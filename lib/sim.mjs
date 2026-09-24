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

export async function simOp(args = {}, ctx = {}) {
  const op = String(args.op || 'state');
  const controller = controllerFor(ctx);

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
    const steps = args.steps || [];
    const expect = args.expect || args.asserts || [];
    if (!Array.isArray(expect) || expect.length === 0) {
      throw new Error('op=verify 需要 expect（至少一条断言）：kind 可为 log / control / var / signal / tree / lua，例如 {"kind":"log","contains":"SCORE"}');
    }
    const events = buildEvents(steps, args.events);
    const lastT = events.reduce((m, e) => Math.max(m, Number(e.t) || 0), 0);
    const asserts = expect.map((row, i) => {
      const r = Object.assign({}, row);
      if (!r.kind) throw new Error('expect[' + i + '] 缺 kind（log / control / var / signal / tree / lua）');
      // at 省略 = 最后一个事件之后 0.1s ⇒ 查的是「这一串操作做完之后的最终状态」
      if (!Number.isFinite(Number(r.at))) r.at = Number((lastT + 0.1).toFixed(3));
      return r;
    });
    const playerCount = Number(args.playerCount) || 1;
    const caseSpec = { name: String(args.name || 'ai-verify'), dt: args.dt, playerCount, events, asserts };
    /*
     * ⚠️ `runCase` 需要一个**活着的 worker**（它只在 worker 内的 studio 上重放），而 worker 里的
     * 工程是 `start` 那一刻送进去的 archive。所以先 `start` 一次把**当前**工程送进去
     * （否则刚 patch 完就 verify 会拿不到新脚本），再让 runCase 在 worker 里重开一个全新会话重放。
     */
    await controller.play('start', {
      canvasId: args.canvasId || undefined,
      playerCount,
      viewPlayerIndex: args.viewPlayerIndex,
    });
    const res = await controller.play('runCase', {
      case: caseSpec,
      canvasId: args.canvasId || undefined,
      playerCount,
      viewPlayerIndex: args.viewPlayerIndex,
    });
    const out = {
      passed: !!(res && res.passed),
      failedAt: res && 'failedAt' in res ? res.failedAt : null,
      frame: (res && res.frame) || 0,
      results: (res && res.results) || [],
      snapshot: (res && res.snapshot) || null,
      case: { name: caseSpec.name, dt: caseSpec.dt || null, playerCount, events, asserts },
      note: '确定性重放：`runCase` 会**开一个全新会话**再按 t 重放事件、按 at 判定断言（所以可重复）；它不认 `device` 事件。',
    };
    if (!out.passed) {
      const bad = out.results.find((r) => !r.ok);
      out.hint = bad
        ? ('第 ' + (out.results.indexOf(bad) + 1) + ' 条断言没过：kind=' + bad.kind
          + ' 期望 ' + JSON.stringify(bad.expected) + ' 实际 ' + JSON.stringify(bad.actual)
          + '（t=' + bad.at + 's / frame=' + out.frame + '）。看 results 与 snapshot.logs / serverLogs 定位，改完再跑一次 verify。')
        : 'verify 没过但 results 里没有失败项（异常情况，看 error）。';
    }
    // 默认收掉会话（判定已经拿到，留着只是空烧 Worker 的 30FPS 时钟）；要接着交互就传 keepRunning:true
    if (args.keepRunning !== true) await controller.play('stop', {}).catch(() => {});
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
