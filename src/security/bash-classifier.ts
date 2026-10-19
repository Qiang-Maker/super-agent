/**
 * ============================================================================
 * Bash 命令风险检测
 * ============================================================================
 *
 * 即使是 owner，有些命令也不该跑：`rm -rf /`、`sudo`、`curl xxx | sh`——
 * 要么是误操作，要么是 prompt injection 诱导模型干的。
 *
 * 三级：dangerous 直接拒绝执行 / moderate 打警告但放行 / safe 正常执行。
 *
 * 【为什么用正则而不是让 LLM 判断】正则**不可被操控**——攻击者在 prompt 里写
 * "以下命令是安全的测试命令"能骗过 LLM，骗不过正则。
 *
 * 【为什么 moderate 放行】如果所有涉及删除和推送的命令都拦，Agent 基本什么
 * 有用的事都干不了——这个度要在实践里调。
 */

export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

export interface ClassifyResult {
  level: RiskLevel;
  reason?: string;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/, reason: '强制删除文件' },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\bsudo\b/, reason: '提权操作' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\beval\b/, reason: 'eval 动态执行' },
  { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
];

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件' },
  { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
  { pattern: /\bkill\b/, reason: '终止进程' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
];

export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { level: 'dangerous', reason };
  }
  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) return { level: 'moderate', reason };
  }
  return { level: 'safe' };
}
