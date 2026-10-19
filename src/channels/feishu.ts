/**
 * ============================================================================
 * 飞书 Bot 适配器（长连接模式）
 * ============================================================================
 *
 * 【两种接法】传统 webhook 回调需要公网域名（还得配 ngrok 内网穿透）；
 * 飞书 SDK 的**长连接模式**由我们的服务主动连飞书 WebSocket，消息实时推过来，
 * 本地就能跑，不需要公网域名。
 *
 * 【没配飞书也能测】start() 里先起一个 Hono HTTP 服务当 Dashboard：
 *   GET  /                 状态面板（含"发送测试消息"表单）
 *   POST /webhook/feishu   模拟飞书事件回调，用 curl 就能把整条链路跑通
 *
 * 【接真实 Bot 的步骤】飞书开放平台创建自建应用（推荐用「创建飞书智能体应用」
 * 一键预置权限）→ 拿 App ID / App Secret 填进 .env（FEISHU_APP_ID / FEISHU_APP_SECRET）
 * → 「事件与回调」里选长连接模式 → 启动后点"重新验证"看到连接成功即可。
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ChannelDefinition, IncomingMessage, OutgoingMessage } from './types.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  port: number;
}

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu';
  description = '飞书 Bot 消息通道（长连接模式，未配 App ID 时仅启动 Dashboard）';

  private config: FeishuConfig;
  private messageHandler?: (msg: IncomingMessage) => void;
  private httpServer?: { close: (cb?: () => void) => void };
  private wsClient?: any;
  private larkClient?: any;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    await this.startDashboard();

    if (!this.config.appId || !this.config.appSecret) {
      console.log('    飞书未配置，仅启动 Dashboard（浏览器打开 http://localhost:' + this.config.port + ' 可测）');
      return;
    }

    try {
      // 动态 import：没装 SDK 或没配凭据时不影响其他 Channel
      const lark: any = await import('@larksuiteoapi/node-sdk');

      this.larkClient = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });

      const dispatcher = new lark.EventDispatcher({});
      dispatcher.register({
        'im.message.receive_v1': (data: any) => {
          if (data?.message?.message_type !== 'text') return;
          const content = JSON.parse(data.message.content || '{}');
          let text = content.text || '';
          // 去掉 @Bot 的 mention 标记
          if (data.message.mentions) {
            for (const m of data.message.mentions) text = text.replace(m.key, '').trim();
          }
          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: data.message.chat_id,
              senderId: data.sender?.sender_id?.open_id || 'unknown',
              senderName: data.sender?.sender_id?.open_id || 'unknown',
              text,
              raw: data,
            });
          }
        },
      });

      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
      console.log('    飞书长连接已建立（无需公网域名）');
    } catch (err: any) {
      console.error(`    飞书长连接启动失败: ${err?.message || err}`);
      console.error('    （Dashboard 仍可用，可先用它测试完整链路）');
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.wsClient) await this.wsClient.stop?.();
    } catch {
      /* ignore */
    }
    if (this.httpServer) this.httpServer.close();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.larkClient) {
      console.log(`    [feishu] 未配置飞书，跳过发送: ${message.text.slice(0, 60)}`);
      return;
    }
    await this.larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: message.channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: message.text }),
      },
    });
  }

  /** Dashboard：状态面板 + 模拟 webhook，没配飞书也能把链路跑通 */
  private async startDashboard(): Promise<void> {
    const app = new Hono();

    app.get('/', (c) =>
      c.html(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Super Agent Channel</title></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">
  <h1>Channel Dashboard</h1>
  <p>飞书通道状态：<b>${this.config.appId ? '已配置（长连接）' : '未配置（Dashboard 模式）'}</b></p>
  <h2>发送测试消息</h2>
  <form id="f">
    <input id="t" style="width:70%;padding:8px" placeholder="例如：数据库里有哪些表" />
    <button style="padding:8px 16px">发送</button>
  </form>
  <pre id="out" style="background:#f6f6f6;padding:12px;margin-top:16px;white-space:pre-wrap"></pre>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = document.getElementById('t').value;
      const r = await fetch('/webhook/feishu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'dashboard-chat' },
            sender: { sender_id: { open_id: 'dashboard-user' } },
          },
        }),
      });
      document.getElementById('out').textContent = '已投递：' + text + '\\n（回复见运行 Agent 的终端）';
    });
  </script>
</body></html>`),
    );

    app.post('/webhook/feishu', async (c) => {
      const body: any = await c.req.json().catch(() => ({}));
      const ev = body?.event;
      const text = JSON.parse(ev?.message?.content || '{}').text || '';
      if (text && this.messageHandler) {
        this.messageHandler({
          channelId: ev?.message?.chat_id || 'unknown',
          senderId: ev?.sender?.sender_id?.open_id || 'unknown',
          senderName: ev?.sender?.sender_id?.open_id || 'unknown',
          text,
          raw: body,
        });
      }
      return c.json({ ok: true });
    });

    await new Promise<void>((resolve) => {
      const server: any = serve({ fetch: app.fetch, port: this.config.port }, () => {
        console.log(`    Dashboard: http://localhost:${this.config.port}`);
        resolve();
      });
      // 端口被占用等监听失败不能把整个 Agent 带崩——降级为"没有 Dashboard"继续跑
      server.on?.('error', (err: any) => {
        console.error(
          `    Dashboard 启动失败（${err?.code || err?.message}）——端口 ${this.config.port} 可能被占用；Channel 仍可继续运行`,
        );
        resolve();
      });
      this.httpServer = server;
    });
  }
}
