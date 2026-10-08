/**
 * `miliastra_playtest` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { SHOT_TARGETS, captureWindow, frameInRun, judgeCapture, nextFreeName, shotFileName, shotsDir, thumbPathFor } from '../shot.mjs';
import { createPlaytestState, logSize, playtestLogPath, playtestSummary, readIncrement, reduceLogLines, scanLog, shouldHit } from '../playtest.mjs';
import { giaLandingState, giaRunEpochs, readGia } from '../gia.mjs';
import { HttpError, clampNum, resolveLevel, sleep, waitForPlaytestStart } from '../shared.mjs';

/**
 * 「本局的 `.gia` 落盘了没有」—— 反馈 A2 ①。
 *
 * 为什么要有这一句（2026-09-25 同事实测）：16:23 / 16:26 / 16:29 / 16:34 四局结束后**都没有生成 `.gia`**，
 * 而 `op=grep`/`op=runs` 会静默回退到 16:16 那局的旧文件 —— 子代理三次抓取都把旧局当成了本局。
 * 所以状态里必须直接写明「已落盘 / 未落盘（可能该局不产生）」，而不是让人自己去看目录时间。
 *
 * 判据是**文件里有没有本局那个 epochSec**（`giaRunEpochs`）：`.gia` 的 instance 第三段就是开跑时刻，
 * 与 `miliastra_playtest` 报的是同一个值 —— 这比「比 mtime」准（mtime 分不清「本局」与「更晚的另一局」）。
 */
export function giaLandingFor(lv, state) {
  const latest = lv && lv.latestLog ? lv.latestLog : null;
  const running = !!(state && state.inPlaytest);
  const last = state && state.runs && state.runs.length ? state.runs[state.runs.length - 1] : null;
  const runEpochSec = running ? state.epochSec : (last ? last.epochSec : null);
  const runStartedAtMs = running ? state.startedAtMs : (last ? last.startedAtMs : null);
  let fileEpochSecs = [];
  let readError = null;
  if (latest && latest.path && !running) {
    try {
      const g = readGia(latest.path);
      if (g.ok) fileEpochSecs = giaRunEpochs(g.records);
      else readError = g.error;
    } catch (e) { readError = (e && e.message) || String(e); }
  }
  const land = giaLandingState({ latest, running, runEpochSec, runStartedAtMs, fileEpochSecs, readError });
  return {
    ...land,
    runEpochSec: Number.isFinite(runEpochSec) ? runEpochSec : null,
    runStartedAt: last ? (last.startedAtText || null) : (running ? state.startedAtText : null),
    fileEpochSecs,
    note2: '⚠️ `.gia` **只在脚本真的 print 出东西时才产生** —— 「未落盘」不等于「没试玩」，'
      + '它等于「这一局没有任何客户端脚本日志」。原因与复测口径见 `docs/功能详解.md`。',
  };
}

/**
 * `op=arm` —— **「武装后台截图」**（反馈 D1）：一次调用完成「等新局开跑 → 按给定秒点抓拍 → 落盘 → 回执」。
 *
 * 为什么要有它（2026-09-25 同事实测）：只能靠「人先在编辑器点试玩、再叫 AI」或靠子代理后台等，而那条路踩了三个坑：
 *   ① `backSec` 回扫**命中已结束的旧局**（拍到的是局外画面）；
 *   ② 等待期间那一局已经结束；
 *   ③ 连拍每次 2.6 秒，短局（<20 秒）根本追不上「加载窗口 + 连拍」。
 * 这里把「秒点」交给调用方（`afterSec:[8,12,16,20]`）：每个秒点**只拍一张**，
 * 局一结束就停（剩下的秒点如实标 `skipped`），并在回执里逐张标 `inRun`。
 *
 * @param {Record<string, any>} args `afterSec`（秒点数组）/ `target` / `label` / `timeoutSec` / `backSec` / `pollMs`
 * @param {any} lv `resolveLevel()` 的结果（关卡）
 */
export async function armPlaytestShots(args, lv) {
  const targetKey = String(args.target || 'game');
  const tgt = SHOT_TARGETS[targetKey] || null;
  const processName = String(args.process || (tgt ? tgt.process : targetKey) || '').replace(/\.exe$/i, '');
  const dir = shotsDir();
  const timeoutSec = clampNum(args.timeoutSec, 300, 5, 3600);
  /*
   * ★★ 秒点取值（2026-09-30 反馈 A9）：**不许静默降级**。
   *   `afterSec` 是 `oneOf`（wait 数字 / arm 数组）—— 实测数组会被参数校验吃掉，
   *   于是**静默回落默认值**，调用方以为自己的秒点生效了（它就是按默认值拍的）。
   *   ⇒ ① 专用参数 `afterSecPoints`（arm 请用它）；② `afterSec` 仍兼容（数组照用、单个数字当一点）；
   *      ③ **用了默认值必须自己说出来**（`pointsFromDefault:true` + note），把"静默"变成"有据可查"。
   */
  const rawPoints = Array.isArray(args.afterSecPoints) ? args.afterSecPoints
    : (Array.isArray(args.afterSec) ? args.afterSec
      : (typeof args.afterSec === 'number' && Number.isFinite(args.afterSec) ? [args.afterSec] : null));
  const pointsFromDefault = !(rawPoints && rawPoints.length);
  const points = [...new Set((pointsFromDefault ? [8, 12, 16, 20] : rawPoints)
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x) && x >= 0 && x <= 600))]
    .sort((a, b) => a - b)
    .slice(0, 12);
  if (!points.length) throw new Error('op=arm 的秒点至少要有一个 0~600 的数字，例如 `afterSecPoints:[8,12,16,20]`');
  if (!processName) throw new Error('op=arm 没给出要截哪个进程（target/process 都是空的）。');

  /* ★ 非阻塞（A9 第 2 条）：只回"计划"，不等开跑、不拍 —— 长阻塞调用不该拖死会话节奏。 */
  if (args.wait === false) {
    return {
      ok: true, op: 'arm', blocking: false, armed: false,
      level: { brand: lv.brand, levelId: lv.levelId },
      target: targetKey, process: processName, dir,
      points, pointsFromDefault, timeoutSec, waitedSec: 0, shots: [], inRunCount: 0,
      note: '⚠️ `wait:false` ⇒ **这次没有等、也没有拍**（只把计划回给你）。要真抓拍就再调一次（省略 `wait`）。',
      nextSteps: '要抓拍：直接再调一次 `op=arm`（不传 `wait`）；或先 `op=status` 看现在在不在试玩。',
    };
  }

  const w = await waitForPlaytestStart(lv, {
    timeoutSec,
    // ⚠️ 默认**不回扫**：`backSec` 回扫会命中「已经结束的旧局」，那正是这个工具要消灭的坑之一
    backSec: clampNum(args.backSec, 0, 0, 3600),
    pollMs: clampNum(args.pollMs, 400, 100, 5000),
  });
  const baseOut = {
    ok: true, op: 'arm', level: { brand: lv.brand, levelId: lv.levelId },
    target: targetKey, process: processName, dir,
    points, pointsFromDefault, timeoutSec, waitedSec: w.waitedSec,
    note: pointsFromDefault
      ? '⚠️ 没收到秒点 ⇒ 用的是**默认** `[8,12,16,20]`。arm 请传 `afterSecPoints:[…]`（数组走 `afterSec` 可能在参数校验那一层被吃掉）。'
      : undefined,
  };
  if (!w.hit) {
    return Object.assign(baseOut, {
      hit: false, timedOut: true, shots: [], inRunCount: 0,
      hint: '这段时间里没有新的「试玩开跑」，所以**一张都没拍**（不白耗）。'
        + '确认人在编辑器里真的点了「试玩」；刚点过一小会儿就用 `backSec=60` 回扫那一局（但要注意那是**已经过去**的局）。',
    });
  }

  /** @type {any} */
  const sum = w.summary || {};
  const last = sum.lastRun || null;
  const endedAlready = !sum.inPlaytest && last && last.epochSec === w.epochSec;
  const runWindow = {
    startedAtMs: Number.isFinite(w.atMs) ? w.atMs : null,
    endedAtMs: endedAlready && Number.isFinite(last.endedAtMs) ? last.endedAtMs : null,
  };
  const head = Object.assign(baseOut, {
    hit: true, backHit: w.backHit,
    startedAt: w.startedAt, startedAtMs: runWindow.startedAtMs, epochSec: w.epochSec, token: w.token,
    endedAtMs: runWindow.endedAtMs,
  });
  if (endedAlready) {
    // 回扫命中的**已经结束**的局：一张都不拍（拍了也是局外画面），但把话说清楚
    return Object.assign(head, {
      shots: points.map((p) => ({ afterSec: p, skipped: true, reason: 'run-ended', file: null, inRun: false })),
      inRunCount: 0, endedBeforeFirstShot: true,
      hint: '⚠️ 命中时这一局**已经结束了**（`backSec` 回扫到的旧局）—— 按你的秒点拍出来的都会是**局外画面**，所以一张都没拍。'
        + '去掉 `backSec`（默认 0）就会等**下一次**开跑。',
    });
  }

  // 结束标记的观测基线：从命中那一刻**之后新增的字节**里找，不会把上一局的结束当成这一局的
  const watchPath = playtestLogPath(lv.brand);
  let watchOffset = logSize(watchPath);
  let endEvent = null;
  const checkEnd = () => {
    if (endEvent || !Number.isFinite(watchOffset)) return endEvent;
    const inc = readIncrement(watchPath, watchOffset);
    if (!inc.ok) return null;
    if (inc.rotated) { watchOffset = inc.size; return null; }   // 游戏重启换代：重新对齐，不当成「结束」
    if (!inc.text) return null;
    watchOffset = inc.size;
    const red = reduceLogLines(createPlaytestState(), inc.text.split(/\r?\n/));
    const e = (red.events || []).find((x) => x.type === 'end');
    if (e) endEvent = e;
    return endEvent;
  };

  fsMod.mkdirSync(dir, { recursive: true });
  const shots = [];
  let stoppedBecause = null;
  for (const pt of points) {
    const deadline = (Number.isFinite(runWindow.startedAtMs) ? runWindow.startedAtMs : Date.now()) + pt * 1000;
    for (;;) {
      if (checkEnd()) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(400, left));
    }
    if (endEvent) {
      stoppedBecause = 'run-ended';
      shots.push({ afterSec: pt, skipped: true, reason: 'run-ended', file: null, inRun: false });
      continue;
    }
    const name = nextFreeName(dir, shotFileName({
      target: targetKey,
      label: (args.label ? String(args.label) : 'arm') + '-' + pt + 's',
      when: new Date(),
    }));
    const r = await captureWindow({
      processName, out: pathMod.join(dir, name),
      thumbOut: thumbPathFor(dir, name),
      bringToFront: args.bringToFront === false ? 0 : 1,
    });
    const judge = judgeCapture(r);
    const atMs = Date.now();
    let size = null;
    try { size = fsMod.statSync(r.path).size; } catch { /* 没落盘也照报 */ }
    shots.push({
      afterSec: pt, file: r.ok ? name : null, atMs,
      elapsedMs: Number.isFinite(runWindow.startedAtMs) ? atMs - runWindow.startedAtMs : null,
      ok: r.ok, suspect: judge.suspect, warning: judge.warning,
      inRun: frameInRun(atMs, runWindow),
      error: r.ok ? null : (r.error || '截图失败'),
    });
    if (!r.ok) { stoppedBecause = 'shot-failed'; break; }
    checkEnd();                      // 拍完这一张立刻看一眼局是不是刚结束
  }

  // 收尾：把「这一局结束了没有 / `.gia` 落盘了没有」刷新成**此刻的事实**
  const fresh = scanLog(playtestLogPath(lv.brand));
  const freshState = fresh.ok ? fresh.state : null;
  const freshLast = freshState && freshState.runs.length ? freshState.runs[freshState.runs.length - 1] : null;
  if (freshLast && freshLast.epochSec === w.epochSec && Number.isFinite(freshLast.endedAtMs)) {
    runWindow.endedAtMs = freshLast.endedAtMs;
  }
  // 窗口补全后逐张重算 inRun（拍的时候可能还不知道结束时刻）
  for (const s of shots) if (!s.skipped) s.inRun = frameInRun(s.atMs, runWindow);
  const inRunCount = shots.filter((s) => s.inRun === true).length;
  const captured = shots.filter((s) => !s.skipped).length;
  return Object.assign(head, {
    endedAtMs: runWindow.endedAtMs,
    durationSec: Number.isFinite(runWindow.endedAtMs) && Number.isFinite(runWindow.startedAtMs)
      ? Math.round((runWindow.endedAtMs - runWindow.startedAtMs) / 1000) : null,
    stoppedBecause: stoppedBecause || (freshState && !freshState.inPlaytest ? 'run-ended' : null),
    shots, capturedCount: captured, inRunCount, skippedCount: shots.length - captured,
    localGia: freshState ? giaLandingFor(lv, freshState) : null,
    hint: '每张正片走 `GET /miliastra/shot?name=<file>` 看原图（`&thumb=1` 看小图）。'
      + '`shots[].inRun` 说明**这张是不是在本局窗口内**拍的；窗口外的图别当证据。'
      + '本局的运行时日志（`.gia`）要等这一局**停下来之后**才落盘（实测局中读不到本局；一停通常几秒内就写好）—— 看 `localGia`；'
      + '没落盘时常见原因是「这一局没有任何客户端脚本日志」。',
  });
}

export const PLAYTEST_TOOL = {
    name: 'miliastra_playtest',
    description:
      TITLE + '：**试玩开跑 / 结束的实时侦测** —— 「在不在试玩 / 开跑到第几秒」，并能**等下一次开跑**。信号来自游戏客户端自己写的 `output_log.txt`（**实测延迟 0.07~0.18 秒**；平台级标记：脚本一行都不 print 的局照样记）。⚠️ **别用 `.gia` 判开跑** —— 它不是实时的（**局在跑的时候磁盘上根本没有这个文件**）。op=status 看状态；op=wait 等下一次开跑（`afterSec` = 开跑 N 秒后；超时**不报错**，如实回 `hit:false`）。\n★ **`op=arm`（武装后台截图）**：一次调用完成「等开跑 → 按秒点抓拍 → 落盘」（秒点用 `afterSecPoints`；`wait:false` = 只回计划），局一结束就停。\n★ **`op=status` 的 `localGia`** 直接回答「本局 `.gia` 落盘了没有」——`missing` 时 `miliastra_log` 取到的是**更早那一局**。\n\n**典型调用**：`{"op":"status"}`｜`{"op":"arm","afterSecPoints":[8,12,16,20]}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['status', 'wait', 'arm'], description: '默认 status。**arm = 武装后台截图**：按 `afterSecPoints` 秒点各拍一张（局结束就停），回执逐张给路径 + `inRun`。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用来定位该品牌的 output_log.txt）。' },
        backSec: { type: 'number', description: 'op=wait/arm：回扫窗口秒数（默认 0）。⚠️ op=arm 回扫会命中**已结束**的旧局（拍到的是局外画面），所以默认 0。' },
        timeoutSec: { type: 'number', description: 'op=wait：最多等多少秒（默认 90，上限 300）；op=arm：默认 300（上限 3600）。' },
        /*
         * ⚠️ `afterSec` 有两种取法（op=wait 传**数字**、op=arm 传**秒点数组**），但 DSH 的工具 schema
         * **子集只收单个 `type` 字符串** —— `type: ['number','array']` 会被注册期校验直接拒掉
         * （实测报 `type arrays are not supported`；试玩探针见 `tests/feedback3-test.mjs` 里那条断言）。
         * 所以这里用子集支持的 `oneOf`（exact-one）表达同样的能力。
         */
        afterSec: {
          oneOf: [
            { type: 'number' },
            { type: 'array', items: { type: 'number' } },
          ],
          description: 'op=wait 的等待秒数；op=arm 用 `afterSecPoints`。',
        },
        /* ★ arm 的秒点单开一个参数（2026-09-30 反馈 A9）：数组走 `oneOf` 那一层会被吃掉并**静默回落默认值**。 */
        afterSecPoints: {
          type: 'array', items: { type: 'number' },
          description: 'op=arm 的秒点数组（≤12，如 `[8,12,16,20]`）—— arm 请用它。',
        },
        wait: { type: 'boolean', description: 'op=arm：`false` = 非阻塞（只回计划，不等不拍）。' },
        target: { type: 'string', enum: Object.keys(SHOT_TARGETS), description: 'op=arm：截哪个窗口（默认 game=游戏客户端）。' },
        process: { type: 'string', description: 'op=arm：直接指定进程名（覆盖 target）。' },
        label: { type: 'string', description: 'op=arm：文件名里的用途标签（默认用 `arm-<秒点>s`）。' },
        pollMs: { type: 'number', description: 'op=wait/arm：轮询间隔毫秒（默认 400，100~5000）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'status');
      if (op !== 'status' && op !== 'wait' && op !== 'arm') throw new HttpError('op 只能是 status / wait / arm，收到：' + op, 400);
      const lv = resolveLevel(args.level);
      const logPath = playtestLogPath(lv.brand);
      const base = scanLog(logPath);
      if (!base.ok) {
        throw new HttpError(
          '读不到试玩日志 ' + logPath + '（' + (base.error || '未知原因') + '）。'
          + '这个文件由游戏客户端在启动时创建 —— 确认 ' + lv.brand + ' 客户端开着、且这台机器上跑过。',
          404,
        );
      }
      const common = {
        level: { brand: lv.brand, levelId: lv.levelId },
        logPath,
        logSize: base.size,
        logTruncated: base.truncated,
        newestGia: lv.latestLog ? { name: lv.latestLog.name, size: lv.latestLog.size, mtime: lv.latestLog.mtime } : null,
      };

      if (op === 'status') {
        return {
          ok: true, op, ...common, ...playtestSummary(base.state),
          // ★ 本局 `.gia` 落盘了没有（反馈 A2 ①）：没有这一句时，人很容易把上一局的日志当成本局的证据
          localGia: giaLandingFor(lv, base.state),
          note: '开跑/结束读的是 output_log.txt（**实时**，实测延迟 0.07~0.18 秒）。'
            + '⚠️ 但**脚本自己的 print 不实时**：`.gia` 是**这一局停下来之后**才写的 —— '
            + '实测同一份 `output_log.txt` 里搜脚本正文（`[夏祭]` / `粒子池就绪` 等）**0 命中**，局中按局号直读也不到本局；'
            + '`LocalLog.log` 是游戏客户端的网络/引擎日志，同样没有。'
            + '⇒ **局中要看状态只能截图**；**一停就能读**（实测一局 14 秒、`.gia` 9 秒后落盘）。'
            + '`localGia` 直接回答「本局的 `.gia` 到底有没有」；未落盘时 `miliastra_log` 取到的是**更早的某一局**。'
            + '（`lastRun.durationSec` 在 `closed:"implicit"` 时是**上界**，见 `durationInferred`。）',
        };
      }

      /* op === 'arm' —— 「武装后台截图」（反馈 D1）：**不依赖 base 的扫描结果**，自己等新局 */
      if (op === 'arm') return await armPlaytestShots(args, lv);

      /* op === wait —— 判据走 waitForPlaytestStart（与 miliastra_shot op=burst 是同一份） */
      const timeoutSec = clampNum(args.timeoutSec, 90, 5, 300);
      const afterSec = clampNum(args.afterSec, 0, 0, 120);
      const w = await waitForPlaytestStart(lv, {
        timeoutSec,
        backSec: clampNum(args.backSec, 0, 0, 3600),
        pollMs: clampNum(args.pollMs, 400, 100, 5000),
      });

      if (!w.hit) {
        return {
          ok: true, op, ...common,
          hit: false, timedOut: true, waitedSec: w.waitedSec, timeoutSec,
          hint: '这段时间里没有新的「试玩开跑」。确认人在编辑器里真的点了「试玩」；'
            + '如果是刚点过一小会儿，用 backSec=60 回扫那一局。',
        };
      }

      if (afterSec > 0) await sleep(afterSec * 1000);
      // 等完 afterSec 之后**重新扫一遍**再报状态：「还在不在试玩」必须是此刻的事实，不是命中那一刻的
      const fresh = scanLog(w.logPath);
      const now = fresh.ok ? playtestSummary(fresh.state) : w.summary;
      return {
        ok: true, op, ...common,
        hit: true, backHit: w.backHit,
        startedAt: w.startedAt,
        startedAtMs: Number.isFinite(w.atMs) ? w.atMs : null,
        epochSec: w.epochSec,
        token: w.token,
        waitedSec: w.waitedSec, afterSec,
        inPlaytest: now.inPlaytest,
        elapsedSec: now.elapsedSec,
        stillRunning: now.inPlaytest,
        nextSteps: '**一条调用就够**：`miliastra_shot op=burst awaitPlaytest:true afterSec=' + afterSec + ' count=5`'
          + ' —— 它会等开跑、再等 N 秒、然后连拍。只要一张就用 `miliastra_shot op=capture`；'
          + '运行时日志（.gia）要等这一局结束之后再 `miliastra_log`。',
      };
    },
  };
