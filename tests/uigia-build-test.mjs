/**
 * 控件组生成器自测（`lib/uigia-build.mjs`）：**用真机已验证的产物做逐字节回归**。
 *
 * 钉住的事：
 *   ① **逐字节复现**：`FIX_3图元源.lua` + 骨架 `1_两个图形.gia` ⇒ 必须与 `FIX_3图元.gia` **一字节不差**
 *      （那份产物是创作者**导入确认画布正常**的，所以这条同时钉住了"结构没被我改坏"）；
 *   ② **扩容**：图元比骨架控件多时，复制模板 + 发新 ID + 同步容器两处引用表 ⇒ 仍应逐字节复现 `FIX_5图元.gia`；
 *   ③ ★ **槽位号全唯一**：扩容出来的控件**必须**拿到自己的号（真机血泪：重复 ⇒ 整组空白）；
 *   ④ **自检口径**：`parentOk` / `packedOk` / `written == expected` / `duplicateSlots 为空`。
 *
 * 用法：node tests/uigia-build-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readElementLua, buildUigia } from '../lib/uigia-build.mjs';
import { validateUigia } from '../lib/uigia.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try {
    const detail = fn();
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
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const read = (n) => fs.readFileSync(path.join(FIX, n));
const SKEL = read('1_两个图形.gia');

check('① 解析源 Lua：ROOT / ELEMENTS', () => {
  const src = readElementLua(read('FIX_3图元源.lua').toString('utf8'));
  assert(src.root.length >= 4, `ROOT 数值不足：${JSON.stringify(src.root)}`);
  assert(src.items.length >= 1, '没解出任何图元');
  assert(src.items.every((it) => it.length >= 18), '有图元字段数 < 18');
  return `图元 ${src.items.length} 个 · 画布 ${src.root[2]}×${src.root[3]} · 场景 ${src.scene ? '有' : '无'}`;
});

check('① ★ 逐字节复现 FIX_3图元.gia（真机导入确认过的那份）', () => {
  const src = readElementLua(read('FIX_3图元源.lua').toString('utf8'));
  const { buffer, report } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  const want = read('FIX_3图元.gia');
  if (!buffer.equals(want)) {
    const at = firstDiff(buffer, want);
    throw new Error(`不一致：我 ${buffer.length} B / 期望 ${want.length} B，首差 @${at}`
      + `  我=${buffer.subarray(Math.max(0, at - 4), at + 6).toString('hex')}`
      + `  期望=${want.subarray(Math.max(0, at - 4), at + 6).toString('hex')}`);
  }
  eq(report.expected, report.written, 'expected == written');
  eq(report.grown, src.items.length - 2, '骨架 2 个控件 ⇒ 超出部分应被扩容');
  return `${buffer.length} B 一字节不差 · 槽位 ${report.controls.map((c) => c.slot).join('/')}`;
});

check('② ★ 扩容：逐字节复现 FIX_5图元.gia（骨架只有 2 个控件）', () => {
  const src = readElementLua(read('test5.lua').toString('utf8'));
  const { buffer, report } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  const want = read('FIX_5图元.gia');
  if (!buffer.equals(want)) {
    const at = firstDiff(buffer, want);
    throw new Error(`不一致：图元 ${src.items.length} 个；我 ${buffer.length} B / 期望 ${want.length} B，首差 @${at}`
      + `  我=${buffer.subarray(Math.max(0, at - 4), at + 6).toString('hex')}`
      + `  期望=${want.subarray(Math.max(0, at - 4), at + 6).toString('hex')}`);
  }
  eq(report.grown, src.items.length - 2, '扩容个数');
  return `${buffer.length} B 一字节不差 · 扩容 ${report.grown} 个 · 槽位 ${report.controls.map((c) => c.slot).join('/')}`;
});

check('③ ★ 扩容后槽位号全唯一（真机血泪的正面回归）', () => {
  const src = readElementLua(read('test5.lua').toString('utf8'));
  const { report } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  eq(report.duplicateSlots.length, 0, `重复槽位 ${JSON.stringify(report.duplicateSlots)}`);
  eq(report.slotAllUnique, true, `slotAllUnique 应为 true（容器槽位 ${report.containerSlot}）`);
  return `槽位 ${report.controls.map((c) => c.slot).join('/')} · 容器 ${report.containerSlot}`;
});

check('④ 自检口径：parentOk / packedOk', () => {
  const src = readElementLua(read('test5.lua').toString('utf8'));
  const { report } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  eq(report.parentOk, true, '父引用应全部指向容器');
  eq(report.packedOk, true, 'packed ID 列表应与子控件一致');
  eq(report.duplicateIds.length, 0, `重复 ID ${JSON.stringify(report.duplicateIds)}`);
  return `id=[${report.controls.map((c) => c.id).join(', ')}]`;
});

check('④ 产物能被 validateUigia 判为自洽', () => {
  const src = readElementLua(read('test5.lua').toString('utf8'));
  const { buffer } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  const r = validateUigia(buffer);
  eq(r.ok, true, `issues=${JSON.stringify(r.issues)}`);
  return `${r.counts.controls} 控件 · 槽位唯一 ${r.counts.uniqueSlots}/${r.counts.slots}`;
});

check('④ 骨架自带的 #3 被沿用（不引入新的账号/关卡号）', () => {
  const src = readElementLua(read('test5.lua').toString('utf8'));
  const { buffer } = buildUigia({ refBuf: SKEL, root: src.root, items: src.items, scene: src.scene });
  const r = validateUigia(buffer);
  const codes = r.issues.map((i) => i.code);
  assert(!codes.includes('SOURCE_LEAKS_IDS'), `产物 #3 带账号/关卡号：${codes.join(',')}`);
  return '沿用骨架的中性 #3 ✓';
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
