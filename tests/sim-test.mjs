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
import { fileURLToPath } from 'node:url';

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

const { simOp, disposeSimAll, simRuntimeInfo, scanScriptKeys, stripLuaComments, hudTexts, sceneNodes } = await import('../lib/sim.mjs');

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const err = async (fn) => { try { await fn(); return null; } catch (e) { return (e && e.message) || String(e); } };

/* ---------------------------------------------------------------- 状态 */

let st = await simOp({ op: 'state' });
ok('op=state 默认 summaryOnly：给结论不给全量几何', Array.isArray(st.tree) && st.boxes === undefined && typeof st.boxesOmitted === 'number',
  'tree=' + (st.tree || []).length + ' boxes=' + st.boxes + ' boxesOmitted=' + st.boxesOmitted);
ok('op=state 带回画布预设（默认 PC 1600×900）', !!st.canvas && st.canvas.width === 1600 && st.canvas.height === 900,
  JSON.stringify(st.canvas));
ok('op=state 的工程有根：客户端控件容器 + 容器节点',
  Array.isArray(st.tree) && st.tree.some((n) => n.kind === 'server-container') && st.tree.some((n) => n.kind === 'container'));
/*
 * `factoryDefault`：**Host 重启后内存里的工程就是出厂默认**（用户 2026-09-24 实测：重启后试玩页里
 * 只剩默认的「文本 / 预设按钮 / 五角星」，看着像"什么都没画"）。这个位必须如实上报，面板才能明说 + 给一键重搭。
 */
ok('★ op=state：新会话的工程如实标 `factoryDefault:true`（重启后就是这个状态）', st.factoryDefault === true,
  'factoryDefault=' + st.factoryDefault);
ok('op=state：`lastBind` 位在（还没绑过就是 null，不报假警）', st.lastBind === null || typeof st.lastBind === 'object',
  JSON.stringify(st.lastBind));

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

/*
 * ★★ `op=keys` 的两路扫描（2026-09-24 真机关卡《冰镜·火烛》实测暴露的漏检）
 *
 * 现场证据：游戏日志白纸黑字 `[yuan-code] 收到首个按键事件: KeyboardMoveRightKeyDown（来源=KeyEventType）`，
 * 而 `op=keys` 回的是「脚本源码里没出现 `KeyEventType`」—— **把原因说反了**。真实脚本长这样：
 *
 *     local candidates = { "KeyEventType", "KeyboardKeyCode", "ControllerKeyCode" }   ← 名字只出现一次，且不是 `X.Y`
 *     try(bindHold("KeyboardMoveRightKeyDown", "KeyboardMoveRightKeyUp", function(v) … end))  ← ★ 键名是裸字符串
 *
 * 后果：AI 拿不到键名就只能**猜**，而猜错是**静默失败**。所以这里把两路都钉住。
 */
{
  const twoWays = [
    'script.object:AddKeyEventListener(Enum.KeyEventType.KeyboardCraftspersonKey3Down, function() end)',
    'script.object:AddKeyEventListener(Enum.KeyEventType["KeyboardJumpKeyDown"], function() end)',
    'try(bindHold("KeyboardMoveRightKeyDown", "KeyboardMoveRightKeyUp", function(v) end))',
    'try(bindHold("ControllerCraftspersonKey1Down", "ControllerCraftspersonKey1Up", function(v) end))',
  ].join('\n');
  const k = scanScriptKeys(twoWays);
  const by = (n) => (k.find((x) => x.name === n) || {}).via;
  ok('★ op=keys 两路并扫：`KeyEventType.X`（enum-member）能扫到',
    by('KeyboardCraftspersonKey3Down') === 'enum-member', JSON.stringify(k));
  ok('★ op=keys 两路并扫：`KeyEventType["X"]`（enum-index）能扫到',
    by('KeyboardJumpKeyDown') === 'enum-index');
  ok('★★ op=keys 两路并扫：**裸字符串键名**能扫到（`bindHold("KeyboardMoveRightKeyDown", …)` —— 旧实现漏检的就是它）',
    by('KeyboardMoveRightKeyDown') === 'string-literal' && by('KeyboardMoveRightKeyUp') === 'string-literal',
    JSON.stringify(k.filter((x) => x.via === 'string-literal')));
  ok('★ `Controller*` 手柄键名同样扫得到（脚本里语意键与手柄键是成对写的）',
    by('ControllerCraftspersonKey1Down') === 'string-literal' && k.some((x) => x.name === 'ControllerCraftspersonKey1Up'));

  // 假阳性防线：注释掉的绑定不许当成"它在听这个键"
  const commented = [
    'local candidates = { "KeyEventType", "KeyboardKeyCode" }',
    '-- bindHold("KeyboardSprintKeyDown", "KeyboardSprintKeyUp", function(v) end)',
    '--[[ 旧版写法：',
    '  bindHold("KeyboardInteractKeyDown", "KeyboardInteractKeyUp", function(v) end)',
    ']]',
    'try(bindHold("KeyboardMoveLeftKeyDown", "KeyboardMoveLeftKeyUp", function(v) end))',
  ].join('\n');
  const c = scanScriptKeys(commented).map((x) => x.name);
  ok('★ 注释掉的绑定**不算**（行注释）—— 否则会让 AI 去按一个没人听的键',
    c.indexOf('KeyboardSprintKeyDown') < 0, JSON.stringify(c));
  ok('★ 注释掉的绑定**不算**（长注释 `--[[ … ]]`）', c.indexOf('KeyboardInteractKeyDown') < 0, JSON.stringify(c));
  ok('★ 真机那种「候选表 + 裸字符串」写法：键名照样扫得到（回归：旧版这里返回 0 个）',
    c.indexOf('KeyboardMoveLeftKeyDown') >= 0, JSON.stringify(c));
  ok('★ 只有名字没有 Down/Up 后缀的字符串不算键名（`"KeyboardSomething"` 是别的用途）',
    scanScriptKeys('local label = "KeyboardSomething"').length === 0);
  ok('★ 字符串里的 `--` **不会**被当成行注释截断（`local u = "a--b"` 后面那行照样扫）',
    scanScriptKeys('local u = "a--b"\ntry(bindHold("KeyboardMoveRightKeyDown", "KeyboardMoveRightKeyUp", f))')
      .some((x) => x.name === 'KeyboardMoveRightKeyDown'));
  ok('★ 同一个键名两路都命中时，保留**更明确**的来源（enum-member 胜过 string-literal）',
    scanScriptKeys('Enum.KeyEventType.KeyboardJumpKeyDown\nbindHold("KeyboardJumpKeyDown", f)')
      .find((x) => x.name === 'KeyboardJumpKeyDown').via === 'enum-member');
  ok('★ 结果按名字排序（回执照抄进断言时顺序稳定）',
    JSON.stringify(k.map((x) => x.name)) === JSON.stringify(k.map((x) => x.name).slice().sort()));

  // stripLuaComments：字符串必须原样留着（键名就住在字符串里）
  ok('stripLuaComments：剥掉行注释、保留字符串内容',
    stripLuaComments('local a = 1 -- KeyboardJumpKeyDown\nlocal s = "KeyboardMoveRightKeyDown"')
      .indexOf('KeyboardJumpKeyDown') < 0
    && stripLuaComments('local s = "KeyboardMoveRightKeyDown"').indexOf('KeyboardMoveRightKeyDown') >= 0);
  ok('stripLuaComments：剥掉长注释、保留长字符串',
    stripLuaComments('--[[ x ]] local s = [[ y ]]').trim() === 'local s = [[ y ]]',
    JSON.stringify(stripLuaComments('--[[ x ]] local s = [[ y ]]')));
}

/*
 * ★ `hudTexts`：只把"画面上的字"挑出来（纯函数，喂真机形状的场景）。
 *
 * 为什么要有它：AI 想边玩边判断就得读游戏状态，而 `get{view:true}` 一次 ≈200ms、几十 KB
 * （31 个控件的矩阵/尺寸/颜色全在里面），真正要的常常只是 HUD 那两行字。
 * 实测代价（2026-09-24）：我为了读到「第1关 教学（1/3） 分数 0」先 dump 了整个场景。
 */
{
  const scene = {
    scene: {
      nodes: [
        { id: 1, parent: null, kind: 'container', matrix: { tx: 800, ty: 450 } },
        { id: 16, parent: 1, kind: 'textbox', matrix: { tx: -360, ty: 374 }, sourceWidth: 900, sourceHeight: 40, text: '第1关 教学（1/3）  分数 0' },
        { id: 9, parent: 1, kind: 'image', matrix: { tx: 100, ty: -355 }, sourceWidth: 110, sourceHeight: 81, text: '这张不是文字控件，不该出现' },
        { id: 17, parent: 1, kind: 'textbox', matrix: { tx: -300, ty: 320 }, sourceWidth: 900, sourceHeight: 40 },
      ],
    },
  };
  const hud = hudTexts(scene);
  ok('★ op=hud 只挑 `textbox` 的文字（图片控件上的 text 字段不算）', hud.length === 2 && hud[0].text.indexOf('第1关') === 0,
    JSON.stringify(hud));
  ok('★★ op=hud 给的是**世界坐标**（沿 parent 链累加容器偏移，不是相对坐标）：-360 + 800 = 440',
    hud[0].x === 440 && hud[0].y === 824, JSON.stringify({ x: hud[0].x, y: hud[0].y }));
  ok('★ op=hud：没写 text 的文本框回空串（不是 `undefined`）', hud[1].text === '', JSON.stringify(hud[1]));
  ok('★ op=hud：没有会话/空场景都不炸（回空数组）',
    hudTexts({}).length === 0 && hudTexts(null).length === 0 && hudTexts({ scene: {} }).length === 0);

  // `sceneNodes`：摊平成一张表（`op=controls runtime:true geom:true` 的底座）
  const flat = sceneNodes(scene);
  ok('★ sceneNodes：每个控件一行，带世界坐标/尺寸/kind（文字只在非空时带）',
    flat.length === 4 && flat[0].kind === 'container' && flat[1].x === 440 && flat[1].width === 900
    && flat[1].text.indexOf('第1关') === 0 && flat[3].text === undefined,
    JSON.stringify(flat));
  ok('★ sceneNodes：`text` 只在非空时带（空文本框连这个字段都没有，省 token）',
    flat[3].kind === 'textbox' && !('text' in flat[3]), JSON.stringify(flat[3]));
  ok('★ sceneNodes：`pressed` 只在真按下时才带（省字段）',
    sceneNodes({ scene: { nodes: [{ id: 1, parent: null, kind: 'button', matrix: { tx: 10, ty: 20 }, pressed: false }] } })[0].pressed === undefined
    && sceneNodes({ scene: { nodes: [{ id: 1, parent: null, kind: 'button', matrix: { tx: 10, ty: 20 }, pressed: true }] } })[0].pressed === true);
  ok('★ sceneNodes：父链断了也不死循环（`parent` 指向不存在的 id）',
    sceneNodes({ scene: { nodes: [{ id: 9, parent: 999, kind: 'image', matrix: { tx: 1, ty: 2 } }] } })[0].x === 1);
}

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
ok('★ op=keys 回执带 `found[].via`（名字从哪来）+ `byVia` 计数 —— AI 据此判断可不可信',
  Array.isArray(keysInfo.found) && keysInfo.found.length === keysInfo.keys.length
  && keysInfo.found.every((f) => f.name && ['enum-member', 'enum-index', 'string-literal'].indexOf(f.via) >= 0)
  && !!keysInfo.byVia && typeof keysInfo.byVia.enum === 'number' && typeof keysInfo.byVia.stringLiteral === 'number',
  JSON.stringify({ found: keysInfo.found, byVia: keysInfo.byVia }));
ok('★ op=keys 提醒「按 Down 要配对 Up」（实测：只发 Down 会把角色一路推到掉出边界）',
  /Down/.test(String(keysInfo.releaseNote)) && /Up/.test(String(keysInfo.releaseNote)),
  String(keysInfo.releaseNote || '').slice(0, 60));
/*
 * ★ 「找个按键这么久」的教训（作者原话）：我知道键名之后，**还得翻 4 个源文件**才知道 `play` 的 `key` 怎么发
 * （`session.js` → `browser-session.js` → `controller.js` → `worker.js`）。请求形状属于 schema 该说的话。
 * 现在 `op=keys` 直接把可照抄的请求体给出来 —— 这两条钉住它别退化。
 */
ok('★★ op=keys 回执带 `press`：key / pointer / click / step / hud 的**可照抄请求体**（别再让 AI 翻源码找形状）',
  !!keysInfo.press && keysInfo.press.key && keysInfo.press.key.body.op === 'play'
  && keysInfo.press.key.body.action === 'key' && typeof keysInfo.press.key.body.args.key === 'string'
  && keysInfo.press.pointer.body.args.type === 'move'
  && keysInfo.press.click.body.args.name !== undefined
  && keysInfo.press.step.body.args.dt > 0
  && keysInfo.press.hud.body.op === 'hud',
  JSON.stringify(keysInfo.press));
ok('★ op=keys 默认**不**回全量键名（164 个 ≈3KB），只给一句「要就传 all:true」+ allCount',
  keysInfo.all === undefined && typeof keysInfo.allCount === 'number' && /all:true/.test(String(keysInfo.allHint)),
  JSON.stringify({ all: keysInfo.all === undefined, allCount: keysInfo.allCount }));

const keysAll = await simOp({ op: 'keys', all: true });
ok('★★ op=keys {all:true}：给**全量 164 个键名**（正源是引擎的 `buildEnumTree()`，不是我们抄的表）',
  Array.isArray(keysAll.all) && keysAll.all.length === 164 && keysAll.allCount === 164,
  'all=' + (keysAll.all || []).length);
ok('★ 全量键名里有语义键与工匠键的头尾（KeyboardCraftspersonKey1Down / Key43Up / ControllerJumpKeyDown）',
  ['KeyboardCraftspersonKey1Down', 'KeyboardCraftspersonKey43Up', 'KeyboardJumpKeyDown', 'ControllerJumpKeyDown',
    'KeyboardCharacterSkill4KeyUp'].every((n) => keysAll.all.indexOf(n) >= 0),
  JSON.stringify(keysAll.all.slice(0, 3)));

// op=hud：一次调用只回画面上的字（"边玩边判断"的最短路径）
const hudInfo = await simOp({ op: 'hud' });
ok('★ op=hud：只回画面上的字（默认工程里有「文本框」）+ frame/time，省掉 dump 整个场景',
  Array.isArray(hudInfo.lines) && hudInfo.count === hudInfo.texts.length && hudInfo.count >= 1
  && typeof hudInfo.frame === 'number' && typeof hudInfo.time === 'number',
  JSON.stringify(hudInfo));
ok('★ op=hud 每条带 id 与有限的世界坐标（点击用得上）',
  hudInfo.texts.every((t) => t.id > 0 && Number.isFinite(t.x) && Number.isFinite(t.y) && typeof t.text === 'string'),
  JSON.stringify(hudInfo.texts));

/*
 * ★ `op=controls runtime:true geom:true`：一次给出"屏幕上有哪些控件、在哪、上面什么字"。
 * 为什么值得：`op=hud` 只解决"字"；AI 要**点**某个控件时还需要坐标 —— 而运行时实例**都叫模板名**，
 * 光看 `{id,name,kind,depth}` 根本认不出谁是谁（实测：31 个控件里 29 个都叫 IMAGE_TEMPLATE）。
 */
const ctlPlain = await simOp({ op: 'controls', runtime: true });
const ctlGeom = await simOp({ op: 'controls', runtime: true, geom: true });
ok('★ op=controls 默认**不带**几何（省 token）', ctlPlain.controls.every((c) => c.x === undefined && c.w === undefined));
ok('★★ op=controls {runtime:true,geom:true}：**有几何的行**都合法（世界坐标 + 源尺寸），且与 op=hud 对得上',
  ctlGeom.controls.length === ctlPlain.controls.length
  && ctlGeom.geomCovered >= 1
  && ctlGeom.geomCovered + ctlGeom.geomMissing === ctlGeom.controls.length
  && ctlGeom.controls.filter((c) => c.x !== undefined)
    .every((c) => Number.isFinite(c.x) && Number.isFinite(c.y) && c.w > 0 && c.h > 0)
  && !!ctlGeom.geomNote,
  JSON.stringify({ covered: ctlGeom.geomCovered, missing: ctlGeom.geomMissing, rows: ctlGeom.controls.length }));
/*
 * ⚠️ **场景 ≠ 控件树**（2026-09-24 实测出来的）：`scene` 只含**会被渲染**的控件 ——
 * 工厂默认工程 `tree` 11 行、`scene` 只有 5 个节点。所以"没有 x/y"**不等于**"控件不存在"，
 * 回执必须把 covered/missing 摆出来，否则 AI 会把"不在画面上"误判成"没建出来"。
 */
ok('★★ 几何只对"会被渲染"的控件给：回执如实报 \`geomCovered\`/\`geomMissing\`（missing > 0 是正常现象，不是故障）',
  ctlGeom.geomMissing > 0 && /不是不存在/.test(String(ctlGeom.geomNote)),
  JSON.stringify({ covered: ctlGeom.geomCovered, missing: ctlGeom.geomMissing,
    noGeom: ctlGeom.controls.filter((c) => c.x === undefined).map((c) => c.kind) }));
ok('★ geom 行的文字与 `op=hud` 对得上（同一个文本框，同一个坐标）—— 两条路不会互相打架',
  (() => {
    const t = hudInfo.texts[0];
    const row = ctlGeom.controls.find((c) => Number(c.id) === Number(t.id));
    return !!row && row.text === t.text && row.x === t.x && row.y === t.y;
  })(), JSON.stringify({ hud: hudInfo.texts[0], row: ctlGeom.controls.find((c) => c.text) }));
ok('★ geom 版没把回执撑大（仍远小于底层 75 KB 的 tree+scene）',
  JSON.stringify(ctlGeom).length < 12000, JSON.stringify(ctlGeom).length + ' 字符');

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

/* ------------------------------- 拖拽（drag）与「建了几个」（count） */

// 拖拽要看引擎的 CursorBeginDrag / CursorDrag / CursorEndDrag —— 用引擎自己测试里的同一套写法
await simOp({
  op: 'patch',
  patch: {
    op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'drag-selftest',
    source: [
      'local function listen(button, eventType, label)',
      '  button:AddCursorEventListener(eventType, function(data)',
      '    local dx, dy = data:GetUIPosDelta()',
      '    print(label, data.dragging, dx, dy)',
      '  end)',
      'end',
      'function OnStart()',
      '  script.object.showCursor = true',
      '  local button = script.object:FindChild("预设按钮")',
      '  listen(button, Enum.CursorEventType.CursorBeginDrag, "DRAG_BEGIN")',
      '  listen(button, Enum.CursorEventType.CursorDrag, "DRAG_MOVE")',
      '  listen(button, Enum.CursorEventType.CursorEndDrag, "DRAG_END")',
      '  listen(button, Enum.CursorEventType.CursorClick, "DRAG_CLICK")',
      'end',
      '',
    ].join('\n'),
  },
});

const vDrag = await simOp({
  op: 'verify', name: 'drag',
  steps: [{ drag: { from: [800, 450], to: [830, 470], steps: 3, gap: 0.05 } }],
  expect: [
    { kind: 'log', contains: 'DRAG_BEGIN' },
    { kind: 'log', contains: 'DRAG_MOVE' },
    { kind: 'log', contains: 'DRAG_END' },
  ],
});
ok('★ op=verify 的 drag：一句 `drag:{from,to}` 展开成 down→move…→up，命中拖拽三阶段（begin/move/end）',
  vDrag.passed === true && vDrag.case.events.length === 5
  && vDrag.case.events[0].payload.type === 'down' && vDrag.case.events[4].payload.type === 'up',
  JSON.stringify({ passed: vDrag.passed, events: vDrag.case.events.map((e) => e.payload.type + '@' + e.t), results: vDrag.results }));
ok('op=verify 的 drag：拖完**不算点击**（引擎只有在原地 up 才发 CursorClick）',
  !(vDrag.snapshot.logs || []).some((l) => /DRAG_CLICK/.test(String(l.text || ''))),
  JSON.stringify(((vDrag.snapshot && vDrag.snapshot.logs) || []).map((l) => l.text).slice(-6)));

const vDragBad = await err(() => simOp({ op: 'verify', steps: [{ drag: { from: 1, to: [2, 3] } }], expect: [{ kind: 'log', contains: 'x' }] }));
ok('op=verify 的 drag 参数写错：明确报错（不静默发一个坏事件）', !!vDragBad && /drag\.from/.test(vDragBad), vDragBad);

const vPointer = await simOp({
  op: 'verify', name: 'raw-pointer',
  steps: [{ pointer: { type: 'down', x: 800, y: 450 } }, { pointer: { type: 'up', x: 800, y: 450 } }],
  expect: [{ kind: 'log', contains: 'DRAG_CLICK' }],
});
ok('op=verify 的裸 pointer：手排 down→up 就是一次点击（CursorClick）', vPointer.passed === true,
  JSON.stringify({ passed: vPointer.passed, results: vPointer.results }));

// 「建了几个」：tree{exists} 只能答建了吗，count 才能数数量
const vCountOk = await simOp({
  op: 'verify', name: 'count-ok',
  expect: [{ kind: 'count', name: '文本框', equals: 1 }, { kind: 'count', controlKind: 'textbox', atLeast: 1 }],
});
ok('★ op=verify 的 count：数出「几个同名控件 / 几个某类型控件」（tree{exists} 答不了这个）',
  vCountOk.passed === true && vCountOk.results[0].actual === 1,
  JSON.stringify(vCountOk.results));

const vCountFail = await simOp({
  op: 'verify', name: 'count-fail', shotOnFail: false,
  expect: [{ kind: 'count', name: '文本框', equals: 3 }],
});
ok('op=verify 的 count 不过时：actual 是**真实数量**、expected 是期望数量（AI 一眼看出差几个）',
  vCountFail.passed === false && vCountFail.results[0].actual === 1 && vCountFail.results[0].expected === 3,
  JSON.stringify(vCountFail.results));

const vCountAtLeast = await simOp({
  op: 'verify', name: 'count-at-least', shotOnFail: false,
  expect: [{ kind: 'count', controlKind: 'textbox', atLeast: 9 }],
});
ok('op=verify 的 count atLeast：不足时报「>=(n)」而不是假装相等',
  vCountAtLeast.passed === false && vCountAtLeast.results[0].expected === '>=9',
  JSON.stringify(vCountAtLeast.results));


// ⑤ 用法错误要明确（不能静默"通过"）
const vNoExpect = await err(() => simOp({ op: 'verify' }));
ok('op=verify 缺 expect：明确报错（不会静默当通过）', !!vNoExpect && /expect/.test(vNoExpect), vNoExpect);
const vBadStep = await err(() => simOp({ op: 'verify', steps: [{ fly: 1 }], expect: [{ kind: 'log', contains: 'x' }] }));
ok('op=verify 步骤写错：报错里列出可用种类', !!vBadStep && /clickName/.test(vBadStep), vBadStep);

/* ------------------------------- 帧序列 + 帧间像素差（op=frames） */

// 会动的工程：容器节点 1 秒内 x 从 0 → 100（写法抄引擎自己的 studio 测试 scripts.test.mjs:138）
await simOp({
  op: 'patch',
  patch: {
    op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'tween-move',
    source: 'function OnStart()\n  game.Tween(script.object, { anchoredPositionX = 100 }, 1):SetEase(Enum.EaseType.Linear):Play()\nend\n',
  },
});
const fr = await simOp({ op: 'frames', frames: [0, 0.5, 1], label: 'selftest-move' });
ok('★ op=frames：按时间点出帧（3 帧、各自真落盘、1600×900、文件名带 t）',
  fr.frameCount === 3 && fr.frames.length === 3
  && fr.frames.every((f) => fs.existsSync(f.file) && f.bytes > 1000 && f.pixelWidth === 1600 && f.pixelHeight === 900)
  && /-t0\.5-/.test(fr.frames[1].name),
  JSON.stringify(fr.frames.map((f) => f.name)));
ok('op=frames：帧号随时间前进（0 → 16 → 32，即 1/30 秒固定步长）',
  fr.frames[0].frame === 0 && fr.frames[1].frame === 16 && fr.frames[2].frame === 32,
  JSON.stringify(fr.frames.map((f) => f.frame)));

const d0 = fr.diffs[0];
const d1 = fr.diffs[1];
ok('★ op=frames：帧间**像素差**是数字（changedPixels / changedRatio / maxDelta / bbox），会动的工程不是 identical',
  fr.diffs.length === 2 && d0.identical === false && d0.changedPixels > 1000
  && d0.changedRatio > 0 && d0.changedRatio <= 1 && d0.maxDelta > 0 && !!d0.bbox,
  JSON.stringify({ pixels: d0.changedPixels, ratio: d0.changedRatio, max: d0.maxDelta, bbox: d0.bbox }));
ok('op=frames：bbox 在画布内且非空（能直接看出"变的是哪一块"）',
  d0.bbox.x >= 0 && d0.bbox.y >= 0 && d0.bbox.width > 0 && d0.bbox.height > 0
  && d0.bbox.x + d0.bbox.width <= 1600 && d0.bbox.y + d0.bbox.height <= 900,
  JSON.stringify(d0.bbox));
ok('★ op=frames：`changedControls` 直接点名**哪个控件的哪个字段**变了（位置在 `matrix.tx` 上，不是 anchoredPositionX）',
  d0.changedControls.length >= 1 && d0.changedControls[0].name === '容器节点'
  && Array.isArray(d0.changedControls[0].fields['matrix.tx']),
  JSON.stringify(d0.changedControls));
{
  // ★ 两个**独立通道**互相印证：场景字段位移 vs 像素 bbox 位移
  const txFirst = d0.changedControls[0].fields['matrix.tx'];
  const txSecond = d1.changedControls[0].fields['matrix.tx'];
  const sceneShift = txSecond[1] - txFirst[1];
  const pixelShift = d1.bbox.x - d0.bbox.x;
  ok('★ 像素位移与场景字段位移**对得上**（0→0.5→1 秒各右移 50 世界单位，bbox 也各右移 50px，±3px 容差）',
    Math.abs(sceneShift - 50) < 1 && Math.abs(pixelShift - 50) <= 3,
    'scene=' + sceneShift + 'px=' + pixelShift);
}

// 负对照：清成静态工程后，同一时间点两次取帧必须**逐像素相同**（证明差的不是噪声）
await simOp({ op: 'reset' });
const still = await simOp({ op: 'frames', frames: [0, 0.5], label: 'selftest-still' });
ok('★ op=frames 负对照：静态工程 `identical:true` / 0 像素差 / 无控件变化（数字不是噪声）',
  still.diffs[0].identical === true && still.diffs[0].changedPixels === 0
  && still.diffs[0].maxDelta === 0 && still.diffs[0].changedControls.length === 0,
  JSON.stringify(still.diffs[0]));

const still2 = await simOp({ op: 'frames', frames: [0, 0.5], label: 'selftest-still' });
ok('★ op=frames 可复现：同一调用跑两遍，像素差数字一样（内部是"暂停 + 单步"，时间不会自己漂）',
  still2.diffs[0].changedPixels === still.diffs[0].changedPixels
  && still2.frames[1].frame === still.frames[1].frame,
  still.diffs[0].changedPixels + ' vs ' + still2.diffs[0].changedPixels);

const frNoDiff = await simOp({ op: 'frames', frames: [0, 0.2], diff: false });
ok('op=frames diff:false：只出帧、不比像素（省一次解码）',
  frNoDiff.frameCount === 2 && frNoDiff.diffs.length === 0 && frNoDiff.frames.every((f) => fs.existsSync(f.file)));

const frNoTimes = await err(() => simOp({ op: 'frames' }));
ok('op=frames 缺 frames：报错并给出可照抄的例子', !!frNoTimes && /frames:\[0,0\.5,1\]/.test(frNoTimes), frNoTimes);
const frTooMany = await err(() => simOp({ op: 'frames', frames: new Array(13).fill(0).map((_, i) => i) }));
ok('op=frames 帧数超上限（12）：明确报错', !!frTooMany && /最多 12 帧/.test(frTooMany), frTooMany);
const frTooLong = await err(() => simOp({ op: 'frames', frames: [60], dt: 1 / 30 }));
ok('op=frames 要推进的步数过大：报错并给出「换更大的 dt」这条路（不是默默跑十分钟）',
  !!frTooLong && /dt/.test(frTooLong) && /步/.test(frTooLong), frTooLong);

/* ------------------------------- 动态实例化的叠层（真机口径：后建的在上） */

/*
 * 为什么专门测这个：引擎原来把 `InstantiateClientUIControl` 建出来的控件 **append 到末尾**，
 * 而内部 children 是「前→后」（index 0 最上层）⇒ 新控件落在**最底层**。
 * 真机口径是反的：真机关卡《冰镜·火烛》先建满屏背景、后建平台，真机上**平台可见**。
 * 这条不通，双相那种"先铺背景再摆东西"的写法在模拟器里就只剩背景色（实测踩到）。
 */
await simOp({ op: 'reset' });
// 这里原来要「建模板 → 存盘 → 手改 JSON 里的 guid → 读回 → 挂脚本」四步（手写探针）。
// 现在直接用 op=bind —— 模板索引由交接值给，脚本从文件读，一个调用搭好。
const layerLua = path.join(tmpData, 'layer-selftest.lua');
fs.writeFileSync(layerLua, [
  'function OnStart()',
  '  local a = game.InstantiateClientUIControl(1073741868, script.object)',
  '  local b = game.InstantiateClientUIControl(1073741868, script.object)',
  '  a:SetSizeDelta(1600, 900); a:SetAnchoredPosition(0, 0); a.imageColor = Color.FromRGBA(255, 0, 0, 255)',
  '  b:SetSizeDelta(1600, 900); b:SetAnchoredPosition(0, 0); b.imageColor = Color.FromRGBA(0, 255, 0, 255)',
  'end',
  '',
].join('\n'), 'utf8');
const layerBind = await simOp({
  op: 'bind', source: layerLua, run: false,
  templates: [{ guid: 1073741868, kind: 'image', name: '层测试模板' }],
});
ok('op=bind：模板 guid 就用交接值（不是引擎自己编的号）',
  layerBind.templates.length === 1 && layerBind.templates[0].guid === 1073741868,
  JSON.stringify(layerBind.templates));
await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
const layerShot = await simOp({ op: 'shot', target: 'play', label: 'layer-selftest' });
{
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(fs.readFileSync(layerShot.file));
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
  ok('★ 动态实例化的叠层：**后建的在上**（中心像素是后建那个的颜色）—— 真机口径，双相靠它才看得见平台',
    d[1] > 200 && d[0] < 60, 'rgba(' + d[0] + ',' + d[1] + ',' + d[2] + ',' + d[3] + ')');
}
await simOp({ op: 'play', action: 'stop' });

/* ------------------------------- op=bind：真机工程搬进模拟器（一条命令） */

/*
 * 为什么要有这条：双相那次预测试是**手写探针**跑通的（建模板 → 存盘改 guid → 挂脚本 → 起会话）。
 * 那套流程里最容易出错的不是技术，是**交接值**：模板索引错了，脚本 `InstantiateClientUIControl`
 * 静默什么也不建 —— 看起来"跑起来了"，其实全是空的。所以 bind 要做两件事：
 *   ① 模板 guid 一律用交接值（缺就报错，不许编造）；② 把"源码里出现的真机 id"和交接值摆在一起核对。
 */
const bindLua = path.join(tmpData, '双相自检.lua');
fs.writeFileSync(bindLua, [
  'local IMAGE_TEMPLATE = 1073741868',
  'local TEXT_TEMPLATE = 1073741867',
  'local CONTAINER = 1073741866',
  'function OnStart()',
  '  print("[bind-selftest] ready")',
  '  local a = game.InstantiateClientUIControl(IMAGE_TEMPLATE, script.object)',
  '  a:SetSizeDelta(120, 60)',
  '  a.imageColor = Color.FromRGBA(0, 128, 255, 255)',
  'end',
  '',
].join('\n'), 'utf8');

const bound = await simOp({
  op: 'bind',
  source: bindLua,
  templates: [
    { guid: 1073741868, kind: 'image', name: '图片模板' },
    { guid: 1073741867, kind: 'textbox', name: '文本框模板' },
  ],
  containerId: 1073741866,
});
ok('★ op=bind：模板按交接值建好（guid 原样落地，不是引擎另编的号）',
  bound.templateCount === 2 && bound.templates.map((t) => t.guid).sort().join(',') === '1073741867,1073741868',
  JSON.stringify(bound.templates));
ok('★ op=bind：脚本挂上了（mount 指向容器节点，path 用文件名）',
  bound.scripts.length === 1 && bound.scripts[0].mounted === true && bound.scripts[0].path === '双相自检.lua',
  JSON.stringify({ scripts: bound.scripts, mount: bound.mount }));
ok('★ op=bind 默认起一次会话，回「脚本跑没跑」的**直接证据**（它自己 print 的那行）',
  !!bound.run && bound.run.logs.some((l) => /bind-selftest\] ready/.test(l.text || '')),
  JSON.stringify(bound.run && bound.run.logs));
ok('★ op=bind 回「控件建了几个」= 运行时树拍平后的数（不是编辑器树）',
  !!bound.run && bound.run.controlCount >= 1, 'controlCount=' + (bound.run && bound.run.controlCount));
ok('op=bind：交接值交叉核对 —— 源码里的真机 id 与交接值对得上（missing 空 / 容器索引在源码里）',
  bound.handover.missing.length === 0 && bound.handover.containerIdInSource === true
  && bound.handover.idsInSource.join(',') === '1073741866,1073741867,1073741868',
  JSON.stringify(bound.handover));
ok('op=bind：源码指纹（sha1/字节/行数）一并回，能对「跑的是不是本地这版」',
  /^[0-9a-f]{12}$/.test(bound.source.sha1_12) && bound.source.bytes > 0 && bound.source.lines > 0,
  JSON.stringify(bound.source));
ok('op=bind：默认清掉出厂橱窗控件（只留你的工程）—— 服务端树上只剩容器本身',
  bound.treeCount <= 2, 'treeCount=' + bound.treeCount);
ok('op=bind：会话没被留着（默认跑完就停）', bound.run.keptRunning !== true);

const bindKeep = await simOp({ op: 'bind', source: bindLua, run: false, keepFactory: true, templates: [{ guid: 1073741868, kind: 'image' }] });
ok('op=bind keepFactory:true：保留出厂控件（treeCount 明显更大）', bindKeep.treeCount > bound.treeCount,
  bindKeep.treeCount + ' vs ' + bound.treeCount);

const bindNoTemplates = await err(() => simOp({ op: 'bind', source: bindLua }));
ok('★ op=bind 缺 templates：报错并教怎么给（**不许编造模板索引**）',
  !!bindNoTemplates && /templates/.test(bindNoTemplates) && /guid/.test(bindNoTemplates), bindNoTemplates);
const bindBadKind = await err(() => simOp({ op: 'bind', source: bindLua, templates: [{ guid: 1073741868, kind: '不存在的类型' }] }));
ok('op=bind kind 不在允许表里：报错并列出可用 kind', !!bindBadKind && /image/.test(bindBadKind), bindBadKind);
const bindDupGuid = await err(() => simOp({ op: 'bind', source: bindLua, templates: [{ guid: 1073741868, kind: 'image' }, { guid: 1073741868, kind: 'textbox' }] }));
ok('op=bind 同一个模板索引交两次：报错（重复的 guid 永远解析不出来）', !!bindDupGuid && /重复/.test(bindDupGuid), bindDupGuid);
const bindNoFile = await err(() => simOp({ op: 'bind', source: path.join(tmpData, '不存在.lua'), templates: [{ guid: 1, kind: 'image' }] }));
ok('op=bind 读不到 Lua：报错说清路径与原因（不是静默空跑）', !!bindNoFile && /读不到/.test(bindNoFile), bindNoFile);
const bindWrongCanvas = await err(() => simOp({ op: 'bind', source: bindLua, canvasId: 'nope', templates: [{ guid: 1073741868, kind: 'image' }] }));
ok('op=bind 画布 id 不认识：报错并列出可用画布', !!bindWrongCanvas && /pc-16-9/.test(bindWrongCanvas), bindWrongCanvas);

/*
 * ★ 配方（last-bind.json）：**Host 重启后内存里的工程回到出厂默认** —— 用户实测那次"试玩页里
 * 只剩默认控件"就是这么来的。所以成功 bind 要记一份配方，重启后 `last:true` 一键重搭。
 */
const recipeFile = path.join(tmpData, 'simulator', 'last-bind.json');
ok('★ op=bind 记下配方（last-bind.json）：源文件 + 交接值 —— 重启后一键重搭的依据',
  fs.existsSync(recipeFile) && JSON.parse(fs.readFileSync(recipeFile, 'utf8')).source === bindLua,
  recipeFile);
ok('op=bind 回执带 `recipe` 路径（面板/人能照着找）', !!bindKeep.recipe && /last-bind\.json$/.test(bindKeep.recipe), bindKeep.recipe);
const rebound = await simOp({ op: 'bind', last: true, run: false });
ok('★ op=bind last:true：用配方一键重搭（交接值照原样、`fromLast:true`）',
  rebound.fromLast === true && rebound.templateCount === 1 && rebound.handover.missing.length === 0,
  JSON.stringify({ fromLast: rebound.fromLast, templates: rebound.templates, missing: rebound.handover.missing }));
ok('op=bind 之后 `factoryDefault:false`（工程里有你的东西了）', (await simOp({ op: 'state' })).factoryDefault === false);
const reboundState = await simOp({ op: 'state' });
ok('op=state 的 `lastBind` 能报出配方是谁（面板写「一键重搭上次：双相自检.lua」用）',
  !!reboundState.lastBind && reboundState.lastBind.scriptName === '双相自检.lua',
  JSON.stringify(reboundState.lastBind));
{
  // 配方丢了 → 明确报错（不是静默搭个空的）
  const keep = fs.readFileSync(recipeFile, 'utf8');
  fs.rmSync(recipeFile);
  const noRecipe = await err(() => simOp({ op: 'bind', last: true }));
  ok('op=bind last:true 但没有配方：明确报错并说怎么产生配方', !!noRecipe && /还没有可重搭的配方/.test(noRecipe), noRecipe);
  fs.writeFileSync(recipeFile, keep, 'utf8');
}

/* ------------------------------- op=handover：交接值从哪来（别靠人抄） */

/*
 * 交接值抄错一位 → 脚本 `InstantiateClientUIControl` **静默什么都不建**（不报错）。
 * 所以先有一步「把源码里写着的真机 id 摆出来」：`local NAME = <大整数>` —— 这是**真值**，不是抄来的。
 * 但 kind 只能提示（按变量名猜）：控件类型错同样是静默失败，必须由创作者确认。
 */
const hoLua = path.join(tmpData, '交接自检.lua');
fs.writeFileSync(hoLua, [
  '-- 创作者交接的三个值（真机界面控件组库里那几条模板的索引）',
  'local CONTAINER_INDEX_HANDOVER = 1073741866',
  'local TEXTBOX_TEMPLATE = 1073741867',
  'local IMAGE_TEMPLATE = 1073741868',
  'local LIMIT = 60',
  'function OnStart()',
  '  local a = game.InstantiateClientUIControl(IMAGE_TEMPLATE, script.object)',
  '  print("[ho-selftest] " .. tostring(a ~= nil))',
  'end',
  '',
].join('\n'), 'utf8');

const ho = await simOp({ op: 'handover', source: hoLua });
ok('★ op=handover：把源码里的交接值抽出来（含**变量名**，不是让人抄）',
  ho.candidates.length === 3 && ho.candidates.map((c) => c.value).join(',') === '1073741866,1073741867,1073741868',
  JSON.stringify(ho.candidates));
ok('op=handover：kind 只按变量名**提示**（IMAGE→image / TEXT→textbox / CONTAINER→role=container）',
  ho.candidates.find((c) => c.name === 'IMAGE_TEMPLATE').kindHint === 'image'
  && ho.candidates.find((c) => c.name === 'TEXTBOX_TEMPLATE').kindHint === 'textbox'
  && ho.candidates.find((c) => c.name === 'CONTAINER_INDEX_HANDOVER').role === 'container'
  && ho.candidates.find((c) => c.name === 'CONTAINER_INDEX_HANDOVER').isTemplate === false,
  JSON.stringify(ho.candidates.map((c) => [c.name, c.kindHint, c.role])));
ok('op=handover：直接给一份可照抄的 suggestedTemplates + containerId',
  ho.suggestedTemplates.length === 2 && ho.containerId === 1073741866
  && ho.suggestedTemplates.every((t) => ['image', 'textbox'].indexOf(t.kind) >= 0),
  JSON.stringify({ t: ho.suggestedTemplates, c: ho.containerId }));
ok('op=handover：小整数（如 60）不会被当成交接值',
  !ho.candidates.some((c) => c.value === 60), JSON.stringify(ho.candidates.map((c) => c.value)));
ok('op=handover：活文件清单是数组（这台机器上可能为空 —— 如实回，不报假警）', Array.isArray(ho.files), JSON.stringify(ho.fileCount));

// 端到端：handover 抽出来的东西直接喂给 bind（"真值 → 工程"一条链）
const hoBound = await simOp({ op: 'bind', source: hoLua, run: false, templates: ho.suggestedTemplates, containerId: ho.containerId });
ok('★ op=handover → op=bind 一条链：抽出来的模板直接建进模拟器（guid 原样）',
  hoBound.templateCount === 2 && hoBound.handover.missing.length === 0,
  JSON.stringify({ templates: hoBound.templates, missing: hoBound.handover.missing }));

const hoNoFile = await err(() => simOp({ op: 'handover', source: path.join(tmpData, '没有这个文件.lua') }));
ok('op=handover 读不到文件：明确报错（不是静默返回空候选）', !!hoNoFile && /读不到/.test(hoNoFile), hoNoFile);

/* ------------------------------- op=cases：验收单（人/AI 读同一份） */

const casesFile = path.join(tmpData, 'simulator', 'cases.json');
const emptyBook = await simOp({ op: 'cases' });
ok('op=cases 空清单：如实说没有（不是报错）', emptyBook.setCount === 0 && Array.isArray(emptyBook.sets), JSON.stringify(emptyBook).slice(0, 120));

const caseAdd = await simOp({
  op: 'cases', action: 'add', set: '自检-第1关',
  cases: [
    { name: '脚本就绪', expect: [{ kind: 'log', contains: 'bind-selftest' }] },
    { name: '建了图片控件', expect: [{ kind: 'count', controlKind: 'image', atLeast: 1 }] },
    { name: '人工：画面上蓝块看得见', manual: true, note: '看 op=shot target=play 的 PNG：要有 120x60 的蓝块' },
  ],
});
ok('★ op=cases action=add：自动项与人工项都存下（人工项不算自动项）',
  caseAdd.caseCount === 3 && caseAdd.manualCount === 1 && caseAdd.added.filter((c) => c.kind === 'auto').length === 2,
  JSON.stringify(caseAdd.added));
ok('op=cases：清单落在模拟器工作区（不在游戏目录）', fs.existsSync(casesFile) && casesFile.toLowerCase().startsWith(tmpData.toLowerCase()), casesFile);
ok('op=cases action=add：同名用例是覆盖（改断言再存一遍不会堆两条）',
  (await simOp({ op: 'cases', action: 'add', set: '自检-第1关', cases: [{ name: '脚本就绪', expect: [{ kind: 'log', contains: 'bind-selftest' }] }] })).replaced.join(',') === '脚本就绪');

const caseList = await simOp({ op: 'cases' });
ok('op=cases 列表：给计数与每条的 kind/断言数（不给全量 events，省 token）',
  caseList.sets.length === 1 && caseList.sets[0].autoCount === 2 && caseList.sets[0].manualCount === 1
  && caseList.sets[0].cases.every((c) => 'kind' in c && 'asserts' in c && !('events' in c && Array.isArray(c.events))),
  JSON.stringify(caseList.sets[0]));

// 跑之前先把那个「会跑一次会话」的工程绑回去（cases run 走 verify：自己 start/stop）
await simOp({ op: 'bind', source: bindLua, run: false, templates: [{ guid: 1073741868, kind: 'image', name: '图片模板' }] });
const caseRun = await simOp({ op: 'cases', action: 'run', set: '自检-第1关' });
ok('★ op=cases action=run：自动项确定性重放并给出判定（2/2）',
  caseRun.autoPassed === true && caseRun.passedCount === 2 && caseRun.failedCount === 0,
  JSON.stringify({ autoPassed: caseRun.autoPassed, passedCount: caseRun.passedCount, failures: caseRun.failures }));
ok('★ op=cases action=run：**人工项不代跑**，只列出来等人打勾（工具不下判决）',
  caseRun.manualCount === 1 && caseRun.manual[0].name.indexOf('人工') >= 0 && /没算过|人工项/.test(caseRun.note),
  JSON.stringify({ manual: caseRun.manual, note: caseRun.note }));

// 一条会失败的用例：判定要真的说没过（否则"全绿"没有意义）
await simOp({ op: 'cases', action: 'add', set: '自检-第1关', cases: [{ name: '故意错', expect: [{ kind: 'log', contains: '这条日志永远不会有' }] }] });
const caseFail = await simOp({ op: 'cases', action: 'run', set: '自检-第1关', cases: ['故意错'], shotOnFail: false });
ok('op=cases action=run 单条筛选：只跑那一句，判定如实说没过并给 hint',
  caseFail.autoPassed === false && caseFail.failedCount === 1 && !!caseFail.result && !!caseFail.result.hint,
  JSON.stringify({ passed: caseFail.autoPassed, failures: caseFail.failures }));

const caseRmDry = await simOp({ op: 'cases', action: 'remove', set: '自检-第1关' });
ok('op=cases action=remove 默认 dryRun：只说会删什么，不动盘', caseRmDry.dryRun === true && caseRmDry.willRemove > 0, JSON.stringify(caseRmDry));
const caseRmCase = await simOp({ op: 'cases', action: 'remove', set: '自检-第1关', case: '故意错', confirm: true });
ok('op=cases action=remove 带 confirm：真删那一条（其余留着）',
  caseRmCase.removed === 1 && (await simOp({ op: 'cases', action: 'show', set: '自检-第1关' })).cases.every((c) => c.name !== '故意错'),
  JSON.stringify(caseRmCase));

const verifyBySet = await simOp({ op: 'verify', caseSet: '自检-第1关' });
ok('op=verify caseSet：直接跑清单里那一组，人工项照样只列出来',
  verifyBySet.passed === true && verifyBySet.passedCount === 2 && (verifyBySet.manual || []).length === 1,
  JSON.stringify({ passed: verifyBySet.passed, manual: verifyBySet.manual }));
const caseNoSet = await err(() => simOp({ op: 'cases', action: 'run', set: '不存在的组' }));
ok('op=cases 指名不存在的组：报错并列出已有的', !!caseNoSet && /不存在的组/.test(caseNoSet), caseNoSet);
const manualNoNote = await err(() => simOp({ op: 'cases', action: 'add', set: '自检-第1关', cases: [{ name: '人工无说明', manual: true }] }));
ok('op=cases 人工项没写 note：报错（否则没人知道要看什么）', !!manualNoNote && /note/.test(manualNoNote), manualNoNote);

await simOp({ op: 'cases', action: 'remove', set: '自检-第1关', confirm: true });
ok('op=cases action=remove all：整组删掉（要 confirm:true）', (await simOp({ op: 'cases' })).setCount === 0);

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

/*
 * ★★ 写盘**只有一个实现**（2026-09-24 源码体检的真实发现）。
 *
 * 体检当时的状况：`codefile.mjs` 走硬化路径（同目录 tmp + `fsync` + rename + 失败清理），
 * 而 `sim.mjs` 自己**手搓** tmp+rename（没 fsync、失败会把 `.tmp<pid>` 漏在盘上），
 * 截图与导出更是**裸 `writeFileSync`**（被杀进程可能留下半截 PNG）。
 * 同一个动作三种实现 = 修了一处、另两处照旧漏。现在统一走 `lib/fsx.mjs`，用源码绊线钉住。
 */
{
  const simSrc = fs.readFileSync(path.join(pkgRoot, 'lib', 'sim.mjs'), 'utf8');
  const strays = [];
  if (/fs\.writeFileSync\(/.test(simSrc)) strays.push('裸 fs.writeFileSync');
  if (/fs\.renameSync\(/.test(simSrc)) strays.push('手搓 fs.renameSync');
  if (/\.tmp'\s*\+\s*process\.pid/.test(simSrc)) strays.push("手搓 '.tmp' + process.pid");
  ok('★★ sim.mjs 的写盘一律走共享原子实现（不许再出现裸写/手搓 tmp+rename —— 健壮性只能长在一个实现上）',
    strays.length === 0 && /from '\.\/fsx\.mjs'/.test(simSrc),
    strays.length ? '还有：' + strays.join(' / ') : '干净');
}

/* ---------------------------------------------------------------- 收尾 */

fs.rmSync(tmpData, { recursive: true, force: true });

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
