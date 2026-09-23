/**
 * tools/render-probe.mjs — 从**磁盘上的** lib/probes.mjs 渲染一个探针模板，
 * 落到工作区 `code/<玩法>/` 下并当场结构校验。
 *
 * 为什么不用 `miliastra_probe op=render`：Host 代码是启动时 import 的，
 * 运行中的 Host 可能还是旧版（`patchReload: live` 不重新 import）。此脚本读磁盘，不受影响。
 *
 * 用法: node tools/render-probe.mjs <模板名> [输出目录] [tag]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_TEMPLATES, renderProbe } from '../lib/probes.mjs';
import { lintLua, lintSummary } from '../lib/lualint.mjs';

const [tpl, outDirArg, tagArg] = process.argv.slice(2);
if (!tpl) {
  console.log('用法: node tools/render-probe.mjs <模板名> [输出目录] [tag]');
  console.log('可用模板: ' + PROBE_TEMPLATES.join(', '));
  process.exit(1);
}
const tag = tagArg || 'PROBE';
const outDir = outDirArg || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'code', '双相');

const r = renderProbe(tpl, { tag });
if (!r.ok) { console.log('❌ ' + r.error); process.exit(1); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = path.join(outDir, '_探针_' + tpl + '_' + stamp + '.lua');

const lr = lintLua(r.lua);
if (!lr.ok) {
  console.log('❌ 模板结构有问题，拒绝落盘：' + lintSummary(lr));
  const lines = r.lua.split(/\r?\n/);
  for (const p of lr.problems) console.log('  L' + p.line + ' ' + p.message + '  |  ' + (lines[p.line - 1] || '').trim().slice(0, 90));
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, r.lua, 'utf8');

// 硬要求：不带 BOM
const head = [...fs.readFileSync(out).slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
console.log('✅ 已落盘 ' + out);
console.log('   模板 ' + tpl + ' / tag=' + tag + ' / ' + r.bytes + 'B / ' + lr.stats.lines + ' 行 / ' + lr.stats.tokens + ' token');
console.log('   前 3 字节 ' + head + (head === '2d 2d 20' ? '（无 BOM ✅）' : '（⚠️ 不是 “-- ” 开头，检查 BOM）'));
