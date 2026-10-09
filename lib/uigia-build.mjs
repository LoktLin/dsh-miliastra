/**
 * uigia-build.mjs — 生成**可导入的界面控件组 `.gia`**（单页）。
 *
 * ## 做法（照搬工作区那套 Python 工具已验证的思路）
 *
 * **拿一份"画布上真的显示得出来"的真机导出当骨架，逐字节沿用它的控件结构，只替换
 * 名字 / 位置 / 尺寸 / 颜色 / 素材号**；图元比骨架控件多时，复制模板控件、发新 ID、
 * 同步容器两处引用表（子引用 + packed ID）。**结构一个字节都不动** —— 这是导入成功率最高的做法。
 *
 * ## 为什么"槽位号"是全篇最关键的一行
 *
 * `19.1.502(含 12 的那个).12.501` = 控件**在控件组里的唯一槽位号**。实测真机 A/B：
 * 复制出来的控件沿用母本号 ⇒ 导入器把它们判成**同一原型** ⇒ 同一容器内 type 重复 ⇒
 * **整组渲染失败（画布全空，连母本一起陪葬）**。
 * ⇒ 生成时必须给每个控件发**自己的号**（容器固定，子控件从某个基址递增）。
 *
 * ## 证据等级
 *
 * - 骨架沿用 / 数值替换 / 槽位号：**observed**（真机导入确认 + 本仓 `uigia-test` 逐字节回归）
 * - 尾部 4 字节常量：**inferred**（多份不同大小文件全同）
 * - 控件「类型码」位置：**unknown** —— 本模块**只支持骨架里已有的控件类型**；
 *   要生成文本框等别的类型，必须先定死类型码（别猜）。
 */

import { scanFields, joinFields, childrenOf, encodeVarint, decodePackedVarints } from './uigia.mjs';

/** 字段数值改一个（varint 形态）。 */
const withValue = (f, value) => ({ ...f, value });
/** 字段内容换掉（length-delimited 形态）。 */
const withBytes = (f, bytes) => ({ ...f, bytes });

/** `(x,y)` → `{501: fixed32 LE, 502: fixed32 LE}`。 */
export function vec2(x, y) {
  const a = Buffer.alloc(4);
  const b = Buffer.alloc(4);
  a.writeFloatLE(x, 0);
  b.writeFloatLE(y, 0);
  return Buffer.concat([
    encodeVarint(501 * 8 + 5), a,
    encodeVarint(502 * 8 + 5), b,
  ]);
}

/** 若字段是 12 字节的 `{501:f32, 502:f32}` 就返回 `[x, y]`，否则 null。 */
export function asVec2(f) {
  if (!f || f.wire !== 2 || !f.bytes || f.bytes.length !== 12) return null;
  let kids;
  try { kids = scanFields(f.bytes); } catch { return null; }
  if (kids.length !== 2 || kids[0].field !== 501 || kids[1].field !== 502) return null;
  if (kids.some((k) => k.wire !== 5 || !k.bytes || k.bytes.length !== 4)) return null;
  return [kids[0].bytes.readFloatLE(0), kids[1].bytes.readFloatLE(0)];
}

/** 状态块 = 同时含 502/503/504/505/506 的消息（504=位置、505=尺寸）。 */
export function isStateBlock(buf) {
  let kids;
  try { kids = scanFields(buf); } catch { return false; }
  const nums = new Set(kids.map((k) => k.field));
  return [502, 503, 504, 505, 506].every((n) => nums.has(n));
}

/** `505` 里以 `12.501` 存字符串的那个 = 控件名字槽位；返回里面的名字。 */
export function nameSlot(f) {
  if (!f || f.field !== 505 || f.wire !== 2 || !f.bytes) return null;
  let kids;
  try { kids = scanFields(f.bytes); } catch { return null; }
  for (const k of kids) {
    if (k.field === 12 && k.wire === 2 && k.bytes) {
      let sub;
      try { sub = scanFields(k.bytes); } catch { continue; }
      for (const g of sub) if (g.field === 501 && g.wire === 2 && g.bytes) return g.bytes;
    }
  }
  return null;
}

/**
 * 递归改写一个控件：位置 / 尺寸（状态块里的 504/505）+ 名字 + 颜色·素材（`84` 槽位）。
 * @param {Buffer} ctrl 控件记录（顶层 `#1`/`#2` 的 payload）
 * @param {{ ax: number, ay: number, w: number, h: number, name?: string, color?: number, asset?: number }} opt
 */
export function patchControl(ctrl, { ax, ay, w, h, name, color, asset }) {
  const walk = (buf) => {
    let fs;
    try { fs = scanFields(buf); } catch { return buf; }
    if (isStateBlock(buf)) {
      return joinFields(fs.map((f) => {
        if (f.field === 504 && asVec2(f)) return withBytes(f, vec2(ax, ay));
        if (f.field === 505 && asVec2(f)) return withBytes(f, vec2(w, h));
        return f;
      }));
    }
    const out = [];
    for (const f of fs) {
      // 染色 / 素材槽位：84 = {502: 0xAARRGGBB, 503: 素材号}
      if (f.field === 84 && f.wire === 2 && f.bytes && f.bytes.length === 12) {
        const inner = scanFields(f.bytes);
        if (inner.some((x) => x.field === 502)) {
          const next = inner.map((x) => {
            if (x.field === 502 && color !== undefined) return withValue(x, color);
            if (x.field === 503 && asset !== undefined) return withValue(x, asset);
            return x;
          });
          if (asset !== undefined && !inner.some((x) => x.field === 503)) {
            const at = next.findIndex((x) => x.field === 502);
            next.splice(at + 1, 0, { field: 503, wire: 0, value: asset });
          }
          out.push(withBytes(f, joinFields(next)));
          continue;
        }
      }
      // 名字槽位
      const nameField = name !== undefined ? nameSlot(f) : null;
      if (nameField) {
        const inner = scanFields(f.bytes);
        out.push(withBytes(f, joinFields(inner.map((x) => {
          if (x.field === 12 && x.wire === 2 && x.bytes) {
            const sub = scanFields(x.bytes);
            return withBytes(x, joinFields(sub.map((g) => (
              g.field === 501 && g.wire === 2 ? withBytes(g, Buffer.from(name, 'utf8')) : g
            ))));
          }
          return x;
        }))));
        continue;
      }
      // 继续下潜
      if (f.wire === 2 && f.bytes && f.bytes.length > 0) out.push(withBytes(f, walk(f.bytes)));
      else out.push(f);
    }
    return joinFields(out);
  };
  return walk(ctrl);
}

/** 写槽位号：`502(含 12).12.501` = 该控件在组内的唯一槽位号。 */
export function setSlotCode(ctrl, code) {
  let fs;
  try { fs = scanFields(ctrl); } catch { return ctrl; }
  const out = [];
  for (const f of fs) {
    if (f.field === 502 && f.wire === 2 && f.bytes) {
      const inner = scanFields(f.bytes);
      if (inner.some((g) => g.field === 12 && g.wire === 2)) {
        out.push(withBytes(f, joinFields(inner.map((g) => {
          if (g.field === 12 && g.wire === 2 && g.bytes) {
            const sub = scanFields(g.bytes);
            return withBytes(g, joinFields(sub.map((hhh) => (
              hhh.field === 501 && hhh.wire === 0 ? withValue(hhh, code) : hhh
            ))));
          }
          return g;
        }))));
        continue;
      }
    }
    if (f.wire === 2 && f.bytes && f.bytes.length > 0) out.push(withBytes(f, setSlotCode(f.bytes, code)));
    else out.push(f);
  }
  return joinFields(out);
}

/** 读回槽位号（自检用）。 */
export function getSlotCode(ctrl) {
  let fs;
  try { fs = scanFields(ctrl); } catch { return null; }
  for (const f of fs) {
    if (f.field === 502 && f.wire === 2 && f.bytes) {
      const inner = scanFields(f.bytes);
      if (inner.some((g) => g.field === 12 && g.wire === 2)) {
        for (const g of inner) {
          if (g.field === 12 && g.wire === 2 && g.bytes) {
            for (const hh of scanFields(g.bytes)) if (hh.field === 501 && hh.wire === 0) return hh.value;
          }
        }
      }
    }
    if (f.wire === 2 && f.bytes && f.bytes.length > 0) {
      const r = getSlotCode(f.bytes);
      if (r !== null) return r;
    }
  }
  return null;
}

/** 控件 ID 存在记录顶层 `#1.4`（另有一份自引用在 `19.1.501`）。 */
export function ctrlId(ctrl) {
  for (const f of scanFields(ctrl)) {
    if (f.field === 1 && f.wire === 2 && f.bytes) {
      for (const g of scanFields(f.bytes)) if (g.field === 4 && g.wire === 0) return g.value;
    }
  }
  throw new Error('这个控件里找不到 ID（#1.4）');
}

/** 控件引用三元组：`{2:1, 3:8, 4:<ID>}`。 */
export function refTriple(cid) {
  return joinFields([
    { field: 2, wire: 0, value: 1 },
    { field: 3, wire: 0, value: 8 },
    { field: 4, wire: 0, value: cid },
  ]);
}

/**
 * 把控件内**所有指向自己的引用**换新 ID。两种形态：裸 varint + 三元组 `{2:1,3:8,4:ID}`。
 * 父引用（`19.1.504` = 容器 ID）不等于 old，不会被误伤。
 */
export function retargetId(buf, oldId, newId) {
  let fs;
  try { fs = scanFields(buf); } catch { return buf; }
  const isTriple = fs.length === 3 && fs.every((f) => f.wire === 0) && new Set(fs.map((f) => f.field)).size === 3
    && [2, 3, 4].every((n) => fs.some((f) => f.field === n));
  if (isTriple) {
    if (!fs.some((f) => f.field === 4 && f.value === oldId)) return buf;
    return joinFields(fs.map((f) => (f.field === 4 ? withValue(f, newId) : f)));
  }
  return joinFields(fs.map((f) => {
    if (f.wire === 0 && f.value === oldId) return withValue(f, newId);
    if (f.wire === 2 && f.bytes && f.bytes.length > 0) return withBytes(f, retargetId(f.bytes, oldId, newId));
    return f;
  }));
}

/** 在容器**子引用表末尾**追加引用（插在名字 `#3` 之前）。 */
export function addChildRefs(container, newIds) {
  const fs = scanFields(container);
  const idxs = fs.map((f, i) => (f.field === 2 && f.wire === 2 ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) throw new Error('容器里没有子控件引用表');
  const pos = idxs[idxs.length - 1] + 1;
  const added = newIds.map((nid) => {
    const v = refTriple(nid);
    return { field: 2, wire: 2, bytes: v };
  });
  return joinFields([...fs.slice(0, pos), ...added, ...fs.slice(pos)]);
}

/** 容器 `19.1.503` = 子控件 ID 的 packed varint 列表，追加新 ID。 */
export function appendPackedIds(container, newIds) {
  const tail = Buffer.concat(newIds.map((i) => encodeVarint(i)));
  return joinFields(scanFields(container).map((f) => {
    if (f.field !== 19 || f.wire !== 2 || !f.bytes) return f;
    const inner = scanFields(f.bytes).map((x) => {
      if (x.field !== 1 || x.wire !== 2 || !x.bytes) return x;
      const y2 = scanFields(x.bytes).map((d) => (
        d.field === 503 && d.wire === 2 && d.bytes ? withBytes(d, Buffer.concat([d.bytes, tail])) : d
      ));
      return withBytes(x, joinFields(y2));
    });
    return withBytes(f, joinFields(inner));
  }));
}

/**
 * 解析绘图编辑器导出的 Lua：`ROOT` / `ELEMENTS`（+ 可选的 base64 场景，用来取名字与透明度）。
 * @param {string} text
 */
export function readElementLua(text) {
  const rootM = /local\s+ROOT\s*=\s*\{([^}]*)\}/.exec(text);
  const elemsM = /local\s+ELEMENTS\s*=\s*\{(.*?)\n\}/s.exec(text);
  if (!rootM || !elemsM) throw new Error('Lua 里找不到 ROOT / ELEMENTS');
  const nums = (s) => (s.match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  const items = [];
  for (const raw of elemsM[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    const vals = nums(line);
    if (vals.length >= 18) items.push(vals);
  }
  let scene = null;
  const sceneM = /MILIASTRA_EDITOR_SCENE_V1\s+([A-Za-z0-9+/=]+)/.exec(text);
  if (sceneM) {
    try { scene = JSON.parse(Buffer.from(sceneM[1], 'base64').toString('utf8')); } catch { scene = null; }
  }
  return { root: nums(rootM[1]), items, scene };
}

/**
 * 生成可导入的控件组 `.gia`（**单页**）。
 *
 * @param {{ refBuf: Buffer, root: number[], items: number[][], scene?: any, slotBase?: number, slotContainer?: number }} opt
 * @returns {{ buffer: Buffer, report: Record<string, any> }}
 */
export function buildUigia({ refBuf, root, items, scene = null, slotBase = 111, slotContainer = 110 }) {
  const bodyLen = refBuf.readUInt32BE(16);
  const top = scanFields(refBuf.subarray(20, 20 + bodyLen));
  const container = top.find((f) => f.field === 1 && f.wire === 2);
  const images = top.filter((f) => f.field === 2 && f.wire === 2);
  if (!container || !images.length) throw new Error('骨架里没有 容器(field1) / 图片(field2)');

  const names = [];
  const opacities = [];
  if (scene && scene.scene && Array.isArray(scene.scene.elements)) {
    for (const el of scene.scene.elements) {
      names.push(el.name || '图元');
      opacities.push(typeof el.opacity === 'number' ? el.opacity : 1);
    }
  }

  const extraIds = [];
  if (images.length < items.length) {
    const existing = [ctrlId(container.bytes), ...images.map((f) => ctrlId(f.bytes))];
    let nxt = Math.max(...existing) + 1;
    const tpl = images[0];
    const tplId = ctrlId(tpl.bytes);
    for (let k = images.length; k < items.length; k += 1) {
      extraIds.push(nxt);
      const c = retargetId(tpl.bytes, tplId, nxt);
      images.push({ field: 2, wire: 2, bytes: c });
      nxt += 1;
    }
  }

  let c0 = patchControl(container.bytes, { ax: root[0], ay: root[1], w: root[2], h: root[3] });
  if (extraIds.length) {
    c0 = appendPackedIds(c0, extraIds);
    c0 = addChildRefs(c0, extraIds);
  }
  const newContainer = withBytes(container, c0);

  const newImages = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const asset = Math.trunc(item[0]);
    const [x, y, w, h] = [item[1], item[2], item[3], item[4]];
    let [r, g, b, a] = [item[14], item[15], item[16], item[17]].map(Math.trunc);
    if (scene && a === 255 && i < opacities.length && opacities[i] !== 1) a = Math.round(255 * opacities[i]);
    // ⚠️ 必须 `>>> 0`：JS 的位运算是有符号 32 位，`255 << 24` 会变成负数，
    //    直接拿去编 varint 会编出垃圾（真踩过：0xFFFFFFFF 变成了 515199）。
    const argb = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    const nm = i < names.length ? names[i] : `图元${i + 1}`;
    let c = patchControl(images[i].bytes, { ax: x, ay: y, w, h, name: nm, color: argb, asset });
    c = setSlotCode(c, slotBase + i);
    const fs = scanFields(c);
    c = joinFields(fs.map((f) => (f.field === 3 && f.wire === 2 ? withBytes(f, Buffer.from(nm, 'utf8')) : f)));
    newImages.push(withBytes(images[i], c));
  }

  // 顶层重排：容器 → 全部图片（扩容出来的紧跟最后一个原图片之后）→ 其余字段
  const lastImg = top.map((f, i) => (f.field === 2 && f.wire === 2 ? i : -1)).filter((i) => i >= 0).pop();
  const parts = [];
  let imgI = 0;
  for (let idx = 0; idx < top.length; idx += 1) {
    const f = top[idx];
    if (f === container) parts.push(newContainer);
    else if (f.field === 2 && f.wire === 2) { parts.push(newImages[imgI]); imgI += 1; }
    else parts.push(f);
    if (idx === lastImg) while (imgI < newImages.length) { parts.push(newImages[imgI]); imgI += 1; }
  }
  const body = joinFields(parts);
  const head = Buffer.alloc(20);
  const tail = refBuf.subarray(refBuf.length - 4);
  head.writeUInt32BE(16 + body.length + tail.length, 0);
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(806, 8);
  head.writeUInt32BE(3, 12);
  head.writeUInt32BE(body.length, 16);
  const buffer = Buffer.concat([head, body, tail]);

  // ---- 自检：把产物读回来逐项核对（与 Python 版口径一致）
  const ctl2 = scanFields(buffer.subarray(20, 20 + body.length)).filter((f) => f.field === 2 && f.wire === 2);
  const contId = ctrlId(c0);
  const rows = ctl2.map((c) => {
    const s = scanFields(c.bytes);
    const nm = s.find((x) => x.field === 3 && x.wire === 2);
    let cid = null;
    const f1 = s.find((x) => x.field === 1 && x.wire === 2);
    if (f1) {
      const g4 = scanFields(f1.bytes).find((x) => x.field === 4);
      cid = g4 ? g4.value : null;
    }
    let parent = null;
    const f19 = s.find((x) => x.field === 19 && x.wire === 2);
    if (f19) {
      const x1 = scanFields(f19.bytes).find((x) => x.field === 1 && x.wire === 2);
      if (x1) {
        const d504 = scanFields(x1.bytes).find((d) => d.field === 504 && d.wire === 0);
        if (d504) parent = d504.value;
      }
    }
    return { id: cid, name: nm ? nm.bytes.toString('utf8') : null, parent, slot: getSlotCode(c.bytes) };
  });
  const ids = rows.map((r) => r.id);
  const slots = rows.map((r) => r.slot);
  const dupIds = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))].sort();
  const dupSlots = [...new Set(slots.filter((x) => x !== null && slots.indexOf(x) !== slots.lastIndexOf(x)))].sort();
  const contSlot = getSlotCode(c0);
  const packed = (() => {
    const f19 = scanFields(c0).find((x) => x.field === 19 && x.wire === 2);
    if (!f19) return [];
    const x1 = scanFields(f19.bytes).find((x) => x.field === 1 && x.wire === 2);
    if (!x1) return [];
    const d503 = scanFields(x1.bytes).find((d) => d.field === 503 && d.wire === 2);
    return d503 ? decodePackedVarints(d503.bytes) : [];
  })();

  return {
    buffer,
    report: {
      bytes: buffer.length,
      expected: items.length,
      written: rows.length,
      grown: extraIds.length,
      containerId: contId,
      containerSlot: contSlot,
      duplicateIds: dupIds,
      duplicateSlots: dupSlots,
      slotAllUnique: !dupSlots.length && !slots.includes(contSlot),
      parentOk: rows.every((r) => r.parent === contId),
      packedOk: [...packed].sort((a, b) => a - b).join(',') === [...ids].sort((a, b) => a - b).join(','),
      packedIds: packed,
      controls: rows,
      root: { pos: [root[0], root[1]], size: [root[2], root[3]] },
    },
  };
}
