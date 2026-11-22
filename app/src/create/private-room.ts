// The server stores ciphertext and one RSA-wrapped room key per approved browser.
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value)));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
let device: Promise<CryptoKeyPair> | undefined;
function deviceKeys() {
  return (device ??= (async () => {
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open('nearby-room-keys', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('device');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    try {
      const read = () =>
        new Promise<CryptoKeyPair | undefined>((ok, fail) => {
          const r = db.transaction('device').objectStore('device').get('keys');
          r.onsuccess = () => ok(r.result);
          r.onerror = () => fail(r.error);
        });
      const existing = await read();
      if (existing) return existing;
      const keys = await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        false,
        ['wrapKey', 'unwrapKey'],
      );
      await new Promise<void>((ok, fail) => {
        const tx = db.transaction('device', 'readwrite');
        tx.objectStore('device').add(keys, 'keys');
        tx.oncomplete = () => ok();
        tx.onabort = () => (tx.error?.name === 'ConstraintError' ? ok() : fail(tx.error));
      });
      return (await read())!;
    } finally {
      db.close();
    }
  })().catch((error) => {
    device = undefined;
    throw error;
  }));
}
const wrap = async (key: CryptoKey, to: CryptoKey) =>
  encode(await crypto.subtle.wrapKey('raw', key, to, 'RSA-OAEP'));
export async function newPrivateKey() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return wrap(key, (await deviceKeys()).publicKey);
}

export function openPrivateRoom(id: string, title: string, name: string) {
  const d = document.createElement('dialog');
  d.className = 'private-room';
  d.setAttribute('aria-label', title);
  d.innerHTML =
    '<header><b></b><button aria-label="Close">×</button></header><small>Private · End-to-end encrypted</small><section></section><ul></ul><form hidden><input required maxlength="400" aria-label="Private message" placeholder="Private message"><button>Send</button></form><p role="status"></p>';
  d.querySelector('b')!.textContent = title;
  document.body.append(d);
  d.showModal();
  d.querySelector('header button')!.addEventListener('click', () => d.close());
  const controls = d.querySelector('section')!,
    list = d.querySelector('ul')!,
    form = d.querySelector('form')!,
    input = form.querySelector('input')!,
    status = d.querySelector('p')!;
  let key: CryptoKey | undefined,
    timer = 0,
    seq = 0,
    view = '',
    log = '';
  const url = '/api/places/' + id;
  const request = async (payload?: unknown) => {
    const r = await fetch(
      url,
      payload
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
        : { cache: 'no-store' },
    );
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Room unavailable');
    return data;
  };
  const action = (label: string, fn: () => Promise<void>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
        await refresh();
      } catch (e) {
        status.textContent = (e as Error).message;
      } finally {
        b.disabled = false;
      }
    };
    controls.append(b);
  };
  async function refresh() {
    const generation = ++seq;
    clearTimeout(timer);
    try {
      const data = await request();
      if (generation !== seq || !d.open) return;
      if (data.key && !key)
        key = await crypto.subtle.unwrapKey(
          'raw',
          decode(data.key),
          (await deviceKeys()).privateKey,
          'RSA-OAEP',
          'AES-GCM',
          true,
          ['encrypt', 'decrypt'],
        );
      const next = JSON.stringify([data.state, data.requests]);
      if (view !== next) {
        view = next;
        controls.replaceChildren();
        form.hidden = !key;
        if (data.state === 'owner')
          controls.append(document.createTextNode('You approve join requests from this browser.'));
        if (data.state === 'guest')
          action('Request to join', async () => {
            await request({
              action: 'request',
              name,
              publicKey: encode(await crypto.subtle.exportKey('spki', (await deviceKeys()).publicKey)),
            });
          });
        if (data.state === 'pending') controls.textContent = 'Request sent. Waiting for the host.';
        for (const [who, r] of Object.entries(data.requests || {}) as [
          string,
          { name: string; publicKey: string },
        ][]) {
          const label = document.createElement('p');
          label.textContent = r.name + ' wants to join';
          controls.append(label);
          action('Approve', async () => {
            const pub = await crypto.subtle.importKey(
              'spki',
              decode(r.publicKey),
              { name: 'RSA-OAEP', hash: 'SHA-256' },
              false,
              ['wrapKey'],
            );
            await request({ action: 'approve', id: who, publicKey: r.publicKey, key: await wrap(key!, pub) });
          });
          action('Decline', async () => {
            await request({ action: 'decline', id: who });
          });
        }
      }
      const snapshot = JSON.stringify(data.messages || []);
      if (key && snapshot !== log) {
        const items = await Promise.all(
          (data.messages || []).map(async (m: { iv: string; cipher: string }) => {
            const li = document.createElement('li');
            try {
              const raw = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: decode(m.iv) },
                key!,
                decode(m.cipher),
              );
              const msg = JSON.parse(new TextDecoder().decode(raw));
              li.textContent = msg.name + ' · ' + msg.text;
            } catch {
              li.textContent = 'Unreadable message';
            }
            return li;
          }),
        );
        if (generation === seq) {
          list.replaceChildren(...items);
          log = snapshot;
          list.scrollTop = list.scrollHeight;
        }
      }
    } catch (e) {
      status.textContent =
        (e as Error).name === 'OperationError'
          ? 'This browser does not have the original decryption key.'
          : (e as Error).message;
    } finally {
      if (d.open && generation === seq) timer = window.setTimeout(refresh, 2000);
    }
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim(),
      send = form.querySelector('button')!;
    if (!text || !key || send.disabled) return;
    send.disabled = true;
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(JSON.stringify({ name, text })),
      );
      await request({ action: 'send', iv: encode(iv.buffer), cipher: encode(cipher) });
      if (input.value.trim() === text) input.value = '';
      await refresh();
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      send.disabled = false;
    }
  };
  d.onclose = () => {
    seq++;
    clearTimeout(timer);
    d.remove();
  };
  void refresh();
}
