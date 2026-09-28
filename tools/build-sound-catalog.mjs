#!/usr/bin/env node
/**
 * build-sound-catalog.mjs — **音效库快照的生成脚本（唯一真身）**。
 *
 * 作用：把第三方镜像 `xiaomoL444/ugc-tool` 的 SoundEffectPlayer 数据（3 个 JSON）
 * 压成一个小快照 `lib/sounds/catalog.json`，供 `lib/sounds/search.mjs` 离线模糊搜索。
 * **运行时不再联网**（那三个 URL 只在"重跑这个脚本"时用）。
 *
 * ## 取数出处（镜像，**不是** miHoYo 官方端点）
 *
 *   https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/data.json            → 本地镜像文件名 sound-data.json
 *   https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/i18n/zh-cn.json      → sound-zh-cn.json
 *   https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/i18n/en-us.json      → sound-en-us.json
 *
 * ⚠️ **镜像 ≠ 官方**：这 3 个文件的字节哈希在下面 `SOUND_SOURCE.sha256` 里钉死。
 *    官方更新后镜像一变，脚本会**直接拒绝**（除非显式 `--allow-sha-mismatch`）——
 *    这是刻意的：静默换数据比报错危险得多（名字与时长会跟着变）。
 *
 * ## 用法
 *
 *   node tools/build-sound-catalog.mjs                      # 用默认镜像目录重建快照
 *   node tools/build-sound-catalog.mjs --src <目录>          # 换镜像目录
 *   node tools/build-sound-catalog.mjs --generated-at <ISO>  # 钉住生成时间（可复现构建）
 *   node tools/build-sound-catalog.mjs --check               # 只校验：现有快照 == 重建结果？
 *   node tools/build-sound-catalog.mjs --allow-sha-mismatch  # 明知镜像变了仍要重建
 *
 * ## 时长单位（`duration` 字符串 → `durationMs` 数值毫秒）
 *
 * `data.json` 的 `duration` 是**字符串形式的秒**（如 `"39.862"`），换算：
 * `durationMs = Math.round(parseFloat(duration) * 1000)`。依据（`from-source`，非推测）：
 *   · `ugc-tool-main/src/i18n/locales/soundEffectPlayer/zh-cn.json` 的
 *     `"soundEffectPlayer.ui.soundDetails": "ID：{id} / {duration} 秒"`（en-us 写 `"{duration} s"`），
 *     而 `SoundEffectPlayer.vue:52` 正是把 **原始字符串** 填进 `{duration}`；
 *   · 同一页面 `formatTime(sec)`（`SoundEffectPlayer.vue:813`）吃的是 `HTMLAudioElement.duration`（秒），
 *     与 `data.json` 的 `duration` 同量纲、同一个波形条；
 *   · 数值范围也自证：0.047 ~ 106.857。若当毫秒 ⇒ 全部音效 ≤ 0.107 秒（分类 1「环境」最大 106.857 毫秒 = 0.1 秒，荒谬）。
 * 细则与证据见 `docs/千星奇域_音效库拓扑_2026-09-28.md` §2。
 *
 * ## 快照丢了什么（刻意的）
 *
 * 丢掉 `path`（`audio/<id>.mp3`，可由 id 推出）、`nameI18nKey`（`soundEffectPlayer.data.<id>`，同可由 id 推出）、
 * `order`（分类内展示序）与 `giVersion`（1997 条全是 `"7.0"`，零信息量）。
 * `order` 的**信息没丢**：脚本按 `id` 升序落盘，而每个分类内 `id` 升序 ≡ `order` 升序
 * （生成时用 `assertOrderRecoverable` 断言这条，破了就拒绝写盘）。
 *
 * ⚠️ 写盘一律走 `lib/fsx.mjs` 的原子写（本仓铁律，别手搓 tmp+rename）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../lib/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 快照格式版本（结构变了才动它）。 */
export const CATALOG_VERSION = 1;

/** 取数出处 + 输入文件哈希（**唯一真身**：重跑与代码审查都看这里）。 */
export const SOUND_SOURCE = Object.freeze({
  dataUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/data.json',
  zhUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/i18n/zh-cn.json',
  enUrl: 'https://oss.xiaomol444.xyz/ugc-tool-data/SoundEffectPlayer/i18n/en-us.json',
  files: { data: 'sound-data.json', zh: 'sound-zh-cn.json', en: 'sound-en-us.json' },
  sha256: {
    data: '0296cf0b4210a46776dc8ee946018d5767649932010dbc2b607407cc6fb2182c',
    zh: 'a843a85143489066eb289100b8ac8b4c891e4ef69054717b44ecf75f60fd7bbb',
    en: 'aff90a986f326617415a5e6b37ed6f809d894efc559023e42515fd83064cd653',
  },
  /** 本地镜像的抓取时刻（`from-mirror`，取自镜像文件 mtime：2026-09-28 23:58 本地时间）。 */
  fetchedAt: '2026-09-28',
  mirrorNote: '镜像 ≠ 官方：数据取自第三方镜像 oss.xiaomol444.xyz，不是 miHoYo 官方端点',
});

/** 默认镜像目录：工作区里的 `tmp/ugc-asset-catalog`（**不进仓库**）。 */
export const DEFAULT_SRC_DIR = path.resolve(ROOT, '../../tmp/ugc-asset-catalog');

/** 快照落盘位置。 */
export const CATALOG_PATH = path.join(ROOT, 'lib', 'sounds', 'catalog.json');

/** `duration`（字符串秒）→ 数值毫秒。理由见文件头。 */
export function toDurationMs(duration) {
  const sec = Number.parseFloat(String(duration));
  if (!Number.isFinite(sec) || sec < 0) throw new Error('duration 不是合法秒数：' + JSON.stringify(duration));
  return Math.round(sec * 1000);
}

/**
 * 每个分类内「id 升序 ≡ order 升序」——`order` 被丢掉之后，这条是"展示序没丢"的**唯一凭证**。
 * 破了就抛（宁可拒绝生成，也不要静默产出一份信息不全的快照）。
 * @param {any[]} data 源 `data.json` 的 `data[]`
 * @param {any[]} sounds 快照里的 `sounds[]`（已按 id 升序）
 */
export function assertOrderRecoverable(data, sounds) {
  const orderOf = new Map(data.map((s) => [String(s.id), Number(s.order)]));
  /** @type {Map<number, string[]>} */
  const byCat = new Map();
  for (const s of sounds) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    const arr = byCat.get(s.category);
    if (arr) arr.push(s.id);
  }
  for (const [cat, ids] of byCat) {
    for (let i = 1; i < ids.length; i += 1) {
      const prev = orderOf.get(ids[i - 1]);
      const cur = orderOf.get(ids[i]);
      if (!(typeof prev === 'number' && typeof cur === 'number' && prev < cur)) {
        throw new Error(`分类 ${cat} 内 id 升序 ≠ order 升序（${ids[i - 1]} 之后是 ${ids[i]}）`
          + ' —— `order` 不能安全丢掉，请改回保留该字段');
      }
    }
  }
  return true;
}

/**
 * **纯函数**：三份源 JSON → 快照对象（不读盘、不写盘，测试直接吃）。
 *
 * @param {{data: any, zh: any, en: any, generatedAt?: string}} payload
 *        `data` = `data.json` 解析结果；`zh` / `en` = 两个 i18n 词表（`{ "soundEffectPlayer.data.10001": "环境_震动" }`）
 * @returns {any} 快照对象（结构见 `lib/sounds/catalog.json`）
 */
export function buildCatalog({ data, zh, en, generatedAt }) {
  if (!data || !Array.isArray(data.data) || !Array.isArray(data.category)) {
    throw new Error('data.json 结构不对：期望 { data: [], category: [] }');
  }
  if (!zh || typeof zh !== 'object' || !en || typeof en !== 'object') {
    throw new Error('i18n 词表结构不对：期望 { "soundEffectPlayer.data.<id>": "名字" }');
  }
  const name = (dict, id) => {
    const v = dict['soundEffectPlayer.data.' + id];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };

  /** 只保留 id 升序（源文件本来就是 id 升序，这里显式排一次，免得源一变就悄悄改变落盘顺序）。 */
  const src = [...data.data].sort((a, b) => Number(a.id) - Number(b.id));
  const sounds = src.map((s) => ({
    id: String(s.id),
    nameZh: name(zh, s.id),
    nameEn: name(en, s.id),
    category: Number(s.category),
    durationMs: toDurationMs(s.duration),
  }));

  /** 分类计数从 `sounds` 现算（不抄 `data.category` 的顺序/内容，避免两份计数对不上）。 */
  const counts = new Map();
  for (const s of sounds) counts.set(s.category, (counts.get(s.category) || 0) + 1);
  const categories = [...data.category]
    .map((c) => ({
      id: Number(c.id),
      nameZh: zh['soundEffectPlayer.category.' + c.id] ?? null,
      nameEn: en['soundEffectPlayer.category.' + c.id] ?? null,
      count: counts.get(Number(c.id)) || 0,
    }))
    .sort((a, b) => a.id - b.id);

  assertOrderRecoverable(data.data, sounds);

  return {
    version: CATALOG_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    durationUnit: 's',
    durationMsFormula: 'Math.round(parseFloat(duration) * 1000)',
    durationBasis: 'soundEffectPlayer.ui.soundDetails = "ID：{id} / {duration} 秒"（SoundEffectPlayer.vue:52 填的就是原始字符串）',
    source: {
      generator: 'tools/build-sound-catalog.mjs',
      dataUrl: SOUND_SOURCE.dataUrl,
      zhUrl: SOUND_SOURCE.zhUrl,
      enUrl: SOUND_SOURCE.enUrl,
      files: { ...SOUND_SOURCE.files },
      sha256: { ...SOUND_SOURCE.sha256 },
      fetchedAt: SOUND_SOURCE.fetchedAt,
      mirrorNote: SOUND_SOURCE.mirrorNote,
    },
    soundCount: sounds.length,
    categories,
    sounds,
  };
}

/**
 * 序列化成落盘文本：**每条音效独占一行**（`JSON.stringify(c, null, 2)` 会把 1997 条摊成 5 行/条，
 * git diff 变得没法看）。顶层键仍是常规两空格缩进，结尾一个 LF。
 * @param {any} catalog `buildCatalog` 的产物
 */
export function serializeCatalog(catalog) {
  const lines = catalog.sounds.map((s) => '    ' + JSON.stringify(s)).join(',\n');
  const head = JSON.stringify({ ...catalog, sounds: '__SOUNDS__' }, null, 2);
  if (!head.includes('"__SOUNDS__"')) throw new Error('序列化占位符没命中（结构变了？）');
  return head.replace('"__SOUNDS__"', '[\n' + lines + '\n  ]') + '\n';
}

/** 读三份源 JSON 并校验哈希；返回 `{ data, zh, en }` 与实测哈希。 */
export function readSource(srcDir, { allowShaMismatch = false } = {}) {
  const read = (file) => {
    const p = path.join(srcDir, file);
    if (!fs.existsSync(p)) {
      throw new Error('找不到源文件：' + p + '\n（镜像是本地工作区的临时副本，不在仓库里；'
        + '要么把 3 个 JSON 放到这里，要么 --src <目录>）');
    }
    const buf = fs.readFileSync(p);
    return { buf, sha: crypto.createHash('sha256').update(buf).digest('hex') };
  };
  const out = {};
  const mismatched = [];
  for (const key of ['data', 'zh', 'en']) {
    const { buf, sha } = read(SOUND_SOURCE.files[key]);
    if (sha !== SOUND_SOURCE.sha256[key]) mismatched.push(`${SOUND_SOURCE.files[key]}（期望 ${SOUND_SOURCE.sha256[key]}，实得 ${sha}）`);
    out[key] = JSON.parse(buf.toString('utf8'));
    out[key + 'Sha'] = sha;
  }
  if (mismatched.length && !allowShaMismatch) {
    throw new Error('源文件哈希与 SOUND_SOURCE.sha256 不一致：\n  - ' + mismatched.join('\n  - ')
      + '\n镜像/官方可能更新了 —— 先核对名字与时长有没有变，确认无误再 --allow-sha-mismatch 并把新哈希写回 SOUND_SOURCE。');
  }
  return out;
}

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n, d = null) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  try {
    const srcDir = value('--src', DEFAULT_SRC_DIR);
    const out = value('--out', CATALOG_PATH);
    const check = flag('--check');
    const allowShaMismatch = flag('--allow-sha-mismatch');
    const pinned = value('--generated-at', null);

    const src = readSource(srcDir, { allowShaMismatch });
    const committed = check && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    const catalog = buildCatalog({
      data: src.data, zh: src.zh, en: src.en,
      generatedAt: pinned || (committed && committed.generatedAt) || undefined,
    });
    const text = serializeCatalog(catalog);

    if (check) {
      if (!fs.existsSync(out)) throw new Error('--check：快照不存在：' + out);
      const now = fs.readFileSync(out, 'utf8');
      if (now === text) {
        console.log('✓ --check：快照与重建结果**逐字节一致**（' + Buffer.byteLength(text, 'utf8') + ' 字节）');
        process.exit(0);
      }
      const a = now.split('\n');
      const b = text.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      console.log('✗ --check：快照与重建结果不一致（第一个不同的行 #' + (i + 1) + '）');
      console.log('  快照：' + String(a[i]).slice(0, 200));
      console.log('  重建：' + String(b[i]).slice(0, 200));
      console.log('  重跑 `node tools/build-sound-catalog.mjs` 更新快照。');
      process.exit(1);
    }

    atomicWriteFile(out, Buffer.from(text, 'utf8'));
    const bytes = Buffer.byteLength(text, 'utf8');
    console.log('✓ 已生成 ' + path.relative(ROOT, out).split(path.sep).join('/')
      + '：' + catalog.soundCount + ' 条音效 / ' + catalog.categories.length + ' 个分类 / '
      + (bytes / 1024).toFixed(1) + ' KB（' + bytes + ' 字节）');
    console.log('  分类计数：' + catalog.categories.map((c) => `${c.id}=${c.count}`).join(' '));
    console.log('  分类名：' + catalog.categories.map((c) => `${c.id}:${c.nameZh}`).join(' / '));
    console.log('  generatedAt=' + catalog.generatedAt + '  durationUnit=' + catalog.durationUnit
      + '  durationMs 范围=' + Math.min(...catalog.sounds.map((s) => s.durationMs)) + '~'
      + Math.max(...catalog.sounds.map((s) => s.durationMs)));
    const missingZh = catalog.sounds.filter((s) => s.nameZh === null).length;
    const missingEn = catalog.sounds.filter((s) => s.nameEn === null).length;
    if (missingZh || missingEn) console.log('  ⚠️ 缺名：zh ' + missingZh + ' 条 / en ' + missingEn + ' 条（源词表没覆盖）');
    console.log('  源 sha256：data=' + src.dataSha.slice(0, 10) + ' zh=' + src.zhSha.slice(0, 10) + ' en=' + src.enSha.slice(0, 10));
  } catch (e) {
    console.error('✗ ' + ((e && e.message) || e));
    process.exit(1);
  }
}
