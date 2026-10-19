/**
 * ============================================================================
 * ChannelGateway（消息路由中枢）
 * ============================================================================
 *
 * 注册所有 Channel，统一处理消息路由：任何 Channel 收到消息 → 丢给 Agent Loop
 * → 拿到回复 → 通过同一个 Channel 发回去。
 *
 * 【会话隔离】sessions 的 key 是 `channelName:senderId`——每个 Channel + 发送者
 * 组合维护独立对话历史。飞书群里张三问的问题不会出现在李四的上下文里。
 *
 * 【复用 Agent Loop】跑的就是同一套推理引擎、工具、system prompt——
 * 终端里调好的能力（记忆 / RAG / Skill / Plugin），飞书群里自动可用。
 */

import type { ModelMessage } from 'ai';
import type { ChannelDefinition, IncomingMessage } from './types.js';

export interface GatewayOptions {
  /** 每轮重建 system prompt（与终端共用同一套 Prompt Pipe） */
  buildSystem: () => string;
  /** 跑一轮对话：把 text 作为用户输入交给 Agent Loop，返回最终回复文本 */
  runTurn: (sessionMessages: ModelMessage[], text: string) => Promise<string>;
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>();
  private sessions = new Map<string, ModelMessage[]>();
  private options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  register(channel: ChannelDefinition): void {
    this.channels.set(channel.name, channel);
    channel.onMessage?.((msg: IncomingMessage) => {
      void this.handleIncoming(channel.name, msg);
    });
  }

  async startAll(): Promise<void> {
    for (const [name, ch] of this.channels) {
      try {
        await ch.start();
        console.log(`  [gateway] ✓ ${name} 已启动`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [gateway] ✗ ${name} 启动失败: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [, ch] of this.channels) {
      try {
        await ch.stop();
      } catch {
        /* 单个 Channel 关闭失败不影响其他 */
      }
    }
  }

  /** 供测试与调试：直接投递一条入站消息 */
  async handleIncoming(channelName: string, msg: IncomingMessage): Promise<void> {
    const sessionKey = `${channelName}:${msg.senderId}`;
    console.log(`\n  [${channelName}] ${msg.senderName}: ${msg.text}`);

    let messages = this.sessions.get(sessionKey);
    if (!messages) {
      messages = [];
      this.sessions.set(sessionKey, messages);
    }

    let replyText = '';
    try {
      replyText = await this.options.runTurn(messages, msg.text);
    } catch (err: any) {
      replyText = `处理失败: ${err?.message || err}`;
    }

    if (replyText) {
      const channel = this.channels.get(channelName);
      if (channel) {
        // 发送失败（群被解散、chat_id 失效、网络抖动）只吞掉这一条回复，
        // 不能让一个未捕获的 rejection 把整个 Agent 进程带走
        try {
          await channel.send({
            channelId: msg.channelId,
            recipientId: msg.senderId,
            text: replyText,
          });
          console.log(
            `  [${channelName}] → ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`,
          );
        } catch (err: any) {
          console.error(`  [${channelName}] 发送失败: ${err?.message || err}`);
        }
      }
    }
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      description: ch.description,
    }));
  }
}
