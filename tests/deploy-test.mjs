/**
 * 部署路径自测：在**临时目录**里验证 codefile.deploy 的三条硬要求。
 *
 * 为什么不碰真活文件：部署会覆盖沙箱里的脚本。这里用 temp 目录造一个假沙箱，
 * 语义与真实路径完全一致（备份目录、二进制拷贝、SHA-256、BOM 检查都不看路径真假）。
 *
 * 用法：node tests/deploy-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploy, inspect, sha256, hasBom, backupFile, listBackups, restore, defaultBackupDir } from '../lib/codefile.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`✅ ${label}${detail ? '  → ' + detail : ''}`);
  } catch (e) {
    fail += 1;
    failures.push(`${label}: ${e && e.message}`);
    console.log(`❌ ${label}  → ${e && e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miliastra-deploy-'));
const sandbox = path.join(tmp, 'external_lua_file');
fs.mkdirSync(sandbox, { recursive: true });
const dest = path.join(sandbox, '双相.lua');

const OLD = '-- 旧版本\r\nlocal a = 1\r\n';
const NEW = '-- 新版本\r\nlocal 中文注释 = "保持编码"\r\nreturn 1\r\n';
fs.writeFileSync(dest, OLD, 'utf8');

const src = path.join(tmp, 'new.lua');
fs.writeFileSync(src, NEW, 'utf8');

let firstBackup = null;

check('正常部署：拷贝成功 + 哈希一致 + 无 BOM + UTF-8 合法', () => {
  const r = deploy(src, dest, {});
  assert(r.ok, 'ok=false：' + JSON.stringify(r.errors));
  assert(r.verified === true, 'verified 不为 true');
  assert(r.sha256 === sha256(Buffer.from(NEW, 'utf8')), '部署后哈希与源不一致');
  assert(r.bomFree === true, 'bomFree 不为 true');
  assert(r.utf8Ok === true, 'utf8Ok 不为 true');
  firstBackup = r.backup;
  return `${r.bytes} 字节  sha=${String(r.sha256).slice(0, 12)}…  备份=${r.backup ? path.basename(r.backup) : '（无）'}`;
});

check('旧文件被备份，且备份 == 原内容（字节级）', () => {
  assert(firstBackup && fs.existsSync(firstBackup), '备份文件不存在');
  const back = fs.readFileSync(firstBackup, 'utf8');
  assert(back === OLD, '备份内容 != 旧内容');
  return path.basename(firstBackup);
});

check('部署后活文件与源文件**字节完全相同**（中文注释未被转码）', () => {
  const a = fs.readFileSync(src);
  const b = fs.readFileSync(dest);
  assert(Buffer.compare(a, b) === 0, '字节不一致 —— 说明中间做过文本转码');
  assert(b.toString('utf8').includes('中文注释'), '中文注释丢失');
  return `${b.length} 字节一致`;
});

check('带 UTF-8 BOM 的源文件被**拒绝**，且不覆盖现有活文件', () => {
  const bomSrc = path.join(tmp, 'bom.lua');
  fs.writeFileSync(bomSrc, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('-- 带BOM\r\n', 'utf8')]));
  assert(hasBom(fs.readFileSync(bomSrc)), '测试前提不成立：造出来的文件没有 BOM');
  const before = fs.readFileSync(dest);
  const r = deploy(bomSrc, dest, {});
  assert(r.ok === false, '带 BOM 竟然被接受了');
  assert((r.errors || []).some((e) => /BOM/.test(e)), '错误信息里没提 BOM：' + JSON.stringify(r.errors));
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒绝却仍然覆盖了活文件');
  return r.errors[0];
});

check('非法 UTF-8 的源文件被拒绝（中文注释可能已损坏）', () => {
  const badSrc = path.join(tmp, 'bad.lua');
  fs.writeFileSync(badSrc, Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x41]));
  const before = fs.readFileSync(dest);
  const r = deploy(badSrc, dest, {});
  assert(r.ok === false, '非法 UTF-8 竟然被接受');
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒绝却仍然覆盖了活文件');
  return r.errors[0];
});

check('noBackup=true 时不产生备份，但仍校验哈希', () => {
  const src2 = path.join(tmp, 'new2.lua');
  fs.writeFileSync(src2, NEW + '-- v2\r\n', 'utf8');
  const r = deploy(src2, dest, { noBackup: true });
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors));
  assert(r.backup === null, 'noBackup 却产生了备份：' + r.backup);
  assert(r.verified === true, 'verified 不为 true');
  return '无备份 + 校验通过';
});

check('inspect() 能如实报出 BOM / 编码 / 行数', () => {
  const bomSrc = path.join(tmp, 'bom.lua');
  const i1 = inspect(bomSrc);
  assert(i1.bom === true, 'BOM 文件没被报成 bom=true');
  assert(i1.utf8Ok === true, 'BOM 文件本身是合法 UTF-8');
  const i2 = inspect(src);
  assert(i2.bom === false, '无 BOM 文件被误报 bom=true');
  assert(i2.firstBytes.startsWith('2d 2d 20'), '前 3 字节不是 "-- "：' + i2.firstBytes);
  return `bom 文件 firstBytes=${i1.firstBytes}；正常文件 ${i2.lineCount} 行`;
});

/* ---------------------------------------------------------------- 备份与还原 */
// 备份是「脚本没有 git」时的唯一安全网，所以这几条必须硬。

check('同一秒内连续备份**不会互相覆盖**（时间戳只到秒，撞名要自动顺延）', () => {
  const bd = path.join(tmp, 'collide-backup');
  const a = backupFile(dest, { backupDir: bd });
  const b = backupFile(dest, { backupDir: bd });
  const c = backupFile(dest, { backupDir: bd });
  assert(a.ok && b.ok && c.ok, '备份失败：' + JSON.stringify([a, b, c]));
  const names = new Set([a.backup, b.backup, c.backup]);
  assert(names.size === 3, '三次备份只产生 ' + names.size + ' 个文件 —— 撞名把前面的覆盖了！');
  assert(/-2_备份\.lua$/.test(b.backup), '第二份没顺延 -2：' + path.basename(b.backup));
  assert(/-3_备份\.lua$/.test(c.backup), '第三份没顺延 -3：' + path.basename(c.backup));
  return path.basename(a.backup) + ' / ' + path.basename(b.backup) + ' / ' + path.basename(c.backup);
});

check('listBackups() 能列出全部备份（倒序，带 SHA/BOM）', () => {
  const bd = path.join(tmp, 'list-backup');
  backupFile(dest, { backupDir: bd });
  backupFile(dest, { backupDir: bd });
  const r = listBackups(dest, { backupDir: bd });
  assert(r.entries.length === 2, '应列出 2 份，实际 ' + r.entries.length);
  assert(r.entries.every((e) => /^[0-9A-F]{64}$/.test(e.sha256)), 'sha256 字段不对');
  assert(r.entries.every((e) => e.bom === false), 'bom 字段不对');
  assert(r.entries[0].mtimeMs >= r.entries[1].mtimeMs, '没有按时间倒序');
  return r.dir + ' 下 ' + r.entries.length + ' 份';
});

check('restore() 覆盖前会**先给当前版本做安全备份**（还原错了还能再回来）', () => {
  const bd = path.join(tmp, 'restore-backup');
  const old = backupFile(dest, { backupDir: bd });           // 拿"部署前"那份当还原源
  assert(old.ok, '准备备份失败');
  const beforeRestore = fs.readFileSync(dest);               // 当前版本
  const r = restore(old.backup, dest, { backupDir: bd });
  assert(r.ok === true, '还原失败：' + JSON.stringify(r.errors || r.error));
  assert(r.verified === true, '还原后校验没过');
  assert(r.safetyBackup && fs.existsSync(r.safetyBackup), '没有做还原前的安全备份');
  assert(Buffer.compare(fs.readFileSync(r.safetyBackup), beforeRestore) === 0, '安全备份内容 != 还原前的活文件');
  assert(Buffer.compare(fs.readFileSync(dest), fs.readFileSync(old.backup)) === 0, '还原后活文件 != 备份内容');
  return '还原自 ' + path.basename(old.backup) + '，安全备份 ' + path.basename(r.safetyBackup);
});

check('restore() 拒收带 BOM / 非法 UTF-8 的备份（还原坏文件比不还原更糟）', () => {
  const bd = path.join(tmp, 'restore-guard');
  const bomBackup = path.join(bd, '双相_bom_备份.lua');
  fs.mkdirSync(bd, { recursive: true });
  fs.writeFileSync(bomBackup, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('-- x\r\n', 'utf8')]));
  const before = fs.readFileSync(dest);
  const r1 = restore(bomBackup, dest, { backupDir: bd });
  assert(r1.ok === false && /BOM/.test(r1.error), '带 BOM 的备份竟然被还原了');
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒绝却改动了活文件');

  const badBackup = path.join(bd, '双相_bad_备份.lua');
  fs.writeFileSync(badBackup, Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x41]));
  const r2 = restore(badBackup, dest, { backupDir: bd });
  assert(r2.ok === false && /UTF-8/.test(r2.error), '非法 UTF-8 的备份竟然被还原了');
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒绝却改动了活文件');
  return '两种坏备份都被拒收，活文件未被改动';
});

check('★ lintMode=strict：语法错的脚本被拒收，且**不碰活文件、不产生备份**', () => {
  const broken = path.join(tmp, 'broken.lua');
  fs.writeFileSync(broken, '-- 少一个 end\nlocal function f()\n  return 1\n', 'utf8');
  const before = fs.readFileSync(dest);
  const bd = path.join(tmp, 'lint-strict-backup');
  const beforeCount = fs.existsSync(bd) ? fs.readdirSync(bd).length : 0;
  const r = deploy(broken, dest, { backupDir: bd });
  assert(r.ok === false, '缺 end 的脚本竟然被部署了');
  assert(/结构校验不通过/.test((r.errors || []).join(' ')), '没说是结构校验拦下的：' + JSON.stringify(r.errors));
  assert(/第 2 行的 function 没有对应的 end/.test((r.errors || []).join(' ')), '没报出是哪个块没关：' + JSON.stringify(r.errors));
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒收却改动了活文件');
  assert((fs.existsSync(bd) ? fs.readdirSync(bd).length : 0) === beforeCount, '被拒收却产生了备份');
  return '拦下并说明原因，活文件零改动';
});

check('★ lintMode=warn：照投但要带出 warnings（不静默吞掉）', () => {
  const broken = path.join(tmp, 'broken-warn.lua');
  fs.writeFileSync(broken, '-- 少一个 end\nlocal function f()\n  return 1\n', 'utf8');
  const r = deploy(broken, dest, { backupDir: path.join(tmp, 'lint-warn-backup'), lintMode: 'warn' });
  assert(r.ok === true, 'warn 模式不该拒收：' + JSON.stringify(r.errors));
  assert(r.lintMode === 'warn', 'lintMode 没回传：' + r.lintMode);
  assert(r.lint && r.lint.ok === false, 'lint 结果没回传');
  assert((r.warnings || []).some((w) => /结构校验不通过/.test(w)), 'warnings 没带出问题：' + JSON.stringify(r.warnings));
  return '已部署 + 1 条 warning';
});

check('★ lintMode=off：不校验、不报（逃生舱）', () => {
  const broken = path.join(tmp, 'broken-off.lua');
  fs.writeFileSync(broken, '-- 少一个 end\nlocal function f()\n  return 1\n', 'utf8');
  const r = deploy(broken, dest, { backupDir: path.join(tmp, 'lint-off-backup'), lintMode: 'off' });
  assert(r.ok === true, 'off 模式不该拦：' + JSON.stringify(r.errors));
  assert((r.warnings || []).length === 0, 'off 模式不该有 warning');
  return '原样投出';
});

check('★ 合法脚本：lint ok、warnings 为空、结果里带 lint 回执', () => {
  const good = path.join(tmp, 'good.lua');
  fs.writeFileSync(good, '-- 正常\nlocal function f(v)\n  return v\nend\nreturn f(1)\n', 'utf8');
  const r = deploy(good, dest, { backupDir: path.join(tmp, 'lint-ok-backup') });
  assert(r.ok === true, '合法脚本被拦了：' + JSON.stringify(r.errors));
  assert(r.lint && r.lint.ok === true, 'lint 回执不对：' + JSON.stringify(r.lint));
  assert((r.warnings || []).length === 0, '合法脚本不该有 warning');
  return `${r.lint.stats.lines} 行 / ${r.lint.stats.tokens} token`;
});

check('★ 未知 lintMode 明确报错，不静默降级成 off', () => {
  const r = deploy(src, dest, { backupDir: path.join(tmp, 'lint-bad-backup'), lintMode: 'loose' });
  assert(r.ok === false, '未知 lintMode 竟然被接受');
  assert(/lintMode 只能是/.test((r.errors || []).join(' ')), '报错文案没点名 lintMode：' + JSON.stringify(r.errors));
  return '拒绝并说明可选值';
});

check('备份目录可用环境变量覆盖（MILIASTRA_BACKUP_DIR）', () => {
  const saved = process.env.MILIASTRA_BACKUP_DIR;
  const custom = path.join(tmp, 'env-backup-dir');
  process.env.MILIASTRA_BACKUP_DIR = custom;
  try {
    assert(defaultBackupDir(dest) === custom, 'defaultBackupDir 没读环境变量');
    const b = backupFile(dest, {});
    assert(b.ok && String(b.backup).startsWith(custom), '备份没落到环境变量指定的目录：' + b.backup);
    return custom;
  } finally {
    if (saved === undefined) delete process.env.MILIASTRA_BACKUP_DIR; else process.env.MILIASTRA_BACKUP_DIR = saved;
  }
});

console.log('');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
