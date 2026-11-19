// The only file that talks to the Nexconn Chat SDK for Web (@nexconn/chat).
// Docs: https://docs.nexconn.ai/chatsdk-web.md  (open channels: /chatsdk-web/open-channel/join.md)
import {
  ChannelType, ConnectionStatusHandler, MessageHandler, MessageType, NCEngine, OpenChannel, SendTextMessageParams,
} from '@nexconn/chat';
import type { Message, TextMessageContent } from '@nexconn/chat';
import type { ChatIdentity, ChatMessage, ChatService } from './types';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

const toMsg = (m: Message<TextMessageContent>): ChatMessage => ({
  id: m.messageId, roomId: m.channelIdentifier.channelId, userId: m.senderUserId,
  name: m.content.senderUserInfo?.name || m.senderUserId, text: m.content.text, at: m.sentTime,
});

export function createNexconnChat(appKey: string): ChatService {
  NCEngine.initialize({ appKey });
  let me: ChatIdentity | null = null;
  let channel: OpenChannel | null = null;
  let listener: ((m: ChatMessage) => void) | null = null;

  NCEngine.addMessageHandler('nearby', new MessageHandler({
    onMessageReceived({ messages }) {
      for (const m of messages) {
        if (m.channelIdentifier.channelType !== ChannelType.OPEN || m.messageType !== MessageType.TEXT) continue;
        if (channel && m.channelIdentifier.channelId === channel.channelId) listener?.(toMsg(m));
      }
    },
  }));
  NCEngine.addConnectionStatusHandler('nearby', new ConnectionStatusHandler({
    onConnectionStatusChanged({ status, code }) { console.info('[nexconn] status', status, code); },
  }));

  return {
    mode: 'nexconn',
    label: 'live on Nexconn',
    async connect(who) {
      if (me?.userId === who.userId) return;
      if (me) await NCEngine.disconnect();
      const { token } = await post<{ token: string }>('/api/nexconn/token', who);
      const r = await NCEngine.connect({ token });
      if (!r.isOk) throw new Error(`Nexconn connect failed, code ${r.code}`);
      me = who;
    },
    async ensureRoom(roomId) { await post('/api/nexconn/room', { channelId: roomId }); },
    async join(roomId, onMessage) {
      if (channel) await channel.exitChannel();
      await this.ensureRoom(roomId);
      channel = new OpenChannel(roomId);
      listener = onMessage;
      // The SDK delivers the last messages through the message handler after entering.
      const r = await channel.enterChannel({ messageCount: 20 });
      if (!r.isOk) throw new Error(`Could not enter room, code ${r.code}`);
      return [];
    },
    async leave() { await channel?.exitChannel(); channel = null; listener = null; },
    async send(roomId, text) {
      if (!me || !channel || channel.channelId !== roomId) throw new Error('not in this room');
      const r = await channel.sendMessage(new SendTextMessageParams({ text, senderUserInfo: { userId: me.userId, name: me.name } }));
      if (!r.isOk || !r.data) throw new Error(`Send failed, code ${r.code}`);
      return toMsg(r.data as Message<TextMessageContent>);
    },
  };
}
