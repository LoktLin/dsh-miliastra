/**
 * 测试公共助手（阶段 4 去重：`gen-test` / `pixelart-test` / `vfx-test` 原本各写一份 `throws`）。
 *
 * ★ 语义要点（2026-10-08 起）：工具出口已统一「**失败回 `{ok:false}` 回执、不抛异常**」⇒
 *   本助手**同时接受两种拒绝形态**：
 *     ① 真的抛异常（同步 throw）；
 *     ② 回执 `ok:false`（把 `error` 当作错误文案 —— 而且**约定它必须存在**）。
 *   断言意图不变：**坏输入必须被明确拒绝，且文案里要有该有的关键词**。
 */
import assert from 'node:assert';

/**
 * 断言 `fn()` 被明确拒绝（抛异常或回 `ok:false`），并可选校验文案含 `mustInclude`；返回错误文案。
 * @param {() => any} fn 触发动作（同步即可；异步请先 await 包一层）
 * @param {string} [mustInclude] 文案里必须出现的子串
 * @param {string} [msg] 断言失败时的人话说明
 */
export function throws(fn, mustInclude, msg) {
  let err = null;
  try {
    const r = fn();
    if (r && typeof r === 'object' && r.ok === false) err = String(r.error || r.code || '（ok:false 但没有 error）');
  } catch (e) { err = (e && e.message) || String(e); }
  assert(err !== null, (msg || '应当报错') + '，但没报错');
  if (mustInclude) assert(err.includes(mustInclude), '错误文案里没有「' + mustInclude + '」：' + err);
  return err;
}
