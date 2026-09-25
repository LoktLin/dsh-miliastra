/**
 * playtest.mjs — 「试玩开跑 / 结束」的实时侦测（2026-09-23 真机验证）
 *
 * 为什么不用 `.gia`：**`.gia` 不是实时的**。实测 22 个 `.gia` 全部
 * `CreationTime == LastWriteTime`，且都**晚于文件名时刻**：
 *   21:46:02 开跑 → 21:46:58 结束 → `…21-46-05_157.gia` 落盘于 **21:47:07**（结束后 9 秒）。
 * 局在跑的时候，磁盘上根本没有这个文件。所以「盯 .gia」只能等局结束。
 *
 * 真正的实时信号在游戏自己写的 Unity 日志 `output_log.txt`（**每行带毫秒时间戳、持续追加**）：
 *   开跑：`Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData … isTrial:True`
 *   结束：`Genshin Loading Log: StartQuickSwitchSceneAction … reason:QuickSwitchToBeyondSettleSceneNormally`
 *   场景：`Genshin Loading Log: OnReceivePlayerEnterSceneNotify <token> - NowTimeStamp:<epoch 秒>`
 *
 * 实测延迟（2026-09-23 21:46 那局，本模块要用的实测依据）：
 *   开跑 Δ = **+0.18 秒**，结束 Δ = **+0.07 秒**（Δ = 我们读到它的时刻 − 它自己写的时刻）。
 *
 * 三条附带事实：
 *   · `isTrial:True` 是**平台级**标记 —— 脚本一行都不 print 的局（磁盘上没有 `.gia`）它照样记。
 *   · `NowTimeStamp` 的值 == 那一局 `.gia` 里 instance 的第三段（`47504-<账号>-<这个>-<毫秒>`），
 *     所以「实时开跑」和「事后日志」能对上号。
 *   · `output_log.txt` **按游戏启动换代**（游戏重启会重建，size 归零）→ 必须处理 offset 回退。
 *
 * ⚠️ 日志记录里那个 `level2` 字段**不要当秒表用**：实测 151 那局 25 条全是 1、155 第 1 局从 34 起、
 *    `90003` 那一路能到 842 —— 语义仍 `unknown`。要时间轴只认日志行自己的毫秒时间戳。
 *
 * 本模块的分工：纯函数（解析 / 归约 / 判定）全在这里，方便单测；
 * 文件 I/O 也在这里但不带状态，轮询由调用方（工具层）驱动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { localLowRoot } from './locate.mjs';

export const PLAYTEST_LOG_NAME = 'output_log.txt';

/** 日志文件路径：`<LocalLow>/<品牌>/output_log.txt`（按品牌，不按账号）。 */
export function playtestLogPath(brand = '原神') {
  return path.join(localLowRoot(), String(brand || '原神'), PLAYTEST_LOG_NAME);
}

const LINE_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s?([\s\S]*)$/;
const RE_START = /SetCurLevelData\b[\s\S]*?\bisTrial:\s*True\b/;
const RE_END = /QuickSwitchToBeyondSettleSceneNormally/;
const RE_SCENE = /OnReceivePlayerEnterSceneNotify\s+(\d+)\s*-\s*NowTimeStamp:(\d+)/;
const RE_EPOCH = /NowTimeStamp:(\d+)/;

/** 解析一行日志 → `{atMs, atText, date, text}`；不是日志行就返回 null。 */
export function parseLogLine(line) {
  const m = LINE_RE.exec(String(line == null ? '' : line));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const h = Number(m[4]); const mi = Number(m[5]); const s = Number(m[6]); const ms = Number(m[7]);
  const at = new Date(y, mo - 1, d, h, mi, s, ms);
  return { atMs: at.getTime(), atText: m[4] + ':' + m[5] + ':' + m[6] + '.' + m[7], date: m[1] + '-' + m[2] + '-' + m[3], text: m[8] };
}

/** 这行属于哪类信号：`start` / `end` / `scene` / null。 */
export function classifyLogText(text) {
  const t = String(text == null ? '' : text);
  if (RE_START.test(t)) return 'start';
  if (RE_END.test(t)) return 'end';
  if (RE_SCENE.test(t)) return 'scene';
  return null;
}

/** 空状态。`runs` 只保留最近 50 局（扫大文件也不会吃内存）。 */
export function createPlaytestState() {
  return {
    inPlaytest: false,
    startedAtMs: null,
    startedAtText: null,
    epochSec: null,
    token: null,
    endedAtMs: null,
    endedAtText: null,
    lastStartAtMs: null,
    lastSceneToken: null,
    lastSceneEpoch: null,
    lineCount: 0,
    runs: [],
  };
}

const pushRun = (s, run) => {
  s.runs.push(run);
  if (s.runs.length > 50) s.runs.splice(0, s.runs.length - 50);
};

/**
 * 归约一批日志行 → `{state, events}`（**纯函数**，不改入参）。
 * events 里只放 `start` / `end`（`scene` 只用来取 token，不产生事件）。
 */
export function reduceLogLines(state, lines) {
  const s = { ...state, runs: state.runs.slice() };
  const events = [];
  for (const raw of lines) {
    const rec = parseLogLine(raw);
    if (!rec) continue;
    s.lineCount += 1;
    const kind = classifyLogText(rec.text);

    if (kind === 'scene') {
      const m = RE_SCENE.exec(rec.text);
      s.lastSceneToken = Number(m[1]);
      s.lastSceneEpoch = Number(m[2]);
      continue;
    }

    if (kind === 'start') {
      // 上一局还没看到结束就又开跑了 → 按「重新开跑」处理，隐式收尾，别把两局并成一局。
      if (s.inPlaytest && s.startedAtMs !== null) {
        pushRun(s, {
          startedAtMs: s.startedAtMs, startedAtText: s.startedAtText, epochSec: s.epochSec, token: s.token,
          endedAtMs: rec.atMs, endedAtText: rec.atText,
          durationSec: Math.round((rec.atMs - s.startedAtMs) / 1000), closed: 'implicit',
        });
      }
      const me = RE_EPOCH.exec(rec.text);
      s.inPlaytest = true;
      s.startedAtMs = rec.atMs;
      s.startedAtText = rec.atText;
      s.epochSec = me ? Number(me[1]) : (s.lastSceneEpoch === null ? null : s.lastSceneEpoch);
      s.token = s.lastSceneToken === null ? null : s.lastSceneToken;
      s.endedAtMs = null;
      s.endedAtText = null;
      s.lastStartAtMs = rec.atMs;
      events.push({ type: 'start', atMs: rec.atMs, atText: rec.atText, epochSec: s.epochSec, token: s.token });
      continue;
    }

    if (kind === 'end') {
      if (!s.inPlaytest || s.startedAtMs === null) {
        // 没看到开跑的结束标记（读晚了 / 文件被截断）→ 如实标记为孤儿事件，不编造一局。
        events.push({ type: 'end', atMs: rec.atMs, atText: rec.atText, orphan: true });
        continue;
      }
      s.inPlaytest = false;
      s.endedAtMs = rec.atMs;
      s.endedAtText = rec.atText;
      pushRun(s, {
        startedAtMs: s.startedAtMs, startedAtText: s.startedAtText, epochSec: s.epochSec, token: s.token,
        endedAtMs: rec.atMs, endedAtText: rec.atText,
        durationSec: Math.round((rec.atMs - s.startedAtMs) / 1000), closed: 'seen',
      });
      events.push({ type: 'end', atMs: rec.atMs, atText: rec.atText });
    }
  }
  return { state: s, events };
}

/**
 * `closed` 两个取值的**人话说明** —— 只加说明，**判据本身一个字不改**。
 *
 * 为什么要有（2026-09-25 同事实测）：回执里只有一句 `lastRun.closed: "implicit"`，
 * 没有任何解释 —— 读的人只能猜这个英文词是什么意思，而它恰好是「这一局没正常收尾」的信号。
 *
 * 取值只有两个（就是 `reduceLogLines` 里写的那两个）：
 *   · `seen`     —— 看到了显式结束标记（`QuickSwitchToBeyondSettleSceneNormally`）；
 *   · `implicit` —— **没**看到结束标记，是「下一局开跑」时才发现上一局已经没了。
 */
export const CLOSED_MEANINGS = Object.freeze({
  seen: '看到了显式结束标记（output_log.txt 里的 QuickSwitchToBeyondSettleSceneNormally）—— 这一局是正常收尾的',
  implicit: '没看到显式结束标记（多半是被杀进程 / 切场景 / 直接关窗口）—— 是**下一局开跑时**才发现上一局已经结束了',
});

/** 某个 `closed` 取值的人话说明；没见过的取值如实回 null（不编）。 */
export function closedMeaningOf(value) {
  const k = String(value == null ? '' : value);
  return Object.prototype.hasOwnProperty.call(CLOSED_MEANINGS, k) ? CLOSED_MEANINGS[k] : null;
}

const stamp = (ms) => {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};

/** 状态 → 给人/AI 看的摘要。 */
export function playtestSummary(state, nowMs = Date.now()) {
  const inRun = !!state.inPlaytest && Number.isFinite(state.startedAtMs);
  const last = state.runs.length ? state.runs[state.runs.length - 1] : null;
  const slim = (r) => ({
    startedAt: r.startedAtText, endedAt: r.endedAtText || null,
    durationSec: r.durationSec, epochSec: r.epochSec, token: r.token, closed: r.closed,
  });
  return {
    inPlaytest: !!state.inPlaytest,
    // `closed` 是个枚举，光给值等于让人猜（见 CLOSED_MEANINGS）：这里连**说明**一起给
    closedMeaning: last ? closedMeaningOf(last.closed) : null,
    closedMeanings: CLOSED_MEANINGS,
    startedAt: inRun ? state.startedAtText : null,
    startedAtMs: inRun ? state.startedAtMs : null,
    elapsedSec: inRun ? Math.round((nowMs - state.startedAtMs) / 1000) : null,
    epochSec: inRun ? state.epochSec : (last ? last.epochSec : null),
    token: inRun ? state.token : (last ? last.token : null),
    endedAt: inRun ? null : state.endedAtText,
    endedAtMs: inRun ? null : state.endedAtMs,
    lastRun: last ? slim(last) : null,
    recentRuns: state.runs.slice(-8).map(slim),
  };
}

/**
 * 判定「该不该算命中」——**纯函数**，wait 的轮询判断走它，好单测。
 *
 * @param state  当前状态
 * @param nowMs  现在
 * @param sinceMs 只看这个时刻**之后**发生的开跑（null = 不看下限）
 * @param backSec 回扫窗口：调用之前 backSec 秒内已经发生过的开跑也算命中
 */
export function shouldHit(state, nowMs, { sinceMs = null, backSec = 0 } = {}) {
  if (!Number.isFinite(state.lastStartAtMs)) return { hit: false };
  if (sinceMs !== null && state.lastStartAtMs < sinceMs) return { hit: false };
  if (sinceMs === null && backSec > 0) {
    const ageSec = (nowMs - state.lastStartAtMs) / 1000;
    if (ageSec <= backSec) return { hit: true, backHit: true, ageSec };
    return { hit: false };
  }
  return { hit: true, backHit: false, ageSec: (nowMs - state.lastStartAtMs) / 1000 };
}

/* ------------------------------------------------------------------ 文件 I/O */

/** 文件大小；不存在返回 null。 */
export function logSize(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

/**
 * 读文件尾部 maxBytes 字节（默认 2MB —— output_log.txt 一次游戏会话也就几百 KB）。
 * 从**中间**截断时，第一行多半是残行，调用方应当丢掉（`dropFirst`）。
 */
export function readTailText(file, maxBytes = 2 * 1024 * 1024) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  const from = Math.max(0, st.size - maxBytes);
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(st.size - from);
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, from);
    } finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  return {
    ok: true, size: st.size, from, mtimeMs: st.mtimeMs,
    truncated: from > 0, text: buf.toString('utf8'),
  };
}

/** 读 [from, size) 的新增字节；文件变短（游戏重启换代）时如实报 rotated。 */
export function readIncrement(file, from) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  if (st.size < from) return { ok: true, size: st.size, rotated: true, text: '' };
  if (st.size === from) return { ok: true, size: st.size, rotated: false, text: '' };
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
    } finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  return { ok: true, size: st.size, rotated: false, text: buf.toString('utf8') };
}

/** 整文件（或尾部）扫一遍 → `{ok, state, size, mtimeMs}`。工具层的 status / wait 基线都走它。 */
export function scanLog(file, maxBytes = 2 * 1024 * 1024) {
  const r = readTailText(file, maxBytes);
  if (!r.ok) return r;
  let state = createPlaytestState();
  const lines = r.text.split(/\r?\n/);
  if (r.truncated) lines.shift(); // 截断点上的残行丢掉
  state = reduceLogLines(state, lines).state;
  return { ok: true, state, size: r.size, mtimeMs: r.mtimeMs, truncated: r.truncated };
}
