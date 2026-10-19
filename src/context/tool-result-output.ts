/**
 * ============================================================================
 * 工具结果的编码与读取
 * ============================================================================
 *
 * AI SDK 5 的 ModelMessage 不再允许把工具结果写成裸字符串，而是带 type 的判别联合
 * （text / error-text / json / error-json / content）。
 *
 * 这里集中处理「写入」与「读回」两件事，后面的压缩、截断、TTL 清理都复用它——
 * 否则每处都写一遍 switch，改一个分支要改一圈。
 */

import type { ToolResultPart } from 'ai';

type ToolResultOutput = ToolResultPart['output'];

/** 把纯文本包装成合规的工具结果 output */
export function textToolResultOutput(value: string): ToolResultOutput {
  return { type: 'text', value };
}

/** 把任意形态的工具结果 output 读回纯文本 */
export function toolResultOutputToText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value);
    case 'content':
      return output.value
        .map((part) =>
          part.type === 'text' ? part.text : `[media: ${(part as any).mediaType ?? part.type}]`,
        )
        .join('\n');
    default:
      return '';
  }
}
