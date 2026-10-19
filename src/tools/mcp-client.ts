/**
 * ============================================================================
 * MCP Client (手写 JSON-RPC over stdio)
 * ============================================================================
 *
 * 【MCP 在传输层到底是什么】
 * 通信协议是 JSON-RPC 2.0，传输方式支持 stdio 与 Streamable HTTP。
 * 这里用 stdio：启动一个本地进程，用 stdin 发消息、stdout 收消息。整个交互三步：
 *
 *   1. 握手     —— Client 发 initialize，Server 回它支持的能力
 *   2. 发现工具 —— Client 发 tools/list，Server 返回工具名 / 描述 / 参数 Schema
 *   3. 调用工具 —— Client 发 tools/call，Server 执行并返回结果
 *
 * 【为什么不直接用官方 SDK】
 * 一是官方 SDK 依赖多、体积大；二是手写一遍才能看清 MCP 没有魔法——
 * 就是 JSON-RPC + 一个 pending Map 做 id 匹配。生产环境换官方 SDK 时，
 * ToolRegistry 的 registerMCPServer 几乎不用改（方法名都一样）。
 *
 * 【MockMCPClient 的用途】
 * 没有 GitHub token、或环境不支持 spawn 进程时降级用它，
 * 返回预设的 GitHub 数据，保证整条链路（发现 → 注册 → 调用 → 截断）能跑通。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** MCPClient 与 MockMCPClient 共同实现的接口——上层不关心底层是真连接还是 mock */
export interface MCPClientLike {
  connect(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export class MCPClient implements MCPClientLike {
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private serverName: string;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
  }

  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      // Windows 上 npx 实际是 npx.cmd，不过 shell 会直接 spawn ENOENT（实测踩到）
      shell: process.platform === 'win32',
    });

    this.process.on('error', (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`);
    });
    // Server 的 stderr 里会有启动日志，这里吞掉避免刷屏
    this.process.stderr?.on('data', () => {});

    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        /* 非 JSON 行直接忽略 */
      }
    });

    // 首次启动时 npx 要先下载整个包（可能几十秒），所以 initialize 用更长的超时
    await this.send(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'super-agent', version: '0.5.0' },
      },
      120_000,
    );

    this.process.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }

  /**
   * 发一条 JSON-RPC 请求并等它的响应
   *
   * 关键点：请求和响应是异步交错的，可能乱序到达——所以必须靠 id 在
   * pending Map 里匹配，不能用"发一个等一个"的同步模式。
   * 15 秒超时是必须的：Server 卡住时不能让整个 Agent 一起挂等。
   */
  private send(method: string, params?: any, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process!.stdin!.write(msg + '\n');
    });
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {});
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result: MCPCallResult = await this.send('tools/call', { name, arguments: args });
    const texts = (result.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text!);
    return texts.join('\n') || '(无返回内容)';
  }

  async close(): Promise<void> {
    if (this.rl) this.rl.close();
    if (this.process) this.process.kill();
  }
}

/**
 * 降级用的 Mock MCP Client
 *
 * 没有 GITHUB_PERSONAL_ACCESS_TOKEN、或环境不支持 spawn 时使用。
 * 返回预设数据，让「发现工具 → 注册 → 调用 → 截断」整条链路照样能演示。
 */
export class MockMCPClient implements MCPClientLike {
  async connect(): Promise<void> {}

  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'list_issues',
        description: '列出 GitHub 仓库的 Issues',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'search_repositories',
        description: '搜索 GitHub 仓库',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_file_contents',
        description: '获取仓库中文件的内容',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: '仓库所有者' },
            repo: { type: 'string', description: '仓库名称' },
            path: { type: 'string', description: '文件路径' },
          },
          required: ['owner', 'repo', 'path'],
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_issues':
        return JSON.stringify(
          [
            { number: 42, title: '支持 MCP 协议接入', state: 'open' },
            { number: 41, title: '循环检测阈值可配置化', state: 'open' },
            { number: 39, title: 'Token 预算用完后的优雅降级', state: 'closed' },
          ],
          null,
          2,
        );
      case 'search_repositories':
        return JSON.stringify(
          [
            { full_name: 'anthropics/anthropic-sdk-python', stars: 2800 },
            { full_name: 'vercel/ai', stars: 12000 },
            { full_name: 'modelcontextprotocol/servers', stars: 5600 },
          ],
          null,
          2,
        );
      case 'get_file_contents':
        return `# README\n\nMock file: ${args.owner}/${args.repo}/${args.path}`;
      default:
        return `未知工具: ${name}`;
    }
  }

  async close(): Promise<void> {}
}
