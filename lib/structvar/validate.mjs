// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/StructViewer/StructViewer.vue
//   （10 位 ID 校验 `/^\d+$/.test(inputId) && inputId.length != 10`）与
//   src/views/StructViewer/components/ParamNodeRender.vue（`value.length >= 500` 的文本上限提示）、
//   src/views/StructViewer/types/WorkspaceManifest.ts（`struct_ype` 这个字段名）。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ **两条硬规则（生成前校验，不通过就报错）**：
//   ① 结构体 ID 必须是 **10 位数字**；② 单条文本 **≤ 500 字符**（超了千星导不进去）。
//   ⚠️ 与源码的一处**刻意差异**：源码对 ② 只 `toast.warning` 就放行（"网页允许保存"）——
//      我们默认**直接报错**，要放行得显式传 `allowLongText:true`（那时才降级成回执里的 `warnings[]`）。

import { PARAM_TYPES, SPELLING_KEYS, STRUCT_ID_LENGTH, TEXT_LIMIT, isParamType } from './model.mjs';

const ID_RE = /^\d+$/;

/** 10 位数字 ID？ */
export function isStructId(v) {
  const s = String(v == null ? '' : v);
  return ID_RE.test(s) && s.length === STRUCT_ID_LENGTH;
}

/**
 * 校验结构体 ID；不合法就抛（错误文案里说清"期望什么 / 实际什么"）。
 * @param {any} v
 * @param {string} where 出错位置（如 `structId` / `$.value[2].structId`）
 * @returns {string} 原样返回（字符串形态）
 */
export function assertStructId(v, where = 'structId') {
  const s = String(v == null ? '' : v);
  if (s === '') throw new Error(`${where} 不能为空：必须是 ${STRUCT_ID_LENGTH} 位数字字符串`);
  if (!ID_RE.test(s)) throw new Error(`${where}=${JSON.stringify(v)} 不是纯数字：必须是 ${STRUCT_ID_LENGTH} 位数字（源码文案：请输入有效10位长度的整数ID！）`);
  if (s.length !== STRUCT_ID_LENGTH) throw new Error(`${where}=${JSON.stringify(v)} 是 ${s.length} 位，必须是 ${STRUCT_ID_LENGTH} 位数字`);
  return s;
}

/**
 * 校验一个 `ParamType`；不认识就抛并列出全部 24 个合法值。
 * @param {any} t
 * @param {string} where
 * @returns {string}
 */
export function assertParamType(t, where = 'param_type') {
  const s = String(t == null ? '' : t);
  if (!isParamType(s)) {
    throw new Error(`${where}=${JSON.stringify(t)} 不是认识的类型（24 个：${PARAM_TYPES.join(' / ')}）`);
  }
  return s;
}

/**
 * `struct_ype` 这个拼写：**是文件的既成事实**，不是我们编的。
 *
 * 证据：同仓库里 **25 份真实千星结构体样例**（`src/assets/DSFGStudio/` 下的 `*.json`）**全部**写
 * `"struct_ype": "basic"`，且整个仓库里搜不到 `struct_type`。所以：
 *   · **读到要认**：两个键都接受（`struct_ype` 优先，它才是样例里的那个）；
 *   · **写出默认沿用样例里的 `struct_ype`**（跟着证据走）；
 *   · 但工具**暴露 `spelling` 参数**，可以显式改成 `struct_type`（文档口径说的"正确拼写"）。
 * ⚠️ **未证实**：千星真正吃哪一个，我们手里没有官方规格 —— 回执里如实标 `unverified`。
 * @param {any} raw `struct_ype` / `struct_type` / undefined
 * @returns {'struct_ype' | 'struct_type'}
 */
export function normalizeSpelling(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return 'struct_ype';
  if (s === 'struct_ype' || s === 'struct_type') return s;
  throw new Error(`不认识的 spelling：${JSON.stringify(raw)}（合法值：${SPELLING_KEYS.join(' / ')}）`);
}

/**
 * 从一个「结构体定义」对象里读出它的拼写键（读到要认：两个都认，`struct_ype` 优先）。
 * @param {Record<string, any>} obj
 * @returns {'struct_ype' | 'struct_type' | null}
 */
export function readSpellingKey(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.struct_ype === 'string') return 'struct_ype';
  if (typeof obj.struct_type === 'string') return 'struct_type';
  return null;
}

/**
 * 遍历已生成的结构体 JSON，收集所有「文本」的长度事实（只报数字，不判决）。
 * 覆盖 `String` 与 `StringList` 的元素（`StringList` 是按元素算"单条"的）。
 * @param {any} node
 * @param {string} [path]
 * @param {Array<{path: string, param_type: string, length: number, preview: string}>} [out]
 * @returns {Array<{path: string, param_type: string, length: number, preview: string}>}
 */
export function collectTexts(node, path = '$', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectTexts(v, `${path}[${i}]`, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const t = node.param_type;
  if (t === 'String' && typeof node.value === 'string') {
    out.push({ path, param_type: 'String', length: node.value.length, preview: node.value.slice(0, 24) });
  } else if (t === 'StringList' && Array.isArray(node.value)) {
    node.value.forEach((v, i) => {
      const s = String(v == null ? '' : v);
      out.push({ path: `${path}.value[${i}]`, param_type: 'StringList', length: s.length, preview: s.slice(0, 24) });
    });
  }
  for (const k of Object.keys(node)) collectTexts(node[k], `${path}.${k}`, out);
  return out;
}

/**
 * 500 字符上限校验。返回 `{ok, over, max}`；`over` 非空时由调用方决定报错还是降级成警告。
 * @param {any} root
 * @returns {{ok: boolean, max: number, over: Array<{path: string, param_type: string, length: number, preview: string}>}}
 */
export function checkTextLimit(root) {
  const texts = collectTexts(root);
  const over = texts.filter((t) => t.length > TEXT_LIMIT);
  const max = texts.reduce((m, t) => Math.max(m, t.length), 0);
  return { ok: over.length === 0, max, over };
}
