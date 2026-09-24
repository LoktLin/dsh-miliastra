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
import { scanLevels, pickCurrent } from './locate.mjs';
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
/** 取一个点：`[x,y]` 或 `{x,y}` 都认（写起来顺手最重要）。 */
function pointOf(v, label) {
  if (Array.isArray(v) && v.length >= 2) return { x: Number(v[0]) || 0, y: Number(v[1]) || 0 };
  if (v && typeof v === 'object') return { x: Number(v.x) || 0, y: Number(v.y) || 0 };
  throw new Error(label + ' 需要 [x,y] 或 {x,y}（收到 ' + JSON.stringify(v) + '）');
}

function buildEvents(steps, explicit) {
  const out = [];
  let cursor = 0;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') throw new Error('op=verify 的 steps 每项必须是对象：' + JSON.stringify(s));
    const at = Number.isFinite(Number(s.at)) ? Number(s.at) : cursor;
    let stepEnd = at;
    if (s.key !== undefined) out.push({ kind: 'key', t: at, payload: { typeName: String(s.key) } });
    else if (s.click) out.push({ kind: 'pointer', t: at, payload: { type: 'click', x: Number(s.click.x) || 0, y: Number(s.click.y) || 0 } });
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
      out.push({ kind: 'pointer', t: at, payload: { type: String(p.type || 'move'), x: Number(p.x) || 0, y: Number(p.y) || 0 } });
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

/** 真机交接的 id（控件模板索引 / 容器节点索引）都在这个量级以上。 */
const HANDOVER_MIN = 1073741824;

/**
 * 交接的**模板清单**：`[{guid, kind, name?}]`。
 *
 * `guid` **只能来自创作者**（真机「界面控件组库 → 客户端控件模板」里那条模板的索引）——
 * 编造一个号的后果是脚本 `InstantiateClientUIControl()` 永远解析不到它，而且**不报错**（静默什么都不建）。
 * 所以这里宁可报错也不给默认值。
 */
function normalizeBindTemplates(raw) {
  const list = Array.isArray(raw) ? raw.filter((t) => t && typeof t === 'object') : [];
  if (!list.length) {
    throw new Error('op=bind 需要 templates:[{guid,kind,name?}] —— guid 是**创作者交接的控件模板索引**（不许编造），kind 是控件类型。例：'
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
    if (BIND_KINDS.indexOf(kind) < 0) {
      throw new Error('templates[' + i + '].kind 必须是 ' + BIND_KINDS.join(' / ') + ' 之一，收到 ' + JSON.stringify(t.kind));
    }
    return { guid, kind, name: t.name ? String(t.name) : (KIND_LABELS[kind] + '模板'), id: t.id ? String(t.id) : undefined };
  });
}

/** 要绑的 Lua：给 `source`（真机活文件的**绝对路径**）或 `script:{path,source}`（直接给源码）。 */
async function readBindScript(args) {
  const inline = args.script && typeof args.script === 'object' ? args.script : null;
  let source = '';
  let stem = 'script';
  let file = '';
  let mtimeMs = 0;
  if (inline && typeof inline.source === 'string' && inline.source.trim()) {
    source = inline.source;
    file = String(inline.file || '');
  } else {
    file = String(args.source || (inline && inline.file) || '');
    if (!file) throw new Error('op=bind 需要 source（真机活文件 .lua 的绝对路径），或 script:{path,source} 直接给源码');
    const abs = path.resolve(file);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      throw new Error('op=bind: 读不到 Lua 文件 ' + abs + '（' + ((e && e.message) || e) + '）——路径要绝对路径，且必须是**活文件**（沙箱里那份 .lua）');
    }
    source = buf.toString('utf8');
    mtimeMs = fs.statSync(abs).mtimeMs;
    file = abs;
  }
  // 挂载名：真机的挂载名是创作者给的（双相的 checkMount() 就拿它跟脚本名比对）。缺省用文件名（含 .lua）。
  const scriptPath = String(args.scriptName || (inline && inline.path) || (file ? path.basename(file) : 'script.lua'));
  if (file && !args.scriptName) stem = path.basename(file).replace(/\.lua$/i, '') || 'script';
  else stem = scriptPath.replace(/\.lua$/i, '') || 'script';
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
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 清单里的一条 = 自动用例（events+asserts）或**人工项**（`manual:true`，要人看画面/真机确认）。 */
function normalizeBookCase(raw, fallbackName) {
  const row = raw && typeof raw === 'object' ? raw : {};
  if (row.manual === true) {
    if (!row.note) throw new Error('人工项（manual:true）必须带 note：写清"人要看什么、看到什么算过"');
    return { name: String(row.name || fallbackName || '人工项'), manual: true, note: String(row.note) };
  }
  const spec = normalizeCaseSpec(row, fallbackName);
  const note = row.note ? String(row.note) : '';
  return note ? Object.assign({}, spec, { note }) : spec;
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
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(recipe, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 从 Lua 源码里**抽候选交接值**（纯函数，可单测）。
 *
 * 交接值的老毛病：创作者给号，抄错一位 → 脚本 `InstantiateClientUIControl` 静默什么都不建。
 * 源码里一般写着 `local IMAGE_TEMPLATE = 1073741868` 这种常量，所以「读源码里的 9 位以上大整数」
 * 能把**真值**摆出来，而不是靠人抄。`kindHint` 只看变量名（IMAGE/TEXT/CONTAINER…）——
 * **只是提示**：控件类型猜错同样是静默失败，必须由人 / 创作者确认。
 */
function handoverCandidates(source) {
  const text = String(source || '').slice(0, 400000);
  const rows = [];
  const seen = new Set();
  const re = /(?:^|\n)[^\S\n]*local[^\S\n]+([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*=[^\S\n]*([0-9]{9,})[^\n]*/g;
  let m = re.exec(text);
  while (m !== null) {
    const value = Number(m[2]);
    if (value >= HANDOVER_MIN && !seen.has(value)) {
      seen.add(value);
      const name = m[1];
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

  if (op === 'handover') {
    /*
     * **交接值体检**：把「这台机器上有哪些活文件」与「这份 Lua 里写着哪些真机 id」摆出来。
     *
     * 为什么值得单独一个 op：`bind` 最难的不是搭工程，是**交接值从哪来**。
     * 创作者给的号写在脚本常量里（`local IMAGE_TEMPLATE = 1073741868`），
     * 所以"读源码抽候选"比"让人抄一遍"可靠得多 —— 但它仍然只是**候选**：
     * `kindHint` 只看变量名，控件类型必须人来定（猜错同样静默失败）。
     */
    const { rows, currentLevel } = liveFileRows();
    const picked = args.source ? path.resolve(String(args.source)) : '';
    const auto = rows.find((r) => !r.auxiliary && r.current) || rows.find((r) => !r.auxiliary) || rows[0] || null;
    const file = picked || (auto && auto.path) || '';
    if (!file) {
      return {
        files: [], fileCount: 0, picked: null, candidates: [], suggestedTemplates: [], containerId: null,
        note: '这台机器上**没扫到活文件**（真机 .lua）。路径随账号/换图变化，先用 miliastra_health 定位；'
          + '或者直接给 `source`（绝对路径）只做交接值抽取。',
      };
    }
    let source = '';
    if (fs.existsSync(file)) source = fs.readFileSync(file, 'utf8');
    else if (picked) throw new Error('op=handover: 读不到 ' + file);
    const candidates = handoverCandidates(source);
    const templates = candidates.filter((c) => c.isTemplate).map((c) => ({
      guid: c.value,
      kind: c.kindHint,
      name: c.name,
    }));
    const containers = candidates.filter((c) => c.role === 'container');
    return {
      files: rows.slice(0, 40),
      fileCount: rows.length,
      currentLevel,
      picked: file,
      pickedBytes: source ? Buffer.byteLength(source, 'utf8') : 0,
      candidates,
      suggestedTemplates: templates,
      containerId: containers.length ? containers[0].value : null,
      note: '`candidates` 来自源码里 `local NAME = <9 位以上整数>`（**启发式**：名字像什么就提示什么 kind）；'
        + '`kindHint` 只是提示 —— **控件类型猜错 = 静默什么都不建**，请创作者确认后再 `op=bind`。'
        + '⚠️ `extra` 里可能混着关卡 ID 这类别的号（如 1073741833），别当成模板。',
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
    const bindArgs = useLast
      ? Object.assign({}, args, {
        source: recipe.source,
        templates: recipe.templates,
        containerId: recipe.containerId,
        scriptName: recipe.scriptName,
        canvasId: args.canvasId || recipe.canvasId,
      })
      : args;
    const CLIENT = 'client-control-template';
    const SERVER = 'server-control-template';
    const templates = normalizeBindTemplates(bindArgs.templates);
    const script = await readBindScript(bindArgs);
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
    controller.patch({ op: 'newAsset', assetType: CLIENT });
    for (const t of templates) {
      controller.patch({ op: 'addTemplate', kind: t.kind, name: t.name, guid: t.guid, id: t.id });
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
    controller.patch({ op: 'addScript', controlId: mount.id, controlAsset: SERVER, path: script.path, source: script.source });
    if (canvasId) controller.patch({ op: 'setCanvas', canvasId });
    if (args.name) controller.patch({ op: 'renameSave', name: String(args.name) });

    // ③ 交接值交叉核对：源码里出现的"高段数字"（真机 id 都在 1073741824 以上）与交接值对不对得上
    const handover = checkHandover(script.source, templates, bindArgs.containerId);

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

    const out = {
      bound: true,
      save: st.save && st.save.name,
      fresh,
      canvas: st.canvas ? { id: st.canvas.id, width: st.canvas.width, height: st.canvas.height, label: st.canvas.label } : null,
      templates: templateRows,
      templateCount: templateRows.length,
      source: script.meta,
      mount: { id: mount.id, name: mount.name, kind: mount.kind, assetType: SERVER },
      scripts: mounted,
      // 两个数分开说：treeCount = 服务端工程**编辑器树**的行数（含容器本身）；
      // editorControlCount = 去掉「客户端控件容器」那一行 —— "你的工程里摆了几个控件"
      treeCount: editorRows.length,
      editorControlCount: editorRows.filter((r) => r.kind !== 'server-container').length,
      handover,
      nextStep: '先看 `run.logs` 里有没有你脚本自己的 print（脚本跑没跑），再看 `run.controlCount`（控件建没建·建了几个）；'
        + '画面用 `op=shot target=play`（PNG 真落盘，用 read_image 看）。判定逻辑用 `op=verify`（可先 `op=cases action=add` 存成用例）。',
    };

    if (args.run !== false) {
      await controller.play('start', { canvasId: canvasId || undefined, playerCount: Number(args.playerCount) || 1, viewPlayerIndex: args.viewPlayerIndex });      /*
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
      out.run = {
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
      if (args.keepRunning !== true) await controller.play('stop', {}).catch(() => {});
      else out.run.keptRunning = true;
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
        source: script.meta.file || bindArgs.source || '',
        scriptName: script.path,
        sourceSha1_12: script.meta.sha1_12,
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

  throw new Error('未知 op：' + op + '（可用：state / patch / bind / play / verify / cases / controls / frames / shot / keys / export / import / load / save / reset）');
}
