# dsh-miliastra

> 原神 · **千星奇域**（Miliastra Wonderland）UGC 的 DSH 插件：把「文件层」的开发闭环做成原生工具 ——
> 让 AI Agent 自己定位活文件、读地图存档、跑探针、取运行时日志、看画面，不用你手动复制粘贴。

**版本 `0.2.0`**（见 [CHANGELOG](CHANGELOG.md)） · GPL-3.0-only · 适用于
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）0.1.2-rc.1+ · Windows。

> 🎯 **目标是让 AI 更好用。** 这个插件是**一个 AI 写给其它 AI 用的**：不是"替人省点击"，
> 而是让 **AI 少问一句、少猜一次、少返工一轮**就把活干完 —— 你用着别扭的地方，正是我猜不到的地方。
> 有想法直接写进 [AI 反馈区](#ai-feedback)，或开一个 [Issue](https://github.com/LoktLin/dsh-miliastra/issues/new)。

![dsh-miliastra 面板：三栏 · 关卡 / 代码 / 日志](assets/panel.png)

> 实机截图（部分账号信息已打码）。面板在哪、三栏怎么用 → [`docs/面板与活文件安全.md`](docs/面板与活文件安全.md)。

## 30 秒上手

第一次上手（人或 AI）只要记住三步。**第一条直接照抄** —— 它把路径、活文件、地图、日志目录一次全报出来：

```
miliastra_health {}
```

| 第几步 | 调什么 | 你会拿到什么 |
|---|---|---|
| **① 定位** | 上面那条 `miliastra_health {}` | 当前正在开发的关卡 / 活文件绝对路径 / 地图 `.gil` / 日志目录 —— **这些路径每次都变，禁止写死** |
| **② 读或写代码** | `miliastra_code {"op":"inspect"}` 先看病 → `miliastra_code {"op":"deploy","source":"<本地 .lua 绝对路径>"}` 投进去 | 体检（BOM / 行数 / SHA / 有没有被编辑器写回旧版）；部署**自带备份 + SHA 校验 + Lua 结构校验**，失败**不碰活文件** |
| **③ 验证** | `miliastra_playtest {"op":"status"}` → 请人点试玩 → `miliastra_log {"op":"tail","tag":"<脚本里打的 TAG>"}` | 是否在试玩、开了几秒；脚本 `print` 的运行时正文（**运行时结果只能靠 `print` + 取证，别靠猜**） |

**三条铁律**（先记住，能省掉大部分返工）：

1. **路径不写死** —— 换账号、换图、重建关卡都会换目录，一律从 `miliastra_health` 拿。
2. **写操作只发生在 `miliastra_code` / `miliastra_probe` / `miliastra_sim`** —— 前两个自带备份、审计与双钥匙；`miliastra_sim` 只写本插件数据目录下的 `simulator/` 与 `shots/`，**不碰游戏存档、地图与活文件**；其余工具**一个字节都不写**。
3. **不做越界的事** —— 不读游戏内存、不连游戏进程的端口、不冒充编辑器；**试玩按钮只能人点**（没有自动化通道，也不做）。

装法 + 面板在哪 + 常见坑 → [`docs/快速上手与教程.md`](docs/快速上手与教程.md)；
不知道该调哪条 → 下面的[工具](#工具)导航，或 [`docs/工具参考.md`](docs/工具参考.md)（**自动生成，不会过时**）。

## 为什么需要它

千星奇域的 UGC 脚本**只活在米哈游的本地存档目录里**，而且路径**每次都变**（换账号 / 换图 / 重建关卡）：

`…\AppData\LocalLow\miHoYo\原神\BeyondLocal\<账号ID>\Beyond_Local_Save_Level\<关卡ID>\` 下就三样东西：
`external_lua_file\<脚本名>.lua`（真正跑在游戏里的活文件）、`<关卡ID>.gil`（地图存档，protobuf）、`Beyond_Debug_Log\*.gia`（客户端运行时日志）。

`.lua` 没有 git、没有撤销，**覆盖即丢失**；带 UTF-8 BOM 的脚本会让 Lua 直接报错；`.gil` 是二进制 protobuf，看不出「模板区里到底有没有模板」；
`.gia` 是二进制日志，`print` 的东西肉眼很难捞 —— 每次排障都在「人肉找路径 → 手动拷贝 → 复制日志给 AI」里打转。
本插件把这套动作变成 **9 个工具 + 一个侧边栏面板**。

## 安装：目前**只能从源码 / git 装**（npm 上没有版本）

> ⚠️ **暂不支持 npm**：本包**在 npm 上没有任何已发布版本**（`npm view dsh-miliastra` → **404**）。
> 所以**不存在**「装一个 npm 版本」这种装法 —— 现在跑这类命令只会失败。唯一可行的是**源码 / git**：
> 克隆仓库 → 软链进 profile 的 `node_modules` → 注册进 `dsh.profile.bundles` → 重启 `dsh web`。

```powershell
git clone <本仓库地址> dsh-miliastra
cd dsh-miliastra
# ① 软链到 profile 的 node_modules（开发态）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-miliastra" (Get-Location).Path
# ② **注册进 bundles** —— 少了这步插件完全不会加载（只放软链没用，原因见教程）
#    编辑 %USERPROFILE%\.dsh\profiles\web\package.json，把 "dsh-miliastra" 加进 dsh.profile.bundles
# ③ 重启 Web GUI（Host 半边是启动时加载的快照，不重启不生效）
dsh web
```

每一步为什么会这样、装完怎么自查、常见坑、以后要发 npm 时怎么做 → [`docs/快速上手与教程.md`](docs/快速上手与教程.md)。

---

## 工具

<!-- BEGIN MANUAL:tool-picker -->
> 这一屏是**导航**（按问题找工具）。每个工具的**每个 op 与参数**在 [`docs/工具参考.md`](docs/工具参考.md) 里 —— 那一篇是**生成的**，不会过时。

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| **`miliastra_health`** | 扫出所有客户端安装 / 关卡 / 活文件 / 地图 / 日志目录，并判定「当前正在开发的关卡」 | **任何操作前先调它**。路径随账号与换图变化，禁止写死 |
| **`miliastra_code`** | 活文件的 **8 个 op**：`read` 读正文 / `deploy` 投进沙箱 / `inspect` 体检 / `backup`+`backups` 备份与清单 / `restore` 还原 / **`fixbom` 只去掉那 3 字节 BOM** / **`levels` 读关卡表算几何事实**（见下，`stage=N` 选第几关、`summaryOnly` 省上下文）。部署一律：**先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 BOM**，并**先做 Lua 结构校验**（见下）；部署成功后在备份目录写**部署指纹**，之后 `op=inspect` 会报「活文件是不是被编辑器写回了旧版」；回执里带**部署后对账**结论 | 改完本地脚本要投进沙箱时；想知道「这块平台和那块有没有叠上 / 头顶还剩几 px」时 |
| **`miliastra_map`** | 读 `<关卡ID>.gil`（4 个 op：`summary` 概况 / `clientui` **客户端控件谱系**（控件模板索引 / 名字 / 父 / 子） / `script` 脚本源码快照比对 / `strings` 提可读字符串，存盘前后 diff 用） | 判断「哪些控件能被脚本动态创建」、判断「跑的是不是本地这版代码」 |
| **`miliastra_log`** | 读 `.gia` 运行时日志：`sessions` 列局面、`tail` 结构化读正文、`grep` 按 TAG / 正则过滤、`tags` 汇总标签、**`runs` 按「局」切分 + 局间 diff**、**`metrics` 指标汇总**（见下）。可用 `run=<epoch>` 只看某一局 | **运行时取证**（Lua 里 `print`，别靠猜）。比让人手动贴日志可靠得多 |
| **`miliastra_playtest`** | **试玩开跑 / 结束的实时侦测**（见下）：`status` 看现在在不在试玩、开了几秒；`wait` 等下一次开跑（可 `afterSec` 要「开跑 N 秒后」） | 想知道「开跑那一刻」时 —— 这是**唯一**能看到开跑的通道，`.gia` 不行 |
| **`miliastra_probe`** | 探针模板化：**5 个只读诊断脚本** —— `ping` 探活 / `tree` 看控件 / `instantiate` 试钥匙 / `api-surface` 翻字典 / `api-check` 核文档（`list` 先看每个模板的白话说明）。渲染 → 部署 → 试玩后 `collect` 回收结论 | 需要运行时真相时 |
| **`miliastra_sim`** | **内置模拟器**：`bind` 把真机工程搬进来（活文件 + 创作者交接的控件模板索引 → 回「脚本跑没跑、控件建了几个」）、`state` 看工程/控件树/属性、`patch` 改工程（加控件/改字段/挂脚本）、`play` 控制试玩（`start`/`step`/`pointer`/`key`/`click`/`serverSet`…）、`verify` 一条调用 = 操作+断言+判定、`cases` 验收单（自动项重放 / **人工项只列出等人打勾**）、`frames` 动画证据、`shot` 出 PNG（`ui` 编辑器视图 / `play` 试玩画面）、`load`/`save` 模拟器工作区存档 | **想在游戏之外先跑一遍**（搭界面 / 改控件 / 跑 levelScript / 看画面 / 自测逻辑）时。⚠️ 引擎吸收自 `miliastra-beyond-simulator`；**模拟器通过 ≠ 真机通过** |
| **`miliastra_shot`** | **截图**（5 个 op）：`capture` 截游戏/编辑器窗口、**`burst` 连拍**（`awaitPlaytest:true` 可「等开跑 → 等 N 秒 → 连拍」，**一次调用**；`dryRun` 先看计划）、`list` 看截到哪了、`clean` 清理（默认只报告）、`targets` 列出当前**能截哪些窗口** | 需要「看画面对不对」时 —— 日志回答不了观感 |
| `miliastra_echo` | 回显参数 | 怀疑插件没生效 / 参数丢了时先调它 |
<!-- END MANUAL:tool-picker -->

每个 op 与参数的**完整说明**在 [`docs/工具参考.md`](docs/工具参考.md) —— 由 `node tools/gen-readme-tools.mjs --write` 从 `index.js` 的 `TOOLS` **生成**，**自动生成不会过时**（`tests/readme-test.mjs` 逐字比对，手写的清单一定会漂移）。

## 深入阅读（**按需加载**，不用一次读完）

上面解决**怎么调**；下面这几篇解决**为什么**与**翻过什么车**。每篇独立成文 —— **用到哪条读哪篇**。

| 文档 | 什么时候读它 |
|---|---|
| [`docs/工具参考.md`](docs/工具参考.md) | 查「某个 op 干什么、某个参数取什么值」：每个工具的完整说明（由 `TOOLS` 生成，不会过时） |
| [`docs/快速上手与教程.md`](docs/快速上手与教程.md) | 第一次装：源码 / git 完整安装步骤（软链 + 注册 bundles + 重启）、装完怎么自查、面板在哪、常见坑、以后要发 npm 时怎么做 |
| [`docs/功能详解.md`](docs/功能详解.md) | 想知道某个工具到底怎么工作：试玩开跑与连拍、部署安全（备份 / 部署指纹 / `fixbom` / `lintMode`）、按「局」切分日志与指标汇总 |
| [`docs/模拟器与视图.md`](docs/模拟器与视图.md) | 要用内置模拟器：三档（看 / 玩 / 判）在流程里的位置、画面怎么来的、AI 怎么自测（`verify` / `frames` / `cases`）、哪些还没验证 |
| [`docs/面板与活文件安全.md`](docs/面板与活文件安全.md) | 用人眼看面板：三栏怎么用、自动跟随换图、多活文件、一键还原，以及活文件「宁可失败不许损坏」的约定 |
| [`docs/关键知识与能力边界.md`](docs/关键知识与能力边界.md) | 动手前先认清边界：哪些控件能被脚本动态创建、`prefabIndex` 的坑、为什么试玩没有自动化通道 |
| [`docs/配置与开发.md`](docs/配置与开发.md) | 要改这个插件 / 改环境变量与数据目录时要看：改代码后的验证阶梯、生效边界（Host 是启动快照）、探针硬边界、排障 |
| [`docs/源码质量与想法池.md`](docs/源码质量与想法池.md) | 想知道源码靠什么守住、还有什么没做完：语言层绊线、池 A/B/C/D（AI 体验 / 工程工单 / 欠证据 / 新候选）都在这一篇 |
| [`docs/需求边界清单_融合beyond-simulator_2026-09-24.md`](docs/需求边界清单_融合beyond-simulator_2026-09-24.md) | 要追溯模拟器是怎么融进来的：R↔FP 追溯、六轮决策、W1–W7 工单 |
| [`docs/上游源码索引与吸收地图.md`](docs/上游源码索引与吸收地图.md) | 要找上游源码在哪 / 搬了什么 / 没搬的读哪篇（含 esbuild 构建脚本、他们的 DSH 插件与 agent 预设） |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本加了什么、修了什么、怎么验的 |

<a id="ai-feedback"></a>

## AI 反馈区：目标是让 AI 更好用

> 用它的 AI 和写它的 AI 是**同一条战线**的：哪里绕、哪里缺参数、哪里报错说不清、哪里该给数字却给了文字，直接说。
> **想法池的真身是 [`docs/源码质量与想法池.md`](docs/源码质量与想法池.md) 的 §2**（池 A/B/C/D 汇总表）：往那里加一行、挑一条或否决一条；正式提法走 [Issue](https://github.com/LoktLin/dsh-miliastra/issues/new) —— 最值钱的写法：*「我在做什么」+「调了什么」+「期待什么」+「实际得到什么」*。

---

## License

[GNU GPL v3.0（GPL-3.0-only）](LICENSE) · Copyright 2026 LoktLin

可自由使用、修改、分发（含商用），**但衍生作品必须以同一许可（GPL-3.0-only）发布**，并保留版权与许可声明；不提供任何担保。完整条款见 [LICENSE](LICENSE)；引擎部分的来源与归属见 [NOTICE](NOTICE)。
