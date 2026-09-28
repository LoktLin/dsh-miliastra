// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （本文件是编排层：把**图源 → 降采样 → 行程与块合并 → 4bit 量化 → Lua / 结构体 JSON** 串起来，
//     并给出回执。分段逻辑分别在 model / decode / blocks / lua / struct 里。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 目标（作者 2026-09-28 明令）：**AI 调一次接口 → 直接拿到可用的像素画 Lua**。
//   `output` 默认 `"lua"`；交接值（图片控件模板索引 / 容器节点索引）**缺了就 ok:false + needsHandover[]**，
//   并且明说「别编，问创作者要」—— 复用 `miliastra_gen` 既有的 `.gil` 自动读取机制（只有唯一候选才采用）。
//
// ★ 未验证项一律如实标（本仓纪律：没在真机跑过就不许说"通过"）：
//   · **4bit 量化**：官方 7.1 原文 `4bit` / `#RGB` 0 命中（已核）⇒ 默认关，开了产物顶部加警示注释；
//   · **真机渲染 / 官方素材 / 联机**：模拟器离线渲染不覆盖 ⇒ 回执 `unverified[]` 恒列这一条。

import fs from 'node:fs';
import { assetsDir, bytesFromSource, fileOfRecord, findRecord, readIndex } from '../assets.mjs';
import {
  BLOCKS_MAX, BLOCKS_WARN, DEFAULT_MAX_PIXEL_WIDTH, DEFAULT_PIXEL_SIZE, DEFAULT_STRUCT_ID,
  OFFSET_MAX, PIXEL_SIZE_MAX, PIXEL_SIZE_MIN, deviationsOf, parseImageType, parseOutput,
  quantColor, requireNumber, resolveGrid,
} from './model.mjs';
import { imageInfo, sampleGrid } from './decode.mjs';
import { blockStats, buildBlocks, countTransparentCells } from './blocks.mjs';
import { buildPixelArtLua } from './lua.mjs';
import { buildPixelStruct } from './struct.mjs';
import { isStructId } from '../structvar/validate.mjs';

/** 交接值缺失时的标准话术（与 text-gradient 同一条纪律：**别编，问创作者要**）。 */
const NO_IMAGE_TEMPLATE = {
  param: 'templateIndex',
  what: '**图片控件**的控件模板索引（界面控件组管理 → 界面控件组库 → 客户端控件模板 →「添加客户端控件」→ 存为模板；画布上摆的实例恒返回 nil）',
};
const NO_CONTAINER = {
  param: 'container',
  what: '**容器节点索引**（脚本要挂上去的那个客户端控件容器节点；AI 拿不到，必须创作者给）',
};

/**
 * 图源 → 字节。两种入口：`assetId`（`miliastra_asset` 素材库，内容寻址）或 `source`（绝对路径）。
 * 两个都给 / 都不给都**明确报错**（不猜）。
 *
 * ⚠️ 回执形状**两个分支同键**（`buf`/`from`/`ref`/`bytes`/`error`）：写成 `{ok:true,…}|{ok:false,…}`
 *    这种判别联合时，`tsc --checkJs` 在 `strict:false` 下不会按 `ok` 收窄，调用方读 `img.error` 会报
 *    「属性不存在」。同键 + `error === null` 判据既过类型检查，也更好读。
 *
 * @param {Record<string, any>} args
 * @returns {{buf: Buffer|null, from: string|null, ref: string|null, bytes: number, error: string|null}}
 */
function readImageBytes(args) {
  const fail = (error) => ({ buf: null, from: null, ref: null, bytes: 0, error });
  const hasAsset = args.assetId !== undefined && args.assetId !== null && String(args.assetId).trim() !== '';
  const hasSource = args.source !== undefined && args.source !== null && String(args.source).trim() !== '';
  if (hasAsset && hasSource) {
    return fail('`assetId` 与 `source` 只能给一个（两个都给就不知道以哪个为准）');
  }
  if (!hasAsset && !hasSource) {
    return fail('要给图源：`assetId`（miliastra_asset 素材库，内容寻址）或 `source`（图片**绝对路径**），二选一。');
  }
  if (hasSource) {
    const got = bytesFromSource({ source: args.source });
    if (!got.ok) return fail(got.error);
    return { buf: got.buf, from: 'source', ref: String(args.source), bytes: got.buf.length, error: null };
  }
  const dir = assetsDir();
  const idx = readIndex(dir);
  const found = findRecord(idx.records, args.assetId);
  if (!found.ok) return fail(found.error + '（素材库目录：' + dir + '）');
  const file = fileOfRecord(dir, found.rec);
  if (!fs.existsSync(file)) {
    return fail('素材索引里有这条记录但盘上没有文件：' + file + '（可以先 miliastra_asset op=rebuild 从目录重建索引）');
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return fail('读素材文件失败：' + ((e && e.message) || e));
  }
  return { buf, from: 'asset', ref: found.rec.id, bytes: buf.length, error: null };
}

/** `output=data` 时给块列表（含 hex，方便人核对颜色）。 */
function blockListOf(blocks, use4bit) {
  return blocks.map((b, i) => ({
    i,
    x: b.x, y: b.y, w: b.w, h: b.h,
    rgba: b.color,
    hex: use4bit
      ? '#' + b.color.map((v) => Math.round(v / 17).toString(16).toUpperCase()).join('')
      : '#' + b.color.map((v) => Math.max(0, Math.min(255, v)).toString(16).toUpperCase().padStart(2, '0')).join(''),
  }));
}

/**
 * `op=pixel-art` 的实现：**一次调用 → 可直接部署的 Lua**（或结构体 JSON / 块数据）。
 *
 * @param {Record<string, any>} args 工具入参
 * @param {{templateIndex?: number|null, container?: number|null, from?: string|null, candidates?: any, missing?: string[]}} [handover]
 * @returns {Promise<Record<string, any>>}
 */
export async function pixelArt(args = {}, handover = {}) {
  let output;
  let imageType;
  let pixelSize;
  let centerOffsetX;
  let centerOffsetY;
  const use4bit = args.use4bit === true;
  const mergeRuns = args.mergeRuns !== false;
  const maxPixelWidth = Number.isFinite(Number(args.maxPixelWidth)) && Number(args.maxPixelWidth) > 0
    ? Math.round(Number(args.maxPixelWidth))
    : DEFAULT_MAX_PIXEL_WIDTH;
  try {
    output = parseOutput(args.output);
    imageType = parseImageType(args.imageType);
    pixelSize = args.pixelSize === undefined || args.pixelSize === null || args.pixelSize === ''
      ? DEFAULT_PIXEL_SIZE
      : requireNumber(args.pixelSize, 'pixelSize', PIXEL_SIZE_MIN, PIXEL_SIZE_MAX);
    centerOffsetX = args.centerOffsetX === undefined || args.centerOffsetX === null || args.centerOffsetX === ''
      ? 0 : requireNumber(args.centerOffsetX, 'centerOffsetX', -OFFSET_MAX, OFFSET_MAX);
    centerOffsetY = args.centerOffsetY === undefined || args.centerOffsetY === null || args.centerOffsetY === ''
      ? 0 : requireNumber(args.centerOffsetY, 'centerOffsetY', -OFFSET_MAX, OFFSET_MAX);
  } catch (e) {
    return { ok: false, op: 'pixel-art', output: String(args.output || 'lua'), error: (e && e.message) || String(e) };
  }

  // ① 图源
  const img = readImageBytes(args);
  if (img.error) return { ok: false, op: 'pixel-art', output, error: img.error };

  // ② 原图尺寸 → 网格
  let info;
  try {
    info = await imageInfo(img.buf);
  } catch (e) {
    return {
      ok: false, op: 'pixel-art', output,
      error: '图片解不开（Host 侧用 @napi-rs/canvas 解码，只认它认得的格式）：' + ((e && e.message) || e),
      image: { from: img.from, ref: img.ref, bytes: img.bytes },
    };
  }
  let grid;
  try {
    grid = resolveGrid(args, info.width, info.height);
  } catch (e) {
    return { ok: false, op: 'pixel-art', output, error: (e && e.message) || String(e), image: { width: info.width, height: info.height } };
  }

  // ③ 关平滑降采样
  let sampled;
  try {
    sampled = await sampleGrid(img.buf, grid.cols, grid.rows);
  } catch (e) {
    return { ok: false, op: 'pixel-art', output, error: '降采样失败：' + ((e && e.message) || e) };
  }

  // ④ 行程与块合并（+ 可选 4bit 量化）
  const rawBlocks = buildBlocks(sampled.grid, { mergeRuns });
  const transparentCells = countTransparentCells(sampled.grid);
  if (rawBlocks.length > BLOCKS_MAX) {
    return {
      ok: false, op: 'pixel-art', output,
      error: '块数 ' + rawBlocks.length + ' 超过上限 ' + BLOCKS_MAX + '（一个块 = 一个图片控件）。'
        + '请降 `cols`/`rows`/`maxSide`（合并开关 `mergeRuns` 默认已开），或换一张更简单的图。',
      stats: { blocks: rawBlocks.length, grid },
    };
  }
  const blocks = use4bit
    ? rawBlocks.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, color: quantColor(b.color, true) }))
    : rawBlocks;
  const stats = blockStats(blocks, { cols: grid.cols, rows: grid.rows }, transparentCells);

  // ⑤ 交接值（只有 lua 需要）
  //    ⚠️ 这里**再看一眼 `args`**：`pixelArt()` 是导出的编排层，直接调它的调用方只会在 args 里给
  //       两个索引（工具层那条路走 `genOp` → 已经把它们放进 `handover`）。两处都认，**缺哪个报哪个**。
  const givenTmpl = Number(args.templateIndex);
  const givenCont = Number(args.container);
  const hTmpl = Number(handover.templateIndex);
  const hCont = Number(handover.container);
  const templateIndex = Number.isFinite(hTmpl) && hTmpl ? hTmpl : (Number.isFinite(givenTmpl) && givenTmpl ? givenTmpl : null);
  const containerIndex = Number.isFinite(hCont) && hCont ? hCont : (Number.isFinite(givenCont) && givenCont ? givenCont : null);
  const handoverFrom = handover.from || ((templateIndex || containerIndex) ? 'arg' : null);
  const missing = [];
  if (!templateIndex) missing.push(NO_IMAGE_TEMPLATE);
  if (!containerIndex) missing.push(NO_CONTAINER);

  const warnings = [];
  const unverified = [];
  /*
   * ⚠️ 这一条**必须**留在回执里：本产物把整幅画建在 `OnStart` 的循环里，而
   *    `miliastra_code op=deploy` 的已知坑检查会命中「在 OnStart / 构建循环里 InstantiateClientUIControl」——
   *    真机见过「整卡一个像素都不画」的案例。我们不能替创作者决定挪不挪（挪了就要 tick），所以**只说事实 + 给出改法**。
   */
  warnings.push({
    code: 'INSTANTIATE_IN_ONSTART',
    note: '本产物在 `OnStart` 里循环建全部图片控件 —— 本仓 `miliastra_code op=deploy` 会提示这条**已知坑**'
      + '（2026-09-26 真机：复合模板在构建期实例化可能"整卡不显示"）。若真机上整幅画都不显示，'
      + '先把创建挪到渲染第一帧（加 `OnUpdate` + 第一帧里建完再 `script:EnableUpdate(false)`）再看一次。',
  });
  if (/gil/.test(String(handoverFrom || ''))) {
    warnings.push({
      code: 'HANDOVER_AUTO_FROM_GIL',
      templateIndex, container: containerIndex,
      note: '交接值是从**当前关卡的 .gil** 自动读到的（只有唯一候选才采用）；部署前请与创作者核一眼',
    });
  }
  if (grid.gridFrom === 'default') {
    warnings.push({
      code: 'GRID_DEFAULTED',
      cols: grid.cols, rows: grid.rows,
      note: '你没给 `cols`/`rows`/`maxSide` —— 按 `maxSide=' + grid.cols + '`（长边）等比取网格。'
        + '像素画的观感几乎由网格决定，建议显式给一个。',
    });
  } else if (grid.gridFrom === 'aspect') {
    warnings.push({
      code: 'GRID_FROM_ASPECT', cols: grid.cols, rows: grid.rows,
      note: '只给了一边 ⇒ 另一边按**原图宽高比**推的（上面这两个数就是最终网格）',
    });
  }
  if (transparentCells > 0) {
    warnings.push({
      code: 'TRANSPARENT_CELLS_DROPPED', cells: transparentCells,
      note: '有 ' + transparentCells + ' 格是 `a=0`（全透明）⇒ **不建块**（源码原判据 `if color[3] > 0`）。'
        + '千星没有"透明图片控件"，建了也是白建一个控件。',
    });
  }
  if (blocks.length > BLOCKS_WARN) {
    warnings.push({
      code: 'MANY_CONTROLS', controls: blocks.length,
      note: '会一次建 ' + blocks.length + ' 个图片控件（超过 ' + BLOCKS_WARN + '）—— 真机这一下可能卡顿；'
        + '降 `cols`/`rows`，或调大 `pixelSize` 让每个块覆盖更多格（不会减少控件数，只是更大）。',
    });
  }
  if (use4bit) {
    unverified.push({
      param: 'use4bit',
      what: '4bit 量化（`round(v/17)`，每通道 0–15 级）',
      why: '官方 7.1 原文里 `4bit` / `#RGB` **0 命中**（已核）—— 量化后的颜色与真机是否一致，未经真机验证',
    });
  }
  unverified.push({
    param: '真机渲染',
    what: '图片控件的矩形块拼图（建了几个控件、颜色字段是什么值）',
    why: 'Host 侧只验到模型层与离线渲染；**官方素材 / 真机渲染管线 / 联机都不覆盖**（模拟器 ≠ 真机）',
  });

  const deviations = deviationsOf(pixelSize);
  const summaryOnly = args.summaryOnly === true;
  const base = {
    ok: true,
    op: 'pixel-art',
    output,
    image: {
      from: img.from, ref: img.ref, bytes: img.bytes,
      width: info.width, height: info.height,
    },
    grid: { cols: grid.cols, rows: grid.rows, gridFrom: grid.gridFrom },
    pixelSize,
    centerOffsetX,
    centerOffsetY,
    imageType,
    use4bit,
    mergeRuns,
    blocks: blocks.length,
    controls: blocks.length,
    stats,
    warnings,
    unverified,
    deviations,
    nextStep: '用 `miliastra_code op=deploy` 把这段投到活文件（**必须显式传 `level`（地图关卡 ID）与 `file`（活文件名）**），'
      + '然后在编辑器里**存一次盘**再试玩 —— 部署不会热加载正在进行的试玩。'
      + '想确认某局跑的是这版，看 `.gia` 里脚本自己 print 的 `start ver=…` 行。',
    needsHandover: output === 'lua' && missing.length ? missing : [],
    handoverFrom,
    // 自动读 `.gil` 时看到了哪些候选（拿不到就给空数组）—— 与 text-gradient 同一形状，创作者照着核
    handoverCandidates: handover.candidates || [],
    summaryOnly,
  };

  if (output === 'data') {
    const out = Object.assign({}, base, {
      blockList: blockListOf(blocks, use4bit),
      notes: [
        '一个块 = 一个图片控件；`rgba` 是最终写进 `Color.FromRGBA` 的值（`use4bit:true` 时已经是量化后的）',
        '`x/y` 是**格坐标、左上原点**，`w/h` 是**格数**',
        '`hex` 只是给人看的：8bit = `#RRGGBBAA`，4bit = `#RGBA`（与源码 `rgbaToHex` 同口径）',
      ],
    });
    if (summaryOnly) {
      delete out.blockList;
      out.blockListOmitted = true;
      out.blockListCount = blocks.length;
    }
    return out;
  }

  if (output === 'struct') {
    const structId = args.structId === undefined || args.structId === null || String(args.structId) === ''
      ? DEFAULT_STRUCT_ID : String(args.structId);
    if (!isStructId(structId)) {
      return {
        ok: false, op: 'pixel-art', output,
        error: 'structId=' + JSON.stringify(structId) + ' 不是 10 位数字 —— 千星导不进去（结构体 ID 硬规则）。'
          + '创作者给你那个 ID 之前，可以先不传（默认 ' + DEFAULT_STRUCT_ID + '）。',
        needsHandover: [{ param: 'structId', what: '要导入的那个**结构体 ID**（10 位数字）—— 别编，问创作者要' }],
      };
    }
    const built = buildPixelStruct(sampled.grid, { structId, use4bit, maxPixelWidth });
    const overLimit = built.parts.filter((s) => s.length > built.charLimit).length;
    if (overLimit) {
      return {
        ok: false, op: 'pixel-art', output,
        error: '有 ' + overLimit + ' 段超过 ' + built.charLimit + ' 字符（单条文本硬规则）—— 这是本工具的 bug（分段没兜住），请报 issue',
      };
    }
    const structText = JSON.stringify(built.struct, null, 2);
    const out = Object.assign({}, base, {
      structId,
      structPartCount: built.parts.length,
      structPartsPerRow: Number((built.parts.length / Math.max(1, built.rows)).toFixed(3)),
      maxLineChars: built.maxLineChars,
      charLimit: built.charLimit,
      notes: [
        '形态与源码 `downloadJson` 逐字一致：`{structId, type:"Struct", value:[{param_type:"StringList", value:[…]}]}`',
        '每段 = 一行里的一段富文本（`<color=#RRGGBBAA>███</color>`；透明段是全角空格 `　`）',
        '本工具**不写文件、也不建结构体** —— 导入那一步只能人在编辑器里做',
      ],
    });
    if (summaryOnly) {
      out.structTextBytes = structText.length;
      out.structTextOmitted = true;
    } else {
      out.structText = structText;
      out.struct = built.struct;
    }
    return out;
  }

  // output === 'lua'
  if (missing.length) {
    return Object.assign({}, base, {
      ok: false,
      error: '生成 Lua 需要两个**交接值**，而它们 AI 拿不到 —— 请向创作者要（**别自己编索引**）：'
        + '① **图片控件**的控件模板索引（走 `templateIndex`）；② 脚本要挂的**容器节点索引**（走 `container`）。',
      stats,
    });
  }

  const lua = buildPixelArtLua({
    cols: grid.cols, rows: grid.rows, pixelSize, centerOffsetX, centerOffsetY, imageType,
    blocks, templateIndex, containerIndex, use4bit,
  });
  const out = Object.assign({}, base, {
    target: { templateIndex, container: containerIndex },
    lua,
    luaBytes: Buffer.byteLength(lua, 'utf8'),
    lines: lua.split('\n').length,
    notes: [
      '像素画是**静态**的 ⇒ 产物**不调** `script:EnableUpdate(true)`：没有 `OnUpdate`，开 tick 只会每帧白烧预算',
      '颜色走**字段** `imageColor`（官方 7.1 原文 `SetImageColor` 命中 0）',
      '每块 = `SetSizeDelta(w×pixelSize, h×pixelSize)` + `SetAnchoredPosition(…)`，锚点/中心都设 0.5',
    ],
  });
  if (summaryOnly) {
    delete out.lua;
    out.luaOmitted = true;
    out.luaBytesOmitted = out.luaBytes;
  }
  return out;
}
