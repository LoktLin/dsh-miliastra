/**
 * gilnodes.mjs — 从 `.gil` 里读**服务端节点图**与**关卡实体的自定义变量**（只读，一个字节都不写）。
 *
 * ★ 为什么有这个文件（作者 2026-10-01 需求）：「有时候我不知道服务端的节点图或者原件到底有没有正确挂载」
 *   —— 地图体检原来只看得见**客户端控件**与**脚本映射**，看不见节点图。这里补上。
 *
 * ★ **字段布局的来源（没有一处是猜的）**：
 *   ① 本机实测（`1073741839.gil`，899 360 字节，2026-10-01）：节点图在**顶层 #10**，
 *      `#10.#1[]` 每个条目是 `{ #1: { #1: {#1=origin,#2=service_domain,#3=kind,#5=runtime_id}, #2: 图名, #3: 图体 },
 *      #2: … }`；图体 `#3` 里 `#1` = 节点数、`#4` = 连线记录。
 *      关卡实体在**顶层 #5**：`#5[i].#1.#5[#1=1].#11` = 实体名；
 *      `#5[i].#1.#7[j].#11.#1[k]` = 一条 `GraphVariable`（`#2` 名字 / `#3` 类型 / `#4` 初值 / `#5` 是否公开）。
 *   ② 参考项目 `Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack-main`（**MIT**）的
 *      `utils/protobuf/gia.proto`：`NodeGraph.identity`（`ResourceLocator`，`service_domain=2` / `runtime_id=5`）、
 *      `GraphVariable{var_name=2, base_type=3, storage_value=4, is_public=5, schema_ref_id=6}`、
 *      `enum ServerTypeId`、以及 `utils/node_data/data.json` 的 `GRAPH_CATEGORY_CONSTS`
 *      （`ENTITY_NODE_GRAPH: {GraphCategory: 20000, GraphKind: 21001}`）。
 *      另一份参考项目 `genshin-ts-master`（MIT）在 `src/injector/node_graph.ts` 也读同一套字段（`10.1.1` + field 2/5），
 *      **两份独立实现互相印证** ⇒ 这里的字段号是有出处的，不是我反推出来的。
 *   ⇒ ⚠️ **但两份 `gia.proto` 本身都是逆向的**（文件里带「推测/TODO」）⇒ 凡是本机没实测到的取值，
 *      这里一律只回**原始数字**，不回"我猜的名字"（见 `labelsVerified` / `unverified`）。
 *
 * ★ 与 `gil.mjs` 的分工：那个文件管"关卡/控件/脚本映射"；这个文件只管"节点图 + 变量"。
 *   两个都建立在 `wire.mjs` 的 `parseMessage`（无 schema 的 protobuf 走查）之上。
 */

import fs from 'node:fs';
import { findProtobufRoot } from './wire.mjs';

/** 节点图类型：`identity.service_domain`。**取值来自参考项目 `gia.proto` 的注释 + data.json**（未在真机逐个验证）。 */
export const GRAPH_TYPES = {
  20000: '关卡实体图',
  20001: '客户端布尔过滤器图',
  20002: '客户端技能图',
  20003: '状态图',
  20004: '职业图',
  20005: '道具图',
  20006: '客户端整数过滤器图',
  20007: '客户端（20007）',
  20008: '客户端（20008）',
  20009: '客户端（20009）',
  20010: '客户端（20010）',
};

/** 图 ID 段（`data.json` 的 `GRAPH_ID_RANGE`）—— 用来判断"这张图是服务端还是客户端还是复合体"。 */
export const GRAPH_ID_RANGES = [
  { from: 1073741824, to: 1082130431, label: '服务端' },
  { from: 1082130432, to: 1610612735, label: '客户端' },
  { from: 1610612736, to: 2147483647, label: '复合体' },
];

/** 变量类型：参考项目 `gia.proto` 的 `enum ServerTypeId`（**本机实测交叉验证过 3/4/6/8/11** 这五个）。 */
export const VAR_TYPES = {
  0: '未知(0)', 1: '实体', 2: 'GUID', 3: '整数', 4: '布尔', 5: '浮点', 6: '字符串',
  7: 'GUID 列表', 8: '整数列表', 9: '布尔列表', 10: '浮点列表', 11: '字符串列表',
  12: '三维向量', 13: '实体列表', 14: '枚举项', 15: '向量列表', 17: '阵营', 18: '枚举列表',
  20: '配置表引用', 21: '预制体引用', 22: '配置列表', 23: '预制体列表', 24: '阵营列表', 25: '结构体',
};
/** 本机实测**确证**过的变量类型号（其余只是"proto 里这么写"，未在真机逐个核对）。 */
export const VAR_TYPES_VERIFIED = [3, 4, 6, 8, 11];

const uv = (bs) => {
  if (!bs || !bs.length) return null;
  const b = Buffer.isBuffer(bs) ? bs : Buffer.from(bs);
  const s = b.toString('utf8');
  if (s.includes('\uFFFD')) return null;
  const t = s.trim();
  if (!t || !/^[\x20-\x7e\u3000-\u9fff\uff00-\uffef]+$/.test(t)) return null;
  return t;
};
const kids = (f, no) => (f && f.sub ? f.sub.filter((x) => x.no === no) : []);
const one = (f, no) => kids(f, no)[0] || null;
const numOf = (f, no) => { const g = one(f, no); return g && g.wt === 0 ? Number(g.value) : null; };
const txtOf = (f, no) => { const g = one(f, no); return g && g.wt === 2 ? uv(g.value) : null; };

/** 图 ID 落在哪一段（服务端 / 客户端 / 复合体）。 */
export function graphIdRange(id) {
  if (!Number.isFinite(id)) return null;
  const hit = GRAPH_ID_RANGES.find((r) => id >= r.from && id <= r.to);
  return hit ? hit.label : null;
}

/**
 * 读**节点图**（顶层 `#10.#1[]`）。
 * 每条给：`name` / `typeCode`(+`typeLabel`) / `kindCode` / `id` / `nodeCount` / `linkCount` / `portRefs`。
 * ⚠️ `nodeCount` 取**图体自己声明的 `#1`**（不是我们数出来的）；`linkCount` 是数出来的 `#4` 条数。
 */
export function readNodeGraphs(top, { limit = 40 } = {}) {
  const region = (top || []).filter((f) => f.no === 10)[0];
  const out = { graphs: [], kinds: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #10（节点图区）—— 可能这张图一个节点图都没有'); return out; }
  const items = kids(region, 1);
  out.regionBytes = region.value ? region.value.length : null;
  let n = 0;
  for (const item of items) {
    if (n >= limit) { out.truncated = items.length - limit; break; }
    const inner = one(item, 1);
    if (!inner) continue;
    const identity = one(inner, 1);
    const body = one(inner, 3);
    const id = identity ? numOf(identity, 5) : null;
    const typeCode = identity ? numOf(identity, 2) : null;
    const kindCode = identity ? numOf(identity, 3) : null;
    const name = txtOf(inner, 2);
    if (!name && id == null) continue; // 既没名字也没 id ⇒ 不是一条图记录
    out.graphs.push({
      name: name || '(无名)',
      id,
      idRange: graphIdRange(id),
      typeCode,
      typeLabel: GRAPH_TYPES[typeCode] || (typeCode == null ? null : `未知类型 ${typeCode}`),
      kindCode,
      nodeCount: body ? numOf(body, 1) : null,
      linkCount: body ? kids(body, 4).length : null,
      portRefs: body ? kids(body, 2).length + kids(body, 3).length : null,
      hasBody: !!body,
    });
    n++;
  }
  // 按类型分组（作者要求「注意区分各个类型的节点图」）
  const byType = new Map();
  for (const g of out.graphs) {
    const k = g.typeCode == null ? -1 : g.typeCode;
    if (!byType.has(k)) byType.set(k, { typeCode: g.typeCode, typeLabel: g.typeLabel, count: 0, nodeTotal: 0, names: [] });
    const a = byType.get(k);
    a.count++;
    a.nodeTotal += g.nodeCount || 0;
    if (a.names.length < 6) a.names.push(g.name);
  }
  out.kinds = [...byType.values()].sort((a, b) => b.count - a.count);
  out.graphCount = out.graphs.length;
  const unknownTypes = out.graphs.filter((g) => g.typeCode != null && !GRAPH_TYPES[g.typeCode]).map((g) => g.typeCode);
  if (unknownTypes.length) out.unverified.push('这些图类型号不在已知表里（原样回，不编名字）：' + [...new Set(unknownTypes)].join(', '));
  return out;
}

/**
 * ★ **种类号 → 分类名**的对照（2026-10-01 真机验出来的）：来源是**资源分类树 `#6`** ——
 * 分类名写着「玩家模版」「职业」的那些条目，其 `ref.id` **就是实体种类号**：
 *   `typeValue 9「玩家模版」→ 1086324737`（= 那 9 个「默认模版」实体的种类号）
 *   `typeValue 10「职业」→ 1090519041`（= 「默认模版(角色编辑)」实体 + `#15` 的「自定义职业」）
 * ⇒ 这三条互相印证（分类名 / 资源 id / 实体种类号 同一个号），所以这部分可以**当证据用**，
 *   回执里给 `kindLabel` + `kindLabelSource`（出处写清楚）。**没出处的号照旧进 `unverified`。**
 */
export function kindLabelsFromTree(top) {
  const tree = readResourceTree(top);
  const map = new Map();
  for (const e of tree.entries) {
    if (e.ref && e.ref.id != null && e.category) {
      const list = map.get(e.ref.id) || [];
      if (!list.includes(e.category)) list.push(e.category);
      map.set(e.ref.id, list);
    }
  }
  return map;
}

/**
 * 读**实体表**（顶层 `#5`）——含**种类号 / 组件槽 / 自定义变量**（作者要点 1「元件和实体的区别」、要点 2「玩家/角色/职业实体」）。
 *
 * 实测结构（本机 `1073741839.gil`，11 条）：
 *   `#5.#1[i]` = 一个实体：`#1`=实体 id、`#2 { #1 = 种类号 }`、`#8` = 种类号回显、
 *   `#5[]` = 组件/字段槽（`#1=1` 那条的 `#11` 是**名字**；其余各带自己的组件号）、`#7[].#11.#1[]` = 自定义变量。
 *
 * ⚠️ **种类号的语义（哪些=玩家实体/角色实体/职业实体/元件）本机没确证** —— 所以：
 *   这里只回 `kindCode` / `kindEcho` / `componentSlots` 这些**原始事实**，`roleGuess` 一律标 `guess:true`，
 *   且只在「名字里明说」时才给（例如名字含「模版」⇒ 记为模版/元件实例）。**不替游戏下定义。**
 */
export function readEntities(top, { limit = 30, withVariables = false } = {}) {
  const out = { entities: [], unverified: [] };
  const regions = (top || []).filter((f) => f.no === 5);
  if (!regions.length) { out.unverified.push('这份 .gil 里没有顶层 #5（实体表）'); return out; }
  const all = [];
  const labelMap = kindLabelsFromTree(top);
  for (const region of regions) {
    for (const e of kids(region, 1)) {
      const id = numOf(e, 1);
      const kindWrap = one(e, 2);
      // 实测 `#2 { #1 = 种类号, #2 = 1 }` ⇒ 种类号就是 `#2.#1` 这个 varint（别再往里钻一层）
      const kindCode = kindWrap ? numOf(kindWrap, 1) : null;
      let name = null;
      const slots = [];
      for (const s5 of kids(e, 5)) {
        const slotNo = numOf(s5, 1);
        if (slotNo === 1) { const t = txtOf(s5, 11); if (t && !name) name = t; }
        else if (slotNo != null) slots.push(slotNo);
      }
      const vars = [];
      let varGroupCount = 0;
      for (const s7 of kids(e, 7)) {
        const s11 = one(s7, 11);
        if (!s11) continue;
        varGroupCount++;
        for (const it of kids(s11, 1)) {
          const vname = txtOf(it, 2);
          if (!vname) continue;
          const typeCode = numOf(it, 3);
          const wrap = one(it, 4);
          const valueFieldNo = wrap ? (wrap.sub || []).filter((x) => x.no > 2).map((x) => x.no)[0] : null;
          const valField = wrap && valueFieldNo != null ? one(wrap, valueFieldNo) : null;
          vars.push({
            name: vname, typeCode,
            typeLabel: VAR_TYPES[typeCode] || (typeCode == null ? null : `未知类型 ${typeCode}`),
            typeVerified: VAR_TYPES_VERIFIED.includes(typeCode),
            isPublic: numOf(it, 5),
            hasDefault: !!(valField && valField.value && valField.value.length > 0),
          });
        }
      }
      if (id == null && !name && !vars.length && !slots.length) continue;
      const roleGuess = name && /模版|模板/.test(name) ? { role: '模版/元件实例', guess: true, why: '名字里带「模版」' } : null;
      // 标签优先级：资源分类树（有出处）> 实体自己的名字就叫这个（如「关卡实体」）
      // 命中优先级：种类号（#2.#1）> 回显号（#8）。**出处字符串必须写真正命中的那个号**，否则会误导。
      const hitId = labelMap.has(kindCode) ? kindCode : (labelMap.has(numOf(e, 8)) ? numOf(e, 8) : null);
      const fromTree = hitId == null ? [] : labelMap.get(hitId);
      const kindLabel = fromTree.length ? fromTree[0]
        : (name === '关卡实体' ? '关卡实体' : null);
      const kindLabelSource = fromTree.length
        ? '资源分类树（#6）：分类名「' + fromTree[0] + '」的 ref id = ' + hitId
          + (hitId !== kindCode ? '（匹配的是回显号 #8）' : '')
        : (name === '关卡实体' ? '实体自己的名字就是「关卡实体」' : null);
      all.push({
        id,
        name: name || '(无名)',
        kindCode,
        kindEcho: numOf(e, 8),
        componentSlots: slots,
        componentCount: slots.length,
        variableGroupCount: varGroupCount,
        variableCount: vars.length,
        ...(withVariables ? { variables: vars } : {}),
        ...(roleGuess ? { roleGuess } : {}),
        ...(kindLabel ? { kindLabel, kindLabelSource } : {}),
      });
    }
  }
  all.sort((a, b) => (b.variableCount - a.variableCount) || String(a.name).localeCompare(String(b.name)));
  out.entities = all.slice(0, limit);
  out.entityCount = all.length;
  out.totalVariables = all.reduce((s, e) => s + e.variableCount, 0);
  // 只收**种类号**（kindCode）；`#8` 是回显，不混进"有没有出处"的判断（它照旧原样回）
  const kinds = [...new Set(all.map((e) => e.kindCode).filter((x) => x != null))];
  out.kindCodes = kinds;
  out.kindLabels = {};
  for (const k of kinds) { const l = labelMap.get(k); if (l && l.length) out.kindLabels[k] = l[0]; }
  out.kindLabelsUnverified = kinds.filter((k) => !(labelMap.get(k) || []).length);
  const badTypes = [...new Set(all.flatMap((e) => (e.variables || [])).filter((v) => v.typeCode != null && !VAR_TYPES_VERIFIED.includes(v.typeCode)).map((v) => v.typeCode))];
  if (badTypes.length) out.unverified.push('这些变量类型号没在本机确证过（只按参考项目 gia.proto 的 ServerTypeId 给名）：' + badTypes.join(', '));
  if (out.kindLabelsUnverified.length) {
    out.unverified.push('这些实体种类号**还没出处**（原样回号，不编名字）：' + out.kindLabelsUnverified.join(' / ')
      + '；已有出处的：' + Object.entries(out.kindLabels).map(([k, v]) => k + '=' + v).join(' / ')
      + '（来源 = 资源分类树 #6 的分类名 + ref id 命中）');
  }
  return out;
}

/**
 * 读**元件区**（顶层 `#4`）——模型 / 骨骼 / 音效 / 特效那类"原件"（作者要点 1 的另一半）。
 * 实测：3 个条目，条目内按 `#6` / `#7` / `#8` 分组（骨骼挂点、音效、特效…），名字在深一层。
 */
export function readComponents(top, { limit = 40 } = {}) {
  const region = (top || []).find((f) => f.no === 4);
  const out = { components: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #4（元件区）'); return out; }
  let i = 0;
  for (const item of kids(region, 1)) {
    if (i >= limit) { out.truncated = true; break; }
    // 名字：条目内**任意一层**里 `#2` 位置的可读短串（实测「默认模版」「默认模版(角色编辑)」就在这儿）
    const found = [];
    (function walk(f, d) {
      if (d > 3 || found.length > 40) return;
      for (const g of f.sub || []) {
        if (g.wt !== 2) continue;
        const t = uv(g.value);
        if (t && t.length <= 32) found.push(t);
        else walk(g, d + 1);
      }
    })(item, 0);
    const groups = {};
    for (const g of item.sub || []) groups[g.no] = (groups[g.no] || 0) + 1;
    out.components.push({
      index: i,
      name: found[0] || '(无名)',
      bytes: item.value.length,
      groups,
      sample: [...new Set(found)].slice(0, 6),
    });
    i++;
  }
  out.componentCount = out.components.length;
  out.unverified.push('元件区（`#4`）的**分组语义**（哪个字段=骨骼挂点 / 音效 / 特效）本机没确证 —— 只给字段号与计数，名字取条目内第一个可读短串');
  return out;
}

/**
 * 读**节点声明表**（顶层 `#10.#4`，本机 88 条）—— 作者要点 4：「我导入了一堆预制的自定义节点，看看能不能全部读取」。
 *
 * 实测每条 = `#1 { #1 { #1,#2,#3,#5=<声明 id> }, #3 {端口/连线}, … }`：
 *   `#1.#1.#5` = 声明 id（`>=1610612736` 是**复合节点**段；本机 1 条复合 + 87 条服务端段），
 *   `#1.#1.#2/#3` = domain/kind（本机全是 `20000/21002`）。
 * 条目里可读的串分两类：**短串**（端口名 / 参数名 / 作者写的短注释，如「侦_名声」「数值」）与**长串**（作者写的说明，如
 * 「由于负载消耗太高，基本没有实际意义；留着引以为戒。」）。
 *
 * ⚠️ **读不出来的那件事要说清**：`id → 官方节点名`（"这个号是『获取自定义变量』"）**不在 `.gil` 里** ——
 *   那在游戏资源/官方节点库里。本机 88 条中 **64 条能取到短串、49 条能取到说明**，但它们是**端口/注释**，不是节点名。
 *   要 id→名字，得另接一份节点库（参考项目 `Genshin-Impact-...-Pack` 的 `node_data/data.json` 有 500+ 条定义，**MIT**）
 *   —— 那是"导入一份库"，不是"从 .gil 读出来"；这句也写进 `unverified`。
 */
export function readNodeDeclarations(top, { limit = 300, labelLimit = 6 } = {}) {
  const region = (top || []).find((f) => f.no === 10);
  const out = { declarations: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #10（节点图区）'); return out; }
  const items = kids(region, 4);
  if (!items.length) { out.unverified.push('这份 .gil 里没有 `#10.#4`（节点声明表）—— 这张图可能没用到任何节点'); return out; }
  let i = 0;
  for (const item of items) {
    if (i >= limit) { out.truncated = items.length - limit; break; }
    const inner = one(item, 1);
    const idMsg = inner ? one(inner, 1) : null;
    const id = idMsg ? numOf(idMsg, 5) : null;
    const labels = [];
    const notes = [];
    (function walk(f, d) {
      if (d > 5 || labels.length + notes.length > 60) return;
      for (const g of f.sub || []) {
        if (g.wt !== 2) continue;
        const s = uv(g.value);
        if (s) { if (s.length <= 24) { if (!labels.includes(s)) labels.push(s); } else if (!notes.includes(s)) notes.push(s); }
        else walk(g, d + 1);
      }
    })(inner || item, 0);
    out.declarations.push({
      id,
      domain: idMsg ? numOf(idMsg, 2) : null,
      kindCode: idMsg ? numOf(idMsg, 3) : null,
      isComposite: id != null && id >= 1610612736,
      bytes: item.value.length,
      labels: labels.slice(0, labelLimit),
      notes: notes.sort((a, b) => b.length - a.length).slice(0, 2),
    });
    i++;
  }
  out.declarationCount = out.declarations.length;
  out.compositeCount = out.declarations.filter((d) => d.isComposite).length;
  out.withLabels = out.declarations.filter((d) => d.labels.length).length;
  out.withNotes = out.declarations.filter((d) => d.notes.length).length;
  out.unverified.push('`id → 官方节点名` **不在 .gil 里**（那是游戏资源/官方节点库）：这里能读的是**声明 id + 端口名/参数名 + 作者注释**'
    + '（本机 ' + out.withLabels + '/' + out.declarationCount + ' 条有短串、' + out.withNotes + ' 条有说明）；'
    + '要把 id 翻成节点名，得另接一份节点库（参考项目 Pack 的 `node_data/data.json`，MIT，500+ 条）—— 那是"导库"，不是"读地图"。');
  return out;
}

/**
 * 读**配置条目表**（顶层 `#15`，本机 8 条）—— 职业 / 成长曲线 / 连段 / 状态 / 环境 / 背包模板（作者要点 2、3）。
 *
 * 实测每条 = `#1[i] { #1=<条目 id>, #2=…, #4=<内容> }`，名字在 `#4.#11.#1` 那一层（如「自定义职业」「新建状态」）。
 * ★ **能确证的关联**（本机实测）：`自定义职业` 的 id 与 `#5` 里那个「默认模版(角色编辑)」实体 id **相同**
 *   （`1090519041`）⇒ 这个职业绑在那个模版实体上。函数会把这种"id 命中实体表"的条目标 `linkedEntity`。
 * ⚠️ **条目里的字段语义**（哪些是成长曲线数值 / 连段参数）**没确证** ⇒ 只回 id/名字/字节/可读关键串。
 */
export function readConfigEntries(top, { limit = 40, keywordLimit = 8 } = {}) {
  const region = (top || []).find((f) => f.no === 15);
  const out = { configs: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #15（配置条目表）'); return out; }
  const ents = readEntities(top, { limit: 99 }).entities;
  const entIds = new Map(ents.map((e) => [e.id, e.name]));
  let i = 0;
  for (const item of kids(region, 1)) {
    if (i >= limit) { out.truncated = true; break; }
    const id = numOf(item, 1);
    const labels = [];
    (function walk(f, d) {
      if (d > 5 || labels.length > 40) return;
      for (const g of f.sub || []) {
        if (g.wt !== 2) continue;
        const s = uv(g.value);
        if (s && s.length <= 28) { if (!labels.includes(s)) labels.push(s); } else if (!s) walk(g, d + 1);
      }
    })(item, 0);
    out.configs.push({
      index: i,
      id,
      name: labels[0] || '(无名)',
      bytes: item.value.length,
      keywords: labels.slice(1, 1 + keywordLimit),
      linkedEntity: entIds.has(id) ? { id, name: entIds.get(id) } : null,
    });
    i++;
  }
  out.configCount = out.configs.length;
  const linked = out.configs.filter((c) => c.linkedEntity);
  out.linked = linked.map((c) => c.name + ' ↔ 实体 ' + c.linkedEntity.name + '(' + c.id + ')');
  out.unverified.push('配置条目（`#15`）的**字段语义**（成长曲线数值 / 连段参数 / 状态参数分别是哪个字段）**没确证** —— '
    + '只回 id / 名字 / 字节数 / 可读关键串；**能确证的只有**："条目 id 命中实体表"这种关联（本机 ' + linked.length + ' 条）。');
  return out;
}

/** 读**阵营 / 出生点 / 预设点**（顶层 `#11`，本机 353B）。名字就在 `#2` / `#3` / `#5` 的字符串里。 */
export function readFactions(top) {
  const region = (top || []).find((f) => f.no === 11);
  const out = { factions: [], spawns: [], presets: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #11（阵营/出生点）'); return out; }
  const collect = (no) => kids(region, no).flatMap((x) => { const s = []; (function w(f, d) { if (d > 3 || s.length > 12) return; for (const g of f.sub || []) { if (g.wt !== 2) continue; const t2 = uv(g.value); if (t2) s.push(t2); else w(g, d + 1); } })(x, 0); return [...new Set(s)]; });
  out.factions = collect(2);
  out.spawns = collect(3);
  out.presets = collect(5);
  const marked = out.factions.filter((s) => /Faction/.test(s));
  out.unverified.push('阵营（`#11.#2`）给的是**名字串**（如「初始玩家阵营」+ 对应的 `UI_MarkPlayer_Faction_0`）；'
    + '**号 ↔ 阵营编号的对应关系**没确证（本机见到 ' + marked.length + ' 个 UI 标记串）');
  return out;
}

/**
 * 读**资源分类树**（顶层 `#6`，本机 43 条）：每条 = `{ typeValue(#1), 父(#2.{#1 名字,#3}), 分类(#3.{#1 名字, #5.{#1,#2=资源 id}}) }`。
 * 实测能把「默认 → 环境配置(1186988033)」「未分类页签 → 1077936130」这种 **分类 ↔ 资源 id** 对上。
 */
export function readResourceTree(top, { limit = 80 } = {}) {
  const region = (top || []).find((f) => f.no === 6);
  const out = { entries: [], categories: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #6（资源分类树）'); return out; }
  let i = 0;
  for (const item of kids(region, 1)) {
    if (i >= limit) { out.truncated = true; break; }
    const typeValue = numOf(item, 1);
    const parentWrap = one(item, 2);
    const catWrap = one(item, 3);
    const parent = parentWrap ? txtOf(parentWrap, 1) : null;
    const category = catWrap ? txtOf(catWrap, 1) : null;
    const ref = catWrap ? one(catWrap, 5) : null;
    out.entries.push({ typeValue, parent, category, ref: ref ? { hi: numOf(ref, 1), id: numOf(ref, 2) } : null });
    if (category && !out.categories.includes(category)) out.categories.push(category);
    i++;
  }
  out.entryCount = out.entries.length;
  out.unverified.push('资源分类树（`#6`）给的是 **typeValue → 分类名 → 资源 id**；'
    + '`typeValue` 与"这条是玩家模版 / 职业 / 图"的**对应关系**没确证（本机 "玩家模版"/"职业" 这两个词只在别的区出现）');
  return out;
}

/**
 * 读**信号 / 节点参数引用表**（顶层 `#10.#2`，本机 136 条）—— 参考项目里信号声明走的就是 `10.2.1 + field 1`（同一路径）。
 *
 * 实测每条 = `#10.#2[i].#1 { #4 端口, #100/#101 参数槽, #200/#201 文本 … }`，可读串里有「信号名」「向服务器节点图发送信号」
 * 「目标玩家」「侦_字符串列表_新增」这类**端口名 / 参数名 / 信号相关词**。
 * ⚠️ **哪一段是"信号名"本机没确证**（名字字段与 `SignalSignature` 的对应关系只有参考项目源码侧面印证）⇒
 *   只回**条目数 + 可读串**，并在 `unverified` 里说清。**不编语义。**
 */
export function readSignalRefs(top, { limit = 200, labelLimit = 4 } = {}) {
  const region = (top || []).find((f) => f.no === 10);
  const out = { refs: [], unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #10（节点图区）'); return out; }
  const items = kids(region, 2);
  if (!items.length) { out.unverified.push('这份 .gil 里没有 `#10.#2`（信号/参数引用表）'); return out; }
  const words = new Set();
  let i = 0;
  for (const item of items) {
    if (i >= limit) { out.truncated = items.length - limit; break; }
    const inner = one(item, 1) || item;
    const labels = [];
    (function walk(f, d) {
      if (d > 4 || labels.length > 24) return;
      for (const x of f.sub || []) {
        if (x.wt !== 2) continue;
        const s = uv(x.value);
        if (s && s.length <= 24) { labels.push(s); words.add(s); } else if (!s) walk(x, d + 1);
      }
    })(inner, 0);
    out.refs.push({ index: i, bytes: item.value.length, labels: [...new Set(labels)].slice(0, labelLimit) });
    i++;
  }
  out.refCount = out.refs.length;
  out.words = [...words].slice(0, 60);
  const signalish = [...words].filter((w) => /信号/.test(w));
  out.signalWords = signalish.slice(0, 20);
  out.unverified.push('信号/参数引用表（`#10.#2`，本机 ' + out.refCount + ' 条）**哪一段是"信号名"没确证** —— '
    + '只回条目数 + 可读串（本机含「信号」字样的串 ' + signalish.length + ' 个，如 ' + signalish.slice(0, 3).map((s) => '「' + s + '」').join('') + '）；'
    + '要"信号名 ↔ 图"的对应，得先在真机上钉字段（参考项目 `gil_signals.ts` 的路子是 `10.2.1 + field 1` 的 `SignalSignature`）。');
  return out;
}

/**
 * 语义判定（作者要点 2、3 的"钉语义"）：把**资源分类树** `#6` 的每条 `ref id` 拿去和
 * 实体种类号 / 节点图 id / 节点声明 id / 配置条目 id **逐个对照**，判出"这个号是什么"。
 *
 * ★ 已确证的两条（本机实测，三处同一号）：
 *   `typeValue 9「玩家模版」→ 1086324737`（9 个「默认模版」实体的种类号）；
 *   `typeValue 10「职业」→ 1090519041`（「默认模版(角色编辑)」实体 + `#15`「自定义职业」）。
 * ⚠️ 本关的分类名里**只有这两个**有语义；其余多是「未分类页签 / 默认分类」占位名 ⇒ **占位名不当作语义**。
 *   所以「玩家实体 / 角色实体 / 单位状态」在本关 `.gil` 里**没有分类名可依**（只作节点端口名出现）——
 *   那几个词的**官方定义**去节点词典查（`miliastra_map op=nodedb`）。
 */
export function analyzeGilSemantics(top) {
  const tree = readResourceTree(top);
  const graphs = readNodeGraphs(top, { limit: 100 }).graphs;
  const ents = readEntities(top, { limit: 100 }).entities;
  const decls = readNodeDeclarations(top, { limit: 400 }).declarations;
  const cfgs = readConfigEntries(top, { limit: 100 }).configs;

  // ⚠️ 同一个号可能**同时**属于多类（实测 1090519041 既是「职业」实体种类号、又是 #15 的「自定义职业」配置条目）
  //    ⇒ 用数组收全部命中，别让后面的 set 把前面的盖掉（那就成"只报一半"的错事实了）。
  const index = new Map();
  const add = (id, hit) => { if (id == null) return; const l = index.get(id) || []; l.push(hit); index.set(id, l); };
  for (const e of ents) add(e.kindCode, { kind: '实体种类号', name: e.kindLabel || e.name });
  for (const x of graphs) add(x.id, { kind: '节点图', name: x.name + (x.typeLabel ? '（' + x.typeLabel + '）' : '') });
  for (const d of decls) add(d.id, { kind: '节点声明', name: d.labels[0] || null });
  for (const c of cfgs) add(c.id, { kind: '配置条目', name: c.name });

  const rows = tree.entries.map((e) => {
    const refId = e.ref ? e.ref.id : null;
    const hits = refId != null ? (index.get(refId) || []) : [];
    return {
      typeValue: e.typeValue,
      category: e.category,
      refId,
      refKind: refId == null ? null : (hits.length ? hits[0].kind : '未识别'),
      refKinds: hits.map((h) => h.kind),
      refName: hits.length ? hits[0].name : null,
      refHits: hits.length > 1 ? hits : undefined,
    };
  });
  const meaningful = rows.filter((r) => r.category && !/^(未分类页签|默认分类|默认)$/.test(r.category));
  return {
    rows,
    meaningfulRows: meaningful,
    meaningCount: meaningful.length,
    rowCount: rows.length,
    categoryCount: new Set(rows.map((r) => r.category).filter(Boolean)).size,
    unverified: [
      '分类树里**有语义的分类名只有**「' + [...new Set(meaningful.map((r) => r.category))].join(' / ') + '」这些（本机）；'
        + '其余是「未分类页签 / 默认分类」占位名 —— 占位名**不当作语义**（不猜）。',
      '「玩家实体 / 角色实体 / 单位状态」在本关 `.gil` 里**没有分类名可依**（只作为节点端口名/信号词出现在 `#10.#2`、`#10.#4`）⇒ '
        + '它们的官方定义请查节点词典：miliastra_map op=nodedb（如 `248 获取在场玩家实体列表`、`258 获取指定玩家所有角色实体`、`297 添加单位状态`）。',
    ],
  };
}

/**
 * 一步到位：从 `.gil` 文件读出「节点图 + 实体自定义变量 + 一行 tag」。
 * 只读、不写、不调任何平台 API（作者要的是"不知道有没有挂载"时能**当场看一眼**）。
 */
export function readGilNodeFacts(file, { graphLimit = 40, entityLimit = 30, withVariables = false } = {}) {
  const buf = fs.readFileSync(file);
  const root = findProtobufRoot(buf);
  if (!root) return { ok: false, file, size: buf.length, error: '解析失败：找不到 protobuf 主体' };
  const graphs = readNodeGraphs(root.fields, { limit: graphLimit });
  const ents = readEntities(root.fields, { limit: entityLimit, withVariables });
  const comps = readComponents(root.fields);
  const decls = readNodeDeclarations(root.fields, { labelLimit: 3 });
  const configs = readConfigEntries(root.fields);
  const factions = readFactions(root.fields);
  const tree = readResourceTree(root.fields);
  const sigs = readSignalRefs(root.fields);
  const sem = analyzeGilSemantics(root.fields);
  return {
    ok: true,
    file,
    size: buf.length,
    graphs: graphs.graphs,
    graphCount: graphs.graphCount,
    kinds: graphs.kinds,
    entities: ents.entities,
    entityCount: ents.entityCount,
    totalVariables: ents.totalVariables,
    entityKindCodes: ents.kindCodes || [],
    entityKindLabels: ents.kindLabels || {},
    entityKindLabelsUnverified: ents.kindLabelsUnverified || [],
    components: comps.components,
    componentCount: comps.componentCount,
    declarationCount: decls.declarationCount,
    compositeCount: decls.compositeCount,
    declarationLabels: decls.declarations.filter((d) => d.labels.length).slice(0, 6).map((d) => ({ id: d.id, labels: d.labels.slice(0, 3), composite: d.isComposite })),
    declarations: decls.declarations,
    declarationStats: { withLabels: decls.withLabels, withNotes: decls.withNotes },
    configCount: configs.configCount,
    configs: configs.configs,
    configLinked: configs.linked,
    factions: factions.factions,
    spawns: factions.spawns,
    presets: factions.presets,
    resourceTree: tree.entries,
    resourceCategories: tree.categories,
    semantics: sem.rows,
    semanticMeaningful: sem.meaningfulRows,
    semanticMeaningCount: sem.meaningCount,
    signalRefCount: sigs.refCount,
    signalWords: sigs.signalWords,
    signalRefs: sigs.refs,
    unverified: [...graphs.unverified, ...ents.unverified, ...comps.unverified, ...decls.unverified, ...configs.unverified, ...factions.unverified, ...tree.unverified, ...sigs.unverified, ...sem.unverified],
    brief: briefLine(graphs.graphs, { entityCount: ents.entityCount, totalVariables: ents.totalVariables, entities: ents.entities },
      { componentCount: comps.componentCount, declarationCount: decls.declarationCount, compositeCount: decls.compositeCount }),
  };
}

/**
 * 一行「粗略展示」——给 tag / 面板 / 回执用（作者 2026-10-01：「增加一个 tag，针对节点图做粗略展示」）。
 * 形如：`[节点图] 2 个（关卡实体图 2：关卡实体信号(9节点) · 玩家自身(0节点)）`
 */
export function briefLine(graphs = [], entityVars = {}, extra = {}) {
  const cnt = (x) => (x.hasBody === false ? '无图体'
    : (x.nodeCount == null ? '?' : x.nodeCount) + '节点' + (x.linkCount ? '/' + x.linkCount + '连线' : ''));
  const g = graphs.slice(0, 4).map((x) => x.name + '(' + cnt(x) + ')').join(' · ');
  const more = graphs.length > 4 ? ' …共 ' + graphs.length + ' 个' : '';
  const kinds = {};
  for (const x of graphs) { const k = x.typeLabel || '未知'; kinds[k] = (kinds[k] || 0) + 1; }
  const kindStr = Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(' / ');
  const ent = entityVars.entityCount
    ? '　｜　[实体] ' + entityVars.entityCount + ' 个（自定义变量共 ' + entityVars.totalVariables + ' 个'
      + (entityVars.entities && entityVars.entities[0] ? '，最大 ' + entityVars.entities[0].name + ' ' + entityVars.entities[0].variableCount + ' 个' : '') + '）'
    : '';
  const comp = extra.componentCount ? '　｜　[元件] ' + extra.componentCount + ' 个' : '';
  const decl = extra.declarationCount ? '　｜　[节点声明] ' + extra.declarationCount + ' 条（复合 ' + (extra.compositeCount || 0) + '）' : '';
  if (decl) { /* 见上：拼在实体/元件之后 */ }
  return '[节点图] ' + graphs.length + ' 个' + (kindStr ? '（' + kindStr + '：' : '（') + (g || '（空）') + more + '）' + ent + comp + decl;
}
