/**
 * ★★ P2-5（《上下文瘦身设计》2026-10-07）：**图测量** —— 色值统计众数 + 连通块包围盒。
 *
 * 由来：作者本会话**手写了 2 次大脚本**（System.Drawing 逐像素）来回答
 * 「这张参考图的主色是什么」「灰块/饱和块各在哪、多大」。这里固化成**纯函数**（可单测、无 I/O），
 * 像素来源复用 `lib/pixelart/decode.mjs` 的 `sampleGrid()`（`grid[y][x] = [r,g,b,a]`）。
 *
 * ⚠️ 口径全部写清、**不下判决**：只报"众数色是多少 / 占多少 / 几块 / 各块在哪多大"，
 *    "这个配色好不好看"不在这层的职责里。
 */

/**
 * 量化到 `levels` 级/通道（默认 16）后取**众数色**。
 * 代表色取该桶内的**平均值**（比取桶中心更接近真实色）；`ratio` = 该桶像素 / 非全透明像素。
 *
 * @param {number[][]|number[][][]} grid `grid[y][x] = [r,g,b,a]`
 * @param {{levels?: number, alphaMin?: number}} [opts]
 */
export function colorMode(grid, { levels = 16, alphaMin = 8 } = {}) {
  const L = Math.max(2, Math.min(256, Math.round(Number(levels) || 16)));
  const buckets = new Map();
  let total = 0;
  for (const row of grid || []) {
    for (const px of row || []) {
      if (!px) continue;
      const a = px[3] === undefined ? 255 : Number(px[3]);
      if (!Number.isFinite(a) || a < alphaMin) continue;
      const q = (v) => Math.min(L - 1, Math.max(0, Math.floor((Number(v) || 0) * L / 256)));
      const key = q(px[0]) + ',' + q(px[1]) + ',' + q(px[2]);
      let b = buckets.get(key);
      if (!b) { b = { n: 0, r: 0, g: 0, b: 0, key }; buckets.set(key, b); }
      b.n += 1; b.r += Number(px[0]) || 0; b.g += Number(px[1]) || 0; b.b += Number(px[2]) || 0;
      total += 1;
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best || !total) {
    return { hex: null, rgb: null, count: 0, ratio: 0, total: 0, distinctBuckets: buckets.size, levels: L,
      note: '没有非全透明像素（或 grid 为空）⇒ 报不了众数色。' };
  }
  const r = Math.round(best.r / best.n);
  const g = Math.round(best.g / best.n);
  const b2 = Math.round(best.b / best.n);
  const hex = '#' + [r, g, b2].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
  return {
    hex, rgb: [r, g, b2], count: best.n, total, ratio: Number((best.n / total).toFixed(4)),
    distinctBuckets: buckets.size, levels: L, bucket: best.key,
    note: '`ratio` = 该桶像素数 / 非全透明像素数；量化 ' + L + ' 级/通道，代表色取桶内平均。',
  };
}

/**
 * **4 连通块**：按饱和度分「灰块 / 饱和块」（作者手搓脚本用的就是这两类）。
 * 输出每块的**中心 / 包围盒 / 面积**；面积 < `minArea` 的丢弃（噪点）。
 *
 * @param {number[][][]} grid `grid[y][x] = [r,g,b,a]`
 * @param {{minArea?: number, satThreshold?: number, alphaMin?: number}} [opts]
 */
export function blobsFromGrid(grid, { minArea = 2, satThreshold = 40, alphaMin = 8 } = {}) {
  const rows = (grid || []).length;
  const cols = rows ? (grid[0] || []).length : 0;
  const kindOf = (px) => {
    if (!px) return null;
    const a = px[3] === undefined ? 255 : Number(px[3]);
    if (!Number.isFinite(a) || a < alphaMin) return null;
    const r = Number(px[0]) || 0;
    const g = Number(px[1]) || 0;
    const b = Number(px[2]) || 0;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : Math.round(((mx - mn) / mx) * 255);
    return sat >= satThreshold ? 'saturated' : 'gray';
  };
  const seen = new Uint8Array(rows * cols);
  const blobs = [];
  const at = (y, x) => (y * cols) + x;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (seen[at(y, x)]) continue;
      const k0 = kindOf(grid[y] && grid[y][x]);
      if (!k0) { seen[at(y, x)] = 1; continue; }
      const stack = [[y, x]];
      seen[at(y, x)] = 1;
      let n = 0; let minX = x; let maxX = x; let minY = y; let maxY = y;
      while (stack.length) {
        const [cy, cx] = stack.pop();
        n += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const nb = [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]];
        for (const [ny, nx] of nb) {
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
          if (seen[at(ny, nx)]) continue;
          if (kindOf(grid[ny] && grid[ny][nx]) !== k0) { continue; }   // 只沿同类像素扩
          seen[at(ny, nx)] = 1;
          stack.push([ny, nx]);
        }
      }
      if (n < minArea) continue;
      blobs.push({
        kind: k0, area: n,
        x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
        cx: Number((((minX + maxX) / 2)).toFixed(1)), cy: Number((((minY + maxY) / 2)).toFixed(1)),
      });
    }
  }
  blobs.sort((a, b) => b.area - a.area);
  return {
    blobs,
    count: blobs.length,
    byKind: { saturated: blobs.filter((b) => b.kind === 'saturated').length, gray: blobs.filter((b) => b.kind === 'gray').length },
    grid: { cols, rows },
    note: '4 连通 + 同类像素才连（按饱和度分灰块/饱和块，阈值 ' + satThreshold + '）；面积 < ' + minArea + ' 的当噪点丢弃。'
      + '坐标单位 = **采样格**（`cols`×`rows`），不是原图像素 —— 要原图坐标请按 `image.w/cols` 换算。',
  };
}
