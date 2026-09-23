/**
 * probes.mjs — 探针模板
 *
 * 「探针」= 一段只读的客户端 Lua，试玩一局就能把运行时真相打到日志里。
 * 这一轮排障（2026-09-23）就是靠这套办法把「实例化为什么返回 nil」钉死的，
 * 现在把它固化成模板，省掉每次手写。
 *
 * 三条硬经验，模板里已经内建：
 *   ① **必须 `script:EnableUpdate(true)`**，否则 `OnUpdate` 永远不触发 ——
 *      症状是日志里只有 OnInit/OnEnable/OnStart 三行空壳（曾踩过）。
 *   ② 所有输出统一前缀 `[TAG]`，方便在日志里 grep。
 *   ③ 只读：不做场景写操作；创建出来的控件用完立刻 Destroy。
 */

const PRELUDE = (tag, note) => `-- ============================================================
-- 探针：${note}
-- 由 dsh-miliastra 生成（${new Date().toISOString()}）· 只读，不写场景
-- 用法：试玩一局（起来 3~5 秒即可），然后用 miliastra_log tag=${tag} 取回结果
-- ============================================================

local TAG = "${tag}"
local ticks = 0
local ran = false

local function p(s) print("[" .. TAG .. "] " .. s) end

-- ⚠️ 单条日志消息上限**实测正好 10000 字符**，超出的部分会被**静默截断**（不报错、不提示）。
-- 踩过：api-surface 打 Enum.KeyEventType（164 项）时第一片就打满 10000，
-- 后面 KeyboardMoveLeftKeyDown / KeyboardJumpKeyDown 这些正是要查的名字全被切掉了 ——
-- 看日志的人会以为「枚举里没有这个键」。所以**长输出一律分片**。
local CHUNK = 3500
local function pChunked(s)
    s = tostring(s)
    local n = #s
    if n <= CHUNK then p(s) return end
    local total = 0
    local rest = n
    while rest > 0 do total = total + 1; rest = rest - CHUNK end
    local i = 1
    local at = 1
    while at <= n do
        local part = string.sub(s, at, at + CHUNK - 1)
        p("(" .. i .. "/" .. total .. ") " .. part)
        i = i + 1
        at = at + CHUNK
    end
end

function OnInit()    end
function OnEnable()  end
function OnDisable() end
function OnDestroy() end

function OnStart()
    local ok, err = pcall(function() script:EnableUpdate(true) end)
    p("OnStart EnableUpdate ok=" .. tostring(ok) .. " err=" .. tostring(err))
end

local function field(obj, name)
    if obj == nil then return nil end
    local ok, v = pcall(function() return obj[name] end)
    if ok then return v end
    return nil
end

local function describe(tag, obj)
    if obj == nil then p(tag .. " = nil") return end
    local parts = {}
    local function add(k, fn)
        local ok, v = pcall(fn)
        parts[#parts + 1] = k .. "=" .. (ok and tostring(v) or "ERR")
    end
    add("name",   function() return obj.name end)
    add("prefab", function() return obj.prefabIndex end)
    add("id",     function() return obj.id end)
    add("active", function() return obj.active end)
    add("visible",function() return obj.visible end)
    add("tostr",  function() return tostring(obj) end)
    p(tag .. " = " .. table.concat(parts, " | "))
end
`;

const EPILOGUE = `
function OnUpdate(dt)
    ticks = ticks + 1
    if ticks == 3 and not ran then
        ran = true
        local ok, err = pcall(run)
        if not ok then p("run() 异常: " .. tostring(err)) end
        p("（之后不再输出）")
    end
end
`;

const BODIES = {
  /**
   * 把客户端 Lua 的**能力面**摊开打出来：`Enum` / `game` / `script` / 全局表。
   *
   * 为什么需要它：写客户端脚本时最费时间的不是逻辑，是**猜名字** ——
   * 比如「按键枚举到底挂在 `Enum.KeyEventType` 还是 `Enum.KeyboardKeyCode`」，
   * 之前只能在三个候选里轮着试（`resolveKeyEvent` 就是这么写的）。
   * 这个探针一次性把真实存在的表名/键名/函数名打出来，**把猜变成查**。
   *
   * 只读，不创建/销毁任何控件。
   */
  'api-surface': () => `
local CAP = 240   -- 单张表最多打这么多成员，防止刷爆日志

local function names(t, cap)
    local out, n = {}, 0
    local ok, err = pcall(function()
        for k in pairs(t) do
            n = n + 1
            if n > (cap or CAP) then out[#out + 1] = "…还有更多"; break end
            out[#out + 1] = tostring(k)
        end
    end)
    if not ok then return nil, tostring(err) end
    table.sort(out)
    return out, nil
end

local function dump(tag, t)
    if t == nil then p(tag .. " = nil"); return end
    local ns, err = names(t)
    if ns == nil then p(tag .. " 无法枚举（" .. err .. "）"); return end
    pChunked(tag .. " [" .. #ns .. "] = " .. table.concat(ns, ", "))
end

local function dumpKVs(tag, t, cap)
    if t == nil then p(tag .. " = nil"); return end
    local out = {}
    local ok, err = pcall(function()
        local n = 0
        for k, v in pairs(t) do
            n = n + 1
            if n > (cap or CAP) then out[#out + 1] = "…还有更多"; break end
            out[#out + 1] = tostring(k) .. "=" .. tostring(v)
        end
    end)
    if not ok then p(tag .. " 无法枚举（" .. err .. "）"); return end
    table.sort(out)
    pChunked(tag .. " [" .. #out .. "] = " .. table.concat(out, ", "))
end

local function run()
    p("=========== API 面探测 ===========")

    -- ① 全局表
    dump("_G", _G)
    dump("Enum", Enum)
    dump("game", game)
    dump("script", script)

    -- ② 按键相关枚举：把候选逐个列出真实键名（这是 resolveKeyEvent 一直在猜的东西）
    p("--- 按键 / 枚举候选 ---")
    for _, tname in ipairs({
        "KeyEventType", "KeyboardKeyCode", "ControllerKeyCode", "Device",
        "ImageSource", "ImageType", "TextHorizontalAlignment", "TextVerticalAlignment",
        "ScrollDirection", "CustomVariableEntityType",
    }) do
        local sub = nil
        pcall(function() sub = Enum[tname] end)
        if sub == nil then
            p("Enum." .. tname .. " = nil")
        else
            dumpKVs("Enum." .. tname, sub)
        end
    end

    -- ③ script 的成员 + 元表（能看到 API 未文档化的部分）
    p("--- script / script.object ---")
    local mt = nil
    pcall(function() mt = getmetatable(script) end)
    if mt ~= nil and mt.__index ~= nil then dump("script.__index", mt.__index) else p("script 没有可枚举的元表") end
    if script.object ~= nil then
        local omt = nil
        pcall(function() omt = getmetatable(script.object) end)
        if omt ~= nil and omt.__index ~= nil then
            dump("script.object.__index", omt.__index)
        else
            p("script.object 元表不可枚举（" .. tostring(script.object) .. "）")
        end
    else
        p("script.object = nil")
    end

    -- ④ 按键事件真能用哪个：对候选逐一 pcall 出一个具体键，看谁真的返回值
    p("--- 按键枚举实测（谁真的能取值） ---")
    for _, tname in ipairs({"KeyEventType", "KeyboardKeyCode", "ControllerKeyCode"}) do
        local sub
        pcall(function() sub = Enum[tname] end)
        if sub ~= nil then
            for _, kn in ipairs({"W", "A", "D", "Space", "LeftShift", "Escape"}) do
                local v
                local ok = pcall(function() v = sub[kn] end)
                if ok and v ~= nil then p("  " .. tname .. "." .. kn .. " = " .. tostring(v)) end
            end
        end
    end

    -- ⑤ 画布 / 宿主（顺带核对）
    local okS, w, h = pcall(function() return game.GetUICanvasSize() end)
    if okS then p("canvas = " .. tostring(w) .. "x" .. tostring(h)) else p("canvas 读取失败: " .. tostring(h)) end
    describe("script.object", script.object)
    p("=========== 结束 ===========")
end
`,

  /** 只打印运行时控件树 + 画布尺寸 + 根节点/脚本宿主。 */
  tree: () => `
local function run()
    p("=========== 控件树 ===========")
    local root
    pcall(function() root = game.GetClientUIRoots()[1] end)
    describe("roots[1]", root)
    describe("script.object", script.object)
    local okS, w, h = pcall(function() return game.GetUICanvasSize() end)
    if okS then p("canvas=" .. tostring(w) .. "x" .. tostring(h)) else p("canvas 读取失败: " .. tostring(h)) end
    p("--- game.PrintClientUITree() ---")
    local okT, errT = pcall(function() game.PrintClientUITree() end)
    p("PrintClientUITree ok=" .. tostring(okT) .. " err=" .. tostring(errT))
    p("=========== 结束 ===========")
end
`,

  /**
   * 读画布上所有活控件的 prefabIndex（官方字段表里的「控件模板索引」），
   * 然后用每个读到的号去实例化，并扫一个区间兜底。
   * 用来回答「哪些控件模板索引在正式服真能被脚本创建」。
   */
  instantiate: (opt = {}) => {
    const from = Number.isFinite(opt.from) ? opt.from : 1073741824;
    const to = Number.isFinite(opt.to) ? opt.to : 1073741900;
    const liveMax = Number.isFinite(opt.liveMax) ? opt.liveMax : 48;
    const extra = Array.isArray(opt.ids) ? opt.ids.filter((n) => Number.isFinite(n)) : [];
    return `
local EXTRA = { ${extra.join(', ')} }

local function tryAt(tag, parent, id)
    local obj
    local ok, err = pcall(function() obj = game.InstantiateClientUIControl(id, parent) end)
    if not ok then p(tag .. " id=" .. tostring(id) .. " pcallErr=" .. tostring(err)) return nil end
    if obj == nil then return nil end
    local nm, pf = "?", "?"
    pcall(function() nm = tostring(obj.name) end)
    pcall(function() pf = tostring(obj.prefabIndex) end)
    p(tag .. " >>> OK id=" .. tostring(id) .. " prefab=" .. pf .. " name=" .. nm)
    return obj
end

local function run()
    p("=========== 模板实例化 ===========")
    local root
    pcall(function() root = game.GetClientUIRoots()[1] end)
    describe("roots[1]", root)
    describe("script.object", script.object)
    pcall(function() game.PrintClientUITree() end)

    local seen, order = {}, {}
    local function note(pf, who)
        if pf == nil then return end
        local key = tostring(pf)
        if not seen[key] then seen[key] = true; order[#order + 1] = pf; p("收集到 prefabIndex=" .. key .. "（来自 " .. who .. "）") end
    end
    for i = 1, ${liveMax} do
        local obj
        local ok = pcall(function() obj = game.GetClientUIControl(i) end)
        if ok and obj ~= nil then describe("live[" .. i .. "]", obj); note(field(obj, "prefabIndex"), "live[" .. i .. "]") end
    end
    for i = 1, #EXTRA do note(EXTRA[i], "EXTRA") end
    p("共收集到 " .. #order .. " 个 prefabIndex")

    local parent = script.object
    if parent == nil then parent = root end
    local hits = 0
    for i = 1, #order do
        local obj = tryAt("byPrefab", parent, order[i])
        if obj ~= nil then hits = hits + 1; pcall(function() game.DestroyClientUIControl(obj) end) end
    end
    p(">>> 用活控件 prefabIndex 实例化：命中 " .. hits .. " / " .. #order)

    local sweep = 0
    for id = ${from}, ${to} do
        local obj = tryAt("sweep", root, id)
        if obj ~= nil then sweep = sweep + 1; pcall(function() game.DestroyClientUIControl(obj) end) end
    end
    p(">>> 区间 ${from}~${to} 命中 " .. sweep)
    p("=========== 结束 ===========")
end
`;
  },

  /** 最小连通性探针：确认脚本通道 + EnableUpdate + OnUpdate 都活着。 */
  ping: () => `
local function run()
    p("=========== ping ===========")
    describe("script.object", script.object)
    local ok, w, h = pcall(function() return game.GetUICanvasSize() end)
    p("GetUICanvasSize ok=" .. tostring(ok) .. " w=" .. tostring(w) .. " h=" .. tostring(h))
    p("=========== 结束 ===========")
end
`,
};

export const PROBE_TEMPLATES = Object.keys(BODIES);

/** 渲染一个探针的 Lua 全文。 */
export function renderProbe(template, { tag = 'PROBE', ids, from, to, liveMax } = {}) {
  const key = String(template || '').trim();
  const body = BODIES[key];
  if (!body) {
    return { ok: false, error: `没有模板 "${template}"（可用：${PROBE_TEMPLATES.join(', ')}）`, templates: PROBE_TEMPLATES };
  }
  const safeTag = String(tag).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 24) || 'PROBE';
  const lua = PRELUDE(safeTag, key) + body({ ids, from, to, liveMax }) + EPILOGUE;
  return { ok: true, template: key, tag: safeTag, lua, bytes: Buffer.byteLength(lua, 'utf8') };
}
