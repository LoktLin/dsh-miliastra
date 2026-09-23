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

// 空状态把**整个面板**渲染一遍：三栏骨架 + 每张卡片都必须在场。
// 这条能抓到「卡片被写坏 / 少一个孩子 / 引用了不存在的变量」这类一渲染就炸的错
// （历史上踩过一次：编辑时打断了 mapKids 的定义，靠这层才发现）。
check('空状态下整面板渲染：三栏骨架 + 全部卡片都在（不炸）', () => {
  const PanelComp = clientExports.__testPanel;
  assert(typeof PanelComp === 'function', '没暴露 __testPanel，无法做整面板渲染测试');
  let html;
  try {
    html = renderToStaticMarkup(React.createElement(PanelComp, {
      open: true, setOpen: () => {}, rootRef: { current: null },
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

// 探针现在收在「高级诊断」折叠区里（默认收起），所以下面这些断言都要显式展开它。
const openAdv = (extra) => Object.assign({
  open: true, setOpen: () => {}, rootRef: { current: null }, __advOpen: true,
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

check('★ 探针默认**收起**：不展开就看不到它（它主要给 AI 用，不该占创作者视线）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
  }));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/高级诊断/.test(flat), '找不到「高级诊断」折叠标题');
  assert(/AI 专用/.test(flat) && /你最好别碰/.test(flat), '没在标题上写明「AI 专用 / 你最好别碰」');
  assert(/平时不用展开/.test(flat), '收起态没说明「平时不用展开」');
  // 收起时：探针的按钮/正文都不该在 DOM 里（不是 width:0 藏起来，是真不渲染）
  for (const nope of ['部署探针', '收回结论', '翻字典', '试钥匙']) {
    assert(!flat.includes(nope), '收起态却渲染了探针内容：' + nope);
  }
  // 展开后必须真的出现
  const open = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const openFlat = open.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/部署探针/.test(openFlat) && /翻字典/.test(openFlat), '展开后探针内容没出来');
  return '收起：只有标题 + AI 专用标签；展开：内容才进 DOM';
});

check('★ 探针卡片讲「人话」：说清是什么/代价/四步流程，且四个模板都列出来', () => {
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

  // ③ 模板按钮用大白话名，且四个模板都在（含 api-surface —— 面板曾漏掉它）
  for (const t of ['ping', 'tree', 'instantiate', 'api-surface']) {
    assert(flat.includes(t), '模板按钮缺 ' + t);
  }
  for (const label of ['探活', '看控件', '试钥匙', '翻字典']) {
    assert(flat.includes(label), '缺大白话标签：' + label);
  }
  return '是什么 / 代价 / 四步流程 / 4 个模板 + 大白话名 都在';
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
  // 模拟「运行中的 Host 还是旧版」：只返回 3 个模板（磁盘上已有 4 个）
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __probeInfo: { templates: ['ping', 'tree', 'instantiate'], info: [], overview: {} },
  })));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/Host 是旧版/.test(flat), '没提示「运行中的 Host 是旧版」');
  assert(/api-surface/.test(flat), '没点名少了哪个模板');
  assert(/重启 dsh web/.test(flat), '提示里没给下一步动作（重启 dsh web）');
  // 反过来：Host 清单齐全时不该有这条噪音
  const ok = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv({
    __probeInfo: { templates: ['ping', 'tree', 'instantiate', 'api-surface'], info: [], overview: {} },
  })));
  assert(!/Host 是旧版/.test(ok.replace(/<[^>]+>/g, ' ')), 'Host 清单齐全时不该提示旧版');
  return '缺模板时提示 + 点名缺失项 + 给出动作；齐全时不提示';
});

check('★ 界面文案里没有 Markdown 记号（面板不渲染 Markdown，`**` 会原样显示给人看）', () => {
  // 展开态一起查：折叠区里的文案同样是给人看的
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
  const stars = text.match(/\*\*[^*]{1,40}\*\*/g);
  assert(!stars, '界面文案里有 Markdown 粗体记号（会原样显示）：' + (stars || []).slice(0, 4).join(' | '));
  const ticks = (text.match(/`[^`\n]{1,40}`/g) || []).filter((s) => !/`\+/.test(s));
  assert(!ticks.length, '界面文案里有反引号（会原样显示）：' + ticks.slice(0, 4).join(' | '));
  return '无 ** / 反引号 残留';
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
