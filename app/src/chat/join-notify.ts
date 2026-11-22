// "Someone joined" notifications for the chat panel.
//
// - In the message log: a quiet "Asha joined" line.
// - Chat closed: a toast with an Open button and a count badge on the chat launcher.
// - Tab hidden: an optional browser notification ("🔔 Join alerts" in the chat footer).
// Only display names are shown. One person rejoining is announced at most every 2 minutes.

import './join-notify.css';
import type { ChatRoom } from './types';

const PREF = 'nearby.notifyJoins';
const QUIET_MS = 120_000;

export function joinNotifier(messageBox: HTMLElement) {
  const panel = document.getElementById('chat-panel')!;
  const launcher = document.getElementById('mobile-chat');
  const seen = new Map<string, number>();
  let unread = 0;

  const isOpen = () => !panel.classList.contains('collapsed') && !panel.classList.contains('hidden') && document.body.classList.contains('chat-open');
  const open = () => window.dispatchEvent(new CustomEvent('nearby:open-chat'));

  // Badges on every chat button (desktop launcher and the phone navigation), cleared when the chat opens.
  const hosts = [launcher, ...document.querySelectorAll<HTMLElement>('[data-map-action="#mobile-chat"]')].filter((h): h is HTMLElement => !!h);
  const badges = hosts.map(host => {
    if (getComputedStyle(host).position === 'static') host.classList.add('join-badge-host');
    const badge = document.createElement('span');
    badge.className = 'join-badge';
    badge.hidden = true;
    host.append(badge);
    return badge;
  });
  const setBadge = (count: number) => {
    unread = count;
    for (const badge of badges) {
      badge.hidden = !count;
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.setAttribute('aria-label', count + (count === 1 ? ' person joined' : ' people joined'));
    }
  };
  new MutationObserver(() => { if (isOpen()) setBadge(0); }).observe(panel, { attributes: true, attributeFilter: ['class'] });

  // Toasts.
  const toasts = document.createElement('div');
  toasts.className = 'join-toasts';
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');
  document.body.append(toasts);
  function toast(name: string, room: ChatRoom) {
    const item = document.createElement('div');
    item.className = 'join-toast';
    const text = document.createElement('span');
    const who = document.createElement('b');
    who.textContent = name;
    text.append(who, ' joined ' + room.title);
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Open';
    go.onclick = () => { item.remove(); open(); };
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'join-toast-x';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.onclick = () => item.remove();
    item.append(text, go, close);
    toasts.prepend(item);
    while (toasts.children.length > 3) toasts.lastElementChild?.remove();
    window.setTimeout(() => item.remove(), 7000);
  }

  // Optional browser notifications while the tab is in the background.
  const footer = panel.querySelector('footer');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'join-alerts';
  const supported = typeof Notification === 'function';
  const enabled = () => supported && localStorage.getItem(PREF) === 'on' && Notification.permission === 'granted';
  const label = () => {
    const on = enabled();
    toggle.textContent = on ? '🔔 Join alerts on' : '🔕 Join alerts';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.title = !supported ? 'This browser does not support notifications' :
      Notification.permission === 'denied' ? 'Notifications are blocked for this site in your browser settings' :
      on ? 'Turn off browser alerts when people join' : 'Notify me when people join (browser alert while this tab is in the background)';
    toggle.setAttribute('aria-label', on ? 'Join alerts on. Turn off' : 'Notify me when people join');
  };
  toggle.onclick = async () => {
    if (!supported) return;
    if (enabled()) { localStorage.setItem(PREF, 'off'); return label(); }
    // Ask for permission only when the visitor turns alerts on.
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    localStorage.setItem(PREF, permission === 'granted' ? 'on' : 'off');
    label();
    if (permission === 'denied') toast('Browser alerts are blocked.', { id: '', title: 'Allow notifications for this site in your browser settings, or keep using in-app alerts' });
  };
  if (supported) { footer?.append(toggle); label(); }

  function logLine(name: string) {
    const line = document.createElement('div');
    line.className = 'message-system';
    line.dataset.id = 'join-' + crypto.randomUUID();
    line.dataset.at = String(Date.now());
    const who = document.createElement('b');
    who.textContent = name;
    line.append(who, ' joined');
    messageBox.append(line);
    messageBox.scrollTop = messageBox.scrollHeight;
  }

  return {
    /** Call when someone else enters the selected room. */
    joined(person: { userId: string; name: string }, room: ChatRoom) {
      const key = room.id + '|' + person.userId;
      const now = Date.now();
      if (now - (seen.get(key) ?? 0) < QUIET_MS) return;
      seen.set(key, now);
      logLine(person.name);
      if (!isOpen()) { toast(person.name, room); setBadge(unread + 1); }
      if (document.hidden && enabled()) {
        try {
          const note = new Notification(person.name + ' joined ' + room.title, { body: 'Say hi on nearby', tag: 'nearby-join-' + room.id, icon: '/og.png' });
          note.onclick = () => { window.focus(); open(); note.close(); };
        } catch { /* some mobile browsers only allow notifications from a service worker */ }
      }
    },
  };
}
