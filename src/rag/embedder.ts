/**
 * ============================================================================
 * Embedding（Step 2）
 * ============================================================================
 *
 * 一段文本进去、一串浮点数出来，这串数字编码了语义——意思相近的文本，
 * 向量夹角（cosine similarity）更小。
 *
 * 两个实现：
 * - createMockEmbedder：确定性哈希生成假向量（128 维），没配 Key 也能把管线跑通；
 * - createDashScopeEmbedder：调阿里云生成真实向量（1024 维）。
 *
 * Embedding 缓存是容易忽略但很重要的优化：同一段文本 + 同一模型，向量是确定性的，
 * 重复调 API 纯属浪费钱。导入大文档时若有重复段落（比如反复出现的免责声明），
 * 缓存能直接省掉这些调用。
 */

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

const EMBED_DIM = 128;

/** 确定性哈希假向量：同一段文本永远得到同一个向量，语义无关但可用于跑通管线 */
function mockEmbed(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % EMBED_DIM] += ((code * 2654435761) % 1000) / 1000;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function createMockEmbedder(): EmbeddingFn {
  return async (texts: string[]) => texts.map(mockEmbed);
}

/**
 * 阿里云向量化
 *
 * 和聊天模型一样，embedding 模型也各有各的免费额度、也会到期/欠费——所以这里传一串
 * 候选模型，**第一个可用的会被记住**，后面的只在它失败时兜底。
 * 注意：不同 embedding 模型的向量不在同一个空间里，一旦选定就不能中途换
 * （换模型必须重新导入全部文档），所以这里只在"完全拿不到向量"时才切。
 *
 * 【候选里只放有免费额度的模型】按到期时间由近到远（先用快到期的）。
 * 早期默认里带过 text-embedding-v3——它**没有免费额度**，一旦前一个候选不可用，
 * 兜底就会悄悄转成按量付费。这类"降级到收费模型"是账单失控的典型来源。
 */
export function createDashScopeEmbedder(
  apiKey: string,
  models: string[] = ['qwen3.7-text-embedding', 'qwen3.7-text-embedding-flash'],
): EmbeddingFn {
  let chosen: string | null = null;

  return async (texts: string[]) => {
    const candidates = chosen ? [chosen] : models;
    let lastError: unknown;

    for (const model of candidates) {
      try {
        const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          // 不传 dimensions：用模型原生维度（1024）。
          // 早期这里传了 dimensions: 128，而 DashScope 只接受
          // [256, 512, 768, 1024, 1536, 2048, 2560]——128 会被直接拒掉，
          // 于是云端调用每次都失败、静默降级成 mock 向量，检索质量悄悄变差。
          body: JSON.stringify({ model, input: texts }),
        });
        const data = (await resp.json()) as any;
        if (!data?.data) {
          throw new Error(`${model}: ${JSON.stringify(data).slice(0, 160)}`);
        }
        if (chosen !== model) {
          chosen = model;
          console.log(`  [embedding] 使用模型: ${model}`);
        }
        return data.data.map((d: any) => d.embedding as number[]);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/**
 * 按环境变量挑一个 embedder：有 DASHSCOPE_API_KEY 用真实向量，否则用 mock。
 *
 * EMBEDDING_MODELS 可用逗号分隔覆盖候选顺序（默认按免费额度到期时间由近到远：
 * qwen3.7-text-embedding 到期 2026-10-13 → qwen3.7-text-embedding-flash 到期 2026-11-30）。
 */
export function pickEmbedder(): { embedFn: EmbeddingFn; mode: 'dashscope' | 'mock' } {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) return { embedFn: createMockEmbedder(), mode: 'mock' };

  const models = (process.env.EMBEDDING_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    embedFn: createDashScopeEmbedder(key, models.length > 0 ? models : undefined),
    mode: 'dashscope',
  };
}

const embedCache = new Map<string, number[]>();

/** 先查缓存，只对没见过的文本调 API */
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  const uncached: { idx: number; text: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text: texts[i] });
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text));
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i];
      embedCache.set(uncached[i].text, vectors[i]);
    }
  }

  return results;
}

/** 余弦相似度：两个向量方向越接近，值越接近 1（20 行，不依赖任何库） */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
