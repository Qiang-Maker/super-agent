/**
 * ============================================================================
 * 混合检索（Step 3，RAG 最关键的一步）
 * ============================================================================
 *
 * 只用向量搜索：能找到"上线出了问题"（语义近），但找不到含 `pm2 stop` 的片段
 * （语义远但关键词命中）。只用关键词搜索：又会漏掉语义相关的内容。
 *
 * 混合检索 = 两条路径各取所长再合并排序。OpenClaw 的默认配比是
 * **70% 向量 + 30% 关键词**。
 *
 * 【两个容易做错的细节】
 * 1. CANDIDATE_MULTIPLIER = 4：最终要 5 条，就各取 20 条候选。因为两条路径的
 *    top-5 可能是完全不同的集合，各取 5 再合并会把某条路径里排第 6 的好结果截掉。
 * 2. 归一化：向量分是 cosine（0-1），BM25 范围不固定（可能负数、可能几十）。
 *    不归一化直接加权，关键词分会直接压过向量分。这里对两边都做 min-max——
 *    注意不要用 sigmoid：BM25 已经转成 [0,1) 区间后，再过 sigmoid 只会压到
 *    0.5-0.7 的窄区间，关键词路径等于"失声"。
 *
 * 【MMR 去重】前几名常常是同一话题的不同段落。MMR 在选结果时兼顾相关性与多样性，
 * 相似度用 Jaccard（词集交集/并集）而不是再算一次 embedding cosine——零 API 成本。
 */

import type { StoredChunk } from './store.js';
import type { EmbeddingFn } from './embedder.js';
import { cosineSimilarity, embed } from './embedder.js';

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const CANDIDATE_MULTIPLIER = 4;
const MMR_LAMBDA = 0.7; // 70% 看相关性，30% 看多样性

/** 中英文混排分词：英文/数字按词，中文按单字（够用，且零依赖） */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]/g)) {
    terms.push(m[0]);
  }
  return terms;
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map((s) => (s - min) / range);
}

/**
 * BM25（k1=1.5, b=0.75），返回每个文档的分数
 *
 * 需要整个语料库来算 IDF——这也是为什么它在 search 里而不是 chunk 上。
 */
export function bm25Scores(terms: string[], docs: string[]): number[] {
  const k1 = 1.5;
  const b = 0.75;
  const tokenized = docs.map(tokenize);
  const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / (tokenized.length || 1);
  const df = new Map<string, number>();
  for (const doc of tokenized) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  }

  const N = docs.length || 1;
  return tokenized.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) || 0;
      if (f === 0) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.length) / (avgLen || 1)));
    }
    return score;
  });
}

/**
 * BM25 原始分转成 [0,1) 的相似度
 *
 * 注意：`score < 0 ? -score/(1-score) : 1/(1+score)` 这个公式是给 SQLite FTS5 的
 * bm25() 设计的（它返回负分，越负越相关）。我们这里是自己算的 BM25——
 * 0 分表示完全没命中、正分越大越相关，所以正确映射是 0 → 0、越大越接近 1。
 * 照搬这个公式会把"完全没命中"映射成 1，等于把最不相关的文档排到最前。
 */
function bm25ToSimilarity(score: number): number {
  return score <= 0 ? 0 : score / (1 + score);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** MMR：兼顾相关性与多样性，避免返回一堆高度重复的段落 */
export function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  if (results.length === 0) return [];
  const selected: SearchResult[] = [results[0]];
  const remaining = results.slice(1);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim = Math.max(
        ...selected.map((s) => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
      );
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

export async function hybridSearch(
  store: { getAll(): StoredChunk[] },
  embedFn: EmbeddingFn,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  const all = store.getAll();
  if (all.length === 0) return [];
  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

  // 路径 1：向量搜索
  const [queryVec] = await embed(embedFn, [query]);
  const vectorResults = all
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 路径 2：关键词搜索（BM25）
  const queryTerms = tokenize(query);
  const keywordScores = bm25Scores(
    queryTerms,
    all.map((c) => c.text),
  );
  const keywordResults = all
    .map((chunk, i) => ({ chunk, score: bm25ToSimilarity(keywordScores[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount);

  // 归一化 + 加权合并：两条路径都认可的文档得分最高
  const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
  const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

  const candidates = new Map<string, SearchResult>();
  vectorResults.forEach((r, i) => {
    candidates.set(r.chunk.id, {
      chunk: r.chunk,
      score: vecScores[i] * VECTOR_WEIGHT,
      vectorScore: vecScores[i],
      keywordScore: 0,
    });
  });
  keywordResults.forEach((r, i) => {
    const existing = candidates.get(r.chunk.id);
    if (existing) {
      existing.keywordScore = kwScores[i];
      existing.score += kwScores[i] * KEYWORD_WEIGHT;
    } else {
      candidates.set(r.chunk.id, {
        chunk: r.chunk,
        score: kwScores[i] * KEYWORD_WEIGHT,
        vectorScore: 0,
        keywordScore: kwScores[i],
      });
    }
  });

  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  return mmrSelect(sorted, topK);
}
