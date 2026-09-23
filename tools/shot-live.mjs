/**
 * tools/shot-live.mjs —— 截图工具的真机验收（**要游戏/编辑器真的开着**，不进 npm test）
 *
 * 为什么单独放这里：截图这件事的正确性**只有看图才知道**，单元测试能测的只有
 * 命名/清理规划/目录解析这些纯逻辑。「截到的到底是不是那个窗口」必须真跑一遍。
 *
 * 用法：
 *   node tools/shot-live.mjs            # 截游戏（YuanShen）
 *   node tools/shot-live.mjs editor     # 截千星沙箱编辑器
 *   node tools/shot-live.mjs --list     # 只看目录里有什么
 *   node tools/shot-live.mjs --cleanup  # 清理演练（dryRun）
 */

import { TOOLS } from '../index.js';

const shot = TOOLS.find((t) => t.name === 'miliastra_shot');
if (!shot) { console.error('没有 miliastra_shot 工具'); process.exit(1); }

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);

function show(title, obj) {
  console.log('\n=== ' + title + ' ===');
  console.log(JSON.stringify(obj, null, 1));
}

if (flag('--list')) {
  show('op=list', await shot.execute({ op: 'list' }, {}));
  process.exit(0);
}
if (flag('--cleanup')) {
  show('op=clean dryRun', await shot.execute({ op: 'clean', keepLast: 3, olderThanDays: 7 }, {}));
  process.exit(0);
}

show('op=targets', await shot.execute({ op: 'targets' }, {}));

const target = argv.find((a) => !a.startsWith('--')) || 'game';
const r = await shot.execute({ op: 'capture', target, label: 'smoke' }, {});
show('op=capture target=' + target, r);
if (r.ok && r.path) {
  console.log('\n→ 现在去看这张图：' + r.path);
  console.log('  （用 read_image / describe_image 看一眼，确认截到的是不是 ' + r.title + '）');
}
process.exit(r.ok ? 0 : 1);
