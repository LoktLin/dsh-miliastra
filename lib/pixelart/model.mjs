// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （只移植**纯逻辑**：4bit 量化 / 颜色与 hex 换算 / 参数校验口径；界面层是本仓自己写的。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 与源码的**刻意偏差**（改行为前先读这几条；回执 `deviations[]` 里也会点名）：
//   ① 默认 `pixelSize` = 8（源码走 `script:GetParam("PixelSize")`，缺省 1）—— 1 时一整幅 20×20 的
//      画只有 20 像素宽，画面上几乎看不见；本仓 UI 栅格也是 8 的倍数。
//   ② `use4bit` 在源码里**只影响那段富文本**（`mergePixels` 用的是原始 RGBA）；本仓让它**同时**量化
//      `Color.FromRGBA` 的入参（`round(v/17)*17`）—— 否则 `output:"lua"` 下这个开关等于空转。
//   ③ alpha 固定写 8 位（源码默认 `isUseAlpha=true`，但没暴露开关）。
//   ④ `mergeRuns:false`（一格一个块）是**本仓新增**的开关，源码恒做行程合并。
//
// ★ 官方依据（本仓 `docs/官方文档-7.1正式/原文/doc_客户端控件API文档.txt` 逐条核过）：
//   `Color.FromRGBA(r,g,b,a)` / `Enum.ImageType`（Basic|Stretch）/ `imageColor` 字段（读写）全部存在；
//   ⚠️ **`SetImageColor` 命中 0** ⇒ 颜色只能走字段 `imageColor`。
//   官方原文里 `4bit` / `#RGB` **0 命中** ⇒ 4bit 量化未经真机验证，默认关，启用时产物顶部加警示注释。

/** 4bit 量化的分母：`255 / 15 = 17`（源码注释原话「255 / 15 ≈ 17」）。 */
export const QUANT_STEP = 17;
/** 网格单边上限（再大就会建出成千上万个控件）。 */
export const GRID_MAX = 512;
/** 像素块边长上限（一个块就是一个图片控件，太大没意义）。 */
export const PIXEL_SIZE_MIN = 1;
export const PIXEL_SIZE_MAX = 64;
/** 默认像素块边长 —— 见文件头偏差 ①。 */
export const DEFAULT_PIXEL_SIZE = 8;
/** 一个矩形块 = 一个图片控件；超这个数**警告**（不是错），超 `BLOCKS_MAX` 才拒绝。 */
export const BLOCKS_WARN = 512;
export const BLOCKS_MAX = 20000;
/** 中心偏移的绝对值上限（防手滑写 1e9）。 */
export const OFFSET_MAX = 4096;
/** `Enum.ImageType` 的两个值（官方 7.1 原文只有这两个）。 */
export const IMAGE_TYPES = Object.freeze(['Stretch', 'Basic']);
/** `output` 的三种模式：默认 lua（一次调用直接给可部署 Lua）。 */
export const OUTPUTS = Object.freeze(['lua', 'struct', 'data']);
/** 结构体 ID 的默认值（源码里的默认 `1077936129`）。 */
export const DEFAULT_STRUCT_ID = '1077936129';
/** `struct` 模式：每段最多几个块字符（源码的 `maxPixelWidth` 默认 40）。 */
export const DEFAULT_MAX_PIXEL_WIDTH = 40;
/** 没给 cols/rows/maxSide 时的兜底长边格数（会在 `gridFrom` 里如实标 `default`）。 */
export const DEFAULT_MAX_SIDE = 32;

/** 整数钳位。 */
export function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 4bit 量化：`Math.round(v / 17)` → 0..15。**逐字移植**源码 `rgbaToHex` 里的 `toHex4`
 * （那里靠 `toString(16)` 落成一位十六进制字符；我们把它拆成"量化"与"成串"两步，好单测）。
 */
export function quant4(v) {
  const n = Math.round(Number(v) / QUANT_STEP);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, n));
}

/** 量化后再铺回 0..255（`Color.FromRGBA` 只吃 0–255，所以要还原到网格上）。 */
export function expand4(v) {
  return quant4(v) * QUANT_STEP;
}

/**
 * 一个 RGBA 是否要量化。`on:false` 时**原样返回**（不拷贝也无所谓，调用方不写它）。
 * @param {number[]} c
 * @param {boolean} on
 * @returns {number[]}
 */
export function quantColor(c, on) {
  if (!on) return c;
  return [expand4(c[0]), expand4(c[1]), expand4(c[2]), expand4(c[3])];
}

/** 0..255 → 两位大写十六进制。 */
export function toHex8(v) {
  return clampInt(v, 0, 255).toString(16).toUpperCase().padStart(2, '0');
}

/** 0..255 → 一位大写十六进制（4bit）。 */
export function toHex4(v) {
  return quant4(v).toString(16).toUpperCase();
}

/**
 * `#RRGGBBAA` / 4bit `#RGBA` —— **逐字移植**源码 `rgbaToHex`（含 4bit 的 `round(v/17)` 口径）。
 * @param {number} r @param {number} g @param {number} b @param {number} a
 * @param {boolean} use4bit
 */
export function rgbaToHex(r, g, b, a, use4bit) {
  if (!use4bit) return '#' + toHex8(r) + toHex8(g) + toHex8(b) + toHex8(a);
  return '#' + toHex4(r) + toHex4(g) + toHex4(b) + toHex4(a);
}

/** 逐通道全等（源码 `sameColor`）。 */
export function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** `output` 校验（默认 lua）。 */
export function parseOutput(v) {
  const s = v === undefined || v === null || v === '' ? 'lua' : String(v);
  if (!OUTPUTS.includes(s)) {
    throw new Error('output 只能是 ' + OUTPUTS.join(' / ') + '，收到：' + JSON.stringify(v)
      + '（默认 lua —— 一次调用直接给可部署的 Lua）');
  }
  return s;
}

/** `imageType` 校验（默认 Stretch）。 */
export function parseImageType(v) {
  const s = v === undefined || v === null || v === '' ? 'Stretch' : String(v);
  if (!IMAGE_TYPES.includes(s)) {
    throw new Error('imageType 只能是 ' + IMAGE_TYPES.join(' / ') + '，收到：' + JSON.stringify(v)
      + '（默认 Stretch；官方 7.1 原文 Enum.ImageType 只有这两个值）');
  }
  return s;
}

/** 有界整数校验（不合法就抛，文案里给期望与实到）。 */
export function requireInt(v, name, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(name + ' 要是 ' + lo + '~' + hi + ' 的整数，收到：' + JSON.stringify(v));
  }
  return n;
}

/** 有界数值校验（`pixelSize` / 中心偏移都用它）。 */
export function requireNumber(v, name, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new Error(name + ' 要是 ' + lo + '~' + hi + ' 的数，收到：' + JSON.stringify(v));
  }
  return n;
}

/**
 * 解出网格（列 × 行）。**高层意图优先**：给两个格数就用；只给一个就按原图宽高比推另一个；
 * 只给 `maxSide` 就按长边等比；都没给就用 `DEFAULT_MAX_SIDE`（**如实标 `default`**，不假装是你给的）。
 *
 * @param {{cols?: any, rows?: any, maxSide?: any}} args
 * @param {number} imgW 原图像素宽
 * @param {number} imgH 原图像素高
 * @returns {{cols: number, rows: number, gridFrom: 'arg'|'aspect'|'maxSide'|'default'}}
 */
export function resolveGrid(args, imgW, imgH) {
  const w = Number(imgW) > 0 ? Number(imgW) : 1;
  const h = Number(imgH) > 0 ? Number(imgH) : 1;
  const hasCols = args.cols !== undefined && args.cols !== null && args.cols !== '';
  const hasRows = args.rows !== undefined && args.rows !== null && args.rows !== '';
  const hasMax = args.maxSide !== undefined && args.maxSide !== null && args.maxSide !== '';

  if (hasCols && hasRows) {
    return {
      cols: requireInt(args.cols, 'cols', 1, GRID_MAX),
      rows: requireInt(args.rows, 'rows', 1, GRID_MAX),
      gridFrom: 'arg',
    };
  }
  if (hasCols) {
    const cols = requireInt(args.cols, 'cols', 1, GRID_MAX);
    const rows = clampInt((cols * h) / w, 1, GRID_MAX);
    return { cols, rows, gridFrom: 'aspect' };
  }
  if (hasRows) {
    const rows = requireInt(args.rows, 'rows', 1, GRID_MAX);
    const cols = clampInt((rows * w) / h, 1, GRID_MAX);
    return { cols, rows, gridFrom: 'aspect' };
  }
  const side = hasMax ? requireInt(args.maxSide, 'maxSide', 1, GRID_MAX) : DEFAULT_MAX_SIDE;
  if (w >= h) return { cols: side, rows: clampInt((side * h) / w, 1, GRID_MAX), gridFrom: hasMax ? 'maxSide' : 'default' };
  return { cols: clampInt((side * w) / h, 1, GRID_MAX), rows: side, gridFrom: hasMax ? 'maxSide' : 'default' };
}

/** 本模块的**刻意偏差**清单（进回执 `deviations[]`，别让调用方以为全是"照抄"。） */
export function deviationsOf(usedPixelSize) {
  return [
    { what: '默认 pixelSize=' + DEFAULT_PIXEL_SIZE, why: '源码缺省 1（整幅画只有几十像素宽，看不见）；本仓 UI 栅格也是 8 的倍数',
      used: usedPixelSize === DEFAULT_PIXEL_SIZE },
    { what: 'use4bit 同时量化 Color.FromRGBA 的入参', why: '源码里它只影响富文本；不量化的话 output:"lua" 下这个开关是空转', used: null },
    { what: 'alpha 固定 8 位', why: '源码默认 isUseAlpha=true，但没有开关暴露出来', used: null },
    { what: 'mergeRuns:false（一格一块）是本仓新增开关', why: '源码恒做行程 + 跨行合并', used: null },
  ];
}
