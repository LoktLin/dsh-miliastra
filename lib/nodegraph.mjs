/*
 * 节点图的**能力画像**（纯函数；只吃「已读出来的节点 + 随包节点词典」，不碰文件、不碰网络）。
 *
 * 作者 2026-10-02 的要求：
 *   ① 「希望读取到有多少的各类型节点（事件节点 x 个 / 执行节点 x 个）」；
 *   ② 「做个快速判断当前节点图用来做啥的能力：入口 / 关键词 / 踩坑」；
 * 判据来源（**不许编**）：
 *   · **节点类型** 来自随包词典 `lib/nodedb.json`（558 条，MIT，见 NOTICE）里的
 *     `identifier` 第一段（`Trigger.` / `Execution.` / `Query.` / `Arithmetic.` / `Control.` / `Others.` / `Hidden.`）
 *     —— 它就是官方那套分类（服务端节点 / 客户端节点教程里的分节），与字典里的 `domain` 字段**互相印证**：
 *     实测 558 条里两者一致 555 条（只有 `Others`/`Hidden` 少量差异，已在下面函数里优先用 identifier、退化到 domain）。
 *   · **服务端 / 客户端** 来自词典的 `system`（`Server` 434 / `Client` 124）。
 *   · ⚠️ 「谁身上挂着这张图」**读不出来**（`.gil` 里没有挂载主体字段；数值 id 号段还重叠 —— 见 `graphOwnerNote()`）。
 */

/** 类型标签：中文名 = 官方教程分节的口径。`Custom`/`Composite` 不是官方分类，而是**能确证的归属**（见 `typeStatsOf`）。 */
export const NODE_TYPE_LABELS = {
  Trigger: '事件',
  Execution: '执行',
  Query: '查询',
  Arithmetic: '运算',
  Control: '分支',
  Others: '端口',
  Hidden: '内置',
  Custom: '自定义节点',
  Composite: '复合节点',
};

/** 类型的中文名（未知一律「未知」，不编）。 */
export function nodeTypeLabel(key) {
  return NODE_TYPE_LABELS[key] || '未知';
}

/**
 * 一个节点属于哪一类：**优先看词典里 `identifier` 的第一段**（最贴近官方分类），
 * 没有 identifier 时退化到 `domain`；两者都没有 ⇒ `Unknown`（回执里如实计数，不猜）。
 * @param {{identifier?: string, domain?: string} | null} doc 随包词典里那一条（读不出来就是 null）
 */
export function nodeTypeOf(doc) {
  if (!doc) return 'Unknown';
  const id = typeof doc.identifier === 'string' ? doc.identifier : '';
  const head = id.split('.')[0];
  if (head && NODE_TYPE_LABELS[head]) return head;
  if (doc.domain && NODE_TYPE_LABELS[doc.domain]) return doc.domain;
  if (doc.domain) return String(doc.domain);
  return 'Unknown';
}

/** 一个节点在哪一端：词典的 `system`（`Server` / `Client`）；读不出来就说 `Unknown`。 */
export function nodeSideOf(doc) {
  if (!doc || !doc.system) return 'Unknown';
  return doc.system === 'Client' ? '客户端' : (doc.system === 'Server' ? '服务端' : String(doc.system));
}

/** 类型分布的固定顺序（事件 → 执行 → 查询 → 运算 → 分支 → 端口 → 内置 → 自定义/复合），其余按出现顺序补在后面。 */
const TYPE_ORDER = ['Trigger', 'Execution', 'Query', 'Arithmetic', 'Control', 'Others', 'Hidden', 'Composite', 'Custom'];

/** `{Trigger:2,…}` → `事件 2 · 执行 1 …`（**未知垫底**；口径只有这一份，面板/报告/工具都用它）。 */
export function typeTextOf(byType) {
  const b = byType || {};
  const parts = TYPE_ORDER.filter((k) => b[k]).map((k) => nodeTypeLabel(k) + ' ' + b[k]);
  for (const k of Object.keys(b)) if (!TYPE_ORDER.includes(k)) parts.push(nodeTypeLabel(k) + ' ' + b[k]);
  return parts.join(' · ') || '（没有节点）';
}

/**
 * 一批节点的类型分布（作者要的「各类型节点有多少个」）。
 *
 * ★ `opts.declarations`（本关的声明表）给了之后，**词典命不中但 id 命中本关卡内声明**的节点会被归成
 *   `Composite`（复合节点）/ `Custom`（自定义节点），而不是一律 `Unknown` —— 这是**能确证的归属**
 *   （实测恐怖-V3：1119 个节点里 548 个命中官方词典、159 个命中本关声明（复合 46）、412 个两边都没有）。
 *
 * @param {Array<{doc?: any, docId?: number|null}>} nodes
 * @param {{declarations?: Array<{id:number, isComposite?:boolean}>}} [opts]
 * @returns {{total:number, known:number, unknown:number, byType:any, byTypeLabel:any,
 *            bySide:any, byTypeAndSide:any, byTypeLabelText:string}}
 */
export function typeStatsOf(nodes, opts) {
  const list = nodes || [];
  const decls = (opts && opts.declarations) || [];
  const byDecl = new Map();
  for (const d of decls) if (d && d.id != null) byDecl.set(d.id, d);
  const byType = {}; const bySide = {}; const byTypeAndSide = {};
  let unknown = 0;
  for (const nd of list) {
    let t = nodeTypeOf(nd && nd.doc);
    if (t === 'Unknown' && nd && nd.docId != null && byDecl.has(nd.docId)) {
      t = byDecl.get(nd.docId).isComposite ? 'Composite' : 'Custom';
    }
    const s = nodeSideOf(nd && nd.doc);
    byType[t] = (byType[t] || 0) + 1;
    bySide[s] = (bySide[s] || 0) + 1;
    if (!byTypeAndSide[t]) byTypeAndSide[t] = {};
    byTypeAndSide[t][s] = (byTypeAndSide[t][s] || 0) + 1;
    if (t === 'Unknown') unknown += 1;
  }
  const byTypeLabel = {};
  for (const [k, v] of Object.entries(byType)) byTypeLabel[nodeTypeLabel(k)] = v;
  return {
    total: list.length, known: list.length - unknown, unknown,
    byType, byTypeLabel, bySide, byTypeAndSide,
    byTypeLabelText: typeTextOf(byType),
  };
}

/**
 * 这张图的**入口**：类型 = 事件（`Trigger`）的节点。它们的官方名字就是"什么情况下跑起来"。
 * @returns {Array<{index:number, name:string, identifier:string|null, docId:number|null}>}
 */
export function triggersOf(nodes) {
  return (nodes || []).filter((nd) => nodeTypeOf(nd && nd.doc) === 'Trigger').map((nd) => ({
    index: nd.index == null ? null : nd.index,
    name: nd.doc ? (nd.doc.zh || nd.doc.en || ('未知节点 ' + nd.docId)) : ('未知节点 ' + nd.docId),
    identifier: nd.doc ? (nd.doc.identifier || null) : null,
    docId: nd.docId == null ? null : nd.docId,
  }));
}

/**
 * 这张图的节点**引用到谁**（`.gil` 里节点带 `refs[]`，读取层已把它翻成「实体「X」/ 声明 N / 图 …」）。
 * ⚠️ 方向是「**图 → 引用了谁**」，**不是**「谁身上挂着这张图」（后者读不出来，见 `graphOwnerNote()`）。
 * @returns {{total:number, entities:string[], others:string[], byWhat:Record<string,number>}}
 */
export function refsSummaryOf(nodes) {
  const entities = new Set(); const others = new Set(); const byWhat = {};
  for (const nd of nodes || []) {
    for (const r of (nd && nd.refs) || []) {
      const what = String((r && r.what) || '');
      const m = /^实体「(.+)」$/.exec(what);
      if (m) entities.add(m[1]); else if (what) others.add(what);
      byWhat[what] = (byWhat[what] || 0) + 1;
    }
  }
  return {
    total: (nodes || []).reduce((s, nd) => s + (((nd && nd.refs) || []).length), 0),
    entities: [...entities], others: [...others], byWhat,
  };
}

/**
 * 从"名字 + 节点名 + 引用到的实体"里抽**关键词**（纯字符串统计，不做语义猜测 —— 不下判决）。
 * @returns {string[]} 出现次数多的在前，最多 `limit` 个
 */
export function keywordsOf(graphName, nodes, refs, limit) {
  const bag = new Map();
  const put = (w, n) => { if (w && w.length >= 2) bag.set(w, (bag.get(w) || 0) + (n || 1)); };
  const cut = (s) => String(s || '').split(/[_\-\s·（）()【】\[\]，,。:：/]+/).filter((x) => x.length >= 2 && !/^\d+$/.test(x));
  for (const w of cut(graphName)) put(w, 3);                                  // 图名权重高
  for (const nd of nodes || []) for (const w of cut(nd.doc ? (nd.doc.zh || '') : '')) put(w);
  for (const w of (refs && refs.entities) || []) for (const x of cut(w)) put(x);
  return [...bag.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit || 12).map((x) => x[0]);
}

/**
 * 一张图的**能力画像**：作者要的「快速判断这张节点图用来做啥」。
 * @param {any} graph `{name, id, typeLabel?, …}`（读不出来就给 `{name}`）
 * @param {Array<any>} nodes 这张图的节点（读取层给的形状：`{index, docId, doc, refs, pins, …}`）
 * @param {{edges?:Array<any>, declarations?:Array<{id:number, isComposite?:boolean}>}} [opts]
 */
export function graphAnatomy(graph, nodes, opts) {
  const g = graph || {};
  const list = nodes || [];
  const typeStats = typeStatsOf(list, opts);
  const triggers = triggersOf(list);
  const refs = refsSummaryOf(list);
  const keywords = keywordsOf(g.name, list, refs, 12);
  const edges = (opts && opts.edges) || [];
  // 一句话画像：**只陈述事实**（类型分布 + 入口 + 引用），判断留给读的人/模型
  const brief = [
    '「' + (g.name || '?') + '」' + (g.typeLabel ? '（' + g.typeLabel + '）' : ''),
    list.length + ' 个节点（' + typeStats.byTypeLabelText + '）',
    triggers.length ? '入口：' + triggers.slice(0, 4).map((t) => t.name).join(' / ') + (triggers.length > 4 ? ' 等 ' + triggers.length + ' 个事件' : '') : '没有事件（触发器）节点',
    refs.entities.length ? '引用实体：' + refs.entities.slice(0, 6).join(' / ') + (refs.entities.length > 6 ? ' 等 ' + refs.entities.length + ' 个' : '') : null,
    '出边 ' + edges.length + ' 条',
  ].filter(Boolean).join('　·　');
  return { graph: g, nodeCount: list.length, edgeCount: edges.length, typeStats, triggers, refs, keywords, brief };
}

/** 把整关的画像汇总成一张表（`byType` 逐图相加）。 */
export function anatomyTotals(anatomies) {
  const byType = {}; const bySide = {}; let nodes = 0; let edges = 0;
  for (const a of anatomies || []) {
    nodes += a.nodeCount; edges += a.edgeCount;
    for (const [k, v] of Object.entries(a.typeStats.byType)) byType[k] = (byType[k] || 0) + v;
    for (const [k, v] of Object.entries(a.typeStats.bySide)) bySide[k] = (bySide[k] || 0) + v;
  }
  const byTypeLabel = {};
  for (const [k, v] of Object.entries(byType)) byTypeLabel[nodeTypeLabel(k)] = v;
  return { graphs: (anatomies || []).length, nodes, edges, byType, byTypeLabel, bySide, byTypeLabelText: typeTextOf(byType) };
}

/**
 * 「谁身上挂着这张图」—— ★★ **2026-10-02 修正：读得出来**（上一轮我说"读不出来"，那是**错的口径**）。
 *
 * 作者给出编辑器「节点图挂载对象」面板后重新查证：
 *   · **能读的判据**是**结构路径**，不是"数值命中"：实体 `#5[i].#6.#13.#1[].#1{ #1=序号, #2=图id, #501=图类型号 }`，
 *     元件把 `#6` 换成 `#7`（同一个挂载形状）。实测与编辑器面板逐条对上：
 *     侦探1「关卡实体」→「关卡实体信号」；恐怖「送菜窗口」→「吧台_收食物」、元件「肉_盘子」→「选项卡食物拿起」。
 *   · 另一类形状（`#7.#27.#2.#6.#2`、`#7.#38.#501.#504.#2` …）也指向某张图（**21 张客户端布尔过滤器图**就是这一类），
 *     但口径**未确证** ⇒ 单独标 `via:'ref'` 回报，不冒充"挂载"。
 *   · ⚠️ **仍然读不到的那部分**：技能图 / 状态图挂在"技能、职业、状态"等**别的区**上 ——
 *     实体/元件区里查不到它们的挂载主（实测侦探1：19 张里 1 张有主）。所以"某张图没主"**只能说"这两个区里没找到"**。
 *   · ⚠️ 上一轮**错在哪**（留作教训）：① 按**名字**匹配（57 个图名只有 1 个与实体名全等）；
 *     ② 按**裸数值**找（号段重叠，同段随机号也会命中）⇒ 两条都不能当证据。**必须按结构路径取**。
 */
export function graphOwnerNote() {
  return {
    verified: true,
    how: '实体记录 `#5[i].#6.#13.#1[].#1.#2`（元件是 `#5`→`#7`）= 挂载的节点图 id；'
      + '该形状**与编辑器「节点图挂载对象」面板逐条对上**，回执里标 `via:"mount"`。',
    partial: '记录里**别处**出现的图 id（如 `#7.#27.#2.#6.#2` / `#7.#38.#501.#504.#2`）也指向某张图 —— '
      + '本机实测这 21 张正是**客户端布尔过滤器图**，但形状口径未确证 ⇒ 一律标 `via:"ref"`，不冒充挂载。',
    blind: '**技能图 / 状态图**挂在技能、职业、状态等**别的区**，实体/元件区里查不到挂载主'
      + '（实测侦探1 的 19 张里只有 1 张「关卡实体信号」有主）⇒ 没找到时只能说"**这两个区里**没找到"，别说"这张图没挂载"。',
    warning: '⚠️ 别用**名字匹配**（图名与实体名大多不同）或**裸数值命中**（号段重叠、随机号也会撞）当证据 —— 这两条正是上一轮的错。',
    source: '口径来自作者 2026-10-02 提供的编辑器面板线索（`#13` 挂载形状），已用两个关卡的实测结果交叉核对。',
  };
}
