/**
 * gil.mjs — 千星奇域地图存档 `<关卡ID>.gil` 读取
 *
 * 文件结构：[20 字节包头] + [protobuf 主体] + [4 字节尾]
 *
 * 已实测的顶层字段：
 *   #1  varint  关卡 ID
 *   #2  str     关卡名（如 "ai测试_存档_1"）
 *   #39 varint  账号 ID
 *   #43 str     版本号（如 "7.1.0"）
 *   #50 msg     客户端脚本映射：
 *          #1 →#1 varint 脚本映射索引、#2 str 脚本名、#3 str 文件名、#5 bytes **脚本源码全文**
 *
 * 客户端控件记录（能读出「控件模板索引 / 名字 / 父 / 子」）：
 *   记录 message 内含
 *     #501 varint          控件模板索引（= 运行时 prefabIndex）
 *     #503 bytes           子节点索引列表（连续 varint）
 *     #504 varint          父节点索引
 *     #505 →#12 →#501 str  控件名字
 *
 * ⚠️ 关键经验：**能在 `#501` 里读到号 ≠ 能被脚本动态创建**。
 *    只有「存为模板」的独立控件（无 #504 父节点、且属于客户端控件模板区）才可创建。
 *    详见 docs 与 AGENTS.md §8。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findProtobufRoot, num, str, field, varintList } from './wire.mjs';

function utf8(bs) {
  const s = Buffer.from(bs).toString('utf8');
  return s.includes('\uFFFD') ? null : s;
}

/** 判断某个 message 是不是一条「客户端控件记录」。 */
function asControlRecord(fields) {
  const idF = field(fields, 501, 0);
  if (!idF) return null;
  let name = null;
  for (const m of fields) {
    if (m.no !== 505 || m.wt !== 2 || !m.sub) continue;
    for (const m12 of m.sub) {
      if (m12.no !== 12 || m12.wt !== 2 || !m12.sub) continue;
      const sF = field(m12.sub, 501, 2);
      if (!sF) continue;
      const s = utf8(sF.value);
      if (s && s.trim()) name = s.trim();
    }
  }
  if (!name) return null;
  const chF = field(fields, 503, 2);
  const parF = field(fields, 504, 0);
  let children = null;
  if (chF) {
    const list = varintList(chF.value);
    if (list && list.length) children = list;
  }
  return {
    id: Number(idF.value),
    name,
    parent: parF ? Number(parF.value) : null,
    children,
  };
}

/** 递归收集所有客户端控件记录（按文件顺序）。 */
function collectControls(fields, out, depth = 0) {
  if (depth > 14) return;
  for (const f of fields) {
    if (f.wt !== 2 || !f.sub) continue;
    const rec = asControlRecord(f.sub);
    if (rec) out.push(rec);
    collectControls(f.sub, out, depth + 1);
  }
}

/**
 * 在（可能嵌套的）消息里**递归找字符串**。
 *
 * 为什么需要：`#11` / `#7` 这些字段号是**逆向出来的**，形状不规整 ——
 * 「出生点」那条记录在 `#11.#3.#2` 里**本身就是记录**（含 #501 名字），
 * 而「预设点」在 `#11.#5.#1` 里又是**一层列表**。写死路径会两头都读空
 * （踩过：出生点/预设点都读成 0 个）。递归找 `#501` 就两种形状都能吃下。
 */
function deepStrAll(fields, no, depth = 0, out = []) {
  if (!fields || depth > 6) return out;
  for (const f of fields) {
    if (f.no === no && f.wt === 2) { const s = utf8(f.value); if (s && s.trim()) out.push(s.trim()); }
    if (f.wt === 2 && f.sub) deepStrAll(f.sub, no, depth + 1, out);
  }
  return out;
}

/** 取第一个（去重前） */
function deepStr(fields, no) {
  const all = deepStrAll(fields, no);
  return all.length ? all[0] : null;
}

/**
 * `.gil` 里的**客户端与资源版本**（顶层 `#29`）。
 *
 * 实测形态：`#29 = {#1:"CNRELWin7.1.0", #2:"48145775", #3:"48379043", #4:"48455349", #5:"48474090"}`
 * —— 第 1 个是客户端版本串，后面几个是资源版本号。
 * 用途：回答「这张图是在哪版客户端/资源下存的」——升级后行为变了时，这是第一个该看的东西。
 */
export function readVersionInfo(top) {
  const f = field(top, 29, 2);
  if (!f || !f.sub) return null;
  const parts = [];
  for (const g of f.sub) {
    if (g.wt === 2) { const s = utf8(g.value); if (s) parts.push(s.trim()); }
  }
  if (!parts.length) return null;
  return { client: parts[0], resources: parts.slice(1) };
}

/**
 * `.gil` 里的**玩法骨架**（顶层 `#11`）：阵营 / 出生点 / 预设点。
 *
 * 实测形态（2026-09-23 真实地图）：
 *   `#11.#2.#1 = {#1:名字, #2:序号, #3:UI 标记名}`   → 初始玩家阵营 / 初始物件阵营 / 初始造物阵营
 *   `#11.#3` 里含 `#501: "出生点1"`
 *   `#11.#5` 里含 `#501: "新建预设点"`
 * 字段号是**逆向出来的**（不是官方文档），所以只做「读出名字与条数」这种保守解读，不做语义推断。
 */
export function readLevelConfig(top) {
  const f = field(top, 11, 2);
  if (!f || !f.sub) return null;
  const factions = [];

  const f2 = field(f.sub, 2, 2);
  if (f2 && f2.sub) {
    for (const rec of f2.sub) {
      if (!rec.sub) continue;
      const name = str(rec.sub, 1);
      if (!name) continue;
      factions.push({ name, index: num(rec.sub, 2), uiMark: str(rec.sub, 3) });
    }
  }
  const uniq = (a) => [...new Set(a)];
  const spawnPoints = uniq(deepStrAll([field(f.sub, 3, 2)].filter(Boolean), 501));
  const presetPoints = uniq(deepStrAll([field(f.sub, 5, 2)].filter(Boolean), 501));

  if (!factions.length && !spawnPoints.length && !presetPoints.length) return null;
  return { factions, spawnPoints, presetPoints };
}

/**
 * `.gil` 里的**场景对象**（顶层 `#7`）：`#7.#1` 挂着 N 条 `{#1:id, #2:{#1:名字}, …}`。
 * 用途：摆件数量与清单（面板只显示条数 + 前几个名字，别把几百条铺出来）。
 */
export function readSceneObjects(top, limit = 12) {
  const f = field(top, 7, 2);
  if (!f || !f.sub) return null;
  const holder = field(f.sub, 1, 2);
  if (!holder || !holder.sub) return null;
  const total = holder.sub.length;
  const sample = [];
  for (const rec of holder.sub.slice(0, limit)) {
    if (!rec.sub) continue;
    // 名字藏在 `#2 → #1`（`#1` 在记录本层是 varint 的 id）
    const name = deepStr(rec.sub, 1);
    if (name) sample.push({ id: num(rec.sub, 1), name });
  }
  return { count: total, sample };
}

/* ------------------------------------------- 「地图快照」↔「本地活文件」能不能比 */

/**
 * 地图里那份脚本快照（`readGil(...).script` 的形状；`bytes`/`sha256` 是 `sourceBytes`/`sourceSha256` 的别名）。
 * @typedef {{name?:string|null, file?:string|null, sourceBytes?:number|null, bytes?:number|null,
 *            sourceSha256?:string|null, sha256?:string|null}} ScriptSnapshotSource
 */
/**
 * 本地活文件这边要比的信息。
 * @typedef {{name?:string|null, path?:string|null, size?:number|null, bytes?:number|null, sha256?:string|null}} ScriptSnapshotLive
 */
/** 取第一个是有限数字的值（没有就 null）。 */
function firstNumber(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * 两个脚本名是不是**同一个文件**：只比文件名（去掉目录）、忽略大小写，
 * 并且忽略 `.lua` 后缀 —— GIL 里 `name` 常常是不带后缀的映射名（实测 `name:"双相"` / `file:"双相.lua"`）。
 */
export function sameScriptName(a, b) {
  const norm = (x) => path.basename(String(x || '').trim()).replace(/\.lua$/i, '').toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  return !!na && na === nb;
}

/**
 * 「地图存档里嵌的脚本」↔「本地活文件」**能不能比、比出来是什么** —— **纯函数**（判据要能单测）。
 *
 * 为什么单独抽出来（2026-09-25 修的实测 bug）：原来直接拿 `gil.script.sourceSha256`
 * （**地图里嵌的那份快照**）与本次活文件比 —— 若两者本来就不是同一个脚本，
 * 得出的「地图里嵌的还是旧版 → 先别急着试玩」就是**反向假告警**。
 * 实测场景：同事的活文件目录里有 `game_01.lua`（真正挂载的）/ `测试.lua`（最旧）/
 * `背景图片.lua`（刚部署），部署的是 `背景图片.lua`，拿去比的却是 `测试.lua` 的快照。
 *
 * 判据（名字优先，哈希只在**同名**时才有意义）：
 *   · GIL 没给名字（老地图 / 字段缺失）→ 按**哈希**判（与既有行为一致，不假装）；
 *   · 名字一致（`file` 优先，缺了用 `name`）→ 按**哈希**判；
 *   · 名字不一致 → **不比**：如实说明「地图快照属于另一个脚本（X），本次比的是 Y」，
 *     并且**不给「先别急着试玩」这类行动建议**（那是拿两个不同脚本的哈希比出来的假结论）。
 *
 * @param {{embedded?: ScriptSnapshotSource|null, live?: ScriptSnapshotLive|null}} [input]
 *   `embedded` = `readGil(...).script`（`{name,file,sourceBytes,sourceSha256}`）
 *   `live` = 本次要比的活文件（`{name, path, sha256, size|bytes}`）
 * @returns {{comparable:boolean, match:boolean|null, skipped:string|null,
 *            embedded:ScriptSnapshotSource|null, live:ScriptSnapshotLive|null, conclusion:string}}
 */
export function compareScriptSnapshot({ embedded = null, live = null } = {}) {
  const emb = embedded ? {
    name: embedded.name || embedded.file || null,
    file: embedded.file || null,
    bytes: firstNumber(embedded.sourceBytes, embedded.bytes),
    sha256: embedded.sourceSha256 || embedded.sha256 || null,
  } : null;
  const lv = live ? {
    name: live.name || null,
    path: live.path || null,
    bytes: firstNumber(live.size, live.bytes),
    sha256: live.sha256 || null,
  } : null;

  if (!emb) {
    return {
      comparable: false, match: null, embedded: null, live: lv,
      skipped: '地图里没有脚本映射记录 —— 编辑器还没把脚本挂到这个关卡上（或没存盘）',
      conclusion: '地图里没有脚本映射记录。',
    };
  }
  if (!lv || !lv.sha256) {
    return {
      comparable: false, match: null, embedded: emb, live: lv,
      skipped: '这次没有可比的本地活文件（关卡下没扫到 .lua？）',
      conclusion: '没有可比的本地活文件。',
    };
  }
  const embeddedName = emb.file || emb.name;
  if (embeddedName && lv.name && !sameScriptName(embeddedName, lv.name)) {
    return {
      comparable: false, match: null, embedded: emb, live: lv,
      skipped: '地图快照属于另一个脚本（' + embeddedName + '），本次比的是 ' + lv.name
        + '；先确认哪个才是你正在改的',
      conclusion: '⚠️ **比不了**：地图里嵌的是另一个脚本（' + embeddedName + '），本次比的是 ' + lv.name
        + ' —— 两个哈希不同源，**不据此判「地图里嵌的还是旧版」**。'
        + '先确认哪个才是你正在改的（`miliastra_health` 会列出这个关卡下的全部活文件）。',
    };
  }
  const match = !!emb.sha256 && emb.sha256 === lv.sha256;
  return {
    comparable: true, match, skipped: null, embedded: emb, live: lv,
    conclusion: match
      ? '地图里嵌的脚本与本地活文件哈希一致 —— 但**地图可能是上次存盘时的快照**，改完活文件记得在编辑器里存盘才会同步。'
      : '地图里嵌的脚本与本地活文件**不一致**：要么刚改了活文件没存盘，要么编辑器里有未保存改动。',
  };
}

/** 解析 .gil → 结构化摘要。 */
export function readGil(file) {
  const buf = fs.readFileSync(file);
  const root = findProtobufRoot(buf);
  if (!root) return { ok: false, file, size: buf.length, error: '解析失败：找不到 protobuf 主体' };
  const top = root.fields;

  const levelId = num(top, 1);
  const levelName = str(top, 2);
  const account = num(top, 39);
  const version = str(top, 43);

  // 脚本映射
  let script = null;
  const s50 = field(top, 50, 2);
  if (s50 && s50.sub) {
    const inner = field(s50.sub, 1, 2);
    if (inner && inner.sub) {
      const srcF = field(inner.sub, 5, 2);
      const src = srcF ? srcF.value : null;
      script = {
        mappingId: num(inner.sub, 1),
        name: str(inner.sub, 2),
        file: str(inner.sub, 3),
        sourceBytes: src ? src.length : 0,
        sourceSha256: src ? crypto.createHash('sha256').update(src).digest('hex').toUpperCase() : null,
        source: src ? utf8(src) : null,
      };
    }
  }

  const clientUI = [];
  collectControls(top, clientUI);

  return {
    ok: true,
    file,
    size: buf.length,
    bodyStart: root.start,
    bodyEnd: root.end,
    level: { id: levelId, name: levelName },
    account,
    version,
    // 下面三项都是 2026-09-23 新加的「静态读」：不用试玩、不改任何文件
    versionInfo: readVersionInfo(top),
    levelConfig: readLevelConfig(top),
    sceneObjects: readSceneObjects(top),
    script,
    clientUI,
  };
}

/** 从文本里提取可读片段（带字节偏移），用于存盘前后 diff。 */
export function extractStrings(buf, minLen = 2) {
  const rows = [];
  let cur = '';
  let start = 0;
  const flush = () => { if (cur.length >= minLen) rows.push({ offset: start, text: cur }); cur = ''; };
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    let len = 0;
    if (c < 0x80) len = 1;
    else if ((c & 0xe0) === 0xc0) len = 2;
    else if ((c & 0xf0) === 0xe0) len = 3;
    else if ((c & 0xf8) === 0xf0) len = 4;
    if (!len) { flush(); i += 1; continue; }
    if (i + len > buf.length) { flush(); break; }
    const s = buf.subarray(i, i + len).toString('utf8');
    if (s.includes('\uFFFD') || (len === 1 && (c < 0x20 || c >= 0x7f))) { flush(); i += len; continue; }
    if (cur === '') start = i;
    cur += s;
    i += len;
  }
  flush();
  return rows
    .map((r) => ({ offset: r.offset, text: r.text.replace(/[\u0000-\u001f]+/g, ' ').trim() }))
    .filter((r) => r.text.length >= minLen && (/[\u4e00-\u9fff]/.test(r.text) || /[A-Za-z]{3}/.test(r.text)));
}

/** 客户端控件的可读清单（人看的表）。 */
export function renderClientUI(gil) {
  if (!gil.ok) return '(解析失败)';
  const lines = [];
  lines.push(`关卡 ${gil.level.id}  ${gil.level.name || ''}   版本 ${gil.version || '?'}   账号 ${gil.account || '?'}`);
  if (gil.script) {
    lines.push(`脚本：${gil.script.name}  (${gil.script.file})  映射索引=${gil.script.mappingId}  源码 ${gil.script.sourceBytes} 字节  sha256=${(gil.script.sourceSha256 || '').slice(0, 16)}…`);
  } else {
    lines.push('脚本：（地图里没有脚本映射记录）');
  }
  lines.push('');
  if (!gil.clientUI.length) {
    lines.push('客户端控件：（没有任何记录）');
    return lines.join('\n');
  }
  const byId = new Map(gil.clientUI.map((r) => [r.id, r]));
  lines.push(`客户端控件记录 ${gil.clientUI.length} 条：`);
  for (const r of gil.clientUI) {
    const kids = r.children && r.children.length
      ? '  子=[' + r.children.map((c) => `${c}${byId.has(c) ? ':' + byId.get(c).name : ''}`).join(', ') + ']'
      : '';
    const par = r.parent == null
      ? '  ★无父节点（候选：存为模板的独立控件）'
      : `  父=${r.parent}${byId.has(r.parent) ? ':' + byId.get(r.parent).name : ''}`;
    lines.push(`  ${r.id}  ${r.name}${par}${kids}`);
  }
  return lines.join('\n');
}
