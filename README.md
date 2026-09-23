# dsh-miliastra

> 原神 · **千星奇域**（Miliastra Wonderland）UGC 的 DSH 插件：把「文件层」的开发闭环做成原生工具，
> 让 AI Agent 能自己定位活文件、读地图配置、跑探针、取运行时日志 —— 不用你手动复制粘贴。

**版本 `0.0.1`**（首个版本，见 [CHANGELOG](CHANGELOG.md)） · Apache-2.0
适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）0.1.2-rc.1+ · Windows。

> 这套工具链是**在正式服上排一次真实的 bug 排出来的**（「动态创建控件恒返回 nil」→ 根因是模板库为空），
> 踩过的坑都固化成了工具能力与下面的「关键知识」。

![dsh-miliastra 面板：三栏 · 关卡 / 代码 / 日志](assets/panel.png)

> 上图为实机截图（部分账号信息已打码）。三栏分工：
> **① 关卡**（自动跟随换图 · 进程状态 · 地图体检）／
> **② 代码**（活文件选择与体检 · 脚本一致性 · 备份还原 · 部署）／
> **③ 日志**（历史日志 · TAG 汇总 · 试玩完自动取回 · 可折叠的「高级诊断」：读界面控件 / 探针）。

---

## 文档索引

| 文档 | 位置 | 内容 |
|---|---|---|
| 本文件 | 本仓库 `README.md` | 装 / 用 / 关键知识 / 能力边界 |
| 变更记录 | 本仓库 [`CHANGELOG.md`](CHANGELOG.md) | 每个版本加了什么、修了什么、怎么验的 |
| 许可 | 本仓库 [`LICENSE`](LICENSE) | Apache-2.0 |

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
本插件把这套动作变成 6 个工具 + 一个侧边栏面板。

---

## 安装

### 方式一：从源码目录装（还没发包时用这个）

```powershell
git clone <本仓库地址> dsh-miliastra
cd dsh-miliastra

# 开发态：目录软链 + 手动进 bundles（改代码立即生效）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-miliastra" (Get-Location).Path
# 再把 "dsh-miliastra" 加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
```

### 方式二：装进 web profile（发布到 npm 之后）

```powershell
dsh plugin --profile web add dsh-miliastra   # 会自动写进 dsh.profile.bundles
```

### 两种方式都别忘了

```powershell
dsh web     # 重启 Web GUI —— Host 半边是启动时加载的快照，不重启不生效
```

> ⚠️ **只放软链不会让插件被装配**：启动期不扫描 `node_modules`，装配来源只有 profile 的 `dsh.profile.bundles`
> （或 profile `cordis.patch.yml` 里显式 insert 一行）。这条错了的表现是**完全静默**：文件都在、什么也没发生。

---

## 发布到 npm

```powershell
npm login                                   # 浏览器 / 2FA；没账号先到 npmjs.com 注册并验证邮箱
npm publish --dry-run                       # 先看会发什么（不真发）
npm publish                                 # 真发；开了 2FA 时加 --otp=123456
npm view dsh-miliastra version              # 验证：打印版本号即成功
```

发布后的使用方式就回到上面「方式二」：

```powershell
dsh plugin --profile web add dsh-miliastra@0.0.1   # 声明了 dsh.bundle.patch，会自动进 dsh.profile.bundles
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

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| **`miliastra_health`** | 扫出所有客户端安装 / 关卡 / 活文件 / 地图 / 日志目录，并判定「当前正在开发的关卡」 | **任何操作前先调它**。路径随账号与换图变化，禁止写死 |
| **`miliastra_code`** | 活文件的 读 / 部署 / 体检 / 还原。部署一律：**先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 BOM**，并**先做 Lua 结构校验**（见下） | 改完本地脚本要投进沙箱时 |
| **`miliastra_map`** | 读 `<关卡ID>.gil`：关卡信息、**客户端控件谱系**（控件模板索引 / 名字 / 父 / 子）、脚本源码快照比对 | 判断「哪些控件能被脚本动态创建」、判断「跑的是不是本地这版代码」 |
| **`miliastra_log`** | 读 `.gia` 运行时日志：列局面、结构化读正文、按 TAG / 正则过滤、汇总标签、**`op=diagnose` 试玩体检**（「我刚试玩了，为什么没有日志？」） | **运行时取证**（Lua 里 `print`，别靠猜）。比让人手动贴日志可靠得多 |
| **`miliastra_probe`** | 探针模板化：**5 个只读诊断脚本** —— `ping` 探活 / `tree` 看控件 / `instantiate` 试钥匙 / `api-surface` 翻字典 / `api-check` 核文档。渲染 → 部署 → 试玩后 `collect` 回收结论 | 需要运行时真相时 |
| **`miliastra_shot`** | **截图**（见下）：`capture` 截游戏/编辑器窗口、`list` 看截到哪了、`clean` 清理（默认只报告） | 需要「看画面对不对」时 —— 日志回答不了观感 |
| `miliastra_echo` | 回显参数 | 怀疑插件没生效 / 参数丢了时先调它 |

### 截图（`miliastra_shot`）

运行时日志能回答「**代码跑了没、print 了什么**」，回答不了「**画面对不对**」——
控件到底挂上去了没、位置歪没歪、颜色对不对。这一环以前只能靠人截图再手动贴回来。

```
miliastra_shot op=capture target=game label=试玩第1局   # 默认就是 capture + game
miliastra_shot op=list                                 # 截到哪去了、多少张、占多大
miliastra_shot op=clean keepLast=5 olderThanDays=7      # 先看将删哪些（默认 dryRun）
miliastra_shot op=clean all=true dryRun=false confirm=true   # 真删（双钥匙）
```

**图片存在插件自己的数据目录**：`~/.dsh/miliastra/shots\`（`MILIASTRA_DATA_DIR` 可整体覆盖）。
**故意不放两个地方**：

| 不放哪 | 为什么 |
|---|---|
| 游戏存档目录（`external_lua_file\`） | 那是米哈游的地盘。混进一堆 PNG 会污染存档目录，而「活文件 = 那个目录里的 `.lua`」这类判断最怕旁边多东西 |
| 本插件的包目录（`node_modules\dsh-miliastra\`） | **插件升级 / 重装会整个替换掉那个目录，用户的图会凭空消失** |

**绝不自动删。** 删除不可恢复，所以：

- `op=clean` 必须显式给条件（`all` 或 `olderThanDays`）；**什么都不给就一张都不删**并说明原因
- `keepLast` 是保护网，**任何模式下都生效**（哪怕 `all:true` 也至少留最新 N 张）
- 真删要 **`dryRun:false` + `confirm:true` 双钥匙**
- 面板上同样是**两步**：点「清理…」先看将删清单，确认按钮才出现

**回执恒带窗口身份**：`process` / `pid` / `title` / `mode` / `blackRatio`。不是装饰 ——
这个功能的第一版抓回来的其实是**恰好压在前面的浏览器**，而回执只有 `{ok:true,path}`，
**光看返回值完全无法发现**，是靠人眼看 PNG 才暴露的。现在改成：

| 字段 | 含义 |
|---|---|
| `mode: "printwindow"` | 让窗口自己渲染（`PrintWindow` + `PW_RENDERFULLCONTENT`）。**不需要窗口在前台**，被遮挡也行 |
| `mode: "screen"` | 退回屏幕抓取。**只有目标窗口真在前台才对** → 此时 `front:false` 会被标成 `suspect:true` |
| `blackRatio` | 量出来的黑像素占比。> 98.5% 判 `suspect`（Unity/D3D 的 swap chain 偶尔让 PrintWindow 返回全黑） |
| `pid` / `title` | 明确告诉你**截到的到底是哪个窗口** |

> ⚠️ 截图在 Windows 上由 `lib/capture-window.ps1` 完成（Node 没有内建窗口截图能力）。
> 那个脚本**刻意保持纯 ASCII**：PowerShell 5.1 在 `.ps1` 没有 BOM 时按 ANSI 解码，任何中文都会变乱码。
> 它还把所有非 ASCII 输出转义成 `\uXXXX` —— 因为 PS 5.1 重定向 stdout 用的是**控制台代码页**（本机 936/GBK），
> 不是 UTF-8，窗口标题「原神」会以 GBK 字节到达 Node 变成 `ԭ��`。

### 部署前的 Lua 结构校验（`lintMode`）

**一段语法错的 Lua 投进沙箱，试玩会静默不生效** —— 脚本根本没起来，日志里只会是「什么都没有」，
这是最难查的一类失败（比报错难查得多）。所以 `op=deploy` 默认先扫一遍结构：

| `lintMode` | 行为 |
|---|---|
| `strict`（默认） | 缺 `end` / 括号不配平 / 字符串或长注释没闭合 / `repeat` 少了 `until` → **直接拒绝部署，且不碰活文件、不产生备份** |
| `warn` | 照投，但把问题放进返回值的 `warnings[]`，不静默吞掉 |
| `off` | 不校验（逃生舱） |

校验器在 `lib/lualint.mjs`，**零依赖的结构级启发式**（不是完整 Lua 解析器）：先严格剥掉注释与
字符串（含 `--[[ ]]` / `[==[ ]==]` 长括号），再统计块开闭与括号配对，**报出「第 N 行的 xxx 没有对应的 end」**。

> ⚠️ 写它的时候踩过一个坑，值得记下来：最初「换行直接跳过」，结果**行尾标识符与下一行行首会粘成一个词**
> （`local sx, sy` 换行接 `local` → `sylocal`），行首的 `end` 被吞进上一行的尾巴 ——
> 于是**真文件恒报「缺 29 个 end」，而单行小样例却全绿**。现在换行会占位保留，
> `tests/lualint-test.mjs` 里有 4 条专门盯这个的回归断言。

典型循环：

```
miliastra_health                       # 我在哪张图、活文件是哪个、日志在哪
  → 改本地 .lua
  → miliastra_code op=deploy source=<本地路径>
  → （编辑器里）停止试玩 → 重新试玩
  → miliastra_log op=tail tag=<你的标签>
```

---

## 侧边栏面板

注册在官方槽位 `sidebar.footer.action`（侧栏底部「设置」旁），点开是一个状态浮层。
**粉蓝主调**（浅蓝 `#7dd3fc` ↔ 粉红 `#f9a8d4`），入口图标是内联的像素画 PNG
（`lib/assets/icon.png`，内联进 bundle，换图不用改路由、也不依赖宿主静态服务）。

布局是**三栏网格**（参考蛋仔面板的 `.eggy-body` / `.eggy-col`）：头部固定、三栏各自独立滚动。

| 栏 | 内容 |
|---|---|
| **① 关卡** | **关卡切换**（默认**自动跟随**换图；点某一关即手动锁定，可一键回自动）<br>关卡与文件（本机存档 / 关卡数 / 当前关卡 / 账号 / 活文件 / 地图存档 / 日志局面 / 最近一局）<br>**进程**（编辑器 / 游戏在不在跑 + 能否试玩）<br>地图体检（名称版本 / 客户端控件条数 / **可创建模板胶囊** / 模板区为空告警） |
| **② 代码** | **活文件选择器**（多文件时点胶囊切换，所有操作跟着它走）<br>活文件体检（大小·行数 / SHA-256 / **BOM** / 编码 / 中文注释）<br>**脚本一致性**（地图快照 vs 本地活文件）<br>**备份**（份数·位置 / 清单 / 逐条还原 / 过多提醒）<br>**部署**（覆盖前自动备份 · 校验 SHA-256 · 拒收 BOM） |
| **③ 日志与画面** | 局面数 / 最近一局 / **历史局面胶囊**（点某一局只看那一局）<br>**TAG 汇总** / 按 TAG 过滤（点胶囊即过滤）/ 日志正文<br>**截图**：存放目录 · 张数 · 占用（**打开面板就能看到**）；截游戏 / 截编辑器 / 列目录 / 清理（两步）<br>**高级诊断**（默认收起）：读界面控件（只读）+ 探针（会覆盖活文件） |

### 关卡切换与「自动跟随」

面板默认**自动跟随**：`miliastra_health` 每次都会重新判定「当前正在开发的关卡」
（有活文件 + 最近改动），作者在编辑器里换图，面板下一轮就跟着切过去。

点列表里任何一关 → 变成**手动锁定**（按钮变「自动跟随」，栏目状态点变黄），
`level` 参数会带给所有工具调用；再点一下「自动跟随」就回到自动。

> 本机实测 `Beyond_Local_Save_Level` 下有 **18 个关卡**（8 个是直接躺在根目录的 `.gil`，
> 那部分是"不在这台机器上编辑的图"）。**两种布局都扫**，只扫一种会漏掉大部分。

### 一个关卡可以有多个活文件

不同角色 / 不同模块可以各挂一个客户端脚本，`external_lua_file\` 下就会有多个 `.lua`。
所以「当前操作哪一个」是**显式**的：

- 面板：列② 顶部的**活文件选择器**，点一下切换；切了之后体检/比对/备份/部署/还原全部跟着切
- 工具：所有相关 op 都收 `file` 参数
  - 省略 → 先按名字关键词（`双相`/`测试`/`main`/`levelScript`），再退到**最近改动**的那个
  - 给了名字但不存在 → **明确报错并列出全部**，绝不悄悄换成别的文件
- 备份是**按文件隔离**的（`_backup\` 里按文件名前缀分组）

### 备份与还原（活文件是唯一副本，所以这里全是硬规定）

活文件没有 git、没有撤销，**覆盖即丢失** —— 这是唯一的安全网。

| | 说明 |
|---|---|
| **备份什么** | **只有活文件 `.lua`**（不备份 `.gil`、不备份已发布的图） |
| **什么时候** | `op=deploy` 覆盖前自动备份；`op=backup` 手动；`op=restore` 还原前**再备份一次当前版本** |
| **备份到哪** | **就在被替换文件的旁边**：活文件同级 `_backup\`。`MILIASTRA_BACKUP_DIR` 只为测试隔离，一般不要动 |
| **备份叫什么** | 每次写**两份**：固定名 **`<原名>.bak`**（= 最近一次覆盖前的那一版）+ 历史 `<原名>.<本地时间戳>_备份.lua` |
| **为什么要有固定名** | 还原时**不用挑版本**：`op=restore` 不传 `backup` 就用 `.bak`。挑时间戳是错误来源之一 |
| **会互相覆盖吗** | 历史那份不会：**同秒撞名自动顺延 `-2 / -3`**。`.bak` 按定义会被下一次覆盖更新 |
| **备份失败怎么办** | **中止覆盖，活文件零改动** —— 绝不带着「没有备份」去写。（以前是「记一笔错误然后照样覆盖」，已修） |
| **断电会不会写坏** | 不会。**原子写**：同目录临时文件 → `fsync` → `rename` 替换。目标要么还是旧内容，要么已是完整新内容 |
| **写完怎么确认** | 比对 SHA-256；**校验不过自动回滚**到覆盖前那一版（部署与还原都如此） |
| **还原安全吗** | ① 先列出让你选（或用固定名一键）② **还原前把当前版本再备份一份** ③ 原子写 ④ 校验 SHA，不过就**自动回滚** ⑤ 回报「从哪份还原 / 当前 sha / 安全备份路径 / 下一步」 |
| **拒收什么** | 带 UTF-8 BOM 或非法 UTF-8 的备份 —— **还原坏文件比不还原更糟** |
| **能跳过备份吗** | `noBackup:true` 必须**同时**传 `allowNoBackup:true`（双钥匙）；正常部署不要用 |
| **会删旧备份吗** | **不会**。份数 ≥20 或总占用 >5 MB 时只提示，清理由你自己决定 |

```powershell
miliastra_code op=backups                  # 列备份（含固定名路径与 ★ 标记）
miliastra_code op=backup                   # 手动备份（写固定名 + 历史各一份）
miliastra_code op=restore                  # 还原到固定名那份（最省事，不用挑版本）
miliastra_code op=restore backup=<路径>     # 还原到指定某一版
miliastra_code op=inspect file=角色B.lua    # 指定活文件体检（含 SHA-256）
```

**面板上更快**：右栏「备份」卡片里有 **「还原到最新备份」** 一键按钮，以及 `★` 标出的固定名那份。

---

## 关键知识（踩过的坑，直接用）

### 1. 客户端控件能不能被脚本动态创建，只取决于「它怎么来的」

`game.InstantiateClientUIControl(controlPrefabIndex, parent)`：

| 控件怎么来的 | 能否创建 |
|---|---|
| 在**界面控件组库 → 客户端控件模板 →【添加客户端控件】→ 存为模板** | ✅ **只有这种能** |
| 从控件面板直接摆到**客户端控件容器画布**上的实例 | ❌ 恒返回 `nil` |
| **模板控件的子节点** | ❌ 恒返回 `nil` |

官方原文（《客户端控件和客户端脚本》§八）：

> 注意：仅存为模板的客户端控件，支持通过接口 `ClientUIBaseControl` 被动态创建
> 注意：挂载在主屏中的客户端控件，以及存为模板的客户端控件的子节点，均不支持通过脚本接口动态创建

**模板库为空 = 对任何索引号都返回 `nil`。** 动手前先 `miliastra_map op=clientui` 看一眼模板区。

### 2. 编辑器面板的「索引」≠ 运行时的 `prefabIndex`

后者才是官方字段表里的**「控件模板索引」**（`ClientUIBaseControl.prefabIndex`，只读）。
实测同一批控件：面板显示 `1073741853/1854/1855`，运行时 `prefabIndex` 是 `1073741866/1865/1864` —— **两套号，不可混用**。

### 3. 部署脚本的三条硬要求

- **不加 UTF-8 BOM** —— 原神日志实测会打印 `Read text file with BOM header may cause Lua error`；
- **二进制拷贝** —— 「读文本再写文本」会把中文注释转码毁掉；
- **改完先备份** —— 脚本没有 git，覆盖即丢失。

`miliastra_code` 全部内建，任一不满足直接拒绝部署。

### 4. `script:EnableUpdate(true)` 不写，`OnUpdate` 永远不触发

症状：日志里只有 `OnInit` / `OnEnable` / `OnStart` 三行，之后的输出一条都没有。
探针模板已内建这一行。

### 5. `.gil` 只反映**已存盘**的状态

编辑器里改完不按 `Ctrl+S`，磁盘上还是旧配置 —— 于是「我刚配的怎么读不到」。
本插件的 `miliastra_map` 读的就是磁盘真身。

---

## 能力边界

- ✅ **文件层全自动**：定位、读取、部署、校验、取证。
- ✅ **画面层可取证**：把游戏窗口截成 PNG 并自证「截到的是哪个窗口」。
- ❌ **编辑器 UI 层没有自动化通道**：在模板库里点【添加客户端控件】、给容器节点挂脚本、建容器 ——
  这些必须在编辑器里由人完成。本插件替代的是「人和 AI 之间的来回搬运」，不是编辑器操作本身。
- ❌ 不做场景写操作：工具全部只读或只写「活文件」（脚本本身），不碰地图数据。
- ❌ **不做任何侵入行为**：不读游戏内存、不连游戏进程的端口、不驱动编辑器/游戏。

### 「试玩」按钮为什么不能自动化（查清了，别再试）

蛋仔派对那套「一键试玩」在千星奇域**走不通**。三个通道逐条查过：

| 通道 | 蛋仔派对 | 千星奇域 | 证据 |
|---|---|---|---|
| 编辑器官方 CLI（`editor-cli`） | ✅ | ❌ | 安装目录只有 `Resource` / `Astrolabe` / `cs` / `Log`，没有 CLI |
| 编辑器插件 + 本地 RPC 桥 | ✅ H5 插件 + `127.0.0.1:19860` | ❌ | `Documents\res\plugin`、`Documents\ugc_plugin` 都不存在；`BeyondEditor` 无监听端口 |
| UIA / AutomationId | ✅ Qt 界面有稳定 id | ❌ | 原神窗口类 `UnityWndClass` → **UIA 子孙节点 = 0**（Unity 自绘，没有原生控件可驱动）；`千星沙箱` 窗口虽是**可访问的 WPF**，但它是**节点图资源管理器**，114 个元素里没有试玩按钮 |
| ⚠️ 编辑器↔客户端私有通道 | — | **存在但放弃** | 实测 `BeyondEditor.exe`(5608) 连到 `YuanShen.exe`(3284) 的 `127.0.0.1:55324`。协议是私有的，要驱动它就得**冒充编辑器** —— 这属于侵入行为，**明确不做** |

→ **结论：不做。** 试玩由人在编辑器里点；插件负责把人的动作接住
（`miliastra_log op=diagnose` 试玩体检 + 试玩完自动取回最新一局）。

> 另外注意：**3D 编辑视图在游戏客户端窗口里**，`target=editor` 截到的「千星沙箱」只是节点图资源管理器。
> 想看画面用 `target=game`。

---

## 配置

无需配置。存档根按下列顺序推导：

1. 环境变量 `MILIASTRA_LOCALLOW`（指向 `...\AppData\LocalLow\miHoYo`）
2. `os.homedir()` + `AppData\LocalLow\miHoYo`（Windows 默认位置）

仓库里**不写死任何绝对路径**。

> ⚠️ **显式指定就照做**：如果 `MILIASTRA_LOCALLOW` 指向一个不存在的目录，工具会明确报「没扫到任何关卡目录」，
> **不会静默回退**到真实存档根。这是刻意的 —— 回退意味着手一滑写错路径，工具就悄悄去动你的真文件了。
> （想换机器/换盘/非默认安装位置时，把 `MILIASTRA_LOCALLOW` 指向真实的 `miHoYo` 目录即可。）

---

## 开发

```powershell
# —— L1 契约 / 单元 ——
node tests/smoke.mjs              # 工具层：lossless JSON / JSON Schema / 只读用例 + 截图删除双保险（30 项）
node tests/deploy-test.mjs        # 部署与备份**安全**：备份失败不覆盖 / 原子写 / 固定名 / 回滚 / 双钥匙 / 自覆盖拦截（28 项，临时目录）
node tests/probe-deploy-test.mjs  # 探针部署：用假存档根跑通 deploy→collect，不碰真活文件；含「每个模板都能过结构校验」（10 项）
node tests/lualint-test.mjs       # Lua 结构校验器：合法构造不误报 / 写坏的必须报对行号 / 15 个真文件回归（32 项）
node tests/logdiag-test.mjs       # 试玩体检判据：四种结论 / 阈值边界 / 拿不到进程也不能乱猜（9 项）
node tests/shot-test.mjs          # 截图：命名 / 目录解析 / 清理规划 / 可信度判据 / 真删双钥匙 + 真机调用失败路径（59 项）
node tests/client-render-test.mjs # L3 真实 React 渲染：入口文案 / 窄态 / 令牌 fallback / 无幽灵 / 日志格式化 / 备份卡片 / 读界面控件 / 截图卡片（30 项）

# —— 开发用小工具（不随包发布）——
node tools/lint-probes.mjs         # 把 5 个探针模板渲染出来逐个校验，出错打印上下文行
node tools/lint-all.mjs ../../code # 对整个 code/ 目录跑结构校验
node tools/live-render-check.mjs   # **向运行中的 Host** 要模板渲染结果并校验（防「跑着的是旧版」）
node tools/render-probe.mjs api-surface   # **从磁盘**渲染模板并落到 code/<玩法>/（Host 是旧版时用这个）
node tools/dump-panel-text.mjs 探针  # 把面板**渲染后的纯文字**打出来 —— 改文案时先自己读一遍用户会看到什么
node tools/shot-live.mjs game      # **真机截图**并把路径打出来 —— 截图对不对只有看图才知道
node tools/shot-live.mjs --list    # 只看截图目录里有什么
node tools/shot-live.mjs --cleanup # 清理演练（dryRun，不删）

# —— L4 真机（改完 Host 半边、重启 dsh web 之后）——
node tests/live-check.mjs                    # 默认 http://127.0.0.1:3080
```

> `patchReload: live` **不会重新 import Host 模块**，所以「磁盘上是对的」≠「跑着的那份是对的」。
> 部署探针前先跑 `tools/live-render-check.mjs`，免得把旧版模板投进沙箱。

### 探针的硬边界（2026-09-23 实机结论，别再踩）

| 想查 | 能不能 | 说明 |
|---|---|---|
| `Enum.*` 子表有哪些成员、值是什么 | ✅ | `pairs(Enum.某子表)` 正常；`Enum.KeyEventType` 实测 **164 项**，与离线文档抽取**逐项对上** |
| `_G` / `game` / `script` 的成员 | ❌ | `pairs()` 全返回 **0 项**（宿主对象不暴露 raw 表），只能按名字取 |
| 画布尺寸 | ✅ | `game.GetUICanvasSize()` 返回**浮点**（`1599.9998 x 999.9998`），比较要留容差 |
| 场景里有哪些客户端控件 | ✅ | `game.GetClientUIRoots()` + `GetClientUIControl(id)` |
| 某个 `prefabIndex` 能不能被创建 | ✅ | 见「关键知识」第 1 条，用 `instantiate` 模板 |
| 控件真实渲染出来的像素 | ❌ | 探针只能打文本；观感要截图 |

> ⚠️ **单条日志消息上限实测正好 10000 字符**，超出的部分**静默截断**（不报错、不提示）。
> 写自己的探针时，长表格/长列表**务必分片打印** —— 否则会得出「枚举里没有这个键」这种反向结论。
> 内置模板统一走 `pChunked()`（3500 字符一片、带 `(1/3)` 标记）。

> `client-render-test.mjs` 需要 `react` / `react-dom`（已列为 devDependency，`npm install` 即可）。
> 本机 dsh 把 react 内联进了前端 vendor 产物，没有独立的 react 包可 require，所以这一层用本包自带的真 React 渲染。

### 验证阶梯

| 层 | 命令 | 证明了什么 | 证明不了什么 |
|---|---|---|---|
| L1 | 技能 `selftest.mjs`（16 项） | 两个半边的契约、工具注册形状、路由信封、cleanup 可回收 | 真实渲染、真实装配 |
| L1 | 上面六个单元测试（168 项） | 部署/探针的字节级行为，Lua 结构校验器不误报也不漏报，截图清理判据不误删 | 同上 |
| L3 | `client-render-test.mjs`（30 项） | 组件真能渲染、窄态/关闭态正确、**样式无裸色值**、**粉蓝视觉身份与结构件齐全**、**图标是合法内联 PNG**、信封剥离正确、**日志格式化 / 自动取回判据 / 备份卡片 / 读界面控件 / 截图卡片 讲清后果** | 壳会不会把它挂上去 |
| L4 | `live-check.mjs`（9 项） | 宿主里工具可用、路由可用、`/status` 报出 `clientHalf` | **像素有没有画出来** |

**合计 214 项**（198 + 自检 16；不含需要 `dsh web` 在跑的 L4 那 9 项）。
`shot-test.mjs` 里另有 2 项走**真实 `powershell` 调用**，但只走失败路径（进程不存在 / 脚本不存在），
所以既不依赖游戏开着，也不产生图片。

`live-check.mjs` 覆盖：状态路由、工具按名调用、`health` / `log` / `map` 四个只读工具真跑一遍、
`echo` 回显、未知路由 404。**它证明不了「侧边栏面板真的渲染出来了」** —— 那需要刷新页面用眼睛看一眼。

### 生效边界（实测，别猜）

| 改了什么 | 怎么生效 |
|---|---|
| `index.js` / `lib/*.mjs`（**Host**） | **必须重启 `dsh web`**。实测：删改 `cordis.patch.yml` 触发 `patchReload: live` 重载后，`/miliastra/status` 仍是旧字段 —— **live 重载不会重新 import Host 模块** |
| `lib/client.js`（**Client**） | 刷新浏览器。client bundle 在激活时被读进内存 |
| `package.json` / `exports` / `dsh.profile.bundles` | 重启（bundle 列表在启动时快照） |

### 自检「面板有没有真的被下发」

`GET /miliastra/status` 会带一个 `clientHalf` 字段 —— 它向宿主 `dsh-client-modules` 服务要
compose 好的 boot 图（也就是 `window.__DSH_BOOT__`），确认本包那一行确实在里面：

```jsonc
"clientHalf": {
  "declared": true,
  "inBootGraph": true,          // ← 这一行为 true，浏览器才会加载面板
  "entryId": "dsh-miliastra",
  "url": "/plugins/??dsh-miliastra/client.js&rev=<内容哈希>",
  "rev": "1b6f8c3a25a6",
  "note": "本包的 client bundle 已进入 window.__DSH_BOOT__ 图 —— 浏览器会加载它"
}
```

`rev` 是 **bundle 内容的哈希**：改完 `lib/client.js` 再查 `/status`，这个值会变
（实测从 `1c199bcb7fe6` → `be02b7acd127`）—— 所以「刷新页面能不能拿到新版」有机器凭据，
不用靠猜。

这是**不需要人眼**的最强证据（再往下就只剩「像素有没有画出来」了）。

### 客户端排障：先看控制台的三条日志

`lib/client.js` 故意在三个位置打了日志（client 半边默认是**全静默**的，这是排障最贵的地方）：

| 控制台 / 宿主日志看到 | 说明 |
|---|---|
| **`failed to apply loader entry (…): cannot get property "slots" without inject`** | Client 半边的 `exports.inject` **没声明 `slots`**。cordis 的服务代理是受限的：不声明就直接读 `ctx.slots` 会抛错，**并让整条 loader entry 失败**。必须 `exports.inject = ['slots']` |
| 一条 `[dsh-miliastra]` 都没有 | bundle **根本没被执行** → 宿主侧的 client 组装问题 |
| 有 `factory 已执行`，没有 `apply 运行中` | 模块系统没 materialize 本包 |
| 有 `apply 运行中：react=无` | 平台没提供 react 单例 |
| 有 `apply 运行中`，3 秒后出现 `没等到 sidebar.footer.action 的声明` | 这一版壳没渲染该槽位（或槽位名变了） |
| 有 `入口已注册到 sidebar.footer.action` 但界面看不到 | 壳渲染了槽位但忽略了条目 |
| 有 `面板注册失败：` 前缀 | apply 内部抛错被 catch |

> ⚠️ **教训**：服务一律「先声明再访问」（`exports.inject = ['slots']`），并且
> **诊断日志本身也要放进 `try` 里** —— 否则一行 `ctx.slots` 的探针就能把整个插件打死，
> 症状还是最难看的那种：宿主报 `failed to apply loader entry`，页面上却一条我们的日志都没有。

契约取证自本机 `dsh 0.1.5-rc.1`：

- `sidebar.footer.action` — kind `list` / scope `root`，owner props 只有 `{ wide: boolean }`
  （占用者先例：`@deepseek-ai/dsh-client-ui-cordis` 的 `CordisPanel`）
- 客户端 bundle = `window.__ModuleLoader__.load({ id, factory })` 的 CJS 表
- `require` 可拿到平台单例：`react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`

## License

[Apache License 2.0](LICENSE) · Copyright 2026 LoktLin

可自由使用、修改、分发（含商用），需保留版权与许可声明，且不提供任何担保。完整条款见 [LICENSE](LICENSE)。
