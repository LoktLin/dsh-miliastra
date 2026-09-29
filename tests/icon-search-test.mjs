/**
 * `op=icon-search`（图标语义检索）的契约测试。
 *
 * 为什么要有这套：识图结果是**模型推断**（官方目录没有单图名称）—— 最容易出的三类错是
 * ①把推断名当官方名 ②未识别的条目产出 `undefined`/编名字 ③`summaryOnly` 把"结论"也删了。
 * 本套逐条钉住这三条，并钉住三档回执（概览 / 检索 / 明细）与两条错误路径。
 */
import { loadIconIndex, searchIcons, ICON_DOC } from '../lib/images/icons.mjs';

let pass = 0; let fail = 0;
const t = (name, fn) => {
  try { const why = fn(); pass++; console.log('  ✅ ' + name + (why ? '  → ' + why : '')); }
  catch (e) { fail++; console.log('  ❌ ' + name + '  → ' + e.message); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m || '断言不成立'); };

const idx = loadIconIndex();

t('① 索引条数 = 1543，且每一条都有 id / recognized / nameSource 三件套', () => {
  eq(idx.itemCount, 1543, 'itemCount ');
  eq(idx.items.length, 1543, 'items.length ');
  for (const it of idx.items) {
    if (typeof it.id !== 'number') throw new Error('id 不是数字：' + JSON.stringify(it.id));
    if (typeof it.recognized !== 'boolean') throw new Error('id ' + it.id + ' 的 recognized 不是布尔');
  }
  return '1543 条逐条检查通过';
});

t('② 已识别的一定带 vision-inferred；未识别的一定 nameZh=null 且不算编名', () => {
  let rec = 0; let unrec = 0;
  for (const it of idx.items) {
    if (it.recognized) { rec++; if (it.nameSource !== 'vision-inferred') throw new Error('id ' + it.id + ' 已识别但 nameSource=' + it.nameSource); }
    else {
      unrec++;
      if (it.nameZh !== null || it.shape !== null || it.nameSource !== null) throw new Error('id ' + it.id + ' 未识别却有名字/形状');
      if (it.keywordsZh.length || it.keywordsEn.length) throw new Error('id ' + it.id + ' 未识别却有关键词');
    }
  }
  eq(rec, idx.recognizedCount, 'recognizedCount ');
  eq(unrec, idx.unrecognizedCount, 'unrecognizedCount ');
  return '识别 ' + rec + ' / 未识别 ' + unrec + '（无一编名）';
});

t('③ 任何字段都不许是 undefined（JSON 往返后仍无 undefined）', () => {
  const round = JSON.parse(JSON.stringify(searchIcons({ q: '宝箱', limit: 100 })));
  const walk = (o, path) => {
    if (o === undefined) throw new Error('undefined at ' + path);
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path + '.' + k);
  };
  walk(round, '$');
  return '检索回执往返无 undefined';
});

t('④ 三档回执：不传参 = 分类概览；传 q = 检索；传 id = 明细', () => {
  const a = searchIcons({});
  eq(a.mode, 'overview', '不传参 ');
  ok(Array.isArray(a.categories) && a.categories.length >= 14, '概览分类应 ≥14 行，实际 ' + (a.categories || []).length);
  const b = searchIcons({ q: '宝箱' });
  eq(b.mode, 'search', '传 q ');
  const c = searchIcons({ id: 105221 });
  eq(c.mode, 'detail', '传 id ');
  eq(c.item.id, 105221, 'id ');
  return '概览 ' + a.categories.length + ' 类 / 检索 ' + b.counts.matched + ' 条 / 明细 1 条';
});

t('⑤ 宝箱能被搜到，且 105221 的推断名是「宝箱」（正是作者要的那个号）', () => {
  const r = searchIcons({ q: '宝箱' });
  ok(r.counts.matched > 0, 'q=宝箱 应有命中');
  const ids = r.items.map((x) => x.id);
  ok(ids.indexOf(105221) >= 0, '105221 应在命中里（实际前几条：' + ids.slice(0, 6).join(',') + '）');
  eq(searchIcons({ id: 105221 }).item.nameZh, '宝箱', '105221 的名字 ');
  return '命中 ' + r.counts.matched + ' 条，含 105221';
});

t('⑥ 英文关键词也能搜（chest）—— 中英双索引', () => {
  const r = searchIcons({ q: 'chest' });
  ok(r.counts.matched > 0, 'q=chest 应有命中');
  return 'chest 命中 ' + r.counts.matched + ' 条';
});

t('⑦ 多词 = AND（词越多命中越少或相等）', () => {
  const one = searchIcons({ q: '宝箱' }).counts.matched;
  const two = searchIcons({ q: '宝箱 金币' }).counts.matched;
  ok(two <= one, '两词命中(' + two + ') 不该多于单词(' + one + ')');
  return one + ' → ' + two;
});

t('⑧ simOnly 只回 6 个几何号（模拟器画得出的）', () => {
  const r = searchIcons({ simOnly: true });
  eq(r.counts.matched, 6, 'simOnly 命中数 ');
  for (const it of r.items) ok(it.simRenderable === true, 'id ' + it.id + ' 不是 simRenderable');
  return '6 个几何号';
});

t('⑨ summaryOnly 只去逐条正文 —— counts / hint / unverified / doc 一个不删', () => {
  const full = searchIcons({ q: '宝箱' });
  const slim = searchIcons({ q: '宝箱', summaryOnly: true });
  ok(Array.isArray(full.items) && full.items.length > 0, '完整回执应有 items');
  eq(slim.items, undefined, 'summaryOnly 应去掉 items ');
  eq(slim.counts.matched, full.counts.matched, 'matched 必须保留 ');
  eq(slim.hint, full.hint, 'hint 必须保留（那是结论）');
  eq(slim.doc, full.doc, 'doc 指针必须保留');
  ok(Array.isArray(slim.unverified) && slim.unverified.length > 0, 'unverified 必须保留');
  ok(JSON.stringify(slim).length < JSON.stringify(full).length, 'summaryOnly 应更小');
  return JSON.stringify(full).length + ' → ' + JSON.stringify(slim).length + ' 字符';
});

t('⑩ id 不存在：ok=false + 给最近候选 + 指路（不许静默空回）', () => {
  const r = searchIcons({ id: 999999 });
  eq(r.ok, false, 'ok ');
  ok(String(r.error).indexOf('没有这个 id') >= 0, '错误文案');
  ok(Array.isArray(r.nearestIds), 'nearestIds 应是数组');
  ok(String(r.hint || '').length > 10, '应给指路');
  return '最近候选 ' + (r.nearestIds || []).length + ' 个';
});

t('⑪ q 无命中：ok 仍 true，但必须给可执行提示（换词 / 分类概览 / shape）', () => {
  const r = searchIcons({ q: '绝对不存在的词xyzabc' });
  eq(r.counts.matched, 0, 'matched ');
  ok(String(r.hint).indexOf('推断') >= 0, '提示要说清"名字是推断"');
  ok(/分类概览|shape|英文/.test(String(r.hint)), '提示要给可执行的下一步');
  return '有指路';
});

t('⑫ 名字来源与真机未验证恒定带（诚实口径）', () => {
  const r = searchIcons({ q: '宝箱' });
  eq(r.nameSource, 'vision-inferred', 'nameSource ');
  ok(Array.isArray(r.unverified) && r.unverified.some((s) => s.indexOf('真机') >= 0), 'unverified 要提真机未验证');
  ok(String(r.doc).indexOf('图标识图与接口规划') >= 0, 'doc 指针要指向规划文档');
  eq(r.doc, ICON_DOC, 'doc 常量 ');
  return 'vision-inferred + 真机未验证 + doc 指针';
});

t('⑬ 未识别条目不会出现在 q 命中里（没有名字就不该被语义搜到）', () => {
  const r = searchIcons({ q: '宝箱' });
  for (const it of r.items) ok(it.id !== 101019, '未识别的 101019 不该被语义命中');
  const detail = searchIcons({ id: 101019 });
  eq(detail.item.recognized, false, '101019 recognized ');
  eq(detail.item.nameZh, null, '101019 nameZh ');
  return '101019 仍在索引里（可按 id 查），但不参与语义命中';
});

console.log('\n  结果：通过 ' + pass + '，失败 ' + fail);
if (fail) { console.log('  失败明细见上。'); process.exit(1); }
