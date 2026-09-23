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

console.log('');
try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
