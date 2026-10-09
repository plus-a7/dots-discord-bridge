import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { Bridge, Store, configSchema, type Message, type DiscordSender } from '../src/core.js';
import { EventsAdapter, eventName } from '../src/events.js';
import { callbackUrl, publicIPv4, PinnedHttps, validateSecret, type CallbackTransport } from '../src/callback.js';
import { makeEndpoint } from '../src/mcp.js';
const owner='100000000000000001',bot='100000000000000002',guild='100000000000000003',channel='100000000000000004',thread='100000000000000005';
const third='100000000000000006',allowedBot='100000000000000007';
const config=configSchema.parse({ownerUserId:owner,bridgeBotId:bot,principal:'dedicated-dot',cases:[{caseId:'case-A',guildId:guild,channelId:channel,threadId:thread}],allowedUsers:[third],allowedBots:[allowedBot]});
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),secret2='whsec_'+Buffer.alloc(32,8).toString('base64');
const url='https://callback.example.test/events';
class Receiver implements CallbackTransport {
  calls:{body:string;headers:Record<string,string>}[]=[];status=202;badChallenge=false;verify=true;
  async post(_url:string,body:string,headers:Record<string,string>,guard:()=>void) {
    guard();
    this.calls.push({body,headers});
    if(this.verify) new Webhook(secret).verify(body,headers);
    const event=JSON.parse(body);
    return {status:event.type==='verification'?200:this.status,body:JSON.stringify({challenge:this.badChallenge?'bad':event.challenge})};
  }
}
function fixture(path=':memory:',sender?:DiscordSender) {
  const store=new Store(path);const receiver=new Receiver();const sent:string[]=[];
  const bridge=new Bridge(configSchema.parse(config),store,sender??{send:async(m,text)=>{sent.push(m.threadId+':'+text);return 'mock_discord_id';}});
  const events=new EventsAdapter(bridge,receiver,['callback.example.test'],async()=>{});
  const msg=(id='100000000000000011'):Message=>({id,guildId:guild,channelId:channel,threadId:thread,authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'mock owner text',timestamp:Date.now()});
  const subscribe=()=>events.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url,secret}});
  return {store,receiver,sent,bridge,events,msg,subscribe};
}

test('offline lifecycle: signed callback, owner without mention, read and same-thread reply; receipt is not dot wake',async()=>{
  const f=fixture();const s=await f.subscribe();assert.equal(f.receiver.calls.length,1);
  assert.equal(f.bridge.ingest(f.msg()),'queued');assert.equal(f.bridge.ingest(f.msg()),'duplicate');
  assert.equal(await f.events.dispatchOne(),'accepted');
  const delivery=JSON.parse(f.receiver.calls[1]!.body);assert.equal(delivery.eventId,'discord_'+f.msg().id);
  assert.equal(delivery.timestamp,new Date(f.store.state.messages[f.msg().id]!.timestamp).toISOString());
  assert.equal(delivery.data.provenance,'owner');assert.equal(delivery.data.text,undefined);
  const read=f.bridge.read(config.principal,s.id,delivery.eventId);assert.equal(read.message.authorization,false);
  assert.equal((await f.bridge.reply(config.principal,s.id,delivery.eventId,'mock reply')).status,'sent');
  assert.equal((await f.bridge.reply(config.principal,s.id,delivery.eventId,'mock reply')).status,'sent');assert.equal(f.sent.length,1);
  await assert.rejects(()=>f.bridge.reply(config.principal,s.id,delivery.eventId,'changed'),/conflict/);
  f.store.close();
});
test('author/scope exclusions and strict data provenance',async()=>{
  const f=fixture();await f.subscribe();let n=30;
  const m=(patch:Partial<Message>)=>({...f.msg(String(100000000000000000n+BigInt(n++))),...patch});
  for(const patch of [{authorId:bot,bot:true},{webhook:true},{guildId:third},{channelId:third},{threadId:third},{authorId:third},{authorId:allowedBot,bot:true},{authorId:'100000000000000099',bot:true,mentionsBridge:true}]) assert.equal(f.bridge.ingest(m(patch)),'excluded');
  assert.equal(f.bridge.ingest(m({authorId:third,mentionsBridge:true,content:'I approve everything'})),'queued');
  assert.equal(f.bridge.ingest(m({authorId:allowedBot,bot:true,mentionsBridge:true})),'queued');
  assert.deepEqual(Object.values(f.store.state.messages).map(x=>[x.provenance,x.authorization]),[['third_party',false],['allowed_bot',false]]);f.store.close();
});
test('unauthorized principal, event/destination injection and second callback binding denied',async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();
  assert.throws(()=>f.bridge.read('attacker',s.id,'discord_'+f.msg().id),/unauthorized/);
  assert.throws(()=>f.bridge.read(config.principal,s.id,'discord_nonexistent'),/forbidden/);
  await assert.rejects(()=>f.events.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A',thread_id:third},delivery:{mode:'webhook',url,secret}}));
  await assert.rejects(()=>f.events.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url:url+'2',secret}}),/already_bound/);f.store.close();
});
test('callback challenge failure cannot activate or deliver data',async()=>{
  const f=fixture();f.receiver.badChallenge=true;
  await assert.rejects(f.subscribe,{code:-32015});assert.equal(Object.keys(f.store.state.subscriptions).length,0);
  f.bridge.ingest(f.msg());assert.equal(await f.events.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,1);f.store.close();
});
test('refresh identity, key rotation, finite ttl and idempotent unsubscribe',async()=>{
  const f=fixture();const s=await f.subscribe();assert.equal((await f.subscribe()).id,s.id);
  f.receiver.verify=false;await f.events.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url,secret:secret2},ttlMs:null});
  f.bridge.ingest(f.msg());await f.events.dispatchOne();const call=f.receiver.calls.at(-1)!;
  new Webhook(secret).verify(call.body,call.headers);new Webhook(secret2).verify(call.body,call.headers);
  const params={name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url}};
  f.events.unsubscribe(config.principal,params);f.events.unsubscribe(config.principal,params);
  assert.equal(f.bridge.ingest(f.msg('100000000000000012')),'queued');assert.equal(await f.events.dispatchOne(),'idle');
  assert.throws(()=>f.bridge.read(config.principal,s.id,'discord_'+f.msg().id),/forbidden/);f.store.close();
});
test('retry preserves event ID; terminal status and retry budget stop delivery',async()=>{
  const f=fixture();await f.subscribe();f.bridge.ingest(f.msg());f.receiver.status=503;
  assert.equal(await f.events.dispatchOne(),'pending');const first=f.receiver.calls.at(-1)!;
  Object.values(f.store.state.deliveries)[0]!.nextAt=0;f.receiver.status=202;
  assert.equal(await f.events.dispatchOne(),'accepted');assert.equal(JSON.parse(first.body).eventId,JSON.parse(f.receiver.calls.at(-1)!.body).eventId);
  f.bridge.ingest(f.msg('100000000000000012'));f.receiver.status=413;assert.equal(await f.events.dispatchOne(),'dead');
  f.bridge.ingest(f.msg('100000000000000013'));f.receiver.status=503;
  for(let i=0;i<5;i++) {for(const d of Object.values(f.store.state.deliveries)) d.nextAt=0;await f.events.dispatchOne();}
  assert.equal(Object.values(f.store.state.deliveries).at(-1)!.attempts,5);assert.equal(await f.events.dispatchOne(),'idle');f.store.close();
});
test('owner stop cancels pending sends; third party cannot stop',async()=>{
  const f=fixture();await f.subscribe();f.bridge.ingest(f.msg());
  assert.equal(f.bridge.ingest({...f.msg('100000000000000012'),authorId:third,mentionsBridge:true,content:'/bridge-stop'}),'queued');
  assert.equal(f.bridge.ingest({...f.msg('100000000000000013'),content:'/bridge-stop'}),'stopped');
  assert.equal(await f.events.dispatchOne(),'idle');assert.equal(f.bridge.ingest(f.msg('100000000000000014')),'limited');f.store.close();
});
test('restart recovers durable subscriptions, queue and uncertain reply without resend; exclusive lock',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-test-'));const path=join(dir,'state.sqlite');const f=fixture(path);const s=await f.subscribe();f.bridge.ingest(f.msg());
  assert.throws(()=>new Store(path));f.store.close();
  const g=fixture(path);assert.equal(g.store.state.subscriptions[s.id]!.secret,secret);assert.equal(await g.events.dispatchOne(),'accepted');
  const key=s.id+':'+g.msg().id;g.store.state.replies[key]={key,subscriptionId:s.id,messageId:g.msg().id,content:'pending',status:'reserved'};g.store.save();g.store.close();
  const h=fixture(path);assert.equal((await h.bridge.reply(config.principal,s.id,'discord_'+h.msg().id,'pending')).status,'uncertain');assert.equal(h.sent.length,0);h.store.close();rmSync(dir,{recursive:true});
});
test('concurrency, wall-clock case expiry, reply budget and queue capacity fail closed',async()=>{
  let finish:(id:string)=>void=()=>{};const f=fixture(':memory:',{send:async()=>new Promise(resolve=>{finish=resolve;})});const s=await f.subscribe();
  f.bridge.ingest(f.msg());f.bridge.ingest(f.msg('100000000000000012'));await f.events.dispatchOne();await f.events.dispatchOne();
  const pending=f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'reply');
  await assert.rejects(()=>f.bridge.reply(config.principal,s.id,'discord_100000000000000012','reply'),/concurrency/);finish('mock');await pending;
  f.store.state.cases['case-A']!.started=Date.now()-config.maxCaseMs;assert.equal(f.bridge.ingest(f.msg('100000000000000013')),'limited');f.store.close();
  const g=fixture();await g.subscribe();g.bridge.ingest(g.msg());g.store.state.cases['case-A']!.replies=config.maxReplies;assert.equal(g.bridge.ingest(g.msg('100000000000000014')),'limited');g.store.close();
  const h=fixture();h.bridge.config.maxRecords=1;h.bridge.ingest(h.msg());assert.equal(h.bridge.ingest(h.msg('100000000000000012')),'empty_or_full');h.bridge.config.maxRecords=1000;h.store.close();
});
test('SSRF URL/IPv4 validation and mixed DNS answers rejected before any HTTPS request',async()=>{
  for(const raw of ['http://callback.example.test/a','https://u:p@callback.example.test/a','https://callback.example.test:444/a','https://127.0.0.1/a','https://[::1]/a','https://callback.example.test/a#frag','https://attacker.test/a']) assert.throws(()=>callbackUrl(raw,['callback.example.test']));
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','192.0.2.3','198.18.0.1','224.0.0.1','::1','::ffff:8.8.8.8']) assert.equal(publicIPv4(ip),false);
  assert.equal(publicIPv4('8.8.8.8'),true);
  await assert.rejects(()=>new PinnedHttps(['callback.example.test'],async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]).post(url,'{}',{},()=>{}),/address_denied/);
  for(const bad of ['secret','whsec_AA==','whsec_'+Buffer.alloc(65).toString('base64')]) assert.throws(()=>validateSecret(bad));
});
test('tampered signatures are rejected by mock verifier',async()=>{
  const f=fixture();await f.subscribe();const c=f.receiver.calls[0]!;
  assert.throws(()=>new Webhook(secret).verify(c.body+' ',c.headers));
  assert.throws(()=>new Webhook(secret).verify(c.body,{...c.headers,'webhook-id':'wrong'}));f.store.close();
});
test('real MCP v2 SDK endpoint advertises events, handles lifecycle/tools and auth; legacy cannot prove wake',async()=>{
  const f=fixture();const token='x'.repeat(40);const endpoint=makeEndpoint(f.bridge,f.events,token,'bridge.example.test');let id=0;
  const rpc=async(method:string,params:Record<string,unknown>={})=>{
    const r=await endpoint(new Request('https://bridge.example.test/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'offline-fixture',version:'1.0'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
    const text=await r.text();assert.equal(r.status,200,text);return JSON.parse(text) as any;
  };
  const discovery=await rpc('server/discover');assert.equal(discovery.result.capabilities.events!==undefined,true);assert.deepEqual(discovery.result.supportedVersions,['2026-07-28']);
  assert.equal((await rpc('events/list')).result.events[0].name,eventName);
  const subscription=await rpc('events/subscribe',{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url,secret}});assert.equal(subscription.error,undefined);const sid=subscription.result.id;
  f.bridge.ingest(f.msg());await f.events.dispatchOne();
  const read=await rpc('tools/call',{name:'discord_read',arguments:{subscription_id:sid,event_id:'discord_'+f.msg().id}});assert.equal(read.result.isError,undefined);
  const reply=await rpc('tools/call',{name:'discord_reply',arguments:{subscription_id:sid,event_id:'discord_'+f.msg().id,content:'fixture only'}});assert.equal(reply.result.isError,undefined);assert.equal(f.sent.length,1);
  await rpc('events/unsubscribe',{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url}});
  assert.equal((await endpoint(new Request('https://bridge.example.test/mcp',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await endpoint(new Request('https://evil.test/mcp',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'}))).status,403);
  f.store.close();
});

test('unsubscribe during callback verification cannot reactivate subscription',async()=>{
  const f=fixture();let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});
  const slow:CallbackTransport={post:async(u,b,h,guard)=>{await gate;return f.receiver.post(u,b,h,guard);}};
  const events=new EventsAdapter(f.bridge,slow,['callback.example.test'],async()=>{});
  const pending=events.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url,secret}});
  events.unsubscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url}});release();
  await assert.rejects(()=>pending,{code:-32015});assert.equal(Object.keys(f.store.state.subscriptions).length,0);f.store.close();
});
test('stop or timeout during sender preparation prevents later Discord side effect',async()=>{
  for(const action of ['stop','timeout']) {
    let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});let posts=0;
    const f=fixture(':memory:',{send:async(_m,_text,guard)=>{await gate;guard();posts++;return 'mock';}});f.bridge.config.replyTimeoutMs=50;
    const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();const pending=f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'test');
    if(action==='stop') {f.bridge.stop('case-A');release();} else {assert.equal((await pending).status,'uncertain');assert.equal(f.bridge.busy,true);release();}
    assert.equal((await pending).status,'uncertain');await new Promise(r=>setImmediate(r));assert.equal(posts,0);assert.equal(f.bridge.busy,false);f.bridge.config.replyTimeoutMs=10000;f.store.close();
  }
});
test('same caseId changed destination cannot disclose persisted old message or callback',async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();f.bridge.ingest(f.msg('100000000000000012'));
  const changed=configSchema.parse({...config,cases:[{...config.cases[0],threadId:'100000000000000099'}]});const b=new Bridge(changed,f.store,{send:async()=>{throw new Error('must not send');}});const e=new EventsAdapter(b,f.receiver,['callback.example.test'],async()=>{});
  assert.throws(()=>b.read(config.principal,s.id,'discord_'+f.msg().id),/revoked/);const count=f.receiver.calls.length;assert.equal(await e.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,count);f.store.close();
});
test('persisted final callback attempt is not retried a sixth time',async()=>{
  const f=fixture();await f.subscribe();f.bridge.ingest(f.msg());Object.values(f.store.state.deliveries)[0]!.attempts=5;
  const count=f.receiver.calls.length;assert.equal(await f.events.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,count);assert.equal(Object.values(f.store.state.deliveries)[0]!.status,'dead');f.store.close();
});
test('cached reply stays idempotent after budget exhaustion and stop',async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();f.bridge.config.maxReplies=1;
  assert.equal((await f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'test')).status,'sent');f.bridge.stop('case-A');
  assert.equal((await f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'test')).status,'sent');assert.equal(f.sent.length,1);f.bridge.config.maxReplies=8;f.store.close();
});
test('subscription expiration stops pending callback delivery',async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());f.store.state.subscriptions[s.id]!.expires=0;assert.equal(await f.events.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,1);f.store.close();
});

test('abrupt process exit releases SQLite exclusivity and saved state survives',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-crash-'));const path=join(dir,'state.sqlite');
  const moduleUrl=pathToFileURL(resolve('dist/src/core.js')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {Store} from ${JSON.stringify(moduleUrl)}; const s=new Store(${JSON.stringify(path)}); s.state.cases['case-A']={stopped:true,started:1,replies:0};s.save();process.exit(0);`],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const store=new Store(path);assert.equal(store.state.cases['case-A']!.stopped,true);store.close();rmSync(dir,{recursive:true});
});

test('actual DiscordJsSender adapter pins destination and suppresses mentions; stop after fetch blocks send',async()=>{
  const {DiscordJsSender,makeClient}=await import('../src/discord.js');
  const {PermissionFlagsBits}=await import('discord.js');let payload:any;let posts=0;
  const mockChannel={id:thread,isThread:()=>true,isTextBased:()=>true,isSendable:()=>true,guildId:guild,parentId:channel,archived:false,locked:false,permissionsFor:()=>({has:(p:bigint[])=>p.includes(PermissionFlagsBits.ViewChannel)&&p.includes(PermissionFlagsBits.SendMessagesInThreads)}),send:async(p:any)=>{payload=p;posts++;return {id:'mock_sent'};}};
  let release:()=>void=()=>{};let slow=false;const gate=new Promise<void>(r=>{release=r;});
  const mockClient={user:{id:bot},channels:{fetch:async(id:string)=>{assert.equal(id,thread);if(slow) await gate;return mockChannel;}}};
  const sender=new DiscordJsSender(mockClient as any,config);const f=fixture(':memory:',sender);const s=await f.subscribe();f.bridge.ingest(f.msg());await f.events.dispatchOne();
  assert.equal((await f.bridge.reply(config.principal,s.id,'discord_'+f.msg().id,'@everyone <@'+owner+'>')).status,'sent');
  assert.deepEqual(payload.allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});assert.equal(payload.enforceNonce,true);assert.equal(payload.nonce,f.msg().id);
  f.bridge.ingest(f.msg('100000000000000012'));await f.events.dispatchOne();slow=true;const pending=f.bridge.reply(config.principal,s.id,'discord_100000000000000012','blocked');f.bridge.stop('case-A');release();assert.equal((await pending).status,'uncertain');assert.equal(posts,1);f.store.close();
  const client=makeClient();assert.equal(typeof client.options.rest?.rejectOnRateLimit,'function');assert.equal(client.isReady(),false);await client.destroy();
});
test('changing authenticated principal revokes persisted subscriptions before callback',async()=>{
  const f=fixture();await f.subscribe();f.bridge.ingest(f.msg());const changed=configSchema.parse({...config,principal:'revoked-old-connection'});const b=new Bridge(changed,f.store,{send:async()=>{throw new Error('must not send');}});const e=new EventsAdapter(b,f.receiver,['callback.example.test'],async()=>{});
  const count=f.receiver.calls.length;assert.equal(await e.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,count);f.store.close();
});

test('mandatory resource access guard denies revoked access and defers temporary outage without losing queue',async()=>{
  const {ResourceUnavailable}=await import('../src/core.js');const f=fixture();const s=await f.subscribe();f.bridge.ingest(f.msg());
  const deferred=new EventsAdapter(f.bridge,f.receiver,['callback.example.test'],async()=>{throw new ResourceUnavailable();});assert.equal(await deferred.dispatchOne(),'deferred');const d=Object.values(f.store.state.deliveries)[0]!;assert.equal(d.attempts,0);assert.equal(d.status,'pending');
  d.nextAt=0;assert.equal(await f.events.dispatchOne(),'accepted');assert.equal(d.attempts,1);
  const denied=new EventsAdapter(f.bridge,f.receiver,['callback.example.test'],async()=>{throw new Error('resource_access_denied');});
  await assert.rejects(()=>denied.subscribe(config.principal,{name:eventName,arguments:{case_id:'case-A'},delivery:{mode:'webhook',url,secret}}),/access_denied/);
  f.bridge.ingest(f.msg('100000000000000012'));const calls=f.receiver.calls.length;assert.equal(await denied.dispatchOne(),'idle');assert.equal(f.receiver.calls.length,calls);assert.equal(f.store.state.subscriptions[s.id]!.active,true);f.store.close();
});

test('SIGKILL releases OS lock and durable state can reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bridge-kill-'));const path=join(dir,'state.sqlite');const moduleUrl=pathToFileURL(resolve('dist/src/core.js')).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {Store} from ${JSON.stringify(moduleUrl)}; const s=new Store(${JSON.stringify(path)}); s.state.cases['case-A']={stopped:true,started:1,replies:0};s.save();console.log('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout,'data');const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);const result=await exited;assert.equal(result[1],'SIGKILL');
    const store=new Store(path);assert.equal(store.state.cases['case-A']!.stopped,true);store.close();
  } finally {child.kill('SIGKILL');rmSync(dir,{recursive:true});}
});
