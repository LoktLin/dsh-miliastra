// tools/lint-all.mjs — 对所有真实 Lua 文件跑一遍 lualint（临时排障用）
import fs from 'node:fs';
import path from 'node:path';
import { lintLua, lintSummary } from '../lib/lualint.mjs';

const roots = process.argv.slice(2);
const files = [];
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  else if (p.endsWith('.lua')) files.push(p);
};
for (const r of roots) walk(r);

let bad = 0;
for (const f of files.sort()) {
  const txt = fs.readFileSync(f, 'utf8');
  const r = lintLua(txt);
  if (!r.ok) bad++;
  console.log((r.ok ? '  OK  ' : ' FAIL ') + path.basename(f).padEnd(46) + ' ' + lintSummary(r));
}
console.log('\n共 ' + files.length + ' 个文件，失败 ' + bad + ' 个');
process.exitCode = bad ? 1 : 0;
