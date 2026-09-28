// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/TextGradient/utils/math.ts
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
// 用途：让「颜色帧序列」与「字号帧序列」的长度对齐，求一个可循环的公共周期（`frameCount`）。

/**
 * 最大公约数（欧几里得）。与源码逐字一致：`b === 0 ? a : gcd(b, a % b)`。
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 最小公倍数。与源码逐字一致：`|a*b| / gcd(a,b)`，结果 NaN 时回 0。
 *
 * ⚠️ `a` 或 `b` 为 0 时 `0/gcd` 或 `0/0` 会得到 `0` / `NaN` —— 源码靠 `Number.isNaN` 兜底，
 * 这里保留同一行为（`lcm(0, 7) === 0`）。TextGradient 的「帧数」正是这样在**文本为空**时退化成 0 的。
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function lcm(a, b) {
  const result = Math.abs(a * b) / gcd(a, b);
  return Number.isNaN(result) ? 0 : result;
}
