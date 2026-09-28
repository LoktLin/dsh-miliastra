/**
 * search.mjs — 音效库的**离线模糊搜索**：给「要配声音的 AI」一个「说人话 → 拿 id」的入口。
 *
 * 数据来自同目录的 `catalog.json`（1997 条，由 `tools/build-sound-catalog.mjs` 生成；
 * 它是**第三方镜像的离线快照**，运行时**不联网**）。本模块只读快照、不写任何文件。
 *
 * ## 为什么这么设计
 *
 * · **给 AI 的接口不是 SQL 而是「相关性排序」**：作者的原话是「拓扑一下 id+名称，给要配声音的 AI 做接口返回」——
 *   AI 手里只有玩法文本里的词（"开宝箱""命中""风声"），它要的是**最像的几个候选**，不是全表。
 *   所以回执带 `score` / `matchKind` / `lang`：AI 能看出「这条是精确名字命中」还是「这条只是编辑距离凑上来的」。
 * · **五档匹配**（`MATCH_KINDS`）：`exact` > `prefix` > `substring` > `subsequence` > `editDistance`，
 *   先按**档位**排、档内再按 `score` —— 档位是"有多可信"，score 只是"同样是子串谁更像"。
 * · ⛔ **不做拼音 / 不做首字母缩写**：本机**没有**拼音词表（拼一套错的词表比不做更糟：
 *   AI 会拿到"看起来命中了"的错音效）。所以「宝箱」能搜到「物件_宝箱_开启」，`bx`/`baoxiang` 搜不到 ——
 *   文档与回执的 `hint` 都明写这条，免得 AI 在死路上多试几轮。
 *   ⚠️ 但**第 4/5 档（子序列 / 编辑距离）天生宽松**：`bx` 这种两字母查询会"凑"出一批结果
 *   （实测 247 条，`matchKind:subsequence`）。这不是拼音命中，所以回执对这类情况给
 *   **`weak:true` + `hint`**：AI 看到最弱档就能判"这批是凑的，别当依据"。
 * · **归一化口径**：小写 + 全角转半角 + 丢掉**除 `[a-z0-9]` 与 CJK 之外的一切**（空格 / `_` / `-` / `/` / 标点）。
 *   于是 `"环境_震动"`、`"环境 震动"`、`"环境震动"` 归一化后是同一个东西，
 *   而名字里的 `_` 与查询里的空格**不会**造成"明明看着一样却搜不到"。
 *
 * ## score 公式（全整数，可复现；细则见 `docs/千星奇域_音效库拓扑_2026-09-28.md` §5）
 *
 * ```
 * 单词某侧命中： tokenScore = KIND_BASE[kind] + round(60 * tokenLen / nameLen) - min(20, 命中下标) - 25*距离
 *               KIND_BASE = { exact:1000, prefix:800, substring:600, subsequence:400, editDistance:200 }
 * 整条：        score = Σ(每个关键词取其**两侧里更高的那一份** tokenScore)
 * 整条 matchKind = 各关键词命中的**最弱**那一档（AND 语义：有一个词只靠编辑距离凑上，整条就只配这一档）
 * ```
 *
 * 纪律：**回执只报事实**（`total` / `truncated` / `matchKind` / `lang`），不替作者判"该用哪条"。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 默认返回条数（`limit` 省略时）。 */
export const DEFAULT_LIMIT = 20;

/** 返回条数上限（`limit` 夹紧在这里）。 */
export const MAX_LIMIT = 100;

/** 五档匹配，**顺序即优先级**（越靠前越可信）。回执里的 `matchKind` 取自这里。 */
export const MATCH_KINDS = Object.freeze(['exact', 'prefix', 'substring', 'subsequence', 'editDistance']);

/** 档位基础分（`score` 公式的一部分；唯一真身，改这里就是改排序）。 */
const KIND_BASE = Object.freeze({ exact: 1000, prefix: 800, substring: 600, subsequence: 400, editDistance: 200 });

/** 档位 → 排序名次。 */
const KIND_RANK = new Map(MATCH_KINDS.map((k, i) => [k, i]));

/**
 * 查询词允许的编辑距离阈值（**中文按字符算**，JS 里 CJK 在 BMP 内 = 1 个 code unit）。
 * 1~3 个字只容 1 个错（"命重"→"命中"），更长容 2 个。阈值越大越容易把无关音效排进来，所以不放大。
 * @param {number} tokenLen 查询词长度（归一化后）
 */
export function maxEditDistance(tokenLen) {
  return tokenLen <= 3 ? 1 : 2;
}

/**
 * 归一化：小写 → 全角转半角 → 只留 `[a-z0-9]` 与 CJK（U+4E00–U+9FFF）。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeText(input) {
  let s = String(input === undefined || input === null ? '' : input).toLowerCase();
  // 全角 ASCII（！-～ U+FF01–FF5E）→ 半角；表意空格 U+3000 → 普通空格
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
  return s.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * 查询 → 关键词数组（空白切分、逐个归一化、去重）。**多关键词是 AND 语义**。
 * 全是标点 / 空白时**报错**（不静默返回全表）。
 * @param {unknown} q
 * @returns {string[]}
 */
export function tokenizeQuery(q) {
  const tokens = [];
  for (const part of String(q === undefined || q === null ? '' : q).split(/\s+/)) {
    const t = normalizeText(part);
    if (t) tokens.push(t);
  }
  const uniq = [...new Set(tokens)];
  if (!uniq.length) {
    throw new Error('q 给不出有效关键词（空 / 全是标点或空格）—— 给我一个词，'
      + '例如 "攻击" / "attack" / "环境 风声"。⚠️ 本工具**不支持拼音/首字母**（没有词表）。');
  }
  return uniq;
}

/** 编辑距离（Levenshtein，标准 DP 两行滚动）。 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** 子序列命中（按顺序但不要求相邻），返回首次命中的下标。 */
function subsequenceIdx(token, norm) {
  let i = 0;
  let first = -1;
  for (let j = 0; j < norm.length && i < token.length; j += 1) {
    if (norm[j] === token[i]) {
      if (first < 0) first = j;
      i += 1;
    }
  }
  return i === token.length ? first : -1;
}

/**
 * 编辑距离档（第 5 档）：**锚定首字符**的近似匹配。
 *
 * 为什么不滑全窗：不锚定的话，任何 2 字查询与名字里**任意** 2~3 字窗口的距离都可能 ≤1
 * ⇒ 全表命中（实测 "龙" 这种名字里根本没有的字也会命中一片）—— 那一档就退化成噪声。
 * 锚定 `token[0]` 之后：`宝相`→`宝箱`、`命重`→`命中`、`环镜`→`环境_震动` 都能兜住，
 * 而"任何一个字顺眼就命中"被挡掉。**代价**：首字就写错的查询这一档不兜底（文档 §5 明写）。
 *
 * 三条**刻意的收窄**（都是为了不把这一档变成噪声，每条都有实测数字，见文档 §5）：
 *   ① 单字查询不走这一档（子串/子序列已经回答了它）；
 *   ② **2 字拉丁词**（`bx` 这种"首字母缩写"）不走这一档 —— 否则 `b?` 在英文名里遍地都是，
 *      实测命中率会从 247 条涨到 1646 条（82% 全表）。这种查询只在子序列档回答，回执会标 `weak:true`；
 *   ③ 2 字中文词只比**等长**窗口（一个字写错的兜底），不放开到 ±1 字。
 *
 * 性能：每个名字最多扫 4 个锚点、每点最多 5 个窗长 —— 全表 1997×2 侧仍是毫秒级。
 * @returns {{dist: number, idx: number}|null}
 */
function fuzzyHit(token, norm) {
  const len = norm.length;
  const maxDist = maxEditDistance(token.length);
  if (token.length < 2) return null;                                        // 收窄 ①
  // (a) 全名近似（查询与整个名字长度相当）
  if (Math.abs(len - token.length) <= maxDist) {
    const d = levenshtein(token, norm);
    if (d <= maxDist) return { dist: d, idx: 0 };
  }
  // (b) 锚定首字符的滑窗（查询明显短于名字时唯一有用的一路）
  const isCjk = /[\u4e00-\u9fff]/.test(token);
  if (token.length === 2 && !isCjk) return null;                            // 收窄 ②
  if (token.length > 8) return null;
  const lo = token.length === 2 ? 2 : Math.max(2, token.length - maxDist);
  const hi = token.length === 2 ? 2 : token.length + maxDist;               // 收窄 ③
  let anchors = 0;
  for (let i = 0; i < len && anchors < 4; i += 1) {
    if (norm[i] !== token[0]) continue;
    anchors += 1;
    const tail = norm.slice(i, i + hi);
    for (let l = lo; l <= hi; l += 1) {
      if (l > tail.length) continue;
      const d = levenshtein(token, tail.slice(0, l));
      if (d <= maxDist) return { dist: d, idx: i };
    }
  }
  return null;
}

/**
 * 单关键词 vs 单个（**已归一化**）名字 → 最好的一档命中；没命中给 `null`。
 * @returns {{kind: string, idx: number, len: number, dist: number}|null}
 */
function matchNormalized(token, norm) {
  if (!token || !norm) return null;   // 空 token 会让 `startsWith('')` 恒真 —— 这里挡住
  const len = norm.length;
  if (norm === token) return { kind: 'exact', idx: 0, len, dist: 0 };
  if (norm.startsWith(token)) return { kind: 'prefix', idx: 0, len, dist: 0 };
  const idx = norm.indexOf(token);
  if (idx >= 0) return { kind: 'substring', idx, len, dist: 0 };
  const sub = subsequenceIdx(token, norm);
  if (sub >= 0) return { kind: 'subsequence', idx: sub, len, dist: 0 };
  const fuzzy = fuzzyHit(token, norm);
  if (fuzzy) return { kind: 'editDistance', idx: fuzzy.idx, len, dist: fuzzy.dist };
  return null;
}

/**
 * 单关键词 vs 一个名字 —— **两边都吃原文**（内部各自归一化），测试与调试直接吃它。
 * @param {string} token 关键词原文（`环境_震动` / `Environment` 都行）
 * @param {string} rawName 名字原文（`环境_震动` / `Environment_Vibration`）
 */
export function matchOne(token, rawName) {
  return matchNormalized(normalizeText(token), normalizeText(rawName));
}

/** 单词得分（整数）。 */
function tokenScore(hit, tokenLen) {
  const coverage = Math.round((60 * tokenLen) / Math.max(1, hit.len));
  const posPenalty = Math.min(20, Math.max(0, hit.idx));
  const distPenalty = hit.kind === 'editDistance' ? 25 * hit.dist : 0;
  return KIND_BASE[/** @type {keyof typeof KIND_BASE} */ (hit.kind)] + coverage - posPenalty - distPenalty;
}

/**
 * 归一化名字缓存（`WeakMap<catalog, entries>`）—— 一次搜索要过 2×1997 个名字，
 * 每次都跑正则归一化纯属浪费；缓存在**快照对象**上，快照换了自然失效。
 */
const normCache = new WeakMap();

/** @param {any} catalog */
function normalizedIndex(catalog) {
  const hit = normCache.get(catalog);
  if (hit) return hit;
  const entries = catalog.sounds.map((/** @type {any} */ s) => ({
    sound: s,
    zh: normalizeText(s.nameZh),
    en: normalizeText(s.nameEn),
  }));
  normCache.set(catalog, entries);
  return entries;
}

/**
 * **纯函数**：在快照上排序候选（不切 `limit`、不读盘）。测试用自造的小快照直接喂它。
 *
 * @param {any} catalog 形如 `{ sounds: [{id, nameZh, nameEn, category, durationMs}], categories: [] }`
 * @param {{tokens: string[], category?: number|null}} opts `tokens` **原文就行**（内部幂等归一化）；多词 = AND
 * @returns {Array<{id: string, name: string, nameEn: string|null, category: number, durationMs: number,
 *                  score: number, matchKind: string, lang: 'zh'|'en'|'both'}>}
 */
export function rankSounds(catalog, { tokens, category = null } = /** @type {any} */ ({})) {
  if (!catalog || !Array.isArray(catalog.sounds)) throw new Error('rankSounds：catalog.sounds 不是数组');
  if (!Array.isArray(tokens) || !tokens.length) throw new Error('rankSounds：tokens 不能为空');
  // 关键词再归一化一遍（幂等）：调用方直接喂原文也不会错，不必先自己 tokenize
  const toks = [...new Set(tokens.map((/** @type {any} */ t) => normalizeText(t)).filter(Boolean))];
  if (!toks.length) throw new Error('rankSounds：tokens 归一化后为空（全是空格/标点？）');
  const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
  const catName = new Map(cats.map((/** @type {any} */ c) => [Number(c.id), c.nameZh]));
  const out = [];
  for (const entry of normalizedIndex(catalog)) {
    const s = entry.sound;
    if (category !== null && Number(s.category) !== Number(category)) continue;
    let score = 0;
    let weakest = -1;
    /** @type {Set<'zh'|'en'>} */
    const sides = new Set();
    let allHit = true;
    for (const t of toks) {
      const zhHit = entry.zh ? matchNormalized(t, entry.zh) : null;
      const enHit = entry.en ? matchNormalized(t, entry.en) : null;
      if (!zhHit && !enHit) { allHit = false; break; }
      const zhScore = zhHit ? tokenScore(zhHit, t.length) : -Infinity;
      const enScore = enHit ? tokenScore(enHit, t.length) : -Infinity;
      const best = zhScore >= enScore ? zhHit : enHit;
      if (zhHit) sides.add('zh');
      if (enHit) sides.add('en');
      score += tokenScore(/** @type {any} */ (best), t.length);
      const rank = KIND_RANK.get(/** @type {any} */ (best).kind) ?? MATCH_KINDS.length;
      if (rank > weakest) weakest = rank;
    }
    if (!allHit) continue;
    out.push({
      id: String(s.id),
      name: s.nameZh ?? s.nameEn ?? String(s.id),
      nameEn: s.nameEn ?? null,
      category: Number(s.category),
      categoryName: catName.get(Number(s.category)) ?? null,
      durationMs: Number(s.durationMs),
      score,
      matchKind: MATCH_KINDS[weakest] ?? 'editDistance',
      lang: sides.size === 2 ? 'both' : (sides.has('en') ? 'en' : 'zh'),
    });
  }
  out.sort((a, b) => ((KIND_RANK.get(a.matchKind) ?? 99) - (KIND_RANK.get(b.matchKind) ?? 99))
    || (b.score - a.score)
    || (String(a.name).length - String(b.name).length)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** 快照文件路径（`lib/sounds/catalog.json`）。 */
function catalogPath() {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

let cachedCatalog = null;

/**
 * 读快照（**只读、进程内缓存一次**）。读不到 / 坏了都报错并点名路径与重建命令（不静默给空表）。
 * @returns {any}
 */
export function loadSoundCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const p = catalogPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error('读不到音效快照：' + p + '（' + ((e && e.message) || e) + '）'
      + ' —— 用 `node tools/build-sound-catalog.mjs` 重新生成');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('音效快照不是合法 JSON：' + p + '（' + ((e && e.message) || e) + '）');
  }
  if (!obj || !Array.isArray(obj.sounds) || !Array.isArray(obj.categories)) {
    throw new Error('音效快照结构不对（缺 sounds / categories）：' + p);
  }
  cachedCatalog = obj;
  return obj;
}

/** `category` 参数归一化：省略 → `null`；给错就**报错并列出合法值**（不默认全表）。 */
function normalizeCategory(value, catalog) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  const ids = catalog.categories.map((/** @type {any} */ c) => Number(c.id));
  if (!Number.isFinite(n) || !ids.includes(n)) {
    throw new Error('category 只能是这些分类 id 之一：' + ids.join(' / ')
      + '（收到 ' + JSON.stringify(value) + '）—— 名称对照见回执的 categories / 文档 §3');
  }
  return n;
}

/** `limit` 参数归一化：省略 → 默认；非数字 → 报错；数字 → 夹到 `[1, MAX_LIMIT]`。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return { limit: DEFAULT_LIMIT, clamped: false };
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('limit 只能是数字（收到 ' + JSON.stringify(value) + '），默认 ' + DEFAULT_LIMIT + '，上限 ' + MAX_LIMIT);
  const floored = Math.floor(n);
  const limit = Math.min(MAX_LIMIT, Math.max(1, floored));
  return { limit, clamped: limit !== floored };
}

/**
 * `op=sound-search` 的回执构造器（**接线方直接调它**，参数就是工具参数）。
 *
 * @param {{q?: string, category?: number|string, limit?: number, summaryOnly?: boolean}} args
 * @returns {any} `{ok, op, q, tokens, category, total, truncated, limit, limitClamped, items?, itemsOmitted?, categories, catalog, hint?}`
 */
export function searchSounds(args = {}) {
  const q = args.q === undefined || args.q === null ? '' : String(args.q);
  const tokens = tokenizeQuery(q);
  const catalog = loadSoundCatalog();
  const category = normalizeCategory(args.category, catalog);
  const { limit, clamped } = normalizeLimit(args.limit);
  const ranked = rankSounds(catalog, { tokens, category });
  const total = ranked.length;
  const shown = ranked.slice(0, limit);
  /** 回执里**只给 AI 要的字段**（内部的 `categoryName` 不重复给：分类表在 `categories` 里）。 */
  const items = shown.map((r) => ({
    id: r.id,
    name: r.name,
    nameEn: r.nameEn,
    category: r.category,
    durationMs: r.durationMs,
    score: r.score,
    matchKind: r.matchKind,
    lang: r.lang,
  }));
  /** @type {any} */
  const receipt = {
    ok: true,
    op: 'sound-search',
    q,
    tokens,
    category,
    total,
    truncated: total > items.length,
    limit,
    limitClamped: clamped,
  };
  if (args.summaryOnly === true) receipt.itemsOmitted = items.length;
  else receipt.items = items;
  /**
   * 最弱档如果已经是 `subsequence` / `editDistance`，这批结果**全是"凑"出来的** ——
   * 明确挂一个 `weak:true`：AI 不用自己去读档位表也知道"这些不是名字命中"。
   */
  const topKind = items.length ? items[0].matchKind : null;
  receipt.weak = Boolean(topKind && (KIND_RANK.get(topKind) ?? 99) >= (KIND_RANK.get('subsequence') ?? 3));
  receipt.categories = catalog.categories.map((/** @type {any} */ c) => ({ id: c.id, name: c.nameZh, count: c.count }));
  receipt.catalog = {
    version: catalog.version,
    soundCount: catalog.soundCount,
    generatedAt: catalog.generatedAt,
    durationUnit: catalog.durationUnit,
    mirror: true,
    note: catalog.source && catalog.source.mirrorNote,
  };
  if (total === 0) {
    receipt.hint = '0 命中。⚠️ 本工具**不支持拼音/首字母**（没有词表）—— 别试 "bx"/"baoxiang"，'
      + '改用中文名或英文名里的词（如 "宝箱" / "chest"）；也可以先用 categories 限定分类，或直接用 id 精确取名。';
  } else if (receipt.weak) {
    receipt.hint = '最弱档是 ' + topKind + '：这批是"宽松凑出来"的（子序列/编辑距离），**不算名字命中**。'
      + '⚠️ 本工具**不支持拼音/首字母**。要更实的候选就换一个更完整的词，或加 `category` 限定分类。';
  }
  return receipt;
}

/**
 * `op=sound-get`（可选 op）：按 id 取单条详情。
 * @param {{id?: string|number}} args
 * @returns {any} `{ok, op, id, found, sound?, hint?}`
 */
export function getSound(args = {}) {
  const id = args.id === undefined || args.id === null ? '' : String(args.id).trim();
  if (!id) throw new Error('id 不能为空 —— 给音效 id（5 位数字，如 "40150"；从 op=sound-search 拿）');
  const catalog = loadSoundCatalog();
  const sound = catalog.sounds.find((/** @type {any} */ s) => String(s.id) === id)
    || catalog.sounds.find((/** @type {any} */ s) => String(s.id) === id.padStart(5, '0'));
  if (!sound) {
    return {
      ok: true,
      op: 'sound-get',
      id,
      found: false,
      hint: '没有这个 id。音效 id 是 5 位数字（家族首位 1~5，见文档 §4）；'
        + '不确定就用 op=sound-search 先搜名字。',
    };
  }
  const cat = catalog.categories.find((/** @type {any} */ c) => Number(c.id) === Number(sound.category));
  return {
    ok: true,
    op: 'sound-get',
    id: String(sound.id),
    found: true,
    sound: {
      id: String(sound.id),
      name: sound.nameZh ?? sound.nameEn ?? String(sound.id),
      nameEn: sound.nameEn ?? null,
      category: Number(sound.category),
      categoryName: cat ? cat.nameZh : null,
      durationMs: Number(sound.durationMs),
    },
  };
}
