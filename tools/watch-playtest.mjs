/**
 * tools/watch-playtest.mjs — 盯试玩：每 4 秒问一次日志局面，把「判据怎么判的」逐行打出来。
 *
 * 用的是**面板里同一个判据函数**（`__testAutoFollowStep`）—— 不另写一套，
 * 否则「验的」和「跑的」不是同一个东西，验了也白验。
 *
 * 用法: node tools/watch-playtest.mjs [秒数，默认 300]
 * 前置: dsh web 在跑（要调 /miliastra/tool）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const PKG_DIR = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(PKG_DIR, 'package.json'));
const BASE = process.env.MILIASTRA_BASE || 'http://127.0.0.1:3080';
const SECONDS = Number(process.argv[2] || 300);

// —— 用与 client-render-test 相同的 shim 把面板代码 materialize 出来，只取判据函数 ——
const styleNodes = [];
const fakeNode = (t) => ({ tagName: String(t).toUpperCase(), id: '', textContent: '', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k]; }, remove() {} });
const documentShim = { head: { appendChild(n) { styleNodes.push(n); } }, body: {}, getElementById: () => null, createElement: fakeNode };
const windowShim = { __ModuleLoader__: { load(s) { windowShim.__captured = s; } }, innerHeight: 900, innerWidth: 1200, addEventListener() {}, removeEventListener() {} };
/*
 * 故意把假 window / document 装进 globalThis（与 dump-panel-text.mjs 同一套 shim）：
 * 无头跑 `lib/client.js` 取面板的判据函数。真 `Document` 的 260 多个成员这里一个都没有 ——
 * 这是**有意的 shim**，所以显式转 `any`，不是类型写错了。
 */
globalThis.window = /** @type {any} */ (windowShim);
globalThis.document = /** @type {any} */ (documentShim);
// eslint-disable-next-line no-new-func -- 同上：把 client.js 塞进假 window/document 里跑（无头渲染面板），不是 eval 外部输入
new Function('window', 'document', 'console', fs.readFileSync(path.join(PKG_DIR, 'lib', 'client.js'), 'utf8'))(windowShim, documentShim, console);
const React = req('react');
const exports_ = windowShim.__captured.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return req('react/jsx-runtime');
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { useDismissOnOutsidePointer() {} };
  throw new Error('未提供的模块：' + name);
});
const step = exports_.__testAutoFollowStep;
const shortName = exports_.__testShortSessionName;
if (typeof step !== 'function') { console.log('判据函数取不到，放弃'); process.exit(1); }

const SETTLE = 6000;
const POLL = 4000;

const ask = async () => {
  const r = await fetch(BASE + '/miliastra/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'miliastra_log', args: { op: 'sessions', limit: 5 } }),
  });
  const j = await r.json();
  const d = j && j.data && j.data.data ? j.data.data : j.data;
  const inner = d && d.data && d.ok !== undefined ? d.data : d;
  return (inner && inner.files) || [];
};
const fmtSize = (n) => (n < 1024 ? n + 'B' : (n / 1024).toFixed(1) + 'KB');
const clock = () => new Date().toTimeString().slice(0, 8);

let state = null;
const started = Date.now();
console.log('开始守望 ' + SECONDS + ' 秒（每 ' + POLL / 1000 + 's 一次，安静 ' + SETTLE / 1000 + 's 判结束）');
console.log('面板用的判据函数: ' + (typeof step === 'function' ? '__testAutoFollowStep（同一份代码）' : '取不到'));
console.log('—— 现在去刷新页面，然后在编辑器里试玩一局 ——\n');

const tick = async () => {
  let files;
  try { files = await ask(); } catch (e) { console.log(clock() + '  取不到（Host 没在跑？）：' + e.message); return; }
  const top = files[0] || null;
  const s = step(state, top, Date.now(), SETTLE);
  state = s.next;
  const mark = exports_.__testAutoPhaseMark(s.phase);
  console.log(clock() + '  ' + (mark + ' ' + s.phase).padEnd(14)
    + (top ? fmtSize(top.size).padStart(8) + '  局 ' + shortName(top.name) : '        —        ')
    + '  ' + s.reason
    + (s.action === 'fetch' ? '   ★ 面板此刻会自动取回这一局' : ''));
};

await tick();
const t = setInterval(() => {
  if (Date.now() - started > SECONDS * 1000) { clearInterval(t); console.log('\n守望结束'); process.exit(0); }
  tick();
}, POLL);
