import { createChat, type ChatMessage, type ChatRoom, type ChatService } from './index';
import { guestId } from '../user';
import { joinNotifier } from './join-notify';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const messageBox = el('messages');
const field = el<HTMLInputElement>('message-input');
const fileInput = el<HTMLInputElement>('photo-file');
const status = el('chat-mode');
const presence = el('room-presence');
const retry = el<HTMLButtonElement>('retry-chat');
const composer = el<HTMLFormElement>('composer');

export function chatPanel(onState: (data: Record<string,string>) => void, onAvailability: () => void) {
  let service: ChatService | undefined;
  let identity = {userId:guestId(), name:localStorage.getItem('nearby.displayName') || ''};
  if (!identity.name || identity.name === 'You') identity.name = 'Neighbor ' + identity.userId.slice(-4).toUpperCase();
  let selected: ChatRoom;
  let area: ChatRoom;
  let sequence = 0;
  let switching = Promise.resolve();
  let ready = false;
  let canWriteMetadata = false;
  const nameButton = el<HTMLButtonElement>('chat-name');
  const nameDialog = el<HTMLDialogElement>('name-dialog');
  const nameField = nameDialog.querySelector('input')!;
  const historyBar = el('history-bar');
  const earlier = el<HTMLButtonElement>('earlier');
  nameButton.textContent = identity.name;
  nameButton.onclick = () => { nameField.value = identity.name; nameDialog.showModal(); };
  el('name-cancel').onclick = () => nameDialog.close();
  el<HTMLFormElement>('name-form').onsubmit = event => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name) return;
    nameDialog.close();
    identity = {...identity,name};
    localStorage.setItem('nearby.displayName',name);
    nameButton.textContent = name;
    void enter(selected,true);
  };
  const notifier = joinNotifier(messageBox);
  let busy = false;
  const drafts = new Map<string,string>();

  function controls() {
    for (const control of composer.querySelectorAll<HTMLButtonElement>('button')) control.disabled = !ready || busy;
    field.disabled = !ready;
    onAvailability();
  }
  function append(m: ChatMessage) {
    if (m.roomId !== selected?.id || messageBox.querySelector('[data-id="' + CSS.escape(m.id) + '"]')) return;
    const mine = m.userId === identity.userId;
    const div = document.createElement('div');
    div.className = 'message' + (mine ? ' mine' : '');
    div.dataset.id = m.id;
    div.dataset.at = String(m.at);
    const content = document.createElement('div');
    const author = document.createElement('b');
    if (!mine && service?.offerCall) {
      const call = document.createElement('button');
      call.type = 'button'; call.className = 'call-author';
      call.textContent = m.name + ' · Call';
      call.title = call.ariaLabel = 'Voice or video call with ' + m.name;
      call.onclick = () => service?.offerCall?.(m.userId,m.name);
      author.append(call);
    } else author.textContent = m.name;
    const time = document.createElement('time');
    time.textContent = new Date(m.at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    const body = document.createElement('p');
    body.textContent = m.text;
    if (m.image && (/^https?:\/\//i.test(m.image) || (service?.mode === 'demo' && /^data:image\/(png|jpeg|webp);base64,/.test(m.image)))) {
      const img = document.createElement('img');
      img.src = m.image; img.alt = 'Photo from ' + m.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      body.append(img);
    }
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = m.name.slice(0,2).toUpperCase();
    content.append(author,time,body); div.append(avatar,content);
    const later = Array.from(messageBox.children).find(n => Number((n as HTMLElement).dataset.at) > m.at);
    messageBox.insertBefore(div,later || null);
    messageBox.scrollTop = messageBox.scrollHeight;
  }
  function enter(room: ChatRoom, force = false) {
    if (!force && selected?.id === room.id) return switching;
    if (selected) drafts.set(selected.id, field.value);
    selected = room;
    field.value = drafts.get(room.id) || '';
    const seq = ++sequence;
    ready = false; busy = false; canWriteMetadata = false; controls();
    historyBar.hidden = true; earlier.disabled = false;
    presence.textContent = ''; retry.hidden = true;
    el('room-kind').textContent = room.kind ?? (room.id === area.id ? 'Area channel' : 'Event channel');
    el('room-title').textContent = room.title;
    el('chat-panel').setAttribute('aria-label',room.title);
    field.placeholder = room.id === area.id ? 'Say hi to your area…' : room.kind ? 'Message this ' + room.kind.toLowerCase() + '…' : 'Message this event…';
    messageBox.replaceChildren(); status.textContent = 'Connecting…';
    switching = switching.then(async () => {
      if (seq !== sequence) return;
      try {
        service ??= await createChat();
        await service.leave();
        identity = await service.connect(identity);
        if (seq !== sequence) return;
        await service.join(room, {
          message: m => { if (seq === sequence) append(m); },
          metadata: values => {
            if (seq === sequence && room.id === area.id) { canWriteMetadata = true; onState(values); onAvailability(); }
          },
          presence: count => { if (seq === sequence) presence.textContent = count + ' in room'; },
          joined: person => { if (seq === sequence) notifier.joined(person, room); },
          availability: (online, detail) => {
            if (seq !== sequence) return;
            ready = online; controls(); retry.hidden = online;
            historyBar.hidden = !online || !service?.earlier;
            if (!online) presence.textContent = '';
            status.textContent = detail || (service?.mode === 'demo' ? 'Local demo' : 'Live on Nexconn');
          },
          metadataError: () => {
            if (seq !== sequence || room.id !== area.id) return;
            canWriteMetadata = false; onAvailability(); retry.hidden = false; status.textContent = 'Room metadata unavailable';
          },
        });
      } catch (e) {
        if (seq !== sequence) return;
        ready = false; controls(); retry.hidden = false; status.textContent = (e as Error).message;
      }
    });
    return switching;
  }
  async function send(file?: File) {
    if (!ready || busy || !service) return;
    const seq = sequence;
    const text = file ? '' : field.value.trim();
    if (!file && !text) return;
    busy = true; controls();
    try {
      if (file && (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > (service.mode === 'demo' ? 1024*1024 : 10*1024*1024)))
        throw new Error('Choose a JPG, PNG or WebP under ' + (service.mode === 'demo' ? '1' : '10') + ' MB');
      const result = await service.send(selected.id,text,file);
      if (seq !== sequence) return;
      append(result);
      if (!file && field.value.trim() === text) field.value = '';
      status.textContent = service.mode === 'demo' ? 'Local demo' : 'Live on Nexconn';
    } catch (e) { if (seq === sequence) status.textContent = (e as Error).message; }
    finally { if (seq === sequence) {busy = false; controls();} }
  }
  earlier.onclick = async () => {
    if (!ready || !service?.earlier) return;
    const seq = sequence;
    earlier.disabled = true;
    const top = messageBox.scrollTop, height = messageBox.scrollHeight;
    const first = messageBox.firstElementChild as HTMLElement | null;
    try {
      const page = await service.earlier(selected.id, first ? Number(first.dataset.at) : 0);
      if (seq !== sequence) return;
      page.messages.forEach(append);
      messageBox.scrollTop = top + messageBox.scrollHeight - height;
      historyBar.hidden = !page.more;
    } catch (e) { if (seq === sequence) status.textContent = (e as Error).message; }
    finally { if (seq === sequence) earlier.disabled = false; }
  };
  composer.onsubmit = e => { e.preventDefault(); void send(); };
  el('attach-photo').onclick = () => fileInput.click();
  fileInput.onchange = () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) void send(file); };
  retry.onclick = () => { void enter(selected,true); };
  return {
    get user() { return identity; },
    get canCall() { return Boolean(service?.offerCall && ready); },
    callUser(id:string, name:string) { service?.offerCall?.(id,name); },
    get areaReady() { return ready && canWriteMetadata && selected?.id === area?.id; },
    setArea(room: ChatRoom) { area = room; return enter(room,true); },
    openArea() { if (area) return enter(area); },
    openEvent(id: string, title: string) { return enter({id:area.id + '_' + id, title}); },
    /** Open a room created on the map. Its channel is global, not tied to the visitor's area. */
    openRoom(id: string, title: string, kind: string) { return enter({id:'nearby_' + id, title, kind}); },
    async write(key: string, value: string | null) {
      if (!service || !ready || !canWriteMetadata || selected.id !== area.id) throw new Error('Area metadata is unavailable. Check the room connection.');
      await service.write(area.id,key,value);
    },
    async announce(text: string) {
      if (!service || !ready || selected.id !== area.id) throw new Error('Area room unavailable');
      append(await service.send(area.id,text));
    },
  };
}
