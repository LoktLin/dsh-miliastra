# 发布清单（Releases）

> ★ **「怎么发一版」只有这一处权威。** 别在 `docs/` 里再抄一份流程 —— 抄出去的那份一定先过期
> （2026-10-01 就是这么发现的：`docs/快速上手与教程.md` 里那份还写着「当前 0.4.0」，而且给了与现状相反的 npm 凭据说法）。
> 本目录只放**发布说明**，一个版本一个文件：`v<版本>.md`；发布动作本身在 GitHub 网页上完成（本机没有 `gh` CLI）。
>
> 每个版本**发到哪了**（tag / npm / Release 页三处状态）记在工作区 `docs/dsh-miliastra_发版记录.md`。

## 六步

1. **升版本号 —— 四处必须一起改**（`smoke` 里有断言，漏一处就红）：
   - `package.json` → `"version"`
   - `index.js` → `const VERSION`
   - `README.md` → 第一段 `**版本 \`x.y.z\`**`
   - `README.md` → 安装示例 `dsh-miliastra@x.y.z`
2. **改了工具就跑生成器**：`node tools/gen-readme-tools.mjs --write`
   （README 的「工具速查」是从 `index.js` 的 `TOOLS` 生成的，`tests/readme-test.mjs` 逐字比对。）
3. **跑测试**：`npm test` + 其余套件 + 技能契约自检 —— 全绿再往下。
   顺手核对 README 与 `AGENTS.md` 里写死的测试项数有没有过期。
4. **写发布说明**：照 `v0.0.10.md` 的格式新建 `v<新版本>.md`，提交并推送。
5. **发 npm**：
   ```powershell
   npm publish --dry-run     # 先看会发什么（不真发）
   npm publish               # 真发（凭据已在本机 ~/.npmrc；开了 2FA 时加 --otp=123456）
   ```
   - ⚠️ **发布成功后 1~2 分钟内 `npm view` 甚至「某一版端点」仍可能报旧版本或 404 —— 这是传播延迟，不是发布失败**
     （`0.3.0` 起每次如此）。判据用两条一起：等 3~5 分钟再打 `https://registry.npmjs.org/dsh-miliastra/<版本>`，
     并在**临时目录**里 `npm install dsh-miliastra@<版本>` **真装一次**（`--dry-run` 的 `package size / total files` 只说明包里有什么，不说明装得上）。
   - 急着再发一次只会拿到 403「不能覆盖已发布版本」—— 那反而证明它已经上去了。
6. **打 tag 并推送，再建 Release 页，最后让 `main` 跟上**：
   `git tag -a v<版本> -m "dsh-miliastra <版本>"` → `git push origin v<版本>`
   → 打开 `https://github.com/LoktLin/dsh-miliastra/releases/new?tag=v<版本>`，标题填 `v<版本>`，描述框粘贴第 4 步那份，Publish
   → `git checkout main && git merge --ff-only dev-beyond-simulator && git push origin main`
   （**tag 打在 `dev-beyond-simulator` 上**；`main` 只做快进，让新人 clone 默认拿到最新发布。）

> ⚠️ **本机 ssh-agent 不常驻**：`git push` 若报 `Permission denied (publickey)`，
> 显式指定密钥即可（PowerShell）：
> `$env:GIT_SSH_COMMAND = 'ssh -i "' + $env:USERPROFILE + '\.ssh\id_ed25519" -o IdentitiesOnly=yes'`

> ⚠️ **GitHub Release 页这一步只能人工做**（本机没有 token/CLI）—— 它是唯一会长期欠着的一步，
> 所以「发版记录」里专门有一列记它。**文案早就在 `.github/release-notes/` 里备好了**，别让它烂在仓库里。

## 发布说明的格式（**以最近一版为准**）

近几版（`v0.7.1` / `v0.7.2` / `v0.7.3`）实际用的是**中文为主**的排版，写新一版**照抄最近一版**即可：

```md
# dsh-miliastra v<版本>

**安装 / Install**：`dsh plugin --profile web add dsh-miliastra@<版本>` → **重启 `dsh web`** / then **restart `dsh web`**。

> 一句话定位这一版：目标是什么、边界在哪、**哪些东西没变**。

## 🚀 新增功能
## 🐛 问题修复
## ⚠️ 其他变更
## 验证        （跑了哪几道门、什么结果 —— 用数字）

**Full Changelog**: https://github.com/LoktLin/dsh-miliastra/compare/v<上一版>...v<本版>
```

- **分节不必全有**（没有就不写那一节）；**中英不必逐段对照**（近几版只做中文，英文摘要放在开头安装行那一句里）。
- ⚠️ **不许引用只有本机才有的路径或文档**：工作区 `docs/`、`案子/`、`技能` 里的东西**不要**写进来 ——
  用户 clone / 装 npm 包都看不到它们。写**包里真实存在**的东西（源码文件、工具、回执字段、数字）。
- 历史上有过**严格双语版**（`[中文](#cn-v<版本>) \| [English](#en-v<版本>)` + 原始 HTML 锚点 + 两侧逐段同序，
  本节原先就是照那套写的）。**要那么做也可以**，但**两边的数字必须一致**，英文别写成机翻腔。
- **发布说明是唯一一份会被贴到 GitHub 上的文案**：它自己就是给外人看的，别再指向本机的东西。
## 两条纪律

- **发布说明是唯一一份会被贴到 GitHub 上的文案** —— 它不能引用只有本机才有的路径或文档。
- **不要手改历史版本的说明**；要补充就等下个版本写清楚。
