# dsh-miliastra

[中文](#30-秒上手不用读完全文) | [English](#english-overview)

> 原神 · **千星奇域**（Miliastra Wonderland）UGC 的 DSH 插件：把「文件层」的开发闭环做成原生工具，
> 让 AI Agent 能自己定位活文件、读地图配置、跑探针、取运行时日志 —— 不用你手动复制粘贴。

**版本 `0.1.0`**（见 [CHANGELOG](CHANGELOG.md)） · GPL-3.0-only
适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）0.1.2-rc.1+ · Windows。

> 这套工具链是**在正式服上排一次真实的 bug 排出来的**（「动态创建控件恒返回 nil」→ 根因是模板库为空），
> 踩过的坑都固化成了工具能力与下面的「关键知识」。

![dsh-miliastra 面板：三栏 · 关卡 / 代码 / 日志](assets/panel.png)

> 上图为实机截图（部分账号信息已打码）。三栏分工：
> **① 关卡**（自动跟随换图 · 进程状态 · 地图体检）／
> **② 代码**（活文件选择与体检 · 脚本一致性 · 备份还原 · 部署）／
> **③ 日志**（历史日志 · TAG 汇总 · 试玩完自动取回 · 可折叠的「高级诊断」：读界面控件 / 探针）。

---

## 30 秒上手（**不用读完全文**）

哪怕你第一次见到这个插件、只知道「原神千星奇域的脚本在本地某个目录里」，按这三步就能干活：

| 第几步 | 调什么 | 你会拿到什么 |
|---|---|---|
| **① 定位** | `miliastra_health {}` | 当前正在开发的关卡 / 活文件绝对路径 / 地图 `.gil` / 日志目录 —— **这些路径每次都变，禁止写死** |
| **② 读或写代码** | `miliastra_code {"op":"inspect"}` 先看病 → `miliastra_code {"op":"deploy","source":"<本地 .lua 绝对路径>"}` 投进去 | 体检（BOM / 行数 / SHA / 有没有被编辑器写回旧版）；部署**自带备份 + SHA 校验 + Lua 结构校验**，失败**不碰活文件** |
| **③ 验证** | `miliastra_playtest {"op":"status"}` → 请人点试玩 → `miliastra_log {"op":"tail","tag":"<脚本里打的 TAG>"}` | 是否在试玩 / 开了几秒；脚本 `print` 的运行时正文（**运行时结果只能靠 `print` + 取证，别靠猜**） |

**三条铁律**（先记住，能省掉大部分返工）：

1. **路径不写死** —— 换账号、换图、重建关卡都会换目录，一律从 `miliastra_health` 拿。
2. **写操作只发生在 `miliastra_code` / `miliastra_probe` / `miliastra_sim`** —— 前两个自带备份、审计与双钥匙；
   `miliastra_sim` 只写**本插件数据目录**下的 `simulator/`（工程存档）与 `shots/`（PNG），**不碰游戏存档、地图与活文件**；其余工具**一个字节都不写**。
3. **不做越界的事** —— 不读游戏内存、不连游戏进程的端口、不冒充编辑器；**试玩按钮只能人点**（没有自动化通道，也不做）。

> 不知道自己该调哪条 → 看下一节的「[工具](#工具)」表（一屏导航），
> 或者直接翻「[工具速查](#每个工具的完整说明自动生成别手改)」（每个工具的每个 op 与参数，**自动生成，不会过时**）。

---

## English overview

> **In one sentence**: `dsh-miliastra` turns the file-level loop of *Miliastra Wonderland*
> (Genshin Impact UGC) into native DSH tools — locate the live `levelScript`/client script, deploy it
> safely, read the map archive and runtime logs, take screenshots, and run probes — so an AI agent
> can debug a UGC level without you copy-pasting files and logs.
> **9 tools + a sidebar panel**, GPL-3.0-only (engine partly derived from miliastra-beyond-simulator — see NOTICE), Windows, DSH `0.1.2-rc.1+`.
> The Chinese sections above/below are the full manual; this page is the one-screen entry point.

**30-second quick start**

| Step | Call | What you get |
|---|---|---|
| **① Locate** | `miliastra_health {}` | current level, absolute path of the live `.lua`, map `.gil`, log directory — **paths change; never hardcode them** |
| **② Read / write code** | `miliastra_code {"op":"inspect"}` → `miliastra_code {"op":"deploy","source":"<absolute path to your .lua>"}` | health check (BOM / line count / SHA / whether the editor wrote back an older version); deploy **always backs up first, verifies SHA-256, and lints the Lua structure — a failure never touches the live file** |
| **③ Verify** | `miliastra_playtest {"op":"status"}` → have a human click Playtest → `miliastra_log {"op":"tail","tag":"<your TAG>"}` | whether a playtest is running and for how long; the runtime text your script `print`ed (**runtime truth comes from `print` + evidence, never from guessing**) |

**The 8 tools, one line each**

| Tool | What it is for |
|---|---|
| **`miliastra_health`** | Where is everything? Scans all installs / levels / live files / maps / log dirs. **Call this first** |
| **`miliastra_code`** | The only place that writes: read / deploy / inspect / backup / restore / `fixbom` / `levels` (level-table geometry facts) |
| **`miliastra_map`** | Read `<level>.gil`: client-UI control hierarchy (which controls a script can instantiate) + script source snapshot |
| **`miliastra_log`** | Read `.gia` runtime logs: sessions / tail / grep / tags / **`runs`** (split by run + diff) / **`metrics`** (distributions) |
| **`miliastra_playtest`** | **Live** start/end detection from `output_log.txt` (measured 0.07–0.18 s). The only channel that sees the moment a run starts — `.gia` is written only after a run ends |
| **`miliastra_shot`** | Screenshots: `capture` / **`burst`** (one call: wait for start → wait N s → shoot N frames) / `list` / `clean` / `targets` |
| **`miliastra_probe`** | 5 read-only diagnostic templates (`ping` / `tree` / `instantiate` / `api-surface` / `api-check`): deploy → playtest → `collect` |
| **`miliastra_sim`** | **Built-in simulator**: `state` / `patch` (build controls, set fields, mount scripts) / `play` (`start`/`step`/`pointer`/`key`/`click`/`serverSet`…) / `shot` (PNG of the editor view or the running play scene) / `load`+`save`. Runs Lua outside the game — **passing the simulator is not passing on device** |
| **`miliastra_echo`** | Echoes its arguments, to rule out "the plugin isn't loaded / the argument was dropped" |

> **Full parameter reference** (every op, every argument, defaults and allowed values) is the
> **generated** block under [工具](#工具) → **每个工具的完整说明**: it is rendered from the tool schema
> itself and compared byte-for-byte by `tests/readme-test.mjs`, so it cannot go stale. It is in Chinese
> because that is the text the model receives in the schema.

**Install**

```powershell
# ① symlink the package into the web profile's node_modules
# ② register it in bundles — without this the plugin is not loaded at all:
#    edit %USERPROFILE%\.dsh\profiles\web\package.json and add "dsh-miliastra" to dsh.profile.bundles
# ③ restart the Web GUI (`dsh web`)
```

> ⚠️ The **Host half (tools / routes / system prompt) is a snapshot taken at startup** — changing it
> requires restarting `dsh web`; changing only `lib/client.js` (the panel) needs a page refresh.
> The repo **hardcodes no absolute paths** (the save root is derived from `os.homedir()`,
> overridable with `MILIASTRA_LOCALLOW`).

**Ground rules**

1. **Never hardcode paths** — they change with account / level / map.
2. **Only `miliastra_code`, `miliastra_probe` and `miliastra_sim` write to disk**; the first two back up first and use
   double-key confirmations for destructive actions. `miliastra_sim` writes only inside the plugin data directory
   (`simulator/` archives, `shots/` PNGs) — never to game saves, maps or live script files. Every other tool writes nothing.
3. **Nothing out of bounds** — no reading game memory, no connecting to game process ports, no
   impersonating the editor. **Playtest can only be clicked by a human** (there is no automation channel,
   and we do not build one).
4. **Numbers, not verdicts** — geometry and metric tools report overlap px, headroom px, distributions;
   whether a level is "fine" is the creator's call, never the tool's.

---

## 文档索引

| 文档 | 位置 | 内容 |
|---|---|---|
| 本文件 | 本仓库 `README.md` | 装 / 用 / 关键知识 / 能力边界 |
| 变更记录 | 本仓库 [`CHANGELOG.md`](CHANGELOG.md) | 每个版本加了什么、修了什么、怎么验的 |
| 发布说明 | 本仓库 [`.github/release-notes/`](.github/release-notes/) | 每个版本的 Release 文案（**中英双语**）+ 发版五步清单 |
| 许可 | 本仓库 [`LICENSE`](LICENSE) ｜ [`NOTICE`](NOTICE) | GPL-3.0-only（引擎部分吸收自 miliastra-beyond-simulator，来源与归属见 NOTICE） |

**配套的离线知识库不在本仓库里**（内容是官方文档的抽取产物，版权归米哈游；
本仓库只放可发布的代码）。它们在工作区的 `docs/` 与 `tools/` 下：

| 产物 | 从哪来 | 有什么用 |
|---|---|---|
| `docs/千星奇域_API参考.md` | `tools/extract-api-reference.mjs` | 153 个接口 + 27 张枚举表（官方原文是整页压成一行的 35KB，翻不到） |
| `docs/千星奇域_按键事件枚举对照表.md` | `tools/extract-key-enums.mjs` | 按键真名与默认物理键（`KeyboardMoveLeftKeyDown` = A …） |
| `docs/千星奇域_补间动画.md` | `tools/extract-api-reference.mjs` | `Tween` / `TweenSequence` / 31 条缓动曲线 |

> 官方文档更新后重跑抽取脚本即可刷新，**不要手改产物**。

---

## 为什么需要它

千星奇域的 UGC 脚本**只活在米哈游的本地存档目录里**：

```
%USERPROFILE%\AppData\LocalLow\miHoYo\原神\BeyondLocal\<账号ID>\
  Beyond_Local_Save_Level\<关卡ID>\external_lua_file\<脚本名>.lua   ← 真正跑在游戏里的
  Beyond_Local_Save_Level\<关卡ID>\<关卡ID>.gil                    ← 地图存档（protobuf）
  Beyond_Debug_Log\<日期_时间>_<pid>_<账号ID>.gia                   ← 客户端运行时日志
```

这些路径**每次都变**（换账号、换图、重建关卡都会变），而且：

- `.lua` 没有 git、没有撤销，**覆盖即丢失**；
- 带 UTF-8 BOM 的脚本会让 Lua 直接报错；
- `.gil` 是二进制 protobuf，靠眼睛看不出「模板区里到底有没有模板」；
- `.gia` 是二进制日志，`print` 出来的东西肉眼很难捞。

结果就是每次排障都在「人肉找路径 → 手动拷贝 → 复制日志给 AI」里打转。
本插件把这套动作变成 **8 个工具 + 一个侧边栏面板**。

---

## 安装（固定方式：从源码目录装）

**只有这一种安装方式**：把仓库克隆下来，软链进 profile，注册进 bundles。
改代码**立即生效**，适合开发与自用 —— npm 发布**暂缓**（要发的话见文末「发布到 npm（暂缓）」）。

```powershell
git clone <本仓库地址> dsh-miliastra
cd dsh-miliastra

# ① 软链到 profile 的 node_modules（开发态）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-miliastra" (Get-Location).Path

# ② **注册进 bundles** —— 少了这步插件完全不会加载（原因见下面那条警告）
#    编辑 %USERPROFILE%\.dsh\profiles\web\package.json，把 "dsh-miliastra" 加进 dsh.profile.bundles

# ③ 重启 Web GUI
dsh web     # Host 半边是启动时加载的快照，不重启不生效
```

> ⚠️ **只放软链不会让插件被装配**：启动期不扫描 `node_modules`，装配来源只有 profile 的 `dsh.profile.bundles`
> （或 profile `cordis.patch.yml` 里显式 insert 一行）。这条错了的表现是**完全静默**：文件都在、什么也没发生。
>
> ⚠️ 本机 pnpm 是 `nodeLinker: hoisted`，手搓的软链不在 profile 的 `dependencies` 里，
> **下一次 `dsh plugin add/install` 会把它清掉** —— 所以它是「自用/开发」方式，不是交付方式。

---

## 发布到 npm（**暂缓**，后面再说）

> **现在固定走上面的「从源码目录装」，不发 npm。** 这一节留在这里只是为了以后要发时不用重新调研 ——
> 内容都实测过（`npm pack --dry-run` 验过 `files` 字段、验过 `dsh.bundle.patch` 会被认）。

```powershell
npm login                                   # 浏览器 / 2FA；没账号先到 npmjs.com 注册并验证邮箱
npm publish --dry-run                       # 先看会发什么（不真发）
npm publish                                 # 真发；开了 2FA 时加 --otp=123456
npm view dsh-miliastra version              # 验证：打印版本号即成功
```

发布之后，别人就用一条命令装（会自动写进 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile web add dsh-miliastra@0.1.0   # 声明了 dsh.bundle.patch，会自动进 dsh.profile.bundles
dsh web
```

**发布前请确认：**

- `private` **必须是 false 或不存在** —— 写了 `"private": true` 时 npm 会直接拒绝
- `files` 是**白名单**：没列进去的文件不会进包（`CHANGELOG.md` 就是后补进去的）
- `license` 与仓库里的 `LICENSE` 一致
- `repository` / `homepage` / `bugs` 指向真实地址
- registry 指向**官方源**（`npm config get registry` 应是 `https://registry.npmjs.org/`；
  指向淘宝等镜像时发布必失败）
- `prepublishOnly` 会自动跑测试 —— 本项目配置为 `npm test`（4 套测试，不过就发不出去）

**三条不可逆的注意点：**

1. **同名同版本不能重发** —— 改完要 `npm version patch`（→ `0.0.2`）再发
2. **72 小时内**可以 `npm unpublish`，超过就再也撤不回来了
3. 包名是**全局唯一**的，先占先得

---

## 工具

<!-- BEGIN MANUAL:tool-picker -->
> 这一屏是**导航**（按问题找工具）。每个工具的**每个 op 与参数**在下面「完整说明」里 —— 那一节是**生成的**，不会过时。

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| **`miliastra_health`** | 扫出所有客户端安装 / 关卡 / 活文件 / 地图 / 日志目录，并判定「当前正在开发的关卡」 | **任何操作前先调它**。路径随账号与换图变化，禁止写死 |
| **`miliastra_code`** | 活文件的 **8 个 op**：`read` 读正文 / `deploy` 投进沙箱 / `inspect` 体检 / `backup`+`backups` 备份与清单 / `restore` 还原 / **`fixbom` 只去掉那 3 字节 BOM** / **`levels` 读关卡表算几何事实**（见下，`stage=N` 选第几关、`summaryOnly` 省上下文）。部署一律：**先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 BOM**，并**先做 Lua 结构校验**（见下）；部署成功后在备份目录写**部署指纹**，之后 `op=inspect` 会报「活文件是不是被编辑器写回了旧版」；回执里带**部署后对账**结论 | 改完本地脚本要投进沙箱时；想知道「这块平台和那块有没有叠上 / 头顶还剩几 px」时 |
| **`miliastra_map`** | 读 `<关卡ID>.gil`（4 个 op：`summary` 概况 / `clientui` **客户端控件谱系**（控件模板索引 / 名字 / 父 / 子） / `script` 脚本源码快照比对 / `strings` 提可读字符串，存盘前后 diff 用） | 判断「哪些控件能被脚本动态创建」、判断「跑的是不是本地这版代码」 |
| **`miliastra_log`** | 读 `.gia` 运行时日志：`sessions` 列局面、`tail` 结构化读正文、`grep` 按 TAG / 正则过滤、`tags` 汇总标签、**`runs` 按「局」切分 + 局间 diff**、**`metrics` 指标汇总**（见下）。可用 `run=<epoch>` 只看某一局 | **运行时取证**（Lua 里 `print`，别靠猜）。比让人手动贴日志可靠得多 |
| **`miliastra_playtest`** | **试玩开跑 / 结束的实时侦测**（见下）：`status` 看现在在不在试玩、开了几秒；`wait` 等下一次开跑（可 `afterSec` 要「开跑 N 秒后」） | 想知道「开跑那一刻」时 —— 这是**唯一**能看到开跑的通道，`.gia` 不行 |
| **`miliastra_probe`** | 探针模板化：**5 个只读诊断脚本** —— `ping` 探活 / `tree` 看控件 / `instantiate` 试钥匙 / `api-surface` 翻字典 / `api-check` 核文档（`list` 先看每个模板的白话说明）。渲染 → 部署 → 试玩后 `collect` 回收结论 | 需要运行时真相时 |
| **`miliastra_sim`** | **内置模拟器**：`state` 看工程/控件树/属性、`patch` 改工程（加控件/改字段/挂脚本）、`play` 控制试玩（`start`/`step`/`pointer`/`key`/`click`/`serverSet`…）、`shot` 出 PNG（`ui` 编辑器视图 / `play` 试玩画面）、`load`/`save` 模拟器工作区存档 | **想在游戏之外先跑一遍**（搭界面 / 改控件 / 跑 levelScript / 看画面）时。⚠️ 引擎吸收自 `miliastra-beyond-simulator`；**模拟器通过 ≠ 真机通过** |
| **`miliastra_shot`** | **截图**（5 个 op）：`capture` 截游戏/编辑器窗口、**`burst` 连拍**（`awaitPlaytest:true` 可「等开跑 → 等 N 秒 → 连拍」，**一次调用**；`dryRun` 先看计划）、`list` 看截到哪了、`clean` 清理（默认只报告）、`targets` 列出当前**能截哪些窗口** | 需要「看画面对不对」时 —— 日志回答不了观感 |
| `miliastra_echo` | 回显参数 | 怀疑插件没生效 / 参数丢了时先调它 |
<!-- END MANUAL:tool-picker -->

### 每个工具的完整说明（**自动生成**，别手改）

> 下面这段由 `node tools/gen-readme-tools.mjs --write` 从 `index.js` 的 `TOOLS` **生成** ——
> **工具的唯一真身是 schema**，本文件只是它的投影。改了工具（加 op / 加参数 / 改描述）就跑一次生成器：
> `tests/readme-test.mjs` 会**逐字比对**，忘了跑就**红**。
> 所以这一节**不会过时** —— 而手写的清单一定会（实测：本文件第一段曾把版本号停在 `0.0.1`，六次发布没人发现）。

<!-- BEGIN GENERATED:tools -->
> ⚠️ **新工具**（还没进 `ORDER`，已排在最后）：`miliastra_sim`

#### `miliastra_health`

Miliastra Wonderland 工具链：环境体检。**任何时候要操作原神 UGC，先调它。**返回：扫到的客户端安装（正式服/Beta）、所有关卡、当前判定为「正在开发」的关卡、活文件（沙箱 .lua）清单与大小、地图存档 .gil、运行时日志目录与日志文件数。编辑器 UI 操作（建模板/挂脚本）没有自动化通道——本工具只做文件层体检，替代不了人点编辑器。

**典型调用**：`{}`（当前关卡速览）｜`{"all":true}`（全部关卡）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `all` | `boolean` | 否 | `true` / `false` | true=返回全部关卡清单（默认只返回最近 12 个）。 |

#### `miliastra_code`

Miliastra Wonderland 工具链：活文件（沙箱里的 .lua）的读 / 部署 / 体检 / 还原。**部署一律：先备份旧文件 → 二进制拷贝 → 比对 SHA-256 → 校验无 UTF-8 BOM。**（不带 BOM 是硬要求：原神实测会打印 "Read text file with BOM header may cause Lua error"。）op=read 读活文件正文；op=deploy 把 source 指向的本地文件投进沙箱（**覆盖前自动备份**）；**部署前先做 Lua 结构校验**（缺 end / 括号不配平 / 字符串没闭合这类错投进去，试玩会静默不生效、日志里什么都没有 —— 这是最难查的一类失败）；默认 lintMode:"strict" 直接拒绝，确认没问题可 lintMode:"warn" 只提示、"off" 跳过。op=inspect 只体检不改动；op=backups 列出该活文件的全部备份（时间/SHA/是否带 BOM）；op=backup 手动备份一份；op=restore 用它覆盖活文件 —— **backup 可以不传**，不传就用固定名那份 `<原名>.bak`。⚠️ 部署不会热加载正在进行的试玩：要 停试玩 → 部署 → 重开试玩。

**安全约定（写活文件的地方都遵守，别绕过）**：①活文件是**唯一副本**（没有 git、没有撤销），所以**备份失败就中止覆盖**，绝不带着「没有备份」去写；②**原子写**（同目录临时文件 → fsync → rename），断电/崩溃不会留下半截损坏的文件；③写完必校验 SHA，**校验不过自动回滚**到覆盖前那一版；④备份就在**被替换文件的旁边**：`<活文件目录>\_backup\`；⑤每次备份都写**两份** —— 固定名 `<原名>.bak`（还原默认用它）+ 一份带**本地时间**戳的历史（永不自动删）；⑥`noBackup` 必须同时传 `allowNoBackup:true` 才生效（不给随手绕过安全网）；⑦所有写操作都回执 `restoreWith` —— 照着它跑就能还原。

**两条防「静默丢代码」的机制**：· **部署指纹** —— `op=deploy` 成功后会在备份目录写一份 `.miliastra-deploy.json`（记下这一版的 SHA/字节/行数/来源）。之后 `op=inspect` 会比对：活文件与上次部署**不一致**就直说「多半是编辑器把脚本面板里的内存版存回了磁盘」（实测会发生），并给出字节差/行数差 —— 而不是让你以为跑的还是刚投进去那版。· **`op=fixbom`** —— 活文件带 UTF-8 BOM 时**只去掉那 3 个字节**（原神实测会打印 "Read text file with BOM header may cause Lua error"）。BOM 不是本工具加的，实测来自**新建关卡时编辑器自己写的文件**。安全顺序与部署同源：本来没有 BOM 就**什么都不做** → 备份失败即中止 → 原子写 → 校验（只差 3 字节 + 无 BOM + 仍是合法 UTF-8）→ 不过**自动回滚**。

**典型调用**：`{"op":"inspect"}`（体检 + 看有没有被编辑器写回旧版）｜`{"op":"deploy","source":"D:\\code\\双相\\双相_v9.lua"}`（投代码）｜`{"op":"levels","summaryOnly":true}`（先扫全部关卡几何）→ `{"op":"levels","stage":3}`（再钻第 3 关）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `read` / `deploy` / `inspect` / `backups` / `backup` / `restore` / `fixbom` / `levels` | 默认 inspect。 |
| `level` | `string` | 否 | —— | **地图关卡 ID / 品牌**（如 1073741833，选的是**哪张图**；不是玩法里的第几关 —— 那个用 `stage`）；省略=当前关卡。 |
| `file` | `string` | 否 | —— | 指定活文件名（省略=该关卡最近改动的那个 .lua；**探针源码/备份这类附属文件会被自动跳过**）。一个关卡可以有多个活文件，拿不准先用 miliastra_health 或 op=inspect 看清单。 |
| `source` | `string` | 否 | —— | op=deploy：要投进去的本地文件绝对路径。 |
| `backup` | `string` | 否 | —— | op=restore：要还原的备份文件绝对路径（从 op=backups 拿）。**省略 = 用固定名那份 `<原名>.bak`**（最近一次覆盖前的版本）。 |
| `backupDir` | `string` | 否 | —— | 备份目录。默认就是活文件旁边的 `_backup\`（写在这里是为了让备份和真身待在一起）。可用环境变量 MILIASTRA_BACKUP_DIR 改到别处，但那会削弱「备份就在旁边」这一点，一般不要动。 |
| `noBackup` | `boolean` | 否 | `true` / `false` | op=deploy：跳过备份。**默认 false，正常部署请勿使用** —— 备份是这块脚本唯一的还原手段。真要跳过必须同时传 allowNoBackup:true，且覆盖后无法还原。 |
| `allowNoBackup` | `boolean` | 否 | `true` / `false` | op=deploy：确认「我知道跳过备份的后果」。仅与 noBackup:true 搭配使用。 |
| `lintMode` | `string` | 否 | `strict` / `warn` / `off` | op=deploy：Lua 结构校验强度。strict（默认）=不通过就拒绝部署；warn=只带提示照投；off=不校验。 |
| `head` | `number` | 否 | —— | op=read：只返回前 N 行（默认 80，0=全文）。 |
| `stage` | `string` | 否 | —— | op=levels：**玩法里的第几关**（表里的序号，或名字片段）；省略=全部关卡。⚠️ 别和 `level` 混：`level` = **地图关卡 ID**（如 1073741833，哪张图），`stage` = **游戏里的第几关**（如 3）—— 前者选文件，后者选表里的一段。 |
| `summaryOnly` | `boolean` | 否 | `true` / `false` | op=levels：只给**每关一行的数字摘要**（计数 + 重叠/净空/相交的处数），**不带每块平台的坐标、不带直方图分箱** —— 先扫一眼再 `stage=N` 钻进去。默认 false（全量）。 |
| `nearPx` | `number` | 否 | —— | op=levels：「近似贴上」的筛选阈值（默认 48px）—— **这是筛选，不是判定**。 |

#### `miliastra_map`

Miliastra Wonderland 工具链：读地图存档 `<关卡ID>.gil`（protobuf，含脚本源码快照）。op=summary 关卡/版本/账号/脚本映射；op=clientui **客户端控件谱系**——每条控件的「控件模板索引 / 名字 / 父 / 子」，是判断「哪些控件能被脚本动态创建」的唯一正解；op=script 比对地图里嵌的脚本源码与本地活文件（用来判断"跑的是不是本地这版代码"）；op=strings 提取可读字符串（偏移+文本），存盘前后 diff 用。判据：**只有「无父节点」的独立控件（存为模板）才可能被 game.InstantiateClientUIControl 创建**；画布上摆的实例、以及模板控件的子节点，一律返回 nil。

**典型调用**：`{"op":"summary"}`（版本/脚本映射/模板数）｜`{"op":"clientui","summaryOnly":true}`（先看有没有可动态创建的模板）｜`{"op":"script"}`（跑的是不是本地这版）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `summary` / `clientui` / `script` / `strings` | 默认 summary。 |
| `level` | `string` | 否 | —— | **地图关卡 ID / 品牌**（哪张图）；省略=当前关卡。 |
| `file` | `string` | 否 | —— | op=script：用哪个活文件比对（一个关卡可能有多个 .lua；省略=自动选；给了名字但不存在会报错并列出全部）。 |
| `summaryOnly` | `boolean` | 否 | `true` / `false` | op=clientui：省掉 `records`（每条控件一行）与 `rendered`（谱系文字），只留计数与「可能能动态创建的模板」。**先看有没有模板，再决定要不要逐条看**时用。默认 false（全量）。 |
| `path` | `string` | 否 | —— | 直接指定 .gil 绝对路径（跳过自动定位）。 |
| `limit` | `number` | 否 | —— | op=strings：最多返回多少条（默认 200）。 |
| `match` | `string` | 否 | —— | op=strings：子串过滤。 |

#### `miliastra_log`

Miliastra Wonderland 工具链：读客户端运行时日志 `.gia`。**这是运行时取证（Lua 里 print 出来的东西）的唯一入口**，比让人手动复制粘贴可靠得多。op=sessions 列出所有日志文件（倒序，带大小/时间）；op=tail 读某个文件的结构化记录；op=grep 用 tag/pattern 过滤（tag 是子串，pattern 是正则）；op=tags 汇总出现过的标签（方括号开头的那种）；**op=runs 按「局」切分** —— 一个 `.gia` 里可能装多局（实测 `21-24-16_155` 装了两段完整生命周期），op=runs 给每局一行摘要（开跑时刻 / 记录数 / 就绪行 / 异常次数 / 错误样式）**并和上一局做 diff**，省掉「把 30 多条倒过来再分清哪段属于哪局」这一步。记录字段：time / account / player / channel（关卡或模式名）/ message（正文）。

⚠️ **「试玩了却没有新日志」先看这里**：`.gia` 里**只有脚本自己 `print` 出来的东西**。实测最坑的一次是**压根忘了从编辑器开试玩**（游戏客户端开着 ≠ 在试玩）——另一种是编辑器「日志」面板里 `客户端脚本` 没勾上。工具不再替这种现象下结论，只如实回「最近一局是什么时候写的」；是不是刚玩过，你自己看一眼就知道。

**典型调用**：`{"op":"runs"}`（这一局/这几局发生了什么，含局间 diff）｜`{"op":"metrics"}`（死亡位置分布与集中区，**不用改脚本**）｜`{"op":"tail","tag":"yuan-code","limit":30}`（按标签读正文）｜`{"op":"tail","run":1790171162}`（只看那一局）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `sessions` / `tail` / `grep` / `tags` / `runs` / `metrics` | 默认 tail。 |
| `level` | `string` | 否 | —— | **地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用它对应的日志目录）。 |
| `file` | `string` | 否 | —— | op=tail/grep/runs：日志文件名或绝对路径；省略=最新那个。 |
| `tag` | `string` | 否 | —— | 正文子串过滤，例如 [P5D]、就绪、首错。 |
| `pattern` | `string` | 否 | —— | 正文正则过滤。 |
| `run` | `string` | 否 | —— | op=tail/grep/tags：**只看某一局**。给 epoch 秒（如 1790170177）或 instance 片段。op=runs 的 epochSec 与 miliastra_playtest 报的是同一个值。 |
| `limit` | `number` | 否 | —— | op=tail/grep：最多返回多少条（默认 120）；op=runs/metrics：最多返回几局/几条时间线（默认 10 / 40）；op=sessions：几个文件（默认 40）。 |
| `evt` | `string` | 否 | —— | op=metrics：只看某个事件名（严格约定的 `evt=`）。 |
| `summaryOnly` | `boolean` | 否 | `true` / `false` | op=metrics：去掉直方图分箱，只留 `n/min/max/median/core/hotBin` 这些标量（有箱可去时 `binsOmitted` 会报出数量）。**先看数再决定要不要分箱**时用。默认 false（全量）。 |
| `bins` | `number` | 否 | —— | op=metrics：直方图分箱数（默认 10，1~50）。**集中区看 `core`（四分位距），热区看 `hotBin`**。 |
| `withRaw` | `boolean` | 否 | `true` / `false` | true=把整段结构化记录一起回传（默认只回 time/message 等要点）。 |

#### `miliastra_playtest`

Miliastra Wonderland 工具链：**试玩开跑 / 结束的实时侦测** —— 回答「现在在不在试玩 / 开跑到第几秒了」，并支持**等下一次开跑**。信号来自游戏客户端自己写的 Unity 日志 `output_log.txt`（每行带毫秒时间戳、持续追加）：开跑 = `BeyondLevelPlayModule SetCurLevelData … isTrial:True`，结束 = `StartQuickSwitchSceneAction … QuickSwitchToBeyondSettleSceneNormally`。**实测延迟 0.07~0.18 秒**（2026-09-23 真机：日志在 21:46:02.420 写下，21:46:02.600 已读到）。它是**平台级**标记：脚本一行都不 print、磁盘上没有 `.gia` 的局，它照样记。⚠️ **别用 `.gia` 判开跑** —— `.gia` 不是实时的：实测那局 21:46:58 结束，`…21-46-05_157.gia` 到 **21:47:07** 才落盘；**局在跑的时候磁盘上根本没有这个文件**。op=status 看当前状态 + 最近几局；op=wait 等下一次开跑（`backSec` 可回扫刚过去那局，`afterSec` 要「开跑 N 秒后」）——命中后接着调 `miliastra_shot` 截一张，就是「游戏开跑 N 秒后的画面」。op=wait 超时**不报错**，如实回 `hit:false`。

**典型调用**：`{"op":"status"}`（现在在不在试玩）｜`{"op":"wait","afterSec":3}`（等开跑再等 3 秒 —— 但**要截图就别用这条**：直接 `miliastra_shot {"op":"burst","awaitPlaytest":true,"afterSec":3}` 一次调用更准）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `status` / `wait` | 默认 status。 |
| `level` | `string` | 否 | —— | **地图关卡 ID / 品牌**（哪张图）；省略=当前关卡（用来定位该品牌的 output_log.txt）。 |
| `backSec` | `number` | 否 | —— | op=wait：回扫窗口秒数 —— 调用之前 backSec 秒内已经开跑的也算命中（默认 0）。人点了试玩再叫 AI 时用得上。 |
| `timeoutSec` | `number` | 否 | —— | op=wait：最多等多少秒（默认 90，上限 300）。 |
| `afterSec` | `number` | 否 | —— | op=wait：命中开跑后再等 N 秒才返回（默认 0，上限 120）—— 这就是「开跑 N 秒后」。 |
| `pollMs` | `number` | 否 | —— | op=wait：轮询间隔毫秒（默认 400，100~5000）。 |

#### `miliastra_shot`

Miliastra Wonderland 工具链：截图 —— 把「现在画面上是什么」变成一张 PNG。运行时日志（miliastra_log）能回答「代码跑了没、print 了什么」，回答不了「画面对不对」（控件到底挂上去了没、位置歪没歪、颜色对不对）；这一环靠它。op=capture（默认）立刻截一张，目标 `target=game`（原神客户端，默认）/ `editor`（千星沙箱），也可以用 `process` 指定任意进程名；op=list 看截到哪去了、有多少张、占多大；op=clean 清理，**默认只报告不删**。**截图存在插件的数据目录**（默认 `~/.dsh/miliastra/shots`，`MILIASTRA_DATA_DIR` 可整体覆盖）——既不放游戏存档目录（那是米哈游的地盘），也不放包目录（插件升级会整个替换掉它）。**不会自动删**：清理要显式给条件（`all` 或 `olderThanDays`），真删还要 `confirm:true`。回执恒带 `pid / process / title` —— 明确告诉你**截到的到底是哪个窗口**（第一版抓错了程序，光看 `ok:true` 根本发现不了）。

**典型调用**：`{"op":"capture","target":"game"}`（现在截一张）｜`{"op":"burst","awaitPlaytest":true,"afterSec":3,"count":5}`（**等开跑 → 等 3 秒 → 连拍 5 张**，一次调用）｜`{"op":"burst","dryRun":true}`（先看要多久、拍几张）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `capture` / `burst` / `list` / `clean` / `targets` | 默认 capture。 |
| `target` | `string` | 否 | `game` / `editor` | 截哪个窗口：game=游戏画面(进程 YuanShen)；editor=千星沙箱编辑器(进程 BeyondEditor)。默认 game。 |
| `process` | `string` | 否 | —— | 直接指定进程名（不带 .exe），覆盖 target。 |
| `window` | `string` | 否 | —— | 按窗口标题子串挑窗口。**一个进程往往有多个窗口**（实测 BeyondEditor 同时有 900×800 的日志窗和 160×28 的最小化残片）——默认取**面积最大**的，不满意再用这个指定。 |
| `label` | `string` | 否 | —— | 文件名里的标签，如「试玩第1局」「控件对齐」（允许中文；非法字符会被清掉）。 |
| `level` | `string` | 否 | —— | op=burst（配合 awaitPlaytest）：关卡 ID / 品牌；省略=当前关卡（用来定位该品牌的 output_log.txt）。 |
| `dir` | `string` | 否 | —— | 覆盖截图目录（默认插件数据目录下的 shots\）。 |
| `keepLast` | `number` | 否 | —— | op=clean：至少保留最新的 N 张（保护网，任何模式下都生效）。 |
| `olderThanDays` | `number` | 否 | —— | op=clean：只删比这个更旧的（>0 才生效）。 |
| `all` | `boolean` | 否 | `true` / `false` | op=clean：不管新旧，除 keepLast 外全删。 |
| `dryRun` | `boolean` | 否 | `true` / `false` | op=clean：默认 true（只报告将删哪些）。 |
| `confirm` | `boolean` | 否 | `true` / `false` | op=clean：真删必须再传 confirm:true。 |
| `bringToFront` | `boolean` | 否 | `true` / `false` | 默认 true：抓不到时把目标窗口拉到前台再抓。 |
| `keepWindowOnTop` | `boolean` | 否 | `true` / `false` | 默认 false：退回屏幕抓取时临时把目标窗口置顶。 |
| `count` | `number` | 否 | —— | op=burst：连拍几张（默认 5，上限 20）。 |
| `burstMs` | `number` | 否 | —— | op=burst：两张之间**额外等待**的毫秒（默认 800；小于 800 会被夹到 800 并标 `clamped`）。⚠️ **这不是「每 N 毫秒一张」**：单张自身还要 ~2.6 秒（本机实测），所以真实帧距 ≈ burstMs + 2600ms，回执里用 **`measuredIntervalMs`** 如实报出。 |
| `awaitPlaytest` | `boolean` | 否 | `true` / `false` | op=burst：**默认 false（立刻开拍）**。传 true 就变成「等试玩开跑 → 再等 afterSec 秒 → 连拍」——这条链**一次调用就能完成**（判据与 miliastra_playtest op=wait 是同一份）。 |
| `afterSec` | `number` | 否 | —— | op=burst（配合 awaitPlaytest）：命中开跑后再等 N 秒才开拍（默认 0，上限 120）。 |
| `timeoutSec` | `number` | 否 | —— | op=burst（配合 awaitPlaytest）：等开跑最多多少秒（默认 90，上限 300）。 |
| `backSec` | `number` | 否 | —— | op=burst（配合 awaitPlaytest）：回扫窗口秒数 —— 调用之前 backSec 秒内已经开跑的也算命中（默认 0）。 |

#### `miliastra_probe`

Miliastra Wonderland 工具链：探针 —— **「问游戏一句」的工具**。探针是一段临时替掉活文件的小程序，只在试玩那几秒跑一次，把游戏内部信息打到日志里。为什么需要它：有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举到底叫什么名），必须让游戏真跑一遍才知道 —— 用它，别猜。**代价**：部署会**临时覆盖活文件**，所以试玩那一局你的玩法不会跑（Host 会先自动备份，用完一键还原）。**四步**：① op=deploy template=<名字> → ② 在编辑器里**重新**试玩一局（不会热加载）→ ③ op=collect 收回结论 → ④ 用 miliastra_code op=restore 还原你的脚本。**5 个模板**（先 op=list 看详情）：`api-surface` 翻字典=把游戏里的枚举和它们的成员列出来（比如某个按键到底叫什么名）；`tree` 看控件=看屏幕上现在挂着哪些客户端控件、画布多大；`instantiate` 试钥匙=拿一串索引号去试，看哪个真能被脚本创建出来；`ping` 探活=确认「脚本到底有没有跑起来」；`api-check` 核文档=官方文档写的那些接口，真机上到底有没有。另：op=render 只生成 Lua 不部署（要先看代码用这个）。探针只读，不做场景写操作。

**典型调用**：`{"op":"deploy","template":"ping"}` → 人重新试玩 → `{"op":"collect","tag":"P1"}` → **还原**：`miliastra_code {"op":"restore"}`（不传 backup 就是用固定名那份）

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `list` / `render` / `deploy` / `collect` | 默认 list。 |
| `template` | `string` | 否 | `api-surface` / `tree` / `instantiate` / `ping` / `api-check` | 模板名。怕选错先 op=list 看每个模板的大白话说明：api-surface=翻字典（把游戏里的枚举和它们的成员列出来（比如某个按键到底叫什么名））；tree=看控件（看屏幕上现在挂着哪些客户端控件、画布多大）；instantiate=试钥匙（拿一串索引号去试，看哪个真能被脚本创建出来）；ping=探活（确认「脚本到底有没有跑起来」）；api-check=核文档（官方文档写的那些接口，真机上到底有没有） |
| `tag` | `string` | 否 | —— | 日志标签（默认 PROBE）。collect 时用它过滤。 |
| `level` | `string` | 否 | —— | 关卡；省略=当前关卡。 |
| `file` | `string` | 否 | —— | op=deploy：要替换哪个活文件（一个关卡可能有多个 .lua；省略=自动选）。 |
| `ids` | `array<number>` | 否 | —— | instantiate：额外的候选控件模板索引。 |
| `from` | `number` | 否 | —— | instantiate：兜底扫描下界（默认 1073741824）。 |
| `to` | `number` | 否 | —— | instantiate：兜底扫描上界（默认 1073741900）。 |
| `saveTo` | `string` | 否 | —— | render/deploy：把生成的 Lua 另存到这个绝对路径。 |
| `lintMode` | `string` | 否 | `strict` / `warn` / `off` | op=deploy：Lua 结构校验强度（默认 strict）。探针模板都是本插件生成的，正常不会挂；报错说明模板本身有 bug。 |

#### `miliastra_echo`

调试用：把 text 原样回显，并带上插件版本与本机存档根目录。**怀疑「插件没生效 / 面板调不通 Host / 工具参数丢了」时先调它** ——返回里带着你传进来的字符串，就不用猜参数到底有没有传到 Host。

**典型调用**：`{"text":"ping"}`

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `text` | `string` | **是** | —— | 要回显的字符串。 |

#### `miliastra_sim`

内置**千星模拟器**（引擎吸收自 miliastra-beyond-simulator，GPL-3.0-only）：在游戏之外搭界面、跑 levelScript、出画面 PNG。
★ **AI 自测逻辑主用 `op=verify`**：一次调用 = 跑一段操作 + 到点断言 + 给判定（引擎开一个全新会话**确定性重放**，可重复）。
  · `steps[]` 每步可带 `at`（模拟秒；省略 = 上一步 + `after`，默认 0.1s）：`key:"KeyboardCraftspersonKey3Down"` / `click:{x,y}`（**左下原点**）/ `clickName:"按钮名"` / `setVar:{entityType,name,value}` / `sendSignal:{name,params,target}` / `view:2` / `pause` / `resume`；
  · `expect[]` 断言数组（`at` 省略 = 最后一个事件之后 0.1s ⇒ 查最终状态），kind 六种：`log{contains,level?,source?}` / `control{id?|name?,field,equals}` / `var{entityType,name,equals}` / `signal{name,direction?,values?}` / `tree{name,exists}` / `lua{source}`（Lua 查询脚本，可用 query.var / query.control / query.logContains / query.logs / query.serverLogContains / query.signals）；
  · 回 `passed` / `failedAt` / `results[]`（每条 ok·actual·expected）/ `snapshot.logs`；**没过时给一句 `hint`** 指出第几条、期望 vs 实际。
  · **没过会顺带取证**：`shot`（失败点附近的一帧 PNG，用 read_image 看）+ `runtime.controlNames`（**运行时**控件名清单 —— 编辑器工程树里没有的就是脚本动态创建的）；不要就传 `shotOnFail:false`。
  · **一组用例一次跑**：`cases:[{name,steps,expect},…]` —— 每个用例各开一个全新会话确定性重放（互不影响，可当回归套件）；默认跑完全部，`stopOnFail:true` 则第一个不过就停。`keepRunning:true` 保留会话以便接着 `op=play` 交互（默认判定完就停；失败取证会把会话置于暂停）。
其它 op：`controls` **控件清单（最省 token，写断言前先看这个）**——只回 `{id,name,kind,depth}` + `names`（可直接抄进 expect）+ 类型直方图；`runtime:true` 看**运行中**会话的控件（脚本动态建出来的），需先 start；`state` 看工程/控件树/属性（要几何与父级才用它）；`patch` 改工程（add/set/remove/setCanvas/addScript…，数据写带 expectedRevision）；`play` 手动试玩（start/step/pointer/key/click/pause/resume/device/view/serverGet/serverSet/serverSend/history/saveCase/runCase/stop；start 可带 canvasId 与 playerCount=1–8）；`keys` 从**你的脚本源码**里扫出它真正在听的按键名；`shot` 出 PNG（target=ui 编辑器视图 / target=play 试玩画面；`reuse:true` 连帧固定名覆盖写）；`export` 导出（format=`gia`/`gia-combined`/`json`/`save`/`scripts`，落进模拟器工作区的 `exports/`）；`import` 把文件导回（`file`=绝对路径）；`load` 列/读模拟器工作区存档；`save` 存进该工作区；`reset` 清空工程。
⚠️ 用户 Lua 跑在**可终止的 Worker** 里（默认 8 秒超时后 terminate），**模拟器通过 ≠ 真机通过**；工作区固定在插件数据目录的 `simulator/`，不碰游戏存档、地图与活文件。

**典型调用**：自测一条规则：`{"op":"verify","steps":[{"key":"KeyboardCraftspersonKey3Down"}],"expect":[{"kind":"log","contains":"GOT_KEY_3"}]}`；写断言前先看有什么控件：`{"op":"controls","namedOnly":true}`；看画面：`{"op":"play","action":"start"}` → `{"op":"shot","target":"play"}`

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `op` | `string` | 否 | `controls` / `state` / `patch` / `play` / `verify` / `shot` / `keys` / `export` / `import` / `load` / `save` / `reset` | 默认 state。**AI 自测逻辑用 verify**；写断言前想省 token 看控件用 controls。 |
| `steps` | `array<object>` | 否 | —— | op=verify 的操作序列；每步 {at?, after?, key?\|click?{x,y}\|clickName?\|setVar?{entityType,name,value}\|sendSignal?{name,params,target}\|view?\|pause?\|resume?}。 |
| `expect` | `array<object>` | 否 | —— | op=verify 的断言数组；每项 {kind, at?, ...}，kind = log{contains}/control{id\|name,field,equals}/var{entityType,name,equals}/signal{name,direction,values}/tree{name,exists}/lua{source}。⚠️ `tree` 只能按 name 找（没名字的控件用 control{id}）。 |
| `cases` | `array<object>` | 否 | —— | op=verify 的**多用例**：每项 {name, steps, expect}（各自独立重放，一次调用跑一组回归）。 |
| `shotOnFail` | `boolean` | 否 | `true` / `false` | op=verify：判定没过时自动存一帧失败点 PNG 并回 `shot`（默认 true，传 false 关掉）。 |
| `stopOnFail` | `boolean` | 否 | `true` / `false` | op=verify 配 cases：第一个用例没过就停（默认 false = 跑完全部，回归语义）。 |
| `keepRunning` | `boolean` | 否 | `true` / `false` | op=verify：判定后不停止会话（默认停），便于接着 op=play 交互；失败取证会把会话暂停，续玩先 op=play action=resume。 |
| `dt` | `number` | 否 | —— | op=verify：重放的每步时长（秒）。省略用引擎默认。 |
| `runtime` | `boolean` | 否 | `true` / `false` | op=controls：看**运行中**会话的控件树（脚本动态创建的），需先 op=play start；省略=看编辑器工程树。 |
| `namedOnly` | `boolean` | 否 | `true` / `false` | op=controls：只列有名字的控件（只有它们能按 name 断言）。 |
| `nameContains` | `string` | 否 | —— | op=controls：按名字子串过滤（Host 侧过滤，中文可用）。 |
| `kind` | `string` | 否 | —— | op=controls：按类型过滤（container / server-container / textbox / button / image …）。 |
| `maxDepth` | `number` | 否 | —— | op=controls：只列到第几层（0=根）。 |
| `limit` | `number` | 否 | —— | op=controls：最多回多少条，默认 200（回执里 `omitted` 说明截掉了多少）。 |
| `summaryOnly` | `boolean` | 否 | `true` / `false` | 只去体积不去结论（默认 true：state 不回 boxes 与 tree 全量）。 |
| `treeLimit` | `number` | 否 | —— | op=state 在 summaryOnly 下最多回多少条控件树，默认 200。 |
| `patch` | `object` | 否 | —— | op=patch 的编辑操作，如 {"op":"add","parentId":"n1","kind":"textbox","name":"标题"}；数据写要带 expectedRevision。 |
| `action` | `string` | 否 | —— | op=play 的动作：start / device / view / get / step / pointer / key / click / pause / resume / stop / serverGet / serverSet / serverSend。 |
| `args` | `object` | 否 | —— | op=play 的参数，如 {"x":640,"y":360} / {"dt":0.033} / {"type":"click","x":640,"y":360}。 |
| `target` | `string` | 否 | `ui` / `play` | op=shot 的取景：ui=编辑器视图（静态），play=试玩画面（需先 op=play action=start）。 |
| `label` | `string` | 否 | —— | op=shot 的文件名标签（便于事后认图）。 |
| `reuse` | `boolean` | 否 | `true` / `false` | op=shot 连帧用：固定名（sim-play-live.png）覆盖写，磁盘只留一张当前帧；URL 带时间戳绕开缓存。不传=每张都新建文件（适合留证据）。 |
| `format` | `string` | 否 | —— | op=export / op=import 的格式：gia（当前界面）/ gia-combined（服务端与客户端并排）/ json / save / scripts / lua。默认 gia。 |
| `assetType` | `string` | 否 | —— | op=export 的资产类型过滤（如 server-control-template / client-control-template）。 |
| `file` | `string` | 否 | —— | op=import 要导入的文件绝对路径。 |
| `archive` | `string` | 否 | —— | op=load 的存档相对路径；省略=列出工作区里的存档。 |
| `path` | `string` | 否 | —— | op=save 的存档文件名（默认 qxqy-simulator.save.json）。 |
<!-- END GENERATED:tools -->

### 深入阅读（**按需加载**，别一次读所有）

上面「工具速查」解决**怎么调**；下面这几篇解决**为什么**与**翻过什么车**。
每篇都是独立文件 —— **用到哪条读哪篇**，不用整份读完。

| 你手上在做的事 | 读这个 |
|---|---|
| 试玩：开跑那一刻 / 连拍 / 截图选窗 / 缩略图 | [`docs/功能详解.md`](docs/功能详解.md) |
| **模拟器**：三个 tab 怎么挂的 / 画面怎么来的 / 失控脚本护栏 / 哪些还没验证 | [`docs/模拟器与视图.md`](docs/模拟器与视图.md) |
| 部署安全：备份与还原 / 部署指纹 / `fixbom` / `lintMode` | [`docs/功能详解.md`](docs/功能详解.md) |
| 读日志：按「局」切分 / 指标汇总 / 关卡表几何事实 | [`docs/功能详解.md`](docs/功能详解.md) |
| 面板怎么用（三栏 / 自动跟随 / 多活文件 / 一键还原） | [`docs/面板与活文件安全.md`](docs/面板与活文件安全.md) |
| 关键知识与能力边界（动态创建 / `prefabIndex` / 试玩没有自动化通道） | [`docs/关键知识与能力边界.md`](docs/关键知识与能力边界.md) |
| 配置项（环境变量 / 数据目录） | [`docs/配置与开发.md`](docs/配置与开发.md) |
| 改代码后的验证阶梯 / 生效边界 / 探针硬边界 / 排障 | [`docs/配置与开发.md`](docs/配置与开发.md) |
| 每个版本的变更与真机证据 | [`CHANGELOG.md`](CHANGELOG.md) |
| 融合 `miliastra-beyond-simulator` 的需求边界与工单（R↔FP 追溯、六轮决策、W1–W7） | [`docs/需求边界清单_融合beyond-simulator_2026-09-24.md`](docs/需求边界清单_融合beyond-simulator_2026-09-24.md) |
| **上游源码在哪 / 搬了什么 / 没搬的读哪篇**（含 esbuild 构建脚本、他们的 DSH 插件与 agent 预设） | [`docs/上游源码索引与吸收地图.md`](docs/上游源码索引与吸收地图.md) |

## License

[GNU GPL v3.0（GPL-3.0-only）](LICENSE) · Copyright 2026 LoktLin

可自由使用、修改、分发（含商用），**但衍生作品必须以同一许可（GPL-3.0-only）发布**，并保留版权与许可声明；不提供任何担保。完整条款见 [LICENSE](LICENSE)；引擎部分的来源与归属见 [NOTICE](NOTICE)。
