/**
 * shot.mjs — 截图：把「游戏现在长什么样」变成一张 PNG
 *
 * 为什么要它：运行时日志（`.gia`）能回答「代码跑了没、print 了什么」，
 * 但回答不了「画面对不对」——控件是不是真的挂上去了、位置歪没歪、颜色对不对。
 * 这一环以前只能靠人截图再手动贴回来，现在做成工具。
 *
 * ── 三条设计决定（都是有理由的，别随手改） ─────────────────────────────
 *
 * ① **落盘在插件自己的数据目录，不是活文件目录、也不是包目录**
 *    `~/.dsh/miliastra/shots/`（`MILIASTRA_DATA_DIR` 可整体覆盖）：
 *    · 不放 `external_lua_file\` —— 那里是米哈游的存档，混进一堆 PNG 会污染，
 *      而且「活文件 = 目录下的 .lua」这类判断最怕旁边多东西；
 *    · 不放 `node_modules\dsh-miliastra\` —— 升级/重装插件会**整个替换掉**那个目录，
 *      用户的图会凭空消失。
 *    所以放在「既不属于存档、也不属于包」的第三个地方，并**把绝对路径回给用户**。
 *
 * ② **绝不自动删**（和备份同样的原则）
 *    磁盘是用户的，删除不可恢复。`clean` 只按**显式条件**干活，默认 `dryRun`，
 *    真删还要 `confirm:true`。工具只负责把「在哪、有多少、占多大」摆清楚让人自己决定。
 *
 * ③ **回执必须写明「截到的到底是哪个窗口」**
 *    第一版用 `CopyFromScreen` 抓游戏矩形，结果抓回来的是**恰好压在前面的浏览器**，
 *    而当时返回体里只有 `{ok:true,path}` —— 光看返回值完全无法发现。
 *    现在恒回 `pid / process / title`，错了一眼就能看出来。
 *
 * 截图本身走 `capture-window.ps1`（Node 在 Windows 上没有内建的窗口截图能力）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 可截的目标。`process` 是进程名（不带 .exe），`label` 是给人看的名字。 */
export const SHOT_TARGETS = {
  game: { process: 'YuanShen', label: '游戏画面', why: '试玩时游戏真的长什么样 —— 控件的实际观感只能靠它' },
  editor: { process: 'BeyondEditor', label: '千星沙箱编辑器', why: '编辑器侧界面（节点图资源管理器等）' },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_SCRIPT = path.join(HERE, 'capture-window.ps1');

/* ------------------------------------------------------------------ 纯函数 */

/**
 * 洗一个标签，让它能安全进文件名。
 * **允许中文**（Windows 文件名没这个限制，而中文标签可读性最好），
 * 只清掉路径非法字符与控制字符，并把连续空白折叠成一个 `-`。
 */
export function sanitizeLabel(raw, maxLen = 24) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');        // 控制字符
  s = s.replace(/[\\/:*?"<>|]/g, '');                  // Windows 文件名非法字符
  s = s.replace(/\s+/g, '-');
  s = s.replace(/^[.\-]+|[.\-]+$/g, '');               // 别让标签以点/横线开头结尾
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/** `YYYYMMDD-HHMMSS`（**本地时间**：用户看文件名时要对得上自己刚才那一局）。 */
export function stampOf(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 文件名：`<target>[-<label>]-<stamp>[-<seq>].png`
 * 例：`game-双相-房间1-20260923-204512.png`
 */
export function shotFileName({ target = 'game', label = '', when = new Date(), seq = 0 } = {}) {
  const t = sanitizeLabel(target) || 'game';
  const l = sanitizeLabel(label);
  const head = l ? `${t}-${l}` : t;
  return `${head}-${stampOf(when)}${seq > 0 ? '-' + (seq + 1) : ''}.png`;
}

/** 同秒重复截图时自动加序号，不覆盖。 */
export function nextFreeName(dir, wanted, exists = (p) => fs.existsSync(p)) {
  if (!exists(path.join(dir, wanted))) return wanted;
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, -ext.length);
  for (let i = 1; i < 1000; i += 1) {
    const cand = `${stem}-${i + 1}${ext}`;
    if (!exists(path.join(dir, cand))) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export function isShotName(name) {
  return /\.png$/i.test(String(name || ''));
}

/** 「1.2 MB」这种给人看的大小。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 决定删哪些（**纯函数** —— 删除不可恢复，判据必须能测）。
 *
 * @param {object} o
 * @param {Array<{path:string,name:string,size:number,mtimeMs:number}>} o.files 全部截图
 * @param {number} [o.keepLast=0]  至少保留最新的 N 张（保护网，任何模式下都生效）
 * @param {number} [o.olderThanDays=0] 只删比这个更旧的（>0 才生效）
 * @param {boolean} [o.all=false]  不管新旧，除 keepLast 外全删
 * @param {number} [o.now=Date.now()]
 * @returns {{delete:Array, keep:Array, bytes:number, note:string}}
 */
export function planClean({ files = [], keepLast = 0, olderThanDays = 0, all = false, now = Date.now() } = {}) {
  const sorted = files.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);   // 新 → 旧
  const k = Math.max(0, Number(keepLast) || 0);
  const protectedSet = new Set(sorted.slice(0, k).map((f) => f.path));
  const days = Number(olderThanDays) || 0;

  if (!all && days <= 0) {
    return {
      delete: [], keep: sorted, bytes: 0,
      note: '既没给 all、也没给 olderThanDays —— 不知道你要删哪些，什么都没删。'
        + '（想全删：all=true；想只删旧的：olderThanDays=7；都受 keepLast 保护）',
    };
  }

  const cutoff = all ? Infinity : now - days * 86400000;
  const del = [];
  const keep = [];
  for (const f of sorted) {
    if (protectedSet.has(f.path)) { keep.push(f); continue; }
    if (all || (Number(f.mtimeMs) || 0) < cutoff) del.push(f); else keep.push(f);
  }
  const bytes = del.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const note = del.length
    ? `将删除 ${del.length} 张（${humanSize(bytes)}），保留 ${keep.length} 张`
      + (k ? `（其中最新 ${Math.min(k, sorted.length)} 张受 keepLast 保护）` : '')
    : '按当前条件没有可删的截图。';
  return { delete: del, keep, bytes, note };
}

/**
 * 判断这次截图**可不可信**（纯函数）。
 *
 * 背景：`capture-window.ps1` 有两条路线，可信度完全不同 ——
 *   · `printwindow`：让窗口自己渲染，不需要它在最前面 → 可信；
 *   · `screen`     ：退回屏幕抓取，**只有目标窗口真的是前台窗口才对**。
 * 第一版就没报这个区别，抓回来一张浏览器截图、回执却是 `ok:true`，全靠人眼看出来。
 *
 * 后来又踩了**两个**「`ok:true` 但图没用」的坑，所以这里一共查四件事：
 *   ① 走屏幕抓取又不在前台 → 很可能是别的程序；
 *   ② 画面全黑（PrintWindow 在某些 D3D surface 上会这样）；
 *   ③ 画面**全是同一个颜色** —— 全白/全灰的空图**能通过黑像素检查**，必须单独判；
 *   ④ 尺寸小得离谱 —— 实测「截编辑器」抓回过一张 **160×28** 的标题栏碎片
 *      （进程有多个窗口，`MainWindowHandle` 指向了被最小化那个），而它当时照样是 `ok:true`。
 *      现在 PS 侧会自己拒掉这种，这里仍然保留，作为第二道防线。
 */
export function judgeCapture(r) {
  if (!r || r.ok === false) return { suspect: true, warning: r && r.error ? String(r.error) : '截图失败' };
  const warn = [];
  let suspect = false;

  const w = Number(r.width);
  const h = Number(r.height);
  if (Number.isFinite(w) && Number.isFinite(h) && (w < 200 || h < 150)) {
    suspect = true;
    warn.push(`图只有 ${w}×${h} —— 这么小的窗口基本不可能是你想截的那个（实测踩过：进程有多个窗口时`
      + '抓到了 160×28 的标题栏碎片）。多半是真正的窗口被最小化或已关掉。');
  }

  const black = Number(r.blackRatio);
  if (Number.isFinite(black) && black > 0.985) {
    suspect = true;
    warn.push(`画面几乎全黑（黑像素 ${(black * 100).toFixed(1)}%）—— 目标窗口很可能没渲染出内容，`
      + '或者它最小化/被遮挡。');
  }

  const uni = Number(r.uniformRatio);
  if (Number.isFinite(uni) && uni > 0.985) {
    suspect = true;
    warn.push(`画面几乎是**单一颜色**（${(uni * 100).toFixed(1)}% 的像素同色）—— 这是一张空图。`
      + '注意「全黑」检查抓不到**全白**，所以才单独量这一项。');
  }

  if (r.mode === 'screen') {
    if (r.front === false) {
      suspect = true;
      warn.push('PrintWindow 没成功，退回了「屏幕抓取」，而目标窗口**不在最前面** —— '
        + '这张图很可能是**别的程序**。请先让目标窗口显示出来再截，或把 bringToFront 打开。');
    } else {
      warn.push('走了「屏幕抓取」路线（目标窗口在前台，所以结果通常正确）；'
        + '但如果你截完又切了窗口，请以回执里的 pid / title 为准。');
    }
  }
  return { suspect, warning: warn.length ? warn.join(' ') : null };
}

/* -------------------------------------------------------------- 连拍（burst） */

/**
 * 连拍的**间隔地板**（两张之间额外等待的最小值，默认也用它）。
 *
 * ⚠️ 这个数字**不是**「每 800ms 能拍一张」——它只是**间歇**的下限。
 *    单张本身的耗时另算：实测本机（起 PowerShell + `PrintWindow` + 顺带出缩略图）**约 2.6 秒/张**
 *    （`PrintWindow` 路线比 `editor-cli screenshot` 的 812~1120ms 慢，因为我们**同时**生成了预览图、省了一次起进程）。
 *    → 真实帧距 ≈ `burstMs + 2600ms`，回执里用 **`measuredIntervalMs`** 如实报出。
 *
 * 由此推出一条**必须提前说清**的边界：**单帧寿命 <1 秒的特效，最多只能抓到 1~2 帧** ——
 * 这是引擎/进程启动的地板，不是参数没调好。
 */
export const BURST_FLOOR_MS = 800;
export const BURST_MAX_COUNT = 20;

/** 间隔夹到地板上；非数字给地板值。 */
export function clampBurstMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return BURST_FLOOR_MS;
  return Math.max(BURST_FLOOR_MS, Math.round(n));
}

/**
 * 连拍计划 —— **纯函数**（不截图、不碰磁盘），所以能单测，也能先 `dryRun` 看一眼。
 *
 * `frames[i].offsetMs` = 相对第一张的偏移（第 0 张永远是 0）。
 */
export function planBurst({ count = 5, intervalMs = BURST_FLOOR_MS } = {}) {
  const rawCount = Number(count);
  const n = Number.isFinite(rawCount) ? Math.min(BURST_MAX_COUNT, Math.max(1, Math.round(rawCount))) : 5;
  const wantMs = Number(intervalMs);
  const eff = clampBurstMs(intervalMs);
  const frames = Array.from({ length: n }, (_, i) => ({ i: i + 1, offsetMs: i * eff }));
  return {
    count: n,
    intervalMs: eff,
    requestedMs: Number.isFinite(wantMs) ? wantMs : null,
    clamped: Number.isFinite(wantMs) && wantMs < BURST_FLOOR_MS,
    floorMs: BURST_FLOOR_MS,
    countCapped: Number.isFinite(rawCount) && Math.round(rawCount) > BURST_MAX_COUNT,
    spanMs: (n - 1) * eff,
    frames,
  };
}

/**
 * 连拍回执摘要 —— **纯函数**。刻意只给文件名/大小/判定，不给 base64（图走 `/miliastra/shot` 路由看）。
 *
 * ⚠️ 这里必须报 **`measuredIntervalMs`（实测帧距）**，因为 `burstMs` **只是两张之间的额外等待**，
 *    不含单张本身的耗时。实测本机（PowerShell + PrintWindow + 顺带缩略图）单张约 **2.6 秒**：
 *    要 `burstMs=800` 时真实帧距是 **~2600ms**，不是 800ms。
 *    只报请求值会让人以为「每 0.8 秒一张」——**参数看起来是那个意思、其实不是**，这种最坑。
 *
 * @param frames 每张的形状：`{ i, file, atMs, ok, suspect, warning, width, height, size, error }`
 * @param startedAtMs 第一张的绝对时刻（用来算 `elapsedMs`）
 */
export function burstSummary(frames, { startedAtMs = null, requestedMs = null } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const okFrames = list.filter((f) => f.ok !== false);
  const suspectFrames = list.filter((f) => f.suspect === true);
  const at = (f) => (Number.isFinite(f.atMs) ? f.atMs : null);
  const firstAt = startedAtMs != null ? startedAtMs : (list.length ? at(list[0]) : null);
  const spanMs = (list.length > 1 && Number.isFinite(at(list[0])) && Number.isFinite(at(list[list.length - 1])))
    ? at(list[list.length - 1]) - at(list[0])
    : 0;
  const measuredIntervalMs = list.length > 1 ? Math.round(spanMs / (list.length - 1)) : null;
  const wantMs = Number.isFinite(requestedMs) ? requestedMs : null;
  return {
    count: list.length,
    okCount: okFrames.length,
    failedCount: list.length - okFrames.length,
    suspectCount: suspectFrames.length,
    spanMs,
    measuredIntervalMs,
    timing: measuredIntervalMs == null
      ? { note: '只有一张，量不出帧距。' }
      : {
        measuredIntervalMs,
        // 单张自身的耗时（不含额外等待）—— 这才是「能拍多快」的真实上限
        perFrameCostMs: measuredIntervalMs,
        note: '`measuredIntervalMs` 是**真实帧距** = 单张耗时 + 你给的间隔。'
          + '本机实测单张（起 PowerShell + PrintWindow + 顺带缩略图）约 **2.6 秒**，'
          + '所以 burstMs=800 时真实帧距约 2600ms。'
          + '**单帧寿命 <1 秒的特效，这个速度注定只能抓到 1~2 帧** —— 是引擎/进程启动地板，不是参数没调好。',
      },
    frames: list.map((f) => ({
      i: f.i,
      file: f.file || null,
      elapsedMs: (firstAt != null && Number.isFinite(f.atMs)) ? f.atMs - firstAt : null,
      ok: f.ok !== false,
      suspect: f.suspect === true,
      width: Number.isFinite(f.width) ? f.width : null,
      height: Number.isFinite(f.height) ? f.height : null,
      sizeText: Number.isFinite(f.size) ? humanSize(f.size) : null,
      warning: f.warning || null,
      error: f.error || null,
    })),
    // 只给「看得到」的入口，不把二进制塞进 JSON
    note: '图走 `GET /miliastra/shot?name=<file>` 看原图、`&thumb=1` 看小图；'
      + '回执刻意不带 base64。`elapsedMs` 是相对第一张的真实偏移（连拍时它比 `i×burstMs` 大得多）。'
      + (wantMs != null && measuredIntervalMs != null && measuredIntervalMs > wantMs * 1.5
        ? ' ⚠️ 实测帧距比你要的间隔大不少 —— 差额是**单张自身耗时**，不是没生效。'
        : ''),
  };
}

/* -------------------------------------------------------------- 缩略图 */

/** 缩略图目录：截图目录下的 `_thumbs\`（`listShots` 只收顶层文件，所以它不会被当成截图）。 */
export function thumbsDir(dir = shotsDir()) {
  return path.join(dir, '_thumbs');
}

/** 某张截图对应的缩略图路径（同名，放在 `_thumbs\`）。 */
export function thumbPathFor(dir, name) {
  return path.join(thumbsDir(dir), path.basename(String(name)));
}

/**
 * 把用户给的 `name` 解析成**确认在该截图目录内**的绝对路径（纯路径运算，可单测）。
 *
 * 这是给 HTTP 路由用的：面板要能 `<img src="/miliastra/shot?name=...">`，
 * 所以必须挡住 `../`、绝对路径、子目录、非 PNG。**宁可拒绝，也不许读到目录外的文件。**
 */
export function resolveShotFile(dir, name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return { ok: false, error: '缺少 name' };
  if (raw.includes('/') || raw.includes('\\')) return { ok: false, error: 'name 不能带路径分隔符' };
  if (raw === '.' || raw === '..') return { ok: false, error: 'name 不合法' };
  if (!isShotName(raw)) return { ok: false, error: '只允许 .png' };
  const base = path.resolve(dir);
  const full = path.resolve(base, raw);
  if (path.dirname(full) !== base) return { ok: false, error: '越出截图目录' };
  return { ok: true, path: full, name: raw };
}

/** 缩略图是不是还新鲜（比原图新就算新鲜）。 */
export function thumbIsFresh(thumbFile, srcFile) {
  try {
    const t = fs.statSync(thumbFile);
    const s = fs.statSync(srcFile);
    return t.size > 0 && t.mtimeMs >= s.mtimeMs;
  } catch { return false; }
}

export const THUMB_SCRIPT = path.join(HERE, 'thumbnail.ps1');

/** 调 thumbnail.ps1 生成一张缩略图（截图时已顺带生成过的不会走这里）。 */
export function makeThumbnail({ src, out, width = 320, timeoutMs = 40000, script = THUMB_SCRIPT } = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-In', String(src), '-Out', String(out), '-Width', String(width)];
  return new Promise((resolve) => {
    execFile('powershell', args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
        if (line) {
          try {
            const j = JSON.parse(line);
            resolve(j.ok ? j : { ok: false, error: j.error || '缩略图失败' });
            return;
          } catch { /* 掉到下面统一报错 */ }
        }
        resolve({ ok: false, error: '缩略图脚本没有返回可解析的 JSON' + (err ? '（' + (err.message || err) + '）' : '') });
      });
  });
}

/** 要缩略图就给一张：新鲜就复用，不存在/过期就生成。失败一律回 null，不抛。 */
export async function ensureThumbnail(dir, name, width = 320) {
  const src = path.join(dir, name);
  const out = thumbPathFor(dir, name);
  if (thumbIsFresh(out, src)) return out;
  const r = await makeThumbnail({ src, out, width });
  return r.ok ? out : null;
}

/** 插件的数据根目录：`MILIASTRA_DATA_DIR` > `DSH_HOME/miliastra` > `~/.dsh/miliastra`。 */export function dataRoot(env = process.env, home = os.homedir()) {
  if (env && env.MILIASTRA_DATA_DIR) return path.resolve(String(env.MILIASTRA_DATA_DIR));
  const dsh = (env && env.DSH_HOME) ? String(env.DSH_HOME) : path.join(home, '.dsh');
  return path.join(dsh, 'miliastra');
}

/** 截图目录。 */
export function shotsDir(deps = {}) {
  return path.join(dataRoot(deps.env || process.env, deps.home || os.homedir()), 'shots');
}

/* -------------------------------------------------------------------- IO */

/** 列截图（新的在前）。目录不存在 = 空，不抛。 */
export function listShots(dir = shotsDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { dir, exists: false, count: 0, totalBytes: 0, files: [] }; }
  const files = [];
  for (const name of names) {
    if (!isShotName(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      files.push({
        name, path: path.join(dir, name), size: st.size,
        mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString(),
      });
    } catch { /* 读不到就跳过这一张，不让它毁掉整次列举 */ }
  }
  // 新 → 旧。**mtime 并列时必须再按文件名兜底**：连着截两张常常落在同一毫秒里，
  // 只按 mtime 排就会退化成「readdir 给什么顺序就是什么顺序」—— 面板上同一批图每次刷新
  // 顺序都可能变（实测这条让一个测试偶发失败：断言「新的在前」时拿到 a,b 而不是 b,a）。
  // 文件名里带 `YYYYMMDD-HHMMSS`，所以按名字倒序 ≈ 按时间倒序，是天然的稳定兜底。
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return {
    dir, exists: true, count: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    files,
  };
}

/**
 * 真删。返回实际删掉的与失败的，**不抛**。
 * 顺带把 `_thumbs\` 里对应的预览删掉 —— 否则预览会留下来变成孤儿文件。
 */
export function removeShots(paths, thumbsRoot = null) {
  const removed = [];
  const failed = [];
  const thumbsRemoved = [];
  for (const p of paths || []) {
    const dir = thumbsRoot || thumbsDir(path.dirname(p));
    const thumb = path.join(dir, path.basename(p));
    for (const t of [p, thumb]) {
      try { fs.unlinkSync(t); if (t === thumb) thumbsRemoved.push(t); else removed.push(t); }
      catch (e) {
        // 缩略图不存在是正常的（不是每张都生成过），只有原图删不掉才算失败
        if (t === p) failed.push({ path: p, error: (e && e.message) || String(e) });
      }
    }
  }
  return { removed, failed, thumbsRemoved };
}

/**
 * 调 capture-window.ps1 抓一个窗口。
 *
 * @param {object} o
 * @param {string} o.processName 进程名（不带 .exe）
 * @param {string} o.out         输出 PNG 绝对路径
 * @param {string} [o.thumbOut]  顺带生成一张预览（同一个 bitmap，不额外起进程）
 * @param {string} [o.title]     按窗口标题子串挑窗口（进程有多个窗口时用）
 * @returns {Promise<{ok:boolean, path?:string, width?:number, height?:number, mode?:string,
 *                    front?:boolean, blackRatio?:number, uniformRatio?:number,
 *                    thumbPath?:string, pid?:number, process?:string, title?:string,
 *                    candidates?:Array, error?:string, stderr?:string}>}
 */
export function captureWindow({
  processName, out, title = '', thumbOut = '', thumbWidth = 320,
  bringToFront = 1, keepWindowOnTop = 0, timeoutMs = 90000, script = CAPTURE_SCRIPT,
} = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProcessName', String(processName), '-Out', String(out),
    '-BringToFront', String(bringToFront), '-KeepWindowOnTop', String(keepWindowOnTop)];
  if (title) args.push('-Title', String(title));
  if (thumbOut) args.push('-ThumbOut', String(thumbOut), '-ThumbWidth', String(thumbWidth));
  return new Promise((resolve) => {
    execFile('powershell', args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
        if (line) {
          try {
            const j = JSON.parse(line);
            if (!j.ok) resolve({ ok: false, error: j.error || '截图失败', stderr: String(stderr || '').slice(0, 500) });
            else resolve(j);
            return;
          } catch (e) { /* 掉到下面统一报错 */ }
        }
        resolve({
          ok: false,
          error: '截图脚本没有返回可解析的 JSON' + (err ? '（' + (err.message || err) + '）' : ''),
          stderr: String(stderr || '').slice(0, 500),
        });
      });
  });
}
