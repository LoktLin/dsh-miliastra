/**
 * `miliastra_log` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { ERRORS_TAG_HINT, ERROR_FORMS, ERROR_KIND_LABELS, NO_ERRORS_HINT, attachFileLines, compareRuns, filterRecords, findErrorRecords, giaRunEpochs, groupRuns, landingMisleadingHint, listGia, logFreshness, pairCommandsWithUi, parseFileLine, playRunsOf, readGia, summarizeRuns } from '../gia.mjs';
import { ReceiptCode, fail } from '../receipt.mjs';
import { clampNum } from '../tools/playtest.mjs';
import { collectMetrics, conventionHint, metricsTimeline, slimLoose, slimMil, summarizeLoose, summarizeMil } from '../metrics.mjs';
import { playtestLogPath, scanLog } from '../playtest.mjs';
import { resolveLevel } from '../shared.mjs';
import { scanLevels } from '../locate.mjs';

/**
 * 这次取到的 `.gia` **属不属于本次会话**—— 反馈 A2 ②（`op=tail|grep|runs` 的回执都带它）。
 *
 * 为什么必须显式告警：那四局没有 `.gia` 时，`op=grep` 返回的是**上一局**的内容，
 * `file` 字段虽然标了文件名，但人（和 AI）都容易把它当成本局证据 —— 这是整条取证链最容易张冠李戴的一环。
 */
export function logStalenessFor(lv, file, epochs) {
  let state = null;
  try {
    const base = scanLog(playtestLogPath(lv.brand));
    if (base && base.ok) state = base.state;
  } catch { /* 读不到试玩日志就退化成「判断不了」，不报错 */ }
  const running = !!(state && state.inPlaytest);
  const last = state && state.runs && state.runs.length ? state.runs[state.runs.length - 1] : null;
  const runEpochSec = running ? (state.epochSec || null) : (last ? last.epochSec : null);
  const runStartedAtMs = running ? state.startedAtMs : (last ? last.startedAtMs : null);
  const f = logFreshness({ file, fileEpochSecs: epochs, runEpochSec, runStartedAtMs });
  return {
    staleLog: f.stale === true,
    logKnown: f.known,
    logBelongsTo: f.logBelongsTo,
    sessionEpochSec: Number.isFinite(runEpochSec) ? runEpochSec : null,
    logFreshnessNote: f.note
      + (f.stale === true
        ? ' ⇒ **别把这份日志当成本局证据**：用 `miliastra_playtest op=status` 看本局的 `.gia` 有没有落盘；'
          + '本局没落盘时，先确认为什么这一局一条 print 都没有。'
        : ''),
  };
}

export const LOG_TOOL = {
    name: 'miliastra_log',
    description:
      TITLE + '：读客户端运行时日志 `.gia`（运行时取证的唯一入口）。`sessions` 列文件；`tail` 读结构化记录；`grep` 按 tag/pattern 过滤；`tags` 汇总**开头**的 `[...]` 前缀；**`runs` 按「局」切分**（每局一行摘要 + 与上一局 diff）；`metrics` 汇总指标分布。\n★ **`op=errors`：按「形态」捞报错，不看标签**（stack traceback / attempt to index / nil value / 缺少交接值 / 文件:行号 / error）—— 真机的报错行**可能完全没有 `[...]` 前缀**，按 tag grep **一条都捞不到**（实测漏掉过一条致命报错）；给 `errors[]{…, fileLine{file,line}, kind}` + `count` / `runsAffected`。\n★ **`staleLog:true` = 不是本局**（带 `logBelongsTo`）—— 别当本局证据；本局落没落盘看 `miliastra_playtest op=status` 的 `localGia`。\n⚠️ **「试玩了却没有新日志」有两种**：① 本局一条 `print` 都没有；② **`.gia` 落盘因时序失败** —— 此时「没有日志」**不能当唯一判据** ⇒ **判画面用 `miliastra_shot`**（细节见 `docs/功能详解.md`）。\n\n**典型调用**：`{"op":"errors"}`（**先跑这个**：不看标签捞报错行，含 `文件:行号`）｜`{"op":"runs"}`（局间 diff）｜`{"op":"metrics"}`（死亡位置分布）｜`{"op":"tail","tag":"miliastra-code","limit":30}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sessions', 'tail', 'grep', 'tags', 'runs', 'metrics', 'errors', 'run-analysis'], description: '默认 tail。' },
        receipt: { type: 'string', enum: ['full', 'min'], description: '默认 full。`min` = **精简骨架档**（换一小撮决策必需字段）；与 `summaryOnly` 不重叠：那个是「去掉体积、保留原字段」，这个是「换骨架」。' },
        explain: { type: 'boolean', description: 'op=errors：回那 8 条「错误形态」固定解释（默认只给 `formsCount`，省上下文）。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用它对应的日志目录）。' },
        file: { type: 'string', description: 'op=tail/grep/runs/errors：日志文件名或绝对路径；省略=最新那个。' },
        tag: { type: 'string', description: '正文子串过滤，例如 [P5D]、就绪、首错。' },
        pattern: { type: 'string', description: '正文正则过滤。' },
        run: {
          type: 'string',
          description: 'op=tail/grep/tags/errors：**只看某一局**（epoch 秒或 instance 片段，与 playtest 的 epochSec 同源）。',
        },
        limit: { type: 'number', description: 'op=tail/grep：默认 120（**超限留最新**）；op=errors：默认 200（超了 `truncated:true`）；op=runs/metrics：默认 10 / 40；op=sessions：默认 40。' },
        last: { type: 'number', description: 'op=tail/grep：**只取尾部 N 条**；顺序永远是**先过滤 → 再取尾**，返回仍按时间正序。' },
        from: {
          type: 'string',
          enum: ['end', 'head'],
          description: 'op=tail/grep：`end`（默认，取尾部）/ `head`（取开头）。',
        },
        evt: { type: 'string', description: 'op=metrics：只看某个事件名（严格约定的 `evt=`）。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=metrics：去掉直方图分箱，只留 `n/min/max/median/core/hotBin` 这些标量（`binsOmitted` 报数量）'
            + '；op=errors：只去 `errors[].message` 正文，**计数 / 分布 / `fileLine` / 提示一个不删**。默认 false。',
        },
        bins: { type: 'number', description: 'op=metrics：直方图分箱数（默认 10，1~50）。**集中区看 `core`，热区看 `hotBin`**。' },
        withRaw: { type: 'boolean', description: 'true=把整段结构化记录一起回传（默认只回 time/message 等要点）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'tail');
      const lv = resolveLevel(args.level);
      let dir = lv.logDir;
      /*
       * ★★ 2026-10-07 修（本轮实测的真 bug）：**显式给了 `file` 却还要先过"当前关卡"这一关** ——
       *   调用方给了 `.gia` 的**绝对路径**，但 `resolveLevel()` 挑中的关卡没有 `Beyond_Debug_Log` 目录
       *   ⇒ 直接 `throw`（实测：`关卡 1073741911 没有关联的 Beyond_Debug_Log 目录。`），
       *   而那份文件**明明读得到**（`op=sessions` 能把它列出来）。
       *   口径：**显式参数优先** —— `file` 是存在的绝对路径 ⇒ 用它的目录；只是文件名且 `dir` 拿不到 ⇒ 退回账号级日志目录。
       */
      const fileArg = args.file == null ? '' : String(args.file).trim();
      if (fileArg) {
        if (pathMod.isAbsolute(fileArg) && fsMod.existsSync(fileArg)) dir = pathMod.dirname(fileArg);
        else if (!dir) {
          // 退回**本账号**的日志目录：任一有 `logDir` 的关卡给的都指向同一个 `Beyond_Debug_Log`（不猜、不拼路径）
          const any = scanLevels().find((l) => l.logDir);
          if (any) dir = any.logDir;
        }
      }
      if (!dir) return fail(ReceiptCode.NOT_FOUND, `关卡 ${lv.levelId} 没有关联的 Beyond_Debug_Log 目录。`, {

        nextStep: '先在编辑器里挂一个客户端脚本并试玩一局（日志目录随关卡创建）；或显式传 level= 指定另一张图。',

      });
      if (op === 'sessions') {
        const files = listGia(dir, Number.isFinite(args.limit) ? args.limit : 40);
        return { ok: true, op, dir, count: files.length, files };
      }
      const file = args.file
        ? (args.file.includes('\\') ? args.file : dir + '\\' + args.file)
        : (listGia(dir, 1)[0] || {}).path;
      if (!file) return fail(ReceiptCode.NOT_FOUND, '该目录下没有 .gia 日志文件——先在编辑器里试玩一局。', {

        nextStep: '`.gia` 只在脚本真的 print 过、且**一局结束后**才落盘 ⇒ 先试玩一局再看。',

      });
      /*
       * ★ `readGia` 自己**没兜住"文件不存在"**（2026-09-30 实测）：`.gia` 被清理/轮转后，
       *   `op=errors`（以及同路的 tail/grep/runs）会让 `ENOENT` 栈冒到调用方，
       *   而本仓约定是回 `{ok:false, error}`；`fx-hardening-test ②e` 正是被这个绊红的
       *   （它的兜底期待的是 `r.error`，见测试第 272-275 行）。这里兜一层转成**优雅回执**。
       */
      let gia;
      try {
        gia = readGia(file);
      } catch (e) {
        gia = {
          ok: false,
          error: '读不到日志文件：' + String((e && e.message) || e)
            + ' —— 日志目录里的 `.gia` 会随会话轮转或被清理；换一个 `file`，或省略 `file` 用**最新那份**。',
        };
      }
      if (!gia.ok) return { ok: false, op, code: ReceiptCode.FAILED, file, error: gia.error };
      const withMsg = gia.records.filter((r) => r.message);
      /*
       * ★ 「这份 .gia 是不是本次会话的」（反馈 A2 ②）：本局没有 `.gia` 时，这里取到的是**上一局**的文件，
       *   而在回执里它只是一行 `file` —— 子代理三次都把它当成了本局的证据。
       *   判据与 `miliastra_playtest op=status` 的 `localGia` 同源（文件里有没有本局那个 epochSec）。
       */
      const fileEpochs = giaRunEpochs(gia.records);
      const staleness = logStalenessFor(lv, file, fileEpochs);
      /*
       * ★★ 「`.gia` 落盘会失败」的醒目提示（2026-09-30 真机实战）：
       *   `staleLog:true` = 本局那个 epochSec 不在文件里 ⇒ 本局没落盘（而文件里有更早的局）。
       *   旧版只给一句中性的"不属于本次会话"，实测把人误导成"脚本层没跑"——
       *   而**同一段流程里画面其实是正常的** ⇒ 所以这里必须明说"这不代表没跑，判画面用截图"。
       */
      const landingHint = staleness.staleLog
        ? landingMisleadingHint({ fileEpochSecs: fileEpochs, sessionEpochSec: staleness.sessionEpochSec, status: 'missing' })
        : null;
      const staleFields = Object.assign({
        staleLog: staleness.staleLog,
        logBelongsTo: staleness.logBelongsTo,
        /*
         * ★★ 《插件调用优化方向》第 3 条：**半截快照要显式说**（`.gia` 一局结束才落盘；局中读到的可能是半截）。
         *   判据是**可验证**的：文件有字节、却一条记录都解不出来 ⇒ 不能把"没有报错"当结论。
         */
        ...(gia && gia.emptyButHasBytes ? {
          partialSnapshot: true,
          partialSnapshotNote: '⚠️ 这个 `.gia` **有字节但解不出任何记录**：要么是**正在写**（`.gia` 一局结束才落盘，'
            + '局中读到的是半截快照），要么文件坏了 ⇒ **"这里没有报错"不能当结论** —— '
            + '等这一局**结束**（停试玩）后再读一次；判"在不在试玩"用 `miliastra_playtest op=status`。',
        } : {}),
      }, landingHint ? { landingHint } : {}, staleness.staleLog ? {
        staleLogWarning: '⚠️ 这份日志**不属于本次会话**：' + staleness.logFreshnessNote
          + '（本局 epochSec ' + (staleness.sessionEpochSec == null ? '未知' : staleness.sessionEpochSec) + '）',
      } : {});

      // 按局过滤：run 可以是 epoch 秒，也可以是 instance 的任意片段
      const runQ = args.run == null || String(args.run).trim() === '' ? null : String(args.run).trim();
      const pool = runQ ? withMsg.filter((r) => String(r.instance || '').includes(runQ)) : withMsg;

      if (op === 'runs') {
        const runs = groupRuns(withMsg);
        const play = playRunsOf(runs);
        return {
          ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
          ...staleFields,
          runCount: runs.length,
          playRunCount: play.length,
          runs: summarizeRuns(runs, Number.isFinite(args.limit) ? args.limit : 10),
          // 局间 diff 只比「试玩局」（90003 是编辑器主屏会话，跨多局不变，混进来会误导）
          diff: compareRuns(play[play.length - 2], play[play.length - 1]),
          hint: '一局 = instance 第一段 `47504`（`90003` 是编辑器主屏会话，跨多局不变）。'
            + 'epochSec 就是「该局开跑时刻」，与 miliastra_playtest 报的是同一个值 —— '
            + '所以「实时看到开跑」和「事后读这局日志」能对上号：'
            + 'miliastra_log op=tail run=<epochSec> 就只看那一局。',
          caveat: 'faultCount / errorSample 是按**通用词**（重生/死亡/失败/nil value…）归的「疑似」计数，'
            + '不是平台给的分类；具体含义以脚本里那行 print 自己的文案为准。'
            + '**命中的词一并报出**（errorSample[].matched / errorMatched / faultMatched）——'
            + '只说「errorKinds: 2」是判断不了该不该信这条归类的，得看见命中哪两个词。',
        };
      }

      if (runQ && !pool.length) {
        return {
          ok: false, op, code: ReceiptCode.FAILED, file,
          error: '这个文件里没有 instance 含 "' + runQ + '" 的记录。先用 op=runs 看有哪些局（instance / epochSec）。',
        };
      }

      if (op === 'errors') {
        /*
         * ★★ `op=errors`（2026-09-30 真机实战）：**按形态捞报错，不看标签**。
         *
         * 为什么必须有这一路：真机那条致命的报错——
         *   `缺少交接值 CONFIG.CONTAINER_INDEX：…` + `stack traceback:` + `特效 fx:428: in function 'requireHandover'`
         * ——**完全没有 `[...]` 前缀**，所以 `op=tags` / `op=grep tag=` 一条都捞不到（作者连猜 4 轮关键词）。
         * 纯函数在 `lib/gia.mjs` 的 `findErrorRecords`（这里只做编排：读文件 → 过滤 → 判 → 给可执行提示）。
         */
        const slim = args.summaryOnly === true;
        const cap = clampNum(args.limit, 200, 1, 1000);
        const found = findErrorRecords(pool, { limit: cap });
        /*
         * ⚠️ 2026-10-04：本轮给 `errors[]` 补过「跨记录借位置」+ 逐条清单，**结果把 `summaryOnly` 的
         *   契约弄坏了**（fx-hardening ②g：slim 9687 B > full 2247 B —— 每条 `fileLine` 填上后多出
         *   `file/line/raw` 三字段 × N 条）。⇒ **回执回退到原形**；真因（`parseFileLine` 缺一条
         *   不锚行首的形态）已经修在 `lib/gia.mjs`，实测 48/48 拿到位置 —— 那才是价值所在。
         *   `attachFileLines()` 仍然导出、仍有测试（feedback5），要逐条清单时再单独接。
         */
        const kinds = Object.entries(found.kindCounts).map(([kind, count]) => ({
          kind, count, what: ERROR_KIND_LABELS[kind] || null,
        })).sort((a, b) => b.count - a.count);
        /**
         * ⚠️ 显式标 `Record<string, any>`：下面会**按条件**补 `hint` / `errorsOmitted` 两个字段，
         *    不标的话 TS 会把 `out` 推成一个联合类型，后面几处赋值就报 TS2339（typecheck 门禁会红）。
         * @type {Record<string, any>}
         */
        const out = {
          ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
          ...staleFields,
          runFilter: runQ,
          scanned: pool.length,
          count: found.count,
          // `count` = 命中总数（未截断前）；`truncated` 后 `errors[]` 只留前 N 条 —— **结论字段一个不删**
          returned: found.errors.length,
          truncated: found.truncated,
          limit: cap,
          runsAffected: found.runsAffected,
          runs: found.runs,
          channels: found.channels,
          kindCounts: found.kindCounts,
          kinds,
          /*
           * ★★ P2-6（《上下文瘦身设计》2026-10-07）：`forms[]`（8 条"错误形态"解释）是**固定文档**，
           *   每次回执都带 ⇒ 实测 **578 B/次**。改成 **`explain:true` 才回**（默认只给 `formsCount`）。
           *   ⚠️ 结论字段（`count`/`kindCounts`/`errors`/`file`）**一个不删**；要那 8 条解释传 `explain:true`。
           */
          ...(args.explain === true
            ? { forms: ERROR_FORMS.map((f) => ({ kind: f.kind, what: ERROR_KIND_LABELS[f.kind] || null })) }
            : { formsCount: ERROR_FORMS.length, formsNote: '要 8 条「错误形态」解释传 `explain:true`（固定文档，默认不占上下文）。' }),
          errors: found.errors,
          summaryOnly: slim,
        };
        /*
         * ★ E5（2026-09-29 实战反馈）：`staleLog` 时 `errors: []` **长得像结论**（"本局零报错"），
         *   实际含义是「这份日志根本不属于本局」—— 在「零首错」是验收判据的场景下误读代价很高。
         *   ⇒ 置 `null` + `errorsMeaningless`，并照抄已有 `staleLog` 那套口径。
         */
        if (out.staleLog === true) {
          out.errors = null;
          out.returned = null;
          out.errorsMeaningless = true;
          out.errorsNote = '本局没有可用的 `.gia` —— 上面的 `errors` 曾被当成"零报错"，其实没有意义。'
            + ' 要看本局报错：确认日志面板勾了客户端脚本，且**这一局结束后**再读（`.gia` 一局结束才落盘）。';
        }
        if (found.count === 0) {
          out.hint = staleFields.landingHint
            ? NO_ERRORS_HINT + ' ' + staleFields.landingHint
            : NO_ERRORS_HINT;
        } else {
          out.hint = ERRORS_TAG_HINT + ' ★ 命中最多的是 `' + (kinds[0] ? kinds[0].kind : '?') + '`。';
          if (staleFields.landingHint) out.hint += ' ' + staleFields.landingHint;
        }
        if (slim) {
          // 只去正文（`errors[].message` 与 `errors[].kinds` 全文），**计数 / 分布 / 提示一个不删**
          if (found.errors.length) out.errorsOmitted = found.errors.length;
          out.errors = found.errors.map((e) => ({
            time: e.time, run: e.run, channel: e.channel, kind: e.kind, fileLine: e.fileLine,
          }));
        }
        /*
         * ★★ 2026-10-07（作者拍板选 A）：**两档必须对同一份日志给同一个结论**。
         *
         * 症状（本轮重启后实测）：`staleLog` 守卫在**全量档**把 `errors` 置 `null`（正确：过期日志不能当证据），
         *   但上面 `slim` 分支**又从原始结果把数组填了回来** ⇒ 同一份数据 `full` 说"没有意义"、`slim` 给 48 条
         *   带 `fileLine` 的报错 —— **AI 会去追一个不属于本局的旧行号**（实测 `表现 view:580`）。
         * 口径（A）：`errorsMeaningless === true` ⇒ **两档都回 `errors:null`**，`count` / `kindCounts` / `runsAffected` /
         *   `errorsNote` 照旧保留（**结论没丢，只是"没意义的报错"不再端出来**）。
         * ⚠️ 放在汇合处（`return out` 之前）收口 ⇒ 不可能再出现第二个填回点。
         */
        if (out.errorsMeaningless === true) {
          if (out.errors && out.errors.length) out.errorsOmitted = out.errors.length;
          out.errors = null;
        }
        /*
         * ★★ 2026-10-08（本轮实测的覆盖缺口）：**同一句连刷 N 次**必须自己报出来。
         *   实测：某图一局 3862 条里 **2358 条**是同一句平台告警
         *   （客户端控件生命周期处于创建或销毁时，无法调用DestroyClientUIControl），
         *   而它**既不在 8 种错误形态里、也没有 [...] 标签** ⇒ op=errors / op=tags / 按 tag 的 grep **全都捞不到**，
         *   只能靠调用方自己想到去 grep。⇒ 这里扫**全量记录**做去重计数，把"淹没型"日志显式报出来。
         *   ⚠️ 只增字段（logFlood），不动既有字段；阈值 20 条才报（少于这个数不算"淹没"）。
         */
        {
          const counts = new Map();
          const firstAt = new Map();
          for (const rec of pool) {
            const msg = String((rec && rec.message) || '').trim();
            if (!msg) continue;
            counts.set(msg, (counts.get(msg) || 0) + 1);
            if (!firstAt.has(msg)) firstAt.set(msg, (rec && rec.time) || null);
          }
          const total = pool.length;
          const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([message, count]) => ({ message: message.slice(0, 200), count, firstAt: firstAt.get(message) }));
          if (top.length && top[0].count >= 20) {
            out.logFlood = {
              top, records: total,
              share: Number((top[0].count / Math.max(1, total)).toFixed(3)),
              note: '**同一句连刷**（logFlood.top[0]）—— 平台级重复告警就是这样把 .gia 撑到几百 KB 的。'
                + '这类句子**不在** op=errors 的 8 种形态里、往往也**没有 [...] 标签**'
                + '（⇒ op=tags / grep tag= 捞不到）⇒ 看这里，别只看 count。',
            };
          }
        }
        return out;
      }

      if (op === 'metrics') {
        const bins = clampNum(args.bins, 10, 1, 50);
        const c = collectMetrics(pool);
        const evtQ = args.evt == null || String(args.evt).trim() === '' ? null : String(args.evt).trim();
        const summarized = summarizeMil(c.mil, { bins });
        const slim = args.summaryOnly === true;
        const sums = slim ? slimMil(summarized) : summarized;
        const loose = c.loose.length ? summarizeLoose(c.loose, { bins }) : null;
        return {
          ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
          ...staleFields,
          scanned: c.scanned, milCount: c.mil.length, looseCount: c.loose.length, ignored: c.ignored,
          summaryOnly: slim,
          // ① 严格约定（`[MIL] evt=… k=v`）：每个事件一张卡 + 一条时间线
          mil: c.mil.length
            ? {
              events: evtQ ? sums.filter((s) => s.evt === evtQ) : sums,
              timeline: metricsTimeline(c.mil, { limit: clampNum(args.limit, 40, 1, 500) }),
            }
            : null,
          // ② 宽松抽取：**不用改脚本**，现有日志里现成的 `k=数字` 也能汇总
          loose: loose ? (slim ? slimLoose(loose) : loose) : null,
          convention: conventionHint(),
          note: '汇总的是**数字事实**，不是判定 —— 不说「这关有问题」，只说「N 次里有 M 次落在 a~b」。'
            + '「集中在哪」看 `core`（中间 50%，抗离群值）；`hotBin` 是直方图命中最多的那一箱，看形状用。'
            + '没有指标格式的行**一律静默忽略**（本 op 只读 `.gia`，一个字节都不写）。'
            + (slim ? '`summaryOnly:true` 去了直方图分箱（有箱可去时 `binsOmitted` 报出数量），`core`/`hotBin` 都还在。' : '')
            + (c.mil.length ? '' : '⚠️ 目前这一局没有 `[MIL]` 行，所以 `mil` 是 null —— 上面 `loose` 那份是**现成日志就能出的**。'),
        };
      }

      if (op === 'run-analysis') {
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 10 条）：**命令应答 ↔ 画面变化**配对。
         *   关键词由调用方给（工具不猜业务词）：
         *     · `pattern` = **命令类**关键词（正则，缺省 `/命令|点击|按下|Invoke|Pressed/`）
         *     · `tag`     = **画面/UI 类**关键词（正则，缺省 `/渲染|显形|收起|SetVisible|界面层|覆盖层|更新/`）
         *   ⚠️ 这是**日志层面**的配对，**不等于"画面真的没变"** ⇒ 判画面用 `miliastra_shot`（回执里明写）。
         */
        const src = runQ ? withMsg.filter((r) => String(r.instance || '').includes(runQ)) : withMsg;
        const withIdx = src.map((r, i) => ({ ...r, i }));
        let cmdRe = null;
        let uiRe = null;
        try { cmdRe = new RegExp(args.pattern || '命令|点击|按下|Invoke|Pressed', 'i'); } catch (e) { return { ok: false, op, code: ReceiptCode.BAD_PARAM, error: 'pattern 不是合法正则：' + ((e && e.message) || e) }; }
        try { uiRe = new RegExp(args.tag || '渲染|显形|收起|SetVisible|界面层|覆盖层|更新', 'i'); } catch (e) { return { ok: false, op, code: ReceiptCode.BAD_PARAM, error: 'tag 不是合法正则：' + ((e && e.message) || e) }; }
        const paired = pairCommandsWithUi(withIdx, { cmdRe, uiRe, window: clampNum(args.limit, 12, 1, 200) });
        return {
          ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
          ...staleFields,
          runFilter: runQ,
          scanned: withIdx.length,
          keywords: { command: cmdRe.source, ui: uiRe.source, window: paired.window },
          commands: paired.commands,
          uiRecords: paired.uiRecords,
          noUiAfterCount: paired.noUiAfterCount,
          noUiAfter: args.summaryOnly === true ? paired.noUiAfterCount : paired.noUiAfter,
          pairs: args.summaryOnly === true ? paired.pairs.length : paired.pairs,
          note: paired.note,
          hint: '想看某一局的：传 `run=<epoch 秒 或 instance 片段>`；改关键词：`pattern`（命令类）/ `tag`（画面类），都是正则。'
            + '**"画面真的变没变"必须另用 `miliastra_shot` 取帧差** —— 日志只能证明"这条记录有没有出现"。',
        };
      }
      if (op === 'tags') {
        /*
         * ★ P2-4（2026-09-26）：按 **`[...]` 前缀**聚合。
         *   旧实现只认「正文里任意位置 + 只含 ASCII 字母数字下划线连字符」的 `[xx]`，
         *   于是本工程那种 `[侦探1/view] 初始化…`（含中文与 `/`）**永远归到 `(无标签)`**，
         *   106 条日志挤成一行 —— AI 只能退回 `op=grep tag="[侦探1/view]"`（能用，但多一步）。
         *   现在：正文**开头**的 `[...]`（1~40 字，任何字符）就是标签；真的没有前缀才归 `(无标签)`。
         */
        const counter = new Map();
        const prefixRe = /^\s*\[([^\]\r\n]{1,40})\]/;
        for (const r of pool) {
          const m = prefixRe.exec(String(r.message || ''));
          const k = m ? m[1].trim() : '(无标签)';
          counter.set(k, (counter.get(k) || 0) + 1);
        }
        const tags = [...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
        return {
          ok: true, op, file, recordCount: gia.recordCount, ...staleFields, tags,
          tagRule: '标签 = 正文**开头**的 `[...]` 前缀（如 `[侦探1/view]`；1~40 字）；没有前缀才归 `(无标签)`。'
            + '要按别的口径读正文用 `op=grep tag=<子串>`。',
        };
      }
      const limit = Number.isFinite(args.limit) ? args.limit : 120;
      /*
       * ★「从尾部取」（2026-09-25 同事反馈）：他想看**收尾阶段**（那 141 条 Destroy 拒绝）却只能从头取 ——
       *   一个文件末尾才是「这一局怎么结束的」。所以显式加 `last`（尾部 N 条）/ `from`（end|head）：
       *   顺序永远是 **过滤（run/tag/pattern）→ 取尾**；`limit` 的行为一个字不改。
       */
      const fromRaw = args.from == null ? '' : String(args.from).trim().toLowerCase();
      if (fromRaw && fromRaw !== 'end' && fromRaw !== 'head') {
        return {
          ok: false, op, code: ReceiptCode.FAILED, file,
          error: 'from 只能是 "end"（从尾部取，默认）或 "head"（从头取），收到：' + JSON.stringify(args.from),
        };
      }
      const fromHead = fromRaw === 'head';
      const lastN = Number.isFinite(args.last) ? Math.max(0, Math.round(args.last)) : null;
      const take = lastN == null ? limit : lastN;
      const { records, error } = filterRecords(pool, { tag: args.tag, pattern: args.pattern, limit: take, fromEnd: !fromHead });
      if (error) return { ok: false, op, code: ReceiptCode.FAILED, file, error };
      /*
       * ★ 2026-09-30 修：`matched` 以前写的是 `records.length` —— 而 `records` **已经是截断后的窗口**，
       *   于是它恒等于「本次返回几条」，**不是命中总数**：我用 `limit:1` 查「命中」时它回 `matched: 1`，
       *   改成 `limit:3` 就回 3。名字骗人，后果很实际：**想问"这一局一共命中多少次"的调用方会拿到 1**。
       *   ⇒ 现在在**截断之前**数一遍真总数；`matched` = 命中总数，`returned` = 返回条数，
       *     外加 `truncated`（一眼看出被截断）。默认行为（`limit`/`last`/`from`）一个字没改。
       */
      const totalMatched = filterRecords(pool, { tag: args.tag, pattern: args.pattern, limit: Number.MAX_SAFE_INTEGER, fromEnd: !fromHead }).records.length;
      const slim = records.map((r, i) => (args.withRaw
        ? r
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 5 条：「同秒时间戳下多脚本 print 的相对顺序不可靠」）：
         *   行里带上 **`seq`**（`.gia` 记录自带的序号，同局内多为单调）**+ `i`（解析顺序下标，兜底）**
         *   ⇒ 判断"渲染比命令慢一拍"这类时序问题才有**硬依据**，不必再靠时间戳（同秒分不出先后）。
         */
        : { seq: Number.isFinite(r.seq) ? r.seq : null, i, time: r.time, account: r.account, player: r.player, channel: r.channel, message: r.message }));
      return {
        ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
        ...staleFields,
        matched: totalMatched, returned: slim.length, truncated: totalMatched > slim.length,
        matchedNote: '`matched` = **命中总数**（过滤后、截断前）；`returned` = 本次返回条数；`truncated` = 被 `limit`/`last` 截掉了。',
        // 「这次是从哪一端取的、取了几条」—— 省掉「为什么我只看到开头那 N 条」这类来回
        window: {
          from: fromHead ? 'head' : 'end', last: lastN, limit, take,
          order: '返回按时间正序（最早在前）',
        },
        /* ★ 时序怎么判：**实测 `seq` 在同局里常常是同一个值**（本机那份 428 条记录全是 `seq=700`）
         *   ⇒ 真正能用的顺序依据是 `i`（= 解析顺序 = `.gia` 落盘顺序）。两个都给你，别猜。 */
        seqNote: '每行带 `seq`（`.gia` 记录序号）与 `i`（解析顺序下标）。'
          + '⚠️ **实测**：`seq` 在同一局里可能是**同一个值**（本机 428 条全是 `seq=700`）⇒ '
          + '**同秒内的先后以 `i` 为准**，别用 `time`（同秒分不出）、也别假设 `seq` 单调。',
        filter: { tag: args.tag || null, pattern: args.pattern || null },
        records: slim,
      };
    },
  };
