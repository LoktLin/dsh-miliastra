/**
 * 工具出口的渲染器（阶段 3 · 前置搬移）。
 *
 * `renderJson` = 把回执渲染成宿主认的 text 段（缩进 1，省 token）。**所有工具共用**，
 * 所以它必须在 `lib/` 里而不是 `index.js` —— 否则每个 `lib/tools/*.mjs` 都要反向 import `index.js`
 * （循环依赖 + TDZ 风险）。
 */
export const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];
