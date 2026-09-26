/**
 * 第二批反馈修复的自测（同事实测清单 ①~⑧）
 *
 * 八条各自「修之前为什么红」都写在对应的那一段上面 —— 这个文件里的每一条断言，
 * 都是为了**在未来某次改动里重新变红**而写的（不是"跑一遍看有没有报错"）。
 *
 * 全部用**合成的假存档 / 假活文件 / 假日志**（`MILIASTRA_LOCALLOW` + `MILIASTRA_DATA_DIR` 指到临时目录），
 * 不碰真机的活文件、地图与截图；需要真机的两条（① 的不变量、⑤ 的体积）在**读不到就跳过**。
 *
 * 用法：node tests/feedback2-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ 作用域隔离
 * ⚠️ `MILIASTRA_DATA_DIR` **必须在 import 之前设好**（sim.mjs 在模块初始化时读它来决定
 * 模拟器工作区 / 截图目录）——所以下面全部用动态 import。
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fb2-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedData = process.env.MILIASTRA_DATA_DIR;
const savedBak = process.env.MILIASTRA_BACKUP_DIR;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');
process.env.MILIASTRA_BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.QXQY_PLAY_TIMEOUT_MS = '2000';

let pass = 0;
const failures = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const { TOOLS, clientUiHint, CLIENTUI_EVIDENCE } = await import('../index.js');
const { simOp, mountHierarchy, AUTO_KIND_ORDER, kindMismatchHint } = await import('../lib/sim.mjs');
const { groupRuns } = await import('../lib/gia.mjs');
const { playtestSummary, createPlaytestState, reduceLogLines, closedMeaningOf, CLOSED_MEANINGS } = await import('../lib/playtest.mjs');
const { mountStatusOf } = await import('../lib/gil.mjs');
const { PROBE_TEMPLATE_CHOICES, PROBE_TEMPLATES, renderProbe } = await import('../lib/probes.mjs');

const health = TOOLS.find((t) => t.name === 'miliastra_health');
const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');
const logTool = TOOLS.find((t) => t.name === 'miliastra_log');
const playtestTool = TOOLS.find((t) => t.name === 'miliastra_playtest');
const probeTool = TOOLS.find((t) => t.name === 'miliastra_probe');

/* ------------------------------------------------------------------ 合成 .gil / .gia */

const pbVarint = (n) => {
  const out = [];
  let v = Number(n);
  do { let x = v & 0x7f; v = Math.floor(v / 128); if (v > 0) x |= 0x80; out.push(x); } while (v > 0);
  return Buffer.from(out);
};
const pbKey = (no, wt) => pbVarint(no * 8 + wt);
const pbBytes = (no, buf) => Buffer.concat([pbKey(no, 2), pbVarint(buf.length), buf]);
const pbStr = (no, s) => pbBytes(no, Buffer.from(s, 'utf8'));
const pbNum = (no, n) => Buffer.concat([pbKey(no, 0), pbVarint(n)]);

/** 合成 `.gil`：只造 `readGil` 真会读的字段（同 locate-test 的口径）。 */
function makeGil({ levelId, name = '假图', account = 201170108, version = '7.1.0', scriptName, scriptFile, source = '-- x\n' }) {
  const inner = Buffer.concat([
    pbNum(1, 1073741825), pbStr(2, scriptName), pbStr(3, scriptFile), pbBytes(5, Buffer.from(source, 'utf8')),
  ]);
  const body = Buffer.concat([
    pbNum(1, levelId), pbStr(2, name), pbNum(39, account), pbStr(43, version), pbBytes(50, pbBytes(1, inner)),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
}

/** 合成 `.gia`：8 字节包头 + 每条记录一个 `#1` 子消息（`#4` 时间 / `#11` 渠道 / `#23` 正文）。 */
function makeGia(records) {
  const recs = records.map((r) => pbBytes(1, Buffer.concat([
    pbStr(4, r.time || '2026/09/25_10:00:00'),
    pbNum(5, 201170108),
    pbBytes(11, pbStr(2, '假图')),
    pbBytes(23, pbStr(2, r.message)),
  ])));
  return Buffer.concat([Buffer.alloc(8), ...recs]);
}

/** 造一个假 LocalLow 关卡目录，返回 `{root, levelDir, luaDir}`。 */
function fakeLevel({ brand = '原神', account = '201170108', levelId, gils = [], luas = {}, logs = {} }) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'low-'));
  const levelDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Local_Save_Level', levelId);
  const luaDir = path.join(levelDir, 'external_lua_file');
  fs.mkdirSync(luaDir, { recursive: true });
  for (const g of gils) fs.writeFileSync(path.join(levelDir, levelId + '.gil'), g);
  for (const [name, text] of Object.entries(luas)) fs.writeFileSync(path.join(luaDir, name), text, 'utf8');
  const logDir = path.join(root, brand, 'BeyondLocal', account, 'Beyond_Debug_Log');
  if (Object.keys(logs).length) {
    fs.mkdirSync(logDir, { recursive: true });
    for (const [name, buf] of Object.entries(logs)) fs.writeFileSync(path.join(logDir, name), buf);
  }
  return { root, levelDir, luaDir, logDir };
}

const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
/** 按句读切开 —— 把「本关 + 外来号**同框**」变成可断言的形状。 */
const sentencesOf = (s) => String(s || '').split(/[。；\n]/).map((x) => x.trim()).filter(Boolean);

/* ================================================================== ① clientui 的 hint 不许拿别的关卡的号说「本关」 */

/*
 * 修之前为什么红：`op=clientui` 的 hint 写死了一句「实测佐证：**本关** 1073741867(文本框) / 1073741868(图片) 可创建」，
 * 而这两个号来自**另一张图**的实测 —— 本关读到的模板是 1073741850/1852。hint 里「本关」与外来号同框 = 假事实。
 */
await check('① 本关模板 ≠ 硬编码证据时：hint **不把外来号说成「本关」**，且写明来源', async () => {
  const hint = clientUiHint({
    levelId: '1073741850',
    likelyTemplates: [{ id: 1073741850, name: '文本框' }, { id: 1073741852, name: '图片' }],
  });
  const mixed = sentencesOf(hint).filter((s) => /本关/.test(s) && /1073741867|1073741868/.test(s));
  assert(mixed.length === 0, '还有「本关 + 外来号」同框的句子：' + JSON.stringify(mixed));
  assert(/来自关卡 1073741833 的实测/.test(hint), '没写明那些号来自哪个关卡：' + hint);
  assert(/本关读到的/.test(hint) && /1073741850/.test(hint), '本关自己的数据没报出来：' + hint);
  return '外来号只出现在「来源：关卡 1073741833」那一句里，本关这一句只报 1073741850/1852';
});

await check('① + 只有当前关卡**就是**那次实测的图时，才允许说「本关」', async () => {
  const hint = clientUiHint({ levelId: CLIENTUI_EVIDENCE.levelId, likelyTemplates: [{ id: 1073741867, name: '文本框' }] });
  const s = sentencesOf(hint).find((x) => x.includes('1073741867'));
  assert(s && /本关/.test(s), '证据关卡自己的图上应当可以说「本关」：' + s);
  assert(!/不是本关的/.test(hint), '证据关卡上不该再挂「不是本关的」这句警告：' + hint);
  return 'levelId=' + CLIENTUI_EVIDENCE.levelId + ' → 允许「本关」，且没有那句「不是本关的」警告';
});

await check('① 本关一个模板都没读到 → 如实说没有（不拿外来号充数）', async () => {
  const hint = clientUiHint({ levelId: '1073741999', likelyTemplates: [] });
  assert(/本关没有读到/.test(hint), '没如实说本关没有：' + hint);
  assert(/来自关卡 1073741833 的实测/.test(hint), '没给来源：' + hint);
  return '本关 0 条 → 「本关没有读到」+ 来源标注';
});

await check('① 集成（真机有 .gil 就查不变量）：hint 里没有「本关 + 外来号」同框', async () => {
  let r = null;
  try { r = await mapTool.execute({ op: 'clientui', summaryOnly: true }, {}); } catch (e) { /* 本机没有 .gil → 跳过 */ }
  if (!r || !r.ok) return '跳过：这台机器上读不到 .gil（' + ((r && r.error) || '没试玩过/没存盘') + '）';
  // ⚠️ 本机这张图**就是**那次实测的图时，说「本关」是对的 —— 那时不适用这条不变量
  if (String(r.level && r.level.id) === String(CLIENTUI_EVIDENCE.levelId)) {
    return '跳过不变量：本机这张图（' + r.level.id + '）**就是**那次实测的图 —— 说「本关」是对的';
  }
  const ids = CLIENTUI_EVIDENCE.creatable.map((c) => c.id).concat(['1073741863']);
  const mixed = sentencesOf(r.hint).filter((s) => /本关/.test(s) && ids.some((i) => s.includes(String(i))));
  assert(mixed.length === 0, '真机回执里还有同框：' + JSON.stringify(mixed));
  return 'levelId=' + r.level + '，hint ' + r.hint.length + ' 字，无同框';
});

/* ================================================================== ② errorKinds 要说清命中了哪些词 */

/*
 * 修之前为什么红：`errorSample` 只有正文字符串，`errorKinds: 2` 只说「有两种错」，
 * **说不出命中的是哪两个词** —— 同事没法判断该不该信这条归类。
 */
await check('② errorSample[].matched：真命中的词都报出来、没命中的一个都不许出现', async () => {
  const I = '47504-201170108-1790170177-5403';
  const runs = groupRuns([
    { index: 0, instance: I, message: '[A] 失败：这一句里有「失败」' },
    { index: 1, instance: I, message: "[A] attempt to call a nil value (global 'x')" },
    { index: 2, instance: I, message: '[A] 落出边界 -> 重生' },
  ]);
  const r = runs[0];
  const byLine = new Map(r.errorSample.map((x) => [x.line, x.matched]));
  assert(r.errorSample.every((x) => Array.isArray(x.matched)), 'errorSample 每项都要带 matched：' + JSON.stringify(r.errorSample));
  const failed = byLine.get('[A] 失败：这一句里有「失败」');
  assert(failed && failed.join(',') === '失败', '「失败」那行的命中词不对：' + JSON.stringify(failed));
  assert(!failed.some((w) => /nil value|attempt to|error|异常/.test(w)), '报了没命中的词：' + JSON.stringify(failed));
  const nilLine = byLine.get("[A] attempt to call a nil value (global 'x')");
  assert(nilLine && nilLine.includes('attempt to') && nilLine.includes('nil value'),
    '一行命中多个词时要都报：' + JSON.stringify(nilLine));
  // 行内按**词表顺序**（表里 nil value 排在 attempt to 前面，与原正则的先后一致）、行间按**首次出现**
  assert(r.errorMatched.join(',') === '失败,nil value,attempt to', '总览词表不对：' + JSON.stringify(r.errorMatched));
  assert(r.faultMatched.join(',') === '落出边界,重生', 'fault 的词表不对：' + JSON.stringify(r.faultMatched));
  return 'errorSample 逐行 matched=' + JSON.stringify([...byLine.values()]) + '；总览 errorMatched=' + r.errorMatched.join(',');
});

await check('② 计数判据没被动过：errorKinds 仍是「去重后的错误行数」', async () => {
  const I = '47504-201170108-1790170177-5403';
  const r = groupRuns([
    { index: 0, instance: I, message: "[A] attempt to call a nil value (global 'x')" },
    { index: 1, instance: I, message: "[A] attempt to call a nil value (global 'x')" },
    { index: 2, instance: I, message: '[A] 另一处 error 了' },
  ])[0];
  assert(r.errorKinds === 2, 'errorKinds 变了：' + r.errorKinds);
  assert(r.errorLines.length === 3, 'errorLines 变了：' + r.errorLines.length);
  assert(r.errorSample.length === 2, 'errorSample 去重坏了：' + r.errorSample.length);
  assert(r.errorMatched.join(',') === 'nil value,attempt to,error', '总览词表不对：' + JSON.stringify(r.errorMatched));
  return 'errorKinds=2 / errorLines=3 / errorSample=2（与修改前一致）+ errorMatched 三种词';
});

/* ================================================================== ③ closed 枚举要有解释 */

/*
 * 修之前为什么红：回执里只有 `lastRun.closed: "implicit"`，没有任何解释 —— 读的人只能猜。
 * ⚠️ 只加说明，判据（seen / implicit 的含义与产生条件）一个字不改。
 */
await check('③ closed 两种取值都有人话说明，且 implicit 点出「没看到结束标记」', async () => {
  const seen = closedMeaningOf('seen');
  const implicit = closedMeaningOf('implicit');
  assert(seen && seen.length > 10, 'seen 没有说明：' + seen);
  assert(/看到/.test(seen) && /结束标记/.test(seen), 'seen 的说明不对：' + seen);
  assert(implicit && /没看到显式结束标记/.test(implicit), 'implicit 的说明不对：' + implicit);
  assert(/杀进程|切场景|关窗口/.test(implicit), 'implicit 没点出常见原因：' + implicit);
  assert(closedMeaningOf('没见过的值') === null, '没见过的取值应当如实回 null（不许编）');
  assert(Object.keys(CLOSED_MEANINGS).sort().join(',') === 'implicit,seen', '取值表多了/少了：' + Object.keys(CLOSED_MEANINGS));
  return 'seen / implicit 都有说明；未知取值 → null';
});

await check('③ 摘要里带上「最后那局的 closed 是什么意思」+ 全表', async () => {
  const I = '47504-201170108-1790169819-1234';
  const L = (m) => `[2026-09-25 10:00:0${m}.000] Genshin Loading Log: BeyondLevelPlayModule SetCurLevelData isTrial:True`;
  const s = reduceLogLines(createPlaytestState(), [L(1), L(2)]).state;   // 连续两次开跑 → 前一句隐式收尾
  const sum = playtestSummary(s, Date.now());
  assert(sum.lastRun && sum.lastRun.closed === 'implicit', '夹具没造出 implicit：' + JSON.stringify(sum.lastRun));
  assert(sum.closedMeaning === CLOSED_MEANINGS.implicit, 'closedMeaning 没跟着 lastRun 走：' + sum.closedMeaning);
  assert(sum.closedMeanings && sum.closedMeanings.seen, '没带全表：' + JSON.stringify(sum.closedMeanings));
  assert(I.length > 0, '');
  return 'lastRun.closed=implicit → closedMeaning 就是 implicit 的说明 + closedMeanings 两个值都在';
});

await check('③ 集成：miliastra_playtest op=status 的回执里带着这张说明表', async () => {
  let r = null;
  try { r = await playtestTool.execute({ op: 'status' }, {}); } catch (e) { return '跳过：本机读不到 output_log.txt（' + e.message.slice(0, 40) + '）'; }
  assert('closedMeaning' in r, 'op=status 没带 closedMeaning');
  assert(r.closedMeanings && /没看到显式结束标记/.test(r.closedMeanings.implicit), 'op=status 的表里没有 implicit 的说明');
  return 'op=status：closedMeaning=' + JSON.stringify(r.closedMeaning) + '（本机历史局数 0 → null 也算如实）';
});

/* ================================================================== ④ deploy 的 nextStep 要分清「挂过没有」 */

/*
 * 修之前为什么红：`nextStep` 只有一句「先在编辑器里存盘…」。
 * 对**从没在编辑器里挂载过的新脚本**，真正缺的一步是「**先挂到容器节点上**」——存盘不解决任何问题。
 */
await check('④ 纯函数 mountStatusOf：对得上=已挂载 / 对不上=没挂过 / 拿不到=判断不了', async () => {
  const mounted = mountStatusOf({ mountedNames: ['game_01.lua', 'game_01'], liveName: 'game_01.lua' });
  assert(mounted.known === true && mounted.mounted === true, '已挂载判错：' + JSON.stringify(mounted));
  const notMounted = mountStatusOf({ mountedNames: ['game_01.lua'], liveName: '背景图片.lua' });
  assert(notMounted.known === true && notMounted.mounted === false && /对不上/.test(notMounted.note),
    '没挂过判错：' + JSON.stringify(notMounted));
  const unknown = mountStatusOf({ mountedNames: [], liveName: 'x.lua' });
  assert(unknown.known === false && unknown.mounted === null && /判断不了/.test(unknown.note),
    '拿不到时应当如实说判断不了：' + JSON.stringify(unknown));
  return '三种情形：已挂载 / 没挂过（对不上）/ 判断不了（GIL 里没有脚本映射记录）';
});

const deployLow = fakeLevel({
  levelId: '1073741900',
  gils: [makeGil({ levelId: 1073741900, scriptName: '已挂', scriptFile: '已挂.lua', source: '-- 地图里那版\n' })],
  luas: { '已挂.lua': '-- 本地这版（与地图里不同）\nlocal x = 1\n', '没挂过.lua': '-- 新脚本\nlocal y = 2\n' },
});
const srcA = path.join(tmpRoot, 'src-A.lua');
const srcB = path.join(tmpRoot, 'src-B.lua');
fs.writeFileSync(srcA, '-- 部署用的新版 A\nlocal a = 1\n', 'utf8');
fs.writeFileSync(srcB, '-- 部署用的新版 B\nlocal b = 2\n', 'utf8');
process.env.MILIASTRA_LOCALLOW = deployLow.root;

await check('④ 集成：**已挂载**的活文件 → nextStep 还是「存盘 / 重新试玩」（不提"挂"）', async () => {
  const r = await codeTool.execute({ op: 'deploy', file: '已挂.lua', source: srcA }, {});
  assert(r.ok, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  assert(r.mount && r.mount.known === true && r.mount.mounted === true, 'mount 判据不对：' + JSON.stringify(r.mount));
  assert(/存盘|重新试玩/.test(r.nextStep || ''), 'nextStep 没说该做什么：' + r.nextStep);
  assert(!/还没挂到容器节点上/.test(r.nextStep || ''), '已挂载却让人去挂载：' + r.nextStep);
  return r.nextStep.slice(0, 60) + '…';
});

await check('④ 集成：**没挂过**的新脚本 → nextStep 明确要求「挂到容器节点上」', async () => {
  const r = await codeTool.execute({ op: 'deploy', file: '没挂过.lua', source: srcB }, {});
  assert(r.ok, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  assert(r.mount && r.mount.known === true && r.mount.mounted === false, 'mount 判据不对：' + JSON.stringify(r.mount));
  assert(/还没挂到容器节点上/.test(r.nextStep || ''), 'nextStep 没点破「还没挂」：' + r.nextStep);
  assert(/挂到客户端控件容器的容器节点上/.test(r.nextStep || ''), 'nextStep 没说要挂到哪儿：' + r.nextStep);
  return r.nextStep.slice(0, 72) + '…';
});

await check('④ 集成：**判断不了**时明说判断不了（不编一个结论）', async () => {
  const noGil = fakeLevel({ levelId: '1073741901', luas: { '只有本地.lua': '-- x\n' } });
  process.env.MILIASTRA_LOCALLOW = noGil.root;
  try {
    const r = await codeTool.execute({ op: 'deploy', file: '只有本地.lua', source: srcA }, {});
    assert(r.ok, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
    assert(r.mount && r.mount.known === false, '没有 .gil 却说能判断：' + JSON.stringify(r.mount));
    assert(/判断不了/.test(r.nextStep || ''), '没明说判断不了：' + r.nextStep);
    // ⚠️ 判断不了**不等于**「可以试玩了」：原来那条底线断言照样要成立
    assert(!/重新试玩一局，然后/.test(r.nextStep || ''), '判断不了却给了「可以试玩」的结论：' + r.nextStep);
    return r.nextStep.slice(0, 60) + '…';
  } finally { process.env.MILIASTRA_LOCALLOW = deployLow.root; }
});

await check('④ 两种场景的 nextStep 文案**确实不同**（不是换个措辞的同一句）', async () => {
  const a = await codeTool.execute({ op: 'deploy', file: '已挂.lua', source: srcA }, {});
  const b = await codeTool.execute({ op: 'deploy', file: '没挂过.lua', source: srcB }, {});
  assert(a.nextStep && b.nextStep && a.nextStep !== b.nextStep, '两种场景的 nextStep 一样：' + a.nextStep);
  assert(/挂/.test(b.nextStep) && !/挂/.test(a.nextStep), '未挂载那条没提「挂」/已挂载那条多提了「挂」：' + JSON.stringify({ a: a.nextStep, b: b.nextStep }));
  return '已挂载 ' + a.nextStep.length + ' 字 / 未挂载 ' + b.nextStep.length + ' 字，且只有未挂载那条提「挂」';
});

/* ================================================================== ⑤ health 的 brief 档 */

/*
 * 修之前为什么红：`miliastra_health` 是「任何操作前先调」的工具，默认回执 9708 B、all:true 24966 B；
 * 而多数时候只要「我在哪张图 / 活文件是哪个 / 日志在哪」—— 没有 < 1KB 的那一档。
 */
const healthLow = fakeLevel({
  levelId: '1073741902',
  gils: [makeGil({ levelId: 1073741902, scriptName: 'game_01', scriptFile: 'game_01.lua' })],
  luas: { 'game_01.lua': '-- x\n', '备用.lua': '-- y\n' },
  logs: { '2026-09-25_10-00-00_1_201170108.gia': makeGia([{ message: '[T] 一行' }]) },
});
process.env.MILIASTRA_LOCALLOW = healthLow.root;

await check('⑤ brief:true → 总长 < 1KB，且含「活文件清单（name+bytes）」', async () => {
  const r = await health.execute({ brief: true }, {});
  const b = bytesOf(r);
  assert(r.brief === true && r.ok === true, 'brief 没生效：' + JSON.stringify(r).slice(0, 200));
  assert(b < 1024, 'brief 回执 ' + b + ' B，超过 1KB');
  assert(r.current && r.current.levelId === '1073741902' && r.current.brand === '原神' && r.current.accountId === '201170108',
    'current 缺关卡 id/品牌/账号：' + JSON.stringify(r.current));
  assert(Array.isArray(r.luaFiles) && r.luaFiles.map((x) => x && x.name).join(',') === 'game_01.lua,备用.lua',
    '活文件清单不对：' + JSON.stringify(r.luaFiles));
  // ★ P1-4（2026-09-26）：形状从「名字数组」改成 **`[{name, bytes}]`** —— 「0 字节脚本」必须一眼看出来。
  //   旧断言 `every(x => typeof x === 'string')` 正是 P1-4 要改掉的那一条：这里**跟着改形状**（不是放宽，
  //   而是把检查条件从「是字符串」换成「有 name + 有 bytes」，字节数还必须是夹具里的真实值 5）。
  assert(r.luaFiles.every((x) => x && typeof x.name === 'string' && x.bytes === 5),
    '活文件应当是 {name, bytes}（P1-4）：' + JSON.stringify(r.luaFiles));
  assert(typeof r.logDir === 'string' && r.logDir.includes('Beyond_Debug_Log'), '没给日志目录：' + r.logDir);
  assert(r.proc && typeof r.proc.editor === 'boolean' && typeof r.proc.game === 'boolean', '没给进程状态：' + JSON.stringify(r.proc));
  return b + ' B（默认档 ' + bytesOf(await health.execute({}, {})) + ' B）';
});

await check('⑤ brief **不带** per-level 的 gil / latestLog 全字段', async () => {
  const r = await health.execute({ brief: true }, {});
  assert(!('levels' in r), 'brief 里还有 levels 全量：' + Object.keys(r).join(','));
  assert(!('latestLog' in r), 'brief 里还有 latestLog');
  assert(typeof r.gil !== 'object', 'brief 里的 gil 应当是文件名（字符串），不是 {size,mtime} 对象：' + JSON.stringify(r.gil));
  assert(!('errorLog' in r) && !('host' in r), 'brief 里还带着 errorLog / host');
  const d = await health.execute({}, {});
  assert(Array.isArray(d.levels) && d.current && d.current.gil && typeof d.current.gil.size === 'number',
    '默认档被改动了（levels / current.gil 全字段必须还在）：' + JSON.stringify(d.current && d.current.gil));
  return 'brief 只有 ' + Object.keys(r).join('/') + '；默认档仍带 levels + gil 全字段';
});

await check('⑤ brief 与 all 同时给 → **brief 优先**（schema 里写明的那条）', async () => {
  const r = await health.execute({ brief: true, all: true }, {});
  assert(r.brief === true && !('levels' in r), 'all:true 把 brief 挤掉了：' + Object.keys(r).join(','));
  const s = health.parameters.properties.brief;
  assert(s && s.type === 'boolean' && /brief 优先|与 all/.test(s.description || ''), 'schema 没写清「brief 优先」：' + JSON.stringify(s));
  return 'brief+all → 仍是 brief；schema 写了「与 all / summaryOnly 同时给时 brief 优先」';
});

await check('⑤ 真机（有存档就查）：brief 也 < 1KB', async () => {
  if (savedLow !== undefined) delete process.env.MILIASTRA_LOCALLOW; else process.env.MILIASTRA_LOCALLOW = savedLow;
  try {
    const r = await health.execute({ brief: true }, {});
    if (!r.current) return '跳过：这台机器上没扫到关卡';
    const b = bytesOf(r);
    assert(b < 1024, '真机 brief 回执 ' + b + ' B，超过 1KB');
    return '真机 current=' + r.current.levelId + '，' + b + ' B，活文件 ' + r.luaFiles.length + ' 个';
  } finally { process.env.MILIASTRA_LOCALLOW = healthLow.root; }
});

/* ================================================================== ⑥ op=tail 从尾部取 */

/*
 * 修之前为什么红：只想看**收尾阶段**（那 141 条 Destroy 拒绝）却只能从头取 —— 没有 `last` / `from`。
 */
const logLow = fakeLevel({
  levelId: '1073741903',
  luas: { 'main.lua': '-- x\n' },
  logs: { '2026-09-25_10-00-00_2_201170108.gia': makeGia(Array.from({ length: 10 }, (_, i) => ({ message: '[T] L' + (i + 1) }))) },
});
process.env.MILIASTRA_LOCALLOW = logLow.root;
const LOG_FILE = '2026-09-25_10-00-00_2_201170108.gia';
const msgs = (r) => (r.records || []).map((x) => x.message.replace('[T] ', ''));

await check('⑥ last:3 → 拿到**最后 3 条**，且仍按时间正序', async () => {
  const r = await logTool.execute({ op: 'tail', file: LOG_FILE, last: 3 }, {});
  assert(r.ok, 'op=tail 失败：' + JSON.stringify(r).slice(0, 200));
  assert(msgs(r).join(',') === 'L8,L9,L10', 'last:3 拿到的不是最后 3 条 / 顺序不对：' + msgs(r).join(','));
  assert(r.window && r.window.from === 'end' && r.window.last === 3, '回执没报清窗口：' + JSON.stringify(r.window));
  return 'last:3 → ' + msgs(r).join(' → ');
});

await check('⑥ limit 单独用时行为**与现在一致**（默认取尾部那 N 条）', async () => {
  const r = await logTool.execute({ op: 'tail', file: LOG_FILE, limit: 4 }, {});
  assert(msgs(r).join(',') === 'L7,L8,L9,L10', 'limit 的语义变了：' + msgs(r).join(','));
  assert(r.window && r.window.last === null && r.window.limit === 4, 'window 没如实报：' + JSON.stringify(r.window));
  const head = await logTool.execute({ op: 'tail', file: LOG_FILE, limit: 4, from: 'head' }, {});
  assert(msgs(head).join(',') === 'L1,L2,L3,L4', 'from:head 没从头取：' + msgs(head).join(','));
  return 'limit:4 → ' + msgs(r).join(',') + '；limit:4+from:head → ' + msgs(head).join(',');
});

await check('⑥ 过滤 → 再取尾（tag/pattern 先过滤，last 取过滤结果的尾巴）', async () => {
  const r = await logTool.execute({ op: 'tail', file: LOG_FILE, tag: 'L1', last: 2 }, {});
  // tag=L1 命中 L1 / L10 两条 → 取尾 2 条 = 两条都留，但顺序仍是 L1 → L10
  assert(msgs(r).join(',') === 'L1,L10', '先过滤再取尾的顺序不对：' + msgs(r).join(','));
  const r2 = await logTool.execute({ op: 'tail', file: LOG_FILE, tag: 'L1', last: 1 }, {});
  assert(msgs(r2).join(',') === 'L10', 'last:1 应当拿过滤后的最后一条：' + msgs(r2).join(','));
  return 'tag=L1 命中 ' + msgs(r).join(',') + '；last:1 → ' + msgs(r2).join(',');
});

await check('⑥ from 传了不认识的取值 → 明确报错（不静默当默认）', async () => {
  const r = await logTool.execute({ op: 'tail', file: LOG_FILE, from: 'tail' }, {});
  assert(r.ok === false && /from 只能是/.test(r.error || ''), '没报错：' + JSON.stringify(r).slice(0, 160));
  const s = logTool.parameters.properties;
  assert(s.last && s.from && Array.isArray(s.from.enum) && s.from.enum.join(',') === 'end,head',
    'schema 没补 last / from：' + JSON.stringify({ last: !!s.last, from: s.from && s.from.enum }));
  return '错误：' + r.error.slice(0, 40) + '…；schema 有 last + from(end/head)';
});

/* ================================================================== ⑦ 自定义探针 template:"custom" */

/*
 * 修之前为什么红：只有 5 个固定模板，两个「只有真机才能答」的问题（OnInit/OnEnable 期能不能
 * InstantiateClientUIControl、锚点是不是归一化 0..1）**一个都答不了**；而手写探针又要自己拼前后缀。
 */
const probeLow = fakeLevel({ levelId: '1073741904', luas: { 'main.lua': '-- 原脚本\nlocal a = 1\n' } });
process.env.MILIASTRA_LOCALLOW = probeLow.root;
const CUSTOM_LUA = [
  'local function run()',
  '    p("onInit=" .. tostring(initOk))',
  '    local ok, w, h = pcall(function() return game.GetUICanvasSize() end)',
  '    p("canvas=" .. tostring(ok) .. " " .. tostring(w) .. "x" .. tostring(h))',
  'end',
  '',
].join('\n');

await check('⑦ 模板清单里有 custom（op=list / schema enum 都算）', async () => {
  const list = await probeTool.execute({ op: 'list' }, {});
  assert(list.templates.includes('custom'), 'op=list 的清单里没有 custom：' + list.templates.join(','));
  assert(list.info.some((x) => x.template === 'custom' && x.when), 'custom 没有「什么时候用」的大白话说明');
  assert(probeTool.parameters.properties.template.enum.includes('custom'), 'schema 的 enum 里没有 custom');
  assert(probeTool.parameters.properties.lua, 'schema 没有 lua 参数（custom 的正文没地方给）');
  assert(!PROBE_TEMPLATES.includes('custom'), '内置模板清单不该混进 custom（那是"不带参数就能渲染"的那一条清单）');
  return 'op=list ' + list.templates.length + ' 个（含 custom）· schema enum ' + PROBE_TEMPLATE_CHOICES.length + ' 个 · 内置仍是 ' + PROBE_TEMPLATES.length + ' 个';
});

await check('⑦ render custom：产出的 Lua 合法（含前后缀），并提示「会覆盖活文件、记得还原」', async () => {
  const r = await probeTool.execute({ op: 'render', template: 'custom', tag: 'FB2', lua: CUSTOM_LUA }, {});
  assert(r.ok, 'render 失败：' + JSON.stringify(r).slice(0, 240));
  assert(r.custom === true && r.savedTo === null, '回执没标 custom / savedTo 应当为 null：' + JSON.stringify({ c: r.custom, s: r.savedTo }));
  assert(/EnableUpdate\(true\)/.test(r.lua) && /local function pChunked\(/.test(r.lua), '没套上探针前后缀（EnableUpdate / 分片打印）');
  assert(r.lua.includes('canvas='), '正文没进产物');
  assert(/临时覆盖活文件/.test(r.note) && /op=restore/.test(r.note), '没提示「会覆盖活文件 / 记得还原」：' + r.note);
  assert(!('probeSource' in r), 'render 不该有 probeSource（那说明它部署了）');
  return r.bytes + ' B；note 里点了「临时覆盖活文件」+ 还原命令';
});

await check('⑦ render custom：**缺 end 的 Lua 被拒**，并指出哪里不合法', async () => {
  const r = await probeTool.execute({ op: 'render', template: 'custom', tag: 'FB2', lua: 'local function run()\n  print("缺 end")\n' }, {});
  assert(r.ok === false, '缺 end 竟然通过了：' + JSON.stringify(r).slice(0, 200));
  assert(/没通过结构校验/.test(r.error) && /end/.test(r.error), '报错没说清哪里不合法：' + r.error);
  assert(Array.isArray(r.problems) && r.problems.length && r.problems[0].line === 1, '没给出问题行号：' + JSON.stringify(r.problems));
  const raw = renderProbe('custom', { tag: 'FB2', lua: 'if true then\n' });
  assert(raw.ok === false && /没有对应的 end|缺/.test(raw.error), '纯函数层也要拒绝：' + raw.error);
  return r.error.slice(0, 70) + '…';
});

await check('⑦ render **不落盘**（不给 saveTo 就不碰任何文件），给了 saveTo 才写', async () => {
  const before = fs.readdirSync(probeLow.luaDir).sort().join(',');
  const r = await probeTool.execute({ op: 'render', template: 'custom', tag: 'FB2', lua: CUSTOM_LUA }, {});
  assert(r.ok, 'render 失败：' + r.error);
  assert(fs.readdirSync(probeLow.luaDir).sort().join(',') === before, 'render 动了活文件目录');
  assert(!fs.existsSync(path.join(probeLow.luaDir, '_backup')), 'render 竟然建了备份目录（说明它部署了）');
  const out = path.join(tmpRoot, 'probe-custom.lua');
  const r2 = await probeTool.execute({ op: 'render', template: 'custom', tag: 'FB2', lua: CUSTOM_LUA, saveTo: out }, {});
  assert(r2.savedTo === out && fs.readFileSync(out, 'utf8') === r2.lua, 'saveTo 没写出产物');
  return '没给 saveTo：活文件目录零变化、无 _backup；给了 saveTo：' + fs.statSync(out).size + ' B 落盘';
});

await check('⑦ deploy custom：走**同一条流水线**（先备份 → 覆盖 → 给出还原命令）', async () => {
  const live = path.join(probeLow.luaDir, 'main.lua');
  const r = await probeTool.execute({ op: 'deploy', template: 'custom', tag: 'FB2', lua: CUSTOM_LUA }, {});
  assert(r.ok, '部署失败：' + JSON.stringify(r).slice(0, 240));
  assert(r.template === 'custom' && r.label === '自己写', '回执没认出 custom：' + JSON.stringify({ t: r.template, l: r.label }));
  assert(fs.readFileSync(live, 'utf8').includes('canvas='), '活文件没被探针覆盖（流水线断了）');
  assert(/临时覆盖|探针/.test(r.nextStep || ''), 'nextStep 没说清现在的处境：' + r.nextStep);
  assert(/op=restore/.test(r.restoreWith || '') || /op=restore/.test(r.nextStep || ''), '没给还原命令');
  // 还原（用固定名那份）→ 原脚本回来
  const back = await codeTool.execute({ op: 'restore', file: 'main.lua' }, {});
  assert(back.ok, '还原失败：' + JSON.stringify(back).slice(0, 200));
  assert(fs.readFileSync(live, 'utf8') === '-- 原脚本\nlocal a = 1\n', '还原后不是原脚本：' + JSON.stringify(fs.readFileSync(live, 'utf8')));
  return 'deploy → 活文件=探针；op=restore → 原脚本回来（' + back.usedFixedBackup + ' 用固定名那份）';
});

/* ================================================================== ⑧ op=bind：kind auto + mount 真实层级 */

/*
 * 修之前为什么红：
 *   · `kind` 只能调用方猜，**猜错静默**（什么都不建）；回执里只有一个 controlCount 数字，看不出"是没建"。
 *   · `mount.assetType: "server-control-template"` 让人以为挂错了地方 —— 而真实拓扑是
 *     `客户端控件容器(server-container) → 容器节点(container)`。
 */
const bindLua = path.join(tmpRoot, '假工程.lua');
// 这段脚本**自己认模板类型**：只有 textbox 能设 text，其余 kind 会抛错 → 把建出来的那个销毁掉再退出。
// 于是「猜错」的表现正好是真机上的那种：控件数一个都不涨。
fs.writeFileSync(bindLua, [
  'local TEMPLATE = 1073741868',
  'function OnStart()',
  '  local root = game.InstantiateClientUIControl(TEMPLATE, script.object)',
  '  if root == nil then print("[kind-selftest] 模板没解析出来") return end',
  '  local okText = pcall(function() root.text = "标题" end)',
  '  if not okText then',
  '    pcall(function() game.DestroyClientUIControl(root) end)',
  '    print("[kind-selftest] 不是 textbox")',
  '    return',
  '  end',
  '  for i = 1, 4 do',
  '    local item = game.InstantiateClientUIControl(TEMPLATE, root)',
  '    item.text = "项" .. i',
  '  end',
  '  print("[kind-selftest] textbox ok")',
  'end',
  '',
].join('\n'), 'utf8');

await check('⑧ mountHierarchy（纯函数）：parent / isClientUI 按真实层级算', async () => {
  const rows = [
    { id: 'sc1', name: '客户端控件容器', kind: 'server-container', parentId: null, ancestorIds: [] },
    { id: 'n1', name: '容器节点', kind: 'container', parentId: 'sc1', ancestorIds: ['sc1'] },
    { id: 'n2', name: '旧控件', kind: 'textbox', parentId: 'n1', ancestorIds: ['sc1', 'n1'] },
  ];
  const h = mountHierarchy(rows, 'n1');
  assert(h.parent && h.parent.name === '客户端控件容器' && h.parent.kind === 'server-container', 'parent 不对：' + JSON.stringify(h.parent));
  assert(h.isClientUI === true && h.clientUIRoot && h.clientUIRoot.kind === 'server-container', 'isClientUI 不对：' + JSON.stringify(h));
  assert(h.ancestors.length === 1, '祖先链不对：' + JSON.stringify(h.ancestors));
  const orphan = mountHierarchy(rows, '不存在');
  assert(orphan.parent === null && orphan.isClientUI === false, '找不到时应当如实回 null/false：' + JSON.stringify(orphan));
  return 'n1 → parent=客户端控件容器(server-container) / isClientUI=true；找不到 → null/false';
});

await check('⑧ kind:"auto"：**第一个 kind 建不出来、第二个能建出来**时选对', async () => {
  const r = await simOp({ op: 'bind', source: bindLua, templates: [{ guid: 1073741868, kind: 'auto', name: '待定模板' }] });
  assert(Array.isArray(r.kindTried) && r.kindTried.length >= 2, '没回 kindTried：' + JSON.stringify(r.kindTried));
  assert(r.kindTried[0].kind === AUTO_KIND_ORDER[0] && r.kindTried[0].grew === false,
    '第一个候选（image）应当"没增长"：' + JSON.stringify(r.kindTried[0]));
  assert(r.kindTried[1].kind === AUTO_KIND_ORDER[1] && r.kindTried[1].grew === true,
    '第二个候选（textbox）应当"增长"：' + JSON.stringify(r.kindTried[1]));
  assert(r.kindWinner === 'textbox', 'winner 不对：' + r.kindWinner);
  assert(r.templates.length === 1 && r.templates[0].kind === 'textbox', '客户端工程里没落成 winner 的 kind：' + JSON.stringify(r.templates));
  assert(r.run.controlCount > r.editorControlCount, 'winner 那一局控件数应当真的增长了：' + JSON.stringify({ c: r.run.controlCount, e: r.editorControlCount }));
  assert(r.run.logs.some((l) => /textbox ok/.test(l.text || '')), 'winner 那局的脚本没跑出成功 print：' + JSON.stringify(r.run.logs));
  assert(!r.kindHint, '已经建出来了就不该再给 kindHint：' + r.kindHint);
  return 'kindTried=' + JSON.stringify(r.kindTried.map((k) => k.kind + ':' + k.controlCount)) + ' → winner=' + r.kindWinner;
});

await check('⑧ 不给 auto：控件数没增长时**自动附一条 kindHint**', async () => {
  const r = await simOp({ op: 'bind', source: bindLua, templates: [{ guid: 1073741868, kind: 'image', name: '猜错的模板' }] });
  assert(r.kindHint, '没给 kindHint：' + JSON.stringify(r).slice(0, 300));
  assert(/kind/.test(r.kindHint) && /image \/ textbox \/ container/.test(r.kindHint) && /"auto"/.test(r.kindHint),
    'hint 没点破「可能是 kind 不对」+ 候选 + auto：' + r.kindHint);
  assert(r.run.controlCount <= r.editorControlCount, '夹具前提不成立（控件数竟然增长了）：' + JSON.stringify({ c: r.run.controlCount, e: r.editorControlCount }));
  assert(!r.kindTried, '没传 auto 却回了 kindTried：' + JSON.stringify(r.kindTried));
  return 'kindHint：' + r.kindHint.slice(0, 72) + '…';
});

await check('⑧ kindHint 文案（纯函数）：两种情形都点出该做什么', async () => {
  const notTried = kindMismatchHint(1, 1, false);
  const tried = kindMismatchHint(1, 1, true);
  assert(/可能一个控件都没建出来/.test(notTried) && /kind:"auto"/.test(notTried), '没试过 auto 的那份不对：' + notTried);
  assert(/都试过了/.test(tried) && /run\.logs/.test(tried), '试过 auto 的那份不对：' + tried);
  return '未试过 → 给候选 + auto；试过 → 指向 run.logs';
});

await check('⑧ mount 回执给**真实层级** + assetType 的语境说明', async () => {
  const r = await simOp({ op: 'bind', source: bindLua, run: false, templates: [{ guid: 1073741868, kind: 'image', name: 'T' }] });
  assert(r.mount.parent && r.mount.parent.name === '客户端控件容器' && r.mount.parent.kind === 'server-container',
    'mount.parent 不是真实层级：' + JSON.stringify(r.mount.parent));
  assert(r.mount.isClientUI === true && r.mount.clientUIRoot && r.mount.clientUIRoot.kind === 'server-container',
    'mount.isClientUI 不对：' + JSON.stringify({ i: r.mount.isClientUI, c: r.mount.clientUIRoot }));
  assert(Array.isArray(r.mount.ancestors) && r.mount.ancestors.length >= 1, '没给祖先链：' + JSON.stringify(r.mount.ancestors));
  assert(r.mount.assetType === 'server-control-template', 'assetType 不该改（兼容）：' + r.mount.assetType);
  assert(/控件模板资源/.test(r.mount.assetTypeNote || '') && /不代表/.test(r.mount.assetTypeNote || ''),
    'assetType 没有语境说明：' + r.mount.assetTypeNote);
  // 与 `op=controls` 看到的拓扑对上：客户端控件容器在第 0 层、容器节点在第 1 层
  const c = await simOp({ op: 'controls' });
  const root = (c.controls || []).find((x) => x.kind === 'server-container');
  const node = (c.controls || []).find((x) => x.id === r.mount.id);
  assert(root && root.depth === 0 && node && node.depth === 1,
    'op=controls 的拓扑与 mount 对不上：' + JSON.stringify({ root: root && root.depth, node: node && node.depth }));
  return 'mount.parent=客户端控件容器(server-container) / isClientUI=true，与 op=controls 的层级一致';
});

/* ------------------------------------------------------------------ 收尾 */

process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW;
if (savedData === undefined) delete process.env.MILIASTRA_DATA_DIR; else process.env.MILIASTRA_DATA_DIR = savedData;
if (savedBak === undefined) delete process.env.MILIASTRA_BACKUP_DIR; else process.env.MILIASTRA_BACKUP_DIR = savedBak;
try { await simOp({ op: 'reset' }); } catch { /* ignore */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n结果：通过 ${pass}，失败 ${failures.length}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
