/**
 * ============================================================================
 * 需要依赖注入的 Prompt Pipe
 * ============================================================================
 *
 * 4-1 时 memoryContext 只有一行闭包，直接写在 index.ts 里；到 4-2 多了 ragContext，
 * 两个放一起更清晰——凡是需要注入外部 store 的 pipe 都收在这个文件里。
 *
 * 注意 ragContext 不是可有可无的：没有这条提示，Agent 不知道有知识库可用，
 * 会直接凭记忆回答然后编造内容。
 */

import type { PromptContext } from './prompt-builder.js';
import type { MemoryStore } from '../memory/store.js';
import type { VectorStore } from '../rag/store.js';
import type { SkillLoader } from '../skills/loader.js';

/** 5-1：已激活的 skill 注入完整 SOP，未激活的只列名称与描述（渐进式加载） */
export function skillsContext(
  skillLoader: SkillLoader,
  activeSkills: Set<string>,
): (ctx: PromptContext) => string | null {
  return () => skillLoader.buildPromptSection(activeSkills);
}

export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection();
}

export function ragContext(vectorStore: VectorStore): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size();
    if (size === 0) return null;
    const sources = vectorStore.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}
