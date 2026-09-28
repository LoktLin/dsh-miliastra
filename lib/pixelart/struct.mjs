// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （这一层对应源码里 `drawToPixelCanvas` 的富文本拼装 + `processColorTags` + `chunkStrings`，
//     以及 `downloadJson` 的 `{structId, type:"Struct", value:[{param_type:"StringList", …}]}` 形态。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 与源码的一处**结构性重写**（行为一致、结果同串）：源码是「边扫像素边拼字符串、到行尾/到
//   `maxPixelWidth` 再切断」，本文件改成「先把一行压成同色行程，再按同一组上限切段」。
//   为什么值得改：① 同一段逻辑要同时服务 `maxPixelWidth` 与**单条 ≤500 字符**（千星的硬规则）
//   两个上限，逐字符拼装做不了"按段裁"；② 行程形态在测试里能直接断言（不用去数 `█` 的个数）。
//   ⚠️ 判据逐字照抄：**按 hex 串比较**（不是按原始 RGBA）—— 4bit 下不同 RGBA 会塌成同一个 hex，
//      源码里它们就是同一段，这里必须一样。
// ★ 透明段：源码用 `processColorTags` 把 `<color=#…00>███</color>` 换成一串**全角空格** `　`
//   （默认 `isUseSpace=true`），本文件直接产出替换后的形态。

import { rgbaToHex } from './model.mjs';
import { TEXT_LIMIT } from '../structvar/model.mjs';

/** 全角空格：源码用它代替透明块（`isUseSpace` 默认开）。 */
export const TRANSPARENT_FILL = '\u3000';
/** 一个可见段的外壳长度：`<color=#RRGGBBAA>`（17）+ `</color>`（8）。 */
const WRAP_CHARS = 25;

/**
 * 一行 → 同色行程（按 **hex 串** 比较，与源码一致）。
 * @param {number[][]} row
 * @param {boolean} use4bit
 * @returns {Array<{hex: string, count: number, transparent: boolean}>}
 */
export function rowRuns(row, use4bit) {
  /** @type {Array<{hex: string, count: number, transparent: boolean}>} */
  const runs = [];
  let lastHex = '';
  for (const px of row) {
    const hex = rgbaToHex(px[0], px[1], px[2], px[3], use4bit);
    if (hex === lastHex && runs.length) {
      runs[runs.length - 1].count += 1;
    } else {
      // 源码判据：`Number(alpha.toUpperCase()) === 0`（"FF" → NaN ≠ 0，"00" → 0）
      const digits = use4bit ? hex.slice(hex.length - 1) : hex.slice(hex.length - 2);
      runs.push({ hex, count: 1, transparent: Number(digits) === 0 });
      lastHex = hex;
    }
  }
  return runs;
}

/** 一段行程的富文本形态（透明段直接给全角空格 —— 源码 `processColorTags` 的结果）。 */
function runText(run, count) {
  if (run.transparent) return TRANSPARENT_FILL.repeat(count);
  return '<color=' + run.hex + '>' + '\u2588'.repeat(count) + '</color>';
}

/** 一段行程占多少个字符（不实际拼串，省内存）。 */
function runTextLen(run, count) {
  return run.transparent ? count : WRAP_CHARS + count;
}

/**
 * 一行的富文本，按**两个上限**切成若干段（源码只有 `maxPixelWidth` 这一个上限；
 * 这里加上千星的「单条 ≤ 500 字符」硬规则 —— 否则导不进去）。
 *
 * @param {number[][]} row
 * @param {{use4bit: boolean, maxPixelWidth: number, charLimit?: number}} opts
 * @returns {string[]} 该行的各段（拼起来 = 该行的完整富文本）
 */
export function rowParts(row, opts) {
  const use4bit = opts.use4bit === true;
  const maxBlocks = Math.max(1, Number(opts.maxPixelWidth) || 1);
  const charLimit = Math.max(WRAP_CHARS + 1, Number(opts.charLimit) || TEXT_LIMIT);
  /** @type {string[]} */
  const parts = [];
  let buf = '';
  let blocks = 0;

  const flush = () => {
    if (blocks > 0) parts.push(buf);
    buf = '';
    blocks = 0;
  };

  for (const run of rowRuns(row, use4bit)) {
    let left = run.count;
    while (left > 0) {
      // 一段里再塞 n 个块要花的字符：可见段 = 25 + n，透明段 = n
      const fixed = run.transparent ? 0 : WRAP_CHARS;
      const roomChars = charLimit - buf.length - fixed;
      const canBlocks = Math.min(left, maxBlocks - blocks, roomChars);
      if (canBlocks <= 0) {
        if (blocks === 0) {
          // 「一段一个块都放不下」不该发生（charLimit 至少 WRAP_CHARS+1）—— 真发生了也**不静默丢**：
          // 强制一段一块，宁可多几段，也不能把像素吃掉
          buf = runText(run, 1);
          blocks = 1;
          left -= 1;
          flush();
          continue;
        }
        flush();
        continue;
      }
      buf += runText(run, canBlocks);
      blocks += canBlocks;
      left -= canBlocks;
      if (blocks >= maxBlocks) flush();
    }
  }
  flush();
  return parts.length ? parts : [''];
}

/**
 * 全图 → 千星结构体 JSON。形态**逐字照抄**源码 `downloadJson`：
 * `{structId, type:"Struct", value:[{param_type:"StringList", value: parts.flat()}]}`。
 *
 * @param {number[][][]} grid
 * @param {{structId: string, use4bit: boolean, maxPixelWidth: number}} opts
 * @returns {{struct: any, parts: string[], rows: number, maxLineChars: number, charLimit: number}}
 */
export function buildPixelStruct(grid, opts) {
  const use4bit = opts.use4bit === true;
  /** @type {string[]} */
  const parts = [];
  let maxLineChars = 0;
  // ⚠️ `string.length` 是 UTF-16 码元数，而千星那句"≤500 字符"我们按源码的 `value.length` 口径算
  //    （与 structvar 一致）。全角空格与 `█` 都在 BMP 内 ⇒ 码元数 = 字符数。
  for (const row of grid) {
    for (const s of rowParts(row, { use4bit, maxPixelWidth: opts.maxPixelWidth })) {
      parts.push(s);
      if (s.length > maxLineChars) maxLineChars = s.length;
    }
  }
  return {
    struct: {
      structId: String(opts.structId),
      type: 'Struct',
      value: [{ param_type: 'StringList', value: parts }],
    },
    parts,
    rows: grid.length,
    maxLineChars,
    charLimit: TEXT_LIMIT,
  };
}
