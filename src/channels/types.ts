/**
 * ============================================================================
 * Channel 抽象
 * ============================================================================
 *
 * Channel = Agent 跟外界通信的通道。终端是一个 Channel，飞书群是一个，
 * Telegram 是一个，邮件也可以是一个。
 *
 * 每个 Channel 做三件事：接收外部消息 → 转成统一格式 → 把回复发回去。
 * Agent Loop 不关心消息从哪来——它只看到 { role: 'user', content: '...' }。
 *
 * 没有这层抽象，每接一个新消息源都得改核心代码；有了它，加一个 Channel
 * 就是加一个适配器，核心零改动。
 */

export interface IncomingMessage {
  /** 标识会话：飞书里是 chat_id，Telegram 里是 chat.id */
  channelId: string;
  /** 标识发送者 */
  senderId: string;
  senderName: string;
  text: string;
  raw?: unknown;
}

export interface OutgoingMessage {
  channelId: string;
  recipientId: string;
  text: string;
}

export interface ChannelDefinition {
  name: string;
  description: string;

  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  send(message: OutgoingMessage): Promise<void>;

  /** 收到外部消息后调用这个 handler，由 Gateway 统一处理 */
  onMessage?: (handler: (msg: IncomingMessage) => void) => void;
}
