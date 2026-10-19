/**
 * ============================================================================
 * ConfigLoader（读取 → 替换 → 校验）
 * ============================================================================
 *
 * 顺序很重要：读取 JSON → 替换 ${ENV_VAR} → Zod 校验 + 默认值合并。
 *
 * 环境变量替换发生在校验之前，所以配置里可以写 "apiKey": "${DASHSCOPE_API_KEY}"——
 * 敏感信息不进配置文件，但配置文件本身依然完整可读、可以安全入 git。
 *
 * 只匹配大写字母+下划线的模式（[A-Z_][A-Z0-9_]*），这是 OpenClaw 也在用的约定：
 * 环境变量统一大写，避免误替换正文里的 ${} 文本。
 */

import fs from 'node:fs';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema.js';

export const CONFIG_FILE = 'super-agent.config.json';

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name) => {
      const val = process.env[name];
      if (val === undefined) {
        console.warn(`  ⚠ 环境变量 ${name} 未设置，保留原值`);
        return match;
      }
      return val;
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置`);
    console.log('  运行 pnpm run init 生成配置文件\n');
    return SuperAgentConfigSchema.parse({});
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`  ✗ 解析 ${path} 失败: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = SuperAgentConfigSchema.safeParse(substituteEnvVars(raw));
  if (!result.success) {
    console.error('  ✗ 配置文件校验失败:');
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}
