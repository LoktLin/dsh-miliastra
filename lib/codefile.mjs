/**
 * codefile.mjs — 活文件（沙箱里的 .lua）的读、备份、部署、校验
 *
 * 把 AGENTS.md 里的铁律固化成一步：
 *   · 拷**二进制**（绝不"读文本再写文本"，中文注释会被转码毁掉）
 *   · 拷完**比对 SHA-256**
 *   · **绝对不加 UTF-8 BOM**（原神日志实测会打印
 *     `Read text file with BOM header may cause Lua error`，带 BOM 的脚本会让 Lua 报错）
 *   · **部署前先备份**（脚本没有 git、没有撤销，覆盖即丢失）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

export function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

export function firstHex(buf, n = 4) {
  return [...buf.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

/** 严格 UTF-8 解码（非法字节返回 null）。 */
export function decodeStrict(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 体检一个文件（不修改）。 */
export function inspect(file) {
  const st = fs.statSync(file);
  const buf = fs.readFileSync(file);
  const text = decodeStrict(buf);
  return {
    path: file,
    size: st.size,
    mtime: st.mtime.toISOString(),
    sha256: sha256(buf),
    firstBytes: firstHex(buf),
    bom: hasBom(buf),
    utf8Ok: text !== null,
    lineCount: text === null ? null : text.split(/\r?\n/).length,
    hasChinese: text === null ? null : /[\u4e00-\u9fff]/.test(text),
  };
}

/** 默认备份目录：环境变量 MILIASTRA_BACKUP_DIR > 调用方给的 > 与活文件同级的 _backup。 */
export function defaultBackupDir(dest, explicit) {
  if (explicit) return explicit;
  if (process.env.MILIASTRA_BACKUP_DIR) return process.env.MILIASTRA_BACKUP_DIR;
  return path.join(path.dirname(dest), '_backup');
}

/** 备份文件名：`<原名>_<YYYYMMDDHHMMSS>_备份.lua`；**同秒撞名时自动加 -2 / -3**。 */
export function backupFileName(dir, dest, at = new Date()) {
  const base = path.basename(dest).replace(/\.lua$/i, '');
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let candidate = path.join(dir, `${base}_${stamp}_备份.lua`);
  let n = 1;
  // 时间戳只到秒 —— 同一秒内连续部署两次就会撞名，撞了就覆盖掉前一份备份。
  // 备份是「脚本没有 git」时的唯一安全网，**绝不能悄悄覆盖**，所以这里显式顺延。
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base}_${stamp}-${n}_备份.lua`);
  }
  return candidate;
}

/**
 * 备份一个活文件（不改动它）。还原与部署都走这里。
 * @returns {{ok:boolean, backup:string, bytes:number, sha256:string, error?:string}}
 */
export function backupFile(dest, { backupDir } = {}) {
  if (!fs.existsSync(dest)) return { ok: false, error: '要备份的文件不存在：' + dest };
  const dir = defaultBackupDir(dest, backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = backupFileName(dir, dest);
  fs.copyFileSync(dest, target);
  const a = sha256(fs.readFileSync(target));
  const b = sha256(fs.readFileSync(dest));
  if (a !== b) return { ok: false, error: '备份校验失败（SHA 不一致）：' + target, backup: target };
  const st = fs.statSync(target);
  return { ok: true, backup: target, bytes: st.size, sha256: a, mtime: st.mtime.toISOString() };
}

/** 列出某个活文件的所有备份（按时间倒序）。 */
export function listBackups(dest, { backupDir } = {}) {
  const dir = defaultBackupDir(dest, backupDir);
  if (!fs.existsSync(dir)) return { dir, entries: [] };
  const base = path.basename(dest).replace(/\.lua$/i, '');
  const entries = fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.lua') && (n.startsWith(base + '_') || n === base + '.lua'))
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        const buf = fs.readFileSync(full);
        return { name: n, path: full, size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs, sha256: sha256(buf), bom: hasBom(buf) };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dir, entries };
}

/**
 * 还原：把某份备份写回活文件。
 *
 * ⚠️ **这会覆盖活文件**，所以固定走「双保险」：
 *   ① 还原前先把**当前版本**再自动备份一份（还原错了还能再回来）；
 *   ② 覆盖后比对 SHA-256；③ 把两份备份路径都回报出来。
 *
 * @param {string} backupPath 要还原的备份文件
 * @param {string} dest       目标活文件
 * @returns 结果 + `safetyBackup`（还原前的当前版本备份）
 */
export function restore(backupPath, dest, { backupDir } = {}) {
  if (!fs.existsSync(backupPath)) return { ok: false, error: '备份文件不存在：' + backupPath };
  const buf = fs.readFileSync(backupPath);
  if (hasBom(buf)) return { ok: false, error: '该备份带 UTF-8 BOM —— 会让 Lua 报错，拒绝还原' };
  if (decodeStrict(buf) === null) return { ok: false, error: '该备份不是合法 UTF-8 —— 拒绝还原（中文注释可能已损坏）' };

  let safetyBackup = null;
  if (fs.existsSync(dest)) {
    const s = backupFile(dest, { backupDir });
    if (!s.ok) return { ok: false, error: '还原前的前置备份失败，已中止：' + s.error };
    safetyBackup = s.backup;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(backupPath, dest);
  const verified = sha256(fs.readFileSync(dest)) === sha256(buf);
  return {
    ok: verified,
    restoredFrom: backupPath,
    dest,
    bytes: buf.length,
    sha256: sha256(fs.readFileSync(dest)),
    verified,
    safetyBackup,
    errors: verified ? [] : ['还原后哈希不一致'],
  };
}

/**
 * 部署一个脚本到活文件位置：先备份旧的 → 二进制拷新的 → 校验。
 * @returns {{ok:boolean, dest:string, bytes:number, sha256:string, verified:boolean,
 *            bomFree:boolean, utf8Ok:boolean, backup:string|null, errors:string[]}}
 */
export function deploy(src, dest, { backupDir, noBackup = false } = {}) {
  const errors = [];
  if (!fs.existsSync(src)) return { ok: false, errors: ['源文件不存在：' + src], dest };
  const srcBuf = fs.readFileSync(src);
  const srcSha = sha256(srcBuf);
  const bomFree = !hasBom(srcBuf);
  const utf8Ok = decodeStrict(srcBuf) !== null;
  if (!bomFree) errors.push('源文件带 UTF-8 BOM —— 会让 Lua 报错，拒绝部署');
  if (!utf8Ok) errors.push('源文件不是合法 UTF-8 —— 拒绝部署（中文注释可能已损坏）');
  if (errors.length) return { ok: false, errors, dest, bytes: srcBuf.length, sha256: srcSha };

  let backup = null;
  if (!noBackup && fs.existsSync(dest)) {
    const b = backupFile(dest, { backupDir });
    if (!b.ok) errors.push('备份失败：' + b.error);
    else backup = b.backup;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);

  const destBuf = fs.readFileSync(dest);
  const destSha = sha256(destBuf);
  const verified = destSha === srcSha;
  if (!verified) errors.push(`部署后哈希不一致：src=${srcSha.slice(0, 12)} dest=${destSha.slice(0, 12)}`);
  if (hasBom(destBuf)) errors.push('部署后文件出现 BOM —— 异常');

  return {
    ok: errors.length === 0,
    src,
    dest,
    bytes: destBuf.length,
    sha256: destSha,
    srcSha256: srcSha,
    verified,
    bomFree: !hasBom(destBuf),
    utf8Ok: decodeStrict(destBuf) !== null,
    backup,
    errors,
  };
}

/** 从活文件目录里挑一个 .lua（按最近改动）。 */
export function pickLuaFile(luaDir) {
  if (!luaDir || !fs.existsSync(luaDir)) return null;
  const files = fs.readdirSync(luaDir)
    .filter((n) => n.toLowerCase().endsWith('.lua'))
    .map((n) => ({ name: n, path: path.join(luaDir, n), ...(fs.statSync(path.join(luaDir, n))) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] || null;
}
