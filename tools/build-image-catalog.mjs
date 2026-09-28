#!/usr/bin/env node
/**
 * build-image-catalog.mjs — **平台「图片资源库」快照的生成脚本（唯一真身）**。
 *
 * 作用：把第三方镜像 `xiaomoL444/ugc-tool` 的 `Public/CustomUIImage/data.json`
 * （+ `ClientUIAnimationEditor/i18n/{zh-cn,en-us}.json` 两个分类名表）压成一个小快照
 * `lib/images/catalog.json`，供 `miliastra_asset op=catalog` 离线查询。
 * **运行时不再联网**（那三个 URL 只在"重跑这个脚本"时用）。
 *
 * ## 取数出处（镜像，**不是** miHoYo 官方端点）
 *
 *   https://oss.xiaomol444.xyz/ugc-tool-data/Public/CustomUIImage/data.json        → 本地镜像 data.json
 *   https://oss.xiaomol444.xyz/ugc-tool-data/ClientUIAnimationEditor/i18n/zh-cn.json → 本地镜像 zh-cn.json
 *   https://oss.xiaomol444.xyz/ugc-tool-data/ClientUIAnimationEditor/i18n/en-us.json → 本地镜像 en-us.json
 *
 * ⚠️ **镜像 ≠ 官方**：3 个文件的字节哈希在下面 `IMAGE_SOURCE.sha256` 里钉死。官方/镜像一变，
 *    脚本**直接拒绝**（除非显式 `--allow-sha-mismatch`）—— 静默换数据比报错危险得多。
 * 依据：拓扑文档 `docs/千星奇域_图片资源库拓扑_2026-09-28.md` §2.1（`imageAssets.ts:49-53` 是这三条 URL 的出处）
 * 与 §9.2 A（三个哈希）。
 *
 * ## 落盘了什么、丢了什么
 *
 * 落盘（**只有事实**）：每个 id 的 `分类 + 两个标志位 + 颜色档`、14 个分类表（中英名 / 数量 / 号段 / 颜色档）、
 * 三个源文件的 sha256、目录**没有名字字段**这件事也如实写在 `nameNote` 里。
 * 丢掉：`img` / `border` 的**路径**（可由 id 推出，且我们**不下载任何图片**）、任何图片字节。
 * ⛔ 本脚本**从不发网络请求**：只读本地镜像目录。
 *
 * ## 四元组 `[id, categoryId, flags, colorKindCode]`
 *
 * · `flags` 位编码：`bit0 = imgExists`、`bit1 = simRenderable`（= 模拟器 `IMAGE_PRIMITIVES` 里那 6 个几何号）。
 * · `colorKindCode` 是 `colorKindCodes[]` 的下标（`mono/multi/neutral/mixed`）—— 存字符串会让文件大 ~30 %，
 *   而回执里一律**展开成完整名字**（AI 看不到代号）。
 * · `categoryId` 是数字：**当时快照里每个 id 恰好属于 1 个分类**（拓扑文档 §3.5 实测；本脚本每次都断言这条，
 *   一旦平台出现"一图多分类"就**直接报错**而不是悄悄丢分类）。
 *
 * ## 颜色档口径（**官方分类名为主口径**）
 *
 * `mono`（官方名含「单色」）/ `multi`（含「彩色」）是**照抄官方分类名**；
 * 官方名没标单色/彩色的 6 类按 §4 的抽样实测分 `neutral`（无彩度白图）/ `mixed`（多色）。
 * ⚠️ 抽样只 66 张（14 类各 ≤5 张）⇒ 它只是**旁证**；本工具**不判决**官方分类名对错。
 *
 * ## 用法
 *
 *   node tools/build-image-catalog.mjs                       # 用默认镜像目录重建快照
 *   node tools/build-image-catalog.mjs --src <目录>           # 换镜像目录
 *   node tools/build-image-catalog.mjs --generated-at <ISO>   # 钉住生成时间（可复现构建）
 *   node tools/build-image-catalog.mjs --check                # 只校验：现有快照 == 重建结果？
 *   node tools/build-image-catalog.mjs --allow-sha-mismatch   # 明知镜像变了仍要重建
 *
 * ⚠️ 写盘一律走 `lib/fsx.mjs` 的原子写（本仓铁律，别手搓 tmp+rename）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 快照格式版本（结构变了才动它）。 */
export const CATALOG_VERSION = 1;

/** 取数出处 + 输入文件哈希（**唯一真身**：重跑与代码审查都看这里）。 */
export const IMAGE_SOURCE = Object.freeze({
  dataUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/Public/CustomUIImage/data.json',
  zhUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/ClientUIAnimationEditor/i18n/zh-cn.json',
  enUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/ClientUIAnimationEditor/i18n/en-us.json',
  files: { data: 'data.json', zh: 'zh-cn.json', en: 'en-us.json' },
  sha256: {
    data: '9fb2308e51c2f8a36a34421731f53f3085f9a6e67f378c94b3d38dd00948cb11',
    zh: '49ca276c8b8b01a9c8c4f7e4e54cbfa18e73fc9755618a41694694e19023079e',
    en: '7b307879f344fbe8f28baa5ddf5e41d54057c34005845f48e4e512bff0a9d2bc',
  },
  /** 本地镜像的抓取日期（取自拓扑文档 §9.2 A 的核对记录）。 */
  fetchedAt: '2026-09-28',
  mirrorNote: '镜像 ≠ 官方：目录取自第三方镜像 oss.xiaomol444.xyz（ugc-tool 的 Public/CustomUIImage），不是 miHoYo 官方端点',
});

/** 默认镜像目录：工作区里的 `tmp/ugc-asset-catalog`（**不进仓库**）。 */
export const DEFAULT_SRC_DIR = path.resolve(ROOT, '../../tmp/ugc-asset-catalog');

/** 快照落盘位置。 */
export const CATALOG_PATH = path.join(ROOT, 'lib', 'images', 'catalog.json');

/**
 * **模拟器画得出来的那 6 个号**（`engine/studio/constants.js` 的 `IMAGE_PRIMITIVES` 的键）。
 * 这里**故意抄成常量**而不是 import 引擎：生成脚本不该依赖引擎模块；两者是否一致由
 * `tests/catalog-test.mjs` 直接读引擎常量来钉（不一致就红）。
 */
export const SIM_RENDERABLE_IDS = Object.freeze([100001, 100002, 100003, 100004, 100005, 100006]);

/** 颜色档四态（顺序 = 快照里 `colorKindCode` 的下标）。 */
export const COLOR_KINDS = Object.freeze(['mono', 'multi', 'neutral', 'mixed']);

/**
 * **分类 id → 颜色档**（口径见文件头）。
 * `mono` = 官方名含「单色」（`3,15,5,1`）；`multi` = 含「彩色」（`4,16,6,2`）；
 * `neutral` = 官方名没标、抽样实测无彩度白图（`8,18,7`）；`mixed` = 官方名没标、抽样实测多色（`17,9,12`）。
 * 出现**未知分类 id** 时脚本直接报错（逼人显式决定它算哪一档，不静默给个默认值）。
 */
export const CATEGORY_COLOR_KIND = Object.freeze({
  1: 'mono', 2: 'multi', 3: 'mono', 4: 'multi', 5: 'mono', 6: 'multi',
  7: 'neutral', 8: 'neutral', 9: 'mixed', 12: 'mixed',
  15: 'mono', 16: 'multi', 17: 'mixed', 18: 'neutral',
});

/**
 * 分类的**展示顺序** = 平台自己那个写死的数组（拓扑文档 §2.3，`imageAssets.ts:61`）。
 * 快照里按它排；表里出现未知 id 就追加在最后（按 id 升序）。
 */
export const CATEGORY_ORDER = Object.freeze([3, 4, 15, 16, 5, 6, 1, 2, 8, 18, 7, 17, 9, 12]);

/**
 * **纯函数**：三份源 JSON → 快照对象（不读盘、不写盘，测试直接喂它）。
 *
 * @param {{data: any, zh: any, en: any, generatedAt?: string, simIds?: number[]}} payload
 *        `data` = `data.json` 解析结果（`{imageData:{id:{id,img,border}}, category:{id:{id,images[]}}}`）；
 *        `zh` / `en` = 分类名表（`{ "8": "基础形状" }`）
 * @returns {any} 快照对象（结构见 `lib/images/catalog.json`）
 */
export function buildImageCatalog({ data, zh, en, generatedAt, simIds }) {
  if (!data || typeof data !== 'object' || !data.imageData || !data.category) {
    throw new Error('data.json 结构不对：期望 { imageData: {}, category: {} }');
  }
  if (!zh || typeof zh !== 'object' || !en || typeof en !== 'object') {
    throw new Error('i18n 词表结构不对：期望 { "<分类id>": "名字" }');
  }
  const simSet = new Set((simIds && simIds.length ? simIds : SIM_RENDERABLE_IDS).map(Number));

  /** 分类 id（升序；键在源里是字符串）。 */
  const catIds = Object.keys(data.category).map(Number).sort((a, b) => a - b);
  /** @type {Map<number, number[]>} id → 它所属的分类（当时快照里长度恒为 1） */
  const catOf = new Map();
  for (const catId of catIds) {
    const c = data.category[String(catId)] || data.category[catId];
    if (!c || !Array.isArray(c.images)) throw new Error('分类 ' + catId + ' 的 images 不是数组');
    for (const raw of c.images) {
      const id = Number(raw);
      if (!catOf.has(id)) catOf.set(id, []);
      const arr = catOf.get(id);
      if (arr) arr.push(catId);
    }
  }

  /** 源里的每条素材：`img` / `border` 两个相对路径（空串 = 目录标了这条但没有图）。 */
  const entries = Object.values(data.imageData).map((/** @type {any} */ x) => ({
    id: Number(x.id),
    img: String(x.img == null ? '' : x.img),
    border: String(x.border == null ? '' : x.border),
  })).sort((a, b) => a.id - b.id);

  /*
   * 三条**结构断言**（拓扑文档 §3.5 实测的性质）：宁可在生成期报错，也不要产出一份悄悄丢了信息的表。
   *   ① 每个 id 恰好 1 个分类（多分类会让四元组装不下 ⇒ 必须改格式，不许静默取第一个）；
   *   ② 目录里每个 id 都在分类表里（否则 items 会少东西）；
   *   ③ `img` / `border` 要么都空、要么都非空，且非空时形如 `sprite/<id>.png`。
   */
  const multi = entries.filter((e) => (catOf.get(e.id) || []).length > 1);
  if (multi.length) {
    throw new Error('有 ' + multi.length + ' 个 id 属于多个分类（如 ' + multi[0].id + '）—— 四元组装不下，请改快照格式');
  }
  const orphan = entries.filter((e) => !(catOf.get(e.id) || []).length);
  if (orphan.length) throw new Error('有 ' + orphan.length + ' 个 id 不在任何分类里（如 ' + orphan[0].id + '）');
  const inCatNotInData = catIds.flatMap((c) => (data.category[String(c)].images || []).map(Number))
    .filter((id) => !data.imageData[String(id)] && !data.imageData[id]);
  if (inCatNotInData.length) {
    throw new Error('有 ' + inCatNotInData.length + ' 个 id 在分类里但不在 imageData 里（如 ' + inCatNotInData[0] + '）');
  }
  for (const e of entries) {
    const bothEmpty = e.img === '' && e.border === '';
    if (!bothEmpty && (e.img === '' || e.border === '')) {
      throw new Error('id ' + e.id + ' 的 img/border 只有一个为空 —— 口径变了，`imgExists` 的含义要重新定');
    }
    if (e.img !== '' && e.img !== 'sprite/' + e.id + '.png') {
      throw new Error('id ' + e.id + ' 的 img 不是 sprite/<id>.png（实得 ' + JSON.stringify(e.img) + '）');
    }
  }

  const codeOf = new Map(COLOR_KINDS.map((k, i) => [k, i]));
  const rank = new Map(CATEGORY_ORDER.map((id, i) => [id, i]));
  const categories = catIds
    .slice()
    .sort((a, b) => {
      const ra = rank.has(a) ? Number(rank.get(a)) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b) ? Number(rank.get(b)) : Number.MAX_SAFE_INTEGER;
      return ra - rb || a - b;
    })
    .map((catId) => {
      const kind = CATEGORY_COLOR_KIND[catId];
      if (!kind) throw new Error('分类 ' + catId + ' 没有定颜色档 —— 在 CATEGORY_COLOR_KIND 里显式加一条（别给默认值）');
      const nameZh = zh[String(catId)];
      const nameEn = en[String(catId)];
      if (typeof nameZh !== 'string' || !nameZh.trim()) throw new Error('分类 ' + catId + ' 缺中文名（源词表变了？）');
      if (typeof nameEn !== 'string' || !nameEn.trim()) throw new Error('分类 ' + catId + ' 缺英文名（源词表变了？）');
      const ids = (data.category[String(catId)].images || []).map(Number).sort((a, b) => a - b);
      return {
        id: catId,
        nameZh,
        nameEn,
        count: ids.length,
        range: [ids[0], ids[ids.length - 1]],
        colorKind: kind,
      };
    });

  const items = entries.map((e) => {
    const cat = Number((catOf.get(e.id) || [])[0]);
    const imgExists = e.img !== '';
    const flags = (imgExists ? 1 : 0) | (simSet.has(e.id) ? 2 : 0);
    const kind = CATEGORY_COLOR_KIND[cat];
    const code = codeOf.get(String(kind));
    if (code === undefined) throw new Error('id ' + e.id + ' 的颜色档 ' + kind + ' 不在 COLOR_KINDS 里');
    return [e.id, cat, flags, code];
  });

  const ids = entries.map((e) => e.id);
  return {
    version: CATALOG_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    source: {
      generator: 'tools/build-image-catalog.mjs',
      dataUrl: IMAGE_SOURCE.dataUrl,
      zhUrl: IMAGE_SOURCE.zhUrl,
      enUrl: IMAGE_SOURCE.enUrl,
      files: { ...IMAGE_SOURCE.files },
      sha256: { ...IMAGE_SOURCE.sha256 },
      fetchedAt: IMAGE_SOURCE.fetchedAt,
      mirrorNote: IMAGE_SOURCE.mirrorNote,
    },
    itemCount: items.length,
    idRange: [ids[0], ids[ids.length - 1]],
    /** **目录里没有单图名字**（全量核对，只有 `id`/`img`/`border`）—— 工具因此不提供也不编任何单图名。 */
    nameNote: '单张图片没有名字：目录里没有 name/title 类字段（全量核对）—— 有名字的只有 14 个分类名',
    colorKindCodes: [...COLOR_KINDS],
    colorKindBasis: '官方分类名为主：名含「单色」→ mono、含「彩色」→ multi；官方名没标的按抽样实测分 neutral（无彩度白图）/ mixed（多色），抽样 66 张只作旁证',
    itemFields: ['id', 'categoryId', 'flags', 'colorKindCode'],
    flagBits: { bit0: 'imgExists', bit1: 'simRenderable' },
    categories,
    items,
  };
}

/**
 * 序列化成落盘文本：**每条素材独占一行**（沿用 `lib/sounds/catalog.json` 的先例 ——
 * `JSON.stringify(c, null, 2)` 会把 1543 条摊成 6 行/条，git diff 没法看）。顶层键仍是两空格缩进，结尾一个 LF。
 * @param {any} catalog `buildImageCatalog` 的产物
 */
export function serializeCatalog(catalog) {
  const lines = catalog.items.map((/** @type {any} */ it) => '    ' + JSON.stringify(it)).join(',\n');
  const head = JSON.stringify({ ...catalog, items: '__ITEMS__' }, null, 2);
  if (!head.includes('"__ITEMS__"')) throw new Error('序列化占位符没命中（结构变了？）');
  return head.replace('"__ITEMS__"', '[\n' + lines + '\n  ]') + '\n';
}

/** 读三份源 JSON 并校验哈希；返回 `{ data, zh, en }` 与实测哈希。 */
export function readSource(srcDir, { allowShaMismatch = false } = {}) {
  const read = (file) => {
    const p = path.join(srcDir, file);
    if (!fs.existsSync(p)) {
      throw new Error('找不到源文件：' + p + '\n（镜像是本地工作区的临时副本，不在仓库里；'
        + '要么把 3 个 JSON 放到这里，要么 --src <目录>）');
    }
    const buf = fs.readFileSync(p);
    return { buf, sha: crypto.createHash('sha256').update(buf).digest('hex') };
  };
  /** @type {any} */
  const out = {};
  const mismatched = [];
  for (const key of ['data', 'zh', 'en']) {
    const { buf, sha } = read(IMAGE_SOURCE.files[key]);
    if (sha !== IMAGE_SOURCE.sha256[key]) mismatched.push(`${IMAGE_SOURCE.files[key]}（期望 ${IMAGE_SOURCE.sha256[key]}，实得 ${sha}）`);
    out[key] = JSON.parse(buf.toString('utf8'));
    out[key + 'Sha'] = sha;
  }
  if (mismatched.length && !allowShaMismatch) {
    throw new Error('源文件哈希与 IMAGE_SOURCE.sha256 不一致：\n  - ' + mismatched.join('\n  - ')
      + '\n镜像/官方可能更新了 —— 先核对分类与数量有没有变，确认无误再 --allow-sha-mismatch 并把新哈希写回 IMAGE_SOURCE。');
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n, d = null) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  try {
    const srcDir = value('--src', DEFAULT_SRC_DIR);
    const out = value('--out', CATALOG_PATH);
    const check = flag('--check');
    const allowShaMismatch = flag('--allow-sha-mismatch');
    const pinned = value('--generated-at', null);

    const src = readSource(srcDir, { allowShaMismatch });
    const committed = check && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    const catalog = buildImageCatalog({
      data: src.data, zh: src.zh, en: src.en,
      generatedAt: pinned || (committed && committed.generatedAt) || undefined,
    });
    const text = serializeCatalog(catalog);

    if (check) {
      if (!fs.existsSync(out)) throw new Error('--check：快照不存在：' + out);
      const now = fs.readFileSync(out, 'utf8');
      if (now === text) {
        console.log('✓ --check：快照与重建结果**逐字节一致**（' + Buffer.byteLength(text, 'utf8') + ' 字节）');
        process.exit(0);
      }
      const a = now.split('\n');
      const b = text.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      console.log('✗ --check：快照与重建结果不一致（第一个不同的行 #' + (i + 1) + '）');
      console.log('  快照：' + String(a[i]).slice(0, 200));
      console.log('  重建：' + String(b[i]).slice(0, 200));
      console.log('  重跑 `node tools/build-image-catalog.mjs` 更新快照。');
      process.exit(1);
    }

    atomicWriteFile(out, Buffer.from(text, 'utf8'));
    const bytes = Buffer.byteLength(text, 'utf8');
    const empty = catalog.items.filter((/** @type {any} */ it) => (it[2] & 1) === 0).length;
    const sim = catalog.items.filter((/** @type {any} */ it) => (it[2] & 2) === 2).length;
    console.log('✓ 已生成 ' + path.relative(ROOT, out).split(path.sep).join('/')
      + '：' + catalog.itemCount + ' 条素材 / ' + catalog.categories.length + ' 个分类 / '
      + (bytes / 1024).toFixed(1) + ' KB（' + bytes + ' 字节）');
    console.log('  id 空间：' + catalog.idRange[0] + '~' + catalog.idRange[1]
      + '  无图（imgExists=false）：' + empty + '  模拟器可渲染：' + sim);
    console.log('  分类：' + catalog.categories.map((/** @type {any} */ c) => `${c.id}=${c.count}(${c.colorKind})`).join(' '));
    console.log('  generatedAt=' + catalog.generatedAt + '  颜色档：'
      + COLOR_KINDS.map((k) => k + '=' + catalog.items.filter((/** @type {any} */ it) => it[3] === COLOR_KINDS.indexOf(k)).length).join(' '));
    console.log('  源 sha256：data=' + src.dataSha.slice(0, 10) + ' zh=' + src.zhSha.slice(0, 10) + ' en=' + src.enSha.slice(0, 10));
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e));
    process.exit(1);
  }
}
