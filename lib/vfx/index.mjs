// 移植自 xiaomoL444/ugc-tool（作者已授权，唯一要求保持开源）—— 源文件：
//   src/views/UIVfxEditor/particleModel.ts（预设数据）／particleLuaRuntime.ts（运行时）
//   ／particleLuaExporter.ts（导出形态）。
//   本文件是**编排层**：预设解析 → 数据层核算 → 交接值检查 → 组装 Lua → 回执。
//   分段逻辑分别在 `presets.mjs`（数据 + 纯函数）与 `lua.mjs`（Lua 组装 + 驱动层复用）。
// 许可：原仓库无 LICENSE 文件，此处使用经作者授权的移植；本文件随本插件以 GPL-3.0-only 发布。
//
// ★ 目标（作者 2026-09-30）：**AI 调一次接口 → 直接拿到可部署的特效 Lua**，
//   并且**四个预设都能在模拟器里真跑一遍**（`op=bind` → `op=frames` → `op=shot`）。
// ★ 交接值（模板索引 / 容器节点索引）**缺了就 ok:false + needsHandover[]**，文案照既有风格
//   「别自己编，问创作者要」；模板索引优先走 `miliastra_gen` 里现成的 `.gil` 自动读取
//   （只有唯一候选才采用）—— 编排在 `index.js`，本文件只负责"缺什么、报什么"。
import {
  BUDGET, IMAGE_MEANING, PRESET_NAMES, SIM_RENDERABLE_IMAGES, applyPathOverride, buildPreset, estimateOf,
  listPresets, poolOf, simulatedImage, travelOf, validateBuilt,
} from './presets.mjs';
import { buildFxLua, versionOf } from './lua.mjs';

/** 上游 `createPreset()` 的名字 → 本仓预设（给错时的"是不是想要这个"提示）。 */
const UPSTREAM_ALIAS = { stars: 'star-scatter', star: 'star-scatter', snow: 'snow-fall', coins: 'coin-collect' };

/** ★ 回执里**恒定带一行文档指针**（第 3 层：细节全在文档，不进 schema、不进回执正文）。 */
const DOC_POINTER = 'docs/千星奇域_粒子特效配置格式.md §5（预设列表）/ §5.0（发射器属性全表）/'
  + ' §5.4（贝塞尔钢笔怎么配）/ §6.5（模拟器能验什么·不能验什么）；插件侧 docs/功能详解.md §vfx';

/**
 * 第 2 层「按需枚举」用的一行摘要（`preset:"list"` ⇒ 12 条）。
 * ★ 只给"选得动"的量：中文名 / 一句话 / 层数 / 默认时长与贴图 / 关键参数 / 控件核算。
 *   完整字段（每个发射器的全部属性）在文档里；回执不堆。
 */
function presetBrief(p) {
  const built = buildPreset(p.name, {});
  const est = estimateOf(built);
  const key = (e) => (e.motion === 'bezier'
    ? { motion: 'bezier', start: e.origin, p1: e.control1, p2: e.control2, target: e.target, lifetime: e.lifetime }
    : {
      rate: e.rate, burst: e.burst, lifetime: e.lifetime, speed: e.speed, size: e.size,
      angle: e.angle, spread: e.spread, gravity: e.gravity, spin: e.spin,
    });
  const first = built.emitters[0];
  return {
    id: p.name,
    nameZh: p.label,
    oneLiner: p.summary,
    upstream: p.upstream,
    emitters: built.emitters.length,
    defaultDuration: built.duration,
    defaultLoop: built.loop,
    imageId: built.imageId,
    imageMeaning: IMAGE_MEANING[built.imageId] || null,
    /// ★ 贴图号**必须由创作者给**（`chest-collect`：目录里没名称字段 ⇒ 不猜）
    needsImageId: built.imageIdFromCreator === true,
    keyParams: key(first),
    budget: {
      controls: est.controls,
      poolPerEmitter: built.particlesPerEmitter,
      needPerEmitter: est.layers.map((l) => l.pool.concurrent),
      note: '控件数 = 层数 × 每层池；平台预算每层 ' + BUDGET.perEmitter + ' / 总计 ' + BUDGET.total,
    },
  };
}

/** 交接值缺失时的标准话术（与 text-gradient / pixel-art 同一条纪律）。 */
const NO_TEMPLATE = {
  param: 'templateIndex',
  what: '**图片控件**的控件模板索引（界面控件组管理 → 界面控件组库 → 客户端控件模板 →「添加客户端控件」→ 存为模板；'
    + '画布上摆的实例恒返回 nil）。别自己编，问创作者要。',
};
const NO_PARENT = {
  param: 'parentName',
  what: '一个**屏幕上看得见的控件名**（用来借它所在的容器当父节点 —— 见格式文档 §2.2 的层级铁律）。'
    + '给了它，产物里才会有 `PARENT_BY_NAME`；不给就用 `script.object` 兜底。',
};
/**
 * ★★ `container` **不是可选的**（2026-09-30 **真机实测**，本轮最重要的一条）。
 *
 * 事实（真机原文，`特效 fx` 那一局）：
 * ```
 * 缺少交接值 CONFIG.CONTAINER_INDEX：粒子父容器的控件节点索引，必须由创作者交接（脚本不会猜、不会写假索引）
 * stack traceback:
 *     特效 fx:428: in function 'requireHandover'
 *     特效 fx:1611: in function 'OnStart'
 * ```
 * 而**只给 `templateIndex`、漏 `container`** 时的表现极具欺骗性：
 * 生成成功 → `deploy` 通过 → `lint` 通过 → `miliastra_sim` 也跑得通（模拟器不跑 requireHandover 这一句），
 * **只有真机在 `OnStart` 里 `error`，整屏没有粒子**。
 * ⇒ 所以它必须与 `templateIndex` **同等对待**（`ok:false` + `needsHandover`）。
 */
const NO_CONTAINER = {
  param: 'container',
  code: 'FX_CONTAINER_MISSING',
  what: '粒子**父容器**的控件节点索引 —— **缺它会在真机 `OnStart` 报错（`缺少交接值 CONFIG.CONTAINER_INDEX`）、整屏没有粒子**。'
    + '模拟器与 lint 都不会替你发现这一点（它们不跑那句 `requireHandover`）。由创作者交接，或让本工具从当前关卡 `.gil` 自动读（只有唯一候选才采用）。',
};

/**
 * ★★ `preflight`：**投递前的可判定自检清单**（2026-09-30，真机实战那一轮加的）。
 *
 * 为什么要有它：这条链上有 5 个环节（生成 → lint → deploy → 模拟器 → 真机），
 * **前三环全绿也可能在真机整屏没有粒子**（本轮实测：漏 `container` 就是这样）。
 * 所以把"能在投递前判定的东西"集中成一张表，**逐项给 `ok` 与一句"真机上会怎样"**：
 *   · `ok:true`   —— 判据满足（注意：**满足 ≠ 真机没问题**，真机渲染/帧率/层级仍要试玩）；
 *   · `ok:false`  —— **确定不合格**，`why` 里直说真机的后果；
 *   · `ok:null`   —— **判不了**（例如读不到本关 `.gil`）⇒ 如实标 unknown，**绝不猜**。
 *
 * @returns {Array<{item: string, ok: boolean|null, why: string}>}
 */
export function preflightOf({ templateIndex = null, container = null, parentName = null, base = null, sim = null, est = null, candidates = null } = {}) {
  const out = [];
  out.push({
    item: 'templateIndex（图片控件模板索引）有',
    ok: templateIndex !== null,
    why: templateIndex !== null
      ? '= ' + templateIndex + '（来自创作者交接或本关 `.gil` 的唯一候选）'
      : '缺 ⇒ 真机 `OnStart` 会 `error` 点名「缺少交接值 CONFIG.TEMPLATE_INDEX」⇒ **整屏没有粒子**；'
        + '`deploy`/`lint`/`miliastra_sim` 三环都不会替你发现它',
  });
  out.push({
    item: 'container（粒子父容器的控件节点索引）有',
    ok: container !== null,
    why: container !== null
      ? '= ' + container
      : '缺 ⇒ 真机 `OnStart` 会 `error` 点名「缺少交接值 CONFIG.CONTAINER_INDEX」⇒ **整屏没有粒子**'
        + '（真机原文：`特效 fx:428: in function \'requireHandover\'`）；前三环全绿也拦不住它',
  });
  out.push(parentNamePreflight(parentName, candidates));
  out.push({
    item: 'imageId 是合法正整数',
    ok: base && Number.isInteger(base.imageId) && base.imageId > 0,
    why: base && Number.isInteger(base.imageId) && base.imageId > 0
      ? '= ' + base.imageId + (IMAGE_MEANING[base.imageId] ? '（几何号 ' + IMAGE_MEANING[base.imageId] + '）' : '（平台素材号）')
      : '不是合法正整数 ⇒ 真机上贴图取不到（具体渲染成什么只有真机能看到）',
  });
  out.push({
    item: 'imageId 能在这台模拟器里预览（100001~100006）',
    ok: !!(sim && sim.renderable),
    why: sim && sim.renderable
      ? '是几何号 ⇒ 模拟器画得出（`op=bind` + `op=frames` 的帧间差才有意义）'
      : '**真机正常**（可用 `op=catalog` 全部 1543 个素材号）—— 只是**模拟器**会画成"缺图"标记；'
        + '想在游戏外看一眼就再传 `previewImageId`（如 100002）',
  });
  const bad = est ? est.layers.filter((l) => !l.pool.enough) : [];
  out.push({
    item: '每层池 ≥ rate × lifetime.max',
    ok: est ? bad.length === 0 : null,
    why: est && bad.length === 0
      ? '每层都够（' + est.layers.map((l) => l.id + ' ' + l.maxParticles + '≥' + l.pool.concurrent).join('；') + '）'
      : bad.map((l) => l.id + '：池 ' + l.maxParticles + ' < 需要 ' + l.pool.concurrent).join('；')
        + ' ⇒ 真机上粒子会抢槽位、**画面缺粒**（池子按 `序号 % maxParticles` 复用）',
  });
  out.push({
    item: '合计控件 ≤ ' + BUDGET.total + '（平台总预算）',
    ok: est ? est.controls <= BUDGET.total : null,
    why: est && est.controls <= BUDGET.total
      ? '合计 ' + est.controls + ' 个（占 ' + Number((est.controls / BUDGET.total * 100).toFixed(1)) + '%）'
      : '合计 ' + (est ? est.controls : '?') + ' > ' + BUDGET.total + ' ⇒ 超出平台总预算（每层 ≤ ' + BUDGET.perEmitter
        + '、合计 ≤ ' + BUDGET.total + ' 是上游自述预算，无帧率证据）',
  });
  return out;
}

/**
 * `parentName` 那条自检：**能查就查，查不到标 unknown（绝不猜）**。
 * 数据来源是 `.gil` 的「容器节点下**有名字**的子控件」（`candidates.namedChildrenOfContainer`）——
 * 它是**候选**不是判据（记录里没有控件类型），所以查不到时只说"会退回 `script.object`"，不说"你写错了"。
 */
function parentNamePreflight(parentName, candidates) {
  if (parentName === null) {
    return {
      item: 'parentName（可省）',
      ok: null,
      why: '这次没传 ⇒ 产物里 `PARENT_BY_NAME = nil`，运行时直接用 `script.object`（不借别人的容器）—— '
        + '想让它落在你的 HUD 容器里，就传一个**屏幕上看得见的控件名**（见格式文档 §2.2 层级铁律）。',
    };
  }
  const rows = candidates && Array.isArray(candidates.namedChildrenOfContainer) ? candidates.namedChildrenOfContainer : null;
  if (!rows) {
    return {
      item: 'parentName 「' + parentName + '」能在本关 `.gil` 里查到',
      ok: null,
      why: '**判不了**（读不到本关 `.gil`，或这次没走自动读）⇒ 如实标 unknown，**不猜**；'
        + '想确认就自己跑 `miliastra_map op=clientui` 看有没有这个名字，或让创作者确认。',
    };
  }
  const hit = rows.some((r) => String(r.name) === String(parentName));
  return {
    item: 'parentName 「' + parentName + '」能在本关 `.gil` 里查到',
    ok: hit,
    why: hit
      ? '在 `.gil` 的「容器节点下有名子控件」里查到了（注意：它是**候选清单**，记录里没有控件类型）'
      : '在 `.gil` 里**没查到**这个名字 ⇒ 真机运行时会退回 `script.object`（产物自己会兜底，不是致命错误），'
        + '但**层级可能不是你想要的那层**。.gil 里现有的名字：'
        + rows.map((r) => r.name).slice(0, 8).join(' / ') + (rows.length > 8 ? ' …' : ''),
  };
}

/**
 * `output=data` 时的结构化数据（**不含 Lua**）：两层发射器全文 + 落程/池子核算 + 属性表要点。
 * ⚠️ 这一层**不需要交接值**（不建控件、不写文件）⇒ 不走 `preflight`，也不拦"缺 container"。
 * @param {any} built
 */
function dataOf(built) {
  const est = estimateOf(built);
  return {
    schema: 'UGCTools.UIParticles@1',
    preset: { name: built.name, label: built.label, upstream: built.upstream, summary: built.summary },
    imageId: built.imageId,
    imageMeaning: IMAGE_MEANING[built.imageId] || null,
    duration: built.duration,
    loop: built.loop,
    particlesPerEmitter: built.particlesPerEmitter,
    sizeScale: built.sizeScale,
    canvas: built.canvas,
    budget: BUDGET,
    controls: est.controls,
    emitters: built.emitters,
    estimate: est,
    notes: [
      '坐标原点 = **父容器中心**、y **向上**为正；画布 1600×1000 ⇒ x ∈ [−800,+800]、y ∈ [−500,+500]',
      '落程 ≈ speed_avg×lifetime_avg + ½|gravity.y|×lifetime_avg²（贝塞尔则给折线长）',
      '需要池 ≥ rate×lifetime.max（单层算法）；平台预算是**两层合计 ≤ ' + BUDGET.total + '**、每层 ≤ ' + BUDGET.perEmitter,
      '这一层是**纯数据**（不写文件、不建控件）；要跑起来还得 `output:"lua"` 生成脚本再部署',
    ],
  };
}

/**
 * `op=vfx-lua` 的实现：**一次调用 → 可直接部署的粒子特效 Lua**（或结构化数据）。
 *
 * @param {Record<string, any>} args 工具入参
 * @param {{templateIndex?: number|null, container?: number|null, from?: string|null, candidates?: any}} [handover]
 * @returns {Record<string, any>}
 */
export function vfxLua(args = {}, handover = {}) {
  const output = String(args.output || 'lua');
  if (output !== 'lua' && output !== 'data') {
    throw new Error('output 只能是 lua / data，收到：' + JSON.stringify(args.output));
  }
  const summaryOnly = args.summaryOnly === true;
  const wanted = String(args.preset === undefined || args.preset === null ? '' : args.preset).trim();

  /*
   * ★★ 渐进式披露（作者 2026-09-30 明令）——
   *   第 1 层：schema 里只有"怎么找到预设"（`preset:"list"`）；
   *   第 2 层：本函数**按需**把清单/参数给回执；
   *   第 3 层：完整属性表与换算全在 `docs/千星奇域_粒子特效配置格式.md`（回执恒带 `doc` 指针）。
   */
  if (wanted === 'list' || wanted === '') {
    /** @type {Record<string, any>} */
    const out = {
      ok: true, op: 'vfx-lua', listMode: true,
      count: listPresets().length,
      presets: listPresets().map(presetBrief),
      doc: DOC_POINTER,
      nextStep: '挑一个 `id` 填回 `preset` 再调一次（默认出可部署 Lua；`output:"data"` 只要数据）。'
        + (wanted === '' ? '（这次没传 `preset` —— 之前会默认用 `star-rain`；现在改成先给你清单，别猜。）' : ''),
      needsPreset: wanted === '',
    };
    if (summaryOnly) {
      // 只留 id / 中文名（**去体积不去结论**：count 与 nextStep 都在）
      out.presets = out.presets.map((p) => ({ id: p.id, nameZh: p.nameZh }));
      out.presetsOmitted = true;
    }    return out;
  }

  const base = buildPreset(wanted, args);
  if (!base) {
    const alias = UPSTREAM_ALIAS[wanted];
    return {
      ok: false,
      op: 'vfx-lua',
      error: '没有这个预设：' + JSON.stringify(wanted) + '。合法值：' + PRESET_NAMES.join(' / ')
        + (alias ? '（上游同名预设 `' + wanted + '` 在本仓叫 `' + alias + '`）' : '')
        + '。要看每个预设的中文名与一句话语义，传 `preset:"list"`；完整参数表见文档。',
      presets: listPresets().map((p) => ({ id: p.name, nameZh: p.label, oneLiner: p.summary })),
      doc: DOC_POINTER,
    };
  }

  /*
   * `path`（贝塞尔"钢笔"三个手柄）：**只对贝塞尔预设天然有意义**。
   * 给了 path 就打在该层的发射器上并把 motion 设成 bezier —— 对 velocity 预设（star-scatter /
   * snow-fall / star-rain）这是**合法但刻意**的用法，所以只 warning（改了运动模型），不拦。
   */
  const pathWarnings = [];
  let pathReceipt = null;
  if (args.path !== undefined && args.path !== null) {
    const layerIndex = Number.isFinite(Number(args.pathLayer)) ? Math.max(0, Math.round(Number(args.pathLayer)) - 1) : 0;
    try {
      pathReceipt = applyPathOverride(base, args.path, layerIndex);
    } catch (e) {
      // 参数错了就**明确报错**（不猜、不静默回落成预设值）—— 与 pixel-art 的 `requireNumber` 同一口径
      return {
        ok: false, op: 'vfx-lua',
        error: (e && e.message) || String(e),
        pathExpected: 'path = { start?:{x,y}, p1:{x,y}, p2:{x,y}, target:{x,y} }（每个点都可单独给，没给的沿用预设值）',
        presets: listPresets(),
      };
    }
    if (base.upstream !== 'coins') {
      pathWarnings.push('`path` 把第 ' + pathReceipt.layer + ' 层「' + pathReceipt.layerName
        + '」的运动模型从 `velocity` 改成了 `bezier`（这个预设本来是速度+重力）—— 起点/终点用的是给定的坐标，'
        + '重力对贝塞尔无效；要"像金币那样汇聚"建议直接用 `preset:"coin-collect"`。');
    }
    if (base.emitters.some((e) => e.motion === 'bezier' && e.lifetime.max < 0.5)) {
      pathWarnings.push('贝塞尔路径很短（lifetime.max < 0.5 秒）—— 粒子几乎瞬间到位，看不出路径。');
    }
  }

  const problems = validateBuilt(base);
  const est = estimateOf(base);
  const sim = simulatedImage(base);
  const version = versionOf(base);

  /*
   * ★ **图是独立维度**（作者 2026-09-30）：预设 = 运动与节奏，图片 = 身份与气质。
   *   两个号分工明确：`imageId` 是**真机发布用**（任意平台素材号），`previewImageId` 只把生成物里的
   *   `IMAGE_ID` 换成几何号，**为了在模拟器里看得见图**。两个都回显，谁都别猜。
   */
  const imageWarnings = [];
  if (base.imageId === null) {
    return {
      ok: false, op: 'vfx-lua',
      error: '预设 `' + base.name + '`（' + base.label + '）的贴图号**必须由创作者给** —— 请显式传 `imageId`'
        + '（如 `{"op":"vfx-lua","preset":"' + base.name + '","imageId":<宝箱图号>}`）。'
        + '我们的素材目录（`miliastra_asset op=catalog`）里**单张图没有名称字段**，所以"哪个号是宝箱"没有依据可推，**不猜**。',
      needsImageId: true,
      preset: { name: base.name, label: base.label, summary: base.summary },
      doc: DOC_POINTER,
    };
  }
  if (base.previewImageId !== null && base.previewImageId !== base.imageId) {
    imageWarnings.push('**两层贴图号**：生成物里写的是 `previewImageId=' + base.previewImageId
      + '`（**只为在模拟器里看得见图** —— 模拟器只画 100001~100006 六个几何号，其它号画成"缺图"）；'
      + '真机要用的是 `imageId=' + base.imageId + '` ⇒ **发布前把它换回真机号**'
      + '（生成物里就一处：`CONFIG.IMAGE_ID`）。');
  } else if (!sim.renderable) {
    imageWarnings.push('贴图号 ' + sim.imageIds.join(' / ') + ' 不是几何号 ⇒ **模拟器里会画成"缺图"标记**'
      + '（模拟器只画 100001~100006 六个几何号；**真机可用平台全部 1543 个素材号**，见 `miliastra_asset op=catalog`）。'
      + '想在模拟器预览就传 `previewImageId`（如 100002）。');
  }

  const warnings = [];
  for (const e of est.layers) {
    if (!e.pool.enough) {
      warnings.push(e.id + '：池子不够 —— 需要 ≥ ' + e.pool.concurrent + '（rate ' + e.rate
        + ' × lifetime.max ' + e.lifetimeMax + '），本层给 ' + e.maxParticles
        + ' ⇒ 粒子会抢槽位、画面缺粒（格式文档 §7.2）。');
    }
    if (!e.spawnInside) {
      warnings.push(e.id + '：出生区域有一部分在画布外（容器是 1600×1000 的全屏容器，超出部分会被裁）。');
    }
  }
  if (est.controls > BUDGET.total) {
    warnings.push('两层合计 ' + est.controls + ' 个控件 > 平台总预算 ' + BUDGET.total + '（上游自述，无帧率证据）。');
  }
  /*
   * 「落不到底」只在**确实想让它落到底**时才提：判据是"大多数层的速度朝下（sin(angle) < 0）
   * **且**落程已经走过半屏"。这样：
   *   · star-rain（1190px ≥ 1000）不提（它本来就落得到）；snow-fall 落程 ≈490px < 半屏 ⇒ 不提
   *     —— 它是"飘"不是"落"，3.5~5 秒时在屏中部淡出，**这是对的**；
   *   · 上升类（ember-rise / bubble-up）与中心爆发类（star-scatter / confetti-pop / hit-spark）方向朝上 ⇒ 不提。
   * `travelOf()` 用的全是平均值 ⇒ 这一条是**估算**，不是判决。
   */
  const falling = base.emitters.filter((e) => e.motion === 'velocity' && Math.sin((e.angle * Math.PI) / 180) < -0.3);
  const longestFall = falling.length ? Math.max(...est.layers.filter((l) => base.emitters.some((e) => e.id === l.id && e.motion === 'velocity' && Math.sin((e.angle * Math.PI) / 180) < -0.3)).map((l) => l.travel)) : 0;
  if (!est.reachesBottom
    && falling.length >= Math.ceil(base.emitters.length / 2)
    && longestFall >= base.canvas.height / 2) {
    warnings.push('下落层差一点到屏幕底边（最长的落程 ' + Number(longestFall.toFixed(1)) + 'px / 屏高 '
      + base.canvas.height + 'px，用平均值估的）—— 想"落到底再淡出"就把 speed 或 lifetime 调大一点。');
  }
  warnings.push(...imageWarnings);
  warnings.push(...pathWarnings);
  warnings.push(...problems.map((p) => '数据层自检：' + p));

  const unverified = [
    '**真机渲染**：模拟器是离线渲染（自己的 2D 引擎），混合模式 / 旋转方向 / 容器裁剪都不覆盖。',
    '**官方素材**：贴图资源号在真机上渲染成什么，只有真机能看到；本工具只保证它是合法正整数。'
      + '（**"6 个号"是模拟器的渲染限制，不是平台限制** —— 真机可用 `miliastra_asset op=catalog` 里全部 1543 个素材号。）',
    '**帧率**：每层 512 / 总计 1024 是上游 README 自述的**工具预算**，没有任何设备的帧率证据。',
    '**回调触发**：`EnableUpdate` 之后的 `OnUpdate` 在真机上的实际节奏（本仓离线契约是「EnableUpdate 前无 OnUpdate」）。',
  ];
  if (args.loop === true || base.loop === true) {
    unverified.push('**循环**：`loop:true` 的预设（star-scatter / snow-fall / coin-collect / peacock-* 等）在真机上"播完不停"的观感未验证。');
  }
  if (base.name === 'chest-collect') {
    unverified.push('**宝箱图号**：`chest-collect` 的贴图号由创作者指定（目录无名称字段）—— 本工具**不猜**，必须显式传 `imageId`。');
  }

  const shared = {
    op: 'vfx-lua',
    /// 第 3 层指针：**每次调用都带**（省得 AI 去猜"细节在哪"）
    doc: DOC_POINTER,
    preset: {
      name: base.name, label: base.label, upstream: base.upstream, summary: base.summary,
      presetCount: PRESET_NAMES.length,
      allIds: PRESET_NAMES,
      listHint: '要看全部预设的中文名 / 一句话 / 关键参数 / 控件核算，传 `preset:"list"`（第 2 层：按需枚举，不占 schema）。',
    },
    emitters: base.emitters.map((e) => ({
      id: e.id, name: e.name, imageId: e.imageId, motion: e.motion, shape: e.shape,
      rate: e.rate, burst: e.burst, delay: e.delay,
      lifetime: e.lifetime, speed: e.speed, maxParticles: e.maxParticles,
    })),
    emitterCount: base.emitters.length,
    /*
     * ★ 贝塞尔"钢笔"的**最终生效点**（作者要照着网页编辑器对齐时看这几个数）：
     *   · `path:null` = 这次没传 `path`（用的是预设自带那组点，四个点仍然回显在上面）。
     *   · 点全部是**相对发射点**的偏移；`*OnCanvas` 那两个才是"容器中心坐标"下的绝对值。
     */
    path: pathReceipt ? pathReceipt : (() => {
      const e = base.emitters[0];
      if (e.motion !== 'bezier') return null;
      return {
        layer: 1, layerId: e.id, layerName: e.name, motion: e.motion, from: 'preset',
        start: { x: e.origin.x, y: e.origin.y, from: 'preset' },
        p1: { x: e.control1.x, y: e.control1.y, from: 'preset' },
        p2: { x: e.control2.x, y: e.control2.y, from: 'preset' },
        target: { x: e.target.x, y: e.target.y, from: 'preset' },
        startOnCanvas: { x: e.origin.x, y: e.origin.y },
        targetOnCanvas: { x: e.origin.x + e.target.x, y: e.origin.y + e.target.y },
      };
    })(),
    pool: {
      perEmitter: base.particlesPerEmitter,
      controls: est.controls,
      budgetPerEmitter: BUDGET.perEmitter,
      budgetTotal: BUDGET.total,
      layers: est.layers.map((e) => ({
        id: e.id, rate: e.rate, lifetimeMax: e.lifetimeMax,
        need: e.pool.concurrent, configured: e.maxParticles, enough: e.pool.enough, headroom: e.pool.headroom,
      })),
    },
    estimate: {
      canvas: base.canvas,
      screenHeight: base.canvas.height,
      reachesBottom: est.reachesBottom,
      controls: est.controls,
      budgetRatio: Number((est.controls / BUDGET.total).toFixed(4)),
      layers: est.layers.map((e) => ({
        id: e.id, travel: e.travel, reachesBottom: e.reachesBottom,
        bezierLength: e.bezierLength, spawnInside: e.spawnInside,
      })),
    },
    image: {
      /// 真机发布用号（任意平台素材号；用 `miliastra_asset op=catalog` 挑）
      id: base.imageId,
      meaning: IMAGE_MEANING[base.imageId] || null,
      /// 预览用号：`null` = 没分离（生成物里就是 `id`）
      previewImageId: base.previewImageId,
      /// 生成物里**实际写进去**的那个号（有 previewImageId 时是它）
      emittedImageId: base.emittedImageId,
      simRenderable: sim.renderable,
      layered: base.previewImageId !== null && base.previewImageId !== base.imageId,
      note: '**两层分别是什么**：`id` = 真机发布用（平台全部素材号都行）；`previewImageId` 只为模拟器预览'
        + '（模拟器只画 100001~100006 六个几何号）；`emittedImageId` 是生成物里真写进去的那个。',
    },
    duration: base.duration,
    loop: base.loop,
    sizeScale: base.sizeScale,
    version,
    warnings,
    unverified,
    summaryOnly,
  };

  if (output === 'data') {
    const out = Object.assign(shared, dataOf(base), { ok: true });
    /*
     * ★ 8 层预设（peacock-*）的 `emitters` 全文会超 10KB ⇒ `summaryOnly` **必须真的省体积**
     *   （只去正文、不去结论：层数、核算、警告、`nextStep` 一个不删）。
     */
    if (summaryOnly) {
      out.emittersOmitted = true;
      out.emitterCount = base.emitters.length;
      out.emitters = base.emitters.map((e) => ({ id: e.id, name: e.name, motion: e.motion, origin: e.origin, target: e.motion === 'bezier' ? e.target : null }));
    }
    return out;
  }

  /*
   * 交接值三条路（优先级从高到低）：编排层解析出来的 `handover` → 调用方**直接写在 args 里** → 没有。
   * ⚠️ 第二条不是多余的：`vfxLua(args)` 也**单独可用**（测试与文档直接调它），那时没有编排层。
   */
  const pickPositive = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };
  const templateIndex = pickPositive(handover.templateIndex, args.templateIndex);
  const container = pickPositive(handover.container, args.container);
  const parentName = args.parentName === undefined || args.parentName === null || String(args.parentName).trim() === ''
    ? null : String(args.parentName).trim();

  const needsHandover = [];
  if (templateIndex === null) needsHandover.push(NO_TEMPLATE);
  if (container === null) needsHandover.push(NO_CONTAINER);
  if (parentName === null) needsHandover.push(Object.assign({ optional: true }, NO_PARENT));
  /*
   * ★★ `preflight`：投递前的可判定自检清单（含 `ok:false` 的两项交接值）。
   *   **失败回执也要带它** —— 那正是"还差哪几项"最该看清单的时刻。
   */
  const preflight = preflightOf({
    templateIndex, container, parentName, base, sim, est,
    candidates: handover.candidates || null,
  });
  /*
   * ★★ 硬拦（2026-09-30 真机实战）：**缺 `container` 与缺 `templateIndex` 同等对待**。
   *   为什么不能"先让它生成、事后警告"：漏 `container` 时 **生成/deploy/lint/模拟器四环全绿**，
   *   只有真机在 `OnStart` 里 error、**整屏没有粒子** —— 那种"四绿一红"最难排查，
   *   所以必须在**投递前**就拦住（`ok:false`），而不是留一条事后警告。
   */
  if (templateIndex === null || container === null) {
    const missing = [];
    if (templateIndex === null) missing.push('图片控件模板索引（`templateIndex`）');
    if (container === null) missing.push('粒子父容器的控件节点索引（`container`）');
    return Object.assign(shared, {
      ok: false,
      error: '生成 Lua 需要**必须由创作者交接**的值：' + missing.join('、')
        + '。这些值请让创作者给，或让本工具从当前关卡的 `.gil` 自动读（**只有唯一候选才采用**）—— 别自己编索引。'
        + (container === null
          ? ' ⚠️ 特别提醒：**漏 `container` 时 `deploy` / `lint` / `miliastra_sim` 都不会报错**，'
            + '只有真机会在 `OnStart` 报「缺少交接值 CONFIG.CONTAINER_INDEX」⇒ **整屏没有粒子**（本轮真机实测）。'
          : ''),
      code: 'FX_HANDOVER_MISSING',
      needsHandover,
      missingParams: missing.map((m) => (m.includes('container') ? 'container' : 'templateIndex')),
      preflight,
      // ★ 稳定 `code` 的**强警告**（供测试与 AI 机读；`warnings[]` 里既有字符串也有对象，按 typeof 分开读）
      warnings: (container === null
        ? warnings.concat([{ code: 'FX_CONTAINER_MISSING', level: 'error', param: 'container', message: NO_CONTAINER.what }])
        : warnings),
      handoverFrom: handover.from || null,
      handoverCandidates: handover.candidates || [],
    });
  }

  const built = buildFxLua({
    built: base, templateIndex, container, parentName, version,
    createAfterFrames: args.createAfterFrames, diagSteadyAt: args.diagSteadyAt,
  });

  const out = Object.assign(shared, {
    ok: true,
    target: { templateIndex, container, parentName },
    /// ★ 投递前的可判定自检清单（7 项；`ok:null` = 判不了，如实标 unknown）
    preflight,
    lua: built.lua,
    luaBytes: built.bytes,
    lines: built.lines,
    driver: {
      from: built.fixture,
      fixtureLines: built.driverLines,
      note: '驱动层（Runtime 块 + 宿主绑定块）**逐字取自真机定稿件**，生成器只参数化了 VERSION / 预设名 / CONFIG+DATA。',
    },
    dataLayerLines: built.dataLines,
    needsHandover: parentName === null ? needsHandover : [],
    handoverFrom: handover.from || null,
    handoverCandidates: handover.candidates || [],
    nextStep: '用 `miliastra_code op=deploy` 投到活文件（**必须显式传 `level`（地图关卡 ID）与 `file`（活文件名）**，'
      + '并核对回执 `dest` 里的关卡号），然后在编辑器里**存一次盘**再试玩 —— deploy 只写磁盘，'
      + '游戏跑的是 `.gil` 里存盘那一刻的快照。想先在游戏外看一眼：'
      + '`miliastra_sim op=bind`（scripts 用 `sourceFrom` 给本 Lua 的绝对路径 + `templates:[{guid,kind:"image"}]` + `containerId`）'
      + '→ `op=frames`（帧间像素差）→ `op=shot target=play`。'
      + (pathReceipt
        ? ' ★ 路径：想改"钢笔曲线"只改 `path.p1/p2/target`（**相对发射点**的偏移）与 `path.start`（发射点，可省）——'
          + '这三个点是**结果**，回执的 `path` 里已经回显最终生效值（含画布绝对坐标），照着在网页编辑器里对齐即可。'
        : ''),
  });
  if (summaryOnly) {
    delete out.lua;
    out.luaOmitted = true;
    out.luaBytesOmitted = out.luaBytes;
  }
  return out;
}

/** 供测试/文档直接用的再导出（纯函数层）。 */
export { listPresets, buildPreset, estimateOf, poolOf, travelOf, simulatedImage, validateBuilt, BUDGET, PRESET_NAMES };

/**
 * ★ **刻意保留但当前无人调用**的两个纯函数（**不删的理由写在这**，将来做 GUI/数据导出时会用）：
 *   · `presetToData(built)`（`presets.mjs`）：把预设直接变成 `UGCTools.UIParticles@1` 的 `DATA` 表
 *     —— 现在 `output=lua` 走的是 `lua.mjs` 内联生成、`output=data` 走 `dataOf()`，两条路都不经过它；
 *     它是"只想要数据表、不想生成 Lua"的第三条路（例如将来做编辑器导入 JSON）。
 *   · `driverOf(file)` / `findFxFixture()`（`lua.mjs`）：分开的驱动层读取接口，`buildFxLua` 内部用了它们，
 *     测试也用 `findFxFixture` 断言"定稿件找得到"。
 *   两者都**有测试覆盖**（`tests/vfx-test.mjs`）⇒ 不是死代码，只是**暂时没有生产调用方**。
 */
export { presetToData } from './presets.mjs';
