/**
 * `op=bind treeFromGil`（2026-10-15 §3 改造）自测。
 *
 * 为什么单开一个套件：这条能力的**价值全在"嵌套真的建出来了"**上 ——
 * 平铺一层时脚本 `GetChild` 全 `nil`，而这件事**回执上看不出来**（`ok:true`、`controlCount` 也可能 > 0）。
 * 所以这里自己造一份**最小 `.gil`**（20 字节头 + protobuf 主体 + 4 字节尾，字段号照 `lib/gil.mjs` 实测布局），
 * 钉住四件事：
 *   ① **纯函数** `clientUiTreeFromGil()`：根 = `parent == null`；子按 `#503` 递归；`guid` 只给根；
 *      账目 `records = built + skipped + unresolved + notInPlan` 对得上；结构控件默认不当模板；
 *      查不到的 id / 数据环**如实记**、不静默丢；
 *   ② **真搭进模拟器**：模板数 = 根数、顶层 `guid` 原样（= 脚本 `InstantiateClientUIControl` 要的 `prefabIndex`）、
 *      子件按嵌套在位（`op=controls` 的 `depth` 能看出层级）；
 *   ③ **脚本真的查得到**（端到端）：Lua 里 `GetChild("颜料盘")` / `GetChild("蓝色方块")` /
 *      `GetChild("光标检测区域")` / `FindChild("蓝色方块/图片")` 全命中、`#GetChildren() == 6`
 *      —— 这条就是本改造的验收点（`containerId` 的**直接子件**要在，否则脚本首帧就 `error(...)` 停摆）；
 *   ④ **失败路径不抛异常**：文件不存在 / 关卡认不出 / 读不出控件表 ⇒ `{ok:false, code, error, nextStep}`；
 *      `templates` 与 `treeFromGil` 互斥；且**只读**（跑完 `.gil` 逐字节没变）。
 *
 * ⚠️ 环境：全程用临时数据目录（`MILIASTRA_DATA_DIR`），不碰用户的 shots/simulator，也不碰游戏存档。
 * ⚠️ **不提交任何用户存档**：夹具是这里现造的合成 `.gil`。
 *
 * 用法：node tests/treefromgil-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}
const eq = (a, b, label) => ok(label, JSON.stringify(a) === JSON.stringify(b), '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-treefromgil-test-'));
process.env.MILIASTRA_DATA_DIR = tmpData;
process.env.QXQY_PLAY_TIMEOUT_MS = '8000';

const { readGil, clientUiTreeFromGil, GIL_CONTROL_KIND, controlKindOfName } = await import('../lib/gil.mjs');
const { simOp, disposeSimAll } = await import('../lib/sim.mjs');

/* ---------- 手搓 protobuf 编码器（只够造这份样本；字段号照 lib/gil.mjs 顶部注释） ---------- */
/* ⚠️ 每个助手都必须**返回 Buffer**（`Buffer.concat` 的元素是 Buffer 或 Uint8Array，不是「数组的数组」）——
 *    第一版把 `Buffer.concat` 丢了，`msg()` 收到的是 Uint8Array 数组 ⇒ 整份夹具全歪（`readGil` 读出 20 条 `parent` 全非空）。 */
const vi = (n) => { const out = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const tag = (no, wt) => vi(no * 8 + wt);
const vint = (no, n) => cat(tag(no, 0), vi(n));
const bytes = (no, buf) => cat(tag(no, 2), vi(buf.length), buf);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...kids) => bytes(no, cat(...kids));
/** 名字藏两层：`#505 → #12 → #501`（`asControlRecord` 只认这条路径）。 */
const nameField = (name) => msg(505, msg(12, str(501, name)));
/**
 * 一条客户端控件记录：`#501` id / `#503` 子 id 列表 / `#504` 父 id / `#505→#12→#501` 名字。
 * `imageIds` = 额外再塞几个 `#501` 号段内的 varint（模拟真图里那种"图源号落在记录子树里"）。
 */
const ctrl = ({ id, name, parent = null, children = [], imageIds = [] }) => msg(7,
  vint(501, id),
  ...(children.length ? [bytes(503, cat(...children.map((c) => vi(c))))] : []),
  ...(parent == null ? [] : [vint(504, parent)]),
  nameField(name),
  // 真图里"图片"控件的图源号就落在**记录自己的子树里**；这里照样塞几个（`asControlRecord` 收 100001~112042）
  ...imageIds.map((v) => vint(501, v)),
);

/*
 * 合成夹具的树（号段遵守真机的量级，但**都是我自己编的** —— ⛔ 不是任何真实关卡的号）：
 *   1073743001 容器节点           ← 这就是 containerId；脚本要它的直接子件「光标检测区域」
 *     ├ 1073743002 光标检测区域
 *     ├ 1073743003 图片
 *     └ 1073743004 文本框
 *   1073743010 颜色转盘            ← 官名没命中 ⇒ kind 退回 container（kindGuessed）
 *     ├ 1073743011 蓝色方块
 *     │   ├ 1073743012 图片（imageId 100001）
 *     │   └ 1073743013 图片（imageId 100003）
 *     └ 1073743014 颜料盘
 *         ├ 1073743015 图片
 *         ├ 1073743016 图片
 *         ├ 1073743017 图片
 *         ├ 1073743018 图片
 *         ├ 1073743019 图片
 *         └ 1073743020 图片
 *   1073743030 图片                 ← 叶子模板
 *   1073743040 默认布局             ← 结构控件（默认不当模板）
 *     └ 1073743041 图片
 *   1073743050 数据环               ← children 指回自己（如实记 cycle）
 *     └ 1073743050（自指）
 *   1073743060 半截树               ← children 里有一个不存在的 id（如实记 missing）
 *     └ 1073743999（不存在）
 */
const F = {
  container: 1073743001, cursor: 1073743002, cImg: 1073743003, cText: 1073743004,
  wheel: 1073743010, square: 1073743011, sqImg1: 1073743012, sqImg2: 1073743013,
  palette: 1073743014,
  palImgs: [1073743015, 1073743016, 1073743017, 1073743018, 1073743019, 1073743020],
  leafImg: 1073743030,
  layout: 1073743040, layoutImg: 1073743041,
  cycle: 1073743050,
  broken: 1073743060, ghost: 1073743999,
};
const RECORDS = [
  ctrl({ id: F.container, name: '容器节点', children: [F.cursor, F.cImg, F.cText] }),
  ctrl({ id: F.cursor, name: '光标检测区域', parent: F.container }),
  ctrl({ id: F.cImg, name: '图片', parent: F.container, imageIds: [100001] }),
  ctrl({ id: F.cText, name: '文本框', parent: F.container }),
  ctrl({ id: F.wheel, name: '颜色转盘', children: [F.square, F.palette] }),
  ctrl({ id: F.square, name: '蓝色方块', parent: F.wheel, children: [F.sqImg1, F.sqImg2] }),
  ctrl({ id: F.sqImg1, name: '图片', parent: F.square, imageIds: [100001] }),
  ctrl({ id: F.sqImg2, name: '图片', parent: F.square, imageIds: [100003] }),
  ctrl({ id: F.palette, name: '颜料盘', parent: F.wheel, children: F.palImgs }),
  ...F.palImgs.map((id) => ctrl({ id, name: '图片', parent: F.palette, imageIds: [100002] })),
  ctrl({ id: F.leafImg, name: '图片' }),
  ctrl({ id: F.layout, name: '默认布局', children: [F.layoutImg] }),
  ctrl({ id: F.layoutImg, name: '图片', parent: F.layout, imageIds: [100001] }),
  ctrl({ id: F.cycle, name: '数据环', children: [F.cycle] }),
  ctrl({ id: F.broken, name: '半截树', children: [F.ghost] }),
];
/*
 * ⚠️ `RECORDS` 是**编码后的 Buffer**（只用来拼夹具）；纯函数吃的是 `readGil()` 解析出来的记录 ——
 *    第一版把 Buffer 直接喂给 `clientUiTreeFromGil()`，于是 `r.parent` 恒 `undefined`、一条根都认不出来（自测当场抓到）。
 */

const fixturePath = path.join(tmpData, 'fixture.gil');
{
  const body = Buffer.concat([
    vint(1, 1073749999),                 // #1 关卡 ID（编的，不是任何真实关卡）
    str(2, '合成夹具'),                   // #2 关卡名
    vint(39, 1),                          // #39 账号（编的）
    str(43, '7.1.0'),                     // #43 版本
    msg(20, ...RECORDS),                  // 客户端控件记录（collectControls 会递归下去）
  ]);
  const head = Buffer.alloc(20);
  head.writeUInt32BE(0x0326, 8);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(body.length, 16);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(0x0679, 0);
  fs.writeFileSync(fixturePath, Buffer.concat([head, body, tail]));
}
const fixtureShaBefore = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
const fixtureSizeBefore = fs.statSync(fixturePath).size;

/* ---------- ⓪ 夹具本身能被 readGil 读出来（否则后面全是假绿） ---------- */
{
  const g = readGil(fixturePath);
  ok('⓪ 合成夹具能被 readGil 读出控件表（字段号#501/#503/#504/#505 都对得上）',
    g.ok === true && g.clientUI.length === RECORDS.length,
    'ok=' + g.ok + ' records=' + g.clientUI.length + '/' + RECORDS.length);
  ok('⓪ 关卡 id / 名字从夹具里读出来（回执 `level` 才有内容）',
    g.level.id === 1073749999 && g.level.name === '合成夹具', JSON.stringify(g.level));
  const c = g.clientUI.find((r) => r.id === F.container);
  ok('⓪ 父子/子列表/图片号都读到了', !!c && c.parent === null && c.children.length === 3 && c.children[0] === F.cursor,
    JSON.stringify(c));
}

/* ---------- ① 纯函数：clientUiTreeFromGil ---------- */

/*
 * ⚠️ 传进去的必须是 **readGil 解析出来的记录**（`{id,name,parent,children,imageIds}`），
 *   不是上面那批 **编码后的 Buffer** —— 纯函数吃的是解析产物（`RECORDS_BYTES` 只用于拼夹具）。
 */
const PARSED = readGil(fixturePath).clientUI;
{
  ok('①a 官名映射：11 个官方控件名一个不差，命不中的 **退回 container 并标 guessed**',
    Object.values(GIL_CONTROL_KIND).length === 11
    && controlKindOfName('图片').kind === 'image' && controlKindOfName('图片').guessed === false
    && controlKindOfName('颜料盘').kind === 'container' && controlKindOfName('颜料盘').guessed === true,
    JSON.stringify(controlKindOfName('颜料盘')));
}

const tree = clientUiTreeFromGil(PARSED, { containerId: F.container });
{
  ok('①b 根 = `parent == null` 的 6 条里，5 条当模板（结构控件 `默认布局` 那条不进 plan）',
    tree.roots === 5 && tree.standaloneRoots === 6,
    'roots=' + tree.roots + ' standalone=' + tree.standaloneRoots + ' → ' + tree.plan.map((n) => n.name).join(','));
  const names = tree.plan.map((n) => n.name);
  ok('①c 结构控件**默认不当模板**：`默认布局` 不在 plan 里，但**如实列进** `structuralRoots`',
    names.indexOf('默认布局') < 0 && tree.structuralRoots.some((r) => r.name === '默认布局') && tree.structuralRoots.length === 1,
    JSON.stringify({ names, structuralRoots: tree.structuralRoots }));
  const wheel = tree.plan.find((n) => n.name === '颜色转盘');
  ok('①d 嵌套照搬：颜色转盘 → 蓝色方块 + 颜料盘 → 6 个图片子件（22 个节点那棵的缩小版）',
    !!wheel && wheel.children.length === 2
    && wheel.children[0].name === '蓝色方块' && wheel.children[0].children.length === 2
    && wheel.children[1].name === '颜料盘' && wheel.children[1].children.length === 6,
    JSON.stringify(wheel && wheel.children.map((c) => c.name + '(' + c.children.length + ')')));
  ok('①e `guid` **只给根**（它就是脚本 InstantiateClientUIControl 的 prefabIndex）；子件一个都不给',
    wheel.guid === F.wheel && wheel.children.every((c) => c.guid === undefined)
    && wheel.children.every((c) => (c.children || []).every((d) => d.guid === undefined)),
    JSON.stringify({ wheelGuid: wheel.guid, kidGuid: wheel.children[0].guid }));
  ok('①f 自定义名字的根也标 `kindGuessed`（颜色转盘/颜料盘这类名字官名命不中）',
    wheel.kindGuessed === true && wheel.kind === 'container',
    JSON.stringify({ kind: wheel.kind, guessed: wheel.kindGuessed }));
  const sqImg1 = tree.plan.find((n) => n.name === '颜色转盘').children[0].children[0];
  const ctrNode = tree.plan.find((n) => n.name === '容器节点');
  ok('①g 图片子件带上 `imageId`（取该记录 imageIds[0]；非图片控件不带）',
    sqImg1.imageId === 100001 && sqImg1.kind === 'image'
    && (ctrNode.children.find((c) => c.name === '文本框') || {}).imageId === undefined,
    JSON.stringify(sqImg1));
  ok('①h 账目对得上：`records = built + skipped + unresolved + notInPlan`',
    tree.records === tree.built + tree.skipped + tree.unresolved + tree.notInPlan,
    JSON.stringify({ records: tree.records, built: tree.built, skipped: tree.skipped, unresolved: tree.unresolved, notInPlan: tree.notInPlan }));
  ok('①i 数据环**如实记 cycle**（不无限展开、也不静默丢）',
    tree.unresolvedList.some((u) => u.reason === 'cycle' && u.id === F.cycle && u.parent === F.cycle),
    JSON.stringify(tree.unresolvedList));
  ok('①j 子 id 在记录表里查不到 ⇒ **如实记 missing**（不编节点、不静默）',
    tree.unresolvedList.some((u) => u.reason === 'missing' && u.id === F.ghost && u.parent === F.broken),
    JSON.stringify(tree.unresolvedList));
  ok('①k `containerIdInTree` 交叉核对：这几条号真在 plan 的根里',
    tree.containerIdInTree === true && tree.containerId === F.container,
    JSON.stringify({ id: tree.containerId, inTree: tree.containerIdInTree }));
  ok('①l `kindStats` / `guessedKind` 如实报「有几条 kind 是猜的」（自定义名字那 5 条）',
    tree.kindStats.image === 10 && tree.kindStats.cursor === 1 && tree.kindStats.textbox === 1
    && tree.guessedKind === 5,
    JSON.stringify({ kindStats: tree.kindStats, guessedKind: tree.guessedKind }));
  const withStruct = clientUiTreeFromGil(PARSED, { includeStructural: true, containerId: F.container });
  ok('①m `includeStructural:true` 才把结构控件也当模板（默认 false = 不搭平台自带的画布/布局）',
    withStruct.plan.some((n) => n.name === '默认布局') && withStruct.structuralRoots.length === 0
    && withStruct.roots === tree.roots + 1,
    JSON.stringify({ roots: withStruct.roots, struct: withStruct.structuralRoots }));
  /*
   * `maxDepth:1` = 根（depth 0）与其直接子（depth 1）都建；再往下（depth 2 的「图片」）**如实记一条 maxDepth**。
   */
  const shallow = clientUiTreeFromGil(PARSED, { maxDepth: 1, containerId: F.container });
  const shallowWheel = shallow.plan.find((n) => n.name === '颜色转盘');
  ok('①n `maxDepth` 超限**如实记一条 maxDepth**（不返回半个节点、也不假装它没子件）',
    shallow.skippedList.some((s) => s.reason === 'maxDepth' && s.depth === 2)
    && shallowWheel.children.length === 2
    && shallowWheel.children[0].name === '蓝色方块' && shallowWheel.children[0].children === undefined,
    JSON.stringify({ skipped: shallow.skippedList.slice(0, 3), square: shallowWheel.children[0] }));
  const noCid = clientUiTreeFromGil(PARSED, {});
  ok('①o 不给 `containerId` ⇒ `containerIdInTree:null`（判不了就说判不了，不默认 false）',
    noCid.containerId === null && noCid.containerIdInTree === null);
  const missingCid = clientUiTreeFromGil(PARSED, { containerId: 123456789 });
  ok('①p 给了但树里没有 ⇒ `containerIdInTree:false`（明确说"你交的容器不在这次要搭的树里"）',
    missingCid.containerIdInTree === false);
}

/* ---------- ② `op=bind treeFromGil`：真搭进模拟器 ---------- */

const lua = path.join(tmpData, 'tree-probe.lua');
fs.writeFileSync(lua, [
  'function OnStart()',
  '  print("[tf] start")',
  '  local c = game.InstantiateClientUIControl(' + F.container + ', script.object)',
  '  print("[tf] container=" .. tostring(c ~= nil))',
  '  if c then',
  '    print("[tf] cursor=" .. tostring(c:GetChild("光标检测区域") ~= nil))',
  '    print("[tf] text=" .. tostring(c:GetChild("文本框") ~= nil))',
  '  end',
  '  local w = game.InstantiateClientUIControl(' + F.wheel + ', script.object)',
  '  print("[tf] wheel=" .. tostring(w ~= nil))',
  '  if w then',
  '    local p = w:GetChild("颜料盘")',
  '    print("[tf] palette=" .. tostring(p ~= nil) .. " kids=" .. tostring(p and #p:GetChildren() or -1))',
  '    print("[tf] square=" .. tostring(w:GetChild("蓝色方块") ~= nil))',
  '    print("[tf] deep=" .. tostring(w:FindChild("蓝色方块/图片") ~= nil))',
  '    w:SetSizeDelta(600, 600); w:SetAnchoredPosition(0, 0)',
  '  end',
  'end',
  '',
].join('\n'), 'utf8');

const bound = await simOp({ op: 'bind', source: lua, treeFromGil: fixturePath, containerId: F.container, keepRunning: true, withMeta: true });
{
  ok('②a `op=bind treeFromGil` 成功，模板数 = plan 的根数（不是 1、也不是平铺那几条）',
    bound.ok !== false && bound.bound === true && bound.templateCount === tree.roots && bound.treeFromGil.templateRoots === tree.roots,
    JSON.stringify({ ok: bound.ok, bound: bound.bound, templateCount: bound.templateCount, roots: tree.roots }));
  ok('②b 顶层 `guid` 原样落地（= 记录自己的号 = 脚本要的 prefabIndex）',
    bound.templates.map((t) => t.guid).sort((a, b) => a - b).join(',')
    === [F.container, F.wheel, F.leafImg, F.cycle, F.broken].sort((a, b) => a - b).join(','),
    JSON.stringify(bound.templates));
  ok('②c 搭完**自检通过**：逐条比对"我要建的"与"工程里真在的"（`missing:0` / `nameMismatch:0` / `ok:true`）',
    bound.treeFromGil.verify.ok === true && bound.treeFromGil.verify.missing.length === 0
    && bound.treeFromGil.verify.actualTemplates === tree.roots,
    JSON.stringify(bound.treeFromGil.verify));
  ok('②d 回执如实交代：`built/skipped/unresolved/notInPlan` + `guessedKind` + 跳过清单',
    bound.treeFromGil.built === tree.built && bound.treeFromGil.skipped === tree.skipped
    && bound.treeFromGil.unresolved === tree.unresolved && bound.treeFromGil.notInPlan === tree.notInPlan
    && bound.treeFromGil.guessedKind === 5
    && bound.treeFromGil.unresolvedList.some((u) => u.reason === 'cycle')
    && bound.treeFromGil.unresolvedList.some((u) => u.reason === 'missing')
    && bound.treeFromGil.structuralRoots.length === 1,
    JSON.stringify({
      built: bound.treeFromGil.built, skipped: bound.treeFromGil.skipped,
      unresolved: bound.treeFromGil.unresolved, notInPlan: bound.treeFromGil.notInPlan,
      guessedKind: bound.treeFromGil.guessedKind,
    }));
  ok('②e 回执说清「读的是哪份 .gil / 哪张图」（`treeFromGil.path` / `level`）',
    bound.treeFromGil.path === fixturePath && bound.treeFromGil.level.id === 1073749999,
    JSON.stringify({ path: bound.treeFromGil.path, level: bound.treeFromGil.level }));
  const logs = (bound.run && bound.run.logs) || [];
  const text = logs.map((l) => l.text).join('\n');
  ok('②f ★ 脚本 `GetChild("光标检测区域")` 命中 —— `containerId` 的**直接子件**真在（否则首帧就 error 停摆）',
    /\[tf\] cursor=true/.test(text), text);
  ok('②g ★ 两层嵌套命中：`GetChild("颜料盘")` + `#GetChildren()==6`（平铺一层时这两条恒 nil/-1）',
    /\[tf\] palette=true kids=6/.test(text), text);
  ok('②h `GetChild("蓝色方块")` 与 `FindChild("蓝色方块/图片")` 都命中（名字路径能走通）',
    /\[tf\] square=true/.test(text) && /\[tf\] deep=true/.test(text), text);
}

/* ---------- ③ 运行时控件树：层级是真的（depth 能看出父子） ---------- */

/*
 * ★ `last:true` 一键重搭（§3 也把它接上了）：配方里记了 `treeFromGil` ⇒ 重启 `dsh web` 后能把**这棵树**重搭，
 *   而不是只剩平铺模板。放在 ③ 之前 —— ④ 那几条会把配方覆盖掉。
 */
{
  const rebound = await simOp({ op: 'bind', last: true, run: true, keepRunning: true, withMeta: true });
  ok('★ 配方记下 `treeFromGil` ⇒ `last:true` 一键重搭的是**这棵树**（不是平铺、模板数不变）',
    rebound.fromLast === true && rebound.templateCount === tree.roots && rebound.treeFromGil.ok === true
    && rebound.treeFromGil.built === tree.built,
    JSON.stringify({ fromLast: rebound.fromLast, templateCount: rebound.templateCount, built: rebound.treeFromGil && rebound.treeFromGil.built }));
}

{
  const ctl = await simOp({ op: 'controls', runtime: true, limit: 0 });
  const by = (n) => ctl.controls.filter((c) => c.name === n);
  ok('③a `op=controls runtime:true` 里有模板内部的子控件名（颜料盘/蓝色方块/光标检测区域）',
    by('颜料盘').length === 1 && by('蓝色方块').length === 1 && by('光标检测区域').length === 1,
    JSON.stringify({ 颜料盘: by('颜料盘').length, 蓝色方块: by('蓝色方块').length, 光标检测区域: by('光标检测区域').length }));
  ok('③b ★ 子件的 `depth` 比根**深**（父子关系真存在，不是平铺）',
    by('颜色转盘')[0] && by('颜料盘')[0] && by('颜料盘')[0].depth > by('颜色转盘')[0].depth
    && by('蓝色方块')[0].depth > by('颜色转盘')[0].depth,
    JSON.stringify({ wheel: by('颜色转盘')[0], palette: by('颜料盘')[0], square: by('蓝色方块')[0] }));
  const six = ctl.controls.filter((c) => c.name === '图片' && c.depth >= 3);
  ok('③c 颜料盘那 6 个图片子件都在运行时树里（按名字数得出来）', six.length >= 6, 'depth>=3 的图片：' + six.length);
  const shot = await simOp({ op: 'shot', target: 'play', label: 'treefromgil-test' });
  ok('③d `op=shot target=play` 能出图（脚本动态建的控件真的进了场景）',
    shot && shot.bytes > 1000 && fs.existsSync(shot.file),
    JSON.stringify({ file: shot && shot.file, bytes: shot && shot.bytes }));
  /*
   * ★ **跑完立刻把会话与 Worker 收干净**（这个套件与其它套件**并行**跑，`tools/test-all.mjs` 默认 4 路）：
   *   `keepRunning:true` 留下的 Worker 里有个 **30FPS 的后台时钟**。不收干净就是给同一台机器上
   *   `sim-test` 那几条"时钟增量必须正好 N×1/30s"的断言**加负载** —— 实测：本套件一进 `SUITES`，
   *   `sim-test` 就间歇报 `frames:15 量到 16 帧`（把本套件注掉再跑 4 路，39/39 全绿）。
   *   这不是 sim-test 的 bug，也不该让别人的测试替我们扛 —— 自己的 Worker 自己收。
   */
  await simOp({ op: 'play', action: 'stop' }).catch(() => {});
  await disposeSimAll();
}

/* ---------- ④ 失败路径：回回执、不抛异常、指路 ---------- */

const err = async (fn) => { try { const r = await fn(); return r && r.ok === false ? r : null; } catch (e) { return { threw: (e && e.message) || String(e) }; } };

{
  const bad = await err(() => simOp({ op: 'bind', source: lua, treeFromGil: path.join(tmpData, '没有这个文件.gil') }));
  ok('④a 文件不存在且认不出关卡 ⇒ `{ok:false, code:NOT_FOUND, error, nextStep}`，**不抛异常**',
    !!bad && !bad.threw && bad.code === 'NOT_FOUND' && /找不到匹配/.test(bad.error) && !!bad.nextStep,
    JSON.stringify(bad));

  const notGil = path.join(tmpData, '故意做坏', '不是gil.gil');
  fs.mkdirSync(path.dirname(notGil), { recursive: true });
  fs.writeFileSync(notGil, 'hello world, not a protobuf at all', 'utf8');
  const bad2 = await err(() => simOp({ op: 'bind', source: lua, treeFromGil: notGil }));
  ok('④b 读不出控件表 ⇒ `{ok:false}`，并点名"确认这是地图存档 .gil（不是控件组 .gia）"',
    !!bad2 && !bad2.threw && bad2.code === 'FAILED' && /控件表/.test(bad2.error) && /\.gia/.test(bad2.nextStep || bad2.error),
    JSON.stringify(bad2));

  const both = await err(() => simOp({ op: 'bind', source: lua, treeFromGil: fixturePath, templates: [{ guid: 1073743001, kind: 'container' }] }));
  ok('④c `treeFromGil` 与 `templates` **互斥**（同时给 = 参数错，不静默挑一个）',
    !!both && !both.threw && both.code === 'BAD_PARAM' && /二选一/.test(both.error),
    JSON.stringify(both));

  /* ④d：`containerId` 不在树里（画布上摆的实例）⇒ **不失败**，但要给 `containerIdNote` 指路 */
  const outOfTree = await simOp({ op: 'bind', source: lua, treeFromGil: fixturePath, containerId: 1073743998, run: false });
  ok('④d `containerId` 不在树里 ⇒ 照搭 + 回 `containerIdNote` 指路（明说"没带它的子件、脚本照样 nil"）',
    outOfTree.ok === true
    && outOfTree.treeFromGil.containerIdInTree === false
    && /不在这棵树的模板根里/.test(outOfTree.containerIdNote || '')
    && /GetChild/.test(outOfTree.containerIdNote || ''),
    JSON.stringify({ ok: outOfTree.ok, inTree: outOfTree.treeFromGil && outOfTree.treeFromGil.containerIdInTree }));
  /* 精简档（默认）也必须带**全部结论**：`ok` / 模板根 / 账目 / `verify` —— 只省逐条清单 */
  const slim = await simOp({ op: 'bind', source: lua, treeFromGil: fixturePath, containerId: F.container, run: false });
  ok('④d-2 默认**精简档**里 `treeFromGil` 的结论一个不少（`ok` / `built` / `guessedKind` / `verify.ok`），只省逐条清单',
    slim.ok === true && slim.treeFromGil.ok === true
    && slim.treeFromGil.built === tree.built && slim.treeFromGil.guessedKind === 5
    && slim.treeFromGil.verify.ok === true && typeof slim.treeFromGil.verify.missing === 'number'
    && slim.treeFromGil.skippedList === 0 && !!slim.treeFromGil.listsPointer,
    JSON.stringify({ ok: slim.ok, tgOk: slim.treeFromGil.ok, built: slim.treeFromGil.built, verify: slim.treeFromGil.verify }));
}

// 只含结构控件的 `.gil`（控件表非空、但一条模板都当不了）⇒ 必须**明确报**而不是搭个空工程
{
  const onlyStructPath = path.join(tmpData, '只有结构', 'only-structural.gil');
  fs.mkdirSync(path.dirname(onlyStructPath), { recursive: true });
  const body = Buffer.concat([
    vint(1, 1073749998), str(2, '只有结构控件'),
    msg(20, ctrl({ id: 1073743200, name: '默认布局', children: [1073743201] }), ctrl({ id: 1073743201, name: '图片', parent: 1073743200 })),
  ]);
  const head = Buffer.alloc(20);
  head.writeUInt32BE(0x0326, 8); head.writeUInt32BE(1, 4); head.writeUInt32BE(body.length, 16);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(0x0679, 0);
  fs.writeFileSync(onlyStructPath, Buffer.concat([head, body, tail]));
  const r = await err(() => simOp({ op: 'bind', source: lua, treeFromGil: onlyStructPath }));
  ok('④e 控件表非空但**一条模板都当不了** ⇒ `{ok:false}` + 指路（并说明 `includeStructural` 能救）',
    !!r && !r.threw && r.code === 'NOT_FOUND' && /可当模板/.test(r.error) && /includeStructural/.test(r.nextStep || ''),
    JSON.stringify(r));
}

/* ---------- ⑤ 只读：`.gil` 一个字节都没变 ---------- */

{
  const after = fs.readFileSync(fixturePath);
  ok('⑤ 夹具 `.gil` 逐字节未变（size 相同 + sha256 相同）—— `treeFromGil` **只读**',
    after.length === fixtureSizeBefore && crypto.createHash('sha256').update(after).digest('hex') === fixtureShaBefore,
    'size ' + fixtureSizeBefore + '→' + after.length);
  const extras = fs.readdirSync(tmpData).filter((n) => /\.(gia|gil)$/.test(n) && path.join(tmpData, n) !== fixturePath);
  ok('⑤b 工具没往 `.gil` 那个目录写任何东西（夹具还在，没有多出来的产物）',
    extras.length === 0,
    JSON.stringify(extras));
}

/* ---------- §2 回归：mountTo 回执里列出的值，原样回填必须能命中 ---------- */

{
  const { resolveMountTarget } = await import('../lib/sim.mjs');
  const pool = [{ id: 'n1', name: '容器节点' }, { id: 'n2', name: '文本框' }, { id: 'n3', name: '按钮' }];
  const miss = resolveMountTarget('不存在的名字', pool, {});
  ok('§2 回归：没命中时 hit=null（调用方据此报错，并列出 available），且 available 列全候选',
    miss.hit === null && Array.isArray(miss.available) && miss.available.length === pool.length,
    JSON.stringify({ hit: miss.hit, available: miss.available }));
  const missed = miss.available.filter((v) => resolveMountTarget(v, pool, {}).mount === null);
  ok('§2 回归：回执里 `可用：…` 的每个值 **原样回填都必须命中**（照抄回执不许再撞墙）',
    missed.length === 0, '这些值回填没命中：' + JSON.stringify(missed));
  ok('§2 旧行为不变：纯名字 / 纯 n<序号> 照样认',
    resolveMountTarget('容器节点', pool, {}).mount !== null && resolveMountTarget('n2', pool, {}).mount !== null);
}

/* ---------- 汇总 ---------- */

console.log('结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
