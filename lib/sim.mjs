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
    canvas: st.canvas ? { id: st.canvas.id, label: st.canvas.label, width: st.canvas.width, height: st.canvas.height, platform: st.canvas.platform } : null,
    asset: st.asset || null,
    selectedId: st.selectedId || '',
    meta: st.meta || null,
    save: st.save ? { name: st.save.name, activeAssetType: st.save.activeAssetType } : null,
    workspace: st.workspace ? { name: st.workspace.name, bound: !!st.workspace.bound, path: st.workspace.path } : null,
    treeCount: tree.length,
    boxCount: boxes.length,
    scriptCount: Array.isArray(st.scripts) ? st.scripts.length : 0,
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

function writePng(buf, { target, label }) {
  const dir = shotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const wanted = shotFileName({ target, label });
  const name = nextFreeName(dir, wanted);
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
    const res = await controller.play(action, args.args || args.playArgs || {});
    return { action, ...slimPlay(res || {}, { summaryOnly: args.summaryOnly !== false }) };
  }

  if (op === 'shot') {
    const target = String(args.target || 'ui');
    if (target === 'play') {
      const img = await controller.playScreenshot();
      const w = writePng(img.data, { target: 'sim-play', label: args.label || '' });
      return {
        target, ...w, width: img.width, height: img.height,
        pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight,
        canvasId: img.canvasId, frame: img.frame, time: img.time,
        url: '/miliastra/shot?name=' + encodeURIComponent(w.name),
        note: '试玩画面由 Host 按引擎场景树渲染成 PNG（不是抓游戏窗口），不需要游戏在前台。',
      };
    }
    const img = controller.uiScreenshot();
    const w = writePng(img.data, { target: 'sim-ui', label: args.label || '' });
    return {
      target: 'ui', ...w, page: img.page, width: img.width, height: img.height,
      pixelWidth: img.pixelWidth, pixelHeight: img.pixelHeight,
      url: '/miliastra/shot?name=' + encodeURIComponent(w.name),
      note: '编辑器视图 PNG：按当前工程几何渲染，含容器与控件框。',
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

  throw new Error('未知 op：' + op + '（可用：state / patch / play / shot / export / import / load / save / reset）');
}
