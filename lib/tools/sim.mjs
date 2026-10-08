/**
 * `miliastra_sim` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import fsMod from 'node:fs';
import pathMod from 'node:path';
import { ReceiptCode } from '../receipt.mjs';
import { applyBootPatch, simOp } from '../sim.mjs';

export function patchSimBindBoot(args) {
  const boot = args.boot || {};
  const touch = (spec) => {
    const src = typeof spec.source === 'string' ? spec.source : null;
    const from = String(spec.sourceFrom || spec.from || '').trim();
    let text = src;
    let file = String(spec.path || spec.file || '') || null;
    if (text === null || text === '') {
      if (!from) throw new Error('`boot` 要能拿到源码：每份脚本给 `source`（内联）或 `sourceFrom`（绝对路径）。');
      const abs = pathMod.resolve(from);
      text = fsMod.readFileSync(abs, 'utf8');
      file = abs;
    }
    const r = applyBootPatch(text, boot);
    return {
      spec: { ...spec, source: r.source, ...(spec.sourceFrom ? { sourceFrom: undefined } : {}) },
      info: {
        path: file, bytesBefore: Buffer.byteLength(text, 'utf8'), bytesAfter: Buffer.byteLength(r.source, 'utf8'),
        patched: r.patched, notes: r.notes, unsupported: r.unsupported,
      },
    };
  };
  const out = { ...args };
  const probe = { patched: [], notes: [], unsupported: [], files: [] };
  if (Array.isArray(args.scripts) && args.scripts.length) {
    out.scripts = args.scripts.map((s) => {
      const t = touch(s || {});
      probe.files.push(t.info);
      probe.patched.push(...t.info.patched.map((x) => ({ ...x, path: t.info.path })));
      probe.notes.push(...t.info.notes);
      probe.unsupported.push(...t.info.unsupported);
      return t.spec;
    });
  } else if (typeof args.source === 'string' || args.sourceFrom) {
    const t = touch({ path: args.file, source: args.source, sourceFrom: args.sourceFrom });
    out.source = t.spec.source;
    out.sourceFrom = undefined;
    probe.files.push(t.info);
    probe.patched.push(...t.info.patched.map((x) => ({ ...x, path: t.info.path })));
    probe.notes.push(...t.info.notes);
    probe.unsupported.push(...t.info.unsupported);
  } else {
    throw new Error('`boot` 要配合 `source` / `sourceFrom` / `scripts[]` 用（没拿到任何源码）。');
  }
  return { args: out, probe: { ...probe, patchedCount: probe.patched.length, nextStep: probe.unsupported.length
    ? '⚠️ `complete` 那项**没有做**（见 `unsupported`）—— 需要玩法自己的数据形状，本插件不猜。'
    : '探针副本已改好（**真源未动**）⇒ 直接看 `run.logs`。' } };
}

export const SIM_TOOL = {
    name: 'miliastra_sim',
    description:
      '内置**千星模拟器**：游戏之外搭界面、跑 levelScript、出画面 PNG。**定位：真机试玩之前的「预测试」**；拦不下官方素材/真机渲染 ⇒ **模拟器通过 ≠ 真机通过**，真机仍要点试玩。\n★ 三档（①看 `state`/`shot` ②玩 `play` ③判 `verify`/`cases`/`frames`）共用一份工程；`op=bind` 搬真机工程（缺值报错，不许编）/ `op=handover` 抽交接值 / `op=cases` 验收单。\n★ 量级：发输入 **5ms** / 读场景 **200ms**；HUD 用 **`op=hud`** 读 `textbox.text` 的 `text`；`…Down` 配 `…Up`，否则**一直按住**；`frame` **不是秒表**，计时用 `time`。\n★ `op=keys` 两路扫键名（含**裸字符串** + `string-literal` 来源），回执带 **`press`**；`all:true` 全量 **164** 个。\n★ 渲染：**PNG 里有脚本建的客户端控件**（含子控件**都会画进图**；模板工程**自己那棵树**不在），仍离线渲染 ⇒ 终验看真机；**Z 序**：**按 sibling 顺序画**，`op=patch add` 的新控件在**最底层**（真机**后建的在上**），不覆盖跨父级叠序。\n★ 能验/不能验什么见 `docs/模拟器与视图.md`。\n\n**典型调用**：`{"op":"bind","source":"D:\\\\…\\\\a.lua","templates":[{"guid":1073741868,"kind":"image"}]}`',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['controls', 'hud', 'state', 'patch', 'handover', 'bind', 'play', 'verify', 'cases', 'frames', 'shot', 'keys', 'export', 'import', 'load', 'save', 'reset'], description: '默认 state。' },
        receipt: { type: 'string', enum: ['full', 'min'], description: '默认 full。`min` = **精简骨架档**（换一小撮决策必需字段）；与 `summaryOnly` 不重叠：那个是「去掉体积、保留原字段」，这个是「换骨架」。' },
        boot: { type: 'object', description: 'op=bind：**探针改写**（只改内存副本、真源不动）。`{cur:数字}` 改 `local cur = N`；`mode:"build"` 注释掉 `registerCursor(` 并把启动入口换成 `buildLevel()`；`complete:true` **本插件不猜玩法数据形状**，会如实回 `unsupported`。改了什么见回执 `probe.patched`。' },
        /*
         * ⚠️ 这个 `all` **同时服务两个 op** —— 写成两个键会**静默覆盖**（JS 对象字面量后者胜），
         * 于是其中一个说明永远不会到达 AI（2026-09-24 被 ESLint 的 `no-dupe-keys` 抓到，见 `tools/lint.mjs`）。
         */
        all: { type: 'boolean', description: 'op=keys：给**全量键名**；op=cases remove：删整个用例集（要 confirm）。' },
        steps: { type: 'array', description: 'op=verify 操作序列（形状见「下沉」§1）。', items: { type: 'object' } },
        expect: { type: 'array', description: 'op=verify 断言（八种 kind 见「下沉」§1）；`count` = **建了几个**；`kind=lua` 只看报不报错（**返回值被忽略** —— 要失败得自己 `assert(false,…)`）。', items: { type: 'object' } },
        cases: { type: 'array', description: 'op=verify 多用例：每项 {name, steps, expect}。', items: { type: 'object' } },
        fromHistory: { type: 'boolean', description: 'op=verify：用**刚跑过那一局**当用例。' },
        frames: { type: 'array', description: 'op=frames 的时间点（模拟秒，升序，≤12 个）。', items: { type: 'number' } },
        diff: { type: 'boolean', description: 'op=frames：是否比帧间像素差（默认 true）。' },
        threshold: { type: 'number', description: 'op=frames：像素算「变了」的每通道阈值（默认 8）。' },
        shotOnFail: { type: 'boolean', description: 'op=verify：没过时自动存失败帧 PNG 并回 `shot`（默认 true）。' },
        stopOnFail: { type: 'boolean', description: 'op=verify 配 cases：第一个没过就停（默认 false）。' },
        keepRunning: { type: 'boolean', description: 'op=verify：判定后不停会话（默认停），便于接着 op=play。' },
        timeoutMs: { type: 'number', description: 'op=verify / op=cases / op=play：单次 play 的墙钟预算（ms，默认 8000，范围 500~600000；也可用环境变量 QXQY_PLAY_TIMEOUT_MS）。⚠️ 长局（>20 秒）必须调大 —— 否则同一用例会间歇超时。' },
        dt: { type: 'number', description: 'op=verify：重放的每步时长（秒）。' },
        runtime: { type: 'boolean', description: 'op=controls：看**运行中**的控件树（脚本动态建的），需先 op=play start。' },
        geom: { type: 'boolean', description: 'op=controls + runtime:true：带世界坐标 `x/y`、尺寸 `w/h`、`text`。' },
        namedOnly: { type: 'boolean', description: 'op=controls：只列有名字的控件（只有它们能按 name 断言）。' },
        nameContains: { type: 'string', description: 'op=controls：按名字子串过滤（中文可用）。' },
        kind: { type: 'string', description: 'op=controls：按类型过滤（container / textbox / image …）。' },
        maxDepth: { type: 'number', description: 'op=controls：只列到第几层（0=根）。' },
        limit: { type: 'number', description: 'op=controls：最多回多少条（默认 200）。' },
        summaryOnly: { type: 'boolean', description: '只去体积不去结论（默认 true：state 不回 boxes 与 tree 全量）。' },
        treeLimit: { type: 'number', description: 'op=state 在 summaryOnly 下最多回多少条控件树（默认 200）。' },
        patch: { type: 'object', description: 'op=patch 编辑操作；数据写带 expectedRevision，**每个 op 只认自己的字段**（§4）。' },
        action: { type: 'string', description: 'op=play 的动作（start/get/step/pointer/key/click/pause/stop… 全表见文档）。' },
        args: { type: 'object', description: 'op=play 参数（`step` 可给 `args.frames:<N>` 真推 N 帧）；形状见文档 §7。' },
        target: { type: 'string', enum: ['ui', 'play'], description: 'op=shot 取景：ui=编辑器视图，play=试玩画面（先 start）。' },
        label: { type: 'string', description: 'op=shot 的文件名标签。' },
        reuse: { type: 'boolean', description: 'op=shot：固定名覆盖写、只留当前帧（不传 = 每张新建）。' },        format: { type: 'string', description: 'op=export / op=import 的格式（默认 gia）。' },
        assetType: { type: 'string', description: 'op=export 的资产类型过滤。' },
        file: { type: 'string', description: 'op=import 要导入的文件绝对路径。' },
        archive: { type: 'string', description: 'op=load 的存档；省略=列出工作区里的存档。' },
        path: { type: 'string', description: 'op=save 的存档文件名（默认 qxqy-simulator.save.json）。' },
        source: { type: 'string', description: 'op=bind / op=handover：一个 .lua 的**绝对路径**（op=handover **只读**，不写盘）。' },
        scripts: {
          type: 'array',
          items: { type: 'object' },
          description: 'op=bind：**一次挂多个脚本** `[{path, source|sourceFrom}]`（就不看顶层 `source`）。',
        },
        templates: { type: 'array', description: 'op=bind：模板清单 `[{guid,kind,name?}]`（`kind` 拿不准传 `"auto"`）。', items: { type: 'object' } },
        containerId: { type: 'number', description: 'op=bind：创作者交接的**容器节点索引**。' },
        scriptName: { type: 'string', description: 'op=bind：挂载名（见「下沉原文」§7）。' },
        mountTo: { type: 'string', description: 'op=bind：脚本挂在哪个控件（id 或名字；缺省=服务端容器节点）。' },
        fresh: { type: 'boolean', description: 'op=bind：默认 true = 清掉出厂工程与已有脚本重建。' },
        last: { type: 'boolean', description: 'op=bind：用**上次那份配方**重搭。' },
        keepFactory: { type: 'boolean', description: 'op=bind：保留出厂橱窗控件（默认清掉）。' },
        run: { type: 'boolean', description: 'op=bind：默认 true = 起一次会话，回 `run.logs` 与 `controlCount`。' },
        settleSec: { type: 'number', description: 'op=bind：起完会话先让时钟走几秒再读。' },
        runForMs: { type: 'number', description: 'op=bind：起完会话**真跑** N 毫秒再读（≤60000，超出夹紧）。' },
        withMeta: { type: 'boolean', description: 'op=bind：回**全文**（默认精简档）；等价 `summaryOnly:false`。' },
        saveAs: { type: 'string', description: 'op=bind：把工程存进工作区（缺省 bind-<脚本名>.save.json）。' },
        script: { type: 'object', description: 'op=bind：直接用源码代替读文件 `{path, source}`。' },
        caseSet: { type: 'string', description: 'op=verify：直接跑 `op=cases` 里存的那一组。' },
        set: { type: 'string', description: 'op=cases：用例集的名字（建议「玩法-关卡」）。' },
        case: { type: 'string', description: 'op=cases action=remove：要删的用例名（不给 = 删整组）。' },
        confirm: { type: 'boolean', description: 'op=cases action=remove：删除不可恢复，必须显式 confirm:true。' },
        manual: { type: 'boolean', description: '存用例时标**人工项**（配合 note）；不代跑不代判，只在 `manual[]` 等人打勾。' },
        note: { type: 'string', description: '用例/人工项的说明：人工项必填「人要看什么、看到什么算过」。' },
        name: { type: 'string', description: 'op=bind：存档名；op=cases：set 的别名（manual 项缺省取 note 前 20 字）。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      /*
       * ★ 回执**必须带 `ok`**（2026-09-30 AI 侧易用性实测发现）：全仓只有 `miliastra_sim` 不带 ——
       *   它把引擎回执原样透出去（`{version, canvas, ...}` / `{bound, treeCount, ...}`）。
       *   实测后果两次：`op=bind` 明明成功，调用方按 `r.ok` 判定 ⇒ **误报失败**（面板显示"预览失败"、
       *   AI 侧同样会误判 —— `if (r.ok)` 是任何调用者的第一反应）。这里补 `ok:true`；
       *   **已有 `ok` 的不动**（尤其别把 `false` 盖成 `true`）。
       */
      let simR;
      /*
       * ★★ P1-4（《上下文瘦身设计》）：`boot` ⇒ **只改内存副本**再交给模拟器（**真源一个字节都不动**）。
       *   `sourceFrom`（路径形态）要被"读出来再改"—— 所以先读进内存转成内联 `source`，
       *   这样永远不回写真源（作者的红线：「改写对源码副本做」）。改了什么逐条记在 `probe.patched`。
       */
      let bootProbe = null;
      if (args && args.boot != null && args.op === 'bind') {
        try {
          const patched = patchSimBindBoot(args);
          args = patched.args;
          bootProbe = patched.probe;
        } catch (e) {
          return { ok: false, op: 'bind', code: 'BOOT_PATCH_FAILED', error: (e && e.message) || String(e),
            nextStep: '`boot` 只支持 `{cur:数字, mode:"build"|"select"|"title", complete:bool}`；' 
              + '`complete` 需要玩法自己的数据形状（见 `unsupported` 说明），本插件**不猜**。' };
        }
      }
      try {
        simR = await simOp(args, {});
      } catch (e) {
        /*
         * ★ 守卫错误**回回执、不回异常**（2026-09-30 AI 侧易用性实测）：
         *   例 `op=hud` 没有在跑的会话时原本 `throw` —— 调用方（尤其 AI）必须自己 try/catch，
         *   否则**整轮被打断**；而全仓其它工具是回 `{ok:false,error}`。
         *   **消息一个字不改**，只把"形式"换成回执（AI 拿到的信息量不减、但不会再炸掉调用）。
         */
        return { ok: false, code: ReceiptCode.FAILED, error: String((e && e.message) || e) };
      }
      /*
       * ★ E10（2026-09-29 实战反馈）：**模拟器不渲染富文本**（`<color=#…>` / `<size=…>` 在画面上是原始标签），
       *   真机正常（已实测）—— 工具以前不主动说 ⇒ "画面上有标签"会被误判成产物有问题。
       *   ⇒ 画面类 op（frames / shot）的回执带 `simLimitations[]`（**只陈述模拟器边界，不改任何判据**）。
       */
      if (simR && typeof simR === "object" && !Array.isArray(simR) && (args.op === "frames" || args.op === "shot")) {
        if (!Array.isArray(simR.simLimitations)) {
          simR.simLimitations = [{
            what: "模拟器不渲染富文本",
            symptom: "画面（PNG / HUD）里出现 <color=…> / <size=…> 原始标签",
            real: "真机正常（已实测）—— 这不是产物 bug",
            other: "官方素材渲染、联机、手感同样不在模拟器覆盖内；视觉终验看真机",
          }];
        }
      }

      const simOut = (simR && typeof simR === "object" && !Array.isArray(simR) && simR.ok === undefined) ? { ok: true, ...simR } : simR;
      /* ★ P1-4：`boot` 改了什么，逐条透出去（`真源未动` 这件事也写在 probe.nextStep 里） */
      return bootProbe && simOut && typeof simOut === 'object' ? { ...simOut, probe: bootProbe } : simOut;
    },
  };
