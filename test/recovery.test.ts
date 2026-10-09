import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Webhook } from 'standardwebhooks';
import { Bridge, Store, configSchema, guildScope, type Message, type DiscordSender } from '../src/core.js';
import { EventsAdapter, eventName } from '../src/events.js';
import { PinnedHttps, signedHeaders, type CallbackTransport } from '../src/callback.js';
import { attachGateway } from '../src/discord.js';
import { makeEndpoint } from '../src/mcp.js';

const owner='100000000000000001',bot='100000000000000002',guild='100000000000000003',channel='100000000000000004';
const config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:'mock-owner'});
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),nextSecret='whsec_'+Buffer.alloc(32,8).toString('base64');
const url='https://callback.example.test/events';
const subscriptionParams={name:eventName,arguments:{guild_id:guild},delivery:{mode:'webhook',url,secret}};
const unsubscribeParams={name:eventName,arguments:{guild_id:guild},delivery:{mode:'webhook',url}};
const message=(timestamp:number,patch:Partial<Message>={}):Message=>({id:'100000000000000011',guildId:guild,channelId:channel,threadId:null,authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'mock only',timestamp,...patch});
function fixture(sender?:DiscordSender) {
  const store=new Store(':memory:');let time=Date.now();let posts=0;
  const bridge=new Bridge(configSchema.parse(config),store,sender??{send:async(_m,_c,guard)=>{guard();posts++;return 'mock-reply';}},()=>time);
  const calls:{body:string;headers:Record<string,string>}[]=[];let status=202;
  const transport:CallbackTransport={post:async(_u,body,headers,guard)=>{guard();calls.push({body,headers});const data=JSON.parse(body);return {status:data.type==='verification'?200:status,body:JSON.stringify({challenge:data.challenge})};}};
  const events=new EventsAdapter(bridge,transport,['callback.example.test'],async()=>{});
  return {store,bridge,events,calls,transport,subscribe:()=>events.subscribe(config.principal,subscriptionParams),msg:()=>message(time),advance:(ms:number)=>{time+=ms;},setStatus:(s:number)=>{status=s;},posts:()=>posts};
}
const actions=['stop-all','unsubscribe','ttl','case-expiry','owner-change','subscription-refresh'] as const;
for(const action of actions) test(`callback DNS preparation cannot start HTTPS after ${action}`,async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let connects=0;
  const pinned=new PinnedHttps(['callback.example.test'],async()=>{entered();await gate;return [{address:'8.8.8.8',family:4}];},(()=>{connects++;throw new Error('mock network must never start');}) as any);
  const events=new EventsAdapter(f.bridge,pinned,['callback.example.test'],async()=>{});const pending=events.dispatchOne();await ready;
  if(action==='stop-all') f.bridge.ingest({...f.msg(),id:'100000000000000012',content:'/bridge-stop-all'});
  if(action==='unsubscribe') f.events.unsubscribe(config.principal,unsubscribeParams);
  if(action==='ttl') f.store.state.subscriptions[s.id]!.expires=f.bridge.now();
  if(action==='case-expiry') f.advance(config.maxCaseMs);
  if(action==='owner-change') f.bridge.config.ownerUserId='100000000000000099';
  if(action==='subscription-refresh') await f.subscribe();
  release();await pending;assert.equal(connects,0);assert.equal(f.calls.length,action==='subscription-refresh'?2:1);f.store.close();
});

test('callback verification DNS cancellation cannot create a subscription or a network request',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let connects=0;
  const pinned=new PinnedHttps(['callback.example.test'],async()=>{entered();await gate;return [{address:'8.8.8.8',family:4}];},(()=>{connects++;throw new Error('no network');}) as any);
  const events=new EventsAdapter(f.bridge,pinned,['callback.example.test'],async()=>{});
  const pending=events.subscribe(config.principal,subscriptionParams);await ready;events.unsubscribe(config.principal,unsubscribeParams);release();
  await assert.rejects(()=>pending,{code:-32015});assert.equal(connects,0);assert.equal(Object.keys(f.store.state.subscriptions).length,0);f.store.close();
});

test('access revoked during verification is rechecked before subscription activation',async()=>{
  const f=fixture();let checks=0;
  const events=new EventsAdapter(f.bridge,f.transport,['callback.example.test'],async()=>{if(++checks===2) throw new Error('revoked');});
  await assert.rejects(()=>events.subscribe(config.principal,subscriptionParams),/revoked/);assert.equal(f.calls.length,1);assert.equal(Object.keys(f.store.state.subscriptions).length,0);f.store.close();
});

for(const action of ['stop-all','unsubscribe','ttl','case-expiry'] as const) test(`guild reply preparation is cancelled by ${action}`,async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let posts=0;
  const f=fixture({send:async(_m,_c,guard)=>{await gate;guard();posts++;return 'never';}});const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();
  const pending=f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'mock');
  if(action==='stop-all') f.bridge.ingest({...f.msg(),id:'100000000000000012',content:'/bridge-stop-all'});
  if(action==='unsubscribe') f.events.unsubscribe(config.principal,unsubscribeParams);
  if(action==='ttl') f.store.state.subscriptions[s.id]!.expires=f.bridge.now();
  if(action==='case-expiry') f.advance(config.maxCaseMs);
  release();assert.equal((await pending).status,'uncertain');assert.equal(posts,0);f.store.close();
});

test('retry classes, exact backoff, 410 deactivation and expired rotation key',async()=>{
  for(const status of [408,429,503,401,410,413]) {
    const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());f.setStatus(status);const before=f.bridge.now();
    assert.equal(await f.events.dispatchOne(),[408,429,503].includes(status)?'pending':'dead');
    const d=Object.values(f.store.state.deliveries)[0]!;assert.equal(d.attempts,1);
    if(d.status==='pending') {assert.equal(d.nextAt,before+1000);assert.equal(await f.events.dispatchOne(),'idle');f.advance(1000);await f.events.dispatchOne();assert.equal(d.nextAt,f.bridge.now()+2000);}
    assert.equal(f.store.state.subscriptions[s.id]!.active,status!==410);f.store.close();
  }
  const f=fixture();await f.subscribe();await f.events.subscribe(config.principal,{...subscriptionParams,delivery:{...subscriptionParams.delivery,secret:nextSecret}});
  f.advance(60001);f.bridge.ingest(f.msg());await f.events.dispatchOne();const call=f.calls.at(-1)!;
  assert.throws(()=>new Webhook(secret).verify(call.body,call.headers));new Webhook(nextSecret).verify(call.body,call.headers);
  assert.equal(Object.values(f.store.state.subscriptions)[0]!.oldSecret,undefined);f.store.close();
});

test('mock receiver verifies signature age and deduplicates replay separately from HMAC verification',()=>{
  const body=JSON.stringify({eventId:'mock-event'}),now=Date.now();const headers=signedHeaders('mock-event',body,'mock-sub',secret,now);
  const seen=new Set<string>();let effects=0;
  const receive=(h:Record<string,string>)=>{new Webhook(secret).verify(body,h);if(!seen.has(h['webhook-id']!)){seen.add(h['webhook-id']!);effects++;}};
  receive(headers);receive(headers);assert.equal(effects,1); // A valid HMAC alone does not reject replay.
  for(const time of [now-600000,now+600000]) assert.throws(()=>receive(signedHeaders('mock-event',body,'mock-sub',secret,time)));
  assert.throws(()=>receive({...headers,'webhook-timestamp':'not-a-number'}));
});

test('acceptance-before-save crash retries same event with fresh signature and never duplicates saved reply',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-receipt-crash-')),path=join(dir,'state.sqlite'),receipt=join(dir,'mock-receipt.json');
  try {
    const core=pathToFileURL(resolve('dist/src/core.js')).href,events=pathToFileURL(resolve('dist/src/events.js')).href;
    const script=`import {Store,Bridge,configSchema} from ${JSON.stringify(core)};import {EventsAdapter} from ${JSON.stringify(events)};import {writeFileSync} from 'node:fs';
      const store=new Store(${JSON.stringify(path)});const b=new Bridge(configSchema.parse(${JSON.stringify(config)}),store,{send:async()=> 'saved-mock-reply'});
      const e=new EventsAdapter(b,{post:async(_u,body,headers,guard)=>{guard();const data=JSON.parse(body);if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};
      await b.reply(${JSON.stringify(config.principal)},headers['X-MCP-Subscription-Id'],data.eventId,'mock reply');
      writeFileSync(${JSON.stringify(receipt)},JSON.stringify({body,headers}),{mode:0o600});process.exit(0);}},['callback.example.test'],async()=>{});
      await e.subscribe(${JSON.stringify(config.principal)},${JSON.stringify(subscriptionParams)});b.ingest(${JSON.stringify(message(Date.now()))});await e.dispatchOne();`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
    const accepted=JSON.parse(readFileSync(receipt,'utf8'));new Webhook(secret).verify(accepted.body,accepted.headers);
    const store=new Store(path);let sends=0,calls=0;const b=new Bridge(configSchema.parse(config),store,{send:async()=>{sends++;return 'never';}},()=>Date.now()+2000);
    const e=new EventsAdapter(b,{post:async(_u,body,headers,guard)=>{guard();calls++;assert.equal(body,accepted.body);assert.equal(headers['webhook-id'],accepted.headers['webhook-id']);assert.notEqual(headers['webhook-timestamp'],accepted.headers['webhook-timestamp']);new Webhook(secret).verify(body,headers);return {status:202,body:''};}},['callback.example.test'],async()=>{});
    const d=Object.values(store.state.deliveries)[0]!;assert.equal(d.status,'pending');assert.equal(d.attempts,1);
    assert.equal(await e.dispatchOne(),'accepted');assert.equal(d.attempts,2);assert.equal(calls,1);
    assert.equal((await b.reply(config.principal,d.subscriptionId,d.eventId,'mock reply')).discordId,'saved-mock-reply');assert.equal(sends,0);store.close();
  } finally {rmSync(dir,{recursive:true});}
});

test('gateway registration rejects unready/wrong identity and self/other bot feedback without creating queue events',async()=>{
  const f=fixture();await f.subscribe();const handlers=new Map<string,Function>();let ready=false,identity=bot;
  const client:any={on:(event:string,fn:Function)=>handlers.set(event,fn),isReady:()=>ready,get user(){return {id:identity};}};const codes:string[]=[];attachGateway(client,f.bridge,code=>codes.push(code));
  const m:any={id:f.msg().id,guildId:guild,partial:false,system:false,createdTimestamp:f.bridge.now(),webhookId:null,content:'mock',author:{id:owner,bot:false},mentions:{users:{has:()=>false}},channel:{id:channel,guildId:guild,isThread:()=>false,isTextBased:()=>true}};
  const receive=handlers.get('messageCreate')!;receive(m);ready=true;identity='100000000000000099';receive(m);assert.equal(Object.keys(f.store.state.messages).length,0);identity=bot;receive(m);await f.events.dispatchOne();
  for(const author of [{id:bot,bot:true},{id:'100000000000000099',bot:true},{id:owner,bot:true}]) receive({...m,id:'100000000000000012',author,mentions:{users:{has:()=>true}}});
  assert.equal(Object.keys(f.store.state.messages).length,1);assert.equal(f.calls.length,2);assert.deepEqual(codes,['discord_identity_unconfirmed','discord_identity_unconfirmed']);assert.equal(f.store.state.subscriptions[Object.keys(f.store.state.subscriptions)[0]!]!.caseId,guildScope(guild));f.store.close();
});

test('inactive callback identities have a bounded persistent capacity; refresh remains possible',async()=>{
  const f=fixture();f.bridge.config.maxSubscriptions=1;await f.subscribe();f.events.unsubscribe(config.principal,unsubscribeParams);
  const calls=f.calls.length;
  await assert.rejects(()=>f.events.subscribe(config.principal,{...subscriptionParams,delivery:{...subscriptionParams.delivery,url:url+'/other'}}),/capacity/);assert.equal(f.calls.length,calls);
  await f.subscribe();assert.equal(Object.keys(f.store.state.subscriptions).length,1);f.store.close();
});

test('oversized authenticated request returns 413 even when stream cancellation never settles',{timeout:1000},async()=>{
  const f=fixture();const token='x'.repeat(40),endpoint=makeEndpoint(f.bridge,f.events,token,'bridge.example.test');let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;return new Promise(()=>{});}});
  const request=new Request('https://bridge.example.test/mcp',{method:'POST',headers:{authorization:'Bearer '+token},body,duplex:'half'} as any);
  assert.equal((await endpoint(request)).status,413);assert.equal(cancelled,true);assert.equal(Object.keys(f.store.state.messages).length,0);f.store.close();
});
