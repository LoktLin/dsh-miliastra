/**
 * 节点图**能力画像**自测（`lib/nodegraph.mjs` 纯函数 + `miliastra_map op=anatomy` 那一层）。
 *
 * 为什么单开：作者要的是「各类型节点有多少个」「快速判断这张图用来做啥」——
 * 这种统计错一个数**不会报错**，只会让人照着错的分布做判断。所以这里把口径逐条钉住：
 *   ① 类型只能来自**随包节点词典**（`identifier` 第一段 / `domain`），命不中就是 `Unknown`（不许猜、不许摊派）；
 *   ② 服务端/客户端只认词典的 `system`；
 *   ③ 入口 = 类型为「事件」的节点；引用 = 节点 `refs`（方向是"图 → 引用了谁"）；
 *   ④ **「谁身上挂着这张图」读不出来** —— 这条结论与它的证伪证据也要钉住（免得下次又去猜）。
 *   ⑤ 拿**真 `.gil`** 喂一遍：逐图相加必须等于整关总数（统计不能对不上账）。
 *
 * 用法：node tests/nodegraph-test.mjs
 */
import fs from 'node:fs';
import { readGilNodeFacts, readGraphMounts } from '../lib/gilnodes.mjs';
import { parseMessage } from '../lib/wire.mjs';
import { scanLevels, pickCurrent } from '../lib/locate.mjs';
import {
  NODE_TYPE_LABELS, nodeTypeLabel, nodeTypeOf, nodeSideOf, typeStatsOf, triggersOf, refsSummaryOf,
  keywordsOf, graphAnatomy, anatomyTotals, graphOwnerNote,
} from '../lib/nodegraph.mjs';
import { TOOLS } from '../index.js';

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    const note = await fn();
    pass += 1;
    console.log('  ✅ ' + name + (note ? '  → ' + note : ''));
  } catch (e) {
    failures.push(name + '：' + e.message);
    console.log('  ❌ ' + name + '  → ' + e.message);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), (msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');

await check('① 类型口径：只认词典（identifier 第一段 → domain → Unknown），服务端/客户端只认 system', () => {
  assert(nodeTypeOf({ identifier: 'Trigger.Entity_Related.On_Created', domain: 'Trigger' }) === 'Trigger', 'identifier 第一段没优先');
  assert(nodeTypeOf({ identifier: 'Execution.Common_Node.Print', domain: 'Execution' }) === 'Execution', 'Execution 判错');
  assert(nodeTypeOf({ domain: 'Query' }) === 'Query', '没有 identifier 时没退化到 domain');
  assert(nodeTypeOf({ domain: 'Weird' }) === 'Weird', 'domain 不在表里时应原样回（不编中文）');
  assert(nodeTypeOf(null) === 'Unknown' && nodeTypeOf({}) === 'Unknown', '读不出来时必须 Unknown');
  assert(nodeTypeLabel('Trigger') === '事件' && nodeTypeLabel('Execution') === '执行' && nodeTypeLabel('Query') === '查询'
    && nodeTypeLabel('Arithmetic') === '运算' && nodeTypeLabel('Control') === '分支', '中文标签不对');
  assert(nodeTypeLabel('不存在的类型') === '未知', '未知类型该回「未知」');
  assert(nodeSideOf({ system: 'Server' }) === '服务端' && nodeSideOf({ system: 'Client' }) === '客户端'
    && nodeSideOf({}) === 'Unknown' && nodeSideOf(null) === 'Unknown', '端判断不对');
  eq(Object.keys(NODE_TYPE_LABELS).sort(),
    ['Arithmetic', 'Composite', 'Control', 'Custom', 'Execution', 'Hidden', 'Others', 'Query', 'Trigger'],
    '类型表本身变了（多出来的是"本关声明归属"两档，不是官方分类）');
  return 'identifier > domain > Unknown；system 才决定端';
});

await check('② 分布统计：逐类计数 + 端拆分 + 一行文字（顺序固定，未知不摊派）', () => {
  const nodes = [
    { doc: { identifier: 'Trigger.A.B', system: 'Server' } },
    { doc: { identifier: 'Trigger.A.C', system: 'Server' } },
    { doc: { identifier: 'Execution.X.Y', system: 'Server' } },
    { doc: { identifier: 'Query.X.Y', system: 'Client' } },
    { doc: null },
  ];
  const s = typeStatsOf(nodes);
  eq(s.total, 5, '总数');
  eq(s.unknown, 1, '未知数');
  eq(s.known, 4, '已知数');
  eq(s.byType, { Trigger: 2, Execution: 1, Query: 1, Unknown: 1 }, 'byType');
  eq(s.bySide, { 服务端: 3, 客户端: 1, Unknown: 1 }, 'bySide');
  eq(s.byTypeAndSide.Trigger, { 服务端: 2 }, 'byTypeAndSide');
  eq(s.byTypeLabelText, '事件 2 · 执行 1 · 查询 1 · 未知 1', '一行文字（顺序 + 未知垫底）');
  eq(typeStatsOf([]).byTypeLabelText, '（没有节点）', '空列表');
  assert(typeStatsOf(null).total === 0, 'null 要兜住');
  return '5 个节点 → 事件2/执行1/查询1/未知1';
});

await check('②b 词典没命中的节点：id 命中**本关卡内声明**的归「复合节点 / 自定义节点」（能确证的归属，不是猜）', () => {
  const decls = [{ id: 1610612737, isComposite: true }, { id: 1073741845, isComposite: false }];
  const nodes = [
    { docId: 1610612737, doc: null },              // 复合声明
    { docId: 1073741845, doc: null },              // 单节点自定义
    { docId: 999999, doc: null },                  // 两边都不是 ⇒ Unknown
    { docId: 36, doc: { identifier: 'Trigger.Custom_Variable.On_Variable_Change', system: 'Server' } },  // 词典命中
  ];
  const withDecl = typeStatsOf(nodes, { declarations: decls });
  eq(withDecl.byType, { Composite: 1, Custom: 1, Unknown: 1, Trigger: 1 }, '没按声明归类：' + JSON.stringify(withDecl.byType));
  eq(withDecl.unknown, 1, '只剩真·未收录的才算 Unknown');
  assert(/复合节点 1/.test(withDecl.byTypeLabelText) && /自定义节点 1/.test(withDecl.byTypeLabelText), '一行文字里缺新类：' + withDecl.byTypeLabelText);
  const withoutDecl = typeStatsOf(nodes);
  eq(withoutDecl.unknown, 3, '不传声明表时应老实全部算 Unknown（不许猜）');
  eq(withoutDecl.byType.Trigger, 1, '不传声明表也不该影响词典命中');
  assert(nodeTypeLabel('Composite') === '复合节点' && nodeTypeLabel('Custom') === '自定义节点', '新类中文名不对');
  return '声明归属 复合1/自定义1；不传声明表 ⇒ 3 个 Unknown（不猜）';
});

await check('③ 入口与引用：入口只取事件节点；引用方向是「图 → 引用了谁」', () => {
  const nodes = [
    { index: 1, docId: 71, doc: { identifier: 'Trigger.Entity_Related.On_Created', zh: '实体创建时', system: 'Server' } },
    { index: 2, docId: 36, doc: { identifier: 'Trigger.Custom_Variable.On_Variable_Change', zh: '自定义变量变化时', system: 'Server' }, refs: [{ id: 123, what: '实体「关卡实体」' }] },
    { index: 3, docId: 1, doc: { identifier: 'Execution.Common_Node.Print', zh: '打印字符串', system: 'Server' } },
  ];
  const t = triggersOf(nodes);
  eq(t.length, 2, '入口数');
  eq(t.map((x) => x.name), ['实体创建时', '自定义变量变化时'], '入口名字');
  eq(t[0].identifier, 'Trigger.Entity_Related.On_Created', '入口标识');
  const r = refsSummaryOf(nodes);
  eq(r.total, 1, '引用条数');
  eq(r.entities, ['关卡实体'], '实体名要拆出来');
  eq(r.others, [], '不该留下别的东西');
  eq(refsSummaryOf([{ refs: [{ id: 9, what: '声明 9' }] }]).others, ['声明 9'], '非实体引用进 others');
  assert(triggersOf([{ doc: null }]).length === 0, '未知节点不能当入口');
  return '2 个事件节点 + 1 条实体引用';
});

await check('④ 关键词：图名权重最高，纯字符串统计（不猜语义）', () => {
  const nodes = [{ doc: { zh: '设置自定义变量' } }, { doc: { zh: '设置自定义变量' } }, { doc: { zh: '打印字符串' } }];
  const k = keywordsOf('灶台_收食物', nodes, { entities: ['吧台'] }, 8);
  assert(k.includes('灶台') && k.includes('收食物'), '图名没进关键词：' + JSON.stringify(k));
  assert(k.includes('设置自定义变量'), '节点名没进关键词');
  assert(k.includes('吧台'), '引用实体没进关键词');
  assert(!k.some((x) => /^\d+$/.test(x)), '纯数字不该进关键词');
  assert(keywordsOf('', [], { entities: [] }, 8).length === 0, '空输入应回空数组');
  return k.slice(0, 5).join(' / ');
});

await check('⑤ 画像与汇总：逐图相加 == 整关总数（统计要对得上账）', () => {
  const g1 = { name: '甲图', id: 1, typeLabel: '关卡实体图' };
  const g2 = { name: '乙图', id: 2, typeLabel: '客户端技能图' };
  const a1 = graphAnatomy(g1, [
    { doc: { identifier: 'Trigger.A', system: 'Server' }, refs: [] },
    { doc: { identifier: 'Execution.B', system: 'Server' }, refs: [] },
  ], { edges: [{ from: 1, to: 2 }] });
  const a2 = graphAnatomy(g2, [
    { doc: { identifier: 'Query.C', system: 'Client' }, refs: [{ id: 1, what: '实体「X」' }] },
    { doc: { identifier: 'Execution.D', system: 'Client' }, refs: [] },
    { doc: null, refs: [] },
  ], { edges: [] });
  assert(/事件 1/.test(a1.brief) && /执行 1/.test(a1.brief), '画像一句话里缺类型分布：' + a1.brief);
  assert(/入口：/.test(a1.brief), '画像一句话里缺入口');
  assert(/出边 1 条/.test(a1.brief), '画像一句话里缺出边数');
  assert(/没有事件（触发器）节点/.test(a2.brief), '没有事件时要明说');
  const tot = anatomyTotals([a1, a2]);
  eq(tot.graphs, 2, '图数');
  eq(tot.nodes, 5, '节点总数');
  eq(tot.edges, 1, '出边总数');
  eq(tot.byType, { Trigger: 1, Execution: 2, Query: 1, Unknown: 1 }, '整关 byType 必须是逐图相加');
  eq(tot.bySide, { 服务端: 2, 客户端: 2, Unknown: 1 }, '整关 bySide');
  eq(tot.byTypeLabel['事件'], 1, '整关中文标签');
  return '2 图 5 节点 → 事件1/执行2/查询1/未知1（逐图相加一致）';
});

await check('⑥ **挂载主读得出来**（作者 2026-10-02 修正；上一轮"读不出来"是错口径 —— 三条教训也要留着）', () => {
  const n = graphOwnerNote();
  assert(n.verified === true, '这条现在必须标"已确证"');
  assert(/#13/.test(n.how) && /逐条对上/.test(n.how), '没给出判据（`#13` 形状 + 与编辑器对上）');
  assert(/未确证/.test(n.partial) && /布尔过滤器/.test(n.partial), '没写清"另一类形状口径未确证"');
  assert(/别的区/.test(n.blind), '没写清盲区（技能图/状态图在别的区）');
  assert(/名字匹配/.test(n.warning) && /裸数值/.test(n.warning), '没留下上一轮那两条错法的教训');
  assert(/编辑器/.test(n.source), '没写出处（作者给的编辑器线索）');
  return '已确证 + 判据 + 未确证口径 + 盲区 + 两条教训';
});

await check('⑥b 挂载抽取：合成树 + 真 .gil 双验（`#13` 形状：实体 `#6`、元件 `#7`）', () => {
  // 合成树：手工搭 `#5[i].#6.#13.#1.#1{ #1=序号, #2=图id, #501=类型号 }`（元件同形状，只是 `#6`→`#7`）
  const vi = (no, n) => ({ no, wt: 0, value: BigInt(n) });
  const msg = (no, ...kids) => ({ no, wt: 2, sub: kids, value: Buffer.alloc(0) });
  const slotName = () => msg(5, vi(1, 1), msg(11, { no: 0, wt: 2, value: Buffer.from('灶台', 'utf8') }));
  const mountItem = (idx, gid) => msg(1, msg(1, vi(1, idx), vi(2, gid), vi(501, 20000)));
  const entRec = msg(1, vi(1, 1001), slotName(), msg(6, msg(13, mountItem(1, 1073741828))));
  const compRec = msg(1, vi(1, 2002), msg(6, vi(1, 1), msg(11, { no: 0, wt: 2, value: Buffer.from('组合位置', 'utf8') })), msg(7, msg(13, mountItem(1, 1082130434))));
  const tree = [msg(5, entRec), msg(4, compRec)];
  const got = readGraphMounts(tree, { graphIds: [1073741828, 1082130434, 999] });
  eq(got.entities.length, 1, '实体挂载记录没抽出来');
  eq(got.entities[0].mounts.map((m) => m.graphId), [1073741828], '实体挂载的图 id 不对');
  eq(got.entities[0].mounts[0].typeCode, 20000, '图类型号（#501）没带出来');
  eq(got.components[0].mounts.map((m) => m.graphId), [1082130434], '元件挂载的图 id 不对');
  eq(got.mountedGraphIds.sort((a, b) => a - b), [1073741828, 1082130434], 'mountedGraphIds 不对');
  const noIds = readGraphMounts(tree, {});
  assert(noIds.entities.length === 0 && noIds.unverified.length > 0, '不给 graphIds 时应拒绝判定并说明');
  // 真数据：两个关卡各验一条（与编辑器面板对上的那两条）
  const lvls = scanLevels();
  const hit39 = lvls.find((l) => String(l.levelId) === '1073741839' && l.gil);
  const hit29 = lvls.find((l) => String(l.levelId) === '1073741829' && l.gil);
  let note = '合成树通过';
  if (hit39) {
    const f = readGilNodeFacts(hit39.gil.path, {});
    const g = (f.graphs || []).find((x) => x.name === '关卡实体信号');
    if (g) {
      assert((f.graphOwners[g.id] || []).some((o) => o.kind === '实体' && o.via === 'mount'), '侦探1：关卡实体信号 没读到挂载主');
      note += '；1073741839「关卡实体信号」← 实体';
    }
  }
  if (hit29) {
    const f = readGilNodeFacts(hit29.gil.path, {});
    const g = (f.graphs || []).find((x) => x.name === '吧台_收食物');
    if (g) {
      assert((f.graphOwners[g.id] || []).length > 0, '恐怖：吧台_收食物 没读到挂载主');
      note += '；1073741829「吧台_收食物」← ' + (f.graphOwners[g.id] || []).length + ' 个挂载主';
    }
  }
  return note;
});

await check('⑦ 真 `.gil`：逐图相加 == 整关（含覆盖率），且入口都是事件类', () => {
  const all = scanLevels().filter((l) => l.gil && l.gil.path);
  if (!all.length) return '环境里没有 .gil ⇒ 如实跳过';
  const lv = all.find((l) => l.levelId === ((pickCurrent(all) || {}).levelId))
    || all.slice().sort((a, b) => (b.gil.size || 0) - (a.gil.size || 0))[0];
  const facts = readGilNodeFacts(lv.gil.path, {});
  const anatomies = Object.entries(facts.graphNodeLists || {}).map(([name, nodes]) => {
    const g = (facts.graphs || []).find((x) => x.name === name) || { name };
    return graphAnatomy(g, nodes, { edges: [] });
  });
  if (!anatomies.length) return '这份 .gil（' + lv.levelId + '）里没有节点图 ⇒ 跳过';
  const tot = anatomyTotals(anatomies);
  let sum = 0;
  for (const a of anatomies) sum += a.nodeCount;
  eq(tot.nodes, sum, '整关节点数必须等于逐图相加');
  const sumByType = {};
  for (const a of anatomies) for (const [k, v] of Object.entries(a.typeStats.byType)) sumByType[k] = (sumByType[k] || 0) + v;
  eq(tot.byType, sumByType, 'byType 逐图相加对不上');
  // 入口节点：必须**都是** Trigger 类（不许把别的类混进入口）
  let trig = 0; let bad = 0;
  for (const a of anatomies) {
    trig += a.triggers.length;
    for (const t of a.triggers) if (!String(t.identifier || '').startsWith('Trigger.')) bad += 1;
  }
  eq(bad, 0, '入口里混进了非事件节点');
  const known = anatomies.reduce((s, a) => s + a.typeStats.known, 0);
  // ★ 2026-10-02 加：计数**必须是数字**且**不许静默截断**（作者抓到"元件只回 40 个 / 声明数 undefined"）
  for (const lv of scanLevels().filter((l) => l.gil && l.gil.path).slice(0, 4)) {
    const f2 = readGilNodeFacts(lv.gil.path, {});
    for (const k of ['graphCount', 'entityCount', 'componentCount', 'declarationCount', 'configCount']) {
      assert(Number.isFinite(f2[k]), lv.levelId + ' 的 ' + k + ' 不是数字：' + f2[k]);
    }
    assert(f2.truncated && typeof f2.truncated === 'object', lv.levelId + ' 缺 truncated（截断要能看出来）');
    // 元件区条目数必须与回执一致（除非**显式**说了截断）
    const buf = fs.readFileSync(lv.gil.path);
    const root = parseMessage(buf, 20, 20 + buf.readUInt32BE(16), 0);
    const r4 = (root || []).find((x) => x.no === 4);
    const raw = r4 && r4.sub ? r4.sub.filter((x) => x.no === 1).length : 0;
    assert(raw === f2.componentCount || f2.truncated.components === true,
      lv.levelId + '：元件区实际 ' + raw + ' 个，回执给 ' + f2.componentCount + ' 个，且没说截断');
  }
  return lv.levelId + '：' + tot.graphs + ' 图 / ' + tot.nodes + ' 节点 / 出边 ' + tot.edges
    + '　' + tot.byTypeLabelText + '　词典覆盖 ' + known + '/' + tot.nodes + '（入口 ' + trig + ' 个，全为事件类）';
});

await check('⑧ `op=anatomy` 回执：字段齐、summaryOnly 只去正文、不猜挂载、ok:false 必带 error', async () => {
  const all = scanLevels().filter((l) => l.gil && l.gil.path);
  if (!all.length) return '环境里没有 .gil ⇒ 如实跳过';
  const lv = all.find((l) => l.levelId === ((pickCurrent(all) || {}).levelId))
    || all.slice().sort((a, b) => (b.gil.size || 0) - (a.gil.size || 0))[0];
  const r = await mapTool.execute({ op: 'anatomy', level: lv.levelId, graph: '不存在图名zzz' });
  assert(r.ok === false && typeof r.error === 'string' && r.error.length, '图名对不上时必须 ok:false + error');
  const full = await mapTool.execute({ op: 'anatomy', level: lv.levelId });
  if (!full.ok) throw new Error('op=anatomy 读失败：' + full.error);
  assert(full.totals && full.coverage && full.anatomyNote, '缺 totals / coverage / anatomyNote');
  assert(full.coverage.nodes === full.totals.nodes, 'coverage.nodes 与 totals.nodes 应一致');
  assert(full.coverage.typedNodes + full.coverage.untypedNodes === full.coverage.nodes, '覆盖率的加法对不上');
  assert(full.anatomyNote.verified === true, 'anatomy 回执必须带"挂载主读得出来"的结论（含判据与盲区）');
  assert(full.mountSummary && full.mountSummary.graphsTotal > 0, '缺 mountSummary（挂载概略）');
  assert(full.customNodes && full.customNodes.declarationsInMap >= 0, '缺 customNodes（本关声明归属）');
  eq(full.customNodes.fromDeclarations, (full.customNodes.composite || 0) + (full.customNodes.custom || 0), 'customNodes 加法对不上');
  assert(/本关卡内的声明/.test(full.coverage.note), 'coverage.note 没写清"命中本关声明"这条归属');
  assert(Array.isArray(full.graphs) && full.graphs.length === full.graphCount, 'summaryOnly 未传时应给逐图');
  for (const g of full.graphs.slice(0, 3)) {
    assert(g.byType && g.triggers && g.refs && g.keywords && g.brief, '逐图字段缺失：' + JSON.stringify(Object.keys(g)));
  }
  const slim = await mapTool.execute({ op: 'anatomy', level: lv.levelId, summaryOnly: true });
  assert(slim.graphs === undefined && slim.totals, 'summaryOnly 只该去掉正文（逐图），结论要留');
  return lv.levelId + '：' + full.graphCount + ' 图；只去正文的 summaryOnly 生效；错误路径 ok:false';
});

if (failures.length) {
  console.log('\n❌ nodegraph-test：' + failures.length + ' 条失败');
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('\n✅ nodegraph-test 通过：' + pass + ' 条');
