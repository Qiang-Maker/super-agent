/**
 * ============================================================================
 * 持久化记忆（文件派：MEMORY.md 索引 + 独立文件）
 * ============================================================================
 *
 * 【存储层次的类比】寄存器/缓存 = 上下文窗口，RAM = 会话历史（关掉就丢），
 * 硬盘 = 长期记忆（跨会话、需要检索）。前面几节都在 L1/L2 和 RAM 打转，
 * 这一节给 Agent 装一块"硬盘"。
 *
 * 【该记什么】排除法优先——能从代码推导的不存、能从 git 推导的不存、
 * 文档里已有的不存。只存"只存在于对话中、无法从其他地方获取"的信息：
 * 用户偏好、纠正反馈、决策背景、外部资源位置。
 *
 * 【四种类型】user（用户画像）/ feedback（行为反馈）/ project（项目动态）/
 * reference（外部资源）。feedback 最重要——纠正和确认都要存，只存纠正会让
 * Agent 越来越保守。
 *
 * 【两个硬约束】索引最多 200 行（迫使只留真正重要的）、单文件最多 4000 字符
 * （防止一条记忆吃光上下文预算）。
 *
 * 【文件派 vs 数据库派】文件派适合 <200 条、单人、要 git 追溯、人要能直接读；
 * 数据库派适合 500+ 条、多人、要语义搜索。不确定就从文件派开始——
 * 迁移成本几乎为零，反过来不行（embedding 没法变回人类可读的文件）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { tokenize, bm25Scores } from '../rag/search.js';

export interface MemoryEntry {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
  filePath: string;
  /** 写入时间（lint 用来判断"存了多久"） */
  lastWriteAt?: number;
  /** 最后一次被显式读取的时间（lint 的 never_used 依据） */
  lastReadAt?: number;
}

const MEMORY_DIR = '.memory';
const INDEX_FILE = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir;
  }

  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE);
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8');
    }
  }

  /** 写文件 + 更新索引；文件名 {type}_{slug}.md，类型前缀方便人眼扫描 */
  save(entry: Omit<MemoryEntry, 'filePath'>): string {
    this.init();
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);

    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      '---',
      '',
      entry.content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(entry.name, filename, entry.description);
    this.setMeta(filename, { lastWriteAt: Date.now(), lastReadAt: Date.now() });
    return filename;
  }

  // ---- 元数据（最后读写时间，供 lint 判断 never_used）------------------------

  private get metaPath(): string {
    return path.join(this.memoryDir, '.meta.json');
  }

  private loadMeta(): Record<string, { lastWriteAt?: number; lastReadAt?: number }> {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private setMeta(filename: string, patch: { lastWriteAt?: number; lastReadAt?: number }): void {
    const meta = this.loadMeta();
    meta[filename] = { ...meta[filename], ...patch };
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  list(): MemoryEntry[] {
    this.init();
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith('.md') && f !== INDEX_FILE);
    const fileMeta = this.loadMeta();

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      let raw = fs.readFileSync(filePath, 'utf-8');
      // 读取时截断，防止单条记忆吃光上下文预算
      if (raw.length > MAX_FILE_CHARS) raw = raw.slice(0, MAX_FILE_CHARS) + '\n...[truncated]';

      const meta = parseFrontmatter(raw);
      const times = fileMeta[file] || {};
      entries.push({
        name: meta.name || file,
        description: meta.description || '',
        type: (meta.type as MemoryEntry['type']) || 'reference',
        content: meta.content,
        filePath,
        lastWriteAt: times.lastWriteAt,
        lastReadAt: times.lastReadAt,
      });
    }
    return entries;
  }

  /** BM25 排序检索（4-3 从 includes 升级而来，复用 RAG 那套全文检索实现） */
  search(query: string): MemoryEntry[] {
    const all = this.list();
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const scores = bm25Scores(
      terms,
      all.map((e) => `${e.name} ${e.description} ${e.content}`),
    );
    return all
      .map((entry, i) => ({ entry, score: scores[i] }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.entry);
  }

  read(filename: string): MemoryEntry | null {
    const entry = this.list().find((e) => path.basename(e.filePath) === filename) || null;
    // 显式读取才算"用过"——lint 的 never_used 依据这个时间
    if (entry) this.setMeta(filename, { lastReadAt: Date.now() });
    return entry;
  }

  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    // 索引里对应行一并移除
    const lines = this.loadIndexLines().filter((l) => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join('\n') + '\n', 'utf-8');
    return true;
  }

  count(): number {
    return this.list().length;
  }

  private loadIndexLines(): string[] {
    this.init();
    return fs.readFileSync(this.indexPath, 'utf-8').split('\n');
  }

  private updateIndex(name: string, filename: string, description: string): void {
    const lines = this.loadIndexLines().filter((l) => l.trim() !== '');
    const entryLine = `- ${name} — ${description} (${filename})`;
    const existing = lines.findIndex((l) => l.includes(`(${filename})`));

    if (existing >= 0) {
      lines[existing] = entryLine;
    } else {
      lines.push(entryLine);
    }

    // 200 行上限：超了就从最早的条目开始淘汰（低价值记忆自然被挤出去）
    while (lines.length > MAX_INDEX_LINES) lines.splice(1, 1);

    fs.writeFileSync(this.indexPath, lines.join('\n') + '\n', 'utf-8');
  }

  /**
   * 生成注入 system prompt 的记忆段落
   *
   * 最后一句「记忆是线索，不是事实」是刻意的：记忆记录的是写入那一刻的事实，
   * 文件可能已经重构、库可能已经迁移——用之前先用工具验证。
   */
  buildPromptSection(): string {
    this.init();
    const entries = this.list();
    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    const index = this.loadIndexLines().filter((l) => l.trim() !== '').join('\n');
    return [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '记忆使用原则：',
      '- 记忆是线索，不是事实——使用前先用工具验证（read_file / grep 确认）',
      '- 不存代码能推导的、git 能查的、文档已经写了的（那些有权威来源，存副本只会过期）',
      '- 只存对话中出现的、其他地方推导不出来的信息',
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容（read/delete 传 filename）。',
    ].join('\n');
  }
}

/** 解析 YAML frontmatter（只认 name / description / type 三个字段） */
function parseFrontmatter(raw: string): {
  name: string;
  description: string;
  type: string;
  content: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: '', description: '', type: '', content: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    name: meta.name || '',
    description: meta.description || '',
    type: meta.type || '',
    content: (match[2] || '').trim(),
  };
}
