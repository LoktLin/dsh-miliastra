/**
 * 知识库问答自测（`lib/kbqa.mjs` 离线蒸馏库 + `miliastra_kb` 工具的 op 契约）。
 *
 * 为什么单开：这个库是"排查清单"，写错了不会报错 —— 只会让人照着错的步骤白折腾一轮。
 * 所以钉住四件事：
 *   ① **每条结构完整**（症状 / 先问什么 / 有序步骤 / 出处 / 证据档），id 唯一，出处 id 都登记过、官方档要带 URL；
 *   ② 检索行为正确（多词 AND、limit、tag），并且**作者点名的那三个症状要命中正确的那条**；
 *   ③ 工具层：`op=qa` / `op=node` 是**离线**（不许标 `network`）；缺参数/查不到要 `ok:false` + 说清原因；
 *      在线兜底失败时**不许**说成"知识库没有"（要有 hint 指回离线 op）；
 *   ④ 隐私与纪律：description 必须写清"哪些 op 会把 query 发到第三方"，回执必须写明"只给排查路径、不下结论"。
 *
 * ⚠️ 与其它套件同一条纪律：**不联网也算过**（在线部分只在真连上时才断言更细的东西）。
 *
 * 用法：node tests/kbqa-test.mjs
 */
import { KB_ENTRIES, KB_SOURCES, kbSearch, kbCatalog, kbEntry, kbSources } from '../lib/kbqa.mjs';
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
const kb = TOOLS.find((t) => t.name === 'miliastra_kb');

await check('① 每条结构完整：症状 / 先问什么 / ≥2 步 / 出处 / 证据档 / 标签，且 id 唯一', () => {
  assert(KB_ENTRIES.length >= 15, '条目太少（作者要"能想到的实际问题都写上"）：' + KB_ENTRIES.length);
  const ids = new Set();
  for (const e of KB_ENTRIES) {
    assert(e.id && /^[a-z0-9-]+$/.test(e.id), 'id 不规范：' + e.id);
    assert(!ids.has(e.id), 'id 重复：' + e.id);
    ids.add(e.id);
    assert(e.symptom && e.symptom.length >= 4, e.id + ' 缺症状');
    assert(Array.isArray(e.ask) && e.ask.length >= 1 && e.ask.every((x) => x && x.length >= 4), e.id + ' 缺"先问什么"');
    assert(Array.isArray(e.steps) && e.steps.length >= 2 && e.steps.every((x) => x && x.length >= 6), e.id + ' 步骤不足/为空');
    assert(Array.isArray(e.src) && e.src.length >= 1, e.id + ' 没写出处');
    assert(['documented', 'community', 'observed'].includes(e.evidence), e.id + ' 证据档非法：' + e.evidence);
    assert(Array.isArray(e.tags) && e.tags.length >= 3, e.id + ' 标签太少（检索靠它）');
    for (const s of e.steps.concat(e.ask)) assert(!/[✅❌]/.test(s), e.id + ' 里出现了判决记号');
  }
  return KB_ENTRIES.length + ' 条，id 唯一、结构齐';
});

await check('② 出处登记：src id 都登记过，官方档必须带 URL，证据档与出处不打架', () => {
  for (const e of KB_ENTRIES) {
    for (const id of e.src) assert(KB_SOURCES[id], e.id + ' 引了没登记的出处：' + id);
  }
  for (const [id, s] of Object.entries(KB_SOURCES)) {
    assert(s.title, id + ' 缺标题');
    if (s.kind === '官方文档') assert(/^https:\/\/act\.mihoyo\.com\//.test(String(s.url)), id + ' 官方档要给官方 URL');
    assert(['官方文档', '社区问答', '本机实测'].includes(s.kind), id + ' kind 非法：' + s.kind);
  }
  for (const e of KB_ENTRIES) {
    const ks = kbSources(e.src).map((x) => x.kind);
    if (e.evidence === 'documented') assert(ks.includes('官方文档'), e.id + ' 标了 documented 却没有官方出处');
    if (e.evidence === 'observed') assert(ks.includes('本机实测'), e.id + ' 标了 observed 却没有本机实测出处');
    if (e.evidence === 'community') assert(ks.includes('社区问答'), e.id + ' 标了 community 却没有社区出处');
  }
  return Object.keys(KB_SOURCES).length + ' 个出处登记，证据档与出处一致';
});

await check('③ 检索：空词回全部、多词 AND、limit/tag 生效，且**作者点名的三个症状**命中正确条目', () => {
  eq(kbSearch('', { limit: 999 }).length, KB_ENTRIES.length, '空搜索词应回全部');
  const first = (q) => (kbSearch(q, { limit: 3 })[0] || {}).entry || {};
  eq(first('镜头不生效').id, 'camera-not-working', '「镜头不生效」没命中镜头那条：' + first('镜头不生效').id);
  eq(first('巡逻路径不生效').id, 'patrol-path-not-working', '「巡逻路径不生效」没命中巡逻那条：' + first('巡逻路径不生效').id);
  eq(first('信号没被接收到').id, 'signal-not-received', '「信号没被接收到」没命中信号那条：' + first('信号没被接收到').id);
  eq(first('节点图 不生效').id, 'graph-not-working', '「节点图 不生效」没命中总自查那条');
  eq(first('控件 nil').id, 'client-ui-instantiate-nil', '「控件 nil」没命中控件模板那条');
  // 多词 AND：有个词谁都命中不了 ⇒ 一条"全词命中"都不该有（退化时标 full:false，别当全中）
  const strict = kbSearch('镜头 zzz不存在zzz', { limit: 5 });
  eq(strict.filter((x) => x.full).length, 0, '多词不是 AND（不该有 full:true）');
  assert(strict.every((x) => x.full === false), '退化的命中必须显式标 full:false');
  const bothOk = kbSearch('镜头 跟随', { limit: 5 });
  assert(bothOk.length && bothOk[0].full === true && bothOk[0].entry.id === 'camera-not-working', '两词都命中时应 full:true 且排第一');
  const limited = kbSearch('不生效', { limit: 2 });
  assert(limited.length <= 2, 'limit 没生效');
  const tagged = kbSearch('', { tag: '巡逻', limit: 5 });
  assert(tagged.length === 1 && tagged[0].entry.id === 'patrol-path-not-working', 'tag 过滤不对：' + JSON.stringify(tagged.map((x) => x.entry.id)));
  assert(kbSearch('', { limit: 5 }).every((x) => Number.isFinite(x.score)), '打分不是数字');
  return '3 个点名症状 + 多词 AND + limit/tag 全部符合预期';
});

await check('④ 工具层 `op=qa`：**离线**、不给参数回目录、按 id 取、错 id 要 ok:false 带候选', async () => {
  const cat = await kb.execute({ op: 'qa' });
  assert(cat.ok === true && cat.catalog && cat.catalog.length === KB_ENTRIES.length, '不给 q 时应回完整目录');
  assert(!cat.network && !cat.sentTo, 'op=qa 是离线的，不该标 network/sentTo');
  const one = await kb.execute({ op: 'qa', id: 'signal-not-received' });
  assert(one.ok && one.entries.length === 1 && one.entries[0].id === 'signal-not-received', '按 id 取失败');
  assert(one.entries[0].sources.length >= 1 && one.entries[0].steps.length >= 2, '回执缺步骤/出处');
  assert(/只给排查路径，不下结论/.test(one.note || ''), '回执没写明纪律（只给路径不下结论）');
  assert(!one.network, 'op=qa 不该联网');
  const bad = await kb.execute({ op: 'qa', id: '没有这条' });
  assert(bad.ok === false && bad.error && Array.isArray(bad.candidates), '错 id 应 ok:false + 列候选');
  const miss = await kb.execute({ op: 'qa', q: 'zzz绝对不存在的症状zzz' });
  assert(miss.ok === true && miss.hitCount === 0 && miss.catalog, '没命中时应回 ok:true + 目录（不是报错）');
  const byTag = await kb.execute({ op: 'qa', tag: '巡逻' });
  assert(byTag.ok && byTag.entries.length === 1, 'tag 检索失败');
  return '目录/按 id/错 id/没命中/tag 五种路径都对；离线无 network';
});

await check('⑤ 工具层 `op=node`：先查**离线词典**（带端口），查不到才去在线兜底（且失败不谎报）', async () => {
  const hit = await kb.execute({ op: 'node', q: '嘲讽目标' });
  assert(hit.ok === true && hit.hitCount >= 1, '离线词典没命中「嘲讽目标」');
  assert(!hit.network && !hit.onlineFallback, '离线命中时不该联网');
  const n = hit.nodes[0];
  assert(n.zh && n.identifier && n.system && Array.isArray(n.pins), '节点条目缺字段：' + JSON.stringify(Object.keys(n)));
  assert(n.pins.length >= 2, '端口数不对：' + n.pins.length);
  assert(n.pins.every((p) => (p.dir === 'in' || p.dir === 'out') && typeof p.type === 'string' && Number.isFinite(p.shell)),
    '端口缺方向/类型/shellIndex：' + JSON.stringify(n.pins[0]));
  const none = await kb.execute({ op: 'node', q: 'zzz不存在的节点zzz' });
  assert(none.ok === true && none.hitCount === 0, '查不到也应 ok:true（查不到 ≠ 报错）');
  assert(none.onlineFallback, '查不到时应给在线兜底结果（成功或失败的说明都算）');
  if (none.onlineFallback.ok) {
    assert(none.onlineFallback.network === true && none.onlineFallback.sentTo, '在线兜底要标 network + sentTo');
  } else {
    assert(/没取到/.test(none.onlineFallback.error || ''), '在线失败要说"没取到"');
    assert(/不代表知识库里没有|qa|node/.test(none.onlineFallback.hint || ''), '在线失败时要给 hint（别让人以为知识库没有）');
  }
  return '离线命中（含端口）＋ 查不到走在线兜底（' + (none.onlineFallback.ok ? '在线成功' : '在线不可用，如实报') + '）';
});

await check('⑥ 在线 op 的**纪律**：缺参数要 ok:false；description 必须披露"哪些 op 会把 query 发出去"', async () => {
  const noTitles = await kb.execute({ op: 'doc' });
  assert(noTitles.ok === false && /titles/.test(noTitles.error), 'op=doc 缺 titles 应 ok:false 并说清要什么');
  const noQ = await kb.execute({ op: 'search' });
  assert(noQ.ok === false && /q/.test(noQ.error), 'op=search 缺 q 应 ok:false');
  const d = kb.description;
  assert(/典型调用/.test(d), 'description 缺「典型调用」（不变量①）');
  assert(/离线/.test(d) && /在线/.test(d), 'description 没写清哪些 op 离线/在线');
  assert(/会把你的 query 发到那个站点/.test(d), 'description 没披露隐私（在线 op 会把 query 发出去）');
  assert(/ugc\.070077\.xyz/.test(d), 'description 没写出第三方来源');
  for (const op of ['qa', 'node', 'list', 'doc', 'search']) {
    assert(kb.parameters.properties.op.enum.includes(op), '缺 op：' + op);
  }
  const params = Object.keys(kb.parameters.properties);
  eq(params, ['op', 'q', 'id', 'tag', 'titles', 'topK', 'limit', 'system'], '参数集合变了（schema 要跟着文档改）');
  return '缺参数 ok:false；离线/在线与隐私都写进 description；5 个 op 齐';
});

if (failures.length) {
  console.log('\n❌ kbqa-test：' + failures.length + ' 条失败');
  for (const f of failures) console.log('   - ' + f);
  process.exit(1);
}
console.log('\n✅ kbqa-test 通过：' + pass + ' 条');
