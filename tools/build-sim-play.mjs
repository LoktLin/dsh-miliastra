/**
 * build-sim-play.mjs —— 把浏览器试玩页要用的渲染器打成**一个 ESM 文件**（esbuild）
 *
 * 为什么需要它：浏览器那条路要 `pixi.js`（WebGL），而浏览器不会解析 `node_modules` 里的裸包名
 * —— 必须预先 bundle 成单文件，页面才能 `import { PixiPlayRenderer } from '/miliastra/play-renderer.js'`。
 *
 * 两条纪律：
 *   ① **产物入库**（`lib/sim-play/dist/play-renderer.js`）：装插件的人不做构建也能用；
 *      所以要有「产物有没有过期」的绊线 —— `--check` 就是干这个的（`tests/sim-play-test.mjs` 用它）。
 *   ② **入口是引擎自己的渲染器**（`engine/studio/play/pixi-renderer.js`）：它 re-export 了
 *      `createPlaySession`，与上游 DSH 插件/Web 共用同一条浏览器循环（`platform: browser`）。
 *
 * 用法：
 *   node tools/build-sim-play.mjs            # 重新打（写进 lib/sim-play/dist/）
 *   node tools/build-sim-play.mjs --check    # 只校验：打一份到临时目录，与入库的那份比对字节
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(PKG, 'engine', 'studio', 'play', 'pixi-renderer.js');
const OUT = path.join(PKG, 'lib', 'sim-play', 'dist', 'play-renderer.js');

/** 是不是被 `node tools/build-sim-play.mjs` 直接跑的（Windows 的 `file:///C:/…` 与字符串拼的不一样，别用字符串比）。 */
function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return pathToFileURL(fs.realpathSync(argv1)).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href; }
  catch { return false; }
}

/** 打包条件（改这里就要重跑 build，`--check` 会比出来）。 */
export async function bundleTo(outfile) {
  await build({
    absWorkingDir: PKG,
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    // 浏览器里没有 Node 内建模块；真需要时让它显式报错而不是静默塞个桩
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return outfile;
}

const kb = (n) => Math.round(n / 1024) + ' KB';

if (isMain()) {
  const checkOnly = process.argv.includes('--check');
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await bundleTo(OUT);
    console.log('已重新打包：' + path.relative(PKG, OUT) + '  ' + kb(fs.statSync(OUT).size));
  } else {
    if (!fs.existsSync(OUT)) {
      console.error('✗ 入库的产物不存在：' + path.relative(PKG, OUT) + '\n  先跑 node tools/build-sim-play.mjs');
      process.exit(1);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-miliastra-build-'));
    const fresh = path.join(tmp, 'play-renderer.js');
    try {
      await bundleTo(fresh);
      const a = fs.readFileSync(OUT);
      const b = fs.readFileSync(fresh);
      if (!a.equals(b)) {
        console.error('✗ 入库的产物与当前源码打出来的不一致：'
          + path.relative(PKG, OUT) + ' ' + kb(a.length) + ' vs ' + kb(b.length)
          + '\n  说明有人改了 browser 侧源码却没重打包 —— 跑 node tools/build-sim-play.mjs 并提交产物。');
        process.exit(1);
      }
      console.log('✓ 浏览器产物与源码一致：' + path.relative(PKG, OUT) + '  ' + kb(a.length));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
