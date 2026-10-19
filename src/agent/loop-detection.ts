/**
 * ==============================================================================
 * 循环检测与短路保护算法引擎 (loop-detection.ts)
 * ==============================================================================
 *
 * 业务背景：
 *   在多步 Agent 执行过程中，大模型在遇到未捕获错误、参数不匹配或环境不变时，
 *   极易陷入无限死循环（例如反复调用同一个工具，或者在 Tool A 和 Tool B 之间振荡）。
 *   为了避免无限烧 Token 并导致服务卡死，本模块通过指纹哈希与滑动窗口，
 *   实现高精度的循环调用检测与熔断截断。
 *
 * 【模块形态：模块级状态，不是类】
 *   滑动窗口 history 直接挂在模块作用域，检测能力以纯函数导出。
 *   这样 Agent Loop 那边只需要 import 四个函数，不需要持有检测器实例；
 *   每一轮新任务开始时调用 resetHistory() 清空窗口即可。
 *
 * 【三档处置力度：先软后硬】
 *   Warning  → 注入系统提醒消息，让模型"醒过来"换策略；
 *   Critical → 阻断工具调用，强制停止循环；
 *   全局熔断 → 无论什么情况，强制停止。
 *
 *   为什么不在第一次重复就停？因为误杀的代价太大：把一个正在正常工作的 Agent
 *   强行停了，比让它多跑几轮更浪费。先软后硬，给模型自救的机会。
 */

import { createHash } from 'node:crypto';

// --- 类型定义 ---

/** 单次工具调用在滑动窗口中的历史记录 */
export interface ToolCallRecord {
  /** 调用的工具名称（如 get_weather, read_file） */
  toolName: string;
  /** 工具调用入参的降维哈希指纹（前 16 位十六进制） */
  argsHash: string;
  /** 工具执行完成返回结果的降维哈希指纹（初始为空，执行完后回填） */
  resultHash?: string;
  /** 发生调用的时间戳 */
  timestamp: number;
}

/** 触发检测的三种检测器 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

/** 检测结论：要么没卡住，要么带着级别、检测器、计数与说明返回 */
export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

// --- 配置 ---

const HISTORY_SIZE = 30;       // 滑动窗口大小
const WARNING_THRESHOLD = 5;   // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8;  // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10;  // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

/**
 * 稳定序列化算法 (Stable Stringify)
 *
 * JavaScript 对象键是无序的，{ a: 1, b: 2 } 和 { b: 1, a: 2 } 直接 stringify 结果不同。
 * 本函数递归提取所有 keys 并执行字典序排序，确保语义完全相同的参数对象
 * 生成的 JSON 字符串绝对一致，指纹才不会误判。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

/**
 * SHA-256 降维指纹
 *
 * 工具参数或返回值可能达数千字符，全量比较占用大量内存和 CPU。
 * 计算 SHA-256 摘要并切片取前 16 位，在碰撞概率可忽略的前提下把比对降到 O(1)。
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** 为工具调用生成唯一组合指纹：toolName:argsHash */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/** 为工具执行结果生成哈希指纹 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

/** 内存中的调用历史滑动窗口（模块级，跨调用共享） */
const history: ToolCallRecord[] = [];

/** 记录一次新的工具调用动作（发生在 execute 执行之前） */
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  // 超过滑动窗口容量时挤出最老的记录
  if (history.length > HISTORY_SIZE) history.shift();
}

/** 回填工具执行的返回结果指纹（发生在 execute 执行之后） */
export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  // 从最新一条往回找匹配的、尚未回填结果的记录
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

/** 重置历史记录（每一轮全新任务启动时调用） */
export function resetHistory(): void {
  history.length = 0;
}

// --- 检测器 ---

/**
 * 检测器 1：无进展连续击穿
 *
 * 连续调用相同入参，且工具返回的结果指纹也 100% 一样，说明外界环境毫无反应。
 * 这是最确定的死循环信号，所以它的阈值直接挂在全局熔断档上。
 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    if (!r.resultHash) continue;

    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }

    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

/**
 * 检测器 2：乒乓交替循环 (Ping-Pong Loop)
 *
 * 识别最隐蔽的模式：A -> B -> A -> B -> A 循环振荡。
 * 先把「上一次之外的那个指纹」找出来当作 otherHash，再从尾部往回数连续交替的段长；
 * 如果本次调用正好接在交替段后面补上另一环，就把计数加一。
 */
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;

  const last = history[history.length - 1];
  let otherHash: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }

  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---

/**
 * 综合判定网关：在执行工具前触发检查
 *
 * 判定优先级：全局熔断（无进展） > 乒乓振荡 > 通用重复。
 * 越确定的死循环信号越先判，避免被弱信号提前降级成 warning。
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  return { stuck: false };
}
