#!/usr/bin/env node
/**
 * 一次跑完**所有**套件（`npm test` 的唯一入口）。
 *
 * 为什么要有它（2026-09-25 同事反馈）：原来的 `npm test` 是 `&&` 串联 ——
 * **第一个套件失败会把后面 8 套一起带走**，于是"改了一处、红了"时只看得见一个套件的结果，
 * 剩下 8 套到底过没过**没人知道**，只能一个一个手跑（他为此多花了一轮）。
 *
 * 现在的行为：
 *   · **顺序跑完所有套件**（不早退），逐个打印结果；
 *   · 最后汇总「通过 / 失败套件 + 总断言数」，**只要有一套失败就以 1 退出**；
 *   · 判定**只认子进程退出码**（每个套件自己最清楚自己过没过），输出文本只用来给你看 + 数断言。
 *
 * ⚠️ 为什么把子进程输出**落到临时文件**再打印，而不是 `stdio: 'inherit'` / `'pipe'`：
 *    `'pipe'` 依赖管道（受限沙箱里 Node 的子进程管道会 EPERM），`'inherit'` 又抓不到输出（数不了断言）。
 *    落到普通文件两头都满足，代价是每个套件的输出在它跑完之后才整段出现（顺序不变，好读）。
 *
 * 用法：`node tools/test-all.mjs`（= `npm test`）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 套件清单（顺序 = 执行顺序）。
 * ⚠️ 加套件就加一行；**别改成并行** —— 各套件有共享的习惯（MILIASTRA_BACKUP_DIR / 临时目录），
 *    并行会互相踩，而且顺序输出才读得懂。
 */
export const SUITES = [
  // 这两个是**门禁**（只回「过 / 不过」，本来就不报断言数）—— 标出来，免得汇总里被当成「认不出来」
  { name: 'lint（语言层绊线）', args: ['tools/lint.mjs'], countable: false },
  { name: 'typecheck（类型层绊线）', args: ['tools/typecheck.mjs'], countable: false },
  { name: 'readme-test（文档与 schema 逐字一致）', args: ['tests/readme-test.mjs'] },
  { name: 'smoke（工具契约 + 人机工效）', args: ['tests/smoke.mjs'] },
  { name: 'locate-test（当前活文件是谁 + 跨脚本不判）', args: ['tests/locate-test.mjs'] },
  { name: 'deploy-test（部署 / 备份 / 指纹 / 原子写）', args: ['tests/deploy-test.mjs'] },
  { name: 'read-source-test（op=read source=<绝对路径>：只读读取）', args: ['tests/read-source-test.mjs'] },
  { name: 'gilnodes-test（节点图 / 实体自定义变量：合成 .gil 逐字段钉住 + 只读）', args: ['tests/gilnodes-test.mjs'] },
  { name: 'kbqa-test（知识库问答：离线蒸馏清单结构/检索/出处 + 在线 op 的纪律与隐私披露）', args: ['tests/kbqa-test.mjs'] },
  { name: 'nodedb-test（官方节点词典：归属 / 搜索 / 与 .gil 的号对不上这条老实说清）', args: ['tests/nodedb-test.mjs'] },
  { name: 'probe-deploy-test（试玩探针渲染 / 部署）', args: ['tests/probe-deploy-test.mjs'] },
  { name: 'handover-ledger-test（P2-8 交接值台账：不 set 不放行 / set 后自动带上 / 按关卡分）', args: ['tests/handover-ledger-test.mjs'] },
  { name: 'lualint-test（Lua 结构校验）', args: ['tests/lualint-test.mjs'] },
  { name: 'lua-syntax-test（fengari 真语法检查）', args: ['tests/lua-syntax-test.mjs'] },
  { name: 'preflight-test（op=preflight：一次查完能不能上真机）', args: ['tests/preflight-test.mjs'] },
  { name: 'vfx-sprite-test（图元层 SHAPE_KIND=sprite：轨迹图元工单 §5 逐条验收）', args: ['tests/vfx-sprite-test.mjs'] },
  { name: 'leveldata-hint-test（关卡表写法与候选，合成样本）', args: ['tests/leveldata-hint-test.mjs'] },
  { name: 'shot-test（截图命名 / 清理 / 连拍）', args: ['tests/shot-test.mjs'] },
  { name: 'assets-test（素材库：内容寻址 / 去重 / 原子索引 / 显式删）', args: ['tests/assets-test.mjs'] },
  { name: 'sim-test（模拟器引擎）', args: ['tests/sim-test.mjs'] },
  { name: 'sim-play-test（浏览器试玩页那一串调用）', args: ['tests/sim-play-test.mjs'] },
  { name: 'client-render-test（客户端控件渲染）', args: ['tests/client-render-test.mjs'] },
  { name: 'feedback2-test（第二批反馈修复 ①~⑧）', args: ['tests/feedback2-test.mjs'] },
  { name: 'feedback3-test（第三批：A1/A2/B1~B4/C1/D1）', args: ['tests/feedback3-test.mjs'] },
  { name: 'feedback4-test（第四批：P0-1/P1/P2/N-1~3 + 保持项）', args: ['tests/feedback4-test.mjs'] },
  { name: 'feedback5-test（第五批施工单：P0-2/P1-3/P1-4/P2-5）', args: ['tests/feedback5-test.mjs'] },
  { name: 'gen-test（生成器：文本渐变逐帧 / 结构体 JSON / 两条硬规则）', args: ['tests/gen-test.mjs'] },
  { name: 'pixelart-test（生成器：图片转像素画 —— 合并/量化/序列化 + 模拟器端到端）', args: ['tests/pixelart-test.mjs'] },
  { name: 'vfx-test（生成器：粒子特效 op=vfx-lua —— 13 预设/落程池子/驱动层逐字 + 模拟器端到端）', args: ['tests/vfx-test.mjs'] },
  { name: 'fx-hardening-test（真机实战 5 个坑：缺 container / op=errors / 落盘提示 / 部署降噪 / preflight）', args: ['tests/fx-hardening-test.mjs'] },
  { name: 'uilint-test（P0-1 UI 门禁 op=lint-ui：**纯夹具**，四条判据 + summaryOnly）', args: ['tests/uilint-test.mjs'] },
  { name: 'audit-test（统一回执契约：任何 op 不许抛异常 + 失败必带 code）', args: ['tests/audit-test.mjs'] },
  { name: 'sounds-test（音效库：1997 条目录 + 中英模糊搜索）', args: ['tests/sounds-test.mjs'] },
  { name: 'catalog-test（图片资源库：分类/颜色档/有无图/可渲染 + 三个新 op 的接线）', args: ['tests/catalog-test.mjs'] },
  { name: 'icon-search-test（图标语义检索：三档回执 / 严格诚实口径 / 错误路径 / summaryOnly 只去正文）', args: ['tests/icon-search-test.mjs'] },
  { name: 'receipt-contract-test（回执契约：必有 ok / ok:false 必带 error / 不许抛异常）', args: ['tests/receipt-contract-test.mjs'] },
  { name: 'engine（`node --test` 上游单测）', args: ['--test', 'engine/**/*.test.mjs'] },
];

/**
 * 从一段输出里**猜**它跑了多少条断言（只用于汇总显示，**不参与判定**）。
 *
 * 各套件的汇总行格式实测有三种：`结果：通过 N，失败 M` / `通过 N 项` / `ℹ pass N`（node --test）。
 * 三种都试一遍取最大值（同一条汇总行可能被两条正则同时命中，取最大才不会重复计数）。
 * 认不出来就返回 null —— 汇总里如实标「未识别」，不假装数到了。
 */
export function assertionsOf(text) {
  const found = [];
  for (const re of [/结果：通过\s*(\d+)/g, /通过\s+(\d+)\s*项/g, /^ℹ pass (\d+)$/gm]) {
    let m;
    let last = null;
    while ((m = re.exec(String(text))) !== null) last = Number(m[1]);
    if (last !== null) found.push(last);
  }
  return found.length ? Math.max(...found) : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const logDir = path.join(os.tmpdir(), 'miliastra-test-all');
  fs.mkdirSync(logDir, { recursive: true });
  const results = [];
  let assertions = 0;
  let unknown = 0;
  let gates = 0;

  for (const suite of SUITES) {
    const slug = suite.name.replace(/[^\w.-]+/g, '_');
    const logFile = path.join(logDir, slug + '.log');
    const t0 = Date.now();
    const fd = fs.openSync(logFile, 'w');
    let r;
    try {
      r = spawnSync(process.execPath, suite.args, { cwd: ROOT, stdio: ['ignore', fd, fd], env: process.env });
    } finally {
      fs.closeSync(fd);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const text = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } })();
    const code = r && typeof r.status === 'number' ? r.status : null;
    const spawnError = (r && r.error && (r.error.message || String(r.error))) || null;
    const ok = code === 0 && !spawnError;

    console.log('\n' + '─'.repeat(72));
    console.log((ok ? '▶ ' : '✗ ') + suite.name + `  （node ${suite.args.join(' ')}）`);
    console.log('─'.repeat(72));
    if (text.trim()) console.log(text.replace(/\s+$/, ''));
    console.log((ok ? '✓ 通过' : '✗ 失败') + ` ${suite.name} —— 退出码 ${code === null ? '(无：被信号打断？)' : code}，用时 ${secs}s`
      + (spawnError ? '（起进程就失败了：' + spawnError + '）' : ''));

    const n = suite.countable === false ? null : assertionsOf(text);
    if (suite.countable === false) gates += 1;
    else if (n === null) unknown += 1;
    else assertions += n;
    results.push({ name: suite.name, ok, code, secs, assertions: n, gate: suite.countable === false, log: logFile });
    if (ok) { try { fs.unlinkSync(logFile); } catch { /* ignore */ } }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '═'.repeat(72));
  console.log(`汇总：套件 ${results.length} 个 —— 通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  ${r.assertions === null ? (r.gate ? '（门禁类：不报断言数）' : '（断言数未识别）') : r.assertions + ' 条断言'}  ${r.secs}s`);
  }
  console.log(`总断言数：${assertions}` + (gates ? `（另有 ${gates} 个门禁类套件不报断言数）` : '')
    + (unknown ? `（还有 ${unknown} 个套件的断言数认不出来，见上面逐条）` : '')
    + '　⚠️ 这只是**汇总显示**：成败一律以每个套件的退出码为准');
  if (failed.length) {
    console.log('\n失败套件的完整输出已留在：');
    for (const r of failed) console.log('  ' + r.log);
  }
  // 有套件失败 → 退出码 1（**不早退**：上面所有套件都已经跑完了）
  process.exit(failed.length ? 1 : 0);
}
