/**
 * ============================================================================
 * spawnAgent —— 执行隔离的核心
 * ============================================================================
 *
 * 【隔离的本质就是一行代码】
 *   const messages: ModelMessage[] = [{ role: 'user', content: request.task }]
 * 子 Agent 拿到全新的空 messages——父 Agent 的历史一概看不到。同一个模型、
 * 同一套工具，但上下文互不干扰。
 *
 * 【结果压缩 10-20 倍】子 Agent 读了几十个搜索结果，回传的只是一段几百 token 的结论。
 *
 * 【四个设计决策】
 * 1. 不复用 agentLoop：它走 toAISDKFormat()（带读写锁），而 spawn_agent 本身是工具，
 *    执行时父 Agent 的锁还没释放，子 Agent 再取锁会死锁 → 用 toAISDKFormatUnlocked()
 * 2. EXCLUDED_TOOLS 排除 spawn_agent：从源头避免子 Agent 再派子 Agent
 * 3. 最后一步强制输出文字：toolChoice:'none'（API 层禁止）+ 注入总结提示（prompt 层引导）
 * 4. AbortController 超时保护：超时能中断请求，并尝试回传已有部分结果
 */

import { type ModelMessage, streamText } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { SubAgentRegistry } from './registry.js';
import type { SpawnRequest } from './types.js';

export interface SpawnContext {
  model: any;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
}

const EXCLUDED_TOOLS = new Set(['spawn_agent']);
const MAX_STEPS = 30;

const AGENT_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m'];
const RESET = '\x1b[0m';

/** 子 Agent 并行时终端输出会交错，用 ANSI 颜色前缀区分 */
function agentTag(index: number, runId: string): string {
  return `${AGENT_COLORS[index % AGENT_COLORS.length]}[Agent-${index + 1}:${runId}]${RESET}`;
}

function extractText(message: ModelMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as any[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  ctx.agentRegistry.register({
    id: runId,
    task: request.task,
    status: 'running',
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  });

  const timeout = request.timeout || ctx.agentRegistry.getConfig().defaultTimeout;
  const ac = new AbortController();
  const messages: ModelMessage[] = [{ role: 'user', content: request.task }];
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  try {
    const system =
      ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n需要多个独立信息时（读多个文件、搜多个关键词），尽量在一次回复中并行调用多个工具。';

    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      let step = 0;
      while (step < MAX_STEPS) {
        step++;
        const isLastStep = step === MAX_STEPS;
        console.log(`  ${tag} Step ${step}/${MAX_STEPS}${isLastStep ? ' (总结)' : ''}`);
        if (isLastStep) {
          messages.push({
            role: 'user',
            content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。',
          });
        }

        const result = streamText({
          model: ctx.model,
          system,
          tools,
          toolChoice: isLastStep ? 'none' : 'auto',
          messages,
          maxRetries: 0,
          abortSignal: ac.signal,
          onError: () => {},
        });

        let hasToolCall = false;
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            hasToolCall = true;
            console.log(`  ${tag} 调用 ${part.toolName}(${JSON.stringify(part.input).slice(0, 80)})`);
          }
        }

        messages.push(...(await result.response).messages);
        if (!hasToolCall) break;
      }
    } finally {
      clearTimeout(timer);
    }

    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const result = extractText(lastAssistant) || '(无输出)';
    ctx.agentRegistry.complete(runId, result);
    console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
    return result;
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError' || ac.signal.aborted;
    const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : err?.message || String(err);
    ctx.agentRegistry.fail(runId, errorMsg, isAbort ? 'timeout' : 'error');
    console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);

    if (isAbort) {
      const partial = extractText([...messages].reverse().find((m) => m.role === 'assistant'));
      if (partial) return `[部分结果] ${partial}`;
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  }
}

/** 并行派发：总耗时约等于最慢的那个，而不是三个之和 */
export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  console.log(`\n  ┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    requests.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return { task: req.task, result };
    }),
  );
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}
