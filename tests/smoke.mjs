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

import fs from 'node:fs';
import path from 'node:path';
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
  ['miliastra_code', { op: 'levels' }],                      // 只读：从活文件里抽关卡表算几何事实
  ['miliastra_map', { op: 'summary' }],
  ['miliastra_map', { op: 'clientui' }],
  ['miliastra_map', { op: 'script' }],
  ['miliastra_map', { op: 'strings', limit: 5 }],
  ['miliastra_log', { op: 'sessions', limit: 5 }],
  ['miliastra_log', { op: 'tags' }],
  ['miliastra_log', { op: 'tail', limit: 5 }],
  ['miliastra_log', { op: 'runs' }],                          // 只读：按局切分 + 局间 diff
  ['miliastra_log', { op: 'metrics' }],                       // 只读：指标汇总（严格 [MIL] + 宽松 k=数字）
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

/* ---- 版本一致性（2026-09-23 加：README 第一段曾一路停在 0.0.1 —— 六次发布没人发现，
 *      因为**没有任何断言在管它**。典型的「不变量缺失」：功能都对，门面上写着旧版本。）---- */
{
  const pkgDir = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const idx = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');
  const readme = fs.readFileSync(path.join(pkgDir, 'README.md'), 'utf8');
  const mIdx = /const VERSION = '([^']+)'/.exec(idx);
  const mReadme = /\*\*版本 `([^`]+)`\*\*/.exec(readme);
  const mInstall = /dsh-miliastra@(\d+\.\d+\.\d+)/.exec(readme);
  const bad = [];
  if (!mIdx) bad.push('index.js 里找不到 `const VERSION`');
  else if (mIdx[1] !== pkg.version) bad.push(`index.js VERSION=${mIdx[1]} ≠ package.json ${pkg.version}`);
  if (!mReadme) bad.push('README 里找不到「**版本 `x.y.z`**」那句');
  else if (mReadme[1] !== pkg.version) bad.push(`README 第一段写的版本=${mReadme[1]} ≠ package.json ${pkg.version}`);
  if (mInstall && mInstall[1] !== pkg.version) bad.push(`README 里的安装示例版本=${mInstall[1]} ≠ ${pkg.version}`);
  if (bad.length) {
    fail += 1;
    failures.push('[version] 版本号不一致：' + bad.join('；'));
  } else {
    console.log(`✓ 版本号三处一致 → package.json / index.js VERSION / README 第一段 / 安装示例 都是 ${pkg.version}`);
    pass += 1;
  }
}

/* ---- 0.0.9：AI 调用体验的三条**不变量**（防止以后又长回去）----
 *
 * 这三条都不是「功能」，是**给调用方（AI）省事**的约束，所以必须被测试钉住 ——
 * 否则下一次加 op 时顺手就破坏了，而且**不会有任何报错**（只是变回难用）。
 */
{
  // ① 每个工具的 description 里都要有一条「典型调用」：AI 读描述就能照抄，不用自己猜参数组合
  const noTypical = TOOLS.filter((t) => !/典型调用/.test(t.description));
  if (noTypical.length) {
    fail += 1;
    failures.push('[ergonomics] 这些工具的 description 里没有「典型调用」：' + noTypical.map((t) => t.name).join(', '));
  } else {
    console.log(`✓ 每个工具的 description 都带「典型调用」（${TOOLS.length} 个）—— AI 读描述就能照抄`);
    pass += 1;
  }

  // ② 不许再有 `which` 这种和 `level` 撞车的参数名：
  //    `level` = **地图关卡 ID**（哪张图）｜`stage` = **玩法里的第几关**。两个「关卡」在中文里同名，必须靠参数名分开。
  const withWhich = TOOLS.filter((t) => JSON.stringify(t.parameters).includes('"which"'));
  if (withWhich.length) {
    fail += 1;
    failures.push('[ergonomics] 还有 `which` 参数（会和 level 撞车，应该叫 stage）：' + withWhich.map((t) => t.name).join(', '));
  } else {
    console.log('✓ 没有 `which` 参数了（`level`=地图关卡ID / `stage`=玩法第几关，不会再混）');
    pass += 1;
  }

  // ③ `summaryOnly` 必须**真的省上下文**，而且**不丢关键数字**
  const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
  const logTool = TOOLS.find((t) => t.name === 'miliastra_log');
  const mapTool = TOOLS.find((t) => t.name === 'miliastra_map');

  const lvFull = await codeTool.execute({ op: 'levels' }, {});
  const lvSlim = await codeTool.execute({ op: 'levels', summaryOnly: true }, {});
  const lvOne = await codeTool.execute({ op: 'levels', stage: 3 }, {});
  const jFull = JSON.stringify(lvFull).length;
  const jSlim = JSON.stringify(lvSlim).length;
  const row = (lvSlim.levels || [])[0] || {};
  const keepsNumbers = ['stage', 'platCount', 'adjacentCount', 'adjacentOverlaps', 'risingOverlaps', 'trueOverlaps', 'nearMiss', 'spanX']
    .every((k) => typeof row[k] === 'number');
  if (jSlim < jFull / 5 && keepsNumbers && (lvOne.levels || []).length === 1 && JSON.stringify(lvOne).length < jFull) {
    console.log(`✓ op=levels 的 summaryOnly 真的省上下文 → 全量 ${jFull}B → 摘要 ${jSlim}B（${Math.round(jSlim / jFull * 100)}%），`
      + `stage=3 单关 ${JSON.stringify(lvOne).length}B，且摘要里的数字都在`);
    pass += 1;
  } else {
    fail += 1;
    failures.push('[ergonomics] op=levels summaryOnly 没省到 / 丢了数字：'
      + JSON.stringify({ jFull, jSlim, keepsNumbers, one: (lvOne.levels || []).length }));
  }

  const mFull = await logTool.execute({ op: 'metrics' }, {});
  const mSlim = await logTool.execute({ op: 'metrics', summaryOnly: true }, {});
  const keyX = (mSlim.loose && mSlim.loose.keys && mSlim.loose.keys.x) || null;
  const keepsCore = !!(keyX && keyX.core && typeof keyX.core.from === 'number' && keyX.hotBin && typeof keyX.hotBin.count === 'number');
  if (mSlim.summaryOnly === true && keyX && typeof keyX.binsOmitted === 'number' && keepsCore
    && JSON.stringify(mSlim).length <= JSON.stringify(mFull).length) {
    console.log(`✓ op=metrics 的 summaryOnly 去掉分箱但保留结论 → ${JSON.stringify(mFull).length}B → ${JSON.stringify(mSlim).length}B，`
      + `binsOmitted=${keyX.binsOmitted}，core ${keyX.core.from}~${keyX.core.to} 与 hotBin 都还在`);
    pass += 1;
  } else {
    fail += 1;
    failures.push('[ergonomics] op=metrics summaryOnly 不对：' + JSON.stringify({ slim: mSlim.summaryOnly, bin: keyX && keyX.binsOmitted, core: keepsCore }).slice(0, 200));
  }

  const cuFull = await mapTool.execute({ op: 'clientui' }, {});
  const cuSlim = await mapTool.execute({ op: 'clientui', summaryOnly: true }, {});
  const cuKeep = Array.isArray(cuSlim.likelyTemplates) && typeof cuSlim.count === 'number' && typeof cuSlim.standaloneCount === 'number';
  const jCuFull = JSON.stringify(cuFull).length;
  const jCuSlim = JSON.stringify(cuSlim).length;
  // 这里只要求「省得下来（≥40%）」，**不要求省到 1/5**：clientui 的大头是 `records`/`rendered`，
  // 但模板清单/结构件本身也不小，硬凑比例会变成"为了过测试而改数字"。
  if (jCuSlim < jCuFull * 0.6 && cuKeep && !('rendered' in cuSlim)) {
    console.log(`✓ op=clientui 的 summaryOnly 省掉逐条谱系 → ${jCuFull}B → ${jCuSlim}B（${Math.round(jCuSlim / jCuFull * 100)}%），模板清单与计数都还在`);
    pass += 1;
  } else {
    fail += 1;
    failures.push('[ergonomics] op=clientui summaryOnly 不对：' + JSON.stringify({ jCuFull, jCuSlim, keep: cuKeep, hasRendered: 'rendered' in cuSlim }));
  }
}

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
