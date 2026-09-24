/**
 * 类型检查绊线（`npm run typecheck`，2026-09-24 加，接进 `npm test`）
 *
 * ★ 为什么加：`tools/lint.mjs` 只看得到**语法/作用域**层面的错；"**声明与真实用法对不上**"要靠类型才看得见。
 * 第一次跑（`strict:false` + `checkJs`）在我们自己的文件里量出 **52 条**，全是这一类，例如：
 *   · `index.js(531) TS2353 'backupDir' does not exist in type '{ allowNoBackup?; lintMode?; noBackup? }'`
 *     —— 有人加了 `backupDir` 支持却没更新注释；
 *   · `index.js(1578) TS2554 Expected 0-1 arguments, but got 2` —— 调用形状与声明的契约不一致。
 * 也就是说：**注释里的契约在骗人**，而 AI/人读的正是那些注释。
 *
 * ★ 三条纪律：
 *   ① **只认我们自己的文件**（`index.js` / `lib/` / `tools/`，见 `tsconfig.json` 的 `include`）——
 *      `engine/` 是搬来的上游代码，改它等于改上游语义；它的报错**如实报数但不阻断**。
 *   ② 验收线是 **0**：我们自己的文件不许有类型错误。`strict:false` 是**故意**的 ——
 *      先只抓"契约对不上"，不引入几百条 `implicit any` 把绊线淹掉（与 lint「只开能过的硬规则」同一条原则）。
 *   ③ 真需要豁免就在代码里写明理由（像 lint 那两处 `new Function`），**不许**用 `@ts-ignore` 糊。
 *
 * 实现走 **spawn `tsc` + 纯函数解析输出**（不用 TypeScript 的 JS API）：实测本机 `typescript@7` 的 ESM
 * 命名空间里没有 `createProgram`，而 CLI 输出格式是稳定的 —— 顺带让解析器变成可单测的纯函数。
 *
 * 用法：`node tools/typecheck.mjs`
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这条报错属于谁：`ours`（我们写的）/ `engine`（上游搬来的）。纯函数，便于单测。
 */
export function classifyFile(rel) {
  const normalized = String(rel || '').split(path.sep).join('/');
  if (normalized.startsWith('engine/')) return 'engine';
  return 'ours';
}

/**
 * 解析 `tsc --pretty false` 的输出。**纯函数**（可单测）：喂一段文本，回结构化条目。
 * 只认 `file(line,col): error TSxxxx: message` 这种行；紧跟其后的缩进说明行忽略。
 * 另外单独收「没有文件位置的」整体性报错（如 `error TS2688: ...`）—— 那种也归我们，别静默漏掉。
 */
export function parseTscOutput(text) {
  const rows = [];
  const perFile = /^(.*?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.*)$/;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = perFile.exec(line.trim());
    if (!m) continue;
    rows.push({
      file: m[1].split(path.sep).join('/'),
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5].trim(),
      who: classifyFile(m[1]),
    });
  }
  const globalRe = /^error\s+(TS\d+):\s*(.*)$/gm;
  let g;
  while ((g = globalRe.exec(String(text || ''))) !== null) {
    rows.push({ file: '(tsconfig)', line: 0, col: 0, code: g[1], message: g[2].trim(), who: 'ours' });
  }
  return rows;
}

/** tsc 可执行文件（开发依赖里）。 */
function tscBin() {
  const bin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(bin)) {
    throw new Error('跑类型检查需要开发依赖：在包目录执行 `npm i`（typescript 是 devDependency，不进用户运行时）。');
  }
  return bin;
}

/** 跑一次类型检查，返回 `{ all, ours, engine }`。 */
export function typecheckOnce() {
  let out = '';
  try {
    out = execFileSync(process.execPath, [tscBin(), '-p', path.join(ROOT, 'tsconfig.json'), '--pretty', 'false'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // tsc 有诊断时退出码非 0 —— 那正是我们要解析的内容，不算失败
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const all = parseTscOutput(out);
  return {
    all,
    ours: all.filter((r) => r.who === 'ours'),
    engine: all.filter((r) => r.who === 'engine'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const r = typecheckOnce();
    if (r.ours.length) {
      console.log('我们自己的文件有类型错误：');
      for (const x of r.ours.slice(0, 40)) console.log(`  ${x.file}:${x.line}  ${x.code}  ${x.message}`);
      if (r.ours.length > 40) console.log('  …还有 ' + (r.ours.length - 40) + ' 条');
      console.log('\n✗ typecheck 未通过：我们自己的文件 ' + r.ours.length + ' 条'
        + '（engine 上游另 ' + r.engine.length + ' 条，不阻断）');
      process.exit(1);
    }
    console.log('✓ typecheck 通过：我们自己的文件 **0** 条'
      + '（engine 上游 ' + r.engine.length + ' 条如实报数、不阻断 —— 那是搬来的代码，改它等于改上游语义）');
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e));
    process.exit(1);
  }
}
