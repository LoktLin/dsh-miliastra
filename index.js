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
 *   miliastra_probe   探针：模板化渲染 → 部署 → 试玩后回收结论
 *
 * 边界（务必知道）：**编辑器 UI 里的操作（建模板 / 挂脚本 / 建容器）没有自动化通道**，
 * 插件替代不了人点编辑器，只替代「人和 AI 之间的来回搬运」。
 *
 * 三条纪律（技能 dsh-plugin-dev 实测踩出来的）：
 *   · 工具返回值必须 **lossless JSON**（所有出口过 `lossless()`）
 *   · `parameters` 必须是合法 JSON Schema（写坏会在注册期炸，严重时连发消息都失败）
 *   · 副作用全部挂 `ctx.effect`，服务用 `ctx.inject` 惰性取，缺了就降级 + warn
 */
export const name = 'dsh-miliastra';

export const inject = [];

const PREFIX = '/miliastra';
const VERSION = '0.0.1';
const TITLE = 'Miliastra Wonderland 工具链';
const STARTED_AT = Date.now();

import fsMod from 'node:fs';
import { scanLevels, pickCurrent, findLevel, localLowRoot } from './lib/locate.mjs';
import { inspect, deploy as deployFile, pickLuaFile, defaultBackupDir, backupFile, listBackups, restore as restoreFile, restoreCommand } from './lib/codefile.mjs';
import { readGil, renderClientUI, extractStrings } from './lib/gil.mjs';
import { readGia, listGia, filterRecords } from './lib/gia.mjs';
import { PROBE_TEMPLATES, PROBE_INFO, PROBE_OVERVIEW, renderProbe } from './lib/probes.mjs';
import { clientProcesses } from './lib/proc.mjs';

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

const TOOLS = [
  {
    name: 'miliastra_health',
    description:
      TITLE + '：环境体检。**任何时候要操作原神 UGC，先调它。**'
      + '返回：扫到的客户端安装（正式服/Beta）、所有关卡、当前判定为「正在开发」的关卡、'
      + '活文件（沙箱 .lua）清单与大小、地图存档 .gil、运行时日志目录与日志文件数。'
      + '编辑器 UI 操作（建模板/挂脚本）没有自动化通道——本工具只做文件层体检，替代不了人点编辑器。',
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
        levelCount: levels.length,
        current: cur ? brief(cur) : null,
        levels: (args.all ? levels : levels.slice(0, 12)).map(brief),
        // 编辑器 / 游戏进程（best-effort，带缓存；拿不到就 available:false，不影响其它字段）
        processes: clientProcesses(),
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
      + '⑦所有写操作都回执 `restoreWith` —— 照着它跑就能还原。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['read', 'deploy', 'inspect', 'backups', 'backup', 'restore'], description: '默认 inspect。' },
        level: { type: 'string', description: '关卡 ID / 品牌 / 脚本名片段；省略=当前关卡。' },
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
        return {
          ok: true,
          op,
          level: { brand: lv.brand, levelId: lv.levelId, accountId: lv.accountId },
          luaDir: lv.luaDir,
          files: lv.luaFiles.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, ...(f.auxiliary ? { auxiliary: true } : {}) })),
          inspected: destPath ? inspect(destPath) : null,
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
        return {
          ok: r.ok, op, level: { levelId: lv.levelId }, ...r,
          lintSummary: r.lint ? (r.lint.ok ? '结构正常' : '发现问题') : '（未校验）',
          restoreWith: r.fixedBackup
            ? restoreCommand(null, destPath)
            : (r.backup ? restoreCommand(r.backup, destPath) : null),
          nextStep: r.ok ? '停掉当前试玩 → 重新试玩一局，然后 miliastra_log 取回结果' : null,
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
      + '画布上摆的实例、以及模板控件的子节点，一律返回 nil。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['summary', 'clientui', 'script', 'strings'], description: '默认 summary。' },
        level: { type: 'string', description: '关卡 ID / 品牌；省略=当前关卡。' },
        file: { type: 'string', description: 'op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。' },
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
        return {
          ok: true, op, path: gilPath,
          level: gil.level,
          count: gil.clientUI.length,
          standalone: c.standalone,
          likelyTemplates: c.likelyTemplates,
          likelyContainers: c.likelyContainers,
          structural: c.structural,
          records: gil.clientUI,
          rendered: renderClientUI(gil),
          hint: '能被 game.InstantiateClientUIControl 创建的，只有「在客户端控件模板库里【添加客户端控件】存为模板」的独立控件。'
            + '本工具把「无父节点 + 名字是客户端控件类型」的记为 likelyTemplates；'
            + '其中 容器节点 那几条通常是客户端控件容器的画布根节点（不是模板），真正的模板看 图片 / 文本框 这类。'
            + '实测佐证：本关 1073741867(文本框) / 1073741868(图片) 可创建，1073741863~1866（画布实例）一律 nil。',
        };
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
      + '比让人手动复制粘贴可靠得多。每局试玩会新写一个 .gia 文件。'
      + 'op=sessions 列出所有日志文件（倒序，带大小/时间）；op=tail 读某个文件的结构化记录；'
      + 'op=grep 用 tag/pattern 过滤（tag 是子串，pattern 是正则）；op=tags 汇总出现过的标签（方括号开头的那种）。'
      + '记录字段：time / account / player / channel（关卡或模式名）/ message（正文）。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sessions', 'tail', 'grep', 'tags'], description: '默认 tail。' },
        level: { type: 'string', description: '关卡 ID / 品牌；省略=当前关卡（用它对应的日志目录）。' },
        file: { type: 'string', description: 'op=tail/grep：日志文件名或绝对路径；省略=最新那个。' },
        tag: { type: 'string', description: '正文子串过滤，例如 [P5D]、就绪、首错。' },
        pattern: { type: 'string', description: '正文正则过滤。' },
        limit: { type: 'number', description: '最多返回多少条（默认 120）。' },
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

      if (op === 'tags') {
        const counter = new Map();
        for (const r of withMsg) {
          const m = /\[([A-Za-z0-9_\-]{1,24})\]/.exec(r.message);
          const k = m ? m[1] : '(无标签)';
          counter.set(k, (counter.get(k) || 0) + 1);
        }
        const tags = [...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
        return { ok: true, op, file, recordCount: gia.recordCount, tags };
      }
      const limit = Number.isFinite(args.limit) ? args.limit : 120;
      const { records, error } = filterRecords(withMsg, { tag: args.tag, pattern: args.pattern, limit });
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
    name: 'miliastra_probe',
    description:
      TITLE + '：探针 —— **「问游戏一句」的工具**。'
      + '探针是一段临时替掉活文件的小程序，只在试玩那几秒跑一次，把游戏内部信息打到日志里。'
      + '为什么需要它：有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举到底叫什么名），'
      + '必须让游戏真跑一遍才知道 —— 用它，别猜。'
      + '**代价**：部署会**临时覆盖活文件**，所以试玩那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。'
      + '**四步**：① op=deploy template=<名字> → ② 在编辑器里**重新**试玩一局（不会热加载）→ '
      + '③ op=collect 收回结论 → ④ 用 miliastra_code op=restore 还原你的脚本。'
      + '**四个模板**（先 op=list 看详情）：'
      + '`ping` 探活=确认脚本到底有没有跑起来（日志空着时先跑它）；'
      + '`tree` 看控件=屏幕上挂着哪些控件、画布多大；'
      + '`instantiate` 试钥匙=拿一串索引号去试，看哪个真能被脚本创建出来；'
      + '`api-surface` 翻字典=把枚举和成员列出来（比如按键的真名），输出较长已分片打印。'
      + '另：op=render 只生成 Lua 不部署（要先看代码用这个）。探针只读，不做场景写操作。',
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
    name: 'miliastra_echo',
    description:
      '调试用：把 text 原样回显，并带上插件版本与本机存档根目录。'
      + '**怀疑「插件没生效 / 面板调不通 Host / 工具参数丢了」时先调它** ——'
      + '返回里带着你传进来的字符串，就不用猜参数到底有没有传到 Host。',
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

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.get('systemPrompt');
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return;
      try {
        const text = [
          '原神·千星奇域（Miliastra Wonderland）UGC 工具链已装载，提供工具：' + TOOLS.map((t) => t.name).join('、') + '。',
          '涉及原神 UGC / 千星奇域 / 客户端控件 / levelScript / 图片资产 / 地图存档 .gil / 运行时日志 .gia 时，',
          '优先用这些工具而不是自己拼 PowerShell：',
          '  · 先 miliastra_health 定位「当前关卡 / 活文件 / 地图 / 日志目录」（路径随账号与换图变化，禁止写死）',
          '  · 运行时结果一律 miliastra_log 取证（Lua 里 print，别靠猜）',
          '  · 改完本地 lua 用 miliastra_code op=deploy 投进沙箱（自动备份 + SHA 校验 + 无 BOM 检查）',
          '  · 判断「哪些控件能被脚本动态创建」用 miliastra_map op=clientui（只看无父节点的独立模板）',
          '  · 需要运行时真相时 miliastra_probe 部署探针，让人试玩一局后 collect',
          '硬规则：编辑器 UI 操作（建客户端控件模板、挂脚本、建容器节点）没有自动化通道，必须人做；',
          '不碰用户的玩法（规则/判定/数值/组件位置），拿不准先问。',
        ].join('\n');
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

async function selfStatus() {
  let current = null;
  try {
    const lv = pickCurrent(scanLevels());
    if (lv) current = { brand: lv.brand, levelId: lv.levelId, luaFiles: lv.luaFiles.map((f) => f.name), logCount: lv.logCount };
  } catch { /* ignore */ }
  return {
    ok: true, plugin: name, title: TITLE, version: VERSION,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    localLow: localLowRoot(),
    tools: TOOLS.map((t) => t.name),
    probeTemplates: PROBE_TEMPLATES,
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

function makeHandler() {
  return async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅允许本机访问' }); return; }
    const url = new URL(req.url || PREFIX, 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || PREFIX;
    try {
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
