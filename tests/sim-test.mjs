/**
 * 模拟器 Host 适配测试（`lib/sim.mjs`）
 *
 * 这个测试盯三件事，都是**会真出事**的那种：
 *   ① **Lua 真的在跑** —— 加一段脚本、开试玩，日志里必须有它 print 出来的字（不是"接口返回 ok"就算过）；
 *   ② **失控脚本不能冻住 Host** —— `while true do end` 必须在超时后被 Worker 超时 + terminate 收掉，
 *      Host 拿到的是错误而不是永久挂起（这条是"把引擎搬进来"最大的安全前提）；
 *   ③ **写盘只写我们自己的数据目录** —— 截图落在 `MILIASTRA_DATA_DIR` 的 `shots/`，
 *      模拟器工作区落在同级的 `simulator/`，**绝不碰游戏存档 / 活文件 / 用户真实截图**。
 *
 * 全部用临时数据目录（`MILIASTRA_DATA_DIR`），跑完删干净 —— 不污染用户真实的 shots/。
 *
 * 用法：node tests/sim-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

// 数据目录指向临时目录（必须在 import sim.mjs 之前设好）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-sim-test-'));
process.env.MILIASTRA_DATA_DIR = tmpData;
// 让失控脚本那条别真等 8 秒
process.env.QXQY_PLAY_TIMEOUT_MS = '1500';

const { simOp, disposeSimAll, simRuntimeInfo } = await import('../lib/sim.mjs');

const err = async (fn) => { try { await fn(); return null; } catch (e) { return (e && e.message) || String(e); } };

/* ---------------------------------------------------------------- 状态 */

let st = await simOp({ op: 'state' });
ok('op=state 默认 summaryOnly：给结论不给全量几何', Array.isArray(st.tree) && st.boxes === undefined && typeof st.boxesOmitted === 'number',
  'tree=' + (st.tree || []).length + ' boxes=' + st.boxes + ' boxesOmitted=' + st.boxesOmitted);
ok('op=state 带回画布预设（默认 PC 1600×900）', !!st.canvas && st.canvas.width === 1600 && st.canvas.height === 900,
  JSON.stringify(st.canvas));
ok('op=state 的工程有根：客户端控件容器 + 容器节点',
  Array.isArray(st.tree) && st.tree.some((n) => n.kind === 'server-container') && st.tree.some((n) => n.kind === 'container'));

const full = await simOp({ op: 'state', summaryOnly: false });
ok('summaryOnly:false 才回 boxes 与 tree 全量', Array.isArray(full.boxes) && full.boxes.length > 0,
  'boxes=' + (full.boxes || []).length);

const beforeCount = st.treeCount;

/* ---------------------------------------------------------------- 编辑 */

const added = await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'SIM-标题' } });
ok('op=patch add：版本号 +1', added.version === full.version + 1, added.version + ' vs ' + (full.version + 1));
ok('op=patch add：控件树多了一个节点', added.treeCount === beforeCount + 1, added.treeCount + ' vs ' + (beforeCount + 1));

const setRes = await simOp({ op: 'patch', patch: { op: 'set', id: added.selectedId, key: 'text', value: '模拟器自检' } });
ok('op=patch set：能改业务字段并回读', setRes.inspector && setRes.inspector.fields.some((f) => f.key === 'text' && f.value === '模拟器自检'),
  JSON.stringify(setRes.inspector && setRes.inspector.fields.filter((f) => f.key === 'text')));

const noPatch = await err(() => simOp({ op: 'patch' }));
ok('op=patch 缺 patch：明确报错（不是静默成功）', !!noPatch && /patch/.test(noPatch), noPatch);

const badOp = await err(() => simOp({ op: 'nope' }));
ok('未知 op：报错里列出可用 op', !!badOp && /state.*patch.*play/.test(badOp), badOp);

/* --------------------------------------------- 控件清单（op=controls，省 token） */

const ctl = await simOp({ op: 'controls' });
ok('★ op=controls：只回 {id,name,kind,depth} 四个字段（不是 state 的 12 字段整行）',
  Array.isArray(ctl.controls) && ctl.controls.length > 0
  && ctl.controls.every((c) => Object.keys(c).sort().join(',') === 'depth,id,kind,name'),
  JSON.stringify(ctl.controls[0]));
ok('op=controls：带回可直接抄进断言的 names + 类型直方图 + 已挂脚本',
  Array.isArray(ctl.names) && ctl.names.indexOf('SIM-标题') >= 0
  && typeof ctl.kinds === 'object' && ctl.kinds.container >= 1 && Array.isArray(ctl.scripts),
  JSON.stringify({ names: ctl.names, kinds: ctl.kinds }));
{
  // 省 token 的本来目的：同一个控件，清单里那行要比 state 里那行小得多
  const inState = (st.tree || []).find((n) => n.id === ctl.controls[0].id) || {};
  ok('op=controls 的一行 ≤ state 一行的 1/3（省 token 就是它的目的）',
    JSON.stringify(ctl.controls[0]).length * 3 <= JSON.stringify(inState).length,
    JSON.stringify(ctl.controls[0]).length + ' vs ' + JSON.stringify(inState).length);
}
ok('op=controls namedOnly：只列有名字的（只有它们能按 name 断言）',
  (await simOp({ op: 'controls', namedOnly: true })).controls.every((c) => !!c.name));
ok('op=controls nameContains：按名字子串过滤（Host 侧过滤，中文可用）',
  (await simOp({ op: 'controls', nameContains: 'SIM-标题' })).total === 1,
  JSON.stringify((await simOp({ op: 'controls', nameContains: 'SIM-标题' })).controls));
ok('op=controls kind 过滤：只回该类型',
  (await simOp({ op: 'controls', kind: 'textbox' })).controls.every((c) => c.kind === 'textbox'));
ok('op=controls maxDepth:0 → 只看根（层级可控）',
  (await simOp({ op: 'controls', maxDepth: 0 })).total === 1);
{
  const lim = await simOp({ op: 'controls', limit: 1 });
  ok('op=controls limit：截断但如实回 total/omitted（不是静默少给）',
    lim.count === 1 && lim.total > 1 && lim.omitted === lim.total - 1,
    JSON.stringify({ count: lim.count, total: lim.total, omitted: lim.omitted }));
}
const ctlNoRun = await err(() => simOp({ op: 'controls', runtime: true }));
ok('op=controls runtime:true 没会话：明确报错并给出路（绝不静默退回编辑器树）',
  !!ctlNoRun && /runtime:true/.test(ctlNoRun) && /start/.test(ctlNoRun), ctlNoRun);

/* ---------------------------------------------------------------- 截图 */

const uiShot = await simOp({ op: 'shot', target: 'ui', label: 'selftest' });
ok('op=shot ui：真的落盘一张 PNG', uiShot.bytes > 1000 && fs.existsSync(uiShot.file), uiShot.file + ' ' + uiShot.bytes + 'B');
ok('op=shot ui：文件名带 sim-ui 前缀与标签', /^sim-ui-selftest-\d{8}-\d{6}/.test(uiShot.name), uiShot.name);
ok('op=shot ui：返回面板可直接用的 URL', typeof uiShot.url === 'string' && uiShot.url.indexOf('/miliastra/shot?name=') === 0, uiShot.url);
ok('op=shot ui：PNG 魔数正确（不是空文件/文本）',
  fs.readFileSync(uiShot.file).subarray(0, 4).toString('hex') === '89504e47',
  fs.readFileSync(uiShot.file).subarray(0, 4).toString('hex'));

/* ---------------------------------------------------------------- 试玩 */

const notStarted = await err(() => simOp({ op: 'play', action: 'get' }));
ok('未 start 就 get：明确报「play session has not started」', !!notStarted && /has not started/.test(notStarted), notStarted);

await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'sim-selftest', source: 'function OnStart()\n  print("SIM_SELFTEST_OK")\nend\n' } });
const started = await simOp({ op: 'play', action: 'start' });
ok('op=play start：回画布与平台（默认 PC）', !!started.canvasId && !!started.platform, JSON.stringify({ canvasId: started.canvasId, platform: started.platform }));

const ctlRun = await simOp({ op: 'controls', runtime: true });
ok('★ op=controls runtime:true：看**运行中**会话的控件树（脚本运行时建出来的那批）',
  ctlRun.source === 'runtime' && ctlRun.kindsTotal > 0 && Array.isArray(ctlRun.controls) && ctlRun.controls.length > 0,
  JSON.stringify({ source: ctlRun.source, count: ctlRun.count, kindsTotal: ctlRun.kindsTotal, kinds: ctlRun.kinds }));
// ⚠️ 真 bug 留的绊线（2026-09-24 演示时才发现）：运行时树是**嵌套**的（顶层只有 1 条「容器节点」，
//    子控件在 children 里、且**没有 depth**），而编辑器树是**拍平**的。只数顶层会把控件少算一个数量级。
ok('★ op=controls runtime:true 会把嵌套的运行时树拍平（顶层 1 条 → 拍平后十几条，且 depth 逐层递增）',
  ctlRun.count > 3 && ctlRun.controls.some((c) => c.depth >= 1)
  && ctlRun.controls.every((c) => typeof c.depth === 'number')
  && ctlRun.controls.filter((c) => c.depth === 0).length === 1,
  JSON.stringify({ count: ctlRun.count, rootRows: ctlRun.controls.filter((c) => c.depth === 0).length, depths: [...new Set(ctlRun.controls.map((c) => c.depth))] }));

const snap = await simOp({ op: 'play', action: 'get' });
const logText = (snap.logs || []).map((l) => (l && l.text) || '').join('\n');
ok('★ Lua 真的在跑：日志里有脚本 print 出来的 SIM_SELFTEST_OK', /SIM_SELFTEST_OK/.test(logText), logText.slice(0, 200) || '(no logs)');

const playShot = await simOp({ op: 'shot', target: 'play', label: 'selftest' });
ok('op=shot play：按引擎场景树出 PNG', playShot.bytes > 1000 && /^sim-play-selftest-/.test(playShot.name), playShot.name + ' ' + playShot.bytes + 'B');
ok('op=shot play：带回帧号与画布（可用于断言"第几帧"）', typeof playShot.frame === 'number' && !!playShot.canvasId,
  'frame=' + playShot.frame + ' canvas=' + playShot.canvasId);

const stepped = await simOp({ op: 'play', action: 'step', args: { dt: 0.033 } });
ok('op=play step：时间前进（单步可调试）', typeof stepped.time === 'number' && stepped.time > 0, 'time=' + stepped.time);

// 连帧（面板 5fps）用 reuse=true：固定名覆盖写，不能每帧新建文件
const live1 = await simOp({ op: 'shot', target: 'play', reuse: true });
ok('op=shot reuse=true：连帧用固定名 sim-play-live.png，且 URL 带时间戳绕开缓存',
  live1.name === 'sim-play-live.png' && fs.existsSync(live1.file) && /&t=\d+/.test(live1.url || ''),
  live1.name + '  ' + live1.url);
await simOp({ op: 'shot', target: 'play', reuse: true });
const liveFiles = fs.readdirSync(path.join(tmpData, 'shots')).filter((n) => n.indexOf('sim-play-live') === 0);
ok('★ 连帧不会每帧新建文件（目录里始终只有 1 张 live 帧）', liveFiles.length === 1, JSON.stringify(liveFiles));

// 按键：op=keys 从脚本源码里扫出它真正在听的键名
const keySrc = [
  'function OnStart()',
  // 正确写法取自引擎自己的测试（lua-runtime/test/runtime.test.mjs:548）：
  // 服务端控件模板里 `script.Parent` 是 nil，要用 `script.object:AddKeyEventListener(...)`
  '  script.object:AddKeyEventListener(Enum.KeyEventType.KeyboardCraftspersonKey3Down, function()',
  '    print("GOT_KEY_3")',
  '  end)',
  'end',
  '',
].join('\n');
await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'keys-selftest', source: keySrc } });
const keysInfo = await simOp({ op: 'keys' });
ok('op=keys：从脚本源码扫出真正在听的键名（含 KeyboardCraftspersonKey3Down）',
  Array.isArray(keysInfo.keys) && keysInfo.keys.indexOf('KeyboardCraftspersonKey3Down') >= 0 && (keysInfo.presets || []).length > 0,
  JSON.stringify({ keys: keysInfo.keys, presets: (keysInfo.presets || []).length }));

// 切设备会重建运行时：人数必须被 Host 自动沿用，否则 视角2 会报 playerIndex 1-1（真机踩过）
const p2 = await simOp({ op: 'play', action: 'start', args: { playerCount: 2 } });
ok('op=play start 带 playerCount=2：能开跑', !!p2.canvasId, JSON.stringify({ canvasId: p2.canvasId }));
await simOp({ op: 'play', action: 'device', args: { canvasId: 'pc-21-9' } });
const v2 = await err(() => simOp({ op: 'play', action: 'view', args: { playerIndex: 2 } }));
ok('★ 切设备后仍能切到 P2（人数没悄悄掉回 1 —— Host 自动沿用 start 的 playerCount）', v2 === null, v2);

const stopped = await simOp({ op: 'play', action: 'stop' });
ok('op=play stop：运行态归零', stopped.running === false || stopped.running === undefined, JSON.stringify(stopped).slice(0, 120));

/* ------------------------------------------------- AI 自测逻辑（op=verify） */

// ① 通过：脚本 OnStart 里 print，断言「日志里出现它」
const vPass = await simOp({ op: 'verify', name: 'self-test-pass', expect: [{ kind: 'log', contains: 'SIM_SELFTEST_OK' }] });
ok('★ op=verify 通过：一次调用跑完「开跑→断言→判定」，passed=true 且 results 有明细',
  vPass.passed === true && Array.isArray(vPass.results) && vPass.results.length === 1 && vPass.results[0].ok === true,
  JSON.stringify({ passed: vPass.passed, results: vPass.results }));

// ② 带事件：注入按键后再断言（at 省略 = 最后一个事件之后 0.1s，AI 不用自己算时序）
const vKey = await simOp({ op: 'verify', name: 'self-test-key', steps: [{ key: 'KeyboardCraftspersonKey3Down' }], expect: [{ kind: 'log', contains: 'GOT_KEY_3' }] });
ok('★ op=verify 带动事件：steps 注入按键 → 断言命中（且 at 不用自己算）',
  vKey.passed === true, JSON.stringify({ passed: vKey.passed, events: vKey.case.events, asserts: vKey.case.asserts, results: vKey.results }));

// ③ 服务端变量：setVar 之后断言变量值
const vVar = await simOp({ op: 'verify', name: 'self-test-var', steps: [{ setVar: { entityType: 'PlayerSelf', name: 'Gold', value: 7 } }], expect: [{ kind: 'var', entityType: 'PlayerSelf', name: 'Gold', equals: 7 }] });
ok('op=verify 断言服务端变量（setVar → var == 7）', vVar.passed === true, JSON.stringify(vVar.results));

// ④ 失败要给得出诊断（AI 靠它自己定位，而不是回头问人）
const vFail = await simOp({ op: 'verify', name: 'self-test-fail', steps: [{ setVar: { entityType: 'PlayerSelf', name: 'Gold', value: 7 } }], expect: [{ kind: 'var', entityType: 'PlayerSelf', name: 'Gold', equals: 999 }] });
ok('★ op=verify 失败：passed=false + failedAt + 实际/期望 + 一句人话 hint',
  vFail.passed === false && vFail.failedAt !== null && vFail.results[0].actual === 7 && vFail.results[0].expected === 999 && /断言/.test(vFail.hint || ''),
  JSON.stringify({ passed: vFail.passed, failedAt: vFail.failedAt, r0: vFail.results[0], hint: String(vFail.hint || '').slice(0, 70) }));

// ④b 失败自动取证：一帧失败点 PNG + 运行时控件名（AI 除了日志还能「看」）
ok('★ op=verify 失败自动出图：是**失败点附近**的一帧真 PNG，文件名带 -fail',
  !!vFail.shot && vFail.shot.bytes > 1000 && fs.existsSync(vFail.shot.file)
  && fs.readFileSync(vFail.shot.file).subarray(0, 4).toString('hex') === '89504e47'
  && /-fail-\d{8}-\d{6}\.png$/.test(vFail.shot.name) && /\/miliastra\/shot\?name=/.test(vFail.shot.url || ''),
  JSON.stringify(vFail.shot && { name: vFail.shot.name, bytes: vFail.shot.bytes, frame: vFail.shot.frame }));
ok('★ op=verify 失败自动给运行时控件名（`tree{name}` 断言写错时，照着这份清单改）',
  !!vFail.runtime && Array.isArray(vFail.runtime.controlNames) && vFail.runtime.controlNames.length >= 5
  && typeof vFail.runtime.controlCount === 'number' && vFail.runtime.controlCount >= 5,
  JSON.stringify(vFail.runtime && { frame: vFail.runtime.frame, controlCount: vFail.runtime.controlCount, names: vFail.runtime.controlNames.slice(0, 6) }));

const vNoShot = await simOp({ op: 'verify', name: 'self-test-noshot', expect: [{ kind: 'var', entityType: 'PlayerSelf', name: 'Gold', equals: 999 }], shotOnFail: false });
ok('op=verify shotOnFail:false：不落图（运行时控件名仍给，不额外花一次截图）',
  vNoShot.passed === false && vNoShot.shot === undefined && !!vNoShot.runtime,
  JSON.stringify({ passed: vNoShot.passed, shot: vNoShot.shot, runtime: !!vNoShot.runtime }));

/* ---------------------------------------- 一组用例一次跑（op=verify cases[]） */

const vCases = await simOp({
  op: 'verify',
  cases: [
    { name: 'c-pass-log', expect: [{ kind: 'log', contains: 'SIM_SELFTEST_OK' }] },
    { name: 'c-fail-var', steps: [{ setVar: { entityType: 'PlayerSelf', name: 'Gold', value: 1 } }], expect: [{ kind: 'var', entityType: 'PlayerSelf', name: 'Gold', equals: 2 }] },
    { name: 'c-pass-key', steps: [{ key: 'KeyboardCraftspersonKey3Down' }], expect: [{ kind: 'log', contains: 'GOT_KEY_3' }] },
  ],
});
ok('★ op=verify cases[]：一次调用跑一组回归，逐个给判定（首个失败**不中断**后面的用例）',
  vCases.passed === false && vCases.caseCount === 3 && vCases.passedCount === 2 && vCases.failedCount === 1
  && vCases.cases.length === 3 && vCases.cases[1].passed === false && vCases.cases[2].passed === true,
  JSON.stringify({ passed: vCases.passed, caseCount: vCases.caseCount, passedCount: vCases.passedCount, failedCount: vCases.failedCount }));
ok('op=verify cases 失败：failures[] 点名是哪个用例，hint 写「第几/共几」',
  Array.isArray(vCases.failures) && vCases.failures[0].name === 'c-fail-var' && /2\/3/.test(vCases.hint || ''),
  JSON.stringify({ failures: vCases.failures, hint: String(vCases.hint || '').slice(0, 80) }));
ok('op=verify cases：只给**失败**的用例回 logs 与取证（通过的用例不带噪音）',
  Array.isArray(vCases.cases[1].logs) && vCases.cases[1].logs.length > 0
  && vCases.cases[0].logs === undefined && vCases.cases[2].logs === undefined
  && !!vCases.cases[1].shot && vCases.cases[0].shot === undefined,
  JSON.stringify({ failLogs: vCases.cases[1].logs.length, pass0: vCases.cases[0].logs, shot: vCases.cases[1].shot && vCases.cases[1].shot.name }));

const vCasesOk = await simOp({
  op: 'verify',
  cases: [
    { name: 'a', expect: [{ kind: 'log', contains: 'SIM_SELFTEST_OK' }] },
    { name: 'b', steps: [{ key: 'KeyboardCraftspersonKey3Down' }], expect: [{ kind: 'log', contains: 'GOT_KEY_3' }] },
  ],
});
ok('op=verify cases 全过：passed=true 且 passedCount=2/failedCount=0（且不落图）',
  vCasesOk.passed === true && vCasesOk.passedCount === 2 && vCasesOk.failedCount === 0 && vCasesOk.shot === undefined,
  JSON.stringify({ passed: vCasesOk.passed, p: vCasesOk.passedCount, f: vCasesOk.failedCount }));

// 用例之间**互不影响**才是「能当回归套件」的前提：上一个用例按过的键，不会漏到下一个用例
const vIsolation = await simOp({
  op: 'verify',
  cases: [
    { name: '先按键', steps: [{ key: 'KeyboardCraftspersonKey3Down' }], expect: [{ kind: 'log', contains: 'GOT_KEY_3' }] },
    { name: '全新会话', expect: [{ kind: 'log', contains: 'GOT_KEY_3' }] },
  ],
});
ok('★ op=verify cases：用例之间**互不影响**（每个用例各开全新会话 —— 上个用例按过的键不会漏进下个用例）',
  vIsolation.passed === false && vIsolation.cases[0].passed === true && vIsolation.cases[1].passed === false,
  JSON.stringify(vIsolation.cases.map((c) => ({ n: c.name, p: c.passed }))));


const vStop = await simOp({
  op: 'verify', stopOnFail: true,
  cases: [
    { name: 's1', expect: [{ kind: 'var', entityType: 'PlayerSelf', name: 'Gold', equals: 404 }] },
    { name: 's2', expect: [{ kind: 'log', contains: 'SIM_SELFTEST_OK' }] },
  ],
});
ok('op=verify stopOnFail:true：第一个不过就停，stoppedEarly 如实标明没跑完',
  vStop.caseCount === 1 && vStop.stoppedEarly === true && vStop.failedCount === 1,
  JSON.stringify({ caseCount: vStop.caseCount, stoppedEarly: vStop.stoppedEarly }));

const vBadCases = await err(() => simOp({ op: 'verify', cases: [{ name: 'x' }] }));
ok('op=verify cases 里某项缺 expect：报错**点名第几个用例**（不是笼统一句）',
  !!vBadCases && /cases\[0\]/.test(vBadCases) && /expect/.test(vBadCases), vBadCases);


// ⑤ 用法错误要明确（不能静默"通过"）
const vNoExpect = await err(() => simOp({ op: 'verify' }));
ok('op=verify 缺 expect：明确报错（不会静默当通过）', !!vNoExpect && /expect/.test(vNoExpect), vNoExpect);
const vBadStep = await err(() => simOp({ op: 'verify', steps: [{ fly: 1 }], expect: [{ kind: 'log', contains: 'x' }] }));
ok('op=verify 步骤写错：报错里列出可用种类', !!vBadStep && /clickName/.test(vBadStep), vBadStep);

/* ------------------------------------------------- 失控脚本的护栏（关键） */

await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'sim-runaway', source: 'function OnStart()\n  while true do end\nend\n' } });
const t0 = Date.now();
const runaway = await err(() => simOp({ op: 'play', action: 'start' }));
const cost = Date.now() - t0;
ok('★ 失控 Lua（while true）不会冻住 Host：超时后返回错误', !!runaway && /timed out|terminated|worker/i.test(runaway), runaway + '  [' + cost + 'ms]');
ok('★ 失控脚本在超时窗口内被收掉（不是无限挂起）', cost < 12000, cost + 'ms');
const afterRunaway = await err(() => simOp({ op: 'play', action: 'stop' }));
ok('★ 超时后仍能 stop（Worker 已被 terminate，不留幽灵）', afterRunaway === null, afterRunaway);

/* ---------------------------------------------------------------- 存档 */

const saved = await simOp({ op: 'save', path: 'sim-selftest.save.json' });
ok('op=save：存进模拟器工作区', !!saved.saved && typeof saved.saved.bytes === 'number', JSON.stringify(saved.saved));
const savedFile = path.join(simRuntimeInfo().workspace, 'sim-selftest.save.json');
ok('op=save 的文件真的在（且 JSON 能解析）', fs.existsSync(savedFile) && JSON.parse(fs.readFileSync(savedFile, 'utf8')).format === 'qxqy-simulator-save', savedFile);

const listed = await simOp({ op: 'load' });
ok('op=load 无参：列出工作区存档', Array.isArray(listed.archives) && listed.archives.some((a) => JSON.stringify(a).indexOf('sim-selftest.save.json') >= 0),
  JSON.stringify(listed.archives).slice(0, 200));
const loaded = await simOp({ op: 'load', archive: 'sim-selftest.save.json' });
ok('op=load 带参：读回工程', !!loaded.loaded && Array.isArray(loaded.tree), JSON.stringify(loaded).slice(0, 120));

/* ---------------------------------------------------------------- 边界 */

ok('★ 工作区在临时数据目录下（不指向游戏存档）',
  simRuntimeInfo().workspace.toLowerCase().startsWith(tmpData.toLowerCase()),
  simRuntimeInfo().workspace + ' vs ' + tmpData);

const reset = await simOp({ op: 'reset' });
ok('op=reset：控制器被释放并重建', reset.reset === true && reset.disposed === true, JSON.stringify({ reset: reset.reset, disposed: reset.disposed }));
const after = await simOp({ op: 'state' });
ok('op=reset 后工程回到初始（脚本不残留）', after.scriptCount === 0, 'scriptCount=' + after.scriptCount);

/* ------------------------------------------------- 导出 / 导回（写回能力） */

const fresh = await simOp({ op: 'state' });
const gia = await simOp({ op: 'export', format: 'gia' });
ok('op=export gia：文件真落盘，且在模拟器工作区里（不是游戏目录）',
  gia.bytes > 100 && fs.existsSync(gia.file) && gia.file.toLowerCase().startsWith(tmpData.toLowerCase()),
  gia.file + '  ' + gia.bytes + 'B');
ok('op=export gia：文件名是 .gia，且回执明说「真机未验证」',
  /\.gia$/i.test(gia.name) && /尚未在真机导入验证/.test(gia.note || ''), gia.name);

// 先改一笔，再用导出的那份盖回去 —— 能盖回去才证明 import 真的生效
await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'IMPORT-PROBE' } });
const polluted = await simOp({ op: 'state' });
ok('导出后先弄脏工程（+1 控件）', polluted.treeCount === fresh.treeCount + 1,
  polluted.treeCount + ' vs ' + (fresh.treeCount + 1));

const imported = await simOp({ op: 'import', format: 'gia', file: gia.file });
ok('★ op=import 导回刚导出的 .gia：控件数回到导出那一刻（引擎侧往返成立）',
  imported.treeCount === fresh.treeCount, imported.treeCount + ' vs ' + fresh.treeCount);

const badImport = await err(() => simOp({ op: 'import', format: 'gia', file: uiShot.file }));
ok('op=import 喂错文件（PNG 冒充 gia）：明确报错，不是静默成功', !!badImport, badImport);

const all = await disposeSimAll();
ok('disposeSimAll：所有会话 Worker 收干净', typeof all.disposed === 'number' && simRuntimeInfo().sessions === 0, JSON.stringify(all));

/* ---------------------------------------------------------------- 收尾 */

fs.rmSync(tmpData, { recursive: true, force: true });

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
