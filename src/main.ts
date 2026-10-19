/**
 * ============================================================================
 * CLI 交互主程序（工具系统 → 搜索 → MCP）
 * ============================================================================
 *
 * 【核心升级】
 * 1. 工具统一注册进 ToolRegistry，启动时打印完整清单（内置 / MCP 来源可辨）；
 * 2. 搜索工具按环境变量二选一（Tavily / Serper），web_fetch 是手动挡配套；
 * 3. 连接 MCP Server（三层降级：真实 → 连接失败降级 Mock → 无 token 直接 Mock），
 *    MCP 工具带 mcp__<server>__<tool> 前缀，与内置工具共享同一套截断与并发控制；
 * 4. 三层保险丝（短路熔断 / 过载退避 / 全局 Token 预算）。
 */

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createMockModel } from './mock-model.js';
import { allTools } from './tools/built-in-tools.js';
import { pickSearchTool, webFetchTool } from './tools/search-tools.js';
import { MCPClient, MockMCPClient } from './tools/mcp-client.js';
import { ToolRegistry, type ToolDefinition } from './tools/registry.js';
import { runAgentLoop, type BudgetState } from './agent/loop.js';
import { SessionStore } from './session/store.js';
import { PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext } from './context/prompt-builder.js';
import { compact, estimateTokens, CONTEXT_TOKEN_THRESHOLD } from './context/compressor.js';
import { TokenTracker, applyDefense, estimateMessageTokens, CONTEXT_WINDOW } from './context/defense.js';
import { renderContextMatrix, renderUsageSummary } from './context/view.js';
import { UsageTracker, normalizeUsage } from './usage/tracker.js';
import { MemoryStore } from './memory/store.js';
import { createMemoryTool } from './tools/memory-tools.js';
import { VectorStore } from './rag/store.js';
import { pickEmbedder, embed, createMockEmbedder } from './rag/embedder.js';
import { chunkDocument } from './rag/chunker.js';
import { createRagTools } from './tools/rag-tools.js';
import { memoryContext, ragContext, skillsContext } from './context/prompt-pipes.js';
import { SkillLoader } from './skills/loader.js';
import { createSkillCommands } from './commands/skills.js';
import { PluginManager } from './plugins/manager.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import { createPluginCommands } from './commands/plugin.js';
import type { PluginDefinition } from './plugins/types.js';
import { ChannelGateway } from './channels/gateway.js';
import { FeishuChannel } from './channels/feishu.js';
import { createChannelCommands } from './commands/channel.js';
import { HookPipeline } from './security/hooks.js';
import { createSecurityCommands } from './commands/security.js';
import { CronService } from './cron/service.js';
import { createCronTool } from './tools/cron-tools.js';
import { createCronCommands } from './commands/cron.js';
import { SubAgentRegistry } from './agents/registry.js';
import { createSpawnTool } from './tools/spawn-tools.js';
import { createAgentCommands } from './commands/agent.js';
import { loadConfig } from './config/loader.js';
import { LocalTraceRecorder } from './trace/recorder.js';
import { ModelChain } from './model/chain.js';
import { createDispatcher } from './commands/index.js';
import { memoryCommands } from './commands/memory.js';

// ----------------------------------------------------------------------------
// 0. 配置（7-1）：所有可调参数集中在 super-agent.config.json
//    读取顺序：JSON → 替换 ${ENV_VAR} → Zod 校验 + 默认值合并
// ----------------------------------------------------------------------------
const config = loadConfig();

// ----------------------------------------------------------------------------
// 1. 模型初始化与 Provider 适配（配置驱动）
// ----------------------------------------------------------------------------
const baseURL = process.env.MODEL_BASE_URL || config.model.baseURL;
// 主模型的 key：本地代理有自己的口令（MODEL_API_KEY），云端则用配置里的 apiKey
const apiKey = process.env.MODEL_API_KEY || config.model.apiKey || '';
const modelName = process.env.MODEL_NAME || config.model.name;
const useMock = process.env.USE_MOCK_MODEL === 'true';

function resolveModel() {
  if (!useMock && apiKey) {
    const openaiProvider = createOpenAI({
      baseURL,
      apiKey,
    });
    console.log(`[Runtime] 正在使用真实模型: ${modelName} (${baseURL})`);
    return openaiProvider.chat(modelName);
  }

  console.log('[Runtime] 正在使用本地模拟模型 (Mock Model)');
  return createMockModel();
}

const model = resolveModel();

/**
 * 模型降级链：主模型 → config.model.chain 里的候选（同一个 provider）
 *
 * 免费额度按模型给、还会到期，所以链里排一串候选；当前这个报"额度用尽/无权限/
 * 不存在/key 无效"时，Agent Loop 会自动切到下一个重试本步（不消耗重试次数）。
 */
function buildModelChain(): ModelChain | undefined {
  const primary = { name: modelName, model };
  // 链的 key：优先配置文件（可能写成 ${DASHSCOPE_API_KEY}），否则直接用环境变量
  const chainKey = config.model.apiKey || process.env.DASHSCOPE_API_KEY || '';
  const entries = (config.model.chain || []).filter((e) => e && e !== modelName);
  if (entries.length === 0) return undefined;

  const sameProvider = chainKey
    ? createOpenAI({ baseURL: config.model.baseURL, apiKey: chainKey })
    : undefined;

  const candidates = entries.map((entry) => {
    if (typeof entry === 'string') {
      if (!sameProvider) return undefined; // 没有 key 时跳过同厂商候选
      return { name: entry, model: sameProvider.chat(entry) };
    }
    // 另一个厂商：自带 baseURL / apiKey（例如 StepFun、Agnes）
    const provider = createOpenAI({ baseURL: entry.baseURL, apiKey: entry.apiKey });
    return { name: entry.name, model: provider.chat(entry.name) };
  });

  const valid = candidates.filter(Boolean) as { name: string; model: any }[];
  if (valid.length === 0) return undefined;
  return new ModelChain([primary, ...valid]);
}

const modelChain = buildModelChain();

// ----------------------------------------------------------------------------
// 2. 工具注册中心：所有工具在这里登记，Agent Loop 与模型共用同一份定义
// ----------------------------------------------------------------------------
const registry = new ToolRegistry();
// 搜索工具按环境变量二选一（TAVILY_API_KEY / SERPER_API_KEY），web_fetch 是手动挡配套
registry.register(...allTools, pickSearchTool(), webFetchTool);

// ----------------------------------------------------------------------------
// 4-1：跨会话记忆（MEMORY.md 索引 + 独立 .md 文件）
// ----------------------------------------------------------------------------
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ----------------------------------------------------------------------------
// 4-2：RAG 知识库（内存向量存储 + 混合检索）
//   生产可换 SQLite + sqlite-vec + FTS5 三表架构（接口一致，见 rag/store.ts 注释）
// ----------------------------------------------------------------------------
const vectorStore = new VectorStore();
const picked = pickEmbedder();
let embedFn = picked.embedFn;
let embedMode = picked.mode;

/**
 * 带降级的 embedding
 *
 * 云端 embedding 可能因为 Key 无效 / 额度用尽 / 网络问题失败——知识库属于增强能力，
 * 不该让整个 Agent 起不来。失败一次就切到本地 mock 向量（确定性哈希，无网络依赖），
 * 并打一行警告；已经缓存过的向量不会混用（失败发生在缓存之前）。
 */
const embedWithFallback = async (texts: string[]): Promise<number[][]> => {
  try {
    return await embed(embedFn, texts);
  } catch (err: any) {
    if (embedMode === 'mock') throw err;
    console.warn(
      `  [embedding] 云端调用失败（${String(err?.message || err).slice(0, 120)}），降级为本地 mock 向量`,
    );
    embedFn = createMockEmbedder();
    embedMode = 'mock';
    return await embed(embedFn, texts);
  }
};

registry.register(...createRagTools(vectorStore, embedWithFallback));

// ----------------------------------------------------------------------------
// 5-1：Skills（领域知识包：写一个 SKILL.md 就能给 Agent 加一种专业能力）
// ----------------------------------------------------------------------------
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ----------------------------------------------------------------------------
// 5-2：Plugins（能力通过插件动态加载，核心只管推理循环与工具调度）
// ----------------------------------------------------------------------------
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([['supabase', supabasePlugin]]);

// ----------------------------------------------------------------------------
// 6-1：安全 —— Hook 管线（角色过滤在 Registry 里，bash 风险检测在 execute 包装层）
//   Hook 只在启动时注册，运行期没有增删 API：Agent 不能改自己的安全检查，
//   否则 prompt injection 就能把检查全关掉。
// ----------------------------------------------------------------------------
const hookPipeline = new HookPipeline();

// 示例 Pre Hook：写文件前记一条审计日志（生产环境可写到日志平台 / 数据库）
if (config.security.auditLog) {
  hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const target = (input as any)?.path || (input as any)?.filePath || 'unknown';
      console.log(`  [audit] 文件写入操作: ${toolName} → ${target}`);
    }
    return { action: 'allow' };
  });
}

// 示例 Post Hook：给 bash 输出加 ISO 时间戳
if (config.security.bashTimestamp) {
  hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      return { action: 'modify', modifiedOutput: `[${new Date().toISOString()}]\n${output}` };
    }
    return { action: 'allow' };
  });
}

registry.setHookPipeline(hookPipeline);
// 7-1：默认角色由配置决定（终端自己用 owner，暴露给别人时改 collaborator/guest）
registry.setRole(config.security.defaultRole);

// ----------------------------------------------------------------------------
// 6-2：定时任务（Agent 从"被动响应"到"主动做事"）
// ----------------------------------------------------------------------------
const cronService = new CronService(config.cron.dataDir);
registry.register(createCronTool(cronService));

// ----------------------------------------------------------------------------
// 6-3：Sub-Agent（用独立上下文做探索，压缩后回传结论，父上下文保持干净）
// ----------------------------------------------------------------------------
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
  defaultTimeout: config.agents.defaultTimeout,
});

/** 扫描 docs/ 目录并导入知识库（启动时自动跑，导入结果注入 ragContext） */
async function ingestDocsDir(): Promise<void> {
  const docsDir = path.resolve(process.cwd(), 'docs');
  if (!existsSync(docsDir)) return;

  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return;

  console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
  for (const file of files) {
    const relPath = `docs/${file}`;
    const text = readFileSync(path.join(docsDir, file), 'utf-8');
    const chunks = chunkDocument(relPath, text);
    const embeddings = await embedWithFallback(chunks.map((c) => c.text));
    vectorStore.addBatch(
      chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
      embedMode,
    );
    console.log(`    ${file} → ${chunks.length} 个片段`);
  }
  console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段（embedding: ${embedMode}）`);
}

// ----------------------------------------------------------------------------
// 2-5：连接 MCP Server（三层降级，保证没有 MCP 也能正常工作）
//   有 token + 环境支持 spawn → 连真实 GitHub MCP Server
//   连接过程出错            → 降级 Mock
//   压根没配 token          → 直接用 Mock
// ----------------------------------------------------------------------------
async function connectMCP(): Promise<void> {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      const client = new MCPClient('npx', ['-y', '@modelcontextprotocol/server-github'], {
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      });
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

// ----------------------------------------------------------------------------
// 2-6：ToolSearch 延迟加载
//   问题：工具从 10 个涨到 50 个，模型选择准确率从 90% 掉到不足 50%；
//         工具定义本身还要吃 3-5 万 token，且一变就废掉 KV Cache。
//   做法：高频工具常驻，低频工具（MCP 全部）标记 shouldDefer，
//         模型先用 tool_search 拿到完整 Schema，发现过的工具随后进入每轮 prompt。
// ----------------------------------------------------------------------------

/** 模拟一批 Notion / Browser / Supabase 工具，把「工具膨胀」问题造出来
 *  （不再注册到运行时——防线实战用不到，保持启动干净；定义留着便于演示） */
function registerSimulatedTools(): number {
  const mk = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    searchHint: string,
    mock: (args: any) => unknown,
  ): ToolDefinition => ({
    name,
    description,
    parameters: { type: 'object', properties, required: [] },
    shouldDefer: true,
    searchHint,
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (input: any) => JSON.stringify(mock(input)),
  });

  const simulatedTools: ToolDefinition[] = [
    // Notion
    mk('mcp__notion__search_pages', '[MCP:notion] 搜索 Notion 页面',
      { query: { type: 'string' } }, 'notion search pages documents',
      ({ query }) => [{ title: `Mock: ${query}`, id: 'page-001' }]),
    mk('mcp__notion__create_page', '[MCP:notion] 创建 Notion 页面',
      { title: { type: 'string' }, content: { type: 'string' } }, 'notion create page write',
      ({ title }) => ({ id: 'page-new', title })),
    mk('mcp__notion__list_databases', '[MCP:notion] 列出 Notion 数据库',
      {}, 'notion list databases tables',
      () => [{ id: 'db-001', name: 'Tasks' }]),
    // Browser
    mk('mcp__browser__navigate', '[MCP:browser] 导航到指定 URL',
      { url: { type: 'string' } }, 'browser navigate open url webpage',
      ({ url }) => ({ ok: true, url })),
    mk('mcp__browser__screenshot', '[MCP:browser] 截取当前页面截图',
      {}, 'browser screenshot capture image',
      () => ({ saved: 'screenshot.png' })),
    mk('mcp__browser__click', '[MCP:browser] 点击页面元素',
      { selector: { type: 'string' } }, 'browser click element button',
      ({ selector }) => ({ clicked: selector })),
    mk('mcp__browser__fill', '[MCP:browser] 在输入框中填写内容',
      { selector: { type: 'string' }, value: { type: 'string' } }, 'browser fill input form type',
      ({ selector }) => ({ filled: selector })),
    mk('mcp__browser__get_text', '[MCP:browser] 获取页面文本内容',
      {}, 'browser get text content read page',
      () => ({ text: 'Mock page text' })),
    // Supabase
    mk('mcp__supabase__query', '[MCP:supabase] 执行 SQL 查询',
      { sql: { type: 'string' } }, 'supabase database sql query select',
      ({ sql }) => [{ rows: 0, sql }]),
    mk('mcp__supabase__list_tables', '[MCP:supabase] 列出数据库表',
      {}, 'supabase list tables schema',
      () => [{ name: 'users' }, { name: 'orders' }]),
    mk('mcp__supabase__describe_table', '[MCP:supabase] 查看表结构',
      { table: { type: 'string' } }, 'supabase describe table columns schema',
      ({ table }) => ({ table, columns: ['id', 'created_at'] })),
  ];

  registry.register(...simulatedTools);
  return simulatedTools.length;
}

/**
 * tool_search 元工具：不干业务，只按工具名把延迟工具的完整 Schema 取回来
 *
 * 工具名已经全在 System prompt 的延迟清单里了，所以用精确匹配而不是模糊搜索。
 */
const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description:
    '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = registry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
    return results.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};

/**
 * 组装 Prompt Builder（3-1 Prompt Pipe）
 *
 * 注册顺序 = 静态到动态：coreRules → toolGuide → deferredTools 基本不变，
 * sessionContext 每次启动都不同，放最后，这样前缀稳定、cache 不被动态内容杀掉。
 */
function buildPromptBuilder(): PromptBuilder {
  return new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    // 4-1/4-2：记忆与知识库注入。放在 deferredTools 之后、sessionContext 之前——
    // 它们一轮内稳定、两轮间可能变，属于"半动态"，位置就在这里
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillsContext', skillsContext(skillLoader, activeSkills))
    .pipe('sessionContext', sessionContext());
}

/** 4-1：PromptContext 每轮重建——存了新记忆后 system prompt 要立刻反映出来 */
function makePromptCtx(): {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
} {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: 'default',
  };
}

// ----------------------------------------------------------------------------
// 3. 对话历史（Session 持久化）+ 全局跨轮持有的 Token 预算控制器 (Budget Guard)
// ----------------------------------------------------------------------------

// 3-1：对话落盘到 .sessions/<id>.jsonl，pnpm run continue 可恢复上次的对话
const isContinue = process.argv.includes('--continue');
const store = new SessionStore(config.session.id);
const messages: ModelMessage[] = [];
/** 3-2：累积摘要（多次压缩时把旧摘要一起喂给 LLM，保证不丢最早期的信息） */
let sessionSummary = '';

/** 3-3：Token 估算器（精确基准 + 粗估增量）与消息时间戳（TTL 修剪的依据） */
const tracker = new TokenTracker();
const timestamps = new Map<number, number>();

/** 3-4：成本追踪（按价格表逐步记账，落盘 .usage/today.jsonl 可复盘） */
const usageTracker = new UsageTracker(config.usage.trackingFile);
/** provider 名决定 usage 规范化口径（openai 系要把 cache read 从 input 里减出来） */
const providerName = process.env.MODEL_PROVIDER || 'openai';
/** /cache off 时按 cache miss 全价记账，用来对比"开 cache vs 关 cache" */
let cacheEnabled = true;

/** 3-3/3-4：把一步的真实 usage 记账（终端与 Channel 共用） */
function recordUsage({
  usage,
  providerMetadata,
  modelId,
}: {
  usage: any;
  providerMetadata?: any;
  modelId: string;
}): void {
  let norm = normalizeUsage(usage, { provider: providerName, providerMetadata });
  if (!cacheEnabled) {
    // /cache off：把缓存命中的部分按全价重新计入 input，模拟"没有 cache"
    norm = {
      inputTokens: norm.inputTokens + norm.cacheReadTokens + norm.cacheWriteTokens,
      outputTokens: norm.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  tracker.updateFromAPI(norm.inputTokens + norm.cacheReadTokens + norm.cacheWriteTokens);
  const rec = usageTracker.record(modelId, norm);
  if (norm.cacheReadTokens > 0) {
    console.log(`  [cache hit] read ${norm.cacheReadTokens} tokens · $${rec.cost.toFixed(5)}`);
  }
}

/** 压入一条消息并记录时间戳，供 TTL 修剪判断"多久之前的" */
function pushMessage(message: ModelMessage, ageMs = 0): void {
  messages.push(message);
  timestamps.set(messages.length - 1, Date.now() - ageMs);
}
if (isContinue && store.exists()) {
  messages.push(...store.load());
  console.log(`[Session] 恢复会话，${messages.length} 条历史消息（${store.path}）`);
} else {
  console.log('[Session] 新会话');
}
// 全局跨轮持有：保证会话进行中累积记账，不会因为每一句新提问而被函数内部清零
const sessionBudget: BudgetState = {
  used: 0,
  limit: 25000, // 设定 25,000 Token 上限，超出即熔断
};

// ----------------------------------------------------------------------------
// 4. 交互式对话主循环 (接入三层保险丝体系 + 工具注册中心)
// ----------------------------------------------------------------------------
async function main() {
  await connectMCP();

  registry.register(toolSearchTool);

  // 4-2：启动时自动导入 docs/ 目录（配置可关）
  if (config.rag.enabled) await ingestDocsDir();

  // 按配置加载插件
  console.log('  加载插件...');
  for (const pluginCfg of config.plugins) {
    const def = availablePlugins.get(pluginCfg.name);
    if (!def) {
      console.log(`  ✗ ${pluginCfg.name} — 未知插件`);
      continue;
    }
    if (!pluginCfg.enabled) {
      console.log(`  - ${pluginCfg.name} — 已禁用`);
      continue;
    }
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${pluginCfg.name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${pluginCfg.name} — 加载失败`);
    }
  }

  // 3-2：启动时先把恢复回来的历史压一遍（Layer 1 清旧工具结果，Layer 2 必要时摘要）
  if (messages.length > 0) {
    const before = messages.length;
    const compacted = await compact(model, messages, sessionSummary);
    sessionSummary = compacted.summary;
    messages.splice(0, messages.length, ...compacted.messages);
    if (compacted.cleared > 0 || compacted.compressedCount > 0) {
      console.log(
        `[压缩] ${before} 条 → ${messages.length} 条（清理旧工具结果 ${compacted.cleared} 个，摘要压缩 ${compacted.compressedCount} 条）`,
      );
    }
  }

  // Prompt Pipe 组装；每轮重建（记忆可能变化）
  const builder = buildPromptBuilder();
  let systemPrompt = builder.build(makePromptCtx());
  builder.debug(makePromptCtx());
  // 6-3：spawn_agent 注册（需要 builder 才能构造子 Agent 的 system prompt）
  registry.register(
    createSpawnTool(agentRegistry, () => ({
      model,
      registry,
      agentRegistry,
      buildSystem: () => builder.build(makePromptCtx()),
      currentDepth: 0,
    })),
  );

  const memoryCount = memoryStore.count();
  if (memoryCount > 0) console.log(`  已加载 ${memoryCount} 条历史记忆`);
  if (modelChain) {
    console.log(`  模型降级链（${modelChain.size} 个）: ${modelChain.names().join(' → ')}`);
  }
  {
    const hooks = hookPipeline.list();
    console.log(
      `  安全: 角色 ${registry.getRole()}（可用工具 ${registry.getActiveTools().length} 个），` +
        `Hook ${hooks.pre.length} pre + ${hooks.post.length} post`,
    );
  }
  if (loadedSkills.length > 0) console.log(`  已加载 ${loadedSkills.length} 个 Skill（/skill 查看）`);

  console.log('================================================================');
  console.log('  Super Agent v0.6 (ToolSearch 延迟加载版)                      ');
  console.log('  🛡️  短路保护: 指纹哈希滑动窗口 + 乒乓/重复循环检测            ');
  console.log('  ⚡  过载保护: 指数退避重试 (Exponential Backoff)             ');
  console.log(`  🔋  漏电保护: 全局 Token 预算守门员 (上限: ${sessionBudget.limit} Tokens) `);
  console.log('----------------------------------------------------------------');
  const activeNames = new Set(registry.getActiveTools().map((t) => t.name));
  console.log(`  已注册 ${registry.getAll().length} 个工具：`);
  for (const tool of registry.getAll()) {
    const flags = [
      tool.name.startsWith('mcp__') ? 'MCP' : '内置',
      activeNames.has(tool.name) ? '常驻' : '延迟',
      tool.isConcurrencySafe ? '可并发' : '串行',
      tool.isReadOnly ? '只读' : '读写',
    ].join(', ');
    console.log(`    - ${tool.name}（${flags}）`);
  }
  const estimate = registry.countTokenEstimate();
  console.log('----------------------------------------------------------------');
  console.log('=== 工具统计 ===');
  console.log(`  全部工具: ${registry.getAll().length} 个`);
  console.log(`  活跃工具: ${activeNames.size} 个（常驻 prompt）`);
  console.log(`  延迟工具: ${registry.getAll().length - activeNames.size} 个（按需 tool_search 发现）`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`);
  console.log('  输入 "exit" 或按 Ctrl+C 退出                                  ');
  console.log('================================================================');

  // 5-3：Channel——消息从哪来 / 回复往哪发，与 Agent 核心解耦。
  // 会话按 channelName:senderId 隔离；跑的是同一套 Agent Loop 与 Prompt Pipe。
  const runChannelTurn = async (sessionMessages: ModelMessage[], text: string): Promise<string> => {
    sessionMessages.push({ role: 'user', content: text });
    let out = '';
    const answer = await runAgentLoop({
      model,
      messages: sessionMessages,
      registry,
      system: builder.build(makePromptCtx()),
      budget: sessionBudget,
      enableRetry: true,
      onTextChunk: (chunk) => {
        out += chunk;
      },
      onToolCall: (name, args) => console.log(`  ⚙️  [调用工具: ${name}(${JSON.stringify(args)})]`),
      onToolResult: (name, result) => console.log(`  👁️  [工具返回: ${result}]`),
      onWarning: (warning) => console.log(`  📢 [防御播报: ${warning}]`),
      onUsage: recordUsage,
      modelChain,
    });
    return out || answer;
  };

  const gateway = new ChannelGateway({
    buildSystem: () => builder.build(makePromptCtx()),
    runTurn: runChannelTurn,
  });
  // 7-1：飞书 Channel 改为配置驱动——enabled:false 就完全不初始化（不占端口）
  if (config.channels.feishu.enabled) {
    gateway.register(
      new FeishuChannel({
        appId: config.channels.feishu.appId || process.env.FEISHU_APP_ID || '',
        appSecret: config.channels.feishu.appSecret || process.env.FEISHU_APP_SECRET || '',
        port: config.channels.feishu.port,
      }),
    );
  }

  // 4-1：命令 dispatcher（记忆命令走 dispatcher，sim/defend/context 等仍是内联实现）
  const dispatch = createDispatcher([
    ...memoryCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createChannelCommands(gateway),
    ...createSecurityCommands(registry, hookPipeline),
    ...createCronCommands(cronService),
    ...createAgentCommands(agentRegistry),
  ]);
  const commandCtx = {
    messages,
    timestamps,
    registry,
    tracker: usageTracker,
    memoryStore,
    model,
    rebuildSystem: () => builder.build(makePromptCtx()),
  };

  // 5-3：启动 Channel（没配飞书也会起 Dashboard，可用它测完整链路）
  await gateway.startAll();

  // 6-2：启动 Cron（执行器注入——CronService 不直接依赖 Agent Loop；配置可关）
  if (config.cron.enabled) cronService.load();
  cronService.setExecutor({
    runAgentPrompt: async (prompt: string) => {
      const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
      let out = '';
      const answer = await runAgentLoop({
        model,
        messages: cronMessages,
        registry,
        system: builder.build(makePromptCtx()),
        budget: sessionBudget,
        enableRetry: true,
        onTextChunk: (chunk) => {
          out += chunk;
        },
        onToolCall: (name, args) => console.log(`  ⚙️  [调用工具: ${name}(${JSON.stringify(args)})]`),
        onToolResult: (name, result) => console.log(`  👁️  [工具返回: ${result}]`),
        onWarning: (warning) => console.log(`  📢 [防御播报: ${warning}]`),
        onUsage: recordUsage,
        modelChain,
      });
      return out || answer || '(无输出)';
    },
    notify: (message) => console.log(`\n${message}`),
  });
  cronService.start();
  if (cronService.list().length > 0) {
    console.log(`  Cron: ${cronService.list().length} 个任务已加载（/cron 查看）`);
  }

  const rl = createInterface({ input, output });

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = await rl.question('\nYou: ');
      } catch {
        break;
      }

      const trimmed = userInput.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        console.log(`\n会话结束！本次会话累计消耗: ${sessionBudget.used} tokens`);
        const costTotals = usageTracker.totals();
        if (costTotals.steps > 0) {
          console.log(
            `[成本] ${costTotals.steps} 步 · $${costTotals.cost.toFixed(5)}` +
              `（无 cache 需 $${costTotals.baselineCost.toFixed(5)}，省 $${costTotals.savedCost.toFixed(5)}）`,
          );
        }
        console.log('再见！感谢体验 Super Agent v0.6');
        break;
      }

      // 4-1/4-3：先过 dispatcher（记忆 / lint / dream 命令）。
      // 返回字符串表示"把它当成一轮用户输入来跑"（/dream 走这条），其余命令直接 continue。
      const dispatched = await dispatch(trimmed, commandCtx);
      const effectiveInput = typeof dispatched === 'string' ? dispatched : trimmed;
      if (dispatched === true) continue;

      // 3-3：内置调试命令，方便直观体验防线效果
      if (trimmed === 'status') {
        console.log(
          `\n[状态] ${messages.length} 条消息，估算 ~${estimateMessageTokens(messages)} tokens（tracker: ~${tracker.estimatedTokens}）`,
        );
        continue;
      }
      if (trimmed === 'defend') {
        const d = applyDefense(messages, timestamps);
        messages.splice(0, messages.length, ...d.messages);
        console.log('\n--- 执行三层防线 ---');
        console.log(`  [Layer 2] 截断: ${d.truncated} 条, 预算清理: ${d.compacted} 条`);
        console.log(`  [Layer 3] 软修剪: ${d.softPruned}, 硬清除: ${d.hardPruned}`);
        console.log(`  [结果] ~${d.beforeTokens} → ~${d.afterTokens} tokens (节省 ${d.beforeTokens - d.afterTokens})`);
        continue;
      }
      if (trimmed === 'context' || trimmed === '/context') {
        const snapshot = {
          model: modelName,
          contextWindow: CONTEXT_WINDOW,
          systemTokens: estimateMessageTokens([{ role: 'user', content: systemPrompt } as ModelMessage]),
          toolsTokens: registry.countTokenEstimate().active,
          messageTokens: estimateMessageTokens(messages),
          bufferTokens: Math.round(CONTEXT_WINDOW * 0.05),
        };
        console.log('\n' + renderContextMatrix(snapshot));
        continue;
      }
      if (trimmed === 'usage' || trimmed === '/usage') {
        console.log('\n' + renderUsageSummary(usageTracker.totals()));
        if (modelChain && modelChain.degradationCount > 0) {
          console.log(
            `  模型降级: 本轮 ${modelChain.degradationCount} 次 (${modelChain.degradationPath})`,
          );
        }
        continue;
      }
      if (trimmed === '/cache off' || trimmed === 'cache off') {
        cacheEnabled = false;
        console.log('\n[cache] 已关闭 —— 后续请求按 cache miss 全价记账，可用 /usage 对比');
        continue;
      }
      if (trimmed === '/cache on' || trimmed === 'cache on') {
        cacheEnabled = true;
        console.log('\n[cache] 已开启');
        continue;
      }
      if (trimmed === 'sim' || trimmed === '/sim') {
        // 注入 20 条模拟历史（含大工具结果，时间跨度 12 分钟），用来体验防线
        const base = messages.length;
        for (let i = 0; i < 5; i++) {
          const age = i < 3 ? 12 * 60_000 : 6 * 60_000; // 前 3 轮 12 分钟前（会被硬清除），后 2 轮 6 分钟前（软修剪）
          pushMessage({ role: 'user', content: `模拟第 ${i + 1} 轮：看看这个文件` } as ModelMessage, age);
          pushMessage({ role: 'assistant', content: '好的，我读一下' } as ModelMessage, age);
          pushMessage(
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: `sim-${i}`,
                  toolName: 'read_file',
                  output: { type: 'text', value: 'X'.repeat(4000) },
                },
              ],
            } as ModelMessage,
            age,
          );
          pushMessage({ role: 'assistant', content: '读完了，这个文件主要讲的是……' } as ModelMessage, age);
        }
        console.log(`\n[sim] 注入 ${messages.length - base} 条模拟历史（含 5 条大工具结果，时间跨度 12 分钟）`);
        continue;
      }

      // 1. 将用户的输入压入上下文，并立刻落盘（进程退出也不丢）
      const turnStart = messages.length;
      pushMessage({ role: 'user', content: effectiveInput });
      store.append({ role: 'user', content: effectiveInput });

      // 4-1：每轮重建 system prompt——新存的记忆立即可用、删掉的立即消失
      systemPrompt = builder.build(makePromptCtx());

      // 3-3：每轮对话前跑三层即时防线（纯字符串操作，零 LLM 成本）
      const defense = applyDefense(messages, timestamps);
      messages.splice(0, messages.length, ...defense.messages);
      if (defense.truncated || defense.compacted || defense.softPruned || defense.hardPruned) {
        console.log(
          `  [防线] 截断 ${defense.truncated} / 预算清理 ${defense.compacted} / 软修剪 ${defense.softPruned} / 硬清除 ${defense.hardPruned}` +
            `（~${defense.beforeTokens} → ~${defense.afterTokens} tokens）`,
        );
      }

      // 8-1：一次用户任务一条 Trace（不放在启动时创建，否则一天的任务全混在一个文件里）
      let trace: LocalTraceRecorder | undefined;
      try {
        trace = await LocalTraceRecorder.start({ sessionId: config.session.id, model: modelName });
        const tokensBefore = sessionBudget.used;
        // 是否已经有文本流出来过。有则走打字机路径，没有则最后统一打印
        let streamedAny = false;

        // 2. 发起受三层保险丝保护的 Agent Loop
        const answer = await runAgentLoop({
          model,
          messages,
          registry, // 工具统一由注册中心提供
          system: systemPrompt, // 延迟工具清单只能通过 System prompt 告诉模型
          budget: sessionBudget, // 必须传入最外层持久持有的预算对象
          enableRetry: true,
          // 打字机效果：文本一生成就往外写，不等整段生成完
          onTextChunk: (chunk) => {
            if (!streamedAny) {
              process.stdout.write('\nAssistant: ');
              streamedAny = true;
            }
            process.stdout.write(chunk);
          },
          onToolCall: (name, args) => {
            console.log(`  ⚙️  [调用工具: ${name}(${JSON.stringify(args)})]`);
          },
          onToolResult: (name, result) => {
            console.log(`  👁️  [工具返回: ${result}]`);
          },
          onWarning: (warning) => {
            console.log(`  📢 [防御播报: ${warning}]`);
          },
          // 3-3/3-4：真实 usage 用来校准估算基准，并按价格表记账
          onUsage: recordUsage,
          // 8-1：把 Trace 交给 Loop 打点（每个 Step 的输入快照 + 输出 + 耗时 + usage）
          trace,
          modelChain,
        });

        // 熔断类出口没有流式文本，需要把返回的告警补打出来
        if (streamedAny) {
          console.log(); // 换行
        } else {
          console.log(`\nAssistant: ${answer}`);
        }

        // 本轮新增的 assistant / tool 消息全部落盘（3-1 Session 持久化），并记录时间戳供 TTL 使用
        store.appendAll(messages.slice(turnStart + 1));
        for (let i = turnStart + 1; i < messages.length; i++) timestamps.set(i, Date.now());

        // 3-2：每轮结束后检查上下文，超阈值就压（先 Microcompact，不够再摘要）
        if (estimateTokens(messages) > CONTEXT_TOKEN_THRESHOLD) {
          const before = messages.length;
          const compacted = await compact(model, messages, sessionSummary);
          sessionSummary = compacted.summary;
          messages.splice(0, messages.length, ...compacted.messages);
          console.log(
            `  [压缩] ${before} 条 → ${messages.length} 条（清理旧工具结果 ${compacted.cleared} 个，摘要压缩 ${compacted.compressedCount} 条）`,
          );
        }

        // 输出 Token 记账与预算健康度看板
        const costThisRound = Number(sessionBudget.used) - Number(tokensBefore);
        const remaining = Math.max(0, Number(sessionBudget.limit) - Number(sessionBudget.used));
        console.log(`\n[Token看板] 本轮消耗: ${costThisRound} | 累计已用: ${sessionBudget.used} | 剩余预算: ${remaining}`);

        // 8-1：任务结束写 trace_finished——没有它就无法判断 Trace 是完整结束还是中途退出
        await trace.finish('completed');
        console.log(`  [Trace] ${trace.filePath}`);
      } catch (err: any) {
        await trace?.finish('failed', err);
        console.error('\n[Fatal Error] 对话异常:', err.message || err);
      }
    }
  } finally {
    rl.close();
    cronService.stop(); // 6-2：停掉所有定时器
    await gateway.stopAll(); // 5-3：关掉 Channel 的 HTTP / WebSocket
    await pluginManager.unloadAll(); // 5-2：Graceful Shutdown，释放插件资源
    await registry.closeAllMCP(); // 关掉 MCP 子进程，不留孤儿
  }
}

/** 7-1：CLI 入口由 src/index.ts 路由到这里（init / start / continue） */
export async function startAgent(): Promise<void> {
  await main();
}
