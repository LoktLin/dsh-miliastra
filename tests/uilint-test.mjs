/**
 * P0-1 自测：平台级 UI 门禁 `miliastra_code op=lint-ui`（2026-09-26 施工单）
 *
 * 「修之前为什么红」分三层写在这里：
 *   ① **根本没有这个 op** —— 四条判据只活在**工作区自己那份** `tools/check-ui-contract.mjs` 里，
 *      每个千星工程各维护一份 ⇒ 判据必然漂移；插件侧没有任何入口。
 *   ② 判据有 4 条（画在哪=点哪算 / 8 的倍数 / 字号四档 / **文本框高 ≥ 字号×1.4 且 ≥ 字号+16**），
 *      最后一条是**离线唯一能拦**的：真机上高度不够 ⇒ 该控件一个像素都不画（模拟器不模拟）。
 *   ③ 验收要**两次真跑**：工作区基线 0 问题 ⇒ 新 op `passed:true`；人为把文本高改成 字号×1.3 ⇒ 必须报出 `file:line`。
 *
 * ⚠️ 真机那两次跑需要工作区那棵《侦探杀》工程；读不到时**跳过并如实说明**（不伪装成通过）。
 *    示例目录可用 `MILIASTRA_UI_SAMPLE_DIR` 覆盖。
 *
 * 用法：node tests/uilint-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-uilint-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const savedData = process.env.MILIASTRA_DATA_DIR;
const savedBak = process.env.MILIASTRA_BACKUP_DIR;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');
process.env.MILIASTRA_BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.MILIASTRA_LOCALLOW = path.join(tmpRoot, 'no-such-locallow');

let pass = 0;
const failures = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const { TOOLS } = await import('../index.js');
const { lintUiFiles, resolveUiConfig, UI_LINT_DEFAULTS } = await import('../lib/uilint.mjs');
const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');

/** 工作区那份基线工具覆盖的工程（验收样例）。 */
const SAMPLE_DIR = process.env.MILIASTRA_UI_SAMPLE_DIR
  || 'C:/Users/Administrator/Desktop/yuanshen/code/侦探1';
/** 工作区基线里那份**硬编码的对照表**（异名控件：名字不同、其实是同一个）。带文件限定，
 *  因为《侦探杀》里 `btnNext` 在 `调查板 board.lua` 与 `图鉴 codex.lua` 里是**两个不同的按钮**。 */
const SAMPLE_PAIRS = [
  { a: 'btnSet', b: 'BTN_SET', aFile: '调查板 board.lua', bFile: '交互 input.lua' },
  { a: 'tabScene', b: 'TAB_SCENE' }, { a: 'tabLog', b: 'TAB_LOG' }, { a: 'tabTerm', b: 'TAB_TERM' },
  { a: 'jd1', b: 'JD1' }, { a: 'jd2', b: 'JD2' }, { a: 'jd3', b: 'JD3' }, { a: 'campBtn', b: 'CAMP_BTN' },
  { a: 'btnEnd', b: 'BTN_END', aFile: '调查板 board.lua', bFile: '交互 input.lua' },
  { a: 'btnNext', b: 'BTN_NEXT', aFile: '调查板 board.lua', bFile: '交互 input.lua' },
  { a: 'btnAgain', b: 'BTN_AGAIN', aFile: '调查板 board.lua', bFile: '交互 input.lua' },
];
/** 基线只判「覆盖层」那些名字（`ov|pk|cx|mx`）—— 复现同一口径要用它。 */
const SAMPLE_UI_CONFIG = { nameFilter: '^(ov|pk|cx|mx)' };

const sampleDir = sampleDirExists() ? SAMPLE_DIR : null;
function sampleDirExists() {
  try { return fs.statSync(SAMPLE_DIR).isDirectory(); } catch { return false; }
}

/* ============================================================ 一、纯函数：四条判据各自能被抓住 */

await check('①② 8 的倍数：`add("x","txt",…)` 里 20 不是 8 的倍数 → 报 file:line + expected/actual/delta', () => {
  const r = lintUiFiles({
    files: [{ name: 'view.lua', text: 'add("box", "img", 96, 20, 400, 80)\n' }],
  });
  assert(r.passed === false, '不是 8 的倍数竟然 passed');
  assert(r.checks.notMultipleOf8.length === 1, '没报出来：' + JSON.stringify(r.checks.notMultipleOf8));
  const e = r.checks.notMultipleOf8[0];
  assert(e.file === 'view.lua' && e.line === 1 && e.name === 'box', 'file/line/name 不对：' + JSON.stringify(e));
  assert(e.actual === 20 && e.delta === 4 && /8 的倍数/.test(e.expected), 'expected/actual/delta 不对：' + JSON.stringify(e));
  return `${e.where || e.file + ':' + e.line} ${e.name} actual=${e.actual} delta=${e.delta}`;
});

await check('② 屏幕外的 -9999 与 0 不当坐标判（不制造噪音）', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'add("off", "img", -9999, -9999, 64, 64)\nadd("z", "img", 0, 0, 8, 8)\n' }] });
  assert(r.checks.notMultipleOf8.length === 0, '把屏幕外的值当坐标判了：' + JSON.stringify(r.checks.notMultipleOf8));
  return '2 条都不判';
});

await check('③ 字号四档：46 号不在 64/52/28/22 里 → 报出且 expected 列出四档', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'setFont("pTitle", 46)\n' }] });
  assert(r.passed === false && r.checks.badFontSize.length === 1, '没抓住：' + JSON.stringify(r.checks.badFontSize));
  const e = r.checks.badFontSize[0];
  assert(e.name === 'pTitle' && e.actual === 46 && /64/.test(e.expected) && /22/.test(e.expected), '字段不对：' + JSON.stringify(e));
  return `${e.file}:${e.line} ${e.name} actual=${e.actual} expected=${e.expected}`;
});

await check('④ 文本框高：字号 52 放在 64 高（< 52×1.4=72.8 也 < 52+16=68）→ 必须报（真机静默不画）', () => {
  const r = lintUiFiles({
    files: [{ name: 'v.lua', text: 'add("ovT", "txt", 320, 240, 960, 64)\nsetFont("ovT", 52)\n' }],
  });
  assert(r.passed === false && r.checks.textTooShort.length === 1, '没抓住：' + JSON.stringify(r.checks.textTooShort));
  const e = r.checks.textTooShort[0];
  assert(e.name === 'ovT' && e.actual === 64 && e.fontSize === 52, '字段不对：' + JSON.stringify(e));
  assert(/72\.8/.test(e.expected) && /68/.test(e.expected), 'expected 要同时给出两条算式：' + JSON.stringify(e.expected));
  return `expected=${e.expected} actual=${e.actual} delta=${e.delta}`;
});

await check('④ 边界：28 号放 40 高（≥39.2 但 <44）→ 仍然报（FP-A 真机打脸那条绝对余量）', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'add("hudT", "txt", 104, 104, 400, 40)\nsetFont("hudT", 28)\n' }] });
  assert(r.checks.textTooShort.length === 1, '绝对余量那条没生效：' + JSON.stringify(r.checks));
  return '28 号 / 40 高被拦下（1.4× 单独不够）';
});

await check('④ 边界：28 号放 48 高 → 合格（两条都过）', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'add("msg", "txt", 104, 104, 400, 48)\nsetFont("msg", 28)\n' }] });
  assert(r.passed === true && r.checks.textTooShort.length === 0, '48 高被误报/其它判据红了：' + JSON.stringify(r.checks));
  return '28 号 / 48 高合格';
});

await check('④ 字号认不出的文本框**不判**（进 skipped，不拿默认值顶）', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'add("who", "txt", 104, 104, 400, 24)\n' }] });
  assert(r.checks.textTooShort.length === 0, '认不出字号却判了：' + JSON.stringify(r.checks.textTooShort));
  assert(r.skipped.length === 1 && /字号认不出/.test(r.skipped[0].why), '没如实说跳过：' + JSON.stringify(r.skipped));
  return 'skipped: ' + r.skipped[0].why.slice(0, 24);
});

await check('① 画在哪=点哪算：**点名**的一对不一致 → 报 expected/actual/delta（带 pairWith）', () => {
  const r = lintUiFiles({
    files: [
      { name: '表现 view.lua', text: 'add("btnSet", "img", 100, 100, 200, 64)\n' },
      { name: '交互 input.lua', text: 'local BTN_SET = { 100, 100, 200, 72 }\n' },
    ],
    pairs: [['btnSet', 'BTN_SET']],
  });
  assert(r.passed === false && r.checks.pairsMismatch.length === 1, '没抓住点名对照：' + JSON.stringify(r.checks));
  const e = r.checks.pairsMismatch[0];
  assert(e.name === 'btnSet ↔ BTN_SET' && e.expected[3] === 64 && e.actual[3] === 72 && e.delta[3] === 8, '字段不对：' + JSON.stringify(e));
  assert(e.pairWith && /view/.test(e.pairWith.file), '没标出对的是哪一行：' + JSON.stringify(e.pairWith));
  return `${e.file}:${e.line} ${e.name} delta=${JSON.stringify(e.delta)}`;
});

await check('① 同名跨文件差异**只报事实、不计入 passed**（不同界面复用同名控件是合法的）', () => {
  const r = lintUiFiles({
    files: [
      { name: 'a.lua', text: 'add("btnNext", "img", 1140, 120, 220, 64)\n' },
      { name: 'b.lua', text: 'add("btnNext", "img", 820, 500, 340, 84)\n' },
    ],
  });
  assert(r.checks.sameNameDiff.length === 1, '同名差异没报：' + JSON.stringify(r.checks));
  // 8 的倍数那一条会红（820/340/84）—— 这里单独看 sameNameDiff 不进 passed 的语义：把坐标换成合规值时 passed 必须转 true
  const clean = lintUiFiles({
    files: [
      { name: 'a.lua', text: 'add("btnNext", "img", 1144, 120, 224, 64)\n' },
      { name: 'b.lua', text: 'add("btnNext", "img", 824, 504, 344, 88)\n' },
    ],
  });
  assert(clean.checks.sameNameDiff.length === 1 && clean.passed === true,
    'sameNameDiff 不该计入 passed：' + JSON.stringify({ c: clean.counts, passed: clean.passed }));
  return 'sameNameDiff=1 而 passed=true';
});

await check('① 点名的名字找不到 → 进 unresolved（如实说找不到哪个），不假装比过', () => {
  const r = lintUiFiles({ files: [{ name: 'a.lua', text: 'add("x", "img", 8, 8, 8, 8)\n' }], pairs: [['ovB1', 'T_START']] });
  assert(r.checks.pairsMismatch.length === 0 && r.unresolved.length === 1, 'unresolved 不对：' + JSON.stringify(r.unresolved));
  assert(/找不到 ovB1/.test(r.unresolved[0].reason), '没说是哪个找不到：' + JSON.stringify(r.unresolved[0]));
  return r.unresolved[0].reason;
});

/* ============================================================ 二、档位覆盖与回执形状 */

await check('usedConfig：覆盖 grid/fonts/lineHeight/slack 后原样回执，passed 随档位变', () => {
  const cfg = { grid: 4, fonts: [40], lineHeight: 1.2, slack: 4 };
  const text = 'add("a", "txt", 104, 24, 400, 48)\nsetFont("a", 40)\n';
  const r = lintUiFiles({ files: [{ name: 'v.lua', text }], config: cfg });
  assert(r.usedConfig.grid === 4 && r.usedConfig.fonts.join() === '40', 'usedConfig 没回实际值：' + JSON.stringify(r.usedConfig));
  assert(r.usedConfig.lineHeight === 1.2 && r.usedConfig.slack === 4, 'usedConfig 缺系数：' + JSON.stringify(r.usedConfig));
  assert(r.passed === true, '按覆盖档位应当合格：' + JSON.stringify(r.checks));
  // 同一份文本用默认档位：40 号不在四档里（且 24 不是 8 的倍数）⇒ 必须红
  const d = lintUiFiles({ files: [{ name: 'v.lua', text }] });
  assert(d.passed === false, '默认档位下竟然合格');
  return 'grid=4/fonts=[40] → passed；默认档 → ' + d.counts.notMultipleOf8 + ' 处非 8 倍数 + ' + d.counts.badFontSize + ' 处字号';
});

await check('非法档位夹住并在 usedConfig.note 里说（不静默接受离谱值）', () => {
  const r = resolveUiConfig({ grid: 0, lineHeight: 99, fonts: [] });
  assert(r.grid >= 1 && r.grid <= 200 && r.lineHeight <= 4, '没夹住：' + JSON.stringify(r));
  assert(/夹到/.test(r.note || ''), '夹住了却不说：' + JSON.stringify(r.note));
  assert(r.nameFilter === null, 'nameFilter 默认应当是 null（全部名字）');
  const bad = resolveUiConfig({ nameFilter: '(' });
  assert(bad.nameFilter === null && /不是合法正则/.test(bad.note || ''), '非法正则没如实说：' + JSON.stringify(bad));
  return 'grid/lineHeight 夹住（' + r.note + '）；非法正则忽略并说明';
});

await check('回执里写明「passed 只代表判据全满足，不代表 UI 合格」+ 没移植的项目专有检查', () => {
  const r = lintUiFiles({ files: [{ name: 'v.lua', text: 'add("a", "img", 8, 8, 8, 8)\n' }] });
  assert(/不代表 UI 合格/.test(r.disclaimer), 'disclaimer 没写清：' + r.disclaimer);
  assert(/没有.*移植|没有.*移植|项目专有/.test(r.portNote), 'portNote 没说清哪几条没移植：' + r.portNote);
  assert(/passed/.test(r.disclaimer) || /passed/.test(r.portNote), '没提 passed 的语义');
  return 'disclaimer + portNote 都在';
});

/* ============================================================ 三、op=lint-ui（工具层） */

await check('op=lint-ui：dir + files 两种入口都认；回执带 where / counts / usedConfig / passed', async () => {
  const f1 = path.join(tmpRoot, 'view.lua');
  fs.writeFileSync(f1, 'add("ovT", "txt", 320, 240, 960, 64)\nsetFont("ovT", 52)\n', 'utf8');
  const r = await codeTool.execute({ op: 'lint-ui', dir: tmpRoot, files: ['view.lua'] }, {});
  assert(r.ok === true && r.op === 'lint-ui', 'op 没进对分支：' + JSON.stringify(r).slice(0, 160));
  assert(r.passed === false && r.counts.textTooShort === 1, '没抓住文本高：' + JSON.stringify(r.counts));
  const e = r.checks.textTooShort[0];
  assert(typeof e.where === 'string' && /view\.lua:1/.test(e.where), '没带 where：' + JSON.stringify(e));
  assert(r.usedConfig && r.usedConfig.grid === 8, 'usedConfig 没回：' + JSON.stringify(r.usedConfig));
  // summaryOnly：结论一个不丢、逐条细节省掉
  const s = await codeTool.execute({ op: 'lint-ui', dir: tmpRoot, files: ['view.lua'], summaryOnly: true }, {});
  assert(s.passed === false && s.counts.textTooShort === 1, 'summaryOnly 丢了结论：' + JSON.stringify(s.counts));
  return 'passed=false（1 条 textTooShort），where=' + e.where;
});

await check('op=lint-ui：合法工程 → passed:true（全绿基线）', async () => {
  const d = path.join(tmpRoot, 'clean');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'view.lua'), [
    'add("ovT", "txt", 320, 240, 960, 96)',
    'setFont("ovT", 52)',
    'add("ovS", "txt", 320, 352, 960, 48)',
    'setFont("ovS", 22)',
    '',
  ].join('\n'), 'utf8');
  const r = await codeTool.execute({ op: 'lint-ui', dir: d }, {});
  assert(r.passed === true, '合法工程竟然不过：' + JSON.stringify(r.checks));
  return 'passed=true（' + r.counts.rects + ' 个矩形）';
});

/* ============================================================ 四、验收：工作区两次真跑 */

await check('★ 验收①（真跑）：工作区基线 0 问题 ⇒ 新 op 的 passed 必须为 true', async () => {
  if (!sampleDir) return '跳过：本机没有 ' + SAMPLE_DIR + '（要用真工程验收时设 MILIASTRA_UI_SAMPLE_DIR）';
  const r = await codeTool.execute({ op: 'lint-ui', dir: SAMPLE_DIR, pairs: SAMPLE_PAIRS, uiConfig: SAMPLE_UI_CONFIG }, {});
  assert(r.ok === true, 'op 报错：' + JSON.stringify(r).slice(0, 200));
  const detail = JSON.stringify(r.counts);
  assert(r.passed === true, '工作区（基线 0 问题）在新 op 下不是 passed：' + detail
    + ' 首条：' + JSON.stringify(Object.entries(r.checks).filter(([, v]) => v.length).slice(0, 1)));
  return `${r.fileCount} 个文件 / ${r.counts.rects} 个矩形 / 点名 ${r.counts.pairsChecked} 对 → passed=true（${detail}）`;
});

await check('★ 验收②（真跑）：人为把文本框高改成 字号×1.3（**临时副本**）⇒ 必须报 file:line + expected/actual', async () => {
  if (!sampleDir) return '跳过：本机没有 ' + SAMPLE_DIR;
  const broken = path.join(tmpRoot, 'broken-sample');
  fs.mkdirSync(broken, { recursive: true });
  for (const n of fs.readdirSync(SAMPLE_DIR)) {
    if (/\.lua$/i.test(n)) fs.copyFileSync(path.join(SAMPLE_DIR, n), path.join(broken, n));
  }
  /*
   * 改坏哪一行：优先 `ovT`（作用域内、字号 52、原高 96 ⇒ 改成 floor(52×1.3)=67）。
   * 工作区是**活的**（作者随时在改），所以再留一条兜底：找任意**作用域内**、字号可查的文本行改坏它。
   * 两路都找不到 ⇒ **老老实实报红**（样例形状变了，验收夹具要跟着改），不静默跳过。
   */
  const viewPath = path.join(broken, '表现 view.lua');
  const src = fs.readFileSync(viewPath, 'utf8');
  let before = null;
  let after = null;
  let wantName = null;
  let wantSize = null;
  const prefer = 'add("ovT", "txt", 320, 240, 960, 96';
  if (src.includes(prefer)) {
    before = prefer; after = 'add("ovT", "txt", 320, 240, 960, 67'; wantName = 'ovT'; wantSize = 52;
  } else {
    const sizeOf = new Map();
    for (const m of src.matchAll(/setFont\("([^"]+)",\s*(\d+)\)/g)) sizeOf.set(m[1], Number(m[2]));
    for (const m of src.matchAll(/add\("([^"]+)",\s*"txt",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g)) {
      const name = m[1];
      if (!/^(ov|pk|cx|mx)/.test(name)) continue;
      const size = sizeOf.get(name);
      if (!size) continue;
      const badH = Math.floor(size * 1.3);
      if (badH >= Math.max(size * 1.4, size + 16)) continue;
      before = m[0]; after = `add("${name}", "txt", ${m[2]}, ${m[3]}, ${m[4]}, ${badH})`;
      wantName = name; wantSize = size;
      break;
    }
  }
  assert(before, '样例工程里找不到"作用域内且字号可查"的文本框 —— 形状变了，验收夹具要跟着改：' + SAMPLE_DIR);
  fs.writeFileSync(viewPath, src.replace(before, after), 'utf8');
  const r = await codeTool.execute({ op: 'lint-ui', dir: broken, pairs: SAMPLE_PAIRS, uiConfig: SAMPLE_UI_CONFIG }, {});
  assert(r.passed === false, '改坏了却仍然 passed：' + JSON.stringify(r.counts));
  assert(r.checks.textTooShort.length === 1, '没抓住改坏的那一处：' + JSON.stringify(r.checks.textTooShort));
  const e = r.checks.textTooShort[0];
  assert(/表现 view\.lua:\d+/.test(e.where), 'where 不是 file:line：' + JSON.stringify(e));
  assert(e.name === wantName && e.fontSize === wantSize, 'name/fontSize 不对：' + JSON.stringify(e));
  return `报出 ${e.where} ${e.name} expected=${e.expected} actual=${e.actual}（delta=${e.delta}）`;
});

/* ------------------------------------------------------------------ 收尾 */
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
process.env.MILIASTRA_LOCALLOW = savedLow === undefined ? '' : savedLow;
process.env.MILIASTRA_DATA_DIR = savedData === undefined ? '' : savedData;
process.env.MILIASTRA_BACKUP_DIR = savedBak === undefined ? '' : savedBak;

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
