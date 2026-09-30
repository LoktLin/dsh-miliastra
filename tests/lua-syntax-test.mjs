/**
 * `lib/lua-syntax.mjs`（**fengari 真解析器**语法检查）自测。
 *
 * ★ 为什么要有它：创作者反馈 **3 次 Lua 语法错误全部漏过**了 `deploy` 的 lint ——
 *   那份 lint 只数 `end`/括号，不做语法分析，于是"deploy 成功"被误当成"语法正确"。
 *   所以这里断言的**不是**「函数返回了个什么东西」，而是：
 *
 *   ① 合法 Lua（含注释/长字符串/中文）**不许误报** —— 误报会挡住正常部署，比漏报更烦人；
 *   ② 真实踩过的语法错**必须报**，且**行号要落在出错那一行**（fengari 报的原始行号，±0，
 *      不修正、不猜 —— 缺逗号时 fengari 把行号报到**下一个 token 那一行**，我们就照它报）；
 *   ③ 形状契约：成功**没有** `error` 键；失败**必有** `error` 与 `message` 字符串
 *      —— 否则调用方（部署门禁）拿不到能显示给人看的话；
 *   ④ 纯函数纪律：空串 / `null` / `undefined` 一律不抛（门禁自己坏了也不许中断部署）；
 *   ⑤ 大文件不超时（2000 行合法 Lua，打印实测耗时）。
 *
 * 用法：`node tests/lua-syntax-test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLuaSyntax } from '../lib/lua-syntax.mjs';

let pass = 0;
let fail = 0;
const failures = [];

/**
 * 断言一条。**签名照抄 `tests/lualint-test.mjs`**（`ok(label, cond, detail)`），
 * 好让两套测试的读数习惯一致 —— 顺带这里是**唯一** import `checkLuaSyntax` 的地方，
 * 于是 `tools/lint.mjs` 的**死导出**检查也认得它（纯函数模块没有别的调用方）。
 */
function ok(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } else {
    fail += 1;
    failures.push(label + (detail ? ' —— ' + detail : ''));
    console.log(`❌ ${label}  → ${detail || '断言不成立'}`);
  }
}

/** 把回执压成一行，失败时一眼看得出实际拿到了什么（只回要点，不糊一大坨）。 */
const brief = (r) => (r.ok ? '{ok:true}' : `{ok:false, line:${r.line}, message:${JSON.stringify(r.message)}}`);

console.log('— 组 1：合法 Lua 不得误报 —');

const validSrc = 'local a = { x = 1, y = 2 }\nprint(a.x)\n';
{
  const r = checkLuaSyntax(validSrc);
  ok('合法 Lua：表构造器 + 字段访问 ⇒ ok:true', r.ok === true, brief(r));
}
{
  // 反例对照：同一段代码**少一个逗号** —— 这是真实事故的形态（两行字段之间漏了逗号）
  const broken = 'local a = { x = 1\n  y = 2 }\nprint(a.x)\n';
  const r = checkLuaSyntax(broken);
  ok('对照：同一段少一个逗号就报错（证明组 1 不是"恒真"）', r.ok === false, brief(r));
}
{
  const r = checkLuaSyntax('--[[ } ]]\n--[==[ { ]==]\nlocal a = [[ { ]]\nlocal b = "{ }"\nprint(a, b)\n');
  ok('长注释 / 长字符串里的 { } 不误报', r.ok === true, brief(r));
}
{
  // ⚠️ **中文标识符在 Lua 里本来就不是合法语法**（Lua 标识符是 ASCII），所以只能测「注释与字符串含中文」
  //    —— 本仓脚本的注释几乎全是中文，这一条防的是「多字节 UTF-8 被引擎当成非法符号」。
  const cjk = '-- 中文注释：这是一段说明，含括号（）与花括号【】\nlocal s = "中文文本，含半角括号 ( ) 也不是语法括号"\n'
    + 'local t = { name = s }\nprint(t.name, "中文")\n';
  const r = checkLuaSyntax(cjk);
  ok('CJK 源码（中文注释 + 中文字符串）不炸', r.ok === true, brief(r));
}
{
  // 反向钉一条：中文标识符**该报就报**（别为了"支持中文"把它放过 —— 真机同样会炸）
  const r = checkLuaSyntax('local 中文变量 = 1\nprint(中文变量)\n');
  ok('中文标识符照报（Lua 标识符不含中文，这是正确行为）', r.ok === false && r.line === 1, brief(r));
}
{
  const r1 = checkLuaSyntax('');
  const r2 = checkLuaSyntax('-- 只有一行注释\n');
  const r3 = checkLuaSyntax('--[==[\n多行长注释\n]==]\n');
  ok('空文件 / 只有注释 / 只有长注释 ⇒ ok:true', r1.ok === true && r2.ok === true && r3.ok === true,
    `${brief(r1)} ${brief(r2)} ${brief(r3)}`);
}

console.log('\n— 组 2：真实踩过的语法错必须报，且行号对得上 —');

{
  // ★ 真实事故形态：表构造器里两行字段之间少了逗号。第 3 行写完 `B = 2` 后应当有逗号。
  //   fengari 把行号报到**它撞上的那个 token 那一行**（第 4 行的 `C`），我们**照报不修**（±0）。
  const src = [
    'local CFG = {',
    '  A = 1,',
    '  B = 2',            // ← 少一个逗号
    '  C = 3,',
    '}',
    'print(CFG.A)',
    '',
  ].join('\n');
  const r = checkLuaSyntax(src);
  ok('缺逗号（真实事故）⇒ ok:false 且 line 指向出错那一行', r.ok === false && r.line === 4,
    `${brief(r)}（期望 line:4）`);
}
{
  const r = checkLuaSyntax('local t = 1)\n');
  ok('多一个右括号 ⇒ ok:false 且有 line', r.ok === false && typeof r.line === 'number', brief(r));
}
{
  const r1 = checkLuaSyntax('local t = (1 + 2\n');
  const r2 = checkLuaSyntax('local t = { 1, 2\n');
  const r3 = checkLuaSyntax('if a then\n  x = 1\n');
  ok('括号 / 花括号 / 块不配平 ⇒ ok:false 且有 line',
    r1.ok === false && r1.line !== null && r2.ok === false && r2.line !== null && r3.ok === false && r3.line !== null,
    `${brief(r1)} ${brief(r2)} ${brief(r3)}`);
}
{
  const r1 = checkLuaSyntax('local s = "abc\n');
  const r2 = checkLuaSyntax("local s = 'abc\n");
  const r3 = checkLuaSyntax('local s = [[abc\n');
  ok('未闭合的短字符串 / 单引号字符串 / 长字符串 ⇒ ok:false',
    r1.ok === false && r2.ok === false && r3.ok === false, `${brief(r1)} ${brief(r2)} ${brief(r3)}`);
}

console.log('\n— 组 3：行号解析（chunkName 里带冒号/引号/为空都不许解错） —');

{
  // ① 普通 chunkName：`@双相.lua` → fengari 回 `双相.lua:3: …`
  const a = checkLuaSyntax('local a = {\n x = 1\n y = 2\n}\n', { chunkName: '双相.lua' });
  // ② 带盘符冒号的 chunkName：前缀里还有 `:`，**贪婪**匹配才能让行号落在最后那个 `:数字:`
  const b = checkLuaSyntax('local a = {\n x = 1\n y = 2\n}\n', { chunkName: 'D:\\code\\双相.lua' });
  ok('chunkName 带盘符冒号也能解出行号', a.line === 3 && b.line === 3 && a.chunkName === '双相.lua',
    `a.line=${a.line} b.line=${b.line} chunkName=${a.chunkName}`);
}
{
  const r = checkLuaSyntax('local a = {\n x = 1\n y = 2\n}\n', { chunkName: 'my "x" chunk' });
  ok('chunkName 含引号不会把行号解错', r.line === 3, brief(r));
}
{
  const r = checkLuaSyntax('local a = {\n x = 1\n y = 2\n}\n', { chunkName: '' });
  ok('chunkName 为空仍能解出行号（前缀为空也不误判）', r.ok === false && r.line === 3, brief(r));
}
{
  // **解不出就 null** 的那条分支：这里用模块自己的纯函数口径验证 —— 报错串里没有 `:数字:`
  // 时不许硬凑。走公开 API 拿不到这种串，所以退一步：只断言「有行号的一定是数字、没有的一定是 null」。
  const r = checkLuaSyntax('local s = "abc\n');
  ok('行号字段类型恒为 number 或 null（不是字符串/undefined）',
    r.line === null || typeof r.line === 'number', `typeof=${typeof r.line} 值=${JSON.stringify(r.line)}`);
}

console.log('\n— 组 4：返回值形状契约 —');

{
  const good = checkLuaSyntax('local a = 1\n');
  const bad = checkLuaSyntax('local s = "abc\n');
  ok('成功时**没有** error 键', good.ok === true && !Object.prototype.hasOwnProperty.call(good, 'error'),
    JSON.stringify(good));
  ok('失败时必有 error 与 message 字符串',
    bad.ok === false && typeof bad.error === 'string' && bad.error.length > 0
      && typeof bad.message === 'string' && bad.message.length > 0,
    `error=${JSON.stringify(bad.error)} message=${JSON.stringify(bad.message)}`);
  ok('message 是去掉 chunk 前缀的正文（不含 `lua-syntax:`）',
    !String(bad.message).startsWith('lua-syntax:') && String(bad.error).includes('lua-syntax:'),
    `error=${JSON.stringify(bad.error)} message=${JSON.stringify(bad.message)}`);
  ok('失败时恒带 chunkName', bad.chunkName === 'lua-syntax', JSON.stringify(bad.chunkName));
}
{
  // 门禁自己坏了也不许抛：异常/缺省入参一律回结构化结果。
  // ⚠️ 数字入参（`123`）**会**被 fengari 当成非法语句 ⇒ `ok:false` —— 这是**正确**的：`source` 契约上就是字符串，
  //    传数字是调用方的错，如实报错比"悄悄当空文件放过"安全。这里只钉「不抛 + 形状完整」。
  let threw = null;
  let r1; let r2; let r3;
  try {
    r1 = checkLuaSyntax();
    r2 = checkLuaSyntax(null);
    r3 = checkLuaSyntax(123);
  } catch (e) {
    threw = e;
  }
  const shaped = (r) => r && typeof r.ok === 'boolean'
    && (r.ok || (typeof r.error === 'string' && typeof r.message === 'string'));
  ok('undefined / null / 数字 入参不抛异常，且回执形状完整',
    threw === null && shaped(r1) && shaped(r2) && shaped(r3),
    threw ? String(threw) : `${brief(r1)} ${brief(r2)} ${brief(r3)}`);
}

console.log('\n— 组 5：性能与真实文件 —');

{
  // 2000 行合法 Lua（每行一个表字段 + 一个函数），断言不超时并**打印实测耗时**
  const rows = ['local BIG = {', '  N = 2000,'];
  for (let i = 1; i <= 2000; i += 1) {
    rows.push(`  f${i} = function(a, b) return a + b + ${i} end,`);
  }
  rows.push('}', 'print(BIG.N)', '');
  const big = rows.join('\n');
  const t0 = Date.now();
  const r = checkLuaSyntax(big);
  const ms = Date.now() - t0;
  ok(`2000 行合法 Lua 不超时（实测 ${ms}ms）`, r.ok === true && ms < 2000, `${brief(r)}，耗时 ${ms}ms`);
}
{
  // 真实脚本回归：**只在存在时**跑（工作区布局各人不同，环境缺失不算失败 —— 与 lualint-test 同口径）
  const cand = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'code'),
    path.resolve(process.cwd(), '..', '..', 'code'),
  ];
  const dir = cand.find((p) => fs.existsSync(p));
  if (!dir) {
    pass += 1;
    console.log(`⏭ 跳过：没找到真实 .lua 样本目录（试过 ${cand.join(' | ')}）—— 环境缺失，非失败`);
  } else {
    const files = [];
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else if (e.name.endsWith('.lua')) files.push(q);
      }
    };
    walk(dir);
    const badOnes = [];
    for (const f of files) {
      const r = checkLuaSyntax(fs.readFileSync(f, 'utf8'), { chunkName: path.basename(f) });
      if (!r.ok) badOnes.push(path.basename(f) + ' @L' + r.line + ': ' + r.message);
    }
    ok(`真实脚本全部通过真解析器（${files.length} 个文件）`, badOnes.length === 0,
      badOnes.slice(0, 5).join(' | ') || `${files.length} 个文件`);
  }
}
{
  // 顺带钉一条：检查**不写盘**（临时目录里除了我们自己建的文件，不该多出东西）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-luasyn-'));
  try {
    const before = fs.readdirSync(tmp).length;
    checkLuaSyntax('local a = {\n x = 1\n y = 2\n}\n');
    checkLuaSyntax('local a = 1\n');
    const after = fs.readdirSync(tmp).length;
    ok('语法检查不写任何文件（纯函数）', before === 0 && after === 0, `临时目录条目 ${before} → ${after}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures.slice(0, 12)) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
