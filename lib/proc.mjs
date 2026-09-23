/**
 * proc.mjs — 本机「原神 / 千星沙箱编辑器」进程状态
 *
 * 实测（2026-09-23 本机）：
 *   · `BeyondEditor.exe` —— **千星沙箱编辑器**（主进程 + 一个渲染进程，两个实例）
 *   · `YuanShen.exe`     —— 原神本体（编辑器试玩跑在它里面）
 *   编辑器**不是** YuanShen 的子进程，是独立可执行文件（在 `BeyondAssets\BeyondAssistEditor\`）。
 *
 * 设计约束：
 *   · **best-effort**：任何失败（tasklist 不存在 / 被拦 / 超时）都回 `available:false`，绝不抛 ——
 *     这个模块的数据只是"锦上添花"，不该让 `miliastra_health` 挂掉。
 *   · **带缓存**：面板每 15 秒刷一次，不能每次都起进程。默认缓存 10 秒。
 */

import { execFileSync } from 'node:child_process';

/** 我们关心的进程：文件名 → 人话标签。 */
const WATCH = [
  ['BeyondEditor.exe', '千星沙箱编辑器'],
  ['YuanShen.exe', '原神（试玩运行环境）'],
];

const TTL_MS = 10000;
let cache = { at: 0, value: null };

/**
 * 取一次进程快照（有缓存）。
 * @param {{force?: boolean, ttlMs?: number}} [opts]
 * @returns {{available:boolean, at:string|null, entries:Array, error?:string, cached?:boolean}}
 */
export function clientProcesses(opts = {}) {
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : TTL_MS;
  const now = Date.now();
  if (!opts.force && cache.value && now - cache.at < ttl) {
    return Object.assign({}, cache.value, { cached: true });
  }

  let value;
  try {
    // /FO CSV /NH：逗号分隔、无表头。列：映像名称,PID,会话名,会话#,内存使用
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });

    const seen = new Map(); // 小写进程名 -> { count, memKB }
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] !== '"') continue;
      const cols = line.split('","');
      const name = cols[0].replace(/^"/, '').trim().toLowerCase();
      if (!name) continue;
      const memRaw = (cols[4] || '').replace(/[^0-9]/g, '');
      const memKB = memRaw ? Number(memRaw) : 0;
      const cur = seen.get(name) || { count: 0, memKB: 0 };
      cur.count += 1;
      cur.memKB += memKB;
      seen.set(name, cur);
    }

    const entries = WATCH.map(([file, label]) => {
      const hit = seen.get(file.toLowerCase());
      return {
        file,
        label,
        running: !!hit,
        instances: hit ? hit.count : 0,
        memoryMB: hit ? Math.round(hit.memKB / 1024) : 0,
      };
    });

    const editor = entries[0];
    const game = entries[1];
    value = {
      available: true,
      at: new Date().toISOString(),
      entries,
      summary: {
        editorRunning: editor.running,
        gameRunning: game.running,
        // 试玩跑在 YuanShen.exe 里 —— 编辑器开着但游戏没开，说明还没进试玩
        canPlaytest: editor.running && game.running,
      },
    };
  } catch (e) {
    value = {
      available: false,
      at: null,
      entries: WATCH.map(([file, label]) => ({ file, label, running: null, instances: 0, memoryMB: 0 })),
      error: '拿不到进程列表（' + ((e && e.message) || String(e)) + '）',
    };
  }

  cache = { at: now, value };
  return value;
}
