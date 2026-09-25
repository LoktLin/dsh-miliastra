/**
 * 第三批反馈修复的自测（任务书 2026-09-25：A1 / A2 / B1~B4 / C1 / D1）
 *
 * 每一条的「**修之前为什么红**」都写在对应的那一段上面 —— 这个文件里的断言都是为了
 * **在未来某次改动里重新变红**而写的，不是「跑一遍看有没有报错」。
 *
 * 全部用**合成的假存档 / 假活文件 / 假日志 / 假试玩日志**（`MILIASTRA_LOCALLOW` +
 * `MILIASTRA_DATA_DIR` 指到临时目录），不碰真机的活文件、地图与截图。
 *
 * 用法：node tests/feedback3-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 作用域隔离
 * ⚠️ `MILIASTRA_DATA_DIR` **必须在 import 之前设好**（sim.mjs 在模块初始化时读它来决定
 * 模拟器工作区 / 截图目录）——所以下面全部用动态 import。
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fb3-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedData = process.env.MILIASTRA_DATA_DIR;
const savedBak = process.env.MILIASTRA_BACKUP_DIR;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');
process.env.MILIASTRA_BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.QXQY_PLAY_TIMEOUT_MS = '2000';

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
const { simOp, normalizeScriptPatch } = await import('../lib/sim.mjs');
const { readScriptMappings, readScriptMounts, pickScriptMapping, mountStatusOf } = await import('../lib/gil.mjs');
const { giaRunEpochs, logFreshness, giaLandingState } = await import('../lib/gia.mjs');
const { frameInRun, burstSummary } = await import('../lib/shot.mjs');

const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');
const logTool = TOOLS.find((t) => t.name === 'miliastra_log');
const playtestTool = TOOLS.find((t) => t.name === 'miliastra_playtest');
const shotTool = TOOLS.find((t) => t.name === 'miliastra_shot');

/* ------------------------------------------------------------------ 合成 protobuf */

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

/**
 * 合成 `.gil`：**多脚本** + **挂载引用**（`#6 → #1 → #4 {#1 归属名, #5 ×n {#1 槽位, #2 映射索引}}`）。
 * 形状与真机 1073741835 那张六脚本图一致（实测：6 条挂在「侦探1-7」，1 条挂在「未分类页签」）。
 */
function makeGil({
  levelId, name = '假图', account = 201170108, version = '7.1.0',
  scripts = [], mounts = [], withHierarchy = true,
}) {
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
  if (withHierarchy) {
    const owners = mounts.map((g) => pbBytes(4, Buffer.concat([
      pbStr(1, g.owner), pbNum(3, g.mappingIds.length),
      ...g.mappingIds.map((mid) => pbBytes(5, Buffer.concat([pbNum(1, 7900), pbNum(2, mid)]))),
    ])));
    parts.push(pbBytes(6, pbBytes(1, Buffer.concat(owners.length ? owners : [pbStr(1, '空层级')]))));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
}

/** 合成 `.gia`：8 字节包头 + 每条记录一个 `#1` 子消息。 */
function makeGia(records) {
  const recs = records.map((r) => pbBytes(1, Buffer.concat([
    pbStr(2, r.instance),
    pbStr(4, r.time || '2026/09/25_16:16:19'),
    pbNum(5, 201170108),
    pbBytes(11, pbStr(2, '假图')),
    pbBytes(23, pbStr(2, r.message)),
  ])));
  return Buffer.concat([Buffer.alloc(8), ...recs]);
}

/** 造一个假 LocalLow 关卡目录。 */
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

/* ================================================================== A2 · 纯函数：这份 .gia 属于哪一局 */

/*
 * 修之前为什么红：16:23 / 16:26 / 16:29 / 16:34 四局**都没有生成 `.gia`**，
 * 而 `op=grep`/`op=runs` 会**静默回退到 16:16 那局的旧文件** —— 子代理三次都把旧局当成了本局。
 * 判据只能有一个：**文件里有没有本局那个 epochSec**（instance 第三段 == 开跑时刻）。
 */
await check('A2 纯函数 giaRunEpochs：只认「试玩局」（47504），排序去重，90003 不算', async () => {
  const epochs = giaRunEpochs([
    { instance: '90003-201170108-1790324100-1' },
    { instance: '47504-201170108-1790324179-16831' },
    { instance: '47504-201170108-1790324179-16832' },
    { instance: '47504-201170108-1790324585-9' },
    { instance: 'bogus' },
  ]);
  assert(JSON.stringify(epochs) === JSON.stringify([1790324179, 1790324585]), '取出/排序不对：' + JSON.stringify(epochs));
  return '90003 被排除，两局去重后升序 [1790324179, 1790324585]';
});

await check('A2 纯函数 logFreshness：本局 epoch 不在文件里 → stale:true + logBelongsTo 带文件名与 epochSec', async () => {
  const f = logFreshness({
    file: 'C:\\x\\2026-09-25_16-16-23_184_201170108.gia',
    fileEpochSecs: [1790324179],
    runEpochSec: 1790324585,
  });
  assert(f.known === true && f.belongs === false && f.stale === true, '没判成 stale：' + JSON.stringify(f));
  assert(f.logBelongsTo === '2026-09-25_16-16-23_184_201170108.gia (epochSec 1790324179)', 'logBelongsTo 形状不对：' + f.logBelongsTo);
  assert(/更早的某一局/.test(f.note), 'note 没点破是更早的局：' + f.note);
  const ok = logFreshness({ file: 'a.gia', fileEpochSecs: [1790324585], runEpochSec: 1790324585 });
  assert(ok.belongs === true && ok.stale === false, '本局自己那份反被判 stale：' + JSON.stringify(ok));
  const unknown = logFreshness({ file: 'a.gia', fileEpochSecs: [], runEpochSec: null, runStartedAtMs: null });
  assert(unknown.known === false && unknown.stale === null, '没有基准时应当「判断不了」：' + JSON.stringify(unknown));
  return 'stale / 本局 / 判断不了 三档都分开了';
});

await check('A2 纯函数 giaLandingState：running / landed / missing / none 四档 + 未落盘的措辞', async () => {
  const running = giaLandingState({ latest: { name: 'a.gia' }, running: true });
  assert(running.status === 'running' && running.landed === false && /还在跑/.test(running.note), 'running 档不对：' + JSON.stringify(running));
  const landed = giaLandingState({ latest: { name: 'a.gia' }, runEpochSec: 123, fileEpochSecs: [123] });
  assert(landed.status === 'landed' && landed.landed === true && /已落盘/.test(landed.note), 'landed 档不对：' + JSON.stringify(landed));
  const missing = giaLandingState({ latest: { name: 'a.gia' }, runEpochSec: 999, fileEpochSecs: [123] });
  assert(missing.status === 'missing' && missing.landed === false && /未落盘/.test(missing.note) && /不是本局/.test(missing.note),
    'missing 档没说清「不是本局」：' + JSON.stringify(missing));
  const none = giaLandingState({ latest: null });
  assert(none.status === 'none' && /未落盘/.test(none.note), 'none 档不对：' + JSON.stringify(none));
  return 'running / landed / missing / none 各一句，且 missing 明说「目录里最新那个不是本局」';
});

/* ================================================================== A2 · 集成：status 的 localGia + log 的 staleLog */

/*
 * 修之前为什么红：`op=status` 只回「在不在试玩」，`.gia` 有没有落盘要人自己翻目录；
 * `op=runs`/`op=grep` 取到旧文件时**一个字都不提醒**。
 */
const a2Low = fakeLevel({
  levelId: '1073741902',
  gils: [makeGil({ levelId: 1073741902, scripts: [{ mappingId: 1073741825, name: '双相', file: '双相.lua' }] })],
  luas: { '双相.lua': '-- 本地这版\nlocal a = 1\n' },
  logs: {
    // 目录里**最新**的 .gia 是 16:16 那一局（1790324179）—— 而本机最近一局是 16:23（1790324585）
    '2026-09-25_16-16-23_184_201170108.gia': makeGia([
      { instance: '47504-201170108-1790324179-1', time: '2026/09/25_16:16:19', message: '[老局] OnInit' },
    ]),
  },
  outputLog: [
    '[2026-09-25 16:16:19.872] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790324179',
    '[2026-09-25 16:16:43.769] Genshin Loading Log: StartQuickSwitchSceneAction token:1 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:',
    '[2026-09-25 16:23:05.069] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790324585',
    '[2026-09-25 16:23:30.912] Genshin Loading Log: StartQuickSwitchSceneAction token:2 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:',
    '',
  ].join('\n'),
});
process.env.MILIASTRA_LOCALLOW = a2Low.root;

await check('A2 集成：`op=status` 直接回答「本局 `.gia` 落盘了没有」= 未落盘', async () => {
  const r = await playtestTool.execute({ op: 'status', level: '1073741902' }, {});
  assert(r.ok, 'status 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.localGia && r.localGia.landed === false, '没给出「未落盘」：' + JSON.stringify(r.localGia));
  assert(r.localGia.runEpochSec === 1790324585, '本局 epochSec 不对：' + JSON.stringify(r.localGia));
  assert(/未落盘/.test(r.localGia.note) && /可能该局不产生/.test(r.localGia.note), '措辞没到位：' + r.localGia.note);
  assert(Array.isArray(r.localGia.fileEpochSecs) && r.localGia.fileEpochSecs[0] === 1790324179, '没报出目录里那份属于哪一局');
  return r.localGia.note.slice(0, 76) + '…';
});

await check('A2 集成：`op=runs` 取到的是**更早那一局**的文件 → staleLog:true + logBelongsTo', async () => {
  const r = await logTool.execute({ op: 'runs', level: '1073741902', limit: 1 }, {});
  assert(r.ok, 'runs 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.staleLog === true, '没告警 staleLog：' + JSON.stringify({ stale: r.staleLog, file: r.file }));
  assert(/2026-09-25_16-16-23_184_201170108\.gia \(epochSec 1790324179\)/.test(r.logBelongsTo || ''),
    'logBelongsTo 没带文件名与 epochSec：' + r.logBelongsTo);
  assert(/不属于本次会话/.test(r.staleLogWarning || '') && /别把这份日志当成本局证据/.test(r.staleLogWarning || ''),
    'staleLogWarning 没说清后果：' + r.staleLogWarning);
  return 'staleLog=true，logBelongsTo=' + r.logBelongsTo;
});

await check('A2 集成：`op=tail` 同样带 staleLog（三个 op 口径一致，不是只补了 runs）', async () => {
  const r = await logTool.execute({ op: 'tail', level: '1073741902', limit: 5 }, {});
  assert(r.ok && r.staleLog === true, 'tail 没带 staleLog：' + JSON.stringify({ ok: r.ok, stale: r.staleLog }));
  return 'tail 也有 staleLog + logBelongsTo';
});

/* ================================================================== A1 · 纯函数：全部映射 + 已挂载集合 */

/*
 * 修之前为什么红：`mountedScriptNames` 只读 `#50` 的**第一条**（多脚本地图里那是旧占位
 * 「新建客户端脚本」）⇒ 6 个脚本的工程 6 次 deploy 全部 `mount.mounted:false`（假阴性）。
 */
const A1_SCRIPTS = [
  { mappingId: 1073741825, name: '新建客户端脚本' },
  { mappingId: 1073741827, name: '主控 main', file: '主控 main.lua', source: '-- main\n' },
  { mappingId: 1073741828, name: '表现 view', file: '表现 view.lua', source: '-- view\n' },
];
const A1_GIL = makeGil({
  levelId: 1073741903, scripts: A1_SCRIPTS,
  mounts: [{ owner: '侦探1-7', mappingIds: [1073741827, 1073741828] }, { owner: '未分类页签', mappingIds: [1073741825] }],
});
const A1_ROOT = fakeLevel({
  levelId: '1073741903',
  gils: [A1_GIL],
  luas: { '主控 main.lua': '-- 本地 main v2\nlocal a = 1\n', '表现 view.lua': '-- 本地 view v2\n', '没挂过.lua': '-- 新脚本\nlocal z = 1\n' },
});

await check('A1 纯函数 readScriptMappings：**读全部**映射（不是只读第一条占位）', async () => {
  const { findProtobufRoot } = await import('../lib/wire.mjs');
  const top = findProtobufRoot(A1_GIL).fields;
  const all = readScriptMappings(top);
  assert(all.length === 3, '映射条数不对：' + all.length);
  assert(all[0].name === '新建客户端脚本' && all[2].file === '表现 view.lua',
    '读出来的顺序/字段不对：' + JSON.stringify(all.map((m) => m.file || m.name)));
  assert(all[1].sourceBytes > 0 && /^[0-9A-F]{64}$/.test(all[1].sourceSha256), '源码哈希口径不对：' + JSON.stringify(all[1]));
  return '3 条映射（含旧占位）都读到了，且各带 bytes/sha256';
});

await check('A1 纯函数 readScriptMounts：挂载引用 = `#5 {槽位, 映射索引}`，带 mountedOn 归属', async () => {
  const { findProtobufRoot } = await import('../lib/wire.mjs');
  const top = findProtobufRoot(A1_GIL).fields;
  const all = readScriptMappings(top);
  const mounts = readScriptMounts(top, all.map((m) => m.mappingId));
  assert(mounts.known === true, '有 #6 层级却说不确定：' + JSON.stringify(mounts));
  assert(mounts.ids.length === 3, '挂载集合不对：' + JSON.stringify(mounts.ids));
  assert(mounts.byId[1073741828] === '侦探1-7', 'mountedOn 归属不对：' + JSON.stringify(mounts.byId));
  return '3 条挂载引用，主控/表现 挂在「侦探1-7」，占位挂在「未分类页签」';
});

await check('A1 纯函数 readScriptMounts：没有挂载信息时 known:false（**不许**据此报「没挂载」）', async () => {
  const { findProtobufRoot } = await import('../lib/wire.mjs');
  const plain = makeGil({ levelId: 1073741904, scripts: [{ mappingId: 1073741825, name: '双相', file: '双相.lua' }] , withHierarchy: false });
  const top = findProtobufRoot(plain).fields;
  const mounts = readScriptMounts(top, [1073741825]);
  assert(mounts.known === false && mounts.ids.length === 0, '没有层级却说已知：' + JSON.stringify(mounts));
  assert(/不许据此报/.test(mounts.note), 'note 没写清后果：' + mounts.note);
  return 'known:false + 明说「不许据此报没挂载」';
});

await check('A1 纯函数 pickScriptMapping：多映射里按**文件名**挑中本次这一份', async () => {
  const all = [
    { mappingId: 1, name: '新建客户端脚本', file: null },
    { mappingId: 2, name: '主控 main', file: '主控 main.lua' },
    { mappingId: 3, name: '表现 view', file: '表现 view.lua' },
  ];
  const a = pickScriptMapping(all, '表现 view.lua');
  assert(a.mapping && a.mapping.mappingId === 3 && a.matchedBy === 'file', '按 file 没挑中：' + JSON.stringify(a));
  const b = pickScriptMapping(all, '主控 main');
  assert(b.mapping && b.mapping.mappingId === 2, '按 name（无后缀）没挑中：' + JSON.stringify(b));
  const c = pickScriptMapping(all, '没挂过.lua');
  assert(c.mapping === null && c.matchedBy === null, '不该挑中任何一条：' + JSON.stringify(c));
  return 'file/name 两种写法都能挑中；挑不到如实 null';
});

await check('A1 纯函数 mountStatusOf：已挂载集合口径（集合为空 + mountKnown → mounted:false，不是 known:false）', async () => {
  const inSet = mountStatusOf({ mountedNames: ['主控 main.lua'], liveName: '主控 main.lua', mountKnown: true, mountSource: 'gil-script-mounts' });
  assert(inSet.known === true && inSet.mounted === true && inSet.source === 'gil-script-mounts', '已挂载判错：' + JSON.stringify(inSet));
  const notInSet = mountStatusOf({ mountedNames: ['主控 main.lua'], liveName: '没挂过.lua', mountKnown: true, mountSource: 'gil-script-mounts' });
  assert(notInSet.known === true && notInSet.mounted === false && /已挂载集合/.test(notInSet.note),
    '不在集合里应当明确 false 且点明用的是「已挂载集合」：' + JSON.stringify(notInSet));
  const emptySet = mountStatusOf({ mountedNames: [], liveName: 'x.lua', mountKnown: true, mountSource: 'gil-script-mounts' });
  assert(emptySet.known === true && emptySet.mounted === false, '空集合 + 已知口径应当是一句结论：' + JSON.stringify(emptySet));
  const unknown = mountStatusOf({ mountedNames: [], liveName: 'x.lua' });
  assert(unknown.known === false, '拿不到挂载信息时应当 known:false（老行为不许改）：' + JSON.stringify(unknown));
  return '已挂载 / 不在集合 / 空集合 / 判断不了 四档分开';
});

/* ================================================================== A1 · 集成：deploy 的 mount + map op=script */

await check('A1 集成：**已挂载**的脚本 → deploy 回执 mount.mounted:true（多脚本工程不再假阴性）', async () => {
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = A1_ROOT.root;
  try {
    const src = path.join(tmpRoot, 'main-v3.lua');
    fs.writeFileSync(src, '-- 本地 main v3\nlocal a = 3\n', 'utf8');
    const r = await codeTool.execute({ op: 'deploy', level: '1073741903', file: '主控 main.lua', source: src }, {});
    assert(r.ok, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
    assert(r.mount && r.mount.known === true && r.mount.mounted === true, 'mount 判据不对：' + JSON.stringify(r.mount));
    assert(r.mount.source === 'gil-script-mounts', '没说用的是「已挂载集合」：' + r.mount.source);
    assert(!/还没挂到容器节点上/.test(r.nextStep || ''), '已挂载却让人去挂载：' + r.nextStep);
    return 'mount=' + r.mount.source + '，matched=' + r.mount.matched;
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

await check('A1 集成：**没挂过**的新脚本 → mount.mounted:false 且 nextStep 要求「挂到容器节点上」', async () => {
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = A1_ROOT.root;
  try {
    const src = path.join(tmpRoot, 'new-script.lua');
    fs.writeFileSync(src, '-- 新脚本\nlocal y = 2\n', 'utf8');
    const r = await codeTool.execute({ op: 'deploy', level: '1073741903', file: '没挂过.lua', source: src }, {});
    assert(r.ok, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
    assert(r.mount && r.mount.known === true && r.mount.mounted === false, 'mount 判据不对：' + JSON.stringify(r.mount));
    assert(/还没挂到容器节点上/.test(r.nextStep || ''), 'nextStep 没点破「还没挂」：' + r.nextStep);
    return '未挂载 → ' + r.nextStep.slice(0, 54) + '…';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

await check('A1 集成：`map op=script` 列**全部**映射（含 mappingId / mountedOn），embedded 按名字挑中本次这一份', async () => {
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = A1_ROOT.root;
  try {
    const r = await mapTool.execute({ op: 'script', level: '1073741903', file: '表现 view.lua' }, {});
    assert(r.ok, 'op=script 失败：' + JSON.stringify(r).slice(0, 200));
    assert(r.scriptCount === 3 && r.mappings.length === 3, '没列出全部映射：' + JSON.stringify({ c: r.scriptCount }));
    const view = r.mappings.find((m) => m.mappingId === 1073741828);
    assert(view && view.mounted === true && view.mountedOn === '侦探1-7', 'mappings 里缺 mountedOn：' + JSON.stringify(view));
    assert(r.embedded && r.embedded.mappingId === 1073741828, 'embedded 没挑中本次这一份：' + JSON.stringify(r.embedded));
    assert(r.embeddedPickedBy === 'name:file', '没说凭什么挑的：' + r.embeddedPickedBy);
    assert(!JSON.stringify(r).includes('-- view'), '回执里混进了源码全文（会让 op 超 10KB）：' + JSON.stringify(r).length);
    // 挑不到时如实退回第一条并说明
    const fb = await mapTool.execute({ op: 'script', level: '1073741903', file: '没挂过.lua' }, {});
    assert(fb.embeddedPickedBy === 'fallback:first', '挑不到时应当明说退回第一条：' + fb.embeddedPickedBy);
    return '3 条映射 + mountedOn；embedded=' + r.embedded.mappingId + '（' + r.embeddedPickedBy + '），回执 ' + JSON.stringify(r).length + ' B';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

/* ================================================================== B1 / B2 · patch 的脚本字段 */

/*
 * 修之前为什么红：
 *   · `addScript` 只认内联 `source`，传 `sourceFrom` 被**静默忽略** ⇒ 脚本全变成空源码，
 *     运行时才报 `unfinished long string (starting at line 1) near <eof>`，而且只有脚本自己的 print 看得见；
 *   · `removeScript` 只认 `id`，传 `path` 报 `脚本不存在: undefined`。
 */
await check('B1 纯函数 normalizeScriptPatch：`sourceFrom` 读文件成 `source`；两个都给要报错', async () => {
  const patch = { op: 'addScript', path: 'a.lua', sourceFrom: 'C:\\x\\a.lua' };
  const r = normalizeScriptPatch(patch, [], () => '-- from file\n');
  assert(r.patch.source === '-- from file\n' && r.patch.sourceFrom === undefined, 'sourceFrom 没被读成 source：' + JSON.stringify(r.patch));
  let both = null;
  try { normalizeScriptPatch({ op: 'addScript', path: 'a.lua', source: 'x', sourceFrom: 'C:\\x\\a.lua' }, [], () => 'y'); } catch (e) { both = e.message; }
  assert(both && /只能给一个/.test(both), '两个都给时没报错：' + both);
  return 'sourceFrom → source；source + sourceFrom 同时给 → 明确报错';
});

await check('B1 纯函数：**不给源码就拒绝**，并说清「还有哪些字段不是源码字段」', async () => {
  let msg = null;
  try { normalizeScriptPatch({ op: 'addScript', path: 'b.lua', sourcePath: 'C:\\x\\b.lua' }, []); } catch (e) { msg = e.message; }
  assert(msg && /缺源码/.test(msg) && /sourceFrom/.test(msg), '没报「缺源码」并指路：' + msg);
  assert(/不会给你写一个空脚本/.test(msg), '没说清「不会写空脚本」：' + msg);
  assert(/sourcePath/.test(msg), '没点出传错的字段名：' + msg);
  return msg.slice(0, 80) + '…';
});

await check('B2 纯函数：removeScript 用 `path` 换 `id`；找不到报「未找到该脚本」；都不给报「缺少 id」', async () => {
  const scripts = [{ id: '1073741869', path: 'a.lua' }, { id: '1073741870', path: 'b.lua' }];
  const byPath = normalizeScriptPatch({ op: 'removeScript', path: 'b.lua' }, scripts);
  assert(byPath.patch.id === '1073741870', 'path → id 没换对：' + JSON.stringify(byPath.patch));
  let miss = null;
  try { normalizeScriptPatch({ op: 'removeScript', path: 'nope.lua' }, scripts); } catch (e) { miss = e.message; }
  assert(miss && /未找到该脚本/.test(miss) && /a\.lua/.test(miss), '找不到时没列出现有的：' + miss);
  assert(!/undefined/.test(miss || ''), '还在报 undefined：' + miss);
  let bare = null;
  try { normalizeScriptPatch({ op: 'removeScript' }, scripts); } catch (e) { bare = e.message; }
  assert(bare && /缺少 `id`（也可传 `path`）/.test(bare), '缺参数时的文案不对：' + bare);
  return 'path→id ✓ / 未找到该脚本 ✓ / 缺少 id（也可传 path）✓';
});

await check('B1+B2 集成（模拟器）：sourceFrom 真的落进工程、path 真的能删、缺源码真的被拒', async () => {
  const src = path.join(tmpRoot, 'sim-a.lua');
  fs.writeFileSync(src, 'function OnStart()\n  print("FB3_SIM_A")\nend\n', 'utf8');
  await simOp({ op: 'reset' });
  const added = await simOp({
    op: 'patch',
    patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'a.lua', sourceFrom: src },
  });
  assert((added.scripts || []).length === 1 && added.scripts[0].path === 'a.lua', 'addScript(sourceFrom) 没挂上：' + JSON.stringify(added.scripts));
  let noSrc = null;
  try { await simOp({ op: 'patch', patch: { op: 'addScript', path: 'b.lua' } }); } catch (e) { noSrc = e.message; }
  assert(noSrc && /缺源码/.test(noSrc), '不给源码没被拒：' + noSrc);
  const removed = await simOp({ op: 'patch', patch: { op: 'removeScript', path: 'a.lua' } });
  assert((removed.scripts || []).length === 0, '按 path 没删掉：' + JSON.stringify(removed.scripts));
  // 真跑一局：sourceFrom 读进来的源码必须能被 Lua 正常执行（旧实现这里是 `unfinished long string`）
  await simOp({ op: 'patch', patch: { op: 'addScript', controlId: 'n1', controlAsset: 'server-control-template', path: 'a.lua', sourceFrom: src } });
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 20; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const got = await simOp({ op: 'play', action: 'get', args: { view: true, compact: true, inspect: true } });
  const texts = (got.logs || []).map((l) => l.text);
  assert(texts.some((t) => /FB3_SIM_A/.test(t)), 'sourceFrom 的脚本没跑起来（空源码会报 unfinished long string）：' + JSON.stringify(texts));
  await simOp({ op: 'play', action: 'stop' });
  return 'sourceFrom 挂上 → OnStart 真的 print 了（' + texts.find((t) => /FB3_SIM_A/.test(t)) + '）';
});

/* ================================================================== B4 · bind 一次挂多个脚本 */

/*
 * 修之前为什么红：`op=bind` 只收单个 `source`，多脚本工程要 bind 一次再 `patch addScript` 多次
 * （而那时 addScript 还不认路径参数 —— B1 的坑就是这么踩出来的）。
 */
await check('B4 集成：一次 bind 挂 3 个脚本 —— run.logs 里出现 3 条各自 OnStart 的挂载名', async () => {
  const files = ['m1.lua', 'm2.lua', 'm3.lua'].map((n, i) => {
    const p = path.join(tmpRoot, 'b4-' + n);
    fs.writeFileSync(p, `function OnStart()\n  print("FB3_B4_${i + 1} 名=" .. tostring(script.path))\nend\n`, 'utf8');
    return { path: n, sourceFrom: p };
  });
  await simOp({ op: 'reset' });
  const r = await simOp({
    op: 'bind', run: true, settleSec: 1, scripts: files,
    templates: [{ guid: 1073741868, kind: 'image', name: '图片模板' }],
  });
  assert(r.scriptCount === 3 && (r.sources || []).length === 3, '没挂到 3 份：' + JSON.stringify({ c: r.scriptCount }));
  assert((r.scripts || []).filter((s) => s.mounted).length === 3, '有脚本没挂上：' + JSON.stringify(r.scripts));
  const texts = (r.run.logs || []).map((l) => l.text || '');
  const hit = ['FB3_B4_1', 'FB3_B4_2', 'FB3_B4_3'].filter((k) => texts.some((t) => t.includes(k)));
  assert(hit.length === 3, '没有 3 条 OnStart 的 print：' + JSON.stringify(texts));
  assert(texts.some((t) => /名=m1$/.test(t)) && texts.some((t) => /名=m3$/.test(t)), '挂载名不是文件名（引擎会去掉 .lua 后缀）：' + JSON.stringify(texts));
  // 配方里也要记下 scripts[]，`last:true` 才能一键重搭
  const recipe = JSON.parse(fs.readFileSync(path.join(process.env.MILIASTRA_DATA_DIR, 'simulator', 'last-bind.json'), 'utf8'));
  assert(Array.isArray(recipe.scripts) && recipe.scripts.length === 3, '配方里没记 scripts[]：' + JSON.stringify(recipe.scripts));
  const again = await simOp({ op: 'bind', last: true, run: false });
  assert(again.scriptCount === 3 && again.fromLast === true, 'last:true 没重搭出 3 份：' + JSON.stringify({ c: again.scriptCount, fromLast: again.fromLast }));
  return '3 份都挂上并各打了一行（名=m1/m2/m3.lua）；配方 scripts[] 也可 last:true 重搭';
});

await check('B4 纯函数（反例）：scripts[].path 重复要被拒绝', async () => {
  const p = path.join(tmpRoot, 'dup.lua');
  fs.writeFileSync(p, '-- dup\n', 'utf8');
  let msg = null;
  try {
    await simOp({ op: 'bind', run: false, scripts: [{ path: 'same.lua', sourceFrom: p }, { path: 'same.lua', sourceFrom: p }], templates: [{ guid: 1073741868, kind: 'image' }] });
  } catch (e) { msg = e.message; }
  assert(msg && /重复/.test(msg), '没拒绝重复 path：' + msg);
  return msg.slice(0, 70) + '…';
});

/* ================================================================== C1 · burst 的时序与 inRun */

/*
 * 修之前为什么红：一局只有 16 秒，而「命中后留 8 秒加载窗口再连拍 4 张」**全部落在局外**
 * （startedAt 16:34:21 / endedAt 16:34:37，4 张拍于 16:34:38~16:34:49），
 * 而回执里只有 `elapsedMs`，**得自己算**才知道全废了。
 */
await check('C1 纯函数 frameInRun：窗口内 / 窗口外 / 窗口未知三档', async () => {
  const run = { startedAtMs: 1000, endedAtMs: 5000 };
  assert(frameInRun(3000, run) === true, '窗口内判错');
  assert(frameInRun(999, run) === false, '开跑之前判错');
  assert(frameInRun(5001, run) === false, '结束之后判错');
  assert(frameInRun(3000, { startedAtMs: 1000, endedAtMs: null }) === true, '还没结束的局：拍到的都算在局内');
  assert(frameInRun(3000, null) === null, '窗口未知时**不许猜**');
  return '三档都对；未知给 null 而不是 false';
});

await check('C1 纯函数 burstSummary：逐张标 inRun + 汇总在局内/局外张数（并保住 C2 的 measuredIntervalMs/spanMs）', async () => {
  const frames = [
    { i: 1, file: 'a.png', atMs: 1000, ok: true },
    { i: 2, file: 'b.png', atMs: 4000, ok: true },
    { i: 3, file: 'c.png', atMs: 9000, ok: true },
  ];
  const s = burstSummary(frames, { startedAtMs: 1000, requestedMs: 800, run: { startedAtMs: 1000, endedAtMs: 5000 } });
  assert(s.frames.map((f) => f.inRun).join(',') === 'true,true,false', '逐张 inRun 不对：' + JSON.stringify(s.frames.map((f) => f.inRun)));
  assert(s.inRunCount === 2 && s.outsideCount === 1, '汇总数不对：' + JSON.stringify({ i: s.inRunCount, o: s.outsideCount }));
  assert(s.runWindow && s.runWindow.endedAtMs === 5000, '没回传本局窗口：' + JSON.stringify(s.runWindow));
  // C2：这三项**不许退化**（本轮就是靠它们算清「为什么拍不到」的）
  assert(s.measuredIntervalMs === 4000 && s.spanMs === 8000, 'measuredIntervalMs/spanMs 退化：' + JSON.stringify({ m: s.measuredIntervalMs, sp: s.spanMs }));
  assert(/别当证据/.test(s.note || ''), 'note 没提醒「窗口外的图别当证据」：' + s.note);
  const none = burstSummary([{ i: 1, file: 'a.png', atMs: 1000, ok: true }], { startedAtMs: 1000, requestedMs: 800 });
  assert(none.frames[0].inRun === null && none.inRunCount === 0, '没窗口时应当 null（不猜）：' + JSON.stringify(none.frames[0]));
  return 'C1 逐张 inRun（2 内 1 外）+ C2 的 4000ms 帧距与 8000ms 跨度都在';
});

await check('C1 参数面：`shot` 声明了 startAfterSec / untilGone，且 dryRun 计划会把它们回出来', async () => {
  const props = shotTool.parameters.properties;
  assert(props.startAfterSec && props.untilGone, '没声明新参数：' + JSON.stringify(Object.keys(props)));
  assert(/untilGone/.test(shotTool.description) && /startAfterSec/.test(shotTool.description), 'description 没写这两个旋钮');
  assert(/inRun/.test(shotTool.description), 'description 没写逐张 inRun');
  const plan = await shotTool.execute({ op: 'burst', dryRun: true, awaitPlaytest: false, startAfterSec: 2, untilGone: true, count: 3 }, {});
  assert(plan.ok && plan.dryRun === true && plan.untilGone === true && plan.startAfterSec === 2,
    'dryRun 没把新参数回出来：' + JSON.stringify({ u: plan.untilGone, s: plan.startAfterSec }));
  return 'dryRun 回执带 startAfterSec=2 / untilGone=true（一张都没拍）';
});

/* ================================================================== D1 · op=arm 的参数面 */

/*
 * D1 的「等开跑 → 按秒点抓拍」要靠人去点试玩，自动化测不了**端到端**；
 * 这里钉住的是**能被钉住的那部分**：op 存在、参数面齐全、秒点会被规整成升序去重、并且
 * 「一张都拍不出来」时不会假装成功（超时如实回 hit:false）。
 */
await check('D1 `playtest op=arm` 声明齐全（op / afterSec 数组 / target），并能被调用', async () => {
  const p = playtestTool.parameters.properties;
  assert(p.op.enum.includes('arm'), 'op 枚举里没有 arm：' + JSON.stringify(p.op.enum));
  /*
   * ★ `afterSec` 要**同时**接数字（op=wait）与数组（op=arm）。
   *   而 DSH 的工具 schema **子集只收单个 `type` 字符串** —— `type:['number','array']` 会在注册期被拒
   *   （真实校验器的原话：`type arrays are not supported`）。这里钉住「不许用类型数组」这条约束
   *   （用子集支持的 `oneOf` 表达 union），免得以后有人顺手写回 `type: [...] ` 而**只有在真机上才炸**。
   */
  assert(!Array.isArray(p.afterSec.type), '`afterSec.type` 不能是数组（DSH 子集不支持）：' + JSON.stringify(p.afterSec.type));
  assert(Array.isArray(p.afterSec.oneOf) && p.afterSec.oneOf.length === 2, 'afterSec 应当用 oneOf 表达「数字或数组」：' + JSON.stringify(p.afterSec));
  assert(p.afterSec.oneOf.some((b) => b.type === 'array') && p.afterSec.oneOf.some((b) => b.type === 'number'),
    'oneOf 的两支不是「数字 + 数组」：' + JSON.stringify(p.afterSec.oneOf));
  assert(p.target && p.process, '缺 target / process：' + JSON.stringify(Object.keys(p)));
  assert(/op=arm/.test(playtestTool.description) && /武装后台截图/.test(playtestTool.description), 'description 没写 arm');
  // 造一个「等不到开跑」的场景：op=arm 必须如实回 hit:false 而不是假装拍到
  const empty = fakeLevel({ levelId: '1073741905', outputLog: '[2026-09-25 10:00:00.000] 什么都没发生\n' });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = empty.root;
  try {
    const r = await playtestTool.execute({ op: 'arm', level: '1073741905', afterSec: [1, 2], timeoutSec: 5, pollMs: 100 }, {});
    assert(r.ok && r.hit === false && r.timedOut === true, '等不到开跑时没说 hit:false：' + JSON.stringify({ ok: r.ok, hit: r.hit, t: r.timedOut }));
    assert(Array.isArray(r.shots) && r.shots.length === 0, '一张都没拍却回了 shots：' + JSON.stringify(r.shots));
    assert(/一张都没拍/.test(r.hint || ''), 'hint 没说清「一张都没拍」：' + r.hint);
    return '超时：hit:false / shots:[] / hint 明说一张都没拍';
  } finally { process.env.MILIASTRA_LOCALLOW = prev; }
});

/* ================================================================== B3 · 模拟器 PNG 到底画不画客户端控件 */

/*
 * 修之前为什么「红」（其实是**工具说错了话**）：`miliastra_sim` 的说明里有一句
 * 「PNG 渲染**不含客户端控件层**」—— 实测（2026-09-25，本机）**这句是错的**：
 * 脚本 `InstantiateClientUIControl` 建的控件会画进 PNG，连「挂在客户端控件模板上的脚本再建的子控件」也在。
 * 所以撤掉那句免责句，改用这条回归把它钉住（也顺便挡住「以后真的退化了」）。
 */
await check('B3 回归：`op=shot target=play` 的 PNG **画得到脚本建的客户端控件**（旧的免责句是错的）', async () => {
  const srv = path.join(tmpRoot, 'b3-server.lua');
  const cli = path.join(tmpRoot, 'b3-client.lua');
  fs.writeFileSync(srv, [
    'function OnStart()',
    '  print("FB3_B3_SERVER")',
    '  local a = game.InstantiateClientUIControl(1073741868, script.object)',
    '  if a then a:SetSizeDelta(900, 500); a:SetAnchoredPosition(0, 0); a.imageColor = Color.FromRGBA(255, 0, 0, 255) end',
    'end',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(cli, [
    'function OnStart()',
    '  print("FB3_B3_CLIENT")',
    '  local b = game.InstantiateClientUIControl(1073741867, script.object)',
    '  if b then b:SetSizeDelta(600, 120); b:SetAnchoredPosition(0, 0); b.text = "FB3"; b.bgColor = Color.FromRGBA(0, 0, 255, 255) end',
    'end',
    '',
  ].join('\n'), 'utf8');
  await simOp({ op: 'reset' });
  const bound = await simOp({
    op: 'bind', run: false,
    scripts: [{ path: 'b3-server.lua', sourceFrom: srv }],
    templates: [{ guid: 1073741868, kind: 'image', name: '图片模板' }, { guid: 1073741867, kind: 'textbox', name: '文本框模板' }],
  });
  const tpl = bound.templates.find((t) => t.guid === 1073741868);
  await simOp({
    op: 'patch',
    patch: { op: 'addScript', controlId: String(tpl.id), controlAsset: 'client-control-template', path: 'b3-client.lua', source: fs.readFileSync(cli, 'utf8') },
  });
  await simOp({ op: 'play', action: 'start', args: { canvasId: 'pc-16-9' } });
  for (let i = 0; i < 30; i += 1) await simOp({ op: 'play', action: 'step', args: { dt: 1 / 30, light: true } });
  const got = await simOp({ op: 'play', action: 'get', args: { view: true, compact: true, inspect: true } });
  const texts = (got.logs || []).map((l) => l.text || '');
  assert(texts.some((t) => /FB3_B3_SERVER/.test(t)), '服务器侧脚本没跑：' + JSON.stringify(texts));
  assert(texts.some((t) => /FB3_B3_CLIENT/.test(t)), '挂在客户端控件模板上的脚本没跑：' + JSON.stringify(texts));
  const shot = await simOp({ op: 'shot', target: 'play', label: 'fb3-client-layer' });
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  // ⚠️ `op=shot` 的 `file` 是**绝对路径**（writePng 返回 `path.join(dir, name)`），别再拼一次 dir
  const img = await loadImage(fs.readFileSync(shot.file));
  const cv = createCanvas(img.width, img.height);
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  // 两张控件叠在正中：红图 900×500（服务器脚本建）、蓝图 600×120 盖在正中（**模板上的客户端脚本**建）
  const center = cx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
  const upper = cx.getImageData(Math.floor(img.width / 2), Math.floor(img.height * 0.25), 1, 1).data;
  assert(upper[0] > 200 && upper[1] < 60, 'PNG 里没画到服务器脚本建的红色图片控件（25% 高处 rgba(' + [...upper].join(',') + ')）');
  assert(center[2] > 200 && center[0] < 60, 'PNG 里没画到客户端脚本建的蓝色文本框（中心 rgba(' + [...center].join(',') + ')）');
  await simOp({ op: 'play', action: 'stop' });
  return '两层都在图里：25% 高处是红图控件 rgba(' + [...upper].join(',') + ')，正中是客户端脚本建的蓝框 rgba(' + [...center].join(',') + ')';
});

await check('B3 说明已改写：不再出现「不含客户端控件层」这种断言，改说清「哪些在图里」', async () => {
  const simTool = TOOLS.find((t) => t.name === 'miliastra_sim');
  assert(!/PNG 渲染不含「客户端控件层」/.test(simTool.description), '旧免责句还在：' + simTool.description.slice(-400));
  assert(/PNG 里有脚本建的客户端控件/.test(simTool.description), '没写清「PNG 里有脚本建的客户端控件」：' + simTool.description.slice(-400));
  assert(/都会画进图/.test(simTool.description), '没写清「都会画进图」：' + simTool.description.slice(-400));
  assert(/自己那棵树/.test(simTool.description), '没写清「哪种东西不在图里」');
  return '旧断言已撤，替换为「PNG 里有脚本建的客户端控件 / 都会画进图 / 只有模板工程自己那棵树不在」';
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
