/**
 * 共享的 fs 小工具（**一处实现、处处复用**）。
 *
 * ★ 为什么单独成模块：`atomicWriteFile` 原来是 `lib/codefile.mjs` 里的私有实现，
 * 而"要写盘的地方"其实不止活文件 —— 模拟器的存档/配方/清单、截图 PNG、导出的 .gia 都在写。
 * 实测（2026-09-24 源码体检）当时的状况是：
 *   · `codefile.mjs` 走**硬化**路径（同目录 tmp + `fsync` + rename + 失败清理 + 不跨卷）；
 *   · `sim.mjs` 的 JSON 是**手搓** tmp+rename（没 fsync、失败会把 `.tmp<pid>` 漏在盘上）；
 *   · `sim.mjs` 的截图/导出更是**裸 `writeFileSync`**（断电/被杀进程可能留下半截 PNG）。
 * 同一个动作两种（其实三种）实现，就是"能复用就复用"最该修的地方 —— **健壮性要长在唯一的实现上**。
 *
 * 纪律：**凡是我们自己写的文件都走这里**（唯一例外见 `sim-play/play.html` 的版本戳注入，
 * 那是响应体内存注入、不落盘）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子替换写入：写同目录临时文件 → `fsync`（把数据真正刷到盘上）→ `rename` 覆盖。
 * 同一卷上的 rename 是原子操作：目标要么还是旧内容、要么已经是完整的新内容，
 * **不存在「写了一半」的中间态**；失败时删掉临时文件并把错误抛出去（旧文件仍然完好）。
 *
 * ⚠️ 临时文件必须与目标**同目录** —— 跨卷 rename 会失败并退化成非原子拷贝。
 *
 * @param {string} dest 目标路径
 * @param {Buffer|Uint8Array|string} buf 内容（字符串按 UTF-8 写）
 * @returns {string} dest
 * @throws 写失败时抛出（调用方负责回报，并知道**旧文件仍然完好**）
 */
export function atomicWriteFile(dest, buf) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // 临时文件必须与目标**同目录**（跨卷 rename 会失败并退化成非原子拷贝）
  const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, 0, data.length, 0);
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

/**
 * 原子写 JSON（带缩进 + 结尾换行，便于人看 diff）。`prettyJson(obj)` 单独导出，
 * 是为了让"我到底写了什么字"能被断言（纯函数）。
 */
export function prettyJson(obj, indent = 2) {
  return JSON.stringify(obj, null, indent) + '\n';
}

/** 原子写一份 JSON 文件。 */
export function atomicWriteJson(dest, obj, indent = 2) {
  return atomicWriteFile(dest, Buffer.from(prettyJson(obj, indent), 'utf8'));
}
