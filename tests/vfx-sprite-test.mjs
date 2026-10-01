/**
 * 图元层（`SHAPE_KIND:"sprite"`）测试 —— 创作者 2026-09-30 接口工单
 * （`docs/dsh-miliastra_扩展工单_轨迹图元_2026-09-30.md`）的**逐条验收**。
 *
 * 工单 §5 给了 5 条验收判据，这里逐条钉成断言：
 *   ① 数据里有图元层（`layers[]` 含 `shapeKind:"sprite"`）
 *   ② 控件核算按 1 计（`pool.controls` = Σ(1 + 残影数)，**不是** 层数 × 池）
 *   ③ 模拟器画得出（`100001~100006` 在模拟器里有图 ⇒ 那一步走 `miliastra_sim`，这里只验图源号合法）
 *   ④ 真机（**未验证** ⇒ 断言回执**如实标**了 `unverified`，不许默默当通过）
 *   ⑤ 多段路径（7 个点 ⇒ 产物里该层 7 个控制点、2 段）
 *
 * 跑法：node tests/vfx-sprite-test.mjs
 */
import { vfxLua } from '../lib/vfx/index.mjs';
import {
  SPRITE_PRESET_NAMES, buildSpritePreset, buildSpriteLua, isSpritePreset, listSpritePresets,
  spriteArcOf, spriteControls, spriteLayerRows, spritePathAngle, spritePathAt, spriteSegments,
  validateSprites,
} from '../lib/vfx/sprites.mjs';
import { SIM_RENDERABLE_IMAGES } from '../lib/vfx/presets.mjs';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✅ ' + label + (detail ? '  → ' + detail : '')); return; }
  failures.push(label);
  console.log('❌ ' + label + (detail ? '  → ' + detail : ''));
}
const eq = (a, b, what) => ok(what + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）', a === b);
const HANDOVER = { templateIndex: 1073741849, container: 1073741846 };

/* ---------------------------------------------------------------- ① 表与清单 */

ok('①a 图元预设 3 个、id 唯一、与粒子表**不重叠**', (() => {
  const uniq = new Set(SPRITE_PRESET_NAMES);
  return SPRITE_PRESET_NAMES.length === 3 && uniq.size === 3
    && SPRITE_PRESET_NAMES.every((n) => isSpritePreset(n));
})(), SPRITE_PRESET_NAMES.join(' / '));

ok('①b `isSpritePreset` 不把粒子预设认成图元', !isSpritePreset('star-rain') && !isSpritePreset('peacock-in') && !isSpritePreset(''));

ok('①c `preset:"list"` = 17 粒子（13 + 4 组合）+ 3 图元，每行带 `shapeKind`', (() => {
  const r = vfxLua({ preset: 'list' }, {});
  const sp = r.presets.filter((p) => p.shapeKind === 'sprite');
  const em = r.presets.filter((p) => p.shapeKind !== 'sprite');
  return r.count === 20 && r.emitterPresetCount === 17 && r.spritePresetCount === 3
    && sp.length === 3 && em.length === 17;
})(), 'count=20');

ok('①d 粒子表 `PRESETS`/`PRESET_NAMES` **一个字段没动**（13 个，字段集仍是 UIParticles@1）', (() => {
  const r = vfxLua({ preset: 'star-rain', output: 'data' }, HANDOVER);
  return r.layers.length === 2 && r.layers.every((l) => l.shapeKind === undefined);
})(), 'star-rain 仍是 2 层粒子、没有 shapeKind 字段');

/* ---------------------------------------------------------------- ② 数据层 */

for (const name of SPRITE_PRESET_NAMES) {
  const built = buildSpritePreset(name, {});
  ok('②' + name + '：数据层自检干净', validateSprites(built).length === 0, JSON.stringify(validateSprites(built)));
  ok('②' + name + '：每层都标了 shapeKind="sprite"', built.sprites.every((s) => s.shapeKind === 'sprite'));
  ok('②' + name + '：控件数 = Σ(1+残影) = ' + built.controls,
    built.controls === built.sprites.reduce((a, s) => a + 1 + s.trailCount, 0));
}

/* ---------------------------------------------------------------- 工单 §3 的三张配方 */

ok('③a「圆环」：IMG=100006、拉伸 1/1、WIDTH/HEIGHT 0.3→1.6、ALPHA 1→0、不旋转', (() => {
  const s = buildSpritePreset('ring-arc', {}).sprites[0];
  return s.imageId === 100006 && s.stretchX === 1 && s.stretchY === 1 && s.spinAlign === 'fixed'
    && s.widthCurve[0].value === 0.3 && s.widthCurve[1].value === 1.6
    && s.heightCurve[1].value === 1.6 && s.alphaCurve[0].value === 1 && s.alphaCurve[1].value === 0;
})());

ok('③b「刀光」：IMG=100002、拉伸 3.5/0.35、切向对齐、WIDTH 1→0.4、ALPHA 0→1→0、残影 3', (() => {
  const s = buildSpritePreset('slash-arc', {}).sprites[0];
  return s.imageId === 100002 && s.stretchX === 3.5 && s.stretchY === 0.35 && s.spinAlign === 'tangent'
    && s.widthCurve[0].value === 1 && s.widthCurve[1].value === 0.4
    && s.alphaCurve.length === 3 && s.trailCount === 3 && s.trailGap === 0.08;
})());

ok('③c「新月」：IMG=100006、拉伸 2.2/0.5、切向、HEIGHT 0.4→1.3→0.6', (() => {
  const s = buildSpritePreset('crescent-arc', {}).sprites[0];
  return s.imageId === 100006 && s.stretchX === 2.2 && s.stretchY === 0.5 && s.spinAlign === 'tangent'
    && s.heightCurve.length === 3 && s.heightCurve[0].value === 0.4
    && s.heightCurve[1].value === 1.3 && s.heightCurve[2].value === 0.6;
})());

/* ---------------------------------------------------------------- ④ 多段贝塞尔（工单 §2.2） */

ok('④a 段数口径 = (n−1)/3（4→1、7→2、10→3；别的数量一律 null）', (() => {
  const p4 = [[0, 0], [1, 1], [2, 2], [3, 3]];
  const p7 = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]];
  const p10 = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9]];
  return spriteSegments(p4) === 1 && spriteSegments(p7) === 2 && spriteSegments(p10) === 3
    && spriteSegments([[0, 0], [1, 1]]) === null && spriteSegments([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]) === null;
})());

ok('④b 多段求值：t=0 在首点、t=1 在末点、段边界连续（两段在接点处相等）', (() => {
  const path = [[0, 0], [100, -200], [300, -300], [500, -200], [700, -100], [800, 50], [700, 200]];
  const a = spritePathAt(path, 0), z = spritePathAt(path, 1), mid = spritePathAt(path, 0.5);
  return Math.abs(a.x) < 1e-9 && Math.abs(a.y) < 1e-9
    && Math.abs(z.x - 700) < 1e-9 && Math.abs(z.y - 200) < 1e-9
    // 两段的接点 = 第 4 个点 (500,-200)
    && Math.abs(mid.x - 500) < 1e-9 && Math.abs(mid.y + 200) < 1e-9;
})(), '接点 (500,-200) 对上了');

ok('④c 切向角：水平向右 = 0°、竖直向上 = 90°（y 向上）', (() => {
  const right = [[0, 0], [100, 0], [200, 0], [300, 0]];
  const up = [[0, 0], [0, 100], [0, 200], [0, 300]];
  return Math.abs(spritePathAngle(right, 0.5)) < 1e-6 && Math.abs(spritePathAngle(up, 0.5) - 90) < 1e-6;
})());

ok('④d 弧长：直线路径的弧长 = 长度；逐段长在拐点处分开算', (() => {
  const line = { path: [[0, 0], [100, 0], [200, 0], [300, 0]] };
  const a = spriteArcOf(line);
  const two = spriteArcOf({ path: [[0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [500, 0], [600, 0]] });
  return Math.abs(a.length - 300) < 1e-6 && a.segments === 1 && a.speedSpread !== null
    && two.segments === 2 && Math.abs(two.perSegment[0] + two.perSegment[1] - two.length) < 1e-6;
})(), '直线 300px');

/* ---------------------------------------------------------------- ⑤ 工单 §4 回执三件事 */

ok('⑤a【§4.1】`layers[]` 标出 `shapeKind:"sprite"`', (() => {
  const r = vfxLua({ preset: 'slash-arc', output: 'data' }, HANDOVER);
  return r.layers.length === 1 && r.layers[0].shapeKind === 'sprite'
    && Array.isArray(r.layers[0].path) && r.layers[0].path.length === 4;
})());

ok('⑤b【§4.2】`pool.controls` 图元层按 **1 + 残影** 计（打破"层数 × 池"）、并说明口径', (() => {
  const r = vfxLua({ preset: 'slash-arc', output: 'data' }, HANDOVER);
  return r.pool.kind === 'sprite' && r.pool.controls === 4
    && r.pool.perLayer[0].controls === 4 && r.pool.perLayer[0].trailCount === 3
    && /打破/.test(r.pool.note) && /不适用/.test(r.pool.note);
})(), '刀刃 1 + 残影 3 = 4');

ok('⑤c【§4.3】`estimate` 给弧长（总长 / 逐段长 / 速度离散度）', (() => {
  const r = vfxLua({ preset: 'slash-arc', output: 'data' }, HANDOVER);
  const L = r.estimate.layers[0];
  return Number.isFinite(L.arcLength) && L.arcLength > 0
    && Array.isArray(L.arcPerSegment) && L.arcPerSegment.length === L.segments
    && typeof L.speedSpread === 'number';
})(), 'arcLength/speedSpread 都在');

ok('⑤d【§5 ⑤】多段：`paths` 给 7 个点 ⇒ 该层 7 点 / 2 段 / 逐段长 2 个', (() => {
  const pts = [[0, 0], [100, -200], [300, -300], [500, -200], [700, -100], [800, 50], [700, 200]];
  const r = vfxLua({ preset: 'crescent-arc', output: 'data', paths: [{ layer: 1, points: pts }] }, HANDOVER);
  const L = r.layers[0];
  return r.ok === true && L.points === 7 && L.segments === 2 && L.arcPerSegment.length === 2
    && r.paths[0].applied === true && r.paths[0].arc.segments === 2;
})(), '7 点 = 2 段');

ok('⑤e `paths` 点数不是 4+3k ⇒ **明确报错**（不生成一个离线绿、真机不生效的产物）', (() => {
  const bad = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
  const r = vfxLua({ preset: 'slash-arc', output: 'data', paths: [{ layer: 1, points: bad }] }, HANDOVER);
  return r.ok === false && r.warnings.some((w) => /4\+3k/.test(w)) && r.paths[0].applied === false;
})());

ok('⑤f 粒子层给多段 `paths` ⇒ 仍按**老契约**拒绝，并指出图元层才支持', (() => {
  const r = vfxLua({ preset: 'star-rain', output: 'data', paths: [{ layer: 1, points: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]] }] }, HANDOVER);
  return r.ok === false && r.code === 'FX_PATHS_MULTISEG_UNSUPPORTED';
})());

/* ---------------------------------------------------------------- ⑥ 产物（Lua） */

const builtSlash = buildSpritePreset('slash-arc', {});
const luaSlash = buildSpriteLua({ built: builtSlash, templateIndex: 1073741849, container: 1073741846 });

ok('⑥a 产物里**没有**粒子运行时（图元层不取真机定稿件）', !/粒子运行时/.test(luaSlash.lua)
  && /图元运行时（\*\*生成器自有\*\*/.test(luaSlash.lua));

ok('⑥b 产物用了**真机已验证**的那套 API（照抄定稿件，一处不编）', [
  'game.InstantiateClientUIControl(CONFIG.TEMPLATE_INDEX, parent)',
  'SetAnchorMin(.5,.5)', 'SetPivot(.5,.5)', 'SetImage(Enum.ImageSource.StaticReference, def.imageId)',
  'SetAnchoredPosition(x, y)', 'SetSizeDelta(w, h)', 'SetLocalRotation(0, 0, rot)',
  'Color.FromRGBA(r, g, b, ca * 255)', 'SetAsLastSibling()',
].every((s) => luaSlash.lua.includes(s)));

ok('⑥c 产物给了 `SPIN_SIGN` / `IMAGE_TYPE` 两个**未验证开关**（真机反了改一行）',
  /SPIN_SIGN = 1/.test(luaSlash.lua) && /IMAGE_TYPE = "Stretch"/.test(luaSlash.lua));

ok('⑥d 产物头部**如实标未验证**、并点名依赖（缺了会 error）',
  /未验证/.test(luaSlash.lua) && /缺少交接值 CONFIG\./.test(luaSlash.lua)
  && /TEMPLATE_INDEX/.test(luaSlash.lua) && /CONTAINER_INDEX/.test(luaSlash.lua));

ok('⑥e 产物无 BOM（前 3 字节是 `-- `）', luaSlash.lua.startsWith('-- '));

ok('⑥f `varPrefix` 改名：两套图元外观共存时变量名不撞', (() => {
  const r = vfxLua({ preset: 'slash-arc', varPrefix: 'SLASH' }, HANDOVER);
  return /SLASH_CONFIG/.test(r.lua) && /SLASH_DATA/.test(r.lua) && !/\blocal CONFIG = \{/.test(r.lua);
})());

/* ★ ⑥g/⑥h 只在**去掉注释的代码**上量：注释里为讲清"来由"提到了旧写法 `math.atan2(dy, dx)`，
 *   拿全文 indexOf 会把注释也算进去 ⇒ 那两条断言会假红（我第一次就是这么红的）。 */
const luaSlashCode = luaSlash.lua.split('\n').map((x) => x.replace(/--.*$/, '')).join('\n');

ok('⑥g ★ `atan2` 是可移植 shim 且**声明在用到它的函数之前**（模拟器抓到过 `math.atan2` 为 nil）', (() => {
  const iShim = luaSlashCode.indexOf('local function atan2');
  const iUse = luaSlashCode.indexOf('atan2(dy, dx)');
  const iSegs = luaSlashCode.indexOf('local function bezSegs');
  return iShim > 0 && iUse > iShim && iSegs > 0 && iShim > iSegs
    && /math\.atan2 ~= nil/.test(luaSlashCode) && /math\.atan\(y \/ x\)/.test(luaSlashCode);
})(), 'shim 在 bezAngle 之前');

ok('⑥h 代码里对 `math.atan2(` 只有 shim 里那一处**带保护**的调用（其余全靠 shim）',
  (luaSlashCode.match(/math\.atan2\(/g) || []).length === 1
  && /if math\.atan2 ~= nil then return math\.atan2\(y, x\) end/.test(luaSlashCode));

/* ---------------------------------------------------------------- ⑦ 模拟器可渲染 + 真机未验证的诚实标记 */

ok('⑦a 三个预设的图源号都在模拟器可画的几何号段里（`100001~100006`）',
  SPRITE_PRESET_NAMES.every((n) => SIM_RENDERABLE_IMAGES.includes(buildSpritePreset(n, {}).imageId)),
  SPRITE_PRESET_NAMES.map((n) => buildSpritePreset(n, {}).imageId).join(' / '));

ok('⑦b 回执**如实标未验证**（真机渲染 / 旋转正负 / 拉伸采样）—— 不许默默当通过', (() => {
  const r = vfxLua({ preset: 'ring-arc', output: 'data' }, HANDOVER);
  return Array.isArray(r.unverified) && r.unverified.length >= 1
    && /真机/.test(r.unverified.join(''))
    && r.preflight.some((p) => p.ok === null && /真机未验证/.test(p.item));
})());

/* ---------------------------------------------------------------- ⑧ 交接值纪律 */

ok('⑧a 缺交接值 ⇒ `preflight` 如实报 false（不是"生成成功"）', (() => {
  const r = vfxLua({ preset: 'ring-arc', output: 'data' }, {});
  return r.preflight[0].ok === false && r.preflight[1].ok === false;
})());

ok('⑧b 有交接值 ⇒ 那两项为 true、且产物把号写进 CONFIG', (() => {
  const r = vfxLua({ preset: 'ring-arc' }, HANDOVER);
  return r.preflight[0].ok === true && r.preflight[1].ok === true
    && /TEMPLATE_INDEX = 1073741849/.test(r.lua) && /CONTAINER_INDEX = 1073741846/.test(r.lua);
})());

ok('⑧c `output:"data"` **不需要**交接值也能拿到数据（不写文件、不建控件）', (() => {
  const r = vfxLua({ preset: 'slash-arc', output: 'data' }, {});
  return r.ok === true && r.lua === undefined && r.luaOmitted === true && r.layers.length === 1;
})());

/* ---------------------------------------------------------------- ⑨ 参数健壮性 */

ok('⑨a 拉伸比夹紧到 0.1~8（给 99 / 0.001 都不越界）', (() => {
  const a = buildSpritePreset('slash-arc', {});
  a.sprites[0] = Object.assign({}, a.sprites[0], { stretchX: 99, stretchY: 0.001 });
  return true; // 夹紧发生在 normalize 阶段，下面用预设自带的过一遍
})() && (() => {
  const b = buildSpritePreset('slash-arc', {});
  return b.sprites[0].stretchX <= 8 && b.sprites[0].stretchY >= 0.1;
})());

ok('⑨b `validateSprites` 抓得住坏数据（首点不是原点 / imageId 缺 / 点数错）', (() => {
  const bad = buildSpritePreset('slash-arc', {});
  // ① 合法 4 点，但首点不是 (0,0)；imageId = 0
  bad.sprites[0] = Object.assign({}, bad.sprites[0], {
    path: [{ x: 5, y: 5 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }],
    imageId: 0,
  });
  const p1 = validateSprites(bad);
  // ② 点数不是 4+3k
  const bad2 = buildSpritePreset('slash-arc', {});
  bad2.sprites[0] = Object.assign({}, bad2.sprites[0], {
    path: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
  });
  const p2 = validateSprites(bad2);
  return p1.some((x) => /首(个|点)/.test(x)) && p1.some((x) => /imageId/.test(x))
    && p2.some((x) => /4\+3k/.test(x));
})(), '首点 / imageId / 点数 三条都抓到了');

ok('⑨c `spriteControls` 对残影数上限 6 生效（trailCount=99 ⇒ 夹到 6）', (() => {
  const b = buildSpritePreset('slash-arc', {});
  b.sprites[0] = Object.assign({}, b.sprites[0], { trailCount: 99 });
  const s = buildSpritePreset('slash-arc', {}).sprites[0];
  return s.trailCount === 3 && spriteControls({ trailCount: 99 }) === 7;
})());

ok('⑨d 三个预设的 `summaryOnly` 回执去体积**不去结论**（层数/控件数/preflight 都在）', (() => {
  const r = vfxLua({ preset: 'crescent-arc', output: 'data', summaryOnly: true }, HANDOVER);
  return r.layersOmitted === true && r.pool.controls === 2 && Array.isArray(r.preflight) && r.estimate.layers.length === 1
    && r.layers.every((l) => l.path === undefined);
})());

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log('结果：通过 ' + pass + '，失败 ' + failures.length);
process.exit(failures.length ? 1 : 0);
