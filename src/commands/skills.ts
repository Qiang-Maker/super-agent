/**
 * ============================================================================
 * Skill 快捷命令
 * ============================================================================
 *
 * /skill                    列出可用 skill 与激活状态
 * /skill load <name>        激活（内容注入 system prompt）
 * /skill unload <name>      卸载
 * /<skill-name> <需求>      一步到位：激活该 skill 并把需求作为这一轮的输入
 *
 * 最后这个快捷方式最关键——大多数时候你只是想用一下某个 skill，
 * 不需要先 load 再打字描述需求。
 */

import type { CommandHandler } from './index.js';
import type { SkillLoader } from '../skills/loader.js';

export function createSkillCommands(
  skillLoader: SkillLoader,
  activeSkills: Set<string>,
): CommandHandler[] {
  return [
    (cmd) => {
      if (cmd !== '/skill' && cmd !== 'skill') return false;
      const all = skillLoader.list();
      if (all.length === 0) {
        console.log('\n[skills] 没有找到任何 skill（在 .skills/<name>/SKILL.md 里写一个即可）\n');
        return true;
      }
      console.log(`\n[skills] 共 ${all.length} 个可用：`);
      for (const s of all) {
        const flag = activeSkills.has(s.name) ? '✓ 已激活' : '  未激活';
        console.log(`  ${flag}  /${s.name} — ${s.description}`);
      }
      console.log('');
      return true;
    },

    (cmd) => {
      if (!cmd.startsWith('/skill load ')) return false;
      const name = cmd.slice('/skill load '.length).trim();
      if (!skillLoader.get(name)) {
        console.log(`\n[skills] 没有这个 skill: ${name}\n`);
        return true;
      }
      activeSkills.add(name);
      console.log(`\n[skills] 已激活 ${name}（内容已注入 system prompt）\n`);
      return true;
    },

    (cmd) => {
      if (!cmd.startsWith('/skill unload ')) return false;
      const name = cmd.slice('/skill unload '.length).trim();
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载 ${name}\n`);
      return true;
    },

    // /<skill-name> <需求>：激活 + 把需求作为这一轮输入交给主循环
    (cmd) => {
      const match = cmd.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/);
      if (!match) return false;
      const [, name, rest] = match;
      if (!skillLoader.get(name)) return false;

      activeSkills.add(name);
      const requirement = rest?.trim();
      console.log(`\n[skills] 已激活 ${name}`);
      return requirement ? requirement : true;
    },
  ];
}
