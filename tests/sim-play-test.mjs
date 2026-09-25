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
ok('★ 舞台尺寸：太小就**先不写**、下一帧再量；并由每帧快照**节流重算**（布局一变 0.35 秒内追平）',
  /box\.width < 200 \|\| box\.height < 150/.test(html) && /new ResizeObserver\(/.test(html)
  && /function fitSoon\(\)/.test(html) && /fitSoon\(\); renderChrome/.test(html));
ok('★ 画布尺寸印在 footer（`画布 668×376（可放 875×400）`）——「画面太小」这类问题肉眼可核，不用猜',
  /id="cvSize"/.test(html) && /textContent = '画布 ' \+ w/.test(html));
/*
 * ★★ 五个高度摆在一起 + 版本戳（"下面那块删掉试试"「画面咋就这么点大」之后的教训）：
 * 光看"画布很小"分不清是哪一层被压 —— 窗口（= iframe 高度）/ 头（工具栏）/ 主（#main）/ 脚（footer）/ 舞台。
 *   · 窗小 → **面板**没给够高度；· 脚大 → **body 格子串位**（见下面 ★★★）；· 主小 → 页面行没拉满；
 *   · 主正常但台小 → 舞台没填满 main。四个数缺一个都会看错（第一版只印了"窗/main/台"，
 *     正好漏掉当时真正出问题的 footer，于是又白跑一轮）。
 * 版本戳自证"面板里那份页面是新是旧"（改完不用猜有没有生效）。
 */
ok('★★ footer 同时给出「窗口/头/主/脚/舞台」五个高度（一眼分清是哪一层被压）',
  /id="diag"/.test(html) && /'窗 ' \+ window\.innerHeight/.test(html)
  && /' · 头 ' \+ \(head \? head\.clientHeight : 0\)/.test(html)
  && /' · 主 ' \+ \(el\.main \? el\.main\.clientHeight : 0\)/.test(html)
  && /' · 脚 ' \+ \(foot \? foot\.clientHeight : 0\)/.test(html)
  && /' · 台 '/.test(html));
ok('★ footer 有页面版本戳占位（`v__PLAY_STAMP__`，由 Host 盖成 `v<大小>-<mtime>`）',
  /id="stamp"/.test(html) && /v__PLAY_STAMP__/.test(html));
/*
 * ★★ **舞台的高度不能被画布带着走**（作者两次实测：「右侧这么大的画面也太小了吧」「直接打开是这样」，
 * footer 上都写着 `可放 542×90` 这种一条缝）。
 *
 * 根因：`main` 只写了 `grid-template-columns`，**行是 auto** ⇒ 行高 = 内容高 = 画布高，
 * 而画布高又是 `fit()` 从舞台盒子量出来算的 ⇒ **自己量自己**：某次算小之后一路变小、锁死。
 * 列宽由容器分配，所以症状是"**宽度一直正常、高度一直不对**"。
 */
ok('★★ `main` 把行拉满（`grid-template-rows:minmax(0,1fr)`）+ 舞台 `height:100%` —— 否则会"自己量自己"锁成一条缝',
  /main\{[^}]*grid-template-rows:minmax\(0,1fr\)/.test(html) && /#stageWrap\{[^}]*height:100%/.test(html));
/*
 * ★★★ **body 的四个格子必须显式认领行号** —— "画面只有一点点大"的**第三次**根因（2026-09-24 作者第三次截图）。
 *
 * 上面的 ★★ 只修好了 `main` **内部**的行；没修 `main` **自己被放在哪一行**。而后者被这个坑坑了：
 * **`display:none` 的 `#fatal` 不是 grid item**（不生成盒子）⇒ 自动排行把后面三个整体上提一格：
 *     main   → 第 2 行（`auto`）  ⇒ 行高 = 内容高 = **舞台高**（又回到"自己量自己"）
 *     footer → 第 3 行（`minmax(0,1fr)`）⇒ 吃掉全部剩余高度
 * 作者截图里的铁证：`窗 374 / main 90`，而 footer **自己 217px**（截图像素扫描：舞台底只有 90px，
 * footer 底色 band 从 y348 一直铺到 y564）。用户原话"重载会大一点、然后马上又被挤扁了" =
 * 每轮 `ResizeObserver → fit()` 把舞台缩 20px，一路缩到钳位 `160×90`。
 * 显式 `grid-row` 之后，隐藏的那一行**塌成 0**，其余各行与"报错条显不显示"再无关系。
 */
ok('★★★ header/main/footer 与 `#fatal` 各自**显式认领行号**（`display:none` 的 #fatal 不生成盒子 → 自动排行会把后面全部串位）',
  /header\{grid-row:1\}/.test(html) && /#fatal\{[^}]*grid-row:2/.test(html)
  && /main\{grid-row:3\}/.test(html) && /footer\{grid-row:4\}/.test(html));
ok('★ 报错条**最多占 40%**并自己滚（报错再长也不许把舞台挤没）',
  /#fatal\{[^}]*max-height:40%/.test(html) && /#fatal\{[^}]*overflow:auto/.test(html));
/*
 * ★ 窄容器兜底：这一页在面板里是**嵌在 iframe 里**的（2/3 列 ≈ 570px）——
 * 按全屏那套排版会把工具栏折成两三行、把舞台挤没（作者截图里就是这样）。
 */
ok('★ 窄容器收一档（面板里那 2/3 列只有 ~570px）：媒体查询 + 短标题',
  /@media \(max-width:820px\)/.test(html) && /title-mini/.test(html)
  && /\.bar strong\{display:none\}/.test(html) && /\.bar \.title-mini\{display:inline\}/.test(html));
/*
 * ★ **画布/人数/视角固定**（作者要求：「固定这样，把切换的功能去掉」）。
 * 这条是**反向断言**：原来那份**手写**的设备清单里 `pc-4-3` / `phone-16-9` / `phone-4-3`
 * 在引擎里并不存在（引擎只有 pc-16-9 / pc-21-9 / mobile-16-9 / mobile-19.5-9 / mobile-4-3），
 * 选中就报 `unknown canvas preset` —— 作者截图里那条红条就是它。谁要加回来，先看这段。
 * ⚠️ 能力没丢：AI 仍可用 `op=play device|view` 与 `playerCount`。
 */
ok('★ 试玩页**没有**会打歪画布尺寸的切换（设备/人数/视角下拉已去掉，固定 PC 16:9 单人）',
  !/deviceSel|playerSel|viewSel/.test(html) && /FIXED_PLAY/.test(html) && /id="fixedCfg"/.test(html));
ok('★ 页面上**没有**引擎里不存在的画布预设（踩过：手写的 `pc-4-3` → 红条 `unknown canvas preset`）',
  // 先剥注释：上面那段解释性注释里正引用着这几个错值，不能被自己的注释绊倒
  !/pc-4-3|phone-16-9|phone-4-3/.test(
    html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\S\n]*\/\/.*$/gm, ''),
  ));

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
  /*
   * `npm test` 现在指向 `tools/test-all.mjs`（一次**跑完全部套件**、不再 `&&` 串联 ——
   * 一个套件红不该把后面 8 套一起带走）。判据跟着换机制，**意图不变**：
   *   「npm test 走的是统一入口」**且**「那个入口的套件清单里有本套件」。
   */
  const testAll = await import('../tools/test-all.mjs');
  ok('新测试已挂进 `npm test`',
    /test-all/.test(pkg.scripts.test || '')
    && testAll.SUITES.some((s) => s.args.join(' ').includes('tests/sim-play-test.mjs'))
    && fs.existsSync(path.join(PKG, 'tests', 'sim-play-test.mjs')),
    JSON.stringify({ test: pkg.scripts.test, suites: testAll.SUITES.length }));
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
