/**
 * `miliastra_code op=preflight` 验收 —— AI 易用性反馈（2026-09-30）第 1/7/12 条的落地断言。
 *
 * 那份反馈的核心痛点：**每改一次脚本要手动跑 6 处检查**（结构 lint / 作用域 / 风格 / 全局写 / 图源 / 括号配平），
 * 而"最要紧的语法"哪都没有 ⇒ 一轮里 3 次语法错全部漏到真机前才发现，
 * 因为**「deploy 成功」被当成了「语法正确」**。
 *
 * 这里钉住四件事：
 *   ① 真语法错 ⇒ `preflight` 报 `ok:false` + 行号 + "别部署"；
 *   ② **如实自述边界**：作用域 / 风格基线两项回 `ok:null`（判不了就写判不了，**不猜**）；
 *   ③ 全局写 / 图片无图源两条各自的判据真的生效；
 *   ④ `summaryOnly` 去体积不去结论；零输入**不许绿**。
 *
 * 跑法：node tests/preflight-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../index.js';

const code = TOOLS.find((t) => t.name === 'miliastra_code');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-preflight-'));
let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✅ ' + label + (detail ? '  → ' + detail : '')); return; }
  failures.push(label);
  console.log('❌ ' + label + (detail ? '  → ' + detail : ''));
}

const GOOD = [
  '-- 干净脚本',
  'local note = "中文注释保持编码"',
  'local function tick(dt)',
  '    return dt',
  'end',
  'return tick',
  '',
].join('\n');
const BAD_SYNTAX = [
  '-- 缺逗号（真实事故那一类）',
  'local CFG = {',
  '    A = 1',
  '    B = 2',
  '}',
  'return CFG',
  '',
].join('\n');
const BAD_GLOBAL = [
  '-- 运行期给全局赋值（真机上不生效）',
  'local n = 0',
  'local function tick(dt)',
  '    started = true',
  '    n = n + dt',
  '    return n',
  'end',
  'return tick',
  '',
].join('\n');
const BAD_IMAGE = [
  '-- 建了图片控件却一处 SetImage 都没有（真机渲染成 ?）',
  'local function build()',
  '    local c = game.InstantiateClientUIControl(1073741849, script.object)',
  '    return c',
  'end',
  'return build',
  '',
].join('\n');

const dir = path.join(tmp, 'proj');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '干净.lua'), GOOD, 'utf8');
fs.writeFileSync(path.join(dir, '缺逗号.lua'), BAD_SYNTAX, 'utf8');
fs.writeFileSync(path.join(dir, '全局写.lua'), BAD_GLOBAL, 'utf8');
fs.writeFileSync(path.join(dir, '无图源.lua'), BAD_IMAGE, 'utf8');
const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });

/* ---------------------------------------------------------------- ① 语法 */

const all = await code.execute({ op: 'preflight', dir }, {});
ok('①a 有不过的文件 ⇒ `ok:false`，且 `verdict` 明说"别部署"',
  all.ok === false && /别部署/.test(all.verdict), all.verdict);
ok('①b 报告里点出是哪几个文件不过',
  all.fileCount === 4 && /缺逗号/.test(all.verdict), all.verdict);

/*
 * ⚠️ 行号期望 **4**（不是 3）：fengari 报的是"它卡在哪一行"——
 *   本夹具 line1 注释 / line2 `local CFG = {` / line3 `A = 1` / line4 `B = 2`
 *   ⇒ 缺的是 line3 末尾那个逗号，报错落在 **line4**（`'}' expected (to close '{' at line 2) near 'B'`）。
 *   第一次我按"直觉"写了 3，被自己的测试打回来 —— 这也说明「按事实钉，别按感觉钉」。
 */
const sf = (all.files || []).find((f) => f.file === '缺逗号.lua');
ok('①c 语法错的文件：`Lua 语法` 那一项 `ok:false` **且带行号**（第 4 行）', (() => {
  if (!sf) return false;
  const c = sf.checks.find((x) => /Lua 语法/.test(x.item));
  return c && c.ok === false && c.line === 4 && /expected/.test(String(c.why));
})(), sf ? JSON.stringify(sf.checks.find((x) => /Lua 语法/.test(x.item))).slice(0, 140) : '没有那一行');

ok('①d 干净文件：可判定项全过 ⇒ 该文件 verdict 是"可以部署"', (() => {
  const g = (all.files || []).find((f) => f.file === '干净.lua');
  return g && g.failedCount === 0 && /可以部署/.test(g.verdict);
})());

/* ---------------------------------------------------------------- ② 如实自述边界 */

ok('②a 作用域 / 风格基线两项回 **`ok:null`**（判不了就写判不了，不猜）', (() => {
  const g = (all.files || []).find((f) => f.file === '干净.lua');
  const scope = g.checks.find((x) => /作用域/.test(x.item));
  const style = g.checks.find((x) => /风格基线/.test(x.item));
  return scope.ok === null && style.ok === null
    && /check-lua-scope\.mjs/.test(scope.why) && /check-lua-style\.mjs/.test(style.why);
})());

ok('②b 顶层把"查了什么/没查什么"写成两张清单（`checkedItems` / `notCheckedItems`）',
  Array.isArray(all.checkedItems) && all.checkedItems.some((x) => /语法/.test(x))
  && Array.isArray(all.notCheckedItems) && all.notCheckedItems.some((x) => /作用域/.test(x)),
  'checked=' + all.checkedItems.length + ' / notChecked=' + all.notCheckedItems.length);

ok('②c `readOnly:true`（这个 op 不写盘、不部署）', all.readOnly === true);

/* ---------------------------------------------------------------- ③ 两条判据真的生效 */

const gf = (all.files || []).find((f) => f.file === '全局写.lua');
ok('③a 全局写被抓到（第 4 行 `started = true`）', (() => {
  if (!gf) return false;
  const c = gf.checks.find((x) => /全局写/.test(x.item));
  return c && c.ok === false && c.line === 4 && Array.isArray(c.hits) && c.hits.some((h) => h.name === 'started');
})(), gf ? JSON.stringify(gf.checks.find((x) => /全局写/.test(x.item))).slice(0, 120) : '没有那一行');

const imf = (all.files || []).find((f) => f.file === '无图源.lua');
ok('③b 图片无图源被抓到（`InstantiateClientUIControl` 却无 `SetImage`）', (() => {
  if (!imf) return false;
  const c = imf.checks.find((x) => /图片有图源/.test(x.item));
  return c && c.ok === false && /SetImage/.test(String(c.why));
})(), imf ? JSON.stringify(imf.checks.find((x) => /图片有图源/.test(x.item))).slice(0, 120) : '没有那一行');

ok('③c `local` 变量不会被误报成全局写（干净文件那条为 `ok:true`）', (() => {
  const g = (all.files || []).find((f) => f.file === '干净.lua');
  return g.checks.find((x) => /全局写/.test(x.item)).ok === true;
})());

/* ---------------------------------------------------------------- ④ 体积与零输入 */

const slim = await code.execute({ op: 'preflight', dir, summaryOnly: true }, {});
ok('④a `summaryOnly` 去体积不去结论（逐条 `checks` 正文省掉、结论字段全在）', (() => {
  const s = (slim.files || []).find((f) => f.file === '缺逗号.lua');
  const f = (all.files || []).find((x) => x.file === '缺逗号.lua');
  return slim.ok === false && /别部署/.test(slim.verdict)
    && s && s.failedCount === f.failedCount && Array.isArray(s.failed) && s.checks === undefined
    && JSON.stringify(slim).length < JSON.stringify(all).length;
})(), 'full=' + JSON.stringify(all).length + 'B / slim=' + JSON.stringify(slim).length + 'B');

const empty = await code.execute({ op: 'preflight', dir: emptyDir }, {});
ok('④b **零输入不许绿**：目录里没有 .lua ⇒ `ok:false` + `noInput` + 说清为什么',
  empty.ok === false && empty.noInput === true && /什么都没验/.test(empty.verdict), empty.verdict);

const one = await code.execute({ op: 'preflight', dir, files: [path.join(dir, '干净.lua')] }, {});
ok('④c 点名一个文件 ⇒ 只查它（`files` 走绝对路径），结论"可以部署"',
  one.ok === true && one.fileCount === 1 && /可以部署/.test(one.verdict), one.verdict);

ok('④d 结构化：每个文件都带 `checks[]`、`failedCount`、`unknownCount`、`verdict`',
  (all.files || []).every((f) => Array.isArray(f.checks) && typeof f.failedCount === 'number'
    && typeof f.unknownCount === 'number' && typeof f.verdict === 'string'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log('结果：通过 ' + pass + '，失败 ' + failures.length);
process.exit(failures.length ? 1 : 0);
