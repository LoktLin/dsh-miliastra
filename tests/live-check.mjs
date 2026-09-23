/**
 * L4 真机验证：对着**正在运行的 dsh web** 验证 Host 半边与工具真的可用。
 *
 * 用法：
 *   node tests/live-check.mjs                  # 默认 http://127.0.0.1:3080
 *   node tests/live-check.mjs http://127.0.0.1:3080
 *
 * 前置：`dsh-miliastra` 已进 profile 的 dsh.profile.bundles，且**重启过 dsh web**
 *       （Host 代码是启动时加载的快照；只放软链不重启 = 静默不生效）。
 *
 * 覆盖：状态路由 / 工具按名调用 / 四个只读工具真跑一遍 / echo 回显 / 未知路由 404。
 * 不覆盖：**侧边栏面板是否真的渲染出来**（那要人刷新页面看一眼）—— 脚本会明确标出来。
 */

const BASE = (process.argv[2] || process.env.MILIASTRA_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/**
 * 路由信封有三层，别少剥一层：
 *   HTTP body = { ok, data: { name, ok, data: <工具业务返回体> } }
 * 本函数返回的是**工具业务返回体**（形如 {ok:true,...} 或 {ok:false,error}）。
 */
async function callTool(name, args) {
  const r = await fetch(`${BASE}/miliastra/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args: args || {} }),
  });
  const j = await r.json().catch(() => null);
  assert(r.status === 200, `HTTP ${r.status}：${JSON.stringify(j).slice(0, 200)}`);
  assert(j && j.ok === true && j.data, '路由信封不对：' + JSON.stringify(j).slice(0, 200));
  assert(j.data.ok === true, '工具调用失败：' + (j.data.error || JSON.stringify(j.data).slice(0, 200)));
  assert(j.data.data && typeof j.data.data === 'object', '工具返回体缺失：' + JSON.stringify(j.data).slice(0, 200));
  return j.data.data;
}

console.log(`=== dsh-miliastra L4 真机验证   目标 ${BASE} ===\n`);

await check('GET /miliastra/status 回 {ok:true,data}', async () => {
  const r = await fetch(`${BASE}/miliastra/status`);
  assert(r.status !== 404, '404 —— Host 半边没加载。**重启过 dsh web 吗？**'
    + '（只放软链/只改 bundles 不重启 = 静默不生效）');
  assert(r.status === 200, `HTTP ${r.status}`);
  const j = await r.json();
  assert(j.ok === true, '信封缺 ok:true');
  assert(j.data && typeof j.data.version === 'string', 'data.version 缺失');
  assert(Array.isArray(j.data.tools) && j.data.tools.length >= 5, 'data.tools 不足 5 个');
  return `${j.data.plugin} v${j.data.version}，工具 ${j.data.tools.length} 个：${j.data.tools.join(', ')}`;
});

await check('POST /miliastra/tool → miliastra_echo 回显正确', async () => {
  const d = await callTool('miliastra_echo', { text: 'live-check' });
  assert(d.ok === true && d.echoed === 'live-check', '回显不对：' + JSON.stringify(d));
  return `echoed=${d.echoed}  本机存档根=${d.localLow}`;
});

await check('POST /miliastra/tool → miliastra_health 扫到关卡', async () => {
  const d = await callTool('miliastra_health', {});
  assert(d.ok === true, 'health 失败：' + d.error);
  assert(typeof d.localLow === 'string' && d.localLow, 'localLow 缺失');
  assert(typeof d.levelCount === 'number', 'levelCount 缺失');
  assert(Array.isArray(d.levels), 'levels 不是数组');
  const cur = d.current;
  const lua = cur && cur.luaFiles ? cur.luaFiles.map((f) => f.name).join(',') : '';
  return `存档根 ${d.localLow}；关卡 ${d.levelCount} 个；当前=${cur ? `${cur.brand}/${cur.levelId}（活文件 ${lua || '无'}）` : '（无）'}`;
});

await check('POST /miliastra/tool → miliastra_log op=sessions 读到日志', async () => {
  const d = await callTool('miliastra_log', { op: 'sessions', limit: 5 });
  if (d.ok === false) return `（本机还没日志，环境缺失不算失败：${d.error}）`;
  assert(Array.isArray(d.files), 'files 不是数组：' + JSON.stringify(d).slice(0, 200));
  return `${d.dir} 下 ${d.count} 个 .gia，最近 ${d.files[0] ? d.files[0].name : '（无）'}`;
});

await check('POST /miliastra/tool → miliastra_log op=tail 结构化读正文', async () => {
  const d = await callTool('miliastra_log', { op: 'tail', limit: 5 });
  if (d.ok === false) return `（本机还没试玩过，环境缺失不算失败：${d.error}）`;
  assert(Array.isArray(d.records), 'records 不是数组');
  const rec = d.records.find((r) => r && r.message);
  return rec ? `记录 ${d.recordCount} 条，样例「${String(rec.message).slice(0, 60)}」` : '（本局无 print 输出）';
});

await check('POST /miliastra/tool → miliastra_map op=clientui 读到控件谱系', async () => {
  const d = await callTool('miliastra_map', { op: 'clientui' });
  if (d.ok === false) return `（本机没扫到地图，环境缺失不算失败：${d.error}）`;
  assert(typeof d.count === 'number', 'count 缺失');
  assert(Array.isArray(d.likelyTemplates), 'likelyTemplates 不是数组');
  const t = d.likelyTemplates.map((x) => x.id + ':' + x.name).join(', ') || '（无）';
  return `控件记录 ${d.count} 条；可动态创建候选 = ${t}`;
});

await check('POST /miliastra/tool → miliastra_map op=summary 给出模板区体检结论', async () => {
  const d = await callTool('miliastra_map', { op: 'summary' });
  if (d.ok === false) return `（本机没扫到地图，环境缺失不算失败：${d.error}）`;
  assert(d.level && typeof d.level.id === 'number', 'level.id 缺失');
  assert(typeof d.templateCount === 'number', 'templateCount 缺失');
  return `关卡 ${d.level.name}（${d.level.id}）v${d.version}；控件 ${d.controlCount} 条；可创建模板 ${d.templateCount} 条`
    + (d.dynamicCreateLikelyBroken ? '；⚠️ 模板区为空' : '');
});

await check('未知路由回 404（而不是 500 / 静默）', async () => {
  const r = await fetch(`${BASE}/miliastra/nope`);
  assert(r.status === 404, `应 404，实际 ${r.status}`);
  return '404';
});

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
console.log('');
console.log('⚠️ 仍未验证（需要人眼）：刷新的页面上，侧边栏底部「设置」旁应出现「千星奇域」入口，点开是状态浮层。');
process.exit(fail ? 1 : 0);
