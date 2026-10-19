/**
 * ============================================================================
 * 配置 Schema（Zod）
 * ============================================================================
 *
 * 每个字段都有 .default() —— 用户可以只写一个 {}，所有默认值自动填上。
 * 这就是**配置最小化原则**：配置文件只表达"跟默认不一样的意图"。
 * 想改并发数就写 {"agents":{"maxConcurrent":5}}，其余字段全部走默认。
 *
 * OpenClaw 的配置系统同思路（约 200 个 Zod schema 覆盖所有子系统），
 * 我们规模小得多，但核心模式一样。
 */

import { z } from 'zod';

export const ModelConfigSchema = z.object({
  provider: z.enum(['dashscope', 'openai', 'custom']).default('dashscope'),
  name: z.string().default('qwen-plus-latest'),
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  apiKey: z.string().default(''),
  /**
   * 模型降级链：主模型报"额度用尽 / 无权限 / 不存在"时依次尝试后面的候选。
   *
   * 【默认值里只放有免费额度的模型】按**免费额度到期时间由近到远**排——
   * 先把快到期的额度用掉，避免浪费。清单依据百炼控制台
   * 「费用用量 → 免费额度」，2026-09-23 核对。
   *
   * ⚠️ 不要再往里加没有免费额度的模型。早期默认值的尾巴上挂着
   * qwen-plus / qwen-max / qwen-turbo / qwen-long / deepseek-v3 / qwq-plus，
   * 它们都不在免费额度列表里——主模型一失败，链就会一路降级到它们身上，
   * **悄悄从"免费用"变成"按量付费"**。账单失控就是这么来的。
   * 要用收费模型，请显式写进 super-agent.config.json 的 chain 里，别改默认值。
   *
   * 注意候选用的是 baseURL + apiKey（配置里的 provider），而主模型可以被
   * MODEL_BASE_URL 环境变量覆盖（例如指向本地代理）。
   */
  chain: z
    .array(
      // 字符串 = 用上面这个 provider；对象 = 另一个厂商（自带 baseURL / apiKey）
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          baseURL: z.string(),
          apiKey: z.string().default(''),
        }),
      ]),
    )
    .default([
      'qwen3.7-flash', // 到期 2026-10-23
      'qwen3.7-flash-2026-07-15', // 到期 2026-10-23
      'deepseek-v4-flash-0731', // 到期 2026-10-31
      'qwen3.8-max', // 到期 2026-11-01
      'qwen3.8-2.4t-a95b', // 到期 2026-11-12
      'deepseek-v4-pro-0813', // 到期 2026-11-13
      'qwen3.8-27b', // 到期 2026-11-18
      'kimi-k3', // 到期 2026-11-18
      'glm-5.3', // 到期 2026-11-23
      'qwen3.8-flash', // 到期 2026-11-25
      'qwen3.8-max-0902', // 到期 2026-12-01
      'deepseek-v4.1-flash', // 到期 2026-12-13
      'qwen3.8-omni-flash', // 到期 2026-12-17
    ]),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.string()).prefault({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.prefault({}),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().default(60_000),
});

export const SecurityConfigSchema = z.object({
  defaultRole: z.enum(['owner', 'collaborator', 'guest']).default('owner'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default('docs'),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.prefault({}),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.prefault({}),
  agents: AgentConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
  cron: CronConfigSchema.prefault({}),
  session: SessionConfigSchema.prefault({}),
  usage: UsageConfigSchema.prefault({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
