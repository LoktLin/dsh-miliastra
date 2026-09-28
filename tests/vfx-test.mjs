#!/usr/bin/env node
/**
 * `miliastra_gen op=vfx-lua`（**粒子特效 → 可部署 Lua**）测试：纯函数层 + Lua 层 + 工具层 + **模拟器端到端**。
 *
 * ★ 为什么要有它 / **修前为什么红**（一条条说清）：
 *   ① 纯函数层：四个（现 13 个）预设的字段集是 `UGCTools.UIParticles@1`，**少一个字段运行时 `validate()` 就报
 *      "越界数值"**（真机白跑一局）。修前没有这张断言表 ⇒ 漏字段只能靠试玩发现。
 *   ② **落程与池子**是"画面稀/断/空"的两个直接原因（`落程 < 屏高` ⇒ 落不到底；`池 < rate×lifetime.max`
 *      ⇒ 粒子抢槽位）。这两个数**必须能被机械算出来**，所以钉在测试里；修前只写在文档注释里，没人验。
 *   ③ 贝塞尔必要性：`motion="bezier"` 时 `speed`/`gravity` 不参与求值，但 `validate()` 仍要求它们在界内
 *      —— 修前照抄上游会写 `speed={min:0,max:0}`（合法），但**控制点全 0** 就会得到一条不动的直线，
 *      画面是"一堆点不动"，没有任何报错。
 *   ④ Lua 层：产物是**给真机跑的脚本**，所以本仓铁律逐条钉：`EnableUpdate` 必须在、`CREATE_AFTER_FRAMES`
 *      必须在（层级铁律）、`PARENT_BY_NAME` 必须在（借可见控件的容器）、`error(` 点名必须在、
 *      **`pcall` 掩盖报错的兜底不许有**、顶部 `CONFIG` 不许裸数字（值全走命名常量）。
 *      修前最大的坑是**驱动层被抄成第二份副本** ⇒ 这里用 `driverParity` 断言"生成物里的驱动层与真机定稿件逐字一致"。
 *   ⑤ 工具层：**真从 `TOOLS` 调 `execute`** —— 断言"默认出 Lua"、`output:"data"`、"未知 preset 报错并列出合法值"、
 *      "缺交接值 → `needsHandover`"、"`preset:'list'` 列表模式"。修前这些接线错一个就是**静默回落**。
 *   ⑥ 模拟器端到端：`op=bind` 把产物投进模拟器 → `op=frames` 比帧间像素差。这是唯一能证明
 *      "脚本真的跑起来了、控件真的建出来了、画面真的在动"的一步（**≠ 真机通过**）。
 *
 * ⚠️ 端到端会改**模拟器工作区**（`~/.dsh/miliastra/simulator`），不碰游戏存档、不碰活文件；
 *    产物 PNG 落在 `~/.dsh/miliastra/shots/`（**不删**）。想跳过端到端：`VFX_TEST_NO_SIM=1`。
 * 用法：`node tests/vfx-test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const failures = [];
const ok = (name, detail = '') => { pass += 1; console.log(`✓ ${name}${detail ? ' —— ' + detail : ''}`); };
const bad = (name, why) => { failures.push(`${name}: ${why}`); console.log(`✗ ${name} —— ${why}`); };

const queue = [];
function t(name, fn) { queue.push([name, fn]); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
function throws(fn, mustInclude, msg) {
  let err = null;
  try { fn(); } catch (e) { err = (e && e.message) || String(e); }
  assert(err !== null, (msg || '应当报错') + '，但没报错');
  if (mustInclude) assert(err.includes(mustInclude), `错误文案里没有「${mustInclude}」：${err}`);
  return err;
}

const { TOOLS, genOp } = await import('../index.js');
const presetMod = await import('../lib/vfx/presets.mjs');
const luaMod = await import('../lib/vfx/lua.mjs');
const {
  PRESET_NAMES, PRESETS, SCHEMA, CANVAS, BUDGET, listPresets, getPreset, buildPreset, presetToData,
  travelOf, poolOf, estimateOf, validateBuilt, simulatedImage, applyPathOverride, IMAGE_MEANING,
} = presetMod;
const { buildFxLua, findFxFixture, driverOf, versionOf } = luaMod;

const TMPL = 1073741868;
const BOX = 1073741863;
const okHandover = { templateIndex: TMPL, container: BOX, parentName: null };

/* ────────────────────────────── ① 纯函数层 ────────────────────────────── */

t('①a 13 个预设、id 唯一、与枚举一致', () => {
  eq(PRESET_NAMES.length, 13, '预设数');
  eq(PRESETS.map((p) => p.name), PRESET_NAMES, 'PRESETS 顺序要与 PRESET_NAMES 一致');
  eq(new Set(PRESET_NAMES).size, 13, 'id 不能重复');
  for (const p of listPresets()) {
    assert(typeof p.label === 'string' && p.label.length > 0, p.name + ' 缺中文名');
    assert(typeof p.summary === 'string' && p.summary.length > 8, p.name + ' 缺一句话语义');
    assert(p.emitters >= 1 && p.emitters <= 8, p.name + ' 发射器数必须在 1~8');
  }
});

t('①b 每个发射器的字段集完整（少一个运行时就会报"越界数值"）', () => {
  const required = ['id', 'name', 'enabled', 'seed', 'imageId', 'origin', 'delay', 'duration', 'loop',
    'maxParticles', 'rate', 'burst', 'lifetime', 'size', 'speed', 'angle', 'spread', 'rotation', 'spin',
    'shape', 'radius', 'width', 'height', 'motion', 'gravity', 'control1', 'control2', 'target',
    'sizeCurve', 'alphaCurve', 'startColor', 'endColor'];
  const bads = [];
  for (const name of PRESET_NAMES) {
    const built = buildPreset(name, { imageId: name === 'chest-collect' ? 101023 : undefined });
    for (const e of built.emitters) {
      for (const k of required) if (e[k] === undefined || e[k] === null) bads.push(`${name}/${e.id}.${k}`);
      if (e.enabled !== true) bads.push(`${name}/${e.id}.enabled 不是 true`);
      if (e.imageId !== (name === 'chest-collect' ? 101023 : built.imageId)) bads.push(`${name}/${e.id}.imageId 没接上`);
    }
  }
  eq(bads, [], '缺字段');
});

t('①c 曲线端点与严格递增（运行时会 reject）', () => {
  for (const name of PRESET_NAMES) {
    const built = buildPreset(name, { imageId: 101023 });
    for (const e of built.emitters) {
      for (const key of ['sizeCurve', 'alphaCurve']) {
        const k = e[key];
        assert(k[0].t === 0 && k[k.length - 1].t === 1, `${name}/${e.id}.${key} 端点必须是 0 与 1`);
        for (let i = 1; i < k.length; i += 1) assert(k[i].t > k[i - 1].t, `${name}/${e.id}.${key} 时间未严格递增`);
      }
    }
  }
});

t('①d validateBuilt 对 13 个预设全绿（数据层自检）', () => {
  for (const name of PRESET_NAMES) {
    const built = buildPreset(name, { imageId: 101023 });
    eq(validateBuilt(built), [], name + ' 数据层自检');
  }
});

t('①e 落程公式 = v·t + ½|g|t²（拿 star-rain A 层手算核对）', () => {
  const built = buildPreset('star-rain', {});
  const a = built.emitters[0];
  const v = (a.speed.min + a.speed.max) / 2;          // 285
  const life = (a.lifetime.min + a.lifetime.max) / 2; // 2.9
  const g = Math.abs(a.gravity.y);                    // 90
  const manual = v * life + 0.5 * g * life * life;
  assert(Math.abs(travelOf(a).travel - manual) < 1e-9, `落程不等于公式：${travelOf(a).travel} vs ${manual}`);
  assert(travelOf(a).travel > CANVAS.height, 'star-rain 应当能从顶落到底（≥1000px）');
});

t('①f 池子 = rate×lifetime.max，且 13 个预设都不缺粒', () => {
  const short = [];
  for (const name of PRESET_NAMES) {
    const built = buildPreset(name, { imageId: 101023 });
    for (const e of built.emitters) {
      const p = poolOf(e);
      eq(p.concurrent, Math.ceil(e.rate * e.lifetime.max), `${name}/${e.id} 并发数`);
      if (!p.enough) short.push(`${name}/${e.id}：要 ${p.concurrent}，给 ${e.maxParticles}`);
    }
  }
  eq(short, [], '这些层池子不够');
});

t('①g 控件预算：每层 ≤512、合计 ≤1024（上游自述预算）', () => {
  for (const name of PRESET_NAMES) {
    const est = estimateOf(buildPreset(name, { imageId: 101023 }));
    for (const l of est.layers) assert(l.pool.configured <= BUDGET.perEmitter, `${name} 每层超预算`);
    assert(est.controls <= BUDGET.total, `${name} 合计超预算：${est.controls}`);
  }
});

t('①h 出生区域全在画布内（±800 / ±500，容器会裁）', () => {
  const out = [];
  for (const name of PRESET_NAMES) {
    const est = estimateOf(buildPreset(name, { imageId: 101023 }));
    for (const l of est.layers) if (!l.spawnInside) out.push(`${name}/${l.id}`);
  }
  eq(out, [], '这些层出生区超框');
});

t('①i 数量分布：8 层只有孔雀两个；爆发/环境类都是 1~3 层', () => {
  const by = Object.fromEntries(listPresets().map((p) => [p.name, p.emitters]));
  eq(by['peacock-in'], 8, 'peacock-in 必须用满 8 层');
  eq(by['peacock-out'], 8, 'peacock-out 必须用满 8 层');
  eq(by['confetti-pop'], 3, 'confetti-pop 三层不同颜色');
  eq(by['star-rain'], 2, 'star-rain 两层');
  assert(Object.values(by).filter((n) => n === 8).length === 2, '只有孔雀两条是 8 层');
});

t('①j 孔雀开屏：8 个方向的点都在屏内，且 in/out 是同一组点反着走', () => {
  const pin = buildPreset('peacock-in', {});
  const pout = buildPreset('peacock-out', {});
  eq(pin.emitters.length, 8, 'in 层数');
  eq(pout.emitters.length, 8, 'out 层数');
  const starts = pin.emitters.map((e) => `${e.origin.x},${e.origin.y}`);
  const targets = pout.emitters.map((e) => `${e.target.x},${e.target.y}`);
  eq(starts, targets, 'in 的起点集合要等于 out 的终点集合');
  for (const e of pin.emitters) eq({ x: e.target.x, y: e.target.y }, { x: 0, y: 0 }, e.id + ' in 的终点必须是中心');
  for (const e of pout.emitters) eq({ x: e.origin.x, y: e.origin.y }, { x: 0, y: 0 }, e.id + ' out 的起点必须是中心');
  for (const e of pin.emitters) {
    eq(e.motion, 'bezier', e.id + ' motion');
    assert(Math.abs(e.origin.x) <= 800 && Math.abs(e.origin.y) <= 500, e.id + ' 起点在屏内');
  }
});

t('①k 贝塞尔必要性：只给一个点也能生效，且 motion 被改成 bezier', () => {
  const built = buildPreset('coin-collect', {});
  const before = built.emitters[0].motion;
  eq(before, 'bezier', 'coin-collect 本来就是贝塞尔');
  const receipt = applyPathOverride(built, { target: { x: 0, y: 0 } }, 0);
  eq(built.emitters[0].target, { x: 0, y: 0 }, 'target 被覆盖');
  eq(receipt.target.from, 'arg', '来源应标 arg');
  eq(receipt.p1.from, 'preset', '没给的点沿用预设');
  eq(receipt.targetOnCanvas, { x: -180, y: -80 }, '画布绝对坐标 = 发射点 + 偏移');
});

t('①l 贝塞尔：给 velocity 预设打 path ⇒ motion 变 bezier（合法但会 warning）', () => {
  const built = buildPreset('snow-fall', {});
  applyPathOverride(built, { p1: { x: 0, y: 100 } }, 0);
  eq(built.emitters[0].motion, 'bezier', 'motion 被改成 bezier');
  const r = genOp({ op: 'vfx-lua', preset: 'snow-fall', templateIndex: TMPL, path: { target: { x: 0, y: -300 } } });
  assert(r.warnings.some((w) => w.includes('path')), '应当有一条 path 改变运动模型的 warning');
});

t('①m path 参数错要报错（不猜、不静默回落）', () => {
  const r = genOp({ op: 'vfx-lua', preset: 'coin-collect', templateIndex: TMPL, path: { p1: { x: 'a' } } });
  assert(r.ok === false, '应当 ok:false');
  assert(r.error.includes('path.p1'), '错误要点名 path.p1：' + r.error);
  const r2 = genOp({ op: 'vfx-lua', preset: 'coin-collect', templateIndex: TMPL, path: {} });
  assert(r2.ok === false && r2.error.includes('一个点都没给'), '空 path 要报错');
});

t('①n 图片是独立维度：previewImageId 只影响生成物，回执两个都回显', () => {
  const r = genOp({ op: 'vfx-lua', preset: 'coin-collect', imageId: 101023, previewImageId: 100002, ...okHandover });
  assert(r.ok === true, '应当成功：' + (r.error || ''));
  eq(r.image.id, 101023, '真机用号');
  eq(r.image.previewImageId, 100002, '预览用号');
  eq(r.image.emittedImageId, 100002, '生成物里写的是预览号');
  eq(r.image.layered, true, 'layered 标记');
  assert(/    IMAGE_ID = 100002,/.test(r.lua), '产物里 IMAGE_ID 应当是预览号');
  assert(r.warnings.some((w) => w.includes('两层贴图号')), '应当有分层 warning');
});

t('①o 非几何号（真机素材号）不再被当成"非法"，只提示模拟器画不出', () => {
  const r = genOp({ op: 'vfx-lua', preset: 'star-rain', imageId: 101023, ...okHandover });
  assert(r.ok === true, '真机素材号必须能生成：' + (r.error || ''));
  assert(r.warnings.some((w) => w.includes('缺图')), '要提示模拟器画成缺图');
  assert(!r.warnings.some((w) => w.includes('不在基础形状号段')), '不许再说"号段非法"');
  assert(r.unverified.some((u) => u.includes('1543')), 'unverified 要说清真机可用全部素材号');
});

t('①p simulatedImage：只有 100001~100006 在模拟器里可渲染', () => {
  for (const id of [100001, 100002, 100003, 100004, 100005, 100006]) {
    eq(simulatedImage({ emitters: [{ imageId: id }] }).renderable, true, String(id));
  }
  for (const id of [101023, 100007, 112042]) {
    eq(simulatedImage({ emitters: [{ imageId: id }] }).renderable, false, String(id));
  }
  eq(IMAGE_MEANING[100005], '五角星', '100005 是五角星');
});

t('①q chest-collect：与 coin-collect 同参数、但贴图号必须由创作者给', () => {
  const chest = buildPreset('chest-collect', {});
  const coin = buildPreset('coin-collect', {});
  eq(chest.imageId, null, 'chest-collect 默认 imageId 必须是 null（不猜）');
  eq(chest.emitters.map((e) => e.origin), coin.emitters.map((e) => e.origin), '起点与金币汇聚一致');
  eq(chest.emitters.map((e) => e.target), coin.emitters.map((e) => e.target), '终点一致');
  eq(chest.drawsFromCreator, undefined, '不该有这个键');
  eq(chest.imageIdFromCreator, true, '要标"号由创作者给"');
  const r = genOp({ op: 'vfx-lua', preset: 'chest-collect', templateIndex: TMPL });
  assert(r.ok === false && r.needsImageId === true, '不传 imageId 必须 ok:false + needsImageId');
  assert(r.error.includes('必须由创作者给'), '文案要点明：' + r.error);
  const r2 = genOp({ op: 'vfx-lua', preset: 'chest-collect', imageId: 101023, ...okHandover });
  assert(r2.ok === true, '给了号就能生成：' + (r2.error || ''));
});

t('①r presetToData 产出的 schema 与字段集正确', () => {
  const d = presetToData(buildPreset('star-rain', {}));
  eq(d.schema, SCHEMA, 'schema');
  eq(d.width, CANVAS.width, 'width');
  eq(d.height, CANVAS.height, 'height');
  eq(d.previewDuration, buildPreset('star-rain', {}).duration, 'previewDuration');
  eq(d.emitters.length, 2, '发射器数');
});

/* ────────────────────────────── ② Lua 层 ────────────────────────────── */

const luaOf = (name, extra = {}) => genOp(Object.assign({ op: 'vfx-lua', preset: name, ...okHandover }, extra));

t('②a 默认一次调用就出可部署 Lua（不是数据模型）', () => {
  const r = luaOf('star-rain');
  assert(r.ok === true, '应当成功');
  assert(typeof r.lua === 'string' && r.lua.length > 1000, '要有 lua 正文');
  assert(r.luaBytes > 1000 && r.lines > 100, '要报字节数与行数');
  assert(r.nextStep.includes('level') && r.nextStep.includes('file'), 'nextStep 要提醒 deploy 显式传 level+file');
  assert(r.nextStep.includes('存一次盘'), 'nextStep 要提醒在编辑器存盘');
});

t('②b 铁律：EnableUpdate / CREATE_AFTER_FRAMES / PARENT_BY_NAME / error 点名都在', () => {
  const lua = luaOf('star-rain').lua;
  for (const needle of ['script:EnableUpdate(true)', 'CREATE_AFTER_FRAMES = 30', 'PARENT_BY_NAME', 'error(',
    'requireHandover', 'local Runtime = (function()', 'diag', 'ver=']) {
    assert(lua.includes(needle), '产物里缺：' + needle);
  }
});

t('②c 产物不许有 pcall 掩盖报错的兜底、不许有静默 return', () => {
  const lua = luaOf('peacock-in').lua;
  /*
   * 驱动层**允许** pcall —— 它把异常原样 `print` 出来**再冒泡**（这正是"不许掩盖"的实现）。
   * 所以这里钉的不是"有没有 pcall"，而是上游那套**吞掉**的写法：
   *   · `safely(fn)` 包装（上游导出脚本用它把异常压成 failed 标志后静默 return）；
   *   · 回滚路径必须把原异常交回去（`error(tostring(message)`）。
   */
  assert(!/safely\s*\(/.test(lua), '不许出现上游那套 safely() 包装（吞异常）');
  assert(!/\bFAULT@/.test(lua), '不许往画面上塞诊断串');
  assert(lua.includes('error(tostring(message)'), '回滚失败要带原异常冒泡');
  assert(/if not cleaned then print\("\[特效/.test(lua), '清理失败必须 print 出原文');
  assert(lua.includes('缺少交接值 CONFIG.'), '缺交接值要 error 点名');
});

t('②d 顶部 CONFIG 不许裸数字（值必须走命名常量）', () => {
  const lua = luaOf('coin-collect').lua;
  const config = lua.slice(lua.indexOf('local CONFIG = {'), lua.indexOf('\n}', lua.indexOf('local CONFIG = {')));
  const bare = config.split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter((line) => /=\s*-?\d/.test(line) && !/^--/.test(line) && !/^[A-Z0-9_]+\s*=/.test(line));
  eq(bare, [], 'CONFIG 里有裸数字且没命名：\n' + bare.join('\n'));
  // 命名常量里有数字是正常的（那正是"取值单点"）；这里断言的是"键名 + 值"成对出现
  assert(/    IMAGE_ID = 100002,/.test(config), 'IMAGE_ID 应当写成 命名常量 = 值');
  assert(/    PARTICLES_PER_EMITTER = 60,/.test(config), '每层池要写成命名常量');
});

t('②e 数据层不允许出现裸数字（全部走 CONFIG.*；只有 seed 例外）', () => {
  const lua = luaOf('confetti-pop').lua;
  const start = lua.indexOf('local DATA = {');
  const end = lua.indexOf('\n}\n', start);
  const data = lua.slice(start, end);
  /*
   * `seed` 是**唯一**允许的字面数字：它是"这层粒子的身份"（固定随机序列，换了就不是同一个效果），
   * 不是可调参数 —— 调它等于换效果。其余一切（坐标/速度/寿命/曲线/颜色）都必须走 `CONFIG.*`，
   * 否则"只改 CONFIG 就能换效果"这条就不成立了。
   */
  const numeric = data.split('\n')
    .filter((line) => /[=:]\s*-?\d/.test(line) && !/^\s*--/.test(line) && !/\["seed"\]/.test(line));
  eq(numeric, [], 'DATA 块里出现了字面数字：\n' + numeric.join('\n'));
  assert(data.includes('CONFIG.IMAGE_ID') && data.includes('CONFIG.PARTICLES_PER_EMITTER'), 'DATA 要引 CONFIG');
});

t('②f 驱动层与真机定稿件**逐字一致**（driverParity；只允许一处有据可查的替换）', () => {
  const fixture = findFxFixture(null);
  assert(fixture !== null, '找不到真机定稿件 —— 生成器的驱动层没有来源');
  const drv = driverOf(fixture);
  const r = luaOf('star-rain');
  assert(r.lua.includes(drv.runtime), 'Runtime 块与定稿件不一致');
  assert(r.lua.includes(drv.guard), 'requireHandover 段与定稿件不一致');
  const hostInGen = drv.host.replace(/\[特效fx/g, '[特效:star-rain')
    .replace('requireHandover("DURATION", CONFIG.DURATION)', 'requirePositiveNumber("DURATION", CONFIG.DURATION)');
  assert(r.lua.includes(hostInGen), '宿主绑定块与定稿件不一致（只允许日志标签 + DURATION 校验这一处替换）');
  // 版本行：ver= 必须在 print 里
  assert(r.lua.includes(`local VERSION = "${versionOf(buildPreset('star-rain', {}))}"`), 'VERSION 行要对');
});

t('②f2 那一处替换：DURATION 可以是小数（上游 coins = 2.5 就是靠它才跑得起来）', () => {
  const r = luaOf('coin-collect');
  eq(r.driver.driverPatches, undefined, '工具回执不暴露内部字段也无所谓');
  assert(r.lua.includes('requirePositiveNumber("DURATION", CONFIG.DURATION)'), '替换必须在产物里');
  assert(!r.lua.includes('requireHandover("DURATION", CONFIG.DURATION)'), '原句必须已被换掉');
  assert(r.lua.includes('local function requirePositiveNumber'), '替换用的校验器要在产物里');
  assert(r.lua.includes('必须是正数（秒）'), '文案要说明是秒');
  assert(r.lua.includes('    DURATION = 2.5,'), 'coin-collect 的时长是小数字面量');
});

t('②g 每层的 CONFIG 字段与 DATA 引用一一对应（不接上就是静默失效）', () => {
  const lua = luaOf('peacock-in').lua;
  const config = lua.slice(lua.indexOf('local CONFIG = {'), lua.indexOf('\n}', lua.indexOf('local CONFIG = {')));
  // 层前缀：A/B/C…（第 1 层是 A —— 与格式文档 §5.0 属性表里的叫法一致）
  const PREFIXES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  for (let i = 0; i < 8; i += 1) {
    const p = PREFIXES[i];
    for (const suffix of ['ORIGIN_X', 'ORIGIN_Y', 'RATE', 'LIFETIME_MAX', 'SIZE_CURVE', 'ALPHA_CURVE', 'START_COLOR', 'END_COLOR']) {
      assert(config.includes(`${p}_${suffix} =`), `CONFIG 缺 ${p}_${suffix}`);
      assert(lua.includes(`CONFIG.${p}_${suffix}`), `DATA 没引用 CONFIG.${p}_${suffix}`);
    }
  }
});

t('②h 落程/池子核算写进产物注释（人读产物就能核对）', () => {
  const lua = luaOf('star-rain').lua;
  assert(/-- 落程核算：/.test(lua), '要有落程注释');
  assert(/需要池 ≥ rate×lifetime\.max/.test(lua), '要有池子注释');
  assert(/    IMAGE_ID = 100005,/.test(lua), '贴图号写在 CONFIG');
});

t('②i 贝塞尔预设的产物带"钢笔"口径注释（相对发射点 + 时间归一化）', () => {
  const lua = luaOf('coin-collect').lua;
  assert(lua.includes('相对发射点'), '要说明控制点是相对发射点的偏移');
  assert(lua.includes('时间归一化'), '要说明 t 是时间归一化（不是弧长匀速）');
  assert(lua.includes('画布绝对位置'), '要给出终点的画布绝对坐标');
});

t('②j cheat：8 层产物行数明显多于 2 层（换 8 层确实多出 6 段）', () => {
  const two = luaOf('star-rain').lines;
  const eight = luaOf('peacock-in').lines;
  assert(eight > two + 300, `8 层应当多出 300+ 行：2 层 ${two} / 8 层 ${eight}`);
});

/* ────────────────────────────── ③ 工具层 ────────────────────────────── */

t('③a 工具接线：默认出 Lua（真的从 TOOLS 调）', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const r = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX });
  assert(r.ok === true && typeof r.lua === 'string', '应当出 Lua');
  assert(r.preset.name === 'hit-spark' && r.emitterCount === 2, '回执要带预设信息');
  assert(r.pool && r.pool.layers.length === 2, '回执要带池子核算');
  assert(r.estimate && r.estimate.layers.length === 2, '回执要带落程核算');
  assert(Array.isArray(r.unverified) && r.unverified.length >= 3, '未验证项要列出来');
  assert(typeof r.doc === 'string' && r.doc.includes('§5'), '回执要带文档指针');
});

t('③b output=data 给结构化数据（不含 Lua）', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const r = await gen.execute({ op: 'vfx-lua', preset: 'coin-collect', output: 'data' });
  assert(r.ok === true, 'data 应当成功');
  assert(r.lua === undefined, 'data 不该带 lua');
  eq(r.emitters.length, 2, '要带发射器全文');
  assert(r.estimate.layers[0].bezierLength > 0, '贝塞尔要报折线长');
});

t('③c output 给错要明确报错', () => {
  const err = throws(() => genOp({ op: 'vfx-lua', preset: 'star-rain', output: 'xml' }), 'output 只能是 lua / data');
  assert(err.includes('xml'), '错误里要带上收到的值');
});

t('③d 未知 preset：报错 + 列出全部合法 id + 指路 preset:"list"', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const r = await gen.execute({ op: 'vfx-lua', preset: 'snow' });
  assert(r.ok === false && typeof r.error === 'string', '应当 ok:false');
  for (const id of PRESET_NAMES) assert(r.error.includes(id) || (r.presets || []).some((p) => p.id === id), '要列出 ' + id);
  assert(r.error.includes('preset:"list"'), '要指路 preset:"list"');
  assert(r.error.includes('snow-fall'), '要给上游同名的映射提示');
});

t('③e 缺交接值：ok:false + needsHandover（文案含"别自己编"）', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain' });
  if (r.ok === true) {
    // 本机 .gil 恰好有唯一候选 ⇒ 自动采用（这是设计允许的），那就断言"确实采用了唯一候选"
    assert(r.target && r.target.templateIndex > 0, '自动采用时也必须给出实际用的模板号');
    ok('', '（本机 .gil 有唯一候选，自动采用）');
    return;
  }
  assert(Array.isArray(r.needsHandover) && r.needsHandover.some((x) => x.param === 'templateIndex'), '要 needsHandover.templateIndex');
  assert(r.error.includes('别自己编索引') || JSON.stringify(r.needsHandover).includes('别自己编'), '文案要含"别自己编"');
  assert(r.lua === undefined, '缺交接值不许给 lua');
});

t('③f preset:"list"：第 2 层按需枚举（13 条 + 关键参数 + 控件核算），summaryOnly 只留 id/中文名', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const full = await gen.execute({ op: 'vfx-lua', preset: 'list' });
  assert(full.ok === true && full.listMode === true, 'list 模式');
  eq(full.count, 13, '数量');
  eq(full.presets.length, 13, '条目数');
  for (const p of full.presets) {
    assert(p.id && p.nameZh && p.oneLiner, '每条要有 id / 中文名 / 一句话');
    assert(p.budget && typeof p.budget.controls === 'number', '每条要有控件核算');
    assert(p.keyParams && typeof p.keyParams === 'object', '每条要有关键参数');
  }
  const slim = await gen.execute({ op: 'vfx-lua', preset: 'list', summaryOnly: true });
  assert(slim.presetsOmitted === true, 'summaryOnly 要标 presetsOmitted');
  assert(slim.presets.length === 13 && slim.presets[0].keyParams === undefined, 'summaryOnly 只留 id/中文名');
  assert(JSON.stringify(slim).length < JSON.stringify(full).length / 3, 'summaryOnly 要真的省体积');
});

t('③g 没传 preset：不默默用默认，回 needsPreset + 简版清单', async () => {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const r = await gen.execute({ op: 'vfx-lua' });
  assert(r.ok === true && r.needsPreset === true, '要标 needsPreset');
  eq(r.count, 13, '要给简版清单');
  assert(r.nextStep.includes('preset'), '要指路下一步');
});

t('③h 其它 op 一个都没被碰坏（未知 op 报错里列出四个）', () => {
  const err = throws(() => genOp({ op: 'nope' }), '没有这个 op');
  for (const o of ['text-gradient', 'struct-json', 'pixel-art', 'vfx-lua']) assert(err.includes(o), '要列出 ' + o);
});

/* ─────────────────── ④ 模拟器端到端（可关：VFX_TEST_NO_SIM=1） ─────────────────── */

if (process.env.VFX_TEST_NO_SIM !== '1') {
  const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
  const sim = TOOLS.find((x) => x.name === 'miliastra_sim');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-sim-'));
  const rows = [];
  for (const name of PRESET_NAMES) {
    const imageId = name === 'chest-collect' ? 101023 : undefined;
    const built = await gen.execute({ op: 'vfx-lua', preset: name, imageId, previewImageId: 100002, templateIndex: TMPL, container: BOX });
    if (built.ok !== true) { bad('④ ' + name, '生成失败：' + built.error); continue; }
    const file = path.join(tmp, name + '.lua');
    fs.writeFileSync(file, built.lua, 'utf8');
    const bound = await sim.execute({
      op: 'bind', fresh: true, run: true, settleSec: 3,
      scripts: [{ path: name + '.lua', sourceFrom: file }],
      templates: [{ guid: TMPL, kind: 'image' }], containerId: BOX,
    });
    if (bound.bound !== true) { bad('④ ' + name, 'bind 失败'); continue; }
    const errs = (bound.run.logs || []).filter((l) => l.level === 'lua-error');
    const controls = Number(bound.run.controlCount) || 0;
    const fr = await sim.execute({ op: 'frames', frames: [1, 2], label: 'vfx-' + name });
    const diff = (fr.diffs && fr.diffs[0]) || {};
    const row = {
      preset: name, controls, want: built.pool.controls, grew: controls > 1,
      changedPixels: diff.changedPixels, identical: diff.identical,
      png: fr.frames && fr.frames.length ? fr.frames[fr.frames.length - 1].file : null,
      luaErrors: errs.length, logLines: (bound.run.logs || []).length,
    };
    rows.push(row);
    const tag = `④ ${name}：控件 ${controls}（生成物池 ${built.pool.controls}）· 帧间差 ${diff.changedPixels} 像素 · 脚本报错 ${errs.length}`;
    if (errs.length) bad(tag, errs[0].text);
    else if (controls <= 1) bad(tag, '一个控件都没建出来');
    else if (diff.identical === true || !(diff.changedPixels > 0)) bad(tag, '帧间像素差为 0（画面没动）');
    else ok(tag, row.png || '');
    // 断言"控件数 ≥ 生成物池"（脚本会把池建满；容器本身 +1）
    if (controls > 1 && controls < built.pool.controls) bad('④ ' + name + ' 控件数不足', `建出 ${controls} < 池 ${built.pool.controls}`);
  }
  fs.writeFileSync(path.join(tmp, '_rows.json'), JSON.stringify(rows, null, 1));
  console.log('\n④ 模拟器端到端汇总（PNG 在 ~/.dsh/miliastra/shots/，不删）：');
  console.log('   preset           控件数  池  帧间差   PNG');
  for (const r of rows) {
    console.log('   ' + String(r.preset).padEnd(15) + String(r.controls).padEnd(7) + String(r.want).padEnd(5)
      + String(r.changedPixels).padEnd(8) + (r.png || '').replace(/^.*shots\\/, ''));
  }
  console.log('   临时工程目录：' + tmp);
}

/* ────────────────────────────── 收尾 ────────────────────────────── */
for (const [name, fn] of queue) {
  try { await fn(); ok(name); } catch (e) { bad(name, (e && e.message) || String(e)); }
}
console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
