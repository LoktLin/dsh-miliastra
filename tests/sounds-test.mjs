/**
 * 音效库测试（`lib/sounds/search.mjs` + `tools/build-sound-catalog.mjs` + `lib/sounds/catalog.json`）
 *
 * 三层钉：
 *   ① **纯函数层**：归一化 / 分词 / 五档匹配 / 排序 / 参数夹紧 / 报错口径 —— 用手写的迷你快照，
 *      每条断言只考一件事（这层不许依赖真数据，否则数据一改就分不清是哪儿坏了）；
 *   ② **数据层**：快照 1997 条、分类计数、id 唯一、每条都有中英名、时长是毫秒整数；
 *   ③ **可重放层**：镜像还在时，**用生成器把快照重建一遍并要求逐字节一致** ——
 *      「仓库里那份 = 生成脚本在镜像上跑出来的那份」这条只能这么证。
 *      镜像目录不在（别的机器 / 只 clone 了插件）时**跳过并说明**，不假装跑过。
 *
 * ⚠️ 纪律：这里只断言"数字与口径"，不判"该用哪条音效"（那是作者的事）。
 *
 * 用法：node tests/sounds-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMIT, MAX_LIMIT, MATCH_KINDS, maxEditDistance, normalizeText, tokenizeQuery,
  matchOne, rankSounds, loadSoundCatalog, searchSounds, getSound,
} from '../lib/sounds/search.mjs';
import {
  CATALOG_VERSION, SOUND_SOURCE, DEFAULT_SRC_DIR, CATALOG_PATH, toDurationMs,
  assertOrderRecoverable, buildCatalog, serializeCatalog, readSource,
} from '../tools/build-sound-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('✓ ' + label); }
  else { failures.push(label + (detail ? '  → ' + detail : '')); console.log('✗ ' + label + (detail ? '  → ' + detail : '')); }
}

/** 抛错就返回错误消息，不抛返回 null（断言报错口径时用）。 */
function errOf(fn) {
  try { fn(); return null; } catch (e) { return (e && e.message) || String(e); }
}

/* ══════════════════════════════════════════════════ ① 纯函数层 */

/* ---- 归一化 ---- */

ok('normalizeText 小写化（英文名大小写不影响搜索）', normalizeText('Environment_Vibration') === 'environmentvibration');
ok('normalizeText 全角转半角', (() => {
  const a = normalizeText('Ｅｎｖ１２３');
  return a === 'env123';
})(), JSON.stringify(normalizeText('Ｅｎｖ１２３')));
ok('normalizeText 丢掉空格 / 下划线 / 连字符 / 斜杠 / 括号（保留字母数字与中文）',
  normalizeText('（宝箱）- 开_启/01') === '宝箱开启01', JSON.stringify(normalizeText('（宝箱）- 开_启/01')));
ok('normalizeText 表意空格 U+3000 也当空白处理', normalizeText('环境\u3000震动') === '环境震动');
ok('normalizeText 对 null / undefined 不炸（给空串）', normalizeText(null) === '' && normalizeText(undefined) === '');
ok('normalizeText 幂等（归一化两次结果一样）', normalizeText(normalizeText('环境_震动')) === '环境震动');

/* ---- 分词（多关键词 AND） ---- */

ok('tokenizeQuery 按空白切分成多词', JSON.stringify(tokenizeQuery('攻击 命中')) === '["攻击","命中"]');
ok('tokenizeQuery 去重（同一个词写两遍不加倍计分）', JSON.stringify(tokenizeQuery('攻击 攻击 命中')) === '["攻击","命中"]');
ok('tokenizeQuery 全角空格也切分', JSON.stringify(tokenizeQuery('攻击\u3000命中')) === '["攻击","命中"]');
ok('★ tokenizeQuery 对空 q 报错，且提示"不支持拼音"', (() => {
  const m = errOf(() => tokenizeQuery(''));
  return m !== null && /拼音/.test(m) && /关键词/.test(m);
})(), String(errOf(() => tokenizeQuery(''))));
ok('★ tokenizeQuery 对"全是标点"也报错（不静默返回全表）', errOf(() => tokenizeQuery(' ！！！  ')) !== null);

/* ---- 五档匹配 ---- */

const N1 = '环境_震动';
const N_EN = 'Environment_Vibration';
ok('第 1 档 exact：全等', matchOne('环境震动', N1)?.kind === 'exact');
ok('★ exact 忽略下划线（用户打「环境震动」也认全等）', matchOne('环境_震动', N1)?.kind === 'exact');
ok('第 2 档 prefix：前缀', matchOne('环境', N1)?.kind === 'prefix');
ok('第 3 档 substring：子串', matchOne('震动', N1)?.kind === 'substring');
ok('★ 大小写不敏感：VIBRATION 命中英文名', matchOne('VIBRATION', N_EN)?.kind === 'substring');
ok('第 4 档 subsequence：子序列（按顺序、不要求相邻）', matchOne('环震', N1)?.kind === 'subsequence');
ok('第 5 档 editDistance：一个字写错也兜住（宝相 → 宝箱）', (() => {
  const h = matchOne('宝相', '场景物件_机关交互_宝箱_01');
  return h?.kind === 'editDistance' && h.dist === 1;
})(), JSON.stringify(matchOne('宝相', '场景物件_机关交互_宝箱_01')));
ok('第 5 档 editDistance：中文全名一字之差（环境震动 → 环镜震动）', (() => {
  const h = matchOne('环境震动', '环镜震动');
  return matchOne('环镜震动', '环镜震动洗牌')?.kind === 'prefix' && h?.kind === 'editDistance' && h.dist === 1;
})(), JSON.stringify(matchOne('环境震动', '环镜震动')));
ok('★ 编辑距离档的**已知代价**（刻意的，见文档 §5）：2 字中文词会兜住"1 字之差"⇒「循环」也算「环境」的子集',
  matchOne('环境', '场景物件_循环音效_移动风声_01')?.kind === 'editDistance');
ok('★ 编辑距离阈值随词长走：≤3 字容 1 个错，更长容 2 个', maxEditDistance(2) === 1 && maxEditDistance(3) === 1 && maxEditDistance(4) === 2 && maxEditDistance(12) === 2);
ok('无命中给 null（不是空对象）', matchOne('龙', N1) === null);
ok('空 token 给 null（不会因为 startsWith("") 全命中）', matchOne('', N1) === null && matchOne('！！', N1) === null);
ok('★ 单字查询不走编辑距离档（否则"名字里根本没有这个字"也会命中一片）', matchOne('龙', '大龙猫铃铛')?.kind === 'substring' && matchOne('虎', '大龙猫铃铛') === null);
ok('★ 2 字拉丁缩写不走编辑距离档（否则 b? 遍地都是）', (() => {
  const hit = matchOne('bx', 'Battle Xylophone');
  return hit?.kind === 'subsequence';     // 只在子序列档回答
})(), JSON.stringify(matchOne('bx', 'Battle Xylophone')));

/* ---- 排序与相关性（迷你快照，五档各一条） ---- */

const MINI = {
  categories: [{ id: 1, nameZh: '环境', count: 6 }, { id: 4, nameZh: '战斗', count: 1 }],
  sounds: [
    { id: '10001', nameZh: '环境震动', nameEn: 'Environment Vibration', category: 1, durationMs: 1000 },       // exact
    { id: '10002', nameZh: '环境震动声', nameEn: 'Environment Vibration Sound', category: 1, durationMs: 2000 }, // prefix
    { id: '10003', nameZh: '大风环境震动', nameEn: 'Strong Wind Environment Vibration', category: 1, durationMs: 3000 }, // substring
    { id: '10005', nameZh: '环绕境界震撼动作', nameEn: 'Around Boundary Shake Move', category: 1, durationMs: 5000 }, // subsequence
    { id: '10006', nameZh: '环镜震动', nameEn: 'Mirror Ring Shake', category: 1, durationMs: 6000 },           // editDistance
    { id: '40001', nameZh: '战斗_攻击', nameEn: 'Combat Attack', category: 4, durationMs: 7000 },
  ],
};

const miniRanked = rankSounds(MINI, { tokens: ['环境震动'] });
ok('★ 五档按顺序排开（exact → prefix → substring → subsequence → editDistance）',
  JSON.stringify(miniRanked.map((r) => r.matchKind)) === '["exact","prefix","substring","subsequence","editDistance"]',
  JSON.stringify(miniRanked.map((r) => [r.id, r.matchKind])));
ok('exact 排第一', miniRanked[0].id === '10001');
ok('rankSounds 吃原文关键词（内部幂等归一化）', rankSounds(MINI, { tokens: ['环境_震动'] })[0].id === '10001');
ok('rankSounds 去重重复关键词', rankSounds(MINI, { tokens: ['震动', '震动'] }).length === rankSounds(MINI, { tokens: ['震动'] }).length);
ok('★ score 是整数且同档内降序', miniRanked.every((r) => Number.isInteger(r.score))
  && miniRanked.every((r, i) => i === 0 || miniRanked[i - 1].matchKind !== r.matchKind || miniRanked[i - 1].score >= r.score));
ok('★ 命中位置越靠前分越高（同为子串）', (() => {
  const a = rankSounds(MINI, { tokens: ['震动'] });
  const head = a.find((r) => r.id === '10001');
  const tail = a.find((r) => r.id === '10003');
  return head.score > tail.score;
})());
ok('多关键词 AND：有一个词谁都不命中 ⇒ 整条不出现在结果里', rankSounds(MINI, { tokens: ['环境', '不存在的词'] }).length === 0);
ok('多关键词 AND：两个词命中不同条目的一部分才算命中', (() => {
  const r = rankSounds(MINI, { tokens: ['大风', '震动'] });
  return r.length === 1 && r[0].id === '10003';
})(), JSON.stringify(rankSounds(MINI, { tokens: ['大风', '震动'] }).map((x) => x.id)));
ok('category 过滤生效', rankSounds(MINI, { tokens: ['攻击'], category: 4 }).length === 1
  && rankSounds(MINI, { tokens: ['攻击'], category: 1 }).length === 0);
ok('★ lang 标出命中侧：中文名 / 英文名', (() => {
  const zh = rankSounds(MINI, { tokens: ['环境震动'] })[0];
  const en = rankSounds(MINI, { tokens: ['vibration'] })[0];
  return zh.lang === 'zh' && en.lang === 'en';
})());
ok('★ lang=both：名字里带拉丁字母的（"提示性UI" 两侧都有 "ui"）', (() => {
  const top = searchSounds({ q: 'ui', limit: 1 }).items[0];
  return top.lang === 'both' && /UI/i.test(top.name);
})(), JSON.stringify(searchSounds({ q: 'ui', limit: 1 }).items.map((x) => [x.name, x.lang])));
ok('★ 跨语言 AND：「大风」+「vibration」也能同时命中（一个中文侧一个英文侧）',
  rankSounds(MINI, { tokens: ['大风', 'vibration'] })[0]?.lang === 'both');
ok('rankSounds 对空 tokens 报错（不静默返回全表）', errOf(() => rankSounds(MINI, { tokens: [] })) !== null
  && errOf(() => rankSounds(MINI, { tokens: ['  '] })) !== null);
ok('rankSounds 对坏 catalog 报错', errOf(() => rankSounds({}, { tokens: ['x'] })) !== null);
ok('MATCH_KINDS 五档顺序就是排序优先级', JSON.stringify(MATCH_KINDS) === '["exact","prefix","substring","subsequence","editDistance"]');

/* ---- op 回执（真数据） ---- */

ok('searchSounds 默认 limit 是 20，且带 total / truncated', (() => {
  const r = searchSounds({ q: '攻击' });
  return r.limit === DEFAULT_LIMIT && r.items.length === DEFAULT_LIMIT && r.total > DEFAULT_LIMIT && r.truncated === true;
})());
ok('★ limit 夹紧：0 → 1（并可看出被夹过）', (() => {
  const r = searchSounds({ q: '攻击', limit: 0 });
  return r.limit === 1 && r.limitClamped === true && r.items.length === 1;
})());
ok('★ limit 夹紧：1000 → 100（MAX_LIMIT）', (() => {
  const r = searchSounds({ q: '攻击', limit: 1000 });
  return r.limit === MAX_LIMIT && r.limitClamped === true;
})());
ok('limit 夹紧：负数 → 1', searchSounds({ q: '攻击', limit: -5 }).limit === 1);
ok('limit 非数字 → 报错点名（不是静默用默认值）', errOf(() => searchSounds({ q: '攻击', limit: 'abc' })) !== null);
ok('truncated=false 的条件：命中数 ≤ limit', searchSounds({ q: 'vibration', limit: 10 }).truncated === false);
ok('q 为空 → 报错（不返回全表）', errOf(() => searchSounds({ q: '' })) !== null);
ok('★ category 给错 → 报错并列出合法 id（1 / 2 / … / 7）', (() => {
  const m = errOf(() => searchSounds({ q: '攻击', category: 9 }));
  return m !== null && /1 \/ 2/.test(m) && /7/.test(m);
})(), String(errOf(() => searchSounds({ q: '攻击', category: 9 }))));
ok('category 是字符串数字也认', searchSounds({ q: '攻击', category: '4' }).items.every((x) => x.category === 4));
ok('★ 超长 q（300 字）不崩、给 0 命中', (() => {
  const r = searchSounds({ q: '环'.repeat(300) });
  return r.total === 0 && Array.isArray(r.items) && r.items.length === 0;
})());
ok('summaryOnly 去掉 items，但 total / truncated / categories 一个不少', (() => {
  const r = searchSounds({ q: '攻击', summaryOnly: true });
  return !('items' in r) && r.itemsOmitted === 20 && r.total > 0 && typeof r.truncated === 'boolean' && r.categories.length === 7;
})());
ok('items 每条字段齐（id/name/nameEn/category/durationMs/score/matchKind/lang）', (() => {
  const it = searchSounds({ q: '宝箱', limit: 1 }).items[0];
  return ['id', 'name', 'nameEn', 'category', 'durationMs', 'score', 'matchKind', 'lang']
    .every((k) => Object.prototype.hasOwnProperty.call(it, k));
})());
ok('★ 0 命中时 hint 明说"不支持拼音"（免得 AI 在死路上多试几轮）',
  /拼音/.test(searchSounds({ q: 'zzzzzzzz' }).hint || ''));
ok('★ 最弱档是子序列/编辑距离时挂 weak:true + hint（"这批是凑的"）', (() => {
  const weak = searchSounds({ q: 'bx', limit: 3 });
  const solid = searchSounds({ q: '宝箱', limit: 3 });
  return weak.weak === true && /拼音/.test(weak.hint || '') && solid.weak === false && !solid.hint;
})(), JSON.stringify({ weak: searchSounds({ q: 'bx', limit: 3 }).weak, solid: searchSounds({ q: '宝箱', limit: 3 }).weak }));
ok('★ 真数据：中文名精确命中 → id 10001 排第一且 matchKind=exact',
  searchSounds({ q: '环境_震动', limit: 1 }).items[0].id === '10001'
  && searchSounds({ q: '环境_震动', limit: 1 }).items[0].matchKind === 'exact');
ok('★ 真数据：多关键词 AND「环境 风声」前三条是三条真正的"环境_风声"（substring）', (() => {
  const r = searchSounds({ q: '环境 风声', limit: 10 });
  return r.items.slice(0, 3).map((x) => x.id).join(',') === '10003,10002,10004'
    && r.items.slice(0, 3).every((x) => x.matchKind === 'substring');
})(), JSON.stringify(searchSounds({ q: '环境 风声', limit: 10 }).items.map((x) => [x.id, x.matchKind])));
ok('★ 真数据：编辑距离档的噪声只落在尾部（"循环" 被当作 "环境"），排序把它们压到最后',
  searchSounds({ q: '环境 风声', limit: 20 }).items.slice(3).every((x) => x.matchKind === 'editDistance'));
ok('★ 真数据：英文查询走英文侧（lang=en）', (() => {
  const r = searchSounds({ q: 'vibration', limit: 3 });
  return r.total >= 1 && r.items[0].lang === 'en' && r.items[0].id === '10001';
})());
ok('★ 真数据：「宝箱」第一条是物件_宝箱（子串命中，不是编辑距离凑的）', (() => {
  const r = searchSounds({ q: '宝箱', limit: 3 });
  return r.items[0].name.includes('宝箱') && r.items[0].matchKind === 'substring' && r.items[0].category === 5;
})());
ok('★ 真数据：拼音/缩写确实搜不到（不做假支持）', searchSounds({ q: 'baoxiang' }).total === 0
  && searchSounds({ q: 'gongji' }).total === 0);
ok('★ 真数据：一次全表搜索在 2 秒内（AI 不能等）', (() => {
  const t0 = Date.now();
  searchSounds({ q: 'attack', limit: 5 });
  return Date.now() - t0 < 2000;
})(), '实测 ' + (() => { const t = Date.now(); searchSounds({ q: 'attack', limit: 5 }); return Date.now() - t; })() + 'ms');
ok('回执 categories 是 7 行 {id,name,count}', (() => {
  const cats = searchSounds({ q: '宝箱', limit: 1 }).categories;
  return cats.length === 7 && cats.every((c) => Number.isInteger(c.id) && typeof c.name === 'string' && Number.isInteger(c.count));
})());
ok('回执 catalog 段声明了"离线镜像快照"与时长单位', (() => {
  const c = searchSounds({ q: '宝箱', limit: 1 }).catalog;
  return c.mirror === true && c.durationUnit === 's' && c.soundCount === 1997 && /镜像/.test(String(c.note));
})());

/* ---- op=sound-get ---- */

ok('getSound 命中：给 id 回单条详情（含分类名）', (() => {
  const r = getSound({ id: '10001' });
  return r.found === true && r.sound.id === '10001' && r.sound.name === '环境_震动' && r.sound.categoryName === '环境';
})());
ok('getSound 数字 id 也认（10001）', getSound({ id: 10001 }).found === true);
ok('getSound 未命中：found=false + 原因，不抛错', (() => {
  const r = getSound({ id: '99999' });
  return r.ok === true && r.found === false && /5 位/.test(String(r.hint));
})());
ok('getSound 空 id 报错', errOf(() => getSound({ id: '' })) !== null);

/* ══════════════════════════════════════════════════ ② 数据层 */

const catalog = loadSoundCatalog();
const raw = fs.readFileSync(CATALOG_PATH);
ok('快照无 BOM（前 3 字节不是 EF BB BF）', !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
ok('快照纯 LF（没有 CRLF）', !raw.toString('utf8').includes('\r'));
ok('版本号 == CATALOG_VERSION（' + CATALOG_VERSION + '）', catalog.version === CATALOG_VERSION);
ok('★ 1997 条音效（与 sound-data.json 的 data.length 一致）', catalog.soundCount === 1997 && catalog.sounds.length === 1997,
  'soundCount=' + catalog.soundCount + ' sounds=' + catalog.sounds.length);
ok('★ 分类计数与源数据逐项一致（74/204/149/474/895/96/105）', (() => {
  const want = { 1: 74, 2: 204, 3: 149, 4: 474, 5: 895, 6: 96, 7: 105 };
  return catalog.categories.length === 7 && catalog.categories.every((c) => c.count === want[c.id]);
})(), JSON.stringify(catalog.categories.map((c) => c.id + ':' + c.count)));
ok('分类计数之和 == 1997', catalog.categories.reduce((a, c) => a + c.count, 0) === 1997);
ok('★ 每个分类的 count == 实际条数（计数不是抄来的）', catalog.categories.every((c) => catalog.sounds.filter((s) => s.category === c.id).length === c.count));
ok('7 个分类都有中文名与英文名', catalog.categories.every((c) => typeof c.nameZh === 'string' && c.nameZh && typeof c.nameEn === 'string' && c.nameEn));
ok('★ id 唯一（1997 个不重复）', new Set(catalog.sounds.map((s) => s.id)).size === 1997);
ok('★ 每条都有中文名', catalog.sounds.every((s) => typeof s.nameZh === 'string' && s.nameZh.length > 0));
ok('★ 每条都有英文名', catalog.sounds.every((s) => typeof s.nameEn === 'string' && s.nameEn.length > 0));
ok('★ durationMs 是正整数（毫秒；最小 47ms、最大 106857ms）', catalog.sounds.every((s) => Number.isInteger(s.durationMs) && s.durationMs > 0)
  && Math.min(...catalog.sounds.map((s) => s.durationMs)) === 47
  && Math.max(...catalog.sounds.map((s) => s.durationMs)) === 106857);
ok('★ duration 单位是**秒**：换算口径 toDurationMs("39.862") == 39862', toDurationMs('39.862') === 39862
  && toDurationMs('0.047') === 47 && toDurationMs('106.857') === 106857);
ok('toDurationMs 对垃圾值报错（不静默给 0）', errOf(() => toDurationMs('abc')) !== null && errOf(() => toDurationMs('-1')) !== null);
ok('快照丢掉了 path / nameI18nKey / order（只留 5 个字段）', (() => {
  const keys = Object.keys(catalog.sounds[0]).sort().join(',');
  return keys === 'category,durationMs,id,nameEn,nameZh';
})(), Object.keys(catalog.sounds[0]).sort().join(','));
ok('id 都是 5 位数字（10001…51096）', catalog.sounds.every((s) => /^\d{5}$/.test(s.id))
  && catalog.sounds[0].id === '10001' && catalog.sounds[catalog.sounds.length - 1].id === '51096');

/* ---- id 规律（文档 §4 的那张表） ---- */

ok('★ id 首位 1~4 直接对应分类 1~4', catalog.sounds
  .filter((s) => Number(s.id[0]) <= 4)
  .every((s) => Number(s.id[0]) === s.category));
ok('★ 家族 1~4 各自连续无空洞', [[1, 10001, 10074], [2, 20001, 20204], [3, 30001, 30149], [4, 40001, 40474]]
  .every(([cat, min, max]) => {
    const ids = catalog.sounds.filter((s) => s.category === cat).map((s) => Number(s.id)).sort((a, b) => a - b);
    return ids[0] === min && ids[ids.length - 1] === max && ids.length === max - min + 1;
  }));
ok('★ 家族 5 装三个分类：5/6/7（50001–51096 密度 100%）', (() => {
    const ids = catalog.sounds.map((s) => Number(s.id)).filter((n) => n >= 50000).sort((a, b) => a - b);
    return ids.length === 1096 && ids[0] === 50001 && ids[ids.length - 1] === 51096 && ids.length === 51096 - 50001 + 1;
  })());
ok('★ 家族 5 内分类 6/7 各占一个连续块（50862–50957 / 50958–51062）', (() => {
    const c6 = catalog.sounds.filter((s) => s.category === 6).map((s) => Number(s.id)).sort((a, b) => a - b);
    const c7 = catalog.sounds.filter((s) => s.category === 7).map((s) => Number(s.id)).sort((a, b) => a - b);
    return c6[0] === 50862 && c6[c6.length - 1] === 50957 && c6.length === 96
      && c7[0] === 50958 && c7[c7.length - 1] === 51062 && c7.length === 105;
  })());

/* ---- order 可复原（丢掉 order 字段的前提） ---- */

ok('★ assertOrderRecoverable 承认"分类内 id 升序 == order 升序"（order 才能安全丢掉）', (() => {
  const sample = {
    data: [{ id: '10001', order: 1 }, { id: '10002', order: 2 }, { id: '10004', order: 3 }],
  };
  return assertOrderRecoverable(sample.data, [{ id: '10001', category: 1 }, { id: '10002', category: 1 }, { id: '10004', category: 1 }]) === true;
})());
ok('★ 破坏这条规律时 assertOrderRecoverable 报错（不静默产出信息不全的快照）', errOf(() => assertOrderRecoverable(
  [{ id: '10001', order: 2 }, { id: '10002', order: 1 }],
  [{ id: '10001', category: 1 }, { id: '10002', category: 1 }],
)) !== null);
ok('快照里 order 字段确实不在（展示序由数组顺序 + 分类内 id 升序承载）', catalog.sounds.every((s) => !('order' in s)));

/* ══════════════════════════════════════════════════ ③ 可重放层（镜像在才算） */

console.log('\n--- 可重放层（镜像目录：' + DEFAULT_SRC_DIR + '）');
const mirrorOk = fs.existsSync(path.join(DEFAULT_SRC_DIR, SOUND_SOURCE.files.data));
if (!mirrorOk) {
  console.log('- 跳过镜像比对：没找到 ' + path.join(DEFAULT_SRC_DIR, SOUND_SOURCE.files.data));
  console.log('  （镜像不进仓库；要复现就把 3 个 OSS JSON 放到那儿，或 --src 指到别处。'
    + ' 只跑插件的人看不到这一层是预期的，所以它不算失败。）');
} else {
  ok('★ 源文件哈希与 SOUND_SOURCE.sha256 一致（官方更新会让这里红）', (() => {
    for (const key of ['data', 'zh', 'en']) {
      const buf = fs.readFileSync(path.join(DEFAULT_SRC_DIR, SOUND_SOURCE.files[key]));
      if (crypto.createHash('sha256').update(buf).digest('hex') !== SOUND_SOURCE.sha256[key]) return false;
    }
    return true;
  })());
  const src = readSource(DEFAULT_SRC_DIR);
  ok('readSource 认得三份源（1997 条 / 2004 键词表）', src.data.data.length === 1997
    && Object.keys(src.zh).length === 2004 && Object.keys(src.en).length === 2004);

  const rebuilt = buildCatalog({ data: src.data, zh: src.zh, en: src.en, generatedAt: catalog.generatedAt });
  ok('★ 重建快照与仓库里那份**逐字节一致**（快照 = 生成脚本的产物）',
    serializeCatalog(rebuilt) === raw.toString('utf8'),
    (() => {
      const a = raw.toString('utf8').split('\n');
      const b = serializeCatalog(rebuilt).split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      return i < 0 ? '长度不同' : '第 ' + (i + 1) + ' 行起不同：' + String(a[i]).slice(0, 120) + ' ≠ ' + String(b[i]).slice(0, 120);
    })());
  ok('★ 逐条对账：1997 条的 id/名字/时长与源数据一致（抽样全量）', (() => {
    const zh = src.zh; const en = src.en;
    for (const s of rebuilt.sounds) {
      if (s.nameZh !== zh['soundEffectPlayer.data.' + s.id]) return false;
      if (s.nameEn !== en['soundEffectPlayer.data.' + s.id]) return false;
    }
    const byId = new Map(src.data.data.map((x) => [String(x.id), x]));
    for (const s of rebuilt.sounds) {
      const o = byId.get(s.id);
      if (!o) return false;
      if (s.category !== Number(o.category)) return false;
      if (s.durationMs !== Math.round(Number.parseFloat(o.duration) * 1000)) return false;
    }
    return true;
  })());
  ok('★ 分类名与 zh 词表逐项一致', rebuilt.categories.every((c) => c.nameZh === src.zh['soundEffectPlayer.category.' + c.id]));
  ok('镜像的 path 字段确实可由 id 推出（丢 path 是安全的）', src.data.data.every((x) => x.path === 'audio/' + x.id + '.mp3'));
  ok('giVersion 全是同一个值（丢掉它零损失）', new Set(src.data.data.map((x) => x.giVersion)).size === 1);
}

/* ------------------------------------------------------------------ */

console.log('\n快照：' + path.relative(ROOT, CATALOG_PATH).split(path.sep).join('/')
  + '，' + catalog.soundCount + ' 条 / ' + catalog.categories.length + ' 类 / '
  + (raw.length / 1024).toFixed(1) + ' KB（' + raw.length + ' 字节）'
  + '，generatedAt=' + catalog.generatedAt);
console.log('分类：' + catalog.categories.map((c) => `${c.id} ${c.nameZh}(${c.count})`).join(' / '));

console.log('\n结果：通过 ' + pass + '，失败 ' + failures.length
  + (failures.length ? '：\n  - ' + failures.join('\n  - ') : '（全部通过）'));
process.exit(failures.length ? 1 : 0);
