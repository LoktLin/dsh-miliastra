/**
 * 探针部署路径自测：用 **MILIASTRA_LOCALLOW 指向一个假存档根**，
 * 完整走一遍 `miliastra_probe op=deploy` 与 `op=collect` —— 不碰真实活文件。
 *
 * 为什么能这么测：locate.mjs 的存档根是在**调用时**读环境变量的，
 * 所以把 MILIASTRA_LOCALLOW 指到临时目录，整套「定位关卡 → 找活文件 → 部署 → 备份 → 校验」
 * 就会落在假沙箱里，语义与真实路径完全一致。
 *
 * 用法：node tests/probe-deploy-test.mjs
 *
 * ⚠️ 断言必须 `await`。本文件的 check() 是 async 的 —— 早先版本写成了同步 check + async fn，
 *    失败会变成 unhandled rejection 而**测试照样报通过**。这类「不会失败的测试」比没有测试更坏。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- 造一个假存档根 ----------
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fake-localow-'));
const ACCOUNT = '999000999';
const LEVEL = '1073741999';
const luaDir = path.join(fakeRoot, '原神', 'BeyondLocal', ACCOUNT, 'Beyond_Local_Save_Level', LEVEL, 'external_lua_file');
fs.mkdirSync(luaDir, { recursive: true });
const livePath = path.join(luaDir, 'main.lua');
const ORIGINAL = '-- 用户的玩法（假沙箱）\r\nlocal x = 1\r\n';
fs.writeFileSync(livePath, ORIGINAL, 'utf8');

process.env.MILIASTRA_LOCALLOW = fakeRoot;

const { TOOLS } = await import('../index.js');
const probe = TOOLS.find((t) => t.name === 'miliastra_probe');
const health = TOOLS.find((t) => t.name === 'miliastra_health');

let deployed = null;

await check('miliastra_health 认得这个假存档根（证明 MILIASTRA_LOCALLOW 生效）', async () => {
  const d = await health.execute({}, {});
  assert(d.localLow === fakeRoot, `localLow 没跟上环境变量：${d.localLow}`);
  assert(d.current && d.current.levelId === LEVEL, '当前关卡没被认出：' + JSON.stringify(d.current));
  return `${d.localLow}；当前=${d.current.brand}/${d.current.levelId}`;
});

await check('miliastra_probe op=render 能生成探针源码（不写盘）', async () => {
  const d = await probe.execute({ op: 'render', template: 'ping', tag: 'FAKE' }, {});
  assert(d.ok === true, 'render 失败：' + d.error);
  assert(/script:EnableUpdate\(true\)/.test(d.lua), '探针里缺 EnableUpdate(true) —— 会只打三行空壳');
  assert(d.lua.includes('"FAKE"'), '标签没写进 TAG 常量');
  return `${d.bytes} 字节，含 EnableUpdate`;
});

await check('miliastra_probe op=deploy 落到假沙箱：备份 + 哈希 + 无 BOM', async () => {
  const before = fs.readFileSync(livePath);
  const d = await probe.execute({ op: 'deploy', template: 'ping', tag: 'FAKE' }, {});
  assert(d.ok === true, 'deploy 失败：' + JSON.stringify(d.errors || d.error));
  assert(d.verified === true, 'verified 不为 true');
  assert(d.bomFree === true, '部署后带 BOM');
  assert(d.backup && fs.existsSync(d.backup), '没有产生备份');
  assert(Buffer.compare(fs.readFileSync(d.backup), before) === 0, '备份内容 != 部署前的活文件');
  const now = fs.readFileSync(livePath, 'utf8');
  assert(now.includes('script:EnableUpdate(true)'), '活文件没被换成探针');
  deployed = d;
  return `活文件 ${d.bytes} 字节  sha=${String(d.sha256).slice(0, 12)}…  备份=${path.basename(d.backup)}`;
});

await check('探针源码另存一份在沙箱目录里（便于事后复查）', async () => {
  assert(deployed && deployed.probeSource, 'probeSource 缺失');
  assert(fs.existsSync(deployed.probeSource), 'probeSource 文件不存在：' + deployed.probeSource);
  const src = fs.readFileSync(deployed.probeSource, 'utf8');
  assert(fs.readFileSync(livePath, 'utf8') === src, '活文件与另存的探针源码不一致');
  return path.basename(deployed.probeSource);
});

await check('op=collect 在「还没试玩过」时给出明确错误，而不是静默', async () => {
  let threw = null;
  let d = null;
  try { d = await probe.execute({ op: 'collect', tag: 'FAKE' }, {}); } catch (e) { threw = e; }
  if (threw) return '明确抛错：' + threw.message;
  assert(d && d.ok === false, '没日志却返回了 ok=true');
  return '明确回 ok:false：' + d.error;
});

await check('作用域隔离：真活文件不在这个假存档根下（本测试不可能碰到它）', async () => {
  assert(String(livePath).startsWith(os.tmpdir()), '测试路径不在系统临时目录下 —— 有碰到真文件的可能');
  assert(String(livePath).startsWith(fakeRoot), '活文件不在假存档根下');
  return '假根 ' + fakeRoot;
});

await check('写错的 MILIASTRA_LOCALLOW 不会静默回退到真实存档根（会明确报扫不到）', async () => {
  const saved = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now());
  try {
    const d = await health.execute({}, {});
    // 注意：os.tmpdir() 本身就在 AppData 下，所以不能用「包含 AppData」来判断有没有回退，
    // 只能直接比对「localLow 是否 == 我们指定的那个不存在的路径」。
    assert(d.localLow === process.env.MILIASTRA_LOCALLOW, 'localLow 没照做，跑别处去了：' + d.localLow);
    assert(d.levelCount === 0 && d.current === null, '不存在的根却扫出了关卡：' + d.levelCount);
    return '明确报 levelCount=0，未回退';
  } finally {
    process.env.MILIASTRA_LOCALLOW = saved;
  }
});

await check('两种关卡布局都要扫到：`<id>\\<id>.gil` 与根目录的 `<id>.gil`（曾漏掉后者 6/8 个）', async () => {
  const saved = process.env.MILIASTRA_LOCALLOW;
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-layout-'));
  const saveRoot = path.join(root2, '原神', 'BeyondLocal', '555', 'Beyond_Local_Save_Level');
  fs.mkdirSync(path.join(saveRoot, '1073741001', 'external_lua_file'), { recursive: true });
  fs.writeFileSync(path.join(saveRoot, '1073741001', '1073741001.gil'), 'x');
  fs.writeFileSync(path.join(saveRoot, '1073741001', 'external_lua_file', 'main.lua'), '-- x\r\n');
  fs.writeFileSync(path.join(saveRoot, '1073741002.gil'), 'y'); // 布局 B：直接躺根目录
  process.env.MILIASTRA_LOCALLOW = root2;
  try {
    const d = await health.execute({ all: true }, {});
    const ids = d.levels.map((l) => l.levelId + '(' + (l.layout || '?') + ')').sort();
    assert(ids.includes('1073741001(folder)'), '漏了布局 A：' + ids.join(', '));
    assert(ids.includes('1073741002(root-gil)'), '漏了布局 B（根目录 .gil）：' + ids.join(', '));
    return '两种布局都扫到：' + ids.join(', ');
  } finally {
    process.env.MILIASTRA_LOCALLOW = saved;
    try { fs.rmSync(root2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check('一个关卡多个活文件：全部列出 / 可按名字选 / 选错明确报错 / 备份各自独立', async () => {
  const saved = process.env.MILIASTRA_LOCALLOW;
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-multilua-'));
  const luaDir3 = path.join(root3, '原神', 'BeyondLocal', '556', 'Beyond_Local_Save_Level', '1073741003', 'external_lua_file');
  fs.mkdirSync(luaDir3, { recursive: true });
  fs.writeFileSync(path.join(luaDir3, '甲角色.lua'), '-- A\r\n', 'utf8');
  fs.writeFileSync(path.join(luaDir3, '乙角色.lua'), '-- B\r\n', 'utf8');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(luaDir3, '乙角色.lua'), later, later);
  process.env.MILIASTRA_LOCALLOW = root3;
  const code = TOOLS.find((t) => t.name === 'miliastra_code');
  try {
    const h = await health.execute({}, {});
    assert(h.current && h.current.luaFiles.length === 2, 'health 没列出两个活文件：' + JSON.stringify(h.current && h.current.luaFiles));
    assert(/2 个/.test(h.hint), 'hint 没提数量：' + h.hint);

    const def = await code.execute({ op: 'inspect' }, {});
    assert(String(def.inspected.path).endsWith('乙角色.lua'), '默认没挑「最近改动」的那个：' + def.inspected.path);

    const picked = await code.execute({ op: 'inspect', file: '甲角色.lua' }, {});
    assert(String(picked.inspected.path).endsWith('甲角色.lua'), '按名字选没生效：' + picked.inspected.path);

    let threw = null;
    try { await code.execute({ op: 'inspect', file: '不存在.lua' }, {}); } catch (e) { threw = e; }
    assert(threw, '指定不存在的活文件竟然没报错（会悄悄操作别的文件）');
    assert(/现有：/.test(threw.message), '报错里没列出可选项：' + threw.message);

    const bk = await code.execute({ op: 'backups', file: '甲角色.lua' }, {});
    assert(bk.count === 0, '甲角色 的备份数应为 0（按文件隔离）：' + bk.count);
    return '列出 2 个 / 默认取最近改动 / 指定生效 / 选错报错 / 备份按文件隔离';
  } finally {
    process.env.MILIASTRA_LOCALLOW = saved;
    try { fs.rmSync(root3, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

await check('★ 每个探针模板生成出来的 Lua 都通过结构校验（模板写错会静默不生效）', async () => {
  const { PROBE_TEMPLATES, renderProbe } = await import('../lib/probes.mjs');
  const { lintLua, lintSummary } = await import('../lib/lualint.mjs');
  assert(PROBE_TEMPLATES.length >= 4, '模板数不对：' + PROBE_TEMPLATES.join(', '));
  const badTpl = [];
  const sizes = [];
  for (const t of PROBE_TEMPLATES) {
    const r = renderProbe(t, { tag: 'SELFTEST' });
    assert(r.ok, `模板 ${t} 渲染失败：${r.error}`);
    assert(/EnableUpdate\(true\)/.test(r.lua), `模板 ${t} 没开 EnableUpdate(true) —— 只会打 OnInit/OnEnable/OnStart 三行空壳`);
    const lr = lintLua(r.lua);
    if (!lr.ok) badTpl.push(t + ': ' + lintSummary(lr));
    sizes.push(t + ' ' + r.bytes + 'B');
  }
  assert(badTpl.length === 0, '模板结构有问题：' + badTpl.join(' | '));

  // 单条日志消息上限**实测正好 10000 字符**，超了会被静默截断。模板必须走分片打印。
  const noChunk = PROBE_TEMPLATES.filter((t) => !/local function pChunked\(/.test(renderProbe(t, { tag: 'SELFTEST' }).lua));
  assert(noChunk.length === 0, '这些模板没有分片打印 helper（长输出会被静默截断）：' + noChunk.join(', '));
  for (const t of PROBE_TEMPLATES) {
    const lua = renderProbe(t, { tag: 'SELFTEST' }).lua;
    const m = /local CHUNK = (\d+)/.exec(lua);
    assert(m, `模板 ${t} 没有 CHUNK 常量`);
    assert(Number(m[1]) > 0 && Number(m[1]) < 10000, `模板 ${t} 的 CHUNK=${m[1]} 必须小于日志上限 10000`);
  }
  return `${PROBE_TEMPLATES.length} 个模板全通过（${sizes.join(' / ')}；均为 ${/local CHUNK = (\d+)/.exec(renderProbe(PROBE_TEMPLATES[0], { tag: 'SELFTEST' }).lua)[1]} 字符分片）`;
});

/* ---------------- 0.0.4：miliastra_code 的 fixbom 与部署指纹（假存档根，工具层端到端） ---------------- */

const code = TOOLS.find((t) => t.name === 'miliastra_code');

await check('op=inspect：没有部署记录时**如实说没有**（不假装一致）', async () => {
  const d = await code.execute({ op: 'inspect' }, {});
  assert(d.ok === true, 'inspect 失败：' + JSON.stringify(d.error));
  assert(d.inspected && d.inspected.path === livePath, '体检的不是那个假活文件：' + JSON.stringify(d.inspected && d.inspected.path));
  assert(d.deploy && d.deploy.hasFingerprint === false, '从没部署过却说有指纹：' + JSON.stringify(d.deploy));
  assert(/没有部署记录/.test(d.deploy.note), '说法不对：' + d.deploy.note);
  return '没有记录 → hasFingerprint:false + 说明';
});

await check('op=deploy：部署成功后**自动写指纹**，再 inspect 就是「一致」', async () => {
  const srcFile = path.join(fakeRoot, 'v2.lua');
  fs.writeFileSync(srcFile, '-- v2（工具层测试）\r\nlocal x = 2\r\n', 'utf8');
  const d = await code.execute({ op: 'deploy', source: srcFile }, {});
  assert(d.ok === true, '部署失败：' + JSON.stringify(d.errors));
  assert(d.deployFingerprint && d.deployFingerprint.ok === true, '部署成功但没写指纹：' + JSON.stringify(d.deployFingerprint));
  assert(/\.miliastra-deploy\.json$/.test(d.deployFingerprint.path), '指纹文件名不对：' + d.deployFingerprint.path);
  assert(path.dirname(d.deployFingerprint.path) === path.join(luaDir, '_backup'), '指纹没落在备份目录：' + d.deployFingerprint.path);

  const after = await code.execute({ op: 'inspect' }, {});
  assert(after.deploy.hasFingerprint === true && after.deploy.sameAsDeploy === true,
    '刚部署完却说变了：' + JSON.stringify(after.deploy));

  // 模拟编辑器把内存里的旧版存回磁盘 → 下一次 inspect 必须报「被改写」
  fs.writeFileSync(livePath, '-- 被编辑器写回的旧版\r\nlocal x = 2\r\nlocal y = 3\r\n', 'utf8');
  const drift = await code.execute({ op: 'inspect' }, {});
  assert(drift.deploy.changedSinceDeploy === true, '被改写了却没报：' + JSON.stringify(drift.deploy));
  assert(/编辑器/.test(drift.deploy.note), '没解释原因：' + drift.deploy.note);
  return '写指纹 → sameAsDeploy → 改写后 changedSinceDeploy（差 ' + drift.deploy.bytesDelta + 'B/' + drift.deploy.lineDelta + ' 行）';
});

await check('op=fixbom：**本来没有 BOM 就什么都不做**（真机上最常走的那条路）', async () => {
  const before = fs.readFileSync(livePath);
  const stBefore = fs.statSync(livePath).mtimeMs;
  const d = await code.execute({ op: 'fixbom' }, {});
  assert(d.ok === false && d.changed === false, '对没 BOM 的文件动了手：' + JSON.stringify(d).slice(0, 200));
  assert(/本来就没有 BOM/.test(d.error), '没说清原因：' + d.error);
  assert(Buffer.compare(fs.readFileSync(livePath), before) === 0, '活了文件被改了');
  assert(fs.statSync(livePath).mtimeMs === stBefore, '无 BOM 时也碰了文件（mtime 变了）');
  return '零改动，如实回「本来就没有 BOM」';
});

await check('op=fixbom：带 BOM 时只去 3 字节（工具层端到端）', async () => {
  const body = Buffer.from('-- 带 BOM\r\nlocal 中文 = "编码"\r\n', 'utf8');
  fs.writeFileSync(livePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  const d = await code.execute({ op: 'fixbom' }, {});
  assert(d.ok === true, '去 BOM 失败：' + JSON.stringify(d.error || d));
  assert(d.removedBytes === 3 && d.after.bom === false, '没去掉 3 字节：' + JSON.stringify({ r: d.removedBytes }));
  assert(Buffer.compare(fs.readFileSync(livePath), body) === 0, '除了 BOM 还动了别的字节');
  assert(d.restoreWith && /op=restore/.test(d.restoreWith), '没给可照抄的还原命令');
  // 去完再体检：bom 必须是 false，中文还在
  const ins = await code.execute({ op: 'inspect' }, {});
  assert(ins.inspected.bom === false && ins.inspected.hasChinese === true, '去完 BOM 后体检不对：'
    + JSON.stringify({ bom: ins.inspected.bom, cn: ins.inspected.hasChinese }));
  return '3 字节 / 逐字节比对通过 / 中文未损 / 回执带 restoreWith';
});

/* ---------------- 0.0.5：ErrorLog 巡检 + 部署后对账（同样是假存档根） ---------------- */

await check('ErrorLog 巡检：先如实报「没有」，放一个之后能报出内容与行数', async () => {
  // ① 没有的时候 —— 「没有」这件事本身也要显示（否则「.gia 干净」容易被当成「脚本没事」）
  const none = await code.execute({ op: 'inspect' }, {});
  assert(none.errorLog && none.errorLog.exists === false, '没如实报「没有 ErrorLog」：' + JSON.stringify(none.errorLog).slice(0, 160));
  assert(/循环调用/.test(none.errorLog.note), '没说清「这类错不进 .gia」：' + none.errorLog.note);

  // ② 有的时候
  fs.writeFileSync(path.join(luaDir, 'ErrorLog.txt'),
    'attempt to call a nil value (global \'nope\')\r\nstack traceback:\r\n\tmain.lua:12\r\n', 'utf8');
  const hit = await code.execute({ op: 'inspect' }, {});
  assert(hit.errorLog.exists === true, '放了 ErrorLog.txt 却没报出来：' + JSON.stringify(hit.errorLog).slice(0, 160));
  assert(hit.errorLog.lineCount === 3, '行数不对：' + hit.errorLog.lineCount);
  assert(/nil value/.test((hit.errorLog.head || []).join(' ')), '没把首几行带出来');
  assert(/不进 \.gia/.test(hit.errorLog.warn || ''), '没给出「这类错只写这里」的提醒');

  // health 也要顺带报（人最先调的是它）
  const h = await health.execute({}, {});
  assert(h.errorLog && h.errorLog.exists === true, 'health 没有带 ErrorLog 状态');
  fs.rmSync(path.join(luaDir, 'ErrorLog.txt'), { force: true });
  const gone = await health.execute({}, {});
  assert(gone.errorLog.exists === false, '删掉之后没回到「没有」');
  return '没有 → exists:false + 说明 / 有 → 行数+首几行+warn / health 也带';
});

await check('部署后对账：假根没有 .gil 时**如实说对不了账**（不假装一致）', async () => {
  const srcFile = path.join(fakeRoot, 'v3.lua');
  fs.writeFileSync(srcFile, '-- v3 对账测试\r\nlocal x = 3\r\n', 'utf8');
  const d = await code.execute({ op: 'deploy', source: srcFile }, {});
  assert(d.ok === true, '部署失败：' + JSON.stringify(d.errors));
  assert(d.reconcile && d.reconcile.ok === false, '没有 .gil 却说对上了：' + JSON.stringify(d.reconcile));
  assert(/没有 \.gil/.test(d.reconcile.reason), '原因没说清：' + d.reconcile.reason);
  // 对不了账时 nextStep 不许说「可以试玩了」
  assert(!/重新试玩一局，然后/.test(d.nextStep || ''), '对不了账却给了「可以试玩」的下一步：' + d.nextStep);
  return '没有 .gil → ok:false + 原因；nextStep 不含「可以试玩」';
});

console.log('');
try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
