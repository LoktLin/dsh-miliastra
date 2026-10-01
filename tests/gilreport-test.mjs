/**
 * 离线节点图报告自测（`lib/gilreport.mjs` 纯函数 + `tools/gil-node-report.mjs` 落地那一层）。
 *
 * 为什么单开一个套件：报告是**给人看的长文**，它错了不会有任何报错 —— 只会让人照着错的数字做判断。
 * 所以这里**自己造一份 `.gil`**（字段号照实测布局），把「总览数字 / 逐图明细 / 连线谁连谁 /
 * 名字里带 `|` 的转义 / 未确证清单原样搬 / 不下判决 / 只读不改地图」逐条钉住，
 * 再用 **假 LocalLow**（两个账号都有同名关卡）钉住「不猜是哪张图，直接报错列候选」。
 *
 * ⚠️ 与其它套件同一条纪律：环境缺失（没有 Node / 没有临时目录）就**如实跳过**，不伪装通过。
 *
 * 用法：node tests/gilreport-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readGilNodeFacts } from '../lib/gilnodes.mjs';
import { buildNodeReport, reportStats, mdCell, nodeName, coordText, statsFingerprint } from '../lib/gilreport.mjs';
import { nodeById } from '../lib/nodedb.mjs';
import { scanLevels, pickCurrent } from '../lib/locate.mjs';

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const note = fn();
    pass += 1;
    console.log('  ✅ ' + name + (note ? '  → ' + note : ''));
  } catch (e) {
    failures.push(name + '：' + e.message);
    console.log('  ❌ ' + name + '  → ' + e.message);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), (msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));

/* ---------- 手搓 protobuf 编码器（只够造这份样本用，与 gilnodes-test 同款） ---------- */
const vi = (n) => { const out = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const tag = (no, wt) => vi(no * 8 + wt);
const vint = (no, n) => Buffer.concat([tag(no, 0), vi(n)]);
const bytes = (no, buf) => Buffer.concat([tag(no, 2), vi(buf.length), buf]);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...kids) => bytes(no, Buffer.concat(kids));
const f32 = (no, v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return Buffer.concat([tag(no, 5), b]); };
const loc = (domain, rid) => msg(2, vint(1, 10001), vint(2, domain), vint(3, 22000), vint(5, rid));

/**
 * 一个节点：`#1`=索引 · `#2`/`#3`=引用 · `#4`×N=**引脚实例**（每个 `#4` 里可挂多条 `#5` 连接）
 * · `#5`/`#6`=float32 坐标。`pins` = 引脚数组，每个引脚给一串「目标节点索引」。
 */
const node = (index, rid, x, y, pins) => msg(3,
  vint(1, index), loc(20000, rid), loc(20000, rid),
  ...(pins || []).map((conns) => msg(4,
    msg(1, vint(1, 2)), msg(2, vint(2, 2)),
    ...conns.map((to) => msg(5, vint(1, to), msg(2, vint(1, 1)), msg(3, vint(1, 1)))))),
  f32(5, x), f32(6, y));
/** 一张图：`#1{ #1=identity, #2=图名, #3×N=节点 }` */
const graph = (name, typeCode, kind, id, nodes) => msg(1,
  msg(1, msg(1, vint(1, 10000), vint(2, typeCode), vint(3, kind), vint(5, id)), str(2, name), ...nodes));
/** 实体：`#5[i].#1{ #1=id, #5{#1=1,#11=名字} }` */
const entity = (id, name) => msg(5, msg(1, vint(1, id), msg(5, vint(1, 1), str(11, name))));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-gilreport-'));
const LEVEL = '1073741999';
const gilPath = path.join(tmp, LEVEL + '.gil');
{
  // `#10.#4` 一条声明，让"声明计数"不为 0（报告总览里会印）
  const declEntry = msg(4, msg(1,
    msg(1, vint(1, 10000), vint(2, 20000), vint(3, 21002), vint(5, 1073741845)),
    msg(5, str(1, '名称')),
    str(11, '侦_名声')));
  const region10 = msg(10,
    graph('甲图', 20000, 21001, 1073741825, [
      node(1, 75, -156.5, -78.25, [[2]]),        // 词典命中（以GUID查询实体）+ 1 个引脚 1 条出边
      node(2, 999999, 0, 0, []),                 // 词典**没有**这个号 ⇒ 必须写「未知节点 999999」
      node(3, 13, 10.5, 20, [[1, 2]]),           // **一个引脚连两个目标**（真机实测这种最多：5693 引脚 / 1662 出边）
    ]),
    graph('乙|图', 20001, 21003, 1082130432, [    // 名字里的 `|` 是转义回归点
      node(1, 75, 1, 2, []),
      node(2, 424242, 3, 4, []),
    ]),
    graph('丙图', 20000, 21001, 1073741827, []), // 无节点（无图体）
    declEntry);
  const treeEntry = msg(1, vint(1, 800), msg(2, str(1, 'root'), vint(3, 1)),
    msg(3, str(1, '玩家模版'), vint(3, 2), msg(5, vint(1, 1700), vint(2, 1086324737))));
  const body = Buffer.concat([
    entity(1094713345, '关卡实体'),
    region10,
    msg(6, treeEntry),
  ]);
  const head = Buffer.alloc(20);
  head.writeUInt32BE(0x0326, 8);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(body.length, 16);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(0x0679, 0);
  fs.writeFileSync(gilPath, Buffer.concat([head, body, tail]));
}

const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const gilShaBefore = shaOf(gilPath);
const facts = readGilNodeFacts(gilPath, {});

/* ---------- ① 统计：一刀算清，总览与明细不许各算一份 ---------- */
check('① reportStats：图/节点/出边/命中/坐标/引脚 一次算对（含"有图记录但没节点列表"的口径）', () => {
  const st = reportStats(facts);
  eq(st.graphCount, 3, '图数');
  eq(st.graphWithNodes, 3, '有节点列表的图数');
  eq(st.nodeCount, 5, '节点数');
  eq(st.edgeCount, 3, '出边数（1 + 2）');
  eq(st.namedCount, 3, '官方名字命中数（75 / 13 / 75）');
  eq(st.unnamedCount, 2, '未命中数');
  eq(st.xyCount, 5, '带坐标数（主口径 = x、y 都有）');
  eq(st.xyBoth, 5, 'x、y 都有');
  eq(st.xyAny, 5, '任一有');
  eq(st.xyOnlyX + st.xyOnlyY, 0, '单边坐标');
  // ★ 复核 2026-10-01 第 3.2 条：`uniqueNodeIds` 是**全部**唯一号（4 种：75/13/999999/424242），
  //   不是"未命中的种数"（那是 2 种）—— 报告文案必须把两个数都写出来，别让人读成 4。
  eq(st.uniqueNodeIds, 4, '唯一号（全部）');
  eq(st.hitUniqueIds, 2, '命中的唯一号');
  eq(st.missUniqueIds, 2, '未收录的唯一号');
  eq(st.pinCount, 2, '引脚实例数');
  eq(st.nodesWithPins, 2, '有引脚的节点数');
  eq(st.duplicateGraphNames, [], '同名图');
  eq(st.declarationCount, 1, '节点声明数');
  return '3 图 / 5 节点 / 3 出边 / 命中 3 / 坐标 5 / 唯一号 4(=2 命中 + 2 未收录) / 引脚 2';
});

/* ---------- ①b 复核第 3.1 条：坐标两个口径 + 单边坐标点名 ---------- */
check('①b 只存一个坐标的节点：两个口径都报，并点名是哪个节点（数据事实，不是漏读）', () => {
  const one = {
    graphs: [{ name: '甲图', id: 1, typeCode: 20000, typeLabel: '关卡实体图', kindCode: 21001, hasBody: true }],
    graphNodeLists: { 甲图: [
      { index: 1, docId: 3, doc: { zh: '多分支', system: 'Server', domain: 'Control', pins: 3 }, x: -123, y: null, pinCount: 1, pins: [], outEdges: [] },
      { index: 2, docId: 1, doc: { zh: '打印字符串', system: 'Server', domain: 'Debug', pins: 2 }, x: 5, y: 6, pinCount: 0, pins: [], outEdges: [] },
    ] },
    unverified: [],
  };
  const st = reportStats(one);
  eq([st.xyBoth, st.xyAny, st.xyOnlyX, st.xyOnlyY], [1, 2, 1, 0], '坐标三口径');
  const t = buildNodeReport(one, { levelId: '1' });
  assert(t.includes('**x、y 都有** 1 / 2；任一有 2'), '总览没写两个口径：' + (t.split('\n').find((l) => l.includes('节点带坐标')) || ''));
  assert(/只存了 x：图「甲图」#1　多分支（x = -123）/.test(t), '没有点名那个只存 x 的节点');
  assert(/读取层只认字段 `#5`\(x\)\/`#6`\(y\) 的 float32/.test(t), '没写明"只有 #5 就是数据事实"（会被当成漏读）');
  // 两个口径都在附录 C 里讲清
  assert(/坐标两个口径/.test(t), '附录 C 没写坐标口径');
  return '都有 1 / 任一 2 + 点名 多分支 x=-123 + 口径写进附录 C';
});

/* ---------- ② 正文：该有的节都在，数字与事实一一对应 ---------- */
const md = buildNodeReport(facts, {
  levelId: LEVEL, gilPath, sha256: gilShaBefore, generatedAt: '2026-01-01T00:00:00.000Z',
  command: 'node tools/gil-node-report.mjs --level ' + LEVEL,
  fingerprint: statsFingerprint(reportStats(facts)),
});
check('② 正文骨架：标题 / 总览表 / 按类型 / 图一览 / 逐图明细 / 三个附录', () => {
  for (const s of ['# 节点图报告 · 关卡 ' + LEVEL, '## 0. 一页总览', '## 1. 按图类型分组', '## 2. 图一览',
    '## 3. 逐图明细', '## 附录 A：节点号 → 出现次数（前 40）', '## 附录 B：未确证清单', '## 附录 C：这份报告的口径']) {
    assert(md.includes(s), '缺这一节：' + s);
  }
  assert(md.includes(gilShaBefore.slice(0, 16) + '…'), '没写来源 sha');
  assert(md.includes('2026-01-01T00:00:00.000Z'), '没写生成时间');
  assert(md.includes('node tools/gil-node-report.mjs --level ' + LEVEL), '没写复现命令');
  assert(new RegExp('数据指纹：`' + statsFingerprint(reportStats(facts)) + '`').test(md), '没写数据指纹（--check 要靠它）');
  return '8 个节 + sha + 时间 + 复现命令 + 数据指纹';
});

check('③ 总览的数字与 reportStats 完全一致（不许两处各算一份）', () => {
  const st = reportStats(facts);
  assert(md.includes('| 节点 | ' + st.nodeCount + ' 个 |'), '总览的节点数不对');
  assert(md.includes('| 出边（连线） | ' + st.edgeCount + ' 条 |'), '总览的出边数不对');
  assert(md.includes('| 节点带坐标 | **x、y 都有** ' + st.xyBoth + ' / ' + st.nodeCount + '；任一有 ' + st.xyAny), '总览的坐标口径不对');
  assert(md.includes('官方名字命中词典 | ' + st.namedCount + ' / ' + st.nodeCount), '总览的命中文案不对');
  // ★ 复核第 3.2 条：三个数都要在场，且**未收录**那个数必须写成 missUniqueIds（不是 uniqueNodeIds）
  assert(/\*\*词典未收录\*\* 2 个，涉及 2 种号；本关节点用到的唯一号共 4 种 = 命中 2 \+ 未收录 2/.test(md),
    '总览的"未收录种数"文案不对（会让人把 4 读成未收录）：' + (md.split('\n').find((l) => l.includes('命中词典')) || ''));
  return '总览 = reportStats（含"唯一号 4 = 命中 2 + 未收录 2"）';
});

check('④ 逐图明细：图名锚点 + 节点表（官方名字/坐标/引脚/出边）+ 连线表（谁连谁）', () => {
  assert(md.includes('<a id="g1"></a>') && md.includes('<a id="g2"></a>') && md.includes('<a id="g3"></a>'), '缺自插锚点（点图名会跳不动）');
  assert(md.includes('### 图 1：甲图'), '缺第 1 张图的标题');
  assert(md.includes('| # | 节点（官方名字） | runtimeId | 系统 / 分类 | x | y | 引脚 | 出边 |'), '缺节点表表头');
  const d75 = nodeById(75);
  assert(d75 && md.includes(d75.zh), '词典命中 75 的官方名字没印出来（应当是 ' + (d75 && d75.zh) + '）');
  assert(md.includes('未知节点 999999'), '词典没命中的号没有如实说未知');
  assert(md.includes('| ' + coordText(-156.5) + ' | ' + coordText(-78.25) + ' |'), '坐标没按 1 位小数印（float32 尾巴没去掉）');
  // 连线表：谁连谁（两端都要能读）
  assert(md.includes('**连线**（连线 = 引脚实例字段 5 的字段 1 = 目标节点索引）'), '缺连线表说明');
  const edgeLine = md.split('\n').find((l) => l.includes('| #1 ' + d75.zh + ' |') && l.includes('| #2 '));
  assert(edgeLine, '连线表里没找到 "#1 甲图首节点 → #2" 那一行');
  // 一引脚连两个目标 ⇒ 两条边
  const toBoth = md.split('\n').filter((l) => l.includes('| #3 ') && l.includes('| #1 ')).length;
  assert(toBoth >= 1, '一引脚连多目标没有逐条列出');
  // 无图体那张要如实说
  assert(md.includes('### 图 3：丙图') && md.includes('（这张图没有节点。）'), '无图体的图没说清');
  return '锚点 + 节点表 + 词典命中/未命中 + 连线表 + 多目标';
});

check('⑤ 名字里带 `|` 的图名必须转义（否则表格被撕开）', () => {
  // 表格里必须是转义形态（标题那种不在表格里的原样给没问题）
  assert(md.includes('乙\\|图'), '图名里的竖线在表格里没转义：' + (md.split('\n').find((l) => l.includes('乙')) || ''));
  // 转义后每一行的列数应当一致（把转义竖线摘掉再数真正的分隔符）
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && l.includes('乙'));
  assert(rows.length > 0, '图一览里没找到那张带竖线的图');
  for (const r of rows) {
    const cols = r.replace(/\\\|/g, '').split('|').length - 2;
    assert(cols === 9, '图一览那行的列数不对（' + cols + '，应为 9）：' + r);
    assert(!/\[乙/.test(r), '带竖线的图名不该做成 Markdown 链接（链接语法会被反斜杠撕开）');
  }
  eq(mdCell('a|b\nc'), 'a\\|b c', 'mdCell 的转义/压行');
  return '竖线转义 + 列数不变 + 不做链接 + mdCell 压掉换行';
});

check('⑥ 未确证清单**原样搬**（不改写、不省略），且正文不下判决', () => {
  const un = facts.unverified || [];
  assert(un.length > 0, '（合成样本里读取层没报 unverified —— 这条就没得测了）');
  for (const u of un) assert(md.includes(u), '未确证的那句没原样搬进来：' + u.slice(0, 40) + '…');
  assert(!/✅|❌/.test(md), '报告里出现了对勾/叉（那是判决，不是事实）');
  assert(!/\bpass\b|\bverdict\b|\breachable\b/i.test(md), '报告里出现了判决词');
  assert(md.includes('不下"对不对 / 通不通"的判决'), '没写明"只报数字不下判决"');
  return un.length + '条未确证原样搬入 + 零判决词';
});

/* ---------- ⑥b 复核第 4.1 / 4.2 条：附录 A 表头与表格**不许自相矛盾** ---------- */
check('⑥b 附录 A：表头如实描述表格里的字面（原来自相矛盾）+ 写明词典自己缺号', () => {
  const apx = md.slice(md.indexOf('## 附录 A'), md.indexOf('## 附录 B'));
  // 表里印的是读取层的兜底文案「未知节点 <号>」⇒ 表头必须解释这一句，而不是承诺另一个词
  assert(/未知节点 `?<?号?>?`?/.test(apx) || apx.includes('未知节点 `<号>`'), '表头没解释表格里的「未知节点 <号>」');
  assert(apx.includes('不是**"这个节点不存在"**') || apx.includes('不是'), '没说明"未知节点 ≠ 节点不存在"');
  assert(!/命不中一律写「词典未收录」/.test(apx), '表头还留着"一律写词典未收录"那句自相矛盾的话');
  // 表格里的实际写法也要对得上（合成样本里 999999 / 424242 都没收录）
  assert(apx.includes('未知节点 999999') || apx.includes('未知节点 424242'), '附录 A 表里没印兜底文案');
  // 上游缺号（4）这件事要写出来，省掉下次一轮排查
  assert(/跳过 4|缺号/.test(apx), '没写明词典自己也有缺号（上游 runtimeId 跳过 4）');
  assert(nodeById(4) === null && nodeById(3), '词典形状变了？nodeById(4) 应当为 null、nodeById(3) 有名字');
  return '表头 = 表格字面 + 「未知节点 ≠ 节点不存在」+ 上游缺号说明';
});

check('⑦ 小工具：nodeName / coordText / mdCell 的边界（null、NaN、超长）', () => {
  eq(nodeName(null), '(无)', '空节点');
  eq(nodeName({ doc: null, docId: null }), '未命名节点（回执里没有 runtimeId）', '无号');
  eq(nodeName({ doc: { zh: '名字' }, docId: 1 }), '名字', '命中');
  eq(coordText(null), '?', '空坐标');
  eq(coordText(NaN), '?', 'NaN 坐标');
  eq(coordText(-0.04), '0', '极小数');
  eq(mdCell(null), '', '空单元');
  eq(mdCell('  a  '), 'a', '去首尾空白');
  return 'null / NaN / 极小数 / 空白';
});

/* ---------- ⑧ CLI：能读、能写、只读地图、dry-run 不落盘 ---------- */
const cli = (args, env) => spawnSync(process.execPath, ['tools/gil-node-report.mjs', ...args], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: Object.assign({}, process.env, env || {}),
  encoding: 'utf8',
});

check('⑧ CLI（--path）：写出报告、**地图一个字节都没变**、报头是无 BOM 的 UTF-8', () => {
  const out = path.join(tmp, 'report-a.md');
  const r = cli(['--path', gilPath, '--out', out]);
  assert(r.status === 0, 'CLI 退出码 ' + r.status + '：' + (r.stderr || '').slice(0, 300));
  assert(fs.existsSync(out), '报告没写出来');
  const buf = fs.readFileSync(out);
  assert(buf.slice(0, 3).toString('hex') !== 'efbbbf', '报告带 UTF-8 BOM（会脏 diff）');
  assert(buf.toString('utf8').startsWith('# 节点图报告 · 关卡 ' + LEVEL), '报告开头不对');
  eq(shaOf(gilPath), gilShaBefore, '⚠️ 读报告把地图改了 —— 这是最严重的一类错');
  assert(/节点 5 个 · 出边 3 条/.test(r.stdout), '打印的读数不对：' + r.stdout.split('\n')[4]);
  // 行数不许把结尾那个换行数成一行（复核时发现：3805 行的文件被印成 3806）
  const txt = buf.toString('utf8');
  const real = txt.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
  assert(new RegExp('\\b' + real + ' 行 /').test(r.stdout), '打印的行数与文件实际行数不一致（实际 ' + real + '）：'
    + (r.stdout.split('\n').pop() || ''));
  return Buffer.byteLength(buf) + ' 字节；地图 sha 不变；行数 ' + real + ' 如实';
});

/* ---------- ⑧b 复核第 6 条：`--check` ——"改了读取层/换了图，报告过期没有" ---------- */
check('⑧b CLI：`--check` 判"该不该重跑"（数字没变 ⇒ 仍然有效；数字变了 ⇒ 退出码 1）', () => {
  const out = path.join(tmp, 'report-chk.md');
  const gen = cli(['--path', gilPath, '--out', out]);
  assert(gen.status === 0, '先生成一份失败：' + gen.stderr);
  const fresh = cli(['--path', gilPath, '--out', out, '--check']);
  assert(fresh.status === 0, '--check 对刚生成的报告却报"该重跑"：' + fresh.stdout + fresh.stderr);
  assert(/仍然有效/.test(fresh.stdout), '--check 没说清结论：' + fresh.stdout);
  // ① 数字变了（换一份 .gil） ⇒ 必须报"该重跑"
  const otherPath = path.join(tmp, LEVEL + '-other', '1073741998.gil');
  fs.mkdirSync(path.dirname(otherPath), { recursive: true });
  fs.copyFileSync(gilPath, otherPath);   // 副本换个文件名 ⇒ levelId 随之变（1073741998）
  const stale = cli(['--path', otherPath, '--out', out, '--check']);
  assert(stale.status === 1, '换了图 --check 却没报过期（退出码 ' + stale.status + '）');
  assert(/该重跑了/.test(stale.stderr) && /1073741998/.test(stale.stderr), '过期提示没说清新旧关卡：' + stale.stderr);
  // ② 旧版报告（没有数据指纹） ⇒ 明确说"没有指纹，建议重跑"，不假装有效
  const legacy = path.join(tmp, 'report-legacy.md');
  fs.writeFileSync(legacy, '# 节点图报告 · 关卡 ' + LEVEL + '\n\n（旧版工具生成的，没有数据指纹）\n');
  const r3 = cli(['--path', gilPath, '--out', legacy, '--check']);
  assert(r3.status === 1 && /没有数据指纹/.test(r3.stderr), '旧版报告没有明确提示：' + r3.stderr);
  // ③ 没给 --out / 报告不存在 ⇒ 明确报错，别静默通过
  const r4 = cli(['--path', gilPath, '--check']);
  assert(r4.status === 1 && /--check 要配合 --out/.test(r4.stderr), '缺 --out 没报错：' + r4.stderr);
  const r5 = cli(['--path', gilPath, '--out', path.join(tmp, 'nope.md'), '--check']);
  assert(r5.status === 1 && /报告不存在/.test(r5.stderr), '报告不存在没报错：' + r5.stderr);
  return '有效 ⇒ 0；换图 ⇒ 1（点名新旧关卡）；无指纹 ⇒ 1；缺 --out/文件 ⇒ 1';
});

/* ---------- ⑧c 复核第 6 条的"对账"版：真 `.gil` 上**逐行**核（复核者说他没有核第 3 节） ---------- */
check('⑧c 真 `.gil`（有就核，没有就跳过）：逐图摘要 + 节点表行数 + 连线表行数 + 端点索引 全对得上', () => {
  const all = scanLevels().filter((l) => l.gil && l.gil.path);
  if (!all.length) return '环境里没有 .gil ⇒ 如实跳过（不伪装通过）';
  const lv = all.find((l) => l.levelId === ((pickCurrent(all) || {}).levelId)) || all[0];
  const f = readGilNodeFacts(lv.gil.path, {});
  const lines = buildNodeReport(f, { levelId: lv.levelId }).split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (l.startsWith('### 图 ')) starts.push(i); });
  const apx = lines.findIndex((l) => l.startsWith('## 附录 A'));
  if (apx > 0) starts.push(apx);
  const countRows = (block, h) => { let i = h + 2; let n = 0; while (i < block.length && block[i].startsWith('| ')) { n += 1; i += 1; } return n; };
  let graphs = 0; let nodeRows = 0; let edgeRows = 0;
  const bad = [];
  for (let s = 0; s + 1 < starts.length; s += 1) {
    const block = lines.slice(starts[s], starts[s + 1]);
    const name = block[0].replace(/^### 图 \d+：/, '').trim();
    const list = f.graphNodeLists[name] || [];
    const eReal = list.reduce((a, n) => a + (n.outEdges || []).length, 0);
    const head = block.findIndex((l) => l.startsWith('| # | 节点（官方名字）'));
    const eHead = block.findIndex((l) => l.startsWith('| 从 | → 到 |'));
    if (list.length) {
      if (head < 0) bad.push(name + ' 缺节点表');
      else { const n = countRows(block, head); nodeRows += n; if (n !== list.length) bad.push(name + ' 节点表 ' + n + ' ≠ ' + list.length); }
    }
    if (eReal) {
      if (eHead < 0) bad.push(name + ' 有出边却缺连线表');
      else { const n = countRows(block, eHead); edgeRows += n; if (n !== eReal) bad.push(name + ' 连线表 ' + n + ' ≠ ' + eReal); }
    }
    const orphan = block.filter((l) => l.startsWith('| #') && l.includes('不在本图节点表里'));
    if (orphan.length) bad.push(name + ' 连线表里有 ' + orphan.length + ' 个目标索引不在本图');
    graphs += 1;
  }
  assert(graphs > 0, '一份图都没切出来（标题锚点变了？）');
  assert(nodeRows > 0 && edgeRows > 0, '切出来的表是空的（节点 ' + nodeRows + ' 行 / 连线 ' + edgeRows + ' 行）');
  assert(!bad.length, '逐行对账不一致：' + bad.slice(0, 5).join(' ｜ '));
  return lv.levelId + '：' + graphs + ' 图 / ' + nodeRows + ' 行节点表 / ' + edgeRows + ' 行连线表 —— 逐行一致';
});

check('⑨ CLI：--dry-run 不落盘；--summary-only 没有明细而且**明说**没有', () => {  const out = path.join(tmp, 'report-dry.md');
  const r1 = cli(['--path', gilPath, '--out', out, '--dry-run']);
  assert(r1.status === 0, 'dry-run 退出码 ' + r1.status);
  assert(!fs.existsSync(out), '--dry-run 竟然写了文件');
  assert(/没有写盘/.test(r1.stdout), 'dry-run 没说明"没有写盘"');
  const out2 = path.join(tmp, 'report-sum.md');
  const r2 = cli(['--path', gilPath, '--out', out2, '--summary-only']);
  assert(r2.status === 0, 'summary-only 退出码 ' + r2.status);
  const t = fs.readFileSync(out2, 'utf8');
  assert(!t.includes('## 3. 逐图明细'), '--summary-only 竟然还是给了明细');
  assert(/第 3 节（逐图明细）/.test(t) && /--summary-only/.test(t), '--summary-only 没在正文里说明自己省了什么');
  assert(/没有第 3 节，所以这里\*\*不给跳转\*\*/.test(t), '图一览没跟着改口径（还会给出跳不动的链接）');
  return 'dry-run 零落盘 + summary-only 明说自己省了明细';
});

check('⑩ CLI：同名关卡在多个账号下都有 `.gil` ⇒ **报错列候选**，不猜（--account 才继续）', () => {
  const low = path.join(tmp, 'fakeLow', '原神', 'BeyondLocal');
  const mk = (acc, content) => {
    const d = path.join(low, acc, 'Beyond_Local_Save_Level', LEVEL);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, LEVEL + '.gil'), content);
  };
  const real = fs.readFileSync(gilPath);
  mk('111111111', real);
  mk('222222222', real);
  const env = { MILIASTRA_LOCALLOW: path.join(tmp, 'fakeLow') };
  const two = cli(['--level', LEVEL, '--out', path.join(tmp, 'x.md')], env);
  assert(two.status !== 0, '两个账号都有同名关卡时竟然照写了一份（猜了）');
  assert(/不猜/.test(two.stderr) && /111111111/.test(two.stderr) && /222222222/.test(two.stderr), '报错没把候选列清楚：' + two.stderr);
  const one = cli(['--level', LEVEL, '--account', '222222222', '--out', path.join(tmp, 'ok.md')], env);
  assert(one.status === 0, '--account 指定后仍然失败：' + one.stderr);
  assert(fs.existsSync(path.join(tmp, 'ok.md')), '--account 那一路没写出来');
  const bad = cli(['--level', '999999999', '--out', path.join(tmp, 'y.md')], env);
  assert(bad.status !== 0 && /扫不到关卡/.test(bad.stderr), '扫不到的关卡没有明确报错：' + bad.stderr);
  return '两账号 ⇒ 报错列候选；--account 指定 ⇒ 正常；扫不到 ⇒ 明确报错';
});

/* ---------- 汇总 ---------- */
console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
