// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/TextGradient/types/config.ts
//   （配置形状 `{colors, sizes, text, option:{isSetColor,isUse4bit,isUseSize,isSkipSpace}}`）
//   与 src/views/TextGradient/types/DisplayStyle.ts（颜色/字号风格枚举原文）。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 三处**刻意的偏差**（都在回执 `deviations[]` 里如实报出，不假装逐字等价）：
//   ① 风格枚举**自己命名**（源码的内部名 `ColorFlow1`/`ColorFlow2`/`Jump1` 不照抄）；
//      映射：普通=flat、流动1=flow-forward、流动2=flow-backward、淡入=fade-in、淡出=fade-out、跳字=jitter。
//   ② 源码的 `colors` 默认值是**随机色**（`RandomColor()`）—— 不可复现，这里钉成固定默认值。
//   ③ 源码用 `chroma-js` 的 `chroma.scale()` 采样色标（默认插值模式是 chroma 自己的实现）；
//      我们**不引入该依赖**（拆解书 §2.4.5 的建议），改成**线性 sRGB 通道插值**：
//      色标端点颜色完全一致，中间色可能与 chroma 略有差别。

/** 颜色风格（源码：normal / ColorFlow1 / ColorFlow2 / FadeIn / FadeOut）。 */
export const COLOR_STYLES = [
  { id: 'flat', label: '普通', source: 'normal' },
  { id: 'flow-forward', label: '流动1（正向）', source: 'ColorFlow1' },
  { id: 'flow-backward', label: '流动2（反向）', source: 'ColorFlow2' },
  { id: 'fade-in', label: '淡入', source: 'FadeIn' },
  { id: 'fade-out', label: '淡出', source: 'FadeOut' },
];

/**
 * 字号风格（源码：normal / Jump1）。
 * ⚠️ 源码给 `Jump1` 的中文标签是 `跳字(没什么用)`（作者自嘲），这里按它的实际行为命名为「跳字」。
 */
export const SIZE_STYLES = [
  { id: 'flat', label: '普通（按字号色标分段插值）', source: 'normal' },
  { id: 'jitter', label: '跳字（每帧随机挑几个字符放大）', source: 'Jump1' },
];

/**
 * 默认色标。**刻意偏离源码**：源码 `colors` 默认是 `[RandomColor(), RandomColor()]`（每次不同），
 * 一个确定性工具不能有这个默认值 ⇒ 钉成白→金（官方 `<color=#D3BC8E>` 一族）。
 */
export const DEFAULT_COLORS = ['#FFFFFF', '#D3BC8E'];

/** 默认字号色标（源码 `sizes = [20, 20]`，逐字一致）。 */
export const DEFAULT_SIZES = [20, 20];

/**
 * 源码里 `FadeInFrames = 24` / `FadeOutFrames = 24`（同一个魔数，两处各写一遍）。
 * 合并成一个常量，数值不变。
 */
export const FADE_FRAMES = 24;

/** 跳字风格的默认取值范围（源码 UI 的 `sizeParams = [20, 40, ...]`：0 号=最小值、1 号=最大值）。 */
export const DEFAULT_SIZE_MIN = 20;
export const DEFAULT_SIZE_MAX = 40;

/** 跳字风格每帧随机改写的字符数（源码里硬编码 `count < 50`，不暴露给用户）。 */
export const JITTER_PICKS = 50;

/** 跳字风格里「未被挑中」的字符的字号（源码硬编码 `frame.push(20)`）。 */
export const JITTER_BASE_SIZE = 20;

/** 确定性 PRNG（mulberry32）—— 源码用 `Math.random()`，我们要可复现，所以换成固定种子的 PRNG。 */
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `getRandomInt(min,max)` 的确定性版本（源码：`floor(random*(max-min+1))+min`）。 */
export function randInt(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

const clamp255 = (v) => Math.min(255, Math.max(0, v));

/**
 * 解析一个颜色字符串 → `{r,g,b,a}`（`r/g/b` 0~255，`a` 0~1）。
 * 只认十六进制与 `rgb()/rgba()`（chroma 能认的 CSS 名字/HSL 等**故意不认** —— 不引入依赖，也不猜）。
 * @param {string} input
 * @returns {{r: number, g: number, b: number, a: number}}
 */
export function parseColor(input) {
  const s = String(input == null ? '' : input).trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (fn) {
    return { r: clamp255(Number(fn[1])), g: clamp255(Number(fn[2])), b: clamp255(Number(fn[3])), a: fn[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(fn[4]))) };
  }
  throw new Error('认不出的颜色：' + JSON.stringify(input)
    + '（只认 #RGB / #RGBA / #RRGGBB / #RRGGBBAA 与 rgb()/rgba()；CSS 颜色名与 HSL 故意不支持）');
}

/** 两个颜色按 `t` 线性插值（含 alpha）。 */
export function mixColor(c1, c2, t) {
  const lerp = (a, b) => a + (b - a) * t;
  return { r: lerp(c1.r, c2.r), g: lerp(c1.g, c2.g), b: lerp(c1.b, c2.b), a: lerp(c1.a, c2.a) };
}

/** 换掉 alpha（保留 RGB）—— 对应源码的 `chroma.alpha(x)`。 */
export function withAlpha(color, a) {
  return { r: color.r, g: color.g, b: color.b, a: Math.min(1, Math.max(0, a)) };
}

/**
 * 色标采样器：把 `[c0, c1, … cn]` 变成 `t → color` 的分段线性函数（`t` 会被夹到 0~1）。
 * 对应源码的 `chroma.scale(colors)(t)`（插值方式见本文件头的偏差③）。
 */
export function scaleSampler(colors) {
  if (!colors.length) throw new Error('色标为空：至少给 1 个颜色');
  if (colors.length === 1) return () => colors[0];
  const segs = colors.length - 1;
  return (t) => {
    const x = Math.min(1, Math.max(0, t));
    const seg = Math.min(Math.floor(x * segs), segs - 1);
    return mixColor(colors[seg], colors[seg + 1], x * segs - seg);
  };
}

/** 8bit 十六进制（**6 位、小写**，与 chroma 的 `.hex()` 同形；**alpha 被丢掉** —— 源码就是这样）。 */
export function hex6(color) {
  const h = (v) => Math.round(clamp255(v)).toString(16).padStart(2, '0');
  return '#' + h(color.r) + h(color.g) + h(color.b);
}

/** 4bit 通道量化（源码 `Math.round((v/255)*15)` → 0~15）。 */
export function to4Bit(v) {
  return Math.round((v / 255) * 15);
}

/**
 * 4bit 短格式十六进制（源码 `applyColorChannels`）：`#RGB`，alpha 不足 15 时补第 4 位 → `#RGBA`。
 * ⚠️ 该格式**没有官方依据**（官方文档只给了 `#FFFFFF` 六位）⇒ 回执必须标「未经真机验证」。
 *
 * ⚠️ **这里踩过一次真坑（被 `tests/gen-test.mjs` 抓到）**：alpha 已经量化成 0~15 了，
 * 不能再喂回 `one()` —— `one()` 是按 0~255 量化的，`one(8)` 会算成 `round(8/255*15)=0`，
 * 于是「半透明」全变成 `#f000`。源码在这一点上是对的（四个通道量化后统一用**裸** `toString(16)`）。
 */
export function hex4(color) {
  const one = (v) => to4Bit(clamp255(v)).toString(16);
  const a = to4Bit(color.a * 255);
  return '#' + one(color.r) + one(color.g) + one(color.b) + (a === 15 ? '' : a.toString(16));
}

/**
 * 分段线性插值取字号（对应源码 `sizeFrams` 的 `normal` 分支）。
 *
 * ⚠️ **修正**（本文件唯一改算法的地方）：源码写的是
 *   `sT = t * sizeSegs` 然后 `lerp(sizes[seg], sizes[seg+1], sT)` —— `sT` 是**全局**刻度（0~sizeSegs），
 *   不是区间内的 0~1。2 个色标时 `sizeSegs=1` 恰好等价，**≥3 个色标就会算出区间外的值**
 *   （例：`[10,20,30]`、`t=0.5` → 源码得 30，应为 20）。源码 UI 只暴露 2 个色标，所以那个 bug 不可见。
 *   这里按标准的「区间内局部 t」实现；两条路在 2 色标下**逐值相同**。
 * @param {number[]} stops
 * @param {number} t
 * @returns {number}
 */
export function piecewiseSize(stops, t) {
  if (!stops.length) return 0;
  if (stops.length === 1) return stops[0];
  const segs = stops.length - 1;
  const x = Math.min(1, Math.max(0, t));
  const seg = Math.min(Math.floor(x * segs), segs - 1);
  return stops[seg] + (stops[seg + 1] - stops[seg]) * (x * segs - seg);
}

/** 把用户给的一批颜色字符串解析成色标（任一非法就抛，带上下文）。 */
export function parseColors(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('colors 必须是「至少 1 个颜色字符串」的数组');
  return list.map((c) => parseColor(c));
}

/** 把用户给的字号色标规整成有限数字数组。 */
export function parseSizes(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('sizes 必须是「至少 1 个数字」的数组');
  return list.map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('sizes 里有非数字：' + JSON.stringify(v));
    return n;
  });
}

/** 风格 id → 内部 id（未知就抛错并列出全部合法值）。 */
function pickStyle(list, raw, fallback, what) {
  const id = raw === undefined || raw === null || raw === '' ? fallback : String(raw);
  const hit = list.find((s) => s.id === id);
  if (!hit) throw new Error(`不认识的 ${what}：${JSON.stringify(raw)}（合法值：${list.map((s) => s.id).join(' / ')}）`);
  return hit.id;
}

/**
 * 把工具入参规整成一份**完整配置**（默认值见本文件常量）。
 * ⚠️ 回执类型写成 `{ok: boolean, config?, error?}` 而不是 `ok: true | false` 的字面量联合 ——
 *    `tsc --checkJs` 认不出 JSDoc 里的字面量判别式，于是 `if (!norm.ok)` 之后**窄化不掉**，
 *    `norm.error` 会报 TS2339（实测踩过）。
 * @param {Record<string, any>} args
 * @returns {{ok: boolean, config?: Record<string, any>, error?: string}}
 */
export function normalizeConfig(args = {}) {
  try {
    const text = String(args.text == null ? '' : args.text);
    const colors = parseColors(args.colors && args.colors.length ? args.colors : DEFAULT_COLORS);
    const sizes = parseSizes(args.sizes && args.sizes.length ? args.sizes : DEFAULT_SIZES);
    const colorStyle = pickStyle(COLOR_STYLES, args.colorStyle, 'flat', 'colorStyle');
    const sizeStyle = pickStyle(SIZE_STYLES, args.sizeStyle, 'flat', 'sizeStyle');
    const jump = Number(args.colorJumpFrames);
    const sizeMin = Number.isFinite(Number(args.sizeMin)) ? Number(args.sizeMin) : DEFAULT_SIZE_MIN;
    const sizeMax = Number.isFinite(Number(args.sizeMax)) ? Number(args.sizeMax) : DEFAULT_SIZE_MAX;
    const seed = Number.isFinite(Number(args.seed)) ? Math.floor(Number(args.seed)) : 12345;
    return {
      ok: true,
      config: {
        text,
        chars: Array.from(text),
        colors,
        sizes,
        colorStyle,
        sizeStyle,
        withColor: args.withColor !== false,
        withSize: args.withSize === true,
        use4bit: args.use4bit === true,
        colorJumpFrames: Number.isFinite(jump) && jump > 0 ? Math.floor(jump) : 0,
        sizeMin: Math.min(sizeMin, sizeMax),
        sizeMax: Math.max(sizeMin, sizeMax),
        seed,
      },
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** 本文件头三条偏差的**机器可读**版本（回执里原样给出去，别让调用方去读注释）。 */
export function deviationsOf() {
  return [
    '风格枚举自己命名（源码内部名 ColorFlow1/ColorFlow2/Jump1 未照抄）',
    '默认色标钉成固定值（源码默认是随机色，不可复现）',
    '色标采样改为线性 sRGB 插值（源码用 chroma-js 的 chroma.scale，我们刻意不引入该依赖）',
    '字号插值修正了源码的区间外取值（≥3 个色标才可见；2 个色标逐值相同）',
    '跳字风格用固定种子 PRNG（源码用 Math.random，不可复现）',
  ];
}
