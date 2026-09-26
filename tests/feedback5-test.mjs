/**
 * 第五批反馈自测：2026-09-26 施工单的 P0-2 / P1-3 / P1-4 / P2-5
 *
 * 每条都写清「**修之前为什么红**」—— 这里的断言都是为了**将来某次改动时能重新变红**：
 *
 *   · **P1-4**：`brief:true` 的 `luaFiles` 原本只是**名字数组** ⇒ 看不出「刚建映射的活文件是 0 字节」，
 *     也看不出「这个文件压根没进 `.gil` 挂载集合」。修前这两个信息只能靠 `op=deploy` 的 `candidates[].bytes` 事后发现。
 *   · **P2-5**：往**新建的空脚本**里第一次 deploy 时，回执有 `dest` 但**没有任何字段**说"这是首次写入"，
 *     而"编辑器里忘了存盘"正是「部署了却什么都没发生」的根因。
 *   · **P0-2**：`staleLog` 口径只在 `miliastra_log` 上；`map op=script` 与 `health op=sha` 里的 `.gil` 那一列
 *     **是存盘快照、不是实时的**，却没有任何归属/新鲜度字段 ⇒ 容易把上一次存盘的内容当成本次结果。
 *   · **P1-3**：两个真机坑（`sanitize` 清复合模板 ⇒ 整卡不画；构建期实例化 ⇒ 不画）只能靠**踩坑人的记忆**传播，
 *     deploy/inspect 完全静态可判却不提。
 *
 * 全部用**合成假存档 / 假活文件**（`MILIASTRA_LOCALLOW` + `MILIASTRA_DATA_DIR` 指到临时目录），不碰真机。
 * 需要工作区真样例的那一条（P1-3 的改造前 `board_body.lua`）**找不到就如实说"不在本机"并改用合成夹具**。
 *
 * 用法：node tests/feedback5-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ⚠️ `MILIASTRA_DATA_DIR` 必须在 import 之前设好（sim.mjs 在模块初始化时读它）——所以下面全用动态 import。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fb5-'));
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
const { snapshotFreshness, localTimeText } = await import('../lib/freshness.mjs');
const { uiWarnings } = await import('../lib/uiwarn.mjs');

const health = TOOLS.find((t) => t.name === 'miliastra_health');
const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');

/* ------------------------------------------------------------------ 合成 protobuf / 假存档 */
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

/** 合成 `.gil`：脚本映射 `#50` + 挂载层级 `#6`（形状同 feedback3-test / 真机六脚本图）。 */
function makeGil({ levelId, name = '假图', account = 201170108, version = '7.1.0', scripts = [], mounts = [], withHierarchy = true }) {
  const recs = scripts.map((s) => pbBytes(1, Buffer.concat([
    pbNum(1, s.mappingId),
    pbStr(2, s.name),
    ...(s.file ? [pbStr(3, s.file)] : []),
    pbBytes(5, Buffer.from(s.source == null ? '-- x\n' : s.source, 'utf8')),
  ])));
  const parts = [pbNum(1, levelId), pbStr(2, name), pbNum(39, account), pbStr(43, version), pbBytes(50, Buffer.concat(recs))];
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

function fakeLevel({ brand = '原神', account = '201170108', levelId, gils = [], luas = {}, logs = {} }) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'low-'));
  const levelDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Local_Save_Level', levelId);
  const luaDir = path.join(levelDir, 'external_lua_file');
  fs.mkdirSync(luaDir, { recursive: true });
  for (const g of gils) fs.writeFileSync(path.join(levelDir, levelId + '.gil'), g);
  for (const [name, text] of Object.entries(luas)) fs.writeFileSync(path.join(luaDir, name), text, 'utf8');
  const logDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Debug_Log');
  if (Object.keys(logs).length) {
    fs.mkdirSync(logDir, { recursive: true });
    for (const [name, buf] of Object.entries(logs)) fs.writeFileSync(path.join(logDir, name), buf);
  }
  return { root, levelDir, luaDir, logDir };
}
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/* ================================================================== P1-4 · brief 带字节数 */

/*
 * 修之前为什么红：`brief:true` 的 `luaFiles` 是 `["HUD hud.lua", …]` —— 光看它**看不出**那个文件是 0 字节。
 * 创作者的场景是：编辑器里新建并挂了一个 `HUD hud.lua`，脚本还没写进去 ⇒ brief 里它和别的活文件长得一模一样。
 */
const b1 = fakeLevel({
  levelId: '1073741911',
  gils: [makeGil({
    levelId: 1073741911,
    scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua' }],
    mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }],
  })],
  luas: { 'game_01.lua': '-- x\n', '空脚本.lua': '', '没挂.lua': '-- z\n' },
});

await check('P1-4 ① brief 的 luaFiles = [{name, bytes}]，0 字节那个标 empty 并在 note 里点名', async () => {
  process.env.MILIASTRA_LOCALLOW = b1.root;
  const r = await health.execute({ brief: true }, {});
  assert(r.ok === true && r.brief === true, 'brief 没生效：' + JSON.stringify(r).slice(0, 160));
  assert(Array.isArray(r.luaFiles) && r.luaFiles.length === 3, 'luaFiles 不对：' + JSON.stringify(r.luaFiles));
  assert(r.luaFiles.every((f) => typeof f.name === 'string' && typeof f.bytes === 'number'),
    '每个元素必须是 {name, bytes}：' + JSON.stringify(r.luaFiles));
  const empty = r.luaFiles.find((f) => f.name === '空脚本.lua');
  assert(empty && empty.bytes === 0 && empty.empty === true, '0 字节没标出来：' + JSON.stringify(empty));
  assert(/空脚本/.test(r.note || '') && /空脚本\.lua/.test(r.note || ''), 'note 没点名 0 字节那个：' + r.note);
  return 'luaFiles=' + r.luaFiles.map((f) => f.name + ':' + f.bytes).join(' / ');
});

await check('P1-4 ② 不在 `.gil` 挂载集合里的活文件 → mounted:false 并在 note 里点名；mountKnown:true', async () => {
  const r = await health.execute({ brief: true }, {});
  assert(r.mountKnown === true, '挂载表读得到却不是 true：' + r.mountKnown);
  const notMounted = r.luaFiles.find((f) => f.name === '没挂.lua');
  assert(notMounted && notMounted.mounted === false, '没标出未挂载：' + JSON.stringify(notMounted));
  assert(/挂载集合/.test(r.note || '') && /没挂\.lua/.test(r.note || ''), 'note 没点名未挂载那个：' + r.note);
  // 挂上的那个**不许**被标成 false（假阴性比漏报更坏）
  const ok = r.luaFiles.find((f) => f.name === 'game_01.lua');
  assert(ok && !('mounted' in ok), '已挂载的活文件被标了 mounted 字段：' + JSON.stringify(ok));
  return 'note=' + r.note;
});

await check('P1-4 ③ 加了两类提示后，brief 回执仍 < 1024 B（它是"先调它"的入口）', async () => {
  const r = await health.execute({ brief: true }, {});
  const b = bytesOf(r);
  assert(b < 1024, 'brief 涨到 ' + b + ' B：' + JSON.stringify(r).slice(0, 200));
  return b + ' B（含 0 字节 + 未挂载两类提示）';
});

await check('P1-4 ④ .gil 挂载表读不到时**一个都不标**（mountKnown:false，不猜）', async () => {
  const b2 = fakeLevel({
    levelId: '1073741912',
    gils: [makeGil({ levelId: 1073741912, withHierarchy: false, scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua' }] })],
    luas: { 'game_01.lua': '-- x\n', '别的.lua': '-- y\n' },
  });
  process.env.MILIASTRA_LOCALLOW = b2.root;
  const r = await health.execute({ brief: true }, {});
  assert(r.mountKnown === false, '挂载表读不到却是 true：' + r.mountKnown);
  assert(r.luaFiles.every((f) => !('mounted' in f)), '读不到挂载表却标了 mounted：' + JSON.stringify(r.luaFiles));
  process.env.MILIASTRA_LOCALLOW = b1.root;
  return 'mountKnown=false，' + r.luaFiles.length + ' 个活文件一个都没标';
});

/* ================================================================== P2-5 · firstWrite */

async function deployTo(box, fileName, { sourceText = '-- 新内容\nlocal x = 1\n' } = {}) {
  const src = path.join(tmpRoot, 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.lua');
  fs.writeFileSync(src, sourceText, 'utf8');
  process.env.MILIASTRA_LOCALLOW = box.root;
  return await codeTool.execute({ op: 'deploy', source: src, file: fileName }, {});
}

/** P2-5 的夹具（两次断言共用同一个关卡，第二次才能验证"不是首次写入"）。 */
const hudBox = fakeLevel({
  levelId: '1073741913',
  gils: [makeGil({ levelId: 1073741913, scripts: [{ mappingId: 1073741825, name: 'HUD hud', file: 'HUD hud.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
  luas: { 'HUD hud.lua': '' },
});

await check('P2-5 ① 投进一个**0 字节**活文件 → firstWrite:true + destBeforeBytes:0 + 一句提示', async () => {
  const r = await deployTo(hudBox, 'HUD hud.lua');
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  assert(r.firstWrite === true && r.destBeforeBytes === 0, '没标首次写入：' + JSON.stringify({ f: r.firstWrite, b: r.destBeforeBytes }));
  assert(/首次写入/.test(r.firstWriteNote || '') && /存盘/.test(r.firstWriteNote || ''), '提示没说清「首次写入 + 存盘」：' + r.firstWriteNote);
  assert(fs.statSync(path.join(hudBox.luaDir, 'HUD hud.lua')).size > 0, '写了却还是 0 字节');
  return 'firstWrite=true，destBeforeBytes=0，note=' + r.firstWriteNote;
});

await check('P2-5 ② 覆盖**已有内容**的活文件 → firstWrite:false（不误报）', async () => {
  const r = await deployTo(hudBox, 'HUD hud.lua', { sourceText: '-- 第二版\nlocal y = 2\n' });
  assert(r.ok === true, '第二次部署失败：' + JSON.stringify(r.errors || r).slice(0, 160));
  assert(r.firstWrite === false && r.destBeforeBytes > 0, '不是首次写入却说成首次：' + JSON.stringify({ f: r.firstWrite, b: r.destBeforeBytes }));
  assert(r.firstWriteNote === null, '非首次写入不该带首写提示：' + r.firstWriteNote);
  return 'destBeforeBytes=' + r.destBeforeBytes + ' → firstWrite=false';
});

/* ================================================================== P0-2 · belongsTo / isCurrent */

/** P0-2 ③④ 共用的夹具（④ 要回到它上面再跑一次 `op=sha`）。 */
let shaBox = null;

await check('P0-2 ① 纯函数：两次存盘 + 读旧的那一次 → isCurrent:false，belongsTo 带**时间与 epoch**', () => {
  const save1 = Date.parse('2026-09-26T21:03:11');
  const save2 = Date.parse('2026-09-26T22:40:05');
  const readOld = snapshotFreshness({
    kind: '存盘快照', name: '1073741833.gil', atMs: save1,
    currentAtMs: save2, currentLabel: '活文件 表现 view.lua',
    what: '这份 .gil 存盘快照',
  });
  assert(readOld.isCurrent === false, '读旧的那一次却说 isCurrent:' + readOld.isCurrent);
  assert(readOld.known === true, '有证据却说不知道：' + JSON.stringify(readOld));
  assert(/1073741833\.gil/.test(readOld.belongsTo), 'belongsTo 没带文件名：' + readOld.belongsTo);
  assert(/2026-09-26 21:03:11/.test(readOld.belongsTo), 'belongsTo 没带本地时间：' + readOld.belongsTo);
  assert(readOld.belongsToEpochSec === Math.floor(save1 / 1000), 'belongsToEpochSec 不对：' + readOld.belongsToEpochSec);
  assert(/不是当前那一份/.test(readOld.note) && /存一次盘/.test(readOld.note), 'note 没给"该怎么办"：' + readOld.note);
  // 读**新的**那一次：必须说"是当前那一份"
  const readNew = snapshotFreshness({ kind: '存盘快照', name: '1073741833.gil', atMs: save2, currentAtMs: save2 });
  assert(readNew.isCurrent === true, '读最新的一次却说不是当前：' + JSON.stringify(readNew));
  return 'save1 → isCurrent=false（epochSec ' + readOld.belongsToEpochSec + '）；save2 → isCurrent=true';
});

await check('P0-2 ② 缺证据时**明说没有证据**：没有时间 / 没有对比基准 → isCurrent:null（不猜）', () => {
  const noTime = snapshotFreshness({ kind: '存盘快照', name: 'x.gil', atMs: null, currentAtMs: 1000 });
  assert(noTime.isCurrent === null && noTime.known === false, '没时间却判了：' + JSON.stringify(noTime));
  assert(/没有证据/.test(noTime.note), '没说"没有证据"：' + noTime.note);
  const noBase = snapshotFreshness({ kind: '存盘快照', name: 'x.gil', atMs: 1000, currentAtMs: null });
  assert(noBase.isCurrent === null && /没有对比基准/.test(noBase.note), '没有基准却判了：' + JSON.stringify(noBase));
  assert(localTimeText(0) === null || typeof localTimeText(0) === 'string', 'localTimeText 形状不对');
  return '两条都 isCurrent:null + 明说原因';
});

await check('P0-2 ③ 集成：`map op=script` 带 belongsTo/isCurrent —— `.gil` 比活文件旧 ⇒ false（并说去哪存盘）', async () => {
  const box = fakeLevel({
    levelId: '1073741914',
    gils: [makeGil({
      levelId: 1073741914,
      scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua', source: '-- old\n' }],
      mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }],
    })],
    luas: { 'game_01.lua': '-- 新内容（活文件比存盘快照新）\n' },
  });
  shaBox = box;
  process.env.MILIASTRA_LOCALLOW = box.root;
  // 夹具标定：把 .gil 的 mtime 钉在过去、活文件钉在现在（否则同一秒内建的两个文件分不出先后）
  const gilPath = path.join(box.levelDir, '1073741914.gil');
  const livePath = path.join(box.luaDir, 'game_01.lua');
  const t0 = Date.parse('2026-09-26T21:00:00');
  fs.utimesSync(gilPath, new Date(t0), new Date(t0));
  fs.utimesSync(livePath, new Date(t0 + 3600 * 1000), new Date(t0 + 3600 * 1000));
  const r = await mapTool.execute({ op: 'script', file: 'game_01.lua' }, {});
  assert(r.ok === true, 'op=script 失败：' + JSON.stringify(r).slice(0, 200));
  assert(/1073741914\.gil/.test(r.belongsTo || ''), 'belongsTo 没带 .gil 名：' + r.belongsTo);
  assert(r.isCurrent === false, '快照比活文件旧却说 isCurrent:' + r.isCurrent);
  assert(typeof r.belongsToEpochSec === 'number' && /存盘|存一次盘/.test(r.currentnessNote || ''),
    'currentnessNote 没给可执行的话：' + r.currentnessNote);
  // 反向：把 .gil 钉到活文件之后 ⇒ 必须说"是当前那一份"（防"永远报 stale"的假阳性）
  const t1 = t0 + 7200 * 1000;
  fs.utimesSync(gilPath, new Date(t1), new Date(t1));
  const r2 = await mapTool.execute({ op: 'script', file: 'game_01.lua' }, {});
  assert(r2.isCurrent === true, '快照更新却说不是当前：' + JSON.stringify({ b: r2.belongsTo, c: r2.isCurrent }));
  return '旧快照 isCurrent=false；新快照 isCurrent=true（belongsTo=' + r2.belongsTo + '）';
});

await check('P0-2 ④ 集成：`health op=sha` 与 `map op=script` **同一口径**（都带 belongsTo/isCurrent）', async () => {
  const r = await health.execute({ op: 'sha' }, {});
  assert(r.ok === true, 'op=sha 失败：' + JSON.stringify(r).slice(0, 200));
  assert(/\.gil/.test(r.belongsTo || ''), 'sha 没带 belongsTo：' + r.belongsTo);
  assert(r.isCurrent === true, '刚被钉到最新的 .gil 却说不是当前：' + JSON.stringify({ b: r.belongsTo, c: r.isCurrent }));
  assert(typeof r.belongsToEpochSec === 'number' && typeof r.currentnessNote === 'string', 'sha 缺 epoch/说明');
  // 没有 .gil 的关卡：必须**明说没有证据**，而不是给一个看起来像结论的旧值
  const noGil = fakeLevel({ levelId: '1073741915', luas: { 'game_01.lua': '-- x\n' } });
  process.env.MILIASTRA_LOCALLOW = noGil.root;
  const rNone = await health.execute({ op: 'sha' }, {});
  assert(rNone.ok === true, '没 .gil 时 op=sha 该如实回报而不是抛：' + JSON.stringify(rNone).slice(0, 160));
  assert(rNone.isCurrent === null || rNone.isCurrent === false, '没 .gil 却给了一个"当前"的结论：' + JSON.stringify({ c: rNone.isCurrent, b: rNone.belongsTo }));
  assert(/没有证据|没有对比基准|判断不了/.test(rNone.currentnessNote || ''), '没 .gil 时没明说判不了：' + rNone.currentnessNote);
  process.env.MILIASTRA_LOCALLOW = shaBox.root;
  return 'sha 与 script 同口径；无 .gil 时 isCurrent=' + rNone.isCurrent;
});

/* ================================================================== P1-3 · 已知坑 warnings */

/** 合成夹具：混着多种模板的集合 + 未加白名单的 sanitize（改造前 `board_body.lua` 的最小形状）。 */
const PIT_MIXED = [
  'local TEMPLATES = {',
  '  { name = "@单图", id = 1073742182 },',
  '  { name = "@复合", id = 1073742519 },',
  '}',
  'local function build()',
  '  for i, t in pairs(TEMPLATES) do',
  '    local node = game.InstantiateClientUIControl(t.id, ROOT)',
  '    sanitize(node, 1)',
  '  end',
  'end',
  '',
].join('\n');
/** 恢复白名单之后：同一个循环里，sanitize 被 `if … ~= "…" then` 收窄。 */
const PIT_WHITELISTED = PIT_MIXED.replace(
  '    sanitize(node, 1)',
  '    if t.name ~= "@复合" then\n      sanitize(node, 1)\n    end',
);

await check('P1-3 ① 纯函数：混合模板集合 + 未加白名单的 sanitize → 报 v2-sanitize-mixed-templates（带 file:line）', () => {
  const w = uiWarnings(PIT_MIXED, 'board.lua');
  const hit = w.find((x) => x.rule === 'v2-sanitize-mixed-templates');
  assert(hit, '没报出来：' + JSON.stringify(w));
  assert(hit.file === 'board.lua' && hit.line === 8 && hit.where === 'board.lua:8', 'file/line 不对：' + JSON.stringify(hit));
  assert(/可能/.test(hit.message) && /整卡不显示|不显示/.test(hit.message), 'message 没写清"可能是 / 后果"：' + hit.message);
  assert(/白名单/.test(hit.fix), 'fix 不是可执行的改法：' + hit.fix);
  assert(/iron-rules-visual-debug|docs\//.test(hit.doc), 'doc 没指向文档链：' + hit.doc);
  return hit.where + ' ' + hit.evidence.trim();
});

await check('P1-3 ② 纯函数：加了白名单 → 该条**消失**（不留噪音）', () => {
  const w = uiWarnings(PIT_WHITELISTED, 'board.lua').filter((x) => x.rule === 'v2-sanitize-mixed-templates');
  assert(w.length === 0, '加了白名单还在报：' + JSON.stringify(w));
  return 'v2-sanitize-mixed-templates = 0 条';
});

await check('P1-3 ③ 纯函数：构建循环里的 InstantiateClientUIControl → 报「试试挪到渲染第一帧」', () => {
  const w = uiWarnings(PIT_MIXED, 'board.lua').filter((x) => x.rule === 'instantiate-in-build-phase');
  assert(w.length === 1, '没报构建期实例化：' + JSON.stringify(w));
  assert(/第一帧/.test(w[0].fix) && /可能|试试|若/.test(w[0].message + w[0].fix), 'fix/message 不对：' + JSON.stringify(w[0]));
  return w[0].where + ' → ' + w[0].fix.slice(0, 30) + '…';
});

await check('P1-3 ④ 纯函数：**没有**模板表的普通循环（遍历子控件）不算"一批模板"（不制造噪音）', () => {
  const plain = [
    'local function sanitizeAll(node)',
    '  local kids = node:GetChildren()',
    '  for i = 1, #kids do',
    '    sanitize(kids[i], 1)',
    '  end',
    'end',
    '',
  ].join('\n');
  const w = uiWarnings(plain, 'x.lua');
  assert(w.length === 0, '把"遍历子控件"误判成"一批模板"：' + JSON.stringify(w));
  return '0 条（数字型循环 / sanitize 自己的递归都不报）';
});

/** 工作区那两份「改造前 / 恢复白名单后」的样例：优先用真文件；不在就用上面的合成夹具并**如实说明**。 */
const SAMPLE_BOARD_BEFORE = 'C:/Users/Administrator/Desktop/yuanshen/code/侦探1/_snapshots/20260926-200607/project/调查板 board.lua';
const SAMPLE_BOARD_AFTER = 'C:/Users/Administrator/Desktop/yuanshen/sources/侦探1/board_body.lua';
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const beforeExists = isFile(SAMPLE_BOARD_BEFORE);
const afterExists = isFile(SAMPLE_BOARD_AFTER);

await check('P1-3 ⑤ 集成：deploy 一份"含未加白名单 sanitize"的产物 → warnings[] 里有该 rule，且 **ok 不变**', async () => {
  const box = fakeLevel({
    levelId: '1073741916',
    gils: [makeGil({ levelId: 1073741916, scripts: [{ mappingId: 1073741825, name: 'board', file: 'board.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
    luas: { 'board.lua': '-- 旧内容\n' },
  });
  process.env.MILIASTRA_LOCALLOW = box.root;
  const src = path.join(tmpRoot, 'board-before.lua');
  fs.writeFileSync(src, beforeExists ? fs.readFileSync(SAMPLE_BOARD_BEFORE, 'utf8') : PIT_MIXED, 'utf8');
  const r = await codeTool.execute({ op: 'deploy', source: src, file: 'board.lua' }, {});
  assert(r.ok === true, '部署被拦了（这两条 warning 不该阻断）：' + JSON.stringify(r.errors || r).slice(0, 200));
  const pits = (r.warnings || []).filter((w) => w && typeof w === 'object' && w.rule === 'v2-sanitize-mixed-templates');
  assert(pits.length === 1, 'warnings 里没有该条：' + JSON.stringify(r.warnings));
  assert(/board-before\.lua:\d+/.test(pits[0].where || ''), 'where 不是 file:line：' + JSON.stringify(pits[0]));
  assert(r.knownPitCount >= 1 && /docs\/功能详解/.test(r.knownPitDoc || ''), '没回 knownPitCount/文档链：' + JSON.stringify({ c: r.knownPitCount, d: r.knownPitDoc }));
  // `ok` 语义不变：lint 正常就还是 true，errors 仍为空
  assert(r.errors.length === 0, 'errors 不该被这两条污染：' + JSON.stringify(r.errors));
  return (beforeExists ? '真样例 ' + path.basename(SAMPLE_BOARD_BEFORE) : '合成夹具（样例不在本机）')
    + ' → ' + pits[0].where + '（ok 仍为 true）';
});

await check('P1-3 ⑥ 集成：恢复白名单后的产物 → 该条**消失**；`op=inspect` 也带同一套 warnings', async () => {
  const box = fakeLevel({
    levelId: '1073741917',
    gils: [makeGil({ levelId: 1073741917, scripts: [{ mappingId: 1073741825, name: 'board', file: 'board.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
    luas: { 'board.lua': '-- 旧内容\n' },
  });
  process.env.MILIASTRA_LOCALLOW = box.root;
  const src = path.join(tmpRoot, 'board-after.lua');
  fs.writeFileSync(src, afterExists ? fs.readFileSync(SAMPLE_BOARD_AFTER, 'utf8') : PIT_WHITELISTED, 'utf8');
  const r = await codeTool.execute({ op: 'deploy', source: src, file: 'board.lua' }, {});
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  const pits = (r.warnings || []).filter((w) => w && typeof w === 'object' && w.rule === 'v2-sanitize-mixed-templates');
  assert(pits.length === 0, '恢复白名单后还在报：' + JSON.stringify(pits[0] && pits[0].where));
  const insp = await codeTool.execute({ op: 'inspect', file: 'board.lua' }, {});
  assert(insp.ok === true && Array.isArray(insp.warnings), 'inspect 没带 warnings 数组：' + JSON.stringify(Object.keys(insp)));
  assert(insp.warnings.every((w) => w && typeof w === 'object' && w.where && w.rule && w.fix && w.doc),
    'inspect 的 warnings 元素形状不对：' + JSON.stringify(insp.warnings));
  return (afterExists ? '真样例 ' + path.basename(SAMPLE_BOARD_AFTER) : '合成夹具（样例不在本机）')
    + ' → sanitize 告警 0 条；inspect 回 ' + insp.warnings.length + ' 条（对象，含 where/fix/doc）';
});

/* ------------------------------------------------------------------ 收尾 */
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
process.env.MILIASTRA_DATA_DIR = savedData === undefined ? '' : savedData;
process.env.MILIASTRA_BACKUP_DIR = savedBak === undefined ? '' : savedBak;

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
