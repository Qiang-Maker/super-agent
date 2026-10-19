/**
 * ============================================================================
 * Plugin 接口契约
 * ============================================================================
 *
 * 一个 Plugin 回答三个问题：你是谁（name/version/description）、
 * 你要注册什么（activate 里通过 api 注册）、你什么时候退出（destroy 清理资源）。
 *
 * 关键设计是 PluginApi —— 插件不直接操作 Agent 内部，而是通过一层受控 API 交互。
 * 若直接把 ToolRegistry 交给插件，它就能删别人的工具、改核心配置、搞崩系统。
 * 以后要给插件更多能力（注册 Channel / Cron / 订阅事件），往 PluginApi 上加方法即可。
 *
 * 对照业界：VS Code 的 vscode API、Webpack 的 compiler 对象、Express 的 app 对象，
 * 都是同一套"控制反转 + 受控 API 层"的思路。
 */

import type { ToolDefinition } from '../tools/registry.js';

export interface PluginConfig {
  [key: string]: string | number | boolean;
}

export interface PluginApi {
  /** 注册工具（会自动加 pluginName__ 前缀防冲突） */
  registerTools(tools: ToolDefinition[]): void;
  /** 取插件配置（${ENV_VAR} 占位符已被替换） */
  getConfig(): PluginConfig;
  /** 带插件名前缀的日志 */
  log(message: string): void;
}

export interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  config?: PluginConfig;

  activate(api: PluginApi): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
