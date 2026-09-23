/**
 * gia.mjs — 原神千星奇域「客户端运行时日志」(.gia) 读取
 *
 * 实测结构（2026-09-23，正式服 7.1）：
 *   文件 = [8 字节包头] + [protobuf 主体]
 *   每条日志 = 顶层字段 #1（message）：
 *     #1 varint  进程/会话序号（如 149）
 *     #2 str     实例 ID（形如 "<进程>-<账号ID>-<时间戳>-<序号>"）
 *     #3 varint  固定 1
 *     #4 str     时间 "2026/09/23_17:01:26"
 *     #5 varint  账号 ID
 *     #6 str     玩家名
 *     #11 msg → #2 str  关卡/模式名
 *     #23 msg → #2 str  正文（就是 Lua 里 print 出来的那一行）
 *
 * 只要脚本里 print，就能在这里被结构化读出来 —— 这是「运行时取证」的唯一入口。
 */

import fs from 'node:fs';
import { findProtobufRoot, num, str, field } from './wire.mjs';

/** 解析一个 .gia 文件 → { ok, file, size, header, records[] } */
export function readGia(file) {
  const buf = fs.readFileSync(file);
  const root = findProtobufRoot(buf);
  if (!root) {
    return { ok: false, file, size: buf.length, error: '解析失败：文件头不是可识别的 protobuf 形态' };
  }
  const records = [];
  for (const f of root.fields) {
    if (f.no !== 1 || f.wt !== 2 || !f.sub) continue;
    const rec = f.sub;
    const ch = field(rec, 11, 2);
    const body = field(rec, 23, 2);
    records.push({
      index: records.length,
      seq: num(rec, 1),
      instance: str(rec, 2),
      level2: num(rec, 3),
      time: str(rec, 4),
      account: num(rec, 5),
      player: str(rec, 6),
      channel: ch && ch.sub ? str(ch.sub, 2) : null,
      message: body && body.sub ? str(body.sub, 2) : null,
      // 正文之外可能还有别的叶子字段，保留原始编号以便排障
      bodyFields: body && body.sub ? body.sub.map((x) => ({ no: x.no, wt: x.wt })) : null,
    });
  }
  return {
    ok: true,
    file,
    size: buf.length,
    headerBytes: root.start,
    recordCount: records.length,
    records,
  };
}

/** 列出日志文件（按写入时间倒序）。 */
export function listGia(dir, limit = 40) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.gia'))
    .map((n) => {
      const full = dir + '\\' + n;
      let st = null;
      try { st = fs.statSync(full); } catch { /* ignore */ }
      return st ? { name: n, path: full, size: st.size, mtime: st.mtime.toISOString() } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    .slice(0, limit);
}

/** 按正则过滤记录；tag 会按「正文包含该子串」处理。 */
export function filterRecords(records, { tag, pattern, onlyWithMessage = true, limit = 200, fromEnd = true } = {}) {
  let re = null;
  if (pattern) {
    try { re = new RegExp(pattern); } catch (e) { return { error: '正则非法：' + e.message, records: [] }; }
  }
  let out = records.filter((r) => {
    if (onlyWithMessage && !r.message) return false;
    if (tag && !(r.message && r.message.includes(tag))) return false;
    if (re && !(r.message && re.test(r.message))) return false;
    return true;
  });
  if (fromEnd && out.length > limit) out = out.slice(out.length - limit);
  else if (out.length > limit) out = out.slice(0, limit);
  return { records: out };
}
