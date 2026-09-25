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
import { fileURLToPath } from 'node:url';
import { deploy, inspect, sha256, hasBom, backupFile, listBackups, restore, defaultBackupDir, stampOfName, atomicWriteFile, rollbackTo, fixedBackupPath, isAuxiliaryLuaName, pickLuaFile, stripBomFile, writeDeployFingerprint, readDeployFingerprint, fingerprintDelta, deployFingerprintName, fingerprintPathByName, DEPLOY_FINGERPRINT_NAME } from '../lib/codefile.mjs';
// 原子写的**实现**住在 lib/fsx.mjs（codefile 只是转发）；这里直接测实现本身
import { atomicWriteJson, prettyJson } from '../lib/fsx.mjs';

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

check('★ noBackup 是**双钥匙**：只传 noBackup 会被拒（不给随手绕过安全网）', () => {
  const src2 = path.join(tmp, 'new2.lua');
  fs.writeFileSync(src2, NEW + '-- v2\r\n', 'utf8');
  const before = fs.readFileSync(dest);

  const denied = deploy(src2, dest, { noBackup: true });
  assert(denied.ok === false, '只传 noBackup 竟然被放行了');
  assert(/allowNoBackup/.test((denied.errors || []).join(' ')), '报错没点名 allowNoBackup：' + JSON.stringify(denied.errors));
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '被拒绝却改动了活文件');

  const ok = deploy(src2, dest, { noBackup: true, allowNoBackup: true });
  assert(ok.ok === true, '双钥匙都给了还失败：' + JSON.stringify(ok.errors));
  assert(ok.backup === null, 'noBackup 却产生了备份：' + ok.backup);
  assert((ok.warnings || []).some((w) => /跳过了备份/.test(w)), '跳过备份却没给警告：' + JSON.stringify(ok.warnings));
  return '单钥匙拒绝 + 活文件零改动；双钥匙放行且带警告';
});

check('★ 🔴 备份失败时**不覆盖**活文件（这是「把用户 lua 吃了」的真实路径）', () => {
  const src3 = path.join(tmp, 'new3.lua');
  fs.writeFileSync(src3, '-- 新版本不该被写进去\r\n', 'utf8');
  const before = fs.readFileSync(dest);

  // 造一个「备份目录写不进去」的场景：把备份目录路径占成一个**普通文件**
  const asFile = path.join(tmp, 'backup-is-a-file');
  fs.writeFileSync(asFile, 'x');
  const r = deploy(src3, dest, { backupDir: asFile });

  assert(r.ok === false, '备份失败竟然还部署成功了 —— 原文件会被抹掉');
  assert(r.backupFailed === true, '没标 backupFailed');
  assert(/已中止覆盖/.test((r.errors || []).join(' ')), '报错没说「已中止覆盖」：' + JSON.stringify(r.errors));
  assert(Buffer.compare(fs.readFileSync(dest), before) === 0, '备份失败却改动了活文件 —— 唯一副本没了');
  assert(Array.isArray(r.nextSteps) && r.nextSteps.length, '没给下一步指引');
  return '备份失败 → 拒绝覆盖，活文件逐字节未变';
});

check('★ 原子写：不留 .tmp 残留，且目标内容完整（断电安全的前提）', () => {
  const src4 = path.join(tmp, 'new4.lua');
  const body = '-- 原子写\r\nlocal 中文 = "注释不能被转码"\r\nreturn 1\r\n';
  fs.writeFileSync(src4, body, 'utf8');
  const r = deploy(src4, dest, { backupDir: path.join(tmp, 'atomic-backup') });
  assert(r.ok === true, '部署失败：' + JSON.stringify(r.errors));
  assert(r.atomic === true, '回执里没有 atomic 标记');
  const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('.tmp-'));
  assert(leftovers.length === 0, '留下了临时文件：' + leftovers.join(', '));
  assert(fs.readFileSync(dest, 'utf8') === body, '内容不完整');
  return '无 .tmp 残留 + 内容逐字节一致';
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

check('★ 备份写**两份**：固定名 `<原名>.bak` + 一份带本地时间戳的历史', () => {
  const bd = path.join(tmp, 'two-kinds-backup');
  const r = backupFile(dest, { backupDir: bd });
  assert(r.ok, '备份失败：' + r.error);
  assert(/\.bak$/.test(r.fixed), '没有固定名备份：' + r.fixed);
  assert(/[._]\d{8}-\d{6}(-\d+)?_备份\.lua$/.test(r.backup), '历史备份名不是本地时间戳格式：' + path.basename(r.backup));
  assert(fs.existsSync(r.fixed) && fs.existsSync(r.backup), '两份备份没都落盘');
  // 名字里的时间戳应当是**本地时间**（以前用 UTC，比本地少 8 小时，看着像错的）
  const d = stampOfName(path.basename(r.backup));
  assert(d && Math.abs(Date.now() - d.getTime()) < 5 * 60 * 1000, '时间戳与本地时间差太多（是不是又用了 UTC？）：' + path.basename(r.backup));
  return path.basename(r.fixed) + ' + ' + path.basename(r.backup);
});

check('★ 备份的「时间」是**备份创建时间**，不是被备份文件的 mtime（否则排序会骗人）', () => {
  const bd = path.join(tmp, 'mtime-backup');
  const old = Date.now() - 3 * 3600 * 1000;   // 把源文件改成 3 小时前
  fs.utimesSync(dest, old / 1000, old / 1000);
  const r = backupFile(dest, { backupDir: bd });
  assert(r.ok, '备份失败：' + r.error);
  const st = fs.statSync(r.backup);
  assert(Math.abs(Date.now() - st.mtimeMs) < 60 * 1000,
    '备份 mtime 沿用了源文件的旧时间（copyFileSync 的坑）—— 按时间取最新备份会选错：' + st.mtime.toISOString());
  const l = listBackups(dest, { backupDir: bd });
  assert(l.entries[0].fixed === true, '固定名那份没排在第一个：' + l.entries.map((e) => e.name).join(', '));
  return '备份时间 = 现在（源文件是 3 小时前，未被沿用）';
});

check('连续备份**不会互相覆盖**（撞名要自动顺延）', () => {
  const bd = path.join(tmp, 'collide-backup');
  const a = backupFile(dest, { backupDir: bd });
  const b = backupFile(dest, { backupDir: bd });
  const c = backupFile(dest, { backupDir: bd });
  assert(a.ok && b.ok && c.ok, '备份失败：' + JSON.stringify([a, b, c]));
  const names = new Set([a.backup, b.backup, c.backup]);
  assert(names.size === 3, '三次备份只产生 ' + names.size + ' 个文件 —— 撞名把前面的覆盖了！');
  // ⚠️ **别断言 `-2`/`-3` 后缀**：后缀只在「同一秒内撞名」时出现，而三次备份是否落在同一秒
  //    取决于机器忙不忙 —— `npm test` 里跨秒过一次，这条因此**假红**（2026-09-24 记）。
  //    真正的不变量与时间无关：**三个不同的名字 + 都在盘上**。
  for (const r of [a, b, c]) assert(fs.existsSync(r.backup), '备份没落盘：' + r.backup);
  return path.basename(a.backup) + ' / ' + path.basename(b.backup) + ' / ' + path.basename(c.backup);
});

check('listBackups() 能列出全部备份（倒序，带 SHA/BOM，固定名那份标 fixed）', () => {
  const bd = path.join(tmp, 'list-backup');
  backupFile(dest, { backupDir: bd });
  backupFile(dest, { backupDir: bd });
  const r = listBackups(dest, { backupDir: bd });
  // 两次备份 = 2 份历史 + 1 份固定名（固定名会被后者覆盖，所以总共 3 个文件）
  assert(r.entries.length === 3, '应列出 3 份（2 历史 + 1 固定名），实际 ' + r.entries.length);
  assert(r.entries.filter((e) => e.fixed).length === 1, '固定名那份标错了');
  assert(r.entries.every((e) => /^[0-9A-F]{64}$/.test(e.sha256)), 'sha256 字段不对');
  assert(r.entries.every((e) => e.bom === false), 'bom 字段不对');
  assert(r.entries.every((e) => e.utf8Ok === true), 'utf8Ok 字段不对');
  const times = r.entries.map((e) => Date.parse(e.stampedAt || e.createdAt) || 0);
  assert(times.every((t, i) => i === 0 || times[i - 1] >= t), '没有按时间倒序：' + r.entries.map((e) => e.name).join(', '));
  return r.dir + ' 下 ' + r.entries.length + ' 份（含固定名）';
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

check('★ restore() **不传 backup** 时用固定名那份（「固定统一备份名」的用处）', () => {
  const bd = path.join(tmp, 'fixed-restore');
  const live = path.join(tmp, 'fixed-live', 'mylua.lua');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, '-- 版本甲\r\n', 'utf8');
  // 部署一次 → 产生固定名备份（内容 = 版本甲）
  const d = deploy(src, live, { backupDir: bd, lintMode: 'off' });
  assert(d.ok, '部署失败：' + JSON.stringify(d.errors));
  assert(fs.existsSync(fixedBackupPath(bd, live)), '固定名备份没生成');
  // 再把活文件改成别的版本，然后不带 backup 还原
  fs.writeFileSync(live, '-- 版本乙（不该留下来）\r\n', 'utf8');
  const r = restore(null, live, { backupDir: bd });
  assert(r.ok === true, '不传 backup 的还原失败：' + r.error);
  assert(r.usedFixedBackup === true, '没标记 usedFixedBackup');
  // 固定名备份里存的是「部署覆盖前那一版」= 版本甲，所以还原应当回到甲
  assert(fs.readFileSync(live, 'utf8') === '-- 版本甲\r\n', '还原后的内容不是「覆盖前那一版」：' + JSON.stringify(fs.readFileSync(live, 'utf8')));
  assert(r.safetyBackup, '没做还原前安全备份');
  assert(/重新试玩/.test(r.nextStep || ''), '没提示「还原后要重新试玩」');
  return '解析到固定名 → 还原成功 + 安全备份 + 下一步提示';
});

check('★ restore() 找不到固定名备份时：明确报错 + 给下一步（不是静默失败）', () => {
  const bd = path.join(tmp, 'no-fixed');
  const live = path.join(tmp, 'no-fixed-live', 'x.lua');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, '-- 原样\r\n', 'utf8');
  const before = fs.readFileSync(live);
  const r = restore(null, live, { backupDir: bd });
  assert(r.ok === false, '没有备份却报成功');
  assert(/固定名备份/.test(r.error), '没说清是缺固定名备份：' + r.error);
  assert(Array.isArray(r.nextSteps) && r.nextSteps.length >= 2, '没给下一步指引');
  assert(Buffer.compare(fs.readFileSync(live), before) === 0, '失败却改动了活文件');
  return r.error.slice(0, 34) + '… + ' + r.nextSteps.length + ' 条下一步';
});

check('★ 🔴 rollbackTo()：校验不过时能把目标恢复成「覆盖前那一版」', () => {
  const d = path.join(tmp, 'rollback-unit');
  fs.mkdirSync(d, { recursive: true });
  const live = path.join(d, 'r.lua');
  const GOOD = Buffer.from('-- 覆盖前的好版本\r\nlocal a = 1\r\n', 'utf8');
  fs.writeFileSync(live, GOOD);

  // 模拟「写坏了」：先写进去一份垃圾，再回滚
  atomicWriteFile(live, Buffer.from('半个文件', 'utf8'));
  const rb = rollbackTo(live, GOOD);
  assert(rb.rolledBack === true, '回滚没成功：' + JSON.stringify(rb));
  assert(Buffer.compare(fs.readFileSync(live), GOOD) === 0, '回滚后内容不是覆盖前那一版');
  assert(rollbackTo(live, null).rolledBack === false, '没有可回滚内容时应当明确返回 false');
  return '垃圾内容 → 回滚 → 逐字节恢复';
});

check('★ 🔴 写不进去时不损坏活文件（写失败分支）', () => {
  const live = path.join(tmp, 'writefail', 'w.lua');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, '-- 原样\r\n', 'utf8');
  const before = fs.readFileSync(live);

  // 把活文件的**父目录**换成一个普通文件 → 临时文件建不出来 → 原子写必然失败
  const blocked = path.join(tmp, 'blocked-parent');
  fs.writeFileSync(blocked, 'x');
  const r = deploy(src, path.join(blocked, 'x.lua'), { backupDir: path.join(tmp, 'wf-backup') });
  assert(r.ok === false, '写不进去却报成功');
  assert(/写入失败/.test((r.errors || []).join(' ')), '报错没说是写入失败：' + JSON.stringify(r.errors));
  assert(Array.isArray(r.nextSteps) && r.nextSteps.length, '没给下一步指引');
  assert(r.atomic === true, '没标 atomic');
  assert(Buffer.compare(fs.readFileSync(live), before) === 0, '别的地方的文件被改动了');
  return '写入失败 → 明确报错 + 下一步，未损坏任何文件';
});

check('★ 🔴 deploy() 拒绝「源文件就是目标活文件」（自覆盖会把唯一副本写没）', () => {
  const live = path.join(tmp, 'self', 's.lua');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, '-- 我自己\r\n', 'utf8');
  const before = fs.readFileSync(live);
  const r = deploy(live, live, { backupDir: path.join(tmp, 'self-backup') });
  assert(r.ok === false, '自覆盖竟然被放行了');
  assert(/同一个路径/.test((r.errors || []).join(' ')), '报错没说清原因：' + JSON.stringify(r.errors));
  assert(Buffer.compare(fs.readFileSync(live), before) === 0, '被拒绝却改动了文件');
  return '拒绝并说明';
});

check('★ pickLuaFile() 跳过探针源码与备份（否则会把探针当成「当前活文件」）', () => {
  const dir = path.join(tmp, 'pick-dir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '双相.lua'), '-- 用户的脚本\r\n', 'utf8');
  // 探针和备份都是「更新的」—— 旧实现按 mtime 取最新就会选中它们
  const probe = path.join(dir, '_探针_api-surface_P1_20260923-190000.lua');
  fs.writeFileSync(probe, '-- 探针\r\n', 'utf8');
  const bak = path.join(dir, '双相_20260101-000000_备份.lua');
  fs.writeFileSync(bak, '-- 备份\r\n', 'utf8');
  const now = new Date();
  fs.utimesSync(probe, now, now);
  fs.utimesSync(bak, now, now);

  const picked = pickLuaFile(dir);
  assert(picked && picked.name === '双相.lua', '选错了文件：' + (picked && picked.name));
  assert(picked.skippedAuxiliary.length === 2, '没报告跳过了几个附属文件：' + JSON.stringify(picked.skippedAuxiliary));
  for (const n of ['_探针_x.lua', '双相.bak', '双相_20260101-000000_备份.lua', '.hidden.lua']) {
    assert(isAuxiliaryLuaName(n), '没被识别为附属文件：' + n);
  }
  assert(!isAuxiliaryLuaName('双相.lua') && !isAuxiliaryLuaName('测试.lua'), '正常活文件名被误判成附属文件');
  return '选中用户的脚本，跳过 2 个附属文件';
});

check('★ atomicWriteFile() 同目录原子替换（不留 tmp、可覆盖已存在文件）', () => {
  const d = path.join(tmp, 'atomic-write');
  const f = path.join(d, 'a.lua');
  atomicWriteFile(f, Buffer.from('第一次', 'utf8'));
  assert(fs.readFileSync(f, 'utf8') === '第一次', '首次写入不对');
  atomicWriteFile(f, Buffer.from('第二次', 'utf8'));
  assert(fs.readFileSync(f, 'utf8') === '第二次', '覆盖写入不对');
  const leftovers = fs.readdirSync(d).filter((n) => n.includes('.tmp-'));
  assert(leftovers.length === 0, '留下临时文件：' + leftovers.join(', '));
  return '覆盖成功、无 tmp 残留';
});

/*
 * ★ 原子写是**共享实现**（`lib/fsx.mjs`），三件事要钉住 —— 2026-09-24 源码体检时发现
 * 「写盘」当时有三种写法（硬化版 / 手搓 tmp+rename / 裸 writeFileSync），健壮性必须长在唯一实现上。
 */
check('★ 原子写也接字符串，且不写 BOM（本项目硬要求：原神遇到 BOM 会报 Lua error）', () => {
  const f = path.join(tmp, 'atomic-str', 'a.json');
  atomicWriteFile(f, '{"a":1}\n');
  const buf = fs.readFileSync(f);
  assert(buf.toString('utf8') === '{"a":1}\n', '字符串内容不对：' + buf.toString('utf8'));
  assert(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), '写出了 UTF-8 BOM');
  return '字符串入参 + 无 BOM';
});

check('★ atomicWriteJson/prettyJson：缩进 2 + 结尾换行（人看 diff 友好），且可往返', () => {
  assert(prettyJson({ a: 1 }) === '{\n  "a": 1\n}\n', 'prettyJson 形状不对：' + JSON.stringify(prettyJson({ a: 1 })));
  const f = path.join(tmp, 'atomic-json', 'b.json');
  atomicWriteJson(f, { n: 1, s: '中文' });
  assert(JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8'))) === JSON.stringify({ n: 1, s: '中文' }), '往返不一致');
  const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-'));
  assert(leftovers.length === 0, '留了 tmp：' + leftovers.join(', '));
  return '缩进 2 + 尾换行 + 可往返';
});

check('★ 原子写失败时：抛错 + 清掉 tmp + **旧文件完好**（这是"宁可失败不许损坏"的底线）', () => {
  const d = path.join(tmp, 'atomic-fail');
  const f = path.join(d, 'keep.json');
  atomicWriteFile(f, '旧内容');
  // 让 rename 注定失败：把目标变成一个**目录**（Windows 上 rename 到已存在目录会失败）
  const asDir = path.join(tmp, 'atomic-fail-dir');
  atomicWriteFile(path.join(asDir, 'x'), '先建出来');   // 建目录用
  let threw = '';
  try { atomicWriteFile(asDir, '新内容'); } catch (e) { threw = (e && e.message) || String(e); }
  assert(threw, '写到一个目录上竟然没报错');
  const leftovers = fs.readdirSync(path.dirname(asDir)).filter((n) => n.includes('.tmp-'));
  assert(leftovers.length === 0, '失败后没清 tmp：' + leftovers.join(', '));
  assert(fs.readFileSync(f, 'utf8') === '旧内容', '别的文件被牵连了');
  return '抛错 + 无残留 + 旧文件完好';
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

/* ---------------------------------------- 0.0.4：部署指纹 + 去 BOM */

check('★ 部署指纹：部署后写、inspect 能发现「活文件被外部改写」', () => {
  const d = path.join(tmp, 'fp');
  fs.mkdirSync(d, { recursive: true });
  const live = path.join(d, 'x.lua');
  const srcFile = path.join(tmp, 'fp-src.lua');
  fs.writeFileSync(srcFile, '-- 第一版\nlocal a = 1\n', 'utf8');
  fs.writeFileSync(live, '-- 旧版\n', 'utf8');

  const r = deploy(srcFile, live, { backupDir: path.join(d, '_backup') });
  assert(r.ok, '部署失败：' + JSON.stringify(r.errors));
  // 部署本身不会自动写指纹（那一步在工具层）；这里模拟工具层写一次
  const w = writeDeployFingerprint(live, inspect(live), { backupDir: path.join(d, '_backup'), source: srcFile });
  assert(w.ok, '写指纹失败：' + w.error);
  assert(fs.existsSync(w.path), '指纹文件没落盘：' + w.path);
  assert(path.basename(w.path) === DEPLOY_FINGERPRINT_NAME, '指纹文件名不对：' + path.basename(w.path));
  // 指纹不许放在活文件目录里（会污染「这个目录里的 .lua 就是活文件」的判断）
  assert(path.dirname(w.path) !== d, '指纹被写进了活文件目录');

  const fp = readDeployFingerprint(live, { backupDir: path.join(d, '_backup') });
  assert(fp.ok, '读不回指纹');
  const same = fingerprintDelta(fp.record, inspect(live));
  assert(same.hasFingerprint === true && same.sameAsDeploy === true && same.changedSinceDeploy === false,
    '刚部署完就报「变了」：' + JSON.stringify(same));
  assert(same.bytesDelta === 0 && same.lineDelta === 0, '刚部署完差值不为 0');

  // 模拟「编辑器把内存里的旧版存回磁盘」——内容变了、行数少了
  // 部署进去的是 `-- 第一版\nlocal a = 1\n` = 25 字节 2 行；
  // 被写回的是 `-- 被编辑器写回的旧版\n` = 31 字节 1 行 → **字节 +6、行数 −1**（方向也要对，别把公式写反）
  fs.writeFileSync(live, '-- 被编辑器写回的旧版\n', 'utf8');
  const diff = fingerprintDelta(fp.record, inspect(live));
  assert(diff.changedSinceDeploy === true && diff.sameAsDeploy === false, '被改写了却没发现');
  assert(diff.bytesDelta === 6, '字节差不对（应为 +6，实际 ' + diff.bytesDelta + '）');
  assert(diff.lineDelta === -1, '行数差不对（应为 −1，实际 ' + diff.lineDelta + '）');
  // ⚠️ `inspect().lineCount` 沿用既有约定 = `text.split(/\r?\n/).length`，
  //    所以**结尾换行会多算一行**：`-- 第一版\nlocal a = 1\n` 是 **3**，不是 2。
  assert(diff.deployedBytes === 25 && diff.deployedLines === 3, '没把「部署时那一版」的体量报出来：'
    + JSON.stringify({ bytes: diff.deployedBytes, lines: diff.deployedLines }));
  assert(/编辑器/.test(diff.note), '没解释「多半是编辑器存的」：' + diff.note);

  // 没有指纹时必须**如实说没有**，不能假装一致
  const none = fingerprintDelta(null, inspect(live));
  assert(none.hasFingerprint === false && /没有部署记录/.test(none.note), '没有指纹时的说法不对：' + JSON.stringify(none));
  return '部署后写指纹 / 一致时 sameAsDeploy / 被改写时报 changed + 差值 + 解释 / 没指纹不假装一致';
});

check('★ fixbom：只去那 3 个字节，且本来没有 BOM 就什么都不做', () => {
  const d = path.join(tmp, 'bom');
  fs.mkdirSync(d, { recursive: true });
  const live = path.join(d, 'bom.lua');
  const bd = path.join(d, '_backup');
  const body = Buffer.from('-- 带 BOM 的脚本\nlocal 中文 = "编码不能坏"\n', 'utf8');
  fs.writeFileSync(live, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));

  const before = fs.readFileSync(live);
  assert(hasBom(before), '前置条件不成立：造出来的文件没 BOM');

  const r = stripBomFile(live, { backupDir: bd });
  assert(r.ok, '去 BOM 失败：' + r.error);
  assert(r.removedBytes === 3, '去掉的字节数不是 3：' + r.removedBytes);
  const after = fs.readFileSync(live);
  assert(!hasBom(after), '去完还带 BOM');
  assert(after.length === before.length - 3, '长度不是只差 3');
  // 关键：**只差那 3 个字节** —— 内容必须逐字节相同（中文一个字节都不能动）
  assert(Buffer.compare(after, before.subarray(3)) === 0, '除了 BOM 之外还有别的字节被改了');
  assert(sha256(after) === r.after.sha256, '回执里的 SHA 与实测不符');
  assert(r.before.bom === true && r.after.bom === false, '回执的 before/after 标记不对');
  assert(r.backup && fs.existsSync(r.backup), '没有留下备份');
  assert(sha256(fs.readFileSync(r.backup)) === sha256(before), '备份的不是「去 BOM 前那一版」');
  // 必须提前警告：.bak 现在指向带 BOM 那版，而 restore 会拒绝它
  assert((r.warnings || []).some((w) => /带 BOM 的那一版/.test(w)), '没警告「固定名备份现在是带 BOM 那版」');

  // 幂等反例：本来没 BOM → 不许动
  const mtimeBefore = fs.statSync(live).mtimeMs;
  const again = stripBomFile(live, { backupDir: bd });
  assert(again.ok === false && again.changed === false, '对没 BOM 的文件动了手：' + JSON.stringify(again).slice(0, 160));
  assert(/本来就没有 BOM/.test(again.error), '没说清「本来就没有 BOM」：' + again.error);
  assert(fs.statSync(live).mtimeMs === mtimeBefore, '无 BOM 时也改了文件（mtime 变了）');

  // 备份目录不可写 → 必须中止，且活文件一个字节都不许动
  const locked = path.join(tmp, 'bom-locked');
  const live2 = path.join(locked, 'bom2.lua');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(live2, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  const pre = fs.readFileSync(live2);
  const badDir = path.join(locked, 'blocked');
  fs.writeFileSync(badDir, 'not a directory');   // 用文件占住这个名字 → mkdir/写必定失败
  const fail = stripBomFile(live2, { backupDir: badDir });
  assert(fail.ok === false && fail.backupFailed === true, '备份失败没被识别：' + JSON.stringify(fail).slice(0, 160));
  assert(Buffer.compare(fs.readFileSync(live2), pre) === 0, '备份失败却动了活文件');
  return '只去 3 字节（逐字节比对）/ 备份正确 / 警告 .bak 副作用 / 无 BOM 时零改动 / 备份失败即中止';
});

/* ------------------------------------------- ③ 指纹按文件名索引（跨文件不许串） */

check('★ 部署指纹按**文件名**索引：多活文件目录下不再互相串（跨文件不判 changedSinceDeploy）', () => {
  const d = path.join(tmp, 'fp-multi');
  const bd = path.join(d, '_backup');
  fs.mkdirSync(d, { recursive: true });
  const a = path.join(d, '背景图片.lua');
  const b = path.join(d, '测试.lua');
  fs.writeFileSync(a, '-- 背景图片\nlocal a = 1\n', 'utf8');
  fs.writeFileSync(b, '-- 测试\nlocal b = 2\n', 'utf8');

  const w = writeDeployFingerprint(a, inspect(a), { backupDir: bd });
  assert(w.ok, '写指纹失败：' + w.error);
  // 新的那份**按活文件名**索引；旧的那份仍然照写（兼容既有调用方与上面那条老断言）
  assert(path.basename(w.pathByName) === deployFingerprintName('背景图片.lua'),
    '按名索引的指纹文件名不对：' + path.basename(w.pathByName));
  assert(path.basename(w.path) === DEPLOY_FINGERPRINT_NAME, '旧版单份指纹没保留：' + path.basename(w.path));
  assert(fs.existsSync(w.pathByName) && fs.existsSync(w.path), '两份指纹没都落盘');
  assert(fingerprintPathByName(a, { backupDir: bd }) === w.pathByName, '按名取路径的函数与写的不一致');
  // 文件名要能安全落盘：非法字符换掉，但原名内嵌在记录里
  const weird = deployFingerprintName('a<b>c:d.lua');
  assert(!/[<>:]/.test(weird) && /\.json$/.test(weird), '非法字符没被换掉：' + weird);

  // ① 同名 → 按名取到、正常判
  const own = readDeployFingerprint(a, { backupDir: bd });
  assert(own.ok && own.source === 'byname' && own.foreign === false, '同名却没按名取到：' + JSON.stringify(own));
  assert(own.belongsTo === '背景图片.lua', '没报出「指纹属于谁」：' + JSON.stringify(own.belongsTo));
  const ownDelta = fingerprintDelta(own.record, inspect(a), { liveName: '背景图片.lua' });
  assert(ownDelta.sameAsDeploy === true && ownDelta.changedSinceDeploy === false, '同名时应当正常判「一致」：' + JSON.stringify(ownDelta));

  // ② 另一份活文件：按名取不到 → 回退旧版单份，而那份属于 背景图片.lua
  const other = readDeployFingerprint(b, { backupDir: bd });
  assert(other.ok && other.source === 'legacy' && other.foreign === true,
    '没标出「指纹属于另一份文件」：' + JSON.stringify(other).slice(0, 200));
  assert(/另一份活文件/.test(other.note) && /背景图片\.lua/.test(other.note), '说明里没点名是哪个文件：' + other.note);
  const otherDelta = fingerprintDelta(other.record, inspect(b), { liveName: '测试.lua' });
  assert(otherDelta.foreignFingerprint === true && otherDelta.belongsTo === '背景图片.lua',
    '比对回执没标出跨文件：' + JSON.stringify(otherDelta).slice(0, 200));
  // ★ 这条就是修之前会红的那条：跨文件时**两个哈希不同源**，判「变了 / 没变」都是假结论
  assert(otherDelta.changedSinceDeploy === null && otherDelta.sameAsDeploy === null,
    '跨文件竟然判了 changedSinceDeploy：' + JSON.stringify(otherDelta));
  assert(/不据此判 changedSinceDeploy/.test(otherDelta.note), '没解释「为什么不判」：' + otherDelta.note);
  // 同一个人工场景：旧版单份指纹**正好属于自己**时，仍然正常判（兼容支不许退化成「永远不判」）
  try { fs.unlinkSync(w.pathByName); } catch { /* ignore */ }
  const fb = readDeployFingerprint(a, { backupDir: bd });
  assert(fb.ok && fb.source === 'legacy' && fb.foreign === false, '回退到自己那份时不该报 foreign：' + JSON.stringify(fb).slice(0, 160));
  const fbDelta = fingerprintDelta(fb.record, inspect(a), { liveName: '背景图片.lua' });
  assert(fbDelta.sameAsDeploy === true, '回退到自己那份时应当照旧判「一致」：' + JSON.stringify(fbDelta));
  return '同名按名取并正常判 / 跨文件回退并标出来 + 不判 changedSinceDeploy / 回退到自己那份仍正常判';
});

/* ------------------------------------------- ④ 失败清理必须真的把 tmp 删掉 */

check('★ 原子写失败清理**真的生效**（Node v24.9.0 的 rmSync 静默不删 → 改用 unlinkSync）', () => {
  const d = path.join(tmp, 'atomic-unlink');
  const asDir = path.join(d, 'target-dir');
  atomicWriteFile(path.join(asDir, 'x'), '先建出来');   // 建目录用：把「目标」造成一个**目录**，rename 必失败
  let threw = '';
  try { atomicWriteFile(asDir, '新内容'); } catch (e) { threw = (e && e.message) || String(e); }
  assert(threw, '写到一个目录上竟然没报错');
  const leftovers = fs.readdirSync(d).filter((n) => n.includes('.tmp-'));
  assert(leftovers.length === 0, '失败后清理**没生效**，盘上留下：' + leftovers.join(', '));

  /*
   * ★ 上面那条行为断言在**本机 Node（v24.18）上修之前也是绿的** —— 因为 rmSync 的老毛病只出现在
   *   DSH 打包版 Node v24.9.0（实测：rmSync(tmp,{force:true}) 不报错、正常返回、文件还在）。
   *   所以这里再加一条**结构断言**：清理必须走 unlinkSync —— 修之前它是红的（那时是 rmSync）。
   */
  const fsx = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'fsx.mjs'), 'utf8');
  // 只看**代码**：注释里会解释「为什么不能用 rmSync(tmp,…)」，把注释算进去这条会假红
  const fsxCode = fsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/rmSync\s*\(/.test(fsxCode), '失败清理又用回 rmSync 了（Node v24.9.0 上它会静默不删）');
  assert(/unlinkSync\s*\(\s*tmp/.test(fsxCode), '失败清理没用 unlinkSync（唯一在 v24.9.0 上真的会删的写法）');
  return '抛错 + tmp 确实被删掉 + 清理走 unlinkSync';
});

console.log('');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
if (failures.length) {
  console.log('====== 失败明细 ======');
  for (const f of failures) console.log(' ✗ ' + f);
}
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
