/**
 * ============================================================================
 * 回归测试
 * ============================================================================
 *
 * 覆盖三层保险丝与工具系统的关键行为，防止退化：
 * 1. 工具由 AI SDK 执行，Loop 消费 response.messages，配对与 v7 schema 天然成立；
 * 2. mock 模型的故障注入必须携带结构化参数，工具能真正收到入参；
 * 3. 重试只针对可重试错误，schema 类确定性错误必须立即抛出；
 * 4. 工具结果超长时必须被 Head/Tail 60/40 截断，且保留头尾两端信息；
 * 5. 读写锁语义：只读工具共享锁并行，读写工具独占；
 * 6. 循环检测的预检挂在 execute 包装层，critical 时工具不执行；
 * 7. 降级链与 embedding 候选链的默认值只放有免费额度的模型，且请求参数合法
 *    （降级路径是花钱路径，静默降级到收费模型/静默降级到 mock 都必须在测试里钉住）。
 *
 * 运行：npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, type LanguageModel } from 'ai';

import { createMockModel } from '../src/mock-model.js';
import { allTools } from '../src/tools/built-in-tools.js';
import { pickSearchTool, webFetchTool } from '../src/tools/search-tools.js';
import { MockMCPClient } from '../src/tools/mcp-client.js';
import { ToolRegistry, truncateResult } from '../src/tools/registry.js';
import { runAgentLoop, type BudgetState } from '../src/agent/loop.js';
import { isRetryable, calculateDelay } from '../src/agent/retry.js';
import { detect, recordCall, recordResult, resetHistory } from '../src/agent/loop-detection.js';
import { SessionStore } from '../src/session/store.js';
import { microcompact, summarize } from '../src/context/compressor.js';
import { TokenTracker, truncateToolResults, ttlPrune } from '../src/context/defense.js';
import { UsageTracker, normalizeUsage } from '../src/usage/tracker.js';
import { MemoryStore } from '../src/memory/store.js';
import { lintAll, validateEntry, TTL_BY_TYPE } from '../src/memory/validator.js';
import { SkillLoader } from '../src/skills/loader.js';
import { PluginManager } from '../src/plugins/manager.js';
import { ChannelGateway } from '../src/channels/gateway.js';
import { canUseTool } from '../src/security/roles.js';
import { parseSchedule, getNextCronTime } from '../src/cron/parser.js';
import { SubAgentRegistry } from '../src/agents/registry.js';
import { LocalTraceRecorder, inspectTrace } from '../src/trace/recorder.js';
import { ModelChain, isModelUnavailableError } from '../src/model/chain.js';
import { loadConfig } from '../src/config/loader.js';
import { SuperAgentConfigSchema } from '../src/config/schema.js';
import { spawnAgent } from '../src/agents/spawn.js';
import { CronService } from '../src/cron/service.js';
import { classifyBashCommand } from '../src/security/bash-classifier.js';
import { HookPipeline } from '../src/security/hooks.js';
import type { ChannelDefinition } from '../src/channels/types.js';
import type { PluginDefinition } from '../src/plugins/types.js';
import { chunkDocument } from '../src/rag/chunker.js';
import { createMockEmbedder, createDashScopeEmbedder, embed } from '../src/rag/embedder.js';
import { VectorStore } from '../src/rag/store.js';
import { hybridSearch, mmrSelect } from '../src/rag/search.js';
import { renderContextMatrix, renderUsageSummary } from '../src/context/view.js';
import { PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext } from '../src/context/prompt-builder.js';

/** 构造一个已注册全部工具的注册中心 */
function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // 与 index.ts 的注册集合保持一致：内置工具 + 搜索工具（按环境变量二选一）+ web_fetch
  registry.register(...allTools, pickSearchTool(), webFetchTool);
  return registry;
}

/** 构造 v4 规范的最小 usage 结构，供自定义测试模型使用 */
function usageOf(total = 10): any {
  return {
    inputTokens: { total, noCache: total, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  };
}

/**
 * 把分块数组包装成 doStream 需要的 ReadableStream
 *
 * 测试模型不需要打字机延迟，一次性推完即可——只有 mock-model 才模拟真实推流节奏。
 */
function streamOf(chunks: any[]): { stream: ReadableStream } {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

/** 把一批工具调用渲染成 v4 规范的 tool-call 分块 */
function toolCallChunks(calls: Array<{ toolName: string; input: any }>, prefix: string): any[] {
  return calls.map((c, i) => ({
    type: 'tool-call' as const,
    toolCallId: `${prefix}-${i}`,
    toolName: c.toolName,
    input: JSON.stringify(c.input),
  }));
}

/** 把纯文本渲染成 v4 规范的流式分块序列 */
function textChunks(text: string): any[] {
  const id = 'text-1';
  return [
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta: text },
    { type: 'text-end' as const, id },
  ];
}

/** 构造结束分块，携带本次调用的用量 */
function finishChunk(hasToolCalls: boolean): any {
  return {
    type: 'finish' as const,
    finishReason: { unified: hasToolCalls ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
    usage: usageOf(),
  };
}

/**
 * 构造「首次返回指定工具调用、之后返回纯文本」的模型
 *
 * 与 createMockModel 的区别是工具组合可自定义，不受预置故障指令限制，
 * 用于精确控制一个批次里出现哪些工具，验证并行/串行分流决策。
 * doGenerate 与 doStream 共用同一套轮次逻辑：Agent Loop 走 streamText，
 * 但直接调 generateText 的断言也在用这个模型，两条路径必须行为一致。
 */
function createBatchModel(calls: Array<{ toolName: string; input: any }>): LanguageModel {
  let round = 0;
  const decideRound = () => {
    round++;
    return round === 1
      ? { calls, text: '' }
      : { calls: [] as Array<{ toolName: string; input: any }>, text: '批次执行完成' };
  };

  return {
    specificationVersion: 'v4' as const,
    provider: 'batch-test-provider',
    modelId: 'batch-test-model',
    get supportedUrls() {
      return Promise.resolve({});
    },
    async doGenerate() {
      const decision = decideRound();
      if (decision.calls.length > 0) {
        return {
          content: toolCallChunks(decision.calls, 'batch'),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usageOf(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: decision.text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: usageOf(),
        warnings: [],
      };
    },
    async doStream() {
      const decision = decideRound();
      const chunks =
        decision.calls.length > 0
          ? [...toolCallChunks(decision.calls, 'batch'), finishChunk(true)]
          : [...textChunks(decision.text), finishChunk(false)];
      return streamOf(chunks);
    },
  } as unknown as LanguageModel;
}

/**
 * 构造「每一轮都注入同一批工具调用」的模型
 *
 * 用于把循环检测一路逼到熔断阈值：轮次越多，相同指纹的累计次数越高。
 */
function createRepeatingModel(calls: Array<{ toolName: string; input: any }>): LanguageModel {
  return {
    specificationVersion: 'v4' as const,
    provider: 'batch-test-provider',
    modelId: 'repeat-model',
    get supportedUrls() {
      return Promise.resolve({});
    },
    async doGenerate() {
      return {
        content: toolCallChunks(calls, `rep-${Date.now()}`),
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: usageOf(),
        warnings: [],
      };
    },
    async doStream() {
      return streamOf([...toolCallChunks(calls, `rep-${Date.now()}`), finishChunk(true)]);
    },
  } as unknown as LanguageModel;
}

/** 单次工具执行的时间区间，用于判定是否发生并发重叠 */
interface Span {
  name: string;
  start: number;
  end: number;
}

/**
 * 构造带探针工具的注册中心：每个工具记录自己的执行起止时间
 *
 * 并行的判据是区间重叠，而不是总耗时——总耗时会被机器负载干扰，
 * 区间重叠才是「确实同时在跑」的直接证据。
 */
function createProbeRegistry(): { registry: ToolRegistry; spans: Span[] } {
  const spans: Span[] = [];
  const probe = (name: string, isSafe: boolean) => ({
    name,
    description: `${name} 探针工具`,
    parameters: { type: 'object', properties: {} },
    isConcurrencySafe: isSafe,
    isReadOnly: isSafe,
    execute: async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 60));
      spans.push({ name, start, end: Date.now() });
      return `${name} 完成`;
    },
  });

  const registry = new ToolRegistry();
  registry.register(
    probe('probe_a', true),
    probe('probe_b', true),
    probe('probe_c', true),
    probe('probe_write', false)
  );
  return { registry, spans };
}

/** 判定一组执行区间里是否存在任意两段重叠 */
function hasOverlap(spans: Span[]): boolean {
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i].start < spans[j].end && spans[j].start < spans[i].end) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 一、重试策略：错误分类
// ---------------------------------------------------------------------------

test('isRetryable：限流与网关故障应判为可重试', () => {
  assert.equal(isRetryable(new Error('429 Too Many Requests')), true);
  assert.equal(isRetryable(new Error('529 Overloaded')), true);
  assert.equal(isRetryable(new Error('503 Service Unavailable')), true);
  assert.equal(isRetryable(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryable(new Error('408 Request Timeout')), true);
});

test('isRetryable：网络层瞬断应判为可重试', () => {
  assert.equal(isRetryable(new Error('fetch failed')), true);
  assert.equal(isRetryable(new Error('read ECONNRESET')), true);
  assert.equal(isRetryable(new Error('socket ETIMEDOUT')), true);
  assert.equal(isRetryable(new Error('No output generated')), true);
});

test('isRetryable：schema 校验与客户端错误必须判为不可重试', () => {
  // 消息结构不合法属于确定性错误，重试毫无意义
  assert.equal(
    isRetryable(new Error('Invalid prompt: The messages do not match the ModelMessage[] schema.')),
    false
  );
  assert.equal(isRetryable(new Error('401 Unauthorized')), false);
  assert.equal(isRetryable(new Error('400 Bad Request')), false);
  assert.equal(isRetryable(new Error('404 Not Found')), false);
});

test('isRetryable：非 Error 输入与未知错误一律判为不可重试', () => {
  assert.equal(isRetryable('字符串错误'), false);
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable(undefined), false);
  assert.equal(isRetryable(new Error('某个无法归类的奇怪故障')), false);
});

// ---------------------------------------------------------------------------
// 二、退避算法
// ---------------------------------------------------------------------------

test('calculateDelay：指数增长且带 ±25% 抖动', () => {
  // 第 1 次：基准 500ms，抖动区间 375~625
  for (let i = 0; i < 50; i++) {
    const d1 = calculateDelay(1, 500, 30000);
    assert.ok(d1 >= 375 && d1 <= 625, `第 1 次退避 ${d1} 超出抖动区间`);
  }
  // 第 3 次：基准 2000ms，抖动区间 1500~2500
  for (let i = 0; i < 50; i++) {
    const d3 = calculateDelay(3, 500, 30000);
    assert.ok(d3 >= 1500 && d3 <= 2500, `第 3 次退避 ${d3} 超出抖动区间`);
  }
});

test('calculateDelay：受 maxMs 上限约束，不会无限膨胀', () => {
  const d = calculateDelay(20, 500, 30000);
  assert.ok(d <= 30000 * 1.25, `退避时长 ${d} 突破了上限约束`);
  assert.ok(d >= 0, '退避时长不应为负数');
});

// ---------------------------------------------------------------------------
// 二·五、循环检测：三档阈值与三种检测器
// ---------------------------------------------------------------------------

test('detect：通用重复累计到 5 次警告、8 次熔断', () => {
  resetHistory();
  const params = { city: '北京' };

  // 滑动窗口里 0~4 条时都不该判定卡住（先软后硬，给模型自救机会）
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(detect('get_weather', params), { stuck: false }, `窗口 ${i} 条时不应判定卡住`);
    recordCall('get_weather', params);
  }

  const warn = detect('get_weather', params);
  assert.equal(warn.stuck, true);
  assert.equal(warn.level, 'warning');
  assert.equal(warn.detector, 'generic_repeat');
  assert.equal(warn.count, 5, '窗口 5 条时应报计数 5');

  // 窗口 5 → 6 → 7 → 8，累计到 8 条才升级为熔断
  recordCall('get_weather', params);
  recordCall('get_weather', params);
  recordCall('get_weather', params);
  const critical = detect('get_weather', params);
  assert.equal(critical.stuck, true);
  assert.equal(critical.level, 'critical');
  assert.equal(critical.detector, 'generic_repeat');
  assert.equal(critical.count, 8, '窗口 8 条时应升级为熔断');
});

test('detect：入参与返回都毫无变化达到 10 次时触发全局熔断', () => {
  resetHistory();
  const params = {};

  // 每次都回填完全一样的结果，模拟外界环境毫无反应
  for (let i = 0; i < 10; i++) {
    recordCall('probe', params);
    recordResult('probe', params, '永远一样的结果');
  }

  const verdict = detect('probe', params);
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.level, 'critical');
  assert.equal(verdict.detector, 'global_circuit_breaker');
  assert.ok(verdict.count >= 10, `无进展计数应达到熔断阈值，实际 ${verdict.count}`);
});

test('detect：A-B-A-B 乒乓交替达到阈值时判定 ping_pong', () => {
  resetHistory();
  const a = { n: 1 };
  const b = { n: 2 };

  for (let i = 0; i < 5; i++) {
    recordCall('tool_a', a);
    recordCall('tool_b', b);
  }

  // 窗口末尾是 B，此时再调用 A 正好补上交替环
  const verdict = detect('tool_a', a);
  assert.equal(verdict.stuck, true);
  assert.equal(verdict.detector, 'ping_pong');
});

test('resetHistory：清空滑动窗口后不再判定卡住', () => {
  resetHistory();
  const params = { city: '北京' };

  for (let i = 0; i < 10; i++) {
    recordCall('get_weather', params);
    recordResult('get_weather', params, '晴');
  }
  assert.equal(detect('get_weather', params).stuck, true, '清空前应当判定卡住');

  resetHistory();
  assert.deepEqual(detect('get_weather', params), { stuck: false }, '清空后不应再判定卡住');
});

// ---------------------------------------------------------------------------
// 三、Mock 模型：故障注入与用量记账
// ---------------------------------------------------------------------------

test('mock 模型：故障注入携带结构化参数，工具能收到真实入参', async () => {
  const result = await generateText({
    model: createMockModel(),
    messages: [{ role: 'user', content: '测试死循环' }],
    // 工具以 AI SDK 格式传入，由 Registry 统一转换
    tools: createRegistry().toAISDKFormat(),
  });

  assert.equal(result.toolCalls.length, 1, '应当注入一次工具调用');
  const call = result.toolCalls[0];
  assert.equal(call.toolName, 'calculator');
  assert.equal(call.invalid, undefined, '工具调用不应被判为非法（说明参数已能被正确解析）');
  assert.deepEqual(call.input, { expression: '1 + 1' }, '参数必须解析为对象而非 JSON 字符串');
});

test('mock 模型：usage 记账生效，totalTokens 可读', async () => {
  const result = await generateText({
    model: createMockModel(),
    messages: [{ role: 'user', content: '你好' }],
  });

  // 这条断言守护的是 mock 声明 v4 规范却返回 v2 结构的历史问题：
  // 版本不匹配时 SDK 会进兼容模式，totalTokens 会变成 undefined，预算记账整体失效。
  assert.equal(result.usage.totalTokens, 30, '普通对话应记账 30 tokens');
});

test('mock 模型：预算注入返回超大用量', async () => {
  const result = await generateText({
    model: createMockModel(),
    messages: [{ role: 'user', content: '测试预算' }],
  });
  assert.equal(result.usage.totalTokens, 30000, '预算注入应一次性消耗 30000 tokens');
});

test('mock 模型：跨轮会话下「测试截断」仍能注入工具调用', async () => {
  // 回归防护：会话历史是跨轮累加的，若「本轮是否已回填工具结果」扫的是全量历史，
  // 上一轮留下的 tool 消息会让本轮误判成已回填，指令从此再也注入不出工具调用。
  const messages: any[] = [];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const registry = createRegistry();

  messages.push({ role: 'user', content: '测试并发' });
  await runAgentLoop({ model: createMockModel(), messages, registry, budget, maxSteps: 4 });

  messages.push({ role: 'user', content: '测试截断' });
  await runAgentLoop({ model: createMockModel(), messages, registry, budget, maxSteps: 4 });

  const toolResults = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-result'))
    .map((c: any) => String(c.output?.value ?? ''));

  assert.ok(
    toolResults.some((t) => t.includes('省略')),
    `跨轮后「测试截断」仍应触发截断，实际工具结果：${JSON.stringify(toolResults).slice(0, 300)}`
  );
});

test('mock 模型：测试重试首次抛 429，退避后正常返回', async () => {
  const messages: any[] = [{ role: 'user', content: '测试重试' }];
  const budget: BudgetState = { used: 0, limit: 25000 };

  // 退避重试的播报走 console.warn（不是 onWarning），这里拦一层确认它真的被触发过
  const originalWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...args: any[]) => {
    warns.push(args.join(' '));
  };

  let answer = '';
  try {
    answer = await runAgentLoop({
      model: createMockModel(),
      messages,
      registry: createRegistry(),
      budget,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warns.some((w) => w.includes('指数退避重试')),
    `应当触发指数退避重试，实际播报：${JSON.stringify(warns)}`
  );
  assert.ok(answer.includes('重试成功'), `重试后应当正常返回文本，实际：${answer}`);
});

// ---------------------------------------------------------------------------
// 四、工具系统：截断与并发锁
// ---------------------------------------------------------------------------

test('truncateResult：未超限的文本原样返回', () => {
  const short = '短文本内容';
  assert.equal(truncateResult(short, 500), short, '未超限时不应改动原文');
});

test('truncateResult：超限文本按 Head/Tail 60/40 分割并保留两端信息', () => {
  // 构造 1000 字符：头部标记 HEAD、尾部标记 TAIL、中间填充 X
  const head = 'HEAD-开头关键信息';
  const tail = 'TAIL-结尾关键信息';
  const text = head + 'X'.repeat(1000 - head.length - tail.length) + tail;

  const result = truncateResult(text, 500);

  assert.ok(result.length < text.length, '超限文本应当被缩短');
  assert.ok(result.startsWith(head), '必须保留头部关键信息（60% 区段）');
  assert.ok(result.endsWith(tail), '必须保留尾部关键信息（40% 区段）');
  assert.ok(result.includes('省略'), '必须标注被省略的字符数');
});

test('truncateResult：maxChars 为零或极小值时不抛异常', () => {
  const text = 'X'.repeat(100);
  assert.doesNotThrow(() => truncateResult(text, 0));
  assert.doesNotThrow(() => truncateResult(text, 10));
});

test('ToolRegistry：注册与查找行为正确', () => {
  const registry = createRegistry();

  assert.equal(registry.getAll().length, 12, '应当注册 12 个工具');
  assert.ok(registry.get('read_file'), 'read_file 应当可被查找到');
  assert.equal(registry.get('不存在的工具'), undefined, '未注册的工具应返回 undefined');

  // 工具元数据必须完整，供 Agent Loop 做并发决策
  const writeTool = registry.get('write_file')!;
  assert.equal(writeTool.isConcurrencySafe, false, 'write_file 有副作用，必须标记为不可并发');
  assert.equal(writeTool.isReadOnly, false, 'write_file 必须标记为读写');

  const readTool = registry.get('read_file')!;
  assert.equal(readTool.isConcurrencySafe, true, 'read_file 只读，应可并发');
  assert.equal(readTool.maxResultChars, 500, 'read_file 的结果上限应为 500（演示截断）');
});

test('ToolRegistry：执行超长结果时自动截断', async () => {
  const registry = createRegistry();
  const result = await registry.executeTool('read_file', { filePath: 'sample-data.txt' });

  // sample-data.txt 远超 500 字符，应当被截断
  assert.ok(result.includes('省略'), `读取大文件应触发截断，实际长度 ${result.length}`);
  assert.ok(result.length < 1000, '截断后长度应明显小于原文');
});

test('ToolRegistry：只读工具并发执行时共享锁计数正确', async () => {
  const registry = createRegistry();

  // 同时发起三个只读调用，它们应当都能拿到共享锁并正常返回
  const results = await Promise.all([
    registry.executeTool('get_weather', { city: '北京' }),
    registry.executeTool('get_weather', { city: '上海' }),
    registry.executeTool('list_directory', { dirPath: '.' }),
  ]);

  assert.ok(results[0].includes('北京') || results[0].includes('晴'), '北京天气应正常返回');
  assert.ok(results[1].includes('上海') || results[1].includes('多云'), '上海天气应正常返回');
  assert.ok(results[2].includes('[FILE]') || results[2].includes('[DIR]'), '目录列表应正常返回');
});

test('ToolRegistry：读写工具与只读工具混跑时锁能正确释放', async () => {
  const registry = createRegistry();

  // 写操作独占执行，之后读操作仍能正常拿到锁（验证 finally 释放逻辑）
  const writeResult = await registry.executeTool('write_file', {
    filePath: '.tmp-lock-test.txt',
    content: '锁释放测试',
  });
  assert.ok(writeResult.includes('已写入'), '写操作应成功');

  const readResult = await registry.executeTool('read_file', { filePath: '.tmp-lock-test.txt' });
  assert.equal(readResult.trim(), '锁释放测试', '写完之后读操作应能拿到锁并读到内容');

  // 清理临时文件，保持工作区干净
  const { unlink } = await import('node:fs/promises');
  await unlink('.tmp-lock-test.txt').catch(() => {});
});

test('ToolRegistry：执行不存在的工具返回错误提示而非抛异常', async () => {
  const registry = createRegistry();
  const result = await registry.executeTool('不存在的工具', {});
  assert.ok(result.includes('找不到工具'), '应当返回可读的错误提示');
});

test('ToolRegistry：toAISDKFormat 产出的工具带 inputSchema 与 execute', () => {
  const registry = new ToolRegistry();
  registry.register(allTools[0]);
  const sdkTools = registry.toAISDKFormat();

  assert.ok(sdkTools.get_weather, '应当包含 get_weather');
  assert.ok(sdkTools.get_weather.inputSchema, '必须带 inputSchema');
  assert.equal(typeof sdkTools.get_weather.execute, 'function', '必须带 execute 函数');
  assert.equal(Object.keys(sdkTools).length, 1, '只注册一个工具时不应多出其他工具');
});

test('edit_file：唯一匹配才替换，0 处与多处匹配返回可读错误', async () => {
  const registry = createRegistry();
  const { writeFile, unlink } = await import('node:fs/promises');
  const tmp = '.tmp-edit-test.txt';

  await writeFile(tmp, '第一行\n第二行\n', 'utf-8');
  const ok = await registry.executeTool('edit_file', { path: tmp, old_string: '第二行', new_string: '第二行（已改）' });
  assert.ok(ok.includes('已替换'), '唯一匹配应替换成功');

  const notFound = await registry.executeTool('edit_file', { path: tmp, old_string: '不存在的文本', new_string: 'x' });
  assert.ok(notFound.includes('未找到匹配'), '匹配 0 处应返回给模型看的错误信息');

  await writeFile(tmp, '重复\n重复\n', 'utf-8');
  const multi = await registry.executeTool('edit_file', { path: tmp, old_string: '重复', new_string: 'x' });
  assert.ok(multi.includes('处匹配'), '多处匹配应要求模型提供更多上下文');

  await unlink(tmp).catch(() => {});
});

test('glob：递归找文件；grep 按 文件名:行号: 内容 返回', async () => {
  const registry = createRegistry();

  const globResult = await registry.executeTool('glob', { pattern: '**/*.ts' });
  assert.ok(globResult.includes('src/index.ts'), `glob 应能搜到 src 下的源码，实际: ${globResult.slice(0, 120)}`);
  assert.ok(globResult.includes('src/tools/registry.ts'), 'glob 应能递归到子目录');

  const grepResult = await registry.executeTool('grep', { pattern: 'ToolRegistry', path: 'src' });
  assert.ok(/\S+\.ts:\d+:/.test(grepResult), `grep 输出应为 文件名:行号: 内容 格式，实际: ${grepResult.slice(0, 120)}`);
  assert.ok(grepResult.includes('ToolRegistry'), 'grep 应能搜到匹配内容');
});

test('2-4：web_fetch 命中 MOCK_PAGES 时返回预置内容并声明只读可并发', async () => {
  const registry = createRegistry();
  const tool = registry.get('web_fetch')!;
  assert.equal(tool.isConcurrencySafe, true, '抓网页只读，应可并发');
  assert.equal(tool.maxResultChars, 3000, '网页结果上限应为 3000（上下文第一道防线）');

  const result = await registry.executeTool('web_fetch', { url: 'https://esm.sh' });
  assert.ok(result.includes('ES module CDN'), `应返回预置页面内容，实际: ${result.slice(0, 80)}`);
});

test('2-4：web_search 未配置 Key 时返回可读提示而非抛异常', async () => {
  const savedTavily = process.env.TAVILY_API_KEY;
  const savedSerper = process.env.SERPER_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPER_API_KEY;
  try {
    const registry = createRegistry();
    const result = await registry.executeTool('web_search', { query: 'test' });
    assert.ok(result.includes('未配置'), `应提示配置 Key，实际: ${result}`);
  } finally {
    if (savedTavily) process.env.TAVILY_API_KEY = savedTavily;
    if (savedSerper) process.env.SERPER_API_KEY = savedSerper;
  }
});

test('2-5：registerMCPServer 用命名空间前缀注册 Mock 工具，可调用且不覆盖内置工具', async () => {
  const registry = createRegistry();
  const before = registry.getAll().length;

  const names = await registry.registerMCPServer('github', new MockMCPClient());
  assert.equal(names.length, 3, 'Mock MCP 应暴露 3 个工具');
  assert.ok(
    names.every((n) => n.startsWith('mcp__github__')),
    '工具名必须带 mcp__<server>__ 命名空间前缀',
  );
  assert.equal(registry.getAll().length, before + 3, '注册后工具数应增加 3');

  const tool = registry.get('mcp__github__list_issues')!;
  assert.ok(tool.description.startsWith('[MCP:github]'), 'description 应带来源前缀，便于调试分辨');

  const result = await registry.executeTool('mcp__github__list_issues', { owner: 'vercel', repo: 'ai' });
  assert.ok(result.includes('支持 MCP 协议接入'), `Mock 应返回预置 issue 数据，实际: ${result.slice(0, 80)}`);

  // 同名工具重复注册应被跳过，不会覆盖已有定义
  const again = await registry.registerMCPServer('github', new MockMCPClient());
  assert.equal(again.length, 0, '同名工具重复注册应全部跳过');

  await registry.closeAllMCP();
});

test('2-6：延迟工具不进活跃集，tool_search 发现后才生效', () => {
  const registry = createRegistry();
  const before = registry.getActiveTools().length;

  registry.register({
    name: 'mcp__notion__search_pages',
    description: '[MCP:notion] 搜索 Notion 页面',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    shouldDefer: true,
    searchHint: 'notion search pages documents',
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async () => '[]',
  });

  assert.equal(registry.getAll().length, before + 1, '注册表里应能看到它');
  assert.equal(registry.getActiveTools().length, before, '延迟工具不进活跃集');
  assert.ok(
    registry.getDeferredToolSummary().includes('mcp__notion__search_pages'),
    '延迟清单应列出它的名字',
  );
  assert.equal(
    registry.toAISDKFormat().mcp__notion__search_pages,
    undefined,
    '被发现之前不应进入 tools 参数（不占 prompt）',
  );

  const found = registry.searchTools('mcp__notion__search_pages');
  assert.equal(found.length, 1, '精确工具名匹配应命中');
  assert.equal(registry.getActiveTools().length, before + 1, '发现后应变为活跃');
  assert.ok(registry.toAISDKFormat().mcp__notion__search_pages, '发现后应进入 tools 参数');

  const est = registry.countTokenEstimate();
  assert.equal(est.total, est.active + est.deferred, 'token 估算结构应自洽');
});

test('2-6：MCP 工具默认延迟，tool_search 自身不可被搜出', async () => {
  const registry = createRegistry();
  await registry.registerMCPServer('github', new MockMCPClient());

  const gh = registry.get('mcp__github__list_issues')!;
  assert.equal(gh.shouldDefer, true, 'MCP 工具默认应标记延迟');
  assert.ok(gh.searchHint?.includes('github'), 'searchHint 应带来源线索，便于 ToolSearch 匹配');
  assert.equal(
    registry.getActiveTools().some((t) => t.name.startsWith('mcp__github__')),
    false,
    'MCP 工具默认不进活跃集',
  );
  assert.equal(registry.searchTools('tool_search').length, 0, 'tool_search 自身不应被搜出');

  await registry.closeAllMCP();
});

test('3-1：SessionStore 追加后可完整读回，坏行被跳过', async () => {
  const { unlink } = await import('node:fs/promises');
  const { appendFileSync } = await import('node:fs');
  const store = new SessionStore('test-session');
  const file = store.path;
  await unlink(file).catch(() => {}); // 上次跑测试留下的文件先清掉，保证断言可重复

  store.append({ role: 'user', content: '你好' });
  store.append({ role: 'assistant', content: '你好！有什么可以帮你的？' });
  // 人为塞一行坏数据：JSONL 的容错性——坏行不该影响其他行
  appendFileSync(file, '这不是 JSON\n', 'utf-8');

  const loaded = store.load();
  assert.equal(loaded.length, 2, '应读回 2 条消息，坏行被跳过');
  assert.equal(loaded[0].role, 'user');
  assert.equal(loaded[1].role, 'assistant');

  await unlink(file).catch(() => {});
});

test('3-1：PromptBuilder 按条件开关模块，顺序即静态到动态', () => {
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  // 新会话：没有历史，sessionContext 应关闭
  const fresh = builder.build({
    toolCount: 12,
    deferredToolSummary: '以下工具可用：\n  - mcp__github__list_issues',
    sessionMessageCount: 0,
    sessionId: 'default',
  });
  assert.ok(fresh.includes('Super Agent'), '核心规则应始终存在');
  assert.ok(fresh.includes('12 个工具'), 'toolGuide 应带上工具数量');
  assert.ok(fresh.includes('mcp__github__list_issues'), '延迟工具清单应注入');
  assert.equal(fresh.includes('[会话信息]'), false, '新会话不应出现会话上下文');

  // 恢复历史后：sessionContext 自动打开
  const restored = builder.build({
    toolCount: 12,
    deferredToolSummary: '',
    sessionMessageCount: 4,
    sessionId: 'default',
  });
  assert.ok(restored.includes('[会话信息]'), '有历史时应出现会话上下文');
  assert.ok(restored.indexOf('Super Agent') < restored.indexOf('[会话信息]'), '静态内容在前、动态在后');
});

test('3-2：microcompact 只清旧的查询类工具结果，最近 3 个原样保留', () => {
  const mkTool = (name: string, text: string): any => ({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: `c-${name}`, toolName: name, output: { type: 'text', value: text } },
    ],
  });
  const messages: any[] = [
    { role: 'user', content: '开始' },
    mkTool('read_file', 'A'.repeat(400)),
    mkTool('grep', 'B'.repeat(400)),
    mkTool('bash', 'C'.repeat(400)),
    mkTool('list_directory', 'D'.repeat(400)),
    mkTool('glob', 'E'.repeat(400)),
    { role: 'assistant', content: '完成' },
  ];

  const { messages: out, cleared } = microcompact(messages);
  assert.equal(cleared, 2, '5 个工具结果里应只清最早的 2 个');

  const texts = out.filter((m: any) => m.role === 'tool').map((m: any) => m.content[0].output.value);
  assert.equal(texts[0], '[tool result cleared]', '旧的应被替换成占位符');
  assert.equal(texts[4], 'E'.repeat(400), '最近的结果必须原样保留（模型下一步可能还要用）');
  assert.equal(out.length, messages.length, '不删消息、不改结构');
});

test('3-2：summarize 超阈值时压缩早期对话，摘要作为首条 user 消息注入', async () => {
  const big = 'X'.repeat(300000); // 触发阈值（默认 60000 tokens ≈ 240000 字符）
  const messages: any[] = [
    { role: 'user', content: '帮我看看项目结构' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: big },
    { role: 'assistant', content: '读完了' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `第 ${i} 轮` })),
  ];

  const result = await summarize(createMockModel(), messages, '');
  assert.ok(result.compressedCount > 0, '超阈值应触发摘要压缩');
  assert.ok(result.summary.length > 0, '应产出摘要文本');
  assert.ok(
    String(result.messages[0].content).includes('[以下是之前对话的压缩摘要]'),
    '摘要应作为第一条 user 消息注入',
  );
  assert.equal(result.messages[1].role, 'user', '保留部分必须对齐到 user 消息边界');
  assert.ok(result.messages.length < messages.length, '压缩后消息条数应减少');
});

test('3-3：TokenTracker 精确值校准后只累加增量', () => {
  const tracker = new TokenTracker();
  tracker.addMessage({ role: 'user', content: 'a'.repeat(400) } as any);
  assert.equal(tracker.estimatedTokens, Math.ceil((400 / 4) * 1.2), '只有粗估时按 chars/4 * 1.2');

  tracker.updateFromAPI(1000);
  assert.equal(tracker.estimatedTokens, 1000, '精确值到达后增量清零');

  tracker.addMessage({ role: 'user', content: 'b'.repeat(400) } as any);
  assert.equal(tracker.estimatedTokens, 1000 + Math.ceil((400 / 4) * 1.2), '新消息继续累加增量');
});

test('3-3：truncateToolResults 超限结果做 Head/Tail 分割并留截断标记', () => {
  const big = 'H'.repeat(1000) + 'M'.repeat(400000) + 'T'.repeat(1000);
  const messages: any[] = [
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: big } },
      ],
    },
  ];

  const { messages: out, truncated } = truncateToolResults(messages, {
    maxSingleResult: 2000,
    contextBudgetChars: 1_000_000,
  });

  assert.equal(truncated, 1, '超限结果应被截断');
  const text = out[0].content[0].output.value;
  assert.ok(text.includes('[truncated:'), '必须留下截断标记，让模型知道内容不完整');
  assert.ok(text.startsWith('H'.repeat(100)), '保留头部');
  assert.ok(text.endsWith('T'.repeat(100)), '保留尾部（日志最新条目 / 函数实现在尾部）');
});

test('3-3：ttlPrune 软修剪保留头尾、硬清除只留事实、错误经验永不修剪', () => {
  const mkTool = (name: string, text: string): any => ({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: `c-${name}`, toolName: name, output: { type: 'text', value: text } },
    ],
  });
  const messages: any[] = [
    { role: 'user', content: '开始' },
    mkTool('read_file', 'A'.repeat(5000)),
    mkTool('bash', 'B'.repeat(5000)),
    mkTool('grep', 'error: 文件不存在'),
    mkTool('glob', 'C'.repeat(100)),
  ];

  const now = Date.now();
  const ts = new Map<number, number>([
    [1, now - 12 * 60_000],
    [2, now - 6 * 60_000],
    [3, now - 12 * 60_000],
    [4, now - 60_000],
  ]);

  const { messages: out, softPruned, hardPruned } = ttlPrune(messages, ts);
  assert.equal(hardPruned, 1, '12 分钟前的普通结果应硬清除');
  assert.equal(softPruned, 1, '6 分钟前的结果应软修剪');
  assert.equal(out[1].content[0].output.value, '[tool result expired]');
  assert.ok(out[2].content[0].output.value.includes('[soft pruned:'), '软修剪应保留头尾并留标记');
  assert.equal(out[3].content[0].output.value, 'error: 文件不存在', '错误经验永不修剪（模型要记住这条路走不通）');
  assert.equal(out[4].content[0].output.value, 'C'.repeat(100), '1 分钟前的结果不动');
  assert.equal(out[0].role, 'user', 'user 消息永不修剪');
});

test('3-4：normalizeUsage 抹平 provider 差异（OpenAI 要把 cache read 减出来）', () => {
  const raw = { inputTokens: { total: 1000 }, outputTokens: { total: 50 }, cachedInputTokens: 800 };

  const openai = normalizeUsage(raw, { provider: 'openai.chat' });
  assert.equal(openai.inputTokens, 200, 'OpenAI 的 cached 已包含在 input 总数里，必须减出来');
  assert.equal(openai.cacheReadTokens, 800);

  const anthropic = normalizeUsage(raw, { provider: 'anthropic' });
  assert.equal(anthropic.inputTokens, 1000, 'Anthropic 的普通输入与 cache read 分开统计，不能减');

  const empty = normalizeUsage(undefined);
  assert.equal(empty.inputTokens, 0, '空 usage 不应抛异常');
});

test('3-4：UsageTracker 逐步记账并算出 cache 省下的金额', () => {
  const tracker = new UsageTracker();
  tracker.record('claude-sonnet-4-7', {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 1000,
    cacheReadTokens: 0,
  });
  tracker.record('claude-sonnet-4-7', {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 1000,
  });

  const t = tracker.totals();
  assert.equal(t.steps, 2);
  assert.ok(t.cost > 0, '应算出实际花费');
  assert.ok(t.baselineCost > t.cost, '有 cache 时应比全价便宜');
  assert.ok(t.savedCost > 0, '应算出省下的金额');
  assert.ok(t.cacheHitRate > 0 && t.cacheHitRate <= 1, '命中率应在 0-1 之间');
});

test('3-4：/context 矩阵按占用来源填充，/usage 汇总含节省金额', () => {
  const matrix = renderContextMatrix({
    model: 'mock-model',
    contextWindow: 1000,
    systemTokens: 100,
    toolsTokens: 50,
    messageTokens: 200,
    bufferTokens: 50,
  });
  assert.ok(matrix.includes('◆'), '应有 system prompt 方块');
  assert.ok(matrix.includes('●'), '应有消息历史方块');
  assert.ok(matrix.includes('▢'), '应有 autocompact buffer 方块');
  assert.ok(matrix.includes('○'), '应有 free space 方块');
  assert.ok(matrix.includes('mock-model'), '应显示模型名');

  const summary = renderUsageSummary(new UsageTracker().totals());
  assert.ok(summary.includes('Usage Summary'), '应输出标题');
  assert.ok(summary.includes('Saved'), '应包含节省金额一行');
});

test('4-1：MemoryStore 保存/列出/搜索/删除，索引与文件同步', async () => {
  const { rm } = await import('node:fs/promises');
  const store = new MemoryStore('.tmp-memory-test');
  await rm('.tmp-memory-test', { recursive: true, force: true });

  const filename = store.save({
    name: '我喜欢 TypeScript',
    description: '用户偏好 TypeScript',
    type: 'user',
    content: '示例代码优先用 TypeScript。',
  });
  assert.ok(filename.startsWith('user_'), '文件名应带类型前缀，方便人眼扫描');
  assert.equal(store.count(), 1);

  const entries = store.list();
  assert.equal(entries[0].description, '用户偏好 TypeScript', 'frontmatter 应被解析出来');
  assert.equal(entries[0].type, 'user');

  assert.equal(store.search('typescript').length, 1, '关键词搜索应命中');
  assert.equal(store.search('python').length, 0, '无关关键词不应命中');

  const section = store.buildPromptSection();
  assert.ok(section.includes('记忆索引'), '注入段落应包含索引');
  assert.ok(section.includes('记忆是线索，不是事实'), '必须带上"用前先验证"的提醒');

  assert.equal(store.delete(filename), true, '删除应成功');
  assert.equal(store.count(), 0, '删除后列表应为空');

  await rm('.tmp-memory-test', { recursive: true, force: true });
});

test('4-2：chunkDocument 递归段落分块，长段按句子切且带元数据', () => {
  const longParagraph = Array.from({ length: 30 }, (_, i) => `第${i}句：${'B'.repeat(80)}。`).join('');
  const text = ['# 标题', 'A'.repeat(100), longParagraph].join('\n\n');
  const chunks = chunkDocument('doc.md', text);

  assert.ok(chunks.length >= 3, '长文应被切成多块');
  assert.ok(chunks.every((c) => c.source === 'doc.md'), '每块都要带来源');
  assert.ok(chunks.every((c) => c.index === chunks.indexOf(c)), 'index 应按顺序编号');
  assert.ok(chunks.every((c) => c.tokenEstimate > 0), '每块都要带 token 估算');
  assert.ok(
    chunks.every((c) => c.text.length <= 256 * 4 + 120),
    `单块不应远超目标大小，实际最大 ${Math.max(...chunks.map((c) => c.text.length))}`,
  );
});

test('4-2：混合检索能召回关键词命中的片段，并记录两条路径的分数', async () => {
  const store = new VectorStore();
  const embedFn = createMockEmbedder();
  const docs = [
    { id: 'a#0', text: '部署事故：pm2 stop 与 pm2 start 之间有几秒空窗，导致 502', source: 'a.md' },
    { id: 'b#0', text: '前端样式规范：按钮圆角统一用 8px', source: 'b.md' },
  ];
  const vectors = await embed(
    embedFn,
    docs.map((d) => d.text),
  );
  store.addBatch(
    docs.map((d, i) => ({ chunk: { ...d, index: 0, tokenEstimate: 10 }, embedding: vectors[i] })),
  );

  const results = await hybridSearch(store, embedFn, 'pm2 部署事故', 2);
  assert.equal(results.length, 2, '应返回两条结果');

  // mock embedder 是哈希假向量、无语义，所以只断言"关键词路径确实命中了 a.md"。
  // 真实 embedder（DashScope）下语义路径也会把 a.md 排上来。
  const hit = results.find((r) => r.chunk.source === 'a.md');
  assert.ok(hit, '关键词命中的片段必须出现在结果里');
  assert.ok(hit!.keywordScore > 0, '关键词路径应给出分数');
  assert.ok(hit!.score > 0, '综合分应大于 0');
  assert.ok(
    results.every((r) => r.vectorScore >= 0 && r.keywordScore >= 0),
    '两条路径的分数都应被记录下来（便于调试排序）',
  );
});

test('4-2：mmrSelect 对高相似候选降权，保证结果多样性', () => {
  const mk = (id: string, text: string, score: number) => ({
    chunk: { id, text, source: 'x.md', index: 0, tokenEstimate: 1, embedding: [], addedAt: 0 },
    score,
    vectorScore: score,
    keywordScore: 0,
  });

  // 2 号与 1 号文本完全相同（相关性 0.99 更高），3 号相关性只有 0.6 但内容不重复。
  // MMR = 0.7×相关性 - 0.3×最大相似度：2 号 0.7*0.99-0.3*1 = 0.393，
  // 3 号 0.7*0.6-0.3*0 = 0.42 —— 应该选 3 号。
  const picked = mmrSelect(
    [
      mk('1', '部署事故 部署事故 回滚', 1),
      mk('2', '部署事故 部署事故 回滚', 0.99),
      mk('3', '样式规范 圆角 统一', 0.6),
    ],
    2,
  );

  assert.equal(picked.length, 2);
  assert.equal(picked[0].chunk.id, '1', '第一名直接入选');
  assert.equal(picked[1].chunk.id, '3', '高度重复的候选应被 MMR 惩罚，改选多样性更好的');
});

test('4-3：lint 按类型分级 TTL，能查出过期路径、重名与超龄未用', async () => {
  const { rm } = await import('node:fs/promises');
  const store = new MemoryStore('.tmp-memory-lint');
  await rm('.tmp-memory-lint', { recursive: true, force: true });

  store.save({
    name: '旧认证模块',
    description: '认证走 legacy 目录',
    type: 'project',
    content: '认证模块在 src/legacy/auth.ts，所有 JWT 签发都走这个文件。',
  });
  store.save({ name: '重复名', description: '第一条', type: 'project', content: '内容 A' });
  // 同名但不同文件名（现实中来自不同时间点存下的两条）——save 会覆盖同 slug 文件，
  // 所以这里直接落一个文件来复现"重名"场景
  const { writeFileSync } = await import('node:fs');
  const dir = store.list()[0].filePath.replace(/[^\\/]+$/, '');
  writeFileSync(
    `${dir}project_重复名-2.md`,
    ['---', 'name: 重复名', 'description: 第二条', 'type: project', '---', '', '内容 B'].join('\n'),
    'utf-8',
  );

  const report = lintAll(store.list(), '.');
  const kinds = report.entries.flatMap((e) => e.issues.map((i) => i.kind));
  assert.ok(kinds.includes('stale_path'), '不存在的路径应被报出');
  assert.ok(kinds.includes('duplicate_name'), '重名应被报出');
  assert.ok(report.entries.length >= 2, '至少两条记忆应被判为有问题');

  // 刚写入的记忆不该被判超龄（TTL 判定依赖 lastReadAt）
  const fresh = store.list().find((e) => e.name === '重复名')!;
  assert.equal(
    validateEntry(fresh, '.').some((i) => i.kind === 'never_used'),
    false,
    '刚写入的记忆不该被判超龄',
  );

  // TTL 分级：偏好一年、决策一个月、外部链接两周
  assert.equal(TTL_BY_TYPE.user, 365);
  assert.equal(TTL_BY_TYPE.project, 30);
  assert.equal(TTL_BY_TYPE.reference, 14);

  await rm('.tmp-memory-lint', { recursive: true, force: true });
});

test('5-1：SkillLoader 未激活只列清单、激活后注入完整 SOP', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const base = '.tmp-skills-test';
  rmSync(base, { recursive: true, force: true });
  mkdirSync(`${base}/.skills/demo`, { recursive: true });
  writeFileSync(
    `${base}/.skills/demo/SKILL.md`,
    [
      '---',
      'name: demo',
      'description: "演示 skill"',
      'when_to_use: "当需要演示时"',
      '---',
      '',
      '# Demo',
      '这是正文 SOP。',
    ].join('\n'),
    'utf-8',
  );

  const loader = new SkillLoader(base);
  const skills = loader.load();
  assert.equal(skills.length, 1, '应扫描到 1 个 skill');
  assert.equal(skills[0].description, '演示 skill', 'frontmatter 的 description 应被解析');
  assert.equal(skills[0].whenToUse, '当需要演示时', 'when_to_use 应被解析（模型据此建议激活）');

  const inactive = loader.buildPromptSection(new Set())!;
  assert.ok(inactive.includes('/demo'), '未激活时应列出名称');
  assert.equal(inactive.includes('这是正文 SOP'), false, '未激活时不应注入正文（渐进式加载）');

  const active = loader.buildPromptSection(new Set(['demo']))!;
  assert.ok(active.includes('这是正文 SOP'), '激活后应注入完整 SOP');

  rmSync(base, { recursive: true, force: true });
});

test('5-2：PluginManager 命名空间前缀 / 环境变量解析 / 卸载清理 / 错误隔离', async () => {
  const registry = new ToolRegistry();
  const manager = new PluginManager(registry);
  let destroyed = false;

  process.env.DEMO_PLUGIN_KEY = 'secret-value';
  const def: PluginDefinition = {
    name: 'demo',
    version: '1.0.0',
    description: '测试插件',
    config: { apiKey: '${DEMO_PLUGIN_KEY}', fixed: 'x' },
    activate(api) {
      assert.equal(api.getConfig().apiKey, 'secret-value', '${ENV} 占位符应被替换成环境变量');
      assert.equal(api.getConfig().fixed, 'x', '非占位符配置原样保留');
      api.registerTools([
        {
          name: 'ping',
          description: 'ping',
          parameters: { type: 'object', properties: {} },
          isConcurrencySafe: true,
          isReadOnly: true,
          execute: async () => 'pong',
        },
      ]);
    },
    destroy() {
      destroyed = true;
    },
  };

  const tools = await manager.load(def);
  assert.deepEqual(tools, ['demo__ping'], '工具名应带 pluginName__ 前缀防冲突');
  assert.ok(
    registry.get('demo__ping')!.description.startsWith('[Plugin:demo]'),
    '描述应带来源前缀，便于调试分辨',
  );
  assert.equal(await registry.executeTool('demo__ping', {}), 'pong');

  // 激活失败的插件不应留下半成品工具，也不影响已加载的插件
  const badDef: PluginDefinition = {
    name: 'bad',
    version: '0.0.1',
    description: '会失败的插件',
    activate(api) {
      api.registerTools([
        {
          name: 'half',
          description: 'half',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'x',
        },
      ]);
      throw new Error('故意失败');
    },
  };
  await assert.rejects(() => manager.load(badDef), '激活失败应抛出');
  assert.equal(registry.get('bad__half'), undefined, '失败插件的工具应被回滚');
  assert.ok(registry.get('demo__ping'), '已加载的插件不受影响（错误隔离）');

  assert.equal(await manager.unload('demo'), true);
  assert.equal(registry.get('demo__ping'), undefined, '卸载后工具应从 Registry 移除');
  assert.equal(destroyed, true, 'destroy 应被调用（资源释放）');
  delete process.env.DEMO_PLUGIN_KEY;
});

test('5-3：ChannelGateway 按 channel:sender 隔离会话，并把回复发回同一 Channel', async () => {
  const sent: Array<{ channelId: string; recipientId: string; text: string }> = [];
  let handler: ((msg: any) => void) | undefined;

  const fakeChannel: ChannelDefinition = {
    name: 'fake',
    description: '测试通道',
    start() {},
    stop() {},
    async send(msg) {
      sent.push(msg);
    },
    onMessage(h) {
      handler = h;
    },
  };

  const seenLengths: number[] = [];
  const gateway = new ChannelGateway({
    buildSystem: () => 'sys',
    runTurn: async (messages, text) => {
      seenLengths.push(messages.length);
      messages.push({ role: 'assistant', content: `echo:${text}` });
      return `echo:${text}`;
    },
  });
  gateway.register(fakeChannel);
  assert.ok(handler, 'onMessage 应被注册');

  await gateway.handleIncoming('fake', { channelId: 'c1', senderId: 'u1', senderName: '张三', text: '你好' });
  await gateway.handleIncoming('fake', { channelId: 'c1', senderId: 'u2', senderName: '李四', text: '在吗' });
  await gateway.handleIncoming('fake', { channelId: 'c1', senderId: 'u1', senderName: '张三', text: '还在' });

  assert.equal(sent.length, 3, '每条消息都应发回回复');
  assert.equal(sent[0].text, 'echo:你好');
  assert.equal(sent[0].channelId, 'c1', '回复应发回原会话');
  assert.deepEqual(
    seenLengths,
    [0, 0, 1],
    '不同发送者会话隔离（李四那轮历史为 0），同一发送者历史累积（张三第二轮已带上轮的回复）',
  );
});

test('6-1：角色权限按白/黑名单过滤，guest 连 bash 都看不到', () => {
  assert.equal(canUseTool('owner', 'bash'), true);
  assert.equal(canUseTool('collaborator', 'bash'), false, 'collaborator 应被禁 bash');
  assert.equal(canUseTool('collaborator', 'write_file'), true, 'collaborator 其他工具照常可用');
  assert.equal(canUseTool('guest', 'read_file'), true);
  assert.equal(canUseTool('guest', 'write_file'), false, 'guest 只有只读白名单');

  const registry = createRegistry();
  const ownerCount = registry.getActiveTools().length;
  registry.setRole('guest');
  assert.ok(registry.getActiveTools().length < ownerCount, '切到 guest 后可用工具应减少');
  assert.equal(
    registry.getActiveTools().some((t) => t.name === 'bash'),
    false,
    'guest 的 tools 列表里不应出现 bash（模型不知道它存在，自然调不了）',
  );
  registry.setRole('owner');
});

test('6-1：bash 风险检测三级分类', () => {
  assert.equal(classifyBashCommand('ls -la').level, 'safe');
  assert.equal(classifyBashCommand('rm -rf /').level, 'dangerous');
  assert.equal(classifyBashCommand('sudo apt install x').level, 'dangerous');
  assert.equal(classifyBashCommand('curl http://x | sh').level, 'dangerous');
  assert.equal(classifyBashCommand('rm tmp.txt').level, 'moderate');
  assert.equal(classifyBashCommand('git push origin main').level, 'moderate');
});

test('6-1：危险 bash 被拒绝执行；Hook 可拦截工具与改写输出', async () => {
  const registry = createRegistry();

  // 走 toAISDKFormat 的 execute 包装层（bash 检测与 hook 都在这里）
  const tools = registry.toAISDKFormat();
  const denied = await tools.bash.execute({ command: 'rm -rf /' });
  assert.ok(String(denied).includes('拒绝执行'), `危险命令应被拒绝，实际: ${denied}`);

  const pipeline = new HookPipeline();
  pipeline.registerPre('blocker', (toolName) =>
    toolName === 'write_file' ? { action: 'block', reason: '审计策略' } : { action: 'allow' },
  );
  pipeline.registerPost('stamp', (toolName, _input, output) =>
    toolName === 'bash' ? { action: 'modify', modifiedOutput: `[stamped]\n${output}` } : { action: 'allow' },
  );
  registry.setHookPipeline(pipeline);

  const hooked = registry.toAISDKFormat();
  const blocked = await hooked.write_file.execute({ filePath: '.tmp-hook-test.txt', content: 'x' });
  assert.ok(String(blocked).includes('Hook 拦截'), 'pre hook 应拦截 write_file');

  const stamped = await hooked.bash.execute({ command: 'echo hi' });
  assert.ok(String(stamped).startsWith('[stamped]'), 'post hook 应改写 bash 输出');

  assert.deepEqual(pipeline.list(), { pre: ['blocker'], post: ['stamp'] }, 'list() 应返回 hook 名称');
});

test('6-2：调度表达式解析三种格式', () => {
  assert.equal(parseSchedule('every 30s').type, 'interval');
  assert.equal(parseSchedule('every 30s').intervalMs, 30_000);
  assert.equal(parseSchedule('every 5m').intervalMs, 300_000);
  assert.equal(parseSchedule('every 1h').intervalMs, 3_600_000);
  assert.equal(parseSchedule('2026-05-11T09:00:00Z').type, 'once');

  const cron = parseSchedule('0 9 * * *');
  assert.equal(cron.type, 'cron');
  assert.ok(getNextCronTime(cron.cronInstance!) > 0, 'cron 应能算出距下次触发的毫秒数');
});

test('6-2：CronService 增删查、持久化与失败熔断', async () => {
  const { rm } = await import('node:fs/promises');
  const base = '.tmp-cron-test';
  await rm(base, { recursive: true, force: true });

  const service = new CronService(base);
  service.load();

  service.add({
    id: 'quote',
    name: '名言推送',
    schedule: 'every 30s',
    scheduleType: 'interval',
    enabled: true,
    payload: { type: 'handler', handler: 'random-quote' },
    source: 'runtime',
  });
  assert.equal(service.list().length, 1);
  assert.equal(service.list()[0].status, 'idle', '未 start 时状态为 idle');

  const out = await service.runNow('quote');
  assert.ok(out.length > 0, 'handler payload 直接返回结果，不走模型');
  assert.equal(service.getRecentLogs('quote').length, 1, '执行日志应写入 JSONL');

  // 失败熔断：执行器抛错 + maxRetries=1 → 自动禁用
  service.setExecutor({
    runAgentPrompt: async () => {
      throw new Error('boom');
    },
  });
  service.add({
    id: 'bad',
    name: '坏任务',
    schedule: 'every 1h',
    scheduleType: 'interval',
    enabled: true,
    payload: { type: 'agent', prompt: 'x' },
    source: 'runtime',
    maxRetries: 1,
  });
  const failOut = await service.runNow('bad');
  assert.ok(failOut.includes('执行失败'), '失败应回填可读文案');
  assert.equal(
    service.list().find((j) => j.config.id === 'bad')!.config.enabled,
    false,
    '连续失败达上限应自动禁用（避免错误无限循环）',
  );

  // 持久化：新实例从 .cron/jobs.json 读回启用的任务
  const reloaded = new CronService(base);
  reloaded.load();
  assert.ok(
    reloaded.list().some((j) => j.config.id === 'quote'),
    '重启后任务应被读回（这就是 CronStore 的作用）',
  );
  assert.equal(
    reloaded.list().some((j) => j.config.id === 'bad'),
    false,
    '被禁用的任务不会被加载调度',
  );

  service.stop();
  await rm(base, { recursive: true, force: true });
});

test('6-3：SubAgentRegistry 的深度与并发保护', () => {
  const registry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 2 });
  assert.equal(registry.canSpawn(0).ok, true, '根层级可以派');
  assert.equal(registry.canSpawn(1).ok, false, '达到最大深度应拒绝');
  assert.ok(registry.canSpawn(1).reason?.includes('深度'), '拒绝原因应说明深度限制');

  registry.register({ id: 'a', task: 't', status: 'running', depth: 1, startedAt: '' });
  registry.register({ id: 'b', task: 't', status: 'running', depth: 1, startedAt: '' });
  assert.equal(registry.canSpawn(0).ok, false, '达到最大并发应拒绝');
  registry.complete('a', 'done');
  assert.equal(registry.canSpawn(0).ok, true, '有任务完成后应能再派');
  assert.equal(registry.getActiveRuns().length, 1);
});

test('6-3：spawnAgent 在独立上下文执行并回传结论，超深度直接拒绝', async () => {
  const registry = createRegistry();
  const agentRegistry = new SubAgentRegistry({ maxSpawnDepth: 1, maxConcurrent: 3 });
  const ctx = {
    model: createMockModel(),
    registry,
    agentRegistry,
    buildSystem: () => 'sys',
    currentDepth: 0,
  };

  const result = await spawnAgent({ task: '说一句问候' }, ctx);
  assert.ok(result.length > 0, '子 Agent 应返回结论文本');

  const runs = agentRegistry.getAllRuns();
  assert.equal(runs.length, 1, '应登记一次运行');
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].depth, 1);
  assert.ok(runs[0].result, '结果应被记录');

  const denied = await spawnAgent({ task: 'x' }, { ...ctx, currentDepth: 1 });
  assert.ok(denied.includes('拒绝'), '超过深度限制应直接拒绝，不执行');
  assert.equal(agentRegistry.getAllRuns().length, 1, '被拒绝的请求不应产生运行记录');
});

test('7-1：配置系统——默认值合并、环境变量替换、非法配置报错', async () => {
  const { writeFileSync, rmSync } = await import('node:fs');
  const path = '.tmp-config-test.json';
  rmSync(path, { force: true });

  // 1) 什么都不写也能拿到完整默认值（配置最小化原则）
  const defaults = SuperAgentConfigSchema.parse({});
  assert.equal(defaults.agents.maxConcurrent, 3);
  assert.equal(defaults.security.defaultRole, 'owner');
  assert.equal(defaults.rag.enabled, true);

  // 2) 只覆盖想改的字段，其余走默认
  writeFileSync(path, JSON.stringify({ agents: { maxConcurrent: 5 } }), 'utf-8');
  const partial = loadConfig(path);
  assert.equal(partial.agents.maxConcurrent, 5, '覆盖生效');
  assert.equal(partial.agents.maxSpawnDepth, 1, '未覆盖的字段走默认');
  assert.equal(partial.model.name, 'qwen-plus-latest');

  // 3) ${ENV_VAR} 在校验前替换
  process.env.TMP_TEST_API_KEY = 'sk-from-env';
  writeFileSync(path, JSON.stringify({ model: { apiKey: '${TMP_TEST_API_KEY}' } }), 'utf-8');
  const withEnv = loadConfig(path);
  assert.equal(withEnv.model.apiKey, 'sk-from-env', '占位符应被替换成环境变量值');

  // 4) 非法配置应抛错（这里用 safeParse 验证校验确实生效）
  const bad = SuperAgentConfigSchema.safeParse({ agents: { maxConcurrent: 99 } });
  assert.equal(bad.success, false, '超出范围的并发数应校验失败');

  delete process.env.TMP_TEST_API_KEY;
  rmSync(path, { force: true });
});

test('8-1：LocalTraceRecorder 逐行落盘、脱敏、inspectTrace 可复盘', async () => {
  const { rm } = await import('node:fs/promises');
  const dir = '.tmp-traces-test';
  await rm(dir, { recursive: true, force: true });

  const trace = await LocalTraceRecorder.start({ directory: dir, sessionId: 'test', model: 'mock' });
  await trace.recordStepStarted({
    step: 1,
    system: 'sys',
    messages: [{ role: 'user', content: '你好' } as any],
  });
  await trace.recordStepCompleted({
    step: 1,
    text: '回答',
    outputMessages: [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'read_file', input: {} }] } as any,
    ],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await trace.recordAttemptError(2, 1, new Error('429 too many requests'));
  await trace.finish('completed');

  const report = await inspectTrace(trace.filePath);
  assert.ok(report.includes('Trace test-'), '应包含 trace id');
  assert.ok(report.includes('Step 1: context 1 messages'), '应记录 Step 开始前的上下文快照');
  assert.ok(report.includes('tools: read_file'), '应从输出消息里提取工具名');
  assert.ok(report.includes('attempt 1 failed: 429'), '失败的尝试应留痕');
  assert.ok(report.includes('Status: completed'), 'trace_finished 应可识别');

  // 脱敏：含 apiKey 字段的内容不应原样落盘
  const trace2 = await LocalTraceRecorder.start({ directory: dir, sessionId: 'test2', model: 'mock' });
  await trace2.recordStepStarted({
    step: 1,
    system: 'sys',
    messages: [{ role: 'user', content: 'k', apiKey: 'sk-super-secret' } as any],
  });
  await trace2.finish('completed');
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(trace2.filePath, 'utf8');
  assert.equal(raw.includes('sk-super-secret'), false, 'API Key 必须被脱敏');
  assert.ok(raw.includes('[REDACTED]'), '应留下脱敏标记');

  await rm(dir, { recursive: true, force: true });
});

test('模型降级链：识别"换模型能解决"的错误，并逐级切换', () => {
  const mk = (name: string) => ({ name, model: { modelId: name } as any });
  const chain = new ModelChain([mk('primary'), mk('fallback-1'), mk('fallback-2')]);

  assert.deepEqual(chain.names(), ['primary', 'fallback-1', 'fallback-2']);
  assert.equal(chain.currentName, 'primary');
  assert.equal(chain.advance(), true);
  assert.equal(chain.currentName, 'fallback-1');
  assert.equal(chain.advance(), true);
  assert.equal(chain.currentName, 'fallback-2');
  assert.equal(chain.advance(), false, '最后一个候选不能再切（调用方应把错误抛出）');

  // 该换模型的错误
  assert.equal(isModelUnavailableError(new Error('Free quota exhausted. To continue accessing…')), true);
  assert.equal(isModelUnavailableError(new Error('AllocationQuota.FreeTierOnly')), true);
  assert.equal(isModelUnavailableError(new Error('The model `x` does not exist')), true);
  assert.equal(isModelUnavailableError(new Error('Access denied. For details…')), true);
  assert.equal(isModelUnavailableError(new Error('Incorrect API key provided: invalid_api_key')), true);

  // 不该换模型的错误：网络抖动与限流分别由退避重试处理
  assert.equal(isModelUnavailableError(new Error('fetch failed: ECONNRESET')), false);
  assert.equal(isModelUnavailableError(new Error('429 Too Many Requests')), false);

  // AI SDK 的 APICallError 未必是标准 Error 实例，信息藏在 responseBody 里——
  // 这个形状是实测抓到的真实错误对象
  const apiCallError = {
    message: 'unknown provider for model no-such-model-v9',
    statusCode: 400,
    responseBody:
      '{"error":{"message":"unknown provider for model no-such-model-v9","code":"model_not_found"}}',
    data: { error: { code: 'model_not_found' } },
  };
  assert.equal(isModelUnavailableError(apiCallError), true, '应从 responseBody 里识别出 model_not_found');

  const quotaError = { statusCode: 400, responseBody: '{"code":"AllocationQuota.FreeTierOnly"}' };
  assert.equal(isModelUnavailableError(quotaError), true, '应从 responseBody 里识别出额度用尽');

  // onError 回调收到的是包装对象（实测形状：{ error: APICallError }）
  const wrapped = {
    error: {
      name: 'AI_APICallError',
      statusCode: 400,
      responseBody: '{"error":{"code":"model_not_found","message":"unknown provider for model x"}}',
    },
  };
  assert.equal(isModelUnavailableError(wrapped), true, '应能穿透 { error: … } 包装识别');
});

test('模型降级链：默认候选必须全部有免费额度——降级不能变成花钱', () => {
  const cfg = SuperAgentConfigSchema.parse({});
  const chain = cfg.model.chain as string[];

  // 这些模型曾经挂在默认链的尾巴上当"兜底"，但它们都没有免费额度：
  // 主模型一失败，链就一路降级到它们身上，从"免费用"变成"按量付费"，
  // 账单失控就是这么来的（2026-09-23 实际发生，欠费 ¥0.01 锁死整个账号）。
  // 这个断言就是防止它们再溜回来。
  const PAID_MODELS = [
    'qwen-plus',
    'qwen-max',
    'qwen3-max',
    'qwen-turbo',
    'qwen-long',
    'deepseek-v3',
    'qwq-plus',
  ];
  for (const m of PAID_MODELS) {
    assert.equal(chain.includes(m), false, `${m} 没有免费额度，不能出现在默认降级链里`);
  }

  // 顺序 = 免费额度到期时间由近到远（先用快到期的，别浪费）
  // 清单依据百炼控制台「费用用量 → 免费额度」，2026-09-23 核对
  assert.deepEqual(chain, [
    'qwen3.7-flash', // 2026-10-23
    'qwen3.7-flash-2026-07-15', // 2026-10-23
    'deepseek-v4-flash-0731', // 2026-10-31
    'qwen3.8-max', // 2026-11-01
    'qwen3.8-2.4t-a95b', // 2026-11-12
    'deepseek-v4-pro-0813', // 2026-11-13
    'qwen3.8-27b', // 2026-11-18
    'kimi-k3', // 2026-11-18
    'glm-5.3', // 2026-11-23
    'qwen3.8-flash', // 2026-11-25
    'qwen3.8-max-0902', // 2026-12-01
    'deepseek-v4.1-flash', // 2026-12-13
    'qwen3.8-omni-flash', // 2026-12-17
  ]);
});

test('embedding：候选按到期由近到远，且请求体不能带 dimensions', async () => {
  const seen: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return { json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
  }) as any;

  try {
    const embedFn = createDashScopeEmbedder('test-key');
    await embedFn(['hello']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 只调第一个候选（选中的会被记住，后续不再重试其它候选）
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].model,
    'qwen3.7-text-embedding',
    '默认先试最快到期的 qwen3.7-text-embedding（2026-10-13）',
  );

  // dimensions 绝不能传：DashScope 只接受 [256,512,768,1024,1536,2048,2560]，
  // 传 128 会让云端调用**每次都失败**、然后静默降级成 mock 向量——
  // 日志里只有一行容易看漏的提示，检索质量会一直悄悄打折（2026-09-23 实际发生）。
  assert.equal('dimensions' in seen[0], false, '不应传 dimensions，用模型原生维度（1024）');
});

test('模型降级链：降级次数与路径可统计，且按轮清零', () => {
  const mk = (name: string) => ({ name, model: { modelId: name } as any });
  const chain = new ModelChain([mk('primary'), mk('fallback-1'), mk('fallback-2')]);

  // 没降级时读到的应是空，而不是 undefined 或 "0 次"
  assert.equal(chain.degradationCount, 0);
  assert.equal(chain.degradationPath, '');

  assert.equal(chain.advance(), true);
  assert.equal(chain.degradationCount, 1);
  assert.equal(chain.degradationPath, 'primary → fallback-1');

  assert.equal(chain.advance(), true);
  assert.equal(chain.degradationCount, 2);
  assert.equal(
    chain.degradationPath,
    'primary → fallback-1 → fallback-2',
    '路径要串成完整链条，而不是只留最后一次',
  );

  // 已经是最后一个：切不动，计数也不能虚增
  assert.equal(chain.advance(), false);
  assert.equal(chain.degradationCount, 2, '切不动时不能多记一次');

  // 每轮任务开始 reset()，降级记录一并清零——所以 /usage 读到的始终是"本轮"
  chain.reset();
  assert.equal(chain.currentName, 'primary');
  assert.equal(chain.degradationCount, 0);
  assert.equal(chain.degradationPath, '');
});

// ---------------------------------------------------------------------------
// 五、Agent Loop：消息协议与三层保险丝
// ---------------------------------------------------------------------------
test('agent loop：纯文本对话正常交付，不产生工具消息', async () => {
  const messages: any[] = [{ role: 'user', content: '你好' }];
  const budget: BudgetState = { used: 0, limit: 25000 };

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
  });

  assert.ok(answer.length > 0, '应当返回非空回答');
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant'],
    '纯文本对话不应插入 tool 消息'
  );
  assert.equal(budget.used, 30, '预算应按实际用量累加');
});

test('agent loop：多步工具调用能通过 v7 消息 schema 校验', async () => {
  const messages: any[] = [{ role: 'user', content: '测试死循环' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const toolResults: any[] = [];

  await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
    maxSteps: 8,
    onToolResult: (_n, r) => toolResults.push(r),
  });

  // 核心断言：消息里必须存在 tool 消息，且其 content 用的是 v7 的 output 字段
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assert.ok(toolMessages.length > 0, '应当产生 tool 消息');

  const firstPart = toolMessages[0].content[0] as any;
  assert.equal(firstPart.type, 'tool-result');
  assert.ok(firstPart.output, 'tool-result 必须使用 output 字段（v7 规范）');
  assert.equal(typeof firstPart.output.value, 'string', 'output 必须是 { type, value } 结构');
  assert.equal(firstPart.result, undefined, '不应残留旧版 result 字段');

  // 工具必须真正收到参数并算出结果
  assert.ok(
    toolResults.some((r) => String(r).includes('1 + 1 = 2')),
    `工具应正确执行，实际结果：${JSON.stringify(toolResults)}`
  );
});

test('agent loop：assistant 消息的工具调用使用 input 字段', async () => {
  const messages: any[] = [{ role: 'user', content: '测试死循环' }];
  const budget: BudgetState = { used: 0, limit: 25000 };

  await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
    maxSteps: 2,
  });

  const assistantWithTool = messages.find(
    (m) => m.role === 'assistant' && Array.isArray(m.content)
  ) as any;
  assert.ok(assistantWithTool, '应当存在带工具调用的 assistant 消息');

  const callPart = assistantWithTool.content[0];
  assert.equal(callPart.type, 'tool-call');
  assert.ok(callPart.input !== undefined, 'tool-call 必须使用 input 字段（v7 规范）');
  assert.equal(callPart.args, undefined, '不应残留旧版 args 字段');
});

test('agent loop：第三层短路保护能拦截死循环', async () => {
  const messages: any[] = [{ role: 'user', content: '测试死循环' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const warnings: string[] = [];

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
    maxSteps: 20,
    onWarning: (w) => warnings.push(w),
  });

  assert.ok(answer.includes('短路熔断'), `应当触发短路熔断，实际返回：${answer}`);
  assert.ok(
    warnings.some((w) => w.includes('短路熔断告警')),
    '应当通过 onWarning 播报熔断告警'
  );
});

test('agent loop：第一层漏电保护能拦截超预算会话', async () => {
  const messages: any[] = [{ role: 'user', content: '你好' }];
  // 模拟会话已经消耗过、余额见底的状态，此时入口门禁就该拦下
  const budget: BudgetState = { used: 10, limit: 10 };

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
  });

  assert.ok(answer.includes('Token 预算耗尽拦截'), `应当触发预算拦截，实际返回：${answer}`);
  assert.equal(messages.length, 1, '预算拦截时不应写入任何新消息');
  assert.equal(budget.used, 10, '被拦截时不应产生新的 Token 消耗');
});

test('agent loop：执行中途超预算会立即熔断', async () => {
  const messages: any[] = [{ role: 'user', content: '测试预算' }];
  const budget: BudgetState = { used: 0, limit: 25000 };

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
  });

  assert.ok(answer.includes('执行中途预算超支'), `应当中途熔断，实际返回：${answer}`);
  assert.equal(budget.used, 30000, '预算应按实际消耗累加');
});

test('agent loop：测试截断指令能跑通并产生 tool 消息', async () => {
  const messages: any[] = [{ role: 'user', content: '测试截断' }];
  const budget: BudgetState = { used: 0, limit: 25000 };

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
    maxSteps: 4,
  });

  assert.ok(answer.length > 0, '应当返回回答');

  // 注意：onToolResult 拿到的是给终端看的 120 字符预览，
  // 要验证截断必须读回填进上下文的 tool 消息，那里才是完整结果。
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assert.ok(toolMessages.length > 0, '应当产生 tool 消息');

  const resultText = (toolMessages[0].content[0] as any).output.value as string;
  assert.ok(
    resultText.includes('省略'),
    `读取大文件应触发截断，实际结果：${resultText.slice(0, 200)}`
  );
  assert.ok(resultText.length < 900, `截断后长度应明显小于原文，实际 ${resultText.length}`);
});

test('agent loop：测试并发指令一次触发多个只读工具', async () => {
  const messages: any[] = [{ role: 'user', content: '测试并发' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const toolCalls: string[] = [];

  const answer = await runAgentLoop({
    model: createMockModel(),
    messages,
    registry: createRegistry(),
    budget,
    maxSteps: 4,
    onToolCall: (name) => toolCalls.push(name),
  });

  assert.ok(answer.length > 0, '应当返回回答');
  assert.equal(toolCalls.length, 3, `应当一次触发 3 个工具调用，实际：${JSON.stringify(toolCalls)}`);
  assert.equal(toolCalls.filter((n) => n === 'get_weather').length, 2, '应含两次天气查询');
  assert.ok(toolCalls.includes('list_directory'), '应含一次目录列举');
});

// ---------------------------------------------------------------------------
// 六、批次并行执行：全只读并行 / 含写工具串行
// ---------------------------------------------------------------------------

test('agent loop：全只读批次真并行，执行区间发生重叠', async () => {
  const messages: any[] = [{ role: 'user', content: '跑一批只读工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry, spans } = createProbeRegistry();

  await runAgentLoop({
    model: createBatchModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_b', input: {} },
      { toolName: 'probe_c', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 4,
  });

  assert.equal(spans.length, 3, '三个探针工具都应执行');
  assert.ok(
    hasOverlap(spans),
    `全只读批次应并行执行（区间重叠），实际区间：${JSON.stringify(spans)}`
  );
});

test('agent loop：读写锁语义下写工具独占，区间不与其他工具重叠', async () => {
  const messages: any[] = [{ role: 'user', content: '跑一批混合工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry, spans } = createProbeRegistry();

  await runAgentLoop({
    model: createBatchModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_write', input: {} },
      { toolName: 'probe_b', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 4,
  });

  assert.equal(spans.length, 3, '三个探针工具都应执行');

  // 读写锁语义：写工具拿独占锁，必须与其他工具完全错开；
  // 只读工具之间拿共享锁，允许重叠。这与旧路线的「含写工具就整批串行」
  // 是两回事——后者是 Agent Loop 自己分流执行的结果，已随回归一并移除，
  // 现在并发顺序完全由 Registry 的锁决定，Agent Loop 不感知并发细节。
  const write = spans.find((s) => s.name === 'probe_write');
  assert.ok(write, '写工具应当执行');

  for (const reader of spans.filter((s) => s.name !== 'probe_write')) {
    const overlapped = reader.start < write.end && write.start < reader.end;
    assert.ok(
      !overlapped,
      `写工具执行期间不应有其他工具在跑，实际区间：${JSON.stringify(spans)}`
    );
  }
});

test('agent loop：并行批次下 tool-result 与 tool-call 严格配对', async () => {
  const messages: any[] = [{ role: 'user', content: '跑一批只读工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry } = createProbeRegistry();

  await runAgentLoop({
    model: createBatchModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_b', input: {} },
      { toolName: 'probe_c', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 4,
  });

  // 取出 assistant 侧的调用 id 与 tool 侧的结果 id，两者必须一一对应
  const callIds = messages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-call').map((c: any) => c.toolCallId));
  const resultIds = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-result').map((c: any) => c.toolCallId));

  assert.equal(callIds.length, 3, '应有 3 个 tool-call');
  assert.equal(resultIds.length, 3, '应有 3 个 tool-result');
  assert.deepEqual(
    [...resultIds].sort(),
    [...callIds].sort(),
    '每个 tool-call 都必须有同 id 的 tool-result'
  );
});

test('agent loop：熔断时整批补 result，消息配对不被破坏', async () => {
  const messages: any[] = [{ role: 'user', content: '跑一批只读工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry, spans } = createProbeRegistry();

  // 每一轮都注入同一个批次（3 个完全相同的 probe_a 调用），把重复计数一路推高：
  // 第 1 轮指纹重复 0/1/2 次 → 全部放行；随后累计次数跨过 warning 与 critical 阈值，
  // 被拦下的调用不再执行，也不再登记。
  const answer = await runAgentLoop({
    model: createRepeatingModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_a', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 8,
  });

  assert.ok(answer.includes('短路熔断'), `应触发短路熔断，实际：${answer}`);
  assert.ok(spans.length >= 3, `熔断前已执行过探针工具，实际执行 ${spans.length} 次`);

  const callIds = messages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-call').map((c: any) => c.toolCallId));
  const resultIds = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-result').map((c: any) => c.toolCallId));

  assert.ok(callIds.length > 0, '应当存在 tool-call');
  assert.equal(resultIds.length, callIds.length, '熔断时也必须为每个 tool-call 补上 tool-result');
  assert.deepEqual(
    [...resultIds].sort(),
    [...callIds].sort(),
    '每个 tool-call 都必须有同 id 的 tool-result'
  );
});

// ---------------------------------------------------------------------------
// 七、回归验收断言（c1 - c4）
//
// c4「截断与读写锁在 SDK 执行路径上依然生效」由前面三条测试承担，
// 它们现在全部经由 streamText 执行，覆盖的就是 SDK 路径：
//   - 截断：「测试截断指令能跑通并产生 tool 消息」
//   - 只读共享锁并行：「全只读批次真并行，执行区间发生重叠」
//   - 写工具独占：「读写锁语义下写工具独占，区间不与其他工具重叠」
// ---------------------------------------------------------------------------

test('回归验收 c1：一批工具每个只被执行一次，SDK 与 Loop 不重复执行', async () => {
  const messages: any[] = [{ role: 'user', content: '同一批里重复调用同一个工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry, spans } = createProbeRegistry();

  await runAgentLoop({
    model: createBatchModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_a', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 4,
  });

  // 3 次调用 = 3 次执行。旧路线里 SDK 与 Loop 各跑一遍，这里会是 6。
  assert.equal(spans.length, 3, `每个工具调用只应执行一次，实际执行 ${spans.length} 次`);
});

test('回归验收 c2：消息由 SDK 组装，配对完整且符合 v7 schema', async () => {
  const messages: any[] = [{ role: 'user', content: '跑一批只读工具' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry } = createProbeRegistry();

  await runAgentLoop({
    model: createBatchModel([
      { toolName: 'probe_a', input: {} },
      { toolName: 'probe_b', input: {} },
    ]),
    messages,
    registry,
    budget,
    maxSteps: 4,
  });

  const callParts = messages
    .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-call'));
  const resultParts = messages
    .filter((m) => m.role === 'tool')
    .flatMap((m: any) => m.content.filter((c: any) => c.type === 'tool-result'));

  assert.equal(callParts.length, 2, '应有 2 个 tool-call');
  assert.equal(resultParts.length, 2, '应有 2 个 tool-result');
  assert.deepEqual(
    resultParts.map((c: any) => c.toolCallId).sort(),
    callParts.map((c: any) => c.toolCallId).sort(),
    '每个 tool-call 都必须有同 id 的 tool-result'
  );

  // v7 schema：assistant 用 input 承载参数，tool 用 output:{ type, value } 承载结果
  for (const part of callParts) {
    assert.ok(part.input !== undefined, 'tool-call 必须使用 input 字段');
    assert.equal(part.args, undefined, '不应残留旧版 args 字段');
  }
  for (const part of resultParts) {
    assert.equal(
      typeof part.output?.value,
      'string',
      'tool-result 的 output 必须是 { type, value } 结构'
    );
    assert.equal(part.result, undefined, '不应残留旧版 result 字段');
  }
});

test('回归验收 c3：判定为 critical 时该工具不被执行（执行前拦截）', async () => {
  const messages: any[] = [{ role: 'user', content: '反复调用同一个探针' }];
  const budget: BudgetState = { used: 0, limit: 25000 };
  const { registry, spans } = createProbeRegistry();

  let callEvents = 0;
  const answer = await runAgentLoop({
    model: createRepeatingModel([{ toolName: 'probe_a', input: {} }]),
    messages,
    registry,
    budget,
    maxSteps: 12,
    onToolCall: () => {
      callEvents++;
    },
  });

  assert.ok(answer.includes('短路熔断'), `应当触发熔断，实际返回：${answer}`);

  // 被拦下的那一轮产生了 tool-call 事件，但没有真正执行——
  // 这正是方案 B 要保住的「执行前拦截」，副作用不会落地。
  assert.ok(
    callEvents > spans.length,
    `应当存在「有调用但未执行」的拦截轮次，调用 ${callEvents} 次 / 实际执行 ${spans.length} 次`
  );
});
