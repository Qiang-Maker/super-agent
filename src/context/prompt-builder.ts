/**
 * ============================================================================
 * Prompt Pipe（模块化 Prompt 组装）
 * ============================================================================
 *
 * 【解决的问题】
 * 功能越加越多（工具描述、延迟工具清单、会话信息、记忆、RAG 上下文……），
 * 全塞进一个模板字符串就会变成"嵌满三元表达式的屎山"。
 *
 * Prompt Pipe 把 system prompt 拆成独立模块，每个模块是一个纯函数：
 * 接收运行时上下文，自己决定要不要出现在最终 prompt 里——
 * 返回字符串就加入，返回 null 就跳过。条件逻辑和内容在同一个模块内，加新 section 零摩擦。
 *
 * 【静态/动态分界线（注册顺序有讲究）】
 * KV Cache 的原理是 prompt 前缀不变就能复用计算结果，所以：
 *   不变的放前面（coreRules → toolGuide → deferredTools），每次启动都变的放最后（sessionContext）。
 * 先静后动，是 Prompt 组装的基本原则。
 */

export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
}

type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext): string {
    const sections: string[] = [];
    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null) {
        sections.push(result);
      }
    }
    return sections.join('\n\n');
  }

  /** 打印各模块的开关状态，一眼看出哪些 Pipe 是开的、哪些被条件关掉了 */
  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===');
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx);
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]';
      console.log(`  ${name}: ${status}`);
    }
    console.log('========================\n');
  }
}

// ---- 内置 Pipe 模块 --------------------------------------------------------

/** 核心行为规则：永远不变，放最前面，cache 稳稳命中 */
export function coreRules(): PipeFn {
  return () =>
    [
      '你是 Super Agent，一个能读写文件、搜索代码、执行命令的编程助手。',
      '工作区约定：app/index.html 是预置脚手架（importmap + Babel loader），不要重写它；',
      '做前端 demo 时只写 App.tsx、组件与 styles.css，单文件尽量控制在 200 行以内。',
      // 6-3：spawn_agent 需要 prompt 层引导，否则模型倾向自己一步步搜（单 Agent 也能做，只是慢）
      '涉及多个独立目标的调研、对比任务时，优先用 spawn_agent 并行派发子 Agent，让它们各自在独立上下文里探索。',
    ].join('\n');
}

/** 工具使用指引：工具数量基本固定，变化很少 */
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return [
      `你有 ${ctx.toolCount} 个工具可用。`,
      '需要外部能力（GitHub / Notion / 浏览器 / 数据库等）时，先用 tool_search 取回对应工具的完整定义再调用；不要用 bash 直接调这些平台的 API。',
    ].join('\n');
  };
}

/** 延迟工具清单：让模型知道有哪些能力可以按需发现 */
export function deferredTools(): PipeFn {
  return (ctx) => (ctx.deferredToolSummary ? ctx.deferredToolSummary.trim() : null);
}

/** 会话上下文：只在恢复历史会话时出现，新会话返回 null 不占 prompt 空间 */
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 会话 ${ctx.sessionId} 已有 ${ctx.sessionMessageCount} 条历史消息，可接着上文继续。`;
  };
}
