/**
 * `miliastra_echo` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import { VERSION } from '../constants.mjs';
import { localLowRoot } from '../locate.mjs';



export const ECHO_TOOL = {
    name: 'miliastra_echo',
    description:
      '调试用：把 text 原样回显，并带上插件版本与本机存档根目录。'
      + '**怀疑「插件没生效 / 面板调不通 Host / 工具参数丢了」时先调它** ——'
      + '返回里带着你传进来的字符串，就不用猜参数到底有没有传到 Host。'
      + '\n\n**典型调用**：`{"text":"ping"}`',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的字符串。' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const text = String(args.text ?? '');
      return { ok: true, echoed: text, length: text.length, version: VERSION, localLow: localLowRoot() };
    },
  };
