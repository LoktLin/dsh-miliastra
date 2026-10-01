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
// 第七页第 2 步的「真数据」那一条要读真的 `.gil`（只读；环境里没有就如实跳过，见那条 check）
import { scanLevels, pickCurrent } from '../lib/locate.mjs';
import { readGilNodeFacts } from '../lib/gilnodes.mjs';

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
      // 2026-09-26 起 apply **只注入一个槽位**：sidebar.footer.action（左下角入口）。
      // 曾经的 conversation.view（会话区顶部三个 tab）已按作者要求撤掉 —— 见下面的反向断言。
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

  /*
   * ★ 2026-09-26（作者要求）：**不许**再注册会话区顶部 tab —— 插件的 GUI 只有一处入口：
   *   侧边栏左下角「千星奇域」→ 浮层面板（面板内部自带三页切换）。
   * 这里是**反向绊线**：谁把 `conversation.view` 加回来，这条就红。
   */
  assert(!injectedSlots.includes('conversation.view'), '又不许注册会话区顶部 tab 了（作者要求撤掉）');
  const views = registeredBySlot['conversation.view'] || [];
  assert(views.length === 0, '不该有 conversation.view 注册，实际 ' + views.length + ' 个');
  assert(clientExports.__testViewTabs === undefined, '__testViewTabs 还在 —— VIEW_TABS 应已随注册一起删掉');
  assert(Object.keys(registeredBySlot).length === 1, '只该注册 sidebar.footer.action 一个槽位，实际：' + Object.keys(registeredBySlot).join(','));
  return registeredSpec.name + '#' + registeredSpec.id + '（唯一槽位；顶部 tab 已撤）';
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
  for (const head of ['① 当前关卡', '② 存盘与进程', '③ 日志']) {
    assert(html.includes(head), '缺栏目：' + head);
  }
  for (const card of ['当前关卡', '整体存盘状态', '地图体检', '代码操作', '运行时日志', '试玩探针', '刷新']) {
    assert(html.includes(card), '缺卡片/按钮：' + card);
  }
  // ★ 2026-10-01 作者要求删掉的两块：关卡选择器（自动跟随 + 全部关卡列表）与「关卡与文件」8 行元信息
  assert(!html.includes('自动跟随'), '关卡选择器还在（作者：「关卡 做个块可以删除了」）');
  assert(!html.includes('关卡与文件'), '「关卡与文件」那张 8 行元信息卡还在（应该只剩一行当前关卡）');
  assert(html.includes('dsh-miliastra-col'), '三栏容器没渲染');
  return `${html.length} 字符，三栏 + ${7} 张卡片齐备，删掉的两块确实不在`;
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


// 试玩探针现在收在「高级诊断」折叠区里（默认收起），所以下面这些断言都要显式展开它。
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
  // ⚠️ 反例：`err=nil` 是**正常**输出（试玩探针常打），不能一见 nil 就标红
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

check('★ 高级诊断默认**收起**（只读的 UI 读取 + 会覆盖脚本的试玩探针都关在里面）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all',
    open: true, setOpen: () => {}, rootRef: { current: null },
  }));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/高级诊断/.test(flat), '找不到「高级诊断」折叠标题');
  assert(/平时不用展开/.test(flat), '收起态没说明「平时不用展开」');
  assert(/读界面控件/.test(flat), '折叠标题里没提「读界面控件」');
  // 收起时：两块内容都不该在 DOM 里（不是 width:0 藏起来，是真不渲染）
  for (const nope of ['部署试玩探针', '收回结论', '翻字典', '试钥匙', '全部 37 条记录']) {
    assert(!flat.includes(nope), '收起态却渲染了内部内容：' + nope);
  }
  // 展开后两块都要出现，而且要分别标出风险（UI 读取 = 只读；试玩探针 = 会覆盖）
  const open = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const openFlat = open.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/部署试玩探针/.test(openFlat) && /翻字典/.test(openFlat), '展开后试玩探针内容没出来');
  assert(/① 读界面控件（只读/.test(openFlat), '没标出 UI 读取是只读的');
  assert(/② 试玩探针（⚠️ 会临时覆盖你的脚本/.test(openFlat), '没标出试玩探针会覆盖脚本');
  return '收起：只有标题；展开：① 只读 UI 读取 + ② 会覆盖脚本的试玩探针，各自标了风险';
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

check('★ 试玩探针卡片讲「人话」：说清是什么/代价/四步流程，且模板清单一个不漏', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, openAdv()));
  const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 得先回答「试玩探针是什么」「要付什么代价」—— 作者的原话是「没看懂试玩探针作用」
  assert(/试玩探针是干嘛的/.test(flat), '没有「试玩探针是干嘛的」这一句');
  assert(/临时替掉你脚本/.test(flat), '没有用大白话解释试玩探针是什么');
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
  assert(/试玩探针已部署/.test(flat), '已部署状态没给出提示');
  assert(/重新试玩一局/.test(flat), '已部署状态没提醒「重新试玩」');
  // 认按钮元素本身，别认字面 —— 收起态的提示语里也含「还原我的脚本」这几个字
  assert(/④ 还原我的脚本<\/button>/.test(html), '缺「④ 还原我的脚本」按钮 —— 用户会忘记把试玩探针换回去');
  // 只有「已部署」才出现，别一上来就摆一个会误点的按钮
  const clean = renderToStaticMarkup(React.createElement(PanelComp, openAdv()));
  assert(!/④ 还原我的脚本<\/button>/.test(clean), '未部署时不该出现「还原我的脚本」按钮');
  return '已部署：提示 + 重新试玩提醒 + 还原按钮；未部署：按钮不出现';
});

check('★ Host 清单比磁盘少时，试玩探针卡片提示「Host 是旧版 + 重启 dsh web」', () => {
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

check('★「整体存盘状态」（`saveVerdict`）：一句话结论 + 点名 + 比不出来就不许说已存盘', () => {
  const V = clientExports.__testSaveVerdict;
  assert(typeof V === 'function', '缺 __testSaveVerdict');
  const row = (file, live, emb, mounted) => Object.assign({ file, liveSha: live, embeddedSha: emb }, mounted === undefined ? { mounted: true } : { mounted });
  // ① 全部一致 ⇒ 已存盘（拿真实回执的形状：liveSha === embeddedSha）
  const ok = V({ ok: true, gilPath: 'C:\\x\\1073741841.gil', level: { levelId: '1073741841' }, rows: [
    row('柱子_红.lua', 'AAA', 'AAA'), row('色彩调度.lua', 'BBB', 'BBB'),
  ] });
  assert(ok.state === 'saved' && ok.saved === 2 && /已存盘：2 \/ 2 个脚本与地图里嵌的一致/.test(ok.title), '全一致时没说"已存盘"：' + JSON.stringify(ok));
  assert(ok.gil === '1073741841.gil' && ok.levelId === '1073741841', '没带出 .gil / 关卡号');
  assert(/可以直接（停掉再）试玩/.test(ok.hint), '已存盘时没给"可以试玩"的下一步：' + ok.hint);
  // ② 有一个不一样 ⇒ 没存盘，并**点名**（不是只报个数）
  const dirty = V({ ok: true, rows: [row('a.lua', 'AAA', 'AAA'), row('b.lua', 'NEW', 'OLD'), row('c.lua', 'C2', 'C2')] });
  assert(dirty.state === 'dirty' && dirty.dirty.length === 1 && dirty.dirty[0] === 'b.lua', '没点名没存盘的那个：' + JSON.stringify(dirty));
  assert(/有 1 \/ 3 个脚本没存盘/.test(dirty.title), '结论计数不对：' + dirty.title);
  assert(/去编辑器里存一次盘/.test(dirty.hint), '没说下一步：' + dirty.hint);
  // ③ 没挂进地图的**不算**"没存盘"（否则结论会说大），只单列
  const unm = V({ ok: true, rows: [row('a.lua', 'AAA', 'AAA'), row('孤儿.lua', 'ZZZ', null, false)] });
  assert(unm.state === 'saved' && unm.saved === 1 && unm.notMounted.length === 1, '没挂进地图的被算进结论了：' + JSON.stringify(unm));
  assert(/没挂进地图/.test(unm.hint) && /孤儿\.lua/.test(unm.hint), '没点名"没挂进地图"的那些：' + unm.hint);
  // ④ 比不出来（缺 sha）⇒ 降级成"说不清"，**不许**说已存盘
  const unk = V({ ok: true, rows: [row('x.lua', 'AAA', 'AAA'), { file: 'y.lua', mounted: true }] });
  assert(unk.state === 'unknown' && /说不清/.test(unk.title) && unk.unknown[0] === 'y.lua', '缺 sha 时没说"说不清"：' + JSON.stringify(unk));
  assert(!/已存盘/.test(unk.title), '缺 sha 却说"已存盘"（那是把不知道说成知道）');
  // ⑤ 空 / 读不到：都要**说清是什么状态**，不能空着
  assert(V({ ok: true, rows: [] }).state === 'none', '没有活文件时该是 none');
  assert(/还没有活文件/.test(V({ ok: true, rows: [] }).title), '没有活文件时没给空态文案');
  const bad = V({ ok: false, error: '扫描失败' });
  assert(bad.state === 'unknown' && /（读取失败）/.test(bad.title) && /扫描失败/.test(bad.error), '回执 ok:false 时没老实说读不到：' + JSON.stringify(bad));
  assert(V(null).state === 'unknown' && /读取失败|读不到/.test(V(null).title), 'null 没兜住');
  // ⑥ 渲染层：把三种状态注入面板，看「整体存盘状态」卡真的长对了
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'basic' };
  const flat = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const saved = flat(renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __saveInfo: { ok: true, gilPath: 'C:\\x\\1.gil', rows: [row('a.lua', 'AAA', 'AAA')] } }))));
  assert(/✅ 已存盘：1 \/ 1 个脚本与地图里嵌的一致/.test(saved), '渲染层没显示已存盘：' + (saved.match(/[✅⚠️❔][^　]{0,40}/) || []));
  assert(/1\.gil/.test(saved), '没写比的是哪个 .gil：' + (saved.match(/[✅⚠️❔][^　]{0,60}/) || []));
  const dirtyHtml = flat(renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __saveInfo: { ok: true, rows: [row('a.lua', 'AAA', 'AAA'), row('柱子_红.lua', 'NEW', 'OLD')] } }))));
  assert(/⚠️ 有 1 \/ 2 个脚本没存盘/.test(dirtyHtml), '渲染层没显示"没存盘"：' + (dirtyHtml.match(/[✅⚠️❔][^　]{0,40}/) || []));
  assert(/· 柱子_红\.lua/.test(dirtyHtml), '没把没存盘的文件名列出来');
  // 还没读到 ⇒ 明说"点刷新"，不假装已存盘
  const pending = flat(renderToStaticMarkup(React.createElement(clientExports.__testPanel, base)));
  assert(/整体存盘状态/.test(pending) && /点「刷新」/.test(pending), '还没读到时没给"点刷新"：' + pending.slice(0, 0));
  assert(!/✅ 已存盘/.test(pending), '还没读到就说已存盘');
  return '四态（已存盘/没存盘/说不清/空）+ 点名 + 没挂进地图单列 + 渲染层三态';
});

check('★ 初级页两块按作者要求删掉（关卡选择器 / 关卡与文件）+ 代码操作折进 details', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'basic' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, base));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // ① 关卡块（自动跟随 + 全部关卡列表）删掉；手选关卡的能力一起没了 ⇒ 面板永远跟随当前图
  assert(!/自动跟随/.test(text), '关卡选择器（自动跟随 / 关卡列表）还在');
  assert(!/关卡与文件/.test(text), '「关卡与文件」元信息卡还在');
  for (const gone of ['本机存档', '关卡数', '账号']) {
    assert(!text.includes(gone), '删掉的那张卡里的「' + gone + '」还在');
  }
  // ② 只留一行「当前关卡」（作者：「我只关心打开的是哪个关卡」）
  assert(/① 当前关卡/.test(text), '缺 ① 当前关卡 栏');
  assert(/② 存盘与进程/.test(text), '缺 ② 存盘与进程 栏（作者要的"整体有没有保存"）');
  // ②b ★ 右栏归属（作者 2026-10-01：「将 整体存盘状态 和 进程 放在右边块」）
  //     按 -col-head 把 HTML 切开，逐块找：整体存盘状态 / 进程 必须在**第 2 块**，地图体检在**第 1 块**
  const withProc = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __status: {
      version: '0.6.3', levelCount: 1, levels: [],
      processes: {
        available: true,
        entries: [{ label: '编辑器 BeyondEditor', running: true, instances: 1, memoryMB: 1234 },
          { label: '游戏 YuanShen', running: false, instances: 0, memoryMB: 0 }],
        summary: { canPlaytest: true },
      },
    },
  })));
  const blocks = withProc.split('dsh-miliastra-col-head').slice(1);
  assert(blocks.length === 2, '初级页应该是两栏：' + blocks.length);
  const blockOf = (needle) => blocks.findIndex((b) => b.includes(needle));
  assert(blockOf('整体存盘状态') === 1, '「整体存盘状态」不在右边块：第 ' + blockOf('整体存盘状态') + ' 块');
  assert(blockOf('>进程<') === 1 || blockOf('进程') === 1, '「进程」不在右边块：第 ' + blockOf('进程') + ' 块');
  assert(blockOf('地图体检') === 0, '「地图体检」该留在左边块：第 ' + blockOf('地图体检') + ' 块');
  assert(blockOf('当前关卡') === 0, '「当前关卡」该留在左边块：第 ' + blockOf('当前关卡') + ' 块');
  assert(blockOf('代码操作') === 1, '「代码操作」该在右边块（折叠）：第 ' + blockOf('代码操作') + ' 块');
  assert(/编辑器 BeyondEditor/.test(withProc) && /✅ 在跑/.test(withProc), '进程卡没渲染出进程条目：'
    + (withProc.match(/编辑器[^<]{0,30}/) || []));
  assert(/✅ 编辑器 \+ 游戏都在/.test(withProc), '进程卡没给"能否试玩"的结论');
  // 拿不到进程信息时，这张卡**不占位**（空态交给「刷新」，不留一张空壳）
  assert(!/② 存盘与进程[\s\S]{0,200}进程/.test(renderToStaticMarkup(React.createElement(clientExports.__testPanel, base))
    .split('dsh-miliastra-col-head')[2] || ''), '读不到进程时不该渲染进程卡空壳');
  // ③ 代码操作**功能没丢**，但折进 details 且默认收起（SSR 下 details 不带 open 属性 = 收起）
  assert(/<details class="dsh-miliastra-sec"><summary[^>]*>代码操作（选活文件 \/ 体检 \/ 备份 \/ 部署 \/ 还原）/.test(html),
    '代码操作没折进 details / summary 文案不对：' + (html.match(/<summary[^>]*>[^<]{0,40}/) || []));
  assert(!/<details[^>]*\bopen\b[^>]*>\s*<summary[^>]*>代码操作/.test(html), '代码操作默认展开了（作者要的是别占视线）');
  for (const kept of ['活文件体检', '脚本一致性', '备份', '部署到活文件']) {
    assert(html.includes(kept), '折进 details 之后「' + kept + '」丢了（功能不该少）');
  }
  // ④ 面板层要真的去拉「整体存盘状态」（op=sha all:true），否则那张卡永远是空的
  assert(/callTool\('miliastra_health', Object\.assign\(\{ op: 'sha', all: true \}, lvArg\(\)\)\)/.test(src),
    '面板没去拉整体存盘状态（op=sha all:true）');
  return '删两块 + 一行当前关卡 + 代码操作折进 details（功能不减）+ 面板真去拉 sha 表';
});

check('★ 预制效果（2026-10-01 作者三条）：独立会话 + 交接值不再是两个怪输入框 + 二级分类下拉', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'presets',
    open: true, setOpen: () => {}, rootRef: { current: null } }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // ① 独立会话（作者：「我希望预制效果的模拟器是独立的 不受到其他影响」）
  assert(/src="\/miliastra\/play\?session=presets"/.test(html), '右边那块画面没带 ?session=presets：'
    + (html.match(/src="\/miliastra\/play[^"]*"/) || []));
  assert(/独立会话/.test(text), '没写清这是独立会话');
  assert(/__session: PRESETS_SESSION/.test(src), '预览没走带 __session 的引擎调用');
  const bindBlock = src.slice(src.indexOf('var doPreview = function'), src.indexOf('var field = function'));
  assert(/engineCall\(\{/.test(bindBlock), '预览还在用工具（tools 永远打在默认会话上）—— 独立不了');
  assert(!/callTool\('miliastra_sim'/.test(bindBlock), '预览仍然调 miliastra_sim ⇒ 会改掉模拟器页/AI 那份工程');
  assert(/var PRESETS_SESSION = 'presets'/.test(src), '缺 PRESETS_SESSION 常量');

  // ② 交接值：一行只读值 + 「手填」，不再是两个一上来就要人填的输入框
  assert(/交接值/.test(text), '缺「交接值」那一行');
  assert(/自动读自本关 \.gil|还没读到（模拟器预览需要/.test(text), '交接值那行没说清来源/缺什么');
  assert(/<button[^>]*>手填<\/button>/.test(html), '缺「手填」按钮（要手填的人没路了）');
  // 读不到时必须**自动展开**两个输入框（那种情况确实要人填）——SSR 下就是"读不到"，所以两个输入框在
  assert(/控件模板索引 \*/.test(text) && /容器节点索引 \*/.test(text), '读不到交接值时没给出输入框（不许静默留空）');

  // ③ 二级分类：`<optgroup label="一级 · 二级">`，且组合那一组在
  const groups = html.match(/<optgroup label="([^"]+)"/g) || [];
  assert(groups.length >= 6, '分组太少（一级/二级没做出来）：' + JSON.stringify(groups));
  assert(/label="粒子 · 组合（多层同屏）"/.test(html), '缺「粒子 · 组合（多层同屏）」这一组：' + JSON.stringify(groups));
  assert(/label="图元 · 形状沿路径"/.test(html), '缺「图元 · 形状沿路径」这一组');
  // 4 个组合都在下拉里，且条数与 Host 一致（17 粒子 + 3 图元 = 20）
  for (const id of ['combo-star-burst', 'combo-coin-fountain', 'combo-snow-blossom', 'combo-peacock-finale']) {
    assert(html.indexOf('value="' + id + '"') >= 0, '下拉里缺组合预设：' + id);
  }
  const opts = html.match(/<option value="[a-z-]+"/g) || [];
  assert(opts.length === 20, '下拉条数应为 20（17 粒子 + 3 图元）：' + opts.length);
  assert(/预制效果（20 个 · 二级分类）/.test(text), '标题没跟着条数/二级分类走');
  // 图元被选中时要说清哪两项不适用（**不许静默忽略**）
  assert(/isSpritePick\(\)/.test(src) && /填了也会被忽略/.test(src), '选了图元预设时没说明 imageId / 每层池 不适用');
  assert(/if \(sprite && \(k === 'imageId' \|\| k === 'particlesPerEmitter'\)\) return;/.test(src),
    '图元预设仍然把 imageId / particlesPerEmitter 发出去（那是无效参数）');
  // ④ 从 Host 拉清单时要**归一化 + 静态表兜底**（旧版 Host 的 summaryOnly 只回 {id,nameZh} ⇒
  //    分组会退化成「其他」、图元被当成粒子、一次性预设说不清）
  assert(/l1: p\.categoryLabel \|\| \(s \? s\[3\] : \(p\.shapeKind === 'sprite' \? '图元' : '粒子'\)\)/.test(src),
    '从 Host 拉回来的清单没做「归一化 + 静态表兜底」（旧 Host 上分组会退化成"其他 · 其他"、图元也会被认错）');
  assert(/loop: p\.defaultLoop === undefined \? \(s \? s\[5\] !== false : true\) : p\.defaultLoop !== false/.test(src),
    '从 Host 拉回来的清单没给"是否循环"留兜底（一次性预设说不清）');
  // ④b ★ Host 的 summaryOnly **必须**留着分类/图元/循环这几个字段（2026-10-01 实测踩到）
  const host = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'vfx', 'index.mjs'), 'utf8');
  const slimBlock = host.slice(host.indexOf('if (summaryOnly) {'), host.indexOf('out.presetsOmitted = true;'));
  for (const keep of ['categoryLabel', 'subLabel', 'shapeKind', 'defaultLoop']) {
    assert(slimBlock.indexOf(keep) >= 0, 'summaryOnly 把 `' + keep + '` 砍掉了 —— 面板分组/图元识别会跟着坏');
  }
  // ⑤ ★ 一次性预设（loop:false）必须说清 + 给「重播」（作者实测"啥都没咋回事"：slash-arc 1.2 秒播完）
  assert(/var isOneShot = function/.test(src), '缺 isOneShot（分不清"播完了"和"坏了"）');
  assert(/这个预设是\*\*一次性\*\*的（loop=false）/.test(src), '一次性预设没给出解释');
  assert(/'重播'/.test(src), '缺「重播」按钮（一次性动画没法从头再看）');
  assert(/onClick: function \(\) \{ doPreview\(\); \}[\s\S]{0,260}'重播'\)/.test(src),
    '「重播」没走 doPreview（那是让一次性动画从头跑的唯一办法）');
  assert(/一次性动画\*\*不会\*\*因此重播/.test(src), '「重载画面」的说明没说清它**不会**重播动画');
  // 静态兜底表也要带 loop（Host 清单没回来时同样要能说清）
  assert(/\['slash-arc', '刀光 · 切向拉伸 \+ 残影', false, '图元', '形状沿路径', false\]/.test(src),
    '静态表的 slash-arc 没标成一次性（loop:false）');
  return '独立会话（?session=presets + engineCall）+ 交接值一行/手填 + 20 条二级分类下拉 + 图元不适用 + 一次性预设解释与重播';
});

// ---------- ⑤ 2026-09-26：顶部 tab 撤掉后，切换**只能**靠浮层内部那三页 ----------

check('★ 顶部 tab 已撤：切换只剩浮层内部三页（初级功能 / 高级功能 / 模拟器）', () => {
  assert(clientExports.__testViewTabs === undefined, '__testViewTabs 还在 —— VIEW_TABS 应已随注册一起删掉');
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'basic',
    open: true, setOpen: () => {}, rootRef: { current: null },
  }));
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const label of ['初级功能', '高级功能', '模拟器']) {
    assert(text.includes(label), '浮层里缺页面按钮：' + label + '（撤掉顶部 tab 后它是唯一入口）');
  }
  assert(/dsh-miliastra-viewtabs/.test(html), '缺页面切换条容器（三等分那条）');
  return '三页按钮 + 切换条都在浮层里';
});

check('（历史 inline 布局，生产已无入口）「初级功能」只出 ① 当前关卡 + ② 存盘与进程', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'basic' }));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('① 当前关卡'), '缺 ① 当前关卡');
  assert(text.includes('② 存盘与进程'), '缺 ② 存盘与进程');
  assert(!text.includes('③ 日志与画面'), 'basic 视图不该出 ③ 日志与画面');
  assert(html.includes('dsh-miliastra-inline'), '没有 inline 样式类 —— 视图模式没生效（会仍按浮层渲染）');
  return '两栏，无 ③';
});

check('「高级功能」视图：只出 ③ 日志与画面（含高级诊断），不重复 ①②', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'advanced' }));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('③ 日志与画面'), '缺 ③ 日志与画面');
  assert(!text.includes('① 当前关卡'), 'advanced 视图不该出 ① 当前关卡');
  assert(!text.includes('② 存盘与进程'), 'advanced 视图不该出 ② 存盘与进程');
  return '一栏（③ + 高级诊断）';
});

check('inline 视图里没有关闭按钮（视图不该有"关掉自己"这回事）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, { __panelTab: 'all', inline: true, group: 'basic' }));
  assert(!/dsh-miliastra-x/.test(html), 'inline 视图里出现了关闭按钮');
  return '无 ×';
});

check('★「模拟器」视图：那条多余的横条删了、四张卡隐藏了，试玩页与两个独有动作还在', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorView, {}));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  /*
   * ① 作者 2026-10-01（截图圈出那条）：「模拟器多了一个横条 非常奇怪」——
   *    该条 = SimulatorBody 自己的全宽 header（图标 +「模拟器」+ 就绪徽标 + 刷新）。
   *    这一页上面已经有 tab 条、外面还有面板头，所以整条删掉（`-badge` 就是那条的徽标，用作判据）。
   */
  assert(!html.includes('dsh-miliastra-badge'), '那条横条还在（就绪/试玩中徽标 + 模拟器标题 + 刷新）');
  assert(!/模拟器<\/span>/.test(html), '横条里的标题「模拟器」还在');
  // ② 刷新能力搬到试玩页工具条，且**只**剩这一个入口（原来是横条上一个 + 工具条重载）
  assert(text.includes('刷新状态'), '「刷新状态」没搬进试玩页工具条');
  // ③ 四张卡按作者要求**不再渲染**（试玩日志 / 试玩操作 / 操作时间线 / 验收单）
  for (const gone of ['试玩日志', '试玩操作', '操作时间线', '验收单']) {
    assert(!text.includes(gone), '作者要求隐藏的卡还在：「' + gone + '」');
  }
  // ④ 试玩页（右列）必须在：画面、两种打开方式、工具条
  for (const label of ['试玩页（WebGL', '重载页面', '新窗口 ↗', '画面就在这里']) {
    assert(text.includes(label), '试玩页缺内容：' + label);
  }
  // ⑤ 只有面板里**没别处可点**的两个动作保留（搬进 ④ 折叠卡），别一起删掉
  for (const label of ['导出 GIA', '重置工程', '④ 工程与控件树']) {
    assert(text.includes(label), '该保留的动作/卡片丢了：' + label);
  }
  // ⑥ 画布固定说明还在（解释为什么没有设备/人数/视角下拉）
  assert(/画布\/人数\/视角固定/.test(text), '画布固定那句说明丢了');
  assert(html.includes('dsh-miliastra-inline'), '模拟器视图没走全宽 inline 布局');
  return '无横条 + 四卡隐藏 + 试玩页齐 + 导出/重置保留 + 全宽布局';
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
  assert(bTxt.includes('① 当前关卡') && bTxt.includes('② 存盘与进程'), '初级页缺 ①②');
  assert(!bTxt.includes('③ 日志与画面'), '初级页混进了 ③');
  assert(/dsh-miliastra-bodyfill/.test(basic), '初级页没平铺（会留一个空洞的第三栏）');

  const adv = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'advanced' })));
  const aTxt = adv.replace(/<[^>]+>/g, ' ');
  assert(aTxt.includes('③ 日志与画面'), '高级页缺 ③');
  assert(!aTxt.includes('① 当前关卡') && !aTxt.includes('② 存盘与进程'), '高级页混进了 ①②');
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
 * ★ 2026-10-01 作者：「试玩日志 / 试玩操作的 GUI 直接隐藏，操作时间线、验收单没有用」——
 *   按键行与传输控制**也一起没了**（它们原本住在「② 试玩操作」这张卡里；试玩页自己就有整套控制）。
 *   这条断言同时是**反向**的：谁要把那四张卡加回来，先看这段注释与作者的原话。
 * ⚠️ 但 `导出 GIA` / `重置工程` **没别处可点**，仍然保留（搬进了 ④ 折叠卡）；画布固定那句说明也保留。
 */
check('模拟器面板：四张卡（日志/操作/时间线/验收单）已隐藏，设备·人数·视角 + 连帧/截图也没了', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const gone of ['① 试玩日志', '② 试玩操作', '③ 操作时间线', '验收单']) {
    assert(!text.includes(gone), '作者要求隐藏的卡还在：「' + gone + '」');
  }
  assert(!text.includes('按键：') && !text.includes('发送键'), '按键行还留着（它属于被隐藏的「试玩操作」）');
  assert(!text.includes('开始试玩') && !text.includes('单步') && !text.includes('停止'),
    '传输控制还留着 —— 试玩页自己就有（作者要求隐藏面板这份）');
  assert(text.includes('导出 GIA') && text.includes('重置工程'), '这两个没别处可点，不该跟着一起没');
  assert(!text.includes('设备：') && !text.includes('人数：') && !text.includes('视角：'),
    '还留着设备/人数/视角下拉 —— 作者要求去掉（它们会重建运行时、打歪画布尺寸）');
  assert(/画布\/人数\/视角固定/.test(text), '去掉开关后没写清"现在是固定的什么"');
  return '四卡隐藏 + 按键/传输控制一起下 + 导出/重置保留 + 设备三下拉已固定';
});

check('模拟器是**面板内的第三个页面**（不再只是提示去会话区）', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'sim' })));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(text.includes('导出 GIA') && text.includes('试玩页（WebGL'), '模拟器页没渲染出动作按钮/试玩页');
  assert(text.includes('刷新状态'), '模拟器页缺「刷新状态」');
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
  // ④ 左列剩下的两块都在；**顺序 = "最常看的在最上面"**（第一位是作者点名的「读本地 .lua（绝对路径）」）。
  //    ★ 2026-10-01：中间那 4 张（① 试玩日志 / ② 试玩操作 / ③ 操作时间线 / 验收单）按作者要求不再渲染。
  for (const label of ['读本地 .lua（绝对路径）', '④ 工程与控件树 / 工程适配', '工程适配']) {
    assert(text.includes(label), '左列缺：' + label);
  }
  const order = ['读本地 .lua（绝对路径）', '④ 工程与控件树'];
  const idx = order.map((s) => text.indexOf(s));
  assert(idx.every((n) => n >= 0) && idx.slice().sort((a, b) => a - b).join(',') === idx.join(','),
    '左列顺序不对（「读本地 .lua（绝对路径）」必须排第一）：' + idx.join(' / '));
  // 「最顶上」= 真的排在左列第 1 张卡（在左列容器里、且在工程折叠卡之前）——作者原话「放做在左边最顶上」
  assert(html.indexOf('读本地 .lua（绝对路径）') > html.indexOf('dsh-miliastra-playside')
    && html.indexOf('读本地 .lua（绝对路径）') < html.indexOf('④ 工程与控件树'),
  '「读本地 .lua（绝对路径）」没排在左列最上面');
  // ⑤ 被隐藏的四张卡**确实不在**（作者：「试玩日志 / 试玩操作的 GUI 直接隐藏，操作时间线、验收单没有用」）；
  //    但面板里**没别处可点**的工程动作与扫描入口要留着（它们驱动的是**同一个**会话）
  for (const gone of ['① 试玩日志', '② 试玩操作', '③ 操作时间线', '验收单']) {
    assert(!text.includes(gone), '左列还渲染着已隐藏的卡：' + gone);
  }
  for (const label of ['导出 GIA', '重置工程', '扫描活文件', '搭进模拟器']) {
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
  const b = flat.indexOf('④ 工程与控件树');
  assert(a >= 0 && b > a, '「绝对路径」那一块没渲染出来（或它没排在 ④ 工程卡 之前）');
  const block = flat.slice(a, b);
  const stars = block.match(/\*\*[^*]{1,40}\*\*/g);
  assert(!stars, '新入口文案里有 Markdown 记号（会原样显示）：' + (stars || []).join(' | '));
  const ticks = block.match(/`[^`\n]{1,40}`/g) || [];
  assert(ticks.length === 0, '新入口文案里有反引号（会原样显示）：' + ticks.join(' | '));

  // ⑧ 位置（作者原话「放做在左边最顶上」）：左列现在只剩两张卡（这张 + ④ 工程折叠），它必须在前
  assert(flat.indexOf('读本地 .lua（绝对路径）') >= 0
    && flat.indexOf('读本地 .lua（绝对路径）') < flat.indexOf('④ 工程与控件树'),
  '「读本地 .lua（绝对路径）」没排在左列最上面');
  assert(!/① 画面与日志/.test(flat) && !/② 试玩操作（高级/.test(flat), '旧的卡片名/结构又回来了');

  return '输入框 + 读取 + 用它搭进模拟器（排在左列最上面）；两个请求体的 source 都是粘贴的路径；新文案无 Markdown 记号';
});

/*
 * 2026-09-25（作者报的缺陷）③：面板「读取」拿到候选之后，**能少一步手点就少一步**，
 * 而候选为空时**必须说清"还缺什么"**（不能只回一句"一条都没有"，也不能让「用它搭进模拟器」看起来现在就能用）。
 *
 * 这条管四件事（纯函数直测 + 渲染一遍）：
 *   ① `isTemplate:true` 的候选**默认预勾选**、`kindHint` 直接当初始 kind；
 *   ② `containerId` 候选**预填**进输入框；没抽到就是空串（**不编号**）；
 *   ③ 候选为空 → 指路：去 .gil 读（miliastra_map op=clientui）或手填；抽取失败 → 如实说失败；
 *   ④ 面板文案不许出现 Markdown 记号（面板不渲染 Markdown，`**` 会原样显示给人看）。
 */
check('★ ③ 面板「读取」：候选预勾选 / 容器预填 / 空候选指路 + 按钮旁写清"还缺什么"', () => {
  const ho = {
    readFrom: 'source',
    containerId: 1073741845,
    candidates: [
      { name: 'containerNodeIndex', value: 1073741845, kindHint: null, role: 'container', isTemplate: false },
      { name: 'prefabImage', value: 1073741852, kindHint: 'image', role: 'value', isTemplate: true },
      { name: 'prefabTextBox', value: 1073741850, kindHint: 'textbox', role: 'value', isTemplate: true },
    ],
  };
  // ① 预勾选（isTemplate 的勾上、kind 预填；容器那条不当模板勾）
  const rows = clientExports.__testExtRowsFromHandover(ho);
  assert(rows.length === 3, '候选行数不对：' + JSON.stringify(rows));
  const img = rows.find((r) => r.value === 1073741852);
  assert(img.on === true && img.kind === 'image', 'isTemplate 的候选没默认预勾选 / 没预填 kind：' + JSON.stringify(img));
  assert(rows.find((r) => r.value === 1073741850).kind === 'textbox', 'textbox 候选的 kind 没预填');
  assert(rows.find((r) => r.value === 1073741845).on === false, '容器索引那条不该被当模板勾上');
  assert(clientExports.__testExtRowsFromHandover(null).length === 0, '空回执应给空表（不是炸）');
  // ② 容器预填
  assert(clientExports.__testExtContainerFromHandover(ho) === '1073741845', '容器索引没预填进输入框');
  assert(clientExports.__testExtContainerFromHandover({}) === '', '没抽到容器索引时不该编一个号');
  // ③ 空候选指路 + 抽取失败如实说
  const empty = clientExports.__testExtCandidatesLine({ candidates: [] });
  assert(/miliastra_map op=clientui/.test(empty), '空候选没指路（第二条自动来源是 .gil）：' + empty);
  assert(/手填/.test(empty), '空候选没说"或手填"：' + empty);
  assert(/抽取失败/.test(clientExports.__testExtCandidatesLine({ ok: false, error: '读不到 X' })),
    '抽取失败被说成"没有候选"（两种情况的下一步完全不同）');
  assert(/3 条/.test(clientExports.__testExtCandidatesLine(ho)), '有候选时没给条数：' + clientExports.__testExtCandidatesLine(ho));
  // ④ 「还缺什么」：没勾模板 → 说清现在点会缺 templates 报错；勾了 → 说清会用什么搭
  const miss = clientExports.__testExtBindReadyHint(rows.map((r) => Object.assign({}, r, { on: false })));
  assert(/缺 templates/.test(miss), '没有可用模板时没写清缺什么：' + miss);
  const ready = clientExports.__testExtBindReadyHint(rows);
  assert(/2 个模板/.test(ready) && /prefabImage/.test(ready), '有模板时没说清会用哪几个：' + ready);
  assert(clientExports.__testExtBindReadyHint([]).length > 0, '空表也要有一句话（不能什么都不写）');
  // ⑤ 这些新文案都会被面板原样显示 —— 不许有 Markdown 记号
  for (const t of [empty, miss, ready, clientExports.__testExtCandidatesLine(ho)]) {
    assert(!/\*\*/.test(t) && !/`/.test(t), '面板文案里混进了 Markdown 记号（会原样显示）：' + t);
  }
  // ⑥ 渲染层：那句「还缺什么」真的挂在「用它搭进模拟器」旁边（静态渲染时表是空的 → 应出现"还缺模板"）
  const html = renderToStaticMarkup(React.createElement(clientExports.__testSimulatorBody, {}));
  const flat = html.replace(/<[^>]+>/g, ' ');
  assert(/还缺模板/.test(flat), '「用它搭进模拟器」旁边没有写清缺什么');
  assert(flat.indexOf('还缺模板') > flat.indexOf('用它搭进模拟器'), '「还缺什么」那句没排在按钮后面（写在上方会像在说别的）');
  return '预勾选/预填 + 空候选指路 + 缺什么（渲染可见）+ 无 Markdown 记号';
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
  // 但必须写清「画面去哪里看」（不能让人以为功能没了）。
  // ⚠️ 2026-10-01：原来这句在左列 ②「试玩操作」里，那张卡按作者要求隐藏了 ⇒ 现在靠**试玩页自己的标题那行**说清。
  assert(/画面就在这里/.test(simText) || /画面[^）]{0,30}试玩页/.test(simText), '没告诉人"画面就在右边那个试玩页里"');
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

/*
 * ============================ 第六页「网格计算」 ============================
 * 2026-09-30 作者要求：真机 UGC 画布是 **1600 × 1000**（所有坐标按它设计），摆放模型时对不准位置，
 * 所以面板里加一页网格计算。规则**改了**（相对工作区技能 `game-grid-mapper`）：
 *   ① **不再要求步长整除画布**（旧 `grid.py` 除不尽直接 `ValueError` 拒绝建档）——
 *      除不尽就如实报残多少，**界外那一条不算**（作者原话「我们就不管最后在界外的点了」）；
 *   ② **X / Y 步长可以不同**（旧技能只有一个正方形 `cell`）；默认推荐 X 100 / Y 50。
 * 这一页**纯前端计算**（一个工具都不调、不写文件），所以回归全落在纯函数 + 渲染 + 文案上。
 */
check('网格计算（纯函数）：默认 1600×1000 / X100 Y50 ⇒ 16×20 = 320 格，整除铺满', () => {
  const P = clientExports.__testGridPlan;
  assert(typeof P === 'function', '缺少 __testGridPlan（网格参数没有独立函数就无法回归）');
  const g = P({ width: 1600, height: 1000, stepX: 100, stepY: 50 });
  assert(g.ok === true, '默认参数应该合法：' + JSON.stringify(g));
  assert(g.cols === 16 && g.rows === 20 && g.cells === 320, '格数不对：' + JSON.stringify(g));
  assert(g.restX === 0 && g.restY === 0 && g.exact === true, '整除却报了残格：' + JSON.stringify(g));
  assert(g.coverX === 1600 && g.coverY === 1000, '有效覆盖不对：' + JSON.stringify(g));
  const ax = clientExports.__testGridAxisLine(g, 'x');
  assert(/^X：1600 \/ 100 = 16\.0000/.test(ax), 'X 轴结论格式不对：' + ax);
  assert(/整除/.test(ax), '整除了却没写「整除」：' + ax);
  assert(clientExports.__testGridAxisLine(g, 'y').startsWith('Y：'), 'Y 轴结论没区分轴：' + clientExports.__testGridAxisLine(g, 'y'));
  // 数字显示：不许出现浮点尾巴
  assert(clientExports.__testGridNum(0.1 + 0.2) === '0.3', 'gridNum 没抹掉浮点尾巴：' + clientExports.__testGridNum(0.1 + 0.2));
  assert(clientExports.__testGridNum('abc') === '?', 'gridNum 对非法输入没给占位：' + clientExports.__testGridNum('abc'));
  return '16×20=320，整除铺满，X/Y 分开';
});

check('★ 除不尽**不再拒绝**：1600×1000 / X110 Y80 ⇒ 14×12 格，残 60/40，界外不算（作者给的例子）', () => {
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  assert(g.ok === true, '除不尽不该被拒（这正是这次要改的规则）：' + JSON.stringify(g));
  assert(g.cols === 14 && g.rows === 12, '格数不对：' + JSON.stringify(g));
  assert(g.restX === 60 && g.restY === 40, '残格不对（应 X 残 60 / Y 残 40）：' + JSON.stringify(g));
  assert(g.coverX === 1540 && g.coverY === 960, '有效覆盖不对：' + JSON.stringify(g));
  assert(g.cells === 168 && g.exact === false, '总格数/整除标记不对：' + JSON.stringify(g));
  const ax = clientExports.__testGridAxisLine(g, 'x');
  assert(/14\.5455/.test(ax), 'X 的比例没算对：' + ax);
  assert(/残 60px/.test(ax), 'X 的残格没报出来：' + ax);
  assert(/最后一格切不出来/.test(ax), '没说清"最后一格切不出来"：' + ax);
  assert(/残 40px/.test(clientExports.__testGridAxisLine(g, 'y')), 'Y 的残格没报出来：' + clientExports.__testGridAxisLine(g, 'y'));
  const lines = clientExports.__testGridSummaryLines(g);
  assert(lines.length === 4, '结论应该有 4 行：' + JSON.stringify(lines));
  assert(/14 × 12 = 168 格/.test(lines[2]), '结论里的格数行不对：' + lines[2]);
  assert(/x\[0, 1540\)/.test(lines[2]) && /y\[0, 960\)/.test(lines[2]), '结论没写有效覆盖：' + lines[2]);
  assert(/界外不算/.test(lines[3]) && /60px/.test(lines[3]) && /40px/.test(lines[3]), '界外那行不对：' + lines[3]);
  return '14×12=168，残 60/40，界外=丢';
});

check('像素 → 格：三态（格内 / 残格 / 画布外）—— 残格要说清"落在第几格位置上"', () => {
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const F = clientExports.__testGridPixelToCell;
  assert(typeof F === 'function', '缺 __testGridPixelToCell');
  // ① 格内
  const a = F(g, 880, 400);
  assert(a.ok && a.state === 'in' && a.inGrid === true, '格内被判成界外：' + JSON.stringify(a));
  assert(a.col === 8 && a.row === 5, '格号算错（880/110=8、400/80=5）：' + JSON.stringify(a));
  assert(/覆盖 x\[880, 990\)/.test(a.note) && /中心 \(935, 440\)/.test(a.note), '格内结论不对：' + a.note);
  // ② 右边残格：x ∈ [1540, 1600)
  const b = F(g, 1550, 500);
  assert(b.state === 'rest' && b.inGrid === false, '残格没被标成界外：' + JSON.stringify(b));
  assert(b.col === null, '界外的点不该给一个"格号"（会误导）：' + JSON.stringify(b));
  assert(/第 15 格位置上/.test(b.note) && /网格只有 14 格/.test(b.note), '残格没说清它落在不存在的第几格：' + b.note);
  // ③ 下边残格：y ∈ [960, 1000)
  assert(F(g, 500, 980).state === 'rest', '下边残格没被识别');
  assert(/第 13 行位置上/.test(F(g, 500, 980).note), '下边残格的行号不对：' + F(g, 500, 980).note);
  // ④ 画布外（含正好落在右下边界上的那个点）
  const d = F(g, 1600, 1000);
  assert(d.state === 'out' && /画布外/.test(d.note), '边界点没判成画布外：' + JSON.stringify(d));
  assert(F(g, -1, 10).state === 'out', '负坐标没判成画布外');
  // ⑤ 整除的那套里，右/下边界就是"画布外"，不该被说成残格
  const ex = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 100, stepY: 50 });
  assert(F(ex, 1600, 1000).state === 'out', '整除时边界点被说成了残格（残 0 不该叫残格）');
  assert(F(ex, 0, 0).state === 'in' && F(ex, 0, 0).col === 0 && F(ex, 0, 0).row === 0, '原点不在 (0,0) 格里');
  const bad = F(g, 'x', 1);
  assert(bad.ok === false && /必须是数字/.test(bad.error), '非法像素没如实报错：' + JSON.stringify(bad));
  return 'in/rest/out 三态 + 残格给"第几格位置" + 边界不误判';
});

check('格 → 像素：左上/中心/覆盖范围；列行越界**如实报合法范围**（不静默夹）', () => {
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const C = clientExports.__testGridCellToPixel;
  const c = C(g, 8, 5);
  assert(c.ok && c.x0 === 880 && c.y0 === 400 && c.x1 === 990 && c.y1 === 480, '范围算错：' + JSON.stringify(c));
  assert(c.cx === 935 && c.cy === 440, '中心算错（X/Y 步长不同时最容易错）：' + JSON.stringify(c));
  assert(/左上 \(880, 400\)/.test(c.note), '结论里没写左上：' + c.note);
  // 数字字符串也要认（面板输入框给的就是字符串）
  assert(C(g, '0', '0').ok === true && C(g, '0', '0').x1 === 110, '字符串列/行没认：' + JSON.stringify(C(g, '0', '0')));
  const bad = C(g, 14, 0);
  assert(bad.ok === false && /列 0~13/.test(bad.error) && /行 0~11/.test(bad.error), '越界没如实报合法范围：' + JSON.stringify(bad));
  assert(C(g, 0, -1).ok === false, '负行号没被拒');
  return '左上/中心/范围 + 越界报 0~13 / 0~11';
});

check('网格参数不合法：如实报错（不抛、不静默兜底）', () => {
  const P = clientExports.__testGridPlan;
  const cases = [
    [{ width: 0, height: 1000, stepX: 100, stepY: 50 }, /画布宽\/高必须是正数/],
    [{ width: 'abc', height: 1000, stepX: 100, stepY: 50 }, /画布宽\/高必须是正数/],
    [{ width: 1600, height: 1000, stepX: 0, stepY: 50 }, /步长必须是正数/],
    [{ width: 1600, height: 1000, stepX: 100, stepY: -5 }, /步长必须是正数/],
    [{ width: 1600, height: 1000, stepX: 2000, stepY: 50 }, /步长比画布还大/],
    [{}, /画布宽\/高必须是正数/],
  ];
  for (const [arg, re] of cases) {
    const r = P(arg);
    assert(r.ok === false && re.test(r.error), '这一档没如实报错：' + JSON.stringify(arg) + ' → ' + JSON.stringify(r));
  }
  // 非法参数喂给别的函数也不许炸：如实回 ok:false
  assert(clientExports.__testGridCellToPixel({ ok: false, error: 'X' }, 0, 0).ok === false, '非法参数下 cellToPixel 没兜住');
  assert(clientExports.__testGridTable({ ok: false, error: 'X' }).ok === false, '非法参数下 table 没兜住');
  assert(clientExports.__testGridLines(null).ok === false, 'gridLines 对 null 没兜住');
  assert(/网格参数不合法/.test(clientExports.__testGridSummaryLines({ ok: false, error: '画布 0' })[0]), '结论行没兜住非法参数');
  return '6 档非法输入 + 下游函数兜底';
});

check('网格线与速查表都有上限：步长很小时**如实说明**，不把页面拖死', () => {
  const dense = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 1, stepY: 1 });
  assert(dense.ok === true && dense.cols === 1600, '1px 步长的计划应该仍然成立：' + JSON.stringify(dense));
  const dl = clientExports.__testGridLines(dense);
  assert(dl.cappedX === true && dl.cappedY === true, '1px 步长没触发线数上限（会画出 2600 条线）：' + JSON.stringify(dl));
  assert(dl.xs.length === 0 && dl.d === '', '超上限时不该仍然生成线：' + dl.d.length);
  assert(/线太多/.test(dl.note) && /1600/.test(dl.note), '超上限时没说清为什么没画线：' + dl.note);
  const dt = clientExports.__testGridTable(dense, 200);
  assert(dt.truncated === true && dt.rows.length === 0, '160 万格时不该真的建表：' + JSON.stringify({ t: dt.truncated, n: dt.rows.length }));
  assert(dt.total === 1600000, '截断时没报总格数：' + dt.total);
  // 正常档：线数 = 格数 + 1（每格一条 + 收尾那条）
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const ln = clientExports.__testGridLines(g);
  assert(ln.cappedX === false && ln.xs.length === 15 && ln.ys.length === 13, '线数不对（14+1 / 12+1）：' + JSON.stringify({ x: ln.xs.length, y: ln.ys.length }));
  assert(/^M0 0L0 1000M110 0L110 1000/.test(ln.d), 'path 的 d 起点不对（应逐条竖线：M<x> 0L<x> 1000）：' + ln.d.slice(0, 30));
  const tb = clientExports.__testGridTable(g, 200);
  assert(tb.truncated === false && tb.rows.length === 168, '168 格应该建表：' + JSON.stringify({ n: tb.rows.length, t: tb.truncated }));
  assert(tb.rows[0].col === 0 && tb.rows[0].row === 0 && tb.rows[167].col === 13 && tb.rows[167].row === 11, '表顺序不对（应先行后列）：' + JSON.stringify([tb.rows[0], tb.rows[167]]));
  const tsv = clientExports.__testGridTableTsv(tb);
  const tsvLines = tsv.split('\n');
  assert(/^col\trow\tx_left\ty_top/.test(tsvLines[0]), 'TSV 表头不对：' + tsvLines[0]);
  assert(tsvLines.length === 169, 'TSV 行数不对（表头 + 168）：' + tsvLines.length);
  assert(/^8\t5\t880\t400\t935\t440$/.test(tsvLines[1 + 5 * 14 + 8]), 'TSV 里格 (8,5) 那一行不对：' + tsvLines[1 + 5 * 14 + 8]);
  return '1px 步长不画线/不建表且说明；168 格建表 + TSV 169 行';
});

check('★ 渲染：第六页「网格计算」能真渲染（参数 + 结论放大 + 网格图 + 多选列表）', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'grid' })));
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const label of ['画布宽 width', '画布高 height', 'X 步长 stepX', 'Y 步长 stepY', '结论', '复制结论', '恢复默认', '网格图（左键点选', '选中的格（0）']) {
    assert(text.includes(label), '网格页缺内容：' + label);
  }
  // ★ 作者 2026-10-01 要求**隐掉**的三样：速查表 / 像素 → 格 / 格 → 像素
  for (const nope of ['逐格速查表', '像素 → 格', '格 → 像素', '复制速查表', '像素 x（右增）', '列 col（0 起）']) {
    assert(!text.includes(nope), '作者要求隐掉的东西还在界面上：' + nope);
  }
  // ★ 作者要求删掉的两处小字：画布与步长卡片底部那段、网格图下面的图例
  assert(!/步长不用整除/.test(text), '「画布与步长」底部那段说明没删掉');
  assert(!/坐标口径 = 画布左上/.test(text), '「画布与步长」底部的口径说明没删掉');
  assert(!/灰字 = 每一格的坐标/.test(text), '网格图下面的图例小字没删掉');
  assert(!/该格中心像素（与格内灰字一致）/.test(text), '复制格式那段小字没删掉');
  // ★ 结论字体放大：用专门的类（不再跟着 -log 的 10.5px 小字走）
  assert(/dsh-miliastra-gridsum/.test(html), '结论没有用放大的字号类');
  const css = styleNodes[0].textContent;
  assert(/dsh-miliastra-gridsum\{[^}]*font-size:14px/.test(css), '结论字号没放大到 14px');
  // 默认值：1600 / 1000 / 100 / 50（作者要的推荐比例）
  assert(/value="1600"/.test(html) && /value="1000"/.test(html), '默认画布尺寸没填 1600×1000');
  assert(/value="100"/.test(html) && /value="50"/.test(html), '默认步长没填 X100 / Y50');
  // 网格图：真的是 svg（不是占位），并且走的是本页的样式类
  assert(/<svg[^>]*viewBox="0 0 1600 1000"/.test(html), '网格图不是 1600×1000 的 svg：' + html.slice(0, 200));
  assert(/dsh-miliastra-gridsvg/.test(html), '网格图没有样式类（会渲染成裸 svg）');
  // 多选列表：空选中 ⇒ 两个按钮禁用，且不渲染行
  const allBtn = html.match(/<button[^>]*>复制全部（x,y 列表）<\/button>/);
  assert(allBtn && /disabled/.test(allBtn[0]), '空选中时「复制全部」该禁用');
  // 网格页不该混进别的页
  assert(!text.includes('① 关卡') && !text.includes('图片绝对路径'), '网格页混进了别的页的内容');
  // 反过来：初级页不该出现网格页的内容
  const basic = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'basic' })));
  const bText = basic.replace(/<[^>]+>/g, ' ');
  assert(!bText.includes('X 步长 stepX'), '初级页混进了网格页的内容');
  return '网格图 + 结论放大 + 三样已隐 + 两处小字已删；不串页';
});

check('★ 渲染（除不尽那一档）：残格画成琥珀、图例带实际数字、界外的点画圈而不是"点不动"', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  // 作者给的例子：1600×1000 / X110 Y80，像素 (1550,500) 正落在右边那条残格里
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __gridInit: { width: 1600, height: 1000, stepX: 110, stepY: 80, px: 1550, py: 500 },
  })));
  const text = html.replace(/<[^>]+>/g, ' ');
  // ① 结论说清残多少
  assert(/残 60px/.test(text) && /残 40px/.test(text), '除不尽那一档的结论没报残格：' + text.slice(0, 0));
  assert(/14 × 12 = 168 格/.test(text), '格数不对：' + (text.match(/\d+ × \d+ = \d+ 格/) || []));
  // ② 图里两块琥珀残格（右 + 下），外加 14+1 / 12+1 条格线
  const amber = (html.match(/rgba\(251,191,36,\.22\)/g) || []).length;
  assert(amber === 2, '残格琥珀块应该正好 2 块（右 + 下）：' + amber);
  const linePath = html.match(/<path[^>]*d="M0 0L0 1000/);
  assert(linePath, '格线 path 没画出来（除不尽那一档也要画线）：' + html.slice(0, 160));
  // ③ 图例那句**已按作者要求删掉**（"网格图的小字不要"）；残格的数字只在**结论**里说
  assert(!/琥珀块/.test(text), '图例小字又回来了（作者要求删掉）：' + (text.match(/琥珀[^。]*。/) || []));
  // ④ 界外的点：不画"格子高亮"，改画一个琥珀圈（否则图上什么都不动，人会以为点了没反应）
  assert(/<circle[^>]*stroke="#fbbf24"/.test(html), '界外的点没有标记（图上不会有任何反应）');
  assert(!/fill="rgba\(249,168,212,\.35\)"/.test(html), '界外的点不该高亮某一格（它根本不在格里）');
  assert(/像素 \(1550, 500\)[^<]*界外（残格）不算/.test(text), '界外判定的人话没渲染出来：' + (text.match(/像素 \(1550[^。]*。/) || []));
  assert(/第 15 格位置上/.test(text), '没说清它落在不存在的第几格：' + (text.match(/第 \d+ 格位置/) || []));
  // ⑤ 格内灰字坐标：168 格 ⇒ 168 个 `<text>`；**x,y 与「取哪一角」联动**（默认右下：0,0 格 = 110,80）
  const texts = html.match(/<text/g) || [];
  assert(texts.length === 168, '格内坐标标签数不对（应 168）：' + texts.length);
  assert(/>110,80</.test(html) && />1540,960</.test(html), '默认（右下）档的格内坐标没画：' + (html.match(/>[\d,]+</g) || []).slice(0, 4).join(' '));
  assert(/fill="#8fa6c4"/.test(html), '格内坐标不是灰色：' + (html.match(/fill="#[0-9a-f]{6}"/gi) || []).join(' '));
  assert(/<g[^>]*pointer-events="none"/.test(html), '标签组没关掉命中测试（点文字会变成点标签，不是点图）');
  // ⑤a ★ 联动：把角切成「左上」⇒ 格内灰字跟着变成左上角坐标（0,0 格 = 0,0）
  const tlHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __gridInit: { width: 1600, height: 1000, stepX: 110, stepY: 80, anchor: 'tl' },
  })));
  assert(/>0,0</.test(tlHtml) && />1430,880</.test(tlHtml), '切成左上角后格内坐标没联动：' + (tlHtml.match(/>[\d,]+</g) || []).slice(0, 4).join(' '));
  // ⚠️ 不能拿 '110,80' 当反例 —— 那正好也是「格 (1,0) 的左上角」；用右下档独有的末格值来判断
  assert(!/>1540,960</.test(tlHtml), '切成左上角后还在画右下角坐标（末格 1540,960 不该出现）');
  // ⑤b 切成「格号」档 ⇒ 画的是 col,row
  const cellHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __gridInit: { width: 1600, height: 1000, stepX: 110, stepY: 80, px: 1550, py: 500, labelMode: 'cell' },
  })));
  assert(/>0,0</.test(cellHtml) && />13,11</.test(cellHtml), '切成「格号」档后没画 col,row：' + (cellHtml.match(/>[\d,]+</g) || []).slice(0, 4).join(' '));
  assert(!/>110,80</.test(cellHtml), '切成「格号」档后还在画坐标');
  // ⑤c 切成「不显示」⇒ 一个 text 都不画
  const offHtml = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __gridInit: { width: 1600, height: 1000, stepX: 110, stepY: 80, labelMode: 'off' },
  })));
  assert(!/<text/.test(offHtml), '「不显示」档仍然画了标签');
  // ⑤d 速查表**已按作者要求从 GUI 隐掉**（代码与纯函数还在，只是不渲染）
  assert(!/逐格速查表/.test(text) && !/复制速查表/.test(text), '速查表又回到界面上了（作者要求隐藏）');
  // ⑥ 整除那一档：不画琥珀
  const exact = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, {
    __gridInit: { width: 1600, height: 1000, stepX: 100, stepY: 50 },
  })));
  assert(!/rgba\(251,191,36,\.22\)/.test(exact), '整除那一档不该画琥珀残格');
  return '2 块琥珀 + 无图例小字 + 界外画圈（不高亮）+ 速查表已隐；整除档无琥珀';
});

check('★ 格内灰字坐标（`gridLabels`）：每格标「经纬度」，**x,y 与「取哪一角」联动**，字号按最长文本算', () => {
  const L = clientExports.__testGridLabels;
  assert(typeof L === 'function', '缺 __testGridLabels（格内坐标标签无法回归）');
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 100, stepY: 50 });
  // ① 默认档 = 坐标 x,y，且**跟着「取哪一角」走**（默认右下）：100/50 的格 (0,0) 右下 = (100,50)
  assert(L(g).mode === 'center' && L(g, undefined).mode === 'center', '默认档不是坐标档：' + L(g).mode);
  const b = L(g, 'center');
  assert(b.ok === true && b.items.length === 320, '默认档应该每格一个标签：' + (b.items || []).length);
  assert(b.items[0].text === '100,50' && b.items[0].x === 50 && b.items[0].y === 25, '第 0 格的标签不对（默认右下）：' + JSON.stringify(b.items[0]));
  const lastB = b.items[b.items.length - 1];
  assert(lastB.text === '1600,1000', '最后一格（右下）该是 1600,1000：' + lastB.text);
  // ★ 联动：换角 ⇒ 同一格的文本跟着换（格心位置不变）
  const corners = { tl: '0,0', tr: '100,0', bl: '0,50', br: '100,50' };
  for (const [id, want] of Object.entries(corners)) {
    const it = L(g, 'center', id).items[0];
    assert(it.text === want && it.x === 50 && it.y === 25, '角 ' + id + ' 的标签该是 ' + want + '：' + JSON.stringify(it));
  }
  assert(L(g, 'center', '没这个角').items[0].text === '100,50', '未知角没回落到右下');
  // ② 字号必须**塞得进本格**（宽按**真实最长文本**算：'1600,1000' 是 9 个字符）
  assert(b.maxLen === 9, '最长文本长度算错：' + b.maxLen);
  assert(b.fontSize > 0 && b.fontSize <= g.stepX * 0.9 / (b.maxLen * 0.58) + 1e-9, '字号超出格宽：' + b.fontSize);
  assert(b.fontSize <= g.stepY * 0.62 + 1e-9, '字号超出格高：' + b.fontSize);
  // ③ 「格号」档：文本短（'15,19' = 5）⇒ 字号自动更大
  const a = L(g, 'cell');
  assert(a.items[0].text === '0,0' && a.items[319].text === '15,19', '格号档的标签不对：' + a.items[0].text + ' / ' + a.items[319].text);
  assert(a.maxLen === 5 && a.fontSize > b.fontSize, '格号更短，字号该更大：' + a.fontSize + ' vs ' + b.fontSize);
  // ④ 除不尽那一档：标签跟着**实际格号/实际坐标**走（14×12，没有第 15 格）
  const g2 = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const c = L(g2, 'cell');
  assert(c.items.length === 168, '除不尽档的标签数不对：' + c.items.length);
  assert(c.items[167].text === '13,11', '最后一格应该是 13,11：' + c.items[167].text);
  assert(c.items[167].x === 1485 && c.items[167].y === 920, '最后一格的格心不对：' + JSON.stringify(c.items[167]));
  assert(L(g2, 'center').items[167].text === '1540,960', '右下档最后一格该是 1540,960（不是画布边 1600/1000）：' + L(g2, 'center').items[167].text);
  assert(L(g2, 'center', 'tl').items[167].text === '1430,880', '左上档最后一格不对：' + L(g2, 'center', 'tl').items[167].text);
  // ⑤ 不显示 = 真的不画（不是空字符串）
  assert(L(g, 'off').items.length === 0 && L(g, 'off').note === '', 'off 档不该生成标签');
  assert(L(g, '没这个档').mode === 'center', '未知档要回落到默认（不静默乱画）');
  // ⑥ 太多格 / 格子太小 ⇒ 不画，并**说清为什么**（画出来是糊的 = 骗人）
  const many = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 20, stepY: 25 });
  const dm = L(many, 'cell');
  assert(dm.items.length === 0 && /格太多/.test(dm.note) && /3200/.test(dm.note), '格太多时没如实说明：' + JSON.stringify(dm.note));
  // 格子太小：**格数没超**，但算出来的字号 <14 ⇒ 同样不画（1×50 格，Y 只有 20px）
  const tiny = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 1600, stepY: 20 });
  const dt = L(tiny, 'cell');
  assert(tiny.cells === 50 && dt.items.length === 0 && /格子太小/.test(dt.note),
    '格子太小时没如实说明：' + JSON.stringify({ cells: tiny.cells, note: dt.note }));
  assert(L({ ok: false, error: 'X' }, 'cell').items.length === 0, '参数不合法时不该产出标签');
  return 'x,y 与「取哪一角」联动（四角 + 未知回落）+ 按最长文本定字号 + 除不尽档跟实际格号/坐标';
});

check('★ 「当前点」那一行（`gridPointLine`）：三种状态都说人话，界外的不假装在格里', () => {
  const F = clientExports.__testGridPointLine;
  assert(typeof F === 'function', '缺 __testGridPointLine');
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const P = clientExports.__testGridPixelToCell;
  const sel = F(P(g, 880, 400));
  assert(/^当前点：格 \(8, 5\)/.test(sel), '当前点那一行的格式不对：' + sel);
  assert(/覆盖 x\[880, 990\)/.test(sel) && /中心 \(935, 440\)/.test(sel), '当前点没给覆盖范围/中心：' + sel);
  const rest = F(P(g, 1550, 500));
  assert(/^像素 \(1550, 500\)/.test(rest) && /界外（残格）不算/.test(rest), '残格那一行没给"点在哪儿"：' + rest);
  const out = F(P(g, 1600, 1000));
  assert(/^像素 \(1600, 1000\)/.test(out) && /画布外/.test(out), '画布外那一档不对：' + out);
  assert(/不合法/.test(F(null)), '参数不合法时没说清；' + F(null));
  assert(/必须是数字/.test(F({ ok: false, error: '像素坐标必须是数字' })), '错误要原样透出：' + F({ ok: false, error: '像素坐标必须是数字' }));
  return '格内/残格/画布外 三态 + 非法输入';
});

check('★ 多选（`gridSelToggle` / `gridSelRows` / `gridSelLua`）：点格子切换、列表逐行、一起复制的格式是作者给的那个', () => {
  const T = clientExports.__testGridSelToggle;
  const R = clientExports.__testGridSelRows;
  const Lua = clientExports.__testGridSelLua;
  assert(typeof T === 'function' && typeof R === 'function' && typeof Lua === 'function', '缺多选三件套');
  // ① 点一格 = 加入；再点同一格 = 移出（这就是"多选"的开关）
  let sel = T([], 8, 10);
  assert(JSON.stringify(sel) === JSON.stringify([{ col: 8, row: 10 }]), '第一次点没加入：' + JSON.stringify(sel));
  sel = T(sel, 9, 10);
  assert(sel.length === 2 && sel[1].col === 9, '第二次点没加进去（多选失败）：' + JSON.stringify(sel));
  sel = T(sel, 8, 10);
  assert(JSON.stringify(sel) === JSON.stringify([{ col: 9, row: 10 }]), '再点同一格没移出：' + JSON.stringify(sel));
  // 不改入参、坏项丢掉
  const orig = [{ col: 1, row: 2 }];
  T(orig, 3, 4);
  assert(orig.length === 1, 'gridSelToggle 改了入参（React 状态会被就地改坏）');
  assert(T([{ col: 'x' }, null, { col: 5, row: 6 }], 7, 8).length === 2, '坏项没被丢掉：' + JSON.stringify(T([{ col: 'x' }, null, { col: 5, row: 6 }], 7, 8)));
  // ② ★ 四角（作者 2026-10-01：「增加四角下拉选择…默认是右下」）：110/80 下格 (8,5) 覆盖 x[880,990) y[400,480)
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const corners = { br: [990, 480], bl: [880, 480], tl: [880, 400], tr: [990, 400] };
  for (const [id, xy] of Object.entries(corners)) {
    const r = R(g, [{ col: 8, row: 5 }], id)[0];
    assert(r.ok && r.x === xy[0] && r.y === xy[1], '角 ' + id + ' 取错了：' + JSON.stringify(r));
  }
  // 默认（不传 anchor）= 右下
  const dft = R(g, [{ col: 8, row: 5 }])[0];
  assert(dft.x === 990 && dft.y === 480 && dft.anchor === 'br', '默认不是右下：' + JSON.stringify(dft));
  assert(dft.anchorName === '右下', '没回角的显示名：' + dft.anchorName);
  // 未知角回落成默认（不静默取一个奇怪的角）
  assert(R(g, [{ col: 8, row: 5 }], '没这个角')[0].x === 990, '未知角没回落到右下');
  const rows = R(g, [{ col: 8, row: 5 }, { col: 0, row: 0 }], 'tl');
  assert(rows.length === 2 && rows[0].x === 880 && rows[0].y === 400, '左上角取错：' + JSON.stringify(rows[0]));
  assert(rows[1].x === 0 && rows[1].y === 0, '格 (0,0) 的左上角该是 (0,0)：' + JSON.stringify(rows[1]));
  // ③ ★ 一起复制的格式 = 作者给的那个（**逐字节**对，含 `, ` / ` }` / 换行）
  const two = Lua([{ ok: true, x: 730, y: 460 }, { ok: true, x: 840, y: 540 }]);
  assert(two === '[{x = 730, y = 460 },\n{x = 840, y = 540 }]',
    '一起复制的格式与作者给的不一致：\n' + JSON.stringify(two));
  assert(Lua([]) === '[]', '空选中该给 []：' + Lua([]));
  assert(Lua([{ ok: true, x: 55, y: 40 }]) === '[{x = 55, y = 40 }]', '单个的格式不对：' + Lua([{ ok: true, x: 55, y: 40 }]));
  // 不可用的行**不许**写进复制正文（复制出去的东西必须能用）
  assert(Lua([{ ok: true, x: 1, y: 2 }, { ok: false, error: '没有这个格' }]) === '[{x = 1, y = 2 }]',
    '失效的行混进了复制正文：' + Lua([{ ok: true, x: 1, y: 2 }, { ok: false, error: '没有这个格' }]));
  // ④ 网格改小 ⇒ 原来选的格不再存在：那一行 ok:false 且**说清为什么**（不静默丢、不拿邻近格顶替）
  //    ⚠️ 用 110/80 那一档：它只有 14 列 / 12 行，col 15 是"没有这一格"
  const bad = R(g, [{ col: 15, row: 19 }, { col: 3, row: 3 }]);
  assert(bad[0].ok === false && /列 0~13/.test(bad[0].error), '失效的那行没如实报错：' + JSON.stringify(bad[0]));
  assert(bad[1].ok === true, '有效的那行被误判失效：' + JSON.stringify(bad[1]));
  assert(R({ ok: false, error: 'X' }, [{ col: 1, row: 1 }]).length === 0, '参数不合法时不该给出选中行');
  return '切换(加/减/不改入参) + **四角**（默认右下）+ **逐字节**格式 + 失效行不参与复制';
});

check('★ 缓存（localStorage）：读不到就回 null（默认值），存不下要能**如实回 false**', () => {
  const G = clientExports.__testStoreGet;
  const S = clientExports.__testStoreSet;
  assert(typeof G === 'function' && typeof S === 'function', '缺 storeGet / storeSet');
  // 本测试环境**没有** localStorage（假 window 只有插件真正用到的那几个成员）⇒
  // 必须优雅降级：读回 null、写回 false —— 绝不抛，也绝不假装成功。
  assert(G('dsh-miliastra:grid') === null, '没有 localStorage 时该回 null：' + JSON.stringify(G('dsh-miliastra:grid')));
  assert(S('dsh-miliastra:grid', { width: '1600' }) === false, '没有 localStorage 时该回 false（好让人知道没存下）');
  // 渲染层：存不下时**不许静默** —— 那句提示的文案要在产物里（effect 在 SSR 不跑，所以查源码常量）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  assert(/没能存到浏览器里/.test(src), '存不下时没有如实提示（静默失败 = 让人以为"下次还在"）');
  assert(/localStorage/.test(src) && /typeof localStorage === 'undefined'/.test(src),
    'localStorage 没有 exists 守卫（隐私模式/被禁会直接抛）');
  return '无 localStorage 时读 null / 写 false + 存不下有提示 + 有守卫';
});

check('★ 右键标记颜色（`gridColorToggle` / `gridSelRows` / `gridSelLua`）：导出片段要**逐字节**等于作者给的那个', () => {
  const T = clientExports.__testGridColorToggle;
  const Of = clientExports.__testGridColorOf;
  const R = clientExports.__testGridSelRows;
  const Lua = clientExports.__testGridSelLua;
  assert(typeof T === 'function' && typeof Of === 'function', '缺颜色两件套');
  // ① 色板：第一个就是作者例子里那个灰；都有 name + hex
  const pal = clientExports.__testGridColors;
  assert(Array.isArray(pal) && pal.length >= 4, '色板太短：' + (pal || []).length);
  assert(pal[0].id === 'gray' && pal[0].name === '灰色' && pal[0].hex === '#d6d7dc',
    '第一个色该是作者给的灰 #d6d7dc：' + JSON.stringify(pal[0]));
  for (const c of pal) assert(/^#[0-9a-f]{6}$/.test(c.hex) && c.name && c.id, '色条不全：' + JSON.stringify(c));
  // ② 切换：上色 → 同色再点 = 清除；换色 = 覆盖；不改入参；未知色 = 清除
  let m = T({}, 1, 2, 'gray');
  assert(m['1,2'] === 'gray', '第一次右键没上色：' + JSON.stringify(m));
  assert(Object.keys(T(m, 1, 2, 'gray')).length === 0, '同色再右键没清除');
  assert(T(m, 1, 2, 'red')['1,2'] === 'red', '换色没覆盖');
  const keep = { '1,2': 'gray' };
  T(keep, 3, 4, 'red');
  assert(Object.keys(keep).length === 1 && keep['1,2'] === 'gray', 'gridColorToggle 改了入参');
  assert(Object.keys(T(m, 1, 2, '没这个色')).length === 0, '未知色没被当成清除');
  assert(Of(m, 1, 2).id === 'gray' && Of(m, 1, 2).hex === '#d6d7dc', 'gridColorOf 读不出来：' + JSON.stringify(Of(m, 1, 2)));
  assert(Of(m, 9, 9) === null && Of({ '1,2': '没这个色' }, 1, 2) === null, '没标记 / 坏色 id 该回 null（不编颜色）');
  // ③ 逐行数据带上颜色；没标记的就是 null
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 100, stepY: 50 });
  const rows = R(g, [{ col: 3, row: 5 }, { col: 0, row: 0 }], 'br', { '3,5': 'gray' });
  assert(rows[0].color === '#d6d7dc' && rows[0].colorName === '灰色', '第 1 行没带上颜色：' + JSON.stringify(rows[0]));
  assert(rows[1].color === null && rows[1].colorName === null, '没标记的行不该编颜色：' + JSON.stringify(rows[1]));
  // ④ ★ 导出的带色片段 = 作者给的那一串（**逐字节**）
  const one = Lua([{ ok: true, x: 330, y: 560, color: '#d6d7dc', colorName: '灰色' }]);
  assert(one === '[{x = 330, y = 560 ,color="#d6d7dc",colorName = "灰色"}]',
    '带色的导出片段与作者给的不一致：\n' + JSON.stringify(one));
  // 混着来：带色的与不带的都对
  const mix = Lua([
    { ok: true, x: 330, y: 560, color: '#d6d7dc', colorName: '灰色' },
    { ok: true, x: 840, y: 540 },
  ]);
  assert(mix === '[{x = 330, y = 560 ,color="#d6d7dc",colorName = "灰色"},\n{x = 840, y = 540 }]',
    '混合导出不对：\n' + JSON.stringify(mix));
  return '色板 8 色（首色=作者的灰）+ 切换/覆盖/清除 + 逐行带色 + **逐字节**导出';
});

check('★ 回归：右键标记**不许**把已选中的格踢出列表（作者报「点了一次之后就不让复制了」）', () => {
  const Add = clientExports.__testGridSelAdd;
  const Prune = clientExports.__testGridSelPrune;
  assert(typeof Add === 'function' && typeof Prune === 'function', '缺 gridSelAdd / gridSelPrune');
  // ① 只加不减：已选中的格再"加"一次 ⇒ **原样返回**（同一个引用，也还在里面）
  const sel1 = [{ col: 3, row: 5 }];
  const again = Add(sel1, 3, 5);
  assert(again === sel1, 'gridSelAdd 对已在列表里的格没有原样返回：' + JSON.stringify(again));
  assert(Add(sel1, 4, 5).length === 2, 'gridSelAdd 没加进去：' + JSON.stringify(Add(sel1, 4, 5)));
  assert(sel1.length === 1, 'gridSelAdd 改了入参');
  // ★ 这就是那个 bug 的形状：toggle 会把已选中的踢掉，add 不会
  assert(clientExports.__testGridSelToggle(sel1, 3, 5).length === 0, '（前提变了：toggle 现在不删了？）');
  assert(Add(sel1, 3, 5).length === 1, 'gridSelAdd 把已选中的格踢掉了 —— 正是那个 bug');
  // ② 失效行清理：只保留当前网格里还存在的
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const mixed = [{ col: 3, row: 3 }, { col: 15, row: 19 }, { col: 0, row: 0 }];
  const kept = Prune(g, mixed);
  assert(kept.length === 2 && kept[0].col === 3 && kept[1].col === 0, 'gridSelPrune 没清对：' + JSON.stringify(kept));
  assert(mixed.length === 3, 'gridSelPrune 改了入参');
  assert(Prune({ ok: false, error: 'X' }, mixed).length === 3, '参数不合法时不该乱清');
  // ③ 接线：右键必须走 gridSelAdd（走 toggle 就是那个 bug 复发）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  const ctx = src.slice(src.indexOf('var onGridContext'), src.indexOf('var onGridClick'));
  assert(/gridSelAdd\(cur, cell\.col, cell\.row\)/.test(ctx), '右键标记没走 gridSelAdd');
  assert(!/gridSelToggle\(cur, cell\.col, cell\.row\)/.test(ctx), '右键标记又用回了 toggle（会把已选中的踢出去）');
  // ④ 渲染层：既选中又标了色的格 ⇒ 列表还在、「复制全部」可点（"一直能复制"）
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { sel: [{ col: 3, row: 5 }], colors: { '3,5': 'gray' } } })));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"');
  assert(/选中的格（1）/.test(text), '选中 + 标记的那一格没留在列表里：' + (text.match(/选中的格[^ ]*/) || []));
  const allBtn = html.match(/<button[^>]*>复制全部（x,y 列表）<\/button>/);
  assert(allBtn && !/disabled/.test(allBtn[0]), '有有效选中时「复制全部」却是灰的');
  assert(!/移除失效行/.test(text), '没有失效行时不该出现「移除失效行」按钮');
  // ⑤ 步长改小留下失效行 ⇒ 出现「移除失效行（N）」，一键清掉（不清的话列表一直占着、也复制不了）
  const bad = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { stepX: 110, stepY: 80, sel: [{ col: 15, row: 19 }, { col: 3, row: 3 }] } })));
  const badText = bad.replace(/<[^>]+>/g, ' ');
  assert(/移除失效行（1）/.test(badText), '有失效行时没给「移除失效行」按钮：' + (badText.match(/移除失效行[^ ]*/) || []));
  assert(/选中的格（1）　⚠️ 1 个现在没有对应格/.test(badText), '失效行的提示不对：' + (badText.match(/选中的格[^取]*/) || []));
  return 'gridSelAdd（只加不减）+ gridSelPrune（清失效）+ 右键接线 + 选中且标色仍能复制 + 失效行一键清';
});

check('★ 网格图交互（渲染层 + 源码）：左键拖动平移 / 右键标记 / 色板 / 标记画在图上', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // ① 左键按住拖动 = 平移：mousedown 落在图上，位移超过 3px 才算拖，拖过就把随后那次 click 吃掉
  assert(/onMouseDown: onGridDown/.test(src), '网格图没挂 onMouseDown（拖不动）');
  assert(/Math\.abs\(dx\) \+ Math\.abs\(dy\) < 3/.test(src), '没有 3px 阈值（会把点击当成拖动）');
  assert(/suppressClick\.current = true/.test(src) && /if \(suppressClick\.current\) \{ suppressClick\.current = false; return; \}/.test(src),
    '拖完没有吃掉那次 click ⇒ 松手会顺手选/取消一格');
  // ⚠️ 每次按下必须清零：不然"拖到格子外面松手"会把标记留到下一次（下一次点击被白吃一次）
  assert(/suppressClick\.current = false;\s*\n\s*panRef\.current = \{ x: e\.clientX/.test(src),
    'mousedown 没有清零 suppressClick（拖到图外松手后，下一次点击会被白吃）');
  assert(/el\.scrollLeft = d\.sl - dx/.test(src) && /el\.scrollTop = d\.st - dy/.test(src), '平移没改滚动位置');
  assert(/cursor:grabbing/.test(styleNodes[0].textContent), '拖动时没有 grabbing 光标');
  // ② 右键 = 用当前笔刷标记（并且顺手选上，否则导出列表里看不到它）
  assert(/onContextMenu: onGridContext/.test(src), '网格图没挂 onContextMenu（右键标记无效）');
  assert(/e\.preventDefault\(\);\s*\n\s*var cell = cellAtEvent\(e\);/.test(src), '右键没阻止浏览器菜单 / 没取格');
  assert(/gridColorToggle\(cur, cell\.col, cell\.row, brush\)/.test(src), '右键没走 gridColorToggle');
  assert(/gridSelAdd\(cur, cell\.col, cell\.row\)/.test(src), '右键标记没走 gridSelAdd（只加不减）');
  // ③ 渲染层：色板 8 个方块 + 当前笔刷打勾；注入颜色与笔刷 ⇒ 图上画出色块、列表带上 color
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, base));
  assert((html.match(/dsh-miliastra-swatch[ "]/g) || []).length === 8, '色板方块数不对：' + (html.match(/dsh-miliastra-swatch[ "]/g) || []).length);
  assert(/dsh-miliastra-swatch-on/.test(html), '当前笔刷没标出来');
  assert(/右键标记：/.test(html.replace(/<[^>]+>/g, ' ')), '没有色板那一行（右键标记入口）');
  const marked = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { sel: [{ col: 3, row: 5 }], colors: { '3,5': 'gray' } } })));
  // ⚠️ React 会把正文里的 `"` 转义成 `&quot;` —— 比对文本前先还原（否则断言永远不匹配）
  const mText = marked.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  assert(/fill="#d6d7dc" fill-opacity="0.45"/.test(marked), '标记的格没画成色块：' + (marked.match(/fill="#[0-9a-f]{6}"/gi) || []).join(' '));
  assert(/1\. 格 \(3, 5\)　右下 \{x = 400, y = 300 ,color="#d6d7dc",colorName = "灰色"\}/.test(mText),
    '列表行没显示带色片段：' + mText.slice(mText.indexOf('1. 格'), mText.indexOf('1. 格') + 90));
  // ④ 颜色 / 笔刷都进缓存
  assert(/colors: colors, brush: brush/.test(src), '颜色 / 笔刷没有进缓存快照');
  return '平移(3px 阈值 + 吃掉 click + 滚动) + 右键标记并选上 + 色板 8 块 + 图上色块 + 列表带 color';
});

check('★ 多选列表与复制按钮（渲染层）：三行 + 四角下拉（默认右下）+ 「复制」「移除」「复制全部」「清空选择」', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { sel: [{ col: 8, row: 10 }, { col: 0, row: 0 }] } })));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(/选中的格（2）/.test(text), '没渲染出「选中的格（N）」：' + (text.match(/选中的格[^ ]*/) || []));
  // 默认角 = 右下：格 (8,10) 覆盖 x[800,900) y[500,550) ⇒ 右下 (900,550)
  assert(/1\. 格 \(8, 10\)　右下 \{x = 900, y = 550 \}/.test(text), '第 1 行不对：' + (text.match(/\d\. 格 \([^)]*\)[^ ]*/) || []));
  assert(/2\. 格 \(0, 0\)　右下 \{x = 100, y = 50 \}/.test(text), '第 2 行不对：' + (text.match(/\d\. 格 \([^)]*\)[^ ]*/g) || []));
  const copies = html.match(/<button[^>]*>复制<\/button>/g) || [];
  assert(copies.length === 2, '每行都该有一个「复制」（单独复制）：' + copies.length);
  assert((html.match(/>移除<\/button>/g) || []).length === 2, '每行都该有一个「移除」');
  assert(/复制全部（x,y 列表）/.test(text), '缺「复制全部」按钮');
  assert(/清空选择/.test(text), '缺「清空选择」按钮');
  // ★ 四角下拉：四个选项、默认选中「右下」
  const opts = html.match(/<option[^>]*>(左上|左下|右上|右下)<\/option>/g) || [];
  assert(opts.length === 4, '四角下拉应该有 4 个选项：' + JSON.stringify(opts));
  assert(/<select[^>]*>/.test(html), '没有下拉控件（四角选择）');
  assert(/<option value="br" selected="">右下<\/option>/.test(html), '四角下拉的默认不是「右下」：' + (html.match(/<option[^>]*>右下/) || []));
  // 切到左上 ⇒ 每一行的 x,y 都跟着换成左上（值真的跟着下拉走）
  const tl = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { sel: [{ col: 8, row: 10 }], anchor: 'tl' } })));
  const tlText = tl.replace(/<[^>]+>/g, ' ');
  assert(/1\. 格 \(8, 10\)　左上 \{x = 800, y = 500 \}/.test(tlText), '切到左上后行没跟着变：' + (tlText.match(/\d\. 格 \([^)]*\)[^ ]*/) || []));
  assert(/<option value="tl" selected="">左上<\/option>/.test(tl), '下拉没停在「左上」');
  // 选中集合里那几格的标签要变成亮粉加粗（多选高亮）
  assert((html.match(/fill="#ffd6ec" font-weight="700"/g) || []).length === 2, '选中的两格没都变成亮粉加粗');
  // 空选中：两个按钮都禁用，且不渲染列表
  const empty = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { sel: [] } })));
  assert(/选中的格（0）/.test(empty.replace(/<[^>]+>/g, ' ')), '空选中没显示（0）');
  const allBtn = empty.match(/<button[^>]*>复制全部（x,y 列表）<\/button>/);
  assert(allBtn && /disabled/.test(allBtn[0]), '空选中时「复制全部」该禁用:' + (allBtn || [])[0]);
  return '2 行 + 四角下拉（默认右下 / 切换生效）+ 复制·移除·复制全部·清空 + 选中标签亮粉';
});

check('★ 网格图缩放：**Ctrl+滚轮**才缩放（普通滚轮只滚动）+ 原生非 passive + 夹取 0.5~8 + 读数 / 复位', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // ① 必须用原生 addEventListener + passive:false（React 的 onWheel 是 passive，preventDefault 不生效）
  assert(/addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(src),
    '滚轮没走原生非 passive 监听 ⇒ 面板会跟着一起滚');
  assert(!/onWheel:/.test(src), '还挂着 React 的 onWheel（passive，preventDefault 无效）');
  assert(/el\.removeEventListener\('wheel', onWheel\)/.test(src), '滚轮监听没有清理（重挂会叠加）');
  // ①b ★ 普通滚轮**不缩放**（作者 2026-10-01：「这个滚轮咋把网格图也搞小了」—— 滚轮陷阱）
  //     只有 Ctrl/⌘ 按住才缩放；不按住就直接 return（**不 preventDefault**，交给浏览器滚）
  assert(/if \(!e\.ctrlKey && !e\.metaKey\) return;/.test(src),
    '普通滚轮还会缩放 ⇒ 想滚面板时光标停图上就把图缩了（滚轮陷阱）');
  const wheelBody = src.slice(src.indexOf('var onWheel = function (e) {'), src.indexOf("el.addEventListener('wheel', onWheel"));
  assert(wheelBody.indexOf('if (!e.ctrlKey && !e.metaKey) return;') < wheelBody.indexOf('e.preventDefault();'),
    'Ctrl 判断必须在 preventDefault 之前（否则普通滚轮也被吃掉）');
  // ② 缩放范围夹取 + 步进（垃圾值 ⇒ 回 100%，不是夹到最小 —— 存的数坏了就该当没存过）
  const C = clientExports.__testGridZoomClamp;
  assert(typeof C === 'function', '缺 gridZoomClamp');
  assert(C(1.12) === 1.12 && C(0.01) === 0.5 && C(99) === 8, '夹取不对：' + [C(1.12), C(0.01), C(99)].join(' / '));
  assert(C(0.29) === 0.5, '老版本存下的 29% 没被收进新范围（一打开就是一条小带）：' + C(0.29));
  assert(C('abc') === 1 && C(-3) === 1 && C(0) === 1, '非法输入没兜成 100%：' + [C('abc'), C(-3), C(0)].join(' / '));
  // ②b 读缓存时也要过夹取（否则老值直接进 state）
  assert(/return gridZoomClamp\(init\.zoom != null \? init\.zoom : saved\.zoom\)/.test(src),
    '读取缓存的 zoom 没夹取（老的 29% 会原样进来）');
  // ③ 只缩图：svg 的宽度走 inline（zoom%），盒子自己滚
  assert(/className: PLUGIN \+ '-gridsvg'/.test(src) && /style: \{ width: \(Math\.round\(zoom \* 10000\) \/ 100\) \+ '%' \}/.test(src),
    '缩放没有落到网格图自己的宽度上');
  const css = styleNodes[0].textContent;
  assert(/dsh-miliastra-gridbox\{[^}]*overflow:auto/.test(css), '网格图没有独立滚动盒子（放大后没法平移）');
  assert(/dsh-miliastra-gridbox\{[^}]*max-height:min\(420px,52vh\)/.test(css), '滚动盒子没有高度上限（放大后会把面板撑长）');
  // ④ 渲染层：默认 100% 读数 + 点一下回 100%（读数是按钮，面板里看得见）+ 标题里写明 Ctrl
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, base));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert(/缩放 100%/.test(text), '没有缩放读数');
  assert(/dsh-miliastra-gridbox/.test(html), '网格图没包在滚动盒子里');
  assert(/Ctrl\+滚轮缩放/.test(text), '标题里没写清"Ctrl+滚轮缩放"（人会以为是直接滚轮）');
  assert(/按住 Ctrl（Mac：⌘）在图滚滚轮 = 缩放/.test(html), '缩放按钮的提示没写清 Ctrl');
  // 注入 200% ⇒ 读数与宽度都跟着变（说明它真的把这个值用在图上了）
  const zoomed = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { zoom: 2 } })));
  assert(/缩放 200%/.test(zoomed.replace(/<[^>]+>/g, ' ')), '缩放读数没跟着 zoom 走');
  assert(/style="width:200%"/.test(zoomed), '网格图宽度没跟着 zoom 走：' + (zoomed.match(/width:\d+%/) || []));
  // ④b 注入老值 29% ⇒ 渲染出来是 50%（下限），不是 29%
  const stale = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    Object.assign({}, base, { __gridInit: { zoom: 0.29 } })));
  assert(/缩放 50%/.test(stale.replace(/<[^>]+>/g, ' ')), '老的 29% 没被抬到下限 50%：'
    + (stale.replace(/<[^>]+>/g, ' ').match(/缩放 \d+%/) || []));
  // ⑤ 缩放与四角都记住
  assert(/anchor: anchor, zoom: zoom/.test(src), '缩放 / 四角没有进缓存快照');
  return 'Ctrl+滚轮才缩放（普通滚轮不缩放）+ 夹取 0.5~8（含老值收编）+ 只缩图 + 读数与复位 + 都进缓存';
});

check('★ 面板：常驻（点外面不关）+ 尺寸回到 880×600 + 开合/常驻都记住', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, base));
  const text = html.replace(/<[^>]+>/g, ' ');
  // ① 头部有常驻开关，且**默认就是常驻**
  assert(/📌 常驻/.test(text), '头部没有「常驻」按钮：' + (text.match(/📌[^ ]*/) || []));
  assert(/dsh-miliastra-pin-on/.test(html), '默认不是常驻（作者要"一直展示在旁边，点外面别关"）');
  // ② 官方 hook 的**开关位**必须真的被用上（否则"常驻"是个装饰）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  assert(/useDismissOnOutsidePointer\(rootRef, open && !pinned, setOpen\)/.test(src),
    '常驻没有接到 useDismissOnOutsidePointer 的开关位（按钮会是个装饰）');
  assert((src.match(/useDismissOnOutsidePointer\(/g) || []).length === 1,
    'useDismissOnOutsidePointer 只能有一处调用（条件调用会被 react-hooks 规则拦）');
  // ③ 尺寸回到原样：880×600（作者 2026-10-01：「还是改回原来的大小其他不变」）
  const css = styleNodes[0].textContent;
  assert(/dsh-miliastra-panel\{[^}]*width:min\(880px,94vw\)/.test(css), '面板宽度没回到 880px');
  assert(/dsh-miliastra-panel\{[^}]*height:min\(600px,82vh\)/.test(css), '面板高度没回到 600px');
  assert(/dsh-miliastra-panel\{[^}]*min-width:420px/.test(css), '拖拽缩小的下限该回到 420×340');
  // ④ 开合与常驻**都写盘记住**（不然刷新就丢）
  assert(/panelPrefSet\(PANEL_OPEN_KEY, open\)/.test(src), '开合状态没有记住');
  assert(/panelPrefSet\(PANEL_PIN_KEY, pinned\)/.test(src), '常驻开关没有记住');
  assert(/panelPref\(PANEL_OPEN_KEY, false\)/.test(src), '首次仍该是**关闭**态（作者早先"不该一上来就糊一层"）');
  assert(/panelPref\(PANEL_PIN_KEY, true\)/.test(src), '常驻的默认值该是**开**');
  return '默认常驻 + 接到 hook 开关位 + 回到 880×600 + 两个开关都记住（首次仍不自动弹）';
});

check('★ 面板可以拖拉（按住头部挪位置 / 双击回原位 / 位置记住）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // ① 头部真的挂了拖动handler（挂在头部而不是整块面板 —— 否则拖内容也会把面板拽走）
  assert(/className: PLUGIN \+ '-head', key: 'head',\s*\n\s*onMouseDown: onHeadDown, onDoubleClick: onHeadDouble/.test(src),
    '头部没挂 onMouseDown / onDoubleClick（拖不动）');
  // ② 拖的是位置：拖过之后用 left/top，且必须把 bottom 让开（同时给会拉成"从 top 到 bottom"）
  assert(/anchorStyle = \{ left: dragPos\.left, top: dragPos\.top, bottom: 'auto' \}/.test(src),
    '拖动后没切到 left/top（或没让开 bottom）');
  // ③ 位置记住 + 双击清掉
  assert(/PANEL_POS_KEY = 'dsh-miliastra:panel-pos'/.test(src), '位置没有自己的存储键');
  assert(/storeSet\(PANEL_POS_KEY, dragPos\)/.test(src), '拖动后没把位置存下来');
  assert(/storeSet\(PANEL_POS_KEY, null\)/.test(src), '双击没清掉记住的位置');
  // ④ 拖出屏幕也要留得下（不然面板和它的 × 一起找不回来了）
  assert(/Math\.max\(-\(w - 60\), Math\.min\(window\.innerWidth - 60/.test(src), '拖动没有"至少留 60px 在屏幕里"的夹取');
  assert(/Math\.max\(0, Math\.min\(window\.innerHeight - 32/.test(src), '纵向拖动没有夹取（会拖到标题栏上面去）');
  // ⑤ 头部光标 + 拖起来不选字
  const css = styleNodes[0].textContent;
  assert(/dsh-miliastra-head\{[^}]*cursor:move/.test(css), '头部没有 cursor:move（看不出能拖）');
  assert(/dsh-miliastra-dragging\{[^}]*user-select:none/.test(css), '拖动时没有禁用选字（会拉出一片蓝）');
  assert(/dsh-miliastra-head button[^{]*\{[^}]*cursor:pointer/.test(css), '头部的按钮没有恢复普通光标（看起来像能拖）');
  // ⑥ 视图模式（inline）不参与拖 —— 它是铺满会话区的，没有"挪位置"这回事
  assert(/if \(inline\) return;\s*\n\s*try \{/.test(src), 'inline 视图没有短路（会在会话区里拖出一层浮层）');
  return '头部拖动 + left/top 切换 + 位置记住 + 双击回原位 + 不拖出屏幕 + inline 短路';
});

check('★ tab 条：七等分，第七档是「节点图」', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'basic' })));
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const label of ['初级功能', '高级功能', '模拟器', '预制效果', '像素画', '网格计算', '节点图']) {
    assert(text.includes(label), 'tab 条缺这一档：' + label);
  }
  const btns = html.match(/dsh-miliastra-vtab[ "]/g) || [];
  assert(btns.length === 7, '切换按钮应该是 7 个（含选中态）：' + btns.length);
  const css = styleNodes[0].textContent;
  assert(/dsh-miliastra-viewtabs\{[^}]*repeat\(7,/.test(css), 'tab 条不是七等分（repeat(7,…)）');
  assert(/dsh-miliastra-gridsvg\{[^}]*width:100%/.test(css), '网格图没有自适应宽度 —— 点图取坐标的线性换算就失真了');
  assert(Array.isArray(clientExports.__testGridPresets) && clientExports.__testGridPresets.length >= 2, '缺预设按钮表');
  const labels = clientExports.__testGridPresets.map((p) => p.label).join(' | ');
  assert(/X100\/Y50/.test(labels), '预设里没有推荐的 X100/Y50：' + labels);
  assert(/X110\/Y80/.test(labels), '预设里没有作者那个"除不尽"的例子：' + labels);
  // 「点图取坐标」不许把 y 翻转（设计画布是 y 向下；左下原点那套是引擎内部舞台，别混用）
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  assert(/e\.clientY - r\.top/.test(src), '网格图的取点没按"y 向下"算（应该是 clientY - rect.top）');
  assert(!/r\.bottom - e\.clientY/.test(src), '网格图里混进了引擎那套"左下原点"的翻转写法（两套坐标系不许混用）');
  return '7 档 + repeat(7) + 预设 + 取点不翻转';
});

check('★ 第七页「节点图」：左侧手风琴（就地展开、一次开一个）+ 右侧只放"再下一层"', () => {
  const base = { open: true, setOpen: () => {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, Object.assign({}, base, { __panelTab: 'nodes' })));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  assert(/点标题展开，一次开一个/.test(text), '缺第七页标题（含"一次开一个"说明）');
  for (const b of ['节点图', '实体', '元件', '节点声明', '配置条目 / 阵营 / 资源分类']) {
    assert(text.includes(b), '缺分组标题：' + b);
  }
  assert(/重新读一次/.test(text), '缺「重新读一次」');
  assert(/全部收起/.test(text), '缺「全部收起」');
  // 默认全收起：只出现 ▸，不该出现 ▾
  assert(text.includes('▸'), '分组默认收起时应有 ▸ 指示');
  assert(!/▾/.test(text), '默认应当是**收起**（不该出现 ▾）');
  // ★ 手风琴：点标题就地展开（同一栏），一次只开一个 —— 这就是作者要的"少一层级"
  assert(/setSel\(sel === key \? '' : key\)/.test(src), '不是手风琴（没有"开一个就收另一个"的语义）');
  assert(/open \? React\.createElement\('div', \{\s*style: \{ maxHeight: '42vh'/.test(src), '展开的数据体没有就地渲染（或没做内部滚动）');
  // 右侧只放"再下一层"（点实体看变量），不再是"左侧列表 → 右侧数据"
  assert(/这一层放/.test(text) && /再往下钻/.test(text), '右侧没有说明它是"再下一层"');
  // 只读 + 走工具
  assert(/callTool\('miliastra_map', \{ op: 'nodes', kind: 'all' \}\)/.test(src), '面板没走 miliastra_map op=nodes kind=all');
  assert(/callTool\('miliastra_map', \{ op: 'nodes', entity: name \}\)/.test(src), '点实体没去读它的自定义变量');
  const pane = src.slice(src.indexOf('exports.__nodesPane = function NodesPane'), src.indexOf('var NodesPane = exports.__nodesPane'));
  assert(pane.length > 400, '取不到 NodesPane 源码片段（锚点变了就更新这条断言）');
  for (const bad of ["'miliastra_code'", "'miliastra_sim'", 'writeFile', 'deploy']) {
    assert(pane.indexOf(bad) < 0, '节点图那页出现了写/模拟器调用：' + bad);
  }
  assert(/粗略数字/.test(text), '页面没说明节点数/连线数是粗略数字');
  assert(/var labelOf = function/.test(src), '实体没有按标签分组的逻辑');
  assert(/kindLabelSource/.test(src), '实体行没写出处');
  return '手风琴（一次开一个、就地 42vh 内滚）+ 右侧下一层';
});

/*
 * ★ 第七页第 2 步（图 → 节点 → 引脚/连线）——**面板**这一层。
 * 五条：① 接线（点图名就地展开 / 点节点走右栏）②③④ 三个纯函数的判据（合成数据）
 *      ⑤ 拿**真 .gil** 喂同一批判据（环境里没有就如实跳过，不伪装通过）。
 */
const nodesPaneSource = () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  return {
    src,
    pane: src.slice(src.indexOf('exports.__nodesPane = function NodesPane'), src.indexOf('var NodesPane = exports.__nodesPane')),
  };
};

check('★ 第 2 步 ①：点图名 ⇒ 就地展开节点表（左栏、自带内滚）+ 点节点 ⇒ 右栏引脚与连线', () => {
  const { src, pane } = nodesPaneSource();
  assert(pane.length > 800, '取不到 NodesPane 源码片段（锚点变了就更新这条断言）');
  // 图名 → 节点表：走 miliastra_map op=nodes graph=…（只读）
  assert(/callTool\('miliastra_map', \{ op: 'nodes', graph: name \}\)/.test(pane), '点图名没去读这张图的节点明细');
  assert(/var openGraphBody = function/.test(pane), '缺"就地展开的节点表"（openGraphBody）');
  assert(/maxHeight: '30vh', overflowY: 'auto'/.test(pane), '展开的节点表没有自己的内滚（会把左栏撑爆）');
  assert(/nodes\.length > NODE_ROW_CAP/.test(pane), '节点表没有"超过上限就明说没列全"');
  // 节点行：官方名字 + 坐标 / 引脚数 / 出边数
  assert(/nodesNodeLabel\(nd\)/.test(pane) && /nodesNodeMeta\(nd\)/.test(pane), '节点行没写官方名字/坐标/引脚/出边');
  // 节点 → 引脚与连线：右栏（并给回左边的路）
  assert(/var openNode = function/.test(pane), '缺"点节点"的入口');
  assert(/var pinLines = nodesPinLines\(/.test(pane), '右栏没有把引脚与连线排出来');
  assert(/回到节点表|回左边的节点表/.test(src), '右栏没有回节点表的路');
  // 判据只有一份：纯函数必须导出去给测试用
  for (const k of ['__testNodesPickKey', '__testNodesNodeLabel', '__testNodesNodeMeta', '__testNodesEdgesOf',
    '__testNodesPinLines', '__testNodesRefLines', '__testNodesGraphFacts']) {
    assert(typeof clientExports[k] === 'function', '缺纯函数导出：' + k);
  }
  // 只读：这一页不许出现写路径 / 模拟器
  for (const bad of ["'miliastra_code'", "'miliastra_sim'", 'writeFile', 'deploy']) {
    assert(pane.indexOf(bad) < 0, '节点图那页出现了写/模拟器调用：' + bad);
  }
  return '就地展开(30vh) + 节点行 + 右栏引脚与连线 + 7 个纯函数导出 + 零写路径';
});

check('★ 第 2 步 ②：节点名 / 坐标 / 出边 —— 命中给官方名、没命中如实说未知（合成数据）', () => {
  const L = clientExports.__testNodesNodeLabel;
  assert(L({ doc: { zh: '命中检测触发时' }, docId: 253 }) === '命中检测触发时', '命中词典时没用官方名字');
  assert(L({ doc: null, docId: 999 }) === '未知节点 999', '没命中时没如实说未知：' + L({ doc: null, docId: 999 }));
  assert(/未命名节点/.test(L({ doc: null, docId: null })), '连 runtimeId 都没有时没说清');
  const M = clientExports.__testNodesNodeMeta;
  const meta = M({ x: -156.00000572, y: -78, pinCount: 1, outEdges: [{ from: 1, to: 2 }], doc: { system: 'Server', domain: 'Trigger' } });
  assert(/\(-156, -78\)/.test(meta), '坐标没去掉 float32 尾巴：' + meta);
  assert(/引脚 1/.test(meta) && /出边 1/.test(meta) && /Server \/ Trigger/.test(meta), '行说明缺项：' + meta);
  assert(!/undefined|NaN/.test(M({})), '空节点也印出了 undefined/NaN：' + M({}));
  // 出边：优先回执的 outEdges；旧版 Host 只回 pins 时**现推**（同一条判据：引脚字段 5 的字段 1）
  const E = clientExports.__testNodesEdgesOf;
  const withOut = E({ index: 1, outEdges: [{ from: 1, to: 7 }], pins: [{ conns: [{ to: 9 }] }] });
  assert(withOut.length === 1 && withOut[0].to === 7, '有 outEdges 时没优先用它');
  const derived = E({ index: 5, pins: [{ kindShell: 2, conns: [{ to: 8, toShell: 1, toKernel: 1 }] }, { kindShell: 3, conns: [] }] });
  assert(derived.length === 1 && derived[0].from === 5 && derived[0].to === 8 && derived[0].fromPinKind === 2,
    '从 pins 现推的边不对：' + JSON.stringify(derived));
  assert(E({}).length === 0 && E(null).length === 0, '空节点应回空数组');
  return '官方名/未知/无号 + 坐标 1 位小数 + 出边两种来源';
});

check('★ 第 2 步 ③：引脚与连线逐行（谁连谁）—— kind 号只印号、不编名字', () => {
  const P = clientExports.__testNodesPinLines;
  const at = (i) => '#' + i + '（目标图元）';
  const lines = P({ pinCount: 2, pins: [
    { kindShell: 2, kindKernel: 2, conns: [{ to: 7, toShell: 1, toKernel: 1 }, { to: 9, toShell: 2, toKernel: 2 }] },
    { kindShell: 3, kindKernel: 3, valueRef: 42, conns: [] },
  ] }, at);
  const all = lines.join('\n');
  assert(/引脚 0　kindShell=2 \/ kindKernel=2/.test(all), '引脚头不对：' + all);
  assert(/→ 节点 #7（目标图元）　脚 shell=1 \/ kernel=1/.test(all), '连线目标没写成人能读的：' + all);
  assert(/→ 节点 #9（目标图元）/.test(all), '一个引脚连多个目标时没全列出来');
  assert(/（这个引脚没有连接记录）/.test(all), '没有连接的引脚没如实说');
  assert(/值引用 42/.test(all), '引脚值引用没印出来');
  assert(/未确证/.test(all), '"kind 号的名字未确证"这件事没说');
  assert(!/undefined|NaN/.test(all), '引脚行里出现了 undefined/NaN');
  const none = P({ pinCount: 0, pins: [] }, at);
  assert(none.length === 1 && /没有引脚实例记录/.test(none[0]), '零引脚没说清（不是留白）');
  // 引用行：Host 翻不出名字时**原样给号**，不猜
  const R = clientExports.__testNodesRefLines;
  assert(R({ refs: [{ id: 1073741845, what: '实体「关卡实体」' }] })[0] === '1073741845 → 实体「关卡实体」', '引用行不对');
  assert(/都没命中/.test(R({ refs: [{ id: 5, what: null }] })[0]), '翻不出来的号没有如实说');
  assert(R({}).length === 0 && R(null).length === 0, '没有引用时不该给行');
  return '引脚头 + 多目标 + 空连接 + 值引用 + 零引脚 + 引用行';
});

check('★ 第 2 步 ④：图级小计（只报数字）+ 回执取图（全等优先、退化、空回执）', () => {
  const F = clientExports.__testNodesGraphFacts;
  const f = F([{ doc: { zh: 'a' }, x: 0, y: 0, outEdges: [{ to: 2 }] }, { doc: null, x: null, y: null, pins: [] }], null);
  assert(f.nodeCount === 2 && f.namedCount === 1 && f.xyCount === 1 && f.edgeCount === 1, '小计算错了：' + JSON.stringify(f));
  assert(/官方名字命中 1\/2/.test(f.summary) && /有坐标 1/.test(f.summary) && /出边 1/.test(f.summary), '小结行不对：' + f.summary);
  assert(!/\bpass\b|reachable|verdict/i.test(f.summary), '小结里出现了判决词（只报数字，不下判决）');
  const K = clientExports.__testNodesPickKey;
  assert(K({ '甲': [], '乙': [] }, '乙') === '乙', '全等没优先');
  assert(K({ '甲': [], '乙': [] }, '不存在的') === '甲', '退化取第一个的逻辑不对');
  assert(K({}, 'x') === null && K(null, 'x') === null, '空回执应回 null');
  return '小计 + 全等优先 + 退化 + 空回执';
});

check('★ 第 2 步 ⑤：拿**真 .gil** 喂同一批判据（没有 .gil 就如实跳过）', () => {  const all = scanLevels().filter((l) => l.gil && l.gil.path);
  if (!all.length) return '环境里没有 .gil ⇒ 如实跳过（不伪装通过）';
  // 优先用「当前关卡」（与面板/工具同一条口径），没有就退化成最大的那份
  const lv = all.find((l) => l.levelId === ((pickCurrent(all) || {}).levelId))
    || all.slice().sort((a, b) => (b.gil.size || 0) - (a.gil.size || 0))[0];
  const facts = readGilNodeFacts(lv.gil.path, {});
  const names = Object.keys(facts.graphNodeLists || {});
  if (!names.length) return '这份 .gil（' + lv.levelId + '）里没有节点图 ⇒ 跳过';
  const big = names.slice().sort((a, b) => facts.graphNodeLists[b].length - facts.graphNodeLists[a].length)[0];
  const nodes = facts.graphNodeLists[big];
  const edges = nodes.flatMap((n) => n.outEdges || []);
  const g = clientExports.__testNodesGraphFacts(nodes, edges);
  assert(g.nodeCount === nodes.length, '节点数对不上');
  assert(g.edgeCount === edges.length, '出边数对不上（真数据）');
  const idx = new Map(nodes.map((n) => [n.index, n]));
  for (const nd of nodes) {
    const label = clientExports.__testNodesNodeLabel(nd);
    const meta = clientExports.__testNodesNodeMeta(nd);
    assert(label && !/undefined|NaN/.test(label), '节点名坏了：' + label);
    assert(!/undefined|NaN/.test(meta), '节点行坏了：' + meta);
  }
  const withPins = nodes.find((n) => (n.pinCount || 0) > 0);
  let targetOk = 0; let targetMiss = 0;
  if (withPins) {
    const lines = clientExports.__testNodesPinLines(withPins, (i) => (idx.has(i) ? '#' + i + '（' + clientExports.__testNodesNodeLabel(idx.get(i)) + '）' : '#' + i + '（不在本图节点表里）'));
    assert(lines.length >= withPins.pinCount, '引脚行数少于引脚数：' + lines.length + ' < ' + withPins.pinCount);
    assert(!/undefined|NaN/.test(lines.join('\n')), '引脚行里有 undefined/NaN（真数据）');
    for (const e of clientExports.__testNodesEdgesOf(withPins)) { if (idx.has(e.to)) targetOk += 1; else targetMiss += 1; }
  }
  // ★ 真数据也要**过一遍 React**：把"真 .gil 的图 + 节点"当注入口喂进面板，SSR 真渲染一次。
  //   （合成数据那两条只能证明"形状对"；这一条证明**真的这份回执**画得出来。）
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'nodes',
    __nodesInit: {
      facts,
      sel: 'graphs',
      gView: { name: big, loading: false, nodes, edges },
      nodeView: withPins ? { graphName: big, node: withPins } : null,
    },
  }));
  const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(txt.includes('官方名字命中'), '真数据渲染出来没有节点表小计');
  assert(!/undefined|NaN/.test(txt), '真数据渲染结果里出现了 undefined/NaN');
  if (withPins) assert(/引脚与连线/.test(txt) && /kindShell=/.test(txt), '真数据的右栏引脚与连线没画出来');
  return lv.levelId + ' 的「' + big + '」' + nodes.length + ' 节点 / ' + edges.length + ' 出边'
    + '（真渲染 OK）'
    + (withPins ? '（首节点出边目标命中本图 ' + targetOk + ' / 不在本图 ' + targetMiss + '）' : '');
});

/*
 * ★ 第 2 步 ⑥：把**展开后的两层真渲染一遍**（SSR）。
 * 为什么必须做：这一页的数据是异步取的，前面几条只能渲染"还没读到"的首帧 ⇒ **画得出来画不出来根本没断到**。
 * 注入口是 `__nodesInit`（与第六页 `__gridInit` 同一个套路），喂的是**面板真正会拿到的那种对象形状**。
 */
const SYNTH_FACTS = {
  graphCount: 1, graphCountText: '1',
  kinds: [{ typeCode: 20000, typeLabel: '关卡实体图', count: 1, nodeTotal: 2, names: ['甲图'] }],
  graphs: [{ name: '甲图', id: 1073741825, idRange: '服务端', typeCode: 20000, typeLabel: '关卡实体图', kindCode: 21001, nodeCount: 2, linkCount: 1, hasBody: true }],
  entities: [], entityCount: 0, totalVariables: 0, entityKindCodes: [], entityKindLabels: {}, entityKindLabelsUnverified: [],
  components: [], componentCount: 0,
  declarations: [], declarationCount: 0, compositeCount: 0, declarationStats: { withLabels: 0, withNotes: 0 },
  configs: [], configCount: 0, configLinked: [], semanticMeaningful: [],
  factions: [], spawns: [], presets: [], resourceCategories: [], resourceTree: [], semantics: [],
  signalRefCount: 0, signalWords: [], signalRefs: [],
  brief: '（合成样本：只为渲染用）', unverified: [],
};
const SYNTH_NODES = [
  {
    index: 1, docId: 75, doc: { zh: '以GUID查询实体', en: 'Query Entity By GUID', identifier: 'X', system: 'Server', domain: 'Query', pins: 6 },
    x: -156.5, y: -78.25, pinCount: 1,
    pins: [{ kindShell: 2, kindKernel: 2, conns: [{ to: 2, toShell: 1, toKernel: 1 }], valueRef: null }],
    outEdges: [{ from: 1, to: 2, toShell: 1, toKernel: 1, fromPinKind: 2 }],
    refs: [{ id: 1073741845, what: '实体「关卡实体」' }], label: '以GUID查询实体',
  },
  { index: 2, docId: 999999, doc: null, x: 0, y: 0, pinCount: 0, pins: [], outEdges: [], refs: [], label: '未知节点 999999' },
];

check('★ 第 2 步 ⑥（渲染）：展开的节点表真画得出来（图名 / 小计 / 每行的名字·坐标·引脚·出边）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'nodes',
    __nodesInit: { facts: SYNTH_FACTS, sel: 'graphs', gView: { name: '甲图', loading: false, nodes: SYNTH_NODES, edges: SYNTH_NODES[0].outEdges } },
  }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(/▾ 甲图/.test(text), '图名没有展开态（▾）—— 就地展开没生效：' + text.slice(0, 200));
  assert(text.includes('节点 2 · 官方名字命中 1/2 · 有坐标 2 · 出边 1（粗略数字）'), '节点表小计不对');
  assert(text.includes('#1 以GUID查询实体') || text.includes('#1　以GUID查询实体'), '节点表没画出节点名');
  assert(text.includes('#2 未知节点 999999') || text.includes('#2　未知节点 999999'), '词典没命中的节点没如实写未知');
  assert(/\(-156\.5, -78\.[0-9]\)/.test(text), '节点行没画坐标：' + text.slice(text.indexOf('#1'), text.indexOf('#1') + 160));
  assert(/引脚 1 · 出边 1/.test(text), '节点行没画引脚/出边数');
  assert(!/undefined|NaN/.test(text), '渲染结果里出现了 undefined/NaN');
  return '展开态 ▾ + 小计 + 两行节点（含未命中）';
});

check('★ 第 2 步 ⑥（渲染）：右栏的引脚与连线真画得出来（谁连谁 + 引用 + 回退按钮）', () => {
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel, {
    open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'nodes',
    __nodesInit: {
      facts: SYNTH_FACTS, sel: 'graphs',
      gView: { name: '甲图', loading: false, nodes: SYNTH_NODES, edges: SYNTH_NODES[0].outEdges },
      nodeView: { graphName: '甲图', node: SYNTH_NODES[0] },
    },
  }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert(text.includes('引脚与连线 · 1 个引脚实例'), '右栏没画"引脚与连线"这一节');
  assert(/引脚 0\s+kindShell=2 \/ kindKernel=2/.test(text), '右栏没画引脚头：' + text.slice(text.indexOf('引脚与连线') - 20, text.indexOf('引脚与连线') + 200));
  assert(/→ 节点 #2（未知节点 999999）/.test(text), '右栏没把连线目标写成人能读的（#2 未知节点 999999）');
  assert(/kind 号的名字未确证/.test(text), '右栏没写明 kind 号↔名字未确证');
  assert(text.includes('引用到的对象 · 1 个') && text.includes('1073741845 → 实体「关卡实体」'), '右栏没画引用行');
  assert(/回到?节点表|回左边的节点表/.test(text), '右栏没有回节点表的路');
  assert(text.includes('属于图「甲图」'), '右栏没写它属于哪张图');
  // 右栏此时应当**已经被最深那一层占住**（不该还挂着"这里以后放什么"的空壳说明）
  assert(!/再往下钻/.test(text), '右栏还挂着空壳说明（最深那一层没顶掉它）');
  return '引脚头 + 谁连谁 + 引用 + 未确证声明 + 回退按钮';
});

check('网格页文案：不许有 Markdown 记号（面板不渲染 Markdown），且复制正文自洽', () => {
  const g = clientExports.__testGridPlan({ width: 1600, height: 1000, stepX: 110, stepY: 80 });
  const p = clientExports.__testGridPixelToCell(g, 1550, 500);
  const c = clientExports.__testGridCellToPixel(g, 8, 5);
  const texts = clientExports.__testGridSummaryLines(g).concat([p.note, c.note]);
  for (const t of texts) {
    assert(!/\*\*/.test(t) && !/`/.test(t), '网格文案里混进了 Markdown 记号（会原样显示）：' + t);
  }
  // 渲染出来的整页也不许有（面板不认识 Markdown）
  const html = renderToStaticMarkup(React.createElement(clientExports.__testPanel,
    { open: true, setOpen: () => {}, rootRef: { current: null }, __panelTab: 'grid' }));
  const text = html.replace(/<[^>]+>/g, ' ');
  const gridBlock = text.slice(text.indexOf('画布与步长'), text.indexOf('网格图（点一下取坐标）'));
  const stars = gridBlock.match(/\*\*[^*]{1,40}\*\*/g);
  assert(!stars, '网格页渲染出来的文案里有 Markdown 记号：' + (stars || []).join(' | '));
  assert(!/`/.test(gridBlock), '网格页渲染出来的文案里有反引号');
  // 一键复制的正文：参数 + 结论 + 当前两个换算
  const copy = clientExports.__testGridCopyText(g, p, c);
  assert(/网格计算（画布 1600 × 1000，步长 X 110 \/ Y 80）/.test(copy), '复制正文没带参数：' + copy.split('\n')[0]);
  assert(/残 60px/.test(copy) && /界外不算/.test(copy), '复制正文没带结论：' + copy);
  assert(/格 \(8, 5\)/.test(copy) && /第 15 格位置上/.test(copy), '复制正文没带当前两个换算：' + copy);
  return '结论/换算/整页都无 Markdown 记号；复制正文 7 行自洽';
});

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
