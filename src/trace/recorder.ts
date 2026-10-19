/**
 * ============================================================================
 * 本地 Trace 记录器
 * ============================================================================
 *
 * 【Trace 和 Session 日志不是一回事】
 *   Session：服务用户继续对话，核心是 user/assistant/tool 消息，一个会话持续追加
 *   Trace  ：服务开发者排查与复盘，核心是每个 Step 的完整输入/输出/耗时/usage，
 *            一次任务一个文件，通常按天清理
 *
 * 【最容易漏掉的字段是 Step 开始前的上下文快照】
 * 只保存模型输出不够。Step 4 回答错了，真正原因可能是它收到的上下文里早期工具结果
 * 已被压缩掉、或一条错误信息被当成了可靠事实——没有输入快照，你只能看到结果错了，
 * 看不到它是在什么信息条件下做的决定。
 *
 * 事件类型：trace_started / step_started / step_completed / step_attempt_failed / trace_finished
 *
 * 【为什么 JSONL】边跑边写（不用整条 Trace 驻留内存）、中断可恢复（进程在第 8 步崩了，
 * 前 7 步仍是合法记录）、容易迁移（上传对象存储或逐行处理都方便）。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelMessage } from 'ai';
import type { StepUsage } from '../usage/tracker.js';

export type TraceStatus = 'completed' | 'failed' | 'cancelled';

interface TraceOptions {
  directory?: string;
  sessionId: string;
  model: string;
}

interface StepStartedInput {
  step: number;
  system: string;
  messages: ModelMessage[];
}

interface StepCompletedInput {
  step: number;
  text: string;
  outputMessages: ModelMessage[];
  usage: StepUsage;
}

/** 命中这些字段名的值会被脱敏——上下文里可能出现 API Key / Token / 密码 */
const SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey),
      ]),
    );
  }
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'default';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly startedAt = Date.now();
  private readonly stepStartedAt = new Map<number, number>();
  private writeFailed = false;

  private constructor(private readonly options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.traceId = `${safeName(options.sessionId)}-${stamp}`;
    this.filePath = join(options.directory ?? '.traces', `${this.traceId}.jsonl`);
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options);
    await mkdir(dirname(recorder.filePath), { recursive: true });
    await recorder.write({
      type: 'trace_started',
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    });
    return recorder;
  }

  /** 必须在调用模型之前记录——等返回后再存，messages 已被追加，就不是"模型当时看到的上下文"了 */
  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt.set(input.step, Date.now());
    await this.write({
      type: 'step_started',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: sanitize({ system: input.system, messages: input.messages }),
    });
  }

  async recordAttemptError(step: number, attempt: number, error: unknown): Promise<void> {
    await this.write({
      type: 'step_attempt_failed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    });
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
    await this.write({
      type: 'step_completed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: Date.now() - startedAt,
      output: sanitize({ text: input.text, messages: input.outputMessages }),
      usage: input.usage,
    });
  }

  /** trace_finished 很重要：没有它就无法判断这条 Trace 是完整结束还是进程中途退出 */
  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: 'trace_finished',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    });
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return;
    try {
      await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
      // Trace 写失败不能影响 Agent 主任务
      this.writeFailed = true;
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
    }
  }
}

/** 最小复盘：逐行读事件，只提取 Step、耗时、token 和工具名 */
export async function inspectTrace(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  const out: string[] = [];
  let traceId = '';
  let status = 'unknown';
  let totalTokens = 0;
  let durationMs = 0;

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'trace_started') {
      traceId = event.traceId;
      out.push(`Trace ${traceId}`);
    } else if (event.type === 'step_started') {
      const count = event.context?.messages?.length ?? 0;
      out.push(`  Step ${event.step}: context ${count} messages`);
    } else if (event.type === 'step_completed') {
      const usage = event.usage || {};
      const tokens =
        (usage.inputTokens || 0) +
        (usage.outputTokens || 0) +
        (usage.cacheReadTokens || 0) +
        (usage.cacheWriteTokens || 0);
      totalTokens += tokens;

      const tools = new Set<string>();
      for (const msg of event.output?.messages || []) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'tool-call' && part.toolName) tools.add(part.toolName);
          }
        }
      }
      out.push(
        `    completed in ${event.durationMs}ms · ${tokens} tokens` +
          (tools.size > 0 ? ` · tools: ${[...tools].join(', ')}` : ''),
      );
    } else if (event.type === 'step_attempt_failed') {
      out.push(`    attempt ${event.attempt} failed: ${event.error}`);
    } else if (event.type === 'trace_finished') {
      status = event.status;
      durationMs = event.durationMs;
      if (event.error) out.push(`  Error: ${event.error}`);
    }
  }

  out.push(`  Status: ${status} (${durationMs}ms · ${totalTokens} tokens total)`);
  return out.join('\n');
}
