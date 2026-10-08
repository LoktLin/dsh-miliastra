/**
 * 图片资源库测试（`lib/images/query.mjs` + `tools/build-image-catalog.mjs` + `lib/images/catalog.json`）
 * **兼** `miliastra_asset` 三个新 op 的**接线测试**（`catalog` / `sound-search` / `sound-get`）。
 *
 * 四层钉：
 *   ① **查询层**：分类过滤（id / 中文名 / 英文名 / 子串）、`colorKind`、`simOnly`、`imgExists`、
 *      `limit` 夹紧、`id` 精确查、未知分类与未知颜色档**必须报错**（不静默给全表）；
 *   ② **数据层**：快照 1543 条 / 14 类 / id 空间两端 / 21 条"目录标了却没图" / 颜色档四态计数 /
 *      每个 id 恰好 1 个分类；并**直接读引擎常量**核对 `simRenderable` 那 6 个号（防两边漂移）；
 *   ③ **工具层**：从 `TOOLS` 里拿 `miliastra_asset` 真 `execute` —— 证明三个 op 真的接上了、回执形状稳、
 *      **回执里没有 `undefined`**、`summaryOnly` **只去体积不去结论**、未知 op 明确报错；
 *      `op=sound-search` 的**五档各一条**（真数据）也在这层钉住（那半边是 `tests/sounds-test.mjs` 的接线）。
 *   ④ **可重放层**：镜像还在时，用生成器把快照重建一遍并要求**逐字节一致** + **逐条对账**。
 *      镜像目录不在（别的机器 / 只 clone 了插件）时**跳过并说明**，不假装跑过。
 *
 * 每条都写清「**修之前为什么红**」—— 断言的价值在于将来某次改动时能重新变红：
 *   · 「21 条无图」：目录里 `img`/`border` 是空串、PNG 实测 404；漏了 `imgExists` 这一列，
 *     AI 会拿一个**根本没有图**的号去 `SetImage`（静默不显示，最难查）。
 *   · 「单图没有名字」：目录里**没有**名字字段 ⇒ 任何"`100136` = 星星"都是编的；这里钉住回执只给分类名。
 *   · 「`simRenderable` == 引擎的 6 个键」：两边各写一份常量，漂移了就只有人眼能发现 ⇒ 让测试读引擎现算。
 *   · 「未知 category 报错」：默认回落全表会让 AI 拿到 1543 条噪声却以为筛过了。
 *   · 「`limit` 夹紧并回 `limitClamped`」：不夹会让一次调用把 1543 条灌进上下文；夹了不说则等于静默截断。
 *   · 「`summaryOnly` 不丢结论」：`items` 可以省，`counts` / 分类表 / `unverified` 一个都不能少
 *     （本仓不变量③：只去体积、不去结论）。
 *   · 「回执无 undefined」：`JSON.stringify` 会把 `undefined` 键**整个删掉** —— 字段悄悄缺失最难发现。
 *   · 「发现调用给全表、过滤调用只给结论」（2026-09-28 体积策略）：修前 `categories` **恒 14 行**，
 *     查 1 个分类时它占回执约一半 ⇒ 现在过滤调用只给**单条** `category` + `categoriesOmitted:14`，
 *     `withMeta:true` 才恢复全表；`sound-search` 那半边同理（带 `q` 时省分类表与 `catalog` 段）。
 *     新增的 ①~⑥ 断言就是钉这条：**省体积可以，丢结论不行**（同一条件下 `counts` 逐字段相等）。
 *   · 「无 `q` 的 `sound-search` 不再报错」：改成**发现调用**（给 7 行分类表 + `browse:true` + **0 条音效**）——
 *     既不报错、也不静默把 1997 条灌进上下文，两头都钉住。
 *
 * 用法：`node tests/catalog-test.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMIT, MAX_LIMIT, COLOR_KINDS, loadImageCatalog, resolveCategory, queryImageCatalog,
} from '../lib/images/query.mjs';
import {
  CATALOG_VERSION, IMAGE_SOURCE, DEFAULT_SRC_DIR, CATALOG_PATH, SIM_RENDERABLE_IDS,
  buildImageCatalog, serializeCatalog, readSource,
} from '../tools/build-image-catalog.mjs';
import { IMAGE_PRIMITIVES } from '../engine/studio/constants.js';
import { TOOLS } from '../index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}
/** 抛错就返回错误消息，不抛返回 null（断言报错口径时用）。 */
function errOf(fn) {
  // 2026-10-08：出口已统一「失败回 {ok:false} 回执、不抛异常」⇒ 回执的 error 也算「报错文案」
  try { const r = fn(); if (r && typeof r === 'object' && r.ok === false) return String(r.error || r.code || 'ok:false'); return null; }
  catch (e) { return (e && e.message) || String(e); }
}
/**
 * 同上，但给 **async** 用（`asset.execute` 是 async：不 await 的话"抛错"变成一个 rejected Promise，
 * 同步 try/catch 抓不到 ⇒ 断言会**静默变成 null 而假过/假红**）。这条注释是踩出来的。
 */
async function errOfAsync(fn) {
  // 2026-10-08：同上（async 版）
  try { const r = await fn(); if (r && typeof r === 'object' && r.ok === false) return String(r.error || r.code || 'ok:false'); return null; }
  catch (e) { return (e && e.message) || String(e); }
}
/** 回执里有没有 `undefined` 值（JSON 会把它整键删掉 ⇒ 必须自己走一遍）。 */
function hasUndefined(v, seen = new Set()) {
  if (v === undefined) return true;
  if (v === null || typeof v !== 'object') return false;
  if (seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => hasUndefined(x, seen));
  return Object.values(v).some((x) => hasUndefined(x, seen));
}

const catalog = loadImageCatalog();
const asset = TOOLS.find((t) => t.name === 'miliastra_asset');
const call = (args) => asset.execute(args);

/* ══════════════════════════════════════════════════ ① 查询层（纯函数） */

console.log('--- ① 查询层（分类解析 / 参数校验 / 夹紧）');

ok('resolveCategory 认分类 id（数字与字符串都行）',
  JSON.stringify(resolveCategory(catalog, 8)) === '[8]' && JSON.stringify(resolveCategory(catalog, '8')) === '[8]');
ok('resolveCategory 认中文名（「基础形状」→ 8）', JSON.stringify(resolveCategory(catalog, '基础形状')) === '[8]');
ok('resolveCategory 认英文名（大小写不敏感）', JSON.stringify(resolveCategory(catalog, 'basic shapes')) === '[8]');
ok('★ resolveCategory 子串命中多个分类（「单色」→ 4 个，按展示顺序）',
  JSON.stringify(resolveCategory(catalog, '单色')) === '[3,15,5,1]', JSON.stringify(resolveCategory(catalog, '单色')));
ok('resolveCategory 空值 = 不过滤（空数组）', JSON.stringify(resolveCategory(catalog, '')) === '[]');
ok('★ 未知 category **报错并列出合法值**（不静默回全表）', (() => {
  const m = errOf(() => resolveCategory(catalog, '不存在的分类'));
  return m !== null && /基础形状/.test(m);
})(), String(errOf(() => resolveCategory(catalog, '不存在的分类'))));

ok('★ 未知 colorKind 报错并列出四态', (() => {
  const m = errOf(() => queryImageCatalog({ colorKind: 'red' }));
  return m !== null && COLOR_KINDS.every((k) => m.includes(k));
})(), String(errOf(() => queryImageCatalog({ colorKind: 'red' }))));
ok('★ 非数字 id 报错（不静默返回全表）', errOf(() => queryImageCatalog({ id: 'abc' })) !== null);
ok('★ 非数字 limit 报错', errOf(() => queryImageCatalog({ limit: 'many' })) !== null);

ok('★ limit 省略 = 默认 ' + DEFAULT_LIMIT, queryImageCatalog({ limit: undefined }).limit === DEFAULT_LIMIT);
ok('★ limit 上限夹到 ' + MAX_LIMIT + '（并说清夹过）', (() => {
  const r = queryImageCatalog({ limit: 99999 });
  return r.limit === MAX_LIMIT && r.limitClamped === true;
})());
ok('★ limit 给 0 / 负数夹到 1（也标记夹过）', queryImageCatalog({ limit: 0 }).limit === 1
  && queryImageCatalog({ limit: -5 }).limit === 1 && queryImageCatalog({ limit: -5 }).limitClamped === true);
ok('limit 没夹时不乱标（limitClamped=false）', queryImageCatalog({ limit: 7 }).limitClamped === false);

ok('★ DEFAULT_LIMIT / MAX_LIMIT 是"默认行为"的一部分（写成常量，别在别处再抄一份）',
  DEFAULT_LIMIT === 50 && MAX_LIMIT === 500, DEFAULT_LIMIT + '/' + MAX_LIMIT);
ok('COLOR_KINDS 是四态且顺序 = 快照的 colorKindCodes',
  JSON.stringify(COLOR_KINDS) === JSON.stringify(catalog.colorKindCodes));

/* ══════════════════════════════════════════════════ ② 数据层（快照事实） */

console.log('\n--- ② 数据层（快照 = 平台目录的快照，只报事实）');

ok('快照版本 = ' + CATALOG_VERSION, catalog.version === CATALOG_VERSION);
ok('★ 1543 条素材 / 14 个分类（与拓扑文档 §① 逐一对上）',
  catalog.itemCount === 1543 && catalog.categories.length === 14,
  catalog.itemCount + ' / ' + catalog.categories.length);
ok('★ id 空间 100001~112042', catalog.idRange[0] === 100001 && catalog.idRange[1] === 112042,
  JSON.stringify(catalog.idRange));
ok('★ 每条恰好属于 1 个分类（四元组装得下）', catalog.items.every((it) => Array.isArray(it.categories ?? []) || true)
  && catalog.items.every((it) => typeof it[1] === 'number' && it[1] > 0));
ok('分类计数合计 = 1543', catalog.categories.reduce((s, c) => s + c.count, 0) === 1543);
ok('★ 各分类计数与拓扑文档 §2.2 逐项一致', (() => {
  const want = { 1: 96, 2: 392, 3: 113, 4: 80, 5: 10, 6: 317, 7: 75, 8: 6, 9: 139, 12: 42, 15: 52, 16: 148, 17: 53, 18: 20 };
  return catalog.categories.every((c) => want[c.id] === c.count);
})(), catalog.categories.map((c) => c.id + '=' + c.count).join(' '));
ok('分类表按**平台展示顺序**排（第一个是 3「功能图标-单色」，不是 id 最小的 1）',
  catalog.categories[0].id === 3, String(catalog.categories[0].id));

ok('★ 21 条"目录里有、图却缺"（imgExists=false），id 与拓扑文档 §3.3 逐个对上', (() => {
  const want = [101019, 101029, 101047, 101049, 101055, 105141, 105220, 106048, 107008, 107009,
    107093, 107181, 107182, 107202, 107206, 107229, 107230, 107279, 108018, 109032, 109035];
  const got = catalog.items.filter((it) => (it[2] & 1) === 0).map((it) => it[0]);
  return JSON.stringify(got) === JSON.stringify(want);
})());
ok('★ 颜色档四态计数与文档 §4.4 一致（mono 271 / multi 937 / neutral 101 / mixed 234）', (() => {
  const c = [0, 0, 0, 0];
  for (const it of catalog.items) c[it[3]] += 1;
  return JSON.stringify(c) === '[271,937,101,234]';
})());
ok('★ 官方分类名的两种档位是**照抄名字**算出来的（含「单色」→ mono、含「彩色」→ multi）',
  catalog.categories.every((c) => (/单色/.test(c.nameZh) ? c.colorKind === 'mono'
    : /彩色/.test(c.nameZh) ? c.colorKind === 'multi' : c.colorKind === 'neutral' || c.colorKind === 'mixed')));
ok('★ 快照自己声明"单图没有名字"（工具因此不编名字）',
  typeof catalog.nameNote === 'string' && /没有名字/.test(catalog.nameNote));
ok('源的三个 sha256 都钉在快照里（data / zh / en 各一条）',
  ['data', 'zh', 'en'].every((k) => /^[0-9a-f]{64}$/.test(String(catalog.source.sha256[k]))));
ok('★ 钉住的 sha256 与拓扑文档 §9.2 A 的前 10 位一致（镜像换了就重建不了）',
  catalog.source.sha256.data.startsWith('9fb2308e51') && catalog.source.sha256.zh.startsWith('49ca276c8b')
  && catalog.source.sha256.en.startsWith('7b307879f3'));

ok('★ `simRenderable` 的号 == **引擎 `IMAGE_PRIMITIVES` 的键**（两边各一份常量 ⇒ 让测试现算）', (() => {
  const fromSnap = catalog.items.filter((it) => (it[2] & 2) === 2).map((it) => it[0]).sort((a, b) => a - b);
  const fromEngine = Object.keys(IMAGE_PRIMITIVES).map(Number).sort((a, b) => a - b);
  return JSON.stringify(fromSnap) === JSON.stringify(fromEngine);
})(), '快照 ' + SIM_RENDERABLE_IDS.join(',') + ' / 引擎 ' + Object.keys(IMAGE_PRIMITIVES).join(','));
ok('那 6 个号正好是分类 8「基础形状」的全部成员',
  JSON.stringify(catalog.categories.find((c) => c.id === 8).range) === '[100001,100006]');

ok('★ 文档里的冲突样本 `106048`：目录里有、图却缺（`imgExists:false`），分类 1、档 mono', (() => {
  const r = queryImageCatalog({ id: 106048 });
  const it = r.items[0];
  return r.items.length === 1 && it.imgExists === false && JSON.stringify(it.categories) === '[1]' && it.colorKind === 'mono';
})());

/* ══════════════════════════════════════════════════ ③ 工具层（接线） */

console.log('\n--- ③ 工具层（从 TOOLS 真调 `miliastra_asset`）');

ok('`miliastra_asset` 的 op 枚举里有 catalog / sound-search / sound-get',
  ['catalog', 'sound-search', 'sound-get'].every((o) => asset.parameters.properties.op.enum.includes(o)));
ok('三个新 op 用到的参数都在 schema 里（q / category / colorKind / simOnly / imgExists + 复用的 id / limit / summaryOnly）',
  ['q', 'category', 'colorKind', 'simOnly', 'imgExists', 'id', 'limit', 'summaryOnly']
    .every((k) => Object.prototype.hasOwnProperty.call(asset.parameters.properties, k)));
ok('★ description 里有「典型调用」且点到了两个平台通道（AI 只看得见 schema）',
  /典型调用/.test(asset.description) && /op=catalog/.test(asset.description) && /sound-search/.test(asset.description));
ok('★ description 里写明**不支持拼音**（免得 AI 在死路上反复试）', /不支持拼音/.test(asset.description));
ok('★ `withMeta` 在 schema 里（boolean），且 description 说清「什么时候用」（AI 只看得见 schema）',
  asset.parameters.properties.withMeta && asset.parameters.properties.withMeta.type === 'boolean'
  && /挑分类/.test(asset.parameters.properties.withMeta.description)
  && /审计哈希/.test(asset.parameters.properties.withMeta.description));
ok('★ description 里写了回执体积策略（发现调用 vs 过滤调用 + `withMeta`）',
  /发现调用/.test(asset.description) && /categoriesOmitted/.test(asset.description) && /withMeta/.test(asset.description));

const cat = await call({ op: 'catalog', category: '基础形状' });
ok('op=catalog：分类过滤 → 6 条（分类 8 的全部成员）',
  cat.op === 'catalog' && cat.counts.total === 6 && cat.counts.returned === 6, JSON.stringify(cat.counts));
ok('op=catalog：每条给 id + 分类 + 颜色档 + imgExists + simRenderable（五列齐全）',
  cat.items.every((it) => typeof it.id === 'number' && Array.isArray(it.categories)
    && COLOR_KINDS.includes(it.colorKind) && typeof it.imgExists === 'boolean' && typeof it.simRenderable === 'boolean'));
/*
 * ★ ①「发现调用给全表，过滤调用只给结论」（作者 2026-09-28 点名的 AI 侧体积策略）
 *   **修之前为什么红**：这版之前 `categories` **恒 14 行**（约 1.4 KB）—— 查 1 个分类时分类表占回执**约一半**；
 *   有了 `withMeta` 之后还能一眼看出「被省了什么」，而不是悄悄少一块。
 */
const discover = await call({ op: 'catalog' });
ok('★ ① op=catalog 过滤调用：**没有**完整 14 行分类表，改回**单条** `category` + `categoriesOmitted:14`',
  cat.categories === undefined && cat.category && cat.category.id === 8
  && cat.category.nameZh === '基础形状' && cat.category.colorKind === 'neutral'
  && cat.categoriesOmitted === 14, JSON.stringify({ category: cat.category, omitted: cat.categoriesOmitted }));
ok('★ ① op=catalog 发现调用（一个收窄条件都不给）：**仍给**完整 14 行分类表，且没有 `categoriesOmitted`',
  discover.categories.length === 14 && discover.categoriesOmitted === undefined && discover.category === undefined);
ok('★ ① 省下来的体积是实打实的（过滤回执不到发现回执的一半）',
  JSON.stringify(cat).length * 2 < JSON.stringify(discover).length,
  JSON.stringify(cat).length + ' B vs ' + JSON.stringify(discover).length + ' B');

/* ★ ② `withMeta:true` = 「把完整分类表与 sha256 元信息给我」（只在挑分类 / 要审计哈希时开） */
const meta = await call({ op: 'catalog', category: '基础形状', withMeta: true });
ok('★ ② op=catalog + withMeta:true：完整 14 行分类表**恢复**，单条 `category` / `categoriesOmitted` 退场',
  meta.categories.length === 14 && meta.categoriesOmitted === undefined && meta.category === undefined);
ok('★ ② op=catalog + withMeta:true：sha256 三连 + `fetchedAt` 一起给（默认不给）',
  /^[0-9a-f]{10}$/.test(meta.source.sha256Prefix.data) && /^[0-9a-f]{10}$/.test(meta.source.sha256Prefix.zh)
  && /^[0-9a-f]{10}$/.test(meta.source.sha256Prefix.en)
  && typeof meta.source.fetchedAt === 'string' && meta.source.fetchedAt.length > 0);
ok('② 默认（不加 withMeta）：`source` **只有 3 个字段** `mirror / origin / note`（没有 sha256 / fetchedAt）',
  Object.keys(cat.source).join(',') === 'mirror,origin,note'
  && cat.source.sha256Prefix === undefined && cat.source.fetchedAt === undefined
  && cat.source.mirror === true && /^mirror@/.test(cat.source.origin));
ok('op=catalog：恒带 `unverified[]` 与镜像出处（别把镜像当官方）',
  Array.isArray(cat.unverified) && cat.unverified.length >= 3 && cat.source.mirror === true
  && /镜像/.test(String(cat.source.note)));
ok('★ op=catalog：回执里**没有 undefined**（三种模式都查）',
  !hasUndefined(cat) && !hasUndefined(discover) && !hasUndefined(meta),
  JSON.stringify(cat).includes('undefined') ? '有 undefined' : '');
/*
 * ★ ⑤「只去体积、不去结论」：`withMeta` **只加元信息**，同一条件下的结论字段必须逐字相等。
 *   **修之前为什么红**：体积优化最容易出的错就是「顺手把 categories 删了还把一个 counts 也删了」——
 *   这种错**不会报错**，只会让 AI 少一个判据。
 */
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
ok('★ ⑤ 只去体积不去结论：`counts` 在「精简」与 `withMeta:true` 两种回执里**逐字段相等**',
  canon(meta.counts) === canon(cat.counts) && cat.counts.total === 6 && cat.counts.catalogTotal === 1543);
ok('★ ⑤ `filters` / `items` / `limit` / `limitClamped` / `idRange` / `notes` 也逐字一致',
  canon({ f: meta.filters, i: meta.items, l: meta.limit, lc: meta.limitClamped, ir: meta.idRange, n: meta.notes })
  === canon({ f: cat.filters, i: cat.items, l: cat.limit, lc: cat.limitClamped, ir: cat.idRange, n: cat.notes }));
/*
 * ★ ⑥ `unverified` 是**对外诚实口径**：任何模式下都在，且逐字相同（体积极简也绝不动它）。
 */
ok('★ ⑥ `unverified` 在任何模式下都在（精简 / withMeta / 发现调用三种回执逐字相同，且 ≥3 条）',
  Array.isArray(cat.unverified) && cat.unverified.length >= 3
  && JSON.stringify(meta.unverified) === JSON.stringify(cat.unverified)
  && JSON.stringify(discover.unverified) === JSON.stringify(cat.unverified));

const sim = await call({ op: 'catalog', simOnly: true });
ok('op=catalog + simOnly：正好 6 条，且都是 100001~100006',
  sim.counts.total === 6 && sim.items.every((it) => it.simRenderable && it.id >= 100001 && it.id <= 100006));
const noImg = await call({ op: 'catalog', imgExists: false });
ok('★ op=catalog + imgExists:false：正好 21 条、条条 imgExists=false（拿号前先看这列）',
  noImg.counts.total === 21 && noImg.items.every((it) => it.imgExists === false), JSON.stringify(noImg.counts));
const mono = await call({ op: 'catalog', colorKind: 'mono' });
ok('op=catalog + colorKind:mono：271 条（= 4 个"单色"分类之和）',
  mono.counts.total === 271 && mono.items.every((it) => it.colorKind === 'mono'), JSON.stringify(mono.counts));
const sub = await call({ op: 'catalog', category: '单色' });
ok('op=catalog：分类子串「单色」→ 4 个分类 271 条，filters 里能看出命中了哪几个',
  sub.counts.total === 271 && JSON.stringify(sub.filters.categoryIds) === '[3,15,5,1]');
const miss = await call({ op: 'catalog', id: 100007 });
ok('★ op=catalog：目录里没有的 id → 0 条 + 一句 note 说清（**不报错**, 也不编）',
  miss.counts.total === 0 && miss.items.length === 0 && miss.notes.some((n) => /不在目录里/.test(n)));

const slim = await call({ op: 'catalog', category: '基础形状', summaryOnly: true });
ok('★ summaryOnly **只去体积、不去结论**（items 缺席，counts / category / unverified / source 一个不少）',
  slim.items === undefined && slim.itemsOmitted === 6 && slim.counts.total === cat.counts.total
  && slim.category.id === 8 && slim.categoriesOmitted === 14
  && Array.isArray(slim.unverified) && slim.source.mirror === true);
ok('★ summaryOnly 与非 summaryOnly 的 `counts` 逐字一致',
  JSON.stringify(slim.counts) === JSON.stringify(cat.counts));
ok('★ summaryOnly 确实更小（省的就是 items）', JSON.stringify(slim).length < JSON.stringify(cat).length);
ok('★ summaryOnly 与分类表策略**互不干扰**（两种瘦身叠起来也不丢结论：counts 仍与 withMeta 版相等）',
  canon(slim.counts) === canon(meta.counts) && slim.categoriesOmitted === 14 && meta.categoriesOmitted === undefined
  && slim.category && slim.category.id === 8 && meta.categories.length === 14);

const limited = await call({ op: 'catalog', category: '底板-彩色', limit: 3 });
ok('★ op=catalog + limit：截到 3 条并给 truncated（总数仍如实给 392）',
  limited.counts.total === 392 && limited.counts.returned === 3 && limited.counts.truncated === true);

/* ---- 音效那半边的接线（五档各一条，真数据）---- */
const tiers = [
  ['exact', { q: '环境_震动' }], ['prefix', { q: '环境' }], ['substring', { q: '宝箱' }],
  ['subsequence', { q: '环震' }], ['editDistance', { q: '命重' }],
];
for (const [kind, args] of tiers) {
  const r = await call({ op: 'sound-search', ...args });
  ok('op=sound-search：`' + args.q + '` 首条是 ' + kind + ' 档（' + (r.items[0] ? r.items[0].id : '无') + '）',
    r.ok === true && r.items[0] && r.items[0].matchKind === kind, JSON.stringify(r.items[0] || null));
}
const weak = await call({ op: 'sound-search', q: '环震' });
ok('★ op=sound-search：最弱档是子序列/编辑距离时挂 `weak:true`（那批是"凑"的）',
  weak.weak === true && /凑/.test(String(weak.hint)));
const soundSlim = await call({ op: 'sound-search', q: '宝箱', summaryOnly: true });
ok('★ op=sound-search + summaryOnly：items 缺席但 total / categoriesOmitted / catalogOmitted 都在（只去体积）',
  soundSlim.items === undefined && soundSlim.itemsOmitted > 0 && soundSlim.total === 15
  && soundSlim.categories === undefined && soundSlim.categoriesOmitted === 7 && soundSlim.catalogOmitted === true);
/*
 * ★ ③ 无 `q` 的 `sound-search` = **发现调用**：分类表与快照元信息照给，且**一条音效都不回**。
 *   **修之前为什么红**：旧版不给 `q` 直接**报错**；作者点名「纯分类浏览＝发现调用」之后，
 *   这条改成「给表、不回音效」—— 既让 AI 看得到 7 个分类，又不会被 1997 条灌满上下文。
 */
const soundFind = await call({ op: 'sound-search' });
ok('★ ③ 无 `q` 的 sound-search：7 行分类表 + `catalog` 段都在，且 `browse:true` / 0 条音效（不是静默回 1997 条）',
  soundFind.browse === true && soundFind.total === 0 && soundFind.items.length === 0
  && soundFind.categories.length === 7 && soundFind.catalog.soundCount === 1997
  && soundFind.categoriesOmitted === undefined && soundFind.catalogOmitted === undefined);
const soundFiltered = await call({ op: 'sound-search', q: '宝箱', limit: 3 });
ok('★ ① sound-search 带 `q`（过滤调用）：省掉分类表与 `catalog` 段，改回 `categoriesOmitted:7` / `catalogOmitted:true`',
  soundFiltered.categories === undefined && soundFiltered.catalog === undefined
  && soundFiltered.categoriesOmitted === 7 && soundFiltered.catalogOmitted === true && soundFiltered.total === 15);
const soundMeta = await call({ op: 'sound-search', q: '宝箱', limit: 3, withMeta: true });
ok('★ ② sound-search + withMeta:true：7 行分类表 + `catalog` 段**恢复**（省略标记退场）',
  soundMeta.categories.length === 7 && soundMeta.catalog.soundCount === 1997
  && soundMeta.categoriesOmitted === undefined && soundMeta.catalogOmitted === undefined);
const soundCat = await call({ op: 'sound-search', q: 'attack', category: 4, limit: 1 });
ok('★ ① sound-search 给 `category` 收窄：只给那一条分类行，另外 6 行记在 `categoriesOmitted`',
  soundCat.categories.length === 1 && soundCat.categories[0].id === 4 && soundCat.categories[0].name === '战斗'
  && soundCat.categoriesOmitted === 6 && soundCat.catalogOmitted === true);
ok('★ ⑤ sound-search：精简版与 `withMeta:true` 只差那 4 个字段，其余**逐字相同**（只去体积不去结论）',
  (() => {
    const a = { ...soundFiltered }; const b = { ...soundMeta };
    delete a.categoriesOmitted; delete a.catalogOmitted; delete b.categories; delete b.catalog;
    return canon(a) === canon(b) && soundFiltered.weak === false && soundMeta.weak === false;
  })());
ok('★ ① sound-search 过滤回执确实小了一截（分类表 + 元信息省掉）',
  JSON.stringify(soundFiltered).length < JSON.stringify(soundMeta).length,
  JSON.stringify(soundFiltered).length + ' B vs ' + JSON.stringify(soundMeta).length + ' B');
/*
 * ★ ⑥ 的**音效半边**：这个 op **历史上就没有** `unverified` 字段 —— 本批**不新增**（每条回执都挂一大段，
 *   正好把这一批省下来的体积又吃回去）；它的诚实口径落在 `catalog.note`（镜像 ≠ 官方），
 *   发现调用 / `withMeta` 时给。这条断言是**把决定钉住**：将来谁想加，会先看见这里为什么没加。
 */
ok('★ ⑥ sound-search 不新增 `unverified`（口径写在 `catalog.note`，发现调用 / withMeta 时给）',
  !('unverified' in soundFiltered) && !('unverified' in soundMeta) && !('unverified' in soundFind)
  && /镜像/.test(String(soundFind.catalog.note)) && /镜像/.test(String(soundMeta.catalog.note))
  && /镜像 ≠ 官方/.test(String(soundFiltered.catalogOmitted === true ? soundFind.catalog.note : '')));
const emptyQ = await errOfAsync(() => asset.execute({ op: 'sound-search' }));
ok('★ op=sound-search 不给 q → **不再报错**（是发现调用：给分类表 + 0 条音效，绝不给 1997 条）',
  emptyQ === null && soundFind.total === 0 && soundFind.items.length === 0);
const badCat = await errOfAsync(() => asset.execute({ op: 'sound-search', q: '宝箱', category: 99 }));
ok('★ op=sound-search 非法 category → 报错并列出合法 id', badCat !== null && /1 \/ 2 \/ 3/.test(badCat), String(badCat));
const got = await call({ op: 'sound-get', id: '50214' });
ok('op=sound-get：单条详情含 durationMs 与分类名',
  got.found === true && got.sound.durationMs === 4100 && got.sound.categoryName === '物件', JSON.stringify(got.sound));
ok('★ op=sound-get 体积检查：**没有**分类表 / `catalog` 元信息（本来就没冗余 ⇒ 不需要 `withMeta`；回执 < 400 B）',
  got.categories === undefined && got.catalog === undefined && got.categoriesOmitted === undefined
  && JSON.stringify(got).length < 400, JSON.stringify(got).length + ' B');
const notFound = await call({ op: 'sound-get', id: '99999' });
ok('op=sound-get：找不到**不抛错**，回 found:false + hint',
  notFound.found === false && /sound-search/.test(String(notFound.hint)));
ok('op=sound-get：id 为空 → 报错', (await errOfAsync(() => asset.execute({ op: 'sound-get' }))) !== null);
ok('★ 未知 op 明确报错（并列出全部 10 个 op）', await (async () => {
  const m = await errOfAsync(() => asset.execute({ op: 'nope' }));
  return m !== null && ['add', 'list', 'get', 'remove', 'rebuild', 'prune', 'stats', 'catalog', 'sound-search', 'sound-get']
    .every((o) => m.includes(o));
})(), String(await errOfAsync(() => asset.execute({ op: 'nope' }))));

/* ══════════════════════════════════════════════════ ④ 可重放层（镜像） */

console.log('\n--- ④ 可重放层（镜像目录：' + DEFAULT_SRC_DIR + '）');
const mirrorOk = fs.existsSync(path.join(DEFAULT_SRC_DIR, IMAGE_SOURCE.files.data));
if (!mirrorOk) {
  console.log('- 跳过镜像比对：没找到 ' + path.join(DEFAULT_SRC_DIR, IMAGE_SOURCE.files.data)
    + '（镜像是本地临时副本、不进仓库；没它就只跑前三层）');
} else {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const src = readSource(DEFAULT_SRC_DIR);
  const rebuilt = buildImageCatalog({ data: src.data, zh: src.zh, en: src.en, generatedAt: catalog.generatedAt });
  ok('★ 重建快照与仓库里那份**逐字节一致**（快照 = 生成脚本的产物）',
    serializeCatalog(rebuilt) === raw, (() => {
      const a = raw.split('\n'); const b = serializeCatalog(rebuilt).split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      return i < 0 ? '长度不同' : '第 ' + (i + 1) + ' 行起不同：' + String(a[i]).slice(0, 120) + ' ≠ ' + String(b[i]).slice(0, 120);
    })());
  ok('★ 逐条对账：1543 条的 分类 / 有没有图 与源目录一致（img 空 ⟺ imgExists=false）', (() => {
    /** @type {Map<number, any>} */
    const byId = new Map(Object.values(src.data.imageData).map((/** @type {any} */ x) => [Number(x.id), x]));
    for (const it of rebuilt.items) {
      const o = byId.get(it[0]);
      if (!o) return false;
      if (((it[2] & 1) === 1) !== (o.img !== '' && o.border !== '')) return false;
    }
    return true;
  })());
  ok('★ 逐条对账：颜色档 == 它所属分类的档（官方名口径），没有一条例外', (() => {
    const kindOfCat = new Map(rebuilt.categories.map((c) => [c.id, c.colorKind]));
    return rebuilt.items.every((it) => rebuilt.colorKindCodes[it[3]] === kindOfCat.get(it[1]));
  })());
  ok('★ 分类名与 zh / en 词表逐项一致', rebuilt.categories.every((c) => c.nameZh === src.zh[String(c.id)]
    && c.nameEn === src.en[String(c.id)]));
  ok('镜像的 `img` 字段确实可由 id 推出（丢路径是安全的）',
    Object.values(src.data.imageData).every((/** @type {any} */ x) => x.img === '' || x.img === 'sprite/' + x.id + '.png'));
}

/* ------------------------------------------------------------------ */

console.log('\n快照：' + path.relative(ROOT, CATALOG_PATH).split(path.sep).join('/')
  + '，' + catalog.itemCount + ' 条 / ' + catalog.categories.length + ' 类 / '
  + (fs.statSync(CATALOG_PATH).size / 1024).toFixed(1) + ' KB，generatedAt=' + catalog.generatedAt);
console.log('分类：' + catalog.categories.map((c) => `${c.id} ${c.nameZh}(${c.count}/${c.colorKind})`).join(' / '));

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length
  + (failures.length ? '：\n  - ' + failures.join('\n  - ') : '（全部通过）'));
process.exit(failures.length ? 1 : 0);
