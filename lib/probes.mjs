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

  /**
   * 逐个核对「官方文档写了的 API，真机上到底有没有」。
   *
   * 为什么值得单独做一个模板：`docs\千星奇域_API参考.md` 是从**文档文本**抽出来的（153 个接口），
   * 而文档 ≠ 真机（版本 / 端 / 开关都可能不一样）。AGENTS.md 铁律 5「API 不许猜」的落地方式
   * 就是「文档查名字 → 真机核存在」。
   *
   * 顺带回答两件只有在运行时才知道的事：
   *   · `game.IsTestPlay()` 到底返回什么（= 「现在是不是在试玩」的官方判据）
   *   · `game.Tween` 这套补间 API 在这个正式服上真的存在吗
   */
  'api-check': () => `
local ROOTS = { game = game, script = script, Color = Color, math = math, debug = debug, Enum = Enum }

-- 文档里抽出来的接口（见 docs/千星奇域_API参考.md）。按名字逐个取 —— _G/game 不能枚举（实测）。
local NAMES = {
    "game.IsTestPlay", "game.GetStageMode", "game.GetLanguageType", "game.GetText",
    "game.PauseLevelTime", "game.IsLevelTimePaused",
    "game.PlayAudio2D", "game.StopAudio", "game.IsAudioAlive",
    "game.Tween", "game.TweenSequence",
    "game.InstantiateClientUIControl", "game.DestroyClientUIControl",
    "game.GetClientUIControl", "game.FindClientUIRoot", "game.GetClientUIRoots",
    "game.GetUICanvasSize", "game.GetCursorUIPos", "game.GetDevice",
    "game.SetControllerFocus", "game.GetControllerFocus",
    "game.PrintClientUITree",
    "Color.FromRGB", "Color.FromRGBA", "Color.ToRGBA",
    "script.EnableUpdate",
    "math.isnan", "math.isinf", "typeof", "print", "printerr", "debug.traceback",
}

local ENUM_TABLES = {
    "EaseType", "KeyEventType", "KeyboardKeyCode", "ControllerKeyCode", "Device",
    "StageMode", "LanguageType", "ImageSource", "ImageType", "ImageFillType",
    "TextHorizontalAlignment", "TextVerticalAlignment", "ScrollDirection",
    "UIAnimationLayer", "ParamType", "CursorEventType",
}

local function resolve(path)
    local head, rest = string.match(path, "^([^%.]+)%.(.+)$")
    if head == nil then return nil, "路径格式不对（本探针只收 a.b）" end
    local cur = ROOTS[head]
    if cur == nil then return nil, "没有这张根表：" .. head end
    for s in string.gmatch(rest, "[^%.]+") do
        local ok, v = pcall(function() return cur[s] end)
        if not ok then return nil, "取 " .. s .. " 报错" end
        if v == nil then return nil, "缺成员 " .. s end
        cur = v
    end
    return cur, nil
end

local function run()
    p("=========== API 可用性核对（文档 vs 真机）===========")
    p("Lua " .. tostring(_VERSION))

    -- ① 只在运行时才知道的几个值（含「是不是在试玩」）
    local okT, isTest = pcall(function() return game.IsTestPlay() end)
    p("game.IsTestPlay()      = " .. (okT and tostring(isTest) or ("读不到：" .. tostring(isTest))))
    local okM, mode = pcall(function() return game.GetStageMode() end)
    p("game.GetStageMode()    = " .. (okM and tostring(mode) or ("读不到：" .. tostring(mode))))
    local okL, lang = pcall(function() return game.GetLanguageType() end)
    p("game.GetLanguageType() = " .. (okL and tostring(lang) or ("读不到：" .. tostring(lang))))
    local w, h = 0, 0
    pcall(function() w, h = game.GetUICanvasSize() end)
    p("画布 = " .. tostring(w) .. " x " .. tostring(h))

    -- ② 逐个核接口是否存在
    local miss, hit = {}, {}
    for _, nm in ipairs(NAMES) do
        local v, err = resolve(nm)
        if v == nil then miss[#miss + 1] = "  x " .. nm .. "   （" .. tostring(err) .. "）"
        else hit[#hit + 1] = "  v " .. nm .. "   type=" .. type(v) end
    end
    p("--- 存在 " .. #hit .. " / " .. #NAMES .. " ---")
    pChunked(table.concat(hit, "\\n"))
    p("--- 文档里有、真机没取到 " .. #miss .. " 个 ---")
    pChunked(#miss > 0 and table.concat(miss, "\\n") or "  （一个都不缺）")

    -- ③ 枚举表能不能用
    local eHit, eMiss = {}, {}
    for _, t in ipairs(ENUM_TABLES) do
        local et = nil
        pcall(function() et = Enum[t] end)
        if et == nil then eMiss[#eMiss + 1] = "  x Enum." .. t
        else
            local n = 0
            pcall(function() for _ in pairs(et) do n = n + 1 end end)
            eHit[#eHit + 1] = "  v Enum." .. t .. "  成员 " .. n
        end
    end
    p("--- 枚举表可用 " .. #eHit .. " / " .. #ENUM_TABLES .. " ---")
    pChunked(table.concat(eHit, "\\n"))
    if #eMiss > 0 then p("--- 枚举表缺 " .. #eMiss .. " 个 ---\\n" .. table.concat(eMiss, "\\n")) end

    -- ④ 补间 API 真的能用吗：拿一个活控件、空目标表、极短时长试一次，立刻 Kill。
    --    ⚠️ 目标表是空的、时长 0.01s 且立刻销毁 —— 只是「问一句」，不会真的动到画面。
    local ctrl = nil
    pcall(function()
        local roots = game.GetClientUIRoots()
        if roots ~= nil then ctrl = roots[1] end
    end)
    if ctrl == nil then
        p("补间实测：跳过（取不到任何客户端控件根）")
    else
        local ok1, t = pcall(function() return game.Tween(ctrl, {}, 0.01) end)
        if not ok1 then
            p("补间实测：game.Tween 调用失败 -> " .. tostring(t))
        else
            p("补间实测：game.Tween 返回 type=" .. type(t) .. " tostring=" .. tostring(t))
            local ok2, e2 = pcall(function() t:SetEase(Enum.EaseType.Linear) end)
            p("  Tween:SetEase(Enum.EaseType.Linear) -> " .. (ok2 and "OK" or ("失败 " .. tostring(e2))))
            local ok3, e3 = pcall(function() t:Kill(false) end)
            p("  Tween:Kill(false) -> " .. (ok3 and "OK" or ("失败 " .. tostring(e3))))
        end
        local ok4, seq = pcall(function() return game.TweenSequence() end)
        p("补间实测：game.TweenSequence() -> " .. (ok4 and ("OK type=" .. type(seq)) or ("失败 " .. tostring(seq))))
    end

    p("=========== 结束 ===========")
end
`,
};

export const PROBE_TEMPLATES = Object.keys(BODIES);

/**
 * 每个模板的大白话说明 —— Host 工具描述、`op=list`、侧边栏面板三处共用这一份，避免各写一套。
 *
 * 写这些字的规矩（踩过）：**用使用者的词，不用实现者的词**。
 * 之前写「只读诊断脚本 / 最小连通性 / 读画布上所有活控件的控件模板索引并逐个试创建」，
 * 作者本人看不懂到底什么时候该点它。改成「问一句就答 / 确认脚本有没有跑起来 / 试钥匙」。
 */
export const PROBE_INFO = {
  ping: {
    label: '探活',
    oneLine: '确认「脚本到底有没有跑起来」',
    what: '只往日志里打几行字：脚本加载了没、OnStart 跑了没、OnUpdate 有没有在跳。',
    when: '试玩完日志里<strong>什么都没有</strong>时，先跑它。用来分清是「脚本压根没起来」还是「起来了但那段没执行」。',
  },
  tree: {
    label: '看控件',
    oneLine: '看屏幕上现在挂着哪些客户端控件、画布多大',
    what: '把每个活控件的名字、索引、父子关系、可见性列出来，并读一次画布尺寸。',
    when: '怀疑「控件没建出来 / 建到了错的父级下 / 尺寸不对」时。也能顺手核对画布尺寸是不是你预期的。',
  },
  instantiate: {
    label: '试钥匙',
    oneLine: '拿一串索引号去试，看哪个真能被脚本创建出来',
    what: '对每个候选号调一次创建接口：成功打 OK，失败是 nil；试出来的控件立刻销毁。',
    when: '准备让脚本动态建控件之前。<strong>只有「在模板库里存为模板」的控件才能被创建</strong>，画布上摆的实例一律 nil —— 用它查出哪些号真的能用。',
  },
  'api-surface': {
    label: '翻字典',
    oneLine: '把游戏里的枚举和它们的成员列出来（比如某个按键到底叫什么名）',
    what: '枚举各枚举表的全部成员与取值，并实测几个按键枚举能不能取到值。',
    when: '要引用某个枚举 / 按键名，但文档翻不到或不确定写法时 —— <strong>别猜，让它把真名打出来</strong>。输出较长，已做分片打印。',
  },
  'api-check': {
    label: '核文档',
    oneLine: '官方文档写的那些接口，真机上到底有没有',
    what: '拿文档抽出来的接口名（见 <code>docs/千星奇域_API参考.md</code>）逐个按名取一次，报「存在 / 取不到」；'
      + '顺带打印 game.IsTestPlay()（是不是在试玩）、GetStageMode()、语言、画布；并**实测一次 Tween**（空目标、0.01 秒、立刻销毁）。',
    when: '想用文档里某个没写过的接口之前先核一遍 —— **文档 ≠ 真机**（版本/端/开关都可能不一样）。'
      + '也可以只为看 game.IsTestPlay() 的值跑它。',
  },
};

/** 大白话的共同前提：探针是什么、代价是什么、四步怎么走。 */
export const PROBE_OVERVIEW = {
  what: '探针 = 一段临时替掉你脚本的小程序，只在试玩那几秒跑一次，把游戏内部的信息打到日志里。',
  why: '有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举叫什么名），必须让游戏真跑一遍才知道。',
  cost: '要临时**覆盖活文件**，所以试玩的那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。',
  steps: ['选一个探针', '点「部署」（覆盖活文件，先自动备份）', '在编辑器里**重新**试玩一局', '回来点「收回结论」，然后**还原你的脚本**'],
};

/**
 * 渲染一个探针的 Lua 全文。
 *
 * @param {string} template 模板名（见 `PROBE_TEMPLATES`；不在表里时回 `ok:false`）
 * @param {{tag?: string, ids?: number[], from?: number, to?: number, liveMax?: number}} [opts]
 *        `tag` = 日志标签（默认 `PROBE`，会被清洗成 `[A-Za-z0-9_-]`）；其余四项**只有
 *        `instantiate` 模板用**：候选控件索引列表、兜底扫描区间下界/上界、同时存活上限
 */
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
