/**
 * ============================================================================
 * 记忆相关快捷命令
 * ============================================================================
 *
 * /memory          列出所有记忆
 * /memory search X 搜索记忆
 */

import path from 'node:path';
import type { CommandHandler } from './index.js';
import { lintAll } from '../memory/validator.js';

/** /dream 的整理指令：给方向、不写死逻辑——具体删谁合并谁由模型看着 lint 报告决定 */
const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下阶段执行：',
  '',
  '**阶段 1：定位** — 用 memory 工具的 lint 操作扫描全库（报告已含问题清单，不需要逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
  '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
  '',
  '注意：read 和 delete 都需要传 filename（如 project_deploy-process.md），不是 name。',
].join('\n');

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false;
    const entries = ctx.memoryStore.list();
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆`);
    for (const e of entries) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('/memory search ')) return false;
    const query = cmd.slice('/memory search '.length).trim();
    const results = ctx.memoryStore.search(query);
    console.log(`\n[记忆搜索] "${query}" → ${results.length} 条结果`);
    for (const e of results) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (cmd !== '/lint' && cmd !== 'lint') return false;
    const report = lintAll(ctx.memoryStore.list(), '.');
    if (report.entries.length === 0) {
      console.log(`\n[lint] 记忆库体检通过：${report.total} 条记忆，没有发现问题。\n`);
      return true;
    }
    console.log(`\n[lint] 记忆库 ${report.entries.length} 条有警告（共 ${report.total} 条）：`);
    for (const { entry, issues } of report.entries) {
      console.log(`  📁 ${path.basename(entry.filePath)}  [${entry.type}] ${entry.name}`);
      for (const issue of issues) console.log(`     • ${issue.kind}: ${issue.message}`);
    }
    console.log('');
    return true;
  },

  // /dream：整理逻辑不硬编码——把 lint 报告交给模型，由它判断删谁、合并谁。
  // 返回字符串 = 让主循环把这句当成一轮用户输入来跑（复用完整的工具与防线）。
  (cmd) => {
    if (cmd !== '/dream' && cmd !== 'dream') return false;
    console.log('\n[dream] 开始记忆整理...');
    return DREAM_PROMPT;
  },
];
