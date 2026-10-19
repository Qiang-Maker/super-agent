/**
 * ============================================================================
 * 文档分块（Step 1）
 * ============================================================================
 *
 * 分块策略直接影响检索质量。PremAI 2026 的基准显示：递归分块（按段落边界切）
 * 准确率 69%，而语义分块（用 embedding 判断主题边界）反而只有 54%——
 * 因为语义分块的误差会累积，一个切分点判断错了后面全跟着错。
 *
 * 所以这里用**递归段落分块**：先按双换行切段落，单段太长再按句子切。
 * 目标每块约 256 token（演示值，生产通常 512）。
 */

export interface Chunk {
  id: string;
  text: string;
  /** 来源文件 */
  source: string;
  /** 在文档中的位置序号 */
  index: number;
  tokenEstimate: number;
}

const TARGET_TOKENS = 256;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}

/** 单段超长时按句子边界继续切 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function chunkDocument(source: string, text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let current = '';
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // 缓冲区 + 新段落超目标大小 → 先把缓冲区落成一块
    if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
      chunks.push(makeChunk(source, current.trim(), idx++));
      current = '';
    }

    if (trimmed.length > TARGET_CHARS) {
      // 单段就超长：按句子累积到接近目标大小
      let buffer = '';
      for (const sentence of splitSentences(trimmed)) {
        if (buffer.length + sentence.length > TARGET_CHARS && buffer.length > 0) {
          chunks.push(makeChunk(source, buffer.trim(), idx++));
          buffer = '';
        }
        buffer += sentence;
      }
      if (buffer.trim()) {
        chunks.push(makeChunk(source, buffer.trim(), idx++));
      }
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++));
  }

  return chunks;
}
