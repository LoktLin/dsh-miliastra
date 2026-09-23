// playtest-watch.mjs — 只读侦测「试玩开跑/结束」信号的实时性
//
// 为什么要有这个工具：`miliastra` 想做到「游戏开跑 N 秒后自动截图 / 取日志」，
// 前提是有一个**能实时看到「开跑」**的信号。候选来源是游戏自己写的 Unity 日志
// `%USERPROFILE%\AppData\LocalLow\miHoYo\原神\output_log.txt`，里面有两行平台级标记：
//   开跑：Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData ... isTrial:True
//   结束：Genshin Loading Log: StartQuickSwitchSceneAction ... reason:QuickSwitchToBeyondSettleSceneNormally
// 但「写进文件」和「我们能读到」是两件事：Unity 可能缓冲。
// 本工具增量 tail 该文件，对每条命中行打印 **Δ = 我们收到它的时刻 − 这行自己的毫秒时间戳**。
//   Δ ≈ 0~1 秒  → 实时可读，能做「开跑 N 秒后」。
//   Δ 很大      → 是切场景时才 flush，只能事后取证，不能做实时触发。
//
// 用法： node tools/playtest-watch.mjs [持续秒数=600]
// 只读，不写任何文件（除 stdout）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo', '原神', 'output_log.txt');
const DURATION = Number(process.argv[2] || 600) * 1000;

const PATTERNS = [
  { name: 'START', re: /isTrial:True/ },
  { name: 'END', re: /QuickSwitchToBeyondSettleSceneNormally/ },
  { name: 'SCENE', re: /OnReceivePlayerEnterSceneNotify/ },
];
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\]\s?(.*)$/;

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// 把日志行里的本地时间戳解析成 epoch ms（用于算 Δ）
let dayCache = null;
function lineEpoch(dateStr, timeStr, msStr) {
  if (!dayCache || dayCache.src !== dateStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    dayCache = { src: dateStr, y, mo, d };
  }
  const [h, mi, s] = timeStr.split(':').map(Number);
  return new Date(dayCache.y, dayCache.mo - 1, dayCache.d, h, mi, s, Number(msStr)).getTime();
}

let offset = 0;
let carry = '';
let stat = null;
let lastSize = 0;
let started = false;
const counts = { START: 0, END: 0, SCENE: 0 };

function report(level, text) {
  console.log(`${nowStamp()} [${level}] ${text}`);
}

function pump() {
  let st;
  try {
    st = fs.statSync(LOG);
  } catch (e) {
    report('ERR', `读不到 ${LOG}：${(e && e.message) || e}`);
    return;
  }
  // 换代：游戏重启会把 output_log.txt 重建，size 变小
  if (st.size < offset) {
    report('ROTATE', `日志换代（size ${st.size} < offset ${offset}）→ 从 0 重读`);
    offset = 0;
    carry = '';
  }
  if (st.size === offset) return;
  let buf;
  try {
    const fd = fs.openSync(LOG, 'r');
    try {
      const len = st.size - offset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    report('ERR', `读取出错：${(e && e.message) || e}`);
    return;
  }
  offset = st.size;
  const text = carry + buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  carry = lines.pop() || '';
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue;
      const delta = (Date.now() - lineEpoch(m[1], m[2], m[3])) / 1000;
      counts[p.name] += 1;
      report(p.name, `Δ+${delta.toFixed(2)}s  ${m[2]}.${m[3]}  ${m[4].slice(0, 130)}`);
    }
  }
}

function heartbeat() {
  let size = 0;
  try { size = fs.statSync(LOG).size; } catch { /* ignore */ }
  const grew = size - lastSize;
  lastSize = size;
  report('BEAT', `文件 ${size}B (本轮 +${grew}B)  累计 START=${counts.START} END=${counts.END} SCENE=${counts.SCENE}`);
}

console.log(`盯: ${LOG}`);
if (!fs.existsSync(LOG)) {
  console.log('!! 文件不存在 —— 游戏可能还没启动过');
} else {
  // 首次从文件尾部开始：只关心「从现在起」的新行，但把末尾 4KB 也扫一遍当作基线
  const st = fs.statSync(LOG);
  offset = Math.max(0, st.size - 4096);
  report('INIT', `基线 offset=${offset} (size=${st.size})，本次只看新增字节`);
  // 基线行不报 Δ，只标记已经存在
  let base;
  try {
    const fd = fs.openSync(LOG, 'r');
    try {
      const len = st.size - offset;
      base = Buffer.alloc(len);
      fs.readSync(fd, base, 0, len, offset);
    } finally { fs.closeSync(fd); }
  } catch { base = Buffer.from(''); }
  for (const p of PATTERNS) {
    const hit = base.toString('utf8').split(/\r?\n/).filter((l) => p.re.test(l)).pop();
    report('BASE', `${p.name} 最近一条（历史，不算触发）: ${hit ? hit.slice(0, 110) : '(无)'}`);
  }
}

const t1 = setInterval(pump, 400);
const t2 = setInterval(heartbeat, 5000);
setTimeout(() => {
  clearInterval(t1); clearInterval(t2);
  report('DONE', `到期，累计 START=${counts.START} END=${counts.END} SCENE=${counts.SCENE}`);
  process.exit(0);
}, DURATION);
