// Bundle with esbuild for node and run with node --test --test-force-exit.
// Defaults to memory. CITY_TEST_REDIS_SOCKET can point to a disposable local Redis.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import test from 'node:test';
import { cityApi } from '../server/city.js';
import { getStore } from '../server/store.js';

test('city market and sports flows over HTTP', async t => {
  for (const key of ['REDIS_URL', 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'VERCEL']) delete process.env[key];
  const socket = process.env.CITY_TEST_REDIS_SOCKET;
  if (socket) {
    assert(isAbsolute(socket) && (await lstat(socket)).isSocket());
    process.env.REDIS_URL = socket;
  }
  const store = getStore();
  assert.equal(store.shared, Boolean(socket));
  const server = createServer((req, res) => cityApi(req, res, () => res.end()));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const city = randomUUID();
  const cookies: string[] = [];
  async function call(actor: number, board: string, body?: object, status = 200, region: string = city) {
    const response = await fetch(`http://127.0.0.1:${port}/api/city/${board}?city=${encodeURIComponent(region)}`, {
      method: body ? 'POST' : 'GET',
      headers: {cookie: cookies[actor] || '', 'content-type': 'application/json'},
      body: body && JSON.stringify(body),
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie) cookies[actor] = cookie.split(';')[0];
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    if (board === 'market' && data.entries) data.entries = data.entries.filter((entry: {sample?: boolean}) => !entry.sample);
    return data;
  }
  await Promise.all(Array.from({length: 9}, (_, i) => call(i, 'market')));
  const id = randomUUID();
  const base = {id, dibs:true, action:'create', title:'Bike', venue:'Station', price:'INR 250'};
  const market = (actor: number, action: string, fields = {}, status = 200) =>
    call(actor, 'market', {id, action, ...fields}, status);
  await t.test('unresolved locations cannot read or create city boards', async () => {
    for (const board of ['market','games']) {
      for (const region of ['||your location','|| Your  Location ','||','||12.3°, -45.6°',
        'country|region|12.3000° N · 45.6000° W','-12.3, 45.6']) {
        const readError = await call(0,board,undefined,400,region);
        const writeError = await call(0,board,{...base,question:'Who wins?',
          'first option':'Home','second option':'Away'},400,region);
        assert.equal(readError.error,'Pick a city first.');
        assert.deepEqual(writeError,readError);
      }
      await call(0,board,undefined,200,'country|region|District 12');
    }
  });
  await t.test('listing creation validates the full currency and amount', async () => {
    const region = city+'-prices';
    for (const price of ['US 2','USD','USD 0x10','USD 1e999','USD -1','USD -1e-999','USD '+'1'.repeat(27)]) {
      await call(0,'market',{...base,price},400,region);
    }
    assert.deepEqual((await call(0,'market',undefined,200,region)).entries,[]);
    const free = await call(0,'market',{...base,price:'USD 0.00'},200,region);
    assert.equal(free.price,'USD 0.00');
    const key = 'city:market:'+createHash('sha256').update(region).digest('hex');
    const stored = await store.hget<typeof free>(key,base.id);
    stored.price = 'Free to collect';
    await store.hset(key,base.id,stored);
    assert.equal((await call(1,'market',undefined,200,region)).entries[0].price,stored.price);
  });
  const created = await Promise.all([call(0,'market',base), call(0,'market',base)]);
  assert.deepEqual(created[0], created[1]);
  assert.equal(created[0].dibs,true);
  const inquiry = await market(1,'inquire',{message:'Is pickup possible this evening?'});
  assert.equal(inquiry.position,-1);
  const ownerReply = await market(0,'inquire',{buyer:inquiry.inquiries[0].buyer,message:'Yes, after six.'});
  assert.equal(ownerReply.count,0);
  assert.deepEqual((await call(1,'market')).entries[0].inquiries,ownerReply.inquiries);
  assert.deepEqual((await call(2,'market')).entries[0].inquiries,[]);
  await call(1,'market',base,409);
  assert.deepEqual((await call(0,'market',undefined,200,city+'-elsewhere')).entries, []);
  const claims = await Promise.all([1,2,3].map(actor => market(actor,'claim',guard(created[0]))));
  const actors = [1,2,3].sort((a,b) => claims[a-1].position - claims[b-1].position);
  assert.deepEqual(actors.map(i => claims[i-1].position), [0,1,2]);
  const current = (await call(0,'market')).entries[0];
  assert.equal((await market(actors[0],'claim')).revision, current.revision);
  const sent = await market(actors[0],'message',{...guard(current),message:'Private pickup'});
  assert.equal(sent.messages.length,1);
  assert.deepEqual(await market(actors[0],'message',{...guard(current),message:'Private pickup'}),sent);
  const waiting = (await call(actors[1],'market')).entries[0];
  assert.deepEqual(waiting.messages, []);
  assert.equal(waiting.holder, undefined);
  await market(actors[1],'message',{...guard(sent),message:'hello'},409);

  // Move only this fixture's deadline, keeping Redis and application clocks real.
  const hash = createHash('sha256').update(city).digest('hex');
  const key = 'city:market:'+hash;
  const held = await store.hget<typeof sent>(key,id);
  held.until = Date.now()-20;
  await store.hset(key,id,held);
  const promoted = await call(0,'market',base);
  assert.equal(promoted.count,2);
  assert.deepEqual(promoted.messages,[]);
  assert.deepEqual((await store.hget<typeof sent>(key,id)).messages,[]);
  await market(actors[0],'claim',guard(created[0]),409);
  await market(0,'sold',guard(sent),409);
  assert.equal((await call(actors[1],'market')).entries[0].position,0);
  const sold = await market(0,'sold',guard(promoted));
  assert(sold.closed);
  assert.equal(sold.sold,true);
  assert.equal((await call(4,'market')).entries[0].sold,true);
  assert.equal(sold.count,1);
  await market(actors[2],'claim',{},409);
  assert.equal(await store.compareRevision(key,id,sold.revision,{revision:999},Date.now()-1),false);

  const secondId = randomUUID();
  const second = await call(0,'market',{...base,id:secondId});
  const legacy = await store.hget<typeof second>(key,secondId);
  delete legacy.dibs;
  await store.hset(key,secondId,legacy);
  assert.equal((await call(0,'market',{...base,id:secondId})).dibs,true);
  const join = await call(1,'market',{id:secondId,action:'claim',...guard(second)});
  const leave = {id:secondId,action:'leave',...guard(join)};
  const left = await call(1,'market',leave);
  assert.deepEqual(await call(1,'market',leave),left);
  await call(1,'market',{id:secondId,action:'claim',...guard(left)});
  await call(1,'market',leave,409);
  await call(2,'market',{id:secondId,action:'claim'});
  const overdue = await store.hget<typeof sent>(key,secondId);
  overdue.until = Date.now() - 15 * 60_000;
  overdue.messages = [{who:'Seller',text:'Old pickup address'}];
  await store.hset(key,secondId,overdue);
  const polled = await Promise.all([0,1,2].map(actor => call(actor,'market')));
  for (const page of polled) {
    const item = page.entries.find((entry: {id:string}) => entry.id===secondId);
    assert.equal(item.count,0);
    assert.deepEqual(item.messages,[]);
  }
  const cleared = await store.hget<typeof sent>(key,secondId);
  assert.equal(cleared.until,0);
  assert.deepEqual(cleared.messages,[]);
  const closedDibs = await call(0,'market',{id:secondId,action:'close',...guard(cleared)});
  assert.equal(closedDibs.closed,true);
  assert.equal(closedDibs.sold,false);
  const publicItems = (await call(4,'market')).entries;
  assert.equal(publicItems.find((item: {id:string}) => item.id===secondId).sold,false);
  await call(0,'market',{...base,id:'-'.repeat(36)},400);
  await call(0,'market',undefined,400,'a'.repeat(221));

  await t.test('pickup messages follow the hold across joins, retries and deadline collisions', async () => {
    const region = city+'-pickup';
    const listingId = randomUUID();
    const post = (actor:number, action:string, fields = {}, status=200) =>
      call(actor,'market',{...fields,id:listingId,action},status,region);
    const read = async (actor:number) => (await call(actor,'market',undefined,200,region)).entries[0];
    await post(0,'create',base);
    const realNow = Date.now;
    const fixedTime = realNow();
    Date.now = () => fixedTime;
    try {
      const holder = await post(1,'claim');
      assert.equal(typeof holder.holdToken,'string');
      const waiter = await post(2,'claim');
      assert.equal(waiter.holdToken,undefined);
      const draft = {holdToken:holder.holdToken, ...guard(holder), message:'Old pickup',requestId:randomUUID()};
      const saved = await Promise.all([post(1,'message',draft),post(1,'message',draft)]);
      assert.deepEqual(saved[0],saved[1]);
      assert.equal(saved[0].messages.length,1);
      assert.deepEqual(Object.keys(saved[0].messages[0]).sort(),['text','who']);
      await post(0,'message',{...guard(holder),message:'Legacy sender'});
      await post(2,'message',draft,409);
      assert.deepEqual((await read(2)).messages,[]);
      await post(1,'leave');
      const promoted = await read(2);
      assert.equal(promoted.until,holder.until);
      assert.equal(promoted.position,0);
      assert.notEqual(promoted.holdToken,holder.holdToken);
      assert.deepEqual(promoted.messages,[]);
      await post(0,'message',{...draft,...guard(promoted)},409);
      await post(0,'message',{...guard(holder),message:'Legacy stale draft'},409);
      await post(1,'message',draft,409);
      const reply = await post(0,'message',{holdToken:promoted.holdToken,message:'New pickup'});
      assert.equal(reply.messages.length,1);
      assert.deepEqual((await read(2)).messages,reply.messages);
      assert.deepEqual((await read(1)).messages,[]);
      assert.equal((await read(1)).holdToken,undefined);
    } finally { Date.now = realNow; }
  });

  await t.test('ordinary listings and private buyer inquiries', async () => {
    const region = city+'-ordinary';
    const listingId = randomUUID();
    const post = (actor: number, action: string, fields = {}, status = 200) =>
      call(actor,'market',{id:listingId,action,...fields},status,region);
    const read = async (actor: number) => (await call(actor,'market',undefined,200,region)).entries[0];
    const fields = {title:'Lamp',venue:'Town hall',price:'INR 150'};
    await post(0,'create',{...fields,dibs:'false'},400);
    const listing = await post(0,'create',fields);
    assert.equal(listing.dibs,false);
    assert.equal(listing.sold,false);
    assert.deepEqual(listing.inquiries,[]);
    for (const action of ['claim','leave','message','sold','close']) {
      await post(1,action,guard(listing),409);
    }
    await post(0,'inquire',{message:'No buyer yet'},409);
    await post(1,'inquire',{message:' '},400);
    const send = (actor: number, message: string, fields = {}, status = 200) =>
      post(actor,'inquire',{message,revision:listing.revision,...fields},status);
    const first = await send(1,'First question');
    const firstBuyer = first.inquiries[0].buyer;
    assert.deepEqual(await send(1,'First question'),first);
    await send(0,'Single thread reply');
    await Promise.all([send(1,'Size?'),send(1,'Weight?'),send(2,'Available?'),send(3,'Pickup?')]);
    const seller = await read(0);
    assert.equal(seller.inquiries.length,3);
    const firstThread = (await read(1)).inquiries;
    assert.equal(firstThread.length,1);
    assert.deepEqual(Object.keys(firstThread[0]).sort(),['buyer','messages','name']);
    assert.equal(firstThread[0].buyer,firstBuyer);
    assert.deepEqual(firstThread[0].messages.map((m: {text:string}) => m.text).sort(),
      ['First question','Single thread reply','Size?','Weight?'].sort());
    const secondBuyer = (await read(2)).inquiries[0].buyer;
    assert.notEqual(firstBuyer,secondBuyer);
    assert.deepEqual((await read(4)).inquiries,[]);
    for (const cookie of cookies) assert(!JSON.stringify(seller).includes(cookie.split('=')[1].split('.')[0]));
    await send(0,'Ambiguous',{},409);
    await send(0,'Unknown buyer',{buyer:randomUUID()},409);
    await send(3,'Wrong thread',{buyer:secondBuyer},409);
    const reply = await send(0,'Yes, available',{buyer:secondBuyer});
    assert.equal(reply.inquiries.length,3);
    assert.deepEqual((await read(2)).inquiries[0].messages.map((m: {text:string}) => m.text),
      ['Available?','Yes, available']);
    assert.deepEqual((await read(1)).inquiries,firstThread);
    const sold = await post(0,'sold');
    assert.equal(sold.closed,true);
    assert.equal(sold.sold,true);
    assert.equal((await read(4)).sold,true);
    await send(1,'After sale',{},409);
    assert.deepEqual((await read(4)).inquiries,[]);
    const another = randomUUID();
    await post(0,'create',{...fields,id:another,dibs:false});
    const inquiry = await post(1,'inquire',{id:another,message:'New listing'});
    assert.notEqual(inquiry.inquiries[0].buyer,firstBuyer);
    await post(0,'inquire',{id:another,message:'Wrong listing',buyer:firstBuyer},409);
    const closed = await post(0,'close',{id:another});
    assert(closed.closed);
    assert.equal(closed.sold,false);
    const refreshed = (await call(4,'market',undefined,200,region)).entries;
    assert.equal(refreshed.find((item: {id:string}) => item.id===another).sold,false);
  });

  const game = (actor: number, action: string, fields = {}, status = 200) =>
    call(actor,'games',{id, action, round:1,...fields},status);
  const options = {question:'Winner?', 'first option':'Home', 'second option':'Away'};
  await game(0,'create',{...base,...options});
  await Promise.all(Array.from({length:8}, (_,i) => game(i+1,'pick',{choice:i%2})));
  const votes = (await call(0,'games')).entries[0];
  assert.deepEqual(votes.counts,[4,4]);
  assert.equal(votes.pick,null);
  assert.equal((await game(1,'pick',{choice:0})).revision,votes.revision);
  await game(1,'lock',{},409);
  await game(0,'result',{choice:0},409);
  await game(0,'lock');
  await game(2,'pick',{choice:0},409);
  const result = await game(0,'result',{choice:1});
  assert.deepEqual(result.history,[{question:'Winner?',answer:'Away',correct:4,total:8}]);
  await game(0,'result',{choice:1},409);
  const next = await game(0,'next',options);
  assert.deepEqual(next.counts,[0,0]);
  await game(1,'pick',{choice:1},409);
  const gameKey = 'city:games:'+hash;
  const expired = await store.hget<typeof next>(gameKey,id);
  expired.closes = Date.now()-1;
  await store.hset(gameKey,id,expired);
  await game(1,'pick',{round:2,choice:1},409);
  await game(0,'result',{round:2,choice:0});
  assert((await game(0,'end',{round:2})).ended);

  const abandoned = randomUUID();
  const abandon = (actor: number, action: string, fields = {}, status = 200) =>
    call(actor,'games',{round:1,...fields,id:abandoned,action},status);
  await abandon(0,'create',{...base,id:abandoned,...options});
  await abandon(1,'pick',{choice:0});
  await abandon(1,'void',{},409);
  await abandon(0,'lock');
  await abandon(0,'result',{choice:0});
  await abandon(0,'next',{...options,question:'Second goal?'});
  await abandon(1,'void',{round:2},409);
  await abandon(0,'void',{round:1},409);
  await abandon(1,'pick',{round:2,choice:1});
  await abandon(0,'lock',{round:2});
  const [voided,retry] = await Promise.all([abandon(0,'void',{round:2}),abandon(0,'void',{round:2})]);
  assert.deepEqual(retry,voided);
  assert.deepEqual(voided.counts,[0,0]);
  assert.equal(voided.ended,true);
  assert.equal(voided.result,null);
  assert.equal(voided.question,'Second goal?');
  assert.deepEqual(voided.history,[{question:'Winner?',answer:'Home',correct:1,total:1}]);
  assert.deepEqual(await abandon(0,'void',{round:2}),voided);
  await abandon(1,'void',{round:2},409);
  await abandon(0,'result',{round:2,choice:1},409);
  const observer = (await call(1,'games')).entries.find((g: {id:string}) => g.id===abandoned);
  assert.equal(observer.pick,null);
  assert.deepEqual(observer.history,voided.history);
  const openId = randomUUID();
  await call(0,'games',{...base,...options,id:openId});
  const openVoid = await call(0,'games',{id:openId,action:'void',round:1});
  assert.equal(openVoid.ended,true);
  assert.equal(openVoid.result,null);
  assert.deepEqual(openVoid.history,[]);
  await abandon(1,'pick',{round:2,choice:0},409);
  await abandon(0,'next',{round:2,...options},409);
  const settled = randomUUID();
  const closed = (action: string, fields = {}, status = 200) => call(0,'games',{id:settled,action,round:1,...fields},status);
  await closed('create',{...base,id:settled,...options});
  await closed('lock');
  await closed('result',{choice:1});
  await closed('void',{},409);
});

function guard(item: {revision:number; until:number}) {
  return {revision:item.revision, until:item.until};
}
