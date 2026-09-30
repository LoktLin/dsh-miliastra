/**
 * Lua 源码审计（**纯函数**，只读文本，不碰磁盘）—— 给 `miliastra_code op=preflight` 用。
 *
 * 为什么要单独一个模块（AI 易用性反馈 2026-09-30 第 7 条）：
 *   那位 AI 每改一次脚本要手动跑 6 处检查（其中"作用域/风格"在工作区、**"语法"哪都没有**），
 *   于是 3 次 Lua 语法错误**全部漏到真机前**才发现。现在把**能机械判定**的那几条收进插件，
 *   一次 `op=preflight` 出结论。
 *
 * ★ 分工（**别在这里重复实现别人的活**）：
 *   · `Lua 语法` → `lib/lua-syntax.mjs`（fengari 真解析器，带行号）—— 本模块**不**做语法；
 *   · `结构配对` → `lib/lualint.mjs`（既有，`deploy` 的 lint 也用它）；
 *   · `图片有图源` → `lib/uilint.mjs`（既有，`op=lint-ui` 用它）；
 *   · 本模块只负责**"运行期给全局赋值"**这一条（真机实测：真机上那种写法**不生效** —— 见下）。
 */

/**
 * 找「**运行期给全局变量赋值**」的地方。
 *
 * 为什么值得单列一条（2026-09-30 真机实测）：插件的帧率探针用「把全局 `onFrame` 置 nil」停采样 ⇒
 * **真机上不生效**，一路报到这一局结束（刷出 13 983 行 / 2.8 MB），而同一份脚本在模拟器里是好的。
 * ⇒ 凡是「把全局当标志位 / 缓存 / 累加器」的写法，都值得人过一眼。
 *
 * 判据（**启发式，只报候选、不下结论** —— 本仓纪律：宁可漏报不误报）：
 *   · 顶层 `local X` 声明、函数参数、`for` 变量 ⇒ 安全，不报；
 *   · 缩进的语句级 `X = …` 且 X 在本文件任何地方都没有 local/参数声明 ⇒ **候选**；
 *   · 表构造器内部（花括号深度 > 0）的 `X = …`、以及行尾带 `,` 的 ⇒ 是**表字段**，不报；
 *   · `a.b = …` / `a[k] = …`（字段/索引赋值）⇒ 不报。
 *
 * ⚠️ **已知漏报**（写清楚，别让人以为它是证明）：行首不缩进的语句级赋值、
 *   以及「`if c then X = 1 end` 这种一行里夹着的赋值」都抓不到。
 *
 * @param {string} source Lua 源码
 * @returns {{line:number, name:string, text:string}[]} 候选清单（空 = 没找到）
 */
export function globalWrites(source) {
  const text = String(source === null || source === undefined ? '' : source);
  const lines = text.split(/\r?\n/);

  // ① 本文件里"算作局部"的名字：local 声明 / 函数形参 / for 变量（粗粒度）
  const locals = new Set();
  for (const m of text.matchAll(/\blocal\s+([^=\n]+?)(?:=|$)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^function\s+/, '').match(/^([A-Za-z_]\w*)/);
      if (name) locals.add(name[1]);
    }
  }
  for (const m of text.matchAll(/function\s*[A-Za-z_.:]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().match(/^([A-Za-z_]\w*)/);
      if (name) locals.add(name[1]);
    }
  }
  for (const m of text.matchAll(/\bfor\s+([A-Za-z_][\w\s,]*)\s+in\b/g)) {
    for (const part of m[1].split(',')) locals.add(part.trim());
  }

  // ② 逐行找"语句级给非局部名字赋值"
  const hits = [];
  let brace = 0;
  lines.forEach((raw, i) => {
    const line = raw.replace(/--.*$/, '');
    const depthAtStart = brace;
    brace += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depthAtStart > 0) return;                 // 表构造器内部 = 字段
    if (line.trim().endsWith(',')) return;        // 表字段一般以逗号结尾
    const m = /^\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=\s*[^=]/.exec(line);
    if (!m) return;
    for (const name of m[1].split(',').map((s) => s.trim())) {
      if (locals.has(name)) continue;
      hits.push({ line: i + 1, name, text: raw.trim().slice(0, 120) });
    }
  });
  return hits;
}
