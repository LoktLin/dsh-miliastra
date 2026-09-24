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
import { SimulatorController } from '../engine/studio/host/controller.js';
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

/** 试玩快照瘦身：scene 是给渲染器用的，除非要，否则不回。 */
function slimPlay(res, { summaryOnly = true } = {}) {
  if (!res || typeof res !== 'object') return res;
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    if (k === 'scene' || k === 'paint') { out[k + 'Omitted'] = Array.isArray(v) ? v.length : 1; continue; }
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
  fs.writeFileSync(file, buf);
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
function buildEvents(steps, explicit) {
  const out = [];
  let cursor = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') throw new Error('op=verify 的 steps 每项必须是对象：' + JSON.stringify(s));
    const at = Number.isFinite(Number(s.at)) ? Number(s.at) : cursor;
    if (s.key !== undefined) out.push({ kind: 'key', t: at, payload: { typeName: String(s.key) } });
    else if (s.click) out.push({ kind: 'pointer', t: at, payload: { type: 'click', x: Number(s.click.x) || 0, y: Number(s.click.y) || 0 } });
    else if (s.clickName !== undefined) out.push({ kind: 'click', t: at, payload: { name: String(s.clickName) } });
    else if (s.setVar) out.push({ kind: 'serverSet', t: at, payload: { entityType: s.setVar.entityType || 'PlayerSelf', name: String(s.setVar.name), value: s.setVar.value } });
    else if (s.sendSignal) out.push({ kind: 'serverSend', t: at, payload: { name: String(s.sendSignal.name), params: s.sendSignal.params || [], target: s.sendSignal.target || 'PlayerSelf' } });
    else if (s.view !== undefined) out.push({ kind: 'view', t: at, payload: { playerIndex: Number(s.view) } });
    else if (s.pause) out.push({ kind: 'pause', t: at, payload: {} });
    else if (s.resume) out.push({ kind: 'resume', t: at, payload: {} });
    else throw new Error('op=verify 的 steps 里这一项看不懂：' + JSON.stringify(s) + '（可用 key / click:{x,y} / clickName / setVar / sendSignal / view / pause / resume）');
    cursor = at + (Number.isFinite(Number(s.after)) ? Number(s.after) : 0.1);
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
    throw new Error('缺少 expect（至少一条断言）：kind 可为 log / control / var / signal / tree / lua，例如 {"kind":"log","contains":"SCORE"}');
  }
  const events = buildEvents(a.steps || [], a.events);
  const lastT = events.reduce((m, e) => Math.max(m, Number(e.t) || 0), 0);
  const asserts = expect.map((row, i) => {
    const r = Object.assign({}, row);
    if (!r.kind) throw new Error('expect[' + i + '] 缺 kind（log / control / var / signal / tree / lua）');
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
    const live = await controller.play('get', { inspect: true });
    return { source: 'runtime', running: true, ...compactControls(live, args) };
  }

  if (op === 'state') {
    return slimState(controller.get(), { summaryOnly: args.summaryOnly !== false, treeLimit: Number(args.treeLimit) || 0 });
  }

  if (op === 'patch') {
    const patch = args.patch || args.p;
    if (!patch || typeof patch !== 'object') throw new Error('op=patch 需要 patch 对象，例如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题"}');
    controller.patch(patch);
    const st = controller.get();
    return { applied: patch.op || Object.keys(patch)[0] || 'patch', version: st.version, ...slimState(st, { summaryOnly: true }) };
  }

  if (op === 'play') {
    const action = String(args.action || 'get');
    const a = Object.assign({}, args.args || args.playArgs || {});
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
      return { action, ...slimPlay(res || {}, { summaryOnly: args.summaryOnly !== false }) };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/playerIndex must be an integer/.test(msg)) {
        throw new Error(msg + ' —— 视角号必须在 1..当前人数 之间；人数由 `op=play action=start` 的 `playerCount`（1–8）决定（切设备后 Host 会自动沿用）。');
      }
      throw e;
    }
  }

  if (op === 'verify') {
    /*
     * **AI 自测逻辑的主入口**：一次调用 = 跑一段操作 + 到点断言 + 给判定。
     *
     * 引擎自带这套（`studio/autotest/runner.js` 的 `replayCase`：确定性重放、失败即返回 `failedAt`），
     * 但它的原生形状是「先交互跑一遍 → history → saveCase → runCase」——对 AI 是三次来回还容易错。
     * 这里由 Host 直接组好用例走 `runCase`；它会**开一个全新会话**再重放 ⇒ 每次结果一致。
     */
    const casesArg = Array.isArray(args.cases) ? args.cases.filter((c) => c && typeof c === 'object') : null;
    const multi = !!(casesArg && casesArg.length);
    const rawList = multi ? casesArg : [args];
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
          + '判定没过时会顺带取证：`shot`（失败点附近的一帧 PNG）+ `runtime.controlNames`（运行时控件名），不需要就传 shotOnFail:false。',
      };
      if (row.runtime) out.runtime = row.runtime;
      if (row.shot) out.shot = row.shot;
      if (!row.passed) out.hint = failureHint(row.results, row.frame);
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
    return out;
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
    const found = new Set();
    // 覆盖 Enum.KeyEventType.X / Enum.KeyEventType["X"] 两种写法
    const re = /KeyEventType\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/g;
    let m = re.exec(src);
    while (m !== null) {
      const name = m[1] || m[2];
      if (name) found.add(name);
      m = re.exec(src);
    }
    const keys = [...found].sort();
    return {
      keys,
      count: keys.length,
      scriptCount: scripts.length,
      from: keys.length
        ? '从**你脚本的源码**里扫出来的 `KeyEventType` 名字（就是它真正在听的键）'
        : '脚本源码里没出现 `KeyEventType` —— 可能没监听按键，或用别的方式判断',
      // 引擎的键名是官方那套（工匠键 1~43 + 语义键），不是 W/A/S/D
      presets: [
        'KeyboardCraftspersonKey1Down', 'KeyboardCraftspersonKey2Down', 'KeyboardCraftspersonKey3Down',
        'KeyboardMoveForwardKeyDown', 'KeyboardMoveBackwardKeyDown', 'KeyboardMoveLeftKeyDown', 'KeyboardMoveRightKeyDown',
        'KeyboardJumpKeyDown', 'KeyboardInteractKeyDown', 'KeyboardSprintKeyDown',
      ],
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
    fs.writeFileSync(file, buf);
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

  throw new Error('未知 op：' + op + '（可用：state / patch / play / verify / shot / keys / export / import / load / save / reset）');
}
