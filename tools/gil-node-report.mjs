#!/usr/bin/env node
/**
 * tools/gil-node-report.mjs —— 把 `.gil` 里的**节点图事实**导成一份可读的 Markdown 报告（**只读**）。
 *
 * ★ 为什么要有它：面板第 7 页能一层层点着看，但**人要的是"拿在手里能翻、能搜、能贴"**的那一份
 *   （作者 2026-10-01 的顺序：工具 → GUI → **离线报告**）。报告正文由 `lib/gilreport.mjs`（纯函数）编，
 *   这里只管三件事：**定位 .gil → 读 → 原子写**。
 *
 * ★ 三条安全约定：
 *   ① 全程**只读** `.gil`（`readGilNodeFacts`），一个字节都不写地图、不碰任何活文件；
 *   ② 写报告走 `lib/fsx.mjs` 的 `atomicWriteFile`（同目录 tmp + fsync + rename），**覆盖前不删旧的**；
 *   ③ **同名关卡可能在多个账号下都有 `.gil`**（本机实测 1073741829 有 4 份，大小从 17 KB 到 3.7 MB）——
 *      这种情况**不猜**：报错 + 列出候选，让人用 `--path` 或 `--account` 指定。
 *
 * 用法：
 *   node tools/gil-node-report.mjs --level 1073741829 --out "D:\...\docs\节点图报告-1073741829.md"
 *   node tools/gil-node-report.mjs --path "C:\...\1073741829\1073741829.gil" --out report.md
 *   node tools/gil-node-report.mjs --level 1073741829 --account 201170108 --out report.md
 *   node tools/gil-node-report.mjs --level 1073741829 --dry-run        # 只报统计 + 候选，不写盘
 *   可选：--summary-only（不要逐图明细）· --max-nodes-per-graph N · --max-graphs N · --quiet
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readGilNodeFacts } from '../lib/gilnodes.mjs';
import { buildNodeReport, reportStats, statsFingerprint } from '../lib/gilreport.mjs';
import { scanLevels, findLevel } from '../lib/locate.mjs';
import { atomicWriteFile } from '../lib/fsx.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes('--' + name);
const numOf = (name) => {
  const v = argOf(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

if (has('help') || argv.includes('-h')) {
  console.log('用法: node tools/gil-node-report.mjs --level <关卡ID> | --path <gil> [--out <文件>] [--account <账号>]');
  console.log('      --summary-only · --max-nodes-per-graph N · --max-graphs N · --dry-run · --quiet');
  console.log('      --check：只核对"已有报告还准不准"（不写盘；数字变了就退出码 1 并让你重跑）');
  process.exit(0);
}

/** 行数（按"文件有几行"算：结尾那个换行不算新的一行 —— 别把 3805 报成 3806）。 */
const lineCount = (s) => { const a = String(s).split('\n'); return a.length - (a[a.length - 1] === '' ? 1 : 0); };

/** 定位 `.gil`：`--path` 优先；`--level` 走扫档（多个账号命中就报错不猜）。 */
function resolveGil() {
  const p = argOf('path');
  if (p) {
    if (!fs.existsSync(p)) throw new Error('--path 指的 .gil 不存在：' + p);
    return { gilPath: path.resolve(p), levelId: path.basename(p).replace(/\.gil$/i, ''), via: '--path' };
  }
  const want = argOf('level');
  if (!want) throw new Error('要给 --level <关卡ID> 或 --path <.gil 绝对路径>（不知道给哪个就先跑 miliastra_health）');
  const all = scanLevels();
  const hits = all.filter((l) => l.levelId === String(want) && l.gil && l.gil.path);
  if (!hits.length) throw new Error('扫不到关卡 ' + want + ' 的 .gil（扫到 ' + all.length + ' 个关卡）');
  const acc = argOf('account');
  if (acc) {
    const one = hits.find((l) => l.accountId === String(acc));
    if (!one) throw new Error('账号 ' + acc + ' 下没有关卡 ' + want + ' 的 .gil；候选账号：' + hits.map((l) => l.accountId).join(' / '));
    return { gilPath: one.gil.path, levelId: one.levelId, accountId: one.accountId, via: '--level+--account' };
  }
  const uniq = new Map(hits.map((l) => [l.gil.path, l]));
  if (uniq.size > 1) {
    const lines = hits.map((l) => '   · 账号 ' + l.accountId + '　' + l.gil.size + ' B　' + l.gil.mtime + '　' + l.gil.path);
    throw new Error('关卡 ' + want + ' 在 **' + uniq.size + ' 处**都有 .gil —— 我不猜是哪张，请指定其中一个：\n'
      + lines.join('\n') + '\n   用法：加 --account <账号ID>，或直接 --path "<上面某一条路径>"');
  }
  const lv = hits[0];
  // 顺带核一下 `findLevel` 的选择是不是同一个（两处口径不一致就是 bug，宁可当场炸）
  const alt = findLevel(all, want);
  if (alt && alt.gil && alt.gil.path !== lv.gil.path) {
    throw new Error('findLevel 与本次选择不一致（' + alt.gil.path + ' ≠ ' + lv.gil.path + '）—— 请用 --path 明确指定');
  }
  return { gilPath: lv.gil.path, levelId: lv.levelId, accountId: lv.accountId, via: '--level' };
}

let target;
try {
  target = resolveGil();
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}

const facts = readGilNodeFacts(target.gilPath, {});
if (!facts.ok) {
  console.error('✗ 解析失败：' + facts.error + '（' + target.gilPath + '）');
  process.exit(1);
}
const st = reportStats(facts);
const fingerprint = statsFingerprint(st);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target.gilPath)).digest('hex');

const outArg = argOf('out');
const command = 'node tools/gil-node-report.mjs --level ' + target.levelId
  + (target.accountId ? ' --account ' + target.accountId : '')
  + ' --out "' + (outArg || '<报告路径>') + '"'
  + (has('summary-only') ? ' --summary-only' : '')
  + (numOf('max-nodes-per-graph') ? ' --max-nodes-per-graph ' + numOf('max-nodes-per-graph') : '')
  + (numOf('max-graphs') ? ' --max-graphs ' + numOf('max-graphs') : '');

const md = buildNodeReport(facts, {
  levelId: target.levelId,
  gilPath: target.gilPath,
  sha256,
  generatedAt: new Date().toISOString(),
  command,
  fingerprint,
  summaryOnly: has('summary-only'),
  maxNodesPerGraph: numOf('max-nodes-per-graph'),
  maxGraphs: numOf('max-graphs'),
});

if (!has('quiet')) {
  console.log('关卡        : ' + target.levelId + (target.accountId ? '（账号 ' + target.accountId + '）' : '')
    + '　·　定位方式 ' + target.via);
  console.log('来源        : ' + target.gilPath);
  console.log('大小 / sha  : ' + facts.size + ' B　' + sha256.slice(0, 16) + '…');
  console.log('读数        : 图 ' + st.graphCount + ' 张（能取到节点列表 ' + st.graphWithNodes + '）· 节点 ' + st.nodeCount
    + ' 个 · 出边 ' + st.edgeCount + ' 条 · 官方名命中 ' + st.namedCount + '/' + st.nodeCount
    + ' · 坐标(x,y 都有) ' + st.xyBoth + '（任一有 ' + st.xyAny + '）· 引脚实例 ' + st.pinCount);
  console.log('实体/变量   : ' + st.entityCount + ' / ' + st.totalVariables + '　元件 ' + st.componentCount
    + '　节点声明 ' + st.declarationCount + '（复合 ' + st.compositeCount + '）　配置条目 ' + st.configCount
    + '　信号引用 ' + st.signalRefCount);
  console.log('数据指纹    : ' + fingerprint.slice(0, 16) + '…（--check 拿它判"该不该重跑"）');
  if (st.xyOnlyX || st.xyOnlyY) {
    console.log('坐标单边    : 只存了 x 的 ' + st.xyOnlyX + ' 个 · 只存了 y 的 ' + st.xyOnlyY
      + ' 个（`.gil` 里就只有那一个字段 ⇒ 数据事实，不是漏读）');
  }
  if (st.duplicateGraphNames.length) {
    console.log('⚠️ 同名图    : ' + st.duplicateGraphNames.join(' / ')
      + ' —— 读取层按图名做键，报告里这两条会指向同一份节点列表（`.gil` 里它们是两条图记录）');
  }
}

/*
 * `--check`：**只判"该不该重跑"，不写盘**（复核 2026-10-01 第 6 节那条建议的落地）。
 * 判据不是"文件动过没有"，而是**"现在重跑一遍，数字还一样吗"** ⇒ 比 `.gil` 的 sha 更严：
 * 读取层改了（哪怕 `.gil` 一个字节没变）只要数字变了，这里就会报"该重跑"。
 */
if (has('check')) {
  if (!outArg) {
    console.error('✗ --check 要配合 --out <已有报告> 用（否则不知道该核对哪一份）');
    process.exit(1);
  }
  const p = path.resolve(outArg);
  if (!fs.existsSync(p)) {
    console.error('✗ --check：报告不存在：' + p + '（那就直接跑一次生成，别传 --check）');
    process.exit(1);
  }
  const old = fs.readFileSync(p, 'utf8');
  const m = /数据指纹：`([0-9a-f]{64})`/.exec(old);
  const oldLevel = (/^# 节点图报告 · 关卡 ([^\s]+)/m.exec(old) || [])[1] || null;
  if (!m) {
    console.error('✗ --check：这份报告里**没有数据指纹**（是旧版工具生成的）⇒ 建议重跑一次');
    console.error('  报告：' + p);
    process.exit(1);
  }
  const same = m[1] === fingerprint && (!oldLevel || oldLevel === String(target.levelId));
  if (same) {
    console.log('\n✅ --check：报告**仍然有效**（同一份 .gil + 同一个读取层 ⇒ 数字一个没变）');
    console.log('   报告：' + p + '　数据指纹 ' + fingerprint.slice(0, 16) + '…');
    process.exit(0);
  }
  console.error('\n✗ --check：**该重跑了** —— 现在重跑算出来的数字与报告里那份不一致');
  console.error('   报告里的指纹：' + m[1].slice(0, 16) + '…'
    + (oldLevel && oldLevel !== String(target.levelId) ? '（报告是关卡 ' + oldLevel + ' 的）' : ''));
  console.error('   现在的指纹  ：' + fingerprint.slice(0, 16) + '…（关卡 ' + target.levelId + '）');
  console.error('   重跑：' + command);
  process.exit(1);
}

if (has('dry-run') || !outArg) {
  const lines = lineCount(md);
  console.log(has('dry-run') ? '\n（--dry-run：正文 ' + lines + ' 行 / '
    + Buffer.byteLength(md) + ' 字节，**没有写盘**）' : '\n（没给 --out：只报统计，正文 ' + lines
    + ' 行 / ' + Buffer.byteLength(md) + ' 字节，**没有写盘**）');
  process.exit(0);
}

const out = path.resolve(outArg);
try {
  atomicWriteFile(out, Buffer.from(md, 'utf8'));
} catch (e) {
  console.error('✗ 写报告失败：' + ((e && e.message) || e));
  process.exit(1);
}
const head = [...fs.readFileSync(out).slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
console.log('\n✅ 报告已写：' + out);
console.log('   ' + lineCount(md) + ' 行 / ' + Buffer.byteLength(md) + ' 字节　前 3 字节 ' + head
  + (head === 'ef bb bf' ? '（⚠️ 带 UTF-8 BOM —— 不该发生，请上报）' : '（无 BOM ✅）'));
