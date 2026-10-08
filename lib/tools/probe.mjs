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

import { readGil } from '../gil.mjs';
import { chooseLua, gilScriptInfo, resolveLevel } from '../shared.mjs';

/** 挑活文件用的名字候选（**全部映射**，宁多勿漏）。 */

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
