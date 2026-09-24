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
import { TOOLS, PROMPT_GUIDE, PROMPT_SKIP, renderPromptSection, hostStaleness, engineArgsFromBody, playPageSource, playPageStamp } from '../index.js';
import { slimStats } from '../lib/metrics.mjs';

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

/* ---- 系统提示段必须**覆盖所有需要指路的工具**（0.0.10 加）
 *
 * 为什么要有这条：系统提示段本质是「AI 的开场指路」，它是工具 schema 之外的**第二份副本**，
 * 而第二份副本必然漂移。实证：0.0.9 之前那段只覆盖 5 个工具，
 * `miliastra_playtest` / `miliastra_shot`（0.0.4~0.0.8 加的）在提示里**没有任何"什么时候用"**，
 * 而没人会发现 —— 同一个病在 README 上也发过（版本号停在 0.0.1 六次发布）。
 * → 判据刻意做成**绊线**而不是"质检"：不在豁免名单里的工具，必须有一条指路，否则红。
 *    它不会误报（豁免是显式的），代价只是「加工具时要想一句什么时候用」—— 那一句本来就该想。
 */
{
  const names = TOOLS.map((t) => t.name);
  const covered = new Set(PROMPT_GUIDE.map((g) => g.tool));
  const text = renderPromptSection();
  const bad = [];
  const missing = names.filter((n) => !PROMPT_SKIP.has(n) && !covered.has(n));
  if (missing.length) bad.push('这些工具在系统提示段里没有「什么时候用」：' + missing.join(', ')
    + '（确实不需要的，显式加进 PROMPT_SKIP 并写明理由）');
  const ghost = [...covered].filter((n) => !names.includes(n));
  if (ghost.length) bad.push('系统提示段指路的工具不存在（改名/删掉后忘了同步）：' + ghost.join(', '));
  // ⚠️ 必须**按行**查「工具名 + 冒号」在不在同一条 bullet 里。
  //    第一版只查 `text.includes(name)` → **假通过**：名字在第一行的工具清单里就有，
  //    于是「每条指路根本没带工具名」（· 先用它定位… 的「它」指谁？）也照样绿。断言查错了对象。
  const lines = text.split('\n');
  const notInText = PROMPT_GUIDE.filter((g) => !lines.some((l) => l.includes(g.tool + '：'))).map((g) => g.tool);
  if (notInText.length) bad.push('这些工具的指路没有和工具名写在同一行（读的人不知道「它」是谁）：' + notInText.join(', '));
  const noWhy = PROMPT_GUIDE.filter((g) => !g.when || g.when.length < 8);
  if (noWhy.length) bad.push('有指路项没写「什么时候用」：' + noWhy.map((g) => g.tool).join(', '));
  if (bad.length) {
    fail += 1;
    failures.push('[prompt] 系统提示段覆盖不全：' + bad.join('；'));
  } else {
    console.log(`✓ 系统提示段覆盖 ${PROMPT_GUIDE.length}/${names.length} 个工具（豁免 ${[...PROMPT_SKIP].join(',') || '无'}）`
      + `，正文 ${text.length} 字（工具 schema 的 ${Math.round(text.length / names.reduce((s, n) => {
        const t = TOOLS.find((x) => x.name === n);
        return s + t.description.length + JSON.stringify(t.parameters).length;
      }, 0) * 100)}%）`);
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
    console.log(`✓ 版本号四处一致 → package.json / index.js VERSION / README 第一段 / 安装示例 都是 ${pkg.version}`);
    pass += 1;
  }
}

/* ---- Host 自陈旧：源码比启动快照新时，必须由 Host 自己说（今晚为此花了 5 个调用）---- */

{
  const base = { sourceVersion: '0.0.10', sourceMtimeMs: 1000, loadedVersion: '0.0.10', startedAtMs: 5000 };
  const fresh = hostStaleness(base);
  const vNew = hostStaleness({ ...base, sourceVersion: '0.0.11' });
  const mNew = hostStaleness({ ...base, sourceMtimeMs: 5000 + 23 * 60000 });
  const broken = hostStaleness({ sourceVersion: null, sourceMtimeMs: null, loadedVersion: '0.0.10', startedAtMs: 1 });
  if (!fresh.stale && !fresh.hint
    && vNew.stale && vNew.versionNewer && /重启 dsh web/.test(String(vNew.hint))
    && mNew.stale && mNew.mtimeNewer && mNew.deltaMin === 23 && /重启 dsh web/.test(String(mNew.hint))
    && !broken.stale) {
    console.log(`✓ Host 陈旧判据：同版本 + 旧 mtime → 不报；源码版本变了 / index.js 晚 23 分钟 → 报并要求重启（deltaMin=${mNew.deltaMin}）；读不到源码也不报假警`);
    pass += 1;
  } else {
    fail += 1;
    failures.push('[gui] hostStaleness 形状不对：' + JSON.stringify({ fresh, vNew, mNew, broken }).slice(0, 220));
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

  // ①b **模拟器的定位必须写在 description 里**（作者 2026-09-24 要求补：它是「真机试玩之前的预测试」）。
  //     为什么是绊线：AI **只看得到 schema 与提示段**；这段没了，AI 会拿模拟器结果当"验过了"跟用户汇报。
  {
    const sim = TOOLS.find((t) => t.name === 'miliastra_sim');
    const text = String(sim && sim.description || '');
    const missing = [];
    if (!/预测试/.test(text)) missing.push('「预测试」定位');
    if (!/真机/.test(text) || !/≠/.test(text)) missing.push('「模拟器通过 ≠ 真机通过」');
    if (!/①/.test(text) || !/③/.test(text)) missing.push('三档（①看 ②玩 ③判）');
    if (missing.length) {
      fail += 1;
      failures.push('[positioning] miliastra_sim 的 description 缺了：' + missing.join(' / ')
        + '（AI 看不到 docs，只能靠 schema 知道模拟器是"真机之前的预测试"）');
    } else {
      console.log('✓ miliastra_sim 的定位写在 schema 里（预测试 / ≠ 真机通过 / 三档）');
      pass += 1;
    }
  }

  /*
   * ①c **AI 自己"玩"的量级与读屏口径也必须写在 description 里**（2026-09-24 实测后补）。
   *
   * 为什么值得绊线：这几条 AI **猜不出来**，而缺了就会做出错误决定 ——
   *   · 以为能"逐帧看画面再反应"（做不到：读一次场景 ≈200ms，眼睛是 ≈5Hz 离散采样）；
   *   · 不知道画面上的文字可以直接从 `textbox.text` 读（于是去截屏、或干脆瞎点）；
   *   · 只发 `keyDown` 不配对 `keyUp` —— 等于**一直按住**（实测把小人一路推到掉出边界重生）；
   *   · `op=keys` 只扫 `KeyEventType.X`、漏掉真脚本的**裸字符串**写法（实测漏检，AI 只能去猜键名）。
   */
  {
    const sim = TOOLS.find((t) => t.name === 'miliastra_sim');
    const text = String(sim && sim.description || '');
    const missing = [];
    if (!/textbox/.test(text) || !/`text`/.test(text)) missing.push('`textbox` 节点带 `text`（不用截屏就能读 HUD/分数）');
    if (!/frame/.test(text) || !/秒表/.test(text)) missing.push('`frame` 不是秒表（注入会顺带推帧）');
    if (!/5ms/.test(text) || !/200ms/.test(text)) missing.push('闭环量级（发输入 ≈5ms / 读场景 ≈200ms ⇒ ≈5Hz）');
    if (!/Up/.test(text) || !/一直按住/.test(text)) missing.push('按 `…Down` 要配对发 `…Up`');
    if (!/keys/.test(text) || !/string-literal/.test(text)) missing.push('`op=keys` 两路扫（含裸字符串键名 + `via` 来源）');
    // ★ 「找个按键这么久」的教训：**请求形状属于 schema**，不该让 AI 去读实现（实测为此翻了 4 个源文件）
    if (!/press/.test(text)) missing.push('`op=keys` 的 `press`（`key`/`pointer`/`click`/`step` 可直接照抄的请求体）');
    if (!/op=hud/.test(text)) missing.push('`op=hud`（只回画面上的字，别为读 HUD dump 整个场景）');
    if (!/all:true/.test(text) || !/164/.test(text)) missing.push('`op=keys {all:true}` 给全量 164 个键名');
    if (missing.length) {
      fail += 1;
      failures.push('[ergonomics] miliastra_sim 的 description 缺了：' + missing.join(' / ')
        + '（这几条 AI 猜不出来，只能靠 schema：缺一条它就会做错决定）');
    } else {
      console.log('✓ miliastra_sim 的「AI 自己玩」口径写在 schema 里（读 HUD / frame 口径 / 量级 / 松键 / keys 两路）');
      pass += 1;
    }
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
  // ⚠️ 这里读的是**真机最新一局**的 .gia —— 内容会随每局试玩变。
  // 所以断言必须**数据无关**：不写死键名（曾写死 `x`，23:33 那局的日志里没有 x → 假红），
  // 只对齐「瘦身不许丢结论」这条不变量：全量里有 core/hotBin 的，摘要里必须还在。
  const fullKeys = (mFull.loose && mFull.loose.keys) || {};
  const slimKeys = (mSlim.loose && mSlim.loose.keys) || {};
  const slimKeysSame = JSON.stringify(Object.keys(fullKeys).sort()) === JSON.stringify(Object.keys(slimKeys).sort());
  const keepsConclusions = Object.entries(fullKeys).every(([k, v]) => {
    const s = slimKeys[k] || {};
    const hadCore = !!(v && v.core && typeof v.core.from === 'number');
    return (!hadCore || (s.core && typeof s.core.from === 'number')) && (!v || !v.hotBin || !!s.hotBin);
  });
  const binsHonest = Object.entries(fullKeys).every(([k, v]) => {
    const had = Array.isArray(v && v.bins) ? v.bins.length : 0;
    const s = slimKeys[k] || {};
    return had > 0 ? s.binsOmitted === had : !('binsOmitted' in s);
  });
  const looseFullLen = JSON.stringify(mFull.loose || {}).length;
  const looseSlimLen = JSON.stringify(mSlim.loose || {}).length;
  if (mSlim.summaryOnly === true && slimKeysSame && keepsConclusions && binsHonest && looseSlimLen <= looseFullLen) {
    const checked = Object.entries(fullKeys).filter(([, v]) => v && v.core).map(([k]) => k);
    console.log(`✓ op=metrics 的 summaryOnly 去掉分箱但保留结论 → loose ${looseFullLen}B → ${looseSlimLen}B，`
      + `键 ${Object.keys(slimKeys).join('/') || '（这一局没有 k=数字 行）'}；带 core 的键：${checked.join('/') || '无'}`);
    pass += 1;
  } else {
    fail += 1;
    failures.push('[ergonomics] op=metrics summaryOnly 不对：' + JSON.stringify({ slim: mSlim.summaryOnly, slimKeysSame, keepsConclusions, binsHonest, looseFullLen, looseSlimLen, full: Object.keys(fullKeys) }).slice(0, 200));
  }

  // 「省体积」这条**用固定夹具**验（真机那一局可能只有 1 个数、1 个箱 —— 不具代表性，
  // 而且回执里那段 `note` 文案本身就比省下来的还长）。夹具代表真实形态：多键 × 多箱。
  {
    const bins = Array.from({ length: 12 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, count: i }));
    const fx = { n: 78, min: 0, max: 120, mean: 60, median: 60, p25: 30, p75: 90,
      core: { from: 30, to: 90, width: 60 }, span: 120, bins, hotBin: { from: 30, to: 40, count: 11 }, hotShare: 0.14 };
    const slim = slimStats(fx);
    const saved = JSON.stringify(fx).length - JSON.stringify(slim).length;
    if (!('bins' in slim) && slim.binsOmitted === 12 && slim.core && slim.hotBin && saved > 0) {
      console.log(`✓ slimStats 在「多箱」夹具上真的省体积 → ${JSON.stringify(fx).length}B → ${JSON.stringify(slim).length}B（省 ${saved}B），`
        + `binsOmitted=12、core 与 hotBin 都在`);
      pass += 1;
    } else {
      fail += 1;
      failures.push('[ergonomics] slimStats 夹具不省 / 丢结论：' + JSON.stringify({ slimLen: JSON.stringify(slim).length, saved, binsOmitted: slim.binsOmitted, core: !!slim.core }).slice(0, 200));
    }
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

/* ------------------------------------------------ 路由参数：别再把 op 吃掉（2026-09-24 真事故） */

/*
 * 事故原样：`/miliastra/engine` 早先写成「有 `body.args` 就用 `body.args`」，
 * 而 `op=play` 的参数**本来就装在 `args` 里**（`{op:'play', action:'click', args:{x,y}}`）——
 * 于是 `op/action` 一起被吃掉，`simOp` 退化成默认的 `op=state`，**不报错**：
 * 面板的试玩按钮、浏览器试玩页的轮询双双静默失效（iframe 一片黑、Frame 永远 0）。
 * 这里钉两件事：① 转换函数原样返回；② 源码里不许再出现那种"拆 args"的写法。
 */
{
  const routed = engineArgsFromBody({ op: 'play', action: 'click', args: { x: 1, y: 2 } });
  const keep = routed.op === 'play' && routed.action === 'click' && routed.args && routed.args.x === 1;
  const nullish = JSON.stringify(engineArgsFromBody(null)) === '{}' && JSON.stringify(engineArgsFromBody(undefined)) === '{}';
  const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'index.js'), 'utf8');
  // 只看**代码行**（注释里为了解释这起事故，原样引用了那行错误写法 —— 不能被自己的注释绊倒）
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // 只看 `/engine` 那一段（`/tool` 路由里的 `body.args` 是合法的：那是 `{name, args}` 信封）
  const iEng = code.indexOf("'/engine'");
  const iTool = code.indexOf("'/tool'");
  const routeSlice = iEng >= 0 && iTool > iEng ? code.slice(iEng, iTool) : '';
  const usesHelper = /engineArgsFromBody\(body\)/.test(routeSlice);
  const antiPattern = /body\.args/.test(routeSlice);
  if (keep && nullish && usesHelper && !antiPattern) {
    console.log('✓ ★ `/miliastra/engine` 的请求体原样交给 simOp（op/action 不被吃掉）—— 面板试玩按钮与试玩页靠这条');
    pass += 1;
  } else {
    fail += 1;
    failures.push('[route] engine 路由参数被改了：keep=' + keep + ' nullish=' + nullish + ' usesHelper=' + usesHelper + ' antiPattern=' + antiPattern);
  }
  // 反向证明：真的喂给 simOp 时，这一形状走的是 play 分支（不是退化成 state）
  try {
    const { simOp } = await import('../lib/sim.mjs');
    const r = await simOp(engineArgsFromBody({ op: 'play', action: 'history' }), {});
    if (r && r.action === 'history') {
      console.log('✓ ★ 同一形状喂给 simOp：走的是 `play` 分支（不是退化成 state 快照）');
      pass += 1;
    } else {
      fail += 1;
      failures.push('[route] play 形状没进 play 分支：' + JSON.stringify(r).slice(0, 160));
    }
  } catch (e) {
    // 没有活会话时 `op=play` 会明确报错（"play session has not started"）—— 那也是**进了 play 分支**的证据
    const msg = (e && e.message) || String(e);
    if (/play session has not started|play worker/.test(msg)) {
      console.log('✓ ★ 同一形状喂给 simOp：进了 `play` 分支（没会话时如实报错：' + msg.slice(0, 60) + '）');
      pass += 1;
    } else {
      fail += 1;
      failures.push('[route] play 形状报错但不是 play 分支的错：' + msg);
    }
  }
}

/* ------------------------------------------------ 试玩页的版本戳（"面板里那份是不是旧的"） */

/*
 * 作者踩过：页面明明修了，面板 iframe 里还是旧行为，来回猜了两轮。
 * 这一页是每次请求现读的（`no-store`），所以"新旧"必须**看得见** —— 响应里盖一个
 * `大小-mtime` 的戳，页脚显示 `v<戳>`，跟磁盘一比就知道要不要点「重载页面」。
 */
{
  const stamp = playPageStamp({ size: 12345, mtimeMs: 1758600000000 });
  const html = playPageSource('<span id="stamp">v__PLAY_STAMP__</span>__PLAY_STAMP__', stamp);
  const okStamp = /^[0-9a-z]+-[0-9a-z]+$/.test(stamp)
    && html.indexOf('__PLAY_STAMP__') < 0 && (html.match(new RegExp(stamp, 'g')) || []).length === 2;
  const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'index.js'), 'utf8');
  const routeUsesIt = /playPageSource\(html, playPageStamp\(st\)\)/.test(src);
  if (okStamp && routeUsesIt) {
    console.log('✓ ★ 试玩页盖上版本戳（`v<大小>-<mtime>`，如 v9ix-1a2b3c）：页脚能自证"面板里那份是新是旧"');
    pass += 1;
  } else {
    fail += 1;
    failures.push('[page] 版本戳不对：stamp=' + stamp + ' okStamp=' + okStamp + ' routeUsesIt=' + routeUsesIt);
  }
}

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
