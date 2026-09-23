/**
 * 「试玩体检」判据自测。
 *
 * 为什么单独立一套：这是**用户看到的提示**，判错会把人带偏 ——
 * 比如「试玩还在进行中」和「你压根没点试玩」这两种情况长得很像，但下一步动作完全不同。
 * 判据是纯函数（`lib/logdiag.mjs`），所以能像 autoFollowStep 那样逐种情况断言。
 *
 * 用法：node tests/logdiag-test.mjs
 */

import { diagnoseLogs, shortestSessionName, FRESH_SEC } from '../lib/logdiag.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const NOW = Date.parse('2026-09-23T21:00:00+08:00');
const file = (name, ageSec, size = 1000) => ({ name, size, mtime: new Date(NOW - ageSec * 1000).toISOString() });
const procs = (editor, game) => ({ editorRunning: editor, gameRunning: game });

console.log('— 四种结论 —');

check('没有日志 → no-logs，并点出编辑器/游戏在不在跑', () => {
  const r = diagnoseLogs({ files: [], procs: procs(false, false), gilMtimeMs: null, now: NOW });
  assert(r.verdict === 'no-logs', 'verdict 不对：' + r.verdict);
  assert(/一个 .gia 都没有/.test(r.headline), 'headline 没说清：' + r.headline);
  assert(r.why.some((w) => /编辑器.*不在运行/.test(w)), '没点出编辑器不在跑');
  assert(r.next.length >= 1, '没给下一步');
  return r.verdict;
});

check('最近一局 30 秒前写的 → fresh（这就是你刚才那局）', () => {
  const r = diagnoseLogs({ files: [file('2026-09-23_20-59-30_151_201170108.gia', 30)], procs: procs(true, true), gilMtimeMs: null, now: NOW });
  assert(r.verdict === 'fresh', 'verdict 不对：' + r.verdict);
  assert(/20:59:30/.test(r.headline), 'headline 里没有把文件名缩成时间：' + r.headline);
  assert(r.why.length === 0, 'fresh 不该列「可能原因」');
  return r.headline;
});

check('★ 最近一局 113 分钟前 + 游戏在跑 → stale，且**先提「试玩可能还在进行中」**', () => {
  const r = diagnoseLogs({
    files: [file('2026-09-23_18-44-57_151_201170108.gia', 113 * 60)],
    procs: procs(true, true), gilMtimeMs: NOW - 60 * 1000, now: NOW,
  });
  assert(r.verdict === 'stale', 'verdict 不对：' + r.verdict);
  assert(/没有写出日志/.test(r.headline), 'headline 没说「刚才那局没写出日志」：' + r.headline);
  assert(/小时前/.test(r.headline), '没换算成小时：' + r.headline);
  // 关键：把「游戏开着 ≠ 在试玩」排在第一位 —— 2026-09-23 作者就是这么中招的（忘了开试玩）
  assert(r.why.some((w) => /其实没点「试玩」/.test(w)), '没提「可能压根没点试玩」');
  assert(r.why.some((w) => /游戏客户端开着 ≠ 在试玩/.test(w)), '没点破「游戏开着 ≠ 在试玩」这个最坑的误解');
  assert(/其实没点「试玩」/.test(r.why.join('')) && r.why.join('').indexOf('其实没点') < r.why.join('').indexOf('进行中'),
    '「没点试玩」应当排在「进行中」之前（前者更常见）');
  // 「落盘时机」还没实测清楚，不许写成定论
  assert(!/不是边玩边写/.test(r.why.join('')), '把未实测的落盘时机写成了定论');
  assert(/尚未完全实测/.test(r.why.join('')), '没标明这项还没实测');
  assert(r.why.some((w) => /存过盘/.test(w)), '没利用「地图刚存过盘」这条证据');
  assert(r.why.some((w) => /客户端脚本.*没勾选/.test(w)), '没提「日志面板没勾客户端脚本」这个原因');
  assert(r.next.some((w) => /点「试玩」/.test(w)), '没给「去点试玩」这一步');
  assert(r.next.some((w) => /试玩体检/.test(w)), '没告诉用户可以再体检一次确认');
  assert(!/结束时才写/.test(r.next.join('')), 'next 里仍把未实测的落盘时机写成定论');
  return r.headline;
});

check('★ 最近一局很旧 + 游戏**没在跑** → 结论换成「试玩根本没起来」', () => {
  const r = diagnoseLogs({
    files: [file('2026-09-23_18-44-57_151_201170108.gia', 3600)],
    procs: procs(true, false), gilMtimeMs: null, now: NOW,
  });
  assert(r.verdict === 'stale', 'verdict 不对');
  assert(r.why.some((w) => /游戏客户端不在运行/.test(w)), '没提游戏不在跑');
  assert(!r.why.some((w) => /还在进行中/.test(w)), '游戏都没跑却说「试玩可能还在进行中」—— 会把人带偏');
  return r.why[0].slice(0, 30) + '…';
});

console.log('\n— 边界 —');

check('阈值边界：正好 120 秒算 fresh，121 秒算 stale', () => {
  const f = diagnoseLogs({ files: [file('a.gia', FRESH_SEC)], procs: procs(true, true), gilMtimeMs: null, now: NOW });
  const s = diagnoseLogs({ files: [file('a.gia', FRESH_SEC + 1)], procs: procs(true, true), gilMtimeMs: null, now: NOW });
  assert(f.verdict === 'fresh', '120 秒应为 fresh：' + f.verdict);
  assert(s.verdict === 'stale', '121 秒应为 stale：' + s.verdict);
  return `阈值 ${FRESH_SEC}s 两侧各一条`;
});

check('拿不到进程信息时不该崩，也不该乱猜', () => {
  const r = diagnoseLogs({ files: [file('a.gia', 3600)], procs: null, gilMtimeMs: null, now: NOW });
  assert(r.verdict === 'stale', 'verdict 不对');
  assert(r.facts.gameRunning === false, '拿不到应记为 false 而不是 true');
  assert(r.why.length >= 1, '没给任何原因');
  return 'procs=null 也能出结论';
});

check('地图比最近一局还旧时，不瞎说「你刚存过盘」', () => {
  const r = diagnoseLogs({
    files: [file('a.gia', 600)], procs: procs(true, true),
    gilMtimeMs: NOW - 7200 * 1000,   // 地图是 2 小时前存的，比日志还旧
    now: NOW,
  });
  assert(r.verdict === 'stale', 'verdict 不对');
  assert(!r.why.some((w) => /存过盘/.test(w)), '地图比日志还旧却说「你刚存过盘」—— 会误导');
  return '只在「地图确实更新」时才提存盘';
});

check('facts 把用到的证据都带出来（面板要显示，排障要看）', () => {
  const r = diagnoseLogs({
    files: [file('2026-09-23_18-44-57_151_201170108.gia', 600, 19485)],
    procs: procs(true, true), gilMtimeMs: NOW - 60000, now: NOW,
  });
  for (const k of ['logCount', 'newestName', 'newestShort', 'newestAgeSec', 'gameRunning', 'editorRunning', 'mapSavedAgeSec', 'freshThresholdSec']) {
    assert(k in r.facts, 'facts 缺字段：' + k);
  }
  assert(r.facts.newestShort === '18:44:57', '缩写不对：' + r.facts.newestShort);
  assert(r.facts.newestAgeSec === 600, 'ageSec 不对：' + r.facts.newestAgeSec);
  return Object.keys(r.facts).length + ' 个字段';
});

check('shortestSessionName：非常规文件名原样回退', () => {
  assert(shortestSessionName('2026-09-23_18-44-57_151_201170108.gia') === '18:44:57', '常规名解析错');
  assert(shortestSessionName('乱七八糟.gia') === '乱七八糟.gia', '非常规名应原样回退');
  assert(shortestSessionName('') === '', '空串应回空串');
  return '3 种形态';
});

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
