// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue
//   （**只移植算法**；这一段 Lua 是本仓自己写的驾驶层 —— 原作者那份走 `script:GetParam("ImagePrefebID")`
//     读编辑器里的参数，本仓把它换成顶部 `CONFIG` 常量，因为 AI 交接的索引本来就来自调用参数。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 目标（作者 2026-09-28 明令）：**AI 调一次接口，回执里就是能直接用的 Lua**。
// ★ 所以产物遵本仓 Lua 铁律（工作区 `AGENTS.md` §6）：
//   ① 交接值全部进顶部 `CONFIG`（模板 / 容器 / 网格 / 像素尺寸 / 中心偏移），**不写裸数字**；
//   ② 控件拿不到 / `InstantiateClientUIControl` 返回 nil ⇒ **`error` 并点名**（模板号 + 第几块），
//      绝不静默 return；
//   ③ ⛔ 不做任何"掩盖报错的兜底"（没有 pcall 吞异常、没有屏幕诊断串、没有"建不出来就算了"）；
//   ④ ★ **不调 `script:EnableUpdate(true)`** —— 像素画是**静态**的：产物里没有 `OnUpdate`，
//      要 tick 干什么？这一条是**刻意的**：本仓实测「开了 EnableUpdate 却没有 OnUpdate」纯属白烧每帧预算。
//   ⑤ `local` 一个不漏（本仓最高发的 bug 类：漏 `local` → 闭包读到 nil → 整块冻结）。
// ★ 与官方 API 的对应（`docs/官方文档-7.1正式/原文/doc_客户端控件API文档.txt` 逐条核过）：
//   `game.InstantiateClientUIControl(controlPrefabIndex, parent)` / `SetAnchoredPosition(x,y)` /
//   `SetSizeDelta(x,y)` / `SetPivot(x,y)` / `SetAnchorMin|Max(x,y)` / `Enum.ImageType`(Basic|Stretch) /
//   `Color.FromRGBA(r,g,b,a)` / **字段 `imageColor`**（⚠️ `SetImageColor` 官方 0 命中，不能用）。
// ※ `CONTAINER_INDEX` 的作用是**自证挂在哪**（`OnStart` 里 print 出来，`.gia` 里可核）——
//   它不进 `InstantiateClientUIControl`（父级用 `script.object`）：官方没有"按节点索引取容器"的接口。

/** Lua 字符串字面量（只转义真正需要转义的；中文原样保留）。 */
function quote(s) {
  const body = String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t');
  return '"' + body + '"';
}

/** 一个块的 Lua 表项：`{x,y,w,h,r,g,b,a}`（顺序与源实现的 `PIXELS` 一致）。 */
function blockLine(b) {
  const c = b.color;
  return '    {' + [b.x, b.y, b.w, b.h, c[0], c[1], c[2], c[3]].join(',') + '},';
}

/**
 * 生成一份**可直接部署**的 Lua（图片 → 图片控件矩形块拼图）。
 *
 * @param {{cols: number, rows: number, pixelSize: number, centerOffsetX: number, centerOffsetY: number,
 *          imageType: string, blocks: any[], templateIndex: number|null, containerIndex: number|null,
 *          use4bit: boolean}} spec
 * @returns {string}
 */
export function buildPixelArtLua(spec) {
  const ver = 'pixel-art/' + spec.cols + 'x' + spec.rows + '/' + spec.blocks.length + 'b';
  const L = [];
  L.push('-- 千星奇域 · 图片转像素画（由 dsh-miliastra 的 `miliastra_gen op=pixel-art output=lua` 生成，勿手改）');
  L.push('-- 算法移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/PixelArt/PixelArt.vue');
  L.push('-- 网格 ' + spec.cols + '×' + spec.rows + ' 格；矩形块 ' + spec.blocks.length
    + ' 个（行内行程 + 跨行同色同宽合并；透明格不建块）');
  L.push('-- 挂法：挂在「客户端控件容器 → 容器节点」这一层的**客户端脚本**上。'
    + '模板 / 容器是**创作者交接值**，缺了本脚本会 error 点名。');
  L.push('-- ★ 本脚本**不开** `script:EnableUpdate`：像素画是**静态**的 —— 建完就不动了，');
  L.push('--   没有 `OnUpdate` 却开着 tick 只会每帧白烧预算（真要动画就自己加 OnUpdate 再开）。');
  if (spec.use4bit) {
    L.push('-- ⚠️ 本文件含「4bit 量化」：官方 7.1 原文 `4bit` / `#RGB` **0 命中**（已核）—— '
      + '**未经真机验证**，先在编辑器里试一次再发。');
  }
  L.push('');
  L.push('local VER = ' + quote(ver));
  L.push('');
  L.push('local CONFIG = {');
  L.push('    -- 交接值：图片控件的**控件模板索引**（界面控件组管理 → 客户端控件模板里的那条独立模板）');
  L.push('    TEMPLATE_INDEX = ' + (Number.isFinite(spec.templateIndex) && spec.templateIndex ? spec.templateIndex : 'nil') + ',');
  L.push('    -- 交接值：脚本要挂的那个**容器节点索引**（只用于自证挂在哪：start 日志里会打出来）');
  L.push('    CONTAINER_INDEX = ' + (Number.isFinite(spec.containerIndex) && spec.containerIndex ? spec.containerIndex : 'nil') + ',');
  L.push('    -- 网格（格）');
  L.push('    COLS = ' + spec.cols + ',');
  L.push('    ROWS = ' + spec.rows + ',');
  L.push('    -- 一个格子在画布上占多少像素');
  L.push('    PIXEL_SIZE = ' + spec.pixelSize + ',');
  L.push('    -- 像素画中心相对容器中心的偏移（画布单位）');
  L.push('    CENTER_OFFSET_X = ' + spec.centerOffsetX + ',');
  L.push('    CENTER_OFFSET_Y = ' + spec.centerOffsetY + ',');
  L.push('    -- 官方 7.1 原文 Enum.ImageType 只有 Basic / Stretch 两个值');
  L.push('    IMAGE_TYPE = ' + quote(spec.imageType) + ',');
  L.push('}');
  L.push('');
  L.push('-- 每个块 = 一个图片控件：{x, y, w, h, r, g, b, a}');
  L.push('-- x/y 是**格坐标、左上原点**；w/h 是**格数**；颜色 0-255（a=0 的格子不会出现在这里）');
  L.push('local BLOCKS = {');
  for (const b of spec.blocks) L.push(blockLine(b));
  L.push('}');
  L.push('');
  L.push('local controls = {}');
  L.push('');
  L.push('-- 取父级：拿不到就 error 点名（不返回 nil、不静默）');
  L.push('local function resolveParent()');
  L.push('    local host = script.object');
  L.push('    if host == nil then');
  L.push('        error("[pixel-art] script.object 为空：本脚本必须挂在「客户端控件容器 → 容器节点」的客户端脚本上")');
  L.push('    end');
  L.push('    return host');
  L.push('end');
  L.push('');
  L.push('function OnStart()');
  L.push('    print("[pixel-art] start ver=" .. VER');
  L.push('        .. " template=" .. tostring(CONFIG.TEMPLATE_INDEX)');
  L.push('        .. " container=" .. tostring(CONFIG.CONTAINER_INDEX)');
  L.push('        .. " blocks=" .. tostring(#BLOCKS))');
  L.push('    if CONFIG.TEMPLATE_INDEX == nil then');
  L.push('        error("[pixel-art] 缺少交接值 CONFIG.TEMPLATE_INDEX：请创作者给出**图片控件**的控件模板索引"');
  L.push('            .. "（只有「存为模板」的独立控件能被创建）")');
  L.push('    end');
  L.push('    local parent = resolveParent()');
  L.push('    local imageType = Enum.ImageType.Stretch');
  L.push('    if CONFIG.IMAGE_TYPE == "Basic" then');
  L.push('        imageType = Enum.ImageType.Basic');
  L.push('    end');
  L.push('    for i = 1, #BLOCKS do');
  L.push('        local b = BLOCKS[i]');
  L.push('        local c = game.InstantiateClientUIControl(CONFIG.TEMPLATE_INDEX, parent)');
  L.push('        if c == nil then');
  L.push('            error("[pixel-art] InstantiateClientUIControl 返回 nil（模板索引 " .. tostring(CONFIG.TEMPLATE_INDEX)');
  L.push('                .. "，第 " .. tostring(i) .. " 块）：只有「存为模板」的独立控件能创建，画布上摆的实例恒返回 nil")');
  L.push('        end');
  L.push('        controls[#controls + 1] = c');
  L.push('        c:SetAnchorMin(0.5, 0.5)');
  L.push('        c:SetAnchorMax(0.5, 0.5)');
  L.push('        c:SetPivot(0.5, 0.5)');
  L.push('        c:SetSizeDelta(b[3] * CONFIG.PIXEL_SIZE, b[4] * CONFIG.PIXEL_SIZE)');
  L.push('        -- 与源实现同一条换算：格坐标（左上原点）→ 相对容器中心的偏移；y 取负是因为画布 y 向上');
  L.push('        c:SetAnchoredPosition(');
  L.push('            (b[1] + b[3] / 2 - CONFIG.COLS / 2 - CONFIG.CENTER_OFFSET_X) * CONFIG.PIXEL_SIZE,');
  L.push('            (CONFIG.ROWS / 2 - b[2] - b[4] / 2 - CONFIG.CENTER_OFFSET_Y) * CONFIG.PIXEL_SIZE)');
  L.push('        c.imageType = imageType');
  L.push('        -- ⚠️ 颜色只能走**字段** imageColor：官方 7.1 原文 `SetImageColor` 命中 0');
  L.push('        c.imageColor = Color.FromRGBA(b[5], b[6], b[7], b[8])');
  L.push('    end');
  L.push('    print("[pixel-art] built controls=" .. tostring(#controls))');
  L.push('end');
  L.push('');
  L.push('function OnDestroy()');
  L.push('    for i = #controls, 1, -1 do');
  L.push('        local c = controls[i]');
  L.push('        if c ~= nil and c.alive then');
  L.push('            game.DestroyClientUIControl(c)');
  L.push('        end');
  L.push('    end');
  L.push('    controls = {}');
  L.push('end');
  L.push('');
  return L.join('\n');
}
