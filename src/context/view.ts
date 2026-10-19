/**
 * ============================================================================
 * /context 与 /usage 终端看板
 * ============================================================================
 *
 * 长会话下觉得"模型变笨了"，第一反应就该看这两块看板：
 *   /context 看"占了多少"——是不是历史消息把推理空间挤没了？工具列表是不是悄悄涨了？
 *   /usage   看"花了多少、省了多少"——cache 到底有没有在起作用。
 *
 * autocompact buffer（▢）是预留给摘要压缩的水位线，一眼看出"离触发自动压缩还有多远"。
 */

import type { UsageTotals } from '../usage/tracker.js';

export interface ContextSnapshot {
  model: string;
  contextWindow: number;
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
  bufferTokens: number;
}

const CELLS_PER_ROW = 16;
const ROWS = 8;
const TOTAL_CELLS = CELLS_PER_ROW * ROWS;

function pct(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(1)}%`;
}

/** 把上下文窗口切成 128 份，按占用来源填不同方块 */
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const { contextWindow } = snapshot;
  const used = snapshot.systemTokens + snapshot.toolsTokens + snapshot.messageTokens;
  const cellSize = contextWindow / TOTAL_CELLS;

  const cells: string[] = [];
  const push = (count: number, char: string) => {
    for (let i = 0; i < count; i++) cells.push(char);
  };

  push(Math.round(snapshot.systemTokens / cellSize), '◆'); // System prompt
  push(Math.round(snapshot.toolsTokens / cellSize), '◈'); // 工具定义
  push(Math.round(snapshot.messageTokens / cellSize), '●'); // 消息历史
  push(Math.round(snapshot.bufferTokens / cellSize), '▢'); // autocompact buffer
  while (cells.length < TOTAL_CELLS) cells.push('○'); // Free space

  const lines: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const row = cells.slice(r * CELLS_PER_ROW, (r + 1) * CELLS_PER_ROW).join(' ');
    if (r === 0) {
      lines.push(`  ${row}   ${snapshot.model}`);
    } else if (r === 1) {
      lines.push(`  ${row}   ${used >= 1000 ? `${(used / 1000).toFixed(1)}k` : used}/${contextWindow >= 1000 ? `${(contextWindow / 1000).toFixed(1)}M` : contextWindow} tokens (${pct(used, contextWindow)})`);
    } else if (r === 3) {
      lines.push(`  ${row}   ◆ System prompt: ${snapshot.systemTokens} (${pct(snapshot.systemTokens, contextWindow)})`);
    } else if (r === 4) {
      lines.push(`  ${row}   ◈ System tools:  ${snapshot.toolsTokens} (${pct(snapshot.toolsTokens, contextWindow)})`);
    } else if (r === 5) {
      lines.push(`  ${row}   ● Messages:      ${snapshot.messageTokens} (${pct(snapshot.messageTokens, contextWindow)})`);
    } else if (r === 6) {
      lines.push(`  ${row}   ○ Free space:    ${Math.max(0, contextWindow - used - snapshot.bufferTokens)} (${pct(Math.max(0, contextWindow - used - snapshot.bufferTokens), contextWindow)})`);
    } else if (r === 7) {
      lines.push(`  ${row}   ▢ Buffer:        ${snapshot.bufferTokens} (${pct(snapshot.bufferTokens, contextWindow)})`);
    } else {
      lines.push(`  ${row}`);
    }
  }
  return lines.join('\n');
}

function bar(rate: number, width = 30): string {
  const filled = Math.round(rate * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** /usage：花了多少、省了多少 */
export function renderUsageSummary(totals: UsageTotals): string {
  return [
    '  Usage Summary',
    `  ${totals.steps} 步累计`,
    '',
    `  ◎ Input        ${totals.inputTokens} tokens`,
    `  ◈ Cache write  ${totals.cacheWriteTokens} tokens`,
    `  ◉ Cache read   ${totals.cacheReadTokens} tokens   (${(totals.cacheHitRate * 100).toFixed(1)}% hit)`,
    `  ◇ Output       ${totals.outputTokens} tokens`,
    '',
    `  Cache hit rate  ${bar(totals.cacheHitRate)}  ${(totals.cacheHitRate * 100).toFixed(1)}%`,
    '',
    `  Cost            $${totals.cost.toFixed(5)}`,
    `  Without cache   $${totals.baselineCost.toFixed(5)}`,
    `  Saved           $${totals.savedCost.toFixed(5)} (${totals.baselineCost > 0 ? ((totals.savedCost / totals.baselineCost) * 100).toFixed(1) : '0.0'}% off)`,
  ].join('\n');
}
