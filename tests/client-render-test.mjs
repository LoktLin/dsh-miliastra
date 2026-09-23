/**
 * L3 客户端真实渲染自测：用**真实的 react / react-dom-server** 把面板组件渲染出来。
 *
 * 为什么需要这一层：技能的桩测试（selftest）能证明「槽位注册被调用了」，
 * 但证明不了「组件真的能渲染、不崩、样式里没有裸色值」。这两件事之间隔着
 * hooks 误用、未定义字段、主题令牌漂移等一堆真实故障。
 *
 * 做法：
 *   ① 造一个最小的浏览器环境（window / document），执行我们的 client bundle，
 *      截获它向 __ModuleLoader__ 注册的 factory；
 *   ② 用真实的 react 去 materialize 这个 factory；
 *   ③ 用 stub ctx（slots.inject 立刻回调）跑 apply，截获注册进去的**组件**；
 *   ④ 用 react-dom/server 的 renderToStaticMarkup 真渲染一遍。
 *
 * 用法：node tests/client-render-test.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 本机 dsh 把 react 内联进了前端 vendor 产物（没有独立的 react 包可 require），
// 所以这一层用**本包自己的 devDependency** 里的真 React 来渲染 —— 见 package.json。
const PKG_DIR = path.resolve(import.meta.dirname, '..');
const req = createRequire(path.join(PKG_DIR, 'package.json'));

let pass = 0;
let fail = 0;
const failures = [];
function check(label, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- ① 最小浏览器环境 ----------
const styleNodes = [];
const fakeNode = (tag) => ({
  tagName: String(tag).toUpperCase(),
  id: '', textContent: '', attributes: {},
  setAttribute(k, v) { this.attributes[k] = v; },
  getAttribute(k) { return this.attributes[k]; },
  remove() { const i = styleNodes.indexOf(this); if (i >= 0) styleNodes.splice(i, 1); },
});
const documentShim = {
  head: { appendChild(n) { styleNodes.push(n); } },
  body: {},
  getElementById: (id) => styleNodes.find((n) => n.id === id) || null,
  createElement: fakeNode,
};
const windowShim = {
  __ModuleLoader__: {
    load(spec) { windowShim.__captured = spec; },
  },
  innerHeight: 900,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = windowShim;
globalThis.document = documentShim;

// ---------- 执行 client bundle ----------
const bundlePath = path.resolve(import.meta.dirname, '..', 'lib', 'client.js');
const source = fs.readFileSync(bundlePath, 'utf8');
// 直接在全局作用域执行（bundle 是 IIFE，只依赖 window/document/console）
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'console', source)(windowShim, documentShim, console);

const captured = windowShim.__captured;

check('bundle 执行后向 __ModuleLoader__ 注册了 factory，且 id 正确', () => {
  assert(captured, '没有截获到 load() 调用 —— bundle 根本没注册（这正是"面板不出现"的头号病因）');
  assert(captured.id === 'dsh-miliastra', '注册的 id 不对：' + captured.id);
  assert(typeof captured.factory === 'function', 'factory 不是函数');
  return 'id=' + captured.id;
});

// ---------- ② 用真 react materialize ----------
let React = null;
let renderToStaticMarkup = null;
check('能从 web profile 里解析到真实的 react 与 react-dom/server', () => {
  React = req('react');
  renderToStaticMarkup = req('react-dom/server').renderToStaticMarkup;
  assert(React && typeof React.createElement === 'function', 'react 解析不到');
  assert(typeof renderToStaticMarkup === 'function', 'react-dom/server 解析不到');
  return 'react ' + (React.version || '?');
});

let clientExports = null;
check('factory(require) 能跑通（require 只被喂 react / primitives）', () => {
  const requireShim = (name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return req('react/jsx-runtime');
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { useDismissOnOutsidePointer() {} };
    throw new Error('bundle 请求了未提供的模块：' + name);
  };
  clientExports = captured.factory(requireShim);
  assert(clientExports && typeof clientExports.apply === 'function', 'exports.apply 缺失');
  assert(clientExports.name === 'dsh-miliastra', 'exports.name 不对：' + clientExports.name);
  assert(Array.isArray(clientExports.inject), 'exports.inject 必须是数组');
  // 回归：cordis 的服务代理是受限的 —— 不声明就访问 ctx.slots 会抛
  // 「cannot get property "slots" without inject」，并让**整条 loader entry 失败**。
  assert(clientExports.inject.includes('slots'),
    'exports.inject 必须声明 "slots"，否则 apply 里访问 ctx.slots 会被 cordis 拒掉');
  return 'exports.name=' + clientExports.name + '  inject=[' + clientExports.inject.join(',') + ']';
});

check('ctx 是「受限代理」时 apply 也不抛（服务未声明就访问会抛错的那种 ctx）', () => {
  const trap = new Proxy({}, {
    get(_t, prop) { throw new Error('cannot get property "' + String(prop) + '" without inject'); },
  });
  let threw = null;
  try { clientExports.apply(trap); } catch (e) { threw = e; }
  assert(threw === null, 'apply 抛了错（会拖垮整条 loader entry）：' + (threw && threw.message));
  return '未抛错';
});

check('信封剥离正确：unwrap 拿到的是**业务返回体**，不是 wrapper（少剥一层曾让面板全是 undefined）', () => {
  const f = clientExports.__testUnwrapToolResult;
  assert(typeof f === 'function', '缺少 __testUnwrapToolResult（信封剥离没有独立函数就无法回归测试）');

  const ok = f({ ok: true, data: { name: 'miliastra_health', ok: true, data: { ok: true, localLow: 'C:\\x', levelCount: 3 } } });
  assert(ok.localLow === 'C:\\x' && ok.levelCount === 3, '剥错层了：' + JSON.stringify(ok));
  assert(ok.name === undefined, '拿到的是 wrapper（带 name 字段）—— 少剥了一层');

  const bizFail = f({ ok: true, data: { name: 'miliastra_log', ok: true, data: { ok: false, error: '没有日志文件' } } });
  assert(bizFail.ok === false && /没有日志文件/.test(bizFail.error), '业务层失败没透出：' + JSON.stringify(bizFail));

  const callFail = f({ ok: true, data: { name: 'x', ok: false, error: 'boom' } });
  assert(callFail.ok === false && callFail.error === 'boom', '工具调用失败没透出：' + JSON.stringify(callFail));

  const empty = f(null);
  assert(empty && empty.ok === false && typeof empty.error === 'string', '空响应没有回失败对象');

  return '1 种成功 + 3 种失败形态都正确';
});

// ---------- ③ 用 stub ctx 跑 apply，截获组件 ----------
let Registered = null;
let registeredSpec = null;
let cleanup = null;
check('apply(stubCtx) 走槽位路线并交出组件 + cleanup', () => {
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: {
      inject(name, cb) { assert(name === 'sidebar.footer.action', '注入了别的槽位：' + name); return cb(); },
      register(spec, Component) {
        registeredSpec = spec; Registered = Component;
        return () => { Registered = null; };
      },
    },
  };
  cleanup = clientExports.apply(ctx);
  assert(Registered, '没有组件被注册');
  assert(registeredSpec && registeredSpec.name === 'sidebar.footer.action', '槽位名不对');
  assert(registeredSpec.id === 'dsh-miliastra', 'list 型槽位必须带 id');
  assert(typeof cleanup === 'function', 'apply 必须返回 cleanup');
  return registeredSpec.name + '#' + registeredSpec.id + '  order=' + registeredSpec.order;
});

check('样式已注入 <style data-plugin="dsh-miliastra">，且带 id 便于回收', () => {
  assert(styleNodes.length === 1, 'style 节点数不对：' + styleNodes.length);
  const s = styleNodes[0];
  assert(s.id === 'dsh-miliastra-style', 'style id 不对：' + s.id);
  assert(s.getAttribute('data-plugin') === 'dsh-miliastra', '缺 data-plugin 属性 —— 宿主无法按模块回收样式');
  return 'style ' + s.textContent.length + ' 字符';
});

check('**样式里没有裸色值**：每个 var(--dsw-*) 都带 fallback', () => {
  const css = styleNodes[0].textContent;
  const vars = css.match(/var\(--dsw-[a-z0-9-]+/g) || [];
  assert(vars.length > 0, '一个主题令牌都没用 —— 说明颜色写死了');
  const bare = (css.match(/var\(--dsw-[a-z0-9-]+\)/g) || []);
  assert(bare.length === 0, '有令牌没带 fallback：' + bare.join(', '));
  return vars.length + ' 处令牌，全部带 fallback';
});

// 视觉身份：**粉蓝**主调 + 蛋仔面板同构的结构件。这些是「观感」的可断言部分，
// 防止以后被无意改回灰扑扑的默认样式、或被改回上一版被否掉的粉紫。
check('视觉身份：粉蓝渐变（浅蓝 #7dd3fc ↔ 粉红 #f9a8d4）+ 结构件齐全', () => {
  const css = styleNodes[0].textContent;
  assert(/linear-gradient\([^)]*#7dd3fc/i.test(css), '缺浅蓝渐变（#7dd3fc）');
  assert(/linear-gradient\([^)]*#f9a8d4/i.test(css), '缺粉红渐变（#f9a8d4）');
  assert(!/#c084fc|#f0abfc|#a855f7/i.test(css), '还残留着被否掉的粉紫配色');
  for (const cls of ['-sec', '-sec-title', '-kv', '-dot', '-pill', '-primary', '-panel', '-head', '-mark', '-col', '-col-head']) {
    assert(css.includes('dsh-miliastra' + cls), '缺样式块：dsh-miliastra' + cls);
  }
  assert(/grid-template-columns:\s*repeat\(3/.test(css), '主体不是三栏网格（蛋仔面板那套）');
  assert(/\.dsh-miliastra-col\{[^}]*overflow-y:\s*auto/.test(css), '每栏没有独立滚动');
  assert(/display:\s*flex;flex-direction:\s*column;overflow:\s*hidden/.test(css), '面板不是「头部固定 + 主体自己滚」的纵向 flex');
  assert(/image-rendering:\s*pixelated/.test(css), '像素画图标缺 image-rendering:pixelated（会糊）');
  const grads = (css.match(/linear-gradient\(/g) || []).length;
  return grads + ' 处渐变；卡片/键值/状态点/胶囊/主按钮/图标齐备';
});

check('品牌图标是内联的合法 PNG data URI（换图不用改路由，也不依赖宿主静态服务）', () => {
  const hit = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(source);
  assert(hit, 'bundle 里没有内联的 PNG data URI');
  const buf = Buffer.from(hit[1], 'base64');
  assert(buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 'data URI 不是合法 PNG（魔数不对）');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert(w > 0 && h > 0, 'PNG 尺寸读不出来');
  return `内联 PNG ${w}x${h}，${buf.length} 字节（原始），${hit[1].length} 字符 base64`;
});

// ---------- ④ 真实渲染 ----------
check('真实 React 渲染（wide=true）：出「千星奇域」+ 图标 + 文字标签，不崩', () => {
  assert(Registered, '组件已被 cleanup 卸下');
  const html = renderToStaticMarkup(React.createElement(Registered, { wide: true }));
  assert(html.includes('千星奇域'), 'wide 态没渲染出入口文案：' + html.slice(0, 200));
  assert(html.includes('dsh-miliastra-btn'), '缺入口按钮类名');
  assert(html.includes('dsh-miliastra-mark'), '缺图标容器');
  assert(html.includes('data:image/png;base64,'), '图标 img 没带 data URI');
  assert(html.includes('dsh-miliastra-label'), 'wide 态缺文字标签');
  return html.replace(/\s+/g, ' ').slice(0, 140);
});

check('真实 React 渲染（wide=false）：收成窄条，只留图标不留文字', () => {
  const html = renderToStaticMarkup(React.createElement(Registered, { wide: false }));
  assert(html.includes('dsh-miliastra-rail'), '窄态没有 rail 类');
  assert(html.includes('dsh-miliastra-mark'), '窄态没有图标');
  assert(!html.includes('dsh-miliastra-label'), '窄态不该有文字标签');
  return html.replace(/\s+/g, ' ').slice(0, 100);
});

check('面板初始为关闭态：渲染结果里没有浮层（不该一上来就糊一层）', () => {
  const html = renderToStaticMarkup(React.createElement(Registered, { wide: true }));
  assert(!html.includes('dsh-miliastra-panel'), '初始就渲染了浮层');
  return '未渲染浮层';
});

check('cleanup 之后能重新挂上（热重载不留幽灵）', () => {
  cleanup();
  let again = null;
  const ctx2 = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject: (n, cb) => cb(), register: (s, C) => { again = C; return () => {}; } },
  };
  clientExports.apply(ctx2);
  assert(again, 'cleanup 后重挂失败');
  return '已重挂';
});

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
