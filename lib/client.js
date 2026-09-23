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
        '.' + PLUGIN + '-log{margin-top:5px;max-height:210px;overflow:auto;border-radius:9px;padding:7px 9px;',
        'background:rgba(4,10,20,.42);border:1px solid rgba(125,211,252,.12);',
        'font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-all;color:#c9dcf5;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar{width:8px;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar-thumb{background:rgba(125,211,252,.30);border-radius:8px;}',
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

      /* ---------------------------------------------------------------- 面板 */

      function Panel(props) {
        var open = props.open;
        var setOpen = props.setOpen;
        var rootRef = props.rootRef;

        var s1 = React.useState(null); var status = s1[0]; var setStatus = s1[1];
        var s2 = React.useState(false); var busy = s2[0]; var setBusy = s2[1];
        var s3 = React.useState(''); var err = s3[0]; var setErr = s3[1];
        var s4 = React.useState([]); var logs = s4[0]; var setLogs = s4[1];
        var s5 = React.useState(''); var srcPath = s5[0]; var setSrcPath = s5[1];
        var s6 = React.useState(''); var note = s6[0]; var setNote = s6[1];
        var s7 = React.useState(null); var anchor = s7[0]; var setAnchor = s7[1];
        var s8 = React.useState(null); var mapInfo = s8[0]; var setMapInfo = s8[1];
        var s9 = React.useState(null); var scriptInfo = s9[0]; var setScriptInfo = s9[1];
        var s10 = React.useState(null); var fileInfo = s10[0]; var setFileInfo = s10[1];
        var s11 = React.useState(null); var backups = s11[0]; var setBackups = s11[1];
        var s12 = React.useState([]); var tags = s12[0]; var setTags = s12[1];
        var s13 = React.useState(''); var tagFilter = s13[0]; var setTagFilter = s13[1];
        var s14 = React.useState(''); var pendingRestore = s14[0]; var setPendingRestore = s14[1];
        /**
         * 当前选中的活文件名。
         * ⚠️ **一个关卡可以有多个 `.lua`**（不同角色 / 不同模块各挂一个客户端脚本），
         *    所以「当前文件」必须是显式状态，所有 op（体检/备份/比对/部署/还原）都跟着它走。
         */
        var s15 = React.useState(''); var activeFile = s15[0]; var setActiveFile = s15[1];

        /**
         * 拉状态。
         * @param {boolean} light 轻量刷新（只拉状态 + 地图），供 15 秒轮询用；
         *                        全量（含活文件体检 / 备份 / 标签）在打开面板与点「刷新」时走。
         */
        var load = React.useCallback(function (light) {
          setBusy(true); setErr('');
          callTool('miliastra_health', {}).then(function (r) {
            if (!r.ok) { setBusy(false); setErr(r.error || '未知错误'); return null; }
            setStatus(r);

            // 一个关卡可能有多个活文件 —— 确保 activeFile 是有效的那个；
            // 有效就留着（不打断用户的选择），失效/为空才重新挑（挑列表第一个 = 面板展示顺序）。
            var files = (r.current && r.current.luaFiles) || [];
            var stillThere = !!activeFile && files.some(function (f) { return f.name === activeFile; });
            var pick = stillThere ? activeFile : (files[0] ? files[0].name : '');
            if (pick !== activeFile) {
              setActiveFile(pick);
              setBusy(false);
              return null; // activeFile 变了会重建 load 并重跑，下一趟就会带上正确的 file
            }
            var F = pick ? { file: pick } : {};

            return callTool('miliastra_map', Object.assign({ op: 'summary' }, F)).then(function (m) {
              setMapInfo(m && m.ok !== false ? m : null);
              return callTool('miliastra_map', Object.assign({ op: 'script' }, F)).then(function (sc) {
                setScriptInfo(sc && sc.ok !== false ? sc : null);
                if (light) { setBusy(false); return null; }
                return callTool('miliastra_code', Object.assign({ op: 'inspect' }, F)).then(function (fi) {
                  setFileInfo(fi && fi.ok !== false ? fi : null);
                  return callTool('miliastra_code', Object.assign({ op: 'backups' }, F)).then(function (bk) {
                    setBackups(bk && bk.ok !== false ? bk : null);
                    return callTool('miliastra_log', { op: 'tags' }).then(function (tg) {
                      if (tg && tg.ok !== false && tg.tags) setTags(tg.tags);
                      setBusy(false);
                    });
                  });
                });
              });
            });
          }).catch(function (e) {
            setBusy(false);
            setErr(String((e && e.message) || e));
          });
        }, [activeFile]);

        React.useEffect(function () { if (open) load(false); }, [open, load]);

        React.useEffect(function () {
          if (!open) return undefined;
          var t = setInterval(function () { load(true); }, 15000);
          return function () { clearInterval(t); };
        }, [open, load]);

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

        var doLogs = function (tag) {
          var args = { op: 'tail', limit: 60 };
          if (tag) { args.op = 'grep'; args.tag = tag; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', args).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setLogs((r.records || []).map(function (x) { return (x.time || '') + '  ' + (x.message || ''); }));
              setNote(tag ? '已按标签 ' + tag + ' 过滤（' + (r.records || []).length + ' 条）' : '最近 60 条（' + (r.records || []).length + ' 条）');
            } else setErr(r.error || '读日志失败');
          });
        };

        var doTags = function () {
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', { op: 'tags' }).then(function (r) {
            setBusy(false);
            if (r.ok) { setTags(r.tags || []); setNote('读到 ' + (r.tags || []).length + ' 个标签'); }
            else setErr(r.error || '读标签失败');
          });
        };

        var doDeploy = function () {
          if (!srcPath) { setErr('请填本地 .lua 的绝对路径'); return; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_code', { op: 'deploy', source: srcPath, file: activeFile }).then(function (r) {
            setBusy(false);
            if (r.ok) setNote('已部署 ' + (r.bytes || 0) + ' 字节 · sha=' + String(r.sha256 || '').slice(0, 12) + ' · 备份' + (r.backup ? '已生成（' + basename(r.backup) + '）' : '无'));
            else setErr(r.error || ((r.errors || []).join('；') || '部署失败'));
            load(false);
          });
        };

        // ⚠️ 还原会**覆盖活文件** —— 所以固定两步：先选中（pendingRestore），再显式点「确认覆盖」。
        var doRestore = function () {
          if (!pendingRestore) return;
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_code', { op: 'restore', backup: pendingRestore, file: activeFile }).then(function (r) {
            setBusy(false);
            setPendingRestore('');
            if (r.ok) setNote('已从 ' + basename(r.restoredFrom) + ' 还原 · 当前 sha=' + String(r.sha256 || '').slice(0, 12)
              + (r.safetyBackup ? ' · 还原前的版本已存为 ' + basename(r.safetyBackup) : ''));
            else setErr(r.error || ((r.errors || []).join('；') || '还原失败'));
            load(false);
          });
        };

        if (!open) return null;

        var cur = status && status.current;
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

        var col1 = [
          sec('关卡与文件', null, React.createElement(KVGrid, { rows: lvRows }), 'sec1', status ? 'ok' : 'warn'),
          sec('地图体检', '直接读 .gil', mapKids, 'sec2', mapDot),
        ];

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
            rows: cell('份数 / 位置', backups.count + ' 份  ' + String(backups.backupDir || '').split('\\').slice(-2).join('\\'), 'b1'),
            key: 'kv',
          }));
          var totalBytes = (backups.entries || []).reduce(function (s, e) { return s + (e.size || 0); }, 0);
          if ((backups.count || 0) >= 20 || totalBytes > 5 * 1024 * 1024) {
            bkDot = 'warn';
            bkKids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'toomany' },
              '备份已 ' + backups.count + ' 份 / ' + fmtSize(totalBytes) + ' —— **不会自动删**，要清理得自己去 _backup 目录收。'));
          }
          if ((backups.entries || []).length) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: 170 } },
              backups.entries.slice(0, 12).map(function (e) {
                return React.createElement('div', { key: e.path, style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '3px 0' } },
                  React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    e.name + '  ' + e.size + 'B'),
                  React.createElement('button', {
                    className: PLUGIN + '-act',
                    style: { padding: '2px 8px', fontSize: '11px' },
                    onClick: function () { setPendingRestore(e.path); setNote(''); setErr(''); },
                  }, '还原'));
              })));
            if (pendingRestore) {
              bkKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'confirm' },
                '确认用 ' + basename(pendingRestore) + ' 覆盖当前活文件？',
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
            React.createElement('div', { className: PLUGIN + '-hint', key: 'h' }, '覆盖前自动备份 · 校验 SHA-256 · 拒收带 BOM / 非法 UTF-8'),
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
          React.createElement('button', { className: PLUGIN + '-act', onClick: doTags, disabled: busy, key: 'g' }, 'TAG 汇总')));
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
        if (logs.length) {
          logKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'log', style: { maxHeight: 300 } }, logs.join('\n')));
        }
        var col3 = [sec('运行时日志', '读 .gia', logKids, 'secL', 'ok')];

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
