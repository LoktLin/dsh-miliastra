/**
 * 界面控件组 `.gia` 读写与校验自测（**纯离线**，夹具是清洗过的真机样本）。
 *
 * 钉住四件事：
 *   ① **wire 层逐字节往返**：`readUigia` → `scanFields`/`joinFields` → `writeUigia` 必须与输入**一字节不差**；
 *   ② **格式常量**：头部 `[len-4,1,806,3,bodyLen]` + 尾部 `00000679`（4 份真机文件全同）；
 *   ③ ★ **槽位号唯一性判据**：`out_grow5.gia`（复制品沿用母本号）必须被判 `SLOT_DUPLICATED`，
 *      `FIX_5图元.gia`（号唯一）必须 `ok:true` —— 这是真机"整组渲染失败"那条血泪的**回归**；
 *   ④ **父子关系与 packed 列表**：容器没有父引用、子控件父引用 = 容器 ID、`19.1.503` 的 packed ID 与子控件一致。
 *
 * 用法：node tests/uigia-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UIGIA_TAIL, readUigia, writeUigia, scanFields, joinFields, listControls,
  validateUigia, retargetId, decodePackedVarints, oneOf, childrenOf,
} from '../lib/uigia.mjs';
import { UigiaIssue } from '../lib/receipt.mjs';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, name));
const SKEL = '1_两个图形.gia';
const GROW_BAD = 'out_grow5.gia';   // 复制品沿用母本槽位号 ⇒ 真机导入后画布全空
const GROW_FIX = 'FIX_5图元.gia';   // 修好号之后 ⇒ 真机导入正常
const FIX3 = 'FIX_3图元.gia';

check('① wire 层逐字节往返（骨架 2561 B）', () => {
  const buf = read(SKEL);
  const gia = readUigia(buf);
  const back = writeUigia(gia.fields, gia.tail);
  assert(back.equals(buf), `往返后不一致：${back.length} B vs ${buf.length} B`);
  return `${buf.length} B 一字节不差`;
});

check('① wire 层逐字节往返（41 图元 36126 B）', () => {
  const buf = read('FIX_41图元.gia');
  const gia = readUigia(buf);
  const back = writeUigia(gia.fields, gia.tail);
  assert(back.equals(buf), '往返后不一致');
  return `${buf.length} B 一字节不差`;
});

check('② 头部常量与尾部标记（4 份样本）', () => {
  const names = [SKEL, GROW_BAD, GROW_FIX, FIX3];
  for (const n of names) {
    const buf = read(n);
    const { header, tail } = readUigia(buf);
    eq(header[0], buf.length - 4, `${n} 头部长度字段`);
    eq(header[1], 1, `${n} 头部[1]`);
    eq(header[2], 806, `${n} 头部[2]（常量）`);
    eq(header[3], 3, `${n} 头部[3]（常量）`);
    eq(header[4], buf.length - 24, `${n} body 长度`);
    assert(tail.equals(UIGIA_TAIL), `${n} 尾部应为 ${UIGIA_TAIL.toString('hex')}，实际 ${tail.toString('hex')}`);
  }
  return `4 份全中 · 尾部 ${UIGIA_TAIL.toString('hex')}`;
});

check('④ 控件清单：id / 槽位号 / 父引用 / 名字', () => {
  const gia = readUigia(read(SKEL));
  const ctrls = listControls(gia.fields);
  eq(ctrls.length, 3, '控件数（1 容器 + 2 子）');
  eq(ctrls[0].kind, 'container', '第一条是容器');
  eq(ctrls[0].id, 1073742248, '容器 ID');
  eq(ctrls[0].parent, null, '容器**没有**父引用');
  eq(ctrls.map((c) => c.slot).join(','), '110,111,112', '槽位号序列');
  eq(ctrls[1].parent, 1073742248, '子控件的父引用 = 容器 ID');
  eq(ctrls[1].name, '图片', '子控件名字');
  return `容器 ${ctrls[0].id} + ${ctrls.length - 1} 子控件，槽位 110/111/112`;
});

check('④ 容器的 packed ID 列表 == 子控件 ID', () => {
  const gia = readUigia(read(SKEL));
  const ctrls = listControls(gia.fields);
  const g19 = oneOf(ctrls[0].fields, 19);
  const g1 = oneOf(childrenOf(g19) ?? [], 1);
  const packed = oneOf(childrenOf(g1) ?? [], 503);
  assert(packed && packed.bytes, '容器没有 19.1.503');
  const listed = decodePackedVarints(packed.bytes);
  const childIds = ctrls.filter((c) => c.kind === 'child').map((c) => c.id);
  eq(listed.join(','), childIds.join(','), 'packed 列表');
  return `packed=[${listed.join(', ')}]`;
});

check('③ ★ 修前样本必须被判「槽位号重复」（真机血泪的回归）', () => {
  const r = validateUigia(read(GROW_BAD));
  const codes = r.issues.map((i) => i.code);
  assert(codes.includes(UigiaIssue.SLOT_DUPLICATED), `未报 SLOT_DUPLICATED，实际 ${codes.join(',') || '(无)'}`);
  eq(r.ok, false, '有 error 时 ok 必须为 false');
  eq(r.counts.slots - r.counts.uniqueSlots, 3, '重复槽位处数（111 出现 4 次 ⇒ 多出 3 处）');
  return `ok=${r.ok} · ${codes.join(',')}`;
});

check('③ 修后样本必须通过（号唯一）', () => {
  const r = validateUigia(read(GROW_FIX));
  eq(r.ok, true, `期望 ok:true，实际 issues=${JSON.stringify(r.issues)}`);
  eq(r.counts.slots, r.counts.uniqueSlots, '槽位号应全唯一');
  eq(r.counts.controls, 6, '控件数（1 容器 + 5 子）');
  return `${r.counts.controls} 控件 · 槽位全唯一`;
});

check('③ 3 图元样本也通过', () => {
  const r = validateUigia(read(FIX3));
  eq(r.ok, true, `期望 ok:true，实际 ${JSON.stringify(r.issues)}`);
  return `槽位 ${r.counts.uniqueSlots}/${r.counts.slots} 唯一`;
});

check('④ 清洗后的夹具不再泄露账号 / 关卡号', () => {
  for (const n of [SKEL, GROW_BAD, GROW_FIX, FIX3]) {
    const gia = readUigia(read(n));
    const src = oneOf(gia.fields, 3);
    const str = src && src.bytes ? src.bytes.toString('utf8') : '';
    assert(!/^341622797/.test(str), `${n} 的 #3 仍带原账号：${str}`);
    assert(str.startsWith('000000000-'), `${n} 的 #3 未清洗：${str}`);
  }
  return '4 份夹具的 #3 均为中性串（等长替换，文件长度不变）';
});

check('retargetId：换掉自身 ID 引用，父引用不受影响', () => {
  const gia = readUigia(read(SKEL));
  const ctrls = listControls(gia.fields);
  const child = ctrls[1];
  const NEW = 1073742999;
  const patched = retargetId(child.fields, child.id, NEW);
  const g19 = oneOf(patched, 19);
  const g1 = oneOf(childrenOf(g19) ?? [], 1);
  const inner = childrenOf(g1) ?? [];
  const id = oneOf(inner, 501);
  eq(id && id.value, NEW, '19.1.501 应被换成新 ID');
  const selfRef = oneOf(childrenOf(oneOf(inner, 502)) ?? [], 11);
  const selfId = oneOf(childrenOf(selfRef) ?? [], 501);
  eq(selfId && selfId.value, NEW, '三元组里的自身引用也应换掉');
  const parent = oneOf(inner, 504);
  eq(parent && parent.value, 1073742248, '父引用（504）不该被换掉');
  return `旧 ${child.id} → 新 ${NEW}，父引用保持`;
});

check('scanFields/joinFields 对空输入不炸', () => {
  eq(scanFields(Buffer.alloc(0)).length, 0, '空 buf 扫描');
  eq(joinFields([]).length, 0, '空字段拼接');
  return 'ok';
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
