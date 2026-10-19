/**
 * ============================================================================
 * 调度表达式解析
 * ============================================================================
 *
 * 三种格式覆盖日常 90% 场景：
 *   every 30s / every 5m / every 1h   固定间隔
 *   0 9 * * *                          标准五字段 cron（分 时 日 月 周）
 *   2026-05-11T09:00:00Z               一次性（到点执行一次然后自动删除）
 *
 * Cron 用 croner 解析：零依赖、支持时区与全部标准语法，msToNext() 直接给出
 * 距下次触发的毫秒数，不用自己遍历时间轴。
 *
 * 解析与执行分离：本文件只把表达式翻译成时间，调度与执行在 service.ts。
 */

import { Cron } from 'croner';
import type { ScheduleType } from './types.js';

export interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number;
  cronInstance?: Cron;
  onceAt?: Date;
}

const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

export function parseSchedule(expr: string): ParsedSchedule {
  const intervalMatch = expr.trim().match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const multiplier = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    return { type: 'interval', intervalMs: value * multiplier };
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(expr.trim())) {
    const date = new Date(expr.trim());
    if (!isNaN(date.getTime())) return { type: 'once', onceAt: date };
  }

  return { type: 'cron', cronInstance: new Cron(expr.trim()) };
}

/** 距下次触发的毫秒数（解析失败时兜底 60s，避免 0 导致忙循环） */
export function getNextCronTime(cron: Cron): number {
  return cron.msToNext() ?? 60_000;
}
