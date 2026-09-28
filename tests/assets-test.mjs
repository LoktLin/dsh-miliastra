/**
 * `lib/assets.mjs`（插件级素材库）+ `miliastra_asset` 工具的自测。
 *
 * 分三层（与 `tests/shot-test.mjs` 同一套路子）：
 *   ① **纯函数**：`id` 命名 / 扩展名白名单 / 路径穿越 / `data:` URL 解析 / 标签归一化；
 *   ② **IO**：在**临时数据目录**里真加真取（`MILIASTRA_DATA_DIR` 指到 tmp，跑完删干净，
 *      不碰用户真实的 `~/.dsh/miliastra/assets/`）；
 *   ③ **工具层**：从 `TOOLS` 里拿 `miliastra_asset` 直接 `execute`，确认接线对、形状稳。
 *
 * 每条都写清「**修之前为什么红**」—— 断言的价值在于**将来某次改动时能重新变红**：
 *   · 「加进去再取出来逐字节一致」：修前（还没有内容寻址时）"存了但取回来是别的图"是**静默**的
 *     —— 只比长度、或者只信索引里的 `bytes`，都不算证据；这里比 **sha256**。
 *   · 「同内容去重」：不去重时同一个素材存 N 份，`stats` 的总体积会骗人（磁盘占用与"库里有几张图"脱钩）。
 *   · 「0 字节 / 超限拒绝」：不拦的话库里会攒出打不开的空图，以及一次把内存撑爆的巨文件。
 *   · 「索引丢了 rebuild」：索引一旦被手删/写坏，**没有 rebuild 就等于素材全丢**（磁盘上还有字节，但没人认识它）。
 *   · 「remove 必须显式」：`remove` 最容易变成"顺手全删"；这里钉住「不给 confirm 一个字都不动」。
 *   · 「`../` 被拒」：`path.basename('..')` 恰好就是 `'..'` —— 不显式挡就会读到素材目录外。
 *   · 「index.json 是原子写且无 BOM」：裸写会留下半截 JSON；带 BOM 的 JSON 会被别的解析器当成坏文件。
 *
 * 用法：`node tests/assets-test.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* ⚠️ `MILIASTRA_DATA_DIR` 必须在 import **之前**设好（`index.js` 是启动快照），所以下面全用动态 import。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-assets-'));
const savedData = process.env.MILIASTRA_DATA_DIR;
process.env.MILIASTRA_DATA_DIR = path.join(tmpRoot, 'data');

const A = await import('../lib/assets.mjs');
const { TOOLS } = await import('../index.js');

const DATA = process.env.MILIASTRA_DATA_DIR;
const DIR = A.assetsDir();
const INDEX = A.assetIndexPath(DIR);

let pass = 0;
const failures = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log('✅ ' + label + (detail ? '  → ' + detail : ''));
  } catch (e) {
    failures.push(label + ': ' + (e && e.message));
    console.log('❌ ' + label + '  → ' + (e && e.message));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
/** 造一段**确定的**假 PNG 字节（可指定长度，用于"同内容/不同内容"两组）。 */
function fakePng(tag, n = 256) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(n, 0);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 31 + tag.charCodeAt(0)) & 0xff;
  return Buffer.concat([head, body]);
}
/** 在临时目录里写一个输入文件（模拟"从磁盘上的一张图入库"）。 */
function tmpFile(name, buf) {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, buf);
  return p;
}

console.log('临时数据目录：' + DATA);
console.log('素材目录：' + DIR);
console.log('');

/* ══════════════════════════════ ① 纯函数 */

await check('id = sha256 前 16 位；长度与常量一致（防碰撞的理由写在 lib/assets.mjs 文件头）', () => {
  const s = sha(Buffer.from('x'));
  const id = A.assetIdOf(s);
  assert(A.ASSET_ID_LEN === 16, 'ASSET_ID_LEN 应为 16');
  assert(id === s.slice(0, 16), id + ' != ' + s.slice(0, 16));
  assert(/^[0-9a-f]{16}$/.test(id), 'id 不是 16 位十六进制：' + id);
  // 大写的完整 sha256 也要能认（便利：从别处复制的哈希）
  assert(A.assetIdOf(s.toUpperCase()) === id, '大写 sha256 没被归一化');
  let threw = null;
  try { A.assetIdOf('不是哈希'); } catch (e) { threw = e; }
  assert(threw, '非法 sha256 应当抛错（拒绝按"前 16 位"瞎截）');
  return 'id=' + id + '（ASSET_ID_LEN=16 / 64bit）';
});

await check('扩展名白名单：只收图片，其余明确拒绝并列出支持项', () => {
  assert(A.normalizeExt('PNG') === '.png', '大写没归一化');
  assert(A.normalizeExt('.jpeg') === '.jpeg', '带点的输入该原样归一: ' + A.normalizeExt('.jpeg'));
  let e1 = null;
  try { A.normalizeExt('.exe'); } catch (e) { e1 = e; }
  assert(e1 && /不支持的素材类型/.test(e1.message), '非图片扩展名应当拒绝');
  assert(/\.png/.test(e1.message), '拒绝时要列出支持的扩展名');
  return Object.keys(A.ASSET_EXT_MIME).join(' ');
});

await check('★ 路径穿越被拒：`../` 与 `..\\`（`path.basename("..")` 恰好就是 `".."`）', () => {
  for (const bad of ['../evil.png', '..\\evil.png', '..', '.', 'a/b.png', 'a\\b.png', '', '   ']) {
    const r = A.safeJoin(DIR, bad);
    assert(r.ok === false, 'safeJoin 竟然放过了 ' + JSON.stringify(bad));
  }
  // 合法的内容寻址名要放过，并且**落在素材目录里**
  const good = A.safeJoin(DIR, 'a1b2c3d4e5f60718.png');
  assert(good.ok === true, '合法名字被拒了：' + JSON.stringify(good));
  assert(path.dirname(good.path) === path.resolve(DIR), '解析结果不在素材目录内：' + good.path);
  // 自由命名的文件不许走「内容寻址」那条路（否则等于开了个任意文件接口）
  const r2 = A.resolveAssetFile(DIR, 'index.json');
  assert(r2.ok === false, 'resolveAssetFile 竟然认了 index.json');
  assert(A.resolveAssetFile(DIR, 'a1b2c3d4e5f60718.png').ok === true, '合法内容寻址名被拒');
  return '7 个穿越写法全拒；内容寻址名放行；index.json 不走这条道';
});

await check('`data:` URL 解析：只认 base64；MIME → 扩展名；百分号编码明确拒绝', () => {
  const png = fakePng('d');
  const ok = A.parseDataUrl('data:image/png;base64,' + png.toString('base64'));
  assert(ok.ok === true, '合法 data URL 被拒：' + JSON.stringify(ok));
  assert(ok.ext === '.png' && ok.mime === 'image/png', JSON.stringify({ ext: ok.ext, mime: ok.mime }));
  const notB64 = A.parseDataUrl('data:image/png,abc');
  assert(notB64.ok === false && /只支持 base64/.test(notB64.error), '非 base64 的 data URL 应当拒绝');
  const junk = A.parseDataUrl('https://example.com/a.png');
  assert(junk.ok === false, '非 data URL 应当拒绝');
  assert(A.extOfMime('image/jpeg') === '.jpg', 'MIME 反查失败');
  assert(A.extOfMime('image/whatever') === null, '不认识的 MIME 应当给 null 而不是瞎猜');
  return 'image/png→.png，image/jpeg→.jpg，其余 null';
});

await check('标签归一化：逗号/数组都收、去重保序、去空白、有上限', () => {
  assert(JSON.stringify(A.normalizeTags('背景, 像素画 ,背景')) === JSON.stringify(['背景', '像素画']),
    JSON.stringify(A.normalizeTags('背景, 像素画 ,背景')));
  assert(JSON.stringify(A.normalizeTags(['a', '', ' a '])) === JSON.stringify(['a']), '数组入参要能去重');
  assert(A.normalizeTags(null).length === 0 && A.normalizeTags('').length === 0, '空值给空数组');
  assert(A.normalizeTags(Array.from({ length: 100 }, (_, i) => 't' + i)).length === 32, '标签数量没有上限');
  return '去重保序 + 上限 32';
});

await check('humanBytes：B / KB / MB 三档都能读', () => {
  assert(A.humanBytes(512) === '512 B', A.humanBytes(512));
  assert(A.humanBytes(2048) === '2.00 KB', A.humanBytes(2048));
  assert(A.humanBytes(64 * 1024 * 1024) === '64.00 MB', A.humanBytes(64 * 1024 * 1024));
  return '512 B / 2.00 KB / 64.00 MB';
});

/* ══════════════════════════════ ② IO：加 → 列 → 取（逐字节一致） */

await check('★ 加 → 列 → 取：**逐字节一致**（比 sha256，不只比长度）', () => {
  const buf = fakePng('A', 1024);
  const src = tmpFile('背景图.png', buf);
  const add = A.addAsset({ source: src, tags: '背景,像素画' });
  assert(add.ok === true, 'add 失败：' + add.error);
  assert(add.deduped === false, '首次加入不该是 deduped');
  assert(add.asset.sha256 === sha(buf), '索引里的 sha256 与源文件不符');
  assert(add.asset.id === sha(buf).slice(0, 16), 'id 不是 sha256 前 16 位');
  assert(add.asset.bytes === buf.length, 'bytes 不对');
  assert(add.asset.ext === '.png' && add.asset.mime === 'image/png', 'ext/mime 不对');
  assert(add.asset.name === '背景图.png', '展示用原始文件名没记下：' + add.asset.name);
  assert(add.asset.source === path.resolve(src), 'source 没记绝对路径：' + add.asset.source);
  assert(typeof add.asset.addedAt === 'string' && !Number.isNaN(Date.parse(add.asset.addedAt)), 'addedAt 不是时间');
  assert(JSON.stringify(add.asset.tags) === JSON.stringify(['背景', '像素画']), JSON.stringify(add.asset.tags));
  // 文件名必须是**内容寻址**的
  assert(path.basename(add.file) === add.asset.id + '.png', '落盘文件名不是内容寻址：' + path.basename(add.file));
  assert(fs.existsSync(add.file), '素材文件没落盘：' + add.file);

  const list = A.listAssets({});
  assert(list.total === 1, 'list 总数不对：' + list.total);
  assert(list.assets[0].id === add.asset.id, 'list 里的 id 不对');
  assert(list.assets[0].fileExists === true, 'list 没标出 fileExists');

  const got = A.getAsset({ id: add.asset.id });
  assert(got.ok === true, 'get 失败：' + got.error);
  assert(got.sha256Match === true, 'get 没确认 sha256 一致');
  const back = Buffer.from(String(got.dataUrl).split(',')[1], 'base64');
  assert(sha(back) === sha(buf), '取回来的字节与加进去的不一致！');
  assert(back.equals(buf), '逐字节比较也不同');
  return buf.length + ' B → id=' + add.asset.id + '，取回 sha256 一致';
});

await check('★ 同内容去重：再加一次不重复落盘，回执 `deduped:true`', () => {
  const buf = fakePng('A', 1024);
  const other = tmpFile('同一张图改个名.png', buf);
  const again = A.addAsset({ source: other });
  assert(again.ok === true, 'add 失败：' + again.error);
  assert(again.deduped === true, '同内容没有命中已有记录');
  assert(again.asset.id === A.assetIdOf(sha(buf)), '命中的不是同一条');
  // 目录里只有 1 个素材文件（没多出一份）
  const files = fs.readdirSync(DIR).filter((n) => /^[0-9a-f]{16}\./.test(n));
  assert(files.length === 1, '去重后目录里竟然有 ' + files.length + ' 个素材文件：' + files.join(','));
  const j = readJson(INDEX);
  assert(j.assets.length === 1, '索引里有 ' + j.assets.length + ' 条（应当 1 条）');
  return '第二次 add：deduped=true，磁盘仍是 1 个文件、索引 1 条';
});

await check('去重时**新标签会并进已有记录**（顺手打的标签不该丢）', () => {
  const buf = fakePng('A', 1024);
  const r = A.addAsset({ source: tmpFile('再来一次.png', buf), tags: '第三批' });
  assert(r.ok === true && r.deduped === true, '没命中去重');
  assert(JSON.stringify(r.tagsAdded) === JSON.stringify(['第三批']), JSON.stringify(r.tagsAdded));
  assert(r.asset.tags.includes('第三批') && r.asset.tags.includes('背景'), JSON.stringify(r.asset.tags));
  const list = A.listAssets({ tag: '第三批' });
  assert(list.total === 1, '按新标签过滤没命中');
  return 'tags=' + r.asset.tags.join('/');
});

await check('★ 拒绝 0 字节（空素材没有任何意义）—— 路径与 base64 两条路都拦', () => {
  const empty = tmpFile('空.png', Buffer.alloc(0));
  const r1 = A.addAsset({ source: empty });
  assert(r1.ok === false && /0 字节/.test(r1.error), '路径入的 0 字节没被拒：' + JSON.stringify(r1));
  const r2 = A.addAsset({ base64: '', name: '空.png' });
  assert(r2.ok === false, '空 base64 没被拒');
  const r3 = A.addAsset({ base64: Buffer.alloc(0).toString('base64'), name: '空.png' });
  assert(r3.ok === false && /0 字节/.test(r3.error), 'base64 解出 0 字节没被拒：' + JSON.stringify(r3));
  return 'source / base64 两条路都拒';
});

await check('★ 拒绝超限（>64 MiB）：**先看 stat，不把巨文件读进内存**', () => {
  const p = tmpFile('巨大.png', fakePng('H', 64));
  const realStat = fs.statSync;
  fs.statSync = (target, ...rest) => {
    const st = realStat(target, ...rest);
    if (path.resolve(String(target)) === path.resolve(p)) return { ...st, size: A.ASSET_MAX_BYTES + 1, isFile: () => true };
    return st;
  };
  let r;
  try { r = A.addAsset({ source: p }); } finally { fs.statSync = realStat; }
  assert(r.ok === false, '超限竟然被放行');
  assert(/超过上限/.test(r.error), '超限的报错没说清原因：' + r.error);
  assert(new RegExp(String(A.ASSET_MAX_BYTES)).test(r.error), '报错里没有上限数值：' + r.error);
  return '64 MiB + 1 B 被拒（报错含实际上限 ' + A.ASSET_MAX_BYTES + '）';
});

await check('★ base64 路径也按字符数先挡一道（避免为巨串分配内存）', () => {
  const huge = Buffer.alloc(A.ASSET_MAX_BYTES + 1024, 1).toString('base64');
  const r = A.addAsset({ base64: huge, name: 'x.png' });
  assert(r.ok === false && /过大|超过上限/.test(r.error), '超大 base64 没被拒：' + JSON.stringify(r).slice(0, 200));
  return '约 ' + Math.round(huge.length / 1024 / 1024) + ' MB 的 base64 被拒';
});

await check('base64 入参：认不出类型时**明确要 name**，不瞎猜', () => {
  const buf = fakePng('B', 64);
  const noName = A.addAsset({ base64: buf.toString('base64') });
  assert(noName.ok === false && /认不出图片类型/.test(noName.error), '裸 base64 没要 name：' + JSON.stringify(noName));
  const withName = A.addAsset({ base64: buf.toString('base64'), name: '像素画.png' });
  assert(withName.ok === true, '给了 name 还是失败：' + withName.error);
  assert(withName.asset.ext === '.png' && withName.asset.name === '像素画.png', JSON.stringify(withName.asset));
  assert(withName.asset.source === 'base64', 'base64 入参的 source 该标成 base64：' + withName.asset.source);
  return 'name=像素画.png → ext=.png';
});

await check('data URL 入参：mime 直接定类型，source 记成 base64:image/png', () => {
  const buf = fakePng('C', 64);
  const r = A.addAsset({ source: 'data:image/png;base64,' + buf.toString('base64') });
  assert(r.ok === true, 'data URL 入参失败：' + r.error);
  assert(r.asset.ext === '.png' && r.asset.mime === 'image/png', JSON.stringify(r.asset));
  assert(r.asset.source === 'base64:image/png', r.asset.source);
  return 'source=' + r.asset.source;
});

await check('source / base64 同时给 → 明确拒绝（不猜以哪个为准）', () => {
  const r = A.addAsset({ source: tmpFile('both.png', fakePng('E', 32)), base64: 'AAAA' });
  assert(r.ok === false && /只能给一个/.test(r.error), JSON.stringify(r));
  return '拒绝并说清原因';
});

await check('相对路径的 source 明确拒绝（避免"以为在别处、其实写在工作目录"）', () => {
  const r = A.addAsset({ source: '相对目录/a.png' });
  assert(r.ok === false && /绝对路径/.test(r.error), JSON.stringify(r));
  return r.error.slice(0, 40) + '…';
});

/* ══════════════════════════════ ② IO：get 写出 / 不覆盖 */

await check('get 写 `out`：逐字节一致；**已存在默认不覆盖**；overwrite:true 才盖', () => {
  const buf = fakePng('F', 512);
  const add = A.addAsset({ source: tmpFile('写出源.png', buf) });
  assert(add.ok === true, add.error);
  const out = path.join(tmpRoot, 'out', '导出.png');
  const r1 = A.getAsset({ id: add.asset.id, out });
  assert(r1.ok === true, '写 out 失败：' + r1.error);
  assert(r1.dataUrl === undefined, '给了 out 就不该再回 dataUrl（省体积）');
  assert(fs.readFileSync(out).equals(buf), '写出去的文件与源不一致');
  // 再来一次：目标已存在 ⇒ 拒绝
  fs.writeFileSync(out, '别人的内容');
  const r2 = A.getAsset({ id: add.asset.id, out });
  assert(r2.ok === false && /不覆盖/.test(r2.error), '已存在的目标被覆盖了！' + JSON.stringify(r2).slice(0, 160));
  assert(fs.readFileSync(out, 'utf8') === '别人的内容', '拒绝之后目标还是被改了');
  const r3 = A.getAsset({ id: add.asset.id, out, overwrite: true });
  assert(r3.ok === true, 'overwrite:true 也没盖上：' + r3.error);
  assert(fs.readFileSync(out).equals(buf), '盖上之后内容不对');
  const r4 = A.getAsset({ id: add.asset.id, out: '相对/out.png' });
  assert(r4.ok === false && /绝对路径/.test(r4.error), 'out 相对路径没被拒');
  return '写→拒覆盖→overwrite 盖上，三次都对';
});

await check('get 认**唯一前缀**；前缀命中多条就报候选、不猜', () => {
  const list = A.listAssets({});
  const id = list.assets[0].id;
  const byPrefix = A.getAsset({ id: id.slice(0, 8) });
  assert(byPrefix.ok === true, '唯一前缀没认出来：' + byPrefix.error);
  assert(byPrefix.resolvedBy === 'prefix', 'resolvedBy 该是 prefix：' + byPrefix.resolvedBy);
  assert(A.getAsset({ id: 'zzzz' }).ok === false, '非法 id 应当报错');
  assert(A.getAsset({ id: 'ffffffffffffffff' }).ok === false, '不存在的 id 应当报错');
  return 'id.slice(0,8) → resolvedBy=prefix';
});

await check('★ `../` 从工具参数进来也读不到素材目录外（路径穿越的第二道门）', () => {
  const secret = path.join(tmpRoot, 'secret.png');
  fs.writeFileSync(secret, fakePng('S', 16));
  // 用 resolveAssetFile 模拟"工具收了个 name"这条路
  const r = A.resolveAssetFile(DIR, '../secret.png');
  assert(r.ok === false, '竟然解析到素材目录外：' + JSON.stringify(r));
  // id 里塞分隔符也不行
  const r2 = A.getAsset({ id: '../secret' });
  assert(r2.ok === false, 'get 的 id 竟然带路径也能用：' + JSON.stringify(r2).slice(0, 120));
  return 'resolveAssetFile / get 两道都拒';
});

/* ══════════════════════════════ ② IO：索引是缓存（rebuild） */

await check('★ 索引缺失时 `rebuild` 从**目录内容**重建（每个文件的 sha256 现算）', () => {
  const before = A.listAssets({});
  assert(before.total >= 3, '前置素材不足：' + before.total);
  const files = fs.readdirSync(DIR).filter((n) => /^[0-9a-f]{16}\./.test(n));
  assert(files.length >= 3, '目录里的素材文件不足：' + files.length);
  // 索引"丢了"（模拟：被手删 / 被写坏）
  fs.rmSync(INDEX);
  const broken = A.listAssets({});
  assert(broken.total === 0, '索引删了竟然还能列出 ' + broken.total + ' 条');
  assert(broken.indexExists === false, 'indexExists 该是 false');
  assert(broken.hint && /重建|rebuild/.test(broken.hint), '索引缺失时该指路 rebuild：' + broken.hint);
  const r = A.rebuildIndex({});
  assert(r.ok === true, 'rebuild 失败');
  assert(r.scanned === files.length, 'rebuild 扫到的文件数不对：' + r.scanned + ' vs ' + files.length);
  assert(r.records === files.length, 'rebuild 出的记录数不对：' + r.records);
  const after = A.listAssets({});
  assert(after.total === files.length, 'rebuild 后 list 总数不对：' + after.total);
  // 每个 id 都要与其**文件内容**的 sha256 对得上（不是照抄文件名）
  for (const a of after.assets) {
    const buf = fs.readFileSync(path.join(DIR, a.id + a.ext));
    assert(a.sha256 === sha(buf), a.id + ' 的 sha256 与文件内容不符');
  }
  // 说明不了的字段如实 null，不编
  assert(after.assets.every((a) => a.name === null || typeof a.name === 'string'), 'name 不是 string|null');
  assert(r.note && /null/.test(r.note), 'rebuild 的说明该点明"说明不了的标 null"');
  // 第二次 rebuild 是幂等的（同输入同结果）
  const again = A.rebuildIndex({});
  assert(again.records === r.records, 'rebuild 不幂等：' + again.records + ' vs ' + r.records);
  return files.length + ' 个文件 → ' + r.records + ' 条记录（sha256 逐个现算）；幂等';
});

await check('★ 索引被写坏（非法 JSON）时不抛：list 如实说、rebuild 能救回来', () => {
  // 先确保索引是好的（前一条用例末尾重建过一次）并记下条数
  const goodCount = A.listAssets({}).total;
  assert(goodCount > 0, '前置：索引里该有素材');
  const good = fs.readFileSync(INDEX, 'utf8');
  fs.writeFileSync(INDEX, '{ 这不是 JSON');
  const l = A.listAssets({});
  assert(l.ok === true, 'list 竟然抛了/失败了：' + JSON.stringify(l).slice(0, 160));
  assert(l.total === 0 && l.indexExists === false, '坏索引该按"没有索引"处理');
  assert(l.indexNote && /不是合法 JSON/.test(l.indexNote), '没有如实说明索引坏了：' + l.indexNote);
  assert(/\d/.test(String(l.hint)) && /rebuild/.test(String(l.hint)),
    '目录里明明有素材文件，hint 该指路 rebuild（而不是"库里还没有素材"）：' + l.hint);
  const r = A.rebuildIndex({});
  assert(r.ok === true && r.records === goodCount, '坏索引没救回来：' + r.records + ' vs ' + goodCount);
  // 把原来那份写回去，确认它依然可用（说明重建前的备份/恢复两条路都通）
  fs.writeFileSync(INDEX, good);
  assert(A.listAssets({}).total === goodCount, '恢复原索引后总数对不上');
  A.rebuildIndex({});
  return '坏 JSON → 如实说 + hint 指路 + rebuild 救回 ' + r.records + ' 条';
});

/* ══════════════════════════════ ② IO：分类、统计、删 */

await check('list：`tag` 过滤 / `limit` 截断 / `summaryOnly` 只去明细不去结论', () => {
  // 保证至少有 3 条（重组索引不会再生素材，所以这里补两张）
  for (const tag of ['夹A', '夹B']) A.addAsset({ source: tmpFile('夹具-' + tag + '.png', fakePng(tag, 128)), tags: tag });
  const all = A.listAssets({});
  assert(all.total >= 3, '夹具不够：' + all.total);
  const one = A.listAssets({ limit: 1 });
  assert(one.count === 1, 'limit 没生效');
  assert(one.total === all.total, 'limit 之后 total 该还是全量：' + one.total + ' vs ' + all.total);
  assert(one.assetsOmitted === all.total - 1, 'assetsOmitted 不对：' + one.assetsOmitted);
  assert(A.listAssets({ tag: '夹A' }).total === 1, 'tag 过滤没生效');
  const slim = A.listAssets({ summaryOnly: true });
  assert(slim.assets === null, 'summaryOnly 该把明细置成 null（不是 undefined —— 那会让字段在 JSON 里消失）');
  assert(!('assets' in slim) === false, 'assets 字段必须还在（只是 null）');
  assert(slim.total === all.total && slim.totalBytes === all.totalBytes, 'summaryOnly 把结论字段也去掉了');
  assert(Array.isArray(slim.supportedExt) && slim.supportedExt.includes('.png'), 'summaryOnly 丢了 supportedExt');
  assert(slim.maxBytes === A.ASSET_MAX_BYTES, 'summaryOnly 丢了 maxBytes');
  // 体积要比明细小（否则 summaryOnly 白加）
  const bFull = JSON.stringify(all).length;
  const bSlim = JSON.stringify(slim).length;
  assert(bSlim < bFull, 'summaryOnly 没省体积：' + bSlim + ' vs ' + bFull);
  return '明细 ' + bFull + 'B → 摘要 ' + bSlim + 'B（省 ' + (bFull - bSlim) + 'B）';
});

await check('stats：总数 / 总体积 / 索引与目录是否一致（`inSync`）', () => {
  const s = A.assetStats({});
  assert(s.ok === true, 'stats 失败');
  assert(s.count === fs.readdirSync(DIR).filter((n) => /^[0-9a-f]{16}\./.test(n)).length, 'count 与目录文件数不符');
  assert(s.bytes === s.diskBytes, '索引体积与磁盘体积不符：' + s.bytes + ' vs ' + s.diskBytes);
  assert(s.inSync === true, 'inSync 该是 true：' + JSON.stringify({ miss: s.missingInDir, orph: s.orphanFiles }));
  assert(s.byExt['.png'] && s.byExt['.png'].count > 0, 'byExt 没统计到 .png');
  assert(s.indexExists === true && s.indexSize > 0, '索引信息不对：' + JSON.stringify({ e: s.indexExists, sz: s.indexSize }));
  return s.count + ' 张 / ' + s.bytesText + '，inSync=true';
});

await check('★ remove **必须显式**：不给 confirm 时一个字节都不动', () => {
  const all = A.listAssets({});
  assert(all.total >= 2, '前置素材不足（后面还要留一张做 prune 的正常素材）：' + all.total);
  const target = all.assets[all.assets.length - 1];
  const file = path.join(DIR, target.id + target.ext);
  const before = fs.readFileSync(INDEX, 'utf8');
  const r = A.removeAsset({ id: target.id });
  assert(r.ok === false, '不给 confirm 竟然成功了：' + JSON.stringify(r).slice(0, 160));
  assert(r.needsConfirm === true, 'needsConfirm 没置真');
  assert(r.removed === false && r.deletedFile === false, 'rejected 之后不该有 removed/deletedFile');
  assert(fs.readFileSync(INDEX, 'utf8') === before, '被拒的 remove 竟然改了索引');
  assert(fs.existsSync(file), '被拒的 remove 竟然删了文件');

  // 只给 confirm：摘索引、**字节留着**
  const r2 = A.removeAsset({ id: target.id, confirm: true });
  assert(r2.ok === true && r2.removed === true, '给了 confirm 还是失败：' + JSON.stringify(r2).slice(0, 160));
  assert(r2.deletedFile === false && r2.fileKept === true, '只给 confirm 时不该删文件');
  assert(fs.existsSync(file), '只给 confirm 时文件被删了！');
  assert(!A.listAssets({}).assets.some((a) => a.id === target.id), '摘了索引但 list 里还在');
  // 无主文件要能被探到（不是静默消失）
  const prune = A.pruneAssets({});
  assert(prune.orphans.some((o) => o.id === target.id), '无主文件没被探到：' + JSON.stringify(prune.counts));
  assert(prune.dryRun === true && prune.deleted.length === 0, 'prune 默认竟然删了东西');
  // rebuild 会把它**收回来**（这正是"只摘索引"的语义）
  const re = A.rebuildIndex({});
  assert(re.recovered.some((x) => x.id === target.id), 'rebuild 没收回复活的无主文件');
  return '拒→摘索引（字节留）→prune 探到→rebuild 收回；recovered=' + re.recovered.length;
});

await check('★ remove + deleteFile:true 才真删字节；删完索引里没有它', () => {
  const target = A.listAssets({}).assets[0];
  const file = path.join(DIR, target.id + target.ext);
  assert(fs.existsSync(file), '前置：目标文件不在');
  const r = A.removeAsset({ id: target.id, confirm: true, deleteFile: true });
  assert(r.ok === true && r.removed === true, 'remove+deleteFile 失败：' + JSON.stringify(r).slice(0, 200));
  assert(r.deletedFile === true && r.fileKept === false, 'deleteFile:true 没真删：' + JSON.stringify(r).slice(0, 200));
  assert(!fs.existsSync(file), '说删了但文件还在');
  assert(!A.listAssets({}).assets.some((a) => a.id === target.id), '索引里还有这条');
  return '索引与字节都清了，remaining=' + r.remaining;
});

await check('★ `prune` 默认**只报告不删**；confirm:true 才删，且只删点名的无主/损坏文件', () => {
  // 造一个"无主文件"（内容寻址的名字，但索引里没有）
  const orphan = path.join(DIR, 'ffffffffffffffff.png');
  fs.writeFileSync(orphan, fakePng('O', 128));
  // 造一个"损坏"（索引有记录、字节被换过）
  const victim = A.listAssets({}).assets[0];
  const vfile = path.join(DIR, victim.id + victim.ext);
  const keep = A.listAssets({}).assets[1];
  const keepFile = path.join(DIR, keep.id + keep.ext);

  const dry = A.pruneAssets({});
  assert(dry.ok === true && dry.dryRun === true, 'prune 默认该是 dryRun');
  assert(dry.orphans.some((o) => o.id === 'ffffffffffffffff'), '无主文件没被点名');
  assert(dry.deleted.length === 0, 'dryRun 竟然删了东西');
  assert(fs.existsSync(orphan), 'dryRun 竟然删了文件');

  fs.writeFileSync(vfile, fakePng('X', 999));   // 换掉字节 ⇒ sha256 与索引不符
  const dry2 = A.pruneAssets({});
  assert(dry2.corrupt.some((c) => c.id === victim.id), '损坏文件没被点名：' + JSON.stringify(dry2.counts));
  assert(dry2.counts.wouldDelete >= 2, 'wouldDelete 计数不对：' + JSON.stringify(dry2.counts));

  const real = A.pruneAssets({ confirm: true });
  assert(real.ok === true && real.confirm === true, 'confirm 之后没跑');
  assert(!fs.existsSync(orphan), '无主文件没被删');
  assert(!fs.existsSync(vfile), '损坏文件没被删');
  assert(fs.existsSync(keepFile), '**正常的素材**被误删了！' + keepFile);
  assert(real.note && /重建了索引/.test(real.note), '删完该重建索引：' + real.note);
  return 'dryRun 只报告；confirm 删 ' + real.deleted.length + ' 个（正常素材保留）';
});

/* ══════════════════════════════ ② IO：原子写 / 无 BOM / id 碰撞 */

await check('★ `index.json` 是**原子写**（不留临时文件）且**无 BOM**、结构稳定', () => {
  const raw = fs.readFileSync(INDEX);
  assert(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), 'index.json 带 BOM（别的解析器会当坏文件）');
  const doc = JSON.parse(raw.toString('utf8'));
  assert(doc.version === A.ASSET_INDEX_VERSION, 'version 不对：' + doc.version);
  assert(typeof doc.updatedAt === 'string' && !Number.isNaN(Date.parse(doc.updatedAt)), 'updatedAt 不对');
  assert(typeof doc.idLen === 'number', 'idLen 没写进索引');
  assert(Array.isArray(doc.assets), 'assets 不是数组');
  for (const key of ['id', 'sha256', 'bytes', 'ext', 'mime', 'name', 'addedAt', 'source', 'tags']) {
    assert(key in doc.assets[0], '记录缺字段 ' + key + '：' + JSON.stringify(doc.assets[0]));
  }
  // 原子写会在同目录留下 `.index.json.tmp-<pid>-…`；写完必须一个都不剩
  const leftovers = fs.readdirSync(DIR).filter((n) => n.startsWith('.') && /tmp/.test(n));
  assert(leftovers.length === 0, '原子写留下了临时文件：' + leftovers.join(','));
  return '无 BOM / version=' + doc.version + ' / ' + doc.assets.length + ' 条 / 无 tmp 残留';
});

await check('★ id 碰撞（同 id、不同 sha256）→ **拒绝写入**，绝不覆盖别人的图', () => {
  // 造一个"索引说 id=X 是内容 A，但其实是内容 B"的局面：直接改索引里那条的 sha256。
  // 这样下一次 add A 就会走进「id 命中、sha256 不同」那条分支 —— 正是真碰撞的处置路径。
  const good = A.addAsset({ source: tmpFile('碰撞源.png', fakePng('K', 300)) });
  assert(good.ok === true, good.error);
  const doc = readJson(INDEX);
  const at = doc.assets.findIndex((r) => r.id === good.asset.id);
  doc.assets[at].sha256 = sha(Buffer.from('完全另一张图'));
  fs.writeFileSync(INDEX, JSON.stringify(doc, null, 2));
  const fileBytes = fs.readFileSync(good.file);
  const r = A.addAsset({ source: tmpFile('碰撞源2.png', fakePng('K', 300)) });
  assert(r.ok === false, '真碰撞竟然静默通过了：' + JSON.stringify(r).slice(0, 200));
  assert(r.collision === true, 'collision 标记没置真');
  assert(/ASSET_ID_LEN/.test(r.error), '报错该点明"调大 ASSET_ID_LEN"：' + r.error);
  assert(fs.readFileSync(good.file).equals(fileBytes), '拒绝之后盘上的字节被改了！');
  // 收拾：把索引改回来，别影响后面
  doc.assets[at].sha256 = good.asset.sha256;
  fs.writeFileSync(INDEX, JSON.stringify(doc, null, 2));
  return '拒绝 + 盘上字节一个字没动';
});

/* ══════════════════════════════ ③ 工具层（接线 / 形状） */

await check('工具层：`miliastra_asset` 的形状 / 参数枚举 / 典型调用 / summaryOnly 都在', () => {
  const t = TOOLS.find((x) => x.name === 'miliastra_asset');
  assert(t, 'TOOLS 里没有 miliastra_asset');
  assert(/典型调用/.test(t.description), 'description 里没有「典型调用」（smoke 会红）');
  assert(/绝不自动删/.test(t.description), 'description 没写"素材绝不自动删"这条纪律');
  assert(/绝对路径/.test(t.description) && /64 MiB/.test(t.description), 'description 没写清路径与上限口径');
  assert(/不进游戏存档/.test(t.description), 'description 没写清"不进游戏存档"');
  const ops = t.parameters.properties.op.enum;
  for (const op of ['add', 'list', 'get', 'remove', 'rebuild', 'prune', 'stats']) {
    assert(ops.includes(op), 'op 枚举缺 ' + op + '：' + ops.join(','));
  }
  assert('summaryOnly' in t.parameters.properties, '缺 summaryOnly（可能超 10KB 的回执必须有）');
  assert('confirm' in t.parameters.properties && 'deleteFile' in t.parameters.properties, '缺确认类参数');
  assert(/磁盘是用户的/.test(t.description) || /绝不自动删/.test(t.description), '没写磁盘纪律');
  return ops.join(' / ');
});

await check('工具层：从工具走一遍 add → list → get → stats → rebuild（真目录）', async () => {
  const t = TOOLS.find((x) => x.name === 'miliastra_asset');
  const buf = fakePng('T', 777);
  const src = tmpFile('工具层.png', buf);
  const add = await t.execute({ op: 'add', source: src, tags: '工具层' });
  assert(add.ok === true, '工具层 add 失败：' + add.error);
  assert(path.resolve(add.dir) === path.resolve(DIR), '工具层写的目录不是素材目录：' + add.dir);
  assert(String(add.dir).startsWith(path.resolve(DATA)), '工具层写到了数据目录外：' + add.dir);
  const list = await t.execute({ op: 'list', summaryOnly: true });
  assert(list.ok === true && typeof list.total === 'number', '工具层 list 形状不对：' + JSON.stringify(list).slice(0, 160));
  const get = await t.execute({ op: 'get', id: add.asset.id });
  assert(get.ok === true && typeof get.dataUrl === 'string', '工具层 get 没回 dataUrl');
  assert(sha(Buffer.from(get.dataUrl.split(',')[1], 'base64')) === sha(buf), '工具层取回的字节不一致');
  const stats = await t.execute({ op: 'stats' });
  assert(stats.ok === true && stats.count >= 1, '工具层 stats 不对');
  const rebuild = await t.execute({ op: 'rebuild' });
  assert(rebuild.ok === true && rebuild.records >= 1, '工具层 rebuild 不对');
  const bad = await t.execute({ op: '不存在的op' }).then(() => null, (e) => e);
  assert(bad && /没有这个 op/.test(bad.message), '不认识的 op 该明确报错（而不是静默当 list）：' + (bad && bad.message));
  return 'add/list/get/stats/rebuild 都对；未知 op 明确报错';
});

await check('工具层：`remove` 不带 confirm 时回 ok:false + needsConfirm（不删任何东西）', async () => {
  const t = TOOLS.find((x) => x.name === 'miliastra_asset');
  const list = await t.execute({ op: 'list' });
  const target = list.assets[0];
  const r = await t.execute({ op: 'remove', id: target.id });
  assert(r.ok === false && r.needsConfirm === true, JSON.stringify(r).slice(0, 200));
  assert(fs.existsSync(path.join(DIR, target.id + target.ext)), '被拒的工具层 remove 删了文件');
  const r2 = await t.execute({ op: 'remove', id: target.id, confirm: true, deleteFile: true });
  assert(r2.ok === true && r2.deletedFile === true, '工具层 confirm+deleteFile 失败：' + JSON.stringify(r2).slice(0, 200));
  return '拒 → 确认后真删；两段都从工具层走';
});

/* ------------------------------------------------------------------ 收尾 */

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
if (savedData === undefined) delete process.env.MILIASTRA_DATA_DIR;
else process.env.MILIASTRA_DATA_DIR = savedData;

console.log('');
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
