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
// 静态 import：本文件的 check() 是**同步**的，用 await import() 会让断言变成
// 「永远通过」的假测试（详见 probe-deploy-test.mjs 文件头的同一条警告）。
import { PROBE_TEMPLATES, PROBE_INFO } from '../lib/probes.mjs';

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
let registeredBySlot = null;
let cleanup = null;
check('apply(stubCtx) 走槽位路线并交出组件 + cleanup', () => {
  const injectedSlots = [];
  registeredBySlot = {};
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: {
      // 0.1.0 起 apply 会注入两个槽位：sidebar.footer.action（入口）+ conversation.view（三个 tab）
      inject(name, cb) { injectedSlots.push(name); return cb(); },
      register(spec, Component) {
        const slot = spec && spec.name;
        (registeredBySlot[slot] = registeredBySlot[slot] || []).push({ spec, Component });
        if (slot === 'sidebar.footer.action') { registeredSpec = spec; Registered = Component; }
        return () => { if (slot === 'sidebar.footer.action') Registered = null; };
      },
    },
  };
  cleanup = clientExports.apply(ctx);
  assert(Registered, '没有组件被注册');
  assert(registeredSpec && registeredSpec.name === 'sidebar.footer.action', '槽位名不对');
  assert(registeredSpec.id === 'dsh-miliastra', 'list 型槽位必须带 id');
  assert(typeof cleanup === 'function', 'apply 必须返回 cleanup');
  assert(injectedSlots.includes('sidebar.footer.action'), '没有注入侧边栏入口槽位');
  assert(injectedSlots.includes('conversation.view'), '没有注入会话区 tab 槽位');

  // 会话区三个 tab（初级功能 / 高级功能 / 模拟器）
  const views = registeredBySlot['conversation.view'] || [];
  assert(views.length === 3, 'conversation.view 应注册 3 个 tab，实际 ' + views.length);
  const tabs = clientExports.__testViewTabs;
  assert(Array.isArray(tabs) && tabs.length === 3, '__testViewTabs 缺失或不是 3 项');
  for (const t of tabs) {
    const hit = views.find((v) => v.spec && v.spec.id === t.id);
    assert(hit, '缺少 tab：' + t.id);
    const label = typeof hit.spec.label === 'function' ? hit.spec.label() : hit.spec.label;
    assert(label === t.label, 'tab 文案不对：' + label + ' vs ' + t.label);
    assert(hit.spec.order === t.order, 'tab order 不对：' + t.id);
    assert(typeof hit.Component === 'function', 'tab 没有组件：' + t.id);
  }
  return registeredSpec.name + '#' + registeredSpec.id + '  + tabs=' + views.map((v) => (typeof v.spec.label === 'function' ? v.spec.label() : v.spec.label)).join('/');
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

// 空状态把**整个面板**渲染一遍：三栏骨架 + 每张卡片都必须在场。
// 这条能抓到「卡片被写坏 / 少一个孩子 / 引用了不存在的变量」这类一渲染就炸的错
// （历史上踩过一次：编辑时打断了 mapKids 的定义，靠这层才发现）。
check('空状态下整面板渲染：三栏骨架 + 全部卡片都在（不炸）', () => {
  const PanelComp = clientExports.__testPanel;
  assert(typeof PanelComp === 'function', '没暴露 __testPanel，无法做整面板渲染测试');
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(PanelComp, {
      open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'all',
    }));
  } catch (e) {
    throw new Error('整面板渲染抛错：' + e.message);
  }
  assert(html.includes('dsh-miliastra-panel'), '没渲染出面板根');
  for (const head of ['① 关卡', '② 代码', '③ 日志']) {
    assert(html.includes(head), '缺栏目：' + head);
  }
  for (const card of ['关卡</div>', '关卡与文件', '地图体检', '活文件', '活文件体检', '脚本一致性',
    '备份', '部署到活文件', '运行时日志', '探针', '刷新']) {
    assert(html.includes(card), '缺卡片/按钮：' + card);
  }
  assert(html.includes('dsh-miliastra-col'), '三栏容器没渲染');
  return `${html.length} 字符，三栏 + ${10} 张卡片齐备`;
});

// Host 是**启动时的快照** —— 面板要把「源码比它新」说出来（P0-C：今晚为此花了 5 个调用定位）。
check('版本行：Host / 源码对照，陈旧时才警告并给下一步', () => {
  const props = (status) => ({ open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'all', __status: status });
  const fresh = renderToStaticMarkup(React.createElement(clientExports.__testPanel, props({
    version: '0.0.10', startedAt: '2026-09-23T14:18:00.000Z',
    source: { sourceVersion: '0.0.10', stale: false, hint: null },
  })));
  assert(fresh.includes('Host v0.0.10'), '版本行没渲染 Host 版本');
  assert(fresh.includes('源码 v0.0.10'), '版本行没渲染源码版本');
  assert(!fresh.includes('⚠️ Host'), '没过期却报了警告');

  const staleHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, props({
    version: '0.0.5', startedAt: '2026-09-23T14:18:00.000Z',
    source: { sourceVersion: '0.0.10', stale: true, hint: '源码比 Host 快照新（源码 v0.0.10 ≠ 载入的 v0.0.5）→ Host 半边（工具 / 路由 / 系统提示）的改动要**重启 dsh web** 才生效；只改 lib/client.js 刷新页面即可' },
  })));
  assert(staleHtml.includes('⚠️ Host v0.0.5'), '陈旧时没标出警告与当时载入的版本');
  assert(staleHtml.includes('源码 v0.0.10'), '陈旧时没给出源码版本');
  assert(staleHtml.includes('重启 dsh web'), '陈旧时没给下一步（重启 dsh web）');
  return '常显 Host/源码；陈旧时琥珀色 + 重启指引';
});


// 探针现在收在「高级诊断」折叠区里（默认收起），所以下面这些断言都要显式展开它。
const openAdv = (extra) => Object.assign({
  open: true, setOpen: () => {}, rootRef: { current: null }, __advOpen: true, __panelTab: 'all',
}, extra || {});

check('★ 日志格式化：拆出 时间 / [TAG] / 正文，且只对疑似异常着色', () => {
  const p = clientExports.__testParseLogRecord;
  assert(typeof p === 'function', '缺少 __testParseLogRecord（日志格式化无法单独回归）');

  const a = p({ time: '17:04:15', message: '[P5D] 《双相》就绪（4 关，控件 12）' });
  assert(a.time === '17:04:15', '时间没拆出来：' + a.time);
  assert(a.tag === 'P5D', '[TAG] 没拆出来：' + a.tag);
  assert(a.text === '《双相》就绪（4 关，控件 12）', '正文里还留着 [TAG] 前缀：' + a.text);
  assert(a.bad === false && a.warn === false, '正常行不该被判为异常');

  // 异常行要显眼
  assert(p({ time: 't', message: '[X] 创建控件失败：返回 nil' }).bad === true, '「失败」没被判为疑似异常');
  assert(p({ time: 't', message: '[X] Error: bad argument count' }).bad === true, 'error 没被判为疑似异常');
  assert(p({ time: 't', message: '[X] 重试中 timeout' }).warn === true, 'timeout 没被判为警告');
  // ⚠️ 反例：`err=nil` 是**正常**输出（探针常打），不能一见 nil 就标红
  assert(p({ time: 't', message: '[PROBE] EnableUpdate ok=true err=nil' }).bad === false,
    'err=nil 被误判为异常 —— 这会让「只看异常」全是噪音');

  // 没有 [TAG] 的行也要能用
  const noTag = p({ time: 't', message: '裸正文一行' });
  assert(noTag.tag === '' && noTag.text === '裸正文一行', '无 TAG 的行拆错了：' + JSON.stringify(noTag));

  const rows = clientExports.__testToLogRows([{ time: 't', message: '[A] 一' }, { time: 't', message: '[B] 二' }]);
  assert(rows.length === 2 && rows[0].tag === 'A' && rows[1].tag === 'B', 'toLogRows 批量转换错了');
  return '时间/[TAG]/正文 拆对；失败↔正常↔警告 判对（含 err=nil 反例）';
});

check('★ 超长日志行折叠成「点开看全」（1 万字符的枚举 dump 不该撑爆面板）', () => {
  // 用一条真·超长记录渲染：走 LogRow → 应产出 <details> 而不是直接把 1 万字塞进 DOM
  const long = 'x'.repeat(10000);
  const rows = clientExports.__testToLogRows([{ time: 't', message: '[BIG] ' + long }]);
  assert(rows[0].text.length === 10000, '超长正文被解析改了长度');
  const detail = renderToStaticMarkup(React.createElement(clientExports.__testLogRow, rows[0], 0));
  assert(detail.includes('<details'), '超长行没有折叠成 <details>');
  assert(detail.includes('共 10000 字符'), '折叠摘要里没说总长度');
  assert(detail.indexOf('xxxx') < detail.indexOf('<pre'), '摘要里不该直接铺满全文');
  const short = renderToStaticMarkup(React.createElement(clientExports.__testLogRow,
    clientExports.__testToLogRows([{ time: 't', message: '[S] 短行' }])[0], 0));
  assert(!short.includes('<details'), '短行不该折叠');
  return '超长行 → <details> + 总长度提示；短行不折叠';
});

check('★ 「试玩完自动取」判据：只在**看见试玩动过**之后才自动取回', () => {
  const step = clientExports.__testAutoFollowStep;
  assert(typeof step === 'function', '缺少 __testAutoFollowStep（自动取回的判据无法回归）');
  const T0 = 1_700_000_000_000;
  const f = (name, size, ageMs) => ({ name, size, mtimeMs: T0 - (ageMs || 0), path: 'C:\\x\\' + name });
  const S = 6000;

  // ① 没有文件 → 不动
  const noFile = step(null, null, T0, S);
  assert(noFile.action === 'none' && noFile.phase === 'idle', '没日志文件时不该动作：' + JSON.stringify(noFile));

  // ② 首次看到「刚写过」的一局（mtime 10 秒前）→ 记为刚玩过，但**当次不取**
  const fresh = step(null, f('a.gia', 1000, 10000), T0, S);
  assert(fresh.action === 'none', '刚建立基线时不该立刻取回');
  assert(fresh.next.activity === true, '「10 秒前才写过」应算刚玩过');
  assert(fresh.phase === 'new-session', 'phase 不对：' + fresh.phase);

  // ③ 首次看到「2 小时前的一局」→ 不算刚玩过，之后也不该自动取（别拿旧局面糊人）
  const stale = step(null, f('old.gia', 5000, 2 * 3600 * 1000), T0, S);
  assert(stale.next.activity === false, '2 小时前的局面不该算「刚玩过」');
  let s = stale.next;
  for (const t of [T0 + 2000, T0 + 8000, T0 + 20000]) s = step(s, f('old.gia', 5000, 2 * 3600 * 1000), t, S).next;
  assert(step(s, f('old.gia', 5000, 2 * 3600 * 1000), T0 + 30000, S).action === 'none',
    '旧局面被自动取回了 —— 打开面板就会糊用户一脸几小时前的日志');

  // ③-b ★ 回归：Host 返回的是 `mtime`（ISO 字符串），不是 `mtimeMs`。
  //      曾经读错字段名 → age 恒 0 → 「刚玩过」永远为真 → 旧局面被自动取回。
  const isoOld = { name: 'iso.gia', size: 5000, mtime: new Date(T0 - 2 * 3600 * 1000).toISOString(), path: 'C:\\x\\iso.gia' };
  const isoOldStep = step(null, isoOld, T0, S);
  assert(isoOldStep.next.activity === false, '只给 mtime（ISO 字符串）的旧局面被误判成「刚玩过」—— 字段名又写错了');
  let sIso = isoOldStep.next;
  for (const t of [T0 + 8000, T0 + 20000]) sIso = step(sIso, isoOld, t, S).next;
  assert(step(sIso, isoOld, T0 + 30000, S).action === 'none', 'ISO mtime 的旧局面被自动取回了');
  // 反过来：ISO mtime 且很新 → 应当算「刚玩过」
  const isoFresh = { name: 'iso2.gia', size: 900, mtime: new Date(T0 - 5000).toISOString(), path: 'C:\\x\\iso2.gia' };
  assert(step(null, isoFresh, T0, S).next.activity === true, '刚写完的 ISO mtime 局面没算「刚玩过」');
  // mtime 完全缺失 → 保守当「很旧」，不许自动取
  const noTime = { name: 'notime.gia', size: 900, path: 'C:\\x\\notime.gia' };
  assert(step(null, noTime, T0, S).next.activity === false, 'mtime 缺失时应保守判为「旧」，不该自动取');

  // ④ 守望期间冒出新的一局 → 记为「动过」，安静够久 → 取回
  s = step(fresh.next, f('b.gia', 200, 0), T0 + 4000, S);
  assert(s.phase === 'new-session' && s.next.activity === true, '新文件没被识别成新的一局：' + JSON.stringify(s));
  // 还在写 → 不取
  s = step(s.next, f('b.gia', 800, 0), T0 + 8000, S);
  assert(s.phase === 'growing' && s.action === 'none', '文件在变大时不该取：' + JSON.stringify(s));
  // 刚安静下来 → 还在等
  s = step(s.next, f('b.gia', 800, 0), T0 + 12000, S);
  assert(s.phase === 'settling' && s.action === 'none', '刚安静下来不该立刻取：' + JSON.stringify(s));
  // 安静够 6 秒 → 取回
  s = step(s.next, f('b.gia', 800, 0), T0 + 19000, S);
  assert(s.action === 'fetch', '安静够久后应当自动取回：' + JSON.stringify(s));
  // 已取过的不重复取
  const again = step(s.next, f('b.gia', 800, 0), T0 + 60000, S);
  assert(again.action === 'none' && again.phase === 'done', '同一版日志被取了两次：' + JSON.stringify(again));

  // ⑤ 空文件不取（这一局还没写出内容）
  let eSt = step(fresh.next, f('c.gia', 0, 0), T0 + 4000, S).next;   // 新的一局，但 0 字节
  let eR = step(eSt, f('c.gia', 0, 0), T0 + 10000, S);
  eSt = eR.next;
  eR = step(eSt, f('c.gia', 0, 0), T0 + 20000, S);
  assert(eR.phase === 'empty' && eR.action === 'none', '空文件应当判为「还没写出内容」：' + JSON.stringify(eR));

  return '无文件不动 / 旧局面不取 / 新一局+安静够久才取 / 不重复取 / 空文件不取';
});

check('★ 局面名与状态图标（面板上只显示 HH:MM:SS，不铺一长串文件名）', () => {
  const s = clientExports.__testShortSessionName;
  assert(s('2026-09-23_18-44-57_151_201170108.gia') === '18:44:57', '局面名没缩成时间：' + s('2026-09-23_18-44-57_151_201170108.gia'));
  assert(s('乱七八糟.gia') === '乱七八糟', '非常规文件名应当原样回退：' + s('乱七八糟.gia'));
  const m = clientExports.__testAutoPhaseMark;
  assert(m('growing') && m('new-session') && m('done') && m('settling'), '状态图标有空的：' + JSON.stringify(['growing', 'new-session', 'done', 'settling'].map(m)));
  return 'HH:MM:SS 抽取 + 4 种状态图标齐备';
});

check('★ 高级诊断默认**收起**（只读的 UI 读取 + 会覆盖脚本的探针都关在里面）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
  }));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/高级诊断/.test(flat), '找不到「高级诊断」折叠标题');
  assert(/平时不用展开/.test(flat), '收起态没说明「平时不用展开」');
  assert(/读界面控件/.test(flat), '折叠标题里没提「读界面控件」');
  // 收起时：两块内容都不该在 DOM 里（不是 width:0 藏起来，是真不渲染）
  for (const nope of ['部署探针', '收回结论', '翻字典', '试钥匙', '全部 37 条记录']) {
    assert(!flat.includes(nope), '收起态却渲染了内部内容：' + nope);
  }
  // 展开后两块都要出现，而且要分别标出风险（UI 读取 = 只读；探针 = 会覆盖）
  const open = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const openFlat = open.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/部署探针/.test(openFlat) && /翻字典/.test(openFlat), '展开后探针内容没出来');
  assert(/① 读界面控件（只读/.test(openFlat), '没标出 UI 读取是只读的');
  assert(/② 探针（⚠️ 会临时覆盖你的脚本/.test(openFlat), '没标出探针会覆盖脚本');
  return '收起：只有标题；展开：① 只读 UI 读取 + ② 会覆盖脚本的探针，各自标了风险';
});

check('★ 读界面控件：给出可创建模板 / 容器节点 / 全部记录，并说明「无父节点只是候选」', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __uiInfo: {
      ok: true, count: 37,
      likelyTemplates: [
        { id: 1073741867, name: '文本框', parent: null },
        { id: 1073741868, name: '图片', parent: null },
        { id: 1073741863, name: '容器节点', parent: null },
      ],
      records: [
        { id: 1073741867, name: '文本框', parent: null },
        { id: 1073741868, name: '图片', parent: null },
        { id: 1073741863, name: '容器节点', parent: null },
        { id: 1073741864, name: '图片', parent: 1073741863 },
      ],
    },
  })));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  assert(/读界面控件/.test(flat), '缺「读界面控件」入口');
  assert(/可被脚本创建的控件模板（2 个）/.test(flat), '没把「可创建模板」单列出来（容器节点不该算进去）：' + flat.slice(0, 200));
  assert(/1073741867/.test(flat) && /1073741868/.test(flat), '没列出可用的模板索引');
  assert(/容器节点（1 个）/.test(flat), '没单列容器节点');
  assert(/不能被脚本创建/.test(flat), '没说明容器实例不可创建');
  assert(/无父节点/.test(flat) && /候选/.test(flat), '没说明「无父节点只是候选条件」');
  assert(/试钥匙/.test(flat), '没指向「确证能不能创建」的办法');
  assert(/全部 37 条记录/.test(flat), '缺「展开全部记录」');

  // 模板库为空时要说清后果与去哪建模板（这是最常见的一步踩坑）
  const empty = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __uiInfo: { ok: true, count: 5, likelyTemplates: [], records: [{ id: 1, name: '容器节点', parent: null }] },
  })));
  const emptyFlat = empty.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/一个都没有/.test(emptyFlat), '模板为空时没报警');
  assert(/返回 nil/.test(emptyFlat), '没说清后果（动态创建会返回 nil）');
  assert(/添加客户端控件/.test(emptyFlat) && /存为模板|各存一条独立模板/.test(emptyFlat), '没给出「去哪建模板」的路径');
  return '可创建模板 / 容器节点 / 全部记录 / 候选说明 / 空库告警 都在';
});

check('★ 探针卡片讲「人话」：说清是什么/代价/四步流程，且模板清单一个不漏', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 得先回答「探针是什么」「要付什么代价」—— 作者的原话是「没看懂探针作用」
  assert(/探针是干嘛的/.test(flat), '没有「探针是干嘛的」这一句');
  assert(/临时替掉你脚本/.test(flat), '没有用大白话解释探针是什么');
  assert(/什么时候用/.test(flat), '没有说什么时候该用它');
  assert(/要付什么代价/.test(flat) && /玩法不会跑/.test(flat), '没说清「试玩那一局玩法不会跑」这个代价');
  // ② 四步流程要能看到，且最后一步是还原脚本
  assert(/流程/.test(flat), '没有流程说明');
  assert(/重新试玩一局/.test(flat), '流程里没写「重新试玩一局」');
  assert(/还原你的脚本|还原脚本/.test(flat), '流程里没写最后一步「还原你的脚本」');

  // ③ 模板按钮用大白话名，且**每个**模板都在（含 api-surface / api-check —— 面板曾漏掉 api-surface）
  for (const t of ['ping', 'tree', 'instantiate', 'api-surface']) {
    assert(flat.includes(t), '模板按钮缺 ' + t);
  }
  for (const label of ['探活', '看控件', '试钥匙', '翻字典']) {
    assert(flat.includes(label), '缺大白话标签：' + label);
  }
  return '是什么 / 代价 / 四步流程 / ' + PROBE_TEMPLATES.length + ' 个模板 + 大白话名 都在';
});

check('★ 面板兜底文案与 Host 的 PROBE_INFO 不脱节（模板清单、标签、一句话说明）', () => {
  const src = fs.readFileSync(path.join(PKG_DIR, 'lib', 'client.js'), 'utf8');
  const infoBlock = /var PROBE_FALLBACK = \[([\s\S]*?)\n      \];/.exec(src);
  assert(infoBlock, 'client.js 里找不到 PROBE_FALLBACK 兜底表（改了结构就更新这条测试）');
  const block = infoBlock[1];
  const missing = PROBE_TEMPLATES.filter((t) => !new RegExp("template: '" + t + "'").test(block));
  assert(missing.length === 0, 'Host 有模板但面板兜底文案里没有：' + missing.join(', '));
  const extra = (block.match(/template: '([^']+)'/g) || [])
    .map((s) => s.replace(/template: '|'/g, ''))
    .filter((t) => PROBE_TEMPLATES.indexOf(t) < 0);
  assert(extra.length === 0, '面板兜底文案里有 Host 已不存在的模板：' + extra.join(', '));
  for (const t of PROBE_TEMPLATES) {
    const label = PROBE_INFO[t].label;
    assert(block.includes("'" + label + "'"), '模板 ' + t + ' 的兜底标签与 Host 不一致（应为 ' + label + '）');
    // oneLine 也必须是同一句话 —— 否则面板与工具描述会各说各的（用户看到的和 AI 看到的不是一回事）
    assert(block.includes(PROBE_INFO[t].oneLine), '模板 ' + t + ' 的兜底 oneLine 与 Host 不一致：' + PROBE_INFO[t].oneLine);
  }
  return PROBE_TEMPLATES.length + ' 个模板的兜底文案（标签 + oneLine）与 Host 一致';
});

check('★ 部署后（已部署状态）渲染出「第 4 步：还原我的脚本」按钮', () => {
  const PanelComp = clientExports.__testPanel;
  const html = renderToStaticMarkup(React.createElement(PanelComp, openAdv({
    __probeBackup: 'C:\\x\\_backup\\双相_20260923104427_备份.lua',
  })));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/探针已部署/.test(flat), '已部署状态没给出提示');
  assert(/重新试玩一局/.test(flat), '已部署状态没提醒「重新试玩」');
  // 认按钮元素本身，别认字面 —— 收起态的提示语里也含「还原我的脚本」这几个字
  assert(/④ 还原我的脚本<\/button>/.test(html), '缺「④ 还原我的脚本」按钮 —— 用户会忘记把探针换回去');
  // 只有「已部署」才出现，别一上来就摆一个会误点的按钮
  const clean = renderToStaticMarkup(React.createElement(PanelComp, openAdv()));
  assert(!/④ 还原我的脚本<\/button>/.test(clean), '未部署时不该出现「还原我的脚本」按钮');
  return '已部署：提示 + 重新试玩提醒 + 还原按钮；未部署：按钮不出现';
});

check('★ Host 清单比磁盘少时，探针卡片提示「Host 是旧版 + 重启 dsh web」', () => {
  // 用 Host 的**真实**模板清单构造两种情形 —— 写死清单会在加模板时变成假失败（踩过）
  const missingTpl = PROBE_TEMPLATES[PROBE_TEMPLATES.length - 1];
  const partial = PROBE_TEMPLATES.filter((t) => t !== missingTpl);
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __probeInfo: { templates: partial, info: [], overview: {} },
  })));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/Host 是旧版/.test(flat), '没提示「运行中的 Host 是旧版」');
  assert(flat.includes(missingTpl), '没点名少了哪个模板（应为 ' + missingTpl + '）');
  assert(/重启 dsh web/.test(flat), '提示里没给下一步动作（重启 dsh web）');
  // 反过来：Host 清单齐全时不该有这条噪音
  const ok = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __probeInfo: { templates: PROBE_TEMPLATES.slice(), info: [], overview: {} },
  })));
  assert(!/Host 是旧版/.test(ok.replace(/<[^>]+>/g, ' ')), 'Host 清单齐全时不该提示旧版');
  return '缺 ' + missingTpl + ' 时提示 + 点名 + 给动作；齐全时不提示';
});

check('★ 界面文案里没有 Markdown 记号（面板不渲染 Markdown，`**` 会原样显示给人看）', () => {
  // 每种「展开态」都要查 —— 否则藏在折叠区/条件渲染里的文案会漏网
  // （踩过：UI 读取那块的 `**不能被脚本创建**` 就是只在展开+有数据时才渲染，一开始没查到）
  const variants = [
    ['默认（收起）', { open: true, setOpen: () => {}, rootRef: { current: null } }],
    ['高级诊断展开', openAdv()],
    ['高级诊断展开 + 试玩状态 + 有备份', openAdv({
      __autoState: { phase: 'growing', reason: '这一局还在写（试玩中）', name: 'a.gia', size: 1 },
      __pendingProbe: true,
      __probeBackup: 'C:\\x\\_backup\\双相.bak',
      __probeResult: { hit: true, tag: 'P1', lines: ['[P1] x'] },
      __backups: { ok: true, count: 1, backupDir: 'C:\\x\\_backup', fixedBackup: 'C:\\x\\_backup\\双相.bak',
        fixedExists: true, entries: [{ name: '双相.bak', path: 'C:\\x\\_backup\\双相.bak', size: 1, fixed: true }] },
      __pendingRestore: '__fixed__',
      __uiInfo: { ok: true, count: 3, likelyTemplates: [{ id: 1073741867, name: '文本框', parent: null }],
        records: [{ id: 1073741867, name: '文本框', parent: null }, { id: 1073741863, name: '容器节点', parent: null }] },
      __uiRaw: true,
      // 截图回执 / 备份说明也是**从 Host 拿来的**文本，里面有给 AI 看的 Markdown —— 面板必须剥掉再显示
      __shot: {
        dir: 'C:\\Users\\x\\.dsh\\miliastra\\shots', count: 2, totalBytes: 5055388, totalText: '4.8 MB',
        newest: { name: 'game-a.png', sizeText: '2.4 MB', mtime: '2026-09-23T12:49:15.000Z' },
        files: [
          { name: 'game-a.png', sizeText: '2.4 MB', mtime: '2026-09-23T12:49:15.000Z' },
          { name: 'game-b.png', sizeText: '2.4 MB', mtime: '2026-09-23T12:49:16.000Z' },
        ],
        lastCapture: { ok: true, file: 'game-a.png', process: 'YuanShen', pid: 3284, title: '原神',
          width: 1456, height: 939, mode: 'printwindow', blackRatio: 0.0312, suspect: false },
      },
      __logs: [{ time: 't', tag: 'A', text: '正常', raw: '[A] 正常' }, { time: 't', tag: 'A', text: '失败', bad: true, raw: '[A] 失败' }],
    })],
  ];
  const bad = [];
  for (const [name, props] of variants) {
    const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, props));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    const stars = text.match(/\*\*[^*]{1,40}\*\*/g);
    if (stars) bad.push(name + ' → ' + stars.slice(0, 3).join(' | '));
    const ticks = (text.match(/`[^`\n]{1,40}`/g) || []).filter((s) => !/`\+/.test(s));
    if (ticks.length) bad.push(name + ' → 反引号 ' + ticks.slice(0, 3).join(' | '));
  }
  assert(bad.length === 0, '界面文案里有 Markdown 记号（会原样显示）：' + bad.join('；'));
  return variants.length + ' 种渲染态下都无 ** / 反引号 残留';
});

check('★ 备份卡片：说明备份在哪 / 固定名 / 一键还原（作者要求的三件事都要看得见）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __backups: {
      ok: true, count: 2, backupDir: 'C:\\x\\external_lua_file\\_backup',
      fixedBackup: 'C:\\x\\external_lua_file\\_backup\\双相.bak',
      fixedExists: true,
      entries: [
        { name: '双相.bak', path: 'C:\\x\\external_lua_file\\_backup\\双相.bak', size: 22446, fixed: true, createdAt: '2026-09-23T19:00:00.000Z' },
        { name: '双相.20260923-180000_备份.lua', path: 'C:\\x\\external_lua_file\\_backup\\双相.20260923-180000_备份.lua', size: 22446, fixed: false, createdAt: '2026-09-23T18:00:00.000Z' },
      ],
    },
  }));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 备份写在哪 —— 作者明确要求「写到被替换的文件旁边」
  assert(/旁边/.test(flat) && /_backup/.test(flat), '没说清备份写在哪里');
  // ② 固定统一的备份名
  assert(/固定名备份/.test(flat) && /双相\.bak/.test(flat), '没显示固定名备份');
  // ③ 一键还原（不用自己挑版本）
  assert(/还原到最新备份<\/button>/.test(html), '缺「还原到最新备份」按钮');
  assert(/最近一次覆盖前/.test(flat), '没说明固定名那份到底是什么');
  // 固定名那条要标星，方便在列表里认出来
  assert(/★ 双相\.bak/.test(flat), '列表里固定名那份没有标记');
  // 确认步骤要讲清后果（覆盖谁、会先备份、会校验回滚）—— 这是覆盖前最后一句话
  const confirmHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __pendingRestore: '__fixed__',
    __backups: {
      ok: true, count: 1, backupDir: 'C:\\x\\_backup',
      fixedBackup: 'C:\\x\\_backup\\双相.bak', fixedExists: true,
      entries: [{ name: '双相.bak', path: 'C:\\x\\_backup\\双相.bak', size: 10, fixed: true }],
    },
  }));
  const confirmFlat = confirmHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/覆盖当前活文件/.test(confirmFlat), '确认步骤没说覆盖谁');
  assert(/会先把当前版本再备份一次/.test(confirmFlat), '确认步骤没说要先备份');
  assert(/会自动回滚/.test(confirmFlat), '确认步骤没提校验/回滚');

  // 没有固定名时不该出现一键按钮，而要给一句解释（Host 旧版的情况）
  const noFixed = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __backups: { ok: true, count: 1, backupDir: 'C:\\x\\_backup', fixedBackup: 'C:\\x\\_backup\\双相.bak',
      fixedExists: false, entries: [{ name: '双相.20260923-180000_备份.lua', path: 'C:\\x\\_backup\\双相.20260923-180000_备份.lua', size: 10, fixed: false }] },
  }));
  assert(!/还原到最新备份<\/button>/.test(noFixed), '没有固定名备份却给了一键还原按钮');
  assert(/Host 可能是旧版/.test(noFixed.replace(/<[^>]+>/g, ' ')), '没解释为什么没有固定名备份');
  return '位置 + 固定名 + 一键还原 + ★标记 + 确认后果；缺固定名时给解释';
});


check('★ 截图卡片：存到哪 / 多少张 / 不会自动删，三件事都必须在卡片上', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: {
      dir: 'C:\\Users\\x\\.dsh\\miliastra\\shots', count: 7, totalBytes: 17694858, totalText: '16.9 MB',
      newest: { name: 'game-试玩第1局-20260923-204915.png', sizeText: '2.4 MB', mtime: '2026-09-23T12:49:15.000Z' },
      files: [{ name: 'game-试玩第1局-20260923-204915.png', sizeText: '2.4 MB', mtime: '2026-09-23T12:49:15.000Z' }],
      lastCapture: {
        ok: true, file: 'game-试玩第1局-20260923-204915.png', process: 'YuanShen', pid: 3284,
        title: '原神', width: 1456, height: 939, mode: 'printwindow', blackRatio: 0.0312, suspect: false,
      },
    },
  }));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 存到哪 —— 这是作者的原话要求（「跟日志一样要提示用户」）
  assert(/存放目录/.test(flat), '没显示存放目录');
  assert(/miliastra/.test(flat) && /shots/.test(flat), '没显示截图目录的绝对路径');
  // ② 有多少、占多大 —— 不然用户根本不知道要不要清
  assert(/7 张/.test(flat), '没显示张数');
  assert(/16\.9 MB/.test(flat), '没显示占用体积');
  assert(/game-试玩第1局/.test(flat), '没显示最近一张的文件名');
  // ③ 不会自动删 —— 最关键的一句（用户会以为工具会自己收拾）
  assert(/不会自动删/.test(flat), '没说明「不会自动删」');
  assert(/先看/.test(flat), '没说清清理是「先看再确认」两步');
  // ④ 三个动作按钮
  assert(/截取游戏画面<\/button>/.test(html), '缺「截取游戏画面」按钮');
  assert(/截编辑器<\/button>/.test(html), '缺「截编辑器」按钮');
  assert(/清理…<\/button>/.test(html), '缺「清理…」按钮');
  // ⑤ 回执要自证「截到的是哪个窗口」（第一版抓错程序就是这里漏的）
  assert(/原神/.test(flat) && /3284/.test(flat), '没显示截到的窗口标题/pid');
  assert(/窗口自绘/.test(flat), '没说明用的是哪条抓取路线（决定这张图可不可信）');
  // ⑥ 可疑时要用醒目样式
  const suspect = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: {
      dir: 'C:\\x', count: 1, totalText: '2.4 MB', files: [],
      lastCapture: { ok: true, file: 'a.png', process: 'YuanShen', pid: 1, title: '原神', width: 1, height: 1,
        mode: 'screen', blackRatio: 0.02, suspect: true, warning: 'grab may show another program' },
    },
  }));
  assert(/dsh-miliastra-err/.test(suspect), 'suspect=true 时没用醒目样式');

  // ⑦ 缩略图预览（作者要求「图片最好有缩略图预览」）——
  //    关键不只是「有 <img>」，而是**图走的是 Host 的小图路由**，不是把 2.4 MB 的原图塞进页面
  const imgs = html.match(/<img[^>]*>/g) || [];
  const shotImgs = imgs.filter((t) => /\/miliastra\/shot\?name=/.test(t));
  assert(shotImgs.length >= 2, '截图卡片里的缩略图不够（应至少有 1 张放大 + 1 张网格），实际 ' + shotImgs.length);
  // 页面上的每一张图要么是内联的入口图标（data:），要么走 Host 小图路由 —— 不许有别的来源
  assert(imgs.every((t) => /\/miliastra\/shot\?name=/.test(t) || /src="data:image\//.test(t)),
    '有图片不是走 Host 的 /miliastra/shot 路由：' + imgs.filter((t) => !/\/miliastra\/shot\?name=/.test(t) && !/src="data:image\//.test(t)).join(' | '));
  assert(shotImgs.some((t) => /thumb=1/.test(t)), '缩略图没有请求缩小版（会直接拉 2.4 MB 的原图）');
  assert(/loading="lazy"/.test(html), '缩略图没有 lazy 加载（一次十几张会拖慢面板）');
  // 点开要看原图：外链必须存在，且指向不带 thumb=1 的那个 URL
  assert(/href="\/miliastra\/shot\?name=[^"]*"/.test(html), '缩略图不能点开看原图');
  return '存放目录 + 张数体积 + 不会自动删 + 三按钮 + 窗口身份 + 缩略图走小图路由；可疑时醒目';
});

check('★ 清理要两步：先看将删哪些，确认按钮才出现', () => {
  // 没规划时不该有「确认删除」
  const idle = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: { dir: 'C:\\x', count: 1, totalText: '2.4 MB', files: [] },
  }));
  assert(!/确认删除/.test(idle), '还没规划就给了「确认删除」按钮 —— 会一按就删');

  // 规划出来后：要显示会删哪些 + 确认按钮 + 取消
  const planned = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: { dir: 'C:\\x', count: 3, totalText: '7.2 MB', files: [] },
    __cleanPlan: {
      ok: true, dryRun: true, note: '将删除 2 张（4.8 MB），保留 1 张',
      planned: [{ name: 'old-1.png', sizeText: '2.4 MB' }, { name: 'old-2.png', sizeText: '2.4 MB' }],
      keepCount: 1, bytes: 5000000,
    },
  }));
  const flat = planned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/将删除 2 张/.test(flat), '没显示将删几张');
  assert(/old-1\.png/.test(flat), '没列出将删哪些文件');
  assert(/确认删除 2 张<\/button>/.test(planned), '缺「确认删除」按钮');
  assert(/取消<\/button>/.test(planned), '缺「取消」按钮');
  return '未规划不给确认按钮；规划后列出清单 + 确认 + 取消';
});

check('★ 开跑自动截图的判据：只在「新开跑」触发、同一局不连拍（纯函数）', () => {
  const step = clientExports.__testPtStep;
  assert(typeof step === 'function', '缺少 __testPtStep（开跑触发无法回归）');
  const run = (n) => ({ ok: true, inPlaytest: true, startedAtMs: 1000 + n, elapsedSec: 5 });

  // ① 第一次调用只建基线 —— 面板一开就发现「上一局在跑」，那不是新开跑，不该补截
  const a = step(null, run(0), { autoShot: true, delaySec: 3 });
  assert(a.action === 'none' && a.next.seeded === true, '首次调用不该触发：' + JSON.stringify(a));

  // ② 真正的新一局 + 开关打开 → 触发，且要说清「等几秒」
  const b = step(a.next, run(1), { autoShot: true, delaySec: 3 });
  assert(b.action === 'shot', '新开跑没触发：' + JSON.stringify(b));
  assert(/3 秒/.test(b.reason), '没说清等几秒：' + b.reason);

  // ③ 同一局的复查不许再触发（2 秒轮一次，不然会连拍十几张）
  const c = step(b.next, run(1), { autoShot: true, delaySec: 3 });
  assert(c.action === 'none', '同一局重复触发（会连拍）：' + JSON.stringify(c));

  // ④ 开关关着 → 只报告、不触发
  const d = step(a.next, run(2), { autoShot: false, delaySec: 3 });
  assert(d.action === 'none' && d.phase === 'started', '关着开关还触发：' + JSON.stringify(d));

  // ⑤ 跑完之后 startedAtMs 变 null —— 绝不能把「结束」误判成「开跑」
  const e = step(b.next, { ok: true, inPlaytest: false, startedAtMs: null }, { autoShot: true, delaySec: 3 });
  assert(e.action === 'none', '把「跑完」当成新开跑了：' + JSON.stringify(e));

  // ⑥ 读不到日志 → unknown，静默不触发
  const f2 = step(a.next, { ok: false, error: 'x' }, { autoShot: true, delaySec: 3 });
  assert(f2.action === 'none' && f2.phase === 'unknown', '读不到日志还触发：' + JSON.stringify(f2));

  return '首次建基线 / 新局触发一次 / 同局不连拍 / 关了不触发 / 跑完不误触发 / 读不到不触发';
});

check('★ 试玩卡片：状态 + 来源 + 实测延迟 + 「别用 .gia 判」都要看得见', () => {
  const live = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __pt: {
      ok: true, inPlaytest: true, startedAt: '21:46:02.420', startedAtMs: 1790171162420,
      elapsedSec: 12, epochSec: 1790171162, endedAt: null,
      logPath: 'C:\\Users\\x\\AppData\\LocalLow\\miHoYo\\原神\\output_log.txt',
      lastRun: { startedAt: '21:29:37.378', endedAt: '21:31:33.372', durationSec: 116, epochSec: 1790170177, token: 1037286, closed: 'seen' },
      recentRuns: [
        { startedAt: '21:29:37.378', endedAt: '21:31:33.372', durationSec: 116, epochSec: 1790170177, closed: 'seen' },
        { startedAt: '21:46:02.420', endedAt: null, durationSec: null, epochSec: 1790171162 },
      ],
    },
  }));
  const flat = live.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  assert(/试玩开跑/.test(flat), '没有「试玩开跑」这张卡');
  assert(/试玩中/.test(flat) && /12 秒/.test(flat), '没显示「在试玩 + 已跑多久」');
  assert(/21:46:02/.test(flat), '没显示开跑时刻');
  assert(/1790171162/.test(flat), '没显示「本局编号」（与 .gia 对号用）');
  assert(/output_log\.txt/.test(flat), '没说信号来自哪个文件');
  assert(/0\.07~0\.18 秒/.test(flat), '没写实测延迟 —— 用户没法判断它灵不灵');
  assert(/不能用 \.gia 判开跑/.test(flat), '没警告「别用 .gia 判开跑」');
  assert(/21:29:37/.test(flat) && /1 分 56 秒/.test(flat), '最近几局没显示（开跑时刻 + 时长）');
  // 自动截图必须默认关：磁盘是用户的，没人点过就不该自己往里写图片
  assert(/开跑自动截图：关/.test(live), '自动截图默认不是「关」');
  assert(/3 秒<\/button>/.test(live), '缺「开跑后几秒」的秒数选择');

  // 不在试玩时也得有话说（不能空着让人猜）
  const idle = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
    __pt: { ok: true, inPlaytest: false, startedAtMs: null, logPath: 'C:\\x\\output_log.txt', lastRun: null, recentRuns: [] },
  }));
  assert(/未在试玩/.test(idle.replace(/<[^>]+>/g, ' ')), '没在试玩时没给状态文案');
  return '状态 + 开跑时刻 + 本局编号 + 来源 + 实测延迟 + 别用 .gia 判 + 最近几局 + 默认关';
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

// ---------- ⑤ 0.1.0：会话区三个 tab（初级功能 / 高级功能 / 模拟器）----------

check('三个 tab 的注册计划是纯数据（id / 文案 / 顺序写坏 = tab 静默消失）', () => {
  const tabs = clientExports.__testViewTabs;
  assert(Array.isArray(tabs) && tabs.length === 3, 'tab 计划不是 3 项');
  const labels = tabs.map((t) => t.label).join('/');
  assert(labels === '初级功能/高级功能/模拟器', 'tab 文案不对：' + labels);
  const ids = tabs.map((t) => t.id);
  assert(new Set(ids).size === 3, 'tab id 有重复');
  assert(ids.every((id) => id.indexOf('dsh-miliastra-') === 0), 'tab id 前缀不对：' + ids.join(','));
  assert(tabs.map((t) => t.order).join(',') === '30,31,32', 'tab 顺序不对');
  return labels + '  ids=' + ids.join(',');
});

check('「初级功能」视图：SSR 真渲染，只出 ① 关卡 + ② 代码', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'basic' }));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('① 关卡'), '缺 ① 关卡');
  assert(text.includes('② 代码'), '缺 ② 代码');
  assert(!text.includes('③ 日志与画面'), 'basic 视图不该出 ③ 日志与画面');
  assert(html.includes('dsh-miliastra-inline'), '没有 inline 样式类 —— 视图模式没生效（会仍按浮层渲染）');
  return '两栏，无 ③';
});

check('「高级功能」视图：只出 ③ 日志与画面（含高级诊断），不重复 ①②', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'advanced' }));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('③ 日志与画面'), '缺 ③ 日志与画面');
  assert(!text.includes('① 关卡'), 'advanced 视图不该出 ① 关卡');
  assert(!text.includes('② 代码'), 'advanced 视图不该出 ② 代码');
  return '一栏（③ + 高级诊断）';
});

check('inline 视图里没有关闭按钮（视图不该有"关掉自己"这回事）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'basic' }));
  assert(!/dsh-miliastra-x/.test(html), 'inline 视图里出现了关闭按钮');
  return '无 ×';
});

check('「模拟器」视图能真渲染（不是占位）：传输/导出/重置动作 + 诚实空态', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorView, {}));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('模拟器'), '缺标题');
  for (const label of ['刷新', '开始试玩', '单步', '停止', '导出 GIA', '重置工程']) {
    assert(text.includes(label), '缺按钮：' + label);
  }
  // 取图入口已按作者要求删除（画面去右列那个试玩页看）→ 空态落在**日志**上，不再是「还没有画面」
  assert(text.includes('还没有日志'), '没给「还没有日志」的诚实提示（空着让人猜）');
  assert(html.includes('dsh-miliastra-inline'), '模拟器视图没走全宽 inline 布局');
  return '6 个动作 + 日志空态 + 全宽布局';
});

check('浮层面板 = 三个独立页面（初级功能 / 高级功能 / 模拟器），**没有「全部」**', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'basic',
    open: true, setOpen: () => {}, rootRef: { current: null },
  }));
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const label of ['初级功能', '高级功能', '模拟器']) {
    assert(text.includes(label), '缺视图切换按钮：' + label);
  }
  assert(!/全部<\/button>/.test(html), '还留着「全部」混合页按钮（作者要求去掉）');
  assert(/dsh-miliastra-vtab/.test(html), '切换按钮没有样式类（会渲染成裸按钮）');
  assert(/dsh-miliastra-vtab-on/.test(html), '没有标出当前选中的那一档');
  assert(/dsh-miliastra-viewtabs/.test(html), '缺 tab 条容器（平铺成三等分）');
  const inline = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'basic' }));
  assert(!/dsh-miliastra-vtab/.test(inline), 'inline 视图不该再带一条内部切换条（那边由会话区 tab 决定）');
  return '三个页面按钮 + 选中态 + 无「全部」+ inline 不重复';
});

check('每个页面只出自己那几栏、内容**平铺铺满**（-bodyfill），互不干扰', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const basic = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'basic' })));
  const bTxt = basic.replace(/<[^>]+>/g, ' ');
  assert(bTxt.includes('① 关卡') && bTxt.includes('② 代码'), '初级页缺 ①②');
  assert(!bTxt.includes('③ 日志与画面'), '初级页混进了 ③');
  assert(/dsh-miliastra-bodyfill/.test(basic), '初级页没平铺（会留一个空洞的第三栏）');

  const adv = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'advanced' })));
  const aTxt = adv.replace(/<[^>]+>/g, ' ');
  assert(aTxt.includes('③ 日志与画面'), '高级页缺 ③');
  assert(!aTxt.includes('① 关卡') && !aTxt.includes('② 代码'), '高级页混进了 ①②');
  assert(/dsh-miliastra-bodyfill/.test(adv), '高级页没平铺');
  return '初级=①② / 高级=③，各自平铺';
});

check('平铺规则必须**写在 -body 之后**且用复合选择器（否则被 repeat(3,…) 盖掉 —— 作者实测踩过）', () => {
  const css = styleNodes[0].textContent;
  const iBody = css.indexOf('dsh-miliastra-body{');
  const iFill = css.indexOf('dsh-miliastra-body.dsh-miliastra-bodyfill{');
  assert(iBody >= 0, '缺 -body 规则');
  assert(iFill >= 0, '缺 -body.bodyfill 复合规则');
  assert(iFill > iBody, '-bodyfill 写在 -body 之前 → 同优先级被 repeat(3,…) 盖掉（初级页第三列会空着）');
  assert(/dsh-miliastra-body\.dsh-miliastra-bodyfill\{[^}]*auto-fit/.test(css), '-bodyfill 没用 auto-fit 平铺');
  assert(/dsh-miliastra-viewtabs\{[^}]*display:grid/.test(css), '页面条不是三等分平铺');
  assert(!/dsh-miliastra-viewtabs\{[^}]*display:flex/.test(css), '还留着旧的 flex 版页面条规则（重复定义）');
  return 'body@' + iBody + ' < bodyfill@' + iFill + '，复合选择器优先级更高';
});

check('画布点击坐标换算（纯函数）：左下原点、y 翻转、退化输入不炸', () => {
  const f = clientExports.__testStagePoint;
  assert(typeof f === 'function', '缺 __testStagePoint（点画布的换算没有独立函数就无法回归）');
  // 图片区域 800×400、画布 1600×900：点图片正中 → 画布正中
  const c = f({ left: 100, bottom: 500, width: 800, height: 400 }, 1600, 900, 500, 300);
  assert(c.x === 800 && c.y === 450, '中心点算错：' + JSON.stringify(c));
  // 图片**左上角**（clientY 小 = 屏幕上方）→ 画布 y 应是最大值（左下原点，y 要翻转）
  const tl = f({ left: 100, bottom: 500, width: 800, height: 400 }, 1600, 900, 100, 100);
  assert(tl.x === 0 && tl.y === 900, '左上角算错（y 没翻转？）：' + JSON.stringify(tl));
  // 图片左下角 → 画布 (0,0)
  const bl = f({ left: 100, bottom: 500, width: 800, height: 400 }, 1600, 900, 100, 500);
  assert(bl.x === 0 && bl.y === 0, '左下角算错：' + JSON.stringify(bl));
  assert(JSON.stringify(f(null, 0, 0, 0, 0)) === '{"x":0,"y":0}', '退化输入没兜住（会点出 NaN 坐标）');
  return '中心 / 左上角(y 翻转) / 左下角 / 退化输入 都对';
});

/*
 * 2026-09-24 作者要求：「我希望固定这样 把切换的功能去掉吧」。
 * 设备/人数/视角三个下拉**全部去掉**，固定 PC 16:9 / 1 人 / P1 —— 理由：
 * ① 切设备会**重建整个运行时**（画布一变，16:9 舞台与 AI 记下的操作坐标都要重算）；
 * ② 试玩页原来那份**手写**的设备清单里有引擎不存在的预设（`pc-4-3` / `phone-16-9` / `phone-4-3`）
 *    → 选中就报 `unknown canvas preset`（作者截图里那条红条）。
 * 2026-09-25 作者又说：「画面和截取画面功能很鸡肋不要了 GUI 部分直接删除」→ **连帧**（它只服务于画面）也删了。
 * ⚠️ 能力没丢：AI 仍可用 `miliastra_sim op=play device|view`、`playerCount`、`op=shot` / `op=frames`。
 * 这条断言是**反向**的：谁要是把开关 / 取图入口加回来，先看这段注释。
 */
check('模拟器面板：按键与传输控制保留，**设备/人数/视角 + 连帧/截图按钮都已去掉**（固定 PC 16:9 单人）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('按键：') && text.includes('发送键'), '缺按键行（按键不是"切换"，要留）');
  for (const label of ['开始试玩', '单步', '停止']) {
    assert(text.includes(label), '缺传输控制（非取图功能，要留）：' + label);
  }
  assert(!text.includes('设备：') && !text.includes('人数：') && !text.includes('视角：'),
    '还留着设备/人数/视角下拉 —— 作者要求去掉（它们会重建运行时、打歪画布尺寸）');
  assert(/画布\/人数\/视角固定/.test(text), '去掉开关后没写清"现在是固定的什么"');
  return '按键 + 传输控制保留；设备·人数·视角已固定';
});

check('模拟器是**面板内的第三个页面**（不再只是提示去会话区）', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'sim' })));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('开始试玩') && text.includes('导出 GIA'), '模拟器页没渲染出动作按钮');
  assert(text.includes('还没有日志'), '模拟器页缺空态提示');
  assert(/dsh-miliastra-simbody/.test(html), '没有 simbody 容器（正文没与 conversation.view 复用同一个组件）');
  assert(!/dsh-miliastra-bodyfill/.test(html), '模拟器页不该再套卡片网格（它自己就是两栏）');
  return '面板内第三个页面可渲染';
});

/*
 * 2026-09-24 作者要求：「模拟器那个 tab 就是 1:2，其中 2 的部分就是放 /miliastra/play（AI 能操作、人也能看到）」。
 * 2026-09-25 作者又要求：「绝对路径的入口放做在左边最顶上」+「画面和截取画面功能很鸡肋不要了 GUI 部分直接删除」。
 * 这类"布局要求"最容易在后续改动里被无声改回去（面板不报错、只是又变回旧样子），所以钉成断言。
 */
check('★ 模拟器布局（作者要求）：tab 是 **1:2**，2 的部分是嵌入的**试玩页** `/miliastra/play`', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const text = html.replace(/<[^>]+>/g, ' ');
  const css = styleNodes[0].textContent.replace(/\s+/g, '');
  // ① 1:2 网格（左列有 300px 下限 —— 880px 的 1/3 只有 285px，塞不下这些按钮）+ 窄屏塌成一列
  assert(/dsh-miliastra-simgrid\{display:grid;grid-template-columns:minmax\(300px,1fr\)2fr/.test(css),
    '模拟器不是 1:2 网格：' + ((css.match(/dsh-miliastra-simgrid\{[^}]*\}/) || ['(缺 simgrid 规则)'])[0]));
  /*
   * 窄屏兜底：断点必须 **< 880px**（浮层面板正好 880px 宽）—— 原来写 1000px，于是浮层里永远命中：
   * 1:2 塌成一列 → 右列高度改由内容决定 → 舞台只剩 ~168px 高 → 画布被压成 263×148（作者实测 footer 数字）。
   */
  const bp = css.match(/@media\(max-width:(\d+)px\)\{\.dsh-miliastra-simgrid\{grid-template-columns:1fr;\}/);
  assert(bp && Number(bp[1]) < 880, '窄屏断点必须小于浮层宽度 880px，实际：' + (bp ? bp[1] + 'px' : '没找到'));
  assert(/@media\(max-width:760px\)\{\.dsh-miliastra-simgrid\{grid-template-columns:1fr;\}\.dsh-miliastra-playframe\{min-height:min\(420px,55vh\);\}\}/.test(css),
    '窄屏塌成一列时没给 iframe 像样的 min-height（会退化成一细条）');
  // ①b 左列子项**不许收缩**：否则内容一超就被压扁、互相重叠（作者截图里的"按钮/文字叠在一起"就是这个）
  assert(/dsh-miliastra-playside>\*\{flex:00auto;min-height:auto;\}/.test(css),
    '左列子项还允许收缩（内容一多就会重叠）');
  // ② 2 的那一半真的是 iframe，且就是试玩页
  assert(/<iframe/.test(html), '没有 iframe —— 试玩页没嵌进面板');
  assert(/dsh-miliastra-playframe/.test(html), 'iframe 没有样式类（会渲染成一条细缝）');
  assert(/src="\/miliastra\/play"/.test(html), 'iframe 的 src 不是 /miliastra/play');
  assert(/title="千星模拟器试玩页/.test(html), 'iframe 没有 title（无障碍与排障都要）');
  // ③ 顺序：左列（读本地 .lua / 日志 / 操作 / 时间线 / 验收单 / 工程）在 iframe 之前 ⇒ iframe 落在右边那 2 份里
  assert(html.indexOf('dsh-miliastra-playside') >= 0
    && html.indexOf('dsh-miliastra-playside') < html.indexOf('dsh-miliastra-playframe'),
  'iframe 没排在左列之后（会跑到 1 的那一半去）');
  // ④ 左列几块都在；**顺序 = "最常看的在最上面"**（作者实测「画面在左下角」就是被工程卡挤下去的）。
  //    2026-09-25 起第一位是作者点名的「读本地 .lua（绝对路径）」——它原来塞在 ④ 里、要先展开折叠卡才看得见。
  for (const label of ['读本地 .lua（绝对路径）', '① 试玩日志', '② 试玩操作', '操作时间线', '验收单',
    '④ 工程与控件树 / 工程适配', '工程适配']) {
    assert(text.includes(label), '左列缺：' + label);
  }
  const order = ['读本地 .lua（绝对路径）', '① 试玩日志', '② 试玩操作', '操作时间线', '验收单', '④ 工程与控件树'];
  const idx = order.map((s) => text.indexOf(s));
  assert(idx.every((n) => n >= 0) && idx.slice().sort((a, b) => a - b).join(',') === idx.join(','),
    '左列顺序不对（「读本地 .lua（绝对路径）」必须排第一）：' + idx.join(' / '));
  // 「最顶上」= 真的排在左列第 1 张卡（在左列容器里、且在日志卡之前）——作者原话「放做在左边最顶上」
  assert(html.indexOf('读本地 .lua（绝对路径）') > html.indexOf('dsh-miliastra-playside')
    && html.indexOf('读本地 .lua（绝对路径）') < html.indexOf('① 试玩日志'),
  '「读本地 .lua（绝对路径）」没排在左列最上面');
  // ⑤ 传输控制与验收单按钮都在（它们驱动的是**同一个**会话）
  for (const label of ['开始试玩', '单步', '停止', '读清单', '跑这一组', '扫描活文件', '搭进模拟器']) {
    assert(html.includes(label), '缺控件/按钮：' + label);
  }
  // ⑥ 滚动模型：**左列自己滚、右边不下沉**（否则左列一长，滚下去 iframe 出视野 —— 作者实测「右侧啥都没」）
  assert(/dsh-miliastra-simbody\{[^}]*overflow:hidden/.test(css),
    'simbody 不该是整页滚动容器（会把试玩页推出视野）');
  assert(/dsh-miliastra-playside\{[^}]*overflow-y:auto/.test(css), '左列没有自己的滚动条（画面/操作会被 iframe 顶下去）');
  assert(/dsh-miliastra-playframe\{[^}]*flex:11auto[^}]*min-height:240px/.test(css), 'iframe 没跟着右列高度自适应');
  // ⑦ 工程那块默认折叠（不然一长就把上面两块挤走）
  assert(/<details[^>]*dsh-miliastra-sec/.test(html), '「工程与控件树」没做成可折叠的 <details>');
  return '1:2 + iframe(/miliastra/play) + 左列顺序(读本地 .lua 最先) + 左列内滚 + 工程折叠 + 窄屏兜底';
});

/*
 * 2026-09-25 作者要求：「现在不能直接看 我希望编辑器面板增加一个输入 lua 的绝对路径读取的功能」；
 * 追问后他选的是「两个都要」：**先看**（元信息 + 正文预览 + 候选交接值），**再一键搭进模拟器**。
 * 同一天他又要求：「绝对路径的入口放做在左边最顶上」——它原来是 ④ 工程适配卡里的一块，
 * 现在是**左列第 1 张独立小卡**（下一张卡就是 ① 试玩日志）。
 *
 * 这条断言管四件事（都是"不报错但会骗人"的那种）：
 *   ① 输入框与两个按钮真的渲染出来了；
 *   ② 它**排在左列最上面**；
 *   ③ 请求体里的 `source` 是**粘贴的那个路径**（串成沙箱活文件路径就会「看起来读了、读的是另一个文件」）；
 *   ④ 新文案里不许有 Markdown 记号（面板不渲染 Markdown，`**` 会原样显示给人看）。
 */
check('★ 「读本地 .lua（绝对路径）」入口（左列最上面那张独立小卡）：输入框 + 读取 + 用它搭进模拟器，且 source 就是粘贴的路径', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

  // ① 输入框（用 aria-label / placeholder 这种稳定判据，不靠视觉）
  assert(/aria-label="本地 \.lua 的绝对路径"/.test(html), '没有「本地 .lua 的绝对路径」输入框');
  assert(html.includes('粘贴 .lua 的绝对路径'), '输入框的占位提示没说清要粘什么');
  assert(html.includes('绝对路径'), '占位提示没强调「绝对路径」');
  // ② 两个按钮
  assert(/>读取<\/button>/.test(html), '缺「读取」按钮');
  assert(/>用它搭进模拟器<\/button>/.test(html), '缺「用它搭进模拟器」按钮');
  // ③ 两条路的区别要写清（上面那条是沙箱活文件，这条是任意本地 .lua）
  assert(/任意本地 \.lua（绝对路径）/.test(flat), '没写清这条入口是什么');
  assert(/沙箱活文件/.test(flat), '没写清它与「沙箱活文件」那条的区别');
  assert(/只读/.test(flat), '没写清读取是只读的');

  // ④ 请求体：`source` 必须是**粘贴的那个路径**（纯函数单独回归）
  const P = 'C:/Users/me/Desktop/背景图片.lua';
  const reqs = clientExports.__testExternalLuaReadRequests(P);
  assert(Array.isArray(reqs) && reqs.length === 2, '「读取」应该发两个请求（read + handover）：' + JSON.stringify(reqs));
  assert(reqs[0].name === 'miliastra_code' && reqs[0].args.op === 'read', '第一个请求不是 miliastra_code op=read：' + JSON.stringify(reqs[0]));
  assert(reqs[0].args.source === P, 'read 的 source 不是粘贴的路径：' + JSON.stringify(reqs[0].args));
  assert(reqs[0].args.head === 60, '预览行数不是 60：' + reqs[0].args.head);
  assert(reqs[1].name === 'miliastra_sim' && reqs[1].args.op === 'handover', '第二个请求不是 miliastra_sim op=handover（交接值是 sim 的 op）：' + JSON.stringify(reqs[1]));
  assert(reqs[1].args.source === P, 'handover 的 source 不是粘贴的路径：' + JSON.stringify(reqs[1].args));
  // 反过来：绝不能把某个活文件路径写进这两个请求体（那正是"看起来读了"的病）
  assert(!/external_lua_file|\b双相\b|picked/i.test(JSON.stringify(reqs)), '请求体里混进了活文件路径：' + JSON.stringify(reqs));

  // ⑤ 「用它搭进模拟器」= 同一个 source 走 op=bind（templates / container 沿用勾选的那套）
  const tpl = [{ guid: 1073741868, kind: 'image', name: 'IMAGE_TEMPLATE' }];
  const bind = clientExports.__testExternalLuaBindArgs(P, tpl, '1073741863');
  assert(bind.op === 'bind' && bind.source === P, 'bind 请求体的 op/source 不对：' + JSON.stringify(bind));
  assert(bind.templates === tpl, 'bind 没带上勾选的模板');
  assert(bind.containerId === 1073741863, 'bind 没带上容器索引：' + JSON.stringify(bind));
  const noBox = clientExports.__testExternalLuaBindArgs(P, [], '');
  assert(!('containerId' in noBox), '容器索引为空时不该塞一个 containerId 进去：' + JSON.stringify(noBox));

  // ⑥ 结构化补强：按钮真的用「粘贴的路径」去调这两个构造函数（不是写死的活文件路径）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  assert(/externalLuaReadRequests\(p\)/.test(src), '「读取」按钮没把粘贴的路径交给请求构造函数');
  assert(/externalLuaBindArgs\(p, templates, bindContainer\)/.test(src), '「用它搭进模拟器」没把粘贴的路径交给 bind');
  assert(/var p = extPath\.trim\(\)/.test(src), '按钮没有从输入框取值（extPath）');

  // ⑦ 新文案里不许有 Markdown 记号（只查**这一块**，避免碰到别处的历史文案）。
  //    2026-09-25 起这块提成了左列最上面的独立卡，所以切片的**右边界改成下一张卡的标题**
  //    （原来靠卡片内部那句"或者，从这台机器上的沙箱活文件里挑一份"分界，现在那句搬去了 ④）
  const a = flat.indexOf('读本地 .lua（绝对路径）');
  const b = flat.indexOf('① 试玩日志');
  assert(a >= 0 && b > a, '「绝对路径」那一块没渲染出来（或它没排在 ① 试玩日志 之前）');
  const block = flat.slice(a, b);
  const stars = block.match(/\*\*[^*]{1,40}\*\*/g);
  assert(!stars, '新入口文案里有 Markdown 记号（会原样显示）：' + (stars || []).join(' | '));
  const ticks = block.match(/`[^`\n]{1,40}`/g) || [];
  assert(ticks.length === 0, '新入口文案里有反引号（会原样显示）：' + ticks.join(' | '));

  // ⑧ 位置（作者原话「放做在左边最顶上」）：它必须排在 ① 试玩日志 之前，旧卡片名也不许回来
  assert(flat.indexOf('读本地 .lua（绝对路径）') >= 0
    && flat.indexOf('读本地 .lua（绝对路径）') < flat.indexOf('① 试玩日志'),
  '「读本地 .lua（绝对路径）」没排在左列最上面');
  assert(!/① 画面与日志/.test(flat) && !/② 试玩操作（高级/.test(flat), '旧的卡片名/结构又回来了');

  return '输入框 + 读取 + 用它搭进模拟器（排在左列最上面）；两个请求体的 source 都是粘贴的路径；新文案无 Markdown 记号';
});

/*
 * ★ 反向绊线（2026-09-25 作者要求）：「画面和截取画面功能很鸡肋不要了 GUI 部分直接删除」。
 * 模拟器面板里**不许再出现**这些取图入口的文案 —— 谁把它们爬回来，先看这段。
 * ⚠️ 删的只是**面板 GUI**：AI 侧一个字没动（miliastra_shot 的 capture/burst/list/clean/targets、
 *    miliastra_sim 的 op=shot / op=frames 全部保留）。
 * ⚠️ 侧边栏那张「游戏截图」卡（存放目录 / 张数 / 不会自动删 / 清理）**故意保留** ——
 *    它是"磁盘是用户的、清理要人显式点"这条纪律的人侧入口，与模拟器面板的画面是两回事。
 */
check('★ 反向绊线：模拟器面板里**不再有**取图/连帧入口（编辑器画面 / 刷新画面 / 连帧 / 还没有画面）', () => {
  const sim = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const simText = sim.replace(/<[^>]+>/g, ' ');
  for (const nope of ['编辑器画面', '刷新画面', '连帧', '还没有画面', '截取游戏画面']) {
    assert(!simText.includes(nope), '模拟器面板里又出现了取图入口：' + nope);
  }
  // 浮层面板全量文案里也不许有（模拟器页 + 高级诊断展开态各渲染一遍）
  for (const props of [
    { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'sim' },
    openAdv(),
  ]) {
    const t = renderToStaticMarkup(React.createElement(clientExports.__testPanel, props)).replace(/<[^>]+>/g, ' ');
    for (const nope of ['编辑器画面', '刷新画面', '连帧']) {
      assert(!t.includes(nope), '面板里又出现了取图入口：' + nope);
    }
  }
  // 但必须写清「画面去哪里看」（不能让人以为功能没了）——左列 ② 那句指向右列试玩页
  assert(/画面[^）]{0,30}试玩页/.test(simText), '没告诉人"画面去右边那个试玩页看"');
  assert(/新窗口/.test(simText), '没说「新窗口 ↗」可以放大看');
  return '编辑器画面 / 刷新画面 / 连帧 / 还没有画面 都不在面板里；且写清了画面去右列试玩页看';
});

check('操作时间线的一行：说清"什么时候、做了什么"（AI 照着就能写成 steps[]）', () => {
  const f = clientExports.__testHistLine;
  assert(typeof f === 'function', '缺少 __testHistLine（时间线格式化无法单独回归）');
  assert(f({ t: 0.5, kind: 'pointer', payload: { type: 'click', x: 800, y: 450 } }) === 't=0.50  pointer click (800,450)',
    'pointer 行不对：' + f({ t: 0.5, kind: 'pointer', payload: { type: 'click', x: 800, y: 450 } }));
  assert(f({ t: 1.25, kind: 'key', payload: { typeName: 'KeyboardCraftspersonKey3Down' } }) === 't=1.25  key KeyboardCraftspersonKey3Down',
    'key 行不对');
  assert(f({ t: 2, kind: 'serverSend', payload: { name: 'GO', params: [1, 2] } }) === 't=2.00  signal GO(1,2)', 'signal 行不对');
  assert(/^t=0\.00 /.test(f(undefined)), '空事件不该炸（时间线要能容忍半截数据）');
  return 'pointer / key / signal / 空输入 都对';
});

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
