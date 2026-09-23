/**
 * 指标解析与汇总测试（lib/metrics.mjs）
 *
 * 这个模块的价值全在「算出来的数对不对」上 —— 算错了会让人按错误的分布去改关卡。
 * 所以三层钉：
 *   ① 解析：`[MIL]` 严格约定 + 宽松抽取（**认不出就静默忽略**，绝不报错）；
 *   ② 统计：分布 / 中位数 / **热区**（含单值、空集这类边界）；
 *   ③ 真机：拿**当前真实日志**跑一遍宽松抽取 —— 这一条就是「今天就能用」的证据。
 *
 * ⚠️ 还有一条纪律断言：汇总结果是**数字事实**，不许出现 verdict/pass 这类判决字段。
 *
 * 用法：node tests/metrics-test.mjs
 */

import fs from 'node:fs';
import {
  DEFAULT_BINS, extractKv, parseMilLine, parseLooseLine, collectMetrics,
  numericStats, summarizeMil, summarizeLoose, metricsTimeline, conventionHint,
} from '../lib/metrics.mjs';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------------------------------------ ① 解析 */

ok('extractKv 抽出基本 k=v', (() => {
  const { kv, nums } = extractKv('evt=death lv=3 x=814');
  return kv.evt === 'death' && nums.lv === 3 && nums.x === 814;
})());
ok('extractKv 在中文标点处停住', (() => {
  const { nums } = extractKv('摔死处 x=814，最后站立=#2 移动）');
  return nums.x === 814 && Object.keys(nums).length === 1;   // `#2` 不是数字，不收
})());
ok('extractKv 中文键也认（值不是数字就不进 nums）', (() => {
  const { kv, nums } = extractKv('最后站立=#2');
  return kv['最后站立'] === '#2' && !('最后站立' in nums);
})());
ok('extractKv 不会把 `1600x1000` 当成 k=v', Object.keys(extractKv('画布 1600x1000').kv).length === 0);
ok('extractKv 同一个键出现两次时保留第一个', extractKv('x=1 x=2').nums.x === 1);

ok('parseMilLine 认出严格约定', (() => {
  const r = parseMilLine('[MIL] evt=death lv=3 x=814 stand=2');
  return r && r.kind === 'mil' && r.evt === 'death' && r.lv === 3 && r.nums.x === 814 && r.nums.stand === 2;
})());
ok('parseMilLine 事件名可以不带 `evt=`（取第一个裸词）', (() => {
  const r = parseMilLine('[MIL] death lv=3 x=814');
  return r && r.evt === 'death' && r.lv === 3 && r.nums.x === 814;
})());
ok('parseMilLine 小写 `[mil]` 也认', parseMilLine('[mil] evt=clear lv=1') !== null);
ok('parseMilLine 认 `第 3 关` 这种关卡线索', parseMilLine('[MIL] evt=death 第 3 关 x=814').lv === 3);
ok('parseMilLine 认带引号的值', parseMilLine('[MIL] evt=note msg="a b" lv=1').kv.msg === 'a b');
ok('★ 非 `[MIL]` 行返回 null（静默忽略，不报错）', parseMilLine('[yuan-code] 一堆正文') === null);
ok('parseMilLine 对 null/undefined 不炸', parseMilLine(null) === null && parseMilLine(undefined) === null);

const LOOSE_LINE = '[yuan-code] 落出边界 -> 重生（第 3 关，摔死处 x=814，最后站立=#2 移动）';
ok('parseLooseLine 从**现有日志**里扒出 x=814', (() => {
  const r = parseLooseLine(LOOSE_LINE);
  return r && r.kind === 'loose' && r.nums.x === 814 && r.lv === 3 && r.tag === 'yuan-code';
})());
ok('parseLooseLine 没有 `k=数字` 的行不收（避免把正文当指标）', parseLooseLine('[yuan-code] 就绪（3 关，控件 20）') === null);
ok('parseLooseLine 保留原文（供人核对）', /摔死处/.test(parseLooseLine(LOOSE_LINE).text));

ok('collectMetrics：`[MIL]` 行不进 loose（不重复计数）', (() => {
  const c = collectMetrics([
    { index: 0, message: '[MIL] evt=death lv=3 x=814' },
    { index: 1, message: LOOSE_LINE },
    { index: 2, message: '[yuan-code] 没有数值' },
  ]);
  return c.mil.length === 1 && c.loose.length === 1 && c.scanned === 3 && c.ignored === 1;
})());
ok('collectMetrics 挂上 index / instance', (() => {
  const c = collectMetrics([{ index: 7, instance: 'I', message: '[MIL] evt=x lv=1' }]);
  return c.mil[0].index === 7 && c.mil[0].instance === 'I';
})());

/* ------------------------------------------------------------ ② 统计 */

ok('numericStats 基本量', (() => {
  const s = numericStats([700, 800, 860]);
  return s.n === 3 && s.min === 700 && s.max === 860 && s.median === 800 && s.span === 160;
})());
ok('numericStats 空集返回 null（不编造）', numericStats([]) === null && numericStats(null) === null);
ok('numericStats 单值时只有一个箱、不会除零', (() => {
  const s = numericStats([814]);
  return s.n === 1 && s.bins.length === 1 && s.hotBin.from === 814 && s.hotBin.to === 814 && s.hotShare === 1
    && s.core.from === 814 && s.core.to === 814;
})());
ok('numericStats 给四分位与集中区', (() => {
  const s = numericStats([10, 20, 30, 40, 50]);
  return s.p25 === 20 && s.p75 === 40 && s.core.from === 20 && s.core.to === 40 && s.core.width === 20;
})());
ok('numericStats 分箱数可调', numericStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 }).bins.length === 5);
ok('numericStats 所有值都进箱（不丢样本）', (() => {
  const vals = Array.from({ length: 37 }, (_, i) => 700 + i * 4);
  const s = numericStats(vals);
  return s.bins.reduce((a, b) => a + b.count, 0) === 37;
})());
ok('numericStats 热区是命中最多的那一箱', (() => {
  const vals = [...Array(9).fill(0).map(() => 700 + Math.random() * 10), ...Array(3).fill(0).map(() => 1000)];
  const s = numericStats(vals, { bins: 3 });
  return s.hotBin.count === 9;
})());
ok('★ 热区标注它是「数字事实」不是判定', /不是/.test(numericStats([1, 2, 3]).note));

/* ------------------------- ③ 文档里点名的那条验证：12 次死亡、x 集中在 700~860 */

const DEPTHS = [700, 814, 858, 785, 1086, 694, 708, 460, 720, 760, 800, 860];
const deathRecords = DEPTHS.map((x, i) => ({ index: i, instance: 'A', message: `[MIL] evt=death lv=3 x=${x} stand=2` }));
const clearRecords = [
  { index: 20, instance: 'A', message: '[MIL] evt=clear lv=1 ms=3000' },
  { index: 21, instance: 'A', message: '[MIL] evt=clear lv=2 ms=5000' },
];
const collected = collectMetrics([...deathRecords, ...clearRecords]);
const sum = summarizeMil(collected.mil);

ok('★ 文档那条验证：第 3 关聚出 **12 次**死亡', (() => {
  const d = sum.find((s) => s.evt === 'death');
  return d && d.count === 12 && d.byLevel['3'].count === 12;
})(), JSON.stringify(sum.map((s) => [s.evt, s.count])));
ok('★ 文档那条验证：x 的分布 min=460 max=1086，**集中区**落在 700~860', (() => {
  const d = sum.find((s) => s.evt === 'death');
  const st = d.byLevel['3'].nums.x;
  // 12 个数里 9 个在 694~860；core = 中间 50% → 706~825（热区/直方图会被 460 与 1086 摊薄，所以要靠 core）
  return st.min === 460 && st.max === 1086
    && st.core.from >= 700 && st.core.from <= 720
    && st.core.to >= 820 && st.core.to <= 860;
})(), JSON.stringify(sum.find((s) => s.evt === 'death').byLevel['3'].nums.x.core));
ok('★ 集中区（四分位距）比直方图热区更抗离群值 —— 同一批数据对比', (() => {
  const d = sum.find((s) => s.evt === 'death');
  const st = d.byLevel['3'].nums.x;
  // 直方图最多只装到 3 个（被 460 / 1086 摊薄），而 core 只圈了中间一半、宽度远小于全距
  return st.hotBin.count < st.n / 2 && st.core.width < st.span / 2;
})(), (() => {
  const st = sum.find((s) => s.evt === 'death').byLevel['3'].nums.x;
  return `hot=${st.hotBin.count}/${st.n} core宽=${st.core.width} 全距=${st.span}`;
})());
ok('summarizeMil 按次数倒序', sum[0].evt === 'death' && sum[1].evt === 'clear');
ok('summarizeMil 分开统计不同事件', sum.find((s) => s.evt === 'clear').count === 2);
ok('summarizeMil 的分关里带数值分布', (() => {
  const c = sum.find((s) => s.evt === 'clear');
  return c.byLevel['1'].count === 1 && c.byLevel['1'].nums.ms.min === 3000;
})());
ok('没有 lv 的事件归到「(未标注)」', (() => {
  const s = summarizeMil(collectMetrics([{ index: 0, message: '[MIL] evt=boom x=1' }]).mil);
  return s[0].byLevel['(未标注)'].count === 1;
})());

ok('summarizeLoose：按键统计（不假装知道 x 是什么）', (() => {
  const rows = collectMetrics([
    { index: 0, message: LOOSE_LINE },
    { index: 1, message: '[yuan-code] 落出边界 -> 重生（第 3 关，摔死处 x=794）' },
    { index: 2, message: '[yuan-code] 落出边界 -> 重生（第 1 关，摔死处 x=220）' },
  ]).loose;
  const s = summarizeLoose(rows);
  return s.keys.x.n === 3 && s.keys.x.min === 220 && s.keys.x.max === 814
    && s.levels['3'] === 2 && s.levels['1'] === 1 && s.tags['yuan-code'] === 3
    && s.keys.x.byLevel['3'].n === 2;
})());

ok('metricsTimeline 从 instance 里取 epoch 秒', (() => {
  const ev = collectMetrics([{ index: 0, instance: '47504-201170108-1790170177-5403', message: '[MIL] evt=death lv=3 x=814' }]).mil;
  const tl = metricsTimeline(ev);
  return tl[0].epochSec === 1790170177 && tl[0].evt === 'death' && tl[0].lv === 3;
})());
ok('metricsTimeline 有上限', metricsTimeline(Array.from({ length: 100 }, (_, i) => ({ index: i })), { limit: 5 }).length === 5);

ok('★ 汇总里不出现判决字段（只说事实）', (() => {
  const banned = ['verdict', 'pass', 'failed', 'problem', 'issue', 'shouldFix'];
  const d = sum.find((s) => s.evt === 'death');
  return banned.every((k) => !Object.prototype.hasOwnProperty.call(d, k));
})());
ok('conventionHint 给出可照抄的 print 片段与字段表', (() => {
  const h = conventionHint();
  return /print\("\[MIL\]/.test(h.how) && h.keys.evt && h.examples.length >= 3 && /静默忽略/.test(h.note);
})());

/* ------------------------------------------------------------ ④ 真机（没有就跳过） */

let logPath = null;
try {
  const { scanLevels, pickCurrent } = await import('../lib/locate.mjs');
  const lv = pickCurrent(scanLevels());
  if (lv && lv.latestLog && lv.latestLog.path) logPath = lv.latestLog.path;
} catch { /* ignore */ }

if (logPath && fs.existsSync(logPath)) {
  const { readGia } = await import('../lib/gia.mjs');
  const gia = readGia(logPath);
  const c = collectMetrics(gia.records);
  ok('真机：现有日志能被宽松抽取（不用改脚本就能用）', c.loose.length > 0, 'loose=' + c.loose.length);
  const s = summarizeLoose(c.loose);
  console.log('  · ' + logPath.split('\\').pop() + '：' + gia.recordCount + ' 条记录，'
    + '宽松命中 ' + c.loose.length + ' 条（MIL ' + c.mil.length + ' 条，忽略 ' + c.ignored + ' 条）');
  for (const [k, st] of Object.entries(s.keys)) {
    console.log(`    键 ${k}：${st.n} 次，${st.min}~${st.max}，中位数 ${st.median}`
      + `，**集中区 ${st.core.from}~${st.core.to}**（中间 50%），热区 ${st.hotBin.from}~${st.hotBin.to}（${st.hotBin.count} 次）`);
    for (const [lv, d] of Object.entries(st.byLevel)) {
      console.log(`      第 ${lv} 关：${d.n} 次，${d.min}~${d.max}，集中区 ${d.core ? d.core.from + '~' + d.core.to : '?'}`);
    }
  }
  ok('真机：能算出数值键的分布与热区', Object.values(s.keys).every((st) => st.bins.reduce((a, b) => a + b.count, 0) === st.n));
} else {
  console.log('- 跳过真机检查：没扫到 .gia');
}

console.log('\n通过 ' + pass + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ') : '，全部通过'));
process.exit(failures.length ? 1 : 0);
