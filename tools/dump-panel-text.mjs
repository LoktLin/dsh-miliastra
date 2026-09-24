/**
 * tools/dump-panel-text.mjs — 把侧边栏面板**渲染后的纯文字**打出来。
 *
 * 用途：改面板文案时，先自己读一遍「用户会看到的字」。
 * 作者的原话是「gui 界面也没看懂探针作用」—— 那次就是因为没人以使用者视角读过一遍。
 *
 * 环境与 client-render-test.mjs 一致：最小 window/document + 真 react 的 SSR。
 * 用法: node tools/dump-panel-text.mjs [关键字，默认「探针」]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const PKG_DIR = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(PKG_DIR, 'package.json'));

const styleNodes = [];
const fakeNode = (t) => ({
  tagName: String(t).toUpperCase(), id: '', textContent: '', attributes: {},
  setAttribute(k, v) { this.attributes[k] = v; },
  getAttribute(k) { return this.attributes[k]; },
  remove() {},
});
const documentShim = {
  head: { appendChild(n) { styleNodes.push(n); } },
  body: {}, getElementById: () => null, createElement: fakeNode,
};
const windowShim = {
  __ModuleLoader__: { load(s) { windowShim.__captured = s; } },
  innerHeight: 900, innerWidth: 1200, addEventListener() {}, removeEventListener() {},
};
globalThis.window = windowShim;
globalThis.document = documentShim;

const source = fs.readFileSync(path.join(PKG_DIR, 'lib', 'client.js'), 'utf8');
// eslint-disable-next-line no-new-func -- 把插件自己的 client.js 塞进假 window/document 里跑（无头渲染面板取文案），不是 eval 外部输入
new Function('window', 'document', 'console', source)(windowShim, documentShim, console);

const React = req('react');
const exports_ = windowShim.__captured.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return req('react/jsx-runtime');
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { useDismissOnOutsidePointer() {} };
  throw new Error('未提供的模块：' + name);
});

const SAMPLE_LOGS = [
  { time: '17:04:12', message: '[P5D] OnInit' },
  { time: '17:04:12', message: '[P5D] EnableUpdate ok=true err=nil' },
  { time: '17:04:15', message: '[P5D] 《双相》就绪（4 关，控件 12，画布 1600x1000）' },
  { time: '17:04:16', message: '[P5D] 收到首个按键事件: KeyboardCraftspersonKey38Down（来源=KeyEventType）' },
  { time: '17:04:19', message: '[P5D] 创建控件失败：InstantiateClientUIControl 返回 nil（模板库为空？）' },
  { time: '17:04:20', message: '[P5D] 重试中 timeout=3000' },
  { time: '17:04:21', message: '[BIG] ' + 'Enum.KeyEventType.KeyboardCraftspersonKey1Down=…, '.repeat(200) + 'END' },
];

const SAMPLE_UI = {
  ok: true, count: 37,
  likelyTemplates: [
    { id: 1073741867, name: '文本框', parent: null },
    { id: 1073741868, name: '图片', parent: null },
    { id: 1073741863, name: '容器节点', parent: null },
  ],
  records: [
    { id: 1073741848, name: '客户端控件容器', parent: null },
    { id: 1073741867, name: '文本框', parent: null },
    { id: 1073741868, name: '图片', parent: null },
    { id: 1073741863, name: '容器节点', parent: null },
    { id: 1073741864, name: '图片', parent: 1073741863 },
  ],
  rendered: '（略）',
};

const html = req('react-dom/server').renderToStaticMarkup(
  React.createElement(exports_.__testPanel, {
    open: true, setOpen() {}, rootRef: { current: null },
    __advOpen: process.argv.includes('--adv'),
    __logs: process.argv.includes('--logs') ? exports_.__testToLogRows(SAMPLE_LOGS) : [],
    __uiInfo: process.argv.includes('--ui') ? SAMPLE_UI : null,
    __uiRaw: process.argv.includes('--uiraw'),
    __backups: process.argv.includes('--backups') ? {
      ok: true, count: 2, backupDir: 'C:\\x\\external_lua_file\\_backup',
      fixedBackup: 'C:\\x\\external_lua_file\\_backup\\双相.bak', fixedExists: true,
      entries: [
        { name: '双相.bak', path: 'C:\\x\\_backup\\双相.bak', size: 22446, fixed: true, createdAt: '2026-09-23T19:00:00.000Z' },
        { name: '双相.20260923-180000_备份.lua', path: 'C:\\x\\_backup\\双相.20260923-180000_备份.lua', size: 22446, fixed: false, createdAt: '2026-09-23T18:00:00.000Z' },
      ],
    } : null,
  }),
);

const lines = html
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<\/(div|span|p|button|label|section)>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const kw = process.argv[2] || '探针';
const i = lines.findIndex((s) => s.includes(kw));
console.log(i >= 0 ? lines.slice(i).join('\n') : lines.join('\n'));
console.log('\n—— 以上是渲染后的纯文字（' + lines.length + ' 行，面板 HTML ' + html.length + ' 字符）——');
