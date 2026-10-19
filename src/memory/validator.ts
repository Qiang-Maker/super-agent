/**
 * ============================================================================
 * 记忆体检（lint）
 * ============================================================================
 *
 * 记忆会以四种方式变坏：污染（把推测当事实）、爆炸（只存不删）、
 * 过期（代码变了记忆没跟上，最危险——Agent 会自信地用错误信息）、
 * 冲突（新旧记忆互相矛盾）。
 *
 * lint 扫三类问题：
 *   stale_path     引用的路径不存在了
 *   never_used     太久没被读过（按类型分级 TTL）
 *   duplicate_name 跟别的记忆重名
 *
 * TTL 分级的意义：对 TypeScript 的偏好一年不读也不过期，但"下周五前不合代码"
 * 一过周五就作废——所以不同来源的信息保质期本来就不同。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry } from './store.js';

/** 各类型记忆的保质期（天） */
export const TTL_BY_TYPE: Record<string, number> = {
  user: 365, // 用户偏好基本不过期
  feedback: 90, // 纠正反馈三个月内有效
  project: 30, // 项目决策变化最快
  reference: 14, // 外部链接会失效
};

export interface ValidationIssue {
  kind: 'stale_path' | 'never_used' | 'duplicate_name';
  message: string;
}

export interface LintReport {
  total: number;
  entries: Array<{ entry: MemoryEntry; issues: ValidationIssue[] }>;
  issueCount: number;
}

/** 从内容里抠出可能的文件路径（含扩展名或以 / 开头的片段） */
export function extractPaths(content: string): string[] {
  const matches = content.match(/[\w./-]+\/[\w./-]*[\w-]|[\w-]+\.(?:ts|js|json|md|sh|yml|yaml|py|go|sql)/g) || [];
  return [...new Set(matches)].filter((p) => !p.includes('://'));
}

export function validateEntry(
  entry: MemoryEntry,
  baseDir = '.',
  now = Date.now(),
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const p of extractPaths(entry.content)) {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (!fs.existsSync(abs)) {
      issues.push({ kind: 'stale_path', message: `引用的路径不存在：${p}` });
    }
  }

  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
    const days = (now - entry.lastReadAt) / (1000 * 60 * 60 * 24);
    if (days > staleDays) {
      issues.push({
        kind: 'never_used',
        message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
      });
    }
  }

  return issues;
}

/** 全库体检：逐条跑 validateEntry，再额外查重名 */
export function lintAll(entries: MemoryEntry[], baseDir = '.'): LintReport {
  const nameCount = new Map<string, number>();
  for (const e of entries) nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);

  const report: LintReport = { total: entries.length, entries: [], issueCount: 0 };

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir);
    if ((nameCount.get(entry.name) || 0) > 1) {
      issues.push({
        kind: 'duplicate_name',
        message: `存在 ${nameCount.get(entry.name)} 条同名记忆，可能需要合并`,
      });
    }
    if (issues.length > 0) {
      report.entries.push({ entry, issues });
      report.issueCount += issues.length;
    }
  }

  return report;
}
