/**
 * uilint.mjs — **平台级 UI 门禁**（`miliastra_code op=lint-ui`，P0-1）
 *
 * 为什么要有它（2026-09-26 实盘）：为了守住 4 条**平台级、与玩法无关**的 UI 硬约束，
 * 每个千星工作区都在自己维护一份 `tools/check-ui-contract.mjs` —— 重复劳动，而且**判据必然漂移**。
 * 其中第 ④ 条是「**离线唯一能拦**」的：文本框矩形高容不下字号行高时，真机上该控件
 * **一个像素都不画**（不裁切、不缩小、不报错，`visible` 仍为 true），而模拟器**不模拟**这个截断。
 *
 * 本模块是**纯函数**（只吃文本，不碰文件），把工作区基线工具
 * `C:\Users\Administrator\Desktop\yuanshen\tools\check-ui-contract.mjs` 的判据**逐条移植**成通用口径：
 *
 *   ① `pairsMismatch`   —— 画在哪 = 点哪算：**人点名的**对照（`ovB1` ↔ `T_START` 这类异名）必须逐字一致。
 *      同名**自动配对**出来的差异另放 `sameNameDiff`（**事实，不计入 `passed`**：不同界面复用同名控件是合法的，
 *      工具不猜语义 —— 基线工具也正是只比它硬编码的那份对照表）。
 *   ② `notMultipleOf8`  —— 坐标 / 尺寸是 **8 的倍数**（平台对齐口径）。
 *   ③ `badFontSize`     —— 字号只许 **64 / 52 / 28 / 22** 四档（默认，可覆盖）。
 *   ④ `textTooShort`    —— 文本框（含 `makeBtn` 的文字）矩形高 `h ≥ 字号 × 1.4` **且** `h ≥ 字号 + 16`（真机静默不画）。
 *
 * ★ **作用域（`nameFilter`）必须显式**：基线工具只覆盖**覆盖层**那些名字（`ov|pk|cx|mx` 前缀 + 它硬编码的对照表），
 *   所以它在《侦探杀》上 0 问题；同一份工程里**别的层**（图鉴 / 弹窗 / 开始场景）本来就不在这些判据里。
 *   本模块**不替任何玩法写死前缀** —— `uiConfig.nameFilter` 给正则（默认 `null` = 全部名字），
 *   要复现工作区那份基线口径就把它传成 `^(ov|pk|cx|mx)`，并用 `pairs` 点名那几张对照表。
 *
 * ★ **只报数字与位置，不下判决**：每条判据一个数组，元素 `{file,line,name,expected,actual,delta}`；
 *   `passed` **只代表"这几条判据全满足"**，不代表 UI 合格（好不好看、合不合适是作者的判断）。
 * ★ 基线工具里那几条**项目专有**的检查（格盘四方一致、1:2:1 三栏、热区必须落在某块面板内）依赖
 *   《侦探杀》的具体变量名与布局，**没有**移植 —— 它们在 `portNote` 里如实说明。
 */
import { scanRects, stripLuaComments } from './rects.mjs';

/** 平台默认档位（工作区可用 `uiConfig` 覆盖，覆盖值会原样回在 `usedConfig` 里）。 */
export const UI_LINT_DEFAULTS = Object.freeze({
  grid: 8,
  fonts: Object.freeze([64, 52, 28, 22]),
  lineHeight: 1.4,
  slack: 16,
  coordMin: 8,
  coordMax: 1600,
});

/**
 * 把调用方给的档位夹成**可复现**的一份（非法值一律回默认，并在 `usedConfig.note` 里说）。
 *
 * @param {Record<string, any>} [cfg] 覆盖项：`grid` / `fonts` / `lineHeight` / `slack` / `coordMin` / `coordMax` / `nameFilter`
 * @returns {any} 夹好的一份（`nameFilter` / `nameRe` 也在里面）
 */
export function resolveUiConfig(cfg = {}) {
  /** @type {any} */
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const notes = [];
  const num = (v, dflt, lo, hi, label) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    const clamped = Math.min(hi, Math.max(lo, n));
    if (clamped !== n) notes.push(label + ' 夹到 ' + clamped + '（收到 ' + n + '）');
    return clamped;
  };
  const grid = num(c.grid, UI_LINT_DEFAULTS.grid, 1, 200, 'grid');
  const lineHeight = num(c.lineHeight, UI_LINT_DEFAULTS.lineHeight, 1, 4, 'lineHeight');
  const slack = num(c.slack, UI_LINT_DEFAULTS.slack, 0, 200, 'slack');
  const coordMin = num(c.coordMin, UI_LINT_DEFAULTS.coordMin, 0, 10000, 'coordMin');
  const coordMax = num(c.coordMax, UI_LINT_DEFAULTS.coordMax, 1, 100000, 'coordMax');
  let fonts = Array.isArray(c.fonts) ? c.fonts.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : null;
  if (!fonts || !fonts.length) fonts = [...UI_LINT_DEFAULTS.fonts];
  else if (fonts.some((x) => !UI_LINT_DEFAULTS.fonts.includes(x))) notes.push('fonts 被覆盖成 ' + fonts.join('/'));
  // 名字作用域：默认 null = 全部名字；给了正则就只判匹配的（基线的口径就是这个）
  let nameFilter = null;
  let nameRe = null;
  if (typeof c.nameFilter === 'string' && c.nameFilter.trim()) {
    nameFilter = c.nameFilter.trim();
    try { nameRe = new RegExp(nameFilter); } catch (e) { notes.push('nameFilter 不是合法正则（已忽略）：' + ((e && e.message) || e)); nameFilter = null; nameRe = null; }
  }
  return {
    grid, fonts: [...new Set(fonts)].sort((a, b) => b - a), lineHeight, slack, coordMin, coordMax,
    nameFilter, nameRe,
    note: notes.length ? notes.join('；') : null,
  };
}

/** 一个文件里的字号声明：`setFont("name", N)` / `X.c.fontSize = N`（含 `local X = add("name", …)` 的反查）。 */
export function scanFontSizes(text, file = '') {
  const code = stripLuaComments(text);
  const lines = code.split('\n');
  const varToName = new Map();
  for (const ln of lines) {
    const m = ln.match(/local\s+(\w+)\s*=\s*add\("([^"]+)"/);
    if (m) varToName.set(m[1], m[2]);
  }
  const out = [];
  lines.forEach((ln, i) => {
    let m = ln.match(/setFont\(\s*"([^"]+)"\s*,\s*(\d+)\s*\)/);
    if (m) { out.push({ file, line: i + 1, name: m[1], size: Number(m[2]), via: 'setFont' }); return; }
    m = ln.match(/add\(\s*"([^"]+)"[^)]*\)\.c\.fontSize\s*=\s*(\d+)/);
    if (m) { out.push({ file, line: i + 1, name: m[1], size: Number(m[2]), via: 'inline' }); return; }
    m = ln.match(/(\w+)\.c\.fontSize\s*=\s*(\d+)/);
    if (m) { out.push({ file, line: i + 1, name: varToName.get(m[1]) || null, size: Number(m[2]), via: 'inline' }); }
  });
  return out;
}

/** 数值是不是在"坐标"的量级里（屏幕外的 `-9999`、面积超画布的值都不当坐标判）。 */
function isCoordInScope(v, cfg) {
  return Number.isFinite(v) && v >= cfg.coordMin && v <= cfg.coordMax;
}

/** 保留 2 位小数（只用于文案里的算式，去掉浮点尾巴）。 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** 一个人在 pairs 里点名的对照：数组、`{a,b}`、或带文件限定的 `{a,b,aFile,bFile}`。 */
function parsePair(raw) {
  if (Array.isArray(raw)) return { a: raw[0], b: raw[1], aFile: raw[2] || null, bFile: raw[3] || null };
  if (raw && typeof raw === 'object') return { a: raw.a, b: raw.b, aFile: raw.aFile || null, bFile: raw.bFile || null };
  return { a: null, b: null, aFile: null, bFile: null };
}
const fileHit = (name, want) => (!want ? true : String(name).toLowerCase().includes(String(want).toLowerCase()));

/**
 * 跑一遍门禁（**纯函数**）。
 *
 * @param {{files?:Array<{name:string,path?:string,text:string}>, pairs?:Array<any>, config?:object}} [input]
 *   `files` = 要扫的文件（`name` 写进回执；`text` 是正文）；`pairs` = 人点名的对照
 *   （`[["ovB1","T_START"]]` / `[{a:"btnSet",b:"BTN_SET"}]`；要限定文件就加 `aFile`/`bFile` 子串）；
 *   `config` = 档位与作用域覆盖（见 `resolveUiConfig`）。
 * @returns {{usedConfig:object, checks:object, counts:object, passed:boolean, skipped:Array,
 *            unresolved:Array, portNote:string, disclaimer:string}}
 */
export function lintUiFiles({ files = [], pairs = null, config = {} } = {}) {
  const usedConfig = resolveUiConfig(config);
  const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.text === 'string');
  const skipped = [];
  const unresolved = [];
  const inScope = (name) => (!usedConfig.nameRe ? true : usedConfig.nameRe.test(String(name == null ? '' : name)));

  /* ---- 抽取：矩形（复用 op=rects 的扫描器）+ 字号 ---- */
  const allRects = [];
  const fonts = [];
  for (const f of list) {
    const { rects } = scanRects(f.text, f.name);
    for (const r of rects) allRects.push({ ...r, file: f.name });
  }
  for (const f of list) fonts.push(...scanFontSizes(f.text, f.name));
  const sizeOf = new Map();
  for (const s of fonts) if (s.name && !sizeOf.has(s.name)) sizeOf.set(s.name, s.size);

  /* ---- ①a 人点名的对照（契约；计入 passed） ---- */
  const byName = new Map();
  for (const r of allRects) {
    if (!r.name || !r.rect) continue;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const pickNamed = (name, fileWant) => (byName.get(String(name == null ? '' : name)) || []).filter((r) => fileHit(r.file, fileWant));
  const pairsMismatch = [];
  if (Array.isArray(pairs)) {
    for (const raw of pairs) {
      const p = parsePair(raw);
      const A = pickNamed(p.a, p.aFile);
      const B = pickNamed(p.b, p.bFile);
      if (!A.length || !B.length) {
        unresolved.push({ pair: [p.a, p.b], aFile: p.aFile, bFile: p.bFile, reason: !A.length ? '找不到 ' + p.a : '找不到 ' + p.b });
        continue;
      }
      for (const ra of A) {
        for (const rb of B) {
          const delta = rb.rect.map((v, i) => v - ra.rect[i]);
          if (delta.every((d) => d === 0)) continue;
          pairsMismatch.push({
            file: rb.file, line: rb.line, name: String(p.a) + ' ↔ ' + String(p.b),
            expected: ra.rect, actual: rb.rect, delta,
            pairWith: { file: ra.file, line: ra.line, name: ra.name },
          });
        }
      }
    }
  }

  /* ---- ①b 同名跨文件的差异（**事实，不计入 passed**：工具不猜语义） ---- */
  const sameNameDiff = [];
  for (const [name, group] of byName) {
    const filesSeen = new Set(group.map((r) => r.file));
    if (filesSeen.size < 2) continue;
    const head = group[0];
    for (const r of group.slice(1)) {
      const delta = r.rect.map((v, i) => v - head.rect[i]);
      if (delta.every((d) => d === 0)) continue;
      sameNameDiff.push({
        file: r.file, line: r.line, name,
        expected: head.rect, actual: r.rect, delta,
        pairWith: { file: head.file, line: head.line, name: head.name },
      });
    }
  }

  /* ---- ② 坐标 / 尺寸是 8 的倍数（作用域内） ---- */
  const notMultipleOf8 = [];
  for (const r of allRects) {
    if (!r.rect || !inScope(r.name)) continue;
    r.rect.forEach((v, i) => {
      if (!isCoordInScope(v, usedConfig)) return;
      if (v % usedConfig.grid === 0) return;
      notMultipleOf8.push({
        file: r.file, line: r.line, name: r.name,
        expected: usedConfig.grid + ' 的倍数', actual: v, delta: v % usedConfig.grid, slot: i,
      });
    });
  }

  /* ---- ③ 字号只许固定档位（作用域内） ---- */
  const badFontSize = [];
  for (const s of fonts) {
    if (s.name && !inScope(s.name)) continue;
    if (usedConfig.fonts.includes(s.size)) continue;
    badFontSize.push({
      file: s.file, line: s.line, name: s.name,
      expected: usedConfig.fonts.join(' / '), actual: s.size, delta: null, via: s.via,
    });
  }

  /* ---- ④ 文本框矩形高 ≥ 字号×1.4 且 ≥ 字号+16（作用域内） ---- */
  const textTooShort = [];
  const pushShort = (file, line, name, h, size) => {
    const byLine = size * usedConfig.lineHeight;
    const bySlack = size + usedConfig.slack;
    const need = Math.max(byLine, bySlack);
    if (h >= need) return;
    textTooShort.push({
      file, line, name,
      expected: 'h ≥ max(' + round2(byLine) + ', ' + round2(bySlack) + ')（字号 ' + size
        + ' ×lineHeight ' + usedConfig.lineHeight + ' = ' + round2(byLine) + '；字号+' + usedConfig.slack + ' = ' + round2(bySlack) + '）',
      actual: h, delta: round2(h - need), fontSize: size,
    });
  };
  for (const r of allRects) {
    if (r.source !== 'add' || String(r.kind || '') !== 'txt') continue;
    if (!inScope(r.name)) continue;
    if (!r.rect) {
      // 动态控件名（`add("pkR" .. i, "txt", …)`）算不出每行矩形 —— 如实列进 skipped，不当成"合格"
      skipped.push({ file: r.file, line: r.line, name: r.name, why: '动态控件名的文本框（公式矩形，认不出）' });
      continue;
    }
    const h = r.rect[3];
    const size = sizeOf.get(r.name);
    if (!Number.isFinite(size)) {
      skipped.push({ file: r.file, line: r.line, name: r.name, why: '文本框但字号认不出（既没有 setFont 也没有 .c.fontSize）—— **不判**（不拿默认值顶）' });
      continue;
    }
    pushShort(r.file, r.line, r.name, h, size);
  }
  // `makeBtn(name, x, y, w, h)` 的文字固定 28 号、矩形 = 按钮矩形（与基线同口径）
  for (const f of list) {
    const re = /makeBtn\(\s*"([^"]+)"\s*,\s*\d+\s*,\s*[^,]+,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
    const code = stripLuaComments(f.text);
    let m;
    let line = 0;
    let idx = 0;
    while ((m = re.exec(code)) !== null) {
      while (code.indexOf('\n', idx) !== -1 && code.indexOf('\n', idx) < m.index) { line += 1; idx = code.indexOf('\n', idx) + 1; }
      if (!inScope(m[1])) continue;
      pushShort(f.name, line + 1, m[1] + '（makeBtn 文字）', Number(m[3]), 28);
    }
  }

  const checks = { pairsMismatch, sameNameDiff, notMultipleOf8, badFontSize, textTooShort };
  const counts = {
    files: list.length,
    rects: allRects.length,
    rectsWithNumbers: allRects.filter((r) => r.rect).length,
    fontDeclarations: fonts.length,
    pairsChecked: Array.isArray(pairs) ? pairs.length : 0,
    pairsMismatch: pairsMismatch.length,
    sameNameDiff: sameNameDiff.length,
    notMultipleOf8: notMultipleOf8.length,
    badFontSize: badFontSize.length,
    textTooShort: textTooShort.length,
    skipped: skipped.length,
    unresolvedPairs: unresolved.length,
  };
  const passed = counts.pairsMismatch === 0 && counts.notMultipleOf8 === 0
    && counts.badFontSize === 0 && counts.textTooShort === 0;
  return {
    usedConfig: {
      grid: usedConfig.grid, fonts: usedConfig.fonts, lineHeight: usedConfig.lineHeight,
      slack: usedConfig.slack, coordMin: usedConfig.coordMin, coordMax: usedConfig.coordMax,
      nameFilter: usedConfig.nameFilter, note: usedConfig.note,
    },
    checks,
    counts,
    passed,
    skipped,
    unresolved,
    portNote: '判据取自工作区基线 `tools/check-ui-contract.mjs`（画在哪=点哪算 / 8 的倍数 / 字号四档 / 文本框高 ≥ 字号×1.4 且 ≥ 字号+16）；'
      + '基线里那几条**项目专有**的检查（格盘四方一致 / 1:2:1 三栏 / 热区必须落在指定面板内 / 逐按钮对照表）依赖该玩法的变量名与布局，'
      + '**没有**移植 —— 要那一层请继续用工作区那份脚本。`sameNameDiff` 只是**同名跨文件差异的事实**（不同界面复用同名控件是合法的），**不计入 `passed`**。',
    disclaimer: '`passed` **只代表上面这几条判据全满足，不代表 UI 合格**（好看不好看、合不合适是作者的判断）；'
      + '本工具**只报数字与位置**，不改任何文件。',
  };
}
