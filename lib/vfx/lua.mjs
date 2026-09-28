// 移植自 xiaomoL444/ugc-tool（作者已授权，唯一要求保持开源）——
//   源文件：`src/views/UIVfxEditor/particleLuaRuntime.ts`（粒子运行时）
//           `src/views/UIVfxEditor/particleLuaExporter.ts`（导出形态 / 宿主回调）
//   本文件是**生成器**：把 `presets.mjs` 的预设数据 + 交接值装配成**一份可直接部署的客户端 Lua**。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★★ 驱动层（`Runtime` 块 + 宿主绑定块）**逐字取自真机定稿**：
//   工作区 `tmp/fx-demo/特效 fx.lua`（1426 行，关卡 1073741838 第一屏星雨，**真机已跑通**）。
//   为什么是"读出来"而不是"抄进来"：
//     · 那一份是**唯一**真机验证过的驱动层，抄一遍就是第二份副本；`tests/vfx-test.mjs` 的断言
//       `driverParity === true` 就是钉住这一点 —— 生成物里的驱动层必须与定稿件逐字一致。
//     · 只参数化三处：`VERSION` 行、预设名（日志标签）、`DATA`/`CONFIG` 两个数据块。
//   ⛔ 生成物**不许**出现：`pcall` 掩盖报错的兜底、静默 `return`、裸数字写死的 `CONFIG` 值。
//
// ★ 交接值（AI 拿不到、不许编）：`TEMPLATE_INDEX`（图片控件模板索引）、`CONTAINER_INDEX`（容器节点索引）、
//   `IMAGE_ID`（贴图资源号）、`PARENT_BY_NAME`（一个屏幕上看得见的控件名）。缺了就是 `error` 点名
//   （运行时）或 `ok:false + needsHandover[]`（工具层）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS, BUDGET, SCHEMA, simulatedImage } from './presets.mjs';
/** 真机定稿件（**只读参照物**，生成器只从中取驱动层，绝不改它）。 */
export const FX_FIXTURE_REL = 'tmp/fx-demo/特效 fx.lua';
/** 相对本文件的候选路径：① 插件包内（打包/独立测试）② 工作区根（`tmp/fx-demo/`）。 */
export const FX_FIXTURE_CANDIDATES = [
  '../../tmp/' + 'fx-demo/特效 fx.lua',
  '../../../../../' + FX_FIXTURE_REL,
];

/** 驱动层起点（运行时块的第一行注释）。 */
const RUNTIME_HEAD = '-- 粒子运行时 —— 逐字移植自 particleLuaRuntime.ts';
/** 宿主绑定起点（驱动层之后的第一段）。 */
const HOST_HEAD = '-- 宿主绑定（OnStart / OnUpdate / OnDisable / OnEnable / OnDestroy + 控制函数）';
/**
 * `requireHandover` 小段：定稿件里它**夹在 CONFIG 与 DATA 之间**（第 198~206 行），
 * 不在"运行时块 / 宿主绑定块"那两段里 ⇒ 生成器必须**单独把它搬过来**（否则产物里
 * `OnStart` 调它会 `attempt to call a nil value`，模拟器第一次跑就抓到了这个 bug）。
 */
const GUARD_HEAD = 'local function requireHandover';
const GUARD_TAIL = '-- ============================================================================';
/** 生成器对宿主绑定块**唯一**的一处替换（DURATION 是秒、可小数，而 requireHandover 只认正整数）。 */
const DURATION_GUARD_CALL = 'requireHandover("DURATION", CONFIG.DURATION)';
const DURATION_GUARD_NEW = 'requirePositiveNumber("DURATION", CONFIG.DURATION)';
/** 数据层起点（参数化时被替换掉的那一段）—— 仅供人/测试对照，不参与生成。 */
const DATA_HEAD = '-- 预设数据：第一屏星雨';
void DATA_HEAD;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位真机定稿件：**显式路径优先**（环境变量 / 入参），否则按候选相对路径找。
 * 找不到就返回 `null` —— 调用方（`vfxLua`）必须**明确报错**，不许静默换一份"差不多的"驱动层。
 * @param {string} [explicit]
 * @returns {string|null}
 */
export function findFxFixture(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.MILIASTRA_FX_FIXTURE) cands.push(process.env.MILIASTRA_FX_FIXTURE);
  for (const rel of FX_FIXTURE_CANDIDATES) cands.push(path.resolve(here, rel));
  // 再往上爬（最多 6 层）找 `tmp/fx-demo/特效 fx.lua` —— 工作区根离本文件的深度会随布局变
  let up = here;
  for (let i = 0; i < 6; i += 1) {
    up = path.dirname(up);
    cands.push(path.join(up, FX_FIXTURE_REL));
  }
  for (const p of cands) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* 读不动就当没有 */ }
  }
  return null;
}

/**
 * 从定稿件里切出**驱动层**（运行时块 + 宿主绑定块 + `requireHandover` 小段）。
 * @param {string} file 定稿件绝对路径
 * @returns {{runtime: string, host: string, guard: string, file: string, lines: number}}
 */
export function driverOf(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const iRuntime = text.indexOf(RUNTIME_HEAD);
  const iHost = text.indexOf(HOST_HEAD);
  const iGuard = text.indexOf(GUARD_HEAD);
  if (iRuntime < 0 || iHost < 0 || iHost <= iRuntime || iGuard < 0) {
    throw new Error('定稿件里找不到驱动层的三段标记（' + RUNTIME_HEAD.slice(0, 20) + '… / ' + HOST_HEAD.slice(0, 20)
      + '… / ' + GUARD_HEAD + '）：' + file + ' —— 生成器依赖它的**结构**，请先确认那份文件没被改过');
  }
  // `requireHandover` 段：到它后面那条分隔线为止（定稿件里 DATA 前有 `-- ===` 横幅）
  const iGuardEnd = text.indexOf(GUARD_TAIL, iGuard);
  const guard = iGuardEnd > iGuard ? text.slice(iGuard, iGuardEnd) : text.slice(iGuard, iRuntime);
  return {
    runtime: text.slice(iRuntime, iHost).replace(/\s+$/, ''),
    host: text.slice(iHost).replace(/\s+$/, ''),
    guard: guard.replace(/\s+$/, ''),
    file,
    lines: text.split('\n').length,
  };
}

/* ---------------------------------------------------------------- 值 → Lua 字面量 */

const num = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error('生成 Lua 时遇到非有限数字：' + JSON.stringify(n));
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
};
const bool = (b) => (b === true ? 'true' : 'false');
const str = (s) => JSON.stringify(String(s));
const rangeLit = (r) => '{ min = ' + num(r.min) + ', max = ' + num(r.max) + ' }';
const pointLit = (p) => '{ x = ' + num(p.x) + ', y = ' + num(p.y) + ' }';
const colorLit = (c) => '{ r = ' + num(c.r) + ', g = ' + num(c.g) + ', b = ' + num(c.b) + ', a = ' + num(c.a) + ' }';
const keysLit = (ks) => '{ ' + ks.map((k) => '{ t = ' + num(k.t) + ', value = ' + num(k.value) + ' }').join(', ') + ' }';

/**
 * 发射器的**属性字段清单**（顺序 = 网页编辑器右侧检查面板的分组顺序）。
 * `key` 是 CONFIG 里的名字（`A_` / `B_` 前缀 = 第几层），`emit` 负责把它写进 Lua。
 * ⚠️ 这张表是**唯一**的"字段 → 值"映射：CONFIG 块与 DATA 块都由它生成，
 *    所以不会出现"CONFIG 里有、DATA 里没接上"这种静默失效。
 */
const FIELDS = [
  // 01 发射
  { key: 'ORIGIN_X', pick: (e) => e.origin.x, emit: num },
  { key: 'ORIGIN_Y', pick: (e) => e.origin.y, emit: num },
  { key: 'DELAY', pick: (e) => e.delay, emit: num },
  { key: 'RATE', pick: (e) => e.rate, emit: num },
  { key: 'BURST', pick: (e) => e.burst, emit: num },
  { key: 'LIFETIME_MIN', pick: (e) => e.lifetime.min, emit: num },
  { key: 'LIFETIME_MAX', pick: (e) => e.lifetime.max, emit: num },
  // 02 出生形状
  { key: 'SHAPE', pick: (e) => e.shape, emit: str },
  { key: 'RADIUS', pick: (e) => e.radius, emit: num },
  { key: 'SPAWN_WIDTH', pick: (e) => e.width, emit: num },
  { key: 'SPAWN_HEIGHT', pick: (e) => e.height, emit: num },
  // 03 运动
  { key: 'MOTION', pick: (e) => e.motion, emit: str },
  { key: 'SPEED_MIN', pick: (e) => e.speed.min, emit: num },
  { key: 'SPEED_MAX', pick: (e) => e.speed.max, emit: num },
  { key: 'ANGLE', pick: (e) => e.angle, emit: num },
  { key: 'SPREAD', pick: (e) => e.spread, emit: num },
  { key: 'GRAVITY_X', pick: (e) => e.gravity.x, emit: num },
  { key: 'GRAVITY_Y', pick: (e) => e.gravity.y, emit: num },
  { key: 'CONTROL1_X', pick: (e) => e.control1.x, emit: num },
  { key: 'CONTROL1_Y', pick: (e) => e.control1.y, emit: num },
  { key: 'CONTROL2_X', pick: (e) => e.control2.x, emit: num },
  { key: 'CONTROL2_Y', pick: (e) => e.control2.y, emit: num },
  { key: 'TARGET_X', pick: (e) => e.target.x, emit: num },
  { key: 'TARGET_Y', pick: (e) => e.target.y, emit: num },
  // 04 尺寸与旋转
  { key: 'ROTATION_MIN', pick: (e) => e.rotation.min, emit: num },
  { key: 'ROTATION_MAX', pick: (e) => e.rotation.max, emit: num },
  { key: 'SPIN_MIN', pick: (e) => e.spin.min, emit: num },
  { key: 'SPIN_MAX', pick: (e) => e.spin.max, emit: num },
  { key: 'SIZE_MIN', pick: (e) => e.size.min, emit: num },
  { key: 'SIZE_MAX', pick: (e) => e.size.max, emit: num },
  { key: 'SIZE_CURVE', pick: (e) => e.sizeCurve, emit: keysLit },
  { key: 'ALPHA_CURVE', pick: (e) => e.alphaCurve, emit: keysLit },
  // 05 颜色
  { key: 'START_COLOR', pick: (e) => e.startColor, emit: colorLit },
  { key: 'END_COLOR', pick: (e) => e.endColor, emit: colorLit },
];

/** 每层发射器的键前缀（A = 第 1 层、B = 第 2 层…最多 H = 第 8 层；格式文档里也是这个叫法）。 */
const PREFIX = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
/** 面板分组标题（写进 CONFIG 的注释，便于与检查面板逐项对照）。 */
const GROUP_TITLE = {
  ORIGIN_X: '01 发射（出生点 / 节奏）',
  SHAPE: '02 出生形状',
  MOTION: '03 运动',
  ROTATION_MIN: '04 尺寸与旋转',
  START_COLOR: '05 颜色',
};

/**
 * 生成 `DATA` 块：**所有值都走 CONFIG.<前缀>_<字段>** ⇒ 顶部 CONFIG 是唯一取值单点。
 * 这正是"换效果只改 CONFIG 里几个数"的落地形态（格式文档 §1 的三层结构）。
 * @param {any} built
 */
export function dataBlock(built) {
  const L = [];
  L.push('local DATA = {');
  L.push('    ["schema"] = ' + str(SCHEMA) + ',');
  L.push('    ["name"] = ' + str(built.label) + ',');
  L.push('    ["width"] = ' + CONFIG_REF.WIDTH + ',');
  L.push('    ["height"] = ' + CONFIG_REF.HEIGHT + ',');
  L.push('    ["previewDuration"] = ' + CONFIG_REF.DURATION + ',');
  L.push('    ["emitters"] = {');
  built.emitters.forEach((e, i) => {
    const p = PREFIX[i] || ('E' + (i + 1));
    const c = (k) => 'CONFIG.' + p + '_' + k;
    L.push('        {');
    L.push('            ["id"] = ' + str(e.id) + ',');
    L.push('            ["name"] = ' + str(e.name) + ',');
    L.push('            ["enabled"] = ' + bool(e.enabled) + ',');
    L.push('            ["seed"] = ' + num(e.seed) + ',');
    L.push('            ["imageId"] = ' + CONFIG_REF.IMAGE_ID + ',');
    L.push('            ["origin"] = { ["x"] = ' + c('ORIGIN_X') + ', ["y"] = ' + c('ORIGIN_Y') + ' },');
    L.push('            ["delay"] = ' + c('DELAY') + ',');
    L.push('            ["duration"] = ' + CONFIG_REF.DURATION + ',');
    L.push('            ["loop"] = ' + c('LOOP') + ',');
    L.push('            ["maxParticles"] = ' + CONFIG_REF.PARTICLES_PER_EMITTER + ',');
    L.push('            ["rate"] = ' + c('RATE') + ',');
    L.push('            ["burst"] = ' + c('BURST') + ',');
    L.push('            ["lifetime"] = { ["min"] = ' + c('LIFETIME_MIN') + ', ["max"] = ' + c('LIFETIME_MAX') + ' },');
    L.push('            ["size"] = { ["min"] = ' + c('SIZE_MIN') + ', ["max"] = ' + c('SIZE_MAX') + ' },');
    L.push('            ["speed"] = { ["min"] = ' + c('SPEED_MIN') + ', ["max"] = ' + c('SPEED_MAX') + ' },');
    L.push('            ["angle"] = ' + c('ANGLE') + ',');
    L.push('            ["spread"] = ' + c('SPREAD') + ',');
    L.push('            ["rotation"] = { ["min"] = ' + c('ROTATION_MIN') + ', ["max"] = ' + c('ROTATION_MAX') + ' },');
    L.push('            ["spin"] = { ["min"] = ' + c('SPIN_MIN') + ', ["max"] = ' + c('SPIN_MAX') + ' },');
    L.push('            ["shape"] = ' + c('SHAPE') + ',');
    L.push('            ["radius"] = ' + c('RADIUS') + ',');
    L.push('            ["width"] = ' + c('SPAWN_WIDTH') + ',');
    L.push('            ["height"] = ' + c('SPAWN_HEIGHT') + ',');
    L.push('            ["motion"] = ' + c('MOTION') + ',');
    L.push('            ["gravity"] = { ["x"] = ' + c('GRAVITY_X') + ', ["y"] = ' + c('GRAVITY_Y') + ' },');
    L.push('            ["control1"] = { ["x"] = ' + c('CONTROL1_X') + ', ["y"] = ' + c('CONTROL1_Y') + ' },');
    L.push('            ["control2"] = { ["x"] = ' + c('CONTROL2_X') + ', ["y"] = ' + c('CONTROL2_Y') + ' },');
    L.push('            ["target"] = { ["x"] = ' + c('TARGET_X') + ', ["y"] = ' + c('TARGET_Y') + ' },');
    L.push('            ["sizeCurve"] = ' + c('SIZE_CURVE') + ',');
    L.push('            ["alphaCurve"] = ' + c('ALPHA_CURVE') + ',');
    L.push('            ["startColor"] = ' + c('START_COLOR') + ',');
    L.push('            ["endColor"] = ' + c('END_COLOR') + ',');
    L.push('        },');
  });
  L.push('    },');
  L.push('}');
  return L.join('\n');
}

/** `DATA`/`CONFIG` 之间的通用引用（写成常量便于测试断言"没有裸数字"）。 */
const CONFIG_REF = {
  WIDTH: 'CONFIG.WIDTH',
  HEIGHT: 'CONFIG.HEIGHT',
  DURATION: 'CONFIG.DURATION',
  IMAGE_ID: 'CONFIG.IMAGE_ID',
  PARTICLES_PER_EMITTER: 'CONFIG.PARTICLES_PER_EMITTER',
};

/**
 * @typedef {Object} BuildLuaOptions
 * @property {any} built `buildPreset()` 的产物
 * @property {number|null} templateIndex 交接值：图片控件模板索引
 * @property {number|null} container 交接值：容器节点索引
 * @property {string|null} parentName 交接值：借哪个可见控件的容器当父节点（`null` = 直接用 script.object）
 * @property {string} version 产物里的 `VERSION` 字符串（`ver=` 那行会打印它）
 * @property {number|null} [createAfterFrames] 晚建帧数（默认 30；≤0 = 关掉推迟）
 * @property {number|null} [diagSteadyAt] 稳态诊断时刻（秒）
 * @property {string|null} [fixture] 定稿件绝对路径（默认自动找）
 */

/** 产物的版本号（工具回执 / `.gia` 的 `ver=` 行都用它）。 */
export function versionOf(built) {
  return 'fx-' + built.name + '-' + new Date().toISOString().slice(0, 10);
}

/**
 * 预设 → **完整可部署 Lua**。
 * @param {BuildLuaOptions} o
 * @returns {{lua: string, lines: number, bytes: number, fixture: string, driverLines: number, dataLines: number,
 *            driverPatches: {from: string, to: string, why: string}[]}}
 */
export function buildFxLua(o) {
  const built = o.built;
  const fixture = findFxFixture(o.fixture || null);
  if (!fixture) {
    throw new Error('找不到真机定稿件（驱动层的唯一来源）：' + FX_FIXTURE_CANDIDATES.join(' 或 ')
      + '。它只读、不改；找不到就不能生成 —— 用 `MILIASTRA_FX_FIXTURE` 指个绝对路径也行。');
  }
  const drv = driverOf(fixture);
  const version = o.version || versionOf(built);
  const createAfterFrames = Number.isFinite(Number(o.createAfterFrames)) ? Math.round(Number(o.createAfterFrames)) : 30;
  const diagSteadyAt = Number.isFinite(Number(o.diagSteadyAt)) ? Number(o.diagSteadyAt) : 2;
  const parentName = o.parentName === undefined || o.parentName === null || String(o.parentName).trim() === ''
    ? null : String(o.parentName);

  const L = [];
  L.push('-- 特效 ' + built.name + '（' + built.label + '）—— 由 dsh-miliastra `miliastra_gen op=vfx-lua` 生成。');
  L.push('--');
  L.push('-- ★ 驱动层（下面 `Runtime` 块 + 宿主绑定块）**逐字取自真机定稿件**：');
  L.push('--   ' + fixture + '（关卡 1073741838 第一屏星雨，真机已跑通）');
  L.push('--   生成时只参数化了三处：`VERSION` 行、预设名（日志标签）、`CONFIG` / `DATA` 两个数据块。');
  L.push('--   断言 `driverParity`（tests/vfx-test.mjs）钉住这一点 —— 想改驱动层请改定稿件，不要在生成器里改。');
  L.push('--');
  L.push('-- ★ 移植出处：粒子运行时来自 xiaomoL444/ugc-tool（作者授权、保持开源）：');
  L.push('--   src/views/UIVfxEditor/particleLuaRuntime.ts（运行时）／particleModel.ts（预设数据形状）');
  L.push('--   ／particleLuaExporter.ts（导出形态）。四个预设的对照表见');
  L.push('--   docs/千星奇域_粒子特效配置格式.md §5.0。');
  L.push('--');
  L.push('-- ★ 这个预设：' + built.summary);
  L.push('--   ' + built.note);
  L.push('--');
  L.push('-- ★ 未验证（如实标，别当通行证）：真机渲染 / 官方素材是否认得 `IMAGE_ID` / 回调触发 / 设备帧率');
  L.push('--   （每层上限 ' + BUDGET.perEmitter + '、总计 ' + BUDGET.total + ' 是上游自述预算，**没有帧率证据**）。');
  L.push('--');
  L.push('-- 交接值（AI 不许编；缺一个运行时都会 error 点名）：');
  L.push('--   TEMPLATE_INDEX  ' + (o.templateIndex ? String(o.templateIndex) : '<待创作者给>') + '   图片控件模板索引（存为模板的那种独立控件）');
  L.push('--   CONTAINER_INDEX ' + (o.container ? String(o.container) : '<待创作者给>') + '   容器节点索引（声明 + 自检，比对 prefabIndex）');
  L.push('--   IMAGE_ID        ' + String(built.imageId) + '   贴图资源号（**真机可用平台全部 1543 个素材号**，id 空间 100001~112042；'
    + '`100001~100006` 只是**模拟器**画得出的几何号段 —— 那是模拟器的渲染限制，不是平台限制）');
  L.push('--   PARENT_BY_NAME  ' + (parentName === null ? 'nil（不借父容器，直接用 script.object）' : str(parentName)) + '   ★ 必须在"晚建之后"真实存在');
  L.push('');
  L.push('local VERSION = ' + str(version));
  L.push('');
  L.push('local CONFIG = {');
  L.push('    -- ★★ 交接值 ----');
  L.push('    -- 图片控件模板索引：由 `miliastra_map op=clientui` 从本关 .gil 读出，或创作者交接。**不许编**。');
  L.push('    TEMPLATE_INDEX = ' + (o.templateIndex ? num(o.templateIndex) : 'nil') + ',');
  L.push('    CONTAINER_INDEX = ' + (o.container ? num(o.container) : 'nil') + ',');
  L.push('    -- 粒子贴图资源号。**真机任意平台素材号都行**（用 `miliastra_asset op=catalog` 挑，id 空间 100001~112042）；');
  L.push('    -- 生成物里写的是**这一层要用的号**：给了 `previewImageId` 时就是它（**只为在模拟器里看得见图** —— 模拟器只画 100001~100006），');
  L.push('    -- 发布前把这一行换回真机素材号（生成物里就这一处）。');
  L.push('    IMAGE_ID = ' + num(built.emittedImageId !== null && built.emittedImageId !== undefined
    ? built.emittedImageId : built.imageId) + (built.previewImageId !== null && built.previewImageId !== built.imageId
    ? ',   -- 预览用号；真机用号 = ' + String(built.imageId) : ','));
  if (built.imageId === null) {
    L.push('    -- ⚠️ 这个预设的贴图号**由创作者指定**（目录里没有名称字段，我们不猜）—— 运行时缺它就会 error 点名。');
  }
  L.push('');
  L.push('    -- ★★ 节奏与开关 ----');
  L.push('    DURATION = ' + num(built.duration) + ',       -- 播多久（秒）');
  L.push('    LOOP = ' + bool(built.loop) + ',             -- true = 播完不停');
  L.push('    PARTICLES_PER_EMITTER = ' + num(built.particlesPerEmitter) + ',   -- 每层池子上限（≥ rate×lifetime.max，见文件头核算）');
  L.push('    SIZE_SCALE = ' + num(built.sizeScale) + ',       -- 粒子尺寸倍率（1 = 原生）');
  L.push('    CREATE_AFTER_FRAMES = ' + num(createAfterFrames) + ',   -- ★★ 晚建：>0 必开（见格式文档 §2.2；设 0 会被全屏背景盖住）');
  L.push('    PARENT_BY_NAME = ' + (parentName === null ? 'nil' : str(parentName)) + ',');
  L.push('    RAISE_TO_FRONT = true,');
  L.push('    RAISE_EVERY_FRAMES = 30, -- 播放期每 N 帧重提一次层级（对根容器无效，留着无害）');
  L.push('    HIDE_WHEN_DONE = true,   -- 播完隐藏全部粒子（不销毁）');
  L.push('    DIAG_STEADY_AT = ' + num(diagSteadyAt) + ',      -- 稳态诊断时刻（秒）；≤0 = 关掉');
  L.push('    IMAGE_ID_ALT = 100001,   -- 备用贴图号（A/B 验证用；默认不改行为）');
  L.push('    USE_ALT_IMAGE = false,');
  L.push('    FOLLOW_LEVEL_TIME = false, -- 与晚建不兼容（那个模式下帧计数不推进）');
  L.push('    WIDTH = ' + num(CANVAS.width) + ',');
  L.push('    HEIGHT = ' + num(CANVAS.height) + ',');
  built.emitters.forEach((e, i) => {
    const p = PREFIX[i] || ('E' + (i + 1));
    L.push('');
    L.push('    -- ★★ 第 ' + (i + 1) + ' 层「' + e.name + '」（面板分组顺序照网页编辑器右侧检查面板）----');
    for (const f of FIELDS) {
      if (GROUP_TITLE[f.key]) L.push('    -- ' + GROUP_TITLE[f.key]);
      L.push('    ' + p + '_' + f.key + ' = ' + f.emit(f.pick(e)) + ',');
    }
    L.push('    ' + p + '_LOOP = ' + bool(e.loop) + ',');
    const travelNote = travelComment(e);
    if (travelNote) L.push('    -- 落程核算：' + travelNote);
    if (e.motion === 'bezier') {
      L.push('    -- 贝塞尔（钢笔）：三个点都是**相对发射点**的偏移（不是画布绝对坐标）；');
      L.push('    --   发射点在容器中心 + (' + num(e.origin.x) + ', ' + num(e.origin.y) + ')，'
        + '终点落在画布绝对位置 (' + num(e.origin.x + e.target.x) + ', ' + num(e.origin.y + e.target.y) + ')（= 中心 + 偏移）。');
      L.push('    --   `t` 是**时间归一化**（t = age/life），**不是弧长匀速** ⇒ 控制点拉得越远那段走得越快。');
    }
  });
  L.push('}');
  L.push('');
  L.push('-- ============================================================================');
  L.push('-- 交接值校验（逐字取自定稿件：缺值/非正整数直接 error 点名，**不写假索引**）');
  L.push('-- ============================================================================');
  L.push(drv.guard);
  L.push('');
  /*
   * ★★ 生成器对驱动层**唯一**的一处补充（其余逐字不动）——
   *   定稿件的 `requireHandover` 是**交接值**校验器：它要求"正整数"（模板索引/容器号/池容量都是整数）。
   *   而 `DURATION` 是**秒**、可以是小数（上游 coins 就是 2.5）⇒ 拿它校验会报
   *   「CONFIG.DURATION 必须是正整数，收到 2.5」——模拟器端到端第一次跑就抓到了这个 bug。
   *   所以这里**只**把 DURATION 那一句换成下面这个"正数"校验器（名字仍叫 require*，语义仍然是不许编）。
   */
  L.push('-- 秒数（可小数）的正数校验 —— 见上面注释：定稿件的 requireHandover 只认正整数，而 DURATION 是秒。');
  L.push('local function requirePositiveNumber(name, value)');
  L.push('    if type(value) ~= "number" or value ~= value or value <= 0 then');
  L.push('        error("CONFIG." .. name .. " 必须是正数（秒），收到 " .. tostring(value), 0)');
  L.push('    end');
  L.push('    return value');
  L.push('end');
  L.push('');
  L.push('-- ============================================================================');
  L.push('-- 数据层：发射器数组（字段集 UGCTools.UIParticles@1；值全部走 CONFIG ⇒ 顶部是唯一取值单点）');
  L.push('-- ============================================================================');
  L.push(dataBlock(built));
  L.push('');
  L.push(drv.runtime);
  L.push('');
  // 宿主绑定块：只改日志标签（[特效fx → [特效:<预设名>）与**唯一**一处校验替换（见上面 requirePositiveNumber）
  const hostTagged = drv.host.replace(/\[特效fx/g, '[特效:' + built.name);
  const hostOut = hostTagged.replace(DURATION_GUARD_CALL, DURATION_GUARD_NEW);
  const patched = hostOut !== hostTagged;
  if (!patched) {
    throw new Error('驱动层里没有找到要替换的那一句 `' + DURATION_GUARD_CALL + '` —— 定稿件被改过？'
      + '生成器只替换这一句（把"正整数"校验换成"正数"校验，因为 DURATION 是秒、可以是小数），'
      + '替换不到就必须**报错**而不是硬塞一份产物。');
  }
  L.push(hostOut);
  const lua = L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return {
    lua,
    lines: lua.split('\n').length,
    bytes: Buffer.byteLength(lua, 'utf8'),
    fixture,
    driverLines: drv.lines,
    dataLines: dataBlock(built).split('\n').length,
    driverPatches: [{
      from: DURATION_GUARD_CALL,
      to: DURATION_GUARD_NEW,
      why: '定稿件的 requireHandover 只认**正整数**（它校验的是模板索引那类交接值），而 DURATION 是**秒**、'
        + '可以是小数（上游 coins = 2.5）⇒ 不换这一句就会「CONFIG.DURATION 必须是正整数，收到 2.5」',
    }],
  };
}

/** 给 CONFIG 里的字段配一句"落程/池子"的核算注释（属性表里也会出现同一份数字）。 */function travelComment(e) {
  const sz = simImageNote(e.imageId);
  const bits = [];
  if (e.motion === 'bezier') {
    const pts = [e.origin, e.control1, e.control2, e.target];
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    bits.push('贝塞尔折线长 ≈' + len.toFixed(0) + 'px');
  } else {
    const v = (e.speed.min + e.speed.max) / 2;
    const t = (e.lifetime.min + e.lifetime.max) / 2;
    const g = Math.abs(e.gravity.y);
    bits.push('落程 ≈ ' + v.toFixed(0) + '×' + t.toFixed(2) + ' + ½×' + g + '×' + t.toFixed(2) + '² ≈ '
      + (v * t + 0.5 * g * t * t).toFixed(0) + 'px');
  }
  bits.push('需要池 ≥ rate×lifetime.max = ' + e.rate + '×' + e.lifetime.max + ' = '
    + Math.ceil(e.rate * e.lifetime.max) + '（本层给 ' + e.maxParticles + '）');
  if (sz) bits.push(sz);
  return bits.join('；');
}

/** 贴图号在模拟器里的可渲染性（非基础形状号 ⇒ 模拟器画成缺图；回执 warnings 也用它）。 */
function simImageNote(imageId) {
  const info = simulatedImage({ emitters: [{ imageId }] });
  if (info.renderable) return null;
  return '⚠️ ' + imageId + ' 不是基础形状号 ⇒ 模拟器里画成缺图';
}
