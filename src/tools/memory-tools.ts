/**
 * ============================================================================
 * memory 工具（让 Agent 自己管理记忆）
 * ============================================================================
 *
 * 一个常见的设计模式：**把相关操作合并成一个工具，用 action 字段区分**，
 * 而不是拆成 memory_save / memory_list / memory_search 五个独立工具。
 * 原因很直接——工具列表的每一项都占上下文预算，5 个工具就是 5 份
 * description + parameters；合并成一个，token 开销只有一份。
 *
 * 用工厂函数封装（与 createToolSearchTool 同一模式）：工厂接收依赖实例，
 * index.ts 里就变成一行 registry.register(createMemoryTool(memoryStore))。
 */

import path from 'node:path';
import type { ToolDefinition } from './registry.js';
import type { MemoryStore } from '../memory/store.js';
import { lintAll } from '../memory/validator.js';

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description:
      '管理跨会话记忆。action: save（保存）| list（列表）| search（搜索）| read（读取）| delete（删除）',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'search', 'read', 'delete', 'lint'] },
        name: { type: 'string', description: '记忆名称（save 时必填）' },
        description: { type: 'string', description: '一句话描述（save 时必填）' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        content: { type: 'string', description: '记忆内容（save 时必填）' },
        query: { type: 'string', description: '搜索关键词（search 时必填）' },
        filename: { type: 'string', description: '文件名（read/delete 时必填）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.type || !args.content) {
            return '保存失败：需要 name、type、content 参数';
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          });
          return `已保存到记忆: ${filename}`;
        }
        case 'list': {
          const entries = memoryStore.list();
          if (entries.length === 0) return '当前没有存储任何记忆。';
          return (
            `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries.map((e) => `  [${e.type}] ${e.name} — ${e.description}`).join('\n')
          );
        }
        case 'search': {
          const results = memoryStore.search(args.query || '');
          if (results.length === 0) return `没有找到与 "${args.query}" 相关的记忆。`;
          return (
            `搜索结果（${results.length} 条匹配）：\n` +
            results.map((e) => `  [${e.type}] ${e.name} — ${e.description}`).join('\n')
          );
        }
        case 'read': {
          if (!args.filename) return '读取失败：需要 filename 参数';
          const entry = memoryStore.read(args.filename);
          if (!entry) return `没有找到记忆文件: ${args.filename}`;
          return `[${entry.type}] ${entry.name}\n\n${entry.content}`;
        }
        case 'delete': {
          if (!args.filename) return '删除失败：需要 filename 参数';
          return memoryStore.delete(args.filename)
            ? `已删除记忆: ${args.filename}`
            : `没有找到记忆文件: ${args.filename}`;
        }
        case 'lint': {
          const report = lintAll(memoryStore.list(), '.');
          if (report.entries.length === 0) {
            return `记忆库体检通过：${report.total} 条记忆，没有发现问题。`;
          }
          const lines = [`记忆库 ${report.entries.length} 条有警告（共 ${report.total} 条）：`];
          for (const { entry, issues } of report.entries) {
            lines.push(`  📁 ${path.basename(entry.filePath)}  [${entry.type}] ${entry.name}`);
            for (const issue of issues) lines.push(`     • ${issue.kind}: ${issue.message}`);
          }
          return lines.join('\n');
        }
        default:
          return `未知操作: ${args.action}`;
      }
    },
  };
}
