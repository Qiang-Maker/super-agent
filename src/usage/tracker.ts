/**
 * ============================================================================
 * 成本追踪（Prompt Cache 的钱花在哪）
 * ============================================================================
 *
 * 【为什么需要它】
 * 上下文大小控住了不等于花钱少了——每轮都要把 system prompt、工具定义、
 * 历史对话重新发一遍并重新付费。Prompt Cache 把请求前缀缓存在服务端，
 * 命中价格只有正常 input 的 10-25%（DeepSeek 甚至 1/100）。
 *
 * 【各家的差异必须抹平】
 * - AI SDK v5 把 cache read 标准化到顶层 cachedInputTokens；
 * - Anthropic 的 cache write（cache_creation_input_tokens）尚未标准化，
 *   要从 providerMetadata.anthropic 里读；
 * - OpenAI 的 cached tokens **已包含在** inputTokens 总数里（要减出来），
 *   Anthropic 的普通输入与 cache read 是分开统计的（不能减）。
 * 所以规范化必须显式带上 provider，不能凭 cacheRead > 0 猜。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ModelPricing {
  /** $/1M tokens（cache miss 价） */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  'claude-sonnet-4-7': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  'gpt-5': { input: 5.0, output: 15.0, cacheWrite: 5.0, cacheRead: 1.25 },
  'deepseek-v3-2': { input: 0.27, output: 1.1, cacheWrite: 0.27, cacheRead: 0.027 },
  'qwen3-6-plus': { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
  'mock-model': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** 价格表里没有的模型用这份兜底，避免记账直接崩掉 */
const FALLBACK_PRICING: ModelPricing = { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 };

export function lookupPricing(model: string): ModelPricing {
  const key = Object.keys(PRICE_TABLE).find((k) => model.toLowerCase().includes(k));
  return key ? PRICE_TABLE[key] : FALLBACK_PRICING;
}

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
}

export interface UsageContext {
  provider?: string;
  providerMetadata?: any;
}

/** 把各家形态各异的 usage 抹平成统一的四类 token */
export function normalizeUsage(usage: any, context: UsageContext = {}): StepUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const cacheRead = Number(usage.cachedInputTokens ?? 0) || 0;

  const cacheWrite =
    Number(
      usage.cacheCreationInputTokens ??
        context.providerMetadata?.anthropic?.cacheCreationInputTokens ??
        0,
    ) || 0;

  const rawInputTokens = Number(usage.inputTokens?.total ?? usage.inputTokens ?? 0) || 0;
  // OpenAI 系：cached tokens 已含在 input 里，要减出来；Anthropic 系：本来就是分开的
  const inputTokens = context.provider?.startsWith('openai')
    ? Math.max(0, rawInputTokens - cacheRead)
    : rawInputTokens;

  return {
    inputTokens,
    outputTokens: Number(usage.outputTokens?.total ?? usage.outputTokens ?? 0) || 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

export function computeCost(model: string, usage: StepUsage): number {
  const p = lookupPricing(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheWriteTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

/** 假如完全没有 cache（全部按 input 全价）该花多少 */
export function computeBaselineCost(model: string, usage: StepUsage): number {
  const p = lookupPricing(model);
  const allInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return (allInput * p.input + usage.outputTokens * p.output) / 1_000_000;
}

export interface UsageTotals extends StepUsage {
  steps: number;
  cost: number;
  baselineCost: number;
  savedCost: number;
  cacheHitRate: number;
}

/**
 * 逐步记账 + 按价格表算钱 + 可选 JSONL 持久化
 *
 * totals() 里的 baselineCost 是"假如没有 cache 该花多少"，
 * 与实际 cost 的差值就是 cache 省下的钱——比相信文档里的"90% off"更实在。
 */
export class UsageTracker {
  private steps: StepRecord[] = [];

  constructor(private filePath?: string) {}

  record(model: string, usage: StepUsage): StepRecord {
    const cost = computeCost(model, usage);
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
    this.steps.push(record);

    if (this.filePath) {
      try {
        // 与 Session 一样的 JSONL：追加写、崩溃安全、打开就能看
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
      } catch {
        /* 记账落盘失败不影响主流程 */
      }
    }

    return record;
  }

  totals(): UsageTotals {
    const totals: UsageTotals = {
      steps: this.steps.length,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      baselineCost: 0,
      savedCost: 0,
      cacheHitRate: 0,
    };

    for (const step of this.steps) {
      totals.inputTokens += step.inputTokens;
      totals.outputTokens += step.outputTokens;
      totals.cacheReadTokens += step.cacheReadTokens;
      totals.cacheWriteTokens += step.cacheWriteTokens;
      totals.cost += step.cost;
      totals.baselineCost += computeBaselineCost(step.model, step);
    }

    totals.savedCost = Math.max(0, totals.baselineCost - totals.cost);
    const cacheable = totals.cacheReadTokens + totals.cacheWriteTokens + totals.inputTokens;
    totals.cacheHitRate = cacheable > 0 ? totals.cacheReadTokens / cacheable : 0;

    return totals;
  }
}
