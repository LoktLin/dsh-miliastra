/**
 * 图元层（`SHAPE_KIND:"sprite"`）—— **一类新层**：一个形状 = **一个控件**（+ 残影）。
 *
 * 为什么要有这一层（创作者 2026-09-30 的接口工单 `docs/dsh-miliastra_扩展工单_轨迹图元_2026-09-30.md`）：
 *   现有 13 个预设**全部是发射器语义**（"从某个区域按某个频率吐出小点"）⇒ 做不出「一个圆环」/「一道刀光」。
 *   而形状类特效才是弹幕玩法最抓眼的观感来源，且**在真机上比粒子便宜一个数量级**：
 *
 *   | | 一个「圆环」 | 用粒子拼一个「圆环」 |
 *   |---|---|---|
 *   | 控件数 | **1** | 一圈 24 个点 = **24** |
 *   | 每帧 | 1× SetSizeDelta + 1× SetLocalRotation | 24 组 |
 *
 *   ⇒ 这是**唯一能在真机预算内继续加密度**的方向（玩法现在 1494 粒子 / 2257 控件）。
 *
 * ★★ 与粒子层的**契约边界**（重要，别混）：
 *   · 粒子层：`DATA.emitters`，**驱动层逐字取自真机定稿件**（作者已在真机跑通）。
 *   · 图元层：`DATA.sprites`，**驱动与宿主绑定由本模块自己写**（定稿件里没有图元这回事）。
 *     ⇒ 这份产物 **没有任何真机证据**：`SetLocalRotation` 的正负、`Enum.ImageType.Stretch` 的缩放行为、
 *       拉伸后贴图的采样质量 —— 都要真机看一眼。产物顶部如实标 `未验证`，回执也带 `unverified[]`。
 *   · 两者**不共用一个产物**：图元预设的产物里没有粒子运行时（也就**不需要**真机定稿件）。
 *
 * ★ 真机 API 用法**照抄定稿件**（`tmp/fx-demo/特效 fx.lua`：关卡 1073741838 第一屏星雨，真机已跑通），
 *   一处都不编：`game.InstantiateClientUIControl(CONFIG.TEMPLATE_INDEX, script.object)`、
 *   `SetVisible/SetAnchorMin/SetAnchorMax/SetPivot(.5,.5)/SetLocalScale/SetImage(Enum.ImageSource.StaticReference,id)`、
 *   `imageType = Enum.ImageType.*`、`SetAnchoredPosition/SetSizeDelta/SetLocalRotation(0,0,deg)`、
 *   `imageColor = Color.FromRGBA(r,g,b,a*255)`、`SetAsLastSibling()`。
 *   ⚠️ 定稿件里粒子的父节点就是 `script.object`（容器索引只是"声明式挂载点"）⇒ 图元层同样挂 `script.object`；
 *      **不做**「按名字找父容器」（那个查找 API 我**没在真机验过**，不编）。
 */

const P = (x, y) => ({ x, y });
const C = (r, g, b, a = 1) => ({ r, g, b, a });
const K = (...pairs) => pairs.map(([t, value]) => ({ t, value }));

/** 图元贴图号的中文含义（`100001~100006` 是平台几何图元；模拟器也只画得出这六个）。 */
export const SPRITE_IMAGE_MEANING = {
  100001: '方块', 100002: '圆', 100003: '三角', 100004: '四角星', 100005: '五角星', 100006: '圆环',
};

/**
 * 图元预设（**独立于** 13 个粒子预设：粒子表 `PRESETS`/`PRESET_NAMES` 一个字段都不动）。
 * 配方照工单 §3 的三张表；数值是**可调起点**，不是"最优解"。
 */
export const SPRITE_PRESETS = [
  {
    name: 'ring-arc',
    label: '环刃 · 扩张圆环',
    summary: '一个圆环沿路径飞出**并扩张**（1 个控件；不是"一圈点"）',
    note: '工单 §3「圆环」：IMG=100006、STRETCH=1/1、WIDTH/HEIGHT 0.3→1.6、ALPHA 1→0、不旋转。',
    duration: 1.4, loop: true, sizeScale: 1,
    sprites: [{
      id: 'sprite_ring_a', name: '环刃', imageId: 100006,
      origin: P(0, 0), path: [P(0, 0), P(200, 60), P(560, 120), P(820, 0)],
      lifetime: { min: 0.62, max: 0.72 }, size: { min: 150, max: 150 },
      stretchX: 1, stretchY: 1, spinAlign: 'fixed', spinCurve: K([0, 0], [1, 0]),
      widthCurve: K([0, 0.3], [1, 1.6]), heightCurve: K([0, 0.3], [1, 1.6]),
      sizeCurve: K([0, 0.85], [1, 1]),
      alphaCurve: K([0, 1], [1, 0]),
      startColor: C(190, 240, 255), endColor: C(60, 140, 255),
      trailCount: 0, trailGap: 0.12, delay: 0,
    }],
  },
  {
    name: 'slash-arc',
    label: '刀光 · 切向拉伸 + 残影',
    summary: '一道被拉长的刀刃沿曲线扫过、**朝切向旋转**、后面拖 3 层渐隐残影',
    note: '工单 §3「刀光」：IMG=100002（圆被拉长）、STRETCH=3.5/0.35、SPIN_ALIGN=tangent、WIDTH 1→0.4、'
      + 'ALPHA 0→1→0、TRAIL_COUNT=3 / GAP=0.08。',
    duration: 1.2, loop: false, sizeScale: 1,
    sprites: [{
      id: 'sprite_slash_a', name: '刀刃', imageId: 100002,
      origin: P(0, 0), path: [P(0, 0), P(300, -420), P(760, -380), P(1024, 0)],
      lifetime: { min: 0.42, max: 0.5 }, size: { min: 220, max: 220 },
      stretchX: 3.5, stretchY: 0.35, spinAlign: 'tangent', spinCurve: K([0, 0], [1, 0]),
      widthCurve: K([0, 1], [1, 0.4]), heightCurve: K([0, 1], [1, 1]),
      sizeCurve: K([0, 1], [1, 1]),
      alphaCurve: K([0, 0.2], [0.15, 1], [1, 0]),
      startColor: C(255, 250, 220), endColor: C(255, 150, 60),
      trailCount: 3, trailGap: 0.08, delay: 0,
    }],
  },
  {
    name: 'crescent-arc',
    label: '新月 · 两段路径',
    summary: '弧刃沿**两段**贝塞尔飞（7 个控制点）、飞行中"弯"起来，像新月',
    note: '工单 §3「弧刃（新月）」：IMG=100006、STRETCH=2.2/0.5、SPIN_ALIGN=tangent、'
      + 'HEIGHT_CURVE 0.4→1.3→0.6；路径用 **7 个点 = 两段**（多段口径见工单 §2.2）。',
    duration: 1.6, loop: true, sizeScale: 1,
    sprites: [{
      id: 'sprite_crescent_a', name: '新月刃', imageId: 100006,
      origin: P(0, 0),
      path: [P(0, 0), P(220, -320), P(520, -420), P(760, -260), P(940, -120), P(980, 60), P(900, 180)],
      lifetime: { min: 0.7, max: 0.8 }, size: { min: 220, max: 220 },
      stretchX: 2.2, stretchY: 0.5, spinAlign: 'tangent', spinCurve: K([0, 0], [1, 0]),
      widthCurve: K([0, 1], [1, 0.7]), heightCurve: K([0, 0.4], [0.6, 1.3], [1, 0.6]),
      sizeCurve: K([0, 1], [1, 1]),
      alphaCurve: K([0, 0.15], [0.12, 1], [1, 0]),
      startColor: C(200, 255, 230), endColor: C(60, 220, 190),
      trailCount: 1, trailGap: 0.1, delay: 0,
    }],
  },
];

export const SPRITE_PRESET_NAMES = SPRITE_PRESETS.map((p) => p.name);

/**
 * 图元预设清单（**给 `preset:"list"` 用** —— 与粒子层的 `listPresets()` 并列，不混表）。
 * 为什么单列一张表：粒子层 13 个预设的字段契约是 `UGCTools.UIParticles@1`（上游格式），
 * 图元层是**我们自己的新契约**（`shapeKind="sprite"` + 拉伸/切向/曲线）—— 混进同一张表会让
 * "13 个预设字段集一致"那条断言（`tests/vfx-test.mjs`）失效，而那条断言是有价值的。
 */
export function listSpritePresets() {
  return SPRITE_PRESETS.map((p) => ({ ...p }));
}

/** 是不是图元预设（工具据此分流：图元走本模块，粒子走定稿件）。 */
export function isSpritePreset(name) {
  return SPRITE_PRESET_NAMES.includes(String(name || ''));
}

/** 一个图元的**控件数** = 1 本体 + 残影数（★ 这打破了"每层一个池"的旧口径）。上下限同 `trailCount`（0~6）。 */
export function spriteControls(s) {
  return 1 + Math.min(6, Math.max(0, Math.round(Number(s && s.trailCount) || 0)));
}

/** 图元层是"一个控件换一个形状"⇒ 没有池子概念；给一个恒真的占位，让人一眼看出**别去套 rate×lifetime**。 */
export function spritePoolOf(s) {
  return {
    kind: 'sprite',
    concurrent: 1,
    configured: spriteControls(s),
    enough: true,
    headroom: 0,
    note: '图元层没有池：控件数 = 1 + 残影数 = ' + spriteControls(s) + '（与 rate/lifetime 无关）',
  };
}

/* ------------------------------------------------------------------ 多段贝塞尔

 * ★ 口径**必须与作者运行时的 `bezPath` 完全一致**（工单 §2.2 原文："点数 = 4 + 3×(段数−1)…
 *   等分参数、段内三次求值；`segs = (n−1)/3"）：
 *   · 段数 `segs = (n−1)/3`，`t ∈ [0,1]` **等分到各段**（不是弧长等分）；
 *   · 段内套标准三次贝塞尔求值。
 * ★ 路径点是**相对出生点**的偏移（与粒子层的 `control1/control2/target` 同口径），首个点恒为 `(0,0)`。
 */

/** 段数（点数必须是 4+3k，否则返回 null —— 调用方负责报错）。 */
export function spriteSegments(path) {
  const n = Array.isArray(path) ? path.length : 0;
  if (n < 4 || (n - 1) % 3 !== 0) return null;
  return (n - 1) / 3;
}

const ptOf = (p) => (Array.isArray(p) ? { x: Number(p[0]) || 0, y: Number(p[1]) || 0 }
  : { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 });

/** 多段贝塞尔求值（`t ∈ [0,1]` 等分参数）。`path` 非法时返回 `{x:0,y:0}`。 */
export function spritePathAt(path, t) {
  const segs = spriteSegments(path);
  if (!segs) return { x: 0, y: 0 };
  let u = Math.min(Math.max(Number(t) || 0, 0), 1) * segs;
  let seg = Math.floor(u);
  if (seg >= segs) { seg = segs - 1; u = 1; } else { u -= seg; }
  const p0 = ptOf(path[seg * 3]), p1 = ptOf(path[seg * 3 + 1]);
  const p2 = ptOf(path[seg * 3 + 2]), p3 = ptOf(path[seg * 3 + 3]);
  const m = 1 - u;
  return {
    x: m * m * m * p0.x + 3 * m * m * u * p1.x + 3 * m * u * u * p2.x + u * u * u * p3.x,
    y: m * m * m * p0.y + 3 * m * m * u * p1.y + 3 * m * u * u * p2.y + u * u * u * p3.y,
  };
}

/** 切向角（度；`atan2(dy, dx)`，**不含** y-up/UI 旋转方向的正负修正 —— 那个交给产物里的 `SPIN_SIGN`）。 */
export function spritePathAngle(path, t) {
  const segs = spriteSegments(path);
  if (!segs) return 0;
  let u = Math.min(Math.max(Number(t) || 0, 0), 1) * segs;
  let seg = Math.floor(u);
  if (seg >= segs) { seg = segs - 1; u = 1; } else { u -= seg; }
  const p0 = ptOf(path[seg * 3]), p1 = ptOf(path[seg * 3 + 1]);
  const p2 = ptOf(path[seg * 3 + 2]), p3 = ptOf(path[seg * 3 + 3]);
  const m = 1 - u;
  const dx = 3 * m * m * (p1.x - p0.x) + 6 * m * u * (p2.x - p1.x) + 3 * u * u * (p3.x - p2.x);
  const dy = 3 * m * m * (p1.y - p0.y) + 6 * m * u * (p2.y - p1.y) + 3 * u * u * (p3.y - p2.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * 弧长核算（**本工具按数值积分自算**，不是平台数据）：总长 / 逐段长 / 速度离散度。
 * `speedSpread = max|d|/min|d|`（1 = 按参数走恰好匀速；越大越"忽快忽慢"）—— 拉伸后的刀光把这个放大了，
 * 因为刀身的**朝向**也跟着切线转，速度不匀会看得比粒子更明显。
 */
export function spriteArcOf(s, sample = 64) {
  const segs = spriteSegments(s && s.path);
  if (!segs) return null;
  const total = Math.max(8, Math.round(sample));
  let len = 0; let prev = spritePathAt(s.path, 0);
  const per = new Array(segs).fill(0);
  const speeds = [];
  for (let i = 1; i <= total; i += 1) {
    const t = i / total;
    const cur = spritePathAt(s.path, t);
    const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    len += d;
    const segIdx = Math.min(segs - 1, Math.floor((t - 1e-9) * segs));
    per[segIdx] += d;
    if (i > 1) speeds.push(d);
    prev = cur;
  }
  const mn = Math.min.apply(null, speeds);
  const mx = Math.max.apply(null, speeds);
  return {
    points: s.path.length,
    segments: segs,
    length: Number(len.toFixed(3)),
    perSegment: per.map((v) => Number(v.toFixed(3))),
    speedSpread: mn > 0 ? Number((mx / mn).toFixed(3)) : null,
  };
}

/* ------------------------------------------------------------------ 构建 */

function clampStretch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Number(Math.min(Math.max(n, 0.1), 8).toFixed(3));
}

/** 一条曲线：`[{t,v}]`；非法 / 缺失 ⇒ `null`（Lua 侧按"恒定 1"处理）。 */
function normalizeCurve(c) {
  if (!Array.isArray(c) || c.length < 2) return null;
  const rows = c.map((k) => ({ t: Number(k && k.t) || 0, value: Number(k && (k.value === undefined ? k.v : k.value)) || 0 }));
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

function normalizeColor(c, fallback) {
  if (!c) return fallback;
  const n = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  return { r: n(c.r, fallback.r), g: n(c.g, fallback.g), b: n(c.b, fallback.b), a: Number.isFinite(Number(c.a)) ? Number(c.a) : 1 };
}

/** 把预设解析成**最终图元数据**（`imageId` / `duration` / 画布已代入）。 */
export function buildSpritePreset(name, opts = {}) {
  const base = SPRITE_PRESETS.find((p) => p.name === String(name));
  if (!base) return null;
  const o = opts || {};
  const given = Number.isFinite(Number(o.imageId)) && Number(o.imageId) > 0 ? Math.round(Number(o.imageId)) : null;
  const preview = Number.isFinite(Number(o.previewImageId)) && Number(o.previewImageId) > 0 ? Math.round(Number(o.previewImageId)) : null;
  const firstImage = given || base.sprites[0].imageId;
  const emittedImage = preview || firstImage;
  const duration = Number.isFinite(Number(o.duration)) && Number(o.duration) > 0 ? Number(o.duration) : base.duration;
  const loop = o.loop === undefined || o.loop === null ? base.loop : o.loop === true;
  const sizeScale = Number.isFinite(Number(o.sizeScale)) && Number(o.sizeScale) > 0 ? Number(o.sizeScale) : base.sizeScale;
  const sprites = base.sprites.map((s) => {
    const img = (given && base.sprites.length === 1) ? given : s.imageId;
    return {
      id: s.id, name: s.name, shapeKind: 'sprite',
      imageId: img,
      emittedImageId: (preview && base.sprites.length === 1) ? preview : img,
      origin: { x: Number(s.origin.x) || 0, y: Number(s.origin.y) || 0 },
      path: s.path.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 })),
      lifetime: { min: Number(s.lifetime.min), max: Number(s.lifetime.max) },
      size: { min: Number(s.size.min), max: Number(s.size.max) },
      stretchX: clampStretch(s.stretchX), stretchY: clampStretch(s.stretchY),
      spinAlign: s.spinAlign === 'tangent' ? 'tangent' : 'fixed',
      widthCurve: normalizeCurve(s.widthCurve), heightCurve: normalizeCurve(s.heightCurve),
      sizeCurve: normalizeCurve(s.sizeCurve), spinCurve: normalizeCurve(s.spinCurve),
      alphaCurve: normalizeCurve(s.alphaCurve),
      startColor: normalizeColor(s.startColor, { r: 255, g: 255, b: 255, a: 1 }),
      endColor: normalizeColor(s.endColor, { r: 255, g: 255, b: 255, a: 1 }),
      trailCount: Math.max(0, Math.min(6, Math.round(Number(s.trailCount) || 0))),
      trailGap: Number.isFinite(Number(s.trailGap)) ? Math.min(Math.max(Number(s.trailGap), 0), 0.3) : 0.12,
      delay: Number(s.delay) || 0,
      controls: spriteControls(s),
    };
  });
  return {
    name: base.name, label: base.label, summary: base.summary, note: base.note,
    shapeKind: 'sprite',
    imageId: firstImage, previewImageId: preview, emittedImageId: emittedImage,
    imageMeaning: SPRITE_IMAGE_MEANING[firstImage] || null,
    duration, loop, sizeScale, particlesPerEmitter: 0, imageIdFromCreator: false,
    emitters: [],             // ★ 图元预设**没有**发射器层（产物里也就没有粒子运行时）
    sprites,
    spriteCount: sprites.length,
    controls: sprites.reduce((a, s) => a + s.controls, 0),
    canvas: { width: 1600, height: 1000 },
  };
}

/** `DATA.sprites` 的那一段（给 `output:"data"` 与回执 `layers[]` 共用）。 */
export function spriteLayerRows(built) {
  return (built.sprites || []).map((s) => {
    const arc = spriteArcOf(s);
    return {
      id: s.id, name: s.name, shapeKind: 'sprite',
      imageId: s.imageId, imageMeaning: SPRITE_IMAGE_MEANING[s.imageId] || null,
      origin: { x: s.origin.x, y: s.origin.y },
      path: s.path.map((p) => ({ x: p.x, y: p.y })),
      points: s.path.length, segments: arc ? arc.segments : null,
      lifetime: { min: s.lifetime.min, max: s.lifetime.max },
      size: { min: s.size.min, max: s.size.max },
      stretch: { x: s.stretchX, y: s.stretchY },
      spinAlign: s.spinAlign,
      widthCurve: s.widthCurve, heightCurve: s.heightCurve, sizeCurve: s.sizeCurve,
      spinCurve: s.spinCurve, alphaCurve: s.alphaCurve,
      startColor: s.startColor, endColor: s.endColor,
      trailCount: s.trailCount, trailGap: s.trailGap,
      controls: s.controls,
      arcLength: arc ? arc.length : null,
      arcPerSegment: arc ? arc.perSegment : null,
      speedSpread: arc ? arc.speedSpread : null,
    };
  });
}

/** 数据层自检（**不抛错**，只收集问题 —— 让回执说清，而不是让真机报错）。 */
export function validateSprites(built) {
  const problems = [];
  const sprites = Array.isArray(built.sprites) ? built.sprites : [];
  if (!sprites.length) problems.push('图元预设里一层都没有');
  sprites.forEach((s, i) => {
    const tag = s.id || ('第' + (i + 1) + '层');
    const segs = spriteSegments(s.path);
    if (!segs) {
      problems.push(tag + '.path 点数必须是 4+3k（单段 4、两段 7、三段 10…），收到 ' + (s.path || []).length + ' 个');
    } else {
      const first = s.path[0];
      if (Math.abs(first.x) > 1e-6 || Math.abs(first.y) > 1e-6) {
        problems.push(tag + '.path 首个点必须是 (0,0)（路径点相对出生点）—— 收到 (' + first.x + ',' + first.y + ')');
      }
    }
    if (!Number.isFinite(s.imageId) || s.imageId <= 0) problems.push(tag + '.imageId 必须是正整数（图源）');
    if (!(s.lifetime.min > 0) || s.lifetime.min > s.lifetime.max) problems.push(tag + '.lifetime 不合法');
    if (!(s.size.min > 0) || s.size.min > s.size.max) problems.push(tag + '.size 不合法');
    for (const k of ['stretchX', 'stretchY']) {
      if (!(s[k] >= 0.1 && s[k] <= 8)) problems.push(tag + '.' + k + ' 越界（限 0.1~8）：' + s[k]);
    }
    if (s.spinAlign !== 'tangent' && s.spinAlign !== 'fixed') problems.push(tag + '.spinAlign 只能是 tangent / fixed');
    if (!(s.trailCount >= 0 && s.trailCount <= 6)) problems.push(tag + '.trailCount 越界（限 0~6）');
    if (!(s.trailGap >= 0 && s.trailGap <= 0.3)) problems.push(tag + '.trailGap 越界（限 0~0.3）');
    for (const key of ['widthCurve', 'heightCurve', 'sizeCurve', 'spinCurve', 'alphaCurve']) {
      const c = s[key];
      if (c === null || c === undefined) continue;
      if (!Array.isArray(c) || c.length < 2) { problems.push(tag + '.' + key + ' 至少要 2 个关键点'); continue; }
      if (Math.abs(c[0].t) > 1e-6 || Math.abs(c[c.length - 1].t - 1) > 1e-6) {
        problems.push(tag + '.' + key + ' 端点必须是 t=0 与 t=1');
      }
    }
  });
  return problems;
}

/* ------------------------------------------------------------------ 产物（Lua）

 * 结构（与粒子产物同序，便于人对照）：头注释 → VERSION → CONFIG → 交接值校验 → DATA → 图元运行时 → 宿主绑定。
 * ★ 值全部写在 **DATA.sprites**（图元层不走 `CONFIG` 展开：粒子层那么做是为了与网页编辑器的检查面板逐项对齐，
 *   图元层没有那个面板）—— CONFIG 只放交接值与全局开关。
 */

const numOf = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '0');
const luaCurve = (c) => (c ? '{' + c.map((k) => '{' + numOf(k.t) + ',' + numOf(k.value) + '}').join(',') + '}' : 'nil');
const luaColor = (c) => '{' + numOf(c.r) + ',' + numOf(c.g) + ',' + numOf(c.b) + ',' + numOf(c.a) + '}';
const luaPath = (p) => '{' + p.map((q) => '{' + numOf(q.x) + ',' + numOf(q.y) + '}').join(',') + '}';

/** DATA 块（`sprites` 数组；`emitters` 不存在 ⇒ 粒子运行时不会碰它）。 */
export function spriteDataBlock(built) {
  const rows = built.sprites.map((s) => [
    '        {',
    '            id = ' + JSON.stringify(s.id) + ', name = ' + JSON.stringify(s.name) + ',',
    '            shapeKind = "sprite",',
    '            imageId = ' + numOf(s.emittedImageId) + ',',
    '            originX = ' + numOf(s.origin.x) + ', originY = ' + numOf(s.origin.y) + ',',
    '            path = ' + luaPath(s.path) + ',',
    '            lifetimeMin = ' + numOf(s.lifetime.min) + ', lifetimeMax = ' + numOf(s.lifetime.max) + ',',
    '            size = ' + numOf(s.size.max) + ',',
    '            stretchX = ' + numOf(s.stretchX) + ', stretchY = ' + numOf(s.stretchY) + ',',
    '            spinAlign = ' + JSON.stringify(s.spinAlign) + ',',
    '            widthCurve = ' + luaCurve(s.widthCurve) + ', heightCurve = ' + luaCurve(s.heightCurve) + ',',
    '            sizeCurve = ' + luaCurve(s.sizeCurve) + ', spinCurve = ' + luaCurve(s.spinCurve) + ',',
    '            alphaCurve = ' + luaCurve(s.alphaCurve) + ',',
    '            startColor = ' + luaColor(s.startColor) + ', endColor = ' + luaColor(s.endColor) + ',',
    '            trailCount = ' + numOf(s.trailCount) + ', trailGap = ' + numOf(s.trailGap) + ',',
    '            delay = ' + numOf(s.delay) + ',',
    '        },',
  ].join('\n')).join('\n');
  return [
    '-- ============================================================================',
    '-- 数据层：**图元层**（`shapeKind = "sprite"`）',
    '--   ★ 一个形状 = 一个控件（+ 残影）；沿 `path`（多段三次贝塞尔，4+3k 点）飞。',
    '--   ★ `path` 的点是**相对出生点**的偏移，首个点恒为 (0,0) —— 与粒子层 `control1/control2/target` 同口径。',
    '--   ★ `t` 是**时间归一化**（t = age/life），**不是弧长匀速**：等分参数、段内三次求值（`segs = (n-1)/3`）。',
    '-- ============================================================================',
    'local DATA = {',
    '    schema = "UGCTools.UIParticles@1",',
    '    shapeKind = "sprite",',
    '    canvasWidth = ' + numOf(built.canvas.width) + ', canvasHeight = ' + numOf(built.canvas.height) + ',',
    '    sprites = {',
    rows,
    '    },',
    '}',
  ].join('\n');
}

/**
 * 生成**可部署的图元特效 Lua**（自包含：不含粒子运行时，也就不需要真机定稿件）。
 * @param {{built:any, templateIndex?:number|null, container?:number|null, version?:string,
 *          createAfterFrames?:number, diagSteadyAt?:number}} o
 */
export function buildSpriteLua(o) {
  const built = o.built;
  const version = o.version || ('sprite-' + built.name + '-v1');
  const createAfterFrames = Number.isFinite(Number(o.createAfterFrames)) ? Math.round(Number(o.createAfterFrames)) : 30;
  const diagSteadyAt = Number.isFinite(Number(o.diagSteadyAt)) ? Number(o.diagSteadyAt) : 2;
  const rows = spriteLayerRows(built);
  const L = [];
  L.push('-- 特效 ' + built.name + '（' + built.label + '）· **图元层（sprite）** —— 由 dsh-miliastra `miliastra_gen op=vfx-lua` 生成。');
  L.push('--');
  L.push('-- ★ 这一类层**不是粒子**：一个形状 = **一个控件**（+ 残影）。它沿**多段三次贝塞尔**路径飞、');
  L.push('--   按 `STRETCH` 拉伸、按 `SPIN_ALIGN` 对齐切向 —— 控件数从"每层一个池"降到"每层 1 + 残影数"。');
  L.push('--');
  L.push('-- ⚠️⚠️ **未验证**（如实标，别当通行证）：');
  L.push('--   · 图元层的**驱动与宿主绑定由生成器自己写**（真机定稿件里只有粒子，没有图元）；');
  L.push('--     ⇒ 这份产物**没有任何真机证据**：`SetLocalRotation` 的正负、`Enum.ImageType.Stretch` 的缩放行为、');
  L.push('--       拉伸后贴图的采样质量，都要真机看一眼。');
  L.push('--   · `SPIN_SIGN` 就是给"旋转方向反了"准备的开关（改这一行，不用改代码）。');
  L.push('--   · 弧长/速度离散度是**本工具按 64 点数值积分自算**的（不是平台数据）。');
  L.push('--');
  L.push('-- ★ 真机 API 用法**照抄已跑通的定稿件**（tmp/fx-demo/特效 fx.lua，关卡 1073741838），一处不编：');
  L.push('--   `game.InstantiateClientUIControl(TEMPLATE_INDEX, script.object)` · `SetAnchorMin/Max` + `SetPivot(.5,.5)`');
  L.push('--   · `SetImage(Enum.ImageSource.StaticReference, id)` · `SetAnchoredPosition/SetSizeDelta/SetLocalRotation(0,0,deg)`');
  L.push('--   · `imageColor = Color.FromRGBA(r,g,b,a*255)` · `SetVisible` · `SetAsLastSibling`');
  L.push('--   父节点就是 `script.object`（定稿件同口径）；**不**做"按名字找父容器"（那个查找 API 没在真机验过）。');
  L.push('--');
  L.push('-- ★★ 运行时依赖清单（缺哪一项，`OnStart` 立刻 `error` 点名 ⇒ **整屏没有图元**）：');
  L.push('--   TEMPLATE_INDEX  ' + (o.templateIndex ? String(o.templateIndex) : '<**缺**>')
    + '   图片控件模板索引（只有"存为模板"的独立图片控件能创建）' + (o.templateIndex ? '' : '　← **缺 → 运行时必 error**'));
  L.push('--   CONTAINER_INDEX ' + (o.container ? String(o.container) : '<**缺**>')
    + '   容器节点索引（声明式挂载点 + 就绪自检；运行时父节点是 `script.object`）' + (o.container ? '' : '　← **缺 → 运行时必 error**'));
  L.push('--   IMAGE_ID        ' + rows.map((r) => r.imageId + (r.imageMeaning ? '(' + r.imageMeaning + ')' : '')).join(' / ')
    + '   图源 —— `miliastra_asset op=catalog` 挑（`100001~100006` 是**模拟器**也画得出的几何号）');
  L.push('--   ⚠️ 上面任一「缺」都要**先补齐再投递**：`preflight[]` 会在投递前逐条判给你。');
  L.push('--');
  L.push('');
  L.push('local VERSION = ' + JSON.stringify(version));
  L.push('local PRESET = ' + JSON.stringify(built.name));
  L.push('');
  L.push('local CONFIG = {');
  L.push('    -- ★★ 交接值（**不许编**；来源：创作者交接 或 `miliastra_map op=clientui` 读 .gil）----');
  L.push('    TEMPLATE_INDEX = ' + (o.templateIndex ? numOf(o.templateIndex) : 'nil') + ',');
  L.push('    CONTAINER_INDEX = ' + (o.container ? numOf(o.container) : 'nil') + ',');
  L.push('');
  L.push('    -- ★★ 节奏与开关 ----');
  L.push('    DURATION = ' + numOf(built.duration) + ',            -- 播多久（秒）');
  L.push('    LOOP = ' + (built.loop ? 'true' : 'false') + ',                  -- true = 播完重头再来');
  L.push('    SIZE_SCALE = ' + numOf(built.sizeScale) + ',           -- 图元尺寸倍率（1 = 原生）');
  L.push('    CREATE_AFTER_FRAMES = ' + numOf(createAfterFrames) + ',  -- ★★ 晚建：>0 必开（设 0 会被后建的全屏背景盖住）');
  L.push('    SPIN_SIGN = 1,             -- ⚠️ 切向旋转的**符号**：真机上若刀光朝反方向，把这里改成 -1（未验证）');
  L.push('    IMAGE_TYPE = "Stretch",    -- ⚠️ 定稿件用 Basic（正方形粒子）；图元要被拉成长条 ⇒ 用 Stretch（未验证）');
  L.push('    HIDE_WHEN_DONE = true,     -- 播完隐藏（不销毁）');
  L.push('    RAISE_TO_FRONT = true,     -- 建完把最后一个控件提到最上层（后建的在上）');
  L.push('    DIAG_STEADY_AT = ' + numOf(diagSteadyAt) + ',       -- 稳态诊断时刻（秒）；≤0 = 关掉');
  L.push('    WIDTH = ' + numOf(built.canvas.width) + ',');
  L.push('    HEIGHT = ' + numOf(built.canvas.height) + ',');
  L.push('}');
  L.push('');
  L.push('-- ============================================================================');
  L.push('-- 交接值校验（错误文本与定稿件同形：`缺少交接值 CONFIG.…` ⇒ `miliastra_log op=errors` 认它）');
  L.push('-- ============================================================================');
  L.push('local function requireHandover(name, value)');
  L.push('    if type(value) ~= "number" or value ~= value or value <= 0 or value % 1 ~= 0 then');
  L.push('        error("缺少交接值 CONFIG." .. name .. "（收到 " .. tostring(value)');
  L.push('            .. "）—— 见产物顶部「运行时依赖清单」", 0)');
  L.push('    end');
  L.push('    return value');
  L.push('end');
  L.push('');
  L.push(spriteDataBlock(built));
  L.push('');
  L.push(spriteRuntimeLua());
  L.push('');
  L.push(spriteBindingLua());
  const lua = L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return { lua, lines: lua.split('\n').length, bytes: Buffer.byteLength(lua, 'utf8'), fixture: null, dataLines: spriteDataBlock(built).split('\n').length };
}

/** 图元运行时（求值 + 一个图元的 N 个控件）。**生成器自有**，不是定稿件内容。 */
function spriteRuntimeLua() {
  return [
    '-- ============================================================================',
    '-- 图元运行时（**生成器自有**：定稿件里没有图元这回事）',
    '--   求值：多段贝塞尔（等分参数 + 段内三次）/ 折线曲线 / 颜色插值 / 段内解析切向',
    '--   一个图元 = 1 个本体 + `trailCount` 个残影（沿同一条路径按时间**错开**）',
    '-- ============================================================================',
    'local function bezSegs(path)',
    '    local n = #path',
    '    if n < 4 or (n - 1) % 3 ~= 0 then return nil end   -- 点数必须是 4+3k',
    '    return (n - 1) / 3',
    'end',
    '',
    '-- ★★ 可移植 `atan2` —— **必须声明在 `bezAngle` 之前**（local 是词法作用域：写在后面 = 读到的还是 nil 的全局，',
    '--   那正是本工程最高发的 bug 类）。',
    '--   来由（2026-09-30 模拟器端到端抓到的真 bug）：第一版直接调 `math.atan2(dy, dx)` ⇒ 运行时报',
    '--   `attempt to call a nil value (field \'atan2\')` —— **Lua 5.3+ 删掉了 `math.atan2`**（改成两参 `math.atan(y, x)`），',
    '--   而沙箱的 Lua 版本不由我们挑 ⇒ 自带一个：能用就用，否则按象限手算（任何版本都对）。',
    'local function atan2(y, x)',
    '    if math.atan2 ~= nil then return math.atan2(y, x) end',
    '    if x > 0 then',
    '        return math.atan(y / x)',
    '    elseif x < 0 then',
    '        if y >= 0 then return math.atan(y / x) + math.pi end',
    '        return math.atan(y / x) - math.pi',
    '    elseif y > 0 then',
    '        return math.pi / 2',
    '    elseif y < 0 then',
    '        return -math.pi / 2',
    '    end',
    '    return 0',
    'end',
    '',
    '-- 多段贝塞尔：`t` 等分到各段（与作者运行时的 `bezPath` 同口径），段内三次求值。',
    'local function bezAt(path, segs, t)',
    '    if t < 0 then t = 0 elseif t > 1 then t = 1 end',
    '    local u = t * segs',
    '    local seg = math.floor(u)',
    '    if seg >= segs then seg = segs - 1; u = 1 else u = u - seg end',
    '    local i = seg * 3',
    '    local p0, p1, p2, p3 = path[i + 1], path[i + 2], path[i + 3], path[i + 4]',
    '    local m = 1 - u',
    '    local x = m*m*m*p0[1] + 3*m*m*u*p1[1] + 3*m*u*u*p2[1] + u*u*u*p3[1]',
    '    local y = m*m*m*p0[2] + 3*m*m*u*p1[2] + 3*m*u*u*p2[2] + u*u*u*p3[2]',
    '    return x, y',
    'end',
    '',
    '-- 段内**解析导数** ⇒ 切向角（度）。`SPIN_SIGN` 处理 y 向上 / UI 旋转方向的正负（未验证）。',
    'local function bezAngle(path, segs, t)',
    '    if t < 0 then t = 0 elseif t > 1 then t = 1 end',
    '    local u = t * segs',
    '    local seg = math.floor(u)',
    '    if seg >= segs then seg = segs - 1; u = 1 else u = u - seg end',
    '    local i = seg * 3',
    '    local p0, p1, p2, p3 = path[i + 1], path[i + 2], path[i + 3], path[i + 4]',
    '    local m = 1 - u',
    '    local dx = 3*m*m*(p1[1]-p0[1]) + 6*m*u*(p2[1]-p1[1]) + 3*u*u*(p3[1]-p2[1])',
    '    local dy = 3*m*m*(p1[2]-p0[2]) + 6*m*u*(p2[2]-p1[2]) + 3*u*u*(p3[2]-p2[2])',
    '    if dx == 0 and dy == 0 then return 0 end',
    '    return math.deg(atan2(dy, dx))',
    'end',
    '',
    '-- 折线曲线：`keys = {{t,v},…}`；nil/空 ⇒ 恒定 `fallback`（默认 1）。端点外按端点值（不外推）。',
    'local function curveAt(keys, t, fallback)',
    '    local fb = fallback == nil and 1 or fallback',
    '    if keys == nil or #keys < 2 then return fb end',
    '    if t <= keys[1][1] then return keys[1][2] end',
    '    local last = keys[#keys]',
    '    if t >= last[1] then return last[2] end',
    '    for i = 1, #keys - 1 do',
    '        local a, b = keys[i], keys[i + 1]',
    '        if t >= a[1] and t <= b[1] then',
    '            local span = b[1] - a[1]',
    '            if span <= 0 then return b[2] end',
    '            local k = (t - a[1]) / span',
    '            return a[2] + (b[2] - a[2]) * k',
    '        end',
    '    end',
    '    return last[2]',
    'end',
    '',
    'local function mix(a, b, k) return a + (b - a) * k end',
    '',
    '-- 一个图元：1 本体 + N 残影。残影 = 同一条路径上**时间错开**的副本（越旧的越淡越细）。',
    'local function makeSprite(def, parent, createImage)',
    '    local segs = bezSegs(def.path)',
    '    if segs == nil then',
    '        error("图元 "+def.id+" 的 path 点数必须是 4+3k（收到 "..#def.path.."）", 0)',
    '    end',
    '    local self = { def = def, segs = segs, copies = {}, age = 0, alive = true }',
    '    local total = 1 + (def.trailCount or 0)',
    '    for i = 1, total do',
    '        local c = createImage(parent)',
    '        if c == nil then',
    '            error("图片控件实例化失败：模板 "..tostring(CONFIG.TEMPLATE_INDEX)',
    '                .." 不是「存为模板」的独立图片控件（画布上摆的实例恒返回 nil）", 0)',
    '        end',
    '        if not c.alive or typeof(c) ~= "ClientUIImageControl" then error("创建模板的根控件必须是图片") end',
    '        c:SetVisible(false)',
    '        c.canControllerFocus = false',
    '        c:SetAnchorMin(.5,.5); c:SetAnchorMax(.5,.5); c:SetPivot(.5,.5)',
    '        c:SetLocalScale(1,1,1); c:SetLocalRotation(0,0,0)',
    '        c:SetImage(Enum.ImageSource.StaticReference, def.imageId)',
    '        c.imageType = (CONFIG.IMAGE_TYPE == "Basic") and Enum.ImageType.Basic or Enum.ImageType.Stretch',
    '        c.enableMask = false; c.enableSoftEdge = false; c:SetFillUnused()',
    '        c:SetActive(true)',
    '        self.copies[i] = { ctrl = c, isTrail = (i > 1) }',
    '    end',
    '    if CONFIG.RAISE_TO_FRONT then',
    '        local tail = self.copies[#self.copies]',
    '        if tail ~= nil and tail.ctrl.alive then',
    '            if not tail.ctrl:SetAsLastSibling() then print("[图元:"..PRESET.."] 提层失败（无害）") end',
    '        end',
    '    end',
    '    function self:Update(dt)',
    '        if not self.alive then return end',
    '        self.age = self.age + dt',
    '        local d = self.def',
    '        local life = d.lifetimeMin + (d.lifetimeMax - d.lifetimeMin) * 0.5   -- 固定取中点（可复现）',
    '        local age = self.age - (d.delay or 0)',
    '        for i = 1, #self.copies do',
    '            local copy = self.copies[i]',
    '            local c = copy.ctrl',
    '            -- 残影：第 i 个副本的时间 = age − (i−1)×gap×life',
    '            local a = age - (i - 1) * (d.trailGap or 0) * life',
    '            if (not c.alive) or a < 0 or a > life then',
    '                if c.alive and c.visible then c:SetVisible(false) end',
    '            else',
    '                local t = a / life',
    '                local x, y = bezAt(d.path, self.segs, t)',
    '                x = x + (d.originX or 0); y = y + (d.originY or 0)',
    '                local sizeT = (d.sizeCurve ~= nil) and curveAt(d.sizeCurve, t, 1) or 1',
    '                local base = d.size * CONFIG.SIZE_SCALE * sizeT',
    '                local w = base * d.stretchX * curveAt(d.widthCurve, t, 1)',
    '                local h = base * d.stretchY * curveAt(d.heightCurve, t, 1)',
    '                local rot = 0',
    '                if d.spinAlign == "tangent" then rot = bezAngle(d.path, self.segs, t) * CONFIG.SPIN_SIGN end',
    '                rot = rot + curveAt(d.spinCurve, t, 0)',
    '                local alpha = curveAt(d.alphaCurve, t, 1)',
    '                if copy.isTrail then',
    '                    local n = 1 + (d.trailCount or 0)',
    '                    alpha = alpha * (1 - 0.55 * ((i - 1) / math.max(1, n - 1)))',
    '                end',
    '                local k = t',
    '                local r = mix(d.startColor[1], d.endColor[1], k)',
    '                local g = mix(d.startColor[2], d.endColor[2], k)',
    '                local b = mix(d.startColor[3], d.endColor[3], k)',
    '                local ca = mix(d.startColor[4], d.endColor[4], k) * alpha',
    '                c:SetAnchoredPosition(x, y)',
    '                c:SetSizeDelta(w, h)',
    '                c:SetLocalRotation(0, 0, rot)',
    '                c.imageColor = Color.FromRGBA(r, g, b, ca * 255)',
    '                if not c.visible then c:SetVisible(true) end',
    '            end',
    '        end',
    '    end',
    '    function self:Hide()',
    '        for i = 1, #self.copies do',
    '            local c = self.copies[i].ctrl',
    '            if c.alive and c.visible then c:SetVisible(false) end',
    '        end',
    '    end',
    '    function self:Destroy()',
    '        self.alive = false',
    '        for i = 1, #self.copies do',
    '            local c = self.copies[i].ctrl',
    '            if c.alive then pcall(function() game.DestroyClientUIControl(c) end) end',
    '        end',
    '    end',
    '    return self',
    'end',
  ].join('\n');
}

/** 宿主绑定（OnStart/OnUpdate + 晚建 + 稳态诊断）。**生成器自有**。 */
function spriteBindingLua() {
  return [
    '-- ============================================================================',
    '-- 宿主绑定（OnStart / OnUpdate / OnDisable / OnEnable / OnDestroy）',
    '--   晚建：`frameCount >= CREATE_AFTER_FRAMES` 才建控件（设 0 会被后建的全屏背景盖住）',
    '--   时钟：`age` 累加 `dt`；播完（DURATION）按 LOOP 决定重头还是隐藏',
    '-- ============================================================================',
    'local sprites = {}',
    'local started = false',
    'local finished = false',
    'local frameCount = 0',
    'local totalAge = 0',
    'local diagSteadyDone = false',
    'local lastUpdateError = nil',
    '',
    'local function createImage(parent)',
    '    return game.InstantiateClientUIControl(CONFIG.TEMPLATE_INDEX, parent)',
    'end',
    '',
    'local function buildAll()',
    '    local parent = script.object',
    '    if parent == nil then error("script.object 是 nil —— 找不到挂载点，无法建图元", 0) end',
    '    local n = 0',
    '    for i, def in ipairs(DATA.sprites) do',
    '        sprites[i] = makeSprite(def, parent, createImage)',
    '        n = n + #sprites[i].copies',
    '    end',
    '    print("[图元:"..PRESET.."] 建成 层="..#sprites.." 控件="..n.."（一个形状 = 一个控件 + 残影）")',
    'end',
    '',
    'function OnStart()',
    '    requireHandover("TEMPLATE_INDEX", CONFIG.TEMPLATE_INDEX)',
    '    requireHandover("CONTAINER_INDEX", CONFIG.CONTAINER_INDEX)',
    '    for i, def in ipairs(DATA.sprites) do',
    '        requireHandover("IMAGE_ID(第"..i.."层)", def.imageId)',
    '    end',
    '    print("[图元:"..PRESET.."] ver="..VERSION.." 画布="..CONFIG.WIDTH.."x"..CONFIG.HEIGHT',
    '        .." 时长="..CONFIG.DURATION.."s 循环="..tostring(CONFIG.LOOP))',
    '    local ok, err = pcall(function() script:EnableUpdate(true) end)',
    '    if not ok then error("EnableUpdate 失败（没有它 OnUpdate 永不触发）："..tostring(err), 0) end',
    'end',
    '',
    'function OnUpdate(dt)',
    '    if lastUpdateError ~= nil then return end',
    '    local ok, err = pcall(function()',
    '        frameCount = frameCount + 1',
    '        if not started then',
    '            if frameCount < CONFIG.CREATE_AFTER_FRAMES then return end',
    '            buildAll()',
    '            started = true',
    '        end',
    '        if finished then return end',
    '        local d = (type(dt) == "number" and dt == dt and dt > 0) and dt or 0.0333333',
    '        totalAge = totalAge + d',
    '        for i = 1, #sprites do sprites[i]:Update(d) end',
    '        -- 稳态诊断（只打一次）：回答"建了几层、几段路径、走了多久"',
    '        if not diagSteadyDone and CONFIG.DIAG_STEADY_AT > 0 and totalAge >= CONFIG.DIAG_STEADY_AT then',
    '            diagSteadyDone = true',
    '            for i = 1, #sprites do',
    '                local sp = sprites[i]',
    '                print(string.format("[图元:"..PRESET.."/diag] 第%d层 path=%d点/%d段 残影=%d age=%.2fs",',
    '                    i, #sp.def.path, sp.segs, #sp.copies - 1, sp.age))',
    '            end',
    '        end',
    '        if totalAge >= CONFIG.DURATION then',
    '            if CONFIG.LOOP then',
    '                totalAge = 0',
    '                for i = 1, #sprites do sprites[i].age = 0 end',
    '            else',
    '                finished = true',
    '                if CONFIG.HIDE_WHEN_DONE then',
    '                    for i = 1, #sprites do sprites[i]:Hide() end',
    '                end',
    '                print("[图元:"..PRESET.."] 播完（"..CONFIG.DURATION.."s）")',
    '            end',
    '        end',
    '    end)',
    '    if not ok then',
    '        lastUpdateError = tostring(err)',
    '        print("[图元:"..PRESET.."] OnUpdate 首错: "..lastUpdateError)',
    '    end',
    'end',
    '',
    'function OnDisable() for i = 1, #sprites do sprites[i]:Hide() end end',
    'function OnEnable() end',
    'function OnDestroy() for i = 1, #sprites do sprites[i]:Destroy() end end',
    'function OnInit() end',
  ].join('\n');
}
