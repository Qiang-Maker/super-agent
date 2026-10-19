/**
 * ============================================================================
 * 安全相关快捷命令
 * ============================================================================
 *
 * /role                  查看当前角色与可用工具数
 * /role owner|collaborator|guest  切换角色（工具列表立刻变化）
 * /hooks                 列出已注册的 hook
 */

import type { CommandHandler } from './index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookPipeline } from '../security/hooks.js';
import type { Role } from '../security/roles.js';

export function createSecurityCommands(
  registry: ToolRegistry,
  hookPipeline: HookPipeline,
): CommandHandler[] {
  return [
    (cmd) => {
      const match = cmd.match(/^\/role(?:\s+(owner|collaborator|guest))?$/);
      if (!match) return false;

      if (match[1]) {
        const role = match[1] as Role;
        registry.setRole(role);
        console.log(`\n[security] 角色切换为 ${role}，可用工具: ${registry.getActiveTools().length} 个\n`);
      } else {
        console.log(
          `\n[security] 当前角色: ${registry.getRole()}，可用工具: ${registry.getActiveTools().length} 个\n`,
        );
      }
      return true;
    },

    (cmd) => {
      if (cmd !== '/hooks') return false;

      const hooks = hookPipeline.list();
      console.log('\n[hooks]');
      if (hooks.pre.length > 0) {
        console.log('  Pre-Tool Hooks:');
        for (const name of hooks.pre) console.log(`    - ${name}`);
      }
      if (hooks.post.length > 0) {
        console.log('  Post-Tool Hooks:');
        for (const name of hooks.post) console.log(`    - ${name}`);
      }
      if (hooks.pre.length === 0 && hooks.post.length === 0) {
        console.log('  没有注册的 Hook');
      }
      console.log('');
      return true;
    },
  ];
}
