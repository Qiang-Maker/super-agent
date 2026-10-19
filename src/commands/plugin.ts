/**
 * ============================================================================
 * Plugin 管理命令
 * ============================================================================
 *
 * /plugin              列出已加载与可加载的插件
 * /plugin load <name>  运行时加载（注册工具，不需要重启）
 * /plugin unload <name>运行时卸载（移除工具 + 释放资源）
 */

import type { CommandHandler } from './index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { PluginDefinition } from '../plugins/types.js';

export function createPluginCommands(
  pluginManager: PluginManager,
  availablePlugins: Map<string, PluginDefinition>,
): CommandHandler[] {
  return [
    (cmd) => {
      if (cmd !== '/plugin' && cmd !== '/plugin list') return false;

      const loaded = pluginManager.list();
      const unloaded = Array.from(availablePlugins.entries()).filter(
        ([name]) => !loaded.find((p) => p.name === name),
      );

      if (loaded.length === 0 && unloaded.length === 0) {
        console.log('\n[plugins] 没有可用的插件。\n');
        return true;
      }

      console.log('\n[plugins]');
      if (loaded.length > 0) {
        console.log('  已加载：');
        for (const p of loaded) {
          console.log(`    ${p.name} v${p.version} — ${p.description}`);
          console.log(`      工具: ${p.tools.join(', ')}`);
        }
      }
      if (unloaded.length > 0) {
        console.log('  可加载：');
        for (const [name, def] of unloaded) {
          console.log(`    ${name} v${def.version} — ${def.description}`);
        }
      }
      console.log('');
      return true;
    },

    async (cmd) => {
      const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      const def = availablePlugins.get(name);
      if (!def) {
        console.log(`\n[plugins] 找不到插件: ${name}\n`);
        return true;
      }

      try {
        const tools = await pluginManager.load(def);
        console.log(`\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`);
        for (const t of tools) console.log(`    ${t}`);
        console.log('');
      } catch (err: any) {
        console.log(`\n[plugins] 加载失败: ${err?.message || err}\n`);
      }
      return true;
    },

    async (cmd) => {
      const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];

      const ok = await pluginManager.unload(name);
      console.log(ok ? `\n[plugins] 已卸载 ${name}，相关工具已移除\n` : `\n[plugins] ${name} 未加载\n`);
      return true;
    },
  ];
}
