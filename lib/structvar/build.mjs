// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/StructViewer/StructViewer.vue
//   （`downloadJson()` 导出的就是这份 JSON）与
//   src/views/StructViewer/types/WorkspaceManifest.ts（`BaseStruct` / `BaseStructValue` 的形状）、
//   src/views/StructViewer/components/ParamNodeRender.vue（`GetParamDefaultValue` 与各型的值形状）。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// 产出**两种**形态，都能直接交给千星编辑器：
//   ① `definition`（结构体定义）：`{type:'Struct', <spelling>:'basic', name, value:[{key,param_type,value:ParamNode}]}`
//      —— 与同仓库 25 份真实样例逐字段同形；
//   ② `value`（结构体变量值）：`{structId, type:'Struct', value:[ParamNode…]}`（**位置参数、无 key**）
//      —— 与样例里嵌套结构体的值、以及 PixelArt 导出的结构体变量同形。

import {
  TYPE_KIND, paramNode, defaultNodeValue, TEXT_LIMIT,
} from './model.mjs';
import {
  assertParamType, assertStructId, normalizeSpelling, checkTextLimit, collectTexts,
} from './validate.mjs';

/** 整数（含 Guid/配置ID/元件ID/阵营/实体那一族）→ 十进制字符串。 */
export function fmtInt(v, path = 'value') {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${path} 要整数（或整数字符串），收到 ${JSON.stringify(v)}`);
  }
  return String(n);
}

/** 浮点 → **两位小数**字符串（真实样例里 Float 全是 `"2.00"` / `"-1.00"`）。 */
export function fmtFloat(v, path = 'value') {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${path} 要数字，收到 ${JSON.stringify(v)}`);
  return n.toFixed(2);
}

/** 布尔 → `"True"` / `"False"`（样例与源码的下拉框都是这两个字面量）。 */
export function fmtBool(v, path = 'value') {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1') return 'True';
  if (s === 'false' || s === '0') return 'False';
  if (s === '') return 'False';
  throw new Error(`${path} 要布尔（true/false/'True'/'False'/'1'/'0'），收到 ${JSON.stringify(v)}`);
}

/** 向量分量：整数就写整数，否则最多 3 位小数（样例里只见过 `0,0,0`）。 */
export function fmtComponent(v, path = 'value') {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${path} 的分量要数字，收到 ${JSON.stringify(v)}`);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** 三维向量 → `"x,y,z"`（接受 `[x,y,z]` / `{x,y,z}` / `"x,y,z"`）。 */
export function fmtVector(v, path = 'value') {
  let parts;
  if (Array.isArray(v)) parts = v;
  else if (v && typeof v === 'object') parts = [v.x, v.y, v.z];
  else if (typeof v === 'string') parts = v.split(',').map((s) => s.trim());
  else throw new Error(`${path} 要三维向量（[x,y,z] / {x,y,z} / "x,y,z"），收到 ${JSON.stringify(v)}`);
  if (parts.length !== 3) throw new Error(`${path} 要 3 个分量，收到 ${parts.length} 个：${JSON.stringify(v)}`);
  return parts.map((p, i) => fmtComponent(p, `${path}[${i}]`)).join(',');
}

function toArray(v, path) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  throw new Error(`${path} 要数组，收到 ${JSON.stringify(v)}`);
}

function coerceText(v, path, ctx) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  ctx.coerced.push({ path, from: typeof v, to: 'string', value: String(v).slice(0, 24) });
  return String(v);
}

/** `Struct` / `StructList` 的子节点：给 `value:[ParamNode…]`（位置参数）或 `fields:[{key,…}]`（便利写法）。 */
function structChildren(spec, path, ctx) {
  if (Array.isArray(spec)) return spec.map((n, i) => toParamNode(n, `${path}[${i}]`, ctx));
  if (spec && Array.isArray(spec.value)) return spec.value.map((n, i) => toParamNode(n, `${path}.value[${i}]`, ctx));
  if (spec && Array.isArray(spec.fields)) return spec.fields.map((f, i) => toParamNode(f, `${path}.fields[${i}]`, ctx));
  throw new Error(`${path} 是 Struct/StructList，要给 value:[{param_type,value},…]（位置参数）或 fields:[{key,param_type,value},…]；`
    + `收到 ${JSON.stringify(spec && spec.value)}`);
}

/**
 * 一个「字段规格」→ 一条 `ParamNode`（递归）。
 * 规格形状：`{param_type, value?, structId?, key_type?, value_type?, value_structId?, fields?}`
 * （`param_type` 也接受 `type` —— 从千星样例里复制过来的对象用的是 `type`）。
 * @param {Record<string, any>} spec
 * @param {string} path
 * @param {{coerced: any[], structIds: string[]}} ctx
 * @returns {{param_type: string, value: any}}
 */
export function toParamNode(spec, path, ctx) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是对象 {param_type, value?}，收到 ${JSON.stringify(spec)}`);
  }
  const raw = spec.param_type != null ? spec.param_type : spec.type;
  const type = assertParamType(raw, `${path}.param_type`);
  const kind = TYPE_KIND[type];
  const v = spec.value;
  switch (kind) {
    case 'text':
      return paramNode(type, coerceText(v, `${path}.value`, ctx));
    case 'textList':
      return paramNode(type, toArray(v, `${path}.value`).map((x, i) => coerceText(x, `${path}.value[${i}]`, ctx)));
    case 'int':
      return paramNode(type, fmtInt(v === undefined ? 0 : v, `${path}.value`));
    case 'intList':
      return paramNode(type, toArray(v, `${path}.value`).map((x, i) => fmtInt(x, `${path}.value[${i}]`)));
    case 'float':
      return paramNode(type, fmtFloat(v === undefined ? 0 : v, `${path}.value`));
    case 'floatList':
      return paramNode(type, toArray(v, `${path}.value`).map((x, i) => fmtFloat(x, `${path}.value[${i}]`)));
    case 'bool':
      return paramNode(type, fmtBool(v, `${path}.value`));
    case 'boolList':
      return paramNode(type, toArray(v, `${path}.value`).map((x, i) => fmtBool(x, `${path}.value[${i}]`)));
    case 'vector':
      return paramNode(type, fmtVector(v === undefined ? '0,0,0' : v, `${path}.value`));
    case 'vectorList':
      return paramNode(type, toArray(v, `${path}.value`).map((x, i) => fmtVector(x, `${path}.value[${i}]`)));
    case 'struct': {
      const sid = assertStructId(spec.structId, `${path}.structId`);
      ctx.structIds.push(sid);
      return paramNode('Struct', { structId: sid, type: 'Struct', value: structChildren(spec, path, ctx) });
    }
    case 'structList': {
      const sid = assertStructId(spec.structId, `${path}.structId`);
      ctx.structIds.push(sid);
      const items = toArray(v, `${path}.value`).map((entry, i) => paramNode('Struct', {
        structId: sid,
        type: 'Struct',
        value: structChildren(entry, `${path}.value[${i}]`, ctx),
      }));
      return paramNode('StructList', { structId: sid, value: items });
    }
    case 'dict': {
      const keyType = assertParamType(spec.key_type, `${path}.key_type`);
      const valueType = assertParamType(spec.value_type, `${path}.value_type`);
      const entries = toArray(v, `${path}.value`).map((e, i) => {
        const entry = e && typeof e === 'object' && !Array.isArray(e) ? e : { value: e };
        return {
          key: toParamNode({ param_type: keyType, value: entry.key }, `${path}.value[${i}].key`, ctx),
          value: toParamNode({ param_type: valueType, structId: spec.value_structId, value: entry.value }, `${path}.value[${i}].value`, ctx),
        };
      });
      const node = { type: 'Dict', key_type: keyType, value_type: valueType, value: entries };
      if (spec.value_structId !== undefined && spec.value_structId !== null && spec.value_structId !== '') {
        node.value_structId = assertStructId(spec.value_structId, `${path}.value_structId`);
        ctx.structIds.push(node.value_structId);
      }
      return paramNode('Dict', node);
    }
    default:
      return paramNode('NULL', null);
  }
}

/** 一个字段 → `BaseStructValue`（结构体定义里那一层）。 */
export function toDefinitionField(f, path, ctx) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new Error(`${path} 必须是对象 {key, param_type, value?}，收到 ${JSON.stringify(f)}`);
  }
  const key = String(f.key == null ? '' : f.key);
  if (key === '') throw new Error(`${path}.key 不能为空 —— 结构体定义里每个字段都要有 key`);
  const node = toParamNode(f, path, ctx);
  return { key, param_type: node.param_type, value: node };
}

/** 遍历已生成的定义，数出各类节点（只报数字）。 */
export function countNodes(node, acc = { paramNodes: 0, listNodes: 0, dictNodes: 0, structNodes: 0 }) {
  if (Array.isArray(node)) { node.forEach((n) => countNodes(n, acc)); return acc; }
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.param_type === 'string') {
    acc.paramNodes += 1;
    if (node.param_type.endsWith('List')) acc.listNodes += 1;
    if (node.param_type === 'Struct') acc.structNodes += 1;
    if (node.param_type === 'Dict') acc.dictNodes += 1;
  }
  for (const k of Object.keys(node)) countNodes(node[k], acc);
  return acc;
}

/** 未验证项（如实列，不当成已支持的能力宣传）。 */
export function unverifiedOf() {
  return [
    { what: '24 个 ParamType 是否等于 7.1 的完整类型集', why: '对方 i18n 自述只覆盖「月之八」（6.7）之前；我们手里没有 7.1 的官方类型枚举可逐项对照' },
    { what: 'struct_ype / struct_type 哪个才是千星吃的拼写', why: '同仓库 25 份真实样例**全部**写 struct_ype，但没有官方规格；默认沿用样例，可用 spelling 切换' },
    { what: 'Float 固定两位小数、Vector3 的数值格式', why: '样例里 Float 全是两位小数、Vector3 只见 "0,0,0"；其它精度没有样例可对照' },
    { what: '500 字符上限是否仍是 7.1 的限制', why: '源码文案写「会导致导入千星编辑器失败」，是与否都只来自对方自述' },
  ];
}

/**
 * `op=struct-json` 的完整回执。**只报数字与结果，不下判决**。
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
export function structJson(args = {}) {
  // ⚠️ spelling 在这里**直接算成字符串**（不放进 union）：写成 `(() => {...})()` 那种会推出
  //    `'struct_ype' | 'struct_type' | {error}`，于是 `{[spelling]: ...}` 过不了 `tsc --checkJs`（TS2464）。
  let spelling;
  try {
    spelling = normalizeSpelling(args.spelling);
  } catch (e) {
    return { ok: false, op: 'struct-json', error: (e && e.message) || String(e) };
  }
  let structId;
  try {
    structId = assertStructId(args.structId, 'structId');
  } catch (e) {
    return { ok: false, op: 'struct-json', error: e.message };
  }
  if (!Array.isArray(args.fields) || !args.fields.length) {
    return { ok: false, op: 'struct-json', error: 'fields 必须是「至少 1 个字段」的数组：每项 {key, param_type, value?}' };
  }
  const ctx = { coerced: [], structIds: [structId] };
  let defFields;
  try {
    defFields = args.fields.map((f, i) => toDefinitionField(f, `fields[${i}]`, ctx));
  } catch (e) {
    return { ok: false, op: 'struct-json', error: e.message };
  }
  const definition = { type: 'Struct', [spelling]: 'basic', name: String(args.structName || '未命名结构体'), value: defFields };
  const value = { structId, type: 'Struct', value: defFields.map((f) => f.value) };

  // ★ 硬规则②：单条文本 ≤ 500 字符。默认**报错**（源码只警告就放行）；allowLongText:true 才降级成 warnings。
  const limit = checkTextLimit(definition);
  const warnings = [];
  if (!limit.ok) {
    if (args.allowLongText !== true) {
      return {
        ok: false,
        op: 'struct-json',
        error: `有 ${limit.over.length} 条文本超过 ${TEXT_LIMIT} 字符（最长 ${limit.max}）—— 千星会导不进去。`
          + `第一条：${limit.over[0].path} 长度 ${limit.over[0].length}。`
          + '（要放行就显式传 allowLongText:true；源码里那只是警告，我们默认按硬规则拦）',
        textLimit: TEXT_LIMIT,
        over: limit.over.map((t) => ({ path: t.path, length: t.length })),
      };
    }
    for (const t of limit.over) warnings.push({ code: 'TEXT_TOO_LONG', path: t.path, length: t.length, limit: TEXT_LIMIT, note: '会导致导入千星编辑器失败' });
  }

  const summaryOnly = args.summaryOnly === true;
  const variableName = args.variableName === undefined || args.variableName === null || args.variableName === ''
    ? null : String(args.variableName);
  const variable = variableName ? { variableName, value } : null;
  const counts = countNodes(value);
  const texts = collectTexts(definition);
  const structRefs = [...new Set(ctx.structIds)];

  const payload = {
    ok: true,
    op: 'struct-json',
    structId,
    structIdDigits: structId.length,
    spelling,
    spellingAlternative: spelling === 'struct_ype' ? 'struct_type' : 'struct_ype',
    spellingAccepted: ['struct_ype', 'struct_type'],
    definition,
    value,
    variable,
    counts: {
      fields: defFields.length,
      paramNodes: counts.paramNodes,
      listNodes: counts.listNodes,
      dictNodes: counts.dictNodes,
      structNodes: counts.structNodes,
      texts: texts.length,
      maxTextLength: limit.max,
      totalTextLength: texts.reduce((s, t) => s + t.length, 0),
      structRefs,
    },
    textLimit: TEXT_LIMIT,
    warnings,
    coerced: ctx.coerced,
    unverified: unverifiedOf(),
    nextStep: '把 `definitionText` 存成 `<结构体ID>.json`（在那之前先确认这 10 位 ID 就是创作者要的那个），'
      + '再让创作者在千星编辑器里按它建/导入结构体定义；`valueText` 是同一个结构体的**变量值**形态，'
      + '给「自定义变量」用。本工具**不写任何文件、也不建变量** —— 这一步必须人在编辑器里做。',
    notes: [
      `拼写：写出用 \`${spelling}\`（读入时 ${'`struct_ype`'} 与 ${'`struct_type`'} 都认）`,
      '两条硬规则：结构体 ID 必须 10 位数字；单条文本 ≤ 500 字符（默认报错，allowLongText:true 才放行）',
      'definition 给「结构体定义」，value 给「结构体变量值」（位置参数、无 key）—— 两种形态见文件头',
    ],
  };
  if (summaryOnly) {
    payload.definitionTextBytes = JSON.stringify(definition, null, 2).length;
    payload.valueTextBytes = JSON.stringify(value, null, 2).length;
  } else {
    payload.definitionText = JSON.stringify(definition, null, 2);
    payload.valueText = JSON.stringify(value, null, 2);
    if (variable) payload.variableText = JSON.stringify(variable.value, null, 2);
  }
  return payload;
}

/** 默认值表（给工具 description / 文档引用；`defaultNodeValue` 就是它的取值函数）。 */
export const DEFAULT_VALUES = Object.fromEntries(
  Object.keys(TYPE_KIND).map((t) => [t, defaultNodeValue(t)]),
);
