// gia-timeline.mjs — 按「局」切分 .gia，并检查 level2 是不是局内秒表
//
// 背景：.gia 里一个文件可以装多局（靠 instance 第一段区分）。
// 记录里那个 `level2` 字段数值很小（1..120），怀疑是**局内秒**（相对本局开跑）。
// 如果成立，就能给「开跑第几秒发生了什么」这种时间轴，不用人肉倒序。
//
// 本轮要验的三件事：
//   ① 同一 instance 内 level2 单调不减
//   ② level2 的跨度 ≈ 该局真实时长（用一局里的首末条推算）
//   ③ 不同 instance 的 level2 各自从头开始（不是全局计数）
//
// 用法: node tools/gia-timeline.mjs [日志文件名或绝对路径 ...]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readGia } from '../lib/gia.mjs';

const DIR = path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo', '原神', 'BeyondLocal', '201170108', 'Beyond_Debug_Log');

let files = process.argv.slice(2);
if (!files.length) {
  files = fs.readdirSync(DIR).filter((n) => n.endsWith('.gia'))
    .map((n) => ({ n, st: fs.statSync(path.join(DIR, n)) }))
    .filter((x) => x.st.size < 2 * 1024 * 1024)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 4).map((x) => path.join(DIR, x.n));
} else {
  files = files.map((f) => (f.includes('\\') ? f : path.join(DIR, f)));
}

const stamp = (epochSec) => {
  if (!epochSec) return '?';
  const d = new Date(epochSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

for (const f of files) {
  const g = readGia(f);
  console.log(`\n=== ${path.basename(f)}  ${g.size}B  ${g.recordCount} 条 ===`);
  if (!g.ok) { console.log('  读取失败: ' + g.error); continue; }
  const runs = new Map();
  for (const r of g.records) {
    const inst = String(r.instance || '');
    const kind = inst.split('-')[0];
    const epoch = Number(inst.split('-')[2]) || 0;
    const key = inst || '(无 instance)';
    if (!runs.has(key)) runs.set(key, { kind, epoch, n: 0, lo2: Infinity, hi2: -Infinity, mono: true, prev2: null, first: '', last: '' });
    const run = runs.get(key);
    run.n += 1;
    const l2 = Number(r.level2);
    if (Number.isFinite(l2)) {
      if (run.prev2 !== null && l2 < run.prev2) run.mono = false;
      run.prev2 = l2;
      run.lo2 = Math.min(run.lo2, l2);
      run.hi2 = Math.max(run.hi2, l2);
    }
    const msg = String(r.message || '');
    if (!run.first) run.first = msg;
    run.last = msg;
  }
  const sorted = [...runs.entries()].sort((a, b) => a[1].epoch - b[1].epoch);
  for (const [inst, run] of sorted) {
    const span = Number.isFinite(run.hi2) ? run.hi2 - run.lo2 : NaN;
    console.log(`  [${run.kind}] 开跑 ${stamp(run.epoch)} (epoch ${run.epoch})  ${run.n} 条  level2 ${run.lo2}..${run.hi2} (跨度 ${span})  单调=${run.mono}`);
    console.log(`      首: ${run.first.slice(0, 96)}`);
    console.log(`      末: ${run.last.slice(0, 96)}`);
  }
}
