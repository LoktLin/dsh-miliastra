/**
 * wire.mjs — 通用 protobuf 线格式解析（.gil 与 .gia 共用）
 *
 * 千星奇域的两个关键文件都是 protobuf：
 *   · `<关卡ID>.gil`  地图存档 = [20 字节包头] + [protobuf 主体] + [4 字节尾]
 *   · `*.gia`         运行时日志 = [8 字节包头] + [protobuf 主体]
 * 二者都不是纯 protobuf，所以需要「找一个能完整解析的起点」这一步。
 *
 * 校验策略（宁可判"不是消息"，也不瞎嵌套）：
 *   一个 length-delimited 字段的载荷，只有当它能被**完整**解析成合法 protobuf
 *   （每个字段严格消费完、无尾部残留、无非法 wire type）时，才当作子消息。
 */

const WIRE = new Set([0, 1, 2, 5]);
const WIRE_NAME = { 0: 'varint', 1: 'fixed64', 2: 'bytes', 5: 'fixed32' };

/** 读一个 varint；越界或超过 10 字节返回 null。 */
export function readVarint(buf, p, end) {
  let v = 0n;
  let n = 0;
  let x = 0;
  do {
    if (p + n >= end || n >= 10) return null;
    x = buf[p + n];
    v |= BigInt(x & 0x7f) << BigInt(7 * n);
    n += 1;
  } while (x & 0x80);
  return { v, n };
}

/**
 * 解析 [start, end) 为 protobuf 字段序列。
 * 成功返回字段数组（每项 { no, wt, value, sub? }），失败返回 null。
 * value: varint→BigInt，bytes/fixed→Buffer；sub: 能解析成子消息时的字段数组。
 */
export function parseMessage(buf, start, end, depth = 0, maxDepth = 10) {
  const fields = [];
  let p = start;
  while (p < end) {
    const key = readVarint(buf, p, end);
    if (!key || key.v === 0n) return null;
    p += key.n;
    const no = Number(key.v >> 3n);
    const wt = Number(key.v & 7n);
    if (no <= 0 || !WIRE.has(wt)) return null;
    let value;
    let sub = null;
    if (wt === 0) {
      const r = readVarint(buf, p, end);
      if (!r) return null;
      p += r.n;
      value = r.v;
    } else if (wt === 1) {
      if (p + 8 > end) return null;
      value = buf.subarray(p, p + 8);
      p += 8;
    } else if (wt === 5) {
      if (p + 4 > end) return null;
      value = buf.subarray(p, p + 4);
      p += 4;
    } else {
      const r = readVarint(buf, p, end);
      if (!r) return null;
      const len = Number(r.v);
      p += r.n;
      if (len < 0 || p + len > end) return null;
      value = buf.subarray(p, p + len);
      if (len > 0 && depth < maxDepth && len <= 1 << 21) {
        sub = parseMessage(buf, p, p + len, depth + 1, maxDepth);
      }
      p += len;
    }
    fields.push({ no, wt, value, sub });
  }
  return p === end ? fields : null;
}

const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

/**
 * 在文件里找到 protobuf 主体的 [start, end)。
 * 依次尝试：.gil 的 20 字节包头（偏移 16 处 BE32 = 主体长度）→ 8 字节包头到文件尾 →
 * 0 起点到文件尾 / 去掉 4~8 字节尾 → 最后在 0..64 里扫起点。
 * 返回 { start, end, fields }；都失败返回 null。
 */
export function findProtobufRoot(buf) {
  const cands = [];
  if (buf.length > 24) {
    const len = be32(buf, 16);
    if (len > 0 && 20 + len <= buf.length) cands.push([20, 20 + len]);
  }
  for (const s of [8, 0, 4, 12, 16]) {
    for (const tail of [0, 4, 8]) {
      if (buf.length - tail > s) cands.push([s, buf.length - tail]);
    }
  }
  const seen = new Set();
  let best = null;
  for (const [s, e] of cands) {
    const key = s + ':' + e;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = parseMessage(buf, s, e, 0);
    if (!f || f.length === 0) continue;
    // 完整的到文件尾 / 到声明长度的候选优先；同等条件下字段多的胜出
    if (!best || f.length > best.fields.length) best = { start: s, end: e, fields: f };
    if (e === buf.length && f.length > 1) break;
  }
  return best;
}

/** 取第一个匹配字段。 */
export function field(fields, no, wt) {
  if (!Array.isArray(fields)) return null;
  for (const f of fields) {
    if (f.no === no && (wt === undefined || f.wt === wt)) return f;
  }
  return null;
}

/** 取全部匹配字段。 */
export function fieldsAll(fields, no, wt) {
  if (!Array.isArray(fields)) return [];
  return fields.filter((f) => f.no === no && (wt === undefined || f.wt === wt));
}

/** varint 字段 → Number（超出安全范围返回 null）。 */
export function num(fields, no) {
  const f = field(fields, no, 0);
  if (!f) return null;
  const v = Number(f.value);
  return Number.isSafeInteger(v) ? v : null;
}

/** bytes 字段 → 字符串（非法 UTF-8 返回 null）。 */
export function str(fields, no) {
  const f = field(fields, no, 2);
  if (!f) return null;
  const s = Buffer.from(f.value).toString('utf8');
  return s.includes('\uFFFD') ? null : s;
}

/** bytes 字段 → 连续 varint 数组（例如「子节点索引列表」）。解析失败返回 null。 */
export function varintList(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let v = 0n;
    let n = 0;
    let x = 0;
    do {
      if (i + n >= bytes.length || n >= 10) return null;
      x = bytes[i + n];
      v |= BigInt(x & 0x7f) << BigInt(7 * n);
      n += 1;
    } while (x & 0x80);
    const asNum = Number(v);
    if (!Number.isSafeInteger(asNum)) return null;
    out.push(asNum);
    i += n;
  }
  return out;
}

export { WIRE_NAME };
