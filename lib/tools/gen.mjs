/**
 * `miliastra_gen` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import pathMod from 'node:path';
import { CLIENT_CONTROL_NAME, classifyControls, resolveLevel } from '../shared.mjs';
import { ROLE, handoverFromString, ledgerNote, lookupHandover } from '../handover-ledger.mjs';
import { STYLE_CHOICES, textGradient } from '../textgradient/gradient.mjs';
import { atomicWriteFile } from '../fsx.mjs';
import { createHash } from 'node:crypto';
import { pixelArt } from '../pixelart/index.mjs';
import { readGil } from '../gil.mjs';
import { structJson } from '../structvar/build.mjs';
import { textGradientLua } from '../textgradient/lua.mjs';
import { vfxLua } from '../vfx/index.mjs';
import { ReceiptCode } from '../receipt.mjs';

export function genOp(args = {}) {
  const op = String(args.op || 'text-gradient');
  if (op === 'text-gradient') {
    const output = String(args.output || 'lua');
    if (output !== 'lua' && output !== 'data') {
      throw new Error('output 只能是 lua / data，收到：' + JSON.stringify(args.output));
    }
    if (output === 'data') return textGradient(args);
    // 交接值：显式参数优先；都没有才去 .gil 自动拿（唯一候选才采用）；拿不到就**报错点名**（绝不编）
    const givenName = args.controlName === undefined || args.controlName === null ? '' : String(args.controlName);
    const givenTmpl = Number(args.templateIndex);
    /** @type {{mode: 'control'|'template'|null, controlName: string, templateIndex: number|null, from: string|null, candidates: any}} */
    let auto = { mode: null, controlName: '', templateIndex: null, from: null, candidates: null };
    if (givenName !== '') {
      auto = { mode: 'control', controlName: givenName, templateIndex: null, from: 'arg', candidates: null };
    } else if (Number.isFinite(givenTmpl) && givenTmpl) {
      auto = { mode: 'template', controlName: '', templateIndex: givenTmpl, from: 'arg', candidates: null };
    } else {
      auto = autoHandoverFromGil(args) || auto;
    }
    const hits = [];
    if (auto.mode === null) {
      // P2-8 最后一档：台账里已确认过的文本框控件名 / 文本框模板索引
      const nameHit = ledgerHit(args, ROLE.textboxControlName);
      if (nameHit) {
        hits.push({ role: ROLE.textboxControlName, hit: nameHit.hit });
        auto = { mode: 'control', controlName: String(nameHit.hit.value), templateIndex: null, from: 'ledger', candidates: auto.candidates };
      } else {
        const tmplHit = ledgerHit(args, ROLE.textboxTemplate);
        if (tmplHit) {
          hits.push({ role: ROLE.textboxTemplate, hit: tmplHit.hit });
          auto = { mode: 'template', controlName: '', templateIndex: Number(tmplHit.hit.value) || null, from: 'ledger', candidates: auto.candidates };
        }
      }
    }
    return withLedgerNote(textGradientLua(args, auto), hits);
  }
  if (op === 'pixel-art') return pixelArtOp(args);
  if (op === 'vfx-lua') {
    /*
     * ★★ 渐进式披露（作者 2026-09-30 明令）：`preset` **不做 enum**（12 个 id 进 schema 会吃几百字符），
     *   改成 `preset:"list"` **按需枚举** —— 第 1 层只放"怎么找到预设"，第 2 层是这条 op 的回执，
     *   第 3 层（完整属性表 / 换算 / 模拟器边界）全在文档里（回执恒带 `doc` 指针）。
     */
    if (String(args.preset || '').trim() === 'list') return vfxLua(args, {});
    // 交接值：显式参数优先；都没有才去 `.gil` 自动拿（**只有唯一候选才采用**）→ 还缺就 needsHandover[]
    const givenTmpl = Number(args.templateIndex);
    const givenBox = Number(args.container);
    const hasTmpl = Number.isFinite(givenTmpl) && givenTmpl !== 0;
    const hasBox = Number.isFinite(givenBox) && givenBox !== 0;
    if (hasTmpl && hasBox) return vfxLua(args, { templateIndex: givenTmpl, container: givenBox, from: 'arg', candidates: null });
    const auto = autoPixelArtFromGil(args);     // 同一条读取路径：图片模板 + 容器节点（唯一候选才采用）
    const hits = [];
    let tmpl = hasTmpl ? givenTmpl : (auto ? auto.templateIndex : null);
    let box = hasBox ? givenBox : (auto ? auto.container : null);
    let fromLedger = false;
    if (!Number.isFinite(tmpl) || !tmpl) {
      const h = ledgerHit(args, ROLE.imageTemplate);
      if (h) { tmpl = Number(h.hit.value) || null; hits.push({ role: ROLE.imageTemplate, hit: h.hit }); fromLedger = true; }
    }
    if (!Number.isFinite(box) || !box) {
      const h = ledgerHit(args, ROLE.container);
      if (h) { box = Number(h.hit.value) || null; hits.push({ role: ROLE.container, hit: h.hit }); fromLedger = true; }
    }
    const fromGil = !!(auto && ((!hasTmpl && auto.templateIndex) || (!hasBox && auto.container)));
    const out = vfxLua(args, {
      templateIndex: tmpl, container: box,
      from: handoverFromString({ arg: hasTmpl || hasBox, gil: fromGil, ledger: fromLedger }),
      candidates: auto ? auto.candidates : null,
    });
    return withLedgerNote(out, hits);
  }
  if (op === 'struct-json') return structJson(args);
  throw new Error('没有这个 op：' + JSON.stringify(op) + '（支持 text-gradient / struct-json / pixel-art / vfx-lua）');
}

export function applySaveTo(res, saveTo) {
  if (!saveTo || !res || res.ok !== true) return res;
  const TEXT_KEYS = ['lua', 'json', 'struct', 'text'];
  let key = null;
  for (const k of TEXT_KEYS) { if (typeof res[k] === 'string' && res[k]) { key = k; break; } }
  if (!key) return res;
  const text = res[key];
  const abs = pathMod.resolve(String(saveTo));
  /*
   * ⚠️ 2026-10-08 对抗测试实测修：这里原来直接 `atomicWriteFile` —— 路径不可写时**抛异常**，
   *   被宿主兜底成 `{ok:false, error:"ENOENT…", tool}` ⇒ 调用方只拿到一句裸系统错误、**没有 code / nextStep**，
   *   也违反本仓红线「失败回 `{ok:false,error}`，**不抛异常**」（其余分支都是 `MEASURE_DECODE_FAILED` 那种形态）。
   */
  try {
    atomicWriteFile(abs, text);
  } catch (e) {
    return {
      ...res, ok: false, saved: false, code: ReceiptCode.SAVE_FAILED, path: abs,
      error: '`saveTo` 写盘失败：' + ((e && e.message) || String(e)),
      nextStep: '`saveTo` 要**可写的绝对路径**（父目录必须已存在 —— 本工具不替调用方 mkdir）；'
        + '不想落盘就把 `saveTo` 去掉（回执仍回正文）。',
    };
  }
  const out = { ...res };
  delete out[key];
  return {
    ...out,
    saved: true,
    path: abs,
    savedField: key,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
    sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex').toUpperCase(),
    nextStep: '生成物已落盘（不进回执）⇒ 要部署走 `miliastra_code op=deploy`（**必须显式给 level + file**），'
      + '部署后 **存盘 → 试玩 → `miliastra_map op=script` 看 match:true**。',
  };
}

/**
 * 从 `.gil` 自动拿交接值（唯一候选才采用；拿不到返回 null ⇒ 交给上层去问人）。
 *
 * ★ 这里**必须显式写返回类型**：函数体里 `mode` 是普通字符串变量（`'control'` / `'template'` / `null`），
 *   不写的话会被推断成 `string`；而调用方把返回值赋给声明为 `'control'|'template'|null` 的变量 ⇒ TS2322。
 *   （2026-10-08 阶段 3 把它搬成独立模块后暴露 —— 原 `index.js` 里周围上下文掩盖了这条。）
 * @param {any} [args] 工具入参（只读 `args.level`）
 * @returns {{mode: 'control'|'template'|null, controlName: string, templateIndex: number|null, from: string|null, candidates: any}|null}
 */
export function autoHandoverFromGil(args = {}) {
  let gil;
  try {
    const lv = resolveLevel(args.level);
    if (!lv || !lv.gil) return null;
    gil = readGil(lv.gil.path);
  } catch { return null; }                      // 没有存档 / 读不动 ⇒ 当成"拿不到"，交给上层去问人
  if (!gil || !gil.ok || !gil.clientUI) return null;
  const c = classifyControls(gil.clientUI);
  const byId = new Map(gil.clientUI.map((r) => [r.id, r]));
  const templates = c.likelyTemplates.filter((r) => r.name === '文本框');
  // 容器节点下**有名字**的子控件：名字是创作者起的（`文本框`/`图片` 这类**类型名**不算 —— 那是模板自己的名字）
  const named = gil.clientUI.filter((r) => r.parent != null && r.name && !CLIENT_CONTROL_NAME.test(r.name)
    && byId.get(r.parent) && byId.get(r.parent).name === '容器节点');
  const candidates = {
    levelId: (gil.level && gil.level.id) || null,
    textboxTemplates: templates.map((r) => ({ templateIndex: r.id, name: r.name })),
    /*
     * ★ 2026-09-28（`op=pixel-art`）：再加两栏 —— **图片**模板与**容器节点**。
     *   与 `textboxTemplates` 同一条纪律：`.gil` 的控件记录里**没有类型字段**，
     *   所以"名字叫 `图片` 的那个"只是**候选**（创作者按类型名起的），采用前仍然要求**唯一**。
     */
    imageTemplates: c.likelyTemplates.filter((r) => r.name === '图片').map((r) => ({ templateIndex: r.id, name: r.name })),
    containerNodes: c.likelyContainers.map((r) => ({ container: r.id, name: r.name })),
    namedChildrenOfContainer: named.map((r) => ({ name: r.name, id: r.id, parent: r.parent })),
    note: '这两个清单来自 `.gil` 的控件记录（只有 id / name / parent）；记录里**没有控件类型**，'
      + '所以「哪个是有名字的文本框」「哪个是图片模板」要创作者确认 —— 本工具不替你认。',
  };
  if (named.length === 1 && String(named[0].name).trim() !== '') {
    return { mode: 'control', controlName: String(named[0].name), templateIndex: null, from: 'gil', candidates };
  }
  if (!named.length && templates.length === 1) {
    return { mode: 'template', controlName: '', templateIndex: templates[0].id, from: 'gil', candidates };
  }
  return { mode: null, controlName: '', templateIndex: null, from: null, candidates };
}

export function ledgerHit(args, role) {
  let levelId = null;
  try {
    const lv = resolveLevel(args && args.level);
    levelId = lv && lv.levelId ? String(lv.levelId) : null;
  } catch { levelId = null; }
  if (!levelId) return null;
  const hit = lookupHandover({ levelId, role });
  return hit ? { hit } : null;
}

export function withLedgerNote(receipt, hits) {
  const note = ledgerNote(hits);
  if (!note) return receipt;
  if (receipt && typeof receipt === 'object') {
    receipt.handoverLedger = note;
    receipt.handoverLedgerNote = '这几项**不是本次调用传的**，是台账里已确认过的值（`miliastra_health op=handover` 可查/改）。';
  }
  return receipt;
}

export async function pixelArtOp(args = {}) {
  const handover = resolvePixelArtHandover(args);
  const out = await pixelArt(args, handover);
  return withLedgerNote(out, handover.ledgerHits);
}

export function autoPixelArtFromGil(args = {}) {
  const auto = autoHandoverFromGil(args);
  if (!auto || !auto.candidates) return null;
  const imgs = Array.isArray(auto.candidates.imageTemplates) ? auto.candidates.imageTemplates : [];
  const conts = Array.isArray(auto.candidates.containerNodes) ? auto.candidates.containerNodes : [];
  const templateIndex = imgs.length === 1 ? Number(imgs[0].templateIndex) : null;
  const container = conts.length === 1 ? Number(conts[0].container) : null;
  return { templateIndex, container, candidates: auto.candidates };
}

export function resolvePixelArtHandover(args = {}) {
  const givenTmpl = Number(args.templateIndex);
  const givenContainer = Number(args.container);
  const hasTmpl = Number.isFinite(givenTmpl) && givenTmpl !== 0;
  const hasContainer = Number.isFinite(givenContainer) && givenContainer !== 0;
  const hits = [];
  const auto = (hasTmpl && hasContainer) ? null : autoPixelArtFromGil(args);
  let tmpl = hasTmpl ? givenTmpl : (auto ? auto.templateIndex : null);
  let cont = hasContainer ? givenContainer : (auto ? auto.container : null);
  let fromLedger = false;
  if (!Number.isFinite(tmpl) || !tmpl) {
    const h = ledgerHit(args, ROLE.imageTemplate);
    if (h) { tmpl = Number(h.hit.value) || null; hits.push({ role: ROLE.imageTemplate, hit: h.hit }); fromLedger = true; }
  }
  if (!Number.isFinite(cont) || !cont) {
    const h = ledgerHit(args, ROLE.container);
    if (h) { cont = Number(h.hit.value) || null; hits.push({ role: ROLE.container, hit: h.hit }); fromLedger = true; }
  }
  const fromGil = auto ? ((!hasTmpl && auto.templateIndex) || (!hasContainer && auto.container)) : false;
  const fromArg = hasTmpl || hasContainer;
  return {
    templateIndex: Number.isFinite(tmpl) && tmpl ? Number(tmpl) : null,
    container: Number.isFinite(cont) && cont ? Number(cont) : null,
    from: handoverFromString({ arg: fromArg, gil: !!fromGil, ledger: fromLedger }),
    candidates: auto ? auto.candidates : null,
    ledgerHits: hits,
  };
}

export const GEN_TOOL = {
    name: 'miliastra_gen',
    description:
      TITLE + '：**离线生成器** —— 一次调用就出**可直接部署的 Lua**（不是数据模型、不是半成品）。\nop=text-gradient：文本 → 色标 → **逐帧刷字**客户端 Lua（`EnableUpdate` + `OnUpdate` 换帧）。\nop=struct-json：结构体/字典 → 可直接导入千星的变量 JSON。\nop=pixel-art：图片 → 可部署**像素画 Lua**（图片控件**矩形块拼图**，非「一个像素一个控件」；要 `cols`/`rows`/`maxSide` + `pixelSize`；**静态不加 EnableUpdate**）。\nop=vfx-lua：**UI 粒子特效** → 可部署客户端 Lua（预设用 `preset:"list"` 按需枚举；贝塞尔用 `path` 三手柄）。\n★ 粒子贴图 `imageId` 真机可用**全部 1543 素材号**（`op=catalog` 挑）；**模拟器只画 `100001~100006`** ⇒ 预览传 `previewImageId`。\n★ **硬规则**：结构体 ID 必须 **10 位数字**、单条文本 **≤500 字符**（放行传 `allowLongText:true`）—— 生成前校验。\n★ **交接值**（模板索引/控件名/容器索引）AI 拿不到：**先自动读当前关卡 `.gil`**（唯一候选才采用），拿不到就**报错点名**（`needsHandover[]`），**绝不编**；`vfx-lua` 的 `container` 与 `templateIndex` 同等必填。\n★ `preflight[]` 投递前自检（`ok:null` = 判不了、**不猜**）；`unverified[]` 记未验证项；产物顶部带**运行时依赖清单**。\n\n**典型调用**：`{"op":"text-gradient","text":"原神千星","colors":["#FFCC33","#37FFFF"],"controlName":"标题"}`｜`{"op":"pixel-art","assetId":"a1b2c3d4e5f60718","cols":32,"pixelSize":8,"templateIndex":1073741900,"container":1073741866}`｜`{"op":"vfx-lua","preset":"coin-collect","imageId":101023,"previewImageId":100002}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['text-gradient', 'struct-json', 'pixel-art', 'vfx-lua'], description: '默认 text-gradient。' },
        output: { type: 'string', enum: ['lua', 'data', 'struct'], description: '默认 lua（回执给可部署的 Lua + `luaBytes`/`lines`）；`data` = 只要数据；`struct` 只有 pixel-art 用。' },
        /* ★ P0-1（《上下文瘦身设计》）：**生成物落盘、不进回执** ——
         *   原默认回执里 `lua` 是**整条生成物全文**（实测一次 ~67 KB 进上下文）。给 `saveTo` 后回执只留摘要（<1 KB）；
         *   **不给时行为一字节不变**。四个 op 统一支持（在 `genOp` 外统一包一层）。 */
        saveTo: { type: 'string', description: '生成物**落盘**到这个绝对路径（原子写）⇒ 回执只回摘要、不回正文。不给则行为不变。' },
        assetId: { type: 'string', description: 'op=pixel-art：图源 —— `miliastra_asset` 的素材 id（或前缀）。与 `source` 二选一。' },
        source: { type: 'string', description: 'op=pixel-art：图源 —— 图片**绝对路径**（**不抓网图**）。' },
        cols: { type: 'number', description: 'op=pixel-art：网格列数（格）。只给一边就按比例推另一边。' },
        rows: { type: 'number', description: 'op=pixel-art：网格行数（格）。' },
        maxSide: { type: 'number', description: 'op=pixel-art：只给**长边**格数（另一边按比例推）；都不给默认 32。' },
        pixelSize: { type: 'number', description: 'op=pixel-art：一格占多少像素（默认 8，1~64）。' },
        centerOffsetX: { type: 'number', description: 'op=pixel-art：像素画中心相对容器中心的水平偏移（默认 0）。' },
        centerOffsetY: { type: 'number', description: 'op=pixel-art：同上，垂直方向。' },
        container: { type: 'number', description: 'op=pixel-art / op=vfx-lua：**交接值** —— **容器节点索引**。别编，问创作者要。' },
        imageId: { type: 'number', description: 'op=vfx-lua：粒子贴图（**真机任意平台素材号**，用 `miliastra_asset op=catalog` 挑；不传 = 预设默认）。' },
        previewImageId: { type: 'number', description: 'op=vfx-lua：**预览用号**（生成物里换成它，只为模拟器看得见：只画 `100001~100006`）。' },
        loop: { type: 'boolean', description: 'op=vfx-lua：播完是否循环（不传 = 预设默认）。' },
        duration: { type: 'number', description: 'op=vfx-lua：播多久（秒；不传 = 预设默认）。' },
        imageType: { type: 'string', enum: ['Stretch', 'Basic'], description: 'op=pixel-art：`Enum.ImageType`（默认 Stretch）。' },
        mergeRuns: { type: 'boolean', description: 'op=pixel-art：行内行程 + 跨行同色同宽合并（默认 true）。' },
        text: { type: 'string', description: 'op=text-gradient：文本（按 UTF-16 码元逐字符切）。' },
        colors: { type: 'array', items: { type: 'string' }, description: 'op=text-gradient：色标（≥1，有序）；hex 或 `rgb()/rgba()`。' },
        sizes: { type: 'array', items: { type: 'number' }, description: 'op=text-gradient：字号色标（默认 `[20,20]`）。' },
        colorStyle: { type: 'string', description: 'op=text-gradient：颜色风格 ' + STYLE_CHOICES.color.map((s) => '`' + s + '`').join('/') + '。' },
        sizeStyle: { type: 'string', description: 'op=text-gradient：字号风格 ' + STYLE_CHOICES.size.map((s) => '`' + s + '`').join('/') + '（jitter=跳字）。' },
        withColor: { type: 'boolean', description: 'op=text-gradient：是否包 `<color=…>`（默认 true）。' },
        withSize: { type: 'boolean', description: 'op=text-gradient：是否包 `<size=N>`（默认 false，**未验证**）。' },
        use4bit: { type: 'boolean', description: 'op=text-gradient / pixel-art：4bit 量化（默认 false，**未验证**）。' },
        colorJumpFrames: { type: 'number', description: 'op=text-gradient：颜色跳帧（默认 0）。' },
        fps: { type: 'number', description: 'op=text-gradient：每秒切几帧（默认 8，上限 60）。' },
        controlName: { type: 'string', description: 'op=text-gradient：**交接值** —— 要逐帧改字的文本框控件名。别编。' },
        templateIndex: { type: 'number', description: 'op=text-gradient / pixel-art / vfx-lua：**交接值** —— 控件模板索引（只有「存为模板」的能创建）。别编。' },
        frames: { type: 'array', items: { type: 'number' }, description: 'op=text-gradient（data）：要哪几帧；不给就出前 60 帧。' },
        structId: { type: 'string', description: 'op=struct-json：结构体 ID —— **必须 10 位数字**。别编。' },
        structName: { type: 'string', description: 'op=struct-json：结构体名。' },
        fields: { type: 'array', items: { type: 'object' }, description: 'op=struct-json：字段表 `{key, param_type, value?}`。' },
        variableName: { type: 'string', description: 'op=struct-json：给了就额外回「自定义变量」形态。' },
        spelling: { type: 'string', enum: ['struct_ype', 'struct_type'], description: 'op=struct-json：写出的拼写键（默认 `struct_ype`，都认）。' },
        allowLongText: { type: 'boolean', description: 'op=struct-json：放行 > 500 字符（默认 false = 报错）。' },
        summaryOnly: { type: 'boolean', description: '只去正文不去结论：去掉 `lua` / JSON 正文 / 逐条块数据。统计与 `nextStep` 都留。' },
        preset: { type: 'string', description: 'op=vfx-lua：预设 id（**17 粒子**（含 4 个组合预设：星光爆发/金币喷泉/雪中花瓣/孔雀终幕）+ **3 图元**：环刃/刀光/新月）；传 `"list"` 列全部（每条带二级分类）。` 列全部。' },
        path: { type: 'object', description: 'op=vfx-lua：贝塞尔"钢笔"三手柄 `{start?,p1,p2,target}`（后三个**相对发射点**）。给了就设 `motion="bezier"`。' },
        pathLayer: { type: 'number', description: 'op=vfx-lua：`path` 打到第几层（1 起，默认 1）。' },
        paths: { type: 'array', description: 'op=vfx-lua：**一次给多层** `[{layer,points:[{x,y}]}]`。粒子层**正好 4 点**（单段）；**图元层 4+3k**（多段）。给错 `ok:false` 说清原因。' },
        particlesPerEmitter: { type: 'number', description: 'op=vfx-lua：每层池子上限（要 ≥ rate×lifetime.max，见回执 `pool`）。' },
        sizeScale: { type: 'number', description: 'op=vfx-lua：粒子尺寸倍率（1 = 原生）。' },
        createAfterFrames: { type: 'number', description: 'op=vfx-lua：晚建帧数（默认 30；**别设 0**，会被全屏背景盖住）。' },
        diagSteadyAt: { type: 'number', description: 'op=vfx-lua：稳态诊断时刻（秒，默认 2）。' },
        parentName: { type: 'string', description: 'op=vfx-lua：一个**屏幕上看得见的控件名**（借它的容器当父节点）；不给就用 `script.object`。' },
        varPrefix: { type: 'string', description: 'op=vfx-lua：给生成物两个数据块改名（CONFIG/DATA ⇒ <varPrefix>_CONFIG/<varPrefix>_DATA），默认不改名。用途：同一脚本里放两套外观（主技能 + 副技能），否则全局名会撞。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      return applySaveTo(genOp(args), args.saveTo);
    },
  };
