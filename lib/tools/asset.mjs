/**
 * `miliastra_asset` 工具（阶段 3 拆文件的第一族 —— 从 index.js 原文搬移，行为零改动）。
 *
 * 为什么能搬：它只依赖 `TITLE` / `renderJson`（阶段 3 前置已进 `lib/`）与 `lib/assets.mjs` 的纯函数，
 * 调度器 `assetOp` 只是薄转发 ⇒ 整族自洽、不需要反向 import `index.js`（避免循环依赖 + TDZ）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { addAsset, assetStats, assetsDir, getAsset, listAssets, pruneAssets, rebuildIndex, removeAsset } from '../assets.mjs';
import { blobsFromGrid, colorMode } from '../measure.mjs';
import { getSound, searchSounds } from '../sounds/search.mjs';
import { imageInfo, sampleGrid } from '../pixelart/decode.mjs';
import { queryImageCatalog } from '../images/query.mjs';
import { searchIcons } from '../images/icons.mjs';
import { ReceiptCode } from '../receipt.mjs';

export async function measureImage(src, { cols = 64, summaryOnly = false } = {}) {
  const buf = fsMod.readFileSync(src);
  const info = await imageInfo(buf);
  const rows = Math.max(4, Math.min(512, Math.round(cols * (info.height / Math.max(1, info.width)))));
  const sampled = await sampleGrid(buf, cols, rows);
  const mode1 = colorMode(sampled.grid, { levels: 16 });
  const blobs = blobsFromGrid(sampled.grid, { minArea: 2 });
  return {
    ok: true, op: 'measure', source: src,
    image: { bytes: buf.length, w: info.width, h: info.height, cols, rows },
    mode1,
    ...(summaryOnly
      ? { blobsCount: blobs.count, byKind: blobs.byKind, blobsOmitted: blobs.count }
      : { blobs: blobs.blobs, blobsCount: blobs.count, byKind: blobs.byKind }),
    note: '主色 = 量化 16 级/通道后的**众数桶**（代表色取桶内平均）；连通块 = 4 连通、按饱和度分「灰块/饱和块」。'
      + '坐标单位是**采样格**（' + cols + '×' + rows + '），不是原图像素。**只报数字，不下判决**（好不好看由你判）。',
    nextStep: '要拿它做 UI：`miliastra_gen op=pixel-art`（像素画）/ `op=vfx-lua`（粒子）都能直接用这张图的素材 id；'
      + '要精确到原图像素就把 `cols` 调大（上限 512）。',
  };
}


function assetOp(args = {}) {
  const op = String(args.op || 'list');
  const dir = assetsDir();
  if (op === 'add') return addAsset({ source: args.source, base64: args.base64, name: args.name, tags: args.tags, dir });
  if (op === 'list') {
    return listAssets({ dir, tag: args.tag, limit: args.limit, summaryOnly: args.summaryOnly === true });
  }
  if (op === 'get') return getAsset({ dir, id: args.id, out: args.out, overwrite: args.overwrite === true });
  if (op === 'remove') return removeAsset({ dir, id: args.id, confirm: args.confirm === true, deleteFile: args.deleteFile === true });
  if (op === 'rebuild') return rebuildIndex({ dir });
  if (op === 'prune') return pruneAssets({ dir, confirm: args.confirm === true });
  if (op === 'stats') return assetStats({ dir });
  /*
   * ★★ P2-5（《上下文瘦身设计》2026-10-07）：**图测量** —— 色值众数 + 连通块包围盒。
   *   代替作者手搓过 2 次的 System.Drawing 逐像素脚本。像素来源 = `lib/pixelart/decode.mjs` 的 `sampleGrid()`
   *   （**降采样**网格，够回答"主色是什么 / 几块 / 在哪多大"）；纯函数在 `lib/measure.mjs`。
   *   `source` 认绝对路径；给 `assetId` 的话先用 `op=get out=<路径>` 落盘再量（**不替调用方猜路径**）。
   */
  if (op === 'measure') {
    const src = args.source ? pathMod.resolve(String(args.source)) : '';
    if (!src || !fsMod.existsSync(src)) {
      return {
        ok: false, op, code: ReceiptCode.MEASURE_NO_SOURCE,
        error: 'op=measure 要 `source` = 图片**绝对路径**（给 `assetId` 的话先用 `op=get out=<路径>` 落盘，再量那份文件）。'
          + '收到：' + JSON.stringify(args.source || null),
      };
    }
    const cols = Math.max(4, Math.min(512, Math.round(Number(args.cols) || 64)));
    /*
     * ★ 红线：**失败回 `{ok:false,error}`，不抛异常**（抛出去会打断调用方一整轮）。
     *   实测：把非图片文件丢进来时 `imageInfo()`（canvas 库）会 reject。
     * ⚠️ 这个函数是**同步的**（`assetOp`）⇒ 不能用 `await`，改用 `.catch()`（仍返回 Promise，工具层会 await）。
     */
    return measureImage(src, { cols, summaryOnly: args.summaryOnly === true }).catch((e) => ({
      ok: false, op, code: ReceiptCode.MEASURE_DECODE_FAILED, source: src,
      error: '读不了这张图（只认 canvas 支持的图片格式：png/jpg/webp…）：' + ((e && e.message) || String(e)),
      nextStep: '确认 `source` 指向**图片文件**（不是 .txt / .gil）；要量平台素材先用 `op=get out=<路径>` 落盘。',
    }));
  }
  /*
   * 后两个是「**平台目录**」通道（只管 id / 名字 / 分类这类目录事实，**不落图片/音频字节**）：
   * `catalog` = 平台图片资源库（1543 条 / 14 类）；`sound-*` = 平台音效库（1997 条 / 7 类）。
   * 它们与上面的 `add/list/get/…`（**插件自己的素材库**）是两件事，别混。
   */
  if (op === 'catalog') return queryImageCatalog(args);
  if (op === 'sound-search') return searchSounds(args);
  if (op === 'sound-get') return getSound(args);
  /* ★ 图标检索（2026-09-30）：按**语义**找图 —— 名字/关键词是模型识图推断的（官方目录没有单图名称）。 */
  if (op === 'icon-search') return searchIcons(args);
  throw new Error('没有这个 op：' + JSON.stringify(op)
    + '（支持 add / list / get / remove / rebuild / prune / stats / catalog / sound-search / sound-get / icon-search）');
}

export const ASSET_TOOL = {
    name: 'miliastra_asset',
    description:
      TITLE + '：**插件素材库** + 两个平台目录通道（图片资源库 / 音效库 —— 只报目录事实，不落字节）。\n★ 插件素材库：**按内容寻址**（文件名 = sha256 前 16 位 + 扩展名，同图只存一份 ⇒ `deduped:true`），落**插件数据目录**（不进游戏存档、不碰活文件）。**磁盘是用户的**：素材**绝不自动删**（`op=remove` 要 `confirm:true`，连字节删再加 `deleteFile:true`；`op=prune` 只报告不删）。\n★ 安全：`source`/`out` 只认**绝对路径**；只收图片白名单、拒 0 字节 / >64 MiB；`out` 默认不覆盖；`../` 拒。\n★ 平台图片资源库（`op=catalog`，1543 条 / 14 类，id 100001~112042）：过滤分类/色档/`simOnly`/`imgExists`；**单张图没有名字** ⇒ 只回分类名（几何号 100001~100006 例外，回 `meaning`）。\n★ 平台音效库（`op=sound-search` / `sound-get`，1997 条 / 7 类）：`q` 按**中英名**模糊搜（多词 = AND），逐条给 `matchKind`；⛔ **不支持拼音/首字母**。\n★ **回执体积**：发现调用给全表、过滤调用只给结论（`categoriesOmitted` 报省了几行）；要完整分类表或 sha256 传 `withMeta:true`。\n\n\n\n\n**典型调用**：`{"op":"add","source":"D:\\\\art\\\\bg.png","tags":"背景"}`｜`{"op":"catalog","category":"基础形状"}`｜`{"op":"sound-search","q":"宝箱 开启","limit":5}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['add', 'list', 'get', 'remove', 'rebuild', 'prune', 'stats', 'measure', 'catalog', 'sound-search', 'sound-get', 'icon-search'],
          description: '默认 list。add 入库（要 source 或 base64）／get 取回／remove 摘索引／rebuild 重建索引／prune 报告不删／stats 总数与体积；'
            + 'catalog = 查**平台图片资源库**；sound-search = 模糊搜音效；sound-get = 按 id 取单条音效；'
            + 'icon-search = **按语义找图标**（不传参数给分类概览、传 `q` 关键词搜、传 `id` 看单条）。',
        },
        id: {
          type: 'string',
          description: 'op=get / remove：素材 `id`（或**唯一前缀**；命中多条就报候选、不猜）。op=catalog：图片素材号；op=sound-get：音效 id。',
        },
        source: {
          type: 'string',
          description: 'op=add：**绝对路径**（如 `D:\\\\art\\\\bg.png`）或 `data:image/png;base64,…`。与 `base64` 只能给一个。',
        },
        base64: {
          type: 'string',
          description: 'op=add：裸 base64 —— 走这条路要给 `name` 一个带图片扩展名的名字，否则认不出类型。',
        },
        name: {
          type: 'string',
          description: 'op=add：**原始文件名，仅展示用**（进索引、回在 `list` 里；不参与寻址）。省略用 source 的 basename。',
        },        tags: {
          type: 'string',
          description: 'op=add：**逗号分隔**的标签（如 `"背景,像素画"`），只用于分类与 `list tag=` 过滤。',
        },
        tag: { type: 'string', description: 'op=list：只看带这个标签的素材。' },
        limit: {
          type: 'number',
          description: 'op=list：默认全部（catalog 50/500、sound-search 20/100）；超限**夹紧**并回 `limitClamped`。',
        },
        q: {
          type: 'string',
          description: 'op=sound-search：关键词（中/英名；空格 = AND）。⚠️ **不支持拼音 / 首字母**。**不给 `q` = 发现调用**（只回分类表，0 条音效）。',
        },
        category: {
          type: 'string',
          description: 'op=catalog：分类 id（`"8"`）或名字（「基础形状」，也可给子串）；op=sound-search：分类 id（`"5"`=物件）。给错报错并列合法值。',
        },
        colorKind: {
          type: 'string',
          enum: ['mono', 'multi', 'neutral', 'mixed'],
          description: 'op=catalog：颜色档（`mono` 官方名含「单色」／`multi` 含「彩色」／`neutral`／`mixed` 是官方没标的实测档）。不传 = 全部。',
        },
        simOnly: {
          type: 'boolean',
          description: 'op=catalog：只回**模拟器画得出来**的 6 个几何号（`100001~100006`）。默认 false。',
        },
        imgExists: {
          type: 'boolean',
          description: 'op=catalog：`true` 只看有图的；`false` 只看**目录标了却没图**的那 21 条。不传 = 不筛。',
        },
        out: {
          type: 'string',
          description: 'op=get：**绝对路径** —— 把字节写到这里（逐字节一致）。不传就回 `dataUrl`。已存在时**默认不覆盖**。',
        },
        overwrite: { type: 'boolean', description: 'op=get：`out` 已存在时是否覆盖。默认 false（**不覆盖是刻意的**）。' },
        confirm: {
          type: 'boolean',
          description: 'op=remove / prune：**显式确认**。remove 给 true 才摘索引；prune 给 true 才真删「无主 / 损坏」那两类。',
        },
        deleteFile: {
          type: 'boolean', description: 'op=remove：**连盘上的字节一起删**（必须同时给 `confirm:true`）。不给就只摘索引（回执 `fileKept:true`）。',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'op=list / op=catalog / op=sound-search：只去逐条 `items`，**计数 / 分类表 / `unverified` 等结论一个不删**。默认 false。',
        },
        withMeta: {
          type: 'boolean',
          description: 'op=catalog / sound-search：把**完整分类表**与 sha256 元信息给我（**只在挑分类 / 审计哈希时开**）。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      return assetOp(args);
    },
  };
