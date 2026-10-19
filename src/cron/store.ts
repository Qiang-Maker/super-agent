/**
 * ============================================================================
 * 任务持久化
 * ============================================================================
 *
 * 任务定义用 JSON（需要原子更新——每次增删全量写，任务数通常几十个，够用），
 * 执行日志用 JSONL（只追加）——跟 Session / usage 的存储思路一脉相承。
 *
 * 重启后任务还在，是 Cron 系统的及格线。
 */

import fs from 'node:fs';
import { join } from 'node:path';
import type { CronJobConfig, RunLog } from './types.js';

const CRON_DIR = '.cron';
const JOBS_FILE = 'jobs.json';
const LOGS_FILE = 'logs.jsonl';

export class CronStore {
  constructor(private baseDir: string = '.') {}

  private get dir(): string {
    return join(this.baseDir, CRON_DIR);
  }

  private get jobsPath(): string {
    return join(this.dir, JOBS_FILE);
  }

  private get logsPath(): string {
    return join(this.dir, LOGS_FILE);
  }

  init(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
      return data.jobs || [];
    } catch {
      return [];
    }
  }

  saveJobs(jobs: CronJobConfig[]): void {
    this.init();
    fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2), 'utf-8');
  }

  appendLog(log: RunLog): void {
    this.init();
    fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n', 'utf-8');
  }

  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsPath)) return [];
    const lines = fs.readFileSync(this.logsPath, 'utf-8').split('\n').filter(Boolean);

    let logs: RunLog[] = lines
      .map((l) => {
        try {
          return JSON.parse(l) as RunLog;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RunLog[];

    if (jobId) logs = logs.filter((l) => l.jobId === jobId);
    return logs.slice(-limit);
  }
}
