/**
 * 语言层绊线（`npm run lint`，2026-09-24 加）
 *
 * ★ 为什么加它：**纯手写 JS + 有一堆测试，也发现不了这一类错**。上线当天它就抓到一条真 bug ——
 * `miliastra_sim` 的 `parameters` 里有**两个 `all`**（一个给 `op=keys`、一个给 `op=cases action=remove`），
 * JS 对象字面量里**后者静默覆盖前者**，于是「`op=keys all:true` 拿全量键名」这条说明**从来没有到达过 AI**。
 * 测试全绿、功能也"能用"，只有 `no-dupe-keys` 看得见它。
 *
 * ★ 设计取舍：**只开"能过的硬规则"**。
 * 绊线的价值在于**长期是绿的** —— 一旦允许几十条风格警告，人（和 AI）就会开始无视它。
 * 所以这里只放"命中即真问题"的规则：变量名拼错（`no-undef`）、键静默覆盖（`no-dupe-keys`）、
 * 不可达代码（`no-unreachable`）、NaN 比较（`use-isnan`）、`typeof` 打错（`valid-typeof`）……
 * 风格类（缩进/引号/分号）一律不开。
 *
 * ★ 配置**写在代码里**（不落地 `eslint.config.mjs`）：一份真身，少一个会和代码走散的文件；
 * 顺带避免"配置文件在 A 目录、被扫文件在 B 目录"时 ESLint 直接拒扫的坑（实测踩过）。
 *
 * 用法：`node tools/lint.mjs`（有命中就退出码 1，可直接串进 `npm test`）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Node 侧全局（ESM）：显式声明，好让 `no-undef` 只报**我们自己的**拼写错，不报环境。 */
const NODE_GLOBALS = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly',
  TextDecoder: 'readonly', TextEncoder: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', fetch: 'readonly',
  performance: 'readonly', AbortController: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly',
};

/** 浏览器侧全局（`lib/client.js` 是塞进页面的那一半）。 */
const BROWSER_GLOBALS = {
  ...NODE_GLOBALS,
  window: 'readonly', document: 'readonly', React: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
  CustomEvent: 'readonly', HTMLElement: 'readonly', Image: 'readonly', Blob: 'readonly',
  TextDecoder: 'readonly', matchMedia: 'readonly', alert: 'readonly',
};

/** 「命中即真问题」的硬规则。加规则前先自问：这条会不会让我开始无视这个绊线？ */
export const LINT_RULES = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-redeclare': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-obj-calls': 'error',
  'no-new-func': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-sparse-arrays': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

/** 扫哪些文件。`lib/client.js` 单独配浏览器全局；引擎是搬来的上游代码，**不扫**（要改也是上游改）。 */
export const LINT_TARGETS = ['index.js', 'lib/**/*.mjs', 'lib/client.js', 'tests/**/*.mjs', 'tools/**/*.mjs'];

/**
 * 跑一次 lint。返回 `{ rules, targets, files, messages, errors, warnings }`。
 * ⚠️ 用**动态 import** 拿 eslint：没装依赖时给一条人话（而不是 `ERR_MODULE_NOT_FOUND` 糊一脸）。
 */
export async function lintOnce() {
  let ESLint;
  try {
    ({ ESLint } = await import('eslint'));
  } catch (e) {
    throw new Error('跑 lint 需要开发依赖：在包目录执行 `npm i`（eslint 是 devDependency，不会进用户运行时）。'
      + ' 原始错误：' + ((e && e.message) || e));
  }
  const eslint = new ESLint({
    cwd: ROOT,
    // `overrideConfigFile: true` = **不去找配置文件**（配置就在本文件里）
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: NODE_GLOBALS },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
        rules: LINT_RULES,
      },
      { files: ['lib/client.js'], languageOptions: { globals: BROWSER_GLOBALS } },
    ],
  });
  const results = await eslint.lintFiles(LINT_TARGETS);
  const messages = [];
  for (const r of results) {
    for (const m of r.messages) {
      messages.push({
        file: path.relative(ROOT, r.filePath).split(path.sep).join('/'),
        line: m.line, column: m.column, rule: m.ruleId || '(parse)', severity: m.severity, text: m.message,
      });
    }
  }
  return {
    rules: Object.keys(LINT_RULES),
    targets: LINT_TARGETS,
    files: results.length,
    messages,
    errors: messages.filter((m) => m.severity === 2).length,
    warnings: messages.filter((m) => m.severity === 1).length,
  };
}

/** 是不是被直接执行（`node tools/lint.mjs`）—— 被 import 时只导出，不干活。 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const r = await lintOnce();
    for (const m of r.messages) {
      console.log(`${m.file}:${m.line}:${m.column}  ${m.rule}  ${m.text}`);
    }
    if (r.errors) {
      console.log(`\n✗ lint 未通过：${r.errors} 条错误（扫了 ${r.files} 个文件，${r.rules.length} 条硬规则）`);
      process.exit(1);
    }
    console.log(`✓ lint 通过：${r.files} 个文件 / 0 命中（${r.rules.length} 条硬规则：变量名拼错、键静默覆盖、`
      + '不可达代码、NaN 比较、typeof 打错…… 风格类一律不开，好让这条绊线长期是绿的）');
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e));
    process.exit(1);
  }
}
