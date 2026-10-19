/**
 * ============================================================================
 * 模型降级链（ModelChain）
 * ============================================================================
 *
 * 【解决什么问题】免费额度是按模型给的，而且会到期/用尽——某个模型突然不能用时，
 * 不该让整个 Agent 停摆。把候选模型排成一条链：当前这个报"额度用尽/不存在/无权限"
 * 这类**换一个模型就能解决**的错误时，自动切到下一个重试本步。
 *
 * 【和重试的分工】指数退避（retry.ts）处理"同一个模型再试一次能好"的问题（网络抖动、
 * 429 限流）；降级链处理"这个模型不行，换一个"的问题。两者互不干扰：
 * 换模型不消耗重试次数，退避重试也不会乱换模型。
 *
 * 【顺序】按到期时间近的排在前面（先用快到期的额度），由 config.model.chain 决定顺序。
 */

import type { LanguageModel } from 'ai';

export interface ModelCandidate {
  name: string;
  model: LanguageModel;
}

/** 一次降级：从哪个模型切到了哪个 */
export interface ChainSwitch {
  from: string;
  to: string;
}

/** 换一个模型就能解决的错误（额度用尽 / 无权限 / 模型不存在 / key 无效） */
const UNAVAILABLE_PATTERNS: RegExp[] = [
  /free quota exhausted/i,
  /freetieronly/i,
  /allocationquota/i,
  /insufficient/i,
  /balance/i,
  /access denied/i,
  /does not exist/i,
  /model_not_found/i,
  /invalid_api_key/i,
];

/** 安全序列化：对象里有循环引用时返回空串，绝不让判断本身抛异常 */
function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

/**
 * 判断"换一个模型就能解决"
 *
 * 注意不能只看 `error.message`：AI SDK 的 APICallError 带 Symbol 标记、未必是
 * 标准 Error 实例，真正的信息（HTTP 状态、provider 的错误码）藏在
 * responseBody / data 里——所以这里把几个可能的位置都拼起来一起匹配。
 */
export function isModelUnavailableError(error: unknown): boolean {
  const e = error as any;
  // 有些地方传进来的是 { error: 真正的错误 } 包装（AI SDK 的 onError 就是这样）
  const layers = [error, e?.error, e?.cause];
  const text = layers
    .flatMap((layer: any) => [
      typeof layer?.message === 'string' ? layer.message : '',
      safeJson(layer?.responseBody),
      safeJson(layer?.data),
      safeJson(layer?.error),
      String(layer ?? ''),
    ])
    .join(' ');
  return UNAVAILABLE_PATTERNS.some((re) => re.test(text));
}

export class ModelChain {
  private index = 0;
  private switches: ChainSwitch[] = [];

  constructor(private readonly candidates: ModelCandidate[]) {
    if (candidates.length === 0) throw new Error('ModelChain 至少需要一个候选模型');
  }

  get current(): ModelCandidate {
    return this.candidates[this.index];
  }

  get currentName(): string {
    return this.current.name;
  }

  get size(): number {
    return this.candidates.length;
  }

  /**
   * 本轮降级了几次
   *
   * 降级链是**花钱路径**：候选里混进收费模型时，降级就等于悄悄开始计费。
   * 所以这个数不能只躺在日志里——要能在 /usage 里看到。
   */
  get degradationCount(): number {
    return this.switches.length;
  }

  /** 本轮降级的完整路径，如 "gemini-3.8-flash-high → qwen3.7-flash → kimi-k3" */
  get degradationPath(): string {
    if (this.switches.length === 0) return '';
    return [this.switches[0].from, ...this.switches.map((s) => s.to)].join(' → ');
  }

  /** 切到下一个候选；已经是最后一个则返回 false（调用方应当把错误抛出去） */
  advance(): boolean {
    if (this.index >= this.candidates.length - 1) return false;
    const from = this.currentName;
    this.index++;
    this.switches.push({ from, to: this.currentName });
    return true;
  }

  /**
   * 回到第一个候选
   *
   * 每轮任务开始时调用：上一次降级可能只是临时故障（额度刷新、账号恢复），
   * 新一轮应该重新从主模型试起，而不是一直卡在链尾。
   * 降级记录一并清零，所以 degradationCount 读到的始终是「本轮」的。
   */
  reset(): void {
    this.index = 0;
    this.switches = [];
  }

  /** 已用过的候选（用于启动时打印链） */
  names(): string[] {
    return this.candidates.map((c) => c.name);
  }
}
