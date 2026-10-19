/**
 * ============================================================================
 * 工具注册中心 (Tool Registry)
 * ============================================================================
 *
 * 【这一层解决什么问题】
 * 工具定义如果逐条挂在 Agent Loop 上，两边会耦合在一起：
 * 没有统一注册、没有结果管理、没有并发控制。一个工具返回 10 万字符的文件内容，
 * 直接塞进上下文就能吃掉半条 Token 预算。
 *
 * ToolRegistry 把「工具怎么调」（模型关心的）和「工具怎么管」（运行时关心的）
 * 收进同一个 ToolDefinition，注册一次同时服务两个消费者。
 *
 * 【三层职责】
 * 1. 注册与查找：register / get / getAll
 * 2. 结果截断：truncateResult 采用 Head/Tail 60/40 分割，保住文件两端的关键信息
 * 3. 并发控制：读写锁，只读工具共享执行，读写工具独占执行
 */

import { jsonSchema } from 'ai';
import type { MCPClientLike } from './mcp-client.js';
import { canUseTool, type Role } from '../security/roles.js';
import { classifyBashCommand } from '../security/bash-classifier.js';
import type { HookPipeline } from '../security/hooks.js';

/**
 * 统一工具定义契约
 *
 * 前三个字段是模型需要的（描述、参数契约、执行逻辑），
 * 后三个是 Agent Loop 做运行时决策用的（能否并发、是否只读、结果上限）。
 */
export interface ToolDefinition {
  /** 工具名，模型按这个名字调用 */
  name: string;
  /** 给模型看的描述，决定模型什么时候用它 */
  description: string;
  /** 参数 JSON Schema */
  parameters: Record<string, unknown>;
  /** 能否和其他工具并行执行（只读工具通常为 true） */
  isConcurrencySafe?: boolean;
  /** 是否只读（不修改系统状态） */
  isReadOnly?: boolean;
  /** 结果最大字符数，超出由 truncateResult 截断 */
  maxResultChars?: number;
  /**
   * 是否延迟加载（2-6 ToolSearch）
   *
   * 标记为 true 的工具默认不进 prompt，模型先用 tool_search 拿到它的完整
   * Schema 后才生效。判断依据就是使用频率：核心工具（读写文件 / 搜索 / 命令）
   * 永远加载，低频工具（MCP 工具、WebSearch 之类）全部延迟。
   */
  shouldDefer?: boolean;
  /** 搜索提示词（3-10 个词的短语），只在 ToolSearch 内部用于匹配，模型看不到 */
  searchHint?: string;
  /** 实际执行逻辑 */
  execute: (input: any) => Promise<unknown>;
}

/** 未显式声明 maxResultChars 时的默认结果上限 */
const DEFAULT_MAX_RESULT_CHARS = 3000;

/** 执行前拦截钩子的裁决结果：blocked 为真时该工具不会被真正执行 */
export interface ToolGuardVerdict {
  blocked: boolean;
  /** blocked 时回填给模型的说明文案 */
  message?: string;
}

export interface ToAISDKFormatOptions {
  /**
   * 工具执行前的拦截钩子（方案 B 的落点）
   *
   * 挂在 execute 包装层里，而不是挂在流事件的 tool-call 分支上：
   * AI SDK 收到 tool-call 后会立刻并发执行工具，等流事件冒出来时
   * 副作用可能已经落地。只有把判定放在 execute 内部、真正执行之前，
   * 才能保住「执行前拦截」——这正是三层保险丝里最硬的那条要求。
   */
  beforeExecute?: (toolName: string, input: any) => ToolGuardVerdict;
}

/**
 * 工具注册中心
 *
 * 负责工具的注册、查找、AI SDK 格式转换，并统一提供结果截断与读写锁保护。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** 已连接的 MCP 客户端，进程退出时统一关闭 */
  private mcpClients: MCPClientLike[] = [];

  /** 已被 tool_search 发现过的延迟工具名——发现过的工具进入后续每轮的 prompt */
  private discoveredTools = new Set<string>();

  /** 6-1：当前角色（终端里自己用默认 owner，最高权限） */
  private currentRole: Role = 'owner';

  /** 6-1：Hook 管线（启动时注入；运行期没有增删 API——防止 Agent 改掉自己的安全检查） */
  private hookPipeline?: HookPipeline;

  // ---- 读写锁的三个状态变量 -------------------------------------------------
  /** 当前是否有独占锁持有者 */
  private exclusiveLock = false;
  /** 当前共享锁持有数 */
  private concurrentCount = 0;
  /** 阻塞等待中的 resolve 函数队列 */
  private waitQueue: Array<() => void> = [];

  /**
   * 批量注册工具。同名工具后注册的覆盖先注册的。
   */
  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * 注销一个工具（5-2 Plugin 卸载时用）
   *
   * 同时把它的"已发现"状态清掉——否则插件重新加载后，
   * 延迟工具会带着旧的 discovered 状态直接进 prompt。
   */
  unregister(name: string): boolean {
    this.discoveredTools.delete(name);
    return this.tools.delete(name);
  }

  /**
   * 按名字查找工具定义
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 取出全部已注册工具
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // ---- 2-6：ToolSearch 延迟加载 --------------------------------------------

  /**
   * 按精确工具名搜索（支持逗号分隔一次查多个）
   *
   * 用精确匹配而不是模糊搜索：System prompt 里已经把延迟工具的名字全列给模型了，
   * 模型直接选名字传过来即可，精确匹配不会搜出不相关的结果，更可靠。
   * 搜到的工具自动进入 discoveredTools，下一轮它就出现在 tools 参数里。
   */
  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = q.includes(',') ? q.split(',').map((n) => n.trim()).filter(Boolean) : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== 'tool_search') {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  /** 哪些工具进入 prompt：延迟工具未被发现前不进；角色不允许的工具直接不暴露给模型 */
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      if (!canUseTool(this.currentRole, tool.name)) {
        return false;
      }
      return true;
    });
  }

  // ---- 6-1：角色与 Hook 管线 -------------------------------------------------

  setRole(role: Role): void {
    this.currentRole = role;
  }

  getRole(): Role {
    return this.currentRole;
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.hookPipeline = pipeline;
  }

  /** 生成延迟工具的名字清单，附到 System prompt 里，模型据此知道有哪些能力可按需发现 */
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return '';

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : '';
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
  }

  /** 粗略估算工具定义占用的 token（序列化长度 / 4），用来直观看到延迟加载省了多少 */
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  // ---- 读写锁实现 ----------------------------------------------------------
  // 拿不到锁的调用方不轮询自旋，而是把 resolve 推进 waitQueue 挂起；
  // 锁持有者释放时 drainQueue() 一次性唤醒全部等待者，让它们重新抢锁。

  /**
   * 获取共享锁：只要没人独占就能拿到，多个只读工具可同时持有
   */
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  /**
   * 释放共享锁：最后一个共享持有者退出时唤醒等待队列
   */
  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  /**
   * 获取独占锁：必须等所有共享锁释放、且没人持独占
   */
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  /**
   * 释放独占锁并唤醒等待队列
   */
  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  /**
   * 锁释放时把等待队列全唤醒，让它们重新去抢锁
   */
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  /**
   * 带锁与截断地执行一个工具
   *
   * 这是本 Registry 对外的唯一执行入口。Agent Loop 和 AI SDK 都走这里，
   * 保证「锁保护」和「结果截断」只实现一份，不会出现两条路径行为不一致。
   *
   * 执行前按 isConcurrencySafe 获取对应锁，执行后用 finally 确保锁一定释放——
   * 否则工具抛异常会把整个 Registry 锁死。
   *
   * @param name 工具名
   * @param input 工具入参
   * @returns 截断后的结果字符串
   */
  async executeTool(name: string, input: any): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `找不到工具: ${name}`;
    }

    const isSafe = tool.isConcurrencySafe === true;

    if (isSafe) {
      await this.acquireConcurrent();
      console.log(`  [并发] ${name} 获取共享锁`);
    } else {
      await this.acquireExclusive();
      console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
    }

    try {
      const raw = await tool.execute(input);
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      return truncateResult(text, tool.maxResultChars);
    } finally {
      // 不管成功还是抛异常，锁都要还回去
      if (isSafe) {
        this.releaseConcurrent();
      } else {
        this.releaseExclusive();
      }
    }
  }

  /**
   * 转换成 Vercel AI SDK 需要的工具格式
   *
   * 产出的工具始终带 execute，执行权交给 AI SDK，
   * 读写锁与结果截断都包在这层 execute 包装里。Agent Loop 不感知并发细节，
   * 也不需要手工组装 tool-call / tool-result 消息——SDK 会把它们组装进
   * response.messages，Loop 直接消费即可。
   *
   * 唯一的扩展是 beforeExecute 钩子（方案 B）：在加锁与执行之前先过一遍
   * 循环检测，判定 critical 时直接返回熔断文案、不执行工具。
   * 这样既保持了 SDK 执行，又保住了「执行前拦截」能力。
   */
  toAISDKFormat(options: ToAISDKFormatOptions = {}): Record<string, any> {
    const { beforeExecute } = options;
    const result: Record<string, any> = {};

    // 只输出活跃工具：延迟工具在被 tool_search 发现之前不进 prompt（2-6）
    for (const tool of this.getActiveTools()) {
      const name = tool.name;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 1. 循环检测预检（方案 B）：判定 critical 时工具不执行，只把文案回填给模型
          const verdict = beforeExecute?.(name, input);
          if (verdict?.blocked) {
            return verdict.message ?? `工具 ${name} 已被拦截，未执行。`;
          }

          // 2. bash 风险检测（6-1）：dangerous 直接拒绝，moderate 打警告放行
          if (name === 'bash' && input?.command) {
            const risk = classifyBashCommand(String(input.command));
            if (risk.level === 'dangerous') {
              return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${input.command}`;
            }
            if (risk.level === 'moderate') {
              console.log(`  [安全] ⚠ ${risk.reason}: ${input.command}`);
            }
          }

          // 3. pre hook（6-1）：可拦截，也可改写输入
          let effectiveInput = input;
          if (registry.hookPipeline) {
            const preResult = await registry.hookPipeline.runPre(name, effectiveInput);
            if (preResult.action === 'block') {
              return `[Hook 拦截] ${preResult.reason || '操作被阻止'}`;
            }
            if (preResult.action === 'modify' && preResult.modifiedInput !== undefined) {
              effectiveInput = preResult.modifiedInput;
            }
          }

          // 4. 加锁、执行、截断、释放锁统一由 executeTool 负责；执行后过 post hook
          try {
            const output = await registry.executeTool(name, effectiveInput);
            if (registry.hookPipeline) {
              const postResult = await registry.hookPipeline.runPost(name, effectiveInput, output);
              if (postResult.modifiedOutput !== undefined) {
                return String(postResult.modifiedOutput);
              }
            }
            return output;
          } catch (err: any) {
            // 工具抛异常时回填可读文案，避免整条流被一个工具故障打断
            return `工具执行异常: ${err?.message || String(err)}`;
          }
        },
      };
    }
    return result;
  }

  /**
   * 6-3：给子 Agent 用的「无锁」工具快照
   *
   * 子 Agent 是在父 Agent 的工具执行过程中被调起来的——那时父 Agent 的锁还没释放，
   * 子 Agent 若再走一遍带锁的 execute 就会死锁。所以这里直接调用 tool.execute，
   * 只保留结果截断（上下文保护），跳过锁、hook 与循环检测预检。
   */
  toAISDKFormatUnlocked(excluded: Set<string> = new Set()): Record<string, any> {
    const result: Record<string, any> = {};
    for (const tool of this.getActiveTools()) {
      if (excluded.has(tool.name)) continue;
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          try {
            const raw = await tool.execute(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, tool.maxResultChars);
          } catch (err: any) {
            return `工具执行异常: ${err?.message || String(err)}`;
          }
        },
      };
    }
    return result;
  }

  // ---- MCP 工具注册 ---------------------------------------------------------

  /**
   * 连接一个 MCP Server，把它暴露的工具注册进 Registry
   *
   * 两个设计决策：
   * - **命名空间前缀** `mcp__<server>__<tool>`：GitHub Server 暴露 26 个工具，
   *   `create_issue` 这种通用名字换个 Server 也会叫同一个名，不加前缀会互相覆盖。
   *   Claude Code 用的也是这个格式。
   * - **description 加 `[MCP:github]` 前缀**：这不是给模型看的，是给你调试看的——
   *   结果不对时一眼能分辨是内置工具的问题还是 MCP Server 的问题。
   *
   * MCP 工具注册后与内置工具共享同一套截断与并发控制，
   * Agent Loop 完全不需要区分工具来源。
   */
  async registerMCPServer(serverName: string, client: MCPClientLike): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        // 2-6：MCP 工具默认全部延迟——数量不可控（GitHub 一个 Server 就 26 个），
        // 全塞进 prompt 既费 token 又干扰模型选择
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  /** 关闭所有 MCP 连接（进程退出前调用，避免留下孤儿进程） */
  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }
}

/**
 * 工具结果截断（上下文保卫战的第一道防线）
 *
 * 采用 Head/Tail 60/40 分割而非只截头部：很多时候文件尾部的信息比中间更有价值——
 * 日志的最新条目在尾部，代码的函数实现在尾部，配置文件最后改的 section 也在尾部。
 *
 * @param text 原始结果文本
 * @param maxChars 最大保留字符数，默认 3000
 */
export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
