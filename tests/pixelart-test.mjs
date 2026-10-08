#!/usr/bin/env node
/**
 * `miliastra_gen op=pixel-art`（**图片转像素画**）测试：纯函数层 + 序列化层 + 工具层 + **一次端到端**。
 *
 * ★ 为什么要有它 / **修前为什么红**（一条条说清，否则「加了个测试」等于没加）：
 *   ① 纯函数层：合并与量化是**逐字**从第三方工具移植的（`xiaomoL444/ugc-tool` 的
 *      `src/views/PixelArt/PixelArt.vue`，作者授权、保持开源）。移植最容易出的错是「看错一步判据」：
 *      · 跨行合并的 key 是 `${x}:${width}:${color}` —— **少一个字段**就会把"错位的同色块"粘成一块，
 *        画出来是错的，而且**不会有任何报错**（只是图变形）；
 *      · 4bit 是 `Math.round(v / 17)` —— 写成 `/16` 或 `>>4` 时 0/17/255 三个端点里总有一个错。
 *      所以这里钉**具体数字**：0→0 / 17→1 / 255→15 / 8→0 / 9→1。
 *   ② 序列化层：结构体 JSON 的形态（`{structId, type:"Struct", value:[{param_type:"StringList", …}]}`）
 *      与富文本形态（`<color=#RRGGBBAA>███</color>`、透明段换**全角空格**）都是**创作者要粘进千星**的产物，
 *      形状错了就是导不进去；另外千星有「单条文本 ≤500 字符」硬规则 —— 逐字符拼装做不到"按段裁"，
 *      修前若照抄源码的两层切分（只按 `maxPixelWidth`），一条 256 格同色的行会**超限**。
 *   ③ Lua 层：这一层是**本仓自己写的驾驶层**（源码那份走 `script:GetParam`），所以要盯本仓铁律：
 *      交接值进顶部 `CONFIG`、控件 nil 要 `error` 点名、**无 pcall / 无静默 return**、颜色走字段
 *      `imageColor`（`SetImageColor` 官方 0 命中），以及**像素画是静态的 ⇒ 不许出现 `EnableUpdate`/`OnUpdate`**
 *      （开着 tick 却没有 OnUpdate = 每帧白烧预算，修前照抄网页实现就会带上）。
 *   ④ 工具层：**真从 `TOOLS` 调 `execute`** —— 修前的问题是「lib 写好了但没接线 / op 拼错静默回落成默认 op」：
 *      这里断言未知 op 明确报错、缺交接值回 `needsHandover[]`（**两个都要，且文案说"别编"**）。
 *   ⑤ 端到端：**生成 → 模拟器跑到块出现 → 数像素**。这是唯一能证明"块真的画出来了、颜色对得上"的一步：
 *      断言四象限颜色逐点相等、透明格**真的是空的**、以及「与空场景的像素差 == 所有块面积之和」。
 *
 * ⚠️ 端到端用**临时数据目录**（`MILIASTRA_DATA_DIR`），跑完删干净 —— 不污染用户真实的 shots/。
 * 用法：`node tests/pixelart-test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const failures = [];
const ok = (name, detail = '') => { pass += 1; console.log(`✓ ${name}${detail ? ' —— ' + detail : ''}`); };
const bad = (name, why) => { failures.push(`${name}: ${why}`); console.log(`✗ ${name} —— ${why}`); };

/**
 * 用例**只登记、不执行**（端到端那条是 async 的，统一在文末按登记顺序 await 跑完）。
 * ⚠️ 为什么不写成同步 `t(name, fn){ fn() }`：那样 async 用例的断言会全漂在 Promise 里，
 * 测试**照样"全绿"** —— 那是测试自己制造的假绿。
 */
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
function throws(fn, mustInclude, msg) {
  let err = null;
  /*
   * ★ 2026-10-08：工具出口已统一"失败回 {ok:false} 回执、不抛异常"（红线）⇒
   *   本助手同时接受两种"拒绝"形态：**抛异常** 或 **回执 ok:false**（把 error 当成错误文案）。
   *   断言意图不变：**坏输入必须被明确拒绝，且文案里要有该有的关键词**。
   */
  try {
    const r = fn();
    if (r && typeof r === 'object' && r.ok === false) err = String(r.error || r.code || '（ok:false）');
  } catch (e) { err = (e && e.message) || String(e); }
  assert(err !== null, (msg || '应当报错') + '，但没报错');
  if (mustInclude) assert(err.includes(mustInclude), `错误文案里没有「${mustInclude}」：${err}`);
  return err;
}

// 临时数据目录（必须在 import sim.mjs 之前设好）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-pixelart-'));
process.env.MILIASTRA_DATA_DIR = tmpData;

const { TOOLS } = await import('../index.js');
const { genOp } = await import('../index.js');
const {
  QUANT_STEP, GRID_MAX, IMAGE_TYPES, OUTPUTS, DEFAULT_PIXEL_SIZE, DEFAULT_MAX_SIDE,
  clampInt, quant4, expand4, quantColor, toHex8, toHex4, rgbaToHex, sameColor,
  parseOutput, parseImageType, requireInt, requireNumber, resolveGrid, deviationsOf,
} = await import('../lib/pixelart/model.mjs');
const { gridFromRgba } = await import('../lib/pixelart/decode.mjs');
const {
  mergeBlocks, flatBlocks, buildBlocks, blockStats, countTransparentCells,
} = await import('../lib/pixelart/blocks.mjs');
const { rowRuns, rowParts, buildPixelStruct, TRANSPARENT_FILL } = await import('../lib/pixelart/struct.mjs');
const { buildPixelArtLua } = await import('../lib/pixelart/lua.mjs');
const { pixelArt } = await import('../lib/pixelart/index.mjs');
const { addAsset } = await import('../lib/assets.mjs');
const { simOp, disposeSimAll } = await import('../lib/sim.mjs');

const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
const genExec = (args) => gen.execute(args);

/** 造一张 **我们自己画的** 图（不碰任何第三方素材）：四象限四色 + 中间一条透明竖条。 */
async function makeFixture(file, size = 64, gap = 4) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const cv = createCanvas(size, size);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const h = size / 2;
  ctx.fillStyle = '#FF0000'; ctx.fillRect(0, 0, h, h);
  ctx.fillStyle = '#00FF00'; ctx.fillRect(h, 0, h, h);
  ctx.fillStyle = '#0000FF'; ctx.fillRect(0, h, h, h);
  ctx.fillStyle = '#FFFF00'; ctx.fillRect(h, h, h, h);
  ctx.clearRect(h - gap / 2, 0, gap, size);
  fs.writeFileSync(file, cv.toBuffer('image/png'));
  return file;
}

/* ================================================================ ① 纯函数层：量化 */

t('★ 4bit 量化：`Math.round(v/17)` —— 0/17/255 三个端点与 8/9 的进位点', () => {
  eq(QUANT_STEP, 17, '分母必须是 17（255/15）');
  eq([quant4(0), quant4(17), quant4(255)], [0, 1, 15], '端点');
  eq([quant4(8), quant4(9)], [0, 1], '8/17=0.47→0，9/17=0.53→1');
  eq([quant4(34), quant4(153)], [2, 9], '中间值');
  eq([quant4(-5), quant4(999), quant4(NaN)], [0, 15, 0], '越界与 NaN 夹住（不抛）');
  // 写成 /16 或 >>4 时会在这三个点上错
  eq([toHex4(0), toHex4(17), toHex4(255)], ['0', '1', 'F'], 'toHex4');
  return '0→0 / 17→1 / 255→15 / 8→0 / 9→1';
});

t('`expand4` 把量化后的级别铺回 0..255（`Color.FromRGBA` 只吃 0-255）', () => {
  eq([expand4(0), expand4(17), expand4(255)], [0, 17, 255], '端点铺回后仍是端点');
  eq([expand4(8), expand4(9)], [0, 17], '8→0，9→17');
  eq(quantColor([255, 130, 51, 255], false), [255, 130, 51, 255], '关掉时**原样返回**（不量化）');
  eq(quantColor([255, 130, 51, 255], true), [255, 136, 51, 255], '开启时逐通道量化（130/17=7.6→8→136）');
  return 'expand4(9)=17；quantColor 关=原样 / 开=量化';
});

t('`rgbaToHex` 与源码同口径：8bit `#RRGGBBAA`、4bit `#RGBA`', () => {
  eq(rgbaToHex(255, 0, 0, 255, false), '#FF0000FF');
  eq(rgbaToHex(0, 0, 0, 0, false), '#00000000');
  eq(rgbaToHex(255, 0, 0, 255, true), '#F00F');
  eq(rgbaToHex(0, 0, 0, 0, true), '#0000');
  eq([toHex8(5), toHex8(255)], ['05', 'FF'], 'toHex8 补零 + 大写');
  eq(sameColor([1, 2, 3, 4], [1, 2, 3, 4]), true);
  eq(sameColor([1, 2, 3, 4], [1, 2, 3, 5]), false);
  return '#FF0000FF / #F00F';
});

/* ================================================================ ① 纯函数层：参数校验 */

t('`resolveGrid`：两个都给=原样；只给一个=按原图宽高比推另一边', () => {
  eq(resolveGrid({ cols: 8, rows: 6 }, 100, 100), { cols: 8, rows: 6, gridFrom: 'arg' });
  eq(resolveGrid({ cols: 20 }, 100, 50), { cols: 20, rows: 10, gridFrom: 'aspect' }, '宽:高=2:1 ⇒ 10 行');
  eq(resolveGrid({ rows: 10 }, 100, 50), { cols: 20, rows: 10, gridFrom: 'aspect' }, '反过来也一样');
  return 'arg / aspect 两路都对';
});

t('`resolveGrid`：只给 `maxSide` 按长边；一个都不给 → 默认 32 且**如实标 `default`**', () => {
  eq(resolveGrid({ maxSide: 16 }, 200, 100), { cols: 16, rows: 8, gridFrom: 'maxSide' });
  eq(resolveGrid({ maxSide: 16 }, 100, 200), { cols: 8, rows: 16, gridFrom: 'maxSide' }, '长边是竖的');
  eq(resolveGrid({}, 200, 100), { cols: DEFAULT_MAX_SIDE, rows: DEFAULT_MAX_SIDE / 2, gridFrom: 'default' });
  assert(resolveGrid({}, 200, 100).gridFrom === 'default', '不许假装是调用方给的');
  // 退化图（1×N）不能让某一边变 0
  const thin = resolveGrid({ maxSide: 32 }, 1000, 1);
  assert(thin.rows >= 1 && thin.cols === 32, '极扁的图另一边至少 1 格：' + JSON.stringify(thin));
  return 'maxSide 等比 / 默认 32 标 default / 极扁图不塌成 0';
});

t('非法 `cols`/`pixelSize`/`output`/`imageType` **明确报错**（不是静默夹住）', () => {
  throws(() => resolveGrid({ cols: 0, rows: 4 }, 10, 10), 'cols', 'cols=0');
  throws(() => resolveGrid({ cols: 1.5, rows: 4 }, 10, 10), 'cols', 'cols 非整数');
  throws(() => resolveGrid({ cols: GRID_MAX + 1, rows: 4 }, 10, 10), 'cols', 'cols 超上限');
  throws(() => requireInt('abc', 'rows', 1, 8), 'rows', 'rows 非数字');
  throws(() => requireNumber(0, 'pixelSize', 1, 64), 'pixelSize', 'pixelSize=0');
  throws(() => requireNumber(65, 'pixelSize', 1, 64), 'pixelSize', 'pixelSize 超上限');
  throws(() => parseOutput('gif'), 'output', '未知 output');
  throws(() => parseImageType('Tile'), 'imageType', '未知 imageType');
  eq(parseOutput(undefined), 'lua', '默认 output=lua（作者明令）');
  eq(parseImageType(undefined), 'Stretch', '默认 Stretch');
  eq(IMAGE_TYPES, ['Stretch', 'Basic'], '官方 7.1 原文只有这两个值');
  eq(OUTPUTS, ['lua', 'struct', 'data']);
  eq(clampInt(3.7, 1, 9), 4, 'clampInt 四舍五入');
  return '6 条非法值全部点名报错；两个默认值对';
});

/* ================================================================ ② 块合并（逐字移植） */

/** 合成一个 grid：`spec` 是 `[[r,g,b,a], …]` 的行数组。 */
const g = (rows) => rows.map((r) => r.map((px) => px.slice()));
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

t('★ 行内行程合并：一行 4 个同色 → **1 个块**（不是 4 个控件）', () => {
  const blocks = mergeBlocks(g([[RED, RED, RED, RED]]));
  eq(blocks.length, 1, '块数');
  eq([blocks[0].x, blocks[0].y, blocks[0].w, blocks[0].h], [0, 0, 4, 1], '几何');
  return '4 格 → 1 块';
});

t('★ 跨行同色**同宽同位置**合并：两行相同 → h=2（这是它比"一像素一控件"省的地方）', () => {
  const blocks = mergeBlocks(g([[RED, RED], [RED, RED]]));
  eq(blocks.length, 1, '块数');
  eq([blocks[0].w, blocks[0].h], [2, 2]);
  return '2×2 同色 → 1 块 h=2';
});

t('★ 跨行合并的**判据是三段 key**：x 或 w 不同就不合并（少抄一个字段就会粘错）', () => {
  // 同色、同宽，但**错位**（第 2 行从 x=1 开始）
  const shifted = mergeBlocks(g([[RED, RED, CLEAR], [CLEAR, RED, RED]]));
  eq(shifted.length, 2, '错位不许合并');
  eq(shifted.map((b) => [b.x, b.y, b.w, b.h]), [[0, 0, 2, 1], [1, 1, 2, 1]], '两块各自独立');
  // 同色、同行起点相同，但**宽度不同**
  const widths = mergeBlocks(g([[RED, RED, RED], [RED, RED, BLUE]]));
  eq(widths.length, 3, '宽度不同不许合并（第 1 行 3 宽 / 第 2 行 2 宽）');
  // 中间被别的颜色截断 ⇒ 上 2 行 + 下 1 行两块
  const broken = mergeBlocks(g([[RED], [RED], [BLUE]]));
  eq(broken.map((b) => [b.y, b.h]), [[0, 2], [2, 1]], '截断处断成两块');
  return '错位 / 宽度不同 / 被截断 三种都不合并';
});

t('★ 透明格（`a=0`）**不建块**（源码原判据 `if (color[3] > 0)`）', () => {
  const blocks = mergeBlocks(g([[CLEAR, RED, CLEAR]]));
  eq(blocks.length, 1, '只有红那个建块');
  eq(blocks[0].x, 1);
  eq(countTransparentCells(g([[CLEAR, RED, CLEAR]])), 2, '透明格计数');
  return '透明格不建块，但计数如实报';
});

t('`mergeRuns:false`（本仓新增开关）= 一格一个块', () => {
  const rows = g([[RED, RED], [CLEAR, BLUE]]);
  eq(mergeBlocks(rows).length, 2, '合并：红 1 块（2 宽）+ 蓝 1 块');
  eq(flatBlocks(rows).length, 3, '不合并：红 2 格 + 蓝 1 格');
  eq(buildBlocks(rows, { mergeRuns: false }).length, 3);
  eq(buildBlocks(rows, { mergeRuns: true }).length, 2);
  return '合并 2 / 不合并 3';
});

/* ================================================================ ② 降采样（纯函数入口） */

t('降采样后的块数：8×8 四象限合成图 → **4 块**（纯函数，不走 canvas）', () => {
  const cols = 8; const rows = 8;
  const data = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const left = x < 4; const top = y < 4;
      data.push(...(left ? (top ? [255, 0, 0, 255] : [0, 0, 255, 255]) : (top ? [0, 255, 0, 255] : [255, 255, 0, 255])));
    }
  }
  const grid = gridFromRgba(data, cols, rows);
  eq(grid.length, rows, '行数');
  eq(grid[0].length, cols, '列数');
  eq(grid[0][0], [255, 0, 0, 255], '左上=红');
  eq(grid[7][7], [255, 255, 0, 255], '右下=黄');
  const blocks = mergeBlocks(grid);
  eq(blocks.length, 4, '四个象限 → 四块');
  eq(blocks.map((b) => [b.x, b.y, b.w, b.h]), [[0, 0, 4, 4], [4, 0, 4, 4], [0, 4, 4, 4], [4, 4, 4, 4]]);
  throws(() => gridFromRgba(data, 4, 4), '长度对不上', '长度不符要报错');
  throws(() => gridFromRgba('nope', 1, 1), 'RGBA 数组', '非数组要报错');
  return '4 块，几何逐块相同';
});

t('`blockStats` 只报数字：块数 / 最宽 / 最高 / 透明格 / 颜色种数 / 合并比', () => {
  const rows = g([[RED, RED], [RED, BLUE]]);
  const blocks = mergeBlocks(rows);
  const st = blockStats(blocks, { cols: 2, rows: 2 }, countTransparentCells(rows));
  // 第 0 行是 2 宽的红、第 1 行是 1 宽的红 + 1 宽的蓝 ⇒ 三段 key 不同 ⇒ **3 块**
  eq(blocks.map((b) => [b.x, b.y, b.w, b.h]), [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]]);
  eq([st.blocks, st.cells, st.transparentCells, st.distinctColors], [3, 4, 0, 2]);
  eq([st.widestBlock, st.tallestBlock], [2, 1], '最宽的是第 0 行那个 2 宽');
  eq(st.mergeRatio, 0.25, '4 格 → 3 块 ⇒ 省 25%');
  eq(blockStats([], { cols: 2, rows: 2 }, 4).mergeRatio, 0, '全透明时不除零');
  return JSON.stringify({ blocks: st.blocks, widest: st.widestBlock, ratio: st.mergeRatio });
});

/* ================================================================ ③ 富文本 / 结构体 JSON */

t('`rowRuns` 按 **hex 串**比较（4bit 下不同 RGBA 会塌成同一段 —— 源码就是这样）', () => {
  const runs8 = rowRuns([[10, 10, 10, 255], [11, 11, 11, 255]], false);
  eq(runs8.length, 2, '8bit：10 与 11 是两个段');
  const runs4 = rowRuns([[10, 10, 10, 255], [11, 11, 11, 255]], true);
  eq(runs4.length, 1, '4bit：都量化成 1 ⇒ 同一段');
  eq(runs4[0].count, 2);
  eq(runs4[0].hex, '#111F', 'toHex4 后同串');
  return '8bit 2 段 / 4bit 1 段';
});

t('★ `rowParts` 的富文本形态与源码同串：`<color=#RRGGBBAA>` + `█`×n + `</color>`', () => {
  const parts = rowParts([[255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255]], { use4bit: false, maxPixelWidth: 40 });
  eq(parts.length, 1, '一行一段（源码默认 maxPixelWidth=40）');
  eq(parts[0], '<color=#FF0000FF>\u2588\u2588\u2588</color>');
  // 两段不同色：中间是 `</color><color=…>`
  const two = rowParts([[255, 0, 0, 255], [0, 255, 0, 255]], { use4bit: false, maxPixelWidth: 40 });
  eq(two[0], '<color=#FF0000FF>\u2588</color><color=#00FF00FF>\u2588</color>');
  return parts[0];
});

t('★ 透明段换成**全角空格** `　`（源码 `processColorTags` 的结果），不是 `█`', () => {
  const parts = rowParts([[0, 0, 0, 0], [0, 0, 0, 0], [255, 0, 0, 255]], { use4bit: false, maxPixelWidth: 40 });
  eq(parts[0], TRANSPARENT_FILL.repeat(2) + '<color=#FF0000FF>\u2588</color>');
  assert(!/\u2588/.test(parts[0].slice(0, 2)), '前两个字符不许是块字符');
  eq(TRANSPARENT_FILL, '\u3000', '全角空格 U+3000');
  return '透明 ⇒ 两个 U+3000';
});

t('`rowParts` 受 `maxPixelWidth` 上限（源码的"每行最大像素宽"）', () => {
  const row = Array.from({ length: 40 }, () => [255, 0, 0, 255]);
  eq(rowParts(row, { use4bit: false, maxPixelWidth: 40 }).length, 1, '正好 40 ⇒ 1 段');
  const p16 = rowParts(row, { use4bit: false, maxPixelWidth: 16 });
  eq(p16.length, 3, '40 格 / 每段 16 ⇒ 3 段（16+16+8）');
  eq(p16.map((s) => (s.match(/\u2588/g) || []).length), [16, 16, 8], '每段的块字符数');
  return '16+16+8';
});

t('★ `rowParts` 还受千星「单条文本 ≤500 字符」约束（源码只有 maxPixelWidth，会超限）', () => {
  const row = Array.from({ length: 512 }, () => [255, 0, 0, 255]);
  const parts = rowParts(row, { use4bit: false, maxPixelWidth: 9999 });
  assert(parts.length > 1, '512 格同色一行不可能塞进 500 字符（25+512=537）');
  for (const s of parts) assert(s.length <= 500, '每段必须 ≤500：' + s.length);
  // 拼起来必须还是完整的 512 个块（不许丢像素）
  eq(parts.join('').match(/\u2588/g).length, 512, '分段后块字符总数不变');
  // 全角空格段也一样受约束
  const clearRow = Array.from({ length: 600 }, () => [0, 0, 0, 0]);
  for (const s of rowParts(clearRow, { use4bit: false, maxPixelWidth: 9999 })) {
    assert(s.length <= 500, '透明段也要 ≤500：' + s.length);
  }
  return parts.map((s) => s.length).join('+');
});

t('★ `buildPixelStruct` 形态与源码 `downloadJson` 逐字一致（这是创作者要粘进千星的 JSON）', () => {
  const grid = g([[RED, RED], [BLUE, CLEAR]]);
  const built = buildPixelStruct(grid, { structId: '1077936129', use4bit: false, maxPixelWidth: 40 });
  eq(Object.keys(built.struct), ['structId', 'type', 'value'], '顶层键');
  eq(built.struct.structId, '1077936129');
  eq(built.struct.type, 'Struct');
  eq(built.struct.value.length, 1);
  eq(built.struct.value[0].param_type, 'StringList');
  eq(built.struct.value[0].value.length, 2, '两行 ⇒ 两段');
  eq(built.struct.value[0].value[0], '<color=#FF0000FF>\u2588\u2588</color>');
  eq(built.struct.value[0].value[1], '<color=#0000FFFF>\u2588</color>\u3000');
  eq(built.maxLineChars, 27, '最长那段 = 17 壳 + 2 块 + 8 壳 = 27');
  eq(built.charLimit, 500, '单条上限');
  return JSON.stringify(built.struct.value[0].value);
});

/* ================================================================ ④ Lua 序列化（本仓驾驶层） */

const SPEC = {
  cols: 4, rows: 4, pixelSize: 10, centerOffsetX: 1, centerOffsetY: 2, imageType: 'Stretch',
  blocks: [{ x: 1, y: 2, w: 2, h: 1, color: [255, 0, 0, 255] }],
  templateIndex: 1073741900, containerIndex: 1073741866, use4bit: false,
};

t('★ `buildPixelArtLua`：交接值/网格/像素尺寸/中心偏移**全在顶部 `CONFIG`**（不写裸数字）', () => {
  const lua = buildPixelArtLua(SPEC);
  for (const line of [
    '    TEMPLATE_INDEX = 1073741900,',
    '    CONTAINER_INDEX = 1073741866,',
    '    COLS = 4,',
    '    ROWS = 4,',
    '    PIXEL_SIZE = 10,',
    '    CENTER_OFFSET_X = 1,',
    '    CENTER_OFFSET_Y = 2,',
    '    IMAGE_TYPE = "Stretch",',
  ]) {
    assert(lua.includes(line), 'CONFIG 里缺：' + line);
  }
  assert(/local CONFIG = \{/.test(lua), '要有 CONFIG 表');
  assert(lua.includes('local BLOCKS = {') && lua.includes('    {1,2,2,1,255,0,0,255},'), '块表要按 {x,y,w,h,r,g,b,a}');
  assert(/local VER = "pixel-art\/4x4\/1b"/.test(lua), 'VER 要能自证是哪一版');
  return 'CONFIG 8 个字段齐全 + 块表 1 行';
});

t('★ 像素画是**静态**的 ⇒ 产物里**不许有** `EnableUpdate` / `OnUpdate`（开 tick 只白烧预算）', () => {
  const lua = buildPixelArtLua(SPEC);
  // ⚠️ 判据用**调用形态**：注释里那句"本脚本不开 `script:EnableUpdate`"是**故意留的解释**，
  //    不能因为它含这个名字就把整条判据判红（第一版就是这么红的）。
  assert(!/script:EnableUpdate\s*\(/.test(lua), '静态像素画不该**调** script:EnableUpdate');
  assert(!/EnableUpdate\s*\(\s*true\s*\)/.test(lua), '更不该开 true');
  assert(!/function OnUpdate/.test(lua), '没有 OnUpdate 就别开 tick');
  assert(!/pcall/.test(lua), '本仓铁律：不拿 pcall 吞异常');
  // 但要**说清为什么**不加（下一个人看到会以为是漏了）
  assert(/不开.*EnableUpdate/.test(lua), '要有一行注释解释为什么不加');
  assert(/静态/.test(lua), '注释里要点明"静态"');
  assert(/function OnStart\(\)/.test(lua) && /function OnDestroy\(\)/.test(lua), 'OnStart/OnDestroy 要有');
  return '不调 EnableUpdate / 无 OnUpdate / 无 pcall，且有理由注释';
});

t('★ 控件拿不到 / 实例化返回 nil ⇒ **`error` 点名**（带模板号与第几块），不静默 return', () => {
  const lua = buildPixelArtLua(SPEC);
  assert(lua.includes('error("[pixel-art] script.object 为空'), 'script.object 为空要 error');
  assert(/CONFIG\.TEMPLATE_INDEX == nil/.test(lua) && lua.includes('缺少交接值 CONFIG.TEMPLATE_INDEX'), '缺模板索引要 error');
  assert(/InstantiateClientUIControl 返回 nil/.test(lua) && /tostring\(CONFIG\.TEMPLATE_INDEX\)/.test(lua), '实例化 nil 要带上模板号');
  assert(/第 " .. tostring\(i\) .. " 块/.test(lua), '要点名是第几块');
  assert(!/\n\s+return\s*\n/.test(lua), '不许有"建不出来就算了"的裸 return');
  return '3 处 error 点名到位';
});

t('★ 颜色走**字段** `imageColor`（`SetImageColor` 官方 0 命中）+ `Color.FromRGBA(r,g,b,a)` 参数序', () => {
  const lua = buildPixelArtLua(SPEC);
  // 同上：注释里那句"官方 `SetImageColor` 命中 0"是解释，判据要看**调用形态**
  assert(!/[:.]SetImageColor\s*\(/.test(lua), '官方文档里 SetImageColor 命中 0 —— 不许**调**它');
  assert(lua.includes('c.imageColor = Color.FromRGBA(b[5], b[6], b[7], b[8])'), '颜色字段与参数序');
  assert(lua.includes('c.imageType = imageType') && lua.includes('Enum.ImageType.Stretch'), 'imageType 走 Enum');
  assert(lua.includes('Enum.ImageType.Basic'), 'Basic 也要认（官方只有这两个值）');
  for (const m of ['c:SetAnchorMin(0.5, 0.5)', 'c:SetAnchorMax(0.5, 0.5)', 'c:SetPivot(0.5, 0.5)', 'c:SetSizeDelta(b[3] * CONFIG.PIXEL_SIZE, b[4] * CONFIG.PIXEL_SIZE)']) {
    assert(lua.includes(m), '缺 API 调用：' + m);
  }
  return 'imageColor / FromRGBA(b5..b8) / Enum.ImageType / 四个几何 API';
});

t('★ 坐标换算与源实现同一条公式（格坐标左上原点 → 相对容器中心，含中心偏移）', () => {
  const lua = buildPixelArtLua(SPEC);
  assert(lua.includes('(b[1] + b[3] / 2 - CONFIG.COLS / 2 - CONFIG.CENTER_OFFSET_X) * CONFIG.PIXEL_SIZE,'), 'x 公式');
  assert(lua.includes('(CONFIG.ROWS / 2 - b[2] - b[4] / 2 - CONFIG.CENTER_OFFSET_Y) * CONFIG.PIXEL_SIZE)'), 'y 公式（画布 y 向上所以取负）');
  // 顺手把数算一遍：x=(1+1-2-1)*10=-10，y=(2-2-0.5-2)*10=-25
  const b = SPEC.blocks[0];
  const x = (b.x + b.w / 2 - SPEC.cols / 2 - SPEC.centerOffsetX) * SPEC.pixelSize;
  const y = (SPEC.rows / 2 - b.y - b.h / 2 - SPEC.centerOffsetY) * SPEC.pixelSize;
  eq([x, y], [-10, -25], '这一块的期望锚点');
  return 'x 公式/y 公式与期望值 (-10, -25)';
});

t('`use4bit:true` ⇒ 产物**顶部加一行**「未经真机验证」；不开则没有', () => {
  const on = buildPixelArtLua(Object.assign({}, SPEC, { use4bit: true }));
  const off = buildPixelArtLua(SPEC);
  const firstLines = on.split('\n').slice(0, 10).join('\n');
  assert(/4bit/.test(firstLines) && /未经真机验证/.test(firstLines), '顶部要有 4bit 警示');
  assert(!/未经真机验证/.test(off), '不开 4bit 时不该有这行');
  assert(/Enum\.ImageType\.Stretch/.test(off));
  return '开=顶部有警示 / 关=没有';
});

t('`buildPixelArtLua` 的产物过本仓两道机械门（无 BOM / LF / 无 tab / 无分号）', () => {
  const lua = buildPixelArtLua(SPEC);
  assert(!lua.startsWith('\uFEFF'), '不许有 BOM');
  assert(!lua.includes('\r'), '不许有 CR（LF only）');
  assert(!lua.includes('\t'), '不许有 tab（缩进 4 空格）');
  assert(!/;\s*$/m.test(lua), '不许有行尾分号');
  assert(lua.endsWith('\n'), '文件以换行收尾');
  return '无 BOM / LF / 无 tab / 无分号';
});

/* ================================================================ ⑤ 工具层（真从 TOOLS 调） */

t('`TOOLS` 里真的有 `op=pixel-art`，且 description 写了「静态不加 EnableUpdate」与「典型调用」', () => {
  assert(!!gen, '找不到 miliastra_gen');
  const props = gen.parameters.properties;
  eq(props.op.enum, ['text-gradient', 'struct-json', 'pixel-art', 'vfx-lua']);
  assert(/典型调用/.test(gen.description), 'description 要有「典型调用」');
  assert(/pixel-art/.test(gen.description), 'description 要提 op=pixel-art');
  assert(/不加.*EnableUpdate|不加.*tick/.test(gen.description), '要写清"静态 ⇒ 不加 EnableUpdate"（AI 看不到 docs）');
  assert(/矩形块拼图/.test(gen.description) && /一个像素一个控件/.test(gen.description), '要写清产物形态');
  assert(/别编/.test(gen.description) || /绝不编/.test(gen.description), '交接值纪律要写进 schema');
  for (const k of ['assetId', 'source', 'cols', 'rows', 'maxSide', 'pixelSize', 'centerOffsetX', 'centerOffsetY', 'container', 'imageType', 'mergeRuns', 'templateIndex', 'use4bit', 'summaryOnly', 'structId']) {
    assert(!!props[k], 'schema 里缺参数：' + k);
  }
  return 'op enum + 15 个参数 + 4 条关键说明都在 schema 里';
});

t('未知 op **明确报错**（不静默回落成默认 op）', async () => {
  // 2026-10-08：出口不抛异常 ⇒ 回执的 ok:false + error 也算「明确报错」
  const err = await genExec({ op: 'pixel-art-typo' }).then(
    (r) => (r && r.ok === false ? String(r.error || r.code || '') : null),
    (e) => (e && e.message) || String(e));
  assert(err !== null, '应当报错');
  assert(/没有这个 op/.test(err) && /pixel-art/.test(err), '报错要列出支持的 op：' + err);
  return err.slice(0, 40);
});

t('缺交接值 ⇒ `ok:false` + `needsHandover[]` **两个都要**（模板 + 容器），且文案说"别编"', async () => {
  const fixture = path.join(tmpData, 'pa-needs-handover.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 8, rows: 8, level: 'no-such-level-xyz' });
  eq(r.ok, false, 'ok');
  assert(Array.isArray(r.needsHandover) && r.needsHandover.length === 2, 'needsHandover 要有两条：' + JSON.stringify(r.needsHandover));
  eq(r.needsHandover.map((x) => x.param).sort(), ['container', 'templateIndex']);
  assert(/别编|别自己编/.test(r.error), '文案要说"别编"：' + r.error);
  assert(/创作者/.test(r.error), '文案要指向创作者');
  assert(r.lua === undefined, '没交接值就不许给 Lua');
  assert(r.blocks > 0 && r.stats, '统计仍要给（便于先核对网格）');
  return r.needsHandover.map((x) => x.param).join(' + ');
});

t('默认 `output=lua`：回执给 `lua`/`luaBytes`/`lines`/`blocks`/`controls`/`nextStep`', async () => {
  const fixture = path.join(tmpData, 'pa-default.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 16, pixelSize: 24, templateIndex: 1073741900, container: 1073741866 });
  eq(r.ok, true, JSON.stringify(r.error));
  eq(r.output, 'lua');
  assert(typeof r.lua === 'string' && r.lua.length > 500, '要有 Lua 正文');
  eq(r.luaBytes, Buffer.byteLength(r.lua, 'utf8'));
  eq(r.lines, r.lua.split('\n').length);
  assert(r.blocks > 0 && r.blocks === r.controls, '一个块 = 一个控件');
  eq(r.target, { templateIndex: 1073741900, container: 1073741866 });
  assert(!/script:EnableUpdate\s*\(/.test(r.lua), '产物不许开 tick');
  assert(r.handoverFrom === 'arg', '两个索引都手传 ⇒ handoverFrom=arg');
  return `${r.blocks} 块 / ${r.lines} 行 / ${r.luaBytes}B`;
});

t('★ `nextStep` 提醒 **显式传 level + file**、以及**编辑器里要存盘**', async () => {
  const fixture = path.join(tmpData, 'pa-nextstep.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 8, templateIndex: 1073741900, container: 1073741866 });
  assert(/`level`/.test(r.nextStep) && /`file`/.test(r.nextStep), '要提醒显式传 level 与 file：' + r.nextStep);
  assert(/存一次盘|存盘/.test(r.nextStep), '要提醒编辑器里存盘');
  assert(/miliastra_code op=deploy/.test(r.nextStep), '要指名 deploy 工具');
  assert(/\.gia/.test(r.nextStep), '要告诉怎么确认跑的是哪一版');
  return 'level + file + 存盘 + .gia 自证 都在 nextStep 里';
});

t('非法 `cols` / `pixelSize` / `output` 在工具层**回 ok:false + 点名**（不是抛栈）', async () => {
  const fixture = path.join(tmpData, 'pa-bad-args.png');
  await makeFixture(fixture);
  const base = { op: 'pixel-art', source: fixture, templateIndex: 1073741900, container: 1073741866 };
  for (const [patch, needle] of [[{ cols: 0, rows: 4 }, 'cols'], [{ cols: 4.5, rows: 4 }, 'cols'], [{ pixelSize: 0 }, 'pixelSize'], [{ output: 'gif' }, 'output'], [{ imageType: 'Tile' }, 'imageType'], [{ centerOffsetX: 1e9 }, 'centerOffsetX']]) {
    const r = await genExec(Object.assign({}, base, patch));
    eq(r.ok, false, JSON.stringify(patch) + ' 应当 ok:false');
    assert(String(r.error).includes(needle), `错误文案要点名 ${needle}：${r.error}`);
  }
  return '6 条非法入参全部 ok:false 且点名';
});

t('图源：`assetId` 走素材库（内容寻址）；`assetId`+`source` 同给 / 都不给 / id 不存在 都报错', async () => {
  const fixture = path.join(tmpData, 'pa-asset.png');
  await makeFixture(fixture);
  const added = addAsset({ source: fixture, name: 'pixelart-fixture.png' });
  eq(added.ok, true, JSON.stringify(added.error));
  const r = await genExec({ op: 'pixel-art', assetId: added.asset.id, cols: 8, pixelSize: 8, templateIndex: 1073741900, container: 1073741866 });
  eq(r.ok, true, JSON.stringify(r.error));
  eq(r.image.from, 'asset', '要标明图源来自素材库');
  eq(r.image.ref, added.asset.id, '回执要带素材 id');
  const both = await genExec({ op: 'pixel-art', assetId: added.asset.id, source: fixture, cols: 8 });
  eq(both.ok, false);
  assert(/只能给一个/.test(both.error), both.error);
  const none = await genExec({ op: 'pixel-art', cols: 8 });
  eq(none.ok, false);
  assert(/assetId/.test(none.error) && /source/.test(none.error), none.error);
  const missing = await genExec({ op: 'pixel-art', assetId: 'ffffffffffffffff', cols: 8 });
  eq(missing.ok, false);
  assert(/没有 id/.test(missing.error), missing.error);
  return 'asset 路径可用；三种错法都点名';
});

t('`output=data` 给块列表（含 rgba 与 hex）；`summaryOnly` **只去正文不去结论**', async () => {
  const fixture = path.join(tmpData, 'pa-data.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data' });
  eq(r.ok, true, JSON.stringify(r.error));
  eq(r.output, 'data');
  assert(Array.isArray(r.blockList) && r.blockList.length === r.blocks);
  eq(r.blockList[0].rgba.length, 4);
  assert(/^#[0-9A-F]{8}$/.test(r.blockList[0].hex), 'hex 形态：' + r.blockList[0].hex);
  const slim = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data', summaryOnly: true });
  eq(slim.blockList, undefined, 'summaryOnly 去掉正文');
  eq(slim.blockListOmitted, true);
  eq(slim.blockListCount, r.blocks, '**结论（块数）必须留**');
  eq(slim.blocks, r.blocks);
  assert(JSON.stringify(slim).length < JSON.stringify(r).length, 'summaryOnly 必须真的省体积');
  const luaSlim = await genExec({ op: 'pixel-art', source: fixture, cols: 16, pixelSize: 8, templateIndex: 1073741900, container: 1073741866, summaryOnly: true });
  eq(luaSlim.lua, undefined, 'lua 模式 summaryOnly 去掉 Lua 正文');
  assert(luaSlim.luaBytesOmitted > 0, '但要给字节数');
  assert(!!luaSlim.nextStep && Array.isArray(luaSlim.warnings), 'nextStep 与 warnings 必须留');
  return `data ${r.blocks} 条 → summaryOnly 省 ${JSON.stringify(r).length - JSON.stringify(slim).length}B`;
});

t('`output=struct` 给千星变量 JSON；非法 `structId` ⇒ ok:false + needsHandover（ID 也是交接值）', async () => {
  const fixture = path.join(tmpData, 'pa-struct.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'struct', structId: '1077936129' });
  eq(r.ok, true, JSON.stringify(r.error));
  eq(r.structId, '1077936129');
  const parsed = JSON.parse(r.structText);
  eq(parsed.structId, '1077936129');
  eq(parsed.type, 'Struct');
  eq(parsed.value[0].param_type, 'StringList');
  eq(parsed.value.length, 1);
  eq(r.structPartCount, parsed.value[0].value.length);
  assert(r.maxLineChars <= 500, '单条文本 ≤500 硬规则：' + r.maxLineChars);
  const bad = await genExec({ op: 'pixel-art', source: fixture, cols: 8, output: 'struct', structId: '123' });
  eq(bad.ok, false);
  assert(/10 位数字/.test(bad.error), bad.error);
  eq(bad.needsHandover.length, 1);
  eq(bad.needsHandover[0].param, 'structId');
  const def = await genExec({ op: 'pixel-art', source: fixture, cols: 8, output: 'struct' });
  eq(def.structId, '1077936129', '不给就用默认（源码同值）');
  return `struct 分 ${r.structPartCount} 段 / 最长 ${r.maxLineChars} 字符`;
});

t('`use4bit:true` ⇒ 产物顶部加警示 + 回执 `unverified[]` 列出 4bit；颜色确实被量化', async () => {
  const fixture = path.join(tmpData, 'pa-4bit.png');
  await makeFixture(fixture);
  const r = await genExec({ op: 'pixel-art', source: fixture, cols: 16, pixelSize: 8, templateIndex: 1073741900, container: 1073741866, use4bit: true });
  eq(r.ok, true, JSON.stringify(r.error));
  assert(r.unverified.some((u) => u.param === 'use4bit'), 'unverified 要列 4bit：' + JSON.stringify(r.unverified));
  assert(/0 命中/.test(r.unverified.find((u) => u.param === 'use4bit').why), '要说清依据（官方原文 0 命中）');
  assert(r.unverified.some((u) => /真机/.test(u.param)), '真机渲染那条恒在');
  assert(/未经真机验证/.test(r.lua.split('\n').slice(0, 12).join('\n')), '产物顶部要有警示行');
  const data = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data', use4bit: true });
  const red = data.blockList.find((b) => b.rgba[0] > 200 && b.rgba[1] < 60);
  eq(red.rgba, [255, 0, 0, 255], '纯红量化后仍是 255/0/0/255');
  const plain = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data', use4bit: false });
  assert(plain.unverified.every((u) => u.param !== 'use4bit'), '不开就不该列 4bit');
  return r.unverified.map((u) => u.param).join(' + ');
});

t('`mergeRuns:false` ⇒ 块数 = 非透明格数（工具层可观测）', async () => {
  const fixture = path.join(tmpData, 'pa-merge.png');
  await makeFixture(fixture);
  const merged = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data' });
  const flat = await genExec({ op: 'pixel-art', source: fixture, cols: 16, output: 'data', mergeRuns: false });
  assert(flat.blocks > merged.blocks, `不合并的块数必须更多：${flat.blocks} vs ${merged.blocks}`);
  eq(flat.blocks + Number(flat.stats.transparentCells), flat.stats.cells, '不合并时：块数 + 透明格数 = 总格数');
  eq(merged.stats.transparentCells, flat.stats.transparentCells, '两种模式的透明格数必须一样');
  return `合并 ${merged.blocks} / 不合并 ${flat.blocks} / 透明 ${flat.stats.transparentCells}`;
});

t('`handoverFrom` 如实标注来源；缺交接值时的回执带 `handoverCandidates`（给创作者核对）', async () => {
  const fixture = path.join(tmpData, 'pa-handover-shape.png');
  await makeFixture(fixture);
  const both = await genExec({ op: 'pixel-art', source: fixture, cols: 8, pixelSize: 8, templateIndex: 1073741900, container: 1073741866 });
  eq(both.handoverFrom, 'arg', '两个都手传 ⇒ arg（不假装是从 .gil 读的）');
  assert(Array.isArray(both.handoverCandidates) && both.handoverCandidates.length === 0, '没去读 .gil 时候选是空数组');
  const why = await genExec({ op: 'pixel-art', source: fixture, cols: 8, level: 'no-such-level-xyz' });
  eq(why.ok, false, '这个不存在的关卡上读不到候选 ⇒ 回 needsHandover');
  assert(Array.isArray(why.handoverCandidates), 'ok:false 那条路也必须带 handoverCandidates（形状一致）');
  assert(why.handoverFrom === null, '读不到就是 null');
  return 'arg / null 两种来源都如实标';
});

t('`deviationsOf` 如实列出与源码的刻意偏差（默认 pixelSize=8 会标 used:true）', () => {
  const d = deviationsOf(DEFAULT_PIXEL_SIZE);
  assert(d.some((x) => x.used === true && /pixelSize/.test(x.what)), '默认 8 时要标 used:true：' + JSON.stringify(d));
  const d2 = deviationsOf(4);
  assert(d2.find((x) => /pixelSize/.test(x.what)).used === false, '非默认值时 used:false');
  assert(d.some((x) => /use4bit/.test(x.what)), '4bit 量化那条要列出来');
  assert(d.some((x) => /mergeRuns/.test(x.what)), 'mergeRuns 那条要列出来');
  return d.length + ' 条偏差';
});

t('`pixelArt()` 直接调用：交接值**从 args 或 handover 任一处给**都走得通（编排层与工具层解耦）', async () => {
  const fixture = path.join(tmpData, 'pa-direct.png');
  await makeFixture(fixture);
  const viaArgs = await pixelArt({ source: fixture, cols: 8, rows: 8, pixelSize: 8, templateIndex: 1073741900, container: 1073741866 });
  eq(viaArgs.ok, true, JSON.stringify(viaArgs.error));
  eq(viaArgs.handoverFrom, 'arg', '参数里给了 ⇒ 如实标 arg（不假装是从 .gil 读的）');
  assert(!!viaArgs.lua, '要有 Lua');
  const viaHandover = await pixelArt({ source: fixture, cols: 8, rows: 8, pixelSize: 8 }, { templateIndex: 1073741900, container: 1073741866, from: 'gil' });
  eq(viaHandover.ok, true, JSON.stringify(viaHandover.error));
  eq(viaHandover.handoverFrom, 'gil', '从 handover 进来时如实标 gil');
  assert(viaHandover.warnings.some((w) => w.code === 'HANDOVER_AUTO_FROM_GIL'), '自动从 .gil 读的交接值必须给 warning');
  eq(viaArgs.lua, viaHandover.lua, '两条路生成的 Lua 必须一致（同一份参数）');
  return `${viaArgs.blocks} 块；arg/gil 两条路都通`;
});

/* ================================================================ ⑥ 端到端（生成 → 模拟器跑到块出现） */

/**
 * 端到端：**我们自己画的图** → `op=pixel-art` → 写进临时目录 → 模拟器 bind/play/shot → 数像素。
 *
 * 为什么必须真跑一遍：前面所有断言只证明"代码算出来的数字对"，**证明不了"块真的画出来了"**。
 * 这一条把闭环补上，而且用**三个互相独立的数**交叉验证：
 *   ① 四象限中心的颜色逐点相等（颜色对得上）；
 *   ② 透明格那片区域**与空场景完全一致**（透明 = 真的没建控件，不是黑色块）；
 *   ③ 「与空场景的像素差」**正好等于所有块面积之和**（多一个像素都说明有东西画错位置）。
 */
t('★ 端到端：自造图 → 生成 Lua → 模拟器跑起来建了 4 个控件 → PNG 里像素差 == 块面积', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const fixture = path.join(tmpData, 'pa-e2e.png');
  await makeFixture(fixture);   // 64×64：四象限四色 + 中间 4px 透明竖条

  const COMMON = { op: 'pixel-art', source: fixture, cols: 16, pixelSize: 24, templateIndex: 1073741900, container: 1073741866 };
  const data = await genExec(Object.assign({}, COMMON, { output: 'data' }));   // 块的**真值**（几何 + 颜色）
  const gen = await genExec(COMMON);                                          // 同一份参数 → 同一份 Lua
  eq(data.ok, true, JSON.stringify(data.error));
  eq(gen.ok, true, JSON.stringify(gen.error));
  eq(data.blocks, gen.controls, 'data 与 lua 两条路必须算出同一个块数');
  const luaFile = path.join(tmpData, 'pa-e2e.lua');
  fs.writeFileSync(luaFile, gen.lua, 'utf8');

  // ① 跑：模板 guid 用**交接值**（不许编），脚本挂容器节点
  const bound = await simOp({
    op: 'bind', source: luaFile, containerId: 1073741866,
    templates: [{ guid: 1073741900, kind: 'image', name: '像素块' }],
    run: true, settleSec: 1, keepRunning: true, fresh: true,
  });
  const logs = (bound.run && bound.run.logs) || [];
  assert(logs.some((l) => /\[pixel-art\] start ver=pixel-art\/16x16\/4b/.test(String(l.text))), '脚本要跑起来并自报版本：' + JSON.stringify(logs.map((l) => l.text)));
  assert(logs.some((l) => /built controls=4/.test(String(l.text))), '要自报建了几个');
  assert(logs.some((l) => /container=1073741866/.test(String(l.text))), 'start 行要带上容器交接值（自证挂在哪）');
  eq(bound.run.controlCount, 1 + data.blocks, '控件总数 = 容器 + 每块一个（脚本真的建出来了）');

  const shot = await simOp({ op: 'shot', target: 'play', label: 'pixelart-e2e' });
  assert(fs.existsSync(shot.file) && shot.bytes > 1000, 'PNG 要真落盘');
  eq(fs.readFileSync(shot.file).subarray(0, 4).toString('hex'), '89504e47', 'PNG 魔数');

  // ② 空场景参照：同一份工程、同样的模板，只把脚本换成"什么都不建"
  const noop = path.join(tmpData, 'pa-e2e-noop.lua');
  fs.writeFileSync(noop, '-- 空场景参照\nfunction OnStart()\n    print("[noop] start")\nend\n', 'utf8');
  const empty = await simOp({
    op: 'bind', source: noop, containerId: 1073741866,
    templates: [{ guid: 1073741900, kind: 'image', name: '像素块' }],
    run: true, settleSec: 1, keepRunning: true, fresh: true,
  });
  eq(empty.run.controlCount, 1, '空场景只有容器');
  const emptyShot = await simOp({ op: 'shot', target: 'play', label: 'pixelart-e2e-empty' });

  // ③ 数像素
  const readPng = async (file) => {
    const img = await loadImage(fs.readFileSync(file));
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  };
  const A = await readPng(shot.file);
  const B = await readPng(emptyShot.file);
  eq([A.w, A.h], [1600, 900], '画布尺寸');

  const at = (S, x, y) => { const i = (y * S.w + x) * 4; return [S.d[i], S.d[i + 1], S.d[i + 2], S.d[i + 3]]; };

  /*
   * ★ 逐块核对：把每一块的**中心点**算到屏幕上，采样看颜色是否等于 `blockList[].rgba`。
   *   这一步同时验了两件事：① 位置换算公式（含中心偏移）真的把块放对地方；② 颜色真的写进了 `imageColor`。
   *   屏幕坐标 = 画布中心 + 换算出来的锚点（y 取负：块坐标左上原点 → 画布 y 向上）。
   */
  const CX = A.w / 2; const CY = A.h / 2;
  const centers = data.blockList.map((b) => ({
    b,
    x: Math.round(CX + (b.x + b.w / 2 - gen.grid.cols / 2 - gen.centerOffsetX) * gen.pixelSize),
    y: Math.round(CY - (gen.grid.rows / 2 - b.y - b.h / 2 - gen.centerOffsetY) * gen.pixelSize),
  }));
  for (const c of centers) {
    const got = at(A, c.x, c.y);
    eq(got, [c.b.rgba[0], c.b.rgba[1], c.b.rgba[2], c.b.rgba[3]], `块#${c.b.i} 中心 (${c.x},${c.y}) 的颜色`);
  }
  // 画布空白处两图必须一致（说明只有像素画那一片变了）
  assert(JSON.stringify(at(A, 300, 200)) === JSON.stringify(at(B, 300, 200)), '画布空白处两图必须一致');

  let changed = 0;
  let minX = 1e9; let minY = 1e9; let maxX = -1; let maxY = -1;
  const rowChange = new Map();   // y → 该行「变了/没变」的连续段（用来验透明缝）
  for (let i = 0; i < A.d.length; i += 4) {
    const d = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]), Math.abs(A.d[i + 3] - B.d[i + 3]));
    if (d > 8) {
      changed += 1;
      const p = i >> 2; const x = p % A.w; const y = (p / A.w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (!rowChange.has(y)) rowChange.set(y, []);
      rowChange.get(y).push(x);
    }
  }
  // ★ 与空场景的像素差必须**正好等于块面积**（多一个像素都说明有东西画错位置或画多了）
  const blockArea = data.blockList.reduce((s, b) => s + b.w * b.h, 0) * gen.pixelSize * gen.pixelSize;
  eq(changed, blockArea, '像素差 == Σ(w×h) × pixelSize²');
  const artW = gen.grid.cols * gen.pixelSize;
  const artH = gen.grid.rows * gen.pixelSize;
  eq([minX, minY, maxX - minX + 1, maxY - minY + 1], [CX - artW / 2, CY - artH / 2, artW, artH], '变化区域 = 整幅像素画的包围盒');

  // ★ 透明格：像素画**内部**必须有一条"没变"的缝（那里真的没建控件），宽度正好 = pixelSize
  const midY = Math.round(CY - artH / 2 + gen.pixelSize / 2);   // 第 1 行像素带的中心
  const xs = (rowChange.get(midY) || []).slice().sort((a, b) => a - b);
  assert(xs.length > 0, '这一行应当有变化像素（midY=' + midY + '）');
  const rowBlocks = data.blockList.filter((b) => b.y === 0).sort((p, q) => p.x - q.x);
  eq(rowBlocks.length, 2, '第 1 行像素带上有两块（左右各一）');
  const left = rowBlocks[0]; const right = rowBlocks[1];
  const gaps = [];
  for (let i = 1; i < xs.length; i += 1) if (xs[i] - xs[i - 1] > 1) gaps.push([xs[i - 1], xs[i]]);
  eq(gaps.length, 1, '两块之间应当只有**一条**缝：' + JSON.stringify(gaps));
  eq(gaps[0][1] - gaps[0][0] - 1, (right.x - (left.x + left.w)) * gen.pixelSize, '缝宽 = 中间被透掉的格数 × pixelSize');
  assert(gaps[0][1] - gaps[0][0] - 1 > 0, '缝宽必须 > 0（透明格真的没建控件）');
  for (let x = gaps[0][0] + 1; x < gaps[0][1]; x += 1) {
    assert(JSON.stringify(at(A, x, midY)) === JSON.stringify(at(B, x, midY)), '缝里每个像素都必须与空场景一致（x=' + x + '）');
  }
  eq(gen.stats.transparentCells * gen.pixelSize * gen.pixelSize,
    (gen.grid.cols * gen.grid.rows - data.blockList.reduce((s, b) => s + b.w * b.h, 0)) * gen.pixelSize * gen.pixelSize,
    '透明格面积 == 总格数 − 块面积');

  // ④ 静态：帧间像素差必须是 0（顺带证明"不该加 tick"）
  const frames = await simOp({ op: 'frames', frames: [0, 0.5], label: 'pixelart-e2e' });
  eq(frames.diffs[0].changedPixels, 0, '像素画是静态的：0.5 秒后一个像素都不该变');
  eq(frames.diffs[0].identical, true);

  await simOp({ op: 'play', action: 'stop' });
  return `${data.blocks} 控件 / 逐块颜色全对 / 像素差 ${changed} == 块面积 ${blockArea} / 缝宽 ${gaps[0][1] - gaps[0][0] - 1}px / 帧间差 0`;
});

/* ================================================================ 汇总 */

console.log('');
for (const [name, fn] of queue) {
  try {
    const d = await fn();
    ok(name, d === undefined ? '' : d);
  } catch (e) {
    bad(name, (e && e.message) || String(e));
  }
}

await disposeSimAll().catch(() => {});
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 临时目录清不掉就算了 */ }

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
