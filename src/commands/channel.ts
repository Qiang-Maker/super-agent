/**
 * ============================================================================
 * Channel 快捷命令
 * ============================================================================
 *
 * /channel 或 /channel list —— 列出已注册的通道
 */

import type { CommandHandler } from './index.js';
import type { ChannelGateway } from '../channels/gateway.js';

export function createChannelCommands(gateway: ChannelGateway): CommandHandler[] {
  return [
    (cmd) => {
      if (cmd !== '/channel' && cmd !== '/channel list') return false;

      const channels = gateway.list();
      if (channels.length === 0) {
        console.log('\n[channels] 没有注册的通道。\n');
        return true;
      }

      console.log('\n[channels]');
      for (const ch of channels) {
        console.log(`  ${ch.name} — ${ch.description}`);
      }
      console.log('');
      return true;
    },
  ];
}
