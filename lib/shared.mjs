/**
 * **工具之间共享**的解析/判定函数（阶段 3 拆文件：从 `index.js` 机械搬移，行为零改动）。
 *
 * 为什么单开一个模块：这些符号被**多个**工具用到（`resolveLevel` 实测被 11 处引用），
 * 搬进任何一个 `lib/tools/<tool>.mjs` 都会让别的工具**反向 import 那个工具** ⇒ 循环依赖 + TDZ 风险。
 *
 * `index.js` 对它们**再导出**，因此外部既有引用（测试 / 面板）不受影响。
 */
import { findLevel, localLowRoot, pickCurrent, scanLevels } from './locate.mjs';

export function resolveLevel(q) {
  const levels = scanLevels();
  if (q && String(q).trim()) {
    const hit = findLevel(levels, q);
    if (!hit) {
      const avail = levels.map((l) => `${l.brand}/${l.levelId}[${l.luaFiles.map((f) => f.name).join(',') || '无脚本'}]`);
      throw new Error(`找不到关卡 "${q}"。现有：${avail.join('  ') || '（一个都没扫到）'}`);
    }
    return hit;
  }
  const cur = pickCurrent(levels);
  if (!cur) throw new Error(`在 ${localLowRoot()} 下没扫到任何关卡目录。确认原神/千星编辑器开过图，或用参数指定。`);
  return cur;
}
