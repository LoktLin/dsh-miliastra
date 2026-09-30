/*
 * 回执契约门禁（2026-09-30 起）
 *
 * 为什么单独立一条：本仓的调用方（AI 与面板）**一律按 `r.ok` 判成败** ——
 * 实测栽过三次同类问题，每次至少白跑一轮：
 *   ① `miliastra_sim` 的回执**整个没有 `ok`** ⇒ `op=bind` 明明成功却被判成"预览失败"；
 *   ② `miliastra_log op=errors` 指向已轮转的 `.gia` 时**抛 ENOENT 栈**（而 `.gia` 轮转是常态）；
 *   ③ `miliastra_sim op=hud`（无会话）**抛异常** ⇒ AI 不包 try/catch 就整轮被打断。
 * ⇒ 这条门禁只钉三件事：**必有 `ok`｜`ok:false` 必带 `error`｜不许抛异常**。
 *
 * ⚠️ 用例**只挑只读调用**（绝不 deploy / restore / remove / clean），离线即可跑。
 * ⚠️ 它**不判内容对不对** —— 内容正确性是各工具自己的测试的事。
 */
const { TOOLS } = await import('../index.js');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; if (process.env.VERBOSE) console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

/** 只读调用表：`[工具名, 参数, 说明]`。**新增工具时补一行**（缺了不报错，但也不受保护）。 */
const CALLS = [
  ['miliastra_health', { brief: true }, '环境体检（brief）'],
  ['miliastra_map', { op: 'summary' }, '地图摘要'],
  ['miliastra_code', { op: 'inspect' }, '活文件体检'],
  ['miliastra_log', { op: 'runs' }, '按局读日志'],
  ['miliastra_log', { op: 'errors' }, '按形态捞报错'],
  ['miliastra_log', { op: 'errors', file: '绝对不存在的_2026_99.gia' }, '不存在的 .gia（必须回执不抛栈）'],
  ['miliastra_playtest', { op: 'status' }, '试玩状态'],
  ['miliastra_shot', { op: 'list' }, '截图清单'],
  ['miliastra_asset', { op: 'stats' }, '素材库统计'],
  ['miliastra_asset', { op: 'icon-search', q: '宝箱' }, '图标语义检索'],
  ['miliastra_asset', { op: 'icon-search', id: '999999' }, '不存在的图标号（必须回执）'],
  ['miliastra_gen', { op: 'vfx-lua', preset: 'list', summaryOnly: true }, '特效预设清单'],
  ['miliastra_sim', { op: 'state' }, '模拟器状态'],
  ['miliastra_sim', { op: 'hud' }, '无会话读 HUD（必须回执不抛栈）'],
  ['miliastra_probe', { op: 'list' }, '试玩探针模板清单'],
  ['miliastra_echo', { text: 'receipt-contract' }, '回显'],
];

for (const [name, args, what] of CALLS) {
  const t = TOOLS.find((x) => x.name === name);
  const label = name + ' ' + what;
  if (!t) { bad(label + ' —— 工具不存在'); continue; }
  let r;
  try {
    r = await t.execute(args);
  } catch (e) {
    bad(label + ' —— **抛了异常**（应回 {ok:false,error}）：' + String((e && e.message) || e).slice(0, 90));
    continue;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) { bad(label + ' —— 回执不是对象'); continue; }
  if (r.ok === undefined) { bad(label + ' —— **回执缺 ok**（调用方按 r.ok 判定必然误判）'); continue; }
  if (r.ok === false) {
    if (typeof r.error !== 'string' || !r.error) { bad(label + ' —— ok:false 但没给 error'); continue; }
    ok(label + '（ok:false + error ✓）');
    continue;
  }
  ok(label);
}

/* 覆盖度提醒：新增工具而没补用例时说一声（不算失败，免得挡住别人加工具） */
const covered = new Set(CALLS.map((c) => c[0]));
const uncovered = TOOLS.map((t) => t.name).filter((n) => !covered.has(n));
if (uncovered.length) console.log('  ! 未纳入回执门禁的工具（建议补一行）：' + uncovered.join(', '));

console.log('结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);