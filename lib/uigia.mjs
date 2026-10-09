/**
 * uigia.mjs — 千星「**界面控件组导出文件**」（也叫 `.gia`）的读写与校验。纯 JS，零依赖，不写盘。
 *
 * ⚠️ **名字撞车警告**：本仓有两套完全不同的 `.gia`：
 * - `lib/gia.mjs`  = **客户端运行时日志**（脚本 `print` 的落盘，`miliastra_log` 读的那个）；
 * - `lib/uigia.mjs`（本文件）= **界面控件组导出**（编辑器里导出、可再导入的那种）。
 * 两者**同扩展名、不同格式**，别互相套用解析器。
 *
 * ## 格式（字段级结论都带证据等级）
 *
 * 逆向来源：真机导出的控件组 `.gia`；结论由本模块**独立复现**过（不依赖原作者那套 Python）。
 *
 * ```
 * [0..3]   uint32 BE = 文件总长 - 4        （observed：4 份文件全中）
 * [4..7]   uint32 BE = 1
 * [8..11]  uint32 BE = 806                  ← 常量（observed）
 * [12..15] uint32 BE = 3                    ← 常量（observed）
 * [16..19] uint32 BE = body 长度
 * [20..]   protobuf body
 * [末尾 4] 00 00 06 79                      ← 4 份**大小差异很大**的文件全同 ⇒ 判为常量（inferred）
 * ```
 *
 * body 顶层（observed）：`#1` = 根容器（`19.1.503` 是**子控件 ID 的 packed varint 列表**）·
 * `#2`×N = 每个子控件 · `#3` = 来源串 `"<账号>-<?>-<关卡ID>-\\<原名>"`（⚠️ 会泄露账号与关卡号）·
 * `#5` = 版本串（实测 `"7.1.0"`）。
 *
 * 控件内部（`19.1`，observed）：
 * - `501`          = 控件 ID
 * - `502[*].11.501` = **自身 ID 引用**（三元组里的那一份）
 * - `502[*].12.501` = **槽位号**：★ **同组内必须唯一** —— 重复 ⇒ 导入后**整组渲染失败**
 *   （真机 A/B：`out_grow5.gia` 里 `111` 重复 4 次 ⇒ 画布全空；改唯一后 `FIX_5图元.gia` 导入正常）
 * - `504`          = 父控件 ID（**容器没有**这一条）
 * - `505`          = 名字槽位 / 状态块组（位置/尺寸/颜色等值在里面）
 *
 * ⚠️ **未确证**：顶层 `#5` 的 `15/70` **不是控件类型码** —— 实测 885 个控件里 `15` 占 884
 * （含文本框/按钮/按键提示等），只有容器是 `70` ⇒ 语义应为「**非容器 / 容器**」。
 * **控件类型码的位置尚未定位**（工作区那份 `build_control_gia.py` 的两处注释互相矛盾）。
 * ⇒ 想生成「文本框」等**别的类型**之前，先必须把这一点定死。
 */

import { UigiaIssue } from './receipt.mjs';

/** 尾部 4 字节常量（多份不同大小的真机文件全同 ⇒ 判为常量，非校验和）。 */
export const UIGIA_TAIL = Buffer.from([0x00, 0x00, 0x06, 0x79]);
/** 头部第 3 个 u32 的常量值。 */
export const UIGIA_HEADER_MAGIC = 806;

/** @typedef {{ field: number, wire: number, value?: number, bytes?: Buffer }} UigiaField */
/** @typedef {{ level: 'error'|'warn', code: string, message: string }} UigiaIssue */
/** @typedef {{ kind: 'container'|'child', fields: UigiaField[], id: number|null, slot: number|null, parent: number|null, name: string|null }} UigiaControl */

/** 读一个 varint（返回数值与下一个下标）。ID 量级 ~1e9 ⇒ Number 安全。 */
export function readVarint(buf, i) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (i >= buf.length) throw new Error('varint 越界');
    const byte = buf[i];
    i += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 56) throw new Error('varint 太长');
  }
  return [result, i];
}

/** 把数值编成 varint。 */
export function encodeVarint(n) {
  const out = [];
  let v = n;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}

/** 扫一段 protobuf 字节成字段列表（length-delimited 只记 bytes，不猜是不是子消息）。 */
export function scanFields(buf) {
  /** @type {UigiaField[]} */
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      out.push({ field, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ field, wire, bytes: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, bytes: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      throw new Error(`不支持的 wire type ${wire}（下标 ${i}）`);
    }
  }
  return out;
}

/** 字段列表 → 字节（`scanFields` 的逆运算，用于**逐字节往返**）。 */
export function joinFields(fields) {
  const parts = [];
  for (const f of fields) {
    const key = encodeVarint(f.field * 8 + f.wire);
    if (f.wire === 0) parts.push(key, encodeVarint(f.value ?? 0));
    else if (f.wire === 2) {
      const b = f.bytes ?? Buffer.alloc(0);
      parts.push(key, encodeVarint(b.length), b);
    } else parts.push(key, f.bytes ?? Buffer.alloc(0));
  }
  return Buffer.concat(parts);
}

/** 从一个 length-delimited 字段里取子字段（不是合法子消息就返回 null）。 */
export function childrenOf(f) {
  if (!f || f.wire !== 2 || !f.bytes) return null;
  try {
    const kids = scanFields(f.bytes);
    return kids.length ? kids : null;
  } catch {
    return null;
  }
}

/** 取某字段的全部实例。 */
export const allOf = (fields, num) => fields.filter((f) => f.field === num);
/** 取某字段的第一个实例。 */
export const oneOf = (fields, num) => fields.find((f) => f.field === num) ?? null;

/** 解 packed varint 列表（容器 `19.1.503` = 子控件 ID 列表）。 */
export function decodePackedVarints(buf) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let v;
    [v, i] = readVarint(buf, i);
    out.push(v);
  }
  return out;
}

/** 读 `.gia`：拆出头部 / body 顶层字段 / 尾部。 */
export function readUigia(buf) {
  if (buf.length < 24) throw new Error('.gia 太短（至少 24 字节）');
  const header = [0, 1, 2, 3, 4].map((k) => buf.readUInt32BE(k * 4));
  const bodyLen = header[4];
  const body = buf.subarray(20, 20 + bodyLen);
  return { header, body, fields: scanFields(body), tail: buf.subarray(buf.length - 4), total: buf.length };
}

/** 写 `.gia`：重算长度字段 + 补尾部常量（与 `readUigia` 往返后**逐字节一致**）。 */
export function writeUigia(fields, tail = UIGIA_TAIL) {
  const body = joinFields(fields);
  const head = Buffer.alloc(20);
  head.writeUInt32BE(16 + body.length + tail.length, 0); // 总长 - 4
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(UIGIA_HEADER_MAGIC, 8);
  head.writeUInt32BE(3, 12);
  head.writeUInt32BE(body.length, 16);
  return Buffer.concat([head, body, tail]);
}

/** 从控件记录（顶层 `#1`/`#2`）里读出 id / 槽位号 / 父 / 名字。 */
export function parseControl(f, kind) {
  const rec = childrenOf(f) ?? [];
  const g19 = oneOf(rec, 19);
  const inner19 = childrenOf(g19);
  const g1 = inner19 ? oneOf(inner19, 1) : null;
  const inner = g1 ? childrenOf(g1) ?? [] : [];
  const id = oneOf(inner, 501);
  const parent = oneOf(inner, 504);
  let slot = null;
  for (const s of allOf(inner, 502)) {
    const kids = childrenOf(s);
    const twelve = kids ? oneOf(kids, 12) : null;
    const twelveKids = childrenOf(twelve);
    const v = twelveKids ? oneOf(twelveKids, 501) : null;
    if (v && typeof v.value === 'number') { slot = v.value; break; }
  }
  let name = null;
  for (const s of allOf(inner, 505)) {
    for (const k of childrenOf(s) ?? []) {
      const v = oneOf(childrenOf(k) ?? [], 501);
      const str = v && v.bytes ? v.bytes.toString('utf8') : '';
      if (str && /^[\x20-\uFFFF]{1,32}$/.test(str) && !/[\x00-\x1f]/.test(str)) { name = str; break; }
    }
    if (name) break;
  }
  const own3 = oneOf(rec, 3);
  if (!name && own3 && own3.bytes) name = own3.bytes.toString('utf8');
  return {
    kind,
    fields: rec,
    id: id && typeof id.value === 'number' ? id.value : null,
    slot,
    parent: parent && typeof parent.value === 'number' ? parent.value : null,
    name,
  };
}

/** 列出全部控件（容器 + 子控件），按顶层字段顺序。 */
export function listControls(fields) {
  /** @type {UigiaControl[]} */
  const out = [];
  for (const f of fields) {
    if (f.field !== 1 && f.field !== 2) continue;
    if (!childrenOf(f)) continue;
    const c = parseControl(f, f.field === 1 ? 'container' : 'child');
    if (c.id !== null) out.push(c);
  }
  return out;
}

/**
 * 校验一份控件组 `.gia` 是否自洽。**只报事实，不下"能导入"的判决。**
 * 判据来源：真机导入的 A/B（见文件头）。
 */
export function validateUigia(buf) {
  /** @type {UigiaIssue[]} */
  const issues = [];
  const gia = readUigia(buf);
  const [lenField, one, magic, three, bodyLen] = gia.header;
  if (lenField !== buf.length - 4) issues.push({ level: 'error', code: UigiaIssue.HEADER_LEN, message: `头部长度 ${lenField} ≠ 实际 ${buf.length - 4}` });
  if (one !== 1) issues.push({ level: 'warn', code: UigiaIssue.HEADER_ONE, message: `头部第 2 个 u32 = ${one}（实测样本恒为 1）` });
  if (magic !== UIGIA_HEADER_MAGIC) issues.push({ level: 'warn', code: UigiaIssue.HEADER_MAGIC, message: `头部常量 = ${magic}（实测样本恒为 ${UIGIA_HEADER_MAGIC}）` });
  if (three !== 3) issues.push({ level: 'warn', code: UigiaIssue.HEADER_THREE, message: `头部第 4 个 u32 = ${three}（实测样本恒为 3）` });
  if (20 + bodyLen + 4 !== buf.length) issues.push({ level: 'error', code: UigiaIssue.BODY_LEN, message: `body 长度 ${bodyLen} 与文件长 ${buf.length} 不匹配` });
  if (!gia.tail.equals(UIGIA_TAIL)) {
    issues.push({ level: 'warn', code: UigiaIssue.TAIL_UNKNOWN, message: `尾部 4 字节 ${gia.tail.toString('hex')} ≠ 实测常量 ${UIGIA_TAIL.toString('hex')}（该常量未确证，若导入异常优先怀疑它）` });
  }
  if (gia.fields.filter((f) => f.field === 1).length !== 1) {
    issues.push({ level: 'error', code: UigiaIssue.CONTAINER_COUNT, message: `容器 #1 应有 1 个，实测 ${gia.fields.filter((f) => f.field === 1).length}` });
  }
  const controls = listControls(gia.fields);
  const ids = controls.map((c) => c.id);
  const dupIds = ids.filter((x, i) => x !== null && ids.indexOf(x) !== i);
  if (dupIds.length) issues.push({ level: 'error', code: UigiaIssue.ID_DUPLICATED, message: `控件 ID 重复：${[...new Set(dupIds)].join(', ')}` });

  // ★ 这条是真机血泪：槽位号重复 ⇒ 导入后**整组渲染失败**（连不重复的一起陪葬）
  const slots = controls.map((c) => c.slot).filter((x) => x !== null);
  const dupSlots = slots.filter((x, i) => slots.indexOf(x) !== i);
  if (dupSlots.length) {
    issues.push({
      level: 'error',
      code: UigiaIssue.SLOT_DUPLICATED,
      message: `槽位号（19.1.502[*].12.501）重复 ${dupSlots.length} 处：${[...new Set(dupSlots)].join(', ')}`
        + ' —— 真机实测：同组内槽位号重复 ⇒ 导入后画布**整组空白**',
    });
  }
  const container = controls.find((c) => c.kind === 'container');
  if (container) {
    const badParent = controls.filter((c) => c.kind === 'child' && c.parent !== null && c.parent !== container.id);
    if (badParent.length) issues.push({ level: 'error', code: UigiaIssue.PARENT_MISMATCH, message: `${badParent.length} 个子控件的父引用 ≠ 容器 ID ${container.id}` });
    const g19 = oneOf(container.fields, 19);
    const inner19 = childrenOf(g19);
    const g1 = inner19 ? oneOf(inner19, 1) : null;
    const packed = g1 ? oneOf(childrenOf(g1) ?? [], 503) : null;
    if (packed && packed.bytes) {
      const listed = decodePackedVarints(packed.bytes);
      const childIds = controls.filter((c) => c.kind === 'child').map((c) => c.id);
      const missing = childIds.filter((x) => x !== null && !listed.includes(x));
      const extra = listed.filter((x) => !childIds.includes(x));
      if (missing.length || extra.length) {
        issues.push({ level: 'error', code: UigiaIssue.PACKED_MISMATCH, message: `容器 packed ID 列表与子控件不一致（缺 ${missing.length} / 多 ${extra.length}）` });
      }
    }
  }
  const source = oneOf(gia.fields, 3);
  if (source && source.bytes && /^\d{6,}-\d+-\d+-/.test(source.bytes.toString('utf8'))) {
    issues.push({ level: 'warn', code: UigiaIssue.SOURCE_LEAKS_IDS, message: `#3 来源串带账号/关卡号（${source.bytes.toString('utf8')}）—— 对外产物建议清洗` });
  }
  return {
    ok: !issues.some((i) => i.level === 'error'),
    counts: { controls: controls.length, slots: slots.length, uniqueSlots: new Set(slots).size },
    issues,
  };
}

/** 把控件里**指向自己的引用**换成新 ID（两种形态：裸 `19.1.501` + 三元组里的 `502[*].11.501`）。 */
export function retargetId(controlFields, oldId, newId) {
  const remap = (buf) => {
    let kids = null;
    try { kids = scanFields(buf); } catch { kids = null; }
    if (!kids) return buf;
    return joinFields(kids.map((f) => {
      if (f.wire === 0 && f.value === oldId) return { ...f, value: newId };
      if (f.wire === 2 && f.bytes) return { ...f, bytes: remap(f.bytes) };
      return f;
    }));
  };
  return controlFields.map((f) => {
    if (f.wire === 2 && f.bytes) return { ...f, bytes: remap(f.bytes) };
    return f;
  });
}
