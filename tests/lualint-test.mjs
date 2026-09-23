/**
 * lualint 自测：**语法错的 Lua 投进沙箱会静默不生效**（脚本根本没起来，日志里什么都没有），
 * 所以部署前必须扫一遍结构。这里分三组断言：
 *
 *   ① 合法构造一律**不报错**（误报会挡住正常部署，比漏报更烦人）
 *   ② 明显写坏的**必须报错**，且报出问题行号
 *   ③ 真实文件回归：`../../code/**\/*.lua` 全部结构正常
 *
 * 用法：node tests/lualint-test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintLua, lintSummary, stripCommentsAndStrings } from '../lib/lualint.mjs';

let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const ok = (src, why) => {
  const r = lintLua(src);
  assert(r.ok, `${why}：被误判为错 —— ${lintSummary(r)}`);
  return `${r.stats.lines} 行`;
};
const bad = (src, why, wantLine) => {
  const r = lintLua(src);
  assert(!r.ok, `${why}：应当报错却通过了`);
  if (wantLine != null) {
    assert(r.problems.some((p) => p.line === wantLine), `${why}：期望行号 L${wantLine}，实际 ${JSON.stringify(r.problems)}`);
  }
  return lintSummary(r);
};

console.log('— 组 1：合法构造不得误报 —');

check('单行 if/end', () => ok('if a then b = 1 end', '单行 if'));
check('多行 function/end', () => ok('local function f()\n  return 1\nend\n', 'function'));
check('嵌套 if + for do', () => ok('for i = 1, 3 do\n  if i > 1 then\n    x = i\n  end\nend\n', '嵌套'));
check('while / repeat-until', () => ok('while true do break end\nrepeat x = 1 until x == 1\n', 'while/repeat'));
check('elseif 不算开块（少减会误报）', () => ok('if a then\n  x = 1\nelseif b then\n  x = 2\nelse\n  x = 3\nend\n', 'elseif'));
check('pcall(function() … end) 闭包', () => ok('local ok = pcall(function() x = 1 end)\n', '闭包'));
check('行注释里的 end/function', () => ok('-- end function do if\nif a then end\n', '行注释'));
check('长注释里的 end/function', () => ok('--[[ end function do if ]]\nif a then end\n', '长注释'));
check('长注释带等号层级 --[==[ ]==]', () => ok('--[==[ end function ]==]\nif a then end\n', '带等号长注释'));
check('短字符串里的 end/function', () => ok('local s = "end function do"\nif a then end\n', '短字符串'));
check('单引号字符串里的 end', () => ok("local s = 'end function'\nif a then end\n", '单引号'));
check('转义引号不提前收尾', () => ok('local s = "a\\" end function"\nif a then end\n', '转义引号'));
check('长字符串 [[ ]] 里的 end', () => ok('local s = [[end function]]\nif a then end\n', '长字符串'));
check('注释里的未配对括号不误报', () => ok('-- 这里有 ( 和 [ 和 {\nif a then end\n', '注释括号'));

// ★ 这条是真实事故的回归：旧实现把换行直接丢掉，导致「行尾词 + 下一行行首词」粘成一个标识符。
//   例：`local x, y` 换行接 `local` → `ylocal`，行首的 `end` 被吞进上一行尾巴，
//   于是真文件恒报「缺 29 个 end」，而单行小样例却全绿。
check('★ 换行不粘连：行尾标识符 + 下一行行首 end', () => ok('local function f(v)\n  return v\nend\n', 'return v 换行 end'));
check('★ 换行不粘连：行尾标识符 + 下一行行首 function', () => ok('local a = 1\nlocal function f()\n  return a\nend\n', '1 换行 local function'));
check('★ 换行不粘连：连续多行声明后接 end', () => ok('if t then\n  local x, y\n  local z = 0\nend\n', '声明行尾接 end'));
check('CRLF 换行同样不粘连', () => ok('local function f(v)\r\n  return v\r\nend\r\n', 'CRLF'));
check('剥离器保留换行占位（位置不粘连）', () => {
  const { code } = stripCommentsAndStrings('local sx, sy\nlocal a = 1\n');
  assert(!code.includes('sylocal'), '换行被丢，词被粘连：' + JSON.stringify(code));
  return 'ok';
});

console.log('\n— 组 2：写坏的必须报错 —');

check('缺 end 报错，且报的是**开块那一行**', () => bad('if a then\n  x = 1\n', '缺 end', 1));
check('缺 end 报错：多行注释后仍定位到 if 自己那行', () => bad('-- 说明\n-- 说明\nif a then\n  x = 1\n', '缺 end 定位', 3));
check('多一个 end 报错', () => bad('if a then end end\n', '多 end', 1));
check('函数体缺 end', () => bad('local function f()\n  return 1\n', '函数缺 end', 1));
check('括号没闭合', () => bad('local t = (1 + 2\n', '未闭合括号', 1));
check('多一个右括号', () => bad('local t = 1)\n', '多余右括号', 1));
check('方括号不匹配', () => bad('local t = [1, 2)\n', '括号错配', 1));
check('短字符串没闭合', () => bad('local s = "abc\n', '未闭合字符串', 1));
check('长注释没闭合', () => bad('--[[ 注释没关\nx = 1\n', '未闭合长注释', 1));
check('长字符串没闭合', () => bad('local s = [[abc\n', '未闭合长括号', 1));
check('repeat 少了 until', () => bad('repeat\n  x = 1\n', 'repeat 缺 until', 1));
check('if 被 until 关（类型错配）', () => {
  const r = lintLua('if a then\n  x = 1\nuntil b\n');
  assert(!r.ok, '应当报错却通过了');
  assert(r.problems.some((p) => /第 1 行的 if 应当由 end 关闭/.test(p.message)), '消息没点名是第 1 行的 if：' + JSON.stringify(r.problems));
  return lintSummary(r);
});

console.log('\n— 组 3：真实文件回归 —');

const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'code');
if (!fs.existsSync(codeDir)) {
  check('真实 Lua 目录存在', () => { throw new Error('找不到 ' + codeDir); });
} else {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
    else if (p.endsWith('.lua')) files.push(p);
  };
  walk(codeDir);
  assert(files.length > 0, 'code/ 下没找到 .lua');
  let badFiles = 0;
  for (const f of files.sort()) {
    const txt = fs.readFileSync(f, 'utf8');
    const r = lintLua(txt);
    if (!r.ok) { badFiles += 1; failures.push(path.basename(f) + ': ' + lintSummary(r)); }
  }
  check(`真实文件全部结构正常（${files.length} 个）`, () => {
    assert(badFiles === 0, badFiles + ' 个文件被误判：' + failures.slice(-badFiles).join(' | '));
    return files.length + ' 个文件（含 ' + Math.max(...files.map((f) => fs.readFileSync(f, 'utf8').split('\n').length)) + ' 行的大文件）';
  });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { console.log('\n失败明细：'); for (const f of failures.slice(0, 12)) console.log('  · ' + f); }
process.exitCode = fail ? 1 : 0;
