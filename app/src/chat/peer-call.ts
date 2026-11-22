// When the app's Nexconn VoIP entitlement is off, direct messages carry the
// invitation and SDP privately between the two users. Media stays on WebRTC.
import {
  ChannelType,
  DirectChannel,
  MessageHandler,
  MessageType,
  NCEngine,
  SendTextMessageParams,
} from '@nexconn/chat';

import { callNetwork } from '../create/ice';

interface Signal {
  id: string;
  type: 'invite' | 'accept' | 'offer' | 'answer' | 'bye';
  video?: boolean;
  sdp?: string;
  at: number;
}
interface Session {
  id: string;
  peer: string;
  video: boolean;
  side: 'caller' | 'callee';
  accepted: boolean;
  pc?: RTCPeerConnection;
  media?: MediaStream;
}
export function peerCalls(
  local: HTMLVideoElement,
  remote: HTMLVideoElement,
  ui: {
    invite: (peer: string, video: boolean) => boolean;
    connected: () => void;
    ended: (message: string) => void;
  },
) {
  let current: Session | undefined,
    timer = 0;
  const prefix = 'nearby-call/1 ';
  async function send(s: Session, type: Signal['type'], sdp?: string) {
    const payload: Signal = { id: s.id, type, video: s.video, sdp, at: Date.now() };
    const r = await new DirectChannel(s.peer).sendMessage(
      new SendTextMessageParams({ text: prefix + JSON.stringify(payload) }),
    );
    if (!r.isOk) throw Error('The call invitation could not be delivered.');
  }
  function stop(note: string, notify: boolean) {
    const s = current;
    if (!s) return;
    current = undefined;
    clearTimeout(timer);
    s.media?.getTracks().forEach((t) => t.stop());
    s.pc?.close();
    local.srcObject = remote.srcObject = null;
    if (notify) void send(s, 'bye').catch(() => {});
    ui.ended(note);
  }
  function begin(s: Session) {
    current = s;
    timer = window.setTimeout(() => stop('Call timed out.', true), 45000);
  }
  async function connection(s: Session) {
    const network = await callNetwork();
    if(current!==s)throw Error('Call ended');
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: s.video });
    if (current !== s) {
      media.getTracks().forEach((t) => t.stop());
      throw Error('Call ended');
    }
    const pc = new RTCPeerConnection(network);
    s.media = media;
    s.pc = pc;
    local.srcObject = media;
    media.getTracks().forEach((t) => pc.addTrack(t, media));
    pc.ontrack = (e) => {
      remote.srcObject = e.streams[0];
      void remote.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (current !== s) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(timer);
        ui.connected();
      }
      if (pc.connectionState === 'failed') stop('The media connection failed.', true);
    };
    return pc;
  }
  async function describe(s: Session, pc: RTCPeerConnection, type: 'offer' | 'answer') {
    await pc.setLocalDescription(type === 'offer' ? await pc.createOffer() : await pc.createAnswer());
    // Collect candidates in the SDP to avoid persisting one chat message per candidate.
    if (pc.iceGatheringState !== 'complete')
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout);
          pc.removeEventListener('icegatheringstatechange', changed);
          resolve();
        };
        const changed = () => {
          if (pc.iceGatheringState === 'complete') done();
        };
        const timeout = setTimeout(done, 2200);
        pc.addEventListener('icegatheringstatechange', changed);
      });
    if (current === s) await send(s, type, pc.localDescription!.sdp);
  }
  async function receive(peer: string, m: Signal) {
    if (!m || typeof m.id !== 'string' || !Number.isFinite(m.at) || Math.abs(Date.now() - m.at) > 60000) return;
    if (m.type === 'invite') {
      if (current || !ui.invite(peer, m.video === true)) return;
      begin({ id: m.id, peer, video: m.video === true, side: 'callee', accepted: false });
      return;
    }
    const s = current;
    if (!s || s.peer !== peer || s.id !== m.id) return;
    try {
      if (m.type === 'bye') {
        stop('Call ended.', false);
        return;
      }
      if (m.type === 'accept' && s.side === 'caller' && !s.accepted) {
        s.accepted = true;
        await describe(s, await connection(s), 'offer');
      } else if (
        m.type === 'offer' &&
        s.side === 'callee' &&
        s.accepted &&
        s.pc &&
        !s.pc.remoteDescription &&
        m.sdp
      ) {
        await s.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await describe(s, s.pc, 'answer');
      } else if (
        m.type === 'answer' &&
        s.side === 'caller' &&
        s.pc?.signalingState === 'have-local-offer' &&
        m.sdp
      ) {
        await s.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      }
    } catch {
      if (current === s) stop('Could not connect. Check media permissions and network access.', true);
    }
  }
  NCEngine.addMessageHandler(
    'nearby-peer-calls',
    new MessageHandler({
      onMessageReceived({ messages }) {
        for (const m of messages) {
          if (
            m.channelIdentifier.channelType !== ChannelType.DIRECT ||
            m.messageType !== MessageType.TEXT ||
            !m.content.text.startsWith(prefix)
          )
            continue;
          try {
            void receive(m.senderUserId, JSON.parse(m.content.text.slice(prefix.length)));
          } catch {
            /* ignore unrelated content */
          }
        }
      },
    }),
  );
  addEventListener('pagehide', () => stop('Call ended.', true));
  return {
    get active() {
      return !!current;
    },
    async start(peer: string, video: boolean) {
      const s: Session = { id: crypto.randomUUID(), peer, video, side: 'caller', accepted: false };
      begin(s);
      try {
        await send(s, 'invite');
      } catch {
        if (current === s) stop('Invitation delivery failed.', false);
      }
    },
    async accept() {
      const s = current;
      if (!s || s.side !== 'callee' || s.accepted) return;
      s.accepted = true;
      try {
        await connection(s);
        if (current === s) await send(s, 'accept');
      } catch {
        if (current === s) stop('Could not open your camera or microphone.', true);
      }
    },
    end: () => stop('Call ended.', true),
    enable(mic: boolean, on: boolean) {
      const tracks = mic ? current?.media?.getAudioTracks() : current?.media?.getVideoTracks();
      tracks?.forEach((t) => {
        t.enabled = on;
      });
    },
  };
}
