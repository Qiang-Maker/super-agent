/**
 * ============================================================================
 * Session 持久化 (JSONL)
 * ============================================================================
 *
 * 【为什么用 JSONL 而不是数据库】
 * 1. Append-only —— 只往文件末尾追加，不需要事务，写入天然崩溃安全：
 *    写到一半断电，最多丢最后一行不完整的数据，前面的全部完好；
 * 2. 可调试 —— 打开文件就能看到完整对话历史，不需要查询工具；
 * 3. 零依赖 —— fs.appendFileSync 就够了，不用装数据库驱动。
 *
 * Claude Code 的对话记录（transcript）也是 JSONL，支持 --continue / --resume。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';

const SESSION_DIR = '.sessions';

export interface SessionEntry {
  type: 'message';
  timestamp: string;
  message: ModelMessage;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = 'default') {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: 'message',
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];

    const messages: ModelMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === 'message') {
          messages.push(entry.message);
        }
      } catch {
        /* 单行坏了不影响其他行——JSONL 的容错性 */
      }
    }
    return messages;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** 会话文件路径（调试用，便于日志里提示用户去看哪个文件） */
  get path(): string {
    return this.filePath;
  }
}
