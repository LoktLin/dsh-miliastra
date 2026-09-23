# 需求边界清单：把 `miliastra-beyond-simulator` 全量融合进 `dsh-miliastra`

日期：2026-09-24　平台：**千星奇域（原神 UGC / Miliastra Wonderland）** · 载体是 DSH 插件工程
项目/工程：`packages/dsh-miliastra`（分支 `dev-beyond-simulator`，自 `eaea62c` 起）
需求来源：口述（本会话）+ 上一轮已完成的对比报告 [`dsh-miliastra_对比_miliastra-beyond-simulator_2026-09-24.md`](dsh-miliastra_对比_miliastra-beyond-simulator_2026-09-24.md)

> 平台识别：识别为 **千星奇域**（依据：需求全程围绕千星沙箱 / `levelScript` / 客户端控件 / `.gil` / `.gia`）。
> 适配文件已加载：`~/.dsh/skills/ugc-bb/references/platforms/yuan.md`。
> ⚠️ 本需求**不是游戏玩法需求，而是插件工程需求** —— 因此四层比对的"层"按**插件工程**落（逻辑=Host 工具与 lib／挂载=patch 与 bundle 声明／资源=面板 UI／能力=本机 DSH 提供的 slot 与模块 id），
> 千星域适配文件里"创作者交接清单"那一套**本需求不适用**（AI 不需要向任何人要控件索引）。
> 清单落盘：本工程自身 `docs/`（该仓的"项目文档"目录；平台适配文件惯例的 `project-docs/` 在本仓不存在，不新建替身）。

---

## 需求原文（R 编号，逐字保真，不许改写）

- **R1**：「新建一个dev-beyond-simulator的分支进行融合测试」
- **R2**：「全量融合」
- **R3**：「在我的插件里面增加顶部一个tab页面 现在的页面分成两个初级功能和高级功能 + 模拟器」
- **R4**：「我想代码级别融合」
- **R5**：「看下开源许可支不支持二开和融合」
- **R6**：「2.新建一个dev开发分支,融合一下」（前一轮）
- **R7**：「1.看看功能边界,看看能力和写法,与我们直接的代码进行对比下」（前一轮）

R5/R7 已在上一轮完成（对比文档 + 许可结论）；R6 已产出 `dev` 分支；R1 已产出 `dev-beyond-simulator` 分支（`eaea62c` → `origin/dev-beyond-simulator`）。

---

## R ↔ FP 映射表（F4 追溯矩阵）

| R | 落到的 FP | 状态 |
|---|---|---|
| R1 | FP1（分支） | ✅ 已落地（证据：`git branch -vv` 显示 `dev-beyond-simulator eaea62c [origin/dev-beyond-simulator]`） |
| R2 | FP3 FP4 FP5 FP7 FP8 FP9 FP10 | 🟡 待确认边界（全量融合的范围与形态未定，见待确认 Q1） |
| R3 | FP5 FP6 FP7 | 🟡 待确认边界（tab 承载方式与初级/高级划分未定，见待确认 Q2） |
| R4 | FP2 FP10 | 🟡 待确认（许可变更与构建形态绑定） |
| R5 | FP2 | ✅ 已核（GPL-3.0-only 支持二开；代码级融合 ⇒ 整仓改 GPL-3.0-only） |
| R6 | FP1 | ✅ 已落地（`dev` 分支，`origin/dev`） |
| R7 | —（产出物是对比文档，不是代码 FP） | ✅ 已完成 |

**覆盖率**：R1–R7 全部有落点；无孤儿 FP（每个 FP 至少挂一条 R）。

---

## A组：新增能力/需求（需确认边界后开发）

> 本需求**无 B组（改 bug）**：全部是"引入外部能力 + 改变现有插件形态"，六问判定器每一问都指向 A组（新增能力 / 新增依赖 / 新增 UI 形态 / 改了预期）。

| 功能点 | 出处R | 现状比对 + 证据 | 待确认边界 | 交接给 |
|---|---|---|---|---|
| **FP1 分支 `dev-beyond-simulator`** | R1 | ✅ 已存在 | — | — |
| **FP2 许可定性**（换 GPL-3.0-only or 维持 Apache-2.0） | R4,R5 | 🟡 现为 Apache-2.0（`package.json:49` + Apache 全文 `LICENSE`）；对方每个 package 均 `GPL-3.0-only`（`LICENSE` 34 674 B）。**Q1 选 C 后口径反转**：独立重写不构成衍生品 ⇒ 可维持 Apache-2.0 | 维持还是更换 + NOTICE 致谢的写法（Q4 轮） | 本技能出方案 → 直接改本仓 |
| **FP3 融合引擎代码**（studio 的 `gia/` `ui/` `play/` `host-png.js` `autotest/` `log/`＋`client/lua-runtime`＋`server`＋`editor-ui`） | R2,R4 | ❌ 我们完全没有：`lib/` 15 个文件全部是"读盘/取证/截图"（`gil.mjs` 10 395 B 只读、`gia.mjs` 8 624 B 日志解析）；对方 `studio/gia/codec.js` 71 649 B **双向**编解码 | 形态（vendored 源码 / 预构建产物 / 拆散重写）→ **Q1** | 本仓（宿主侧）+ 复核走 `yuan-code` 的 API 纪律 |
| **FP4 融合 Host 半边**（`/qxqy-simulator/api/*` 路由 + Controller/Worker + 6 个 `qxqy_studio_*` 工具） | R2 | 🟡 我们已有 8 个 `miliastra_*` 工具（`index.js` TOOLS）与自己的路由；对方 6 工具（`skill/SKILL.md:135-140`） | **工具命名空间**：保留 `qxqy_studio_*` 并存 / 并入 `miliastra_*` 前缀（Q5 轮） | 本仓 |
| **FP5 Client 半边注册 `conversation.view` 三个 tab** | R3 | 🟡 我们目前只注册 `sidebar.footer.action` + 浮层面板（`lib/client.js:4`、`1995+`）；对方注册 `conversation.view`（`dsh-plugin/lib/client.js:21`，`label: () => '模拟器'`，`order: 20`） | **承载方式** → **Q2** | 本仓 |
| **FP6 现有面板拆成「初级功能 / 高级功能」** | R3 | ✅ 素材齐备：现面板 = 10 张卡片 —— 关卡(`client.js:1195`)、关卡与文件(`1196`)、地图体检(`1197`)、活文件(`1345`)、活文件体检(`1346`)、脚本一致性(`1348`)、试玩开跑(`1854`)、运行时日志(`1856`)、游戏截图(`1857`)、高级诊断(`1871`)；后者已内含「读界面控件 + 探针」，且代码注释里留着作者原话：「折腾探针对人没啥用啊」「关键 ui 读取……做到高级功能里面做个样子」 | 哪些进初级/哪些进高级 → **Q2** | 本仓 |
| **FP7 「模拟器」tab 承载对方 `editor-ui`** | R3,R2 | ❌ 没有；对方 `editor-ui/index.js` 93 932 B（三栏：控件树 / 画布 / 检视器），需 React + 其 API 与 `playUrl`；我们面板是浮层窄栏 | 形态绑定 Q1；承载绑定 Q2 | 本仓 |
| **FP8 独立试玩页 `/qxqy-simulator/play`（PixiJS v8 WebGL）** | R2 | ❌ 没有；对方 `dsh-plugin/lib/play.html` 23 562 B + `studio/play/pixi-renderer.js` 15 087 B | 要不要一并融合（Q6 轮） | 本仓 |
| **FP9 融合对方的 skill（`qxqy-simulator`）与 agent 预设（`wonderland-lua-builder`）** | R2 | 🟡 我们的知识在 workspace `AGENTS.md` + `docs/` + 宿主技能 `yuan-code`；对方把 skill 打进插件（`skill/SKILL.md` 14 507 B，经独立 bundle 行 `ctx.skills.register`）、预设 `agent/wonderland-lua-builder/` | 要不要一并融合（Q6 轮） | 本仓 + workspace 文档 |
| **FP10 依赖与构建** | R4,R2 | ❌ 我们 **0 运行依赖**（`package.json:50-53` 只有 devDeps react/react-dom）、**无构建步骤**（`lib/client.js` 是手写 JS）；对方 3 运行依赖 + esbuild 构建 + pixi 打进浏览器资源 | 形态绑定 Q1 | 本仓 |
| **FP11 术语消歧：`.gia` 同名不同物** | R2,R4 | ⚠️ 实测：我们 `.gia` = 客户端**运行时日志**（`lib/gia.mjs` 头注释：8 字节包头 + 每条日志正文在字段 `#23→#2`）；对方 `.gia` = 千星**界面资产包**（`studio/gia/codec.js:14` `message Root { repeated GraphUnit graph = 1; …}`） | 融合后文档/工具里的命名口径（Q6 轮） | 本仓 `docs/` |
| **FP12 测试归属** | R2 | ✅ 我们 462 项（11 子集 + 契约自检 16）；对方 162 项（20 文件 / 169 `test()` / 1 079 `assert.`）。两套都要能独立跑 | 融合后由谁跑、契约自检是否覆盖新依赖（Q6 轮） | 本仓 |

---

## 能力层证据（本机 DSH 0.1.5-rc.1，逐条可复现）

| 结论 | 证据 |
|---|---|
| 有 `conversation.view` 槽位，语义 = 会话区**顶部 tab** | `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js:15124` `renderSlot("conversation.view", …)`；`:16544` `slots.entries("conversation.view")` |
| 该槽位契约：每个 entry 投影成一个 `ViewTab { id, label }`，`label` 缺省回退成 entry id；默认视图是 Chat | 同包 `lib\types\client\contract\views.d.ts:3-8,18-25` |
| 对方正是这么挂的（可照抄的现成写法） | `_ref/…/dsh-plugin/lib/client.js:17-22`：`exports.inject=['slots']` → `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id:'qxqy-simulator', order:20, label:()=>'模拟器' }, editor.SimulatorView))` |
| 我们与对方**加载约定同源**（都是 `window.__ModuleLoader__.load` + `module.exports` + `exports.inject`,只需换注册的槽位） | 我们 `lib/client.js:35-45, 1976, 2035`；对方 `dsh-plugin/lib/client.js:3-25` |
| 我们当前 `dsh.client.inject` 为空 | `package.json:37-40` `"client": { "platform": "web", "inject": [] }` |
| ⚠️ **风险**：对方 `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 在本机 DSH 内**0 命中**（`dsh-client-ui-slots` 51 命中、`dsh-client-ui-conversation` 27 命中、`dsh-agent-preset` 30 命中） | `Get-ChildItem …\@deepseek-ai\dsh -Recurse … Select-String 'dsh-client-runtime'` → 0 |
| 本机 DSH 版本 | `@deepseek-ai/dsh` = **0.1.5-rc.1**（我们 `engines.dsh: >=0.1.2-rc.1`；对方预设要求 ≥0.1.7-rc.1 才启用新版注册） |

---

## 第 1 轮 · 决策点 Q1+Q2（形态）

**背景**：
- R2「全量融合」有两条完全不同的路：把对方**源码**搬进来（需要引入 esbuild 构建 —— 我们仓今天**没有任何构建步骤**，`lib/client.js` 是手写 JS、`package.json` 无 `dependencies`），或搬**预构建产物**（他们 npm 包里就是 `dsh-plugin/dist`：`index/worker/skill/preset.js` + `play-renderer.js` + minify 过的 `client.js`）。
- R3「顶部 tab」在 DSH 里有现成落点：`conversation.view`（会话区顶部 tab，契约已核），对方就是这么挂「模拟器」的；备选是在我们**现有浮层面板内部**做三条 tab（不占会话区）。

**问法**：
- Q1 融合形态 → A 源码搬入 + 引入 esbuild 构建（可改可测、透明；代价：我们仓第一次有构建步骤与 devDep）／B 只搬预构建 dist（零构建；代价：压缩代码不可读不可改，出 bug 只能等上游）／C 拆散重写进我们"零依赖 + 无构建"的手写风格（最干净；代价：`editor-ui` 93 KB 要重写，周期最长）。
- Q2 tab 承载 → A 注册 `conversation.view` 三个 tab（初级功能 / 高级功能 / 模拟器），与官方「对话」并列，模拟器得到全宽三栏（**推荐**，因为 `editor-ui` 是三栏宽版）／B 只在我们浮层面板内部加 tab 条，不动会话区。

**用户选择**：✅ **Q1 = C 拆散重写进我们的手写风格**；✅ **Q2 = A 注册 `conversation.view` 三个 tab**

**意图解读**：
- 选 C 而不是 A/B，说明作者要的是**这一份代码从此是自己的**（可读、可改、风格统一、不背别人的构建链与压缩产物），而不是"尽快用上别人的能力"。这与本仓既有取向一致（0 运行依赖、`lib/client.js` 手写 React、测试全是 `node:x.mjs` 直接跑）。
- 选 A（会话区全宽三 tab）说明 R3 的"顶部 tab"指的是**官方会话区那个 tab 条**，不是面板内的小 tab；也侧面说明「模拟器」是要**当正经工作区用**的（需要全宽三栏），不是顺手看两眼的小面板。

**影响回填（★ 两条，其中一条改了 R4 的口径）**：
1. **许可结论变了**：Q1 从"代码级融合"变成"**独立重写**" ⇒ **不再构成 GPL 衍生品，本仓可以保持 Apache-2.0**（Q4 拍板）。边界是：只吸收**事实**（字段号/类型/布局/行为约定），**不抄表达**（代码、注释、命名、结构）；并在文档里如实致谢来源。⚠️ 反过来说：**若实际做法是"照他们的代码改写成我们的风格"，那依然是衍生品，GPL 照样适用** —— 这条我按"事实/表达"分界执行，落地时逐文件自查。
2. **R2「全量融合」在当前形态下不可能字面成立** ⇒ 见「F4 曲解警报」。

---

### ★ F4 曲解警报（必须回问，不许自己拍板）

R2 原文是「**全量**融合」，但 Q1 选 C（独立重写）之后，"全量"在物理上做不到。对方那份"全量"里，有东西**不可能手写**：

| 对方的能力 | 手写可行性 | 说明 |
|---|---|---|
| `.gil` / GIA 双向编解码 | ✅ **能** | protobuf 编解码可手写（我们 `lib/gil.mjs` 已经是手写解码）；**字段号/类型/布局属事实**，可吸收 |
| **Lua 5.3 执行**（fengari 1 602 KB） | ❌ **不能** | 一个 Lua 5.3 VM 是数十万行级实现（fengari 是 C Lua 的 JS 移植）。零依赖手写不现实 → 这块**只能二选一**：破例引入 `fengari`（MIT、纯 JS、无原生、无构建），或**放弃"在 PC 上跑脚本"** |
| 试玩页 WebGL 渲染（pixi.js） | 🟡 降级可行 | 手写 WebGL 引擎不现实；可降级成 canvas 2D + DOM 事件（还原度/性能差一档） |
| Host 内出 PNG（`@napi-rs/canvas` 37 MB 原生） | ✅ **能** | 用 Node 自带 `zlib` **手写 PNG 编码器**即可（本仓已有缩略图链路的经验），无需原生模块 |
| MCP / Web 自托管服务 | ✅ 能 | 纯 Node，无第三方依赖 |

**两个必须由作者拍板的推论**：
1. 「全量」要重新定义为**分层能力**，且 **Lua 执行**这一层是否破例引入 `fengari` —— 这是第 2 轮 Q3。
2. **许可结论反转**：独立重写 ⇒ 不构成 GPL 衍生品 ⇒ 本仓**可以保持 Apache-2.0**（第 2 轮 Q4）；但若实际做法是"照抄改写"，GPL 依然适用 —— 落地按"事实/表达"分界逐文件自查。
3. 另一个容易被低估的成本：**他们的知识库不在仓库里**（`knowledge/`、`docs/`、`probes/` 均未入库，见对比文档 §5.2），连"事实"都要我们自己重新挖。

---

## 第 2 轮 · 决策点 Q3+Q4（C 路径下的能力层与许可）

**背景**：见上「F4 曲解警报」。C 路径把"融合别人的引擎"变成了"重建引擎"，所以要先把**做到哪一层**和**许可**钉死。

**问法**：
- Q3 = 「模拟器」tab 先做到哪一层？A 只读检视（`.gil` → 控件树 + 属性 + 2D 画布预览，零依赖）／B A + 编辑 + 写回 `.gil`（手写 protobuf 编码，写回能否被官方编辑器接受**未验证**）／C B + 执行 Lua（**破例引入 fengari**，MIT 纯 JS）。
- Q4 = 许可维持 **Apache-2.0**（独立实现）还是仍换 GPL-3.0-only？

**用户选择**：✅ **Q3 = 「全吸收融合 将对话测试子集作为回归测试的dome」**（原文照抄）；✅ **Q4 = 现在就想换成 GPL-3.0-only**

**意图解读**：
- 选「全吸收」而不是 Q3 里任何一层 ⇒ 作者不接受"先做只读检视"这种分层裁剪，**三层都要**（检视 + 编辑写回 + **执行 Lua**）。这与 R2「全量融合」口径一致，也解释了他为什么在 Q1 选 C 之后仍要求全量：他要的是**最终形态完整**，不是最小可用。
- 「将对话测试子集作为回归测试的dome」有两种读法，**必须回问**（见第 3 轮 Q6）：(i) 把**对方的测试子集**搬进来当我们的回归测试；(ii) 把**「会话区三 tab」这条链路**先做成带回归测试的 demo。
- 选「现在就想换 GPL-3.0-only」 ⇒ 他愿意**现在就放弃 Apache 的宽松度**，通常意味着打算**吸收对方代码/测试本体**（否则独立重写不需要换）—— 这一条与 Q1=C（重写）**字面冲突**，必须对齐（见第 3 轮 Q5）。

**影响回填（⚠️ 出现三条互斥，未对齐前不动手）**：
| 已定 | 与谁冲突 | 冲突点 |
|---|---|---|
| Q1 = C（拆散重写进手写风格，零依赖无构建） | Q3 全吸收 + Q4 换 GPL | C 的卖点是"自己的代码、无构建"；全吸收+GPL 的卖点是"直接拿他们的代码与测试"。两者只能选一个作为**落地方式** |
| Q3 = 全吸收（含执行 Lua） | Q1 = C | 执行 Lua **不可能手写**，全吸收就必须引入 `fengari`（0 依赖 → 1 依赖） |
| Q4 = 换 GPL-3.0-only | Q1 = C（独立实现本可留 Apache） | 若最终仍是独立重写，换 GPL 是无收益的自缚；若是吸收代码，换 GPL 是**必须** |

→ 三条对齐后就写「方案级实现方案」+ 工单，**对齐前不写任何代码**。

---

## 第 3 轮 · 决策点 Q5+Q6（对齐冲突 + 回归测试含义）

**背景**：上表的冲突必须由作者一次拍板，否则落地方式无法唯一确定。

**问法**：
- **Q5（形态归属）**：吸收对方的**代码与测试本体**（⇒ 许可按 Q4 换 GPL-3.0-only，落地快、能力全，但本仓从此有构建步骤与依赖，代码风格两套）／还是**只吸收能力与事实、自己重写**（⇒ 风格统一、可长期维护，但慢，且"全吸收"要拆成多期交付）。
- **Q6（回归测试含义）**：「将对话测试子集作为回归测试的dome」指的是 (i) 搬**对方的测试子集**进来当本仓回归测试／(ii) 先把**「会话区三 tab」这条链路**做成 demo + 回归测试／(iii) 其他（作者补充）。

**用户选择**：✅ **Q5 = C 混合：引擎吸收源码，UI 自己写**；✅ **Q6 = (i) 搬对方的测试子集当回归**

**意图解读**：
- 选混合（既不"全盘吸收"也不纯重写）说明作者分得清两层价值：**引擎是可复用的既有资产**（`.gil` 编解码 / Lua VM / 渲染 / 授权模型 —— 逆向成本极高、重写无收益，且已带 169 项测试兜着）；**UI 是这个插件的门面**（tab 形态、中文措辞、与现有面板一致的观感 —— 必须自己说了算）。这和他 Q2 挑"会话区三 tab"是一致的：那是**我们的**界面形态。
- 选 (i) 说明他要的"回归"不是再写个 demo，而是**真能跑的既有断言**（169 test / 1 079 assert）—— 把对方的测试当作搬入代码的**质量锚**。

**影响回填（★ 三条冲突已对齐，落地方式从此唯一确定）**：

| 维度 | 定稿 |
|---|---|
| **引擎层**（吸收对方源码） | `studio/{gia, ui, play, host, host-png.js, log, autotest, json.js, constants.js}`、`client/lua-runtime`、`server` —— 随源码保留其 LICENSE 与版权声明 |
| **UI 层**（我们自己手写） | `conversation.view` 三个 tab（初级功能 / 高级功能 / 模拟器）+ 模拟器视图本体；**不搬** `editor-ui/`（93 932 B 的对方三栏编辑器） |
| **适配层**（我们自己写） | 我们自己的 Host 路由 + 工具；**不搬**对方的 `dsh-plugin/`、`web/`、`mcp/` |
| **许可** | 整仓 → **GPL-3.0-only**（Q4 已定；因为吸收了引擎源码，这是**必需**而非可选） |
| **依赖 / 构建** | 随引擎引入 `protobufjs`（codec 3.6 MB）、`fengari`（Lua VM 1.6 MB）、`@napi-rs/canvas`（host-png，Windows 原生 37.4 MB）、`pixi.js`（浏览器渲染，打进产物）⇒ 本仓**第一次有 esbuild 构建步骤** |
| **测试** | 搬对方 20 个测试文件 / 169 test / 1 079 assert 当回归；我们自己的 462 项继续跑 |
| **Q1 的处置** | Q1=C（拆散重写）**被 Q5 覆盖**并改判为"引擎吸收源码 + UI 手写"；Q1 只保留其中**"UI 手写"**这一半 |

---

## 步骤 6：边界复核（确认后重查一次）

**F4 覆盖率硬校验**：
- R1（分支）→ FP1 ✅｜R2（全量融合）→ FP3 FP4 FP5 FP7 FP8 FP9 FP10 → **改判说明**：因 Q5=混合，"全量"的**引擎面**全数落 FP3/FP10，**UI 面**（对方 editor-ui）由 FP7 以"我们自写"承接，**不再算漏做** ✅｜R3（三 tab）→ FP5 FP6 FP7 ✅｜R4（代码级融合）→ FP2 FP10（改判：融合=引擎吸收，UI 自写）✅｜R5（许可）→ FP2 ✅｜R6（dev 分支）→ FP1 ✅｜R7（对比）→ 已产出文档 ✅
- **孤儿 FP**：无（每个 FP 都挂 R）。**孤儿 R**：无。
- **曲解警报**：R2 的"全量"与 R4 的"代码级"都**已回问并经作者拍板改判**（Q5=C 混合），不是自行缩水 —— 警报清零。

**证伪（反例检查）**：
- "引擎吸收源码"在本机 DSH 0.1.5-rc.1 上跑得起来吗？→ **引擎层不依赖 `conversation.view`/`client-runtime`**（那些只属客户半边），所以 `dsh-client-runtime` 0 命中的风险**只影响 UI 层**，而 UI 层本来就是我们自写 → 风险被 Q5=C 顺带消掉 ✅
- 对方测试搬进来能跑吗？→ 它们的 `import` 只指向本仓将搬入的引擎模块（`node:test` + `node:assert/strict`），但**用到 `@napi-rs/canvas`/`pixi.js` 的用例**需要依赖装好 —— 记入 W2 的验收条件。
- 会不会动到用户手工成果？→ 本需求**只动 `packages/dsh-miliastra`（插件源码）**，不碰千星地图活文件、不碰用户控件/摆位、不碰游戏存档 ✅

**模糊转量化**：
| 模糊说法 | 量化判据（正例 / 反例） |
|---|---|
| "三个 tab 能用" | 正例：会话区顶部出现 初级功能 / 高级功能 / 模拟器 三个 tab，点击切换后各自状态独立（切换回来仍是原状态）；反例：只有一个 tab、或切换后状态串味/白屏 |
| "引擎吸收成功" | 正例：`.gil` 能读**且能写回**，写回文件可被官方编辑器打开；对方 169 项测试在本仓可跑；反例：只有读、或测试 skip/红 |
| "回归可信" | 正例：新增测试与既有 462 项**一起全绿且断言数增加**；反例：靠 skip 或删断言变绿 |

**影响范围**：`packages/dsh-miliastra/` 内部（新增 `engine/` 子树、`package.json` 依赖与构建脚本、`lib/client.js` 注册槽位改动、`docs/`）。**不动**：`code/`、`docs/官方文档-*`、workspace 其他目录。

---

## On / Off scope（定稿）

**In**：
1. `dev-beyond-simulator` 分支（已推送）。
2. 整仓许可 → GPL-3.0-only（含 NOTICE 致谢与版权保留）。
3. **引擎吸收**：`studio/{gia,ui,play,host,host-png.js,log,autotest}` + `client/lua-runtime` + `server`（含其测试）。
4. **UI 自写**：`conversation.view` 三 tab（初级功能 / 高级功能 / 模拟器）。
5. **适配层自写**：Host 路由 + 工具（命名空间见 QT3）。
6. 依赖与构建：`protobufjs` / `fengari` / `@napi-rs/canvas` / `pixi.js` + esbuild 构建脚本。
7. 回归：搬入的 169 项 + 既有 462 项一起跑。

**Out（本轮不做，需另开工单）**：
- 对方的 `web/` 自托管服务、`mcp/` stdio 服务（R2 里没点名，且与"DSH 插件"这一载体重复）。
- 对方的 `editor-ui/`（Q5 已定 UI 自写）。
- 对方 skill（`qxqy-simulator`）与 agent 预设（`wonderland-lua-builder`）—— 见 QT4。
- 现有面板 10 张卡片的初级/高级**重排**（业务不改，仅形态）—— 见 QT1。

---

## 撤销条件

- **许可**：一旦推送并发布，新版本起永久 GPL-3.0-only（已发布的 Apache-2.0 旧版不撤回）⇒ 许可变更必须与引擎吸收**同一批**提交。
- **依赖**：若 `@napi-rs/canvas` 在目标机器装不上（原生模块 + pnpm 构建拦截），则 `host-png.js` 单独降级为"纯 JS 手写 PNG 编码器"（我们已确认可行）。
- **对方仓**：若 `1475505/miliastra-beyond-simulator` 改许可或删库 → 立即停搬并重评（当前基线 `master@22d75a7`，GPL-3.0-only）。
- **UI 槽位**：若将来 DSH 升级改变 `conversation.view` 契约 → 回炉重写注册（不影响引擎层）。

---

## 待确认问题清单（QT 系列；QT1–QT5 未拍板前不进实现）

- **QT1**（边界）：初级功能 / 高级功能 的**卡片归属**逐张确认。建议：初级 = 关卡 · 关卡与文件 · 地图体检 · 活文件 · 脚本一致性 · 试玩开跑 · 运行时日志 · 游戏截图；高级 = 读界面控件 · 探针 · 活文件体检明细。
- **QT2**（许可）：GPL 落地清单（`LICENSE` 替换 / `package.json` / 新增 `NOTICE` 保留对方版权与来源 / README 声明 / 版本号取 `0.1.0` 还是 `0.0.12`）。
- **QT3**（实现）：工具命名空间 —— 引擎搬入后工具是保留对方 6 个 `qxqy_studio_*` 名，还是统一到 `miliastra_*`（自写适配层 ⇒ 我倾向统一前缀 + 文档留别名）。
- **QT4**（范围）：试玩页（FP8）/ 对方 skill（FP9）/ agent 预设（FP9）/ 术语消歧（FP11）各自 in 还是 out。
- **QT5**（实现）：`dsh.client.inject` 只声明真正要用的（`slots`）还是连带升 DSH 版本。

---

## 交接去向

| 功能点 | 交接给 | 内容 |
|---|---|---|
| FP2–FP12 全部实现类 | **本仓（`dsh-miliastra`）自身**，即 `yuan-code` 所属的千星域工程 | 方案级实现方案 + 验收 + On/Off scope |
| API 纪律复核 | 技能 **`yuan-code`**（千星域 API 零猜测 / 证据双轴） | 融合后的 `.gil`/`.gia` 语义结论一律按 `yuan-code` 的 API 纪律复核，不采信模型记忆 |
| 需求边界本身 | 本技能（`ugc-bb`） | 后续新需求重复六步 |

**方案级实现方案**（边界已确认；只写"落到哪一层、怎么落、谁去做"，不写完整代码、不预设精确尺寸）

#### ① 引擎层（吸收对方源码）
- **改哪**：新增 `engine/` 子树，按对方原结构落位 —— `engine/gia/{codec,guid,raw-fields}`、`engine/ui/{authoring,layout}`、`engine/play/{session,compile,browser-session,pixi-renderer}`、`engine/host/{controller,worker,workspace}`、`engine/host-png.js`、`engine/log/`、`engine/autotest/`、`engine/json.js`、`engine/constants.js`、`engine/lua-runtime/{runtime,scene,tween,ease,enums,color,lua-bridge}`、`engine/server/`
- **语义红线**：Worker 模型（单会话一个 Worker / 单次操作 8 秒超时 / `stop` 是唯一确定性回收方式）**原样保留**，不"顺手优化"
- **取证口径**：`.gil` 读 + 写回各出 1 个真实文件，写回结果与官方编辑器对照是否接受

#### ② 依赖与构建
- **改哪**：`package.json` 增 `dependencies`（`protobufjs` / `fengari` / `@napi-rs/canvas` / `pixi.js`）与 `devDependencies`（`esbuild`）、增 `scripts.build`
- **产物纪律**：构建产物落 `dist/`，**不进 git**（`.gitignore`），纯 Node 侧测试**不依赖构建产物**
- **取证口径**：`npm test` 在无 `dist/` 的干净检出处仍可全绿；浏览器产物单独一条校验

#### ③ UI 层（我们自写，不搬 `editor-ui/`）
- **改哪**：`lib/client.js` —— **保留**现有 `sidebar.footer.action` 注册，新增 `conversation.view` 三条 entry：`miliastra-basic`（初级功能）· `miliastra-advanced`（高级功能）· `miliastra-simulator`（模拟器）；现有 10 张卡片按 QT1 归类后搬进前两个视图，模拟器视图新写（引擎渲染到 canvas/DOM）
- **状态纪律**：切 tab **不重建引擎**；会话级状态放 store，三个视图互不串味
- **取证口径**：`tests/client-render-test.mjs` 增三条注册断言 + "切换后状态独立"断言

#### ④ 适配层（我们自写，不搬对方 `dsh-plugin/`）
- **改哪**：`index.js` 增 `/miliastra/engine/*` 路由承载引擎 API + 工具（命名按 QT3）
- **契约纪律**：沿用既有 `lossless()` 回执与 `HttpError`；工具 description 末尾必须有 `典型调用`
- **取证口径**：新增路由与工具各出契约测试；`gen-readme-tools.mjs --write` 后 `readme-test` 逐字比对

#### ⑤ 许可（与②③同一批落地）
- **改哪**：`LICENSE` → GPL-3.0-only 全文；`package.json` `license` 字段；新增 `NOTICE`（对方仓库 URL + 基线 commit `22d75a7` + 版权归属）；`README.md` 声明段；版本号按 QT2
- **取证口径**：三处许可声明一致 + `readme-test` 的版本行断言同步

#### ⑥ 回归（搬对方测试子集）
- **改哪**：`tests/` 增 `engine-*.mjs`（对方 20 个测试文件改写 import 路径）+ `package.json` 的 `test` 脚本纳入
- **取证口径**：既有 462 项 + 对方 169 项**一起全绿**；断言数只增不减（不许靠 skip 变绿）

> ⚠️ **落地铁律**（每条工单都适用）：① 活文件是唯一副本 → 备份/原子写/SHA/lint/失败回滚**不许绕过**；② 不读游戏内存、不连游戏端口、不冒充编辑器；③ **不碰用户玩法**（规则/判定/数值/摆位是需求本体）；④ 只有工具 schema 与系统提示段能自动到达 AI；⑤ 引擎若要写用户磁盘，必须先并入我们的备份与双钥匙纪律。

---

## 交接工单（F3：逐条确认，**不许静默开工**）

| 工单 | 内容 | 验收（量化） | 依赖 | 状态 |
|---|---|---|---|---|
| **W1** | 许可与声明 → GPL-3.0-only（`LICENSE` / `NOTICE` / `package.json` / `README`） | 三处声明一致；既有 462 项仍全绿 | 无 | ✅ 已完成（`c76da4d`，与 W2 同批落地） |
| **W2** | 引擎子树搬入 + 依赖 + esbuild 构建脚本 | 引擎测试在本仓可跑（非 skip） | W1 | 🟡 进行中：搬入 + 依赖 + **129 项引擎测试已绿**；**esbuild 构建脚本待做**（面板当前走 Host 出 PNG，不依赖浏览器产物） |
| **W3** | Host 适配层（路由 + 工具，命名按 QT3） | 新路由/工具契约测试绿；`readme-test` 逐字比对过 | W2 | ✅ 已完成：`lib/sim.mjs` + `miliastra_sim` 工具（9 个 op/动作）+ `POST /miliastra/engine`；README 工具块已重生成，`readme-test` 14/0 |
| **W4** | `conversation.view` 三 tab 骨架（UI 自写） | 三 tab 可切、状态独立、互不白屏 | 无（不依赖 W2/W3） | ✅ 已完成：`dsh-miliastra-basic` / `-advanced` / `-simulator`，SSR 断言 5 项（`client-render-test` 37/0） |
| **W3** | Host 适配层（路由 + 工具，命名按 QT3） | 新路由/工具契约测试绿；`readme-test` 逐字比对过 | W2 | 待确认 |
| **W4** | `conversation.view` 三 tab 骨架（UI 自写） | 三 tab 可切、状态独立、互不白屏 | 无（不依赖 W2/W3） | 待确认 |
| **W5** | 初级/高级卡片归类搬家（QT1 定稿后） | 现有 10 张卡功能不变形；462 项绿 | W4 | ✅ 已完成：`Panel` 加 `inline`+`group`（basic = ①② / advanced = ③ 含高级诊断 / all = 浮层三栏），侧边栏入口保留 |
| **W6** | 模拟器视图（接引擎 API 渲染 + 交互） | 读 `.gil` 出控件树/画布；写回经官方编辑器验证 | W2 W3 | 🟡 部分：视图 + 7 个动作（编辑器画面/开始试玩/单步/刷新画面/停止/居中点击/重置）+ 控件树 + 试玩日志可用；**写回 `.gil` 的真机验证仍未做**（保持 `pending`） |
| **W7** | 搬对方测试子集进回归 | 引擎 129 + 我们的一起全绿，断言数只增不减 | W2 | ✅ 已完成：引擎 129 项 + 新增 `tests/sim-test.mjs` 31 项都进 `npm test`；`npm test` 退出码 0 |

---

## 复测记录

| 日期 | 做了什么 | 证据 |
|---|---|---|
| 2026-09-24 | 建 `dev` 分支并推送 | `dev eaea62c [origin/dev]` |
| 2026-09-24 | 建 `dev-beyond-simulator` 分支并推送 | `git branch -vv` → `dev-beyond-simulator eaea62c [origin/dev-beyond-simulator]` |
| 2026-09-24 | 对比 + 许可 + 重依赖 + 代码质量分析 | `docs/dsh-miliastra_对比_miliastra-beyond-simulator_2026-09-24.md` |
| 2026-09-24 | **第 4 轮拍板**：许可不单独排期，重心转"模拟器重构吸收" | 作者原话：「许可不重要 重要的模拟器要重构吸收」 |
| 2026-09-24 | 引擎物理搬入 `engine/{studio,lua-runtime,server}` = **58 文件 / 610 KB**，5 处裸包名 + 4 处测试旧路径改写 | commit `c76da4d`（已推送 `origin/dev-beyond-simulator`） |
| 2026-09-24 | 4 个依赖装好并实测可加载（原生 canvas 真出 PNG 113 B、fengari 有 lua 命名空间） | `npm install` → added 22 packages in 13s |
| 2026-09-24 | **引擎测试 129 项全绿**（0 失败 / 0 跳过 / 1.9s） | `npm run test:engine`；注：129 是引擎三包（studio+lua-runtime+server），对方全仓 169 还含 `dsh-plugin`/`web`/`mcp` 三套（按 Q5 **未搬**） |
| 2026-09-24 | 许可同批落地：`LICENSE`→GPL-3.0-only、新增 `NOTICE`、README 四处同步、`readme-test` 的 docs 可达性补链后 14/0 | 同 commit `c76da4d` |
| 2026-09-24 | 既有套件复核：11 子集 + 自检**全绿**（client-render 32 / deploy 30 / giaruns 25 / leveldata 44 / live-check 9 / lualint 32 / metrics 39 / playtest 63 / probe-deploy 16 / readme 14 / shot 103 / smoke 48） | 逐个跑，见输出 |
| 2026-09-24 | **W3 完成**：`lib/sim.mjs`（会话级控制器 + `simOp` 七个 op）+ `miliastra_sim` 工具 + `POST /miliastra/engine` 路由 | `tests/sim-test.mjs` **31/0**；`readme-test` 14/0；README 生成块 25 253 → 27 002 字符 |
| 2026-09-24 | **W4/W5 完成**：会话区三 tab（初级功能/高级功能/模拟器）+ `Panel(inline, group)` 复用（浮层入口保留） | `client-render-test` 32 → **37/0**（新增：tab 计划纯数据、两视图分组、inline 无关闭按钮、模拟器视图空态） |
| 2026-09-24 | **W7 完成**：引擎 129 + sim 31 并入 `npm test` | `npm test` 退出码 **0**；另跑 giaruns 25 / leveldata 44 / metrics 39 / playtest 63 / live-check 9 全绿 |
| 2026-09-24 | 安全护栏实测：`while true do end` 的脚本超时后返回错误、Worker 被 terminate、随后 `stop` 仍可用 | `tests/sim-test.mjs` 的 3 条 ★ 断言（耗时 < 12 秒） |
| 2026-09-24 | 新文档 `docs/模拟器与视图.md`（两轴对照 / tab 契约出处 / PNG 出图 / 三条安全纪律 / 已验证 vs 未验证 / 排障） | README「深入阅读」已链接，`readme-test` 的 docs 可达性通过 |

```yaml
handoff:
  # F2 机器可读交接块（八要素齐全）；按 F3 工单制逐条确认后才开工
  - fp: FP2 → W1
    origin_reqs: [R4, R5]
    group: A
    layer: 数据/声明
    handoff_to: dsh-miliastra
    acceptance: "LICENSE 为 GPL-3.0-only 全文；package.json license 字段一致；NOTICE 含对方仓库 URL + 基线 commit 22d75a7 + 版权归属；README 有声明；既有 462 项仍全绿"
    scope_in: ["LICENSE", "package.json", "NOTICE", "README.md"]
    scope_out: ["任何代码搬运（W2 才做）"]
    undo_condition: "推送发布前可回退；发布后不可撤回（已发布旧版仍 Apache-2.0）"
    evidence: ["packages/dsh-miliastra/package.json:49", "_ref/.../LICENSE（34 674 B）", "_ref/.../package.json license=GPL-3.0-only"]
    status: 待用户确认
  - fp: FP3 + FP10 → W2
    origin_reqs: [R2, R4]
    group: A
    layer: 逻辑 + 构建
    handoff_to: dsh-miliastra
    acceptance: "engine/ 子树落地；protobufjs/fengari/@napi-rs/canvas/pixi.js 进 dependencies；esbuild 产出 dist/ 且不进 git；对方测试在本仓可跑且非 skip"
    scope_in: ["engine/gia", "engine/ui", "engine/play", "engine/host", "engine/host-png.js", "engine/log", "engine/autotest", "engine/lua-runtime", "engine/server", "package.json", ".gitignore", "scripts/build.mjs"]
    scope_out: ["editor-ui（UI 自写）", "对方 web/ 与 mcp/"]
    undo_condition: "@napi-rs/canvas 装不上 → host-png.js 降级为纯 JS 手写 PNG 编码器"
    evidence: ["_ref/.../studio/gia/codec.js（71 649 B）", "_ref/.../client/lua-runtime/src/lua-bridge.js:1", "_ref/.../scripts/build.mjs:7"]
    status: 待用户确认
  - fp: FP4 → W3
    origin_reqs: [R2, R3]
    group: A
    layer: 逻辑（适配层）
    handoff_to: dsh-miliastra
    acceptance: "自写 Host 路由 + 工具；契约测试绿；gen-readme-tools 后 readme-test 逐字比对通过"
    scope_in: ["index.js 的新路由与新工具"]
    scope_out: ["对方的 dsh-plugin/lib/index.js（不搬）"]
    undo_condition: "命名空间若定为统一前缀（QT3）→ 工具文案与 README 一并改"
    evidence: ["packages/dsh-miliastra/index.js（TOOLS）", "_ref/.../skill/SKILL.md:135-140（对方 6 工具）"]
    status: 待用户确认
  - fp: FP5 + FP6 + FP7 → W4 W5 W6
    origin_reqs: [R3]
    group: A
    layer: UI
    handoff_to: dsh-miliastra
    acceptance: "会话区顶部出现 初级功能/高级功能/模拟器 三个 tab；切换状态独立不串味；模拟器读 .gil 出控件树与画布，写回经官方编辑器验证"
    scope_in: ["lib/client.js 的 conversation.view 注册与三个视图", "dsh.client.inject 增 slots"]
    scope_out: ["对方 editor-ui/index.js（93 932 B，不搬）"]
    undo_condition: "conversation.view 契约随 DSH 升级变化 → 重评（不影响引擎层）"
    evidence: ["dsh-client-ui-conversation/lib/client.js:15124", "lib/types/client/contract/views.d.ts:3-8", "_ref/.../dsh-plugin/lib/client.js:21", "packages/dsh-miliastra/lib/client.js:4,1976"]
    status: 待用户确认
  - fp: FP12 → W7
    origin_reqs: [R2, Q6(i)]
    group: A
    layer: 测试
    handoff_to: dsh-miliastra
    acceptance: "搬入 20 个测试文件（169 个 test()；其 README 记 162 项回归）；与既有 462 项一起全绿；断言数只增不减"
    scope_in: ["tests/engine-*.mjs", "package.json 的 test 脚本"]
    scope_out: ["改小对方断言使其变绿（不允许）"]
    undo_condition: "某测试依赖本机不存在的资源 → 标 [待确认] 并单列，不许删断言"
    evidence: ["20 个测试文件 / 194 282 B / 169 test() / 1 079 assert. ", "_ref/.../DISTRIBUTION.md:100"]
    status: 待用户确认
```
