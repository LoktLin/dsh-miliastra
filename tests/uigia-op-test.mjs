/**
 * `miliastra_code op=gia-check` 自测（**op 级**，真调 `execute`，用真机夹具）。
 *
 * 钉住的事：
 *   ① 绿样本（`FIX_5图元.gia`）⇒ `ok:true` + 槽位全唯一 + `readOnly:true`；
 *   ② ★ 红样本（`out_grow5.gia`，复制品沿用母本槽位号）⇒ `ok:false` + **`UIGIA_INVALID`** + 点出重复号
 *      —— 这条就是「导入后画布为什么空白」的**可独立回答**版本；
 *   ③ 参数纪律：相对路径 / 缺 source ⇒ `BAD_PARAM`；文件不在 ⇒ `NOT_FOUND`；**都不许抛异常**；
 *   ④ 体积纪律：`limit` 生效、逐控件清单被截断且回报 `controlsOmitted`。
 *
 * 用法：node tests/uigia-op-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../index.js';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const tool = TOOLS.find((t) => t.name === 'miliastra_code');
const fx = (n) => path.join(FIX, n);
assert(tool, '找不到 miliastra_code 工具');
assert(fs.existsSync(fx('FIX_5图元.gia')), '夹具不在（先跑 tmp/_make-gia-fixtures.mjs 生成）');

await check('① 绿样本：ok:true + 槽位全唯一 + 只读', async () => {
  const r = await tool.execute({ op: 'gia-check', source: fx('FIX_5图元.gia') });
  eq(r.ok, true, `issues=${JSON.stringify(r.issues)}`);
  eq(r.slotAllUnique, true, '槽位应全唯一');
  eq(r.readOnly, true, '必须标明只读');
  eq(r.counts.controls, 6, '控件数');
  assert(/^[0-9a-f]{64}$/.test(r.sha256), 'sha256 形状');
  return `${r.bytes} B · 控件 ${r.counts.controls} · 槽位 ${r.counts.uniqueSlots}/${r.counts.slots}`;
});

await check('② ★ 红样本：槽位号重复 ⇒ UIGIA_INVALID 且点出重复号（回答"导入后为什么空白"）', async () => {
  const r = await tool.execute({ op: 'gia-check', source: fx('out_grow5.gia') });
  eq(r.ok, false, '应当判红');
  eq(r.code, 'UIGIA_INVALID', `实际 code=${r.code}`);
  assert(r.duplicateSlots.includes(111), `应点出 111，实际 ${JSON.stringify(r.duplicateSlots)}`);
  assert(r.nextStep && r.nextStep.includes('槽位号重复'), `nextStep 要指向病因，实际 ${r.nextStep}`);
  return `code=${r.code} · 重复槽位 ${JSON.stringify(r.duplicateSlots)}`;
});

await check('③ 参数纪律：相对路径 / 缺 source / 文件不在 —— 都回回执、不抛异常', async () => {
  const rel = await tool.execute({ op: 'gia-check', source: 'ui.gia' });
  eq(rel.ok, false, '相对路径应拒绝');
  eq(rel.code, 'BAD_PARAM', `相对路径实际 ${rel.code}`);
  const none = await tool.execute({ op: 'gia-check' });
  eq(none.code, 'BAD_PARAM', `缺 source 实际 ${none.code}`);
  const miss = await tool.execute({ op: 'gia-check', source: path.join(FIX, '根本没有这个文件.gia') });
  eq(miss.ok, false, '不存在的文件应拒绝');
  eq(miss.code, 'NOT_FOUND', `不存在实际 ${miss.code}`);
  return 'BAD_PARAM / BAD_PARAM / NOT_FOUND';
});

await check('④ 体积纪律：limit 截断逐控件清单并回报 controlsOmitted', async () => {
  const full = await tool.execute({ op: 'gia-check', source: fx('FIX_41图元.gia'), limit: 3 });
  eq(full.ok, true, '41 图元样本应自洽');
  eq(full.controls.length, 3, 'limit=3 应只回 3 条');
  eq(full.controlsOmitted, full.counts.controls - 3, 'controlsOmitted 要对得上');
  assert(full.counts.controls > 40, `41 图元样本控件数应 >40，实际 ${full.counts.controls}`);
  return `控件 ${full.counts.controls} → 只回 3 条（省略 ${full.controlsOmitted}）`;
});

await check('④ 同一份文件两次体检结论一致（确定性）', async () => {
  const a = await tool.execute({ op: 'gia-check', source: fx('FIX_3图元.gia') });
  const b = await tool.execute({ op: 'gia-check', source: fx('FIX_3图元.gia') });
  eq(a.sha256, b.sha256, 'sha256 应一致');
  eq(a.ok, b.ok, '结论应一致');
  eq(JSON.stringify(a.duplicateSlots), JSON.stringify(b.duplicateSlots), '重复槽位应一致');
  return 'sha/结论/重复集 三者一致';
});

await check('④ 乱码文件（≥24 B）⇒ UIGIA_INVALID，绝不抛异常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-uigia-'));
  const bad = path.join(dir, '乱码.gia');
  const buf = Buffer.alloc(64, 0x37);
  buf.writeUInt32BE(60, 0);
  buf.writeUInt32BE(1, 4);
  buf.writeUInt32BE(806, 8);
  buf.writeUInt32BE(3, 12);
  buf.writeUInt32BE(40, 16);
  fs.writeFileSync(bad, buf);
  const r = await tool.execute({ op: 'gia-check', source: bad });
  eq(r.ok, false, '乱码文件应判 red');
  assert(r.code !== 'TOOL_THREW', '不能变成 TOOL_THREW（那是我们自己的 bug）');
  eq(r.code, 'UIGIA_INVALID', `实际 ${r.code}`);
  return `code=${r.code}（输入问题，不是工具 bug）`;
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
