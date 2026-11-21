import {
  AreaCode, ChannelType, ConnectionStatus, ConnectionStatusHandler, Helper, MessageHandler, MessageType,
  NCEngine, OpenChannel, OpenChannelHandler, OpenChannelMetadataOperationType, SendTextMessageParams,
} from '@nexconn/chat';
import type { Message } from '@nexconn/chat';
import type { ChatIdentity, ChatMessage, ChatService, RoomEvents } from './types';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch('/api/nexconn/' + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Nexconn request failed');
  return data;
}

function decode(m: Message): ChatMessage | undefined {
  if (m.channelIdentifier.channelType !== ChannelType.OPEN || (m.messageType !== MessageType.TEXT && m.messageType !== MessageType.IMAGE)) return;
  return {id:m.messageId, roomId:m.channelIdentifier.channelId, userId:m.senderUserId,
    name:m.content.senderUserInfo?.name || m.senderUserId, at:m.sentTime,
    text:m.messageType === MessageType.TEXT ? m.content.text : '', image:m.messageType === MessageType.IMAGE ? m.content.remoteUrl : undefined};
}

export function createNexconnChat(appKey: string, region: keyof typeof AreaCode): ChatService {
  NCEngine.initialize({appKey, areaCode:AreaCode[region]});
  let me: ChatIdentity;
  let channel: OpenChannel | null = null;
  let events: RoomEvents | null = null;
  let values: Record<string,string> = {};
  let version = 0;
  let history: ReturnType<typeof OpenChannel.createOpenChannelMessagesQuery> | undefined;
  async function sync(target: OpenChannel) {
    const snapshot = ++version;
    try {
      const r = await target.getMetadata();
      if (target !== channel || snapshot !== version) return;
      if (!r.isOk) throw new Error();
      values = {...r.data};
      events?.metadata(values);
    } catch { if (target === channel && snapshot === version) events?.metadataError(); }
  }
  NCEngine.addOpenChannelHandler('nearby', new OpenChannelHandler({
    onEntered({channelId,response}) {
      if (channelId !== channel?.channelId) return;
      events?.availability(true);
      events?.presence(response.participantCount);
      void sync(channel);
    },
    onParticipantChanged({channelId,participantCount}) { if (channelId === channel?.channelId) events?.presence(participantCount); },
    onMetadataSynced({channelId}) { if (channelId === channel?.channelId) void sync(channel); },
    onMetadataChanged({changeInfo}) {
      for (const item of changeInfo) {
        if (item.channelId !== channel?.channelId) continue;
        if (item.operationType === OpenChannelMetadataOperationType.REMOVE) delete values[item.key];
        else values[item.key] = item.value;
      }
      if (channel && changeInfo.some(item => item.channelId === channel?.channelId)) {
        events?.metadata({...values});
        void sync(channel);
      }
    },
    onEnterFailed({channelId,code}) { if (channelId === channel?.channelId) events?.availability(false, 'Join failed (' + code + ')'); },
    onChannelDestroyed({channelId}) { if (channelId === channel?.channelId) events?.availability(false, 'Room expired'); },
  }));
  NCEngine.addMessageHandler('nearby', new MessageHandler({
    onMessageReceived({messages}) {
      for (const raw of messages) {
        const msg = decode(raw);
        if (msg && msg.roomId === channel?.channelId) events?.message(msg);
      }
    },
  }));
  NCEngine.addConnectionStatusHandler('nearby', new ConnectionStatusHandler({
    onConnectionStatusChanged({status}) {
      if (status !== ConnectionStatus.CONNECTED) events?.availability(false, status === ConnectionStatus.DISCONNECTED ? 'Disconnected' : 'Reconnecting…');
    },
  }));
  function current(id: string) {
    if (!channel || channel.channelId !== id) throw new Error('Room changed');
    return channel;
  }
  return {
    mode:'nexconn',
    async connect(who) {
      if (me && NCEngine.getConnectionStatus() === ConnectionStatus.CONNECTED) {
        me = {...me,name:who.name}; return me;
      }
      const {token} = await post<{token:string}>('token', {name:who.name});
      const r = await NCEngine.connect({token});
      if (!r.isOk || !r.data) throw new Error('Connect failed (' + r.code + ')');
      me = {name:who.name, userId:r.data.userId};
      return me;
    },
    async join(room, callbacks) {
      await post('room', {channelId:room.id});
      channel = new OpenChannel(room.id);
      events = callbacks; values = {};
      const r = await channel.enterChannel({messageCount:30});
      if (!r.isOk) throw new Error('Join failed (' + r.code + ')');
      if (r.data) callbacks.presence(r.data.participantCount);
      callbacks.availability(true);
      void sync(channel);
    },
    async leave() {
      const previous = channel;
      channel = null; events = null; history = undefined;
      if (previous) await previous.exitChannel();
    },
    async send(id,text,file) {
      const senderUserInfo = {userId:me.userId, name:me.name};
      const target = current(id);
      const send = async () => {
        if (!file) return target.sendMessage(new SendTextMessageParams({text,senderUserInfo}));
        const prepared = await Helper.createSendImageMessageParams(file);
        if (!prepared.isOk || !prepared.data) throw new Error('Could not prepare photo');
        prepared.data.content.senderUserInfo = senderUserInfo;
        return current(id).sendMediaMessage(prepared.data);
      };
      const r = await send();
      if (!r.isOk || !r.data) throw new Error('Send failed (' + r.code + ')');
      return decode(r.data)!;
    },
    async earlier(id,before) {
      current(id);
      history ??= OpenChannel.createOpenChannelMessagesQuery({channelId:id, pageSize:30, isAscending:false, startTime:before});
      const query = history;
      const r = await query.loadNextPage();
      if (!r.isOk || !r.data) throw new Error('History unavailable (' + r.code + ')');
      return {messages:r.data.data.map(decode).filter((m): m is ChatMessage => !!m), more:query.hasNext && r.data.data.length > 0};
    },
    async write(id,key,value) {
      const target = current(id);
      const r = value === null ? await target.deleteMetadata({keys:[key]}) :
        await target.setMetadata({metadata:{[key]:value}, deleteWhenLeft:false, overwrite:false});
      if (!r.isOk) throw new Error('Room update failed (' + r.code + ')');
      if (channel === target) {
        if (value === null) delete values[key]; else values[key] = value;
        ++version;
        events?.metadata({...values});
        void sync(target);
      }
    },
  };
}
