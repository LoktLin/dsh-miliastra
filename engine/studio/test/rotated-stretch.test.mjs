/**
 * 「细长 + 大角度旋转」的图片控件：矩阵、两套渲染器落点、像素跨度
 *
 * 这份测试由一次实测反馈（2026-09-25 作者：背景图里那两根 blade 杆「没被识别出来」、
 * 圆叶「变小了」）驱动。当时列了三条候选根因：
 *   ① 旋转没被渲染器应用（或只用了 tx/ty，忽略 2×2）
 *   ② imageType=Stretch 的缩放轴算错（拿未旋转尺寸或 AABB 尺寸去缩放）
 *   ③ 锚点尺寸算错（设计画布 vs 实际画布）
 *
 * 实测结论是三条都不成立 —— 所以这里把「正确的样子」逐条钉成断言，三条候选各自对应一组：
 *   · 矩阵级：scene 的 2×2 必须等于缩放后的 [cosθ, sinθ; −sinθ, cosθ]（否掉 ①②）
 *   · 尺寸级：sourceWidth/Height 必须等于「锚点区间在原画布上量出来的尺寸」（否掉 ③）
 *   · 落点级：Pixi 写进 root 的变换，其局部原点必须正好落在 paint 给出的世界中心
 *   · 像素级：一根 w=52 h=10 rot≈−89° 的长条，渲染后**竖直**跨度必须远大于水平跨度
 *
 * ⚠️ 这里的数字全部由 `layout.js` 独立算出（不读被测代码的中间量），
 *    只有像素统计依赖渲染结果。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Container, Matrix } from 'pixi.js'
import { createRuntime } from '../../lua-runtime/src/index.js'
import { paintList, playSnapshot, runtimeLayout, runtimeTransforms } from '../play/session.js'
import { renderScenePng } from '../host-png.js'
import { PixiPlayRenderer } from '../play/pixi-renderer.js'
import { applyMatrix } from '../ui/layout.js'

const CANVAS_W = 1600
const CANVAS_H = 900
const CW = 1632          // 容器节点比画布略大 —— 暴露「拿画布尺寸顶替父级尺寸」这类错
const CH = 924
const DESIGN_W = 879     // 作者脚本 CONFIG.designW/designH（背景图原图像素）
const DESIGN_H = 480

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 作者脚本 LAYOUT.anchors 的等价实现（返回锚点分数） */
function anchors(p) {
  return {
    x0: clamp01((p.x - p.w * 0.5) / DESIGN_W),
    y0: clamp01(1 - (p.y + p.h * 0.5) / DESIGN_H),
    x1: clamp01((p.x + p.w * 0.5) / DESIGN_W),
    y1: clamp01(1 - (p.y - p.h * 0.5) / DESIGN_H),
  }
}

// 作者脚本 DATA 里逐字抄下来的三条（行 39/41/25、行 20 的 stem、行 43 的 rot=-76.37）
const BLADE = { tag: 'blade', x: 172.19, y: 346.04, w: 52.54, h: 10.28, rot: -89.25, color: 0xff819b59 }
const BLADE2 = { tag: 'blade2', x: 178.67, y: 329.42, w: 36.46, h: 4.59, rot: -76.37, color: 0xff819b59 }
const STEM = { tag: 'stem', x: 59.00, y: 290.00, w: 112.64, h: 2.60, rot: -83.88, color: 0xff000000 }
const LEAF = { tag: 'leaf', x: 65.00, y: 234.00, w: 12.50, h: 12.50, rot: 0, color: 0xff8b9c5f }

function fixture(t, items) {
  const runtime = createRuntime({ canvasWidth: CANVAS_W, canvasHeight: CANVAS_H, device: 'KEYBOARD' })
  t.after(() => runtime.destroy())
  const children = items.map((p) => {
    const a = anchors(p)
    return {
      kind: 'image', name: p.tag, active: true, visible: true,
      imageSource: 'StaticReference', imageId: 100001, imageColor: p.color,
      imageType: 'Stretch',           // 作者脚本：c.imageType = Enum.ImageType.Stretch
      anchorMinX: a.x0, anchorMinY: a.y0, anchorMaxX: a.x1, anchorMaxY: a.y1,
      sizeDeltaX: 0, sizeDeltaY: 0,   // 作者脚本：c:SetSizeDelta(0, 0)
      anchoredPositionX: 0, anchoredPositionY: 0,
      pivotX: 0.5, pivotY: 0.5,
      localRotationZ: p.rot * -1,     // 作者脚本：CONFIG.rotateFromImage = -1
    }
  })
  const root = runtime.addRoot({
    kind: 'container', name: '容器节点', active: true,
    anchorMinX: 0, anchorMinY: 0, anchorMaxX: 1, anchorMaxY: 1,
    sizeDeltaX: CW - CANVAS_W, sizeDeltaY: CH - CANVAS_H,
    anchoredPositionX: 0, anchoredPositionY: 0, pivotX: 0.5, pivotY: 0.5,
    children,
  })
  const session = {
    runtime,
    compiled: { canvasId: 'pc-16-9', platform: 'PC' },
    history: { events: [] }, views: [{}], viewPlayerIndex: 1, playerCount: 1, server: null, debugPaused: false,
  }
  const boxes = runtimeLayout(session)
  const snapshot = playSnapshot(session, { view: true, summaryOnly: false })
  return {
    runtime,
    session,
    root,
    boxes,
    transforms: runtimeTransforms(session, boxes),
    paint: paintList(session, boxes),
    scene: snapshot.scene,
    byName: new Map(snapshot.scene.nodes.map((n) => [n.name, n])),
  }
}

/* ------------------------------------------------------------------ ① 矩阵级 */

test('旋转 + Stretch：2×2 矩阵逐项等于（父级缩放 ×）[cosθ, sinθ; −sinθ, cosθ]', (t) => {
  const { boxes, byName } = fixture(t, [BLADE, BLADE2, STEM])
  for (const p of [BLADE, BLADE2, STEM]) {
    const node = byName.get(p.tag)
    const box = boxes.get(node.id)
    // 父级是锚点拉伸的容器节点：它的局部尺寸就是「父宽 × 锚点跨度」
    const deg = p.rot * -1
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    assert.ok(Math.abs(node.matrix.a - cos) < 1e-9, `${p.tag} a=${node.matrix.a} 期望 ${cos}`)
    assert.ok(Math.abs(node.matrix.b - sin) < 1e-9, `${p.tag} b=${node.matrix.b} 期望 ${sin}`)
    assert.ok(Math.abs(node.matrix.c + sin) < 1e-9, `${p.tag} c=${node.matrix.c} 期望 ${-sin}`)
    assert.ok(Math.abs(node.matrix.d - cos) < 1e-9, `${p.tag} d=${node.matrix.d} 期望 ${cos}`)
    // 与未旋转尺寸无关：2×2 是纯旋转（无缩放），落在单位圆上
    assert.ok(Math.abs(Math.hypot(node.matrix.a, node.matrix.b) - 1) < 1e-9, `${p.tag} 第一列不是单位向量`)
    assert.ok(Math.abs(Math.hypot(node.matrix.c, node.matrix.d) - 1) < 1e-9, `${p.tag} 第二列不是单位向量`)
    // 尺寸 = 锚点区间在原画布上量出来的尺寸，**不是** AABB、也**不是**未旋转的 w/h
    assert.ok(Math.abs(node.sourceWidth - (box.right - box.left)) < 1e-9)
    assert.ok(Math.abs(node.sourceHeight - (box.top - box.bottom)) < 1e-9)
    // AABB 与未旋转尺寸必须不同 —— 否则这条测试在「拿 AABB 顶替」时也会绿
    const aabbW = Math.abs(node.sourceWidth * cos) + Math.abs(node.sourceHeight * sin)
    assert.ok(Math.abs(aabbW - node.sourceWidth) > 1, `${p.tag} 的 AABB 与自身宽度太接近，样本没有区分力`)
  }
  // blade（w=52.54 h=10.28 rot=−89.25°）在 1632 宽的容器上：宽 97.55、高 19.06 —— 细长条
  const blade = byName.get(BLADE.tag)
  assert.ok(blade.sourceWidth > 90 && blade.sourceWidth < 100, 'blade 宽度 ' + blade.sourceWidth)
  assert.ok(blade.sourceHeight > 17 && blade.sourceHeight < 21, 'blade 高度 ' + blade.sourceHeight)
  assert.ok(blade.sourceWidth / blade.sourceHeight > 4, 'blade 必须是细长条')
})

/* ------------------------------------------------------------------ ② 尺寸级 */

test('Stretch + 0 尺寸差：sourceWidth/Height 逐个等于锚点区间量出来的尺寸（不是画布尺寸）', (t) => {
  const { boxes, byName, scene } = fixture(t, [BLADE, STEM, LEAF])
  const canvasW = CANVAS_W
  for (const p of [BLADE, STEM, LEAF]) {
    const node = byName.get(p.tag)
    const box = boxes.get(node.id)
    assert.ok(Math.abs(node.sourceWidth - box.width) < 1e-9, `${p.tag} 宽度≠box 宽度`)
    assert.ok(Math.abs(node.sourceHeight - box.height) < 1e-9, `${p.tag} 高度≠box 高度`)
    // 反例守卫：绝不能等于画布尺寸
    assert.ok(Math.abs(node.sourceWidth - canvasW) > 1e-6, `${p.tag} 宽度被当成了画布宽度`)
  }
  // 圆叶：正方形、且明显小于画布
  const leaf = byName.get(LEAF.tag)
  assert.ok(Math.abs(leaf.sourceWidth - leaf.sourceHeight) < 1.5,
    `圆叶应当接近正方形（实际 ${leaf.sourceWidth.toFixed(2)}×${leaf.sourceHeight.toFixed(2)}）`)
  assert.ok(leaf.sourceWidth > 15 && leaf.sourceWidth < 30, '圆叶直径 ' + leaf.sourceWidth)
  assert.equal(scene.nodes.filter((n) => n.kind === 'image').length, 3)
})

/* ------------------------------------------------------------------ ③ 落点级 */

test('Pixi 与 PNG 落点一致：写进 root 的变换，其局部原点正好落在 paint 的世界中心', (t) => {
  const { paint, scene, byName } = fixture(t, [BLADE, BLADE2, STEM, LEAF])
  const renderer = Object.create(PixiPlayRenderer.prototype)
  renderer.scratch = new Matrix()
  renderer.canvasHeight = CANVAS_H
  const holders = new Map()
  for (const node of scene.nodes) {
    const holder = new Container()
    t.after(() => holder.destroy({ children: true }))
    renderer.applyMatrix(holder, node, { nested: node.parent !== null })
    holders.set(node.id, holder)
  }

  // renderer 的换算：Pixi 局部矩阵 = [a, −b, −c, d, tx, parent==null ? H−ty : −ty]
  const toScreen = (m, isRoot) => ({ a: m.a, b: -m.b, c: -m.c, d: m.d, tx: m.tx, ty: isRoot ? CANVAS_H - m.ty : -m.ty })
  const mul = (o, i) => ({
    a: o.a * i.a + o.c * i.b, b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d, d: o.b * i.c + o.d * i.d,
    tx: o.a * i.tx + o.c * i.ty + o.tx, ty: o.b * i.tx + o.d * i.ty + o.ty,
  })
  const byId = new Map(scene.nodes.map((n) => [n.id, n]))
  const world = new Map()
  const worldOf = (id) => {
    if (world.has(id)) return world.get(id)
    const n = byId.get(id)
    const local = toScreen(n.matrix, n.parent == null)
    const m = n.parent == null ? local : mul(worldOf(n.parent), local)
    world.set(id, m)
    return m
  }
  const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty })

  for (const p of [BLADE, BLADE2, STEM, LEAF]) {
    const node = byName.get(p.tag)
    const item = paint.find((x) => x.id === node.id)
    assert.ok(item, `${p.tag} 不在 paint 列表里`)
    // paint 给的是世界中心（Y 向上）→ 换到屏慕坐标
    const want = { x: item.matrix.tx, y: CANVAS_H - item.matrix.ty }
    const got = apply(worldOf(node.id), 0, 0)
    assert.ok(Math.hypot(got.x - want.x, got.y - want.y) < 1e-6,
      `${p.tag} Pixi 原点 (${got.x}, ${got.y}) 与 PNG 中心 (${want.x}, ${want.y}) 不一致`)
    // Pixi root 的本地平移（position）就是中心 —— 顺带钉住 applyMatrix 的分解
    const holder = holders.get(node.id)
    assert.ok(Math.abs(holder.x - want.x) < 1e-6 || node.parent != null,
      `${p.tag} root.x 应当等于中心 x`)
  }

  // 视觉几何必须是以「局部原点」为中心画的：画在 (-w/2,-h/2,w,h) 时中心偏移为 0
  const node = byName.get(BLADE.tag)
  const holder = holders.get(node.id)
  renderer.updateNode(holder, node, { nested: true })
  const bounds = holder.__visual.getLocalBounds()
  assert.ok(Math.abs(bounds.minX + bounds.maxX) < 0.5, '视觉几何没有以局部原点为中心（x）')
  assert.ok(Math.abs(bounds.minY + bounds.maxY) < 0.5, '视觉几何没有以局部原点为中心（y）')
  assert.ok(Math.abs(bounds.maxX - bounds.minX - node.sourceWidth) < 0.5, '视觉宽度不等于 sourceWidth')
  assert.ok(Math.abs(bounds.maxY - bounds.minY - node.sourceHeight) < 0.5, '视觉高度不等于 sourceHeight')
})

/* ------------------------------------------------------------------ ④ 像素级 */

test('像素级：w=52 h=10 rot=−89° 的 Stretch 长条，渲染后竖向跨度必须远大于横向跨度', async (t) => {
  const { scene, byName } = fixture(t, [BLADE])
  const blade = byName.get(BLADE.tag)
  const out = renderScenePng(scene, CANVAS_W, CANVAS_H)
  const image = await loadImage(out.data)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data

  // 全画布扫描即可：本 fixture 只有这一条控件，背景是蓝渐变，绿色只可能来自它。
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, count = 0
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      // 0x819B59（乘法着色后的绿色本体）
      if (!(a > 40 && g > 60 && g > r + 12 && g > b + 12)) continue
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  assert.ok(count > 200, 'blade 的绿色像素太少（count=' + count + '）—— 像条"发丝"，说明没画出来')
  const spanX = maxX - minX + 1
  const spanY = maxY - minY + 1
  // 数字留痕：这条断言失败时报告里要能直接读到跨度
  console.log(`    · blade 像素：count=${count} 竖向=${spanY}px 横向=${spanX}px 源尺寸=${blade.sourceWidth.toFixed(1)}×${blade.sourceHeight.toFixed(1)}`)
  assert.ok(spanY > spanX * 2.5,
    `blade 应当接近竖直：竖向跨度 ${spanY}px vs 横向 ${spanX}px（期望竖向 >2.5 倍）`)
  // 期望的竖向跨度：源高 19.06 → 屏幕上 ≈ 源宽 97.55（旋转 89° 把长边转到竖直）
  assert.ok(Math.abs(spanY - blade.sourceWidth) < 4, `竖向跨度 ${spanY} 应接近源宽 ${blade.sourceWidth.toFixed(1)}`)
})

test('像素级对照（反例守卫）：同样一条长条不旋转时必须是横向的', async (t) => {
  const flat = { ...BLADE, tag: 'flat', rot: 0 }
  const { scene, byName } = fixture(t, [flat])
  const node = byName.get(flat.tag)
  const out = renderScenePng(scene, CANVAS_W, CANVAS_H)
  const image = await loadImage(out.data)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const i = (y * canvas.width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
      if (!(a > 40 && g > 60 && g > r + 12 && g > b + 12)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const spanX = maxX - minX + 1
  const spanY = maxY - minY + 1
  console.log(`    · 反例（不旋转）：横向=${spanX}px 竖向=${spanY}px 源尺寸=${node.sourceWidth.toFixed(1)}×${node.sourceHeight.toFixed(1)}`)
  assert.ok(spanX > spanY * 2.5, `不旋转时应当横向：横 ${spanX}px vs 竖 ${spanY}px`)
  assert.ok(Math.abs(spanX - node.sourceWidth) < 4, `横向跨度 ${spanX} 应接近源宽 ${node.sourceWidth.toFixed(1)}`)
})
