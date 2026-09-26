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
 *   miliastra_probe   探针：模板化渲染 → 部署 → 试玩后回收结论
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
const VERSION = '0.4.0';
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
import { scanLevels, pickCurrent, findLevel, localLowRoot } from './lib/locate.mjs';
import { inspect, deploy as deployFile, pickLuaFile, rankLuaFiles, defaultBackupDir, backupFile, listBackups, restore as restoreFile, restoreCommand, stripBomFile, writeDeployFingerprint, readDeployFingerprint, fingerprintDelta, DEPLOY_FINGERPRINT_NAME, readLuaAt, pickLiveFile, compareLiveSources, normalizeLiveName } from './lib/codefile.mjs';
import { scanRects, compareRects, expandDriverRefs } from './lib/rects.mjs';
import { snapshotFreshness } from './lib/freshness.mjs';
import { lintUiFiles } from './lib/uilint.mjs';
import { uiWarnings, uiWarningsOfFiles, UI_WARN_DOC } from './lib/uiwarn.mjs';
import { readGil, renderClientUI, extractStrings, compareScriptSnapshot, mountStatusOf, pickScriptMapping } from './lib/gil.mjs';
import { readGia, listGia, filterRecords, groupRuns, playRunsOf, summarizeRuns, compareRuns, giaRunEpochs, logFreshness, giaLandingState } from './lib/gia.mjs';
import {
  playtestLogPath, scanLog, readIncrement, reduceLogLines, createPlaytestState,
  playtestSummary, shouldHit, logSize,
} from './lib/playtest.mjs';
import { PROBE_TEMPLATES, PROBE_TEMPLATE_CHOICES, PROBE_INFO, PROBE_OVERVIEW, renderProbe } from './lib/probes.mjs';
import { extractLevelTable, describeLevels, findCanvas, levelSummary } from './lib/leveldata.mjs';
import { collectMetrics, summarizeMil, summarizeLoose, metricsTimeline, conventionHint, slimMil, slimLoose } from './lib/metrics.mjs';
import { clientProcesses } from './lib/proc.mjs';
import { atomicWriteFile } from './lib/fsx.mjs';
import { simOp, disposeSimAll, simRuntimeInfo } from './lib/sim.mjs';
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
  return ms && ms.known === false ? '（**挂没挂过判断不了**：' + ms.note + '）' + base : base;
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

/** 把版本戳盖进试玩页（占位符 `__PLAY_STAMP__`）。纯函数，便于回归。 */
export function playPageSource(html, stamp) {
  return String(html || '').replace(/__PLAY_STAMP__/g, String(stamp || 'unknown'));
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
 * `miliastra_health op=sha`（N-2）：**三方 SHA 对照** —— 活文件 / 本地镜像 / `.gil` 嵌入快照。
 *
 * 为什么值得单开一步：`deploy` 只写本地活文件，游戏跑的是**编辑器存盘时嵌进 `.gil` 的那份快照** ——
 * 「部署了但没存盘」是最容易白跑一轮的失败（作者 2026-09-26 手工核过三处 SHA 才想清）。
 * 这里只做**比对与一句话结论**，不替谁决定该用哪一版；镜像目录由调用方给（插件不假设工作区布局）。
 */
function healthSha({ mirror = null } = {}) {
  const levels = scanLevels();
  const cur = pickCurrent(levels);
  if (!cur) {
    return { ok: false, op: 'sha', error: '没扫到关卡 —— 先跑 miliastra_health（不带 op）看清这台机器上有什么。' };
  }
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
 * 从控件记录里挑出「可能可被脚本动态创建」的候选。
 * ⚠️ 「无父节点」只是**必要**条件，不是充分条件：
 *    容器节点 的独立记录通常是客户端控件容器的画布根节点（画布实例，不可创建）。
 */
function classifyControls(clientUI) {
  const standalone = clientUI.filter((r) => r.parent == null);
  const likelyTemplates = standalone.filter((r) => CLIENT_CONTROL_NAME.test(r.name));
  const likelyContainers = standalone.filter((r) => r.name === '容器节点');
  const structural = standalone.filter((r) => STRUCTURAL_NAME.test(r.name)).map((r) => ({ id: r.id, name: r.name }));
  return { standalone, likelyTemplates, likelyContainers, structural };
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
      + '本关要用哪个号，以「本关读到的」那一份为准；确证某个号能不能创建，用探针「试钥匙」跑一次。');
  }
  return parts.join('');
}

/* ---------------------------------------------- op=rects：矩形提取与配对（N-1） */

/** 扫工程目录时要跳过的活文件（历史产物 / 备份 / 探针源码 —— 收进来只会造出假配对）。 */
const RECT_SKIP_FILE = /(^_)|(_备份\.lua$)|(\.bak$)|(\.engine\.lua$)|(\.save\.json$)/i;
/** 一次扫多少个 `.lua`（超过就如实报 `truncated`，不静默截断）。 */
const RECT_MAX_FILES = 60;
/** 回执里最多列多少条矩形（`summaryOnly` 时更多信息被折叠）。 */
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
      if (RECT_SKIP_FILE.test(ent.name)) { skipped.push({ path: full, reason: '历史产物/备份/探针源码（收进来会造出假配对）' }); continue; }
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
  return {
    ok: true, op: 'lint-ui',
    dir: root, scope,
    level: level ? { levelId: level.levelId } : null,
    fileCount: rows.length,
    files: rows.map((f) => ({ file: f.name, path: f.path, bytes: Buffer.byteLength(f.text, 'utf8') })),
    skipped,
    skippedCount: skipped.length,
    summaryOnly,
    usedConfig: r.usedConfig,
    counts: r.counts,
    passed: r.passed,
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
      scan.skipped.length ? '跳过了 ' + scan.skipped.length + ' 个文件/目录（见 `skipped[]`：历史产物、备份、探针源码、隐藏目录）—— 要看它们就把目录缩到那个子目录再跑。' : null,
    ].filter(Boolean),
    hint: '差异看 `near`（逐字段差 `delta`）与 `pairsChecked`（人点名的对照）；'
      + '要省上下文传 `summaryOnly:true`（去掉全量矩形清单，计数与差异列表都还在）。',
  };
}

/* ---------------------------------------------------------------- 工具定义 */

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
  { tool: 'miliastra_health', when: '先用它定位「当前关卡 / 活文件 / 地图 / 日志目录」（路径随账号与换图变化，禁止写死）' },
  { tool: 'miliastra_code', when: '改完本地 lua 用 op=deploy 投进沙箱（自动备份 + SHA 校验 + 无 BOM；还会跑 Lua 结构校验）；op=inspect 看有没有被编辑器写回旧版；op=read 给 source=<绝对路径> 就只读看任意本地 .lua（不在沙箱里也行）' },
  { tool: 'miliastra_map', when: '判断「哪些控件能被脚本动态创建」用 op=clientui（只看无父节点的独立模板）' },
  { tool: 'miliastra_log', when: '运行时结果一律用它取证（Lua 里 print，别靠猜）；op=runs 按「局」切分、op=metrics 汇总指标分布' },
  { tool: 'miliastra_playtest', when: '想知道「开跑那一刻 / 现在在不在试玩」用它 —— 开跑信号在 output_log.txt（实测延迟 0.07~0.18 秒），**`.gia` 里没有**（它是一局结束后才落盘）' },
  { tool: 'miliastra_shot', when: '要看「画面对不对」用它（日志只能回答「代码跑了没」）；「等开跑 → 等 N 秒 → 连拍」是**一次调用**（op=burst awaitPlaytest:true，可先 dryRun 看计划）' },
  { tool: 'miliastra_probe', when: '需要运行时真相（某个控件能不能建、某个枚举叫什么名）时部署探针，让人重新试玩一局后 collect，**收完记得还原脚本**' },
  { tool: 'miliastra_sim', when: '它是**真机试玩之前的「预测试」**（①静态预览 ②交互试玩 ③确定性判定，三档共用同一份工程）—— 要**在游戏之外先跑一遍**（建界面 / 改控件 / 跑 levelScript / 出画面 PNG）时用它；**要把真机那份脚本搬进来跑，用 `op=bind`**（给活文件路径 + 控件模板索引；**索引优先自动拿**：`op=handover`（可带 `source` 读任意本地 .lua）从源码抽 → `miliastra_map op=clientui` 从 `.gil` 读 → 两个都拿不到才问创作者，**不许编**；它会回「脚本跑没跑、控件建了几个」，缺交接值就报错）；**要固定「这一版怎么验收」，用 `op=cases`**（存成一份人和 AI 读同一份的清单：自动项确定性重放、人工项只列出来等人打勾；`autoPassed` 不等于验收通过）；**AI 自测逻辑一律用 `op=verify`**（一次调用 = 操作 + 断言 + 判定，确定性可重复；一组用例用 `cases[]` 一次跑完，没过会带失败帧与运行时控件名；**人玩过的那一局用 `fromHistory:true` 直接变回归用例**，不用手抄 events；**动画/动效类用 `op=frames` 出多帧 + 帧间像素差数字，别只断言静态值**）—— 写断言前先用 `op=controls` 拿控件名（`runtime:true` 看脚本运行时建出来的）；人想自己上手玩就让他开 `GET /miliastra/play`（WebGL 试玩页，与 AI 共用同一个会话）；不占用真机、不需要试玩按钮，但它**不等于真机通过**（官方素材/真机渲染/联机都不覆盖）；**你自己想"玩"先记住量级**：发输入 ≈5ms 级、读场景 ≈200ms 级（≈5Hz）⇒ 能做**回合制闭环**、**不能逐帧看画面**（实时档要么一次调用里跑循环、要么让人玩）；HUD 上的字直接从 `get{view:true}` 的 **`textbox.text`** 读（当闭环条件用）；按 `…Down` 要**配对** `…Up` 否则等于一直按住' },
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

const TOOLS = [
  {
    name: 'miliastra_health',
    description:
      TITLE + '：环境体检。**任何时候要操作原神 UGC，先调它。**'
      + '返回：客户端安装（正式服/Beta）、所有关卡、当前判定为「正在开发」的关卡、'
      + '活文件（沙箱 .lua）清单与字节数、地图存档 .gil、运行时日志目录与文件数。'
      + '编辑器 UI 操作（建模板/挂脚本）没有自动化通道 —— 本工具只做文件层体检。'
      + '\n★ `op:"sha"` **三方 SHA 对照**：活文件 / 本地镜像（`mirror`=目录绝对路径；不传就只出两列）/ `.gil` **嵌入快照**（**试玩真正跑的是它**）—— 三列哈希 + 一句结论（`该部署了` / `该存盘了` / `三方一致`）；'
      + '`.gil` 那一列还会带 `belongsTo` / `isCurrent`（**它是存盘那一刻的快照，不是实时的**）。对象是**当前关卡**。'
      + '\n★ `brief:true` 是「任何操作前先调」那一档（< 1KB）：`luaFiles` 给 `[{name, bytes}]`，'
      + '0 字节（空脚本/未写入）与**不在 `.gil` 挂载集合里**的活文件都会在 `note` 里点名。'
      + '\n\n**典型调用**：`{}`（当前关卡速览）｜`{"op":"sha","mirror":"D:\\\\code\\\\侦探1"}`（三方 SHA 对照）｜`{"all":true}`（全部关卡）｜`{"brief":true}`（< 1KB：在哪张图/活文件/日志在哪）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['scan', 'sha'], description: '默认 scan（环境体检）。op=sha = **三方 SHA 对照**（活文件 / mirror 镜像 / .gil 嵌入快照 + 一句结论）。' },
        mirror: {
          type: 'string',
          description: 'op=sha：本地镜像**目录的绝对路径**（如 `code/` 那一份）—— 按活文件同名匹配（忽略大小写与 `.lua`）。'
            + '不传就只比「活文件 vs .gil」两列（插件**不假设**你的工作区布局）。',
        },
        all: { type: 'boolean', description: 'true=返回全部关卡清单（默认只返回最近 12 个）。' },
        brief: {
          type: 'boolean',
          description: '**只回「我在哪张图 / 活文件是哪个 / 日志在哪」（< 1KB）** —— 默认回执约 9.7KB、all:true 约 25KB，'
            + '而这是「任何操作前先调」的工具，多数时候只要这一小撮。'
            + '`luaFiles` 是 `[{name, bytes}]`：**0 字节**（空脚本/未写入）与**不在 `.gil` 挂载集合里**的活文件都在 `note` 里点名。'
            + '⚠️ **与 all / summaryOnly 同时给时 brief 优先**（默认行为一个字不改）。',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const levels = scanLevels();
      const cur = pickCurrent(levels);
      // ★ op=sha：三方 SHA 对照（N-2）—— 用**当前关卡**，与其余 op 同一口径
      if (String(args.op || 'scan') === 'sha') return healthSha({ mirror: args.mirror });
      /*
       * ★ brief 档：只回「在哪张图 / 活文件是哪个 / 日志在哪」+ 进程状态。
       *   实测的痛点是体积（默认 9708 B / all:true 24966 B），不是信息不够 ——
       *   所以这一档只保留**每次都要看**的那几项，其余（每个关卡的 .gil、最近日志、ErrorLog）一律不带。
       */
      if (args.brief === true) {
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
        const luaFiles = live.map((f) => ({
          name: f.name,
          bytes: f.size,
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
          current: cur ? { brand: cur.brand, accountId: cur.accountId, levelId: cur.levelId } : null,
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
      TITLE + '：活文件（沙箱里的 .lua）的读 / 部署 / 体检 / 还原。'
      + '**部署一律：先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM**（带 BOM 原神实测会打印 "Read text file with BOM header may cause Lua error"）。'
      + 'op=read 读**沙箱活文件**的正文；**给了 `source`（绝对路径）就改读那个文件**（只读：不备份、不写入）。'
      + 'op=deploy 把 source 指向的本地文件投进沙箱（**覆盖前自动备份**）；**部署前先做 Lua 结构校验**（缺 end / 括号不配平 / 字符串没闭合 —— 投进去会静默不生效、日志里什么都没有），'
      + '默认 lintMode:"strict" 直接拒绝，"warn" 只提示、"off" 跳过。'
      + 'op=inspect 只体检不改动；op=backups 列全部备份（时间/SHA/是否带 BOM）；op=backup 手动备一份；'
      + 'op=restore 用它覆盖活文件 —— **backup 可以不传**，不传就用固定名那份 `<原名>.bak`。'
      + '⚠️ 部署不会热加载正在进行的试玩：要 停试玩 → 部署 → 重开试玩。'
      + '\n\n**安全约定（写活文件的地方都遵守，别绕过）**：①活文件是**唯一副本**（没有 git、没有撤销）⇒ **备份失败就中止覆盖**；'
      + '②**原子写**（同目录临时文件 → fsync → rename）；③写完必校验 SHA，**不过就自动回滚**；'
      + '④备份就在活文件旁边 `<活文件目录>\\_backup\\`，每次**两份**（固定名 `<原名>.bak` + 带本地时间戳的历史，永不自动删）；'
      + '⑤`noBackup` 必须同时传 `allowNoBackup:true`；⑥所有写操作都回执 `restoreWith`（照着跑就能还原）。'
      + '逐条细节与失败处置见 `docs/功能详解.md` §部署安全。'
      + '\n★ **已知坑提醒（`warnings[]`，不阻断）**：`deploy` / `inspect` 会静态扫两条**真机踩过的坑**——'
      + '①`sanitize(` 作用在一批模板上（复合模板与单图同批 ⇒ 可能整卡不显示）；②在 `OnStart`/构建循环里 `InstantiateClientUIControl`（若整卡不显示，试试挪到渲染第一帧）。'
      + '命中就给 `file:line` + 可执行改法 + 文档链，**只说「可能是」**（细则见 `docs/功能详解.md` §已知坑）。'
      + '\n★ **部署指纹**：`op=deploy` 成功后记 `.miliastra-deploy.<脚本名>.json`（SHA/字节/行数/来源）；'
      + '`op=inspect` 比对时活文件**不一致**就直说「多半是编辑器把脚本面板里的内存版存回了磁盘」，并给字节差/行数差。'
      + '\n★ **`op=fixbom`**：活文件带 BOM 时**只去掉那 3 个字节**（本来没有就什么都不做；备份失败即中止；写完校验，不过自动回滚）。'
      + '\n★ **部署不会热加载**：改完要 **stop → deploy → 重新试玩**；想确认某局跑的是哪版，看 `.gia` 里脚本自己 print 出来的版本行。'
      + '\n★ **多脚本工程**：`mount` 读**全部脚本映射**但只按**已挂载集合**判（取不到才 `known:false`，不瞎报 false）；逐条对账用 `miliastra_map op=script` 的 `mappings[]`。'
      + '\n★ **`op=deploy` 选目标活文件只用名字，不按「最近改动」猜**：目标 = 显式 `file` > `source` 的**同名**活文件（忽略大小写与 `.lua`）> 目录里只有 1 个（标 `basenameMismatch:true`）> 拒绝写盘并列出全部候选；'
      + '回执恒带 `dest` 与 `destBasenameMatchesSource`（实事故与理由见 `docs/功能详解.md` §部署目标）。'
      + '\n★ **`op=rects`：矩形提取 + 跨文件配对（只报数字不判决）** —— 给 `文件:行号` + 名字 + 数值；**同名**与**数值近似**（每字段都在 `nearPx` 内）的自动配对并给逐字段 `delta`；'
      + '名字不同的（`ovB1` ↔ `T_START`）要你用 `pairs` **点名**（工具不猜语义）；循环建出来的控件算不出数，回执给公式槽位 + `driverRefs` 的**驱动表原文**，公式由你代。'
      + '\n★ **`op=lint-ui`：平台级 UI 门禁（只报数字与位置，不下判决）** —— ①画在哪=点哪算（**人点名**的对照逐字比，同名差异另放 `sameNameDiff`）'
      + '②坐标/尺寸是 **8 的倍数** ③字号只许 **64/52/28/22** ④**h ≥ 字号×1.4 且 h ≥ 字号+16**（★真机铁律：高度不够 ⇒ 该控件**一个像素都不画**，模拟器不模拟它）。'
      + '每条判据一个数组 `{file,line,name,expected,actual,delta}`（+ `where`）+ `passed`（**只代表判据全满足，不代表 UI 合格**）+ `counts` + `usedConfig`；档位与**名字作用域**用 `uiConfig` 覆盖。'
      + '（判据对齐工作区 `tools/check-ui-contract.mjs`；细则见 `docs/功能详解.md` §UI 门禁。）'
      + '\n\n**典型调用**：`{"op":"inspect"}`（体检 + 看有没有被编辑器写回旧版）｜'
      + '`{"op":"read","source":"C:/Users/me/Desktop/背景图片.lua","head":60}`（只读看任意本地 .lua —— 不在沙箱里也行）｜'
      + '`{"op":"deploy","source":"D:\\\\code\\\\双相\\\\双相_v9.lua","file":"双相.lua"}`（投代码；**多脚本工程必须带 `file`**）｜'
      + '`{"op":"rects","dir":"D:\\\\code\\\\侦探1","pairs":[["ovB1","T_START"]]}`（矩形对账）｜'
      + '`{"op":"lint-ui","dir":"D:\\\\code\\\\侦探1","pairs":[["ovB1","T_START"]],"summaryOnly":true}`（UI 门禁；不传 dir = 当前关卡活文件目录）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'deploy', 'inspect', 'backups', 'backup', 'restore', 'fixbom', 'levels', 'rects', 'lint-ui'], description: '默认 inspect。⚠️ op=read 给了 source 就只读读那个文件，不读沙箱活文件；op=rects / op=lint-ui 给了 dir 就扫那个工程目录。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（如 1073741833，选的是**哪张图**；不是玩法里的第几关 —— 那个用 `stage`）；省略=当前关卡。' },
        file: {
          type: 'string',
          description: '指定活文件名（省略=该关卡最近改动的那个 .lua；**探针源码/备份这类附属文件自动跳过**）。一个关卡可以有多个活文件，拿不准先看 miliastra_health 的清单。',
        },
        source: {
          type: 'string',
          description: 'op=deploy：要投进去的本地文件绝对路径。**op=read 时也可以**（只读读那个文件）；不给就读沙箱里的活文件。'
            + '正斜杠与反斜杠都认，但**必须是绝对路径**。',
        },
        backup: {
          type: 'string',
          description: 'op=restore：要还原的备份文件绝对路径（从 op=backups 拿）。**省略 = 用固定名那份 `<原名>.bak`**。',
        },
        backupDir: {
          type: 'string',
          description: '备份目录。默认 = 活文件旁边的 `_backup\\`（备份和真身待在一起）；环境变量 MILIASTRA_BACKUP_DIR 可改到别处（一般别动）。',
        },
        noBackup: {
          type: 'boolean',
          description: 'op=deploy：跳过备份。**默认 false，正常部署请勿使用** —— 备份是这块脚本唯一的还原手段。'
            + '真要跳过必须同时传 allowNoBackup:true，且覆盖后无法还原。',
        },
        allowNoBackup: { type: 'boolean', description: 'op=deploy：确认「我知道跳过备份的后果」。仅与 noBackup:true 搭配使用。' },
        lintMode: {
          type: 'string',
          enum: ['strict', 'warn', 'off'],
          description: 'op=deploy：Lua 结构校验强度。strict（默认）=不通过就拒绝部署；warn=只带提示照投；off=不校验。',
        },
        head: { type: 'number', description: 'op=read：只返回前 N 行（默认 80，0=全文）。活文件与 source 两条路都听它。' },
        stage: {
          type: 'string',
          description: 'op=levels：**玩法里的第几关**（表里的序号或名字片段）；省略=全部关卡。⚠️ `level` = **地图关卡 ID**（哪张图，如 1073741833），`stage` = **游戏里的第几关**（如 3）。',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'op=levels / op=lint-ui：只给**数字摘要**（levels 不带每块平台坐标与分箱；lint-ui 省掉逐条 `{file,line,…}` 细节、只留计数与 `passed`）。默认 false。',
        },
        nearPx: {
          type: 'number',
          description: '近似阈值（**筛选，不是判定**）。op=levels：「近似贴上」默认 48px；op=rects：「数值近似」的逐字段容差默认 4px（差异原样给在 `delta` 里）。',
        },
        nameHint: {
          type: 'string',
          description: 'op=levels：关卡表的**变量名**（默认 `LEVELS`）。`local LEVELS = {` 与 `DATA.LEVELS = {` 两种写法都认；'
            + '抽不到表时回执里会列出 `nameCandidates`，照着它传即可。',
        },
        dir: {
          type: 'string',
          description: 'op=rects / op=lint-ui：要扫的**工程目录绝对路径**（递归找 `.lua`，跳过 `_*`/`.*` 目录与备份/历史产物，跳过了什么在 `skipped[]` 里）。'
            + '省略 = 扫**当前关卡的活文件目录**。',
        },
        pairs: {
          type: 'array',
          items: { type: 'object' },
          description: 'op=rects / op=lint-ui：**人点名的**名字对照，如 `[["ovB1","T_START"],{"a":"btnSet","b":"BTN_SET"}]` —— '
            + '画面在 view、热区在 input，两边**名字往往不同**，工具不猜语义。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'op=lint-ui：只查这几个活文件（文件名或绝对路径都行；不给就看 `dir` 里的全部 .lua）。',
        },
        uiConfig: {
          type: 'object',
          description: 'op=lint-ui：覆盖默认档位（默认 = 平台口径）—— `{grid:8, fonts:[64,52,28,22], lineHeight:1.4, slack:16}`；回执 `usedConfig` 报实际用的值。',
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
        const text = fs.readFileSync(destPath, 'utf8');
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
        // backup 可不传 = 用固定名那份（<原名>.bak）。这是「固定统一备份名」的用处：还原有确定目标。
        const r = restoreFile(args.backup || null, destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...picked, ...r,
          error: r.error || (r.errors || [])[0] || null,
          restoreWith: restoreCommand(null, destPath),
          usedFixedBackup: r.usedFixedBackup === true,
        };
      }
      if (op === 'deploy') {
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
        if (r.ok && destPath) {
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
        return {
          ...(mismatchWarning ? { warning: mismatchWarning } : {}),
          ok: r.ok, op, level: { levelId: lv.levelId }, dest: destPath, ...picked, ...r,
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
      TITLE + '：读地图存档 `<关卡ID>.gil`（protobuf，含脚本源码快照）。'
      + 'op=summary 关卡/版本/账号/脚本映射；op=clientui **客户端控件谱系**（每条控件的「控件模板索引 / 名字 / 父 / 子」）——'
      + '判断「哪些控件能被脚本动态创建」的唯一正解：**只有「无父节点」的独立控件（存为模板）才可能被 game.InstantiateClientUIControl 创建**，'
      + '画布上摆的实例、以及模板控件的子节点，一律返回 nil。'
      + 'op=script 比对地图里嵌的脚本源码与本地活文件（判断"跑的是不是本地这版代码"，并给 `belongsTo`/`isCurrent`：**`.gil` 是存盘那一刻的快照**，不是实时的）；op=strings 提取可读字符串（存盘前后 diff 用）。'
      + '\n★ **多脚本工程**：`op=script` 的 `mappings[]` 列出全部映射（含 `mappingId` / `mounted`）；`embedded` = **按名字挑中本次那一份**（`embeddedPickedBy` 说明凭什么）。\n\n**典型调用**：`{"op":"summary"}`（版本/脚本映射/模板数）｜'
      + '`{"op":"clientui","summaryOnly":true}`（先看有没有可动态创建的模板）｜`{"op":"script"}`（跑的是不是本地这版）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['summary', 'clientui', 'script', 'strings'], description: '默认 summary。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡。' },
        file: { type: 'string', description: 'op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=clientui：省掉 `records` 与 `rendered`，只留计数与「可能能动态创建的模板」。默认 false。',
        },
        path: { type: 'string', description: '直接指定 .gil 绝对路径（跳过自动定位）。' },
        limit: { type: 'number', description: 'op=strings：最多返回多少条（默认 200）。' },
        match: { type: 'string', description: 'op=strings：子串过滤。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'summary');
      const gilPath = args.path || (() => {
        const lv = resolveLevel(args.level);
        if (!lv.gil) throw new Error(`关卡 ${lv.levelId} 下没有 .gil。`);
        return lv.gil.path;
      })();
      if (op === 'strings') {
        const fs = await import('node:fs');
        const rows = extractStrings(fs.readFileSync(gilPath));
        const filtered = args.match ? rows.filter((r) => r.text.includes(String(args.match))) : rows;
        const limit = Number.isFinite(args.limit) ? args.limit : 200;
        return { ok: true, op, path: gilPath, total: rows.length, returned: Math.min(limit, filtered.length), rows: filtered.slice(0, limit) };
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
        const base = {
          ok: true, op, path: gilPath,
          level: gil.level,
          count: gil.clientUI.length,
          likelyTemplates: c.likelyTemplates,
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
            note: 'summaryOnly：省掉了 `records`（每条控件一行）与 `rendered`（谱系文字），'
              + '只留计数与「可能能动态创建的模板」。要全量就去掉 summaryOnly。',
          };
        }
        return { ...base, standalone: c.standalone, records: gil.clientUI, rendered: renderClientUI(gil) };
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
      TITLE + '：读客户端运行时日志 `.gia`。**这是运行时取证（Lua 里 print 出来的东西）的唯一入口**。'
      + 'op=sessions 列出所有日志文件（倒序，带大小/时间）；op=tail 读某个文件的结构化记录；'
      + 'op=grep 用 tag/pattern 过滤（tag 是子串，pattern 是正则）；op=tags 汇总标签（正文**开头**的 `[...]` 前缀，如 `[侦探1/view]`；没有前缀才归 `(无标签)`）；'
      + '**op=runs 按「局」切分** —— 一个 `.gia` 里可能装多局：给每局一行摘要（开跑时刻 / 记录数 / 就绪行 / 异常次数 / **命中的词**）**并和上一局做 diff**。'
      + '记录字段：time / account / player / channel / message。'
      + '\n★ **本局没有 `.gia` 时不会静默给旧数据**：回执带 `staleLog` / `logBelongsTo`（文件名 + epochSec），`staleLog:true` = **不属于本次会话**，别当本局证据。本局落没落盘看 `miliastra_playtest op=status` 的 `localGia`。'
      + '\n⚠️ **「试玩了却没有新日志」**：`.gia` 里**只有脚本自己 `print` 出来的东西** —— 最常见是压根没从编辑器开试玩，或编辑器「日志」面板里 `客户端脚本` 没勾上；'
      + '（完整排查步骤见 `docs/功能详解.md` §按局读日志。）'
      + '\n\n**典型调用**：`{"op":"runs"}`（这一局/这几局发生了什么，含局间 diff）｜'
      + '`{"op":"metrics"}`（死亡位置分布与集中区，**不用改脚本**）｜'
      + '`{"op":"tail","tag":"miliastra-code","limit":30}`（按标签读正文）｜`{"op":"tail","run":1790171162}`（只看那一局）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sessions', 'tail', 'grep', 'tags', 'runs', 'metrics'], description: '默认 tail。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用它对应的日志目录）。' },
        file: { type: 'string', description: 'op=tail/grep/runs：日志文件名或绝对路径；省略=最新那个。' },
        tag: { type: 'string', description: '正文子串过滤，例如 [P5D]、就绪、首错。' },
        pattern: { type: 'string', description: '正文正则过滤。' },
        run: {
          type: 'string',
          description: 'op=tail/grep/tags：**只看某一局**。给 epoch 秒（如 1790170177）或 instance 片段；与 miliastra_playtest 报的 epochSec 同源。',
        },
        limit: { type: 'number', description: 'op=tail/grep：几条（默认 120，**超限留最新**）；op=runs/metrics：几局/几条时间线（默认 10 / 40）；op=sessions：几个文件（默认 40）。' },
        last: {
          type: 'number',
          description: 'op=tail/grep：**只取尾部 N 条**（要看"这一局怎么结束的"用它）；顺序永远是**先过滤 → 再取尾**，返回仍按时间正序。',
        },
        from: {
          type: 'string',
          enum: ['end', 'head'],
          description: 'op=tail/grep：`end`（默认，取尾部）/ `head`（取开头）。',
        },
        evt: { type: 'string', description: 'op=metrics：只看某个事件名（严格约定的 `evt=`）。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=metrics：去掉直方图分箱，只留 `n/min/max/median/core/hotBin` 这些标量（有箱可去时 `binsOmitted` 报数量）。默认 false。',
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
      const gia = readGia(file);
      if (!gia.ok) return { ok: false, op, file, error: gia.error };
      const withMsg = gia.records.filter((r) => r.message);
      /*
       * ★ 「这份 .gia 是不是本次会话的」（反馈 A2 ②）：本局没有 `.gia` 时，这里取到的是**上一局**的文件，
       *   而在回执里它只是一行 `file` —— 子代理三次都把它当成了本局的证据。
       *   判据与 `miliastra_playtest op=status` 的 `localGia` 同源（文件里有没有本局那个 epochSec）。
       */
      const staleness = logStalenessFor(lv, file, giaRunEpochs(gia.records));
      const staleFields = Object.assign({
        staleLog: staleness.staleLog,
        logBelongsTo: staleness.logBelongsTo,
      }, staleness.staleLog ? {
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
      const slim = records.map((r) => (args.withRaw
        ? r
        : { time: r.time, account: r.account, player: r.player, channel: r.channel, message: r.message }));
      return {
        ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
        ...staleFields,
        matched: records.length, returned: slim.length,
        // 「这次是从哪一端取的、取了几条」—— 省掉「为什么我只看到开头那 N 条」这类来回
        window: {
          from: fromHead ? 'head' : 'end', last: lastN, limit, take,
          order: '返回按时间正序（最早在前）',
        },
        filter: { tag: args.tag || null, pattern: args.pattern || null },
        records: slim,
      };
    },
  },

  {
    name: 'miliastra_playtest',
    description:
      TITLE + '：**试玩开跑 / 结束的实时侦测** —— 回答「现在在不在试玩 / 开跑到第几秒了」，并支持**等下一次开跑**。'
      + '信号来自游戏客户端自己写的 Unity 日志 `output_log.txt`（每行带毫秒时间戳、持续追加）：'
      + '开跑 = `BeyondLevelPlayModule SetCurLevelData … isTrial:True`，'
      + '结束 = `StartQuickSwitchSceneAction … QuickSwitchToBeyondSettleSceneNormally`。'
      + '**实测延迟 0.07~0.18 秒**（真机：日志 21:46:02.420 写下、21:46:02.600 已读到）；'
      + '它是**平台级**标记：脚本一行都不 print、磁盘上没有 `.gia` 的局，它照样记。'
      + '⚠️ **别用 `.gia` 判开跑** —— `.gia` 不是实时的：实测那局 21:46:58 结束，`…21-46-05_157.gia` 到 **21:47:07** 才落盘；**局在跑的时候磁盘上根本没有这个文件**。'
      + 'op=status 看当前状态 + 最近几局；op=wait 等下一次开跑（`backSec` 可回扫刚过去那局，'
      + '`afterSec` 要「开跑 N 秒后」）——命中后接着调 `miliastra_shot` 截一张，就是「游戏开跑 N 秒后的画面」。op=wait 超时**不报错**，如实回 `hit:false`。'
      + '\n★ **`op=arm`（武装后台截图）**：一次调用完成**「等新局开跑 → 按秒点抓拍 → 落盘」** ——'
      + '`op=arm afterSec:[8,12,16,20] timeoutSec:300`：等**下一次**开跑（默认不回扫，避免拍到已结束的旧局），每个秒点各拍一张，'
      + '**这一局一结束就停**（剩余秒点标 `skipped`），回执逐张给路径 + `inRun`。人点完「试玩」后 AI 不用再参与。'
      + '\n★ **`op=status` 的 `localGia`**：直接回答「**本局 `.gia` 落盘了没有**」（`landed`/`missing`/`running`/`none`）——`missing` 时 `miliastra_log` 取到的是**更早那一局**，别当本局证据。'
      + '（信号来源与「试玩了却没日志」的排查见 `docs/功能详解.md` §试玩开跑侦测。）'
      + '\n\n**典型调用**：`{"op":"status"}`（现在在不在试玩 + 本局 `.gia` 落盘没有）｜'
      + '`{"op":"arm","afterSec":[8,12,16,20],"timeoutSec":300}`（等下一次开跑、按秒点各拍一张）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['status', 'wait', 'arm'], description: '默认 status。**arm = 武装后台截图**：等新局开跑后按 `afterSec` 秒点各拍一张（局结束就停），回执给每张路径 + `inRun`。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用来定位该品牌的 output_log.txt）。' },
        backSec: { type: 'number', description: 'op=wait/arm：回扫窗口秒数（默认 0）。⚠️ op=arm 回扫会命中**已结束**的旧局（拍到的是局外画面），所以默认 0。' },
        timeoutSec: { type: 'number', description: 'op=wait：最多等多少秒（默认 90，上限 300）；op=arm：默认 300（上限 3600）。' },
        /*
         * ⚠️ `afterSec` 有两种取法（op=wait 传**数字**、op=arm 传**秒点数组**），但 DSH 的工具 schema
         * **子集只收单个 `type` 字符串** —— `type: ['number','array']` 会被注册期校验直接拒掉
         * （实测报 `type arrays are not supported`；探针见 `tests/feedback3-test.mjs` 里那条断言）。
         * 所以这里用子集支持的 `oneOf`（exact-one）表达同样的能力。
         */
        afterSec: {
          oneOf: [
            { type: 'number', description: 'op=wait：命中后再等 N 秒才返回（默认 0，上限 120）。' },
            { type: 'array', items: { type: 'number' }, description: 'op=arm：**秒点数组**（默认 `[8,12,16,20]`）—— 到每个秒点各拍一张，相对**开跑时刻**算。' },
          ],
          description: 'op=wait 传**数字**（命中后再等 N 秒才返回）；**op=arm 传秒点数组**（如 `[8,12,16,20]`，最多 12 个，到每个秒点各拍一张）。',
        },
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
          note: '开跑/结束读的是 output_log.txt（实时）。`.gia` 是**这一局结束之后**才落盘的，'
            + '所以「本局的运行时日志」要等局结束才有 —— 局中要看画面对不对只能截图。'
            + '`localGia` 直接回答「本局的 `.gia` 到底有没有」；未落盘时 `miliastra_log` 取到的是**更早的某一局**。',
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
      TITLE + '：截图 —— 把「现在画面上是什么」变成一张 PNG。'
      + '日志（miliastra_log）能回答「代码跑了没、print 了什么」，回答不了「画面对不对」（控件挂上了没、位置歪没歪、颜色对不对）；这一环靠它。'
      + 'op=capture（默认）立刻截一张，目标 `target=game`（原神客户端，默认）/ `editor`（千星沙箱），也可用 `process` 指定任意进程名；op=list 看截到哪去了、有多少张、占多大；op=clean 清理，**默认只报告不删**。'
      + '**截图存在插件的数据目录**（默认 `~/.dsh/miliastra/shots`，`MILIASTRA_DATA_DIR` 可整体覆盖）—— 既不放在游戏存档目录，也不放在包目录（插件升级会整个替换掉它）。'
      + '**不会自动删**：清理要显式给条件（`all` / `olderThanDays`），真删还要 `confirm:true`。'
      + '回执恒带 `pid / process / title` + **候选窗口清单**（同进程多窗口时逐条给标题/尺寸/是否最小化，并标出选中哪个）—— **截到的到底是哪个窗口**必须看得见。'
      + '`suspect` 只在**判得出来**时给：进程名对不上 / `target=game` 而标题像编辑器 / 全黑 / 单色 / 屏抓却不在前台 —— **画面内容本工具不识别**，图对不对最终要看图。'
      + '\n★ **连拍每张约 2.6~3.5 秒**（回执的 `measuredIntervalMs` 是实测值，`burstMs` 给再小也无效）。'
      + '**短局（< 20 秒）别用「等 8 秒再连拍 4 张」**（4 张会全落局外）：用 '
      + '`op=burst awaitPlaytest:true startAfterSec:<小值> untilGone:true`（命中就开拍、局一结束就停，逐张标 `inRun`），或 `miliastra_playtest op=arm`。'
      + '（**选窗规则 / 缩略图 / 连拍时序的完整说明见 `docs/功能详解.md` §截图**。）'
      + '\n\n**典型调用**：`{"op":"capture","target":"game"}`（现在截一张）｜'
      + '`{"op":"burst","awaitPlaytest":true,"startAfterSec":1,"untilGone":true,"count":20}`（短局：命中就拍、局结束就停，逐张给 `inRun`）｜'
      + '`{"op":"burst","dryRun":true}`（先看要多久、拍几张）',
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
        window: {
          type: 'string',
          description: '按窗口标题子串挑窗口。**一个进程往往有多个窗口**（实测 BeyondEditor 同时有 900×800 的日志窗和 160×28 的最小化残片）—— 默认取**面积最大**的。',
        },
        label: { type: 'string', description: '文件名里的标签，如「试玩第1局」「控件对齐」（允许中文；非法字符会被清掉）。' },
        level: { type: 'string', description: 'op=burst（配合 awaitPlaytest）：关卡 ID / 品牌；省略=当前关卡（用来定位该品牌的 output_log.txt）。' },
        dir: { type: 'string', description: '覆盖截图目录（默认插件数据目录下的 shots\\）。' },
        keepLast: { type: 'number', description: 'op=clean：至少保留最新的 N 张（保护网，任何模式下都生效）。' },
        olderThanDays: { type: 'number', description: 'op=clean：只删比这个更旧的（>0 才生效）。' },
        all: { type: 'boolean', description: 'op=clean：不管新旧，除 keepLast 外全删。' },
        dryRun: { type: 'boolean', description: 'op=clean：默认 true（只报告将删哪些）。' },
        confirm: { type: 'boolean', description: 'op=clean：真删必须再传 confirm:true。' },
        bringToFront: { type: 'boolean', description: '默认 true：抓不到时把目标窗口拉到前台再抓。' },
        keepWindowOnTop: { type: 'boolean', description: '默认 false：退回屏幕抓取时临时把目标窗口置顶。' },
        count: { type: 'number', description: 'op=burst：连拍几张（默认 5，上限 20）。' },
        burstMs: {
          type: 'number',
          description: 'op=burst：两张之间的**额外等待**毫秒（默认 800；<800 夹到 800 并标 `clamped`）。⚠️ **不是「每 N 毫秒一张」** —— 真实帧距看 `measuredIntervalMs`。',
        },
        awaitPlaytest: {
          type: 'boolean',
          description: 'op=burst：**默认 false（立刻开拍）**；true = 「等开跑 → 再等 afterSec 秒 → 连拍」**一次调用完成**（与 `miliastra_playtest op=wait` 同一份判据）。',
        },
        afterSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：命中开跑后等 N 秒才开拍（默认 0，上限 120）。⚠️ 短局改用 startAfterSec + untilGone。' },
        startAfterSec: {
          type: 'number',
          description: 'op=burst：命中开跑后等 N 秒**立刻开拍**（默认 = afterSec）—— 短局给小值，配 `untilGone:true`。',
        },
        untilGone: {
          type: 'boolean',
          description: 'op=burst：**拍到这一局结束就自动停**（默认 false），剩余张数不再拍。',
        },
        timeoutSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：等开跑最多多少秒（默认 90，上限 300）。' },
        backSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：回扫窗口秒数（默认 0）。⚠️ 回扫命中的局**可能已结束** —— 那些图标 `inRun:false`。' },
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
        const base = {
          op, dir, before: { count: s.count, totalBytes: s.totalBytes, totalText: humanSize(s.totalBytes) },
          planned: plan.delete.map((f) => ({ name: f.name, sizeText: humanSize(f.size), mtime: f.mtime })),
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
          removed: res.removed.map((p) => pathBasenameOf(p)),
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
        const plan = planBurst({ count: args.count, intervalMs: args.burstMs });
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
      TITLE + '：探针 —— **「问游戏一句」的工具**。'
      + '探针是一段临时替掉活文件的小程序，只在试玩那几秒跑一次，把游戏内部信息打到日志里。'
      + '为什么需要它：有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举到底叫什么名），必须让游戏真跑一遍才知道。'
      + '**代价**：部署会**临时覆盖活文件**，所以试玩那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。'
      + '**四步**：① op=deploy template=<名字> → ② 在编辑器里**重新**试玩一局（不会热加载）→ '
      + '③ op=collect 收回结论 → ④ 用 miliastra_code op=restore 还原你的脚本。'
      + `**${PROBE_TEMPLATE_CHOICES.length} 个模板**：`
      + PROBE_TEMPLATE_CHOICES.join(' / ') + '（**别猜**：每个模板"能答什么问题"用 `op=list` 看 `info[]`）。'
      + '另：op=render 只生成 Lua 不部署（要先看代码用这个；给了 saveTo 才落盘）。探针只读，不做场景写操作。'
      + '★ **`template:"custom"`**：现成模板答不了的问题（OnInit/OnEnable 期能不能创建控件、锚点是不是归一化 0..1…），用 `lua` 传一段**完整 Lua** 当正文 ——'
      + '它走**同一条流水线**（render → 人部署 → 试玩 → collect → `miliastra_code op=restore` 还原），部署前照样**先备份活文件**，正文还会先过一遍**结构校验**（缺 end / 括号不配平直接拒绝渲染）。'
      + '它**不给探针任何新能力**：仍然只能 print + 只读 API。（细则见 `docs/功能详解.md` §探针。）'
      + '\n\n**典型调用**：`{"op":"deploy","template":"ping"}` → 人重新试玩 → `{"op":"collect","tag":"P1"}` → '
      + '**还原**：`miliastra_code {"op":"restore"}`（不传 backup 就是用固定名那份）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'render', 'deploy', 'collect'], description: '默认 list。' },
        template: {
          type: 'string',
          enum: PROBE_TEMPLATE_CHOICES,
          description: '模板名（清单与每个模板的大白话说明见工具说明；怕选错先 op=list）。⚠️ `custom` 必须再给 `lua`（正文），其余模板都不用。',
        },
        lua: {
          type: 'string',
          description: '**只有 template:"custom" 用**：探针正文，一段**完整 Lua**（建议定义 `function run()` —— 探针会在试玩起来后第 3 帧调它；也能自己在 OnStart/OnUpdate 里输出）。'
            + '正文里只做两件事：print + 只读 API（**不写地图 / 不写存档**）。缺 end / 括号不配平 / 字符串没闭合会被**拒绝渲染**并指出哪里不合法。',
        },
        tag: { type: 'string', description: '日志标签（默认 PROBE）。collect 时用它过滤。' },
        level: { type: 'string', description: '关卡；省略=当前关卡。' },
        file: { type: 'string', description: 'op=deploy：要替换哪个活文件（一个关卡可能有多个 .lua；省略=自动选）。' },
        ids: { type: 'array', items: { type: 'number' }, description: 'instantiate：额外的候选控件模板索引。' },
        from: { type: 'number', description: 'instantiate：兜底扫描下界（默认 1073741824）。' },
        to: { type: 'number', description: 'instantiate：兜底扫描上界（默认 1073741900）。' },
        saveTo: { type: 'string', description: 'render/deploy：把生成的 Lua 另存到这个绝对路径。' },
        lintMode: {
          type: 'string',
          enum: ['strict', 'warn', 'off'],
          description: 'op=deploy：Lua 结构校验强度（默认 strict）。探针模板都是本插件生成的，正常不会挂；报错说明模板本身有 bug。',
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
      const r = renderProbe(args.template || 'tree', { tag: args.tag, ids: args.ids, from: args.from, to: args.to, lua: args.lua });
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
         * ⚠️ 探针源码**绝不能写进活文件目录**（`external_lua_file`）。
         *    踩过：以前写在那里（`_探针_xxx.lua`），而「当前活文件」是按 mtime 最新的那个 → 探针文件成了「当前文件」，
         *    之后任何不带 file 的操作（体检/备份/部署/还原）都会打到探针上。
         *    现在写到**备份目录**里：紧挨着被替换的文件（作者要求「写到被替换的文件旁边」），
         *    又不会被当成活文件。`pickLuaFile` / `chooseLua` 另有名字护栏。
         */
        const probeDir = defaultBackupDir(dest, args.backupDir);
        const probeSrc = args.saveTo || (probeDir + '\\_探针_' + r.template + '_' + r.tag + '_' + stamp + '.lua');
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
            ? '⚠️ 现在活文件是探针，**你的玩法这一局不会跑**。去编辑器里「停止试玩 → 重新试玩一局」（不会热加载），'
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
      '内置**千星模拟器**（引擎吸收自 miliastra-beyond-simulator，GPL-3.0-only）：在游戏之外搭界面、跑 levelScript、出画面 PNG。'
      + '\n**定位：真机试玩之前的「预测试」** —— 在游戏外先用**同一套 Lua 与控件语义**拦掉可自动判定的问题（脚本跑没跑 / 控件建没建·建了几个 / 变量与信号 / 布局 / 动画）；'
      + '拦不下官方素材、真机渲染、联机、手感 ⇒ **模拟器通过 ≠ 真机通过**，真机那一步仍要人点试玩。'
      + '\n三档共用同一份工程与同一个会话：①静态预览（`state`/`controls`/`shot`）②交互试玩（`play`/浏览器页 `/miliastra/play`）③确定性判定（`verify`/`cases`/`fromHistory`/`frames`，冻结时钟、可复现）。'
      + '\n★ **AI 自测逻辑主用 `op=verify`**：一次调用 = 操作 + 断言 + 判定（引擎开全新会话**确定性重放**，可重复）；`cases:[…]` 一组一次跑。'
      + '\n  · `steps[]` / `expect[]` 的**完整形状**（八个 kind、`absent:true`、每个字段）见下面的 `steps`/`expect` 参数；'
      + '细则与范例见 `docs/模拟器与视图.md` §4.6；断言字段写错会当**参数错**报出来，不是断言没过。'
      + '\n  · 回 `passed` / `failedAt` / `results[]` / `snapshot.logs`；没过给 `hint` + 失败点取证 `shot`（一帧 PNG）。'
      + '\n  · `runtime.controlNames` = **运行时**控件名（工程树里没有的就是脚本动态建的）；不要取证传 `shotOnFail:false`。'
      + '\n  · `fromHistory:true` 把「刚跑过那一局」（含人在试玩页里玩的）变成用例；回放会重开会话，`keepRunning:true` 保留会话接着玩。'
      + '\n  · `lua` 断言**只看报不报错**（返回值被忽略 —— 要"不成立就失败"得自己 `assert(false,"…")`）。'
      + '\n★ **交接值先 `op=handover`**：活文件 + 候选交接值 + `suggestedTemplates`（也可带 `source` **只读**读任意本地 .lua）。'
      + '\n★ **guid / containerId 优先自动拿，拿不到才问创作者（不许编）**：① handover 抽 → ② `miliastra_map op=clientui` 读 → ③ 才问人；抄错一位 ⇒ 脚本静默什么都不建。'
      + '\n★ **真机工程搬进来用 `op=bind`**：`source` + `templates:[{guid,kind,name?}]` + `containerId`；`kind` 拿不准传 `"auto"`；默认起一次会话回 `run.logs` 与 `run.controlCount`。'
      + '\n★ **验收单 `op=cases`**（工作区 `cases.json`）：`add/run/list/show/remove`；`manual:true, note:"人要看什么"` 存**人工项**（`autoPassed` **不等于**验收通过）。'
      + '\n★ 其它 op：`controls`（写断言前先看它；`runtime:true` 看运行中会话、`geom:true` 给坐标/尺寸/文字）｜`state`｜`patch`（字段白名单）｜`play`｜`keys`｜`shot`｜`export`/`import`/`load`/`save`/`reset`。'
      + '\n  · `keys` 从**你的脚本源码**扫按键名（**两路**：`KeyEventType.X` 与**裸字符串**；`found[].via` 标来源，`string-literal` 是启发式）。'
      + '\n  · **动画/动效类用 `op=frames`**：每点一张 PNG + 帧间像素差 + 字段级 `changedControls`（内部暂停+单步 ⇒ 可复现）。'
      + '\n  · **人想自己上手玩**：`GET /miliastra/play`（真能玩，与面板/AI 共用同一会话）；不关会话就能 `fromHistory`。'
      + '\n★ **AI 自己"玩"的量级**：发一次输入 ≈ **5ms**（纯注入）、读一次 `get{view:true}` ≈ **200ms**、出一张 PNG 秒级（⇒ 眼睛 ≈5Hz）。'
      + '\n★ **画面上的字不用截屏就能读**：**`op=hud`** 只回 `textbox.text`（HUD/分数/关卡），拿它当闭环条件。'
      + '\n★ **记不住 `play` 的请求形状就别翻源码**：`op=keys` 回执带 **`press`**（可直接照抄的请求体，指针**左下原点**）；传 `all:true` 给全量 **164** 个键名。'
      + '\n  ⚠️ **按了 `…Down` 就要配对发 `…Up`**，否则等于**一直按住**这个键（实测把角色一路推到掉出边界重生）。'
      + '\n⚠️ `frame` **不是秒表**：连续注入按键会顺带推帧（静置 30fps、注入期间 41.7/s），要计时用 `time`。⚠️ 用户 Lua 跑在**可终止的 Worker**（默认 8 秒超时 terminate）。'
      + '\n★ **PNG 里有脚本建的客户端控件**：`InstantiateClientUIControl` 建的（含子控件）**都会画进图**；只有客户端控件模板工程**自己那棵树**不在。仍是**离线渲染** ⇒ 视觉终验看真机。'
      + '\n★ **Z 序（谁压谁）**：模拟器**按 sibling 顺序画**（越靠前越上层）；⚠️ `op=patch add` 是**追加** ⇒ 新控件落在**最底层**（真机脚本则是**后建的在上**）。**不覆盖**跨父级叠序 / 官方素材层序 / 真机渲染管线。'
      + '\n★ 模拟器**不模拟**真机「文本框高不够 ⇒ 一个像素都不画」的截断 —— 那条离线判据在 `miliastra_code op=lint-ui`。'
      + '\n★ **`op=patch` 每个 op 有字段白名单，传错名会报错点名**（`add` 收 `text`；`set` 要 `{op,id,key,value}`；`addScript` 缺源码明确拒绝）。\n\n**典型调用**：把真机工程搬进来：`{"op":"bind","source":"D:\\\\…\\\\external_lua_file\\\\双相.lua","templates":[{"guid":1073741868,"kind":"image"}],"containerId":1073741866}`；'
      + '控件类型拿不准：`{"op":"bind","templates":[{"guid":1073741867,"kind":"auto"}]}`；'
      + '自测一条规则：`{"op":"verify","steps":[{"key":"KeyboardCraftspersonKey3Down"}],"expect":[{"kind":"log","contains":"GOT_KEY_3"}]}`；'
      + '写断言前先看控件：`{"op":"controls","namedOnly":true}`；证明动画在动：`{"op":"frames","frames":[0,0.5,1]}`；'
      + '看画面：`{"op":"play","action":"start"}` → `{"op":"shot","target":"play"}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['controls', 'hud', 'state', 'patch', 'handover', 'bind', 'play', 'verify', 'cases', 'frames', 'shot', 'keys', 'export', 'import', 'load', 'save', 'reset'], description: '默认 state。**AI 自测用 verify**；交接值 handover；真机工程 bind；验收单 cases；动画 frames；**读画面上的字用 hud**；写断言前看控件用 controls。' },
        /*
         * ⚠️ 这个 `all` **同时服务两个 op** —— 写成两个键会**静默覆盖**（JS 对象字面量后者胜），
         * 于是其中一个说明永远不会到达 AI（2026-09-24 被 ESLint 的 `no-dupe-keys` 抓到，见 `tools/lint.mjs`）。
         */
        all: { type: 'boolean', description: 'op=keys：给**全量键名**（164 项）；op=cases action=remove：删掉整个用例集（仍要 confirm:true）。' },
        steps: { type: 'array', description: 'op=verify 的操作序列；每步 {key, click{x,y}（**左下原点**）, clickName, drag{from,to}, pointer, setVar, sendSignal, at?, after?, pause, resume}（全形状见 docs/模拟器与视图.md §4.6）。', items: { type: 'object' } },
        expect: { type: 'array', description: 'op=verify 的断言；每项 {kind, at?, …}，kind 八种：log/control/var/signal/tree/count（**建了几个** —— 动态 UI 只能用它数）/controlAbsent/lua。`absent:true` = **不该存在**；未知字段按**参数错**报出（字段全形状见 docs/模拟器与视图.md §4.6）。', items: { type: 'object' } },
        cases: { type: 'array', description: 'op=verify 的**多用例**：每项 {name, steps, expect}（各自独立重放）；op=cases action=add 用它一次存多条。', items: { type: 'object' } },
        fromHistory: { type: 'boolean', description: 'op=verify：用**刚跑过那一局**的事件当用例（浏览器试玩页里玩的也算）。需要会话活着；回放会重开会话。' },
        frames: { type: 'array', description: 'op=frames 的时间点（模拟秒，升序，最多 12 个），如 [0,0.5,1]：每点一张 PNG + 帧间像素差 + 字段级变化。', items: { type: 'number' } },
        diff: { type: 'boolean', description: 'op=frames：是否比帧间像素差（默认 true）。false = 只出帧、不解码。' },
        threshold: { type: 'number', description: 'op=frames：像素算「变了」的每通道差值阈值，默认 8。' },
        shotOnFail: { type: 'boolean', description: 'op=verify：没过时自动存一帧失败点 PNG 并回 `shot`（默认 true）。' },
        stopOnFail: { type: 'boolean', description: 'op=verify 配 cases：第一个没过就停（默认 false = 跑完全部，回归语义）。' },
        keepRunning: { type: 'boolean', description: 'op=verify：判定后不停会话（默认停），便于接着 op=play；失败取证会把会话暂停，续玩先 action=resume。' },
        dt: { type: 'number', description: 'op=verify：重放的每步时长（秒）。省略用引擎默认。' },
        runtime: { type: 'boolean', description: 'op=controls：看**运行中**会话的控件树（脚本动态建的），需先 op=play start；省略=看工程树。' },
        geom: { type: 'boolean', description: 'op=controls 配 runtime:true：再带**世界坐标 `x/y` + 源尺寸 `w/h` + `text`**（左下原点，可直接喂 pointer/click）。' },
        namedOnly: { type: 'boolean', description: 'op=controls：只列有名字的控件（只有它们能按 name 断言）。' },
        nameContains: { type: 'string', description: 'op=controls：按名字子串过滤（Host 侧过滤，中文可用）。' },
        kind: { type: 'string', description: 'op=controls：按类型过滤（container / textbox / button / image …）。⚠️ op=bind 的模板类型在 `templates[].kind`。' },
        maxDepth: { type: 'number', description: 'op=controls：只列到第几层（0=根）。' },
        limit: { type: 'number', description: 'op=controls：最多回多少条，默认 200（截了多少看 `omitted`）。' },
        summaryOnly: { type: 'boolean', description: '只去体积不去结论（默认 true：state 不回 boxes 与 tree 全量）。' },
        treeLimit: { type: 'number', description: 'op=state 在 summaryOnly 下最多回多少条控件树（默认 200）。' },
        patch: { type: 'object', description: 'op=patch 的编辑操作，如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题","text":"…"}；数据写要带 expectedRevision；`set` 要 {op,id,key,value}；脚本类 addScript/updateScript/removeScript。**每个 op 只认自己的字段**。' },
        action: { type: 'string', description: 'op=play 的动作：start/device/view/get/step/pointer/key/click/pause/resume/stop/serverGet/serverSet/serverSend。**click 给 args.x/y = 坐标；给 args.name = 控件名。**' },
        args: { type: 'object', description: 'op=play 的参数，如 {"x":640,"y":360} / {"dt":0.033} / {"type":"click","x":640,"y":360}。' },
        target: { type: 'string', enum: ['ui', 'play'], description: 'op=shot 取景：ui=编辑器视图（静态），play=试玩画面（需先 start）。' },
        label: { type: 'string', description: 'op=shot 的文件名标签（便于事后认图）。' },
        reuse: { type: 'boolean', description: 'op=shot 连帧用：固定名覆盖写、只留当前帧；不传 = 每张新建文件。' },
        format: { type: 'string', description: 'op=export / op=import 的格式：gia（默认）/ gia-combined / json / save / scripts / lua。' },
        assetType: { type: 'string', description: 'op=export 的资产类型过滤（如 server-control-template / client-control-template）。' },
        file: { type: 'string', description: 'op=import 要导入的文件绝对路径。' },
        archive: { type: 'string', description: 'op=load 的存档相对路径；省略=列出工作区里的存档。' },
        path: { type: 'string', description: 'op=save 的存档文件名（默认 qxqy-simulator.save.json）。' },
        source: { type: 'string', description: 'op=bind / op=handover：一个 .lua 的**绝对路径**（handover **只读**；>8 MB / 二进制 / 相对路径拒绝）。bind 给真机**活文件** .lua（别写死路径）。' },
        scripts: {
          type: 'array',
          items: { type: 'object' },
          description: 'op=bind：**一次挂多个脚本** `[{path, source|sourceFrom}]`；给了它就不看顶层 `source`。',
        },
        templates: { type: 'array', description: 'op=bind：控件模板清单 `[{guid,kind,name?}]`。`guid` = 客户端控件模板索引（优先自动拿、**不许编**）；`kind` = image/textbox/button/container… 或 `"auto"`；缺值报错。', items: { type: 'object' } },
        containerId: { type: 'number', description: 'op=bind：创作者交接的**容器节点索引**（只记录 + 与源码交叉核对 `handover.containerIdInSource`）。' },
        scriptName: { type: 'string', description: 'op=bind：挂载名（= 脚本 `script.path`，缺省用文件名含 .lua）。⚠️ 有些脚本用它自查挂载名，名字不对会自己退出。' },
        mountTo: { type: 'string', description: 'op=bind：脚本挂在哪个控件（id 或名字；缺省=服务端容器节点）。' },
        fresh: { type: 'boolean', description: 'op=bind：默认 true = 先把资产重置成出厂工程、清掉已有脚本再重建；false = 追加。' },
        last: { type: 'boolean', description: 'op=bind：用**上次那份配方**重搭（重启 `dsh web` 后回到出厂默认 —— 这就是"一键回来"）。配方记在 `last-bind.json`。' },
        keepFactory: { type: 'boolean', description: 'op=bind：保留出厂橱窗控件（默认 false 清掉 —— 留着会混进渲染与控件清单）。' },
        run: { type: 'boolean', description: 'op=bind：默认 true = 搭完顺手起一次会话，回 `run.logs` 与 `run.controlCount`；false = 只搭不跑。' },
        settleSec: { type: 'number', description: 'op=bind：起完会话先让时钟走几秒再读（默认 0.5，上限 3）—— 停在 frame 0 会把「建了 31 个」读成 1。' },
        saveAs: { type: 'string', description: 'op=bind：把工程存进工作区（缺省名 bind-<脚本名>.save.json）。' },
        script: { type: 'object', description: 'op=bind：直接用源码代替读文件：`{path:"双相.lua", source:"…"}`。' },
        caseSet: { type: 'string', description: 'op=verify：直接跑 `op=cases` 里存的那一组；人工项不代跑，只列在 `manual[]`。' },
        set: { type: 'string', description: 'op=cases：用例集的名字（建议「玩法-关卡」，如 双相-第1关）。' },
        case: { type: 'string', description: 'op=cases action=remove：要删的用例名（不给 = 删整组，仍要 confirm:true）。' },
        confirm: { type: 'boolean', description: 'op=cases action=remove：删除不可恢复，必须显式 confirm:true 才真删（不传只回 dryRun）。' },
        manual: { type: 'boolean', description: '存用例时标**人工项**（配合 note）—— 工具不代跑也不代判，只在 run 的 `manual[]` 里等人打勾。' },
        note: { type: 'string', description: '用例/人工项的说明：人工项必填「人要看什么、看到什么算过」。' },
        name: { type: 'string', description: 'op=bind：存档名；op=cases：set 的别名（manual 项缺省取 note 前 20 字）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      return await simOp(args, {});
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
  const rawPoints = Array.isArray(args.afterSec) ? args.afterSec : null;
  const points = [...new Set((rawPoints && rawPoints.length ? rawPoints : [8, 12, 16, 20])
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x) && x >= 0 && x <= 600))]
    .sort((a, b) => a - b)
    .slice(0, 12);
  if (!points.length) throw new Error('op=arm 的 `afterSec` 至少要有一个 0~600 的秒点，例如 afterSec:[8,12,16,20]');
  if (!processName) throw new Error('op=arm 没给出要截哪个进程（target/process 都是空的）。');

  const w = await waitForPlaytestStart(lv, {
    timeoutSec,
    // ⚠️ 默认**不回扫**：`backSec` 回扫会命中「已经结束的旧局」，那正是这个工具要消灭的坑之一
    backSec: clampNum(args.backSec, 0, 0, 3600),
    pollMs: clampNum(args.pollMs, 400, 100, 5000),
  });
  const baseOut = {
    ok: true, op: 'arm', level: { brand: lv.brand, levelId: lv.levelId },
    target: targetKey, process: processName, dir,
    points, timeoutSec, waitedSec: w.waitedSec,
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
      + '本局的运行时日志（`.gia`）要等这一局结束**再等约 10 秒**才落盘 —— 看 `localGia`；'
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
        const body = Buffer.from(playPageSource(html, playPageStamp(st)), 'utf8');
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
         */
        sendJson(res, 200, { ok: true, data: lossless(await simOp(engineArgsFromBody(body), {})) });
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
