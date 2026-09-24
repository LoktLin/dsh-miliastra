/**
 * lualint.mjs — 轻量 Lua 结构校验（零依赖，纯文本扫描）
 *
 * 为什么需要：**一段语法错的 Lua 投进沙箱，试玩会静默不生效**（脚本根本没起来），
 * 而日志里只会看到"什么都没有" —— 这是最难查的一类失败。
 * 部署前扫一遍，至少能把"括号没配平 / end 少一个"这类低级错误挡在门外。
 *
 * ⚠️ **这不是完整 Lua 解析器**，是**结构级启发式**。它做两件事：
 *   ① 先严格剥掉注释与字符串（含 `[[...]]` 长括号），避免把里面的 `end` 当真；
 *   ② 在剥完的代码上统计块开闭与括号配对，**报第一处问题的行号**。
 *
 * 因此：
 *   · 报"括号不配平 / 块深度不为 0" → 几乎可以确定是真错，**值得拦**
 *   · 报别的 → 只当提示（可能是我这套启发式的误判）
 * 调用方据此决定「警告」还是「拒绝部署」。
 */

const OPENERS = new Set(['function', 'if', 'do', 'repeat']);
const CLOSERS = new Set(['end', 'until']);
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{' };

/**
 * 扫描一遍，产出「去掉注释与字符串后的代码」+ **逐字符的行号映射**。
 *
 * 顺序很讲究（踩过）：
 *   · 先看 `--[[` / `--[=[` **长注释**，再看普通 `--` 行注释 ——
 *     反过来的话 `--[[` 会被当行注释，注释体留在代码里，里面的 `function/end` 全被当真。
 *   · 字符串用**一个空格**占位（不能直接删，否则 `a"b"c` 会粘成一个词）。
 * @returns {{code:string, lineOf:number[], problems:Array}}
 */
export function stripCommentsAndStrings(src, trace) {
  const problems = [];
  const rec = (kind, atLine, text) => { if (trace) trace.push({ kind, line: atLine, len: text.length, sample: text.slice(0, 60).replace(/\n/g, '\\n') }); };
  let out = '';
  const lineOf = [];
  let line = 1;
  let i = 0;
  const n = src.length;

  // 逐字符记录行号 —— 必须与 out 等长，否则后面按 index 查行号会错位
  const push = (ch, atLine) => {
    out += ch;
    for (let k = 0; k < ch.length; k++) lineOf.push(atLine);
  };
  const skipTo = (endExclusive) => {
    for (let k = i; k < endExclusive; k++) if (src[k] === '\n') line++;
    i = endExclusive;
  };

  while (i < n) {
    const c = src[i];

    // ① 长注释：--[[ ... ]] / --[=[ ... ]=]
    if (c === '-' && src[i + 1] === '-') {
      const lm = /^--\[(=*)\[/.exec(src.slice(i, i + 10));
      if (lm) {
        const closer = ']' + lm[1] + ']';
        const body = i + lm[0].length;
        const end = src.indexOf(closer, body);
        if (end < 0) { problems.push({ line, message: '长注释 ' + lm[0] + ' 没有闭合' }); break; }
        rec('longcomment', line, src.slice(i, end + closer.length));
        skipTo(end + closer.length);
        push(' ', line);   // 占位，避免前后词粘在一起
        continue;
      }
      const cStart = i;
      while (i < n && src[i] !== '\n') i++;   // 普通行注释
      rec('linecomment', line, src.slice(cStart, i));
      continue;
    }

    // ② 长字符串：[[ ... ]] / [=[ ... ]=]
    const longOpen = /^\[(=*)\[/.exec(src.slice(i, i + 40));
    if (longOpen) {
      const closer = ']' + longOpen[1] + ']';
      const body = i + longOpen[0].length;
      const end = src.indexOf(closer, body);
      if (end < 0) { problems.push({ line, message: '长括号 ' + longOpen[0] + ' 没有闭合的 ' + closer }); break; }
      const at = line;
      rec('longstring', at, src.slice(i, end + closer.length));
      skipTo(end + closer.length);
      push(' ', at);
      continue;
    }

    // ③ 短字符串
    if (c === '"' || c === "'") {
      const quote = c;
      const at = line;
      const strStart = i;
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') { line++; i++; continue; }   // 合法 Lua 不允许，但别把行号算丢
        if (src[i] === quote) { i++; closed = true; break; }
        i++;
      }
      rec(closed ? 'string' : 'string-unclosed', at, src.slice(strStart, i));
      if (!closed) problems.push({ line: at, message: '字符串 ' + quote + ' 没有闭合' });
      push(' ', at);
      continue;
    }

    // ⚠️ 换行**必须占位保留**：直接跳过会让「行尾词 + 下一行行首词」粘成一个标识符
    //    （踩过：`sx, sy` 换行后接 `local` → 粘成 `sylocal`，行首的 `end` 被吞进上一行尾巴，
    //     于是真文件恒报「缺 N 个 end」，而单行小样例却是好的）。
    if (c === '\n') { push('\n', line); line++; i++; continue; }
    push(c, line);
    i++;
  }

  return { code: out, lineOf, problems };
}

/**
 * 校验一段 Lua 的结构。
 * @param {string} text
 * @returns {{ok:boolean, problems:Array<{line:number,message:string}>,
 *            stats:{bytes:number, lines:number, tokens:number, thenCount:number}}}
 *   `stats` 是**原文的**体量（`bytes` 按 UTF-8 算、`lines` 按行数、`tokens` 是词法 token 数、
 *   `thenCount` 是见到的 `then` 个数）；`problems` 只保留前 5 条，避免刷屏。
 */
export function lintLua(text) {
  const src = String(text == null ? '' : text);
  const { code, lineOf, problems } = stripCommentsAndStrings(src);

  // 逐 token 走一遍
  const words = [...code.matchAll(/[A-Za-z_][A-Za-z0-9_]*|==|~=|<=|>=|\.\.|[(){}\[\]]/g)];
  const delims = [];
  const blocks = [];   // [{tok, line}] —— 记下开块位置，缺 end 时才能报「是哪个块没关」
  let sawReturnLike = 0;

  for (const m of words) {
    const tok = m[0];
    const at = lineOf[m.index] || 1;

    if (PAIRS[tok]) { delims.push({ ch: tok, line: at }); continue; }
    if (CLOSE_TO_OPEN[tok]) {
      const top = delims.pop();
      if (!top) { problems.push({ line: at, message: '多出一个 ' + tok }); continue; }
      if (top.ch !== CLOSE_TO_OPEN[tok]) {
        problems.push({ line: at, message: '括号不匹配：第 ' + top.line + ' 行的 ' + top.ch + ' 被第 ' + at + ' 行的 ' + tok + ' 关闭' });
      }
      continue;
    }

    if (OPENERS.has(tok)) { blocks.push({ tok, line: at }); continue; }
    if (CLOSERS.has(tok)) {
      const top = blocks.pop();
      if (!top) { problems.push({ line: at, message: '多出一个 ' + tok + '（前面没有对应的块开始）' }); continue; }
      // `repeat` 只由 `until` 关，其余（if / for / while / do / function）只由 `end` 关
      const want = top.tok === 'repeat' ? 'until' : 'end';
      if (tok !== want) problems.push({ line: at, message: '第 ' + top.line + ' 行的 ' + top.tok + ' 应当由 ' + want + ' 关闭，这里却是 ' + tok });
      continue;
    }
    if (tok === 'then') { sawReturnLike++; continue; }
  }

  for (const d of delims) problems.push({ line: d.line, message: '括号 ' + d.ch + ' 没有闭合' });
  // 报**最内层没关上的那个块**的行号 —— 比「文件最后一行」有用得多
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    problems.push({ line: b.line, message: '第 ' + b.line + ' 行的 ' + b.tok + ' 没有对应的 ' + (b.tok === 'repeat' ? 'until' : 'end') });
  }
  if (blocks.length) {
    problems.push({ line: lineOf[lineOf.length - 1] || 1, message: '文件结束时还有 ' + blocks.length + ' 个块没关（共缺 ' + blocks.length + ' 个 end/until）' });
  }

  // 只保留前 5 条，避免刷屏
  const trimmed = problems.slice(0, 5);
  return {
    ok: trimmed.length === 0,
    problems: trimmed,
    stats: {
      bytes: Buffer.byteLength(src, 'utf8'),
      lines: src.split(/\r?\n/).length,
      tokens: words.length,
      thenCount: sawReturnLike,
    },
  };
}

/** 给日志/返回值用的一行人话总结。 */
export function lintSummary(res) {
  if (!res) return '（未校验）';
  if (res.ok) return '结构正常（' + res.stats.lines + ' 行 / ' + res.stats.tokens + ' token）';
  return res.problems.map((p) => 'L' + p.line + ' ' + p.message).join('；');
}
