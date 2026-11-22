import { NCCallCode, NCCallEngine, NCCallMediaType, NCCallType } from '@nexconn/call';
import './calls.css';
import { peerCalls } from './peer-call';

type Phase = 'choose' | 'ringing' | 'incoming' | 'connecting' | 'connected' | 'ended';
export function setupCalls() {
  const engine = NCCallEngine.initialize({});
  const dialog = document.createElement('dialog');
  dialog.className = 'nearby-call';
  dialog.setAttribute('aria-labelledby','nearby-call-title');
  dialog.innerHTML = `<h2 id="nearby-call-title">Call</h2><p role="status"></p>
    <div class="call-views" hidden><video playsinline autoplay></video><video playsinline autoplay muted></video></div>
    <footer><button data-action="voice">Voice call</button><button data-action="video">Video call</button>
    <button data-action="mic">Mute</button><button data-action="camera">Camera off</button>
    <button data-action="accept">Accept</button><button data-action="end">Close</button></footer>`;
  document.body.append(dialog);
  const title = dialog.querySelector('h2')!, status = dialog.querySelector('p')!;
  const views = dialog.querySelector<HTMLElement>('.call-views')!;
  const [remote,local] = dialog.querySelectorAll('video');
  let phase: Phase = 'ended', peer = '', callId = '', video = false, generation = 0;
  let micOn = true, cameraOn = true;
  function draw(next: Phase, message: string) {
    phase = next;
    status.textContent = message;
    for (const b of dialog.querySelectorAll('button')) {
      const action = b.dataset.action;
      switch (action) {
        case 'accept': b.hidden = phase !== 'incoming'; break;
        case 'mic': b.hidden = phase !== 'connected'; b.textContent = micOn ? 'Mute' : 'Unmute'; break;
        case 'camera': b.hidden = phase !== 'connected' || !video; b.textContent = cameraOn ? 'Camera off' : 'Camera on'; break;
        case 'end': b.hidden = false; break;
        default: b.hidden = phase !== 'choose';
      }
      if (action === 'end') b.textContent = phase === 'incoming' ? 'Decline' : phase === 'ended' || phase === 'choose' ? 'Close' : 'Hang up';
    }
    views.hidden = !video || phase !== 'connected';
    if (!dialog.open) dialog.showModal();
  }
  const fallback=peerCalls(local,remote,{
    invite(id,withVideo){
      if(dialog.open && !['choose','ended'].includes(phase)) return false;
      peer=id;video=withVideo;++generation;
      title.textContent=video?'Incoming video call':'Incoming voice call';
      draw('incoming',video?'Accept to share your camera and microphone.':'Accept to share your microphone.');return true;
    },
    connected(){micOn=cameraOn=true;draw('connected','Connected');},
    ended(message){finish(message,false);}
  });
  function finish(message: string,native=true) {
    generation++;
    if (native && video && peer) engine.removeVideoView([peer]);
    local.srcObject = remote.srcObject = null;
    callId = '';
    draw('ended',message);
  }
  async function end() {
    if (phase === 'ended' || phase === 'choose') { dialog.close(); return; }
    if(fallback.active){fallback.end();return;}
    const seq = ++generation;
    try {
      const result = await engine.endCall(callId ? {callId} : {});
      if (seq !== generation) return;
      if (result.code !== 0 && result.code !== NCCallCode.NOT_IN_CALL) throw new Error();
      finish('Call ended.');
    } catch { if (seq === generation) status.textContent = 'Could not end the call. Try again.'; }
  }
  async function start(withVideo: boolean) {
    video = withVideo;
    const seq = ++generation;
    draw('ringing','Waiting for them to accept…');
    try {
      const result = await engine.startCall({calleeIds:[peer],callType:NCCallType.SINGLE,
        mediaType: video ? NCCallMediaType.AUDIO_VIDEO : NCCallMediaType.AUDIO});
      if (seq !== generation) {
        if (result.callId) void engine.endCall({callId:result.callId});
        return;
      }
      if(result.code===NCCallCode.VOIP_SERVICE_UNAVAILABLE){await fallback.start(peer,video);return;}
      if (result.code !== NCCallCode.SUCCESS || !result.callId) {
        finish('Could not start this call (Nexconn ' + result.code + ').');
        return;
      }
      callId = result.callId;
    } catch { if (seq === generation) finish('Call unavailable. Check your connection and media permissions.'); }
  }
  async function accept() {
    const seq = generation;
    draw('connecting','Connecting…');
    if(fallback.active){await fallback.accept();return;}
    try {
      const result = await engine.acceptCall({callId});
      if (result.code !== 0) throw new Error();
    } catch {
      if (seq === generation && phase === 'connecting') draw('incoming','Could not connect. Try again or decline.');
    }
  }
  engine.setCallEventHandler({
    onCallReceived({session}) {
      if (dialog.open && !['ended','choose'].includes(phase)) return;
      ++generation;
      peer = session.getInviterUserId();
      callId = session.getCallId();
      video = session.getMediaType() === NCCallMediaType.AUDIO_VIDEO;
      title.textContent = video ? 'Incoming video call' : 'Incoming voice call';
      draw('incoming',video ? 'Accept to share your camera and microphone.' : 'Accept to share your microphone.');
    },
    onCallConnected({session}) {
      if (phase === 'ended' || (callId && callId !== session.getCallId())) return;
      callId = session.getCallId();
      micOn = cameraOn = true;
      draw('connected','Connected');
      if (video) {
        engine.setLocalVideoView({videoElement:local});
        engine.setRemoteVideoView([{userId:peer,videoElement:remote}]);
      }
    },
    onCallEnded({session}) {
      if (fallback.active || (callId && callId !== session.getCallId()) || ['ended','choose'].includes(phase)) return;
      finish('Call ended.');
    },
  });
  async function toggleDevice(button: HTMLButtonElement) {
    const seq = generation;
    button.disabled = true;
    const mic = button.dataset.action === 'mic';
    try {
      const result = fallback.active ? (fallback.enable(mic,mic ? !micOn : !cameraOn),{code:0}) : mic ? await engine.enableMicrophone(!micOn) : await engine.enableCamera(!cameraOn);
      if (seq !== generation || phase !== 'connected') return;
      if (result.code !== 0) throw new Error();
      if (mic) micOn = !micOn; else cameraOn = !cameraOn;
      draw('connected','Connected');
    } catch { if (seq === generation) status.textContent = 'Could not change device settings.'; }
    finally { button.disabled = false; }
  }
  dialog.addEventListener('cancel', e => { e.preventDefault(); void end(); });
  dialog.addEventListener('click', e => {
    const button = (e.target as HTMLElement).closest('button');
    const action = button?.dataset.action;
    if (phase === 'connected' && button && (action === 'mic' || action === 'camera')) void toggleDevice(button);
    if (action === 'end') void end();
    if (phase === 'incoming' && action === 'accept') void accept();
    if (phase === 'choose' && (action === 'voice' || action === 'video')) void start(action === 'video');
  });
  return (id: string, name: string, voiceInvite = false) => {
    if (dialog.open) return;
    peer = id; video = false;
    title.textContent = 'Call ' + name;
    if (voiceInvite) { void start(false); return; }
    draw('choose','They’ll receive an invitation.');
  };
}
