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

const snap = await simOp({ op: 'play', action: 'get' });
const logText = (snap.logs || []).map((l) => (l && l.text) || '').join('\n');
ok('★ Lua 真的在跑：日志里有脚本 print 出来的 SIM_SELFTEST_OK', /SIM_SELFTEST_OK/.test(logText), logText.slice(0, 200) || '(no logs)');

const playShot = await simOp({ op: 'shot', target: 'play', label: 'selftest' });
ok('op=shot play：按引擎场景树出 PNG', playShot.bytes > 1000 && /^sim-play-selftest-/.test(playShot.name), playShot.name + ' ' + playShot.bytes + 'B');
ok('op=shot play：带回帧号与画布（可用于断言"第几帧"）', typeof playShot.frame === 'number' && !!playShot.canvasId,
  'frame=' + playShot.frame + ' canvas=' + playShot.canvasId);

const stepped = await simOp({ op: 'play', action: 'step', args: { dt: 0.033 } });
ok('op=play step：时间前进（单步可调试）', typeof stepped.time === 'number' && stepped.time > 0, 'time=' + stepped.time);

const stopped = await simOp({ op: 'play', action: 'stop' });
ok('op=play stop：运行态归零', stopped.running === false || stopped.running === undefined, JSON.stringify(stopped).slice(0, 120));

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
