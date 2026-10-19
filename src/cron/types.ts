/**
 * ============================================================================
 * 定时任务数据结构
 * ============================================================================
 *
 * 从"用户发消息才响应"到"自己按时做事"——Cron 是 Agent 从工具变助手的关键一步。
 *
 * source 字段区分任务来源：config 写在配置文件里（模型删不掉），
 * runtime 是 Agent 运行时创建的（可增删）。你肯定不希望模型把关键配置级任务删了。
 */

export type ScheduleType = 'cron' | 'interval' | 'once';

export interface CronJobConfig {
  /** 任务唯一标识 */
  id: string;
  name: string;
  description?: string;
  /** 调度表达式：cron 五字段 | "every 30s" | ISO 时间戳 */
  schedule: string;
  scheduleType: ScheduleType;
  enabled: boolean;
  payload: JobPayload;
  /** 单次执行超时，单位 ms，默认 60000 */
  timeout?: number;
  /** 连续失败多少次后自动禁用，默认 3 */
  maxRetries?: number;
  /** config 不可删，runtime 可增删 */
  source: 'config' | 'runtime';
}

export type JobPayload =
  | { type: 'agent'; prompt: string }
  | { type: 'handler'; handler: string };

export interface RunLog {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'error' | 'timeout';
  /** 执行输出（截断到 1000 字符） */
  output?: string;
  error?: string;
}

export interface CronJobState {
  config: CronJobConfig;
  timerId: ReturnType<typeof setTimeout> | null;
  lastRun?: RunLog;
  consecutiveFailures: number;
  running: boolean;
}
