/**
 * ============================================================================
 * 上下文压缩（Microcompact + LLM 摘要）
 * ============================================================================
 *
 * 【上下文里什么最占空间】
 * System Prompt 不能压（压了模型就忘了自己是谁）；能压的是对话历史与工具调用记录，
 * 而工具结果通常是大头——读一个文件 3000 token、grep 一次 2000 token，
 * 50 轮下来工具结果占 60-80% 并不夸张。
 *
 * 【两层策略，先轻后重】
 * Layer 1 Microcompact：不删消息、不改结构，只把「旧的查询类工具结果」换成占位符，
 *   3000 token 直接降到不到 10。零 LLM 成本。
 * Layer 2 Summarization：还不够就调 LLM，把早期对话压成一段结构化摘要，
 *   摘要作为第一条 user 消息注入，并支持与上一次摘要累积合并。
 *
 * 原则：先 Compaction 后 Summarization —— 能不丢结构就不丢。
 */

import { generateText, type ModelMessage } from 'ai';
import { textToolResultOutput } from './tool-result-output.js';

// ---- Layer 1：Microcompact -------------------------------------------------

/** 只清理「查询类」工具的结果——它们的返回值是一次性的 */
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file',
]);

/** 最近 N 个工具结果不动：刚读的文件、刚跑的命令，模型下一步可能还要用 */
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolResultIndices.push(i);
  }

  const toClear = new Set(
    toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)),
  );

  let cleared = 0;
  const result = messages.map((msg, idx) => {
    if (!toClear.has(idx) || msg.role !== 'tool') return msg;

    const parts = (Array.isArray(msg.content) ? msg.content : []) as any[];
    const names = parts.map((p) => p.toolName).filter(Boolean);
    // 只要有一个 part 的工具不在白名单里，整条消息保持原样
    if (names.length === 0 || names.some((n: string) => !CLEARABLE_TOOLS.has(n))) return msg;

    cleared++;
    return {
      ...msg,
      content: parts.map((part) => ({ ...part, output: textToolResultOutput('[tool result cleared]') })),
    } as ModelMessage;
  });

  return { messages: result, cleared };
}

// ---- 触发阈值与估算 --------------------------------------------------------

/**
 * 超过这个估算值才做摘要压缩
 *
 * 演示用 300 方便看到效果；生产环境按上下文窗口的 ~87% 设（200K 窗口约 170K）。
 * 这里默认取 60000，可用环境变量 CONTEXT_TOKEN_THRESHOLD 覆盖（跑 demo 时调小）。
 */
export const CONTEXT_TOKEN_THRESHOLD = Number(process.env.CONTEXT_TOKEN_THRESHOLD ?? 60000);

/** 摘要压缩时保留最近多少条消息 */
const KEEP_RECENT_MESSAGES = 8;

/** 粗略估算消息占用的 token（序列化长度 / 4） */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += JSON.stringify(msg.content ?? '').length;
  }
  return Math.ceil(chars / 4);
}

// ---- Layer 2：LLM 摘要压缩 -------------------------------------------------

/**
 * 压缩 Prompt 的设计要点（参考 Sitor / Manus 的实践）
 * 1. 保什么——给模板让模型填，而不是自由写作：模板越具体，压缩结果越稳定；
 * 2. 不保什么——明确禁止"笼统的概述"，只留具体、可操作的信息；
 * 3. 标识符保护——文件路径 / UUID / 版本号必须原样保留，否则后续对话找不到文件；
 * 4. 字数上限——不设上限模型可能写出比原文还长的"摘要"。
 */
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的
对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

/**
 * 把早期对话压成结构化摘要
 *
 * 三个必须做对的细节：
 * - **对齐到 user 消息边界**：切分点落在 assistant / tool 上，保留列表就会以非 user 开头，
 *   很多 API 直接报错；
 * - **已有摘要合并**：多次压缩时把旧摘要一起喂进去，摘要才是累积的、不会丢最早的信息；
 * - **失败不影响主流程**：网络抖动 / 模型超时都只返回原始消息，不做压缩。
 */
export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD) {
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }

  // 保留最近 N 条，再往前对齐到最近的 user 消息边界
  let alignedIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
    alignedIdx--;
  }
  if (alignedIdx === 0) {
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }

  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);
  const conversationText = toCompress
    .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  const userPrompt = existingSummary
    ? `## 已有摘要\n\n${existingSummary}\n\n## 新对话\n\n${conversationText}`
    : conversationText;

  try {
    const { text: summary } = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束]`,
    };

    return {
      messages: [summaryMessage, ...toKeep],
      summary,
      compressedCount: toCompress.length,
    };
  } catch (err: any) {
    // 压缩失败不能影响 Agent 正常工作
    console.warn(`  [压缩失败] ${err?.message || err}，保留原始消息`);
    return { messages, summary: existingSummary || '', compressedCount: 0 };
  }
}

/** 两层串起来跑一遍：先 Microcompact，再看是否需要 Summarization */
export async function compact(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<{ messages: ModelMessage[]; summary: string; cleared: number; compressedCount: number }> {
  const mc = microcompact(messages);
  const result = await summarize(model, mc.messages, existingSummary);
  return {
    messages: result.messages,
    summary: result.summary,
    cleared: mc.cleared,
    compressedCount: result.compressedCount,
  };
}
