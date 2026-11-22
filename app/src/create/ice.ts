const stun: RTCIceServer = {urls:'stun:stun.l.google.com:19302'};

export async function callNetwork(): Promise<RTCConfiguration> {
  try {
    const r = await fetch('/api/audio/network', {cache:'no-store',signal:AbortSignal.timeout(2000)});
    if(r.ok) {
      const {relay} = await r.json() as {relay?:RTCIceServer};
      if(relay) return {iceServers:[stun,relay]};
    }
  } catch { /* Local calls can still use a direct connection. */ }
  return {iceServers:[stun]};
}
