#!/usr/bin/env node
/**
 * 一次跑完**所有**套件（`npm test` 的唯一入口）。
 *
 * 为什么要有它（2026-09-25 同事反馈）：原来的 `npm test` 是 `&&` 串联 ——
 * **第一个套件失败会把后面 8 套一起带走**，于是"改了一处、红了"时只看得见一个套件的结果，
 * 剩下 8 套到底过没过**没人知道**，只能一个一个手跑（他为此多花了一轮）。
 *
 * 现在的行为：
 *   · **跑完所有套件**（不早退），逐个打印结果；
 *   · 最后汇总「通过 / 失败套件 + 总断言数」，**只要有一套失败就以 1 退出**；
 *   · 判定**只认子进程退出码**（每个套件自己最清楚自己过没过），输出文本只用来给你看 + 数断言。
 *
 * ⚠️ 为什么把子进程输出**落到临时文件**再打印，而不是 `stdio: 'inherit'` / `'pipe'`：
 *    `'pipe'` 依赖管道（受限沙箱里 Node 的子进程管道会 EPERM），`'inherit'` 又抓不到输出（数不了断言）。
 *    落到普通文件两头都满足，代价是每个套件的输出在它跑完之后才整段出现（顺序不变，好读）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/test-all.mjs                 # 默认：**按核数并行（上限 4 路）** · 不含上游 engine（约 2.6 分钟）
 * node tools/test-all.mjs --jobs 4        # 4 路并行（2026-10-08 实测安全，见下）· 墙钟约 1/3
 * node tools/test-all.mjs --fast          # 迭代档：跳过大件端到端（目前只对 vfx-test 生效）
 * node tools/test-all.mjs --with-engine   # 把上游 `engine/**` 的 135 断言也算进来（约 8 秒）
 * node tools/test-all.mjs --list          # 只列套件名（默认档）
 * ```
 *
 * ## ⚠️ 关于并行（2026-10-08 改，附**实测结论**）
 *
 * 旧注释写「**别改成并行** —— 各套件有共享的习惯（`MILIASTRA_BACKUP_DIR` / 临时目录）」。**这条已经过期**：
 * 现在每个套件都是 `fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-<套件>-'))`（**唯一临时目录**），
 * 而 `MILIASTRA_*` 一律是**在子进程内**设置（每个套件一个进程 ⇒ 天然隔离）。
 * ⇒ 并行安全；但**默认仍是 1 路**（保守）：要快就显式 `--jobs 4`。
 * 改动并行前请照旧验证：**连跑 3 遍，结果集必须逐字一致**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 套件清单（顺序 = 打印顺序）。
 * ⚠️ 加套件就加一行（`{ name, args, countable?, fastEnv? }`）。
 * `countable: false` = 门禁类（只回过/不过，不报断言数）。
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
  // ★ 全仓最慢的一个（约 116 s）：`VFX_TEST_NO_SIM=1` 可跳过模拟器端到端（`--fast` 会自动带上）
  { name: 'vfx-test（生成器：粒子特效 op=vfx-lua —— 17 预设/落程池子/驱动层逐字 + 模拟器端到端）',
    args: ['tests/vfx-test.mjs'], fastEnv: { VFX_TEST_NO_SIM: '1' } },
  { name: 'fx-hardening-test（真机实战 5 个坑：缺 container / op=errors / 落盘提示 / 部署降噪 / preflight）', args: ['tests/fx-hardening-test.mjs'] },
  { name: 'uilint-test（P0-1 UI 门禁 op=lint-ui：**纯夹具**，四条判据 + summaryOnly）', args: ['tests/uilint-test.mjs'] },
  { name: 'audit-test（统一回执契约：任何 op 不许抛异常 + 失败必带 code）', args: ['tests/audit-test.mjs'] },
  { name: 'receipt-contract-test（回执形状：必有 ok / ok:false 必带 error —— 与上一条互补，不重叠）', args: ['tests/receipt-contract-test.mjs'] },
  { name: 'uigia-test（界面控件组 .gia：wire 往返逐字节 + 槽位唯一性判据 + 隐私清洗）', args: ['tests/uigia-test.mjs'] },
  { name: 'sounds-test（音效库：1997 条目录 + 中英模糊搜索）', args: ['tests/sounds-test.mjs'] },
  { name: 'catalog-test（图片资源库：分类/颜色档/有无图/可渲染 + 三个新 op 的接线）', args: ['tests/catalog-test.mjs'] },
  { name: 'icon-search-test（图标语义检索：三档回执 / 严格诚实口径 / 错误路径 / summaryOnly 只去正文）', args: ['tests/icon-search-test.mjs'] },
];

/**
 * **可选**套件：上游 `engine/**` 自带的单测（135 断言 / 约 8 秒）。
 * 它测的是**上游代码**、不是我们的 —— 所以**默认不跑**，要跑加 `--with-engine`。
 */
export const ENGINE_SUITE = { name: 'engine（`node --test` 上游单测，可选）', args: ['--test', 'engine/**/*.test.mjs'] };

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

/** 跑一个套件（异步；输出落文件，避免管道 — 受限沙箱里管道会 EPERM）。 */
function runSuite(suite, { logDir, fast }) {
  const slug = suite.name.replace(/[^\w.-]+/g, '_');
  const logFile = path.join(logDir, slug + '.log');
  const env = { ...process.env };
  if (fast && suite.fastEnv) Object.assign(env, suite.fastEnv);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, suite.args, { cwd: ROOT, stdio: ['ignore', fd, fd], env });
    const finish = (code, err) => {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      let text = '';
      try { text = fs.readFileSync(logFile, 'utf8'); } catch { /* ignore */ }
      resolve({
        suite, code, spawnError: err ? (err.message || String(err)) : null, secs, text, logFile,
        ok: code === 0 && !err,
      });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, null));
  });
}

/** 把一次套件结果打成人读的一段（并行时也保证每段是完整的，不会交错）。 */
function printResult(r) {
  console.log('\n' + '─'.repeat(72));
  console.log((r.ok ? '▶ ' : '✗ ') + r.suite.name + `  （node ${r.suite.args.join(' ')}）`);
  console.log('─'.repeat(72));
  if (r.text.trim()) console.log(r.text.replace(/\s+$/, ''));
  console.log((r.ok ? '✓ 通过' : '✗ 失败') + ` ${r.suite.name} —— 退出码 ${r.code === null ? '(无：被信号打断？)' : r.code}，用时 ${r.secs}s`
    + (r.spawnError ? '（起进程就失败了：' + r.spawnError + '）' : ''));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const jobsIdx = argv.indexOf('--jobs');
  // 默认并行档：按核数取一半、上限 4（2026-10-08 实测：4 路 157s / 2 路 178s / 顺序 ~233s）
  // 要顺序跑就显式 `--jobs 1`（同时开着游戏/编辑器、想少占 CPU 时用）。
  const cores = os.cpus().length;
  const defJobs = Math.max(1, Math.min(4, Math.floor(cores / 2) || 1));
  const jobs = Math.max(1, Math.min(8, jobsIdx >= 0 ? (Number(argv[jobsIdx + 1]) || 1) : defJobs));
  const fast = argv.includes('--fast');
  const withEngine = argv.includes('--with-engine');
  const listOnly = argv.includes('--list');

  const suites = withEngine ? [...SUITES, ENGINE_SUITE] : [...SUITES];
  if (listOnly) {
    for (const s of suites) console.log(s.name);
    console.log(`共 ${suites.length} 个套件` + (withEngine ? '（含可选的上游 engine）' : '（不含上游 engine；加 --with-engine 才跑）'));
    process.exit(0);
  }

  const logDir = path.join(os.tmpdir(), 'miliastra-test-all');
  fs.mkdirSync(logDir, { recursive: true });
  const t0 = Date.now();
  console.log(`▶ 跑 ${suites.length} 个套件 · ${jobs} 路并行` + (fast ? ' · **--fast 迭代档**（跳过大件端到端，**不能当提交前证据**）' : ''));

  // 结果按**清单顺序**存；打印按**完成顺序**（每段自成一体，不会交错）
  const results = new Array(suites.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= suites.length) return;
      const r = await runSuite(suites[i], { logDir, fast });
      results[i] = r;
      printResult(r);
      if (r.ok) { try { fs.unlinkSync(r.logFile); } catch { /* ignore */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));

  const all = results.filter(Boolean);
  const failed = all.filter((r) => !r.ok);
  let assertions = 0;
  let unknown = 0;
  let gates = 0;
  for (const r of all) {
    const n = r.suite.countable === false ? null : assertionsOf(r.text);
    r.assertions = n;
    if (r.suite.countable === false) gates += 1;
    else if (n === null) unknown += 1;
    else assertions += n;
  }

  console.log('\n' + '═'.repeat(72));
  console.log(`汇总：套件 ${all.length} 个 —— 通过 ${all.length - failed.length}，失败 ${failed.length}`
    + `　（墙钟 ${((Date.now() - t0) / 1000).toFixed(1)}s · ${jobs} 路）`);
  for (const r of all) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.suite.name}  `
      + (r.assertions === null ? (r.suite.countable === false ? '（门禁类：不报断言数）' : '（断言数未识别）') : r.assertions + ' 条断言')
      + `  ${r.secs}s`);
  }
  console.log(`总断言数：${assertions}` + (gates ? `（另有 ${gates} 个门禁类套件不报断言数）` : '')
    + (unknown ? `（还有 ${unknown} 个套件的断言数认不出来，见上面逐条）` : '')
    + '　⚠️ 这只是**汇总显示**：成败一律以每个套件的退出码为准');
  if (fast) console.log('⚠️ 本次是 `--fast` 迭代档：**不能当"提交前全绿"的证据**（端到端那段没跑）。');
  if (failed.length) {
    console.log('\n失败套件的完整输出已留在：');
    for (const r of failed) console.log('  ' + r.logFile);
  }
  // 有套件失败 → 退出码 1（**不早退**：上面所有套件都已经跑完了）
  process.exit(failed.length ? 1 : 0);
}
