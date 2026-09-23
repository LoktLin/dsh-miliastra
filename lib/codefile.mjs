/**
 * codefile.mjs — 活文件（沙箱里的 .lua）的读、备份、部署、校验
 *
 * 把 AGENTS.md 里的铁律固化成一步：
 *   · 拷**二进制**（绝不"读文本再写文本"，中文注释会被转码毁掉）
 *   · 拷完**比对 SHA-256**
 *   · **绝对不加 UTF-8 BOM**（原神日志实测会打印
 *     `Read text file with BOM header may cause Lua error`，带 BOM 的脚本会让 Lua 报错）
 *   · **部署前先备份**（脚本没有 git、没有撤销，覆盖即丢失）
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 安全约定（2026-09-23 作者要求「再查查会不会把用户的 lua 给吃了」后重做的）
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 活文件是**唯一副本**：它只活在米哈游的本地存档目录里，没有 git、没有撤销。
 * 所以这里的每一条都是「宁可失败，也不许损坏」：
 *
 *   ① **备份失败 → 立即中止覆盖**。以前是「记一笔错误，然后照样覆盖」——
 *      备份失败（磁盘满 / 无权限 / 路径过长）时会把唯一副本直接抹掉。
 *   ② **原子写**：写同目录临时文件 → fsync → rename 覆盖。
 *      直接 `copyFileSync` 到目标时，断电 / 蓝屏 / 进程被杀会让目标停在半截，
 *      等于永久损坏。rename 在同一卷上是原子的：要么还是旧内容，要么已是完整新内容。
 *   ③ **写完必校验 SHA**；校验不过**自动回滚**到刚备份的那一版。
 *   ④ **备份就放在被替换文件的旁边**：`<活文件目录>\_backup\`。
 *   ⑤ **固定名备份** `<原名>.bak` —— 永远指向「最近一次覆盖前的版本」，
 *      还原不用再去翻时间戳、不会选错版本；同时保留一份带时间戳的历史（永不自动删）。
 *   ⑥ 备份名里的时间戳用**本地时间**（以前用 UTC，比本地少 8 小时，看着像错的）。
 *   ⑦ 备份文件的 mtime 显式设成**备份创建时间** —— `copyFileSync` 会沿用源文件 mtime，
 *      导致「按时间排最新备份」失效、界面上显示的备份时间也是错的。
 *   ⑧ `noBackup` 不能随手用：必须同时传 `allowNoBackup: true`。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lintLua, lintSummary } from './lualint.mjs';

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

/* ------------------------------------------------------------------ 原子写 */

/**
 * 原子替换写入。**所有会改动活文件的地方都必须走这里。**
 *
 * 写同目录临时文件 → fsync（把数据真正刷到盘上）→ rename 覆盖。
 * 同一卷上的 rename 是原子操作：目标要么还是旧内容，要么已经是完整的新内容，
 * 不存在「写了一半」的中间态。
 *
 * @returns {string} dest
 * @throws 写失败时抛出（调用方负责回报，并知道**旧文件仍然完好**）
 */
export function atomicWriteFile(dest, buf) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件必须与目标**同目录**（跨卷 rename 会失败并退化成非原子拷贝）
  const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);          // 先落盘，再改名
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, dest);  // 同卷原子替换
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return dest;
}

/* ------------------------------------------------------------ 备份：路径与命名 */

/**
 * 校验不过时把「覆盖前那一版」写回去。
 *
 * 单独抽出来是为了**能测**：真正触发「写完校验不过」需要磁盘损坏，
 * 没法在测试里自然构造；而「回滚这一步本身对不对」是可以直接测的
 * （给它一份内容，看它是不是把目标恢复成那一版）。组合关系在 deploy/restore 里只有一行。
 *
 * @returns {{rolledBack:boolean, rollbackError:string|null}}
 */
export function rollbackTo(dest, beforeBuf) {
  if (!beforeBuf) return { rolledBack: false, rollbackError: '没有可回滚的内容' };
  try {
    atomicWriteFile(dest, beforeBuf);
    const same = sha256(fs.readFileSync(dest)) === sha256(beforeBuf);
    return { rolledBack: same, rollbackError: same ? null : '回滚后哈希仍不一致' };
  } catch (e) {
    return { rolledBack: false, rollbackError: (e && e.message) || String(e) };
  }
}

/**
 * 备份目录：**永远在被替换文件的旁边**。
 * 默认 `<活文件目录>\_backup\`。
 * `MILIASTRA_BACKUP_DIR` 只为测试隔离用（指到别处时，返回值里仍会报出真实绝对路径）。
 */
export function defaultBackupDir(dest, explicit) {
  if (explicit) return explicit;
  if (process.env.MILIASTRA_BACKUP_DIR) return process.env.MILIASTRA_BACKUP_DIR;
  return path.join(path.dirname(dest), '_backup');
}

/** 本地时间戳 `YYYYMMDD-HHMMSS`（**不用 UTC**：以前用 UTC，比本地少 8 小时，看着像错的）。 */
export function localStamp(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/** 把备份文件名里的本地时间戳解析回 Date（排序用；解析不了返回 null）。 */
export function stampOfName(name) {
  const m = /(\d{8})-(\d{6})/.exec(String(name || ''));
  if (!m) return null;
  // 拼成 `YYYYMMDDHHMMSS`（把 `-` 去掉）后按下标切 —— 注意切的是 8/10/12，不是 9/11/13。
  const s = m[1] + m[2];
  const d = new Date(
    Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)),
    Number(s.slice(8, 10)), Number(s.slice(10, 12)), Number(s.slice(12, 14)),
  );
  return isNaN(d.getTime()) ? null : d;
}

/** 历史备份文件名：`<原名>.<YYYYMMDD-HHMMSS>_备份.lua`；同秒撞名顺延 `-2 / -3`。 */
export function backupFileName(dir, dest, at = new Date()) {
  const base = path.basename(dest).replace(/\.lua$/i, '');
  const stamp = localStamp(at);
  let candidate = path.join(dir, `${base}.${stamp}_备份.lua`);
  let n = 1;
  // 时间戳只到秒 —— 同一秒内连续部署两次就会撞名，撞了就覆盖掉前一份备份。
  // 备份是「脚本没有 git」时的唯一安全网，**绝不能悄悄覆盖**，所以这里显式顺延。
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${base}.${stamp}-${n}_备份.lua`);
  }
  return candidate;
}

/** **固定名备份**：`<原名>.bak` —— 永远指向「最近一次覆盖前的版本」，还原不用再找。 */
export function fixedBackupPath(dir, dest) {
  return path.join(dir, path.basename(dest).replace(/\.lua$/i, '') + '.bak');
}

/** 这个名字看起来是不是「探针源码 / 备份」而不是用户的活文件？（用于选择器护栏） */
export function isAuxiliaryLuaName(name) {
  const n = String(name || '');
  return /^_探针_/.test(n) || /_备份\.lua$/i.test(n) || /\.bak$/i.test(n) || /^\./.test(n);
}

/* ------------------------------------------------------------------ 体检 */

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

/* ------------------------------------------------------------------ 备份 */

/**
 * 备份一个活文件（不改动它）。部署与还原都走这里。
 *
 * 写**两份**：
 *   · 历史：`<原名>.<本地时间戳>_备份.lua` —— 只增不删，撞名顺延
 *   · 固定名：`<原名>.bak` —— 永远指向最近一次覆盖前的版本，还原的默认目标
 *
 * ⚠️ 备份也走**原子写**：备份本身写坏了，等于安全网破了个洞。
 * ⚠️ 显式把备份的 mtime 设成**现在**：`copyFileSync` 会沿用源文件 mtime
 *    （实测），那样「按时间取最新备份」就是错的。
 *
 * @returns {{ok:boolean, backup:string, fixed:string, dir:string, bytes:number, sha256:string, createdAt:string, error?:string}}
 */
export function backupFile(dest, { backupDir } = {}) {
  if (!fs.existsSync(dest)) return { ok: false, error: '要备份的文件不存在：' + dest };
  const dir = defaultBackupDir(dest, backupDir);
  const buf = fs.readFileSync(dest);
  const want = sha256(buf);
  const at = new Date();
  const archive = backupFileName(dir, dest, at);
  const fixed = fixedBackupPath(dir, dest);
  try {
    atomicWriteFile(archive, buf);
    atomicWriteFile(fixed, buf);
    // 备份时间 = 备份创建时间（不是被备份文件的 mtime）
    fs.utimesSync(archive, at, at);
    fs.utimesSync(fixed, at, at);
  } catch (e) {
    return { ok: false, dir, error: '写备份失败（' + (e && e.message) + '）：' + dir, backup: null, fixed: null };
  }
  const gotA = sha256(fs.readFileSync(archive));
  const gotF = sha256(fs.readFileSync(fixed));
  if (gotA !== want || gotF !== want) {
    return { ok: false, dir, error: '备份校验失败（SHA 不一致）：' + archive, backup: archive, fixed };
  }
  return {
    ok: true, backup: archive, fixed, dir,
    bytes: buf.length, sha256: want, createdAt: at.toISOString(),
  };
}

/** 列出某个活文件的所有备份（按备份时间倒序，固定名那份标 `fixed:true`）。 */
export function listBackups(dest, { backupDir } = {}) {
  const dir = defaultBackupDir(dest, backupDir);
  const base = path.basename(dest).replace(/\.lua$/i, '');
  if (!fs.existsSync(dir)) return { dir, base, fixedPath: fixedBackupPath(dir, dest), entries: [] };
  const fixedName = base + '.bak';
  const entries = fs.readdirSync(dir)
    // 匹配三种：固定名 `<base>.bak`、新历史 `<base>.<stamp>_备份.lua`、旧历史 `<base>_<stamp>_备份.lua`
    .filter((n) => n === fixedName || n.startsWith(base + '.') || n.startsWith(base + '_'))
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        const buf = fs.readFileSync(full);
        const stamped = stampOfName(n);
        return {
          name: n, path: full, size: st.size,
          createdAt: st.mtime.toISOString(),
          createdAtMs: st.mtimeMs,
          // 文件名里的时间戳（比 mtime 更可信：mtime 可能被外部工具改过）
          stampedAt: stamped ? stamped.toISOString() : null,
          fixed: n === fixedName,
          sha256: sha256(buf), bom: hasBom(buf), utf8Ok: decodeStrict(buf) !== null,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    // 排序口径：优先用文件名里的时间戳（= 备份创建时刻），缺失才退回 mtime；
    // 时间并列时**固定名那份排前面** —— 它按定义就是「最近一次覆盖前的版本」。
    .sort((a, b) => {
      const ta = Date.parse(a.stampedAt || a.createdAt) || 0;
      const tb = Date.parse(b.stampedAt || b.createdAt) || 0;
      if (tb !== ta) return tb - ta;
      if (a.fixed !== b.fixed) return a.fixed ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });
  return { dir, base, fixedPath: fixedBackupPath(dir, dest), entries };
}

/* ------------------------------------------------------------------ 还原 */

/** 拼一条给人和 AI 都能直接照抄的还原命令。 */
export function restoreCommand(backupPath, dest) {
  return `miliastra_code op=restore backup=${backupPath}` + (dest ? ` file=${path.basename(dest)}` : '');
}

/**
 * 还原：把某份备份写回活文件。
 *
 * @param {string|null} backupPath 备份文件路径；传 null / 'latest' → 用**固定名** `<原名>.bak`
 *
 * ⚠️ **这会覆盖活文件**，所以固定走「双保险」：
 *   ① 还原前先把**当前版本**再自动备份一份（还原错了还能再回来）；
 *   ② **原子写** + 覆盖后比对 SHA-256；
 *   ③ **校验不过自动回滚**到「还原前那一版」—— 不留半损坏状态；
 *   ④ 无论成败都回报 `safetyBackup`（还原前那一版）与可照抄的下一步。
 */
export function restore(backupPath, dest, { backupDir } = {}) {
  const dir = defaultBackupDir(dest, backupDir);
  // 不传就用固定名 —— 这是「固定统一备份名」的用处：还原有确定目标，不用翻时间戳
  const target = (!backupPath || backupPath === 'latest')
    ? fixedBackupPath(dir, dest)
    : backupPath;
  const usingFixed = !backupPath || backupPath === 'latest';

  if (!fs.existsSync(target)) {
    return {
      ok: false, dest, backupDir: dir, resolvedFrom: target,
      error: usingFixed ? '还没有固定名备份（<原名>.bak）—— 说明这个活文件从没被覆盖过，或备份目录不对' : '备份文件不存在：' + target,
      nextSteps: ['先跑 miliastra_code op=backups 看有哪些备份', '再用 op=restore backup=<上面列出的 path> 指定一份'],
    };
  }

  const buf = fs.readFileSync(target);
  if (hasBom(buf)) {
    return {
      ok: false, dest, backupDir: dir, resolvedFrom: target,
      error: '这份备份带 UTF-8 BOM —— 带 BOM 的脚本会让 Lua 报错，拒绝还原',
      nextSteps: ['换一份不带 BOM 的备份（op=backups 里 bom 为 false 的那些）', '活文件当前未被改动'],
    };
  }
  if (decodeStrict(buf) === null) {
    return {
      ok: false, dest, backupDir: dir, resolvedFrom: target,
      error: '这份备份不是合法 UTF-8 —— 中文注释可能已损坏，拒绝还原',
      nextSteps: ['换一份 utf8Ok 为 true 的备份', '活文件当前未被改动'],
    };
  }

  // ① 前置安全备份（失败即中止 —— 不能在没有退路的情况下覆盖）
  let safetyBackup = null;
  let safetyBuf = null;
  if (fs.existsSync(dest)) {
    const s = backupFile(dest, { backupDir });
    if (!s.ok) {
      return {
        ok: false, dest, backupDir: dir, resolvedFrom: target,
        error: '还原前的前置备份失败，已中止（活文件未改动）：' + s.error,
        nextSteps: ['检查 ' + dir + ' 是否可写、磁盘是否已满', '腾出空间后重试'],
      };
    }
    safetyBackup = s.fixed || s.backup;   // 用固定名那份：它会被后续备份覆盖，这里先记路径
    safetyBuf = fs.readFileSync(safetyBackup);
  }

  // ② 原子写
  try {
    atomicWriteFile(dest, buf);
  } catch (e) {
    return {
      ok: false, dest, backupDir: dir, resolvedFrom: target, safetyBackup,
      error: '写入失败（原文件应当仍完好）：' + (e && e.message),
      nextSteps: ['先确认活文件内容：miliastra_code op=inspect', '必要时用备份手动覆盖：' + restoreCommand(target, dest)],
    };
  }

  // ③ 校验；不过就**自动回滚**
  const verified = sha256(fs.readFileSync(dest)) === sha256(buf);
  if (verified) {
    return {
      ok: true, restoredFrom: target, dest, backupDir: dir, resolvedFrom: target,
      bytes: buf.length, sha256: sha256(fs.readFileSync(dest)),
      verified: true, safetyBackup, usedFixedBackup: usingFixed,
      errors: [],
      nextStep: '还原完成 —— 记得在编辑器里「停止试玩 → 重新试玩一局」，活文件不会热加载',
    };
  }

  let rolledBack = false;
  let rollbackError = null;
  if (safetyBuf) {
    const rb = rollbackTo(dest, safetyBuf);
    rolledBack = rb.rolledBack;
    rollbackError = rb.rollbackError;
  }
  return {
    ok: false, restoredFrom: target, dest, backupDir: dir, resolvedFrom: target,
    verified: false, safetyBackup, rolledBack, rollbackError,
    error: '还原后哈希不一致 —— 文件可能已损坏',
    nextSteps: rolledBack
      ? ['已**自动回滚**到还原前那一版（活文件是好的）', '换一份备份再试：' + restoreCommand(null, dest) + '（不传 backup 就是用固定名最新那份）']
      : ['手动用安全备份覆盖：' + (safetyBackup ? restoreCommand(safetyBackup, dest) : '（没有安全备份）'),
        '活文件可能处于损坏状态，先在编辑器里确认它还能不能跑'],
    errors: ['还原后哈希不一致'],
  };
}

/* ------------------------------------------------------------------ 部署 */

/**
 * 部署一个脚本到活文件位置。
 *
 * 顺序（任一步失败都**不继续**，且活文件保持原样）：
 *   ① 源文件体检（无 BOM / 合法 UTF-8）
 *   ② Lua 结构校验（lintMode）
 *   ③ **备份现有活文件**（失败即中止 —— 绝不带着「没有备份」去覆盖）
 *   ④ 原子写
 *   ⑤ 校验 SHA；不过就**自动回滚**
 *
 * @returns 结果里永远带 `backup` / `fixedBackup` / `backupDir` / `restoreWith`，
 *          让调用方（人和 AI）不用再找就能还原。
 */
export function deploy(src, dest, { backupDir, noBackup = false, allowNoBackup = false, lintMode = 'strict' } = {}) {
  const errors = [];
  const warnings = [];
  const dir = defaultBackupDir(dest, backupDir);

  if (!fs.existsSync(src)) return { ok: false, errors: ['源文件不存在：' + src], dest, backupDir: dir };
  if (!['strict', 'warn', 'off'].includes(lintMode)) {
    return { ok: false, errors: ['lintMode 只能是 strict / warn / off，收到：' + JSON.stringify(lintMode)], dest, backupDir: dir };
  }
  if (noBackup && !allowNoBackup) {
    return {
      ok: false, dest, backupDir: dir,
      errors: ['noBackup 需要同时显式传 allowNoBackup:true —— 备份是这块脚本唯一的还原手段，不给随手绕过'],
      nextSteps: ['正常部署请不要传 noBackup'],
    };
  }
  if (dirnameEqual(src, dest)) {
    return { ok: false, dest, backupDir: dir, errors: ['源文件与目标活文件是同一个路径 —— 拒绝自覆盖（会把唯一副本写没）'] };
  }

  const srcBuf = fs.readFileSync(src);
  const srcSha = sha256(srcBuf);
  if (!hasBom(srcBuf)) { /* ok */ } else errors.push('源文件带 UTF-8 BOM —— 会让 Lua 报错，拒绝部署');
  const text = decodeStrict(srcBuf);
  const utf8Ok = text !== null;
  if (!utf8Ok) errors.push('源文件不是合法 UTF-8 —— 拒绝部署（中文注释可能已损坏）');

  const lint = utf8Ok ? lintLua(text) : null;
  if (lint && !lint.ok) {
    const detail = 'Lua 结构校验不通过：' + lintSummary(lint);
    if (lintMode === 'strict') errors.push(detail + '　（确认代码没问题时可用 lintMode:"off" 跳过）');
    else if (lintMode === 'warn') warnings.push(detail);
  }
  if (errors.length) return { ok: false, errors, warnings, dest, backupDir: dir, bytes: srcBuf.length, sha256: srcSha, lint };

  // ③ 备份（失败即中止）
  let backup = null;
  let fixedBackup = null;
  const destExists = fs.existsSync(dest);
  // 覆盖前的内容留一份在内存里 → 校验不过时可以**自动回滚**（即便 noBackup 也有退路）
  const beforeBuf = destExists ? fs.readFileSync(dest) : null;
  if (destExists) {
    if (noBackup) {
      warnings.push('⚠️ 按你的要求跳过了备份 —— 覆盖后原文件没有任何副本可还原');
    } else {
      const b = backupFile(dest, { backupDir });
      if (!b.ok) {
        return {
          ok: false, dest, backupDir: dir, backupFailed: true, bytes: srcBuf.length, sha256: srcSha, lint,
          errors: ['备份失败，**已中止覆盖**（活文件未被改动）：' + b.error],
          nextSteps: [
            '先解决备份写不进去的问题：检查 ' + dir + ' 是否可写、磁盘是否已满',
            '确认无碍后可临时用 noBackup:true + allowNoBackup:true 跳过备份（**后果自负**：覆盖后无法还原）',
          ],
        };
      }
      backup = b.backup;
      fixedBackup = b.fixed;
    }
  }

  // ④ 原子写
  try {
    atomicWriteFile(dest, srcBuf);
  } catch (e) {
    return {
      ok: false, dest, backupDir: dir, backup, fixedBackup, lint, atomic: true,
      errors: ['写入失败（活文件应当仍是原来那份）：' + (e && e.message)],
      restoreWith: backup ? restoreCommand(backup, dest) : null,
      nextSteps: ['确认活文件完好：miliastra_code op=inspect', backup ? '必要时还原：' + restoreCommand(backup, dest) : '（本次没有备份：目标原本不存在）'],
    };
  }

  // ⑤ 校验；不过就**自动回滚**
  const destBuf = fs.readFileSync(dest);
  const destSha = sha256(destBuf);
  const verified = destSha === srcSha;
  if (verified && !hasBom(destBuf)) {
    return {
      ok: true, src, dest, backupDir: dir,
      bytes: destBuf.length, sha256: destSha, srcSha256: srcSha,
      verified: true, bomFree: true, utf8Ok: decodeStrict(destBuf) !== null,
      backup, fixedBackup, lint, lintMode, warnings, errors: [],
      atomic: true,
      restoreWith: backup ? restoreCommand(backup, dest) : null,
      nextStep: '停掉当前试玩 → 重新试玩一局，然后 miliastra_log 取回结果',
    };
  }

  const bad = verified ? '部署后文件出现 BOM —— 异常' : `部署后哈希不一致：src=${srcSha.slice(0, 12)} dest=${destSha.slice(0, 12)}`;
  errors.push(bad);
  // 自动回滚：把刚才备份的那一版写回去
  let rolledBack = false;
  let rollbackError = null;
  if (beforeBuf) {
    const rb = rollbackTo(dest, beforeBuf);
    rolledBack = rb.rolledBack;
    rollbackError = rb.rollbackError;
  }
  return {
    ok: false, src, dest, backupDir: dir, backup, fixedBackup, lint, lintMode, warnings,
    verified: false, rolledBack, rollbackError, atomic: true,
    restoreWith: backup ? restoreCommand(backup, dest) : null,
    errors,
    nextSteps: rolledBack
      ? ['已**自动回滚**到部署前那一版（活文件是好的）', '检查一下是不是磁盘/权限问题，再重试']
      : ['手动还原：' + (backup ? restoreCommand(backup, dest) : '（本次没有备份）')],
  };
}

function dirnameEqual(a, b) {
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } catch { return false; }
}

/* -------------------------------------------- 部署指纹（活文件被外部改写了吗） */

/**
 * 部署指纹：记下「我上次部署进去的到底是哪一版」。
 *
 * 为什么需要：**编辑器保存时会把脚本面板里的内存版写回活文件** ——
 * 也就是说，如果创作者在编辑器里开着一份旧代码按了保存，我们刚部署进去的版本会被**静默吃掉**，
 * 而当时**没有任何迹象**（回执照样是 ok，活文件哈希也确实等于源文件）。实测那次保存让
 * `.gil` 从 54.5KB 涨到 65.9KB（差值 ≈ 那次部署的脚本增量），说明脚本确实被吃进去了。
 *
 * 有了指纹，下一次 `op=inspect` 就能直接说「活文件与上次部署不一致（多半是编辑器存的）」，
 * 并给出字节差 / 行数差。
 *
 * 落点：备份目录里的 `.miliastra-deploy.json` —— 和备份待在一起，
 * 不往活文件目录里放额外文件（否则会污染「这个目录里的 `.lua` 就是活文件」这条判断）。
 * ⚠️ 写指纹失败**不影响部署成败**：它只是记账，调用方记一条 warning 就行。
 */
export const DEPLOY_FINGERPRINT_NAME = '.miliastra-deploy.json';

export function fingerprintPath(dest, { backupDir } = {}) {
  return path.join(defaultBackupDir(dest, backupDir), DEPLOY_FINGERPRINT_NAME);
}

/** 部署成功后写指纹（原子写；失败只返回 ok:false，调用方降级成 warning）。 */
export function writeDeployFingerprint(dest, info, { backupDir, source } = {}) {
  const file = fingerprintPath(dest, { backupDir });
  const record = {
    tool: 'dsh-miliastra',
    dest,
    file: path.basename(dest),
    source: source || null,
    sha256: info.sha256,
    bytes: info.size,
    lineCount: info.lineCount,
    bom: info.bom === true,
    at: new Date().toISOString(),
    atLocal: localStamp(),
  };
  try {
    atomicWriteFile(file, Buffer.from(JSON.stringify(record, null, 1), 'utf8'));
    return { ok: true, path: file, record };
  } catch (e) {
    return { ok: false, path: file, error: (e && e.message) || String(e) };
  }
}

/** 读指纹（没有就是没有，不抛）。 */
export function readDeployFingerprint(dest, { backupDir } = {}) {
  const file = fingerprintPath(dest, { backupDir });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, path: file, missing: true, error: '还没有部署记录' };
    return { ok: false, path: file, error: '读不到部署记录：' + ((e && e.message) || String(e)) };
  }
  try {
    return { ok: true, path: file, record: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, path: file, error: '部署记录不是合法 JSON：' + ((e && e.message) || String(e)) };
  }
}

/**
 * 「部署时记录的」↔「现在的体检结果」比对 —— **纯函数**（判据要能单测）。
 *
 * @param fp  `readDeployFingerprint(...).record`（没有就传 null）
 * @param cur `inspect(file)` 的结果
 */
export function fingerprintDelta(fp, cur) {
  if (!fp || !fp.sha256) {
    return { hasFingerprint: false, note: '还没有部署记录（没用本插件部署过，或备份目录被清过）' };
  }
  if (!cur || !cur.sha256) {
    return { hasFingerprint: true, deployedSha256: fp.sha256, error: '拿不到活文件当前信息' };
  }
  const changed = fp.sha256 !== cur.sha256;
  return {
    hasFingerprint: true,
    deployedSha256: fp.sha256,
    deployedAtLocal: fp.atLocal || null,
    deployedBytes: Number.isFinite(fp.bytes) ? fp.bytes : null,
    deployedLines: Number.isFinite(fp.lineCount) ? fp.lineCount : null,
    bytesDelta: Number.isFinite(fp.bytes) ? cur.size - fp.bytes : null,
    lineDelta: (Number.isFinite(fp.lineCount) && Number.isFinite(cur.lineCount)) ? cur.lineCount - fp.lineCount : null,
    changedSinceDeploy: changed,
    sameAsDeploy: !changed,
    note: changed
      ? '活文件与上次部署**不一致** —— 多半是编辑器把脚本面板里的内存版存回了磁盘（实测会发生）；也可能是手动改过'
      : '活文件与上次部署一致',
  };
}

/**
 * 去掉活文件的 UTF-8 BOM：**只去这 3 个字节，不动其它任何一个字节**。
 *
 * 为什么单独做一件事：原神实测会打印
 * `Read text file with BOM header may cause Lua error` —— 带 BOM 的脚本会让 Lua 报错。
 * 而 BOM **不是我们加的**（部署路径会拒绝带 BOM 的源文件），实测它来自
 * **新建关卡时编辑器自己写的活文件**：备份里确实出现过 `EF BB BF` 开头的 22449 字节版，
 * 同一份内容无 BOM 是 22446 字节 —— **正好差 3 字节**。
 *
 * 安全顺序（和部署同源：宁可失败，也不许损坏）：
 *   ① 本来没有 BOM → **什么都不做**（不为「修一下」去动不需要动的文件）
 *   ② 备份失败 → 立即中止
 *   ③ 原子写 → 校验（哈希只差那 3 字节 + 无 BOM + 仍是合法 UTF-8）
 *   ④ 校验不过 → **自动回滚**回带 BOM 的那一版
 *
 * ⚠️ 副作用要提前说清：`<原名>.bak` 这时指向的是**带 BOM 的那一版**，
 *    而 `op=restore` 会**拒绝**还原带 BOM 的备份（故意的 —— 那种文件还原回去 Lua 照样报错）。
 */
export function stripBomFile(dest, { backupDir } = {}) {
  const dir = defaultBackupDir(dest, backupDir);
  if (!fs.existsSync(dest)) return { ok: false, dest, backupDir: dir, error: '活文件不存在：' + dest };
  const before = fs.readFileSync(dest);
  if (!hasBom(before)) {
    return {
      ok: false, dest, backupDir: dir, bom: false, changed: false,
      error: '这个文件本来就没有 BOM —— 什么都没做（不为「修一下」去动不需要动的文件）',
      inspect: inspect(dest),
    };
  }
  if (before.length <= 3) {
    return {
      ok: false, dest, backupDir: dir, bom: true, changed: false,
      error: '文件只有 ' + before.length + ' 字节，去掉 BOM 就没内容了 —— 拒绝',
      inspect: inspect(dest),
    };
  }
  const after = before.subarray(3);
  if (decodeStrict(after) === null) {
    return {
      ok: false, dest, backupDir: dir, bom: true, changed: false,
      error: '去掉 BOM 之后不是合法 UTF-8 —— 拒绝（这文件可能本来就更坏，别拿它开刀）',
      inspect: inspect(dest), firstBytesAfter: firstHex(after),
    };
  }

  // ① 备份（失败即中止）
  const b = backupFile(dest, { backupDir });
  if (!b.ok) {
    return {
      ok: false, dest, backupDir: dir, backupFailed: true, changed: false,
      error: '备份失败，**已中止**（活文件未被改动）：' + b.error,
      nextSteps: ['检查 ' + dir + ' 是否可写、磁盘是否已满'],
    };
  }

  // ② 原子写
  try {
    atomicWriteFile(dest, after);
  } catch (e) {
    return {
      ok: false, dest, backupDir: dir, backup: b.backup, fixedBackup: b.fixed, changed: false,
      error: '写入失败（原文件应当仍完好）：' + (e && e.message),
      restoreWith: restoreCommand(b.backup, dest),
    };
  }

  // ③ 校验；不过就回滚
  const now = fs.readFileSync(dest);
  const shaOk = sha256(now) === sha256(after);
  if (shaOk && !hasBom(now)) {
    return {
      ok: true, dest, backupDir: dir, changed: true,
      before: { bytes: before.length, sha256: sha256(before), firstBytes: firstHex(before), bom: true },
      after: { bytes: now.length, sha256: sha256(now), firstBytes: firstHex(now), bom: false, utf8Ok: true },
      removedBytes: before.length - now.length,
      backup: b.backup, fixedBackup: b.fixed,
      warnings: ['固定名备份 <原名>.bak 现在是「带 BOM 的那一版」；op=restore 会拒绝还原它'
        + '（故意的 —— 那种文件还原回去 Lua 还是会报错）。要更早的版本请从 op=backups 的历史里挑'],
      restoreWith: restoreCommand(b.backup, dest),
      nextStep: '停掉当前试玩 → 重新试玩一局（活文件不会热加载）',
    };
  }
  const rb = rollbackTo(dest, before);
  return {
    ok: false, dest, backupDir: dir, backup: b.backup, fixedBackup: b.fixed, changed: false,
    rolledBack: rb.rolledBack, rollbackError: rb.rollbackError,
    error: '去 BOM 后校验不过' + (shaOk ? '（文件仍带 BOM）' : '（哈希不一致）'),
    restoreWith: restoreCommand(b.backup, dest),
    nextSteps: [rb.rolledBack
      ? '已**自动回滚**到带 BOM 的那一版（活文件是好的），别再重试，先查磁盘'
      : '手动还原：' + restoreCommand(b.backup, dest)],
  };
}


/* ------------------------------------------------------------------ 选文件 */

/**
 * 从活文件目录里挑一个 .lua（按最近改动）。
 *
 * ⚠️ **必须排除探针源码与备份**：探针部署曾经把 `_探针_xxx.lua` 写进活文件目录，
 *    而这里是按 mtime 取最新 —— 结果之后不带 `file` 的操作全都打到了探针上。
 *    现在双侧防护：探针源码不再写进这个目录（见 index.js），这里也再筛一遍。
 */
export function pickLuaFile(luaDir) {
  if (!luaDir || !fs.existsSync(luaDir)) return null;
  const all = fs.readdirSync(luaDir).filter((n) => n.toLowerCase().endsWith('.lua'));
  const skipped = all.filter(isAuxiliaryLuaName);
  const files = all
    .filter((n) => !isAuxiliaryLuaName(n))
    .map((n) => ({ name: n, path: path.join(luaDir, n), ...(fs.statSync(path.join(luaDir, n))) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = files[0] || null;
  if (picked) picked.skippedAuxiliary = skipped;
  return picked;
}
