/**
 * query.mjs — **平台「图片资源库」的离线查询**：给「要选素材的 AI」一个「说分类/颜色档 → 拿 id 清单」的入口。
 *
 * 数据来自同目录的 `catalog.json`（1543 条，由 `tools/build-image-catalog.mjs` 生成；
 * 它是**第三方镜像的离线快照**，运行时**不联网**）。本模块只读快照、不写任何文件、不下载任何图片。
 *
 * ## 这个工具**不做**什么（与 `lib/assets.mjs` 的区别，最容易混）
 *
 * · `lib/assets.mjs`（`op=add/list/get/...`）= **插件自己的素材库**：真存图片字节、按内容寻址。
 * · 本模块（`op=catalog`）= **平台资源库的目录事实**：只有 `id / 分类 / 有没有图 / 颜色档 / 模拟器认不认`，
 *   **一个字节的图都不落盘、也不提供下载**。
 *
 * ## 三条口径（都是事实，不替作者判"该用哪张"）
 *
 * 1. **单张图片没有名字**：镜像目录里只有 `id`/`img`/`border`（1543 条全量核对，无名字字段）
 *    ⇒ 本工具**只给分类名**，绝不编"`100136` = 星星"这种话。要名字只能人去编辑器里看。
 * 2. **`imgExists`**：目录里有 21 条的 `img`/`border` 是空串（实测其 PNG 404）。
 *    拿 id 去 `SetImage` 之前**先看这一列**（`imgExists:false` 的别用）。
 * 3. **`colorKind`**：`mono`（官方名含「单色」）/ `multi`（含「彩色」）是**官方分类名**；
 *    官方名没标的 6 类按抽样实测分 `neutral`（无彩度白图）/ `mixed`（多色）。
 *    抽样只 66 张 ⇒ 回执的 `unverified[]` 里如实写着"样本小、只作旁证"，**工具不判决官方写得对不对**。
 *
 * ## `simRenderable` 是什么
 *
 * = 我们**自己的模拟器**画不画得出来：只有 `IMAGE_PRIMITIVES` 里那 6 个几何号
 * （`100001~100006`，正好 = 分类 8「基础形状」的全部成员）会被画成程序化图元，其余一律画"缺图"标记。
 * ⚠️ 它**不是**"官方素材长什么样"——模拟器不加载 PNG；真机渲染一律 `unknown`（未经真机验证）。
 *
 * ## 回执体积策略（作者 2026-09-28 点名的 AI 侧体验）
 *
 * **发现调用给全表，过滤调用只给结论**：
 *   · **没有收窄条件**（`category` / `id` / `colorKind` / `simOnly` / `imgExists` 全空）= **发现调用**
 *     ⇒ 给**完整 14 行分类表**（AI 才知道有哪些分类可挑）。
 *   · **有收窄条件** = **过滤调用** ⇒ 省掉 14 行分类表，只留**收窄到的那一条**（`category` 字段）
 *     + `categoriesOmitted:14`（让人知道被省了什么）。实测：查一个分类时分类表曾占回执**约一半**。
 *   · `source` 一律只 3 个字段（`mirror` / `origin` / `note`）；**sha256 三连 + `fetchedAt` 只在
 *     `withMeta:true` 时给**（审计哈希才要）。
 *   ⚠️ **只去体积、不去结论**：`counts` / `filters` / `limit` / `limitClamped` / `unverified` / `notes` /
 *   `source.mirror|origin|note` 一个都不少（`unverified` 是对外诚实口径，**永远保留**）。
 *
 * 纪律：**回执只报事实**（`counts` / `imgExists` / `colorKind` / `simRenderable`），不替作者挑素材。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `limit` 省略时的默认条数（1543 条全量灌进上下文没意义）。 */
export const DEFAULT_LIMIT = 50;

/** `limit` 上限（夹紧在这里；要更多就按分类分批查）。 */
export const MAX_LIMIT = 500;

/** 颜色档四态（与快照的 `colorKindCodes` 同一套）。 */
export const COLOR_KINDS = Object.freeze(['mono', 'multi', 'neutral', 'mixed']);

/**
 * 回执里 `source.note` 的**精简一行**（省体积用）。
 * 完整那句（带具体目录名）在快照的 `source.mirrorNote` 里；`origin` 已经把镜像主机与路径说全了，
 * 所以这里只留「镜像是谁、不是什么」这个结论 —— **只去体积，不去结论**。
 */
const MIRROR_NOTE = '镜像 ≠ 官方（第三方镜像，非 miHoYo 端点）';

/**
 * 每次回执都带的**未验证项**（照本仓证据双轴：说清哪些还没验，别把镜像事实当官方结论）。
 * 只写 3~4 行、每行一句话 —— 它是给 AI 决策用的，不是免责声明。
 */
const UNVERIFIED = Object.freeze([
  '真机渲染：unknown（镜像里有图 ≠ 正式服能加载；真机才是判据）',
  '颜色档 neutral/mixed：来自 14 类各抽 ≤5 张（共 66 张），样本小、只作旁证；含「单色/彩色」的 8 类以官方名为准',
  'imgExists：镜像目录口径（21 条空条目抽验 7 个全 404）；号段内部未逐点验',
]);

/** 快照文件路径（`lib/images/catalog.json`）。 */
function catalogPath() {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

let cachedCatalog = null;

/**
 * 读快照（**只读、进程内缓存一次**）。读不到 / 坏了都报错并点名路径与重建命令（不静默给空表）。
 * @returns {any}
 */
export function loadImageCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const p = catalogPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error('读不到图片资源库快照：' + p + '（' + ((e && e.message) || e) + '）'
      + ' —— 用 `node tools/build-image-catalog.mjs` 重新生成');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error('图片资源库快照不是合法 JSON：' + p + '（' + ((e && e.message) || e) + '）');
  }
  if (!obj || !Array.isArray(obj.items) || !Array.isArray(obj.categories) || !Array.isArray(obj.colorKindCodes)) {
    throw new Error('图片资源库快照结构不对（缺 items / categories / colorKindCodes）：' + p);
  }
  cachedCatalog = obj;
  return obj;
}

/**
 * 分类过滤值 → 分类 id 数组。
 * 支持：分类 id（`8` / `"8"`）、中文名、英文名（大小写不敏感）；名字**先精确后子串**
 * （子串命中多个 = 并集，例如 `"单色"` → 4 个分类）。**一个都没命中就报错并列出全部合法值**（不默认全表）。
 * @param {any} snap 快照
 * @param {unknown} value 工具入参 `category`
 * @returns {number[]} 分类 id（按快照里的展示顺序；空数组 = 没给过滤）
 */
export function resolveCategory(snap, value) {
  if (value === undefined || value === null || value === '') return [];
  const ids = snap.categories.map((/** @type {any} */ c) => Number(c.id));
  const asNum = Number(value);
  if (Number.isFinite(asNum) && ids.includes(asNum)) return [asNum];
  const needle = String(value).trim().toLowerCase();
  const byName = (/** @type {any} */ c) => [c.nameZh, c.nameEn].map((s) => String(s || '').toLowerCase());
  const exact = snap.categories.filter((/** @type {any} */ c) => byName(c).includes(needle));
  const hit = exact.length ? exact : snap.categories.filter((/** @type {any} */ c) => byName(c).some((s) => s.includes(needle)));
  if (!hit.length) {
    throw new Error('category 只能给分类 id 或分类名，合法的有：'
      + snap.categories.map((/** @type {any} */ c) => c.id + ' ' + c.nameZh).join(' / ')
      + '（若给名字也可以只给一段子串，如「单色」；收到 ' + JSON.stringify(value) + '）');
  }
  return hit.map((/** @type {any} */ c) => Number(c.id));
}

/** `limit` 归一化：省略 → 默认；非数字 → 报错；数字 → 夹到 `[1, MAX_LIMIT]` 并标记夹过。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return { limit: DEFAULT_LIMIT, clamped: false };
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('limit 只能是数字（收到 ' + JSON.stringify(value) + '），默认 ' + DEFAULT_LIMIT + '，上限 ' + MAX_LIMIT);
  const floored = Math.floor(n);
  const limit = Math.min(MAX_LIMIT, Math.max(1, floored));
  return { limit, clamped: limit !== floored };
}

/**
 * `op=catalog` 的回执构造器（**接线方直接调它**，参数就是工具参数）。
 *
 * @param {{category?: string|number, colorKind?: string, simOnly?: boolean, imgExists?: boolean,
 *          id?: string|number, limit?: number, summaryOnly?: boolean, withMeta?: boolean}} args
 * @returns {any} `{ok, op, filters, categories?|category?|categoriesOmitted?, items?, itemsOmitted?,
 *                  counts, limit, limitClamped, idRange, source, unverified, notes}`
 */
export function queryImageCatalog(args = {}) {
  const snap = loadImageCatalog();
  const codes = snap.colorKindCodes;
  const kindOf = (/** @type {number} */ code) => codes[code] ?? null;

  const catIds = resolveCategory(snap, args.category);
  const catSet = new Set(catIds);
  /** 颜色档过滤（不传 = 全部）。 */
  let colorKind = null;
  if (args.colorKind !== undefined && args.colorKind !== null && args.colorKind !== '') {
    const k = String(args.colorKind).trim().toLowerCase();
    if (!COLOR_KINDS.includes(k)) {
      throw new Error('colorKind 只能是 ' + COLOR_KINDS.join(' / ') + ' 之一（收到 ' + JSON.stringify(args.colorKind) + '）');
    }
    colorKind = k;
  }
  const simOnly = args.simOnly === true;
  /** `imgExists` 过滤（不传 = 不筛；`false` 就是那 21 条"目录标了但没图"的）。 */
  let imgExistsOnly = null;
  if (args.imgExists === true || args.imgExists === false) imgExistsOnly = args.imgExists;

  let wantId = null;
  if (args.id !== undefined && args.id !== null && args.id !== '') {
    const n = Number(args.id);
    if (!Number.isInteger(n)) throw new Error('id 只能是整数图片素材号（收到 ' + JSON.stringify(args.id) + '）');
    wantId = n;
  }

  const { limit, clamped } = normalizeLimit(args.limit);

  /** @type {any[]} */
  const matched = [];
  let imgMissing = 0;
  for (const raw of snap.items) {
    const id = Number(raw[0]);
    const cat = Number(raw[1]);
    const flags = Number(raw[2]);
    const kind = kindOf(Number(raw[3]));
    const hasImg = (flags & 1) === 1;
    const sim = (flags & 2) === 2;
    if (!hasImg) imgMissing += 1;
    if (wantId !== null && id !== wantId) continue;
    if (catSet.size && !catSet.has(cat)) continue;
    if (colorKind !== null && kind !== colorKind) continue;
    if (simOnly && !sim) continue;
    if (imgExistsOnly !== null && hasImg !== imgExistsOnly) continue;
    matched.push({ id, categories: [cat], colorKind: kind, imgExists: hasImg, simRenderable: sim });
  }

  const shown = matched.slice(0, limit);
  /**
   * **发现调用**（一个收窄条件都没给）或**显式要元信息**（`withMeta:true`）⇒ 给完整 14 行分类表；
   * 否则是**过滤调用** ⇒ 只给收窄到的那一条 + `categoriesOmitted`（省体积，但让人知道省了什么）。
   */
  const narrowed = catIds.length > 0 || colorKind !== null || simOnly || imgExistsOnly !== null || wantId !== null;
  const allCats = snap.categories.map((/** @type {any} */ c) => ({
    id: c.id, nameZh: c.nameZh, nameEn: c.nameEn, count: c.count, range: c.range, colorKind: c.colorKind,
  }));
  /** @type {any} */
  const receipt = {
    ok: true,
    op: 'catalog',
    filters: {
      category: args.category === undefined || args.category === '' ? null : args.category,
      categoryIds: catIds,
      colorKind,
      simOnly,
      imgExists: imgExistsOnly,
      id: wantId,
    },
  };
  if (!narrowed || args.withMeta === true) {
    receipt.categories = allCats;
  } else if (catIds.length === 1) {
    receipt.category = allCats.find((/** @type {any} */ c) => Number(c.id) === catIds[0]);
    receipt.categoriesOmitted = allCats.length;          // 整张表都没给（那一行在 `category` 里，不在 `categories` 里）
  } else if (catIds.length > 1) {
    receipt.categories = allCats.filter((/** @type {any} */ c) => catIds.includes(Number(c.id)));
    receipt.categoriesOmitted = allCats.length - receipt.categories.length;
  } else {
    receipt.categoriesOmitted = allCats.length;
  }
  if (args.summaryOnly === true) receipt.itemsOmitted = shown.length;
  else receipt.items = shown;
  receipt.counts = {
    catalogTotal: snap.itemCount,
    imgMissingInCatalog: imgMissing,
    total: matched.length,
    returned: shown.length,
    truncated: matched.length > shown.length,
  };
  receipt.limit = limit;
  receipt.limitClamped = clamped;
  receipt.idRange = snap.idRange;
  /** `source` 恒 3 个字段；`fetchedAt` / `sha256Prefix` 只在 `withMeta:true` 时补（审计哈希才要）。 */
  receipt.source = {
    mirror: true,
    origin: 'mirror@oss.xiaomol444.xyz/ugc-tool-data/Public/CustomUIImage',
    note: MIRROR_NOTE,
  };
  if (args.withMeta === true) {
    receipt.source.fetchedAt = snap.source && snap.source.fetchedAt;
    receipt.source.sha256Prefix = {
      data: String((snap.source && snap.source.sha256 && snap.source.sha256.data) || '').slice(0, 10),
      zh: String((snap.source && snap.source.sha256 && snap.source.sha256.zh) || '').slice(0, 10),
      en: String((snap.source && snap.source.sha256 && snap.source.sha256.en) || '').slice(0, 10),
    };
  }
  receipt.unverified = [...UNVERIFIED];

  /** @type {string[]} */
  const notes = [snap.nameNote];
  if (catIds.length > 1) notes.push('分类过滤命中 ' + catIds.length + ' 个分类（子串匹配）：' + catIds.join(' / '));
  if (wantId !== null && !matched.length) {
    notes.push('这个 id 不在目录里：目录共 ' + snap.itemCount + ' 个 id（' + snap.idRange[0] + '~' + snap.idRange[1]
      + '），并且有 21 条"目录标了但没有图"（看 imgExists）。');
  }
  receipt.notes = notes;
  return receipt;
}
