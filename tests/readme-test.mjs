#!/usr/bin/env node
/**
 * README 与代码的**一致性**测试（防止「主文档又变旧」）。
 *
 * 背景：本文件（README）是**第二份副本**，手写的工具清单**必然漂移** ——
 * 实测过两次：① 第一段版本号停在 `0.0.1` 六次发布没人发现；
 * ② 系统提示段的工具指路漏了 4 个版本（两个工具在 AI 开场提示里根本没指路）。
 * 所以工具清单**不手写**：由 `tools/gen-readme-tools.mjs` 从 `index.js` 的 `TOOLS` 生成，
 * 这里**逐字比对** + 检查导航表覆盖全部工具 + 检查 README 里没有「已经不存在的工具名」。
 *
 * 失败时怎么办：
 *   - 「生成块与代码不一致」 → 跑 `node tools/gen-readme-tools.mjs --write`
 *   - 「导航表缺某个工具」   → 在 `<!-- BEGIN MANUAL:tool-picker -->` 那一段补一行
 *   - 「README 提到不存在的工具」 → 改文档（或把工具加回去）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../index.js';
import { BEGIN, END, README_PATH, extractToolsSection, renderToolsSection } from '../tools/gen-readme-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_BEGIN = '<!-- BEGIN MANUAL:tool-picker -->';
const MANUAL_END = '<!-- END MANUAL:tool-picker -->';

let passed = 0;
const failures = [];

function t(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`✓ ${name}${detail ? ` —— ${detail}` : ''}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`✗ ${name} —— ${err.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// 统一成 LF 再断言：文件在 Windows 上可能是 CRLF，而 `\n\n` 这种正则会被 `\r` 破坏（实测踩过）
const readme = fs.readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const toolNames = TOOLS.map((tool) => tool.name);
const nameSet = new Set(toolNames);

/* ---- 1. 标记与生成块 ---- */

t('README 里有成对的生成标记', () => {
  assert(readme.includes(BEGIN) && readme.includes(END), `找不到 ${BEGIN} … ${END}；生成块被删了？`);
  return `${BEGIN} … ${END}`;
});

t('README 里有成对的「导航表」标记', () => {
  assert(readme.includes(MANUAL_BEGIN) && readme.includes(MANUAL_END), `找不到 ${MANUAL_BEGIN} … ${MANUAL_END}`);
  return '导航表（人工维护）与生成块分开标记';
});

t('生成块与 `TOOLS` **逐字一致**', () => {
  const { markersFound, body } = extractToolsSection(readme);
  assert(markersFound, '标记缺失');
  const expected = renderToolsSection();
  if (body === expected) return `${expected.length} 字符，与 ${toolNames.length} 个工具的 schema 一致`;
  // 给出**第一处**差异，别只说「不一致」
  const at = [...Array(Math.min(body.length, expected.length) + 1).keys()].find((i) => body[i] !== expected[i]);
  const line = body.slice(0, at).split('\n').length;
  throw new Error(
    `生成块与代码不一致（第一处差异在第 ${line} 行）→ 跑 \`node tools/gen-readme-tools.mjs --write\`；` +
      `块 ${body.length} 字符 vs 代码 ${expected.length} 字符`,
  );
});

/* ---- 2. 导航表必须覆盖全部工具（加了新工具忘了写导航 → 红）---- */

t('导航表覆盖全部工具', () => {
  const start = readme.indexOf(MANUAL_BEGIN);
  const end = readme.indexOf(MANUAL_END);
  const picker = readme.slice(start, end);
  const missing = toolNames.filter((name) => !picker.includes(name));
  assert(!missing.length, `导航表里没有：${missing.join(' / ')}（新工具要补一行「干什么 / 什么时候用」）`);
  return `${toolNames.length}/${toolNames.length}：${toolNames.join(' / ')}`;
});

/* ---- 3. 反向检查：README 不许提到**不存在**的工具 ---- */

t('README 里提到的工具名都真实存在', () => {
  const mentioned = new Set((readme.match(/miliastra_[a-z][a-z_]*/g) || []).map((s) => s));
  const ghosts = [...mentioned].filter((name) => !nameSet.has(name));
  assert(!ghosts.length, `README 提到了不存在的工具：${ghosts.join(' / ')}（改名/删除后忘了改文档？）`);
  return `提到 ${mentioned.size} 个，全部存在`;
});

t('`TOOLS` 里每个工具都在 README 里出现', () => {
  const missing = toolNames.filter((name) => !readme.includes(name));
  assert(!missing.length, `README 完全没提：${missing.join(' / ')}`);
  return `${toolNames.length} 个都在`;
});

/* ---- 4. 每个工具的每个 op 与参数都在生成块里（生成块 = schema 投影）---- */

t('每个 op 取值都出现在生成块里', () => {
  const body = extractToolsSection(readme).body || '';
  const ops = [];
  for (const tool of TOOLS) {
    const props = (tool.parameters && tool.parameters.properties) || {};
    for (const [key, schema] of Object.entries(props)) {
      if (key !== 'op' || !Array.isArray(schema.enum)) continue;
      for (const value of schema.enum) ops.push(`${tool.name}:${value}`);
    }
  }
  assert(ops.length > 0, '一个 op 枚举都没找到 —— 工具结构变了？');
  const missing = ops.filter((pair) => {
    const [tool, value] = pair.split(':');
    const at = body.indexOf('`' + tool + '`');
    return at < 0 || !body.slice(at).includes('`' + value + '`');
  });
  assert(!missing.length, `生成块里找不到：${missing.join(' / ')}`);
  return `${ops.length} 个 op 取值（${[...new Set(ops.map((p) => p.split(':')[0]))].length} 个工具）`;
});

t('每个参数名都在生成块里', () => {
  const body = extractToolsSection(readme).body || '';
  const missing = [];
  for (const tool of TOOLS) {
    const props = (tool.parameters && tool.parameters.properties) || {};
    // 必须定位到**这个小节自己的标题**，不能找第一次出现 —— 别的工具的描述里会提到它（实测踩过：`miliastra_shot` 在别处被提到）
    const at = body.indexOf('#### `' + tool.name + '`');
    const next = body.indexOf('####', at + 1);
    const block = at < 0 ? '' : body.slice(at, next < 0 ? undefined : next);
    for (const key of Object.keys(props)) {
      if (!block.includes('`' + key + '`')) missing.push(`${tool.name}.${key}`);
    }
  }
  assert(!missing.length, `参数表里找不到：${missing.join(' / ')}`);
  const total = TOOLS.reduce((n, tool) => n + Object.keys((tool.parameters && tool.parameters.properties) || {}).length, 0);
  return `${total} 个参数`;
});

/* ---- 5. 入门路径不能被删（第一眼要能看懂）---- */

t('README 有「30 秒上手」且第一步是 `miliastra_health`', () => {
  assert(/\n##+\s*30 秒上手/.test(readme), '找不到「30 秒上手」那一节 —— 那是给第一次上手的人（和 AI）的一条最短路径');
  const at = readme.indexOf('miliastra_health {}');
  assert(at > 0, '「30 秒上手」里没有可照抄的第一步 `miliastra_health {}`');
  return '三步路径完整';
});

/* ---- 5b. 英文入口（照 DSH Release 的双语写法）---- */

/** 取某个 `## ` 小节（到下一个小节为止）。找不到返回 null。 */
const sectionOf = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return null;
  const next = text.indexOf('\n## ', at + 1);
  return text.slice(at, next < 0 ? undefined : next);
};

t('README 顶部有中英语言锚点', () => {
  const m = /\[中文\]\(#[^)]+\)\s*\|\s*\[English\]\(#english-overview\)/.exec(readme);
  assert(m, '第一行下面应有 `[中文](#…) | [English](#english-overview)`（照 DSH Release 的写法）');
  assert(/^# .+\n\n\[中文\]/.test(readme), '语言锚点要贴在标题下面第一行');
  return m[0];
});

t('有 `English overview` 段（可照抄 + 安装要点）', () => {
  const sec = sectionOf(readme, '## English overview');
  assert(sec, '找不到 `## English overview` —— 英文读者没有一眼能懂的入口');
  assert(/30-second quick start/i.test(sec), '英文速览里没有 30-second quick start');
  assert(/miliastra_health \{\}/.test(sec), '英文速览里没有可照抄的第一步 `miliastra_health {}`');
  assert(/dsh\.profile\.bundles/.test(sec), '英文速览没写「必须进 bundles，否则插件完全不加载」');
  return `${sec.length} 字符`;
});

t('`English overview` 覆盖全部工具', () => {
  const sec = sectionOf(readme, '## English overview');
  assert(sec, '找不到 `## English overview`');
  const missing = toolNames.filter((name) => !sec.includes(name));
  assert(!missing.length, `英文速览里没有：${missing.join(' / ')}（加新工具要补一行英文说明）`);
  return `${toolNames.length}/${toolNames.length}`;
});

/* ---- 5c. 渐进式披露：README 只是入口，细节在 docs/ —— 两个方向都要连得上 ---- */

t('README 与 `docs/` 的「按需加载」双向可达', () => {
  const pkgRoot = path.join(here, '..');
  const links = [...new Set([...readme.matchAll(/\]\((docs\/[^)]+\.md)\)/g)].map((m) => m[1]))];
  assert(links.length > 0, 'README 里一个 `docs/…md` 链接都没有 —— 「按需加载」的入口丢了（细节会重新堆回主文档）');
  const missing = links.filter((rel) => !fs.existsSync(path.join(pkgRoot, rel)));
  assert(!missing.length, `README 链接指向不存在的文件：${missing.join(' / ')}`);
  const orphans = fs
    .readdirSync(path.join(pkgRoot, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`)
    .filter((rel) => !links.includes(rel));
  assert(!orphans.length, `docs/ 里有孤立文件（README 没链接，等于没人会读）：${orphans.join(' / ')}`);
  return `链接 ${links.length} 篇，docs/ 无孤立文件`;
});

t('README 第一段的版本号 = package.json', () => {
  const m = /\*\*版本 `([^`]+)`\*\*/.exec(readme);
  assert(m, 'README 第一段找不到「**版本 `x.y.z`**」');
  assert(m[1] === pkg.version, `README 写 ${m[1]}，package.json 是 ${pkg.version}`);
  return pkg.version;
});

/* ---- 汇总 ---- */

console.log(`\n结果：通过 ${passed}，失败 ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failures.length ? 1 : 0);
