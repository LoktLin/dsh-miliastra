// 移植自 xiaomoL444/ugc-tool（作者已授权，保持开源）—— 源文件：src/views/TextGradient/TextGradient.vue
//   （**只移植「逐帧富文本怎么算」**；这一段 Lua 是本仓自己写的驾驶层，原作者没有对应实现 ——
//     他那边是把逐帧文本复制出去，由玩家侧自己按帧切字。）
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 目标（作者 2026-09-28 明令）：**AI 调一次接口，回执里就是能直接用的 Lua** ——
//   不是数据模型、不是半成品、不是"再调一次拼起来"。
// ★ 所以这个文件的产出遵本仓 Lua 铁律（工作区 `AGENTS.md` §6）：
//   ① 控件拿不到 / 实例化返回 nil ⇒ **`error` 并点名**（控件名 / 模板号），绝不静默 return；
//   ② ⛔ 不做任何"掩盖报错的兜底"（没有 `pcall` 吞异常、没有屏幕诊断串、没有"建不出来就算了"）；
//   ③ 交接值全部走脚本顶部的 `CONFIG`，**不写裸数字**；缺了就 `error` 点名要交接，**绝不编造**；
//   ④ `script:EnableUpdate(true)` 必须显式打开（本仓实测：不开则 `OnUpdate` 永不执行）。
// ★ 未验证语法（官方 7.1 原文 0 命中的 `<size=N>` / 4bit 短格式）**默认关**；
//   一旦启用，生成的 Lua **顶部就有一行注释**说明它未经真机验证。

import { textGradient } from './gradient.mjs';
import { WarnCode } from '../receipt.mjs';

/** Lua 字符串字面量（只处理真正需要转义的：反斜杠、双引号、换行、制表符；中文原样保留）。 */
export function luaString(s) {
  const body = String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t');
  return '"' + body + '"';
}

/** 一帧的多段（999 字符分段）在 Lua 里拼回**一行**（那是网页展示用的分段，不是平台限制）。 */
export function frameToLuaLine(frame) {
  return (frame.lines || []).join('');
}

/** 顶部注释里的「未经真机验证」提醒（只在真的用到时出现）。 */
function unverifiedComments(unverified) {
  return (unverified || []).map((u) => `-- ⚠️ 本段含「${u.what}」：${u.why} —— **未经真机验证**，先在编辑器里试一次再发）`);
}

/**
 * 生成一份**可直接部署**的 Lua（逐帧富文本动画）。
 *
 * @param {{frames: any[], frameCount: number, fps: number, style: string, sizeStyle: string, fps2?: number}} data
 * @param {{mode: 'control'|'template', controlName: string, templateIndex: number|null, unverified: any[]}} target
 * @returns {string}
 */
export function buildTextGradientLua(data, target) {
  const isTemplate = target.mode === 'template';
  const ver = `text-gradient/${data.style}/${data.frameCount}f`;
  const lines = [];

  lines.push('-- 千星奇域 · 逐帧富文本动画（由 dsh-miliastra 的 `miliastra_gen op=text-gradient output=lua` 生成，勿手改）');
  lines.push(`-- 风格：颜色=${data.style}  字号=${data.sizeStyle}  帧数=${data.frameCount}  节奏=${data.fps} 帧/秒`);
  lines.push('-- 挂法：挂到「客户端控件容器 → 容器节点」这一层的**客户端脚本**上；'
    + (isTemplate ? 'CONFIG.TEMPLATE_INDEX 指向一个「存为模板」的文本框模板。' : 'CONFIG.CONTROL_NAME 指向它的**直接子**文本框控件。'));
  lines.push('-- 交接值说明：索引/控件名属于**创作者交接**（AI 拿不到）；本脚本缺了会 `error` 点名，绝不自己猜一个。');
  for (const c of unverifiedComments(target.unverified)) lines.push(c);
  lines.push('');

  lines.push(`local VER = ${luaString(ver)}`);
  lines.push('local CONFIG = {');
  if (isTemplate) {
    lines.push('    -- 交接值：文本框的**控件模板索引**（界面控件组管理 → 客户端控件模板里的那条独立模板）');
    lines.push(`    TEMPLATE_INDEX = ${Number.isFinite(target.templateIndex) && target.templateIndex ? target.templateIndex : 'nil'},`);
  } else {
    lines.push('    -- 交接值：要逐帧改字的**文本框控件名**（脚本宿主控件的直接子控件）');
    lines.push(`    CONTROL_NAME = ${luaString(target.controlName || '')},`);
  }
  lines.push('    FPS = ' + (Number.isFinite(data.fps) && data.fps > 0 ? data.fps : 8) + ',');
  lines.push('}');
  lines.push('');
  lines.push('-- 逐帧正文（每帧一项；生成时按 999 字符分段，这里已拼回一行）');
  lines.push('local FRAMES = {');
  for (const f of data.frames) lines.push('    ' + luaString(frameToLuaLine(f)) + ',');
  lines.push('}');
  lines.push('');

  lines.push('local textbox = nil');
  lines.push('local frame = 0');
  lines.push('local acc = 0');
  lines.push('');
  lines.push('/** 取到要改字的文本框：拿不到就 error 点名（不返回 nil、不静默） */');
  lines.push('local function resolve()');
  lines.push('    local host = script.object');
  lines.push('    if host == nil then');
  lines.push('        error("[text-gradient] script.object 为空：本脚本必须挂在「容器节点」这类客户端控件上")');
  lines.push('    end');
  if (isTemplate) {
    lines.push('    if CONFIG.TEMPLATE_INDEX == nil then');
    lines.push('        error("[text-gradient] 缺少交接值 CONFIG.TEMPLATE_INDEX：请创作者给出文本框模板的控件模板索引")');
    lines.push('    end');
    lines.push('    local c = game.InstantiateClientUIControl(CONFIG.TEMPLATE_INDEX, host)');
    lines.push('    if c == nil then');
    lines.push('        error("[text-gradient] InstantiateClientUIControl 返回 nil（模板索引 " .. tostring(CONFIG.TEMPLATE_INDEX)');
    lines.push('            .. "）：只有「存为模板」的独立控件能创建，画布上摆的实例恒返回 nil")');
    lines.push('    end');
    lines.push('    return c');
  } else {
    lines.push('    if CONFIG.CONTROL_NAME == "" then');
    lines.push('        error("[text-gradient] 缺少交接值 CONFIG.CONTROL_NAME：请创作者给出要逐帧改字的文本框控件名")');
    lines.push('    end');
    lines.push('    local c = host:GetChild(CONFIG.CONTROL_NAME)');
    lines.push('    if c == nil then');
    lines.push('        error("[text-gradient] 宿主控件下找不到名为「" .. CONFIG.CONTROL_NAME .. "」的直接子控件：请核对控件名是否写错")');
    lines.push('    end');
    lines.push('    if c.text == nil then');
    lines.push('        error("[text-gradient] 控件「" .. CONFIG.CONTROL_NAME .. "」没有 text 字段（不是文本框）：请换成文本框控件")');
    lines.push('    end');
    lines.push('    return c');
  }
  lines.push('end');
  lines.push('');
  lines.push('function OnStart()');
  lines.push('    print("[text-gradient] start ver=" .. VER .. " frames=" .. tostring(#FRAMES))');
  lines.push('    -- ⚠️ 不开这一句 OnUpdate 永不触发（本仓真机实测结论）');
  lines.push('    script:EnableUpdate(true)');
  lines.push('end');
  lines.push('');
  lines.push('function OnUpdate(dt)');
  lines.push('    if textbox == nil then');
  lines.push('        textbox = resolve()');
  lines.push('        -- 第一帧立刻上屏，不等累积（否则会先空一拍）');
  lines.push('        textbox.text = FRAMES[1]');
  lines.push('    end');
  lines.push('    acc = acc + dt');
  lines.push('    local step = 1 / CONFIG.FPS');
  lines.push('    if acc >= step then');
  lines.push('        acc = acc - step * math.floor(acc / step)');
  lines.push('        frame = (frame + 1) % #FRAMES');
  lines.push('        textbox.text = FRAMES[frame + 1]');
  lines.push('    end');
  lines.push('end');
  lines.push('');
  lines.push('function OnDestroy()');
  lines.push('    textbox = nil');
  lines.push('end');
  lines.push('');
  return lines.join('\n');
}

/**
 * `op=text-gradient` 造 Lua 的那条路（`output:"lua"`，**默认**）。
 *
 * @param {Record<string, any>} args 工具入参
 * @param {{mode?: 'control'|'template', controlName?: string, templateIndex?: number|null, from?: string|null, candidates?: any[]}} [handover]
 *        交接值的解析结果（`from` = `'arg'` / `'gil'` / `null`；`candidates` 是自动读 .gil 时看到的候选；
 *        `mode` 只在**自动读 .gil** 时要给 —— 手传参数时由「给了哪个」决定）
 * @returns {Record<string, any>}
 */
export function textGradientLua(args = {}, handover = {}) {
  const fps = Number.isFinite(Number(args.fps)) && Number(args.fps) > 0 ? Math.min(60, Number(args.fps)) : 8;
  /*
   * ⚠️ Lua 模式下 frames 是**正文**，一帧都不能少（`frames` 不传时 `textGradient` 只出前 60 帧 ——
   *    那是给"看数据"用的上限，对生成的动画来说是**静默截断**）。所以走两次：
   *    ① 先拿 `frameCount`；② 再按**全量下标**取一次逐帧正文。
   */
  const probe = textGradient(Object.assign({}, args, { summaryOnly: true }));
  if (!probe.ok) return probe;
  if (probe.frameCount === 0) {
    return {
      ok: false,
      op: 'text-gradient',
      error: '文本为空 ⇒ 帧数 0，生成不出逐帧动画。先给 text（或给 withColor/withSize 之外的内容）。',
    };
  }
  const allIndexes = Array.from({ length: probe.frameCount }, (_, i) => i);
  const data = textGradient(Object.assign({}, args, { summaryOnly: false, frames: allIndexes }));
  if (!data.ok) return data;

  const controlName = String(handover.controlName == null ? (args.controlName || '') : handover.controlName);
  const templateIndex = handover.templateIndex == null ? null : Number(handover.templateIndex);
  const mode = controlName !== '' && handover.mode !== 'template' ? 'control' : (Number.isFinite(templateIndex) && templateIndex ? 'template' : null);
  const warnings = [];
  const needsHandover = [];

  if (mode === null) {
    // ★ 作者要求：缺交接值就**报错点名**，绝不替创作者编一个索引
    return {
      ok: false,
      op: 'text-gradient',
      error: '生成 Lua 需要一个**交接值**，而它 AI 拿不到 —— 请向创作者要下面任意一个（别自己编）：'
        + '① 要逐帧改字的**文本框控件名**（脚本宿主容器下的直接子控件）→ 传 `controlName`；'
        + '② 文本框的**控件模板索引**（界面控件组管理里「存为模板」的那条）→ 传 `templateIndex`。',
      needsHandover: [
        { param: 'controlName', what: '文本框控件名（推荐：脚本挂在容器节点上，从它的直接子控件里按名字找）' },
        { param: 'templateIndex', what: '文本框的控件模板索引（走动态创建；只有「存为模板」的独立控件能创建）' },
      ],
      handoverFrom: handover.from || null,
      handoverCandidates: handover.candidates || [],
      stats: { charCount: data.charCount, frameCount: data.frameCount, colorFrameCount: data.colorFrameCount, sizeFrameCount: data.sizeFrameCount },
    };
  }

  if (handover.from === 'gil') {
    warnings.push({
      code: WarnCode.HANDOVER_AUTO_FROM_GIL,
      param: mode === 'template' ? 'templateIndex' : 'controlName',
      value: mode === 'template' ? templateIndex : controlName,
      note: '交接值是从**当前关卡的 .gil** 自动读到的（唯一候选）；部署前请与创作者核一眼',
    });
  }
  if (args.controlName && Number.isFinite(Number(args.templateIndex)) && Number(args.templateIndex)) {
    warnings.push({ code: WarnCode.HANDOVER_BOTH_GIVEN, note: '`controlName` 与 `templateIndex` 都给了 ⇒ 用 controlName（按名字找现成控件），templateIndex 被忽略' });
  }
  for (const u of data.unverified) warnings.push({ code: WarnCode.UNVERIFIED_SYNTAX, param: u.param, what: u.what, why: u.why });

  const lua = buildTextGradientLua(
    { frames: data.frames, frameCount: data.frameCount, fps, style: data.style.color, sizeStyle: data.style.size },
    { mode, controlName, templateIndex, unverified: data.unverified },
  );
  const luaLines = lua.split('\n').length;
  const nextStep = '用 `miliastra_code op=deploy` 把这段投到活文件（**必须显式传 `level` 与 `file`**，多脚本工程尤其要传 `file`），'
    + '然后在编辑器里**存一次盘**再试玩 —— 部署不会热加载正在进行的试玩。'
    + '想确认某局跑的是这版，看 `.gia` 里脚本自己 print 的 `start ver=…` 行。';
  const out = {
    ok: true,
    op: 'text-gradient',
    output: 'lua',
    target: { mode, controlName: mode === 'control' ? controlName : null, templateIndex: mode === 'template' ? templateIndex : null, fps },
    handoverFrom: handover.from || null,
    frameCount: data.frameCount,
    colorFrameCount: data.colorFrameCount,
    sizeFrameCount: data.sizeFrameCount,
    distinctColorFrames: data.distinctColorFrames,
    charCount: data.charCount,
    tags: data.tags,
    lua,
    luaBytes: Buffer.byteLength(lua, 'utf8'),
    lines: luaLines,
    framesPerLine: data.frames.map((f) => ({ index: f.index, chars: frameToLuaLine(f).length })),
    nextStep,
    warnings,
    needsHandover,
    unverified: data.unverified,
    deviations: data.deviations,
    notes: data.notes,
    summaryOnly: args.summaryOnly === true,
  };
  if (args.summaryOnly === true) {
    // ★ 只去 Lua 正文；**统计与 nextStep 必须留**
    delete out.lua;
    out.luaOmitted = true;
    out.luaBytesOmitted = out.luaBytes;
  }
  return out;
}
