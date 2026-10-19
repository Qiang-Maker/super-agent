/**
 * ============================================================================
 * Trace 复盘命令
 * ============================================================================
 *
 * 用法: pnpm trace:inspect .traces/<trace-id>.jsonl
 *
 * 原始 JSONL 证据最完整，但肉眼看几百行 JSON 不舒服——这个命令只提取
 * Step、耗时、token 与工具名，把执行路径打印出来。
 */

import { inspectTrace } from './recorder.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('用法: pnpm trace:inspect <trace-file>');
  process.exit(1);
}

console.log(await inspectTrace(filePath));
