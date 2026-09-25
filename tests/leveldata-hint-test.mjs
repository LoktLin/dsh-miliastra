/**
 * 关卡表写法与候选提示的自测（⑤2 的回归）。
 *
 * 背景（2026-09-25 同事实测报的）：`lib/leveldata.mjs` 原来**只认**顶层 `local LEVELS = {`，
 * 而他的活文件是 `DATA.LEVELS = {`（表挂在字段上）→ 抽不到表，而报错只说「没找到」：
 * 他既不知道工具认哪些写法，也不知道该传什么 `nameHint`。
 *
 * 这里用**小型合成样本**（不拷任何人手上那份 20KB 的活文件进仓库）分两层验：
 *   · 纯函数：`extractLevelTable` / `findLevelTableCandidates` —— 两种写法、多级前缀、候选排序；
 *   · 集成：把 `MILIASTRA_LOCALLOW` 指到**临时造的假存档**，直接调 `miliastra_code op=levels`，
 *     验 `nameHint` 真的透传、失败时真的回候选、把候选传回去真的能成功（**闭环**）。
 *
 * 用法：node tests/leveldata-hint-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../index.js';
import { extractLevelTable, findLevelTableCandidates } from '../lib/leveldata.mjs';

let pass = 0;
const failures = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ------------------------------------------------------------ 合成样本（都很小） */

const LOCAL_LEVELS = [
  '-- 本机那种写法：顶层 local',
  'local K_PLAIN, K_ICE = 0, 1',
  'local LEVELS = {',
  '  {',
  '    name = "第1关",',
  '    spawn = { 40, 90 },',
  '    plats = {',
  '      { 0, 120, 260, 100, K_PLAIN },',
  '      { 340, 180, 130, 24, K_ICE },',
  '    },',
  '  },',
  '}',
].join('\n');

const FIELD_LEVELS = [
  '-- 同事那种写法：表挂在字段上',
  'local K_PLAIN, K_ICE = 0, 1',
  'DATA = DATA or {}',
  'DATA.LEVELS = {',
  '  {',
  '    name = "第1关",',
  '    spawn = { 40, 90 },',
  '    plats = {',
  '      { 0, 120, 260, 100, K_PLAIN },',
  '      { 340, 180, 130, 24, K_ICE },',
  '    },',
  '  },',
  '}',
].join('\n');

const DEEP_FIELD_LEVELS = [
  'local M = {}',
  'M.DATA.LEVELS = {',
  '  { name = "第1关", plats = { { 0, 0, 10, 10, 0 } } },',
  '}',
].join('\n');

const BARE_LEVELS = [
  'LEVELS = {',
  '  { name = "第1关", plats = { { 0, 0, 10, 10, 0 } } },',
  '}',
].join('\n');

const NO_HIT = [
  '-- 一个都没有的样本：名字都不叫 LEVELS',
  'local K_PLAIN = 0',
  'local STAGES = {',
  '  { name = "第1关", plats = { { 0, 0, 10, 10, K_PLAIN } } },',
  '}',
  'local ZONES = { { 1, 2, 3 } }',
  'DATA.LEVELS_2 = { { name = "旧" } }',
].join('\n');

const FIELD_NOT_ARRAY = [
  'DATA.LEVELS = {',
  '  name = "第1关",',
  '  plats = { { 0, 0, 10, 10, 0 } },',
  '}',
].join('\n');

/* ------------------------------------------------------------ ① 两种写法都认 */

await check('★ 老写法照旧：`local LEVELS = {` 抽得到（并报出 matched）', async () => {
  const r = extractLevelTable(LOCAL_LEVELS);
  assert(r.ok === true, '抽表失败：' + r.error);
  assert(r.levels.length === 1 && r.levels[0].name === '第1关', '关卡内容不对：' + JSON.stringify(r.levels));
  assert(r.levels[0].plats.length === 2 && r.levels[0].plats[1][4] === 1, '常量/平台没解析对');
  assert(r.matched && r.matched.name === 'LEVELS' && r.matched.kind === 'local', 'matched 不对：' + JSON.stringify(r.matched));
  return 'matched=LEVELS(local)，1 关 2 平台';
});

await check('★ 新写法：`DATA.LEVELS = {`（字段赋值）也抽得到 —— 这条修之前会红', async () => {
  const r = extractLevelTable(FIELD_LEVELS);
  assert(r.ok === true, '字段写法的关卡表没抽到：' + r.error);
  assert(r.levels.length === 1 && r.levels[0].name === '第1关', '关卡内容不对：' + JSON.stringify(r.levels));
  assert(r.levels[0].plats.length === 2, '平台没解析对：' + JSON.stringify(r.levels[0].plats));
  assert(r.matched && r.matched.name === 'DATA.LEVELS' && r.matched.kind === 'field', 'matched 不对：' + JSON.stringify(r.matched));
  return 'matched=DATA.LEVELS(field)，1 关 2 平台';
});

await check('多级前缀 `M.DATA.LEVELS = {` 与裸赋值 `LEVELS = {` 都认', async () => {
  const deep = extractLevelTable(DEEP_FIELD_LEVELS);
  assert(deep.ok === true, '多级前缀没认：' + deep.error);
  assert(deep.matched.name === 'M.DATA.LEVELS', '多级前缀的 matched 不对：' + JSON.stringify(deep.matched));
  const bare = extractLevelTable(BARE_LEVELS);
  assert(bare.ok === true, '裸赋值没认：' + bare.error);
  assert(bare.matched.kind === 'field', '裸赋值应当算 field 档：' + JSON.stringify(bare.matched));
  return 'M.DATA.LEVELS / LEVELS 都抽到';
});

await check('nameHint 能指定别的变量名（新旧两种写法都吃 nameHint）', async () => {
  const srcLocal = LOCAL_LEVELS.replace(/LEVELS/g, 'STAGES');
  const a = extractLevelTable(srcLocal, { nameHint: 'STAGES' });
  assert(a.ok === true, 'local 写法 + nameHint 失败：' + a.error);
  const b = extractLevelTable(FIELD_LEVELS.replace(/LEVELS/g, 'STAGES'), { nameHint: 'STAGES' });
  assert(b.ok === true && b.matched.name === 'DATA.STAGES', '字段写法 + nameHint 失败：' + b.error);
  return 'nameHint=STAGES：local STAGES / DATA.STAGES 都抽到';
});

await check('认不出来时：error 里点名**两种写法**，并给出 searchedFor', async () => {
  const r = extractLevelTable(NO_HIT);
  assert(r.ok === false, '不该成功');
  assert(/没有找到/.test(r.error), '没说「没有找到」：' + r.error);
  assert(/local LEVELS = \{/.test(r.error) && /X\.LEVELS = \{/.test(r.error), 'error 没点名两种写法：' + r.error);
  assert(r.searchedFor === 'LEVELS', 'searchedFor 不对：' + r.searchedFor);
  return r.error;
});

await check('★ 认不出来时**列出候选**（修之前只有一句「找不到」，人得回去翻代码）', async () => {
  const r = extractLevelTable(NO_HIT);
  assert(Array.isArray(r.nameCandidates) && r.nameCandidates.length === 3, '候选数不对：' + JSON.stringify(r.nameCandidates));
  assert(r.nameCandidatesTotal === 3, '候选总数不对：' + r.nameCandidatesTotal);
  // 名字里含 nameHint 的排前面（DATA.LEVELS_2），其余按行号
  assert(r.nameCandidates[0].name === 'DATA.LEVELS_2' && r.nameCandidates[0].kind === 'field', '排序/类型不对：' + JSON.stringify(r.nameCandidates[0]));
  assert(r.nameCandidates.some((c) => c.name === 'STAGES' && c.kind === 'local' && c.line === 3), 'local 候选不对：' + JSON.stringify(r.nameCandidates));
  assert(r.nameCandidates.every((c) => typeof c.line === 'number'), '候选缺行号：' + JSON.stringify(r.nameCandidates));
  return r.nameCandidates.map((c) => `${c.name}(${c.kind}@L${c.line})`).join(' > ');
});

await check('★ 候选能直接当 nameHint 用（闭环：照着回执说的做就能成功）', async () => {
  const r = extractLevelTable(NO_HIT, { nameHint: 'STAGES' });
  assert(r.ok === true && r.matched.name === 'STAGES', '把候选名传回去没能抽到：' + r.error);
  const r2 = extractLevelTable(NO_HIT, { nameHint: 'DATA.LEVELS_2' });
  assert(r2.ok === true && r2.matched.name === 'DATA.LEVELS_2', '多级候选名传回去没能抽到：' + r2.error);
  return 'nameHint=STAGES / DATA.LEVELS_2 都能抽到';
});

await check('字段写法命中但顶层不是数组 → 明确报错并点名**命中的那个名字**', async () => {
  const r = extractLevelTable(FIELD_NOT_ARRAY);
  assert(r.ok === false && /不是数组/.test(r.error), '没说「不是数组」：' + r.error);
  assert(/DATA\.LEVELS/.test(r.error), '没点名是哪个表：' + r.error);
  return r.error;
});

await check('findLevelTableCandidates：只按形状扫，不猜语义（注释里的赋值不算）', async () => {
  const src = [
    'local T = {',            // 算
    '  -- DATA.NOT_REAL = { 注释里不算',
    '}',
    'A.B = {',                 // 算
    '}',
  ].join('\n');
  const c = findLevelTableCandidates(src);
  assert(c.total === 2, '候选数不对（注释里那个不该算）：' + JSON.stringify(c.rows.map((r) => r.name)));
  assert(c.rows.some((r) => r.name === 'T' && r.kind === 'local') && c.rows.some((r) => r.name === 'A.B' && r.kind === 'field'),
    '形状识别不对：' + JSON.stringify(c.rows));
  return c.rows.map((r) => `${r.name}(${r.kind})`).join(' / ');
});

/* ------------------------------------------------------------ ② 工具层（假存档，集成） */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-levelhint-'));
const savedLow = process.env.MILIASTRA_LOCALLOW;
const luaDir = path.join(tmp, 'miHoYo', '原神', 'BeyondLocal', '201170108', 'Beyond_Local_Save_Level', '1073741833', 'external_lua_file');
fs.mkdirSync(luaDir, { recursive: true });
fs.writeFileSync(path.join(luaDir, 'game_01.lua'), FIELD_LEVELS + '\n', 'utf8');
process.env.MILIASTRA_LOCALLOW = path.join(tmp, 'miHoYo');

const codeTool = TOOLS.find((t) => t.name === 'miliastra_code');

await check('★ 集成：op=levels 认 `DATA.LEVELS = {`（同事那份活文件的写法）', async () => {
  const r = await codeTool.execute({ op: 'levels' }, {});
  assert(r.ok === true, 'op=levels 失败：' + JSON.stringify(r).slice(0, 240));
  assert(r.levelCount === 1, '关卡数不对：' + r.levelCount);
  assert(r.matchedName === 'DATA.LEVELS', '没报出命中的表名：' + r.matchedName);
  assert(r.nameHint === 'LEVELS', '默认 nameHint 不对：' + r.nameHint);
  assert(r.levels[0].platCount === 2, '平台数不对：' + r.levels[0].platCount);
  // ① 的 pickedBy/candidates 也要在 levels 的回执里（这次没有 .gil → mtime）
  assert(r.pickedBy === 'mtime' && r.selectedFile === 'game_01.lua', '没报出选了谁/凭什么：' + JSON.stringify({ by: r.pickedBy, f: r.selectedFile }));
  return `levelCount=1 matchedName=${r.matchedName} pickedBy=${r.pickedBy}`;
});

await check('★ 集成：op=levels 的 nameHint 真的透传；不命中时回候选 + hint 指路', async () => {
  const miss = await codeTool.execute({ op: 'levels', nameHint: 'STAGES' }, {});
  assert(miss.ok === false, '不存在的 nameHint 竟然成功了：' + JSON.stringify(miss).slice(0, 200));
  assert(miss.searchedFor === 'STAGES', 'searchedFor 没跟着 nameHint 走：' + miss.searchedFor);
  assert(Array.isArray(miss.nameCandidates) && miss.nameCandidates.some((c) => c.name === 'DATA.LEVELS'),
    '没把文件里像关卡表的声明摆出来：' + JSON.stringify(miss.nameCandidates));
  assert(/nameHint/.test(miss.hint || ''), 'hint 没告诉人该传 nameHint：' + miss.hint);
  // 闭环：把候选里那个名字传回去 → 成功
  const hit = await codeTool.execute({ op: 'levels', nameHint: 'DATA.LEVELS' }, {});
  assert(hit.ok === true && hit.levelCount === 1, '照着候选传 nameHint 却没成功：' + JSON.stringify(hit).slice(0, 200));
  return 'nameHint=STAGES → 失败 + 候选 + hint 指路；nameHint=DATA.LEVELS → 成功';
});

/* ------------------------------------------------------------ 收尾 */

if (savedLow === undefined) delete process.env.MILIASTRA_LOCALLOW; else process.env.MILIASTRA_LOCALLOW = savedLow;
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(failures.length ? 1 : 0);
