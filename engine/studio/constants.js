/** Canvas presets share GIA platform slots. Simulator-policy sizes (PC 1600×900 observed). */

export const PLATFORMS = Object.freeze([
  'KEYBOARD',
  'TOUCHSCREEN',
  'CONTROLLER_CONSOLE',
  'CONTROLLER_MOBILE',
])

export const CANVAS_PRESETS = Object.freeze({
  'pc-16-9': {
    id: 'pc-16-9',
    device: 'pc',
    platform: 'KEYBOARD',
    width: 1600,
    height: 900,
    ratio: '16:9',
    luaDevice: 'KeyboardAndMouse',
    label: 'PC 1600×900',
  },
  'pc-21-9': {
    id: 'pc-21-9',
    device: 'pc',
    platform: 'KEYBOARD',
    width: 2100,
    height: 900,
    ratio: '21:9',
    luaDevice: 'KeyboardAndMouse',
    label: 'PC 2100×900',
  },
  'mobile-16-9': {
    id: 'mobile-16-9',
    device: 'mobile',
    platform: 'TOUCHSCREEN',
    width: 1280,
    height: 720,
    ratio: '16:9',
    luaDevice: 'Mobile',
    label: '手机 1280×720',
  },
  'mobile-19.5-9': {
    id: 'mobile-19.5-9',
    device: 'mobile',
    platform: 'TOUCHSCREEN',
    width: 1560,
    height: 720,
    ratio: '19.5:9',
    luaDevice: 'Mobile',
    label: '手机 1560×720',
  },
  'mobile-4-3': {
    id: 'mobile-4-3',
    device: 'mobile',
    platform: 'TOUCHSCREEN',
    width: 1280,
    height: 960,
    ratio: '4:3',
    luaDevice: 'Mobile',
    label: '手机 1280×960',
  },
})

export const DEFAULT_CANVAS_ID = 'pc-16-9'

/** Canonical preview used when a GIA platform slot must be materialized. */
export const CANONICAL_CANVAS_BY_PLATFORM = Object.freeze({
  KEYBOARD: 'pc-16-9',
  TOUCHSCREEN: 'mobile-16-9',
  CONTROLLER_CONSOLE: 'pc-16-9',
  CONTROLLER_MOBILE: 'mobile-16-9',
})

export const KIND_LABELS = Object.freeze({
  'server-container': '客户端控件容器',
  container: '容器节点',
  textbox: '文本框',
  image: '图片',
  button: '预设按钮',
  cursor: '光标检测区域',
  grid: '网格视窗',
  reference: '模板引用控件',
  textwindow: '文本视窗',
  keyhint: '按键提示',
  animation: '界面动效',
  fullscreen: '全屏动效',
})

export const CORE_KINDS = Object.freeze([
  'server-container',
  'container',
  'textbox',
  'cursor',
  'reference',
  'grid',
  'image',
  'button',
  'textwindow',
  'keyhint',
  'animation',
  'fullscreen',
])

export const DEFAULT_SIZE = Object.freeze({
  'server-container': null,
  container: [150, 150],
  textbox: [100, 40],
  image: [80, 80],
  button: [150, 50],
  cursor: [150, 50],
  grid: [80, 80],
  reference: [80, 80],
  textwindow: [100, 40],
  keyhint: [40, 40],
  animation: [100, 100],
  fullscreen: null,
})

export const IMAGE_PRIMITIVES = Object.freeze({
  100001: 'rect',
  100002: 'circle',
  100003: 'triangle',
  100004: 'fourstar',
  100005: 'fivestar',
  100006: 'ring',
})

/**
 * 一个「图片」控件该按什么画 —— **四处调用点共用这一条规则**（session / inspector / 两个渲染器）。
 *
 * 三档（E1③，2026-09-30）：
 *   · `100001~100006` ⇒ 几何形状（模拟器画得出来）
 *   · **没给贴图**（`imageId` 空 / 0）⇒ `'missing'` ⇒ 画成 **`?` 占位符**，
 *     **与真机一致**：创作者「图片」模板若没指定贴图，真机就是满屏 `?`。
 *     ⚠️ 以前作者层默认 `imageId = 100001`（方块）⇒ 模拟器**自己补一张方块**，
 *     把「真机满屏 `?`」这个症状**完全盖住**（真机白跑一轮换来的教训，见 E1）。
 *   · **有号但模拟器画不出来**（平台素材号，如 101023）⇒ `'unsupported'`：
 *     真机有图、我们只能画占位符 —— 与上一档**分开**，免得冤枉"缺贴图"。
 */
export function imagePrimitiveOf(imageId) {
  const id = Number(imageId) || 0
  if (id === 0) return 'missing'
  return IMAGE_PRIMITIVES[id] || 'unsupported'
}

/** 渲染器画占位符用的两档（`'missing'` = 真机也是 `?`；`'unsupported'` = 真机有图、模拟器画不出）。 */
export const PLACEHOLDER_PRIMITIVES = Object.freeze(['missing', 'unsupported'])

export const DEFAULT_CLICK_AUDIO_ID = 50888

export const COLOR = Object.freeze({
  font: 4294967295,
  bg: 16777215,
  outline: 858993459,
  image: 4294967295,
})
