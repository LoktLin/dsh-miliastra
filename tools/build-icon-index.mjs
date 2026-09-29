// 把「目录事实 + 本地像素 + 视觉识别」三源合并成 lib/images/icons.json
// 三源各管一轴（诚实口径）：目录=id/分类/有没有图 ｜ 像素=颜色/透明/近似单色 ｜ 视觉=形状/名字/关键词/置信度
// 纪律：字段名以实际文件为准；**任一 id 缺 id 就报错**，不静默产出残缺记录
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.MILIASTRA_WORKSPACE || 'C:/Users/Administrator/Desktop/yuanshen'; // 工作区根（可用环境变量覆盖）
const PLUGIN = path.join(ROOT, 'packages/dsh-miliastra');
const PIX = path.join(process.env.TEMP || 'C:/Users/Administrator/AppData/Local/Temp', 'ugc-icons/pixels.json');
const RECDIR = path.join(ROOT, 'tmp/ugc-icons-out');
const CAT = path.join(PLUGIN, 'lib/images/catalog.json');
const OUT = path.join(PLUGIN, 'lib/images/icons.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const problems = [];

// ① 像素（1543）
const pix = readJson(PIX);
const pixById = new Map();
for (const e of pix.entries || []) {
  if (!e || e.id == null) { problems.push('pixels 条目缺 id'); continue; }
  pixById.set(String(e.id), e);
}

// ② 目录（1543）—— ⚠️ `items` 是**位置数组**，按它自己的 `itemFields` 解码：
//    [id, categoryId, flags, colorKindCode]；flags 位掩码见 flagBits（bit0=imgExists、bit1=simRenderable）
const cat = readJson(CAT);
const CK = cat.colorKindCodes || [];
const catNameById = new Map((cat.categories || []).map((c) => [String(c.id), c.nameZh]));
const catById = new Map();
for (const row of cat.items || []) {
  if (!Array.isArray(row) || row.length < 4) { problems.push('catalog 条目不是 4 元组：' + JSON.stringify(row).slice(0, 60)); continue; }
  const [id, categoryId, flags, ck] = row;
  catById.set(String(id), {
    id, categoryId,
    imgExists: (flags & 1) === 1,
    simRenderable: (flags & 2) === 2,
    colorKind: CK[ck] || null,
  });
}

// ③ 视觉识别（22 份 / 1422 条）
const recById = new Map();
let recFiles = 0;
for (const f of fs.readdirSync(RECDIR).filter((n) => n.endsWith('.json'))) {
  const j = readJson(path.join(RECDIR, f));
  recFiles++;
  for (const it of j.items || []) {
    if (it == null || it.id == null) { problems.push(f + ' 有条目缺 id'); continue; }
    recById.set(String(it.id), {
      nameZh: it.nameZh == null ? null : String(it.nameZh),
      nameEn: it.nameEn == null ? null : String(it.nameEn),
      shape: it.shape == null ? null : String(it.shape),
      keywordsZh: Array.isArray(it.keywordsZh) ? it.keywordsZh.filter((x) => typeof x === 'string' && x) : [],
      keywordsEn: Array.isArray(it.keywordsEn) ? it.keywordsEn.filter((x) => typeof x === 'string' && x) : [],
      confidence: typeof it.confidence === 'number' ? it.confidence : null,
      sheet: j.sheet, categoryId: j.categoryId == null ? null : j.categoryId, categoryNameZh: j.categoryNameZh || null,
    });
  }
}

// ④ 合并：以「像素 ∪ 目录」为全集（= 1543，含 21 条无图）
const allIds = [...new Set([...pixById.keys(), ...catById.keys()])].map(Number).sort((a, b) => a - b);
const items = allIds.map((numId) => {
  const id = String(numId);
  const p = pixById.get(id) || null;
  const c = catById.get(id) || null;
  const r = recById.get(id) || null;
  const w = p && Number.isFinite(p.w) ? p.w : null;
  const h = p && Number.isFinite(p.h) ? p.h : null;
  return {
    id: numId,
    categoryId: (c && c.categoryId != null ? c.categoryId : (p && p.categoryId != null ? Number(p.categoryId) : null)),
    categoryNameZh: (c && catNameById.get(String(c.categoryId))) || (p && p.categoryNameZh) || null,
    imgExists: c ? c.imgExists : (w != null && h != null && w > 0 && h > 0),
    simRenderable: c ? c.simRenderable : (numId >= 100001 && numId <= 100006),
    recognized: !!r,
    shape: r ? r.shape : null,
    nameZh: r ? r.nameZh : null,
    nameEn: r ? r.nameEn : null,
    keywordsZh: r ? r.keywordsZh : [],
    keywordsEn: r ? r.keywordsEn : [],
    confidence: r ? r.confidence : null,
    nameSource: r ? 'vision-inferred' : null,
    colorKind: (c && c.colorKind) || null,
    defaultColor: (p && p.dominantHex) || null,
    pixels: p ? {
      w, h,
      transparentRatio: p.transparentRatio == null ? null : p.transparentRatio,
      nearWhiteRatio: p.nearWhiteRatio == null ? null : p.nearWhiteRatio,
      isApproxMono: p.isApproxMono === true,
      alphaOnlyWhite: p.alphaOnlyWhite === true,
      dominantCoverage: p.dominantCoverage == null ? null : p.dominantCoverage,
      chromaticRatio: p.chromaticRatio == null ? null : p.chromaticRatio,
      visiblePixels: p.visiblePixels == null ? null : p.visiblePixels,
    } : null,
  };
});

if (problems.length) {
  console.log('  ✗ 有问题，未写盘：\n    - ' + problems.slice(0, 8).join('\n    - '));
  process.exit(1);
}

const stat = (f) => items.filter(f).length;
const out = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  source: '平台图片资源库目录（事实）+ 本地像素分析（颜色）+ 视觉识别结果（形状/名字/关键词，模型 mimo-v2.6-flash 推断）',
  nameNote: '⚠️ 官方目录**没有单图名称** —— nameZh/nameEn/keywords* 全部是**模型识图推断**（nameSource:"vision-inferred"），带 confidence，不要当官方名。',
  fields: 'id/categoryId/categoryNameZh/imgExists/simRenderable/recognized/shape/nameZh/nameEn/keywordsZh/keywordsEn/confidence/nameSource/colorKind/defaultColor/pixels',
  itemCount: items.length,
  recognizedCount: stat((x) => x.recognized),
  unrecognizedCount: stat((x) => !x.recognized),
  lowConfidenceCount: stat((x) => x.confidence != null && x.confidence < 0.5),
  emptyImgCount: stat((x) => !x.imgExists),
  simRenderableCount: stat((x) => x.simRenderable),
  idRange: [items[0].id, items[items.length - 1].id],
  items,
};
fs.writeFileSync(OUT, JSON.stringify(out) + '\n', 'utf8');
const b = fs.statSync(OUT).size;
console.log('  写盘: ' + OUT);
console.log('  体积 = ' + (b / 1024 / 1024).toFixed(2) + ' MB（' + b + ' B）');
console.log('  条数 = ' + out.itemCount + '（识别 ' + out.recognizedCount + ' / 未识别 ' + out.unrecognizedCount + ' / 低置信 ' + out.lowConfidenceCount + '）');
console.log('  无图 = ' + out.emptyImgCount + '　模拟器可画 = ' + out.simRenderableCount);
console.log('  识别来源 = ' + recFiles + ' 份 sheet 文件');
const s = items.find((x) => x.id === 108010);
console.log('  抽查 108010: ' + JSON.stringify({ nameZh: s.nameZh, shape: (s.shape || '').slice(0, 20), conf: s.confidence, color: s.defaultColor, recognized: s.recognized }));
const s2 = items.find((x) => x.id === 105221);
console.log('  抽查 105221: ' + JSON.stringify({ nameZh: s2.nameZh, conf: s2.confidence, color: s2.defaultColor }));
const s3 = items.find((x) => x.recognized === false);
console.log('  抽查未识别: ' + JSON.stringify({ id: s3.id, recognized: s3.recognized, nameZh: s3.nameZh, imgExists: s3.imgExists }));
