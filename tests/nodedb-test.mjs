/**
 * 节点词典自测（`lib/nodedb.mjs` + `lib/nodedb.json`）。
 *
 * 为什么要单开：这份词典是**随包发的数据**（205 KB / 558 节点，从参考项目 Pack MIT 的 4.1 MB 库压缩而来），
 * 它一旦损坏或与生成器脱节，AI 就会拿到空结果或错名字 —— 而"查不到"和"没这个节点"在回执里长得一样。
 * 所以这里钉住：① 条目数/系统分布 ② 已知 id 的名字（含端口）③ 搜索排序与多词 AND
 * ④ **归属信息必须在**（MIT / 上游版本）⑤ **产物与生成器同步**（有上游时）⑥ 只读、不联网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadNodeDb, nodeDbMeta, nodeDbFacets, searchNodes, nodeById } from '../lib/nodedb.mjs';

const PKG = path.resolve(import.meta.dirname, '..');
let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { const note = fn(); pass += 1; console.log('  ✅ ' + name + (note ? '  → ' + note : '')); }
  catch (e) { failures.push(name + '：' + e.message); console.log('  ❌ ' + name + '  → ' + e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), (m || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));

const DB_FILE = path.join(PKG, 'lib', 'nodedb.json');
const before = { sha: crypto.createHash('sha256').update(fs.readFileSync(DB_FILE)).digest('hex'), mtime: fs.statSync(DB_FILE).mtimeMs };

check('① 词典能载入：558 节点 / 服务端 434 / 客户端 124 / 端口 2824', () => {
  const db = loadNodeDb();
  eq(db.nodes.length, 558, '节点数');
  eq(db.counts.server, 434, '服务端');
  eq(db.counts.client, 124, '客户端');
  eq(db.counts.pins, 2824, '端口数');
  const ids = db.nodes.map((n) => n.id);
  eq(new Set(ids).size, ids.length, 'id 有重复');
  return db.nodes.length + ' 条 · ' + db.counts.pins + ' 端口';
});

check('② 归属必须在（MIT + 上游版本 + 出处字段）—— 少了这条就等于盗用', () => {
  const meta = nodeDbMeta();
  eq(meta.license, 'MIT', '许可');
  assert(/Wu-Yijun/.test(meta.copyright || ''), '缺上游版权声明');
  assert(/Node-Editor-Pack/.test(meta.project || ''), '缺上游项目名');
  assert(meta.dbVersion && meta.gameVersion, '缺上游版本号');
  assert(meta.generatedBy && /gen-nodedb/.test(meta.generatedBy), '缺生成器出处');
  return meta.project + ' · ' + meta.dbVersion + ' / 游戏 ' + meta.gameVersion + ' · ' + meta.license;
});

check('③ 已知 id 的名字与端口（真机语义的直接依据）', () => {
  const one = nodeById(297);
  assert(one, 'id=297 没找到');
  eq(one.zh, '添加单位状态', '中文名');
  eq(one.identifier, 'Execution.Unit_Status.Add_Status', '标识符');
  eq(one.system, 'Server', '系统');
  const labels = one.pins.map((p) => p.label);
  for (const need of ['施加者实体', '施加目标实体', '单位状态配置ID', '施加层数', '单位状态参数字典']) {
    assert(labels.includes(need), '缺端口：' + need);
  }
  const flow = one.pins.filter((p) => p.flow).map((p) => p.dir);
  eq(flow, ['in', 'out'], '执行流端口');
  return one.zh + '（' + labels.length + ' 个标签，含执行流 in/out）';
});

check('④ 搜「玩家实体 / 角色实体 / 单位状态 / 职业」都能出官方节点名', () => {
  eq(searchNodes({ q: '玩家实体' }).total, 4, '玩家实体');
  eq(searchNodes({ q: '角色实体' }).total, 2, '角色实体');
  eq(searchNodes({ q: '单位状态' }).total, 10, '单位状态');
  eq(searchNodes({ q: '职业' }).total, 8, '职业');
  const p = searchNodes({ q: '玩家实体', limit: 5 }).rows.map((n) => n.id);
  assert(p.includes(248) && p.includes(259), '玩家实体那两条没出来：' + JSON.stringify(p));
  return '玩家实体 4 / 角色实体 2 / 单位状态 10 / 职业 8';
});

check('⑤ 搜索：多词 = AND、完全相等排最前、limit 夹紧、分类/系统过滤生效', () => {
  const multi = searchNodes({ q: '获取 实体', limit: 50 }).rows;
  assert(multi.length > 0, '多词 AND 没结果');
  assert(multi.every((n) => (n.zh + n.en + n.identifier).includes('获取') || (n.zh + n.en + n.identifier).includes('实体')), '多词过滤不对');
  eq(searchNodes({ q: '打印字符串', limit: 3 }).rows[0].id, 1, '完全相等的应排第一');
  eq(searchNodes({ limit: 5 }).returned, 5, 'limit');
  eq(searchNodes({ limit: 9999 }).returned, 200, 'limit 上限夹到 200');
  const srv = searchNodes({ q: '状态', system: 'Server', limit: 200 }).rows;
  assert(srv.every((n) => n.system === 'Server'), 'system 过滤失效');
  const qry = searchNodes({ domain: 'Query', limit: 200 }).rows;
  assert(qry.length > 0 && qry.every((n) => n.domain === 'Query'), 'domain 过滤失效');
  return 'AND/排序/夹紧/过滤 都对（Query ' + qry.length + ' 条）';
});

check('⑥ 分类清单（facets）与词典自洽', () => {
  const f = nodeDbFacets();
  const sum = Object.values(f.domains).reduce((a, b) => a + b, 0);
  eq(sum, f.total, '分类计数之和 = 总数');
  eq(f.total, 558, '总数');
  eq(f.server + f.client, 558, '服务端+客户端 = 总数');
  return Object.keys(f.domains).length + ' 个分类';
});

check('⑦ **老实说清"对不上"**：.gil 里那种关卡内分配的声明号，词典里查不到', () => {
  const meta = nodeDbMeta();
  assert(meta.unverified.some((s) => s.includes('不是一套')), 'unverified 里没写"与 .gil 的号不是一套"');
  // 真机见过的几个声明号，词典必须查不到（查到了反而说明我上面的结论错了）
  for (const id of [1073741843, 1073741904, 1610612737, 260128]) {
    assert(nodeById(id) === null, '词典里竟然有 ' + id + ' —— 那"不是一套"的结论要重写');
  }
  return 'unverified 有说明 + 4 个真机声明号确实查不到';
});

check('⑧ 产物与生成器同步（有上游 4.1MB 库时才算；没有就如实跳过）', () => {
  const ref = 'C:/Users/Administrator/Desktop/yuanshen/参考项目/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack-main/utils/node_data/data.json';
  if (!fs.existsSync(ref)) return '跳过：本机没有上游库（只读参考，不在仓库里）';
  const d = JSON.parse(fs.readFileSync(ref, 'utf8'));
  const db = loadNodeDb();
  eq(db.nodes.length, d.Nodes.length, '节点数与上游不符（该重跑 tools/gen-nodedb.mjs 了）');
  const src = d.Nodes.find((n) => n.ID === 297);
  eq(nodeById(297).identifier, src.Identifier, 'id=297 的标识与上游不符');
  return '与上游 ' + d.Version + ' 同步（' + d.Nodes.length + ' 条）';
});

check('⑨ 只读 + 不联网：读完产物逐字节未变，源码里没有网络/写盘', () => {
  const after = { sha: crypto.createHash('sha256').update(fs.readFileSync(DB_FILE)).digest('hex'), mtime: fs.statSync(DB_FILE).mtimeMs };
  eq(after.sha, before.sha, '词典文件被改了');
  eq(after.mtime, before.mtime, 'mtime 变了');
  const src = fs.readFileSync(path.join(PKG, 'lib', 'nodedb.mjs'), 'utf8');
  for (const bad of ['fetch(', 'http://', 'https://', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'mkdirSync']) {
    assert(src.indexOf(bad) < 0, '词典读取层出现了不该有的东西：' + bad);
  }
  // 缓存要真的生效（同一个文件重复调用不重复读盘）
  const a = loadNodeDb(); const b = loadNodeDb();
  assert(a === b, '缓存没生效（两次调用返回了不同对象）');
  return '逐字节未变 + 无网络/写盘 + 缓存生效';
});

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) { console.log('====== 失败明细 ======'); failures.forEach((f) => console.log(' ✗ ' + f)); process.exitCode = 1; }
