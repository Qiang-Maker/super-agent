/**
 * ============================================================================
 * spawn_agent 工具
 * ============================================================================
 *
 * 模型可以用 task 派一个子 Agent，也可以用 tasks 一次派多个并行执行。
 *
 * 【模型不一定主动用】如果同时给了 web_search 和 spawn_agent，模型可能倾向自己搜
 * （单 Agent 也能完成，只是效率低）。function calling 本身就是最自然的意图检测——
 * 所以最有效的做法是把 description 写清楚（明确适用场景）+ 在 system prompt 里
 * 加一句引导。两层加上去，主流模型命中率已经很高。
 */

import type { ToolDefinition } from './registry.js';
import type { SubAgentRegistry } from '../agents/registry.js';
import { spawnAgent, spawnParallel, type SpawnContext } from '../agents/spawn.js';

export function createSpawnTool(
  agentRegistry: SubAgentRegistry,
  getSpawnCtx: () => SpawnContext,
): ToolDefinition {
  return {
    name: 'spawn_agent',
    description:
      '派一个子 Agent 去执行任务。子 Agent 有独立的上下文窗口，完成后只返回结果摘要，' +
      '适合多项独立调研、并行对比、或会产生大量中间信息的任务（父上下文保持干净）。' +
      '支持同时派多个子 Agent 并行执行。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '单个任务描述（与 tasks 二选一）' },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '多个任务描述，并行执行（与 task 二选一）',
        },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: true,
    execute: async (input: { task?: string; tasks?: string[] }) => {
      const ctx = getSpawnCtx();

      if (input.tasks && input.tasks.length > 0) {
        const results = await spawnParallel(
          input.tasks.map((task) => ({ task })),
          ctx,
        );
        return results
          .map((r, i) => `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`)
          .join('\n\n---\n\n');
      }

      if (input.task) return spawnAgent({ task: input.task }, ctx);

      return '需要提供 task 或 tasks 参数';
    },
  };
}
