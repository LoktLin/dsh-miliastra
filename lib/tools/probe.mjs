/**
 * `miliastra_probe` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import { PROBE_INFO, PROBE_OVERVIEW, PROBE_TEMPLATE_CHOICES, renderProbe } from '../probes.mjs';
import { ReceiptCode, fail } from '../receipt.mjs';
import { atomicWriteFile } from '../fsx.mjs';
import { defaultBackupDir, deploy as deployFile, inspect, pickLuaFile, rankLuaFiles } from '../codefile.mjs';
import { filterRecords, listGia, readGia } from '../gia.mjs';
import { pathBasenameOf } from '../tools/shot.mjs';
import { readGil } from '../gil.mjs';
import { resolveLevel } from '../shared.mjs';

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

/** 挑活文件用的名字候选（**全部映射**，宁多勿漏）。 */
export function mountedScriptNames(lv) {
  return gilScriptInfo(lv).allNames;
}

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
export const gilScriptCache = new Map();

/** 回执里最多列多少条矩形（`summaryOnly` 时更多信息被折叠）。 */
/*
 * ★ E8（2026-09-29 实战反馈）：`mountedOn` 是「存档里离这条挂载记录最近的那层 `#1` 字符串」——
 *   它可能是**占位名**（如 `未分类页签`）⇒ 既不能证实、也不能证伪「挂在客户端控件容器的容器节点上」；
 *   从没在编辑器里挂过时恒为 null。⇒ 把这层边界写进回执，别让人拿它当判据。
 */
export const MOUNTED_ON_NOTE = '`mountedOn` = 存档里「离这条挂载记录最近的那层 #1 字符串」（挂载归属名）。'
  + '⚠️ 边界：① 可能是占位名（如 `未分类页签`）⇒ **既不能证实也不能证伪**「挂在客户端控件容器的容器节点上」；'
  + '② 从没在编辑器里挂过 ⇒ 恒为 null。真机硬要求是「挂客户容器的容器节点」，这条只能当**线索**，以编辑器里的挂载点为准。';

export const PROBE_TOOL = {
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
        if (!file) return fail(ReceiptCode.NOT_FOUND, '没有日志文件——先试玩一局。', {
  nextStep: '`.gia` 只在脚本 print 过、且**一局结束后**才落盘 ⇒ 先试玩一局再 collect。',
});
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
        if (!lv.luaDir) return fail(ReceiptCode.NOT_FOUND, `关卡 ${lv.levelId} 没有 external_lua_file 目录——先在编辑器里挂一个客户端脚本。`, {
  nextStep: '在编辑器里把客户端脚本挂到关卡上，再回来看活文件目录。',
});
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
      return fail(ReceiptCode.BAD_PARAM, '未知 op：' + op, {

        nextStep: '看 `miliastra_map` 的 description 里 op 的合法取值（summary / clientui / audit-template / script / strings / nodes / anatomy / regions / nodedb）。',

      });
    },
  };
