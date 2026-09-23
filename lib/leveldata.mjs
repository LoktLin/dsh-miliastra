/**
 * leveldata.mjs — 从**活文件**里读出「玩法关卡表」（受限解析，只读）
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 为什么要有它（2026-09-23 真机教训）
 * ───────────────────────────────────────────────────────────────────────────
 * 那一晚白跑了两局：作者按设计文档的 ASCII 图**脑算**排坐标，结果 A 的横向占位
 * `[400,740]` 与 B 的 `[720,1060]` **水平投影重叠 20px**、A 最高时玩家头顶离 B 底面只剩 **6px**，
 * 一往右走就被推回（原话：「碰到空气墙的感觉，被踢回来，然后往右掉下去」）。
 *
 * 这两个数字**本来是可以算出来的** —— 缺的只是「让工具读得到那张关卡表」。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 纪律：**只报数字，不下判决**
 * ───────────────────────────────────────────────────────────────────────────
 * 「跳得过去吗」取决于跳跃初速、重力、移动平台相位 —— 那些是**玩法**，是作者定的。
 * 所以这里只给**几何事实**（重叠多少 px、净空多少 px、缝多少 px），
 * **不出现「通过 / 不通过」「可达 / 不可达」这类结论**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 解析边界：只认纯字面量表，认不出来就**如实报行号**，绝不猜
 * ───────────────────────────────────────────────────────────────────────────
 * 认：
 *   · 顶级 `local A, B, C = 1, 2, 3`（**多变量一行赋值**，实测活文件就是这么写的常量）
 *   · `local X = "字符串" / 数字 / true / false`
 *   · 嵌套表：数组部分 `{ 1, 2, 3 }` + 命名部分 `{ name = "…", plats = { … } }`
 *   · 数字（含负数、小数）、字符串（单/双引号，含中文与转义）、`true` / `false` / `nil`
 *   · 常量标识符（如 `K_PLAIN` / `PHASE_ICE`）→ 从上面的 `local` 赋值里解析
 *   · 行注释 `--`、长注释 `--[[ ]]` / `--[==[ ]==]`、尾随逗号
 * 不认（**报行号 + 原文 + 原因**）：
 *   · 算术 / 拼接 / 索引 / 函数调用 / `for` / 变量引用 —— 即「表里有算出来的值」
 * 实测活文件 `双相.lua` v9.2 的表**全部落在「认」的一侧**（K_* 是数字常量、`nil` 占位、
 * 中文都在字符串里），所以这条路走得通 —— 但**它随时可能被改**，所以不认时必须吵。
 */

/** 常量取值允许的类型。 */
const isLiteralScalar = (v) => v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';

/* --------------------------------------------------------------- ① 去注释 */

/**
 * 去掉 Lua 注释，**保留所有换行**（行号不能错位），并把注释位置替换成空格。
 * 字符串（单/双引号、`[[ ]]` / `[==[ ]==]` 长括号）内部原样保留。
 */
export function stripLuaComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    // 长注释 / 长字符串 `[==[ … ]==]`
    if (c === '[' && (s[i + 1] === '[' || /=/.test(s[i + 1] || ''))) {
      const m = /^\[(=*)\[/.exec(s.slice(i));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = s.indexOf(close, i + m[0].length);
        const body = end === -1 ? s.slice(i) : s.slice(i, end + close.length);
        // 长括号开头若是 `--[[`，说明前面已经把 `--` 吃掉了；这里只看它是注释还是字符串：
        // 由调用方的 `--` 分支决定 —— 走到这里说明是**长字符串**，原样保留。
        out += body;
        i += body.length;
        continue;
      }
    }
    if (c === '-' && s[i + 1] === '-') {
      // 行注释，或 `--[[ … ]]` 长注释
      const m = /^--\[(=*)\[/.exec(s.slice(i));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = s.indexOf(close, i + m[0].length);
        const body = end === -1 ? s.slice(i) : s.slice(i, end + close.length);
        // 注释里的换行要保留（行号）
        out += body.replace(/[^\n]/g, ' ');
        i += body.length;
        continue;
      }
      let j = i;
      while (j < n && s[j] !== '\n') j += 1;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      // 短字符串：原样保留（含转义）
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c || s[j] === '\n') { j += 1; break; }
        j += 1;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* --------------------------------------------------- ② 常量表（local X = 字面量） */

const LITERAL_TOKENS = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * 扫出顶级 `local A, B = 1, 2` / `local X = "s"` 形式的**字面量**常量。
 * 值不是字面量（函数调用 / 表 / 表达式）就**跳过这个名字**（不塞错值）。
 */
export function collectConstants(cleanSrc) {
  const consts = new Map();
  const lines = String(cleanSrc).split('\n');
  for (const line of lines) {
    const m = /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const names = m[1].split(',').map((x) => x.trim());
    const values = [];
    for (const raw of splitTopLevel(m[2], ',')) {
      const v = parseScalar(raw.trim(), null);
      values.push(v === undefined ? undefined : v);
    }
    if (values.length !== names.length) continue;          // 数量对不上（多半含逗号在表里）→ 整条跳过
    if (values.some((v) => v === undefined)) continue;      // 有非字面量 → 整条跳过，宁可少认也不认错
    for (let k = 0; k < names.length; k += 1) {
      if (!consts.has(names[k])) consts.set(names[k], values[k]);
    }
  }
  return consts;
}

/** 按分隔符切顶层（不切进表 / 字符串里）。 */
function splitTopLevel(src, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) { j += 1; break; }
        j += 1;
      }
      cur += s.slice(i, j); i = j; continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; i += 1; continue; }
    cur += c; i += 1;
  }
  out.push(cur);
  return out;
}

/** 把一段文本当**单个字面量**解析；不是字面量返回 undefined。 */
function parseScalar(text, consts) {
  const t = String(text).trim();
  if (!t) return undefined;
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'nil') return null;
  const sm = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*')$/.exec(t);
  if (sm) return unquoteLua(t);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    if (consts && consts.has(t)) return consts.get(t);
    return undefined;
  }
  return undefined;
}

function unquoteLua(lit) {
  const q = lit[0];
  const body = lit.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const nx = body[i + 1];
    i += 1;
    if (nx === 'n') out += '\n';
    else if (nx === 't') out += '\t';
    else if (nx === 'r') out += '\r';
    else if (nx === '\\') out += '\\';
    else if (nx === '"') out += '"';
    else if (nx === "'") out += "'";
    else if (nx === '\n') out += '\n';
    else out += nx;
  }
  return out;
}

/* --------------------------------------------------- ③ 受限表解析 */

class LevelParseError extends Error {
  constructor(message, line) { super(message); this.name = 'LevelParseError'; this.line = line; }
}

/**
 * 解析一个 Lua 表字面量（受限）。返回 `{ value, end }`。
 * 认不出来 → 抛 `LevelParseError`（带**行号**，调用方如实回报）。
 */
export function parseTableLiteral(src, start, consts, baseLine = 1) {
  const s = String(src);
  let i = Number(start) || 0;
  const lineAt = (pos) => baseLine + (s.slice(0, pos).match(/\n/g) || []).length;

  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };

  const readValue = (depth) => {
    skipWs();
    const c = s[i];
    if (c === '{') {
      if (depth > 12) throw new LevelParseError('表嵌套太深（>12 层）', lineAt(i));
      return readTable(depth + 1);
    }
    // 标量：读到分隔符为止
    let j = i;
    if (c === '"' || c === "'") {
      j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) { j += 1; break; }
        if (s[j] === '\n') break;
        j += 1;
      }
    } else {
      while (j < s.length && !/[,}\]\n]/.test(s[j])) j += 1;
    }
    const rawText = s.slice(i, j);
    const v = parseScalar(rawText, consts);
    if (v === undefined) {
      throw new LevelParseError('这一项不是字面量（认不出的写法：' + rawText.trim().slice(0, 40) + '）', lineAt(i));
    }
    i = j;
    return v;
  };

  const readTable = (depth) => {
    skipWs();
    if (s[i] !== '{') throw new LevelParseError('期望 `{`', lineAt(i));
    const openLine = lineAt(i);
    i += 1;
    const arr = [];
    const map = {};
    for (;;) {
      skipWs();
      if (i >= s.length) throw new LevelParseError('表没有闭合（少了 `}`）—— 从第 ' + openLine + ' 行开始', openLine);
      if (s[i] === '}') { i += 1; break; }
      // 命名项？  `name = value`（`=` 前是个标识符，且后面不是 `=`)
      const keyM = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(s.slice(i));
      if (keyM) {
        i += keyM[0].length;
        map[keyM[1]] = readValue(depth);
      } else {
        arr.push(readValue(depth));
      }
      skipWs();
      if (s[i] === ',' || s[i] === ';') { i += 1; continue; }
      if (s[i] === '}') { i += 1; break; }
      if (i >= s.length) throw new LevelParseError('表没有闭合（少了 `}`）', openLine);
      throw new LevelParseError('表里出现认不出的分隔：`' + String(s[i]).slice(0, 12) + '`', lineAt(i));
    }
    // 数组部分没用到时，允许只返回命名部分（例如 LEVELS 的每一项）
    if (arr.length === 0 && Object.keys(map).length > 0) return map;
    if (Object.keys(map).length === 0) return arr;
    // 两者都有 → 合并成对象（数组放到 `.` 下标上，避免丢数据）
    for (let k = 0; k < arr.length; k += 1) map[String(k)] = arr[k];
    return map;
  };

  skipWs();
  const value = readValue(0);
  return { value, end: i };
}

/* --------------------------------------------------- ④ 找 `local LEVELS = {` */

/**
 * 从源码里抽出关卡表。返回：
 *   `{ ok:true, levels, constants, unresolved[], blockLines }`
 *   `{ ok:false, error, line }`
 *
 * `nameHint` 默认 `LEVELS`；可按需换成别的变量名。
 */
export function extractLevelTable(src, { nameHint = 'LEVELS' } = {}) {
  const raw = String(src);
  const clean = stripLuaComments(raw);
  const consts = collectConstants(clean);
  const constList = [...consts.entries()].map(([name, value]) => ({ name, value }));

  const re = new RegExp('^\\s*local\\s+' + nameHint + '\\s*=\\s*\\{', 'm');
  const m = re.exec(clean);
  if (!m) {
    return {
      ok: false,
      error: '活文件里没有找到 `local ' + nameHint + ' = {` —— 关卡表可能改名了，或者用的是别的写法',
      constants: constList,
      searchedFor: nameHint,
    };
  }
  const braceAt = clean.indexOf('{', m.index);
  const lineAt = clean.slice(0, braceAt).split('\n').length;
  let parsed;
  try {
    parsed = parseTableLiteral(clean, braceAt, consts, 1);
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) || String(e),
      line: e && e.line ? e.line : lineAt,
      lineText: raw.split('\n')[(e && e.line ? e.line : lineAt) - 1] || null,
      constants: constList,
      hint: '本工具**只认纯字面量表**（数字 / 字符串 / true / false / nil / 常量名 / 嵌套表）。'
        + '表里一旦出现算出来的值（算术、拼接、函数调用、变量引用），这里会明确报行号而不是猜 —— '
        + '要么把那一段写成字面量，要么就不用这个工具。',
    };
  }
  const value = parsed.value;
  if (!Array.isArray(value)) {
    return { ok: false, error: '`' + nameHint + '` 解析出来不是数组（顶层应当是 `{ 关卡1, 关卡2, … }`）', line: lineAt, constants: constList };
  }
  return { ok: true, levels: value, constants: constList, blockLines: { from: lineAt, to: lineAt + clean.slice(braceAt).split('\n').length } };
}

/* --------------------------------------------------- ⑤ 几何事实（只给数字） */

const KINDS_DEFAULT = { 0: '普通', 1: '冰面', 2: '熔岩', 3: '冰墙', 4: '熔岩坑', 5: '移动' };

/** 一个平台项 `{ x, y, w, h, kind [, mv] [, iso] }` → 结构化。认不出就返回 null。 */
export function normalizePlat(item, kindNames = KINDS_DEFAULT) {
  if (!Array.isArray(item) || item.length < 5) return null;
  const [x, y, w, h, kind, mv, iso] = item;
  if (![x, y, w, h, kind].every((v) => typeof v === 'number')) return null;
  const mover = mv && typeof mv === 'object' && !Array.isArray(mv)
    ? { range: typeof mv.range === 'number' ? mv.range : null, period: typeof mv.period === 'number' ? mv.period : null }
    : null;
  return {
    x, y, w, h, kind,
    kindName: kindNames[kind] || ('kind' + kind),
    mv: mover,
    iso: iso === true,
    // 设计坐标 y 从顶向下：下面这些「上下」判断都按这个约定，**不做翻转**
    left: x, right: x + w, top: y, bottom: y + h,
  };
}

const overlap1d = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);

const boxOf = (p) => ({ x: p.x, y: p.y, w: p.w, h: p.h });

/**
 * 一对相邻平台在几何上属于哪种**形状组合**（纯描述，**不是判定**）。
 *
 * ⚠️ 为什么单独给这个字段：2026-09-23 那次白跑的真正形状是「**向上跳 + 水平投影重叠**」
 * （往上跳，而目标块的水平投影又压着当前块 → 头顶/侧面被挡）。
 * 而「向下跳 + 水平重叠」（台阶式的行与行之间）在关卡里是完全正常的。
 * 只给 `dxOverlap` 一个数，看的人要自己判断方向；把方向一起写出来，才不会误读。
 */
function patternOf({ dxOverlap, dyRise }) {
  const dir = dyRise > 0 ? '向上' : dyRise < 0 ? '向下' : '同高';
  const hor = dxOverlap > 0 ? '水平重叠' : dxOverlap === 0 ? '水平相接' : '水平分离';
  return dir + '+' + hor;
}

/**
 * 一关的几何事实 —— **纯函数，只产生数字与形状描述，不产生「通过/不通过」**。
 *
 * @param plats   `normalizePlat` 之后的数组（保持**声明顺序**；可带 `idx` = 它在关卡表 `plats` 里的 1-based 序号）
 * @param opts.nearPx 「近似贴上」的筛选阈值（默认 48px）—— **这是筛选，不是判定**
 *
 * ⚠️ 所有 `i` / `j` 都报**关卡表 `plats` 里的序号**（`idx`，含 `iso` 项），
 *    不是「非 iso 平台里的第几个」—— 两种口径混用会把两块平台认错（实测踩过）。
 *    另外每条里都内联了 `aBox` / `bBox`，**不看序号也能直接读坐标**。
 */
export function levelGeometry(plats, { nearPx = 48 } = {}) {
  const withIdx = plats.map((p, k) => ({ ...p, idx: Number.isFinite(p.idx) ? p.idx : k + 1 }));
  const solid = withIdx.filter((p) => !p.iso);
  const bbox = solid.length
    ? {
      left: Math.min(...solid.map((p) => p.left)), right: Math.max(...solid.map((p) => p.right)),
      top: Math.min(...solid.map((p) => p.top)), bottom: Math.max(...solid.map((p) => p.bottom)),
    }
    : null;

  // ① 相邻声明对（脚本注释：平台按**通关路径顺序**声明）
  const adjacent = [];
  for (let i = 0; i + 1 < solid.length; i += 1) {
    const a = solid[i];
    const b = solid[i + 1];
    const dxOverlap = overlap1d(a.left, a.right, b.left, b.right);
    const dyRise = a.top - b.top;                  // >0 = 后者更高（设计坐标 y 向下）
    adjacent.push({
      i: a.idx, j: b.idx,
      from: a.kindName, to: b.kindName,
      aBox: boxOf(a), bBox: boxOf(b),
      dxOverlap,                                   // >0 = 水平投影重叠多少 px
      dxGap: dxOverlap < 0 ? -dxOverlap : 0,       // >0 = 水平缝多少 px（分离）
      dyRise,                                      // >0 = 后者更高
      dyBottomDelta: a.bottom - b.bottom,
      rising: dyRise > 0,
      overlapped: dxOverlap > 0,
      pattern: patternOf({ dxOverlap, dyRise }),
    });
  }

  // ② 两两：水平投影重叠 且 垂直方向「贴得很近或直接穿插」
  const nearMiss = [];
  const overlaps = [];
  for (let i = 0; i < solid.length; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      const a = solid[i];
      const b = solid[j];
      const dxOverlap = overlap1d(a.left, a.right, b.left, b.right);
      if (dxOverlap <= 0) continue;                // 水平都不重叠，谈不上贴/撞
      const dyOverlap = overlap1d(a.top, a.bottom, b.top, b.bottom);
      if (dyOverlap > 0) {
        overlaps.push({
          i: a.idx, j: b.idx, a: a.kindName, b: b.kindName,
          aBox: boxOf(a), bBox: boxOf(b),
          dxOverlap, dyOverlap,
          note: '两块平台的矩形**真的相交**了 ' + dxOverlap + '×' + dyOverlap + ' px',
        });
        continue;
      }
      // 垂直分离：谁在上，净空多少
      const upper = a.bottom <= b.top ? a : b;
      const lower = upper === a ? b : a;
      const clearance = lower.top - upper.bottom;
      if (clearance <= nearPx) {
        nearMiss.push({
          i: upper.idx, j: lower.idx,
          upper: upper.kindName, lower: lower.kindName,
          upperBox: boxOf(upper), lowerBox: boxOf(lower),
          dxOverlap, clearance,
          note: '上面那块的**底面**与下面那块的**顶面**只差 ' + clearance + ' px，水平方向重叠 ' + dxOverlap + ' px',
        });
      }
    }
  }

  const kinds = {};
  for (const p of withIdx) kinds[p.kindName] = (kinds[p.kindName] || 0) + 1;

  return {
    count: withIdx.length,
    solidCount: solid.length,
    isoCount: withIdx.length - solid.length,
    kinds,
    bbox,
    spanX: bbox ? bbox.right - bbox.left : null,
    spanY: bbox ? bbox.bottom - bbox.top : null,
    adjacent,
    overlaps,
    nearMiss,
    nearPxUsed: nearPx,
    // 一次性把「向上 + 水平重叠」这种形状挑出来 —— **是分类，不是判定**
    risingOverlaps: adjacent.filter((a) => a.rising && a.overlapped).map((a) => ({ i: a.i, j: a.j, dxOverlap: a.dxOverlap, dyRise: a.dyRise, pattern: a.pattern })),
  };
}

/**
 * 把 `extractLevelTable` 的结果整成「每关一张卡」。
 *
 * 刻意**不输出**任何 `ok/pass/reachable` 字段 —— 判决是玩法的，不是工具的。
 */
export function describeLevels(levels, { kindNames = KINDS_DEFAULT, nearPx = 48, which = null } = {}) {
  const out = [];
  for (let k = 0; k < levels.length; k += 1) {
    const lv = levels[k];
    if (!lv || typeof lv !== 'object' || Array.isArray(lv)) continue;
    const rawPlats = Array.isArray(lv.plats) ? lv.plats : [];
    // ⚠️ `idx` = 它在**关卡表 plats 里的 1-based 序号**（含 iso 项）——
    //    几何事实里的 i/j 全用这个口径，保证「序号 → 表里那块平台」是一一对应的。
    const plats = rawPlats
      .map((p, k) => {
        const n = normalizePlat(p, kindNames);
        return n ? { ...n, idx: k + 1 } : null;
      })
      .filter(Boolean);
    const unparsedPlats = rawPlats.length - plats.length;
    const zones = Array.isArray(lv.zones) ? lv.zones.map((z) => (Array.isArray(z) ? z[4] : null)).filter((s) => typeof s === 'string') : [];
    const card = {
      index: k + 1,
      name: typeof lv.name === 'string' ? lv.name : null,
      hint: typeof lv.hint === 'string' ? lv.hint : null,
      startPhase: lv.startPhase === undefined ? null : lv.startPhase,
      spawn: Array.isArray(lv.spawn) ? { x: lv.spawn[0], y: lv.spawn[1] } : null,
      exit: Array.isArray(lv.exit) ? { x: lv.exit[0], y: lv.exit[1], w: lv.exit[2], h: lv.exit[3] } : null,
      zoneHints: zones,
      platCount: rawPlats.length,
      unparsedPlats,
      plats: plats.map((p) => ({ n: p.idx, x: p.x, y: p.y, w: p.w, h: p.h, kind: p.kind, kindName: p.kindName, mv: p.mv, iso: p.iso })),
      facts: levelGeometry(plats, { nearPx }),
    };
    if (unparsedPlats > 0) {
      card.warning = '有 ' + unparsedPlats + ' 个平台项没能解析成 `{ x, y, w, h, kind … }` —— 几何事实因此**不完整**，别据此下结论';
    }
    if (which === null || which === undefined || which === '') out.push(card);
    else if (String(card.index) === String(which) || (card.name && card.name.includes(String(which)))) out.push(card);
  }
  return out;
}

/**
 * 找画布尺寸常量（有就报**是哪一对**，没有就算了 —— 不猜）。
 *
 * 实测活文件用的是 `DESIGN_W, DESIGN_H = 1600, 1000`（不是 `CANVAS_*`），所以这里按候选名单依次试。
 */
const CANVAS_NAME_PAIRS = [
  ['DESIGN_W', 'DESIGN_H'],
  ['CANVAS_W', 'CANVAS_H'],
  ['SCREEN_W', 'SCREEN_H'],
  ['W', 'H'],
];

export function findCanvas(constants) {
  for (const [wn, hn] of CANVAS_NAME_PAIRS) {
    const w = (constants || []).find((c) => c.name === wn);
    const h = (constants || []).find((c) => c.name === hn);
    if (w && h && typeof w.value === 'number' && typeof h.value === 'number') {
      return { w: w.value, h: h.value, source: wn + '/' + hn };
    }
  }
  return null;
}
