import { ICON, KIND, esc } from '../ui/icons';
import type { Place } from '../world/earth';
import { sampleChat } from '../chat/samples';
import { cityScope } from './scope';
import './market.css';

interface Message { who: string; text: string }
interface Inquiry { buyer: string; name: string; messages: Message[] }

interface Listing {
  id: string; title: string; price: string; description: string; venue: string; owner: string;
  created: number; revision: number; mine: boolean; position: number; count: number; holder?: string;
  until: number; holdToken?: string; closed: boolean; sold?: boolean; dibs?: boolean; messages: Message[]; inquiries?: Inquiry[];
  /** Seeded sample listing. */ sample?: boolean; /** Hidden after reports (only the owner still sees it). */ hidden?: boolean; reported?: boolean;
}

function actionFor(item: Listing) {
  if (item.closed) return undefined;
  if (item.dibs === false) return item.mine ? ['sold', 'Mark as sold'] : undefined;
  if (item.mine) return item.count ? ['sold', 'Mark as sold'] : ['close', 'Close listing'];
  if (item.position === 0) return ['leave', 'Release hold'];
  if (item.position > 0) return ['leave', 'Leave waitlist'];
  return ['claim', item.count ? 'Join waitlist' : 'Call dibs'];
}

function statusFor(item: Listing) {
  if (item.hidden) return 'Hidden after reports';
  if (item.closed) return (item.sold ?? (item.count > 0)) ? 'Sold' : 'Closed';
  if (item.position === 0) return 'You have dibs';
  if (item.position > 0) return `Waitlist · #${item.position}`;
  return item.count ? 'On hold' : 'Available';
}

function currencyFor(place?: Place) {
  const country = place?.country.trim().toLowerCase();
  const currencies: Record<string, string> = { india: 'INR', in: 'INR', singapore: 'SGD', sg: 'SGD', 'united states': 'USD', us: 'USD', 'united kingdom': 'GBP', gb: 'GBP', canada: 'CAD', ca: 'CAD', japan: 'JPY', jp: 'JPY' };
  return currencies[country || ''] || '';
}

function messageForm(label: string) {
  return `<form class="mk-send"><label><span class="mk-sr">${esc(label)}</span><input type="text" name="message" maxlength="400" placeholder="Write a message…" required></label><button class="mk-primary">Send</button></form>`;
}

function renderMessages(list: HTMLElement, messages: Message[]) {
  const html = messages.map(message => `<li><b>${esc(message.who)}</b><span>${esc(message.text)}</span></li>`).join('');
  if (html === list.dataset.content) return;
  if (messages.length && !list.childElementCount) list.previousElementSibling?.removeAttribute('open');
  list.innerHTML = html;
  list.dataset.content = html;
  list.scrollTop = list.scrollHeight;
}

function renderInquiries(card: HTMLElement, item: Listing) {
  const container = card.querySelector<HTMLElement>('.mk-inquiries')!;
  const inquiries = item.inquiries || [];
  // The buyer can open a conversation before sending a first message.
  const threads = item.mine || item.closed ? inquiries : [inquiries[0] || { buyer: '', name: '', messages: [] }];
  const existing = new Map(Array.from(container.querySelectorAll<HTMLDetailsElement>('.mk-inquiry')).map(detail => [detail.dataset.key!, detail]));
  for (const thread of threads) {
    const key = item.mine ? thread.buyer : 'self';
    let detail = existing.get(key);
    if (!detail) {
      detail = document.createElement('details');
      detail.className = 'mk-inquiry';
      detail.dataset.key = key;
      detail.innerHTML = `<summary>${ICON.chat}<span></span></summary><div class="mk-inquiry-body">${sampleChat('Inquiry', item.title)}<ul aria-label="Private messages"></ul>${messageForm('Private message to ' + (item.mine ? thread.name : item.owner))}</div>`;
      container.append(detail);
    }
    existing.delete(key);
    const label = item.mine ? `Chat with ${thread.name}` : thread.messages.length ? 'Your chat with the seller' : 'Chat with seller';
    detail.querySelector('summary span')!.textContent = label;
    detail.querySelector('form')!.hidden = item.closed;
    renderMessages(detail.querySelector('ul')!, thread.messages);
  }
  for (const obsolete of existing.values()) obsolete.remove();
}

function createCard(item: Listing) {
  const card = document.createElement('article');
  card.className = 'mk-card';
  card.dataset.id = item.id;
  // Decorative tile in place of a photo: first letter on one of five soft tones.
  const initial = Array.from(item.title.trim())[0] || '•';
  card.dataset.initial = initial.toLocaleUpperCase();
  card.dataset.tone = String(Array.from(item.title).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 5);
  card.innerHTML = `<div class="mk-card-head"><h3 tabindex="-1">${esc(item.title)}</h3><strong class="mk-price">${esc(item.price)}</strong></div>
    <div class="mk-place">${ICON.pin}<span>${esc(item.venue)}</span></div>
    ${item.description ? `<p class="mk-description">${esc(item.description)}</p>` : ''}
    <div class="mk-byline"><span>${item.mine ? 'Your listing' : 'Listed by ' + esc(item.owner)}</span>${item.sample ? '<span class="mk-sample" title="A sample so you can try the marketplace. Nothing is really for sale.">Sample listing</span>' : ''}<span class="mk-badge"></span></div>
    <div class="mk-terms"><p></p><button type="button" class="mk-secondary mk-action" hidden></button><button type="button" class="mk-secondary mk-close-listing" data-action="close" hidden>Close listing</button><button type="button" class="mk-report" data-action="report" hidden>Report</button></div>
    <div class="mk-inquiries"></div>
    <section class="mk-private" hidden><h4>${ICON.lock} Private pickup chat</h4><p class="mk-recipient"></p>${sampleChat('Pickup', item.title)}<ul aria-label="Pickup messages"></ul>
      ${messageForm('Message about ' + item.title)}</section>`;
  return card;
}

function renderCard(card: HTMLElement, item: Listing) {
  const focused = document.activeElement;
  const hadFocus = focused instanceof HTMLElement && card.contains(focused);
  const badge = card.querySelector<HTMLElement>('.mk-badge')!;
  badge.textContent = statusFor(item);
  badge.dataset.tone = item.hidden || item.closed ? 'closed' : item.count ? 'held' : 'open';
  const report = card.querySelector<HTMLButtonElement>('.mk-report')!;
  report.hidden = item.mine || item.closed || !!item.hidden;
  report.disabled = !!item.reported;
  report.textContent = item.reported ? 'Reported' : 'Report';
  const action = actionFor(item);
  const button = card.querySelector<HTMLButtonElement>('.mk-action')!;
  const ordinary = item.dibs === false;
  const extra = card.querySelector<HTMLButtonElement>('.mk-close-listing')!;
  extra.hidden = !ordinary || !item.mine || item.closed;
  button.hidden = !action;
  if (action) {
    button.dataset.action = action[0];
    button.textContent = action[1];
    button.classList.toggle('mk-primary', action[0] === 'claim');
    button.classList.toggle('mk-secondary', action[0] !== 'claim');
  }
  const terms = card.querySelector('.mk-terms p')!;
  terms.parentElement!.hidden = false;
  if (item.hidden) terms.textContent = 'Hidden after reports from neighbours. Only you can see it.';
  else if (item.closed) terms.textContent = statusFor(item) === 'Sold' ? 'This item has been sold.' : 'The seller closed this listing.';
  else if (ordinary) terms.textContent = '';
  else if (!item.count) terms.textContent = 'Calling dibs holds this item for 15 minutes.';
  else {
    const until = new Date(item.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const held = item.position === 0 ? 'Your hold' : item.mine ? `${item.holder}’s hold` : 'Current hold';
    const queue = item.position > 0 ? `You’re #${item.position} on the waitlist.` : item.count > 1 ? `${item.count - 1} waiting.` : '';
    terms.textContent = `${held} ends at ${until}. ${queue}`.trim();
  }
  const chat = card.querySelector<HTMLElement>('.mk-private')!;
  renderInquiries(card, item);
  const canChat = !ordinary && item.count > 0 && (item.mine || item.position === 0);
  const token = canChat ? item.holdToken || String(item.until) : '';
  const form = chat.querySelector<HTMLFormElement>('form')!;
  if (chat.dataset.hold !== token) form.reset();
  chat.dataset.hold = token;
  chat.hidden = !canChat;
  form.hidden = item.closed;
  chat.querySelector('.mk-recipient')!.textContent = canChat ? `Between you and ${item.mine ? item.holder : item.owner}.` : '';
  renderMessages(chat.querySelector('ul')!, canChat ? item.messages : []);
  if (hadFocus && (!focused.isConnected || focused.closest('[hidden]'))) {
    card.querySelector('h3')!.focus();
  }
}

export function mountMarket(getPlace: () => Place | undefined) {
  const dialog = document.createElement('dialog');
  dialog.className = 'mk-dialog';
  dialog.setAttribute('aria-labelledby', 'mk-title');
  dialog.innerHTML = `<div class="mk-shell"><header class="mk-header"><button type="button" class="mk-dismiss" aria-label="Close marketplace">${ICON.x}</button>
    <div class="mk-heading"><h2 id="mk-title">City marketplace</h2><div class="mk-location">${ICON.pin}<span></span></div></div></header>
    <main class="mk-main"><div class="mk-toolbar"><div><h3>Local listings</h3><p class="mk-lede">Buy and sell with neighbours in your city.</p></div><button type="button" class="mk-primary mk-sell" aria-expanded="false" aria-controls="mk-compose"><span aria-hidden="true">+</span> Sell an item</button></div>
    <form class="mk-compose" id="mk-compose" hidden><h3>Sell an item</h3>
      <label>Item name<input name="title" maxlength="80" required placeholder="e.g. Folding bike"></label>
      <div class="mk-field-row"><label>Price<input type="number" name="amount" min="0" step="any" required placeholder="0.00"></label>
      <label>Currency<input name="currency" maxlength="3" pattern="[A-Za-z]{3}" title="Enter a three-letter currency code" list="mk-currencies" placeholder="e.g. INR" required></label></div>
      <datalist id="mk-currencies">${['INR','SGD','USD','EUR','GBP','JPY','CAD','AUD'].map(code=>`<option value="${code}"></option>`).join('')}</datalist>
      <label>Pickup area<input name="venue" maxlength="100" required placeholder="Neighbourhood or public landmark"></label>
      <label>Description <small>(optional)</small><textarea name="description" maxlength="360" rows="3" placeholder="Condition, size or other details"></textarea></label>
      <label class="mk-dibs"><input name="dibs" type="checkbox" aria-describedby="mk-dibs-help"> Enable Dibs</label>
      <p id="mk-dibs-help">Give the first buyer a 15-minute hold. Other buyers can join a waitlist.</p>
      <p class="mk-form-error" role="alert" hidden></p>
      <div class="mk-form-actions"><button type="button" class="mk-secondary mk-cancel">Cancel</button><button class="mk-primary">Post listing</button></div>
      <p class="mk-checked">Listings are checked for scams and prohibited items before they appear.</p></form>
    <p class="mk-network" role="status"></p><div class="mk-list"></div>
    <div class="mk-empty" hidden><span aria-hidden="true">${KIND.market.icon}</span><h3>No listings yet</h3><p>Have something to sell? List it for neighbours to find.</p></div></main>
    <p class="mk-feedback" role="status"></p></div>`;
  document.body.append(dialog);
  const sell = dialog.querySelector<HTMLButtonElement>('.mk-sell')!;
  const compose = dialog.querySelector<HTMLFormElement>('.mk-compose')!;
  const list = dialog.querySelector<HTMLElement>('.mk-list')!;
  const empty = dialog.querySelector<HTMLElement>('.mk-empty')!;
  const feedback = dialog.querySelector<HTMLElement>('.mk-feedback')!;
  const network = dialog.querySelector<HTMLElement>('.mk-network')!;
  const pendingMessages = new WeakMap<HTMLFormElement, {text: string; hold?: string; requestId: string}>();
  const items = new Map<string, Listing>();
  const cards = new Map<string, HTMLElement>();
  let endpoint = '';
  let generation = 0;
  let sequence = 0;
  let interval = 0;
  let createId = '';
  let fetching = false;
  let writing = false;
  let claimFeedbackId: string | undefined;

  // Show a status line as a toast. Errors stay visible; confirmations fade out.
  function say(text: string, tone: 'info' | 'error' | 'quiet' = 'info') {
    feedback.textContent = text;
    feedback.dataset.tone = tone;
    if (tone === 'quiet') return;
    feedback.classList.remove('mk-pop');
    void feedback.offsetWidth;
    feedback.classList.add('mk-pop');
  }

  function put(item: Listing) {
    const previous = items.get(item.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) return;
    if (claimFeedbackId === item.id && previous && (previous.position !== item.position || previous.closed !== item.closed)) {
      say(item.title + ' · ' + statusFor(item));
    }
    items.set(item.id, item);
    let card = cards.get(item.id);
    if (!card) {
      card = createCard(item);
      cards.set(item.id, card);
      // Insert by creation time without detaching existing cards or their focused inputs.
      const older = Array.from(list.children).find(el => items.get((el as HTMLElement).dataset.id!)!.created < item.created);
      list.insertBefore(card, older ?? null);
    }
    renderCard(card, item);
  }
  async function refresh() {
    if (!dialog.open || !endpoint || fetching || writing) return;
    const session = generation, request = sequence;
    fetching = true;
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json();
      if (generation !== session || sequence !== request) return;
      if (!response.ok) throw new Error(data.error || 'Couldn’t load listings.');
      for (const item of data.entries as Listing[]) put(item);
      empty.hidden = items.size !== 0;
      delete list.dataset.loading;
      network.textContent = '';
    } catch (error) {
      if (generation === session && sequence === request) delete list.dataset.loading;
      if (generation === session && sequence === request) network.textContent = `${error instanceof Error ? error.message : 'Connection interrupted.'} Retrying…`;
    } finally {
      if (generation === session) fetching = false;
    }
  }
  function showCompose(show: boolean) {
    compose.hidden = !show;
    sell.setAttribute('aria-expanded', String(show));
    if (show) compose.querySelector('input')!.focus();
    else sell.focus();
  }
  async function write(body: Record<string, unknown>, onSuccess?: () => void) {
    if (writing || !endpoint) return;
    const session = generation;
    sequence++;
    writing = true;
    claimFeedbackId = undefined;
    dialog.setAttribute('aria-busy', 'true');
    say('Saving…', 'quiet');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (session !== generation) return;
      if (!response.ok) throw new Error(data.error || 'Couldn’t save that change.');
      put(data);
      empty.hidden = true;
      const confirmations: Record<string, string> = {
        create: 'Listing posted.',
        claim: data.position === 0 ? 'You have dibs. Message the seller to arrange pickup.' : `You’re #${data.position} on the waitlist.`,
        leave: 'You left this reservation.',
        message: 'Message sent.',
        inquire: 'Message sent.',
        sold: 'Item marked as sold.',
        close: 'Listing closed.',
        report: 'Thanks for reporting. Listings with several reports are hidden.',
      };
      if (body.action === 'create') compose.querySelector<HTMLElement>('.mk-form-error')!.hidden = true;
      say(confirmations[String(body.action)]);
      if (body.action === 'claim') claimFeedbackId = data.id;
      onSuccess?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Couldn’t save that change. Try again.';
      if (session === generation) say(message, 'error');
      // Detector rejections and other form errors also show next to the form.
      if (session === generation && body.action === 'create') {
        const note = compose.querySelector<HTMLElement>('.mk-form-error')!;
        note.textContent = message;
        note.hidden = false;
      }
    } finally {
      if (session === generation) {
        writing = false;
        dialog.removeAttribute('aria-busy');
        void refresh();
      }
    }
  }
  compose.addEventListener('submit', event => {
    event.preventDefault();
    const fields = new FormData(compose);
    const currency = String(fields.get('currency')).trim().toUpperCase();
    const amount = String(fields.get('amount')).trim();
    if (amount.length > 26 || !Number.isFinite(Number(amount))) {
      say('Enter a shorter price.', 'error');
      return;
    }
    void write({
      action: 'create', id: createId, title: fields.get('title'), venue: fields.get('venue'),
      price: `${currency} ${amount}`, dibs: fields.has('dibs'), description: fields.get('description'),
    }, () => {
      compose.reset();
      (compose.elements.namedItem('currency') as HTMLInputElement).value = currency;
      createId = crypto.randomUUID();
      showCompose(false);
    });
  });
  list.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const item = items.get(form.closest<HTMLElement>('.mk-card')!.dataset.id!)!;
    const input = form.elements.namedItem('message') as HTMLInputElement;
    const message = input.value.trim();
    if (!message) { input.focus(); return; }
    const action = form.closest('.mk-inquiries') ? 'inquire' : 'message';
    const buyer = action === 'inquire' && item.mine ? form.closest<HTMLElement>('details')?.dataset.key : undefined;
    const hold = action === 'message' ? item.holdToken : undefined;
    const pending = pendingMessages.get(form);
    const requestId = pending?.text === message && pending.hold === hold ? pending.requestId : crypto.randomUUID();
    pendingMessages.set(form, {text: message, hold, requestId});
    void write({
      action, id: item.id, revision: item.revision, until: item.until, holdToken: item.holdToken,
      buyer, message, requestId,
    }, () => {
      pendingMessages.delete(form);
      if (input.value.trim() === message) input.value = '';
    });
  });
  list.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]');
    if (!button) return;
    const item = items.get(button.closest<HTMLElement>('.mk-card')!.dataset.id!)!;
    void write({
      action: button.dataset.action, id: item.id, revision: item.revision,
      until: item.until, holdToken: item.holdToken,
    });
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || compose.hidden || event.defaultPrevented) return;
    event.stopPropagation();
    event.preventDefault();
    showCompose(false);
  });
  sell.onclick = () => showCompose(compose.hidden);
  dialog.querySelector<HTMLButtonElement>('.mk-cancel')!.onclick = () => showCompose(false);
  dialog.querySelector<HTMLButtonElement>('.mk-dismiss')!.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; window.clearInterval(interval); });
  document.addEventListener('click', event => {
    const trigger = (event.target as Element).closest('[data-city-market]');
    if (!trigger || dialog.open) return;
    const place = getPlace();
    const scope = place && cityScope(place);
    generation++;
    sequence = 0;
    fetching = false;
    writing = false;
    claimFeedbackId = undefined;
    dialog.removeAttribute('aria-busy');
    endpoint = scope ? '/api/city/market?city=' + encodeURIComponent(scope) : '';
    dialog.querySelector('.mk-location span')!.textContent = place?.city || place?.locality || 'Nearby';
    compose.hidden = true;
    sell.setAttribute('aria-expanded', 'false');
    compose.reset();
    (compose.elements.namedItem('currency') as HTMLInputElement).value = currencyFor(place);
    sell.disabled = !scope;
    createId = crypto.randomUUID();
    list.replaceChildren();
    items.clear();
    cards.clear();
    empty.hidden = true;
    say('', 'quiet');
    if (scope) list.dataset.loading = 'true';
    else delete list.dataset.loading;
    network.textContent = scope ? 'Loading listings…' : 'Choose a city on the map to see listings.';
    dialog.showModal();
    if (scope) {
      void refresh();
      interval = window.setInterval(refresh, 3500);
    }
  });
}
