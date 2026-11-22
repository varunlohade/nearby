import { AudioSession } from '../create/audio';

export function groupVoice(host: HTMLElement, room: () => string, name: () => string) {
  host.innerHTML = '<button type="button" data-join>Join group voice</button><span role="status"></span><button type="button" data-mute hidden>Mute</button><button type="button" data-leave hidden>Leave voice</button>';
  const join = host.querySelector<HTMLButtonElement>('[data-join]')!;
  const mute = host.querySelector<HTMLButtonElement>('[data-mute]')!;
  const leave = host.querySelector<HTMLButtonElement>('[data-leave]')!;
  const status = host.querySelector('span')!;
  let session: AudioSession | undefined;
  let generation = 0;

  function stop() {
    ++generation;
    const previous = session;
    session = undefined;
    previous?.leave();
    join.hidden = false;
    mute.hidden = leave.hidden = true;
    status.textContent = '';
  }
  leave.onclick = stop;
  mute.onclick = () => session?.toggleMute();
  join.onclick = async () => {
    const version = ++generation;
    join.hidden = true;
    leave.hidden = false;
    status.textContent = 'Connecting…';
    try {
      const channel = room();
      let id = channel;
      if (!/^[cp][0-9a-f]{12}$/.test(channel)) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(channel));
        id = 'g' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      if (version !== generation) return;
      session = new AudioSession(id, name(), (active, note) => {
        if (version !== generation) return;
        if (note) { stop(); status.textContent = note; return; }
        mute.hidden = false;
        mute.textContent = active.muted ? 'Unmute' : 'Mute';
        const label = [...active.participants.values()].map(person => person.name).join(', ');
        if (status.textContent !== label) status.textContent = label;
      });
      await session.join();
    } catch (error) {
      if (version !== generation) return;
      stop();
      status.textContent = (error as Error).message;
    }
  };
  return stop;
}
