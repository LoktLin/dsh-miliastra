/**
 * tools/inspect-gia.mjs — 把一局的 `.gia` **原样**打出来（所有记录、所有字段）。
 *
 * 用途：`miliastra_log op=tail` 只回 message 正文，看不到「记录本身的形状」。
 * 想判断「有没有试玩开始/结束的标记」「channel 是什么」这类问题，得看原始记录。
 *
 * 用法: node tools/inspect-gia.mjs [日志文件绝对路径] [最多几条]
 *       不给路径 = 用最新那个 .gia
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readGia } from '../lib/gia.mjs';

const localLow = process.env.MILIASTRA_LOCALLOW || path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo');

function newestGia() {
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.gia')) {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
  };
  walk(localLow, 0);
  return best;
}

let file = process.argv[2];
let limit = Number(process.argv[3] || 200);
if (!file) {
  const b = newestGia();
  if (!b) { console.log('没找到 .gia'); process.exit(1); }
  file = b.path;
  console.log('最新一局: ' + file);
  console.log('大小 ' + b.size + 'B  改动于 ' + new Date(b.mtimeMs).toLocaleString());
}

const g = readGia(file);
if (!g.ok) { console.log('解析失败: ' + g.error); process.exit(1); }

console.log('记录数: ' + g.recordCount + '（下面显示前 ' + limit + ' 条，全部字段）\n');

// 每一条都把字段列全 —— 这样才看得出「记录本身有没有形状上的差别」
const keys = new Set();
g.records.slice(0, limit).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
console.log('所有出现过的字段: ' + [...keys].join(', ') + '\n');

g.records.slice(0, limit).forEach((r, i) => {
  const parts = Object.keys(r)
    .filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== '')
    .map((k) => k + '=' + JSON.stringify(r[k]));
  console.log(String(i + 1).padStart(4) + '  ' + parts.join('  '));
});
