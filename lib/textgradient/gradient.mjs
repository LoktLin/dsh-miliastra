// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/TextGradient/TextGradient.vue
//   （`<script>` 段里的 colorFrames / sizeFrams / frameCount / getCharList，是这一整块的核心算法）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ⛔ 不吸收的部分：Vue 界面、预设卡片的云端拉取（`createOss("TextGradient")`）、账号/存储服务。
// 输出格式：逐帧的**千星富文本行**（每行 ≤ 999 字符的分段规则照源码）。
//   · `<color=#RRGGBB>字</color>` —— **有官方依据**（`docs/官方文档-7.1正式/原文/doc_界面布局.txt`）。
//   · `<size=N>…</size>` 与 4bit 短格式 —— 我核过的 19 份官方 7.1 原文里 **0 命中**
//     （`<color` 命中 1 处，`<size` / `4bit` / `#RGB` 全 0）⇒ **默认关闭，打开时回执标「未经真机验证」**。

import {
  COLOR_STYLES, SIZE_STYLES, FADE_FRAMES, JITTER_PICKS, JITTER_BASE_SIZE,
  mulberry32, randInt, scaleSampler, withAlpha, hex6, hex4, piecewiseSize,
  normalizeConfig, deviationsOf,
} from './model.mjs';
import { lcm } from './math.mjs';

/** 单行字符上限：源码 `getCharList` 里的 `999`（超过就换行，是**输出分段**不是平台限制）。 */
export const LINE_CHAR_LIMIT = 999;

/** 默认最多逐帧输出多少帧（序列可能上百帧；`frames` 不传时的上限，超出的只报数量）。 */
export const DEFAULT_MAX_FRAMES = 60;

/**
 * 颜色帧序列。逐字对应源码 `colorFrames`（含 `frameSpeed = max(1, colorJumpFrames+1)` 与
 * 「来回长序列 + 滑动窗口」这两步）。
 * @param {Record<string, any>} cfg normalizeConfig 的输出
 * @returns {Array<Array<{r: number, g: number, b: number, a: number}>>}
 */
export function buildColorFrames(cfg) {
  const list = [];
  const n = cfg.chars.length;
  if (n === 0) return list;
  const scale = scaleSampler(cfg.colors);
  const frames = [];
  for (let i = 0; i < n; i += 1) {
    let t = i / (n - 1);
    if (Number.isNaN(t)) t = 0;
    frames.push(scale(t));
  }
  const step = Math.max(1, cfg.colorJumpFrames + 1);
  if (cfg.colorStyle === 'flat') { list.push(frames); return list; }
  if (cfg.colorStyle === 'flow-forward' || cfg.colorStyle === 'flow-backward') {
    const loop = [...frames, ...frames.slice(1).reverse(), ...frames.slice(1)];
    if (cfg.colorStyle === 'flow-forward') {
      for (let i = 0; i < n * 2 - 1; i += step) list.push(loop.slice(i, i + n));
    } else {
      for (let i = n * 2 - 2; i > -1; i -= step) list.push(loop.slice(i, i + n));
    }
    return list;
  }
  for (let i = 0; i < FADE_FRAMES; i += step) {
    const k = cfg.colorStyle === 'fade-in' ? i / (FADE_FRAMES - 1) : (FADE_FRAMES - i - 1) / (FADE_FRAMES - 1);
    list.push(frames.map((c) => withAlpha(c, c.a * k)));
  }
  return list;
}

/**
 * 字号帧序列。对应源码 `sizeFrams`。
 * ⚠️ 源码的 `jitter` 分支帧数**跟着颜色帧走**（`i < colorFrames.value.length`）⇒ 必须把颜色帧数传进来。
 * @param {Record<string, any>} cfg
 * @param {number} colorFrameCount
 * @returns {number[][]}
 */
export function buildSizeFrames(cfg, colorFrameCount) {
  const list = [];
  const n = cfg.chars.length;
  if (n === 0) return list;
  if (cfg.sizeStyle === 'flat') {
    const frames = [];
    for (let i = 0; i < n; i += 1) {
      let t = i / (n - 1);
      if (Number.isNaN(t)) t = 0;
      frames.push(piecewiseSize(cfg.sizes, t));
    }
    list.push(frames);
    return list;
  }
  const rand = mulberry32(cfg.seed);
  for (let f = 0; f < colorFrameCount; f += 1) {
    const frame = new Array(n).fill(JITTER_BASE_SIZE);
    for (let k = 0; k < JITTER_PICKS; k += 1) {
      frame[randInt(rand, 0, n - 1)] = randInt(rand, cfg.sizeMin, cfg.sizeMax);
    }
    list.push(frame);
  }
  return list;
}

/**
 * 取第 `frame` 帧的富文本输出（**逐字**对应源码 `getCharList`，含 999 字符换行规则）。
 * @param {Record<string, any>} cfg
 * @param {Array<Array<{r: number, g: number, b: number, a: number}>>} colorFrames
 * @param {number[][]} sizeFrames
 * @param {number} frame
 * @returns {string[]}
 */
export function renderFrame(cfg, colorFrames, sizeFrames, frame) {
  const out = [];
  let line = 0;
  const cf = colorFrames.length ? colorFrames[frame % colorFrames.length] : null;
  const sf = sizeFrames.length ? sizeFrames[frame % sizeFrames.length] : null;
  cfg.chars.forEach((char, index) => {
    if (out.length <= line) out.push('');
    let word = char;
    if (cfg.withColor && cf) {
      const c = cf[index];
      const tag = cfg.use4bit ? hex4(c) : hex6(c);
      word = `<color=${tag}>${char}</color>`;
    }
    if (cfg.withSize && sf) word = `<size=${Math.round(sf[index])}>${word}</size>`;
    if (word.length + out[line].length > LINE_CHAR_LIMIT) { line += 1; out.push(''); }
    out[line] += word;
  });
  return out;
}

/**
 * 一帧里「同一位置的字符有没有变过颜色」—— 用来发现「淡入/淡出在 8bit 下其实是空转」。
 * ⚠️ 必须**按真正的输出格式**算（8bit 走 `hex6` 会丢 alpha；4bit 走 `hex4` 才留得住 alpha）——
 *    第一版无脑用 `hex6`，于是开着 4bit 也报「只有 1 种颜色」，把工具自己的提示说反了。
 */
function distinctColorFrames(colorFrames, use4bit) {
  const seen = new Set();
  const enc = use4bit ? hex4 : hex6;
  for (const f of colorFrames) seen.add(f.map((c) => enc(c)).join('|'));
  return seen.size;
}

/**
 * `op=text-gradient` 的完整回执。**只报数字与结果，不下判决**：
 * 「这个渐变好不好看」「`<size>` 能不能用」都不是工具说的。
 * @param {Record<string, any>} args 工具入参
 * @returns {Record<string, any>}
 */
export function textGradient(args = {}) {
  const norm = normalizeConfig(args);
  if (!norm.ok) return { ok: false, op: 'text-gradient', error: norm.error };
  const cfg = norm.config;
  const colorFrames = buildColorFrames(cfg);
  const sizeFrames = buildSizeFrames(cfg, colorFrames.length);
  const frameCount = lcm(colorFrames.length, sizeFrames.length);
  const requested = Array.isArray(args.frames) && args.frames.length
    ? args.frames.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && (frameCount === 0 || v < frameCount))
    : null;
  const wanted = frameCount === 0 ? [] : (requested || Array.from({ length: Math.min(frameCount, DEFAULT_MAX_FRAMES) }, (_, i) => i));
  const summaryOnly = args.summaryOnly === true;
  const frames = wanted.map((i) => {
    const lines = renderFrame(cfg, colorFrames, sizeFrames, i);
    return {
      index: i,
      lineCount: lines.length,
      charCount: lines.reduce((s, l) => s + l.length, 0),
      lines: summaryOnly ? undefined : lines,
    };
  }).map((f) => (summaryOnly ? { index: f.index, lineCount: f.lineCount, charCount: f.charCount } : f));

  const distinct = distinctColorFrames(colorFrames, cfg.use4bit);
  const unverified = [];
  if (cfg.withSize) unverified.push({ what: 'size 标签', why: '官方 7.1 原文里 `<size` 0 命中（只有 `<color` 有 1 处），未经真机验证', param: 'withSize' });
  if (cfg.use4bit) unverified.push({ what: '4bit 短格式（#RGB/#RGBA）', why: '官方文档只给了 `#FFFFFF` 六位；`4bit`/`#RGB` 在 19 份原文里 0 命中', param: 'use4bit' });

  const notes = [];
  if (frameCount > wanted.length) {
    notes.push(`帧数 ${frameCount} > 本次输出 ${wanted.length} 帧（用 frames:[…] 点名要哪几帧）`);
  }
  if ((cfg.colorStyle === 'fade-in' || cfg.colorStyle === 'fade-out') && !cfg.use4bit) {
    notes.push('淡入/淡出 + 8bit：6 位十六进制**不带 alpha**（源码用 chroma 的 `.hex()` 也是这样）'
      + `⇒ 本序列 ${colorFrames.length} 帧的颜色只有 ${distinct} 种；要看透明度得开 use4bit`);
  }
  if (sizeFrames.length && colorFrames.length && sizeFrames.length !== colorFrames.length && cfg.sizeStyle === 'jitter') {
    notes.push('跳字风格的字号帧数跟着颜色帧数走（源码如此）');
  }
  if (cfg.text === '') notes.push('文本为空 ⇒ 帧数 0（源码同样退化，但我们**不再**产出越界下标）');

  return {
    ok: true,
    op: 'text-gradient',
    charCount: cfg.chars.length,
    frameCount,
    colorFrameCount: colorFrames.length,
    sizeFrameCount: sizeFrames.length,
    distinctColorFrames: distinct,
    tags: { color: cfg.withColor, size: cfg.withSize, format: cfg.use4bit ? '4bit' : '8bit' },
    style: { color: cfg.colorStyle, size: cfg.sizeStyle, colorJumpFrames: cfg.colorJumpFrames, seed: cfg.seed },
    framesOmitted: frameCount > wanted.length ? frameCount - wanted.length : 0,
    frames,
    summaryOnly,
    unverified,
    deviations: deviationsOf(),
    notes,
  };
}

/** 把两个风格清单暴露给工具层（description 里要列出合法值）。 */
export const STYLE_CHOICES = {
  color: COLOR_STYLES.map((s) => s.id),
  size: SIZE_STYLES.map((s) => s.id),
};
