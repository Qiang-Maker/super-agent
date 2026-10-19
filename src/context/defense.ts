/**
 * ============================================================================
 * 三层即时防线（零 LLM 成本）
 * ============================================================================
 *
 * 上一篇的 LLM 摘要压缩有效，但调 LLM 本身就要花时间花钱。而大部分上下文膨胀
 * 根本不需要动用 LLM——读了个 5 万字符的文件，截断到 5000 就够了；
 * 十分钟前的 grep 结果，现在大概率已经没用了。
 *
 * 这三层防线都是纯字符串替换，毫秒级、零成本，在每轮对话前自动执行：
 *   Layer 1 Token 估算 —— 知道自己还剩多少空间（精确基准 + 粗估增量）
 *   Layer 2 动态截断   —— 单条工具结果超窗口 50% 就 Head/Tail 分割；总量超 75% 从最老的开始清
 *   Layer 3 TTL 修剪   —— 5 分钟软修剪（保留头尾）、10 分钟硬清除（只留"发生过"）
 *
 * 配合关系：截断 → TTL → 估算（判断要不要 LLM 压缩）→ Microcompact → Summarization。
 * 从轻到重，能用简单手段解决的绝不上复杂方案。
 */

import type { ModelMessage } from 'ai';
import { textToolResultOutput, toolResultOutputToText } from './tool-result-output.js';

// ---- Layer 1：Token 估算 ---------------------------------------------------

function partChars(part: any): number {
  if (typeof part === 'string') return part.length;
  if (part?.type === 'text') return (part.text ?? '').length;
  if (part?.output) return toolResultOutputToText(part.output).length;
  return JSON.stringify(part ?? '').length;
}

export function countMessageChars(message: ModelMessage): number {
  const content: any = message.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((sum: number, p: any) => sum + partChars(p), 0);
  return JSON.stringify(content ?? '').length;
}

export function countMessagesChars(messages: ModelMessage[]): number {
  return messages.reduce((sum, msg) => sum + countMessageChars(msg), 0);
}

/**
 * 粗略估算消息占用的 token
 *
 * 4 字符 ≈ 1 token 是业界通用启发式，但中文 token 效率更低（1 个汉字约 1.5-2 token），
 * 所以加 1.2 倍安全系数。误差 10-20%，对「要不要触发防御」这种二元判断足够。
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  return Math.ceil((countMessagesChars(messages) / 4) * 1.2);
}

/**
 * 精确基准 + 粗估增量
 *
 * 每次 API 返回时用真实 usage.inputTokens 校准（updateFromAPI），中间新增的
 * user / assistant / tool 消息用 chars/4 粗估补上。防线替换旧工具结果时用
 * replaceMessages 只记字符差，不会丢掉已校准的 system prompt 与工具定义成本。
 *
 * 不每次精确计算的原因：加载 tokenizer 要几百毫秒，且各模型 tokenizer 不同。
 */
export class TokenTracker {
  private lastPreciseCount = 0;
  private pendingChars = 0;

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0;
  }

  addMessage(message: ModelMessage): void {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) this.addMessage(message);
  }

  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil((this.pendingChars / 4) * 1.2);
  }
}

// ---- Layer 2：工具结果动态截断 ---------------------------------------------

export const CONTEXT_WINDOW = 200_000;

export interface TruncateConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATE_CONFIG: TruncateConfig = {
  maxSingleResult: CONTEXT_WINDOW * 0.5 * 2, // 单条不超过窗口 50%（按 2 chars/token 折算）
  contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4, // 总量不超过窗口 75%（按 4 chars/token 折算）
};

/**
 * 动态截断（区别于 Registry 里注册时配置的静态截断 maxResultChars）
 *
 * Pass 1 单条截断：超限的结果做 Head/Tail 60/40 分割，并留下
 *   [truncated: 80000 → 50000 chars] 标记——模型据此知道"这里被截过"，需要时可重读；
 * Pass 2 总量预算：还超就从最老的工具结果开始逐条清空。
 */
export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncateConfig = DEFAULT_TRUNCATE_CONFIG,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  let result: ModelMessage[] = messages.map((msg) => {
    if (msg.role !== 'tool') return msg;
    const parts = (Array.isArray(msg.content) ? msg.content : []) as any[];
    const newContent = parts.map((part: any) => {
      if (!part.output) return part;
      const outputText = toolResultOutputToText(part.output);
      if (outputText.length <= config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const head = outputText.slice(0, Math.floor(maxChars * 0.6));
      const tail = outputText.slice(-Math.floor(maxChars * 0.4));
      return {
        ...part,
        output: textToolResultOutput(
          `${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`,
        ),
      };
    });
    return { ...msg, content: newContent } as ModelMessage;
  });

  let totalChars = countMessagesChars(result);
  if (totalChars > config.contextBudgetChars) {
    for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
      const msg = result[i];
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;

      const parts = msg.content as any[];
      const toolName = parts[0]?.toolName || 'unknown';
      const oldSize = parts.reduce((s, p: any) => s + (p.output ? toolResultOutputToText(p.output).length : 0), 0);

      result[i] = {
        ...msg,
        content: parts.map((p: any) => ({
          ...p,
          output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
        })),
      } as ModelMessage;

      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted };
}

// ---- Layer 3：TTL 修剪 -----------------------------------------------------

export interface PruneConfig {
  softTTLMs: number;
  hardTTLMs: number;
  keepHeadTail: number;
}

const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  softTTLMs: 5 * 60_000,
  hardTTLMs: 10 * 60_000,
  keepHeadTail: 1500,
};

/** 失败经验永不修剪：模型需要记住"这条路走不通"，否则会重复踩坑 */
const ERROR_PATTERN = /error|失败|不存在|denied|timeout/i;

function softPruneMessage(msg: ModelMessage, keep: number): ModelMessage {
  const parts = (Array.isArray(msg.content) ? msg.content : []) as any[];
  return {
    ...msg,
    content: parts.map((part: any) => {
      if (!part.output) return part;
      const text = toolResultOutputToText(part.output);
      if (text.length <= keep * 2) return part;
      const head = text.slice(0, keep);
      const tail = text.slice(-keep);
      return {
        ...part,
        output: textToolResultOutput(`${head}\n\n[soft pruned: ${text.length} chars → ${keep * 2}]\n\n${tail}`),
      };
    }),
  } as ModelMessage;
}

/**
 * 时间衰减修剪
 *
 * 铁律：只修剪 tool 结果，user / assistant 消息永不修剪——用户说过什么、
 * 模型回复过什么永远保留，对话结构完整；模型知道"第 5 轮读过某个文件"，
 * 只是看不到内容了，需要时可以再读一次。
 */
export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): { messages: ModelMessage[]; softPruned: number; hardPruned: number } {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;

  const result = messages.map((msg, idx) => {
    if (msg.role !== 'tool') return msg;

    const age = now - (timestamps.get(idx) || now);
    const parts = (Array.isArray(msg.content) ? msg.content : []) as any[];
    const outputText = parts.map((p: any) => (p.output ? toolResultOutputToText(p.output) : '')).join('');

    // 保留错误经验
    if (ERROR_PATTERN.test(outputText)) return msg;

    if (age >= config.hardTTLMs) {
      hardPruned++;
      return {
        ...msg,
        content: parts.map((part: any) => ({
          ...part,
          output: textToolResultOutput('[tool result expired]'),
        })),
      } as ModelMessage;
    }

    if (age >= config.softTTLMs) {
      softPruned++;
      return softPruneMessage(msg, config.keepHeadTail);
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ---- 三层联合 --------------------------------------------------------------

export interface DefenseResult {
  messages: ModelMessage[];
  truncated: number;
  compacted: number;
  softPruned: number;
  hardPruned: number;
  beforeTokens: number;
  afterTokens: number;
}

/** 每轮对话前跑一遍：截断 → TTL 修剪（都是零 LLM 成本的纯字符串操作） */
export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  const beforeTokens = estimateMessageTokens(messages);

  const t = truncateToolResults(messages);
  const p = ttlPrune(t.messages, timestamps);

  return {
    messages: p.messages,
    truncated: t.truncated,
    compacted: t.compacted,
    softPruned: p.softPruned,
    hardPruned: p.hardPruned,
    beforeTokens,
    afterTokens: estimateMessageTokens(p.messages),
  };
}
