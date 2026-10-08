/**
 * **工具之间共享**的解析/判定函数（阶段 3 拆文件：从 `index.js` 机械搬移，行为零改动）。
 *
 * 为什么单开一个模块：这些符号被**多个**工具用到（`resolveLevel` 实测被 11 处引用），
 * 搬进任何一个 `lib/tools/<tool>.mjs` 都会让别的工具**反向 import 那个工具** ⇒ 循环依赖 + TDZ 风险。
 *
 * `index.js` 对它们**再导出**，因此外部既有引用（测试 / 面板）不受影响。
 */
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { VERSION } from './constants.mjs';
import { createPlaytestState, playtestLogPath, playtestSummary, readIncrement, reduceLogLines, scanLog, shouldHit } from './playtest.mjs';
import { fileURLToPath } from 'node:url';
import { findLevel, localLowRoot, pickCurrent, scanLevels } from './locate.mjs';
import { inspect, pickLuaFile, rankLuaFiles } from './codefile.mjs';
import { readGil } from './gil.mjs';





export function resolveLevel(q) {
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

export function classifyControls(clientUI) {
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

export const CLIENT_CONTROL_NAME = /^(容器节点|文本框|文本视窗|图片|界面动效|全屏界面动效|预设按钮|按键提示|光标检测区域|网格视窗|模板引用控件)$/;

export const STRUCTURAL_NAME = /客户端控件容器|布局|HierarchyRoot|小地图|技能区|队伍信息|生命值条|摇杆|退出按钮|语音|选项卡|聊天按钮|网络状态|挣扎按钮|提示队列/;

export function hostSummary() {
  const info = sourceInfo();
  return {
    version: VERSION,
    startedAt: new Date(STARTED_AT).toISOString(),
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    source: { ...info, ...hostStaleness({ ...info, loadedVersion: VERSION, startedAtMs: STARTED_AT }) },
  };
}

export function sourceInfo() {
  try {
    const dir = pathMod.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fsMod.readFileSync(pathMod.join(dir, 'package.json'), 'utf8'));
    const st = fsMod.statSync(pathMod.join(dir, 'index.js'));
    return { sourceVersion: pkg.version, sourceMtimeMs: st.mtimeMs, sourceMtime: new Date(st.mtimeMs).toISOString() };
  } catch (e) {
    return { sourceVersion: null, sourceMtimeMs: null, error: (e && e.message) || String(e) };
  }
}

export const STARTED_AT = Date.now();

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
export const chooseLua = (lv, name) => {
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
 * 一个关卡的地图脚本信息：`{ok, mappings, allNames, mountedNames, mountedIds, mountKnown, mountSource}`。
 * `allNames` 用于**挑活文件**（宁多勿漏）；`mountedNames` + `mountKnown` 用于**判挂载**（宁缺勿假）。
 */
export function gilScriptInfo(lv) {
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
/** 回执里最多列多少条矩形（`summaryOnly` 时更多信息被折叠）。 */
/*
 * ★ E8（2026-09-29 实战反馈）：`mountedOn` 是「存档里离这条挂载记录最近的那层 `#1` 字符串」——
 *   它可能是**占位名**（如 `未分类页签`）⇒ 既不能证实、也不能证伪「挂在客户端控件容器的容器节点上」；
 *   从没在编辑器里挂过时恒为 null。⇒ 把这层边界写进回执，别让人拿它当判据。
 */
export const MOUNTED_ON_NOTE = '`mountedOn` = 存档里「离这条挂载记录最近的那层 #1 字符串」（挂载归属名）。'
  + '⚠️ 边界：① 可能是占位名（如 `未分类页签`）⇒ **既不能证实也不能证伪**「挂在客户端控件容器的容器节点上」；'
  + '② 从没在编辑器里挂过 ⇒ 恒为 null。真机硬要求是「挂客户容器的容器节点」，这条只能当**线索**，以编辑器里的挂载点为准。';
/** 数值参数取值：非数字给默认，超出区间夹住（不静默接受离谱值）。 */
export function clampNum(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 等「试玩开跑」—— `miliastra_playtest op=wait` 与 `miliastra_shot op=burst awaitPlaytest:true` **共用这一份**。
 *
 * 抽出来的理由不是为了少写几行，而是**判据只能有一份**：
 * 两条路各写一套「怎样算开跑」，早晚会漂移，而「漂移过的判据」比没有判据更坏（会让人信错的那个）。
 */
export async function waitForPlaytestStart(lv, { timeoutSec = 90, backSec = 0, pollMs = 400 } = {}) {
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
export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'HttpError'; this.status = status; }
}
/** 取路径最后一段（回执里要报「是哪个活文件」，用的就是它）。 */
export const pathBasenameOf = (p) => String(p || '').split(/[\\/]/).pop();
export const PREFIX = '/miliastra';
/**
 * 「这次用的是哪个活文件、凭什么」—— 每个 op 的公开回执都带上它（`pickedBy` / `candidates`）。
 * 纯展示；**不含 undefined**（`smoke` 与宿主都会拒收含 undefined 的结果）。
 */
export function pickedFields(pick) {
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

export function mountedScriptNames(lv) {
  return gilScriptInfo(lv).allNames;
}

export const gilScriptCache = new Map();
