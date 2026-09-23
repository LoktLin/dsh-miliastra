// tools/lint-probes.mjs — 把所有探针模板渲染出来逐个结构校验，出错时打印上下文
// 用法: node tools/lint-probes.mjs [模板名...]
import { PROBE_TEMPLATES, renderProbe } from '../lib/probes.mjs';
import { lintLua, lintSummary } from '../lib/lualint.mjs';

const only = process.argv.slice(2);
const list = only.length ? only : PROBE_TEMPLATES;
let bad = 0;

for (const t of list) {
  const r = renderProbe(t, { tag: 'LINT' });
  if (!r.ok) { console.log('FAIL ' + t + ' 渲染失败: ' + r.error); bad++; continue; }
  const lr = lintLua(r.lua);
  console.log((lr.ok ? '  OK ' : 'FAIL ') + t.padEnd(14) + r.bytes + 'B  ' + lintSummary(lr));
  if (lr.ok) continue;
  bad++;
  const lines = r.lua.split(/\r?\n/);
  console.log('  模板渲染时自带的前缀行数（PRELUDE）会让行号整体后移，下面同时给两侧行号:');
  for (const p of lr.problems) {
    console.log('  ── L' + p.line + ' ' + p.message);
    for (let k = Math.max(1, p.line - 2); k <= Math.min(lines.length, p.line + 2); k++) {
      console.log('     ' + (k === p.line ? '>' : ' ') + String(k).padStart(4) + ' | ' + lines[k - 1]);
    }
  }
}
console.log('\n共 ' + list.length + ' 个模板，失败 ' + bad + ' 个');
process.exitCode = bad ? 1 : 0;
