#!/usr/bin/env node
/**
 * `miliastra_gen`（生成器）测试：**纯函数层 + 校验层 + 工具层**。
 *
 * ★ 为什么要有它 / **修前为什么红**（一条条说清，否则「加了个测试」等于没加）：
 *   ① 纯函数层：`text-gradient` 的切分/采样/风格/帧数是**逐字**从第三方工具移植的
 *      （`xiaomoL444/ugc-tool`，作者授权、保持开源）—— 移植最容易出的错是「看错一步偏移」，
 *      所以这里钉住**具体的数字/字符串**：1 字文本 t 取 0、2 字文本两端正好是色标端点、
 *      flow-forward 的帧数 = `2n-1`、fade 固定 24 帧、`lcm(3,1)=3` …
 *      **不写这些断言的话，源码里的 `i / (length - 1)` 与 `frames.slice(1).reverse()` 少抄一层都没人发现。**
 *   ② 校验层：**两条硬规则**（结构体 ID 10 位数字 / 单条文本 ≤500 字符）是**平台会不会导得进去**的前提。
 *      修前若按「先装配再顺口一提」的写法，非法 ID 会**照样产出 JSON**（源码就是只 `toast` 一句）——
 *      于是创作者拿着导不进去的 JSON 白跑一轮。这里断言「非法 ID / 超长文本 = `ok:false` + 有人话的错误」。
 *   ③ `struct_ype` 兼容：这个拼写是**文件里的既成事实**（同仓库 25 份真实样例全是它），
 *      但文档口径说"正确拼写"是 `struct_type`。修前若只认一个，另一种就会静默丢字段
 *      （`struct_ype` 被当成未知键 → 导出的定义少一行）⇒ 这里实测「两个都读得出、写出可切换」。
 *   ④ 工具层：**真从 `TOOLS` 调 `execute`**（不是直接 import lib）—— 修前的问题是
 *      「lib 写好了但没接线 / op 拼错静默回落成默认 op」：这里断言未知 op **明确报错**、
 *      `TOOLS` 里真的有这个工具、description 带「典型调用」、`summaryOnly` 真的省体积。
 *
 * ⚠️ 全程**不写任何文件**：`miliastra_gen` 是纯函数工具（这一点本身也被断言）。
 * 用法：`node tests/gen-test.mjs`
 */
import { TOOLS } from '../index.js';
import { gcd, lcm } from '../lib/textgradient/math.mjs';
import {
  COLOR_STYLES, SIZE_STYLES, DEFAULT_COLORS, DEFAULT_SIZES, FADE_FRAMES,
  DEFAULT_SIZE_MIN, DEFAULT_SIZE_MAX, JITTER_PICKS, JITTER_BASE_SIZE,
  mulberry32, randInt, parseColor, mixColor, withAlpha, scaleSampler,
  hex6, to4Bit, hex4, piecewiseSize, parseColors, parseSizes,
  normalizeConfig, deviationsOf,
} from '../lib/textgradient/model.mjs';
import {
  LINE_CHAR_LIMIT, DEFAULT_MAX_FRAMES, buildColorFrames, buildSizeFrames,
  renderFrame, textGradient, STYLE_CHOICES,
} from '../lib/textgradient/gradient.mjs';
import { luaString, frameToLuaLine, buildTextGradientLua, textGradientLua } from '../lib/textgradient/lua.mjs';
import {
  PARAM_TYPES, TYPE_LABELS, TYPE_KIND, TEXT_LIMIT, STRUCT_ID_LENGTH, SPELLING_KEYS,
  defaultNodeValue, isParamType, paramNode,
} from '../lib/structvar/model.mjs';
import {
  isStructId, assertStructId, assertParamType, normalizeSpelling, readSpellingKey,
  collectTexts, checkTextLimit,
} from '../lib/structvar/validate.mjs';
import {
  fmtInt, fmtFloat, fmtBool, fmtComponent, fmtVector, toParamNode,
  toDefinitionField, countNodes, unverifiedOf, structJson, DEFAULT_VALUES,
} from '../lib/structvar/build.mjs';

let pass = 0;
const failures = [];
const ok = (name, detail = '') => { pass += 1; console.log(`✓ ${name}${detail ? ' —— ' + detail : ''}`); };
const bad = (name, why) => { failures.push(`${name}: ${why}`); console.log(`✗ ${name} —— ${why}`); };
/**
 * 用例**只登记、不执行**（有些用例是 async 的，统一在文末按登记顺序 await 跑完）。
 * ⚠️ 为什么不写成同步 `t(name, fn){ fn() }`：那样几条 `async` 用例的断言会全漂在 Promise 里，
 * 测试**照样"全绿"** —— 那是测试自己制造的假绿。这条注释是给下一个改这个文件的人看的。
 */
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || '不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
/** 断言某次调用**报错**（而不是静默回一个坏结果）。 */
function throws(fn, mustInclude, msg) {
  let err = null;
  /*
   * ★ 2026-10-08：工具出口已统一"失败回 {ok:false} 回执、不抛异常"（红线）⇒
   *   本助手同时接受两种"拒绝"形态：**抛异常** 或 **回执 ok:false**（把 error 当成错误文案）。
   *   断言意图不变：**坏输入必须被明确拒绝，且文案里要有该有的关键词**。
   */
  try {
    const r = fn();
    if (r && typeof r === 'object' && r.ok === false) err = String(r.error || r.code || '（ok:false）');
  } catch (e) { err = (e && e.message) || String(e); }
  assert(err !== null, (msg || '应当报错') + '，但没报错');
  if (mustInclude) assert(err.includes(mustInclude), `错误文案里没有「${mustInclude}」：${err}`);
  return err;
}

const gen = TOOLS.find((x) => x.name === 'miliastra_gen');

/* ---------------------------------------------------------------- ① 纯函数层 */

t('gcd / lcm 与源码同形（含 `lcm(0,7)=0` 与 `lcm(0,0)=0` 两条退化）', () => {
  eq(gcd(12, 18), 6, 'gcd(12,18)');
  eq(gcd(0, 5), 5, 'gcd(0,5)');
  eq(lcm(3, 4), 12, 'lcm(3,4)');
  eq(lcm(3, 1), 3, 'lcm(3,1)');
  eq(lcm(0, 7), 0, 'lcm(0,7) 必须 0（源码 NaN 兜底）');
  eq(lcm(0, 0), 0, 'lcm(0,0) 必须 0');
  return 'lcm(3,1)=3 / lcm(0,7)=0 / lcm(0,0)=0';
});

t('色标采样：2 个色标时 t=0/1 正好是端点，t=0.5 是中点（线性 sRGB）', () => {
  const s = scaleSampler([{ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }]);
  eq(hex6(s(0)), '#000000', 't=0');
  eq(hex6(s(1)), '#ffffff', 't=1');
  eq(hex6(s(0.5)), '#808080', 't=0.5（Math.round(127.5)=128）');
  // 越界要夹住（源码 chroma 也会夹）
  eq(hex6(s(-1)), '#000000', 't 越界下夹');
  eq(hex6(s(2)), '#ffffff', 't 越界上夹');
  return '#000000 → #808080 → #ffffff';
});

t('parseColor：hex 3/4/6/8 位与 rgb()/rgba() 都认，短格式会展开', () => {
  eq(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 }, '#fff');
  eq(parseColor('#f00f'), { r: 255, g: 0, b: 0, a: 1 }, '#f00f（a=15/15=1）');
  eq(parseColor('#ff000080').a, 128 / 255, '#ff000080 的 alpha');
  eq(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 }, 'rgb()');
  eq(parseColor('rgba(1,2,3,0.5)').a, 0.5, 'rgba()');
  throws(() => parseColor('red'), 'CSS', 'CSS 颜色名必须明确拒绝（不引入依赖也不猜）');
  return '8 种输入 + 1 种明确拒绝';
});

t('hex6 丢 alpha、hex4 保留 alpha（这正是「淡入淡出在 8bit 下空转」的根因）', () => {
  eq(hex6({ r: 255, g: 0, b: 0, a: 0.5 }), '#ff0000', 'hex6 不带 alpha');
  eq(hex4({ r: 255, g: 0, b: 0, a: 1 }), '#f00', 'a=1 ⇒ 三位（源码 a==15 时省略）');
  eq(hex4({ r: 255, g: 0, b: 0, a: 0.5 }), '#f008', 'a=0.5 ⇒ 四位（to4Bit(127.5)=8）');
  eq(to4Bit(255), 15, 'to4Bit(255)');
  eq(to4Bit(0), 0, 'to4Bit(0)');
  return 'hex6 丢 alpha / hex4 的 a==15 省略第 4 位';
});

t('mixColor / withAlpha 是纯函数（不改原对象）', () => {
  const a = { r: 0, g: 0, b: 0, a: 1 };
  const b = { r: 10, g: 20, b: 30, a: 0 };
  eq(mixColor(a, b, 0.5), { r: 5, g: 10, b: 15, a: 0.5 }, 'mix 0.5');
  eq(withAlpha(a, 0.25).a, 0.25, 'withAlpha');
  eq(a.a, 1, '原对象没被改');
  eq(withAlpha(a, 9).a, 1, 'alpha 上夹到 1');
  return 'mix 与 withAlpha 都不改入参';
});

t('piecewiseSize：2 个色标与源码逐值相同；≥3 个色标按区间内局部 t（修正源码的越界取值）', () => {
  eq(piecewiseSize([20, 40], 0), 20, '2 色标 t=0');
  eq(piecewiseSize([20, 40], 0.5), 30, '2 色标 t=0.5');
  eq(piecewiseSize([20, 40], 1), 40, '2 色标 t=1');
  eq(piecewiseSize([10, 20, 30], 0.5), 20, '3 色标 t=0.5（源码会给 30 —— 这是刻意的修正）');
  eq(piecewiseSize([7], 0.9), 7, '单色标恒返回它自己');
  return '2 色标逐值相同；3 色标 t=0.5 → 20（源码 30）';
});

t('mulberry32 / randInt 确定性：同种子两次一模一样，不同种子不同', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(999);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  eq(seqA, seqB, '同种子序列一致');
  assert(seqA[0] !== c(), '不同种子应当不同');
  assert(seqA.every((v) => v >= 0 && v < 1), '取值应当在 [0,1)');
  const ra = mulberry32(7); const rb = mulberry32(7);
  eq([randInt(ra, 0, 9), randInt(ra, 5, 5)], [randInt(rb, 0, 9), 5], 'randInt 含端点 min=max');
  return '同种子可复现（源码用 Math.random，不可复现 —— 这是刻意的偏差）';
});

t('normalizeConfig：默认值正确 + 未知风格**报错并列出合法值**', () => {
  const n = normalizeConfig({ text: 'ab' });
  assert(n.ok === true, '默认配置应当成功');
  eq(n.config.colors.length, DEFAULT_COLORS.length, '默认色标');
  eq(n.config.sizes, DEFAULT_SIZES, '默认字号');
  eq(n.config.withColor, true, 'withColor 默认 true');
  eq(n.config.withSize, false, 'withSize 默认 false（未验证项默认关）');
  eq(n.config.use4bit, false, 'use4bit 默认 false');
  eq(n.config.colorStyle, 'flat', 'colorStyle 默认 flat');
  eq(n.config.chars.length, 2, 'chars 按 UTF-16 码元切');
  const e = normalizeConfig({ text: 'a', colorStyle: 'ColorFlow1' });
  assert(e.ok === false, '源码内部名 ColorFlow1 **不该**被接受（我们自己命名）');
  assert(e.error.includes('flow-forward'), '报错要列出合法值：' + e.error);
  assert(normalizeConfig({ text: 'a', colorStyle: 'flow-forward' }).ok, 'flow-forward 合法');
  return '默认值 8 项 + 未知风格报错带合法值';
});

t('parseColors / parseSizes 的失败路径（空数组与非数字都要报）', () => {
  throws(() => parseColors([]), '至少 1 个', '空 colors');
  throws(() => parseColors(['red']), '认不出的颜色', '非法颜色');
  throws(() => parseSizes([]), '至少 1 个', '空 sizes');
  throws(() => parseSizes(['x']), '非数字', '非法字号');
  return '4 条失败路径';
});

t('deviationsOf 把 5 处刻意偏差列全（含「枚举自己命名」与「不引 chroma」）', () => {
  const d = deviationsOf();
  assert(d.length >= 5, '偏差条数');
  assert(d.some((s) => s.includes('自己命名')), '要有枚举命名偏差');
  assert(d.some((s) => s.includes('chroma')), '要有插值实现偏差');
  assert(d.some((s) => s.includes('随机')), '要有随机默认值偏差');
  return `${d.length} 条`;
});

/* ------------------------------------------------------- ② 风格 / 逐帧（序列层） */

const cfg = (extra) => {
  const n = normalizeConfig(Object.assign({ text: 'abc', colors: ['#000000', '#ffffff'] }, extra));
  assert(n.ok, '夹具配置应当合法：' + n.error);
  return n.config;
};

t('flat 颜色帧：1 帧，且 t = i/(n-1) 均匀采样（首尾正好是色标端点）', () => {
  const c = cfg({});
  const frames = buildColorFrames(c);
  eq(frames.length, 1, 'flat 只有 1 帧');
  eq(frames[0].map(hex6), ['#000000', '#808080', '#ffffff'], '3 个字符的采样');
  const one = cfg({ text: 'x' });
  eq(hex6(buildColorFrames(one)[0][0]), '#000000', '**1 个字符时 t=0/0=NaN → 按 0 处理**（源码同）');
  return '3 字符 → #000000/#808080/#ffffff；1 字符 → t 退化取 0';
});

t('flow-forward：帧数 = 2n-1，第 0 帧等于原始序列（滑动窗口）', () => {
  const c = cfg({ colorStyle: 'flow-forward' });
  const frames = buildColorFrames(c);
  eq(frames.length, 5, 'n=3 ⇒ 2*3-1 = 5 帧（步长 1）');
  // 源码的「来回长序列」是 `frames + frames.slice(1).reverse() + frames.slice(1)`（**第三段不是整份 frames**）
  // ⇒ n=3 时长序列 = [c0,c1,c2,c2,c1,c1,c2]（8 项 = 3n-1），窗口从 0 滑到 4：
  eq(frames[0].map(hex6), ['#000000', '#808080', '#ffffff'], 'i=0 → slice(0,3) = 原序列');
  eq(frames[1].map(hex6), ['#808080', '#ffffff', '#ffffff'], 'i=1 → slice(1,4)');
  eq(frames[2].map(hex6), ['#ffffff', '#ffffff', '#808080'], 'i=2 → slice(2,5)（反向段）');
  eq(frames[3].map(hex6), ['#ffffff', '#808080', '#808080'], 'i=3 → slice(3,6)');
  eq(frames[4].map(hex6), ['#808080', '#808080', '#ffffff'], 'i=4 → slice(4,7)（第三段的头两项接回去）');
  return '5 帧，逐帧与源码的滑动窗口一致';
});

t('flow-backward：帧数与 forward 相同但**顺序相反**（源码 i 从 2n-2 递减）', () => {
  const fwd = buildColorFrames(cfg({ colorStyle: 'flow-forward' }));
  const bwd = buildColorFrames(cfg({ colorStyle: 'flow-backward' }));
  eq(bwd.length, 5, '帧数 5');
  eq(bwd[0].map(hex6), fwd[4].map(hex6), '反向流的首帧 = 正向流的末帧（i=4 起）');
  eq(bwd[4].map(hex6), fwd[0].map(hex6), '反向流的末帧 = 正向流的首帧');
  eq(bwd[2].map(hex6), fwd[2].map(hex6), '中间那一帧两边相同（对称点）');
  return '同帧数、方向相反';
});

t('colorJumpFrames：步长 = max(1, 值+1)，帧数按步长收缩', () => {
  const c = cfg({ colorStyle: 'flow-forward', colorJumpFrames: 1 });
  eq(buildColorFrames(c).length, 3, '步长 2 ⇒ ceil(5/2)=3 帧');
  const c2 = cfg({ colorStyle: 'flow-forward', colorJumpFrames: 0 });
  eq(buildColorFrames(c2).length, 5, '步长 1 ⇒ 5 帧');
  return '步长 2 时 5→3 帧';
});

t('fade-in / fade-out：固定 24 帧，alpha 从 0→1 / 1→0（8bit 时看不出，4bit 才有第 4 位）', () => {
  const inF = buildColorFrames(cfg({ colorStyle: 'fade-in' }));
  const outF = buildColorFrames(cfg({ colorStyle: 'fade-out' }));
  eq(inF.length, FADE_FRAMES, 'fade-in 帧数 = 24');
  eq(outF.length, FADE_FRAMES, 'fade-out 帧数 = 24');
  assert(inF[0][0].a === 0, 'fade-in 第 0 帧 alpha=0，实际 ' + inF[0][0].a);
  assert(inF[FADE_FRAMES - 1][0].a === 1, 'fade-in 末帧 alpha=1');
  assert(outF[0][0].a === 1 && outF[FADE_FRAMES - 1][0].a === 0, 'fade-out 方向相反');
  return '24 帧，alpha 0↔1';
});

t('字号帧：flat 只有 1 帧；jitter 的帧数**跟着颜色帧走**（源码如此）', () => {
  const c = cfg({ sizeStyle: 'jitter', seed: 1 });
  const cf = buildColorFrames(c);
  const sf = buildSizeFrames(c, cf.length);
  eq(sf.length, cf.length, 'jitter 字号帧数 = 颜色帧数');
  eq(sf[0].length, 3, '每帧的字符数 = 文本长度');
  const c2 = cfg({ colorStyle: 'flow-forward', sizeStyle: 'jitter', seed: 1 });
  const cf2 = buildColorFrames(c2);
  eq(buildSizeFrames(c2, cf2.length).length, 5, 'flow 时 jitter 也跟到 5 帧');
  eq(buildSizeFrames(cfg({}), 1).length, 1, 'flat 字号只有 1 帧');
  return 'jitter 帧数跟颜色帧；每帧长度 = 字符数';
});

t('jitter 的确定性 + 基准字号：同种子两次逐值相同，未挑中的字符是 20', () => {
  const a = buildSizeFrames(cfg({ sizeStyle: 'jitter', seed: 42 }), 1);
  const b = buildSizeFrames(cfg({ sizeStyle: 'jitter', seed: 42 }), 1);
  eq(a, b, '同种子逐值一致');
  const c = buildSizeFrames(cfg({ sizeStyle: 'jitter', seed: 42, text: 'abcdefghij' }), 1);
  assert(c[0].includes(JITTER_BASE_SIZE) || c[0].every((v) => v !== undefined), 'base size 常量存在');
  eq(JITTER_BASE_SIZE, 20, 'JITTER_BASE_SIZE 照源码硬编码的 20');
  eq(JITTER_PICKS, 50, 'JITTER_PICKS 照源码的 count<50');
  eq([DEFAULT_SIZE_MIN, DEFAULT_SIZE_MAX], [20, 40], '跳字取值范围照源码默认');
  return '可复现；base=20 / picks=50 / 范围 20~40';
});

t('renderFrame：`<color=#RRGGBB>字</color>` 逐字包裹（官方 only 有依据的那个标签）', () => {
  const c = cfg({});
  const lines = renderFrame(c, buildColorFrames(c), buildSizeFrames(c, 1), 0);
  eq(lines.length, 1, '一行');
  eq(lines[0], '<color=#000000>a</color><color=#808080>b</color><color=#ffffff>c</color>', '逐字符包裹');
  return lines[0];
});

t('withColor=false 出纯文本；withSize=true 时 `<size>` 包在 `<color>` 外面（源码嵌套顺序）', () => {
  const c1 = cfg({ withColor: false });
  eq(renderFrame(c1, buildColorFrames(c1), buildSizeFrames(c1, 1), 0)[0], 'abc', '关颜色就是纯文本');
  const c2 = cfg({ withSize: true });
  const out = renderFrame(c2, buildColorFrames(c2), buildSizeFrames(c2, 1), 0)[0];
  assert(out.startsWith('<size=20><color='), 'size 应在外层：' + out.slice(0, 40));
  assert(out.endsWith('</color></size>'), '闭合顺序也要对：' + out.slice(-24));
  return out.slice(0, 46) + '…';
});

t('999 字符换行规则（源码 LINE_CHAR_LIMIT）：长文本会切成多行，且**每行都不超过阈值**', () => {
  const c = cfg({ text: 'a'.repeat(300) });
  const lines = renderFrame(c, buildColorFrames(c), buildSizeFrames(c, 1), 0);
  // 每个字包上 8bit 颜色标签后是 24 字符（`<color=#rrggbb>` 15 + 字 1 + `</color>` 8）
  assert(lines.length > 1, '300 个字符必须切成多行，实际 ' + lines.length);
  assert(lines.every((l) => l.length > 0), '不允许出现空段');
  assert(lines.every((l) => l.length <= LINE_CHAR_LIMIT), '源码是「先判后加」⇒ 每行都 ≤ 阈值：' + lines.map((l) => l.length).join('/'));
  const total = lines.reduce((s, l) => s + l.length, 0);
  eq(total, 300 * 24, '总字符数守恒（一个字都没丢）');
  eq(lines.length, 8, '41 字/行 ⇒ ceil(300/41) = 8 行');
  return `${lines.length} 行，行长 ${lines.map((l) => l.length).join('/')}（阈值 ${LINE_CHAR_LIMIT}）`;
});

t('frameCount = lcm(颜色帧, 字号帧)，且 `text:""` 时是 0（不再产出越界下标）', () => {
  const r = textGradient({ text: 'abc', colorStyle: 'flat', sizeStyle: 'flat' });
  eq(r.frameCount, 1, 'flat×flat = 1 帧');
  const r2 = textGradient({ text: 'abc', colorStyle: 'flow-forward' });
  eq(r2.frameCount, 5, 'flow-forward = 5 帧');
  const r3 = textGradient({ text: '' });
  eq(r3.ok, true, '空文本不报错');
  eq(r3.frameCount, 0, '空文本帧数 0');
  eq(r3.frames, [], '空文本不给帧');
  assert(r3.notes.some((n) => n.includes('文本为空')), '要在 notes 里说明退化');
  return 'flat=1 / flow=5 / 空文本=0';
});

t('确定性：同一组参数调两次**逐字节相同**（没有 Math.random 漏进去）', () => {
  const args = { text: '千星奇域', colors: ['#FFCC33', '#37FFFF'], colorStyle: 'flow-forward', sizeStyle: 'jitter', seed: 7 };
  eq(textGradient(args), textGradient(args), '两次调用');
  return '两次逐值一致';
});

/* -------------------------------------------------------------- ③ 校验层 */

t('结构体 ID 规则：10 位数字才行（少于/多于/带字母/空 全部拒绝）', () => {
  assert(isStructId('1077936165'), '10 位数字应当过');
  assert(!isStructId('107793616'), '9 位不过');
  assert(!isStructId('10779361650'), '11 位不过');
  assert(!isStructId('10779361a5'), '带字母不过');
  assert(!isStructId(''), '空不过');
  eq(assertStructId('1077936165'), '1077936165', '合法值原样返回');
  throws(() => assertStructId('123', 'structId'), '10 位', '3 位要报错');
  throws(() => assertStructId('abcdefghij', 'x'), '不是纯数字', '非数字要报错（文案照源码：有效10位长度的整数ID）');
  return '5 个非法 + 1 个合法';
});

t('ParamType 校验：24 个类型可枚举、中文标签齐全、未知类型报错并列出全部', () => {
  eq(PARAM_TYPES.length, 24, '24 个成员');
  assert(PARAM_TYPES.every((x) => typeof TYPE_LABELS[x] === 'string' && TYPE_LABELS[x]), '每型都要有中文标签');
  assert(PARAM_TYPES.every((x) => typeof TYPE_KIND[x] === 'string'), '每型都要有值编码');
  assert(isParamType('StructList') && !isParamType('StringList2'), 'isParamType');
  throws(() => assertParamType('Strng'), 'String', '拼错要报错并列出合法值');
  eq(defaultNodeValue('Float'), '0.00', 'Float 默认值');
  eq(defaultNodeValue('Bool'), 'False', 'Bool 默认值');
  eq(defaultNodeValue('Vector3'), '0,0,0', 'Vector3 默认值');
  eq(defaultNodeValue('String'), ' ', 'String 默认值照源码是**一个空格**');
  eq(paramNode('Int32', '0'), { param_type: 'Int32', value: '0' }, 'paramNode 形状');
  return `24 型 × (标签+编码)；默认值 ${TEXT_LIMIT} / ${STRUCT_ID_LENGTH}`;
});

t('单条文本上限 500：String 与 StringList 的**每个元素**都算一条', () => {
  eq(TEXT_LIMIT, 500, '上限常量');
  const node = { param_type: 'String', value: 'x'.repeat(500) };
  assert(checkTextLimit(node).ok, '正好 500 应当过');
  assert(!checkTextLimit({ param_type: 'String', value: 'x'.repeat(501) }).ok, '501 应当不过');
  const list = { param_type: 'StringList', value: ['ok', 'y'.repeat(600)] };
  const r = checkTextLimit(list);
  eq(r.over.length, 1, 'StringList 逐元素算');
  eq(r.max, 600, 'max 要报最长');
  eq(r.over[0].path, '$.value[1]', '要报**具体路径**（否则人不知道改哪个）');
  const texts = collectTexts(list);
  eq(texts.length, 2, 'collectTexts 条目数');
  return '500 过 / 501 不过 / 逐元素 / 路径 $.value[1]';
});

t('`struct_ype` 兼容：读入两个都认、写出可切换、非法拼写报错', () => {
  eq(SPELLING_KEYS, ['struct_ype', 'struct_type'], '两个键');
  eq(normalizeSpelling(undefined), 'struct_ype', '默认沿用真实样例里的拼写');
  eq(normalizeSpelling('struct_type'), 'struct_type', '可显式切换');
  throws(() => normalizeSpelling('structtype'), '不认识的 spelling', '非法拼写要报错');
  eq(readSpellingKey({ struct_ype: 'basic' }), 'struct_ype', '读 struct_ype');
  eq(readSpellingKey({ struct_type: 'basic' }), 'struct_type', '读 struct_type');
  eq(readSpellingKey({ struct_ype: 'basic', struct_type: 'basic' }), 'struct_ype', '两个都在时 struct_ype 优先');
  eq(readSpellingKey({}), null, '都没有回 null');
  return '读 2 种 / 写 2 种 / 非法 1 种';
});

/* -------------------------------------------------------------- ④ 值编码层 */

t('标量编码照真实千星样例：整数/浮点/布尔/向量都写成**字符串**', () => {
  eq(fmtInt(0), '0', 'Int32 → "0"');
  eq(fmtInt(-3), '-3', '负整数');
  eq(fmtFloat(2), '2.00', 'Float → 两位小数');
  eq(fmtFloat(-1), '-1.00', '负浮点');
  eq(fmtBool(true), 'True', 'true → "True"');
  eq(fmtBool('false'), 'False', "'false' → \"False\"");
  eq(fmtComponent(1.5), '1.5', '整/非整分量');
  eq(fmtComponent(2), '2', '整数分量不带小数');
  eq(fmtVector([1, 2, 3]), '1,2,3', '数组');
  eq(fmtVector({ x: 1, y: 2, z: 3 }), '1,2,3', '对象');
  eq(fmtVector('1,2,3'), '1,2,3', '字符串');
  throws(() => fmtInt(1.5), '要整数', 'Int32 收小数要报错');
  throws(() => fmtVector([1, 2]), '3 个分量', '维度不对要报错');
  return '9 个成功 + 2 个失败';
});

t('toParamNode 递归：Struct / StructList / Dict 三种容器的形状都对得上样例', () => {
  const ctx = { coerced: [], structIds: [] };
  const s = toParamNode({ param_type: 'Struct', structId: '1077936164', value: [{ param_type: 'Int32', value: 0 }, { param_type: 'String', value: 'x' }] }, 'f', ctx);
  eq(s, { param_type: 'Struct', value: { structId: '1077936164', type: 'Struct', value: [{ param_type: 'Int32', value: '0' }, { param_type: 'String', value: 'x' }] } }, 'Struct 值：位置参数 + structId + type');
  const sl = toParamNode({ param_type: 'StructList', structId: '1077936164', value: [[{ param_type: 'Int32', value: 1 }]] }, 'f', ctx);
  eq(sl.value.value[0].param_type, 'Struct', 'StructList 的元素是 Struct 节点');
  eq(sl.value.value[0].value.structId, '1077936164', '元素里也带 structId');
  const d = toParamNode({ param_type: 'Dict', key_type: 'Int32', value_type: 'Float', value: [{ key: 3, value: 1.5 }] }, 'f', ctx);
  eq(d.value.type, 'Dict', 'Dict 有 type');
  eq(d.value.key_type, 'Int32', 'key_type');
  eq(d.value.value[0].key, { param_type: 'Int32', value: '3' }, '字典键也是 ParamNode');
  eq(d.value.value[0].value, { param_type: 'Float', value: '1.50' }, '字典值也是 ParamNode');
  const ds = toParamNode({ param_type: 'Dict', key_type: 'Int32', value_type: 'Struct', value_structId: '1077936173', value: [] }, 'f', ctx);
  eq(ds.value.value_structId, '1077936173', '字典带结构体 id 时要写出 value_structId');
  assert(ctx.structIds.length >= 3, 'structId（Struct + StructList + Dict 的 value_structId）都要被登记（用于校验），实际 ' + ctx.structIds.length);
  return '3 种容器 + 字典的结构体 id';
});

t('toDefinitionField：缺 key 直接报错（定义里每个字段必须有 key）', () => {
  const ctx = { coerced: [], structIds: [] };
  const f = toDefinitionField({ key: '标题', param_type: 'String', value: '序章' }, 'f', ctx);
  eq(f, { key: '标题', param_type: 'String', value: { param_type: 'String', value: '序章' } }, 'BaseStructValue 形状');
  throws(() => toDefinitionField({ param_type: 'String' }, 'f', ctx), 'key 不能为空', '缺 key');
  return '形状对 + 缺 key 报错';
});

t('非字符串给 String 会被**强制转成字符串并登记**（不静默丢信息）', () => {
  const ctx = { coerced: [], structIds: [] };
  const n = toParamNode({ param_type: 'String', value: 42 }, 'f', ctx);
  eq(n.value, '42', '转成字符串');
  eq(ctx.coerced.length, 1, '登记一条 coerced');
  eq(ctx.coerced[0].path, 'f.value', '带路径');
  return 'coerced[0] = f.value';
});

/* -------------------------------------------------------------- ⑤ 工具层 */

t('`TOOLS` 里真的有 `miliastra_gen`，且 description 带「典型调用」与两条硬规则', () => {
  assert(gen, '没注册 miliastra_gen');
  assert(/典型调用/.test(gen.description), 'description 要有「典型调用」');
  assert(/10 位数字/.test(gen.description), '要写结构体 ID 硬规则');
  assert(/500 字符/.test(gen.description), '要写文本上限硬规则');
  assert(/未证实|未验证/.test(gen.description), '要写未验证项');
  assert(/Lua/.test(gen.description), '要写「默认出 Lua」（作者 2026-09-28 明令）');
  // ⚠️ op 清单是**逐字**断言的：加一个 op 就必须来这里改一次（防止"悄悄加 op"）。
  //    `pixel-art` 2026-09-29 加的（它自己的 41 条断言在 `tests/pixelart-test.mjs`）。
  //    `vfx-lua` 2026-09-30 加的（粒子特效；它自己的 51 条断言在 `tests/vfx-test.mjs`）。
  eq(gen.parameters.properties.op.enum, ['text-gradient', 'struct-json', 'pixel-art', 'vfx-lua'], '四个 op');
  // `output` 同理：`struct` 是 pixel-art 专用的那档（text-gradient 仍然只认 lua / data）
  eq(gen.parameters.properties.output.enum, ['lua', 'data', 'struct'], 'output 三个取值');
  assert(gen.parameters.properties.controlName, '要暴露 controlName（交接值）');
  assert(gen.parameters.properties.templateIndex, '要暴露 templateIndex（交接值）');
  assert(gen.parameters.properties.summaryOnly, '要暴露 summaryOnly（回执可能很长）');
  return '3 个 op + output(默认 lua) + 交接值参数 + summaryOnly';
});

t('工具层 op=text-gradient：真从 TOOLS.execute 调，回执是 lossless（无 undefined）', async () => {
  const out = await gen.execute({ op: 'text-gradient', output: 'data', text: 'ab', colors: ['#FF0000', '#0000FF'] }, {});
  eq(out.ok, true, 'ok');
  eq(out.op, 'text-gradient', 'op 回显');
  eq(out.frameCount, 1, '帧数');
  eq(out.frames[0].lines.length, 1, '一段');
  eq(out.frames[0].lines[0], '<color=#ff0000>a</color><color=#0000ff>b</color>', '正文');
  eq(out.frames[0].index, 0, '带 index');
  const walk = (v, p = '$') => {
    if (v === undefined) throw new Error('undefined at ' + p);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], `${p}.${k}`));
  };
  walk(out);
  return 'ok / frameCount=1 / 正文逐字对 / 无 undefined';
});

t('工具层 op=struct-json：能直接出「定义」与「变量值」两种形态', async () => {
  const out = await gen.execute({
    op: 'struct-json',
    structId: '1077936165',
    structName: '[任务]章节',
    fields: [{ key: 'id', param_type: 'Int32', value: 0 }, { key: '标题', param_type: 'String', value: '序章' }],
    variableName: '章节表',
  }, {});
  eq(out.ok, true, 'ok');
  eq(out.structIdDigits, 10, '10 位');
  eq(out.definition.type, 'Struct', 'type');
  eq(out.definition.struct_ype, 'basic', '默认拼写 struct_ype（跟真实样例）');
  eq(out.definition.name, '[任务]章节', '结构体名');
  eq(out.definition.value[0], { key: 'id', param_type: 'Int32', value: { param_type: 'Int32', value: '0' } }, '定义字段形状');
  eq(out.value, { structId: '1077936165', type: 'Struct', value: [{ param_type: 'Int32', value: '0' }, { param_type: 'String', value: '序章' }] }, '变量值形状（位置参数）');
  eq(out.variable.variableName, '章节表', '变量名');
  assert(out.definitionText.includes('"struct_ype"'), 'definitionText 里也是 struct_ype');
  assert(JSON.parse(out.valueText).value.length === 2, 'valueText 可解析');
  return 'definition / value / variable 三份都在';
});

t('工具层硬规则①：结构体 ID 不是 10 位数字 ⇒ ok:false + 人话错误（不能产出 JSON）', async () => {
  const out = await gen.execute({ op: 'struct-json', structId: '123', fields: [{ key: 'a', param_type: 'Int32' }] }, {});
  eq(out.ok, false, '必须 ok:false');
  assert(typeof out.error === 'string' && out.error.includes('10 位'), '错误要说清 10 位：' + out.error);
  assert(out.definition === undefined, '**不许**顺手产出定义');
  return out.error.slice(0, 60) + '…';
});

t('工具层硬规则②：单条文本 > 500 字符 ⇒ 默认报错；allowLongText:true 才降级成 warning', async () => {
  const long = 'x'.repeat(501);
  const a = await gen.execute({ op: 'struct-json', structId: '1077936165', fields: [{ key: 't', param_type: 'String', value: long }] }, {});
  eq(a.ok, false, '默认必须报错');
  assert(a.error.includes('500'), '错误里要有 500：' + a.error);
  eq(a.over[0].length, 501, '要报出超长的那条');
  const b = await gen.execute({ op: 'struct-json', structId: '1077936165', fields: [{ key: 't', param_type: 'String', value: long }], allowLongText: true }, {});
  eq(b.ok, true, '放行后 ok');
  eq(b.warnings[0].code, 'TEXT_TOO_LONG', '降级成 warning');
  eq(b.warnings[0].limit, TEXT_LIMIT, 'warning 带上限');
  return '默认拦 / allowLongText 降级';
});

t('工具层：spelling 可切换（写出 struct_type，回执说清读了哪个、写了哪个）', async () => {
  const out = await gen.execute({ op: 'struct-json', structId: '1077936165', spelling: 'struct_type', fields: [{ key: 'a', param_type: 'Int32' }] }, {});
  eq(out.spelling, 'struct_type', '写出的拼写');
  eq(out.spellingAlternative, 'struct_ype', '另一个拼写也报出来');
  eq(out.definition.struct_type, 'basic', '用 struct_type 键');
  assert(!('struct_ype' in out.definition), '同时给两个键会让导入端为难 ⇒ 只写一个');
  eq(out.spellingAccepted, ['struct_ype', 'struct_type'], '读入两个都认');
  return '写出 struct_type，读入两个都认';
});

t('工具层：未知 op **明确报错**（不静默回落成默认 op）', async () => {
  let err = null;
  try {
    const __r = await gen.execute({ op: 'tween-lua' }, {});
    if (__r && __r.ok === false) err = String(__r.error || __r.code || '');
  } catch (e) { err = (e && e.message) || String(e); }
  assert(err !== null, '未知 op 必须报错');
  assert(err.includes('tween-lua') && err.includes('text-gradient'), '错误要点名收到的 op 与支持的 op：' + err);
  // 反向：不传 op 时按默认 op 走（这条也钉住，免得"报错"改成"什么都报错"）
  const d = await gen.execute({ text: 'a' }, {});
  eq(d.op, 'text-gradient', '不传 op 用默认');
  return err.slice(0, 70);
});

t('工具层 summaryOnly：**真的省体积**且不丢结论字段', async () => {
  const args = { op: 'text-gradient', output: 'data', text: 'abcdefghij', colors: ['#FF0000', '#00FF00', '#0000FF'], colorStyle: 'fade-in' };
  const full = await gen.execute(args, {});
  const slim = await gen.execute({ ...args, summaryOnly: true }, {});
  const jf = JSON.stringify(full).length;
  const js = JSON.stringify(slim).length;
  assert(js < jf, `summaryOnly 应当更小：${jf} → ${js}`);
  eq(slim.frames.length, full.frames.length, '帧数不能少');
  eq(slim.frameCount, full.frameCount, 'frameCount 不能少');
  eq(slim.frames[0].charCount, full.frames[0].charCount, '每帧字数不能少');
  assert(!('lines' in slim.frames[0]), 'summaryOnly 才去掉逐帧正文');
  assert(Array.isArray(slim.unverified), '未验证项不能删');
  const sf = await gen.execute({ op: 'struct-json', structId: '1077936165', fields: [{ key: 'a', param_type: 'String', value: 'hi' }], summaryOnly: true }, {});
  assert(!('definitionText' in sf) && typeof sf.definitionTextBytes === 'number', 'struct-json 的 summaryOnly 换字节数');
  eq(sf.counts.fields, 1, '计数不能少');
  assert(typeof sf.nextStep === 'string' && sf.nextStep.length > 10, 'summaryOnly 也必须留 nextStep');
  return `${jf}B → ${js}B（${Math.round(js / jf * 100)}%）`;
});

t('未验证项**只在用到时才出现**（`<size>` / 4bit 默认关，就不该出现）', async () => {
  const hs = { controlName: '标题' };
  const off = await gen.execute({ op: 'text-gradient', text: 'a', ...hs }, {});
  eq(off.unverified, [], '默认不出未验证项');
  const on = await gen.execute({ op: 'text-gradient', text: 'a', withSize: true, use4bit: true, ...hs }, {});
  eq(on.unverified.length, 2, '开了两样就报两条');
  assert(on.unverified.every((u) => u.why && u.param), '每条要说清为什么 + 哪个参数');
  const sv = await gen.execute({ op: 'struct-json', structId: '1077936165', fields: [{ key: 'a', param_type: 'Int32' }] }, {});
  assert(sv.unverified.length >= 1 && sv.unverified.some((u) => /完整|类型集/.test(u.what)), 'struct-json 必须带「类型集未证实」');
  return '3 组开关各验一次';
});

t('8bit 的「淡入/淡出空转」要**如实报出来**（distinctColorFrames + notes）', async () => {
  const hs = { controlName: '标题' };
  const a = await gen.execute({ op: 'text-gradient', text: 'ab', colorStyle: 'fade-in', ...hs }, {});
  eq(a.distinctColorFrames, 1, '8bit 下 24 帧只有 1 种颜色（hex6 丢 alpha）');
  assert(a.notes.some((n) => n.includes('淡入') && n.includes('alpha')), '要在 notes 里点破：' + JSON.stringify(a.notes));
  const b = await gen.execute({ op: 'text-gradient', text: 'ab', colorStyle: 'fade-in', use4bit: true, ...hs }, {});
  assert(b.distinctColorFrames > 1, '4bit 下才真的在变：' + b.distinctColorFrames);
  return `8bit=${a.distinctColorFrames} 种 / 4bit=${b.distinctColorFrames} 种`;
});

t('回执里带 deviations[]（移植偏差如实交代，不假装逐字等价）', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'a', controlName: '标题' }, {});
  assert(Array.isArray(out.deviations) && out.deviations.length >= 5, 'text-gradient 要带偏差清单');
  return out.deviations.length + ' 条';
});

t('纯函数工具：**不写任何文件**（回执里没有落盘字段）', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'a', controlName: '标题' }, {});
  const keys = Object.keys(out);
  assert(!keys.some((k) => /^(path|file|dir|savedTo)$/i.test(k)), '不该有落盘字段：' + keys.join(','));
  return keys.length + ' 个字段，无落盘字段';
});

t('countNodes / unverifiedOf / DEFAULT_VALUES 这些导出真的可用（防死导出）', () => {
  const acc = countNodes({ param_type: 'Struct', value: { value: [{ param_type: 'Int32List', value: ['1'] }] } });
  eq(acc.paramNodes, 2, 'paramNodes 计数');
  eq(acc.listNodes, 1, 'listNodes 计数');
  eq(acc.structNodes, 1, 'structNodes 计数');
  eq(countNodes({ param_type: 'Dict', value: { type: 'Dict', value: [] } }).dictNodes, 1, 'dictNodes');
  assert(unverifiedOf().length >= 1, 'unverifiedOf 非空');
  eq(DEFAULT_VALUES.Float, '0.00', 'DEFAULT_VALUES 取值');
  eq(COLOR_STYLES.length, 5, '5 种颜色风格');
  eq(SIZE_STYLES.length, 2, '2 种字号风格');
  eq([LINE_CHAR_LIMIT, DEFAULT_MAX_FRAMES], [999, 60], '两个输出上限常量');
  return '计数 4 项 + 表 3 张 + 常量 2 个';
});

/* ------------------------------------------------ ⑥ Lua 层（作者 2026-09-28 的方向修正）

 * 验收标准：**AI 调一次接口，回执里就是能直接用的 Lua** —— 不是数据模型、不是"再调一次拼起来"。
 * 所以这一节全部是「回执里的那段 Lua 源码」的断言，而不是"我们内部有个数据模型"。
 */

t('luaString：Lua 字面量转义（反斜杠 / 双引号 / 换行 / 制表符；中文原样）', () => {
  eq(luaString('a"b'), '"a\\"b"', '双引号');
  eq(luaString('a\\b'), '"a\\\\b"', '反斜杠');
  eq(luaString('a\nb'), '"a\\nb"', '换行');
  eq(luaString('a\tb'), '"a\\tb"', '制表符');
  eq(luaString('原神'), '"原神"', '中文不转义');
  eq(luaString(null), '""', 'null → 空串');
  return '6 种输入';
});

t('frameToLuaLine：把一帧的多段拼回一行（999 分段是网页展示用的，不是平台限制）', () => {
  eq(frameToLuaLine({ lines: ['a', 'b', 'c'] }), 'abc', '多段拼一行');
  eq(frameToLuaLine({ lines: [] }), '', '空段回空串');
  eq(frameToLuaLine({}), '', '缺 lines 不炸');
  return '3 种输入';
});

t('★ 一次调用 → **可直接部署的 Lua**（默认 output=lua）', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: '原神千星', colors: ['#FFCC33', '#37FFFF'], colorStyle: 'flow-forward', controlName: '标题' }, {});
  eq(out.ok, true, 'ok');
  eq(out.output, 'lua', 'output 回显');
  assert(typeof out.lua === 'string' && out.lua.length > 200, '要真的有 lua 正文');
  eq(out.luaBytes, Buffer.byteLength(out.lua, 'utf8'), 'luaBytes = 真实字节数（含中文）');
  eq(out.lines, out.lua.split('\n').length, 'lines = 行数');
  eq(out.target.mode, 'control', '走了「按名字找现成控件」');
  eq(out.target.controlName, '标题', '控件名进了回执');
  assert(typeof out.nextStep === 'string' && /miliastra_code op=deploy/.test(out.nextStep), 'nextStep 要给出落地动作');
  assert(/显式传 `level` 与 `file`/.test(out.nextStep), 'nextStep 要提醒显式传 level + file（真事故）');
  return `${out.luaBytes} B / ${out.lines} 行 / ${out.frameCount} 帧`;
});

t('★ 生成的 Lua 遵本仓铁律：EnableUpdate / OnUpdate / CONFIG / error 点名 / 不吞异常', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'abc', colorStyle: 'flow-forward', controlName: '标题', fps: 6 }, {});
  const lua = out.lua;
  assert(/script:EnableUpdate\(true\)/.test(lua), '必须显式 EnableUpdate(true)（不开则 OnUpdate 永不触发）');
  assert(/function OnStart\(\)/.test(lua) && /function OnUpdate\(dt\)/.test(lua) && /function OnDestroy\(\)/.test(lua), '三个回调');
  assert(/local CONFIG = \{/.test(lua), '交接值/节奏要走顶部 CONFIG（不写裸数字）');
  assert(/CONTROL_NAME = "标题"/.test(lua), '控件名进 CONFIG');
  assert(/FPS = 6/.test(lua), 'fps 进 CONFIG');
  assert(/host == nil then[\s\S]*?error\(/.test(lua), 'script.object 为空要 error');
  assert(/GetChild\(CONFIG\.CONTROL_NAME\)/.test(lua), '按名字查子控件');
  assert(/error\("\[text-gradient\] 宿主控件下找不到名为/.test(lua), '找不到控件要 error 点名');
  assert(/c\.text == nil/.test(lua) && /不是文本框/.test(lua), '不是文本框要 error 点名');
  assert(!/pcall/.test(lua), '⛔ 不许有 pcall 吞异常（本仓铁律：不许掩盖报错的兜底）');
  assert(!/FAULT@|诊断/.test(lua), '⛔ 不许往屏幕塞诊断串');
  assert(/print\("\[text-gradient\] start ver=" .. VER/.test(lua), '要 print 版本行（事后能确认某局跑的是哪版）');
  assert(!/return\s*$/m.test(lua.split('\n').filter((l) => /resolve/.test(l)).join('\n')), 'resolve 不许静默 return nil');
  return 'EnableUpdate/OnUpdate/CONFIG/4 处 error/无 pcall/版本行';
});

t('★ 交接值缺失 ⇒ **报错点名要求交接**（绝不编造索引），并给 .gil 候选', async () => {
  /*
   * ★ hermetic（2026-09-29）：**显式传一个不存在的 `level`** 让 `.gil` 读取失败 ⇒ 候选为空 ⇒ 稳定走"缺交接值"。
   *   不传 `level` 时工具会读**当前关卡**的 `.gil`，而本机那张图恰好有唯一候选（文本框模板 + 名字）⇒ 自动采用 ⇒ 回 `ok:true`，
   *   于是这条用例在"机器状态不同"时红绿不定（实测：干净树也会红）—— 这是**用例不 hermetic**，不是工具错。
   */
  const out = await gen.execute({ op: 'text-gradient', text: '标题', controlName: '', level: '999999999' }, {});
  eq(out.ok, false, '缺交接值必须 ok:false（不许回一段运行时必崩的 Lua）');
  assert(/controlName/.test(out.error) && /templateIndex/.test(out.error), '错误要点名这两个交接值：' + out.error);
  assert(/别自己编|绝不编|别编/.test(out.error), '要明确说「别自己编」');
  eq(out.needsHandover.length, 2, 'needsHandover 两条');
  // 候选是**对象**（不是数组）：来自 `.gil` 的两个清单 + 一句说明；读不到存档时是 `{}`
  assert(out.handoverCandidates && typeof out.handoverCandidates === 'object', '要带回从 .gil 读到的候选（读不到就是 {}）');
  if (Array.isArray(out.handoverCandidates.namedChildrenOfContainer)) {
    assert(/没有控件类型/.test(out.handoverCandidates.note || ''), '候选里要说明「记录里没有控件类型，别替你认」');
  }
  eq(out.stats.frameCount > 0, true, 'stats 要在');
  return 'ok:false + needsHandover(2) + handoverCandidates' + (out.handoverCandidates.levelId ? `（读到了关卡 ${out.handoverCandidates.levelId}）` : '');
});

t('★ 模板模式（templateIndex）：InstantiateClientUIControl + nil 检查 + error 点名模板号', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'ab', templateIndex: 1073741867 }, {});
  eq(out.ok, true, 'ok');
  eq(out.target.mode, 'template', '走了动态创建');
  eq(out.target.templateIndex, 1073741867, '模板索引进回执/进 CONFIG');
  const lua = out.lua;
  assert(/TEMPLATE_INDEX = 1073741867/.test(lua), '模板索引进 CONFIG');
  assert(/game\.InstantiateClientUIControl\(CONFIG\.TEMPLATE_INDEX, host\)/.test(lua), '用 host（script.object）当父节点');
  assert(/if c == nil then[\s\S]*?error\(/.test(lua), '实例化返回 nil 必须 error');
  assert(/返回 nil（模板索引/.test(lua) && /tostring\(CONFIG\.TEMPLATE_INDEX\)/.test(lua), 'error 里要带模板号');
  assert(/存为模板/.test(lua), '要点破「只有存为模板的才建得出来」');
  assert(!/GetChild/.test(lua), '模板模式不该出现按名字查');
  return 'InstantiateClientUIControl + nil→error(模板号)';
});

t('两个交接值都给 ⇒ 用 controlName，并在 warnings 里说清忽略了谁', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'a', controlName: '标题', templateIndex: 1073741867 }, {});
  eq(out.target.mode, 'control', 'controlName 优先');
  assert(out.warnings.some((w) => w.code === 'HANDOVER_BOTH_GIVEN'), '要说清 templateIndex 被忽略');
  return out.warnings.map((w) => w.code).join(' / ');
});

t('★ 未验证语法启用时，**产出的 Lua 顶部**就有一行注释（不能只在回执里说）', async () => {
  const out = await gen.execute({ op: 'text-gradient', text: 'ab', withSize: true, use4bit: true, controlName: '标题' }, {});
  const head = out.lua.split('\n').slice(0, 8).join('\n');
  assert(/⚠️ 本段含「size 标签」/.test(head), 'size 的未验证注释要在顶部：' + head);
  assert(/⚠️ 本段含「4bit/.test(head), '4bit 的未验证注释也要在顶部');
  assert(out.warnings.some((w) => w.code === 'UNVERIFIED_SYNTAX'), '回执 warnings 也要有');
  const clean = await gen.execute({ op: 'text-gradient', text: 'ab', controlName: '标题' }, {});
  assert(!/未经真机验证/.test(clean.lua), '默认关的时候不该有这句注释');
  return '两条注释都在前 8 行内';
});

t('★ Lua 模式**一帧都不少**（不吃 `data` 的 60 帧上限 —— 那是静默截断）', async () => {
  // 造一个 > 60 帧的序列：jitter 的帧数跟着颜色帧走，flow-forward 长文本给 2n-1 帧
  const out = await gen.execute({ op: 'text-gradient', text: 'a'.repeat(40), colorStyle: 'flow-forward', controlName: '标题' }, {});
  assert(out.frameCount > 60, '夹具要 > 60 帧，实际 ' + out.frameCount);
  const m = out.lua.match(/^\s{4}"/gm) || [];
  eq(m.length, out.frameCount, 'Lua 里的 FRAMES 条数 = frameCount');
  const dataOut = await gen.execute({ op: 'text-gradient', output: 'data', text: 'a'.repeat(40), colorStyle: 'flow-forward' }, {});
  eq(dataOut.frames.length, 60, 'data 模式仍然按默认上限只出 60 帧（两条路语义不同，刻意的）');
  return `frameCount=${out.frameCount} ⇒ Lua ${m.length} 条；data 模式 ${dataOut.frames.length} 条`;
});

t('★ lua 的 summaryOnly：只去 Lua 正文，`nextStep` / 统计 / 警告必须留', async () => {
  const args = { op: 'text-gradient', text: 'abcdefghij', colors: ['#FF0000', '#00FF00', '#0000FF'], colorStyle: 'fade-in', controlName: '标题' };
  const full = await gen.execute(args, {});
  const slim = await gen.execute({ ...args, summaryOnly: true }, {});
  const jf = JSON.stringify(full).length;
  const js = JSON.stringify(slim).length;
  assert(js < jf / 2, `summaryOnly 要明显更小：${jf} → ${js}`);
  assert(!('lua' in slim) && slim.luaOmitted === true, '去掉的只有 lua 正文');
  eq(slim.luaBytesOmitted, full.luaBytes, '字节数要留下');
  eq(slim.nextStep, full.nextStep, 'nextStep 必须留');
  eq(slim.frameCount, full.frameCount, '统计必须留');
  eq(slim.target.mode, full.target.mode, 'target 必须留');
  eq(slim.warnings.length, full.warnings.length, '警告必须留');
  return `${jf}B → ${js}B（${Math.round(js / jf * 100)}%）`;
});

t('output 只认 lua / data（写错要报错，不静默回落）', async () => {
  let err = null;
  // 2026-10-08：出口不抛异常 ⇒ 回执 ok:false 的 error 也算「报错文案」
  try { const r = await gen.execute({ op: 'text-gradient', output: 'json' }, {}); if (r && r.ok === false) err = String(r.error || r.code || ''); } catch (e) { err = (e && e.message) || String(e); }
  assert(err && err.includes('lua') && err.includes('data'), '要报出合法取值：' + err);
  return err.slice(0, 60);
});

t('struct-json 回执也带 nextStep（变量 JSON 的落地动作）', async () => {
  const out = await gen.execute({ op: 'struct-json', structId: '1077936165', fields: [{ key: 'a', param_type: 'Int32' }] }, {});
  assert(typeof out.nextStep === 'string' && out.nextStep.length > 10, '要有 nextStep');
  assert(/不写任何文件/.test(out.nextStep) && /编辑器/.test(out.nextStep), 'nextStep 要说清"最后一步是人做的"');
  return out.nextStep.slice(0, 50) + '…';
});

/* ---------------------------------------------------------------- 汇总 */

// 按登记顺序把用例跑完（`await` 让 async 用例的断言真的算数）
console.log('');
for (const [name, fn] of queue) {
  try {
    const d = await fn();
    ok(name, d === undefined ? '' : d);
  } catch (e) {
    bad(name, (e && e.message) || String(e));
  }
}

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
