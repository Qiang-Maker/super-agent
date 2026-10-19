/**
 * ============================================================================
 * 过载保护 (Retry & Backoff)
 * ============================================================================
 *
 * 【业务背景】
 * Agent 与真实大模型 API 之间隔着网络。限流 (429)、网关抖动 (502/503)、
 * 连接被重置 (ECONNRESET) 都是常态，而非异常。如果一遇到就把整轮对话判死，
 * Agent 的可用性会被网络质量直接拖垮。
 *
 * 【设计意图】
 * 重试必须"挑对象"：
 * 1. 只重试「临时性故障」（限流 / 5xx / 网络抖动），它们等一等大概率会自愈；
 * 2. 绝不重试「确定性故障」（参数不合法、schema 校验失败、鉴权失败），
 *    它们重试一万次也是同样的结果，只会白白空等、拖长用户感知延迟。
 *
 * 【关键约束】
 * 退避时间必须带随机抖动 (Jitter)。若所有客户端都严格等 1s 后重试，
 * 服务端会被同一波请求再次打垮，形成"惊群效应"(Thundering Herd)。
 */

/**
 * 错误分类网关：判断一个异常是否值得重试
 *
 * 判定顺序说明：
 * 优先从错误信息里解析 HTTP 状态码，其次回退到网络层错误关键词匹配。
 * 无法识别的错误一律判定为「不可重试」，宁可快速失败，也不无谓空等。
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message || '';

  // --- 第一优先级：HTTP 状态码判断 ---
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if ([429, 529, 408].includes(status)) return true; // 限流 / 服务过载 / 请求超时
    if (status >= 500 && status < 600) return true;    // 服务端故障，可等待自愈
    if (status >= 400 && status < 500) return false;   // 客户端错误，重试无意义
  }

  // --- 第二优先级：网络层与 SDK 包装错误 ---
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  // AI SDK 在流式响应中断时会包装成 NoOutputGeneratedError
  if (message.includes('No output generated')) return true;

  // 兜底：无法归类的错误按不可重试处理，快速失败优于盲目等待
  return false;
}

/**
 * 指数退避 + 随机抖动 计算器
 *
 * 公式：delay = min(base * 2^(attempt-1), maxMs) ± 25% 抖动
 * 例（base=500）：约 500ms → 1000ms → 2000ms → 4000ms …
 *
 * @param attempt 当前第几次重试（从 1 开始计数）
 * @param baseMs  首次退避基准时长（毫秒）
 * @param maxMs   单次退避时长上限（毫秒），防止指数膨胀到不可接受
 */
export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(jittered));
}

/** 异步休眠工具函数 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
