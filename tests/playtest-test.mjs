/**
 * 试玩信号模块测试（lib/playtest.mjs）
 *
 * 这个模块决定「什么时候算开跑」——判错了会让人以为在试玩、或者等一局永远不来的信号。
 * 所以分三层钉：
 *   ① **纯函数**：解析 / 分类 / 归约 / 命中判定 —— 逐条钉，含「新局隐式收尾」「孤儿结束」这类边界；
 *   ② **IO**：临时目录里的真文件（含换代 size 回退、尾部截断）；
 *   ③ **真机轻量**：本机有 `output_log.txt` 时扫一遍，只断言「解析不炸且找得到开跑」——
 *      不依赖游戏当时在不在跑；没有这个文件就算跳过，不算失败。
 *
 * ⚠️ 夹具全是 2026-09-23 真机抓到的原文（Δ 0.07~0.18s 那一局）。
 * 用法：node tests/playtest-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAYTEST_LOG_NAME, playtestLogPath, parseLogLine, classifyLogText,
  createPlaytestState, reduceLogLines, playtestSummary, shouldHit,
  scanLog, readTailText, readIncrement, logSize,
} from '../lib/playtest.mjs';

let pass = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------------------------- 真机原文夹具 */

const L_SCENE_1 = '[2026-09-23 21:46:02.419] Genshin Loading Log: OnReceivePlayerEnterSceneNotify 1037586 - NowTimeStamp:1790171162';
const L_START_1 = '[2026-09-23 21:46:02.420] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790171162';
const L_END_1 = '[2026-09-23 21:46:58.960] Genshin Loading Log: StartQuickSwitchSceneAction token:1037686 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:1790171218';
const L_NOISE = '[2026-09-23 21:31:42.081] Send ResourceTagCollection Sync - IGStuffCustom';
const L_TRIAL_FALSE = '[2026-09-23 20:34:48.200] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:False - NowTimeStamp:1790166888';
// 21:29 那局：开跑 epoch 与 .gia 的 instance 第三段相同（跨来源对得上号）
const L_SCENE_2 = '[2026-09-23 21:29:37.376] Genshin Loading Log: OnReceivePlayerEnterSceneNotify 1037286 - NowTimeStamp:1790170177';
const L_START_2 = '[2026-09-23 21:29:37.378] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData guid: 0 serverVersion: 0 isTrial:True - NowTimeStamp:1790170177';
const L_END_2 = '[2026-09-23 21:31:33.372] Genshin Loading Log: StartQuickSwitchSceneAction token:1037386 reason:QuickSwitchToBeyondSettleSceneNormally - NowTimeStamp:1790170293';

const feed = (state, lines) => reduceLogLines(state, lines).state;
const eventsOf = (state, lines) => reduceLogLines(state, lines).events;

/* ------------------------------------------------- ① 解析 */

ok('parseLogLine 认出真机行', (() => {
  const r = parseLogLine(L_START_1);
  return r && r.atText === '21:46:02.420' && r.date === '2026-09-23' && r.text.startsWith('Genshin Loading Log');
})());
ok('parseLogLine 保留毫秒', parseLogLine(L_END_1).atText === '21:46:58.960', parseLogLine(L_END_1).atText);
ok('parseLogLine 返回可比较的绝对时刻', new Date(parseLogLine(L_START_1).atMs).getHours() === 21);
ok('parseLogLine 空串 → null', parseLogLine('') === null);
ok('parseLogLine 普通文本 → null', parseLogLine('hello') === null);
ok('parseLogLine 缺毫秒 → null（宁可漏，不可错）', parseLogLine('[2026-09-23 21:46:02] x') === null);
ok('parseLogLine 容忍 ] 后无空格', parseLogLine('[2026-09-23 21:46:02.420]x') !== null);

/* ------------------------------------------------- 分类 */

ok('分类：开跑行 → start', classifyLogText(L_START_1.split('] ')[1]) === 'start');
ok('分类：结束行 → end', classifyLogText(L_END_1.split('] ')[1]) === 'end');
ok('分类：场景行 → scene', classifyLogText(L_SCENE_1.split('] ')[1]) === 'scene');
ok('分类：噪声行 → null', classifyLogText(L_NOISE.split('] ')[1]) === null);
ok('分类：isTrial:False 不算开跑', classifyLogText(L_TRIAL_FALSE.split('] ')[1]) === null);
ok('分类：开跑行不会被误判成 end', classifyLogText(L_START_1.split('] ')[1]) !== 'end');
ok('分类：结束行不会被误判成 start', classifyLogText(L_END_1.split('] ')[1]) !== 'start');
ok('分类：null / undefined 不炸', classifyLogText(null) === null && classifyLogText(undefined) === null);

/* ------------------------------------------------- 归约 */

const ev1 = eventsOf(createPlaytestState(), [L_SCENE_1, L_START_1]);
ok('开跑产生 start 事件', ev1.length === 1 && ev1[0].type === 'start', JSON.stringify(ev1));
ok('开跑带上后面那句 token', ev1[0].token === 1037586, String(ev1[0].token));
ok('开跑带上 epoch 秒', ev1[0].epochSec === 1790171162, String(ev1[0].epochSec));
ok('开跑时刻用毫秒行自己的时间', ev1[0].atText === '21:46:02.420', ev1[0].atText);

const s1 = feed(createPlaytestState(), [L_SCENE_1, L_START_1]);
ok('开跑后 inPlaytest = true', s1.inPlaytest === true);
ok('开跑后 epoch 与 .gia instance 第三段一致', s1.epochSec === 1790171162);

const s1e = feed(s1, [L_END_1]);
ok('结束后 inPlaytest = false', s1e.inPlaytest === false);
ok('结束后落一局到 runs', s1e.runs.length === 1, String(s1e.runs.length));
ok('局时长 = 行时间戳之差（56.54s → 57）', s1e.runs[0].durationSec === 57, String(s1e.runs[0].durationSec));
// 记录里**保留毫秒**（精确）；要好看的截到秒是展示层的事，别在这里丢精度
ok('局起止都留了可读时刻（含毫秒）', s1e.runs[0].startedAtText === '21:46:02.420' && s1e.runs[0].endedAtText === '21:46:58.960', JSON.stringify(s1e.runs[0]));
ok('正常收尾标 closed=seen', s1e.runs[0].closed === 'seen');

ok('归约是纯函数：不改入参', (() => {
  const base = createPlaytestState();
  reduceLogLines(base, [L_SCENE_1, L_START_1, L_END_1]);
  return base.inPlaytest === false && base.runs.length === 0;
})());

ok('没有 scene 行也能开跑（token 为 null，epoch 自取）', (() => {
  const st = feed(createPlaytestState(), [L_START_1]);
  return st.inPlaytest === true && st.token === null && st.epochSec === 1790171162;
})());
ok('结束事件不会误配到上一局', (() => {
  const ev = eventsOf(createPlaytestState(), [L_END_1]);
  return ev.length === 1 && ev[0].type === 'end' && ev[0].orphan === true;
})());
ok('孤儿结束不编造出一局', feed(createPlaytestState(), [L_END_1]).runs.length === 0);

const sDbl = feed(createPlaytestState(), [L_SCENE_1, L_START_1, L_SCENE_2, L_START_2]);
ok('连续两次开跑 → 前一局隐式收尾', sDbl.runs.length === 1 && sDbl.runs[0].closed === 'implicit', JSON.stringify(sDbl.runs));
ok('隐式收尾后仍在试玩（第二局还开着）', sDbl.inPlaytest === true && sDbl.epochSec === 1790170177);

// 噪声行本身是**合法日志行**（有毫秒前缀）→ 计入 lineCount，但不产生事件；
// 「不是日志行」连前缀都没有 → 解析失败，连 lineCount 都不计。
ok('噪声行不产生事件、但要计入 lineCount', (() => {
  const r = reduceLogLines(createPlaytestState(), [L_NOISE, '不是日志行', L_START_1]);
  return r.events.length === 1 && r.state.lineCount === 2;
})());

ok('分批喂（行被拆到两次读取里）结果一致', (() => {
  const a = feed(feed(createPlaytestState(), [L_SCENE_1, L_START_1]), [L_END_1]);
  const b = feed(createPlaytestState(), [L_SCENE_1, L_START_1, L_END_1]);
  return a.inPlaytest === b.inPlaytest && a.runs.length === b.runs.length && a.runs[0].durationSec === b.runs[0].durationSec;
})());

ok('两局都记上（21:29 与 21:46）', (() => {
  const st = feed(createPlaytestState(), [L_SCENE_1, L_START_1, L_END_1, L_SCENE_2, L_START_2, L_END_2]);
  return st.runs.length === 2 && st.runs[0].epochSec === 1790171162 && st.runs[1].epochSec === 1790170177;
})());
ok('21:29 那局时长 = 116s（真机 21:29:37→21:31:33）', (() => {
  const st = feed(createPlaytestState(), [L_SCENE_2, L_START_2, L_END_2]);
  return st.runs[0].durationSec === 116;
})());

ok('runs 上限 50（长会话不吃内存）', (() => {
  let st = createPlaytestState();
  for (let i = 0; i < 60; i += 1) st = feed(st, [L_SCENE_1, L_START_1, L_END_1]);
  return st.runs.length === 50;
})());

/* ------------------------------------------------- 命中判定 */

const NOW = parseLogLine(L_START_1).atMs + 5000;
const sHit = feed(createPlaytestState(), [L_SCENE_1, L_START_1]);
ok('刚开跑 + 无下限 → 命中', shouldHit(sHit, NOW, {}).hit === true);
ok('命中时带回 ageSec', Math.round(shouldHit(sHit, NOW, {}).ageSec) === 5);
ok('sinceMs 之后没开跑 → 不命中', shouldHit(sHit, NOW, { sinceMs: NOW - 1000 }).hit === false);
ok('sinceMs 之前开跑 → 命中', shouldHit(sHit, NOW, { sinceMs: NOW - 60000 }).hit === true);
ok('backSec 覆盖到 5 秒前的开跑 → 命中且标 backHit', (() => {
  const r = shouldHit(sHit, NOW, { backSec: 30 });
  return r.hit === true && r.backHit === true;
})());
ok('backSec=2 不够覆盖 5 秒前 → 不命中', shouldHit(sHit, NOW, { backSec: 2 }).hit === false);
ok('从没开跑过 → 不命中', shouldHit(createPlaytestState(), NOW, { backSec: 9999 }).hit === false);

/* ------------------------------------------------- 摘要 */

const cur = playtestSummary(sHit, NOW);
ok('摘要：在试玩中 + 已跑秒数', cur.inPlaytest === true && cur.elapsedSec === 5, JSON.stringify(cur.elapsedSec));
ok('摘要：在跑时不报结束时刻', cur.endedAt === null && cur.endedAtMs === null);
const done = playtestSummary(s1e, NOW);
ok('摘要：跑完给最后局的时长', done.inPlaytest === false && done.lastRun.durationSec === 57);
const multi = playtestSummary(feed(createPlaytestState(), [L_SCENE_1, L_START_1, L_END_1, L_SCENE_2, L_START_2, L_END_2]), NOW);
ok('摘要：recentRuns 按喂入（真实日志即时间）序给全', multi.recentRuns.length === 2 && multi.recentRuns[0].startedAt === '21:46:02.420', JSON.stringify(multi.recentRuns.map((r) => r.startedAt)));

/* ------------------------------------------------- ② IO（临时目录，不碰存档） */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-playtest-'));
try {
  const f = path.join(tmp, PLAYTEST_LOG_NAME);
  fs.writeFileSync(f, [L_NOISE, L_SCENE_1, L_START_1, L_END_1, L_SCENE_2, L_START_2].join('\r\n') + '\r\n', 'utf8');

  const sc = scanLog(f);
  ok('scanLog 扫真文件成功', sc.ok === true && sc.size > 0);
  ok('scanLog 找到 1 局完整 + 1 局在跑', sc.state.runs.length === 1 && sc.state.inPlaytest === true, JSON.stringify(playtestSummary(sc.state, NOW)));
  ok('scanLog 的 epoch 与夹具一致', sc.state.epochSec === 1790170177, String(sc.state.epochSec));
  ok('scanLog 未截断时 truncated=false', sc.truncated === false);

  const small = scanLog(f, 120);
  ok('scanLog 小窗口会标 truncated', small.ok === true && small.truncated === true);
  ok('scanLog 截断时丢掉残行（不产生垃圾状态）', small.state.lineCount >= 0 && small.state.lineCount <= sc.state.lineCount);

  ok('logSize 真文件有值', logSize(f) > 0);
  ok('logSize 不存在 → null', logSize(path.join(tmp, 'nope.txt')) === null);
  ok('readTailText 不存在 → ok:false 且不抛', readTailText(path.join(tmp, 'nope.txt')).ok === false);
  ok('scanLog 不存在 → ok:false 且不抛', scanLog(path.join(tmp, 'nope.txt')).ok === false);

  const inc = readIncrement(f, 0);
  ok('readIncrement 从 0 读全文', inc.ok === true && inc.text.includes('isTrial:True'));
  ok('readIncrement 到末尾时返回空串', readIncrement(f, fs.statSync(f).size).text === '');
  ok('readIncrement 位置超过 size → rotated', (() => {
    const r = readIncrement(f, fs.statSync(f).size + 10);
    return r.ok === true && r.rotated === true && r.text === '';
  })());
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------- ③ 真机轻量（没有日志就跳过） */

const realLog = playtestLogPath('原神');
if (fs.existsSync(realLog)) {
  const r = scanLog(realLog);
  ok('真机 output_log.txt 扫得动', r.ok === true && r.size > 0, r.error || '');
  const runs = r.ok ? r.state.runs.length : 0;
  const hasStart = r.ok ? Number.isFinite(r.state.lastStartAtMs) || runs > 0 : false;
  ok('真机日志里确实找得到「试玩开跑」记录', hasStart, 'runs=' + runs);
  if (r.ok && r.state.epochSec) {
    console.log('  · 本机最近一次开跑 epoch = ' + r.state.epochSec + '，在跑=' + r.state.inPlaytest + '，历史上共 ' + runs + ' 局');
  }
} else {
  console.log('- 跳过真机检查：本机没有 ' + realLog);
}

/* ------------------------------------------------- 收尾 */

console.log('\n通过 ' + pass + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ') : '，全部通过'));
process.exit(failures.length ? 1 : 0);
