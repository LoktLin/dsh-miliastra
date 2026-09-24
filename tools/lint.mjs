/**
 * 语言层绊线（`npm run lint`，2026-09-24 加，接进 `npm test`）
 *
 * ★ 为什么加它：**纯手写 JS + 有一堆测试，也发现不了这一类错**。上线当天它就抓到一条真 bug ——
 * `miliastra_sim` 的 `parameters` 里有**两个 `all`**（一个给 `op=keys`、一个给 `op=cases action=remove`），
 * JS 对象字面量里**后者静默覆盖前者**，于是「`op=keys all:true` 拿全量键名」这条说明**从来没有到达过 AI**。
 * 测试全绿、功能也"能用"，只有 `no-dupe-keys` 看得见它。
 *
 * ★ 设计取舍：**只开"能过的硬规则"**。
 * 绊线的价值在于**长期是绿的** —— 一旦允许几十条风格警告，人（和 AI）就会开始无视它。
 * 实测取舍记录：`react-hooks/exhaustive-deps` 在 `lib/client.js` 上会报 **11 条**（多数是"故意不带依赖"的
 * ref/稳定函数），所以**故意不开**；只开 `react-hooks/rules-of-hooks`（实测 **0 条**，条件式 hook 才是真 bug）。
 *
 * ★ 配置**写在代码里**（不落地 `eslint.config.mjs`）：一份真身，少一个会和代码走散的文件；
 * 顺带避免"配置文件在 A 目录、被扫文件在 B 目录"时 ESLint 直接拒扫的坑（实测踩过）。
 *
 * 三个阶段：① ESLint 硬规则（含 hooks）② **死导出**（零引用的 export，见 `findDeadExports`）③ 汇总。
 *
 * 用法：`node tools/lint.mjs`（有命中就退出码 1，可直接串进 `npm test`）
 */
import fs from 'node:fs';
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
  matchMedia: 'readonly', alert: 'readonly',
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
  // 条件式 hook 才是真 bug（实测 0 条命中）；`exhaustive-deps` 故意不开，理由见文件头
  'react-hooks/rules-of-hooks': 'error',
};

/**
 * 扫哪些文件。`lib/client.js` 单独配浏览器全局。
 * ★ `engine/**` 也扫（2026-09-24 补）：上一版**有意排除**过它（"上游代码"），但"有意排除"不等于"没问题" ——
 * 实测 51 个文件命中 **0**，所以纳进来是零成本的保险。它的报错会带 `engine/` 前缀，便于分辨是谁的锅。
 */
export const LINT_TARGETS = ['index.js', 'lib/**/*.mjs', 'lib/client.js', 'engine/**/*.js', 'engine/**/*.mjs',
  'tests/**/*.mjs', 'tools/**/*.mjs'];

/**
 * **死导出**检查：`export` 出去的符号，如果在整个包（含 tests / tools）里没人引用，就是死代码。
 *
 * 为什么做成绊线：2026-09-24 体检时靠**人肉**发现了两个零引用导出（`findLevelAll` 与一个恒返回 `null` 的
 * `findClientProcess`）—— 人肉发现的东西下次不会自动生效。这里把它变成可回归的检查（纯函数，可单测）。
 *
 * ⚠️ 白名单是**显式**的：确实要对外暴露的（例如给测试用的纯函数）就写进 `EXPORT_WHITELIST` 并写理由，
 * 而不是放宽整个规则。
 */
export const EXPORT_WHITELIST = new Map([
  // 例：['somePublicHelper', '对外 API，工具层暂未使用'],
]);

/**
 * 在一个"文件集合"里找零引用导出。**纯函数**（可单测）。
 * @param {Array<{path: string, text: string}>} files 参与检查的文件（定义与引用都在这一集合里找）
 * @param {Map<string, string>} [whitelist] 名字 → 保留理由
 * @returns {Array<{name: string, file: string, line: number}>}
 */
export function findDeadExports(files, whitelist = EXPORT_WHITELIST) {
  const defs = [];
  for (const f of files) {
    const lines = String(f.text || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /^\s*export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/.exec(line);
      if (m) defs.push({ name: m[1], file: f.path, line: i + 1 });
      // `export { a, b };` 这种转发也算定义（例如 codefile.mjs 转发 fsx.mjs 的原子写）
      const g = /^\s*export\s*\{([^}]*)\}/.exec(line);
      if (g) {
        for (const part of g[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name) defs.push({ name, file: f.path, line: i + 1 });
        }
      }
    });
  }
  const corpus = files.map((f) => String(f.text || '')).join('\n');
  const dead = [];
  for (const d of defs) {
    if (whitelist && whitelist.has(d.name)) continue;
    const hits = (corpus.match(new RegExp('\\b' + d.name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length;
    if (hits <= 1) dead.push(d);       // 只有定义那一处 = 没人用
  }
  return dead;
}

/** 收集参与死导出检查的文件（只看**我们自己的**源码：engine/ 是上游，它有它的对外 API）。 */
function ownSourceFiles() {
  const out = [];
  const push = (rel) => {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push({ path: rel.split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  };
  const walk = (relDir, filter) => {
    const dir = path.join(ROOT, relDir);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const rel = relDir + '/' + name;
      const st = fs.statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel, filter);
      else if (filter(name)) push(rel);
    }
  };
  push('index.js');
  walk('lib', (n) => n.endsWith('.mjs') || n === 'client.js');
  walk('tools', (n) => n.endsWith('.mjs'));
  walk('tests', (n) => n.endsWith('.mjs'));
  return out;
}

/**
 * 跑一次 lint。返回 `{ rules, targets, files, messages, errors, warnings, dead }`。
 * ⚠️ 用**动态 import** 拿 eslint：没装依赖时给一条人话（而不是 `ERR_MODULE_NOT_FOUND` 糊一脸）。
 */
export async function lintOnce() {
  let ESLint;
  let reactHooks;
  try {
    ({ ESLint } = await import('eslint'));
    reactHooks = (await import('eslint-plugin-react-hooks')).default;
  } catch (e) {
    throw new Error('跑 lint 需要开发依赖：在包目录执行 `npm i`（eslint / eslint-plugin-react-hooks 是 devDependency，'
      + '不会进用户运行时）。 原始错误：' + ((e && e.message) || e));
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
        plugins: { 'react-hooks': reactHooks },
        rules: LINT_RULES,
      },
      { files: ['lib/client.js'], languageOptions: { globals: BROWSER_GLOBALS } },
      // 引擎里唯一的**浏览器侧**文件（跑在页面里的 Pixi 渲染器）—— 实测 51 个 engine 文件里只有它用 `window`
      { files: ['engine/studio/play/pixi-renderer.js'], languageOptions: { globals: BROWSER_GLOBALS } },
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
  const dead = findDeadExports(ownSourceFiles());
  return {
    rules: Object.keys(LINT_RULES),
    targets: LINT_TARGETS,
    files: results.length,
    messages,
    errors: messages.filter((m) => m.severity === 2).length,
    warnings: messages.filter((m) => m.severity === 1).length,
    dead,
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
    for (const d of r.dead) {
      console.log(`${d.file}:${d.line}  no-unused-export  '${d.name}' 导出了但全包零引用`
        + '（要保留就写进 tools/lint.mjs 的 EXPORT_WHITELIST 并写理由）');
    }
    if (r.errors || r.dead.length) {
      console.log(`\n✗ lint 未通过：${r.errors} 条规则命中 + ${r.dead.length} 个死导出`
        + `（扫了 ${r.files} 个文件，${r.rules.length} 条硬规则）`);
      process.exit(1);
    }
    console.log(`✓ lint 通过：${r.files} 个文件 / 0 命中 / 0 死导出（${r.rules.length} 条硬规则：变量名拼错、`
      + '键静默覆盖、不可达代码、NaN 比较、typeof 打错、条件式 hook…… 风格类一律不开，好让这条绊线长期是绿的）');
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e));
    process.exit(1);
  }
}
