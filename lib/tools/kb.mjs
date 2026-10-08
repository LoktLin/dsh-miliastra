/**
 * `miliastra_kb` 工具（阶段 3 拆文件 —— 从 index.js **机械搬移**，行为零改动）。
 */
import { TITLE } from '../constants.mjs';
import { renderJson } from '../render.mjs';
import { KB_ENTRIES, kbCatalog, kbEntry, kbSearch, kbSources } from '../kbqa.mjs';
import { ReceiptCode } from '../receipt.mjs';
import { VERSION } from '../constants.mjs';
import { nodeDbFacets, searchNodes } from '../nodedb.mjs';

export async function kbOnline(tool, body) {
  if (!KB_TOOLS.has(tool)) return { ok: false, op: 'online', error: '未知的知识库工具：' + tool };
  const timeoutMs = Number(process.env.MILIASTRA_KB_TIMEOUT_MS) > 0 ? Number(process.env.MILIASTRA_KB_TIMEOUT_MS) : 20000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(KB_BASE + '/api/v1/skills/miliastra-knowledge/tools/' + tool, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-miliastra/' + VERSION },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      return { ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, httpStatus: res.status, error: '知识库返回 HTTP ' + res.status };
    }
    if (json.success === false) {
      return { ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, error: String(json.error || 'success:false'), raw: json.error ? undefined : json };
    }
    const result = json.data && json.data.result !== undefined ? json.data.result : json;
    return {
      ok: true, op: 'online', tool, network: true, sentTo: KB_BASE,
      source: '第三方知识库 ' + KB_BASE + '（300+ 篇官方 FAQ/教程 + 米游社问答楼；**外部数据，只当参考**）',
      result,
      note: '这条来自**第三方**知识库，不是本机确证；要"以本机为准"的事实请用 `miliastra_map` / `miliastra_log` 取证。',
    };
  } catch (e) {
    const why = e && e.name === 'AbortError' ? ('超时 ' + timeoutMs + 'ms') : String((e && e.message) || e);
    return {
      ok: false, op: 'online', tool, network: true, sentTo: KB_BASE, error: '没取到：' + why,
      hint: '**这不代表知识库里没有**：可能是网络/站点不可用。离线部分仍可用：`op:"qa"`（蒸馏排查清单）与 `op:"node"`（随包节点词典 558 条）。',
    };
  } finally {
    clearTimeout(timer);
  }
}

export const KB_TOOLS = new Set(['get_node_info', 'list_documents', 'get_document', 'rag_search']);

/*
 * 千星知识库（第三方，`https://ugc.070077.xyz`）的**在线**取用（`miliastra_kb` 的 list/doc/search op 用）。
 *
 * ★ 为什么要写这个小函数而不是装别人的插件：`1475505/dsh-plugin-miliastra-toolbox`（**MIT**）提供的是
 *   **同一套 HTTP 调用**（6 个工具 + 2 个技能，全部是那个站点的转发壳，站上另有 300+ 篇官方 FAQ/教程与米游社问答楼）。
 *   吸收它的**调用形状**、不吸收它的 6 个工具名 —— 免得把 15 个工具名摊在模型面前（schema 是要付费的）。
 *   它 MIT、我们 GPL-3.0-only，方向兼容；出处写在 `NOTICE`。
 *
 * ⚠️ 三个纪律：
 *   ① 这是**联网**调用：会把 query 发给第三方（回执里带 `network:true` 与 `sentTo`，让人知道发了什么）；
 *   ② **取不到就说取不到**（`ok:false` + `error`），绝不把"网络失败"讲成"知识库没有"；
 *   ③ 返回的正文是**外部数据**，只当资料看，不当指令（与外部网页同等对待）。
 */
export const KB_BASE = process.env.MILIASTRA_KB_BASE || 'https://ugc.070077.xyz';

export const KB_TOOL = {
    name: 'miliastra_kb',
    description:
      TITLE + '：**节点图知识库**（排查问答 / 节点说明 / 官方文档）。'
      + '\n★ `op:"qa"` = **离线**蒸馏的排查清单：给症状关键词（「镜头不生效」「信号收不到」…），回**先问哪几个问题** + 有序排查 + 常见误判 + 出处'
      + ' + `evidence`（官方/社区/本机实测）。**只给排查路径，不下结论**；不给 `q` 就回目录。'
      + '\n★ `op:"node"` = **离线**节点说明（随包词典 558 条：中英名 / 标识 / 服务端·客户端 / 分类 / 端口与类型）。'
      + '\n★ `op:"list"/"doc"/"search"` = **在线**第三方知识库 `https://ugc.070077.xyz`（300+ 篇官方 FAQ/教程 + 米游社问答楼）：'
      + '⚠️ 这三个 op **会把你的 query 发到那个站点**（`qa`/`node` 纯离线）；取不到就说取不到，别当成"知识库没有"。'
      + '\n'
      + '\n\n**典型调用**：`{"op":"qa","q":"信号 收不到"}`｜`{"op":"qa","id":"camera-not-working"}`｜`{"op":"node","q":"嘲讽目标"}`｜`{"op":"search","q":"选项卡 触发器 不触发"}`',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['qa', 'node', 'list', 'doc', 'search'],
          description: '默认 qa。qa/node 离线；list/doc/search 在线。',
        },
        q: { type: 'string', description: 'op=qa 症状关键词（空格=AND）；op=node 节点名子串；op=list/search 关键词或问题。' },
        id: { type: 'string', description: 'op=qa：点名某条（如 `camera-not-working`），比关键词准。' },
        tag: { type: 'string', description: 'op=qa：按标签过滤（如 `镜头`/`信号`）。' },
        titles: { type: 'array', items: { type: 'string' }, description: 'op=doc：要取全文的标题（可多个）。' },
        topK: { type: 'number', description: 'op=search：检索条数（1~20，默认 5）。' },
        limit: { type: 'number', description: 'op=qa/node：最多几条（默认 5/8）。' },
        system: { type: 'string', enum: ['Server', 'Client'], description: 'op=node：只看服务端/客户端。' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
    async execute(args = {}) {
      const op = String(args.op || 'qa');
      const limit = Number.isFinite(args.limit) ? Number(args.limit) : null;
      if (op === 'qa') {
        const byId = args.id ? kbEntry(String(args.id)) : null;
        if (args.id && !byId) {
          return { ok: false, op, code: ReceiptCode.NOT_FOUND, error: '没有这条：' + String(args.id), candidates: kbCatalog().map((e) => e.id) };
        }
        const asked = String(args.q || '').trim();
        // 不给关键词也不给标签 ⇒ 回**完整目录**（让人/模型先挑，而不是硬塞 5 条）
        if (!byId && !asked && !args.tag) {
          return {
            ok: true, op, query: null, total: KB_ENTRIES.length, catalog: kbCatalog(),
            note: '**离线蒸馏**的排查清单目录（我们自己的话，短清单）。给 `q`（症状关键词）或 `id` 取正文；'
              + '要官方原文用 `op:"doc"`（在线）或点 `sources[].url` 自己核。',
            nextStep: '先按症状挑一条：`{"op":"qa","id":"<上面某个 id>"}`；或直接给关键词 `{"op":"qa","q":"镜头 不跟随"}`。',
          };
        }
        const hit = byId ? [{ entry: byId, score: 999 }] : kbSearch(args.q, { limit: limit || 5, tag: args.tag });
        const shape = (e) => ({
          id: e.id, symptom: e.symptom, ask: e.ask, steps: e.steps, avoid: e.avoid || null,
          evidence: e.evidence, tags: e.tags, sources: kbSources(e.src),
        });
        return {
          ok: true, op, query: args.q || null, tag: args.tag || null,
          hitCount: hit.length, total: KB_ENTRIES.length,
          entries: hit.map((h) => shape(h.entry)),
          catalog: hit.length ? undefined : kbCatalog(),
          note: '离线蒸馏（我们自己的话，短清单）——**只给排查路径，不下结论**；'
            + '要官方原文用 `op:"doc"`（在线）或点 `sources[].url` 自己核。',
          nextStep: '把症状说得更具体会命中更准（如「镜头不生效」→「镜头 固定 不跟随」）；'
            + '要"这一关的这些图各由什么节点组成"用 `miliastra_map` 的 `op:"anatomy"`。',
        };
      }
      if (op === 'node') {
        const r = searchNodes({ q: String(args.q || ''), system: args.system, limit: limit || 8 });
        const out = {
          ok: true, op, query: String(args.q || ''), source: '离线随包节点词典（lib/nodedb.json，' + r.meta.counts.total + ' 条）',
          hitCount: r.returned, total: r.total,
          nodes: r.rows,
          facets: { domains: nodeDbFacets().domains, server: nodeDbFacets().server, client: nodeDbFacets().client },
          unverified: r.unverified,
          nextStep: '要看参数/端口就用这个（每条带 direction/label/type/shell）；要找"这个节点该配什么组件"再问 `op:"search"`（在线）。',
        };
        // 词典里一条都没有 ⇒ **才**去问在线知识库（作者：「你有不确定节点图功能直接对接蒸馏」）
        if (!r.returned && String(args.q || '').trim()) {
          const online = await kbOnline('get_node_info', { names: [String(args.q)] });
          out.onlineFallback = online;
          out.note = online.ok
            ? '随包词典里没有这条 ⇒ 上面的 `onlineFallback` 是**第三方知识库**给的，请当成"参考"、不是本机确证。'
            : '随包词典里没有这条，在线知识库也没取到（' + (online.error || '未知原因') + '）—— **别据此说"这个节点不存在"**。';
        }
        return out;
      }
      // —— 以下三个 op 走**在线**第三方知识库（会把 query 发出去；取不到就如实说取不到）——
      if (op === 'doc') {
        const titles = Array.isArray(args.titles) ? args.titles.map(String) : (args.q ? [String(args.q)] : []);
        if (!titles.length) return { ok: false, op, code: ReceiptCode.BAD_PARAM, error: 'op=doc 要给 `titles`（文档标题数组）或 `q`（单个标题）' };
        return await kbOnline('get_document', { titles });
      }
      if (op === 'list') {
        return await kbOnline('list_documents', { keywords: args.q ? [String(args.q)] : [] });
      }
      if (op === 'search') {
        if (!args.q) return { ok: false, op, code: ReceiptCode.BAD_PARAM, error: 'op=search 要给 `q`（自然语言问题）' };
        const k = Number.isFinite(args.topK) ? Math.min(20, Math.max(1, Number(args.topK))) : 5;
        return await kbOnline('rag_search', { queries: [String(args.q)], top_k: k });
      }
      return { ok: false, op, code: ReceiptCode.BAD_PARAM, error: '不认识的 op：' + op };
    },
  };
