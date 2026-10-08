/**
 * 常量与枚举（对应 Java 的 `common.constants` / `common.enums`）—— **唯一出处**。
 *
 * 为什么要有这一层：工具名/op 名此前是**内联字符串**，而且靠字符串映射再复制一遍
 * （`MIN_KIND = { miliastra_code: 'deploy' }`）⇒ 改名或新增工具会**静默失效**。
 */

/** 12 个工具名（字符串只在这里出现一次）。 */
export const TOOL = Object.freeze({
  HEALTH: 'miliastra_health', CODE: 'miliastra_code', MAP: 'miliastra_map', LOG: 'miliastra_log',
  ASSET: 'miliastra_asset', GEN: 'miliastra_gen', SIM: 'miliastra_sim', SHOT: 'miliastra_shot',
  PROBE: 'miliastra_probe', PLAYTEST: 'miliastra_playtest', KB: 'miliastra_kb', ECHO: 'miliastra_echo',
});

/** 高频 op 名（只收 `MIN_OPS` 与判据里用到的；其余 op 名仍以各工具 description 为准）。 */
export const OP = Object.freeze({
  DEPLOY: 'deploy', BIND: 'bind', ERRORS: 'errors',
});

/** 业务阈值（魔法值的唯一出处）。 */
export const LIMIT = Object.freeze({
  FLOOD_MIN: 20,            // logFlood：同一句 ≥ 这个次数才算"淹没"
  SAMPLE_COLS_MAX: 512,     // op=measure 采样列数上限
  BRIEF_BYTES: 1024,        // health brief 的体积预算（回归断言用）
  SCHEMA_SOFT: 40 * 1024,   // 工具 schema 软线（只警告）
  SCHEMA_HARD: 50 * 1024,   // 工具 schema 硬线（超了红）
});

/** `receipt:"min"` 骨架档：哪些工具、哪些 op（**用常量拼，不再写内联字符串**）。 */
export const MIN_KIND = Object.freeze({
  [TOOL.CODE]: 'deploy',
  [TOOL.SIM]: 'sim',
  [TOOL.LOG]: 'errors',
});

/** 哪些 op 才吃 `receipt:"min"` 的骨架（其余 op 原样返回，免得套错骨架）。 */
export const MIN_OPS = Object.freeze({
  [TOOL.CODE]: [OP.DEPLOY],
  [TOOL.SIM]: [OP.BIND],
  [TOOL.LOG]: [OP.ERRORS],
});

/** 工具 description 的统一前缀（“千星奇域”）。 */
export const TITLE = '千星奇域';
