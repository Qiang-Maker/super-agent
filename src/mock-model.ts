/**
 * ============================================================================
 * 模拟模型（Mock Model）
 * ============================================================================
 *
 * 【为什么需要 Mock 模型？】
 * 1. 零成本开发：在没有 API Key 或网络离线时，依然可以跑通完整的对话主循环。
 * 2. 确定性测试：单元测试和冒烟测试中避免消耗 Token 与不可控的模型幻觉。
 * 3. 深入理解底层：展示 Vercel AI SDK 的 Provider 机制与 LanguageModel 接口规范。
 *
 * 【核心原理】
 * Vercel AI SDK 采用 Provider 适配器模式。任何实现了 LanguageModel 规范的对象，
 * 都能直接传给 `generateText` 或 `streamText`，调用方无需修改任何业务代码。
 *
 * 【规范版本说明】
 * AI SDK v7 同时支持 v2 / v3 / v4 三套 Provider 规范，其中 v4 是当前主推版本
 * （官方 @ai-sdk/openai provider 用的就是 v4）。声明哪一套，就必须完整返回那一套的
 * 数据结构：v4 的 usage 是嵌套的 { inputTokens: { total, ... }, outputTokens: { ... } }，
 * tool-call 的参数放在 input 字段且为 stringified JSON。
 * 版本声明与返回结构不一致时，SDK 会进入兼容模式，导致用量记账失效、工具匹配失败。
 *
 * 【两条输出路径必须行为一致】
 * Agent Loop 走的是 streamText，所以故障注入不能只写在 doGenerate 里。
 * 决策逻辑抽在 decide() 一处，doGenerate / doStream 只负责把它渲染成各自的数据结构——
 * 否则同一句「测试并发」在两条路径下会得到完全不同的行为。
 */

import type { LanguageModel } from 'ai';

// 预置的规则应答表：通过简单关键词匹配模拟模型响应
const RESPONSES: Record<string, string> = {
  default: '你好！我是模拟模型（Mock Model）。填了真实的 API Key 之后会自动切换到真实大模型。',
  greeting: '你好！虽然我现在是本地模拟运行，但流式逐字输出的机制和真实 API 完全一致 :)',
  name: '你刚才告诉我了呀！我之所以能"记住"，是因为你的客户端代码把历史 messages 数组完整回传给了我。',
  intro: '我是 Super Agent（模拟版）。我证明了大模型本身无记忆，记忆本质上是客户端上下文的累加。',
};

/** 流式输出每个字符的推流间隔，模拟真实大模型的打字机效果 */
const STREAM_CHAR_DELAY_MS = 25;

/**
 * 依据最新一条用户消息的内容，匹配合适的回复文本
 */
function pickResponse(prompt: any[]): string {
  const text = lastUserText(prompt);

  if (text.includes('介绍你自己') || text.includes('你是谁')) return RESPONSES.intro;
  if (text.includes('你好') || text.includes('hello')) return RESPONSES.greeting;
  if (text.includes('叫什么') || text.includes('记住') || text.includes('我是谁')) return RESPONSES.name;
  if (text.includes('测试死循环')) return '触发测试死循环指令';
  if (text.includes('测试重试')) return '重试成功，这一次请求正常返回了。';
  if (text.includes('测试预算')) return '触发测试预算指令';
  if (text.includes('测试截断')) return '读取大文件后触发了 Head/Tail 60/40 截断保护。';
  if (text.includes('测试并发')) return '三个只读工具都拿到了共享锁，并行执行完成。';
  return RESPONSES.default;
}

/**
 * 取出最新一条用户消息的纯文本内容（已转小写）
 *
 * 取的是「最后一条 user 消息」而不是「最后一条消息」：多步循环里
 * tool / assistant 消息会不断追加，但触发指令始终是用户最初那句话。
 */
function lastUserText(prompt: any[]): string {
  const userMsgs = (prompt || []).filter((m: any) => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  return (last?.content || [])
    .map((c: any) => c.text || '')
    .join('')
    .toLowerCase();
}

/**
 * 判断「本轮」是否已经回填过工具结果
 *
 * 用途：Mock 的「测试截断」「测试并发」只在首次调用时注入工具调用，
 * 等工具结果回填后再走文本回答，避免像「测试死循环」那样无限注入导致熔断。
 *
 * 边界：只看最近一条 user 消息之后的部分。会话历史是跨轮累加的，
 * 若扫全量历史，上一轮留下的 tool 消息会让本轮误判成「已回填」，
 * 指令就再也注入不出工具调用了。
 */
function hasToolResult(prompt: any[]): boolean {
  const msgs = prompt || [];

  let lastUserIndex = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  return msgs.slice(lastUserIndex + 1).some((m: any) => {
    if (m.role === 'tool') return true;
    if (Array.isArray(m.content)) {
      return m.content.some((c: any) => c.type === 'tool-result');
    }
    return false;
  });
}

/**
 * 构造 AI SDK v4 规范的 usage 结构
 *
 * v4 把用量拆成 inputTokens / outputTokens 两个嵌套对象，
 * 且每项都要求显式的 total 字段。结构写错会导致 SDK 无法解析，
 * 最终表现为 usage.totalTokens 为 undefined，Token 预算记账整体失效。
 *
 * @param total 本次调用消耗的总 Token 数
 * @param input 其中输入（prompt）部分的占比，默认按 1:3 拆分
 */
function makeUsage(total: number, input = Math.round(total / 3)): any {
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: total - input,
      text: total - input,
      reasoning: undefined,
    },
  };
}

/** 一次模型调用的决策结果：发起一批工具调用 / 直接给文本 / 抛出可重试错误 */
type MockDecision =
  | { kind: 'tool-calls'; calls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>; usage: number }
  | { kind: 'text'; text: string; usage: number }
  | { kind: 'error'; message: string };

/** 工具调用 ID 的自增序号，保证同一毫秒内的多次调用也不重号 */
let callSeq = 0;
const nextCallId = (tag: string) => `${tag}-${++callSeq}`;

/** 「测试重试」上一轮提问的 user 消息条数，用来区分新一轮提问与同一轮内的重试 */
let retryTurnUserCount = -1;

/**
 * 判断这一轮提问是否需要注入一次限流故障
 *
 * 只在每一轮提问的第一次调用抛错，重试时放行——否则会连抛三次直接把任务判死。
 * 判据是 user 消息条数：重试时 messages 数组原样未动，条数不变；
 * 用户新问一句则条数 +1，于是下一条「测试重试」又能重新演示一遍。
 */
function shouldInjectRetryFailure(prompt: any[]): boolean {
  const userCount = (prompt || []).filter((m: any) => m.role === 'user').length;
  if (userCount !== retryTurnUserCount) {
    retryTurnUserCount = userCount;
    return true;
  }
  return false;
}

/**
 * 故障注入与应答决策的唯一入口
 *
 * doGenerate 与 doStream 都从这里取结果，保证两条路径行为完全一致。
 */
function decide(prompt: any[]): MockDecision {
  const text = lastUserText(prompt);

  // 故障注入 1：测试死循环（连续请求调用同一个工具与相同参数）
  if (text.includes('测试死循环')) {
    return {
      kind: 'tool-calls',
      calls: [
        { toolCallId: nextCallId('call-loop'), toolName: 'calculator', input: { expression: '1 + 1' } },
      ],
      usage: 100,
    };
  }

  // 故障注入 2：测试重试（首次调用抛 429 限流，逼出指数退避重试）
  if (text.includes('测试重试') && shouldInjectRetryFailure(prompt)) {
    return { kind: 'error', message: '429 Too Many Requests（模拟限流）' };
  }

  // 故障注入 3：测试 Token 预算超标
  if (text.includes('测试预算')) {
    return {
      kind: 'text',
      text: '已模拟一次性生成超大文本并消耗海量 Token！',
      usage: 30000,
    };
  }

  // 故障注入 4：测试截断（读大文件触发 Head/Tail 60/40 截断）
  // 仅在还没回填过工具结果时注入，避免反复调用同一工具触发短路熔断
  if (text.includes('测试截断') && !hasToolResult(prompt)) {
    return {
      kind: 'tool-calls',
      calls: [
        { toolCallId: nextCallId('call-truncate'), toolName: 'read_file', input: { filePath: 'sample-data.txt' } },
      ],
      usage: 100,
    };
  }

  // 故障注入 5：测试并发（一次注入三个只读工具，观察共享锁并行）
  if (text.includes('测试并发') && !hasToolResult(prompt)) {
    return {
      kind: 'tool-calls',
      calls: [
        { toolCallId: nextCallId('call-weather-bj'), toolName: 'get_weather', input: { city: '北京' } },
        { toolCallId: nextCallId('call-weather-sh'), toolName: 'get_weather', input: { city: '上海' } },
        { toolCallId: nextCallId('call-listdir'), toolName: 'list_directory', input: { dirPath: '.' } },
      ],
      usage: 120,
    };
  }

  return { kind: 'text', text: pickResponse(prompt), usage: 30 };
}

/**
 * 创建延迟流（模拟真实大模型 SSE 流式输出打字机效果）
 * @param chunks 数据分块数组
 * @param delayMs 每个分块之间的推流间隔（毫秒）
 */
function createDelayedStream(chunks: any[], delayMs = STREAM_CHAR_DELAY_MS): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

/**
 * 创建 Mock 语言模型实例
 * 实现了 AI SDK 的 LanguageModel 规范
 */
export function createMockModel(): LanguageModel {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock-provider',
    modelId: 'mock-model-v1',
    get supportedUrls() {
      return Promise.resolve({});
    },

    // 1. 同步生成方法（用于 generateText）
    async doGenerate({ prompt }: any) {
      const decision = decide(prompt);
      if (decision.kind === 'error') throw new Error(decision.message);

      if (decision.kind === 'tool-calls') {
        return {
          content: decision.calls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            // v4 规范：input 承载 stringified JSON 对象
            input: JSON.stringify(call.input),
          })),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(decision.usage),
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text' as const, text: decision.text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: makeUsage(decision.usage),
        warnings: [],
      };
    },

    // 2. 流式生成方法（用于 streamText —— Agent Loop 走的就是这条）
    async doStream({ prompt }: any) {
      const decision = decide(prompt);
      if (decision.kind === 'error') throw new Error(decision.message);

      const chunks: any[] = [];

      if (decision.kind === 'tool-calls') {
        // 最小可用形态：SDK 认一个 tool-call 分块就够了，
        // 不需要再补 tool-input-start / delta / end 三段
        for (const call of decision.calls) {
          chunks.push({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
          });
        }
      } else {
        // 模拟标准 SSE 数据分块：text-start -> text-delta (逐字) -> text-end
        const id = 'text-chunk-1';
        chunks.push({ type: 'text-start' as const, id });
        for (const char of decision.text.split('')) {
          chunks.push({ type: 'text-delta' as const, id, delta: char });
        }
        chunks.push({ type: 'text-end' as const, id });
      }

      chunks.push({
        type: 'finish' as const,
        finishReason: {
          unified: decision.kind === 'tool-calls' ? ('tool-calls' as const) : ('stop' as const),
          raw: undefined,
        },
        usage: makeUsage(decision.usage),
      });

      return {
        stream: createDelayedStream(chunks, STREAM_CHAR_DELAY_MS),
      };
    },
  } as unknown as LanguageModel;
}
