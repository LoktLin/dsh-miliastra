/**
 * 浏览器试玩页测试（W2 尾段）
 *
 * 这个页面有**两个最容易悄悄坏掉**的地方，测试就盯这两处：
 *   ① **产物会过期**：`lib/sim-play/dist/play-renderer.js` 是 esbuild 打出来入库的，
 *      改了 browser 侧源码却忘了重打包 → 页面在浏览器里跑的是**旧引擎**（而且完全没有报错）。
 *      → `bundleTo()` 现打一份来**比字节**（`--check` 同款判据）。
 *   ② **数据通路**：页面靠 `POST /miliastra/engine` 拿 `scene`（节点级增量场景）。而 `slimPlay`
 *      原来**无条件**砍掉 `scene`/`paint` —— 那就等于页面永远拿不到画面。这里用 simOp 走一遍
 *      页面真正走的那串调用（start → get{sceneRev} → …），钉住「summaryOnly:false 必须给 scene」。
 *
 * 浏览器里的观感（拖拽手感、WebGL 是否真的画出来）**本测试覆盖不到** —— 那条保持 `pending`，
 * 要靠人打开页面看（同 `.gia` 真机导入那条纪律）。
 *
 * 用法：node tests/sim-play-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');
const PAGE = 'lib/sim-play/play.html';
const BUNDLE = 'lib/sim-play/dist/play-renderer.js';
const html = read(PAGE);

/* ------------------------------------------------- ① 产物：在、是 ESM、且没过期 */

ok('浏览器产物在库里（装插件的人不用自己构建）', fs.existsSync(path.join(PKG, BUNDLE)));
const bundleText = read(BUNDLE);
const bundleBytes = fs.statSync(path.join(PKG, BUNDLE)).size;
ok('产物是**打好的 ESM 单文件**（不是空壳、也没有裸 import 留着让浏览器解析）',
  bundleBytes > 100 * 1024 && /export\s*\{/.test(bundleText) && !/from\s*["']pixi\.js["']/.test(bundleText),
  bundleBytes + ' B, 含 export={' + /export\s*\{/.test(bundleText) + '}');
ok('产物真的导出了页面要用的两个名字（PixiPlayRenderer / createPlaySession）',
  bundleText.includes('PixiPlayRenderer') && bundleText.includes('createPlaySession'));

{
  // 现打一份比字节 —— 与 `node tools/build-sim-play.mjs --check` 同一判据（但不用起子进程）
  const { bundleTo } = await import('../tools/build-sim-play.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-playtest-'));
  try {
    const fresh = path.join(tmp, 'play-renderer.js');
    await bundleTo(fresh);
    ok('★ 入库的产物与当前源码一致（改了 browser 侧没重打包 → 这里红）',
      fs.readFileSync(fresh).equals(fs.readFileSync(path.join(PKG, BUNDLE))),
      fs.statSync(fresh).size + ' vs ' + bundleBytes);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  // CLI 入口本身也要能跑通（Windows 上 `import.meta.url === 'file://' + argv` 那种写法会静默不执行 —— 踩过）
  const cli = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(PKG, 'tools', 'build-sim-play.mjs'), '--check'], { cwd: PKG },
      (error, stdout, stderr) => resolve({ code: error ? (error.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  ok('★ `node tools/build-sim-play.mjs --check` 能真跑（主模块判定别用字符串拼 file://）',
    cli.code === 0 && /一致/.test(cli.stdout), 'code=' + cli.code + ' out=' + cli.stdout.slice(0, 80) + ' err=' + cli.stderr.slice(0, 80));
}

/* ------------------------------------------------- ② 页面：把这条路的约定钉住 */

ok('页面 import 的是**我们自己的**产物路径（不是 CDN、也不是 node_modules 裸包名）',
  /from\s*'\/miliastra\/play-renderer\.js'/.test(html) && !/https?:\/\//.test(html));
ok('页面用引擎自己的浏览器循环（PixiPlayRenderer + createPlaySession，与上游共用同一条）',
  html.includes('new PixiPlayRenderer(') && html.includes('createPlaySession(') && html.includes('bindInput('));
ok('★ 页面请求画面走 `summaryOnly:false`（默认的"瘦身"会把 scene 砍掉 → 黑屏）',
  /summaryOnly:\s*false/.test(html));
ok('页面打的是 `POST /miliastra/engine`（与面板、与 AI 工具**同一个入口**，状态不分裂）',
  html.includes("const API = '/miliastra/engine'") && /op:\s*'play'/.test(html));
ok('★ 关页面**不停局**（否则 `fromHistory` 那条"人玩一局 → AI 变回归用例"的路就断了）',
  !/action:\s*'stop'/.test(html) && /addEventListener\('pagehide'/.test(html));
ok('页面把 AI 的交接方式写在明面上（fromHistory 的调用样例 + 会重开会话的提醒）',
  html.includes('fromHistory') && /重开会话/.test(html));
ok('打开先 attach 已有会话，接不上才新开一局（不把人/AI 正在跑的局顶掉）',
  /play\.attach\(\)/.test(html) && /\.catch\(\(\) => play\.start\(/.test(html));

/*
 * ★ 报错必须**看得见**（2026-09-24 被嵌进面板 iframe 时暴露）：
 * `#fatal` 原来放在 `#side` 里，而 `#side` 默认 `display:none`（要点「侧栏」才出现）——
 * 于是「WebGL 起不来 / 会话没跑起来」一个字都看不到，用户看到的就是"一片黑"。
 * 这条把三件事钉住：报错条在 header 下面（不在侧栏里）、WebGL 初始化失败会当场说清、舞台尺寸没定下来时不会硬套小方块。
 */
ok('★ 报错条在**常驻可见**的位置（不在默认隐藏的侧栏里）—— 否则出错时只剩一片黑',
  /<\/header>\s*<div id="fatal"><\/div>/.test(html) && !/<aside id="side">[\s\S]*id="fatal"/.test(html));
ok('★ WebGL 初始化**包了 try/catch**：拿不到 WebGL 就明说（并建议用「新窗口」打开），而不是黑屏',
  /try\s*\{[\s\S]{0,120}new PixiPlayRenderer\(/.test(html) && /拿不到 WebGL/.test(html));
ok('★ 舞台尺寸**还没定下来**时不硬套（0×0 时下一帧重试；另挂 ResizeObserver 跟着面板缩放）',
  /box\.width < 40 \|\| box\.height < 40/.test(html) && /new ResizeObserver\(/.test(html));

{
  /*
   * ★ 内联 `<script type="module">` 的**语法校验**。
   * 一个笔误就是整页白屏，而浏览器**不会**把这种错告诉我（本机也没有浏览器自动化）——
   * 所以把那段脚本抠出来当 ESM 解析一遍（`--check` 只解析、不解析模块路径，正好）。
   */
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  ok('页面里有内联 module 脚本（试玩页的接线都在里面）', !!m && m[1].length > 800, m ? m[1].length + ' 字符' : '没找到');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-inline-'));
  try {
    const file = path.join(tmp, 'inline.mjs');
    fs.writeFileSync(file, m[1]);
    const r = await new Promise((resolve) => {
      execFile(process.execPath, ['--check', file], (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, err: String(stderr) || String(stdout) }));
    });
    ok('★ 内联脚本语法正确（笔误 → 整页白屏，且浏览器不会报给我）', r.code === 0, r.err.split('\n').slice(0, 3).join(' | '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------- ③ 路由 + 打包清单（页面要真能送到浏览器） */

const indexSrc = read('index.js');
ok('Host 有 `GET /miliastra/play` 路由（送页面）与 `/miliastra/play-renderer.js`（送产物）',
  indexSrc.includes("PREFIX + '/play'") && indexSrc.includes("PREFIX + '/play-renderer.js'"));
ok('产物缺失时**明确报错并给出补法**（不静默 404）',
  /浏览器产物缺失/.test(indexSrc) && /build-sim-play/.test(indexSrc));
{
  const pkg = JSON.parse(read('package.json'));
  ok('★ `files` 放行了 HTML（lib/**/*.html）—— 否则页面根本不进包，装了也没有试玩页',
    (pkg.files || []).includes('lib/**/*.html'), JSON.stringify(pkg.files));
  ok('`files` 覆盖产物（lib/**/*.js 已含 dist）', (pkg.files || []).includes('lib/**/*.js'));
  ok('新测试已挂进 `npm test`', /sim-play-test/.test(pkg.scripts.test));
  ok('发版前会校验产物不过期（prepublishOnly 跑 --check）', /--check/.test(pkg.scripts.prepublishOnly || ''));
  ok('esbuild 只在 devDependencies（装着插件的人不需要它）',
    !!pkg.devDependencies.esbuild && !pkg.dependencies.esbuild);
}

/* ------------------------------------------------- ④ 无浏览器的协议冒烟（页面依赖的那串调用） */

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-play-proto-'));
process.env.MILIASTRA_DATA_DIR = tmpData;
process.env.QXQY_PLAY_TIMEOUT_MS = '1500';
const { simOp, disposeSimAll } = await import('../lib/sim.mjs');
const err = async (fn) => { try { await fn(); return null; } catch (e) { return (e && e.message) || String(e); } };

try {
  await simOp({ op: 'patch', patch: { op: 'add', parentId: 'n1', kind: 'textbox', name: 'PLAY-PROBE' } });
  const started = await simOp({ op: 'play', action: 'start', args: { view: true, compact: true, canvasId: 'pc-16-9', playerCount: 1 }, summaryOnly: false });
  ok('★ 页面路径：`summaryOnly:false` 时回执**带 scene**（页面唯一的画面来源）',
    !!started.scene && started.scene.format === 'tree-v1' && Array.isArray(started.scene.nodes),
    JSON.stringify({ hasScene: !!started.scene, format: started.scene && started.scene.format, nodes: started.scene && started.scene.nodes && started.scene.nodes.length }));
  ok('页面路径：带回画布尺寸与帧号（fit 与状态栏要用）',
    started.canvasWidth > 0 && started.canvasHeight > 0 && typeof started.frame === 'number',
    JSON.stringify({ w: started.canvasWidth, h: started.canvasHeight, frame: started.frame }));

  const slim = await simOp({ op: 'play', action: 'get', args: { view: true, compact: true } });
  ok('对照：**默认**（summaryOnly 缺省）仍然只报计数、不回 scene（省体积的默认行为没被改坏）',
    slim.scene === undefined && typeof slim.sceneOmitted === 'number', JSON.stringify({ scene: slim.scene, omitted: slim.sceneOmitted }));

  const rev = Number(started.scene.revision) || 0;
  const poll1 = await simOp({ op: 'play', action: 'get', args: { view: true, compact: true, sceneRev: rev }, summaryOnly: false });
  ok('★ 轮询带 `sceneRev` 能接着拿增量场景（浏览器循环 33ms 就是这么拉的）',
    !!poll1.scene && Number.isFinite(Number(poll1.scene.revision)) && Number(poll1.scene.revision) >= rev,
    JSON.stringify({ rev, next: poll1.scene && poll1.scene.revision, changed: poll1.scene && poll1.scene.changed && poll1.scene.changed.length }));

  const acted = await simOp({ op: 'play', action: 'pointer', args: { type: 'click', x: 60, y: 60 } });
  ok('页面点画布走的是 `play action=pointer`（引擎的指针生命周期）', acted === undefined || acted.running !== undefined || !!acted,
    JSON.stringify(acted).slice(0, 120));

  const hist = await simOp({ op: 'play', action: 'history' });
  ok('页面侧栏的「操作时间线」拿得到（`play action=history`）', Array.isArray(hist.events),
    JSON.stringify({ events: (hist.events || []).length }));

  /* ⑤ AI 侧的收益点：人玩的那一局 → 回归用例（fromHistory） */
  const fromHist = await simOp({
    op: 'verify', fromHistory: true, shotOnFail: false,
    expect: [{ kind: 'count', name: 'PLAY-PROBE', atLeast: 1 }],
  });
  ok('★ AI 侧收益：`op=verify fromHistory:true` 把**刚玩那一局**的事件直接当用例跑（AI 不用手抄 events）',
    fromHist.passed === true && fromHist.case.events.length >= 1 && /fromHistory/.test(fromHist.note || ''),
    JSON.stringify({ passed: fromHist.passed, events: fromHist.case.events.length, note: String(fromHist.note || '').slice(-60) }));

  const noSession = await err(() => simOp({ op: 'verify', fromHistory: true, expect: [{ kind: 'log', contains: 'x' }] }));
  ok('fromHistory 没有活会话时：明确报错并给出路（不静默变成"零事件通过"）',
    !!noSession && /fromHistory/.test(noSession) && /play/.test(noSession), noSession);
} finally {
  await disposeSimAll();
  fs.rmSync(tmpData, { recursive: true, force: true });
}

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
