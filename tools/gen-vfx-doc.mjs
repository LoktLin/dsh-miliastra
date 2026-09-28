#!/usr/bin/env node
/**
 * 把 `packages/dsh-miliastra/lib/vfx/presets.mjs` 里的 13 个预设**生成成文档里的两张表**：
 *   ① 效果预设列表（id / 中文名 / 一句话 / 层数 / 默认贴图 / 适合什么场景 用手写的那张，不生成）
 *   ② **§5.0 发射器属性全表**（每个预设 × 每层 × 每个字段的实际取值 + 落程/池子核算）
 *
 * ★ 为什么要有它（而不是手写表格）：
 *   表格是**第二份副本**，手写必然与 `presets.mjs` 漂移（而且漂移了没人会发现 —— 文档不被断言）。
 *   生成器把"文档里的数字"钉在**唯一数据源**上：改了预设就重跑这一条。
 *
 * 替换范围：文档里 `<!-- VFX-PRESETS-TABLE-START -->` 与 `<!-- VFX-PRESETS-TABLE-END -->` 之间。
 * 用法：`node tools/gen-vfx-doc.mjs [--check]`（`--check` 只报告"会不会变"，不写盘 —— 给门禁用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPresets, buildPreset, estimateOf, travelOf, poolOf, BUDGET, CANVAS } from '../lib/vfx/presets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const DOC = path.join(REPO, 'docs', '千星奇域_粒子特效配置格式.md');
const START = '<!-- VFX-PRESETS-TABLE-START -->';
const END = '<!-- VFX-PRESETS-TABLE-END -->';

/** 每个预设"贴图"栏给几个**实读到的**真机可选号（不许编名字：目录里没有名称字段）。 */
const IMAGE_EXAMPLES = {
  100002: '`100002` 圆（几何号，模拟器可预览）',
  100005: '`100005` 五角星（几何号，模拟器可预览）',
  100006: '`100006` 圆环（几何号，模拟器可预览）',
  100001: '`100001` 方块（几何号，模拟器可预览）',
};
/** 真机可选号的例子（都来自 `miliastra_asset op=catalog` 实读；**不编名字**，只给分类）。 */
const REAL_IMAGE_EXAMPLES = '`101023` / `101005`（功能图标-彩色，`imgExists:true`）、`105001+`（装饰图案-彩色）';

const r = (x) => (Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))));
const range = (x) => `${r(x.min)}~${r(x.max)}`;
const point = (p) => `(${r(p.x)}, ${r(p.y)})`;
const color = (c) => `rgba(${r(c.r)},${r(c.g)},${r(c.b)},${r(c.a)})`;
const curve = (k) => k.map((e) => `${r(e.t)}:${r(e.value)}`).join(' → ');

/**
 * 生成两张表之间的正文（纯函数，便于 `--check` 与测试比对）。
 * @returns {string}
 */
export function renderVfxTables() {
  const L = [];
  L.push('> **账目口径**：坐标原点 = 父容器**中心**、y 向上为正；本关画布 ' + CANVAS.width + '×' + CANVAS.height
    + ' ⇒ x ∈ ±' + CANVAS.width / 2 + '、y ∈ ±' + CANVAS.height / 2 + '。');
  L.push('> 「上游同名」列写的是**上游那个预设的原始值**（`stars` / `snow` / `coins`）；其余 10 个上游没有，写 `—`。');
  L.push('> ★ 本仓**刻意改动**的理由逐条写在 `packages/dsh-miliastra/lib/vfx/presets.mjs` 每个预设的 `note` 里'
    + '（也随生成物一起打进文件头注释）—— 改预设时**改那里**，重跑本工具刷新这张表。');
  L.push('> 平台预算：每层 ≤ ' + BUDGET.perEmitter + ' / 总计 ≤ ' + BUDGET.total + '（上游自述，**无帧率证据**）。');
  L.push('');
  for (const p of listPresets()) {
    const built = buildPreset(p.name, {});
    const est = estimateOf(built);
    L.push(`#### \`${p.name}\` ${p.label}（${p.emitters} 层 · 默认时长 ${r(built.duration)}s · loop=${built.loop ? 'true' : 'false'}）`);
    L.push('');
    L.push('> ' + p.summary);
    if (p.name === 'chest-collect') {
      L.push('> ⚠️ **默认贴图号 = 待创作者给**（我们的素材目录里**单张图没有名称字段**，"哪个号是宝箱"没有依据可推 ⇒ 不猜）；');
      L.push('> 不传 `imageId` 时工具回 `ok:false + needsImageId`。');
    } else {
      L.push('> 默认贴图：' + (IMAGE_EXAMPLES[built.imageId] || `\`${built.imageId}\``)
        + '；真机可换成 ' + REAL_IMAGE_EXAMPLES + '（**任意素材号都行**，"6 个"只是模拟器的渲染限制）。');
    }
    L.push('> 每层池 = `PARTICLES_PER_EMITTER` = **' + built.particlesPerEmitter + '**；合计控件 **' + est.controls
      + '**（= 总预算的 ' + (est.controls / BUDGET.total * 100).toFixed(1) + '%）。');
    L.push('');
    L.push('| 字段（面板分组顺序） | ' + built.emitters.map((_, i) => String.fromCharCode(65 + i) + ' 层').join(' | ') + ' | 上游同名 |');
    L.push('|---|' + built.emitters.map(() => '---').join('|') + '|---|');
    /** 上游同名预设的原始值（只对三个老预设成立；其余写"—"）。 */
    const upstream = upstreamOf(p.name, built.emitters.length);
    const row = (label, pick, up) => {
      const cells = built.emitters.map((e) => pick(e));
      L.push('| ' + label + ' | ' + cells.join(' | ') + ' | ' + (up || '—') + ' |');
    };
    row('名称 / id', (e) => e.name, upstream ? upstream.name : null);
    row('粒子图片', (e) => (e.imageId === null ? '**待创作者给**' : String(e.imageId)), null);
    L.push('| **01 发射** | |'.replace(' | |', ' | ' + built.emitters.map(() => '').join(' | ') + ' |') + ' |');
    row('发射周期 duration（s）', (e) => r(e.duration), upstream ? upstream.duration : null);
    row('启动延迟 delay（s）', (e) => r(e.delay), upstream ? '0（单层）' : null);
    row('循环发射 loop', (e) => String(e.loop), upstream ? 'true' : null);
    row('每秒发射 rate', (e) => r(e.rate), upstream ? String(upstream.rate) : null);
    row('周期起点爆发 burst', (e) => r(e.burst), upstream ? String(upstream.burst) : null);
    row('粒子池上限 maxParticles', (e) => String(e.maxParticles), upstream ? String(upstream.max) : null);
    row('随机种子 seed', (e) => String(e.seed), null);
    L.push('| **02 出生形状** | ' + built.emitters.map(() => '').join(' | ') + ' | — |');
    row('形状 shape', (e) => e.shape, upstream ? upstream.shape : null);
    row('位置 X / Y（origin）', (e) => `${r(e.origin.x)} / ${r(e.origin.y)}`, upstream ? upstream.origin : null);
    row('半径 radius', (e) => r(e.radius), null);
    row('区域宽 × 高', (e) => `${r(e.width)} × ${r(e.height)}`, upstream ? upstream.size2 : null);
    L.push('| **03 运动** | ' + built.emitters.map(() => '').join(' | ') + ' | — |');
    row('运动模式 motion', (e) => e.motion, upstream ? upstream.motion : null);
    row('速度（范围）', (e) => range(e.speed), upstream ? upstream.speed : null);
    row('方向角 angle（度）', (e) => r(e.angle), upstream ? upstream.angle : null);
    row('散角 spread（度）', (e) => r(e.spread), upstream ? upstream.spread : null);
    row('重力 gravity', (e) => point(e.gravity), upstream ? upstream.gravity : null);
    row('P1 / P2 / 终点（贝塞尔）', (e) => (e.motion === 'bezier' ? `${point(e.control1)} / ${point(e.control2)} / ${point(e.target)}` : '—'), upstream ? upstream.path : null);
    L.push('| **04 尺寸与旋转** | ' + built.emitters.map(() => '').join(' | ') + ' | — |');
    row('初始旋转（范围）', (e) => range(e.rotation), null);
    row('自转 spin（度/秒）', (e) => range(e.spin), upstream ? upstream.spin : null);
    row('尺寸（范围，px）', (e) => range(e.size), upstream ? upstream.size : null);
    row('尺寸曲线关键点', (e) => curve(e.sizeCurve), null);
    L.push('| **05 颜色** | ' + built.emitters.map(() => '').join(' | ') + ' | — |');
    row('出生色 RGBA', (e) => color(e.startColor), upstream ? upstream.start : null);
    row('结束色 RGBA', (e) => color(e.endColor), upstream ? upstream.end : null);
    row('不透明度曲线关键点', (e) => curve(e.alphaCurve), null);
    L.push('');
    // 两行核算
    const travels = built.emitters.map((e) => travelOf(e));
    const pools = built.emitters.map((e) => poolOf(e));
    const tInfo = travels[0].kind === 'bezier'
      ? '折线长 ' + travels.map((t) => r(t.bezierLength) + 'px').join(' / ')
      : travels.map((t) => r(t.travel) + 'px').join(' / ');
    L.push('- **落程**：' + tInfo + '（`v·t + ½|g|t²`，用平均速度与平均寿命估）'
      + (travels[0].kind === 'velocity' && Math.max(...travels.map((t) => t.travel)) >= CANVAS.height
        ? ' ⇒ **≥ 屏高 ' + CANVAS.height + 'px**，能落到底' : ''));
    L.push('- **需要的池**：' + pools.map((p) => `${p.concurrent}（= ${r(p.rate)} × ${r(p.lifetimeMax)}）`).join(' / ')
      + ' ⇒ 本仓每层给 **' + built.particlesPerEmitter + '**，'
      + (pools.every((p) => p.enough) ? '**都够**' : '**有层不够**')
      + `；两层合计 ${est.controls} 控件（每层上限 ${BUDGET.perEmitter} / 总计 ${BUDGET.total}）。`);
    L.push('- **出生区域**：' + est.layers.map((l) => (l.spawnInside ? '在画布内' : '**有部分是超框的（会被裁）**')).join(' / ') + '。');
    L.push('');
  }
  return L.join('\n');
}

/** 上游同名预设的原始值（只对 `stars` / `snow` / `coins` 三个成立，其余返回 null —— 不编）。 */
function upstreamOf(name, layers) {
  const U = {
    'star-scatter': {
      name: '星光 A（上游 stars 只有 1 层）', rate: 28, burst: 16, max: 100, shape: 'circle',
      duration: '2', origin: '(0, 0)', size2: '（circle 用半径 radius=12）', motion: 'velocity',
      speed: '60~170', angle: 90, spread: 360, gravity: '(0, -35)', spin: '-90~90',
      size: '8~20', start: '(255,239,183,1)', end: '(255,146,73,1)', path: '—',
    },
    'snow-fall': {
      name: '雪花（上游 snow 只有 1 层）', rate: 18, burst: 0, max: 140, shape: 'box',
      duration: '6', origin: '(0, 230)（上游画布 960×540）', size2: '760 × 15', motion: 'velocity',
      speed: '30~60', angle: -90, spread: 30, gravity: '(2, -4)', spin: '-30~30',
      size: '4~11', start: '(225,241,255,.9)', end: '(179,210,255,.4)', path: '—',
    },
    'coin-collect': {
      name: '收集光点（上游 coins 只有 1 层）', rate: 12, burst: 10, max: 100, shape: 'circle',
      duration: '2.5', origin: '(-180, -80)', size2: '（circle 用半径 radius=60）', motion: 'bezier',
      speed: '60~170（上游 bezier 不用它）', angle: 90, spread: 360, gravity: '(0, -35)',
      spin: '-90~90', size: '12~22', start: '(255,224,100,1)', end: '(255,249,216,1)',
      path: '(-100,230) / (300,-80) / (430,210)',
    },
  };
  const u = U[name];
  if (!u) return null;
  return Object.assign({}, u, { layers });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const doc = fs.readFileSync(DOC, 'utf8');
  const i = doc.indexOf(START);
  const j = doc.indexOf(END);
  if (i < 0 || j < 0 || j < i) {
    console.error('✗ 文档里找不到表格标记：' + START + ' / ' + END + '（在 ' + DOC + '）');
    process.exit(1);
  }
  const body = renderVfxTables();
  const next = doc.slice(0, i + START.length) + '\n' + body + doc.slice(j);
  const changed = next !== doc;
  if (process.argv.includes('--check')) {
    console.log((changed ? '✗ 表格与 presets.mjs 不一致' : '✓ 表格与 presets.mjs 一致')
      + `（正文 ${body.split('\n').length} 行 / ${Buffer.byteLength(body, 'utf8')} 字节）`);
    process.exit(changed ? 1 : 0);
  }
  if (!changed) {
    console.log('✓ 无需改动（表格已是最新）');
  } else {
    fs.writeFileSync(DOC, next, 'utf8');   // 文档不是活文件；UTF-8 无 BOM
    console.log('✓ 已刷新 §5.0 发射器属性全表 → ' + DOC
      + `（正文 ${body.split('\n').length} 行）`);
  }
}
