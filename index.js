/**
 * dsh-miliastra — DSH 插件 · Host half
 *
 * 原神·千星奇域（Miliastra Wonderland）UGC 开发工具链。
 * 把这一轮排障跑通的「文件层」能力固化成原生工具：
 *
 *   miliastra_health  环境体检：当前关卡 / 活文件 / 地图 / 运行时日志目录
 *   miliastra_code    活文件：读、部署（带备份+SHA校验+无BOM检查）、体检、还原
 *   miliastra_map     地图存档 .gil：关卡信息、客户端控件谱系、可读字符串
 *   miliastra_log     运行时日志 .gia：列出局面、结构化读正文、按 TAG 过滤
 *   miliastra_playtest 试玩开跑/结束**实时**侦测（output_log.txt，实测延迟 0.07~0.18s）
 *   miliastra_probe   试玩探针：模板化渲染 → 部署 → 试玩后回收结论
 *
 * 边界（务必知道）：**编辑器 UI 里的操作（建模板 / 挂脚本 / 建容器）没有自动化通道**，
 * 插件替代不了人点编辑器，只替代「人和 AI 之间的来回搬运」。
 *
 * 三条纪律（技能 dsh-plugin-win10 / 原名 dsh-plugin-dev 实测踩出来的）：
 *   · 工具返回值必须 **lossless JSON**（所有出口过 `lossless()`）
 *   · `parameters` 必须是合法 JSON Schema（写坏会在注册期炸，严重时连发消息都失败）
 *   · 副作用全部挂 `ctx.effect`，服务用 `ctx.inject` 惰性取，缺了就降级 + warn
 */
export const name = 'dsh-miliastra';

export const inject = [];

/*
 * 工具说明的抬头。
 * ⚠️ 它会被拼进**每一个**工具的 description，而 schema 体积是**每个会话都在花的钱**
 *（smoke 里有 32KB 棘轮）—— 所以这里用短名；完整品牌名仍在系统提示段（renderPromptSection）
 * 与面板（lib/client.js）里，AI 不会因此认不出这是哪套工具。
 */

import fsMod from 'node:fs';
import { execFileSync } from 'node:child_process';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';
/** 本包目录（`index.js` 所在那一层）—— 浏览器试玩页与它的产物都从这儿取。 */
const SELF_DIR = pathMod.dirname(fileURLToPath(import.meta.url));
import { scanLevels, pickCurrent, findLevel, localLowRoot, currentLevelDecision, editorHint } from './lib/locate.mjs';
import { createHash } from 'node:crypto';
import { inspect, deploy as deployFile, pickLuaFile, rankLuaFiles, defaultBackupDir, backupFile, listBackups, restore as restoreFile, restoreCommand, stripBomFile, writeDeployFingerprint, readDeployFingerprint, fingerprintDelta, DEPLOY_FINGERPRINT_NAME, readLuaAt, pickLiveFile, compareLiveSources, normalizeLiveName, inferLiveNameFromBackup } from './lib/codefile.mjs';
import { scanRects, compareRects, expandDriverRefs } from './lib/rects.mjs';
import { snapshotFreshness } from './lib/freshness.mjs';
import { lintUiFiles } from './lib/uilint.mjs';
/* ★ 2026-09-30（AI 易用性反馈第 1/7 条）：**真语法检查** + 全局写审计 —— `op=preflight` 与 deploy 的 lint 都用 */
import { checkLuaSyntax } from './lib/lua-syntax.mjs';
import { globalWrites } from './lib/lua-audit.mjs';
import { lintLua, lintSummary } from './lib/lualint.mjs';
import { uiWarnings, uiWarningsOfFiles, UI_WARN_DOC } from './lib/uiwarn.mjs';
import { readGil, renderClientUI, extractStrings, compareScriptSnapshot, mountStatusOf, pickScriptMapping, clientUiSubtree, subtreeNodeCount } from './lib/gil.mjs';
import { readGilNodeFacts, signalInventory } from './lib/gilnodes.mjs';
import { graphAnatomy, anatomyTotals, graphOwnerNote, NODE_TYPE_LABELS, triggersOf, actionsOf } from './lib/nodegraph.mjs';
import { searchNodes, nodeById, nodeDbMeta, nodeDbFacets } from './lib/nodedb.mjs';
import { kbSearch, kbCatalog, kbEntry, kbSources, KB_ENTRIES } from './lib/kbqa.mjs';
import { readGia, listGia, filterRecords, groupRuns, playRunsOf, summarizeRuns, compareRuns, giaRunEpochs, logFreshness, giaLandingState,
  findErrorRecords, parseFileLine, attachFileLines, pairCommandsWithUi, ERROR_KIND_LABELS, ERROR_FORMS, NO_ERRORS_HINT, ERRORS_TAG_HINT, landingMisleadingHint } from './lib/gia.mjs';
import {
  playtestLogPath, scanLog, readIncrement, reduceLogLines, createPlaytestState,
  playtestSummary, shouldHit, logSize,
} from './lib/playtest.mjs';
import { PROBE_TEMPLATES, PROBE_TEMPLATE_CHOICES, PROBE_INFO, PROBE_OVERVIEW, renderProbe } from './lib/probes.mjs';
import { ROLE, ROLE_LABEL, lookupHandover, setHandover, clearHandover, readLedger, ledgerNote, ledgerPath, handoverFromString } from './lib/handover-ledger.mjs';
import {
  assetsDir, addAsset, listAssets, getAsset, removeAsset, rebuildIndex, pruneAssets, assetStats,
} from './lib/assets.mjs';
import { extractLevelTable, describeLevels, findCanvas, levelSummary } from './lib/leveldata.mjs';
import { collectMetrics, summarizeMil, summarizeLoose, metricsTimeline, conventionHint, slimMil, slimLoose } from './lib/metrics.mjs';
import { clientProcesses } from './lib/proc.mjs';
import { atomicWriteFile } from './lib/fsx.mjs';
import { minifyReceipt, withFallbackCode, ReceiptCode, fail } from './lib/receipt.mjs';
import { MIN_KIND, MIN_OPS, TITLE, VERSION } from './lib/constants.mjs';
import { renderJson } from './lib/render.mjs';
import { CLIENT_CONTROL_NAME, STARTED_AT, STRUCTURAL_NAME, classifyControls, hostStaleness, hostSummary, resolveLevel, sourceInfo } from './lib/shared.mjs';
import { KB_TOOL } from './lib/tools/kb.mjs';
import { HEALTH_TOOL } from './lib/tools/health.mjs';
import { CODE_TOOL, scanErrorLog } from './lib/tools/code.mjs';
import { MAP_TOOL, pickedFields } from './lib/tools/map.mjs';
import { LOG_TOOL } from './lib/tools/log.mjs';
import { PROBE_TOOL, chooseLua, gilScriptInfo, MOUNTED_ON_NOTE } from './lib/tools/probe.mjs';
import { SHOT_TOOL, pathBasenameOf, PREFIX } from './lib/tools/shot.mjs';
import { PLAYTEST_TOOL, clampNum, waitForPlaytestStart, sleep, HttpError } from './lib/tools/playtest.mjs';
import { SIM_TOOL } from './lib/tools/sim.mjs';
import { GEN_TOOL, genOp } from './lib/tools/gen.mjs';
import { ASSET_TOOL } from './lib/tools/asset.mjs';
import { colorMode, blobsFromGrid } from './lib/measure.mjs';
import { imageInfo, sampleGrid } from './lib/pixelart/decode.mjs';
import { simOp, disposeSimAll, simRuntimeInfo, applyBootPatch } from './lib/sim.mjs';
import { textGradient, STYLE_CHOICES } from './lib/textgradient/gradient.mjs';
import { textGradientLua } from './lib/textgradient/lua.mjs';
import { structJson } from './lib/structvar/build.mjs';
import { pixelArt } from './lib/pixelart/index.mjs';
import { vfxLua } from './lib/vfx/index.mjs';
/*
 * 素材库的两个「**平台目录**」通道（2026-09-28 接线）：
 *   · `lib/images/query.mjs`    = 平台**图片资源库**的目录事实（1543 条 / 14 类；**不落图片字节**）
 *   · `lib/sounds/search.mjs`   = 平台**音效库**的离线模糊搜索（1997 条 / 7 类；中英双查、五档相关性）
 * 两个都是**只读快照**、不联网、不写文件；快照由 `tools/build-{image,sound}-catalog.mjs` 生成。
 */
import { queryImageCatalog } from './lib/images/query.mjs';
import { searchIcons } from './lib/images/icons.mjs';
import { searchSounds, getSound } from './lib/sounds/search.mjs';
import {
  SHOT_TARGETS, shotsDir, dataRoot, listShots, planClean, removeShots, captureWindow,
  shotFileName, nextFreeName, sanitizeLabel, humanSize, judgeCapture, markSelectedCandidate,
  thumbPathFor, resolveShotFile, ensureThumbnail,
  planBurst, burstSummary, BURST_FLOOR_MS, BURST_MAX_COUNT, frameInRun,
} from './lib/shot.mjs';

function lossless(value) {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(lossless);
  if (value !== null && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `<Buffer ${value.length}B>`;
    const out = {};
    for (const k of Object.keys(value)) out[k] = lossless(value[k]);
    return out;
  }
  return value;
}

/**
 * ★★ P2-5（《上下文瘦身设计》）：**图测量** —— 读图 → 降采样 → 众数色 + 连通块。
 *
 * 输出（`summaryOnly` 去掉 `blobs` 明细，只留计数与众数色）：
 *   `{ ok, op:'measure', source, image:{bytes,w,h,cols,rows}, mode1:{hex,rgb,ratio,…}, blobsCount, blobs[], byKind, note }`
 * ⚠️ 坐标单位是**采样格**（`cols`×`rows`），不是原图像素 —— 回执里明写（要原图坐标按 `image.w/cols` 换算）。
 *
 * @param {string} src 图片绝对路径
 * @param {{cols?: number, summaryOnly?: boolean}} opts
 */

/**
 * ★★ P1-4（《上下文瘦身设计》2026-10-07）：把 `boot` 落到 `op=bind` 的**脚本副本**上。
 *
 * 口径（**永不写真源**）：
 *   · `scripts:[{path, source|sourceFrom}]` 或顶层 `source` 都支持；
 *   · 有 `sourceFrom` ⇒ **读进内存**转成内联 `source`（原文件一个字节不动）；
 *   · 逐份调 `applyBootPatch()`，把 `patched` 汇总成 `probe:{path, patched[], notes[], unsupported[], bytesBefore, bytesAfter}`。
 * 返回 `{args, probe}` —— `args` 是**改过的副本**，只交给模拟器用。
 *
 * @param {any} args `miliastra_sim` 的参数（`op=bind`）
 */

/** 供本地自测脚本读取（cordis 只认 name / inject / apply，多导出无害）。 */
export { TOOLS };

/**
 * `/miliastra/engine` 的请求体 → `simOp` 的参数。
 * **就是原样返回** —— 看着像废话，但这里出过一次静默事故（2026-09-24）：
 * 早先写成「有 `body.args` 就用 `body.args`」，而 `op=play` 的参数**本来就装在 `args` 里**，
 * 于是 `op/action` 被吃掉 → 每次调用都退化成默认的 `op=state`、且不报错 ⇒
 * 面板的试玩按钮与浏览器试玩页双双失效（iframe 一片黑、Frame 永远 0）。
 * 单独抽成函数是为了让回归能钉住它（`tests/smoke.mjs`）。
 */
export function engineArgsFromBody(body) {
  return body && typeof body === 'object' ? body : {};
}

/**
 * ★ **可选的会话名**（2026-10-01 作者：「我希望预制效果的模拟器是独立的，不受到其他影响」）。
 *
 * Host 侧本来就按会话分控制器（`lib/sim.mjs` 的 `registry`，键 = `ctx.sessionId`），
 * 但 `/miliastra/engine` 与 AI 的工具都传空 ctx ⇒ **大家共用 `'default'` 这一份工程**。
 * 于是"预制效果预览"会**改掉**模拟器页/AI 正在用的那份工程 —— 那正是作者要解决的。
 *
 * 这里只做一件事：把请求里的会话名**验一遍**（只认 `[A-Za-z0-9_-]{1,32}`），
 * 别的（空 / 怪字符 / 过长）一律回 `''` = 默认会话 —— **绝不把没验过的串当键**。
 */
export function simSessionKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : '';
}

/** 请求体里的会话名（`__session` / `session`），并把它从 args 里**摘掉**（别让引擎看到这个字段）。 */
export function engineSessionOf(body) {
  const src = body && typeof body === 'object' ? body : {};
  const key = simSessionKey(src.__session != null ? src.__session : src.session);
  const args = { ...src };
  delete args.__session;
  delete args.session;
  return { key, args };
}

/**
 * 试玩页的**版本戳**（`<字节数 base36>-<mtime base36>`）。
 *
 * 为什么要有：这一页是每次请求现读的，改完只要「重载页面」就生效 —— 但"面板里那份到底是新的还是旧的"
 * 以前**看不出来**（作者踩过：明明修了，面板里还是旧行为，来回猜了两轮）。
 * 盖上戳之后，页脚会显示 `v<戳>`，跟磁盘上一比就知道该不该点「重载页面」。
 */
export function playPageStamp(stat) {
  const size = Number(stat && stat.size) || 0;
  const mtime = Math.round(Number(stat && stat.mtimeMs) || 0);
  return size.toString(36) + '-' + mtime.toString(36);
}

/**
 * 把版本戳与**会话名**盖进试玩页（占位符 `__PLAY_STAMP__` / `__PLAY_SESSION__`）。纯函数，便于回归。
 * ★ 会话名走 `JSON.stringify` 注入成 `window.__MILIASTRA_SESSION`（页面据此把 `__session` 带回每次请求），
 *   同时塞进页脚那个 `#sess` 里 —— **人得看得出这一页对着哪一份工程**，不然"为什么这里没反应"没法自查。
 */
export function playPageSource(html, stamp, session) {
  const key = simSessionKey(session);
  return String(html || '')
    .replace(/__PLAY_STAMP__/g, String(stamp || 'unknown'))
    .replace(/__PLAY_SESSION__/g, JSON.stringify(key))
    .replace(/__PLAY_SESSION_TEXT__/g, key ? '· 会话 ' + key : '· 默认会话');
}

/* ---------------------------------------------------------------- 公共解析 */

/** 定位关卡：显式 level 参数 > 当前（最近改动、有活文件）。 */

/** 结构对象（不是客户端控件）：容器、布局、各种 HierarchyRoot，以及内置布局控件。 */
/** 客户端控件类型名（官方《客户端控件和客户端脚本》「四、相关的界面控件资产」枚举）。 */

/**
 * 从控件记录里挑出「可能可被脚本动态创建」的候选。
 * ⚠️ 「无父节点」只是**必要**条件，不是充分条件：
 *    容器节点 的独立记录通常是客户端控件容器的画布根节点（画布实例，不可创建）。
 */

/* ---------------------------------------------- op=rects：矩形提取与配对（N-1） */

/* ---------------------------------------------------------------- 工具定义 */

/**
 * `miliastra_asset` 的实现：**插件级素材库**的 ops。
 *
 * ★ 为什么单开一个工具，而不是挂成 `miliastra_code op=asset`：
 *   `miliastra_code` 的语义是「**沙箱活文件**的读/部署/体检/还原」—— 它的 `source` 指 `.lua`、
 *   它的失败模式是「覆盖唯一副本」，它的纪律是「先备份再写」。素材库的 `source` 是**图片字节**、
 *   失败模式是「存的图找不回来」、纪律是「按内容寻址 + 绝不自动删」。
 *   两套纪律塞进一个工具，AI 在 `miliastra_code` 里看到 `source` 就得先想「这次是 .lua 还是 .png」——
 *   而 op 枚举变长还会把 5.5KB 的 `miliastra_code` 说明挤爆。
 *   代价是 schema 里多一个工具条目（体积在 smoke 的 32KB 棘轮内，实测见测试输出）——
 *   用有限体积换「语义不串门」，这笔换得过。
 *
 * 所有分支都返回 `{ok, op, dir, …}`；`dir` 恒在回执里（素材落哪了必须看得见）。
 */

/* ---------------------------------------------- 生成器（miliastra_gen）

 * 定位：把第三方工具里**零平台 API 的纯逻辑**做成 AI 能直接调的能力 ——
 * 「AI 出参数/数据 → 插件出**能直接用的东西**」（作者 2026-09-28 明令：默认就出 Lua，不是数据模型）。
 *
 * 移植出处（作者已授权、唯一要求保持开源）：`xiaomoL444/ugc-tool`
 *   · `op=text-gradient` → `src/views/TextGradient/`（0 个平台 API）
 *   · `op=struct-json`   → `src/views/StructViewer/`（0 个平台 API）
 * 每个 lib 文件的**文件头**都写了「移植自 …— 源文件：…」，并列出**刻意的偏差**。
 * ⛔ 不吸收：登录 / OSS 直传 / Cloudflare Worker / 桌面伴侣（127.0.0.1:27182）/ 对方 OSS 素材 CDN。
 *
 * ⚠️ 未知 op **必须报错**（不静默回落），这条有测试钉住。
 */

/**
 * **交接值优先自动拿，拿不到才问创作者（不许编）** —— 本仓既有纪律（见工作区 `AGENTS.md` §4）。
 *
 * 这一层只做「从**当前关卡的 .gil** 里读候选」：`文本框` 的独立模板（`存为模板` 过的那种）
 * 与容器节点下**有名字的子控件**。**只有唯一候选时才自动采用**（多候选绝不替人选）。
 *
 * ⚠️ `.gil` 的控件记录只有 `{id, name, parent, children}` —— **没有类型字段** ⇒
 *    光看记录**分不出**某个有名字的子控件是文本框还是图片（所以候选名叫
 *    `namedChildrenOfContainer` 而不是 "textboxes"，并由创作者确认）。
 * @param {{level?: any}} args 工具入参（`level` = 地图关卡 ID）
 * @returns {{mode: 'control'|'template'|null, controlName: string, templateIndex: number|null, from: string|null, candidates: any}}
 *          拿不到就 `mode:null`（调用方**不许**造一个默认值）
 */

/**
 * ★★ P0-1（《上下文瘦身设计》2026-10-07）：**生成物落盘，不进回执**。
 *
 * 现状痛点：`miliastra_gen op=vfx-lua` 默认回执里 `lua` 是**整条生成物全文**（实测一次 ~67 KB 进上下文）。
 * `saveTo`（**绝对路径**）给了 ⇒ 把正文写盘（`atomicWriteFile`，原子写）、回执只留摘要：
 * `{ saved, path, bytes, lines, sha256, savedField, nextStep }`，**不再回正文**。
 * ⚠️ **不给 `saveTo` 时行为一字节不变**（仍回正文）—— 这是本项的红线。
 * ⚠️ 四个 op 统一支持（`vfx-lua` / `pixel-art` / `text-gradient` / `struct-json`）：这里在 `genOp` 外统一包一层，
 *   不去改各生成器（少动一处风险少一处）。只落**字符串**型正文（`data` 是对象时不落、原样回）。
 *
 * @param {any} res `genOp()` 的产物
 * @param {string|undefined} saveTo 绝对路径
 */

/**
 * `op=pixel-art` 的**交接值解析**（模板索引 + 容器节点索引，两个都要）。
 *
 * 规则与 `op=text-gradient` **完全一致**，只是要两个值：
 *   显式参数优先 → 都没有才去 `.gil` 自动拿（**只有唯一候选才采用**）→ 还缺就交给
 *   `pixelArt()` 回 `ok:false` + `needsHandover[]`（**绝不编**，见工作区 `AGENTS.md` §4）。
 *
 * @param {{level?: any, templateIndex?: any, container?: any}} args
 * @returns {{templateIndex: number|null, container: number|null, from: string|null, candidates: any,
 *            ledgerHits: Array<{role: string, hit: any}>}}
 */

/**
 * 从当前关卡的 `.gil` 里自动读 `pixel-art` 需要的两个交接值。
 * **只有唯一候选才采用**（多候选绝不替人选）；读不到就当"拿不到"。
 * @param {{level?: any}} args
 */

/**
 * P2-8：**已确认交接值台账**的读取口（`.gil` 拿不到时的最后一档兜底）。
 *
 * 只在「参数没给 + `.gil` 没有唯一候选」时查；查到了会在回执里记 `handoverFrom` 带 `ledger`
 * 与 `handoverLedger[]`（值 / 谁确认的 / 什么时候）—— **绝不自动写台账**（写只有
 * `miliastra_health op=handover action=set` 一条路，见 `lib/handover-ledger.mjs` 顶部说明）。
 *
 * @param {Record<string, any>} args 工具入参（用 `level` 定位关卡）
 * @param {string} role 见 `ROLE`
 * @returns {{hit: any}|null}
 */

/**
 * 把「这次用了台账里的哪几项」贴到回执上（**有才贴**，没用到就一个字段都不加 —— 形状稳定）。
 * @param {any} receipt
 * @param {Array<{role: string, hit: any}>} hits
 */

/**
 * `op=pixel-art`：图片 → **一次调用直接给可部署的像素画 Lua**（或结构体 JSON / 块数据）。
 * 纯编排 —— 全部算法在 `lib/pixelart/`。
 * @param {Record<string, any>} args
 */

/* ---------------------------------------------- 系统提示段的数据源（0.0.10）
 *
 * ⚠️ 为什么**从数据生成**而不是手写一段话：
 *    那段提示是「AI 的开场指路」，它天生是**第二份副本** —— 而第二份副本必然漂移。
 *    实证：0.0.9 之前那段只覆盖 5 个工具，`miliastra_playtest` / `miliastra_shot`
 *    （0.0.4~0.0.8 加的）**在提示里没有任何"什么时候用"**，而没人会发现 ——
 *    同一个病在 README 上也发过（第一段版本号停在 `0.0.1` 六次发布）。
 *    → 所以这里只维护**数据**，文案由 `renderPromptSection()` 生成；
 *      再由 `tests/smoke.mjs` 断言「不在 `PROMPT_SKIP` 里的工具，都必须有一条指路」。
 *      **加新工具时如果忘了补，smoke 会当场红。**
 *
 * ⚠️ 往里写什么：只写 **schema 表达不了的** —— 「什么时候用哪个」的决策。
 *    别复述参数/返回值/op 列表（那些工具 schema 里已经有了，抄一遍等于重复付费 + 多个会过期的副本）。
 */
export const PROMPT_SKIP = new Set(['miliastra_echo']);   // 纯调试工具：不需要在开场提示里指路
export const PROMPT_GUIDE = [
  { tool: 'miliastra_health', when: '先用它定位「当前关卡 / 活文件 / 地图 / 日志目录」（路径随账号与换图变化，禁止写死）；★ **编辑器没有"正在编辑哪张图"的通道**（窗口标题不含关卡名 / `.gil` 不锁 / 无自动保存 / 编辑器配置为空）⇒ `editorHint` 只是**间接证据**（`gil`=最近存盘、`live`=活文件最近改动，**后者会被 deploy 污染**）：**改码/部署前先问作者一句"现在在哪张图"**' },
  { tool: 'miliastra_code', when: '改完本地 lua 用 op=deploy 投进沙箱（自动备份 + SHA 校验 + 无 BOM；还会跑 Lua 结构校验）；op=inspect 看有没有被编辑器写回旧版；op=read 给 source=<绝对路径> 就只读看任意本地 .lua（不在沙箱里也行）' },
  { tool: 'miliastra_map', when: '判断「哪些控件能被脚本动态创建」用 op=clientui（只看无父节点的独立模板）；**"这张节点图在做什么"用 `op=anatomy`** —— 各类型节点多少个（事件/执行/查询/运算/分支）、入口事件、引用到的实体、关键词都能直接读（类型只覆盖随包词典命中的节点，未命中的如实计 Unknown）；要节点明细与引脚连线用 `op=nodes`' },
  { tool: 'miliastra_kb', when: '**遇到"为什么不生效/不触发/收不到"先用它**：`op=qa` 给症状关键词就回**离线蒸馏**的排查清单（先问哪几个问题 + 有序排查 + 常见误判 + 出处）；`op=node` 离线查节点说明与端口；`op=list/doc/search` 才是在线问第三方知识库（会把 query 发出去）。它**只给排查路径、不下结论**' },
  { tool: 'miliastra_log', when: '运行时结果一律用它取证（Lua 里 print，别靠猜）；**怀疑有报错就先跑 `op=errors`**（按**形态**捞、不看标签 —— 真机的报错行可能没有任何 `[...]` 前缀，按 tag grep 一条都捞不到），它还能把 `文件:行号` 解析出来' },
  { tool: 'miliastra_playtest', when: '想知道「开跑那一刻 / 现在在不在试玩」用它 —— 开跑信号在 output_log.txt（实测延迟 0.07~0.18 秒），**`.gia` 里没有**（它是一局结束后才落盘）' },
  { tool: 'miliastra_shot', when: '要看「画面对不对」用它（日志只能回答「代码跑了没」）；「等开跑 → 等 N 秒 → 连拍」是**一次调用**（op=burst awaitPlaytest:true，可先 dryRun 看计划）' },
  { tool: 'miliastra_probe', when: '★ **用试玩探针就必须提醒人**：部署完立刻说「现在去编辑器点一次**试玩**」（试玩探针只在试玩那几秒跑），试玩后再 op=collect，收完记得还原脚本。需要运行时真相（某个控件能不能建、某个枚举叫什么名）时部署试玩探针，让人重新试玩一局后 collect，**收完记得还原脚本**' },
  { tool: 'miliastra_asset', when: '要把**图片素材**存下来反复引用（UI 动画 / 粒子 / 像素画的图源）用它 —— 按内容寻址、同图只存一份；它写的是**插件数据目录**（不进游戏存档、不碰活文件），素材**绝不自动删**（remove 要显式 confirm，连字节一起删还要 deleteFile）。**要挑平台素材**也用它：`op=catalog` 查**平台图片资源库**（1543 条 / 14 类，回 id + 分类 + 有没有图 + 模拟器认不认；单图没名字、我们不编名字），**要配音效**用 `op=sound-search`（离线快照 1997 条，中英文名模糊搜 + 相关性档位，**不支持拼音**）' },
  { tool: 'miliastra_gen', when: '要**出可直接用的东西**时用它（零平台 API、不写任何文件）：`op=text-gradient` **一次调用就出可部署的 Lua**（逐帧刷字：`EnableUpdate` + `OnUpdate` 换帧；`output:"data"` 才只要数据）；`op=struct-json` 出可导入千星的变量 JSON（**结构体 ID 必须 10 位数字、单条文本 ≤500 字符**，两条硬规则不通过直接报错）；**要发光效/粒子就用 `op=vfx-lua`** —— 12 个预设（星雨/飘雪/花瓣/火星上升/星光散射/彩纸/金币汇聚/孔雀收拢/孔雀展开/萤火/气泡/火花），**先传 `preset:"list"` 挑预设**（按需枚举，不占 schema），挑好再传 id 拿可部署 Lua；贝塞尔预设可用 `path` 给"钢笔"三手柄。★ **交接值**（文本框控件名 / 控件模板索引 / 容器节点索引）它先自动读当前关卡的 `.gil`（只有唯一候选才采用），拿不到就**报错点名让你去问创作者**（`needsHandover`）—— **别自己编索引**；回执的 `nextStep` 说清怎么落地（deploy 要显式传 `level` + `file`）。`<size>` 与 4bit **未经真机验证、默认关**' },
  { tool: 'miliastra_sim', when: '它是**真机试玩之前的「预测试」**（①看 `state`/`shot` ②玩 `play` ③判 `verify`/`cases`/`frames`，三档共用一份工程）—— 要**在游戏之外先跑一遍**（建界面 / 改控件 / 跑 levelScript / 出画面 PNG）时用它；**要把真机那份脚本搬进来跑，用 `op=bind`**（给活文件路径 + 控件模板索引；**索引优先自动拿**：`op=handover` 从源码抽 → `miliastra_map op=clientui` 从 `.gil` 读 → 都拿不到才问创作者，**不许编**）；**要固定「这一版怎么验收」，用 `op=cases`**（存成人和 AI 读同一份的清单：自动项确定性重放、人工项等人打勾；`autoPassed` 不等于验收通过）；**AI 自测逻辑一律用 `op=verify`**（一次调用 = 操作 + 断言 + 判定，确定性可重复；一组用例用 `cases[]` 跑完，没过带失败帧与运行时控件名；**人玩过的那一局用 `fromHistory:true` 直接变回归用例**；**动画/动效类用 `op=frames` 出多帧 + 帧间像素差数字**）—— 写断言前先用 `op=controls` 拿控件名（`runtime:true` 看脚本运行时建出来的）；人想自己上手玩就让他开 `GET /miliastra/play`（WebGL 试玩页，与 AI 共用同一个会话）；它**不等于真机通过**（官方素材/真机渲染/联机都不覆盖）；其余 op：`op=keys`（扫键名）/ `op=patch`（改工程）/ `op=hud`（只读画面上的字）/ `op=export`/`op=import`/`op=load`/`op=save`/`op=reset`。' },
];

export const PROMPT_RULES = [
  '编辑器 UI 操作（建客户端控件模板、挂脚本、建容器节点）**没有自动化通道，必须人做**；',
  '「试玩」按钮也只能人点 —— 插件只负责把人点完之后的开跑/结束接住（不读内存、不连游戏端口、不冒充编辑器）；',
  '工具**只报数字，不下判决**（几何重叠多少 px、指标集中在哪段，都是事实；「能不能过」是作者的判断）；',
  '「磁盘是用户的」：截图与备份**绝不自动删**，清理永远要人显式点（真删还要双钥匙）；',
  '不碰用户的玩法（规则/判定/数值/组件位置），拿不准先问、给 2~3 个具体选项。',
  // ★ 这条是给**用插件的 AI** 的：这个插件的目标就是"让 AI 更好用"，而 AI 卡住的地方作者猜不到。
  //   写在提示段而不是 README，是因为**只有工具 schema 与提示段能自动到达 AI**（README/面板对 AI 是黑洞）。
  '★ 这套工具的目标是**让 AI 更好用**：你用着别扭就说 —— 缺 op / 参数绕 / 报错说不清 / 该给数字却给了文字 / 该省 token 却没省，'
    + '都值得**一句话直说**（连同「我在做什么 + 调了什么 + 期待什么 + 实际得到什么」）。想加工具或改回执字段也直接提；'
    + '仓库 `README.md` 的「AI 反馈区」有想法池与提法模板，欢迎开 Issue 或直接加一行。',
];

/** 生成系统提示段的正文（纯函数，便于断言「覆盖全不全」）。 */
export function renderPromptSection() {

  return [
    '原神·千星奇域（Miliastra Wonderland）UGC 工具链已装载，提供工具：' + TOOLS.map((t) => t.name).join('、') + '。',
    '涉及原神 UGC / 千星奇域 / 客户端控件 / levelScript / 图片资产 / 地图存档 .gil / 运行时日志 .gia 时，',
    '优先用这些工具而不是自己拼 PowerShell：',
    ...PROMPT_GUIDE.map((g) => '  · ' + g.tool + '：' + g.when),
    '硬规则：',
    ...PROMPT_RULES.map((r) => '  · ' + r),
  ].join('\n');
}

const TOOLS = [ HEALTH_TOOL,

  CODE_TOOL,

  MAP_TOOL,

  LOG_TOOL,

  PLAYTEST_TOOL,

  SHOT_TOOL,

  PROBE_TOOL,

  SIM_TOOL,

  ASSET_TOOL,

  GEN_TOOL,

  KB_TOOL,

  {
    name: 'miliastra_echo',
    description:
      '调试用：把 text 原样回显，并带上插件版本与本机存档根目录。'
      + '**怀疑「插件没生效 / 面板调不通 Host / 工具参数丢了」时先调它** ——'
      + '返回里带着你传进来的字符串，就不用猜参数到底有没有传到 Host。'
      + '\n\n**典型调用**：`{"text":"ping"}`',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的字符串。' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const text = String(args.text ?? '');
      return { ok: true, echoed: text, length: text.length, version: VERSION, localLow: localLowRoot() };
    },
  },
];

/* ---------------------------------------------------------------- 插件入口 */

export function apply(ctx) {
  const log = (...a) => console.log('[' + name + ']', ...a);

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => {
      const tools = toolsCtx.get('tools');
      if (!tools || typeof tools.register !== 'function') {
        console.warn('[' + name + '] tools 服务不可用：工具未注册');
        return;
      }
      let n = 0;
      for (const def of TOOLS) {
        try {
          const guarded = {
            ...def,
            /*
             * 第二个形参是 DSH 工具服务给的**执行上下文**（harness 是 `execute(args, exec)` 这样调的）。
             * 本插件所有 tool 的 `execute` 都只吃 `args` 一个参数（没有哪个实现用到 exec），
             * 所以这里**不往下转发** —— 将来哪个 tool 真需要它，给那个 tool 的 execute 补第二个形参即可。
             */
            async execute(args, exec) {
              try {
                return lossless(await def.execute(args));
              } catch (e) {
                return lossless({ ok: false, error: (e && e.message) || String(e), tool: def.name });
              }
            },
          };
          toolsCtx.effect(() => tools.register(guarded), name + ': tool ' + def.name);
          n += 1;
        } catch (e) {
          console.warn('[' + name + '] 注册工具 ' + def.name + ' 失败：' + (e && e.message ? e.message : e));
        }
      }
      log('已注册 ' + n + '/' + TOOLS.length + ' 个工具');
    });
  }

  // 模拟器：插件卸载/重挂时收掉所有会话的试玩 Worker，不留幽灵进程
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { void disposeSimAll(); }, name + ': sim dispose');
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.get('systemPrompt');
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return;
      try {
        // 文案由数据生成（见文件头 `PROMPT_GUIDE`）—— 不再手写，避免它变成第二份会漂移的副本
        const text = renderPromptSection();
        promptCtx.effect(
          () => systemPrompt.section({ name: 'plugin:' + name, order: 148, text }),
          name + ': prompt section',
        );
      } catch (e) {
        console.warn('[' + name + '] 系统提示注入失败：' + (e && e.message ? e.message : e));
      }
    });
  }

  // Client 半边的装配证据：向 dsh-client-modules 要 boot 图，确认本包那一行被收进去了。
  // 纯观测，不注册任何东西；服务缺失就降级为 unknown（绝不硬依赖）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['clientModules'], (cmCtx) => {
      const reg = cmCtx.get('clientModules');
      if (!reg || typeof reg.graph !== 'function') {
        clientHalfNote = 'clientModules 服务在，但没有 graph()';
        return;
      }
      clientHalfProbe = () => {
        const graph = reg.graph();
        const entries = (graph && graph.entries) || [];
        const row = entries.find((e) => e && e.id === name);
        const path = typeof reg.clientPath === 'function' ? reg.clientPath(name) : undefined;
        let bundle = null;
        if (path) {
          try {
            const st = fsMod.statSync(path);
            bundle = { path, size: st.size, mtime: st.mtime.toISOString() };
          } catch (e) {
            bundle = { path, error: (e && e.message) || String(e) };
          }
        }
        const batches = (graph && graph.batches) || [];
        const inBatch = batches.some((b) => Array.isArray(b.ids) && b.ids.includes(name));
        return {
          declared: true,
          inBootGraph: !!row,
          entryId: row ? row.id : null,
          url: row ? row.url : null,
          rev: row ? row.rev : null,
          scheduledInBatch: inBatch,
          graphEntryCount: entries.length,
          bundle,
          note: row
            ? '本包的 client bundle 已进入 window.__DSH_BOOT__ 图 —— 浏览器会加载它'
            : '本包不在 boot 图里：检查 package.json 的 dsh.client.platform 与 exports["./client"]',
        };
      };
      log('已接入 clientModules：/status 会报告 client 半边的装配状态');
    });
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer');
      if (!webServer || typeof webServer.register !== 'function') return;
      try {
        webCtx.effect(
          () => webServer.register({ kind: 'prefix', path: PREFIX, handler: makeHandler() }),
          name + ': ' + PREFIX + ' routes',
        );
        log('已挂载 ' + PREFIX + '/* 路由');
      } catch (e) {
        console.warn('[' + name + '] 路由注册失败：' + (e && e.message ? e.message : e));
      }
    });
  }
}

/* ---------------------------------------------------------------- HTTP 层 */

function isLocalRequest(req) {
  const host = String((req.headers && req.headers.host) || '');
  const bare = host.replace(/^\[/, '').split(']')[0].split(':')[0].toLowerCase();
  return bare === '' || bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new HttpError('请求体过大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError('请求体不是合法 JSON', 400)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(lossless(payload), null, 1);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 直接送文件（HTML / JS bundle）。**一律不缓存** —— 浏览器试玩页与产物都在开发中反复重建，
 *  被浏览器缓存住会变成"我明明改了怎么没生效"（这类错觉已经吃过一次）。 */
function sendFile(res, file, contentType) {
  let buf;
  try { buf = fsMod.readFileSync(file); }
  catch (e) {
    sendJson(res, 404, { ok: false, error: '读不到文件：' + file + ' —— ' + ((e && e.message) || String(e)) });
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

/**
 * Client 半边的装配证据。
 *
 * `dsh-client-modules` 提供的 `clientModules` 服务手里就有 compose 好的 boot 图
 * （即 `window.__DSH_BOOT__`），所以「面板的 bundle 到底有没有被收进启动图」
 * 不用靠眼睛看 —— `graph().entries` 里有本包这一行就是被收了。
 * 服务缺失时降级为 unknown，绝不让它影响插件加载。
 */
let clientHalfProbe = null;
let clientHalfNote = 'clientModules 服务未注入（宿主可能未启用 web 半边）';

function clientHalf() {
  if (typeof clientHalfProbe !== 'function') return { declared: true, inBootGraph: 'unknown', note: clientHalfNote };
  try {
    return clientHalfProbe();
  } catch (e) {
    return { declared: true, inBootGraph: 'unknown', note: '查询 boot 图失败：' + ((e && e.message) || String(e)) };
  }
}

/**
 * 截图目录的摘要（给面板用）。
 * 面板要在**打开时**就把「图在哪、有多少、占多大」摆出来 —— 和日志卡片同一个待遇，
 * 而不是等人点了按钮才第一次知道东西落在哪。
 */
function shotsSummary() {
  try {
    const s = listShots(shotsDir());
    return {
      dir: s.dir,
      count: s.count,
      totalBytes: s.totalBytes,
      totalText: humanSize(s.totalBytes),
      newest: s.files.length
        ? { name: s.files[0].name, mtime: s.files[0].mtime, sizeText: humanSize(s.files[0].size) }
        : null,
      // 面板默认只显示 6 张缩略图，「展开全部」到 24 张；多给一点省得再要一次
      files: s.files.slice(0, 24).map((f) => ({ name: f.name, mtime: f.mtime, sizeText: humanSize(f.size) })),
    };
  } catch (e) {
    return { dir: shotsDir(), count: 0, totalBytes: 0, totalText: '0 B', newest: null, files: [], error: (e && e.message) || String(e) };
  }
}

/**
 * 「源码比 Host 快照新」的判据 —— **纯函数**（好测：注入假版本 / mtime / 启动时刻）。
 *
 * 为什么要有它（2026-09-23 深夜真踩）：源码 22:41 改到 `0.0.9`，而 Host 是 **22:18 启动的快照**、
 * 仍报 `0.0.5` —— 定位花掉 **5 个调用**（grep `package.json`、grep `VERSION`、查进程 CreationDate、
 * 手工拼时间线）。**Host 半边是启动时的快照**这件事，应该由 Host 自己说，不该让人去推理。
 *
 * 判据两条，任一成立即算陈旧：① 源码 `package.json` 的版本 ≠ 载入的 `VERSION`；
 * ② `index.js` 的 mtime 晚于进程启动时刻。**只报事实与下一步，不猜「你改了什么」。**
 */

/** 读本包源码的版本与 mtime（读不到只返 null 字段，**绝不抛** —— 面板要能照常显示）。 */

/**
 * Host 自身的状态（`/miliastra/status` 与 `miliastra_health` **共用这一份**）。
 * 含「源码是不是比这个快照新」—— 判据只有一份，免得两处各写一套然后漂移。
 */

async function selfStatus() {
  let current = null;
  try {
    const lv = pickCurrent(scanLevels());
    if (lv) current = { brand: lv.brand, levelId: lv.levelId, luaFiles: lv.luaFiles.map((f) => f.name), logCount: lv.logCount };
  } catch { /* ignore */ }
  return {
    ok: true, plugin: name, title: TITLE,
    // Host 是**启动时的快照**：版本 / 启动时刻 / 「源码是不是比它新」都在这份里
    ...hostSummary(),
    localLow: localLowRoot(),
    tools: TOOLS.map((t) => t.name),
    probeTemplates: PROBE_TEMPLATES,
    shots: shotsSummary(),
    clientHalf: clientHalf(),
    current,
    prefix: PREFIX,
  };
}

async function runToolByName(toolName, args) {
  const def = TOOLS.find((t) => t.name === String(toolName || '').trim());
  if (!def) throw new HttpError('没有工具 ' + toolName + '（可用：' + TOOLS.map((t) => t.name).join(', ') + '）', 404);
  try {
    // 与 apply() 里那个守卫同一个理由：tool 的 execute 只吃 args，exec 上下文没有实现用到
    return { name: def.name, ok: true, data: lossless(await def.execute({ ...(args || {}) })) };
  } catch (e) {
    return { name: def.name, ok: false, error: (e && e.message) || String(e) };
  }
}

function makeHandler() {
  return async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅允许本机访问' }); return; }
    const url = new URL(req.url || PREFIX, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || PREFIX;
    try {
      // 给面板显示截图用。**这是插件里唯一会返回非 JSON 的路由**，所以路径守卫写死在这里：
      // 只认截图目录里的 .png，name 不许带路径分隔符（见 lib/shot.mjs 的 resolveShotFile）。
      if (route === PREFIX + '/shot') {
        const dir = shotsDir();
        const want = url.searchParams.get('name') || '';
        const r = resolveShotFile(dir, want);
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        const useThumb = url.searchParams.get('thumb') === '1';
        let file = r.path;
        if (useThumb) {
          // 缩略图新鲜就直接用；没有就现场生成一张（截图时其实已经顺带生成过，这里只是兜底）
          file = (await ensureThumbnail(dir, r.name)) || r.path;
        }
        let buf;
        try { buf = fsMod.readFileSync(file); } catch (e) {
          sendJson(res, 404, { ok: false, error: '读不到这张图：' + ((e && e.message) || String(e)) });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          // 文件名里带时间戳，所以同一 URL 的内容不会再变 → 允许浏览器缓存
          'Cache-Control': 'private, max-age=31536000, immutable',
        });
        res.end(buf);
        return;
      }
      if (route === PREFIX || route === PREFIX + '/status') { sendJson(res, 200, { ok: true, data: await selfStatus() }); return; }
      if (route === PREFIX + '/tools') {
        sendJson(res, 200, {
          ok: true,
          data: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 200),
              parameters: t.parameters,
            })),
          },
        });
        return;
      }
      // 浏览器试玩页（W2）：页面 + 渲染器 bundle。**给人玩的**；AI 那条路仍然是 PNG + op=verify。
      if (route === PREFIX + '/play' || route === PREFIX + '/play/') {
        /*
         * ⚠️ 这一页是**每次请求现读**的（`Cache-Control: no-store`）—— 所以改了它只要「重载页面/F5」就生效。
         * 但"面板里那份是不是新的"以前看不出来（作者踩过：明明修了，面板里还是旧行为）。
         * 于是在响应里**盖一个版本戳**（大小 + mtime），页脚会显示 `v<戳>` —— 对不上就是旧页面。
         */
        const file = pathMod.join(SELF_DIR, 'lib', 'sim-play', 'play.html');
        let html;
        try {
          html = fsMod.readFileSync(file, 'utf8');
        } catch (e) {
          sendJson(res, 404, { ok: false, error: '读不到试玩页：' + file + ' —— ' + ((e && e.message) || String(e)) });
          return;
        }
        const st = fsMod.statSync(file);
        /*
         * ★ `?session=<名>`（2026-10-01）：这一页对着**哪一份工程**。
         *   预制效果页的预览用 `presets` 会话 ⇒ 与模拟器页/AI 的那份**互不影响**。
         *   不传 = 默认会话（老行为，一个字节没变）。
         */
        const sess = simSessionKey(url.searchParams.get('session'));
        const body = Buffer.from(playPageSource(html, playPageStamp(st), sess), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (route === PREFIX + '/play-renderer.js') {
        // 产物入库（tools/build-sim-play.mjs 打的）；缺了就直说怎么补，不静默 404
        const bundle = pathMod.join(SELF_DIR, 'lib', 'sim-play', 'dist', 'play-renderer.js');
        if (!fsMod.existsSync(bundle)) {
          sendJson(res, 500, { ok: false, error: '浏览器产物缺失：' + bundle + ' —— 先跑 `node tools/build-sim-play.mjs`（或重新装一次带产物的包）' });
          return;
        }
        sendFile(res, bundle, 'text/javascript; charset=utf-8');
        return;
      }
      // 模拟器路由：面板的「模拟器」tab / 浏览器试玩页走这条（与工具共用同一个 simOp，状态不分裂）
      if (route === PREFIX + '/engine' && req.method === 'POST') {
        const body = await readBody(req);
        /*
         * ⚠️ **别把 `body.args` 拆出来当整体参数**（2026-09-24 实测踩到，症状是"看起来在跑、其实什么都没发生"）：
         * `op=play` 的参数**就装在 `args` 里** —— `{op:'play', action:'click', args:{x,y}}`。
         * 早先那版写的是 `body.args && typeof body.args === 'object' ? body.args : body`，
         * 于是 `op/action` 一起被吃掉 ⇒ `simOp({x,y})` 退化成 **`op=state`**（默认值），
         * 而且**不报错**：面板的试玩按钮、浏览器试玩页的轮询双双静默失效（iframe 里一片黑、Frame 永远 0）。
         * 现在原样交给 simOp（`engineArgsFromBody` 一行，有回归钉住）。
         * ★ 2026-10-01：多一层「会话」—— `__session` 从 body 里摘出来当 `ctx.sessionId`
         *   （不给就是默认会话，行为与以前**逐字一致**）。
         */
        const sessOf = engineSessionOf(engineArgsFromBody(body));
        sendJson(res, 200, { ok: true, data: lossless(await simOp(sessOf.args, sessOf.key ? { sessionId: sessOf.key } : {})) });
        return;
      }
      if (route === PREFIX + '/tool' && req.method === 'POST') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: await runToolByName(body.name, body.args) });
        return;
      }
      sendJson(res, 404, { ok: false, error: '未知路由：' + route });
    } catch (e) {
      sendJson(res, (e && e.status) || 500, { ok: false, error: (e && e.message) || String(e) });
    }
  };
}

/*
 * 工具出口统一收口（2026-10-08）：
 *   ① 任何工具都**不许把异常抛给调用方** ⇒ 转成 {ok:false, code:TOOL_THREW, tool, op, error, nextStep}；
 *   ② 失败档 **code 兜底**（withFallbackCode）；
 *   ③ `receipt:"min"` 骨架档（只对 MIN_OPS 名单里的 op 生效）。
 * 常量与骨架实现分别在 `lib/constants.mjs` / `lib/receipt.mjs`（本文件只调用）。
 */
for (const t of TOOLS) {
  if (typeof t.execute !== 'function') continue;
  const kind = MIN_KIND[t.name];
  const ops = MIN_OPS[t.name] || [];
  const inner = t.execute;
  t.execute = /** @type {any} */ (async (args) => {
    let res;
    try {
      res = await inner(args);
    } catch (e) {
      const op = args && args.op ? String(args.op) : null;
      return {
        ok: false, tool: t.name, op, code: 'TOOL_THREW',
        error: (e && e.message) || String(e),
        nextStep: '这条错误的**文案本身**就是给你的信息（多半是参数指错了地方：关卡号 / 路径 / op 名）。'
          + '改对参数重跑即可；如果你确认参数没问题，那就是插件 bug —— 把 tool / op / error 三个字段报出来。',
      };
    }
    res = withFallbackCode(res);
    if (!kind) return res;
    const op = args && args.op ? String(args.op) : null;
    const want = !!(args && args.receipt === 'min' && (op === null || ops.includes(op)));
    return want ? minifyReceipt(res, kind) : res;
  });
}

/** 供本地自测脚本读取（`minifyReceipt` 仍从这里可拿，测试依赖此出口）。 */
export { minifyReceipt };

/** 阶段 3：这些符号已搬进 `lib/tools/gen.mjs`，这里**再导出**以免破坏既有引用（测试 / 面板）。 */
export { genOp, applySaveTo, autoHandoverFromGil, ledgerHit, withLedgerNote, pixelArtOp, autoPixelArtFromGil, resolvePixelArtHandover } from './lib/tools/gen.mjs';

/** 阶段 3：这些符号已搬进 `lib/tools/sim.mjs`，这里**再导出**以免破坏既有引用。 */
export { patchSimBindBoot } from './lib/tools/sim.mjs';

/** 阶段 3：这些符号已搬进 `lib/tools/playtest.mjs`，这里**再导出**以免破坏既有引用。 */
export { sleep, HttpError } from './lib/tools/playtest.mjs';

/** 阶段 3：这些符号已搬进 `lib/tools/shot.mjs`，这里**再导出**以免破坏既有引用。 */
export { PREFIX } from './lib/tools/shot.mjs';

/** 阶段 3：这些符号已搬进 `lib/tools/map.mjs`，这里**再导出**以免破坏既有引用。 */
export { clientUiHint, CLIENTUI_EVIDENCE } from './lib/tools/map.mjs';

/** 阶段 3：这些符号已搬进 `lib/tools/code.mjs`，这里**再导出**以免破坏既有引用。 */
export { runWorkspaceGates, collectLuaFilesForRects } from './lib/tools/code.mjs';

/** 阶段 3：`hostStaleness` 已搬进 `lib/shared.mjs`，这里**再导出**（`tests/smoke.mjs` 等既有引用不断）。 */
export { hostStaleness };
