/**
 * 节点图 / 自定义变量读取自测（`lib/gilnodes.mjs`）。
 *
 * 为什么要单开一个套件：这块是**照 protobuf 字段号读二进制**，字段号写错不会报错、只会"读到空" ——
 * 所以这里**自己造一份 `.gil`**（20 字节头 + 主体 + 4 字节尾，字段号照实测布局），
 * 把「图名 / 类型 / 节点数 / 连线数 / 变量名 / 变量类型 / 是否公开」逐项钉住，
 * 再钉住「读不出来就如实说 unverified，不编名字」与「只读（文件一个字节没变）」。
 *
 * ⚠️ 与 `read-source-test` 同一条纪律：**环境缺失**（本机没有 `.gil`）⇒ 如实跳过，不伪装通过。
 *
 * 用法：node tests/gilnodes-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readGilNodeFacts, readNodeGraphs, readEntities, readComponents, briefLine, graphIdRange,
  GRAPH_TYPES, VAR_TYPES, VAR_TYPES_VERIFIED,
} from '../lib/gilnodes.mjs';

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

/* ---------- 手搓 protobuf 编码器（只够造这份样本用） ---------- */
const vi = (n) => { const out = []; let v = n; do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const tag = (no, wt) => vi(no * 8 + wt);
const vint = (no, n) => Buffer.concat([tag(no, 0), vi(n)]);
const bytes = (no, buf) => Buffer.concat([tag(no, 2), vi(buf.length), buf]);
const str = (no, s) => bytes(no, Buffer.from(s, 'utf8'));
const msg = (no, ...kids) => bytes(no, Buffer.concat(kids));

/** 一条 `identity`：`#1`=origin / `#2`=service_domain（图类型） / `#3`=kind / `#5`=图 id */
const identity = (domain, kind, id) => msg(1, vint(1, 10000), vint(2, domain), vint(3, kind), vint(5, id));
/** 一条图记录：`{ #1: { #1: identity, #2: 图名, #3: 图体 }, #2: … }` */
const graph = (name, domain, kind, id, nodeCount, links) => {
  const body = msg(3, vint(1, nodeCount), ...Array.from({ length: links }, (_, i) => msg(4, vint(1, i + 1), vint(4, nodeCount))));
  return msg(1, msg(1, identity(domain, kind, id), str(2, name), nodeCount == null ? Buffer.alloc(0) : body));
};
/** 一条 `GraphVariable`：`#2`=名 / `#3`=类型 / `#4`=初值（TypedValue：`#1`=类型 + 类型号字段）/ `#5`=是否公开 */
const variable = (name, typeCode, isPublic, withValue) => {
  const tv = msg(4, vint(1, typeCode), msg(2, vint(1, typeCode), bytes(2, Buffer.alloc(0))),
    ...(withValue ? [bytes(13, Buffer.from([1, 0, 0, 0]))] : []));
  return msg(1, str(2, name), vint(3, typeCode), tv, vint(5, isPublic ? 1 : 0));
};
/** 实体记录：`#1 { #1=实体id, #5{#1=1,#11=名字}, #7 { #11 { #1=vars… } } }` */
const entity = (name, id, vars, kindCode) => msg(5, msg(1,
  vint(1, id),
  ...(kindCode ? [msg(2, vint(1, kindCode), vint(2, 1))] : []),
  msg(5, vint(1, 1), str(11, name)),
  msg(5, vint(1, 111)),          // 组件槽
  msg(5, vint(1, 19)),           // 组件槽
  ...(kindCode ? [vint(8, kindCode)] : []),
  msg(7, vint(1, 1), vint(2, 1), msg(11, ...vars)),
));
/** 一个「元件」的条目（真实文件里它们都挂在**同一个** `#4` 下）：名字藏在 `#1.#2` 里 */
const component = (name) => msg(1, msg(2, str(2, name)), msg(6, vint(1, 1)), msg(7, vint(1, 1)), msg(8, vint(1, 1)));

/** 一条节点声明（顶层 `#10.#4`）：`#1{ #1{ id }, #5{ 短串/长串 } }` */
const decl = (id, composite, labels, notes) => msg(1,
  msg(1, vint(1, 10000), vint(2, 20000), vint(3, 21002), vint(5, id)),
  msg(5, str(1, '名称'), str(2, '数值')),
  ...labels.map((s) => str(11, s)),
  ...notes.map((s) => str(12, s)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-gilnodes-'));
const gilPath = path.join(tmp, '1073741999.gil');
{
  const body = Buffer.concat([
    entity('关卡实体', 1094713345, [
      variable('测试计数', 3, true, false),
      variable('侦_消息', 6, true, true),
      variable('侦_名单', 11, false, false),
      variable('某未知类型', 99, true, false),
    ], 10003004),
    entity('默认模版', 1086324737, [], 1086324737),
    msg(4, component('默认模版'), component('默认模版(角色编辑)')),
    msg(10,
      graph('玩家自身', 20000, 21001, 1073741825, null, 0),
      graph('关卡实体信号', 20000, 21001, 1073741826, 9, 1),
      graph('某客户端图', 20002, 21003, 1082130432, 3, 2),
      msg(4, decl(1073741845, false, ['侦_名声', '数值'], ['由于负载消耗太高，基本没有实际意义；留着引以为戒。'])),
      msg(4, decl(1610612737, true, ['侦_浮点数', '名称', '数值'], []))),
    msg(15, msg(1, vint(1, 1094713345), msg(4, msg(11, str(1, '自定义成长曲线'), str(2, '关键字甲'))))),
    msg(6,
      msg(1, vint(1, 800), msg(2, str(1, 'root'), vint(3, 1)), msg(3, str(1, '玩家模版'), vint(3, 2), msg(5, vint(1, 1700), vint(2, 1086324737)))),
      msg(1, vint(1, 56), msg(2, str(1, 'root'), vint(3, 1)), msg(3, str(1, '默认'), vint(3, 2), msg(5, vint(1, 5400), vint(2, 1186988033))))),
    msg(11, msg(2, str(1, '初始玩家阵营'), str(2, 'UI_MarkPlayer_Faction_0')), msg(3, str(1, '出生点1'))),
  ]);
  const head = Buffer.alloc(20);
  head.writeUInt32BE(0x0326, 8);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(body.length, 16);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(0x0679, 0);
  fs.writeFileSync(gilPath, Buffer.concat([head, body, tail]));
}

const before = { sha: crypto.createHash('sha256').update(fs.readFileSync(gilPath)).digest('hex'), mtime: fs.statSync(gilPath).mtimeMs, files: fs.readdirSync(tmp).length };

/* ---------- ① 读节点图 ---------- */
check('①a 图名 / 类型 / kind / id / 节点数 / 连线数 都对（含"无图体"那张）', () => {
  const r = readGilNodeFacts(gilPath, { withVariables: true });
  assert(r.ok === true, '读失败：' + r.error);
  eq(r.graphCount, 3, '图数');
  const g = Object.fromEntries(r.graphs.map((x) => [x.name, x]));
  eq(g['关卡实体信号'].typeCode, 20000, '图类型号');
  eq(g['关卡实体信号'].typeLabel, GRAPH_TYPES[20000], '图类型名');
  eq(g['关卡实体信号'].nodeCount, 9, '节点数');
  eq(g['关卡实体信号'].linkCount, 1, '连线数');
  eq(g['关卡实体信号'].idRange, '服务端', 'id 段');
  eq(g['玩家自身'].hasBody, false, '无图体那张');
  eq(g['某客户端图'].idRange, '客户端', '客户端 id 段');
  return r.graphs.map((x) => x.name + '(' + x.nodeCount + ')').join(' · ');
});

check('①b 按类型分组（作者要求「注意区分各个类型的节点图」）', () => {
  const r = readNodeGraphs([{ no: 10, sub: [] }]);
  eq(r.kinds, [], '空区不该有分类');
  const full = readGilNodeFacts(gilPath, { withVariables: true });
  eq(full.kinds.length, 2, '两种类型');
  eq(full.kinds[0].count, 2, '关卡实体图 2 个');
  eq(full.kinds.map((k) => k.typeLabel).sort(), ['关卡实体图', '客户端技能图'].sort(), '类型名');
  return full.kinds.map((k) => k.typeLabel + '×' + k.count).join(' + ');
});

/* ---------- ② 读实体自定义变量 ---------- */
check('②a 变量名 / 类型（含未确证标位）/ 是否公开 都对', () => {
  const r = readGilNodeFacts(gilPath, { withVariables: true });
  const e = r.entities.find((x) => x.name === '关卡实体');
  assert(e, '没读到「关卡实体」');
  eq(e.variableCount, 4, '变量数');
  eq(e.variables.map((v) => v.name), ['测试计数', '侦_消息', '侦_名单', '某未知类型'], '变量名与顺序');
  eq(e.variables.map((v) => v.typeLabel), ['整数', '字符串', '字符串列表', '未知类型 99'], '类型名');
  eq(e.variables.map((v) => v.typeVerified), [true, true, true, false], '哪些类型号本机确证过');
  eq(e.variables.map((v) => v.isPublic), [1, 1, 0, 1], '是否公开');
  eq(e.variables[1].hasDefault, true, '有初值那条');
  eq(e.variables[0].hasDefault, false, '没初值那条');
  return e.variables.map((v) => v.name + '=' + v.typeLabel).join(' ');
});

check('②b 没变量的实体也在册（`默认模版` 0 个），实体按变量数排序', () => {
  const r = readEntities(readGilNodeFacts(gilPath).graphs.length ? [] : []);
  assert(Array.isArray(r.entities), '形状不对');
  const full = readGilNodeFacts(gilPath, { withVariables: true });
  eq(full.entityCount, 2, '实体数');
  eq(full.entities[0].name, '关卡实体', '变量多的排前面');
  eq(full.totalVariables, 4, '变量总数');
  return full.entities.map((e) => e.name + '(' + e.variableCount + ')').join(' · ');
});

check('②c 实体：种类号 / 组件槽 / 变量计数，名字带「模版」才标模版/元件实例（且带 guess）', () => {
  const r = readGilNodeFacts(gilPath, { withVariables: true });
  const e = r.entities.find((x) => x.name === '关卡实体');
  assert(e, '没读到「关卡实体」');
  eq(e.kindCode, 10003004, '种类号');
  eq(e.kindEcho, 10003004, '#8 回显');
  eq(e.componentSlots, [111, 19], '组件槽');
  eq(e.componentCount, 2, '组件槽数');
  eq(e.variableCount, 4, '变量数');
  assert(!e.roleGuess, '关卡实体不该被标成模版/元件实例');
  const tpl = r.entities.find((x) => x.name === '默认模版');
  assert(tpl && tpl.roleGuess && tpl.roleGuess.guess === true, '名字带「模版」的应当标成模版/元件实例（带 guess:true）');
  eq(r.entityKindCodes, [10003004, 1086324737], '种类号集合');
  return r.entities.map((x) => x.name + '/种类' + x.kindCode + '/槽' + x.componentCount).join(' · ');
});

check('②d 元件区（顶层 #4）：名字 + 分组字段 + 计数', () => {
  const r = readComponents(readGilNodeFacts(gilPath).graphs.length ? [] : []);
  assert(Array.isArray(r.components), '形状不对');
  const full = readGilNodeFacts(gilPath);
  eq(full.componentCount, 2, '元件数');
  eq(full.components.map((c) => c.name), ['默认模版', '默认模版(角色编辑)'], '元件名');
  assert(full.components[0].groups && full.components[0].groups[6] === 1, '元件分组计数不对');
  assert(full.unverified.some((s) => s.includes('元件区')), '元件区语义未确证没进 unverified');
  return full.components.map((c) => c.name + '(' + c.bytes + 'B)').join(' · ');
});

check('②e 节点声明表（#10.#4）：逐条 id / 复合标记 / 短串 / 说明，且**说清 id→节点名不在 .gil**', () => {
  const r = readGilNodeFacts(gilPath);
  eq(r.declarationCount, 2, '声明数');
  eq(r.compositeCount, 1, '复合声明数');
  const one1 = r.declarations.find((d) => d.id === 1073741845);
  assert(one1 && one1.labels.includes('侦_名声'), '普通声明没读到短串：' + JSON.stringify(one1));
  assert(one1.notes.some((s) => s.includes('留着引以为戒')), '普通声明没读到说明：' + JSON.stringify(one1.notes));
  const comp = r.declarations.find((d) => d.id === 1610612737);
  assert(comp && comp.isComposite === true, '复合声明没标出来');
  assert(r.unverified.some((s) => s.includes('不在 .gil 里')), '没写清「id→节点名不在 .gil」这句');
  return r.declarationCount + ' 条（复合 ' + r.compositeCount + '）· 带短串 ' + r.declarationStats.withLabels + ' · 带说明 ' + r.declarationStats.withNotes;
});

check('②f 配置条目 / 阵营 / 资源树：名字与**能确证的关联**（id 命中实体表）', () => {
  const r = readGilNodeFacts(gilPath);
  eq(r.configCount, 1, '配置条数');
  eq(r.configs[0].name, '自定义成长曲线', '配置名');
  assert(r.configs[0].keywords.includes('关键字甲'), '关键字没读到');
  eq(r.configLinked.length, 1, '关联条数');
  assert(/关卡实体/.test(r.configLinked[0]), '关联没指到实体：' + r.configLinked[0]);
  eq(r.resourceCategories, ['玩家模版', '默认'], '资源分类');
  assert(r.resourceTree.some(function (e) { return e.ref && e.ref.id === 1186988033; }), '资源 id（默认→环境配置）没读到');
  assert(r.resourceTree.some(function (e) { return e.ref && e.ref.id === 1086324737; }), '资源 id（玩家模版）没读到');
  eq(r.factions, ['初始玩家阵营', 'UI_MarkPlayer_Faction_0'], '阵营串');
  eq(r.spawns, ['出生点1'], '出生点');
  assert(r.unverified.some((s) => s.includes('字段语义')), '配置字段语义未确证没进 unverified');
  // ★ 种类号标签：有出处（资源树分类名 = 玩家模版）才给名字，并在 kindLabelSource 写出处
  eq(r.entityKindLabels['1086324737'], '玩家模版', '种类号标签');
  const tpl = r.entities.find((x) => x.name === '默认模版');
  assert(tpl && tpl.kindLabel === '玩家模版', '实体没带上种类号标签：' + JSON.stringify(tpl));
  assert(/资源分类树/.test(tpl.kindLabelSource || ''), '出处没写清：' + tpl.kindLabelSource);
  assert(r.unverified.some((s) => s.includes('还没出处') && s.includes('10003004')), '没出处的号没被点名：' + JSON.stringify(r.unverified));
  return r.configs[0].name + ' ↔ ' + r.configLinked[0] + '；分类 ' + r.resourceCategories.join('/');
});

/* ---------- ③ 诚实：读不出来就说读不出来 ---------- */
check('③a 未知类型号 → 原样回数字 + 进 unverified（**不编名字**）', () => {
  const r = readGilNodeFacts(gilPath, { withVariables: true });
  assert(r.unverified.some((s) => s.includes('99')), '未知变量类型号没进 unverified：' + JSON.stringify(r.unverified));
  assert(r.unverified.some((s) => /没在本机确证过/.test(s)), 'unverified 没说清"只是 proto 里这么写"');
  return r.unverified.length + ' 条';
});

check('③b 没有节点图区 / 没有实体表时，如实说（不是"空数组 = 一切正常"）', () => {
  const g = readNodeGraphs([{ no: 1, sub: [] }]);
  assert(g.unverified.some((s) => s.includes('#10')), '缺 #10 没说明');
  const e = readEntities([{ no: 1, sub: [] }]);
  assert(e.unverified.some((s) => s.includes('#5')), '缺 #5 没说明');
  return '两条都点到了区号';
});

check('③c 坏文件（不是 .gil）→ ok:false + 说明，不抛栈', () => {
  // ⚠️ 放在**另一个**临时目录：下面 ⑥ 要断言"只读"（原目录不多出文件），别把自己的造物算进去
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-gilnodes-bad-'));
  const bad = path.join(tmp2, '坏文件.gil');
  fs.writeFileSync(bad, Buffer.from([1, 2, 3]));
  const r = readGilNodeFacts(bad);
  assert(r.ok === false && typeof r.error === 'string', '坏文件没回 ok:false');
  try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
  return r.error.slice(0, 28) + '…';
});

/* ---------- ④ tag 行 / id 段 ---------- */
check('④a 一行 tag：图数 + 类型 + 每张图(节点数) + 变量汇总', () => {
  const facts = readGilNodeFacts(gilPath, { withVariables: true });
  const line = facts.brief;
  assert(line.startsWith('[节点图] 3 个'), 'tag 开头不对：' + line);
  assert(line.includes('关卡实体信号(9节点/1连线)'), 'tag 里没写节点/连线：' + line);
  assert(line.includes('玩家自身(无图体)'), '无图体那张没标"无图体"：' + line);
  assert(line.includes('[实体] 2 个（自定义变量共 4 个'), 'tag 里没写实体/变量汇总：' + line);
  assert(line.includes('[元件] 2 个'), 'tag 里没写元件数：' + line);
  return line;
});

check('④b briefLine 空输入也不炸（没有图时给 `（空）`）', () => {
  const line = briefLine([], {});
  assert(line.includes('0 个'), '空图数不对：' + line);
  assert(line.includes('（空）'), '空列表没给占位：' + line);
  return line;
});

check('④c graphIdRange：服务端 / 客户端 / 复合体三段都能判', () => {
  eq([graphIdRange(1073741824), graphIdRange(1082130432), graphIdRange(1610612736)], ['服务端', '客户端', '复合体'], '三段');
  eq([graphIdRange(1), graphIdRange(NaN)], [null, null], '段外/非法 → null');
  return '服务端 / 客户端 / 复合体';
});

check('⑤ 枚举表有出处且自洽（类型名不许留空）', () => {
  for (const [code, label] of Object.entries(VAR_TYPES)) assert(label && label.length > 0, '类型 ' + code + ' 没名字');
  for (const code of VAR_TYPES_VERIFIED) assert(VAR_TYPES[code], '确证过的类型 ' + code + ' 不在表里');
  eq(VAR_TYPES_VERIFIED.slice(0, 3), [3, 4, 6], '本机确证过的最小集合');
  return 'VAR_TYPES ' + Object.keys(VAR_TYPES).length + ' 条 / 确证 ' + VAR_TYPES_VERIFIED.length + ' 条';
});

/* ---------- ⑥ 只读性 ---------- */
check('⑥ 只读：读完文件逐字节未变、mtime 未变、旁边不多出文件', () => {
  const after = { sha: crypto.createHash('sha256').update(fs.readFileSync(gilPath)).digest('hex'), mtime: fs.statSync(gilPath).mtimeMs, files: fs.readdirSync(tmp).length };
  eq(after.sha, before.sha, '文件内容变了');
  eq(after.mtime, before.mtime, 'mtime 变了');
  eq(after.files, before.files, '目录里多出文件了（不该有临时/备份文件）');
  const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'lib', 'gilnodes.mjs'), 'utf8');
  const wrote = ['writeFileSync', 'appendFileSync', 'createWriteStream', 'renameSync', 'unlinkSync', 'mkdirSync', 'rmSync'].filter((api) => src.includes(api));
  eq(wrote, [], 'gilnodes.mjs 里出现了写操作');
  return '逐字节未变 + mtime 未变 + 目录未变 + 源码无写操作';
});

/* ---------- 清场（**只删自己造的临时目录**） ---------- */
console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) {
  console.log('====== 失败明细 ======');
  failures.forEach((f) => console.log(' ✗ ' + f));
  process.exitCode = 1;
} else {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 删不掉就算了，**不递归删别的** */ }
}
