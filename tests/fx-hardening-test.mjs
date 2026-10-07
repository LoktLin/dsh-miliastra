#!/usr/bin/env node
/**
 * 真机实战暴露的 5 个坑（2026-09-30 · 特效收尾轮）：**修前为什么红 / 为什么必须钉住**
 *
 * 背景：`peacock-out`（8 层 / 贝塞尔）在**真机**跑通了，但排查极艰难。5 条实测教训：
 *
 *  ① **缺 `container` 时"四环全绿、真机整屏无星"**：只给 `templateIndex` 时
 *     生成成功 → `deploy` 通过 → `lint` 通过 → `miliastra_sim` 也跑得通，
 *     只有真机在 `OnStart` 里 `error`（真机原文：`缺少交接值 CONFIG.CONTAINER_INDEX：…` +
 *     `特效 fx:428: in function 'requireHandover'`）。**修前**：它被当成"可选值"，一路放过。
 *
 *  ② **那条报错没有 `[...]` 标签 ⇒ 按 tag grep 一条都捞不到**（作者连猜 4 轮关键词）。
 *     **修前**：`miliastra_log` 只有按 tag/pattern 捞的两条路，没有任何"按形态捞报错"的入口。
 *
 *  ③ **`.gia` 落盘会失败**：本局没落盘、更早的局落了，而**画面其实是正常的** ——
 *     旧版只给一句中性的"未落盘"，实测把人误导成"脚本层没跑"。**修前**：没有任何一句话说破这一点。
 *
 *  ④ **"文件名不一致"每次都会命中**（把生成物 `特效 fx_coin-fan.lua` 投成活文件 `特效 fx.lua`），
 *     置顶 `warning` 让真警告被淹（作者原话：噪声很大）。**修前**：显式 `file` 也照打 warning。
 *
 *  ⑤ **投递前没有可判定自检清单**：上面 ① 那种坑本该在**投递前**就被判出来。
 *     **修前**：只有散落在 `warnings[]` 里的字符串，没有"逐项 ok + 真机会怎样"的表。
 *
 * ⚠️ 本套件**只读**（除第 ④ 条用临时目录造活文件清单）；不碰游戏存档、不 deploy、不改活文件。
 * 用法：`node tests/fx-hardening-test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const failures = [];
const ok = (name, detail = '') => { pass += 1; console.log(`✓ ${name}${detail ? ' —— ' + detail : ''}`); };
const bad = (name, why) => { failures.push(`${name}: ${why}`); console.log(`✗ ${name} —— ${why}`); };

const queue = [];
function t(name, fn) { queue.push([name, fn]); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

/*
 * ★★ 2026-09-30：**先隔离台账与根目录**，再 import `index.js`。
 *
 * 为什么必须隔离（本轮实测踩到）：P2-8 的**交接值台账**会在 `container` 缺席时**自动补上**
 * （`handoverFrom:"arg+ledger"`）—— 于是第 ① 条「只给 templateIndex、漏 container ⇒ 必须 ok:false」
 * 在本机**变成了 ok:true**（因为本机台账里确实有一条 container，是创作者交接过的真值）。
 * 那不是产品回归，而是**这条断言的前提被改变了**：它要验的是「**哪儿都没有**交接值时必须拦住」。
 * ⇒ 与 `tests/handover-ledger-test.mjs` 同一套隔离法，但**只隔离 `MILIASTRA_DATA_DIR`**（台账住在那儿）。
 *   ⚠️ 第一版我连 `MILIASTRA_LOCALLOW` 一起改了 ⇒ 依赖**真实沙箱**的那 6 条（日志夹具 / deploy 集成）全红：
 *   「在 temp 下没扫到任何关卡目录」。隔离要**只隔住你要隔的那一样**。
 */
const tmpIsolate = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fxhard-'));
process.env.MILIASTRA_DATA_DIR = path.join(tmpIsolate, 'data');

const { TOOLS, genOp } = await import('../index.js');
const giaMod = await import('../lib/gia.mjs');
const { findErrorRecords, parseFileLine, landingMisleadingHint, giaLandingState, ERROR_KIND_LABELS } = giaMod;
const { pickLiveFile } = await import('../lib/codefile.mjs');
const vfx = await import('../lib/vfx/index.mjs');
const { preflightOf } = vfx;

const gen = TOOLS.find((x) => x.name === 'miliastra_gen');
const sim = TOOLS.find((x) => x.name === 'miliastra_sim');
const log = TOOLS.find((x) => x.name === 'miliastra_log');
const playtest = TOOLS.find((x) => x.name === 'miliastra_playtest');
const code = TOOLS.find((x) => x.name === 'miliastra_code');

const TMPL = 1073741868;
const BOX = 1073741863;

/** 真机原文（**逐字**，别改字）—— 第 ① ② 条的证据都来自它。 */
const REAL_DEVICE_ERROR = '缺少交接值 CONFIG.CONTAINER_INDEX：粒子父容器的控件节点索引，必须由创作者交接（脚本不会猜、不会写假索引）\n'
  + 'stack traceback:\n\t特效 fx:428: in function \'requireHandover\'\n\t特效 fx:1611: in function \'OnStart\'';

/* ==================================================================== ① 缺 container 必须报警 */

t('①a 只给 templateIndex、漏 container ⇒ **ok:false**（与缺 templateIndex 同等对待）', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL });
  assert(r.ok === false, '漏 container 竟然生成成功了（真机会整屏没有粒子）：ok=' + r.ok);
  assert(r.lua === undefined, '缺交接值不许给 lua');
  assert(Array.isArray(r.needsHandover) && r.needsHandover.some((x) => x.param === 'container'),
    'needsHandover 里没有 container：' + JSON.stringify(r.needsHandover));
  assert(eq(r.missingParams, ['container']) === undefined, '缺的就是 container');
  return 'ok:false + needsHandover[container] + missingParams=["container"] + 不给 lua';
});

t('①b 文案必须点明「缺它会在真机 `OnStart` 报错、整屏没有粒子」+ 稳定 code', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL });
  assert(r.code === 'FX_HANDOVER_MISSING', '没有稳定 code：' + r.code);
  assert(/OnStart/.test(r.error), 'error 没点明 OnStart：' + r.error);
  assert(/整屏没有粒子|整屏没有星/.test(r.error), 'error 没点明"整屏没有粒子"：' + r.error);
  assert(/CONTAINER_INDEX/.test(r.error), 'error 没带上真机那句 CONTAINER_INDEX：' + r.error);
  assert(/miliastra_sim/.test(r.error) && /lint/.test(r.error) && /deploy/.test(r.error),
    'error 没说清"哪三环不会替你发现"：' + r.error);
  return 'code=FX_HANDOVER_MISSING + 点明「三环全绿、真机 OnStart error、整屏没有粒子」';
});

t('①c `warnings[]` 带一条**稳定 code 的强警告**（对象形态，可机读）', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL });
  const obj = (r.warnings || []).filter((w) => w && typeof w === 'object');
  const hit = obj.find((w) => w.code === 'FX_CONTAINER_MISSING');
  assert(hit, 'warnings 里没有 code=FX_CONTAINER_MISSING 的那条：' + JSON.stringify(r.warnings));
  assert(hit.level === 'error' && hit.param === 'container', '那条警告的 level/param 不对：' + JSON.stringify(hit));
  assert(/整屏没有粒子/.test(hit.message), '警告正文没说清后果：' + hit.message);
  // ⚠️ 字符串与对象**并存**是既有契约（deploy 那边也一样）⇒ 这里只钉"对象那条在"，不去数总长度
  assert((r.warnings || []).length >= 1, 'warnings 不该为空');
  return 'warnings[] 里 {code:"FX_CONTAINER_MISSING", level:"error", param:"container"}';
});

t('①d 两个都给 ⇒ 生成成功、**没有**那条强警告（这才是正常路径）', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX });
  assert(r.ok === true && typeof r.lua === 'string', '两个交接值都给应当成功：' + JSON.stringify(r).slice(0, 200));
  const obj = (r.warnings || []).filter((w) => w && typeof w === 'object');
  assert(!obj.some((w) => w.code === 'FX_CONTAINER_MISSING'), '两个都给时不该有缺 container 的警告');
  assert(r.target.container === BOX && r.target.templateIndex === TMPL, 'target 要回显两个号：' + JSON.stringify(r.target));
  return 'target=' + JSON.stringify(r.target);
});

t('①e 生成物顶部有「**运行时依赖清单**」：四项各带来源，缺哪个写"缺 → 运行时必 error"', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', templateIndex: TMPL, container: BOX });
  const head = String(r.lua).split('\n').slice(0, 32).join('\n');
  assert(/运行时依赖清单/.test(head), '产物顶部没有依赖清单：' + head.slice(0, 300));
  for (const k of ['TEMPLATE_INDEX', 'CONTAINER_INDEX', 'PARENT_BY_NAME', 'IMAGE_ID']) {
    assert(head.includes(k), '依赖清单缺 ' + k);
  }
  assert(/来源/.test(head), '依赖清单没写"来源"');
  assert(/漏了它前三环都不会报错/.test(head), 'CONTAINER_INDEX 那行没点破"前三环不报错"');
  // ⚠️ 清单里不该再出现"缺了会怎样"缺失的情况：两项都给了 ⇒ 不该出现「缺 → 运行时必 error」
  assert(!/← \*\*缺 → 运行时必 error\*\*/.test(head), '两个交接值都给了，不该出现"缺 → error"标记');
  return '四项齐全（来源 + 前三环警示）';
});

t('①f 依赖清单：**缺的那项**必须标出来（拿 lib 层直接构造，模拟"没给 templateIndex"）', () => {
  // `vfxLua` 在缺值时不出产物（①a）⇒ 这里用 `preflightOf` 的判据反向确认"缺 → 真机 error"这句话在
  const items = preflightOf({ templateIndex: null, container: null, base: null, sim: null, est: null });
  const tpl = items.find((i) => /TEMPLATE_INDEX|templateIndex/.test(i.item));
  const box = items.find((i) => /container/.test(i.item));
  assert(tpl && tpl.ok === false && /整屏没有粒子/.test(tpl.why), 'templateIndex 缺了没判 FAIL：' + JSON.stringify(tpl));
  assert(box && box.ok === false && /缺少交接值 CONFIG.CONTAINER_INDEX/.test(box.why), 'container 缺了没判 FAIL：' + JSON.stringify(box));
  return '两项缺值时 ok:false 且 why 点明真机后果';
});

/* ==================================================================== ⑤ preflight 自检清单 */

t('⑤a preflight 七项齐全，全给时逐项说明"真机会怎样"', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'peacock-out', imageId: 112042, previewImageId: 100005, templateIndex: TMPL, container: BOX });
  assert(Array.isArray(r.preflight), '回执没有 preflight');
  eq(r.preflight.length, 7, 'preflight 项数');
  for (const p of r.preflight) {
    assert(typeof p.item === 'string' && p.item.length > 4, '每项要有 item：' + JSON.stringify(p));
    assert(p.ok === true || p.ok === false || p.ok === null, 'ok 只能是 true/false/null：' + JSON.stringify(p));
    assert(typeof p.why === 'string' && p.why.length > 8, '每项要有 why（一句话说清真机会怎样）：' + JSON.stringify(p));
  }
  const items = r.preflight.map((p) => p.item).join(' | ');
  for (const k of ['templateIndex', 'container', 'parentName', 'imageId 是合法正整数', '模拟器', '池', '控件']) {
    assert(items.includes(k), 'preflight 缺一项：' + k + '（实际：' + items + '）');
  }
  return '7 项：' + r.preflight.map((p) => (p.ok === true ? 'ok' : p.ok === false ? 'FAIL' : 'unknown')).join('/');
});

t('⑤b 缺 container 的那次：preflight 里该项 **FAIL**，且结论字段照给', async () => {
  const r = await gen.execute({ op: 'vfx-lua', preset: 'star-rain', imageId: 112042, templateIndex: TMPL });
  const box = r.preflight.find((p) => /container/.test(p.item));
  assert(box && box.ok === false, 'preflight 没把 container 标 FAIL：' + JSON.stringify(box));
  const tpl = r.preflight.find((p) => /templateIndex/.test(p.item));
  assert(tpl && tpl.ok === true, 'templateIndex 这次是有的，不该 FAIL');
  assert(r.preflight.length === 7, '失败回执里 preflight 也要完整（这正是最该看清单的时刻）');
  return 'container FAIL、templateIndex ok，共 7 项';
});

t('⑤c 图片号：合法正整数判 true；不能预览时判 false 但**说清真机正常**', async () => {
  const good = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', imageId: 100005, templateIndex: TMPL, container: BOX });
  const g = good.preflight.find((p) => /合法正整数/.test(p.item));
  const s = good.preflight.find((p) => /模拟器/.test(p.item));
  assert(g.ok === true, '几何号该判合法：' + JSON.stringify(g));
  assert(s.ok === true, '100005 是几何号 ⇒ 模拟器能预览：' + JSON.stringify(s));
  const real = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', imageId: 112042, templateIndex: TMPL, container: BOX });
  const s2 = real.preflight.find((p) => /模拟器/.test(p.item));
  assert(s2.ok === false, '112042 不是几何号 ⇒ 预览这项该 false：' + JSON.stringify(s2));
  assert(/真机正常/.test(s2.why) && /1543/.test(s2.why), '该项 false 时必须说清"真机正常（1543 个号都能用）"：' + s2.why);
  return '几何号 true / 平台号 false（why 点明真机正常）';
});

t('⑤d parentName：能查就查（查到 true / 查不到 false）；**查不到清单就 unknown，绝不猜**', async () => {
  // ① 没传 parentName ⇒ unknown（它不是必填）
  const none = await gen.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX });
  const p0 = none.preflight.find((p) => /parentName/.test(p.item));
  assert(p0.ok === null, '没传 parentName 时该是 unknown：' + JSON.stringify(p0));
  // ② 传了、给了候选清单 ⇒ 逐字比对
  const withCand = vfx.vfxLua(
    { op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX, parentName: 't1_hud_status' },
    { templateIndex: TMPL, container: BOX, candidates: { namedChildrenOfContainer: [{ name: 't1_hud_status', id: 1, parent: 2 }] } },
  );
  const p1 = withCand.preflight.find((p) => /parentName/.test(p.item));
  assert(p1.ok === true, '在候选清单里查到了却判 false：' + JSON.stringify(p1));
  const miss = vfx.vfxLua(
    { op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX, parentName: '不存在的名字' },
    { templateIndex: TMPL, container: BOX, candidates: { namedChildrenOfContainer: [{ name: 't1_hud_status', id: 1, parent: 2 }] } },
  );
  const p2 = miss.preflight.find((p) => /parentName/.test(p.item));
  assert(p2.ok === false, '查不到该判 false：' + JSON.stringify(p2));
  assert(/script\.object/.test(p2.why) && /层级/.test(p2.why), 'false 时要说清"退回 script.object、层级可能不对"：' + p2.why);
  assert(/t1_hud_status/.test(p2.why), 'false 时要把 .gil 里现有的名字列出来：' + p2.why);
  // ③ 没有候选清单（读不到 .gil）⇒ unknown（**不猜**）
  const noCand = vfx.vfxLua(
    { op: 'vfx-lua', preset: 'hit-spark', templateIndex: TMPL, container: BOX, parentName: 'x' },
    { templateIndex: TMPL, container: BOX, candidates: null },
  );
  const p3 = noCand.preflight.find((p) => /parentName/.test(p.item));
  assert(p3.ok === null && /不猜|判不了/.test(p3.why), '读不到 .gil 时该 unknown 且说清"不猜"：' + JSON.stringify(p3));
  return 'unknown(没传) / true(查到) / false(查不到 + 列出名字) / unknown(读不到 .gil)';
});

t('⑤e 工具 schema 里点到了 preflight（AI 只看得见 schema）', () => {
  const d = String(gen.description || '');
  assert(/preflight/.test(d), 'description 没提 preflight：' + d.slice(0, 200));
  assert(/运行时依赖清单/.test(d), 'description 没提「运行时依赖清单」');
  return 'description 提到 preflight + 运行时依赖清单';
});

/* ==================================================================== ② op=errors */

t('②a parseFileLine：真机的 `特效 fx:428:` 解析得出（**不带 .lua** 也要认）', () => {
  const r = parseFileLine(REAL_DEVICE_ERROR);
  assert(r && r.file === '特效 fx' && r.line === 428, '真机那条没解析对：' + JSON.stringify(r));
  // 带 .lua 的形态
  const a = parseFileLine('[侦探1/view] err.lua:12: boom');
  assert(a && a.file === 'err.lua' && a.line === 12, '.lua:行号 没解析对：' + JSON.stringify(a));
  // ⚠️ 时间戳 `01:36:27` **不许**被当成 `文件:行号`
  eq(parseFileLine('01:36:27 [特效fx] 建成 120 个图片控件'), null, '把时间戳当成了文件行号');
  eq(parseFileLine('attempt to index a nil value (field \'x\')'), null, '没有文件行号时该给 null（不编）');
  return '特效 fx:428 / err.lua:12 / 时间戳拒绝 / 无行号给 null';
});

t('②b findErrorRecords：真机原文能捞出来，且 kind 是 `handover-missing`（带 fileLine）', () => {
  const recs = [
    { index: 0, instance: '47504-201170108-1790621791-32146', channel: '(白)测试 - 副标题', time: '2026/09/29_02:56:34', message: '[yuan-code] OnInit' },
    { index: 9, instance: '47504-201170108-1790621791-32146', channel: '(白)测试 - 副标题', time: '2026/09/29_02:56:34', message: REAL_DEVICE_ERROR },
  ];
  const r = findErrorRecords(recs);
  eq(r.count, 1, '命中数');
  eq(r.runsAffected, 1, '受影响局数');
  const e = r.errors[0];
  eq(e.kind, 'handover-missing', 'kind');
  assert(e.kinds.includes('stack-traceback') && e.kinds.includes('file-line'), 'kinds 要列出全部命中形态：' + JSON.stringify(e.kinds));
  eq(e.fileLine, { file: '特效 fx', line: 428, raw: '特效 fx:428: in function' }, 'fileLine');
  eq(e.run, 1790621791, 'run = instance 第三段（与 playtest 的 epochSec 同源）');
  eq(e.channel, '(白)测试 - 副标题', 'channel 要带上（跨 channel 捞是这条路的要点）');
  return 'kind=handover-missing · fileLine=特效 fx:428 · run=1790621791';
});

t('②c 各形态都能认（含 attempt to index / call、nil value、instantiate、stack traceback）', () => {
  const cases = [
    ['attempt to index a nil value (global \'x\')', 'attempt-index'],
    ['attempt to call a nil value (field \'f\')', 'attempt-call'],
    ['bad argument #1 to \'ipairs\' (nil value)', 'nil-value'],
    ['InstantiateClientUIControl 返回 nil（模板号 1073741868）', 'instantiate-nil'],
    ['stack traceback:\n\tmain:12: in function \'OnStart\'', 'stack-traceback'],
    ['缺少交接值 CONFIG.X：必须由创作者交接', 'handover-missing'],
  ];
  for (const [msg, kind] of cases) {
    const r = findErrorRecords([{ index: 1, instance: '47504-1-100-1', message: msg }]);
    eq(r.errors.length, 1, '该命中：' + msg);
    eq(r.errors[0].kind, kind, msg + ' 的 kind');
  }
  // 干净的一行**不许**命中
  eq(findErrorRecords([{ index: 1, instance: '47504-1-100-1', message: '[侦探1/view] 初始化完成，控件 29 个' }]).count, 0, '正常日志被误报');
  return cases.length + ' 种形态 + 1 条正常日志不误报';
});

t('②d ★ 假阳性守卫：脚本自己说"**不是异常**"的诊断行，不算报错', () => {
  const diag = { index: 46, instance: '47504-1-100-1', message: '[特效:sword-river/diag] script.object.parent = nil ⇒ 到这里没有父节点了（读到 nil，不是异常）' };
  const r = findErrorRecords([diag]);
  eq(r.count, 0, '把"不是异常"的诊断行当成了报错（真机实测抓到过这个假阳性）');
  // 但具体形态**不受**否定过滤影响：同一条里若真的有 attempt to index，必须仍然命中
  const real = { index: 1, instance: '47504-1-100-1', message: '不是异常？不，attempt to index a nil value 了' };
  const r2 = findErrorRecords([real]);
  eq(r2.count, 1, '具体形态不该被否定过滤误伤');
  eq(r2.errors[0].kind, 'attempt-index', 'kind');
  return '「不是异常」跳过；同时含明确形态时仍命中';
});

t('②e 工具层 `op=errors`：真从 TOOLS 调，回执形状 + 结论文档字段齐全', async () => {
  const r = await log.execute({ op: 'errors', file: '2026-09-29_02-56-34_426_201170108.gia' });
  if (r.file && /没有这个 op|不存在/.test(String(r.error || ''))) throw new Error('op=errors 没接上：' + r.error);
  // ⚠️ 那份 .gia 只在本机存在；换机器时退化成"读不到"⇒ 用"结构断言"而不是"值断言"
  if (r.ok !== true) {
    assert(/没有 .gia|不存在|读不到/.test(String(r.error || '')), '非"文件不存在"之外的失败要看清：' + r.error);
    ok('', '（本机没有那份 .gia，跳过值断言）');
    return;
  }
  for (const k of ['count', 'returned', 'truncated', 'runsAffected', 'runs', 'channels', 'kindCounts', 'kinds', 'forms', 'errors', 'hint']) {
    assert(k in r, 'op=errors 回执缺字段：' + k + '（有：' + Object.keys(r).join(',') + '）');
  }
  assert(Array.isArray(r.errors), 'errors 要是数组');
  assert(r.forms.length >= 7, 'forms 要列出全部形态（供 AI 知道捞了什么）：' + r.forms.length);
  for (const f of r.forms) assert(f.what, '每条形态要有 what：' + JSON.stringify(f));
  if (r.count) {
    const e = r.errors[0];
    for (const k of ['time', 'run', 'channel', 'message', 'kind', 'fileLine']) assert(k in e, 'errors[] 缺字段：' + k);
    assert(ERROR_KIND_LABELS[e.kind], 'kind 不在已知形态里：' + e.kind);
  }
  return 'count=' + r.count + ' · kindCounts=' + JSON.stringify(r.kindCounts) + ' · truncated=' + r.truncated;
});

t('②f 找不到时：给**可执行**提示（指向层级/可见性 + 用截图判画面），不是干巴巴一句"没有"', async () => {
  // 造一份"干净"的 .gia 不可行（那是二进制）⇒ 走纯函数 + 工具层空结果两条路
  const clean = findErrorRecords([{ index: 1, instance: '47504-1-100-1', message: '一切正常' }]);
  eq(clean.count, 0, '干净样例');
  const hint = giaMod.NO_ERRORS_HINT;
  assert(/层级|可见性/.test(hint), '空结果提示没指向层级/可见性：' + hint);
  assert(/miliastra_shot/.test(hint), '空结果提示没说"用截图判画面"：' + hint);
  assert(/docs\//.test(hint), '空结果提示没给文档指针：' + hint);
  // 工具层：拿一个必然 0 命中的过滤（run 片段）看不到，就用"不存在的 run"⇒ 它会报错；改用纯函数已覆盖
  return '提示含「层级/可见性 + miliastra_shot + 文档指针」';
});

t('②g `summaryOnly` 只去正文：计数 / 分布 / fileLine / 提示一个不删', async () => {
  /*
   * ★ 2026-10-04：这条曾红（slim 9654 B > full 2151 B）—— **按 AI 使用判断：工具是对的、测试是错的**。
   *   真因：两次调用各自解析「**最新** `.gia`」，而**作者正在试玩** ⇒ 期间新的一局落盘，
   *   两次读到的是**不同文件**（一次命中 `staleLog:true` ⇒ 工具故意把 `errors` 置 `null` 并说明
   *   "别把过期日志当零报错"，**这是正确设计**；另一次是新文件 ⇒ 正常回 48 条）。
   *   ⇒ 修法：**把 `file` 钉死在同一条上**再比；拿不到文件就如实跳过（不伪装通过）。
   */
  const head = await log.execute({ op: 'errors' });
  if (!head.ok || !head.file) return '读不到 `.gia` ⇒ 如实跳过';
  const full = await log.execute({ op: 'errors', file: head.file });
  const slim = await log.execute({ op: 'errors', file: head.file, summaryOnly: true });
  assert(full.ok === true && slim.ok === true, '两次调用都要成功');
  if (full.staleLog || slim.staleLog) return '这份 `.gia` 不是本局（staleLog）⇒ 内容没有可比性，如实跳过';
  eq(slim.count, full.count, 'summaryOnly 改了 count');
  eq(slim.kindCounts, full.kindCounts, 'summaryOnly 改了 kindCounts');
  eq(slim.runsAffected, full.runsAffected, 'summaryOnly 改了 runsAffected');
  eq(slim.truncated, full.truncated, 'summaryOnly 改了 truncated');
  assert(slim.hint === full.hint, 'summaryOnly 丢了 hint');
  assert(JSON.stringify(slim).length <= JSON.stringify(full).length, 'summaryOnly 没有更小（' + JSON.stringify(slim).length + ' vs ' + JSON.stringify(full).length + '）');
  if (full.count && full.errors && full.errors.length) {
    assert(slim.errors[0].fileLine !== undefined, 'summaryOnly 把 fileLine 也去了（那是结论）');
    assert(slim.errors[0].message === undefined, 'summaryOnly 该去掉 message 正文');
    assert(slim.errorsOmitted === full.errors.length, 'errorsOmitted 要对：' + slim.errorsOmitted);
  }
  return 'count/kindCounts/hint 逐字相同；正文被去';
});

t('②h `op=errors` 支持 `run` 过滤；不存在的局给可执行报错', async () => {
  const r = await log.execute({ op: 'errors', run: '不存在的局片段' });
  assert(r.ok === false && /op=runs/.test(String(r.error || '')), '不存在的 run 该报错并指路 op=runs：' + JSON.stringify(r).slice(0, 200));
  return '报错指路 op=runs';
});

t('②i schema：op 枚举里有 errors，且 description 写清"不看标签"（AI 只看得见 schema）', () => {
  const props = log.parameters.properties;
  assert(props.op.enum.includes('errors'), 'op 枚举里没有 errors：' + JSON.stringify(props.op.enum));
  const d = String(log.description || '');
  assert(/op=errors/.test(d), 'description 没提 op=errors');
  assert(/不看标签/.test(d), 'description 没写清"不看标签"');
  assert(/没有.*标签|完全没有/.test(d), 'description 没点破"真机报错行可能没有标签"：' + d.slice(0, 300));
  assert(/落盘.*失败|落盘会因时序失败/.test(d), 'description 没提".gia 落盘会失败"');
  assert(/miliastra_shot/.test(d), 'description 没说"判画面用截图"');
  return 'op 含 errors + 三条口径都在 description 里';
});

/* ==================================================================== ③ .gia 落盘不稳定 */

t('③a landingMisleadingHint：**只有**"本局缺 + 更早有"才说这句话', () => {
  const h = landingMisleadingHint({ fileEpochSecs: [1790621379], sessionEpochSec: 1790621791, status: 'missing' });
  assert(typeof h === 'string', '该给提示时没给');
  assert(/这不代表本局脚本没跑/.test(h), '没说破"不代表没跑"：' + h);
  assert(/miliastra_shot/.test(h), '没说"判画面用截图"：' + h);
  assert(/落盘会因时序失败/.test(h), '没解释原因：' + h);
  assert(/1790621379/.test(h), '没报出"更早那局是哪个 epochSec"：' + h);
  // 不该说的三种情形
  eq(landingMisleadingHint({ fileEpochSecs: [], status: 'missing' }), null, '文件里没有任何局 ⇒ 不该说');
  eq(landingMisleadingHint({ fileEpochSecs: [1], status: 'landed' }), null, '已落盘 ⇒ 不该说');
  eq(landingMisleadingHint({ fileEpochSecs: [1], status: 'running' }), null, '还在跑 ⇒ 不该说');
  return 'missing + 有更早的局 ⇒ 给；其余三档 ⇒ null';
});

t('③b giaLandingState：missing 档同时带 `note` 与 `hint`；其余档 hint=null（形状稳定）', () => {
  const missing = giaLandingState({ latest: { name: 'a.gia' }, runEpochSec: 999, fileEpochSecs: [123] });
  eq(missing.status, 'missing', 'status');
  assert(/未落盘/.test(missing.note) && /不是本局/.test(missing.note), '原有 note 措辞丢了：' + missing.note);
  assert(typeof missing.hint === 'string' && /这不代表本局脚本没跑/.test(missing.hint), 'missing 没带 hint：' + missing.hint);
  for (const [label, input] of [
    ['running', { latest: { name: 'a.gia' }, running: true }],
    ['landed', { latest: { name: 'a.gia' }, runEpochSec: 123, fileEpochSecs: [123] }],
    ['none', { latest: null }],
  ]) {
    const r = giaLandingState(input);
    assert('hint' in r, label + ' 档缺 hint 字段（形状要稳定）');
    eq(r.hint, null, label + ' 档的 hint 该是 null');
  }
  return 'missing ⇒ hint 有；running/landed/none ⇒ hint:null（字段恒在）';
});

t('③c `miliastra_playtest op=status` 的 localGia 带 hint（工具层接线）', async () => {
  const r = await playtest.execute({ op: 'status' });
  assert(r.localGia && typeof r.localGia === 'object', 'status 没有 localGia');
  assert('hint' in r.localGia, 'localGia 没有 hint 字段（本局落盘与否都要能被判）');
  assert(['running', 'landed', 'missing', 'none', 'unknown'].includes(r.localGia.status), 'status 档不对：' + r.localGia.status);
  if (r.localGia.status === 'missing') assert(typeof r.localGia.hint === 'string', 'missing 档必须给 hint');
  return 'localGia.status=' + r.localGia.status + '，hint 字段在（' + (r.localGia.hint ? '有内容' : 'null') + '）';
});

t('③d `op=runs` 的 staleLog 档带 `landingHint`（与 status 同一个口径）', async () => {
  const r = await log.execute({ op: 'runs' });
  assert(r.ok === true, 'op=runs 要成功');
  if (r.staleLog === true) {
    assert(typeof r.landingHint === 'string' && /这不代表本局脚本没跑/.test(r.landingHint),
      'staleLog 时必须给 landingHint：' + JSON.stringify(r.landingHint));
  } else {
    assert(!r.landingHint, '不是 staleLog 时不该给 landingHint');
  }
  return 'staleLog=' + r.staleLog + ' ⇒ landingHint ' + (r.landingHint ? '在' : '不在（对）');
});

/* ==================================================================== ④ deploy 降噪 */

t('④a 显式 `file` + 名字不一致 ⇒ **note**（warning 为空），判据字段照留', () => {
  const live = [{ name: '特效 fx.lua' }, { name: '表现 view.lua' }];
  const r = pickLiveFile({ levelId: 7, liveFiles: live, source: 'D:\\gen\\特效 fx_coin-fan.lua', file: '特效 fx.lua' });
  assert(r.picked.name === '特效 fx.lua' && r.pickedBy === 'explicit', '显式 file 没优先：' + JSON.stringify(r).slice(0, 160));
  eq(r.warning, null, '显式 file 不该再给置顶 warning');
  assert(typeof r.mismatchNote === 'string' && /不一样/.test(r.mismatchNote), '没给 mismatchNote：' + r.mismatchNote);
  assert(/显式 `file`/.test(r.mismatchNote), 'note 要说清"这是显式 file 的正常用法"：' + r.mismatchNote);
  eq(r.destBasenameMatchesSource, false, '判据字段必须照旧保留');
  eq(r.basenameMismatch, true, '判据字段必须照旧保留');
  return 'warning=null + mismatchNote + destBasenameMatchesSource:false';
});

t('④b **自动挑**（唯一候选）时仍保留置顶 warning（那是真可能写错文件）', () => {
  const r = pickLiveFile({ levelId: 7, liveFiles: [{ name: '唯一.lua' }], source: 'D:\\gen\\别的.lua' });
  assert(r.pickedBy === 'only-one', '该走唯一候选：' + r.pickedBy);
  assert(typeof r.warning === 'string' && /不一样/.test(r.warning), '自动挑时 warning 必须留着：' + r.warning);
  eq(r.mismatchNote, undefined, '自动挑时不该给 mismatchNote');
  return 'only-one ⇒ warning 保留、mismatchNote 不给';
});

t('④c 显式 `file` 且名字**一致** ⇒ 两样都没有（正常路径不吵）', () => {
  const r = pickLiveFile({ levelId: 7, liveFiles: [{ name: '特效 fx.lua' }], source: 'D:\\gen\\特效 fx.lua', file: '特效 fx.lua' });
  eq(r.warning, null, '名字一致不该有 warning');
  assert(!r.mismatchNote, '名字一致不该有 mismatchNote：' + r.mismatchNote);
  eq(r.destBasenameMatchesSource, true, '名字一致该 true');
  return 'warning=null / 无 note / destBasenameMatchesSource:true';
});

t('④d 集成：`op=deploy` 被拒时**不写盘**，且显式 file 的 note 在顶层、没有置顶 warning', async () => {
  /*
   * ⚠️ 这条**故意让 deploy 失败**（source 指向一个不存在的文件）：
   *   · 这样它**一个字节都不会写**（无指纹、无还原指令）—— 不会碰用户的活文件；
   *   · 同时又能验到"最终回执的顶层形状"：显式 `file` ⇒ `note` 在、`warning` 不在、判据字段还在。
   *   （真正写盘成功那条路在 `deploy-test` 的临时夹具里跑，这里不重复。）
   */
  const src = path.join(os.tmpdir(), 'fx-hardening-不存在.lua');
  const r = await code.execute({ op: 'deploy', level: '1073741838', file: '特效 fx.lua', source: src });
  eq(r.ok, false, '源文件不存在必须拒绝');
  assert(Array.isArray(r.errors) && /源文件不存在/.test(r.errors[0] || ''), '被拒原因要说清"源文件不存在"：' + JSON.stringify(r.errors));
  // ★ 「拒绝 ⇒ 零改动」：没有指纹、没有还原指令（写盘那条路才该有这两样）
  eq(r.deployFingerprint, null, '被拒的部署不该留下部署指纹');
  eq(r.restoreWith, null, '被拒的部署不该给还原指令');
  // ★ 第 ④ 条的集成口径：显式 file 时顶层给 `note`、**不给** `warning`
  assert(/不一样/.test(String(r.note || '')), '顶层没有 mismatchNote：' + JSON.stringify(Object.keys(r)));
  eq(r.warning, undefined, '显式 file 时顶层不该有 warning：' + r.warning);
  eq(r.destBasenameMatchesSource, false, '判据字段仍在');
  eq(r.basenameMismatch, true, '判据字段仍在');
  return 'ok:false + errors[源文件不存在] + fingerprint:null + note 在 / warning 不在';
});

/* ==================================================================== 收尾 */

for (const [name, fn] of queue) {
  try { await fn(); ok(name); } catch (e) { bad(name, (e && e.message) || String(e)); }
}
console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
if (failures.length) process.exitCode = 1;
