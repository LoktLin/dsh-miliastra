/**
 * metrics.mjs — 从日志里收「指标」并汇总（**只读、纯函数**）
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 为什么需要它（2026-09-23 真机）
 * ───────────────────────────────────────────────────────────────────────────
 * 那一晚真正救命的**不是** 36 条日志的正文，而是作者自己在脚本里加的一行：
 *
 *   [yuan-code] 落出边界 -> 重生（第 3 关，摔死处 x=814，最后站立=#2 移动）
 *
 * 有了它，「卡在哪一段」一目了然；没有它只能猜。而这类「埋点」**每次都要重新发明一遍格式**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 两层，都**不猜语义**
 * ───────────────────────────────────────────────────────────────────────────
 * ① **严格约定**：`[MIL]` 开头 + `k=v` 对。默认字段含义（作者自己填，工具只按名字用）：
 *
 *      [MIL] evt=death lv=3 x=814 stand=2
 *      [MIL] evt=clear lv=3 ms=8420
 *      [MIL] death lv=3 x=814            ← 事件名也可以不带 `evt=`
 *
 *      `evt` = 事件名（没给就从第一个裸词取）  `lv` = 关卡  `x`/`y` = 位置
 *      `ms` = 耗时  `n` = 计数    其它键**原样保留**，工具不去解释它
 *
 *    → 汇总成「每个事件：次数 / 分期分关次数 / 数值字段的分布与**热区**」。
 *
 * ② **宽松抽取**：**任何**日志行里出现 `k=<数字>` 就收（例如上面那行里的 `x=814`），
 *    再配上「第 N 关 / lv=N」这类关卡线索，给出**按数值键**的分布与热区。
 *    → 这条**不需要作者改任何代码**，拿现在的日志就能跑出「x 集中在 700~860」。
 *
 * ⚠️ 硬约束：**没有这个格式就静默忽略，绝不报错、绝不污染日志**。
 *    工具只**读** `.gia`，一个字节都不写。
 *
 * ⚠️ 纪律：热区/分布是**数字事实**，不是判定 —— 不说「这一关有问题」，只说「12 次里有 9 次落在 700~860」。
 */

/** 数值字段的默认直方图分箱数。 */
export const DEFAULT_BINS = 10;

/* --------------------------------------------------------------- 解析 */

const MIL_RE = /^\s*\[MIL\]\s*(.*)$/i;
/** `k=v`：键允许中文（实测日志里有 `最后站立=#2`）；值到空白或中文标点为止。 */
const KV_RE = /([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]{0,23})\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,，;；、）)】\]}]+)/g;
/** 关卡线索：`第 3 关` / `第3关` / `lv=3` / `L3`。 */
const LEVEL_CN_RE = /第\s*(\d+)\s*关/;

const unquote = (v) => {
  const s = String(v);
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
};

/** 值能不能当数字用（`#2` 这种带前缀的不算，免得把 `#2` 当成 2）。 */
function asNumber(raw) {
  const v = unquote(raw).trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 抽一行里的所有 `k=v`（不要求 `[MIL]`）。返回 `{ kv, nums }`。 */
export function extractKv(text) {
  const kv = {};
  const nums = {};
  KV_RE.lastIndex = 0;
  let m;
  while ((m = KV_RE.exec(String(text || ''))) !== null) {
    const key = m[1];
    const raw = m[2];
    if (!(key in kv)) kv[key] = unquote(raw);          // 同一个键出现多次时保留第一个
    const n = asNumber(raw);
    if (n !== null && !(key in nums)) nums[key] = n;
  }
  return { kv, nums };
}

/**
 * 严格约定：`[MIL] …`。不是 `[MIL]` 开头 → 返回 null（**静默忽略**）。
 *
 * 事件名取 `evt=`（也接受 `event=` / `e=`），没有的话取第一个非 `k=v` 的裸词。
 */
export function parseMilLine(message) {
  const m = MIL_RE.exec(String(message == null ? '' : message));
  if (!m) return null;
  const body = m[1];
  const { kv, nums } = extractKv(body);
  let evt = kv.evt || kv.event || kv.e || null;
  if (!evt) {
    // 第一个不是 `k=v` 的裸词当事件名：`[MIL] death lv=3 x=814`
    const bare = body.replace(KV_RE, ' ').trim().split(/\s+/).filter(Boolean)[0];
    if (bare) evt = bare;
  }
  const lvRaw = kv.lv != null ? kv.lv : (() => {
    const g = LEVEL_CN_RE.exec(body);
    return g ? g[1] : null;
  })();
  const lv = lvRaw != null && /^\d+$/.test(String(lvRaw).trim()) ? Number(String(lvRaw).trim()) : null;
  return { kind: 'mil', evt: evt || null, lv, kv, nums };
}

/**
 * 宽松抽取一行：只要里面有 `k=<数字>` 就收；顺带找关卡线索。
 * 没有任何数值 `k=v` 的行**不收**（避免把整段正文当指标）。
 */
export function parseLooseLine(message) {
  const text = String(message == null ? '' : message);
  const { kv, nums } = extractKv(text);
  if (Object.keys(nums).length === 0) return null;
  const tagM = /\[([A-Za-z0-9_\-]{1,24})\]/.exec(text);
  const g = LEVEL_CN_RE.exec(text);
  const lv = kv.lv != null && /^\d+$/.test(String(kv.lv).trim()) ? Number(kv.lv)
    : (g ? Number(g[1]) : null);
  return {
    kind: 'loose',
    tag: tagM ? tagM[1] : '(无标签)',
    lv,
    kv, nums,
    text: text.length > 200 ? text.slice(0, 200) + '…' : text,
  };
}

/**
 * 一批记录 → `{ mil, loose, scanned, ignored }`。
 * `[MIL]` 行**不进** loose（免得同一行被算两次）。
 */
export function collectMetrics(records) {
  const mil = [];
  const loose = [];
  let scanned = 0;
  for (const r of records || []) {
    const msg = r && r.message;
    if (!msg) continue;
    scanned += 1;
    const m = parseMilLine(msg);
    if (m) {
      mil.push({ ...m, index: r.index, instance: r.instance, time: r.time || null });
      continue;
    }
    const l = parseLooseLine(msg);
    if (l) loose.push({ ...l, index: r.index, instance: r.instance, time: r.time || null });
  }
  return { mil, loose, scanned, ignored: scanned - mil.length - loose.length };
}

/* --------------------------------------------------------------- 统计 */

const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 线性插值分位数（`q` 取 0~1）。 */
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * 一组数字的分布 + **热区** + **集中区**。
 *
 * 两个都要，因为它们回答的是不同的问题：
 *   · `hotBin`（直方图命中最多的那一箱）= 「形状长什么样」，**会被离群值摊薄**
 *     （实测：12 个值跨 460~1086、10 个箱子时，最多的箱子只有 3 个 —— 明明 9 个都挤在 700~860 附近）；
 *   · `core`（**四分位距 p25~p75**）= 「中间那一半落在哪」，**抗离群值**
 *     —— 「x 集中在 700~860」这种话，用的是这个。
 *
 * ⚠️ 两者都是**数字事实**，不是「这里有问题」的判定。
 */
export function numericStats(values, { bins = DEFAULT_BINS } = {}) {
  const v = (values || []).filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const binCount = Math.max(1, Math.min(50, Math.round(bins) || DEFAULT_BINS));
  const width = max === min ? 0 : (max - min) / binCount;
  const buckets = [];
  for (let i = 0; i < (width === 0 ? 1 : binCount); i += 1) {
    const from = min + width * i;
    const to = width === 0 ? max : min + width * (i + 1);
    buckets.push({ from, to: Math.round(to * 100) / 100, count: 0 });
  }
  for (const x of v) {
    const idx = width === 0 ? 0 : Math.min(buckets.length - 1, Math.floor((x - min) / width));
    buckets[idx].count += 1;
  }
  const hot = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
  const sorted = v.slice().sort((a, b) => a - b);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const round2 = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);
  return {
    n, min, max,
    mean: round2(mean),
    median: round2(median(v)),
    p25: round2(p25),
    p75: round2(p75),
    core: { from: round2(p25), to: round2(p75), width: round2(p75 - p25) },
    span: max - min,
    bins: buckets,
    hotBin: { from: round2(hot.from), to: round2(hot.to), count: hot.count },
    hotShare: Math.round((hot.count / n) * 1000) / 1000,
    note: '`core` = 中间 50%（四分位距，抗离群值）—— 「集中在哪」看它；'
      + '`hotBin` = 直方图命中最多的那一箱，看形状用，会被离群值摊薄。**两者都是数字事实，不是判定**。',
  };
}

/** 按某个 key 分组（`lv` 为 null 时归到 `'(未标注)'`）。 */
function groupBy(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/**
 * 严格模式的汇总：每个 `evt` 一张卡。
 *   `{ evt, count, byLevel: { '3': {count, nums:{x:stats}} }, nums: { x: stats, ms: stats } }`
 */
export function summarizeMil(events, { bins = DEFAULT_BINS } = {}) {
  const byEvt = groupBy(events || [], (e) => e.evt || '(未命名)');
  const out = [];
  for (const [evt, list] of [...byEvt.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const numKeys = new Set();
    for (const e of list) for (const k of Object.keys(e.nums)) numKeys.add(k);
    const nums = {};
    for (const k of numKeys) {
      const st = numericStats(list.map((e) => e.nums[k]).filter((x) => x !== undefined), { bins });
      if (st) nums[k] = st;
    }
    const lvMap = groupBy(list, (e) => (e.lv == null ? '(未标注)' : String(e.lv)));
    const byLevel = {};
    for (const [lv, ls] of [...lvMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const detail = { count: ls.length };
      // 每个关卡里也给一份数值分布 —— 「第 3 关 12 次，x 集中在 700~860」就是这里出的
      const sub = {};
      for (const k of numKeys) {
        const st = numericStats(ls.map((e) => e.nums[k]).filter((x) => x !== undefined), { bins });
        if (st) sub[k] = st;
      }
      if (Object.keys(sub).length) detail.nums = sub;
      byLevel[lv] = detail;
    }
    out.push({ evt, count: list.length, nums, byLevel });
  }
  return out;
}

/**
 * 宽松模式的汇总：**按键**统计（不假装知道 `x` 是「摔死位置」）。
 *   `{ keys: { x: {…stats, byLevel:{…}} }, tags: {…}, levels: {…} }`
 */
export function summarizeLoose(rows, { bins = DEFAULT_BINS } = {}) {
  const keyMap = new Map();
  for (const r of rows || []) {
    for (const [k, v] of Object.entries(r.nums)) {
      if (!keyMap.has(k)) keyMap.set(k, []);
      keyMap.get(k).push({ v, lv: r.lv, tag: r.tag });
    }
  }
  const keys = {};
  for (const [k, list] of keyMap.entries()) {
    const st = numericStats(list.map((x) => x.v), { bins });
    const lvMap = groupBy(list, (x) => (x.lv == null ? '(未标注)' : String(x.lv)));
    const byLevel = {};
    for (const [lv, ls] of [...lvMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sub = numericStats(ls.map((x) => x.v), { bins });
      if (sub) byLevel[lv] = { n: ls.length, min: sub.min, max: sub.max, median: sub.median, core: sub.core, hotBin: sub.hotBin };
    }
    keys[k] = { ...st, byLevel };
  }
  const tags = {};
  for (const r of rows || []) tags[r.tag] = (tags[r.tag] || 0) + 1;
  const levels = {};
  for (const r of rows || []) {
    const k = r.lv == null ? '(未标注)' : String(r.lv);
    levels[k] = (levels[k] || 0) + 1;
  }
  return { keys, tags, levels };
}

/** 关键事件时间线（按日志顺序，带局号与关卡）。 */
export function metricsTimeline(events, { limit = 40 } = {}) {
  return (events || []).slice(0, Math.max(1, limit)).map((e) => ({
    index: e.index,
    epochSec: e.instance ? (Number(String(e.instance).split('-')[2]) || null) : null,
    lv: e.lv,
    evt: e.evt || null,
    kv: e.kv,
  }));
}

/** 把「怎么用这个约定」写进回执 —— 没采用 `[MIL]` 时也能照着做。 */
export function conventionHint() {
  return {
    how: '在脚本里 print 一行即可（工具只读日志，不要求任何 API）：'
      + ' print("[MIL] evt=death lv=" .. lv .. " x=" .. math.floor(x))',
    keys: {
      evt: '事件名（没给的话取第一个裸词）',
      lv: '关卡号（也认 `第 N 关`）',
      x: '位置 x（y 同理）',
      ms: '耗时毫秒',
      n: '计数',
      '其它键': '原样保留，工具不解释',
    },
    examples: ['[MIL] evt=death lv=3 x=814 stand=2', '[MIL] evt=clear lv=3 ms=8420', '[MIL] death lv=3 x=814'],
    note: '不采用也不影响：工具照样会用**宽松抽取**把日志里现成的 `k=数字` 汇总出来；'
      + '没有这个格式的行一律**静默忽略**，不报错、不影响任何既有功能。',
  };
}
