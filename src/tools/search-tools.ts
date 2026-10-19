/**
 * ============================================================================
 * Search 工具 (web_search / web_fetch)
 * ============================================================================
 *
 * 【这一层解决什么问题】
 * Claude Code 的 WebSearch、Cursor 的联网搜索，底层都是一个普通 Tool——
 * 调一个搜索 API 拿结果，和 get_weather 没有本质区别。有意思的是选型：
 *
 * - Google 代理型（Serper）：帮你调 Google，返回 snippet（一两句），
 *   快（200-500ms）、便宜（$0.30-1/1K），但想看详情得再配一个抓全文的工具；
 * - AI 原生型（Tavily）：搜索 + AI 增强的结果处理（提取完整段落 + 摘要回答），
 *   贵（$5-8/1K）、慢（1-2s），但"找了资料还做了笔记"。
 *
 * 【双引擎架构】
 * 两个引擎注册的工具名都叫 web_search——模型不关心后端是谁。
 * .env 里配了 TAVILY_API_KEY 用 Tavily，配了 SERPER_API_KEY 用 Serper，
 * pickSearchTool() 启动时自动选。以后要加 Brave，只写一个 braveSearchTool
 * 加进判断里即可，其余代码零改动。
 *
 * 【web_fetch 的设计】
 * fetch_url 粗暴地删掉 HTML 标签返回纯文本；web_fetch 用 Turndown 转 Markdown，
 * 保留标题层级、链接、代码块、列表——LLM 读起来信息密度更高。
 * 手写正则做转换看着简单，但嵌套标签、自闭合标签、HTML 实体、表格每个都是坑，
 * 没必要自己造轮子。
 */

import TurndownService from 'turndown';
import type { ToolDefinition } from './registry.js';

// ── Tavily（自动挡）─────────────────────────────────────────────────────────

export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置';

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results,
        include_answer: true,
      }),
    });

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

    const data = (await res.json()) as any;
    const lines: string[] = [];

    if (data.answer) {
      lines.push(`## AI 摘要\n${data.answer}\n`);
    }

    for (const r of data.results || []) {
      lines.push(`### ${r.title}`);
      lines.push(r.url);
      lines.push(r.content || r.snippet || '');
      lines.push('');
    }

    return lines.join('\n') || '没有找到相关结果';
  },
};

// ── Serper（手动挡）─────────────────────────────────────────────────────────

export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置';

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: max_results }),
    });

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

    const data = (await res.json()) as any;
    const lines: string[] = [];

    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      lines.push(`## ${kg.title}`);
      if (kg.description) lines.push(kg.description);
      lines.push('');
    }

    for (const r of (data.organic || []).slice(0, max_results)) {
      lines.push(`### ${r.title}`);
      lines.push(r.link);
      lines.push(r.snippet || '');
      lines.push('');
    }

    return lines.join('\n') || '没有找到相关结果';
  },
};

/**
 * 启动时按环境变量挑一个搜索后端
 *
 * 都没配时返回 Tavily（执行时会提示去配 Key，而不是启动就崩）。
 */
export function pickSearchTool(): ToolDefinition {
  if (process.env.TAVILY_API_KEY) return tavilySearchTool;
  if (process.env.SERPER_API_KEY) return serperSearchTool;
  return tavilySearchTool; // 默认（会提示配 Key）
}

// ── web_fetch（手动挡配套）──────────────────────────────────────────────────

/** HTML 转 Markdown：去掉这些噪音标签，只留正文 */
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.remove(['script', 'style', 'nav', 'footer', 'noscript', 'iframe']);

/**
 * 兜底页面：没网时用预置内容，保证 demo 离线可跑
 *
 * 兜底页面从 fetch_url 的 MOCK_PAGES 迁移而来——演示场景保留，
 * 生产环境应去掉这层直接抓线上内容。
 */
const MOCK_PAGES: Record<string, string> = {
  'https://esm.sh': `esm.sh —— 一个免费的 ES module CDN。
它把 npm 上的包重新打包成浏览器可直接 import 的 ES module，
所以不需要 webpack / Vite，也能在浏览器里 import 第三方库。`,
  'https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling': `AI SDK Core - Tools and Tool Calling
工具是模型可以决定调用的函数。一个工具由三部分组成：
- description：告诉模型何时使用这个工具
- inputSchema：通过 Zod 或 JSON Schema 定义参数
- execute：实际在服务端运行的函数
模型只负责决定调用哪个工具、传什么参数；真正的执行由运行时完成。`,
  'https://ai-sdk.dev/docs/ai-sdk-core/generating-text': `AI SDK Core - Generating Text
streamText 是 AI SDK 的流式文本生成入口。
它返回一个 fullStream，可以逐个消费 text-delta / tool-call / tool-result 事件；
把 tools 传进去之后，SDK 会自己执行工具，并把结果组装进 response.messages。`,
};

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key];
    }
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `抓取失败: HTTP ${res.status}`;
      const html = await res.text();
      return turndown.turndown(html);
    } catch (err: any) {
      return `抓取失败: ${err.message}`;
    }
  },
};
