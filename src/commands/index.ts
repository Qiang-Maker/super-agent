/**
 * ============================================================================
 * 命令系统（dispatcher 责任链）
 * ============================================================================
 *
 * 之前所有快捷命令（sim / defend / status / context / usage / cache / memory）
 * 全用 if/else 串在 index.ts 里，越加越长，每个命令还要闭包捕获一堆外层变量。
 *
 * 现在改成 dispatcher：命令模块只从 CommandContext 里取自己需要的东西，
 * 第一个返回真值的 handler 接管。加新命令 = 加一个模块，不用动主循环。
 */

import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/registry.js';
import type { UsageTracker } from '../usage/tracker.js';
import type { MemoryStore } from '../memory/store.js';

export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  tracker: UsageTracker;
  memoryStore: MemoryStore;
  /** 命令需要模型时用（比如 /memory 相关的批量操作） */
  model: any;
  /** 重建 system prompt（记忆变化后要重算） */
  rebuildSystem: () => string;
}

/**
 * true      = 已处理（同步）
 * false     = 不认识，交给下一个 handler
 * string    = 已处理，但请主循环把这个字符串当成一轮用户输入来跑
 *             （/dream 就靠这个复用完整的 Agent Loop 与防线，而不是另写一套）
 */
export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | string | Promise<boolean | string>;

export function createDispatcher(
  handlers: CommandHandler[],
): (cmd: string, ctx: CommandContext) => Promise<boolean | string> {
  return async (cmd, ctx) => {
    for (const h of handlers) {
      const result = await h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}
