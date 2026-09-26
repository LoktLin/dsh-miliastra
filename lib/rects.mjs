/**
 * rects.mjs — 「画在哪 = 点哪算」的**数字提取与配对**（`miliastra_code op=rects`，N-1）
 *
 * 为什么要它（2026-09-26 实盘）：热区写在 `交互 input.lua`、画面写在 `表现 view.lua`，
 * **同一份数字写两处** —— 改一处忘另一处就是「看得见点不着」。作者当时自写了 ~60 行脚本
 * （`tmp/check-overlay-rects.mjs`）把 `add("name","img|txt",x,y,w,h)` 与 `local RECT = {x,y,w,h}`
 * 逐字比对，还手工把 `ovB1 ↔ T_START` 这种「名字不同、其实是同一个东西」的对照表写在脚本里。
 *
 * 本模块只做**机械**的三件事，**只报数字不判决**（本仓纪律）：
 *   ① 把每个 `.lua` 里的矩形抄出来（`文件:行号` + 名字 + 数值 + 原始写法）；
 *   ② 把**同名**的（跨文件）与**数值近似**的（跨文件、每个字段都在 `nearPx` 内）配成对，给出逐字段差；
 *   ③ 人给了 `pairs` 时，只做他点名的那几对（作者那份脚本的 `ovB1 ↔ T_START` 就是这种）。
 *
 * ★ **宁可少覆盖，也不给假一致**（写在这里防止以后"顺手补全"）：
 *   · 名字不同 ≠ 同一个东西 —— **本模块不会**自动把 `ovB1` 配到 `T_START`（那是语义，得人给 `pairs`）；
 *   · 循环建出来的控件（`add(MENU_BTNS[mi][1], "img", 620, y, 360, 72)`）**算不出**每行坐标：
 *     本模块把它原样记为 `formula:true`（槽位是表达式而不是字面量），并把驱动表
 *     （`local MENU_BTNS = { {"mxB1", "继续", 428}, … }`）的**原始行**一起给你 —— 公式由你/AI 代；
 *   · 注释掉的代码不参与（先剥 Lua 注释），字符串里的 `add(...)` 也不参与。
 */

/** 剥掉 Lua 的 `--` 行注释与 `--[[ … ]]` 长注释（**不**碰字符串里的内容：按行扫，引号内跳过）。 */
export function stripLuaComments(src) {
  const out = [];
  let inLong = false;
  for (const raw of String(src || '').split(/\r?\n/)) {
    let line = raw;
    if (inLong) {
      const end = line.indexOf(']]');
      if (end < 0) { out.push(''); continue; }
      line = line.slice(end + 2);
      inLong = false;
    }
    let i = 0;
    let res = '';
    let quote = '';
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        res += ch;
        if (ch === '\\') { res += line[i + 1] || ''; i += 2; continue; }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; res += ch; i += 1; continue; }
      if (ch === '-' && line[i + 1] === '-') {
        const rest = line.slice(i);
        if (/^--\[=*\[/.test(rest)) { inLong = true; break; }
        break;                                   // 行注释：本行到此为止
      }
      res += ch;
      i += 1;
    }
    out.push(res);
  }
  return out.join('\n');
}

/** 一个槽位是不是「纯数字字面量」（`620` / `812.5`；`620 + 1` 不算）。 */
export function asNumber(slot) {
  const s = String(slot == null ? '' : slot).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把 `f(a, b, c)` 的实参按**顶层逗号**切开（`(i-1)%3` 这种带括号/逗号的表达式不许切坏）。
 *
 * @param {string} text 从第一个 `(` 之后开始、到匹配的 `)` 之前的那一段
 * @returns {string[]}
 */
export function splitTopLevelArgs(text) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += text[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur.trim());
  return out;
}

/** 从 `text` 的 `open` 位置起找配对的 `)`，返回其中间内容（找不到返回 null）。 */
function insideParens(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** 行号（1 基）：按换行累加，算某个下标在第几行。 */
function lineOf(src, index) {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') n += 1;
  return n;
}

/** 一条矩形记录（槽位可以是字面量，也可以是表达式 —— 后者 `rect` 为 null）。 */
function makeRect({ name, kind, file, line, source, slots }) {
  const nums = slots.map(asNumber);
  const literal = nums.every((n) => n !== null);
  return {
    name: name == null ? null : String(name),
    kind: kind == null ? null : String(kind),
    file, line, source,
    slots: slots.map((s) => String(s).trim()),
    formula: !literal,
    rect: literal ? nums : null,
    // 哪些槽位不是字面量（`formula:true` 时用来看"卡在哪一项"）
    nonLiteralSlots: literal ? [] : slots.map((s, i) => (nums[i] === null ? { i, expr: String(s).trim() } : null)).filter(Boolean),
  };
}

/**
 * 扫一份 Lua 源码里的矩形（**纯函数**，可单测）。
 *
 * @param {string} text Lua 正文
 * @param {string} file 文件名（只写进回执）
 * @returns {{rects:Array, driverTables:Array}}
 *   `rects[]`：`{name, kind, file, line, source:'add'|'table', slots, formula, rect, nonLiteralSlots}`
 *   `driverTables[]`：`{name, file, line, rows: [['"mxB1"','"继续"','428'], …]}`
 */
export function scanRects(text, file = '') {
  const code = stripLuaComments(text);
  const rects = [];
  const driverTables = [];

  /* ---- ① add("name", "img|txt", x, y, w, h)（名字/类型必须是字符串字面量，否则只当公式记录） ---- */
  const addRe = /\badd\s*\(/g;
  let m = addRe.exec(code);
  while (m !== null) {
    const inner = insideParens(code, m.index + m[0].length - 1);
    if (inner != null) {
      const args = splitTopLevelArgs(inner);
      if (args.length >= 6) {
        const nameArg = args[0].trim();
        const kindArg = args[1].trim();
        const name = /^"[^"]*"$/.test(nameArg) ? nameArg.slice(1, -1) : nameArg;
        const kind = /^"[^"]*"$/.test(kindArg) ? kindArg.slice(1, -1) : null;
        const slots = args.slice(2, 6);
        // 只收「像一个矩形」的调用：至少有一个槽位是数字/含数字的表达式
        if (slots.some((s) => /\d/.test(s))) {
          rects.push(makeRect({ name, kind, file, line: lineOf(code, m.index), source: 'add', slots }));
        }
      }
    }
    m = addRe.exec(code);
  }

  /* ---- ② local NAME = { x, y, w, h }（4 个槽位）；以及驱动表（≥1 行 {a, b, c} 的表） ---- */
  const assignRe = /(?:^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)\{/gm;
  let a = assignRe.exec(code);
  while (a !== null) {
    const name = a[1];
    const open = a.index + a[0].length - 1;
    const body = braceBody(code, open);
    if (body != null) {
      const items = splitTopLevelArgs(body);
      const rows = items.filter((s) => s.trim() !== '');
      const isRowTable = rows.length >= 1 && rows.every((r) => /^\{[^{}]*\}$/.test(r.trim()));
      if (isRowTable) {
        driverTables.push({
          name, file, line: lineOf(code, a.index),
          rows: rows.map((r) => splitTopLevelArgs(r.trim().slice(1, -1)).map((x) => x.trim())),
        });
      } else if (rows.length === 4 && rows.some((s) => /\d/.test(s))) {
        rects.push(makeRect({ name, kind: null, file, line: lineOf(code, a.index), source: 'table', slots: rows }));
      }
    }
    a = assignRe.exec(code);
  }

  return { rects, driverTables };
}

/** 从 `open`（指向 `{`）起找配对的 `}`，返回其中间内容（找不到返回 null）。 */
export function braceBody(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const rowOf = (r) => (r.rect ? r.rect.join(',') : r.slots.join(','));

/**
 * 把「循环建出来的控件」的**驱动表**找出来（`add(MENU_BTNS[mi][1], "img", 620, y, 360, 72)` ← `local MENU_BTNS = {…}`）。
 *
 * ⚠️ 这里**不做代换**：公式里那个 `y` 到底取第几列、乘不乘系数，只有写代码的人知道
 * （作者的脚本自己写死了 `[620, m[2], 360, 72]`）。本函数只把**表行原文**摆到公式旁边 ——
 * 「从驱动表读坐标 + 建表公式」这一步留给你/AI，工具**不猜**（猜错就是假一致，比不报更坏）。
 *
 * @param {Array} rects `scanRects` 的 `rects`
 * @param {Array} driverTables `scanRects` 的 `driverTables`
 * @returns {Array<{file:string, line:number, name:string, table:string, slots:string[], rows:Array<Array<string>>}>}
 */
export function expandDriverRefs(rects, driverTables) {
  const tables = new Map((Array.isArray(driverTables) ? driverTables : []).map((t) => [t.name, t]));
  const out = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!r || r.rect) continue;                    // 只有「算不出来的公式」才可能靠驱动表
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[/.exec(String(r.name || ''));
    if (!m) continue;
    const t = tables.get(m[1]);
    if (!t) continue;
    out.push({ file: r.file, line: r.line, name: r.name, table: t.name, slots: r.slots, rows: t.rows });
  }
  return out;
}

/**
 * 跨文件配对与差异（**纯函数**）—— 只回答「这两个数字对不对得上」，**不判谁对**。
 *
 * @param {Array} rects `scanRects` 汇总出来的全部矩形（带 `file` / `line` / `name` / `rect`）
 * @param {{nearPx?: number, pairs?: Array<any>, maxPairs?: number}} [opts]
 *        `nearPx` = 「近似」的逐字段容差（默认 4px）；`pairs` = 人点名的名字对照
 *        （`[["ovB1","T_START"], …]` 或 `[{a:"ovB1", b:"T_START"}, …]`）
 * @returns {{exact:Array, near:Array, nearTotal:number, nearTruncated:boolean, sameName:Array,
 *            pairsChecked:Array, formulaOnly:Array, counts:object}}
 */
export function compareRects(rects, { nearPx = 4, pairs = null, maxPairs = 60 } = {}) {
  const list = (Array.isArray(rects) ? rects : []).filter((r) => r && r.rect && r.file);
  const byKey = new Map();
  for (const r of list) {
    const k = rowOf(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const brief = (r) => ({ name: r.name, file: r.file, line: r.line, rect: r.rect, source: r.source });

  // ① 逐字相同、且**跨文件**（同文件里两处相同是正常写法，不算"两份数字要对齐"的证据）
  const exact = [];
  for (const [, group] of byKey) {
    const files = new Set(group.map((r) => r.file));
    if (group.length < 2 || files.size < 2) continue;
    exact.push({ rect: group[0].rect, count: group.length, files: [...files], entries: group.map(brief) });
  }
  exact.sort((a, b) => b.count - a.count || String(a.rect).localeCompare(String(b.rect)));

  // ② 近似（每个字段都在 nearPx 内、但不完全相同）+ 跨文件
  const near = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.file === b.file) continue;
      const delta = a.rect.map((v, k) => v - b.rect[k]);
      const same = delta.every((d) => d === 0);
      if (same) continue;                                  // 完全相同的由 ① 管
      const worst = Math.max(...delta.map((d) => Math.abs(d)));
      if (worst > nearPx) continue;
      near.push({ a: brief(a), b: brief(b), delta, maxDelta: worst });
    }
  }
  near.sort((x, y) => x.maxDelta - y.maxDelta);
  const nearCapped = near.length > maxPairs;
  const nearOut = near.slice(0, maxPairs);

  // ③ 同名跨文件（名字相同、数字可能不同 —— 那正是"改一处忘另一处"的样子）
  const nameMap = new Map();
  for (const r of list) {
    if (!r.name) continue;
    const k = r.name;
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k).push(r);
  }
  const sameName = [];
  for (const [name, group] of nameMap) {
    const files = new Set(group.map((r) => r.file));
    if (files.size < 2) continue;
    const rows = group.map(brief);
    const same = new Set(group.map(rowOf)).size === 1;
    sameName.push({ name, same, files: [...files], entries: rows });
  }
  sameName.sort((a, b) => (a.same === b.same ? 0 : a.same ? 1 : -1));

  // ④ 人点名的对照（作者的 `ovB1 ↔ T_START` 那种：名字不同，但确实是同一个控件）
  const pairsChecked = [];
  if (Array.isArray(pairs)) {
    for (const raw of pairs) {
      let an; let bn;
      if (Array.isArray(raw)) { an = raw[0]; bn = raw[1]; } else if (raw && typeof raw === 'object') { an = raw.a; bn = raw.b; }
      const key = (n) => String(n == null ? '' : n);
      const hitsA = list.filter((r) => r.name === key(an));
      const hitsB = list.filter((r) => r.name === key(bn));
      if (!hitsA.length || !hitsB.length) {
        pairsChecked.push({
          a: key(an), b: key(bn), ok: false,
          reason: (!hitsA.length ? '找不到 ' + key(an) : '找不到 ' + key(bn)),
        });
        continue;
      }
      for (const ra of hitsA) {
        for (const rb of hitsB) {
          const delta = ra.rect.map((v, k) => v - rb.rect[k]);
          pairsChecked.push({
            a: brief(ra), b: brief(rb), delta,
            maxDelta: Math.max(...delta.map((d) => Math.abs(d))),
            equal: delta.every((d) => d === 0),
          });
        }
      }
    }
  }

  const noNumber = (Array.isArray(rects) ? rects : []).filter((r) => r && !r.rect);
  return {
    exact, near: nearOut, nearTruncated: nearCapped, nearTotal: near.length, sameName, pairsChecked,
    formulaOnly: noNumber.map((r) => ({ name: r.name, file: r.file, line: r.line, slots: r.slots, source: r.source })),
    counts: {
      rects: Array.isArray(rects) ? rects.length : 0,
      withNumbers: list.length,
      formulaOnly: noNumber.length,
      exactGroups: exact.length,
      nearPairs: near.length,
      sameNameGroups: sameName.length,
      mismatchSameName: sameName.filter((g) => !g.same).length,
    },
  };
}
