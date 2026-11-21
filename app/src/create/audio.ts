// Small-group live audio: a WebRTC mesh (up to 6 people). The app server only
// relays the connection handshake (server/places.ts); audio flows peer to peer.
// The handshake stream ends before the server's time limit with a "reconnect"
// event; the session then reopens it with the same peer id, keeping its calls.

export interface Participant { peer: string; name: string; state: string; level: number; me?: boolean; muted?: boolean; role?: 'speaker' | 'listener' }

const ICE: RTCConfiguration = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

export class AudioSession {
  readonly peerId = crypto.randomUUID();
  participants = new Map<string, Participant>();
  muted = false;
  private local?: MediaStream;
  private peers = new Map<string, RTCPeerConnection>();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private players = new Map<string, HTMLAudioElement>();
  private meters = new Map<string, AnalyserNode>();
  private context?: AudioContext;
  private abort = new AbortController();
  private timer = 0;

  private volume = 1;

  /** mode 'listen' joins receive-only: no microphone, and everyone sees "(listening)" next to the name. */
  constructor(private id: string, private name: string, private onChange: (session: AudioSession, note?: string) => void,
    readonly mode: 'speak' | 'listen' = 'speak') {}

  /** Playback volume for everyone in the session, 0..1 (used for distance fading). */
  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    for (const player of this.players.values()) player.volume = this.volume;
  }

  async join() {
    const listening = this.mode === 'listen';
    if (!listening) {
      try {
        this.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        throw new Error('Microphone access is needed to join. Allow it in your browser and try again.');
      }
    }
    this.context = new AudioContext();
    this.participants.set(this.peerId, { peer: this.peerId, name: this.name + (listening ? ' (listening, you)' : ' (you)'),
      state: 'connected', level: 0, me: true, role: listening ? 'listener' : 'speaker' });
    if (this.local) this.meter(this.peerId, this.local);
    await this.open();
    this.timer = window.setInterval(() => this.levels(), 120);
    this.onChange(this);
    addEventListener('pagehide', this.goodbye);
  }

  private reconnecting = false;
  private async open() {
    const role = this.mode === 'listen' ? '&role=listener' : '';
    const response = await fetch(`/api/audio/${this.id}/stream?peer=${this.peerId}&name=${encodeURIComponent(this.name)}${role}`, { signal: this.abort.signal });
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      this.leave();
      throw new Error(error.error || 'Could not join this session.');
    }
    void this.read(response.body);
  }

  /** Tell the others right away when the tab closes. */
  private goodbye = () => {
    navigator.sendBeacon?.(`/api/audio/${this.id}/leave`, new Blob([JSON.stringify({ peer: this.peerId })], { type: 'application/json' }));
  };

  private async read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1];
          if (event && data) void this.handle(event, JSON.parse(data));
        }
      }
    } catch { /* left or network dropped */ }
    if (this.abort.signal.aborted) return;
    if (this.reconnecting) {
      this.reconnecting = false;
      try { await this.open(); return; } catch { /* fall through */ }
    }
    this.leave(); this.onChange(this, 'Disconnected from the session.');
  }

  private async handle(event: string, data: any) {
    if (event === 'reconnect') {
      this.reconnecting = true;
    } else if (event === 'welcome') {
      // The newcomer calls everyone already in the room (after a reconnect, only people it has no call with).
      // Listeners only call speakers: two listeners have nothing to send each other.
      for (const { peer, name, role } of data.peers) {
        if (this.peers.has(peer)) continue;
        this.add(peer, name, role);
        if (this.mode === 'listen' && role === 'listener') continue;
        await this.call(peer);
      }
    } else if (event === 'join') {
      this.add(data.peer, data.name, data.role);
    } else if (event === 'leave') {
      this.drop(data.peer);
    } else if (event === 'signal') {
      await this.signal(data.from, data.data);
    }
    this.onChange(this);
  }

  private add(peer: string, name: string, role: 'speaker' | 'listener' = 'speaker') {
    const idle = this.mode === 'listen' && role === 'listener';
    if (!this.participants.has(peer)) this.participants.set(peer, { peer, name, state: idle ? 'listening' : 'connecting', level: 0, role });
  }

  private connection(peer: string) {
    let pc = this.peers.get(peer);
    if (pc) return pc;
    pc = new RTCPeerConnection(ICE);
    this.peers.set(peer, pc);
    this.local?.getTracks().forEach(track => pc!.addTrack(track, this.local!));
    pc.onicecandidate = ({ candidate }) => { if (candidate) void this.send(peer, { ice: candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      const p = this.participants.get(peer);
      if (p) { p.state = pc!.connectionState; this.onChange(this); }
    };
    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      let player = this.players.get(peer);
      if (!player) { player = new Audio(); player.autoplay = true; player.volume = this.volume; this.players.set(peer, player); }
      player.srcObject = stream;
      void player.play().catch(() => undefined);
      this.meter(peer, stream);
    };
    return pc;
  }

  private async call(peer: string) {
    const pc = this.connection(peer);
    // Without a microphone track the offer needs an explicit receive-only audio line.
    if (!this.local) pc.addTransceiver('audio', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await this.send(peer, { sdp: pc.localDescription });
  }

  private async signal(peer: string, data: any) {
    if (!this.participants.has(peer)) this.add(peer, 'Neighbour');
    const pc = this.connection(peer);
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const candidate of this.pending.get(peer) ?? []) await pc.addIceCandidate(candidate).catch(() => undefined);
      this.pending.delete(peer);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        await this.send(peer, { sdp: pc.localDescription });
      }
    } else if (data.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => undefined);
      else this.pending.set(peer, [...(this.pending.get(peer) ?? []), data.ice]);
    }
  }

  private send(to: string, data: unknown) {
    return fetch(`/api/audio/${this.id}/signal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.peerId, to, data }),
    }).catch(() => undefined);
  }

  private meter(peer: string, stream: MediaStream) {
    if (!this.context) return;
    try {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 256;
      this.context.createMediaStreamSource(stream).connect(analyser);
      this.meters.set(peer, analyser);
    } catch { /* metering is optional */ }
  }

  private levels() {
    const buffer = new Uint8Array(128);
    for (const [peer, analyser] of this.meters) {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += ((v - 128) / 128) ** 2;
      const p = this.participants.get(peer);
      if (p) p.level = p.me && this.muted ? 0 : Math.min(1, Math.sqrt(sum / buffer.length) * 6);
    }
    this.onChange(this);
  }

  private drop(peer: string) {
    this.peers.get(peer)?.close();
    this.peers.delete(peer);
    this.players.get(peer)?.remove();
    this.players.delete(peer);
    this.meters.delete(peer);
    this.participants.delete(peer);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.local?.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
    const me = this.participants.get(this.peerId);
    if (me) me.muted = this.muted;
    this.onChange(this);
  }

  leave() {
    removeEventListener('pagehide', this.goodbye);
    if (!this.abort.signal.aborted) this.goodbye();
    this.abort.abort();
    clearInterval(this.timer);
    for (const peer of [...this.peers.keys()]) this.drop(peer);
    this.local?.getTracks().forEach(track => track.stop());
    void this.context?.close().catch(() => undefined);
    this.participants.clear();
  }
}
