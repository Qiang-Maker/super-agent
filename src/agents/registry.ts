/**
 * ============================================================================
 * SubAgentRegistry
 * ============================================================================
 *
 * 记录谁在跑、跑到哪了、结果是什么；每次 spawn 前先问它"还能不能派"。
 * canSpawn 的两道检查（深度 / 并发）是 Sub-Agent 系统最基本的安全保障。
 * Claude Code 内部也有类似限制，只不过它靠 token 预算自然收敛——
 * 子 Agent 分到的预算有限，用完就得收工。
 */

import type { SubAgentRun, SubAgentConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class SubAgentRegistry {
  private runs = new Map<string, SubAgentRun>();
  private config: SubAgentConfig;
  private idCounter = 0;

  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generateId(): string {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
  }

  canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return { ok: false, reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}` };
    }
    if (this.getActiveRuns().length >= this.config.maxConcurrent) {
      return {
        ok: false,
        reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成`,
      };
    }
    return { ok: true };
  }

  register(run: SubAgentRun): void {
    this.runs.set(run.id, run);
  }

  complete(id: string, result: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = 'completed';
    run.result = result;
    run.finishedAt = new Date().toISOString();
  }

  fail(id: string, error: string, status: 'error' | 'timeout' = 'error'): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = status;
    run.error = error;
    run.finishedAt = new Date().toISOString();
  }

  get(id: string): SubAgentRun | undefined {
    return this.runs.get(id);
  }

  getActiveRuns(): SubAgentRun[] {
    return Array.from(this.runs.values()).filter((r) => r.status === 'running');
  }

  getAllRuns(): SubAgentRun[] {
    return Array.from(this.runs.values());
  }

  getConfig(): SubAgentConfig {
    return this.config;
  }
}
