/**
 * `miliastra_map` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';

import { ReceiptCode, fail } from '../receipt.mjs';
import { actionsOf, anatomyTotals, graphAnatomy, graphOwnerNote, triggersOf } from '../nodegraph.mjs';
import { MOUNTED_ON_NOTE, chooseLua, classifyControls, pickedFields, resolveLevel } from '../shared.mjs';
import { clientUiSubtree, compareScriptSnapshot, extractStrings, pickScriptMapping, readGil, renderClientUI, subtreeNodeCount } from '../gil.mjs';
import { inspect } from '../codefile.mjs';
import { nodeById, nodeDbFacets, nodeDbMeta, searchNodes } from '../nodedb.mjs';
import { readGilNodeFacts, signalInventory } from '../gilnodes.mjs';
import { snapshotFreshness } from '../freshness.mjs';

/**
 * `op=clientui` 的 hint —— **本关的数据**与**别处的实测**分成两句话说，绝不同框。
 *
 * 只负责「**本关读到的** + **实测佐证（带来源）**」这两段；前面那几句通用说明由调用方拼接
 * （那几句与数据无关，抄到这里会在回执里整段重复 —— 真机复核时当场抓到过）。
 *
 * 判据很简单：`likelyTemplates` 是从**这张图的 .gil** 里读出来的（真数据，只报本关的）；
 * `CLIENTUI_EVIDENCE` 是**另一张图**上跑出来的结论，永远带上它的关卡 ID。
 * 只有当前关卡**就是**那次实测的那张图时，才允许说「本关」。
 *
 * @param {{levelId?: any, likelyTemplates?: any[]}} [input] `levelId` = 本关关卡 ID；
 *        `likelyTemplates` = 本关读到的独立控件（`{id, name}`）
 * @returns {string}
 */
export function clientUiHint({ levelId = null, likelyTemplates = [] } = {}) {
  const tmpl = Array.isArray(likelyTemplates) ? likelyTemplates : [];
  const ev = CLIENTUI_EVIDENCE;
  const isEvidenceLevel = levelId != null && String(levelId) === String(ev.levelId);
  const parts = [
    // ① **本关自己的数据**：只报从这张图的 .gil 里读出来的号
    tmpl.length
      ? '**本关读到的**独立控件（' + (levelId != null ? '关卡 ' + levelId + '，' : '') + tmpl.length + ' 条）：'
        + tmpl.map((t) => t.id + '(' + t.name + ')').join(' / ') + '。'
      : '**本关没有读到**任何「无父节点 + 名字是控件类型」的记录 —— 这张图多半还没把控件「存为模板」。',
    // ② **别处的实测**：来源写在最前面，不是本关的就明说不是
    '真机实测佐证（来源：' + (isEvidenceLevel ? '**本关**' : '**关卡 ' + ev.levelId + '**')
      + ' ' + ev.where + '）：' + ev.creatable.map((c) => c.id + '(' + c.name + ')').join(' / ') + ' 可创建，'
      + ev.notCreatable + '。',
  ];
  if (!isEvidenceLevel) {
    parts.push('⚠️ 上面那几个号**来自关卡 ' + ev.levelId + ' 的实测，不是本关的** —— '
      + '本关要用哪个号，以「本关读到的」那一份为准；确证某个号能不能创建，用试玩探针「试钥匙」跑一次。');
  }
  return parts.join('');
}

/**
 * 子树的**深度**（根 = 0；叶子回 0）。贪婪扫（`op=clientui kind:"all"`）用。
 * @param {any} node `clientUiSubtree()` 的产物
 */
export function maxDepthOf(node) {
  if (!node) return 0;
  let d = 0;
  for (const c of node.children || []) d = Math.max(d, maxDepthOf(c) + 1);
  return d;
}

/**
 * 取一个文件的 mtime（毫秒）；取不到就 `null`。
 * P0-2 用它给「这份快照属于哪一次」定位 —— 取不到时 `snapshotFreshness` 会**明说没有证据**，不猜。
 */
export function statMsSafe(p) {
  if (!p) return null;
  try { return fsMod.statSync(p).mtimeMs; } catch { return null; }
}

/**
 * 「哪些号真的能被创建」的**一次真机实测记录** —— 必须连**来源关卡**一起说，否则就是假事实。
 *
 * 同事实测（2026-09-25）：`op=clientui` 的 hint 里写死了「实测佐证：**本关** 1073741867(文本框) /
 * 1073741868(图片) 可创建」，而他那张图的 likelyTemplates 是 1073741850/1852/1854/1846 ——
 * 那两个号**来自另一张图**的实测。「本关 + 别人的号」看起来就是一条事实，最容易被当真。
 */
export const CLIENTUI_EVIDENCE = {
  /** 那次实测是在**哪张图**上做的（不许省掉——省掉就变成"本关"了）。 */
  levelId: '1073741833',
  where: '《冰镜·火烛》那次真机实测',
  creatable: [
    { id: 1073741867, name: '文本框' },
    { id: 1073741868, name: '图片' },
  ],
  notCreatable: '1073741863~1866（画布上摆的实例）一律返回 nil',
};

export const MAP_TOOL = {
    name: 'miliastra_map',
    description:
      TITLE + '：读地图存档 `<关卡ID>.gil`（protobuf，含脚本源码快照）。op=summary 关卡/版本/账号/脚本映射；op=clientui **客户端控件谱系**（控件模板索引 / 名字 / 父 / 子）——判断「哪些控件能被脚本动态创建」的唯一正解：**只有「无父节点」的独立控件（存为模板）才可能被 InstantiateClientUIControl 创建**，画布上摆的实例与模板控件的子节点一律 nil。op=script 比对地图里嵌的源码与本地活文件（`belongsTo`/`isCurrent`：**`.gil` 是存盘那一刻的快照**）；op=strings 提可读字符串。\n★ **op=nodedb**：查**官方节点词典**（558 节点：中英名 / 标识 / 服务端·客户端 / 分类 / 端口，来源 = 参考项目 Pack，MIT）。⚠️ 词典 id 与 `.gil` 里的**声明号不是一套**（不能互翻）。\n★ **op=nodes**：读**节点图**与**实体自定义变量**（回答「节点图/原件有没有正确挂载」）；默认粗略档（计数 + 一行 `brief`），要明细传 `graph`/`entity`。⚠️ 字段号有出处**但未逐个真机确证**，不确定的原样回数字并进 `unverified`。\n★ **op=anatomy**：节点图**能力画像** —— 各类型节点多少个（事件/执行/查询/运算/分支；词典没收录但 id 命中**本关声明**的归「复合/自定义节点」，都不中才算 Unknown）+ 每张图的**入口事件** + **引用了哪些实体·声明** + 关键词。\n★ **多脚本工程**：`op=script` 的 `mappings[]` 列全部映射；`embedded` = 按名字挑中本次那一份。\n\n**典型调用**：`{"op":"summary"}`｜`{"op":"clientui","summaryOnly":true}`｜`{"op":"nodes","graph":"关卡实体信号"}`｜`{"op":"anatomy","summaryOnly":true}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['summary', 'clientui', 'audit-template', 'script', 'strings', 'nodes', 'anatomy', 'regions', 'nodedb'],
          description: '默认 summary。`nodes`=节点图/实体/元件/场景物件明细；`anatomy`=节点图能力画像；`regions`=顶层区地图。',
        },
        q: { type: 'string', description: 'op=nodedb：搜节点关键词（中/英/标识符；空格=AND）。不给 q 只回分类清单与计数。' },
        nodeId: { type: 'number', description: 'op=nodedb：按**官方节点 id** 取一条（与 .gil 里的声明号不是一套）。' },
        /* ★ 2026-10-07：**当初被 34 KB 棘轮拦下的那个参数** —— 实现早就在（`op=clientui` 读 `args.root`），
         *   但加它会顶穿棘轮 ⇒ 只能留在代码里 ⇒ **AI 看不到 = 调不出来**。硬线放宽到 50 KB 后补回来。 */
        root: { type: 'number', description: 'op=clientui：点名一个控件 id，回它的**整棵子树**（递归子控件，防环）。' },
        system: { type: 'string', enum: ['Server', 'Client'], description: 'op=nodedb：只看服务端 / 客户端节点。' },
        domain: { type: 'string', description: 'op=nodedb：按分类过滤（Execution / Control / Query / Arithmetic / Trigger …）。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡。' },
        file: { type: 'string', description: 'op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。' },
        kind: { type: 'string', enum: ['graphs', 'entities', 'components', 'decls', 'defs', 'all'], description: 'op=nodes 看哪一块：默认 graphs（节点图）；entities=实体（含量与种类号）；components=元件；decls=节点声明表（自定义节点）；defs=配置条目（职业/成长曲线/连段/状态）+ 阵营 + 资源分类树；all=全给。' },
        graph: { type: 'string', description: 'op=nodes：只看名字含这个子串的**节点图**（如 `关卡实体信号`）；**点名时额外回该图的逐节点明细**（`nodes`：索引/引用/引脚 kind/坐标/官方名字）；不给就只列图。' },
        entity: { type: 'string', description: 'op=nodes：要哪个**实体的自定义变量**（名字子串，如 `关卡实体`）——给了才回逐条 `variables[]`。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=clientui：省掉 `records` 与 `rendered`，只留计数与「可能能动态创建的模板」。op=nodes：省掉逐条 `graphs[]`/`entities[]`，只留计数 + `kinds` + 一行 `brief`。默认 false。',
        },
        path: { type: 'string', description: '直接指定 .gil 绝对路径（跳过自动定位）。' },
        limit: { type: 'number', description: 'op=strings：最多返回多少条（默认 200）。op=nodes：最多列几张图 / 几个实体（默认 40 / 20）。' },
        match: { type: 'string', description: 'op=strings：子串过滤。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'summary');
      // ★ op=nodedb 与地图无关（**不要求 .gil**）—— 词典是随包发的静态数据
      if (op === 'nodedb') {
        const meta = nodeDbMeta();
        if (args.nodeId != null) {
          const one = nodeById(Number(args.nodeId));
          return {
            ok: true, op, nodeId: Number(args.nodeId), found: !!one, node: one || undefined,
            meta: { source: meta.project, license: meta.license, copyright: meta.copyright, dbVersion: meta.dbVersion, gameVersion: meta.gameVersion },
            unverified: meta.unverified,
            nextStep: one ? undefined : '这个号在词典里没有 —— 确认是**官方节点 id**（<=300004），不是 .gil 里的声明号。',
          };
        }
        const r = searchNodes({ q: args.q || '', system: args.system, domain: args.domain, limit: args.limit });
        const facets = nodeDbFacets();
        const detail = args.summaryOnly !== true;
        return {
          ok: true, op, q: args.q || null, filter: { system: args.system || null, domain: args.domain || null },
          total: r.total, returned: r.returned,
          meta: { source: r.meta.project, license: r.meta.license, copyright: r.meta.copyright, dbVersion: r.meta.dbVersion, gameVersion: r.meta.gameVersion, counts: r.meta.counts },
          facets: { domains: facets.domains, server: facets.server, client: facets.client },
          nodes: detail ? r.rows : undefined,
          nodesOmitted: detail ? undefined : r.total,
          unverified: r.unverified,
          nextStep: '搜关键词传 `q:"玩家实体"`（中英/标识符都行）；按分类过滤传 `domain:"Query"`；看客户端节点传 `system:"Client"`；要端口明细别传 summaryOnly（默认就给逐条端口：方向/标签/类型/shellIndex）。',
        };
      }
      const gilPath = args.path || (() => {
        const lv = resolveLevel(args.level);
        if (!lv.gil) return fail(ReceiptCode.NOT_FOUND, `关卡 ${lv.levelId} 下没有 .gil。`, {

          nextStep: '先在编辑器里存一次盘（.gil 是存盘时才写的），或显式传 level= 指定另一张图。',

        });
        return lv.gil.path;
      })();
      if (op === 'strings') {
        const fs = await import('node:fs');
        const rows = extractStrings(fsMod.readFileSync(gilPath));
        const filtered = args.match ? rows.filter((r) => r.text.includes(String(args.match))) : rows;
        const limit = Number.isFinite(args.limit) ? args.limit : 200;
        return { ok: true, op, path: gilPath, total: rows.length, returned: Math.min(limit, filtered.length), rows: filtered.slice(0, limit) };
      }
      if (op === 'anatomy') {
        /*
         * ★ 2026-10-02 新增（作者：「希望读取到有多少的各类型节点（事件 x 个 / 执行 x 个）」+
         *   「做个快速判断当前节点图用来做啥的能力：入口 / 关键词 / 引用」）。
         *   只读：一次 readGilNodeFacts + 纯函数（`lib/nodegraph.mjs`，吃随包节点词典 558 条）。
         *   ⚠️ 类型分布**只覆盖词典命中的节点**（本机恐怖-V3：1119 个节点里命中 548）—— 未命中的按 `Unknown`
         *   如实计数，`coverage` 里写清，别把它读成"这张图就这么点节点"。
         */
        const gq = args.graph ? String(args.graph) : '';
        const facts = readGilNodeFacts(gilPath, { graphLimit: 400, entityLimit: 1 });
        if (!facts.ok) return { ok: false, op, code: ReceiptCode.FAILED, path: gilPath, error: facts.error };
        const graphNames = Object.keys(facts.graphNodeLists || {});
        const picked = gq ? graphNames.filter((n) => n.includes(gq)) : graphNames;
        if (gq && !picked.length) {
          return {
            ok: false, op, code: ReceiptCode.FAILED, path: gilPath,
            error: '没有图名含「' + gq + '」的节点图',
            candidates: graphNames.slice(0, 40),
          };
        }
        const anatomies = picked.map((name) => {
          const g = (facts.graphs || []).find((x) => x.name === name) || { name };
          const nodes = (facts.graphNodeLists || {})[name] || [];
          const edges = nodes.reduce((s, nd) => s + ((nd.outEdges || []).length), 0);
          // 传本关声明表：词典命不中但 id 命中本关声明的节点会被归成「复合节点 / 自定义节点」（能确证的归属）
          return graphAnatomy(g, nodes, { edges: new Array(edges), declarations: facts.declarations || [] });
        });
        const totals = anatomyTotals(anatomies);
        let known = 0;
        for (const a of anatomies) known += a.typeStats.known;
        const out = {
          ok: true, op, path: gilPath, size: facts.size,
          filter: { graph: gq || null },
          graphCount: anatomies.length,
          totals,
          coverage: {
            nodes: totals.nodes, typedNodes: known, untypedNodes: totals.nodes - known,
            note: '类型来自**随包节点词典**（`lib/nodedb.json`，558 条）里 `identifier` 的第一段；'
              + '词典没收录的节点再看它的 id **是不是本关卡内的声明**（是 ⇒ 归「复合节点 / 自定义节点」，这是能确证的归属）；'
              + '两边都命不中的才计 `Unknown` —— **想提高覆盖要给词典补条目，别猜类型**。',
          },
          customNodes: {
            composite: totals.byType.Composite || 0, custom: totals.byType.Custom || 0,
            fromDeclarations: (totals.byType.Composite || 0) + (totals.byType.Custom || 0),
            declarationsInMap: (facts.declarations || []).length,
            note: '这些节点的类型不是官方分类（一个自定义/复合节点里可能包着任意逻辑），'
              + '只能确证到"它属于本关的哪条声明"；要展开看它内部，用 `op:"nodes"` 逐节点看。',
          },
          anatomyNote: graphOwnerNote(),
          graphs: args.summaryOnly === true ? undefined : anatomies.map((a) => ({
            name: a.graph.name,
            id: a.graph.id == null ? null : a.graph.id,
            type: a.graph.typeLabel || null,
            // ★ 挂载主（作者 2026-10-02 给的编辑器线索）：via=mount 是**已确证**形状，via=ref 是"记录里别处指向这张图"
            owners: (facts.graphOwners || {})[a.graph.id] || [],
            nodeCount: a.nodeCount,
            edgeCount: a.edgeCount,
            byType: a.typeStats.byTypeLabel,
            bySide: a.typeStats.bySide,
            sideUnknown: a.typeStats.unknown,
            triggers: a.triggers.map((t) => t.name),
            refs: { entities: a.refs.entities, others: a.refs.others },
            keywords: a.keywords,
            brief: a.brief,
          })),
          brief: '整关 ' + totals.nodes + ' 个节点（' + totals.graphs + ' 张图）：' + totals.byTypeLabelText
            + '　·　词典覆盖 ' + known + '/' + totals.nodes,
          /* ★ 2026-10-02（作者问「能不能读取结构体 还有信号」）：
           *   信号 = **能读**（`#10.#2` 引用表 − 固定引脚名 − 现场前缀 `侦_`，口径是启发式，见 `signalInventory` 的 unverified）；
           *   结构体 = **读不到定义**（同表里有「结构体」字样，但字段名+类型没找到）⇒ 如实说，不编。 */
          signals: (args.summaryOnly === true) ? undefined : signalInventory(facts),
          mountSummary: {
            graphsWithOwner: Object.keys(facts.graphOwners || {}).length,
            graphsTotal: (facts.graphs || []).length,
            entityRecords: (facts.mounts && facts.mounts.entities || []).length,
            componentRecords: (facts.mounts && facts.mounts.components || []).length,
            note: '挂载主从**实体/元件记录**里读（`#13` 形状 = 已确证；另有"别处指向"的记 `via:"ref"`）。'
              + '⚠️ 技能图 / 状态图挂在别的区 ⇒ 没找到时只能说"**这两个区里**没找到"。',
          },
          nextStep: '要整关一张表：`op:"anatomy"`；只看某张图：`+graph:"<图名子串>"`；'
            + '要看某张图的节点明细与引脚连线：`op:"nodes", graph:"<图名>"`；'
            + '**「谁身上挂着这张图」看每条图的 `owners[]`**（`via:"mount"` 已确证 / `via:"ref"` 口径未确证）。',
        };
        out.caveats = [
          '类型分布基于**随包节点词典**：`identifier` 第一段（`Trigger./Execution./Query./Arithmetic./Control./Others./Hidden.`）为准，'
          + '与词典 `domain` 字段互相印证（558 条里一致 555 条）；词典没收录的节点 ⇒ `Unknown`（不明说就不算数）。',
          '`refs` 的方向是「**这张图的节点引用到了谁**」，**不是**「谁身上挂着这张图」—— 后者 `.gil` 里读不出来（见 `anatomyNote`）。',
        ];
        return out;
      }
      if (op === 'regions') {
        /*
         * ★ 2026-10-02 新增（作者问「实体也是 这都是啥」）：把 `.gil` 的**顶层区地图**摊开 ——
         * 每个区多少字节 / 多少条目 / 样例名字 / **已知区名**（未确证的一律 label:null，不编名字）。
         * 这是"这张图里到底都有些什么"的自助入口，也是发现"某个区我没解"的最快方式。
         */
        const facts = readGilNodeFacts(gilPath, {});
        if (!facts.ok) return { ok: false, op, code: ReceiptCode.FAILED, path: gilPath, error: facts.error };
        const slim = args.summaryOnly === true;
        return {
          ok: true, op, path: gilPath, size: facts.size,
          regionCount: facts.regionMap.length,
          regions: facts.regionMap.map((r) => (slim ? {
            field: r.field, label: r.label, bytes: r.bytes, itemCount: r.itemCount,
          } : r)),
          counts: {
            entities: facts.entityCount, components: facts.componentCount, graphs: facts.graphCount,
            declarations: facts.declarationCount, configs: facts.configCount,
            sceneObjects: facts.sceneObjectCount, placedInstances: facts.placedCount,
            factions: (facts.factions || []).length,
          },
          note: '**区名只写已确证的**（未确证的一律 null，不编）；`bytes` 对解不成消息的裸块按内容长度算。'
            + '⚠️ 「实体 12 个」只是 `#5` 逻辑实体表 —— **场景静态**与**摆放实例**在别的区（`#27` / `#8`），`counts` 里一起给了。',
          nextStep: '要看场景物件/摆放实例的明细用 `op:"nodes", kind:"all", summaryOnly:false`（回执里带 `sceneObjects` / `placedInstances`）。',
        };
      }
      if (op === 'nodes') {
        /*
         * ★ 2026-10-01 新增（作者：「有时候我不知道服务端的节点图或者原件到底有没有正确挂载」）。
         *   只读：一次 findProtobufRoot + 纯函数（`lib/gilnodes.mjs`），不写任何文件。
         *   `kind` 选看哪一块：graphs（默认）/ entities / components / all；默认**粗略档**（计数 + 一行 brief）。
         */
        const kind = String(args.kind || 'graphs');
        const wantDeclsEarly = kind === 'decls' || kind === 'all';
        const gq = args.graph ? String(args.graph) : '';
        const eq = args.entity ? String(args.entity) : '';
        const wantVars = !!eq || args.summaryOnly === false;
        const facts = readGilNodeFacts(gilPath, {
          graphLimit: Number.isFinite(args.limit) ? Number(args.limit) : 200,
          entityLimit: Number.isFinite(args.limit) ? Number(args.limit) : 400,
          withVariables: wantVars,
        });
        if (!facts.ok) return { ok: false, op, code: ReceiptCode.FAILED, path: gilPath, error: facts.error };
        const graphs = gq ? facts.graphs.filter((g) => g.name.includes(gq)) : facts.graphs;
        const entities = eq ? facts.entities.filter((e) => e.name.includes(eq)) : facts.entities;
        const detailed = args.summaryOnly === false || !!gq || !!eq;
        const out = {
          ok: true, op, path: gilPath, size: facts.size,
          kind,
          graphCount: facts.graphCount,
          kinds: facts.kinds,
          entityCount: facts.entityCount,
          totalVariables: facts.totalVariables,
          entityKindCodes: facts.entityKindCodes,
          entityKindLabels: facts.entityKindLabels,
          componentCount: facts.componentCount,
          // ★ 场景静态 / 摆放实例（2026-10-02）：别让"实体 N 个"被读成"这张图只有 N 个东西"
          sceneObjectCount: facts.sceneObjectCount,
          placedCount: facts.placedCount,
          sceneObjects: (detailed && facts.sceneObjects) ? facts.sceneObjects.slice(0, Number.isFinite(args.limit) ? Number(args.limit) : 200) : undefined,
          placedInstances: (detailed && facts.placedInstances) ? facts.placedInstances : undefined,
          // ★ 截断如实报（作者 2026-10-02 抓到"元件只回 40 个"）：任何一块被截了都在这里说
          truncated: facts.truncated,
          configCount: facts.configCount,
          signalRefCount: facts.signalRefCount,
          configLinked: facts.configLinked,
          declarationCount: facts.declarationCount,
          compositeCount: facts.compositeCount,
          declarationStats: facts.declarationStats,
          // ★ 挂载关系（2026-10-02 补）：概略恒给；明细档才给逐条（免得粗略档回执爆掉）
          mountSummary: facts.mounts ? {
            graphsWithOwner: Object.keys(facts.graphOwners || {}).length,
            graphsTotal: facts.graphs.length,
            entityRecords: facts.mounts.entities.length,
            componentRecords: facts.mounts.components.length,
            note: '挂载主从**实体/元件记录**读（`#13` 形状已确证 ⇒ `via:"mount"`；"别处指向"记 `via:"ref"`，口径未确证）。'
              + '⚠️ 技能图/状态图挂在别的区 ⇒ 没找到只能说"**这两个区里**没找到"。',
          } : undefined,
          mounts: (detailed && facts.mounts) ? {
            entities: facts.mounts.entities, components: facts.mounts.components,
            graphOwners: facts.graphOwners,
          } : undefined,
          mountsOmitted: (detailed || !facts.mounts) ? undefined
            : (facts.mounts.entities.length + facts.mounts.components.length),
          filter: { kind, graph: gq || null, entity: eq || null },
          brief: facts.brief,
          caveats: [
            '`nodeCount` 取的是**图体自己声明**的那个数；`linkCount` 是数出来的**图体连线记录条数**（疑似连线，语义未逐个确证）—— 都当"粗略数字"看。',
            '实体**种类号**：有出处的按 `kindLabels` 给名字（来源写在 `kindLabelSource`：资源分类树 #6 的分类名「玩家模版」「职业」等 ref id 命中）；'
            + '**没出处的照旧只回原始号**（见 `kindLabelsUnverified`），名字带"模版"的另标 `roleGuess.guess:true`。',
          ],
          unverified: facts.unverified.length ? facts.unverified : undefined,
          nextStep: '看某张图传 `graph:"<图名子串>"`（如 `关卡实体信号`）；看某个实体的变量传 `entity:"<实体名子串>"`（如 `关卡实体`）；'
            + '要配置条目（职业/成长曲线/连段/状态）+ 阵营 + 资源树传 `kind:"defs"`；要节点声明表（自定义节点）传 `kind:"decls"`；'
            + '要元件/实体/图/声明一起看传 `kind:"all"`；**要"哪张图挂在哪个实体/元件上"看 `mountSummary` / 明细档的 `mounts.graphOwners`**；'
            + '只要计数就别传参数（默认粗略档）。',
        };
        // 按 kind 决定回哪一块（默认 graphs；`all` 全给；给了 graph/entity 过滤就按过滤给明细）
        const wantGraphs = kind === 'graphs' || kind === 'all' || !!gq;
        const wantEnts = kind === 'entities' || kind === 'all' || !!eq;
        const wantComps = kind === 'components' || kind === 'all';
        if (wantGraphs) {
          /*
           * ★ 2026-10-02 加：每条图**就地补上**「入口事件 / 会做哪些事 / 挂载在谁身上」——
           * 作者问「挂在 XX 上的图能做到什么」。数据全在**已经读进来的** `graphNodeLists` 与 `graphOwners` 里，
           * **不用再读一遍 `.gil`**（面板/回执都能直接渲染，不用二次调用）。
           */
          out.graphs = detailed ? graphs.map(function (g) {
            const nodes = (facts.graphNodeLists || {})[g.name] || [];
            const acts = actionsOf(nodes, { limit: 8 });
            return Object.assign({}, g, {
              owners: (facts.graphOwners || {})[g.id] || [],
              entryEvents: triggersOf(nodes).map((t) => t.name),
              actions: acts.names,
              actionTotal: acts.total,
              actionUnknown: acts.unknown,
              nodeKnown: nodes.length,
            });
          }) : undefined;
          if (!detailed) out.graphsOmitted = graphs.length;
          // ★ 点名某张图时，把它的**节点明细**一起回（作者：「我想要每一个节点都能被点到，而不是总和」）
          if (gq) {
            const pick = Object.keys(facts.graphNodeLists || {}).filter(function (k) { return k.includes(gq); });
            const nodeDetail = {};
            const edgeDetail = {};
            for (const k of pick) {
              nodeDetail[k] = facts.graphNodeLists[k];
              edgeDetail[k] = facts.graphNodeLists[k].flatMap(function (n) { return n.outEdges || []; });
            }
            out.nodes = nodeDetail;
            out.edges = edgeDetail;
            out.nodeTotal = pick.reduce(function (s, k) { return s + nodeDetail[k].length; }, 0);
            out.edgeTotal = pick.reduce(function (s, k) { return s + edgeDetail[k].length; }, 0);
            out.nodesNote = '每节点给：index / declaredIndex / shell·kernel 引用 / x·y 坐标 / pins（引脚实例）/ outEdges（出边）/ '
              + 'doc（拿 runtimeId 去官方节点词典查到的名字，查不到为 null）。'
              + '**连线**：edges[图名] = [{from, to, toShell, toKernel, fromPinKind}]，与 gia.proto 的 NodeConnection 一致'
              + '（2026-10-01 在 266 节点的图上钉出来：连接挂在引脚的字段 5，字段 1 = 目标节点索引）。'
              + '⚠️ 仍未确证的：引脚 kind 号到"输入/输出参数"的**名字**、节点字段 7（附加块）的语义、引脚值（valueRef）。';
          }
        }
        if (wantEnts) {
          out.entities = detailed ? entities : entities.map((e) => ({ name: e.name, id: e.id, kindCode: e.kindCode, kindEcho: e.kindEcho, componentCount: e.componentCount, variableCount: e.variableCount }));
          out.variablesOmitted = eq ? undefined : true;
        }
        if (wantComps) out.components = facts.components;
        if (wantDeclsEarly) out.declarations = facts.declarations;
        if (kind === 'defs' || kind === 'all') {
          out.configCount = facts.configCount;
          out.configs = facts.configs;
          out.configLinked = facts.configLinked;
          out.factions = facts.factions;
          out.spawns = facts.spawns;
          out.presets = facts.presets;
          out.resourceCategories = facts.resourceCategories;
          out.resourceTree = facts.resourceTree;
          out.semantics = facts.semantics;
          out.semanticMeaningful = facts.semanticMeaningful;
          out.signalRefCount = facts.signalRefCount;
          out.signalWords = facts.signalWords;
        }
        return out;
      }
      const gil = readGil(gilPath);
      if (!gil.ok) return { ok: false, op, code: ReceiptCode.FAILED, path: gilPath, error: gil.error };
      if (op === 'summary') {
        const c = classifyControls(gil.clientUI);
        // 「真正的模板」= 独立、且不是容器节点（容器节点那几条是画布根节点）
        const templates = c.likelyTemplates.filter((r) => r.name !== '容器节点');
        return {
          ok: true, op, path: gilPath, size: gil.size,
          level: gil.level, account: gil.account, version: gil.version,
          // ↓ 2026-09-23 新增的三项「静态读」：不用试玩、不碰任何文件
          clientVersion: gil.versionInfo ? gil.versionInfo.client : null,
          resourceVersions: gil.versionInfo ? gil.versionInfo.resources : null,
          levelConfig: gil.levelConfig,
          sceneObjectCount: gil.sceneObjects ? gil.sceneObjects.count : null,
          sceneObjectSample: gil.sceneObjects ? gil.sceneObjects.sample : null,
          script: gil.script ? { name: gil.script.name, file: gil.script.file, mappingId: gil.script.mappingId, sourceBytes: gil.script.sourceBytes, sourceSha256: gil.script.sourceSha256 } : null,
          controlCount: gil.clientUI.length,
          templateCount: templates.length,
          templates,
          likelyTemplates: c.likelyTemplates,
          likelyContainers: c.likelyContainers,
          standaloneControls: c.standalone.map((r) => ({ id: r.id, name: r.name })),
          dynamicCreateLikelyBroken: templates.length === 0,
          warning: templates.length === 0
            ? '⚠️ 地图里没有发现「存为模板」的独立客户端控件（图片 / 文本框 / …）。'
              + '若脚本用 game.InstantiateClientUIControl 动态创建控件，现在会对任何索引号都返回 nil —— '
              + '请到「界面控件组管理 → 界面控件组库 → 客户端控件模板 →【添加客户端控件】→ 存为模板」，各存一条独立模板，然后保存地图。'
            : null,
        };
      }
      if (op === 'clientui') {
        const c = classifyControls(gil.clientUI);
        /*
         * ★★ 2026-10-02（作者：「**模板子树**这个估计要开发下 —— 现在只有**最顶层**的客户端模板能读取到，要**递归子树**」）：
         *   子控件 id 本来就在记录里（`#503` → `children`），这里**按它递归展开**。
         *   · `subtreeOf` 给某个 id 的整棵子树（作者点名的 5 个素材各有 A/B 两条同名记录，靠子树才分得清）；
         *   · 默认回执里给**每条 standalone 的子树节点数**（大子树只给计数 + `subtreeTruncated`，体积有界；
         *     `summaryOnly` 时连这个也不给）。
         */
        const subtreeOf = (id) => clientUiSubtree(gil.clientUI, id);
        const countOf = (id) => subtreeNodeCount(subtreeOf(id));
        const bound = 40;                      // 单棵子树节点数上限（超过只给计数，防回执爆掉）
        const withTree = (r) => {
          const n = countOf(r.id);
          return Object.assign({}, r, n <= bound
            ? { subtree: subtreeOf(r.id), subtreeNodes: n }
            : { subtreeNodes: n, subtreeTruncated: '子树 ' + n + ' 个节点（> ' + bound + '）⇒ 省略正文，要正文请点名 `root=' + r.id + '`' });
        };
        const base = {
          ok: true, op, path: gilPath,
          level: gil.level,
          count: gil.clientUI.length,
          likelyTemplates: c.likelyTemplates.map(withTree),
          likelyContainers: c.likelyContainers,
          structural: c.structural,
          hint: '能被 game.InstantiateClientUIControl 创建的，只有「在客户端控件模板库里【添加客户端控件】存为模板」的独立控件。'
            + '本工具把「无父节点 + 名字是客户端控件类型」的记为 likelyTemplates；'
            + '其中 容器节点 那几条通常是客户端控件容器的画布根节点（不是模板），真正的模板看 图片 / 文本框 这类。'
            // ⚠️ 这段文案由 clientUiHint() 生成：**本关的数据**与**别处的实测**分两句、带来源，
            //    不许再出现「本关 + 别的关卡的号」这种看起来是事实的误导（见 CLIENTUI_EVIDENCE）
            // ⚠️ `gil.level` 是 `{id, name}` 对象（不是数字）—— 传错会让 hint 里印出「关卡 [object Object]」
            + clientUiHint({ levelId: gil.level && gil.level.id, likelyTemplates: c.likelyTemplates }),
        };
        if (args.summaryOnly === true) {
          // 全量 `records` + `rendered` 是 37 条控件 × 多列，光扫一眼就要几千字符
          return {
            ...base,
            standaloneCount: c.standalone.length,
            /* ★ `root` 与 `summaryOnly` 同时给时必须仍回子树 —— "点名一个 id 只要子树"本来就是最省的用法。 */
            ...(args.root != null && args.root !== '' ? { subtree: subtreeOf(Number(args.root)) } : {}),
            note: 'summaryOnly：省掉了 `records`（每条控件一行）与 `rendered`（谱系文字），'
              + '只留计数与「可能能动态创建的模板」。要全量就去掉 summaryOnly。',
          };
        }
        /*
         * ★★ 2026-10-02（作者：「**贪婪模式**都通过插件能扫出来」）：
         *   `kind:"all"` = **贪婪扫** —— 把**每一条** standalone 记录的**完整子树**都摊开（不再受 40 节点上限），
         *   外加一份 `greedy` 汇总（总节点数 / 最深 / 名字直方图 / 谁是叶子）。
         *   ⚠️ **不新增 schema 参数**：复用已有的 `kind`（枚举里本来就有 `all`）与 `limit`（默认 200 棵树，`limit:0` = 不限）。
         *   ⚠️ 回执会很大（本机 `1073741842`：90 条 standalone、单棵最大 197 节点）⇒ 要计数就用 `summaryOnly`。
         */
        if (String(args.kind || '') === 'all') {
          const cap = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 200;
          const all = c.standalone.map((r) => {
            const tree = subtreeOf(r.id);
            const nodes = subtreeNodeCount(tree);
            const nameAcc = {};
            (function walk(n) { nameAcc[n.name || '?'] = (nameAcc[n.name || '?'] || 0) + 1; for (const k of n.children || []) walk(k); })(tree);
            return { rootId: r.id, name: r.name, role: (c.likelyTemplates.some((t) => t.id === r.id) ? 'likelyTemplate' : 'other'), nodes, depth: maxDepthOf(tree), names: nameAcc, tree };
          }).sort((a, b) => b.nodes - a.nodes);
          const shown = cap > 0 ? all.slice(0, cap) : all;
          return {
            ok: true, op, path: gilPath, level: gil.level,
            greedy: {
              controlCount: gil.clientUI.length,
              standaloneRoots: all.length,
              treesShown: shown.length,
              treesOmitted: all.length - shown.length,
              totalNodes: all.reduce((s, t) => s + t.nodes, 0),
              biggest: all.length ? { rootId: all[0].rootId, name: all[0].name, nodes: all[0].nodes, depth: all[0].depth } : null,
              note: '贪婪扫：每条 standalone 记录的**完整子树**都摊开（不再有 40 节点上限）。'
                + '⚠️ `nodes` 是**整棵子树**的节点数（含深层），不是"直接子控件数"（那看 `tree.childCount`）。',
            },
            trees: shown,
            hint: base.hint,
          };
        }
        return {
          ...base,
          /* ★ 每条 standalone 的**子树节点数**（不展开正文）—— 一眼看出"A 条带几个子控件、B 条带几个" */
          standalone: c.standalone.map((r) => ({ id: r.id, name: r.name, childCount: (r.children || []).length, subtreeNodes: countOf(r.id) })),
          records: gil.clientUI, rendered: renderClientUI(gil),
          /* ★ 点名某条 id 时给**整棵子树**（不限深；防环/限深在 clientUiSubtree 里）。
           *   ⚠️ 没点名时**不许留 `subtree: undefined`** —— lossless 契约会判它（smoke 抓到过）。 */
          ...(args.root != null && args.root !== '' ? { subtree: subtreeOf(Number(args.root)) } : {}),
        };
      }
      if (op === 'audit-template') {
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 6 条「内置模板审计」）：作者本轮为回答
         *   "模板组件是否都用 id/名字引用""`?` 是哪个节点""槽位在哪"，手写了 3 个一次性脚本解析 gil dump。
         *   这里把那些问法固化成一条 op（**全部来自 `.gil` 记录本身，不猜**）：
         *     · `tree`            = 子树（递归子控件；`nodeId` 给根，缺省取「名字含 `q`」或第一个独立控件）
         *     · `map`             = id → { name, parent, 深度 } 便于对照代码里的引用
         *     · `sameNameSameParent` = **同父重名**（`GetChild(名字)` 会歧义 ⇒ 必须用 id 或改名字）
         *     · `duplicateRoots`  = **同名多条独立控件**（就是 §7 那 5 组 A/B 记录的形态）
         *     · `idExists`        = 点名的 id 在不在记录表里
         *     · `nameRefs`        = 可选：`q` 给逗号分隔的名字清单，报「有 / 没有 / 有几条（歧义）」
         *   ⚠️ **图源**字段（"会不会渲染成 `?`"）目前**没逆出来** ⇒ 回执里明写 `imageSource: 'unverified'`，**不编**。
         */
        const recs = gil.clientUI || [];
        const byId = new Map(recs.map((r) => [r.id, r]));
        const depthOf = (id) => { let d = 0; let cur = byId.get(id); const seen = new Set(); while (cur && cur.parent != null) { if (seen.has(cur.id)) break; seen.add(cur.id); cur = byId.get(cur.parent); d += 1; if (d > 64) break; } return d; };
        const rootId = Number.isFinite(args.nodeId) ? Number(args.nodeId) : null;
        const q = args.q == null ? '' : String(args.q).trim();
        let root = rootId != null ? byId.get(rootId) : null;
        if (!root && q) root = recs.find((r) => r.parent == null && String(r.name || '').includes(q)) || null;
        if (!root && rootId == null && !q) root = recs.find((r) => r.parent == null) || null;
        // 同父重名（父可为 null = 独立控件那一层）
        const buckets = new Map();
        for (const r of recs) {
          const k = String(r.parent == null ? 'root' : r.parent) + '\u0000' + String(r.name || '');
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        }
        const sameNameSameParent = [...buckets.values()].filter((v) => v.length > 1)
          .map((v) => ({ parent: v[0].parent, name: v[0].name, count: v.length, ids: v.map((x) => x.id) }))
          .sort((a, b) => b.count - a.count);
        const nameHist = new Map();
        for (const r of recs) if (r.parent == null) nameHist.set(r.name, (nameHist.get(r.name) || 0) + 1);
        const duplicateRoots = [...nameHist.entries()].filter(([, n]) => n > 1)
          .map(([name, count]) => ({ name, count, ids: recs.filter((r) => r.parent == null && r.name === name).map((r) => r.id) }));
        const nameRefs = q && !root
          ? null
          : (q ? q.split(',').map((s) => s.trim()).filter(Boolean).map((nm) => {
            const hits = recs.filter((r) => String(r.name || '') === nm);
            return { name: nm, count: hits.length, ids: hits.map((r) => r.id), ambiguous: hits.length > 1 };
          }) : null);
        const tree = root ? clientUiSubtree(recs, root.id) : null;
        return {
          ok: true, op, path: gilPath, level: gil.level,
          controlCount: recs.length,
          rootId: root ? root.id : null,
          rootName: root ? root.name : null,
          tree,
          subtreeNodes: tree ? subtreeNodeCount(tree) : null,
          idExists: rootId != null ? byId.has(rootId) : null,
          parentOfRoot: root ? root.parent : null,
          depthOfRoot: root ? depthOf(root.id) : null,
          sameNameSameParent: args.summaryOnly === true ? sameNameSameParent.length : sameNameSameParent,
          sameNameSameParentCount: sameNameSameParent.length,
          duplicateRoots: args.summaryOnly === true ? duplicateRoots.length : duplicateRoots,
          duplicateRootsCount: duplicateRoots.length,
          nameRefs,
          /*
           * ★★ 图源（2026-10-04 逆出来了，**有对照证据**）：控件记录子树里落在**平台图片号段 100001~112042**
           *   的 varint = 该控件的图源号。证据：日志报 `图片图源=106045`，而 `.gil` 里 106045 **恰好出现 29 次**、
           *   且落在 29 条控件记录里 ⇒ **与运行时日志对得上**。名字含「图片」却没有号 ⇒ **会渲染成 `?`**。
           *   ⚠️ 字段号仍未钉死（只钉了"值域 + 在记录子树内"）⇒ 标 `heuristic`，但这对"有没有图"是可证伪的。
           */
          imageSource: 'heuristic-verified',
          imageSourceNote: '图源号 = 控件记录子树内落在**平台图片号段 100001~112042** 的 varint（`miliastra_asset op=catalog` 同号段）；'
            + '对照证据：日志报 `图片图源=106045`，`.gil` 里 106045 出现 29 次且落在 29 条控件里。'
            + '⚠️ 字段号未钉死 ⇒ 标 heuristic；但「**图片控件一个号都没有 ⇒ 会渲染成 `?`**」这条是可证伪的。',
          imageSourceMissingCount: (() => {
            const isImg = (n) => /图片|Image/i.test(String(n || ''));
            const walk = (node) => {
              let n = 0;
              if (isImg(node.name) && !(node.imageIds || []).length) n += 1;
              for (const c of node.children || []) n += walk(c);
              return n;
            };
            return tree ? walk(tree) : null;
          })(),
          imageSourceMissingSample: (() => {
            const isImg = (n) => /图片|Image/i.test(String(n || ''));
            const out = [];
            const walk = (node) => {
              if (out.length >= 20) return;
              if (isImg(node.name) && !(node.imageIds || []).length) out.push({ id: node.id, name: node.name });
              for (const c of node.children || []) walk(c);
            };
            if (tree) walk(tree);
            return out;
          })(),
          hint: '同父重名 ⇒ `GetChild(名字)` 有歧义（改用 id，或把名字改唯一）；同名多条独立控件 ⇒ '
            + '正是"另存为 / 复制一份"留下的形态（本轮 §7 的 5 组 A/B 记录就是这个）。',
          next: '看某个具体 id：`{"op":"audit-template","level":"<关卡>","nodeId":1073745047}`；'
            + '按名字找根：`{"op":"audit-template","q":"声望值"}`；比对代码引用：`q:"名字A,名字B"`（逗号分隔）。',
        };
      }
      if (op === 'script') {
        const cur = args.level || !args.path ? resolveLevel(args.level) : null;
        // 一个关卡可能有多个活文件 —— 比的是**指定/默认的那一个**，返回里带上「选了谁、凭什么」
        const pick = cur ? chooseLua(cur, args.file) : null;
        const live = pick ? pick.picked : null;
        let liveInfo = null;
        if (live) {
          const i = inspect(live.path);
          liveInfo = { name: live.name, path: live.path, size: i.size, sha256: i.sha256, mtime: i.mtime };
        }
        /*
         * ★ 多脚本工程（反馈 A1 / 实践文档 §2 第 2 条）：一张图的 `#50` 里有 **N 条**脚本映射，
         *   旧实现只回**第一条**（实测是旧占位「新建客户端脚本」），于是 `embedded` 与 6 个活文件
         *   "对不上"，`pickedNote` 只能让人去人工确认 —— 多脚本工程根本没法对账。
         *   现在：① `mappings` 给**全部**映射（含 mappingId / mountedOn）；② `embedded` 改成
         *   **按名字挑中本次那一份**；③ `candidates` 逐份列出「与哪条映射对上、哈希一致不一致」。
         */
        const all = Array.isArray(gil.scripts) ? gil.scripts : (gil.script ? [gil.script] : []);
        const mounts = gil.scriptMounts || { known: false, ids: [], byId: {}, note: null };
        const mappings = all.map((m) => ({
          mappingId: m.mappingId,
          name: m.name,
          file: m.file,
          bytes: m.sourceBytes,
          sha256: m.sourceSha256,
          mounted: Array.isArray(mounts.ids) && mounts.ids.indexOf(m.mappingId) >= 0,
          mountedOn: (mounts.byId && mounts.byId[m.mappingId]) || null,
          mountedOnNote: MOUNTED_ON_NOTE,
        }));
        const picked = liveInfo ? pickScriptMapping(all, liveInfo.name) : { mapping: null, matchedBy: null };
        // ② 同名才比哈希（名字对不上就是**另一个脚本**）；挑不到本次那一份时**退回第一条**并如实说明
        const embedded = picked.mapping || all[0] || null;
        const cmp = compareScriptSnapshot({
          embedded,
          live: liveInfo ? { name: liveInfo.name, path: liveInfo.path, sha256: liveInfo.sha256, size: liveInfo.size } : null,
        });
        const isMounted = (m) => !!m && Array.isArray(mounts.ids) && mounts.ids.indexOf(m.mappingId) >= 0;
        /*
         * ★ P0-2（2026-09-26）：`match` 比的是 **`.gil` 里那份存盘快照** ↔ 本地活文件 ——
         *   快照可能是**上一次存盘**时的内容。所以除了 `match`，还要回答「这份快照属于哪一次存盘、是不是当前那一份」
         *   （与 `miliastra_log` 的 `staleLog` / `logBelongsTo` 同一个口径）。
         *   ⚠️ 拿不到 `.gil` / 活文件的时间 ⇒ `isCurrent:null` + **明说没有证据**（不静默给旧数据）。
         */
        const gf = snapshotFreshness({
          kind: '存盘快照',
          name: pathMod.basename(gilPath),
          atMs: statMsSafe(gilPath),
          currentAtMs: liveInfo ? Date.parse(liveInfo.mtime) : null,
          currentLabel: liveInfo ? '活文件 ' + liveInfo.name : null,
          what: '这份 .gil 存盘快照',
        });
        // ⚠️ 回执里**绝不能带 `source`（源码全文）** —— 那是几十 KB，会让这个 op 一下超 10KB
        const embeddedSlim = embedded ? {
          mappingId: embedded.mappingId,
          name: embedded.name,
          file: embedded.file,
          bytes: embedded.sourceBytes,
          sha256: embedded.sourceSha256,
          mounted: isMounted(embedded),
          mountedOn: (mounts.byId && mounts.byId[embedded.mappingId]) || null,
          mountedOnNote: MOUNTED_ON_NOTE,
        } : null;
        const candidates = cur
          ? (pick && pick.candidates ? pick.candidates : []).map((c) => {
            const m = pickScriptMapping(all, c.name).mapping;
            return {
              name: c.name,
              bytes: c.bytes,
              mtime: c.mtime,
              mappingId: m ? m.mappingId : null,
              mappingName: m ? m.name : null,
              mappingBytes: m ? m.sourceBytes : null,
              mappingMounted: m ? isMounted(m) : null,
            };
          })
          : [];
        return {
          ok: true, op, path: gilPath,
          ...pickedFields(pick),
          scriptCount: mappings.length,
          mappings,
          mountKnown: mounts.known === true,
          mountNote: mounts.note || null,
          embedded: embeddedSlim,
          embeddedMappingId: embedded ? embedded.mappingId : null,
          embeddedPickedBy: picked.mapping ? ('name:' + picked.matchedBy) : (all.length ? 'fallback:first' : null),
          live: liveInfo,
          match: cmp.match,
          // ★ P0-2：这份存盘快照的归属与新鲜度（`.gil` 不是实时的，是**存盘那一刻**的快照）
          belongsTo: gf.belongsTo,
          belongsToAt: gf.belongsToAt,
          belongsToEpochSec: gf.belongsToEpochSec,
          isCurrent: gf.isCurrent,
          currentnessNote: gf.note,
          skipped: cmp.skipped || null,
          candidates,
          note: cmp.conclusion
            + (mappings.length > 1
              ? '　（这张图里共 **' + mappings.length + ' 条**脚本映射 —— 多脚本工程请用 `mappings[]` 逐条对账，'
                + '`embedded` 只是**本次这一份**对应（或退回第一条）的那一条。）'
              : ''),
        };
      }
      return fail(ReceiptCode.BAD_PARAM, '未知 op：' + op, {

        nextStep: '看 `miliastra_map` 的 description 里 op 的合法取值（summary / clientui / audit-template / script / strings / nodes / anatomy / regions / nodedb）。',

      });
    },
  };
