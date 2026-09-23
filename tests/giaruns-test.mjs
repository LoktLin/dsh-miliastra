/**
 * `.gia` 按「局」切分测试（lib/gia.mjs 的 groupRuns / summarizeRuns / compareRuns）
 *
 * 这三条是为了把「人肉把 30 多条倒过来、再分清哪段属于哪局」变成「看一眼摘要」。
 * 判错了的后果是**误诊**：把上一局的错算到这一局头上，或者把「两局」揉成一局。
 *
 * 分两层：
 *   ① 纯函数（合成记录）—— 分组 / 排序 / 计数 / 局间 diff 的边界；
 *   ② 真机（本机有 `.gia` 时）—— **回归那句实测结论**：
 *      `21-24-16_155` 必须切成 **2 局试玩**、`21-29-40_156` 是 **1 局**。
 *      没有日志文件就跳过，不算失败。
 *
 * 用法：node tests/giaruns-test.mjs
 */

import fs from 'node:fs';
import { groupRuns, playRunsOf, summarizeRuns, compareRuns } from '../lib/gia.mjs';
import { scanLevels, pickCurrent } from '../lib/locate.mjs';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/** 造一条记录（index 由调用方按顺序给）。 */
const rec = (index, instance, message) => ({ index, instance, message, time: '2026/09/23_21:29:40' });

// 真机原文里那两个 instance（epoch 1790170177 = 21:29:37，1790169819 = 21:23:39）
const I156 = '47504-201170108-1790170177-5403';
const I155A = '47504-201170108-1790169819-1234';
const I155B = '47504-201170108-1790169937-5678';
const I900 = '90003-201170108-1790166887-4884';

/* ------------------------------------------------- ① 纯函数 */

ok('空输入不炸', groupRuns([]).length === 0);
ok('没有 instance 的记录被跳过（不编造一局）', groupRuns([rec(0, '', 'x'), rec(1, null, 'y')]).length === 0);

const g = groupRuns([
  rec(0, I156, '[A] OnInit'),
  rec(1, I156, '[A] 就绪（3 关）'),
  rec(2, I156, '[A] 落出边界 -> 重生'),
  rec(3, I900, '[A] OnDisable'),
  rec(4, I155A, '[A] OnInit'),
  rec(5, I155B, '[A] OnInit'),
]);
ok('按 instance 分成 4 局', g.length === 4, String(g.length));
ok('局数里 47504 有 3 个', playRunsOf(g).length === 3, String(playRunsOf(g).length));
ok('epochSec 取自 instance 第三段', g.find((r) => r.instance === I156).epochSec === 1790170177);
ok('startedAt 是 HH:MM:SS 形状', /^\d{2}:\d{2}:\d{2}$/.test(g.find((r) => r.instance === I156).startedAt || ''));
ok('kind 取自第一段', g.find((r) => r.instance === I900).kind === '90003');
ok('按「47504 在前、90003 在后」排序', g[g.length - 1].kind === '90003', g.map((r) => r.kind).join(','));
ok('47504 之间按开跑时刻升序', (() => {
  const play = playRunsOf(g).map((r) => r.epochSec);
  return play.every((v, i) => i === 0 || play[i - 1] <= v);
})());
ok('每局记录数正确', g.find((r) => r.instance === I156).recordCount === 3);
ok('就绪行被挑出来（只用通用词）', /就绪/.test(g.find((r) => r.instance === I156).readyLine || ''));
ok('疑似异常计数（重生）', g.find((r) => r.instance === I156).faultCount === 1);
ok('首末行都留着', (() => {
  const r = g.find((x) => x.instance === I156);
  return r.firstMessage === '[A] OnInit' && /重生/.test(r.lastMessage);
})());

const errRun = groupRuns([
  rec(0, I156, '[A] attempt to call a nil value (global \'x\')'),
  rec(1, I156, '[A] attempt to call a nil value (global \'x\')'),
  rec(2, I156, '[A] 另一处 error 了'),
])[0];
ok('同类错去重后 errorKinds=2', errRun.errorKinds === 2, String(errRun.errorKinds));
ok('errorSample 也去重', errRun.errorSample.length === 2, String(errRun.errorSample.length));
ok('异常次数按「行数」算（不去重）', errRun.errorLines.length === 3, String(errRun.errorLines.length));

ok('summarizeRuns 只给最后 N 局', summarizeRuns(g, 2).length === 2);
ok('summarizeRuns 不带原始 messages（省带宽）', !('messages' in summarizeRuns(g, 1)[0]));

const cmp = compareRuns(errRun, groupRuns([
  rec(0, I156, '[A] attempt to call a nil value (global \'x\')'),
])[0]);
ok('局间 diff：消失的错误被列出来', cmp.goneErrors.length === 1 && cmp.newErrors.length === 0, JSON.stringify(cmp.goneErrors));
ok('局间 diff：计数增减方向正确', cmp.errorKindsDelta === -1 && cmp.recordDelta === -2, JSON.stringify({ k: cmp.errorKindsDelta, r: cmp.recordDelta }));
ok('局间 diff：变好时明确说「没有变坏」', /没有变坏/.test(cmp.verdict), cmp.verdict);
ok('局间 diff：多出错误时不说「没变坏」', (() => {
  const c2 = compareRuns(errRun, groupRuns([rec(0, I156, '[A] 一个全新的 error 样式')])[0]);
  return !/没有变坏/.test(c2.verdict) && c2.newErrors.length === 1;
})());
ok('局间 diff：缺一局时返回 null（不硬凑）', compareRuns(null, errRun) === null && compareRuns(errRun, null) === null);

/* ------------------------------------------------- ② 真机回归（没有日志就跳过） */

let logDir = null;
try {
  const lv = pickCurrent(scanLevels());
  logDir = lv && lv.logDir;
} catch { /* ignore */ }

if (logDir && fs.existsSync(logDir)) {
  const want = '2026-09-23_21-24-16_155_201170108.gia';
  const p155 = logDir + '\\' + want;
  if (fs.existsSync(p155)) {
    const { readGia } = await import('../lib/gia.mjs');
    const gia = readGia(p155);
    const runs = groupRuns(gia.records.filter((r) => r.message));
    const play = playRunsOf(runs);
    ok('真机回归：21-24-16_155 切成 **2 局试玩**', play.length === 2, '实际 ' + play.length + ' 局：' + play.map((r) => r.startedAt).join(' / '));
    ok('真机回归：那两局开跑时刻是 21:23:39 / 21:25:37（本机 UTC+8）', (() => {
      const t = play.map((r) => r.startedAt);
      // 只在 UTC+8 成立；别的时区会看到不同值 —— 所以这里同时校验 epoch 本身
      return play.map((r) => r.epochSec).join(',') === '1790169819,1790169937'
        && (new Date().getTimezoneOffset() !== -480 || t.join(',') === '21:23:39,21:25:37');
    })(), play.map((r) => r.epochSec + '@' + r.startedAt).join(' / '));
    const s = summarizeRuns(runs, 10);
    console.log('  · 155 的局摘要：' + s.map((r) => `${r.kind}@${r.startedAt ?? '?'}(${r.recordCount}条/异常${r.faultCount})`).join('  '));
  } else {
    console.log('- 跳过真机回归：本机没有 ' + want);
  }
} else {
  console.log('- 跳过真机回归：没扫到日志目录');
}

/* ------------------------------------------------- 收尾 */

console.log('\n通过 ' + pass + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ') : '，全部通过'));
process.exit(failures.length ? 1 : 0);
