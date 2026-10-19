/**
 * ============================================================================
 * Skill 加载器
 * ============================================================================
 *
 * 【Skill 不是 Tool】
 * Tool 是可执行的函数（read_file / grep / bash）——它手里的锤子和扳手；
 * Skill 是一份 Markdown 写的行为指导——它脑子里的操作手册。
 * 有工具但没有方法论，等于有一堆零件不知道怎么组装。
 *
 * Skill 不注册进 tools 列表，而是注入 system prompt。
 *
 * 【渐进式加载（控制 token 的关键）】
 * Level 1 启动时只加载 frontmatter（name + description + when_to_use，约 100 token/skill）；
 * Level 2 用户激活后才把完整内容塞进 prompt；
 * Level 3 skill 目录下的参考文件按需用 read_file 读——天然就是按需加载，不用额外实现。
 *
 * 所以 100 个 skill 初始也就 10K token，不会把上下文撑爆。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dirPath: string;
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();

  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  /** 扫描 .skills/ 下每个子目录的 SKILL.md */
  load(): SkillDefinition[] {
    this.skills.clear();
    const skillsDir = path.join(this.baseDir, SKILLS_DIR);
    if (!fs.existsSync(skillsDir)) return [];

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
      });
    }
    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * 注入 system prompt
   *
   * 已激活的：注入完整 SOP；未激活的：只列名称 + 描述（+ 适用场景），
   * 让模型知道还有哪些可用、什么时候该建议用户激活。
   */
  buildPromptSection(activeSkills: Set<string>): string | null {
    if (this.skills.size === 0) return null;
    const lines: string[] = [];

    for (const name of activeSkills) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      lines.push(`[激活的 Skill: ${skill.name}]`);
      lines.push(skill.content);
      lines.push('');
    }

    const available = this.list()
      .filter((s) => !activeSkills.has(s.name))
      .map((s) => `  /${s.name} — ${s.description}${s.whenToUse ? `（适用场景: ${s.whenToUse}）` : ''}`);
    if (available.length > 0) {
      lines.push('可用的 Skills（输入 /skill load <name> 激活，或直接 /<skill-name> <需求>）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

/** 简易 frontmatter 解析（按行拆、按冒号分 key/value，去掉包裹引号） */
function parseFrontmatter(raw: string): {
  description: string;
  whenToUse?: string;
  content: string;
} | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { description: '', content: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      meta[key] = value;
    }
  }

  return {
    description: meta.description || '',
    whenToUse: meta.when_to_use,
    content: match[2].trim(),
  };
}
