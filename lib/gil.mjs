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
