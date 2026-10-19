/**
 * ============================================================================
 * CronService（调度引擎核心）
 * ============================================================================
 *
 * 任务生命周期：加载 → 调度 → 执行 → 失败处理 → 持久化。
 *
 * 四个值得注意的设计：
 * 1. **执行器注入**：CronService 不直接依赖 Agent Loop，通过 setExecutor 注入——
 *    可独立测试，也方便换成别的执行方式（比如 HTTP 调用 Agent）；
 * 2. **连续失败自动禁用**：连续失败 N 次（默认 3）后 enabled=false，避免错误无限循环；
 * 3. **一次性任务执行后自动清理**；
 * 4. **persist 只存 runtime 来源**：config 来源的任务由配置文件管理，不被覆盖。
 *
 * 常见写法里 `getNextCronTime(parsed.cronFields!)` 是笔误（字段名不存在），
 * 这里用解析器返回的 cronInstance。
 */

import type { CronJobConfig, CronJobState, RunLog, JobPayload } from './types.js';
import { parseSchedule, getNextCronTime } from './parser.js';
import { CronStore } from './store.js';

const QUOTES = [
  '"知之为知之，不知为不知，是知也。" —— 孔子',
  '"学而不思则罔，思而不学则殆。" —— 孔子',
  '"千里之行，始于足下。" —— 老子',
  '"天行健，君子以自强不息。" —— 《周易》',
  '"不积跬步，无以至千里。" —— 荀子',
  '"Stay hungry, stay foolish." —— Steve Jobs',
  '"The best way to predict the future is to invent it." —— Alan Kay',
  '"Talk is cheap. Show me the code." —— Linus Torvalds',
  '"Simplicity is the ultimate sophistication." —— Leonardo da Vinci',
  '"First, solve the problem. Then, write the code." —— John Johnson',
];

export interface CronExecutor {
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>;
  notify?: (message: string) => void;
}

export class CronService {
  private jobs = new Map<string, CronJobState>();
  private store: CronStore;
  private executor?: CronExecutor;
  private running = false;

  constructor(baseDir = '.') {
    this.store = new CronStore(baseDir);
    this.store.init();
  }

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  load(): void {
    for (const config of this.store.loadJobs()) {
      if (config.enabled) {
        this.jobs.set(config.id, {
          config,
          timerId: null,
          consecutiveFailures: 0,
          running: false,
        });
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const state of this.jobs.values()) {
      if (state.config.enabled) this.scheduleJob(state);
    }
  }

  stop(): void {
    this.running = false;
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
    }
  }

  add(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) throw new Error(`任务 ${config.id} 已存在`);
    const state: CronJobState = {
      config,
      timerId: null,
      consecutiveFailures: 0,
      running: false,
    };
    this.jobs.set(config.id, state);
    this.persist();
    if (this.running && config.enabled) this.scheduleJob(state);
  }

  remove(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    if (state.timerId) clearTimeout(state.timerId);
    this.jobs.delete(id);
    this.persist();
    return true;
  }

  enable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = true;
    state.consecutiveFailures = 0;
    this.persist();
    if (this.running) this.scheduleJob(state);
    return true;
  }

  disable(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state) return false;
    state.config.enabled = false;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    this.persist();
    return true;
  }

  list(): Array<{ config: CronJobConfig; status: string; lastRun?: RunLog }> {
    return Array.from(this.jobs.values()).map((state) => ({
      config: state.config,
      status: state.running
        ? 'running'
        : !state.config.enabled
          ? 'disabled'
          : state.timerId
            ? 'scheduled'
            : 'idle',
      lastRun: state.lastRun,
    }));
  }

  async runNow(id: string): Promise<string> {
    const state = this.jobs.get(id);
    if (!state) return `任务 ${id} 不存在`;
    return this.executeJob(state);
  }

  getRecentLogs(jobId?: string, limit?: number): RunLog[] {
    return this.store.getRecentLogs(jobId, limit);
  }

  private scheduleJob(state: CronJobState): void {
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }

    try {
      const parsed = parseSchedule(state.config.schedule);
      let delayMs: number;

      switch (parsed.type) {
        case 'interval':
          delayMs = parsed.intervalMs!;
          break;
        case 'once': {
          const diff = parsed.onceAt!.getTime() - Date.now();
          if (diff <= 0) {
            void this.executeJob(state);
            return;
          }
          delayMs = diff;
          break;
        }
        default:
          delayMs = getNextCronTime(parsed.cronInstance!);
          break;
      }

      state.timerId = setTimeout(async () => {
        await this.executeJob(state);
        if (parsed.type === 'once') {
          this.remove(state.config.id);
        } else if (state.config.enabled && this.running) {
          this.scheduleJob(state);
        }
      }, delayMs);
    } catch (err: any) {
      console.log(`  [cron] ✗ 调度失败 ${state.config.id}: ${err?.message || err}`);
    }
  }

  private async executeJob(state: CronJobState): Promise<string> {
    if (state.running) return '任务正在执行中';
    state.running = true;

    const startedAt = new Date().toISOString();
    let output = '';
    let status: RunLog['status'] = 'success';
    let error: string | undefined;

    try {
      const timeout = state.config.timeout || 60_000;
      output = await this.runPayload(state.config.payload, timeout);
      state.consecutiveFailures = 0;
    } catch (err: any) {
      status = String(err?.message).includes('timeout') ? 'timeout' : 'error';
      error = err?.message || String(err);
      output = `执行失败: ${error}`;
      state.consecutiveFailures++;

      const maxRetries = state.config.maxRetries ?? 3;
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false;
        console.log(`  [cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`);
        this.persist();
      }
    } finally {
      state.running = false;
    }

    const log: RunLog = {
      jobId: state.config.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      output: output.slice(0, 1000),
      error,
    };
    state.lastRun = log;
    this.store.appendLog(log);

    if (this.executor?.notify) {
      const icon = status === 'success' ? '✓' : '✗';
      this.executor.notify(`[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`);
    }

    return output;
  }

  private async runPayload(payload: JobPayload, timeout: number): Promise<string> {
    if (!this.executor) return '[cron] 未设置执行器，无法运行任务';

    if (payload.type === 'agent') {
      return this.executor.runAgentPrompt(payload.prompt, timeout);
    }
    if (payload.handler === 'random-quote') {
      // handler 类型不走模型、不消耗 token，适合不需要 LLM 参与的轻量任务
      return QUOTES[Math.floor(Math.random() * QUOTES.length)];
    }
    return `[handler] ${payload.handler} — handler 类型需要通过插件注册`;
  }

  private persist(): void {
    const runtimeJobs = Array.from(this.jobs.values())
      .filter((s) => s.config.source === 'runtime')
      .map((s) => s.config);
    const configJobs = this.store.loadJobs().filter((j) => j.source === 'config');
    this.store.saveJobs([...configJobs, ...runtimeJobs]);
  }
}
