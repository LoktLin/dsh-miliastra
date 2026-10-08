/**
 * 统一返回（对应 Java 的 `R<T>` + `ErrorCode`）—— **本仓唯一的回执构造出处**。
 *
 * 规矩（引用自《架构规划》§4 与仓库红线）：
 *   ① 失败**回回执、不抛异常**（抛出去会打断调用方一整轮）；
 *   ② 失败**必带 `code`**（机器可读、可分支；没有精确 code 时由 `withFallbackCode()` 兜 `FAILED`）；
 *   ③ 成功档不强求字段一致（各工具业务字段本就不同），但**结论字段不许因为瘦身而丢**。
 */

/** 错误码枚举（`Object.freeze` 防手滑改）。有精确 code 的用精确的；没有的兜 `FAILED`。 */
export const ReceiptCode = Object.freeze({
  OK: 'OK',
  BAD_PARAM: 'BAD_PARAM',
  NOT_FOUND: 'NOT_FOUND',
  NO_EVIDENCE: 'NO_EVIDENCE',
  GATE_FAILED: 'GATE_FAILED',
  TOOL_THREW: 'TOOL_THREW',
  FAILED: 'FAILED',
});

/** 成功回执（薄封装：`{ ok:true, ...data, ...meta }`）。 */
export const ok = (data = {}, meta = {}) => ({ ok: true, ...data, ...meta });

/** 失败回执（薄封装：**必带 code**）。`nextStep` 建议给 —— 让调用方知道下一步做什么。 */
export const fail = (code, error, meta = {}) => ({ ok: false, code, error, ...meta });

/**
 * 失败档 **code 兜底**：`ok:false` 且没 `code` ⇒ 补 `FAILED`。
 * `FAILED` 的含义是"这条路径还没细分 code，请看 `error` 文案"，**不是**"失败原因未知"。
 */
export const withFallbackCode = (res) => (res && typeof res === 'object' && res.ok === false && !res.code
  ? { ...res, code: ReceiptCode.FAILED } : res);

/**
 * ★★ P0-2（《上下文瘦身设计》2026-10-07）：**`receipt:"min"` —— 精简骨架档**。
 *
 * 与 `summaryOnly` 的**区别**（两个参数都要在 description 里互相点名，防撞车）：
 *   · `summaryOnly` = **去掉体积**（拿掉逐条明细 / 正文），**保留原来的字段与结论**；
 *   · `receipt:"min"` = **换一副骨架**（只留"这一轮决策必需"的那一小撮字段），字段名也按骨架来。
 * ⇒ 结论字段（`ok` / `bytes` / `sha` / `match` / `errors`）**一个都不能少**，否则 AI 就得再调一次。
 *
 * ⚠️ **不给 `receipt` 时行为一字节不变**（默认 `"full"`）。
 *
 * @param {any} res 工具的完整回执
 * @param {'deploy'|'sim'|'errors'} kind 哪一类骨架
 */
export function minifyReceipt(res, kind) {
  if (!res || typeof res !== 'object') return res;
  const pick = (o, keys) => { /** @type {Record<string, any>} */ const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
  if (kind === 'deploy') {
    const rec = res.reconcile || {};
    /** @type {Record<string, any>} */
    const out = {
      receipt: 'min', ok: res.ok,
      ...pick(res, ['op', 'dest', 'selectedFile', 'pickedBy', 'src', 'bytes', 'backup', 'fixedBackup', 'error']),
      sha256_12: typeof res.sha256 === 'string' ? res.sha256.slice(0, 12) : null,
      syntax_ok: res.syntax ? res.syntax.ok === true : null,
      lint_error: res.lint && Array.isArray(res.lint.problems) ? res.lint.problems.length : 0,
      live_bytes: rec.liveBytes == null ? null : rec.liveBytes,
      embed_bytes: rec.embeddedBytes == null ? null : rec.embeddedBytes,
      match: rec.match === undefined ? null : rec.match,
      prodUnchanged: res.prodUnchanged === undefined ? null : res.prodUnchanged,
      knownPitCount: res.knownPitCount === undefined ? null : res.knownPitCount,
    };
    if (Array.isArray(res.checklist)) out.checklist = res.checklist;   // P3-7 的短句清单（有就带上）
    return out;
  }
  if (kind === 'sim') {
    const run = res.run || {};
    return {
      receipt: 'min', ok: res.ok,
      ...pick(res, ['op', 'bound', 'fresh', 'scriptCount', 'error']),
      controlCount: run.controlCount == null ? null : run.controlCount,
      logCount: run.logCount == null ? (Array.isArray(run.logs) ? run.logs.length : null) : run.logCount,
      logs: Array.isArray(run.logs) ? run.logs.slice(0, 40) : null,
      liveBytes: res.source && res.source.bytes != null ? res.source.bytes : null,
      nextStep: res.nextStep || null,
    };
  }
  if (kind === 'errors') {
    return {
      receipt: 'min', ok: res.ok,
      ...pick(res, ['op', 'file', 'count', 'returned', 'truncated', 'runsAffected', 'kindCounts', 'errors', 'error', 'hint']),
      // `errorsMeaningless` 必须带上：**不清档就会把"过期日志"当"零报错"**（今天修过的那个坑）
      errorsMeaningless: res.errorsMeaningless === undefined ? null : res.errorsMeaningless,
    };
  }
  return res;
}
