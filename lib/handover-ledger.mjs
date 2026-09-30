/**
 * handover-ledger.mjs — **已确认交接值台账**（P2-8）
 *
 * 解决什么问题：创作者已经把 `container:1073741846` 确认过一次了，但工具**只有唯一候选才采用**，
 * 于是 `.gil` 里有 3 个容器节点时它拒绝采用（**做得对，不猜**）⇒ 每次调用都得人再传一遍。
 * 本轮实测：9 个脚本 × 每次重发，这个开销线性涨。
 *
 * ★★ 设计上**只认显式确认**（`miliastra_health op=handover set …`），**绝不自动学习**。
 *    为什么这条是硬规矩（上一版就栽在这）：如果"调用时传了 `container` 就顺手记下来"，
 *    那么一次**传错的号**会被永久写进台账，而且**当真机症状出现时**你再也看不出它是哪来的；
 *    更隐蔽的是它会**改掉「缺交接值 ⇒ ok:false」这个语义** —— 实测把 `gen-test` /
 *    `fx-hardening-test` 两道门禁同时打红（上一轮已整块回退过一次）。
 *    ⇒ 明确一次（`set`）才记；没 `set` 过就照旧"缺值就报错"。
 *
 * ★ 台账落在**插件数据目录**（`MILIASTRA_DATA_DIR` > `~/.dsh/miliastra`），**不进游戏存档、不碰活文件**。
 *   路径**每次调用现算**（不缓存）—— 因为测试是在 import 之后才把 `MILIASTRA_DATA_DIR` 指到临时目录的。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from './fsx.mjs';

/**
 * `handoverFrom` 的字符串拼装 —— **顺序是既有契约，别改**。
 *
 * 历史值（2026-09-28 起就在回执与 `docs/功能详解.md` 里）：`arg` / `gil` / **`gil+arg`** / `null`。
 * ⚠️ 2026-09-30 加台账时我顺手把顺序写成了 `arg+gil`（因为代码里先判 arg）—— 那是**静默的契约变更**：
 *    下游（另一个 AI / 面板 / 文档）按 `gil+arg` 匹配就认不出来。所以这里把顺序**钉死成 gil 在前**，
 *    台账只在**末尾**追加 `+ledger`（新档位，与旧值不会混淆）。
 *
 * @param {{arg?: boolean, gil?: boolean, ledger?: boolean}} parts
 * @returns {string|null}
 */
export function handoverFromString({ arg = false, gil = false, ledger = false } = {}) {
  const out = [];
  if (gil) out.push('gil');
  if (arg) out.push('arg');
  if (ledger) out.push('ledger');
  return out.length ? out.join('+') : null;
}

/** 台账里的**角色**（一个关卡可能同时需要"图片模板"和"文本框模板"，所以按角色分开存，不共用一个 templateIndex）。 */
export const ROLE = Object.freeze({
  container: 'container',                 // 容器节点索引（粒子/像素画的父容器）
  imageTemplate: 'template:image',        // 图片控件模板索引
  textboxTemplate: 'template:textbox',    // 文本框控件模板索引
  textboxControlName: 'control:textbox',  // 文本框控件名（text-gradient 要的是名字，不是模板号）
});

/** 角色的中文名（回执里给人看）。 */
export const ROLE_LABEL = Object.freeze({
  [ROLE.container]: '容器节点索引',
  [ROLE.imageTemplate]: '图片控件模板索引',
  [ROLE.textboxTemplate]: '文本框控件模板索引',
  [ROLE.textboxControlName]: '文本框控件名',
});

/** 插件数据根目录：`MILIASTRA_DATA_DIR` > `DSH_HOME/miliastra` > `~/.dsh/miliastra`（**每次现算**）。 */
export function ledgerDataRoot(env = process.env) {
  if (env && env.MILIASTRA_DATA_DIR) return path.resolve(String(env.MILIASTRA_DATA_DIR));
  if (env && env.DSH_HOME) return path.join(path.resolve(String(env.DSH_HOME)), 'miliastra');
  return path.join(os.homedir(), '.dsh', 'miliastra');
}

/** 台账文件绝对路径。 */
export function ledgerPath(env = process.env) {
  return path.join(ledgerDataRoot(env), 'handover-ledger.json');
}

/**
 * 读整本台账。**读不到就当成空台账**（没有文件是正常状态，不是错误）。
 * @returns {{ok: true, path: string, version: number, levels: Record<string, Record<string, any>>}}
 */
export function readLedger(env = process.env) {
  const file = ledgerPath(env);
  const empty = { ok: /** @type {true} */ (true), path: file, version: 1, levels: {} };
  let raw;
  try {
    if (!fs.existsSync(file)) return empty;
    raw = fs.readFileSync(file, 'utf8');
  } catch { return empty; }
  try {
    const parsed = JSON.parse(raw);
    const levels = parsed && typeof parsed.levels === 'object' && parsed.levels ? parsed.levels : {};
    return { ok: true, path: file, version: Number(parsed && parsed.version) || 1, levels };
  } catch { return empty; }   // 文件坏了：当空台账（**不删**，磁盘是用户的）
}

/**
 * 查一个角色的已确认值。
 * @param {{levelId?: any, role?: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {{value: any, role: string, confirmedAt: string|null, confirmedBy: string|null, levelId: string}|null}
 */
export function lookupHandover({ levelId, role, env = process.env } = {}) {
  const lv = levelId === undefined || levelId === null ? '' : String(levelId).trim();
  if (!lv || !role) return null;
  const book = readLedger(env);
  const entry = book.levels[lv];
  if (!entry || typeof entry !== 'object') return null;
  const cell = entry[role];
  if (!cell || typeof cell !== 'object') return null;
  if (cell.value === undefined || cell.value === null) return null;
  return {
    value: cell.value,
    role,
    confirmedAt: cell.confirmedAt || null,
    confirmedBy: cell.confirmedBy || null,
    levelId: lv,
  };
}

/**
 * 写一条（**只有显式确认才会走到这里**）。
 * @param {{levelId?: any, role?: string, value?: any, confirmedBy?: string, env?: NodeJS.ProcessEnv, now?: Date}} opts
 * @returns {{ok: boolean, path?: string, levelId?: string, role?: string, value?: any, replaced?: any, error?: string}}
 */
export function setHandover({ levelId, role, value, confirmedBy = 'creator', env = process.env, now } = {}) {
  const lv = levelId === undefined || levelId === null ? '' : String(levelId).trim();
  if (!lv) return { ok: false, error: '台账要按**关卡**记，但当前没有可用的关卡 ID —— 传 `level`，或在编辑器里打开目标地图。' };
  const roles = Object.values(ROLE);
  if (!roles.includes(/** @type {any} */ (role))) {
    return { ok: false, error: `没有这个角色 "${role}"（可用：${roles.join(' / ')}）` };
  }
  if (value === undefined || value === null || String(value).trim() === '') return { ok: false, error: `角色 ${role} 的值是空的。` };
  const file = ledgerPath(env);
  const book = readLedger(env);
  const entry = Object.assign({}, book.levels[lv]);
  const replaced = entry[role] ? entry[role].value : null;
  entry[role] = {
    value,
    confirmedAt: (now instanceof Date ? now : new Date()).toISOString(),
    confirmedBy: String(confirmedBy || 'creator'),
  };
  const next = { version: 1, levels: Object.assign({}, book.levels, { [lv]: entry }) };
  try {
    atomicWriteJson(file, next);
  } catch (e) {
    return { ok: false, error: '台账写盘失败：' + (e && e.message) };
  }
  return { ok: true, path: file, levelId: lv, role, value, replaced };
}

/**
 * 抹掉一个关卡的台账（或只抹一个角色）。**这是显式动作**，调用方要 `confirm:true`。
 * @param {{levelId?: any, role?: string, env?: NodeJS.ProcessEnv}} opts
 */
export function clearHandover({ levelId, role, env = process.env } = {}) {
  const lv = levelId === undefined || levelId === null ? '' : String(levelId).trim();
  if (!lv) return { ok: false, error: '没给关卡 ID —— 传 `level`，或在编辑器里打开目标地图。' };
  const file = ledgerPath(env);
  const book = readLedger(env);
  if (!book.levels[lv]) return { ok: true, path: file, levelId: lv, removed: [], note: '这个关卡在台账里本来就没有条目。' };
  const entry = Object.assign({}, book.levels[lv]);
  const removed = role ? (entry[role] ? [role] : []) : Object.keys(entry);
  if (role) delete entry[role];
  const levels = Object.assign({}, book.levels);
  if (!role || Object.keys(entry).length === 0) delete levels[lv];
  else levels[lv] = entry;
  try {
    atomicWriteJson(file, { version: 1, levels });
  } catch (e) {
    return { ok: false, error: '台账写盘失败：' + (e && e.message) };
  }
  return { ok: true, path: file, levelId: lv, removed };
}

/**
 * 把「用过台账」这件事做成一行的回执照会 —— 回执里必须能看出**哪个值、谁确认的、什么时候**。
 * @param {Array<{role: string, hit: any}>} hits
 */
export function ledgerNote(hits) {
  const rows = (hits || []).filter((h) => h && h.hit);
  if (!rows.length) return null;
  return rows.map((h) => ({
    role: h.role,
    label: ROLE_LABEL[h.role] || h.role,
    value: h.hit.value,
    confirmedAt: h.hit.confirmedAt,
    confirmedBy: h.hit.confirmedBy,
    from: 'ledger',
  }));
}
