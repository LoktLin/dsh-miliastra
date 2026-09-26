import { createRuntime } from '../../lua-runtime/src/index.js'

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function walkTree(nodes, visit) {
  for (const node of nodes || []) {
    visit(node)
    if (node.children?.length) walkTree(node.children, visit)
  }
}

function findControl(tree, { id, name }) {
  let hit = null
  walkTree(tree, (node) => {
    if (hit) return
    if (id && String(node.id) === String(id)) hit = node
    else if (!id && name && node.name === name) hit = node
  })
  return hit
}

/**
 * 数一数匹配的控件有几个。
 *
 * 为什么需要它：`tree{exists}` 只能回答「**建了吗**」，回答不了「**建了几个**」——
 * 而「每按一次加一条」这类动态 UI 恰恰要问数量（列表项、金币图标、连击星）。2026-09-24 加。
 */
function countControls(tree, { name, controlKind }) {
  let n = 0
  walkTree(tree, (node) => {
    if (name && node.name !== name) return
    if (controlKind && node.kind !== controlKind) return
    n += 1
  })
  return n
}

function readField(control, field) {
  if (!control) return undefined
  if (Object.prototype.hasOwnProperty.call(control, field)) return control[field]
  if (control.box && Object.prototype.hasOwnProperty.call(control.box, field)) return control.box[field]
  return undefined
}

function makeQuery(snap) {
  return {
    var(entityType, name) {
      return snap.server?.vars?.[entityType]?.[name]?.value ?? null
    },
    logs() {
      return (snap.logs || []).map((row) => row.text)
    },
    logContains(text) {
      return (snap.logs || []).some((row) => String(row.text || '').includes(String(text)))
    },
    serverLogs() {
      return (snap.server?.logs || snap.serverLogs || []).map((row) => row.text)
    },
    serverLogContains(text) {
      return (snap.server?.logs || snap.serverLogs || []).some((row) => String(row.text || '').includes(String(text)))
    },
    control(name) {
      const node = findControl(snap.tree, { name: String(name) })
      if (!node) return null
      return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        active: node.active,
        visible: node.visible,
        pressed: node.pressed,
        text: node.text,
        interactable: node.interactable,
      }
    },
    signals(direction) {
      const key = direction === 'outbound' ? 'outbound' : 'inbound'
      return (snap.server?.[key] || []).map((row) => ({ name: row.name, values: row.values }))
    },
  }
}

function evalJsonAssert(assert, snap) {
  /*
   * ★ `absent:true`（2026-09-26，本仓库加法改动）：把这一条断言的结论**反过来** ——
   *   「这个日志/控件/变量/信号/控件名**不该存在**」。
   *   为什么必须实现：`{"kind":"log","contains":"首错","absent":true}` 以前会被**静默忽略**，
   *   于是断言"莫名失败"，人/AI 会去查一个不存在的逻辑问题（实测踩到）。
   *   实现方式：原判定 `ok:true`（= 它**存在**）时改成失败，反之亦然；`actual` 原样保留（事实不变）。
   */
  const wrap = (result) => {
    if (!assert.absent) return result;
    const exists = result.ok === true;
    return exists
      ? { ok: false, actual: result.actual, expected: '不应存在（absent:true）', absent: true, message: 'assert.absent: 它**存在**，但断言要求它不存在' }
      : { ok: true, actual: result.actual, expected: '不应存在（absent:true）', absent: true };
  };
  if (assert.kind === 'log') {
    const logs = assert.source === 'server'
      ? (snap.server?.logs || snap.serverLogs || [])
      : (snap.logs || [])
    const hit = logs.some((row) => {
      if (assert.level && row.level !== assert.level) return false
      return String(row.text || '').includes(assert.contains)
    })
    return wrap(hit
      ? { ok: true, actual: assert.contains }
      : { ok: false, actual: logs.map((row) => row.text).slice(-8), expected: assert.contains })
  }
  if (assert.kind === 'control') {
    const control = findControl(snap.tree, assert)
    if (!control) {
      return wrap({ ok: false, actual: null, expected: assert.equals, message: `control not found: ${assert.id || assert.name}` })
    }
    // 「这个控件不该存在」——存在即失败；`actual` 报出**到底存在什么**（id/name/kind），一眼能定位
    if (assert.absent === true) {
      return { ok: false, actual: { id: control.id, name: control.name, kind: control.kind }, expected: '不应存在（absent:true）', absent: true, message: 'assert.absent: 这个控件**存在**' }
    }
    const actual = readField(control, assert.field)
    return wrap(same(actual, assert.equals)
      ? { ok: true, actual }
      : { ok: false, actual, expected: assert.equals })
  }
  if (assert.kind === 'var') {
    const bag = snap.server?.vars?.[assert.entityType]
    const missing = !bag || !Object.prototype.hasOwnProperty.call(bag, assert.name)
    const actual = missing ? null : bag[assert.name].value
    return wrap(same(actual, assert.equals)
      ? { ok: true, actual }
      : { ok: false, actual, expected: assert.equals })
  }
  if (assert.kind === 'signal') {
    const list = assert.direction === 'outbound' ? (snap.server?.outbound || []) : (snap.server?.inbound || [])
    const hit = list.find((row) => row.name === assert.name && (assert.values === undefined || same(row.values, assert.values)))
    return wrap(hit
      ? { ok: true, actual: hit.values }
      : { ok: false, actual: list.map((row) => ({ name: row.name, values: row.values })), expected: { name: assert.name, values: assert.values ?? null } })
  }
  if (assert.kind === 'tree') {
    const exists = Boolean(findControl(snap.tree, { name: assert.name }))
    // `absent:true` 时 `exists` 可以不传（"不该存在"本身就是期望）
    if (assert.absent === true && assert.exists === undefined) {
      return exists
        ? { ok: false, actual: exists, expected: '不应存在（absent:true）', absent: true }
        : { ok: true, actual: exists, expected: '不应存在（absent:true）', absent: true }
    }
    return wrap(exists === assert.exists
      ? { ok: true, actual: exists }
      : { ok: false, actual: exists, expected: assert.exists })
  }
  if (assert.kind === 'count') {
    const actual = countControls(snap.tree, assert)
    const atLeast = assert.atLeast === undefined ? null : Number(assert.atLeast)
    return atLeast === null
      ? (same(actual, assert.equals)
        ? { ok: true, actual, expected: assert.equals }
        : { ok: false, actual, expected: assert.equals })
      : (actual >= atLeast
        ? { ok: true, actual, expected: '>=' + atLeast }
        : { ok: false, actual, expected: '>=' + atLeast })
  }
  return { ok: false, message: `unsupported assert kind ${assert.kind}` }
}

function evalLuaAssert(source, snap) {
  const rt = createRuntime()
  try {
    rt.evalQueryScript(source, makeQuery(snap))
    return { ok: true, actual: true }
  } catch (err) {
    return { ok: false, message: err?.message || String(err) }
  } finally {
    rt.destroy()
  }
}

export function evaluateAssert(assert, snap) {
  if (assert.kind === 'lua') return evalLuaAssert(assert.source, snap)
  return evalJsonAssert(assert, snap)
}
