import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge,Store,configSchema,originCaseId,guildScope,type Message,type Origin,type RecordMessage } from '../src/core.js';
import { EventsAdapter,eventName } from '../src/events.js';
import { DiscordJsSender,normalize,resourceAccessGuard } from '../src/discord.js';
import { makeMockRuntime,runMockDemo } from '../src/mock-runtime.js';
const owner='100000000000000001',bot='100000000000000002',guild='100000000000000003',channel='100000000000000004',thread='100000000000000005';
const other='100000000000000099';
const config=configSchema.parse({mode:'guild_owner',guildId:guild,ownerUserId:owner,bridgeBotId:bot,principal:'guild-dot'});
const base:Origin={guildId:guild,channelId:channel,threadId:null};
const msg=(patch:Partial<Message>={}):Message=>({...base,id:'100000000000000011',authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'mock input',timestamp:Date.now(),...patch});
function fixture(path=':memory:') {
  const store=new Store(path);const sent:Origin[]=[];const bridge=new Bridge(configSchema.parse(config),store,{send:async(m,_c,guard)=>{guard();sent.push({guildId:m.guildId,channelId:m.channelId,threadId:m.threadId});return 'mock';}});
  const e=new EventsAdapter(bridge,{post:async(_u,body,_h,guard)=>{guard();return {status:202,body:JSON.stringify({challenge:JSON.parse(body).challenge})};}},['mock.example.test'],async()=>{});
  const secret='whsec_'+Buffer.alloc(32,7).toString('base64');const delivery={mode:'webhook',url:'https://mock.example.test/events',secret};
  return {bridge,e,store,sent,delivery,subscribe:()=>e.subscribe(config.principal,{name:eventName,arguments:{guild_id:guild},delivery})};
}
test('guild-wide owner input accepts multiple channels and threads without mentions; all other authors/scopes denied',async()=>{
  const f=fixture();const s=await f.subscribe();
  const input=[msg(),msg({id:'100000000000000012',channelId:other}),msg({id:'100000000000000013',threadId:thread})];
  for(const m of input) {assert.equal(f.bridge.ingest(m),'queued');assert.equal(await f.e.dispatchOne(),'accepted');assert.equal((await f.bridge.reply(config.principal,s.id,'discord_'+m.id,'mock reply')).status,'sent');}
  assert.deepEqual(f.sent,input.map(m=>({guildId:m.guildId,channelId:m.channelId,threadId:m.threadId})));
  for(const patch of [{guildId:other},{guildId:''},{authorId:other,mentionsBridge:true},{authorId:bot,bot:true},{authorId:owner,bot:true},{authorId:other,bot:true,mentionsBridge:true},{webhook:true}]) assert.equal(f.bridge.ingest(msg({id:'100000000000000014',...patch})),'excluded');
  assert.equal(f.bridge.ingest(input[0]!),'duplicate');assert.deepEqual(Object.values(f.store.state.messages).map(m=>[m.provenance,m.authorization]),[['owner',false],['owner',false],['owner',false]]);
  assert.throws(()=>configSchema.parse({...config,allowedBots:[other]}));assert.throws(()=>configSchema.parse({...config,allowedUsers:[other]}));f.store.close();
});
test('guild subscription cannot broaden scope or accept destination input; one origin stop does not stop others',async()=>{
  const f=fixture();const s=await f.subscribe();assert.deepEqual(f.e.list(config.principal).events[0]!.inputSchema.required,['guild_id']);
  for(const args of [{guild_id:other},{case_id:'made-up'},{guild_id:guild,channel_id:channel},{guild_id:guild,case_id:'made-up'}]) await assert.rejects(()=>f.e.subscribe(config.principal,{name:eventName,arguments:args,delivery:f.delivery}));
  f.bridge.ingest(msg());assert.equal(f.bridge.ingest(msg({id:'100000000000000012',content:'/bridge-stop'})),'stopped');
  assert.equal(await f.e.dispatchOne(),'idle');assert.equal(f.bridge.ingest(msg({id:'100000000000000013'})),'limited');
  const second=msg({id:'100000000000000014',channelId:other});assert.equal(f.bridge.ingest(second),'queued');assert.equal(await f.e.dispatchOne(),'accepted');assert.equal((await f.bridge.reply(config.principal,s.id,'discord_'+second.id,'other channel')).status,'sent');
  assert.equal(f.bridge.ingest(msg({id:'100000000000000015',content:'/bridge-stop-all'})),'stopped');assert.throws(()=>f.bridge.subscription(config.principal,s.id));assert.notEqual(f.bridge.ingest(msg({id:'100000000000000016',channelId:thread})),'queued');f.store.close();
});
test('persisted dynamic origins/queue/subscription recover and global stop survives restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'guild-restart-'));const path=join(dir,'state.sqlite');let f=fixture(path);const s=await f.subscribe();const m=msg({threadId:thread});f.bridge.ingest(m);f.store.close();
  f=fixture(path);assert.deepEqual(f.bridge.binding(originCaseId(m)),{guildId:guild,channelId:channel,threadId:thread});assert.equal(await f.e.dispatchOne(),'accepted');assert.equal(f.bridge.read(config.principal,s.id,'discord_'+m.id).message.id,m.id);
  f.bridge.ingest(msg({id:'100000000000000012',content:'/bridge-stop-all'}));f.store.close();f=fixture(path);assert.equal(f.store.state.guildStopped,true);await assert.rejects(f.subscribe,/stopped/);f.store.close();rmSync(dir,{recursive:true});
});
test('dynamic origin cap and altered parent/guild/destination fail closed',async()=>{
  const f=fixture();await f.subscribe();f.bridge.config.maxOrigins=1;assert.equal(f.bridge.ingest(msg({threadId:thread})),'queued');assert.equal(f.bridge.ingest(msg({id:'100000000000000012',channelId:other})),'empty_or_full');
  const saved=f.store.state.messages[msg().id]!;assert.equal(Object.keys(f.store.state.origins).length,1);
  for(const patch of [{guildId:other},{channelId:other},{threadId:other}]) assert.throws(()=>f.bridge.sameBinding({...saved,...patch}),/revoked/);
  f.store.state.origins[saved.caseId]!.channelId=other;assert.throws(()=>f.bridge.binding(saved.caseId),/forbidden/);f.store.close();
});
test('Discord adapters reject same-named foreign guild, wrong parent or channel/thread substitution without permission changes',async()=>{
  const f=fixture();await f.subscribe();const m=msg({threadId:thread});f.bridge.ingest(m);const record=f.store.state.messages[m.id]!;
  let posts=0;let fetched='';let channelObject:any={id:thread,name:'same-name',guildId:guild,parentId:channel,isThread:()=>true,isTextBased:()=>true,isSendable:()=>true,archived:false,locked:false,permissionsFor:()=>({has:()=>true}),send:async()=>{posts++;return {id:'mock'};}};
  const client:any={isReady:()=>true,user:{id:bot},guilds:{cache:new Map([[guild,{}]])},channels:{fetch:async(id:string)=>{fetched=id;return channelObject;}}};
  const guard=resourceAccessGuard(client,config,id=>f.bridge.binding(id));await guard(config.principal,guildScope(guild));await guard(config.principal,record.caseId);
  const sender=new DiscordJsSender(client,config);assert.equal(await sender.send(record,'mock',()=>f.bridge.sameBinding(record)),'mock');assert.equal(fetched,thread);assert.equal(posts,1);
  for(const patch of [{guildId:other},{parentId:other},{id:other},{isThread:()=>false}]) {
    const original=channelObject;channelObject={...original,...patch};await assert.rejects(()=>guard(config.principal,record.caseId),/denied/);await assert.rejects(()=>sender.send(record,'mock',()=>{}),/unavailable/);channelObject=original;
  }
  channelObject.permissionsFor=()=>({has:()=>false});await assert.rejects(()=>guard(config.principal,record.caseId),/denied/);await assert.rejects(()=>sender.send(record,'mock',()=>{}),/denied/);assert.equal(posts,1);f.store.close();
});
test('normalizer handles accessible guild channels/threads and excludes DM/foreign-guild metadata',()=>{
  const m:any={...msg(),guildId:guild,partial:false,system:false,createdTimestamp:Date.now(),webhookId:null,author:{id:owner,bot:false},mentions:{users:{has:()=>false}},channel:{id:channel,guildId:guild,isThread:()=>false,isTextBased:()=>true}};
  assert.equal(normalize(m,bot)!.threadId,null);assert.equal(normalize({...m,guildId:null},bot),null);assert.equal(normalize({...m,channel:{...m.channel,guildId:other}},bot),null);
  const threaded={...m,channel:{...m.channel,id:thread,parentId:channel,isThread:()=>true}};assert.equal(normalize(threaded,bot)!.channelId,channel);assert.equal(normalize({...threaded,channel:{...threaded.channel,parentId:null}},bot),null);
});
test('auth-free in-process mock assembles real MCP Events and tools; never reports dot wake or Discord posting',async()=>{
  assert.deepEqual(await runMockDemo(),{mockOnly:true,auth:'none/in-process',eventsCapability:true,signedMockCallbacks:1,mockReplies:1,liveDiscordPosts:0,liveDotWake:false});
  const r=makeMockRuntime();const origin={...base,threadId:thread};r.allowMockOrigin(origin);await r.subscribe();assert.equal(r.receive(msg({...origin,channelId:other})),'excluded');assert.equal(r.receive(msg(origin)),'queued');await r.events.dispatchOne();
  const event=JSON.parse(r.received[0]!.body),s=Object.values(r.bridge.store.state.subscriptions)[0]!;
  const reply=await r.rpc('tools/call',{name:'discord_reply',arguments:{subscription_id:s.id,event_id:event.eventId,content:'mock',channel_id:other}});assert.ok(reply.result.isError||reply.error);assert.equal(r.posted.length,0);r.close();
});
test('changing owner with the same guild/principal/store revokes old-owner backlog/read/send',async()=>{
  const f=fixture();const s=await f.subscribe();f.bridge.ingest(msg());await f.e.dispatchOne();f.bridge.ingest(msg({id:'100000000000000012'}));
  const changed=configSchema.parse({...config,ownerUserId:other});let sends=0;let callbacks=0;
  const b=new Bridge(changed,f.store,{send:async()=>{sends++;return 'never';}});const e=new EventsAdapter(b,{post:async(_u,_b,_h,guard)=>{guard();callbacks++;return {status:202,body:''};}},['mock.example.test'],async()=>{});
  assert.throws(()=>b.read(changed.principal,s.id,'discord_'+msg().id),/source_revoked/);await assert.rejects(()=>b.reply(changed.principal,s.id,'discord_'+msg().id,'never'),/source_revoked/);assert.equal(await e.dispatchOne(),'idle');assert.equal(callbacks,0);assert.equal(sends,0);
  assert.equal(b.ingest(msg({id:'100000000000000013'})),'excluded');assert.equal(b.ingest(msg({id:'100000000000000014',authorId:other})),'queued');f.store.close();
});
