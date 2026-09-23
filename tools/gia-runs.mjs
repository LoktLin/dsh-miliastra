/**
 * tools/gia-runs.mjs — 统计「一个 .gia 里到底有几局」。
 *
 * 为什么要单独统计：`.gia` 的 `instance` 字段是**每一局**的身份，
 * 形如 `47504-201170108-1790154081-2937`，其中 `1790154081` 是 **epoch 秒 = 该局开跑时刻**。
 * 一个 `.gia` 里可以有多次运行（实测同一文件里出现两遍同一份探针输出）。
 *
 * 用法: node tools/gia-runs.mjs [日志目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readGia } from '../lib/gia.mjs';

const dir = process.argv[2] || (process.env.MILIASTRA_LOCALLOW || path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo'))
  + '\\原神\\BeyondLocal\\201170108\\Beyond_Debug_Log';
/** 只统计最近 N 个文件（默认 12）—— 老的没问题，但没必要。 */
const LIMIT = Number(process.argv[3] || 12);
/** 超过这个大小就跳过：本机有个 165MB 的 .gia，全量解析会 OOM（实测）。 */
const MAX_MB = Number(process.env.GIA_MAX_MB || 8);

const all = fs.readdirSync(dir).filter((n) => n.endsWith('.gia'))
  .map((n) => ({ n, st: fs.statSync(path.join(dir, n)) }))
  .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
const files = all.slice(-LIMIT);

const epochOf = (inst) => {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(String(inst || ''));
  if (!m) return null;
  return { sec: Number(m[3]), ms: Number(m[4]), kind: m[1] };
};
const hhmmss = (sec) => (sec ? new Date(sec * 1000).toTimeString().slice(0, 8) : '—');

console.log('目录: ' + dir + '\n');
console.log('文件'.padEnd(42) + '大小'.padStart(9) + '  记录  局数  各局开跑时刻（instance 里的 epoch 秒）');
let totalRuns = 0;
for (const f of files) {
  if (f.st.size > MAX_MB * 1024 * 1024) {
    console.log(f.n.padEnd(42) + String(f.st.size).padStart(7) + 'B' + '  跳过（>' + MAX_MB + 'MB，解析会 OOM）');
    continue;
  }
  const g = readGia(path.join(dir, f.n));
  if (!g.ok) { console.log(f.n.padEnd(42) + ' 解析失败'); continue; }
  const runs = [];
  const seen = new Set();
  for (const r of g.records) {
    if (!r.instance || seen.has(r.instance)) continue;
    seen.add(r.instance);
    runs.push(r.instance);
  }
  totalRuns += runs.length;
  const label = runs.map((i) => {
    const e = epochOf(i);
    return e ? hhmmss(e.sec) + '(' + e.kind + ')' : i;
  }).join(' ');
  console.log(f.n.padEnd(42) + String(f.st.size).padStart(7) + 'B'
    + String(g.recordCount).padStart(6) + String(runs.length).padStart(6) + '  ' + label);
}
console.log('\n合计 ' + files.length + ' 个文件 / ' + totalRuns + ' 局');
console.log('注意 kind（instance 第一段）也会分叉：47504 与 90003 是不同来源，别混为一谈');
