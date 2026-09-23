# 发布清单（Releases）

> 这个目录只放**发布说明**，一个版本一个文件：`v<版本>.md`。
> 发布动作本身在 GitHub 网页上完成（本机没有 `gh` CLI，也没有 token），
> 把对应的 `v<版本>.md` **整段复制**贴进 Release 的描述框即可。

## 五步

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
5. **打 tag 并推送**（除了 `main`，这是唯一要推的东西）：
   `git tag -a v<版本> -m "dsh-miliastra <版本>"` 然后 `git push origin v<版本>`
   接着打开 `https://github.com/LoktLin/dsh-miliastra/releases/new?tag=v<版本>`，
   标题填 `v<版本>`，描述框粘贴第 4 步那份，Publish。

> ⚠️ **本机 ssh-agent 不常驻**：`git push` 若报 `Permission denied (publickey)`，
> 显式指定密钥即可（PowerShell）：
> `$env:GIT_SSH_COMMAND = 'ssh -i "' + $env:USERPROFILE + '\.ssh\id_ed25519" -o IdentitiesOnly=yes'`

## 发布说明的格式（与 DSH 仓库对齐）

- 第一行语言锚点：`[中文](#cn-v<版本>) | [English](#en-v<版本>)`
- 两侧的分节标题用**原始 HTML**（这样中英各有自己的 id，互不冲突）：
  `<h3 id="cn-v<版本>">新增功能</h3>` / `<h3 id="en-v<版本>">New Features</h3>`
- 四个分类、两侧同名同序：
  **新增功能 / 体验优化 / 问题修复 / 其他变更**
  （New Features / Improvements / Bug Fixes / Chores）
- 中间用 `---` 分隔中英两半；两半结尾各写一行 `Full Changelog` 指向 compare 链接
  （还没有上一个 tag 时，指向 `https://github.com/LoktLin/dsh-miliastra/commits/main`）
- **两边的数字必须一致**（字符数、毫秒、测试项数……）；英文别写成机翻腔。

## 两条纪律

- **发布说明是唯一一份会被贴到 GitHub 上的文案** —— 它不能引用只有本机才有的路径或文档。
- **不要手改历史版本的说明**；要补充就等下个版本写清楚。
