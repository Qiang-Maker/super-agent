/**
 * ============================================================================
 * Sub-Agent 数据结构
 * ============================================================================
 *
 * 为什么拆子 Agent（正当理由就三个）：
 *   上下文装不下 —— 调研三个大项目，单 Agent 上下文累积严重；
 *   需要并行提效 —— 三个独立任务同时跑，总耗时等于最慢的那个；
 *   需要隔离     —— 子 Agent 做破坏性操作，不影响主 Agent。
 *
 * 两道保护：maxSpawnDepth 防无限嵌套，maxConcurrent 防一次派太多把资源吃光。
 */

export interface SubAgentConfig {
  /** 最大嵌套深度，默认 1（即子 Agent 不能再派子 Agent） */
  maxSpawnDepth: number;
  /** 最大并发子 Agent 数，默认 3 */
  maxConcurrent: number;
  /** 默认执行超时 ms，默认 60000 */
  defaultTimeout: number;
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60_000,
};

export interface SpawnRequest {
  task: string;
  /** 允许使用的工具名（不传则继承父 Agent 的活跃工具集） */
  tools?: string[];
  timeout?: number;
}

export interface SubAgentRun {
  id: string;
  task: string;
  status: 'running' | 'completed' | 'error' | 'timeout';
  depth: number;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}
