/**
 * nodedb.mjs —— **官方节点词典**（只读、离线、不联网）。
 *
 * ★ 这是什么：参考项目 **Node Editor Pack**（MIT，`Copyright 2025-2026 Wu-Yijun`）的
 *   `utils/node_data/data.json`（4.1 MB / 558 节点 / 274 枚举）里**挑出插件要用的字段**压成
 *   `lib/nodedb.json`（约 205 KB），由 `tools/gen-nodedb.mjs` 生成，归属见仓库 `NOTICE`。
 *
 * ★ 它回答什么：**官方有哪些节点、名字（中/英）叫什么、标识是什么、服务端还是客户端、属于哪一类、有哪些端口**。
 *   —— 作者要的"经验/知识库，后续自己写节点图"用的就是这份。
 *
 * ⚠️ **它不回答什么（必须说清，别让人误会）**：**.gil 里的节点声明 id（关卡内分配的号，如 `1073741843`）
 *   与这份词典的 `id`（≤ 300004）不是一套** —— 已把上游的 `ID` / `__ref_id` / `Alias` / `Implementation`
 *   以及整份 JSON 搜过那些号，**一条都没命中**。所以要"地图里这个声明是什么节点"，**做不到**
 *   （回执里 \`unverified\` 常驻这句）。
 * ⚠️ 上游库是**逆向整理**的（`Schema: Skip`），其 `GameVersion` 与 7.1 是否逐条一致**未核**。
 */

import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DEFAULT_FILE = path.join(HERE, 'nodedb.json');

let CACHE = null;
let CACHE_FILE = null;

/** 载入词典（默认 `lib/nodedb.json`；结果缓存在内存里，重复调用不重复读盘）。 */
export function loadNodeDb(file) {
  const f = file || DEFAULT_FILE;
  if (CACHE && CACHE_FILE === f) return CACHE;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const nodes = (raw.nodes || []).map((n) => ({
    id: n.i,
    zh: n.z || '',
    en: n.e || '',
    identifier: n.k || '',
    ref: n.r || '',
    system: n.s === 'S' ? 'Server' : 'Client',
    domain: n.d || '',
    type: n.t || '',
    alias: n.a || [],
    pins: (n.p || []).map((p) => ({ dir: p[0] === 'i' ? 'in' : 'out', label: p[1] || '', type: p[2] || '', shell: p[3] === -1 ? null : p[3], flow: p[4] === 1 })),
  }));
  CACHE = { meta: raw._source || {}, unverified: raw.unverified || [], counts: raw.counts || {}, nodes };
  CACHE_FILE = f;
  return CACHE;
}

/** 词典元信息（来源 / 许可 / 版本 / 计数）—— 回执里要带，别让人不知道数据哪来的。 */
export function nodeDbMeta(file) {
  const db = loadNodeDb(file);
  return { ...db.meta, counts: db.counts, unverified: db.unverified };
}

const norm = (s) => String(s == null ? '' : s).toLowerCase();
const SEARCHABLE = (n) => [n.zh, n.en, n.identifier, n.ref, ...n.alias].map(norm);

/**
 * 按关键词搜节点（多词 = AND；中英与标识符都能搜）。
 * 排序：名字/标识**完全相等** > 名字**以关键词开头** > 名字命中 > 标识/别名命中。
 *
 * @param {{ q?: string, system?: string, domain?: string, id?: number|null, limit?: number, file?: string }} [opts]
 */
export function searchNodes({ q = '', system, domain, id, limit = 20, file } = {}) {
  const db = loadNodeDb(file);
  let rows = db.nodes;
  if (id != null) rows = rows.filter((n) => n.id === Number(id));
  if (system) rows = rows.filter((n) => n.system.toLowerCase() === String(system).toLowerCase());
  if (domain) rows = rows.filter((n) => n.domain.toLowerCase() === String(domain).toLowerCase());
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    rows = rows.filter((n) => { const hay = SEARCHABLE(n).join(' '); return words.every((w) => hay.includes(w)); });
    const qq = String(q).trim().toLowerCase();
    const rank = (n) => {
      const zh = norm(n.zh); const en = norm(n.en); const k = norm(n.identifier);
      if (zh === qq || en === qq || k === qq) return 0;
      if (zh.startsWith(qq) || en.startsWith(qq) || k.startsWith(qq)) return 1;
      if (zh.includes(qq) || en.includes(qq)) return 2;
      return 3;
    };
    rows = rows.slice().sort((a, b) => (rank(a) - rank(b)) || a.id - b.id);
  } else {
    rows = rows.slice().sort((a, b) => a.id - b.id);
  }
  const total = rows.length;
  const lim = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20;
  return { total, returned: Math.min(lim, total), rows: rows.slice(0, lim), meta: { ...db.meta, counts: db.counts }, unverified: db.unverified };
}

/** 按官方 id 取一条。 */
export function nodeById(id, file) {
  const db = loadNodeDb(file);
  return db.nodes.find((n) => n.id === Number(id)) || null;
}

/** 词典里出现的分类（Domain）与服务端/客户端计数 —— 供工具列清单用。 */
export function nodeDbFacets(file) {
  const db = loadNodeDb(file);
  const domains = {};
  for (const n of db.nodes) domains[n.domain || '(无)'] = (domains[n.domain || '(无)'] || 0) + 1;
  return { domains, server: db.counts.server, client: db.counts.client, total: db.nodes.length };
}
