/**
 * 截图模块测试
 *
 * 分三层：
 *   ① **纯函数**（命名 / 清理规划 / 目录解析 / 可信度判据）—— 这些是「删除」和「回执」的判据，
 *      判错了会删错文件或让人信一张错图，所以必须逐条钉住；
 *   ② **IO**（列举 / 删除）—— 在临时目录里跑真文件，不碰真截图目录；
 *   ③ **真机调用**（captureWindow）—— 只走**必定失败**的那条路：进程不存在。
 *      它证明「Node → PowerShell → JSON」这条链是通的、错误会被如实报出来，
 *      而且不依赖游戏有没有开着（不然测试就是碰运气）。
 *
 * 用法：node tests/shot-test.mjs
 * ⚠️ 不改任何米哈游存档；临时目录用完即删。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHOT_TARGETS, sanitizeLabel, stampOf, shotFileName, nextFreeName, isShotName, humanSize,
  planClean, judgeCapture, dataRoot, shotsDir, listShots, removeShots, captureWindow,
  thumbsDir, thumbPathFor, resolveShotFile, thumbIsFresh,
} from '../lib/shot.mjs';

let pass = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------------------------------------ ① 纯函数 */

ok('sanitizeLabel 保留中文', sanitizeLabel('双相-房间1') === '双相-房间1', sanitizeLabel('双相-房间1'));
ok('sanitizeLabel 去掉路径非法字符', sanitizeLabel('a/b\\c:d*e?f"g<h>i|j') === 'abcdefghij', sanitizeLabel('a/b\\c:d*e?f"g<h>i|j'));
ok('sanitizeLabel 空白折叠成 -', sanitizeLabel('控件  对齐') === '控件-对齐', sanitizeLabel('控件  对齐'));
ok('sanitizeLabel 去掉首尾的点与横线', sanitizeLabel('..--abc--..') === 'abc', sanitizeLabel('..--abc--..'));
ok('sanitizeLabel 截断到上限', sanitizeLabel('x'.repeat(50), 10).length === 10);
ok('sanitizeLabel 空值给空串', sanitizeLabel(null) === '' && sanitizeLabel(undefined) === '');
// 控制字符被删掉，中间的空白按规则折叠成 '-'（两个控制字符夹着的空格就是 `ab c` → `ab-c`）
ok('sanitizeLabel 去掉控制字符', sanitizeLabel('a\u0001b\u007f c') === 'ab-c', sanitizeLabel('a\u0001b\u007f c'));

{
  const s = stampOf(new Date(2026, 8, 23, 20, 49, 5));
  ok('stampOf 本地时间格式', s === '20260923-204905', s);
  ok('stampOf 补零', stampOf(new Date(2026, 0, 2, 3, 4, 5)) === '20260102-030405', stampOf(new Date(2026, 0, 2, 3, 4, 5)));
}

{
  const when = new Date(2026, 8, 23, 20, 49, 5);
  ok('shotFileName 无标签', shotFileName({ target: 'game', when }) === 'game-20260923-204905.png', shotFileName({ target: 'game', when }));
  ok('shotFileName 带中文标签', shotFileName({ target: 'game', label: '试玩第1局', when }) === 'game-试玩第1局-20260923-204905.png',
    shotFileName({ target: 'game', label: '试玩第1局', when }));
  ok('shotFileName seq>0 加后缀', shotFileName({ target: 'game', when, seq: 1 }) === 'game-20260923-204905-2.png',
    shotFileName({ target: 'game', when, seq: 1 }));
  ok('shotFileName 标签非法字符被清掉', shotFileName({ target: 'game', label: 'a/b', when }) === 'game-ab-20260923-204905.png',
    shotFileName({ target: 'game', label: 'a/b', when }));
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mshot-name-'));
  ok('nextFreeName 空闲时原样', nextFreeName(tmp, 'a.png') === 'a.png');
  fs.writeFileSync(path.join(tmp, 'a.png'), 'x');
  ok('nextFreeName 占用时加 -2', nextFreeName(tmp, 'a.png') === 'a-2.png', nextFreeName(tmp, 'a.png'));
  fs.writeFileSync(path.join(tmp, 'a-2.png'), 'x');
  fs.writeFileSync(path.join(tmp, 'a-3.png'), 'x');
  ok('nextFreeName 连续占用跳到 -4', nextFreeName(tmp, 'a.png') === 'a-4.png', nextFreeName(tmp, 'a.png'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

ok('isShotName 只认 png', isShotName('a.png') && isShotName('A.PNG') && !isShotName('a.jpg') && !isShotName('a.png.bak'));
ok('humanSize B', humanSize(512) === '512 B', humanSize(512));
ok('humanSize KB', humanSize(2048) === '2.0 KB', humanSize(2048));
ok('humanSize MB', humanSize(2527694) === '2.4 MB', humanSize(2527694));
ok('humanSize GB', humanSize(3 * 1024 * 1024 * 1024) === '3.00 GB', humanSize(3 * 1024 * 1024 * 1024));
ok('humanSize 非数字当 0', humanSize(undefined) === '0 B', humanSize(undefined));

/* ---- 清理规划：删除是不可恢复的，逐条钉 ---- */
{
  const now = Date.parse('2026-09-23T12:00:00Z');
  const mk = (n, daysAgo, size) => ({
    name: n, path: 'D:\\x\\' + n, size,
    mtimeMs: now - daysAgo * 86400000, mtime: new Date(now - daysAgo * 86400000).toISOString(),
  });
  const files = [mk('new1.png', 0, 100), mk('new2.png', 1, 200), mk('old1.png', 10, 300), mk('old2.png', 30, 400)];

  const none = planClean({ files, now });
  ok('既不给 all 也不给 days → 一张都不删', none.delete.length === 0 && none.keep.length === 4, JSON.stringify(none.delete));
  ok('     且说明白了为什么', /不知道你要删哪些/.test(none.note), none.note);

  const all = planClean({ files, all: true, now });
  ok('all=true 全删', all.delete.length === 4, '删了 ' + all.delete.length);
  ok('all=true 体积求和', all.bytes === 1000, String(all.bytes));

  const keep2 = planClean({ files, all: true, keepLast: 2, now });
  ok('all=true + keepLast=2 → 保留最新 2 张', keep2.delete.length === 2 && keep2.keep.length === 2, JSON.stringify(keep2.keep.map((f) => f.name)));
  ok('     保留的是最新的那两张', keep2.keep.map((f) => f.name).sort().join(',') === 'new1.png,new2.png', keep2.keep.map((f) => f.name).join(','));

  const old7 = planClean({ files, olderThanDays: 7, now });
  ok('olderThanDays=7 只删 7 天前的', old7.delete.map((f) => f.name).sort().join(',') === 'old1.png,old2.png', old7.delete.map((f) => f.name).join(','));
  ok('     keepLast 同时生效时不误删', planClean({ files, olderThanDays: 7, keepLast: 4, now }).delete.length === 0);

  const empty = planClean({ files: [], all: true, now });
  ok('空列表不炸', empty.delete.length === 0 && empty.bytes === 0);
  ok('note 会报数量与体积', /将删除 2 张/.test(old7.note) && /700 B|0\.7 KB/.test(old7.note), old7.note);
}

/* ---- 截图可信度判据：抓错程序就是从这里漏出去的 ---- */
{
  ok('judgeCapture 失败即 suspect', judgeCapture({ ok: false, error: 'x' }).suspect === true);
  ok('judgeCapture 失败带原因', judgeCapture({ ok: false, error: 'x' }).warning === 'x');
  ok('printwindow + 正常黑比 → 不可疑',
    judgeCapture({ ok: true, mode: 'printwindow', width: 1456, height: 939, blackRatio: 0.03, uniformRatio: 0.03 }).suspect === false);
  ok('全黑 → suspect', judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 800, blackRatio: 0.99 }).suspect === true);
  ok('screen + 不在前台 → suspect（这就是抓错浏览器那次）',
    judgeCapture({ ok: true, mode: 'screen', width: 900, height: 800, blackRatio: 0.02, front: false }).suspect === true);
  const scr = judgeCapture({ ok: true, mode: 'screen', width: 900, height: 800, blackRatio: 0.02, uniformRatio: 0.02, front: true });
  ok('screen + 在前台 → 不可疑但要留话', scr.suspect === false && /屏幕抓取/.test(scr.warning), String(scr.warning));
  ok('黑比 NaN 不误判', judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 800, blackRatio: NaN }).suspect === false);

  // —— 实测踩到的第二个坑：160×28 的标题栏碎片，当时照样是 ok:true ——
  const tiny = judgeCapture({ ok: true, mode: 'printwindow', width: 160, height: 28, blackRatio: 0, uniformRatio: 0.09 });
  ok('尺寸小得离谱 → suspect', tiny.suspect === true && /160×28/.test(tiny.warning), String(tiny.warning));
  ok('宽度不够也算小', judgeCapture({ ok: true, mode: 'printwindow', width: 199, height: 800, blackRatio: 0 }).suspect === true);
  ok('高度不够也算小', judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 149, blackRatio: 0 }).suspect === true);
  ok('刚好到门槛不算小', judgeCapture({ ok: true, mode: 'printwindow', width: 200, height: 150, blackRatio: 0, uniformRatio: 0 }).suspect === false);

  // —— 实测踩到的第三个坑：**全白**能通过黑像素检查，必须单独量「单一颜色」比例 ——
  const blank = judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 800, blackRatio: 0, uniformRatio: 1 });
  ok('单一颜色（全白空图）→ suspect', blank.suspect === true && /单一颜色/.test(blank.warning), String(blank.warning));
  ok('      且说明白了「全黑检查抓不到全白」', /全白/.test(blank.warning));
  ok('有内容的图不会被误判成空图',
    judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 800, blackRatio: 0, uniformRatio: 0.09 }).suspect === false);
  ok('uniformRatio 缺失时不误判', judgeCapture({ ok: true, mode: 'printwindow', width: 900, height: 800, blackRatio: 0 }).suspect === false);
}

/* ---- 缩略图路径 +「只读截图目录」的路径守卫 ---- */
{
  ok('thumbsDir 是截图目录下的 _thumbs',
    thumbsDir('C:\\x\\shots') === path.join('C:\\x\\shots', '_thumbs'), thumbsDir('C:\\x\\shots'));
  ok('thumbPathFor 同名放进 _thumbs',
    thumbPathFor('C:\\x\\shots', 'game-a.png') === path.join('C:\\x\\shots', '_thumbs', 'game-a.png'),
    thumbPathFor('C:\\x\\shots', 'game-a.png'));

  const dir = 'C:\\x\\shots';
  ok('resolveShotFile 正常名字放行', resolveShotFile(dir, 'game-a.png').ok === true);
  ok('resolveShotFile 拒绝 ..\\', resolveShotFile(dir, '..\\a.png').ok === false);
  ok('resolveShotFile 拒绝 子目录\\', resolveShotFile(dir, 'sub\\a.png').ok === false);
  ok('resolveShotFile 拒绝正斜杠', resolveShotFile(dir, '../a.png').ok === false);
  ok('resolveShotFile 拒绝绝对路径', resolveShotFile(dir, 'C:\\windows\\a.png').ok === false);
  ok('resolveShotFile 拒绝非 png', resolveShotFile(dir, 'a.txt').ok === false);
  ok('resolveShotFile 拒绝空', resolveShotFile(dir, '').ok === false);
  ok('resolveShotFile 拒绝 `..`', resolveShotFile(dir, '..').ok === false);
  ok('resolveShotFile 结果确实在目录内',
    path.dirname(resolveShotFile(dir, 'a.png').path) === path.resolve(dir));

  // 缩略图新鲜度：比原图旧 = 要重做（不然改过的图会一直显示旧预览）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mshot-thumb-'));
  const src = path.join(tmp, 'a.png'); const th = path.join(tmp, 't.png');
  fs.writeFileSync(src, 'x');
  ok('缩略图不存在 → 不新鲜', thumbIsFresh(th, src) === false);
  fs.writeFileSync(th, '');
  ok('缩略图是空文件 → 不新鲜', thumbIsFresh(th, src) === false);
  fs.writeFileSync(th, 'yy');
  const nowT = Date.now() / 1000;
  fs.utimesSync(th, nowT, nowT);
  fs.utimesSync(src, nowT - 10, nowT - 10);   // 原图更旧 → 预览算新鲜
  ok('缩略图比原图新 → 新鲜', thumbIsFresh(th, src) === true);
  fs.utimesSync(src, nowT + 10, nowT + 10);   // 原图更新 → 预览过期
  ok('原图更新后 → 过期（会重新生成）', thumbIsFresh(th, src) === false);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---- 目录解析 ---- */
{
  ok('MILIASTRA_DATA_DIR 优先', dataRoot({ MILIASTRA_DATA_DIR: 'D:\\shots-here' }, 'C:\\u') === path.resolve('D:\\shots-here'),
    dataRoot({ MILIASTRA_DATA_DIR: 'D:\\shots-here' }, 'C:\\u'));
  ok('DSH_HOME 次之', dataRoot({ DSH_HOME: 'D:\\dsh' }, 'C:\\u') === path.join('D:\\dsh', 'miliastra'),
    dataRoot({ DSH_HOME: 'D:\\dsh' }, 'C:\\u'));
  ok('都没有 → ~/.dsh/miliastra', dataRoot({}, 'C:\\Users\\x') === path.join('C:\\Users\\x', '.dsh', 'miliastra'),
    dataRoot({}, 'C:\\Users\\x'));
  ok('shotsDir 在 dataRoot 下的 shots\\',
    shotsDir({ env: { MILIASTRA_DATA_DIR: 'D:\\s' } }) === path.join(path.resolve('D:\\s'), 'shots'));
}

/* ------------------------------------------------------------ ② IO */

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mshot-io-'));
  const missing = listShots(path.join(tmp, 'nope'));
  ok('listShots 目录不存在 → 空且不抛', missing.exists === false && missing.count === 0 && missing.files.length === 0);

  fs.writeFileSync(path.join(tmp, 'a.png'), Buffer.alloc(100));
  fs.writeFileSync(path.join(tmp, 'b.png'), Buffer.alloc(200));
  fs.writeFileSync(path.join(tmp, 'ignore.txt'), 'x');
  fs.mkdirSync(path.join(tmp, 'sub.png'));   // 目录名叫 .png，不能被当成截图

  const s = listShots(tmp);
  ok('listShots 只收 .png 文件', s.count === 2, 'count=' + s.count);
  ok('     忽略非 png 与同名目录', !s.files.some((f) => f.name === 'ignore.txt' || f.name === 'sub.png'));
  ok('listShots 体积求和', s.totalBytes === 300, String(s.totalBytes));
  ok('listShots 新的在前', s.files[0].name === 'b.png', s.files.map((f) => f.name).join(','));
  ok('listShots 带 ISO 时间', Number.isFinite(Date.parse(s.files[0].mtime)));

  const del = removeShots([path.join(tmp, 'a.png'), path.join(tmp, '不存在.png')]);
  ok('removeShots 删掉真实存在的', del.removed.length === 1, String(del.removed.length));
  ok('removeShots 失败进 failed 而不是抛', del.failed.length === 1 && /不存在\.png/.test(del.failed[0].path), JSON.stringify(del.failed));
  ok('removeShots 之后列表少一张', listShots(tmp).count === 1);

  // 删截图要连预览一起删，否则 _thumbs 里会攒一堆孤儿文件
  const b = path.join(tmp, 'b.png');
  fs.mkdirSync(thumbsDir(tmp), { recursive: true });
  fs.writeFileSync(thumbPathFor(tmp, 'b.png'), 'preview');
  const del2 = removeShots([b]);
  ok('removeShots 顺带删掉对应预览', del2.removed.length === 1 && del2.thumbsRemoved.length === 1, JSON.stringify(del2));
  ok('      预览文件真的没了', !fs.existsSync(thumbPathFor(tmp, 'b.png')));
  // 没有预览的截图也要能正常删（不是每张都生成过预览）
  fs.writeFileSync(path.join(tmp, 'c.png'), 'x');
  const del3 = removeShots([path.join(tmp, 'c.png')]);
  ok('没有预览时也照删不误报失败', del3.removed.length === 1 && del3.failed.length === 0 && del3.thumbsRemoved.length === 0, JSON.stringify(del3));
  // _thumbs 目录本身不能被当成一张截图
  ok('listShots 不会把 _thumbs 目录算成截图', listShots(tmp).files.every((f) => f.name !== '_thumbs'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* --------------------------------------------- ③ 真机调用（只走失败路径） */

{
  const r = await captureWindow({ processName: 'NoSuchProcess_ZZZ_' + process.pid, out: path.join(os.tmpdir(), 'never.png') });
  ok('captureWindow 对不存在的进程 → ok:false', r.ok === false, JSON.stringify(r));
  ok('     带出可读的错误', typeof r.error === 'string' && r.error.length > 0, String(r.error));
  ok('     没留下半张图', !fs.existsSync(path.join(os.tmpdir(), 'never.png')));

  const bad = await captureWindow({ processName: 'YuanShen', out: path.join(os.tmpdir(), 'never2.png'), script: 'D:\\nope\\nope.ps1' });
  ok('captureWindow 脚本不存在 → ok:false（不静默）', bad.ok === false, JSON.stringify(bad).slice(0, 200));
}

/* ------------------------------------------------------------ 目标表 */

{
  ok('SHOT_TARGETS 有 game 与 editor', !!SHOT_TARGETS.game && !!SHOT_TARGETS.editor);
  ok('SHOT_TARGETS 带进程名与说明', SHOT_TARGETS.game.process === 'YuanShen' && typeof SHOT_TARGETS.game.why === 'string');
  ok('目标不含 .exe 后缀', Object.values(SHOT_TARGETS).every((t) => !/\.exe$/i.test(t.process)));
}

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
