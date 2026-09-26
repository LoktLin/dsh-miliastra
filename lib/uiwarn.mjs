/**
 * uiwarn.mjs — 「已知坑」启发式提醒（P1-3，`miliastra_code op=deploy` / `op=inspect` 的 `warnings[]`）
 *
 * 来源：`C:\Users\Administrator\.dsh\skills\miliastra-code\references\iron-rules-visual-debug.md`（V2 / 二级 L2-V2）。
 * 那 6 轮真机排查逼出两个**平台级**事实：
 *
 *   · **V2**：`sanitize()` 类"清理"动作作用在**带子控件的复合模板实例**上 ⇒ **整卡不画**
 *     （子控件 11 个全在、`visible/active/scale/位置尺寸`全正常，就是不显示）；单图模板加不加都正常。
 *     ⇒ 判据：`sanitize(node, …)` 落在**遍历一张模板表**（`for k, id in pairs(<表>) do`，表里 ≥2 个模板索引）
 *       的循环体里，且**没有被白名单守卫**（`if <变量> ~= "<某个模板名>" then`）收窄。
 *       改法：**白名单只对单图模板调用**。
 *
 *   · **实例化时机是变量**：同一模板、同一位置、同一套 `SetVisible/SetAnchoredPosition/GetChild`，
 *     **build 期建的**不画、**渲染第一帧建的**画（真机实测，只差时机）。
 *     ⇒ 判据：`InstantiateClientUIControl(` 落在**遍历模板表的循环体**里或**构建期函数**
 *       （`OnStart` / `OnInit` / `build` / `init`…）里。改法：挪到**渲染第一帧**再建。
 *
 * ★ 两条都**不阻断、不下判决**（`ok` 语义不变），只进 `warnings[]`：
 *   `{rule, file, line, where, message, fix, doc, evidence}`。措辞一律「**可能**是 / 若…试试」——
 *   工具**不认识**"哪个模板带子控件"（那要读 `.gil` 的控件谱系，见 `miliastra_map op=clientui`），
 *   所以只把**命中的那一行**摆出来，让人/AI 自己判。
 * ★ 认不出来就**不报**（宁可少报，也不制造噪音）：块结构靠**缩进**推（Lua 工程普遍是规整缩进的），
 *   缩进对不上的写法不会命中 —— 这是"启发式"应该有的保守。
 */
import { stripLuaComments } from './rects.mjs';

/** 文档链（不要复述长篇；schema 里也只留指针）。 */
export const UI_WARN_DOC = 'docs/功能详解.md §已知坑（sanitize / 实例化时机）';
export const UI_WARN_DOC_SKILL = '技能 miliastra-code → references/iron-rules-visual-debug.md（V2 / L2-V2）';

/** 构建期函数的函数名（真机实测里"build 期建的"就是这些地方建的）。 */
const BUILD_FN_RE = /^(OnStart|OnEnable|OnInit|build|Build|init|Init|createUI|CreateUI|setup|Setup|OnAwake|Awake)$/;
/** 模板索引的量级（`1073741824` 起；低于这个数的不当模板号）。 */
const TEMPLATE_ID_MIN = 1000000000;
/** 这是不是 `sanitize` 的定义行（定义行不是调用，别命中）。 */
const SANITIZE_DEF_RE = /function\s+sanitize\b/;

const indentOf = (ln) => (ln.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;

/**
 * 用**缩进**推每一行的块上下文（不建 AST：够用、且认不出就不报）。
 * @returns {Array<{text:string, line:number, indent:number, loop:boolean, loopTable:string|null,
 *                  guardTexts:string[], fn:string|null}>}
 */
function contexts(lines) {
  const out = [];
  const stack = [];                 // {indent, kind:'loop'|'block'|'fn', table?:string, text:string}
  let fn = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const text = raw.trim();
    const indent = indentOf(raw);
    // 先按缩进收栈（空行不参与）
    if (text !== '') {
      while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    }
    const loops = stack.filter((s) => s.kind === 'loop');
    out.push({
      text, line: i + 1, indent,
      loop: loops.length > 0,
      loopTable: loops.length ? (loops[loops.length - 1].table || null) : null,
      guardTexts: stack.filter((s) => s.kind === 'block').map((s) => s.text),
      fn,
    });
    if (text === '') continue;
    const fnOpen = /(?:local\s+)?function\s+([A-Za-z_][\w.]*)/.exec(text);
    if (fnOpen) { stack.push({ indent, kind: 'fn', text }); fn = fnOpen[1]; continue; }
    const loopOpen = /\bfor\b[\s\S]*\bdo\b\s*$/.test(text) || /\bwhile\b[\s\S]*\bdo\b\s*$/.test(text);
    if (loopOpen) {
      const t = /(?:pairs|ipairs)\(\s*([A-Za-z_][\w.]*)\s*\)/.exec(text);
      stack.push({ indent, kind: 'loop', table: t ? t[1] : null, text });
      continue;
    }
    if (/\bthen\s*$/.test(text) || /\belse\b\s*$/.test(text) || /\bdo\b\s*$/.test(text)) {
      stack.push({ indent, kind: 'block', text });
    }
  }
  return out;
}

/** 一张表里有几个「模板索引」（≥ `TEMPLATE_ID_MIN` 的字面量）——V2 的"混合集合"静态证据。 */
function templateIdsInTable(code, tableName) {
  if (!tableName) return { found: false, ids: [] };
  const lines = code.split('\n');
  const at = lines.findIndex((l) => new RegExp('local\\s+' + tableName.replace(/\./g, '\\.') + '\\s*=\\s*\\{').test(l));
  if (at < 0) return { found: false, ids: [] };
  let depth = 0;
  const ids = [];
  for (let i = at; i < lines.length; i += 1) {
    for (const ch of lines[i]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
    for (const m of lines[i].match(/\b(\d{9,})\b/g) || []) {
      const v = Number(m);
      if (v >= TEMPLATE_ID_MIN) ids.push(v);
    }
    if (depth <= 0 && i > at) break;
  }
  return { found: true, ids: [...new Set(ids)] };
}

/**
 * 扫一份 Lua 源码里的「已知坑」（**纯函数**）。
 *
 * @param {string} text Lua 正文
 * @param {string} file 文件名（只写进回执）
 * @returns {Array<{rule:string,file:string,line:number,where:string,message:string,fix:string,doc:string,evidence:string}>}
 */
export function uiWarnings(text, file = '') {
  const code = stripLuaComments(text);
  const lines = code.split('\n');
  const ctx = contexts(lines);
  const out = [];
  const where = (l) => file + ':' + l;

  /* ---- 规则 ①：sanitize 作用在「一批模板」上，且没有被白名单守卫 ---- */
  for (const c of ctx) {
    if (!/\bsanitize\s*\(/.test(c.text) || SANITIZE_DEF_RE.test(c.text)) continue;
    if (!c.loop) continue;                                     // 不在循环里 ⇒ 作用对象不是"一批模板"
    const tbl = c.loopTable;
    if (!tbl) continue;                                        // 数字型循环（如遍历子控件）不算"模板表"
    const info = templateIdsInTable(code, tbl);
    if (!info.found || info.ids.length < 2) continue;           // 表里没有 ≥2 个模板索引 ⇒ 不报（宁可少报）
    // 白名单守卫：同一个循环体里、这一行之前出现过 `if <var> ~= "…" then`
    const guarded = c.guardTexts.some((g) => /\bif\b[^\n]*[~=]=[^\n]*".*"/.test(g));
    if (guarded) continue;
    out.push({
      rule: 'v2-sanitize-mixed-templates',
      file, line: c.line, where: where(c.line),
      message: '`sanitize(` 落在遍历模板表 `' + tbl + '`（' + info.ids.length + ' 个模板索引）的循环体里，'
        + '且**没有白名单条件**收窄 —— **可能**是"复合模板（带子控件的）与单图模板同批被清理"：'
        + '真机上复合模板被 sanitize 过 ⇒ **整卡不显示**（子控件 / 尺寸 / `visible` 全正常，就是不画）。',
      fix: '**白名单**：只对"单图类"模板调用（`if <角色/名字> ~= "<复合模板>" then sanitize(node, 1) end`）。',
      doc: UI_WARN_DOC + ' ｜ ' + UI_WARN_DOC_SKILL,
      evidence: c.text.slice(0, 160),
    });
  }

  /* ---- 规则 ②：在构建循环 / 构建期函数里 InstantiateClientUIControl ---- */
  for (const c of ctx) {
    if (!/InstantiateClientUIControl\s*\(/.test(c.text)) continue;
    const inLoop = c.loop && !!c.loopTable;
    const inBuildFn = !!(c.fn && BUILD_FN_RE.test(c.fn));
    if (!inLoop && !inBuildFn) continue;
    const tmpl = /InstantiateClientUIControl\(\s*([^,)]+)/.exec(c.text);
    const info = inLoop ? templateIdsInTable(code, c.loopTable) : { found: false, ids: [] };
    out.push({
      rule: 'instantiate-in-build-phase',
      file, line: c.line, where: where(c.line),
      message: '`InstantiateClientUIControl(` 在' + (inLoop ? '构建循环（模板表 `' + c.loopTable + '`' + (info.ids.length ? '，' + info.ids.length + ' 个索引' : '') + '）' : '构建期函数 `' + c.fn + '`')
        + '里被调用（模板 ' + (tmpl ? tmpl[1].trim().slice(0, 40) : '?') + '）—— 真机实测**实例化时机是变量**：'
        + '同一模板同一位置，build 期建的**不画**、**渲染第一帧**建的画。',
      fix: '若整卡不显示（而 `visible`/子控件数/位置尺寸全正常），把这一句挪到**渲染第一帧**再建（如 `OnUpdate` 首帧分支），'
        + '或在建完的**下一帧**再 `SetVisible(true)`。',
      doc: UI_WARN_DOC + ' ｜ ' + UI_WARN_DOC_SKILL,
      evidence: c.text.slice(0, 160),
    });
  }
  return out;
}

/**
 * 从文件路径列表里读文本并扫坑（**只读**，不写任何文件）。
 *
 * @param {Array<string>} paths 绝对路径
 * @param {{readFileSync?: Function, basename?: Function}} [io] 读文件用的两个函数（可注入，便于单测）
 * @returns {{warnings:Array, files:Array<{path:string,bytes:number}>, skipped:Array<{path:string,reason:string}>}}
 */
export function uiWarningsOfFiles(paths, io = {}) {
  const readFileSync = typeof io.readFileSync === 'function' ? io.readFileSync : null;
  const basename = typeof io.basename === 'function' ? io.basename : null;
  const warnings = [];
  const files = [];
  const skipped = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!p) continue;
    if (!readFileSync) { skipped.push({ path: p, reason: '没有提供 readFileSync（调用方 bug）' }); continue; }
    let text;
    try { text = readFileSync(p, 'utf8'); } catch (e) {
      skipped.push({ path: p, reason: '读不动：' + ((e && e.message) || e) });
      continue;
    }
    files.push({ path: p, bytes: Buffer.byteLength(text, 'utf8') });
    warnings.push(...uiWarnings(text, basename ? basename(p) : p));
  }
  return { warnings, files, skipped };
}
