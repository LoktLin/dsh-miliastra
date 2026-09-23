/**
 * 关卡表受限解析 + 几何事实测试（lib/leveldata.mjs）
 *
 * 两层：
 *   ① 纯函数（合成 Lua 片段）—— 认什么、**不认什么**、几何数字算得对不对；
 *   ② 真机（本机有活文件时）—— 拿**当前真正在跑的那份**跑一遍，只断言「解析得动 + 关卡数 ≥ 1 + 平台数 > 0」，
 *      没有活文件就跳过（不算失败）。
 *
 * ⚠️ 这个模块的判据有一条硬要求：**只报数字，不下判决**。
 *    「跳得过去吗」是玩法，阈值是作者定的 —— 所以这里还有一条断言专门守这件事。
 *
 * 用法：node tests/leveldata-test.mjs
 */

import fs from 'node:fs';
import {
  stripLuaComments, collectConstants, extractLevelTable, parseTableLiteral,
  normalizePlat, levelGeometry, describeLevels, findCanvas,
} from '../lib/leveldata.mjs';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------------------------------------ ① 去注释 */

ok('行注释被去掉，换行数与行号保持不变', (() => {
  const src = 'a = 1 -- 注释\nb = 2\n-- 整行注释\nc = 3';
  const out = stripLuaComments(src);
  return out.split('\n').length === 4 && !/注释/.test(out);
})());
ok('字符串里的 `--` 不能被当注释', (() => {
  const out = stripLuaComments('x = "a -- b"  -- 真注释');
  return /a -- b/.test(out) && !/真注释/.test(out);
})());
ok('长注释 `--[[ … ]]` 整段去掉且保留换行', (() => {
  const out = stripLuaComments('a=1\n--[[ 多行\n注释 ]]\nb=2');
  return !/多行/.test(out) && out.split('\n').length === 4;
})());
ok('长注释 `--[==[ … ]==]` 也认', stripLuaComments('a=1 --[==[ 里面 ] 不算结束 ]==] b=2').includes('b=2'));
ok('长字符串 `[[ ]]` 原样保留', stripLuaComments('x = [[a -- b]]').includes('[[a -- b]]'));

/* ------------------------------------------------------ ② 常量表 */

const C = collectConstants(stripLuaComments([
  'local A, B, C = 1, 2, 3',                     // 多变量一行（活文件就这么写）
  'local NAME = "冰镜"',
  'local T = true',
  'local BAD = os.time()',                       // 非字面量 → 跳过
  'local PAIR = 1, 2',                           // 数量对不上 → 跳过
].join('\n')));
ok('多变量一行赋值全部收到', C.get('A') === 1 && C.get('B') === 2 && C.get('C') === 3);
ok('字符串常量收到（中文不乱）', C.get('NAME') === '冰镜');
ok('布尔常量收到', C.get('T') === true);
ok('非字面量的常量**不塞错值**', !C.has('BAD'));
ok('数量对不上的跳过', !C.has('PAIR'));

/* ------------------------------------------------------ ③ 抽表 */

const SRC = [
  '-- 说明：平台项 = { x, y, w, h, kind [, mv] [, iso] }',
  'local K_PLAIN, K_ICE, K_MOVER = 0, 1, 5',
  'local CANVAS_W, CANVAS_H = 1600, 1000',
  'local LEVELS = {',
  '  {',
  '    name = "第1关 教学",',
  '    spawn = { 40, 90 },',
  '    exit  = { 60, 850, 110, 90 },',
  '    zones = { { 1150, 520, 460, 200, "冰墙教学" } },',
  '    plats = {',
  '      { 0,   120, 260, 100, K_PLAIN },              -- 起点',
  '      { 340, 180, 130, 24,  K_ICE },',
  '      { 1380, 420, 40, 140, K_ICE, nil, true },     -- iso：不在通关路径上',
  '      { 700, 340, 130, 24,  K_MOVER, { range = 120, period = 3 } },',
  '    },',
  '  },',
  '}',
].join('\n');

const ex = extractLevelTable(SRC);
ok('抽表成功', ex.ok === true, ex.error);
ok('抽到 1 关', ex.ok && ex.levels.length === 1);
ok('常量表里 K_PLAIN=0 可用于解析', ex.ok && ex.levels[0].plats[0][4] === 0);
ok('画布常量能找出来', (() => {
  const c = findCanvas(ex.constants);
  return c && c.w === 1600 && c.h === 1000 && c.source === 'CANVAS_W/CANVAS_H';
})());
ok('画布常量换名字也认（实测活文件用的是 DESIGN_W/DESIGN_H）', (() => {
  const c = findCanvas([{ name: 'DESIGN_W', value: 1600 }, { name: 'DESIGN_H', value: 1000 }]);
  return c && c.w === 1600 && c.source === 'DESIGN_W/DESIGN_H';
})());
ok('没有画布常量时返回 null（不编造）', findCanvas([{ name: 'FOO', value: 1 }]) === null);

ok('认不出 `local LEVELS = {` 时明确报「找不到」', (() => {
  const r = extractLevelTable('local FOO = { 1 }');
  return r.ok === false && /没有找到/.test(r.error) && r.searchedFor === 'LEVELS';
})());

ok('表里有**算术**时如实报行号，不猜', (() => {
  const r = extractLevelTable('local LEVELS = {\n  { 1+2, 3, 4, 5, 0 },\n}');
  return r.ok === false && typeof r.line === 'number' && /不是字面量/.test(r.error);
})());
ok('报错时把那一行原文带出来（好定位）', (() => {
  const r = extractLevelTable('local LEVELS = {\n  { 1+2, 3, 4, 5, 0 },\n}');
  return /1\+2/.test(r.lineText || '');
})());
ok('表里有函数调用时也如实报错', (() => {
  const r = extractLevelTable('local LEVELS = {\n  { math.floor(1), 3, 4, 5, 0 },\n}');
  return r.ok === false;
})());
ok('表没闭合时报「少了 }」而不是静默截断', (() => {
  const r = extractLevelTable('local LEVELS = {\n  { 1, 2, 3, 4, 0 },');
  return r.ok === false && /没有闭合/.test(r.error);
})());

ok('尾随逗号允许', extractLevelTable('local LEVELS = { { name="x", plats={ {1,2,3,4,0}, } }, }').ok === true);
// ⚠️ `LEVELS` 顶层必须是**数组**（`{ 关卡1, 关卡2, … }`）—— 单个关卡对象会被明确拒绝，不会当成一关
ok('分号也当分隔符', extractLevelTable('local LEVELS = { { name="x"; plats={ {1,2,3,4,0} } } }').ok === true);
ok('LEVELS 不是数组时明确报错（不硬当一关）', (() => {
  const r = extractLevelTable('local LEVELS = { name="x", plats={ {1,2,3,4,0} } }');
  return r.ok === false && /不是数组/.test(r.error);
})());

/* ------------------------------------------------------ ④ 几何事实 */

const L1 = [ // 今晚那个坑的原型：A 的 [400,740] 与 B 的 [720,1060] 水平重叠 20px
  { x: 400, y: 500, w: 340, h: 40, kind: 0 },   // A: 400..740
  { x: 720, y: 460, w: 340, h: 40, kind: 0 },   // B: 720..1060（更高，且水平重叠 20）
].map((p) => normalizePlat([p.x, p.y, p.w, p.h, p.kind], {}));

const g1 = levelGeometry(L1);
ok('相邻对：水平投影重叠 20px 被算出来', g1.adjacent[0].dxOverlap === 20, String(g1.adjacent[0].dxOverlap));
ok('相邻对：上升高度算对（A.top 500 → B.top 460）', g1.adjacent[0].dyRise === 40, String(g1.adjacent[0].dyRise));
ok('相邻对：分离时给缝的像素数', (() => {
  const p = [{ x: 0, y: 0, w: 100, h: 10, kind: 0 }, { x: 140, y: 0, w: 100, h: 10, kind: 0 }]
    .map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  const g = levelGeometry(p);
  return g.adjacent[0].dxOverlap === -40 && g.adjacent[0].dxGap === 40;
})());
// ★ 形状分类：今晚那次白跑的真正形状是「向上 + 水平重叠」；而「向下 + 水平重叠」（台阶式换行）是正常的
ok('★ 形状分类：向上 + 水平重叠 被单独挑出来', g1.adjacent[0].pattern === '向上+水平重叠' && g1.risingOverlaps.length === 1, g1.adjacent[0].pattern);
ok('形状分类：向下 + 水平重叠 不会被当成「向上重叠」', (() => {
  const p = [
    { x: 0, y: 0, w: 200, h: 20, kind: 0 },
    { x: 100, y: 100, w: 200, h: 20, kind: 0 },   // 更低
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  const g = levelGeometry(p);
  return g.adjacent[0].pattern === '向下+水平重叠' && g.risingOverlaps.length === 0;
})());
// ★ 序号口径：i/j 必须是「关卡表 plats 里的序号」，不是「非 iso 平台里的第几个」
ok('★ 序号用「表里的序号」而不是「非 iso 的第几个」（混用会认错平台）', (() => {
  const p = [
    normalizePlat([0, 0, 100, 10, 0], {}),
    normalizePlat([0, 0, 10, 900, 3, null, true], {}),   // 第 2 项是 iso
    normalizePlat([200, 0, 100, 10, 0], {}),
  ].map((q, k) => ({ ...q, idx: k + 1 }));
  const g = levelGeometry(p);
  return g.adjacent[0].i === 1 && g.adjacent[0].j === 3;   // 不是 1 和 2
})());
ok('相邻对里内联了 aBox/bBox（不看序号也能直接读坐标）', (() => {
  const a = g1.adjacent[0];
  return a.aBox && a.bBox && a.aBox.x === 400 && a.bBox.x === 720 && a.aBox.w === 340;
})());

ok('★ 「头顶净空只剩 N px」被算出来（今晚那 6px）', (() => {
  const p = [
    { x: 0, y: 500, w: 200, h: 40, kind: 0 },       // 下面这块，顶面 y=500
    { x: 100, y: 454, w: 200, h: 40, kind: 0 },     // 上面这块，底面 y=494 → 净空 6
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  const g = levelGeometry(p);
  return g.nearMiss.length === 1 && g.nearMiss[0].clearance === 6;
})(), JSON.stringify(g1.nearMiss));

ok('★ 真·矩形相交被单独归类（不是「近似」）', (() => {
  const p = [
    { x: 0, y: 0, w: 100, h: 100, kind: 0 },
    { x: 50, y: 50, w: 100, h: 100, kind: 0 },
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  const g = levelGeometry(p);
  return g.overlaps.length === 1 && g.overlaps[0].dxOverlap === 50 && g.overlaps[0].dyOverlap === 50 && g.nearMiss.length === 0;
})());
ok('水平完全不重叠的一对不进 nearMiss（不然报告全是噪声）', (() => {
  const p = [
    { x: 0, y: 500, w: 100, h: 10, kind: 0 },
    { x: 500, y: 400, w: 100, h: 10, kind: 0 },
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  return levelGeometry(p).nearMiss.length === 0;
})());
ok('nearPx 是筛选阈值（可调），不是判定', (() => {
  const p = [
    { x: 0, y: 500, w: 200, h: 40, kind: 0 },
    { x: 100, y: 300, w: 200, h: 40, kind: 0 },   // 净空 160
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind], {}));
  return levelGeometry(p, { nearPx: 48 }).nearMiss.length === 0 && levelGeometry(p, { nearPx: 200 }).nearMiss.length === 1;
})());
ok('iso 平台不进相邻链、也不进 bbox', (() => {
  const p = [
    { x: 0, y: 0, w: 100, h: 10, kind: 0 },
    { x: 0, y: 0, w: 10, h: 900, kind: 3, iso: true },
    { x: 200, y: 0, w: 100, h: 10, kind: 0 },
  ].map((q) => normalizePlat([q.x, q.y, q.w, q.h, q.kind, null, q.iso], {}));
  const g = levelGeometry(p);
  return g.solidCount === 2 && g.isoCount === 1 && g.adjacent.length === 1 && g.bbox.bottom === 10;
})());
ok('平台项少于 5 个数 → 归一化成 null（不编造）', normalizePlat([1, 2, 3], {}) === null);

/* ------------------------------------------------------ ⑤ 「只报数字」这条纪律 */

{
  const g = levelGeometry(L1);
  const banned = ['pass', 'passed', 'ok', 'reachable', 'valid', 'safe', 'verdict', 'conclusion', 'issues'];
  const bad = banned.filter((k) => Object.prototype.hasOwnProperty.call(g, k));
  ok('★ 几何事实里**没有** pass/reachable/verdict 这类判决字段', bad.length === 0, bad.join(','));
}
{
  const cards = describeLevels(ex.levels);
  const c = cards[0];
  const banned = ['pass', 'passed', 'reachable', 'valid', 'verdict', 'conclusion'];
  const bad = banned.filter((k) => Object.prototype.hasOwnProperty.call(c.facts, k));
  ok('★ 关卡卡片同样只有数字，不替作者判「跳得过去」', bad.length === 0 && !('pass' in c), bad.join(','));
}
ok('卡片带上 name / spawn / exit / 平台数与几何事实', (() => {
  const c = describeLevels(ex.levels)[0];
  return c.name === '第1关 教学' && c.spawn.x === 40 && c.exit.w === 110 && c.platCount === 4 && c.facts.solidCount === 3;
})());
ok('卡片按 kind 名统计（iso 也算在 count 里）', (() => {
  const c = describeLevels(ex.levels)[0];
  return c.facts.kinds['普通'] === 1 && c.facts.kinds['冰面'] === 2 && c.facts.kinds['移动'] === 1;
})());
ok('`which` 可按序号或名字筛关', (() => {
  const two = extractLevelTable('local LEVELS = { { name="第1关", plats={{1,2,3,4,0}} }, { name="第2关", plats={{5,6,7,8,0}} } }');
  return describeLevels(two.levels, { which: '2' }).length === 1
    && describeLevels(two.levels, { which: '第2关' })[0].index === 2
    && describeLevels(two.levels)[0].index === 1;
})());

/* ------------------------------------------------------ ⑥ 真机（没有就跳过） */

const liveDirs = [];
try {
  const { scanLevels, pickCurrent } = await import('../lib/locate.mjs');
  const lv = pickCurrent(scanLevels());
  if (lv && lv.luaFiles && lv.luaFiles.length) {
    for (const f of lv.luaFiles) liveDirs.push(f.path);
  }
} catch { /* ignore */ }

if (liveDirs.length) {
  const p = liveDirs[0];
  const src = fs.readFileSync(p, 'utf8');
  const r = extractLevelTable(src);
  ok('真机：当前活文件抽表成功', r.ok === true, r.error);
  if (r.ok) {
    const cards = describeLevels(r.levels);
    ok('真机：至少 1 关，且平台数 > 0', cards.length >= 1 && cards.every((c) => c.platCount > 0));
    const canvas = findCanvas(r.constants);
    console.log('  · ' + p.split('\\').pop() + '：' + r.levels.length + ' 关'
      + (canvas ? '，画布 ' + canvas.w + '×' + canvas.h : '（没找到画布常量）'));
    for (const c of cards) {
      const f = c.facts;
      console.log(`    第${c.index}关 ${c.name || '?'}：平台 ${c.platCount}（iso ${f.isoCount}）`
        + ` bbox ${f.spanX}×${f.spanY}  相邻重叠 ${f.adjacent.filter((a) => a.dxOverlap > 0).length} 处`
        + `（其中向上重叠 ${f.risingOverlaps.length}）  真相交 ${f.overlaps.length} 处  净空≤${f.nearPxUsed}px ${f.nearMiss.length} 处`);
      // 用**内联坐标**报那几处，顺带证明「不看序号也能读」
      for (const a of f.risingOverlaps) {
        console.log(`      ⚠ 相邻第 ${a.i} → ${a.j} 块：${a.pattern}，水平重叠 ${a.dxOverlap}px，后者高 ${a.dyRise}px`);
      }
    }
  }
} else {
  console.log('- 跳过真机检查：没扫到活文件');
}

console.log('\n通过 ' + pass + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ') : '，全部通过'));
process.exit(failures.length ? 1 : 0);
