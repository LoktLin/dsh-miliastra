/**
 * gilreport.mjs —— 把 `.gil` 里读出来的**节点图事实**编成一份**给人看的 Markdown 报告**（纯函数，不碰盘）。
 *
 * ★ 为什么单独一层：报告正文要能被**回归测试**逐条断言（表头齐不齐、数字对不对、
 *   未确证的话有没有原样带上、有没有偷偷下判决），而"读盘 + 写盘"那半边归 `tools/gil-node-report.mjs`。
 *   两件事分开 ⇒ 测的是**判据**，不是"文件写没写成功"。
 *
 * ★ 口径（与面板第 7 页、`miliastra_map op=nodes` **同一份判据**）：
 *   · 节点名 = `doc.zh`（拿 `runtimeId` 查随包节点词典）；命不中 ⇒ `未知节点 <号>`，**不编**。
 *   · 连线 = 每个节点的 `outEdges`（= 引脚实例字段 5 的字段 1 = 目标节点索引）。
 *   · 引脚 kind 号 ↔「输入/输出参数」名字**未确证** ⇒ 只印号。
 *   · **只报数字，不下判决**（报告里不会出现"正确 / 通过 / 有问题"这类结论）。
 */

import crypto from 'node:crypto';

/** Markdown 表格单元：竖线、换行都得转义（否则表格会被节点名字里的 `|` 撕开）。 */
export function mdCell(s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 节点官方名字（与面板 `nodesNodeLabel` 同一条判据）。 */
export function nodeName(nd) {
  if (!nd) return '(无)';
  if (nd.doc && nd.doc.zh) return nd.doc.zh;
  if (nd.docId == null) return '未命名节点（回执里没有 runtimeId）';
  return '未知节点 ' + nd.docId;
}

/** 一个节点的出边（谁连谁）。`outEdges` 由读取层给；没有就当 0 条（**不在此处重新推导** —— 判据只有一份）。 */
export function edgesOfNode(nd) {
  return (nd && nd.outEdges) || [];
}

/** 坐标文本：float32 尾巴只留 1 位小数。 */
export function coordText(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '?';
  return String(Math.round(v * 10) / 10);
}

/**
 * 报告要用的**全部数字**（一刀算清，表头与总览都从这里取，别各算一份）。
 * @param {any} facts `readGilNodeFacts()` 的回执（字段来自读取层，这里不做形状假设）
 */
export function reportStats(facts) {
  const graphs = (facts && facts.graphs) || [];
  const lists = (facts && facts.graphNodeLists) || {};
  const names = Object.keys(lists);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  let nodes = 0; let edges = 0; let named = 0; let pins = 0; let nodesWithPins = 0;
  /*
   * ⚠️ 坐标有**两个口径**，两个都算（复核 2026-10-01 第 3.1 条指出的）：
   *   `xyBoth` = x、y 都有（报告主口径）；`xyAny` = 任一有。本关实测 1115 / 1116，
   *   差的那 1 个是「门_未准备」#4 `多分支`（x=-123、**`.gil` 里根本没有 `#6` 字段**）——
   *   是**数据事实**，不是读取层漏读；只出现 `#5` 的节点会被单列出来给读者看。
   */
  let xyBoth = 0; let xyAny = 0; let xyOnlyX = 0; let xyOnlyY = 0;
  const noY = []; const noX = [];
  const idCount = new Map();
  const idHit = new Set();
  for (const nm of names) {
    for (const nd of lists[nm]) {
      nodes += 1;
      edges += edgesOfNode(nd).length;
      if (nd.doc) named += 1;
      const hasX = nd.x != null; const hasY = nd.y != null;
      if (hasX && hasY) xyBoth += 1;
      if (hasX || hasY) xyAny += 1;
      if (hasX && !hasY) { xyOnlyX += 1; noY.push({ graph: nm, index: nd.index, x: nd.x, name: nodeName(nd) }); }
      if (!hasX && hasY) { xyOnlyY += 1; noX.push({ graph: nm, index: nd.index, y: nd.y, name: nodeName(nd) }); }
      if (nd.pinCount) { pins += nd.pinCount; nodesWithPins += 1; }
      const k = nd.docId == null ? 'null' : String(nd.docId);
      idCount.set(k, (idCount.get(k) || 0) + 1);
      if (nd.doc) idHit.add(k);
    }
  }
  // 图记录里有、但读取层拿不到节点列表的（无名图 / 无图体）
  const noList = graphs.filter((g) => !Object.prototype.hasOwnProperty.call(lists, g.name)).length;
  return {
    graphCount: graphs.length,
    graphWithNodes: names.length,
    graphWithoutNodeList: noList,
    duplicateGraphNames: [...new Set(dup)],
    nodeCount: nodes,
    edgeCount: edges,
    namedCount: named,
    unnamedCount: nodes - named,
    // 坐标：主口径 = x、y 都有（`xyCount` 是旧名，别拿它当"任一有"）
    xyCount: xyBoth,
    xyBoth, xyAny, xyOnlyX, xyOnlyY, noY, noX,
    pinCount: pins,
    nodesWithPins,
    // 唯一号三个口径（复核第 3.2 条：277 是**全部**唯一号，不是"未命中的种数"）
    uniqueNodeIds: idCount.size,
    hitUniqueIds: idHit.size,
    missUniqueIds: [...idCount.keys()].filter((k) => k !== 'null' && !idHit.has(k)).length,
    nullIdNodes: idCount.get('null') || 0,
    entityCount: facts.entityCount || 0,
    totalVariables: facts.totalVariables || 0,
    componentCount: facts.componentCount || 0,
    declarationCount: facts.declarationCount || 0,
    compositeCount: facts.compositeCount || 0,
    declarationWithLabels: (facts.declarationStats || {}).withLabels || 0,
    declarationWithNotes: (facts.declarationStats || {}).withNotes || 0,
    configCount: facts.configCount || 0,
    signalRefCount: facts.signalRefCount || 0,
    kinds: facts.kinds || [],
    idCount,
  };
}

/**
 * **数据指纹**：把"这份报告依赖的全部数字"压成一个 sha256。
 *
 * ★ 它回答的是复核第 6 节那个担心（「改了读取层忘了重跑报告」）——
 *   判据不是"文件有没有被改过"，而是**"现在重跑一遍，数字还一样吗"**：
 *   数字一样 ⇒ 报告仍然有效（哪怕读取层的注释改了）；数字变了 ⇒ 该重跑。
 *   `--check` 就是拿它跟报告头里那一行比。
 */
export function statsFingerprint(stats) {
  const o = {
    graphCount: stats.graphCount, graphWithNodes: stats.graphWithNodes, graphWithoutNodeList: stats.graphWithoutNodeList,
    duplicateGraphNames: stats.duplicateGraphNames,
    nodeCount: stats.nodeCount, edgeCount: stats.edgeCount, namedCount: stats.namedCount, unnamedCount: stats.unnamedCount,
    xyBoth: stats.xyBoth, xyAny: stats.xyAny, xyOnlyX: stats.xyOnlyX, xyOnlyY: stats.xyOnlyY,
    pinCount: stats.pinCount, nodesWithPins: stats.nodesWithPins,
    uniqueNodeIds: stats.uniqueNodeIds, hitUniqueIds: stats.hitUniqueIds, missUniqueIds: stats.missUniqueIds,
    nullIdNodes: stats.nullIdNodes,
    entityCount: stats.entityCount, totalVariables: stats.totalVariables, componentCount: stats.componentCount,
    declarationCount: stats.declarationCount, compositeCount: stats.compositeCount,
    declarationWithLabels: stats.declarationWithLabels, declarationWithNotes: stats.declarationWithNotes,
    configCount: stats.configCount, signalRefCount: stats.signalRefCount,
    kinds: (stats.kinds || []).map((k) => [k.typeLabel, k.count, k.nodeTotal]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

/** 按类型分组的图/节点/出边小计（总览与「按类型」两节共用）。 */
function kindRows(facts, stats) {
  const lists = (facts && facts.graphNodeLists) || {};
  const byKind = new Map();
  for (const g of (facts && facts.graphs) || []) {
    const key = g.typeLabel || ('未知类型 ' + g.typeCode);
    if (!byKind.has(key)) byKind.set(key, { label: key, graphs: 0, nodes: 0, edges: 0 });
    const a = byKind.get(key);
    a.graphs += 1;
    const l = lists[g.name] || [];
    a.nodes += l.length;
    a.edges += l.reduce((s, n) => s + edgesOfNode(n).length, 0);
  }
  const out = [...byKind.values()].sort((a, b) => b.nodes - a.nodes);
  if (!out.length) out.push({ label: '（没有节点图）', graphs: 0, nodes: 0, edges: 0 });
  if (stats && stats.graphCount !== stats.graphWithNodes) {
    // 图记录里有、但节点列表拿不到：如实留一行，别让"节点数合计"看起来对不上
    out.push({ label: '（图记录有、节点列表拿不到）', graphs: stats.graphCount - stats.graphWithNodes, nodes: 0, edges: 0 });
  }
  return out;
}

/** 表格：一行表头 + 分隔行 + 数据行。 */
function table(head, rows) {
  const lines = ['| ' + head.map(mdCell).join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const r of rows) lines.push('| ' + r.map(mdCell).join(' | ') + ' |');
  return lines.join('\n');
}

/**
 * 编报告正文。
 * @param {any} facts `readGilNodeFacts()` 的回执（字段来自读取层，这里不做形状假设）
 * @param {{levelId?: string|number, gilPath?: string, sha256?: string, generatedAt?: string,
 *          command?: string, fingerprint?: string, maxNodesPerGraph?: number, maxGraphs?: number, summaryOnly?: boolean}} [opts]
 * @returns {string} Markdown 正文（结尾带换行）
 */
export function buildNodeReport(facts, opts = {}) {
  const o = opts || {};
  const st = reportStats(facts);
  const lists = facts.graphNodeLists || {};
  const graphs = facts.graphs || [];
  const capN = Number.isFinite(o.maxNodesPerGraph) && o.maxNodesPerGraph > 0 ? o.maxNodesPerGraph : 0;
  const capG = Number.isFinite(o.maxGraphs) && o.maxGraphs > 0 ? o.maxGraphs : 0;
  const L = [];
  const p = (s) => L.push(s == null ? '' : s);

  p('# 节点图报告 · 关卡 ' + (o.levelId == null ? '（未指定）' : o.levelId));
  p('');
  p('> 由 `tools/gil-node-report.mjs` 从 `.gil` **只读**生成（一个字节都不写地图）。**别手改这份文件** —— 要改就重跑命令。');
  p('>');
  p('> · 来源文件：`' + (o.gilPath || facts.file || '（未知）') + '`');
  p('> · 文件大小：' + (facts.size == null ? '?' : facts.size) + ' 字节'
    + (o.sha256 ? '　sha256：`' + String(o.sha256).slice(0, 16) + '…`' : ''));
  p('> · 生成时间：' + (o.generatedAt || '（未记录）'));
  if (o.command) p('> · 复现命令：`' + o.command + '`');
  p('> · 读取层：`lib/gilnodes.mjs`（字段出处见插件 `docs/功能详解.md`）');
  if (o.fingerprint) {
    p('> · 数据指纹：`' + String(o.fingerprint) + '`'
      + '（= 这份报告依赖的全部数字压出来的 sha256；拿 `--check` 比一下就知道**该不该重跑** —— 复核第 6 节那条建议）');
  }
  p('> · ⚠️ 本报告**只报数字与原始串**，不下"对不对 / 通不通"的判决；语义未确证的地方见文末附录 B。');
  p('');

  p('## 0. 一页总览');
  p('');
  p(table(['项', '数'], [
    ['节点图', st.graphCount + ' 张'
      + (st.graphWithNodes !== st.graphCount ? '（其中 ' + st.graphWithNodes + ' 张能取到节点列表，' + st.graphWithoutNodeList + ' 张取不到）' : '')],
    ['节点', st.nodeCount + ' 个'],
    ['出边（连线）', st.edgeCount + ' 条'],
    ['节点官方名字命中词典', st.namedCount + ' / ' + st.nodeCount + '（**词典未收录** ' + st.unnamedCount + ' 个，涉及 '
      + st.missUniqueIds + ' 种号；本关节点用到的唯一号共 ' + st.uniqueNodeIds + ' 种 = 命中 ' + st.hitUniqueIds
      + ' + 未收录 ' + st.missUniqueIds + '）'],
    ['节点带坐标', '**x、y 都有** ' + st.xyBoth + ' / ' + st.nodeCount + '；任一有 ' + st.xyAny
      + (st.xyOnlyX + st.xyOnlyY ? '（只存了 x 的 ' + st.xyOnlyX + ' 个' + (st.xyOnlyY ? '、只存了 y 的 ' + st.xyOnlyY + ' 个' : '') + '）' : '')],
    ['引脚实例', st.pinCount + ' 个（分布在 ' + st.nodesWithPins + ' 个节点上）'],
    ['实体 / 自定义变量', st.entityCount + ' / ' + st.totalVariables],
    ['元件', String(st.componentCount)],
    ['节点声明', st.declarationCount + ' 条（复合 ' + st.compositeCount + ' · 有端口/参数名 ' + st.declarationWithLabels
      + ' · 有作者说明 ' + st.declarationWithNotes + '）'],
    ['配置条目（职业/成长曲线/连段/状态…）', String(st.configCount)],
    ['信号 / 参数引用', String(st.signalRefCount)],
  ]));
  p('');
  /*
   * 坐标口径的脚注：**只出现一个坐标**的节点要单列出来（复核 2026-10-01 第 3.1 / 第 5 条）。
   * 已实测确认那是**数据事实**（`.gil` 里确实没有 `#6` 字段），不是读取层漏读 —— 读取层只认 `#5`/`#6` 的 float32。
   */
  if (st.xyOnlyX || st.xyOnlyY) {
    p('> ⚠️ 上面「只存了一个坐标」的节点（x/y 只有一个）——**读取层只认字段 `#5`(x)/`#6`(y) 的 float32**，'
      + '一个节点只有 `#5` 就是 `.gil` 里**没有 `#6`**，属**数据事实**，不是漏读：');
    for (const x of st.noY.slice(0, 5)) p('> · 只存了 x：图「' + x.graph + '」#' + x.index + '　' + x.name + '（x = ' + coordText(x.x) + '）');
    for (const x of st.noX.slice(0, 5)) p('> · 只存了 y：图「' + x.graph + '」#' + x.index + '　' + x.name + '（y = ' + coordText(x.y) + '）');
    if (st.noY.length + st.noX.length > 10) p('> · （还有 ' + (st.noY.length + st.noX.length - 10) + ' 个没列出来）');
    p('');
  }

  p('## 1. 按图类型分组');
  p('');
  p(table(['图类型', '张数', '节点', '出边'], kindRows(facts, st).map((k) => [k.label, k.graphs, k.nodes, k.edges])));
  p('');

  p('## 2. 图一览');
  p('');
  const linkable = !o.summaryOnly;
  p(linkable
    ? '（点图名跳到第 3 节的明细；锚点是我们自己插的 `<a id="gN">`，不依赖阅读器怎么认中文标题）'
    : '（`--summary-only` 模式：没有第 3 节，所以这里**不给跳转**，免得点了没反应）');
  p('');
  p(table(['#', '图名', '类型', '图 id（段）', 'kind', '节点', '出边', '官方名命中', '坐标(x,y)'],
    graphs.map((g, i) => {
      const l = lists[g.name] || [];
      const e = l.reduce((s, n) => s + edgesOfNode(n).length, 0);
      const nm = l.filter((n) => n.doc).length;
      const xy = l.filter((n) => n.x != null && n.y != null).length;
      // 图名里带方括号或竖线时不做链接（那会把 Markdown 链接语法 / 表格撕开）—— 名字原样给，照样能搜到
      const label = linkable && !/[[\]|]/.test(g.name) ? '[' + g.name + '](#g' + (i + 1) + ')' : g.name;
      return [i + 1, label, g.typeLabel || ('类型 ' + g.typeCode),
        g.id + (g.idRange ? '（' + g.idRange + '）' : ''), g.kindCode,
        g.hasBody === false ? '无图体' : l.length, e, nm + ' / ' + l.length, xy];
    })));
  p('');

  if (!o.summaryOnly) {
    p('## 3. 逐图明细');
    p('');
    p('每张图两张表：**节点**（官方名字 / 坐标 / 引脚数 / 出边数）与**连线**（谁连谁）。');
    p('节点表里的 `#` 就是 `.gil` 里的**节点索引**，连线表用同一套号。');
    p('');
    const shown = capG ? graphs.slice(0, capG) : graphs;
    shown.forEach((g, gi) => {
      const all = lists[g.name] || [];
      const nodes = capN ? all.slice(0, capN) : all;
      const pos = new Map(all.map((n) => [n.index, n]));
      const at = (i) => (pos.has(i) ? '#' + i + ' ' + nodeName(pos.get(i)) : '#' + i + '（不在本图节点表里）');
      const allEdges = all.reduce((s, n) => s.concat(edgesOfNode(n).map((e) => ({ e, from: n }))), []);
      p('<a id="g' + (gi + 1) + '"></a>');
      p('');
      p('### 图 ' + (gi + 1) + '：' + g.name);
      p('');
      p('- 类型：' + (g.typeLabel || ('类型 ' + g.typeCode)) + '　·　图 id：`' + g.id + '`'
        + (g.idRange ? '（' + g.idRange + '段）' : '') + '　·　kind：' + g.kindCode);
      p('- 节点 ' + all.length + ' 个 · 出边 ' + allEdges.length + ' 条 · 官方名字命中 '
        + all.filter((n) => n.doc).length + ' · 坐标(x,y 都有) ' + all.filter((n) => n.x != null && n.y != null).length
        + (g.hasBody === false ? '　·　**图体为空**（图记录里没有节点块）' : ''));
      p('');
      if (!all.length) {
        p('（这张图没有节点。）');
        p('');
        return;
      }
      p(table(['#', '节点（官方名字）', 'runtimeId', '系统 / 分类', 'x', 'y', '引脚', '出边'],
        nodes.map((n) => [
          n.index, nodeName(n), n.docId == null ? '（无）' : n.docId,
          n.doc ? n.doc.system + ' / ' + n.doc.domain : '（词典没命中）',
          coordText(n.x), coordText(n.y), n.pinCount == null ? '?' : n.pinCount, edgesOfNode(n).length,
        ])));
      if (capN && all.length > capN) {
        p('');
        p('（上面只列了前 ' + capN + ' 个节点，本图共 ' + all.length + ' 个 —— 要全量就别传 `--max-nodes-per-graph`。）');
      }
      p('');
      if (allEdges.length) {
        p('**连线**（连线 = 引脚实例字段 5 的字段 1 = 目标节点索引）');
        p('');
        p(table(['从', '→ 到', '目标脚 shell / kernel', '出发引脚 kind'], allEdges.map((x) => [
          '#' + x.e.from + ' ' + nodeName(x.from), at(x.e.to),
          (x.e.toShell == null ? '?' : x.e.toShell) + ' / ' + (x.e.toKernel == null ? '?' : x.e.toKernel),
          x.e.fromPinKind == null ? '?' : x.e.fromPinKind,
        ])));
        p('');
      } else {
        p('（这张图没有连线记录。）');
        p('');
      }
    });
    if (capG && graphs.length > capG) {
      p('（上面只列了前 ' + capG + ' 张图，本关共 ' + graphs.length + ' 张 —— 要全量就别传 `--max-graphs`。）');
      p('');
    }
  } else {
    p('> ⚠️ `--summary-only`：**没有**第 3 节（逐图明细）。要节点/连线明细就重跑，别传这个开关。');
    p('');
  }

  // 附录 A：节点号 → 出现次数（按次数降序，前 40 条）
  const ids = [...st.idCount.entries()].map(([k, v]) => ({ id: k, n: v }))
    .sort((a, b) => b.n - a.n || String(a.id).localeCompare(String(b.id)));
  const nameOf = new Map();
  for (const nm of Object.keys(lists)) for (const nd of lists[nm]) if (nd.docId != null && !nameOf.has(String(nd.docId))) nameOf.set(String(nd.docId), nodeName(nd));
  p('## 附录 A：节点号 → 出现次数（前 40）');
  p('');
  /*
   * ★ 这一段原来**自相矛盾**（复核 2026-10-01 第 4.1 条）：表头写「命不中一律写『词典未收录』」，
   *   可表格里印的是**读取层的兜底文案**「未知节点 <号>」。现在改成：**表头如实描述表格里的字面**，
   *   并把"未知节点 = 词典里没有这个号，不是节点不存在"讲明白（要不要把三处口径统一改名，见交接文档的待拍板）。
   */
  p('官方名字用**随包节点词典**（`lib/nodedb.json`，558 条 / MIT，见 `NOTICE`）按 `runtimeId` 查。');
  p('查不到时，表格里印的是**读取层的原样兜底文案**「未知节点 `<号>`」—— 意思是**词典里没有这个号**，'
    + '**不是**"这个节点不存在"（节点在 `.gil` 里是真实存在的，只是词典没收录它的 `runtimeId`）。');
  p('⚠️ **词典自己也有空缺**：上游 `runtimeId` 序列就是 `1, 2, 3, 5, 6, 7, 8, 9 …`（**跳过 4**）—— 那是**上游库的缺号**，'
    + '不是读取错误（本关用到的号里有 ' + st.missUniqueIds + ' 种在词典里查不到）。');
  p('');
  p(table(['runtimeId', '出现次数', '官方名字（词典）'], ids.slice(0, 40).map((x) => [
    x.id, x.n, nameOf.get(x.id) || '未知节点 ' + x.id,
  ])));
  p('');

  // 附录 B：未确证清单（原样搬，别改写）
  p('## 附录 B：未确证清单（**原样搬自读取层，别当事实用**）');
  p('');
  const un = (facts.unverified || []);
  if (!un.length) p('（这次读取没有报"未确证"项。）');
  un.forEach((u, i) => p((i + 1) + '. ' + u));
  p('');

  // 附录 C：口径与复现
  p('## 附录 C：这份报告的口径');
  p('');
  p('- **节点数** = 图里 `#3` 块的个数（不是任何子字段）。**连线** = `#4`（引脚实例）→ `#5`（连接）→ `#1`（目标节点索引）。');
  p('- **坐标两个口径**：总览里的主口径是 **x、y 都有**（本关 ' + st.xyBoth + ' / ' + st.nodeCount + '）；'
    + '另给"任一有"（' + st.xyAny + '）。读取层只认字段 `#5`(x)/`#6`(y) 的 float32 —— '
    + '**只出现一个坐标的节点就是 `.gil` 里只有那一个字段**（数据事实），不是漏读。');
  p('- **节点官方名字**：拿 `shell_ref` / `kernel_ref` 的 `runtimeId` 去**官方节点词典**查（`75 = 以GUID查询实体` 这类）；');
  p('  词典 id 与 `.gil` 里的**节点声明号**（`1073741xxx`）**不是一套**，别互相套。');
  p('- **引脚 kind 号 ↔「输入/输出参数」名字未确证** ⇒ 一律只印号。');
  p('- 复现：' + (o.command ? '`' + o.command + '`' : '见仓库 `tools/gil-node-report.mjs`'));
  p('');
  return L.join('\n');
}
