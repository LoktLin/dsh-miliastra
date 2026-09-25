/**
 * 活文件定位 + 地图快照对账的自测（① 与 ② 两个 P0 的回归）。
 *
 * 背景（2026-09-25 同事实测报的）：
 *   ① 一个关卡可以有**多个**活文件（不同角色 / 模块各挂一个脚本），而「哪个才是当前文件」原来靠
 *      `index.js` 里一条**关键字启发式**（`/双相|测试|main|levelScript/`，命中即返回）——
 *      他的目录里 `game_01.lua`（真正挂载的）/ `测试.lua`（最旧）/ `背景图片.lua`（刚部署）时，
 *      它稳定选中 `测试.lua`：`op=inspect` 体检了最旧那个、`reconcile` 拿它的快照去比别人的文件，
 *      还给出「地图里嵌的还是旧版，先别急着试玩」这种**反向假告警**。
 *   ② 同一个病在 `reconcileWithGil` / `miliastra_map op=script` 上：拿**地图里嵌的**哈希与
 *      **另一个脚本**的活文件比 → 「match: true」的假安心，或「先别急着试玩」的假告警。
 *
 * 这个测试分两层：
 *   · **纯函数**：`rankLuaFiles`（排序 / 选择的唯一实现）与 `compareScriptSnapshot`（能不能比）；
 *   · **集成**：在**临时目录**里造一棵假的 LocalLow（含一个**合成 `.gil`**，脚本映射指向 `game_01.lua`），
 *     把 `MILIASTRA_LOCALLOW` 指过去，直接调真工具的 `execute` —— 不动真实存档、不动活文件。
 *
 * 用法：node tests/locate-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../index.js';
import { rankLuaFiles, pickLuaFile, isAuxiliaryLuaName } from '../lib/codefile.mjs';
import { compareScriptSnapshot, sameScriptName } from '../lib/gil.mjs';

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

/* ------------------------------------------------------------------ 合成 .gil */

/* 只造 `readGil` 真会读的那几个字段：#1 关卡 ID / #2 名字 / #39 账号 / #43 版本 /
 * #50 →#1 →{#1 映射索引, #2 脚本名, #3 文件名, #5 源码全文}。 */
const pbVarint = (n) => {
  const out = [];
  let v = Number(n);
  do {
    let x = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) x |= 0x80;
    out.push(x);
  } while (v > 0);
  return Buffer.from(out);
};
const pbKey = (no, wt) => pbVarint(no * 8 + wt);
const pbBytes = (no, buf) => Buffer.concat([pbKey(no, 2), pbVarint(buf.length), buf]);
const pbStr = (no, s) => pbBytes(no, Buffer.from(s, 'utf8'));
const pbNum = (no, n) => Buffer.concat([pbKey(no, 0), pbVarint(n)]);
/** 合成一份 .gil：[20 字节包头（16 处 = 主体长度 BE32）] + protobuf + [4 字节尾]。 */
function makeGil({ levelId, name, account, version, scriptName, scriptFile, source }) {
  const inner = Buffer.concat([
    pbNum(1, 1073741825), pbStr(2, scriptName), pbStr(3, scriptFile), pbBytes(5, source),
  ]);
  const body = Buffer.concat([
    pbNum(1, levelId), pbStr(2, name), pbNum(39, account), pbStr(43, version),
    pbBytes(50, pbBytes(1, inner)),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
}

/* ------------------------------------------------------------------ ① 纯函数 */

/* 同事那台机器上的三个文件（mtime：测试最旧 / game_01 中间 / 背景图片最新） */
const T_OLD = Date.parse('2026-09-01T10:00:00Z');
const T_MID = Date.parse('2026-09-02T10:00:00Z');
const T_NEW = Date.parse('2026-09-03T10:00:00Z');
const fileOf = (name, size, mtimeMs) => ({ name, size, mtimeMs, mtime: new Date(mtimeMs).toISOString() });
const threeFiles = () => [
  fileOf('测试.lua', 21591, T_OLD),
  fileOf('game_01.lua', 114035, T_MID),
  fileOf('背景图片.lua', 20480, T_NEW),
];

await check('★ rankLuaFiles：GIL 指向谁就选谁（**不许**因为名字里带「测试」就选最旧的那个）', () => {
  const r = rankLuaFiles(threeFiles(), { mountedName: 'game_01.lua' });
  assert(r.picked && r.picked.name === 'game_01.lua', '按 GIL 挂载名选错了：' + (r.picked && r.picked.name));
  assert(r.pickedBy === 'gil', 'pickedBy 应当是 gil，实际 ' + r.pickedBy);
  assert(r.picked.name !== '测试.lua', '还是选中了「测试.lua」—— 关键字启发式的老毛病');
  assert(r.candidates.length === 3, '候选数不对：' + r.candidates.length);
  assert(r.candidates[0].name === '背景图片.lua' && r.candidates[2].name === '测试.lua',
    '候选没按 mtime 倒序（看不出「为什么是它」）：' + r.candidates.map((c) => c.name).join(','));
  assert(r.candidates.every((c) => typeof c.bytes === 'number' && typeof c.mtime === 'string'),
    '候选缺 name/bytes/mtime 三件套：' + JSON.stringify(r.candidates[0]));
  assert(/地图存档里嵌的脚本名/.test(r.note), '没说明「凭什么是它」：' + r.note);
  return `选中 ${r.picked.name}（pickedBy=gil），候选 ${r.candidates.map((c) => c.name).join(' > ')}`;
});

await check('★ rankLuaFiles：拿不到 GIL 时退到 mtime 最新，且 pickedBy 如实标 mtime', () => {
  for (const mountedName of [null, '', [], ['']]) {
    const r = rankLuaFiles(threeFiles(), { mountedName });
    assert(r.picked && r.picked.name === '背景图片.lua', '没退到最近改动：' + (r.picked && r.picked.name));
    assert(r.pickedBy === 'mtime', 'pickedBy 应当是 mtime，实际 ' + r.pickedBy);
    assert(r.mountedName === null, '没拿到挂载名却报了一个：' + r.mountedName);
  }
  return 'mtime 最新 = 背景图片.lua（pickedBy=mtime）';
});

await check('rankLuaFiles：挂载名对不上时退 mtime，并在 note 里说清「对不上」', () => {
  const r = rankLuaFiles(threeFiles(), { mountedName: '不存在的脚本.lua' });
  assert(r.picked.name === '背景图片.lua' && r.pickedBy === 'mtime', '对不上时的兜底不对：' + JSON.stringify({ n: r.picked.name, by: r.pickedBy }));
  assert(/对不上/.test(r.note), '没说明「挂载名对不上」：' + r.note);
  return r.note;
});

await check('rankLuaFiles：GIL 的 name 不带 .lua 后缀也认（实测 name:"双相" / file:"双相.lua"）', () => {
  const files = [fileOf('双相.lua', 100, T_MID), fileOf('别的.lua', 200, T_NEW)];
  const r = rankLuaFiles(files, { mountedName: '双相' });
  assert(r.picked.name === '双相.lua' && r.pickedBy === 'gil', '不带后缀的挂载名没认出来：' + JSON.stringify({ n: r.picked.name, by: r.pickedBy }));
  return '两个候选（双相 / 双相.lua）都试，命中即用';
});

await check('rankLuaFiles：附属文件（探针源码 / 备份 / 隐藏文件）一律不参选', () => {
  const files = [
    ...threeFiles(),
    fileOf('_探针_ping_P1_20260903-120000.lua', 999, T_NEW + 1000),
    fileOf('双相.20260903-120000_备份.lua', 998, T_NEW + 2000),
    fileOf('双相.bak', 997, T_NEW + 3000),
    fileOf('.hidden.lua', 996, T_NEW + 4000),
  ];
  for (const n of ['_探针_x.lua', '双相.bak', '双相.20260101-000000_备份.lua', '.hidden.lua']) {
    assert(isAuxiliaryLuaName(n), '前置条件不成立：' + n + ' 没被判成附属文件');
  }
  const r = rankLuaFiles(files, { mountedName: 'game_01.lua' });
  assert(r.picked.name === 'game_01.lua', '附属文件被算进来了：' + r.picked.name);
  assert(r.candidates.length === 3, '候选里混进了附属文件：' + r.candidates.map((c) => c.name).join(','));
  const latest = rankLuaFiles(files, { mountedName: null });
  assert(latest.picked.name === '背景图片.lua', '附属文件抢走了「最近改动」：' + latest.picked.name);
  return '4 个附属文件都不参选（探针 / 历史备份 / 固定名备份 / 隐藏文件）';
});

await check('★ pickLuaFile 与 rankLuaFiles **同源**：同一目录、同一结果（两套「当前活文件」不再各说各话）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-pick-'));
  try {
    const files = threeFiles();
    for (const f of files) {
      fs.writeFileSync(path.join(d, f.name), '-- ' + f.name + '\n', 'utf8');
      const t = new Date(f.mtimeMs / 1000);
      fs.utimesSync(path.join(d, f.name), t, t);
    }
    // 附属文件要用 **.lua 结尾**的那种（pickLuaFile 只看 .lua，「双相.bak」连扫描都进不去）
    const aux = '双相.20260903-120000_备份.lua';
    fs.writeFileSync(path.join(d, aux), '-- 备份\n', 'utf8');
    const picked = pickLuaFile(d);
    const ranked = rankLuaFiles(files);
    assert(picked && picked.name === ranked.picked.name, '两处选的不一样：' + (picked && picked.name) + ' vs ' + ranked.picked.name);
    assert(picked.name === '背景图片.lua', 'pickLuaFile 不再返回「最近改动」：' + picked.name);
    assert(picked.skippedAuxiliary.length === 1 && picked.skippedAuxiliary[0] === aux, '没报告跳过的附属文件：' + JSON.stringify(picked.skippedAuxiliary));
    return 'pickLuaFile=' + picked.name + '，与 rankLuaFiles 一致，且跳过 1 个附属文件';
  } finally {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ------------------------------------------------------------------ ② 纯函数 */

await check('★ compareScriptSnapshot：同名 → 按哈希正常判（一致 / 不一致都给结论）', () => {
  const embedded = { name: '双相', file: '双相.lua', sourceBytes: 11, sourceSha256: 'AAA' };
  const same = compareScriptSnapshot({ embedded, live: { name: '双相.lua', sha256: 'AAA', size: 11 } });
  assert(same.comparable === true && same.match === true && same.skipped === null, '同名同哈希没判成一致：' + JSON.stringify(same));
  assert(/可以试玩|一致/.test(same.conclusion), '结论不对：' + same.conclusion);
  const diff = compareScriptSnapshot({ embedded, live: { name: '双相.lua', sha256: 'BBB', size: 11 } });
  assert(diff.comparable === true && diff.match === false, '同名不同哈希没判成不一致：' + JSON.stringify(diff));
  // GIL 只给了 name（没有 file）也要能对上
  const byName = compareScriptSnapshot({ embedded: { name: '双相', sourceSha256: 'AAA' }, live: { name: '双相.lua', sha256: 'AAA' } });
  assert(byName.comparable === true && byName.match === true, '只有 name 时对不上：' + JSON.stringify(byName));
  return '同名一致 / 同名不一致 / GIL 只有 name 三种都对';
});

await check('★ compareScriptSnapshot：不同名 → **不比**（哪怕内容恰好同哈希，也不许报 match: true）', () => {
  // 这正是「假安心」那条：两个不相干的文件恰好同内容时，旧逻辑会报 match: true
  const r = compareScriptSnapshot({
    embedded: { name: 'game_01', file: 'game_01.lua', sourceSha256: 'AAA', sourceBytes: 10 },
    live: { name: '测试.lua', sha256: 'AAA', size: 10 },
  });
  assert(r.comparable === false, '不同名竟然还判了：' + JSON.stringify(r));
  assert(r.match === null, '不同名时 match 必须是 null（不是 false —— 那也是一种结论）：' + r.match);
  assert(/另一个脚本/.test(r.skipped) && /game_01\.lua/.test(r.skipped) && /测试\.lua/.test(r.skipped), 'skipped 没点名两个脚本：' + r.skipped);
  assert(!/先别急着试玩/.test(r.conclusion) && !/先别急着试玩/.test(r.skipped), '不该带「先别急着试玩」这类行动建议：' + r.conclusion);
  assert(/先确认哪个才是你正在改的/.test(r.conclusion), '没给「该做什么」：' + r.conclusion);
  return r.skipped;
});

await check('compareScriptSnapshot：GIL 没给名字 / 没有活文件 / 地图没脚本记录，都如实说「不比」', () => {
  const noName = compareScriptSnapshot({ embedded: { sourceSha256: 'AAA' }, live: { name: 'x.lua', sha256: 'AAA' } });
  assert(noName.comparable === true && noName.match === true, 'GIL 没给名字时应当按哈希判（与既有行为一致）：' + JSON.stringify(noName));
  const noLive = compareScriptSnapshot({ embedded: { name: 'a', file: 'a.lua', sourceSha256: 'AAA' }, live: null });
  assert(noLive.comparable === false && noLive.match === null && /没有可比的本地活文件/.test(noLive.skipped), '没活文件时说法不对：' + JSON.stringify(noLive));
  const noEmb = compareScriptSnapshot({ embedded: null, live: { name: 'a.lua', sha256: 'AAA' } });
  assert(noEmb.comparable === false && /没有脚本映射记录/.test(noEmb.skipped), '地图没脚本记录时说法不对：' + JSON.stringify(noEmb));
  return '三种「比不了」都明确说清';
});

await check('sameScriptName：忽略目录与 .lua 后缀、忽略大小写', () => {
  assert(sameScriptName('双相', '双相.lua'), 'name 不带后缀时没认成同一个');
  assert(sameScriptName('external_lua_file/Game_01.LUA', 'game_01.lua'), '路径与大小写没归一');
  assert(!sameScriptName('game_01.lua', '测试.lua'), '不同名被认成同一个');
  assert(!sameScriptName('', 'x.lua') && !sameScriptName('a.lua', ''), '空名不该算同一个');
  return '双相==双相.lua / 路径+大小写归一 / 不同名不等';
});

/* ------------------------------------------------------------------ 集成：假 LocalLow */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-locate-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedBak = process.env.MILIASTRA_BACKUP_DIR;

const saveRoot = path.join(tmp, 'miHoYo', '原神', 'BeyondLocal', '201170108', 'Beyond_Local_Save_Level', '1073741833');
const luaDir = path.join(saveRoot, 'external_lua_file');
fs.mkdirSync(luaDir, { recursive: true });

const GAME_SRC = '-- game_01\nlocal LEVELS = { { name = "第1关", plats = { { 0, 0, 10, 10, 0 } } } }\nreturn 1\n';
const BG_SRC = '-- 背景图片\nlocal background = "图片"\nreturn 2\n';
const TEST_SRC = '-- 测试\nlocal b = 2\n';
const writeLua = (name, text, t) => {
  const p = path.join(luaDir, name);
  fs.writeFileSync(p, text, 'utf8');
  const at = new Date(t / 1000);
  fs.utimesSync(p, at, at);
};
writeLua('测试.lua', TEST_SRC, T_OLD);
writeLua('game_01.lua', GAME_SRC, T_MID);
writeLua('背景图片.lua', BG_SRC, T_NEW);
fs.writeFileSync(path.join(saveRoot, '1073741833.gil'), makeGil({
  levelId: 1073741833, name: '冰火', account: 201170108, version: '7.1.0',
  scriptName: 'game_01', scriptFile: 'game_01.lua', source: Buffer.from(GAME_SRC, 'utf8'),
}));

process.env.MILIASTRA_LOCALLOW = path.join(tmp, 'miHoYo');
process.env.MILIASTRA_BACKUP_DIR = path.join(tmp, 'backups');   // 别写进任何真实备份目录

const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');

await check('★ 集成：op=inspect（不带 file）→ 选 **GIL 里嵌的那个**，不是最旧的「测试.lua」', async () => {
  const r = await codeTool.execute({ op: 'inspect' }, {});
  assert(r.ok, 'inspect 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.pickedBy === 'gil', 'pickedBy 应当是 gil，实际 ' + r.pickedBy);
  assert(r.selectedFile === 'game_01.lua', '选中的不是 GIL 里嵌的那个：' + r.selectedFile);
  assert(r.inspected.path.endsWith('game_01.lua'), '体检的不是选中的那个文件：' + r.inspected.path);
  assert(r.mountedName === 'game_01.lua' || r.mountedName === 'game_01', '没报出 GIL 的挂载名：' + r.mountedName);
  assert(Array.isArray(r.candidates) && r.candidates.length === 3, 'candidates 不对：' + JSON.stringify(r.candidates));
  assert(r.candidates.some((c) => c.name === '测试.lua'), '候选里应当能看到「测试.lua」（透明，但不选它）');
  return `selectedFile=${r.selectedFile} pickedBy=${r.pickedBy} 候选=${r.candidates.map((c) => c.name).join(' > ')}`;
});

await check('★ 集成：op=inspect 显式 file → pickedBy=explicit（显式优先，未被 GIL 规则挤掉）', async () => {
  const r = await codeTool.execute({ op: 'inspect', file: '测试.lua' }, {});
  assert(r.pickedBy === 'explicit', 'pickedBy 应当是 explicit，实际 ' + r.pickedBy);
  assert(r.selectedFile === '测试.lua' && r.inspected.path.endsWith('测试.lua'), '没按显式 file 走：' + r.selectedFile);
  return 'file=测试.lua → pickedBy=explicit';
});

await check('★ 集成：miliastra_map op=script → 比的是 GIL 里嵌的那个活文件（不再是「碰巧同内容」的假 match）', async () => {
  const r = await mapTool.execute({ op: 'script' }, {});
  assert(r.ok, 'op=script 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.pickedBy === 'gil' && r.selectedFile === 'game_01.lua', '没选中 GIL 那个：' + JSON.stringify({ by: r.pickedBy, f: r.selectedFile }));
  assert(r.embedded && r.embedded.file === 'game_01.lua' && r.embedded.name === 'game_01', 'embedded 没报出名字/文件：' + JSON.stringify(r.embedded));
  assert(r.match === true && r.skipped === null, '同名同内容应当判一致：' + JSON.stringify({ match: r.match, skipped: r.skipped }));

  // 显式指定**另一个**脚本 → 必须 skipped（不许拿两份不相干的哈希判「match: true」）
  const other = await mapTool.execute({ op: 'script', file: '测试.lua' }, {});
  assert(other.match === null && other.skipped && /另一个脚本/.test(other.skipped),
    '比另一个脚本时没 skipped：' + JSON.stringify({ match: other.match, skipped: other.skipped }));
  assert(!/先别急着试玩/.test(JSON.stringify(other)), '回执里还带着「先别急着试玩」这类行动建议');
  return '默认比 GIL 那个（一致）/ 指定别的脚本 → skipped 且无行动建议';
});

await check('★ 集成：deploy 另一个脚本 → reconcile.skipped（**不含**「先别急着试玩」）+ 指纹按名索引', async () => {
  const srcFile = path.join(tmp, 'src-背景图片.lua');
  fs.writeFileSync(srcFile, BG_SRC, 'utf8');
  const r = await codeTool.execute({ op: 'deploy', file: '背景图片.lua', source: srcFile }, {});
  assert(r.ok, 'deploy 失败：' + JSON.stringify(r.errors || r).slice(0, 240));
  assert(r.pickedBy === 'explicit' && r.selectedFile === '背景图片.lua', 'deploy 的目标文件不对：' + JSON.stringify({ by: r.pickedBy, f: r.selectedFile }));
  // ② 跨脚本对账：必须 skipped，并说清地图快照属于谁
  assert(r.reconcile && r.reconcile.skipped, '跨脚本时 reconcile 应当 skipped：' + JSON.stringify(r.reconcile).slice(0, 200));
  assert(r.reconcile.match === null, '跨脚本时 match 必须是 null：' + r.reconcile.match);
  assert(r.reconcile.embedded && r.reconcile.embedded.file === 'game_01.lua', 'embedded 没点明是谁的快照：' + JSON.stringify(r.reconcile.embedded));
  assert(/game_01\.lua/.test(r.reconcile.skipped) && /背景图片\.lua/.test(r.reconcile.skipped), 'skipped 没点名两个脚本：' + r.reconcile.skipped);
  // ★ 整条回执里都不许再出现那句假告警（结论 + nextStep 都算）
  assert(!/先别急着试玩/.test(JSON.stringify(r)), '回执里还带着「先别急着试玩」这类行动建议');
  assert(/对不上/.test(r.nextStep || '') && /miliastra_health/.test(r.nextStep || ''), 'nextStep 没说该做什么：' + r.nextStep);
  // ③ 指纹按文件名索引（`pathByName` 是这次写的、之后 inspect 会读的那份；`path` 仍是旧版单份，兼容保留）
  const fpPath = r.deployFingerprint && r.deployFingerprint.pathByName;
  assert(fpPath && fpPath.includes('背景图片.lua') && path.basename(fpPath).startsWith('.miliastra-deploy.'),
    '指纹没按文件名索引：' + fpPath);
  assert(r.deployFingerprint.path && path.basename(r.deployFingerprint.path) === '.miliastra-deploy.json',
    '旧版单份指纹没保留（兼容）：' + r.deployFingerprint.path);
  return 'reconcile.skipped（点明 game_01.lua）+ nextStep 指向 miliastra_health + 指纹按名索引';
});

await check('★ 集成：inspect 另一份活文件 → 指纹属于别的文件时**不判** changedSinceDeploy', async () => {
  const r = await codeTool.execute({ op: 'inspect', file: 'game_01.lua' }, {});
  assert(r.deploy, '没读到部署指纹：' + JSON.stringify(r.deploy));
  assert(r.deploy.fingerprintBelongsTo === '背景图片.lua', '没点明「指纹属于谁」：' + r.deploy.fingerprintBelongsTo);
  assert(r.deploy.comparedFile === 'game_01.lua', '没点明「本次比的是谁」：' + r.deploy.comparedFile);
  assert(r.deploy.foreignFingerprint === true, '跨文件却没标 foreignFingerprint：' + JSON.stringify(r.deploy).slice(0, 240));
  assert(r.deploy.changedSinceDeploy === null && r.deploy.sameAsDeploy === null,
    '跨文件竟然判了 changedSinceDeploy：' + JSON.stringify({ c: r.deploy.changedSinceDeploy, s: r.deploy.sameAsDeploy }));
  assert(/不据此判 changedSinceDeploy/.test(r.deploy.note || ''), '没解释为什么不判：' + r.deploy.note);
  // 自己那份文件（刚部署的 背景图片.lua）仍然正常判「一致」
  const own = await codeTool.execute({ op: 'inspect', file: '背景图片.lua' }, {});
  assert(own.deploy && own.deploy.sameAsDeploy === true && own.deploy.changedSinceDeploy === false,
    '自己那份文件没正常判「一致」：' + JSON.stringify(own.deploy && { c: own.deploy.changedSinceDeploy, s: own.deploy.sameAsDeploy }));
  return 'game_01.lua → foreign（不判）；背景图片.lua → 正常判「一致」';
});

/* ------------------------------------------------------------------ 收尾 */

process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW;
if (savedBak === undefined) delete process.env.MILIASTRA_BACKUP_DIR; else process.env.MILIASTRA_BACKUP_DIR = savedBak;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
