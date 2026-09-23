/**
 * logdiag.mjs — 「我刚试玩了，为什么没有日志？」的判据。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 为什么要有这个东西（2026-09-23 实机踩到）
 * ───────────────────────────────────────────────────────────────────────────
 * 作者试玩了一局，回来让「看看」—— 磁盘上**一个新的 `.gia` 都没有**，
 * 而当时的工具只会安安静静地把**上一次的旧日志**端上来。用户不知道自己漏了哪一步，
 * 最后原因是他**忘了开试玩**。
 *
 * 这类「空结果」最坑的地方是：它和「脚本没 print」「日志被配置关掉」「试玩还在进行中」
 * 长得一模一样。所以这里把「人肉判断」抽成**可断言的判据**，并把**能拿到的事实**摆出来
 * （时间 / 进程 / 地图存盘时间），给出结论 + 下一步，而不是让人自己猜。
 *
 * ⚠️ 判据只用**拿到的事实**，不做无根据的推断。拿不到的字段就说明拿不到。
 */

/** `2026-09-23_18-44-57_151_201170108.gia` → `18:44:57`。 */
export function shortestSessionName(name) {
  const m = /^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})/.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}:${m[3]}` : String(name || '');
}

/** 「刚写过」的阈值：最近一局在这个秒数内写过，就当作就是刚才那局。 */
export const FRESH_SEC = 120;

/**
 * @param {object} input
 * @param {Array<{name:string,size:number,mtime:string}>} input.files 日志文件（倒序）
 * @param {{editorRunning:boolean, gameRunning:boolean}|null} input.procs 进程状态（拿不到传 null）
 * @param {number|null} input.gilMtimeMs 地图存档最后修改时间
 * @param {number} input.now 当前时间（毫秒）—— 传进来是为了可测
 * @param {number} [input.freshSec]
 * @returns {{verdict:string, headline:string, why:string[], next:string[], facts:object}}
 */
export function diagnoseLogs({ files, procs, gilMtimeMs, now, freshSec = FRESH_SEC } = {}) {
  const list = Array.isArray(files) ? files : [];
  const newest = list[0] || null;
  const editorRunning = !!(procs && procs.editorRunning);
  const gameRunning = !!(procs && procs.gameRunning);

  if (!newest) {
    const why = ['从没跑过试玩，或试玩在加载关卡前就退出了'];
    if (!editorRunning) why.push('编辑器当前**不在运行**');
    if (!gameRunning) why.push('游戏客户端当前**不在运行**');
    return {
      verdict: 'no-logs',
      headline: '这个日志目录里一个 .gia 都没有 —— 这张图从来没试玩过（或试玩没起来过）。',
      why,
      next: ['在编辑器里点「试玩」，起来后回到这里再取日志'],
      facts: { logCount: 0 },
    };
  }

  const ageSec = Math.round((now - Date.parse(newest.mtime)) / 1000);
  const gilAgeSec = gilMtimeMs ? Math.round((now - gilMtimeMs) / 1000) : null;
  const facts = {
    logCount: list.length,
    newestName: newest.name,
    newestShort: shortestSessionName(newest.name),
    newestSize: newest.size,
    newestAgeSec: ageSec,
    gameRunning,
    editorRunning,
    mapSavedAgeSec: gilAgeSec,
    freshThresholdSec: freshSec,
  };

  if (ageSec <= freshSec) {
    return {
      verdict: 'fresh',
      headline: `最近一局是 ${ageSec} 秒前写的（${shortestSessionName(newest.name)}）—— 这应该就是你刚才那局。`,
      why: [],
      next: ['直接「取日志」即可'],
      facts,
    };
  }

  const mins = Math.floor(ageSec / 60);
  const ago = mins >= 60 ? `${Math.floor(mins / 60)} 小时前` : `${mins} 分钟前`;
  const why = [];
  if (gameRunning) {
    why.push('① 或者**其实没点「试玩」**（最常见）—— **游戏客户端开着 ≠ 在试玩**；'
      + '实测同一个游戏进程跨了一整天的全部试玩，所以「进程在跑」完全不能当判据');
    why.push('② **或者试玩还在进行中** —— `.gia` 的落盘时机**尚未完全实测**（有可能只在结束时写），'
      + '所以「进行中」也是一个合理解释');
  } else {
    why.push('① **游戏客户端不在运行** —— 试玩根本没起来');
  }
  if (!editorRunning) why.push('编辑器当前**不在运行** —— 没法点试玩');
  if (gilAgeSec != null && gilAgeSec < ageSec) {
    why.push(`③ 地图在最近（${Math.round(gilAgeSec / 60)} 分钟前）**存过盘** —— 你动过编辑器，但存盘不会产生日志`);
  }
  why.push('④ 编辑器「日志」面板里 **`客户端脚本` 没勾选** → 脚本 print 不会落盘（该面板左侧是节点图选择树，要勾选后点「确认选择」）');

  return {
    verdict: 'stale',
    headline: `⚠️ 最近一局是 ${ago}写的（${shortestSessionName(newest.name)}）—— **你刚才那局没有写出日志**。`,
    why,
    next: [
      '① 在编辑器里**点「试玩」**（这是最常见的原因：游戏客户端开着，但没从编辑器开试玩）',
      '② 起来后**再点一次「试玩体检」** —— 若显示「刚写过」，那就取日志',
      '③ 结束后仍没有 → 去编辑器「日志」面板确认 `客户端脚本` 是勾上的，并点「确认选择」',
    ],
    facts,
  };
}
