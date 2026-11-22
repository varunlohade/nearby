import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { clean, readJson } from './communities.js';
import { visitor, type Visitor } from './identity.js';
import { allow, getStore, type Store } from './store.js';
import { screenListing } from './guard.js';
import { SAMPLE_OWNER, SAMPLE_REPLY, seedMarket } from './market-seed.js';

type Input = Record<string, unknown>;
interface Base { id: string; title: string; venue: string; owner: Visitor; created: number; revision: number }
interface Message { who: string; text: string; receipt?: string }
interface Inquiry { buyer: string; name: string; messages: Message[] }
interface Item extends Base {
  // Older listings always used Dibs. New listings explicitly store their mode.
  dibs?: boolean; sold?: boolean; inquiries?: Record<string, Inquiry>;
  kind: 'item'; price: string; description: string; queue: Visitor[]; until: number;
  holdToken?: string; holdRevision?: number;
  lastRemovalRevision?: number; closed: boolean; messages: Message[];
  /** Seeded sample listing (badged in the UI). */ sample?: boolean;
  /** Visitors who reported it; three hide it from everyone but the owner. */ reporters?: string[]; hidden?: boolean;
}
interface Game extends Base {
  kind: 'game'; question: string; choices: string[]; picks: Record<string, number>;
  closes: number; locked: boolean; result: number | null; round: number; ended: boolean;
  history: { question: string; answer: string; correct: number; total: number }[];
}
type Entry = Game | Item;
const HOLD = 15 * 60_000;
// Legacy geolocation fallbacks include "12.3°, -45.6°" and "12.3° N · 45.6° W".
const coordinatePair = /^[+−-]?\d+(?:\.\d+)?\s*°?\s*[ns]?(?:\s*[,·;]\s*|\s+)[+−-]?\d+(?:\.\d+)?\s*°?\s*[ew]?$/;
class Problem extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function required(input: Input, key: string, max: number) {
  const text = clean(input[key], max);
  if (!text) throw new Problem('Please enter ' + key + '.');
  return text;
}
function listingPrice(value: unknown) {
  if (typeof value !== 'string' || value.length > 30) {
    throw new Problem('Enter a currency and amount within 30 characters.');
  }
  const match = /^([A-Za-z]{3}) (-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(value);
  if (!match || !Number.isFinite(Number(match[2]))) {
    throw new Problem('Enter a three-letter currency and a finite amount.');
  }
  // Checking the mantissa also catches negative amounts that underflow to -0.
  const [mantissa] = match[2].split(/[eE]/);
  if (mantissa.startsWith('-') && /[1-9]/.test(mantissa)) {
    throw new Problem('The price must be zero or greater.');
  }
  return match[1].toUpperCase() + ' ' + match[2];
}
function options(input: Input) {
  const choices = [required(input,'first option',50), required(input,'second option',50)];
  if (choices[0].toLowerCase() === choices[1].toLowerCase()) throw new Problem('Use two different options.');
  return {question:required(input,'question',120), choices};
}
// An existing pre-token hold gets a stable handle until its first transition.
function holdToken(item: Item) {
  if (!item.queue.length) return undefined;
  return item.holdToken ?? createHash('sha256')
    .update(JSON.stringify([item.id, item.queue[0].id, item.until])).digest('hex');
}
function startHold(item: Item, until: number) {
  item.until = item.queue.length ? until : 0;
  item.holdToken = item.queue.length ? randomUUID() : undefined;
  item.holdRevision = item.revision + 1;
  item.messages = [];
}
function publicMessages(messages: Message[]) {
  return messages.map(({who, text}) => ({who, text}));
}
function appendMessage(messages: Message[], input: Input, me: Visitor) {
  const text = required(input, 'message', 400);
  // Current clients send the revision of the form they submitted. A client
  // can also identify a logical send explicitly across refreshes and retries.
  let identity;
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 128) {
      throw new Problem('Invalid message request ID.');
    }
    identity = input.requestId;
  } else if (Number.isSafeInteger(input.revision)) {
    identity = input.revision;
  }
  const receipt = identity === undefined ? undefined : createHash('sha256')
    .update(JSON.stringify([me.id, identity, text])).digest('hex');
  if (receipt && messages.some(message => message.receipt === receipt)) return false;
  messages.push({who:me.name, text, receipt});
  if (messages.length > 40) messages.shift();
}
// Advance through every elapsed hold using its original deadline. Persist the
// cleanup with CAS so a polling reader cannot overwrite a concurrent mutation.
async function expire(store: Store, key: string, e: Entry, now: number) {
  if (e.kind !== 'item' || e.dibs === false || e.closed || !e.queue.length || now < e.until) return true;
  const elapsed = Math.floor((now - e.until) / HOLD) + 1;
  e.queue.splice(0, elapsed);
  startHold(e, e.until + elapsed * HOLD);
  const previous = e.revision++;
  e.lastRemovalRevision = e.revision;
  if (await store.compareRevision(key, e.id, previous, e)) return true;
  // The projected snapshot must never carry the winning writer's revision.
  e.revision = previous;
  return false;
}
function view(e: Entry, me: Visitor, now: number) {
  const common = {id:e.id,title:e.title,venue:e.venue,owner:e.owner.name,mine:e.owner.id===me.id,created:e.created,revision:e.revision};
  if (e.kind === 'game') return {...common,kind:e.kind,question:e.question,choices:e.choices,round:e.round,closes:e.closes,
    locked:e.locked || now >= e.closes,result:e.result,ended:e.ended,history:e.history,pick:e.picks[me.id] ?? null,
    counts:e.choices.map((_,i)=>Object.values(e.picks).filter(v=>v===i).length)};
  const position=e.queue.findIndex(v=>v.id===me.id);
  const threads = e.inquiries ?? {};
  const inquiries = common.mine ? Object.values(threads) : threads[me.id] ? [threads[me.id]] : [];
  const participant = common.mine || position===0;
  return {...common,kind:e.kind,dibs:e.dibs ?? true,sold:e.sold ?? (e.closed && e.queue.length>0),
    sample:e.sample===true,hidden:e.hidden===true,reported:(e.reporters ?? []).includes(me.id),
    inquiries:inquiries.map(({buyer,name,messages}) => ({buyer,name,messages:publicMessages(messages)})),
    holdToken:participant ? holdToken(e) : undefined,price:e.price,description:e.description,position,until:e.until,closed:e.closed,
    count:e.queue.length,holder:(common.mine || position===0) ? e.queue[0]?.name : undefined,messages:participant ? publicMessages(e.messages) : []};
}
function updateOrdinaryItem(item: Item, input: Input, me: Visitor) {
  const owner = me.id === item.owner.id;
  if (owner && (input.action === 'sold' || input.action === 'close')) {
    item.closed = true;
    item.sold = input.action === 'sold';
    return;
  }
  if (input.action !== 'inquire') throw new Problem('That action is unavailable.',409);
  const threads = item.inquiries ??= {};
  let thread: Inquiry;
  if (owner) {
    const candidates = Object.values(threads);
    const recipient = input.buyer === undefined && candidates.length === 1
      ? candidates[0] : candidates.find(t => t.buyer === input.buyer);
    if (!recipient) throw new Problem('Choose an existing buyer inquiry.',409);
    thread = recipient;
  } else {
    // The signed visitor selects the thread. Its public reply handle is scoped
    // to this listing and discloses no identifying cookie or storage key.
    if (input.buyer !== undefined && input.buyer !== threads[me.id]?.buyer) {
      throw new Problem('That inquiry is unavailable.',409);
    }
    thread = threads[me.id] ??= {buyer:randomUUID(), name:me.name, messages:[]};
    thread.name = me.name;
  }
  const first = !thread.messages.length;
  const result = appendMessage(thread.messages, input, me);
  if (item.sample && first && result !== false) thread.messages.push({who:SAMPLE_OWNER.name, text:SAMPLE_REPLY});
  return result;
}
function update(e: Entry,b: Input,me: Visitor,now: number) {
  const owner=e.owner.id===me.id;
  if (e.kind==='item') {
    if (b.action==='report') {
      if (owner) throw new Problem('You cannot report your own listing.',409);
      const reporters = e.reporters ??= [];
      if (reporters.includes(me.id)) return false;
      reporters.push(me.id);
      if (reporters.length>=3) e.hidden=true;
      return;
    }
    if (e.hidden) throw new Problem('This listing was hidden after reports.',409);
    if (e.closed) throw new Problem('This listing is closed.',409);
    if (e.dibs === false) return updateOrdinaryItem(e,b,me);
    if (e.queue.length && e.holdRevision === undefined) e.holdRevision = e.revision;
    const pos=e.queue.findIndex(p=>p.id===me.id);
    if (b.action==='claim' && !owner) {
      if (pos>=0) return false;
      // Concurrent joins are compatible. After a removal, a replay from an
      // older view must not recreate a reservation that was released or expired.
      if (typeof b.revision === 'number' && b.revision < (e.lastRemovalRevision ?? 0)) {
        throw new Problem('The reservation changed. Refresh and try again.',409);
      }
      e.queue.push(me);
      if (e.queue.length===1) {
        startHold(e,now+HOLD);
        if (e.sample) e.messages.push({who:SAMPLE_OWNER.name, text:SAMPLE_REPLY});
      }
      return;
    }
    if (b.action==='leave' && !owner) {
      if (pos<0) return false;
      if (b.revision!==undefined && b.revision!==e.revision) throw new Problem('The reservation changed. Refresh and try again.',409);
      e.queue.splice(pos,1);
      e.lastRemovalRevision=e.revision+1;
      if (pos===0) startHold(e,now+HOLD);
      return;
    }
    if (b.action==='message' && e.queue.length && (owner || pos===0)) {
      // Older clients identify their snapshot with revision + deadline. The
      // revision must fall inside this hold, even if two deadlines coincide.
      const sameHold = b.holdToken !== undefined ? b.holdToken === holdToken(e)
        : b.until === e.until && typeof b.revision === 'number' && Number.isSafeInteger(b.revision)
          && b.revision >= (e.holdRevision ?? e.revision) && b.revision <= e.revision;
      if (!sameHold) throw new Problem('The pickup hold changed. Refresh before sending.',409);
      return appendMessage(e.messages,b,me);
    }
    // The client must still be looking at the same holder before confirming a sale or exchanging details.
    if (b.revision!==e.revision || b.until!==e.until) throw new Problem('The listing changed. Check the current hold and try again.',409);
    if (owner && b.action==='close' && !e.queue.length) { e.closed=true;return; }
    if (owner && b.action==='sold' && e.queue.length) {e.closed=true;e.queue.splice(1);return;}

  } else {
    if (b.round!==e.round) throw new Problem('This round has finished.',409);
    if (owner && b.action==='void' && e.result===null) {
      if (e.ended) return false;
      e.ended=true;
      e.locked=true;
      e.picks={};
      return;
    }
    if (e.ended) throw new Problem('This round has finished.',409);
    const locked=e.locked || now>=e.closes;
    const choice=b.choice;
    if (b.action==='pick' && !locked && (choice===0 || choice===1)) {
      if (e.picks[me.id]===choice) return false;
      e.picks[me.id]=choice;
      return;
    }
    if (owner && b.action==='lock') {if (e.locked) return false; e.locked=true;return;}
    if (owner && b.action==='result' && locked && e.result===null && (choice===0 || choice===1)) {
      e.result=choice;e.locked=true;
      const votes=Object.values(e.picks);
      e.history.push({question:e.question,answer:e.choices[choice],correct:votes.filter(v=>v===choice).length,total:votes.length});return;
    }
    if (owner && e.result!==null && b.action==='end') {e.ended=true;return;}
    if (owner && e.result!==null && b.action==='next') {
      Object.assign(e,options(b),{picks:{},round:e.round+1,locked:false,result:null,closes:now+5*60_000});return;
    }
  }
  throw new Problem('That action is unavailable.',409);
}
export async function cityApi(req:IncomingMessage,res:ServerResponse,next:()=>void) {
  const url=new URL(req.url || '/','http://local');
  const match=/^\/api\/city\/(market|games)$/.exec(url.pathname);
  if (!match) return next();
  const send=(code:number,data:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(data));};
  try {
    const city=(url.searchParams.get('city') ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (city.length>220) throw new Problem('City name is too long.');
    const locality=city.split('|').at(-1)?.trim();
    if (!locality || locality==='your location' || coordinatePair.test(locality)) {
      throw new Problem('Pick a city first.');
    }
    const key='city:'+match[1]+':'+createHash('sha256').update(city).digest('hex');
    const store=getStore();
    if (!store.shared && process.env.VERCEL) throw new Problem('City storage is unavailable.',503);
    const me=await visitor(req,res);
    if (req.method==='GET') {
      const snapshots=Object.values(await store.hgetall<Entry>(key));
      const entries=await Promise.all(snapshots.map(async entry => {
        for (let attempt=0;attempt<25;attempt++) {
          if (await expire(store,key,entry,Date.now())) return entry;
          // Another writer won the transition. Return its actual hold token.
          const current=await store.hget<Entry>(key,entry.id);
          if (!current) break;
          entry=current;
        }
        throw new Problem('Listing changed. Please refresh.',409);
      }));
      const now=Date.now();
      let visible=entries.filter(e=>!(e.kind==='item' && e.hidden && e.owner.id!==me.id));
      if (match[1]==='market') {
        const open=visible.filter(e=>e.kind==='item' && !e.closed).length;
        if (await seedMarket(store,key,city,open).catch(error=>{console.error('[market] seed',error);return false;})) {
          visible=Object.values(await store.hgetall<Entry>(key)).filter(e=>!(e.kind==='item' && e.hidden && e.owner.id!==me.id));
        }
      }
      return send(200,{entries:visible.sort((a,b)=>b.created-a.created).map(e=>view(e,me,now))});
    }
    if (req.method!=='POST') throw new Problem('Method unavailable.',405);
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Problem('JSON required.',415);
    req.setEncoding('utf8');
    const b=await readJson(req).catch(()=>{throw new Problem('Invalid request.');});
    if (!b || typeof b!=='object' || typeof b.id!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.id)) throw new Problem('Invalid listing or game.');
    if (!await allow('city:'+me.id,120,60,false)) throw new Problem('Please try again shortly.',429);
    // Bad-listing detector: new listings and listing messages are screened before saving.
    if (match[1]==='market' && (b.action==='create' || b.action==='inquire' || b.action==='message')) {
      if (b.action==='create' && !await store.hget(key,b.id)) {
        if (!await allow('list:'+me.id,20,86400,false)) throw new Problem('You have listed a lot today. Try again tomorrow.',429);
        const text=['Title: '+clean(b.title,80),'Price: '+clean(b.price,30),'Pickup: '+clean(b.venue,100),'Description: '+clean(b.description,360)].join('\n');
        const verdict=await screenListing('listing',text);
        if (!verdict.allowed) throw new Problem(verdict.reason || 'This listing was not accepted.',422);
      } else if (b.action!=='create') {
        const verdict=await screenListing('message',clean(b.message,400));
        if (!verdict.allowed) throw new Problem(verdict.reason || 'This message was not sent.',422);
      }
    }
    for (let attempt=0;attempt<25;attempt++) {
      let e=await store.hget<Entry>(key,b.id);
      const now=Date.now();
      if (e && !await expire(store,key,e,now)) continue;
      const revision=e?.revision ?? 0;
      // The hold or picking window can end while the write is in flight.
      const deadline=e?.kind==='item' ? e.until || undefined
        : e?.kind==='game' && b.action==='pick' ? e.closes : undefined;
      if (b.action==='create') {
        if (e && e.owner.id===me.id) return send(200,view(e,me,now));
        if (e) throw new Problem('Already exists.',409);
        const base={id:b.id,owner:me,title:required(b,'title',80),venue:required(b,'venue',100),created:now,revision:0};
        if (match[1]==='market' && b.dibs!==undefined && typeof b.dibs!=='boolean') {
          throw new Problem('Dibs must be true or false.');
        }
        e=match[1]==='market' ? {...base,kind:'item',dibs:b.dibs===true,price:listingPrice(b.price),description:clean(b.description,360),closed:false,queue:[],until:0,messages:[]}
          : {...base,kind:'game',...options(b),round:1,closes:now+300000,locked:false,result:null,ended:false,picks:{},history:[]};
      } else {
        if (!e) throw new Problem('No longer available.',404);
        if (update(e,b,me,now)===false) return send(200,view(e,me,now));
      }
      e.revision=revision+1;
      if (await store.compareRevision(key,e.id,revision,e,deadline)) return send(200,view(e,me,now));
    }
    throw new Problem('Busy right now. Please try again.',409);
  } catch(error) {
    send(error instanceof Problem ? error.status : 503,{error:error instanceof Problem ? error.message : 'City board temporarily unavailable.'});
  }
}
