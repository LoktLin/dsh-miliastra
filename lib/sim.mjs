/**
 * sim.mjs —— 「模拟器」引擎的 Host 侧适配（**会话级控制器注册表**）
 *
 * 引擎来自 `engine/studio`（吸收自 miliastra-beyond-simulator，GPL-3.0-only，来源见仓库根 NOTICE）。
 *
 * 三条安全纪律（写在这里，别绕）：
 *   ① **用户 Lua 一律在引擎自己的 `worker_threads.Worker` 里跑**（默认 8 秒超时后 terminate），
 *      绝不在 Host 主线程执行 —— 否则一条 `while true do end` 就能冻住整个 Web GUI。
 *   ② **工作区固定在本插件数据目录下的 `simulator/`**（`<dataRoot>/simulator`），
 *      永不指向游戏存档、地图或活文件目录；模拟器的存档读写只发生在这里。
 *   ③ 每个会话一个控制器，切会话不串状态；插件卸载时 `disposeSimAll()` 收干净，
 *      不留 Worker 幽灵进程。
 *
 * 形态：一个 `simOp(args, ctx)` 入口，按 `op` 分派 —— 与插件其它工具的 op 风格一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SimulatorController } from '../engine/studio/host/controller.js';
import { CANVAS_PRESETS, KIND_LABELS } from '../engine/studio/constants.js';
// `set` 的可设字段全集（引擎侧**加法导出**，只为报错时能列出「该控件可设的 key」；语义未改）
import { DIRECT_FIELDS } from '../engine/studio/ui/project.js';
// 全量键名（`Enum.KeyEventType` 164 项）由引擎**生成**，直接拿正源，别在插件里抄一份会过期的表
import { buildEnumTree } from '../engine/lua-runtime/src/enums.js';
// 写盘一律走共享的原子实现（同目录 tmp + fsync + rename；见 lib/fsx.mjs 顶部注释）
import { atomicWriteFile, atomicWriteJson } from './fsx.mjs';
import { scanLevels, pickCurrent } from './locate.mjs';
// `source`（任意本地 .lua，只读）的校验**复用** op=read 那一套：8 MB 上限 / 二进制拒绝 / 只认绝对路径
import { readLuaAt } from './codefile.mjs';
import { shotsDir, shotFileName, nextFreeName, humanSize } from './shot.mjs';

/** 控制器注册表：key = 会话标识（无会话时用 'default'）。 */
const registry = new Map();

/** 模拟器工作区：`<dataRoot>/simulator`（shotsDir() 是 `<dataRoot>/shots`）。 */
function simWorkspace() {
  const dir = path.join(path.dirname(shotsDir()), 'simulator');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function keyOf(ctx) {
  const raw = (ctx && (ctx.sessionId || ctx.session || ctx.key)) || '';
  return String(raw || 'default').slice(0, 120) || 'default';
}

/** 取（或建）本会话的控制器。 */
export function controllerFor(ctx) {
  const key = keyOf(ctx);
  let c = registry.get(key);
  if (!c) {
    c = new SimulatorController(simWorkspace());
    registry.set(key, c);
  }
  return c;
}

/** 释放某个会话的控制器（`reset` 与卸载时用）。 */
export async function disposeSim(ctx) {
  const key = keyOf(ctx);
  const c = registry.get(key);
  registry.delete(key);
  if (c) await c.dispose().catch(() => {});
  return { disposed: !!c, key };
}

/** 插件卸载：把所有会话的 Worker 都收掉。 */
export async function disposeSimAll() {
  const keys = [...registry.keys()];
  for (const k of keys) {
    const c = registry.get(k);
    registry.delete(k);
    if (c) await c.dispose().catch(() => {});
  }
  return { disposed: keys.length };
}

/** 给自检/状态看：现在有几个会话控制器、工作区在哪。 */
export function simRuntimeInfo() {
  return { sessions: registry.size, workspace: simWorkspace() };
}

/* ------------------------------------------------------------------ 瘦身 */

const PLAY_LOG_KEEP = 60;

/**
 * 状态瘦身。默认行为不变（结论都在），`summaryOnly` 只去体积：
 * `boxes`（每帧几何，动辄几十 KB）与 `tree` 全量列表在 summaryOnly 下被折叠成计数。
 */
function slimState(st, { summaryOnly = false, treeLimit = 0 } = {}) {
  const tree = Array.isArray(st.tree) ? st.tree : [];
  const boxes = Array.isArray(st.boxes) ? st.boxes : [];
  const out = {
    version: st.version,
    canvasId: st.canvasId,
    canvas: st.canvas
      ? {
        id: st.canvas.id, label: st.canvas.label, width: st.canvas.width, height: st.canvas.height,
        platform: st.canvas.platform,
        presets: Array.isArray(st.canvas.presets) ? st.canvas.presets : [],
      }
      : null,
    asset: st.asset || null,
    selectedId: st.selectedId || '',
    meta: st.meta || null,
    save: st.save ? { name: st.save.name, activeAssetType: st.save.activeAssetType } : null,
    workspace: st.workspace ? { name: st.workspace.name, bound: !!st.workspace.bound, path: st.workspace.path } : null,
    treeCount: tree.length,
    boxCount: boxes.length,
    scriptCount: Array.isArray(st.scripts) ? st.scripts.length : 0,
    scripts: Array.isArray(st.scripts)
      ? st.scripts.map((s) => ({ id: s.id, path: s.path, controlName: s.controlName, mounted: s.mounted !== false }))
      : [],
    mountTargetCount: Array.isArray(st.mountTargets) ? st.mountTargets.length : 0,
    serverLogic: st.serverLogic || null,
    inspector: st.inspector || null,
    // 「这还是出厂默认工程」——重启 Host 后内存里的工程就是这个。调用方据此如实提示，别让人对着一屏默认控件猜。
    factoryDefault: st.factoryDefault === true,
    // 上次 bind 的配方（只报"有没有 + 是什么"，让面板能写「一键重搭上次的《双相》」）
    lastBind: (() => {
      const r = readBindRecipe();
      return r ? { source: r.source, scriptName: r.scriptName, at: r.at, templates: (r.templates || []).length, save: r.save || null } : null;
    })(),
  };
  if (!summaryOnly) {
    out.tree = tree;
    out.boxes = boxes;
  } else {
    const limit = treeLimit > 0 ? treeLimit : 200;
    out.treeOmitted = Math.max(0, tree.length - limit);
    out.tree = tree.slice(0, limit);
    out.boxesOmitted = boxes.length;
    out.binsOmitted = boxes.length; // 与其它工具同一个"去掉了多少"的口径
  }
  return out;
}

/** 试玩快照瘦身：scene 是给浏览器渲染器用的，默认不回；`summaryOnly:false` 时必须原样给。 */
function slimPlay(res, { summaryOnly = true } = {}) {
  if (!res || typeof res !== 'object') return res;
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    if (k === 'scene' || k === 'paint') {
      // ⚠️ 这里原来**无条件**丢掉 scene/paint —— 于是浏览器试玩页永远拿不到场景（2026-09-24 修）。
      //    1/3 的节点级增量场景是浏览器那条路唯一的画面来源，不能跟着"瘦身"一起被砍。
      if (summaryOnly) { out[k + 'Omitted'] = Array.isArray(v) ? v.length : 1; continue; }
      out[k] = v;
      continue;
    }
    if (k === 'tree' && Array.isArray(v)) {
      out.treeCount = v.length;
      if (!summaryOnly) out.tree = v.slice(0, 400);
      else out.treeOmitted = v.length;
      continue;
    }
    if ((k === 'logs' || k === 'serverLogs' || k === 'serverVars') && Array.isArray(v)) {
      out[k] = v.length > PLAY_LOG_KEEP ? v.slice(-PLAY_LOG_KEEP) : v;
      if (v.length > PLAY_LOG_KEEP) out[k + 'Omitted'] = v.length - PLAY_LOG_KEEP;
      continue;
    }
    if (k === 'canvasPresets') { out[k] = v; continue; }
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ 动作 */

function writePng(buf, { target, label, reuse = false }) {
  const dir = shotsDir();
  fs.mkdirSync(dir, { recursive: true });
  // 连帧（reuse）用**固定文件名覆盖写**：5fps 连跑一小时就是 18000 张图，
  // 绝不能每帧都落一个新文件 —— 固定名 + 覆盖，只留一张「当前帧」。
  const name = reuse
    ? (target === 'sim-play' ? 'sim-play-live.png' : 'sim-ui-live.png')
    : nextFreeName(dir, shotFileName({ target, label }));
  const file = path.join(dir, name);
  atomicWriteFile(file, buf);
  return { file, name, dir, bytes: buf.length, bytesText: humanSize(buf.length) };
}

/**
 * 模拟器入口。
 *
 * @param {{op?: string}} args
 * @param {{sessionId?: string}} [ctx]
 */
/** 每个控制器记住最近一次 `start` 的选项（device 重建运行时时要用）。 */
const startOpts = new WeakMap();

/**
 * 把「好写的步骤」翻成引擎用例里的 `events[]`。
 * 引擎的事件种类（`autotest/runner.js` 的 applyEvent）：pointer / key / click / pause / resume / serverSet / serverSend / view。
 * 这里每个步骤都可以给 `at`（模拟秒）；不给就按上一步 + `after`（默认 0.1s）依次排开。
 */
/** 取一个点：`[x,y]` 或 `{x,y}` 都认（写起来顺手最重要）。 */
function pointOf(v, label) {
  const num = (raw, axis) => {
    /*
     * ⚠️ 只看 `!== undefined` 不够：`Number(null) / Number("") / Number([]) / Number(false)` **全是 0**，
     * 所以那些值会照样静默兜成 0（实测 `pointer:{x:null}` 就漏过去了）。先按**类型**过筛，再谈数值。
     */
    const typed = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");
    const n = typed ? Number(raw) : NaN;
    /*
     * 不许静默兜 0（2026-09-24 源码审计）：以前写的是 `Number(v[0]) || 0`，
     * 于是 AI 写错坐标（`{x:"abc"}`、`click:[800]`）会静默变成 (0,0) —— 一次点在左下角的点击，
     * 看起来「成功」却什么都没点到。引擎那层的 `isFinite` 校验救不了：Host 在更早一步就兜成 0 了。
     * 现在笔误当场报错，并把收到的原值打回去（AI 一眼看得出自己写错在哪）。
     */
    if (!Number.isFinite(n)) {
      throw new Error(label + " 的 " + axis + " 不是有限数字（收到 " + JSON.stringify(raw) + "）"
        + " —— 坐标是**左下原点**的世界坐标；写错不要紧，别让它静默变成 0。");
    }
    return n;
  };
  if (Array.isArray(v) && v.length >= 2) return { x: num(v[0], "x"), y: num(v[1], "y") };
  if (v && typeof v === "object" && v.x !== undefined && v.y !== undefined) return { x: num(v.x, "x"), y: num(v.y, "y") };
  /*
   * ⚠️ **这行兜底不能删**：我重写 `num` 时删过一次，于是"参数写错"不再是清晰报错，而是烂到下一层变成
   * `Cannot read properties of undefined (reading 'x')` —— `sim-test` 里那条「drag 参数写错：明确报错」
   * 当场变红把它抓住了。形状不对就**说清要什么形状**，这正是绊线的意义。
   */
  throw new Error(label + ' 需要 [x,y] 或 {x,y}（收到 ' + JSON.stringify(v) + '）'
    + ' —— 坐标是**左下原点**的世界坐标。');
}

function buildEvents(steps, explicit) {
  const out = [];
  let cursor = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') throw new Error('op=verify 的 steps 每项必须是对象：' + JSON.stringify(s));
    const at = Number.isFinite(Number(s.at)) ? Number(s.at) : cursor;
    let stepEnd = at;
    if (s.key !== undefined) out.push({ kind: 'key', t: at, payload: { typeName: String(s.key) } });
    else if (s.click) out.push({ kind: 'pointer', t: at, payload: { type: 'click', ...pointOf(s.click, 'steps[].click') } });
    else if (s.clickName !== undefined) out.push({ kind: 'click', t: at, payload: { name: String(s.clickName) } });
    else if (s.drag) {
      /*
       * 拖拽：引擎的指针事件是 down → move… → up（`CursorBeginDrag` / `CursorDrag` / `CursorEndDrag` 都在 move 里发），
       * 所以「从 A 拖到 B」要展开成一串事件。AI 只想写一句 `drag:{from,to}`，不该自己排 8 个 move。
       */
      const d = typeof s.drag === 'object' ? s.drag : {};
      const from = pointOf(d.from, 'drag.from');
      const to = pointOf(d.to, 'drag.to');
      const moves = Math.max(1, Math.min(60, Number(d.steps) || 6));
      const gap = Number.isFinite(Number(d.gap)) ? Math.max(0.01, Number(d.gap)) : 0.05;
      out.push({ kind: 'pointer', t: at, payload: { type: 'down', x: from.x, y: from.y } });
      for (let i = 1; i <= moves; i += 1) {
        const k = i / moves;
        out.push({
          kind: 'pointer',
          t: Number((at + i * gap).toFixed(4)),
          payload: { type: 'move', x: Number((from.x + (to.x - from.x) * k).toFixed(3)), y: Number((from.y + (to.y - from.y) * k).toFixed(3)) },
        });
      }
      out.push({ kind: 'pointer', t: Number((at + (moves + 1) * gap).toFixed(4)), payload: { type: 'up', x: to.x, y: to.y } });
      stepEnd = at + (moves + 1) * gap;
    } else if (s.pointer) {
      // 裸指针事件：要手排 enter/exit/连续 move 之类的细节时用它
      const p = typeof s.pointer === 'object' ? s.pointer : {};
      out.push({ kind: 'pointer', t: at, payload: { type: String(p.type || 'move'), ...pointOf(p, 'steps[].pointer') } });
    } else if (s.setVar) out.push({ kind: 'serverSet', t: at, payload: { entityType: s.setVar.entityType || 'PlayerSelf', name: String(s.setVar.name), value: s.setVar.value } });
    else if (s.sendSignal) out.push({ kind: 'serverSend', t: at, payload: { name: String(s.sendSignal.name), params: s.sendSignal.params || [], target: s.sendSignal.target || 'PlayerSelf' } });
    else if (s.view !== undefined) out.push({ kind: 'view', t: at, payload: { playerIndex: Number(s.view) } });
    else if (s.pause) out.push({ kind: 'pause', t: at, payload: {} });
    else if (s.resume) out.push({ kind: 'resume', t: at, payload: {} });
    else throw new Error('op=verify 的 steps 里这一项看不懂：' + JSON.stringify(s)
      + '（可用 key / click:{x,y} / clickName / drag:{from,to,steps?,gap?} / pointer:{type,x,y} / setVar / sendSignal / view / pause / resume）');
    cursor = stepEnd + (Number.isFinite(Number(s.after)) ? Number(s.after) : 0.1);
  }
  return out.concat(Array.isArray(explicit) ? explicit : []);
}

/**
 * 控件清单：给 AI 抄名字用的**最省 token** 的形态。
 *
 * 为什么要它：`op=state` 的每条 tree 行有 12 个字段（`ancestorIds` / `siblingIndex` /
 * `siblingCount` / `templateId` / `guid` …），对「写一条断言」这件事**全是噪音**。
 * AI 要的通常只有四个：**有哪些控件、叫什么名、什么类型、第几层**。
 *
 * ⚠️ 一条不显然但要紧的规则（写在这里免得 AI 反复试错）：
 *   `expect[{kind:'tree'}]` **只能按 `name` 找**（引擎 `assert.js` 的 findControl 只认 name）；
 *   `expect[{kind:'control'}]` 才 `id` / `name` 都认。所以**没名字的控件断不了 tree**。
 */
/**
 * 把控件树统一成**拍平行**。
 *
 * ⚠️ 两种形状（2026-09-24 实测踩到）：**编辑器树是拍平的**（每条带 `depth`，12 个字段），
 * **运行时树是嵌套的**（顶层只有 1 条「容器节点」，子控件全在 `children` 里，而且**没有 `depth`**，
 * 但多出 `box` / 颜色 / `text` / `instantiated` 等 40 多个运行时字段）。
 * 只按顶层 `length` 数控件会**少算一个数量级**（实测 1 vs 12）—— 所以先拍平再数。
 */
function flattenControls(nodes, depth = 0, out = []) {
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object') continue;
    const d = typeof n.depth === 'number' ? n.depth : depth;
    out.push({ id: n.id, name: n.name || '', kind: n.kind, depth: d });
    if (Array.isArray(n.children) && n.children.length) flattenControls(n.children, d + 1, out);
  }
  return out;
}

/**
 * 把拍平后的控件树压成**省 token 的清单**（`op=controls` 的默认形状）。
 *
 * @param {any} st 引擎给的快照（`{tree, scripts}`；字段来自引擎，这里不做假设）
 * @param {{nameContains?: string, kind?: string, maxDepth?: number, namedOnly?: boolean,
 *          limit?: number}} [args] `op=controls` 的过滤参数（都省略 = 不过滤、`limit` 取 200）
 * @returns {{total:number, count:number, omitted:number, controls:any[], names:any[], namesCount:number,
 *            kinds:object, kindsTotal:number, scripts:any, hint:string,
 *            geomCovered?:number, geomMissing?:number, geomNote?:string}}
 *          `geomCovered` / `geomMissing` / `geomNote` **只有 `geom:true` 那一路才挂** ——
 *          调用方在 runtime 分支给 `controls` 补完世界坐标后再追加（见 `op=controls`）
 */
function compactControls(st, args = {}) {
  const tree = flattenControls(st.tree);
  const kinds = {};
  for (const n of tree) kinds[n.kind] = (kinds[n.kind] || 0) + 1;

  const nameContains = args.nameContains === undefined || args.nameContains === null ? '' : String(args.nameContains);
  const kindFilter = args.kind ? String(args.kind) : '';
  const maxDepth = Number.isFinite(Number(args.maxDepth)) ? Number(args.maxDepth) : -1;
  const namedOnly = args.namedOnly === true;
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 200;

  const hit = tree.filter((n) => {
    if (kindFilter && n.kind !== kindFilter) return false;
    if (maxDepth >= 0 && Number(n.depth || 0) > maxDepth) return false;
    if (namedOnly && !n.name) return false;
    if (nameContains && String(n.name || '').indexOf(nameContains) < 0) return false;
    return true;
  });
  const controls = hit.slice(0, limit);
  const names = [];
  for (const row of controls) if (row.name && names.indexOf(row.name) < 0) names.push(row.name);

  return {
    total: hit.length,
    count: controls.length,
    omitted: Math.max(0, hit.length - controls.length),
    controls,
    names,
    namesCount: names.length,
    kinds,
    kindsTotal: tree.length,
    scripts: Array.isArray(st.scripts)
      ? st.scripts.map((s) => ({ id: s.id, path: s.path, controlName: s.controlName, mounted: s.mounted !== false }))
      : [],
    hint: '`names` 可直接抄进 expect 的 name 字段；`tree` 断言只能按 name 找（没名字的控件请用 `control{id}`）；'
      + '要找**脚本运行时动态创建**的控件，传 `runtime:true`（需会话在跑，或 verify 失败回执里的 runtime.controlNames）。',
  };
}

/** 把一段「好写的步骤 + 断言」规范成引擎的用例（`op=verify` 与 `cases[]` 共用）。 */
function normalizeCaseSpec(raw, fallbackName) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const expect = a.expect || a.asserts || [];
  if (!Array.isArray(expect) || expect.length === 0) {
    throw new Error('缺少 expect（至少一条断言）：kind 可为 ' + Object.keys(EXPECT_KINDS).join(' / ')
      + '，例如 {"kind":"log","contains":"SCORE"}');
  }
  const events = buildEvents(a.steps || [], a.events);
  const lastT = events.reduce((m, e) => Math.max(m, Number(e.t) || 0), 0);
  const asserts = expect.map((row, i) => {
    /*
     * ★ P1-4：**先过字段白名单**（未知 kind / 未知字段 = **参数错**，不是"断言没过"），
     *   再把 `controlAbsent` 翻成 `control{absent:true}`；归一后的那一份才是交给引擎的。
     */
    const r = validateExpect(row, i).assert;
    // at 省略 = 最后一个事件之后 0.1s ⇒ 查的是「这一串操作做完之后的最终状态」
    if (!Number.isFinite(Number(r.at))) r.at = Number((lastT + 0.1).toFixed(3));
    return r;
  });
  return {
    name: String(a.name || fallbackName || 'ai-verify'),
    dt: a.dt,
    playerCount: Number(a.playerCount) || 1,
    events,
    asserts,
  };
}

/** 判定失败的判定语（AI 靠它自己定位，而不是回头问人）。 */
function failureHint(results, frame) {
  const bad = (Array.isArray(results) ? results : []).find((r) => !r.ok);
  if (!bad) return 'verify 没过但 results 里没有失败项（异常情况，看 error）。';
  return '第 ' + (results.indexOf(bad) + 1) + ' 条断言没过：kind=' + bad.kind
    + ' 期望 ' + JSON.stringify(bad.expected) + ' 实际 ' + JSON.stringify(bad.actual)
    + '（t=' + bad.at + 's / frame=' + frame + '）。看 results 与 snapshot.logs / serverLogs 定位，改完再跑一次 verify。';
}

/**
 * 失败取证：**在失败点就地取证**——一帧 PNG + 运行时的控件名清单。
 *
 * 为什么能在失败点取证：`runCase` 的 `playRunCase` 是「`playStart` → 在**活着的会话**上重放」，
 * 判定返回时会话**还停在失败那一帧**，所以能直接截图 / 读运行时树。
 * 先把 worker 时钟**暂停**（`tickClock` 看 `status.paused`），否则 30FPS 会继续往前走。
 */
async function failureEvidence(controller, label, { shot = true } = {}) {
  const out = {};
  await controller.play('pause', {}).catch(() => {});
  try {
    const live = await controller.play('get', { inspect: true });
    const rows = flattenControls(live && live.tree);
    const names = [];
    for (const n of rows) if (n.name && names.indexOf(n.name) < 0) names.push(n.name);
    out.runtime = {
      frame: Number(live && live.frame) || 0,
      time: Number(live && live.time) || 0,
      controlCount: rows.length,
      controlNames: names,
      note: '失败点附近的**运行时**控件名（已把嵌套的运行时树拍平）：编辑器工程树里没有的 = 脚本运行时动态创建的'
        + '（如 `InstantiateClientUIControl` 建出来的「Lua实例化面板」）。对照它改 `tree{name,exists}` / `control{name,field,equals}` 的期望值。',
    };
  } catch (e) {
    out.runtime = { error: (e && e.message) || String(e) };
  }
  if (shot) {
    try {
      const img = await controller.playScreenshot();
      const w = writePng(img.data, { target: 'sim-play', label: label + '-fail' });
      out.shot = {
        ...w, frame: img.frame, time: img.time, canvasId: img.canvasId,
        url: '/miliastra/shot?name=' + encodeURIComponent(w.name),
        note: '已把时钟冻结在失败点附近（Worker 每帧 33ms，画面可能比 failedAt 晚 0~2 帧）。'
          + '用 read_image 看这张图；不需要就传 shotOnFail:false。',
      };
    } catch (e) {
      out.shot = { error: (e && e.message) || String(e) };
    }
  }
  return out;
}

/* ------------------------------------------------- 帧序列 + 帧间差异（数字） */

let canvasLibPromise = null;
function loadCanvasLib() {
  if (!canvasLibPromise) canvasLibPromise = import('@napi-rs/canvas');
  return canvasLibPromise;
}

/** PNG → RGBA 像素（解不开就抛，让调用方决定降级还是报错）。 */
async function decodePng(buf) {
  const { createCanvas, loadImage } = await loadCanvasLib();
  const img = await loadImage(buf);
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
}

/**
 * 两帧的**像素差** —— 只报数字，不下判决。
 *
 * 为什么需要：`verify` 只能断言某个静态值（"t=1s 时 anchoredPositionX=100"），
 * 但「动画到底动没动」「动的是不是那一块」这种问题，两个值答不了。
 * 这里把「两帧一样吗」变成 `changedPixels` / `changedRatio` / `maxDelta` / 变化区域 `bbox`。
 */
async function diffPngs(a, b, threshold = 8) {
  const A = await decodePng(a);
  const B = await decodePng(b);
  if (A.width !== B.width || A.height !== B.height) {
    return { sizeChanged: true, from: { width: A.width, height: A.height }, to: { width: B.width, height: B.height } };
  }
  const total = A.width * A.height;
  let changed = 0;
  let maxDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(
      Math.abs(A.data[i] - B.data[i]),
      Math.abs(A.data[i + 1] - B.data[i + 1]),
      Math.abs(A.data[i + 2] - B.data[i + 2]),
      Math.abs(A.data[i + 3] - B.data[i + 3]),
    );
    if (d > maxDelta) maxDelta = d;
    if (d > threshold) {
      changed += 1;
      const px = i >> 2;
      const x = px % A.width;
      const y = (px / A.width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    identical: changed === 0,
    changedPixels: changed,
    totalPixels: total,
    changedRatio: Number((changed / total).toFixed(6)),
    maxDelta,
    // bbox 是**图像像素坐标**（左上原点）；舞台坐标是左下原点，两者 y 相反
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    threshold,
  };
}

/** 嵌套场景树 → `id → 节点`（拍平，顺便留下名字）。 */
function sceneById(nodes, out = new Map()) {
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || n.id === undefined) continue;
    out.set(String(n.id), n);
    if (Array.isArray(n.children) && n.children.length) sceneById(n.children, out);
  }
  return out;
}

/**
 * 把节点摊成**标量字段**表（`matrix.tx` 这种点号路径）。
 *
 * ⚠️ 位置不在 `anchoredPositionX` 上 —— 运行时场景节点长这样（2026-09-24 实测）：
 * `{id, parent, z, group, matrix:{a,b,c,d,tx,ty}, kind, name, sourceWidth, sourceHeight, pressed}`，
 * 所以「控件移动了」表现为 **`matrix.tx/ty` 变了**。不摊开这一层，`changedControls` 会永远是空的（踩过）。
 */
function scalarFields(node, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(node || {})) {
    if (k === 'children') continue;
    if (v === null || typeof v !== 'object') out[prefix + k] = v;
    else if (!Array.isArray(v)) scalarFields(v, prefix + k + '.', out);
  }
  return out;
}

/** 哪些控件的哪些字段变了（`{id,name,fields:{字段:[旧,新]}}`）—— 比"像素变了"更能直接定位。 */
function changedFields(prev, next, limit = 20) {
  const out = [];
  for (const [id, node] of next) {
    const before = prev.get(id);
    if (!before) { out.push({ id, name: node.name || '', fields: { '(新增)': [null, node.kind || ''] } }); continue; }
    const a = scalarFields(before);
    const b = scalarFields(node);
    const fields = {};
    for (const key of Object.keys(b)) {
      if (a[key] === b[key]) continue;
      fields[key] = [a[key] === undefined ? null : a[key], b[key]];
    }
    for (const key of Object.keys(a)) if (!(key in b)) fields[key] = [a[key], null];
    if (Object.keys(fields).length) out.push({ id, name: node.name || '', fields });
  }
  for (const [id, node] of prev) if (!next.has(id)) out.push({ id, name: node.name || '', fields: { '(移除)': [node.kind || '', null] } });
  let truncated = 0;
  if (out.length > limit) { truncated = out.length - limit; out.length = limit; }
  return { changed: out, truncated };
}

/** 事件 → worker 动作（`op=frames` 自己驱动时间，要逐个发出去）。 */
function eventToAction(e) {
  const p = e.payload || {};
  if (e.kind === 'key') return ['key', { key: p.typeName, light: true }];
  if (e.kind === 'pointer') return ['pointer', { type: p.type, x: p.x, y: p.y, light: true }];
  if (e.kind === 'click') return ['click', { name: p.name, light: true }];
  if (e.kind === 'view') return ['view', { playerIndex: p.playerIndex, light: true }];
  if (e.kind === 'serverSet') return ['serverSet', { entityType: p.entityType, name: p.name, value: p.value, light: true }];
  if (e.kind === 'serverSend') return ['serverSend', { name: p.name, params: p.params, target: p.target, light: true }];
  if (e.kind === 'pause') return ['pause', { light: true }];
  if (e.kind === 'resume') return ['resume', { light: true }];
  return null;
}

/* ------------------------------------------------- op=bind：工程适配（真机 → 模拟器） */

/** 能当模板的 kind（`server-container` 是容器本身，不是模板）。 */
const BIND_KINDS = Object.keys(KIND_LABELS).filter((k) => k !== 'server-container');

/**
 * `templates[].kind` 传 `"auto"` = **让工具自己试**：按这个顺序逐个起会话，谁让控件数增长就用谁。
 *
 * 为什么值得单独做一个（2026-09-25 同事实测）：`kind` 一直要调用方猜，而**猜错是静默的** ——
 * 控件类型不对时脚本设属性会报 `cannot set <字段>, no such field` 并中止，看起来"跑起来了"、
 * 其实什么都没建（唯一的痕迹是脚本自己 print 的那行）。顺序取最常用的三种：
 * 图片（绝大多数界面都是图片 / 色块拼的）→ 文本框 → 容器节点。
 */
export const AUTO_KIND = 'auto';

/** `kind:"auto"` 的候选顺序。 */
export const AUTO_KIND_ORDER = ['image', 'textbox', 'container'];

/**
 * `mount.assetType` 的**语境说明** —— 别让它在「挂载点」这个语境下误导人。
 *
 * 同事实测：回执里 `mount.assetType: "server-control-template"` 让人以为脚本挂错了地方，
 * 而 `op=controls` 里的真实拓扑是 `客户端控件容器(server-container) → 容器节点(container)` ——
 * 脚本挂的**就是客户端控件容器下面的那个容器节点**（真机上客户端脚本也是挂这儿）。
 */
export const MOUNT_ASSET_TYPE_NOTE = '`assetType` 是**控件模板资源**的名字'
  + '（模拟器里"服务端那份工程" = server-control-template / "客户端控件模板" = client-control-template），'
  + '**不代表脚本挂在"服务端"** —— 真机上客户端脚本就是挂在客户端控件容器的容器节点上，'
  + '看 `mount.parent` / `mount.isClientUI`（真实层级）而不是这个字段。';

/**
 * 挂载点的**真实层级**（`op=bind` 的 `mount` 回执用）——**纯函数**。
 * @param {Array<{id:string,name:string,kind:string,parentId?:string|null,ancestorIds?:string[]}>} rows 编辑器树行（`st.tree`）
 * @param {string} mountId 挂载点控件的 id
 * @returns {{parent:{name:string,kind:string}|null, ancestors:Array<{name:string,kind:string}>,
 *            isClientUI:boolean, clientUIRoot:{name:string,kind:string}|null}}
 *          `isClientUI` = 挂载点是否在「客户端控件容器」（kind `server-container`）下面
 */
export function mountHierarchy(rows, mountId) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.id), r]));
  const self = byId.get(String(mountId));
  if (!self) return { parent: null, ancestors: [], isClientUI: false, clientUIRoot: null };
  const ancestorIds = Array.isArray(self.ancestorIds) ? self.ancestorIds : [];
  const ancestors = ancestorIds
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((r) => ({ name: r.name, kind: r.kind }));
  const parentRow = self.parentId == null || self.parentId === '' ? null : byId.get(String(self.parentId));
  const clientUIRoot = ancestors.find((r) => r.kind === 'server-container') || null;
  return {
    parent: parentRow ? { name: parentRow.name, kind: parentRow.kind } : null,
    ancestors,
    // 在客户端控件容器下面 = 真机上客户端脚本该在的位置
    isClientUI: !!clientUIRoot,
    clientUIRoot,
  };
}

/**
 * 「控件数一个都没涨」时的指路文案。
 *
 * ⚠️ 基线取**编辑器工程里的控件数**（`editorControlCount`）：运行时树拍平出来的那批正好就是它
 * （实测 fresh 时两边都是 1、keepFactory 时两边都是 11）—— 所以「`run.controlCount` 没有比它大」
 * 就等于「脚本一个控件都没建出来」。
 */
export function kindMismatchHint(baseline, controlCount, triedAll) {
  const head = '运行时控件数（' + controlCount + '）没有比编辑器工程里的（' + baseline + '）多 —— '
    + '**可能一个控件都没建出来**：kind 猜错时脚本会静默什么都不建（不报错，只有脚本自己的 print 留痕）。';
  if (triedAll) {
    return head + '`kind:"auto"` 已经把候选（' + AUTO_KIND_ORDER.join(' / ') + '）都试过了 —— '
      + '那就看 `run.logs` 里脚本自己 print 了什么。';
  }
  return head + '可试的候选：' + AUTO_KIND_ORDER.join(' / ') + '，或传 `kind:"auto"` 让工具按这个顺序自己试一遍。';
}

/** 真机交接的 id（控件模板索引 / 容器节点索引）都在这个量级以上。 */
const HANDOVER_MIN = 1073741824;

/**
 * 交接的**模板清单**：`[{guid, kind, name?}]`。
 *
 * `guid` 有三个来源，**优先自动拿**：① `op=handover`（可带 `source` 读任意本地 .lua）从源码抽 →
 * ② `miliastra_map op=clientui` 从 `.gil` 读模板索引 → ③ 两个都拿不到才问创作者。**仍然不许编** ——
 * 编造一个号的后果是脚本 `InstantiateClientUIControl()` 永远解析不到它，而且**不报错**（静默什么都不建）。
 * 所以这里宁可报错也不给默认值。
 */
function normalizeBindTemplates(raw) {
  const list = Array.isArray(raw) ? raw.filter((t) => t && typeof t === 'object') : [];
  if (!list.length) {
    throw new Error('op=bind 需要 templates:[{guid,kind,name?}] —— guid 是**控件模板索引**（优先自动拿：op=handover 从源码抽 / miliastra_map op=clientui 从 .gil 读；都拿不到才问创作者，仍然不许编），kind 是控件类型。例：'
      + '{"op":"bind","source":"D:\\\\…\\\\双相.lua","templates":[{"guid":1073741868,"kind":"image","name":"图片模板"},'
      + '{"guid":1073741867,"kind":"textbox","name":"文本框模板"}],"containerId":1073741866}');
  }
  const seen = new Set();
  return list.map((t, i) => {
    const guid = Number(t.guid);
    if (!Number.isSafeInteger(guid) || guid <= 0) {
      throw new Error('templates[' + i + '].guid 必须是正整数（真机交接的控件模板索引），收到 ' + JSON.stringify(t.guid));
    }
    if (seen.has(guid)) throw new Error('templates[' + i + '].guid ' + guid + ' 与前面重复（同一模板索引只能有一个模板）');
    seen.add(guid);
    const kind = String(t.kind || '');
    // `auto` 额外允许：让工具按 AUTO_KIND_ORDER 自己试（`kind` 猜错是**静默**的，这条是给人的兜底）
    if (kind !== AUTO_KIND && BIND_KINDS.indexOf(kind) < 0) {
      throw new Error('templates[' + i + '].kind 必须是 ' + BIND_KINDS.join(' / ') + ' / ' + AUTO_KIND + ' 之一，收到 ' + JSON.stringify(t.kind));
    }
    return {
      guid, kind,
      name: t.name ? String(t.name) : ((KIND_LABELS[kind] || '自动') + '模板'),
      id: t.id ? String(t.id) : undefined,
    };
  });
}

/**
 * 读**一份**要绑的 Lua：`{path, source}`（内联源码）或 `{path, sourceFrom}`（要读的 .lua **绝对路径**）。
 *
 * 挂载名（`script.path`）：真机的挂载名是创作者给的（双相的 `checkMount()` 就拿它跟脚本名比对）。
 * 缺省用文件名（含 .lua）。`sourceFrom` / `source` 两个字段名与 `op=patch addScript` 一致，
 * 免得同一件事在两处叫两个名字（反馈 B1/B4）。
 */
async function readOneBindScript(spec = {}) {
  const inline = typeof spec.source === 'string' && spec.source.trim() ? spec.source : '';
  const fromRaw = String(spec.sourceFrom || spec.from || '').trim();
  let source = inline;
  let file = '';
  let mtimeMs = 0;
  if (!source) {
    if (!fromRaw) {
      throw new Error('op=bind 的每一份脚本都要给 `source`（内联源码）或 `sourceFrom`（.lua 的**绝对路径**）——'
        + '收到 ' + JSON.stringify(spec.path || '(没写 path)') + ' 这一份什么都没有');
    }
    const abs = path.resolve(fromRaw);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      throw new Error('op=bind: 读不到 Lua 文件 ' + abs + '（' + ((e && e.message) || e) + '）——路径要绝对路径，且必须是**活文件**（沙箱里那份 .lua）');
    }
    source = buf.toString('utf8');
    mtimeMs = fs.statSync(abs).mtimeMs;
    file = abs;
  } else {
    file = String(spec.file || '').trim();
  }
  const scriptPath = String(spec.path || (file ? path.basename(file) : '') || 'script.lua');
  const stem = scriptPath.replace(/\.lua$/i, '') || 'script';
  const bytes = Buffer.byteLength(source, 'utf8');
  return {
    source,
    path: scriptPath,
    stem,
    meta: {
      file: file || null,
      path: scriptPath,
      bytes,
      lines: source ? source.split(/\r?\n/).length : 0,
      sha1_12: crypto.createHash('sha1').update(source, 'utf8').digest('hex').slice(0, 12),
      mtime: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      // 只是提示，不改写用户给的名字：命名是创作者的事
      pathHint: /\.lua$/i.test(scriptPath) ? null : 'path 没有 `.lua` 后缀 —— 若脚本用 `script.path` 自查挂载名（去掉 .lua 后比对），就会不匹配而自己退出。',
    },
  };
}

/**
 * 要绑的 Lua **清单** —— 反馈 B4：一次挂多个。
 *
 * 三种写法（都是同一份 `readOneBindScript`，所以字段语义不会两处漂移）：
 *   ① `scripts:[{path, source|sourceFrom}, …]` —— **多脚本工程用这个**；
 *   ② `source`（单个绝对路径）+ 可选 `scriptName` —— 老写法，行为一个字不改；
 *   ③ `script:{path, source}` —— 直接给源码。
 */
async function readBindScripts(args = {}) {
  const list = Array.isArray(args.scripts) ? args.scripts.filter((x) => x && typeof x === 'object') : [];
  if (list.length) {
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      out.push(await readOneBindScript({
        path: row.path,
        source: row.source,
        sourceFrom: row.sourceFrom || row.file,
      }));
    }
    const paths = new Set();
    for (const s of out) {
      if (paths.has(s.path)) throw new Error('scripts[].path 重复：' + s.path + '（同一份工程里脚本路径必须唯一，否则分不清哪份是哪份）');
      paths.add(s.path);
    }
    return out;
  }
  const inline = args.script && typeof args.script === 'object' ? args.script : null;
  return [await readOneBindScript({
    path: (inline && inline.path) || args.scriptName,
    source: inline && typeof inline.source === 'string' ? inline.source : '',
    sourceFrom: args.source || (inline && inline.file) || '',
  })];
}

/* ------------------------------------- op=patch 的**字段白名单**（P1-2 / P1-3，2026-09-26） */

/**
 * 每个 patch op **只认自己的字段** —— 未知字段一律**报错并点名**。
 *
 * 为什么必须做（两条都是实测踩到的）：
 *   · P1-2：`{"op":"add","kind":"textbox","name":"t1_kb_state","text":"stage=…"}` 回 `applied:"add"`，
 *     而 inspector 里 `text` 仍是 `""` —— **`text` 被静默吞掉**，需要再补一次 `set`。
 *     对「用状态串驱动界面」的工程，这是**静默失败**（AI 以为设好了）。
 *   · P1-3：`{"op":"set","id":"n12","field":"text","value":"…"}` ⇒ 引擎里 `key.startsWith` 读到 undefined，
 *     回一句 JS 内部错 `Cannot read properties of undefined (reading 'startsWith')`，
 *     看起来像插件 bug，AI 只能靠试参数名。
 *
 * 这份表是**工具层**的（不是引擎的）：引擎仍然按自己的语义执行，这里只保证
 * 「传错的字段名**不会静默消失**」—— 报错文案照抄本仓 `addScript` 已有的那句风格。
 */
export const PATCH_OP_FIELDS = {
  add: ['op', 'parentId', 'kind', 'name', 'text', 'expectedRevision'],
  addTemplate: ['op', 'kind', 'name', 'guid', 'id', 'expectedRevision'],
  set: ['op', 'id', 'path', 'key', 'value', 'expectedRevision'],
  remove: ['op', 'id', 'path', 'expectedRevision'],
  setCanvas: ['op', 'canvasId', 'expectedRevision'],
  select: ['op', 'id', 'path', 'expectedRevision'],
  pick: ['op', 'x', 'y', 'expectedRevision'],
  reparent: ['op', 'id', 'path', 'parentId', 'expectedRevision'],
  moveSibling: ['op', 'id', 'path', 'direction', 'expectedRevision'],
  newAsset: ['op', 'assetType', 'expectedRevision'],
  replace: ['op', 'project', 'expectedRevision'],
  addScript: ['op', 'id', 'controlId', 'controlAsset', 'path', 'source', 'sourceFrom', 'expectedRevision'],
  updateScript: ['op', 'id', 'controlId', 'controlAsset', 'path', 'source', 'sourceFrom', 'expectedRevision'],
  removeScript: ['op', 'id', 'path', 'expectedRevision'],
};

/** `add` 只对这两种控件有意义地收 `text`（其余 kind 传了就是**传错**，不许静默忽略）。 */
export const TEXT_KINDS = new Set(['textbox', 'textwindow']);

/**
 * `miliastra_sim op=patch` 的**入口校验** —— 纯函数（不碰引擎），可单测。
 *
 * @param {any} patch 调用方给的那一份
 * @param {{settableKeys?: string[]|null}} [opts] `set` 报错时要列出的「该控件可设的 key」
 * @returns {{patch: any, text?: string|null, note?: string, interpreted?: string}}
 *          `text` 非 null = 这个 `add` 还要补一次 `set key=text`（Host 侧接着做）
 * @throws {Error} 未知 op / 未知字段 / `set` 缺 key / `add` 的 `text` 用在非文本控件上
 */
export function validatePatchFields(patch, { settableKeys = null } = {}) {
  if (!patch || typeof patch !== 'object') throw new Error('op=patch 需要 patch 对象，例如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题"}');
  const op = String(patch.op || '');
  const known = PATCH_OP_FIELDS[op];
  if (!known) {
    throw new Error('未知 patch op：' + JSON.stringify(op || patch.op)
      + '　可用：' + Object.keys(PATCH_OP_FIELDS).join(' / ')
      + '　（你传的字段：' + Object.keys(patch).join(' / ') + '）');
  }
  const unknown = Object.keys(patch).filter((k) => known.indexOf(k) < 0);

  // `set`：把「传了 field」单独拎出来说人话（这是实测踩到的那一条）
  if (op === 'set') {
    const keysHint = (keys) => (Array.isArray(keys) && keys.length
      ? '　该控件可设的 key（' + keys.length + ' 个）：' + keys.join(' / ')
      : '　（拿不准就先用 op=controls 看这个控件的 kind / 属性）');
    if (unknown.indexOf('field') >= 0) {
      throw new Error('`set` 需要 {op, id, key, value}；你传了 `field` —— 是不是想传 `key`？'
        + '（`path` 只有脚本类 op 用，例如 updateScript / removeScript —— 不过控件类 op（set/remove/select/reparent/moveSibling）的目标现在也可以用 `path` 按名字/名字路径给）' + keysHint(settableKeys));
    }
    if (unknown.length) {
      throw new Error('`set` 不认这些字段：' + unknown.join(' / ') + '。这次还传了：' + Object.keys(patch).join(' / ')
        + '　—— `set` 需要 {op, id, key, value}（+ 可选 expectedRevision）' + keysHint(settableKeys));
    }
    const hasKey = patch.key !== undefined && patch.key !== null && String(patch.key) !== '';
    if (!hasKey) {
      throw new Error('`set` 缺 `key`（要改哪个字段？）+ `value`。' + keysHint(settableKeys));
    }
    return { patch };
  }

  if (unknown.length) {
    const extra = op === 'add'
      ? '　（`add` 的字段：' + known.join(' / ') + '）'
      : '';
    throw new Error('`' + op + '` 不认这些字段：' + unknown.join(' / ')
      + '　—— 每个 op 只认自己的字段，传错名字不会被静默忽略' + extra
      + '。这次传的是：' + Object.keys(patch).join(' / '));
  }

  if (op === 'add' && patch.text !== undefined && patch.text !== null) {
    const kind = String(patch.kind || '');
    if (!TEXT_KINDS.has(kind)) {
      throw new Error('`add` 的 `text` 只有 textbox / textwindow 能用，而这次 kind=' + JSON.stringify(patch.kind || null)
        + '　—— 换个 kind，或先 add 再用 `set {op:"set",id:…,key:…,value:…}` 设那个控件**真正有的**字段。');
    }
    return { patch, text: String(patch.text), note: '`add` 的 `text` 会**在建好之后**紧接着补一次 set key=text（引擎的 add 本身不收 text）' };
  }
  return { patch };
}

/**
 * `op=patch` 里**脚本类操作**的入口校验与字段归一 —— **纯函数**（读文件靠注入的 `readFile`，好单测）。
 *
 * 为什么要有它（反馈 B1/B2，2026-09-25 同事实测）：
 *   · `addScript` **只认内联 `source`** —— 传 `sourceFrom:"C:\\…\\表现 view.lua"` 被**静默忽略**，
 *     于是 5 个脚本全变成空源码，运行时才报 `表现 view.lua:1: unfinished long string (starting at line 1) near <eof>`，
 *     而且**只有脚本自己的 print 看得见**（排障绕了一大圈）；
 *   · `removeScript` **只认 `id`** —— 传 `path` 时报 `脚本不存在: undefined`（它读的是 `id`），
 *     人只能靠猜参数名（试了两轮）。
 *
 * 所以这里只做两件事：**把 `sourceFrom` / `path` 归一成引擎认的字段**；**缺什么就明确说缺什么**
 * （宁可拒绝，也不给用户写一个空脚本进去）。
 *
 * @param {any} patch 调用方给的那一份
 * @param {Array<{id?:any, path?:any}>} [scripts] 当前工程里的脚本（用于 `path` → `id`）
 * @param {(p:string)=>string} [readFile] `sourceFrom` 的读文件实现（缺省=不读，交给 simOp 注入）
 * @returns {{patch: object}} 归一后**真正交给引擎**的那一份
 */
export function normalizeScriptPatch(patch, scripts = [], readFile = null) {
  const op = String((patch && patch.op) || '');
  if (op !== 'addScript' && op !== 'updateScript' && op !== 'removeScript') return { patch };
  const out = { ...patch };
  const list = (Array.isArray(scripts) ? scripts : []).filter((s) => s && typeof s === 'object');
  const label = (s) => (s.path ? String(s.path) + '(' + String(s.id) + ')' : String(s.id));
  const have = list.map(label).join(' / ') || '（一个都没有）';

  if (op === 'removeScript' || op === 'updateScript') {
    const hasId = out.id !== undefined && out.id !== null && String(out.id) !== '';
    const wantPath = out.path !== undefined && out.path !== null && String(out.path) !== '' ? String(out.path) : '';
    if (!hasId && wantPath) {
      const hits = list.filter((s) => String(s.path) === wantPath);
      if (!hits.length) {
        throw new Error('未找到该脚本 ' + JSON.stringify(wantPath) + ' —— 现有脚本：' + have
          + '。`path` 必须与工程里的脚本路径**完全一致**（也可以直接传 `id`）。');
      }
      if (hits.length > 1) {
        throw new Error('脚本路径 ' + JSON.stringify(wantPath) + ' 对应 ' + hits.length + ' 条脚本（同 path 被 addScript 加过多次）——'
          + '请改用 `id` 指定：' + hits.map((s) => String(s.id)).join(' / '));
      }
      out.id = hits[0].id;
    } else if (!hasId) {
      throw new Error('缺少 `id`（也可传 `path`）—— 现有脚本：' + have);
    }
    if (op === 'removeScript') return { patch: out };
  }

  const fromRaw = out.sourceFrom === undefined || out.sourceFrom === null ? '' : String(out.sourceFrom).trim();
  const hasInline = typeof out.source === 'string' && out.source.length > 0;
  if (fromRaw && hasInline) {
    throw new Error('`source` 与 `sourceFrom` 只能给一个：`source` 是内联源码、`sourceFrom` 是要读的 .lua **绝对路径**。');
  }
  if (fromRaw) {
    if (typeof readFile !== 'function') throw new Error('内部错误：sourceFrom 没有可用的读文件实现（请把它当 bug 报）');
    let text;
    try {
      text = readFile(fromRaw);
    } catch (e) {
      throw new Error('读不到 `sourceFrom` 指定的文件 ' + JSON.stringify(fromRaw) + '（' + ((e && e.message) || e) + '）');
    }
    out.source = text;
    delete out.sourceFrom;
    return { patch: out };
  }
  if (op === 'addScript' && !hasInline) {
    /*
     * ★ 这一条是整段的重点：**不传 source 时明说并拒绝**。
     *   以前的实现会静默按空源码写进去 —— 空源码在 Lua 里是「未闭合的长字符串」，
     *   报错发生在运行时、而且只有脚本自己的 print 看得见。
     */
    const known = ['op', 'id', 'path', 'source', 'sourceFrom', 'controlId', 'controlAsset', 'expectedRevision'];
    const ignored = Object.keys(patch).filter((k) => known.indexOf(k) < 0);
    throw new Error('addScript 缺源码：要给 `source`（内联源码）或 `sourceFrom`（.lua 的**绝对路径**，工具会替你读）。'
      + '**不会给你写一个空脚本**（空源码在 Lua 里是「未闭合的长字符串」，报错要到运行时才看得见）。'
      + (ignored.length ? ' 这次还传了这些字段：' + ignored.join(' / ') + ' —— 它们不是源码字段（`sourceFrom` 才是路径那一个）。' : ''));
  }
  return { patch: out };
}

/**
 * 交接值交叉核对（**启发式**）：源码里 10 位以上的整数几乎必然就是真机 id。
 * 意义是把「模板索引交错了」这类事故在跑之前就摆出来 —— 它不是判决。
 */
function checkHandover(source, templates, containerId) {
  const text = String(source || '').slice(0, 200000);
  const nums = new Set();
  const re = /(?:^|[^0-9])(\d{10,})(?![0-9])/g;
  let m = re.exec(text);
  while (m !== null) {
    const n = Number(m[1]);
    if (n >= HANDOVER_MIN) nums.add(n);
    m = re.exec(text);
  }
  const given = templates.map((t) => t.guid);
  const givenSet = new Set(given);
  const container = Number(containerId) || 0;
  return {
    templatesGiven: given,
    idsInSource: [...nums].sort((a, b) => a - b),
    missing: given.filter((g) => !nums.has(g)),
    extra: [...nums].filter((n) => !givenSet.has(n)).sort((a, b) => a - b),
    containerId: container || null,
    containerIdInSource: container ? nums.has(container) : null,
    note: '启发式（源码里 10 位以上的整数 ≈ 真机交接值），不是判决：`missing` = 你交了的模板索引在源码里找不到（多半交错了）；'
      + '`extra` = 源码里有、你没交的（脚本可能还要建别的模板）。',
  };
}

/* ---------------------------------------- op=cases：用例清单（人/AI 共用的一份验收单） */

const CASES_FORMAT = 'qxqy-simulator-cases';

/** 清单就放在模拟器工作区里（`<数据目录>/simulator/cases.json`）—— 不碰游戏存档。 */
function casesPath() {
  return path.join(simWorkspace(), 'cases.json');
}

function readCasesFile() {
  const file = casesPath();
  const empty = { format: CASES_FORMAT, version: 1, updated: null, sets: {} };
  if (!fs.existsSync(file)) return empty;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('用例清单读不动（' + file + '）：' + ((e && e.message) || e) + ' —— 它是 JSON；手改坏了就直接删这个文件重建');
  }
  if (!raw || typeof raw !== 'object' || !raw.sets || typeof raw.sets !== 'object') return empty;
  return raw;
}

function writeCasesFile(doc) {
  const file = casesPath();
  doc.format = CASES_FORMAT;
  doc.version = 1;
  doc.updated = new Date().toISOString();
  atomicWriteJson(file, doc);
  return file;
}

/** `set` 报错时要列出的「该控件可设的 key」—— 只有两类是**按控件类型推断**的，其余是布局通用键。 */
const SET_LAYOUT_KEYS = [
  'posX', 'posY', 'width', 'height', 'anchorType', 'rotationZ',
  'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY', 'syncAllDevices',
];

/** 控制器里按 id（省略 = 当前选中）找一个节点对象；找不到返回 null。 */
function nodeById(root, wantId) {
  let hit = null;
  const walk = (n) => {
    if (!n || hit) return;
    if (String(n.id) === String(wantId)) { hit = n; return; }
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return hit;
}

/**
 * 某个控件**可设的 key 列表**（给 `set` 的报错做人话提示）—— 实测派生的，不写死全集：
 *   · **按控件类型**：节点对象上真正存在的字段 ∩ 引擎 `DIRECT_FIELDS`（`textbox` 才有 `text`、`image` 才有 `fillType`…）；
 *   · **布局通用键**：`posX/width/anchorMinX…`（引擎对任何控件都收）；
 *   · **`giaRaw.*`**：节点自己的原始字段表（`giaRaw` 的键）。
 * 拿不到节点（id 不存在）就只给布局通用键 + `giaRaw.*` 说明 —— 宁可少列，不列错的。
 */
function settableKeysOf(controller, id) {
  const st = controller.get();
  const root = st && st.root ? st.root : null;
  const wantId = id !== undefined && id !== null && String(id) !== '' ? id : (st && st.selectedId);
  const node = root && wantId ? nodeById(root, wantId) : null;
  const keys = new Set(SET_LAYOUT_KEYS);
  if (node) {
    for (const k of Object.keys(node)) if (DIRECT_FIELDS.has(k)) keys.add(k);
    for (const k of Object.keys(node.giaRaw || {})) keys.add('giaRaw.' + k);
  } else {
    keys.add('giaRaw.<字段>');
  }
  return [...keys];
}

/* ------------------------------------- op=verify 的 expect 白名单（P1-4，2026-09-26） */

/**
 * 每种断言 `kind` **允许哪些字段** —— 未知字段 = **参数错**，不是"断言没过"。
 *
 * 为什么必须做（P1-4 实测）：`{"kind":"log","contains":"首错","absent":true}`（想做"这条日志不该出现"）
 * 回的是 `passed:false` + `actual=整段日志` + `hint:"第 3 条断言没过"` —— 真实原因只是 **`absent` 不受支持**
 * （被静默忽略了），人/AI 却会去查一个**不存在的逻辑问题**（那次先怀疑"首错"真的出现了）。
 *
 * ⚠️ `absent` 现在**真的实现了**（引擎 `autotest/assert.js`）：加在 log/control/var/signal/tree 上 = 「不该存在」；
 * `controlAbsent` 是它的语法糖（`{"kind":"controlAbsent","name":"提示"}`）。
 */
export const EXPECT_KINDS = {
  log: ['kind', 'at', 'contains', 'level', 'source', 'absent'],
  control: ['kind', 'at', 'id', 'name', 'field', 'equals', 'absent'],
  var: ['kind', 'at', 'entityType', 'name', 'equals', 'absent'],
  signal: ['kind', 'at', 'name', 'direction', 'values', 'absent'],
  tree: ['kind', 'at', 'name', 'exists', 'absent'],
  count: ['kind', 'at', 'name', 'controlKind', 'equals', 'atLeast'],
  controlAbsent: ['kind', 'at', 'id', 'name'],
  lua: ['kind', 'at', 'source'],
};

/**
 * `expect[]` 的**入口校验**（纯函数，可单测）：未知 kind / 未知字段 / 缺必填 → 抛**参数错**。
 *
 * @param {any} row 一条断言
 * @param {number} i 序号（报错里点出来）
 * @returns {{assert: any}} 归一后交给引擎的那一份（`controlAbsent` 会被翻成 `control{absent:true}`）
 * @throws {Error}
 */
export function validateExpect(row, i = 0) {
  const at = 'expect[' + i + ']';
  if (!row || typeof row !== 'object') throw new Error(at + ' 必须是一个对象（如 {"kind":"log","contains":"就绪"}）');
  const kind = String(row.kind || '');
  if (!kind) {
    throw new Error(at + ' 缺 `kind`　可用：' + Object.keys(EXPECT_KINDS).join(' / ')
      + '　例如 {"kind":"log","contains":"SCORE"}');
  }
  const allowed = EXPECT_KINDS[kind];
  if (!allowed) {
    throw new Error(at + ' 的 kind=' + JSON.stringify(kind) + ' 不存在　可用：' + Object.keys(EXPECT_KINDS).join(' / ')
      + '（`count` 用来数"建了几个"；"不该存在"用 `absent:true` 或 `controlAbsent`）');
  }
  const unknown = Object.keys(row).filter((k) => allowed.indexOf(k) < 0);
  if (unknown.length) {
    throw new Error(at + '（kind=' + kind + '）不认这些字段：' + unknown.join(' / ')
      + '　该 kind 允许的字段：' + allowed.join(' / ')
      + '　—— 字段写错**不是断言没过**，所以这里直接报参数错（旧版会静默忽略，让断言"莫名失败"）');
  }
  const missing = (name) => row[name] === undefined || row[name] === null || String(row[name]) === '';
  if (kind === 'log' && missing('contains')) {
    throw new Error(at + '（log）缺 `contains`（要找的正文子串）'
      + (row.absent ? '　—— `absent:true` 时它表示"这条**不该**出现"' : ''));
  }
  if ((kind === 'tree' || kind === 'controlAbsent' || kind === 'control') && missing('name') && missing('id')) {
    throw new Error(at + '（' + kind + '）要 `id` 或 `name`（`tree` 只能按 `name` 找）');
  }
  if (kind === 'control' && row.absent !== true) {
    if (missing('field')) throw new Error(at + '（control）缺 `field`（要查哪个字段）');
    if (row.equals === undefined) throw new Error(at + '（control）缺 `equals`（期望值；要"不该存在"用 kind:"controlAbsent"）');
  }
  if (kind === 'var' && (missing('entityType') || missing('name'))) throw new Error(at + '（var）要 `entityType` + `name`');
  if (kind === 'var' && row.equals === undefined && row.absent !== true) throw new Error(at + '（var）缺 `equals`（期望值）');
  if (kind === 'signal' && missing('name') && row.absent !== true) throw new Error(at + '（signal）要 `name`');
  if (kind === 'signal' && row.values === undefined && row.absent !== true) throw new Error(at + '（signal）要 `values`（期望值）');
  if (kind === 'count' && row.equals === undefined && row.atLeast === undefined) throw new Error(at + '（count）要 `equals` 或 `atLeast`');
  if (kind === 'lua' && missing('source')) {
    throw new Error(at + '（lua）缺 `source`（一段 Lua；**返回值被忽略**，跑完不报错就算过 —— 要判失败得自己 error()/assert()）');
  }
  if (kind === 'tree' && row.exists === undefined && row.absent !== true) {
    throw new Error(at + '（tree）要 `exists:true|false`（或 `absent:true`）');
  }
  // 语法糖：`controlAbsent{name}` → `control{name, absent:true}`
  if (kind === 'controlAbsent') {
    const out = { kind: 'control', absent: true };
    if (row.at !== undefined) out.at = row.at;
    if (row.id !== undefined) out.id = row.id;
    if (row.name !== undefined) out.name = row.name;
    return { assert: out };
  }
  return { assert: Object.assign({}, row) };
}

/** 清单里的一条 = 自动用例（events+asserts）或**人工项**（`manual:true`，要人看画面/真机确认）。 */
function normalizeBookCase(raw, fallbackName) {
  const row = raw && typeof raw === 'object' ? raw : {};
  if (row.manual === true) {
    if (!row.note) throw new Error('人工项（manual:true）必须带 note：写清"人要看什么、看到什么算过"');
    /*
     * ★ P2-1（2026-09-26）：`name` 缺省时用 **note 的前 ~20 字**。
     *   旧行为是 `'<set> 用例 N'` —— 跑清单时人看到的是「用例 3」，**不知道要验什么**
     *   （note 里明明写着「真机上要看到…」）。显式传 `name` 照样覆盖。
     */
    const fallback = shortNoteName(row.note) || fallbackName;
    return { name: String(row.name || fallback || '人工项'), manual: true, note: String(row.note) };
  }
  const spec = normalizeCaseSpec(row, fallbackName);
  const note = row.note ? String(row.note) : '';
  return note ? Object.assign({}, spec, { note }) : spec;
}

/**
 * 把一句 note 压成「能当名字看」的短标签（**纯函数**，可单测）。
 *
 * 规则（都为了「一眼认得出」）：折叠空白 → 取前 20 字 → 去掉结尾的逗号/句号/分号/冒号/顿号。
 * 取不出东西（空 note）返回 `''`（调用方再退回 `'<set> 用例 N'`）。
 */
export function shortNoteName(note, maxLen = 20) {
  const s = String(note == null ? '' : note).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.length > maxLen ? s.slice(0, maxLen) : s;
  return cut.replace(/[,，.。;；:：、]+$/g, '') || cut;
}

/** 清单概览的一行（不给全量 events，省 token；要看全量用 action=show）。 */
function bookCaseRow(c) {
  return {
    name: c.name,
    kind: c.manual ? 'manual' : 'auto',
    events: c.manual ? 0 : (c.events || []).length,
    asserts: c.manual ? 0 : (c.asserts || []).length,
    note: c.note || '',
  };
}

function caseSetOrThrow(doc, name) {
  const key = String(name || '');
  if (!key) throw new Error('要指定 set（用例集的名字）。现有的：' + (Object.keys(doc.sets).join(' / ') || '（空）'));
  const set = doc.sets[key];
  if (!set) throw new Error('用例清单里没有「' + key + '」（现有的：' + (Object.keys(doc.sets).join(' / ') || '（空）') + '）—— 先 op=cases action=add set=… 存一条');
  return set;
}

/* ------------------------------------------------- op=bind 的"配方"（重启后可一键重搭） */

const BIND_RECIPE = 'last-bind.json';

function bindRecipePath() {
  return path.join(simWorkspace(), BIND_RECIPE);
}

/** 上次 `op=bind` 用的配方（源文件 + 交接值）。读不到就回 null —— 不报警。 */
function readBindRecipe() {
  try {
    const raw = JSON.parse(fs.readFileSync(bindRecipePath(), 'utf8'));
    return raw && typeof raw === 'object' && raw.source ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 记下这次 bind 的配方。
 *
 * 为什么要有它：**Host 是启动时的快照** —— 每次重启 `dsh web`，模拟器内存里的工程都回到出厂默认
 * （用户 2026-09-24 实测：重启后试玩页里只剩默认的「文本 / 预设按钮 / 五角星」，看着像"什么都没画"）。
 * 把"用哪些交接值搭的"落一份小配方在模拟器工作区，重启后就能 `op=bind last:true` 一键重搭
 * （**不自动重搭** —— 那会在人没要求的时候改工程）。
 */
function writeBindRecipe(recipe) {
  const file = bindRecipePath();
  atomicWriteJson(file, recipe);
  return file;
}

/**
 * 从 Lua 源码里**抽候选交接值**（纯函数，可单测）。
 *
 * 交接值的老毛病：创作者给号，抄错一位 → 脚本 `InstantiateClientUIControl` 静默什么都不建。
 * 源码里一般写着 `local IMAGE_TEMPLATE = 1073741868` 这种常量，所以「读源码里的 9 位以上大整数」
 * 能把**真值**摆出来，而不是靠人抄。`kindHint` 只看变量名（IMAGE/TEXT/CONTAINER…）——
 * **只是提示**：控件类型猜错同样是静默失败，必须由人 / 创作者确认。
 *
 * ★ 2026-09-25（作者报的缺陷）：**两种写法都要认** ——
 *   ① `local NAME = 1073741868`（裸 local 常量）；
 *   ② `prefabImage = 1073741852` / `CONFIG.prefabImage = 1073741852`（表字段 / 限定名）。
 *   ② 是真机脚本里很常见的写法（作者那份 `背景图片.lua` 就是
 *   `CONFIG = { containerNodeIndex = 1073741845, prefabImage = 1073741852, prefabTextBox = 1073741850 }`）——
 *   只认 ① 时那份脚本**一条候选都抽不出来** ⇒ 面板候选表空 ⇒ 人只能手填 guid（正是要避免的事）。
 *   ⚠️ 放宽的只是**写法**：阈值一个字没动（仍要 ≥ `HANDOVER_MIN` = 1073741824）。
 */
function handoverCandidates(source) {
  const text = String(source || '').slice(0, 400000);
  const rows = [];
  const seen = new Set();
  const re = /([A-Za-z_][A-Za-z0-9_.]*)[^\S\n]*=[^\S\n]*([0-9]{9,})/g;
  let m = re.exec(text);
  while (m !== null) {
    const value = Number(m[2]);
    if (value >= HANDOVER_MIN && !seen.has(value)) {
      seen.add(value);
      // `CONFIG.prefabImage = …` 取最后一段当变量名（名字只用于提示 kind）
      const name = m[1].split('.').pop();
      let kindHint = null;
      let role = 'value';
      if (/IMAGE|IMG|PIC|图片|图/i.test(name)) kindHint = 'image';
      else if (/TEXT|TXT|LABEL|文本|文字|标签/i.test(name)) kindHint = 'textbox';
      else if (/BUTTON|按钮/i.test(name)) kindHint = 'button';
      else if (/CONTAINER|ROOT|PARENT|容器|挂载|父/i.test(name)) role = 'container';
      rows.push({
        name, value,
        line: text.slice(0, m.index).split('\n').length,
        kindHint, role,
        isTemplate: kindHint !== null && BIND_KINDS.indexOf(kindHint) >= 0,
      });
    }
    m = re.exec(text);
  }
  return rows;
}

/** 列出这台机器上的**活文件**（真机 .lua），并标出「当前正在开发的那张图」。 */
function liveFileRows() {
  const levels = scanLevels();
  const current = pickCurrent(levels);
  const rows = [];
  for (const lv of levels) {
    for (const f of (lv.luaFiles || [])) {
      rows.push({
        path: f.path,
        file: f.name,
        levelId: lv.levelId,
        accountId: lv.accountId,
        brand: lv.brand,
        bytes: f.size,
        mtime: f.mtime,
        auxiliary: !!f.auxiliary,
        current: !!(current && current.levelId === lv.levelId && current.accountId === lv.accountId),
      });
    }
  }
  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return {
    rows,
    currentLevel: current ? { levelId: current.levelId, accountId: current.accountId, brand: current.brand } : null,
  };
}

/* ---------------------------------------------------------------- 脚本按键扫描 */

/**
 * 剥掉 Lua 注释（**字符串照原样保留** —— 键名就住在字符串里）。
 *
 * 为什么需要它：`op=keys` 要扫"脚本里出现了哪些键名"，而被注释掉的绑定
 * （`-- bindHold("KeyboardMoveRightKeyDown", …)`）是**最常见的假阳性**来源；
 * 反过来，字符串里出现 `--`（比如一个 URL）又**不能**被当成行注释截断 —— 所以必须
 * 逐字符走、记着"当前在不在字符串里"，不能拿正则 `--.*$` 糊。
 */
export function stripLuaComments(src) {
  const s = String(src || '');
  let out = '';
  let i = 0;
  const n = s.length;
  /** `i` 处是不是长括号（`[` + k 个 `=` + `[`）：是就返回 k，否则 -1 */
  const longLevel = (at) => {
    if (s[at] !== '[') return -1;
    let j = at + 1;
    while (s[j] === '=') j += 1;
    return s[j] === '[' ? j - at - 1 : -1;
  };
  while (i < n) {
    // ① 注释：`--[[ … ]]` 是长注释，`-- …` 到行尾；两种都丢掉
    if (s[i] === '-' && s[i + 1] === '-') {
      const lv = longLevel(i + 2);
      if (lv >= 0) {
        const close = ']' + '='.repeat(lv) + ']';
        const end = s.indexOf(close, i + lv + 4);
        i = end < 0 ? n : end + close.length;
      } else {
        const nl = s.indexOf('\n', i);
        i = nl < 0 ? n : nl; // 换行留着（行号不至于全糊在一起）
      }
      continue;
    }
    // ② 长字符串：原样保留（内容里可能有键名）
    const lv = longLevel(i);
    if (lv >= 0) {
      const close = ']' + '='.repeat(lv) + ']';
      const end = s.indexOf(close, i + lv + 2);
      const stop = end < 0 ? n : end + close.length;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    // ③ 普通字符串：原样保留，转义不打断
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 从脚本源码里扫出"它可能要听的键名"，并**逐个标明来源**。
 *
 * ⚠️ 这是 2026-09-24 在真机关卡《冰镜·火烛》上实测暴露的漏检（详见 `docs/模拟器与视图.md`）：
 * 旧实现只认 `KeyEventType.X` / `KeyEventType["X"]`，而真实脚本的写法是**把键名当裸字符串传**：
 *
 *     local candidates = { "KeyEventType", ... }                        ← 只出现一次名字，扫不出键名（也不该）
 *     try(bindHold("KeyboardMoveRightKeyDown", "KeyboardMoveRightKeyUp", …))  ← ★ 旧实现完全看不到
 *
 * 后果很严重：脚本明明在听键盘（游戏日志白纸黑字 `收到首个按键事件: …（来源=KeyEventType）`），
 * `op=keys` 却回「脚本源码里没出现 KeyEventType」—— **AI 据此就会去猜按键名**，而猜错是静默失败。
 *
 * 所以现在两路都扫，并且**每条都带 `via`**：
 *   · `enum-member` / `enum-index` —— 写法明确，可信；
 *   · `string-literal` —— **启发式**（按官方命名：`Keyboard*` / `Controller*` 且以 `Down`/`Up` 结尾）。
 *     它可能是死分支、也可能只是被引用而没真监听 ⇒ 是**候选**不是判决。
 * 同一个名字两路都命中时，保留**更明确**的那个来源。
 */
export function scanScriptKeys(src) {
  const code = stripLuaComments(src);
  const rank = { 'enum-member': 3, 'enum-index': 2, 'string-literal': 1 };
  const found = new Map();
  const add = (name, via) => {
    if (!name) return;
    const prev = found.get(name);
    if (!prev || rank[via] > rank[prev]) found.set(name, via);
  };
  // 写法一：Enum.KeyEventType.X / Enum.KeyEventType["X"]
  const enumRe = /KeyEventType\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g;
  for (let m = enumRe.exec(code); m !== null; m = enumRe.exec(code)) {
    if (m[1]) add(m[1], 'enum-member'); else add(m[2], 'enum-index');
  }
  // 写法二：键名当裸字符串传（`bindHold("KeyboardMoveRightKeyDown", …)`）
  const litRe = /["']((?:Keyboard|Controller)[A-Za-z0-9_]*(?:Down|Up))["']/g;
  for (let m = litRe.exec(code); m !== null; m = litRe.exec(code)) add(m[1], 'string-literal');
  return [...found.entries()].map(([name, via]) => ({ name, via })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把运行中的**场景快照**摊平成一张表：每个控件的位置/尺寸/文字/按下态，坐标已经算成**世界坐标**。
 *
 * 为什么要有它（两次实测的教训）：
 *  ① `scene.nodes[].matrix.tx/ty` 是**相对父节点**的（容器根在 800,450）—— AI 自己算容易错；
 *  ② 一次 `get{inspect:true, view:true}` 加 `summaryOnly:false` 是 **75 KB**（真实关卡实测：tree + 31 节点场景），
 *     而 AI 往往只想知道"屏幕上有哪些字 / 能点哪儿"。让 Host 摊平完再回**紧凑行**，能省一个数量级。
 */
export function sceneNodes(snapshot) {
  const scene = snapshot && snapshot.scene;
  const nodes = Array.isArray(scene && scene.nodes) ? scene.nodes : [];
  const byId = new Map();
  for (const n of nodes) byId.set(Number(n && n.id), n);
  const worldOf = (node) => {
    let x = 0;
    let y = 0;
    let cur = node;
    for (let guard = 0; cur && guard < 64; guard += 1) {
      x += Number(cur.matrix && cur.matrix.tx) || 0;
      y += Number(cur.matrix && cur.matrix.ty) || 0;
      const pid = cur.parent;
      cur = (pid === null || pid === undefined) ? null : byId.get(Number(pid));
    }
    return { x, y };
  };
  return nodes.filter(Boolean).map((n) => {
    const p = worldOf(n);
    const row = {
      id: Number(n.id),
      kind: String(n.kind || ''),
      name: n.name === undefined || n.name === null ? '' : String(n.name),
      // 世界坐标四舍五入到 2 位：够点，又不会把回执撑大
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      width: Number(n.sourceWidth) || 0,
      height: Number(n.sourceHeight) || 0,
    };
    if (n.text !== undefined && n.text !== null && String(n.text) !== '') row.text = String(n.text);
    if (n.pressed === true) row.pressed = true;
    return row;
  });
}

/**
 * 从**运行中的快照**里只挑出"画面上的字"（`textbox` 控件的 `text`）。
 *
 * 为什么值得单开一个纯函数 + 一个 op：AI 想"边玩边判断"就必须能读游戏状态，
 * 而**读场景 get{view:true} 一次 ≈200ms、回几十 KB**（31 个控件的矩阵/尺寸/颜色全在里面）；
 * 真正要的往往只是 HUD 那两行字（关卡/分数）。实测（2026-09-24，真机关卡《冰镜·火烛》）：
 * 我为了拿到「第1关 教学（1/3） 分数 0」这句话，先 dump 了整个场景才发现 `textbox.text` 可读。
 */
export function hudTexts(snapshot) {
  return sceneNodes(snapshot)
    .filter((n) => n.kind === 'textbox')
    .map((n) => ({ id: n.id, text: n.text || '', x: n.x, y: n.y, width: n.width, height: n.height }));
}

export async function simOp(args = {}, ctx = {}) {
  const op = String(args.op || 'state');
  const controller = controllerFor(ctx);

  if (op === 'controls') {
    /*
     * 省 token 的控件清单。默认看**编辑器工程树**（写脚本时有什么可用）；
     * `runtime:true` 看**运行中的会话**（脚本运行时到底建出了什么）—— 不改状态（不暂停、不单步）。
     */
    const wantRuntime = args.runtime === true;
    if (!wantRuntime) {
      return { source: 'editor', ...compactControls(controller.get(), args) };
    }
    if (!controller.worker) {
      throw new Error('op=controls runtime:true 需要一个**在跑的会话**：先 `op=play action=start`（或 verify 时传 keepRunning:true）。'
        + '想看你脚本里「能建出什么」也可以先看编辑器工程树（不加 runtime）。');
    }
    /*
     * `geom:true`：把**几何**一并回（世界坐标 + 源尺寸 + 文字）—— 回答"屏幕上有哪些东西、能点哪儿"。
     * 实现上一次拿全：`get{inspect:true, view:true}`（引擎里这两段是**独立填充**的，能同时给；
     * ⚠️ 但它加 summaryOnly:false 是 **75 KB**（真实关卡实测），所以**摊平后只回紧凑行**）。
     */
    const wantGeom = args.geom === true;
    const live = await controller.play('get', wantGeom ? { inspect: true, view: true } : { inspect: true });
    const out = { source: 'runtime', running: true, ...compactControls(live, args) };
    if (wantGeom) {
      const geo = new Map(sceneNodes(live).map((n) => [n.id, n]));
      let covered = 0;
      out.controls = out.controls.map((row) => {
        const g = geo.get(Number(row.id));
        if (!g) return row;
        covered += 1;
        const boxed = { ...row, x: g.x, y: g.y, w: g.width, h: g.height };
        if (g.text) boxed.text = g.text;
        if (g.pressed) boxed.pressed = true;
        return boxed;
      });
      out.geomCovered = covered;
      out.geomMissing = Math.max(0, out.controls.length - covered);
      /*
       * ⚠️ 实测（2026-09-24，跑出来的）：**场景 ≠ 控件树**。`scene` 只含**会被渲染**的控件 ——
       * 工厂默认工程里 `tree` 有 11 行，而 `scene` 只有 5 个节点（`光标检测区域`/`网格视窗`/`按键提示` 这类没有画面）。
       * 所以"没有 x/y"**不等于**"控件不存在"，只等于"它现在不在画面上"。这条必须说清楚，否则 AI 会误判。
       */
      out.geomNote = '坐标是**世界坐标**（左下原点），可直接喂给 `op=play action=pointer/click`；`w/h` 是控件源尺寸（缩放前的）。'
        + '⚠️ 只有**出现在场景里（会被渲染）**的控件才有 `x/y` —— 实测同类差异：`tree` 11 行 / `scene` 5 个节点；'
        + '没坐标的（共 ' + out.geomMissing + ' 个）**不是不存在**，只是现在不在画面上（不可见/不渲染的控件）。'
        + '⚠️ 运行时实例**都叫模板名**，认人要靠 `id`、位置或 `text`。';
    }
    return out;
  }

  /*
   * `op=hud`：**只回画面上的字**（`textbox.text`）—— "边玩边判断"的最短路径。
   *
   * 为什么不让 AI 自己 `get{view:true}` 再翻：那一次 ≈200ms、几十 KB，而 AI 要的常常只是
   * HUD 那两行（关卡/分数/操作提示）。实测代价：2026-09-24 我为了读到「第1关 教学（1/3） 分数 0」，
   * 先 dump 了整个场景（31 个控件的矩阵/尺寸/颜色）才认出 `textbox.text` 这条路。
   */
  if (op === 'hud') {
    if (!controller.worker) {
      throw new Error('op=hud 需要一个**在跑的会话**：先 `op=play action=start`'
        + '（或 `op=verify ... keepRunning:true`）。想读编辑器里的控件用 `op=controls`。');
    }
    const snap = await controller.play('get', { view: true });
    const texts = hudTexts(snap);
    return {
      texts,
      lines: texts.map((t) => t.text),
      count: texts.length,
      frame: Number(snap && snap.frame) || 0,
      time: Number(snap && snap.time) || 0,
      note: '只回**文字**（textbox 控件的 `text` + 世界坐标，点击用得上）。'
        + '要看控件清单用 `op=controls runtime:true`；要看整棵场景树才用 `op=play action=get {view:true}`（≈200ms、大）。',
    };
  }

  if (op === 'state') {
    return slimState(controller.get(), { summaryOnly: args.summaryOnly !== false, treeLimit: Number(args.treeLimit) || 0 });
  }
  if (op === 'patch') {
    const patch = args.patch || args.p;
    if (!patch || typeof patch !== 'object') throw new Error('op=patch 需要 patch 对象，例如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题"}');
    /*
     * ★ 先过**字段白名单**（P1-2 / P1-3）：未知字段报错点名，`set` 传了 `field` 直接说人话并列出可设 key。
     *   `set` 的 key 提示要**真从控件类型推断**（节点对象上只有那个 kind 才有的字段），
     *   所以这里先按 `id`（或当前选中）把节点捞出来 —— 拿不到就退回"看 op=controls"。
     */
    const rawOp = String(patch.op || '');
    /*
     * ★ 2026-09-26（作者要求）：控件类 op 的目标可用 `path` 按**名字/名字路径**给
     *   （"容器节点/文本框" 或直接 "文本框"）。命中多个、或一个都没命中 → **报错不猜**；
     *   `id` 同时给时 `id` 优先（它是精确的），回执用 `resolvedBy` 披露按哪个找到的。
     */
    let resolvedBy = null;
    let resolvedPath = null;
    let patchEff = patch;
    if (['set', 'remove', 'select', 'reparent', 'moveSibling'].indexOf(rawOp) >= 0
      && patch.path !== undefined && String(patch.path) !== '') {
      const st0 = controller.get();
      const flat = [];
      const walk = (node, prefix) => {
        const label = (node && node.name) || ('<' + ((node && node.kind) || '?') + '#' + ((node && node.id) || '?') + '>');
        const p = prefix ? prefix + '/' + label : label;
        flat.push({ id: String((node && node.id) || ''), path: p, name: String((node && node.name) || '') });
        for (const ch of ((node && node.children) || [])) walk(ch, p);
      };
      for (const ch of (((st0 && st0.root) || {}).children || [])) walk(ch, '');
      const hasId = patch.id !== undefined && patch.id !== null && String(patch.id) !== '';
      if (hasId) {
        resolvedBy = 'id';
      } else {
        const want = String(patch.path).trim().split(/[\\/]+/).filter(Boolean);
        const tail = want.length ? want[want.length - 1] : '';
        const nameHit = flat.filter((c) => c.name === tail);
        const fullHit = nameHit.filter((c) => {
          const segs = c.path.split('/');
          if (segs.length < want.length) return false;
          return want.every((w, i) => segs[segs.length - want.length + i] === w);
        });
        const use = fullHit.length ? fullHit : nameHit;
        if (use.length === 1) {
          patchEff = { ...patch, id: use[0].id };
          resolvedBy = 'path';
          resolvedPath = use[0].path;
        } else if (use.length > 1) {
          throw new Error('`path` 命中多个控件（' + use.length + ' 个）：'
            + use.map((c) => c.path + '（id ' + c.id + '）').join(' / ')
            + '　—— 请给**全路径**（父/子）或直接用 `id`，工具不替你猜。');
        } else {
          throw new Error('没找到控件 `' + patch.path + '`　现有控件（名字路径，最多 20 条）：'
            + (flat.slice(0, 20).map((c) => c.path + '（id ' + c.id + '）').join(' / ') || '（树是空的）')
            + '　—— 也可以直接用 `id`（op=controls 能看到）。');
        }
      }
    }
    let settableKeys = null;
    if (rawOp === 'set') settableKeys = settableKeysOf(controller, patchEff.id);
    const v = validatePatchFields(patchEff, { settableKeys });
    /*
     * ★ 脚本类 patch 再走一遍入口校验（反馈 B1/B2）：`sourceFrom`（读文件）在这里被读成 `source`，
     *   `removeScript` 的 `path` 在这里被换成 `id`；缺源码 / 缺 id 一律**明确报错**（不静默写空脚本）。
     *   `sourceFrom` 的读文件实现复用 `op=read source=` 那一套（绝对路径 / 8 MB 上限 / 拒绝二进制）。
     */
    const norm = normalizeScriptPatch(v.patch, controller.get().scripts || [], (p) => {
      const r = readLuaAt(p, { head: 0 });
      if (r.ok === false) throw new Error(r.error + '　' + (r.nextSteps || []).join('；'));
      return r.text;
    });
    controller.patch(norm.patch);
    /*
     * ★ P1-2：`add {…, text}` 的 `text` —— 引擎的 `add` 不收它（旧版**静默吞掉**），
     *   所以建好之后**紧接着补一次 set**（新控件的 id 就是引擎刚设的 `selectedId`）。
     */
    let textApplied = null;
    if (v.text !== null && v.text !== undefined) {
      const st0 = controller.get();
      const newId = st0 && st0.selectedId ? String(st0.selectedId) : '';
      if (!newId) throw new Error('内部错误：`add` 之后拿不到新控件的 id（报告这个 bug）');
      controller.patch({ op: 'set', id: newId, key: 'text', value: v.text });
      textApplied = { id: newId, text: v.text };
    }
    const st = controller.get();
    return {
      applied: patch.op || Object.keys(patch)[0] || 'patch',
      version: st.version,
      ...(resolvedBy ? { resolvedBy, resolvedFrom: patch.path, resolvedTo: resolvedPath } : {}),
        ...(textApplied ? { textApplied, textNote: v.note } : {}),
      ...slimState(st, { summaryOnly: true }),
    };
  }

  if (op === 'play') {
    let action = String(args.action || 'get');
    let a = Object.assign({}, args.args || args.playArgs || {});
    /*
     * ★ P1-1（2026-09-26）：`action=click` 从前**存在但不产生任何光标事件** ——
     *   实测它记了一条 `{kind:"click",payload:{name:"undefined"}}` 的**假记录**，
     *   而脚本的 `AddCursorEventListener(CursorClick, …)` 一次都没触发（AI 于是去改脚本，白烧一轮）。
     *   现在：给了 `x/y` 就**等价于 `pointer{type:"click"}`**（同一份 Lua 侧光标事件）；
     *   给了 `name` 仍按控件名点；**两者都没有 → 明确报错指路**（绝不再记一条 name=undefined 的假记录）。
     */
    let clickAs = null;
    if (action === 'click') {
      const rawName = a.name;
      const nameStr = rawName === undefined || rawName === null ? '' : String(rawName).trim();
      const hasName = nameStr !== '' && nameStr !== 'undefined' && nameStr !== 'null';
      const hasXy = a.x !== undefined && a.x !== null && a.y !== undefined && a.y !== null;
      if (!hasName && !hasXy) {
        throw new Error('op=play action=click 需要**二者之一**：'
          + '① 点坐标 → `{"op":"play","action":"click","args":{"x":800,"y":277}}`（等价 `pointer{type:"click"}`，坐标**左下原点**）；'
          + '② 点控件 → `{"op":"play","action":"click","args":{"name":"按钮名"}}`。'
          + '两个都不给的话**什么都不会发生**（旧版会记一条 name=undefined 的假记录，容易让人以为"点了但脚本没反应"）。');
      }
      if (!hasName && hasXy) {
        action = 'pointer';
        a = { type: 'click', x: a.x, y: a.y };
        clickAs = 'pointer';
      } else {
        clickAs = 'name';
      }
    }
    if (action === 'start') {
      startOpts.set(controller, { canvasId: a.canvasId, playerCount: a.playerCount });
    }
    if (action === 'device') {
      /*
       * ⚠️ 引擎的 `device` 会**重建整个运行时**（controller.play('device') → worker 'start'）。
       * 不把 `playerCount` 一起带上的话，人数会**悄悄掉回 1** —— 然后 `view 2` 报
       * `playerIndex must be an integer 1-1`（2026-09-24 真机实测踩到）。
       * 所以这里由 Host 记住 start 时的人数，切设备时自动补上。
       */
      const memo = startOpts.get(controller) || {};
      if (a.playerCount === undefined && memo.playerCount) a.playerCount = memo.playerCount;
      startOpts.set(controller, Object.assign({}, memo, { canvasId: a.canvasId !== undefined ? a.canvasId : memo.canvasId }));
    }
    try {
      const res = await controller.play(action, a);
      return {
        action,
        ...(clickAs ? { requestedAction: 'click', clickInterpretedAs: clickAs, clickNote: clickAs === 'pointer'
          ? '`click` 给了 x/y ⇒ 按**坐标**点（与 `pointer{type:"click"}` 是同一份 Lua 侧光标事件）'
          : '`click` 给了 name ⇒ 按**控件名**点（引擎的 SimulateCursorClick）' } : {}),
        ...slimPlay(res || {}, { summaryOnly: args.summaryOnly !== false }),
      };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/playerIndex must be an integer/.test(msg)) {
        throw new Error(msg + ' —— 视角号必须在 1..当前人数 之间；人数由 `op=play action=start` 的 `playerCount`（1–8）决定（切设备后 Host 会自动沿用）。');
      }
      throw e;
    }
  }

  if (op === 'handover') {
    /*
     * **交接值体检**：把「这台机器上有哪些活文件」与「这份 Lua 里写着哪些真机 id」摆出来。
     *
     * 为什么值得单独一个 op：`bind` 最难的不是搭工程，是**交接值从哪来**。
     * 创作者给的号写在脚本常量里（`local IMAGE_TEMPLATE = 1073741868`，或
     * `CONFIG = { prefabImage = 1073741852 }` 这种表字段），所以"读源码抽候选"比"让人抄一遍"可靠得多 ——
     * 但它仍然只是**候选**：`kindHint` 只看变量名，控件类型必须人来定（猜错同样静默失败）。
     *
     * ★ `source`（**绝对路径，只读**）：读**那一份**文件并抽候选 —— 面板「读本地 .lua」用的就是它。
     *   校验**复用** `miliastra_code op=read source=` 的同一份实现（`readLuaAt`）：
     *   只认绝对路径、> 8 MB 拒绝、二进制拒绝、非 UTF-8 拒绝。
     *   以前这条路只有一句裸 `fs.readFileSync`：相对路径会按**进程当前目录**解析（静默读错文件）、
     *   二进制读成乱码 —— 两种都**不报错**。
     *   ★ 回执必须**说清这次读的是哪一份**（`readFrom: "source"`）：source 模式只是**顺带**列出这台
     *   机器上有哪些活文件（`files`/`fileCount`），别让它看起来像"扫了活文件"。
     */
    const sourceArg = args.source === undefined || args.source === null ? '' : String(args.source).trim();
    const fromSource = !!sourceArg;
    const { rows, currentLevel } = liveFileRows();
    let file = '';
    let source = '';
    let readMeta = null;
    if (fromSource) {
      // ★ 只读：readLuaAt 内部只有 statSync / readFileSync（tests/read-source-test.mjs 有源码级断言钉住）
      const r = readLuaAt(sourceArg, { head: 0 });
      if (r.ok === false) {
        throw new Error('op=handover source=… ' + r.error + '　' + (r.nextSteps || []).join('；'));
      }
      file = r.file;
      source = r.text;
      readMeta = { bytes: r.bytes, lines: r.lines, sha256_12: r.sha256_12, mtime: r.mtime, bom: r.bom };
    } else {
      const auto = rows.find((x) => !x.auxiliary && x.current) || rows.find((x) => !x.auxiliary) || rows[0] || null;
      file = (auto && auto.path) || '';
      if (!file) {
        return {
          files: [], fileCount: 0, readFrom: 'live', picked: null, candidates: [], suggestedTemplates: [], containerId: null,
          note: '这台机器上**没扫到活文件**（真机 .lua）。路径随账号/换图变化，先用 miliastra_health 定位；'
            + '或者直接给 `source`（绝对路径）只做交接值抽取。',
        };
      }
      if (fs.existsSync(file)) source = fs.readFileSync(file, 'utf8');
    }
    const candidates = handoverCandidates(source);
    const templates = candidates.filter((c) => c.isTemplate).map((c) => ({
      guid: c.value,
      kind: c.kindHint,
      name: c.name,
    }));
    const containers = candidates.filter((c) => c.role === 'container');
    /*
     * 没抽到候选要**指路**，不能只回一句「一条都没有」：
     * 这份源码里认不出模板索引时，第二条自动来源是 `.gil`（`miliastra_map op=clientui`），
     * 两条都拿不到才轮到问创作者 —— 顺序写在回执里，省一轮往返。
     */
    const nextStep = templates.length
      ? '抽到 ' + templates.length + ' 个候选模板 —— `kindHint` 只看变量名猜的，拿不准就在 `op=bind` 里传 `kind:"auto"`（谁让控件数增长就用谁）。'
      : '这份源码里没认出模板索引 → 可从 `.gil` 读：`miliastra_map op=clientui`（客户端控件模板索引），或手填。'
        + '（本工具认 `local NAME = <9 位以上整数>` 与表字段 `NAME = <大整数>` 两种写法。）';
    return {
      files: rows.slice(0, 40),
      fileCount: rows.length,
      currentLevel,
      // ★ 这次到底读的是哪一份：给了 source 就是**那份文件**，没给才是沙箱活文件
      readFrom: fromSource ? 'source' : 'live',
      ...(fromSource ? { sourceArg, readOnly: true, readMeta } : {}),
      picked: file,
      pickedBytes: source ? Buffer.byteLength(source, 'utf8') : 0,
      candidates,
      suggestedTemplates: templates,
      containerId: containers.length ? containers[0].value : null,
      nextStep,
      note: (fromSource
        ? '`candidates` 抽自 **`source` 指定的那一份文件**（readFrom:"source"，**只读**：没有写入、也没动沙箱活文件）；'
          + '`files`/`fileCount`/`currentLevel` 只是顺带列出这台机器上有哪些活文件，**不是**这次读的东西。'
        : '`candidates` 抽自 `picked` 那份**沙箱活文件**（readFrom:"live"）。')
        + '`candidates` 来自源码里的大整数（**启发式**：名字像什么就提示什么 kind）；'
        + '`kindHint` 只是提示 —— **控件类型猜错 = 静默什么都不建**：拿不准就传 `kind:"auto"`，或让创作者确认后再 `op=bind`。'
        + '⚠️ 可能混着关卡 ID 这类别的号（如 1073741833），别当成模板。',
    };
  }

  if (op === 'bind') {
    /*
     * **把「一份真机工程 + 创作者交接值」搭成模拟器工程** —— 一条命令替掉原来那 4 步手写探针
     * （`newAsset` → `addTemplate` → 存盘改 guid → 挂脚本），核心只有两件事：
     *   ① **模板索引必须用真机交接的那个值**：脚本里 `InstantiateClientUIControl(<模板索引>, parent)`
     *      用的就是它；模拟器自己另编一个号 ⇒ 脚本永远解析不到模板（静默跑不动）。
     *   ② **脚本的 path 要写真名**：不少脚本用 `script.path` 做挂载自检（双相的 `checkMount()` 就要求
     *      path 去掉 `.lua` 后 = 脚本名），名字不对它会自己退出。
     *
     * `last:true` = 用上次那份**配方**重搭（重启 `dsh web` 后内存里的工程会回到出厂默认，这条就是"一键回来"）。
     *
     * 不做的事：不猜模板索引、不猜控件类型、不猜容器索引（缺哪个就报错让创作者给）——
     * 编造交接值的代价是"看起来跑起来了、其实什么都没建"。
     */
    const useLast = args.last === true || args.fromLast === true;
    const recipe = useLast ? readBindRecipe() : null;
    if (useLast && !recipe) {
      throw new Error('op=bind last:true：还没有可重搭的配方（' + bindRecipePath() + ' 不存在）—— 先用 source + templates 正常搭一次，之后就会自动记下来');
    }
    /*
     * `last:true` 重搭：**优先用配方里的 `scripts[]`**（多脚本工程，反馈 B4），
     * 老配方只有单个 `source` 时照旧走单脚本那条路（不破坏既有配方文件）。
     */
    let bindArgs = args;
    if (useLast) {
      bindArgs = Object.assign({}, args, {
        templates: recipe.templates,
        containerId: recipe.containerId,
        canvasId: args.canvasId || recipe.canvasId,
      });
      delete bindArgs.script;
      if (Array.isArray(recipe.scripts) && recipe.scripts.length) {
        bindArgs.scripts = recipe.scripts;
        bindArgs.source = undefined;
        bindArgs.scriptName = undefined;
      } else {
        bindArgs.scripts = undefined;
        bindArgs.source = recipe.source;
        bindArgs.scriptName = recipe.scriptName;
      }
    }
    const CLIENT = 'client-control-template';
    const SERVER = 'server-control-template';
    const templates = normalizeBindTemplates(bindArgs.templates);
    const scriptList = await readBindScripts(bindArgs);
    const script = scriptList[0];
    const canvasId = String(bindArgs.canvasId || '');
    if (canvasId && !CANVAS_PRESETS[canvasId]) {
      throw new Error('op=bind: 未知画布 ' + canvasId + '（可用：' + Object.keys(CANVAS_PRESETS).join(' / ') + '）');
    }
    const fresh = bindArgs.fresh !== false;          // 默认：先把存档重置成干净状态，再重建 ⇒ 同一份参数 → 同一份工程
    const keepFactory = bindArgs.keepFactory === true; // 保留出厂橱窗控件（默认清掉，否则分不清哪些是你的）

    if (fresh) {
      // 旧脚本先撤挂载再移除：`newAsset` 只会把"挂不上的"脚本置空，条目本身会留在存档里（越攒越多）
      for (const row of (controller.get().scripts || [])) controller.patch({ op: 'removeScript', id: row.id });
    }

    // ① 客户端控件模板工程：每个交接值建一个**顶层模板**，guid 就用交接值
    const givenGuids = new Set(templates.map((t) => t.guid));
    /**
     * 重建客户端模板工程（`kind:"auto"` 时按候选 kind 反复重建）。
     * `cand` 只对 `auto` 的那几条生效，其余模板一律用调用方给的 kind。
     */
    const buildClientTemplates = (cand) => {
      controller.patch({ op: 'newAsset', assetType: CLIENT });
      for (const t of templates) {
        controller.patch({
          op: 'addTemplate', name: t.name, guid: t.guid, id: t.id,
          kind: t.kind === AUTO_KIND ? cand : t.kind,
        });
      }
      if (fresh) {
        // 出厂自带的那个「Lua实例化面板」模板不是你的工程的一部分，留着只会在控件清单里添噪音。
        // 判据用 **guid**（顶层行的 guid 必须是我们刚交的那些）——比"第几个"稳。
        for (const row of (controller.get().tree || [])) {
          if (row.depth === 0 && !givenGuids.has(Number(row.guid))) {
            try { controller.patch({ op: 'remove', id: row.id }); } catch (e) { /* 至少留一个模板，删不动就算了 */ }
          }
        }
      }
    };
    buildClientTemplates(AUTO_KIND_ORDER[0]);

    // ② 服务端工程：脚本挂在这里（真机的 levelScript 也是挂在容器节点上）
    controller.patch({ op: 'newAsset', assetType: SERVER });
    let mount = null;
    {
      const want = String(args.mountTo || '');
      const pool = (controller.get().mountTargets || []).filter((r) => r.assetType === SERVER);
      mount = (want && pool.find((r) => r.id === want || r.name === want))
        || pool.find((r) => r.kind === 'container')
        || pool[0]
        || null;
      if (!mount) throw new Error('op=bind: 服务端工程里找不到可挂载的控件节点（不该发生，请把它当 bug 报）');
      if (want && mount.id !== want && mount.name !== want) {
        throw new Error('op=bind: mountTo 找不到对应控件（' + want + '）；可用：' + pool.map((r) => r.id + ':' + r.name).join(' / '));
      }
    }
    if (fresh && !keepFactory) {
      // 清掉出厂橱窗控件：它们和你的工程没关系，留着会混进渲染与控件清单
      const st = controller.get();
      for (const row of (st.tree || [])) {
        if (row.depth === 2 && row.kind !== 'server-container' && row.id !== mount.id) {
          try { controller.patch({ op: 'remove', id: row.id }); } catch (e) { /* 删不动的留着 */ }
        }
      }
    }
    for (const s of scriptList) {
      controller.patch({ op: 'addScript', controlId: mount.id, controlAsset: SERVER, path: s.path, source: s.source });
    }
    if (canvasId) controller.patch({ op: 'setCanvas', canvasId });
    if (args.name) controller.patch({ op: 'renameSave', name: String(args.name) });

    /**
     * 起一次会话 → 让时钟走一小段 → 把「脚本跑没跑 / 控件建了几个」读回来。
     * `kind:"auto"` 逐个候选试的时候也走它（每个候选一次会话，互不干扰）。
     * @param {boolean} keepRunning 跑完留不留着会话（不留就 stop）
     */
    const runSession = async (keepRunning) => {
      await controller.play('start', { canvasId: canvasId || undefined, playerCount: Number(args.playerCount) || 1, viewPlayerIndex: args.viewPlayerIndex });
      /*
       * **先让时钟走一小段再读**（默认 0.5s）。为什么不能停在 start 那一刻读：
       * 脚本的 OnInit/OnEnable/OnStart 只是"准备"，真正的构建（双相建 31 个控件）发生在**进入 RUNNING 之后**——
       * 停在 frame 0 读，`controlCount` 只有 1（容器本身），会被误读成"脚本什么都没建"（实测踩到）。
       */
      const settle = Number.isFinite(Number(args.settleSec)) ? Math.max(0, Math.min(3, Number(args.settleSec))) : 0.5;
      const stepDt = 1 / 30;
      for (let i = 0; i < Math.ceil(settle / stepDt); i += 1) {
        await controller.play('step', { dt: stepDt, light: true });
      }
      const live = await controller.play('get', { view: true, compact: true, inspect: true });
      const logs = (live && live.logs) || [];
      const runOut = {
        running: true,
        settleSec: settle,
        logs: logs.length > PLAY_LOG_KEEP ? logs.slice(-PLAY_LOG_KEEP) : logs,
        logCount: logs.length,
        // 控件数（运行时，已拍平）：脚本动态建出来的都在里面，是"脚本到底建没建"的直接证据
        controlCount: flattenControls(live && live.tree).length,
        frame: Number(live && live.frame) || 0,
        time: Number(live && live.time) || 0,
        canvasId: live && live.canvasId,
        playerCount: Number(live && live.playerCount) || 1,
        viewPlayerIndex: Number(live && live.viewPlayerIndex) || 1,
      };
      if (keepRunning !== true) await controller.play('stop', {}).catch(() => {});
      else runOut.keptRunning = true;
      return runOut;
    };

    // ③ 交接值交叉核对：源码里出现的"高段数字"（真机 id 都在 1073741824 以上）与交接值对不对得上
    //    （多脚本时**把所有脚本的源码合起来**看 —— 否则「缺哪个模板」会被第一份源码带偏）
    const handover = checkHandover(scriptList.map((s) => s.source).join('\n'), templates, bindArgs.containerId);

    /*
     * ③b `kind` 自动判定 —— 判据只有一个：**控件数有没有增长**（比的是编辑器工程里已有的控件数）。
     *    为什么不能更聪明：kind 猜错的表现就是"静默什么都不建"，除了控件数（和脚本自己的 print）
     *    没有任何别的信号可用；而这条判据在真机上也是同一个道理。
     */
    const autoTemplates = templates.filter((t) => t.kind === AUTO_KIND);
    controller.patch({ op: 'selectAsset', assetType: SERVER });
    const baselineControlCount = (controller.get().tree || []).filter((r) => r.kind !== 'server-container').length;
    let kindTried = null;
    let kindWinner = null;
    let autoRun = null;
    let kindNote = '';
    if (autoTemplates.length && bindArgs.run !== false) {
      kindTried = [];
      for (const cand of AUTO_KIND_ORDER) {
        buildClientTemplates(cand);
        const one = await runSession(false);
        const grew = Number(one.controlCount) > baselineControlCount;
        kindTried.push({ kind: cand, controlCount: one.controlCount, baseline: baselineControlCount, grew });
        if (grew) { kindWinner = cand; autoRun = one; break; }
      }
      // 一个候选都没让控件数增长 → 落回第一个候选，让下面的正常 run 照常给证据（并附 kindHint）
      if (!kindWinner) buildClientTemplates(AUTO_KIND_ORDER[0]);
      kindNote = kindWinner
        ? '（`kind:"auto"` 试出来的是 **' + kindWinner + '**：' + kindTried.map((k) => k.kind + '=' + k.controlCount).join(' / ') + '）'
        : '（`kind:"auto"` 把 ' + AUTO_KIND_ORDER.join(' / ') + ' 都试过，控件数都没增长 —— 看 `run.logs` 里脚本自己的 print）';
    }

    // ④ 报告：模板表（含 guid）从客户端工程读，脚本挂载点从 state 读
    controller.patch({ op: 'selectAsset', assetType: CLIENT });
    const clientState = controller.get();
    const templateRows = (clientState.tree || [])
      .filter((r) => r.depth === 0)
      .map((r) => ({ id: r.id, guid: Number(r.guid) || 0, kind: r.kind, name: r.name }));
    controller.patch({ op: 'selectAsset', assetType: SERVER });
    const st = controller.get();
    const editorRows = Array.isArray(st.tree) ? st.tree : [];
    const mounted = (st.scripts || []).map((s) => ({ id: s.id, path: s.path, controlId: s.controlId, controlName: s.controlName, mounted: !!s.mounted }));
    // 挂载点的**真实层级**：只给 assetType 会让人以为挂错了地方（同事实测）
    const hierarchy = mountHierarchy(editorRows, mount.id);

    const out = {
      bound: true,
      save: st.save && st.save.name,
      fresh,
      canvas: st.canvas ? { id: st.canvas.id, width: st.canvas.width, height: st.canvas.height, label: st.canvas.label } : null,
      templates: templateRows,
      templateCount: templateRows.length,
      source: script.meta,
      // ★ 多脚本（反馈 B4）：每一份的元信息都列出来（`source` 仍 = 第一份，向后兼容）
      sources: scriptList.map((s) => s.meta),
      scriptCount: scriptList.length,
      mount: {
        id: mount.id, name: mount.name, kind: mount.kind, assetType: SERVER,
        // 真实层级（assetType 只是**控件模板资源**的名字，见 assetTypeNote）
        parent: hierarchy.parent,
        ancestors: hierarchy.ancestors,
        isClientUI: hierarchy.isClientUI,
        clientUIRoot: hierarchy.clientUIRoot,
        assetTypeNote: MOUNT_ASSET_TYPE_NOTE,
      },
      scripts: mounted,
      // 两个数分开说：treeCount = 服务端工程**编辑器树**的行数（含容器本身）；
      // editorControlCount = 去掉「客户端控件容器」那一行 —— "你的工程里摆了几个控件"
      treeCount: editorRows.length,
      editorControlCount: editorRows.filter((r) => r.kind !== 'server-container').length,
      handover,
      nextStep: '先看 `run.logs` 里有没有你脚本自己的 print（脚本跑没跑），再看 `run.controlCount`（控件建没建·建了几个）'
        + kindNote + '；'
        + '画面用 `op=shot target=play`（PNG 真落盘，用 read_image 看）。判定逻辑用 `op=verify`（可先 `op=cases action=add` 存成用例）。',
    };

    // 只在 auto 那次调用里才挂这两个字段（**不用对象展开**：带展开会让后面补 out.run / out.note 的赋值被 tsc 判成"属性不存在"）
    if (kindTried) { out.kindTried = kindTried; out.kindWinner = kindWinner; }

    if (args.run !== false) {
      const keep = args.keepRunning === true;
      // auto 判赢家的那一局就是「赢家那一局」——不重复跑（除非人要 keepRunning，那必须再起一次）
      out.run = (autoRun && !keep) ? autoRun : await runSession(keep);
      /*
       * ★ kind 猜错时**自动补一条 hint**（同事实测：猜错是静默的 —— 什么都不建、不报错，
       *   而回执里只有一个 controlCount 数字，人看不出"是没建"还是"本来就没那么多控件"）。
       */
      if (Number(out.run.controlCount) <= baselineControlCount) {
        out.kindHint = kindMismatchHint(baselineControlCount, Number(out.run.controlCount), !!kindTried);
      }
      out.note = '⚠️ `logs` 里**只有你脚本 print 出来的字**：没有 print ≠ 没跑（可能是脚本没进 OnStart，也可能它在等信号）。'
        + '控件的真假看 **`controlCount`**（运行时树已拍平，脚本动态建的都在里面）—— 要塞脚本没写 print 时的证据，'
        + '就用 `op=controls runtime:true`（需 `keepRunning:true` 保住会话）。'
        + '**模拟器通过 ≠ 真机通过**（官方素材 / 真机渲染 / 联机 / 性能都不覆盖）。';
    } else {
      out.note = '只是搭好了工程（run:false）。要跑起来：`op=play action=start`。';
    }
    if (args.saveAs || (recipe && recipe.save)) {
      const name = typeof args.saveAs === 'string' ? args.saveAs
        : (recipe && recipe.save) || ('bind-' + script.stem + '.save.json');
      out.saved = controller.saveArchive(name);
    }
    // 记下配方：重启 `dsh web` 后内存里的工程会回到出厂默认，这份配方就是"一键回来"的依据
    if (bindArgs.remember !== false) {
      out.recipe = writeBindRecipe({
        format: 'qxqy-simulator-bind',
        version: 1,
        at: new Date().toISOString(),
        // `source` 仍是**第一份**的文件路径（既有断言与面板按它写）；多脚本看 `scripts[]`
        source: script.meta.file || bindArgs.source || '',
        scriptName: script.path,
        sourceSha1_12: script.meta.sha1_12,
        // ★ 多脚本（反馈 B4）：能按路径重读的就存路径，纯内联的才存源码
        scripts: scriptList.map((s) => (s.meta.file
          ? { path: s.path, sourceFrom: s.meta.file }
          : { path: s.path, source: s.source })),
        templates: templates.map((t) => ({ guid: t.guid, kind: t.kind, name: t.name })),
        containerId: Number(bindArgs.containerId) || null,
        canvasId: canvasId || null,
        save: (out.saved && out.saved.path) || (recipe && recipe.save) || null,
      });
    }
    if (useLast) out.fromLast = true;
    return out;
  }

  if (op === 'cases') {
    /*
     * **用例清单（case book）** —— 把「这一版该怎么验收」变成一份**存在盘上、人和 AI 读同一份**的单子：
     *   · 自动项：events + asserts，`action=run` 时确定性重放，谁跑结果都一样；
     *   · **人工项**（`manual:true` + note）：要人看画面 / 上真机确认的，工具**不代跑也不代判**，
     *     只在 run 的返回里列成 `manual[]` 等人打勾 —— 「工具只报数字，不下判决」。
     * 这样"模拟器通过"与"真机通过"两件事不会混成一句"过了"。
     */
    const action = String(args.action || 'list');
    const doc = readCasesFile();
    const file = casesPath();

    if (action === 'list') {
      const sets = Object.keys(doc.sets).map((k) => {
        const set = doc.sets[k] || {};
        const list = Array.isArray(set.cases) ? set.cases : [];
        return {
          set: k,
          updated: set.updated || null,
          caseCount: list.length,
          autoCount: list.filter((c) => c && c.manual !== true).length,
          manualCount: list.filter((c) => c && c.manual === true).length,
          cases: list.map(bookCaseRow),
        };
      });
      return {
        file, setCount: sets.length, sets,
        note: '这是**验收单**：auto 项由 `op=cases action=run set=<名字>` 确定性重放（谁跑都一样）；'
          + 'manual 项工具不代跑 —— 它列出来等人/等真机打勾。存用例：`op=cases action=add set=<名字> expect=[…]`；'
          + '把刚跑过那一局变成用例：加 `fromHistory:true`（AI 不用手抄 events）。',
      };
    }

    if (action === 'show') {
      const set = caseSetOrThrow(doc, args.set || args.name);
      return { file, set: String(args.set || args.name), updated: set.updated || null, cases: set.cases || [], note: set.note || '' };
    }

    if (action === 'add') {
      const key = String(args.set || args.name || '');
      if (!key) throw new Error('op=cases action=add 需要 set=<用例集名>（建议用「玩法-关卡」这种能一眼认出的名字）');
      const list = Array.isArray(args.cases) ? args.cases : [args];
      let historyEvents = null;
      let historyPlayer = 0;
      if (args.fromHistory === true || args.useHistory === true) {
        if (!controller.worker) {
          throw new Error('op=cases action=add fromHistory:true 需要**刚跑过一局**（人在浏览器试玩页里玩的，或自己 op=play start）：'
            + '现在没有活着的会话。先在 `GET /miliastra/play` 里玩一局，或先 op=play action=start。');
        }
        const h = await controller.play('history', {});
        historyEvents = (h && Array.isArray(h.events)) ? h.events : [];
        historyPlayer = Number(h && h.case && h.case.playerCount) || 0;
        if (!historyEvents.length) throw new Error('op=cases action=add fromHistory:true：这一局 history 还是空的（一次操作都还没记录）——先去玩一局，或自己发 steps。');
      }
      const saved = [];
      const set0Count = (doc.sets[key] && Array.isArray(doc.sets[key].cases)) ? doc.sets[key].cases.length : 0;
      for (const raw of list) {
        const row = Object.assign({}, raw);
        if (historyEvents && !row.events && !(Array.isArray(row.steps) && row.steps.length)) row.events = historyEvents;
        if (historyEvents && !row.playerCount && historyPlayer) row.playerCount = historyPlayer;
        saved.push(normalizeBookCase(row, key + ' 用例 ' + (set0Count + saved.length + 1)));
      }
      const set = doc.sets[key] || { name: key, updated: null, note: '', cases: [] };
      const byName = new Map((set.cases || []).map((c) => [c.name, c]));
      const replaced = [];
      for (const c of saved) {
        if (byName.has(c.name)) replaced.push(c.name);
        byName.set(c.name, c);
      }
      set.cases = [...byName.values()];
      set.updated = new Date().toISOString();
      doc.sets[key] = set;
      writeCasesFile(doc);
      return {
        file, set: key, added: saved.map((c) => bookCaseRow(c)), replaced,
        caseCount: set.cases.length,
        manualCount: set.cases.filter((c) => c.manual === true).length,
        note: '同名用例是**覆盖**（改断言再存一遍即可）。跑它：`op=cases action=run set=' + key + '`。'
          + '注意：模拟器能判的是「脚本行为」，判不了「好不好玩 / 真机渲染对不对」—— 那种要写成 manual 项。',
      };
    }

    if (action === 'remove') {
      const key = String(args.set || args.name || '');
      const set = caseSetOrThrow(doc, key);
      const caseName = args.case ? String(args.case) : '';
      const wholeSet = args.all === true || !caseName;
      const before = set.cases.length;
      const after = wholeSet ? [] : set.cases.filter((c) => c.name !== caseName);
      const willRemove = before - after.length;
      if (args.confirm !== true) {
        return {
          file, set: key, dryRun: true,
          willRemove: wholeSet ? before : willRemove,
          what: wholeSet ? ('整个用例集「' + key + '」') : ('用例「' + caseName + '」'),
          note: '删除是**不可恢复**的（没有回收站）。确认无误后传 confirm:true 才真删。',
        };
      }
      if (wholeSet) delete doc.sets[key]; else { set.cases = after; set.updated = new Date().toISOString(); }
      writeCasesFile(doc);
      return { file, set: key, removed: willRemove, wholeSet, setCount: Object.keys(doc.sets).length };
    }

    if (action === 'run') {
      const key = String(args.set || args.name || '');
      const set = caseSetOrThrow(doc, key);
      const all = (set.cases || []);
      const only = Array.isArray(args.cases) && args.cases.length
        ? all.filter((c) => args.cases.map(String).indexOf(c.name) >= 0)
        : all;
      if (Array.isArray(args.cases) && args.cases.length && !only.length) {
        throw new Error('op=cases action=run：cases 里给的名字在「' + key + '」里一个都对不上（现有：' + all.map((c) => c.name).join(' / ') + '）');
      }
      const autos = only.filter((c) => c && c.manual !== true);
      const manuals = only.filter((c) => c && c.manual === true);
      const out = {
        file, set: key, caseCount: only.length, autoCount: autos.length, manualCount: manuals.length,
        manual: manuals.map((c) => ({ name: c.name, note: c.note })),
      };
      if (!autos.length) {
        out.autoPassed = null;
        out.note = '这一组里**没有自动项**（只有人工项）—— 工具不代判：请按 `manual[]` 里的 note 逐条看画面 / 上真机确认。';
        return out;
      }
      const res = await simOp({
        op: 'verify',
        cases: autos,
        canvasId: args.canvasId || set.canvasId,
        playerCount: args.playerCount || set.playerCount,
        viewPlayerIndex: args.viewPlayerIndex,
        shotOnFail: args.shotOnFail,
        stopOnFail: args.stopOnFail,
        summaryOnly: args.summaryOnly,
      }, ctx);
      out.autoPassed = res.passed;
      out.passedCount = res.passedCount;
      out.failedCount = res.failedCount;
      out.failures = res.failures;
      out.result = res;
      out.note = (manuals.length
        ? '自动项已跑完（' + res.passedCount + '/' + autos.length + '）—— 但**整组没算过**：还有 ' + manuals.length + ' 条人工项要人确认（见 `manual[]`）。'
        : '自动项全跑完：' + res.passedCount + '/' + autos.length + '。')
        + '别把 `autoPassed` 说成「验收通过」——真机那一步仍要人点试玩。';
      return out;
    }

    throw new Error('未知 action：' + action + '（可用：list / show / add / remove / run）');
  }

  if (op === 'verify') {
    /*
     * **AI 自测逻辑的主入口**：一次调用 = 跑一段操作 + 到点断言 + 给判定。
     *
     * 引擎自带这套（`studio/autotest/runner.js` 的 `replayCase`：确定性重放、失败即返回 `failedAt`），
     * 但它的原生形状是「先交互跑一遍 → history → saveCase → runCase」——对 AI 是三次来回还容易错。
     * 这里由 Host 直接组好用例走 `runCase`；它会**开一个全新会话**再重放 ⇒ 每次结果一致。
     */
    const casesArg0 = Array.isArray(args.cases) ? args.cases.filter((c) => c && typeof c === 'object') : null;
    /*
     * `caseSet`：直接跑**清单里存着的一整组**（`op=cases` 存的那份）—— 人/AI 读同一份验收单。
     * 人工项**不代跑**：只把它们原样列出来等人打勾（工具不下判决）。
     */
    let manualItems = [];
    let casesArg = casesArg0;
    if (args.caseSet) {
      const set = caseSetOrThrow(readCasesFile(), args.caseSet);
      const rows = Array.isArray(set.cases) ? set.cases : [];
      manualItems = rows.filter((c) => c && c.manual === true).map((c) => ({ name: c.name, note: c.note || '' }));
      casesArg = rows.filter((c) => c && c.manual !== true);
      if (!casesArg.length) {
        return {
          passed: null, caseCount: 0, passedCount: 0, failedCount: 0, cases: [],
          manual: manualItems,
          note: '「' + args.caseSet + '」这一组里**没有自动项**（只有人工项）—— 工具不代判：请按 `manual[]` 的 note 逐条看画面 / 上真机确认。',
        };
      }
    }
    const multi = !!(casesArg && casesArg.length);

    /*
     * `fromHistory`：把**刚跑过那一局**（人在浏览器试玩页里玩的，或 AI 自己 op=play 驱动的）的事件
     * 直接拿来当用例 —— AI 不用手抄一大串 events，这是「浏览器试玩页」这条路对 AI 的真正价值：
     * 人玩出问题 → 那局的操作时间线原样变成可重放的回归用例。
     * ⚠️ 必须在 `start` **之前**读：runCase 会重开会话，history 归零。
     */
    let historyEvents = null;
    let historyPlayerCount = 0;
    if (args.fromHistory === true || args.useHistory === true) {
      if (!controller.worker) {
        throw new Error('op=verify fromHistory:true 需要**刚跑过一局**（人在浏览器试玩页里玩的，或自己 op=play action=start 起的）：'
          + '现在没有活着的会话。先在 `GET /miliastra/play` 里玩一局，或先 op=play action=start。');
      }
      const h = await controller.play('history', {});
      historyEvents = (h && Array.isArray(h.events)) ? h.events : [];
      historyPlayerCount = Number(h && h.case && h.case.playerCount) || 0;
      if (!historyEvents.length) {
        throw new Error('op=verify fromHistory:true：这一局 history 还是空的（一次操作都还没记录）。'
          + '先在浏览器试玩页里点/按（人的操作会被记进 history），或自己发几个 steps，再来跑这一条。');
      }
    }

    const rawList = (multi ? casesArg : [args]).map((c) => {
      const row = Object.assign({}, c);
      if (historyEvents && !row.events && !(Array.isArray(row.steps) && row.steps.length)) row.events = historyEvents;
      if (historyEvents && !row.playerCount && historyPlayerCount) row.playerCount = historyPlayerCount;
      return row;
    });
    const specs = rawList.map((c, i) => {
      try {
        return normalizeCaseSpec(c, multi ? 'case-' + (i + 1) : 'ai-verify');
      } catch (e) {
        const msg = (e && e.message) || String(e);
        throw new Error(multi ? 'cases[' + i + ']（' + (c.name || '未命名') + '）：' + msg : 'op=verify：' + msg);
      }
    });
    /*
     * ⚠️ `runCase` 需要一个**活着的 worker**（它只在 worker 内的 studio 上重放），而 worker 里的
     * 工程是 `start` 那一刻送进去的 archive。所以先 `start` 一次把**当前**工程送进去
     * （否则刚 patch 完就 verify 会拿不到新脚本），再让 runCase 在 worker 里重开一个全新会话重放。
     */
    await controller.play('start', {
      canvasId: args.canvasId || undefined,
      playerCount: Number(args.playerCount) || specs[0].playerCount,
      viewPlayerIndex: args.viewPlayerIndex,
    });

    const shotOnFail = args.shotOnFail !== false;   // 默认开：判定没过时，AI 除了日志还该看一眼画面
    const ran = [];
    for (const spec of specs) {
      const res = await controller.play('runCase', {
        case: spec,
        canvasId: args.canvasId || undefined,
        playerCount: spec.playerCount,
        viewPlayerIndex: args.viewPlayerIndex,
      });
      const row = {
        name: spec.name,
        passed: !!(res && res.passed),
        failedAt: res && 'failedAt' in res ? res.failedAt : null,
        frame: (res && res.frame) || 0,
        results: (res && res.results) || [],
        snapshot: (res && res.snapshot) || null,
        spec,
      };
      ran.push(row);
      // 首个失败就地取证（截图 + 运行时控件名）；后面的失败只报判定，免得攒一摞图
      if (!row.passed && ran.filter((r) => !r.passed).length === 1) {
        Object.assign(row, await failureEvidence(controller, row.name, { shot: shotOnFail }));
      }
      if (!row.passed && args.stopOnFail === true) break;
    }

    const failed = ran.filter((r) => !r.passed);
    const firstBad = failed[0] || null;
    const stopAfter = args.keepRunning !== true;
    if (stopAfter) await controller.play('stop', {}).catch(() => {});

    /* 单条用例：保持原有扁平形状（AI 与测试都照这个抄） —— 不因为加了 cases 而改名 */
    if (!multi) {
      const row = ran[0];
      const out = {
        passed: row.passed,
        failedAt: row.failedAt,
        frame: row.frame,
        results: row.results,
        snapshot: row.snapshot,
        case: { name: row.spec.name, dt: row.spec.dt || null, playerCount: row.spec.playerCount, events: row.spec.events, asserts: row.spec.asserts },
        note: '确定性重放：`runCase` 会**开一个全新会话**再按 t 重放事件、按 at 判定断言（所以可重复）；它不认 `device` 事件。'
          + '判定没过时会顺带取证：`shot`（失败点附近的一帧 PNG）+ `runtime.controlNames`（运行时控件名），不需要就传 shotOnFail:false。'
          + (historyEvents ? '本条用例的事件来自 `fromHistory`（刚跑过那一局共 ' + historyEvents.length + ' 步）——**回放会重开会话，浏览器/面板里那局就此结束**。' : ''),
      };
      if (row.runtime) out.runtime = row.runtime;
      if (row.shot) out.shot = row.shot;
      if (!row.passed) out.hint = failureHint(row.results, row.frame);
      if (manualItems.length) out.manual = manualItems;
      return out;
    }

    /* 多条用例：一次调用跑一整组回归 */
    const out = {
      passed: failed.length === 0,
      caseCount: ran.length,
      passedCount: ran.length - failed.length,
      failedCount: failed.length,
      cases: ran.map((r) => {
        const item = { name: r.name, passed: r.passed, failedAt: r.failedAt, frame: r.frame, results: r.results };
        // 通过的用例不回日志（噪音）；没过的回最后几行，够定位
        const logs = (r.snapshot && r.snapshot.logs) || [];
        if (!r.passed) item.logs = logs.slice(-10);
        if (r.runtime) item.runtime = r.runtime;
        if (r.shot) item.shot = r.shot;
        return item;
      }),
      failures: failed.map((r) => ({ name: r.name, failedAt: r.failedAt, hint: failureHint(r.results, r.frame) })),
      note: '一组用例各自**开一个全新会话**确定性重放（互不影响，所以能当回归套件）；'
        + '默认**跑完所有用例**（要第一个不过就停传 stopOnFail:true）。首个失败的用例带 shot + runtime 取证。',
    };
    if (firstBad) {
      out.hint = '第 ' + (ran.indexOf(firstBad) + 1) + '/' + ran.length + ' 个用例没过（' + firstBad.name + '）：' + failureHint(firstBad.results, firstBad.frame);
      if (firstBad.shot) out.shot = firstBad.shot;
      if (firstBad.runtime) out.runtime = firstBad.runtime;
    }
    if (ran.length < specs.length) out.stoppedEarly = true;
    if (manualItems.length) out.manual = manualItems;
    return out;
  }

  if (op === 'frames') {
    /*
     * **按时间点出一串帧 + 帧间差异** —— 回答「动画真的在动吗 / 动的是哪一块」。
     *
     * 两条实现决定（都不是随便选的）：
     *   ① 内部用「**暂停 + 单步**」推进时间：worker 自己有个 30FPS 的 setInterval 在走，
     *      不暂停的话时间会自己往前跑 —— 帧就对不上时间点，也不可复现（面板的「单步」同理）。
     *   ② 每帧回**全量场景**由 Host 自己比字段，不依赖引擎的增量协议：
     *      得到的是「控件 X 的 anchoredPositionX 0 → 50」这种能直接定位的答案。
     */
    const rawTimes = (Array.isArray(args.frames) ? args.frames : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (!rawTimes.length) {
      throw new Error('op=frames 需要 frames:[0,0.5,1]（模拟秒，升序；最多 12 个）。例如 '
        + '{"op":"frames","frames":[0,0.5,1],"steps":[{"click":{"x":800,"y":450}}]}');
    }
    if (rawTimes.length > 12) throw new Error('op=frames 最多 12 帧（每帧一张 PNG 还要解码比像素），收到 ' + rawTimes.length + ' 个');
    const times = rawTimes.slice().sort((a, b) => a - b);
    const events = buildEvents(args.steps, args.events).slice().sort((a, b) => a.t - b.t);
    const dt = Number(args.dt) > 0 ? Number(args.dt) : 1 / 30;
    const playerCount = Number(args.playerCount) || 1;
    const total = times[times.length - 1] || 0;
    const stepCount = Math.ceil(total / dt);
    if (stepCount > 1200) {
      throw new Error('op=frames 要推进 ' + stepCount + ' 步（最后一帧 t=' + total + 's / dt=' + dt + '）—— 太大：'
        + '给更短的帧时间，或用更大的 `dt`（默认 1/30 秒）');
    }
    const wantDiff = args.diff !== false;
    const threshold = Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : 8;

    const first = await controller.play('start', {
      canvasId: args.canvasId || undefined, playerCount, viewPlayerIndex: args.viewPlayerIndex,
      view: true, compact: true,
    });
    await controller.play('pause', {});   // 冻结时钟：只有下面显式 step 才前进
    const frames = [];
    const fieldDiffs = [];
    let time = 0;
    let ei = 0;
    let prevScene = sceneById(first && first.scene && first.scene.nodes);
    let touchedClock = false;

    async function applyDue() {
      while (ei < events.length && events[ei].t <= time + 1e-9) {
        const act = eventToAction(events[ei]);
        if (act) {
          if (act[0] === 'pause' || act[0] === 'resume') touchedClock = true;
          await controller.play(act[0], act[1]);
        }
        ei += 1;
      }
      // steps 里若有人 resume，会把 30FPS 时钟重新放开 —— 立刻再冻住，否则帧时间点会漂
      if (touchedClock) { await controller.play('pause', {}).catch(() => {}); touchedClock = false; }
    }

    try {
      await applyDue();
      for (const t of times) {
        while (time + 1e-9 < t) {
          const d = Math.min(dt, Number((t - time).toFixed(9)));
          await controller.play('step', { dt: d, light: true });
          time = Number((time + d).toFixed(9));
          await applyDue();
        }
        await applyDue();
        const img = await controller.playScreenshot();
        // 标签保持短：`sanitizeLabel` 上限 24 字符，写长了会把 `t0.5` 截断（踩过）
        const label = (args.label ? String(args.label) + '-' : '') + 't' + String(t);
        const w = writePng(img.data, { target: 'sim-play', label });
        const obs = wantDiff ? await controller.play('get', { view: true, compact: true }) : null;
        const nowScene = obs ? sceneById(obs.scene && obs.scene.nodes) : new Map();
        const fields = obs ? changedFields(prevScene, nowScene) : null;
        if (obs) prevScene = nowScene;
        frames.push({
          t, name: w.name, file: w.file, bytes: w.bytes, bytesText: w.bytesText,
          frame: img.frame, time: img.time, canvasId: img.canvasId,
          pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight,
          url: '/miliastra/shot?name=' + encodeURIComponent(w.name),
        });
        if (fields) fieldDiffs.push(fields.changed);
      }
    } finally {
      if (args.keepRunning !== true) await controller.play('stop', {}).catch(() => {});
    }

    const diffs = [];
    if (wantDiff) {
      for (let i = 1; i < frames.length; i += 1) {
        let pixels = null;
        try {
          pixels = await diffPngs(fs.readFileSync(frames[i - 1].file), fs.readFileSync(frames[i].file), threshold);
        } catch (e) {
          pixels = { error: (e && e.message) || String(e) };
        }
        diffs.push({
          from: frames[i - 1].t, to: frames[i].t,
          ...pixels,
          changedControls: fieldDiffs[i] || [],
        });
      }
    }

    return {
      target: 'play',
      frameTimes: times,
      frameCount: frames.length,
      frames,
      diffs,
      dir: frames[0] ? path.dirname(frames[0].file) : shotsDir(),
      note: '帧是**暂停 + 单步**推进出来的（可复现）：`diffs[].changedPixels` 是超过阈值的像素数（默认 8/通道），'
        + '`bbox` 是变化区域（**图像像素坐标，左上原点**），`changedControls` 是同一区间里字段真的变了的控件（更直接）。'
        + '`identical:true` = 逐像素相同（这是事实，不是判决）。看画面用 read_image 打开 `frames[].file`。'
        + (wantDiff ? '' : '（本次 diff:false，只出帧不比像素）'),
    };
  }

  if (op === 'shot') {
    const target = String(args.target || 'ui');
    const reuse = args.reuse === true;
    if (target === 'play') {
      const img = await controller.playScreenshot();
      const w = writePng(img.data, { target: 'sim-play', label: args.label || '', reuse });
      return {
        target, ...w, width: img.width, height: img.height,
        pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight,
        canvasId: img.canvasId, frame: img.frame, time: img.time,
        // 连帧必须绕开浏览器缓存（/shot 路由是 immutable 缓存），所以带时间戳
        url: '/miliastra/shot?name=' + encodeURIComponent(w.name) + (reuse ? '&t=' + Date.now() : ''),
        note: '试玩画面由 Host 按引擎场景树渲染成 PNG（不是抓游戏窗口），不需要游戏在前台。' + (reuse ? ' reuse=true：固定名覆盖写，磁盘只留一张当前帧。' : ''),
      };
    }
    const img = controller.uiScreenshot();
    const w = writePng(img.data, { target: 'sim-ui', label: args.label || '', reuse });
    return {
      target: 'ui', ...w, page: img.page, width: img.width, height: img.height,
      pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight,
      url: '/miliastra/shot?name=' + encodeURIComponent(w.name) + (reuse ? '&t=' + Date.now() : ''),
      note: '编辑器视图 PNG：按当前工程几何渲染，含容器与控件框。',
    };
  }

  if (op === 'keys') {
    const raw = controller.get();
    const scripts = Array.isArray(raw.scripts) ? raw.scripts : [];
    const src = scripts.map((s) => String(s.source || '')).join('\n');
    const found = scanScriptKeys(src);
    const keys = found.map((f) => f.name);
    const literals = found.filter((f) => f.via === 'string-literal');
    const enumed = found.length - literals.length;
    /*
     * ⚠️ `from` 这段话以前**把原因说反了**（实测事故）：脚本里明明有 `KeyEventType`（放在候选表里），
     * 只是按键名是裸字符串写法，旧实现却回「脚本源码里没出现 KeyEventType」——
     * AI 会据此去**猜**按键名，而按键名猜错是**静默失败**。所以三种情况分开说清。
     */
    const mentionsEnum = /KeyEventType/.test(stripLuaComments(src));
    return {
      keys,
      count: keys.length,
      // 每条名字 + 来源：AI 要判断"这个键名可不可信"就靠它（enum 明确 / string-literal 是启发式）
      found,
      byVia: { enum: enumed, stringLiteral: literals.length },
      scriptCount: scripts.length,
      from: keys.length
        ? '从**你脚本的源码**里扫出来的键名（`found[].via` 标明来源）：`enum-*` = 写法明确（`KeyEventType.X`）；'
          + '`string-literal` = **启发式**（键名当裸字符串传，如 `bindHold("KeyboardMoveRightKeyDown", …)` —— '
          + '这 ' + literals.length + ' 个里可能有被注释掉/死分支的，但**比不看强**，实测真脚本就是这么写的）'
        : (mentionsEnum
          ? '源码里有 `KeyEventType`，但**不是 `KeyEventType.X` 这种写法**（大概是放进候选表/动态取值），'
            + '按键名也没以裸字符串出现 —— 这属于插件认不出的写法：拿 `presets` 里的候选键用 `op=play action=key` **试发**一个，'
            + '再看快照的 `logs` 有没有反应（**别猜键名，试**）'
          : '扫完了：既没有 `KeyEventType.*`，也没有 `Keyboard*/Controller*` 的裸字符串键名 —— '
            + '它可能真不监听按键（比如只吃指针），或用了插件认不出的写法（试发一个候选键看 `logs`）'),
      // 引擎的键名是官方那套（工匠键 1~43 + 语义键），不是 W/A/S/D
      presets: [
        'KeyboardCraftspersonKey1Down', 'KeyboardCraftspersonKey2Down', 'KeyboardCraftspersonKey3Down',
        'KeyboardMoveForwardKeyDown', 'KeyboardMoveBackwardKeyDown', 'KeyboardMoveLeftKeyDown', 'KeyboardMoveRightKeyDown',
        'KeyboardJumpKeyDown', 'KeyboardInteractKeyDown', 'KeyboardSprintKeyDown',
      ],
      /*
       * ★ `all:true` 给**全量键名**（164 项）—— 直接从引擎的枚举正源生成，不抄表（抄一份就会过期）。
       * 为什么必须给：AI 想"试发一个键看看游戏理不理"的时候，它得先知道**存在哪些名字**；
       * 以前只有 10 条 presets + 一份工作区文档，AI 就会去翻源码/枚举表（实测：为了发一个按键翻了 4 个文件）。
       * ⚠️ 164 个名字 ≈ 3KB，所以**默认不给**，要就显式要。
       */
      ...(args.all === true
        ? { all: Object.keys(buildEnumTree().KeyEventType || {}), allCount: Object.keys(buildEnumTree().KeyEventType || {}).length }
        : { allCount: Object.keys(buildEnumTree().KeyEventType || {}).length, allHint: '要全量 164 个键名就传 `all:true`' }),
      /*
       * ★ **请求形状**（这就是本节作者的原话「找个按键这么久」的根因）：
       * 我知道键名之后，还得翻 4 个源文件才知道 `play` 的 `key` 到底怎么发（`session.js` → `browser-session.js`
       * → `controller.js` → `worker.js` 里才看到 `studio.playKey(args.key, …)`）。这属于**schema 该说的话**，
       * 不该让 AI 去读实现。所以这里直接把**可照抄的请求体**给出来。
       */
      press: {
        key: { body: { op: 'play', action: 'key', args: { key: 'KeyboardJumpKeyDown' } }, note: '发 Down 之后**要配对发 Up**（KeyboardJumpKeyUp），否则等于一直按住' },
        pointer: { body: { op: 'play', action: 'pointer', args: { type: 'move', x: 800, y: 450 } }, note: 'type = move | down | up | click；坐标**左下原点**' },
        click: { body: { op: 'play', action: 'click', args: { name: '按钮名' } }, note: '按控件名点（没名字的控件用 pointer 坐标）' },
        step: { body: { op: 'play', action: 'step', args: { dt: 0.0333 } }, note: '先 pause 再单步；跑着的时候那个 30FPS 时钟自己也走' },
        hud: { body: { op: 'hud' }, note: '读画面上的字（关卡/分数）—— 别 dump 整个场景' },
      },
      // 松键：只按 Down 会把角色**一直按住**（实测会把小人一路推到掉出边界）——`Up` 名字从哪来也给出来
      releaseNote: '⚠️ 按了 `…Down` 就要配对发 `…Up`（例：`KeyboardMoveRightKeyDown` → `KeyboardMoveRightKeyUp`），'
        + '否则等于**一直按住**这个键（实测：只发 Down 会把角色一路推到掉出边界重生）。',
    };
  }

  if (op === 'load') {
    if (!args.archive && !args.path) return controller.listArchives();
    const r = controller.loadArchive(String(args.archive || args.path));
    return { loaded: args.archive || args.path, ...slimState(controller.get(), { summaryOnly: true }), result: r };
  }

  if (op === 'save') {
    const r = controller.saveArchive(args.path || undefined);
    return { saved: r, workspace: simWorkspace() };
  }

  if (op === 'export') {
    const format = String(args.format || 'gia');
    const r = controller.studio.exportData(format, args.assetType ? String(args.assetType) : '');
    const dir = path.join(simWorkspace(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const wanted = String((r && r.filename) || ('sim-export-' + format + '.bin')).replace(/[\\/:*?"<>|]/g, '');
    const name = nextFreeName(dir, wanted);
    const file = path.join(dir, name);
    const buf = Buffer.from((r && r.data) || '', 'base64');
    atomicWriteFile(file, buf);
    return {
      format, file, name, dir,
      bytes: buf.length, bytesText: humanSize(buf.length),
      warnings: (r && r.warnings) || null,
      note: '导出到**模拟器工作区**（不是游戏目录）。⚠️「GIA 能否被官方编辑器接受」**尚未在真机导入验证** —— 请拿这个文件进编辑器试，再回来记结论。',
    };
  }

  if (op === 'import') {
    const format = String(args.format || 'gia');
    if (!args.file) throw new Error('op=import 需要 file（要导入的文件绝对路径）');
    const target = path.resolve(String(args.file));
    const buf = fs.readFileSync(target);
    const res = controller.studio.importData(format, buf.toString('base64'), path.basename(target));
    return {
      imported: path.basename(target), format,
      ...slimState(controller.get(), { summaryOnly: true }),
      result: res,
    };
  }

  if (op === 'reset') {
    const d = await disposeSim(ctx);
    const st = controllerFor(ctx).get();
    return { reset: true, disposed: d.disposed, ...slimState(st, { summaryOnly: true }) };
  }

  throw new Error('未知 op：' + op + '（可用：state / patch / bind / play / verify / cases / controls / frames / shot / keys / export / import / load / save / reset）');
}
