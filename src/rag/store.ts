/**
 * ============================================================================
 * 向量存储（内存版）
 * ============================================================================
 *
 * 生产环境推荐 SQLite + sqlite-vec（向量索引）+ FTS5（全文索引）三表架构：
 *   chunks      主表：原文、向量 JSON、来源、模型名、时间戳
 *   chunks_vec  vec0 虚拟表：向量二进制 + 索引，服务向量搜索
 *   chunks_fts  FTS5 虚拟表：倒排索引 + BM25，服务关键词搜索
 * 三表通过 chunk id 关联，写入时同步，搜索时两路并行查索引、回主表取原文。
 *
 * 本仓库用内存数组实现——搜索逻辑与生产方案完全一样，只是换了存储介质。
 * 要切到 SQLite：pnpm add better-sqlite3 sqlite-vec && pnpm approve-builds，
 * 然后按 sqlite-store.ts 替换本文件（接口一致）。
 *
 * 注意：不同 embedding 模型生成的向量在不同空间里，不能混用——
 * 换模型必须重新生成全部向量（所以 StoredChunk 上带 model 字段）。
 */

import type { Chunk } from './chunker.js';

export interface StoredChunk extends Chunk {
  embedding: number[];
  addedAt: number;
  model?: string;
}

export class VectorStore {
  private items = new Map<string, StoredChunk>();

  add(chunk: Chunk, embedding: number[], model?: string): void {
    this.items.set(chunk.id, { ...chunk, embedding, addedAt: Date.now(), model });
  }

  addBatch(entries: Array<{ chunk: Chunk; embedding: number[] }>, model?: string): void {
    for (const { chunk, embedding } of entries) this.add(chunk, embedding, model);
  }

  getAll(): StoredChunk[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  sources(): string[] {
    return [...new Set(this.getAll().map((c) => c.source))];
  }
}
