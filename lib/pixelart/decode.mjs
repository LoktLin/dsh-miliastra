// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （这一层对应源码的 `drawToPixelCanvas`：**关掉平滑**把原图缩到 cols×rows，再取像素。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 为什么用真 canvas 而不是自己写缩放：源码那句 `ctx.imageSmoothingEnabled = false` 是**语义的一部分**
//   —— 关平滑 = 最近邻取样，"硬像素"才不会糊。Host 侧本来就有 `@napi-rs/canvas`（依赖里就有），
//   用它比手搓一个"双线性但要装作不是"的缩放更诚实。
// ★ `@napi-rs/canvas` 走**动态 import**（照 `lib/sim.mjs` 的 `loadCanvasLib` 写法）：
//   纯函数层（model / blocks / lua / struct）因此可以在不加载原生模块的前提下被单测。

/**
 * 一个像素 = `[r, g, b, a]`（0–255）。
 * @typedef {number[]} PixelColor
 */

let canvasLibPromise = null;

/** 惰性加载 `@napi-rs/canvas`（只加载一次）。 */
function loadCanvasLib() {
  if (!canvasLibPromise) canvasLibPromise = import('@napi-rs/canvas');
  return canvasLibPromise;
}

/**
 * 扁平 RGBA → 二维像素矩阵。**纯函数**（不碰 canvas，单测直接喂合成数据）。
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} data 长度必须是 `cols * rows * 4`
 * @param {number} cols
 * @param {number} rows
 * @returns {PixelColor[][]} `grid[y][x]`
 */
export function gridFromRgba(data, cols, rows) {
  const c = Number(cols);
  const r = Number(rows);
  const need = c * r * 4;
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) {
    throw new Error('gridFromRgba 要一段 RGBA 数组，收到：' + typeof data);
  }
  if (data.length !== need) {
    throw new Error('gridFromRgba 长度对不上：要 ' + need + '（' + c + '×' + r + '×4），收到 ' + data.length);
  }
  const out = [];
  for (let y = 0; y < r; y += 1) {
    const row = [];
    for (let x = 0; x < c; x += 1) {
      const i = (y * c + x) * 4;
      row.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    }
    out.push(row);
  }
  return out;
}

/**
 * 只读原图尺寸（决定 `maxSide` 往哪边算、以及回执里的"原图尺寸"）。
 * @param {Buffer|Uint8Array} buf
 * @returns {Promise<{width: number, height: number}>}
 */
export async function imageInfo(buf) {
  const { loadImage } = await loadCanvasLib();
  const img = await loadImage(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  return { width: Number(img.width), height: Number(img.height) };
}

/**
 * 关平滑降采样成 cols×rows 的像素矩阵 —— **逐字移植**源码 `drawToPixelCanvas` 的三步：
 * `imageSmoothingEnabled = false` → `clearRect` → `drawImage(img, 0, 0, cols, rows)` → `getImageData`。
 *
 * ⚠️ 源码在 `isUseAlpha=false` 时会先铺一层白底；本仓**不暴露这个开关**（alpha 固定保留），
 * 所以这里没有那一步 —— 写在这里免得下一个人以为漏抄了。
 *
 * @param {Buffer|Uint8Array} buf 图片字节（PNG / JPEG / …）
 * @param {number} cols
 * @param {number} rows
 * @returns {Promise<{grid: PixelColor[][], width: number, height: number}>}
 */
export async function sampleGrid(buf, cols, rows) {
  const { createCanvas, loadImage } = await loadCanvasLib();
  const img = await loadImage(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const width = Number(img.width);
  const height = Number(img.height);
  if (!(width > 0) || !(height > 0)) {
    throw new Error('图片尺寸不合法：' + width + '×' + height);
  }
  const cv = createCanvas(Number(cols), Number(rows));
  const ctx = cv.getContext('2d');
  // 禁用平滑，确保「硬像素」（源码原话）
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, Number(cols), Number(rows));
  ctx.drawImage(img, 0, 0, Number(cols), Number(rows));
  const imgData = ctx.getImageData(0, 0, Number(cols), Number(rows));
  return { grid: gridFromRgba(imgData.data, Number(cols), Number(rows)), width, height };
}
