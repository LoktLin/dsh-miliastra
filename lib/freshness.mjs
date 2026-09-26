/**
 * freshness.mjs — 「这份数据属于**哪一次**（哪一局 / 哪一次存盘）」+「它是不是**当前那一份**」（P0-2）
 *
 * 为什么要单开一个模块：`miliastra_log` 早就有一条救过命的口径（`staleLog` / `logBelongsTo`，反馈 A2）——
 * **`.gia` 是一局结束后才落盘的**，所以「我读到的是不是刚跑那一局」必须显式回答，
 * 否则人（和 AI）会把**上一局**的日志当成本局证据。
 *
 * 同一个风险在别的 op 上一直在：
 *   · `miliastra_map op=script` —— 比对的是 **`.gil` 里那份存盘快照**，不是此刻磁盘上的活文件；
 *   · `miliastra_health op=sha`  —— `.gil` 那一列同样是**上一次存盘时**嵌进去的那一份。
 * 两处都可能在「活文件已经改了、编辑器还没存盘」时让人误判成「跑的就是本地这版」。
 *
 * 所以这里只做**纯函数**的三件事（可单测、无 I/O）：
 *   ① `belongsTo` —— 这份数据属于哪一次（名字 + **本地时间** + **epoch 秒**）；
 *   ② `isCurrent` —— 与「当前那一份」的对比结果（拿不到对比基准就是 `null`，**不猜**）；
 *   ③ `note` —— 一句人话：一致/不一致分别意味着什么、下一步做什么。
 *
 * ★ 本仓纪律：**缺证据时明说「没有证据」**，绝不静默给一个看起来像结论的旧数据。
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（人读；`belongsTo` 里用这个）。 */
export function localTimeText(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * 这份（快照 / 某一局）数据属于谁、是不是当前那一份。
 *
 * @param {{kind?:string, label?:string, name?:string|null, atMs?:number|null,
 *          currentAtMs?:number|null, currentLabel?:string|null, what?:string|null,
 *          advice?:string|null}} [input]
 *   · `kind`   —— 数据的种类（写进 belongsTo 的抬头，如 `存盘快照` / `试玩局`）
 *   · `name`   —— 文件名或局标识（如 `1073741833.gil` / `2026-09-26_21-03-11_179.gia`）
 *   · `atMs`   —— **这份数据的时间**（`.gil` 的 mtime / 那一局的开跑时刻）
 *   · `currentAtMs` —— 「当前那一份」的时间（活文件的 mtime）；**不给 = 没有对比基准**
 *   · `what`   —— 这份数据是什么（默认「这份数据」），用来拼人话
 *   · `advice` —— 不一致时的下一步（默认给「编辑器里存一次盘」这条通用建议）
 * @returns {{known:boolean, belongsTo:string|null, belongsToAt:string|null,
 *            belongsToEpochSec:number|null, isCurrent:boolean|null, note:string}}
 */
export function snapshotFreshness({
  kind = '快照', label = null, name = null, atMs = null,
  currentAtMs = null, currentLabel = null, what = null, advice = null,
} = {}) {
  const head = [label || kind, name || null].filter(Boolean).join(' ');
  const t = Number.isFinite(Number(atMs)) && atMs !== null ? Number(atMs) : null;
  const atText = t === null ? null : localTimeText(t);
  const epochSec = t === null ? null : Math.floor(t / 1000);
  const belongsTo = head + (atText ? ' (存于 ' + atText + ' / epochSec ' + epochSec + ')' : ' (时间未知)');
  const thing = what || '这份数据';

  // ① 连自己那份数据的时间都没有 ⇒ **没有证据**，不猜「是不是当前」
  if (t === null) {
    return {
      known: false, belongsTo, belongsToAt: null, belongsToEpochSec: null, isCurrent: null,
      note: '**没有证据**：拿不到' + thing + '的时间/身份（' + belongsTo + '）—— 判断不了它是不是当前那一份，别当成刚出的结果。',
    };
  }

  // ② 有自己那份的时间、但没有「当前那一份」可比 ⇒ 如实说不一致判不了
  const cur = Number.isFinite(Number(currentAtMs)) && currentAtMs !== null ? Number(currentAtMs) : null;
  if (cur === null) {
    return {
      known: false, belongsTo, belongsToAt: atText, belongsToEpochSec: epochSec, isCurrent: null,
      note: '**没有对比基准**：' + belongsTo + ' 已定位，但没拿到「当前那一份」的时间 —— 判断不了它是不是最新的（' + thing + '）。',
    };
  }

  const isCurrent = t >= cur;
  const curText = localTimeText(cur);
  return {
    known: true, belongsTo, belongsToAt: atText, belongsToEpochSec: epochSec, isCurrent,
    note: isCurrent
      ? '**是当前那一份**：' + belongsTo + ' 不早于' + (currentLabel ? currentLabel + '（' + curText + '）' : '对比基准（' + curText + '）') + '。'
      : '⚠️ **不是当前那一份**：' + belongsTo + ' **早于**'
        + (currentLabel ? currentLabel + '（' + curText + '）' : '对比基准（' + curText + '）')
        + ' —— ' + (advice || '活文件已经改过了：在编辑器里**存一次盘**（把活文件吃进地图）再重新看，试玩跑的永远是嵌进 .gil 的那份快照。'),
  };
}
