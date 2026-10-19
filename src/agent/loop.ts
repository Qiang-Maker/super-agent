/**
 * ============================================================================
 * 三层保险丝 + 工具系统的 Agent Loop 引擎
 * ============================================================================
 *
 * 【三层保险丝机制】
 * 1. 漏电保护 (Token Budget Guard)：跨轮全局预算守门员，单步实时记账，超额拦截；
 * 2. 过载保护 (Exponential Backoff)：指数退避自动重试，捕获 429 限流与网络抖动；
 * 3. 短路保护 (Loop Detection Engine)：指纹哈希滑动窗口，检测通用重复/乒乓交替/无进展僵死并熔断。
 *
 * 【执行路线】
 * tools 交给 AI SDK 执行，Loop 消费 SDK 组装好的 response.messages：
 * - 传进去的是 registry.toAISDKFormat()，工具带 execute，锁与截断都包在那层包装里；
 * - 流消费只负责播报事件、登记循环检测指纹、累计 Token；
 * - 消息历史由 messages.push(...stepResponse.messages) 落盘，不再手工拼 tool-call / tool-result。
 *
 * 手工组装消息容易埋雷：字段名写错就会触发
 * 「Invalid prompt: The messages do not match the ModelMessage[] schema.」。
 * 交还给 SDK 之后，这条 schema 风险从根上消失——SDK 产出的消息天然合规。
 *
 * 【循环检测的拦截点（方案 B）】
 * 预检挂在 toAISDKFormat 的 execute 包装层内，而不是流事件的 tool-call 分支上。
 * AI SDK 收到 tool-call 就会立刻并发执行工具，等流事件冒出来时副作用可能已经落地；
 * 只有把判定放进 execute 内部、真正执行之前，才能保住「执行前拦截」。
 * 判定为 critical 时该工具不执行，只把熔断文案回填给模型，随后本步结束、不再进入下一轮。
 */

import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay, sleep } from './retry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LocalTraceRecorder } from '../trace/recorder.js';
import { normalizeUsage } from '../usage/tracker.js';
import { isModelUnavailableError, type ModelChain } from '../model/chain.js';

/** 跨轮全局持有的 Token 预算状态契约 */
export interface BudgetState {
  /** 当前已累计消耗的 Token 总量 */
  used: number;
  /** 允许消耗的硬性上限 */
  limit: number;
}

export interface RunAgentLoopOptions {
  model: LanguageModel;
  messages: ModelMessage[];
  /** 工具注册中心：工具定义、结果截断与并发锁都由它统一负责 */
  registry: ToolRegistry;
  /** 系统提示词（由 streamText 的 system 参数承载） */
  system?: string;
  maxSteps?: number;
  /** 跨轮预算守门员对象（必须由最外层持有传入） */
  budget: BudgetState;
  /** 是否启用指数退避重试（默认 true） */
  enableRetry?: boolean;
  onTextChunk?: (chunk: string) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onToolResult?: (toolName: string, result: any) => void;
  onWarning?: (warning: string) => void;
  /** 3-3/3-4：每步的真实 usage 与 provider 元数据，交给 TokenTracker 校准 / UsageTracker 记账 */
  onUsage?: (payload: { usage: any; providerMetadata?: any; modelId: string }) => void;
  /** 8-1：本地 Trace（记录每个 Step 的输入上下文、输出、耗时与 usage） */
  trace?: LocalTraceRecorder;
  /** 模型降级链：当前模型报"额度用尽/不存在/无权限"时自动切下一个 */
  modelChain?: ModelChain;
}

/** 最大循环步数：防止模型陷入无限循环 */
const MAX_STEPS = 15;

/** 指数退避的最大重试次数 */
const MAX_RETRIES = 3;

/** 工具结果日志预览的最大字符数，避免大结果刷屏终端 */
const TOOL_RESULT_PREVIEW_CHARS = 120;

/** 熔断告警前缀，既用于回填工具结果，也作为最终回答返回 */
const FUSE_ALERT_PREFIX = '💥 [短路熔断告警] 触发死循环保护';

/**
 * 生成工具结果的单行预览，超出上限时截断并标注省略字符数
 *
 * 只作用于终端日志展示，落回上下文的仍是完整结果——
 * 真正的上下文保护由 ToolRegistry 的 truncateResult 负责。
 */
function previewResult(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (text.length <= TOOL_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}... [共 ${text.length} 字符]`;
}

/**
 * 运行具备三层保险丝守护的 Agent Loop 核心
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<string> {
  const {
    model,
    messages,
    registry,
    system,
    maxSteps = MAX_STEPS,
    budget,
    enableRetry = true,
    onTextChunk,
    onToolCall,
    onToolResult,
    onWarning,
    onUsage,
    trace,
    modelChain,
  } = options;

  // --------------------------------------------------------------------------
  // 【第一层保险丝：漏电保护 (Token 预算门禁)】
  // --------------------------------------------------------------------------
  if (budget.used >= budget.limit) {
    const budgetAlert = `🛑 [Token 预算耗尽拦截] 当前会话已消耗 ${budget.used} tokens，已达预设预算上限 (${budget.limit})。拒绝执行新任务！`;
    console.error(`\n${budgetAlert}`);
    return budgetAlert;
  }

  let currentStep = 0;
  // 滑动窗口是模块级状态，每轮任务开始前清空一次
  resetHistory();
  // 模型链也回到主模型：上一轮的降级可能只是临时故障，新一轮重新试起
  modelChain?.reset();
  // 本步内被预检拦下的熔断文案；非空表示该步应当中止
  let blockedAlert: string | null = null;

  // --------------------------------------------------------------------------
  // 【第三层保险丝：短路保护（方案 B —— 预检挂在 execute 包装层）】
  //
  // 判定与登记都收在这里，而不是判定在包装层、登记在流事件的 tool-call 分支。
  // 原因是一个真实的竞态：AI SDK 收到 tool-call 就立刻并发执行工具，
  // 而我们消费流事件是异步的，同一批次里「判定」很可能跑在「登记」前面，
  // 判定看到的历史会随调度顺序漂移，熔断时机就不再确定。
  // 放在同一处、执行前原子完成，历史才可预期。
  // --------------------------------------------------------------------------
  // 每步都重新取一次活跃工具：tool_search 刚发现的延迟工具，
  // 必须在下一步就出现在 tools 参数里（2-6 的延迟加载靠这个生效）。
  // 之前这里只在循环外算一次，导致新发现的工具永远进不了 tools，
  // 模型调用时报 AI_NoSuchToolError —— 实测复现后改成本步内构建。
  const buildTools = () =>
    registry.toAISDKFormat({
      beforeExecute: (toolName, input) => {
        const verdict = detect(toolName, input);

        if (verdict.stuck && verdict.level === 'critical') {
          const alert = `${FUSE_ALERT_PREFIX}：${verdict.message}`;
          console.error(`\n${alert}`);
          onWarning?.(alert);
          blockedAlert = alert;
          // 被拦下的调用不登记：它没有执行，不该计入后续判定
          return { blocked: true, message: alert };
        }

        if (verdict.stuck && verdict.level === 'warning') {
          console.warn(`\n⚠️  [循环检测提示] ${verdict.message}`);
          onWarning?.(verdict.message);
        }

        recordCall(toolName, input);
        return { blocked: false };
      },
    });

  while (currentStep < maxSteps) {
    currentStep++;
    console.log(`\n--- Step ${currentStep} ---`);

    let hasToolCall = false;
    let fullText = '';
    let stepMessages: ModelMessage[] = [];
    let stepTokens = 0;
    blockedAlert = null;

    // 本步的工具集：含此前被 tool_search 发现过的所有延迟工具
    const tools = buildTools();

    // 8-1：必须在调用模型之前记录上下文快照——等返回后再存，
    // messages 已被追加，就不是"模型当时看到的上下文"了
    await trace?.recordStepStarted({ step: currentStep, system: system ?? '', messages });

    // ------------------------------------------------------------------------
    // 【第二层保险丝：过载保护 (指数退避重试)】
    // 重试包裹整个「发起流 + 消费流」过程，与步骤级重试同构
    // ------------------------------------------------------------------------
    for (let attempt = 1; ; attempt++) {
      // 每次尝试都用链条当前模型——降级后本步会用新模型重来
      const activeModel = modelChain ? modelChain.current.model : model;
      // streamText 的 onError 会吞掉真实错误、只留一句 "No output generated"，
      // 而"该不该退避重试 / 该不该换模型"必须看原始错误——所以在这里接住它
      let streamError: unknown;
      try {
        const result = streamText({
          model: activeModel,
          system,
          messages,
          tools,
          maxRetries: 0,
          onError: (e) => {
            streamError = e;
          },
        });

        hasToolCall = false;
        fullText = '';
        blockedAlert = null;

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              fullText += part.text;
              onTextChunk?.(part.text);
              break;

            case 'tool-call':
              // 登记已在 execute 包装层完成，这里只做播报
              hasToolCall = true;
              onToolCall?.(part.toolName, part.input as Record<string, any>);
              break;

            case 'tool-result':
              recordResult(part.toolName, part.input, part.output);
              onToolResult?.(part.toolName, previewResult(part.output));
              break;

            case 'tool-error':
              onWarning?.(`工具 ${part.toolName} 执行失败：${String(part.error)}`);
              break;
          }
        }

        // 消息历史直接消费 SDK 组装好的版本，不手工拼装
        stepMessages = (await result.response).messages;
        const usage: any = await result.usage;
        const providerMetadata: any = await result.providerMetadata;
        stepTokens = usage?.totalTokens ?? 0;
        // 3-3/3-4：真实 usage + provider 元数据交给上层（校准估算 / 成本记账）
        const modelId = (activeModel as any)?.modelId ?? 'unknown';
        onUsage?.({ usage, providerMetadata, modelId });

        // 8-1：记录本步结果（输出消息含工具调用轨迹 + usage + 耗时）
        await trace?.recordStepCompleted({
          step: currentStep,
          text: fullText,
          outputMessages: stepMessages,
          usage: normalizeUsage(usage, { provider: (model as any)?.provider, providerMetadata }),
        });
        break;
      } catch (err: any) {
        // 优先用 streamText 里接住的原始错误（HTTP 状态、额度信息都在那里面）。
        // 注意 onError 回调收到的是 { error: 真正的错误 } 包装对象，要先解包，
        // 否则"该不该退避 / 该不该换模型"两个判断都会失明。
        const effectiveErr = ((streamError as any)?.error ?? streamError ?? err) as any;

        // 8-1：每一次失败的尝试都留痕（重试前因后果可复盘）
        await trace?.recordAttemptError(currentStep, attempt, effectiveErr);

        // 模型降级：额度用尽 / 无权限 / 模型不存在 / key 无效 —— 换一个模型就能解决，
        // 所以切到下一个候选立刻重试本步（不消耗重试次数，也不该退避等待）
        if (modelChain && isModelUnavailableError(effectiveErr) && modelChain.advance()) {
          const next = modelChain.currentName;
          const reason = String(effectiveErr?.message || effectiveErr).slice(0, 90);
          console.warn(`\n⚠️  [模型降级] 当前模型不可用（${reason}）→ 改用 ${next}`);
          onWarning?.(`模型降级 → ${next}`);
          continue;
        }

        // 确定性错误不做无意义退避；已经产生工具副作用时也不重试，
        // 否则同一次调用会被执行两遍（副作用工具会被写两次）
        if (attempt > MAX_RETRIES || hasToolCall || !isRetryable(effectiveErr)) {
          throw effectiveErr;
        }

        const delay = calculateDelay(attempt);
        console.warn(`\n⚠️  [网络抖动/限流] 调用失败: ${effectiveErr.message || '未知异常'}。将在 ${delay}ms 后进行第 ${attempt}/${MAX_RETRIES} 次指数退避重试...`);
        await sleep(delay);
      }
    }

    // 消息先落盘再判定出口：无论走哪条路，assistant 的 tool-call 与
    // tool-result 都成对进入历史，配对不会被破坏
    messages.push(...stepMessages);
    budget.used += stepTokens;

    // 熔断出口：预检已拦下工具执行，本步结束后不再进入下一轮
    if (blockedAlert) {
      console.error('\n[循环检测触发，Agent 已停止]');
      return blockedAlert;
    }

    // 步后预算检查：如果在多步循环中中途超支，立即掐断
    if (budget.used >= budget.limit) {
      const midLoopAlert = `🛑 [执行中途预算超支] 步数 ${currentStep} 耗尽预算（已累计 ${budget.used}/${budget.limit} tokens），强行熔断退出！`;
      console.error(`\n${midLoopAlert}`);
      messages.push({ role: 'assistant', content: midLoopAlert });
      return midLoopAlert;
    }

    // 模型没有调用工具，说明已经给出最终回答
    if (!hasToolCall) {
      return fullText;
    }

    console.log('  → 继续下一步...');
  }

  // 步数超限兜底
  const fallbackMessage = `[步数超限熔断] 任务执行已达到最大步数限制 (${maxSteps} 步)，自动熔断。`;
  messages.push({ role: 'assistant', content: fallbackMessage });
  return fallbackMessage;
}
