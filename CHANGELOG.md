# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1] — 2026-09-23

首个版本。整套工具链不是设计出来的，是**在原神·千星奇域 7.1 正式服上排一次真实的 bug 排出来的** ——
那次「`game.InstantiateClientUIControl` 对任何索引号都返回 `nil`」折腾了好几小时，
最后定位到「客户端控件模板库为空」。踩过的坑都固化成了工具能力与 README 的「关键知识」。

### Host 半边 · 6 个工具

- **`miliastra_health`** 环境体检：客户端安装 / 关卡 / 活文件 / 地图 / 日志目录定位。
  **两种关卡布局都扫**（`<id>\<id>.gil` 与根目录的 `<id>.gil` —— 只扫前者会漏掉大部分图）。
  另含**编辑器 / 游戏进程状态**（`BeyondEditor.exe` / `YuanShen.exe`，10 秒缓存、best-effort 不抛）。
- **`miliastra_code`** 活文件：`inspect` / `read` / `deploy` / `backup` / `backups` / `restore`。
  部署一律 **先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM**，任一不满足直接拒绝。
- **`miliastra_map`** 读 `.gil`（protobuf）：`summary` / `clientui` / `script` / `strings`。
  `clientui` 给出**客户端控件谱系 + 可被脚本动态创建的模板清单**；`script` 给出**地图快照 vs 活文件的一致性**。
- **`miliastra_log`** 读 `.gia` 运行时日志：`sessions` / `tail` / `grep` / `tags`，结构化到
  `{时间, 账号, 玩家, 关卡, 正文}`。
- **`miliastra_probe`** 探针模板化：`tree` / `instantiate` / `ping`，`render` → `deploy` → `collect`。
- **`miliastra_echo`** 回显参数，用来确认参数真的传到了 Host。

另外：

- **同源 HTTP 路由** `/miliastra/{status,tools,tool}`，给面板取数据（唯一合法通道）。
  带**本机访问守卫**（非 `127.0.0.1`/`localhost` 一律 403）、未知路由回 404、`Cache-Control: no-store`。
- **系统提示段**：让 agent 知道「有这么个插件、什么时候该用它」，而不是去拼 PowerShell。
- **`/status` 的 `clientHalf` 自检**：查询宿主 `dsh-client-modules` 的 boot 图，
  直接回答「面板 bundle 有没有进 `window.__DSH_BOOT__`」——
  把原先「只能靠人眼看面板出没出来」这件事变成可断言的数据。

### Client 半边 · 侧边栏面板

- 注册到**官方槽位** `sidebar.footer.action`（不是 DOM 注入）
- **三栏**布局（参考蛋仔面板）：① 关卡 / ② 代码 / ③ 日志，每栏独立滚动
- 粉蓝配色；入口图标内联 PNG（像素画，`image-rendering: pixelated`）
- **关卡切换 + 自动跟随**：默认跟着 `miliastra_health` 判定的「当前关卡」走
  （作者在编辑器里换图，面板自己切过去）；点某一关就切成手动锁定，一键回自动
- **进程状态**：免截图看编辑器 / 游戏在不在跑（实测进程名 `BeyondEditor.exe` / `YuanShen.exe`，
  编辑器是**独立进程**不是游戏子进程），并给出「能否试玩」判断（两者都在才行）
- **多活文件支持**：一个关卡可以有多个 `.lua`（不同角色各一个），选择器切换，所有操作跟着走
- **活文件体检**：大小 / 行数 / SHA-256 / **是否带 BOM** / 编码是否合法 / 有无中文注释
- **脚本一致性**：地图里嵌的脚本快照 vs 本地活文件 —— 回答「跑的是不是本地这版代码」
- **备份清单 + 逐条还原**，还原带二次确认与「还原前安全备份」；份数过多只提醒、不自动删
- **探针一键**：选模板（`ping`/`tree`/`instantiate`）→ 部署（**覆盖活文件，带二次确认与自动备份**）
  → 重新试玩 → 「收回结论」直接从最新一局日志里捞该 tag 的输出
- **历史局面**：列出最近 12 局 `.gia`，点某一局只看那一局
- 日志 TAG 汇总 / 按 TAG 过滤（点胶囊即过滤）
- **诊断日志三连**（刻意保留）：`factory 已执行` / `apply 运行中` / `入口已注册` ——
  client 半边失败默认是**全静默**的，这三行让排障一眼定位卡在哪一步

### 修掉的真实缺陷

- **`exports.inject` 没声明 `slots`** → cordis 的服务代理直接抛
  `cannot get property "slots" without inject`，**整条 loader entry 失败**。
  症状最难看：宿主报 `failed to apply loader entry`，而页面上**一条我们的日志都没有**。
  更坑的是当时把诊断日志写在了 `try` 外面 —— 一行探针把整个插件打死了。
- **Client 的 `callTool` 少剥一层信封** → 面板上「本机存档 —」「关卡数 undefined」全是空的。
  信封是三层 `body{ok,data:{name,ok,data:<业务返回体>}}`，这个错**犯了两次**
  （一次在 `live-check.mjs`、一次在面板里）。现在剥离逻辑抽成独立函数并加了回归测试。
- **关卡扫描盲区**：`Beyond_Local_Save_Level` 下有两种布局，只扫带文件夹的那种会**漏掉大部分图**
  （实测 8 个只看见 3 个；修复后 18 个）。
- **`MILIASTRA_LOCALLOW` 写错会静默回退到真实存档根** —— 手滑就会去动真文件。改成「显式指定就照做，指错就明确报错」。
- **备份同秒撞名**：时间戳只到秒，同一秒连部署两次会覆盖前一份备份。改为自动顺延 `-2 / -3`。
- **探针漏 `script:EnableUpdate(true)`** → `OnUpdate` 永不触发，游戏里只打
  `OnInit`/`OnEnable`/`OnStart` 三行空壳。探针模板已内建这行。
- **解析 5 字节 varint 只解 4 字节**，漏掉整整一段 ID 区间（工具早期版本）。

### 部署前的 Lua 结构校验（`lib/lualint.mjs`）

**一段语法错的 Lua 投进沙箱，试玩会静默不生效** —— 脚本根本没起来，日志里只会是「什么都没有」，
这比报错难查得多。所以 `miliastra_code op=deploy` 与 `miliastra_probe op=deploy` 默认先扫一遍结构：

- `lintMode: 'strict'`（默认）—— 缺 `end` / 括号不配平 / 字符串或长注释没闭合 / `repeat` 少了 `until`
  → **拒绝部署，且不碰活文件、不产生备份**
- `lintMode: 'warn'` —— 照投，但问题进 `warnings[]`，不静默吞掉
- `lintMode: 'off'` —— 不校验（逃生舱）；未知取值明确报错，**不静默降级成 off**

零依赖的结构级启发式（不是完整 Lua 解析器）：先严格剥注释与字符串（含 `--[[ ]]` / `[==[ ]==]`），
再统计块开闭与括号配对，报的是**「第 N 行的 function 没有对应的 end」**而不是「文件最后一行」。

- **`miliastra_probe` 新增 `api-surface` 模板**：把 `_G` / `Enum` / `game` / `script` / 元表逐个枚举打出来，
  并对 `KeyEventType` / `KeyboardKeyCode` / `ControllerKeyCode` 逐个实测取值 ——
  用来终结「按键枚举到底是哪张表」这种靠猜的活（模板上线前被结构校验抓出一个 `if … end else … end` 的语法错，
  那种错**投进去就是整段静默失效**）。

### 开发小工具（`tools/`，不随包发布）

- `tools/lint-probes.mjs` —— 把每个探针模板渲染出来逐个结构校验，出错打印上下文行
- `tools/lint-all.mjs <目录>` —— 对整个目录的 `.lua` 跑结构校验

### 修掉的真实缺陷（续）

- **结构校验器把换行丢了** → 「行尾标识符 + 下一行行首词」粘成一个标识符
  （`local sx, sy` 换行接 `local` → `sylocal`），**行首的 `end` 被吞进上一行尾巴**。
  症状极具迷惑性：**真文件恒报「缺 29 个 end」，而单行小样例全绿**。
  逐行拆 token 才抓到（`L130:sylocal`）。现在换行占位保留，`tests/lualint-test.mjs` 有 4 条回归断言盯它。
- **缺 `end` 时报的是「文件最后一行」**，对排障几乎没用。改为记开块栈，报**最内层没关上的那个块**的行号。
- **`api-surface` 模板里的语法错**（`if … then … end else … end`）—— 由新加的模板结构校验抓出。

### 工程 / 仓库

- 许可证 **Apache-2.0**；`LICENSE` / `CHANGELOG.md` / `.gitattributes`（统一 LF）/ `.gitignore`
- `files` 白名单（`private` 已移除，npm 可直接发布）；`prepublishOnly: npm test` —— **测试不过发不出去**
- README 含实机截图 `assets/panel.png`（已加进 `files`，否则 npm 详情页是裂图）
- 仓库 <https://github.com/LoktLin/dsh-miliastra>

### 已验证

| 层 | 结果 |
|---|---|
| L1 工具层（`tests/smoke.mjs`） | 22 项 |
| L1 部署与备份 / `lintMode` 三档（`tests/deploy-test.mjs`） | 17 项 |
| L1 探针部署 / 多活文件 / 关卡布局 / 模板结构（`tests/probe-deploy-test.mjs`） | 10 项 |
| L1 Lua 结构校验器 / 15 个真文件回归（`tests/lualint-test.mjs`） | 32 项 |
| L3 真实 React 渲染 + 整面板空状态 SSR（`tests/client-render-test.mjs`） | 15 项 |
| L1 技能契约自检（`dsh-plugin-dev` 的 `selftest.mjs`） | 16 项 |
| **L4 真机**（`tests/live-check.mjs`，对着运行中的 dsh web） | 9 项 |

合计 **121 项**（含自检 16 项）。契约取证自本机 **`dsh 0.1.5-rc.1`**。

其中 L4 的 9 项里有一条值得单独说：**`clientHalf` 断言** ——
它查宿主 `dsh-client-modules` 的 boot 图，机器证明「面板 bundle 已进 `window.__DSH_BOOT__`」
（实测 `dsh-miliastra  63.0 KB  rev=33316704`）。**这一格以前只能靠人眼看面板出没出来。**

### 已知边界

- **编辑器 UI 操作没有自动化通道**：在「客户端控件模板」里点【添加客户端控件】、给容器节点挂脚本、
  建容器节点 —— 这些必须由人在编辑器里完成。本插件替代的是「人和 AI 之间的来回搬运」，不是编辑器操作本身。
- **不做场景写操作**：工具只读，或只写「活文件」（脚本本身），不碰地图数据。
- **负载 / 节点图统计尚未实现**：官方文档确认「负载计算」是编辑器 UI 功能（静态菜单 + 动态试玩报告），
  「节点图」数据虽在 `.gil` 里有痕迹但字段结构尚未逆出。已记录为后续课题。
- **`patchReload: live` 不会重新 import Host 模块**（实测：改 `cordis.patch.yml` 触发重载后
  `/miliastra/status` 仍返回旧字段）—— 所以 **Host 改动一定要重启 `dsh web`**，
  只有 `lib/client.js` 刷新页面即可。
