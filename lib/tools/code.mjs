/**
 * `miliastra_code` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { ReceiptCode, fail } from '../receipt.mjs';
import { UI_WARN_DOC, uiWarnings, uiWarningsOfFiles } from '../uiwarn.mjs';
import { backupFile, deploy as deployFile, fingerprintDelta, inferLiveNameFromBackup, inspect, listBackups, pickLiveFile, readDeployFingerprint, readLuaAt, restore as restoreFile, restoreCommand, stripBomFile, writeDeployFingerprint } from '../codefile.mjs';
import { checkLuaSyntax } from '../lua-syntax.mjs';
import { chooseLua, gilScriptInfo } from '../tools/probe.mjs';
import { clampNum } from '../tools/playtest.mjs';
import { compareRects, expandDriverRefs, scanRects } from '../rects.mjs';
import { compareScriptSnapshot, mountStatusOf, pickScriptMapping, readGil } from '../gil.mjs';
import { createHash } from 'node:crypto';
import { currentLevelDecision, scanLevels } from '../locate.mjs';
import { describeLevels, extractLevelTable, findCanvas, levelSummary } from '../leveldata.mjs';
import { execFileSync } from 'node:child_process';
import { globalWrites } from '../lua-audit.mjs';
import { lintLua, lintSummary } from '../lualint.mjs';
import { lintUiFiles } from '../uilint.mjs';
import { pathBasenameOf } from '../tools/shot.mjs';
import { pickedFields } from '../tools/map.mjs';
import { resolveLevel } from '../shared.mjs';

/**
 * `miliastra_code op=rects` 的实现（**只报数字不判决**）。
 *
 * @param {{dir:string, scope:'dir'|'level', args:any, level?:any}} input
 */
export function runRectsOp({ dir, scope, args, level = null }) {
  if (!dir || !fsMod.existsSync(dir) || !fsMod.statSync(dir).isDirectory()) {
    throw new Error('op=rects 要一个**存在的目录**（工程目录的绝对路径用 dir=…，省略 dir 就用当前关卡的活文件目录）。收到：' + JSON.stringify(dir));
  }
  const scan = collectLuaFilesForRects(dir);
  const all = [];
  const driverTables = [];
  const fileRows = [];
  for (const f of scan.files) {
    let text;
    try { text = fsMod.readFileSync(f, 'utf8'); } catch (e) {
      scan.skipped.push({ path: f, reason: '读不动：' + ((e && e.message) || e) });
      continue;
    }
    const r = scanRects(text, pathBasenameOf(f));
    for (const x of r.rects) all.push({ ...x, path: f });
    for (const t of r.driverTables) driverTables.push({ ...t, path: f });
    fileRows.push({ file: pathBasenameOf(f), path: f, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split(/\r?\n/).length, rects: r.rects.length, driverTables: r.driverTables.length });
  }
  const pairs = Array.isArray(args.pairs) ? args.pairs : null;
  const nearPx = clampNum(args.nearPx, 4, 0, 400);
  const cmp = compareRects(all, { nearPx, pairs });
  const driverRefs = expandDriverRefs(all, driverTables);
  const summaryOnly = args.summaryOnly === true;
  // 每条都带 `文件:行号`（人的第一诉求：「改哪一行」）—— 这里把行号拼成可直接照抄的串
  const withWhere = (r) => ({ where: r.file + ':' + r.line, ...r });
  return {
    ok: true, op: 'rects',
    dir, scope,
    level: level ? { levelId: level.levelId } : null,
    /* ★ E3 同理（rects）：零输入时也要一眼看出"什么都没查" */
    noInput: fileRows.length === 0 ? true : undefined,
    noInputHint: fileRows.length === 0
      ? '0 个文件参与检查 —— `files` 是相对**关卡目录**解析的，请传**绝对路径**。'
      : undefined,
    fileCount: fileRows.length,
    files: fileRows,
    skipped: scan.skipped,
    skippedCount: scan.skipped.length,
    nearPx,
    summaryOnly,
    counts: cmp.counts,
    // ① 全部矩形（`summaryOnly` 只给计数 + 前几张，省上下文；差异列表不受影响）
    rects: summaryOnly ? undefined : all.slice(0, RECT_MAX_LIST).map(withWhere),
    rectsOmitted: summaryOnly ? all.length : Math.max(0, all.length - RECT_MAX_LIST),
    // ② 配对与差异
    exact: cmp.exact.map((g) => ({ ...g, entries: g.entries.map(withWhere) })),
    near: cmp.near.map((g) => ({ a: withWhere(g.a), b: withWhere(g.b), delta: g.delta, maxDelta: g.maxDelta })),
    nearTotal: cmp.nearTotal, nearTruncated: cmp.nearTruncated === true,
    sameName: cmp.sameName.map((g) => ({ ...g, entries: g.entries.map(withWhere) })),
    // ③ 人点名的对照（作者那份脚本的 `ovB1 ↔ T_START` 就是这种：名字不同、其实是同一个控件）
    pairsChecked: cmp.pairsChecked.map((p) => ({
      ...p,
      a: p.a ? withWhere(p.a) : p.a,
      b: p.b ? withWhere(p.b) : p.b,
    })),
    // ④ 「循环建出来的控件」：公式 + 驱动表**原文**都摆出来，公式由你代（工具不猜）
    formulaOnly: cmp.formulaOnly.map(withWhere),
    driverTables,
    driverRefs,
    disclaimer: '**只报数字，不判对错**：本工具不判「哪个矩形才是对的」（那取决于玩法），'
      + '只把「同一份数字写在几处、差多少」摆出来。`nearPx=' + nearPx + '` 是**筛选阈值**，不是判定。'
      + '⚠️ 名字不同但其实是同一个控件的（如 `ovB1` ↔ `T_START`）**本工具不会自动配** —— 那是语义，得用 `pairs` 点名。',
    caveats: [
      '`formula:true` 的矩形**算不出数值**（槽位是表达式）—— 循环建出来的控件就在这一类：'
        + '把 `driverRefs[].rows` 代进 `driverRefs[].slots` 得到每行矩形（公式由你/AI 代，工具不猜）。',
      '注释掉的代码、字符串里的 `add(...)` 不参与（先剥 Lua 注释）。',
      '同文件内多处相同**不算**「两份数字要对齐」的证据（`exact` 只收**跨文件**的）。',
      scan.skipped.length ? '跳过了 ' + scan.skipped.length + ' 个文件/目录（见 `skipped[]`：历史产物、备份、试玩探针源码、隐藏目录）—— 要看它们就把目录缩到那个子目录再跑。' : null,
    ].filter(Boolean),
    hint: '差异看 `near`（逐字段差 `delta`）与 `pairsChecked`（人点名的对照）；'
      + '要省上下文传 `summaryOnly:true`（去掉全量矩形清单，计数与差异列表都还在）。',
  };
}

/**
 * `miliastra_code op=lint-ui` 的实现（P0-1，**只报数字与位置、不下判决**）。
 *
 * 判据本体在 `lib/uilint.mjs`（纯函数，可单测）；这里只负责「读哪些文件」与「回执怎么省体积」。
 * 作用域与 `op=rects` 同一套：给了 `dir` 就扫那个工程目录，没给就扫**当前关卡的活文件目录**；
 * `files` 可以只查点名的那几个（活文件名或绝对路径都行）。
 *
 * @param {{dir:string, scope:'dir'|'level', args:any, level?:any}} input
 */
export function runLintUiOp({ dir, scope, args, level = null }) {
  const root = dir || null;
  const rows = [];
  const skipped = [];
  const filesArg = Array.isArray(args.files) ? args.files.map((x) => String(x)).filter((x) => x.trim()) : [];
  if (filesArg.length) {
    for (const f of filesArg) {
      const p = pathMod.isAbsolute(f) ? f : pathMod.join(root || '', f);
      let text;
      try { text = fsMod.readFileSync(p, 'utf8'); } catch (e) {
        skipped.push({ file: f, path: p, reason: '读不动：' + ((e && e.message) || e) });
        continue;
      }
      rows.push({ name: pathBasenameOf(p), path: p, text });
    }
  } else {
    if (!root || !fsMod.existsSync(root) || !fsMod.statSync(root).isDirectory()) {
      throw new Error('op=lint-ui 要一个**存在的目录**（工程目录绝对路径用 dir=…，省略就用当前关卡的活文件目录）。收到：' + JSON.stringify(root));
    }
    const scan = collectLuaFilesForRects(root);
    skipped.push(...scan.skipped);
    for (const p of scan.files) {
      let text;
      try { text = fsMod.readFileSync(p, 'utf8'); } catch (e) {
        skipped.push({ file: pathBasenameOf(p), path: p, reason: '读不动：' + ((e && e.message) || e) });
        continue;
      }
      rows.push({ name: pathBasenameOf(p), path: p, text });
    }
  }
  const pairs = Array.isArray(args.pairs) ? args.pairs : null;
  const r = lintUiFiles({ files: rows, pairs, config: args.uiConfig });
  const summaryOnly = args.summaryOnly === true;
  // 每条都带上可直接照抄的 `文件:行号`（人的第一诉求是"改哪一行"）
  const withWhere = (list) => {
    const capped = summaryOnly ? list.slice(0, 3) : list;
    return capped.map((x) => ({ where: x.file + ':' + x.line, ...x }));
  };
  const checks = {};
  const checksOmitted = {};
  for (const [k, list] of Object.entries(r.checks)) {
    checks[k] = withWhere(list);
    if (summaryOnly && list.length > 3) checksOmitted[k] = list.length - 3;
  }
  /*
   * ★ E1②（2026-09-29 实战反馈）：**图片控件没指定图源 ⇒ 真机渲染成 `?` 占位符**。
   *   （E1③ 2026-09-30：模拟器**不再**替图片控件补方块 ⇒ 现在离线也画得出这个症状，
   *     但这道静态检查仍然更快、更早 —— 不用跑一局就能指出在哪个文件第几行。）
   *   判据只报事实与位置，不替作者判"必须改"。
   */
  const imgSrcWarn = [];
  for (const f of rows) {
    const lines = String(f.text).split(/\r?\n/);
    const instLine = lines.findIndex((l) => /InstantiateClientUIControl\s*\(/.test(l));
    if (instLine < 0) continue;
    if (/:SetImage\s*\(/.test(f.text)) continue;
    imgSrcWarn.push({
      file: f.name, line: instLine + 1,
      message: 'IMAGE_WITHOUT_SOURCE：本文件用 InstantiateClientUIControl 建控件，但**一处 `:SetImage(` 都没有** —— '
        + '若这些控件来自「图片」模板，**真机会渲染成 `?` 占位符**（E1③ 起模拟器也不再补方块、同样画 `?`）。'
        + '拿不准就显式调 `SetImage(Enum.ImageSource.StaticReference, <号>)`（号见 miliastra_asset op=catalog）。'
    });
  }
  if (imgSrcWarn.length) checks.imageWithoutSource = withWhere(imgSrcWarn);
  return {
    ok: true, op: 'lint-ui',    dir: root, scope,
    level: level ? { levelId: level.levelId } : null,
    fileCount: rows.length,
    files: rows.map((f) => ({ file: f.name, path: f.path, bytes: Buffer.byteLength(f.text, 'utf8') })),
    skipped,
    skippedCount: skipped.length,
    summaryOnly,
    usedConfig: r.usedConfig,
    counts: r.counts,
    /* ★ E3（2026-09-29 实战反馈）：**零输入不许绿**。
     *   `files` 是相对**关卡目录**解析的，传了错路径 ⇒ 该文件进 `skipped`、`fileCount: 0`，
     *   而旧实现仍回 `passed: true` ⇒ 「绿了但一个文件都没查」是**最危险的回执**（差点让人以为 UI 契约验过了）。
     *   ⇒ 零输入时 `passed: null` + `noInput: true` + 一句可执行提示。 */
    passed: rows.length === 0 ? null : r.passed,
    noInput: rows.length === 0 ? true : undefined,
    noInputHint: rows.length === 0
      ? '0 个文件参与检查，`passed` 无意义。`files` 是相对**关卡目录**解析的 —— 请传**绝对路径**（看 `skipped[]` 里那条 `读不动` 的实际路径）。'
      : undefined,
    checks,
    checksOmitted: summaryOnly ? checksOmitted : undefined,
    unresolved: r.unresolved,
    // skipped 明细在 summaryOnly 下只留前 5 条（结论字段一个不删）
    skippedDetail: summaryOnly ? r.skipped.slice(0, 5) : r.skipped,
    passedMeans: r.disclaimer,
    portNote: r.portNote,
  };
}

/**
 * ★★ `miliastra_code op=preflight`（AI 易用性反馈 2026-09-30 第 1/7/12 条）—— **一次把"能不能上真机"查完**。
 *
 * 为什么要有它：那位 AI 每改一次脚本要手动拼 6 处检查（全是机械判据）——
 * `deploy` 的结构 lint、工作区的 `check-lua-scope` / `check-lua-style --baseline` / `scan-lua-globals`、
 * 插件的 `op=lint-ui`、以及"括号配平"（他自己在构建脚本里写的）——**6 项里只有 1 项在插件里，
 * 而最要紧的"语法"哪都没有** ⇒ 一轮里 3 次语法错全部漏到真机前。
 *
 * 本 op **只读**（不写盘、不部署、不改任何文件），一次回一张表：
 *   `[Lua 语法（fengari 真解析器）· 结构配对 · 全局写 · 图片有图源 · 作用域 · 风格基线]`
 *
 * ★ 两条**如实报 `ok:null`**（"判不了"就写判不了，本仓纪律 —— **不猜**）：
 *   · **作用域（漏 local）**：权威判据在工作区 `tools/check-lua-scope.mjs`，它还依赖跨脚本的黑板契约；
 *     在插件里重写一版只会**误报**（把别的脚本声明的入口当漏 local）⇒ 这里给指针，不给假结论。
 *   · **风格基线**：基线数字在 `tools/lua-style-baseline.json`（工作区的），插件不复制一份。
 * @param {{dir:string, scope:'dir'|'level', args:any, level?:any}} input
 */
export function runPreflightOp({ dir, scope, args, level = null }) {
  const root = dir || null;
  if (!root || !fsMod.existsSync(root) || !fsMod.statSync(root).isDirectory()) {
    throw new Error('op=preflight 要一个**存在的目录**（工程目录绝对路径用 dir=…，省略就用当前关卡的活文件目录）。收到：'
      + JSON.stringify(root));
  }
  const filesArg = Array.isArray(args.files) ? args.files.map((x) => String(x)).filter((x) => x.trim()) : [];
  const rows = [];
  const skipped = [];
  const push = (p) => {
    let text;
    try { text = fsMod.readFileSync(p, 'utf8'); } catch (e) {
      skipped.push({ file: pathBasenameOf(p), path: p, reason: '读不动：' + ((e && e.message) || e) });
      return;
    }
    rows.push({ name: pathBasenameOf(p), path: p, text });
  };
  if (filesArg.length) {
    for (const f of filesArg) push(pathMod.isAbsolute(f) ? f : pathMod.join(root, f));
  } else {
    const scan = collectLuaFilesForRects(root);
    skipped.push(...scan.skipped);
    for (const p of scan.files) push(p);
  }
  // 图片图源那一项复用 `op=lint-ui` 的判据（同一条纪律，不重写第二版）
  let uiFindings = [];
  try {
    const ui = runLintUiOp({ dir: root, scope, args: Object.assign({}, args, { summaryOnly: false }), level });
    uiFindings = (ui && ui.checks && Array.isArray(ui.checks.imageWithoutSource)) ? ui.checks.imageWithoutSource : [];
  } catch (e) { uiFindings = []; }

  const fileRows = rows.map((f) => {
    /* ⚠️ `checkLuaSyntax` 是「成功/失败」两形的联合类型，`tsc --checkJs` 收窄不了 ⇒ 显式当 any 读字段 */
    const syntax = /** @type {any} */ (checkLuaSyntax(f.text, { chunkName: f.name }));
    const structure = lintLua(f.text);
    const gw = globalWrites(f.text);
    const imgBad = uiFindings.filter((x) => x && x.file === f.name);
    const checks = [
      {
        item: 'Lua 语法（fengari 真解析器）',
        ok: syntax.ok,
        line: syntax.ok ? null : syntax.line,
        why: syntax.ok ? null : (syntax.message || syntax.error),
      },
      {
        item: '结构配对（未闭合块 / 括号花括号）',
        ok: structure.ok,
        line: null,
        why: structure.ok ? null : lintSummary(structure),
        note: '与「语法」有重叠：语法检查更严，这条留着是为了**和 `deploy` 的 lint 口径一致**。',
      },
      {
        item: '全局写（运行期给全局赋值 —— 真机上不生效）',
        ok: gw.length === 0,
        line: gw.length ? gw[0].line : null,
        why: gw.length ? ('候选 ' + gw.length + ' 处，第一处第 ' + gw[0].line + ' 行：' + gw[0].text) : null,
        hits: gw.slice(0, 20),
        note: '启发式（只报"缩进里给非 local 名字赋值"，表字段不算）；已知漏报见 lib/lua-audit.mjs。',
      },
      {
        item: '图片有图源（用了 InstantiateClientUIControl 却一处 SetImage 都没有）',
        ok: imgBad.length === 0,
        line: imgBad.length ? imgBad[0].line : null,
        why: imgBad.length ? imgBad[0].message : null,
      },
      {
        item: '作用域（漏 local）',
        ok: null,
        line: null,
        why: '**本级不判**：权威判据在工作区 `node tools/check-lua-scope.mjs`（它依赖跨脚本的黑板契约，'
          + '插件里重写会误报）—— 请在那条命令上跑。',
      },
      {
        item: '风格基线',
        ok: null,
        line: null,
        why: '**本级不判**：基线数字在工作区 `tools/lua-style-baseline.json` ⇒ `node tools/check-lua-style.mjs --baseline`。',
      },
    ];
    const failed = checks.filter((c) => c.ok === false);
    const unknown = checks.filter((c) => c.ok === null);
    return {
      file: f.name, path: f.path, bytes: Buffer.byteLength(f.text, 'utf8'),
      checks,
      failedCount: failed.length,
      unknownCount: unknown.length,
      verdict: failed.length ? ('有 ' + failed.length + ' 项不过 ⇒ **别部署**')
        : (unknown.length ? '可判定项全过（' + unknown.length + ' 项判不了，见各自 why）⇒ 可以部署' : '全过 ⇒ 可以部署'),
    };
  });

  const badFiles = fileRows.filter((r) => r.failedCount > 0);
  const unknownTotal = fileRows.reduce((s, r) => s + r.unknownCount, 0);
  return {
    /*
     * ★ **零输入不许绿**（与 `op=lint-ui` 同一条纪律）：一个文件都没查到时必须是 `ok:false`。
     *   为什么不能是 `true`：`ok:true` + `fileCount:0` 读起来就是"检查通过了"，而其实**什么都没验** ——
     *   实测这种回执最危险（差点让人以为 UI 契约验过了，见 `op=lint-ui` 的 E3 教训）。
     *   （我自己第一版就写成了 `ok: badFiles.length === 0` ⇒ 0 个文件时回 `true`，被 preflight-test 当场抓住。）
     */
    ok: badFiles.length === 0 && fileRows.length > 0,
    op: 'preflight',
    dir: root, scope,
    level: level ? { levelId: level.levelId } : null,
    fileCount: fileRows.length,
    skipped, skippedCount: skipped.length,
    /*
     * ★ 零输入不许绿（与 `op=lint-ui` 同一条纪律）：一个文件都没查到时 `ok:false` + 说清为什么，
     *   否则「绿了但什么都没查」是最危险的回执。
     */
    noInput: fileRows.length === 0 ? true : undefined,
    verdict: fileRows.length === 0
      ? '0 个文件参与检查 ⇒ **什么都没验**（`files` 是相对关卡目录解析的，请传绝对路径；看 `skipped[]`）'
      : (badFiles.length
        ? ('有 ' + badFiles.length + ' 个文件不过 ⇒ **别部署**：' + badFiles.map((r) => r.file).join('、'))
        : ('可判定项全过 ⇒ 可以部署' + (unknownTotal ? '（' + unknownTotal + ' 项判不了：作用域 / 风格基线，见各文件 why）' : ''))),
    files: args.summaryOnly === true
      ? fileRows.map((r) => ({ file: r.file, failedCount: r.failedCount, unknownCount: r.unknownCount, verdict: r.verdict,
        failed: r.checks.filter((c) => c.ok === false).map((c) => ({ item: c.item, line: c.line, why: c.why })) }))
      : fileRows,
    /*
     * 这一层是**结论层**：既写"查了什么"，也写"没查什么"。
     * 为什么必须写 skips（反馈第 1/12 条）：上一版 `deploy` 的 lint **不查语法**却没有任何限定语，
     * 于是「deploy 成功」被当成了「语法正确」。
     */
    checkedItems: ['Lua 语法（fengari）', '结构配对', '全局写', '图片有图源'],
    notCheckedItems: ['作用域（漏 local）⇒ 工作区 check-lua-scope.mjs', '风格基线 ⇒ 工作区 check-lua-style.mjs --baseline',
      '类型 / 运行时语义', '平台 UI 铁律 ⇒ miliastra_code op=lint-ui'],
    readOnly: true,
    nextStep: badFiles.length === 0
      ? '可以 `miliastra_code op=deploy`（**必须显式传 `level` + `file`**）→ 编辑器里**存一次盘** → 试玩。'
      : '先修 `failedCount > 0` 的那几条（每条都带 `line`）再部署。',
  };
}

/**
 * ★★ 2026-09-30（AI 易用性反馈第 10 条）：**写盘类 op 在「当前关卡」有歧义时直接拒绝**。
 *
 * 为什么：`health brief` 早就把「当前关卡是怎么判出来的 / 还有哪些候选」摆出来了（做得好），
 * 但 `deploy` / `backup` / `restore` / `fixbom` 的默认**还是**用它 —— 而 AGENTS 里记着一次真实事故：
 * 在双相那张图里 deploy 侦探杀的脚本，把**双相的同名活文件**覆盖了（靠自动备份救回来的）。
 * 歧义时可判性最高的一步就是**拒绝**：写盘类 op 一旦写错文件，就是活文件（唯一副本）出事。
 *
 * 判据：`currentLevelDecision()` 的 `warning`（第二近的关卡与它相差 < 5 分钟 = 歧义）。
 * ⚠️ 只拦**写盘类**；只读 op（inspect / read / log / shot…）一字不动。
 * @returns {Record<string, any>|null} 有歧义时返回可直出的**错误回执**，否则 null
 */
export function requireUnambiguousLevel(args, op) {
  const given = args.level === undefined || args.level === null || String(args.level).trim() === '';
  if (!given) return null;                      // 显式给了 level ⇒ 什么都不管
  const d = currentLevelDecision(scanLevels());
  if (!d || !d.warning) return null;            // 不歧义 ⇒ 照旧
  return {
    ok: false, op, code: 'LEVEL_AMBIGUOUS',
    currentDecidedBy: d.decidedBy,
    currentLevelId: d.levelId,
    currentAlternatives: d.alternatives,
    error: '「当前关卡」有歧义（' + d.decidedBy + '；第二近的关卡与它相差不到 5 分钟）⇒ '
      + '**写盘类 op 拒绝在猜出来的关卡上动手**，请显式传 `level=<地图关卡ID>`。',
    howTo: '先用 `miliastra_health {brief:true}` 看这份 `currentAlternatives`，把要改的那张图的 `levelId` 填进 `level`。',
    why: '活文件是唯一副本：写错关卡 = 覆盖另一张图的同名脚本（2026-09-28 真实事故，靠自动备份救回）。',
  };
}

/**
 * 扫 `ErrorLog.txt`。
 *
 * 为什么要有这一条：**循环调用 / 挂载失败这类错不进 `.gia`** ——
 * 官方文档（`doc_客户端控件和客户端脚本` §五.8(2)，见 `docs/官方文档对比-7.1正式vs内测.md` 第 9 条）
 * 说得很清楚：正常日志里**不报**，要去客户端脚本同目录看 `ErrorLog.txt`。
 * 也就是说「`.gia` 里干干净净」**不等于**「脚本没出事」—— 所以每次体检都顺手扫一眼，
 * **没有也要如实显示「没有」**（省一次人工翻目录）。
 */
export function scanErrorLog(...dirs) {
  const tried = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = pathMod.join(dir, 'ErrorLog.txt');
    tried.push(p);
    let st;
    try { st = fsMod.statSync(p); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { exists: null, path: p, tried, error: (e && e.message) || String(e) };
    }
    let head = null; let lineCount = null; let textError = null;
    try {
      const text = fsMod.readFileSync(p, 'utf8');
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
      lineCount = lines.length;
      head = lines.slice(0, 8);
    } catch (e) { textError = (e && e.message) || String(e); }
    return {
      exists: true, path: p, size: st.size, mtime: st.mtime.toISOString(),
      lineCount, head, textError, tried,
      warn: '⚠️ ErrorLog.txt 有内容 —— 循环调用 / 挂载失败这类错**不进 .gia**，只写在这里；先看上面几行。',
    };
  }
  return {
    exists: false, tried,
    note: '没有 ErrorLog.txt。这条也要如实看：**循环调用 / 挂载失败只会写这个文件，不写 .gia**，'
      + '所以「.gia 里很干净」不能单独当成「脚本没出事」的证据。',
  };
}

/**
 * ★★ P1-3（《上下文瘦身设计》2026-10-07）：**跑工作区那两道门禁**（`check-lua-scope` + `check-lua-style`）。
 *
 * 为什么下沉：AI 每轮照抄「`check-lua-scope` → `check-lua-style` → `deploy`」四步 ⇒ 合并成一次调用。
 * 口径：
 *   · 显式拿 **source 文件**当参数（不用 `--map`，避免"扫了哪几张图"的歧义）；
 *   · 工程根 = 从 source 往上找含 `tools/check-lua-scope.mjs` 的目录（最多 6 层）；
 *   · **找不到工具就报错**（`code:"GATES_NO_TOOLS"`），**绝不静默放行**（"判不了"不等于"通过"）；
 *   · 任一道 exit≠0 ⇒ `ok:false`，并把该门的**输出尾部**回放出来（人/ AI 都能直接看）。
 *
 * @param {string} source 要部署的本地文件绝对路径
 * @param {{levelId?: string}} [lv]
 */
export function runWorkspaceGates(source, lv) {
  const abs = pathMod.resolve(String(source || ''));
  if (!abs || !fsMod.existsSync(abs)) return { ok: false, code: 'GATES_NO_SOURCE', error: 'source 不存在：' + JSON.stringify(abs) };
  let root = pathMod.dirname(abs);
  let found = null;
  for (let i = 0; i < 6; i += 1) {
    const p = pathMod.join(root, 'tools', 'check-lua-scope.mjs');
    if (fsMod.existsSync(p)) { found = { root, scope: p, style: pathMod.join(root, 'tools', 'check-lua-style.mjs') }; break; }
    const up = pathMod.dirname(root);
    if (up === root) break;
    root = up;
  }
  if (!found) {
    return {
      ok: false, code: 'GATES_NO_TOOLS',
      error: '从 source 往上 6 层没找到 `tools/check-lua-scope.mjs` ⇒ **判不了**，按「宁可失败也不写盘」处理。'
        + '要么把 source 放进工作区（`案子/<地图>/2.代码/…`），要么别用 `gates:true`（用 `withGates` 走插件内置检查）。',
    };
  }
  const run = (cmd, cmdArgs) => {
    try {
      const out = execFileSync(process.execPath, [cmd, ...cmdArgs], {
        cwd: found.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 120000,
      });
      return { exit: 0, tail: String(out).slice(-600) };
    } catch (e) {
      const tail = String((e && (e.stdout || e.stderr)) || (e && e.message) || '').slice(-600);
      return { exit: e && typeof e.status === 'number' ? e.status : 1, tail };
    }
  };
  const scope = run(found.scope, [abs]);
  const style = fsMod.existsSync(found.style) ? run(found.style, [abs, '--summary']) : { exit: 0, tail: '（本工作区没有 check-lua-style.mjs，跳过）' };
  const gates = {
    root: found.root, levelId: (lv && lv.levelId) || null,
    scope: { exit: scope.exit, tail: scope.tail },
    style: { exit: style.exit, tail: style.tail },
  };
  if (scope.exit === 0 && style.exit === 0) return { ok: true, gates };
  return {
    ok: false, code: 'GATES_FAILED',
    error: '工作区门禁没过：`check-lua-scope` exit=' + scope.exit + ' · `check-lua-style --summary` exit=' + style.exit
      + '（两者的输出尾部在 `gates` 里）⇒ **没有写盘**。',
    gates,
  };
}

/**
 * 部署后对账：**地图里嵌的脚本** vs **刚投进去的活文件**。
 *
 * 为什么需要（2026-09-23 真踩）：部署完没重新开局，白等了 8 分钟才发现「根本没开局」。
 * 更隐蔽的一种是：**编辑器把活文件内容吃进 `.gil` 的时机取决于它自己**（实测一次保存让 `.gil`
 * 涨了 ≈ 那次部署的脚本增量）—— 所以「部署成功」不代表「编辑器已经拿的是新版」。
 * 直接把结论写进回执，人不用自己推。
 */
export function reconcileWithGil(lv, livePath) {
  try {
    if (!lv.gil || !lv.gil.path) return { ok: false, reason: '这个关卡下没有 .gil（编辑器里还没存过盘？）' };
    const gil = readGil(lv.gil.path);
    if (!gil.ok) return { ok: false, reason: '地图读不出来：' + gil.error, gilPath: lv.gil.path };
    const all = Array.isArray(gil.scripts) ? gil.scripts : (gil.script ? [gil.script] : []);
    if (!all.length) {
      return {
        ok: false, gilPath: lv.gil.path,
        reason: '地图里没有脚本映射记录 —— 说明编辑器还没把脚本挂到这个关卡上（或没存盘）',
      };
    }
    const cur = inspect(livePath);
    /*
     * ★ 先按**名字**在多脚本映射表里挑出与本次活文件同一条（0.3.1，反馈 A1）：
     *   多脚本工程的 `#50` 第一条常常是**旧占位**（实测「新建客户端脚本」），
     *   直接拿它去比，得到的永远是「地图快照属于另一个脚本」这种没用的话。
     *   挑不到就**退回第一条**（行为与旧版一致，不假装）。
     */
    const picked = pickScriptMapping(all, pathBasenameOf(livePath));
    const embedded = picked.mapping || all[0];
    /*
     * ⚠️ 判据**不是**「拿地图里嵌的哈希和这个文件比」那么简单（2026-09-25 修）：
     *    一个关卡可以有多个活文件，若地图里嵌的**根本是另一个脚本**，那两个哈希本来就不同源 ——
     *    这时报「地图里嵌的还是旧版 → 先别急着试玩」是**反向假告警**。
     *    所以判断逻辑抽到 `compareScriptSnapshot`（纯函数，可单测）：名字对不上就**不比**，如实说清。
     */
    const cmp = compareScriptSnapshot({
      embedded,
      live: { name: pathBasenameOf(livePath), path: livePath, sha256: cur.sha256, size: cur.size },
    });
    return {
      ok: true, gilPath: lv.gil.path,
      match: cmp.match,
      // ⚠️ 只有 `skipped` 为 null 时 `match` 才有意义（跨脚本时 match=null → **不判**）
      skipped: cmp.skipped || null,
      embedded: cmp.embedded,
      live: cmp.live,
      // 多脚本工程里「挑中的是不是同一份」也要能看见（挑不到时 matchedBy 为 null）
      mappingId: embedded ? embedded.mappingId : null,
      mappingMatchedBy: picked.matchedBy,
      mappingCount: all.length,
      embeddedSha256: cmp.embedded ? cmp.embedded.sha256 : null,
      liveSha256: cur.sha256,
      embeddedBytes: cmp.embedded ? cmp.embedded.bytes : null,
      liveBytes: cur.size,
      conclusion: cmp.conclusion,
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/**
 * `op=deploy` 的 `nextStep` —— **分清「这份挂过没有」**。
 *
 * 同事实测（2026-09-25）：原来只有一句「先在编辑器里存盘（地图里嵌的还不是这一版）」。
 * 对**从没在编辑器里挂载过的新脚本**，真正缺的那一步是「**先挂到容器节点上**」——
 * 存盘不解决任何问题（地图里根本没有这条挂载记录），而人是照着 nextStep 做事的。
 *
 * 判据来自 `mountStatusOf`（地图存档里嵌的脚本名 ↔ 这份活文件的名字）：
 *   · 已挂载 → 原来的「存盘 / 重新试玩」；
 *   · 没挂过 → 明说「先挂到容器节点上」；
 *   · **判断不了 → 明说判断不了**（前缀一句，后面照旧给可执行的建议，绝不编一个结论出来）。
 */
export function deployNextStep(ms, rec, destPath) {
  const name = pathBasenameOf(destPath);
  if (ms && ms.mounted === false) {
    return '这份（' + name + '）**还没挂到容器节点上**：' + ms.note
      + ' → 先在编辑器里把它**挂到客户端控件容器的容器节点上**，再重新试玩一局。'
      + '拿不准哪个才是你正在改的，先用 miliastra_health 看清这个关卡下有哪些活文件（也可以直接传 file 指定）。';
  }
  const base = rec && rec.match === true
    ? '停掉当前试玩 → 重新试玩一局，然后 miliastra_log 取回结果'
    : (rec && rec.skipped
      // ② 跨脚本时**不给**「先别急着试玩」这种结论：两个不同脚本的哈希本来就不同源，
      //    该做的是先弄清「哪个才是你正在改的」
      ? '地图里嵌的是 ' + ((rec.embedded && (rec.embedded.file || rec.embedded.name)) || '另一个脚本')
        + '，与本次的 ' + name + ' 对不上 → 先用 miliastra_health 看清这个关卡下有哪些活文件，'
        + '确认哪个才是你正在改的（也可以直接传 file 指定）'
      : '先在编辑器里存盘（地图里嵌的还不是这一版）→ 再重新试玩一局');
  /*
   * ★★ 2026-10-04（《插件调用优化方向》第 1 条）：把「**存盘 → 试玩 → 对账**」三步**固化**进 `nextStep`
   *   （作者本轮靠对账两次，才分清"没存盘"和"真 bug"）。挂在原有结论后面，不替换它 —— 原有结论回答
   *   "这一次该做什么"，这三步回答"怎么确认游戏里真的跑的是这一版"。
   */
  const chain = '　★ 三步别省：**① 编辑器存盘**（游戏跑的是存盘时嵌进 `.gil` 的那份，不是活文件）'
    + ' → **② 让人点试玩** → **③ `miliastra_map op=script` 看 `match:true`**（false = 他试的是旧代码，别急着查脚本）。'
    /*
     * ★★ P3-8（《上下文瘦身设计》2026-10-07）：**判据归口** —— 每张图的坐标系 / 验证链 / 坑清单
     *   以 `案子/<地图>/AGENTS.md` 的「记忆」段为**唯一出处**；回执只**指向**它，AI **引用**而不要每轮复述。
     *   ⚠️ 插件只知道**关卡 ID**、不知道地图名 ⇒ 给出"怎么认名字"的方法（**不猜**）。
     */
    + '　★ 本图的**坐标系 / 验证链 / 坑清单**以 `案子/<地图>/AGENTS.md` 的「记忆」段为**唯一出处**'
    + '（用关卡 ID 在 `案子/*/AGENTS.md` 的「基本信息」表里认地图名）—— **引用它，别在回复里复述**。';
  const tail = ms && ms.known === false ? '（**挂没挂过判断不了**：' + ms.note + '）' + base : base;
  return tail + chain;
}

/** 递归收集目录里的 `.lua`（跳过 `_*` / `.*` 目录；返回跳过了什么，别静默）。 */
export function collectLuaFilesForRects(root, { maxFiles = RECT_MAX_FILES } = {}) {
  const files = [];
  const skipped = [];
  const walk = (dir) => {
    let entries;
    try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      skipped.push({ path: dir, reason: '读不动：' + ((e && e.message) || e) });
      return;
    }
    for (const ent of entries) {
      const full = pathMod.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (/^[_.]/.test(ent.name) || ent.name === 'node_modules') { skipped.push({ path: full, reason: '目录（历史/隐藏/依赖）' }); continue; }
        walk(full);
        continue;
      }
      if (!/\.lua$/i.test(ent.name)) continue;
      if (RECT_SKIP_FILE.test(ent.name)) { skipped.push({ path: full, reason: '历史产物/备份/试玩探针源码（收进来会造出假配对）' }); continue; }
      if (files.length >= maxFiles) { skipped.push({ path: full, reason: '超过一次最多扫 ' + maxFiles + ' 个 .lua' }); continue; }
      files.push(full);
    }
  };
  walk(root);
  return { files, skipped };
}

export const RECT_MAX_LIST = 400;

/** 一次扫多少个 `.lua`（超过就如实报 `truncated`，不静默截断）。 */
export const RECT_MAX_FILES = 60;

/** 扫工程目录时要跳过的活文件（历史产物 / 备份 / 试玩探针源码 —— 收进来只会造出假配对）。 */
export const RECT_SKIP_FILE = /(^_)|(_备份\.lua$)|(\.bak$)|(\.engine\.lua$)|(\.save\.json$)/i;

export const CODE_TOOL = {
    name: 'miliastra_code',
    description:
      TITLE + '：活文件（沙箱里的 .lua）的读 / 部署 / 体检 / 还原。**部署一律：先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM**（带 BOM 原神会报 Lua 错）。\nop=read 读沙箱活文件正文（**给了 `source` 绝对路径就读那个文件**，只读不写）；op=deploy 投进去（**覆盖前自动备份** + Lua 结构校验，默认 `lintMode:"strict"` 直接拒绝）；op=inspect 只体检；op=backup / op=backups / op=restore（**backup 可不传** = 固定名 `<原名>.bak`）；op=fixbom。\n⚠️ 部署**不会热加载**正在进行的试玩：要 **停试玩 → 部署 → 重开试玩**。\n★ **安全约定**：活文件是**唯一副本** ⇒ 备份失败就中止、原子写、写完校验 SHA（不过**自动回滚**）、备份两份**永不自动删**、跳过备份要 `allowNoBackup:true`。\n★ **`op=deploy` 选目标只用名字、不按「最近改动」猜**：`file` > `source` 同名活文件 > 目录里只有 1 个 > 拒绝并列候选；回执恒带 `dest`。\n★ **部署指纹**：成功后记 `.miliastra-deploy.<脚本名>.json`；`op=inspect` 对不上就直说「多半是编辑器把内存版存回了磁盘」。\n★ **`op=lint-ui`（平台级 UI 门禁，只报数字与位置）**：画在哪=点哪算 · 坐标/尺寸 8 的倍数 · 字号只许 64/52/28/22 · **h ≥ 字号×1.4 且 h ≥ 字号+16**（真机铁律：高度不够 ⇒ 该控件**一个像素都不画**）；`passed` 不代表 UI 合格。\n★ 另见 `docs/功能详解.md`（各 op 的配对口径 / 已知坑 / 下沉说明）。\n\n\n\n**典型调用**：`{"op":"inspect"}`（体检 + 看有没有被编辑器写回旧版）｜`{"op":"read","source":"C:/me/背景图片.lua","head":60}`（只读看任意本地 .lua）｜`{"op":"deploy","source":"D:\\\\code\\\\双相\\\\双相_v9.lua","file":"双相.lua"}`（**多脚本工程必须带 `file`**）｜`{"op":"lint-ui","dir":"D:\\\\code\\\\侦探1","summaryOnly":true}`（其余请求体见 `docs/功能详解.md`）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'deploy', 'inspect', 'backups', 'backup', 'restore', 'fixbom', 'levels', 'rects', 'lint-ui', 'preflight'], description: '默认 inspect。`dir` 给 op=rects / op=lint-ui / op=preflight。' },
        receipt: { type: 'string', enum: ['full', 'min'], description: '默认 full。`min` = **精简骨架档**（换一小撮决策必需字段）；与 `summaryOnly` 不重叠：那个是「去掉体积、保留原字段」，这个是「换骨架」。' },
        gates: { type: 'boolean', description: 'op=deploy：部署前跑**工作区**那两道门禁（check-lua-scope + check-lua-style），**没过就不写盘**。与 `withGates`（插件内置检查）分工不同，可同时用。' },
        sync: { type: 'array', items: { type: 'string' }, description: 'op=deploy：部署成功后把活文件**二进制同步**到这些镜像绝对路径，并逐个 SHA 复验（只写不删；失败回 ok:false + deployOk:true）。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（如 1073741833，选的是**哪张图**；不是玩法里的第几关 —— 那个用 `stage`）；省略=当前关卡。' },
        file: {
          type: 'string',
          description: '指定活文件名（省略=该关卡最近改动的那个 .lua）。',
        },
        source: {
          type: 'string',
          description: 'op=deploy：要投进去的本地文件**绝对路径**；op=read 也可以（只读）。',
        },
        backup: {
          type: 'string',
          description: 'op=restore：要还原的备份文件绝对路径（从 op=backups 拿）。**省略 = 用固定名那份 `<原名>.bak`**。',
        },
        backupDir: {
          type: 'string',
          description: '备份目录。默认 = 活文件旁边的 `_backup\\`；环境变量 MILIASTRA_BACKUP_DIR 可改（一般别动）。',
        },
        noBackup: {
          type: 'boolean',
          description: 'op=deploy：跳过备份。**默认 false，正常部署请勿使用** —— 备份是这块脚本唯一的还原手段。真要跳过必须同时传 allowNoBackup:true。',
        },
        allowNoBackup: { type: 'boolean', description: 'op=deploy：确认「我知道跳过备份的后果」。仅与 noBackup:true 搭配使用。' },
        lintMode: {
          type: 'string',
          enum: ['strict', 'warn', 'off'],
          description: 'op=deploy：Lua 结构校验强度。strict（默认）=不通过就拒绝部署；warn=只提示照投；off=不校验。',
        },
        withGates: {
          type: 'boolean',
          description: 'op=deploy：写盘前先跑内置 preflight，没过就**不写盘**并回放失败门。',
        },
        head: { type: 'number', description: 'op=read：只返回前 N 行（默认 80，0=全文）。活文件与 source 两条路都听它。' },
        stage: {
          type: 'string',
          description: 'op=levels：**玩法里的第几关**（序号或名字片段）；省略=全部关卡。⚠️ `level`=地图关卡 ID（哪张图），`stage`=游戏里的第几关。',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'op=levels / op=lint-ui / op=deploy / op=preflight：只去体积不去结论（deploy 省 `candidates[]`）。默认 false。',
        },
        nearPx: {
          type: 'number',
          description: '近似阈值（**筛选，不是判定**）。op=levels 默认 48px；op=rects 逐字段容差默认 4px（差异给在 `delta` 里）。',
        },
        nameHint: {
          type: 'string',
          description: 'op=levels：关卡表的**变量名**（默认 `LEVELS`，`local` 与 `DATA.` 两种写法都认；抽不到会列 `nameCandidates`）。',
        },
        dir: {
          type: 'string',
          description: 'op=rects / op=lint-ui：要扫的**工程目录绝对路径**（递归找 `.lua`，跳过 `_*`/`.*` 与备份产物，跳过什么在 `skipped[]`）。省略 = 当前关卡活文件目录。',
        },
        pairs: {
          type: 'array',
          items: { type: 'object' },
          description: 'op=rects / op=lint-ui：**人点名的**名字对照，如 `[["ovB1","T_START"]]` —— 画面在 view、热区在 input，名字往往不同，**不猜语义**。',
        },
        files: {
          type: 'array',
          items: {},
          description: 'op=lint-ui：**文件名数组**（只查这几个）；op=deploy：**多文件批量** `[{file, source}]`（**任一失败整体回滚**）。',
        },
        uiConfig: {
          type: 'object',
          description: 'op=lint-ui：覆盖默认档位 —— `{grid:8, fonts:[64,52,28,22], lineHeight:1.4, slack:16}`（回执 `usedConfig`）。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'inspect');
      /*
       * ★ op=read + source：读**任意绝对路径**的 .lua（**只读**）。
       *
       * 为什么放在 `resolveLevel` 之前：作者要读的那份脚本（背景图片.lua）根本不在沙箱里，
       * 而「这台机器上正在开发哪张图」与「要读哪个文件」没有任何关系 ——
       * 让关卡解析先跑，只会在「还没挂脚本 / 换过图」时把这条只读路径误伤掉。
       *
       * ⚠️ 只读：这条路径不写任何文件，也**不给任何写 op 开「用 source 指任意路径」的口子**
       *    （deploy / restore / fixbom 的 source 语义一字未动）。
       */
      if (op === 'read' && typeof args.source === 'string') {
        const r = readLuaAt(args.source, { head: args.head });
        return {
          op,
          source: args.source,
          readOnly: true,
          ...r,
          hint: r.ok
            ? '这是只读读取（没有写入任何文件）。要把它搭进模拟器：miliastra_sim op=bind source=<同一路径> templates=[…] containerId=…'
            : '只读读取失败（什么都没写）。按 nextSteps 处理即可。',
        };
      }
      /*
       * ★ op=rects + dir（**绝对路径**）：扫任意工程目录 —— 与 op=read source 同理，
       *   「这台机器上正在开发哪张图」和「要扫哪个目录」没有关系，别让关卡解析先跑。
       */
      if (op === 'rects' && typeof args.dir === 'string' && args.dir.trim()) {
        return runRectsOp({ dir: pathMod.resolve(args.dir.trim()), scope: 'dir', args });
      }
      /* ★ op=lint-ui + dir：与 op=rects 同理 —— 「要扫哪个目录」与「这台机器上在开发哪张图」无关 */
      if (op === 'lint-ui' && typeof args.dir === 'string' && args.dir.trim()) {
        return runLintUiOp({ dir: pathMod.resolve(args.dir.trim()), scope: 'dir', args });
      }
      /* ★ op=preflight（AI 易用性反馈第 7 条）：一次把「能不能上真机」查完 —— 同样先认 `dir`（与关卡无关） */
      if (op === 'preflight' && typeof args.dir === 'string' && args.dir.trim()) {
        return runPreflightOp({ dir: pathMod.resolve(args.dir.trim()), scope: 'dir', args });
      }
      /* ★ 写盘类 op：**当前关卡有歧义就拒绝**（反馈第 10 条）—— 宁可让人显式传 level，也不猜着一张图去覆盖活文件 */
      if (op === 'deploy' || op === 'backup' || op === 'restore' || op === 'fixbom') {
        const guard = requireUnambiguousLevel(args, op);
        if (guard) return guard;
      }
      const lv = resolveLevel(args.level);
      if (!lv.luaDir) return fail(ReceiptCode.NOT_FOUND, `关卡 ${lv.levelId} 没有 external_lua_file 目录——说明还没在编辑器里挂客户端脚本。`, {
        nextStep: '这条码是机器可读的分类；具体原因看 `error` 文案 —— 按它指的地方改参数或环境后重跑。',
      });
      const pick = chooseLua(lv, args.file);
      const target = pick ? pick.picked : null;
      // ⚠️ 写盘 op（deploy）会**重新**用 pickLiveFile 定目标（见下面那一段）；其余 op 用这里的 A1 口径
      let destPath = target ? target.path : (args.file ? lv.luaDir + '\\' + args.file : null);
      let picked = pickedFields(pick);

      if (op === 'inspect') {
        const info = destPath ? inspect(destPath) : null;
        // 「上次部署的是哪一版」↔「现在磁盘上是哪一版」—— 不一致就直接说，别让人以为跑的是刚投进去那版
        const fp = destPath ? readDeployFingerprint(destPath, { backupDir: args.backupDir }) : null;
        // 这份活文件在这个关卡里挂过没有（GIL 已挂载集合 ↔ 本文件名；拿不到就 known:false，绝不猜 false）
        //   —— 任务书 §3 的验收口径：`op=inspect file=主控 main.lua` 必须能回 mounted:true
        const inspGil = gilScriptInfo(lv);
        const inspMount = destPath ? mountStatusOf({
          mountedNames: inspGil.mountedNames,
          liveName: pathBasenameOf(destPath),
          mountKnown: inspGil.mountKnown === true,
          mountSource: inspGil.mountSource,
        }) : null;
        return {
          ok: true,
          op,
          level: { brand: lv.brand, levelId: lv.levelId, accountId: lv.accountId },
          ...picked,
          mount: inspMount,
          luaDir: lv.luaDir,
          files: lv.luaFiles.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, ...(f.auxiliary ? { auxiliary: true } : {}) })),
          inspected: info,
          // ③ 点明「本次比的是哪个文件 / 指纹属于哪个文件」：指纹现在**按文件名索引**，
          //    回退到旧版单份指纹且它属于别的文件时，`fingerprintDelta` 会给出 foreignFingerprint 并且**不判**
          //    changedSinceDeploy（跨文件的两个哈希本来就没有可比性）
          deploy: fp ? {
            recordPath: fp.path,
            fingerprintSource: fp.source || null,
            fingerprintBelongsTo: fp.belongsTo || null,
            comparedFile: info ? pathBasenameOf(info.path) : null,
            ...(fp.foreign ? { fingerprintWarning: fp.note } : {}),
            ...fingerprintDelta(fp.record || null, info, { liveName: info ? pathBasenameOf(info.path) : null }),
          } : null,
          // 「.gia 里很干净」不等于「脚本没出事」—— 循环调用/挂载失败只写这个文件
          errorLog: scanErrorLog(lv.luaDir, lv.levelDir),
          // ★ P1-3：体检时就地扫一遍「已知坑」（同样**不阻断**）：命中的是**这份活文件**，带 `file:line` + 改法 + 文档链
          warnings: destPath ? uiWarnings(fsMod.readFileSync(destPath, 'utf8'), pathBasenameOf(destPath)) : [],
          knownPitDoc: UI_WARN_DOC,
        };
      }
      if (op === 'read') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到可读的活文件 —— 先用 miliastra_health 看这台机器上有哪些关卡与 .lua。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        const fs = await import('node:fs');
        const info = inspect(destPath);
        const text = fsMod.readFileSync(destPath, 'utf8');
        const lines = text.split(/\r?\n/);
        const head = Number.isFinite(args.head) && args.head >= 0 ? args.head : 80;
        return {
          ok: true, op, path: destPath, info,
          ...picked,
          lineCount: lines.length,
          text: head === 0 ? text : lines.slice(0, head).join('\n'),
          truncated: head !== 0 && lines.length > head,
        };
      }
      if (op === 'backups') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        const r = listBackups(destPath, { backupDir: args.backupDir });
        return {
          ok: true, op, dest: destPath, ...picked, backupDir: r.dir,
          fixedBackup: r.fixedPath,
          fixedExists: r.entries.some((e) => e.fixed),
          count: r.entries.length,
          entries: r.entries,
          restoreWithFixed: r.entries.some((e) => e.fixed) ? restoreCommand(null, destPath) : null,
          note: r.entries.length
            ? '还原有两条路：① **不传 backup** —— 直接用固定名那份（`' + pathBasenameOf(r.fixedPath) + '`），最省事；'
              + '② 传 backup=<上面某条 path> 指定某一版。'
              + '**无论走哪条，还原前都会自动把当前版本再备份一次**，还原错了还能再回来。'
            : '还没有任何备份（这个活文件从没被本工具覆盖过）。首次 op=deploy 时会自动产生（同时写一份固定名 `<原名>.bak`）。',
        };
      }
      if (op === 'backup') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        const r = backupFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, dest: destPath, ...picked, ...r,
          restoreWith: restoreCommand(null, destPath),
          note: r.ok ? '已写两份：固定名 `' + pathBasenameOf(r.fixed || '') + '`（还原默认用它）+ 一份带本地时间戳的历史。' : null,
        };
      }
      if (op === 'restore') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        /*
         * ★★ P0 修复（使用反馈 2026-10-02 第 2 条 —— **真实事故**：还原 0 字节的 `背景层 bg.lua` 时没传 `file`，
         *   工具按 `.gil` 挂载名挑目标，把 **表现 view.lua 覆盖成 3936 B**，靠 safetyBackup + 镜像才修回）。
         *   规矩：**备份文件名能推断出它属于哪个活文件时，就以它为准**；推断出来的目标与"当前挑中的目标"不一致 ⇒
         *   **报错，不写盘**（写错活文件 = 不可逆）。推不出来（既不是 `<原名>.bak` 也不是 `<原名>.<戳>_备份.lua`）
         *   就照旧走 `file=` / 挑选，但把 `targetInferredFrom` 如实回报。
         */
        const liveNames = (lv.luaFiles || []).map((f) => pathBasenameOf(f.path));
        const inferred = inferLiveNameFromBackup(args.backup, liveNames);
        const pickedName = pathBasenameOf(destPath);
        if (inferred && !args.file && inferred !== pickedName) {
          // 备份名说了它是谁的 ⇒ 以备份名为准（这是"最不容易错"的证据）
          const cand = (lv.luaFiles || []).find((f) => pathBasenameOf(f.path) === inferred);
          if (cand) {
            destPath = cand.path;
            // ⚠️ 这里**保持 `picked` 的原形**（typecheck 会查）——只改说明性字段，不动 `selectedFile/candidates`
            picked = { ...picked, pickedBy: 'backupName', selectedFile: inferred };
          }
        } else if (inferred && args.file && inferred !== pickedName) {
          return {
            ok: false, op, code: 'RESTORE_TARGET_MISMATCH',
            level: { levelId: lv.levelId },
            backup: args.backup, backupBelongsTo: inferred, wanted: pickedName,
            error: '备份「' + pathBasenameOf(args.backup) + '」是 **' + inferred + '** 的，但你指定的目标是 **' + pickedName + '**'
              + ' ⇒ **拒绝写盘**（写错活文件不可逆）。',
            howTo: '要么把 `file` 改成 `' + inferred + '`，要么换一份属于 `' + pickedName + '` 的备份（`op=backups` 列出来）。',
          };
        }
        // backup 可不传 = 用固定名那份（<原名>.bak）。这是「固定统一备份名」的用处：还原有确定目标。
        const r = restoreFile(args.backup || null, destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...picked, ...r,
          targetInferredFrom: inferred || null,
          error: r.error || (r.errors || [])[0] || null,
          restoreWith: restoreCommand(null, destPath),
          usedFixedBackup: r.usedFixedBackup === true,
        };
      }
      if (op === 'deploy') {
        /*
         * ★ P2-9（2026-09-30 扩展规划）：`op=deploy` **一次多文件**（多脚本工程 9 个文件 → 1 次调用）。
         *   语义（本工具定义）：**先全部备份 → 逐个写并校验 SHA → 任一失败整体回滚**（回滚用各次回执的 `backup`）。
         *   实现=**复用本工具自己的 execute**（直接引用 `CODE_TOOL`，不依赖函数名）⇒ 单文件那套安全约定原封不动。
         */
        if (Array.isArray(args.files) && args.files.length) {
          // stage3: 原来是 TOOLS.find(...) 从宿主工具数组里找回「自己」，好复用单文件 deploy 那套安全约定。
          //         现在本工具就在自己模块里 ⇒ 直接引用自己（不再反向依赖宿主的 TOOLS，去掉循环依赖嫌疑）。
          const self = CODE_TOOL;
          const results = [];
          const written = [];
          try {
            for (const item of args.files) {
              /** @type {any} 本模块 execute 的返回是多形态联合；这一处只按通用字段读，故显式 any */
              const r = await self.execute(Object.assign({}, args, {
                op: 'deploy', files: undefined, file: item.file, source: item.source, sourceFrom: item.sourceFrom,
              }));
              const okOne = !!(r && r.ok !== false);
              results.push({ file: item.file, ok: okOne, dest: (r && r.dest) || null, bytes: (r && r.bytes) || null, backup: (r && r.backup) || null });
              if (!okOne) throw new Error('第 ' + results.length + ' 个失败（' + String(item.file) + '）：' + String((r && r.error) || 'deploy 未成功'));
              written.push(r);
            }
            return { ok: true, op: 'deploy', mode: 'multi', count: results.length, results };
          } catch (e) {
            const rolledBack = [];
            const failedRollback = [];
            for (const r of written) {
              if (r && r.backup && r.dest) {
                try { fsMod.copyFileSync(r.backup, r.dest); rolledBack.push(r.dest); }
                catch (err) { failedRollback.push({ dest: r.dest, error: String((err && err.message) || err) }); }
              }
            }
            return {
              ok: false, op: 'deploy', mode: 'multi', code: ReceiptCode.FAILED,
              failedAt: results.length + 1,
              attempted: args.files.map((x) => x && x.file),
              error: String((e && e.message) || e),
              results, rolledBack, failedRollback,
              note: '多文件 deploy：**任一失败 ⇒ 已写成功的用各自 backup 回滚**。`rolledBack` = 已还原；`failedRollback` 有条目 = **没还原成功**（要手动处理）。',
            };
          }
        }
        if (!args.source) return fail(ReceiptCode.BAD_PARAM, 'op=deploy 需要 source（要投进去的本地文件绝对路径）。', {
  nextStep: '`source` 要**本地文件的绝对路径**（要投进沙箱的那份）；source 与 file 一起给最稳。',
});
        /*
         * ★ P0-1（2026-09-26）：**写盘路径只认名字**，不按「最近改动」猜。
         *
         * 旧行为：不带 `file` 时目标走 A1 的「GIL 挂载名 > mtime」—— 多脚本工程里那只手
         * 实测把 `交互 input.lua` 的内容写进了 `表现 view.lua`（活文件是唯一副本，等于毁数据）。
         * 现在由 `pickLiveFile` 唯一决定：显式 file > source 的 basename 命中 > 只有一个活文件（标 basenameMismatch）
         * > 抛错列出全部候选。只读 op（inspect/read/backups…）**保持 A1 口径不变**。
         */
        const wpick = pickLiveFile({
          levelId: lv.levelId, liveFiles: lv.luaFiles, source: args.source, file: args.file,
        });
        destPath = wpick.picked.path;
        picked = pickedFields({ ...wpick, pickedNote: wpick.note });
        picked.destBasenameMatchesSource = wpick.destBasenameMatchesSource;
        if (wpick.basenameMismatch) picked.basenameMismatch = true;
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 1 条「deploy 前自动门禁」）：
         *   `withGates:true` ⇒ **写盘前**先跑内置 `preflight`（语法 / 作用域 / 全局写审计，全是纯函数、不写盘）。
         *   没过就**不写盘**并把失败门原样回放 —— 省掉"构建 → 门禁 → deploy"里那 3~4 次往返。
         *   ⚠️ 只在显式要求时生效（默认行为一个字节不变）。
         */
        if (args.withGates === true) {
          let gate = null;
          let gateErr = null;
          try {
            gate = runPreflightOp({ dir: pathMod.dirname(pathMod.resolve(String(args.source))), scope: 'dir', args: {}, level: lv });
          } catch (e) { gateErr = (e && e.message) || String(e); }
          const gateCounts = (gate && gate.counts) || null;
          /*
           * ⚠️ 2026-10-08 实测修：原来 `|| !gate || gate.ok !== true` 把**"门禁跑不出来/判不了"**也算成没过
           *   ⇒ 回执自相矛盾（`error 0 条` 却拦下写盘、`passed:null` `counts:null`）。
           *   现在只认**明确的失败**（`passed === false` 或 error 计数 > 0）；判不了就照写，
           *   并在回执里如实标 `gatesNote`（**不假装门禁过了**）。
           */
          const gateBad = !!gateErr || (gate && gate.passed === false)
            || (gateCounts && Number(gateCounts.error || 0) > 0);
          if (gateBad) {
            return {
              ok: false, op, code: 'PRECHECK_FAILED',
              level: { levelId: lv.levelId },
              dest: destPath, ...pickedFields(wpick),
              error: gateErr
                ? ('写盘前门禁**跑不起来**：' + gateErr + ' ⇒ 按"宁可失败不许写错"处理，**没有写盘**。')
                : ('写盘前门禁没过（error ' + String((gateCounts && gateCounts.error) || 0) + ' 条）⇒ **没有写盘**。'),
              gates: gate ? {
                passed: gate.passed, counts: gate.counts,
                // 只回**前几条**失败项（回放失败门，但不把整个回执灌满）
                failing: Object.entries(gate.checks || {})
                  .filter(([, v]) => Array.isArray(v) && v.length)
                  .map(([k, v]) => ({ check: k, count: v.length, first: v.slice(0, 3) }))
                  .filter((x) => /error/i.test(x.check) || x.count > 0)
                  .slice(0, 5),
              } : null,
              nextStep: '先修掉上面的门禁项，再原样重跑这条 deploy（`withGates:true` 会在这里拦住，不会写盘）。',
            };
          }
        }
        /*
         * ★★ P1-3（《上下文瘦身设计》）：`gates:true` ⇒ **部署前跑工作区那两道门禁**
         *   （`tools/check-lua-scope.mjs` + `tools/check-lua-style.mjs --summary`，显式拿 source 当参数），
         *   **任何一道非 0 退出就不写盘**。工程根从 `source` 往上找 `tools/check-lua-scope.mjs`（**找不到就报错，绝不静默放行**）。
         *   ⚠️ 与 `withGates` 的分工：`withGates` = **插件内置**检查（语法/作用域/全局写审计，不依赖工作区）；
         *      `gates` = **工作区那套门禁**（各图自己的判据）。两个都给了就都跑，任一不过都不写盘。
         */
        if (args.gates === true) {
          const g = runWorkspaceGates(args.source, lv);
          if (g.ok !== true) {
            return {
              ok: false, op, code: g.code || 'GATES_FAILED',
              level: { levelId: lv.levelId }, dest: destPath, ...pickedFields(wpick),
              error: g.error, gates: g.gates || null,
              nextStep: '先修掉不过的那道门（上面 `gates.<门>.tail` 是它的输出尾部），再原样重跑 deploy；**没有写盘**。',
            };
          }
          args = { ...args, _gatesPassed: g.gates };
        }
        const r = deployFile(args.source, destPath, {
          backupDir: args.backupDir,
          noBackup: args.noBackup === true,
          allowNoBackup: args.allowNoBackup === true,
          lintMode: args.lintMode,
        });
        /*
         * ★ P1-3（2026-09-26）：**已知坑**启发式提醒 —— 把 6 轮真机排查换来的两条经验做成「一行 warning」：
         *   ① `sanitize(` 作用在一批模板上（复合模板 + 单图同批）⇒ 整卡不显示；
         *   ② 在构建循环 / 构建期函数里 `InstantiateClientUIControl` ⇒ 试试挪到渲染第一帧。
         *   ⚠️ **不阻断、不改 `ok`**（`ok` 语义一个字没动）；只说「**可能**是」，并给 `file:line` + 可执行改法 + 文档链。
         *   ⚠️ `warnings[]` 里现在两种元素并存：**字符串**（Lua 结构校验 / 跳过备份那类既有告警）与
         *      **对象**（这两条已知坑，带 `rule`/`where`/`fix`/`doc`）—— 按 `typeof` 分开读即可。
         */
        const pit = uiWarningsOfFiles([args.source], { readFileSync: fsMod.readFileSync, basename: pathBasenameOf });
        const warnings = [...(r.warnings || []), ...pit.warnings];
        // 成功后记一笔「这次投进去的是哪一版」—— 这是之后能发现「活文件被编辑器写回旧版」的唯一依据。
        // ⚠️ 写指纹失败**不影响部署成败**，只降级成一条 warning。
        let fp = null;
        let rec = null;
        /** @type {Array<any>|null} P1-3：镜像同步结果（`sync:[…]` 给了才有） */
        let syncResults = null;
        /** @type {any} P1-3：四方 SHA 对照（source / live / mirror[] / embed） */
        let shas = null;
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 2 条「改产物 vs 改源」防呆）：
         *   真事故是「grep 定位到改动点，改的其实是**构建产物**」⇒ 下次 build 静默覆盖，白干。
         *   判据最硬的一条：**这次投进去的内容与上一次投进去的逐字节相同** ⇒ 你的改动根本没进来
         *   （改了源没 build，或改的是产物）。⇒ 回执给 `prodUnchanged` + 一句人话。
         */
        let prodUnchanged = null;
        if (r.ok && destPath) {
          const before = readDeployFingerprint(destPath, { backupDir: args.backupDir });
          const beforeSha = before && before.record ? (before.record.sha256 || before.record.sha || null) : null;
          const nowSha = inspect(destPath) ? inspect(destPath).sha256 : null;
          if (beforeSha && nowSha) prodUnchanged = String(beforeSha) === String(nowSha);
          fp = writeDeployFingerprint(destPath, inspect(destPath), { backupDir: args.backupDir, source: args.source });
          if (!fp.ok) {
            r.warnings = (r.warnings || []).concat(['部署已成功，但写「部署指纹」失败（只影响「活文件被外部改写」的检测）：' + fp.error]);
          }
          // 部署完立刻对账：地图里嵌的是不是刚投进去这版（不然「可以试玩了」是句空话）
          rec = reconcileWithGil(lv, destPath);
          /*
           * ★★ P1-3（《上下文瘦身设计》）：`sync:[镜像绝对路径]` ⇒ **部署成功后二进制同步镜像 + SHA 复验**。
           *   为什么要下沉：AI 每轮照抄一段 PowerShell（取三方 SHA → Copy-Item → 再复验）≈30 次。
           *   口径：**只写镜像、不删**；写完**逐个复验** sha(live)==sha(mirror)；**任一失败就 `ok:false`**
           *   （`deployOk:true` 说明"活文件其实已经写成功了"，不让人误判）。
           */
          if (Array.isArray(args.sync) && args.sync.length) {
            const list = [];
            const hexOf = (p) => createHash('sha256').update(fsMod.readFileSync(p)).digest('hex').toUpperCase();
            let liveSha = null;
            try { liveSha = hexOf(destPath); } catch (e) { liveSha = null; }
            for (const raw of args.sync) {
              const dst = pathMod.resolve(String(raw));
              const item = { path: dst, ok: false, bytes: null, sha256_12: null, error: null };
              try {
                if (!liveSha) return fail(ReceiptCode.NOT_FOUND, '读不到活文件（' + destPath + '）', {
  nextStep: '确认活文件还在（换图会换目录）；用 miliastra_health 重新定位。',
});
                fsMod.copyFileSync(destPath, dst);              // 二进制拷贝（不经过文本层）
                const st = fsMod.statSync(dst);
                const mSha = hexOf(dst);
                item.bytes = st.size;
                item.sha256_12 = mSha.slice(0, 12);
                item.ok = mSha === liveSha;
                if (!item.ok) item.error = '镜像 sha 与活文件不一致（拷贝后复验失败）';
              } catch (e) { item.error = (e && e.message) || String(e); }
              list.push(item);
            }
            syncResults = list;
          }
          /*
           * ★ `shas`：**四方对照**（源码 / 活文件 / 镜像[] / 地图里嵌的）—— 以前只有两列（`reconcile`）。
           *   与 `miliastra_health op=sha` 用的是**同一套含义**（去 BOM 的活文件 sha 用于和嵌入值比）。
           */
          {
            const hexOf = (p) => { try { return createHash('sha256').update(fsMod.readFileSync(p)).digest('hex').toUpperCase(); } catch (e) { return null; } };
            shas = {
              source: hexOf(args.source),
              live: hexOf(destPath),
              mirror: (syncResults || []).map((x) => ({ path: x.path, sha256: x.sha256_12 ? x.sha256_12 + '…' : null, ok: x.ok })),
              embed: rec && rec.embeddedSha256 ? rec.embeddedSha256 : null,
              embedEqualsLive: rec && rec.match !== undefined ? rec.match : null,
              note: '`live` = 活文件原始 sha；与 `embed`（地图里嵌的那份，**去 BOM**）比用 `embedEqualsLive`（= `reconcile.match`）。',
            };
          }
        }
        // 这份活文件**在这个关卡里挂过没有**（GIL 里的**已挂载集合** ↔ 本次的文件名；拿不到就 known:false，不猜）
        const gi = gilScriptInfo(lv);
        const ms = mountStatusOf({
          mountedNames: gi.mountedNames,
          liveName: pathBasenameOf(destPath),
          mountKnown: gi.mountKnown === true,
          mountSource: gi.mountSource,
        });
        /*
         * ★ P0-1：`destBasenameMatchesSource` 为 false 时，把 warning 放在回执**最前面**。
         *   为什么放最前：AI 是自上而下读 JSON 的，而这条是「你这次可能写到了另一个文件」——
         *   放在末尾的 warnings[] 里，实测就是没人看（上一次静默写错文件正是这么发生的）。
         */
        const mismatchWarning = wpick.warning || null;
        /*
         * ★★ 降噪（2026-09-30）：显式 `file` 时的"文件名不一致"**降级为 `note`**（不再顶 warning）——
         *   把生成物投成活文件是每次都会遇到的正常用法，置顶 warning 会淹掉真警告。
         *   判据字段（`destBasenameMatchesSource` / `basenameMismatch`）**照旧保留**。
         */
        const mismatchNote = wpick.mismatchNote || null;
        /*
         * ★ 2026-09-30（AI 易用性反馈第 6 条）：`summaryOnly:true` ⇒ **去掉 `candidates[]`**（10 条活文件的
         *   `bytes/mtime` 对"这 1 个写没写成功"毫无用处），只留 `pickedBy` + `selectedFile` + `dest`。
         *   判据字段一个不删（`mountedName` / `destBasenameMatchesSource` / `basenameMismatch` 照旧）。
         */
        const pickedSlim = args.summaryOnly === true ? (() => {
          const c = Object.assign({}, picked);
          delete c.candidates;
          c.candidatesOmitted = true;
          return c;
        })() : picked;
        return {
          ...(mismatchWarning ? { warning: mismatchWarning } : {}),
          ok: r.ok, op, level: { levelId: lv.levelId }, dest: destPath, ...pickedSlim, ...r,
          ...(mismatchNote ? { note: mismatchNote } : {}),
          /*
           * ★★ 《插件调用优化方向》第 2 条：**这次投进去的与上次逐字节相同** ⇒ 你的改动没进产物
           *   （改了源没 build / 改的是构建产物）—— 一句话省一轮。
           */
          ...(prodUnchanged === null ? {} : {
            prodUnchanged,
            prodNote: prodUnchanged
              ? '⚠️ **这次部署的内容与上一次逐字节相同**（sha 未变）⇒ 你的改动**没进这份产物**：'
                + '大概率是「改了源但没 build」，或者「改的是构建产物、下次 build 还会被覆盖」。先确认改的是哪一份。'
              : '内容与上次不同（改动确实进来了）。',
          }),
          // ★ P1-3：已知坑（对象）与既有告警（字符串）并存在这里；**不阻断**，`ok` 语义不变
          warnings: warnings.length ? warnings : (r.warnings || []),
          knownPitCount: pit.warnings.length,
          knownPitDoc: pit.warnings.length ? UI_WARN_DOC : null,
          mount: ms,
          lintSummary: r.lint ? (r.lint.ok ? '结构正常' : '发现问题') : '（未校验）',
          deployFingerprint: fp ? {
            ok: fp.ok,
            // ⚠️ `path` 故意仍是**旧版单份**那份（`.miliastra-deploy.json`）—— 既有回执与断言按它写的，
            //    不动它；这次真正写进去、之后 **op=inspect 会去读**的是 `pathByName`（按活文件名索引）。
            path: fp.path,
            pathByName: fp.pathByName || fp.path,
            sha256: (fp.record || {}).sha256 || null,
            atLocal: (fp.record || {}).atLocal || null,
          } : null,
          reconcile: rec,
          /* ★ P1-3：四方 SHA 对照 + 工作区门禁结论 + 镜像同步结果（都只在给了对应参数时才有值） */
          ...(shas ? { shas } : {}),
          ...(syncResults ? { syncResults } : {}),
          ...(args._gatesPassed ? { gates: args._gatesPassed } : {}),
          restoreWith: r.fixedBackup
            ? restoreCommand(null, destPath)
            : (r.backup ? restoreCommand(r.backup, destPath) : null),
          nextStep: r.ok ? deployNextStep(ms, rec, destPath) : null,
          /*
           * ★★ P3-7（《上下文瘦身设计》2026-10-07）：**`checklist[]` 短句数组** —— 让 AI **引用**而不是每轮复述
           *   （实测那套"存盘 → 试玩 → 对账"话术被手写 ~60 次）。三步与 `nextStep` 说的是同一件事，
           *   这里给**可引用的数组形态**（`nextStep` 是给人读的长句）。
           */
          ...(r.ok ? {
            checklist: [
              '编辑器里**存一次盘**（游戏跑的是存盘时嵌进 `.gil` 的那份，不是活文件）',
              '**重新开一局**试玩（热更不生效）',
              '`miliastra_map op=script` 看 `match:true`（false = 试的是旧代码）',
            ],
          } : {}),
        };
      }
      if (op === 'rects') {
        return runRectsOp({ dir: lv.luaDir, scope: 'level', args, level: lv });
      }
      if (op === 'lint-ui') {
        return runLintUiOp({ dir: lv.luaDir, scope: 'level', args, level: lv });
      }
      if (op === 'fixbom') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        const r = stripBomFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...picked, ...r,
          error: r.error || null,
          restoreWith: r.restoreWith || restoreCommand(null, destPath),
        };
      }
      if (op === 'levels') {
        if (!destPath) return fail(ReceiptCode.NOT_FOUND, '没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。', {
  nextStep: '先用 `miliastra_health {brief:true}` 看这台机器上有哪些关卡与 .lua；或显式传 level= 指定另一张图。',
});
        const src = fsMod.readFileSync(destPath, 'utf8');
        const nameHint = args.nameHint ? String(args.nameHint) : 'LEVELS';
        const ex = extractLevelTable(src, { nameHint });
        if (!ex.ok) {
          // ★ 抽不到表时**列出候选**：把文件里像关卡表的声明 / 赋值（`local LEVELS` / `DATA.LEVELS` / …）
          //   摆出来。只回一句「没找到」等于让人回去翻 20KB 的代码找变量名。
          const nameCandidates = ex.nameCandidates || [];
          return {
            ok: false, op, code: ReceiptCode.NOT_FOUND, file: destPath, ...picked,
            error: ex.error, line: ex.line || null, lineText: ex.lineText || null,
            searchedFor: ex.searchedFor || null, constantsFound: (ex.constants || []).length,
            nameCandidates,
            hint: ex.hint || (nameCandidates.length
              ? '关卡表多半用了别的名字 —— 把上面 nameCandidates 里的某一个传给 nameHint 再试一次'
              : '活文件里没有任何像关卡表的声明 / 赋值（`local X = {` 或 `A.X = {`）'),
          };
        }
        const cards = describeLevels(ex.levels, {
          which: args.stage == null || args.stage === '' ? null : String(args.stage),
          nearPx: clampNum(args.nearPx, 48, 0, 2000),
        });
        const summaryOnly = args.summaryOnly === true;
        return {
          ok: true, op, file: destPath, ...picked,
          matchedName: ex.matched ? ex.matched.name : null,
          nameHint,
          levelCount: ex.levels.length,
          stageFilter: args.stage == null || args.stage === '' ? null : String(args.stage),
          summaryOnly,
          canvas: findCanvas(ex.constants),
          blockLines: ex.blockLines,
          constants: ex.constants,
          levels: summaryOnly ? cards.map(levelSummary) : cards,
          coordinateNote: '坐标**按表里怎么写就怎么报**（该表约定设计坐标 y 从顶向下）。'
            + '脚本转控件坐标时会翻 y（实测 `canvasH / 2 - dy * sy`）—— **别拿这里的 y 直接和控件坐标比**。',
          disclaimer: '本工具**只给几何数字，不给「跳得过去 / 不可达」的结论** —— '
            + '那取决于跳跃初速、重力、移动平台相位，属于玩法。'
            + '`adjacent` 按**声明顺序**（脚本注释说这是通关路径顺序）；'
            + '`nearMiss` 的 `nearPx` 是**筛选阈值**，不是判定；`overlaps` 是两块矩形**真的相交**。'
            + (summaryOnly ? '' : '　想省上下文：`summaryOnly:true` 只给每关一行的数字摘要（不带平台坐标），再 `stage=N` 钻进去。'),
        };
      }
      return fail(ReceiptCode.BAD_PARAM, '未知 op：' + op, {

        nextStep: '看 `miliastra_map` 的 description 里 op 的合法取值（summary / clientui / audit-template / script / strings / nodes / anatomy / regions / nodedb）。',

      });
    },
  };
