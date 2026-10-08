/**
 * ## 码规范（2026-10-08 定，**由 tools/lint.mjs 强制**：包内不许出现 `code: '大写字面量'`）
 *
 * ### 两类码，别混用
 * | 类别 | 用在哪 | 枚举 | 语义 |
 * |---|---|---|---|
 * | **失败码** | `{ok:false, code}` —— 工具回执的失败档 | `ReceiptCode` | 调用方**要分支**的原因 |
 * | **警告码** | 成功回执里的 `warnings[].code` | `WarnCode` | **不是失败**，只是「这处我替你做了个决定 / 有东西被丢了」的提示项 |
 * 失败档**必带** `code`（`withFallbackCode()` 兜 `FAILED`）；警告码只出现在数组元素里，**不带 `ok`**。
 *
 * ### 命名
 * - 全大写 + 下划线；
 * - **通用语义码**不带域：`BAD_PARAM` / `NOT_FOUND` / `NO_EVIDENCE` / `GATE_FAILED` / `FAILED` / `TOOL_THREW`；
 * - **具体原因**=`<域>_<原因>`：`GATES_NO_TOOLS` / `MEASURE_NO_SOURCE` / `RESTORE_TARGET_MISMATCH` / `FX_PATHS_BAD`；
 * - 域用工具/能力名（`GATES` / `MEASURE` / `FX` / `BOOT` / `GRID` …），别用动词短语。
 *
 * ### 什么时候才新增一个码
 * **只有当调用方需要据此分支时才加**（例如「门禁跑不起来」与「门禁没通过」要分开处理）。
 * 只给人看的信息写进 `error` / `hint` / `note`，**不要造码** —— 码一多就没人记得住，反而失去机器可读的意义。
 *
 * ### 兼容别名
 * `GATES_FAILED` 是 `GATE_FAILED` 的**旧名**（历史上门禁那处用复数）。保留它只为不破坏既有消费者，
 * 新代码一律用 `GATE_FAILED`。
 */
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
  /** op=bind 的探针改写失败 */
  BOOT_PATCH_FAILED: 'BOOT_PATCH_FAILED',
  /** 粒子/图元特效：没拿到容器节点索引 */
  FX_CONTAINER_MISSING: 'FX_CONTAINER_MISSING',
  /** 粒子/图元特效：交接值不够（模板索引 / 控件名 / 容器都缺） */
  FX_HANDOVER_MISSING: 'FX_HANDOVER_MISSING',
  /** 粒子/图元特效：paths 形状不合法 */
  FX_PATHS_BAD: 'FX_PATHS_BAD',
  /** 粒子/图元特效：多段路径不被支持 */
  FX_PATHS_MULTISEG_UNSUPPORTED: 'FX_PATHS_MULTISEG_UNSUPPORTED',
  /** 旧名（= GATE_FAILED）：工作区门禁没过（保留兼容） */
  GATES_FAILED: 'GATES_FAILED',
  /** 工作区门禁：没给 source，判不了 */
  GATES_NO_SOURCE: 'GATES_NO_SOURCE',
  /** 工作区门禁：工程里找不到门禁脚本 ⇒ 判不了（不等于通过） */
  GATES_NO_TOOLS: 'GATES_NO_TOOLS',
  /** 关卡名匹配到多个 ⇒ 要显式指定 */
  LEVEL_AMBIGUOUS: 'LEVEL_AMBIGUOUS',
  /** op=measure：图片解码失败 */
  MEASURE_DECODE_FAILED: 'MEASURE_DECODE_FAILED',
  /** op=measure：没给图源（assetId / source 都缺） */
  MEASURE_NO_SOURCE: 'MEASURE_NO_SOURCE',
  /** 部署前自检没过 */
  PRECHECK_FAILED: 'PRECHECK_FAILED',
  /** 还原：指定文件与实际目标对不上 ⇒ 拒绝 */
  RESTORE_TARGET_MISMATCH: 'RESTORE_TARGET_MISMATCH',
  /** 生成物落盘失败 */
  SAVE_FAILED: 'SAVE_FAILED',
});

/**
 * **警告码**：成功回执里 `warnings[].code` 用的分类。**不是失败** —— 只是「我替你做了决定 / 有东西被丢了」。
 * 规则见文件顶部的《码规范》。
 */
export const WarnCode = Object.freeze({
  /** 网格用了默认值（没给 cols/rows/maxSide） */
  GRID_DEFAULTED: 'GRID_DEFAULTED',
  /** 网格按原图长宽比推出来的一边 */
  GRID_FROM_ASPECT: 'GRID_FROM_ASPECT',
  /** 交接值是从 .gil 自动取到的（唯一候选才采用） */
  HANDOVER_AUTO_FROM_GIL: 'HANDOVER_AUTO_FROM_GIL',
  /** controlName 与 templateIndex 都给了 ⇒ 用了前者 */
  HANDOVER_BOTH_GIVEN: 'HANDOVER_BOTH_GIVEN',
  /** 在 OnStart 里建控件（层级/时序有坑，见文档） */
  INSTANTIATE_IN_ONSTART: 'INSTANTIATE_IN_ONSTART',
  /** 控件数量偏多（性能提示） */
  MANY_CONTROLS: 'MANY_CONTROLS',
  /** 文本超过单条上限，导入会失败 */
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  /** 全透明的格子被丢掉了 */
  TRANSPARENT_CELLS_DROPPED: 'TRANSPARENT_CELLS_DROPPED',
  /** 带未验证的语法（例如 size 标签） */
  UNVERIFIED_SYNTAX: 'UNVERIFIED_SYNTAX',
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
