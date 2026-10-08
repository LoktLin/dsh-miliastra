/**
 * `miliastra_shot` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { ReceiptCode } from '../receipt.mjs';
import { SHOT_TARGETS, burstSummary, captureWindow, dataRoot, humanSize, judgeCapture, listShots, markSelectedCandidate, nextFreeName, planBurst, planClean, removeShots, sanitizeLabel, shotFileName, shotsDir, thumbPathFor } from '../shot.mjs';

import { clientProcesses } from '../proc.mjs';
import { createPlaytestState, logSize, playtestLogPath, readIncrement, reduceLogLines } from '../playtest.mjs';
import { PREFIX, clampNum, pathBasenameOf, resolveLevel, sleep, waitForPlaytestStart } from '../shared.mjs';

export const SHOT_TOOL = {
    name: 'miliastra_shot',
    description:
      TITLE + '：截图 —— 把「现在画面上是什么」变成一张 PNG（日志只能回答「代码跑了没」）。`op=capture`（默认）立刻截一张（`target=game` 原神 / `editor` 沙箱，也可 `process` 指任意进程）；`list` 看截到哪去了；`clean` 清理**默认只报告不删**。**截图存在插件数据目录**（`MILIASTRA_DATA_DIR` 可覆盖，不在游戏存档）—— **不会自动删**（要 `all`/`olderThanDays` + `confirm:true`）。回执恒带 `pid/process/title` + **候选窗口清单**（同进程多窗口逐条给尺寸/是否最小化 + 选中哪个）—— **截到的到底是哪个窗口**必须看得见；`suspect` 只在判得出来时给（进程对不上 / 全黑 / 单色…），**画面内容本工具不识别**。\n★ **连拍每张约 2.6~3.5 秒**（`burstMs` 再小也无效）；**短局（<20 秒）别"等 8 秒再连拍 4 张"**（会全落局外）—— 用 `op=burst awaitPlaytest:true startAfterSec:<小值> untilGone:true`。选窗/缩略图/时序完整说明见 `docs/功能详解.md` §截图。\n\n**典型调用**：`{"op":"capture","target":"game"}`（现在截一张）｜`{"op":"burst","awaitPlaytest":true,"startAfterSec":1,"untilGone":true,"count":20}`（短局：命中就拍、局结束就停，逐张给 `inRun`）｜`{"op":"burst","dryRun":true}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['capture', 'burst', 'list', 'clean', 'targets'], description: '默认 capture。' },
        target: {
          type: 'string',
          enum: Object.keys(SHOT_TARGETS),
          description: '截哪个窗口：'
            + Object.keys(SHOT_TARGETS).map((k) => `${k}=${SHOT_TARGETS[k].label}(进程 ${SHOT_TARGETS[k].process})`).join('；')
            + '。默认 game。',
        },
        process: { type: 'string', description: '直接指定进程名（不带 .exe），覆盖 target。' },
        window: { type: 'string', description: '按窗口标题子串挑窗口（默认取**面积最大**的）。' },
        label: { type: 'string', description: '文件名里的标签，如「试玩第1局」（允许中文）。' },
        level: { type: 'string', description: 'op=burst（配合 awaitPlaytest）：关卡 ID / 品牌；省略=当前关卡。' },
        dir: { type: 'string', description: '覆盖截图目录（默认插件数据目录下的 shots\\）。' },
        keepLast: { type: 'number', description: 'op=clean：至少保留最新的 N 张（保护网，任何模式下都生效）。' },
        olderThanDays: { type: 'number', description: 'op=clean：只删比这个更旧的（>0 才生效）。' },
        all: { type: 'boolean', description: 'op=clean：不管新旧，除 keepLast 外全删。' },
        dryRun: { type: 'boolean', description: 'op=clean：默认 true（只报告将删哪些）。' },
        confirm: { type: 'boolean', description: 'op=clean：真删必须再传 confirm:true。' },
        bringToFront: { type: 'boolean', description: '默认 true：抓不到时把目标窗口拉到前台再抓。' },
        keepWindowOnTop: { type: 'boolean', description: '默认 false：退回屏幕抓取时临时把目标窗口置顶。' },
        count: { type: 'number', description: 'op=burst：连拍几张（默认 5，上限 20）。' },
        burstMs: { type: 'number', description: 'op=burst：两张之间的**额外等待**毫秒（默认 800）。⚠️ 不是「每 N 毫秒一张」（真实帧距看 `measuredIntervalMs`）。' },
        extraWaitMs: { type: 'number', description: 'op=burst：`burstMs` 的别名（更准确；都传时以它为准）。' },
        awaitPlaytest: { type: 'boolean', description: 'op=burst：**默认 false（立刻开拍）**；true = 「等开跑 → 再等 afterSec 秒 → 连拍」**一次调用完成**。' },
        afterSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：命中开跑后等 N 秒才开拍（默认 0，上限 120）。⚠️ 短局改用 startAfterSec + untilGone。' },
        startAfterSec: { type: 'number', description: 'op=burst：命中开跑后等 N 秒**立刻开拍**（默认 = afterSec）—— 短局给小值，配 `untilGone:true`。' },
        untilGone: { type: 'boolean', description: 'op=burst：**拍到这一局结束就自动停**（默认 false），剩余张数不再拍。' },
        timeoutSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：等开跑最多多少秒（默认 90，上限 300）。' },
        backSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：回扫窗口秒数（默认 0）。⚠️ 回扫命中的局**可能已结束**（`inRun:false`）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'capture');

      if (op === 'targets') {
        const procs = clientProcesses();
        return {
          ok: true, op,
          dir: shotsDir(),
          dataRoot: dataRoot(),
          targets: Object.keys(SHOT_TARGETS).map((k) => {
            const t = SHOT_TARGETS[k];
            const e = (procs.entries || []).find((x) => x.file.toLowerCase() === (t.process + '.exe').toLowerCase());
            return {
              target: k, label: t.label, process: t.process, why: t.why,
              running: e ? e.running : null, instances: e ? e.instances : 0,
            };
          }),
        };
      }

      const targetKey = String(args.target || 'game');
      const tgt = SHOT_TARGETS[targetKey] || null;
      const processName = String(args.process || (tgt ? tgt.process : targetKey) || '').replace(/\.exe$/i, '');
      const dir = args.dir ? pathMod.resolve(String(args.dir)) : shotsDir();

      if (op === 'list') {
        const s = listShots(dir);
        const limit = Number.isFinite(args.limit) ? args.limit : 20;
        return {
          ok: true, op, dir, exists: s.exists,
          count: s.count, totalBytes: s.totalBytes, totalText: humanSize(s.totalBytes),
          newest: s.files.length ? { name: s.files[0].name, mtime: s.files[0].mtime, size: s.files[0].size } : null,
          files: s.files.slice(0, limit).map((f) => ({ name: f.name, size: f.size, sizeText: humanSize(f.size), mtime: f.mtime })),
          truncated: s.count > limit,
          howToClean: 'miliastra_shot op=clean keepLast=5 olderThanDays=7  → 先看将删哪些；'
            + '确认后再加 dryRun=false confirm=true 真删。截图**不会自动删**。',
        };
      }

      if (op === 'clean') {
        const s = listShots(dir);
        const plan = planClean({
          files: s.files,
          keepLast: Number.isFinite(args.keepLast) ? args.keepLast : 0,
          olderThanDays: Number.isFinite(args.olderThanDays) ? args.olderThanDays : 0,
          all: args.all === true,
          now: Date.now(),
        });
        const plannedAll = plan.delete.map((f) => ({ name: f.name, sizeText: humanSize(f.size), mtime: f.mtime }));
        /*
         * ★ 2026-09-30 修：`op=clean` 原来**无视 `summaryOnly`** —— 要删 1600 多张时，
         *   `planned[]` / `removed[]` 把每条文件名都列出来（实测 ≈ 90 KB 回执）。
         *   后果很实际：**我自己就因为回执太大而绕开工具、改用 PowerShell 删** ——
         *   一个"省 token 的开关不存在"会把人逼到不安全的路上，所以这里必须给。
         *   `summaryOnly:true` ⇒ 只给**条数 + 前 5 条样例**（结论一个不少）；默认档照旧全列。
         */
        const slim = args.summaryOnly === true;
        const listField = (key, rows) => (slim
          ? { [key + 'Count']: rows.length, [key + 'Sample']: rows.slice(0, 5), [key + 'Omitted']: Math.max(0, rows.length - 5) }
          : { [key]: rows });
        const base = {
          op, dir, before: { count: s.count, totalBytes: s.totalBytes, totalText: humanSize(s.totalBytes) },
          ...listField('planned', plannedAll),
          keepCount: plan.keep.length,
          bytes: plan.bytes, bytesText: humanSize(plan.bytes),
          note: plan.note,
        };
        if (args.dryRun !== false) {
          return Object.assign({ ok: true, dryRun: true, confirmWith: 'dryRun=false confirm=true' }, base);
        }
        if (args.confirm !== true) {
          return Object.assign({
            ok: false, code: ReceiptCode.FAILED, dryRun: false,
            error: '真删要同时传 dryRun:false 与 confirm:true —— 截图删了不可恢复。',
          }, base);
        }
        const res = removeShots(plan.delete.map((f) => f.path));
        const after = listShots(dir);
        return Object.assign({
          ok: res.failed.length === 0,
          dryRun: false,
          ...listField('removed', res.removed.map((p) => pathBasenameOf(p))),
          removedCount: res.removed.length,
          failed: res.failed,
          after: { count: after.count, totalBytes: after.totalBytes, totalText: humanSize(after.totalBytes) },
        }, base);
      }

      /* ---- op=burst ----
       * 「等开跑 → 等 N 秒 → 连拍 N 张」做成**一次调用**：
       * 分成「先 op=wait 再逐个 capture」两次调用时，两次之间的往返延迟（1~3 秒）会毁掉时间精度。
       */
      if (op === 'burst') {
        const plan = planBurst({ count: args.count, intervalMs: (args.extraWaitMs != null ? args.extraWaitMs : args.burstMs) });
        let playtest = null;
        let startedAtMs = null;
        let runWindow = null;
        let lvForWatch = null;
        let watchPath = null;
        let watchOffset = null;
        let goneAt = null;
        const untilGone = args.untilGone === true;
        if (args.awaitPlaytest === true) {
          lvForWatch = resolveLevel(args.level);
          playtest = await waitForPlaytestStart(lvForWatch, {
            timeoutSec: clampNum(args.timeoutSec, 90, 5, 300),
            backSec: clampNum(args.backSec, 0, 0, 3600),
            pollMs: clampNum(args.pollMs, 400, 100, 5000),
          });
          if (!playtest.hit) {
            return {
              ok: true, op, hit: false, timedOut: true, plan,
              waitedSec: playtest.waitedSec,
              hint: '没等到「试玩开跑」，所以**一张都没拍**（不白耗）。确认人在编辑器里点了「试玩」；'
                + '刚点过一小会儿的话加 `backSec=60` 回扫那一局。',
            };
          }
          /*
           * ★ `startAfterSec`（反馈 C1 ①）：命中后等 N 秒**立刻开拍**。
           *   为什么不复用 `afterSec` 一个就够：实战里那个值被拿来当「加载窗口」（8 秒），
           *   而 16 秒的短局里 8 秒窗口 + 每次 2.6 秒的连拍 ⇒ 全落在局外。
           *   不传时**沿用 `afterSec`**（老调用的行为一个字不改），传了就单独生效。
           */
          const startAfterSec = clampNum(args.startAfterSec, clampNum(args.afterSec, 0, 0, 120), 0, 120);
          if (startAfterSec > 0) await sleep(startAfterSec * 1000);
          startedAtMs = Date.now();
          /*
           * ★ 本局窗口（反馈 C1 ③）：逐张 `inRun` 靠它算。
           *   `backSec` 回扫命中的**已经结束**的局，这里会直接拿到 `endedAtMs` ——
           *   于是那批图会被标成 `inRun:false`，而不是让人以为「拍到了」。
           */
          const sum = playtest.summary || {};
          const last = sum.lastRun || null;
          const endedAlready = !sum.inPlaytest && last && last.epochSec === playtest.epochSec;
          runWindow = {
            startedAtMs: Number.isFinite(playtest.atMs) ? playtest.atMs : null,
            endedAtMs: endedAlready && Number.isFinite(last.endedAtMs) ? last.endedAtMs : null,
          };
          if (endedAlready) {
            runWindow.warning = '⚠️ 命中时这一局**已经结束了**（多半是 `backSec` 回扫命中的旧局）——'
              + '接下来拍到的每一张都会被标 `inRun:false`。要局内画面就别把 `backSec` 放那么大。';
          }
          if (untilGone) {
            watchPath = playtestLogPath(lvForWatch.brand);
            const sz = logSize(watchPath);
            watchOffset = Number.isFinite(sz) ? sz : null;
          }
        }
        if (!processName) throw new Error('没给出要截哪个进程（target/process 都是空的）。');
        if (args.dryRun === true) {
          return {
            ok: true, op, dryRun: true, plan, dir, target: targetKey, process: processName,
            startAfterSec: clampNum(args.startAfterSec, clampNum(args.afterSec, 0, 0, 120), 0, 120),
            untilGone,
            playtest: playtest ? { hit: playtest.hit, epochSec: playtest.epochSec, startedAt: playtest.startedAt } : null,
            note: '这是**计划**，一张都没拍。去掉 dryRun 才真拍 —— 连拍要花约 ' + plan.spanMs + 'ms。'
              + (untilGone ? ' `untilGone:true`：拍到**这一局结束**为止（直到看得到结束标记，或拍满 count 张）。' : ''),
          };
        }
        fsMod.mkdirSync(dir, { recursive: true });
        const frames = [];
        let abortedAt = null;
        let stoppedBecause = null;
        for (const f of plan.frames) {
          if (f.i > 1) {
            if (goneAt) { stoppedBecause = 'run-ended'; break; }
            await sleep(plan.intervalMs);
          }
          const base = args.label ? String(args.label) : 'burst';
          const label = plan.count > 1 ? base + '-' + f.i : base;
          const name = nextFreeName(dir, shotFileName({ target: targetKey, label, when: new Date() }));
          const r = await captureWindow({
            processName, out: pathMod.join(dir, name),
            title: args.window ? String(args.window) : '',
            thumbOut: thumbPathFor(dir, name),
            bringToFront: args.bringToFront === false ? 0 : 1,
            keepWindowOnTop: args.keepWindowOnTop === true ? 1 : 0,
          });
          const judge = judgeCapture(r);
          let size = null;
          try { size = fsMod.statSync(r.path).size; } catch { /* 没落盘也照报，size 可能是 null */ }
          frames.push({
            i: f.i, file: r.ok ? name : null, atMs: Date.now(),
            ok: r.ok, suspect: judge.suspect, warning: judge.warning,
            width: r.width, height: r.height, size,
            error: r.ok ? null : (r.error || '截图失败'),
          });
          if (!r.ok) { abortedAt = f.i; break; }
          /*
           * ★ `untilGone`（反馈 C1 ②）：拍着拍着**这一局结束了就停**。
           *   判据与 `miliastra_playtest` 同一份（`QuickSwitchToBeyondSettleSceneNormally`），
           *   而且只吃**基线之后新增的字节** —— 不会把上一局的结束标记当成本局的。
           */
          if (watchPath && watchOffset != null) {
            const inc = readIncrement(watchPath, watchOffset);
            if (inc.ok && inc.rotated) {
              // 游戏重启 → 日志换代：重新对齐，不当成「本局结束」
              watchOffset = inc.size;
            } else if (inc.ok && inc.text) {
              watchOffset = inc.size;
              const red = reduceLogLines(createPlaytestState(), inc.text.split(/\r?\n/));
              const end = (red.events || []).find((e) => e.type === 'end');
              if (end) {
                goneAt = end;
                if (runWindow && !Number.isFinite(runWindow.endedAtMs)) runWindow.endedAtMs = end.atMs;
              }
            }
          }
          if (goneAt) { stoppedBecause = 'run-ended'; break; }
        }
        const sum = burstSummary(frames, {
          startedAtMs, requestedMs: plan.intervalMs,
          run: runWindow,
        });
        return Object.assign({
          ok: sum.okCount > 0, op, target: targetKey, process: processName, dir,
          plan,
          startAfterSec: clampNum(args.startAfterSec, clampNum(args.afterSec, 0, 0, 120), 0, 120),
          untilGone,
          stoppedBecause,
          endedAtMs: runWindow && Number.isFinite(runWindow.endedAtMs) ? runWindow.endedAtMs : null,
          playtest: playtest
            ? { hit: true, backHit: playtest.backHit, epochSec: playtest.epochSec, startedAt: playtest.startedAt, afterSec: clampNum(args.afterSec, 0, 0, 120) }
            : null,
          startedAtMs, abortedAt,
        }, sum, {
          hint: abortedAt
            ? '第 ' + abortedAt + ' 张就失败了，**剩下的没拍**（不白耗时间）—— 看那一张的 error。'
            : (stoppedBecause === 'run-ended'
              ? '这一局结束了就自动停（`untilGone:true`）—— 上面 `frames[].inRun` 说清了哪几张在局内。'
              : '看图走 `GET /miliastra/shot?name=<file>`（原图）或 `&thumb=1`（小图），回执不带 base64。'
                + '**截图不会自动删**，记得 `op=clean` 看一眼。')
              + (runWindow && runWindow.warning ? ' ' + runWindow.warning : ''),
        });
      }

      if (op !== 'capture') throw new Error('未知 op：' + op);

      /* ---- op=capture ---- */
      if (!processName) throw new Error('没给出要截哪个进程（target/process 都是空的）。');
      fsMod.mkdirSync(dir, { recursive: true });
      const wanted = shotFileName({ target: targetKey, label: args.label, when: new Date() });
      const name = nextFreeName(dir, wanted);
      const out = pathMod.join(dir, name);

      const r = await captureWindow({
        processName, out,
        title: args.window ? String(args.window) : '',
        // 顺带出一张预览：**同一个 bitmap**，不额外起 PowerShell（起进程约 1 秒，面板一开就要十几张）
        thumbOut: thumbPathFor(dir, name),
        bringToFront: args.bringToFront === false ? 0 : 1,
        keepWindowOnTop: args.keepWindowOnTop === true ? 1 : 0,
      });

      if (!r.ok) {
        const procs = clientProcesses();
        return {
          ok: false, op, code: ReceiptCode.NOT_FOUND, target: targetKey, process: processName, dir,
          error: r.error || '截图失败',
          stderr: r.stderr || null,
          // PS 侧把**所有**候选窗口列出来了 —— 「一个进程有多个窗口」是这个功能最容易出错的地方，
          // 选窗口的依据必须能看见（实测就是靠它定位到 160x28 那个被最小化的窗口的）
          candidates: r.candidates || null,
          runningWindows: (procs.entries || []).map((e) => `${e.file}=${e.running === null ? 'unknown' : e.running}`),
          hint: `进程 "${processName}" 没在跑、没有可见窗口、或者最大的窗口太小。`
            + '游戏本体是 YuanShen.exe（要先把客户端开起来）；换别的目标用 process= 或 target=editor；'
            + '一个进程有多个窗口时用 window=<标题子串> 指定。',
        };
      }

      const judge = judgeCapture(r, { target: targetKey, requestedProcess: processName });
      // 候选窗口逐条标出「哪个被选中了」（多窗口时"选错窗口"才看得见；P2-2 ①）
      const cands = markSelectedCandidate(r.candidates, { pid: r.pid, title: r.title, width: r.width, height: r.height });
      let size = null;
      try { size = fsMod.statSync(r.path).size; } catch { /* 图没落盘也照报，size 可能为 null */ }
      const s = listShots(dir);
      return {
        ok: true, op, target: targetKey, label: args.label ? sanitizeLabel(args.label) : null,
        // 回执的身份：**截到的到底是哪个窗口**（第一版就是靠人眼看图才发现抓错了程序）
        process: r.process, pid: r.pid, title: r.title,
        path: r.path, file: name, dir,
        width: r.width, height: r.height, mode: r.mode, front: r.front,
        blackRatio: r.blackRatio, uniformRatio: r.uniformRatio,
        candidates: cands.length ? cands : null,
        candidateCount: cands.length,
        size, sizeText: size === null ? null : humanSize(size),
        thumb: r.thumbPath ? pathBasenameOf(r.thumbPath) : null,
        // 面板直接用这两个 URL 显示预览 / 原图（路由只允许读截图目录内的 .png）
        thumbUrl: r.thumbPath ? PREFIX + '/shot?name=' + encodeURIComponent(name) + '&thumb=1' : null,
        viewUrl: PREFIX + '/shot?name=' + encodeURIComponent(name),
        suspect: judge.suspect, warning: judge.warning,
        shots: {
          count: s.count, totalBytes: s.totalBytes, totalText: humanSize(s.totalBytes),
          newest: s.files.length ? s.files[0].name : null,
        },
        cleanup: `截图存在 ${dir} —— 现在共 ${s.count} 张 / ${humanSize(s.totalBytes)}。`
          + '**不会自动删**（磁盘是你的）。不用了就：miliastra_shot op=clean keepLast=5 olderThanDays=7'
          + ' → 看将删哪些 → 再加 dryRun=false confirm=true 真删。',
        nextSteps: [
          '面板「游戏截图」卡片里会显示缩略图，点开看原图。',
          judge.suspect ? '⚠️ 本次标记 suspect=true，先读 warning 再决定要不要信这张图。' : null,
          '要对照日志用 miliastra_log；要看控件挂载用 miliastra_map op=clientui。',
        ].filter(Boolean),
      };
    },
  };
