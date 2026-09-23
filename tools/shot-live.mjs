/**
 * tools/shot-live.mjs —— 截图工具的真机验收（**要游戏/编辑器真的开着**，不进 npm test）
 *
 * 为什么单独放这里：截图这件事的正确性**只有看图才知道**，单元测试能测的只有
 * 命名/清理规划/目录解析/可信度判据这些纯逻辑。「截到的到底是不是那个窗口」必须真跑一遍。
 *
 * 用法：
 *   node tools/shot-live.mjs                      # 截游戏（YuanShen）
 *   node tools/shot-live.mjs editor               # 截千星沙箱编辑器（自动挑面积最大的窗口）
 *   node tools/shot-live.mjs editor --window 日志  # 进程有多个窗口时按标题挑
 *   node tools/shot-live.mjs --list                # 只看目录里有什么（含预览状态）
 *   node tools/shot-live.mjs --cleanup             # 清理演练（dryRun，不删）
 */

import fs from 'node:fs';
import { TOOLS } from '../index.js';
import { shotsDir, listShots, thumbIsFresh, thumbPathFor } from '../lib/shot.mjs';

const shot = TOOLS.find((t) => t.name === 'miliastra_shot');
if (!shot) { console.error('没有 miliastra_shot 工具'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const winIdx = argv.indexOf('--window');
const winVal = winIdx >= 0 ? argv[winIdx + 1] : '';

function show(title, obj) {
  console.log('\n=== ' + title + ' ===');
  console.log(JSON.stringify(obj, null, 1));
}

if (flag('--list')) {
  const s = listShots(shotsDir());
  console.log('截图目录: ' + s.dir);
  console.log('张数/占用: ' + s.count + ' 张 / ' + s.totalBytes + ' 字节');
  for (const f of s.files) {
    const th = thumbPathFor(shotsDir(), f.name);
    const fresh = thumbIsFresh(th, f.path);
    let thumbSize = '-';
    try { thumbSize = fs.statSync(th).size + 'B'; } catch { /* 没有预览 */ }
    console.log(`  ${f.name}  ${f.size}B  预览=${fresh ? thumbSize : '（无/过期）'}`);
  }
  show('op=list', await shot.execute({ op: 'list' }, {}));
  process.exit(0);
}
if (flag('--cleanup')) {
  show('op=clean dryRun', await shot.execute({ op: 'clean', keepLast: 3, olderThanDays: 7 }, {}));
  process.exit(0);
}

show('op=targets', await shot.execute({ op: 'targets' }, {}));

const target = argv.find((a) => !a.startsWith('--') && a !== winVal) || 'game';
const args = { op: 'capture', target, label: 'live' };
if (winVal) args.window = winVal;
const r = await shot.execute(args, {});
show('op=capture ' + JSON.stringify(args), r);

if (r.ok) {
  const th = thumbPathFor(shotsDir(), r.file);
  console.log('\n→ 原图: ' + r.path + '  (' + r.sizeText + ')');
  console.log('→ 预览: ' + (fs.existsSync(th) ? th + '  (' + fs.statSync(th).size + 'B)' : '（没生成）'));
  console.log('→ 缩略图路由: http://127.0.0.1:3080' + r.thumbUrl);
  console.log('  现在看图确认截到的是不是「' + r.title + '」，并核对预览是不是同一张');
}
process.exit(r.ok ? 0 : 1);
