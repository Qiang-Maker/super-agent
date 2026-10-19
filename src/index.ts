/**
 * ============================================================================
 * CLI 入口（路由）
 * ============================================================================
 *
 * index.ts 只做路由，真正的启动逻辑搬到了 main.ts：
 *   pnpm start              → 启动 Agent
 *   pnpm run init           → 交互式配置向导
 *   pnpm run continue       → 恢复上次会话（--continue 透传给 main）
 *
 * package.json 的 bin 字段让这个包能作为 CLI 安装——npm i -g 之后
 * 可以直接用 super-agent start / super-agent init。
 */

const command = process.argv[2];

if (command === 'init') {
  import('./config/init.js').then((m) => m.runInit());
} else {
  import('./main.js').then((m) => m.startAgent().catch(console.error));
}
