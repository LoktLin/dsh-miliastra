/**
 * `miliastra_health` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { ROLE, ROLE_LABEL, clearHandover, ledgerPath, readLedger, setHandover } from '../handover-ledger.mjs';
import { VERSION } from '../constants.mjs';

import { clientProcesses } from '../proc.mjs';
import { compareLiveSources, inspect, normalizeLiveName } from '../codefile.mjs';
import { createHash } from 'node:crypto';
import { currentLevelDecision, editorHint, findLevel, localLowRoot, pickCurrent, scanLevels } from '../locate.mjs';
import { chooseLua, gilScriptInfo, hostSummary, pathBasenameOf, scanErrorLog } from '../shared.mjs';

import { pickScriptMapping } from '../gil.mjs';

import { simRuntimeInfo } from '../sim.mjs';
import { snapshotFreshness } from '../freshness.mjs';

/**
 * `miliastra_health op=sha`（N-2）：**三方 SHA 对照** —— 活文件 / 本地镜像 / `.gil` 嵌入快照。
 *
 * 为什么值得单开一步：`deploy` 只写本地活文件，游戏跑的是**编辑器存盘时嵌进 `.gil` 的那份快照** ——
 * 「部署了但没存盘」是最容易白跑一轮的失败（作者 2026-09-26 手工核过三处 SHA 才想清）。
 * 这里只做**比对与一句话结论**，不替谁决定该用哪一版；镜像目录由调用方给（插件不假设工作区布局）。
 */
export function healthSha({ mirror = null, allFiles = false } = {}) {
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
export function healthHandover(args = {}, cur = null) {
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
 * ★★ `op=sha all:true`（AI 易用性反馈第 8 条）—— **一次给整张表**：每个活文件一行，三列哈希 + 一句话结论。
 *
 * 为什么：要确认「9 条脚本是不是都该存盘了」，旧版一次只出 3 行（一个文件），得跑 9 次。
 * 口径与单文件版**同一套**（`compareLiveSources`），只是循环每个活文件；镜像仍按**同名**匹配。
 * @param {any} cur 当前关卡
 * @param {string|null} mirror 工作区镜像目录（不传就只出两列）
 */
export function shaAllFiles(cur, mirror) {
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

export const HEALTH_TOOL = {
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
          /*
           * ★★ P3-8（《上下文瘦身设计》2026-10-07）：**判据归口** —— brief 是 AI 每轮第一个调用，
           *   把"这张图的坐标/验证链/坑清单在哪"一次说清（**只指向，不复述**）。
           *   ⚠️ 插件只知道关卡 ID、不知道地图名 ⇒ 给认名字的方法，**不猜**。
           */
          memoryDoc: '出处：案子/<地图>/AGENTS.md 的「记忆」段（用 levelId 认地图名）',
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
  };
