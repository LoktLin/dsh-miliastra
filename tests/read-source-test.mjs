/**
 * `op=read` + `source=<绝对路径>`（读**任意本地 .lua**，只读）自测。
 *
 * 为什么要单开一个套件：这条路径是**唯一**一个「按调用方给的路径去读任意文件」的入口，
 * 所以它同时扛着两种风险，两种都不会自己报错：
 *   ① **误伤**：路径没校验好 → 相对路径按进程当前目录解析、二进制当文本读回一堆乱码；
 *   ② **越界**：这条只读的路要是被写操作借道（`deploy` / `restore` / `fixbom` 的 `source`），
 *      就等于给「任意路径写文件」开了口子 —— 而活文件是**没有 git 的唯一副本**。
 *
 * 所以这里除了「读对了」，还要钉住「读的时候**什么都没写**」与「deploy 的 source 语义没被改」。
 *
 * ⚠️ 与 smoke 同一条纪律：**环境缺失**（本机没有活文件/关卡）与**代码坏了**是两件事 ——
 *    前者如实跳过并说明，不伪装成通过，也不因此放宽断言。
 *
 * 用法：node tests/read-source-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TOOLS } from '../index.js';
import { readLuaAt, MAX_EXTERNAL_READ_BYTES } from '../lib/codefile.mjs';

let pass = 0;
let fail = 0;
const failures = [];

async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

/** 调一次工具：**必须拒绝**的那些用例靠它拿错误文字（没抛就回 null，断言据此判红）。 */
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return (e && e.message) || String(e); }
}

const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');
const simTool = TOOLS.find((t) => t.name === 'miliastra_sim');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-read-src-'));
const EXT = path.join(tmp, '背景图片.lua');
/** 60 行正文（含中文注释 + CRLF）—— 用来验 lines / head / truncated。 */
const BODY = ['-- 任意路径读取的自测样本', 'local 中文注释 = "保持编码"']
  .concat(Array.from({ length: 58 }, (_, i) => `local K${i} = ${i}`))
  .join('\r\n') + '\r\n';
fs.writeFileSync(EXT, BODY, 'utf8');
const EXT_BUF = fs.readFileSync(EXT);
const EXT_LINES = BODY.split(/\r?\n/).length;
const EXT_MTIME = fs.statSync(EXT).mtime.toISOString();

/* --------------------------- ① op=handover source=<绝对路径>：只读、抽那份文件的候选 */

/*
 * 为什么单开这一组（作者 2026-09-25 报的缺陷）：面板「读取」是拿**粘贴的路径**去调
 * `miliastra_sim op=handover source=` 抽候选交接值的 —— 这条路径要是没做校验、或没把 source 当回事，
 * 面板就会「看起来读了、候选表却是空的」，人只能手填 guid（正好撞上"不许编造"那句）。
 * 判据三件：
 *   ① **读的是那一份文件**（readFrom / picked / readMeta 都得指向它，不是沙箱活文件）；
 *   ② **只读**（读完零改动 —— 这条是硬要求，不因为"反正只读"省掉）；
 *   ③ 校验与 `miliastra_code op=read source=` **同一套**（相对路径 / 二进制 / 超大一律拒绝），不是第二份实现。
 */
const hoSrc = path.join(tmp, '交接样本.lua');
fs.writeFileSync(hoSrc, [
  '-- 交接样本：表字段写法（真机脚本里更常见）+ 裸 local 写法',
  'local LIMIT = 60',
  'local CONFIG = {',
  '  containerNodeIndex = 1073741845,',
  '  prefabImage        = 1073741852,',
  '}',
  'local prefabTextBox = 1073741850',
  '',
].join('\n'), 'utf8');
const HO_BUF = fs.readFileSync(hoSrc);

/* ------------------------------------------------------------------ 读对了 */

await check('★ op=read source=<绝对路径>：元信息与正文都对（bytes / lines / sha256_12 / mtime / bom / head）', async () => {
  const r = await codeTool.execute({ op: 'read', source: EXT, head: 2 });
  assert(r.ok === true, '读取失败：' + JSON.stringify(r).slice(0, 300));
  assert(r.readOnly === true, '没有标 readOnly（只读这件事必须写在回执里）');
  assert(path.win32.normalize(EXT) === r.file, 'file 不是规范化后的绝对路径：' + r.file);
  assert(r.source === EXT, 'source 没原样回显');
  assert(r.bytes === EXT_BUF.length, `bytes 不对：${r.bytes} != ${EXT_BUF.length}`);
  assert(r.lines === EXT_LINES, `lines 不对：${r.lines} != ${EXT_LINES}`);
  assert(r.sha256_12 === sha256Hex(EXT_BUF).slice(0, 12), 'sha256_12 不是 sha256 的前 12 位：' + r.sha256_12);
  assert(r.mtime === EXT_MTIME, `mtime 不对：${r.mtime} != ${EXT_MTIME}`);
  assert(r.bom === false, '无 BOM 的样本被报成 bom=true');
  assert(Array.isArray(r.head) && r.head.length === 2, 'head 应是「前 2 行」的数组：' + JSON.stringify(r.head));
  assert(r.head[0] === '-- 任意路径读取的自测样本' && r.head[1] === 'local 中文注释 = "保持编码"', 'head 内容不对：' + JSON.stringify(r.head));
  assert(r.text === r.head.join('\n'), 'text 与 head 不一致（面板预览用的是 text）');
  assert(r.truncated === true, `head:2 时 truncated 应为 true（共 ${r.lines} 行）`);
  assert(/只读/.test(String(r.hint || '')), 'hint 里没说这是只读读取');
  // 中文没被转码（这条路径不做任何转换，读出来就该是同一批字）
  assert(r.text.includes('中文注释'), '中文注释丢失');
  return `${r.bytes} 字节 / ${r.lines} 行 / sha256_12=${r.sha256_12} / bom=false / head=2 行`;
});

await check('head 默认 80 行；head:0 = 全文（且 truncated=false）', async () => {
  const longFile = path.join(tmp, '长文件.lua');
  fs.writeFileSync(longFile, Array.from({ length: 100 }, (_, i) => `local L${i} = ${i}`).join('\n') + '\n', 'utf8');
  const dflt = await codeTool.execute({ op: 'read', source: longFile });
  assert(dflt.head.length === 80, '默认 head 不是 80 行：' + dflt.head.length);
  assert(dflt.truncated === true, '默认档截断了却没标 truncated');
  const all = await codeTool.execute({ op: 'read', source: longFile, head: 0 });
  assert(all.head.length === all.lines, 'head:0 应给全文：' + all.head.length + ' != ' + all.lines);
  assert(all.truncated === false, 'head:0 不该标 truncated');
  assert(all.text.startsWith('local L0 = 0\nlocal L1 = 1'), 'head:0 的正文开头不对');
  return `默认 ${dflt.head.length} 行（截断）/ head:0 全文 ${all.lines} 行`;
});

await check('正斜杠与反斜杠都认（C:/… 与 C:\\… 指向同一个文件）', async () => {
  const fwd = EXT.replace(/\\/g, '/');
  const r = await codeTool.execute({ op: 'read', source: fwd, head: 1 });
  assert(r.ok === true, '正斜杠路径读不到：' + JSON.stringify(r).slice(0, 200));
  assert(r.file === path.win32.normalize(EXT), '两种写法的 file 应该归一化到同一个：' + r.file);
  assert(r.sha256_12 === sha256Hex(EXT_BUF).slice(0, 12), '两种写法的内容哈希不一致');
  return fwd;
});

/* --------------------------------------------------- 错误要清楚、可行动（不是乱码） */

await check('相对路径：拒绝，并说清「为什么不能用相对路径」', async () => {
  const r = await codeTool.execute({ op: 'read', source: '背景图片.lua' });
  assert(r.ok === false, '相对路径竟然被接受了（会按进程当前目录解析到别的文件）');
  assert(/绝对路径/.test(r.error), '报错没点明「要绝对路径」：' + r.error);
  const steps = (r.nextSteps || []).join(' ');
  assert(/盘符/.test(steps) && /完整路径/.test(steps), '没给可行动的下一步（含盘符的完整路径）：' + steps);
  assert(/运行目录/.test(steps), '没解释为什么拒绝相对路径（运行目录不可预期）：' + steps);
  return r.error;
});

await check('文件不存在：拒绝 + 给核对路径的下一步', async () => {
  const missing = path.join(tmp, '并不存在', '没有这个.lua');
  const r = await codeTool.execute({ op: 'read', source: missing });
  assert(r.ok === false, '不存在的文件竟然读成功了');
  assert(/不存在|读不到/.test(r.error), '报错没说清「不存在」：' + r.error);
  assert(/ENOENT/.test(r.error), '没带上底层原因（ENOENT）：' + r.error);
  const steps = (r.nextSteps || []).join(' ');
  assert(/核对路径|写全/.test(steps), '没给可行动的下一步：' + steps);
  return r.error;
});

await check('给的是目录：拒绝（不是「读了一堆乱码」）', async () => {
  const r = await codeTool.execute({ op: 'read', source: tmp });
  assert(r.ok === false, '目录竟然被当成文件读了');
  assert(/不是(一个)?文件|目录/.test(r.error), '报错没点明「这是目录」：' + r.error);
  assert(/(\.lua|文件本身)/.test((r.nextSteps || []).join(' ')), '没给可行动的下一步：' + (r.nextSteps || []).join(' '));
  return r.error;
});

await check('二进制（含 NUL 字节）：拒绝按文本读', async () => {
  const bin = path.join(tmp, '其实是二进制.lua');
  fs.writeFileSync(bin, Buffer.concat([Buffer.from('-- 头\n', 'utf8'), Buffer.from([0x00, 0x01, 0x02, 0xff])]));
  const r = await codeTool.execute({ op: 'read', source: bin });
  assert(r.ok === false, '二进制竟然被当文本读了（会把乱码丢给 AI）');
  assert(/二进制|NUL/.test(r.error), '报错没点明二进制/NUL：' + r.error);
  assert(/miliastra_map|源文件/.test((r.nextSteps || []).join(' ')), '没给可行动的下一步：' + (r.nextSteps || []).join(' '));
  return r.error;
});

await check('非法 UTF-8：拒绝（继续读只会得到乱码）', async () => {
  const bad = path.join(tmp, '坏编码.lua');
  fs.writeFileSync(bad, Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x41]));
  const r = await codeTool.execute({ op: 'read', source: bad });
  assert(r.ok === false, '非法 UTF-8 竟然被读了');
  assert(/UTF-8/.test(r.error), '报错没点明 UTF-8：' + r.error);
  assert(/另存为/.test((r.nextSteps || []).join(' ')), '没给可行动的下一步：' + (r.nextSteps || []).join(' '));
  return r.error;
});

await check(`★ 太大：超过 ${MAX_EXTERNAL_READ_BYTES} 字节（8 MB）就拒绝，并说明上限`, async () => {
  // ① 工具层：真造一个刚好超限的文件（拒绝发生在 stat 之后、read 之前 —— 所以不会真读 8 MB）
  const huge = path.join(tmp, '巨型文件.lua');
  fs.writeFileSync(huge, Buffer.alloc(MAX_EXTERNAL_READ_BYTES + 1, 0x61));
  const r = await codeTool.execute({ op: 'read', source: huge });
  assert(r.ok === false, '超限文件竟然被读了');
  assert(/太大/.test(r.error), '报错没点明「太大」：' + r.error);
  assert(r.error.includes(String(MAX_EXTERNAL_READ_BYTES)), '报错没带上限数字：' + r.error);
  assert(/8 MB|MB/.test(r.error), '上限没写成 MB（人读不出量级）：' + r.error);
  assert(/给错|截取/.test((r.nextSteps || []).join(' ')), '没给可行动的下一步：' + (r.nextSteps || []).join(' '));
  // ② 辅助层：小上限也能测同一个分支（不必每次都写 8 MB）
  const r2 = readLuaAt(EXT, { maxBytes: 8 });
  assert(r2.ok === false && /太大/.test(r2.error), 'readLuaAt 的 maxBytes 分支没生效：' + JSON.stringify(r2).slice(0, 160));
  // ③ op=handover source= 走的是**同一套校验**（复用 readLuaAt）—— 同一个文件在它那里也必须被拒
  const hoMsg = await refusal(() => simTool.execute({ op: 'handover', source: huge }));
  assert(hoMsg !== null && /太大/.test(hoMsg), 'op=handover source= 没把 8 MB 上限这条判据复用过来：' + hoMsg);
  fs.unlinkSync(huge);
  return r.error;
});

/* ------------------------------------------------------------ 只读性回归 */

await check('★ 只读性（行为）：读完文件本身逐字节未变，旁边也不多出备份/临时文件', async () => {
  const dir = path.join(tmp, '只读检查');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '只读.lua');
  fs.writeFileSync(f, '-- 只读检查\nlocal A = 1\n', 'utf8');
  const before = fs.readFileSync(f);
  const beforeStat = fs.statSync(f);
  const beforeList = fs.readdirSync(dir).sort().join('|');

  const r = await codeTool.execute({ op: 'read', source: f, head: 0 });
  assert(r.ok === true, '读取失败：' + JSON.stringify(r).slice(0, 200));
  assert(Buffer.compare(fs.readFileSync(f), before) === 0, '文件内容被改动了');
  assert(fs.statSync(f).mtime.toISOString() === beforeStat.mtime.toISOString(), 'mtime 被改动了');
  assert(fs.readdirSync(dir).sort().join('|') === beforeList, '目录里多出了东西（备份/临时文件？）：' + fs.readdirSync(dir).join(', '));
  assert(!fs.existsSync(path.join(dir, '_backup')), '只读路径竟然建了 _backup 目录');
  // 顺带钉一句：这条路径**不能**有 deploy/restore 之类的能力（回执里不许出现还原指引）
  assert(!/restoreWith/.test(JSON.stringify(r)), '只读回执里出现了 restoreWith（写操作的口子漏进来了）');
  return '逐字节未变 + mtime 未变 + 目录未变 + 无 _backup';
});

await check('★ 只读性（结构）：readLuaAt 里没有任何写操作（源码断言）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'codefile.mjs'), 'utf8');
  const start = src.indexOf('export function readLuaAt');
  assert(start >= 0, '找不到 readLuaAt 的定义');
  // 取到下一个顶层注释/函数为止（本文件里 readLuaAt 后面紧跟「备份」分节）
  const rest = src.slice(start);
  const end = rest.indexOf('\n/* ------');
  const body = (end > 0 ? rest.slice(0, end) : rest)
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 去掉块注释（注释里会点名这些 API，算进去就假红）
    .replace(/^\s*\/\/.*$/gm, '');
  // ⚠️ 只列**真正会写盘**的 API 名：`truncate` 这种子串会把回执字段 `truncated` 也命中（假红）
  const wrote = ['writeFileSync', 'writeFile(', 'atomicWriteFile', 'atomicWriteJson', 'copyFileSync',
    'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync', 'appendFileSync', 'createWriteStream', 'ftruncateSync', 'openSync']
    .filter((api) => body.includes(api));
  assert(wrote.length === 0, '只读路径里出现了写操作：' + wrote.join(', '));
  assert(/fs\.readFileSync|fs\.statSync/.test(body), 'readLuaAt 里没有读到文件？（断言可能失效了）');
  return '读文件的方法只有 statSync / readFileSync';
});

await check('★ 只读性（回归）：op=deploy 的 source 语义没被改 —— 源文件不存在就是拒绝，不会被 read 路径接管', async () => {
  let out = null;
  let threw = null;
  try {
    out = await codeTool.execute({ op: 'deploy', source: path.join(tmp, '并不存在', '要投的.lua') });
  } catch (e) {
    threw = e;
  }
  if (threw) {
    // 本机没有关卡 / 活文件时，deploy 走不到「源文件检查」那一步 —— 如实跳过，不放宽别的断言
    assert(/external_lua_file|没找到|关卡/.test(threw.message), '环境缺失时的报错也不对头：' + threw.message);
    return '本机没有可部署的活文件，跳过（' + String(threw.message).slice(0, 36) + '…）';
  }
  assert(out.ok === false, '不存在的源文件竟然部署成功了');
  assert(/源文件不存在/.test((out.errors || []).join(' ')), 'deploy 没把 source 当「要投进去的本地文件」：' + JSON.stringify(out).slice(0, 220));
  assert(out.readOnly !== true, 'deploy 这条路带了 readOnly 标记 —— 说明它被 read 分支劫持了');
  return (out.errors || [])[0];
});

/* ------------------------------------------------------------ schema / 配对 */

await check('schema：op=read + source 的说明到位，且 read 仍在 op 枚举里', async () => {
  const props = codeTool.parameters.properties;
  assert(props.op.enum.includes('read'), 'op 枚举里没有 read 了');
  assert(/op=read/.test(props.source.description), 'source 的说明里没写「op=read 时也可以」：' + props.source.description);
  assert(/绝对路径/.test(props.source.description), 'source 的说明没强调必须是绝对路径');
  assert(/只读/.test(props.source.description), 'source 的说明没点明 op=read 是只读');
  assert(/head/.test(Object.keys(props).join(',')), 'head 参数没了');
  return 'op 含 read；source 说明含「op=read / 绝对路径 / 只读」';
});

await check('配对：面板抽交接值打的是 miliastra_sim op=handover（不是 miliastra_code）', async () => {
  assert(simTool, '没有 miliastra_sim 工具');
  assert(simTool.parameters.properties.op.enum.includes('handover'), 'miliastra_sim 的 op 枚举里没有 handover');
  assert(!codeTool.parameters.properties.op.enum.includes('handover'), 'miliastra_code 不该有 handover（交接值是 sim 的 op）');
  return 'handover 属于 miliastra_sim；milastra_code 只加了 read+source';
});

await check('不传 source 时完全照旧：还是读沙箱活文件，回执形状不变（这条是「老路径」）', async () => {
  let out = null;
  let threw = null;
  try {
    out = await codeTool.execute({ op: 'read', head: 1 });
  } catch (e) {
    threw = e;
  }
  if (threw) {
    // 本机没有活文件（没在编辑器里挂过脚本）—— 如实跳过，不放宽别的断言
    assert(/external_lua_file|没找到|关卡/.test(threw.message), '环境缺失时的报错也不对头：' + threw.message);
    return '本机没有活文件，跳过（' + String(threw.message).slice(0, 36) + '…）';
  }
  assert(out.ok === true, '读活文件失败：' + JSON.stringify(out).slice(0, 220));
  assert(typeof out.path === 'string' && out.path.includes('external_lua_file'), 'path 不是沙箱活文件：' + out.path);
  assert(typeof out.lineCount === 'number' && typeof out.text === 'string', '老形状（path / lineCount / text）变了');
  assert(out.readOnly === undefined, '不传 source 时不该带 readOnly 标记（这条是「老路径」，形状要照旧）');
  assert(out.source === undefined, '不传 source 时不该回显 source');
  assert(out.text.split('\n').length <= 2, 'head:1 应该只给 1 行：' + JSON.stringify(out.text));
  return 'path=…\\' + out.path.split('\\').pop() + ' · lineCount=' + out.lineCount + ' · 无 readOnly/source 字段';
});
/* ------------------------------------------- ① op=handover source=… 的回归 */

await check('★ op=handover source=<绝对路径>：读的是**那一份**文件（readFrom/readOnly/readMeta），不是沙箱活文件', async () => {
  const ho = await simTool.execute({ op: 'handover', source: hoSrc });
  assert(ho.readFrom === 'source', '没标出这次读的是 source 指定的文件：readFrom=' + JSON.stringify(ho.readFrom));
  assert(ho.readOnly === true, 'source 读取没标 readOnly（只读这件事必须写在回执里）');
  assert(ho.sourceArg === hoSrc, 'sourceArg 没原样回显粘贴的路径：' + ho.sourceArg);
  assert(ho.picked === path.win32.normalize(hoSrc), 'picked 不是那份文件（多半读成沙箱活文件了）：' + ho.picked);
  assert(!!ho.readMeta && ho.readMeta.bytes === HO_BUF.length && ho.readMeta.lines === 8,
    'readMeta 的 bytes/lines 不对：' + JSON.stringify(ho.readMeta));
  assert(ho.readMeta.sha256_12 === sha256Hex(HO_BUF).slice(0, 12), 'readMeta.sha256_12 对不上那份文件：' + ho.readMeta.sha256_12);
  assert(ho.readMeta.bom === false, '无 BOM 的样本被报成 bom=true');
  // 活文件清单照旧（不传 source 时的行为一字不变）——但它只是"顺带列出"，不是这次读的东西
  assert(Array.isArray(ho.files) && typeof ho.fileCount === 'number', 'files/fileCount 这条老形状没了');
  assert(/readFrom:"source"/.test(ho.note) && /只读/.test(ho.note), 'note 没写清"这次读的是 source 那份、且只读"：' + ho.note);
  return 'readFrom=source · picked=' + ho.picked.split('\\').pop() + ' · ' + ho.readMeta.bytes + ' 字节 · sha256_12=' + ho.readMeta.sha256_12;
});

await check('★ 表字段写法也认：CONFIG.prefabImage = 大整数（作者那份 背景图片.lua 就是这么写的）', async () => {
  const ho = await simTool.execute({ op: 'handover', source: hoSrc });
  const byName = (n) => ho.candidates.find((c) => c.name === n);
  assert(ho.candidates.length === 3, '候选条数不对（表字段那两条要抽出来）：' + JSON.stringify(ho.candidates));
  assert(byName('containerNodeIndex').value === 1073741845 && byName('containerNodeIndex').role === 'container',
    '容器那条没被认成容器：' + JSON.stringify(byName('containerNodeIndex')));
  assert(byName('prefabImage').kindHint === 'image' && byName('prefabImage').isTemplate === true,
    'prefabImage 没提示成 image 模板：' + JSON.stringify(byName('prefabImage')));
  assert(byName('prefabTextBox').kindHint === 'textbox' && byName('prefabTextBox').isTemplate === true,
    'prefabTextBox 没提示成 textbox 模板：' + JSON.stringify(byName('prefabTextBox')));
  assert(!ho.candidates.some((c) => c.value === 60), '小整数（LIMIT = 60）被当成了交接值');
  assert(ho.suggestedTemplates.length === 2 && ho.containerId === 1073741845,
    'suggestedTemplates / containerId 没抽出来：' + JSON.stringify({ t: ho.suggestedTemplates, c: ho.containerId }));
  assert(/kind:"auto"|kind:auto/.test(String(ho.nextStep || '')), '抽到了模板却没提示"拿不准用 kind:auto"：' + ho.nextStep);
  return 'containerNodeIndex=1073741845（容器）· prefabImage=1073741852（image）· prefabTextBox=1073741850（textbox）';
});

await check('★ op=handover source=… 是**只读**的：读完文件逐字节未变、mtime 未变、旁边不多出备份/临时文件', async () => {
  const dir = path.join(tmp, 'handover只读');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '只读.lua');
  fs.writeFileSync(f, '-- 只读检查\nlocal TPL = 1073741868\n', 'utf8');
  const before = fs.readFileSync(f);
  const beforeStat = fs.statSync(f);
  const beforeList = fs.readdirSync(dir).sort().join('|');

  const ho = await simTool.execute({ op: 'handover', source: f });
  assert(ho.candidates.length === 1, '读取失败（候选没抽出来）：' + JSON.stringify(ho).slice(0, 200));
  assert(Buffer.compare(fs.readFileSync(f), before) === 0, '文件内容被改动了');
  assert(fs.statSync(f).mtime.toISOString() === beforeStat.mtime.toISOString(), 'mtime 被改动了');
  assert(fs.readdirSync(dir).sort().join('|') === beforeList, '目录里多出了东西（备份/临时文件？）：' + fs.readdirSync(dir).join(', '));
  assert(!fs.existsSync(path.join(dir, '_backup')), '只读抽取竟然建了 _backup 目录');
  assert(!/restoreWith/.test(JSON.stringify(ho)), '只读回执里出现了 restoreWith（写操作的口子漏进来了）');
  return '逐字节未变 + mtime 未变 + 目录未变 + 无 _backup';
});

await check('★ source 分支复用 op=read 那套校验（源码断言：走 readLuaAt、自己不读盘）', () => {
  const s = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'sim.mjs'), 'utf8');
  const block = s.slice(s.indexOf("if (op === 'handover')"), s.indexOf("if (op === 'bind')"));
  assert(block.length > 0, '找不到 op=handover 分支');
  const i = block.indexOf('if (fromSource) {');
  assert(i >= 0, '找不到 fromSource 分支（source 那条路没了？）');
  const branch = block.slice(i, block.indexOf('} else {', i));
  assert(/readLuaAt\(/.test(branch), 'source 分支没有复用 readLuaAt（校验被写成了第二份）');
  // ⚠️ 先去掉注释再查（注释里会点名 readFileSync —— 算进去就假红；同 §只读性（结构）那条的坑）
  const code = branch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/readFileSync/.test(code), 'source 分支自己又读了一次盘（绕过了那套校验）');
  return 'source 分支只调 readLuaAt（8 MB / 二进制 / 绝对路径 都由它判）';
});

await check('★ 相对路径：op=handover source=… 拒绝（以前会按进程当前目录解析 —— 静默读错文件）', async () => {
  const msg = await refusal(() => simTool.execute({ op: 'handover', source: '背景图片.lua' }));
  assert(msg !== null, '相对路径竟然被接受了（会按进程当前目录解析到别的文件）');
  assert(/绝对路径/.test(msg), '报错没点明"要绝对路径"：' + msg);
  assert(/运行目录|盘符/.test(msg), '没给可行动的下一步：' + msg);
  return msg.slice(0, 60) + '…';
});

await check('★ 二进制（含 NUL 字节）：op=handover source=… 拒绝按文本读', async () => {
  const bin = path.join(tmp, 'handover二进制.lua');
  fs.writeFileSync(bin, Buffer.concat([Buffer.from('-- 头\nlocal T = 1073741868\n', 'utf8'), Buffer.from([0x00, 0x01, 0xff])]));
  const msg = await refusal(() => simTool.execute({ op: 'handover', source: bin }));
  assert(msg !== null, '二进制竟然被当文本读了（会把乱码当成候选交接值）');
  assert(/二进制|NUL/.test(msg), '报错没点明二进制/NUL：' + msg);
  return msg.slice(0, 60) + '…';
});

await check('★ 空候选要**指路**：没认出模板索引 → 说清去 .gil 读（miliastra_map op=clientui）或手填', async () => {
  const clean = path.join(tmp, '没有交接值.lua');
  fs.writeFileSync(clean, '-- 这份源码里一个大整数都没有\nlocal N = 3\nprint("hi")\n', 'utf8');
  const ho = await simTool.execute({ op: 'handover', source: clean });
  assert(ho.candidates.length === 0, '这份源码本来就没有交接值，却抽出了候选：' + JSON.stringify(ho.candidates));
  const ns = String(ho.nextStep || '');
  assert(/miliastra_map op=clientui/.test(ns), '空候选没指路（第二条自动来源是 .gil）：' + ns);
  assert(/手填/.test(ns), '空候选没说"或手填"：' + ns);
  return ns.slice(0, 70) + '…';
});

await check('★ schema：source 的说明把 op=handover / op=bind 两种用法都讲清（绝对路径 + 只读）', () => {
  const d = simTool.parameters.properties.source.description;
  assert(/op=handover/.test(d), 'source 的说明没提 op=handover（AI 就不知道 handover 也吃 source）：' + d);
  assert(/op=bind/.test(d), 'source 的说明没提 op=bind：' + d);
  assert(/绝对路径/.test(d), 'source 的说明没强调必须是绝对路径');
  assert(/只读/.test(d), 'source 的说明没点明 op=handover 是只读');
  return 'source 说明含 op=handover / op=bind / 绝对路径 / 只读';
});

await check('不传 source 时形状照旧（仍扫活文件）：readFrom=live、没有 readOnly/readMeta', async () => {
  const ho = await simTool.execute({ op: 'handover' });
  assert(ho.readFrom === 'live', '不传 source 时应标 readFrom=live：' + JSON.stringify(ho.readFrom));
  assert(ho.readOnly === undefined, '不传 source 时不该带 readOnly 标记（这条是"老路径"，形状要照旧）');
  assert(ho.readMeta === undefined, '不传 source 时不该带 readMeta');
  assert(Array.isArray(ho.files), 'files 清单没了：' + JSON.stringify(ho.fileCount));
  assert('fileCount' in ho, 'fileCount 这个老字段没了');
  if (ho.fileCount > 0) assert('currentLevel' in ho, '有活文件却不给 currentLevel');
  return 'readFrom=live · files=' + ho.files.length + ' · fileCount=' + ho.fileCount + ' · 无 readOnly/readMeta';
});

/* ------------------------------------------------------------------ 汇总 */

console.log('');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
