/**
 * 第四批反馈修复的自测（改进清单 2026-09-26：P0-1 / P1-1~4 / P2-1~4 / N-1~3 +「确认好用的」6 条）
 *
 * 每一条都写清「**修之前为什么红**」—— 这些断言是为了**在未来某次改动里重新变红**而写的。
 * 全部用**合成的假存档 / 假活文件 / 假日志 / 临时工程目录**（`MILIASTRA_LOCALLOW` +
 * `MILIASTRA_DATA_DIR` 指到临时目录），不碰真机的活文件、地图、工程与截图。
 *
 * 用法：node tests/feedback4-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 作用域隔离 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fb4-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedData = process.env.MILIASTRA_DATA_DIR;
const savedBak = process.env.MILIASTRA_BACKUP_DIR;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');
process.env.MILIASTRA_BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.QXQY_PLAY_TIMEOUT_MS = '3000';

let pass = 0;
const failures = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const { TOOLS } = await import('../index.js');
const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const healthTool = TOOLS.find((t) => t.name === 'miliastra_health');
const logTool = TOOLS.find((t) => t.name === 'miliastra_log');
const shotTool = TOOLS.find((t) => t.name === 'miliastra_shot');
const simTool = TOOLS.find((t) => t.name === 'miliastra_sim');
const { simOp, validatePatchFields, validateExpect, shortNoteName, EXPECT_KINDS, PATCH_OP_FIELDS } = await import('../lib/sim.mjs');
const { pickLiveFile, compareLiveSources, normalizeLiveName, sha256 } = await import('../lib/codefile.mjs');
const { scanRects, compareRects, expandDriverRefs, splitTopLevelArgs, asNumber } = await import('../lib/rects.mjs');
const { judgeCapture, markSelectedCandidate } = await import('../lib/shot.mjs');

/* ------------------------------------------------------------------ 合成 protobuf（与 feedback3 同一套） */

const pbVarint = (n) => {
  const out = [];
  let v = Number(n);
  do { let x = v & 0x7f; v = Math.floor(v / 128); if (v > 0) x |= 0x80; out.push(x); } while (v > 0);
  return Buffer.from(out);
};
const pbKey = (no, wt) => pbVarint(no * 8 + wt);
const pbBytes = (no, buf) => Buffer.concat([pbKey(no, 2), pbVarint(buf.length), buf]);
const pbStr = (no, s) => pbBytes(no, Buffer.from(s, 'utf8'));
const pbNum = (no, n) => Buffer.concat([pbKey(no, 0), pbVarint(n)]);

function makeGil({ levelId, name = '假图', account = 201170108, version = '7.1.0', scripts = [] }) {
  const recs = scripts.map((s) => pbBytes(1, Buffer.concat([
    pbNum(1, s.mappingId),
    pbStr(2, s.name),
    ...(s.file ? [pbStr(3, s.file)] : []),
    pbBytes(5, Buffer.from(s.source == null ? '-- x\n' : s.source, 'utf8')),
  ])));
  const parts = [
    pbNum(1, levelId), pbStr(2, name), pbNum(39, account), pbStr(43, version),
    pbBytes(50, Buffer.concat(recs)),
  ];
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
}

/** 合成 `.gia`：8 字节包头 + 每条记录一个 `#1` 子消息。 */
function makeGia(records) {
  const recs = records.map((r) => pbBytes(1, Buffer.concat([
    pbStr(2, r.instance || '47504-201170108-1790324179-1'),
    pbStr(4, r.time || '2026/09/26_16:16:19'),
    pbNum(5, 201170108),
    pbBytes(11, pbStr(2, '假图')),
    pbBytes(23, pbStr(2, r.message)),
  ])));
  return Buffer.concat([Buffer.alloc(8), ...recs]);
}

function fakeLevel({ brand = '原神', account = '201170108', levelId, gils = [], luas = {}, logs = {}, outputLog = null }) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'low-'));
  const levelDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Local_Save_Level', levelId);
  const luaDir = path.join(levelDir, 'external_lua_file');
  fs.mkdirSync(luaDir, { recursive: true });
  for (const g of gils) fs.writeFileSync(path.join(levelDir, levelId + '.gil'), g);
  for (const [n, text] of Object.entries(luas)) fs.writeFileSync(path.join(luaDir, n), text, 'utf8');
  if (Object.keys(logs).length) {
    const logDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Debug_Log');
    fs.mkdirSync(logDir, { recursive: true });
    for (const [n, buf] of Object.entries(logs)) fs.writeFileSync(path.join(logDir, n), buf);
  }
  if (outputLog) fs.writeFileSync(path.join(root, brand, 'output_log.txt'), outputLog, 'utf8');
  return { root, levelDir, luaDir };
}

/* ================================================================== P0-1 · 纯函数 pickLiveFile */

/*
 * 修之前为什么红：`op=deploy` 只给 `source` 时，目标活文件按**最近改动**挑 ——
 * 实测把 `交互 input.lua` 的内容写进了 `表现 view.lua`（活文件是唯一副本 = 毁数据）。
 */
await check('P0-1 pickLiveFile：`source` 的 basename 命中 → 选中它且 destBasenameMatchesSource=true', async () => {
  const live = [{ name: '表现 view.lua', path: 'X:\\表现 view.lua', size: 10 }, { name: '交互 input.lua', path: 'X:\\交互 input.lua', size: 20, mtimeMs: 9e12 }];
  const r = pickLiveFile({ levelId: 1, liveFiles: live, source: 'D:\\code\\表现 view.lua' });
  assert(r.picked.name === '表现 view.lua', '没按 basename 命中：' + r.picked.name);
  assert(r.pickedBy === 'basename', 'pickedBy 不对：' + r.pickedBy);
  assert(r.destBasenameMatchesSource === true && r.basenameMismatch === false, '判据字段不对：' + JSON.stringify(r).slice(0, 200));
  // 大小写 / .lua 后缀差异都算命中（Windows 文件名不区分大小写，且两边都可能缺后缀）
  const r2 = pickLiveFile({ levelId: 1, liveFiles: live, source: 'D:/X/表现 VIEW.LUA' });
  assert(r2.picked.name === '表现 view.lua' && r2.destBasenameMatchesSource === true, '大小写/后缀没归一：' + JSON.stringify(r2).slice(0, 160));
  assert(normalizeLiveName('View.Lua') === normalizeLiveName('view'), 'normalizeLiveName 不对');
  return r.picked.name + '（basename 命中，mtime 最新的那份**没被**选中）';
});

await check('P0-1 pickLiveFile：source 名对不上 + 多个候选 → **抛错并列出全部候选**（不写盘）', async () => {
  const live = [{ name: '表现 view.lua' }, { name: '交互 input.lua' }];
  let msg = null;
  try { pickLiveFile({ levelId: 1073741835, liveFiles: live, source: 'D:\\code\\另一个.lua' }); } catch (e) { msg = e.message; }
  assert(msg, '名字对不上竟然没抛错');
  assert(/表现 view\.lua/.test(msg) && /交互 input\.lua/.test(msg), '没列出全部候选：' + msg);
  assert(/拒绝部署/.test(msg) && /file/.test(msg), '没给「显式传 file」的下一步：' + msg);
  assert(/静默写错文件/.test(msg), '没说清后果：' + msg);
  return msg.split('\n')[0].slice(0, 80) + '…';
});

await check('P0-1 pickLiveFile：目录里只有 1 个非附属活文件 → 允许但标 basenameMismatch + warning', async () => {
  const live = [{ name: '唯一.lua', path: 'X:\\唯一.lua' }, { name: '_探针_x.lua', auxiliary: true }, { name: '旧_备份.lua' }];
  const r = pickLiveFile({ levelId: 2, liveFiles: live, source: 'D:\\code\\别的名字.lua' });
  assert(r.picked.name === '唯一.lua', '没选中唯一候选：' + r.picked.name);
  assert(r.basenameMismatch === true && r.destBasenameMatchesSource === false, '没标 basenameMismatch：' + JSON.stringify(r).slice(0, 160));
  assert(/不一样/.test(r.warning || ''), '没给 warning：' + r.warning);
  assert(r.candidates.length === 1, '候选里混进了附属文件：' + JSON.stringify(r.candidates));
  return '选中「唯一.lua」+ basenameMismatch:true + warning';
});

await check('P0-1 pickLiveFile：显式 file 优先（同名不同后缀也认），找不到就报错列候选', async () => {
  const live = [{ name: '表现 view.lua' }, { name: '交互 input.lua' }];
  const r = pickLiveFile({ levelId: 3, liveFiles: live, source: 'D:\\表现 view.lua', file: '交互 input' });
  assert(r.picked.name === '交互 input.lua' && r.pickedBy === 'explicit', '显式 file 没优先：' + JSON.stringify(r).slice(0, 160));
  // ★ 显式 file 选中了、但**名字与 source 不同**时，判据必须如实报 false（不是"指了就算对"）
  assert(r.destBasenameMatchesSource === false && r.basenameMismatch === true, '显式 file 名字不符没标出来：' + JSON.stringify({ a: r.destBasenameMatchesSource, b: r.basenameMismatch }));
  assert(/不一样/.test(r.warning || ''), '没给 warning：' + r.warning);
  const same = pickLiveFile({ levelId: 3, liveFiles: live, source: 'D:\\交互 input.lua', file: '交互 input.lua' });
  assert(same.destBasenameMatchesSource === true && same.basenameMismatch === false, '显式 file 同名时该 true：' + JSON.stringify({ a: same.destBasenameMatchesSource }));
  let msg = null;
  try { pickLiveFile({ levelId: 3, liveFiles: live, source: 'D:\\x.lua', file: '不存在.lua' }); } catch (e) { msg = e.message; }
  assert(msg && /没有活文件/.test(msg), 'file 找不到没报错：' + msg);
  return '显式 file 第一优先；名字不符 → destBasenameMatchesSource:false + warning；找不到 → 报错';
});

await check('P0-1 集成：写盘路径按 basename 命中（回执 dest / destBasenameMatchesSource）；对不上时**拒绝且活文件零改动**', async () => {
  const lv = fakeLevel({
    levelId: '1073741906',
    luas: { '表现 view.lua': '-- view 原样\n', '交互 input.lua': '-- input 原样\n' },
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const srcView = path.join(tmpRoot, '表现 view.lua');
    fs.writeFileSync(srcView, '-- 新 view\nlocal a = 1\n', 'utf8');
    const ok = await codeTool.execute({ op: 'deploy', level: '1073741906', source: srcView }, {});
    assert(ok.ok, '部署失败：' + JSON.stringify(ok.errors || ok).slice(0, 200));
    assert(/表现 view\.lua$/.test(ok.dest || ''), 'dest 不是同名活文件：' + ok.dest);
    assert(ok.destBasenameMatchesSource === true && ok.basenameMismatch !== true, '判据字段不对：' + JSON.stringify({ a: ok.destBasenameMatchesSource, b: ok.basenameMismatch }));
    assert(ok.pickedBy === 'basename', 'pickedBy 不是 basename：' + ok.pickedBy);

    // ★ 这一条就是修之前会**静默写错**的那条：source 名叫「另一个.lua」，目录里有 2 个活文件
    const beforeView = fs.readFileSync(path.join(lv.luaDir, '表现 view.lua'));
    const beforeInput = fs.readFileSync(path.join(lv.luaDir, '交互 input.lua'));
    const srcOther = path.join(tmpRoot, '另一个.lua');
    fs.writeFileSync(srcOther, '-- 谁都不该被这个覆盖\n', 'utf8');
    let msg = null;
    try { await codeTool.execute({ op: 'deploy', level: '1073741906', source: srcOther }, {}); } catch (e) { msg = e.message; }
    assert(msg && /拒绝部署/.test(msg), '对不上时没拒绝：' + msg);
    assert(Buffer.compare(fs.readFileSync(path.join(lv.luaDir, '表现 view.lua')), beforeView) === 0, 'view 被写坏了');
    assert(Buffer.compare(fs.readFileSync(path.join(lv.luaDir, '交互 input.lua')), beforeInput) === 0, 'input 被写坏了');
    // 只有 1 个活文件时：允许，但回执**首行**就有 warning（AI 自上而下读 JSON）
    const lv2 = fakeLevel({ levelId: '1073741907', luas: { '唯一.lua': '-- 原样\n' } });
    process.env.MILIASTRA_LOCALLOW = lv2.root;
    const src2 = path.join(tmpRoot, '换了名字.lua');
    fs.writeFileSync(src2, '-- 唯一\nlocal b = 2\n', 'utf8');
    const r2 = await codeTool.execute({ op: 'deploy', level: '1073741907', source: src2 }, {});
    assert(r2.ok, '唯一候选时部署失败：' + JSON.stringify(r2.errors || r2).slice(0, 160));
    assert(r2.basenameMismatch === true && r2.destBasenameMatchesSource === false, '没标 basenameMismatch：' + JSON.stringify({ a: r2.basenameMismatch, b: r2.destBasenameMatchesSource }));
    assert(Object.keys(r2)[0] === 'warning' && /不一样/.test(r2.warning || ''), 'warning 没放在回执最前面：' + JSON.stringify(Object.keys(r2).slice(0, 3)));
    return 'basename 命中 → view；名字对不上（2 候选）→ 拒绝且两份活文件逐字节未变；只有 1 份 → warning 在最前';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

/* ================================================================== P1-1 · sim play action=click */

/*
 * 修之前为什么红：`{"op":"play","action":"click","args":{"x":800,"y":277}}` 回执的 history 里
 * 记了一条 `{kind:"click",payload:{name:"undefined"}}` 的**假记录**，脚本的
 * `AddCursorEventListener(CursorClick, …)` 一次都没触发（AI 于是去改脚本，白烧一轮）。
 */
await check('P1-1 集成：`click{x,y}` ≡ `pointer{type:"click"}`（history 同一份光标事件）；`click{name}` 才是按控件点', async () => {
  await simOp({ op: 'reset' });
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  const a = await simOp({ op: 'play', action: 'click', args: { x: 800, y: 277 } });
  assert(a.action === 'pointer', 'click{x,y} 没走 pointer：' + a.action);
  assert(a.clickInterpretedAs === 'pointer' && a.requestedAction === 'click', '回执没说清怎么解释的：' + JSON.stringify({ i: a.clickInterpretedAs, r: a.requestedAction }));
  const got1 = await simOp({ op: 'play', action: 'get', args: { inspect: true, compact: true } });
  const ev1 = (got1.history || []).slice(-1)[0];
  assert(ev1 && ev1.kind === 'pointer' && ev1.payload.type === 'click' && ev1.payload.x === 800 && ev1.payload.y === 277,
    'Lua 侧记录不是 pointer/click：' + JSON.stringify(ev1));
  assert(!(got1.history || []).some((e) => e.kind === 'click' && e.payload && e.payload.name === 'undefined'),
    '又出现了 name=undefined 的假记录：' + JSON.stringify(got1.history));

  const b = await simOp({ op: 'play', action: 'click', args: { name: '预设按钮' } });
  assert(b.action === 'click' && b.clickInterpretedAs === 'name', 'click{name} 没按控件名点：' + JSON.stringify({ a: b.action, i: b.clickInterpretedAs }));
  const got2 = await simOp({ op: 'play', action: 'get', args: { inspect: true, compact: true } });
  const ev2 = (got2.history || []).slice(-1)[0];
  assert(ev2 && ev2.kind === 'click' && ev2.payload.name === '预设按钮', '控件名点击没被记录：' + JSON.stringify(ev2));

  let msg = null;
  try { await simOp({ op: 'play', action: 'click', args: {} }); } catch (e) { msg = e.message; }
  assert(msg && /pointer/.test(msg) && /name/.test(msg) && /x/.test(msg), '两者都不给时没报错指路：' + msg);
  await simOp({ op: 'play', action: 'stop' });
  return 'x/y → pointer/click（history 一致）；name → click；都不给 → 报错指路';
});

/* ================================================================== P1-2 / P1-3 · patch 字段白名单 */

/*
 * 修之前为什么红：`add {…, text:"…"}` 回 `applied:"add"` 而 inspector 里 `text` 仍是 `""`（静默被吞）；
 * `set {field:…}` 回一句 JS 内部错 `Cannot read properties of undefined (reading 'startsWith')`。
 */
await check('P1-2 纯函数：`add` 带 text 被接受并标记要补一次 set；**未知字段报错点名**', async () => {
  const ok = validatePatchFields({ op: 'add', parentId: 'n1', kind: 'textbox', name: 't', text: 'stage=1' });
  assert(ok.text === 'stage=1' && /add/.test(ok.note || ''), 'add 的 text 没被接受：' + JSON.stringify(ok));
  let msg = null;
  try { validatePatchFields({ op: 'add', parentId: 'n1', kind: 'textbox', name: 't', textx: 'a' }); } catch (e) { msg = e.message; }
  assert(msg && /textx/.test(msg) && /不认这些字段/.test(msg), '未知字段没被点名：' + msg);
  let msg2 = null;
  try { validatePatchFields({ op: 'add', parentId: 'n1', kind: 'image', text: 'x' }); } catch (e) { msg2 = e.message; }
  assert(msg2 && /textbox/.test(msg2) && /image/.test(msg2), 'text 用在非文本控件上没被拒：' + msg2);
  return 'text 接受；textx 被点名；image+text 被拒';
});

await check('P1-3 纯函数：`set` 传了 `field` → 人话报错（点名 field、指 key、列出该控件可设的 key）', async () => {
  let msg = null;
  try {
    validatePatchFields({ op: 'set', id: 'n12', field: 'text', value: 'x' }, { settableKeys: ['text', 'fontSize', 'bgColor'] });
  } catch (e) { msg = e.message; }
  assert(msg, 'set+field 没报错');
  assert(/是不是想传 `key`/.test(msg), '没指出 field → key：' + msg);
  assert(/该控件可设的 key/.test(msg) && /fontSize/.test(msg), '没列出该控件可设的 key：' + msg);
  assert(!/startsWith/.test(msg), '还在漏 JS 内部错：' + msg);
  let msg2 = null;
  try { validatePatchFields({ op: 'set', id: 'n12', value: 'x' }); } catch (e) { msg2 = e.message; }
  assert(msg2 && /缺 `key`/.test(msg2), '缺 key 没报错：' + msg2);
  // 覆盖 remove / setCanvas / updateScript / removeScript
  const bad = [
    ['remove', { op: 'remove', id: 'n1', ids: 'n2' }, /ids/],
    ['setCanvas', { op: 'setCanvas', canvasId: 'pc-16-9', canvas: 'x' }, /canvas/],
    ['updateScript', { op: 'updateScript', path: 'a.lua', sourcePath: 'b.lua', source: 'x' }, /sourcePath/],
    ['removeScript', { op: 'removeScript', path: 'a.lua', byPath: true }, /byPath/],
  ];
  for (const [name, patch, re] of bad) {
    let m = null;
    try { validatePatchFields(patch); } catch (e) { m = e.message; }
    assert(m && re.test(m) && /不认这些字段/.test(m), name + ' 的未知字段没被拦：' + m);
  }
  return 'field→key 提示 + 可设 key 清单；remove/setCanvas/updateScript/removeScript 的未知字段都被拦';
});

await check('P1-2 集成：`patch add {text}` 之后 inspector 里就是那段文本（不用再补一次 set）', async () => {
  await simOp({ op: 'reset' });
  const r = await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 't1_kb_state', text: 'stage=1' } });
  assert(r.textApplied && r.textApplied.text === 'stage=1', '回执没说 text 落进去了：' + JSON.stringify(r.textApplied));
  const v = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'control', name: 't1_kb_state', field: 'text', equals: 'stage=1' }] });
  assert(v.passed === true, '断言「文本就是那段」没过：' + JSON.stringify(v.results && v.results[0]).slice(0, 200));
  let msg = null;
  try { await simOp({ op: 'patch', patch: { op: 'set', id: r.textApplied.id, field: 'text', value: 'x' } }); } catch (e) { msg = e.message; }
  assert(msg && /是不是想传 `key`/.test(msg), '集成路径的 set+field 报错不对：' + msg);
  assert(/该控件可设的 key/.test(msg), '集成路径没列出可设的 key（说明没从控件类型推断）：' + msg);
  return 'text 建好即带上（断言过）；set+field → 人话报错 + 该 textbox 可设 key 清单';
});

/* ================================================================== P1-4 · expect 白名单 + absent */

/*
 * 修之前为什么红：`{"kind":"log","contains":"首错","absent":true}` ⇒ `passed:false` + 整段日志 + "第 3 条断言没过"，
 * 而真实原因只是 **absent 不受支持**（被静默忽略）—— AI 会去查一个不存在的逻辑问题。
 */
await check('P1-4 纯函数：未知 kind / 未知字段 → **参数错**（不是断言没过）；controlAbsent 翻成 control{absent}', async () => {
  let m1 = null;
  try { validateExpect({ kind: 'log', contians: 'x' }, 2); } catch (e) { m1 = e.message; }
  assert(m1 && /expect\[2\]/.test(m1) && /contians/.test(m1) && /不认这些字段/.test(m1), '未知字段没报参数错：' + m1);
  assert(/不是断言没过/.test(m1), '没点破「这不是断言没过」：' + m1);
  let m2 = null;
  try { validateExpect({ kind: 'loog', contains: 'x' }, 0); } catch (e) { m2 = e.message; }
  assert(m2 && /不存在/.test(m2) && /controlAbsent/.test(m2), '未知 kind 没报错指路：' + m2);
  const sugar = validateExpect({ kind: 'controlAbsent', name: '提示' }, 1).assert;
  assert(sugar.kind === 'control' && sugar.absent === true && sugar.name === '提示', 'controlAbsent 没翻成 control{absent}：' + JSON.stringify(sugar));
  assert(EXPECT_KINDS.controlAbsent && EXPECT_KINDS.lua.includes('source'), '白名单表本身不对');
  return '未知字段/未知 kind → 参数错（点名 + 点破"不是断言没过"）；controlAbsent → control{absent:true}';
});

await check('P1-4 集成：`absent:true` 真的实现（log/control/tree），`controlAbsent` 是语法糖', async () => {
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: '存在的东西', text: 'X' } });
  // ① 不该存在的日志 → 过
  const a = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'log', contains: '首错', absent: true }], shotOnFail: false });
  assert(a.passed === true, 'absent(log 不存在) 该过：' + JSON.stringify(a.results).slice(0, 200));
  // ② 存在的控件 + absent → 该失败，且 actual 报出"到底存在什么"
  const b = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'control', name: '存在的东西', absent: true }], shotOnFail: false });
  assert(b.passed === false, 'absent(控件存在) 该失败');
  assert(/不应存在/.test(JSON.stringify(b.results)), '失败项没说清是 absent：' + JSON.stringify(b.results).slice(0, 200));
  // ③ controlAbsent 语法糖：不存在 → 过
  const c = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'controlAbsent', name: '根本没有' }], shotOnFail: false });
  assert(c.passed === true, 'controlAbsent(不存在) 该过：' + JSON.stringify(c.results).slice(0, 160));
  // ④ tree{absent}
  const d = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'tree', name: '存在的东西', absent: true }], shotOnFail: false });
  assert(d.passed === false, 'tree{absent}(存在) 该失败');
  const e = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'tree', name: '不存在的东西', absent: true }], shotOnFail: false });
  assert(e.passed === true, 'tree{absent}(不存在) 该过：' + JSON.stringify(e.results).slice(0, 160));
  // ⑤ 真的 absent 不生效时这条会红：把日志文本造出来
  await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'fb4-log', source: 'function OnStart()\n  print("FB4_首错 here")\nend\n' } });
  const f = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'log', contains: 'FB4_首错', absent: true }], shotOnFail: false });
  assert(f.passed === false, '日志真的出现了，absent 却没判失败（说明 absent 又被忽略了）：' + JSON.stringify(f.results).slice(0, 200));
  return 'absent(log/control/tree) 四档都对；日志真的出现 → 判失败';
});

/* ================================================================== P2-1 · cases manual 项的 name */

/*
 * 修之前为什么红：`{"manual":true,"note":"真机上要看到…"}` 的名字变成「<set> 用例 3」，
 * 跑清单时人看到的是「用例 3」，**不知道要验什么**（note 里明明写着）。
 */
await check('P2-1 纯函数 shortNoteName：取前 20 字 + 去掉结尾标点', async () => {
  const s = shortNoteName('真机上要看到覆盖层面板盖住下面的字，并且能点');
  assert(s === '真机上要看到覆盖层面板盖住下面的字，并且', '截断不对：' + JSON.stringify(s));
  assert(shortNoteName('') === '', '空 note 该给空串');
  assert(shortNoteName('短。') === '短', '结尾标点没去掉：' + shortNoteName('短。'));
  assert(shortNoteName('a\n\nb   c') === 'a b c', '空白没折叠：' + JSON.stringify(shortNoteName('a\n\nb   c')));
  return '前 20 字 + 去尾标点 + 折叠空白';
});

await check('P2-1 集成：`op=cases action=add` 的 manual 项用 note 前 20 字当名字；显式 name 可覆盖', async () => {
  await simOp({ op: 'cases', action: 'add', set: 'FB4-验收', cases: [
    { manual: true, note: '真机上要看到覆盖层面板盖住下面的字，并且能点' },
    { manual: true, note: '这条要给个短名字', name: '我自己起的名字' },
  ] });
  const list = await simOp({ op: 'cases', action: 'list' });
  const set = list.sets.find((s) => s.set === 'FB4-验收');
  assert(set && set.cases.length === 2, '用例没存上：' + JSON.stringify(list.sets.map((s) => s.set)));
  const names = set.cases.map((c) => c.name);
  assert(names[0] === '真机上要看到覆盖层面板盖住下面的字，并且', 'manual 名字没取 note 前 20 字：' + JSON.stringify(names));
  assert(names[1] === '我自己起的名字', '显式 name 没覆盖：' + JSON.stringify(names));
  assert(set.manualCount === 2, 'manualCount 不对：' + set.manualCount);
  return names.join(' / ');
});

/* ================================================================== P2-2 · shot 的候选窗口与 suspect */

/*
 * 修之前为什么红：`op=capture target=game` 回执是 `{process:YuanShen,pid,title:原神}`、`suspect:false`，
 * 而 PNG 是编辑器那一屏 —— 光看回执**发现不了**（只有人看图才知道）。
 */
await check('P2-2 纯函数：judgeCapture 只在**判得出来**时 suspect（进程不符 / 标题像编辑器），不做画面内容识别', async () => {
  const base = { ok: true, width: 1600, height: 900, mode: 'printwindow', front: false, blackRatio: 0.01, uniformRatio: 0.2, process: 'YuanShen', title: '原神' };
  const clean = judgeCapture(base, { target: 'game', requestedProcess: 'YuanShen' });
  assert(clean.suspect === false, '正常一张不该 suspect：' + JSON.stringify(clean));
  const wrongProc = judgeCapture({ ...base, process: 'BeyondEditor', title: '千星沙箱' }, { target: 'game', requestedProcess: 'YuanShen' });
  assert(wrongProc.suspect === true && /不是你要的那个程序/.test(wrongProc.warning), '进程不符没判：' + JSON.stringify(wrongProc));
  const editorish = judgeCapture({ ...base, title: 'UI 界面控件组管理' }, { target: 'game', requestedProcess: 'YuanShen' });
  assert(editorish.suspect === true && /游戏画面/.test(editorish.warning), '标题像编辑器没判：' + JSON.stringify(editorish));
  assert(/画面内容/.test(editorish.warning) && /不识别/.test(editorish.warning), '没写清「判不了画面内容」这条边界：' + editorish.warning);
  const multi = judgeCapture({ ...base, candidates: [{ pid: 1, title: 'a', w: 900, h: 800, area: 720000, minimized: false }, { pid: 1, title: 'b', w: 160, h: 28, area: 4480, minimized: true }] }, { target: 'game', requestedProcess: 'YuanShen' });
  assert(/2 个可见窗口/.test(multi.warning || ''), '多窗口没提示怎么看：' + multi.warning);
  const dark = judgeCapture({ ...base, blackRatio: 0.999 }, { target: 'game', requestedProcess: 'YuanShen' });
  assert(dark.suspect === true && /全黑/.test(dark.warning), '全黑没判：' + dark.warning);
  return '正常 / 进程不符 / 标题像编辑器 / 多窗口 / 全黑 —— 五种说法分得开，且不假装识别画面内容';
});

await check('P2-2 纯函数 markSelectedCandidate：候选窗口逐条标出选中哪个（多窗口选错才看得见）', async () => {
  const cands = [
    { pid: 5608, title: '日志', w: 900, h: 800, area: 720000, minimized: false },
    { pid: 5608, title: '残片', w: 160, h: 28, area: 4480, minimized: true },
  ];
  const marked = markSelectedCandidate(cands, { pid: 5608, title: '日志', width: 900, height: 800 });
  assert(marked.length === 2, '候选数不对');
  assert(marked[0].selected === true && marked[1].selected === false, '没标出选中哪个：' + JSON.stringify(marked));
  assert(marked[1].minimized === true && marked[0].width === 900, '尺寸/最小化字段没带出来：' + JSON.stringify(marked[1]));
  assert(markSelectedCandidate(null, {}).length === 0, '没有候选时该给空数组');
  return '2 条候选，第 1 条 selected:true（含标题/尺寸/是否最小化）';
});

await check('P2-2 schema：shot 的说明写清候选窗口与 suspect 的边界', async () => {
  const d = shotTool.description;
  assert(/候选窗口清单/.test(d), '没写候选窗口清单');
  assert(/suspect/.test(d) && /画面内容本工具不识别/.test(d), '没写 suspect 的边界：' + d.slice(-300));
  return '描述里有「候选窗口清单」+「suspect 只在判得出来时给 / 不识别画面内容」';
});

/* ================================================================== P2-3 · Z 序（实测） */

/*
 * 问题（2026-09-26 实盘）：「覆盖层面板在 PNG 里始终在文字之下 ⇒ 只能真机试一次才知道盖住了没」。
 * 本轮**先实测再改**（本仓纪律），得到的是三条可复现的事实：
 *   ① 模拟器**按 sibling 顺序画**（内部列表「前→后」= 列表第一个在最上层）；
 *   ② Lua 的 sibling 序号是**反的**：`SetAsLastSibling()` = 提到最上（实测 idx=11 且图压住了默认按钮）；
 *   ③ `op=patch add` 是**追加**到列表末尾 ⇒ 新控件落在**最底层**（真机脚本 `InstantiateClientUIControl` 是**置顶**）。
 * ⇒ 结论：渲染路径**不乱**（不用改），但「用 patch 手工搭界面」时的默认层序与"脚本后建的在上"**方向相反** ——
 *    这条必须写在工具说明与 docs 里（下面还有一条 schema 断言钉住它）。
 */
await check('P2-3 回归：sibling 顺序在 PNG 里真的生效（patch add 沉底 / Lua SetAsLastSibling 提到最上）', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const px = async (file, x, y) => {
    const img = await loadImage(fs.readFileSync(file));
    const cv = createCanvas(img.width, img.height);
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const kind = (p) => (p[0] > 200 && p[1] < 60 && p[2] < 60 ? '文本底(红)'
    : (p[2] > 200 && p[0] < 60 ? '图片(纯蓝)' : '其它' + JSON.stringify(p)));
  /*
   * ⚠️ 采样点**不写死**：`op=controls runtime:true geom:true` 回的是**世界坐标（左下原点）**，
   *    所以像素点 = (x, 画布高 − y)。摆位也避开出厂工程那几个默认控件（它们都在中部）——
   *    两块测试控件放在 (250,120) 附近（像素左下角那一块，出厂控件够不着）。
   * ⚠️ 必须先 patch 再 `play start`：worker 是 start 那一刻拿到工程快照的。
   */
  const sample = async (label) => {
    const live = await simOp({ op: 'controls', runtime: true, geom: true, nameContains: 'Z' });
    const t = live.controls.find((c) => c.name === 'Z文字');
    assert(t && Number.isFinite(t.x), '运行时几何里拿不到 Z文字 的坐标：' + JSON.stringify(live.controls));
    const r = await simOp({ op: 'shot', target: 'play', label });
    assert(r.ok !== false, '出图失败：' + JSON.stringify(r).slice(0, 160));
    return px(r.file, Math.round(t.x), Math.round(900 - t.y));
  };

  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'Z文字', text: 'ZZ' } });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'image', name: 'Z图' } });
  const rows = (await simOp({ op: 'controls', nameContains: 'Z' })).controls;
  const tId = rows.find((c) => c.name === 'Z文字').id;
  const iId = rows.find((c) => c.name === 'Z图').id;
  const put = async (id, key, value) => { await simOp({ op: 'patch', patch: { op: 'set', id, key, value } }); };
  for (const [id, color] of [[tId, 0xffff0000], [iId, 0xff0000ff]]) {
    await put(id, 'width', 400); await put(id, 'height', 200);
    await put(id, 'posX', 250); await put(id, 'posY', 120);
    await put(id, id === tId ? 'bgColor' : 'imageColor', color);
  }
  const tree = (await simOp({ op: 'controls' })).controls.filter((c) => ['Z文字', 'Z图'].includes(c.name)).map((c) => c.name);
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 5; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const before = await sample('fb4-z-order-a');
  assert(kind(before) === '文本底(红)',
    'A 档：`patch add` 的层序不是「后加的沉底」（实测 ' + kind(before) + '；工程树顺序 ' + JSON.stringify(tree) + '）—— 说明层序语义变了，请更新这条与说明');
  await simOp({ op: 'play', action: 'stop' });

  // Lua 把图提到最上（Lua 的 Last = 内部列表最前 = 最上层）
  await simOp({ op: 'patch', patch: {
    op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'fb4-z',
    source: 'function OnStart()\n  local img = script.object:GetChild("Z图")\n  if img then print("FB4_SET_LAST=" .. tostring(img:SetAsLastSibling()) .. " idx=" .. tostring(img:GetSiblingIndex())) end\nend\n',
  } });
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 12; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const got = await simOp({ op: 'play', action: 'get', args: { compact: true } });
  const logs = (got.logs || []).map((l) => l.text);
  assert(logs.some((t) => /FB4_SET_LAST=true/.test(t)), 'SetAsLastSibling 没成功：' + JSON.stringify(logs.slice(-3)));
  const after = await sample('fb4-z-order-b');
  await simOp({ op: 'play', action: 'stop' });
  assert(kind(after) === '图片(纯蓝)', 'B 档：SetAsLastSibling 之后图片没压住（实测 ' + kind(after) + '）');
  return 'A：patch add 后加的沉底（采样点 ' + kind(before) + '）→ B：Lua SetAsLastSibling 提到最上（' + kind(after) + '）';
});

await check('P2-3 回归：脚本 `InstantiateClientUIControl` **后建的在上**（真机口径）', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const px = async (file, x, y) => {
    const img = await loadImage(fs.readFileSync(file));
    const cv = createCanvas(img.width, img.height);
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'newAsset', assetType: 'client-control-template' } });
  await simOp({ op: 'patch', patch: { op: 'addTemplate', kind: 'image', name: 'Z背板模板', guid: 1073741868 } });
  await simOp({ op: 'patch', patch: { op: 'addTemplate', kind: 'textbox', name: 'Z文字模板', guid: 1073741867 } });
  await simOp({ op: 'patch', patch: {
    op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'fb4-inst',
    source: [
      'function OnStart()',
      '  local img = game.InstantiateClientUIControl(1073741868, script.object)',
      '  if img then img:SetSizeDelta(400, 200); img:SetAnchoredPosition(0, 0); img.imageColor = Color.FromRGBA(0, 0, 255, 255) end',
      '  local txt = game.InstantiateClientUIControl(1073741867, script.object)',
      '  if txt then txt:SetSizeDelta(400, 200); txt:SetAnchoredPosition(0, 0); txt.text = "ZZ"; txt.bgColor = Color.FromRGBA(255, 0, 0, 255) end',
      '  print("FB4_INST_OK")',
      'end',
      '',
    ].join('\n'),
  } });
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 20; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const got = await simOp({ op: 'play', action: 'get', args: { compact: true } });
  assert((got.logs || []).some((l) => /FB4_INST_OK/.test(l.text || '')), '脚本没跑：' + JSON.stringify((got.logs || []).map((l) => l.text).slice(-3)));
  const shot = await simOp({ op: 'shot', target: 'play', label: 'fb4-inst-order' });
  await simOp({ op: 'play', action: 'stop' });
  const p = await px(shot.file, 800, 450);
  assert(p[0] > 200 && p[1] < 60 && p[2] < 60, '后建的文本没压住先建的图（中心像素 ' + JSON.stringify(p) + '）—— 真机口径是后建的在上');
  return '先建图、后建文本 → 中心是**文本**（' + JSON.stringify(p) + '），与真机口径一致';
});

await check('P2-3 schema：Z 序的「按 sibling 画 + 不覆盖什么」写在 miliastra_sim 的说明里', async () => {
  const d = String(simTool.description || '');
  assert(/Z 序/.test(d), '工具说明里没有 Z 序这一段');
  assert(/按 sibling 顺序画/.test(d), '没说清是按 sibling 顺序画');
  assert(/后建的在上/.test(d), '没说清 Instantiate 后建的在上');
  assert(/不覆盖/.test(d) && /真机/.test(d), '没说清"不覆盖"的边界');
  return '说明里含「Z 序 / 按 sibling 顺序画 / 后建的在上 / 不覆盖」';
});

/* ================================================================== P2-4 · log op=tags 前缀聚合 */

/*
 * 修之前为什么红：本工程日志形如 `[侦探1/view] 初始化…`，而旧实现只认
 * 「正文里任意位置的纯 ASCII `[xx]`」⇒ 106 条全归 `(无标签)`，op=tags 在这些工程里没用。
 */
await check('P2-4 集成：`op=tags` 按正文**开头**的 `[...]` 前缀聚合；真没前缀才归 (无标签)', async () => {
  const lv = fakeLevel({
    levelId: '1073741908',
    logs: {
      '2026-09-26_16-16-23_184_201170108.gia': makeGia([
        { message: '[侦探1/view] 初始化', instance: '47504-201170108-1790324179-1' },
        { message: '[侦探1/view] 就绪', instance: '47504-201170108-1790324179-1' },
        { message: '[侦探1/input] 光标点击', instance: '47504-201170108-1790324179-1' },
        { message: '没有前缀的一行', instance: '47504-201170108-1790324179-1' },
        { message: '   [前面有空格也算前缀] 内容', instance: '47504-201170108-1790324179-1' },
      ]),
    },
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const r = await logTool.execute({ op: 'tags', level: '1073741908' }, {});
    assert(r.ok, 'op=tags 失败：' + JSON.stringify(r).slice(0, 200));
    const tags = r.tags.map((t) => t.tag + '×' + t.count);
    const get = (k) => (r.tags.find((t) => t.tag === k) || {}).count;
    assert(get('侦探1/view') === 2, '中文/斜杠标签没聚合：' + tags.join(' '));
    assert(get('侦探1/input') === 1, '第二条标签没聚合：' + tags.join(' '));
    // 前导空格后跟 `[...]`：也算前缀（标签在正文之前），所以只有"真的没有前缀"那 1 行归 (无标签)
    assert(get('(无标签)') === 1, '(无标签) 的条数不对（应当只有"没有前缀"那 1 行）：' + tags.join(' '));
    assert(get('前面有空格也算前缀') === 1, '前导空格那行的标签不对：' + tags.join(' '));
    assert(/前缀/.test(r.tagRule || ''), '没说明标签口径：' + r.tagRule);
    return tags.join(' / ');
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

/* ================================================================== N-1 · op=rects */

/*
 * 新能力：热区在 input.lua、画面在 view.lua，同一份数字写两处 ⇒ 改一处忘另一处就是"看得见点不着"。
 * 作者自写的 ~60 行脚本（tmp/check-overlay-rects.mjs）只覆盖了这一种写法；这里钉住的是
 * **机械可判**的部分（含"循环建出来的控件"：公式 + 驱动表原文摆出来，工具**不代换**）。
 */
await check('N-1 纯函数：从注释/字符串里不误取；`add(...)` 与 `local RECT = {…}` 都认得', async () => {
  const src = [
    '-- add("注释里的", "img", 1, 2, 3, 4)',
    'local s = "add(\\"字符串里的\\", \\"img\\", 9, 9, 9, 9)"',
    'local T_START = { 620, 480, 360, 72 }',
    'function build()',
    '  add("ovB1", "img", 620, 480, 360, 72)',
    'end',
    '',
  ].join('\n');
  const r = scanRects(src, 'x.lua');
  const names = r.rects.map((x) => x.name);
  assert(!names.includes('注释里的') && !names.includes('字符串里的'), '注释/字符串里的 add 被当成了矩形：' + JSON.stringify(names));
  assert(names.includes('T_START') && names.includes('ovB1'), '漏了正经的矩形：' + JSON.stringify(names));
  const t = r.rects.find((x) => x.name === 'T_START');
  assert(JSON.stringify(t.rect) === '[620,480,360,72]' && t.formula === false, 'table 矩形解析不对：' + JSON.stringify(t));
  assert(t.line === 3, '行号不对：' + t.line);
  assert(asNumber('620') === 620 && asNumber('620 + 1') === null, 'asNumber 判据不对');
  assert(JSON.stringify(splitTopLevelArgs('a, f(1,2), b')) === '["a","f(1,2)","b"]', '顶层逗号切分不对');
  return '注释/字符串不误取；table 与 add 都认，带行号';
});

await check('N-1 纯函数：循环建出来的控件 → formula + 驱动表原文（**不代换**，宁可少覆盖）', async () => {
  const src = [
    'local MENU_BTNS = {',
    '  { "mxB1", "继续", 400 },',
    '  { "mxB2", "图鉴", 488 },',
    '}',
    'function build(mi, y)',
    '  add("ovB1", "img", 620, 480, 360, 72)',
    '  add(MENU_BTNS[mi][1], "img", 620, y, 360, 72)',
    'end',
    '',
  ].join('\n');
  const r = scanRects(src, 'view.lua');
  const menu = r.rects.find((x) => String(x.name).includes('MENU_BTNS'));
  assert(menu, '循环建出来的那条没被收到：' + JSON.stringify(r.rects.map((x) => x.name)));
  assert(menu.formula === true && menu.rect === null, '公式那条被当成了字面量：' + JSON.stringify(menu));
  assert(menu.nonLiteralSlots.some((s) => s.expr === 'y'), '没说清卡在哪一项：' + JSON.stringify(menu.nonLiteralSlots));
  assert(r.driverTables.length === 1 && r.driverTables[0].name === 'MENU_BTNS' && r.driverTables[0].rows.length === 2,
    '驱动表没抽到：' + JSON.stringify(r.driverTables));
  const refs = expandDriverRefs(r.rects, r.driverTables);
  assert(refs.length === 1 && refs[0].table === 'MENU_BTNS' && refs[0].rows[0][0] === '"mxB1"', 'driverRefs 没把表行摆到公式旁边：' + JSON.stringify(refs));
  return 'formula:true + 槽位表达式 + 驱动表 2 行原文（工具只摆事实，不替人算）';
});

await check('N-1 纯函数：跨文件配对（同名 / 数值近似 / 人点名的 pairs）只报数字', async () => {
  const view = scanRects(['add("ovB1", "img", 620, 480, 360, 72)', 'add("btnSet", "img", 620, 812, 240, 88)', 'add("SAME_ONE", "img", 10, 20, 30, 40)'].join('\n'), 'view.lua').rects;
  const input = scanRects(['local T_START = { 620, 480, 360, 72 }', 'local BTN_SET = { 620, 812, 240, 90 }', 'local SAME_ONE = { 10, 20, 30, 40 }'].join('\n'), 'input.lua').rects;
  const c = compareRects([...view, ...input], { nearPx: 4, pairs: [['ovB1', 'T_START'], ['btnSet', 'BTN_SET']] });
  assert(c.counts.rects === 6 && c.counts.withNumbers === 6, '计数不对：' + JSON.stringify(c.counts));
  const p1 = c.pairsChecked.find((p) => p.a && p.a.name === 'ovB1');
  assert(p1 && p1.equal === true && p1.maxDelta === 0, '点名对照（逐字一致）没判对：' + JSON.stringify(p1));
  const p2 = c.pairsChecked.find((p) => p.a && p.a.name === 'btnSet');
  assert(p2 && p2.equal === false && JSON.stringify(p2.delta) === '[0,0,0,-2]', '点名对照（差 2px）没给出逐字段差：' + JSON.stringify(p2));
  assert(c.near.some((n) => n.maxDelta === 2 && n.a.file !== n.b.file), '近似配对没跨文件给出：' + JSON.stringify(c.near));
  assert(c.sameName.length === 1 && c.sameName[0].name === 'SAME_ONE' && c.sameName[0].same === true, '同名组不对：' + JSON.stringify(c.sameName));
  assert(c.exact.length >= 1, '逐字相同的组没算出来：' + JSON.stringify(c.exact));
  return JSON.stringify(c.counts);
});

await check('N-1 集成：`op=rects dir=<工程目录>` 出「文件:行号 + 数值」+ 配对差异；summaryOnly 只去体积', async () => {
  const proj = path.join(tmpRoot, 'proj-侦探');
  fs.mkdirSync(path.join(proj, '_snapshots'), { recursive: true });
  fs.writeFileSync(path.join(proj, '表现 view.lua'), [
    'local MENU_BTNS = { { "mxB1", "继续", 400 } }',
    'function build(mi, y)',
    '  add("ovB1", "img", 620, 480, 360, 72)',
    '  add("btnSet", "img", 620, 812, 240, 88)',
    '  add(MENU_BTNS[mi][1], "img", 620, y, 360, 72)',
    'end',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(proj, '交互 input.lua'), [
    'local T_START = { 620, 480, 360, 72 }',
    'local BTN_SET = { 620, 812, 240, 90 }',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(proj, '表现 view_备份.lua'), 'add("旧的", "img", 0, 0, 1, 1)\n', 'utf8');
  fs.writeFileSync(path.join(proj, '_snapshots', '老版本.lua'), 'add("快照里的", "img", 0, 0, 1, 1)\n', 'utf8');

  const r = await codeTool.execute({ op: 'rects', dir: proj, pairs: [['btnSet', 'BTN_SET']] }, {});
  assert(r.ok, 'op=rects 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.fileCount === 2, '没扫到 2 个 .lua：' + r.fileCount);
  const where = r.rects.map((x) => x.where);
  assert(where.some((w) => /^表现 view\.lua:\d+$/.test(w)), '矩形没带「文件:行号」：' + JSON.stringify(where.slice(0, 4)));
  assert(!where.some((w) => /备份/.test(w)), '备份文件被扫进来了：' + JSON.stringify(where));
  assert(r.skipped.some((s) => /备份/.test(s.path)) && r.skipped.some((s) => /_snapshots/.test(s.path)),
    '跳过了什么没说清：' + JSON.stringify(r.skipped));
  assert(r.driverTables.length === 1 && r.driverRefs.length === 1, '驱动表/公式没带出来：' + JSON.stringify({ t: r.driverTables.length, d: r.driverRefs.length }));
  const p = r.pairsChecked.find((x) => x.a && x.a.name === 'btnSet');
  assert(p && JSON.stringify(p.delta) === '[0,0,0,-2]', '点名对照的差异不对：' + JSON.stringify(p));
  assert(/只报数字/.test(r.disclaimer) && /不会自动配/.test(r.disclaimer), '免责说明不完整：' + r.disclaimer.slice(0, 120));
  const slim = await codeTool.execute({ op: 'rects', dir: proj, pairs: [['btnSet', 'BTN_SET']], summaryOnly: true }, {});
  assert(slim.rects === undefined && slim.counts.rects === r.counts.rects, 'summaryOnly 没去掉清单/丢了计数：' + JSON.stringify({ u: slim.rects, c: slim.counts }));
  assert(slim.pairsChecked.length === r.pairsChecked.length && slim.near.length === r.near.length, 'summaryOnly 把差异列表也去掉了：' + JSON.stringify({ p: slim.pairsChecked.length, n: slim.near.length }));
  assert(JSON.stringify(slim).length < JSON.stringify(r).length, 'summaryOnly 没省到体积');
  let msg = null;
  try { await codeTool.execute({ op: 'rects', dir: path.join(tmpRoot, '不存在') }, {}); } catch (e) { msg = e.message; }
  assert(msg && /存在的目录/.test(msg), '目录不存在时没报错指路：' + msg);
  return `${r.counts.rects} 个矩形 / 近似 ${r.counts.nearPairs} 对 / 点名差异 ${JSON.stringify(p.delta)}；summaryOnly 省了 ${(1 - JSON.stringify(slim).length / JSON.stringify(r).length).toFixed(2)}`;
});

await check('N-1 集成：**不给 dir** 时扫当前关卡的活文件目录（两条入口都通）', async () => {
  const lv = fakeLevel({
    levelId: '1073741912',
    luas: {
      '表现 view.lua': 'add("ovB1", "img", 620, 480, 360, 72)\n',
      '交互 input.lua': 'local T_START = { 620, 480, 360, 72 }\n',
    },
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const r = await codeTool.execute({ op: 'rects', level: '1073741912', pairs: [['ovB1', 'T_START']] }, {});
    assert(r.ok && r.scope === 'level', 'scope 不是 level：' + JSON.stringify({ ok: r.ok, s: r.scope }));
    assert(r.fileCount === 2 && r.counts.rects === 2, '没扫到活文件目录里的矩形：' + JSON.stringify({ f: r.fileCount, c: r.counts.rects }));
    assert(r.pairsChecked[0] && r.pairsChecked[0].equal === true, '跨文件点名对照没对上：' + JSON.stringify(r.pairsChecked[0]));
    assert(r.rects.every((x) => /:\d+$/.test(x.where)), '没给「文件:行号」：' + JSON.stringify(r.rects.map((x) => x.where)));
    return 'scope=level / 2 个文件 / 2 个矩形 / ovB1↔T_START 一致';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

/* ================================================================== N-2 · health op=sha */

/*
 * 新能力：deploy 只写本地活文件，**游戏跑的是编辑器存盘时嵌进 `.gil` 的快照** ⇒
 * 「部署了但没存盘」是最容易白跑一轮的失败。这里把三处哈希 + 一句话结论做成一眼可判。
 */
await check('N-2 纯函数 compareLiveSources：三列对照 + 结论（该部署 / 该存盘 / 三方一致 / 比不了）', async () => {
  const A = 'A'.repeat(64); const B = 'B'.repeat(64);
  const same = compareLiveSources({ live: { name: 'a.lua', sha256: A }, mirror: { name: 'a.lua', sha256: A }, embedded: { file: 'a.lua', sha256: A } });
  assert(same.verdict === '三方一致' && same.allThreeMatch === true, '三方一致没判出来：' + JSON.stringify(same.verdict));
  const needSave = compareLiveSources({ live: { name: 'a.lua', sha256: B }, embedded: { file: 'a.lua', sha256: A } });
  assert(needSave.verdict === '该存盘了' && /存一次盘/.test(needSave.conclusion), '「该存盘了」没判出来：' + JSON.stringify(needSave.conclusion));
  const mirrorBehind = compareLiveSources({ live: { name: 'a.lua', sha256: B }, mirror: { name: 'a.lua', sha256: A }, embedded: { file: 'a.lua', sha256: B } });
  assert(mirrorBehind.verdict === '该同步镜像了', '镜像落后没判出来：' + mirrorBehind.verdict);
  const twoCol = compareLiveSources({ live: { name: 'a.lua', sha256: A }, embedded: { file: 'a.lua', sha256: A } });
  assert(twoCol.rows[1].sha256 === null && twoCol.rows[1].matchesLive === null, '没有镜像那一列该如实给 null：' + JSON.stringify(twoCol.rows[1]));
  assert(twoCol.caveats.some((c) => /没给镜像目录/.test(c)), '没说明少了一列：' + JSON.stringify(twoCol.caveats));
  assert(twoCol.verdict === '三方一致' || twoCol.verdict === '只比得出一部分', '两列时的结论不对：' + twoCol.verdict);
  const none = compareLiveSources({});
  assert(none.verdict === '比不了' && none.allThreeMatch === null, '什么都没给时该说比不了：' + JSON.stringify(none));
  return '四方结论都对；缺列 → null（不假装一致）';
});

await check('N-2 集成：`miliastra_health op=sha` 三列 + 结论；不传 mirror 就只出两列', async () => {
  const SRC = '-- 本地 view v2\nlocal a = 2\n';
  const lv = fakeLevel({
    levelId: '1073741909',
    gils: [makeGil({ levelId: 1073741909, scripts: [{ mappingId: 1073741825, name: '表现 view', file: '表现 view.lua', source: SRC }] })],
    luas: { '表现 view.lua': SRC },
  });
  const mirrorDir = path.join(tmpRoot, 'mirror-侦探');
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(path.join(mirrorDir, '表现 view.lua'), SRC, 'utf8');
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const r = await healthTool.execute({ op: 'sha', level: '1073741909', mirror: mirrorDir }, {});
    assert(r.ok, 'op=sha 失败：' + JSON.stringify(r).slice(0, 200));
    assert(r.rows.length === 3, '不是三列：' + JSON.stringify(r.rows.map((x) => x.source)));
    assert(r.rows.every((x) => x.matchesLive === true), '三列哈希没对上：' + JSON.stringify(r.rows));
    assert(r.verdict === '三方一致', '结论不对：' + r.verdict + ' ' + r.conclusion);
    assert(/存一次盘|可以（stop/.test(r.nextStep || ''), '没给下一步：' + r.nextStep);

    // 镜像落后：改镜像那一份 → 结论必须变，且指出是镜像的问题
    fs.writeFileSync(path.join(mirrorDir, '表现 view.lua'), '-- 镜像还是旧的\n', 'utf8');
    const r2 = await healthTool.execute({ op: 'sha', level: '1073741909', mirror: mirrorDir }, {});
    assert(r2.verdict === '该同步镜像了', '镜像落后没判出来：' + r2.verdict);
    assert(r2.rows.find((x) => x.source === 'mirror').matchesLive === false, '镜像那一列的判据不对：' + JSON.stringify(r2.rows));

    // 不传 mirror：只出两列（插件不假设工作区布局）
    const r3 = await healthTool.execute({ op: 'sha', level: '1073741909' }, {});
    assert(r3.mirrorDir === null && r3.rows[1].sha256 === null, '不传 mirror 却出了镜像列：' + JSON.stringify(r3.rows[1]));
    assert(r3.caveats.some((c) => /没给镜像目录/.test(c)), '没说明少了一列：' + JSON.stringify(r3.caveats));

    // 「该存盘了」这条路：把活文件改掉（不等编辑器存盘）
    fs.writeFileSync(path.join(lv.luaDir, '表现 view.lua'), '-- 刚部署但还没存盘\nlocal a = 3\n', 'utf8');
    const r4 = await healthTool.execute({ op: 'sha', level: '1073741909' }, {});
    assert(r4.verdict === '该存盘了' && /存一次盘/.test(r4.nextStep || ''), '「该存盘了」没判出来：' + r4.verdict + ' / ' + r4.nextStep);
    assert(Object.keys(r4)[0] !== 'ok' || true, '占位');
    return '三方一致 → 镜像落后 → 该存盘了；不传 mirror 只出两列';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

await check('N-2 schema：health 声明了 op / mirror 且在「典型调用」里给了可照抄的请求', async () => {
  const p = healthTool.parameters.properties;
  assert(p.op && p.op.enum.includes('sha'), '没声明 op=sha：' + JSON.stringify(p.op));
  assert(p.mirror && /绝对路径/.test(p.mirror.description), 'mirror 的说明没说清是绝对路径');
  assert(/op":"sha/.test(healthTool.description), 'description 的典型调用里没有 sha');
  assert(/三方一致|该存盘了/.test(healthTool.description), 'description 没写结论长什么样');
  return 'op=sha + mirror（绝对路径）+ 典型调用';
});

/* ================================================================== N-3 · lua 断言的返回值契约 */

/*
 * 契约是**实测**出来的（不是照抄猜测）：引擎 `evalQueryScript` → `runChunk` 走
 * `lua_pcall(L, 0, 0, 0)`（**0 个返回值**）⇒ **返回值被丢弃**，脚本跑完不报错就算过。
 * 所以要"不成立就失败"必须自己 `assert(false,…)` / `error(…)`。
 */
await check('N-3 契约（实测）：lua 断言**只看报不报错** —— `return false` 也算过，`assert(false)` 才算不过', async () => {
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: '有字', text: 'X' } });
  const a = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'lua', source: 'return false' }], shotOnFail: false });
  assert(a.passed === true, '`return false` 竟然没过 —— 契约变了！请同步改工具说明与 docs：' + JSON.stringify(a.results).slice(0, 200));
  const b = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'lua', source: 'assert(false, "我不成立")' }], shotOnFail: false });
  assert(b.passed === false, '`assert(false)` 竟然过了：' + JSON.stringify(b.results).slice(0, 200));
  assert(/我不成立/.test(JSON.stringify(b.results)), '失败原因没带回 Lua 的报错文本：' + JSON.stringify(b.results).slice(0, 200));
  const c = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'lua', source: 'assert(query.control("有字") ~= nil, "控件没了")' }], shotOnFail: false });
  assert(c.passed === true, '正常断言没过：' + JSON.stringify(c.results).slice(0, 200));
  const d = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'lua', source: 'assert(query.control("没有这个") ~= nil, "控件没了")' }], shotOnFail: false });
  assert(d.passed === false, '该失败的断言过了：' + JSON.stringify(d.results).slice(0, 200));
  const e = await simOp({ op: 'verify', steps: [], expect: [{ kind: 'lua', source: 'local x ==' }], shotOnFail: false });
  assert(e.passed === false, 'Lua 语法错竟然过了');
  return 'return false → 过；assert(false)/语法错 → 不过（错误文本带回）；query.* 可用';
});

await check('N-3 schema：契约写进 miliastra_sim 的说明（返回值被忽略 + 要失败得自己 assert/error）', async () => {
  const d = String(simTool.description || '');
  assert(/返回值被忽略/.test(d), '没说清返回值契约：' + d.slice(-500));
  assert(/assert\(false/.test(d), '没给「要失败得自己 assert」的例子');
  return '说明里有「返回值被忽略 / assert(false, …)」';
});

/* ================================================================== 「确认好用的」6 条（保持，别改） */

/*
 * 这 6 条是本轮实盘里**实打实换到钱**的机制（清单「确认好用的（保持，别改）」）。
 * 前 4 条已有专门回归（feedback3 / locate-test / sim-test），这里再各钉一条**面向用法**的断言，
 * 让「以后谁顺手改了它们」在同一个地方就红 —— 另两条（updateScript / 确定性重放）补上缺口。
 */
await check('保持①：`op=deploy` 的 reconcile.match（跑的是不是本地这版）+ 部署指纹', async () => {
  const SRC = '-- 本地 main v9\nlocal a = 9\n';
  const lv = fakeLevel({
    levelId: '1073741910',
    gils: [makeGil({ levelId: 1073741910, scripts: [{ mappingId: 1073741827, name: '主控 main', file: '主控 main.lua', source: SRC }] })],
    luas: { '主控 main.lua': '-- 旧版\n' },
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const src = path.join(tmpRoot, '主控 main.lua');
    fs.writeFileSync(src, SRC, 'utf8');
    const r = await codeTool.execute({ op: 'deploy', level: '1073741910', file: '主控 main.lua', source: src }, {});
    assert(r.ok && r.reconcile && r.reconcile.match === true, 'reconcile.match 不是 true：' + JSON.stringify(r.reconcile).slice(0, 200));
    assert(r.deployFingerprint && r.deployFingerprint.sha256, '部署指纹没记：' + JSON.stringify(r.deployFingerprint));
    const ins = await codeTool.execute({ op: 'inspect', level: '1073741910' }, {});
    assert(ins.deploy && ins.deploy.sameAsDeploy === true, 'inspect 没判「与上次部署一致」：' + JSON.stringify(ins.deploy).slice(0, 200));
    // 模拟「编辑器把内存版存回磁盘」
    fs.writeFileSync(path.join(lv.luaDir, '主控 main.lua'), '-- 被编辑器写回的旧版\n', 'utf8');
    const ins2 = await codeTool.execute({ op: 'inspect', level: '1073741910' }, {});
    assert(ins2.deploy.changedSinceDeploy === true && /编辑器/.test(ins2.deploy.note || ''), '活文件被改写没发现：' + JSON.stringify(ins2.deploy).slice(0, 200));
    return 'match=true + 指纹 + inspect 一致/被改写两种都判对';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

await check('保持②：`op=cases` 验收单（自动项重放 + 人工项只列出来等人打勾；autoPassed≠验收通过）', async () => {
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'K', text: 'ok' } });
  await simOp({ op: 'cases', action: 'add', set: 'FB4-保持', cases: [
    { name: '自动-文本在', steps: [], expect: [{ kind: 'control', name: 'K', field: 'text', equals: 'ok' }] },
    { manual: true, note: '真机上小人看得见' },
  ] });
  const run = await simOp({ op: 'cases', action: 'run', set: 'FB4-保持' });
  assert(run.autoPassed === true && run.passedCount === 1, '自动项没跑过：' + JSON.stringify(run).slice(0, 200));
  assert(run.manual && run.manual.length === 1 && /真机上/.test(run.manual[0].note), '人工项没列出来：' + JSON.stringify(run.manual));
  assert(/不等于.*验收通过|整组没算过/.test(run.note), '没点破 autoPassed ≠ 验收通过：' + run.note);
  // 确定性重放：同一个用例跑两次，结果必须一样
  const again = await simOp({ op: 'cases', action: 'run', set: 'FB4-保持' });
  assert(again.autoPassed === run.autoPassed && again.passedCount === run.passedCount, '重放结果不稳定');
  return 'autoPassed=true + manual[] 1 条 + 两次重放一致';
});

await check('保持③：`op=patch updateScript` 能原地更新模拟器里的脚本（省掉重新 bind + 补黑板）', async () => {
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'up.lua', source: 'function OnStart()\n  print("UPDATE_V1")\nend\n' } });
  const up = await simOp({ op: 'patch', patch: { op: 'updateScript', path: 'up.lua', source: 'function OnStart()\n  print("UPDATE_V2")\nend\n' } });
  assert((up.scripts || []).length === 1 && up.scripts[0].path === 'up.lua', 'updateScript 把脚本弄丢了：' + JSON.stringify(up.scripts));
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 10; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const got = await simOp({ op: 'play', action: 'get', args: { compact: true } });
  const texts = (got.logs || []).map((l) => l.text || '');
  await simOp({ op: 'play', action: 'stop' });
  assert(texts.some((t) => /UPDATE_V2/.test(t)) && !texts.some((t) => /UPDATE_V1/.test(t)), 'updateScript 没生效（跑的还是旧版）：' + JSON.stringify(texts.slice(-3)));
  return '按 path 原地更新 → 跑起来打的是 V2';
});

await check('保持④⑤⑥：staleLog / op=arm 参数面 / sim verify 确定性重放（三条一起钉）', async () => {
  const playtestTool = TOOLS.find((t) => t.name === 'miliastra_playtest');
  const lv = fakeLevel({
    levelId: '1073741911',
    logs: { '2026-09-26_16-16-23_184_201170108.gia': makeGia([{ message: '[老局] OnInit', instance: '47504-201170108-1790324179-1' }]) },
    // 本机最近一局是 1790324585（16:23），而目录里的 .gia 属于 1790324179（16:16）⇒ 必须报 staleLog
    outputLog: [
      '[2026-09-26 16:16:19.872] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790324179',
      '[2026-09-26 16:16:43.769] Genshin Loading Log: StartQuickSwitchSceneAction token:1 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:',
      '[2026-09-26 16:23:05.069] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790324585',
      '[2026-09-26 16:23:30.912] Genshin Loading Log: StartQuickSwitchSceneAction token:2 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:',
      '',
    ].join('\n'),
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = lv.root;
  try {
    const r = await logTool.execute({ op: 'runs', level: '1073741911', limit: 1 }, {});
    assert(r.ok && r.staleLog === true && /不属于本次会话/.test(r.staleLogWarning || ''), 'staleLog 告警没了：' + JSON.stringify({ s: r.staleLog, w: r.staleLogWarning }));
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
  assert(playtestTool.parameters.properties.op.enum.includes('arm'), 'op=arm 没了');
  assert(Array.isArray(playtestTool.parameters.properties.afterSec.oneOf), 'afterSec 的 oneOf 没了');
  assert(/武装后台截图/.test(playtestTool.description), 'description 里的 arm 说明没了');
  // 确定性重放：同一用例两次结果一致（含事件时间点）
  await simOp({ op: 'reset' });
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'R', text: 'RR' } });
  const spec = { steps: [{ at: 0.2, view: 1 }], expect: [{ kind: 'control', name: 'R', field: 'text', equals: 'RR' }] };
  const v1 = await simOp({ op: 'verify', ...spec, shotOnFail: false });
  const v2 = await simOp({ op: 'verify', ...spec, shotOnFail: false });
  assert(v1.passed === true && v2.passed === true, '确定性重放没过：' + JSON.stringify([v1.passed, v2.passed]));
  assert(v1.failedAt === v2.failedAt && v1.frame === v2.frame, '两次重放的 frame/failedAt 不一致：' + JSON.stringify([v1.frame, v2.frame]));
  return 'staleLog 仍告警 / arm 参数面在 / 两次重放 frame 都是 ' + v1.frame;
});

/* ------------------------------------------------------------------ 收尾 */

process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW;
if (savedData === undefined) delete process.env.MILIASTRA_DATA_DIR; else process.env.MILIASTRA_DATA_DIR = savedData;
if (savedBak === undefined) delete process.env.MILIASTRA_BACKUP_DIR; else process.env.MILIASTRA_BACKUP_DIR = savedBak;
try { await simOp({ op: 'reset' }); } catch { /* ignore */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n结果：通过 ${pass}，失败 ${failures.length}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
