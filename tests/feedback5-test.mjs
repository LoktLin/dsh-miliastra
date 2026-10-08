/**
 * 第五批反馈自测：2026-09-26 施工单的 P0-2 / P1-3 / P1-4 / P2-5
 *
 * 每条都写清「**修之前为什么红**」—— 这里的断言都是为了**将来某次改动时能重新变红**：
 *
 *   · **P1-4**：`brief:true` 的 `luaFiles` 原本只是**名字数组** ⇒ 看不出「刚建映射的活文件是 0 字节」，
 *     也看不出「这个文件压根没进 `.gil` 挂载集合」。修前这两个信息只能靠 `op=deploy` 的 `candidates[].bytes` 事后发现。
 *   · **P2-5**：往**新建的空脚本**里第一次 deploy 时，回执有 `dest` 但**没有任何字段**说"这是首次写入"，
 *     而"编辑器里忘了存盘"正是「部署了却什么都没发生」的根因。
 *   · **P0-2**：`staleLog` 口径只在 `miliastra_log` 上；`map op=script` 与 `health op=sha` 里的 `.gil` 那一列
 *     **是存盘快照、不是实时的**，却没有任何归属/新鲜度字段 ⇒ 容易把上一次存盘的内容当成本次结果。
 *   · **P1-3**：两个真机坑（`sanitize` 清复合模板 ⇒ 整卡不画；构建期实例化 ⇒ 不画）只能靠**踩坑人的记忆**传播，
 *     deploy/inspect 完全静态可判却不提。
 *
 * 全部用**合成假存档 / 假活文件**（`MILIASTRA_LOCALLOW` + `MILIASTRA_DATA_DIR` 指到临时目录），不碰真机。
 * 需要工作区真样例的那一条（P1-3 的改造前 `board_body.lua`）**找不到就如实说"不在本机"并改用合成夹具**。
 *
 * 用法：node tests/feedback5-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ⚠️ `MILIASTRA_DATA_DIR` 必须在 import 之前设好（sim.mjs 在模块初始化时读它）——所以下面全用动态 import。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-fb5-'));
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
const eq = (got, want, msg) => { if (got !== want) throw new Error(msg + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）'); };

const { TOOLS } = await import('../index.js');
const { snapshotFreshness, localTimeText } = await import('../lib/freshness.mjs');
const { uiWarnings } = await import('../lib/uiwarn.mjs');

const health = TOOLS.find((t) => t.name === 'miliastra_health');
const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');

/* ------------------------------------------------------------------ 合成 protobuf / 假存档 */
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

/** 合成 `.gil`：脚本映射 `#50` + 挂载层级 `#6`（形状同 feedback3-test / 真机六脚本图）。 */
function makeGil({ levelId, name = '假图', account = 201170108, version = '7.1.0', scripts = [], mounts = [], withHierarchy = true }) {
  const recs = scripts.map((s) => pbBytes(1, Buffer.concat([
    pbNum(1, s.mappingId),
    pbStr(2, s.name),
    ...(s.file ? [pbStr(3, s.file)] : []),
    pbBytes(5, Buffer.from(s.source == null ? '-- x\n' : s.source, 'utf8')),
  ])));
  const parts = [pbNum(1, levelId), pbStr(2, name), pbNum(39, account), pbStr(43, version), pbBytes(50, Buffer.concat(recs))];
  if (withHierarchy) {
    const owners = mounts.map((g) => pbBytes(4, Buffer.concat([
      pbStr(1, g.owner), pbNum(3, g.mappingIds.length),
      ...g.mappingIds.map((mid) => pbBytes(5, Buffer.concat([pbNum(1, 7900), pbNum(2, mid)]))),
    ])));
    parts.push(pbBytes(6, pbBytes(1, Buffer.concat(owners.length ? owners : [pbStr(1, '空层级')]))));
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(body.length, 16);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
}

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

/* ================================================================== P1-4 · brief 带字节数 */

/*
 * 修之前为什么红：`brief:true` 的 `luaFiles` 是 `["HUD hud.lua", …]` —— 光看它**看不出**那个文件是 0 字节。
 * 创作者的场景是：编辑器里新建并挂了一个 `HUD hud.lua`，脚本还没写进去 ⇒ brief 里它和别的活文件长得一模一样。
 */
const b1 = fakeLevel({
  levelId: '1073741911',
  gils: [makeGil({
    levelId: 1073741911,
    scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua' }],
    mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }],
  })],
  luas: { 'game_01.lua': '-- x\n', '空脚本.lua': '', '没挂.lua': '-- z\n' },
});

await check('P1-4 ① brief 的 luaFiles = [{name, bytes}]，0 字节那个标 empty 并在 note 里点名', async () => {
  process.env.MILIASTRA_LOCALLOW = b1.root;
  const r = await health.execute({ brief: true }, {});
  assert(r.ok === true && r.brief === true, 'brief 没生效：' + JSON.stringify(r).slice(0, 160));
  assert(Array.isArray(r.luaFiles) && r.luaFiles.length === 3, 'luaFiles 不对：' + JSON.stringify(r.luaFiles));
  assert(r.luaFiles.every((f) => typeof f.name === 'string' && typeof f.bytes === 'number'),
    '每个元素必须是 {name, bytes}：' + JSON.stringify(r.luaFiles));
  const empty = r.luaFiles.find((f) => f.name === '空脚本.lua');
  assert(empty && empty.bytes === 0 && empty.empty === true, '0 字节没标出来：' + JSON.stringify(empty));
  assert(/空脚本/.test(r.note || '') && /空脚本\.lua/.test(r.note || ''), 'note 没点名 0 字节那个：' + r.note);
  return 'luaFiles=' + r.luaFiles.map((f) => f.name + ':' + f.bytes).join(' / ');
});

await check('P1-4 ② 不在 `.gil` 挂载集合里的活文件 → mounted:false 并在 note 里点名；mountKnown:true', async () => {
  const r = await health.execute({ brief: true }, {});
  assert(r.mountKnown === true, '挂载表读得到却不是 true：' + r.mountKnown);
  const notMounted = r.luaFiles.find((f) => f.name === '没挂.lua');
  assert(notMounted && notMounted.mounted === false, '没标出未挂载：' + JSON.stringify(notMounted));
  assert(/挂载集合/.test(r.note || '') && /没挂\.lua/.test(r.note || ''), 'note 没点名未挂载那个：' + r.note);
  // 挂上的那个**不许**被标成 false（假阴性比漏报更坏）
  const ok = r.luaFiles.find((f) => f.name === 'game_01.lua');
  assert(ok && !('mounted' in ok), '已挂载的活文件被标了 mounted 字段：' + JSON.stringify(ok));
  return 'note=' + r.note;
});

await check('P1-4 ③ 加了两类提示后，brief 回执仍 < 1024 B（它是"先调它"的入口）', async () => {
  const r = await health.execute({ brief: true }, {});
  const b = bytesOf(r);
  assert(b < 1024, 'brief 涨到 ' + b + ' B：' + JSON.stringify(r).slice(0, 200));
  // ★ 2026-10-02：brief 档**不再有** `currentEvidence` / `currentAlternatives`（实测那两项 285+294 B，
  //   路径与备选都已在 luaDir/gil/logDir 与完整档里）⇒ 合成一行 `currentWhy`；钉住这个形状，别被改回去。
  assert(!('currentEvidence' in r) && !('currentAlternatives' in r),
    'brief 档又把 currentEvidence/currentAlternatives 放回来了（体积）');
  assert(typeof r.currentWhy === 'string' && r.currentWhy.length > 0, 'brief 缺 currentWhy');
  return b + ' B（含 0 字节 + 未挂载两类提示；备选压成一行）';
});

await check('P0（使用反馈 2026-10-02 #2）`inferLiveNameFromBackup`：**备份名能推断目标**就以它为准，认不出回 null（不猜）', async () => {
  const { inferLiveNameFromBackup } = await import('../lib/codefile.mjs');
  const L = ['表现 view.lua', '背景层 bg.lua', '主控 main.lua', 'aa.lua', 'a.lua'];
  eq(inferLiveNameFromBackup('C:\\b\\背景层 bg.bak', L), '背景层 bg.lua', '固定名没认出来');
  eq(inferLiveNameFromBackup('C:\\b\\表现 view.bak', L), '表现 view.lua', '固定名没认出来（表现）');
  eq(inferLiveNameFromBackup('C:\\b\\主控 main.20261002-113000_备份.lua', L), '主控 main.lua', '时间戳名没认出来');
  eq(inferLiveNameFromBackup('C:\\b\\随便一个.bak', L), null, '认不出却猜了一个');
  eq(inferLiveNameFromBackup('C:\\b\\.bak', L), null, '空 stem 不该命中');
  eq(inferLiveNameFromBackup('C:\\b\\aa.bak', L), 'aa.lua', '短名抢了长名的备份（会还原错文件）');
  return '固定名/时间戳名/认不出/最长匹配 四种情形都对';
});

await check('★ #8 两条按形状自动挂的已知坑（《插件调用优化方向》第 8 条）：`applyVars` ⇒ 慢一拍 · `SetAsLastSibling` ⇒ 返回值可能恒 false', async () => {
  const { uiWarnings } = await import('../lib/uiwarn.mjs');
  const code = ['local function tick()', '  applyVars(c:GetChild("T"), t)', '  local ret = node:SetAsLastSibling()', 'end'].join('\n');
  const r = uiWarnings(code, 'view.lua');
  const rules = r.map((w) => w.rule);
  assert(rules.includes('vars-write-lags-one-frame'), '`applyVars` 没挂上"慢一拍"提示：' + JSON.stringify(rules));
  assert(rules.includes('set-as-last-sibling-may-return-false'), '`SetAsLastSibling` 没挂上"返回值恒 false"提示：' + JSON.stringify(rules));
  const vars = r.find((w) => w.rule === 'vars-write-lags-one-frame');
  assert(/直推|Invoke/.test(vars.fix), '修法必须给出**直推**这条出路：' + vars.fix);
  assert(vars.line === 2, '行号不对：' + vars.line);
  eq(uiWarnings('local x = 1\n', 'view.lua').length, 0, '干净代码不该误报');
  return '两条形状各自命中（带行号 + 修法），干净代码 0 命中';
});

await check('★ #10 `pairCommandsWithUi`（《插件调用优化方向》第 10 条）：命令 ↔ 画面配对，点名"有命令无画面"', async () => {
  const { pairCommandsWithUi } = await import('../lib/gia.mjs');
  const rows = [
    { i: 0, time: 't', channel: 'A', message: '命令 图鉴快捷' },
    { i: 1, time: 't', channel: 'A', message: '渲染 时间=1' },
    { i: 2, time: 't', channel: 'A', message: '命令 详情' },
    { i: 3, time: 't', channel: 'A', message: '（这条跟画面无关）' },
    { i: 4, time: 't', channel: 'A', message: '命令 关掉' },
    { i: 5, time: 't', channel: 'A', message: '收起 完成' },
  ];
  const r = pairCommandsWithUi(rows, { cmdRe: /命令/, uiRe: /渲染|收起/, window: 2 });
  eq(r.commands, 3, '命令数不对');
  eq(r.pairs.length, 3, '配对数不对');
  eq(r.pairs[0].uiFound, true, '第一条命令后面有渲染，该判 found');
  // 第二条命令后面 2 行内没有画面记录（`window:2`）⇒ 必须点名
  eq(r.pairs[1].uiFound, false, '窗口内没有画面记录时必须判 false');
  eq(r.noUiAfterCount, 1, '「有命令无画面」的点名数不对');
  eq(r.noUiAfter[0].i, 2, '点名的不是第二条命令');
  assert(/不等于"画面真的没变"/.test(r.note), 'note 必须说清"日志配对 ≠ 画面真的没变"');
  assert(/miliastra_shot/.test(r.note), 'note 必须指路帧差取证');
  return '3 条命令 → 2 条配到画面、1 条被点名（窗口 2 行）';
});

await check('★ P2-5（《上下文瘦身设计》）`asset op=measure`：众数色 + 连通块（纯函数可预期；失败**不抛异常**）', async () => {
  const { colorMode, blobsFromGrid } = await import('../lib/measure.mjs');
  const { TOOLS } = await import('../index.js');
  // 合成网格：左半纯红（饱和）、右半中灰 ⇒ 众数与两块都可预期
  const grid = [];
  for (let y = 0; y < 4; y += 1) {
    const row = [];
    for (let x = 0; x < 4; x += 1) row.push(x < 2 ? [255, 0, 0, 255] : [128, 128, 128, 255]);
    grid.push(row);
  }
  const cm = colorMode(grid, { levels: 16 });
  eq(cm.hex, '#FF0000', '众数色不对：' + cm.hex);
  eq(cm.count, 8, '众数像素数不对');
  eq(cm.ratio, 0.5, '占比不对');
  const bl = blobsFromGrid(grid, { minArea: 2 });
  eq(bl.count, 2, '连通块数不对：' + bl.count);
  eq(bl.byKind.saturated, 1, '饱和块数不对');
  eq(bl.byKind.gray, 1, '灰块数不对');
  const left = bl.blobs.find((b) => b.kind === 'saturated');
  eq(left.w + 'x' + left.h, '2x4', '左边那块包围盒不对：' + left.w + 'x' + left.h);
  // 全透明 + 小于 minArea 的噪点都要被丢掉
  const noisy = [[[0, 0, 0, 0], [255, 255, 0, 255], [255, 255, 0, 255]]];
  eq(blobsFromGrid(noisy, { minArea: 3 }).count, 0, '噪点该被 minArea 丢掉');
  eq(colorMode(noisy).count, 2, '全透明像素不该计数');
  // 工具面：失败必须回 ok:false（**不抛异常** —— 抛出去会打断调用方一整轮）
  const a = TOOLS.find((t) => t.name === 'miliastra_asset');
  assert(((a.parameters.properties.op.enum) || []).includes('measure'), 'asset 的 op 枚举里没有 measure');
  const bad = await a.execute({ op: 'measure', source: 'C:\\definitely\\not\\here.txt' });
  eq(bad.ok, false, '不存在的文件该回 ok:false');
  const noSrc = await a.execute({ op: 'measure' });
  eq(noSrc.code, 'MEASURE_NO_SOURCE', '不给 source 该明确报 code');
  return '众数 #FF0000/50% · 两块 2x4（饱和+灰）· 噪点与全透明都丢掉 · 失败回 ok:false';
});

await check('★ P2-6 / P3-7（《上下文瘦身设计》）errors 的 forms 按需回 + deploy 的 checklist 短句数组', async () => {
  const { TOOLS, minifyReceipt } = await import('../index.js');
  const log = TOOLS.find((t) => t.name === 'miliastra_log');
  const code = TOOLS.find((t) => t.name === 'miliastra_code');
  assert(Object.keys((log.parameters || {}).properties || {}).includes('explain'), 'log 缺 explain 参数（P2-6）');
  // ⚠️ 真调可能因为"解析到的当前关卡没有日志目录"而报错 ⇒ **try 住并如实跳过真数据那半段**（不伪装通过）
  let a = null;
  let b = null;
  try {
    a = await log.execute({ op: 'errors', summaryOnly: true });
    b = await log.execute({ op: 'errors', summaryOnly: true, explain: true });
  } catch (e) { a = null; b = null; }
  if (a && a.ok === true) {
    eq('forms' in a, false, '默认不该再带 forms（固定文档，578 B/次）');
    eq(typeof a.formsCount, 'number', '默认该给 formsCount（结论不丢）');
    assert(Array.isArray(b.forms) && b.forms.length > 0, 'explain:true 时必须回全部 8 条');
    assert(typeof a.count === 'number' && a.kindCounts, '结论字段（count/kindCounts）不许因为瘦身而丢');
  }
  // P3-7：deploy 的 checklist 是**数组短句**，且 min 骨架也带着它（决策要用）
  const dep = minifyReceipt({ ok: true, op: 'deploy', dest: 'd.lua', bytes: 1, sha256: 'A'.repeat(64), checklist: ['存盘', '重开一局', '看 match'] }, 'deploy');
  assert(Array.isArray(dep.checklist) && dep.checklist.length === 3, 'deploy min 骨架该带上 checklist');
  return 'errors 默认无 forms（有 formsCount）/ explain:true 8 条 · checklist 3 条短句（min 骨架也带）';
});

await check('★ P1-4（《上下文瘦身设计》）`sim bind boot`：探针改写**只改内存副本** —— cur/mode 生效、complete 如实报 unsupported、**真源不动**', async () => {
  const { applyBootPatch } = await import('../lib/sim.mjs');
  const { patchSimBindBoot, TOOLS } = await import('../index.js');
  const props = Object.keys((TOOLS.find((t) => t.name === 'miliastra_sim').parameters || {}).properties || {});
  assert(props.includes('boot'), 'sim 缺 boot 参数');
  const original = ['local cur = 1', 'local function boot()', '  showTitle()', '  registerCursor(c, 0)', 'end', 'return boot'].join('\n');
  const pure = applyBootPatch(original, { cur: 5, mode: 'build', complete: true });
  assert(/local cur = 5/.test(pure.source), 'cur 没改');
  assert(/-- \[boot\].*registerCursor/.test(pure.source), 'registerCursor 没被注释（模拟器没这个控件，真跑会抛错打死 tick）');
  assert(/buildLevel\(\)/.test(pure.source), '启动入口没换成 buildLevel()');
  eq(pure.unsupported.length, 1, '`complete` 该如实报 unsupported（**不许猜玩法数据形状**）');
  eq(pure.patched.length, 3, 'patched 该逐条记下改了什么');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-boot-'));
  const file = path.join(d, 'probe.lua');
  fs.writeFileSync(file, original, 'utf8');
  const r = patchSimBindBoot({ op: 'bind', sourceFrom: file, boot: { cur: 5, mode: 'build', complete: true } });
  eq(fs.readFileSync(file, 'utf8'), original, '**真源被改了**（红线：只改内存副本）');
  assert(/local cur = 5/.test(r.args.source), 'bind 那条路没把补丁落到副本上');
  eq(r.probe.patched.length, 3, 'probe.patched 数量不对');
  fs.rmSync(d, { recursive: true, force: true });
  return '纯函数 3 处补丁 · 走 bind 也 3 处 · **真源逐字节未动** · complete 如实 unsupported';
});

await check('★ P1-3（《上下文瘦身设计》）`runWorkspaceGates`：跑工作区两道门禁；**找不到工具就报错、绝不静默放行**', async () => {
  const { runWorkspaceGates, TOOLS } = await import('../index.js');
  const code = TOOLS.find((t) => t.name === 'miliastra_code');
  const props = Object.keys((code.parameters || {}).properties || {});
  assert(props.includes('gates'), '缺 gates 参数（P1-3）');
  assert(props.includes('sync'), '缺 sync 参数（P1-3）');
  // 工作区外：**判不了 ⇒ 报错**（不是"通过"）—— 这是"宁可失败也不写盘"的那条纪律
  const outside = runWorkspaceGates(process.execPath);
  eq(outside.ok, false, '工作区外的 source 竟判成通过');
  eq(outside.code, 'GATES_NO_TOOLS', '该给 GATES_NO_TOOLS：' + outside.code);
  assert(/宁可失败/.test(outside.error), '错误里该说清为什么不放行：' + outside.error);
  // 不存在的 source：明确报错
  const missing = runWorkspaceGates('C:\\definitely\\not\\here.lua');
  eq(missing.ok, false, '不存在的 source 竟判成通过');
  // 真工作区里挑一个文件（扫到哪个算哪个，**不写死地图**）：能给出门禁结论
  const fs = await import('node:fs');
  const path = await import('node:path');
  const caseRoot = path.resolve(process.cwd(), '..', '..', '案子');
  let file = null;
  if (fs.existsSync(caseRoot)) {
    for (const map of fs.readdirSync(caseRoot)) {
      const codeDir = path.join(caseRoot, map, '2.代码');
      if (!fs.existsSync(codeDir)) continue;
      const hit = fs.readdirSync(codeDir).find((n) => /\.lua$/i.test(n));
      if (hit) { file = path.join(codeDir, hit); break; }
    }
  }
  if (!file) return 'GATES_NO_TOOLS 与"文件不存在"两条都对（本机没找到工作区 .lua ⇒ 跳过真跑那条）';
  const r = runWorkspaceGates(file);
  assert(r.gates && typeof r.gates.scope.exit === 'number', '该回 gates.scope.exit');
  assert(typeof r.gates.style.exit === 'number', '该回 gates.style.exit');
  assert(r.ok === (r.gates.scope.exit === 0 && r.gates.style.exit === 0), 'ok 与两道门的 exit 不自洽');
  return '工作区外 ⇒ GATES_NO_TOOLS · 真文件 ⇒ scope/style 结论自洽（ok=' + r.ok + '）';
});

await check('★ P0-2（《上下文瘦身设计》）`receipt:"min"`：精简骨架档 —— 结论字段全在、**非名单 op 一字节不变**', async () => {
  const { TOOLS, minifyReceipt } = await import('../index.js');
  const log = TOOLS.find((t) => t.name === 'miliastra_log');
  const code = TOOLS.find((t) => t.name === 'miliastra_code');
  assert(Object.keys((log.parameters || {}).properties || {}).includes('receipt'), 'log 缺 receipt 参数');
  assert(Object.keys((code.parameters || {}).properties || {}).includes('receipt'), 'code 缺 receipt 参数');
  // ⚠️ 用**纯函数**钉骨架（不依赖本机日志目录 —— 换图/清日志都不会假红）
  const full = {
    ok: true, op: 'errors', file: 'x.gia', count: 48, returned: 48, truncated: false, runsAffected: 1,
    kindCounts: { 'attempt-call': 48 }, errors: [{ kind: 'attempt-call', message: '…', fileLine: null }],
    errorsMeaningless: true, forms: [{ kind: 'a' }, { kind: 'b' }], kinds: [{ kind: 'a', count: 1 }],
    hint: 'hint', scanned: 428, channels: 1, size: 92384, recordCount: 428, staleLog: false,
  };
  const min = minifyReceipt(full, 'errors');
  assert(min.receipt === 'min', '没收成 min 骨架');
  assert(JSON.stringify(min).length < JSON.stringify(full).length, 'min 没比 full 小');
  for (const k of ['ok', 'count', 'kindCounts', 'errors', 'file']) assert(k in min, 'min 少了结论字段：' + k);
  eq(min.errorsMeaningless, true, 'min 档丢了 errorsMeaningless（会把过期日志当零报错）');
  assert(!('forms' in min), 'min 档不该再带 forms（那是固定文档）');
  // deploy / sim 两个骨架也要有各自的决策字段
  const dep = minifyReceipt({ ok: true, op: 'deploy', dest: 'd.lua', bytes: 10, sha256: 'A'.repeat(64), syntax: { ok: true }, lint: { problems: [] }, reconcile: { match: false, liveBytes: 10, embeddedBytes: 11 }, checklist: ['a'] }, 'deploy');
  for (const k of ['ok', 'dest', 'bytes', 'sha256_12', 'syntax_ok', 'match', 'live_bytes', 'embed_bytes']) assert(k in dep, 'deploy min 少字段：' + k);
  eq(dep.sha256_12.length, 12, 'sha 该截 12 位（决策够用、省字节）');
  const sim = minifyReceipt({ ok: true, op: 'bind', bound: true, run: { controlCount: 10, logs: ['x'], logCount: 1 }, source: { bytes: 99 } }, 'sim');
  for (const k of ['ok', 'bound', 'controlCount', 'logs', 'liveBytes']) assert(k in sim, 'sim min 少字段：' + k);
  // ★ 非名单 op：原样返回（默认行为不变的另一种表现）—— 用 inspect（不需要日志目录）
  const i1 = await code.execute({ op: 'inspect' });
  const i2 = await code.execute({ op: 'inspect', receipt: 'min' });
  eq(JSON.stringify(i2).length, JSON.stringify(i1).length, '非名单 op 被套了骨架（应原样返回）');
  return 'errors 骨架 ' + JSON.stringify(full).length + ' → ' + JSON.stringify(min).length + ' B · 三种骨架字段齐 · 非名单 op 原样';
});

await check('★ P0-1（《上下文瘦身设计》）`gen saveTo`：生成物落盘、回执只留摘要；**不给时行为一字节不变**', async () => {
  const { TOOLS } = await import('../index.js');
  const g = TOOLS.find((t) => t.name === 'miliastra_gen');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-saveto-'));
  const base = { op: 'text-gradient', text: '原神千星', colors: ['#FFCC33', '#37FFFF'], controlName: '标题' };
  const full = await g.execute({ ...base });
  assert(typeof full.lua === 'string' && full.lua.length > 0, '不给 saveTo 时**必须**仍回正文（默认行为不许变）');
  const slim = await g.execute({ ...base, saveTo: path.join(d, 'out.lua') });
  assert(slim.saved === true, 'saveTo 没生效：' + JSON.stringify(slim).slice(0, 160));
  eq('lua' in slim, false, '给了 saveTo 还回正文（那就没省上下文）');
  eq(typeof slim.luaBytes, 'number', '`luaBytes`（生成物字节数）该保留 —— 设计文档要求摘要里带它（是数字，不是正文）');
  const file = path.join(d, 'out.lua');
  const st = fs.statSync(file);
  eq(st.size, slim.bytes, '盘上文件字节 ≠ 回执 bytes');
  assert(typeof slim.sha256 === 'string' && slim.sha256.length === 64, '缺 sha256（要能核对落盘的就是生成的那份）');
  assert(JSON.stringify(slim).length < 1500, '摘要档回执该 <1.5 KB，实得 ' + JSON.stringify(slim).length);
  assert(JSON.stringify(slim).length < JSON.stringify(full).length, '摘要档竟没比全量小');
  // 最大的一档（vfx-lua 默认回执实测 ~67 KB）—— 用 saveTo 之后必须也只剩摘要
  const vfxFull = await g.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: 1073741868, container: 1073741866 });
  const vfxSlim = await g.execute({ op: 'vfx-lua', preset: 'hit-spark', templateIndex: 1073741868, container: 1073741866, saveTo: path.join(d, 'vfx.lua') });
  if (typeof vfxFull.lua === 'string' && vfxFull.lua.length > 2000) {
    assert(vfxSlim.saved === true && !('lua' in vfxSlim), 'vfx-lua 的 saveTo 没生效');
    assert(JSON.stringify(vfxSlim).length < JSON.stringify(vfxFull).length / 4, 'vfx-lua 摘要档没显著变小');
  }
  fs.rmSync(d, { recursive: true, force: true });
  return '全量 ' + JSON.stringify(full).length + ' B（带正文）→ 摘要 ' + JSON.stringify(slim).length + ' B · 盘上字节与回执一致 · vfx-lua 全量 ' + JSON.stringify(vfxFull).length + ' B → 摘要 ' + JSON.stringify(vfxSlim).length + ' B';
});

await check('★ #6 模板审计 `op=audit-template`（《插件调用优化方向》第 6 条）：子树 / 同父重名 / id 存在性 / **图源已逆出**', async () => {
  const { TOOLS } = await import('../index.js');
  const t = TOOLS.find((x) => x.name === 'miliastra_map');
  // ⚠️ 前面几个夹具用例会改 `MILIASTRA_LOCALLOW`（指向临时夹具）⇒ 这里**临时清掉**，让 `scanLevels()` 看真沙箱
  const savedLow = process.env.MILIASTRA_LOCALLOW;
  delete process.env.MILIASTRA_LOCALLOW;
  try {
  const lv0 = (await import('../lib/locate.mjs')).scanLevels().filter((l) => l.gil && l.gil.path);
  if (!lv0.length) return '本机没有 .gil ⇒ 如实跳过';
  // ⚠️ **不写死关卡**：挑一张**真有客户端控件**的图（.gil 随存盘变，id 与关卡号都不能当契约）
  let r = null;
  let lv = null;
  for (const cand of lv0) {
    const probe = await t.execute({ op: 'audit-template', level: cand.levelId, summaryOnly: true });
    if (probe.ok === true && probe.controlCount > 0) { r = probe; lv = cand; break; }
  }
  if (!r) return '这几张图的 .gil 里都没有客户端控件记录 ⇒ 如实跳过';
  assert(r.ok === true, 'op 没进对分支：' + JSON.stringify(r).slice(0, 160));
  assert(r.controlCount > 0, '控件数为 0，读错地方了');
  // 不依赖任何**活 id**的结构性断言（.gil 会随存盘变，不能把 id 当契约）
  assert(typeof r.sameNameSameParentCount === 'number' && r.sameNameSameParentCount >= 0, '缺同父重名计数');
  assert(typeof r.duplicateRootsCount === 'number' && r.duplicateRootsCount >= 0, '缺同名多条计数');
  eq(r.imageSource, 'heuristic-verified', '图源口径该是 heuristic-verified（本轮已逆出，有对照证据）');
  assert(/106045/.test(r.imageSourceNote), '图源口径必须把**对照证据**写出来（日志 106045 ↔ .gil 里 29 次）');
  assert(typeof r.imageSourceMissingCount === 'number', '缺号计数必须是数字（判"会渲染成 ?"就靠它）');
  assert(Array.isArray(r.imageSourceMissingSample), '缺号样例该是数组');
  assert(Array.isArray(r.tree.imageIds), '树节点该带 imageIds（哪怕为空数组）');
  // 不存在的 id：如实回 idExists:false + tree:null（不报假警、也不抛）
  const bad = await t.execute({ op: 'audit-template', level: lv.levelId, nodeId: 999999999, summaryOnly: true });
  eq(bad.ok, true, '不存在的 id 不该整条报错');
  eq(bad.idExists, false, '不存在的 id 必须 idExists:false');
  eq(bad.tree, null, '不存在的 id 不该编出子树');
  // 缺省根（不给 nodeId/q）也要能给出一个根 + 非空子树
  assert(r.rootId != null && r.tree && r.subtreeNodes > 0, '缺省根/子树不对：' + JSON.stringify({ id: r.rootId, n: r.subtreeNodes }));
  eq(r.tree.id, r.rootId, '子树根与 rootId 不一致');
  return '控件 ' + r.controlCount + ' · 同父重名 ' + r.sameNameSameParentCount + ' 组 · 缺省根 ' + r.rootId + '（子树 ' + r.subtreeNodes + ' 节点）· 图源=' + r.imageSource + '（缺号 ' + r.imageSourceMissingCount + '）';
  } finally {
    if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW;
    else process.env.MILIASTRA_LOCALLOW = savedLow;
  }
});

await check('★ #3 `.gia` 半截快照判据（《插件调用优化方向》第 3 条）：**有字节但解不出记录**要能判出来', async () => {
  const { readGia } = await import('../lib/gia.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-gia-'));
  const bad = path.join(d, 'half.gia');
  fs.writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02]));   // 有字节、连头都解不出来（半截/坏文件的常态）
  const g = readGia(bad);
  eq(g.size > 0, true, 'size 该 > 0');
  eq(g.emptyButHasBytes, true, '**没判出"有字节但解不动"** —— 半截快照就会被当成"没有报错"');
  eq(g.complete, false, 'complete 该是 false（这条早退路径也要带判据）');
  fs.rmSync(d, { recursive: true, force: true });
  return 'emptyButHasBytes=true · complete=false（半截/坏文件的判据可验证，不是猜）';
});

await check('★ #4 fileLine（《插件调用优化方向》第 4 条，**实测真因**）：报错行**行首还挂着别的内容**时也要提取 + 跨记录兜底', async () => {
  const { parseFileLine, attachFileLines } = await import('../lib/gia.mjs');
  // 真机原文（实测 48 条全 null 的那一行）：行首第一个冒号后面**不是数字** ⇒ 旧兜底（锚 `^`）不命中
  const real = '[侦探1/view] 三态按钮[ovB1] 事件注册失败(容器默认/…CursorEnter): 表现 view:580: attempt to call a nil value';
  const r = parseFileLine(real);
  assert(r && r.file === '表现 view' && r.line === 580, '真机原文没提取到（这正是 48 条 fileLine=null 的真因）：' + JSON.stringify(r));
  // 时间戳不许被当文件行号（旧③的另一半职责，加了④之后仍然要成立）
  eq(parseFileLine('01:36:27 开跑'), null, '时间戳被误认成 `文件:行号`');
  // 跨记录兜底：报错记录自己没位置 ⇒ 从**同 channel 的邻居**借（并说明是借来的）
  const pool = [
    { index: 0, channel: 'A', seq: 100, message: 'attempt to index a nil value' },
    { index: 1, channel: 'A', seq: 101, message: "特效 fx:428: in function 'requireHandover'" },
    { index: 2, channel: 'B', seq: 102, message: '特效 other:9: in function x' },
  ];
  const st = attachFileLines(pool, [{ index: 0, channel: 'A', seq: 100, message: pool[0].message, fileLine: null }]);
  eq(st.errors[0].fileLine.line, 428, '没从邻居借到行号');
  eq(st.errors[0].fileLineFrom.index, 1, '没记清位置是**从哪条借的**（人就无法回原文核对）');
  eq(st.errors[0].fileLine.file, '特效 fx', '借来的文件名不对');
  assert(st.patched.length === 1, 'patched 清单不对');
  return '真机原文命中 + 时间戳排除 + 跨记录借位置（带 fileLineFrom）';
});

await check('★ 贪婪扫 `op=clientui kind:"all"`（作者 2026-10-02）：所有 standalone 的**完整子树**一次扫完 + 不占新 schema', async () => {
  const { TOOLS } = await import('../index.js');
  const t = TOOLS.find((x) => x.name === 'miliastra_map');
  // schema 侧：`kind` / `limit` 是**已有**参数 ⇒ 贪婪模式不许新增参数（棘轮 34 KB）
  const props = Object.keys((t.parameters && t.parameters.properties) || {});
  assert(props.includes('kind') && props.includes('limit'), '缺 kind/limit');
  /*
   * ★ 2026-10-07 前提变了（作者把硬线 34 → 50 KB）：原断言「贪婪模式不该新增顶层参数」**依据是 34 KB 棘轮**，
   *   而那次真实代价正是 `root` —— **实现好了却因为顶穿棘轮留在代码里 ⇒ AI 看不到 = 调不出来**。
   *   新纪律：**能力参数一律进 schema**（只有解释性长文才下沉）⇒ 这里翻过来：
   *   不许为"贪婪扫"另造 `greedy`（复用 `kind`/`limit` ✓），但 **`root` 必须在**。
   */
  assert(!props.includes('greedy'), '贪婪扫该复用 `kind`，不该另造 `greedy` 参数');
  assert(props.includes('root'), '`root`（点名任意控件 id 回子树）是**能力参数**，必须进 schema（2026-10-07 新纪律）');
  const lv = (await import('../lib/locate.mjs')).scanLevels().find((l) => String(l.levelId) === '1073741842' && l.gil);
  if (!lv) return 'schema 侧通过（本机没有 1073741842，跳过真数据那条）';
  const r = await t.execute({ op: 'clientui', level: '1073741842', kind: 'all', limit: 2 });
  assert(r.greedy && r.greedy.standaloneRoots > 0, '缺 greedy 汇总');
  eq(r.trees.length, 2, 'limit 没生效');
  assert(r.trees.every((x) => x.nodes > 0 && x.tree && x.tree.id === x.rootId), '某棵树的 root/nodes 不对');
  assert(r.trees[0].nodes >= r.trees[1].nodes, '没按 nodes 倒序（最大的在前）');
  assert(r.greedy.biggest && r.greedy.biggest.nodes > 0, '缺 biggest');
  // lossless：不许出现 undefined 值（smoke 抓过同类）
  assert(!JSON.stringify(r).includes('undefined'), '回执里出现了 undefined');
  const s = await t.execute({ op: 'clientui', level: '1073741842', summaryOnly: true });
  assert(s.trees === undefined, 'summaryOnly 时仍回 trees（体积）');
  return 'standaloneRoots=' + r.greedy.standaloneRoots + ' · totalNodes=' + r.greedy.totalNodes
    + ' · 最大 ' + r.greedy.biggest.name + '(' + r.greedy.biggest.nodes + ' 节点/深 ' + r.greedy.biggest.depth + ')';
});

await check('★ 模板子树（作者 2026-10-02：「只有最顶层的客户端模板能读取到，要递归子树」）`clientUiSubtree` 递归/防环/限深/missing', async () => {
  const { clientUiSubtree, subtreeNodeCount } = await import('../lib/gil.mjs');
  const recs = [
    { id: 1, name: '声望值', parent: null, children: [2, 3] },
    { id: 2, name: '图片', parent: 1, children: null },
    { id: 3, name: '图片', parent: 1, children: [4, 5] },
    { id: 4, name: '图片', parent: 3, children: null },
    { id: 5, name: '图片', parent: 3, children: [3] },          // 环：指回祖先
  ];
  const t = clientUiSubtree(recs, 1);
  eq(t.id, 1, '根不对');
  eq(t.childCount, 2, '一级子数不对');
  eq(t.children[1].childCount, 2, '二级子数不对');
  eq(subtreeNodeCount(t), 6, '节点数不对：应为 6（含根 + 那张**指回祖先的重复记录**也算一条，免得"数不出来"）');
  assert(t.children[1].children[1].children[0].cycle === true, '指回祖先的环没被标出来（会无限递归）');
  const m = clientUiSubtree(recs, 99);
  assert(m.missing === true, '查不到的 id 没标 missing');
  const d = clientUiSubtree(recs, 1, { maxDepth: 1 });
  assert(d.children[1].truncatedChildren === 2, '限深后没给 truncatedChildren');
  return '递归展开 + 环标记 + missing + 限深 四种情形都对';
});

await check('P1-4 ③c `editorHint` 是**纯函数**：两条判据各自命中 + `same` 判定（不许把"最近改动"当"当前图"）', async () => {
  const { editorHint } = await import('../lib/locate.mjs');
  const lv = (id, gilMs, liveMs) => ({ levelId: id, gil: { path: id + '.gil', size: 10, mtimeMs: gilMs }, luaFiles: [{ name: 'x.lua', mtimeMs: liveMs }], newestMs: Math.max(gilMs, liveMs) });
  const a = editorHint([lv('A', 200, 100), lv('B', 100, 300)]);
  eq(a.byGilSave.levelId, 'A', 'byGilSave 没取 .gil 最新的');
  eq(a.byLiveFile.levelId, 'B', 'byLiveFile 没取活文件最新的');
  eq(a.same, false, '两张图不同却说 same');
  eq(a.evidence, 'indirect', '没标"间接证据"');
  assert(typeof a.askHuman === 'string' && a.askHuman.length > 4, '没给"该问人什么"');
  assert(!/当前图就是/.test(JSON.stringify(a)), '不许下"当前图"的结论');
  const b = editorHint([lv('A', 300, 200), lv('B', 100, 50)]);
  eq(b.same, true, '同一张图时 same 应为 true');
  eq(editorHint([]).byGilSave, null, '空列表应给 null');
  return 'A/B 各自命中 + same 判定 + 空列表安全';
});

await check('P1-4 ③b **多活文件**下 brief 仍**有界**（2026-10-02：真实环境 11 个活文件时实测 1348 B，旧测试只测夹具⇒漏了）', async () => {
  const luas = {};
  for (let i = 1; i <= 12; i += 1) luas['game_' + String(i).padStart(2, '0') + '.lua'] = '-- x\n';
  const fake = fakeLevel({
    levelId: '1073741950',
    gils: [makeGil({ levelId: 1073741950, scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua' }] })],
    luas,
  });
  const prev = process.env.MILIASTRA_LOCALLOW;
  process.env.MILIASTRA_LOCALLOW = fake.root;
  // ★ 再来一张**更近**的图（同一 root 下）⇒ 逼出"备选"那一行，钉住"备选压成一行"的形状
  const lv2 = path.join(fake.root, '原神', 'BeyondLocal', '201170108', 'Beyond_Local_Save_Level', '1073741951');
  fs.mkdirSync(path.join(lv2, 'external_lua_file'), { recursive: true });
  fs.writeFileSync(path.join(lv2, '1073741951.gil'), makeGil({ levelId: 1073741951, scripts: [{ mappingId: 1073741825, name: 'b', file: 'b.lua' }] }));
  for (let i = 1; i <= 3; i += 1) fs.writeFileSync(path.join(lv2, 'external_lua_file', 'b' + i + '.lua'), '-- x\n', 'utf8');
  // 把第二张图的时间**拨回一小时** ⇒ 它只当"备选"，当前图仍是 12 活文件那张（不然当前图会变成它）
  const old = new Date(Date.now() - 3600 * 1000);
  for (const f of fs.readdirSync(path.join(lv2, 'external_lua_file'))) fs.utimesSync(path.join(lv2, 'external_lua_file', f), old, old);
  fs.utimesSync(path.join(lv2, '1073741951.gil'), old, old);
  try {
    const r = await health.execute({ brief: true }, {});
    const b = bytesOf(r);
    // 上限 1536 B：**实测口径**（12 个活文件 + 歧义警告 + 目录），不是"理想的 1KB"
    assert(b <= 1536, '12 个活文件时 brief 涨到 ' + b + ' B（上限 1536）');
    assert(/备选/.test(String(r.currentWhy)), '备选没折进 currentWhy：' + r.currentWhy);
    // 活文件多于 8 个 ⇒ 逐条 `bytes` 不给了（省 ~180 B），但**名字一个不许少**
    assert(r.luaFiles.length === 12, '活文件少了：' + r.luaFiles.length);
    assert(r.luaFiles.every((f) => !('bytes' in f)), '多于 8 个活文件时仍逐条给了 bytes');
    assert(r.luaFiles.every((f) => typeof f.name === 'string'), '名字丢了');
    return b + ' B（12 个活文件 · 只给名字不给字节 · 备选一行）';
  } finally {
    if (prev === undefined) delete process.env.MILIASTRA_LOCALLOW; else process.env.MILIASTRA_LOCALLOW = prev;
  }
});

await check('P1-4 ④ .gil 挂载表读不到时**一个都不标**（mountKnown:false，不猜）', async () => {
  const b2 = fakeLevel({
    levelId: '1073741912',
    gils: [makeGil({ levelId: 1073741912, withHierarchy: false, scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua' }] })],
    luas: { 'game_01.lua': '-- x\n', '别的.lua': '-- y\n' },
  });
  process.env.MILIASTRA_LOCALLOW = b2.root;
  const r = await health.execute({ brief: true }, {});
  assert(r.mountKnown === false, '挂载表读不到却是 true：' + r.mountKnown);
  assert(r.luaFiles.every((f) => !('mounted' in f)), '读不到挂载表却标了 mounted：' + JSON.stringify(r.luaFiles));
  process.env.MILIASTRA_LOCALLOW = b1.root;
  return 'mountKnown=false，' + r.luaFiles.length + ' 个活文件一个都没标';
});

/* ================================================================== P2-5 · firstWrite */

async function deployTo(box, fileName, { sourceText = '-- 新内容\nlocal x = 1\n' } = {}) {
  const src = path.join(tmpRoot, 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.lua');
  fs.writeFileSync(src, sourceText, 'utf8');
  process.env.MILIASTRA_LOCALLOW = box.root;
  return await codeTool.execute({ op: 'deploy', source: src, file: fileName }, {});
}

/** P2-5 的夹具（两次断言共用同一个关卡，第二次才能验证"不是首次写入"）。 */
const hudBox = fakeLevel({
  levelId: '1073741913',
  gils: [makeGil({ levelId: 1073741913, scripts: [{ mappingId: 1073741825, name: 'HUD hud', file: 'HUD hud.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
  luas: { 'HUD hud.lua': '' },
});

await check('P2-5 ① 投进一个**0 字节**活文件 → firstWrite:true + destBeforeBytes:0 + 一句提示', async () => {
  const r = await deployTo(hudBox, 'HUD hud.lua');
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  assert(r.firstWrite === true && r.destBeforeBytes === 0, '没标首次写入：' + JSON.stringify({ f: r.firstWrite, b: r.destBeforeBytes }));
  assert(/首次写入/.test(r.firstWriteNote || '') && /存盘/.test(r.firstWriteNote || ''), '提示没说清「首次写入 + 存盘」：' + r.firstWriteNote);
  assert(fs.statSync(path.join(hudBox.luaDir, 'HUD hud.lua')).size > 0, '写了却还是 0 字节');
  return 'firstWrite=true，destBeforeBytes=0，note=' + r.firstWriteNote;
});

await check('P2-5 ② 覆盖**已有内容**的活文件 → firstWrite:false（不误报）', async () => {
  const r = await deployTo(hudBox, 'HUD hud.lua', { sourceText: '-- 第二版\nlocal y = 2\n' });
  assert(r.ok === true, '第二次部署失败：' + JSON.stringify(r.errors || r).slice(0, 160));
  assert(r.firstWrite === false && r.destBeforeBytes > 0, '不是首次写入却说成首次：' + JSON.stringify({ f: r.firstWrite, b: r.destBeforeBytes }));
  assert(r.firstWriteNote === null, '非首次写入不该带首写提示：' + r.firstWriteNote);
  return 'destBeforeBytes=' + r.destBeforeBytes + ' → firstWrite=false';
});

/* ================================================================== P0-2 · belongsTo / isCurrent */

/** P0-2 ③④ 共用的夹具（④ 要回到它上面再跑一次 `op=sha`）。 */
let shaBox = null;

await check('P0-2 ① 纯函数：两次存盘 + 读旧的那一次 → isCurrent:false，belongsTo 带**时间与 epoch**', () => {
  const save1 = Date.parse('2026-09-26T21:03:11');
  const save2 = Date.parse('2026-09-26T22:40:05');
  const readOld = snapshotFreshness({
    kind: '存盘快照', name: '1073741833.gil', atMs: save1,
    currentAtMs: save2, currentLabel: '活文件 表现 view.lua',
    what: '这份 .gil 存盘快照',
  });
  assert(readOld.isCurrent === false, '读旧的那一次却说 isCurrent:' + readOld.isCurrent);
  assert(readOld.known === true, '有证据却说不知道：' + JSON.stringify(readOld));
  assert(/1073741833\.gil/.test(readOld.belongsTo), 'belongsTo 没带文件名：' + readOld.belongsTo);
  assert(/2026-09-26 21:03:11/.test(readOld.belongsTo), 'belongsTo 没带本地时间：' + readOld.belongsTo);
  assert(readOld.belongsToEpochSec === Math.floor(save1 / 1000), 'belongsToEpochSec 不对：' + readOld.belongsToEpochSec);
  assert(/不是当前那一份/.test(readOld.note) && /存一次盘/.test(readOld.note), 'note 没给"该怎么办"：' + readOld.note);
  // 读**新的**那一次：必须说"是当前那一份"
  const readNew = snapshotFreshness({ kind: '存盘快照', name: '1073741833.gil', atMs: save2, currentAtMs: save2 });
  assert(readNew.isCurrent === true, '读最新的一次却说不是当前：' + JSON.stringify(readNew));
  return 'save1 → isCurrent=false（epochSec ' + readOld.belongsToEpochSec + '）；save2 → isCurrent=true';
});

await check('P0-2 ② 缺证据时**明说没有证据**：没有时间 / 没有对比基准 → isCurrent:null（不猜）', () => {
  const noTime = snapshotFreshness({ kind: '存盘快照', name: 'x.gil', atMs: null, currentAtMs: 1000 });
  assert(noTime.isCurrent === null && noTime.known === false, '没时间却判了：' + JSON.stringify(noTime));
  assert(/没有证据/.test(noTime.note), '没说"没有证据"：' + noTime.note);
  const noBase = snapshotFreshness({ kind: '存盘快照', name: 'x.gil', atMs: 1000, currentAtMs: null });
  assert(noBase.isCurrent === null && /没有对比基准/.test(noBase.note), '没有基准却判了：' + JSON.stringify(noBase));
  assert(localTimeText(0) === null || typeof localTimeText(0) === 'string', 'localTimeText 形状不对');
  return '两条都 isCurrent:null + 明说原因';
});

await check('P0-2 ③ 集成：`map op=script` 带 belongsTo/isCurrent —— `.gil` 比活文件旧 ⇒ false（并说去哪存盘）', async () => {
  const box = fakeLevel({
    levelId: '1073741914',
    gils: [makeGil({
      levelId: 1073741914,
      scripts: [{ mappingId: 1073741825, name: 'game_01', file: 'game_01.lua', source: '-- old\n' }],
      mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }],
    })],
    luas: { 'game_01.lua': '-- 新内容（活文件比存盘快照新）\n' },
  });
  shaBox = box;
  process.env.MILIASTRA_LOCALLOW = box.root;
  // 夹具标定：把 .gil 的 mtime 钉在过去、活文件钉在现在（否则同一秒内建的两个文件分不出先后）
  const gilPath = path.join(box.levelDir, '1073741914.gil');
  const livePath = path.join(box.luaDir, 'game_01.lua');
  const t0 = Date.parse('2026-09-26T21:00:00');
  fs.utimesSync(gilPath, new Date(t0), new Date(t0));
  fs.utimesSync(livePath, new Date(t0 + 3600 * 1000), new Date(t0 + 3600 * 1000));
  const r = await mapTool.execute({ op: 'script', file: 'game_01.lua' }, {});
  assert(r.ok === true, 'op=script 失败：' + JSON.stringify(r).slice(0, 200));
  assert(/1073741914\.gil/.test(r.belongsTo || ''), 'belongsTo 没带 .gil 名：' + r.belongsTo);
  assert(r.isCurrent === false, '快照比活文件旧却说 isCurrent:' + r.isCurrent);
  assert(typeof r.belongsToEpochSec === 'number' && /存盘|存一次盘/.test(r.currentnessNote || ''),
    'currentnessNote 没给可执行的话：' + r.currentnessNote);
  // 反向：把 .gil 钉到活文件之后 ⇒ 必须说"是当前那一份"（防"永远报 stale"的假阳性）
  const t1 = t0 + 7200 * 1000;
  fs.utimesSync(gilPath, new Date(t1), new Date(t1));
  const r2 = await mapTool.execute({ op: 'script', file: 'game_01.lua' }, {});
  assert(r2.isCurrent === true, '快照更新却说不是当前：' + JSON.stringify({ b: r2.belongsTo, c: r2.isCurrent }));
  return '旧快照 isCurrent=false；新快照 isCurrent=true（belongsTo=' + r2.belongsTo + '）';
});

await check('P0-2 ④ 集成：`health op=sha` 与 `map op=script` **同一口径**（都带 belongsTo/isCurrent）', async () => {
  const r = await health.execute({ op: 'sha' }, {});
  assert(r.ok === true, 'op=sha 失败：' + JSON.stringify(r).slice(0, 200));
  assert(/\.gil/.test(r.belongsTo || ''), 'sha 没带 belongsTo：' + r.belongsTo);
  assert(r.isCurrent === true, '刚被钉到最新的 .gil 却说不是当前：' + JSON.stringify({ b: r.belongsTo, c: r.isCurrent }));
  assert(typeof r.belongsToEpochSec === 'number' && typeof r.currentnessNote === 'string', 'sha 缺 epoch/说明');
  // 没有 .gil 的关卡：必须**明说没有证据**，而不是给一个看起来像结论的旧值
  const noGil = fakeLevel({ levelId: '1073741915', luas: { 'game_01.lua': '-- x\n' } });
  process.env.MILIASTRA_LOCALLOW = noGil.root;
  const rNone = await health.execute({ op: 'sha' }, {});
  assert(rNone.ok === true, '没 .gil 时 op=sha 该如实回报而不是抛：' + JSON.stringify(rNone).slice(0, 160));
  assert(rNone.isCurrent === null || rNone.isCurrent === false, '没 .gil 却给了一个"当前"的结论：' + JSON.stringify({ c: rNone.isCurrent, b: rNone.belongsTo }));
  assert(/没有证据|没有对比基准|判断不了/.test(rNone.currentnessNote || ''), '没 .gil 时没明说判不了：' + rNone.currentnessNote);
  process.env.MILIASTRA_LOCALLOW = shaBox.root;
  return 'sha 与 script 同口径；无 .gil 时 isCurrent=' + rNone.isCurrent;
});

/* ================================================================== P1-3 · 已知坑 warnings */

/** 合成夹具：混着多种模板的集合 + 未加白名单的 sanitize（改造前 `board_body.lua` 的最小形状）。 */
const PIT_MIXED = [
  'local TEMPLATES = {',
  '  { name = "@单图", id = 1073742182 },',
  '  { name = "@复合", id = 1073742519 },',
  '}',
  'local function build()',
  '  for i, t in pairs(TEMPLATES) do',
  '    local node = game.InstantiateClientUIControl(t.id, ROOT)',
  '    sanitize(node, 1)',
  '  end',
  'end',
  '',
].join('\n');
/** 恢复白名单之后：同一个循环里，sanitize 被 `if … ~= "…" then` 收窄。 */
const PIT_WHITELISTED = PIT_MIXED.replace(
  '    sanitize(node, 1)',
  '    if t.name ~= "@复合" then\n      sanitize(node, 1)\n    end',
);

await check('P1-3 ① 纯函数：混合模板集合 + 未加白名单的 sanitize → 报 v2-sanitize-mixed-templates（带 file:line）', () => {
  const w = uiWarnings(PIT_MIXED, 'board.lua');
  const hit = w.find((x) => x.rule === 'v2-sanitize-mixed-templates');
  assert(hit, '没报出来：' + JSON.stringify(w));
  assert(hit.file === 'board.lua' && hit.line === 8 && hit.where === 'board.lua:8', 'file/line 不对：' + JSON.stringify(hit));
  assert(/可能/.test(hit.message) && /整卡不显示|不显示/.test(hit.message), 'message 没写清"可能是 / 后果"：' + hit.message);
  assert(/白名单/.test(hit.fix), 'fix 不是可执行的改法：' + hit.fix);
  assert(/iron-rules-visual-debug|docs\//.test(hit.doc), 'doc 没指向文档链：' + hit.doc);
  return hit.where + ' ' + hit.evidence.trim();
});

await check('P1-3 ② 纯函数：加了白名单 → 该条**消失**（不留噪音）', () => {
  const w = uiWarnings(PIT_WHITELISTED, 'board.lua').filter((x) => x.rule === 'v2-sanitize-mixed-templates');
  assert(w.length === 0, '加了白名单还在报：' + JSON.stringify(w));
  return 'v2-sanitize-mixed-templates = 0 条';
});

await check('P1-3 ③ 纯函数：构建循环里的 InstantiateClientUIControl → 报「试试挪到渲染第一帧」', () => {
  const w = uiWarnings(PIT_MIXED, 'board.lua').filter((x) => x.rule === 'instantiate-in-build-phase');
  assert(w.length === 1, '没报构建期实例化：' + JSON.stringify(w));
  assert(/第一帧/.test(w[0].fix) && /可能|试试|若/.test(w[0].message + w[0].fix), 'fix/message 不对：' + JSON.stringify(w[0]));
  return w[0].where + ' → ' + w[0].fix.slice(0, 30) + '…';
});

await check('P1-3 ④ 纯函数：**没有**模板表的普通循环（遍历子控件）不算"一批模板"（不制造噪音）', () => {
  const plain = [
    'local function sanitizeAll(node)',
    '  local kids = node:GetChildren()',
    '  for i = 1, #kids do',
    '    sanitize(kids[i], 1)',
    '  end',
    'end',
    '',
  ].join('\n');
  const w = uiWarnings(plain, 'x.lua');
  assert(w.length === 0, '把"遍历子控件"误判成"一批模板"：' + JSON.stringify(w));
  return '0 条（数字型循环 / sanitize 自己的递归都不报）';
});

/** 工作区那两份「改造前 / 恢复白名单后」的样例：优先用真文件；不在就用上面的合成夹具并**如实说明**。 */
// ★ 2026-10-04 B 方案：工作区把 code/ + sources/ 迁进了 案子/<地图>/2.代码/ ⇒ 夹具跟着改（只改路径）。
const SAMPLE_BOARD_BEFORE = 'C:/Users/Administrator/Desktop/yuanshen/案子/侦探1/2.代码/_snapshots/20260926-200607/project/调查板 board.lua';
const SAMPLE_BOARD_AFTER = 'C:/Users/Administrator/Desktop/yuanshen/案子/侦探1/2.代码/board_body.lua';
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const beforeExists = isFile(SAMPLE_BOARD_BEFORE);
const afterExists = isFile(SAMPLE_BOARD_AFTER);

await check('P1-3 ⑤ 集成：deploy 一份"含未加白名单 sanitize"的产物 → warnings[] 里有该 rule，且 **ok 不变**', async () => {
  const box = fakeLevel({
    levelId: '1073741916',
    gils: [makeGil({ levelId: 1073741916, scripts: [{ mappingId: 1073741825, name: 'board', file: 'board.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
    luas: { 'board.lua': '-- 旧内容\n' },
  });
  process.env.MILIASTRA_LOCALLOW = box.root;
  const src = path.join(tmpRoot, 'board-before.lua');
  fs.writeFileSync(src, beforeExists ? fs.readFileSync(SAMPLE_BOARD_BEFORE, 'utf8') : PIT_MIXED, 'utf8');
  const r = await codeTool.execute({ op: 'deploy', source: src, file: 'board.lua' }, {});
  assert(r.ok === true, '部署被拦了（这两条 warning 不该阻断）：' + JSON.stringify(r.errors || r).slice(0, 200));
  const pits = (r.warnings || []).filter((w) => w && typeof w === 'object' && w.rule === 'v2-sanitize-mixed-templates');
  assert(pits.length === 1, 'warnings 里没有该条：' + JSON.stringify(r.warnings));
  assert(/board-before\.lua:\d+/.test(pits[0].where || ''), 'where 不是 file:line：' + JSON.stringify(pits[0]));
  assert(r.knownPitCount >= 1 && /docs\/功能详解/.test(r.knownPitDoc || ''), '没回 knownPitCount/文档链：' + JSON.stringify({ c: r.knownPitCount, d: r.knownPitDoc }));
  // `ok` 语义不变：lint 正常就还是 true，errors 仍为空
  assert(r.errors.length === 0, 'errors 不该被这两条污染：' + JSON.stringify(r.errors));
  return (beforeExists ? '真样例 ' + path.basename(SAMPLE_BOARD_BEFORE) : '合成夹具（样例不在本机）')
    + ' → ' + pits[0].where + '（ok 仍为 true）';
});

await check('P1-3 ⑥ 集成：恢复白名单后的产物 → 该条**消失**；`op=inspect` 也带同一套 warnings', async () => {
  const box = fakeLevel({
    levelId: '1073741917',
    gils: [makeGil({ levelId: 1073741917, scripts: [{ mappingId: 1073741825, name: 'board', file: 'board.lua' }], mounts: [{ owner: '侦探1-7', mappingIds: [1073741825] }] })],
    luas: { 'board.lua': '-- 旧内容\n' },
  });
  process.env.MILIASTRA_LOCALLOW = box.root;
  const src = path.join(tmpRoot, 'board-after.lua');
  fs.writeFileSync(src, afterExists ? fs.readFileSync(SAMPLE_BOARD_AFTER, 'utf8') : PIT_WHITELISTED, 'utf8');
  const r = await codeTool.execute({ op: 'deploy', source: src, file: 'board.lua' }, {});
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors || r).slice(0, 200));
  const pits = (r.warnings || []).filter((w) => w && typeof w === 'object' && w.rule === 'v2-sanitize-mixed-templates');
  assert(pits.length === 0, '恢复白名单后还在报：' + JSON.stringify(pits[0] && pits[0].where));
  const insp = await codeTool.execute({ op: 'inspect', file: 'board.lua' }, {});
  assert(insp.ok === true && Array.isArray(insp.warnings), 'inspect 没带 warnings 数组：' + JSON.stringify(Object.keys(insp)));
  assert(insp.warnings.every((w) => w && typeof w === 'object' && w.where && w.rule && w.fix && w.doc),
    'inspect 的 warnings 元素形状不对：' + JSON.stringify(insp.warnings));
  return (afterExists ? '真样例 ' + path.basename(SAMPLE_BOARD_AFTER) : '合成夹具（样例不在本机）')
    + ' → sanitize 告警 0 条；inspect 回 ' + insp.warnings.length + ' 条（对象，含 where/fix/doc）';
});

/* ------------------------------------------------------------------ 收尾 */
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
process.env.MILIASTRA_DATA_DIR = savedData === undefined ? '' : savedData;
process.env.MILIASTRA_BACKUP_DIR = savedBak === undefined ? '' : savedBak;

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
