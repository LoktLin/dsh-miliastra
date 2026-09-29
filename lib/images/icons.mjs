/**
 * 平台图标**检索**（`miliastra_asset op=icon-search` 的纯函数半边）。
 *
 * 数据 = `lib/images/icons.json`（0.9 MB / 1543 条）—— 由 `tools/build-icon-index.mjs` 合并三源生成：
 *   · 目录事实（id / 分类 / 有没有图 / 模拟器认不认）
 *   · 本地像素（颜色 `defaultColor` / 透明占比 / 近似单色）
 *   · **视觉识别推断**（形状 / 名字 / 关键词 / 置信度 —— `nameSource:"vision-inferred"`）
 *
 * ★ 渐进式披露（作者定调，别破坏）：
 *   第1层 schema 只放"怎么找"（本模块的 `doc` 指针就是第3层入口）；
 *   第2层回执**按需**：不传 `q`/`id`/筛选 ⇒ **分类概览**（14 行）；传 `id` ⇒ **单条全字段**；传条件 ⇒ 命中条目；
 *   第3层全表在数据文件与 `docs/千星奇域_图标识图与接口规划.md（**已按创作者要求清理**）`。
 * ★ 诚实口径：名字是**模型推断**、不是官方名（官方目录没有单图名称）；查不到时要说清"这是推断词"，
 *   **不许静默返回空**；真机渲染未验证（`unverified` 恒定带）。
 */
import fs from 'node:fs';

let CACHE = null;

/** 懒加载 + 缓存（0.9 MB，别每次调用都重解析）。 */
export function loadIconIndex() {
  if (CACHE) return CACHE;
  const url = new URL('./icons.json', import.meta.url);
  CACHE = JSON.parse(fs.readFileSync(url, 'utf8'));
  return CACHE;
}

export const ICON_DOC = 'docs/千星奇域_图标识图与接口规划.md（**已按创作者要求清理**） §1（字段与三轴来源）/ §2（三层披露）；数据 lib/images/icons.json';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const haystack = (it) => [
  it.nameZh, it.nameEn, it.shape,
  ...(it.keywordsZh || []), ...(it.keywordsEn || []),
].filter(Boolean).join(' ').toLowerCase();

const brief = (it) => ({
  id: it.id, nameZh: it.nameZh, shape: it.shape,
  keywordsZh: (it.keywordsZh || []).slice(0, 6),
  colorKind: it.colorKind, defaultColor: it.defaultColor,
  simRenderable: it.simRenderable, imgExists: it.imgExists, confidence: it.confidence,
});

const UNVERIFIED = [
  '★ **真机渲染未验证**：`defaultColor` / `shape` / 名字都来自像素分析与模型识图，**正式服里画成什么样只有真机能看到**。',
  '★ **`simRenderable:true` 只说明本仓模拟器画得出**（`100001~100006` 六个几何号），不是平台限制 —— 真机可用目录里全部 1543 个号。',
];

/**
 * @param {{q?:string, id?:number|string, shape?:string, colorKind?:string,
 *          category?:string|number, simOnly?:boolean, limit?:number, summaryOnly?:boolean}} [args]
 */
export function searchIcons(args = {}) {
  const idx = loadIconIndex();
  const items = idx.items || [];
  const byId = new Map(items.map((x) => [String(x.id), x]));
  const base = { ok: true, op: 'icon-search', itemCount: idx.itemCount, recognizedCount: idx.recognizedCount, nameSource: 'vision-inferred', doc: ICON_DOC, unverified: UNVERIFIED };

  /* ---- 单条明细 ---- */
  if (args.id != null && args.id !== '') {
    const hit = byId.get(String(args.id));
    if (!hit) {
      const want = Number(args.id);
      const near = items
        .filter((x) => Number.isFinite(want) && Math.abs(x.id - want) <= 8)
        .slice(0, 8)
        .map((x) => x.id);
      return {
        ...base, ok: false, mode: 'detail',
        error: '没有这个 id：' + String(args.id) + '（数据里共 ' + idx.itemCount + ' 条，id 范围 ' + JSON.stringify(idx.idRange) + '）',
        nearestIds: near,
        hint: 'id 是平台图片素材号（6 位数字，如 100005 五角星 / 108010 点状虚线）。要按语义找，用 `q`；先看有哪些分类就不传参数。',
      };
    }
    return { ...base, mode: 'detail', item: hit, counts: { total: 1, returned: 1, truncated: false } };
  }

  /* ---- 收窄条件 ---- */
  const q = args.q == null ? '' : String(args.q).trim();
  const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const hasFilter = terms.length > 0 || args.shape != null || args.colorKind != null || args.category != null || args.simOnly === true;

  const matchCategory = (it) => {
    if (args.category == null) return true;
    const want = String(args.category).trim();
    return String(it.categoryId) === want
      || (it.categoryNameZh && String(it.categoryNameZh).indexOf(want) >= 0);
  };

  /* ---- 发现调用：不传任何条件 ⇒ 分类概览（14 行，省 token） ---- */
  if (!hasFilter) {
    const groups = new Map();
    for (const it of items) {
      const k = it.categoryId == null ? '?' : String(it.categoryId);
      if (!groups.has(k)) groups.set(k, { categoryId: it.categoryId, nameZh: it.categoryNameZh, count: 0, ids: [] });
      const g = groups.get(k);
      g.count++;
      if (g.ids.length < 3) g.ids.push(it.id);
    }
    const categories = [...groups.values()].sort((a, b) => a.count - b.count ? b.count - a.count : 0);
    return {
      ...base, mode: 'overview', total: idx.itemCount,
      categories,
      counts: { total: idx.itemCount, returned: categories.length, truncated: false, unrecognizedCount: idx.unrecognizedCount, lowConfidenceCount: idx.lowConfidenceCount, emptyImgCount: idx.emptyImgCount },
      hint: '这是**分类概览**（每个分类只给 3 个示例 id）。要找具体图标：传 `q`（中文或英文关键词，空格 = AND），例如 `{"op":"icon-search","q":"宝箱"}`；或传 `category` 收窄。',
    };
  }

  /* ---- 过滤调用：只回命中条目 ---- */
  let hits = items.filter(matchCategory);
  if (args.simOnly === true) hits = hits.filter((x) => x.simRenderable === true);
  if (args.colorKind != null) hits = hits.filter((x) => x.colorKind === String(args.colorKind));
  if (args.shape != null) {
    const s = String(args.shape).toLowerCase();
    hits = hits.filter((x) => x.shape && x.shape.toLowerCase().indexOf(s) >= 0);
  }
  if (terms.length) {
    hits = hits
      .map((it) => {
        const hay = haystack(it);
        let score = 0;
        for (const t of terms) {
          if (hay.indexOf(t) < 0) return null;   // AND：任一 term 不中即淘汰
          score += (it.keywordsZh || []).concat(it.keywordsEn || []).some((k) => String(k).toLowerCase() === t) ? 2 : 1;
        }
        return { it, score };
      })
      .filter(Boolean)
      .sort((a, b) => (b.score - a.score) || ((b.it.confidence || 0) - (a.it.confidence || 0)) || (a.it.id - b.it.id))
      .map((x) => x.it);
  } else {
    hits = hits.slice().sort((a, b) => a.id - b.id);
  }

  const limit = Math.min(Math.max(Number(args.limit) > 0 ? Math.round(Number(args.limit)) : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const limitClamped = Number(args.limit) > MAX_LIMIT;
  const returned = hits.slice(0, limit);
  /** @type {Record<string, any>} 回执是"按档拼装"的（`items`/`hint`/`itemsOmitted` 视档位增删），所以放宽类型 */
  const out = {
    ...base, mode: 'search',
    query: { q, terms, shape: args.shape == null ? null : String(args.shape), colorKind: args.colorKind == null ? null : String(args.colorKind), category: args.category == null ? null : String(args.category), simOnly: args.simOnly === true },
    counts: { total: items.length, matched: hits.length, returned: returned.length, truncated: hits.length > returned.length },
    limit, limitClamped,
    items: returned.map(brief),
  };
  if (args.summaryOnly === true) { out.itemsOmitted = out.items.length; delete out.items; }

  if (!hits.length) {
    out.hint = '没有命中 —— ⚠️ 这些名字/关键词是**模型识图推断**出来的（官方目录没有单图名称），换个词试试：'
      + '① 更泛的上位词（如「图标」「箭头」「箱子」）；② 英文词（如 `chest`）；'
      + '③ 不传 `q` 看**分类概览**（14 类）；④ 想按"看起来长什么样"找，用 `shape`（如 `shape:"圆"`）。';
  } else {
    out.hint = '命中按"关键词精确度 → 置信度"排序。要看某一条的全部字段（含像素统计与识别原文），传 `id`。';
  }
  // ⚠️ `summaryOnly` **只去逐条正文**（`items`），`hint`/`counts`/`unverified`/`doc` 一个都不删 —— 那是结论。
  return out;
}
