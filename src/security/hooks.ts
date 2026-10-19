/**
 * ============================================================================
 * Hook 管线
 * ============================================================================
 *
 * 角色权限与 bash 检测解决"该不该执行"；Hook 解决"执行前后能不能插入自定义逻辑"——
 * 审计日志、格式检查、参数改写、输出脱敏……
 *
 * 返回值三选一：allow（放行）/ block（拦截，仅 pre 有效）/ modify（放行但改输入输出）。
 * 多个 hook 串联执行，前一个的修改结果传给下一个（管线模式）。
 *
 * 【两个设计细节】
 * 1. 每个 hook 的异常被 catch —— 一个 hook 挂了不影响其他 hook 与工具本身；
 * 2. **hook 配置不能被 Agent 自己修改** —— 只在启动时注册，运行期没有增删 API。
 *    这是安全考量：如果 Agent 能改自己的安全检查，prompt injection 就能让它
 *    把所有检查关掉（Claude Code 同理：hook 配在 settings.json 里，Agent 不能写它）。
 */

export type HookAction = 'allow' | 'block' | 'modify';

export interface HookResult {
  action: HookAction;
  reason?: string;
  modifiedInput?: unknown;
  modifiedOutput?: unknown;
}

export type PreToolHook = (toolName: string, input: unknown) => HookResult | Promise<HookResult>;
export type PostToolHook = (
  toolName: string,
  input: unknown,
  output: unknown,
) => HookResult | Promise<HookResult>;

export class HookPipeline {
  private preHooks: Array<{ name: string; fn: PreToolHook }> = [];
  private postHooks: Array<{ name: string; fn: PostToolHook }> = [];

  registerPre(name: string, fn: PreToolHook): void {
    this.preHooks.push({ name, fn });
  }

  registerPost(name: string, fn: PostToolHook): void {
    this.postHooks.push({ name, fn });
  }

  async runPre(toolName: string, input: unknown): Promise<HookResult> {
    let currentInput = input;
    for (const hook of this.preHooks) {
      try {
        const result = await hook.fn(toolName, currentInput);
        if (result.action === 'block') {
          console.log(`  [hook:${hook.name}] 拦截 ${toolName}: ${result.reason}`);
          return result;
        }
        if (result.action === 'modify' && result.modifiedInput !== undefined) {
          currentInput = result.modifiedInput;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] pre 异常: ${msg}`);
      }
    }
    return { action: 'allow', modifiedInput: currentInput };
  }

  async runPost(toolName: string, input: unknown, output: unknown): Promise<HookResult> {
    let currentOutput = output;
    for (const hook of this.postHooks) {
      try {
        const result = await hook.fn(toolName, input, currentOutput);
        if (result.action === 'modify' && result.modifiedOutput !== undefined) {
          currentOutput = result.modifiedOutput;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [hook:${hook.name}] post 异常: ${msg}`);
      }
    }
    return { action: 'allow', modifiedOutput: currentOutput };
  }

  list(): { pre: string[]; post: string[] } {
    return {
      pre: this.preHooks.map((h) => h.name),
      post: this.postHooks.map((h) => h.name),
    };
  }
}
