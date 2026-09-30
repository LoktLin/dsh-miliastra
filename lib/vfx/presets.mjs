// 移植自 xiaomoL444/ugc-tool（作者已授权，唯一要求保持开源）——
//   源文件：`src/views/UIVfxEditor/particleModel.ts` 的 `createEmitter()` / `createPreset()`。
//   本文件是**数据 + 纯函数**层（零平台 API、零 I/O、零 Lua）：四个预设的字段集与
//   `UGCTools.UIParticles@1` 逐字一致，参数的可照抄版本见工作区文档
//   `docs/千星奇域_粒子特效配置格式.md` §5；驱动层（采样/发射/池子/回收）在 `lua.mjs`。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 四个预设与上游的对应关系（逐条，便于复核）：
//   · `star-scatter`（星光散射） ← 上游 `stars`（= 上游 `createEmitter()` 的默认值 + `burst`）
//   · `snow-fall`   （轻雪飘落） ← 上游 `snow`
//   · `coin-collect`（金币汇聚） ← 上游 `coins`（**贝塞尔运动 + 定点收集**）
//   · `star-rain`   （五角星雨） ← **本仓真机定稿**（关卡 1073741838 第一屏，已在真机跑通），
//                                  上游没有这个预设；参数见格式文档 §5.1。
//   上游画布是 960×540、本仓是按 1600×1000 重算的 ⇒ 凡坐标/尺寸/寿命按"从顶落到底"重算过的，
//   都在每个字段的注释里标了「上游 X → 本仓 Y（为什么）」，并汇总在格式文档 §5.0 的属性表里。

/** 数据版本（与上游 `PARTICLE_SCHEMA` / 运行时 `Runtime.Schema` 同一个字符串）。 */
export const SCHEMA = 'UGCTools.UIParticles@1';

/** 本关（真机实测）画布：x ∈ [−800, +800]、y ∈ [−500, +500]，y 向上为正。 */
export const CANVAS = { width: 1600, height: 1000 };

/** 平台预算（上游 README 第 48 行自述：每层 512 / 总计 1024；**没有帧率证据**）。 */
/*
 * ★ P1-7（2026-09-30 扩展规划）：这两个数是**上游 README 自述的工具预算**，**没有任何设备的帧率证据** ——
 *   以前回执里 `budget.note` 写"平台预算"、`unverified` 里又写"只是工具自述"，两种说法并存，
 *   读者（尤其 AI）会把它当**平台硬限**来设计。⇒ 显式带 `provenance`。
 */
export const BUDGET = { perEmitter: 512, total: 1024, provenance: 'upstream-tool-self-declared',
  provenanceNote: '上游工具自述的预算，不是平台硬限；没有任何设备的帧率证据。' };

/** 图片资源号 → 模拟器能不能画。模拟器只画得出 100001~100006 这六个几何号。 */
export const SIM_RENDERABLE_IMAGES = [100001, 100002, 100003, 100004, 100005, 100006];
export const IMAGE_MEANING = {
  100001: '方块', 100002: '圆', 100003: '三角', 100004: '四角星', 100005: '五角星', 100006: '圆环',
};

/** 13 个预设的合法值（工具 `op=vfx-lua` 的 `preset` 参数枚举，也是报错时的"合法值"清单）。 */
export const PRESET_NAMES = [
  'star-scatter', 'snow-fall', 'coin-collect', 'chest-collect', 'star-rain',
  'petal-fall', 'ember-rise', 'confetti-pop',
  'peacock-in', 'peacock-out',
  'firefly-drift', 'bubble-up', 'hit-spark',
];

const range = (min, max) => ({ min, max });
const point = (x, y) => ({ x, y });
const color = (r, g, b, a = 1) => ({ r, g, b, a });
const keys = (...pairs) => pairs.map(([t, value]) => ({ t, value }));
/*
 * 贝塞尔的两条"惰性值"：`motion="bezier"` 时 `speed` 与 `gravity` **不参与求值**
 * （`particleSimulation.ts:57` 只走 `bezierPoint`），但运行时 `validate()` 要求字段存在且在界内
 * （`speed ∈ [0,2000]`、`gravity.x/y ∈ [-5000,5000]`）⇒ 统一写 0 / 0.001，避免"看着像还能用"的假值。
 */
const BEZ_SPEED = range(0, 0.001);
const BEZ_GRAVITY = point(0, 0);

/**
 * 造一条贝塞尔发射器（**孔雀开屏**与"金币汇聚"共用这层结构）。
 * `motion="bezier"` 时 `speed`/`gravity` 不参与求值（见 `BEZ_*` 注释），但仍要写合法值。
 * 所有未显式给出的字段都从 `extra` 覆盖 —— 这样 8 层只有"点"不一样，其余全同源，便于复核。
 */
function bezierEmitter(o) {
  return Object.assign({
    enabled: true,
    seed: o.seed,
    imageId: o.imageId,
    origin: o.origin,
    delay: o.delay || 0,
    rate: o.rate,
    burst: 0,
    lifetime: o.lifetime,
    size: o.size,
    speed: BEZ_SPEED,
    angle: Math.round((Math.atan2(o.target.y, o.target.x) * 180) / Math.PI),
    spread: 10,
    rotation: range(0, 360),
    spin: range(-90, 90),
    shape: 'circle',
    radius: o.radius || 28,
    width: 220,
    height: 100,
    motion: 'bezier',
    gravity: BEZ_GRAVITY,
    control1: o.control1,
    control2: o.control2,
    target: o.target,
    sizeCurve: keys([0, 0.35], [0.2, 1], [1, 0.4]),
    alphaCurve: keys([0, 0], [0.12, 1], [0.82, 0.85], [1, 0]),
  }, {
    id: o.id, name: o.name,
    startColor: o.startColor, endColor: o.endColor,
  });
}

/**
 * 孔雀开屏的**八向点集**（右 / 右上 / 上 / 左上 / 左 / 左下 / 下 / 右下）。
 * `inward=true` ⇒ 起点在屏边、终点在中心（收拢）；`false` ⇒ 反过来（展开）。
 * 贝塞尔是"相对发射点"的偏移 ⇒ **两种模式的 P1/P2 数值一模一样**，只有 origin/target 换边 —— 便于对照。
 */
const PEACOCK_DIRS = [
  { tag: 'R', deg: 0, start: { x: 770, y: 0 } },
  { tag: 'RU', deg: 45, start: { x: 555, y: 335 } },
  { tag: 'U', deg: 90, start: { x: 0, y: 470 } },
  { tag: 'LU', deg: 135, start: { x: -555, y: 335 } },
  { tag: 'L', deg: 180, start: { x: -770, y: 0 } },
  { tag: 'LD', deg: 225, start: { x: -555, y: -335 } },
  { tag: 'D', deg: 270, start: { x: 0, y: -470 } },
  { tag: 'RD', deg: 315, start: { x: 555, y: -335 } },
];
const PEACOCK_COLORS = [
  [[255, 230, 190], [255, 170, 90]],
  [[190, 255, 230], [60, 220, 190]],
  [[200, 225, 255], [70, 150, 255]],
  [[225, 200, 255], [140, 90, 240]],
  [[255, 200, 225], [240, 90, 160]],
  [[255, 245, 190], [250, 200, 40]],
  [[190, 245, 255], [40, 190, 230]],
  [[215, 255, 200], [90, 210, 80]],
];
const PEACOCK_COMMON = {
  rate: 12,
  lifetime: range(1.4, 1.9),
  size: range(9, 18),
  radius: 28,
  control1: { x: -180, y: 200 },
  control2: { x: 120, y: 240 },
};

/** 生成 8 条孔雀发射器（`inward` = 收拢 / 展开）。 */
function peacockRing(inward) {
  const center = point(0, 0);
  return PEACOCK_DIRS.map((d, i) => {
    const c = PEACOCK_COLORS[i];
    const colorA = color(c[0][0], c[0][1], c[0][2]);
    const colorB = color(c[1][0], c[1][1], c[1][2]);
    const seed = 880000 + (inward ? 100 : 200) + i * 7;
    const id = 'emitter_peacock_' + (inward ? 'in' : 'out') + '_' + d.tag.toLowerCase();
    const name = '孔雀' + (inward ? '收' : '展') + '·' + d.tag;
    if (inward) {
      return bezierEmitter(Object.assign({}, PEACOCK_COMMON, {
        id, name, seed, origin: d.start, target: center,
        startColor: colorA, endColor: colorB,
      }));
    }
    return bezierEmitter(Object.assign({}, PEACOCK_COMMON, {
      id, name, seed, origin: center, target: d.start,
      startColor: colorB, endColor: colorA,
    }));
  });
}

/** `true` = 收拢（往中心）／`false` = 展开（往八向）。 */
function PEACOCK_RING(inward) {
  return peacockRing(inward);
}

/*
 * 两个共用的"标准形"——不是为了省字，而是为了让**四个预设的差异一眼看得出**：
 *   · FLARE：出生淡入 → 中段稳定 → 结束淡出（尺寸同时收一下）。上游 `createEmitter()` 的原值。
 *   · SPARK：出生即亮、结束归零（雪/金币那种"一直在飘"的用）。
 */
const FLARE_SIZE = keys([0, 0.35], [0.15, 1], [1, 0.15]);
const FLARE_ALPHA = keys([0, 0], [0.1, 1], [0.7, 0.9], [1, 0]);

/**
 * 每个预设给两层发射器（上游只给一层 —— 这是**刻意的差异①**：两层错开 ⇒ 密度更匀、
 * 更像自然现象；`delay` 错开 0.25 秒就够，见格式文档 §5）。
 *
 * 字段名与 `ParticleEmitter` 逐字一致（少一个字段运行时 `validate()` 就会报"越界数值"）。
 */
export const PRESETS = [
  {
    name: 'star-scatter',
    label: '星光散射',
    upstream: 'stars',
    summary: '爆发 + 旋转 + 重力：从容器中心向四周炸开（快、短、亮）',
    imageId: 100005,          // 五角星：上游 stars 让创作者自己挑图，本仓给五角星（视觉上最像"星光"）
    duration: 2,
    loop: true,               // 上游 stars：loop=true、duration=2 ⇒ 每 2 秒炸一次
    particlesPerEmitter: 100, // 上游 maxParticles=100
    sizeScale: 1,
    note: '上游 stars 是"每 2 秒一次爆发"的循环效果（`loop:true`）；`burst:16` 在循环下'
      + '每周期起点给一团 —— 所以这一层的观感是"一波一波炸"，不是连续流。',
    emitters: [
      {
        id: 'emitter_star_scatter_a', name: '星光 A', seed: 12345,
        origin: point(0, 0), delay: 0,          // 上游 origin (0,0) = 容器中心
        rate: 28, burst: 16,
        lifetime: range(0.8, 1.6), size: range(8, 20), speed: range(60, 170),
        angle: 90, spread: 360,                  // 90° = 向上；360° 散角 = 向四周
        rotation: range(0, 360), spin: range(-90, 90),
        shape: 'circle', radius: 12, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -35),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: FLARE_SIZE, alphaCurve: FLARE_ALPHA,
        startColor: color(255, 239, 183), endColor: color(255, 146, 73),
      },
      {
        id: 'emitter_star_scatter_b', name: '星光 B', seed: 987654,
        origin: point(0, 0), delay: 0.25,
        rate: 20, burst: 16,
        lifetime: range(0.8, 1.6), size: range(8, 20), speed: range(60, 170),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-90, 90),
        shape: 'circle', radius: 12, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -35),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: FLARE_SIZE, alphaCurve: FLARE_ALPHA,
        startColor: color(214, 244, 255), endColor: color(96, 190, 255),
      },
    ],
  },

  {
    name: 'snow-fall',
    label: '轻雪飘落',
    upstream: 'snow',
    summary: '矩形区域 + 持续发射：慢速下落、横风大、几乎不自转',
    imageId: 100002,          // 圆 → 当雪花用（上游 snow 也是让创作者挑图）
    duration: 6,              // 上游 snow：duration 6、previewDuration 12
    loop: true,
    particlesPerEmitter: 150, // ★ 刻意改：上游 140（单层算法 18×7=126 够）。
                              //   本仓把 lifetime 收短到 ≤5.2 秒（理由见 note）⇒ 需要 18×5.0=90 / 20×5.2=104，
                              //   取 150 有 ~44% 余量；两层合计 300 控件（= 总预算 1024 的 29.3%）。
    sizeScale: 1,
    note: '上游 snow 的 `origin.y=230` 在 960×540 画布里刚好在顶边内侧；本仓按 y≈+470（顶边）重算。'
      + '上游每一层只有一条发射器，本仓给了 A/B 两条（错开 0.25 秒 + 微调速度/散角），'
      + '观感上"雪片不会挤在同一条线上掉下来"。'
      + '★ 另一处刻意改：`lifetime` 从上游 (5,7) 收到 (3.5,5.0)/(3.6,5.2) —— 7 秒会让雪花'
      + '**落到屏幕底边之后还"活着"**（顶到底约 6.8 秒）⇒ 后半段白烧控件；收短后"到底边附近正好淡出"。',
    emitters: [
      {
        id: 'emitter_snow_fall_a', name: '雪花 A', seed: 20260930,
        // 上游 origin (0, 230) → 本仓 (0, 470)：画布顶边（y=+500 是顶）；出生带高 15 ⇒ 462.5~477.5 全在屏内
        origin: point(0, 470), delay: 0,
        rate: 18, burst: 0,      // 上游 burst 0：只走 rate（连续流）
        // 上游 lifetime (5,7)：本仓收到 (3.5,5.0) —— 7 秒会让雪花在落到屏幕底边（y=+470 → −470 约
        // 6.8 秒）**之前就飞出画面**，浪费一半寿命；收短后"飘到底边附近正好淡出"。
        lifetime: range(3.5, 5.0), size: range(4, 11), speed: range(30, 60),
        angle: -90, spread: 30,  // 上游 -90°（Lua 里 270° 等价：向下）
        rotation: range(0, 360), spin: range(-30, 30),
        shape: 'box',
        // 上游 width 760（画布 960 宽 ⇒ 79%）→ 本仓 1560（画布 1600 宽 ⇒ 97.5%）
        radius: 12, width: 1560, height: 15,
        motion: 'velocity', gravity: point(2, -4),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.7], [0.2, 1], [1, 0.7]),
        alphaCurve: keys([0, 0], [0.12, 0.9], [0.8, 0.7], [1, 0]),
        // 上游 startColor a=.9 / endColor a=.4（雪越飘越淡）
        startColor: color(225, 241, 255, 0.9), endColor: color(179, 210, 255, 0.4),
      },
      {
        id: 'emitter_snow_fall_b', name: '雪花 B', seed: 314159,
        origin: point(0, 455), delay: 0.25,
        rate: 20, burst: 0,
        lifetime: range(3.6, 5.2), size: range(3, 9), speed: range(26, 52),
        angle: -92, spread: 38,
        rotation: range(0, 360), spin: range(-24, 24),
        shape: 'box', radius: 12, width: 1500, height: 15,
        motion: 'velocity', gravity: point(-2, -3),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.7], [0.2, 1], [1, 0.7]),
        alphaCurve: keys([0, 0], [0.12, 0.85], [0.8, 0.65], [1, 0]),
        startColor: color(225, 241, 255, 0.85), endColor: color(179, 210, 255, 0.35),
      },
    ],
  },

  {
    name: 'coin-collect',
    label: '金币汇聚',
    upstream: 'coins',
    summary: '贝塞尔运动 + 定点收集：从容器中心左侧出发，掠过上方，收到右上角"终点"',
    imageId: 100002,          // 圆 → 当金币用（上游 coins 没指定图）
    duration: 2.5,            // 上游 coins：duration 2.5
    loop: true,
    particlesPerEmitter: 60,  // 上游 maxParticles 100；本仓 60 ≥ rate×lifetime.max = 12×1.8 = 22 ⇒ 够
    sizeScale: 1,
    note: '上游 coins 的 `motion="bezier"` 用的是**绝对坐标**（引擎里 x/y 是"相对原点的偏移"）⇒'
      + '要在容器中心附近收集，"终点"必须写成接近 (0,0) 的位置。本仓把它改成'
      + '**相对容器中心**：(−180,−80) 起、P1(−100,230) 掠过上方、P2(300,−80)、终点 (430,210)，'
      + '并把"从哪来"的那一端也搬到左半屏 —— 上游的 target (430,210) 在 1600×1000 画布上等于'
      + '"右上四分之一处"，正好可以当"收集点"。',
    emitters: [
      {
        id: 'emitter_coin_collect_a', name: '金币 A', seed: 246810,
        // 上游 origin (-180, -80) —— 原样保留（左下方起手）
        origin: point(-180, -80), delay: 0,
        rate: 12, burst: 10,     // 上游 burst 10：每个周期起点先洒一把
        lifetime: range(1.0, 1.8), size: range(12, 22), speed: range(0, 0),
        angle: 0, spread: 0,     // bezier 不用 angle/spread，但 validate() 要求字段存在
        rotation: range(0, 360), spin: range(-180, 180),
        shape: 'circle', radius: 60, width: 220, height: 100,
        motion: 'bezier',
        gravity: point(0, 0),    // bezier 不算 gravity（字段必须在，值给 0）
        control1: point(-100, 230), control2: point(300, -80), target: point(430, 210),
        sizeCurve: keys([0, 0.3], [0.2, 1], [0.8, 0.7], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.15, 1], [0.85, 0.9], [1, 0]),
        startColor: color(255, 224, 100), endColor: color(255, 249, 216),
      },
      {
        id: 'emitter_coin_collect_b', name: '金币 B', seed: 135791,
        origin: point(-150, -120), delay: 0.2,
        rate: 9, burst: 10,
        lifetime: range(1.1, 1.9), size: range(10, 18), speed: range(0, 0),
        angle: 0, spread: 0,
        rotation: range(0, 360), spin: range(-180, 180),
        shape: 'circle', radius: 45, width: 220, height: 100,
        motion: 'bezier',
        gravity: point(0, 0),
        control1: point(-60, 200), control2: point(330, -60), target: point(430, 210),
        sizeCurve: keys([0, 0.3], [0.2, 1], [0.8, 0.7], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.15, 1], [0.85, 0.9], [1, 0]),
        startColor: color(255, 236, 140), endColor: color(255, 249, 216),
      },
    ],
  },

  {
    /*
     * ★ `chest-collect`（宝箱汇聚）——作者 2026-09-30 点名："图是独立维度"。
     *   参数**完全复用** `coin-collect`（同一套贝塞尔汇聚），只换默认贴图。
     *   ⚠️ **宝箱图号由创作者指定，我们不猜**：`op=catalog` 的目录里**单张图没有名字字段**
     *      （全量核对过：只有 14 个分类名），所以"哪个号是宝箱"没有任何依据可推。
     *      ⇒ 这里 `imageId: null` + `imageIdFromCreator: true`；调用时必须显式传 `imageId`，
     *        否则回 `needsImageId`（**不随便挑一个号冒充**）。
     */
    name: 'chest-collect',
    label: '宝箱汇聚',
    upstream: null,
    summary: '★同一套贝塞尔汇聚，换**宝箱图标**就是"宝箱汇聚" —— 预设管"怎么动"、图片管"是什么"',
    imageId: null,
    imageIdFromCreator: true,
    duration: 2.5,
    loop: true,
    particlesPerEmitter: 60,
    sizeScale: 1,
    note: '与 `coin-collect` **同一组运动参数**（贝塞尔汇聚到右上"终点"），唯一差别是默认贴图 = 宝箱图标。'
      + '⚠️ **宝箱图号由创作者给**（我们的素材目录里没有名称字段，不猜）⇒ 不传 `imageId` 时本工具会'
      + '`ok:false + needsImageId`；传上号之后它就与金币汇聚一样能跑。'
      + '预览请另传 `previewImageId`（模拟器只画 100001~100006）。',
    emitters: [
      {
        id: 'emitter_chest_collect_a', name: '宝箱 A', seed: 246810,
        origin: point(-180, -80), delay: 0,
        rate: 12, burst: 10,
        lifetime: range(1.0, 1.8), size: range(12, 22), speed: range(0, 0),
        angle: 0, spread: 0,
        rotation: range(0, 360), spin: range(-180, 180),
        shape: 'circle', radius: 60, width: 220, height: 100,
        motion: 'bezier',
        gravity: point(0, 0),
        control1: point(-100, 230), control2: point(300, -80), target: point(430, 210),
        sizeCurve: keys([0, 0.3], [0.2, 1], [0.8, 0.7], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.15, 1], [0.85, 0.9], [1, 0]),
        startColor: color(255, 224, 100), endColor: color(255, 249, 216),
      },
      {
        id: 'emitter_chest_collect_b', name: '宝箱 B', seed: 135791,
        origin: point(-150, -120), delay: 0.2,
        rate: 9, burst: 10,
        lifetime: range(1.1, 1.9), size: range(10, 18), speed: range(0, 0),
        angle: 0, spread: 0,
        rotation: range(0, 360), spin: range(-180, 180),
        shape: 'circle', radius: 45, width: 220, height: 100,
        motion: 'bezier',
        gravity: point(0, 0),
        control1: point(-60, 200), control2: point(330, -60), target: point(430, 210),
        sizeCurve: keys([0, 0.3], [0.2, 1], [0.8, 0.7], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.15, 1], [0.85, 0.9], [1, 0]),
        startColor: color(255, 236, 140), endColor: color(255, 249, 216),
      },
    ],
  },

  {
    name: 'star-rain',
    label: '五角星雨',
    upstream: null,           // ★ 本仓真机定稿（上游没有）
    summary: '两层顶部窄带 + 斜落：从屏幕顶边落到屏幕底边才淡出（真机跑通那一版）',
    imageId: 100005,          // 五角星（作者 2026-09-28 定参：只用五角星，不混撒）
    duration: 10,             // 作者 2026-09-28 定参：进关播 10 秒
    loop: false,              // 播完停在最后一帧（HIDE_WHEN_DONE 会隐藏）
    particlesPerEmitter: 84,  // 寿命拉到 ~3 秒后并存数 ≈ rate×lifetime ≈ 64（A）/ 54（B）⇒ 84 够
    sizeScale: 1,             // 作者 2026-09-29 定稿：原生尺寸（4× 只是排查用的诊断值，已收回）
    note: '真机定稿（关卡 1073741838 第一屏，`.gia` 有完整证据）。与上游 stars 无关：'
      + '上游是"中心炸开"，这一版是"顶部窄带斜落"，两者只共用字段集与运行时。'
      + '坐标/寿命/速度按 1600×1000 与"从顶落到底（≥1000px）"重算过。'
      + '★ 相对真机定稿件有一处**坐标收敛**：A 层出生带 y=470/高 80 ⇒ 越过顶边 10px'
      + '（画布顶是 +500，容器会裁掉那一条），本仓收成 y=455/高 60（425~485，全在屏内），'
      + 'B 层同步收到 440/高 60；速度、寿命、重力、颜色**一个数没动**。',
    emitters: [
      {
        id: 'emitter_starrain_five_a', name: '五角星雨 A', seed: 20260928,
        origin: point(0, 455), delay: 0,
        rate: 20, burst: 0,      // burst 0：只走 rate（连续雨幕）
        lifetime: range(2.6, 3.2), size: range(10, 26), speed: range(240, 330),
        angle: 270, spread: 40,  // 270° = 正向下；40° 散角 = 被风吹斜的雨
        rotation: range(0, 360), spin: range(-70, 70),
        shape: 'box', radius: 12, width: 1480, height: 60,
        motion: 'velocity', gravity: point(20, -90),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.30], [0.18, 1], [1, 0.20]),
        alphaCurve: keys([0, 0], [0.12, 1], [0.65, 0.85], [1, 0]),
        startColor: color(255, 244, 200), endColor: color(255, 158, 74),
      },
      {
        id: 'emitter_starrain_five_b', name: '五角星雨 B', seed: 987654,
        origin: point(0, 440), delay: 0.25,
        rate: 16, burst: 0,
        lifetime: range(2.6, 3.4), size: range(8, 22), speed: range(200, 300),
        angle: 264, spread: 34,
        rotation: range(0, 360), spin: range(50, 110),
        shape: 'box', radius: 12, width: 1400, height: 60,
        motion: 'velocity', gravity: point(-14, -80),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.35], [0.2, 1], [1, 0.25]),
        alphaCurve: keys([0, 0], [0.1, 0.95], [0.7, 0.8], [1, 0]),
        startColor: color(214, 244, 255), endColor: color(96, 190, 255),
      },
    ],
  },

  /*
   * ── 下面这些是**本仓新做**的预设（上游没有）────────────────────────────────────
   * 共同点：字段集与上游完全一致 ⇒ **引擎一行都没改**（用户 2026-09-30 明确要求"全部作为数据放进 presets.mjs"）。
   * 每个都给了"关键手法"注释；完整属性表与"适合什么场景"见格式文档 §5.0 / §5.0b。
   */
  {
    name: 'petal-fall',
    label: '花瓣飘落',
    upstream: null,
    summary: '左右摆动下落、自转慢：两层横风**反号**（A 偏左 / B 偏右）⇒ 一层层打着旋飘下来',
    imageId: 100002,
    duration: 10,
    loop: true,
    particlesPerEmitter: 105,
    sizeScale: 1,
    note: '与 snow-fall 的差别只在"横风方向"与"自转"：两层 gravity.x **正负相反**（+26 / −26），'
      + '再吃掉一层 speed 上的差异 ⇒ 雪是"齐刷刷往下"，花瓣是"左一层右一层打旋"。',
    emitters: [
      {
        id: 'emitter_petal_fall_a', name: '花瓣 A', seed: 777001,
        origin: point(0, 460), delay: 0,
        rate: 16, burst: 0,
        lifetime: range(4.5, 6.0), size: range(8, 16), speed: range(60, 100),
        angle: 266, spread: 52,
        rotation: range(0, 360), spin: range(-90, 40),
        shape: 'box', radius: 12, width: 1540, height: 40,
        motion: 'velocity', gravity: point(26, -46),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.2, 1], [1, 0.6]),
        alphaCurve: keys([0, 0], [0.15, 0.95], [0.85, 0.85], [1, 0]),
        startColor: color(255, 214, 232), endColor: color(238, 150, 190),
      },
      {
        id: 'emitter_petal_fall_b', name: '花瓣 B', seed: 777002,
        origin: point(0, 445), delay: 0.3,
        rate: 13, burst: 0,
        lifetime: range(5.0, 6.5), size: range(6, 13), speed: range(50, 88),
        angle: 274, spread: 58,
        rotation: range(0, 360), spin: range(-40, 90),
        shape: 'box', radius: 12, width: 1480, height: 40,
        motion: 'velocity', gravity: point(-26, -40),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.2, 1], [1, 0.6]),
        alphaCurve: keys([0, 0], [0.15, 0.9], [0.85, 0.8], [1, 0]),
        startColor: color(255, 236, 244), endColor: color(232, 176, 255),
      },
    ],
  },

  {
    name: 'ember-rise',
    label: '火星上升',
    upstream: null,
    summary: '★反向：从屏幕底边往上升、边升边淡；`gravity.y` **为正**（向上加速）—— 与 snown/rain 的符号相反',
    imageId: 100002,
    duration: 8,
    loop: true,
    particlesPerEmitter: 100,
    sizeScale: 1,
    note: '下落类预设的"符号翻转版"：`origin.y=−465`（底边）、`angle=90`（正向上）、'
      + '`gravity.y=+34 / +28`（**正 = 向上加速**，引擎 y 向上为正）；`alphaCurve` 尾部归零 ⇒ 升到一半就熄。'
      + '落程核算与下落类同一个式子（这里"落程"= 上升高度）。',
    emitters: [
      {
        id: 'emitter_ember_rise_a', name: '火星 A', seed: 555001,
        origin: point(0, -465), delay: 0,
        rate: 20, burst: 0,
        lifetime: range(2.4, 3.2), size: range(5, 13), speed: range(70, 130),
        angle: 90, spread: 46,
        rotation: range(0, 360), spin: range(-40, 40),
        shape: 'box', radius: 12, width: 1500, height: 40,
        motion: 'velocity', gravity: point(8, 34),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.2, 1], [1, 0.35]),
        alphaCurve: keys([0, 0], [0.12, 1], [0.6, 0.85], [1, 0]),
        startColor: color(255, 236, 168), endColor: color(255, 96, 40),
      },
      {
        id: 'emitter_ember_rise_b', name: '火星 B', seed: 555002,
        origin: point(0, -450), delay: 0.25,
        rate: 16, burst: 0,
        lifetime: range(2.0, 2.8), size: range(4, 10), speed: range(60, 110),
        angle: 84, spread: 54,
        rotation: range(0, 360), spin: range(-30, 30),
        shape: 'box', radius: 12, width: 1420, height: 40,
        motion: 'velocity', gravity: point(-6, 28),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.2, 1], [1, 0.35]),
        alphaCurve: keys([0, 0], [0.12, 0.95], [0.55, 0.8], [1, 0]),
        startColor: color(255, 214, 140), endColor: color(220, 60, 30),
      },
    ],
  },

  {
    name: 'confetti-pop',
    label: '彩纸礼花',
    upstream: null,
    summary: '短促爆开、强自转、多彩：三层不同颜色 + 大散角 + `spin` ±520 ⇒ 炸一下、翻着飞、很快落地',
    imageId: 100001,
    duration: 2,
    loop: true,
    particlesPerEmitter: 36,
    sizeScale: 1,
    note: '与 star-scatter 同一族（爆发 + 重力），差别在"三层不同颜色 + 自转极大 + 尺寸更小"：'
      + '`burst` 给每周期一团，`rate` 很低（4）⇒ 是"礼花"不是"喷泉"；三层颜色分别是青 / 洋红 / 金。',
    emitters: [
      {
        id: 'emitter_confetti_pop_a', name: '彩纸 A（青）', seed: 661001,
        origin: point(0, 0), delay: 0,
        rate: 4, burst: 22,
        lifetime: range(1.2, 1.8), size: range(7, 13), speed: range(150, 260),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-520, 520),
        shape: 'circle', radius: 18, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -180),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.4], [0.15, 1], [1, 0.35]),
        alphaCurve: keys([0, 0], [0.08, 1], [0.7, 0.9], [1, 0]),
        startColor: color(120, 240, 255), endColor: color(40, 140, 255),
      },
      {
        id: 'emitter_confetti_pop_b', name: '彩纸 B（洋红）', seed: 661002,
        origin: point(0, 0), delay: 0.08,
        rate: 4, burst: 20,
        lifetime: range(1.1, 1.7), size: range(6, 12), speed: range(160, 280),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-520, 520),
        shape: 'circle', radius: 18, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -170),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.4], [0.15, 1], [1, 0.35]),
        alphaCurve: keys([0, 0], [0.08, 1], [0.7, 0.9], [1, 0]),
        startColor: color(255, 150, 230), endColor: color(200, 60, 220),
      },
      {
        id: 'emitter_confetti_pop_c', name: '彩纸 C（金）', seed: 661003,
        origin: point(0, 0), delay: 0.16,
        rate: 4, burst: 18,
        lifetime: range(1.0, 1.6), size: range(6, 11), speed: range(140, 250),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-480, 480),
        shape: 'circle', radius: 18, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -160),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.4], [0.15, 1], [1, 0.35]),
        alphaCurve: keys([0, 0], [0.08, 1], [0.7, 0.9], [1, 0]),
        startColor: color(255, 240, 170), endColor: color(255, 170, 60),
      },
    ],
  },

  /*
   * ★★ 孔雀开屏（作者点名的重点）：**用满 8 个发射器** —— 这正是 `DATA.emitters` 支持 1~8 层的原因。
   *   八个方向：右 / 右上 / 上 / 左上 / 左 / 左下 / 下 / 右下（0°=右、90°=上、180°=左、270°=下）。
   *   `peacock-in`  = 八条边各自**往中心收拢**（target 都是 {0,0}）；`peacock-out` = 从中心**往八个方向展开**。
   *   池子：每层 28 ⇒ 合计 224 控件（= 总预算 1024 的 21.9%；自设的"≤400"上限也用得上）。
   */
  {
    name: 'peacock-in',
    label: '孔雀开屏·收拢',
    upstream: null,
    summary: '★八个方向同时往中心汇聚：8 层发射器各从一条边/一个角出发，`target` 全是 {0,0} ⇒ 像羽毛收拢',
    imageId: 100005,
    duration: 4,
    loop: true,
    particlesPerEmitter: 28,
    sizeScale: 1,
    note: '8 层都走贝塞尔：`origin` 在屏边（8 个方向各一个），`target={0,0}`（容器中心），'
      + 'P1/P2 沿路铺开（不向起点回折，避免路径自交）。粒子池每层 28 ⇒ **合计 224 个控件**。'
      + '起点坐标都在屏内（±800 / ±500），出生区不会超框。',
    emitters: PEACOCK_RING(true),
  },

  {
    name: 'peacock-out',
    label: '孔雀开屏·展开',
    upstream: null,
    summary: '★从中心往八个方向散开：8 层同起点 {0,0}，各自 `target` 落在一条边/一个角 ⇒ 扇形展开',
    imageId: 100005,
    duration: 3,
    loop: true,
    particlesPerEmitter: 28,
    sizeScale: 1,
    note: '与 `peacock-in` **同一组点、方向相反**：`origin={0,0}`、`target` 在屏边，'
      + 'P1/P2 由内向外交替铺开 ⇒ 从中心"刷"地铺满一圈。粒子池每层 28 ⇒ **合计 224 个控件**。',
    emitters: PEACOCK_RING(false),
  },

  {
    name: 'firefly-drift',
    label: '萤火虫漂浮',
    upstream: null,
    summary: '小、慢、忽明忽暗：`alphaCurve` **多次起伏**（3 次暗—亮—暗，可复现，不用随机）',
    imageId: 100002,
    duration: 12,
    loop: true,
    particlesPerEmitter: 60,
    sizeScale: 1,
    note: '与 snow 同族的"环境漂浮"，差别在 `alphaCurve` 是**多次起伏**（t=0→0、0.12→1、0.3→0.15、'
      + '0.45→1、0.6→0.2、0.75→0.95、0.88→0.25、1→0）—— 曲线是确定性的、可复现（**没有用随机**）；'
      + '`speed` 很小（16~44）⇒ 几乎在原地飘。',
    emitters: [
      {
        id: 'emitter_firefly_drift_a', name: '萤火 A', seed: 888001,
        origin: point(0, 0), delay: 0,
        rate: 10, burst: 0,
        lifetime: range(3.5, 5.5), size: range(3, 7), speed: range(16, 44),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-20, 20),
        shape: 'circle', radius: 420, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, 4),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.6], [0.25, 1], [1, 0.6]),
        alphaCurve: keys([0, 0], [0.12, 1], [0.3, 0.15], [0.45, 1], [0.6, 0.2], [0.75, 0.95], [0.88, 0.25], [1, 0]),
        startColor: color(214, 255, 170), endColor: color(255, 232, 120),
      },
      {
        id: 'emitter_firefly_drift_b', name: '萤火 B', seed: 888002,
        origin: point(0, 0), delay: 0.4,
        rate: 8, burst: 0,
        lifetime: range(3.0, 5.0), size: range(2, 6), speed: range(14, 38),
        angle: 90, spread: 360,
        rotation: range(0, 360), spin: range(-16, 16),
        shape: 'circle', radius: 380, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -3),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.6], [0.25, 1], [1, 0.6]),
        alphaCurve: keys([0, 0], [0.15, 0.9], [0.35, 0.2], [0.5, 0.85], [0.68, 0.18], [0.85, 0.8], [1, 0]),
        startColor: color(190, 240, 255), endColor: color(150, 255, 210),
      },
    ],
  },

  {
    name: 'bubble-up',
    label: '气泡上浮',
    upstream: null,
    summary: '从底部缓慢上升、轻摆：`angle=90` + 两层 `gravity.x` **交变**（一左一右）',
    imageId: 100006,
    duration: 10,
    loop: true,
    particlesPerEmitter: 80,
    sizeScale: 1,
    note: '与 ember-rise 同一族（上升），差别在"慢 + 大 + 轻摆 + 不熄"：`speed` 只 40~80，'
      + '两层 `gravity.x` 反号（+10 / −12）⇒ 上升时左右轻晃；`alphaCurve` 出生淡入、结束前才归零。',
    emitters: [
      {
        id: 'emitter_bubble_up_a', name: '气泡 A', seed: 999001,
        origin: point(0, -480), delay: 0,
        rate: 12, burst: 0,
        lifetime: range(3.5, 5.0), size: range(10, 22), speed: range(50, 84),
        angle: 90, spread: 30,
        rotation: range(0, 360), spin: range(-20, 20),
        shape: 'box', radius: 12, width: 1500, height: 30,
        motion: 'velocity', gravity: point(10, 6),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.25, 1], [1, 0.8]),
        alphaCurve: keys([0, 0], [0.1, 0.8], [0.7, 0.7], [1, 0]),
        startColor: color(220, 245, 255, 0.85), endColor: color(255, 255, 255, 0.5),
      },
      {
        id: 'emitter_bubble_up_b', name: '气泡 B', seed: 999002,
        origin: point(0, -465), delay: 0.35,
        rate: 9, burst: 0,
        lifetime: range(3.0, 4.5), size: range(8, 18), speed: range(42, 72),
        angle: 86, spread: 34,
        rotation: range(0, 360), spin: range(-16, 16),
        shape: 'box', radius: 12, width: 1440, height: 30,
        motion: 'velocity', gravity: point(-12, 5),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.5], [0.25, 1], [1, 0.8]),
        alphaCurve: keys([0, 0], [0.1, 0.75], [0.7, 0.65], [1, 0]),
        startColor: color(230, 250, 255, 0.8), endColor: color(200, 235, 255, 0.45),
      },
    ],
  },

  {
    name: 'hit-spark',
    label: '命中火花',
    upstream: null,
    summary: '短促、少量、从一点炸开：`lifetime` 0.25~0.45 秒、高 `rate` 但**小池**（24/层）',
    imageId: 100005,
    duration: 1.2,
    loop: true,
    particlesPerEmitter: 28,
    sizeScale: 1,
    note: '为"打击反馈"做的：`shape="point"`（从**一点**炸开）、`spread` 收到 130~150°（锥形，不是全向）、'
      + '`lifetime` 极短、`alphaCurve` 立刻归零 ⇒ 一闪就没。池子 28/层：并发 = 60×0.45 ≈ 27（A）/ 40×0.40 = 16（B）'
      + '⇒ 刚好够、余量很小（要更保险就把 `particlesPerEmitter` 提到 40）。',
    emitters: [
      {
        id: 'emitter_hit_spark_a', name: '火花 A', seed: 424001,
        origin: point(0, 0), delay: 0,
        rate: 60, burst: 24,
        lifetime: range(0.25, 0.45), size: range(4, 10), speed: range(140, 320),
        angle: 90, spread: 130,
        rotation: range(0, 360), spin: range(-360, 360),
        shape: 'point', radius: 12, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -120),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.3], [0.2, 1], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.08, 1], [0.6, 0.7], [1, 0]),
        startColor: color(255, 255, 210), endColor: color(255, 140, 40),
      },
      {
        id: 'emitter_hit_spark_b', name: '火花 B', seed: 424002,
        origin: point(0, 0), delay: 0.05,
        rate: 40, burst: 16,
        lifetime: range(0.22, 0.4), size: range(3, 8), speed: range(120, 280),
        angle: 90, spread: 150,
        rotation: range(0, 360), spin: range(-420, 420),
        shape: 'point', radius: 12, width: 220, height: 100,
        motion: 'velocity', gravity: point(0, -100),
        control1: point(-180, 200), control2: point(120, 240), target: point(260, 80),
        sizeCurve: keys([0, 0.3], [0.2, 1], [1, 0.2]),
        alphaCurve: keys([0, 0], [0.08, 0.95], [0.55, 0.6], [1, 0]),
        startColor: color(255, 240, 190), endColor: color(255, 90, 90),
      },
    ],
  },
];

/** 深拷贝（预设是**只读数据**：调用方拿到的一定是副本，改它不会污染下一份产物）。 */
const clone = (v) => JSON.parse(JSON.stringify(v));

/** 印一份预设清单（工具的 `preset` 参数校验 / 报错文案 / 测试都用它）。 */
export function listPresets() {
  return PRESETS.map((p) => ({
    name: p.name,
    label: p.label,
    upstream: p.upstream,
    summary: p.summary,
    imageId: p.imageId,
    needsImageId: p.imageIdFromCreator === true,
    duration: p.duration,
    loop: p.loop,
    particlesPerEmitter: p.particlesPerEmitter,
    emitters: p.emitters.length,
  }));
}

/** 按名字取预设的**副本**；未知名字返回 `null`（调用方负责报错并列出 `PRESET_NAMES`）。 */
export function getPreset(name) {
  const p = PRESETS.find((x) => x.name === String(name));
  return p ? clone(p) : null;
}

/**
 * 落程（像素）：`v·t + ½|g|t²`（格式文档 §7.1）。
 * 用平均速度与平均寿命 —— 这是**估算**，用来回答"能不能从顶落到底"，不是逐帧模拟。
 * @param {any} emitter
 * @returns {{speedAvg: number, lifetimeAvg: number, gravityY: number, travel: number, bezierLength: number|null, kind: 'velocity'|'bezier'}}
 */
export function travelOf(emitter) {
  const speedAvg = (emitter.speed.min + emitter.speed.max) / 2;
  const lifetimeAvg = (emitter.lifetime.min + emitter.lifetime.max) / 2;
  const gravityY = Math.abs(emitter.gravity.y);
  if (emitter.motion === 'bezier') {
    // 贝塞尔没有"速度×时间"：直接用折线长度当落程上限（p0 取出生区域中心，保守取 origin）
    const pts = [emitter.origin, emitter.control1, emitter.control2, emitter.target];
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) {
      len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return { speedAvg: 0, lifetimeAvg, gravityY, travel: 0, bezierLength: len, kind: 'bezier' };
  }
  const travel = speedAvg * lifetimeAvg + 0.5 * gravityY * lifetimeAvg * lifetimeAvg;
  return { speedAvg, lifetimeAvg, gravityY, travel, bezierLength: null, kind: 'velocity' };
}

/**
 * 池子（会不会缺粒）：`rate × lifetime.max`（格式文档 §7.2）。
 * ⚠️ 这是**单层**的算法；平台预算是**两层合计 ≤ 1024** ⇒ 两层各自都要够，总量也要够。
 * @param {any} emitter
 */
export function poolOf(emitter) {
  return {
    rate: emitter.rate,
    lifetimeMax: emitter.lifetime.max,
    concurrent: Math.ceil(emitter.rate * emitter.lifetime.max),
    configured: emitter.maxParticles,
    enough: emitter.maxParticles >= emitter.rate * emitter.lifetime.max,
    headroom: emitter.maxParticles - emitter.rate * emitter.lifetime.max,
  };
}

/** 把预设解析成**最终发射器数据**（`imageId` / `duration` / `maxParticles` / 画布已代入）。 */
export function buildPreset(name, opts = {}) {
  const base = getPreset(name);
  if (!base) return null;
  const o = opts || {};
  const givenImage = Number.isFinite(Number(o.imageId)) && Number(o.imageId) > 0 ? Math.round(Number(o.imageId)) : null;
  /*
   * ★ **贴图号是"两层"的**（作者 2026-09-30 更正）：
   *   · 真机：**任意平台素材号**（`op=catalog` 里 1543 条 / 14 类 / id 空间 100001~112042）；
   *   · 模拟器：只画 `100001~100006` 六个几何号（其余是"缺图"标记）—— 那是**模拟器的渲染限制**，不是平台限制。
   *   ⇒ `imageId` 走真机、`previewImageId` 走模拟器预览；两个都回显。
   */
  const previewImage = Number.isFinite(Number(o.previewImageId)) && Number(o.previewImageId) > 0
    ? Math.round(Number(o.previewImageId)) : null;
  // 预设自带号可能是 `null`（`chest-collect`：宝箱图号由创作者给，我们不猜）
  const presetImage = Number.isFinite(Number(base.imageId)) && Number(base.imageId) > 0 ? Number(base.imageId) : null;
  const imageId = givenImage || presetImage;
  const duration = Number.isFinite(Number(o.duration)) && Number(o.duration) > 0 ? Number(o.duration) : base.duration;
  const loop = o.loop === undefined || o.loop === null ? base.loop : o.loop === true;
  const perEmitter = Number.isFinite(Number(o.particlesPerEmitter)) && Number(o.particlesPerEmitter) > 0
    ? Math.round(Number(o.particlesPerEmitter))
    : base.particlesPerEmitter;
  const sizeScale = Number.isFinite(Number(o.sizeScale)) && Number(o.sizeScale) > 0 ? Math.round(Number(o.sizeScale)) : base.sizeScale;
  // 生成物里写"哪一层"的号：给了 previewImageId 就写它（只为在模拟器里看得见图）
  const emittedImageId = previewImage || imageId;
  const emitters = base.emitters.map((e) => Object.assign(clone(e), {
    enabled: true,
    imageId: emittedImageId,
    duration,
    loop,
    maxParticles: perEmitter,
  }));
  return {
    name: base.name, label: base.label, upstream: base.upstream, summary: base.summary, note: base.note,
    imageId, duration, loop, particlesPerEmitter: perEmitter, sizeScale,
    /// 真机用号 / 模拟器预览用号（后者只影响生成物里的 `IMAGE_ID`，不影响数据层核算）
    previewImageId: previewImage,
    emittedImageId,
    /// 这个预设的贴图号**必须由创作者给**（目录里没有名称字段，我们不猜）
    imageIdFromCreator: base.imageIdFromCreator === true,
    emitterCount: emitters.length,
    emitters,
    canvas: { width: CANVAS.width, height: CANVAS.height },
  };
}

/** `DATA.emitters` 全文（`UGCTools.UIParticles@1`，字段名**不许改**）。 */
export function presetToData(built) {
  return {
    schema: SCHEMA,
    name: built.label,
    width: CANVAS.width,
    height: CANVAS.height,
    previewDuration: built.duration,
    emitters: built.emitters.map((e) => clone(e)),
  };
}

/**
 * 纯函数层的自检（**不抛错**，只收集问题）：字段完整性 / 曲线端点 / 池子 / 落程 / 坐标范围。
 * 工具在出 Lua 之前跑一次 —— 数据层坏了要让**回执**说清，而不是等运行时 `validate()` 报"越界数值"。
 * @param {any} built `buildPreset()` 的产物
 * @returns {string[]} 问题清单（空 = 干净）
 */
export function validateBuilt(built) {
  const problems = [];
  const has = (v) => v !== undefined && v !== null;
  const checkRange = (e, key, lo, hi) => {
    const r = e[key];
    if (!r || typeof r.min !== 'number' || typeof r.max !== 'number') { problems.push(`${e.id}.${key} 不是 {min,max}`); return; }
    if (r.min > r.max) problems.push(`${e.id}.${key} 颠倒（min>max）`);
    if (r.min < lo || r.max > hi) problems.push(`${e.id}.${key} 越界（限 ${lo}~${hi}）：${r.min}~${r.max}`);
  };
  const checkCurve = (e, key, max) => {
    const k = e[key];
    if (!Array.isArray(k) || k.length < 2) { problems.push(`${e.id}.${key} 至少 2 个关键点`); return; }
    if (k[0].t !== 0 || k[k.length - 1].t !== 1) problems.push(`${e.id}.${key} 端点必须是 t=0 与 t=1`);
    for (let i = 0; i < k.length; i += 1) {
      if (k[i].t < 0 || k[i].t > 1) problems.push(`${e.id}.${key}[${i}].t 越界`);
      if (k[i].value < 0 || k[i].value > max) problems.push(`${e.id}.${key}[${i}].value 越界（限 0~${max}）`);
      if (i > 0 && k[i].t <= k[i - 1].t) problems.push(`${e.id}.${key} 时间未严格递增`);
    }
  };
  const required = ['id', 'name', 'enabled', 'seed', 'imageId', 'origin', 'delay', 'duration', 'loop',
    'maxParticles', 'rate', 'burst', 'lifetime', 'size', 'speed', 'angle', 'spread', 'rotation', 'spin',
    'shape', 'radius', 'width', 'height', 'motion', 'gravity', 'control1', 'control2', 'target',
    'sizeCurve', 'alphaCurve', 'startColor', 'endColor'];
  for (const e of built.emitters) {
    for (const k of required) if (!has(e[k])) problems.push(`${e.id} 缺字段 ${k}`);
    if (e.maxParticles > BUDGET.perEmitter) problems.push(`${e.id}.maxParticles ${e.maxParticles} > 每层上限 ${BUDGET.perEmitter}`);
    checkRange(e, 'lifetime', 0.05, 30);
    checkRange(e, 'size', 1, 300);
    checkRange(e, 'speed', 0, 2000);
    checkRange(e, 'rotation', -360, 360);
    checkRange(e, 'spin', -720, 720);
    checkCurve(e, 'sizeCurve', 3);
    checkCurve(e, 'alphaCurve', 1);
    if (e.motion === 'bezier' && (e.control1.x === 0 && e.control1.y === 0 && e.target.x === 0 && e.target.y === 0)) {
      problems.push(`${e.id} 是 bezier 但没有控制点/终点`);
    }
    if (e.motion === 'velocity' && e.speed.min === 0 && e.speed.max === 0) {
      problems.push(`${e.id} 是 velocity 但速度为 0（不会动）`);
    }
  }
  const total = built.emitters.reduce((s, e) => s + e.maxParticles, 0);
  if (total > BUDGET.total) problems.push(`控件预算 ${total} > 总上限 ${BUDGET.total}`);
  return problems;
}

/**
 * 落程 / 池子 / 坐标范围的**核算块**（工具回执的 `estimate`、属性表、测试都用同一份）。
 * @param {any} built
 */
export function estimateOf(built) {
  const halfW = built.canvas.width / 2;
  const halfH = built.canvas.height / 2;
  return {
    canvas: built.canvas,
    budget: BUDGET,
    controls: built.emitters.reduce((s, e) => s + e.maxParticles, 0),
    screenHeight: built.canvas.height,
    reachesBottom: built.emitters.some((e) => travelOf(e).travel >= built.canvas.height),
    layers: built.emitters.map((e) => {
      const travel = travelOf(e);
      const pool = poolOf(e);
      return {
        id: e.id, name: e.name,
        rate: e.rate, lifetimeMax: e.lifetime.max, maxParticles: e.maxParticles,
        travel: Number(travel.travel.toFixed(1)),
        reachesBottom: travel.kind === 'velocity' && travel.travel >= built.canvas.height,
        bezierLength: travel.bezierLength === null ? null : Number(travel.bezierLength.toFixed(1)),
        pool,
        spawnInside: e.origin.x - (e.shape === 'box' ? e.width / 2 : e.radius) >= -halfW
          && e.origin.x + (e.shape === 'box' ? e.width / 2 : e.radius) <= halfW
          && e.origin.y - (e.shape === 'box' ? e.height / 2 : e.radius) >= -halfH
          && e.origin.y + (e.shape === 'box' ? e.height / 2 : e.radius) <= halfH,
      };
    }),
  };
}

/** 模拟器只画得出 `SIM_RENDERABLE_IMAGES` 六个号 ⇒ 这个号在模拟器里是"缺图"。 */
export function simulatedImage(built) {
  const ids = [...new Set(built.emitters.map((e) => e.imageId))];
  return {
    imageIds: ids,
    renderable: ids.every((id) => SIM_RENDERABLE_IMAGES.includes(id)),
    meaning: ids.map((id) => (IMAGE_MEANING[id] ? `${id}=${IMAGE_MEANING[id]}` : `${id}=非基础形状号（模拟器画不出）`)),
  };
}

/* ---------------------------------------------------------------- 贝塞尔路径（"钢笔"）

 * ★ 上游到底怎么存的（源码依据，**只报事实**）：
 *   · 字段就三个：`control1`(=P1) / `control2`(=P2) / `target`(=终点)，都是 `{x,y}`
 *     —— `particleModel.ts:16`（`control1: Point; control2: Point; target: Point`）；
 *   · **是三次贝塞尔**（2 个控制点 + 终点，**没有**第二个端点字段）：`particleSimulation.ts:20`
 *     `bezierPoint(t, p0, p1, p2, p3)`（`p0` 是**出生点**、`p3` 是 `target`）。
 *   · **起点 `p0` 不是 `origin`**：是"出生形状里抽出来的那个点"（`particleSimulation.ts:51-55`：
 *     `circle/ring` 取 `cos/sin(shapeAngle)×radius`、`box` 取 `(boxX-.5)×width,(boxY-.5)×height`），
 *     最后才整体加上 `origin`（`particleSimulation.ts:62`：`x: e.origin.x + position.x`）。
 *   · **三个点是"相对发射点"的偏移**，不是画布绝对坐标：`UIVfxEditor.vue:106` 原文提示
 *     「坐标相对发射点；用函数计算三次贝塞尔。沿路径的进度由寿命决定。」；
 *     拖动落盘也按这个口径算：`UIVfxEditor.vue:287,293-295`（`origin = key==='origin' ? {0,0} : e.origin`，
 *     新值 = `画布点 − origin − 抓取偏移`，并 `clamp(-5000, 5000)` + `Math.round`，**没有网格吸附**）；
 *     引导线也画在"以发射点为原点"的局部坐标里：`UIVfxEditor.vue:65-67`（`M 0 0 C P1 P2 target`）。
 *   · **`t` 是时间归一化，不是弧长归一化**：`particleSimulation.ts:56`（`t = age / life`）⇒
 *     **视觉速度沿路径不匀**（控制点拉得越远，那段走得越快）—— 上游 README 第 42 行原文：
 *     「贝塞尔路径使用 Lua 数学函数，不依赖千星曲线资产；**不是弧长匀速运动**。」
 *   · **"定点收集"没有额外语义**：到 `target` 后没有"消失/回收"事件，粒子只是在 `age >= life`
 *     时不再被采样（`particleSimulation.ts:50`）⇒ "收进去了"是靠 `alphaCurve` 在尾部归零 + `life` 结束
 *     两件事**看起来像**被收走。
 */

/** `path` 参数里的三个点（与上游字段一一对应；`p1`=`control1`、`p2`=`control2`）。 */
export const PATH_KEYS = [
  { arg: 'p1', field: 'control1', label: 'P1' },
  { arg: 'p2', field: 'control2', label: 'P2' },
  { arg: 'target', field: 'target', label: '终点' },
];

/** 一个 `{x,y}` 点：接受 `{x,y}` / `[x,y]`，两个数都必须是有限数；否则抛错（不猜）。 */
function readPoint(raw, what) {
  const x = Array.isArray(raw) ? raw[0] : (raw && raw.x);
  const y = Array.isArray(raw) ? raw[1] : (raw && raw.y);
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    throw new Error(what + ' 必须是 `{x, y}`（或 `[x, y]`）两个有限数，收到：' + JSON.stringify(raw));
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}

/**
 * 把调用方给的 `path`（钢笔三个手柄）打到**某一层**发射器上。
 *
 * 语义（与上游编辑器逐条对齐）：
 *   · `path.p1/p2/target` → 该层的 `control1/control2/target`，并把 `motion` 设成 `"bezier"`；
 *   · `path.start` → 覆盖该层的 **`origin`**（"发射点"）；
 *   · 三者都**可单独给**（没给的沿用预设值）—— 只想挪终点时不必把三个点都写一遍；
 *   · 坐标口径与预设数据一致：`p1/p2/target` 是**相对发射点**的偏移，`start` 是**相对容器中心**。
 *
 * @param {any} built `buildPreset()` 的产物（**原地修改**，调用方拿到的是副本）
 * @param {any} path 工具入参里的 `path`
 * @param {number} [layerIndex] 第几层（默认 0 = A 层）
 * @returns {any} 回执块：最终生效的四个点 + 来源标注
 */
export function applyPathOverride(built, path, layerIndex = 0) {
  const e = built.emitters[layerIndex];
  if (!e) throw new Error('path.layer=' + (layerIndex + 1) + ' 超出范围：这个预设只有 ' + built.emitters.length + ' 层发射器');
  if (path === undefined || path === null || typeof path !== 'object') {
    throw new Error('path 必须是对象：`{ p1:{x,y}, p2:{x,y}, target:{x,y}, start? }`');
  }
  const given = {};
  for (const k of PATH_KEYS) {
    if (path[k.arg] !== undefined && path[k.arg] !== null) {
      e[k.field] = readPoint(path[k.arg], 'path.' + k.arg);
      given[k.field] = true;
    }
  }
  if (path.start !== undefined && path.start !== null) {
    e.origin = readPoint(path.start, 'path.start');
    given.origin = true;
  }
  const anyGiven = Object.keys(given).length > 0;
  if (!anyGiven) throw new Error('path 里一个点都没给：至少要给 `p1` / `p2` / `target` / `start` 中的一个');
  e.motion = 'bezier';
  const pt = (p) => ({ x: p.x, y: p.y });
  return {
    layer: layerIndex + 1,
    layerId: e.id,
    layerName: e.name,
    motion: e.motion,
    // 起点 = 发射点 origin（出生形状会在此基础上再给一个 ±radius 的小偏移，见上面的源码依据）
    start: { x: e.origin.x, y: e.origin.y, from: given.origin ? 'arg' : 'preset' },
    p1: { x: e.control1.x, y: e.control1.y, from: given.control1 ? 'arg' : 'preset' },
    p2: { x: e.control2.x, y: e.control2.y, from: given.control2 ? 'arg' : 'preset' },
    target: { x: e.target.x, y: e.target.y, from: given.target ? 'arg' : 'preset' },
    // 终点在画布上的**绝对位置**（= 发射点 + 终点偏移）—— 作者要照着网页编辑器对齐时看这个
    targetOnCanvas: pt({ x: e.origin.x + e.target.x, y: e.origin.y + e.target.y }),
    startOnCanvas: pt(e.origin),
    given: Object.keys(given).map((k) => (k === 'origin' ? 'start' : PATH_KEYS.find((x) => x.field === k).arg)),
  };
}
