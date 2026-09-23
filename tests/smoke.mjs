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

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
