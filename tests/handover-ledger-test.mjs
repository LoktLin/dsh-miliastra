/**
 * P2-8 交接值台账自测（合成假存档根 + 临时数据目录，**不碰真机**）。
 *
 * 钉住四件事（前三条是上一轮整块回退过的那道坎）：
 *   ① **没 set 过 ⇒ 语义不变**：缺交接值仍然 `ok:false` + `needsHandover[]`（绝不因为"有台账机制"就放行）；
 *   ② `set` 之后**自动带上**：`handoverFrom` 含 `ledger`，且 `handoverLedger[]` 给值 / 谁确认的 / 什么时候；
 *   ③ **台账按关卡分**：另一个关卡不受影响（不串号）；
 *   ④ **只有显式 set 会写盘**：一次"调用时传了"的调用**不落盘**（否则传错的号会被永久记下）。
 *
 * 用法：node tests/handover-ledger-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ` 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- 造两个假关卡（没有 .gil ⇒ 「自动拿」这一档必然拿不到，正是要测的入口） ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-ledger-'));
const LEVEL_A = '1073741911';
const LEVEL_B = '1073741912';
for (const lv of [LEVEL_A, LEVEL_B]) {
  const dir = path.join(tmpRoot, '原神', 'BeyondLocal', '999000999', 'Beyond_Local_Save_Level', lv, 'external_lua_file');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.lua'), '-- 占位\n', 'utf8');
}
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedData = process.env.MILIASTRA_DATA_DIR;
process.env.MILIASTRA_LOCALLOW = tmpRoot;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');

const { TOOLS } = await import('../index.js');
const { ledgerPath } = await import('../lib/handover-ledger.mjs');
const health = TOOLS.find((t) => t.name === 'miliastra_health');
const gen = TOOLS.find((t) => t.name === 'miliastra_gen');
const CONTAINER = 1073741846;
const TEMPLATE = 1073741849;

await check('① 没 set 过 ⇒ 缺交接值仍然 ok:false + needsHandover（语义没被台账改掉）', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, level: LEVEL_A });
  assert(r.ok === false, '竟然成功了：' + JSON.stringify(r).slice(0, 200));
  assert(Array.isArray(r.needsHandover) && r.needsHandover.length >= 2, 'needsHandover 不对：' + JSON.stringify(r.needsHandover));
  assert(!r.handoverLedger, '没 set 过却回了 handoverLedger');
  return r.missingParams ? 'missingParams=' + JSON.stringify(r.missingParams) : 'needsHandover ' + r.needsHandover.length + ' 项';
});

await check('② op=handover action=set 写盘（含「谁确认的 / 什么时候」）', async () => {
  const r = await health.execute({ op: 'handover', action: 'set', level: LEVEL_A, handover: { container: CONTAINER, imageTemplate: TEMPLATE, confirmedBy: 'creator' } });
  assert(r.ok === true, 'set 失败：' + JSON.stringify(r).slice(0, 200));
  eq(r.levelId, LEVEL_A, 'levelId');
  const file = ledgerPath();
  assert(fs.existsSync(file), '台账文件没落盘：' + file);
  const book = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cell = book.levels[LEVEL_A]['container'];
  assert(cell && cell.value === CONTAINER, 'container 没写对：' + JSON.stringify(cell));
  assert(/^\d{4}-\d\d-\d\dT/.test(cell.confirmedAt), 'confirmedAt 不是 ISO：' + cell.confirmedAt);
  eq(cell.confirmedBy, 'creator', 'confirmedBy');
  return '写了 ' + r.written.length + ' 项';
});

await check('③ set 之后**自动带上**：handoverFrom 含 ledger + handoverLedger[] 有出处', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, level: LEVEL_A });
  assert(r.ok === true, '还是失败：' + JSON.stringify(r).slice(0, 300));
  assert(String(r.handoverFrom || '').includes('ledger'), 'handoverFrom 没标 ledger：' + r.handoverFrom);
  assert(Array.isArray(r.handoverLedger) && r.handoverLedger.length === 2, 'handoverLedger 不是 2 项：' + JSON.stringify(r.handoverLedger));
  const roles = r.handoverLedger.map((x) => x.role).sort().join(',');
  eq(roles, 'container,template:image', 'roles');
  assert(r.handoverLedger.every((x) => x.confirmedBy === 'creator' && x.confirmedAt), '缺「谁 / 什么时候」');
  eq(r.target && r.target.container, CONTAINER, 'target.container 没接上');
  eq(r.target && r.target.templateIndex, TEMPLATE, 'target.templateIndex 没接上');
  return 'handoverFrom=' + r.handoverFrom;
});

await check('④ 台账**按关卡分**：另一个关卡不受影响（不串号）', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, level: LEVEL_B });
  assert(r.ok === false, 'B 关卡竟然也成功了（串号了）：' + JSON.stringify(r).slice(0, 200));
  assert(!r.handoverLedger, 'B 关卡回了 A 的台账');
  const one = await health.execute({ op: 'handover', action: 'get', level: LEVEL_B });
  eq(one.entries.length, 0, 'B 关卡的台账条目数');
  return 'B 仍然缺值 ⇒ 不串号';
});

await check('⑤ 只有显式 set 会写盘：一次"参数里传了值"的调用**不落盘**', async () => {
  const before = fs.readFileSync(ledgerPath(), 'utf8');
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, level: LEVEL_B, templateIndex: TEMPLATE, container: CONTAINER });
  assert(r.ok === true, '带参数调用失败：' + JSON.stringify(r).slice(0, 200));
  eq(r.handoverFrom, 'arg', 'handoverFrom');
  const after = fs.readFileSync(ledgerPath(), 'utf8');
  eq(after, before, '台账被"顺手"改了 —— 这正是上一版把两道门禁打红的原因');
  return '台账逐字节未变';
});

await check('⑥ get / clear：回显与显式抹除（clear 要 confirm）', async () => {
  const g = await health.execute({ op: 'handover', action: 'get', level: LEVEL_A });
  assert(g.ok && g.entries.length === 2, 'get 不对：' + JSON.stringify(g).slice(0, 200));
  const noConfirm = await health.execute({ op: 'handover', action: 'clear', level: LEVEL_A });
  assert(noConfirm.ok === false && /confirm/.test(noConfirm.error), 'clear 没要 confirm');
  const c = await health.execute({ op: 'handover', action: 'clear', level: LEVEL_A, confirm: true });
  assert(c.ok === true && c.removed.includes('container'), 'clear 不对：' + JSON.stringify(c).slice(0, 200));
  const after = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, level: LEVEL_A });
  assert(after.ok === false, 'clear 之后竟然还能生成（台账没清干净）');
  return 'get 2 项 → clear 后回到 ok:false';
});

await check('⑦ `handoverFrom` 的**既有顺序不许变**（`gil+arg` 是文档里的值；台账只能追加在末尾）', async () => {
  const { handoverFromString } = await import('../lib/handover-ledger.mjs');
  eq(handoverFromString({ gil: true, arg: true }), 'gil+arg', '既有值被改过（下游按 gil+arg 匹配就认不出来）');
  eq(handoverFromString({ gil: true }), 'gil', 'gil');
  eq(handoverFromString({ arg: true }), 'arg', 'arg');
  eq(handoverFromString({ ledger: true }), 'ledger', 'ledger');
  eq(handoverFromString({ gil: true, arg: true, ledger: true }), 'gil+arg+ledger', '台账必须追加在末尾');
  eq(handoverFromString({ gil: true, ledger: true }), 'gil+ledger', 'gil+ledger');
  eq(handoverFromString({}), null, '都没有 ⇒ null');
  return 'gil+arg / gil / arg / ledger / gil+arg+ledger / gil+ledger / null';
});

if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW; else process.env.MILIASTRA_LOCALLOW = savedLow;
if (savedData === undefined) delete process.env.MILIASTRA_DATA_DIR; else process.env.MILIASTRA_DATA_DIR = savedData;

console.log('');
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 磁盘是用户的：删不掉就留着 */ }
process.exitCode = fail ? 1 : 0;
