/**
 * 统一回执契约 · 只读审计回归网（2026-10-08）
 *
 * 来源：一次真实的长会话 —— 系统审计发现 **10 条 op 会把异常抛给调用方**（找不到关卡 / 目录不存在 /
 * 裸 ENOENT / 未知 op…）。抛异常会**打断调用方一整轮**，是本仓红线明令禁止的形态；
 * 同一批里另有 18 条**已经**是 `{ok:false}` 回执 ⇒ 说明这是"漏改的少数"，不是设计分歧。
 *
 * 本测试把那份审计**固化成门禁**，断言两条不变量：
 *   ① **任何工具的任何 op 都不许抛异常**（出口统一收口成 `{ok:false, code:'TOOL_THREW', …}`）；
 *   ② **失败档必带 `code`**（出口结构性兜底 `'FAILED'`；有精确 code 的保持精确）。
 *
 * ⚠️ **只跑只读调用**（不 deploy / 不 restore / 不删 / 不 arm / 不 wait），可在任意机器上跑：
 *   本机没有存档时它们回 `ok:false`，**测试仍应通过**（断言的是"形式"，不是"业务结果"）。
 *
 * 用法：`node tests/audit-test.mjs`
 */
import { TOOLS } from '../index.js';

const CASES = [
  [
    "miliastra_health",
    {
      "op": "scan",
      "level": "999999999"
    }
  ],
  [
    "miliastra_health",
    {
      "op": "sha",
      "mirror": "Z:\\nope"
    }
  ],
  [
    "miliastra_health",
    {
      "op": "handover",
      "action": "set"
    }
  ],
  [
    "miliastra_health",
    {
      "op": "handover",
      "action": "clear"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "read",
      "source": "Z:\\nope.lua"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "inspect",
      "level": "999999999"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "backups",
      "level": "999999999"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "rects",
      "dir": "Z:\\nope"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "lint-ui",
      "dir": "Z:\\nope"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "preflight",
      "dir": "Z:\\nope"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "levels",
      "stage": "根本不存在"
    }
  ],
  [
    "miliastra_code",
    {
      "op": "fixbom",
      "source": "Z:\\nope.lua"
    }
  ],
  [
    "miliastra_map",
    {
      "op": "summary",
      "level": "999999999"
    }
  ],
  [
    "miliastra_map",
    {
      "op": "clientui",
      "root": 999999999
    }
  ],
  [
    "miliastra_map",
    {
      "op": "regions",
      "path": "Z:\\nope.gil"
    }
  ],
  [
    "miliastra_map",
    {
      "op": "nodedb",
      "nodeId": -1
    }
  ],
  [
    "miliastra_map",
    {
      "op": "strings",
      "path": "Z:\\nope.gil"
    }
  ],
  [
    "miliastra_log",
    {
      "op": "tail",
      "file": "Z:\\nope.gia"
    }
  ],
  [
    "miliastra_log",
    {
      "op": "grep",
      "pattern": "(["
    }
  ],
  [
    "miliastra_log",
    {
      "op": "metrics",
      "bins": 99999
    }
  ],
  [
    "miliastra_asset",
    {
      "op": "get",
      "id": "zzzz"
    }
  ],
  [
    "miliastra_asset",
    {
      "op": "remove",
      "id": "zzzz"
    }
  ],
  [
    "miliastra_asset",
    {
      "op": "catalog",
      "category": "根本没有这类"
    }
  ],
  [
    "miliastra_asset",
    {
      "op": "sound-get",
      "id": 99999999
    }
  ],
  [
    "miliastra_asset",
    {
      "op": "measure",
      "source": "Z:\\nope.png"
    }
  ],
  [
    "miliastra_gen",
    {
      "op": "pixel-art",
      "source": "Z:\\nope.png"
    }
  ],
  [
    "miliastra_gen",
    {
      "op": "struct-json",
      "structId": "123"
    }
  ],
  [
    "miliastra_gen",
    {
      "op": "vfx-lua",
      "preset": "根本没有这个预设"
    }
  ],
  [
    "miliastra_gen",
    {
      "op": "bogus-op"
    }
  ],
  [
    "miliastra_sim",
    {
      "op": "bind"
    }
  ],
  [
    "miliastra_sim",
    {
      "op": "play",
      "action": "根本没有这个动作"
    }
  ],
  [
    "miliastra_sim",
    {
      "op": "controls",
      "maxDepth": -5
    }
  ],
  [
    "miliastra_kb",
    {
      "op": "node",
      "q": "根本不存在的节点名zzz"
    }
  ],
  [
    "miliastra_kb",
    {
      "op": "qa",
      "id": "根本没有这条"
    }
  ],
  [
    "miliastra_shot",
    {
      "op": "capture",
      "process": "NoSuchProcess123"
    }
  ],
  [
    "miliastra_probe",
    {
      "op": "render",
      "template": "根本没有这个模板"
    }
  ],
  [
    "miliastra_probe",
    {
      "op": "render",
      "template": "custom"
    }
  ],
  [
    "miliastra_echo",
    {}
  ]
];

let pass = 0;
let fail = 0;
const failures = [];
const threw = [];
const noCode = [];

for (const [name, args] of CASES) {
  const def = TOOLS.find((t) => t.name === name);
  const label = name + ' ' + JSON.stringify(args).slice(0, 60);
  if (!def) { fail += 1; failures.push('没有工具 ' + name); continue; }
  let r;
  try {
    r = await def.execute(args);
  } catch (e) {
    threw.push(label + ' ⇒ ' + ((e && e.message) || String(e)).slice(0, 80));
    fail += 1;
    continue;
  }
  if (!r || typeof r !== 'object') { fail += 1; failures.push(label + ' 回执不是对象'); continue; }
  if (r.ok === undefined) { fail += 1; failures.push(label + ' 回执没有 ok 字段'); continue; }
  if (r.ok === false && !r.code) { noCode.push(label); fail += 1; continue; }
  pass += 1;
}

console.log('用例 ' + CASES.length + ' 条：通过 ' + pass + '，失败 ' + fail);
if (threw.length) {
  console.log('✗ 抛异常 ' + threw.length + ' 条（红线：失败必须回 {ok:false}，不许抛）：');
  for (const t of threw) console.log('   ' + t);
}
if (noCode.length) {
  console.log('✗ 失败档缺 code ' + noCode.length + ' 条：');
  for (const t of noCode) console.log('   ' + t);
}
for (const f of failures) console.log('   · ' + f);
console.log(fail === 0 ? '✅ 统一回执契约：不抛异常 ✓ · 失败必带 code ✓' : '❌ 统一回执契约被破坏');
process.exit(fail === 0 ? 0 : 1);
