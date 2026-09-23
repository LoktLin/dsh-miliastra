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
const VERSION = '0.0.11';
const TITLE = 'Miliastra Wonderland 工具链';
const STARTED_AT = Date.now();

import fsMod from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLevels, pickCurrent, findLevel, localLowRoot } from './lib/locate.mjs';
import { inspect, deploy as deployFile, pickLuaFile, defaultBackupDir, backupFile, listBackups, restore as restoreFile, restoreCommand, stripBomFile, writeDeployFingerprint, readDeployFingerprint, fingerprintDelta, DEPLOY_FINGERPRINT_NAME } from './lib/codefile.mjs';
import { readGil, renderClientUI, extractStrings } from './lib/gil.mjs';
import { readGia, listGia, filterRecords, groupRuns, playRunsOf, summarizeRuns, compareRuns } from './lib/gia.mjs';
import {
  playtestLogPath, scanLog, readIncrement, reduceLogLines, createPlaytestState,
  playtestSummary, shouldHit,
} from './lib/playtest.mjs';
import { PROBE_TEMPLATES, PROBE_INFO, PROBE_OVERVIEW, renderProbe } from './lib/probes.mjs';
import { extractLevelTable, describeLevels, findCanvas, levelSummary } from './lib/leveldata.mjs';
import { collectMetrics, summarizeMil, summarizeLoose, metricsTimeline, conventionHint, slimMil, slimLoose } from './lib/metrics.mjs';
import { clientProcesses } from './lib/proc.mjs';
import { simOp, disposeSimAll, simRuntimeInfo } from './lib/sim.mjs';
import {
  SHOT_TARGETS, shotsDir, dataRoot, listShots, planClean, removeShots, captureWindow,
  shotFileName, nextFreeName, sanitizeLabel, humanSize, judgeCapture,
  thumbPathFor, resolveShotFile, ensureThumbnail,
  planBurst, burstSummary, BURST_FLOOR_MS, BURST_MAX_COUNT,
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
    if (!gil.script) {
      return {
        ok: false, gilPath: lv.gil.path,
        reason: '地图里没有脚本映射记录 —— 说明编辑器还没把脚本挂到这个关卡上（或没存盘）',
      };
    }
    const cur = inspect(livePath);
    const match = gil.script.sourceSha256 === cur.sha256;
    return {
      ok: true, gilPath: lv.gil.path,
      match,
      embeddedSha256: gil.script.sourceSha256,
      liveSha256: cur.sha256,
      embeddedBytes: gil.script.sourceBytes,
      liveBytes: cur.size,
      conclusion: match
        ? '地图里嵌的脚本 == 刚部署的活文件 → **可以试玩了**（记得停掉上一局再重开）'
        : '⚠️ 地图里嵌的**还是旧版**（编辑器未重新加载 / 未存盘）→ **先别急着试玩**：'
          + '在编辑器里存一次盘，或确认脚本面板已经是新版',
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/** 供本地自测脚本读取（cordis 只认 name / inject / apply，多导出无害）。 */
export { TOOLS };

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
 * 选一个活文件。
 *
 * ⚠️ **一个关卡可以有多个 `.lua`**（不同角色 / 不同模块各挂一个客户端脚本）——
 * 所以「哪个是当前文件」必须**显式**，不能靠猜：
 *   · 给了 `name` → 精确匹配；找不到就**抛错并列出全部**，绝不悄悄换一个
 *   · 没给 → 优先名字里带常见关键词的，再退到列表第一个
 * `miliastra_health` 会把**全部**活文件列出来，供调用方挑选。
 */
const pathBasenameOf = (p) => String(p || '').split(/[\\/]/).pop();

const chooseLua = (lv, name) => {
  if (!lv || !lv.luaFiles.length) return null;
  if (name) {
    const hit = lv.luaFiles.find((f) => f.name === name);
    if (!hit) {
      throw new Error(`关卡 ${lv.levelId} 下没有活文件 "${name}"。现有：${lv.luaFiles.map((f) => f.name).join('、')}`);
    }
    return hit;
  }
  // ⚠️ 兜底「最近改动」时必须**跳过附属文件**（探针源码 / 备份）：
  //    早期探针部署会把 `_探针_xxx.lua` 写进活文件目录，而它是最新的 mtime，
  //    于是后续不带 file 的操作全都打到了探针上 —— 等于在错的文件上做备份/部署/还原。
  const real = lv.luaFiles.filter((f) => !f.auxiliary);
  return real.find((f) => /双相|测试|main|levelScript/i.test(f.name))
    || real.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0]   // 兜底取**最近改动**的那个，而不是文件名排序第一个
    || null;
};

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
  { tool: 'miliastra_code', when: '改完本地 lua 用 op=deploy 投进沙箱（自动备份 + SHA 校验 + 无 BOM；还会跑 Lua 结构校验）；op=inspect 看有没有被编辑器写回旧版' },
  { tool: 'miliastra_map', when: '判断「哪些控件能被脚本动态创建」用 op=clientui（只看无父节点的独立模板）' },
  { tool: 'miliastra_log', when: '运行时结果一律用它取证（Lua 里 print，别靠猜）；op=runs 按「局」切分、op=metrics 汇总指标分布' },
  { tool: 'miliastra_playtest', when: '想知道「开跑那一刻 / 现在在不在试玩」用它 —— 开跑信号在 output_log.txt（实测延迟 0.07~0.18 秒），**`.gia` 里没有**（它是一局结束后才落盘）' },
  { tool: 'miliastra_shot', when: '要看「画面对不对」用它（日志只能回答「代码跑了没」）；「等开跑 → 等 N 秒 → 连拍」是**一次调用**（op=burst awaitPlaytest:true，可先 dryRun 看计划）' },
  { tool: 'miliastra_probe', when: '需要运行时真相（某个控件能不能建、某个枚举叫什么名）时部署探针，让人重新试玩一局后 collect，**收完记得还原脚本**' },
  { tool: 'miliastra_sim', when: '要**在游戏之外先跑一遍**（建界面 / 改控件 / 跑 levelScript / 出画面 PNG）时用它 —— 不占用真机、不需要试玩按钮；但它**不等于真机通过**（官方素材/真机渲染/联机都不覆盖）' },
];

export const PROMPT_RULES = [
  '编辑器 UI 操作（建客户端控件模板、挂脚本、建容器节点）**没有自动化通道，必须人做**；',
  '「试玩」按钮也只能人点 —— 插件只负责把人点完之后的开跑/结束接住（不读内存、不连游戏端口、不冒充编辑器）；',
  '工具**只报数字，不下判决**（几何重叠多少 px、指标集中在哪段，都是事实；「能不能过」是作者的判断）；',
  '「磁盘是用户的」：截图与备份**绝不自动删**，清理永远要人显式点（真删还要双钥匙）；',
  '不碰用户的玩法（规则/判定/数值/组件位置），拿不准先问、给 2~3 个具体选项。',
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
      + '返回：扫到的客户端安装（正式服/Beta）、所有关卡、当前判定为「正在开发」的关卡、'
      + '活文件（沙箱 .lua）清单与大小、地图存档 .gil、运行时日志目录与日志文件数。'
      + '编辑器 UI 操作（建模板/挂脚本）没有自动化通道——本工具只做文件层体检，替代不了人点编辑器。'
      + '\n\n**典型调用**：`{}`（当前关卡速览）｜`{"all":true}`（全部关卡）',
    parameters: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true=返回全部关卡清单（默认只返回最近 12 个）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const levels = scanLevels();
      const cur = pickCurrent(levels);
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
      + '**部署一律：先备份旧文件 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM。**'
      + '（不带 BOM 是硬要求：原神实测会打印 "Read text file with BOM header may cause Lua error"。）'
      + 'op=read 读活文件正文；op=deploy 把 source 指向的本地文件投进沙箱（**覆盖前自动备份**）；'
      + '**部署前先做 Lua 结构校验**（缺 end / 括号不配平 / 字符串没闭合这类错投进去，试玩会静默不生效、'
      + '日志里什么都没有 —— 这是最难查的一类失败）；默认 lintMode:"strict" 直接拒绝，'
      + '确认没问题可 lintMode:"warn" 只提示、"off" 跳过。'
      + 'op=inspect 只体检不改动；'
      + 'op=backups 列出该活文件的全部备份（时间/SHA/是否带 BOM）；op=backup 手动备份一份；'
      + 'op=restore 用它覆盖活文件 —— **backup 可以不传**，不传就用固定名那份 `<原名>.bak`。'
      + '⚠️ 部署不会热加载正在进行的试玩：要 停试玩 → 部署 → 重开试玩。'
      + '\n\n**安全约定（写活文件的地方都遵守，别绕过）**：'
      + '①活文件是**唯一副本**（没有 git、没有撤销），所以**备份失败就中止覆盖**，绝不带着「没有备份」去写；'
      + '②**原子写**（同目录临时文件 → fsync → rename），断电/崩溃不会留下半截损坏的文件；'
      + '③写完必校验 SHA，**校验不过自动回滚**到覆盖前那一版；'
      + '④备份就在**被替换文件的旁边**：`<活文件目录>\\_backup\\`；'
      + '⑤每次备份都写**两份** —— 固定名 `<原名>.bak`（还原默认用它）+ 一份带**本地时间**戳的历史（永不自动删）；'
      + '⑥`noBackup` 必须同时传 `allowNoBackup:true` 才生效（不给随手绕过安全网）；'
      + '⑦所有写操作都回执 `restoreWith` —— 照着它跑就能还原。'
      + '\n\n**两条防「静默丢代码」的机制**：'
      + '· **部署指纹** —— `op=deploy` 成功后会在备份目录写一份 `.miliastra-deploy.json`（记下这一版的 SHA/字节/行数/来源）。'
      + '之后 `op=inspect` 会比对：活文件与上次部署**不一致**就直说「多半是编辑器把脚本面板里的内存版存回了磁盘」'
      + '（实测会发生），并给出字节差/行数差 —— 而不是让你以为跑的还是刚投进去那版。'
      + '· **`op=fixbom`** —— 活文件带 UTF-8 BOM 时**只去掉那 3 个字节**（原神实测会打印 '
      + '"Read text file with BOM header may cause Lua error"）。BOM 不是本工具加的，'
      + '实测来自**新建关卡时编辑器自己写的文件**。安全顺序与部署同源：本来没有 BOM 就**什么都不做** → '
      + '备份失败即中止 → 原子写 → 校验（只差 3 字节 + 无 BOM + 仍是合法 UTF-8）→ 不过**自动回滚**。'
      + '\n\n**典型调用**：`{"op":"inspect"}`（体检 + 看有没有被编辑器写回旧版）｜'
      + '`{"op":"deploy","source":"D:\\\\code\\\\双相\\\\双相_v9.lua"}`（投代码）｜'
      + '`{"op":"levels","summaryOnly":true}`（先扫全部关卡几何）→ `{"op":"levels","stage":3}`（再钻第 3 关）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'deploy', 'inspect', 'backups', 'backup', 'restore', 'fixbom', 'levels'], description: '默认 inspect。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（如 1073741833，选的是**哪张图**；不是玩法里的第几关 —— 那个用 `stage`）；省略=当前关卡。' },
        file: {
          type: 'string',
          description: '指定活文件名（省略=该关卡最近改动的那个 .lua；**探针源码/备份这类附属文件会被自动跳过**）。'
            + '一个关卡可以有多个活文件，拿不准先用 miliastra_health 或 op=inspect 看清单。',
        },
        source: { type: 'string', description: 'op=deploy：要投进去的本地文件绝对路径。' },
        backup: {
          type: 'string',
          description: 'op=restore：要还原的备份文件绝对路径（从 op=backups 拿）。**省略 = 用固定名那份 `<原名>.bak`**（最近一次覆盖前的版本）。',
        },
        backupDir: {
          type: 'string',
          description: '备份目录。默认就是活文件旁边的 `_backup\\`（写在这里是为了让备份和真身待在一起）。'
            + '可用环境变量 MILIASTRA_BACKUP_DIR 改到别处，但那会削弱「备份就在旁边」这一点，一般不要动。',
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
        head: { type: 'number', description: 'op=read：只返回前 N 行（默认 80，0=全文）。' },
        stage: {
          type: 'string',
          description: 'op=levels：**玩法里的第几关**（表里的序号，或名字片段）；省略=全部关卡。'
            + '⚠️ 别和 `level` 混：`level` = **地图关卡 ID**（如 1073741833，哪张图），'
            + '`stage` = **游戏里的第几关**（如 3）—— 前者选文件，后者选表里的一段。',
        },
        summaryOnly: {
          type: 'boolean',
          description: 'op=levels：只给**每关一行的数字摘要**（计数 + 重叠/净空/相交的处数），'
            + '**不带每块平台的坐标、不带直方图分箱** —— 先扫一眼再 `stage=N` 钻进去。默认 false（全量）。',
        },
        nearPx: { type: 'number', description: 'op=levels：「近似贴上」的筛选阈值（默认 48px）—— **这是筛选，不是判定**。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'inspect');
      const lv = resolveLevel(args.level);
      if (!lv.luaDir) throw new Error(`关卡 ${lv.levelId} 没有 external_lua_file 目录——说明还没在编辑器里挂客户端脚本。`);
      const target = chooseLua(lv, args.file);
      const destPath = target ? target.path : (args.file ? lv.luaDir + '\\' + args.file : null);

      if (op === 'inspect') {
        const info = destPath ? inspect(destPath) : null;
        // 「上次部署的是哪一版」↔「现在磁盘上是哪一版」—— 不一致就直接说，别让人以为跑的是刚投进去那版
        const fp = destPath ? readDeployFingerprint(destPath, { backupDir: args.backupDir }) : null;
        return {
          ok: true,
          op,
          level: { brand: lv.brand, levelId: lv.levelId, accountId: lv.accountId },
          luaDir: lv.luaDir,
          files: lv.luaFiles.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, ...(f.auxiliary ? { auxiliary: true } : {}) })),
          inspected: info,
          deploy: fp ? { recordPath: fp.path, ...fingerprintDelta(fp.record || null, info) } : null,
          // 「.gia 里很干净」不等于「脚本没出事」—— 循环调用/挂载失败只写这个文件
          errorLog: scanErrorLog(lv.luaDir, lv.levelDir),
        };
      }
      if (op === 'read') {
        if (!destPath) throw new Error('没找到可读的活文件。');
        const fs = await import('node:fs');
        const info = inspect(destPath);
        const text = fs.readFileSync(destPath, 'utf8');
        const lines = text.split(/\r?\n/);
        const head = Number.isFinite(args.head) && args.head >= 0 ? args.head : 80;
        return {
          ok: true, op, path: destPath, info,
          lineCount: lines.length,
          text: head === 0 ? text : lines.slice(0, head).join('\n'),
          truncated: head !== 0 && lines.length > head,
        };
      }
      if (op === 'backups') {
        if (!destPath) throw new Error('没找到活文件路径。');
        const r = listBackups(destPath, { backupDir: args.backupDir });
        return {
          ok: true, op, dest: destPath, backupDir: r.dir,
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
        if (!destPath) throw new Error('没找到活文件路径。');
        const r = backupFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, dest: destPath, ...r,
          restoreWith: restoreCommand(null, destPath),
          note: r.ok ? '已写两份：固定名 `' + pathBasenameOf(r.fixed || '') + '`（还原默认用它）+ 一份带本地时间戳的历史。' : null,
        };
      }
      if (op === 'restore') {
        if (!destPath) throw new Error('没找到目标活文件路径。');
        // backup 可不传 = 用固定名那份（<原名>.bak）。这是「固定统一备份名」的用处：还原有确定目标。
        const r = restoreFile(args.backup || null, destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...r,
          error: r.error || (r.errors || [])[0] || null,
          restoreWith: restoreCommand(null, destPath),
          usedFixedBackup: r.usedFixedBackup === true,
        };
      }
      if (op === 'deploy') {
        if (!args.source) throw new Error('op=deploy 需要 source（要投进去的本地文件绝对路径）。');
        if (!destPath) throw new Error('没找到目标活文件路径（关卡里还没有 .lua？先用 miliastra_health 看）。');
        const r = deployFile(args.source, destPath, {
          backupDir: args.backupDir,
          noBackup: args.noBackup === true,
          allowNoBackup: args.allowNoBackup === true,
          lintMode: args.lintMode,
        });
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
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...r,
          lintSummary: r.lint ? (r.lint.ok ? '结构正常' : '发现问题') : '（未校验）',
          deployFingerprint: fp ? { ok: fp.ok, path: fp.path, sha256: (fp.record || {}).sha256 || null, atLocal: (fp.record || {}).atLocal || null } : null,
          reconcile: rec,
          restoreWith: r.fixedBackup
            ? restoreCommand(null, destPath)
            : (r.backup ? restoreCommand(r.backup, destPath) : null),
          nextStep: r.ok
            ? (rec && rec.match === true
              ? '停掉当前试玩 → 重新试玩一局，然后 miliastra_log 取回结果'
              : '先在编辑器里存盘（地图里嵌的还不是这一版）→ 再重新试玩一局')
            : null,
        };
      }
      if (op === 'fixbom') {
        if (!destPath) throw new Error('没找到活文件路径。');
        const r = stripBomFile(destPath, { backupDir: args.backupDir });
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...r,
          error: r.error || null,
          restoreWith: r.restoreWith || restoreCommand(null, destPath),
        };
      }
      if (op === 'levels') {
        if (!destPath) throw new Error('没找到活文件路径。');
        const src = fsMod.readFileSync(destPath, 'utf8');
        const ex = extractLevelTable(src);
        if (!ex.ok) {
          return {
            ok: false, op, file: destPath,
            error: ex.error, line: ex.line || null, lineText: ex.lineText || null,
            searchedFor: ex.searchedFor || null, constantsFound: (ex.constants || []).length,
            hint: ex.hint || null,
          };
        }
        const cards = describeLevels(ex.levels, {
          which: args.stage == null || args.stage === '' ? null : String(args.stage),
          nearPx: clampNum(args.nearPx, 48, 0, 2000),
        });
        const summaryOnly = args.summaryOnly === true;
        return {
          ok: true, op, file: destPath,
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
      + 'op=summary 关卡/版本/账号/脚本映射；op=clientui **客户端控件谱系**——'
      + '每条控件的「控件模板索引 / 名字 / 父 / 子」，是判断「哪些控件能被脚本动态创建」的唯一正解；'
      + 'op=script 比对地图里嵌的脚本源码与本地活文件（用来判断"跑的是不是本地这版代码"）；'
      + 'op=strings 提取可读字符串（偏移+文本），存盘前后 diff 用。'
      + '判据：**只有「无父节点」的独立控件（存为模板）才可能被 game.InstantiateClientUIControl 创建**；'
      + '画布上摆的实例、以及模板控件的子节点，一律返回 nil。'
      + '\n\n**典型调用**：`{"op":"summary"}`（版本/脚本映射/模板数）｜'
      + '`{"op":"clientui","summaryOnly":true}`（先看有没有可动态创建的模板）｜`{"op":"script"}`（跑的是不是本地这版）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['summary', 'clientui', 'script', 'strings'], description: '默认 summary。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡。' },
        file: { type: 'string', description: 'op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=clientui：省掉 `records`（每条控件一行）与 `rendered`（谱系文字），只留计数与「可能能动态创建的模板」。'
            + '**先看有没有模板，再决定要不要逐条看**时用。默认 false（全量）。',
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
            + '实测佐证：本关 1073741867(文本框) / 1073741868(图片) 可创建，1073741863~1866（画布实例）一律 nil。',
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
        // 一个关卡可能有多个活文件 —— 比的是**指定/默认的那一个**，返回里带上它叫什么
        const live = cur ? chooseLua(cur, args.file) : null;
        let liveInfo = null;
        if (live) {
          const i = inspect(live.path);
          liveInfo = { name: live.name, path: live.path, size: i.size, sha256: i.sha256, mtime: i.mtime };
        }
        const match = !!(gil.script && liveInfo && gil.script.sourceSha256 === liveInfo.sha256);
        return {
          ok: true, op, path: gilPath,
          embedded: gil.script ? { name: gil.script.name, file: gil.script.file, bytes: gil.script.sourceBytes, sha256: gil.script.sourceSha256 } : null,
          live: liveInfo,
          match,
          note: gil.script
            ? (match
              ? '地图里嵌的脚本与本地活文件哈希一致 —— 但**地图可能是上次存盘时的快照**，改完活文件记得在编辑器里存盘才会同步。'
              : '地图里嵌的脚本与本地活文件**不一致**：要么刚改了活文件没存盘，要么编辑器里有未保存改动。')
            : '地图里没有脚本映射记录。',
        };
      }
      throw new Error('未知 op：' + op);
    },
  },

  {
    name: 'miliastra_log',
    description:
      TITLE + '：读客户端运行时日志 `.gia`。**这是运行时取证（Lua 里 print 出来的东西）的唯一入口**，'
      + '比让人手动复制粘贴可靠得多。'
      + 'op=sessions 列出所有日志文件（倒序，带大小/时间）；op=tail 读某个文件的结构化记录；'
      + 'op=grep 用 tag/pattern 过滤（tag 是子串，pattern 是正则）；op=tags 汇总出现过的标签（方括号开头的那种）；'
      + '**op=runs 按「局」切分** —— 一个 `.gia` 里可能装多局（实测 `21-24-16_155` 装了两段完整生命周期），'
      + 'op=runs 给每局一行摘要（开跑时刻 / 记录数 / 就绪行 / 异常次数 / 错误样式）**并和上一局做 diff**，'
      + '省掉「把 30 多条倒过来再分清哪段属于哪局」这一步。'
      + '记录字段：time / account / player / channel（关卡或模式名）/ message（正文）。'
      + '\n\n⚠️ **「试玩了却没有新日志」先看这里**：`.gia` 里**只有脚本自己 `print` 出来的东西**。'
      + '实测最坑的一次是**压根忘了从编辑器开试玩**（游戏客户端开着 ≠ 在试玩）——'
      + '另一种是编辑器「日志」面板里 `客户端脚本` 没勾上。工具不再替这种现象下结论，'
      + '只如实回「最近一局是什么时候写的」；是不是刚玩过，你自己看一眼就知道。'
      + '\n\n**典型调用**：`{"op":"runs"}`（这一局/这几局发生了什么，含局间 diff）｜'
      + '`{"op":"metrics"}`（死亡位置分布与集中区，**不用改脚本**）｜'
      + '`{"op":"tail","tag":"yuan-code","limit":30}`（按标签读正文）｜`{"op":"tail","run":1790171162}`（只看那一局）',
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
          description: 'op=tail/grep/tags：**只看某一局**。给 epoch 秒（如 1790170177）或 instance 片段。'
            + 'op=runs 的 epochSec 与 miliastra_playtest 报的是同一个值。',
        },
        limit: { type: 'number', description: 'op=tail/grep：最多返回多少条（默认 120）；op=runs/metrics：最多返回几局/几条时间线（默认 10 / 40）；op=sessions：几个文件（默认 40）。' },
        evt: { type: 'string', description: 'op=metrics：只看某个事件名（严格约定的 `evt=`）。' },
        summaryOnly: {
          type: 'boolean',
          description: 'op=metrics：去掉直方图分箱，只留 `n/min/max/median/core/hotBin` 这些标量'
            + '（有箱可去时 `binsOmitted` 会报出数量）。**先看数再决定要不要分箱**时用。默认 false（全量）。',
        },
        bins: { type: 'number', description: 'op=metrics：直方图分箱数（默认 10，1~50）。**集中区看 `core`（四分位距），热区看 `hotBin`**。' },
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

      // 按局过滤：run 可以是 epoch 秒，也可以是 instance 的任意片段
      const runQ = args.run == null || String(args.run).trim() === '' ? null : String(args.run).trim();
      const pool = runQ ? withMsg.filter((r) => String(r.instance || '').includes(runQ)) : withMsg;

      if (op === 'runs') {
        const runs = groupRuns(withMsg);
        const play = playRunsOf(runs);
        return {
          ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
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
            + '不是平台给的分类；具体含义以脚本里那行 print 自己的文案为准。',
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
        const counter = new Map();
        for (const r of pool) {
          const m = /\[([A-Za-z0-9_\-]{1,24})\]/.exec(r.message);
          const k = m ? m[1] : '(无标签)';
          counter.set(k, (counter.get(k) || 0) + 1);
        }
        const tags = [...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
        return { ok: true, op, file, recordCount: gia.recordCount, tags };
      }
      const limit = Number.isFinite(args.limit) ? args.limit : 120;
      const { records, error } = filterRecords(pool, { tag: args.tag, pattern: args.pattern, limit });
      if (error) return { ok: false, op, file, error };
      const slim = records.map((r) => (args.withRaw
        ? r
        : { time: r.time, account: r.account, player: r.player, channel: r.channel, message: r.message }));
      return {
        ok: true, op, file, size: gia.size, recordCount: gia.recordCount,
        matched: records.length, returned: slim.length,
        filter: { tag: args.tag || null, pattern: args.pattern || null },
        records: slim,
      };
    },
  },

  {
    name: 'miliastra_playtest',
    description:
      TITLE + '：**试玩开跑 / 结束的实时侦测** —— 回答「现在在不在试玩 / 开跑到第几秒了」，'
      + '并支持**等下一次开跑**。'
      + '信号来自游戏客户端自己写的 Unity 日志 `output_log.txt`（每行带毫秒时间戳、持续追加）：'
      + '开跑 = `BeyondLevelPlayModule SetCurLevelData … isTrial:True`，'
      + '结束 = `StartQuickSwitchSceneAction … QuickSwitchToBeyondSettleSceneNormally`。'
      + '**实测延迟 0.07~0.18 秒**（2026-09-23 真机：日志在 21:46:02.420 写下，21:46:02.600 已读到）。'
      + '它是**平台级**标记：脚本一行都不 print、磁盘上没有 `.gia` 的局，它照样记。'
      + '⚠️ **别用 `.gia` 判开跑** —— `.gia` 不是实时的：实测那局 21:46:58 结束，'
      + '`…21-46-05_157.gia` 到 **21:47:07** 才落盘；**局在跑的时候磁盘上根本没有这个文件**。'
      + 'op=status 看当前状态 + 最近几局；op=wait 等下一次开跑（`backSec` 可回扫刚过去那局，'
      + '`afterSec` 要「开跑 N 秒后」）——命中后接着调 `miliastra_shot` 截一张，'
      + '就是「游戏开跑 N 秒后的画面」。op=wait 超时**不报错**，如实回 `hit:false`。'
      + '\n\n**典型调用**：`{"op":"status"}`（现在在不在试玩）｜'
      + '`{"op":"wait","afterSec":3}`（等开跑再等 3 秒 —— 但**要截图就别用这条**：'
      + '直接 `miliastra_shot {"op":"burst","awaitPlaytest":true,"afterSec":3}` 一次调用更准）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['status', 'wait'], description: '默认 status。' },
        level: { type: 'string', description: '**地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用来定位该品牌的 output_log.txt）。' },
        backSec: { type: 'number', description: 'op=wait：回扫窗口秒数 —— 调用之前 backSec 秒内已经开跑的也算命中（默认 0）。人点了试玩再叫 AI 时用得上。' },
        timeoutSec: { type: 'number', description: 'op=wait：最多等多少秒（默认 90，上限 300）。' },
        afterSec: { type: 'number', description: 'op=wait：命中开跑后再等 N 秒才返回（默认 0，上限 120）—— 这就是「开跑 N 秒后」。' },
        pollMs: { type: 'number', description: 'op=wait：轮询间隔毫秒（默认 400，100~5000）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'status');
      if (op !== 'status' && op !== 'wait') throw new HttpError('op 只能是 status / wait，收到：' + op, 400);
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
          note: '开跑/结束读的是 output_log.txt（实时）。`.gia` 是**这一局结束之后**才落盘的，'
            + '所以「本局的运行时日志」要等局结束才有 —— 局中要看画面对不对只能截图。',
        };
      }

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
      + '运行时日志（miliastra_log）能回答「代码跑了没、print 了什么」，回答不了「画面对不对」'
      + '（控件到底挂上去了没、位置歪没歪、颜色对不对）；这一环靠它。'
      + 'op=capture（默认）立刻截一张，目标 `target=game`（原神客户端，默认）/ `editor`（千星沙箱），'
      + '也可以用 `process` 指定任意进程名；op=list 看截到哪去了、有多少张、占多大；'
      + 'op=clean 清理，**默认只报告不删**。'
      + '**截图存在插件的数据目录**（默认 `~/.dsh/miliastra/shots`，`MILIASTRA_DATA_DIR` 可整体覆盖）——'
      + '既不放游戏存档目录（那是米哈游的地盘），也不放包目录（插件升级会整个替换掉它）。'
      + '**不会自动删**：清理要显式给条件（`all` 或 `olderThanDays`），真删还要 `confirm:true`。'
      + '回执恒带 `pid / process / title` —— 明确告诉你**截到的到底是哪个窗口**'
      + '（第一版抓错了程序，光看 `ok:true` 根本发现不了）。'
      + '\n\n**典型调用**：`{"op":"capture","target":"game"}`（现在截一张）｜'
      + '`{"op":"burst","awaitPlaytest":true,"afterSec":3,"count":5}`（**等开跑 → 等 3 秒 → 连拍 5 张**，一次调用）｜'
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
          description: '按窗口标题子串挑窗口。**一个进程往往有多个窗口**（实测 BeyondEditor 同时有'
            + ' 900×800 的日志窗和 160×28 的最小化残片）——默认取**面积最大**的，不满意再用这个指定。',
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
          description: 'op=burst：两张之间**额外等待**的毫秒（默认 800；小于 800 会被夹到 800 并标 `clamped`）。'
            + '⚠️ **这不是「每 N 毫秒一张」**：单张自身还要 ~2.6 秒（本机实测），'
            + '所以真实帧距 ≈ burstMs + 2600ms，回执里用 **`measuredIntervalMs`** 如实报出。',
        },
        awaitPlaytest: {
          type: 'boolean',
          description: 'op=burst：**默认 false（立刻开拍）**。传 true 就变成「等试玩开跑 → 再等 afterSec 秒 → 连拍」——'
            + '这条链**一次调用就能完成**（判据与 miliastra_playtest op=wait 是同一份）。',
        },
        afterSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：命中开跑后再等 N 秒才开拍（默认 0，上限 120）。' },
        timeoutSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：等开跑最多多少秒（默认 90，上限 300）。' },
        backSec: { type: 'number', description: 'op=burst（配合 awaitPlaytest）：回扫窗口秒数 —— 调用之前 backSec 秒内已经开跑的也算命中（默认 0）。' },
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
        if (args.awaitPlaytest === true) {
          playtest = await waitForPlaytestStart(resolveLevel(args.level), {
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
          const afterSec = clampNum(args.afterSec, 0, 0, 120);
          if (afterSec > 0) await sleep(afterSec * 1000);
          startedAtMs = Date.now();
        }
        if (!processName) throw new Error('没给出要截哪个进程（target/process 都是空的）。');
        if (args.dryRun === true) {
          return {
            ok: true, op, dryRun: true, plan, dir, target: targetKey, process: processName,
            playtest: playtest ? { hit: playtest.hit, epochSec: playtest.epochSec, startedAt: playtest.startedAt } : null,
            note: '这是**计划**，一张都没拍。去掉 dryRun 才真拍 —— 连拍要花约 ' + plan.spanMs + 'ms。',
          };
        }
        fsMod.mkdirSync(dir, { recursive: true });
        const frames = [];
        let abortedAt = null;
        for (const f of plan.frames) {
          if (f.i > 1) await sleep(plan.intervalMs);
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
        }
        const sum = burstSummary(frames, { startedAtMs, requestedMs: plan.intervalMs });
        return Object.assign({
          ok: sum.okCount > 0, op, target: targetKey, process: processName, dir,
          plan,
          playtest: playtest
            ? { hit: true, backHit: playtest.backHit, epochSec: playtest.epochSec, startedAt: playtest.startedAt, afterSec: clampNum(args.afterSec, 0, 0, 120) }
            : null,
          startedAtMs, abortedAt,
        }, sum, {
          hint: abortedAt
            ? '第 ' + abortedAt + ' 张就失败了，**剩下的没拍**（不白耗时间）—— 看那一张的 error。'
            : '看图走 `GET /miliastra/shot?name=<file>`（原图）或 `&thumb=1`（小图），回执不带 base64。'
              + '**截图不会自动删**，记得 `op=clean` 看一眼。',
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

      const judge = judgeCapture(r);
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
        candidates: r.candidates || null,
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
      + '为什么需要它：有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举到底叫什么名），'
      + '必须让游戏真跑一遍才知道 —— 用它，别猜。'
      + '**代价**：部署会**临时覆盖活文件**，所以试玩那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。'
      + '**四步**：① op=deploy template=<名字> → ② 在编辑器里**重新**试玩一局（不会热加载）→ '
      + '③ op=collect 收回结论 → ④ 用 miliastra_code op=restore 还原你的脚本。'
      + `**${PROBE_TEMPLATES.length} 个模板**（先 op=list 看详情）：`
      // 模板清单从 PROBE_INFO 生成 —— 硬编码过「四个模板」，加第 5 个时描述就悄悄过期了
      + PROBE_TEMPLATES.map((t) => {
        const i = PROBE_INFO[t] || {};
        return '`' + t + '` ' + (i.label || '') + (i.oneLine ? '=' + i.oneLine : '');
      }).join('；') + '。'
      + '另：op=render 只生成 Lua 不部署（要先看代码用这个）。探针只读，不做场景写操作。'
      + '\n\n**典型调用**：`{"op":"deploy","template":"ping"}` → 人重新试玩 → `{"op":"collect","tag":"P1"}` → '
      + '**还原**：`miliastra_code {"op":"restore"}`（不传 backup 就是用固定名那份）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'render', 'deploy', 'collect'], description: '默认 list。' },
        template: {
          type: 'string',
          enum: PROBE_TEMPLATES,
          description: '模板名。怕选错先 op=list 看每个模板的大白话说明：'
            + PROBE_TEMPLATES.map((t) => `${t}=${(PROBE_INFO[t] || {}).label || ''}（${(PROBE_INFO[t] || {}).oneLine || ''}）`).join('；'),
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
          ok: true, op, templates: PROBE_TEMPLATES,
          whatIsAProbe: PROBE_OVERVIEW.what,
          why: PROBE_OVERVIEW.why,
          cost: PROBE_OVERVIEW.cost,
          steps: PROBE_OVERVIEW.steps,
          // 每个模板的大白话说明 —— 面板直接拿这份渲染，避免两边各写一套文案
          info: PROBE_TEMPLATES.map((t) => Object.assign({ template: t }, PROBE_INFO[t] || {})),
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
      const r = renderProbe(args.template || 'tree', { tag: args.tag, ids: args.ids, from: args.from, to: args.to });
      if (!r.ok) return r;
      const fs = await import('node:fs');
      if (args.saveTo) {
        fs.mkdirSync((await import('node:path')).dirname(args.saveTo), { recursive: true });
        fs.writeFileSync(args.saveTo, r.lua, 'utf8');
      }
      if (op === 'render') {
        return { ok: true, op, template: r.template, tag: r.tag, bytes: r.bytes, savedTo: args.saveTo || null, lua: r.lua };
      }
      if (op === 'deploy') {
        const lv = resolveLevel(args.level);
        if (!lv.luaDir) throw new Error(`关卡 ${lv.levelId} 没有 external_lua_file 目录——先在编辑器里挂一个客户端脚本。`);
        const chosen = chooseLua(lv, args.file);
        const dest = chosen ? chosen.path : lv.luaDir + '\\' + (lv.levelId + '_probe.lua');
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
          fs.mkdirSync(probeDir, { recursive: true });
          fs.writeFileSync(probeSrc, r.lua, 'utf8');
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
      + 'op=state 看工程/控件树/属性；op=patch 改工程（add/set/remove/setCanvas/addScript…，数据写要带 expectedRevision）；'
      + 'op=play 控制试玩（start/step/pointer/key/click/pause/serverGet/serverSet/serverSend/stop）；'
      + 'op=shot 出 PNG（target=ui 编辑器视图 / target=play 试玩画面，Host 按引擎场景树渲染，不需要窗口在前台）；'
      + 'op=load 列/读模拟器工作区存档；op=save 存进该工作区；op=reset 清空工程。'
      + '⚠️ 用户 Lua 跑在**可终止的 Worker** 里（默认 8 秒超时后 terminate），**模拟器通过 ≠ 真机通过**；'
      + '工作区固定在插件数据目录的 `simulator/`，不碰游戏存档、地图与活文件。'
      + '\n\n**典型调用**：`{"op":"state","summaryOnly":true}`；跑一局看画面：`{"op":"play","action":"start"}` → `{"op":"shot","target":"play"}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['state', 'patch', 'play', 'shot', 'load', 'save', 'reset'], description: '默认 state。' },
        summaryOnly: { type: 'boolean', description: '只去体积不去结论（默认 true：state 不回 boxes 与 tree 全量）。' },
        treeLimit: { type: 'number', description: 'op=state 在 summaryOnly 下最多回多少条控件树，默认 200。' },
        patch: { type: 'object', description: 'op=patch 的编辑操作，如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题"}；数据写要带 expectedRevision。', additionalProperties: true },
        action: { type: 'string', description: 'op=play 的动作：start / device / view / get / step / pointer / key / click / pause / resume / stop / serverGet / serverSet / serverSend。' },
        args: { type: 'object', description: 'op=play 的参数，如 {"x":640,"y":360} / {"dt":0.033} / {"type":"click","x":640,"y":360}。', additionalProperties: true },
        target: { type: 'string', enum: ['ui', 'play'], description: 'op=shot 的取景：ui=编辑器视图（静态），play=试玩画面（需先 op=play action=start）。' },
        label: { type: 'string', description: 'op=shot 的文件名标签（便于事后认图）。' },
        archive: { type: 'string', description: 'op=load 的存档相对路径；省略=列出工作区里的存档。' },
        path: { type: 'string', description: 'op=save 的存档文件名（默认 qxqy-simulator.save.json）。' },
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
            async execute(args, exec) {
              try {
                return lossless(await def.execute(args, exec));
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
    return { name: def.name, ok: true, data: lossless(await def.execute({ ...(args || {}) }, {})) };
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
      // 模拟器路由：面板的「模拟器」tab 走这条（与工具共用同一个 simOp，状态不分裂）
      if (route === PREFIX + '/engine' && req.method === 'POST') {
        const body = await readBody(req);
        const args = body && typeof body === 'object'
          ? (body.args && typeof body.args === 'object' ? body.args : body)
          : {};
        sendJson(res, 200, { ok: true, data: lossless(await simOp(args, {})) });
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
