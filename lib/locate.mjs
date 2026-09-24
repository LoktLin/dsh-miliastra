/**
 * locate.mjs — 找「活文件」在哪
 *
 * 千星奇域的活文件只活在米哈游本地存档目录里：
 *   C:\Users\<用户>\AppData\LocalLow\miHoYo\<原神|原神 Beta>\BeyondLocal\<账号ID>\
 *     Beyond_Local_Save_Level\<关卡ID>\external_lua_file\<脚本名>.lua     ← 真正跑在游戏里的
 *     Beyond_Local_Save_Level\<关卡ID>\<关卡ID>.gil                        ← 地图存档
 *     Beyond_Debug_Log\<日期_时间>_<pid>_<账号ID>.gia                      ← 运行时日志（每局一个）
 *
 * ⚠️ `<账号ID>` 与 `<关卡ID>` 都会随账号/换图/重建变化，**不要写死**。
 *    本模块每次现扫，并给「当前图」一个基于修改时间的判定。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuxiliaryLuaName } from './codefile.mjs';

/**
 * LocalLow 根目录。
 *
 * 顺序：环境变量 `MILIASTRA_LOCALLOW` > `os.homedir()` + `AppData/LocalLow/miHoYo`。
 *
 * ⚠️ 显式指定就**照做**，即使那个目录不存在 —— 这样写错路径会明确报「没扫到任何关卡目录」，
 *    而不是静默回退去操作真实存档。（早先版本会在路径不存在时回退，等于手一滑就悄悄动了真文件。）
 */
export function localLowRoot() {
  const override = process.env.MILIASTRA_LOCALLOW;
  if (override && String(override).trim()) return String(override).trim();
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'miHoYo');
}

const statSafe = (p) => { try { return fs.statSync(p); } catch { return null; } };
const listDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

/** 扫出所有「客户端安装」（原神 / 原神 Beta）。 */
export function scanInstalls() {
  const root = localLowRoot();
  const out = [];
  for (const name of listDirs(root)) {
    if (!/原神|Genshin/i.test(name)) continue;
    const beyond = path.join(root, name, 'BeyondLocal');
    if (!fs.existsSync(beyond)) continue;
    out.push({ brand: name, beyondLocal: beyond, debugLogs: [] });
  }
  return out;
}

/**
 * 扫出所有「关卡」条目（含活文件 / 地图 / 日志目录）。
 * 返回按最近改动时间倒序的数组。
 *
 * ⚠️ **`Beyond_Local_Save_Level` 下有两种布局，必须都扫**（2026-09-23 实测踩过）：
 *   A. **在当前客户端里的图**：`<关卡ID>\<关卡ID>.gil` + `<关卡ID>\external_lua_file\*.lua`
 *   B. **不在这台机器上编辑的图**：`<关卡ID>.gil` **直接躺在根目录**（没有同名文件夹）
 * 只扫 A 会漏掉 B —— 实测本机 8 个关卡里只看见 3 个，而**节点图数据恰恰在 B 那种图里**。
 */
export function scanLevels() {
  const levels = [];
  for (const inst of scanInstalls()) {
    const logDirs = listDirs(inst.beyondLocal).map((acc) => ({
      account: acc,
      dir: path.join(inst.beyondLocal, acc, 'Beyond_Debug_Log'),
    })).filter((d) => fs.existsSync(d.dir));

    for (const accDir of listDirs(inst.beyondLocal)) {
      const saveRoot = path.join(inst.beyondLocal, accDir, 'Beyond_Local_Save_Level');
      if (!fs.existsSync(saveRoot)) continue;

      const logDir = (logDirs.find((d) => d.account === accDir) || {}).dir || null;
      let logCount = 0;
      let latestLog = null;
      if (logDir && fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir).filter((n) => n.toLowerCase().endsWith('.gia'))
          .map((n) => ({ name: n, path: path.join(logDir, n), ...(statSafe(path.join(logDir, n)) || {}) }))
          .filter((f) => f.mtimeMs)
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        logCount = files.length;
        if (files[0]) latestLog = { name: files[0].name, path: files[0].path, size: files[0].size, mtime: new Date(files[0].mtimeMs).toISOString() };
      }

      // 布局 A：每个关卡一个同名文件夹
      for (const levelId of listDirs(saveRoot)) {
        const levelDir = path.join(saveRoot, levelId);
        const gilPath = path.join(levelDir, levelId + '.gil');
        const luaDir = path.join(levelDir, 'external_lua_file');
        const gilSt = statSafe(gilPath);
        const luaFiles = [];
        let newest = gilSt ? gilSt.mtimeMs : 0;
        if (fs.existsSync(luaDir)) {
          for (const n of (() => { try { return fs.readdirSync(luaDir); } catch { return []; } })()) {
            if (!n.toLowerCase().endsWith('.lua')) continue;
            const st = statSafe(path.join(luaDir, n));
            if (!st) continue;
            // 标出「探针源码 / 备份」这类附属文件 —— 它们**不是**用户的活文件。
            // 仍然列出来（透明），但 chooseLua 选「当前文件」时会跳过它们。
            const auxiliary = isAuxiliaryLuaName(n);
            luaFiles.push({
              name: n, path: path.join(luaDir, n), size: st.size,
              mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs,
              ...(auxiliary ? { auxiliary: true } : {}),
            });
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          }
        }
        levels.push({
          layout: 'folder',
          brand: inst.brand,
          accountId: accDir,
          levelId,
          levelDir,
          gil: gilSt ? { path: gilPath, size: gilSt.size, mtime: gilSt.mtime.toISOString(), mtimeMs: gilSt.mtimeMs } : null,
          luaDir: fs.existsSync(luaDir) ? luaDir : null,
          luaFiles,
          logDir,
          logCount,
          latestLog,
          newestMs: newest,
        });
      }

      // 布局 B：`<关卡ID>.gil` 直接躺在根目录（不在这台机器上编辑的图；节点图数据常在这里）
      const folderIds = new Set(listDirs(saveRoot));
      for (const n of (() => { try { return fs.readdirSync(saveRoot); } catch { return []; } })()) {
        if (!n.toLowerCase().endsWith('.gil')) continue;
        const levelId = n.slice(0, -4);
        if (folderIds.has(levelId)) continue; // 已被布局 A 收录
        const gilPath = path.join(saveRoot, n);
        const gilSt = statSafe(gilPath);
        if (!gilSt) continue;
        levels.push({
          layout: 'root-gil',
          brand: inst.brand,
          accountId: accDir,
          levelId,
          levelDir: saveRoot,
          gil: { path: gilPath, size: gilSt.size, mtime: gilSt.mtime.toISOString(), mtimeMs: gilSt.mtimeMs },
          luaDir: null,
          luaFiles: [],
          logDir,
          logCount,
          latestLog,
          newestMs: gilSt.mtimeMs,
        });
      }
    }
  }
  levels.sort((a, b) => b.newestMs - a.newestMs);
  return levels;
}

/** 选「当前正在开发的关卡」：优先有活文件且最近改动的。 */
export function pickCurrent(levels = scanLevels(), brand) {
  const pool = brand ? levels.filter((l) => new RegExp(brand).test(l.brand)) : levels;
  const withLua = pool.filter((l) => l.luaFiles.length > 0);
  const ranked = (withLua.length ? withLua : pool).slice().sort((a, b) => b.newestMs - a.newestMs);
  return ranked[0] || null;
}

/**
 * 按关卡 ID / 品牌 / 脚本名找。
 * ⚠️ 同一个 levelId 可能存在于**多个账号**下（各有一份 .gil），这里优先取「带活文件」的那个，
 *    其余作为 `alsoFound` 一并返回，避免"选错了图还浑然不觉"。
 */
export function findLevel(levels, q) {
  if (!q) return null;
  const s = String(q);
  const byId = levels.filter((l) => l.levelId === s);
  if (byId.length) return byId.find((l) => l.luaFiles.length > 0) || byId[0];
  return levels.find((l) => l.brand.includes(s) || l.accountId === s)
    || levels.find((l) => l.luaFiles.some((f) => f.name.includes(s)))
    || null;
}

