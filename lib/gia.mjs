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

/* ------------------------------------------------- 「这份 .gia 属于哪一局」（0.3.1，反馈 A2） */

/**
 * 一个 `.gia` 里出现过哪些**试玩局**的开跑时刻（epoch 秒，去重升序）—— **纯函数**。
 *
 * 为什么需要（2026-09-25 同事实测）：16:23 / 16:26 / 16:29 / 16:34 四局结束后**都没有生成 `.gia`**
 * （日志目录最新仍是 16:16 那局），而 `op=grep`/`op=runs` 会**静默回退到旧文件** ——
 * `file` 字段虽然标了文件名，但很容易被当成「本局日志」，于是整条取证链张冠李戴。
 * 判据只能有一个：**instance 第三段 == 那一局的开跑时刻**（与 `miliastra_playtest` 报的 `epochSec` 同源），
 * 所以「这份文件里有没有那一局的记录」是一句可判的事实。
 */
export function giaRunEpochs(records) {
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    const inst = String((r && r.instance) || '').trim();
    if (!inst) continue;
    const parts = inst.split('-');
    if (parts[0] !== '47504') continue;          // 90003 = 编辑器主屏会话，跨多局不变，不能当「某一局」
    const e = Number(parts[2]);
    if (Number.isFinite(e) && e > 0 && out.indexOf(e) < 0) out.push(e);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 局归属判定的**容差（秒）** —— 2026-09-30 真机实测（反馈 A8）。
 *
 * 事实：开跑信号（`output_log.txt`）的 epoch 与 `.gia` **文件名**上的 epoch **可以差 1 秒** ——
 * 后者的时刻取自**脚本首次 print**，必然晚于开跑。旧版按秒**精确**匹配 ⇒ 同一局被判成
 * `staleLog:true` / `localGia:missing`，而**它就是本局**（文件里有完整的 `OnStart`→`OnDestroy`）。
 * 危害是 **AI 会照着工具警告丢掉真证据**（本轮差点误判"本局没日志"）。
 * ⇒ ±5 秒内视为同一局；回执里如实写明差了几秒，别让人以为"没有容差"。
 */
export const RUN_EPOCH_TOLERANCE_SEC = 5;

/**
 * 这份 `.gia` **属不属于本次会话那一局** —— **纯函数**（判据要能单测）。
 *
 * @param {{file?:string|null, fileEpochSecs?:number[], runEpochSec?:number|null,
 *          runStartedAtMs?:number|null, fileMtimeMs?:number|null}} [input]
 *   `file` 取到的日志文件；`fileEpochSecs` = `giaRunEpochs(...)`；`runEpochSec` = 本次会话那一局的开跑时刻
 *   （`miliastra_playtest` 报的同一个值）；`runStartedAtMs` / `fileMtimeMs` 是不带 epoch 时的粗判依据
 * @returns {{known:boolean, belongs:boolean|null, stale:boolean|null, file:string|null,
 *            logBelongsTo:string, fileEpochSecs:number[], note:string,
 *            matchedEpochSec?:number, epochGapSec?:number}}
 */
export function logFreshness({ file = null, fileEpochSecs = [], runEpochSec = null, runStartedAtMs = null, fileMtimeMs = null } = {}) {
  const name = file ? String(file).split(/[\\/]/).pop() : null;
  const epochs = (Array.isArray(fileEpochSecs) ? fileEpochSecs : []).filter((x) => Number.isFinite(x));
  const maxEpoch = epochs.length ? Math.max(...epochs) : null;
  const base = {
    file: name,
    // 回执里直接给出「这份日志属于哪一局」的**一行**（文件名 + 那一局的开跑时刻），省掉人去比文件名
    logBelongsTo: (name || '(未知文件)') + ' (epochSec ' + (maxEpoch == null ? '未知' : maxEpoch) + ')',
    fileEpochSecs: epochs,
  };
  if (!name) {
    return { ...base, known: false, belongs: null, stale: null, note: '没拿到日志文件名 —— 判断不了这份日志属于哪一局。' };
  }
  if (Number.isFinite(runEpochSec)) {
    if (epochs.indexOf(Number(runEpochSec)) >= 0) {
      return { ...base, known: true, belongs: true, stale: false, note: '这份 .gia 里有本次会话那一局（epochSec ' + runEpochSec + '）的记录。' };
    }
    /*
     * ★★ 容差匹配（反馈 A8）：开跑信号 epoch 与 `.gia` 文件名 epoch 差 1 秒是**正常的**
     *    （后者取自脚本首次 print 的时刻）⇒ 精确匹配会把本局冤枉成 stale。
     */
    const near = epochs.find((e) => Math.abs(e - Number(runEpochSec)) <= RUN_EPOCH_TOLERANCE_SEC);
    if (near != null) {
      const gap = Math.abs(near - Number(runEpochSec));
      return {
        ...base, known: true, belongs: true, stale: false, matchedEpochSec: near, epochGapSec: gap,
        note: '这份 .gia **属于本次会话那一局**（开跑 epochSec ' + runEpochSec + '；`.gia` 记的是 ' + near
          + '，差 ' + gap + ' 秒 ≤ 容差 ' + RUN_EPOCH_TOLERANCE_SEC + ' 秒 —— `.gia` 的 epoch 取自**脚本首次 print 的时刻**，'
          + '晚于开跑信号，属正常，不是旧局）。',
      };
    }
    if (!epochs.length) {
      return {
        ...base, known: false, belongs: null, stale: null,
        note: '这份 .gia 里没有读到任何「试玩局」记录（只有编辑器主屏会话？）—— **判断不了**它是不是本次会话那一局。',
      };
    }
    return {
      ...base, known: true, belongs: false, stale: true,
      note: '⚠️ 这份 .gia 里**没有**本次会话那一局（epochSec ' + runEpochSec + '）的记录 —— '
        + '它最新的局是 epochSec ' + maxEpoch + '（' + hhmmss(maxEpoch) + '），属于**更早的某一局**。'
        + '本局多半**没有落盘**（`.gia` 只在脚本有 print 时才产生）。',
    };
  }
  if (Number.isFinite(runStartedAtMs) && Number.isFinite(fileMtimeMs)) {
    const stale = Number(fileMtimeMs) < Number(runStartedAtMs);
    return {
      ...base, known: true, belongs: !stale, stale,
      note: stale
        ? '⚠️ 这份 .gia 的最后写入时刻早于本次会话开跑时刻 —— 它属于**更早的某一局**。'
        : '这份 .gia 的最后写入时刻不早于本次会话开跑时刻（只按时间粗判，没有 epoch 可对）。',
    };
  }
  return { ...base, known: false, belongs: null, stale: null, note: '没有「本次会话」的对比基准（没扫到试玩日志 / 这一局没有开跑时刻），判断不了归属。' };
}

/**
 * 「本局的 `.gia` 落盘了没有」—— **纯函数**（只吃已经读出来的事实，不做文件 I/O，好单测）。
 *
 * 为什么要单独一句（反馈 A2 ①）：`op=status` 以前只回「现在在不在试玩」，
 * 而「本局的运行时日志到底有没有」要人自己去翻目录 —— 实测正是这一环让人把**上一局**的日志当成本局的。
 *
 * @param {{latest?:any, running?:boolean, runEpochSec?:number|null, runStartedAtMs?:number|null,
 *          fileEpochSecs?:number[], readError?:string|null}} [input]
 * @returns {{status:string, landed:boolean|null, file:string|null, note:string, hint:string|null}}
 *   `status`：`running`（本局还在跑）/ `landed`（已落盘）/ `missing`（未落盘）/ `none`（整个目录都没有）/ `unknown`
 *   `hint`：**只有**「本局缺 + 文件里有更早的局」时给一句醒目提示（`.gia` 落盘会失败 ⇒ 别只看日志），其余档 `null`
 */
export function giaLandingState({ latest = null, running = false, runEpochSec = null, runStartedAtMs = null, fileEpochSecs = [], readError = null } = {}) {
  const file = latest && latest.name ? String(latest.name) : null;
  if (running) {
    return {
      status: 'running', landed: false, file, hint: null,
      note: '本局 `.gia`：**未落盘** —— 本局还在跑。⚠️ 口径（2026-09-30 实测核过）：`.gia` 是**这一局停下来之后**才写的，'
        + '所以**局中读本局读不到**（同一份 `output_log.txt` 里只有开跑/结束标记，脚本 print 不进它；实测局中按局号直读 → "没有这个局的记录"）。'
        + '⇒ 局中要看状态只能**截图**（`miliastra_shot`）；**一停就能读**（实测一局 14 秒、`.gia` 9 秒后落盘）。'
        + '⚠️ 局中读不到本局 **≠** 脚本没跑。',
    };
  }
  if (!file) {
    return { status: 'none', landed: false, file: null, hint: null, note: '本局 `.gia`：**未落盘**（日志目录里一个 .gia 都没有）。' };
  }
  if (!Number.isFinite(runEpochSec) && !Number.isFinite(runStartedAtMs)) {
    return { status: 'unknown', landed: null, file, hint: null, note: '本局 `.gia`：**判断不了** —— 没读到任何一局的开跑记录（输出日志里没有开跑标记）。' };
  }
  const f = logFreshness({
    file,
    fileEpochSecs,
    runEpochSec,
    runStartedAtMs,
    fileMtimeMs: latest && latest.mtime ? Date.parse(latest.mtime) : null,
  });
  if (readError) {
    return {
      status: 'unknown', landed: null, file, hint: null,
      note: '本局 `.gia`：**判断不了** —— 读最新那个日志文件失败（' + readError + '）；它是 ' + f.logBelongsTo + '。',
    };
  }
  if (f.belongs === true) {
    return {
      status: 'landed', landed: true, file, hint: null,
      note: '本局 `.gia`：**已落盘**（' + file + (Number.isFinite(runEpochSec) ? '，含 epochSec ' + runEpochSec + ' 那一局' : '') + '）。',
    };
  }
  if (f.belongs === false) {
    /*
     * ★★ 只给"未落盘"是**会误导人的**（2026-09-30 真机实测：本局没落盘、更早的局落了、
     *   而画面其实是正常的，人被这句话骗成"脚本层没跑"）⇒ 按 `landingMisleadingHint` 加一条醒目提示。
     */
    const hint = landingMisleadingHint({ fileEpochSecs, sessionEpochSec: runEpochSec, status: 'missing' });
    return {
      status: 'missing', landed: false, file,
      note: '本局 `.gia`：**未落盘**（可能该局不产生 —— 实测「脚本一条 print 都没有」的局就不会有 .gia）。'
        + '目录里最新那个是 ' + f.logBelongsTo + '，**不是本局**。',
      hint,
    };
  }
  return { status: 'unknown', landed: null, file, hint: null, note: '本局 `.gia`：**判断不了** —— ' + f.note };
}

/* ================================ 「像报错」的行：按**形态**捞，不看标签（2026-09-30） */

/**
 * ★★ 为什么要有这一节（真机实战，本会话最值钱的一条）：
 *
 * 真机上那条致命的报错长这样 —— **它没有任何 `[标签]` 前缀**：
 * ```
 * 缺少交接值 CONFIG.CONTAINER_INDEX：粒子父容器的控件节点索引，必须由创作者交接（脚本不会猜、不会写假索引）
 * stack traceback:
 *     特效 fx:428: in function 'requireHandover'
 *     特效 fx:1611: in function 'OnStart'
 * ```
 * ⇒ 按 `op=tags` / `op=grep tag=...` 全都捞不到它（作者连猜 4 轮关键词才找到）。
 * ⇒ 所以必须有**按形态**捞的一路：只看"这行像不像 Lua 报错/堆栈"，跨全部 channel。
 *
 * ⚠️ `file-line` 与 `error` 是**最弱**的两条形态（正常日志里也可能出现 `文件:行号` 或英文 error），
 * 所以它们排在最后：**只在这条记录没命中更具体的形态时**才作为 kind 报出。
 */
export const ERROR_FORMS = [
  { kind: 'handover-missing', re: /缺少交接值/ },
  { kind: 'instantiate-nil', re: /instantiate[^\n]*nil|nil[^\n]*instantiate|实例化[^\n]*nil/i },
  { kind: 'attempt-index', re: /attempt to index/ },
  { kind: 'attempt-call', re: /attempt to call/ },
  { kind: 'nil-value', re: /nil value/ },
  { kind: 'stack-traceback', re: /stack traceback/ },
  { kind: 'file-line', re: /\.lua:\d+|\S+:\d+:\s*in function/ },
  { kind: 'error', re: /\berror\b|报错|异常/ },
];

/** 每条形态"人话叫什么"（回执里给 AI 看，省得它去猜 kind 的含义）。 */
export const ERROR_KIND_LABELS = {
  'handover-missing': '缺少交接值（真机原文：`缺少交接值 CONFIG.…`）',
  'instantiate-nil': '实例化返回 nil',
  'attempt-index': '`attempt to index`（对 nil 取字段）',
  'attempt-call': '`attempt to call`（对 nil 调函数）',
  'nil-value': '`nil value`',
  'stack-traceback': '`stack traceback`（Lua 堆栈）',
  'file-line': '`文件:行号`（Lua 源码位置）',
  error: '含 `error` / 报错 / 异常字样（最弱的一条形态）',
};

/**
 * 弱形态（`error` / 报错 / 异常）的**否定式**：脚本自己明说"**不是**异常 / 没有报错"时，**不算错误**。
 *
 * 为什么必须有（2026-09-30 实测抓到的假阳性）：
 *   本工程有一条**诊断**日志 —— `[特效:sword-river/diag] script.object.parent = nil ⇒ 到这里没有父节点了（读到 nil，不是异常）`。
 *   它字面上含「异常」二字，于是被最弱的那条形态捞成 3 条"报错"，而它其实是**脚本主动说明这不是异常**。
 *   这类假阳性会直接侵蚀 `op=errors` 的可信度 ⇒ 只对**最弱形态**加这一道否定过滤；
 *   具体形态（堆栈 / attempt to / nil value / 缺少交接值 / 文件:行号）**一律不受影响**。
 */
const RE_ERROR_NEGATED = /(不是|不算|并非|没有|无)\s*(异常|报错|错误)/;

/**
 * 从一段正文里解析 `文件:行号` —— **真机的报错行就用这个格式**（`特效 fx:428: in function 'requireHandover'`）。
 *
 * 为什么不能只认 `.lua:`：真机打印的是**脚本的显示名**（`特效 fx`），**不带 `.lua` 后缀**。
 *
 * @returns {{file:string, line:number, raw:string}|null}
 */
export function parseFileLine(message) {
  const text = String(message || '');
  const pats = [
    /([^\s:：][^\n:：]*?\.lua):(\d+)/,                     // ① 带 .lua（本地文件 / 源码路径）
    /([^\s:：][^\n:：]*?):(\d+):\s*in function/,            // ② 真机形态：`特效 fx:428: in function 'x'`
    /^[ \t]*([^\s:：\d][^\n:：]*?):(\d+)(?::|\s|$)/m,       // ③ 兜底：`文件:行号`（首字符不能是数字 ⇒ 排除 `01:36:27` 那种时间戳）
  ];
  for (const re of pats) {
    const m = re.exec(text);
    if (!m) continue;
    const file = String(m[1]).trim().replace(/^\[[^\]]{1,40}\]\s*/, '');   // 去掉 `[侦探1/view] ` 这类标签前缀
    const line = Number(m[2]);
    // 首字符是数字 ⇒ 多半是 `01:36:27` 这类时间戳，不是文件行号
    if (!file || /^\d/.test(file) || !Number.isFinite(line)) continue;
    return { file, line, raw: m[0] };
  }
  return null;
}

/**
 * 按**形态**捞「像报错」的记录 —— **纯函数，不看标签、跨全部 channel**。
 *
 * @param {Array<any>} records `readGia()` 的记录
 * @param {{limit?:number}} [opts]
 * @returns {{errors:Array<any>, count:number, total:number, truncated:boolean,
 *            kindCounts:Record<string,number>, runsAffected:number, runs:number[], channels:number}}
 */
export function findErrorRecords(records, { limit = 200 } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 200;
  const all = [];
  for (const r of Array.isArray(records) ? records : []) {
    const msg = String((r && r.message) || '');
    if (!msg) continue;
    const kinds = ERROR_FORMS.filter((f) => f.re.test(msg)).map((f) => f.kind);
    if (!kinds.length) continue;
    // ★ 只命中「最弱形态」且脚本自己说了"不是异常/没有报错" ⇒ 假阳性，跳过
    if (kinds.length === 1 && kinds[0] === 'error' && RE_ERROR_NEGATED.test(msg)) continue;
    const inst = String((r && r.instance) || '').trim();
    const parts = inst.split('-');
    all.push({
      time: (r && r.time) || null,
      run: Number(parts[2]) || null,
      instance: inst || null,
      channel: (r && r.channel) || null,
      index: r && Number.isFinite(r.index) ? r.index : null,
      kind: kinds[0],
      kinds,
      message: msg,
      fileLine: parseFileLine(msg),
    });
  }
  const errors = all.slice(0, cap);
  const kindCounts = {};
  for (const e of all) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  const runs = [...new Set(all.map((e) => e.run).filter((n) => Number.isFinite(n) && n > 0))];
  const channels = new Set(all.map((e) => e.channel).filter(Boolean));
  return {
    errors, count: all.length, total: all.length, truncated: all.length > cap,
    kindCounts, runsAffected: runs.length, runs, channels: channels.size,
  };
}

/** 一条都没捞到时的**可执行**提示（别只说"没有"）。 */
export const NO_ERRORS_HINT = '本局 `.gia` 里**没有任何报错形态**（按形态捞的：`stack traceback` / `attempt to index` / '
  + '`attempt to call` / `nil value` / `缺少交接值` / `文件:行号` / `instantiate…nil` / `error`）。'
  + '⚠️ 若**画面不对但也没有报错**，别在日志里继续翻了 —— 优先查**层级/可见性**：'
  + '控件全建出来了、日志干干净净，却被后建的全屏背景盖住，这是本工程最高发的"整屏什么都没有"'
  + '（见 `docs/千星奇域_层级与渲染顺序问题.md`）。**画面判据用 `miliastra_shot`**，不是日志。';

/** 捞到了报错时的一句方法论提示（解释"为什么按 tag 捞不到"）。 */
export const ERRORS_TAG_HINT = '★ 这一路是按**形态**捞的、**不看标签** —— 真机的报错行**可能完全没有 `[...]` 前缀**'
  + '（实测：`缺少交接值 CONFIG.CONTAINER_INDEX：…` + `stack traceback:` + `特效 fx:428: in function \'…\'`），'
  + '所以 `op=tags` / `op=grep tag=` **捞不到它**。定位到行号后，直接去那份 `.lua` 的第 N 行看。';

/**
 * ★★ 「`.gia` 落盘不稳定」的**醒目提示**（2026-09-30 真机实战）。
 *
 * 事实：同一段流程里，**本局没有 `.gia`、但更早的局有** —— 而且**画面其实是正常的**。
 * 我们旧版只给一句中性的"未落盘"，实测它会把人（和 AI）误导成"脚本层没跑"。
 * ⇒ 所以只要「本局缺 + 文件里有更早的局」就加这一条，明确说：**这不代表本局脚本没跑，判画面用截图**。
 *
 * @returns {string|null} 不满足条件时 `null`（也就是"不该说这句话"时不说）
 */
export function landingMisleadingHint({ fileEpochSecs = [], sessionEpochSec = null, status = null } = {}) {
  if (status !== 'missing' && status !== 'stale') return null;
  const epochs = (Array.isArray(fileEpochSecs) ? fileEpochSecs : []).filter((e) => Number.isFinite(e) && e > 0);
  if (!epochs.length) return null;
  return '⚠️ 本局 `.gia` **未落盘**，但**更早的局落了**（目录里那份含 epochSec ' + epochs.join(' / ') + '）'
    + '⇒ **这不代表本局脚本没跑** —— 实测 `.gia` 落盘会因时序失败（同一段流程里画面其实是正常的）。'
    + '**判画面请用 `miliastra_shot`（截图）**，别只看日志；'
    + '要拿到本局日志就先确认编辑器「日志」面板勾了**客户端脚本**，并在这一局**结束后**再看。';
}

/**
 * 每局的精简摘要（给 AI / 人看的那一份）。 */
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
