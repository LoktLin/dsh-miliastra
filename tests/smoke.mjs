/**
 * 本地冒烟测试：直接调用每个工具的 execute，校验
 *   ① 返回体是 **lossless JSON**（宿主会拒收 undefined/NaN/Infinity，且报整个结果无效）
 *   ② parameters 是**合法 JSON Schema**（写坏会在注册期炸，严重时连发消息都失败）
 *   ③ 业务失败必须是 {ok:false,error}，而不是抛错、也不是静默
 *
 * 用法：node tests/smoke.mjs
 *
 * ⚠️ 只跑**只读**用例；`miliastra_probe op=deploy` / `miliastra_code op=deploy` 会写活文件，这里不跑。
 * ⚠️ 本测试依赖本机真有一份米哈游存档（Windows）。没有时用例会回 `ok:false`，测试**仍应通过**
 *    ——「环境缺失」与「代码坏了」是两件事，这里只负责证明后者不成立。
 */

import { TOOLS } from '../index.js';

let pass = 0;
let fail = 0;
const failures = [];

function checkLossless(v, path = '$') {
  if (v === undefined) return `undefined at ${path}`;
  if (typeof v === 'number' && !Number.isFinite(v)) return `非有限数字 at ${path}: ${v}`;
  if (typeof v === 'number' && Object.is(v, -0)) return `-0 at ${path}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) { const e = checkLossless(v[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) { const e = checkLossless(v[k], `${path}.${k}`); if (e) return e; }
    return null;
  }
  return null;
}

function checkSchema(tool) {
  const p = tool.parameters;
  if (!p || typeof p !== 'object') return 'parameters 缺失';
  if (p.type !== 'object') return 'parameters.type 必须是 object';
  if (p.properties && typeof p.properties !== 'object') return 'properties 必须是对象';
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'items', 'enum']);
  for (const k of Object.keys(p)) if (!allowed.has(k)) return `顶层多出未识别字段 "${k}"`;
  if (Array.isArray(p.required)) {
    for (const r of p.required) {
      if (!p.properties || !(r in p.properties)) return `required 里的 "${r}" 不在 properties 里`;
    }
  }
  return null;
}

const CASES = [
  ['miliastra_echo', { text: 'smoke' }],
  ['miliastra_health', {}],
  ['miliastra_health', { all: true }],
  ['miliastra_code', { op: 'inspect' }],
  ['miliastra_map', { op: 'summary' }],
  ['miliastra_map', { op: 'clientui' }],
  ['miliastra_map', { op: 'script' }],
  ['miliastra_map', { op: 'strings', limit: 5 }],
  ['miliastra_log', { op: 'sessions', limit: 5 }],
  ['miliastra_log', { op: 'tags' }],
  ['miliastra_log', { op: 'tail', limit: 5 }],
  ['miliastra_log', { op: 'runs' }],                          // 只读：按局切分 + 局间 diff
  ['miliastra_playtest', { op: 'status' }],                  // 只读：读 output_log.txt
  ['miliastra_shot', { op: 'targets' }],
  ['miliastra_shot', { op: 'list' }],
  ['miliastra_shot', { op: 'clean' }],                       // 默认 dryRun，不删任何东西
  ['miliastra_shot', { op: 'clean', all: true, keepLast: 3 }], // 也只是报告
  ['miliastra_probe', { op: 'list' }],
  ['miliastra_probe', { op: 'render', template: 'ping', tag: 'SMOKE' }],
  ['miliastra_probe', { op: 'render', template: 'tree', tag: 'SMOKE' }],
  ['miliastra_probe', { op: 'render', template: 'instantiate', tag: 'SMOKE', ids: [1073741824, 1073741825] }],
];

for (const t of TOOLS) {
  const err = checkSchema(t);
  if (err) { fail += 1; failures.push(`[schema] ${t.name}: ${err}`); } else { pass += 1; }
}

for (const [toolName, args] of CASES) {
  const def = TOOLS.find((x) => x.name === toolName);
  if (!def) { fail += 1; failures.push(`[case] 没有工具 ${toolName}`); continue; }
  const label = `${toolName} ${JSON.stringify(args)}`;
  let out;
  try {
    out = await def.execute(args, {});
  } catch (e) {
    fail += 1; failures.push(`[throw] ${label}: ${e && e.message}`);
    continue;
  }
  const l = checkLossless(out);
  if (l) { fail += 1; failures.push(`[lossless] ${label}: ${l}`); continue; }
  let text;
  try { text = JSON.stringify(out); } catch (e) { fail += 1; failures.push(`[json] ${label}: ${e.message}`); continue; }
  if (out && out.ok === false && !out.error) {
    fail += 1; failures.push(`[shape] ${label}: ok=false 但没有 error 字段`);
    continue;
  }
  console.log(`✓ ${label}
    bytes=${Buffer.byteLength(text, 'utf8')}  ok=${out && out.ok}  head=${text.slice(0, 130)}`);
  pass += 1;
}

// ---- 额外断言：形状必须稳定，且"拿不到"时也不能抛 ----

{
  const health = TOOLS.find((t) => t.name === 'miliastra_health');
  const d = await health.execute({}, {});
  const p = d && d.processes;
  if (!p || typeof p.available !== 'boolean' || !Array.isArray(p.entries)) {
    fail += 1;
    failures.push('[shape] miliastra_health.processes 形状不对：' + JSON.stringify(p));
  } else {
    const shaped = p.entries.every((e) => typeof e.file === 'string' && typeof e.label === 'string'
      && (e.running === true || e.running === false || e.running === null)
      && typeof e.instances === 'number' && typeof e.memoryMB === 'number');
    if (!shaped) {
      fail += 1;
      failures.push('[shape] processes.entries 元素形状不对：' + JSON.stringify(p.entries));
    } else {
      console.log(`✓ miliastra_health.processes 形状稳定 → available=${p.available} `
        + p.entries.map((e) => `${e.file}:${e.running === null ? 'unknown' : e.running}`).join('  '));
      pass += 1;
    }
    // 缓存必须生效：连调两次不应各起一次 tasklist（这里只验"第二次标记为 cached"）
    const again = (await health.execute({}, {})).processes;
    if (again && again.available === true && again.cached !== true) {
      console.log('  （提示：第二次调用没命中缓存 —— 仅影响性能，不计失败）');
    }
  }
}

// ---- 截图：删除必须有双保险（截图删了不可恢复）----

{
  const shot = TOOLS.find((t) => t.name === 'miliastra_shot');
  const before = await shot.execute({ op: 'list' }, {});
  const dry = await shot.execute({ op: 'clean', all: true }, {});
  const mid = await shot.execute({ op: 'list' }, {});
  if (!dry.dryRun || dry.removedCount) {
    fail += 1;
    failures.push('[safety] op=clean 默认应当是 dryRun 且不删东西：' + JSON.stringify({ dryRun: dry.dryRun, removedCount: dry.removedCount }));
  } else if (mid.count !== before.count) {
    fail += 1;
    failures.push(`[safety] op=clean dryRun 之后张数变了：${before.count} → ${mid.count}`);
  } else {
    console.log(`✓ miliastra_shot op=clean 默认 dryRun（${before.count} 张，一张没动）`);
    pass += 1;
  }

  const noConfirm = await shot.execute({ op: 'clean', all: true, dryRun: false }, {});
  const after = await shot.execute({ op: 'list' }, {});
  if (noConfirm.ok !== false || !noConfirm.error || after.count !== before.count) {
    fail += 1;
    failures.push('[safety] 只给 dryRun=false、不给 confirm:true 时**必须拒绝且不删**：'
      + JSON.stringify({ ok: noConfirm.ok, count: after.count }));
  } else {
    console.log('✓ miliastra_shot 真删要 dryRun=false + confirm=true 双钥匙');
    pass += 1;
  }

  // 回执必须写明「截到的到底是哪个窗口」—— 第一版抓错程序就是因为没有这个字段
  const cap = await shot.execute({ op: 'capture', process: 'NoSuchProcess_ZZZ' }, {});
  if (cap.ok !== false || !cap.error || !Array.isArray(cap.runningWindows)) {
    fail += 1;
    failures.push('[shape] 截图失败时必须回 ok:false + error + runningWindows：' + JSON.stringify(cap).slice(0, 200));
  } else {
    console.log('✓ miliastra_shot 截不到的进程时如实报错并列出可截窗口');
    pass += 1;
  }
}

// ---- 0.0.5：ErrorLog 巡检 + 部署指纹在**真机**上的形状（只读；不改任何文件）----

{
  const health = TOOLS.find((t) => t.name === 'miliastra_health');
  const code = TOOLS.find((t) => t.name === 'miliastra_code');

  const h = await health.execute({}, {});
  const el = h.errorLog;
  if (!el || typeof el.exists !== 'boolean' || (el.exists === false && !el.note)) {
    fail += 1;
    failures.push('[shape] health.errorLog 形状不对（要 exists + 没有时给说明）：' + JSON.stringify(el).slice(0, 200));
  } else {
    console.log(`✓ miliastra_health 带 ErrorLog 巡检 → ${el.exists
      ? '有 ' + el.size + 'B（循环调用/挂载失败只写这里，需人看）'
      : '没有（如实说明，不当成「脚本没出事」的证据）'}`);
    pass += 1;
  }

  const ins = await code.execute({ op: 'inspect' }, {});
  const d = ins.deploy;
  if (!d || typeof d.hasFingerprint !== 'boolean') {
    fail += 1;
    failures.push('[shape] code op=inspect 没带 deploy 指纹块：' + JSON.stringify(d).slice(0, 200));
  } else {
    console.log(`✓ miliastra_code op=inspect 带部署指纹 → hasFingerprint=${d.hasFingerprint}`
      + (d.hasFingerprint
        ? `  sameAsDeploy=${d.sameAsDeploy}（差 ${d.bytesDelta}B / ${d.lineDelta} 行）`
        : `  「${d.note}」`));
    pass += 1;
  }
}

// ---- 试玩侦测：超时必须能被 timeoutSec 打断，且如实回 hit:false（不许挂死）----

{
  const pt = TOOLS.find((t) => t.name === 'miliastra_playtest');
  const st = await pt.execute({ op: 'status' }, {});
  if (st.ok !== true || typeof st.inPlaytest !== 'boolean' || !st.logPath) {
    fail += 1;
    failures.push('[shape] op=status 必须回 ok / inPlaytest / logPath：' + JSON.stringify(st).slice(0, 200));
  } else {
    const last = st.startedAt || (st.lastRun && st.lastRun.startedAt) || '无';
    console.log(`✓ miliastra_playtest op=status → 在试玩=${st.inPlaytest}  最近开跑=${last}  历史局数=${(st.recentRuns || []).length}`);
    pass += 1;
  }

  const t0 = Date.now();
  const to = await pt.execute({ op: 'wait', timeoutSec: 5, pollMs: 500 }, {});
  const cost = Date.now() - t0;
  // 正常情况是「5 秒没人开局 → 超时」；万一这 5 秒里真有人开局，命中也算对。
  const shapeOk = to.ok === true && (to.hit === true || to.timedOut === true);
  if (!shapeOk || cost > 20000) {
    fail += 1;
    failures.push('[safety] op=wait 必须能被 timeoutSec 打断并如实回报（不许挂死）：'
      + JSON.stringify({ ok: to.ok, hit: to.hit, timedOut: to.timedOut, cost }));
  } else {
    console.log(`✓ miliastra_playtest op=wait 超时可打断且如实回报（${(cost / 1000).toFixed(1)}s，hit=${to.hit}）`);
    pass += 1;
  }
}

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
