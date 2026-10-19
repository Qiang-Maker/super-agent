/**
 * ============================================================================
 * RAG 工具（Step 4）
 * ============================================================================
 *
 * 两个工具：
 * - rag_ingest：把文档分块、向量化后存进知识库
 * - rag_search：混合检索（向量 70% + 关键词 30%），返回最相关的片段
 *
 * rag_search 的结果刻意带上来源与综合分——Agent 能看到信息从哪来，
 * 便于判断可信度；片段截断到 500 字符控制上下文预算（与"入口管理"一脉相承）。
 */

import fs from 'node:fs';
import type { ToolDefinition } from './registry.js';
import type { VectorStore } from '../rag/store.js';
import type { EmbeddingFn } from '../rag/embedder.js';
import { embed } from '../rag/embedder.js';
import { chunkDocument } from '../rag/chunker.js';
import { hybridSearch } from '../rag/search.js';

export function createRagTools(vectorStore: VectorStore, embedFn: EmbeddingFn): ToolDefinition[] {
  const ragIngestTool: ToolDefinition = {
    name: 'rag_ingest',
    description: '将文档导入知识库。内容会被分块、向量化后存储。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档路径（相对工作目录）' } },
      required: ['path'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async ({ path }: { path: string }) => {
      try {
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(
          embedFn,
          chunks.map((c) => c.text),
        );
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
        return `已导入 ${chunks.length} 个文档片段。知识库共 ${vectorStore.size()} 个片段。`;
      } catch (err: any) {
        return `导入失败: ${err?.message || String(err)}`;
      }
    },
  };

  const ragSearchTool: ToolDefinition = {
    name: 'rag_search',
    description: '从知识库中搜索相关信息。返回最相关的文档片段。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        top_k: { type: 'number', description: '返回结果数量（默认 5）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, top_k }: { query: string; top_k?: number }) => {
      if (vectorStore.size() === 0) return '知识库为空，请先导入文档。';
      const results = await hybridSearch(vectorStore, embedFn, query, top_k || 5);
      if (results.length === 0) return `没有找到与 "${query}" 相关的片段。`;
      return results
        .map(
          (r, i) =>
            `[${i + 1}] 来源: ${r.chunk.source} | 分数: ${r.score.toFixed(3)}\n${r.chunk.text.slice(0, 500)}`,
        )
        .join('\n\n---\n\n');
    },
  };

  return [ragIngestTool, ragSearchTool];
}
