/**
 * gia.mjs — 原神千星奇域「客户端运行时日志」(.gia) 读取
 *
 * 实测结构（2026-09-23，正式服 7.1）：
 *   文件 = [8 字节包头] + [protobuf 主体]
 *   每条日志 = 顶层字段 #1（message）：
 *     #1 varint  进程/会话序号（如 149）
 *     #2 str     实例 ID（形如 "<进程>-<账号ID>-<时间戳>-<序号>"）
 *     #3 varint  固定 1
 *     #4 str     时间 "2026/09/23_17:01:26"
 *     #5 varint  账号 ID
 *     #6 str     玩家名
 *     #11 msg → #2 str  关卡/模式名
 *     #23 msg → #2 str  正文（就是 Lua 里 print 出来的那一行）
 *
 * 只要脚本里 print，就能在这里被结构化读出来 —— 这是「运行时取证」的唯一入口。
 */

import fs from 'node:fs';
import { findProtobufRoot, num, str, field } from './wire.mjs';

/** 解析一个 .gia 文件 → { ok, file, size, header, records[] } */
export function readGia(file) {
  const buf = fs.readFileSync(file);
  const root = findProtobufRoot(buf);
  if (!root) {
    return { ok: false, file, size: buf.length, error: '解析失败：文件头不是可识别的 protobuf 形态' };
  }
  const records = [];
  for (const f of root.fields) {
    if (f.no !== 1 || f.wt !== 2 || !f.sub) continue;
    const rec = f.sub;
    const ch = field(rec, 11, 2);
    const body = field(rec, 23, 2);
    records.push({
      index: records.length,
      seq: num(rec, 1),
      instance: str(rec, 2),
      level2: num(rec, 3),
      time: str(rec, 4),
      account: num(rec, 5),
      player: str(rec, 6),
      channel: ch && ch.sub ? str(ch.sub, 2) : null,
      message: body && body.sub ? str(body.sub, 2) : null,
      // 正文之外可能还有别的叶子字段，保留原始编号以便排障
      bodyFields: body && body.sub ? body.sub.map((x) => ({ no: x.no, wt: x.wt })) : null,
    });
  }
  return {
    ok: true,
    file,
    size: buf.length,
    headerBytes: root.start,
    recordCount: records.length,
    records,
  };
}

/** 列出日志文件（按写入时间倒序）。 */
export function listGia(dir, limit = 40) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.gia'))
    .map((n) => {
      const full = dir + '\\' + n;
      let st = null;
      try { st = fs.statSync(full); } catch { /* ignore */ }
      return st ? { name: n, path: full, size: st.size, mtime: st.mtime.toISOString() } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    .slice(0, limit);
}

/**
 * 按正则过滤记录；tag 会按「正文包含该子串」处理。
 *
 * @param {Array<{message?: string}>} records 原始记录（如 `readGia(...).records`）
 * @param {{tag?: string, pattern?: string, onlyWithMessage?: boolean, limit?: number, fromEnd?: boolean}} [opts]
 *        `tag` 子串过滤；`pattern` 正则过滤；`onlyWithMessage` 默认 true（丢掉没有正文的记录）；
 *        `limit` 默认 200；`fromEnd` 默认 true —— 超限时留**最新**的那些，false 则留最早的
 * @returns {{records: Array, error?: string}} 正则非法时只回 `error`，此时 `records` 是空数组
 */
export function filterRecords(records, { tag, pattern, onlyWithMessage = true, limit = 200, fromEnd = true } = {}) {
  let re = null;
  if (pattern) {
    try { re = new RegExp(pattern); } catch (e) { return { error: '正则非法：' + e.message, records: [] }; }
  }
  let out = records.filter((r) => {
    if (onlyWithMessage && !r.message) return false;
    if (tag && !(r.message && r.message.includes(tag))) return false;
    if (re && !(r.message && re.test(r.message))) return false;
    return true;
  });
  if (fromEnd && out.length > limit) out = out.slice(out.length - limit);
  else if (out.length > limit) out = out.slice(0, limit);
  return { records: out };
}

/* ------------------------------------------------- 按「局」切分（0.0.6） */

const RE_READY = /就绪|ready/i;

/*
 * 疑似异常 / 疑似错误的**词表** —— 注意：这些是**通用**词，不硬编码某个玩法的文案
 * （玩法是用户的，工具只能做「疑似」归类）。
 *
 * ⚠️ 为什么要拆成「一个词一条」而不是一条大正则（2026-09-25 同事实测）：
 *    回执里只有 `errorKinds: 2` —— 只说「有两种错」，**说不出命中的是哪两个词**，
 *    于是 AI 根本没法判断该不该信这条归类（工具自己也标了 caveat）。
 *    现在逐条记录都带上**真命中的词表**（`errorSample[].matched` / `errorMatched`）。
 *    合并成正则的那条仍由这张表**推导**（`specs.map(s => s.re.source)`）——
 *    保证「计数」与「命中词」永远同源，不会各说各话。
 */
const FAULT_WORD_SPECS = ['落出边界', '重生', '死亡', '摔死', '坠落', 'dead', 'death', 'died', 'respawn', 'fell']
  .map((w) => ({ label: w, re: new RegExp(w, 'i') }));
const ERROR_WORD_SPECS = [
  { label: 'error', re: /\berror\b/i },
  { label: '错误', re: /错误/ },
  { label: '失败', re: /失败/ },
  { label: '异常', re: /异常/ },
  { label: 'nil value', re: /nil value/i },
  { label: 'attempt to', re: /attempt to/i },
  { label: 'traceback', re: /traceback/i },
  { label: 'invalid', re: /invalid/i },
];
const RE_FAULT = new RegExp(FAULT_WORD_SPECS.map((s) => s.re.source).join('|'), 'i');
const RE_ERROR = new RegExp(ERROR_WORD_SPECS.map((s) => s.re.source).join('|'), 'i');

/** 这段文字**真的**命中了词表里的哪几个词（顺序 = 词表顺序，没命中的一律不出现）。 */
const wordsHit = (text, specs) => specs
  .filter((s) => s.re.test(String(text == null ? '' : text)))
  .map((s) => s.label);

/** epoch 秒 → 本地 `HH:MM:SS`。 */
function hhmmss(epochSec) {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  const d = new Date(epochSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 按 `instance` 把记录切成「局」——**纯函数**。
 *
 * 为什么需要：**一个 `.gia` 里可以装多局**（实测 `21-24-16_155` 装了两段完整 `OnInit…OnDestroy`）。
 * 以前只有整文件倒序的 `op=tail`，读的人得自己把 30 多条倒过来、再分清哪段属于哪局 —— 纯人肉。
 *
 * `instance` 形如 `47504-201170108-1790170177-5403`：
 *   · 第一段 = 来源：**`47504`** 一次试玩运行 / **`90003`** 编辑器主屏会话（跨多局不变）
 *   · 第三段 = **epoch 秒 = 该局开跑时刻**，与 `miliastra_playtest` 报的 `epochSec` 是**同一个值**
 */
export function groupRuns(records, { maxMessagesPerRun = 400 } = {}) {
  const map = new Map();
  for (const r of records) {
    const inst = String(r.instance || '').trim();
    if (!inst) continue;
    const parts = inst.split('-');
    if (!map.has(inst)) {
      map.set(inst, {
        instance: inst,
        kind: parts[0] || null,
        epochSec: Number(parts[2]) || null,
        recordCount: 0,
        firstIndex: r.index,
        lastIndex: r.index,
        readyLines: [],
        errorLines: [],
        // 与 errorLines **一一对应**的命中词（每行一个数组）—— 给 errorSample[].matched 用
        errorHitLines: [],
        // 整个 run 里疑似异常行命中过的词（去重）
        faultHitWords: [],
        faultCount: 0,
        messages: [],
        truncatedMessages: false,
      });
    }
    const run = map.get(inst);
    run.recordCount += 1;
    run.lastIndex = r.index;
    const msg = String(r.message || '');
    if (!msg) continue;
    if (run.messages.length < maxMessagesPerRun) run.messages.push(msg);
    else run.truncatedMessages = true;
    if (RE_READY.test(msg)) run.readyLines.push(msg);
    if (RE_FAULT.test(msg)) {
      run.faultCount += 1;
      for (const w of wordsHit(msg, FAULT_WORD_SPECS)) if (run.faultHitWords.indexOf(w) < 0) run.faultHitWords.push(w);
    }
    if (RE_ERROR.test(msg)) {
      run.errorLines.push(msg);
      run.errorHitLines.push(wordsHit(msg, ERROR_WORD_SPECS));
    }
  }
  const runs = [...map.values()].map((run) => ({
    ...run,
    startedAt: hhmmss(run.epochSec),
    // 同类错刷屏时别淹了摘要：去重后再给前几条；**每条都带上真命中的词**（AI 才能判断该不该信这条归类）
    errorSample: (() => {
      const seen = new Map();
      for (let i = 0; i < run.errorLines.length; i += 1) {
        if (!seen.has(run.errorLines[i])) seen.set(run.errorLines[i], run.errorHitLines[i] || []);
      }
      return [...seen.entries()].slice(0, 6).map(([line, matched]) => ({ line, matched }));
    })(),
    /** 这一局里**所有**疑似错误行命中过的词（去重，按首次出现顺序）—— 总览用。 */
    errorMatched: (() => {
      const out = [];
      for (const words of run.errorHitLines) for (const w of words) if (out.indexOf(w) < 0) out.push(w);
      return out;
    })(),
    /** 疑似异常（faultCount）命中过的词 —— 同一个问题，一并说清。 */
    faultMatched: run.faultHitWords,
    errorKinds: new Set(run.errorLines).size,
    readyLine: run.readyLines.length ? run.readyLines[run.readyLines.length - 1] : null,
    firstMessage: run.messages[0] || null,
    lastMessage: run.messages.length ? run.messages[run.messages.length - 1] : null,
  }));
  // 试玩局（47504）排前面、主屏会话（90003）排后面，各自按开跑时刻升序
  return runs.sort((a, b) => {
    const ka = a.kind === '47504' ? 0 : 1;
    const kb = b.kind === '47504' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return (a.epochSec || 0) - (b.epochSec || 0);
  });
}

/** 只取「试玩局」（instance 第一段 47504）。 */
export const playRunsOf = (runs) => runs.filter((r) => r.kind === '47504');

/** 每局的精简摘要（给 AI / 人看的那一份）。 */
export function summarizeRuns(runs, limit = 10) {
  return runs.slice(-limit).map((r) => ({
    instance: r.instance,
    kind: r.kind,
    epochSec: r.epochSec,
    startedAt: r.startedAt,
    recordCount: r.recordCount,
    faultCount: r.faultCount,
    errorKinds: r.errorKinds,
    readyLine: r.readyLine,
    // 命中的**词**（errorSample 每项也各带 matched）：只说「几种错」没法判断该不该信这条归类
    errorMatched: r.errorMatched,
    faultMatched: r.faultMatched,
    errorSample: r.errorSample,
    firstMessage: r.firstMessage ? r.firstMessage.slice(0, 160) : null,
    lastMessage: r.lastMessage ? r.lastMessage.slice(0, 160) : null,
  }));
}

/**
 * 最近两局的**局间 diff**：新增/消失的错误样式 + 计数增减。任一局缺失返回 null。
 *
 * 判据刻意保守：只有「没有新增错误样式 **且** 错误样式数没涨 **且** 异常次数没涨」才说「没变坏」。
 */
export function compareRuns(prev, cur) {
  if (!prev || !cur) return null;
  const setOf = (r) => new Set((r.errorLines || []).map((s) => String(s).slice(0, 160)));
  const a = setOf(prev);
  const b = setOf(cur);
  const added = [...b].filter((x) => !a.has(x));
  const gone = [...a].filter((x) => !b.has(x));
  const notWorse = added.length === 0 && cur.errorKinds <= prev.errorKinds && cur.faultCount <= prev.faultCount;
  return {
    from: prev.instance,
    to: cur.instance,
    recordDelta: cur.recordCount - prev.recordCount,
    faultDelta: cur.faultCount - prev.faultCount,
    errorKindsDelta: cur.errorKinds - prev.errorKinds,
    newErrors: added.slice(0, 8),
    goneErrors: gone.slice(0, 8),
    verdict: notWorse
      ? '没有变坏：没有新增的错误样式，错误样式数与异常次数都没涨'
      : '有变化 —— 看 newErrors / 各项 delta（正数 = 比上一局多）',
  };
}
