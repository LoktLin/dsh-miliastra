#!/usr/bin/env node
/**
 * 从 `index.js` 的 `TOOLS` 生成 README 里的「工具速查」块。
 *
 *   node tools/gen-readme-tools.mjs --write    # 刷新 README 里对应的块
 *   node tools/gen-readme-tools.mjs            # 只打印（不写盘）
 *
 * 为什么要生成：README 是**第二份副本**，手写的工具清单**必然漂移**
 * （实测：README 第一段的版本号曾一路停在 0.0.1 六次发布没人发现；
 * 系统提示段的工具指路漏了 4 个版本）。所以工具清单不做手写 ——
 * 从**唯一真身**（工具 schema）生成，并由 `tests/readme-test.mjs` 逐字比对。
 *
 * ⚠️ 工具改完（加 op / 加参数 / 改描述）→ 跑一次 `--write`，否则测试会红。
 * ⚠️ 生成块**不要手改**：手改会在下一次 `--write` 时被覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const README_PATH = path.join(here, '..', 'README.md');
export const BEGIN = '<!-- BEGIN GENERATED:tools -->';
export const END = '<!-- END GENERATED:tools -->';

/** 阅读顺序：按「人/AI 实际会用的顺序」排，不按代码定义顺序。 */
const ORDER = [
  'miliastra_health',
  'miliastra_code',
  'miliastra_map',
  'miliastra_log',
  'miliastra_playtest',
  'miliastra_shot',
  'miliastra_probe',
  'miliastra_echo',
];

function typeOf(schema) {
  const t = schema && schema.type;
  if (Array.isArray(t)) return t.join(' | ');
  if (t === 'array') return `array<${(schema.items && schema.items.type) || 'any'}>`;
  return t || 'any';
}

function valuesOf(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => `\`${v}\``).join(' / ');
  if (schema.type === 'boolean') return '`true` / `false`';
  if (schema.type === 'array') return '——';
  return schema.default !== undefined ? `默认 \`${JSON.stringify(schema.default)}\`` : '——';
}

/** 生成块正文（不含 BEGIN/END 标记）。**纯函数**：同输入必得同输出。 */
export function renderToolsSection() {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const missing = ORDER.filter((n) => !byName.has(n));
  const extra = [...byName.keys()].filter((n) => !ORDER.includes(n));
  const names = [...ORDER.filter((n) => byName.has(n)), ...extra];

  const out = [];
  if (missing.length) {
    out.push(`> ⚠️ 生成器里列了但**工具不存在**：${missing.map((n) => `\`${n}\``).join(' / ')}（\`tools/gen-readme-tools.mjs\` 的 \`ORDER\` 该改了）`);
    out.push('');
  }
  if (extra.length) {
    out.push(`> ⚠️ **新工具**（还没进 \`ORDER\`，已排在最后）：${extra.map((n) => `\`${n}\``).join(' / ')}`);
    out.push('');
  }

  for (const name of names) {
    const tool = byName.get(name);
    const props = (tool.parameters && tool.parameters.properties) || {};
    const required = new Set((tool.parameters && tool.parameters.required) || []);
    const keys = Object.keys(props);

    out.push(`#### \`${name}\``);
    out.push('');
    out.push(tool.description.trim());
    out.push('');
    if (!keys.length) {
      out.push('**参数**：无。');
      out.push('');
      continue;
    }
    out.push('| 参数 | 类型 | 必填 | 取值 | 说明 |');
    out.push('|---|---|---|---|---|');
    for (const key of keys) {
      const schema = props[key] || {};
      // 参数说明也带上：AI 与人读这一份就够（否则「改了 description 要跑生成器」这句话对参数不成立）
      const desc = String(schema.description || '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      out.push(
        `| \`${key}\` | \`${typeOf(schema)}\` | ${required.has(key) ? '**是**' : '否'} | ${valuesOf(schema)} | ${desc} |`,
      );
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/** 文件自己的行尾 —— 生成块必须跟着它，不然会写出「一半 CRLF 一半 LF」的文件。 */
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** 把 README 里两个标记之间的内容替换成 `renderToolsSection()`。返回新全文。 */
export function spliceIntoReadme(readme) {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`README 里找不到成对的标记 → ${BEGIN} … ${END}`);
  }
  const eol = eolOf(readme);
  let body = renderToolsSection();
  if (eol === '\r\n') body = body.replace(/\n/g, '\r\n');
  return readme.slice(0, start + BEGIN.length) + eol + body + readme.slice(end);
}

/** 只读出标记之间的正文（不比对）。**统一成 LF**（否则 CRLF 与 LF 会被当成不一致）。 */
export function extractToolsSection(readme) {
  const start = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || end < start) return { markersFound: false, body: null };
  const body = readme
    .slice(start + BEGIN.length, end)
    .replace(/^\r?\n/, '')
    .replace(/\r\n/g, '\n');
  return { markersFound: true, body };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const next = spliceIntoReadme(readme);
  if (process.argv.includes('--write')) {
    if (next === readme) {
      console.log('README 的工具速查块**已是最新**，没有改动。');
    } else {
      fs.writeFileSync(README_PATH, next);
      console.log(`已刷新 README 的工具速查块（${readme.length} → ${next.length} 字符）。`);
    }
  } else {
    console.log(renderToolsSection());
  }
}
