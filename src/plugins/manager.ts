/**
 * ============================================================================
 * PluginManager
 * ============================================================================
 *
 * 职责：加载/卸载插件、给每个插件构造隔离的 PluginApi、处理工具名冲突、
 * 保证一个插件挂掉不影响其他插件。
 *
 * 四个设计决策（放任何项目里都通用）：
 * 1. **命名空间隔离**：`pluginName__toolName`（与 MCP 的三段式前缀同理）
 * 2. **环境变量解析**：config 里写 '${SUPABASE_URL}'，由 Manager 启动时替换成真实值，
 *    缺了给空字符串、插件自己决定怎么降级
 * 3. **生命周期**：activate / destroy —— 连接池、定时器、长连接都要显式清理
 * 4. **错误隔离**：activate 抛异常只影响该插件；destroy 抛异常只打日志，不阻断卸载流程
 */

import type { ToolRegistry, ToolDefinition } from '../tools/registry.js';
import type { PluginDefinition, PluginConfig, PluginApi } from './types.js';

interface LoadedPlugin {
  definition: PluginDefinition;
  tools: string[];
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    const resolvedConfig = this.resolveEnvVars({ ...definition.config, ...config });
    const registeredTools: string[] = [];

    const api: PluginApi = {
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`;
          this.registry.register({
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          });
          registeredTools.push(prefixedName);
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => console.log(`  [plugin:${definition.name}] ${message}`),
    };

    try {
      await definition.activate(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
      // 激活失败要把已注册的工具回滚，避免留下半成品
      for (const toolName of registeredTools) this.registry.unregister(toolName);
      throw err;
    }

    this.plugins.set(definition.name, { definition, tools: registeredTools });
    return registeredTools;
  }

  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
      }
    }

    for (const toolName of plugin.tools) this.registry.unregister(toolName);
    this.plugins.delete(name);
    return true;
  }

  /** 进程退出前调用，做 Graceful Shutdown */
  async unloadAll(): Promise<void> {
    for (const name of Array.from(this.plugins.keys())) {
      await this.unload(name);
    }
  }

  list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        resolved[key] = process.env[value.slice(2, -1)] || '';
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
