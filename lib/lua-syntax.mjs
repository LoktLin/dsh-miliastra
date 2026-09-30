/**
 * 真 Lua 语法检查（`fengari` 编译器，**不是**正则/括号配对）。
 *
 * ★ 为什么要有它：创作者反馈 **3 次 Lua 语法错误全部漏过**了 `miliastra_code op=deploy` 的 lint ——
 *   那份 lint 只做**结构配对**（`end`/括号个数），不做语法分析，于是「deploy 成功」被误当成「语法正确」，
 *   脚本进了真机才炸（或者更糟：静默不生效，日志里什么都没有）。
 *   本仓已经有 `fengari`（`engine/lua-runtime/src/lua-bridge.js` 第一行就 import 它），
 *   直接拿它当**真解析器**用，比自己写规则可靠得多。
 *
 * ★ 覆盖：**语法层**问题 —— 括号/花括号/方括号不配平、块（`if`/`function`/`do`）缺 `end`、
 *   表构造器**缺逗号**、未闭合的短字符串 / 长字符串 / 长注释、非法符号、`until` 缺失等
 *   —— 这些 Lua 官方编译器（fengari 是 Lua 5.3 的 JS 移植）**在编译期**就能确定。
 *
 * ★ **不覆盖**（各有专门检查，别指望这里）：
 *   · 作用域：读了没声明的名字 → Lua 不报错，值就是 `nil` ⇒ `tools/check-lua-scope.mjs`
 *   · 风格：命名/行长/裸色值 ⇒ `tools/check-lua-style.mjs --baseline`
 *   · 类型：`nil` 上取字段 ⇒ 运行时才炸
 *   · 运行时语义：官方 API 存不存在、控件索引对不对 ⇒ `miliastra_probe` / `miliastra_sim` / 真机日志
 *   · 平台 UI 门禁（8 的倍数坐标 / 字号档位 / 文本框高度）⇒ `miliastra_code op=lint-ui`
 *
 * ★ 纯函数纪律：**不写盘、不抛异常、不缓存全局 lua_State**（每次都 `luaL_newstate` + `lua_close`）。
 *   连 fengari 自身崩了也只回 `{ok:false, error}` —— 部署路径上的门禁**永远不许因为门禁自己坏了而中断**。
 */
import fengari from 'fengari'

const { lua, lauxlib, to_luastring, to_jsstring } = fengari

/**
 * 从 fengari 的原始报错串里解出**行号**。解不出就回 `null`（**不猜**）。
 *
 * fengari（`luaL_loadbuffer` 带 `@name` 型 chunkName，即本仓 `runtime.js` 的用法）报错形如：
 *   `lua-syntax:3: '}' expected (to close '{' at line 1) near 'y'`
 * 若 chunkName **不带 `@`**，Lua 会自己套一层 `[string "..."]`（实测 chunkName 里带引号也照套）：
 *   `[string "my "x" chunk"]:3: '}' expected (to close '{' at line 1) near 'y'`
 * 两种前缀都认（本仓走 ①，② 留给别处直接调 `loadbuffer` 的用法）。
 * 认不出就 `null` —— 行号是给人看的定位，宁可说"没解出来"也不给一个错的。
 *
 * @param {string} raw fengari 的原始错误串
 * @returns {{line: number|null, message: string}} line 为行号（解不出 null）；message 为去掉 chunk 前缀的正文
 */
function parseLuaError(raw) {
  const text = String(raw == null ? '' : raw)
  // ① `[string "x"]:12: …` —— chunkName **不带 `@`** 时 Lua 自己套的壳
  const bracket = /^\[string "(?:[^"\\]|\\.)*"\]:(\d+):[ \t]?/.exec(text)
  if (bracket) return { line: Number(bracket[1]), message: text.slice(bracket[0].length) }
  // ② `chunkName:12: …` —— `@chunkname` 形态（本仓 runtime.js 用的就是它）。
  //    chunkName 自身可能带 `:`（如 `D:\a\b.lua` / 带冒号的关卡名），所以前缀**贪婪**匹配，
  //    让行号落在**最后一个**「前缀 + `:` + 数字 + `:`」上。
  const named = /^(.*):(\d+):[ \t]?/.exec(text)
  if (named) return { line: Number(named[2]), message: text.slice(named[0].length) }
  // ③ 解不出：如实 null（宁可说"没解出来"，也不给一个错的定位）
  return { line: null, message: text }
}

/**
 * 对一段 Lua 源码做**真语法检查**（fengari 编译，不执行）。
 *
 * @param {string} source Lua 源码（BOM 会被剥掉 —— 原神读带 BOM 的文件会报 Lua 错）
 * @param {{ chunkName?: string }} [opts] chunkName 用于报错定位；默认 `lua-syntax`
 * @returns {{ok: true} | {ok: false, error: string, message: string, line: number|null, chunkName: string}}
 */
export function checkLuaSyntax(source, opts = {}) {
  const chunkName = opts && opts.chunkName ? String(opts.chunkName) : 'lua-syntax'
  let L = null
  try {
    const src = String(source == null ? '' : source).replace(/^\uFEFF/, '')
    // 与 `engine/lua-runtime/src/runtime.js` 的 runChunk 同一套写法（参数顺序 / 返回值语义照抄，不编 API）：
    //   luaL_loadbuffer(L, buf, buf.length, chunkname) → 状态码；LUA_OK 才算编译通过；失败时**错误串在栈顶**。
    L = lauxlib.luaL_newstate()
    const buf = to_luastring(src)
    const status = lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring(`@${chunkName}`))
    if (status === lua.LUA_OK) return { ok: true }
    const raw = to_jsstring(lua.lua_tostring(L, -1)) || `luaL_loadbuffer status ${status}`
    const { line, message } = parseLuaError(raw)
    return { ok: false, error: raw, message, line, chunkName }
  } catch (err) {
    // 门禁自己坏了 / fengari 抛了 —— 照样回结构化结果，绝不往上抛（部署路径不能被门禁打断）
    const raw = String((err && err.message) || err)
    return {
      ok: false,
      error: raw,
      message: `语法检查自身异常（不是源码的错，请上报）：${raw}`,
      line: null,
      chunkName,
    }
  } finally {
    // 每次新建就每次关闭：不缓存 lua_State（缓存会跨调用留栈、留注册表引用，且并发下互相踩）
    if (L) {
      try {
        lua.lua_close(L)
      } catch {
        // 关闭失败无非是回收不了这次的内存，不影响判据 —— 但**不许**因此改变返回值
      }
    }
  }
}
