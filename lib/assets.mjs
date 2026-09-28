/**
 * assets.mjs — **插件级素材库（asset store）**：与具体功能无关的图片素材存储。
 *
 * 为什么要单独一层（而不是塞进某个功能里）：作者要吸收第三方「UI 动画 / 粒子 / 像素画」编辑器的能力，
 * 这三件事都要把**图片素材**存起来并反复引用。若把存储写进某个功能，下一个功能就会再写一份 ——
 * 于是「同一张图存三遍、删的时候只删掉其中一份、索引格式各不一样」。
 * 所以这里只做**一件事**：给字节找一个**稳定的名字**，让任何功能都能按名字把它取回来。
 *
 * ## 布局（全部在**插件自己的数据目录**下，不进游戏存档、不碰活文件）
 *
 * ```
 * <dataRoot>/assets/                 ← dataRoot = MILIASTRA_DATA_DIR > DSH_HOME/miliastra > ~/.dsh/miliastra
 *   index.json                       ← 索引（原子写；丢了能从目录 rebuild 回来）
 *   <id>.<ext>                       ← 素材正文，文件名 = 内容寻址
 *   a1b2c3d4e5f60718.png
 * ```
 *
 * ## 三条设计决策（连同理由）
 *
 * ① **`id` = `sha256` 的**前 16 位十六进制**（64 bit）**。防碰撞的理由是算出来的、不是拍的：
 *    生日碰撞概率 ≈ n²/2^65；即使攒到 **100 万**张素材也只有 ≈ 2.7e-8。
 *    而且这里**不靠概率兜底**：`id` 只是**短名**，索引里**存着完整 `sha256`** ——
 *    真要撞上（不同内容 → 同一个 id），`addAsset` 会**明确报错并拒绝写入**，绝不静默覆盖别人的图。
 *    16 位是「文件名短到能一眼读」与「不可能撞」的折中；`ASSET_ID_LEN` 是唯一定义处。
 * ② **单张上限 64 MiB**（`ASSET_MAX_BYTES`）。这是**素材**（界面图 / 像素画 / 精灵图），
 *    不是视频仓库；上限存在的意义是挡住「误把整个安装目录塞进来」这种事故，
 *    以及让 base64 路径（体积 ×4/3）在内存里是可控的。超限**拒绝**并报出实际大小。
 * ③ **只收白名单里的图片扩展名**（`ASSET_EXT_MIME`），并且 **拒绝 0 字节**。
 *    白名单同时给出 `mime` —— 于是 `get` 能直接回一个可用的 `dataUrl`，不需要猜类型。
 *
 * ## 纪律
 *
 * · **磁盘是用户的**：加进来的素材**绝不自动删**。`removeAsset` 有两个开关且都要显式给：
 *   `deleteFile:true` 才动盘上的字节；只加 `confirm:true`（或不传）时**只摘索引**。
 *   `pruneAssets` **只报告**，不删。
 * · **写盘一律走 `lib/fsx.mjs`** 的 `atomicWriteFile` / `atomicWriteJson`（本仓铁律，别手搓 tmp+rename）。
 * · **路径穿越**：`safeJoin` 只用 `path.basename` 后的名字，并复验解析结果的父目录
 *   —— `../` 与 `..\\` 一律拒（`path.basename('..')` 恰好就是 `'..'`，躲不过）。
 * · **索引是缓存、目录才是真相**：`index.json` 丢了/坏了/被手改了都能 `rebuildIndex` 重建，
 *   重建结果里**目录说明得了的字段照实填**，说明不了的（原始文件名 / 来源）**如实标 `null`**，不编。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWriteFile, atomicWriteJson } from './fsx.mjs';

/* ------------------------------------------------------------ 常量（唯一真身） */

/** 素材 `id` 的长度（`sha256` 前 N 位**十六进制字符**）。理由见文件头 ①；改这里就是改全库命名。 */
export const ASSET_ID_LEN = 16;

/** 单张素材的字节上限（64 MiB）。理由见文件头 ②。 */
export const ASSET_MAX_BYTES = 64 * 1024 * 1024;

/** 允许的扩展名 → MIME。白名单 = 同时挡住「不是图片的东西」并给出 `mime`（见文件头 ③）。 */
export const ASSET_EXT_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // 千星「像素画」路线的常用输出格式（无损、带索引色，体积小）
  '.avif': 'image/avif',
});

/** 索引文件名（在 `assets/` 下）。 */
export const ASSET_INDEX_NAME = 'index.json';

/** 索引格式版本 —— 将来改结构时用它判断要不要迁移（不是「文件版本」，是「记录结构版本」）。 */
export const ASSET_INDEX_VERSION = 1;

/** 素材是不是「内容寻址的名字」（`<16 hex><ext>`）—— `resolveAssetFile` 用它挡掉自由命名。 */
const ID_RE = new RegExp('^[0-9a-f]{' + ASSET_ID_LEN + '}$');

/* ------------------------------------------------------------ 纯函数（可单测、无 IO） */

/**
 * 插件数据根目录：`MILIASTRA_DATA_DIR` > `DSH_HOME/miliastra` > `~/.dsh/miliastra`。
 *
 * ⚠️ 与 `lib/shot.mjs` 的 `dataRoot` 是**同一条约定**（截图落在 `<dataRoot>/shots/`，
 * 素材落在 `<dataRoot>/assets/`）。这里重复三行而不是 import 那个模块：
 * `shot.mjs` 拖着一堆截图/PS 相关的依赖，素材库不该为了一个目录名把它整个拉进来。
 * 两边的一致性由 `tests/assets-test.mjs` 与 `tests/shot-test.mjs` 各钉一条断言。
 *
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function assetsDataRoot(env = process.env, home = os.homedir()) {
  if (env && env.MILIASTRA_DATA_DIR) return path.resolve(String(env.MILIASTRA_DATA_DIR));
  const dsh = (env && env.DSH_HOME) ? String(env.DSH_HOME) : path.join(home, '.dsh');
  return path.join(dsh, 'miliastra');
}

/** 素材库目录（`<dataRoot>/assets`）。 */
export function assetsDir(deps = {}) {
  return path.join(assetsDataRoot(deps.env || process.env, deps.home || os.homedir()), 'assets');
}

/** 索引文件的绝对路径。 */
export function assetIndexPath(dir = assetsDir()) {
  return path.join(dir, ASSET_INDEX_NAME);
}

/**
 * 一个**观察到的** sha256 → 素材短名（`sha256` 前 `ASSET_ID_LEN` 位小写十六进制）。
 * 纯函数，不读盘 —— 于是「命名规则」只有这一处定义，测试直接对它断言。
 */
export function assetIdOf(sha256) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('assetIdOf 要一个完整的 sha256（64 位十六进制），收到：' + JSON.stringify(sha256));
  return hex.slice(0, ASSET_ID_LEN);
}

/**
 * 从**索引里的**记录算 `id`，但**不抛**（索引可能是人手改过的坏数据）。
 * 为什么要这条：`list` / `stats` / `get` 走的是「读索引」这条路，
 * 一条 `sha256` 写坏的记录不该让整个列举炸掉 —— 那会把「有条坏数据」变成「工具用不了」。
 * 算不出来就给空串（调用方拿它拼出的路径必然找不到文件，于是自然进 `missingInDir`，一路如实报出来）。
 */
function safeIdOf(sha256) {
  try { return assetIdOf(sha256); } catch { return ''; }
}

/**
 * 归一化扩展名：小写、补前导点；**必须**在白名单里，否则抛（报出支持哪些）。
 * @throws {Error}
 */
export function normalizeExt(ext) {
  let e = String(ext == null ? '' : ext).trim().toLowerCase();
  if (!e) throw new Error('缺扩展名（要能吃到 MIME，只收：' + Object.keys(ASSET_EXT_MIME).join(' ') + '）');
  if (e[0] !== '.') e = '.' + e;
  if (!Object.prototype.hasOwnProperty.call(ASSET_EXT_MIME, e)) {
    throw new Error('不支持的素材类型 "' + e + '"（只收图片：' + Object.keys(ASSET_EXT_MIME).join(' ') + '）');
  }
  return e;
}

/**
 * 把 `name` 解析成**确认在该目录内**的绝对路径。纯路径运算（可单测、不碰盘）。
 *
 * 用在哪：`resolveAssetFile`（素材库目录内的名字）。
 * 挡三类：① `../` / `..\\`（`path.basename('..')` 恰好就是 `'..'`）；② 绝对路径；③ 子目录。
 *
 * ⚠️ 两个分支**都带 `error` 字段**（成功时是 `null`）：这样 TypeScript 的 `checkJs` 才能
 * 在 `if (!r.ok)` 之后把 `r.error` 收窄成 `string`。少了它 `typecheck` 会当场报 TS2339。
 *
 * @returns {{ok:true, path:string, name:string, error:null} | {ok:false, error:string}}
 */
export function safeJoin(dir, name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return { ok: false, error: '缺少 name' };
  if (raw.includes('/') || raw.includes('\\')) return { ok: false, error: 'name 不能带路径分隔符' };
  if (raw === '.' || raw === '..') return { ok: false, error: 'name 不合法（路径穿越）' };
  const base = path.resolve(dir);
  const full = path.resolve(base, raw);
  if (path.dirname(full) !== base) return { ok: false, error: '越出素材目录' };
  return { ok: true, path: full, name: raw, error: null };
}

/**
 * 把一个**内容寻址的名字**（`<id>.<ext>` 或裸 `<id>`）解析到素材库里。
 *
 * ⚠️ 与 `safeJoin` 分开：`get` / `remove` 只认**内容寻址**的名字，
 * 自由命名的文件即便躺在 `assets/` 里也不许通过这条路径读写（否则等于给了个任意文件接口）。
 */
export function resolveAssetFile(dir, name) {
  const j = safeJoin(dir, name);
  if (!j.ok) return j;
  const base = j.name.toLowerCase();
  if (!base.startsWith('.')) {
    const dot = base.lastIndexOf('.');
    const id = dot < 0 ? base : base.slice(0, dot);
    if (ID_RE.test(id)) return j;
  }
  return { ok: false, error: '素材名要形如 <id>' + ASSET_ID_LEN + '位十六进制 + 图片扩展名（收到 ' + JSON.stringify(j.name) + '）' };
}

/** `Buffer` → `data:<mime>;base64,…`（`get` 的回执用它，AI 可以直接喂给图片查看器）。 */
export function toDataUrl(buf, mime) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return 'data:' + String(mime || 'application/octet-stream') + ';base64,' + b.toString('base64');
}

/**
 * 解析 `data:` URL。**只认 base64**（`data:image/png;base64,…`）——
 * 非 base64 的（百分号编码）这里明确拒绝而不是猜着解，否则会把文本塞成图片。
 *
 * @returns {{ok:true, mime:string|null, base64:string, ext:string|null, error:null} | {ok:false, error:string}}
 */
export function parseDataUrl(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /^data:([^,;]*)((?:;[^,]*)*),([\s\S]*)$/.exec(s);
  if (!m) return { ok: false, error: '不是合法的 data URL（要 data:<mime>;base64,<内容>）' };
  const mime = m[1] ? m[1].toLowerCase() : null;
  const meta = m[2] || '';
  if (! /;base64/i.test(meta)) return { ok: false, error: '只支持 base64 的 data URL（收到非 base64 的 ' + (mime || '无 mime') + '）' };
  const ext = mime ? extOfMime(mime) : null;
  return { ok: true, mime, base64: m[3].replace(/\s+/g, ''), ext, error: null };
}

/** MIME → 扩展名（白名单反查；不认识就 `null`，由调用方决定报错还是按别的线索认）。 */
export function extOfMime(mime) {
  const m = String(mime == null ? '' : mime).trim().toLowerCase().split(';')[0];
  for (const [ext, mm] of Object.entries(ASSET_EXT_MIME)) if (mm === m) return ext;
  return null;
}

/**
 * 「原始文件名」只做**展示**，所以这里把路径与危险字符一并清掉 —— 它永远不会被当成路径用。
 * 空/缺省给 `null`（如实说不知道，不编一个名字）。
 */
function displayName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const base = s.split(/[\\/]/).pop();
  // 控制字符与路径分隔符一律去掉（它只进 JSON、只给人看）
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  return cleaned || null;
}

/**
 * 归一化 `tags`：去空白、去重（保序）、只留字符串、每个截到 64 字、最多 32 个。
 *
 * 为什么字符串入参要**按逗号拆**：工具的 `tags` 是 `string` 类型（省 schema 体积），
 * AI 很自然就写 `"背景,像素画"`。若把它整串当成一个标签，`list tag=背景` 就永远筛不出东西 ——
 * 而这**不会报错**，只会静默筛空（属于最难发现、最浪费轮次的一类 bug）。
 */
export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : (tags == null || tags === '' ? [] : String(tags).split(','));
  const out = [];
  for (const t of list) {
    const s = String(t == null ? '' : t).trim();
    if (!s) continue;
    const cut = s.slice(0, 64);
    if (!out.includes(cut)) out.push(cut);
    if (out.length >= 32) break;
  }
  return out;
}

/** 记录形状（回执/索引都用它，字段顺序固定，便于人读 diff）。 */
export function publicRecord(rec) {
  return {
    id: rec.id,
    sha256: rec.sha256,
    bytes: rec.bytes,
    ext: rec.ext,
    mime: rec.mime,
    name: rec.name === undefined ? null : rec.name,
    addedAt: rec.addedAt === undefined ? null : rec.addedAt,
    source: rec.source === undefined ? null : rec.source,
    tags: Array.isArray(rec.tags) ? rec.tags : [],
  };
}

/* ------------------------------------------------------------ 索引读写 */

/**
 * 读索引。**任何异常都不抛**（索引是缓存，不是唯一副本）：文件不存在/坏 JSON/结构不对
 * 都把 `exists` 置假、把原因放进 `note`，让上层可以走 `rebuildIndex`。
 *
 * @returns {{exists:boolean, records:Array<any>, updatedAt:string|null, version:number, note:string|null, dir:string}}
 */
export function readIndex(dir = assetsDir()) {
  const file = assetIndexPath(dir);
  const empty = { exists: false, records: [], updatedAt: null, version: ASSET_INDEX_VERSION, note: null, dir };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ...empty, note: '索引不存在（丢了吗？可以 rebuild）' };
    return { ...empty, note: '索引读不动：' + ((e && e.message) || e) };
  }
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ...empty, note: '索引不是合法 JSON（' + ((e && e.message) || e) + '）—— 可以 rebuild 从目录重建' };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.assets)) {
    return { ...empty, note: '索引结构不对（要 {version, updatedAt, assets:[…]}）—— 可以 rebuild' };
  }
  const records = doc.assets.filter((r) => r && typeof r === 'object' && typeof r.id === 'string');
  return {
    exists: true,
    records,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    version: Number.isFinite(Number(doc.version)) ? Number(doc.version) : ASSET_INDEX_VERSION,
    note: records.length !== doc.assets.length
      ? '索引里有 ' + (doc.assets.length - records.length) + ' 条结构不对的记录被跳过（可以 rebuild）'
      : null,
    dir,
  };
}

/** 原子写索引（**唯一写入口**；规矩见 `lib/fsx.mjs`）。 */
export function writeIndex(dir, records, now = null) {
  const at = now ? new Date(now) : new Date();
  const doc = {
    version: ASSET_INDEX_VERSION,
    updatedAt: at.toISOString(),
    idLen: ASSET_ID_LEN,
    assets: records.map(publicRecord),
  };
  atomicWriteJson(assetIndexPath(dir), doc);
  return doc;
}

/** 列目录里「长得像素材」的文件（`<id><ext>`，跳过索引与临时文件）。 */
export function scanAssetFiles(dir = assetsDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { dir, exists: false, files: [] }; }
  const files = [];
  for (const name of names) {
    if (name === ASSET_INDEX_NAME || name.startsWith('.')) continue;
    const dot = name.lastIndexOf('.');
    const id = dot < 0 ? name : name.slice(0, dot);
    const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
    if (!ID_RE.test(id.toLowerCase())) continue;
    if (!Object.prototype.hasOwnProperty.call(ASSET_EXT_MIME, ext)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      files.push({ name, id: id.toLowerCase(), ext, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 读不到就跳过这一个，不让它毁掉整次扫描 */ }
  }
  return { dir, exists: true, files };
}

/**
 * **从目录重建索引**（索引丢了/坏了/被人手改了都靠它）。
 *
 * 怎么知道一个文件名对应的内容是什么：**读它的字节算 sha256**（这正是内容寻址的好处 ——
 * 目录本身就携带了全部真相）。于是重建结果里：
 *   · **能被目录说明的**（`sha256` / `bytes` / `ext` / `mime` / `id`）照实填；
 *   · **目录说明不了的**（原始文件名 `name` / 来源 `source` / 加入时间）**如实标 `null`**，不编。
 *   · 索引里还有记录、但目录里字节已经不在的 → 进 `missing`，**不写回新索引**。
 *
 * @param {{dir?:string, now?:number}} [opts]
 */
export function rebuildIndex(opts = {}) {
  const dir = opts.dir || assetsDir();
  const now = opts.now ? new Date(opts.now) : new Date();
  const scanned = scanAssetFiles(dir);
  const before = readIndex(dir);
  const byId = new Map(before.records.map((r) => [r.id, r]));
  const records = [];
  const recovered = [];
  const dropped = [];
  for (const f of scanned.files) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, f.name)); } catch { dropped.push({ name: f.name, reason: '读不动' }); continue; }
    const sha256 = sha256Of(buf);
    const id = assetIdOf(sha256);
    const old = byId.get(id);
    const rec = {
      id,
      sha256,
      bytes: buf.length,
      ext: f.ext,
      mime: ASSET_EXT_MIME[f.ext],
      // 索引里那份记录的 name/source/addedAt 只在 **sha256 对得上**时才沿用；对不上就是另一张图，不继承
      name: old && old.sha256 === sha256 ? (old.name === undefined ? null : old.name) : null,
      addedAt: old && old.sha256 === sha256 && old.addedAt ? old.addedAt : now.toISOString(),
      source: old && old.sha256 === sha256 ? (old.source === undefined ? null : old.source) : null,
      tags: old && old.sha256 === sha256 && Array.isArray(old.tags) ? old.tags : [],
    };
    records.push(rec);
    if (!old) recovered.push({ id, name: f.name, bytes: rec.bytes, note: '目录里有、索引里没有（无主的字节）' });
  }
  const seen = new Set(records.map((r) => r.id));
  for (const r of before.records) if (!seen.has(r.id)) dropped.push({ id: r.id, name: r.name || null, reason: '索引里有、目录里字节不在（缺文件）' });
  writeIndex(dir, records, now);
  return {
    ok: true,
    dir,
    indexPath: assetIndexPath(dir),
    scanned: scanned.files.length,
    records: records.length,
    recovered,
    dropped,
    existedBefore: before.exists,
    indexNote: before.note,
    note: '已按**目录内容**重建索引（每个文件的 sha256 现算）：能被目录说明的字段照实填，'
      + '说明不了的（原始文件名 / 来源）如实标 null。索引里那些**字节已经不在**的记录没有写回。',
  };
}

/* ------------------------------------------------------------ sha256 / 字节 */

/** `sha256`（小写十六进制）。纯函数。 */
export function sha256Of(buf) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).digest('hex');
}

/**
 * 把三种来源（绝对路径 / base64 / data URL）统一成字节。**只做解码与限额，不碰磁盘**。
 *
 * @param {{source?:string, base64?:string, name?:string}} input
 * @returns {{ok:true, buf:Buffer, ext:string, name:string|null, error:null, sourceText:string} | {ok:false, error:string}}
 */
export function bytesFromSource(input = {}) {
  const rawSource = input.source == null ? '' : String(input.source).trim();
  const rawB64 = input.base64 == null ? '' : String(input.base64);
  /*
   * 「给没给 base64」看的是**键在不在**，不是「值空不空」：
   * `base64: ''` 是「给了、但内容是空的」，必须走到下面那条**「拒绝 0 字节」**的报错上 ——
   * 否则同一个错会有两种说法（"没给来源" vs "空素材"），排查时白绕一圈。
   */
  const gaveB64 = input.base64 !== undefined && input.base64 !== null;
  if (rawSource === '' && !gaveB64) {
    return { ok: false, error: '要给来源：`source`（绝对路径，或 `data:` 开头的 data URL）/ `base64`，二选一' };
  }
  if (rawSource && gaveB64) {
    return { ok: false, error: '`source` 与 `base64` 只能给一个（两个都给就不知道以哪个为准）' };
  }

  // ① data URL / base64
  if (gaveB64 || /^data:/i.test(rawSource)) {
    const text = gaveB64 ? rawB64 : rawSource;
    let mime = null;
    let b64 = text;
    let ext = null;
    if (/^data:/i.test(text)) {
      const parsed = parseDataUrl(text);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      mime = parsed.mime;
      b64 = parsed.base64;
      ext = parsed.ext;
    }
    // 空 base64（`base64:""` 或 `data:…;base64,` 后面没内容）与"解出来是空"是同一件事：
    //   统一说成「拒绝 0 字节」，别让同一个错误有两种说法
    if (!b64.replace(/\s+/g, '')) return { ok: false, error: '拒绝 0 字节素材：base64 内容是空的（空素材没有任何意义）' };
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { ok: false, error: 'base64 含非法字符（只认 A-Za-z0-9+/=）' };
    // 先按字符数挡一道：base64 长度 ×3/4 ≈ 字节数，避免为一个 200MB 的串先分配内存
    const approx = Math.floor(b64.replace(/\s+/g, '').length * 3 / 4);
    if (approx > ASSET_MAX_BYTES + 4) {
      return { ok: false, error: '素材过大：约 ' + approx + ' B 超过上限 ' + ASSET_MAX_BYTES + ' B（' + humanBytes(ASSET_MAX_BYTES) + '）' };
    }
    const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (!buf.length) return { ok: false, error: 'base64 解出来是 0 字节（拒绝：空素材没有任何意义）' };
    if (!ext) ext = extOfMime(mime);
    /*
     * MIME 认不出来时退到 `name` 的扩展名 —— 裸 base64 就是没有 mime 的，
     * 而 `name` 是唯一还能说明类型的东西。这里**只认白名单**（`normalizeExt` 会挡掉 .exe 之类），
     * 认不出来就明确报错，**绝不猜**（猜错会把一张图当成另一种格式存下去，之后取出来打不开）。
     */
    if (!ext && input.name) {
      try { ext = normalizeExt(path.extname(String(input.name))); } catch { /* 认不出就继续报错 */ }
    }
    if (!ext) {
      return { ok: false, error: '认不出图片类型（mime=' + JSON.stringify(mime) + '）；'
        + '请给 `name` 一个带图片扩展名的文件名（如 shot.png）或换 data URL 的 mime。支持：' + Object.keys(ASSET_EXT_MIME).join(' ') };
    }
    const name = displayName(input.name);
    const sourceText = mime ? 'base64:' + mime : 'base64';
    return { ok: true, buf, ext, name, error: null, sourceText };
  }

  // ② 绝对路径
  if (!path.isAbsolute(rawSource)) {
    return { ok: false, error: '`source` 要是**绝对路径**（收到 ' + JSON.stringify(rawSource) + '）；'
      + 'base64 / data URL 请放进 `base64` 或写 `data:` 开头的串。' };
  }
  if (!fs.existsSync(rawSource)) return { ok: false, error: '文件不存在：' + rawSource };
  let st;
  try { st = fs.statSync(rawSource); } catch (e) { return { ok: false, error: '读不到文件状态：' + ((e && e.message) || e) }; }
  if (!st.isFile()) return { ok: false, error: '不是普通文件（目录 / 设备）：' + rawSource };
  if (st.size === 0) return { ok: false, error: '拒绝 0 字节素材：' + rawSource + '（空文件没有任何意义）' };
  if (st.size > ASSET_MAX_BYTES) {
    return { ok: false, error: '素材过大：' + st.size + ' B（' + humanBytes(st.size) + '）超过上限 '
      + ASSET_MAX_BYTES + ' B（' + humanBytes(ASSET_MAX_BYTES) + '）：' + rawSource };
  }
  let ext;
  try { ext = normalizeExt(path.extname(rawSource)); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  let buf;
  try { buf = fs.readFileSync(rawSource); } catch (e) { return { ok: false, error: '读文件失败：' + ((e && e.message) || e) }; }
  if (!buf.length) return { ok: false, error: '拒绝 0 字节素材：' + rawSource };
  const name = displayName(input.name) || displayName(path.basename(rawSource));
  return { ok: true, buf, ext, name, error: null, sourceText: path.resolve(rawSource) };
}

/** 人能读的字节数（2 位小数，`KB/MB/GB` 十进制）。 */
export function humanBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return String(n);
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return x.toFixed(x >= 100 ? 0 : 2) + ' ' + units[i];
}

/* ------------------------------------------------------------ 主要操作 */

/** 按 `id` 或**完整的（或唯一的）前缀**找一条记录。名字不完整时**只在唯一命中时**才认，否则如实报候选。 */
export function findRecord(records, idLike) {
  const q = String(idLike == null ? '' : idLike).trim().toLowerCase();
  if (!q) return { ok: false, error: '缺 id' };
  const dot = q.lastIndexOf('.');
  const key = dot > 0 && ID_RE.test(q.slice(0, dot)) ? q.slice(0, dot) : q;
  const exact = records.filter((r) => r.id === key);
  if (exact.length === 1) return { ok: true, rec: exact[0], how: 'id' };
  if (exact.length > 1) return { ok: false, error: '索引里有多条同 id 记录（不该发生）：' + key };
  if (!/^[0-9a-f]{1,64}$/.test(key)) return { ok: false, error: 'id 不合法：' + JSON.stringify(idLike) + '（要十六进制）' };
  const hits = records.filter((r) => r.id.startsWith(key));
  if (hits.length === 1) return { ok: true, rec: hits[0], how: 'prefix' };
  if (hits.length > 1) {
    return { ok: false, error: 'id 前缀 ' + key + ' 命中 ' + hits.length + ' 条，不猜：' + hits.slice(0, 5).map((r) => r.id).join(' / ') };
  }
  return { ok: false, error: '素材库里没有 id=' + JSON.stringify(idLike) + '（可以先 op=rebuild 从目录重建索引）' };
}

/**
 * 一条记录对应的绝对路径。正常情况下 = `<sha256 前 N 位><ext>`（内容寻址 ⇒ 路径是**算出来的**，不是查出来的）；
 * 记录是坏数据（`sha256`/`ext` 不合法）时退化成「拼不出文件」，**不抛** —— 见 `safeIdOf`。
 */
export function fileOfRecord(dir, rec) {
  const id = safeIdOf(rec.sha256) || String(rec.id || '');
  let ext = '';
  try { ext = normalizeExt(rec.ext); } catch { ext = ''; }
  return path.join(dir, id + ext);
}

/**
 * 加入一个素材（绝对路径 / base64 / data URL）。
 *
 * 去重口径：**同内容 = 同 sha256** ⇒ 命中已有记录，**一个字节都不重写**，回执 `deduped:true`。
 * 撞 id 但 sha256 不同（真的碰撞）→ **报错拒绝**，绝不覆盖（理由见文件头 ①）。
 *
 * @param {{source?:string, base64?:string, name?:string, tags?:any, dir?:string, now?:number}} [input]
 */
export function addAsset(input = {}) {
  const got = bytesFromSource(input);
  if (!got.ok) return { ok: false, error: got.error, op: 'add' };
  const dir = input.dir || assetsDir();
  const buf = got.buf;
  if (buf.length === 0) return { ok: false, error: '拒绝 0 字节素材', op: 'add' };
  if (buf.length > ASSET_MAX_BYTES) {
    return { ok: false, error: '素材过大：' + buf.length + ' B 超过上限 ' + ASSET_MAX_BYTES + ' B', op: 'add' };
  }
  const sha256 = sha256Of(buf);
  const id = assetIdOf(sha256);
  const now = input.now ? new Date(input.now) : new Date();
  const idx = readIndex(dir);
  const records = idx.records.slice();
  const tags = normalizeTags(input.tags);

  const same = records.find((r) => r.id === id);
  if (same) {
    if (String(same.sha256).toLowerCase() !== sha256) {
      // 极不可能发生（≈ n²/2^65），但发生了就**必须**说清楚，而不是覆盖
      return {
        ok: false, op: 'add', collision: true, id,
        error: 'id 碰撞：' + id + ' 已被 sha256=' + String(same.sha256).slice(0, 16) + '… 占用，'
          + '而这次是 ' + sha256.slice(0, 16) + '…（内容不同）。**没有写入任何东西** —— '
          + '请把 lib/assets.mjs 的 ASSET_ID_LEN 调大后 op=rebuild。',
      };
    }
    const file = fileOfRecord(dir, same);
    const onDisk = fs.existsSync(file);
    // 去重时把新给的 tags 并进去（作者第二次加同一张图时顺手打了个标签，那个标签不该丢）
    const merged = normalizeTags([...(same.tags || []), ...tags]);
    const tagsAdded = merged.filter((t) => !(same.tags || []).includes(t));
    let rec = same;
    if (tagsAdded.length) {
      rec = { ...same, tags: merged, name: same.name || got.name };
      const at = records.findIndex((r) => r.id === id);
      records[at] = rec;
    }
    // 索引里说有、盘上却没有（有人手删了字节）⇒ 顺手把字节补回去，并如实说明
    let restored = false;
    if (!onDisk) {
      try { atomicWriteFile(file, buf); restored = true; } catch (e) { return { ok: false, op: 'add', error: '补齐素材字节失败：' + ((e && e.message) || e) }; }
    }
    if (tagsAdded.length || restored) writeIndex(dir, records, now);
    return {
      ok: true, op: 'add', deduped: true, restored, tagsAdded,
      asset: publicRecord(rec),
      file,
      dir,
      indexPath: assetIndexPath(dir),
      note: '同内容已在库里（sha256 相同）⇒ **没有重复落盘**，回的就是已有的那条。'
        + (restored ? ' ⚠️ 索引里有、盘上字节却不在 —— 这次把字节补回去了（是不是有人手删过？）。' : '')
        + (tagsAdded.length ? ' 新标签已并入：' + tagsAdded.join(' / ') : ''),
    };
  }

  // 新素材：先写字节、再写索引（顺序不能反 —— 反了就成了「索引里有、字节不在」的鬼记录）
  const file = fileOfRecord(dir, { id, ext: got.ext });
  if (fs.existsSync(file)) {
    // 目录里有同名文件但索引里没有（索引被删过）⇒ 读出来核对，别盲目覆盖
    let old = null;
    try { old = fs.readFileSync(file); } catch { /* ignore */ }
    if (old && sha256Of(old) !== sha256) {
      return { ok: false, op: 'add', collision: true, id, error: '磁盘上已有 ' + file + ' 但内容不同（id 碰撞或索引缺失）—— 拒绝覆盖，请先 op=rebuild。' };
    }
  }
  try { atomicWriteFile(file, buf); } catch (e) { return { ok: false, op: 'add', error: '写素材失败：' + ((e && e.message) || e) }; }
  const rec = {
    id, sha256, bytes: buf.length, ext: got.ext, mime: ASSET_EXT_MIME[got.ext],
    name: got.name, addedAt: now.toISOString(), source: got.sourceText, tags,
  };
  records.push(rec);
  try { writeIndex(dir, records, now); } catch (e) { return { ok: false, op: 'add', error: '写索引失败：' + ((e && e.message) || e) }; }
  return {
    ok: true, op: 'add', deduped: false,
    asset: publicRecord(rec),
    file,
    dir,
    indexPath: assetIndexPath(dir),
    indexNote: idx.note,
    note: '已按**内容寻址**落盘（文件名 = sha256 前 ' + ASSET_ID_LEN + ' 位 + 扩展名）；同内容再加一次会命中这条、不再重复落盘。',
  };
}

/**
 * 列素材（新的在前）。可 `tag` 过滤、`limit` 截断、`summaryOnly` 只给计数。
 *
 * ⚠️ 顺带**只报事实**：每条标 `fileExists`；索引里有、目录里没有的进 `missingInDir`，
 * 目录里有、索引里没有的进 `orphanFiles` —— 都只是**数字与名字**，删不删由人决定（本工具不自动删）。
 */
export function listAssets(opts = {}) {
  const dir = opts.dir || assetsDir();
  const idx = readIndex(dir);
  const tag = opts.tag == null || opts.tag === '' ? null : String(opts.tag).trim();
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : null;
  const summaryOnly = opts.summaryOnly === true;
  const scanned = scanAssetFiles(dir);
  const onDisk = new Set(scanned.files.map((f) => f.id));

  let rows = idx.records.map((r) => publicRecord({ ...r, file: fileOfRecord(dir, r) }));
  rows = rows.map((r) => ({ ...r, fileExists: onDisk.has(r.id) }));
  if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
  rows.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  const total = rows.length;
  const shown = limit ? rows.slice(0, limit) : rows;
  const totalBytes = rows.reduce((s, r) => s + (Number(r.bytes) || 0), 0);
  const missingInDir = rows.filter((r) => r.fileExists === false).map((r) => ({ id: r.id, ext: r.ext, bytes: r.bytes }));
  const indexedIds = new Set(idx.records.map((r) => r.id));
  const orphanFiles = scanned.files.filter((f) => !indexedIds.has(f.id)).map((f) => ({ name: f.name, bytes: f.bytes }));

  return {
    ok: true, op: 'list',
    dir,
    indexPath: assetIndexPath(dir),
    indexExists: idx.exists,
    indexNote: idx.note,
    idLen: ASSET_ID_LEN,
    maxBytes: ASSET_MAX_BYTES,
    maxBytesText: humanBytes(ASSET_MAX_BYTES),
    supportedExt: Object.keys(ASSET_EXT_MIME),
    tag,
    limit,
    summaryOnly,
    total,
    totalBytes,
    totalText: humanBytes(totalBytes),
    count: shown.length,
    // `summaryOnly` 只删清单**明细**（给 `null` 而不是 `undefined`：本仓的工具回执必须是无损 JSON，
    //   而 `undefined` 在 `JSON.stringify` 里会**整个字段消失** —— 那会让"省了体积"与"字段没实现"看起来一样）
    assets: summaryOnly ? null : shown,
    assetsOmitted: summaryOnly ? total : Math.max(0, total - shown.length),
    missingInDir,
    missingInDirCount: missingInDir.length,
    orphanFiles: summaryOnly ? orphanFiles.slice(0, 5) : orphanFiles,
    orphanFilesCount: orphanFiles.length,
    diskFileCount: scanned.files.length,
    hint: total > 0
      ? '要取回字节用 op=get（回 dataUrl，或写到 out=<绝对路径>）；要清理用 op=remove（显式 id + deleteFile）。'
      : (orphanFiles.length > 0 || idx.exists === false
        ? '**索引里一条都没有，但目录里有 ' + scanned.files.length + ' 个素材文件** —— 索引多半是丢了或被写坏了：'
          + 'op=rebuild 能从**目录内容**重建（每个文件的 sha256 现算）。'
        : '库里还没有素材：op=add 传 source=<绝对路径> / base64=<…> / dataUrl（`data:` 开头的串也可以放进 source）。'),
  };
}

/**
 * 取回一个素材。
 *
 * 两条出口**二选一**：`out`（绝对路径，写到指定位置，**逐字节**与入库时一致）或 `dataUrl`（默认）。
 * 写盘照旧走 `atomicWriteFile`。`out` 已存在时**不覆盖**（除非 `overwrite:true`）——
 * 这是「磁盘是用户的」那条规矩在**写**这一侧的对称面：不声不响盖掉别人的文件，和删掉它一样糟。
 */
export function getAsset(opts = {}) {
  const dir = opts.dir || assetsDir();
  const idx = readIndex(dir);
  const found = findRecord(idx.records, opts.id);
  if (!found.ok) return { ok: false, op: 'get', error: found.error, dir, indexNote: idx.note };
  const rec = found.rec;
  const file = fileOfRecord(dir, rec);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return {
      ok: false, op: 'get', error: '索引里有这条记录，但字节读不到（' + file + '）：' + ((e && e.message) || e)
        + ' —— 索引可能过期了，先 op=rebuild 从目录重建。',
      asset: publicRecord(rec), file, dir,
    };
  }
  const sha256 = sha256Of(buf);
  const intact = sha256 === String(rec.sha256).toLowerCase();
  const out = opts.out == null || opts.out === '' ? null : String(opts.out).trim();
  const base = {
    ok: true, op: 'get',
    resolvedBy: found.how,
    asset: publicRecord(rec),
    file,
    dir,
    bytes: buf.length,
    bytesMatch: buf.length === Number(rec.bytes),
    sha256Match: intact,
    sha256OnDisk: sha256,
  };
  if (!intact) {
    return {
      ...base, ok: false,
      error: '盘上的字节与索引记录的 sha256 对不上（索引过期 / 文件被换过）—— 没写出去。先 op=rebuild。',
    };
  }
  if (out) {
    if (!path.isAbsolute(out)) return { ...base, ok: false, error: '`out` 要是**绝对路径**（收到 ' + JSON.stringify(out) + '）' };
    if (fs.existsSync(out) && opts.overwrite !== true) {
      return { ...base, ok: false, error: '目标已存在，**不覆盖**：' + out + '（确实要盖就传 overwrite:true）' };
    }
    try { atomicWriteFile(out, buf); } catch (e) { return { ...base, ok: false, error: '写出去失败：' + ((e && e.message) || e) }; }
    return {
      ...base, out,
      note: '已写到 out（逐字节一致，见 sha256Match:true）。**没回 dataUrl** —— 要看图直接开这个文件。',
    };
  }
  return {
    ...base,
    dataUrl: toDataUrl(buf, rec.mime),
    note: '回的是 data URL（可直接喂图片查看器）；要落盘就传 out=<绝对路径>（省一次 base64 转码）。',
  };
}

/**
 * 从索引摘掉一条（**磁盘是用户的**：默认不动字节）。
 *
 * 两个开关**都显式**：
 *   · 只 `confirm:true`   → 摘索引，**盘上文件留着**（回执 `fileKept:true` 明说）；
 *   · `confirm:true` + `deleteFile:true` → 连字节一起删（回执给删掉的路径）。
 * 为什么不在 index.js 层兜底：命令行的 `remove` 最容易"顺手全删"，这里把口径钉在库里，别的调用方也躲不过。
 */
export function removeAsset(opts = {}) {
  const dir = opts.dir || assetsDir();
  const idx = readIndex(dir);
  const found = findRecord(idx.records, opts.id);
  if (!found.ok) return { ok: false, op: 'remove', error: found.error, dir, removed: false, deletedFile: false };
  const rec = found.rec;
  const file = fileOfRecord(dir, rec);
  const confirm = opts.confirm === true;
  const deleteFile = opts.deleteFile === true;
  if (!confirm) {
    return {
      ok: false, op: 'remove', removed: false, deletedFile: false,
      asset: publicRecord(rec), file, dir, needsConfirm: true,
      error: 'remove 要**显式确认**：传 confirm:true 才摘索引；连盘上字节一起删还要再给 deleteFile:true。'
        + '（**没有任何批量删的口子** —— 一次一个 id。）',
    };
  }
  const records = idx.records.filter((r) => r.id !== rec.id);
  try { writeIndex(dir, records, opts.now ? new Date(opts.now) : new Date()); } catch (e) {
    return { ok: false, op: 'remove', removed: false, deletedFile: false, error: '写索引失败：' + ((e && e.message) || e) };
  }
  let fileKept = true;
  let fileError = null;
  if (deleteFile) {
    if (!fs.existsSync(file)) {
      fileKept = false;
      fileError = '索引摘掉了，但盘上本来就没有这个文件（' + file + '）';
    } else {
      try { fs.unlinkSync(file); fileKept = false; } catch (e) { fileError = '删文件失败（索引已摘）：' + ((e && e.message) || e); }
    }
  }
  return {
    ok: !fileError || !deleteFile ? true : false,
    op: 'remove',
    removed: true,
    deletedFile: deleteFile && !fileKept,
    fileKept,
    file,
    fileError: fileError || null,
    asset: publicRecord(rec),
    dir,
    indexPath: assetIndexPath(dir),
    remaining: records.length,
    note: fileKept
      ? '**只摘了索引**，盘上的字节还在（' + file + '）—— 它现在算「无主文件」，下次 rebuild 会把它收回来。要真删给 deleteFile:true。'
      : '索引与盘上的字节都处理过了。',
  };
}

/**
 * 盘点：**只报告，不删**（要真删必须 `confirm:true`，且只删被点名的那几条）。
 *
 * 三类：① `missing` 索引有、字节不在；② `orphans` 字节在、索引没有；③ `corrupt` 字节还在但 sha256 与记录不符。
 */
export function pruneAssets(opts = {}) {
  const dir = opts.dir || assetsDir();
  const idx = readIndex(dir);
  const scanned = scanAssetFiles(dir);
  const onDisk = new Map(scanned.files.map((f) => [f.id, f]));
  const missing = [];
  const corrupt = [];
  for (const r of idx.records) {
    const f = onDisk.get(r.id);
    if (!f) { missing.push({ id: r.id, ext: r.ext, bytes: r.bytes, file: fileOfRecord(dir, r) }); continue; }
    let buf = null;
    try { buf = fs.readFileSync(path.join(dir, f.name)); } catch { corrupt.push({ id: r.id, file: path.join(dir, f.name), reason: '读不动' }); continue; }
    const sha = sha256Of(buf);
    if (sha !== String(r.sha256).toLowerCase()) corrupt.push({ id: r.id, file: path.join(dir, f.name), reason: 'sha256 与索引不符', expected: r.sha256, actual: sha });
  }
  const indexedIds = new Set(idx.records.map((r) => r.id));
  const orphans = scanned.files.filter((f) => !indexedIds.has(f.id)).map((f) => ({ name: f.name, id: f.id, ext: f.ext, bytes: f.bytes, file: path.join(dir, f.name) }));

  const targets = [...orphans.map((o) => o.file), ...corrupt.map((c) => c.file)];
  const confirm = opts.confirm === true;
  const deleted = [];
  const failed = [];
  if (confirm) {
    for (const p of targets) {
      try { fs.unlinkSync(p); deleted.push(p); } catch (e) { failed.push({ file: p, error: (e && e.message) || String(e) }); }
    }
    // 删完必须重建索引（记录里那些 sha256 对应的字节已经没了）
    if (deleted.length) { const r = rebuildIndex({ dir, now: opts.now }); return { ...r, op: 'prune', confirm: true, deleted, failed, missing, corrupt, orphans, note: '已删 ' + deleted.length + ' 个无主/损坏文件，并**重建了索引**。' }; }
  }
  return {
    ok: true,
    op: 'prune',
    dir,
    confirm,
    dryRun: !confirm,
    counts: { missing: missing.length, orphans: orphans.length, corrupt: corrupt.length, wouldDelete: targets.length },
    missing, orphans, corrupt,
    wouldDelete: targets,
    deleted: confirm ? deleted : [],
    failed,
    note: confirm
      ? '已按点名的文件删除（只删「无主」与「损坏」两类，**不碰**索引里正常的素材）。'
      : '**只报告，没删任何东西**（这是默认档）。要真删传 confirm:true —— 只删上面 `wouldDelete` 里点名的文件，'
        + '正常的素材一个都不动。',
  };
}

/**
 * 总览：总数 / 总体积 / 索引与目录是否对得上。
 * @param {{dir?:string}} [opts]
 */
export function assetStats(opts = {}) {
  const dir = opts.dir || assetsDir();
  const idx = readIndex(dir);
  const scanned = scanAssetFiles(dir);
  const onDisk = new Set(scanned.files.map((f) => f.id));
  const indexBytes = idx.records.reduce((s, r) => s + (Number(r.bytes) || 0), 0);
  const diskBytes = scanned.files.reduce((s, f) => s + f.bytes, 0);
  const byExt = {};
  for (const r of idx.records) {
    const e = r.ext || '(无)';
    byExt[e] = byExt[e] || { count: 0, bytes: 0 };
    byExt[e].count += 1;
    byExt[e].bytes += Number(r.bytes) || 0;
  }
  let indexSize = null;
  try { indexSize = fs.statSync(assetIndexPath(dir)).size; } catch { indexSize = null; }
  return {
    ok: true, op: 'stats',
    dir,
    indexPath: assetIndexPath(dir),
    indexExists: idx.exists,
    indexNote: idx.note,
    indexVersion: idx.version,
    indexUpdatedAt: idx.updatedAt,
    indexSize,
    // 统计口径写清楚：`count`/`bytes` 指**索引里的**（`diskCount`/`diskBytes` 指**目录里的**）
    count: idx.records.length,
    bytes: indexBytes,
    bytesText: humanBytes(indexBytes),
    diskCount: scanned.files.length,
    diskBytes,
    diskBytesText: humanBytes(diskBytes),
    /** 两边对得上 = 索引与目录一致（不一致时先 op=rebuild） */
    inSync: idx.records.length === scanned.files.length && idx.records.every((r) => onDisk.has(r.id)),
    missingInDir: idx.records.filter((r) => !onDisk.has(r.id)).length,
    orphanFiles: scanned.files.filter((f) => !idx.records.some((r) => r.id === f.id)).length,
    byExt,
    idLen: ASSET_ID_LEN,
    maxBytes: ASSET_MAX_BYTES,
    maxBytesText: humanBytes(ASSET_MAX_BYTES),
    supportedExt: Object.keys(ASSET_EXT_MIME),
  };
}
