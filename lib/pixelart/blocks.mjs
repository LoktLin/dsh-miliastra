// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （这一层对应源码的 `mergePixels`：**行内行程 + 跨行同色同宽合并**成矩形块 ——
//     不是"一个像素一个控件"，这正是它比朴素做法的价值所在。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 合并判据**逐字照抄**：key = `${x}:${width}:${color.join(':')}` ——
//   只有**位置与宽度都完全相同**的行程才向上长高。少一个字段就会把"错位的同色块"粘起来，
//   画出来是错的（所以 `tests/pixelart-test.mjs` 拿具体数字钉住它）。
// ★ 透明（`a === 0`）**不生成块**（源码就是 `if (color[3] > 0)`）——
//   千星没有"透明图片控件"，留一个 a=0 的块等于白建一个控件。
// ★ `mergeRuns:false` 是本仓新增（源代码恒合并）：走 `flatBlocks`，一格一个块。

import { sameColor } from './model.mjs';

/**
 * 一个矩形块。坐标是**格坐标、左上原点**；`w`/`h` 是格数（不是像素）。
 * @typedef {{x: number, y: number, w: number, h: number, color: number[]}} PixelBlock
 */

/**
 * 逐行做行程合并，再把「同 x / 同 w / 同色」的行程向上长高 —— **逐字移植** `mergePixels`。
 *
 * @param {number[][][]} grid `grid[y][x] = [r,g,b,a]`
 * @returns {PixelBlock[]}
 */
export function mergeBlocks(grid) {
  /** @type {PixelBlock[]} */
  const blocks = [];
  /** @type {Map<string, PixelBlock>} */
  let previousRuns = new Map();

  grid.forEach((row, y) => {
    /** @type {Map<string, PixelBlock>} */
    const currentRuns = new Map();
    let x = 0;
    while (x < row.length) {
      const color = row[x];
      let width = 1;
      while (x + width < row.length && sameColor(row[x + width], color)) width += 1;
      if (color[3] > 0) {
        const key = x + ':' + width + ':' + color.join(':');
        const previous = previousRuns.get(key);
        if (previous) {
          previous.h += 1;
          currentRuns.set(key, previous);
        } else {
          const block = { x, y, w: width, h: 1, color };
          blocks.push(block);
          currentRuns.set(key, block);
        }
      }
      x += width;
    }
    previousRuns = currentRuns;
  });

  return blocks;
}

/**
 * 一格一个块（不合并）—— 本仓新增的 `mergeRuns:false` 走这条。
 * @param {number[][][]} grid
 * @returns {PixelBlock[]}
 */
export function flatBlocks(grid) {
  /** @type {PixelBlock[]} */
  const out = [];
  grid.forEach((row, y) => {
    row.forEach((color, x) => {
      if (color[3] > 0) out.push({ x, y, w: 1, h: 1, color });
    });
  });
  return out;
}

/** 按开关选合并策略。 */
export function buildBlocks(grid, { mergeRuns = true } = {}) {
  return mergeRuns ? mergeBlocks(grid) : flatBlocks(grid);
}

/**
 * 只报数字：块数 / 最长边块 / 透明格数 / 颜色种数。**不下判决**。
 * @param {PixelBlock[]} blocks
 * @param {{cols: number, rows: number}} gridSize
 * @param {number} transparentCells
 */
export function blockStats(blocks, gridSize, transparentCells) {
  let widest = 0;
  let tallest = 0;
  const colors = new Set();
  for (const b of blocks) {
    if (b.w > widest) widest = b.w;
    if (b.h > tallest) tallest = b.h;
    colors.add(b.color.join(','));
  }
  return {
    blocks: blocks.length,
    grid: { cols: gridSize.cols, rows: gridSize.rows },
    cells: gridSize.cols * gridSize.rows,
    widestBlock: widest,
    tallestBlock: tallest,
    transparentCells,
    distinctColors: colors.size,
    // 块数 / 格数：合并省下了多少（透明格不算进分母，它们本来就不建块）
    mergeRatio: gridSize.cols * gridSize.rows - transparentCells > 0
      ? Number((1 - blocks.length / (gridSize.cols * gridSize.rows - transparentCells)).toFixed(4))
      : 0,
  };
}

/** 数一下有多少格是全透明的（a === 0）—— 它们不会变成块。 */
export function countTransparentCells(grid) {
  let n = 0;
  for (const row of grid) {
    for (const px of row) if (px[3] === 0) n += 1;
  }
  return n;
}
