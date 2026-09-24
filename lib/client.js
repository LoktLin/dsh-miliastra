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
        // 视图模式（会话区全宽 tab）：宽屏下自动分栏，别把两栏挤在一条窄列里
        '.' + PLUGIN + '-inline{overflow:auto;}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-body{grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-height:none;}',
        // 浮层里的三个页面切换（平铺成三等分）
        '.' + PLUGIN + '-viewtabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:8px 13px 0;}',
        '.' + PLUGIN + '-vtab{padding:5px 10px;border-radius:999px;border:1px solid rgba(125,211,252,.28);',
        'background:transparent;color:var(--dsw-alias-label-secondary,#8fa6c4);font-size:11.5px;cursor:pointer;text-align:center;}',
        '.' + PLUGIN + '-vtab:hover{border-color:#7dd3fc;color:#e2e8f0;}',
        '.' + PLUGIN + '-vtab-on{background:linear-gradient(135deg,rgba(125,211,252,.28),rgba(249,168,212,.28));',
        'border-color:#7dd3fc;color:#e2e8f0;font-weight:600;}',
        '.' + PLUGIN + '-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;',
        'padding:11px 13px 13px;flex:1 1 auto;min-height:0;overflow:hidden;align-items:stretch;}',
        /*
         * 单页内容**平铺铺满**：初级=①②、高级=③，不留空洞的第三栏。
         * ⚠️ 必须写在 `-body` **之后**、并带复合选择器：同优先级时后写的赢，
         *    上一版写在了前面 → 被 `repeat(3,…)` 盖掉 → 初级页第三列空着（作者实测指出）。
         */
        '.' + PLUGIN + '-body.' + PLUGIN + '-bodyfill{grid-template-columns:repeat(auto-fit,minmax(340px,1fr));}',
        '.' + PLUGIN + '-col{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;',
        'overflow-y:auto;overflow-x:hidden;padding-right:3px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar{width:6px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar-thumb{background:rgba(125,211,252,.28);border-radius:6px;}',
        '.' + PLUGIN + '-col-head{font-size:10.5px;font-weight:700;letter-spacing:.6px;',
        'color:#7dd3fc;opacity:.85;padding:0 2px;flex:0 0 auto;}',
        // —— 模拟器：② 画面与日志**横排**（窄容器自动塌成一列，别硬挤两列） ——
        '.' + PLUGIN + '-simrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;align-items:start;}',
        '.' + PLUGIN + '-simrow>.' + PLUGIN + '-sec{min-width:0;}',
        /*
         * 模拟器 tab = **1:2**（作者要求）：左边 1 份是「画面日志 / 试玩操作 / 验收单 / 工程（折叠）」，
         * 右边 2 份是**试玩页**（iframe 嵌 `/miliastra/play`，PixiJS WebGL，人真能在里面玩）。
         * ⚠️ 窄（浮层 880px 以下）自动塌成一列 —— 否则 1/3 宽会挤成一条，什么都看不清。
         */
        '.' + PLUGIN + '-simgrid{display:grid;grid-template-columns:1fr 2fr;gap:10px;padding:11px 13px 13px;',
        'align-items:stretch;flex:1 1 auto;min-height:0;}',
        '@media (max-width:1000px){.' + PLUGIN + '-simgrid{grid-template-columns:1fr;}}',
        // 左列自己滚、右列不动 —— 否则左列一长，滚下去就把 iframe 推出视野（作者实测「右侧啥都没」）
        '.' + PLUGIN + '-playside{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;',
        'overflow-y:auto;overflow-x:hidden;padding-right:3px;}',
        '.' + PLUGIN + '-playside::-webkit-scrollbar{width:6px;}',
        '.' + PLUGIN + '-playside::-webkit-scrollbar-thumb{background:rgba(125,211,252,.28);border-radius:6px;}',
        '.' + PLUGIN + '-playpane{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;}',
        '.' + PLUGIN + '-playhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;}',
        '.' + PLUGIN + '-playframe{flex:1 1 auto;width:100%;min-height:240px;border:0;border-radius:10px;',
        'background:#0b1220;box-shadow:0 0 0 1px rgba(125,211,252,.20);}',
        // 折叠卡（<details>）：summary 用同一套标题样式
        'details.' + PLUGIN + '-sec>summary{cursor:pointer;list-style:none;}',
        'details.' + PLUGIN + '-sec>summary::-webkit-details-marker{display:none;}',
        'details.' + PLUGIN + '-sec>summary:before{content:"▸ ";opacity:.7;}',
        'details.' + PLUGIN + '-sec[open]>summary:before{content:"▾ ";}',
        // —— 面板里「试玩页」要一直看得见：整页不滚，让左列自己滚 ——
        '.' + PLUGIN + '-simbody{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden;}',
        '.' + PLUGIN + '-simbody .' + PLUGIN + '-body{flex:0 0 auto;overflow:visible;max-height:none;}',
        '.' + PLUGIN + '-simbody .' + PLUGIN + '-col{overflow:visible;max-height:none;}',
        // 会话区全宽视图：整页滚（那里高度足够），并保证 1:2 有下限高度
        '.' + PLUGIN + '-inline .' + PLUGIN + '-simbody{overflow:visible;}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-simgrid{min-height:min(760px,calc(100vh - 190px));}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-playside{overflow:visible;}',

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

        // —— 截图预览（缩略图网格 + 单张放大）——
        // 原图是 2.5 MB 级的 PNG，一次列十几张直接把页面拖垮；所以面板只加载 Host 生成的小图，
        // 点开才看原图（新标签页）。
        '.' + PLUGIN + '-thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px;}',
        '.' + PLUGIN + '-thumb{display:block;border-radius:8px;overflow:hidden;text-decoration:none;',
        'border:1px solid rgba(125,211,252,.20);background:rgba(4,10,20,.42);}',
        '.' + PLUGIN + '-thumb:hover{border-color:rgba(249,168,212,.60);}',
        '.' + PLUGIN + '-thumb img{display:block;width:100%;height:auto;background:#0b1220;}',
        '.' + PLUGIN + '-thumbcap{display:block;font-size:9.5px;padding:2px 5px;color:#9fb6d4;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Consolas,monospace;}',
        '.' + PLUGIN + '-preview{margin-top:6px;border-radius:9px;overflow:hidden;',
        'border:1px solid rgba(125,211,252,.22);background:rgba(4,10,20,.42);}',
        '.' + PLUGIN + '-preview img{display:block;width:100%;height:auto;background:#0b1220;}',
        '.' + PLUGIN + '-previewcap{font-size:10px;padding:3px 7px;color:#9fb6d4;}',

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

      /** ISO 时间 → 本地 `MM-DD HH:MM`（截图列表用；解析不了就原样回）。 */
      function hhmm(iso) {
        var d = new Date(iso);
        if (!isFinite(d.getTime())) return String(iso || '');
        var p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      /** `pendingRestore` 的哨兵值：表示「用固定名那份备份」（= 最近一次覆盖前的版本）。 */
      var RESTORE_FIXED = '__fixed__';

      /**
       * 把 Host 回传的、**给 AI 看的 Markdown** 转成面板能显示的人话。
       *
       * 踩过两次：`BACKUP_NOTE` 与工具回执里的 `**强调**`，面板不渲染 Markdown
       * → 用户看到的是字面量星号。面板不渲染 Markdown，
       * 所以凡是从 Host 拿来的文本，落 UI 前一律经这里剥掉记号。
       */
      function plain(s) {
        return String(s == null ? '' : s).replace(/\*\*/g, '').replace(/`/g, '');
      }
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

      /** 试玩状态轮询间隔。开跑信号实测 0.07~0.18 秒就到磁盘，所以 2 秒够灵敏、又不吵。 */
      var PT_POLL_MS = 2000;

      /**
       * 「该不该因为开跑而自动截图」——**纯函数**（定时器不好测，判据好测）。
       *
       * `prev = { seeded, startMs, firedStart }`。
       * 两条刻意的设计：
       *   · **打开面板先建基线**：面板一开就发现「上一局在跑」不该触发自动截图 —— 那不是新开跑；
       *   · **同一局只触发一次**（`firedStart` 记住已经为哪个 startMs 抓过），免得轮询复查时连拍。
       */
      function ptStep(prev, info, opts) {
        var p = prev || { seeded: false, startMs: 0, firedStart: 0 };
        if (!info || info.ok === false) {
          return { next: p, action: 'none', phase: 'unknown', reason: '读不到试玩日志' };
        }
        var startMs = info.startedAtMs || 0;
        if (!p.seeded) {
          return {
            next: { seeded: true, startMs: startMs, firedStart: p.firedStart || 0 },
            action: 'none', phase: info.inPlaytest ? 'running' : 'idle',
            reason: info.inPlaytest ? '面板打开时已在试玩中（不补截）' : '',
          };
        }
        // 跑完的那一瞬 startedAtMs 会变 null → 保留旧 startMs，等下一个真正的新局
        if (!startMs || startMs === p.startMs) {
          return { next: p, action: 'none', phase: info.inPlaytest ? 'running' : 'idle', reason: '' };
        }
        var next = { seeded: true, startMs: startMs, firedStart: p.firedStart };
        if (opts && opts.autoShot && p.firedStart !== startMs) {
          next.firedStart = startMs;
          return {
            next: next, action: 'shot', phase: 'started',
            reason: '检测到开跑 → 约 ' + (opts.delaySec || 0) + ' 秒后自动截图',
          };
        }
        return {
          next: next, action: 'none', phase: 'started',
          reason: '检测到开跑（自动截图没开）',
        };
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
        {
          template: 'api-check', label: '核文档',
          oneLine: '官方文档写的那些接口，真机上到底有没有',
          what: '拿文档抽出来的接口名逐个按名取一次，报「存在 / 取不到」；顺带打印 game.IsTestPlay()（是不是在试玩）与画布尺寸，并实测一次 Tween。',
          when: '想用文档里某个没写过的接口之前先核一遍 —— 文档 ≠ 真机（版本/端/开关都可能不一样）。也可以只为看 game.IsTestPlay() 的值跑它。',
        },
      ];

      /* ---------------------------------------------------------------- 面板 */

      /**
       * 会话区顶部三个 tab 的注册计划（**纯数据**，便于回归：
       * id / label / order / 分组 被写坏是"静默失效"——tab 不出现或串味，页面上不报错）。
       */
      var VIEW_TABS = [
        { id: PLUGIN + '-basic', label: '初级功能', order: 30, group: 'basic' },
        { id: PLUGIN + '-advanced', label: '高级功能', order: 31, group: 'advanced' },
        { id: PLUGIN + '-simulator', label: '模拟器', order: 32, sim: true },
      ];

      function Panel(props) {
        var open = props.open;
        var setOpen = props.setOpen;
        var rootRef = props.rootRef;
        /*
         * 「视图模式」（0.1.0 融合 miliastra-beyond-simulator 时加的）：
         * 同一个 Panel 既当侧边栏浮层（inline=false，行为与以前完全一致），
         * 也当会话区 `conversation.view` 的全宽视图（inline=true）。
         *   · group='basic'    → ① 关卡 + ② 代码
         *   · group='advanced' → ③ 日志与画面（含「高级诊断」折叠区）
         *   · group='all'      → 三栏全上（浮层用）
         * 官方 `renderSlot('conversation.view', …, { only: active.id })` **只挂载当前选中的那个 view**，
         * 所以三个 tab 不会各自轮询 —— 同时只有可见的那一个在跑。
         */
        var inline = !!props.inline;
        var group = props.group || 'all';

        var s1 = React.useState(props.__status || null); var status = s1[0]; var setStatus = s1[1];
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
        /**
         * 浮层面板内部的视图切换（0.1.0）。会话区那三个 tab（`conversation.view`）是**另一处**入口，
         * 两处共用同一份卡片：这里切的是「浮层里先看哪一组」；会话区视图（inline）不用这个状态 —— 那边由 tab 本身决定。
         */
        var s29 = React.useState(props.group || props.__panelTab || 'basic');
        var panelTab = s29[0]; var setPanelTab = s29[1];
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
            // 截图目录的摘要随状态一起来 —— 打开面板就该看到「图存在哪、有多少」，
            // 而不是点了按钮才第一次知道（作者要求「跟日志一样要提示用户」）
            // 注意保留 lastCapture：15 秒轮询会把 shotInfo 换掉，回执不能跟着没
            if (r.shots) {
              setShotInfo(function (prev) {
                return Object.assign({}, r.shots, { lastCapture: prev && prev.lastCapture ? prev.lastCapture : null });
              });
            }

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
          if ((!open && !inline) || probeInfo) return undefined;
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
          if (!open && !inline) return undefined;
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
          if ((!open && !inline) || !autoLog) return undefined;
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

        /**
         * 试玩开跑轮询（0.0.4）。
         *
         * 依赖只放 `open` / `activeLevel` —— 开关与秒数走 ref，否则用户一改秒数
         * 这个 2 秒定时器就被重建一次（面板每 15 秒还会 `load(true)` 重渲染）。
         */
        React.useEffect(function () {
          if (!open && !inline) return undefined;
          var stopped = false;
          var shotTimer = null;

          var tick = function () {
            if (stopped) return;
            callTool('miliastra_playtest', Object.assign({ op: 'status' },
              activeLevel ? { level: activeLevel } : {})).then(function (r) {
              if (stopped || !r) return;
              setPtInfo(r);
              var opt = ptAutoRef.current || { on: false, delay: 3 };
              var step = ptStep(ptRef.current, r, { autoShot: !!opt.on, delaySec: opt.delay });
              ptRef.current = step.next;
              if (step.reason) setPtNote(step.reason);
              if (step.action === 'shot') {
                var delayMs = Math.max(0, Number(opt.delay) || 0) * 1000;
                shotTimer = setTimeout(function () {
                  if (stopped) return;
                  var fire = doCaptureRef.current;
                  if (typeof fire === 'function') fire('game');
                }, delayMs);
              }
            }).catch(function () { /* 轮询失败不打扰用户；状态行会显示上次拿到的值 */ });
          };

          tick();
          var t = setInterval(tick, PT_POLL_MS);
          return function () {
            stopped = true;
            clearInterval(t);
            if (shotTimer) clearTimeout(shotTimer);
          };
        }, [open, activeLevel]);

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

        /**
         * 截图状态。
         *
         * 作者的要求原话：「做游戏截图希望有这个功能跟日志一样要提示用户，是存到插件运行目录
         * 要提示用户清理」。所以这一块的设计目标**不是「能截到图」**（工具已经把图截出来了），
         * 而是**让用户始终知道东西落在哪、占了多少、以及它不会自己消失**：
         *   · 面板一打开就把目录 / 张数 / 占用摆出来（`status.shots`），不用点按钮才看得到；
         *   · 清理走「先规划、再确认」两步，判据在 Host（纯函数 `planClean`，有单测）；
         *   · 回执里的 pid / title 也显示出来 —— 「截到的是不是那个窗口」必须能自证。
         */
        var s34 = React.useState(props.__shot || null); var shotInfo = s34[0]; var setShotInfo = s34[1];
        var s35 = React.useState(false); var shotBusy = s35[0]; var setShotBusy = s35[1];
        var s36 = React.useState(props.__cleanPlan || null); var cleanPlan = s36[0]; var setCleanPlan = s36[1];
        var s37 = React.useState(false); var showShotFiles = s37[0]; var setShowShotFiles = s37[1];
        var s38 = React.useState(''); var shotTarget = s38[0]; var setShotTarget = s38[1];

        /*
         * 试玩开跑侦测（0.0.4）。
         *
         * 为什么要它：`.gia` **不是实时的** —— 实测「21:46:58 结束、21:47:07 才落盘」，
         * 局在跑的时候磁盘上根本没有那个文件。所以「游戏开跑 N 秒后的画面」只能靠
         * `output_log.txt` 里的实时标记（实测延迟 0.07~0.18 秒）来触发。
         * 自动截图**默认关**：磁盘是用户的，没人点过就不该自己往里写文件。
         */
        var s39 = React.useState(props.__pt || null); var ptInfo = s39[0]; var setPtInfo = s39[1];
        var s40 = React.useState(props.__autoShot === true); var autoShot = s40[0]; var setAutoShot = s40[1];
        var s41 = React.useState(3); var autoShotDelay = s41[0]; var setAutoShotDelay = s41[1];
        var s42 = React.useState(''); var ptNote = s42[0]; var setPtNote = s42[1];
        var ptRef = React.useRef({ seeded: false, startMs: 0, firedStart: 0 });
        var ptAutoRef = React.useRef({ on: props.__autoShot === true, delay: 3 });
        var doCaptureRef = React.useRef(null);
        React.useEffect(function () {
          ptAutoRef.current = { on: autoShot, delay: autoShotDelay };
        }, [autoShot, autoShotDelay]);

        /* ------------------------------------------------ 截图（画面取证） */

        /**
         * 截一张。
         *
         * ⚠️ 面板**不做**「截完自动删」或「自动清理」——作者明确要求「要提示用户清理」，
         * 磁盘是用户的，删除不可恢复，所以清理永远是人显式点的。
         */
        var doCapture = function (target) {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          setCleanPlan(null);
          callTool('miliastra_shot', { op: 'capture', target: target || 'game' })
            .then(function (r) {
              setShotBusy(false);
              if (r && r.ok) {
                setShotInfo({
                  dir: r.dir, count: (r.shots || {}).count, totalBytes: (r.shots || {}).totalBytes,
                  totalText: (r.shots || {}).totalText, newest: { name: r.file, sizeText: r.sizeText, mtime: null },
                  files: [], lastCapture: r,
                });
                setNote('已截图 ' + r.file + '（' + r.sizeText + '，' + r.width + '×' + r.height
                  + '，截到的是「' + (r.title || r.process) + '」pid=' + r.pid + '）'
                  + (r.suspect ? '　⚠️ ' + (r.warning || '这张图可能不可信') : ''));
                doShotList();
              } else {
                setErr(((r && r.error) || '截图失败')
                  + (r && (r.runningWindows || []).length ? '　→ 当前可截窗口：' + r.runningWindows.join(' ') : ''));
              }
            });
        };
        // 试玩轮询的效应比这里早定义，所以走 ref 取最新那份 doCapture（同 doLogsRef 的做法）
        doCaptureRef.current = doCapture;

        /** 只列目录（不截图）。保留上一次截图的回执 —— 它不该因为刷新列表就消失。 */
        var doShotList = function () {          callTool('miliastra_shot', { op: 'list' }).then(function (r) {
            if (r && r.ok !== false) {
              setShotInfo(function (prev) {
                return Object.assign({}, r, { lastCapture: prev && prev.lastCapture ? prev.lastCapture : null });
              });
            }
          });
        };

        /** 第一步：让 Host 算「会删哪些」（dryRun，绝不删）。 */
        var doShotCleanPlan = function () {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          callTool('miliastra_shot', { op: 'clean', keepLast: 5, olderThanDays: 7 }).then(function (r) {
            setShotBusy(false);
            if (r && r.ok !== false) {
              setCleanPlan(r);
              setNote(r.note || '');
            } else setErr((r && r.error) || '清理规划失败');
          });
        };

        /** 第二步：确认真删（双钥匙：dryRun:false + confirm:true）。 */
        var doShotCleanConfirm = function () {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          callTool('miliastra_shot', { op: 'clean', keepLast: 5, olderThanDays: 7, dryRun: false, confirm: true })
            .then(function (r) {
              setShotBusy(false);
              setCleanPlan(null);
              if (r && r.ok) {
                setNote('已删除 ' + r.removedCount + ' 张（' + r.bytesText + '），'
                  + '现在剩 ' + ((r.after || {}).count || 0) + ' 张 / ' + ((r.after || {}).totalText || '0 B'));
              } else {
                setErr((r && r.error) || ((r && (r.failed || []).length) ? '部分删除失败' : '清理失败'));
              }
              doShotList();
            });
        };

        if (!open && !inline) return null;

        // 「当前关卡」= 手动选的（若有）否则 Host 判定的那个 —— 面板所有展示都跟着它
        var cur = (function () {
          if (!status) return null;
          if (!activeLevel) return status.current;
          return (status.levels || []).find(function (x) { return x.levelId === activeLevel; }) || status.current;
        })();
        var lua = cur && cur.luaFiles && cur.luaFiles.length ? cur.luaFiles[0] : null;
        var anchorStyle = anchor ? { left: anchor.left, bottom: anchor.bottom } : { left: 12, bottom: 60 };
        // 视图模式：铺满会话区（不吸在侧边栏按钮上方、不带圆角与投影、自己滚动）
        var panelStyle = inline
          ? { position: 'relative', left: 'auto', bottom: 'auto', width: '100%', maxWidth: 'none',
              minHeight: '100%', maxHeight: 'none', borderRadius: 0, boxShadow: 'none', zIndex: 'auto' }
          : anchorStyle;
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
          // 2026-09-23 新增：静态读出来的「这图是哪版存的 / 有哪些阵营与出生点 / 摆了多少东西」
          if (mapInfo.clientVersion) {
            mapRows = mapRows.concat(cell('存图客户端', mapInfo.clientVersion
              + (mapInfo.resourceVersions && mapInfo.resourceVersions.length ? '　资源 ' + mapInfo.resourceVersions.join(' / ') : ''), 'm5'));
          }
          var lc = mapInfo.levelConfig;
          if (lc) {
            var fac = (lc.factions || []).map(function (f) { return '#' + f.index + ' ' + f.name; }).join('　');
            mapRows = mapRows.concat(cell('阵营', (lc.factions || []).length + ' 个' + (fac ? '　' + fac : ''), 'm6'));
            mapRows = mapRows.concat(cell('出生点 / 预设点',
              (lc.spawnPoints || []).length + ' / ' + (lc.presetPoints || []).length
              + ((lc.spawnPoints || []).length ? '　' + lc.spawnPoints.join('、') : ''), 'm7'));
          }
          if (mapInfo.sceneObjectCount != null) {
            mapRows = mapRows.concat(cell('场景对象', mapInfo.sceneObjectCount + ' 条'
              + ((mapInfo.sceneObjectSample || []).length ? '　如 ' + mapInfo.sceneObjectSample.slice(0, 3).map(function (x) { return x.name; }).join('、') : ''), 'm8'));
          }
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

        /*
         * ⚠️ 这里曾经有一块「试玩体检」结论条（红框：「最近一局是 2 小时前写的 → 可能原因 → 下一步」），
         * 并在打开面板时**自动跑一次**。作者的原话是「做个是什么鬼东西 下面一大段一直在」——
         * 它是常驻的：只要最近一局是几小时前写的，那段警告就会**永远挂在面板最上面**，
         * 而这对用户没有一点信息量（他当然知道自己没在试玩）。
         *
         * 结论：整块删掉（工具侧的 `miliastra_log op=diagnose` 也一并删了）。
         * 「最近一局是什么时候写的」这个事实本来就在 KV 行里，看一眼就够，不需要替用户下结论。
         */
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

        /*
         * ---------------- 截图卡片 ----------------
         *
         * 这一段存在的理由**不是**「我们实现了截图」，而是作者的这句话：
         * 「做游戏截图希望有这个功能跟日志一样要提示用户，是存到插件运行目录要提示用户清理」。
         * 也就是：截图功能本身不难，难的是**别让图在用户不知道的地方越堆越多**。
         * 所以卡片上一开始就写清楚「存在哪 / 多少张 / 占多大 / 不会自动删」。
         */
        var lastCap = shotInfo && shotInfo.lastCapture ? shotInfo.lastCapture : null;
        var shotKids = [];

        var shotRows = [];
        shotRows = shotRows.concat(cell('存放目录', (shotInfo && shotInfo.dir) || '（还没截过）', 'sd'));
        shotRows = shotRows.concat(cell('现有', (shotInfo ? (shotInfo.count || 0) : 0) + ' 张'
          + ((shotInfo && shotInfo.totalText) ? ' · ' + shotInfo.totalText : ''), 'sn'));
        shotRows = shotRows.concat(cell('最近一张',
          (shotInfo && shotInfo.newest && shotInfo.newest.name) || '—', 'sl'));
        shotKids.push(React.createElement(KVGrid, { rows: shotRows, key: 'kv' }));

        shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'where' },
          React.createElement('div', null, plain('存在「插件数据目录」下（默认 ~/.dsh/miliastra/shots）——'
            + '不放进游戏存档目录（那是米哈游的地盘），也不放插件包目录（升级会整个替换掉，图会没）。')),
          React.createElement('div', { style: { marginTop: '3px' } }, plain('不会自动删。清理要你自己点：'
            + '先看「会删哪些」，确认了才真删。'))));

        shotKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'b' },
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: shotBusy, key: 'g',
            title: '抓原神客户端窗口（试玩时就是游戏画面）。不需要它在前台。',
            onClick: function () { doCapture('game'); },
          }, shotBusy ? '截图中…' : '截取游戏画面'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'e',
            title: '抓千星沙箱编辑器窗口（节点图资源管理器等）',
            onClick: function () { doCapture('editor'); },
          }, '截编辑器'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'l',
            title: '重新列一遍截图目录',
            onClick: doShotList,
          }, '列目录'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'c',
            title: '先只算「会删哪些」（保留最新 5 张 + 最近 7 天），看清楚了再确认',
            onClick: doShotCleanPlan,
          }, '清理…')));

        // 截图回执：**截到的到底是哪个窗口**。第一版抓错程序就是因为回执里没这个信息。
        if (lastCap && lastCap.ok) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'last' },
            plain('截到的是「' + (lastCap.title || lastCap.process) + '」pid=' + lastCap.pid
              + ' · ' + lastCap.width + '×' + lastCap.height
              + ' · ' + (lastCap.mode === 'printwindow' ? '窗口自绘（不需要前台）' : '屏幕抓取')
              + ' · 黑比 ' + (lastCap.blackRatio != null ? lastCap.blackRatio : '—'))));
        }
        if (lastCap && lastCap.ok && lastCap.suspect) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'suspect' },
            plain('⚠️ 这张图可能不可信：' + (lastCap.warning || ''))));
        }
        if (lastCap && !lastCap.ok) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'shoterr' },
            plain('截图失败：' + (lastCap.error || ''))));
        }

        // 清理：先规划、再确认（删除不可恢复）
        if (cleanPlan) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'plan' },
            React.createElement('div', null, plain(cleanPlan.note || '')),
            (cleanPlan.planned || []).length
              ? React.createElement('div', { className: PLUGIN + '-log', style: { maxHeight: 110, marginTop: '4px' } },
                cleanPlan.planned.slice(0, 30).map(function (f) {
                  return React.createElement('div', { key: f.name }, f.name + '　' + f.sizeText);
                }))
              : null,
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '6px' } },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary',
                disabled: shotBusy || !(cleanPlan.planned || []).length,
                key: 'yes', onClick: doShotCleanConfirm,
              }, '确认删除 ' + ((cleanPlan.planned || []).length) + ' 张'),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'no', onClick: function () { setCleanPlan(null); },
              }, '取消'))));
        }

        /*
         * 缩略图预览（作者要求「图片最好有缩略图预览」）。
         *
         * 为什么要 Host 出小图、而不是直接 <img> 指原图：一张原图 2.4 MB，列十来张就是 30 MB，
         * 面板每次刷新都会重下。所以 Host 侧在**截图时**就顺手生成一张 ~320px 的预览
         * （同一个 bitmap，不额外起进程），面板只加载预览；点一下开新标签看原图。
         */
        var shotUrl = function (name, thumb) {
          return PREFIX + '/shot?name=' + encodeURIComponent(name) + (thumb ? '&thumb=1' : '');
        };
        var shotFiles = (shotInfo && shotInfo.files) || [];
        // 最近截的那张单独放大显示 —— 「我刚才截的对不对」是第一眼要看的事
        var previewName = (lastCap && lastCap.file) || (shotInfo && shotInfo.newest && shotInfo.newest.name) || shotFiles[0] && shotFiles[0].name;
        if (previewName) {
          shotKids.push(React.createElement('a', {
            className: PLUGIN + '-preview', key: 'preview',
            href: shotUrl(previewName, false), target: '_blank', rel: 'noreferrer',
            title: '点开看原图（新标签页）',
          },
            React.createElement('img', { src: shotUrl(previewName, true), alt: previewName, loading: 'lazy' }),
            React.createElement('span', { className: PLUGIN + '-previewcap' },
              previewName + (lastCap && lastCap.width ? '　' + lastCap.width + '×' + lastCap.height : ''))));
        }
        if (shotFiles.length) {
          var grid = shotFiles.slice(0, showShotFiles ? 24 : 6);
          shotKids.push(React.createElement('div', { className: PLUGIN + '-thumbs', key: 'thumbs' },
            grid.map(function (f) {
              return React.createElement('a', {
                className: PLUGIN + '-thumb', key: f.name,
                href: shotUrl(f.name, false), target: '_blank', rel: 'noreferrer',
                title: f.name + '　' + (f.sizeText || '') + (f.mtime ? '　' + hhmm(f.mtime) : '') + '　（点开看原图）',
              },
                React.createElement('img', { src: shotUrl(f.name, true), alt: f.name, loading: 'lazy' }),
                React.createElement('span', { className: PLUGIN + '-thumbcap' }, (f.sizeText || '') + (f.mtime ? '　' + hhmm(f.mtime) : '')));
            })));
          shotKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'fl' },
            React.createElement('button', {
              className: PLUGIN + '-act', style: { padding: '2px 9px', fontSize: '10.5px' }, key: 't',
              onClick: function () { setShowShotFiles(!showShotFiles); },
            }, showShotFiles ? '收起' : '展开全部 ' + shotFiles.length + ' 张')));
        }

        /* ------------------------------------------------ 试玩开跑卡片（0.0.4） */

        var hms = function (s) { return String(s == null ? '' : s).replace(/\.\d+$/, ''); };
        var durText = function (sec) {
          if (sec == null || !isFinite(sec)) return '—';
          var m = Math.floor(sec / 60);
          var r = Math.round(sec % 60);
          return m ? (m + ' 分 ' + r + ' 秒') : (r + ' 秒');
        };
        var ptKids = [];
        var ptLive = !!(ptInfo && ptInfo.ok !== false && ptInfo.inPlaytest);
        var ptNow;
        if (!ptInfo) ptNow = '读取中…（第一次轮询还没回来）';
        else if (ptInfo.ok === false) ptNow = '读不到试玩日志' + (ptInfo.error ? '：' + ptInfo.error : '');
        else if (ptLive) ptNow = '🟢 试玩中 · 已跑 ' + durText(ptInfo.elapsedSec) + '（开跑 ' + hms(ptInfo.startedAt) + '）';
        else if (ptInfo.lastRun) ptNow = '⚪ 未在试玩 · 最近一局 ' + hms(ptInfo.lastRun.startedAt) + '（时长 ' + durText(ptInfo.lastRun.durationSec) + '）';
        else ptNow = '⚪ 未在试玩（这次游戏会话里还没开过局）';

        var ptRows = [];
        ptRows = ptRows.concat(cell('现在', ptNow, 'pt'));
        if (ptInfo && ptInfo.lastRun && ptInfo.lastRun.endedAt) {
          ptRows = ptRows.concat(cell('最近结束', hms(ptInfo.lastRun.endedAt), 'pte'));
        }
        if (ptInfo && ptInfo.epochSec) {
          ptRows = ptRows.concat(cell('本局编号', String(ptInfo.epochSec) + '　与 .gia 的 instance 对得上号', 'ptn'));
        }
        if (ptInfo && ptInfo.logPath) {
          ptRows = ptRows.concat(cell('信号来源', basename(ptInfo.logPath) + '　实时', 'ptl'));
        }
        ptKids.push(React.createElement(KVGrid, { rows: ptRows, key: 'kv' }));

        var ptRuns = (ptInfo && ptInfo.recentRuns) || [];
        if (ptRuns.length) {
          ptKids.push(React.createElement('div', { key: 'runs' },
            ptRuns.slice().reverse().map(function (r, i) {
              return React.createElement('span', {
                className: PLUGIN + '-pill', key: 'r' + i,
                title: '开跑 ' + r.startedAt + '　时长 ' + durText(r.durationSec) + '　编号 ' + (r.epochSec || '—'),
              }, hms(r.startedAt) + '　' + durText(r.durationSec));
            })));
        }

        ptKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'auto' },
          React.createElement('button', {
            className: PLUGIN + '-act' + (autoShot ? ' ' + PLUGIN + '-primary' : ''), key: 'tg',
            title: '开着的时候：检测到「试玩开跑」→ 等 N 秒 → 自动截一张游戏画面（只截图，不碰你的脚本）',
            onClick: function () {
              var next = !autoShot;
              setAutoShot(next);
              setPtNote(next ? '已开：检测到开跑后约 ' + autoShotDelay + ' 秒自动截图' : '已关（不会再自动截图）');
            },
          }, autoShot ? '开跑自动截图：开' : '开跑自动截图：关'),
          [3, 5, 10].map(function (n) {
            return React.createElement('button', {
              className: PLUGIN + '-act', key: 'd' + n,
              style: { padding: '2px 9px', fontSize: '10.5px' },
              title: '开跑后等 ' + n + ' 秒再截（游戏刚起来的头一两秒还在加载）',
              onClick: function () { setAutoShotDelay(n); },
            }, (autoShotDelay === n ? '● ' : '') + n + ' 秒');
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'now',
            title: '不等开跑，现在就截一张',
            onClick: function () { doCapture('game'); },
          }, '立刻截')));

        if (ptNote) {
          ptKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'note' }, plain(ptNote)));
        }
        ptKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'why' },
          React.createElement('div', null, plain('开跑/结束读的是游戏自己写的 output_log.txt（每行带毫秒时间戳）——'
            + '实测「它写下」到「我们读到」只差 0.07~0.18 秒，所以能做「开跑 N 秒后」这种触发。')),
          React.createElement('div', { style: { marginTop: '3px' } },
            plain('⚠️ 不能用 .gia 判开跑：它是这一局**结束之后**才落盘的'
              + '（实测 21:46:58 结束、21:47:07 才出现）—— 局在跑的时候磁盘上根本没有这个文件。'))));

        var col3 = [
          sec('试玩开跑', ptLive ? '试玩中 · ' + durText(ptInfo.elapsedSec) : '等开跑',
            ptKids, 'secPt', ptLive ? 'ok' : 'warn'),
          sec('运行时日志', '读 .gia', logKids, 'secL', 'ok'),
          sec('游戏截图', shotInfo ? ((shotInfo.count || 0) + ' 张 · 记得清理') : '把画面存成 PNG',
            shotKids, 'secShot', shotInfo && shotInfo.count ? 'ok' : 'warn'),
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
            inline ? null : React.createElement('button', { className: PLUGIN + '-x', onClick: function () { setOpen(false); }, title: '关闭', key: 'x' }, '×')),
        ];
        if (err) kids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'err', style: { margin: '9px 13px 0' } }, String(err)));
        if (note) kids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'note', style: { margin: '9px 13px 0' } }, String(note)));
        /*
         * 版本行：**Host 是启动时的快照** —— 源码比它新就当场说，别让人去推理。
         * （2026-09-23 深夜真踩：源码 22:41 改到 0.0.9，Host 还报 0.0.5，定位花掉 5 个调用。）
         * 正常时是灰字一行；**陈旧时才变琥珀色并带上「重启 dsh web」的下一步**。
         */
        if (status && status.version) {
          var srcInfo = status.source || {};
          var stale = !!srcInfo.stale;
          var bits = ['Host v' + status.version];
          if (status.startedAt) {
            var sd = new Date(status.startedAt);
            if (!isNaN(sd.getTime())) {
              bits.push('启动 ' + ('0' + sd.getHours()).slice(-2) + ':' + ('0' + sd.getMinutes()).slice(-2));
            }
          }
          if (srcInfo.sourceVersion) bits.push('源码 v' + srcInfo.sourceVersion);
          var verStyle = { margin: '9px 13px 0' };
          if (stale) { verStyle.color = '#fbbf24'; verStyle.fontWeight = 600; }
          kids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'ver', style: verStyle },
            (stale ? '⚠️ ' : '') + bits.join(' · ') + (stale && srcInfo.hint ? ' —— ' + srcInfo.hint : '')));
        }
        var shownGroup = inline ? group : panelTab;
        var bodyCols = [];
        if (shownGroup === 'all' || shownGroup === 'basic') {
          bodyCols.push(col('① 关卡', col1, 'c1'));
          bodyCols.push(col('② 代码', col2, 'c2'));
        }
        if (shownGroup === 'all' || shownGroup === 'advanced') bodyCols.push(col('③ 日志与画面', col3, 'c3'));

        /*
         * 浮层里的三个页面：各自独立、互不干扰 —— **不再有「全部」混合页**（作者要求）。
         * 三档 = 初级功能(①②) / 高级功能(③) / 模拟器；每页内容**平铺铺满**（`-bodyfill`）。
         */
        if (!inline) {
          kids.push(React.createElement('div', { className: PLUGIN + '-viewtabs', key: 'vtabs' },
            [['basic', '初级功能'], ['advanced', '高级功能'], ['sim', '模拟器']].map(function (pair) {
              return React.createElement('button', {
                key: 'vt' + pair[0],
                className: PLUGIN + '-vtab' + (panelTab === pair[0] ? ' ' + PLUGIN + '-vtab-on' : ''),
                onClick: function () { setPanelTab(pair[0]); },
              }, pair[1]);
            })));
        }

        if (shownGroup === 'sim') {
          // 模拟器页：与「会话区 → 模拟器」tab 共用一个正文组件（同一份状态、同一套动作）
          kids.push(React.createElement(SimulatorBody, { key: 'simbody' }));
        } else {
          kids.push(React.createElement('div', {
            className: PLUGIN + '-body' + (shownGroup === 'all' ? '' : ' ' + PLUGIN + '-bodyfill'),
            key: 'body',
          }, bodyCols));
        }

        return React.createElement('div', {
          className: PLUGIN + '-panel' + (inline ? ' ' + PLUGIN + '-inline' : ''),
          style: panelStyle,
        }, kids);
      }

      /**
       * 画布点击坐标换算（**纯函数**，单独回归）。
       *
       * 语义与引擎 `engine/studio/play/browser-session.js` 的 `stagePoint` 一致：
       *   画布原点在**左下**（引擎口径），所以 y 必须翻转 `(rect.bottom - clientY)`。
       * 写错的表现是「点哪儿都点不到 / 点到别处」，而面板不会报错 —— 所以必须能测。
       */
      function stagePointFromEvent(rect, width, height, clientX, clientY) {
        var r = rect || { left: 0, bottom: 0, width: 0, height: 0 };
        var w = Number(width) || 0;
        var h = Number(height) || 0;
        if (!w || !h || !r.width || !r.height) return { x: 0, y: 0 };
        return {
          x: Math.round((clientX - r.left) * w / r.width),
          y: Math.round((r.bottom - clientY) * h / r.height),
        };
      }

      /* ---------------------------------------------------------------- 模拟器视图 */

      /**
       * 操作时间线的一行：`t=0.53  pointer click (800,450)`。
       * 人能对上"自己刚才做了什么"，AI 也能照着写成 `verify` 的 `steps[]`（同一份历史就是 `fromHistory` 的来源）。
       */
      function histLine(e) {
        var p = (e && e.payload) || {};
        var what = (e && e.kind) || '?';
        if (what === 'pointer') what = 'pointer ' + (p.type || '') + ' (' + p.x + ',' + p.y + ')';
        else if (what === 'key') what = 'key ' + (p.typeName || '');
        else if (what === 'click') what = 'click ' + (p.name || '');
        else if (what === 'view') what = 'view P' + (p.playerIndex || 1);
        else if (what === 'serverSet') what = 'setVar ' + p.entityType + '.' + p.name + ' = ' + p.value;
        else if (what === 'serverSend') what = 'signal ' + (p.name || '') + '(' + (p.params || []).join(',') + ')';
        return 't=' + (Number(e && e.t) || 0).toFixed(2) + '  ' + what;
      }

      /**
       * 「模拟器」tab：会话区全宽视图，直接打 `/miliastra/engine` ——
       * 与 `miliastra_sim` 工具**同一个入口**，所以面板里看到的和 AI 操作的是**同一份**工程状态。
       *
       * 画面是 Host 按引擎场景树渲染的 PNG（原生 canvas）：**不需要开游戏、也不要求窗口在前台**。
       * 交互：开始试玩 → 引擎在可终止的 Worker 里跑 Lua → 刷新画面拿新帧 → 点坐标注入点击。
       */
      function SimulatorBody() {
        var s1 = React.useState(null); var st = s1[0]; var setSt = s1[1];
        var s2 = React.useState(''); var err = s2[0]; var setErr = s2[1];
        var s3 = React.useState(true); var busy = s3[0]; var setBusy = s3[1];
        var s4 = React.useState(null); var shot = s4[0]; var setShot = s4[1];
        var s5 = React.useState([]); var logs = s5[0]; var setLogs = s5[1];
        var s6 = React.useState(false); var running = s6[0]; var setRunning = s6[1];
        // 「能玩」四件套（0.1.1）：连帧 / 按键 / 设备 / 人数视角
        var s7 = React.useState(false); var auto = s7[0]; var setAuto = s7[1];
        var s8 = React.useState({ keys: [], presets: [], from: '' }); var keyInfo = s8[0]; var setKeyInfo = s8[1];
        var s9 = React.useState(''); var keyName = s9[0]; var setKeyName = s9[1];
        var s10 = React.useState(''); var canvasId = s10[0]; var setCanvasId = s10[1];
        var s11 = React.useState(1); var players = s11[0]; var setPlayers = s11[1];
        var s12 = React.useState(1); var viewIndex = s12[0]; var setViewIndex = s12[1];
        // ③ 「AI 试玩区域」的两个读数：这一局的帧头信息，以及**可重放的操作时间线**
        var s13 = React.useState({ frame: 0, time: 0, controls: 0 }); var stat = s13[0]; var setStat = s13[1];
        var s14 = React.useState([]); var hist = s14[0]; var setHist = s14[1];
        // 工程适配（op=handover / op=bind）
        var s15 = React.useState(null); var bindInfo = s15[0]; var setBindInfo = s15[1];
        var s16 = React.useState(''); var bindPath = s16[0]; var setBindPath = s16[1];
        var s17 = React.useState([]); var bindRows = s17[0]; var setBindRows = s17[1];
        var s18 = React.useState(''); var bindContainer = s18[0]; var setBindContainer = s18[1];
        var s19 = React.useState(null); var bindRes = s19[0]; var setBindRes = s19[1];
        // 验收单（op=cases）
        var s20 = React.useState(null); var book = s20[0]; var setBook = s20[1];
        var s21 = React.useState(''); var bookSet = s21[0]; var setBookSet = s21[1];
        var s22 = React.useState('[{"kind":"log","contains":"就绪"}]'); var expectText = s22[0]; var setExpectText = s22[1];
        var s23 = React.useState(''); var caseName = s23[0]; var setCaseName = s23[1];
        var s24 = React.useState(''); var caseNote = s24[0]; var setCaseNote = s24[1];
        var s25 = React.useState(null); var caseResults = s25[0]; var setCaseResults = s25[1];
        // 试玩页 iframe 的「重载」计数（改 key 就重挂）
        var s26 = React.useState(0); var playNonce = s26[0]; var setPlayNonce = s26[1];

        var engine = React.useCallback(function (args, quiet) {
          if (!quiet) { setBusy(true); setErr(''); }
          return fetch(PREFIX + '/engine', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args || {}),
          }).then(function (r) { return r.json(); })
            .then(function (env) {
              if (!env || env.ok === false) throw new Error((env && env.error) || '引擎调用失败');
              return env.data || {};
            })
            .catch(function (e) { setErr((e && e.message) || String(e)); return null; })
            .then(function (d) { if (!quiet) setBusy(false); return d; });
        }, []);

        var refresh = React.useCallback(function () {
          return engine({ op: 'state', summaryOnly: false }).then(function (d) { if (d) setSt(d); });
        }, [engine]);

        React.useEffect(function () { refresh(); }, [refresh]);

        // 进页面就拉一次「你脚本在听哪些键」（op=keys 从脚本源码扫 KeyEventType），有就用它做按钮
        React.useEffect(function () {
          engine({ op: 'keys' }, true).then(function (d) {
            if (!d) return;
            setKeyInfo({ keys: d.keys || [], presets: d.presets || [], from: d.from || '' });
            if (d.keys && d.keys.length) setKeyName(function (prev) { return prev || d.keys[0]; });
          });
        }, [engine]);

        var doPlay = React.useCallback(function (action, a) {
          return engine({ op: 'play', action: action, args: a || {} }).then(function (d) {
            if (!d) return null;
            if (Array.isArray(d.logs)) {
              setLogs(d.logs.map(function (l) { return (l && l.text) || ''; }));
            }
            // 「AI 试玩区域」的状态行：帧 / 时间 / 控件数（引擎每次回快照都带着）
            if (d.frame !== undefined || d.treeCount !== undefined || d.controlCount !== undefined) {
              setStat({
                frame: Number(d.frame) || 0,
                time: Number(d.time) || 0,
                controls: Number(d.treeCount || d.controlCount) || 0,
              });
            }
            // 操作时间线：引擎把人的每一次点/按键/拖拽都记在 history 里（AI 的 fromHistory 用的就是它）
            if (Array.isArray(d.history)) {
              setHist(d.history.slice(-12).map(histLine));
            }
            if (action === 'start') setRunning(true);
            if (action === 'stop') { setRunning(false); setLogs([]); setAuto(false); setHist([]); }
            return d;
          });
        }, [engine]);

        var doShot = React.useCallback(function (target, quiet, reuse) {
          return engine({ op: 'shot', target: target, label: 'panel', reuse: reuse === true }, quiet === true).then(function (d) {
            if (d && d.name) setShot(d);
          });
        }, [engine]);

        /*
         * 连帧：引擎在 Worker 里本来就以 **30 FPS 固定步长自走**（worker.js 的 setInterval(33ms)），
         * 我们这边只负责**反复取当前帧** —— 200ms 一帧 ≈ 5 FPS，够点按钮、看状态变化与动画在走，
         * 但**不是 60 FPS 动作游戏**（那条路要浏览器端 WebGL 渲染，还没做）。
         * `reuse=true`：固定名覆盖写，**不会一晚上刷出几万张 PNG**。
         */
        React.useEffect(function () {
          if (!auto || !running) return undefined;
          var t = setInterval(function () { doShot('play', true, true); }, 200);
          return function () { clearInterval(t); };
        }, [auto, running, doShot]);

        var kids = [];
        kids.push(React.createElement('div', { className: PLUGIN + '-head', key: 'head' },
          React.createElement(Icon, { k: 'mk' }),
          React.createElement('span', { className: PLUGIN + '-title', key: 'ti' }, '模拟器'),
          React.createElement('span', { className: PLUGIN + '-badge', key: 'bg' }, running ? '试玩中' : '就绪'),
          React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'rf', disabled: busy,
            onClick: function () { refresh(); },
          }, busy ? '刷新中…' : '刷新')));
        if (err) kids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'err', style: { margin: '9px 13px 0' } }, err));

        var info = st ? [
          ['画布', (st.canvas && st.canvas.label) || st.canvasId || '—'],
          ['控件', String(st.treeCount || 0) + ' 个'],
          ['脚本', String(st.scriptCount || 0) + ' 个'],
          ['存档', (st.save && st.save.name) || '—'],
        ] : [];
        var rows = [];
        for (var i = 0; i < info.length; i += 1) {
          rows.push(React.createElement('div', { className: PLUGIN + '-k', key: 'k' + i }, info[i][0]));
          rows.push(React.createElement('div', { className: PLUGIN + '-v', key: 'v' + i }, info[i][1]));
        }

        var treeNodes = (st && st.tree ? st.tree : []).slice(0, 80).map(function (n) {
          return React.createElement('div', {
            className: PLUGIN + '-log', key: 'n' + n.id,
            style: { paddingLeft: (6 + (n.depth || 0) * 10) + 'px', cursor: 'pointer' },
            title: '点一下在引擎里选中它（op=patch select）',
            onClick: function () {
              engine({ op: 'patch', patch: { op: 'select', id: n.id } }).then(function (d) { if (d) setSt(d); });
            },
          }, n.id + '  ' + n.kind + '  ' + (n.name || ''));
        });

        var stage = shot
          ? React.createElement('img', {
            src: shot.url, alt: 'sim-thumb',
            title: '这一帧是 Host 按引擎场景树渲染的 PNG。点它任意位置 = 往引擎注入一次点击（坐标按左下原点换算）——'
              + '要连续操作就用右边那 2/3 的**试玩页**（真 WebGL）',
            style: { width: '100%', maxHeight: '140px', objectFit: 'contain', borderRadius: '6px', background: '#0b1220', cursor: 'crosshair' },
            onClick: function (e) {
              if (!shot || !shot.width || !shot.height) return;
              var rect = e.currentTarget.getBoundingClientRect();
              var p = stagePointFromEvent(rect, shot.width, shot.height, e.clientX, e.clientY);
              doPlay('pointer', { type: 'click', x: p.x, y: p.y })
                .then(function () { return doShot('play', true, true); });
            },
          })
          : React.createElement('div', { className: PLUGIN + '-hint' }, '还没有画面 —— 点「编辑器画面」，或先「开始试玩」再点「试玩画面」。');

        var btn = function (label, cls, fn, key) {
          return React.createElement('button', {
            className: PLUGIN + '-act' + (cls ? ' ' + cls : ''), key: key, disabled: busy, onClick: fn,
          }, label);
        };
        var actions = React.createElement('div', { className: PLUGIN + '-row', key: 'act' },
          btn('编辑器画面', PLUGIN + '-primary', function () { doShot('ui'); }, 'b1'),
          btn(running ? '重开试玩' : '开始试玩', PLUGIN + '-primary', function () {
            doPlay('start', { canvasId: canvasId || undefined, playerCount: players })
              .then(function (d) { if (d) doShot('play'); });
          }, 'b2'),
          btn('单步', null, function () {
            // 单帧确定性推进：**先暂停**再 step（跑着的时候引擎那个 30FPS 时钟自己也在走）
            setAuto(false);
            doPlay('pause').then(function () { return doPlay('step', { dt: 0.033 }); })
              .then(function () { return doShot('play', true, true); });
          }, 'b3'),
          btn(auto ? '连帧：开（≈5fps）' : '连帧：关', auto ? PLUGIN + '-primary' : null, function () { setAuto(!auto); }, 'b0'),
          btn('刷新画面', null, function () { doShot('play', true, true); }, 'b4'),
          btn('停止', null, function () { setAuto(false); doPlay('stop'); }, 'b5'),
          btn('导出 GIA', null, function () {
            engine({ op: 'export', format: 'gia' }).then(function (d) {
              if (!d) return;
              setLogs(function (prev) {
                return prev.concat(['导出 ' + d.name + '（' + d.bytesText + '） → ' + d.file,
                  '⚠️ 这个 .gia 还没在真机编辑器里导入验证过 —— 拿它去试，结果记回 docs/']);
              });
            });
          }, 'b8'),
          /**
           * 浏览器试玩页（W2）：WebGL 渲染的**真·能玩**页面，与面板/AI 共用同一个会话。
           * 为什么不塞进面板：pixi 需要 WebGL + 自己的 CSP 处理，独立页最稳；
           * 而且它**关页不停局** —— AI 能把人刚玩的那一局直接变成回归用例（`op=verify fromHistory:true`）。
           */
          React.createElement('a', {
            className: PLUGIN + '-act', key: 'b9', href: PREFIX + '/play', target: '_blank', rel: 'noreferrer',
            title: '浏览器试玩页（WebGL）：与这里、与 AI 共用同一份工程与同一个会话；玩完可以让 AI 用 op=verify fromHistory:true 把这局变成回归用例',
            style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
          }, '浏览器试玩 ↗'),
          btn('重置工程', null, function () {
            engine({ op: 'reset' }).then(function (d) {
              if (d) { setSt(d); setShot(null); setLogs([]); setRunning(false); }
            });
          }, 'b7'));

        /** 按键行：优先用**你脚本真正在听的键**（`op=keys` 从脚本源码扫出来的），没有就用引擎的官方键名预设。 */
        var keyCandidates = ((keyInfo.keys && keyInfo.keys.length ? keyInfo.keys : keyInfo.presets) || []).slice(0, 6);
        var keyRow = React.createElement('div', { className: PLUGIN + '-row', key: 'keys' },
          React.createElement('span', { className: PLUGIN + '-hint', key: 'kh' }, '按键：'),
          keyCandidates.map(function (k) {
            return React.createElement('button', {
              className: PLUGIN + '-act', key: 'k' + k, disabled: busy, title: k,
              onClick: function () { doPlay('key', { key: k }).then(function () { return doShot('play', true, true); }); },
            }, String(k).replace('Keyboard', '').replace('Controller', 'C-'));
          }),
          React.createElement('input', {
            className: PLUGIN + '-act', key: 'ki', value: keyName,
            placeholder: '键名，如 KeyboardCraftspersonKey1Down',
            style: { minWidth: '170px' },
            onChange: function (e) { setKeyName(e.target.value); },
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'ks', disabled: busy || !keyName,
            onClick: function () { doPlay('key', { key: keyName }).then(function () { return doShot('play', true, true); }); },
          }, '发送键'));

        /** 设备 / 人数 / 视角：设备可中途切（`play device`），人数在 `start` 时生效，视角随时可切。 */
        var presets = (st && st.canvas && st.canvas.presets) || [];
        var optList = function (values, prefix, keyPrefix) {
          return values.map(function (v) {
            return React.createElement('option', { key: keyPrefix + String(v), value: String(v) }, prefix + v);
          });
        };
        var devRow = React.createElement('div', { className: PLUGIN + '-row', key: 'dev' },
          React.createElement('span', { className: PLUGIN + '-hint', key: 'dh' }, '设备：'),
          React.createElement('select', {
            className: PLUGIN + '-act', key: 'dc',
            value: canvasId || (st && st.canvasId) || 'pc-16-9',
            onChange: function (e) {
              var v = e.target.value;
              setCanvasId(v);
              // ⚠️ 切设备会重建运行时：必须把人数一起带上，否则人数悄悄掉回 1（Host 也会兜底沿用）
              if (running) doPlay('device', { canvasId: v, playerCount: players }).then(function () { return doShot('play', true, true); });
            },
          }, presets.length
            ? presets.map(function (p) { return React.createElement('option', { key: 'o' + p.id, value: p.id }, p.label || p.id); })
            : optList(['pc-16-9', 'mobile-16-9'], '', 'd')),
          React.createElement('span', { className: PLUGIN + '-hint', key: 'ph' }, '人数：'),
          React.createElement('select', {
            className: PLUGIN + '-act', key: 'pc', value: String(players),
            title: '在「开始试玩」时生效（1–8 人本地多客户端模拟）',
            onChange: function (e) { setPlayers(Number(e.target.value) || 1); },
          }, optList([1, 2, 3, 4, 5, 6, 7, 8], '', 'p')),
          React.createElement('span', { className: PLUGIN + '-hint', key: 'vh' }, '视角：'),
          React.createElement('select', {
            className: PLUGIN + '-act', key: 'vc',
            value: String(Math.min(viewIndex, players)),
            title: '只看哪个玩家的客户端（Engine: play view）；可选范围跟着人数走',
            onChange: function (e) {
              var n = Number(e.target.value) || 1;
              setViewIndex(n);
              if (running) doPlay('view', { playerIndex: n }).then(function () { return doShot('play', true, true); });
            },
          }, optList(Array.from({ length: players }, function (_v, i) { return i + 1; }), 'P', 'v')));

        var statFrame = stat.frame + (stat.time ? '（t=' + stat.time.toFixed(2) + 's）' : '');
        var statControls = stat.controls || (st ? (st.treeCount || 0) : 0);

        /* ---------------------------------------------- 工程适配（op=bind） */

        var kindOpts = ['image', 'textbox', 'button', 'container', 'cursor', 'grid', 'reference', 'textwindow', 'keyhint', 'animation', 'fullscreen'];

        var bindCard = sec('工程适配', bindInfo ? (bindInfo.fileCount + ' 个活文件') : '把真机工程搬进来',
          React.createElement('div', { key: 'b' },
            React.createElement('div', { className: PLUGIN + '-row', key: 'r1' },
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'scan', disabled: busy,
                title: 'op=handover：扫这台机器上的活文件，并把源码里的候选交接值（local NAME = 大整数）摆出来',
                onClick: function () {
                  engine({ op: 'handover' }).then(function (d) {
                    if (!d) return;
                    setBindInfo(d);
                    setBindPath(d.picked || '');
                    setBindRows((d.candidates || []).map(function (c) {
                      return { name: c.name, value: c.value, kind: c.isTemplate ? c.kindHint : '', on: !!c.isTemplate };
                    }));
                    if (d.containerId) setBindContainer(String(d.containerId));
                  });
                },
              }, '扫描活文件'),
              React.createElement('select', {
                className: PLUGIN + '-act', key: 'f', value: bindPath,
                style: { maxWidth: '100%' },
                title: '选一份真机活文件（.lua）。标 ★ 的是「当前正在开发的那张图」',
                onChange: function (e) {
                  var v = e.target.value;
                  setBindPath(v);
                  engine({ op: 'handover', source: v }).then(function (d) {
                    if (!d) return;
                    setBindInfo(d);
                    setBindRows((d.candidates || []).map(function (c) {
                      return { name: c.name, value: c.value, kind: c.isTemplate ? c.kindHint : '', on: !!c.isTemplate };
                    }));
                    if (d.containerId) setBindContainer(String(d.containerId));
                  });
                },
              }, (bindInfo && bindInfo.files && bindInfo.files.length)
                ? bindInfo.files.map(function (f) {
                  return React.createElement('option', { key: f.path, value: f.path },
                    (f.current ? '★ ' : '') + f.levelId + ' · ' + f.file + (f.auxiliary ? '（附属）' : ''));
                })
                : [React.createElement('option', { key: 'none', value: '' }, '（还没扫 —— 点左边「扫描活文件」）')])),
            bindRows.length
              ? React.createElement('div', { key: 'r2' },
                React.createElement('div', { className: PLUGIN + '-hint' },
                  '候选交接值（来自源码 `local NAME = <大整数>`，**启发式**）：勾上要当模板的，**kind 必须你确认** —— 猜错会静默什么都不建'),
                bindRows.map(function (r, i) {
                  return React.createElement('div', { className: PLUGIN + '-row', key: 'c' + r.value, style: { marginTop: '4px' } },
                    React.createElement('label', { className: PLUGIN + '-hint', key: 'lb', style: { display: 'flex', gap: '5px', alignItems: 'center' } },
                      React.createElement('input', {
                        type: 'checkbox', checked: r.on, key: 'ck',
                        onChange: function (e) {
                          var on = e.target.checked;
                          setBindRows(function (prev) { return prev.map(function (x, j) { return j === i ? Object.assign({}, x, { on: on }) : x; }); });
                        },
                      }),
                      r.name + ' = ' + r.value),
                    React.createElement('select', {
                      className: PLUGIN + '-act', key: 'k', value: r.kind,
                      onChange: function (e) {
                        var k = e.target.value;
                        setBindRows(function (prev) { return prev.map(function (x, j) { return j === i ? Object.assign({}, x, { kind: k }) : x; }); });
                      },
                    }, [React.createElement('option', { key: 'none', value: '' }, '不是模板')].concat(kindOpts.map(function (k) {
                      return React.createElement('option', { key: k, value: k }, k);
                    }))));
                }))
              : null,
            React.createElement('div', { className: PLUGIN + '-row', key: 'r3' },
              React.createElement('span', { className: PLUGIN + '-hint', key: 'ch' }, '容器索引：'),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'ci', value: bindContainer,
                placeholder: '创作者交接的容器节点索引（可空）',
                style: { minWidth: '150px' },
                onChange: function (e) { setBindContainer(e.target.value); },
              }),
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'do', disabled: busy || !bindPath,
                title: 'op=bind：建模板（guid 用交接值）+ 挂脚本 + 起一次会话并回「脚本跑没跑、控件建了几个」',
                onClick: function () {
                  var templates = bindRows.filter(function (x) { return x.on && x.kind; })
                    .map(function (x) { return { guid: x.value, kind: x.kind, name: x.name }; });
                  engine({
                    op: 'bind', source: bindPath, templates: templates,
                    containerId: Number(bindContainer) || undefined,
                    keepRunning: true, name: undefined,
                  }).then(function (d) {
                    if (!d) return;
                    setBindRes(d);
                    setLogs(((d.run && d.run.logs) || []).map(function (l) { return (l && l.text) || ''; }));
                    if (d.run) { setRunning(true); setStat({ frame: d.run.frame || 0, time: d.run.time || 0, controls: d.run.controlCount || 0 }); }
                    return refresh();
                  });
                },
              }, '搭进模拟器')),
            bindRes
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'res', style: { maxHeight: '170px' } },
                ('搭好了：模板 ' + (bindRes.templateCount || 0) + ' 个 · ' + (bindRes.scripts || []).length + ' 个脚本 · '
                  + (bindRes.handover && bindRes.handover.missing && bindRes.handover.missing.length
                    ? '⚠️ 有 ' + bindRes.handover.missing.length + ' 个交接值在源码里找不到（可能交错了）' : '交接值核对：missing 空')
                  + '\n控件（运行时）：' + ((bindRes.run && bindRes.run.controlCount) || 0)
                  + (bindRes.run && bindRes.run.logs && bindRes.run.logs.length ? '\n脚本 print：' : '\n⚠️ 脚本一行都没 print（不等于没跑）')
                  + ((bindRes.run && bindRes.run.logs) || []).slice(-6).map(function (l) { return '\n  ' + l.text; }).join('')))
              : null),
          'simBind', bindRes ? 'ok' : 'warn');

        /* ---------------------------------------------- 验收单（op=cases） */

        var bookCard = sec('验收单', book ? (book.setCount + ' 组') : '人 / AI 读同一份',
          React.createElement('div', { key: 'k' },
            React.createElement('div', { className: PLUGIN + '-row', key: 'r1' },
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'ld', disabled: busy,
                title: 'op=cases action=list：读模拟器工作区的 cases.json',
                onClick: function () { engine({ op: 'cases' }).then(function (d) { if (d) setBook(d); }); },
              }, '读清单'),
              React.createElement('select', {
                className: PLUGIN + '-act', key: 'set',
                value: bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : ''),
                onChange: function (e) { setBookSet(e.target.value); setCaseResults(null); },
              }, (book && book.sets && book.sets.length)
                ? book.sets.map(function (s) { return React.createElement('option', { key: s.set, value: s.set }, s.set + '（' + s.autoCount + ' 自动 / ' + s.manualCount + ' 人工）'); })
                : [React.createElement('option', { key: 'none', value: '' }, '（还没有用例集）')]),
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'run', disabled: busy || !(book && book.sets && book.sets.length),
                title: 'op=cases action=run：自动项确定性重放；**人工项不代跑**，只列出来等人打勾',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  engine({ op: 'cases', action: 'run', set: set }).then(function (d) {
                    if (!d) return;
                    setCaseResults(d);
                    setLogs(function (prev) { return prev.concat([d.note || '']); });
                  });
                },
              }, '跑这一组')),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r2' },
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'nm', value: caseName,
                placeholder: '用例名，如「切相后不掉血」', style: { minWidth: '150px' },
                onChange: function (e) { setCaseName(e.target.value); },
              }),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'ex', value: expectText,
                placeholder: '期望（JSON 数组），如 [{"kind":"log","contains":"就绪"}]',
                style: { minWidth: '190px', flex: '1 1 190px' },
                title: '断言：log{contains} / control{name,field,equals} / count{controlKind,atLeast} / var / signal / tree / lua',
                onChange: function (e) { setExpectText(e.target.value); },
              }),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'add', disabled: busy || !caseName,
                title: 'op=cases action=add fromHistory:true：把**刚跑过那一局**的操作当成用例的步骤（AI 不用手抄 events）',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  if (!set) { setErr('先给用例集起个名字（用「读清单」后下拉里就会有）'); return; }
                  var expect;
                  try { expect = JSON.parse(expectText); } catch (e) { setErr('期望不是合法 JSON：' + ((e && e.message) || e)); return; }
                  engine({ op: 'cases', action: 'add', set: set, fromHistory: true, cases: [{ name: caseName, expect: expect }] })
                    .then(function (d) { if (d) { setErr(''); setCaseName(''); return engine({ op: 'cases' }).then(function (x) { if (x) setBook(x); }); } });
                },
              }, '存用例（含这一局）'),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'man', disabled: busy || !caseName || !caseNote,
                title: '存成**人工项**：工具不代跑也不代判，只列出来等人 / 等真机打勾',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  if (!set) { setErr('先给用例集起个名字'); return; }
                  engine({ op: 'cases', action: 'add', set: set, cases: [{ name: caseName, manual: true, note: caseNote }] })
                    .then(function (d) { if (d) { setCaseName(''); setCaseNote(''); return engine({ op: 'cases' }).then(function (x) { if (x) setBook(x); }); } });
                },
              }, '存人工项')),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r3' },
              React.createElement('span', { className: PLUGIN + '-hint', key: 'nh' }, '人工项说明（人要看什么、看到什么算过）：'),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'nt', value: caseNote,
                placeholder: '如：真机上小人看得见、手不飘',
                style: { minWidth: '200px', flex: '1 1 200px' },
                onChange: function (e) { setCaseNote(e.target.value); },
              })),
            (book && book.sets && book.sets.length)
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: '190px' } },
                book.sets.map(function (s) {
                  return s.cases.map(function (c) {
                    var res = null;
                    if (caseResults && caseResults.set === s.set && caseResults.result) {
                      res = (caseResults.result.cases || []).filter(function (x) { return x.name === c.name; })[0] || null;
                    }
                    var mark = c.kind === 'manual' ? '☐' : (res ? (res.passed ? '✅' : '❌') : '·');
                    return '\n' + mark + ' [' + s.set + '] ' + c.name
                      + (c.kind === 'manual' ? '（人工）' + (c.note ? ' — ' + c.note : '') : '（自动 ' + c.asserts + ' 断言）')
                      + (res && !res.passed ? ' ← 没过：' + JSON.stringify(res.results) : '');
                  }).join('');
                }).join(''),
                caseResults
                  ? (caseResults.autoPassed === null ? '\n\n⚠️ 这一组没有自动项（只有人工项）—— 工具不代判'
                    : '\n\n自动项 ' + caseResults.passedCount + '/' + caseResults.autoCount
                    + '；人工项 ' + caseResults.manualCount + ' 条等你打勾' + (caseResults.note ? ' — ' + caseResults.note : ''))
                  : '')
              : null),
          'simCases', caseResults ? (caseResults.autoPassed ? 'ok' : 'warn') : 'warn');

        /**
         * ④ 工程与控件树（**默认折叠**）：工程信息、工程适配（bind）与控件树平时不用盯着看，
         * 展开又会把上面两块挤下去（作者实测：「画面在左下角」就是这么来的）—— 塞进 `<details>`，要看再点开。
         */
        var engCard = React.createElement('details', { className: PLUGIN + '-sec', key: 'eng' },
          React.createElement('summary', { className: PLUGIN + '-sec-title' }, '④ 工程与控件树 / 工程适配'),
          sec('工程', st ? ((st.workspace && st.workspace.name) || '') : '读取中…',
            React.createElement(KVGrid, { rows: rows }), 'simInfo', st ? 'ok' : 'warn'),
          bindCard,
          (st && st.treeCount > 80)
            ? React.createElement('div', { className: PLUGIN + '-hint', key: 'more' }, '只列前 80 个（共 ' + st.treeCount + ' 个）')
            : null,
          React.createElement('div', { key: 'tree' }, treeNodes));

        /**
         * ① 画面与日志（**放最前**）：作者实测反馈「画面在左下角」——
         * 原来它排在「工程与控件树 + 工程适配」后面，那两块一长就把画面挤到看不见的地方。
         * 现在按"最常看的在最上面"排：画面/日志 → 试玩操作 → 验收单 → 工程（折叠）。
         */
        var shots = React.createElement('div', { className: PLUGIN + '-col', key: 'R' },
          React.createElement('div', { className: PLUGIN + '-col-head', key: 'h' }, '① 画面与日志'),
          React.createElement('div', { className: PLUGIN + '-simrow', key: 'row' },
            sec('画面', shot ? shot.name : '未取图',
              React.createElement('div', { key: 's' }, stage), 'simStage', shot ? 'ok' : 'warn'),
            sec('试玩日志', running ? '运行中' : '未开始',
              React.createElement('div', { className: PLUGIN + '-log', key: 'l', style: { maxHeight: '132px' } },
                logs.length ? logs.join('\n') : '（还没有日志：先点「开始试玩」）'), 'simLog', running ? 'ok' : 'warn')));

        /**
         * ② 试玩操作：传输控制 + 按键 + 设备/人数/视角 + **这一局的操作时间线**
         * （时间线就是 `verify fromHistory:true` 复用的那份 history —— 人在这里做的每一步，AI 都能变成回归用例）。
         */
        var ops = React.createElement('div', { className: PLUGIN + '-col', key: 'O' },
          React.createElement('div', { className: PLUGIN + '-col-head', key: 'h' }, '② 试玩操作'),
          React.createElement('div', { className: PLUGIN + '-hint', key: 'i' },
            (running ? '会话运行中' : '未开始') + ' · 帧 ' + statFrame + ' · 控件 ' + statControls),
          actions, keyRow, devRow,
          sec('操作时间线', hist.length ? '最近 ' + hist.length + ' 步' : '空',
            React.createElement('div', { className: PLUGIN + '-log', key: 'h', style: { maxHeight: '110px' } },
              hist.length
                ? hist.join('\n')
                : '（你在右边试玩页里点 / 按键之后，这里会出现可重放的操作序列 —— AI 用 op=verify fromHistory:true 直接把这一局变成回归用例）'),
            'simHist', hist.length ? 'ok' : 'warn'));

        /**
         * **试玩页**（右 2 份，作者要求）：直接 iframe 嵌 `GET /miliastra/play`（PixiJS WebGL，真能玩）。
         * 它跟面板、跟 AI **共用同一个会话与同一份工程** ——
         *   · 人：在页面里点/按键（引擎把这一局记成 history）；
         *   · AI：用 `miliastra_sim op=play`（key/pointer/step）驱动**同一个会话**，页面每 33ms 轮询场景，所以这里会跟着变。
         * 为什么用 iframe 而不是把 pixi 塞进面板：WebGL + 自己的 CSP 处理，独立页最稳（面板里只留缩略图与操作面）。
         */
        var playPane = React.createElement('div', { className: PLUGIN + '-playpane', key: 'P' },
          React.createElement('div', { className: PLUGIN + '-playhead', key: 'h' },
            React.createElement('span', { className: PLUGIN + '-col-head', key: 't' }, '试玩页（WebGL · 人可玩 / AI 可驱动）'),
            React.createElement('span', { className: PLUGIN + '-hint', key: 'i' }, '与 AI 的 `miliastra_sim` 共用同一个会话；关页面不会停局'),
            React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
            React.createElement('button', {
              className: PLUGIN + '-act', key: 'rf', title: '重新加载这一页（比如脚本改了要重开一局）',
              onClick: function () { setPlayNonce(function (n) { return n + 1; }); },
            }, '重载页面'),
            React.createElement('a', {
              className: PLUGIN + '-act', key: 'open', href: PREFIX + '/play', target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              title: '在新标签页打开（全屏玩更舒服）',
            }, '新窗口 ↗')),
          React.createElement('iframe', {
            key: 'f' + playNonce,
            className: PLUGIN + '-playframe',
            src: PREFIX + '/play',
            title: '千星模拟器试玩页（WebGL）',
          }));

        kids.push(React.createElement('div', { className: PLUGIN + '-simgrid', key: 'grid' },
          React.createElement('div', { className: PLUGIN + '-playside', key: 'L' }, [shots, ops, bookCard, engCard]),
          playPane));
        return React.createElement('div', { className: PLUGIN + '-simbody' }, kids);
      }

      /** 「模拟器」页 = 全宽面板壳 + 正文（正文 `SimulatorBody` 与侧边栏浮层**同源**，避免两套漂移） */
      function SimulatorView() {
        return React.createElement('div', {
          className: PLUGIN + '-panel ' + PLUGIN + '-inline',
          style: { position: 'relative', width: '100%', minHeight: '100%', maxHeight: 'none', borderRadius: 0, boxShadow: 'none' },
        }, React.createElement(SimulatorBody, {}));
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
      // 会话区三个 tab 的注册计划（纯数据）与模拟器视图 —— 都能在 SSR 下真渲染/真断言
      exports.__testViewTabs = VIEW_TABS;
      exports.__testSimulatorView = SimulatorView;
      exports.__testSimulatorBody = SimulatorBody;
      // 画布点击的坐标换算（纯函数）—— 写错会「点哪儿都点不到」且不报错，必须单独回归
      exports.__testStagePoint = stagePointFromEvent;
      exports.__testHistLine = histLine;
      // 日志格式化的两个纯函数也交出去 —— 拆分/判色这些逻辑值得单独回归（不必渲染整面板）。
      exports.__testParseLogRecord = parseLogRecord;
      exports.__testToLogRows = toLogRows;
      exports.__testLogRow = LogRow;
      // 「试玩完自动取」的判据是纯函数 —— 定时器不好测，判据必须能测。
      exports.__testAutoFollowStep = autoFollowStep;
      // 「开跑 → 该不该自动截图」也是纯函数判据，同样必须能回归
      exports.__testPtStep = ptStep;
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

            /*
             * 会话区顶部三个 tab（0.1.0 融合）。
             *
             * 落点：官方槽位 `conversation.view` —— DSH 的会话区就是按它渲染 tab 的
             * （`dsh-client-ui-conversation/lib/client.js` 里 `renderSlot("conversation.view", …)`，
             *  tab 列表来自 `slots.entries("conversation.view")`，`label` 由 `resolveSlotLabel` 解析）。
             * 注册形态与上面 sidebar 那条**完全一样**：`slots.inject(槽位, () => slots.register(options, Component))`。
             * 组件会收到 `{ viewRequest, openView, completeViewRequest }`（我们不出视图内跳转，忽略）。
             *
             * ⚠️ 三个 view 里**只有当前选中的那个会被挂载**（官方 `{ only: active.id }`），
             *    所以不会出现「三个 Panel 各自 15 秒轮询」。
             */
            var registerView = function (v) {
              push(slotsSvc.inject('conversation.view', function () {
                var Comp = v.sim
                  ? SimulatorView
                  : function () { return React.createElement(Panel, { inline: true, group: v.group }); };
                var unregister = slotsSvc.register({
                  name: 'conversation.view',
                  id: v.id,
                  order: v.order,
                  label: function () { return v.label; },
                }, Comp);
                console.log('[' + PLUGIN + '] 视图已注册：conversation.view id=' + v.id + ' label=' + v.label);
                return function () { try { unregister(); } catch (e) { /* ignore */ } };
              }));
            };
            for (var vi = 0; vi < VIEW_TABS.length; vi += 1) registerView(VIEW_TABS[vi]);

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
