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

const PREFIX = '/miliastra';
const VERSION = '0.7.1';
/*
 * 工具说明的抬头。
 * ⚠️ 它会被拼进**每一个**工具的 description，而 schema 体积是**每个会话都在花的钱**
 *（smoke 里有 32KB 棘轮）—— 所以这里用短名；完整品牌名仍在系统提示段（renderPromptSection）
 * 与面板（lib/client.js）里，AI 不会因此认不出这是哪套工具。
 */
const TITLE = '千星奇域';
const STARTED_AT = Date.now();

import fsMod from 'node:fs';
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
import { simOp, disposeSimAll, simRuntimeInfo } from './lib/sim.mjs';
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

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];

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

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'HttpError'; this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 数值参数取值：非数字给默认，超出区间夹住（不静默接受离谱值）。 */
function clampNum(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
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
function scanErrorLog(...dirs) {
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

/** 取路径最后一段（回执里要报「是哪个活文件」，用的就是它）。 */
const pathBasenameOf = (p) => String(p || '').split(/[\\/]/).pop();

/**
 * 部署后对账：**地图里嵌的脚本** vs **刚投进去的活文件**。
 *
 * 为什么需要（2026-09-23 真踩）：部署完没重新开局，白等了 8 分钟才发现「根本没开局」。
 * 更隐蔽的一种是：**编辑器把活文件内容吃进 `.gil` 的时机取决于它自己**（实测一次保存让 `.gil`
 * 涨了 ≈ 那次部署的脚本增量）—— 所以「部署成功」不代表「编辑器已经拿的是新版」。
 * 直接把结论写进回执，人不用自己推。
 */
function reconcileWithGil(lv, livePath) {
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
function deployNextStep(ms, rec, destPath) {
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
    + ' → **② 让人点试玩** → **③ `miliastra_map op=script` 看 `match:true`**（false = 他试的是旧代码，别急着查脚本）。';
  const tail = ms && ms.known === false ? '（**挂没挂过判断不了**：' + ms.note + '）' + base : base;
  return tail + chain;
}

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
function resolveLevel(q) {
  const levels = scanLevels();
  if (q && String(q).trim()) {
    const hit = findLevel(levels, q);
    if (!hit) {
      const avail = levels.map((l) => `${l.brand}/${l.levelId}[${l.luaFiles.map((f) => f.name).join(',') || '无脚本'}]`);
      throw new Error(`找不到关卡 "${q}"。现有：${avail.join('  ') || '（一个都没扫到）'}`);
    }
    return hit;
  }
  const cur = pickCurrent(levels);
  if (!cur) throw new Error(`在 ${localLowRoot()} 下没扫到任何关卡目录。确认原神/千星编辑器开过图，或用参数指定。`);
  return cur;
}

/**
 * 地图存档里嵌的**脚本名候选**（`file` 优先、缺了用 `name`，再各补一个 `<名>.lua`）。
 *
 * 这是判断「活文件目录里哪个才是当前文件」的**唯一依据**（以前那条关键字启发式是私货，已删）：
 * 编辑器认的是地图里记着的挂载名，不是「名字里带没带『测试』」。
 * 读不到 GIL（没有 .gil / 解析失败 / 没脚本映射）就返回空数组 —— **静默回退 mtime**，不为它报错。
 *
 * ★ 0.3.1（反馈 A1）：**读全部映射、并且区分「已挂载集合」**。
 *   旧实现只读 `#50` 的**第一条**——6 脚本地图里第一条是旧占位「新建客户端脚本」，
 *   于是 6 次部署全部误报 `mount.mounted:false`（假阴性）。
 *
 * 按「gil 路径 + mtime」缓存：一次工具调用里可能选好几回文件，不必反复解 86KB 的 protobuf。
 */
const gilScriptCache = new Map();
/**
 * 一个关卡的地图脚本信息：`{ok, mappings, allNames, mountedNames, mountedIds, mountKnown, mountSource}`。
 * `allNames` 用于**挑活文件**（宁多勿漏）；`mountedNames` + `mountKnown` 用于**判挂载**（宁缺勿假）。
 */
function gilScriptInfo(lv) {
  const empty = {
    ok: false, mappings: [], allNames: [], mountedNames: [], mountedIds: [], mountKnown: false, mountSource: null,
  };
  if (!lv || !lv.gil || !lv.gil.path) return empty;
  const key = lv.gil.path + '@' + (lv.gil.mtimeMs || lv.gil.mtime || '');
  if (gilScriptCache.has(key)) return gilScriptCache.get(key);
  let info = empty;
  try {
    const gil = readGil(lv.gil.path);
    if (gil.ok) {
      const mappings = Array.isArray(gil.scripts) ? gil.scripts : (gil.script ? [gil.script] : []);
      const mounts = gil.scriptMounts || { known: false, refs: [], ids: [], byId: {}, note: null };
      const mountedIds = Array.isArray(mounts.ids) ? mounts.ids : [];
      const pick = (list) => {
        const out = [];
        for (const m of list) {
          const raw = [m.file, m.name].filter((x) => typeof x === 'string' && x.trim());
          for (const x of raw) {
            out.push(pathBasenameOf(x));
            if (!/\.lua$/i.test(x)) out.push(pathBasenameOf(x) + '.lua');
          }
        }
        return [...new Set(out)];
      };
      const mountKnown = mounts.known === true;
      const mounted = mappings.filter((m) => mountedIds.indexOf(m.mappingId) >= 0);
      info = {
        ok: true,
        mappings: mappings.map((m) => ({
          mappingId: m.mappingId,
          name: m.name,
          file: m.file,
          bytes: m.sourceBytes,
          sha256: m.sourceSha256,
          mountedOn: (mounts.byId && mounts.byId[m.mappingId]) || null,
          mountedOnNote: MOUNTED_ON_NOTE,
          mounted: mountedIds.indexOf(m.mappingId) >= 0,
        })),
        allNames: pick(mappings),
        // 挂载表读得到就用**已挂载集合**；读不到（老存档没有界面控件组层级）退回全部映射名
        mountedNames: mountKnown ? pick(mounted) : pick(mappings),
        mountedIds,
        mountKnown,
        mountSource: mountKnown ? 'gil-script-mounts' : 'gil-script-names',
        mountNote: mounts.note || null,
      };
    }
  } catch { info = empty; }
  gilScriptCache.set(key, info);
  return info;
}

/**
 * 取一个文件的 mtime（毫秒）；取不到就 `null`。
 * P0-2 用它给「这份快照属于哪一次」定位 —— 取不到时 `snapshotFreshness` 会**明说没有证据**，不猜。
 */
function statMsSafe(p) {
  if (!p) return null;
  try { return fsMod.statSync(p).mtimeMs; } catch { return null; }
}

/**
 * `miliastra_health op=handover`（P2-8）：**已确认交接值台账**的读 / 写 / 抹。
 *
 * 为什么要有它：`.gil` 里有 3 个容器节点时，`vfx-lua` **拒绝采用任何一个**（做得对，不猜）⇒
 * 创作者早就确认过的 `container` 每次调用都得重传（本轮 9 个脚本 = 反复重传）。
 * 确认一次、记在台账里，之后 `miliastra_gen` 自动带上。
 *
 * ⚠️ **只有 `action:"set"` 会写盘** —— 不存在"调用时传了就顺手记"这条路：
 *    那样一次传错的号会被永久写进台账，而且会**悄悄改掉「缺交接值 ⇒ ok:false」这个语义**
 *    （实测把 `gen-test` / `fx-hardening-test` 两道门禁同时打红，上一版已整块回退）。
 *
 * @param {Record<string, any>} args
 * @param {any} cur `pickCurrent(scanLevels())` 的结果（用它的 `levelId` 定位关卡）
 */
function healthHandover(args = {}, cur = null) {
  const action = String(args.action || 'get');
  /*
   * ★ 关卡优先级：**显式 `level` > 当前关卡**。
   *   ⚠️ 这里踩过一次（本套件第 ② 条抓到的真 bug）：先取 `cur` 再回头看 `args.level`，
   *   结果 `level=<A>` 的 set 被写进了"当前关卡"（`<B>`）—— 台账**串了号**，而且回执还报 B 的 levelId，
   *   看上去"成功"了。写盘类操作**永远**以显式参数为准。
   */
  let levelId = null;
  let levelSource = null;
  if (args.level !== undefined && args.level !== null && String(args.level).trim() !== '') {
    const picked = findLevel(scanLevels(), args.level);
    levelId = picked && picked.levelId ? String(picked.levelId) : String(args.level).trim();
    levelSource = 'arg';
  } else if (cur && cur.levelId) {
    levelId = String(cur.levelId);
    levelSource = 'current';
  }
  const file = ledgerPath();
  const book = readLedger();
  if (action === 'get') {
    const entry = levelId ? book.levels[String(levelId)] : null;
    const rows = entry
      ? Object.keys(entry).map((role) => {
        const cell = entry[role] || {};
        return {
          role,
          label: ROLE_LABEL[role] || role,
          value: cell.value === undefined ? null : cell.value,
          confirmedAt: cell.confirmedAt || null,
          confirmedBy: cell.confirmedBy || null,
        };
      })
      : [];
    return {
      ok: true, op: 'handover', action: 'get',
      ledgerFile: file,
      levelId,
      levelSource,
      entries: rows,
      levelsKnown: Object.keys(book.levels),
      note: rows.length
        ? '这些值会**自动**被 `miliastra_gen` 的 vfx-lua / pixel-art / text-gradient 用上（回执里标 `handoverFrom` 含 `ledger`）。'
        : (levelId
          ? '这个关卡还没有台账条目 —— 用 `action:"set"` 记下创作者确认过的值（例如 `container`）。'
          : '没定位到关卡（没扫到存档 / 也没传 `level`）⇒ 台账**按关卡记**，先给 `level`。'),
    };
  }
  if (action === 'set') {
    const given = (args.handover && typeof args.handover === 'object') ? args.handover : {};
    const wanted = [
      [ROLE.container, given.container],
      [ROLE.imageTemplate, given.imageTemplate],
      [ROLE.textboxTemplate, given.textboxTemplate],
      [ROLE.textboxControlName, given.textboxControlName],
    ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
    if (!wanted.length) {
      return {
        ok: false, op: 'handover', action: 'set', levelId,
        error: 'set 要在一个 `handover` 对象里给至少一个值：container / imageTemplate / textboxTemplate / textboxControlName。'
          + '例：{"op":"handover","action":"set","handover":{"container":1073741846,"imageTemplate":1073741849}}',
      };
    }
    const written = [];
    for (const [role, value] of wanted) {
      const r = setHandover({ levelId, role, value, confirmedBy: given.confirmedBy });
      if (!r.ok) return Object.assign({ op: 'handover', action: 'set', levelId, written }, r);
      written.push({ role, label: ROLE_LABEL[role] || role, value, replaced: r.replaced });
    }
    return {
      ok: true, op: 'handover', action: 'set', levelId, ledgerFile: file, written,
      note: '记下了（**只有显式 set 会落盘**）。之后 miliastra_gen 的 vfx-lua / pixel-art / text-gradient 会自动带上，'
        + '回执里 `handoverFrom` 会含 `ledger`，并带 `handoverLedger[]` 说明是谁什么时候确认的。',
    };
  }
  if (action === 'clear') {
    if (args.confirm !== true) {
      return {
        ok: false, op: 'handover', action: 'clear', levelId, ledgerFile: file,
        error: '抹台账要显式 `confirm:true`（它是磁盘上的文件，抹掉不可恢复）。',
      };
    }
    const r = clearHandover({ levelId });
    return Object.assign({ op: 'handover', action: 'clear', ledgerFile: file, levelId, cur: levelId }, r);
  }
  return { ok: false, op: 'handover', action, error: `没有这个 action "${action}"（可用：get / set / clear）` };
}

/**
 * `miliastra_health op=sha`（N-2）：**三方 SHA 对照** —— 活文件 / 本地镜像 / `.gil` 嵌入快照。
 *
 * 为什么值得单开一步：`deploy` 只写本地活文件，游戏跑的是**编辑器存盘时嵌进 `.gil` 的那份快照** ——
 * 「部署了但没存盘」是最容易白跑一轮的失败（作者 2026-09-26 手工核过三处 SHA 才想清）。
 * 这里只做**比对与一句话结论**，不替谁决定该用哪一版；镜像目录由调用方给（插件不假设工作区布局）。
 */
function healthSha({ mirror = null, allFiles = false } = {}) {
  const levels = scanLevels();
  const cur = pickCurrent(levels);
  if (!cur) {
    return { ok: false, op: 'sha', error: '没扫到关卡 —— 先跑 miliastra_health（不带 op）看清这台机器上有什么。' };
  }
  /* ★ 2026-09-30（AI 易用性反馈第 8 条）：`op=sha all:true` ⇒ **一次给整张表**（9 个脚本跑 9 次太贵） */
  if (allFiles === true) return shaAllFiles(cur, mirror);
  const pick = chooseLua(cur, null);
  const livePath = pick && pick.picked ? pick.picked.path : null;
  const live = livePath ? inspect(livePath) : null;
  const liveName = livePath ? pathBasenameOf(livePath) : null;

  const gi = gilScriptInfo(cur);
  const all = Array.isArray(gi.mappings) ? gi.mappings : [];
  const chosen = pickScriptMapping(all, liveName);
  const emb = chosen.mapping || (all.length ? all[0] : null);
  const embedded = emb
    ? { name: emb.name, file: emb.file, sha256: emb.sha256, bytes: emb.bytes, mappingId: emb.mappingId, mounted: emb.mounted, matchedBy: chosen.matchedBy }
    : null;

  // 镜像：按**活文件同名**匹配（忽略大小写与 .lua）；目录不存在/没有同名文件都如实说，不假装一致
  let mirrorInfo = null;
  let mirrorNote = null;
  const mirrorDir = mirror ? pathMod.resolve(String(mirror)) : null;
  if (mirrorDir) {
    if (!fsMod.existsSync(mirrorDir) || !fsMod.statSync(mirrorDir).isDirectory()) {
      mirrorNote = 'mirror 目录不存在或不是目录：' + mirrorDir + '（这一列是空的，不是"不一致"）';
    } else {
      let names = [];
      try { names = fsMod.readdirSync(mirrorDir).filter((n) => /\.lua$/i.test(n) && !/_备份\.lua$/i.test(n) && !/\.bak$/i.test(n)); } catch (e) { mirrorNote = '读不动 mirror 目录：' + ((e && e.message) || e); }
      const hit = liveName ? names.find((n) => normalizeLiveName(n) === normalizeLiveName(liveName)) : null;
      if (hit) {
        const info = inspect(pathMod.join(mirrorDir, hit));
        mirrorInfo = { name: hit, path: info.path, sha256: info.sha256, bytes: info.size, mtime: info.mtime };
      } else if (!mirrorNote) {
        mirrorNote = liveName
          ? '镜像目录里没有与活文件同名的 .lua（找的是 ' + liveName + '）—— 现有 ' + names.length + ' 个：'
            + (names.slice(0, 8).join('、') || '（一个都没有）')
          : '没有活文件可比对（先在编辑器里挂一个客户端脚本）';
      }
    }
  }

  const cmp = compareLiveSources({
    live: live ? { name: liveName, sha256: live.sha256, bytes: live.size } : null,
    mirror: mirrorInfo,
    embedded: embedded ? { name: embedded.name, file: embedded.file, sha256: embedded.sha256, bytes: embedded.bytes } : null,
    embeddedCount: all.length,
  });
  /*
   * ★ P0-2（2026-09-26）：`.gil` 那一列是**存盘快照**，不是「此刻的代码」——
   *   所以这一列必须带「它属于哪一次存盘」+「是不是当前那一份」。
   *   判据：`.gil` 的 mtime ↔ **活文件**的 mtime（活文件更新 = 还没存盘 = 不是当前那份）。
   *   ⚠️ 没 `.gil` / 没活文件 ⇒ `isCurrent:null` + 明说「没有证据」（`snapshotFreshness` 负责措辞）。
   */
  const gf = snapshotFreshness({
    kind: '存盘快照',
    name: cur.gil ? pathMod.basename(cur.gil.path) : null,
    atMs: cur.gil ? cur.gil.mtimeMs : null,
    currentAtMs: live ? Date.parse(live.mtime) : null,
    currentLabel: liveName ? '活文件 ' + liveName : null,
    what: '这份 .gil 存盘快照',
  });
  return {
    ok: true, op: 'sha',
    level: { brand: cur.brand, levelId: cur.levelId, accountId: cur.accountId },
    luaDir: cur.luaDir,
    gilPath: cur.gil ? cur.gil.path : null,
    livePath,
    pickedBy: pick ? pick.pickedBy : null,
    mirrorDir,
    mirrorNote,
    embeddedPickedBy: embedded ? embedded.matchedBy : null,
    rows: cmp.rows,
    verdict: cmp.verdict,
    conclusion: cmp.conclusion,
    caveats: cmp.caveats,
    // ★ P0-2：这份「存盘快照」的归属与新鲜度（与 miliastra_log 的 staleLog / logBelongsTo 同一个口径）
    belongsTo: gf.belongsTo,
    belongsToAt: gf.belongsToAt,
    belongsToEpochSec: gf.belongsToEpochSec,
    isCurrent: gf.isCurrent,
    currentnessNote: gf.note,
    nextStep: cmp.verdict === '该存盘了'
      ? '在编辑器里**存一次盘**（把活文件吃进地图），再回来看这一条；试玩跑的永远是嵌进 .gil 的那份。'
      : (cmp.verdict === '三方一致'
        ? '三处一致 —— 可以（stop → 重新）试玩了；跑完用 miliastra_log 取结果。'
        : null),
    note: '只报三处的哈希与一句话结论，不判「哪一版才是你要的」。镜像目录由你给（`mirror`）—— 不给就只出两列。',
  };
}

/**
 * ★★ `op=sha all:true`（AI 易用性反馈第 8 条）—— **一次给整张表**：每个活文件一行，三列哈希 + 一句话结论。
 *
 * 为什么：要确认「9 条脚本是不是都该存盘了」，旧版一次只出 3 行（一个文件），得跑 9 次。
 * 口径与单文件版**同一套**（`compareLiveSources`），只是循环每个活文件；镜像仍按**同名**匹配。
 * @param {any} cur 当前关卡
 * @param {string|null} mirror 工作区镜像目录（不传就只出两列）
 */
function shaAllFiles(cur, mirror) {
  const gi = gilScriptInfo(cur);
  const mappings = Array.isArray(gi.mappings) ? gi.mappings : [];
  const mirrorDir = mirror ? pathMod.resolve(String(mirror)) : null;
  let mirrorNames = [];
  let mirrorNote = null;
  if (mirrorDir) {
    if (!fsMod.existsSync(mirrorDir) || !fsMod.statSync(mirrorDir).isDirectory()) {
      mirrorNote = 'mirror 目录不存在或不是目录：' + mirrorDir + '（这一列是空的，不是"不一致"）';
    } else {
      try {
        mirrorNames = fsMod.readdirSync(mirrorDir).filter((n) => /\.lua$/i.test(n) && !/_备份\.lua$/i.test(n) && !/\.bak$/i.test(n));
      } catch (e) { mirrorNote = '读不动 mirror 目录：' + ((e && e.message) || e); }
    }
  }
  const liveFiles = Array.isArray(cur.luaFiles) ? cur.luaFiles : [];
  const rows = liveFiles.map((f) => {
    const live = inspect(f.path);
    const name = f.name;
    /*
     * ★★ 2026-10-02 修：**比较存盘状态时必须去掉 UTF-8 BOM**。
     *   实测（侦探0.0.3 `1073741842`）：11 条活文件**全都带 BOM**，而 `.gil` 里嵌的是**去 BOM 的那份**
     *   （`.gil` 的字节数恰好每条少 3）⇒ 直接比 sha 会把**刚存过盘的图也判成"该存盘了"**。
     *   判据：`sha256(活文件[3:]) == 嵌入 sha` —— 实测 **10/10 命中**（内容一致，只差 BOM）。
     *   ⚠️ `背景层 bg.lua` 那种 **3 字节 = 只有 BOM、没有内容** 的，`.gil` 侧是 0 字节 + 无 sha ⇒ 两边都无内容可对。
     */
    const buf = (() => { try { return fsMod.readFileSync(f.path); } catch (e) { return null; } })();
    const hasBom = !!(buf && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf);
    const noBomSha = hasBom ? createHash('sha256').update(buf.slice(3)).digest('hex').toUpperCase() : null;
    const liveShaCmp = noBomSha || live.sha256;         // 比较用：有 BOM 就用去 BOM 的那份
    const hit = mirrorDir && mirrorNames.length
      ? mirrorNames.find((n) => normalizeLiveName(n) === normalizeLiveName(name)) : null;
    const mInfo = hit ? inspect(pathMod.join(mirrorDir, hit)) : null;
    const emb = pickScriptMapping(mappings, name);
    const mapping = emb.mapping || null;
    const cmp = compareLiveSources({
      live: { name, sha256: liveShaCmp, bytes: live.size },
      mirror: mInfo ? { name: hit, sha256: mInfo.sha256, bytes: mInfo.size } : null,
      embedded: mapping ? { name: mapping.name, file: mapping.file, sha256: mapping.sha256, bytes: mapping.bytes } : null,
      embeddedCount: mappings.length,
    });
    return {
      file: name,
      liveSha: liveShaCmp ? liveShaCmp.slice(0, 12) : null,
      /* ★ 原始 sha 也留着（有 BOM 时两者不同）—— 谁要查"到底差在哪"，这两个值就是答案 */
      liveShaRaw: hasBom && live.sha256 ? live.sha256.slice(0, 12) : undefined,
      bomStripped: hasBom || undefined,
      liveBytes: live.size,
      mirrorSha: mInfo ? mInfo.sha256.slice(0, 12) : null,
      embeddedSha: mapping ? String(mapping.sha256 || '').slice(0, 12) : null,
      verdict: cmp.verdict,
      mounted: mapping ? mapping.mounted === true : null,
    };
  });
  const needSave = rows.filter((r) => r.verdict === '该存盘了').length;
  const needDeploy = rows.filter((r) => r.verdict === '该部署了').length;
  const consistent = rows.filter((r) => r.verdict === '三方一致').length;
  return {
    ok: true, op: 'sha', allFiles: true,
    level: { brand: cur.brand, levelId: cur.levelId, accountId: cur.accountId },
    luaDir: cur.luaDir,
    gilPath: cur.gil ? cur.gil.path : null,
    mirrorDir, mirrorNote,
    fileCount: rows.length,
    rows,
    summary: {
      needSave, needDeploy, consistent,
      unknown: rows.length - needSave - needDeploy - consistent,
      note: '`该存盘了` = 活文件比 `.gil` 里嵌的新（试玩跑的是嵌的那份）；`该部署了` = 活文件比镜像旧；`三方一致` = 可以直接试玩。',
    },
    nextStep: needSave
      ? ('在编辑器里**存一次盘**（把这些活文件吃进地图）：' + rows.filter((r) => r.verdict === '该存盘了').map((r) => r.file).join('、'))
      : '没有"该存盘"的文件 —— 可以直接（stop → 重新）试玩。',
    note: '口径与单文件版 `op=sha` **完全一致**（`compareLiveSources`），只是一次把全部活文件列出来。',
  };
}

/** 挑活文件用的名字候选（**全部映射**，宁多勿漏）。 */
function mountedScriptNames(lv) {
  return gilScriptInfo(lv).allNames;
}

/**
 * 选一个活文件 —— 返回 `{ picked, pickedBy, candidates, mountedName, note }`（**不再只返回文件对象**）。
 *
 * ⚠️ **一个关卡可以有多个 `.lua`**（不同角色 / 不同模块各挂一个客户端脚本），所以必须说清「凭什么选它」：
 *   · 给了 `file` → 精确匹配（`pickedBy: 'explicit'`）；找不到就**抛错并列出全部**，绝不悄悄换一个；
 *   · 没给 → 先按**地图存档里嵌的脚本名**（`pickedBy: 'gil'`），对不上才退到 **mtime 最新**（`pickedBy: 'mtime'`）。
 *
 * ★ 2026-09-25 修掉的那条：这里原来是**关键字启发式**（`/双相|测试|main|levelScript/`，命中即返回）——
 *   同事的目录里有 `game_01.lua`（真正挂载的）/ `测试.lua`（最旧）/ `背景图片.lua`（刚部署）时，
 *   它稳定选中 `测试.lua`：`op=inspect` 体检了最旧的那个、`reconcile` 拿它的快照去比别人的文件，
 *   还给出「地图里嵌的还是旧版，先别急着试玩」这种反向假告警。
 *   排序/选择现在**只有一份实现**（`lib/codefile.mjs` 的 `rankLuaFiles`），与 `pickLuaFile` 共用。
 * `miliastra_health` 会把**全部**活文件列出来，供调用方挑选。
 */
const chooseLua = (lv, name) => {
  if (!lv || !lv.luaFiles.length) return null;
  const info = rankLuaFiles(lv.luaFiles, { mountedName: mountedScriptNames(lv) });
  if (name) {
    const hit = lv.luaFiles.find((f) => f.name === name);
    if (!hit) {
      throw new Error(`关卡 ${lv.levelId} 下没有活文件 "${name}"。现有：${lv.luaFiles.map((f) => f.name).join('、')}`);
    }
    return { ...info, picked: hit, pickedBy: 'explicit', pickedNote: '按显式 file 参数选中（其余候选仅供参考）' };
  }
  return info;
};

/**
 * 「这次用的是哪个活文件、凭什么」—— 每个 op 的公开回执都带上它（`pickedBy` / `candidates`）。
 * 纯展示；**不含 undefined**（`smoke` 与宿主都会拒收含 undefined 的结果）。
 */
function pickedFields(pick) {
  if (!pick) return { pickedBy: null, selectedFile: null, candidates: [] };
  const out = {
    pickedBy: pick.pickedBy,
    selectedFile: pick.picked ? pick.picked.name : null,
    candidates: pick.candidates || [],
  };
  if (pick.mountedName) out.mountedName = pick.mountedName;
  const note = pick.pickedNote || pick.note;
  if (note) out.pickedNote = note;
  return out;
}

/** 结构对象（不是客户端控件）：容器、布局、各种 HierarchyRoot，以及内置布局控件。 */
const STRUCTURAL_NAME = /客户端控件容器|布局|HierarchyRoot|小地图|技能区|队伍信息|生命值条|摇杆|退出按钮|语音|选项卡|聊天按钮|网络状态|挣扎按钮|提示队列/;
/** 客户端控件类型名（官方《客户端控件和客户端脚本》「四、相关的界面控件资产」枚举）。 */
const CLIENT_CONTROL_NAME = /^(容器节点|文本框|文本视窗|图片|界面动效|全屏界面动效|预设按钮|按键提示|光标检测区域|网格视窗|模板引用控件)$/;

/**
 * 子树的**深度**（根 = 0；叶子回 0）。贪婪扫（`op=clientui kind:"all"`）用。
 * @param {any} node `clientUiSubtree()` 的产物
 */
function maxDepthOf(node) {
  if (!node) return 0;
  let d = 0;
  for (const c of node.children || []) d = Math.max(d, maxDepthOf(c) + 1);
  return d;
}

/**
 * 从控件记录里挑出「可能可被脚本动态创建」的候选。
 * ⚠️ 「无父节点」只是**必要**条件，不是充分条件：
 *    容器节点 的独立记录通常是客户端控件容器的画布根节点（画布实例，不可创建）。
 */
function classifyControls(clientUI) {
  const standalone = clientUI.filter((r) => r.parent == null);
  const likelyTemplates = standalone.filter((r) => CLIENT_CONTROL_NAME.test(r.name));
  const likelyContainers = standalone.filter((r) => r.name === '容器节点');
  const structural = standalone.filter((r) => STRUCTURAL_NAME.test(r.name)).map((r) => ({ id: r.id, name: r.name }));
  /*
   * ★ E6（2026-09-29 实战反馈）：`likelyTemplates` 里混进了**容器节点**，与 `likelyContainers` 重叠 ⇒
   *   调用方看着像"4 个候选模板"，其中两个其实不能当控件模板用。
   *   ⇒ 每条给 `role`（container / control），并把重叠**点名**（不删字段：同一批记录两种用途，删了会丢信息）。
   */
  const roleOf = (r) => (likelyContainers.some((c) => c.id === r.id) ? 'container' : 'control');
  const withRole = (list) => list.map((r) => Object.assign({}, r, { role: roleOf(r) }));
  const overlapIds = likelyTemplates.filter((r) => likelyContainers.some((c) => c.id === r.id)).map((r) => r.id);
  const roleNote = overlapIds.length
    ? '⚠️ 有 ' + overlapIds.length + ' 条同时在 likelyTemplates 与 likelyContainers 里（' + overlapIds.join(', ') + '）—— 它们是**容器节点**，不是可创建的控件模板。看 `role` 字段分辨；容器节点不该当控件模板用（控件要 InstantiateClientUIControl，容器由创作者在画布上摆）。多个候选形态相同时：让创作者点名，或删掉多余的那些。'
    : null;
  return { standalone, likelyTemplates: withRole(likelyTemplates), likelyContainers: withRole(likelyContainers), structural, roleNote };
}

/**
 * 「哪些号真的能被创建」的**一次真机实测记录** —— 必须连**来源关卡**一起说，否则就是假事实。
 *
 * 同事实测（2026-09-25）：`op=clientui` 的 hint 里写死了「实测佐证：**本关** 1073741867(文本框) /
 * 1073741868(图片) 可创建」，而他那张图的 likelyTemplates 是 1073741850/1852/1854/1846 ——
 * 那两个号**来自另一张图**的实测。「本关 + 别人的号」看起来就是一条事实，最容易被当真。
 */
export const CLIENTUI_EVIDENCE = {
  /** 那次实测是在**哪张图**上做的（不许省掉——省掉就变成"本关"了）。 */
  levelId: '1073741833',
  where: '《冰镜·火烛》那次真机实测',
  creatable: [
    { id: 1073741867, name: '文本框' },
    { id: 1073741868, name: '图片' },
  ],
  notCreatable: '1073741863~1866（画布上摆的实例）一律返回 nil',
};

/**
 * `op=clientui` 的 hint —— **本关的数据**与**别处的实测**分成两句话说，绝不同框。
 *
 * 只负责「**本关读到的** + **实测佐证（带来源）**」这两段；前面那几句通用说明由调用方拼接
 * （那几句与数据无关，抄到这里会在回执里整段重复 —— 真机复核时当场抓到过）。
 *
 * 判据很简单：`likelyTemplates` 是从**这张图的 .gil** 里读出来的（真数据，只报本关的）；
 * `CLIENTUI_EVIDENCE` 是**另一张图**上跑出来的结论，永远带上它的关卡 ID。
 * 只有当前关卡**就是**那次实测的那张图时，才允许说「本关」。
 *
 * @param {{levelId?: any, likelyTemplates?: any[]}} [input] `levelId` = 本关关卡 ID；
 *        `likelyTemplates` = 本关读到的独立控件（`{id, name}`）
 * @returns {string}
 */
export function clientUiHint({ levelId = null, likelyTemplates = [] } = {}) {
  const tmpl = Array.isArray(likelyTemplates) ? likelyTemplates : [];
  const ev = CLIENTUI_EVIDENCE;
  const isEvidenceLevel = levelId != null && String(levelId) === String(ev.levelId);
  const parts = [
    // ① **本关自己的数据**：只报从这张图的 .gil 里读出来的号
    tmpl.length
      ? '**本关读到的**独立控件（' + (levelId != null ? '关卡 ' + levelId + '，' : '') + tmpl.length + ' 条）：'
        + tmpl.map((t) => t.id + '(' + t.name + ')').join(' / ') + '。'
      : '**本关没有读到**任何「无父节点 + 名字是控件类型」的记录 —— 这张图多半还没把控件「存为模板」。',
    // ② **别处的实测**：来源写在最前面，不是本关的就明说不是
    '真机实测佐证（来源：' + (isEvidenceLevel ? '**本关**' : '**关卡 ' + ev.levelId + '**')
      + ' ' + ev.where + '）：' + ev.creatable.map((c) => c.id + '(' + c.name + ')').join(' / ') + ' 可创建，'
      + ev.notCreatable + '。',
  ];
  if (!isEvidenceLevel) {
    parts.push('⚠️ 上面那几个号**来自关卡 ' + ev.levelId + ' 的实测，不是本关的** —— '
      + '本关要用哪个号，以「本关读到的」那一份为准；确证某个号能不能创建，用试玩探针「试钥匙」跑一次。');
  }
  return parts.join('');
}

/* ---------------------------------------------- op=rects：矩形提取与配对（N-1） */

/** 扫工程目录时要跳过的活文件（历史产物 / 备份 / 试玩探针源码 —— 收进来只会造出假配对）。 */
const RECT_SKIP_FILE = /(^_)|(_备份\.lua$)|(\.bak$)|(\.engine\.lua$)|(\.save\.json$)/i;
/** 一次扫多少个 `.lua`（超过就如实报 `truncated`，不静默截断）。 */
const RECT_MAX_FILES = 60;
/** 回执里最多列多少条矩形（`summaryOnly` 时更多信息被折叠）。 */
/*
 * ★ E8（2026-09-29 实战反馈）：`mountedOn` 是「存档里离这条挂载记录最近的那层 `#1` 字符串」——
 *   它可能是**占位名**（如 `未分类页签`）⇒ 既不能证实、也不能证伪「挂在客户端控件容器的容器节点上」；
 *   从没在编辑器里挂过时恒为 null。⇒ 把这层边界写进回执，别让人拿它当判据。
 */
const MOUNTED_ON_NOTE = '`mountedOn` = 存档里「离这条挂载记录最近的那层 #1 字符串」（挂载归属名）。'
  + '⚠️ 边界：① 可能是占位名（如 `未分类页签`）⇒ **既不能证实也不能证伪**「挂在客户端控件容器的容器节点上」；'
  + '② 从没在编辑器里挂过 ⇒ 恒为 null。真机硬要求是「挂客户容器的容器节点」，这条只能当**线索**，以编辑器里的挂载点为准。';
const RECT_MAX_LIST = 400;

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

/**
 * `miliastra_code op=lint-ui` 的实现（P0-1，**只报数字与位置、不下判决**）。
 *
 * 判据本体在 `lib/uilint.mjs`（纯函数，可单测）；这里只负责「读哪些文件」与「回执怎么省体积」。
 * 作用域与 `op=rects` 同一套：给了 `dir` 就扫那个工程目录，没给就扫**当前关卡的活文件目录**；
 * `files` 可以只查点名的那几个（活文件名或绝对路径都行）。
 *
 * @param {{dir:string, scope:'dir'|'level', args:any, level?:any}} input
 */
function runLintUiOp({ dir, scope, args, level = null }) {
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
function requireUnambiguousLevel(args, op) {
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
function runPreflightOp({ dir, scope, args, level = null }) {
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
 * `miliastra_code op=rects` 的实现（**只报数字不判决**）。
 *
 * @param {{dir:string, scope:'dir'|'level', args:any, level?:any}} input
 */
function runRectsOp({ dir, scope, args, level = null }) {
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
function assetOp(args = {}) {
  const op = String(args.op || 'list');
  const dir = assetsDir();
  if (op === 'add') return addAsset({ source: args.source, base64: args.base64, name: args.name, tags: args.tags, dir });
  if (op === 'list') {
    return listAssets({ dir, tag: args.tag, limit: args.limit, summaryOnly: args.summaryOnly === true });
  }
  if (op === 'get') return getAsset({ dir, id: args.id, out: args.out, overwrite: args.overwrite === true });
  if (op === 'remove') return removeAsset({ dir, id: args.id, confirm: args.confirm === true, deleteFile: args.deleteFile === true });
  if (op === 'rebuild') return rebuildIndex({ dir });
  if (op === 'prune') return pruneAssets({ dir, confirm: args.confirm === true });
  if (op === 'stats') return assetStats({ dir });
  /*
   * 后两个是「**平台目录**」通道（只管 id / 名字 / 分类这类目录事实，**不落图片/音频字节**）：
   * `catalog` = 平台图片资源库（1543 条 / 14 类）；`sound-*` = 平台音效库（1997 条 / 7 类）。
   * 它们与上面的 `add/list/get/…`（**插件自己的素材库**）是两件事，别混。
   */
  if (op === 'catalog') return queryImageCatalog(args);
  if (op === 'sound-search') return searchSounds(args);
  if (op === 'sound-get') return getSound(args);
  /* ★ 图标检索（2026-09-30）：按**语义**找图 —— 名字/关键词是模型识图推断的（官方目录没有单图名称）。 */
  if (op === 'icon-search') return searchIcons(args);
  throw new Error('没有这个 op：' + JSON.stringify(op)
    + '（支持 add / list / get / remove / rebuild / prune / stats / catalog / sound-search / sound-get / icon-search）');
}

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
function autoHandoverFromGil(args = {}) {
  let gil;
  try {
    const lv = resolveLevel(args.level);
    if (!lv || !lv.gil) return null;
    gil = readGil(lv.gil.path);
  } catch { return null; }                      // 没有存档 / 读不动 ⇒ 当成"拿不到"，交给上层去问人
  if (!gil || !gil.ok || !gil.clientUI) return null;
  const c = classifyControls(gil.clientUI);
  const byId = new Map(gil.clientUI.map((r) => [r.id, r]));
  const templates = c.likelyTemplates.filter((r) => r.name === '文本框');
  // 容器节点下**有名字**的子控件：名字是创作者起的（`文本框`/`图片` 这类**类型名**不算 —— 那是模板自己的名字）
  const named = gil.clientUI.filter((r) => r.parent != null && r.name && !CLIENT_CONTROL_NAME.test(r.name)
    && byId.get(r.parent) && byId.get(r.parent).name === '容器节点');
  const candidates = {
    levelId: (gil.level && gil.level.id) || null,
    textboxTemplates: templates.map((r) => ({ templateIndex: r.id, name: r.name })),
    /*
     * ★ 2026-09-28（`op=pixel-art`）：再加两栏 —— **图片**模板与**容器节点**。
     *   与 `textboxTemplates` 同一条纪律：`.gil` 的控件记录里**没有类型字段**，
     *   所以"名字叫 `图片` 的那个"只是**候选**（创作者按类型名起的），采用前仍然要求**唯一**。
     */
    imageTemplates: c.likelyTemplates.filter((r) => r.name === '图片').map((r) => ({ templateIndex: r.id, name: r.name })),
    containerNodes: c.likelyContainers.map((r) => ({ container: r.id, name: r.name })),
    namedChildrenOfContainer: named.map((r) => ({ name: r.name, id: r.id, parent: r.parent })),
    note: '这两个清单来自 `.gil` 的控件记录（只有 id / name / parent）；记录里**没有控件类型**，'
      + '所以「哪个是有名字的文本框」「哪个是图片模板」要创作者确认 —— 本工具不替你认。',
  };
  if (named.length === 1 && String(named[0].name).trim() !== '') {
    return { mode: 'control', controlName: String(named[0].name), templateIndex: null, from: 'gil', candidates };
  }
  if (!named.length && templates.length === 1) {
    return { mode: 'template', controlName: '', templateIndex: templates[0].id, from: 'gil', candidates };
  }
  return { mode: null, controlName: '', templateIndex: null, from: null, candidates };
}

export function genOp(args = {}) {
  const op = String(args.op || 'text-gradient');
  if (op === 'text-gradient') {
    const output = String(args.output || 'lua');
    if (output !== 'lua' && output !== 'data') {
      throw new Error('output 只能是 lua / data，收到：' + JSON.stringify(args.output));
    }
    if (output === 'data') return textGradient(args);
    // 交接值：显式参数优先；都没有才去 .gil 自动拿（唯一候选才采用）；拿不到就**报错点名**（绝不编）
    const givenName = args.controlName === undefined || args.controlName === null ? '' : String(args.controlName);
    const givenTmpl = Number(args.templateIndex);
    /** @type {{mode: 'control'|'template'|null, controlName: string, templateIndex: number|null, from: string|null, candidates: any}} */
    let auto = { mode: null, controlName: '', templateIndex: null, from: null, candidates: null };
    if (givenName !== '') {
      auto = { mode: 'control', controlName: givenName, templateIndex: null, from: 'arg', candidates: null };
    } else if (Number.isFinite(givenTmpl) && givenTmpl) {
      auto = { mode: 'template', controlName: '', templateIndex: givenTmpl, from: 'arg', candidates: null };
    } else {
      auto = autoHandoverFromGil(args) || auto;
    }
    const hits = [];
    if (auto.mode === null) {
      // P2-8 最后一档：台账里已确认过的文本框控件名 / 文本框模板索引
      const nameHit = ledgerHit(args, ROLE.textboxControlName);
      if (nameHit) {
        hits.push({ role: ROLE.textboxControlName, hit: nameHit.hit });
        auto = { mode: 'control', controlName: String(nameHit.hit.value), templateIndex: null, from: 'ledger', candidates: auto.candidates };
      } else {
        const tmplHit = ledgerHit(args, ROLE.textboxTemplate);
        if (tmplHit) {
          hits.push({ role: ROLE.textboxTemplate, hit: tmplHit.hit });
          auto = { mode: 'template', controlName: '', templateIndex: Number(tmplHit.hit.value) || null, from: 'ledger', candidates: auto.candidates };
        }
      }
    }
    return withLedgerNote(textGradientLua(args, auto), hits);
  }
  if (op === 'pixel-art') return pixelArtOp(args);
  if (op === 'vfx-lua') {
    /*
     * ★★ 渐进式披露（作者 2026-09-30 明令）：`preset` **不做 enum**（12 个 id 进 schema 会吃几百字符），
     *   改成 `preset:"list"` **按需枚举** —— 第 1 层只放"怎么找到预设"，第 2 层是这条 op 的回执，
     *   第 3 层（完整属性表 / 换算 / 模拟器边界）全在文档里（回执恒带 `doc` 指针）。
     */
    if (String(args.preset || '').trim() === 'list') return vfxLua(args, {});
    // 交接值：显式参数优先；都没有才去 `.gil` 自动拿（**只有唯一候选才采用**）→ 还缺就 needsHandover[]
    const givenTmpl = Number(args.templateIndex);
    const givenBox = Number(args.container);
    const hasTmpl = Number.isFinite(givenTmpl) && givenTmpl !== 0;
    const hasBox = Number.isFinite(givenBox) && givenBox !== 0;
    if (hasTmpl && hasBox) return vfxLua(args, { templateIndex: givenTmpl, container: givenBox, from: 'arg', candidates: null });
    const auto = autoPixelArtFromGil(args);     // 同一条读取路径：图片模板 + 容器节点（唯一候选才采用）
    const hits = [];
    let tmpl = hasTmpl ? givenTmpl : (auto ? auto.templateIndex : null);
    let box = hasBox ? givenBox : (auto ? auto.container : null);
    let fromLedger = false;
    if (!Number.isFinite(tmpl) || !tmpl) {
      const h = ledgerHit(args, ROLE.imageTemplate);
      if (h) { tmpl = Number(h.hit.value) || null; hits.push({ role: ROLE.imageTemplate, hit: h.hit }); fromLedger = true; }
    }
    if (!Number.isFinite(box) || !box) {
      const h = ledgerHit(args, ROLE.container);
      if (h) { box = Number(h.hit.value) || null; hits.push({ role: ROLE.container, hit: h.hit }); fromLedger = true; }
    }
    const fromGil = !!(auto && ((!hasTmpl && auto.templateIndex) || (!hasBox && auto.container)));
    const out = vfxLua(args, {
      templateIndex: tmpl, container: box,
      from: handoverFromString({ arg: hasTmpl || hasBox, gil: fromGil, ledger: fromLedger }),
      candidates: auto ? auto.candidates : null,
    });
    return withLedgerNote(out, hits);
  }
  if (op === 'struct-json') return structJson(args);
  throw new Error('没有这个 op：' + JSON.stringify(op) + '（支持 text-gradient / struct-json / pixel-art / vfx-lua）');
}

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
function resolvePixelArtHandover(args = {}) {
  const givenTmpl = Number(args.templateIndex);
  const givenContainer = Number(args.container);
  const hasTmpl = Number.isFinite(givenTmpl) && givenTmpl !== 0;
  const hasContainer = Number.isFinite(givenContainer) && givenContainer !== 0;
  const hits = [];
  const auto = (hasTmpl && hasContainer) ? null : autoPixelArtFromGil(args);
  let tmpl = hasTmpl ? givenTmpl : (auto ? auto.templateIndex : null);
  let cont = hasContainer ? givenContainer : (auto ? auto.container : null);
  let fromLedger = false;
  if (!Number.isFinite(tmpl) || !tmpl) {
    const h = ledgerHit(args, ROLE.imageTemplate);
    if (h) { tmpl = Number(h.hit.value) || null; hits.push({ role: ROLE.imageTemplate, hit: h.hit }); fromLedger = true; }
  }
  if (!Number.isFinite(cont) || !cont) {
    const h = ledgerHit(args, ROLE.container);
    if (h) { cont = Number(h.hit.value) || null; hits.push({ role: ROLE.container, hit: h.hit }); fromLedger = true; }
  }
  const fromGil = auto ? ((!hasTmpl && auto.templateIndex) || (!hasContainer && auto.container)) : false;
  const fromArg = hasTmpl || hasContainer;
  return {
    templateIndex: Number.isFinite(tmpl) && tmpl ? Number(tmpl) : null,
    container: Number.isFinite(cont) && cont ? Number(cont) : null,
    from: handoverFromString({ arg: fromArg, gil: !!fromGil, ledger: fromLedger }),
    candidates: auto ? auto.candidates : null,
    ledgerHits: hits,
  };
}

/**
 * 从当前关卡的 `.gil` 里自动读 `pixel-art` 需要的两个交接值。
 * **只有唯一候选才采用**（多候选绝不替人选）；读不到就当"拿不到"。
 * @param {{level?: any}} args
 */
function autoPixelArtFromGil(args = {}) {
  const auto = autoHandoverFromGil(args);
  if (!auto || !auto.candidates) return null;
  const imgs = Array.isArray(auto.candidates.imageTemplates) ? auto.candidates.imageTemplates : [];
  const conts = Array.isArray(auto.candidates.containerNodes) ? auto.candidates.containerNodes : [];
  const templateIndex = imgs.length === 1 ? Number(imgs[0].templateIndex) : null;
  const container = conts.length === 1 ? Number(conts[0].container) : null;
  return { templateIndex, container, candidates: auto.candidates };
}

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
function ledgerHit(args, role) {
  let levelId = null;
  try {
    const lv = resolveLevel(args && args.level);
    levelId = lv && lv.levelId ? String(lv.levelId) : null;
  } catch { levelId = null; }
  if (!levelId) return null;
  const hit = lookupHandover({ levelId, role });
  return hit ? { hit } : null;
}

/**
 * 把「这次用了台账里的哪几项」贴到回执上（**有才贴**，没用到就一个字段都不加 —— 形状稳定）。
 * @param {any} receipt
 * @param {Array<{role: string, hit: any}>} hits
 */
function withLedgerNote(receipt, hits) {
  const note = ledgerNote(hits);
  if (!note) return receipt;
  if (receipt && typeof receipt === 'object') {
    receipt.handoverLedger = note;
    receipt.handoverLedgerNote = '这几项**不是本次调用传的**，是台账里已确认过的值（`miliastra_health op=handover` 可查/改）。';
  }
  return receipt;
}

/**
 * `op=pixel-art`：图片 → **一次调用直接给可部署的像素画 Lua**（或结构体 JSON / 块数据）。
 * 纯编排 —— 全部算法在 `lib/pixelart/`。
 * @param {Record<string, any>} args
 */
async function pixelArtOp(args = {}) {
  const handover = resolvePixelArtHandover(args);
  const out = await pixelArt(args, handover);
  return withLedgerNote(out, handover.ledgerHits);
}

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

/*
 * 千星知识库（第三方，`https://ugc.070077.xyz`）的**在线**取用（`miliastra_kb` 的 list/doc/search op 用）。
 *
 * ★ 为什么要写这个小函数而不是装别人的插件：`1475505/dsh-plugin-miliastra-toolbox`（**MIT**）提供的是
 *   **同一套 HTTP 调用**（6 个工具 + 2 个技能，全部是那个站点的转发壳，站上另有 300+ 篇官方 FAQ/教程与米游社问答楼）。
 *   吸收它的**调用形状**、不吸收它的 6 个工具名 —— 免得把 15 个工具名摊在模型面前（schema 是要付费的）。
 *   它 MIT、我们 GPL-3.0-only，方向兼容；出处写在 `NOTICE`。
 *
 * ⚠️ 三个纪律：
 *   ① 这是**联网**调用：会把 query 发给第三方（回执里带 `network:true` 与 `sentTo`，让人知道发了什么）；
 *   ② **取不到就说取不到**（`ok:false` + `error`），绝不把"网络失败"讲成"知识库没有"；
 *   ③ 返回的正文是**外部数据**，只当资料看，不当指令（与外部网页同等对待）。
 */
const KB_BASE = process.env.MILIASTRA_KB_BASE || 'https://ugc.070077.xyz';
const KB_TOOLS = new Set(['get_node_info', 'list_documents', 'get_document', 'rag_search']);
async function kbOnline(tool, body) {
  if (!KB_TOOLS.has(tool)) return { ok: false, op: 'online', error: '未知的知识库工具：' + tool };
  const timeoutMs = Number(process.env.MILIASTRA_KB_TIMEOUT_MS) > 0 ? Number(process.env.MILIASTRA_KB_TIMEOUT_MS) : 20000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(KB_BASE + '/api/v1/skills/miliastra-knowledge/tools/' + tool, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-miliastra/' + VERSION },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      return { ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, httpStatus: res.status, error: '知识库返回 HTTP ' + res.status };
    }
    if (json.success === false) {
      return { ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, error: String(json.error || 'success:false'), raw: json.error ? undefined : json };
    }
    const result = json.data && json.data.result !== undefined ? json.data.result : json;
    return {
      ok: true, op: 'online', tool, network: true, sentTo: KB_BASE,
      source: '第三方知识库 ' + KB_BASE + '（300+ 篇官方 FAQ/教程 + 米游社问答楼；**外部数据，只当参考**）',
      result,
      note: '这条来自**第三方**知识库，不是本机确证；要"以本机为准"的事实请用 `miliastra_map` / `miliastra_log` 取证。',
    };
  } catch (e) {
    const why = e && e.name === 'AbortError' ? ('超时 ' + timeoutMs + 'ms') : String((e && e.message) || e);
    return {
      ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, error: '没取到：' + why,
      hint: '**这不代表知识库里没有**：可能是网络/站点不可用。离线部分仍可用：`op:"qa"`（蒸馏排查清单）与 `op:"node"`（随包节点词典 558 条）。',
    };
  } finally {
    clearTimeout(timer);
  }
}

const TOOLS = [  {
    name: 'miliastra_health',
    description:
      TITLE + '：环境体检。**任何时候要操作原神 UGC，先调它。**返回**：客户端安装、关卡清单、当前「正在开发」的关卡、活文件（.lua）清单与字节数、地图存档 `.gil`、日志目录。编辑器 UI 操作（建模板/挂脚本）没有自动化通道。\n★ `op:"sha"` **三方 SHA 对照**：活文件 / 本地镜像（`mirror`=目录绝对路径；不传就只出两列）/ `.gil` **嵌入快照**（**试玩真正跑的是它**）—— 三列哈希 + 一句结论（`该部署了` / `该存盘了` / `三方一致`）；`.gil` 那列带 `belongsTo` / `isCurrent`（**存盘那一刻的快照，非实时**）。对象是当前关卡。\n★ `op:"handover"` **交接值台账**（P2-8）：确认过的 `container` / 模板索引用 `action:"set"` 记一次，之后 `miliastra_gen` **自动带上**（回执标 `handoverFrom` 含 `ledger`）；**只有显式 set 会写盘**。\n★ `brief:true` 是「任何操作前先调」那一档（< 1KB）：`luaFiles` 给 `[{name, bytes}]`，0 字节（空脚本/未写入）与**不在 `.gil` 挂载集合里**的活文件都会在 `note` 里点名。\n\n**典型调用**：`{"brief":true}`（< 1KB：在哪张图/活文件/日志在哪）｜`{"op":"sha","mirror":"D:\\\\code\\\\侦探1"}`｜`{"op":"handover","action":"set","handover":{"container":1073741846,"imageTemplate":1073741849}}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['scan', 'sha', 'handover'], description: '默认 scan。op=sha = 三方 SHA 对照（配 `all:true` = **全部活文件一张表**）；op=handover = 交接值台账（配 action / handover）。' },
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'op=handover：默认 get 看；set 显式确认（之后 miliastra_gen 自动带上）；clear 抹掉（要 confirm）。' },
        handover: {
          type: 'object',
          description: 'op=handover action=set：要记下的值，键 = `container` / `imageTemplate` / `textboxTemplate` / `textboxControlName` / `confirmedBy`（谁确认的，默认 creator）。'
            + '例：`{"container":1073741846,"imageTemplate":1073741849}`。',
        },
        confirm: { type: 'boolean', description: 'op=handover action=clear：必须 true（台账是磁盘上的文件）。' },
        mirror: {
          type: 'string',
          description: 'op=sha：本地镜像**目录的绝对路径**（如 `code/` 那一份）—— 按活文件同名匹配（忽略大小写与 `.lua`）。'
            + '不传就只比「活文件 vs .gil」两列（插件**不假设**你的工作区布局）。',
        },
        all: { type: 'boolean', description: 'true=返回全部关卡清单（默认只返回最近 12 个）。' },
        brief: {
          type: 'boolean',
          description: '**只回「我在哪张图 / 活文件是哪个 / 日志在哪」（< 1KB）** —— 默认回执约 9.7KB、all:true 约 25KB。'
            + '`luaFiles` 是 `[{name, bytes}]`：**0 字节**（空脚本/未写入）与**不在 `.gil` 挂载集合里**的活文件都在 `note` 里点名。'
            + '⚠️ **与 all / summaryOnly 同时给时 brief 优先**。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const levels = scanLevels();
      const cur = pickCurrent(levels);
      // ★ op=sha：三方 SHA 对照（N-2）—— 用**当前关卡**，与其余 op 同一口径
      if (String(args.op || 'scan') === 'sha') {
        return healthSha({ mirror: args.mirror, allFiles: args.all === true });
      }
      // ★ P2-8 op=handover：已确认交接值台账（**唯一写入口** —— 只有显式 set 才落盘）
      if (String(args.op || 'scan') === 'handover') return healthHandover(args, cur);
      /*
       * ★ brief 档：只回「在哪张图 / 活文件是哪个 / 日志在哪」+ 进程状态。
       *   实测的痛点是体积（默认 9708 B / all:true 24966 B），不是信息不够 ——
       *   所以这一档只保留**每次都要看**的那几项，其余（每个关卡的 .gil、最近日志、ErrorLog）一律不带。
       */
      if (args.brief === true) {
        const curDecision = currentLevelDecision(levels);
        /*
         * ★ 2026-10-02（作者要 (a)）：**"编辑器现在开着哪张图"没有直接通道**（五条候选全排除，见 `editorHint()` 的注释）。
         *   这一档**只放两个号**（`gil` = 最近存盘 / `live` = 活文件最近改动）—— 它是"先调它"的入口，**必须继续 < 1KB**，
         *   所以详细版（时间 / 字节 / 为什么是间接证据 / 该问人什么）只在**完整档**给。
         */
        const eh = editorHint(levels);
        const proc = clientProcesses();
        /*
         * ★ P1-4（2026-09-26）：`luaFiles` 从**字符串数组**改成 `[{name, bytes}]`，并标出两种"看着像有、其实没用"的活文件：
         *   ① `bytes === 0` —— 刚在编辑器里建了映射、脚本还没写进去（本工作区文档记着这个坑：「别把空文件当成果」）；
         *   ② **不在 `.gil` 挂载集合里** —— 文件在磁盘上、但编辑器里没挂上（或挂了另一份）。
         *   ⚠️ 挂载集合**读不到**（老存档没有界面控件组层级）就**一个都不标**、只回 `mountKnown:false` —— 不猜。
         *   ⚠️ 这一档必须**继续 < 1KB**（它是"任何操作前先调"的入口）：所以标记只在**出问题时**才加、note 拼成一行。
         */
        const gi = cur ? gilScriptInfo(cur) : null;
        const live = cur ? cur.luaFiles.filter((f) => !f.auxiliary) : [];
        const mountKnown = !!(gi && gi.mountKnown === true);
        const mountedSet = new Set(mountKnown ? gi.mountedNames.map((n) => normalizeLiveName(n)) : []);
        const luaFiles = live.map((f, i) => ({
          name: f.name,
          /* ★ 2026-10-02 压体积：活文件多（本机实测 11 个）时 `bytes` 逐条累计约 180 B —— 只在 ≤8 个时给，
           *   多于 8 个时**只给名字**（要字节数用完整档）。理由：brief 的用途是"我在哪、有哪几个脚本"。 */
          ...(live.length <= 8 ? { bytes: f.size } : {}),
          ...(f.size === 0 ? { empty: true } : {}),
          ...(mountKnown && !mountedSet.has(normalizeLiveName(f.name)) ? { mounted: false } : {}),
        }));
        const emptyNames = luaFiles.filter((f) => f.empty).map((f) => f.name);
        const unmountedNames = luaFiles.filter((f) => f.mounted === false).map((f) => f.name);
        // 名单本身也要**有界**（活文件可能十几个，note 不许把 1KB 顶穿）
        const listNames = (a) => a.slice(0, 3).join('、') + (a.length > 3 ? ' 等 ' + a.length + ' 个' : '');
        const notes = [];
        if (emptyNames.length) notes.push('空脚本: ' + listNames(emptyNames));
        if (unmountedNames.length) notes.push('不在挂载集合里: ' + listNames(unmountedNames));
        return {
          ok: true, brief: true,
          /* ★ `version` 必须给（2026-09-30）：面板顶栏要显示版本号，而旧版 **brief 档没这个字段**
           *   ⇒ 面板只能绕道 `miliastra_echo` 去取（多一次调用，还得解释为什么）。工具该给的字段就给。 */
          version: VERSION,
          current: cur ? { brand: cur.brand, accountId: cur.accountId, levelId: cur.levelId } : null,
          /* ★ E7：「当前关卡」是猜的 —— 判据 / 证据 / 备选 / 歧义警告都摆出来（写盘前请显式传 `level`）
           *   ★ 2026-10-02 压体积：`currentEvidence`（实测 285 B，含一串绝对路径）与 `currentAlternatives`
           *   （实测 294 B，三个含 ISO 时间戳的对象）**在 brief 档合成一行 `currentWhy`**（≈90 B）——
           *   路径本来就有 `luaDir` / `gil` / `logDir` 三个字段在，备选也只留 id + 时间 + 活文件数。
           *   完整版（含全部路径与 3 个备选对象）在**非 brief 档**照旧给。 */
          currentDecidedBy: curDecision.decidedBy,
          currentWhy: (curDecision.decidedBy || '')
            + ((curDecision.alternatives || []).length
              ? '；备选：' + curDecision.alternatives.slice(0, 2).map((a) => a.levelId + '（'
                + String(a.newestMs || '').slice(5, 16).replace('T', ' ') + ' · ' + a.luaFileCount + ' 活文件）').join(' ')
              : ''),
          currentWarning: curDecision.warning,
          /* ★ 两个"间接判据"（作者要 (a)）：`gil` = .gil 最近存盘、`live` = 活文件最近改动（**会被 deploy 污染**） */
          editorHint: { gil: eh.byGilSave ? String(eh.byGilSave.levelId) : null, live: eh.byLiveFile ? String(eh.byLiveFile.levelId) : null },
          luaFiles,
          note: notes.length ? notes.join('；') : null,
          mountKnown,
          luaDir: cur ? cur.luaDir : null,
          gil: cur && cur.gil ? pathMod.basename(cur.gil.path) : null,
          logDir: cur ? cur.logDir : null,
          proc: {
            editor: proc.summary ? proc.summary.editorRunning : null,
            game: proc.summary ? proc.summary.gameRunning : null,
          },
          hint: cur ? '全量就别传 brief' : '没扫到关卡',
        };
      }
      const brief = (l) => ({
        layout: l.layout || 'folder',
        brand: l.brand,
        accountId: l.accountId,
        levelId: l.levelId,
        gil: l.gil ? { size: l.gil.size, mtime: l.gil.mtime } : null,
        luaFiles: l.luaFiles.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime })),
        logDir: l.logDir,
        logCount: l.logCount,
        latestLog: l.latestLog,
        newest: new Date(l.newestMs).toISOString(),
      });
      return {
        ok: true,
        localLow: localLowRoot(),
        // 源码比 Host 快照新就说出来 —— 省掉「改了怎么没生效」那一轮排查（今晚为此花过 5 个调用）
        host: hostSummary(),
        levelCount: levels.length,
        current: cur ? brief(cur) : null,
        /* ★ (a) 完整档给**详细版**：两条间接判据 + 证据档 + "该问人什么"（brief 档只给两个号，见上） */
        editorHint: editorHint(levels),
        levels: (args.all ? levels : levels.slice(0, 12)).map(brief),
        // `ErrorLog.txt` 巡检：**循环调用 / 挂载失败这类错不进 `.gia`**，只写这个文件。
        // 「没有」也要如实显示 —— 省一次人工翻目录，也避免把「.gia 干净」当成「没事」。
        errorLog: cur ? scanErrorLog(cur.luaDir, cur.levelDir) : null,
        // 编辑器 / 游戏进程（best-effort，带缓存；拿不到就 available:false，不影响其它字段）
        processes: clientProcesses(),
        sim: simRuntimeInfo(),
        hint: cur
          ? (cur.luaFiles.length
            ? '活文件（' + cur.luaFiles.length + ' 个）=' + cur.luaFiles.map((f) => f.path).join('  |  ')
            : '（该关卡尚无 .lua —— 需要在编辑器里给容器节点挂一个客户端脚本）')
          : '没扫到关卡',
      };
    },
  },

  {
    name: 'miliastra_code',
    description:
      TITLE + '：活文件（沙箱里的 .lua）的读 / 部署 / 体检 / 还原。**部署一律：先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM**（带 BOM 原神会报 Lua 错）。\nop=read 读沙箱活文件正文（**给了 `source` 绝对路径就读那个文件**，只读不写）；op=deploy 投进去（**覆盖前自动备份** + Lua 结构校验，默认 `lintMode:"strict"` 直接拒绝）；op=inspect 只体检；op=backup / op=backups / op=restore（**backup 可不传** = 固定名 `<原名>.bak`）；op=fixbom。\n⚠️ 部署**不会热加载**正在进行的试玩：要 **停试玩 → 部署 → 重开试玩**。\n★ **安全约定**：活文件是**唯一副本** ⇒ 备份失败就中止、原子写、写完校验 SHA（不过**自动回滚**）、备份两份**永不自动删**、跳过备份要 `allowNoBackup:true`。\n★ **`op=deploy` 选目标只用名字、不按「最近改动」猜**：`file` > `source` 同名活文件 > 目录里只有 1 个 > 拒绝并列候选；回执恒带 `dest`。\n★ **部署指纹**：成功后记 `.miliastra-deploy.<脚本名>.json`；`op=inspect` 对不上就直说「多半是编辑器把内存版存回了磁盘」。\n★ **`op=lint-ui`（平台级 UI 门禁，只报数字与位置）**：画在哪=点哪算 · 坐标/尺寸 8 的倍数 · 字号只许 64/52/28/22 · **h ≥ 字号×1.4 且 h ≥ 字号+16**（真机铁律：高度不够 ⇒ 该控件**一个像素都不画**）；`passed` 不代表 UI 合格。\n★ 另见 `docs/功能详解.md`（各 op 的配对口径 / 已知坑 / 下沉说明）。\n\n\n\n**典型调用**：`{"op":"inspect"}`（体检 + 看有没有被编辑器写回旧版）｜`{"op":"read","source":"C:/me/背景图片.lua","head":60}`（只读看任意本地 .lua）｜`{"op":"deploy","source":"D:\\\\code\\\\双相\\\\双相_v9.lua","file":"双相.lua"}`（**多脚本工程必须带 `file`**）｜`{"op":"lint-ui","dir":"D:\\\\code\\\\侦探1","summaryOnly":true}`（其余请求体见 `docs/功能详解.md`）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'deploy', 'inspect', 'backups', 'backup', 'restore', 'fixbom', 'levels', 'rects', 'lint-ui', 'preflight'], description: '默认 inspect。`dir` 给 op=rects / op=lint-ui / op=preflight。' },
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
      if (!lv.luaDir) throw new Error(`关卡 ${lv.levelId} 没有 external_lua_file 目录——说明还没在编辑器里挂客户端脚本。`);
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
        if (!destPath) throw new Error('没找到可读的活文件 —— 先用 miliastra_health 看这台机器上有哪些关卡与 .lua。');
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
        if (!destPath) throw new Error('没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。');
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
        if (!destPath) throw new Error('没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。');
        const r = backupFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, dest: destPath, ...picked, ...r,
          restoreWith: restoreCommand(null, destPath),
          note: r.ok ? '已写两份：固定名 `' + pathBasenameOf(r.fixed || '') + '`（还原默认用它）+ 一份带本地时间戳的历史。' : null,
        };
      }
      if (op === 'restore') {
        if (!destPath) throw new Error('没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。');
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
         *   实现=**复用本工具自己的 execute**（`TOOLS.find` 拿回引用，不依赖函数名）⇒ 单文件那套安全约定原封不动。
         */
        if (Array.isArray(args.files) && args.files.length) {
          const self = TOOLS.find((t) => t && t.name === 'miliastra_code');
          const results = [];
          const written = [];
          try {
            for (const item of args.files) {
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
              ok: false, op: 'deploy', mode: 'multi',
              failedAt: results.length + 1,
              attempted: args.files.map((x) => x && x.file),
              error: String((e && e.message) || e),
              results, rolledBack, failedRollback,
              note: '多文件 deploy：**任一失败 ⇒ 已写成功的用各自 backup 回滚**。`rolledBack` = 已还原；`failedRollback` 有条目 = **没还原成功**（要手动处理）。',
            };
          }
        }
        if (!args.source) throw new Error('op=deploy 需要 source（要投进去的本地文件绝对路径）。');
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
          const gateBad = !!gateErr || !gate || gate.ok !== true || gate.passed === false
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
          restoreWith: r.fixedBackup
            ? restoreCommand(null, destPath)
            : (r.backup ? restoreCommand(r.backup, destPath) : null),
          nextStep: r.ok ? deployNextStep(ms, rec, destPath) : null,
        };
      }
      if (op === 'rects') {
        return runRectsOp({ dir: lv.luaDir, scope: 'level', args, level: lv });
      }
      if (op === 'lint-ui') {
        return runLintUiOp({ dir: lv.luaDir, scope: 'level', args, level: lv });
      }
      if (op === 'fixbom') {
        if (!destPath) throw new Error('没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。');
        const r = stripBomFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...picked, ...r,
          error: r.error || null,
          restoreWith: r.restoreWith || restoreCommand(null, destPath),
        };
      }
      if (op === 'levels') {
        if (!destPath) throw new Error('没找到活文件路径 —— 路径随账号/换图变化，先用 miliastra_health 定位（或直接给 source）。');
        const src = fsMod.readFileSync(destPath, 'utf8');
        const nameHint = args.nameHint ? String(args.nameHint) : 'LEVELS';
        const ex = extractLevelTable(src, { nameHint });
        if (!ex.ok) {
          // ★ 抽不到表时**列出候选**：把文件里像关卡表的声明 / 赋值（`local LEVELS` / `DATA.LEVELS` / …）
          //   摆出来。只回一句「没找到」等于让人回去翻 20KB 的代码找变量名。
          const nameCandidates = ex.nameCandidates || [];
          return {
            ok: false, op, file: destPath, ...picked,
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
      throw new Error('未知 op：' + op);
    },
  },

  {
    name: 'miliastra_map',
    description:
      TITLE + '：读地图存档 `<关卡ID>.gil`（protobuf，含脚本源码快照）。op=summary 关卡/版本/账号/脚本映射；op=clientui **客户端控件谱系**（控件模板索引 / 名字 / 父 / 子）——判断「哪些控件能被脚本动态创建」的唯一正解：**只有「无父节点」的独立控件（存为模板）才可能被 InstantiateClientUIControl 创建**，画布上摆的实例与模板控件的子节点一律 nil。op=script 比对地图里嵌的源码与本地活文件（`belongsTo`/`isCurrent`：**`.gil` 是存盘那一刻的快照**）；op=strings 提可读字符串。\n★ **op=nodedb**：查**官方节点词典**（558 节点：中英名 / 标识 / 服务端·客户端 / 分类 / 端口，来源 = 参考项目 Pack，MIT）。⚠️ 词典 id 与 `.gil` 里的**声明号不是一套**（不能互翻）。\n★ **op=nodes**：读**节点图**与**实体自定义变量**（回答「节点图/原件有没有正确挂载」）；默认粗略档（计数 + 一行 `brief`），要明细传 `graph`/`entity`。⚠️ 字段号有出处**但未逐个真机确证**，不确定的原样回数字并进 `unverified`。\n★ **op=anatomy**：节点图**能力画像** —— 各类型节点多少个（事件/执行/查询/运算/分支；词典没收录但 id 命中**本关声明**的归「复合/自定义节点」，都不中才算 Unknown）+ 每张图的**入口事件** + **引用了哪些实体·声明** + 关键词。\n★ **多脚本工程**：`op=script` 的 `mappings[]` 列全部映射；`embedded` = 按名字挑中本次那一份。\n\n**典型调用**：`{"op":"summary"}`｜`{"op":"clientui","summaryOnly":true}`｜`{"op":"nodes","graph":"关卡实体信号"}`｜`{"op":"anatomy","summaryOnly":true}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['summary', 'clientui', 'audit-template', 'script', 'strings', 'nodes', 'anatomy', 'regions', 'nodedb'],
          description: '默认 summary。`nodes`=节点图/实体/元件/场景物件明细；`anatomy`=节点图能力画像；`regions`=顶层区地图。',
        },
        q: { type: 'string', description: 'op=nodedb：搜节点关键词（中/英/标识符；空格=AND）。不给 q 只回分类清单与计数。' },
        nodeId: { type: 'number', description: 'op=nodedb：按**官方节点 id** 取一条（与 .gil 里的声明号不是一套）。' },
        /* ★ 2026-10-07：**当初被 34 KB 棘轮拦下的那个参数** —— 实现早就在（`op=clientui` 读 `args.root`），
         *   但加它会顶穿棘轮 ⇒ 只能留在代码里 ⇒ **AI 看不到 = 调不出来**。硬线放宽到 50 KB 后补回来。 */
        root: { type: 'number', description: 'op=clientui：点名一个控件 id，回它的**整棵子树**（递归子控件，防环）。' },
        system: { type: 'string', enum: ['Server', 'Client'], description: 'op=nodedb：只看服务端 / 客户端节点。' },
        domain: { type: 'string', description: 'op=nodedb：按分类过滤（Execution / Control / Query / Arithmetic / Trigger …）。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡。' },
        file: { type: 'string', description: 'op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。' },
        kind: { type: 'string', enum: ['graphs', 'entities', 'components', 'decls', 'defs', 'all'], description: 'op=nodes 看哪一块：默认 graphs（节点图）；entities=实体（含量与种类号）；components=元件；decls=节点声明表（自定义节点）；defs=配置条目（职业/成长曲线/连段/状态）+ 阵营 + 资源分类树；all=全给。' },
        graph: { type: 'string', description: 'op=nodes：只看名字含这个子串的**节点图**（如 `关卡实体信号`）；**点名时额外回该图的逐节点明细**（`nodes`：索引/引用/引脚 kind/坐标/官方名字）；不给就只列图。' },
        entity: { type: 'string', description: 'op=nodes：要哪个**实体的自定义变量**（名字子串，如 `关卡实体`）——给了才回逐条 `variables[]`。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=clientui：省掉 `records` 与 `rendered`，只留计数与「可能能动态创建的模板」。op=nodes：省掉逐条 `graphs[]`/`entities[]`，只留计数 + `kinds` + 一行 `brief`。默认 false。',
        },
        path: { type: 'string', description: '直接指定 .gil 绝对路径（跳过自动定位）。' },
        limit: { type: 'number', description: 'op=strings：最多返回多少条（默认 200）。op=nodes：最多列几张图 / 几个实体（默认 40 / 20）。' },
        match: { type: 'string', description: 'op=strings：子串过滤。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'summary');
      // ★ op=nodedb 与地图无关（**不要求 .gil**）—— 词典是随包发的静态数据
      if (op === 'nodedb') {
        const meta = nodeDbMeta();
        if (args.nodeId != null) {
          const one = nodeById(Number(args.nodeId));
          return {
            ok: true, op, nodeId: Number(args.nodeId), found: !!one, node: one || undefined,
            meta: { source: meta.project, license: meta.license, copyright: meta.copyright, dbVersion: meta.dbVersion, gameVersion: meta.gameVersion },
            unverified: meta.unverified,
            nextStep: one ? undefined : '这个号在词典里没有 —— 确认是**官方节点 id**（<=300004），不是 .gil 里的声明号。',
          };
        }
        const r = searchNodes({ q: args.q || '', system: args.system, domain: args.domain, limit: args.limit });
        const facets = nodeDbFacets();
        const detail = args.summaryOnly !== true;
        return {
          ok: true, op, q: args.q || null, filter: { system: args.system || null, domain: args.domain || null },
          total: r.total, returned: r.returned,
          meta: { source: r.meta.project, license: r.meta.license, copyright: r.meta.copyright, dbVersion: r.meta.dbVersion, gameVersion: r.meta.gameVersion, counts: r.meta.counts },
          facets: { domains: facets.domains, server: facets.server, client: facets.client },
          nodes: detail ? r.rows : undefined,
          nodesOmitted: detail ? undefined : r.total,
          unverified: r.unverified,
          nextStep: '搜关键词传 `q:"玩家实体"`（中英/标识符都行）；按分类过滤传 `domain:"Query"`；看客户端节点传 `system:"Client"`；要端口明细别传 summaryOnly（默认就给逐条端口：方向/标签/类型/shellIndex）。',
        };
      }
      const gilPath = args.path || (() => {
        const lv = resolveLevel(args.level);
        if (!lv.gil) throw new Error(`关卡 ${lv.levelId} 下没有 .gil。`);
        return lv.gil.path;
      })();
      if (op === 'strings') {
        const fs = await import('node:fs');
        const rows = extractStrings(fsMod.readFileSync(gilPath));
        const filtered = args.match ? rows.filter((r) => r.text.includes(String(args.match))) : rows;
        const limit = Number.isFinite(args.limit) ? args.limit : 200;
        return { ok: true, op, path: gilPath, total: rows.length, returned: Math.min(limit, filtered.length), rows: filtered.slice(0, limit) };
      }
      if (op === 'anatomy') {
        /*
         * ★ 2026-10-02 新增（作者：「希望读取到有多少的各类型节点（事件 x 个 / 执行 x 个）」+
         *   「做个快速判断当前节点图用来做啥的能力：入口 / 关键词 / 引用」）。
         *   只读：一次 readGilNodeFacts + 纯函数（`lib/nodegraph.mjs`，吃随包节点词典 558 条）。
         *   ⚠️ 类型分布**只覆盖词典命中的节点**（本机恐怖-V3：1119 个节点里命中 548）—— 未命中的按 `Unknown`
         *   如实计数，`coverage` 里写清，别把它读成"这张图就这么点节点"。
         */
        const gq = args.graph ? String(args.graph) : '';
        const facts = readGilNodeFacts(gilPath, { graphLimit: 400, entityLimit: 1 });
        if (!facts.ok) return { ok: false, op, path: gilPath, error: facts.error };
        const graphNames = Object.keys(facts.graphNodeLists || {});
        const picked = gq ? graphNames.filter((n) => n.includes(gq)) : graphNames;
        if (gq && !picked.length) {
          return {
            ok: false, op, path: gilPath,
            error: '没有图名含「' + gq + '」的节点图',
            candidates: graphNames.slice(0, 40),
          };
        }
        const anatomies = picked.map((name) => {
          const g = (facts.graphs || []).find((x) => x.name === name) || { name };
          const nodes = (facts.graphNodeLists || {})[name] || [];
          const edges = nodes.reduce((s, nd) => s + ((nd.outEdges || []).length), 0);
          // 传本关声明表：词典命不中但 id 命中本关声明的节点会被归成「复合节点 / 自定义节点」（能确证的归属）
          return graphAnatomy(g, nodes, { edges: new Array(edges), declarations: facts.declarations || [] });
        });
        const totals = anatomyTotals(anatomies);
        let known = 0;
        for (const a of anatomies) known += a.typeStats.known;
        const out = {
          ok: true, op, path: gilPath, size: facts.size,
          filter: { graph: gq || null },
          graphCount: anatomies.length,
          totals,
          coverage: {
            nodes: totals.nodes, typedNodes: known, untypedNodes: totals.nodes - known,
            note: '类型来自**随包节点词典**（`lib/nodedb.json`，558 条）里 `identifier` 的第一段；'
              + '词典没收录的节点再看它的 id **是不是本关卡内的声明**（是 ⇒ 归「复合节点 / 自定义节点」，这是能确证的归属）；'
              + '两边都命不中的才计 `Unknown` —— **想提高覆盖要给词典补条目，别猜类型**。',
          },
          customNodes: {
            composite: totals.byType.Composite || 0, custom: totals.byType.Custom || 0,
            fromDeclarations: (totals.byType.Composite || 0) + (totals.byType.Custom || 0),
            declarationsInMap: (facts.declarations || []).length,
            note: '这些节点的类型不是官方分类（一个自定义/复合节点里可能包着任意逻辑），'
              + '只能确证到"它属于本关的哪条声明"；要展开看它内部，用 `op:"nodes"` 逐节点看。',
          },
          anatomyNote: graphOwnerNote(),
          graphs: args.summaryOnly === true ? undefined : anatomies.map((a) => ({
            name: a.graph.name,
            id: a.graph.id == null ? null : a.graph.id,
            type: a.graph.typeLabel || null,
            // ★ 挂载主（作者 2026-10-02 给的编辑器线索）：via=mount 是**已确证**形状，via=ref 是"记录里别处指向这张图"
            owners: (facts.graphOwners || {})[a.graph.id] || [],
            nodeCount: a.nodeCount,
            edgeCount: a.edgeCount,
            byType: a.typeStats.byTypeLabel,
            bySide: a.typeStats.bySide,
            sideUnknown: a.typeStats.unknown,
            triggers: a.triggers.map((t) => t.name),
            refs: { entities: a.refs.entities, others: a.refs.others },
            keywords: a.keywords,
            brief: a.brief,
          })),
          brief: '整关 ' + totals.nodes + ' 个节点（' + totals.graphs + ' 张图）：' + totals.byTypeLabelText
            + '　·　词典覆盖 ' + known + '/' + totals.nodes,
          /* ★ 2026-10-02（作者问「能不能读取结构体 还有信号」）：
           *   信号 = **能读**（`#10.#2` 引用表 − 固定引脚名 − 现场前缀 `侦_`，口径是启发式，见 `signalInventory` 的 unverified）；
           *   结构体 = **读不到定义**（同表里有「结构体」字样，但字段名+类型没找到）⇒ 如实说，不编。 */
          signals: (args.summaryOnly === true) ? undefined : signalInventory(facts),
          mountSummary: {
            graphsWithOwner: Object.keys(facts.graphOwners || {}).length,
            graphsTotal: (facts.graphs || []).length,
            entityRecords: (facts.mounts && facts.mounts.entities || []).length,
            componentRecords: (facts.mounts && facts.mounts.components || []).length,
            note: '挂载主从**实体/元件记录**里读（`#13` 形状 = 已确证；另有"别处指向"的记 `via:"ref"`）。'
              + '⚠️ 技能图 / 状态图挂在别的区 ⇒ 没找到时只能说"**这两个区里**没找到"。',
          },
          nextStep: '要整关一张表：`op:"anatomy"`；只看某张图：`+graph:"<图名子串>"`；'
            + '要看某张图的节点明细与引脚连线：`op:"nodes", graph:"<图名>"`；'
            + '**「谁身上挂着这张图」看每条图的 `owners[]`**（`via:"mount"` 已确证 / `via:"ref"` 口径未确证）。',
        };
        out.caveats = [
          '类型分布基于**随包节点词典**：`identifier` 第一段（`Trigger./Execution./Query./Arithmetic./Control./Others./Hidden.`）为准，'
          + '与词典 `domain` 字段互相印证（558 条里一致 555 条）；词典没收录的节点 ⇒ `Unknown`（不明说就不算数）。',
          '`refs` 的方向是「**这张图的节点引用到了谁**」，**不是**「谁身上挂着这张图」—— 后者 `.gil` 里读不出来（见 `anatomyNote`）。',
        ];
        return out;
      }
      if (op === 'regions') {
        /*
         * ★ 2026-10-02 新增（作者问「实体也是 这都是啥」）：把 `.gil` 的**顶层区地图**摊开 ——
         * 每个区多少字节 / 多少条目 / 样例名字 / **已知区名**（未确证的一律 label:null，不编名字）。
         * 这是"这张图里到底都有些什么"的自助入口，也是发现"某个区我没解"的最快方式。
         */
        const facts = readGilNodeFacts(gilPath, {});
        if (!facts.ok) return { ok: false, op, path: gilPath, error: facts.error };
        const slim = args.summaryOnly === true;
        return {
          ok: true, op, path: gilPath, size: facts.size,
          regionCount: facts.regionMap.length,
          regions: facts.regionMap.map((r) => (slim ? {
            field: r.field, label: r.label, bytes: r.bytes, itemCount: r.itemCount,
          } : r)),
          counts: {
            entities: facts.entityCount, components: facts.componentCount, graphs: facts.graphCount,
            declarations: facts.declarationCount, configs: facts.configCount,
            sceneObjects: facts.sceneObjectCount, placedInstances: facts.placedCount,
            factions: (facts.factions || []).length,
          },
          note: '**区名只写已确证的**（未确证的一律 null，不编）；`bytes` 对解不成消息的裸块按内容长度算。'
            + '⚠️ 「实体 12 个」只是 `#5` 逻辑实体表 —— **场景静态**与**摆放实例**在别的区（`#27` / `#8`），`counts` 里一起给了。',
          nextStep: '要看场景物件/摆放实例的明细用 `op:"nodes", kind:"all", summaryOnly:false`（回执里带 `sceneObjects` / `placedInstances`）。',
        };
      }
      if (op === 'nodes') {
        /*
         * ★ 2026-10-01 新增（作者：「有时候我不知道服务端的节点图或者原件到底有没有正确挂载」）。
         *   只读：一次 findProtobufRoot + 纯函数（`lib/gilnodes.mjs`），不写任何文件。
         *   `kind` 选看哪一块：graphs（默认）/ entities / components / all；默认**粗略档**（计数 + 一行 brief）。
         */
        const kind = String(args.kind || 'graphs');
        const wantDeclsEarly = kind === 'decls' || kind === 'all';
        const gq = args.graph ? String(args.graph) : '';
        const eq = args.entity ? String(args.entity) : '';
        const wantVars = !!eq || args.summaryOnly === false;
        const facts = readGilNodeFacts(gilPath, {
          graphLimit: Number.isFinite(args.limit) ? Number(args.limit) : 200,
          entityLimit: Number.isFinite(args.limit) ? Number(args.limit) : 400,
          withVariables: wantVars,
        });
        if (!facts.ok) return { ok: false, op, path: gilPath, error: facts.error };
        const graphs = gq ? facts.graphs.filter((g) => g.name.includes(gq)) : facts.graphs;
        const entities = eq ? facts.entities.filter((e) => e.name.includes(eq)) : facts.entities;
        const detailed = args.summaryOnly === false || !!gq || !!eq;
        const out = {
          ok: true, op, path: gilPath, size: facts.size,
          kind,
          graphCount: facts.graphCount,
          kinds: facts.kinds,
          entityCount: facts.entityCount,
          totalVariables: facts.totalVariables,
          entityKindCodes: facts.entityKindCodes,
          entityKindLabels: facts.entityKindLabels,
          componentCount: facts.componentCount,
          // ★ 场景静态 / 摆放实例（2026-10-02）：别让"实体 N 个"被读成"这张图只有 N 个东西"
          sceneObjectCount: facts.sceneObjectCount,
          placedCount: facts.placedCount,
          sceneObjects: (detailed && facts.sceneObjects) ? facts.sceneObjects.slice(0, Number.isFinite(args.limit) ? Number(args.limit) : 200) : undefined,
          placedInstances: (detailed && facts.placedInstances) ? facts.placedInstances : undefined,
          // ★ 截断如实报（作者 2026-10-02 抓到"元件只回 40 个"）：任何一块被截了都在这里说
          truncated: facts.truncated,
          configCount: facts.configCount,
          signalRefCount: facts.signalRefCount,
          configLinked: facts.configLinked,
          declarationCount: facts.declarationCount,
          compositeCount: facts.compositeCount,
          declarationStats: facts.declarationStats,
          // ★ 挂载关系（2026-10-02 补）：概略恒给；明细档才给逐条（免得粗略档回执爆掉）
          mountSummary: facts.mounts ? {
            graphsWithOwner: Object.keys(facts.graphOwners || {}).length,
            graphsTotal: facts.graphs.length,
            entityRecords: facts.mounts.entities.length,
            componentRecords: facts.mounts.components.length,
            note: '挂载主从**实体/元件记录**读（`#13` 形状已确证 ⇒ `via:"mount"`；"别处指向"记 `via:"ref"`，口径未确证）。'
              + '⚠️ 技能图/状态图挂在别的区 ⇒ 没找到只能说"**这两个区里**没找到"。',
          } : undefined,
          mounts: (detailed && facts.mounts) ? {
            entities: facts.mounts.entities, components: facts.mounts.components,
            graphOwners: facts.graphOwners,
          } : undefined,
          mountsOmitted: (detailed || !facts.mounts) ? undefined
            : (facts.mounts.entities.length + facts.mounts.components.length),
          filter: { kind, graph: gq || null, entity: eq || null },
          brief: facts.brief,
          caveats: [
            '`nodeCount` 取的是**图体自己声明**的那个数；`linkCount` 是数出来的**图体连线记录条数**（疑似连线，语义未逐个确证）—— 都当"粗略数字"看。',
            '实体**种类号**：有出处的按 `kindLabels` 给名字（来源写在 `kindLabelSource`：资源分类树 #6 的分类名「玩家模版」「职业」等 ref id 命中）；'
            + '**没出处的照旧只回原始号**（见 `kindLabelsUnverified`），名字带"模版"的另标 `roleGuess.guess:true`。',
          ],
          unverified: facts.unverified.length ? facts.unverified : undefined,
          nextStep: '看某张图传 `graph:"<图名子串>"`（如 `关卡实体信号`）；看某个实体的变量传 `entity:"<实体名子串>"`（如 `关卡实体`）；'
            + '要配置条目（职业/成长曲线/连段/状态）+ 阵营 + 资源树传 `kind:"defs"`；要节点声明表（自定义节点）传 `kind:"decls"`；'
            + '要元件/实体/图/声明一起看传 `kind:"all"`；**要"哪张图挂在哪个实体/元件上"看 `mountSummary` / 明细档的 `mounts.graphOwners`**；'
            + '只要计数就别传参数（默认粗略档）。',
        };
        // 按 kind 决定回哪一块（默认 graphs；`all` 全给；给了 graph/entity 过滤就按过滤给明细）
        const wantGraphs = kind === 'graphs' || kind === 'all' || !!gq;
        const wantEnts = kind === 'entities' || kind === 'all' || !!eq;
        const wantComps = kind === 'components' || kind === 'all';
        if (wantGraphs) {
          /*
           * ★ 2026-10-02 加：每条图**就地补上**「入口事件 / 会做哪些事 / 挂载在谁身上」——
           * 作者问「挂在 XX 上的图能做到什么」。数据全在**已经读进来的** `graphNodeLists` 与 `graphOwners` 里，
           * **不用再读一遍 `.gil`**（面板/回执都能直接渲染，不用二次调用）。
           */
          out.graphs = detailed ? graphs.map(function (g) {
            const nodes = (facts.graphNodeLists || {})[g.name] || [];
            const acts = actionsOf(nodes, { limit: 8 });
            return Object.assign({}, g, {
              owners: (facts.graphOwners || {})[g.id] || [],
              entryEvents: triggersOf(nodes).map((t) => t.name),
              actions: acts.names,
              actionTotal: acts.total,
              actionUnknown: acts.unknown,
              nodeKnown: nodes.length,
            });
          }) : undefined;
          if (!detailed) out.graphsOmitted = graphs.length;
          // ★ 点名某张图时，把它的**节点明细**一起回（作者：「我想要每一个节点都能被点到，而不是总和」）
          if (gq) {
            const pick = Object.keys(facts.graphNodeLists || {}).filter(function (k) { return k.includes(gq); });
            const nodeDetail = {};
            const edgeDetail = {};
            for (const k of pick) {
              nodeDetail[k] = facts.graphNodeLists[k];
              edgeDetail[k] = facts.graphNodeLists[k].flatMap(function (n) { return n.outEdges || []; });
            }
            out.nodes = nodeDetail;
            out.edges = edgeDetail;
            out.nodeTotal = pick.reduce(function (s, k) { return s + nodeDetail[k].length; }, 0);
            out.edgeTotal = pick.reduce(function (s, k) { return s + edgeDetail[k].length; }, 0);
            out.nodesNote = '每节点给：index / declaredIndex / shell·kernel 引用 / x·y 坐标 / pins（引脚实例）/ outEdges（出边）/ '
              + 'doc（拿 runtimeId 去官方节点词典查到的名字，查不到为 null）。'
              + '**连线**：edges[图名] = [{from, to, toShell, toKernel, fromPinKind}]，与 gia.proto 的 NodeConnection 一致'
              + '（2026-10-01 在 266 节点的图上钉出来：连接挂在引脚的字段 5，字段 1 = 目标节点索引）。'
              + '⚠️ 仍未确证的：引脚 kind 号到"输入/输出参数"的**名字**、节点字段 7（附加块）的语义、引脚值（valueRef）。';
          }
        }
        if (wantEnts) {
          out.entities = detailed ? entities : entities.map((e) => ({ name: e.name, id: e.id, kindCode: e.kindCode, kindEcho: e.kindEcho, componentCount: e.componentCount, variableCount: e.variableCount }));
          out.variablesOmitted = eq ? undefined : true;
        }
        if (wantComps) out.components = facts.components;
        if (wantDeclsEarly) out.declarations = facts.declarations;
        if (kind === 'defs' || kind === 'all') {
          out.configCount = facts.configCount;
          out.configs = facts.configs;
          out.configLinked = facts.configLinked;
          out.factions = facts.factions;
          out.spawns = facts.spawns;
          out.presets = facts.presets;
          out.resourceCategories = facts.resourceCategories;
          out.resourceTree = facts.resourceTree;
          out.semantics = facts.semantics;
          out.semanticMeaningful = facts.semanticMeaningful;
          out.signalRefCount = facts.signalRefCount;
          out.signalWords = facts.signalWords;
        }
        return out;
      }
      const gil = readGil(gilPath);
      if (!gil.ok) return { ok: false, op, path: gilPath, error: gil.error };
      if (op === 'summary') {
        const c = classifyControls(gil.clientUI);
        // 「真正的模板」= 独立、且不是容器节点（容器节点那几条是画布根节点）
        const templates = c.likelyTemplates.filter((r) => r.name !== '容器节点');
        return {
          ok: true, op, path: gilPath, size: gil.size,
          level: gil.level, account: gil.account, version: gil.version,
          // ↓ 2026-09-23 新增的三项「静态读」：不用试玩、不碰任何文件
          clientVersion: gil.versionInfo ? gil.versionInfo.client : null,
          resourceVersions: gil.versionInfo ? gil.versionInfo.resources : null,
          levelConfig: gil.levelConfig,
          sceneObjectCount: gil.sceneObjects ? gil.sceneObjects.count : null,
          sceneObjectSample: gil.sceneObjects ? gil.sceneObjects.sample : null,
          script: gil.script ? { name: gil.script.name, file: gil.script.file, mappingId: gil.script.mappingId, sourceBytes: gil.script.sourceBytes, sourceSha256: gil.script.sourceSha256 } : null,
          controlCount: gil.clientUI.length,
          templateCount: templates.length,
          templates,
          likelyTemplates: c.likelyTemplates,
          likelyContainers: c.likelyContainers,
          standaloneControls: c.standalone.map((r) => ({ id: r.id, name: r.name })),
          dynamicCreateLikelyBroken: templates.length === 0,
          warning: templates.length === 0
            ? '⚠️ 地图里没有发现「存为模板」的独立客户端控件（图片 / 文本框 / …）。'
              + '若脚本用 game.InstantiateClientUIControl 动态创建控件，现在会对任何索引号都返回 nil —— '
              + '请到「界面控件组管理 → 界面控件组库 → 客户端控件模板 →【添加客户端控件】→ 存为模板」，各存一条独立模板，然后保存地图。'
            : null,
        };
      }
      if (op === 'clientui') {
        const c = classifyControls(gil.clientUI);
        /*
         * ★★ 2026-10-02（作者：「**模板子树**这个估计要开发下 —— 现在只有**最顶层**的客户端模板能读取到，要**递归子树**」）：
         *   子控件 id 本来就在记录里（`#503` → `children`），这里**按它递归展开**。
         *   · `subtreeOf` 给某个 id 的整棵子树（作者点名的 5 个素材各有 A/B 两条同名记录，靠子树才分得清）；
         *   · 默认回执里给**每条 standalone 的子树节点数**（大子树只给计数 + `subtreeTruncated`，体积有界；
         *     `summaryOnly` 时连这个也不给）。
         */
        const subtreeOf = (id) => clientUiSubtree(gil.clientUI, id);
        const countOf = (id) => subtreeNodeCount(subtreeOf(id));
        const bound = 40;                      // 单棵子树节点数上限（超过只给计数，防回执爆掉）
        const withTree = (r) => {
          const n = countOf(r.id);
          return Object.assign({}, r, n <= bound
            ? { subtree: subtreeOf(r.id), subtreeNodes: n }
            : { subtreeNodes: n, subtreeTruncated: '子树 ' + n + ' 个节点（> ' + bound + '）⇒ 省略正文，要正文请点名 `root=' + r.id + '`' });
        };
        const base = {
          ok: true, op, path: gilPath,
          level: gil.level,
          count: gil.clientUI.length,
          likelyTemplates: c.likelyTemplates.map(withTree),
          likelyContainers: c.likelyContainers,
          structural: c.structural,
          hint: '能被 game.InstantiateClientUIControl 创建的，只有「在客户端控件模板库里【添加客户端控件】存为模板」的独立控件。'
            + '本工具把「无父节点 + 名字是客户端控件类型」的记为 likelyTemplates；'
            + '其中 容器节点 那几条通常是客户端控件容器的画布根节点（不是模板），真正的模板看 图片 / 文本框 这类。'
            // ⚠️ 这段文案由 clientUiHint() 生成：**本关的数据**与**别处的实测**分两句、带来源，
            //    不许再出现「本关 + 别的关卡的号」这种看起来是事实的误导（见 CLIENTUI_EVIDENCE）
            // ⚠️ `gil.level` 是 `{id, name}` 对象（不是数字）—— 传错会让 hint 里印出「关卡 [object Object]」
            + clientUiHint({ levelId: gil.level && gil.level.id, likelyTemplates: c.likelyTemplates }),
        };
        if (args.summaryOnly === true) {
          // 全量 `records` + `rendered` 是 37 条控件 × 多列，光扫一眼就要几千字符
          return {
            ...base,
            standaloneCount: c.standalone.length,
            /* ★ `root` 与 `summaryOnly` 同时给时必须仍回子树 —— "点名一个 id 只要子树"本来就是最省的用法。 */
            ...(args.root != null && args.root !== '' ? { subtree: subtreeOf(Number(args.root)) } : {}),
            note: 'summaryOnly：省掉了 `records`（每条控件一行）与 `rendered`（谱系文字），'
              + '只留计数与「可能能动态创建的模板」。要全量就去掉 summaryOnly。',
          };
        }
        /*
         * ★★ 2026-10-02（作者：「**贪婪模式**都通过插件能扫出来」）：
         *   `kind:"all"` = **贪婪扫** —— 把**每一条** standalone 记录的**完整子树**都摊开（不再受 40 节点上限），
         *   外加一份 `greedy` 汇总（总节点数 / 最深 / 名字直方图 / 谁是叶子）。
         *   ⚠️ **不新增 schema 参数**：复用已有的 `kind`（枚举里本来就有 `all`）与 `limit`（默认 200 棵树，`limit:0` = 不限）。
         *   ⚠️ 回执会很大（本机 `1073741842`：90 条 standalone、单棵最大 197 节点）⇒ 要计数就用 `summaryOnly`。
         */
        if (String(args.kind || '') === 'all') {
          const cap = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 200;
          const all = c.standalone.map((r) => {
            const tree = subtreeOf(r.id);
            const nodes = subtreeNodeCount(tree);
            const nameAcc = {};
            (function walk(n) { nameAcc[n.name || '?'] = (nameAcc[n.name || '?'] || 0) + 1; for (const k of n.children || []) walk(k); })(tree);
            return { rootId: r.id, name: r.name, role: (c.likelyTemplates.some((t) => t.id === r.id) ? 'likelyTemplate' : 'other'), nodes, depth: maxDepthOf(tree), names: nameAcc, tree };
          }).sort((a, b) => b.nodes - a.nodes);
          const shown = cap > 0 ? all.slice(0, cap) : all;
          return {
            ok: true, op, path: gilPath, level: gil.level,
            greedy: {
              controlCount: gil.clientUI.length,
              standaloneRoots: all.length,
              treesShown: shown.length,
              treesOmitted: all.length - shown.length,
              totalNodes: all.reduce((s, t) => s + t.nodes, 0),
              biggest: all.length ? { rootId: all[0].rootId, name: all[0].name, nodes: all[0].nodes, depth: all[0].depth } : null,
              note: '贪婪扫：每条 standalone 记录的**完整子树**都摊开（不再有 40 节点上限）。'
                + '⚠️ `nodes` 是**整棵子树**的节点数（含深层），不是"直接子控件数"（那看 `tree.childCount`）。',
            },
            trees: shown,
            hint: base.hint,
          };
        }
        return {
          ...base,
          /* ★ 每条 standalone 的**子树节点数**（不展开正文）—— 一眼看出"A 条带几个子控件、B 条带几个" */
          standalone: c.standalone.map((r) => ({ id: r.id, name: r.name, childCount: (r.children || []).length, subtreeNodes: countOf(r.id) })),
          records: gil.clientUI, rendered: renderClientUI(gil),
          /* ★ 点名某条 id 时给**整棵子树**（不限深；防环/限深在 clientUiSubtree 里）。
           *   ⚠️ 没点名时**不许留 `subtree: undefined`** —— lossless 契约会判它（smoke 抓到过）。 */
          ...(args.root != null && args.root !== '' ? { subtree: subtreeOf(Number(args.root)) } : {}),
        };
      }
      if (op === 'audit-template') {
        /*
         * ★★ 2026-10-04（《插件调用优化方向》第 6 条「内置模板审计」）：作者本轮为回答
         *   "模板组件是否都用 id/名字引用""`?` 是哪个节点""槽位在哪"，手写了 3 个一次性脚本解析 gil dump。
         *   这里把那些问法固化成一条 op（**全部来自 `.gil` 记录本身，不猜**）：
         *     · `tree`            = 子树（递归子控件；`nodeId` 给根，缺省取「名字含 `q`」或第一个独立控件）
         *     · `map`             = id → { name, parent, 深度 } 便于对照代码里的引用
         *     · `sameNameSameParent` = **同父重名**（`GetChild(名字)` 会歧义 ⇒ 必须用 id 或改名字）
         *     · `duplicateRoots`  = **同名多条独立控件**（就是 §7 那 5 组 A/B 记录的形态）
         *     · `idExists`        = 点名的 id 在不在记录表里
         *     · `nameRefs`        = 可选：`q` 给逗号分隔的名字清单，报「有 / 没有 / 有几条（歧义）」
         *   ⚠️ **图源**字段（"会不会渲染成 `?`"）目前**没逆出来** ⇒ 回执里明写 `imageSource: 'unverified'`，**不编**。
         */
        const recs = gil.clientUI || [];
        const byId = new Map(recs.map((r) => [r.id, r]));
        const depthOf = (id) => { let d = 0; let cur = byId.get(id); const seen = new Set(); while (cur && cur.parent != null) { if (seen.has(cur.id)) break; seen.add(cur.id); cur = byId.get(cur.parent); d += 1; if (d > 64) break; } return d; };
        const rootId = Number.isFinite(args.nodeId) ? Number(args.nodeId) : null;
        const q = args.q == null ? '' : String(args.q).trim();
        let root = rootId != null ? byId.get(rootId) : null;
        if (!root && q) root = recs.find((r) => r.parent == null && String(r.name || '').includes(q)) || null;
        if (!root && rootId == null && !q) root = recs.find((r) => r.parent == null) || null;
        // 同父重名（父可为 null = 独立控件那一层）
        const buckets = new Map();
        for (const r of recs) {
          const k = String(r.parent == null ? 'root' : r.parent) + '\u0000' + String(r.name || '');
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        }
        const sameNameSameParent = [...buckets.values()].filter((v) => v.length > 1)
          .map((v) => ({ parent: v[0].parent, name: v[0].name, count: v.length, ids: v.map((x) => x.id) }))
          .sort((a, b) => b.count - a.count);
        const nameHist = new Map();
        for (const r of recs) if (r.parent == null) nameHist.set(r.name, (nameHist.get(r.name) || 0) + 1);
        const duplicateRoots = [...nameHist.entries()].filter(([, n]) => n > 1)
          .map(([name, count]) => ({ name, count, ids: recs.filter((r) => r.parent == null && r.name === name).map((r) => r.id) }));
        const nameRefs = q && !root
          ? null
          : (q ? q.split(',').map((s) => s.trim()).filter(Boolean).map((nm) => {
            const hits = recs.filter((r) => String(r.name || '') === nm);
            return { name: nm, count: hits.length, ids: hits.map((r) => r.id), ambiguous: hits.length > 1 };
          }) : null);
        const tree = root ? clientUiSubtree(recs, root.id) : null;
        return {
          ok: true, op, path: gilPath, level: gil.level,
          controlCount: recs.length,
          rootId: root ? root.id : null,
          rootName: root ? root.name : null,
          tree,
          subtreeNodes: tree ? subtreeNodeCount(tree) : null,
          idExists: rootId != null ? byId.has(rootId) : null,
          parentOfRoot: root ? root.parent : null,
          depthOfRoot: root ? depthOf(root.id) : null,
          sameNameSameParent: args.summaryOnly === true ? sameNameSameParent.length : sameNameSameParent,
          sameNameSameParentCount: sameNameSameParent.length,
          duplicateRoots: args.summaryOnly === true ? duplicateRoots.length : duplicateRoots,
          duplicateRootsCount: duplicateRoots.length,
          nameRefs,
          /*
           * ★★ 图源（2026-10-04 逆出来了，**有对照证据**）：控件记录子树里落在**平台图片号段 100001~112042**
           *   的 varint = 该控件的图源号。证据：日志报 `图片图源=106045`，而 `.gil` 里 106045 **恰好出现 29 次**、
           *   且落在 29 条控件记录里 ⇒ **与运行时日志对得上**。名字含「图片」却没有号 ⇒ **会渲染成 `?`**。
           *   ⚠️ 字段号仍未钉死（只钉了"值域 + 在记录子树内"）⇒ 标 `heuristic`，但这对"有没有图"是可证伪的。
           */
          imageSource: 'heuristic-verified',
          imageSourceNote: '图源号 = 控件记录子树内落在**平台图片号段 100001~112042** 的 varint（`miliastra_asset op=catalog` 同号段）；'
            + '对照证据：日志报 `图片图源=106045`，`.gil` 里 106045 出现 29 次且落在 29 条控件里。'
            + '⚠️ 字段号未钉死 ⇒ 标 heuristic；但「**图片控件一个号都没有 ⇒ 会渲染成 `?`**」这条是可证伪的。',
          imageSourceMissingCount: (() => {
            const isImg = (n) => /图片|Image/i.test(String(n || ''));
            const walk = (node) => {
              let n = 0;
              if (isImg(node.name) && !(node.imageIds || []).length) n += 1;
              for (const c of node.children || []) n += walk(c);
              return n;
            };
            return tree ? walk(tree) : null;
          })(),
          imageSourceMissingSample: (() => {
            const isImg = (n) => /图片|Image/i.test(String(n || ''));
            const out = [];
            const walk = (node) => {
              if (out.length >= 20) return;
              if (isImg(node.name) && !(node.imageIds || []).length) out.push({ id: node.id, name: node.name });
              for (const c of node.children || []) walk(c);
            };
            if (tree) walk(tree);
            return out;
          })(),
          hint: '同父重名 ⇒ `GetChild(名字)` 有歧义（改用 id，或把名字改唯一）；同名多条独立控件 ⇒ '
            + '正是"另存为 / 复制一份"留下的形态（本轮 §7 的 5 组 A/B 记录就是这个）。',
          next: '看某个具体 id：`{"op":"audit-template","level":"<关卡>","nodeId":1073745047}`；'
            + '按名字找根：`{"op":"audit-template","q":"声望值"}`；比对代码引用：`q:"名字A,名字B"`（逗号分隔）。',
        };
      }
      if (op === 'script') {
        const cur = args.level || !args.path ? resolveLevel(args.level) : null;
        // 一个关卡可能有多个活文件 —— 比的是**指定/默认的那一个**，返回里带上「选了谁、凭什么」
        const pick = cur ? chooseLua(cur, args.file) : null;
        const live = pick ? pick.picked : null;
        let liveInfo = null;
        if (live) {
          const i = inspect(live.path);
          liveInfo = { name: live.name, path: live.path, size: i.size, sha256: i.sha256, mtime: i.mtime };
        }
        /*
         * ★ 多脚本工程（反馈 A1 / 实践文档 §2 第 2 条）：一张图的 `#50` 里有 **N 条**脚本映射，
         *   旧实现只回**第一条**（实测是旧占位「新建客户端脚本」），于是 `embedded` 与 6 个活文件
         *   "对不上"，`pickedNote` 只能让人去人工确认 —— 多脚本工程根本没法对账。
         *   现在：① `mappings` 给**全部**映射（含 mappingId / mountedOn）；② `embedded` 改成
         *   **按名字挑中本次那一份**；③ `candidates` 逐份列出「与哪条映射对上、哈希一致不一致」。
         */
        const all = Array.isArray(gil.scripts) ? gil.scripts : (gil.script ? [gil.script] : []);
        const mounts = gil.scriptMounts || { known: false, ids: [], byId: {}, note: null };
        const mappings = all.map((m) => ({
          mappingId: m.mappingId,
          name: m.name,
          file: m.file,
          bytes: m.sourceBytes,
          sha256: m.sourceSha256,
          mounted: Array.isArray(mounts.ids) && mounts.ids.indexOf(m.mappingId) >= 0,
          mountedOn: (mounts.byId && mounts.byId[m.mappingId]) || null,
          mountedOnNote: MOUNTED_ON_NOTE,
        }));
        const picked = liveInfo ? pickScriptMapping(all, liveInfo.name) : { mapping: null, matchedBy: null };
        // ② 同名才比哈希（名字对不上就是**另一个脚本**）；挑不到本次那一份时**退回第一条**并如实说明
        const embedded = picked.mapping || all[0] || null;
        const cmp = compareScriptSnapshot({
          embedded,
          live: liveInfo ? { name: liveInfo.name, path: liveInfo.path, sha256: liveInfo.sha256, size: liveInfo.size } : null,
        });
        const isMounted = (m) => !!m && Array.isArray(mounts.ids) && mounts.ids.indexOf(m.mappingId) >= 0;
        /*
         * ★ P0-2（2026-09-26）：`match` 比的是 **`.gil` 里那份存盘快照** ↔ 本地活文件 ——
         *   快照可能是**上一次存盘**时的内容。所以除了 `match`，还要回答「这份快照属于哪一次存盘、是不是当前那一份」
         *   （与 `miliastra_log` 的 `staleLog` / `logBelongsTo` 同一个口径）。
         *   ⚠️ 拿不到 `.gil` / 活文件的时间 ⇒ `isCurrent:null` + **明说没有证据**（不静默给旧数据）。
         */
        const gf = snapshotFreshness({
          kind: '存盘快照',
          name: pathMod.basename(gilPath),
          atMs: statMsSafe(gilPath),
          currentAtMs: liveInfo ? Date.parse(liveInfo.mtime) : null,
          currentLabel: liveInfo ? '活文件 ' + liveInfo.name : null,
          what: '这份 .gil 存盘快照',
        });
        // ⚠️ 回执里**绝不能带 `source`（源码全文）** —— 那是几十 KB，会让这个 op 一下超 10KB
        const embeddedSlim = embedded ? {
          mappingId: embedded.mappingId,
          name: embedded.name,
          file: embedded.file,
          bytes: embedded.sourceBytes,
          sha256: embedded.sourceSha256,
          mounted: isMounted(embedded),
          mountedOn: (mounts.byId && mounts.byId[embedded.mappingId]) || null,
          mountedOnNote: MOUNTED_ON_NOTE,
        } : null;
        const candidates = cur
          ? (pick && pick.candidates ? pick.candidates : []).map((c) => {
            const m = pickScriptMapping(all, c.name).mapping;
            return {
              name: c.name,
              bytes: c.bytes,
              mtime: c.mtime,
              mappingId: m ? m.mappingId : null,
              mappingName: m ? m.name : null,
              mappingBytes: m ? m.sourceBytes : null,
              mappingMounted: m ? isMounted(m) : null,
            };
          })
          : [];
        return {
          ok: true, op, path: gilPath,
          ...pickedFields(pick),
          scriptCount: mappings.length,
          mappings,
          mountKnown: mounts.known === true,
          mountNote: mounts.note || null,
          embedded: embeddedSlim,
          embeddedMappingId: embedded ? embedded.mappingId : null,
          embeddedPickedBy: picked.mapping ? ('name:' + picked.matchedBy) : (all.length ? 'fallback:first' : null),
          live: liveInfo,
          match: cmp.match,
          // ★ P0-2：这份存盘快照的归属与新鲜度（`.gil` 不是实时的，是**存盘那一刻**的快照）
          belongsTo: gf.belongsTo,
          belongsToAt: gf.belongsToAt,
          belongsToEpochSec: gf.belongsToEpochSec,
          isCurrent: gf.isCurrent,
          currentnessNote: gf.note,
          skipped: cmp.skipped || null,
          candidates,
          note: cmp.conclusion
            + (mappings.length > 1
              ? '　（这张图里共 **' + mappings.length + ' 条**脚本映射 —— 多脚本工程请用 `mappings[]` 逐条对账，'
                + '`embedded` 只是**本次这一份**对应（或退回第一条）的那一条。）'
              : ''),
        };
      }
      throw new Error('未知 op：' + op);
    },
  },

  {
    name: 'miliastra_log',
    description:
      TITLE + '：读客户端运行时日志 `.gia`（运行时取证的唯一入口）。`sessions` 列文件；`tail` 读结构化记录；`grep` 按 tag/pattern 过滤；`tags` 汇总**开头**的 `[...]` 前缀；**`runs` 按「局」切分**（每局一行摘要 + 与上一局 diff）；`metrics` 汇总指标分布。\n★ **`op=errors`：按「形态」捞报错，不看标签**（stack traceback / attempt to index / nil value / 缺少交接值 / 文件:行号 / error）—— 真机的报错行**可能完全没有 `[...]` 前缀**，按 tag grep **一条都捞不到**（实测漏掉过一条致命报错）；给 `errors[]{…, fileLine{file,line}, kind}` + `count` / `runsAffected`。\n★ **`staleLog:true` = 不是本局**（带 `logBelongsTo`）—— 别当本局证据；本局落没落盘看 `miliastra_playtest op=status` 的 `localGia`。\n⚠️ **「试玩了却没有新日志」有两种**：① 本局一条 `print` 都没有；② **`.gia` 落盘因时序失败** —— 此时「没有日志」**不能当唯一判据** ⇒ **判画面用 `miliastra_shot`**（细节见 `docs/功能详解.md`）。\n\n**典型调用**：`{"op":"errors"}`（**先跑这个**：不看标签捞报错行，含 `文件:行号`）｜`{"op":"runs"}`（局间 diff）｜`{"op":"metrics"}`（死亡位置分布）｜`{"op":"tail","tag":"miliastra-code","limit":30}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sessions', 'tail', 'grep', 'tags', 'runs', 'metrics', 'errors', 'run-analysis'], description: '默认 tail。' },
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
      const dir = lv.logDir;
      if (!dir) throw new Error(`关卡 ${lv.levelId} 没有关联的 Beyond_Debug_Log 目录。`);
      if (op === 'sessions') {
        const files = listGia(dir, Number.isFinite(args.limit) ? args.limit : 40);
        return { ok: true, op, dir, count: files.length, files };
      }
      const file = args.file
        ? (args.file.includes('\\') ? args.file : dir + '\\' + args.file)
        : (listGia(dir, 1)[0] || {}).path;
      if (!file) throw new Error('该目录下没有 .gia 日志文件——先在编辑器里试玩一局。');
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
      if (!gia.ok) return { ok: false, op, file, error: gia.error };
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
          ok: false, op, file,
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
          forms: ERROR_FORMS.map((f) => ({ kind: f.kind, what: ERROR_KIND_LABELS[f.kind] || null })),
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
        try { cmdRe = new RegExp(args.pattern || '命令|点击|按下|Invoke|Pressed', 'i'); } catch (e) { return { ok: false, op, error: 'pattern 不是合法正则：' + ((e && e.message) || e) }; }
        try { uiRe = new RegExp(args.tag || '渲染|显形|收起|SetVisible|界面层|覆盖层|更新', 'i'); } catch (e) { return { ok: false, op, error: 'tag 不是合法正则：' + ((e && e.message) || e) }; }
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
          ok: false, op, file,
          error: 'from 只能是 "end"（从尾部取，默认）或 "head"（从头取），收到：' + JSON.stringify(args.from),
        };
      }
      const fromHead = fromRaw === 'head';
      const lastN = Number.isFinite(args.last) ? Math.max(0, Math.round(args.last)) : null;
      const take = lastN == null ? limit : lastN;
      const { records, error } = filterRecords(pool, { tag: args.tag, pattern: args.pattern, limit: take, fromEnd: !fromHead });
      if (error) return { ok: false, op, file, error };
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
  },

  {
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
  },

  {
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
            ok: false, dryRun: false,
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
          ok: false, op, target: targetKey, process: processName, dir,
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
  },

  {
    name: 'miliastra_probe',
    description:
      TITLE + '：试玩探针 —— **部署后必须先告诉人「现在去编辑器点一次试玩」，试玩完再 op=collect**（试玩探针只在试玩那几秒跑）。**「问游戏一句」的工具**。试玩探针是一段临时替掉活文件的小程序，只在试玩那几秒跑一次，把**光读代码看不出来**的事（某个控件号能不能被创建、某个枚举到底叫什么名）打到日志里。**代价**：部署会**临时覆盖活文件**，所以试玩那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。**四步**：① op=deploy template=<名字> → ② 在编辑器里**重新**试玩一局（不会热加载）→ ③ op=collect 收回结论 → ④ 用 miliastra_code op=restore 还原你的脚本。' + `**${PROBE_TEMPLATE_CHOICES.length} 个模板**：`
      + PROBE_TEMPLATE_CHOICES.join(' / ') + '（用 `op=list` 看 `info[]`）。op=render 只生成 Lua 不部署；只读，不做场景写操作。★ **`template:"custom"`**：用 `lua` 传一段**完整 Lua** 当正文（**要定义 `run()`**），走同一条流水线（render → 人部署 → 试玩 → collect → 还原），部署前先备份 + 结构校验；**不给新能力**（只 print + 只读 API）。\n\n**典型调用**：`{"op":"deploy","template":"ping"}` → 人重新试玩 → `{"op":"collect","tag":"P1"}` → **还原**：`miliastra_code {"op":"restore"}`（不传 backup 就是用固定名那份）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'render', 'deploy', 'collect'], description: '默认 list。' },
        template: {
          type: 'string',
          enum: PROBE_TEMPLATE_CHOICES,
          description: '模板名（每个模板"能答什么问题"用 `op=list` 看 `info[]`）。⚠️ `custom` 必须再给 `lua`，其余模板都不用。',
        },
        lua: {
          type: 'string',
          description: '**只有 template:"custom" 用**：试玩探针正文，一段**完整 Lua**（建议定义 `function run()` —— 试玩起来后第 3 帧调它）。'
            + '正文里只做两件事：print + 只读 API（**不写地图 / 不写存档**）。缺 end / 括号不配平会被**拒绝渲染**。',
        },
        tag: { type: 'string', description: '日志标签（默认 PROBE）。collect 时用它过滤。' },
        perfSeconds: {
          type: 'number',
          description: 'perf：采样秒数（默认 8，2~120）。中途每 2 秒也打快照 —— 试玩被提前掐掉也拿得到部分数据。',
        },
        level: { type: 'string', description: '关卡；省略=当前关卡。' },
        file: { type: 'string', description: 'op=deploy：要替换哪个活文件（省略=自动选）。' },
        ids: { type: 'array', items: { type: 'number' }, description: 'instantiate：额外的候选控件模板索引。' },
        from: { type: 'number', description: 'instantiate：兜底扫描下界（默认 1073741824）。' },
        to: { type: 'number', description: 'instantiate：兜底扫描上界（默认 1073741900）。' },
        saveTo: { type: 'string', description: 'render/deploy：把生成的 Lua 另存到这个绝对路径。' },
        lintMode: {
          type: 'string',
          enum: ['strict', 'warn', 'off'],
          description: 'op=deploy：Lua 结构校验强度（默认 strict）。报错说明试玩探针模板本身有 bug。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'list');
      if (op === 'list') {
        return {
          ok: true, op, templates: PROBE_TEMPLATE_CHOICES,
          whatIsAProbe: PROBE_OVERVIEW.what,
          why: PROBE_OVERVIEW.why,
          cost: PROBE_OVERVIEW.cost,
          steps: PROBE_OVERVIEW.steps,
          // 每个模板的大白话说明 —— 面板直接拿这份渲染，避免两边各写一套文案
          info: PROBE_TEMPLATE_CHOICES.map((t) => Object.assign({ template: t }, PROBE_INFO[t] || {})),
          usage: 'miliastra_probe op=deploy template=instantiate tag=P1 → 在编辑器里重新试玩一局 → '
            + 'miliastra_probe op=collect tag=P1 → miliastra_code op=restore 还原你的脚本',
        };
      }
      if (op === 'collect') {
        const lv = resolveLevel(args.level);
        const file = (listGia(lv.logDir || '', 1)[0] || {}).path;
        if (!file) throw new Error('没有日志文件——先试玩一局。');
        const gia = readGia(file);
        const tag = String(args.tag || 'PROBE');
        const { records } = filterRecords(gia.records.filter((r) => r.message), { tag, limit: Number.isFinite(args.limit) ? args.limit : 400 });
        return {
          ok: true, op, tag, file, logFile: file,
          hit: records.length > 0,
          count: records.length,
          lines: records.map((r) => r.message),
        };
      }
      const r = renderProbe(args.template || 'tree', { tag: args.tag, ids: args.ids, from: args.from, to: args.to, lua: args.lua, perfSeconds: args.perfSeconds });
      if (!r.ok) return r;
      const fs = await import('node:fs');
      if (args.saveTo) {
        // 写盘一律走共享原子实现（同目录 tmp + fsync + rename），不留半截文件
        atomicWriteFile(args.saveTo, r.lua);
      }
      if (op === 'render') {
        return {
          ok: true, op, template: r.template, tag: r.tag, bytes: r.bytes, savedTo: args.saveTo || null,
          ...(r.custom ? { custom: true } : {}),
          ...(r.warnings ? { warnings: r.warnings } : {}),
          // ⚠️ render **不部署、不覆盖活文件**（没给 saveTo 就只在回执里）；要真跑必须走 op=deploy
          note: 'render 只出代码、**不碰任何文件**（给 saveTo 才落盘）。要真跑就 `op=deploy`：'
            + '它会**临时覆盖活文件**（先自动备份），在编辑器里重新试玩一局后 `op=collect` 收结论，'
            + '**收完记得还原**：`miliastra_code op=restore`（不传 backup 就是用固定名那份）。',
          lua: r.lua,
        };
      }
      if (op === 'deploy') {
        const lv = resolveLevel(args.level);
        if (!lv.luaDir) throw new Error(`关卡 ${lv.levelId} 没有 external_lua_file 目录——先在编辑器里挂一个客户端脚本。`);
        const chosen = chooseLua(lv, args.file);
        const dest = chosen && chosen.picked ? chosen.picked.path : lv.luaDir + '\\' + (lv.levelId + '_probe.lua');
        const now = new Date();
        const stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
          + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
        /*
         * ⚠️ 试玩探针源码**绝不能写进活文件目录**（`external_lua_file`）。
         *    踩过：以前写在那里（`_试玩探针_xxx.lua`），而「当前活文件」是按 mtime 最新的那个 → 试玩探针文件成了「当前文件」，
         *    之后任何不带 file 的操作（体检/备份/部署/还原）都会打到试玩探针上。
         *    现在写到**备份目录**里：紧挨着被替换的文件（作者要求「写到被替换的文件旁边」），
         *    又不会被当成活文件。`pickLuaFile` / `chooseLua` 另有名字护栏。
         */
        const probeDir = defaultBackupDir(dest, args.backupDir);
        const probeSrc = args.saveTo || (probeDir + '\\_试玩探针_' + r.template + '_' + r.tag + '_' + stamp + '.lua');
        if (!args.saveTo) {
          atomicWriteFile(probeSrc, r.lua);
        }
        const dep = deployFile(probeSrc, dest, { backupDir: args.backupDir, lintMode: args.lintMode });
        return {
          ok: dep.ok, op, template: r.template, tag: r.tag,
          label: (PROBE_INFO[r.template] || {}).label || null,
          probeSource: probeSrc, ...dep,
          collectWith: `miliastra_probe op=collect tag=${r.tag}`,
          restoreWith: dep.fixedBackup
            ? `miliastra_code op=restore backup=${dep.fixedBackup}`
            : (dep.backup ? `miliastra_code op=restore backup=${dep.backup}` : null),
          nextStep: dep.ok
            ? '⚠️ 现在活文件是试玩探针，**你的玩法这一局不会跑**。去编辑器里「停止试玩 → 重新试玩一局」（不会热加载），'
              + '起来约 5 秒后 op=collect 收结论；**收完记得还原你的脚本**'
              + (dep.fixedBackup ? '：op=restore 不传 backup 就是用固定名那份（' + dep.fixedBackup + '）' : '')
            : '部署失败，活文件未被改动。',
        };
      }
      throw new Error('未知 op：' + op);
    },
  },

  {
    name: 'miliastra_sim',
    description:
      '内置**千星模拟器**：游戏之外搭界面、跑 levelScript、出画面 PNG。**定位：真机试玩之前的「预测试」**；拦不下官方素材/真机渲染 ⇒ **模拟器通过 ≠ 真机通过**，真机仍要点试玩。\n★ 三档（①看 `state`/`shot` ②玩 `play` ③判 `verify`/`cases`/`frames`）共用一份工程；`op=bind` 搬真机工程（缺值报错，不许编）/ `op=handover` 抽交接值 / `op=cases` 验收单。\n★ 量级：发输入 **5ms** / 读场景 **200ms**；HUD 用 **`op=hud`** 读 `textbox.text` 的 `text`；`…Down` 配 `…Up`，否则**一直按住**；`frame` **不是秒表**，计时用 `time`。\n★ `op=keys` 两路扫键名（含**裸字符串** + `string-literal` 来源），回执带 **`press`**；`all:true` 全量 **164** 个。\n★ 渲染：**PNG 里有脚本建的客户端控件**（含子控件**都会画进图**；模板工程**自己那棵树**不在），仍离线渲染 ⇒ 终验看真机；**Z 序**：**按 sibling 顺序画**，`op=patch add` 的新控件在**最底层**（真机**后建的在上**），不覆盖跨父级叠序。\n★ 能验/不能验什么见 `docs/模拟器与视图.md`。\n\n**典型调用**：`{"op":"bind","source":"D:\\\\…\\\\a.lua","templates":[{"guid":1073741868,"kind":"image"}]}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['controls', 'hud', 'state', 'patch', 'handover', 'bind', 'play', 'verify', 'cases', 'frames', 'shot', 'keys', 'export', 'import', 'load', 'save', 'reset'], description: '默认 state。' },
        /*
         * ⚠️ 这个 `all` **同时服务两个 op** —— 写成两个键会**静默覆盖**（JS 对象字面量后者胜），
         * 于是其中一个说明永远不会到达 AI（2026-09-24 被 ESLint 的 `no-dupe-keys` 抓到，见 `tools/lint.mjs`）。
         */
        all: { type: 'boolean', description: 'op=keys：给**全量键名**；op=cases remove：删整个用例集（要 confirm）。' },
        steps: { type: 'array', description: 'op=verify 操作序列（形状见「下沉」§1）。', items: { type: 'object' } },
        expect: { type: 'array', description: 'op=verify 断言（八种 kind 见「下沉」§1）；`count` = **建了几个**；`kind=lua` 只看报不报错（**返回值被忽略** —— 要失败得自己 `assert(false,…)`）。', items: { type: 'object' } },
        cases: { type: 'array', description: 'op=verify 多用例：每项 {name, steps, expect}。', items: { type: 'object' } },
        fromHistory: { type: 'boolean', description: 'op=verify：用**刚跑过那一局**当用例。' },
        frames: { type: 'array', description: 'op=frames 的时间点（模拟秒，升序，≤12 个）。', items: { type: 'number' } },
        diff: { type: 'boolean', description: 'op=frames：是否比帧间像素差（默认 true）。' },
        threshold: { type: 'number', description: 'op=frames：像素算「变了」的每通道阈值（默认 8）。' },
        shotOnFail: { type: 'boolean', description: 'op=verify：没过时自动存失败帧 PNG 并回 `shot`（默认 true）。' },
        stopOnFail: { type: 'boolean', description: 'op=verify 配 cases：第一个没过就停（默认 false）。' },
        keepRunning: { type: 'boolean', description: 'op=verify：判定后不停会话（默认停），便于接着 op=play。' },
        timeoutMs: { type: 'number', description: 'op=verify / op=cases / op=play：单次 play 的墙钟预算（ms，默认 8000，范围 500~600000；也可用环境变量 QXQY_PLAY_TIMEOUT_MS）。⚠️ 长局（>20 秒）必须调大 —— 否则同一用例会间歇超时。' },
        dt: { type: 'number', description: 'op=verify：重放的每步时长（秒）。' },
        runtime: { type: 'boolean', description: 'op=controls：看**运行中**的控件树（脚本动态建的），需先 op=play start。' },
        geom: { type: 'boolean', description: 'op=controls + runtime:true：带世界坐标 `x/y`、尺寸 `w/h`、`text`。' },
        namedOnly: { type: 'boolean', description: 'op=controls：只列有名字的控件（只有它们能按 name 断言）。' },
        nameContains: { type: 'string', description: 'op=controls：按名字子串过滤（中文可用）。' },
        kind: { type: 'string', description: 'op=controls：按类型过滤（container / textbox / image …）。' },
        maxDepth: { type: 'number', description: 'op=controls：只列到第几层（0=根）。' },
        limit: { type: 'number', description: 'op=controls：最多回多少条（默认 200）。' },
        summaryOnly: { type: 'boolean', description: '只去体积不去结论（默认 true：state 不回 boxes 与 tree 全量）。' },
        treeLimit: { type: 'number', description: 'op=state 在 summaryOnly 下最多回多少条控件树（默认 200）。' },
        patch: { type: 'object', description: 'op=patch 编辑操作；数据写带 expectedRevision，**每个 op 只认自己的字段**（§4）。' },
        action: { type: 'string', description: 'op=play 的动作（start/get/step/pointer/key/click/pause/stop… 全表见文档）。' },
        args: { type: 'object', description: 'op=play 参数（`step` 可给 `args.frames:<N>` 真推 N 帧）；形状见文档 §7。' },
        target: { type: 'string', enum: ['ui', 'play'], description: 'op=shot 取景：ui=编辑器视图，play=试玩画面（先 start）。' },
        label: { type: 'string', description: 'op=shot 的文件名标签。' },
        reuse: { type: 'boolean', description: 'op=shot：固定名覆盖写、只留当前帧（不传 = 每张新建）。' },        format: { type: 'string', description: 'op=export / op=import 的格式（默认 gia）。' },
        assetType: { type: 'string', description: 'op=export 的资产类型过滤。' },
        file: { type: 'string', description: 'op=import 要导入的文件绝对路径。' },
        archive: { type: 'string', description: 'op=load 的存档；省略=列出工作区里的存档。' },
        path: { type: 'string', description: 'op=save 的存档文件名（默认 qxqy-simulator.save.json）。' },
        source: { type: 'string', description: 'op=bind / op=handover：一个 .lua 的**绝对路径**（op=handover **只读**，不写盘）。' },
        scripts: {
          type: 'array',
          items: { type: 'object' },
          description: 'op=bind：**一次挂多个脚本** `[{path, source|sourceFrom}]`（就不看顶层 `source`）。',
        },
        templates: { type: 'array', description: 'op=bind：模板清单 `[{guid,kind,name?}]`（`kind` 拿不准传 `"auto"`）。', items: { type: 'object' } },
        containerId: { type: 'number', description: 'op=bind：创作者交接的**容器节点索引**。' },
        scriptName: { type: 'string', description: 'op=bind：挂载名（见「下沉原文」§7）。' },
        mountTo: { type: 'string', description: 'op=bind：脚本挂在哪个控件（id 或名字；缺省=服务端容器节点）。' },
        fresh: { type: 'boolean', description: 'op=bind：默认 true = 清掉出厂工程与已有脚本重建。' },
        last: { type: 'boolean', description: 'op=bind：用**上次那份配方**重搭。' },
        keepFactory: { type: 'boolean', description: 'op=bind：保留出厂橱窗控件（默认清掉）。' },
        run: { type: 'boolean', description: 'op=bind：默认 true = 起一次会话，回 `run.logs` 与 `controlCount`。' },
        settleSec: { type: 'number', description: 'op=bind：起完会话先让时钟走几秒再读。' },
        runForMs: { type: 'number', description: 'op=bind：起完会话**真跑** N 毫秒再读（≤60000，超出夹紧）。' },
        withMeta: { type: 'boolean', description: 'op=bind：回**全文**（默认精简档）；等价 `summaryOnly:false`。' },
        saveAs: { type: 'string', description: 'op=bind：把工程存进工作区（缺省 bind-<脚本名>.save.json）。' },
        script: { type: 'object', description: 'op=bind：直接用源码代替读文件 `{path, source}`。' },
        caseSet: { type: 'string', description: 'op=verify：直接跑 `op=cases` 里存的那一组。' },
        set: { type: 'string', description: 'op=cases：用例集的名字（建议「玩法-关卡」）。' },
        case: { type: 'string', description: 'op=cases action=remove：要删的用例名（不给 = 删整组）。' },
        confirm: { type: 'boolean', description: 'op=cases action=remove：删除不可恢复，必须显式 confirm:true。' },
        manual: { type: 'boolean', description: '存用例时标**人工项**（配合 note）；不代跑不代判，只在 `manual[]` 等人打勾。' },
        note: { type: 'string', description: '用例/人工项的说明：人工项必填「人要看什么、看到什么算过」。' },
        name: { type: 'string', description: 'op=bind：存档名；op=cases：set 的别名（manual 项缺省取 note 前 20 字）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      /*
       * ★ 回执**必须带 `ok`**（2026-09-30 AI 侧易用性实测发现）：全仓只有 `miliastra_sim` 不带 ——
       *   它把引擎回执原样透出去（`{version, canvas, ...}` / `{bound, treeCount, ...}`）。
       *   实测后果两次：`op=bind` 明明成功，调用方按 `r.ok` 判定 ⇒ **误报失败**（面板显示"预览失败"、
       *   AI 侧同样会误判 —— `if (r.ok)` 是任何调用者的第一反应）。这里补 `ok:true`；
       *   **已有 `ok` 的不动**（尤其别把 `false` 盖成 `true`）。
       */
      let simR;
      try {
        simR = await simOp(args, {});
      } catch (e) {
        /*
         * ★ 守卫错误**回回执、不回异常**（2026-09-30 AI 侧易用性实测）：
         *   例 `op=hud` 没有在跑的会话时原本 `throw` —— 调用方（尤其 AI）必须自己 try/catch，
         *   否则**整轮被打断**；而全仓其它工具是回 `{ok:false,error}`。
         *   **消息一个字不改**，只把"形式"换成回执（AI 拿到的信息量不减、但不会再炸掉调用）。
         */
        return { ok: false, error: String((e && e.message) || e) };
      }
      /*
       * ★ E10（2026-09-29 实战反馈）：**模拟器不渲染富文本**（`<color=#…>` / `<size=…>` 在画面上是原始标签），
       *   真机正常（已实测）—— 工具以前不主动说 ⇒ "画面上有标签"会被误判成产物有问题。
       *   ⇒ 画面类 op（frames / shot）的回执带 `simLimitations[]`（**只陈述模拟器边界，不改任何判据**）。
       */
      if (simR && typeof simR === "object" && !Array.isArray(simR) && (args.op === "frames" || args.op === "shot")) {
        if (!Array.isArray(simR.simLimitations)) {
          simR.simLimitations = [{
            what: "模拟器不渲染富文本",
            symptom: "画面（PNG / HUD）里出现 <color=…> / <size=…> 原始标签",
            real: "真机正常（已实测）—— 这不是产物 bug",
            other: "官方素材渲染、联机、手感同样不在模拟器覆盖内；视觉终验看真机",
          }];
        }
      }

      return (simR && typeof simR === "object" && !Array.isArray(simR) && simR.ok === undefined) ? { ok: true, ...simR } : simR;
    },
  },

  {
    name: 'miliastra_asset',
    description:
      TITLE + '：**插件素材库** + 两个平台目录通道（图片资源库 / 音效库 —— 只报目录事实，不落字节）。\n★ 插件素材库：**按内容寻址**（文件名 = sha256 前 16 位 + 扩展名，同图只存一份 ⇒ `deduped:true`），落**插件数据目录**（不进游戏存档、不碰活文件）。**磁盘是用户的**：素材**绝不自动删**（`op=remove` 要 `confirm:true`，连字节删再加 `deleteFile:true`；`op=prune` 只报告不删）。\n★ 安全：`source`/`out` 只认**绝对路径**；只收图片白名单、拒 0 字节 / >64 MiB；`out` 默认不覆盖；`../` 拒。\n★ 平台图片资源库（`op=catalog`，1543 条 / 14 类，id 100001~112042）：过滤分类/色档/`simOnly`/`imgExists`；**单张图没有名字** ⇒ 只回分类名（几何号 100001~100006 例外，回 `meaning`）。\n★ 平台音效库（`op=sound-search` / `sound-get`，1997 条 / 7 类）：`q` 按**中英名**模糊搜（多词 = AND），逐条给 `matchKind`；⛔ **不支持拼音/首字母**。\n★ **回执体积**：发现调用给全表、过滤调用只给结论（`categoriesOmitted` 报省了几行）；要完整分类表或 sha256 传 `withMeta:true`。\n\n\n\n\n**典型调用**：`{"op":"add","source":"D:\\\\art\\\\bg.png","tags":"背景"}`｜`{"op":"catalog","category":"基础形状"}`｜`{"op":"sound-search","q":"宝箱 开启","limit":5}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['add', 'list', 'get', 'remove', 'rebuild', 'prune', 'stats', 'catalog', 'sound-search', 'sound-get', 'icon-search'],
          description: '默认 list。add 入库（要 source 或 base64）／get 取回／remove 摘索引／rebuild 重建索引／prune 报告不删／stats 总数与体积；'
            + 'catalog = 查**平台图片资源库**；sound-search = 模糊搜音效；sound-get = 按 id 取单条音效；'
            + 'icon-search = **按语义找图标**（不传参数给分类概览、传 `q` 关键词搜、传 `id` 看单条）。',
        },
        id: {
          type: 'string',
          description: 'op=get / remove：素材 `id`（或**唯一前缀**；命中多条就报候选、不猜）。op=catalog：图片素材号；op=sound-get：音效 id。',
        },
        source: {
          type: 'string',
          description: 'op=add：**绝对路径**（如 `D:\\\\art\\\\bg.png`）或 `data:image/png;base64,…`。与 `base64` 只能给一个。',
        },
        base64: {
          type: 'string',
          description: 'op=add：裸 base64 —— 走这条路要给 `name` 一个带图片扩展名的名字，否则认不出类型。',
        },
        name: {
          type: 'string',
          description: 'op=add：**原始文件名，仅展示用**（进索引、回在 `list` 里；不参与寻址）。省略用 source 的 basename。',
        },        tags: {
          type: 'string',
          description: 'op=add：**逗号分隔**的标签（如 `"背景,像素画"`），只用于分类与 `list tag=` 过滤。',
        },
        tag: { type: 'string', description: 'op=list：只看带这个标签的素材。' },
        limit: {
          type: 'number',
          description: 'op=list：默认全部（catalog 50/500、sound-search 20/100）；超限**夹紧**并回 `limitClamped`。',
        },
        q: {
          type: 'string',
          description: 'op=sound-search：关键词（中/英名；空格 = AND）。⚠️ **不支持拼音 / 首字母**。**不给 `q` = 发现调用**（只回分类表，0 条音效）。',
        },
        category: {
          type: 'string',
          description: 'op=catalog：分类 id（`"8"`）或名字（「基础形状」，也可给子串）；op=sound-search：分类 id（`"5"`=物件）。给错报错并列合法值。',
        },
        colorKind: {
          type: 'string',
          enum: ['mono', 'multi', 'neutral', 'mixed'],
          description: 'op=catalog：颜色档（`mono` 官方名含「单色」／`multi` 含「彩色」／`neutral`／`mixed` 是官方没标的实测档）。不传 = 全部。',
        },
        simOnly: {
          type: 'boolean',
          description: 'op=catalog：只回**模拟器画得出来**的 6 个几何号（`100001~100006`）。默认 false。',
        },
        imgExists: {
          type: 'boolean',
          description: 'op=catalog：`true` 只看有图的；`false` 只看**目录标了却没图**的那 21 条。不传 = 不筛。',
        },
        out: {
          type: 'string',
          description: 'op=get：**绝对路径** —— 把字节写到这里（逐字节一致）。不传就回 `dataUrl`。已存在时**默认不覆盖**。',
        },
        overwrite: { type: 'boolean', description: 'op=get：`out` 已存在时是否覆盖。默认 false（**不覆盖是刻意的**）。' },
        confirm: {
          type: 'boolean',
          description: 'op=remove / prune：**显式确认**。remove 给 true 才摘索引；prune 给 true 才真删「无主 / 损坏」那两类。',
        },
        deleteFile: {
          type: 'boolean', description: 'op=remove：**连盘上的字节一起删**（必须同时给 `confirm:true`）。不给就只摘索引（回执 `fileKept:true`）。',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'op=list / op=catalog / op=sound-search：只去逐条 `items`，**计数 / 分类表 / `unverified` 等结论一个不删**。默认 false。',
        },
        withMeta: {
          type: 'boolean',
          description: 'op=catalog / sound-search：把**完整分类表**与 sha256 元信息给我（**只在挑分类 / 审计哈希时开**）。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      return assetOp(args);
    },
  },

  {
    name: 'miliastra_gen',
    description:
      TITLE + '：**离线生成器** —— 一次调用就出**可直接部署的 Lua**（不是数据模型、不是半成品）。\nop=text-gradient：文本 → 色标 → **逐帧刷字**客户端 Lua（`EnableUpdate` + `OnUpdate` 换帧）。\nop=struct-json：结构体/字典 → 可直接导入千星的变量 JSON。\nop=pixel-art：图片 → 可部署**像素画 Lua**（图片控件**矩形块拼图**，非「一个像素一个控件」；要 `cols`/`rows`/`maxSide` + `pixelSize`；**静态不加 EnableUpdate**）。\nop=vfx-lua：**UI 粒子特效** → 可部署客户端 Lua（预设用 `preset:"list"` 按需枚举；贝塞尔用 `path` 三手柄）。\n★ 粒子贴图 `imageId` 真机可用**全部 1543 素材号**（`op=catalog` 挑）；**模拟器只画 `100001~100006`** ⇒ 预览传 `previewImageId`。\n★ **硬规则**：结构体 ID 必须 **10 位数字**、单条文本 **≤500 字符**（放行传 `allowLongText:true`）—— 生成前校验。\n★ **交接值**（模板索引/控件名/容器索引）AI 拿不到：**先自动读当前关卡 `.gil`**（唯一候选才采用），拿不到就**报错点名**（`needsHandover[]`），**绝不编**；`vfx-lua` 的 `container` 与 `templateIndex` 同等必填。\n★ `preflight[]` 投递前自检（`ok:null` = 判不了、**不猜**）；`unverified[]` 记未验证项；产物顶部带**运行时依赖清单**。\n\n**典型调用**：`{"op":"text-gradient","text":"原神千星","colors":["#FFCC33","#37FFFF"],"controlName":"标题"}`｜`{"op":"pixel-art","assetId":"a1b2c3d4e5f60718","cols":32,"pixelSize":8,"templateIndex":1073741900,"container":1073741866}`｜`{"op":"vfx-lua","preset":"coin-collect","imageId":101023,"previewImageId":100002}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['text-gradient', 'struct-json', 'pixel-art', 'vfx-lua'], description: '默认 text-gradient。' },
        output: { type: 'string', enum: ['lua', 'data', 'struct'], description: '默认 lua（回执给可部署的 Lua + `luaBytes`/`lines`）；`data` = 只要数据；`struct` 只有 pixel-art 用。' },
        assetId: { type: 'string', description: 'op=pixel-art：图源 —— `miliastra_asset` 的素材 id（或前缀）。与 `source` 二选一。' },
        source: { type: 'string', description: 'op=pixel-art：图源 —— 图片**绝对路径**（**不抓网图**）。' },
        cols: { type: 'number', description: 'op=pixel-art：网格列数（格）。只给一边就按比例推另一边。' },
        rows: { type: 'number', description: 'op=pixel-art：网格行数（格）。' },
        maxSide: { type: 'number', description: 'op=pixel-art：只给**长边**格数（另一边按比例推）；都不给默认 32。' },
        pixelSize: { type: 'number', description: 'op=pixel-art：一格占多少像素（默认 8，1~64）。' },
        centerOffsetX: { type: 'number', description: 'op=pixel-art：像素画中心相对容器中心的水平偏移（默认 0）。' },
        centerOffsetY: { type: 'number', description: 'op=pixel-art：同上，垂直方向。' },
        container: { type: 'number', description: 'op=pixel-art / op=vfx-lua：**交接值** —— **容器节点索引**。别编，问创作者要。' },
        imageId: { type: 'number', description: 'op=vfx-lua：粒子贴图（**真机任意平台素材号**，用 `miliastra_asset op=catalog` 挑；不传 = 预设默认）。' },
        previewImageId: { type: 'number', description: 'op=vfx-lua：**预览用号**（生成物里换成它，只为模拟器看得见：只画 `100001~100006`）。' },
        loop: { type: 'boolean', description: 'op=vfx-lua：播完是否循环（不传 = 预设默认）。' },
        duration: { type: 'number', description: 'op=vfx-lua：播多久（秒；不传 = 预设默认）。' },
        imageType: { type: 'string', enum: ['Stretch', 'Basic'], description: 'op=pixel-art：`Enum.ImageType`（默认 Stretch）。' },
        mergeRuns: { type: 'boolean', description: 'op=pixel-art：行内行程 + 跨行同色同宽合并（默认 true）。' },
        text: { type: 'string', description: 'op=text-gradient：文本（按 UTF-16 码元逐字符切）。' },
        colors: { type: 'array', items: { type: 'string' }, description: 'op=text-gradient：色标（≥1，有序）；hex 或 `rgb()/rgba()`。' },
        sizes: { type: 'array', items: { type: 'number' }, description: 'op=text-gradient：字号色标（默认 `[20,20]`）。' },
        colorStyle: { type: 'string', description: 'op=text-gradient：颜色风格 ' + STYLE_CHOICES.color.map((s) => '`' + s + '`').join('/') + '。' },
        sizeStyle: { type: 'string', description: 'op=text-gradient：字号风格 ' + STYLE_CHOICES.size.map((s) => '`' + s + '`').join('/') + '（jitter=跳字）。' },
        withColor: { type: 'boolean', description: 'op=text-gradient：是否包 `<color=…>`（默认 true）。' },
        withSize: { type: 'boolean', description: 'op=text-gradient：是否包 `<size=N>`（默认 false，**未验证**）。' },
        use4bit: { type: 'boolean', description: 'op=text-gradient / pixel-art：4bit 量化（默认 false，**未验证**）。' },
        colorJumpFrames: { type: 'number', description: 'op=text-gradient：颜色跳帧（默认 0）。' },
        fps: { type: 'number', description: 'op=text-gradient：每秒切几帧（默认 8，上限 60）。' },
        controlName: { type: 'string', description: 'op=text-gradient：**交接值** —— 要逐帧改字的文本框控件名。别编。' },
        templateIndex: { type: 'number', description: 'op=text-gradient / pixel-art / vfx-lua：**交接值** —— 控件模板索引（只有「存为模板」的能创建）。别编。' },
        frames: { type: 'array', items: { type: 'number' }, description: 'op=text-gradient（data）：要哪几帧；不给就出前 60 帧。' },
        structId: { type: 'string', description: 'op=struct-json：结构体 ID —— **必须 10 位数字**。别编。' },
        structName: { type: 'string', description: 'op=struct-json：结构体名。' },
        fields: { type: 'array', items: { type: 'object' }, description: 'op=struct-json：字段表 `{key, param_type, value?}`。' },
        variableName: { type: 'string', description: 'op=struct-json：给了就额外回「自定义变量」形态。' },
        spelling: { type: 'string', enum: ['struct_ype', 'struct_type'], description: 'op=struct-json：写出的拼写键（默认 `struct_ype`，都认）。' },
        allowLongText: { type: 'boolean', description: 'op=struct-json：放行 > 500 字符（默认 false = 报错）。' },
        summaryOnly: { type: 'boolean', description: '只去正文不去结论：去掉 `lua` / JSON 正文 / 逐条块数据。统计与 `nextStep` 都留。' },
        preset: { type: 'string', description: 'op=vfx-lua：预设 id（**17 粒子**（含 4 个组合预设：星光爆发/金币喷泉/雪中花瓣/孔雀终幕）+ **3 图元**：环刃/刀光/新月）；传 `"list"` 列全部（每条带二级分类）。` 列全部。' },
        path: { type: 'object', description: 'op=vfx-lua：贝塞尔"钢笔"三手柄 `{start?,p1,p2,target}`（后三个**相对发射点**）。给了就设 `motion="bezier"`。' },
        pathLayer: { type: 'number', description: 'op=vfx-lua：`path` 打到第几层（1 起，默认 1）。' },
        paths: { type: 'array', description: 'op=vfx-lua：**一次给多层** `[{layer,points:[{x,y}]}]`。粒子层**正好 4 点**（单段）；**图元层 4+3k**（多段）。给错 `ok:false` 说清原因。' },
        particlesPerEmitter: { type: 'number', description: 'op=vfx-lua：每层池子上限（要 ≥ rate×lifetime.max，见回执 `pool`）。' },
        sizeScale: { type: 'number', description: 'op=vfx-lua：粒子尺寸倍率（1 = 原生）。' },
        createAfterFrames: { type: 'number', description: 'op=vfx-lua：晚建帧数（默认 30；**别设 0**，会被全屏背景盖住）。' },
        diagSteadyAt: { type: 'number', description: 'op=vfx-lua：稳态诊断时刻（秒，默认 2）。' },
        parentName: { type: 'string', description: 'op=vfx-lua：一个**屏幕上看得见的控件名**（借它的容器当父节点）；不给就用 `script.object`。' },
        varPrefix: { type: 'string', description: 'op=vfx-lua：给生成物两个数据块改名（CONFIG/DATA ⇒ <varPrefix>_CONFIG/<varPrefix>_DATA），默认不改名。用途：同一脚本里放两套外观（主技能 + 副技能），否则全局名会撞。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      return genOp(args);
    },
  },

  {
    name: 'miliastra_kb',
    description:
      TITLE + '：**节点图知识库**（排查问答 / 节点说明 / 官方文档）。'
      + '\n★ `op:"qa"` = **离线**蒸馏的排查清单：给症状关键词（「镜头不生效」「信号收不到」…），回**先问哪几个问题** + 有序排查 + 常见误判 + 出处'
      + ' + `evidence`（官方/社区/本机实测）。**只给排查路径，不下结论**；不给 `q` 就回目录。'
      + '\n★ `op:"node"` = **离线**节点说明（随包词典 558 条：中英名 / 标识 / 服务端·客户端 / 分类 / 端口与类型）。'
      + '\n★ `op:"list"/"doc"/"search"` = **在线**第三方知识库 `https://ugc.070077.xyz`（300+ 篇官方 FAQ/教程 + 米游社问答楼）：'
      + '⚠️ 这三个 op **会把你的 query 发到那个站点**（`qa`/`node` 纯离线）；取不到就说取不到，别当成"知识库没有"。'
      + '\n'
      + '\n\n**典型调用**：`{"op":"qa","q":"信号 收不到"}`｜`{"op":"qa","id":"camera-not-working"}`｜`{"op":"node","q":"嘲讽目标"}`｜`{"op":"search","q":"选项卡 触发器 不触发"}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['qa', 'node', 'list', 'doc', 'search'],
          description: '默认 qa。qa/node 离线；list/doc/search 在线。',
        },
        q: { type: 'string', description: 'op=qa 症状关键词（空格=AND）；op=node 节点名子串；op=list/search 关键词或问题。' },
        id: { type: 'string', description: 'op=qa：点名某条（如 `camera-not-working`），比关键词准。' },
        tag: { type: 'string', description: 'op=qa：按标签过滤（如 `镜头`/`信号`）。' },
        titles: { type: 'array', items: { type: 'string' }, description: 'op=doc：要取全文的标题（可多个）。' },
        topK: { type: 'number', description: 'op=search：检索条数（1~20，默认 5）。' },
        limit: { type: 'number', description: 'op=qa/node：最多几条（默认 5/8）。' },
        system: { type: 'string', enum: ['Server', 'Client'], description: 'op=node：只看服务端/客户端。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'qa');
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : null;
      if (op === 'qa') {
        const byId = args.id ? kbEntry(String(args.id)) : null;
        if (args.id && !byId) {
          return { ok: false, op, error: '没有这条：' + String(args.id), candidates: kbCatalog().map((e) => e.id) };
        }
        const asked = String(args.q || '').trim();
        // 不给关键词也不给标签 ⇒ 回**完整目录**（让人/模型先挑，而不是硬塞 5 条）
        if (!byId && !asked && !args.tag) {
          return {
            ok: true, op, query: null, total: KB_ENTRIES.length, catalog: kbCatalog(),
            note: '**离线蒸馏**的排查清单目录（我们自己的话，短清单）。给 `q`（症状关键词）或 `id` 取正文；'
              + '要官方原文用 `op:"doc"`（在线）或点 `sources[].url` 自己核。',
            nextStep: '先按症状挑一条：`{"op":"qa","id":"<上面某个 id>"}`；或直接给关键词 `{"op":"qa","q":"镜头 不跟随"}`。',
          };
        }
        const hit = byId ? [{ entry: byId, score: 999 }] : kbSearch(args.q, { limit: limit || 5, tag: args.tag });
        const shape = (e) => ({
          id: e.id, symptom: e.symptom, ask: e.ask, steps: e.steps, avoid: e.avoid || null,
          evidence: e.evidence, tags: e.tags, sources: kbSources(e.src),
        });
        return {
          ok: true, op, query: args.q || null, tag: args.tag || null,
          hitCount: hit.length, total: KB_ENTRIES.length,
          entries: hit.map((h) => shape(h.entry)),
          catalog: hit.length ? undefined : kbCatalog(),
          note: '离线蒸馏（我们自己的话，短清单）——**只给排查路径，不下结论**；'
            + '要官方原文用 `op:"doc"`（在线）或点 `sources[].url` 自己核。',
          nextStep: '把症状说得更具体会命中更准（如「镜头不生效」→「镜头 固定 不跟随」）；'
            + '要"这一关的这些图各由什么节点组成"用 `miliastra_map` 的 `op:"anatomy"`。',
        };
      }
      if (op === 'node') {
        const r = searchNodes({ q: String(args.q || ''), system: args.system, limit: limit || 8 });
        const out = {
          ok: true, op, query: String(args.q || ''), source: '离线随包节点词典（lib/nodedb.json，' + r.meta.counts.total + ' 条）',
          hitCount: r.returned, total: r.total,
          nodes: r.rows,
          facets: { domains: nodeDbFacets().domains, server: nodeDbFacets().server, client: nodeDbFacets().client },
          unverified: r.unverified,
          nextStep: '要看参数/端口就用这个（每条带 direction/label/type/shell）；要找"这个节点该配什么组件"再问 `op:"search"`（在线）。',
        };
        // 词典里一条都没有 ⇒ **才**去问在线知识库（作者：「你有不确定节点图功能直接对接蒸馏」）
        if (!r.returned && String(args.q || '').trim()) {
          const online = await kbOnline('get_node_info', { names: [String(args.q)] });
          out.onlineFallback = online;
          out.note = online.ok
            ? '随包词典里没有这条 ⇒ 上面的 `onlineFallback` 是**第三方知识库**给的，请当成"参考"、不是本机确证。'
            : '随包词典里没有这条，在线知识库也没取到（' + (online.error || '未知原因') + '）—— **别据此说"这个节点不存在"**。';
        }
        return out;
      }
      // —— 以下三个 op 走**在线**第三方知识库（会把 query 发出去；取不到就如实说取不到）——
      if (op === 'doc') {
        const titles = Array.isArray(args.titles) ? args.titles.map(String) : (args.q ? [String(args.q)] : []);
        if (!titles.length) return { ok: false, op, error: 'op=doc 要给 `titles`（文档标题数组）或 `q`（单个标题）' };
        return await kbOnline('get_document', { titles });
      }
      if (op === 'list') {
        return await kbOnline('list_documents', { keywords: args.q ? [String(args.q)] : [] });
      }
      if (op === 'search') {
        if (!args.q) return { ok: false, op, error: 'op=search 要给 `q`（自然语言问题）' };
        const k = Number.isFinite(args.topK) ? Math.min(20, Math.max(1, Number(args.topK))) : 5;
        return await kbOnline('rag_search', { queries: [String(args.q)], top_k: k });
      }
      return { ok: false, op, error: '不认识的 op：' + op };
    },
  },

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
export function hostStaleness({ sourceVersion, sourceMtimeMs, loadedVersion, startedAtMs }) {
  const versionNewer = !!(sourceVersion && loadedVersion && String(sourceVersion) !== String(loadedVersion));
  const mtimeNewer = !!(sourceMtimeMs && startedAtMs && sourceMtimeMs > startedAtMs);
  const deltaMin = mtimeNewer ? Math.max(1, Math.round((sourceMtimeMs - startedAtMs) / 60000)) : 0;
  const stale = versionNewer || mtimeNewer;
  const why = [
    versionNewer ? `源码 v${sourceVersion} ≠ 载入的 v${loadedVersion}` : null,
    mtimeNewer ? `index.js 比启动晚约 ${deltaMin} 分钟` : null,
  ].filter(Boolean).join('，');
  return {
    stale, versionNewer, mtimeNewer, deltaMin,
    hint: stale
      ? `源码比 Host 快照新（${why}）→ Host 半边（工具 / 路由 / 系统提示）的改动要**重启 dsh web** 才生效；只改 lib/client.js 刷新页面即可`
      : null,
  };
}

/** 读本包源码的版本与 mtime（读不到只返 null 字段，**绝不抛** —— 面板要能照常显示）。 */
function sourceInfo() {
  try {
    const dir = pathMod.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fsMod.readFileSync(pathMod.join(dir, 'package.json'), 'utf8'));
    const st = fsMod.statSync(pathMod.join(dir, 'index.js'));
    return { sourceVersion: pkg.version, sourceMtimeMs: st.mtimeMs, sourceMtime: new Date(st.mtimeMs).toISOString() };
  } catch (e) {
    return { sourceVersion: null, sourceMtimeMs: null, error: (e && e.message) || String(e) };
  }
}

/**
 * Host 自身的状态（`/miliastra/status` 与 `miliastra_health` **共用这一份**）。
 * 含「源码是不是比这个快照新」—— 判据只有一份，免得两处各写一套然后漂移。
 */
function hostSummary() {
  const info = sourceInfo();
  return {
    version: VERSION,
    startedAt: new Date(STARTED_AT).toISOString(),
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    source: { ...info, ...hostStaleness({ ...info, loadedVersion: VERSION, startedAtMs: STARTED_AT }) },
  };
}

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

/**
 * 等「试玩开跑」—— `miliastra_playtest op=wait` 与 `miliastra_shot op=burst awaitPlaytest:true` **共用这一份**。
 *
 * 抽出来的理由不是为了少写几行，而是**判据只能有一份**：
 * 两条路各写一套「怎样算开跑」，早晚会漂移，而「漂移过的判据」比没有判据更坏（会让人信错的那个）。
 */
async function waitForPlaytestStart(lv, { timeoutSec = 90, backSec = 0, pollMs = 400 } = {}) {
  const logPath = playtestLogPath(lv.brand);
  const base = scanLog(logPath);
  if (!base.ok) {
    throw new HttpError(
      '读不到试玩日志 ' + logPath + '（' + (base.error || '未知原因') + '）。'
      + '这个文件由游戏客户端在启动时创建 —— 确认 ' + lv.brand + ' 客户端开着、且这台机器上跑过。',
      404,
    );
  }
  const t0 = Date.now();
  let state = base.state;
  let offset = base.size;
  let hit = null;
  if (backSec > 0) {
    const pre = shouldHit(state, t0, { backSec });
    if (pre.hit) hit = { backHit: true, atMs: state.lastStartAtMs, epochSec: state.epochSec, token: state.token };
  }
  while (!hit && Date.now() - t0 < timeoutSec * 1000) {
    await sleep(pollMs);
    const inc = readIncrement(logPath, offset);
    if (!inc.ok) throw new HttpError('读试玩日志出错：' + inc.error, 500);
    if (inc.rotated) {
      // 游戏重启 → 日志换代 → 从头对齐，别拿旧 offset 读新文件
      offset = 0;
      state = createPlaytestState();
      continue;
    }
    if (!inc.text) continue;
    offset = inc.size;
    const before = state.lastStartAtMs;
    state = reduceLogLines(state, inc.text.split(/\r?\n/)).state;
    if (state.lastStartAtMs !== before && Number.isFinite(state.lastStartAtMs)) {
      hit = { backHit: false, atMs: state.lastStartAtMs, epochSec: state.epochSec, token: state.token };
    }
  }
  return {
    logPath, base, state,
    hit: !!hit,
    backHit: !!(hit && hit.backHit),
    atMs: hit ? hit.atMs : null,
    startedAt: state.startedAtText || null,
    epochSec: hit ? hit.epochSec : null,
    token: hit ? hit.token : null,
    waitedSec: Math.round((Date.now() - t0) / 100) / 10,
    timeoutSec,
    summary: playtestSummary(state),
  };
}

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
function giaLandingFor(lv, state) {
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
 * 这次取到的 `.gia` **属不属于本次会话**—— 反馈 A2 ②（`op=tail|grep|runs` 的回执都带它）。
 *
 * 为什么必须显式告警：那四局没有 `.gia` 时，`op=grep` 返回的是**上一局**的内容，
 * `file` 字段虽然标了文件名，但人（和 AI）都容易把它当成本局证据 —— 这是整条取证链最容易张冠李戴的一环。
 */
function logStalenessFor(lv, file, epochs) {
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
async function armPlaytestShots(args, lv) {
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
