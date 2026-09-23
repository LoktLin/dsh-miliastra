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
> **③ 日志**（历史局面 · TAG 汇总 · 探针一键）。

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
| **`miliastra_code`** | 活文件的 读 / 部署 / 体检 / 还原。部署一律：**先备份 → 二进制拷贝 → 比对 SHA-256 → 校验无 BOM** | 改完本地脚本要投进沙箱时 |
| **`miliastra_map`** | 读 `<关卡ID>.gil`：关卡信息、**客户端控件谱系**（控件模板索引 / 名字 / 父 / 子）、脚本源码快照比对 | 判断「哪些控件能被脚本动态创建」、判断「跑的是不是本地这版代码」 |
| **`miliastra_log`** | 读 `.gia` 运行时日志：列局面、结构化读正文、按 TAG / 正则过滤、汇总标签 | **运行时取证**（Lua 里 `print`，别靠猜）。比让人手动贴日志可靠得多 |
| **`miliastra_probe`** | 探针模板化：`tree` / `instantiate` / `ping` 三个只读诊断脚本，渲染 → 部署 → 试玩后 `collect` 回收结论 | 需要运行时真相时 |
| `miliastra_echo` | 回显参数 | 怀疑插件没生效 / 参数丢了时先调它 |

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
| **③ 日志** | 局面数 / 最近一局 / **历史局面胶囊**（点某一局只看那一局）<br>**TAG 汇总** / 按 TAG 过滤（点胶囊即过滤）/ 日志正文<br>**探针**：选模板 → 部署（覆盖活文件，带二次确认）→ 重新试玩 → **收回结论**

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

### 备份与还原

活文件没有 git、没有撤销，**覆盖即丢失** —— 这是唯一的安全网。

| | 说明 |
|---|---|
| **备份什么** | **只有活文件 `.lua`**（不备份 `.gil`、不备份已发布的图） |
| **什么时候** | `op=deploy` 覆盖前自动备份；`op=backup` 手动；`op=restore` 还原前**再备份一次当前版本** |
| **备份到哪** | 活文件同级 `_backup\`，命名 `<原名>_<YYYYMMDDHHMMSS>_备份.lua`（可用 `MILIASTRA_BACKUP_DIR` 换目录） |
| **会互相覆盖吗** | 不会。**同秒撞名自动顺延 `-2 / -3`**（时间戳只到秒，撞了就盖掉前一份备份是不可接受的） |
| **还原安全吗** | 四步：① 列出让你选（不自动选）② **还原前把当前版本再备份一份** ③ 覆盖后比对 SHA-256 ④ 回报「从哪份还原的 / 当前 sha / 安全备份路径」 |
| **拒收什么** | 带 UTF-8 BOM 或非法 UTF-8 的备份 —— **还原坏文件比不还原更糟** |
| **会删旧备份吗** | **不会**。份数 ≥20 或总占用 >5 MB 时只提示，清理由你自己决定 |

```powershell
miliastra_code op=backups              # 列备份（时间/SHA/是否带 BOM）
miliastra_code op=backup               # 手动备份
miliastra_code op=restore backup=<路径> # 还原（自动双保险）
miliastra_code op=inspect file=角色B.lua # 指定活文件体检
```

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
- ❌ **编辑器 UI 层没有自动化通道**：在模板库里点【添加客户端控件】、给容器节点挂脚本、建容器 ——
  这些必须在编辑器里由人完成。本插件替代的是「人和 AI 之间的来回搬运」，不是编辑器操作本身。
- ❌ 不做场景写操作：工具全部只读或只写「活文件」（脚本本身），不碰地图数据。

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
node tests/smoke.mjs              # 工具层：lossless JSON / JSON Schema / 只读用例（21 项）
node tests/deploy-test.mjs        # 部署与备份：哈希 / 拒收 BOM / 拒收非法 UTF-8 / 备份撞名顺延 / 列备份 / 安全还原（12 项，临时目录）
node tests/probe-deploy-test.mjs  # 探针部署：用假存档根跑通 deploy→collect，不碰真活文件（7 项）
node tests/client-render-test.mjs # L3 真实 React 渲染：入口文案 / 窄态 / 令牌 fallback / 无幽灵（10 项）

# —— L4 真机（改完 Host 半边、重启 dsh web 之后）——
node tests/live-check.mjs                    # 默认 http://127.0.0.1:3080
```

> `client-render-test.mjs` 需要 `react` / `react-dom`（已列为 devDependency，`npm install` 即可）。
> 本机 dsh 把 react 内联进了前端 vendor 产物，没有独立的 react 包可 require，所以这一层用本包自带的真 React 渲染。

### 验证阶梯

| 层 | 命令 | 证明了什么 | 证明不了什么 |
|---|---|---|---|
| L1 | 技能 `selftest.mjs`（16 项） | 两个半边的契约、工具注册形状、路由信封、cleanup 可回收 | 真实渲染、真实装配 |
| L1 | 上面三个单元测试 | 部署/探针的字节级行为 | 同上 |
| L3 | `client-render-test.mjs`（14 项） | 组件真能渲染、窄态/关闭态正确、**样式无裸色值**、**粉蓝视觉身份与结构件齐全**、**图标是合法内联 PNG**、信封剥离正确 | 壳会不会把它挂上去 |
| L4 | `live-check.mjs`（8 项） | 宿主里工具可用、路由可用、`/status` 报出 `clientHalf` | **像素有没有画出来** |

`live-check.mjs` 覆盖：状态路由、工具按名调用、`health` / `log` / `map` 四个只读工具真跑一遍、
`echo` 回显、未知路由 404。**它证明不了「侧边栏面板真的渲染出来了」** —— 那需要刷新页面用眼睛看一眼。

### 客户端排障：先看控制台的三条日志

`lib/client.js` 故意在三个位置打了日志（client 半边默认是**全静默**的，这是排障最贵的地方）：

| 控制台看到 | 说明 |
|---|---|
| 一条 `[dsh-miliastra]` 都没有 | bundle **根本没被执行** → 宿主侧的 client 组装问题 |
| 有 `factory 已执行`，没有 `apply 运行中` | 模块系统没 materialize 本包 |
| 有 `apply 运行中：react=无` | 平台没提供 react 单例 |
| 有 `apply 运行中`，3 秒后出现 `没等到 sidebar.footer.action 的声明` | 这一版壳没渲染该槽位（或槽位名变了） |
| 有 `入口已注册到 sidebar.footer.action` 但界面看不到 | 壳渲染了槽位但忽略了条目 |
| 有 `factory 已执行` 但完全没有 apply 之后的日志 | apply 抛错被 catch（会有 `面板注册失败` 前缀） |

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
  "bundle": { "path": "…/lib/client.js", "size": 17523 },
  "note": "本包的 client bundle 已进入 window.__DSH_BOOT__ 图 —— 浏览器会加载它"
}
```

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
