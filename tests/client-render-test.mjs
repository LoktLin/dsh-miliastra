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
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
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
      // 体检结论是**从 Host 拿来的**文本，里面有给 AI 看的 Markdown —— 面板必须剥掉再显示
      __logDiag: {
        verdict: 'stale',
        headline: '⚠️ 最近一局是 **113 分钟前**写的（18:44:57）—— **你刚才那局没有写出日志**。',
        why: ['① **试玩可能还在进行中** —— `.gia` 不是边玩边写', '④ 「日志」面板里 **`客户端脚本` 没勾选**'],
        next: ['① 确认试玩是**进行中**的状态', '② 结束试玩后**再点一次取日志**'],
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
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
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
  const confirmHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
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
  const noFixed = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
    __backups: { ok: true, count: 1, backupDir: 'C:\\x\\_backup', fixedBackup: 'C:\\x\\_backup\\双相.bak',
      fixedExists: false, entries: [{ name: '双相.20260923-180000_备份.lua', path: 'C:\\x\\_backup\\双相.20260923-180000_备份.lua', size: 10, fixed: false }] },
  }));
  assert(!/还原到最新备份<\/button>/.test(noFixed), '没有固定名备份却给了一键还原按钮');
  assert(/Host 可能是旧版/.test(noFixed.replace(/<[^>]+>/g, ' ')), '没解释为什么没有固定名备份');
  return '位置 + 固定名 + 一键还原 + ★标记 + 确认后果；缺固定名时给解释';
});

check('★ 试玩体检：最近一局不新鲜时，把「原因 + 下一步」摆在日志卡片最上面', () => {
  const stale = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
    __logDiag: {
      verdict: 'stale',
      headline: '⚠️ 最近一局是 113 分钟前写的（18:44:57）—— 你刚才那局没有写出日志。',
      why: ['① 试玩可能还在进行中 —— .gia 不是边玩边写', '② 或者其实没点「试玩」'],
      next: ['① 在编辑器里确认试玩是进行中的状态', '② 结束试玩后再点一次取日志'],
    },
  }));
  const flat = stale.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 结论要在，而且要说清「没有写出日志」（不能只端上旧日志让人自己发现）
  assert(/没有写出日志/.test(flat), '没说清「刚才那局没写出日志」');
  assert(/可能原因/.test(flat), '没列可能原因');
  assert(/下一步/.test(flat), '没给下一步');
  assert(/不是边玩边写/.test(flat), '没解释 .gia 的落盘时机（这是用户最容易误解的点）');
  // ② 要用醒目样式（-err），不能混在普通提示里
  assert(/dsh-miliastra-err/.test(stale), '没用醒目样式（-err）');
  // ③ 要有个「试玩体检」按钮随时能再问一次
  assert(/试玩体检<\/button>/.test(stale), '缺「试玩体检」按钮');

  // 反过来：fresh 时不该刷一个红框出来（只留一句淡色说明）
  const fresh = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
    __logDiag: { verdict: 'fresh', headline: '最近一局是 30 秒前写的 —— 这应该就是你刚才那局。', why: [], next: ['直接「取日志」即可'] },
  }));
  const freshFlat = fresh.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/30 秒前/.test(freshFlat), 'fresh 的说明没显示');
  assert(!/可能原因/.test(freshFlat), 'fresh 时不该列「可能原因」');
  return 'stale：醒目框 + 原因 + 下一步 + 按钮；fresh：只一句说明';
});

check('★ 截图卡片：存到哪 / 多少张 / 不会自动删，三件事都必须在卡片上', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
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
  const suspect = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: {
      dir: 'C:\\x', count: 1, totalText: '2.4 MB', files: [],
      lastCapture: { ok: true, file: 'a.png', process: 'YuanShen', pid: 1, title: '原神', width: 1, height: 1,
        mode: 'screen', blackRatio: 0.02, suspect: true, warning: 'grab may show another program' },
    },
  }));
  assert(/dsh-miliastra-err/.test(suspect), 'suspect=true 时没用醒目样式');
  return '存放目录 + 张数体积 + 不会自动删 + 三按钮 + 窗口身份；可疑时醒目';
});

check('★ 清理要两步：先看将删哪些，确认按钮才出现', () => {
  // 没规划时不该有「确认删除」
  const idle = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null },
    __shot: { dir: 'C:\\x', count: 1, totalText: '2.4 MB', files: [] },
  }));
  assert(!/确认删除/.test(idle), '还没规划就给了「确认删除」按钮 —— 会一按就删');

  // 规划出来后：要显示会删哪些 + 确认按钮 + 取消
  const planned = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
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
