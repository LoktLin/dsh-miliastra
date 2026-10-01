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
import { nodeById } from './nodedb.mjs';

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
/**
 * ★ 名字的**深取**（2026-10-02 修「面板里一片 (无名)」）：
 * 实测有些实体的名字不是直接摆在 `#5[槽1].#11` 的字节里，而是 `#11` 里**再套一层**（`#11.#1` = 文本）；
 * 直接 `uv(#11 的字节)` 会把那一层的 tag 字节也当成文本 ⇒ 过不了可读性检查 ⇒ 名字丢掉（表现成「(无名)」）。
 * 这里：先直接试（清掉控制字符），不行就**往下钻 ≤3 层**找第一个可读串。
 */
const deepTxtOf = (f, depth) => {
  if (!f || f.wt !== 2) return null;
  const direct = uv(f.value);
  if (direct && direct.length) return direct;
  if ((depth || 0) > 3) return null;
  for (const g of f.sub || []) { const t = deepTxtOf(g, (depth || 0) + 1); if (t) return t; }
  return null;
};
/** 取 float32 字段（wire 对 wt5 可能给 4 字节 Buffer，也可能已解成数字）—— 节点坐标 x/y 用。 */
const float32Of = (f, no) => {
  const g = one(f, no);
  if (!g || g.wt !== 5) return null;
  const v = g.value;
  if (Buffer.isBuffer(v)) return v.length === 4 ? v.readFloatLE(0) : null;
  return typeof v === 'number' ? v : null;
};

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
export function readNodeGraphs(top, { limit = 200 } = {}) {
  const region = (top || []).filter((f) => f.no === 10)[0];
  // ★ 计数先给 0：**早退路径**（没有 #10 区等）也必须回数字，不许 undefined（2026-10-02 修）
  const out = { graphs: [], kinds: [], graphCount: 0, unverified: [] };
  if (!region) { out.unverified.push('这份 .gil 里没有顶层 #10（节点图区）—— 可能这张图一个节点图都没有'); return out; }
  const items = kids(region, 1);
  out.regionBytes = region.value ? region.value.length : null;
  let n = 0;
  for (const item of items) {
    if (n >= limit) { out.truncated = items.length - limit; break; }
    const inner = one(item, 1);
    if (!inner) continue;
    const identity = one(inner, 1);
    // ⚠️ 字段 3 是**重复字段 = 节点列表**（不是「图体」）：图自己就是 inner，节点直接挂在它下面
    const nodeBlocks = kids(inner, 3);
    const body = nodeBlocks.length ? inner : null;
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
      // ⚠️ 节点数 = **字段 3 的块数**（两块错都在这：先把「第一个节点自己的 #1」当节点数，
      //   又把「第一个 #3（=第一个节点）」当成「图体」⇒ 节点数恒为 1。见 readGraphNodes 注释）
      nodeCount: nodeBlocks.length,
      // 连线数 = 各节点里字段 4 的记录条数之和（**疑似连线，语义未逐个确证** —— 回执 caveats 里明说）
      linkCount: nodeBlocks.reduce(function (s, b) { return s + kids(b, 4).length; }, 0),
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
  // ⚠️ **占位名不算语义**（实测新图里 1077936180 被标成「未分类页签」—— 那是编辑器占位分类，不是种类名）
  const PLACEHOLDER = /^(未分类页签|默认分类|默认|root)$/;
  for (const e of tree.entries) {
    if (e.ref && e.ref.id != null && e.category && !PLACEHOLDER.test(e.category)) {
      const list = map.get(e.ref.id) || [];
      if (!list.includes(e.category)) list.push(e.category);
      map.set(e.ref.id, list);
    }
  }
  return map;
}

/**
 * 读**一张图的节点列表**（作者 2026-10-01：「我想要每一个节点都能被点到，而不是总和」）。
 *
 * ★ 实测（本机 `1073741839.gil`）：图的 `#1` 里，**每个 `#3` 块 = 一个节点**：
 *   `#1` = 节点索引、`#2` = shell_ref（`ResourceLocator{origin, service_domain, kind, runtime_id}`）、
 *   `#3` = kernel_ref、`#4` = 引脚/连线记录、**`#5`/`#6` = float32 的 x / y 坐标**。
 *   ⇒ **节点数 = `#3` 块的个数**（⚠️ 不是第一个块里的 `#1` —— 那是**节点自己的索引**，
 *     我第一版就读错了这个，把"关卡实体信号"报成 9 个节点，实际 **2 个**；已修 + 回归钉住）。
 * ⚠️ `shell_ref/kernel_ref` 的 `#5`（runtime_id）就是**官方节点/复合节点的号**（如 `1610612789` 属复合体段）
 *   —— 但**官方名字**仍不在 `.gil` 里（去 `op=nodedb` 查；且词典 id 与这里的号不是一套，别混）。
 */
export function readGraphNodes(graphItem) {
  // 兼容两种调用：给「图条目」（#10.#1[i]，需再下一层）或直接给「图」（inner）。
  // ⚠️ 判据 = 「这个孩子里有没有字段 3 的块」：直接给 inner 时它的字段 1 是 identity，
  //   若按「有字段 1 就当条目」去拆，就会把 identity 当图 ⇒ 节点数恒为 1（踩过）。
  // 形态判据：**字段 2 是字符串（图名）** ⇒ 传进来的就是图；否则当条目，再往下走一层。
  const childOfItem = one(graphItem, 1);
  const inner = txtOf(graphItem, 2) ? graphItem : (childOfItem || graphItem);
  if (!inner || !inner.sub) return { nodes: [], nodeCount: 0 };
  const blocks = kids(inner, 3);
  const nodes = blocks.map((b, i) => {
    const shell = one(b, 2);
    const kernel = one(b, 3);
    const pinBlocks = kids(b, 4);
    const loc = (m) => (m ? { origin: numOf(m, 1), serviceDomain: numOf(m, 2), kind: numOf(m, 3), runtimeId: numOf(m, 5) } : null);
    /*
     * ★ 引脚与连线（2026-10-01 在 266 节点的图上钉出来，与 gia.proto 的 PinInstance/NodeConnection 一致）：
     *   每个字段 4 块 = **一个引脚实例**：字段 1/2 = 引脚签名（里面的字段 1 = kind 号），
     *   字段 5 = **连接**（可重复）：字段 1 = **目标节点索引**、字段 2/3 = 目标脚（shell/kernel）。
     *   实例：节点 0 → 7；节点 1 → 51 与 259 ⇒ 一个输出脚可以连多个目标。
     */
    const pins = pinBlocks.map((p) => {
      const conns = kids(p, 5).map((c) => ({
        to: numOf(c, 1),
        toShell: numOf(one(c, 2) || { sub: [] }, 1),
        toKernel: numOf(one(c, 3) || { sub: [] }, 1),
      }));
      const v = one(p, 3);
      return {
        kindShell: numOf(one(p, 1) || { sub: [] }, 1),
        kindKernel: numOf(one(p, 2) || { sub: [] }, 1),
        conns,
        valueRef: v ? numOf(one(v, 101) || { sub: [] }, 1) : null,
      };
    });
    const declaredIndex = numOf(b, 1);
    return {
      index: declaredIndex == null ? i : declaredIndex,
      declaredIndex,
      shellRef: loc(shell),
      kernelRef: loc(kernel),
      pins,
      pinCount: pins.length,
      outEdges: pins.flatMap((p) => p.conns.map((c) => ({ from: declaredIndex == null ? i : declaredIndex, to: c.to, toShell: c.toShell, toKernel: c.toKernel, fromPinKind: p.kindShell }))),
      extraBytes: (one(b, 7) || { value: null }).value ? one(b, 7).value.length : 0,
      pinRecordBytes: pinBlocks.reduce((s, x) => s + x.value.length, 0),
      // 引脚/值区（字段 4）里**能确证的事实**（语义未确证 ⇒ 不写"这是输入脚"这种话）：
      //   #1/#2 = 两个引脚签名的 kind 号；#4 = 引脚数；#3.#101 = 引用到的 id（可能是实体/图/声明）
      pinKinds: pinBlocks.map(function (p) { return numOf(one(p, 1) || { sub: [] }, 1); }).filter(function (x) { return x != null; }),
      refIds: pinBlocks.length ? (function () {
        const ids = [];
        (function walk(f, d) {
          if (d > 4 || ids.length > 12) return;
          for (const x of f.sub || []) {
            if (x.wt === 0 && x.value >= 1000000) ids.push(Number(x.value));
            if (x.sub) walk(x, d + 1);
          }
        })({ sub: pinBlocks }, 0);
        return [...new Set(ids)];
      })() : [],
      x: float32Of(b, 5),
      y: float32Of(b, 6),
    };
  });
  const edges = nodes.flatMap(function (n) { return n.outEdges || []; });
  return { nodes, nodeCount: nodes.length, edges, edgeCount: edges.length };
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
  const out = { entities: [], entityCount: 0, totalVariables: 0, unverified: [] };
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
        if (slotNo === 1) { const t = deepTxtOf(one(s5, 11), 0); if (t && !name) name = t; }
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

/** 在一棵子树里找**第一个可读短串**（深度 ≤ `maxDepth`）——场景物件/摆放实例的名字都是"套一层"的，直接解会拿到 tag 字节。 */
const firstNameIn = (fields, maxDepth) => {
  const out = [];
  (function walk(fs, d) {
    if (d > (maxDepth || 3) || out.length) return;
    for (const g of fs || []) {
      if (g.wt === 2) { const t = uv(g.value); if (t && t.length <= 32) out.push(t); else walk(g.sub, d + 1); }
      else walk(g.sub, d + 1);
    }
  })(fields, 0);
  return out[0] || null;
};

/**
 * ★ 2026-10-02 新增：**场景摆放物**（顶层 `#27`）与**摆放的元件实例**（顶层 `#8`）。
 *
 * 作者问「实体保守估计有 50 个、场景静态更多」时发现：面板当时只报 `#5` 实体表（12 条），
 * 而恐怖-V3 真正的"静态物件"在 `#27`：**1287 条**（名字形如「装饰物_N」，`#2` = 种类号、`#502` = 引用），
 * 另有 `#8` = **128 条摆放实例**（名字就是元件名，如「有鬼啊」「电视机」）。
 * ⇒ 这两块**必须单独计数并说出来**，否则"实体 12 个"会被读成"这张图只有 12 个东西"。
 *
 * 口径说明：`#27` 条目的 `#1` = 物件 id、`#2` = 种类号、`#502` = 引用 id（多半指向元件/实体）；
 * 名字是**自动生成的**（装饰物_N 之类）⇒ 别拿它当语义名。坐标疑似在 `#1`(wt5) 那串 float 里，**未确证**。
 */
export function readSceneObjects(top, { limit = 5000 } = {}) {
  const out = { sceneObjects: [], sceneObjectCount: 0, placedInstances: [], placedCount: 0, unverified: [] };
  const region27 = (top || []).find((f) => f.no === 27);
  const items27 = region27 && region27.sub ? region27.sub.filter((x) => x.no === 1) : [];
  for (const it of items27.slice(0, limit)) {
    out.sceneObjects.push({
      id: numOf(it, 1),
      kindCode: numOf(it, 2),
      refId: numOf(it, 502),
      // 名字是"套一层"的（实测 `#3.#11`）⇒ 用深取；它是**自动生成**的（装饰物_N），别当语义名
      name: firstNameIn(it.sub || [], 3),
    });
  }
  out.sceneObjectCount = items27.length;
  if (items27.length > limit) out.unverified.push('`#27` 场景物件超过上限 ' + limit + '，只列了前 ' + limit + ' 条');
  const region8 = (top || []).find((f) => f.no === 8);
  const items8 = region8 && region8.sub ? region8.sub.filter((x) => x.no === 1) : [];
  for (const it of items8.slice(0, limit)) {
    out.placedInstances.push({ id: numOf(it, 1), name: firstNameIn(it.sub || [], 3) });
  }
  out.placedCount = items8.length;
  if (!items27.length) out.unverified.push('这份 .gil 里没有顶层 `#27`（场景摆放物）');
  if (!items8.length) out.unverified.push('这份 .gil 里没有顶层 `#8`（摆放的元件实例）');
  if (items27.length) out.unverified.push('`#27` 的**字段语义未逐个确证**（`#1`/`#2`/`#502` 是按实测形状读的；坐标未确证）');
  return out;
}

/**
 * ★ 2026-10-02 新增：**顶层区地图**（"这都是啥"的答案）。
 * 每个顶层字段给：字节数、条目数（`#1` 的重复数）、子字段数、**样例可读串**、以及**已知区名**（我只认确证过的）。
 * ⚠️ 未确证的区一律标 `label: null` —— 不编名字（作者 2026-10-02：「实体也是 这都是啥」）。
 */
export function readRegionMap(top, { sampleLimit = 3 } = {}) {
  const KNOWN = {
    1: '关卡身份（level id / 版本号）',
    4: '元件区（元件定义）', 5: '实体表（逻辑实体）', 6: '元件分类树', 7: '地形 / 场景数据', 8: '摆放的元件实例',
    9: '界面控件组（疑似，未确证）', 10: '节点图区', 15: '配置条目', 27: '场景摆放物', 35: '成就 / 结算条件（疑似）',
    50: '脚本映射（内嵌 Lua 源码）',
  };
  const bytesOf = (f) => {
    if (f.wt !== 2) return 0;                                   // varint/fixed：没有"内容长度"这回事（原来是 NaN）
    const sub = (f.sub || []).reduce((s, x) => s + (x.value && x.value.length ? x.value.length : 0), 0);
    if (sub) return sub;
    return f.value && f.value.length ? f.value.length : 0;      // 解不成消息的裸 bytes（如 #27 里的二进制块）
  };
  const namesIn = (fields, max) => {
    const out = [];
    (function walk(fs, d) {
      if (d > 3 || out.length >= max) return;
      for (const g of fs || []) {
        if (g.wt === 2) { const t = uv(g.value); if (t && t.length <= 24) out.push(t); else walk(g.sub, d + 1); }
        else walk(g.sub, d + 1);
      }
    })(fields, 0);
    return out;
  };
  return (top || []).map((f) => {
    const items = (f.sub || []).filter((x) => x.no === 1);
    return {
      field: f.no,
      wt: f.wt,
      label: KNOWN[f.no] || null,
      bytes: bytesOf(f),
      itemCount: items.length,
      subFieldCount: (f.sub || []).length,
      sampleNames: namesIn(items.slice(0, sampleLimit).map((k) => k.sub || []).flat(), 5),
    };
  }).sort((a, b) => b.bytes - a.bytes);
}

/**
 * ★★ **节点图挂载对象**（`#5` 实体 / `#4` 元件 → 它们身上挂了哪些节点图）。
 *
 * ⚠️ **这条能力是作者 2026-10-02 给出编辑器「节点图挂载对象」面板之后补上的 —— 它推翻了我上一轮的结论。**
 *    上一轮我按"整棵树里找等于图 id 的数值"去搜，再用"同段随机号也会命中"证伪，就写下了"读不出来"。
 *    **错在口径**：号段确实重叠、裸数值确实不能当证据 —— 但**按结构路径**取是能读出来的，
 *    而且读出来的结果**与编辑器面板逐条对上**（判据见下）。
 *
 * 口径（本机实测；两个形状在编辑器里都表现为"这张图挂在这个对象上"）：
 *   · 实体记录 `#5[i]`：`#6.#13.#1[].#1.#2` = 挂载的节点图 id
 *   · 元件记录 `#4[i]`：`#7.#13.#1[].#1.#2` = 同上（`#7` 是"按槽号编排"的重复块，槽 N 的载荷字段号 = 10+N）
 *   ⇒ 通用规则：**`#13` 块下 repeated `#1` 项里的 `#2`**（值必须是本关的图 id）。
 *     挂载项里另有 `#1` = 序号、`#501` = 图类型号（实测 20000）。
 *   · 记录里**别处**出现的图 id（如 `#7.#27.#2.#6.#2`、`#7.#38.#501.#504.#2`、元件自己的 `#1`）口径**未确证**，
 *     单独放 `otherRefs`，**不混进 mounts**。
 *   · ⚠️ **哪些图不在这两个区**：技能图 / 状态图之类挂在"技能、职业、状态"这些**别的区**上，
 *     实体/元件区里找不到它们的挂载主（实测侦探1：19 张里只有「关卡实体信号」挂在关卡实体上）。
 *     要判"某张图有没有挂载主"必须**两个区都查完再下结论**，并且**明说**哪些没找到。
 *
 * @param {Array<any>} top `wire.parseMessage` 的顶层字段
 * @param {{graphIds?: Iterable<number>}} [opts] 本关的图 id 集合（不在集合里的数值一律不算）
 * @returns {{entities:Array<any>, components:Array<any>, mountedGraphIds:number[], unverified:string[]}}
 */
export function readGraphMounts(top, { graphIds } = {}) {
  const ids = new Set(graphIds || []);
  const out = { entities: [], components: [], mountedGraphIds: [], unverified: [] };
  if (!ids.size) { out.unverified.push('没给 graphIds ⇒ 无法判定"这个号是不是本关的节点图"，一律不猜'); return out; }
  const regionOf = (no) => (top || []).find((f) => f.no === no);
  const slotText = (rec, slotFieldNo) => {
    for (const s of kids(rec, slotFieldNo)) {
      if (numOf(s, 1) === 1) { const t = txtOf(s, 11); if (t) return t; }
    }
    return null;
  };
  /** 一个字段的数值（varint / fixed32；其余给 null）——`numOf` 是"容器 + 字段号"，这里要按字段本身取。 */
  const valOf = (f) => (f && f.wt === 0 ? Number(f.value) : (f && f.wt === 5 ? Buffer.from(f.value).readUInt32LE(0) : null));
  /** `#13` 块（可嵌套任意深度）→ 挂载项。实测形状：`#13.#1[].#1{ #1=序号, #2=图id, #501=图类型号 }` */
  const mountsOf = (rec) => {
    const mounts = [];
    (function walk(fields, depth) {
      if (depth > 8) return;
      for (const f of fields || []) {
        if (f.no === 13 && f.sub) {
          (function inner(fs, d) {
            if (d > 4) return;
            for (const g of fs || []) {
              if (!g.sub) continue;
              const v2 = numOf(g, 2);
              if (v2 != null && ids.has(v2)) mounts.push({ graphId: v2, index: numOf(g, 1), typeCode: numOf(g, 501) });
              inner(g.sub, d + 1);
            }
          })(f.sub, 0);
        }
        if (f.sub) walk(f.sub, depth + 1);
      }
    })(rec.sub || [], 0);
    return mounts;
  };
  /** 别处的图 id（跳过 `#13` 子树） */
  const otherRefsOf = (rec) => {
    const refs = [];
    (function walk(fields, inMount, depth) {
      if (depth > 8) return;
      for (const f of fields || []) {
        const inMount2 = inMount || (f.no === 13 && !!f.sub);
        const v = valOf(f);
        if (v != null && ids.has(v) && !inMount2) refs.push(v);
        if (f.sub) walk(f.sub, inMount2, depth + 1);
      }
    })(rec.sub || [], false, 0);
    return [...new Set(refs)];
  };
  const collect = (kind, list, regionNo, slotField) => {
    const region = regionOf(regionNo);
    if (!region) { out.unverified.push('这份 .gil 里没有顶层 #' + regionNo + '（' + kind + '区）'); return; }
    let i = 0;
    for (const rec of kids(region, 1)) {
      const mounts = mountsOf(rec); const otherRefs = otherRefsOf(rec);
      if (mounts.length || otherRefs.length) {
        list.push({ kind, index: i, id: numOf(rec, 1), name: slotText(rec, slotField), mounts, otherRefs });
      }
      i += 1;
    }
  };
  collect('实体', out.entities, 5, 5);
  collect('元件', out.components, 4, 6);
  const seen = new Set();
  for (const r of out.entities.concat(out.components)) for (const m of r.mounts) seen.add(m.graphId);
  out.mountedGraphIds = [...seen];
  return out;
}

/**
 * 读**元件区**（顶层 `#4`）——模型 / 骨骼 / 音效 / 特效那类"原件"（作者要点 1 的另一半）。
 * 实测：3 个条目，条目内按 `#6` / `#7` / `#8` 分组（骨骼挂点、音效、特效…），名字在深一层。
 */
export function readComponents(top, { limit = 40 } = {}) {
  const region = (top || []).find((f) => f.no === 4);
  const out = { components: [], componentCount: 0, unverified: [] };
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
  const out = { declarations: [], declarationCount: 0, compositeCount: 0, unverified: [] };
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
export function readGilNodeFacts(file, { graphLimit = 200, entityLimit = 400, componentLimit = 2000, declarationLimit = 300, configLimit = 200, withVariables = false } = {}) {
  const buf = fs.readFileSync(file);
  const root = findProtobufRoot(buf);
  if (!root) return { ok: false, file, size: buf.length, error: '解析失败：找不到 protobuf 主体' };
  const graphs = readNodeGraphs(root.fields, { limit: graphLimit });
  const ents = readEntities(root.fields, { limit: entityLimit, withVariables });
  /*
   * ⚠️ 2026-10-02 修：这里原来**没传 limit** ⇒ 吃到 `readComponents` 的默认 **40**，
   * 于是恐怖-V3 的 **71 个元件只回 40 个**（面板显示「元件 40 个」，作者一眼看出不对）。
   * 现在显式给足上限；真被截断时 `truncated` 由读取层标出来，回执里要如实说"还有 N 个没列"。
   */
  const comps = readComponents(root.fields, { limit: componentLimit });
  const decls = readNodeDeclarations(root.fields, { limit: declarationLimit, labelLimit: 3 });
  const configs = readConfigEntries(root.fields, { limit: configLimit });
  // ★ 场景摆放物（#27）/ 摆放实例（#8）：作者问"实体 12 个、场景静态更多"时补的 —— 这两块必须单独计数
  const scene = readSceneObjects(root.fields);
  const factions = readFactions(root.fields);
  const tree = readResourceTree(root.fields);
  const sigs = readSignalRefs(root.fields);
  const sem = analyzeGilSemantics(root.fields);
  // ★ 挂载关系（作者 2026-10-02 给出编辑器面板后补的能力）：实体/元件身上挂了哪些图
  const mounts = readGraphMounts(root.fields, { graphIds: graphs.graphs.map((g) => g.id).filter((x) => x != null) });
  // 名字兜底：记录内没取到名字的，用「同一个下标」的实体/元件名（readComponents 的名字是启发式取的，可能更深）
  for (const rec of mounts.entities) if (!rec.name && ents.entities[rec.index]) rec.name = ents.entities[rec.index].name;
  for (const rec of mounts.components) if (!rec.name && comps.components[rec.index]) rec.name = comps.components[rec.index].name;
  /** 图 id → 挂载主（`via:'mount'` = `#13` 形状**已确证**；`via:'ref'` = 记录里别处的图 id，**口径未确证**） */
  const graphOwners = {};
  const addOwner = (gid, o) => { if (!graphOwners[gid]) graphOwners[gid] = []; graphOwners[gid].push(o); };
  for (const rec of mounts.entities.concat(mounts.components)) {
    for (const m of rec.mounts) addOwner(m.graphId, { kind: rec.kind, name: rec.name, id: rec.id, via: 'mount' });
    for (const g of rec.otherRefs) addOwner(g, { kind: rec.kind, name: rec.name, id: rec.id, via: 'ref' });
  }
  return {
    ok: true,
    file,
    size: buf.length,
    graphs: graphs.graphs,
    mounts,
    graphOwners,
    // 每张图的节点（索引 / shell·kernel 引用 / x·y / 引脚记录字节数）—— 下一步「节点可点」要用
    graphNodeLists: (function () {
      const m = {};
      const region = (root.fields || []).find(function (f) { return f.no === 10; });
      if (region) for (const it of kids(region, 1)) {
        const inner = one(it, 1);
        const nm = inner ? txtOf(inner, 2) : null;
        if (!nm) continue;
        // ★ 官方名字：拿 shell/kernel 的 runtimeId 去**随包的节点词典**查（2026-10-01 实测对得上：
        //   如 75 = 以GUID查询实体；但本关 15 个唯一号只命中 2 个 —— 命不中就 doc=null，**不猜**）
        const names = new Map();
        for (const e of readEntities(root.fields, { limit: 100 }).entities) if (e.id != null) names.set(e.id, '实体「' + e.name + '」');
        for (const x of readNodeGraphs(root.fields, { limit: 100 }).graphs) if (x.id != null) names.set(x.id, '图「' + x.name + '」');
        for (const d of readNodeDeclarations(root.fields, { limit: 400 }).declarations) if (d.id != null) names.set(d.id, '声明 ' + d.id);
        m[nm] = readGraphNodes(inner).nodes.map(function (nd) {
          const rid = (nd.kernelRef && nd.kernelRef.runtimeId) != null ? nd.kernelRef.runtimeId
            : (nd.shellRef ? nd.shellRef.runtimeId : null);
          const doc = rid == null ? null : nodeById(rid);
          return Object.assign({}, nd, {
            docId: rid,
            doc: doc ? { zh: doc.zh, en: doc.en, identifier: doc.identifier, system: doc.system, domain: doc.domain, pins: doc.pins.length } : null,
            refs: (nd.refIds || []).map(function (id) { return { id: id, what: names.get(id) || null }; }),
            label: doc ? doc.zh : ('未知节点 ' + rid),
          });
        });
      }
      return m;
    })(),
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
    // ★ 场景摆放物 / 摆放实例（2026-10-02）：别让"实体 12 个"被读成"这张图只有 12 个东西"
    sceneObjectCount: scene.sceneObjectCount,
    sceneObjects: scene.sceneObjects,
    placedCount: scene.placedCount,
    placedInstances: scene.placedInstances,
    regionMap: readRegionMap(root.fields),
    declarationCount: decls.declarationCount,
    compositeCount: decls.compositeCount,
    declarationLabels: decls.declarations.filter((d) => d.labels.length).slice(0, 6).map((d) => ({ id: d.id, labels: d.labels.slice(0, 3), composite: d.isComposite })),
    declarations: decls.declarations,
    declarationStats: { withLabels: decls.withLabels, withNotes: decls.withNotes },
    // ★ 截断要说出来（2026-10-02 修掉"元件静默截断在 40"时一起加的）：各子读取器的 `truncated` 原样透出
    truncated: {
      graphs: graphs.truncated || 0,
      entities: ents.truncated || 0,
      components: comps.truncated === true ? true : false,
      declarations: decls.truncated || 0,
      configs: configs.truncated || 0,
    },
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
