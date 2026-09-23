/**
 * dsh-miliastra — DSH 插件 · Client half
 *
 * 一个侧边栏入口（注册到官方槽位 `sidebar.footer.action`）+ 一个**三栏**状态浮层面板。
 * 面板数据全部走 Host 半边的同源路由 `/miliastra/*`（唯一合法通道）。
 *
 * 契约（2026-09-23 取证自本机 dsh 0.1.5-rc.1）：
 *   · `sidebar.footer.action` = kind `list` / scope `root`，owner props 只有 `{ wide: boolean }`
 *   · 注册写法与官方 `dsh-client-ui-cordis` 的 `CordisPanel` 一致（它是该槽位的真实占用者）
 *   · 锚点：`{ left: rect.left, bottom: innerHeight - rect.top + 8 }`，面板自身 `position: fixed` 向上展开
 *   · 点外关闭用 primitives 的 `useDismissOnOutsidePointer`，**不要自己写 document 监听**
 *
 * 视觉：**粉蓝主调**（浅蓝 ↔ 粉红渐变），结构参考蛋仔面板（dsh-eggy）——
 *       三栏网格 `.body{grid-template-columns:repeat(3,…)}` + `.col` 各自独立滚动 +
 *       sec 卡片 / kv 网格 / dot 状态点 / 渐变主按钮 / 自定义滚动条。
 *       入口图标是内联 PNG（像素画，`image-rendering: pixelated` 保持锐利）。
 *
 * 三栏分工：① 关卡（在哪张图）② 代码（改了什么、备份、部署）③ 日志（跑了什么）。
 *
 * 四条纪律（都是实测踩出来的）：
 *   ① **声明了才敢访问**：`exports.inject = ['slots']`。cordis 的服务代理受限，
 *      不声明就读 `ctx.slots` 会抛 `cannot get property "slots" without inject`，
 *      **并让整条 loader entry 失败**（症状：宿主报 failed to apply，页面上一条我们的日志都没有）。
 *   ② **绝不 throw**：Client 半边抛错会让整个 Web 壳启动失败。所有入口（**包括诊断日志**）都包 try/catch。
 *   ③ **信封有三层**，别少剥一层：`body{ok,data:{name,ok,data:<业务返回体>}}`。
 *   ④ **主题令牌一律带 fallback**：令牌是运行时注入的，缺了不该变成一片透明或纯黑。
 */
(function () {
  // 这几条日志是**刻意的**：client 半边的失败默认是全静默的（没入口、没报错），
  // 排障时最贵的就是"到底卡在哪一步"。刷新一次页面就能从控制台区分：
  //   ① 一条都没有 → bundle 根本没被执行（宿主侧的组装问题）
  //   ② 有「factory 已执行」没有「apply」→ 模块系统没 materialize 我们
  //   ③ 有「apply」没有「入口已注册」→ 槽位声明没到达（壳没渲染该槽位）
  if (typeof window === 'undefined') return;
  if (!window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
    console.warn('[dsh-miliastra] window.__ModuleLoader__ 不可用 —— client bundle 无法注册 factory。'
      + '若这条出现了，说明本脚本的执行时机早于模块系统就绪。');
    return;
  }

  window.__ModuleLoader__.load({
    id: 'dsh-miliastra',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var PLUGIN = 'dsh-miliastra';
      var PREFIX = '/miliastra';
      var STYLE_ID = 'dsh-miliastra-style';
      /** 入口图标：内联 data URI，零依赖、换图不用改路由（源图见 lib/assets/icon.png）。 */
      var ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAABACAYAAABRPoQBAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyNpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjM4OEU0QkQ2RjQzOTExRjA4RTUwQzVGRjVGM0E2REU0IiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjM4OEU0QkQ3RjQzOTExRjA4RTUwQzVGRjVGM0E2REU0Ij4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6Mzg4RTRCRDRGNDM5MTFGMDhFNTBDNUZGNUYzQTZERTQiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6Mzg4RTRCRDVGNDM5MTFGMDhFNTBDNUZGNUYzQTZERTQiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz6pMgwaAAAV9UlEQVR42sxbCZRl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';
      console.log('[dsh-miliastra] factory 已执行（bundle 被模块系统 materialize）');

      function safeRequire(name) {
        try { return require(name); } catch (e) { console.warn('[' + PLUGIN + '] require("' + name + '") 失败：', e); return null; }
      }

      var React = safeRequire('react');
      var primitives = safeRequire('@deepseek-ai/dsh-client-ui-primitives');

      /* ------------------------------------------------------------------ 样式
       * 粉蓝主调：浅蓝 #7dd3fc ↔ 粉红 #f9a8d4。
       * 三栏网格参考蛋仔面板（dsh-eggy 的 .eggy-body / .eggy-col）。
       * 凡用主题令牌一律写 fallback —— 实测令牌是运行时注入的，缺了不该变成透明或纯黑。
       * ------------------------------------------------------------------ */
      var CSS = [
        // —— 入口 ——
        '.' + PLUGIN + '-root{position:relative;display:flex;align-items:center;}',
        '.' + PLUGIN + '-btn{display:flex;align-items:center;gap:8px;width:100%;border:0;cursor:pointer;',
        'background:transparent;color:var(--dsw-alias-label-primary,#e8f2ff);font:inherit;font-size:13px;',
        'padding:6px 10px;border-radius:10px;white-space:nowrap;transition:background .15s,box-shadow .15s;}',
        '.' + PLUGIN + '-btn:hover{background:linear-gradient(135deg,rgba(125,211,252,.18),rgba(249,168,212,.18));',
        'box-shadow:0 0 0 1px rgba(125,211,252,.30) inset;}',
        '.' + PLUGIN + '-rail{justify-content:center;padding:0;width:36px;height:36px;}',
        '.' + PLUGIN + '-mark{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;',
        'width:22px;height:24px;filter:drop-shadow(0 0 6px rgba(125,211,252,.45));}',
        '.' + PLUGIN + '-mark img{height:24px;width:auto;display:block;image-rendering:pixelated;}',
        '.' + PLUGIN + '-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

        // —— 面板（三栏 + 头部固定，主体自己滚）——
        '.' + PLUGIN + '-panel{position:fixed;z-index:60;width:min(880px,94vw);max-width:94vw;',
        'height:min(600px,82vh);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:0;',
        'border-radius:14px;font-size:12.5px;line-height:1.6;',
        'background:linear-gradient(180deg,#101a2c,#0b1220 62%);',
        'color:var(--dsw-alias-label-primary,#e8f2ff);',
        'border:1px solid rgba(125,211,252,.22);',
        'box-shadow:0 20px 54px rgba(0,0,0,.60),0 0 0 1px rgba(125,211,252,.06) inset;}',

        // —— 头部 ——
        '.' + PLUGIN + '-head{display:flex;align-items:center;gap:9px;padding:10px 13px;',
        'border-bottom:1px solid rgba(125,211,252,.16);',
        'background:linear-gradient(180deg,rgba(125,211,252,.12),transparent);}',
        '.' + PLUGIN + '-head .' + PLUGIN + '-mark{width:20px;height:22px;}',
        '.' + PLUGIN + '-head .' + PLUGIN + '-mark img{height:22px;}',
        '.' + PLUGIN + '-title{font-weight:700;letter-spacing:.4px;font-size:13.5px;',
        'background:linear-gradient(90deg,#a5d8ff,#f9a8d4);-webkit-background-clip:text;background-clip:text;color:transparent;}',
        '.' + PLUGIN + '-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;',
        'border:1px solid rgba(249,168,212,.32);color:#ffd6ec;background:rgba(249,168,212,.12);}',
        '.' + PLUGIN + '-spacer{flex:1;}',
        '.' + PLUGIN + '-x{border:0;background:transparent;cursor:pointer;color:#8fa6c4;font-size:15px;',
        'line-height:1;padding:3px 7px;border-radius:8px;}',
        '.' + PLUGIN + '-x:hover{background:rgba(125,211,252,.14);color:#e8f2ff;}',

        // —— 主体：三栏，每栏自己滚 ——
        '.' + PLUGIN + '-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;',
        'padding:11px 13px 13px;flex:1 1 auto;min-height:0;overflow:hidden;align-items:stretch;}',
        '.' + PLUGIN + '-col{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;',
        'overflow-y:auto;overflow-x:hidden;padding-right:3px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar{width:6px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar-thumb{background:rgba(125,211,252,.28);border-radius:6px;}',
        '.' + PLUGIN + '-col-head{font-size:10.5px;font-weight:700;letter-spacing:.6px;',
        'color:#7dd3fc;opacity:.85;padding:0 2px;flex:0 0 auto;}',

        // —— 卡片 ——
        '.' + PLUGIN + '-sec{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:10px;',
        'border:1px solid rgba(125,211,252,.14);background:rgba(255,255,255,.022);flex:0 0 auto;}',
        '.' + PLUGIN + '-sec-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;',
        'color:#a5d8ff;letter-spacing:.3px;}',
        '.' + PLUGIN + '-hint{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-secondary,#8fa6c4);}',

        // —— 键值网格 ——
        '.' + PLUGIN + '-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px;}',
        '.' + PLUGIN + '-k{color:var(--dsw-alias-label-secondary,#8fa6c4);white-space:nowrap;}',
        '.' + PLUGIN + '-v{word-break:break-all;color:#e8f2ff;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;}',

        // —— 状态点 ——
        '.' + PLUGIN + '-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;}',
        '.' + PLUGIN + '-dot.ok{background:#7dd3fc;box-shadow:0 0 7px rgba(125,211,252,.6);}',
        '.' + PLUGIN + '-dot.warn{background:#f9a8d4;box-shadow:0 0 7px rgba(249,168,212,.6);}',
        '.' + PLUGIN + '-dot.err{background:#fb7185;box-shadow:0 0 7px rgba(251,113,133,.6);}',

        // —— 按钮与输入 ——
        '.' + PLUGIN + '-row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;}',
        '.' + PLUGIN + '-act{font:inherit;font-size:12px;padding:5px 11px;border-radius:8px;cursor:pointer;',
        'border:1px solid rgba(125,211,252,.26);background:rgba(125,211,252,.10);color:#e8f2ff;',
        'transition:background .15s,box-shadow .15s;flex:0 0 auto;}',
        '.' + PLUGIN + '-act:hover:not(:disabled){background:rgba(249,168,212,.18);box-shadow:0 0 0 1px rgba(125,211,252,.30) inset;}',
        '.' + PLUGIN + '-act:disabled{opacity:.5;cursor:default;}',
        '.' + PLUGIN + '-primary{border-color:transparent;color:#0d1626;font-weight:600;',
        'background:linear-gradient(135deg,#7dd3fc,#f9a8d4);}',
        '.' + PLUGIN + '-primary:hover:not(:disabled){background:linear-gradient(135deg,#a5e0ff,#ffbde0);',
        'box-shadow:0 4px 14px rgba(125,211,252,.35);}',
        '.' + PLUGIN + '-inp{flex:1 1 auto;min-width:0;box-sizing:border-box;border-radius:8px;padding:5px 9px;',
        'font:inherit;font-size:11.5px;background:rgba(0,0,0,.30);color:#e8f2ff;',
        'border:1px solid rgba(125,211,252,.22);}',
        '.' + PLUGIN + '-inp:focus{outline:none;border-color:rgba(249,168,212,.55);box-shadow:0 0 0 2px rgba(125,211,252,.18);}',
        '.' + PLUGIN + '-inp::placeholder{color:#6c7f9c;}',

        // —— 胶囊 / 日志 / 提示条 ——
        '.' + PLUGIN + '-pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;margin:1px 4px 1px 0;',
        'border:1px solid rgba(249,168,212,.34);background:rgba(249,168,212,.12);color:#ffd6ec;',
        'font-family:ui-monospace,Consolas,monospace;}',
        '.' + PLUGIN + '-pill:hover{background:rgba(249,168,212,.22);}',
        '.' + PLUGIN + '-log{margin-top:5px;max-height:52vh;overflow:auto;border-radius:9px;padding:5px 4px;',
        'background:rgba(4,10,20,.42);border:1px solid rgba(125,211,252,.12);',
        'font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-all;color:#c9dcf5;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar{width:8px;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar-thumb{background:rgba(125,211,252,.30);border-radius:8px;}',

        // —— 日志行（格式化后）——
        '.' + PLUGIN + '-lrow{display:flex;gap:6px;align-items:flex-start;padding:2px 5px;border-radius:6px;',
        'border-left:2px solid transparent;}',
        '.' + PLUGIN + '-lrow:hover{background:rgba(125,211,252,.06);}',
        '.' + PLUGIN + '-lrow.' + PLUGIN + '-lbad{background:rgba(251,113,133,.12);border-left-color:#fb7185;}',
        '.' + PLUGIN + '-lrow.' + PLUGIN + '-lwarn{background:rgba(249,168,212,.09);border-left-color:#f9a8d4;}',
        '.' + PLUGIN + '-ltime{flex:0 0 auto;color:#6c7f9c;font-size:9.5px;padding-top:1px;}',
        '.' + PLUGIN + '-ltag{flex:0 0 auto;font-size:9.5px;padding:0 6px;border-radius:999px;',
        'background:rgba(125,211,252,.16);color:#a5d8ff;border:1px solid rgba(125,211,252,.22);}',
        '.' + PLUGIN + '-lmsg{flex:1 1 auto;min-width:0;}',
        '.' + PLUGIN + '-ldet{flex:1 1 auto;min-width:0;}',
        '.' + PLUGIN + '-ldet>summary{cursor:pointer;color:#a5d8ff;outline:none;}',
        '.' + PLUGIN + '-ldet>summary:hover{color:#ffd6ec;}',
        '.' + PLUGIN + '-lpre{margin:4px 0 2px;padding:5px 7px;border-radius:6px;white-space:pre-wrap;',
        'background:rgba(0,0,0,.34);color:#dbe9fb;font-family:inherit;}',
        // —— 可折叠卡片（高级诊断）——
        '.' + PLUGIN + '-fold-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;',
        'color:#a5d8ff;letter-spacing:.3px;cursor:pointer;user-select:none;}',
        '.' + PLUGIN + '-fold-title:hover{color:#ffd6ec;}',
        '.' + PLUGIN + '-onlyai{font-size:10px;padding:1px 7px;border-radius:999px;margin-left:auto;',
        'background:rgba(249,168,212,.14);border:1px solid rgba(249,168,212,.30);color:#ffd6ec;font-weight:500;}',
        '.' + PLUGIN + '-err{font-size:11.5px;color:#ff9fb0;padding:5px 9px;border-radius:8px;',
        'background:rgba(251,113,133,.10);border:1px solid rgba(251,113,133,.28);}',
        '.' + PLUGIN + '-note{font-size:11.5px;color:#ffd6ec;padding:5px 9px;border-radius:8px;',
        'background:rgba(249,168,212,.10);border:1px solid rgba(249,168,212,.26);}',
      ].join('');

      function injectStyle() {
        try {
          if (document.getElementById(STYLE_ID)) return function () {};
          var el = document.createElement('style');
          el.id = STYLE_ID;
          el.setAttribute('data-plugin', PLUGIN);
          el.textContent = CSS;
          document.head.appendChild(el);
          return function () { try { el.remove(); } catch (e) { /* ignore */ } };
        } catch (e) {
          console.warn('[' + PLUGIN + '] 样式注入失败：', e);
          return function () {};
        }
      }

      /**
       * 剥掉路由信封，拿到**工具的业务返回体**。
       *
       * 信封有三层，少剥一层就会读出一堆 undefined（实测踩过两次）：
       *   HTTP body = { ok, data: { name, ok, data: <业务返回体> } }
       *
       * @param {unknown} j 已解析的响应体
       * @returns {{ok:boolean}} 业务返回体；任何一层不对则回 `{ok:false, error}`
       */
      function unwrapToolResult(j) {
        if (j && j.ok === true && j.data && j.data.ok === true && j.data.data && typeof j.data.data === 'object') {
          return j.data.data;
        }
        var msg = (j && j.data && j.data.error) || (j && j.error) || '调用失败（信封形状不符）';
        return { ok: false, error: String(msg) };
      }
      // 仅用于回归测试（信封层数错一次就够贵了）
      exports.__testUnwrapToolResult = unwrapToolResult;

      /** 调 Host 半边：POST /miliastra/tool {name,args}。绝不 throw，失败回 {ok:false}。 */
      function callTool(name, args) {
        return fetch(PREFIX + '/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, args: args || {} }),
        }).then(function (r) { return r.json(); })
          .then(unwrapToolResult)
          .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
      }

      /* ---------------------------------------------------------------- 小组件 */

      function KVGrid(props) {
        return React.createElement('div', { className: PLUGIN + '-kv' }, props.rows);
      }

      function cell(k, v, key) {
        var empty = v === undefined || v === null || v === '';
        return [
          React.createElement('div', { className: PLUGIN + '-k', key: key + '-k' }, k),
          React.createElement('div', { className: PLUGIN + '-v', key: key + '-v' }, empty ? '—' : v),
        ];
      }

      function sec(title, hint, children, key, dotCls) {
        return React.createElement('div', { className: PLUGIN + '-sec', key: key },
          React.createElement('div', { className: PLUGIN + '-sec-title', key: 't' },
            dotCls ? React.createElement('span', { className: PLUGIN + '-dot ' + dotCls, key: 'd' }) : null,
            title,
            hint ? React.createElement('span', { className: PLUGIN + '-hint', key: 'h' }, hint) : null),
          children);
      }

      /** 品牌图标：内联 PNG（像素画用 pixelated 保持锐利）。 */
      function Icon(props) {
        return React.createElement('span', { className: PLUGIN + '-mark', key: props.k },
          React.createElement('img', { src: ICON_DATA_URI, alt: '', draggable: false }));
      }

      function fmtSize(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
      }

      function basename(p) { return String(p || '').split('\\').pop(); }

      /** `pendingRestore` 的哨兵值：表示「用固定名那份备份」（= 最近一次覆盖前的版本）。 */
      var RESTORE_FIXED = '__fixed__';
      /** 备份相关说明的统一文案（面板与工具描述保持同一口径）。注意：面板不渲染 Markdown，别写反引号/星号。 */
      var BACKUP_NOTE = '备份就写在你脚本旁边（_backup 目录），每次两份：固定名「<原名>.bak」（最新）+ 一份带本地时间戳的历史（永不自动删）。'

      /*
       * ---------------- 日志格式化 ----------------
       *
       * 之前是一坨 `logs.join('\n')` 直接塞进 <div>：时间/标签/正文同色同字号，
       * 出错的那一行混在几十行里看不出来，超长行（枚举 dump 那种上万字符）会把整块撑爆。
       *
       * 现在拆成结构化行：时间（暗） + [TAG]（胶囊） + 正文（自动折行）；超长正文折叠成
       * 「点开看全」；疑似异常的行左边加一道红/粉竖线。
       *
       * ⚠️ `bad/warn` 是**关键词启发式**，不是权威级别 —— 地图脚本用 print 打日志时不带级别。
       *    所以只用来「显眼」，不用来「判定」。判据一律以正文为准。
       */
      var BAD_RE = /(错误|失败|异常|崩溃|报错|无法|不能|不存在|未就绪|error|failed|exception|not found)/i;
      var WARN_RE = /(警告|注意|重试|超时|warn|retry|timeout|deprecated)/i;

      function parseLogRecord(rec) {
        var time = String((rec && rec.time) || '');
        var raw = String((rec && rec.message) || '');
        var text = raw;
        var tag = '';
        var m = /^\[([^\]\s]{1,24})\]\s*/.exec(text);
        if (m) { tag = m[1]; text = text.slice(m[0].length); }
        var bad = BAD_RE.test(text);
        return { time: time, tag: tag, text: text, raw: raw, bad: bad, warn: !bad && WARN_RE.test(text) };
      }

      /** 从 Host 返回的记录数组造出「格式化行」。超长正文只截一段（点开才看全，别一次塞进 DOM）。 */
      function toLogRows(records) {
        return (records || []).map(parseLogRecord);
      }

      /*
       * ---------------- 「试玩一结束自动取最新一局」 ----------------
       *
       * 信号只有文件系统。2026-09-23 实测（把事实钉死，别再想当然）：
       *   · **每次试玩 = 一个新的 `.gia` 文件**，文件名里 `HH-MM-SS` 是开局时刻，
       *     文件名里那个数字**不是游戏进程 pid**（实测 `YuanShen.exe` 从 12:39 一直开着，
       *     而文件里的号从 135 逐局涨到 151）—— 它是每局的会话序号。
       *   · 文件的 mtime ≈ 最后一次写入（也就是这一局结束的时刻）。
       *   · `.gia` 里**只有脚本自己 print 的内容**，没有框架级的「开始/结束」记录
       *     （全字段导出确认），所以没有权威标记，只能用文件动静代理。
       *   · `YuanShen.exe` 在跑 **不能** 当作「在试玩」—— 它跨了当天 13:40~18:44 的全部试玩。
       *
       * 于是判据是：
       *   · 出现新文件 / 文件变大  → 这一局在动
       *   · 名字和大小都不动了、且等够 AUTO_SETTLE_MS → 认定这局结束 → 自动取回
       *   · 全程没动静 → 不取（别拿几小时前的旧局面糊用户一脸）
       *
       * 抽成纯函数是为了能回归：定时器不好测，判据好测。
       */
      var AUTO_POLL_MS = 4000;
      var AUTO_SETTLE_MS = 6000;
      /** 打开面板时，如果最新一局是这个时间内写完的，也算「刚玩过」→ 直接取回。 */
      var AUTO_FRESH_MS = 30000;

      /**
       * 一个日志局面「上次写入距今多久」（毫秒）。
       *
       * ⚠️ 踩过：Host 的 `listGia` 返回的字段是 **`mtime`（ISO 字符串）**，不是 `mtimeMs`。
       * 我一开始读 `top.mtimeMs` → 恒为 undefined → age 恒 0 → 「刚玩过」永远为真，
       * 于是打开面板就把**十几小时前的旧局面**自动取回来糊用户一脸。
       * 这个是**真机验证跑出来的**（对着 16 分钟前的局面判了「刚结束」）。
       * 现在两种字段都认；都拿不到就返回 Infinity（当「很旧」），宁可保守不漏。
       */
      function logRecordAgeMs(top, now) {
        if (!top) return Infinity;
        var mt = top.mtimeMs;
        if (!(typeof mt === 'number' && isFinite(mt) && mt > 0)) {
          var parsed = Date.parse(top.mtime);
          mt = isNaN(parsed) ? 0 : parsed;
        }
        if (!(mt > 0)) return Infinity;
        return now - mt;
      }

      function autoFollowStep(prev, top, now, settleMs) {
        var p = prev || { name: '', size: -1, stableSince: 0, fetched: '', activity: false, seen: false };
        if (!top || !top.name) return { next: p, action: 'none', phase: 'idle', reason: '还没有日志文件' };

        var isNew = top.name !== p.name;
        var grew = !isNew && top.size !== p.size;

        if (isNew || grew) {
          var age = logRecordAgeMs(top, now);
          // 首次建立基线时：只有「刚刚才写过」的才算刚玩过，旧局面不算
          var activity = p.seen ? true : age <= AUTO_FRESH_MS;
          return {
            next: { name: top.name, size: top.size, stableSince: now, fetched: p.fetched, activity: activity, seen: true },
            action: 'none',
            phase: isNew ? 'new-session' : 'growing',
            reason: isNew
              ? (p.seen ? '检测到新的一局，正在记录' : '刚结束的一局（' + shortSessionName(top.name) + '）')
              : '这一局还在写（试玩中）',
          };
        }

        if (!p.stableSince) {
          return { next: Object.assign({}, p, { stableSince: now }), action: 'none', phase: 'settling', reason: '等它写完' };
        }
        var waited = now - p.stableSince;
        if (waited < settleMs) {
          return {
            next: p, action: 'none', phase: 'settling',
            reason: '安静 ' + Math.round(waited / 1000) + 's / ' + Math.round(settleMs / 1000) + 's',
          };
        }
        if (!p.activity) return { next: p, action: 'none', phase: 'idle', reason: '没动静（面板打开后还没试玩过）' };
        if (top.size === 0) return { next: p, action: 'none', phase: 'empty', reason: '这一局还没写出内容' };
        var key = top.name + ':' + top.size;
        if (p.fetched === key) return { next: p, action: 'none', phase: 'done', reason: '这一局已经取过了' };
        return {
          next: Object.assign({}, p, { fetched: key }),
          action: 'fetch', phase: 'fetching',
          reason: '试玩结束，自动取回',
        };
      }

      /** `2026-09-23_18-44-57_151_201170108.gia` → `18:44:57`（面板里只留时间，省地方）。 */
      function shortSessionName(name) {
        var s = String(name || '').replace(/\.gia$/i, '');
        var m = /^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})/.exec(s);
        return m ? m[1] + ':' + m[2] + ':' + m[3] : s;
      }

      /** 自动跟新的状态图标（沿用面板那套粉蓝，不用 emoji）。 */
      function autoPhaseMark(phase) {
        if (phase === 'growing' || phase === 'new-session') return '●';
        if (phase === 'settling') return '◌';
        if (phase === 'fetching') return '↓';
        if (phase === 'done') return '✓';
        if (phase === 'empty') return '…';
        return '';
      }

      /** 一条日志行的可视渲染。 */
      function LogRow(row, i) {
        var kids = [];
        if (row.time) kids.push(React.createElement('span', { className: PLUGIN + '-ltime', key: 't' }, row.time));
        if (row.tag) kids.push(React.createElement('span', { className: PLUGIN + '-ltag', key: 'g' }, row.tag));
        if (row.text.length > 400) {
          kids.push(React.createElement('details', { className: PLUGIN + '-ldet', key: 'm' },
            React.createElement('summary', null,
              row.text.slice(0, 160) + ' …（共 ' + row.text.length + ' 字符，点开看全）'),
            React.createElement('pre', { className: PLUGIN + '-lpre' }, row.text)));
        } else {
          kids.push(React.createElement('span', { className: PLUGIN + '-lmsg', key: 'm' }, row.text));
        }
        return React.createElement('div', {
          className: PLUGIN + '-lrow' + (row.bad ? ' ' + PLUGIN + '-lbad' : row.warn ? ' ' + PLUGIN + '-lwarn' : ''),
          key: i,
          title: row.raw,
        }, kids);
      }

      /*
       * 探针说明的兜底文案 —— 只在拿不到 Host `op=list` 的 info 时才用
       * （比如 Host 半边是旧版、或 op=list 失败）。
       * 正路是 Host 给：`lib/probes.mjs` 的 PROBE_INFO / PROBE_OVERVIEW 是唯一口径；
       * 这里复制一份只为「Host 不在线也能看懂」，`client-render-test` 会核对两边不脱节。
       */
      var PROBE_OVERVIEW_FALLBACK = {
        what: '探针 = 一段临时替掉你脚本的小程序，只在试玩那几秒跑一次，把游戏内部的信息打到日志里。',
        why: '有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举叫什么名），必须让游戏真跑一遍才知道。',
        cost: '要临时覆盖活文件，所以试玩的那一局你的玩法不会跑（会自动先备份，用完可一键还原）。',
        steps: ['选一个探针', '点「部署」（覆盖活文件，先自动备份）', '在编辑器里重新试玩一局', '回来点「收回结论」，然后还原你的脚本'],
      };
      var PROBE_FALLBACK = [
        {
          template: 'ping', label: '探活',
          oneLine: '确认「脚本到底有没有跑起来」',
          what: '只往日志里打几行字：脚本加载了没、OnStart 跑了没、OnUpdate 有没有在跳。',
          when: '试玩完日志里什么都没有时，先跑它。用来分清是「脚本压根没起来」还是「起来了但那段没执行」。',
        },
        {
          template: 'tree', label: '看控件',
          oneLine: '看屏幕上现在挂着哪些客户端控件、画布多大',
          what: '把每个活控件的名字、索引、父子关系、可见性列出来，并读一次画布尺寸。',
          when: '怀疑「控件没建出来 / 建到了错的父级下 / 尺寸不对」时。也能顺手核对画布尺寸是不是你预期的。',
        },
        {
          template: 'instantiate', label: '试钥匙',
          oneLine: '拿一串索引号去试，看哪个真能被脚本创建出来',
          what: '对每个候选号调一次创建接口：成功打 OK，失败是 nil；试出来的控件立刻销毁。',
          when: '准备让脚本动态建控件之前。只有「在模板库里存为模板」的控件才能被创建，画布上摆的实例一律 nil —— 用它查出哪些号真的能用。',
        },
        {
          template: 'api-surface', label: '翻字典',
          oneLine: '把游戏里的枚举和它们的成员列出来（比如某个按键到底叫什么名）',
          what: '枚举各枚举表的全部成员与取值，并实测几个按键枚举能不能取到值。',
          when: '要引用某个枚举 / 按键名，但文档翻不到或不确定写法时 —— 别猜，让它把真名打出来。输出较长，已做分片打印。',
        },
      ];

      /* ---------------------------------------------------------------- 面板 */

      function Panel(props) {
        var open = props.open;
        var setOpen = props.setOpen;
        var rootRef = props.rootRef;

        var s1 = React.useState(null); var status = s1[0]; var setStatus = s1[1];
        var s2 = React.useState(false); var busy = s2[0]; var setBusy = s2[1];
        var s3 = React.useState(''); var err = s3[0]; var setErr = s3[1];
        /** 日志（已格式化的行）。`__logs` 仅供本地渲染测试/工具预置样例行。 */
        var s4 = React.useState(props.__logs || []); var logs = s4[0]; var setLogs = s4[1];
        var s5 = React.useState(''); var srcPath = s5[0]; var setSrcPath = s5[1];
        var s6 = React.useState(''); var note = s6[0]; var setNote = s6[1];
        var s7 = React.useState(null); var anchor = s7[0]; var setAnchor = s7[1];
        var s8 = React.useState(null); var mapInfo = s8[0]; var setMapInfo = s8[1];
        var s9 = React.useState(null); var scriptInfo = s9[0]; var setScriptInfo = s9[1];
        var s10 = React.useState(null); var fileInfo = s10[0]; var setFileInfo = s10[1];
        /** 备份清单。`__backups` 仅供本地渲染测试预置（否则「一键还原」那块测不到）。 */
        var s11 = React.useState(props.__backups || null); var backups = s11[0]; var setBackups = s11[1];
        var s12 = React.useState([]); var tags = s12[0]; var setTags = s12[1];
        var s13 = React.useState(''); var tagFilter = s13[0]; var setTagFilter = s13[1];
        /** 待确认的还原目标（备份路径，或 RESTORE_FIXED 哨兵）。`__pendingRestore` 仅供渲染测试。 */
        var s14 = React.useState(props.__pendingRestore || ''); var pendingRestore = s14[0]; var setPendingRestore = s14[1];
        /**
         * 当前选中的活文件名。
         * ⚠️ **一个关卡可以有多个 `.lua`**（不同角色 / 不同模块各挂一个客户端脚本），
         *    所以「当前文件」必须是显式状态，所有 op（体检/备份/比对/部署/还原）都跟着它走。
         */
        var s15 = React.useState(''); var activeFile = s15[0]; var setActiveFile = s15[1];
        /** 选中的关卡；**空串 = 自动跟随**（跟着 `miliastra_health` 判定的「当前关卡」走）。 */
        var s16 = React.useState(''); var activeLevel = s16[0]; var setActiveLevel = s16[1];
        /** 历史局面（`.gia` 文件）；空串 = 最新那局。 */
        var s17 = React.useState([]); var sessions = s17[0]; var setSessions = s17[1];
        var s18 = React.useState(''); var activeSession = s18[0]; var setActiveSession = s18[1];
        /** 探针：选模板 → 部署（**覆盖活文件**，带备份）→ 重新试玩 → 收回结论 → 还原脚本。 */
        var s19 = React.useState('ping'); var probeTemplate = s19[0]; var setProbeTemplate = s19[1];
        var s20 = React.useState('P1'); var probeTag = s20[0]; var setProbeTag = s20[1];
        var s21 = React.useState(null); var probeResult = s21[0]; var setProbeResult = s21[1];
        var s22 = React.useState(false); var pendingProbe = s22[0]; var setPendingProbe = s22[1];
        /** 探针的大白话说明（op=list 从 Host 拿，单一口径；拿不到就用下面的兜底文案）。
         *  `__probeInfo` 仅供本地渲染测试模拟「Host 返回的清单」用（否则「Host 是旧版」那条提示测不到）。 */
        var s23 = React.useState(props.__probeInfo || null); var probeInfo = s23[0]; var setProbeInfo = s23[1];
        /** 部署探针时产生的备份路径 —— 用来「一键还原我的脚本」。
         *  `__probeBackup` 仅供本地渲染测试预置初值（State 从外面设不了，否则「已部署」那段永远测不到）。 */
        var s24 = React.useState(props.__probeBackup || null); var probeBackup = s24[0]; var setProbeBackup = s24[1];
        /** 「高级诊断」折叠区默认**收起** —— 探针主要给 AI 排障用，不该占创作者的视线。 */
        var s25 = React.useState(props.__advOpen === true); var advOpen = s25[0]; var setAdvOpen = s25[1];
        /** 日志过滤：只看疑似异常的行（关键词启发式）。 */
        var s26 = React.useState(false); var onlyBad = s26[0]; var setOnlyBad = s26[1];
        /**
         * 「读界面控件」的结果（高级诊断区）。
         * 这是**静态读取**：直接从地图存档 `.gil` 里读客户端控件谱系（模板索引 / 名字 / 父子），
         * 不用试玩、不用覆盖任何文件。想要**运行时**的控件树就点探针里的「看控件」。
         * `__uiInfo` / `__uiRaw` 仅供渲染测试预置。
         */
        var s29 = React.useState(props.__uiInfo || null); var uiInfo = s29[0]; var setUiInfo = s29[1];
        var s30 = React.useState(false); var uiBusy = s30[0]; var setUiBusy = s30[1];
        var s31 = React.useState(props.__uiRaw === true); var uiRaw = s31[0]; var setUiRaw = s31[1];
        /**
         * 试玩结束**自动取回最新一局**（作者要求）。
         * 默认开。守望 `.gia` 文件：名字或大小一变就说明「试玩在动」，
         * 然后等它安静下来（SETTLE_MS）就自动取回那一局 —— 不用人再点「取日志」。
         * `__autoLog` / `__autoState` 仅供渲染测试预置状态。
         */
        var s27 = React.useState(props.__autoLog !== false); var autoLog = s27[0]; var setAutoLog = s27[1];
        var s28 = React.useState(props.__autoState || null); var autoState = s28[0]; var setAutoState = s28[1];
        /** 守望用的游标（不进 state：它每秒都在变，进 state 会引发无意义重渲染）。 */
        var watchRef = React.useRef({ name: '', size: -1, stableSince: 0, fetched: '' });
        var doLogsRef = React.useRef(null);
        var tagFilterRef = React.useRef(tagFilter);

        /** 所有工具调用统一带上「当前关卡」——空串表示让 Host 自动判定。 */
        var lvArg = function () { return activeLevel ? { level: activeLevel } : {}; };

        /**
         * 拉状态。
         * @param {boolean} light 轻量刷新（只拉状态 + 地图），供 15 秒轮询用；
         *                        全量（含活文件体检 / 备份 / 标签 / 历史局面）在打开面板与点「刷新」时走。
         */
        var load = React.useCallback(function (light) {
          setBusy(true); setErr('');
          // all:true —— 面板要列出**全部**关卡供切换（默认只回 12 个，本机实测有 18 个）
          callTool('miliastra_health', { all: true }).then(function (r) {
            if (!r.ok) { setBusy(false); setErr(r.error || '未知错误'); return null; }
            setStatus(r);

            // 关卡的「当前」：手动选过就用手动的，否则跟着 Host 判定的当前关卡（= 自动跟随换图）
            var levels = r.levels || [];
            var wanted = activeLevel || (r.current ? r.current.levelId : '');
            var lv = levels.find(function (x) { return x.levelId === wanted; }) || r.current || null;

            // 一个关卡可能有多个活文件 —— 确保 activeFile 是有效的那个；
            // 有效就留着（不打断用户的选择），失效/为空才重新挑（挑列表第一个）。
            var files = (lv && lv.luaFiles) || [];
            var stillThere = !!activeFile && files.some(function (f) { return f.name === activeFile; });
            var pick = stillThere ? activeFile : (files[0] ? files[0].name : '');
            if (pick !== activeFile) {
              setActiveFile(pick);
              setBusy(false);
              return null; // activeFile 变了会重建 load 并重跑，下一趟就会带上正确的 file
            }
            var F = Object.assign({}, lvArg(), pick ? { file: pick } : {});

            return callTool('miliastra_map', Object.assign({ op: 'summary' }, F)).then(function (m) {
              setMapInfo(m && m.ok !== false ? m : null);
              return callTool('miliastra_map', Object.assign({ op: 'script' }, F)).then(function (sc) {
                setScriptInfo(sc && sc.ok !== false ? sc : null);
                if (light) { setBusy(false); return null; }
                return callTool('miliastra_code', Object.assign({ op: 'inspect' }, F)).then(function (fi) {
                  setFileInfo(fi && fi.ok !== false ? fi : null);
                  return callTool('miliastra_code', Object.assign({ op: 'backups' }, F)).then(function (bk) {
                    setBackups(bk && bk.ok !== false ? bk : null);
                    return callTool('miliastra_log', Object.assign({ op: 'tags' }, lvArg())).then(function (tg) {
                      if (tg && tg.ok !== false && tg.tags) setTags(tg.tags);
                      return callTool('miliastra_log', Object.assign({ op: 'sessions', limit: 12 }, lvArg())).then(function (ss) {
                        setSessions(ss && ss.ok !== false && Array.isArray(ss.files) ? ss.files : []);
                        setBusy(false);
                      });
                    });
                  });
                });
              });
            });
          }).catch(function (e) {
            setBusy(false);
            setErr(String((e && e.message) || e));
          });
        }, [activeFile, activeLevel]);

        React.useEffect(function () { if (open) load(false); }, [open, load]);

        /**
         * 探针说明只拉一次（不是状态轮询的一部分）。
         * 面板不硬编码模板清单：模板名 / 大白话说明都由 Host 的 `op=list` 给，
         * 这样加模板不用改 panel，也不会出现「面板写的是旧清单」。
         */
        React.useEffect(function () {
          if (!open || probeInfo) return undefined;
          var alive = true;
          callTool('miliastra_probe', Object.assign({ op: 'list' }, lvArg())).then(function (r) {
            if (!alive || !r || !r.ok) return;
            setProbeInfo({
              templates: r.templates || [],
              info: r.info || [],
              overview: { what: r.whatIsAProbe, why: r.why, cost: r.cost, steps: r.steps || [] },
            });
            if (r.templates && r.templates.length && r.templates.indexOf(probeTemplate) < 0) setProbeTemplate(r.templates[0]);
          }).catch(function () { /* 拿不到就用兜底文案 */ });
          return function () { alive = false; };
        }, [open, probeInfo, probeTemplate, lvArg]);

        React.useEffect(function () {
          if (!open) return undefined;
          var t = setInterval(function () { load(true); }, 15000);
          return function () { clearInterval(t); };
        }, [open, load]);

        /**
         * 试玩结束 → 自动取回最新一局。
         *
         * 依赖只放 open / autoLog / activeLevel：`lvArg` / `doLogs` / `tagFilter` 每次渲染都是新身份，
         * 放进依赖会让这个 4 秒的定时器每次渲染都被重建（面板每 15 秒轮询一次 → 定时器永远跑不满）。
         * 所以后两者走 ref 读最新值。
         */
        React.useEffect(function () {
          if (!open || !autoLog) return undefined;
          var stopped = false;
          var lastKey = '';

          var tick = function () {
            if (stopped) return;
            callTool('miliastra_log', Object.assign({ op: 'sessions', limit: 5 },
              activeLevel ? { level: activeLevel } : {})).then(function (r) {
              if (stopped || !r || r.ok === false) return;
              var top = (r.files || [])[0] || null;
              var step = autoFollowStep(watchRef.current, top, Date.now(), AUTO_SETTLE_MS);
              watchRef.current = step.next;

              // 只在「状态真的变了」时 setState，否则每 4 秒无意义重渲染一次整个面板
              var key = step.phase + '|' + (top ? top.name : '') + '|' + (top ? top.size : '') + '|' + step.reason;
              if (key !== lastKey) {
                lastKey = key;
                setAutoState({
                  phase: step.phase, reason: step.reason,
                  name: top ? top.name : '', size: top ? top.size : 0,
                });
              }
              if (step.action === 'fetch' && top && top.path) {
                var fn = doLogsRef.current;
                if (typeof fn === 'function') fn(tagFilterRef.current || '', top.path);
              }
            });
          };

          tick();
          var t = setInterval(tick, AUTO_POLL_MS);
          return function () { stopped = true; clearInterval(t); };
        }, [open, autoLog, activeLevel]);

        // 锚点：面板是触发器的子元素 + position:fixed，向上展开（抄官方 CordisPanel）
        React.useLayoutEffect(function () {
          if (!open) return undefined;
          var place = function () {
            try {
              var rect = rootRef.current && rootRef.current.getBoundingClientRect();
              if (rect) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
            } catch (e) { /* ignore */ }
          };
          place();
          window.addEventListener('resize', place);
          return function () { window.removeEventListener('resize', place); };
        }, [open, rootRef]);

        if (primitives && typeof primitives.useDismissOnOutsidePointer === 'function') {
          try { primitives.useDismissOnOutsidePointer(rootRef, open, setOpen); } catch (e) { /* ignore */ }
        }

        /**
         * 取日志。
         * @param {string} [tag]  按标签过滤（空 = 全部）
         * @param {string} [file] 指定某一局（空 = 最新那局）
         */
        var doLogs = function (tag, file) {
          var args = Object.assign({ op: 'tail', limit: 60 }, lvArg());
          if (file) args.file = file;
          if (tag) { args.op = 'grep'; args.tag = tag; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', args).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setLogs(toLogRows(r.records));
              if (file) setActiveSession(file);
              var parts = [];
              if (file) parts.push('局 ' + basename(file));
              if (tag) parts.push('标签 ' + tag);
              parts.push((r.records || []).length + ' 条');
              setNote(parts.join(' · '));
            } else setErr(r.error || '读日志失败');
          });
        };

        // 让「自动取回」那个定时器读到最新的回调与过滤条件（见上面 effect 的注释）
        doLogsRef.current = doLogs;
        tagFilterRef.current = tagFilter;

        var doTags = function () {
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', Object.assign({ op: 'tags' }, lvArg())).then(function (r) {
            setBusy(false);
            if (r.ok) { setTags(r.tags || []); setNote('读到 ' + (r.tags || []).length + ' 个标签'); }
            else setErr(r.error || '读标签失败');
          });
        };

        /**
         * 部署探针 —— ⚠️ **它会覆盖选中的活文件**（探针源码替换你的脚本）。
         * 所以固定两步：先 setPendingProbe(true) 弹确认，再点「确认覆盖」才真的执行。
         * Host 侧 `op=deploy` 会先自动备份，所以覆盖后能从「备份」卡片回退。
         */
        var doDeployProbe = function () {
          var tag = (probeTag || 'P1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'P1';
          setBusy(true); setErr(''); setNote(''); setProbeResult(null); setProbeBackup(null);
          var a = Object.assign({ op: 'deploy', template: probeTemplate, tag: tag }, lvArg());
          if (activeFile) a.file = activeFile;
          callTool('miliastra_probe', a).then(function (r) {
            setBusy(false);
            setPendingProbe(false);
            if (r.ok) {
              // 记住这份备份 = 「第 4 步：还原我的脚本」的凭据
              setProbeBackup(r.backup || null);
              setNote('探针已部署（' + (r.label || probeTemplate) + ' / ' + tag + '）'
                + ' —— 第 2 步：去编辑器「停止试玩 → 重新试玩一局」（先停掉当前那局）');
            } else setErr(r.error || ((r.errors || []).join('；') || '部署探针失败'));
            load(false);
          });
        };

        /** 第 4 步：把探针换回你自己的脚本（用部署时自动生成的那份备份）。 */
        var doRestoreProbe = function () {
          if (!probeBackup) { setErr('没有可用的备份路径 —— 请到「代码」栏的备份清单里手动还原'); return; }
          setBusy(true); setErr(''); setNote('');
          var a = Object.assign({ op: 'restore', backup: probeBackup }, lvArg());
          if (activeFile) a.file = activeFile;
          callTool('miliastra_code', a).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setNote('已还原回你的脚本（' + basename(r.restoredFrom || probeBackup) + '，' + (r.bytes || 0) + ' 字节）'
                + ' —— 记得「停止试玩 → 重新试玩一局」才会生效');
              setProbeBackup(null);
              setProbeResult(null);
            } else setErr(r.error || ((r.errors || []).join('；') || '还原失败'));
            load(false);
          });
        };

        /** 收回探针结论：从最新一局日志里捞该 tag 的输出。 */
        /**
         * 读界面控件（静态，从 `.gil` 读，不改任何文件）。
         *
         * 为什么值得放在面板上：写客户端脚本最缺的两个号就是
         * **容器节点索引**与**控件模板索引** —— 以前要靠人抄、或者写探针去试。
         * `miliastra_map op=clientui` 能把它们直接读出来，**不用试玩、不用覆盖脚本**。
         */
        var doReadUi = function () {
          setUiBusy(true); setErr(''); setNote('');
          callTool('miliastra_map', Object.assign({ op: 'clientui' }, lvArg())).then(function (r) {
            setUiBusy(false);
            if (r && r.ok !== false) {
              setUiInfo(r);
              setNote('读到 ' + (r.count || 0) + ' 条控件记录 · 可创建模板 ' + ((r.likelyTemplates || []).filter(function (x) { return x.name !== '容器节点'; }).length) + ' 个');
            } else {
              setErr((r && r.error) || '读界面控件失败（地图还没存盘？）');
            }
          });
        };

        var doCollectProbe = function () {
          var tag = (probeTag || 'P1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'P1';
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_probe', Object.assign({ op: 'collect', tag: tag }, lvArg())).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setProbeResult(r);
              setNote(r.hit ? '收回 ' + r.count + ' 行 [' + tag + ']' : '这一局里没有 [' + tag + '] 的输出');
            } else setErr(r.error || '收回失败');
          });
        };

        var doDeploy = function () {
          if (!srcPath) { setErr('请填本地 .lua 的绝对路径'); return; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_code', Object.assign({ op: 'deploy', source: srcPath }, lvArg(), activeFile ? { file: activeFile } : {})).then(function (r) {
            setBusy(false);
            if (r.ok) setNote('已部署 ' + (r.bytes || 0) + ' 字节 · sha=' + String(r.sha256 || '').slice(0, 12) + ' · 备份' + (r.backup ? '已生成（' + basename(r.backup) + '）' : '无'));
            else setErr(r.error || ((r.errors || []).join('；') || '部署失败'));
            load(false);
          });
        };

        /**
         * 还原。`pendingRestore` 是选中的备份路径，或哨兵 `RESTORE_FIXED` 表示「固定名那份」
         * （`<原名>.bak` = 最近一次覆盖前的版本）—— 不传 backup 给 Host，它自己解析固定名。
         *
         * 失败时把 Host 给的 `nextSteps` 一并显示 —— 光说「失败」等于把问题丢回给用户。
         * 若 Host 报了 `rolledBack`，要明确告诉用户「活文件已经被自动放回原样」。
         */
        var doRestore = function () {
          if (!pendingRestore) return;
          var isFixed = pendingRestore === RESTORE_FIXED;
          setBusy(true); setErr(''); setNote('');
          var args = Object.assign({ op: 'restore' }, lvArg(), activeFile ? { file: activeFile } : {});
          if (!isFixed) args.backup = pendingRestore;   // 固定名那份 = 不传 backup
          callTool('miliastra_code', args).then(function (r) {
            setBusy(false);
            var shown = isFixed ? '固定名备份' : basename(pendingRestore);
            setPendingRestore('');
            if (r.ok) {
              setNote('已还原 ' + (isFixed ? shown : basename(r.restoredFrom || shown))
                + (r.usedFixedBackup ? '（固定名 · 最近一次覆盖前的版本）' : '')
                + ' · ' + (r.bytes || 0) + ' 字节 · sha=' + String(r.sha256 || '').slice(0, 12)
                + (r.safetyBackup ? ' · 还原前那一版已存为 ' + basename(r.safetyBackup) : '')
                + ' —— 记得在编辑器里「停止试玩 → 重新试玩一局」才会生效');
            } else {
              var tips = (r.nextSteps || []).join('　·　');
              setErr((r.error || ((r.errors || []).join('；')) || '还原失败')
                + (r.rolledBack ? '　✅ 已自动回滚，活文件仍是还原前那一版（没坏）' : '')
                + (tips ? '　→ ' + tips : ''));
            }
            load(false);
          });
        };

        if (!open) return null;

        // 「当前关卡」= 手动选的（若有）否则 Host 判定的那个 —— 面板所有展示都跟着它
        var cur = (function () {
          if (!status) return null;
          if (!activeLevel) return status.current;
          return (status.levels || []).find(function (x) { return x.levelId === activeLevel; }) || status.current;
        })();
        var lua = cur && cur.luaFiles && cur.luaFiles.length ? cur.luaFiles[0] : null;
        var anchorStyle = anchor ? { left: anchor.left, bottom: anchor.bottom } : { left: 12, bottom: 60 };
        var col = function (title, kids, key) {
          return React.createElement('div', { className: PLUGIN + '-col', key: key },
            React.createElement('div', { className: PLUGIN + '-col-head', key: 'h' }, title), kids);
        };

        /* ---------------- 第 1 栏：关卡 ---------------- */

        var lvRows = [];
        if (status) {
          lvRows = lvRows.concat(cell('本机存档', status.localLow, 'a'));
          lvRows = lvRows.concat(cell('关卡数', String(status.levelCount), 'b'));
          if (cur) {
            lvRows = lvRows.concat(cell('当前关卡', cur.brand + ' / ' + cur.levelId, 'c'));
            lvRows = lvRows.concat(cell('账号', String(cur.accountId), 'd'));
            lvRows = lvRows.concat(cell('活文件', lua ? lua.name + '  ' + fmtSize(lua.size) : '需在编辑器里给容器节点挂脚本', 'e'));
            lvRows = lvRows.concat(cell('地图存档', cur.gil ? fmtSize(cur.gil.size) : '无', 'f'));
            lvRows = lvRows.concat(cell('日志局面', String(cur.logCount), 'g'));
            lvRows = lvRows.concat(cell('最近一局', cur.latestLog ? cur.latestLog.name : '—', 'h'));
          } else {
            lvRows = lvRows.concat(cell('提示', '没扫到关卡目录 —— 确认编辑器开过图，或检查 MILIASTRA_LOCALLOW', 'i'));
          }
        } else {
          lvRows = lvRows.concat(cell('状态', busy ? '读取中…' : '（未加载）', 'j'));
        }

        var mapRows = [];
        var mapDot = 'ok';
        if (mapInfo) {
          var lv = mapInfo.level || {};
          mapRows = mapRows.concat(cell('名称 / 版本', (lv.name || '（无名）') + '  v' + (mapInfo.version || '?'), 'm1'));
          mapRows = mapRows.concat(cell('客户端控件', mapInfo.controlCount + ' 条 · 可创建模板 ' + mapInfo.templateCount + ' 条', 'm2'));
        } else {
          mapRows = mapRows.concat(cell('地图', busy ? '读取中…' : '（无 .gil）', 'm4'));
        }
        if (mapInfo && mapInfo.dynamicCreateLikelyBroken) mapDot = 'err';
        var mapKids = [React.createElement(KVGrid, { rows: mapRows, key: 'kv' })];
        if (mapInfo && (mapInfo.templates || []).length) {
          mapKids.push(React.createElement('div', { key: 'pills' },
            mapInfo.templates.map(function (t) {
              return React.createElement('span', { className: PLUGIN + '-pill', key: t.id }, t.name + ' ' + t.id);
            })));
        }
        if (mapInfo && mapInfo.dynamicCreateLikelyBroken) {
          mapKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'warn' },
            '模板区没有独立模板 —— 脚本动态创建控件会全部返回 nil。请到「客户端控件模板」里把图片/文本框各存为一条独立模板，再保存地图。'));
        }

        // 关卡选择器：默认**自动跟随**（作者在编辑器里换图，面板自己切过去）；点某个关卡就切成手动
        var allLevels = (status && status.levels) || [];
        var autoId = status && status.current ? status.current.levelId : '';
        var lvKids = [];
        lvKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
          React.createElement('button', {
            className: PLUGIN + '-act' + (activeLevel ? '' : ' ' + PLUGIN + '-primary'),
            style: { padding: '3px 9px', fontSize: '11px' },
            onClick: function () { setActiveLevel(''); setActiveFile(''); },
            title: '跟着 miliastra_health 判定的「当前关卡」走',
          }, activeLevel ? '自动跟随' : '● 自动跟随'),
          React.createElement('span', { className: PLUGIN + '-hint', key: 'h' },
            activeLevel ? '已手动锁定 ' + activeLevel : '当前 ' + (autoId || '—'))));
        if (allLevels.length) {
          lvKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: 132 } },
            allLevels.map(function (x) {
              var on = x.levelId === (activeLevel || autoId);
              var lua = (x.luaFiles || []).map(function (f) { return f.name; }).join(',');
              return React.createElement('div', {
                key: x.accountId + '/' + x.levelId + '/' + x.layout,
                style: {
                  display: 'flex', gap: '6px', alignItems: 'center', margin: '3px 0', cursor: 'pointer',
                  color: on ? '#a5d8ff' : undefined, fontWeight: on ? 600 : 400,
                },
                title: x.brand + ' · 账号 ' + x.accountId + ' · ' + (x.layout === 'root-gil' ? '根目录图' : '本机图'),
                onClick: function () { setActiveLevel(x.levelId); setActiveFile(''); },
              },
                React.createElement('span', { style: { flex: '0 0 auto' } }, (on ? '● ' : '○ ') + x.levelId),
                React.createElement('span', {
                  style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, (x.brand === '原神' ? '' : 'Beta ') + (lua || '（无脚本）')),
                React.createElement('span', { style: { flex: '0 0 auto', opacity: .7 } },
                  x.gil ? Math.round(x.gil.size / 1024) + 'KB' : '—'));
            })));
        } else {
          lvKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, '没扫到关卡'));
        }

        var col1 = [
          sec('关卡', allLevels.length + ' 个', lvKids, 'secLv', activeLevel ? 'warn' : 'ok'),
          sec('关卡与文件', null, React.createElement(KVGrid, { rows: lvRows }), 'sec1', status ? 'ok' : 'warn'),
          sec('地图体检', '直接读 .gil', mapKids, 'sec2', mapDot),
        ];

        // 编辑器 / 游戏进程（best-effort；拿不到就显示"未知"，不影响别的）
        var pr = status && status.processes;
        if (pr) {
          var prRows = [];
          if (pr.available) {
            (pr.entries || []).forEach(function (e, i) {
              prRows = prRows.concat(cell(e.label,
                (e.running ? '✅ 在跑' : '— 未运行') + (e.running ? '  ' + e.instances + ' 实例 / ' + e.memoryMB + 'MB' : ''), 'p' + i));
            });
            prRows = prRows.concat(cell('能否试玩',
              pr.summary && pr.summary.canPlaytest ? '✅ 编辑器 + 游戏都在' : '⚠️ 需要编辑器与游戏进程同时在', 'p9'));
          } else {
            prRows = prRows.concat(cell('进程', '读不到（' + (pr.error || '未知') + '）', 'p0'));
          }
          col1.push(sec('进程', '免截图看环境', React.createElement(KVGrid, { rows: prRows }), 'secPr',
            pr.available && pr.summary && pr.summary.canPlaytest ? 'ok' : 'warn'));
        }

        /* ---------------- 第 2 栏：代码 ---------------- */

        var fileRows = [];
        if (fileInfo && fileInfo.inspected) {
          var fi = fileInfo.inspected;
          fileRows = fileRows.concat(cell('文件', basename(fi.path), 'f1'));
          fileRows = fileRows.concat(cell('大小 / 行数', fmtSize(fi.size) + ' / ' + fi.lineCount + ' 行', 'f2'));
          fileRows = fileRows.concat(cell('SHA-256', String(fi.sha256 || '').slice(0, 16) + '…', 'f3'));
          fileRows = fileRows.concat(cell('BOM', fi.bom ? '❌ 有 —— 会让 Lua 报错' : '✅ 无', 'f4'));
          fileRows = fileRows.concat(cell('编码', fi.utf8Ok ? '✅ 合法 UTF-8' : '❌ 非法 UTF-8', 'f5'));
          fileRows = fileRows.concat(cell('中文注释', fi.hasChinese ? '有' : '无', 'f6'));
        } else {
          fileRows = fileRows.concat(cell('活文件', busy ? '读取中…' : '（无）', 'f0'));
        }

        var scRows = [];
        var scDot = 'warn';
        if (scriptInfo) {
          var shaOf = function (o) { return o && o.sha256 ? String(o.sha256).slice(0, 10) : '—'; };
          var consistent = scriptInfo.match === true;
          scDot = consistent ? 'ok' : 'warn';
          scRows = scRows.concat(cell('结论', consistent ? '✅ 一致' : '❌ 不一致', 's1'));
          scRows = scRows.concat(cell('地图快照', shaOf(scriptInfo.embedded) + (scriptInfo.embedded ? '  ' + fmtSize(scriptInfo.embedded.bytes) : ''), 's2'));
          scRows = scRows.concat(cell('本地活文件', shaOf(scriptInfo.live), 's3'));
          if (!consistent) {
            scRows = scRows.concat(cell('怎么办', scriptInfo.embedded ? '在编辑器里存盘，把当前活文件写进地图' : '地图里没有脚本映射记录', 's4'));
          }
        } else {
          scRows = scRows.concat(cell('脚本一致', busy ? '读取中…' : '（未知）', 's0'));
        }

        var bkKids = [];
        var bkDot = 'ok';
        if (backups && backups.ok !== false) {
          bkKids.push(React.createElement(KVGrid, {
            rows: [].concat(
              cell('份数 / 位置', backups.count + ' 份  ' + String(backups.backupDir || '').split('\\').slice(-2).join('\\'), 'b1'),
              cell('固定名备份', backups.fixedBackup ? basename(backups.fixedBackup) : '（还没有）', 'b2'),
            ),
            key: 'kv',
          }));
          // 作者要求：备份要写在**被替换的文件旁边** + 固定统一的名字 + 明确提示还原操作。
          bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'where' }, BACKUP_NOTE));

          // ① 最省事的一条路：不挑版本，直接用固定名那份
          if (backups.fixedExists) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'fixed' },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary',
                disabled: busy,
                title: '把固定名那份（最近一次覆盖前的版本）写回活文件',
                onClick: function () { setPendingRestore(RESTORE_FIXED); setNote(''); setErr(''); },
              }, '还原到最新备份'),
              React.createElement('span', { className: PLUGIN + '-hint' },
                basename(backups.fixedBackup || '') + ' = 最近一次覆盖前的那一版')));
          } else if ((backups.count || 0) > 0) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'nofixed' },
              '还没有固定名备份（Host 可能是旧版 —— 重启 dsh web 后每次部署都会自动写一份）。下面可以逐条还原。'));
          }

          var totalBytes = (backups.entries || []).reduce(function (s, e) { return s + (e.size || 0); }, 0);
          if ((backups.count || 0) >= 20 || totalBytes > 5 * 1024 * 1024) {
            bkDot = 'warn';
            bkKids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'toomany' },
              '备份已 ' + backups.count + ' 份 / ' + fmtSize(totalBytes) + ' —— 不会自动删，要清理得自己去 _backup 目录收。'));
          }
          if ((backups.entries || []).length) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: 170 } },
              backups.entries.slice(0, 12).map(function (e) {
                return React.createElement('div', { key: e.path, style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '3px 0' } },
                  React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    (e.fixed ? '★ ' : '') + e.name + '  ' + e.size + 'B'
                    + (e.createdAt ? '  ' + String(e.createdAt).replace('T', ' ').slice(5, 19) : '')),
                  React.createElement('button', {
                    className: PLUGIN + '-act',
                    style: { padding: '2px 8px', fontSize: '11px' },
                    onClick: function () { setPendingRestore(e.path); setNote(''); setErr(''); },
                  }, '还原'));
              })));
            if (pendingRestore) {
              var isFixedPick = pendingRestore === RESTORE_FIXED;
              bkKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'confirm' },
                '确认用 ' + (isFixedPick ? basename(backups.fixedBackup || '固定名备份') + '（最新）' : basename(pendingRestore))
                + ' 覆盖当前活文件 ' + (activeFile || '') + ' ？'
                + '还原前会先把当前版本再备份一次；写完会校验 SHA，不一致会自动回滚。',
                React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
                  React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doRestore, disabled: busy, key: 'yes' }, '确认覆盖'),
                  React.createElement('button', { className: PLUGIN + '-act', onClick: function () { setPendingRestore(''); }, key: 'no' }, '取消'))));
            }
          } else {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'none' }, '还没有备份 —— 首次部署时自动产生。'));
          }
        } else {
          bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, busy ? '读取中…' : '（读取失败）'));
        }

        // 活文件选择器：**一个关卡可以有多个 .lua**，先明确"现在操作哪一个"，再谈其他
        var allFiles = (cur && cur.luaFiles) || [];
        var fileSelKids = [];
        if (allFiles.length) {
          fileSelKids.push(React.createElement('div', { key: 'pills' },
            allFiles.map(function (f) {
              var on = f.name === activeFile;
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: f.name,
                title: f.path,
                style: on
                  ? { cursor: 'pointer', background: 'linear-gradient(135deg,rgba(125,211,252,.40),rgba(249,168,212,.40))', borderColor: 'rgba(125,211,252,.65)', color: '#0d1626', fontWeight: 600 }
                  : { cursor: 'pointer' },
                onClick: function () {
                  if (on) return;
                  setActiveFile(f.name);
                  setPendingRestore('');
                  setLogs([]);
                },
              }, (on ? '● ' : '') + f.name + '  ' + fmtSize(f.size));
            })));
          fileSelKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'h' },
            allFiles.length > 1
              ? '共 ' + allFiles.length + ' 个活文件 —— 下面所有操作（体检 / 比对 / 备份 / 部署 / 还原）都只作用于选中的这个'
              : '该关卡只有 1 个活文件'));
        } else {
          fileSelKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, '该关卡还没有活文件 —— 先在编辑器里给容器节点挂客户端脚本'));
        }

        var col2 = [
          sec('活文件', '选中的那个才被操作', fileSelKids, 'secSel', allFiles.length ? 'ok' : 'warn'),
          sec('活文件体检', null, React.createElement(KVGrid, { rows: fileRows }), 'secF',
            fileInfo && fileInfo.inspected && fileInfo.inspected.bom ? 'err' : 'ok'),
          sec('脚本一致性', '地图 vs 活文件', React.createElement(KVGrid, { rows: scRows }), 'secS', scDot),
          sec('备份', '覆盖前的安全网', bkKids, 'secB', bkDot),
          sec('部署到活文件', null, [
            React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
              React.createElement('input', {
                className: PLUGIN + '-inp',
                placeholder: '本地 .lua 绝对路径',
                value: srcPath,
                onChange: function (e) { setSrcPath(e.target.value); },
                key: 'in',
              }),
              React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doDeploy, disabled: busy, key: 'dp' }, '部署')),
            React.createElement('div', { className: PLUGIN + '-hint', key: 'h' },
              '覆盖前自动备份（写在活文件旁边的 _backup\\，固定名 + 带时间戳各一份） · 原子写（断电不会留半截文件） · 校验 SHA-256 · 拒收带 BOM / 非法 UTF-8'),
          ], 'secD', 'ok'),
        ];

        /* ---------------- 第 3 栏：日志 ---------------- */

        var logRows = [];
        if (cur) {
          logRows = logRows.concat(cell('局面数', String(cur.logCount), 'l1'));
          logRows = logRows.concat(cell('最近一局', cur.latestLog ? cur.latestLog.name : '—', 'l2'));
        }
        if (tags.length) {
          logRows = logRows.concat(cell('标签数', String(tags.length), 'l3'));
        }
        var logKids = [];
        if (logRows.length) logKids.push(React.createElement(KVGrid, { rows: logRows, key: 'kv' }));
        logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
          React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: function () { doLogs(tagFilter); }, disabled: busy, key: 't' }, '取日志'),
          React.createElement('button', { className: PLUGIN + '-act', onClick: doTags, disabled: busy, key: 'g' }, 'TAG 汇总'),
          React.createElement('button', {
            className: PLUGIN + '-act' + (autoLog ? ' ' + PLUGIN + '-primary' : ''),
            style: { padding: '5px 10px', fontSize: '11px' },
            key: 'auto',
            title: '盯着日志文件：新的一局出现、或文件还在变大，就说明试玩在动；安静 6 秒后自动取回那一局。',
            onClick: function () { setAutoLog(!autoLog); },
          }, autoLog ? '试玩完自动取：开' : '试玩完自动取：关')));
        if (autoLog) {
          logKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'autostat' },
            autoState
              ? React.createElement('span', null,
                React.createElement('b', null, autoPhaseMark(autoState.phase)),
                ' ' + autoState.reason
                + (autoState.name && autoState.phase !== 'idle' ? '（局 ' + shortSessionName(autoState.name) + '）' : ''))
              : React.createElement('span', null, '正在守望日志文件…（每 4 秒看一次）')));
        }
        logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r2' },
          React.createElement('input', {
            className: PLUGIN + '-inp',
            placeholder: '按 TAG 过滤（如 P5D）',
            value: tagFilter,
            onChange: function (e) { setTagFilter(e.target.value); },
            key: 'fi',
          })));
        if (tags.length) {
          logKids.push(React.createElement('div', { key: 'tagpills' },
            tags.slice(0, 14).map(function (t) {
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: t.tag,
                style: { cursor: 'pointer' },
                onClick: function () { setTagFilter(t.tag); doLogs(t.tag); },
                title: '点一下只看这个标签',
              }, t.tag + '×' + t.count);
            })));
        }
        // 历史局面：点某一局就看那一局（默认最新那局）
        if (sessions.length) {
          logKids.push(React.createElement('div', { key: 'sess' },
            sessions.slice(0, 10).map(function (s) {
              var on = s.name === activeSession || (!activeSession && sessions[0] && s.name === sessions[0].name);
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: s.name,
                title: s.mtime + '  ' + s.size + 'B',
                style: on
                  ? { cursor: 'pointer', background: 'linear-gradient(135deg,rgba(125,211,252,.40),rgba(249,168,212,.40))', borderColor: 'rgba(125,211,252,.65)', color: '#0d1626', fontWeight: 600 }
                  : { cursor: 'pointer' },
                onClick: function () { setTagFilter(''); doLogs('', s.name); },
              }, (on ? '● ' : '') + s.name.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_\d+_\d+\.gia$/, ''));
            })));
        }
        if (logs.length) {
          var badCount = logs.filter(function (x) { return x.bad; }).length;
          var warnCount = logs.filter(function (x) { return x.warn; }).length;
          var shown = onlyBad ? logs.filter(function (x) { return x.bad || x.warn; }) : logs;
          logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'lbar' },
            React.createElement('span', { className: PLUGIN + '-hint' },
              logs.length + ' 行' + (badCount ? ' · 疑似异常 ' + badCount : '') + (warnCount ? ' · 警告 ' + warnCount : '')),
            React.createElement('button', {
              className: PLUGIN + '-act' + (onlyBad ? ' ' + PLUGIN + '-primary' : ''),
              style: { padding: '2px 9px', fontSize: '10.5px', marginLeft: 'auto' },
              key: 'ob',
              title: '按关键词粗筛（错误/失败/异常/error…）。这只是一个过滤器，判据仍以正文为准。',
              onClick: function () { setOnlyBad(!onlyBad); },
            }, onlyBad ? '显示全部' : '只看异常')));
          if (!shown.length) {
            logKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'lb' },
              '这一批里没有疑似异常的行（关键词粗筛，不代表一定没问题）'));
          } else {
            logKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'log' },
              shown.map(LogRow)));
          }
        }

        /*
         * 探针卡片 —— 这一段文案是**给使用者看的**，不是给实现者看的。
         *
         * 之前写「探针 / 只读诊断脚本」+ 三个光秃秃的 ping / tree / instantiate，
         * 作者本人的反馈是「没看懂探针作用」。所以现在：
         *   ① 顶部先把「探针是什么 / 为什么需要 / 代价是什么」讲清楚；
         *   ② 每个模板显示「大白话名 + 一句话」，选中的那个再展开 what/when；
         *   ③ 四步流程直接写在卡片上（含最后一步「还原你的脚本」），并且真的给一键还原。
         * 模板清单与说明来自 Host 的 `op=list`（单一口径），拿不到才用兜底文案。
         */
        var probeMeta = (probeInfo && probeInfo.templates && probeInfo.templates.length)
          ? probeInfo
          : { templates: PROBE_FALLBACK.map(function (x) { return x.template; }), info: PROBE_FALLBACK, overview: PROBE_OVERVIEW_FALLBACK };
        var probeById = {};
        (probeMeta.info || []).forEach(function (x) { if (x && x.template) probeById[x.template] = x; });
        var curInfo = probeById[probeTemplate] || { label: probeTemplate, oneLine: '', what: '', when: '' };
        var ov = probeMeta.overview || {};

        var probeKids = [];

        // ⚠️ Host 代码是**启动时 import** 的：`patchReload: live` 不会重新 import Host 模块，
        // 所以「磁盘上加了新模板」≠「跑着的 Host 认这个模板」。这里显式报出来，
        // 否则用户只会看到「面板少了一个按钮」而不知道为什么。
        var knownTpls = PROBE_FALLBACK.map(function (x) { return x.template; });
        var hostTpls = probeMeta.templates || [];
        var missingOnHost = knownTpls.filter(function (t) { return hostTpls.indexOf(t) < 0; });
        if (missingOnHost.length) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'stale' },
            '⚠️ 运行中的 Host 是旧版：它只认 ' + hostTpls.length + ' 个探针，少了 ' + missingOnHost.join('、')
            + '。重启 dsh web 之后才会出现 —— 光刷新这个页面不够（Host 代码是启动时加载的）。'));
        }

        // ① 这是什么（大白话）
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'what' },
          React.createElement('div', null, React.createElement('b', null, '探针是干嘛的：'), ov.what || '临时替掉你脚本的一小段程序，试玩时跑一次，把游戏内部信息打到日志里。'),
          React.createElement('div', { style: { marginTop: '3px' } }, React.createElement('b', null, '什么时候用：'), ov.why || '有些事光看代码看不出来，得让游戏真跑一遍。'),
          React.createElement('div', { style: { marginTop: '3px' } }, React.createElement('b', null, '要付什么代价：'), ov.cost || '会临时覆盖活文件，试玩那一局你的玩法不会跑（自动备份，用完可一键还原）。')));

        // ② 四步流程
        probeKids.push(React.createElement('div', { className: PLUGIN + '-kv', key: 'steps' },
          React.createElement('span', { className: PLUGIN + '-k' }, '流程'),
          React.createElement('span', { className: PLUGIN + '-v' },
            (ov.steps && ov.steps.length ? ov.steps : ['选探针', '部署', '重新试玩一局', '收回结论 + 还原脚本'])
              .map(function (s, i) { return React.createElement('span', { key: 's' + i },
                React.createElement('span', { className: PLUGIN + '-pill' }, String(i + 1) + '. ' + s),
                i < 3 ? ' ' : null); }))));

        // ③ 选一个探针（大白话名 + 一句话）
        probeKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'tpl' },
          (probeMeta.templates || []).map(function (t) {
            var m = probeById[t] || {};
            return React.createElement('button', {
              className: PLUGIN + '-act' + (probeTemplate === t ? ' ' + PLUGIN + '-primary' : ''),
              style: { padding: '3px 9px', fontSize: '11px' },
              title: (m.what ? m.what + ' ' : '') + (m.when ? '什么时候用：' + String(m.when).replace(/<[^>]+>/g, '') : ''),
              key: t,
              onClick: function () { setProbeTemplate(t); setProbeResult(null); },
            }, (m.label || t) + '（' + t + '）');
          })));

        // ④ 选中那个的详细说明 —— 「这个探针能帮我回答什么问题」
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'sel' },
          React.createElement('div', null, React.createElement('b', null, curInfo.label + '（' + probeTemplate + '）'), '：', curInfo.oneLine || ''),
          curInfo.what ? React.createElement('div', { style: { marginTop: '3px' }, dangerouslySetInnerHTML: { __html: '做什么：' + curInfo.what } }) : null,
          curInfo.when ? React.createElement('div', { style: { marginTop: '3px' }, dangerouslySetInnerHTML: { __html: '什么时候点它：' + curInfo.when } }) : null));

        probeKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'tag' },
          React.createElement('input', {
            className: PLUGIN + '-inp',
            placeholder: '日志标签（如 P1）',
            value: probeTag,
            onChange: function (e) { setProbeTag(e.target.value); },
            key: 'i',
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: busy, key: 'dp',
            onClick: function () { setPendingProbe(true); setNote(''); setErr(''); },
          }, '① 部署探针'),
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: busy, key: 'co',
            onClick: doCollectProbe,
          }, '③ 收回结论')));

        // ① 和 ③ 之间那一步**必须人来做**，所以单独写一行说明，别让编号看着像缺了一块
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'step2' },
          React.createElement('span', { className: PLUGIN + '-pill' }, '②'),
          ' 这一步得你手动做：到编辑器里「停止试玩 → 重新试玩一局」（部署不会热加载）。'
          + '起来后等 3~5 秒让探针打完字，再回来点 ③。'));

        if (pendingProbe) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'warn' },
            '⚠️ 这一步会用探针源码覆盖活文件 ' + (activeFile || '（当前选中）') + '（Host 会先自动备份）。'
            + '覆盖后在编辑器里「停止试玩 → 重新试玩一局」才会生效，否则跑的还是旧脚本。',
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
              React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doDeployProbe, disabled: busy, key: 'y' }, '确认覆盖'),
              React.createElement('button', { className: PLUGIN + '-act', onClick: function () { setPendingProbe(false); }, key: 'n' }, '取消'))));
        }

        // 已部署 → 提醒第 2 步，并给出第 4 步「还原我的脚本」的一键按钮
        if (probeBackup) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'deployed' },
            React.createElement('div', null, '✅ 探针已部署 —— 现在请去编辑器里重新试玩一局（第 2 步）。'),
            React.createElement('div', { style: { marginTop: '3px' } }, '试玩完回来点「③ 收回结论」；拿完结论记得还原你的脚本（第 4 步）—— 否则活文件一直是探针，你的玩法不会跑。'),
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: busy, key: 'rs',
                title: '用部署探针前自动生成的那份备份覆盖回去',
                onClick: doRestoreProbe,
              }, '④ 还原我的脚本'))));
        }
        if (probeResult && probeResult.hit) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'res', style: { maxHeight: 150 } },
            (probeResult.lines || []).join('\n')));
        } else if (probeResult) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'no' },
            '这一局里没有 [' + probeResult.tag + '] 的输出。两个最常见原因：'
            + '① 部署后没有重新试玩（部署不会热加载）；② 探针起来了但试玩结束太快（等 3~5 秒再退）。'));
        }

        /*
         * 「读界面控件」—— 高级诊断区的第一块。
         *
         * 这是**静态**读（从 `.gil` 存档读），不改任何文件、不用试玩，所以放在折叠区里也没风险；
         * 想要**运行时**的控件树（脚本眼里实际挂了什么）就去点下面的探针「看控件」。
         *
         * 为什么它重要：写客户端脚本最缺的两个号 —— 容器节点索引 / 控件模板索引 ——
         * 以前得靠人抄或写探针试，现在这里直接读出来。
         */
        var uiKids = [];
        uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'what' },
          '从地图存档里直接读「界面控件谱系」（模板索引 / 名字 / 父子）。'
          + '静态读取，不改任何文件、不用试玩。写脚本要的「容器节点索引 / 控件模板索引」就在这里。'));
        uiKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'btn' },
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: uiBusy || busy, key: 'r',
            onClick: doReadUi,
          }, uiBusy ? '读取中…' : '读界面控件')));

        if (uiInfo && uiInfo.ok !== false) {
          var realTemplates = (uiInfo.likelyTemplates || []).filter(function (x) { return x.name !== '容器节点'; });
          var containerNodes = (uiInfo.records || []).filter(function (x) { return x.name === '容器节点'; });

          // ① 真正能被脚本创建的模板 —— 这是写脚本直接要用的号
          uiKids.push(React.createElement('div', { key: 'tpl' },
            React.createElement('div', { className: PLUGIN + '-hint' },
              React.createElement('b', null, '可被脚本创建的控件模板（' + realTemplates.length + ' 个）'),
              ' —— 写 game.InstantiateClientUIControl 就用这些号'),
            realTemplates.length
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'l', style: { maxHeight: 120 } },
                realTemplates.map(function (x) {
                  return React.createElement('div', { key: x.id, style: { display: 'flex', gap: '8px' } },
                    React.createElement('span', { style: { flex: '1 1 auto' } }, x.name),
                    React.createElement('span', { style: { fontFamily: 'ui-monospace,Consolas,monospace', color: '#a5d8ff' } }, String(x.id)));
                }))
              : React.createElement('div', { className: PLUGIN + '-err', key: 'none' },
                '⚠️ 一个都没有 —— 说明「客户端控件模板库」是空的。'
                + '这时脚本动态创建任何控件都会返回 nil。'
                + '请到 界面控件组管理 → 界面控件组库 → 客户端控件模板 →【添加客户端控件】各存一条独立模板，然后保存地图。')));

          // ② 容器节点 —— 不一定能创建，但常被当成「容器节点索引」用
          uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'cnt' },
            React.createElement('b', null, '容器节点（' + containerNodes.length + ' 个）'),
            '：',
            containerNodes.map(function (x) { return x.id; }).join(' / ') || '（无）',
            '　—— 画布上摆的容器实例，不能被脚本创建（但脚本要挂东西时认的就是这类号）'));

          // ③ 全部记录（默认折叠，别一上来铺 37 行）
          uiKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'all' },
            React.createElement('button', {
              className: PLUGIN + '-act', style: { padding: '2px 9px', fontSize: '10.5px' }, key: 't',
              onClick: function () { setUiRaw(!uiRaw); },
            }, (uiRaw ? '收起' : '展开') + '全部 ' + (uiInfo.count || 0) + ' 条记录')));
          if (uiRaw) {
            uiKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'raw', style: { maxHeight: 220 } },
              (uiInfo.records || []).map(function (x) {
                return React.createElement('div', { key: x.id },
                  (x.parent == null ? '● ' : '└ ') + x.id + '  ' + x.name
                  + (x.parent == null ? '  （无父节点）' : '  ← ' + x.parent));
              })));
          }
          uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'tip' },
            '提示：「无父节点」只是「候选」条件。实测本关 1073741867(文本框) / 1073741868(图片) 真能被创建，'
            + '而 1073741863~1866（画布上的实例）一律返回 nil。想确证某个号能不能创建，用探针「试钥匙」。'));
        }

        var col3 = [
          sec('运行时日志', '读 .gia', logKids, 'secL', 'ok'),
          /*
           * 「高级诊断」折叠卡片：探针**默认收起**。
           * 作者的原话：「折腾探针对人没啥用啊」—— 他是对的：探针解决的是「我写代码时不知道某件事」
           * 这种 AI 侧的问题，而创作者要为它付出四次手工操作。所以降级成折叠区，
           * 并且把「这是给 AI 用的」直接写在标题上，而不是等用户点开才明白。
           */
          /*
           * 「高级诊断」折叠卡片，里面两块**风险完全不同**，所以要分开标：
           *   ① 读界面控件 —— **只读**（从 .gil 读），不会碰你的脚本，作者自己也能用
           *   ② 探针 —— 会**临时覆盖**活文件，主要给 AI 排障用
           * 作者的原话：「折腾探针对人没啥用啊」+「关键 ui 读取……做到高级功能里面做个样子」。
           */
          React.createElement('div', { className: PLUGIN + '-sec', key: 'secAdv' },
            React.createElement('div', {
              className: PLUGIN + '-fold-title',
              key: 'ft',
              title: '点一下' + (advOpen ? '收起' : '展开'),
              onClick: function () { setAdvOpen(!advOpen); },
            },
              React.createElement('span', { className: PLUGIN + '-dot warn' }),
              '高级诊断（读界面控件 / 探针）',
              React.createElement('span', { className: PLUGIN + '-onlyai' }, advOpen ? '' : '平时不用展开'),
              React.createElement('span', { className: PLUGIN + '-hint' }, advOpen ? '▾' : '▸')),
            React.createElement('div', { className: PLUGIN + '-hint' }, advOpen
              ? '① 读界面控件是只读的（从地图存档读，不碰任何文件）；② 探针会临时覆盖你的脚本。'
              : '平时不用展开。里面「读界面控件」是只读安全的；「探针」会临时覆盖你的脚本。'),
            advOpen
              ? React.createElement('div', null,
                React.createElement('div', { className: PLUGIN + '-hint', style: { marginTop: '2px', fontWeight: 600, color: '#7dd3fc' } },
                  '① 读界面控件（只读 · 不改任何文件）'),
                React.createElement('div', null, uiKids),
                React.createElement('div', { className: PLUGIN + '-hint', style: { marginTop: '8px', fontWeight: 600, color: '#f9a8d4' } },
                  '② 探针（⚠️ 会临时覆盖你的脚本 —— 主要给 AI 排障用）'),
                React.createElement('div', null, probeKids))
              : null),
        ];

        var kids = [
          React.createElement('div', { className: PLUGIN + '-head', key: 'head' },
            React.createElement(Icon, { k: 'mk' }),
            React.createElement('span', { className: PLUGIN + '-title', key: 'ti' }, 'Miliastra Wonderland'),
            React.createElement('span', { className: PLUGIN + '-badge', key: 'bg' }, '千星奇域'),
            React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
            React.createElement('button', {
              className: PLUGIN + '-act', onClick: function () { load(false); }, disabled: busy, key: 'rf',
              style: { padding: '3px 10px', fontSize: '11.5px' },
            }, busy ? '刷新中…' : '刷新'),
            React.createElement('button', { className: PLUGIN + '-x', onClick: function () { setOpen(false); }, title: '关闭', key: 'x' }, '×')),
        ];
        if (err) kids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'err', style: { margin: '9px 13px 0' } }, String(err)));
        if (note) kids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'note', style: { margin: '9px 13px 0' } }, String(note)));
        kids.push(React.createElement('div', { className: PLUGIN + '-body', key: 'body' }, [
          col('① 关卡', col1, 'c1'),
          col('② 代码', col2, 'c2'),
          col('③ 日志', col3, 'c3'),
        ]));

        return React.createElement('div', { className: PLUGIN + '-panel', style: anchorStyle }, kids);
      }

      /* ---------------------------------------------------------------- 入口 */

      function FooterAction(props) {
        var wide = !!(props && props.wide);
        var s = React.useState(false); var open = s[0]; var setOpen = s[1];
        var rootRef = React.useRef(null);
        return React.createElement('div', { className: PLUGIN + '-root', ref: rootRef },
          React.createElement('button', {
            className: PLUGIN + '-btn' + (wide ? '' : ' ' + PLUGIN + '-rail'),
            title: 'Miliastra Wonderland · 千星奇域',
            'aria-label': '千星奇域',
            onClick: function () { setOpen(!open); },
          },
          React.createElement(Icon, {}),
          wide ? React.createElement('span', { className: PLUGIN + '-label' }, '千星奇域') : null),
          React.createElement(Panel, { open: open, setOpen: setOpen, rootRef: rootRef }));
      }

      exports.name = PLUGIN;
      // 仅供本地渲染测试：把面板组件交出去，好在 **SSR 下真渲染一遍**（空状态），
      // 抓「卡片被写坏 / 少一个孩子」这类一渲染就炸的错。
      exports.__testPanel = Panel;
      // 日志格式化的两个纯函数也交出去 —— 拆分/判色这些逻辑值得单独回归（不必渲染整面板）。
      exports.__testParseLogRecord = parseLogRecord;
      exports.__testToLogRows = toLogRows;
      exports.__testLogRow = LogRow;
      // 「试玩完自动取」的判据是纯函数 —— 定时器不好测，判据必须能测。
      exports.__testAutoFollowStep = autoFollowStep;
      exports.__testShortSessionName = shortSessionName;
      exports.__testAutoPhaseMark = autoPhaseMark;
      // ⚠️ **必须声明 `slots`**。cordis 的服务代理是受限的：不声明就直接读 `ctx.slots`
      //    会抛 `cannot get property "slots" without inject`，而且会让**整条 loader entry 失败**
      //    （表现为「插件没生效」+ 页面上一条我们的日志都没有）。
      //    声明后 cordis 会等该服务就绪再调 apply。
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        var disposers = [];
        var push = function (d) { if (typeof d === 'function') disposers.push(d); };

        // 服务一律走「安全读」：即使 ctx 是受限代理也不会抛。
        var slotsSvc = null;
        try { slotsSvc = (ctx && ctx.slots) || null; } catch (e) { slotsSvc = null; }

        try {
          console.log('[' + PLUGIN + '] apply 运行中：react=' + (React ? '有' : '无')
            + '  ctx.slots=' + (slotsSvc ? '有' : '无')
            + '  ctx.slots.inject=' + (slotsSvc && typeof slotsSvc.inject === 'function' ? '有' : '无')
            + '  ctx.effect=' + (ctx && typeof ctx.effect === 'function' ? '有' : '无'));

          if (!React) { console.warn('[' + PLUGIN + '] react 不可用，面板未注册'); }
          else if (!slotsSvc || typeof slotsSvc.inject !== 'function') {
            console.warn('[' + PLUGIN + '] slots 服务不可用，面板未注册');
          } else {
            push(typeof ctx.effect === 'function' ? ctx.effect(injectStyle, PLUGIN + ': style') : injectStyle());

            var declared = false;
            push(slotsSvc.inject('sidebar.footer.action', function () {
              declared = true;
              console.log('[' + PLUGIN + '] 槽位 sidebar.footer.action 的声明到达 —— 正在注册入口');
              var unregister = slotsSvc.register({
                name: 'sidebar.footer.action',
                id: PLUGIN,
                order: 120,
              }, FooterAction);
              console.log('[' + PLUGIN + '] 入口已注册到 sidebar.footer.action（id=' + PLUGIN + ', order=120）');
              return function () { try { unregister(); } catch (e) { /* ignore */ } };
            }));

            // 诊断计时器：3 秒内没等到槽位声明 = 这一版壳没渲染该槽位（或名字变了）。
            // 这是 client 半边最容易"静默失败"的一条路，所以显式报出来。
            var probeTimer = setTimeout(function () {
              if (!declared) {
                console.warn('[' + PLUGIN + '] 3 秒内没等到 sidebar.footer.action 的声明 —— '
                  + '这一版壳可能根本没渲染该槽位，或槽位名变了。'
                  + '可跑 window.__DSH_BOOT__.entries.map(e=>e.id) 确认 bundle 是否已进启动图。');
              }
            }, 3000);
            push(function () { clearTimeout(probeTimer); });
          }
        } catch (e) {
          // 绝不 throw：Client 半边抛错会让整个 Web 壳起不来
          console.warn('[' + PLUGIN + '] 面板注册失败：', e);
        }

        // 返回聚合 cleanup：既满足宿主 ctx.effect 的回收，也让「卸载后重挂不留幽灵」可被自测验证。
        return function () {
          for (var i = disposers.length - 1; i >= 0; i -= 1) {
            try { disposers[i](); } catch (e) { /* ignore */ }
          }
          disposers.length = 0;
        };
      };

      return module.exports;
    },
  });
})();
