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

export function classifyControls(clientUI) {
  const standalone = clientUI.filter((r) => r.parent == null);
  const likelyTemplates = standalone.filter((r) => CLIENT_CONTROL_NAME.test(r.name));
  const likelyContainers = standalone.filter((r) => r.name === '容器节点');
  const structural = standalone.filter((r) => STRUCTURAL_NAME.test(r.name)).map((r) => ({ id: r.id, name: r.name }));
  /*
   * ★ E6（2026-09-29 实战反馈）：`likelyTemplates` 里混进了**容器节点**，与 `likelyContainers` 重叠 ⇒
   *   调用方看着像"4 个候选模板"，其中两个其实不能当控件模板用。
   *   ⇒ 每条给 `role`（container / control），并把重叠**点名**（不删字段：同一批记录两种用途，删了会丢信息）。
   */
  const roleOf = (r) => (likelyContainers.some((c) => c.id === r.id) ? 'container' : 'control');
  const withRole = (list) => list.map((r) => Object.assign({}, r, { role: roleOf(r) }));
  const overlapIds = likelyTemplates.filter((r) => likelyContainers.some((c) => c.id === r.id)).map((r) => r.id);
  const roleNote = overlapIds.length
    ? '⚠️ 有 ' + overlapIds.length + ' 条同时在 likelyTemplates 与 likelyContainers 里（' + overlapIds.join(', ') + '）—— 它们是**容器节点**，不是可创建的控件模板。看 `role` 字段分辨；容器节点不该当控件模板用（控件要 InstantiateClientUIControl，容器由创作者在画布上摆）。多个候选形态相同时：让创作者点名，或删掉多余的那些。'
    : null;
  return { standalone, likelyTemplates: withRole(likelyTemplates), likelyContainers: withRole(likelyContainers), structural, roleNote };
}

export const CLIENT_CONTROL_NAME = /^(容器节点|文本框|文本视窗|图片|界面动效|全屏界面动效|预设按钮|按键提示|光标检测区域|网格视窗|模板引用控件)$/;

export const STRUCTURAL_NAME = /客户端控件容器|布局|HierarchyRoot|小地图|技能区|队伍信息|生命值条|摇杆|退出按钮|语音|选项卡|聊天按钮|网络状态|挣扎按钮|提示队列/;
