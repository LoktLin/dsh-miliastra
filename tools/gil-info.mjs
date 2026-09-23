/**
 * tools/gil-info.mjs — 把 `.gil` 里**玩法骨架**那几项静态读出来（不用试玩、不改任何文件）。
 *
 * 打印：客户端/资源版本、阵营、出生点、预设点、场景对象条数、客户端控件数、脚本映射。
 *
 * 用法: node tools/gil-info.mjs [gil路径]
 *       不给路径 = 扫当前所有关卡，找最近改动的那张图
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readGil } from '../lib/gil.mjs';

const localLow = process.env.MILIASTRA_LOCALLOW || path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo');

function newestGil() {
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.gil')) {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(localLow, 0);
  return best && best.path;
}

const file = process.argv[2] || newestGil();
if (!file) { console.log('没找到 .gil'); process.exit(1); }

const g = readGil(file);
if (!g.ok) { console.log('解析失败: ' + g.error); process.exit(1); }

console.log('文件    : ' + g.file);
console.log('大小    : ' + g.size + ' B');
console.log('关卡    : ' + g.level.id + '  ' + (g.level.name || ''));
console.log('账号    : ' + g.account);
console.log('图版本  : ' + g.version);
console.log('');
console.log('=== #29 客户端 / 资源版本 ===');
console.log(g.versionInfo
  ? '客户端 ' + g.versionInfo.client + '   资源 ' + g.versionInfo.resources.join(' / ')
  : '（没有这个字段）');
console.log('');
console.log('=== #11 玩法骨架（阵营 / 出生点 / 预设点）===');
if (!g.levelConfig) console.log('（没有这个字段）');
else {
  const lc = g.levelConfig;
  console.log('阵营 ' + lc.factions.length + ' 个：');
  for (const f of lc.factions) console.log('   #' + f.index + '  ' + f.name + (f.uiMark ? '   标记UI=' + f.uiMark : ''));
  console.log('出生点 ' + lc.spawnPoints.length + ' 个：' + (lc.spawnPoints.join(' / ') || '（无）'));
  console.log('预设点 ' + lc.presetPoints.length + ' 个：' + (lc.presetPoints.join(' / ') || '（无）'));
}
console.log('');
console.log('=== #7 场景对象 ===');
console.log(g.sceneObjects
  ? g.sceneObjects.count + ' 条；前几个：' + g.sceneObjects.sample.map((x) => x.name).join(' / ')
  : '（没有这个字段）');
console.log('');
console.log('=== #9 客户端控件 ===');
console.log(g.clientUI.length + ' 条记录');
console.log('');
console.log('=== #50 脚本映射 ===');
console.log(g.script
  ? g.script.name + '  (' + g.script.file + ')  源码 ' + g.script.sourceBytes + ' 字节  sha=' + String(g.script.sourceSha256).slice(0, 12) + '…'
  : '（没有）');
