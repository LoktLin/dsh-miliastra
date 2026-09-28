// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/StructViewer/types/ParamsType.ts
//   与 src/views/StructViewer/utils/variableTypeMap.ts（24 个类型的中文标签）。
//   值编码（"标量都写成字符串"）另有**同仓库里的真实千星样例**作证据：
//   `src/assets/DSFGStudio/` 下的 25 份 json（全部形如 `{"param_type":"Int32","value":"0"}`）。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ⚠️ **未证实**：对方自述只覆盖「月之八」（6.7）**之前**的类型体系；我们手里没有一份 7.1 的
//    「结构体变量类型枚举」可以逐项对照 ⇒ 24 项**不宣称完整**，回执里带 `unverified`。

/** 24 个 `ParamType`（与源码逐一对应，顺序也照它）。 */
export const PARAM_TYPES = [
  'String', 'StringList', 'Int32', 'Int32List', 'Float', 'FloatList', 'Bool', 'BoolList',
  'Vector3', 'Vector3List', 'Entity', 'EntityList', 'Guid', 'GuidList',
  'ConfigReference', 'ConfigReferenceList', 'EntityReference', 'EntityReferenceList',
  'Army', 'ArmyList', 'Struct', 'StructList', 'Dict', 'NULL',
];

/** 类型 → 中文标签（`variableTypeMap.ts` 的 `titleKey` → zh-cn 文案）。 */
export const TYPE_LABELS = {
  String: '字符串', StringList: '字符串列表',
  Int32: '整数', Int32List: '整数列表',
  Float: '浮点数', FloatList: '浮点数列表',
  Bool: '布尔值', BoolList: '布尔值列表',
  Vector3: '三维向量', Vector3List: '三维向量列表',
  Entity: '实体', EntityList: '实体列表',
  Guid: 'Guid', GuidList: 'Guid 列表',
  ConfigReference: '配置ID', ConfigReferenceList: '配置ID列表',
  EntityReference: '元件ID', EntityReferenceList: '元件ID列表',
  Army: '阵营', ArmyList: '阵营列表',
  Struct: '结构体', StructList: '结构体列表', Dict: '字典', NULL: '空',
};

/**
 * 值编码（**从真实千星样例归纳**，不是猜的）：
 *   · `int` / `intList` → 十进制**字符串**（样例 `"0"` / `["0","1"]`）
 *   · `float` / `floatList` → **两位小数**的字符串（样例 `"2.00"` / `"-1.00"`）
 *   · `bool` / `boolList` → `"True"` / `"False"`
 *   · `vector` / `vectorList` → `"x,y,z"`
 *   · `text` / `textList` → 原样字符串
 *   · `entity` 一族在源码里是**只读展示**（`ParamNodeRender` 直接 `{{ param.value }}`）
 */
export const TYPE_KIND = {
  String: 'text', StringList: 'textList',
  Int32: 'int', Int32List: 'intList',
  Float: 'float', FloatList: 'floatList',
  Bool: 'bool', BoolList: 'boolList',
  Vector3: 'vector', Vector3List: 'vectorList',
  Entity: 'int', EntityList: 'intList',
  Guid: 'int', GuidList: 'intList',
  ConfigReference: 'int', ConfigReferenceList: 'intList',
  EntityReference: 'int', EntityReferenceList: 'intList',
  Army: 'int', ArmyList: 'intList',
  Struct: 'struct', StructList: 'structList', Dict: 'dict', NULL: 'null',
};

/** 单条文本上限（源码 `StructViewer.vue` 的 `value.length >= 500` 警告文案：「会导致导入千星编辑器失败」）。 */
export const TEXT_LIMIT = 500;

/** 结构体 ID 规则（源码 `/^\d+$/.test(inputId) && inputId.length != 10` ⇒ 非法）。 */
export const STRUCT_ID_LENGTH = 10;

/** `struct_ype` 的历史拼写与"正确"拼写（详见 validate.mjs 的说明）。 */
export const SPELLING_KEYS = ['struct_ype', 'struct_type'];

/** 源码 `GetParamDefaultValue` 的默认值（逐型对应；`String` 的默认值是**一个空格**，照抄）。 */
export function defaultNodeValue(type) {
  const kind = TYPE_KIND[type];
  if (kind === 'text') return ' ';
  if (kind === 'float') return '0.00';
  if (kind === 'bool') return 'False';
  if (kind === 'vector') return '0,0,0';
  if (kind === 'null') return null;
  if (kind === 'int') return '0';
  return null; // 列表/结构体/字典：由调用方给空容器
}

/** 是不是 24 个 `ParamType` 之一。 */
export function isParamType(t) {
  return PARAM_TYPES.includes(String(t));
}

/** 生成一条 `ParamNode`（`{param_type, value}`）。 */
export function paramNode(type, value) {
  return { param_type: type, value };
}
