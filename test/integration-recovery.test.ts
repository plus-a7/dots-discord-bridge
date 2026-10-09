// Socket-free integration using the actual Gateway normalizer, SQLite Store,
// OAuth resource server, SDK Events/tools, ACL and Discord sender adapters.
// All sources, receivers and Discord resources are dummy-only. No login/LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { Webhook } from 'standardwebhooks';
import { Bridge, Store, configSchema } from '../src/core.js';
import { attachGateway, DiscordJsSender, resourceAccessGuard } from '../src/discord.js';
import { OAuthResourceAuthenticator } from '../src/oauth.js';
import { EventsAdapter } from '../src/events.js';
import { makeAuthenticatedEndpoint } from '../src/mcp.js';
import { oauthPolicy, oauthJwt } from './oauth-fixture.js';
import { jwks } from './fake-issuer.js';
import { folders, owner, bot, guild, channel, thread, secret, subscribe } from './bootstrap-fixture.js';

function context() {
  return {time:Date.now(),fetchStatus:0,view:true,send:true,loseReplyAck:false,callbackStatus:202,attempts:[] as string[],seen:new Set<string>(),posts:[] as {threadId:string;payload:any}[]};
}
function assembly(path:string,c:ReturnType<typeof context>,maxCaseMs=1800000) {
  const now=()=>c.time,store=new Store(path),client:any=new EventEmitter();
  const config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:oauthPolicy.principal,maxCaseMs});
  const destinations=new Map<string,any>();
  const destination=(id=thread)=>{
    if(!destinations.has(id))destinations.set(id,{id,guildId:guild,parentId:channel,archived:false,locked:false,isThread:()=>true,isTextBased:()=>true,isSendable:()=>true,
      permissionsFor:()=>({has:(requested:unknown)=>Array.isArray(requested)?c.view&&c.send:c.view}),
      send:async(payload:any)=>{c.posts.push({threadId:id,payload});if(c.loseReplyAck)throw new Error('mock acceptance then lost response');return {id:'mock-reply-'+c.posts.length};}});
    return destinations.get(id);
  };
  client.user={id:bot,bot:true};client.isReady=()=>true;client.guilds={cache:new Map([[guild,{}]])};
  client.channels={fetch:async(id:string)=>{if(c.fetchStatus)throw Object.assign(new Error('mock ACL failure'),{status:c.fetchStatus});return destination(id);}};
  const auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>jwks()},now);
  const bridge=new Bridge(config,store,new DiscordJsSender(client,config),now);
  const events=new EventsAdapter(bridge,{post:async(_url,body,headers,guard)=>{
    guard();new Webhook(secret).verify(body,headers);const event=JSON.parse(body);
    if(event.type==='verification')return {status:200,body:JSON.stringify({challenge:event.challenge})};
    c.attempts.push(event.eventId);c.seen.add(event.eventId);return {status:c.callbackStatus,body:''};
  }},['callback.example.test'],resourceAccessGuard(client,config,id=>bridge.binding(id)),g=>auth.assertGrant(g));
  const detach=attachGateway(client,bridge,()=>{}),endpoint=makeAuthenticatedEndpoint(bridge,events,auth,'local-mcp.invalid');let sequence=0;
  const emit=(id='100000000000000011',content='mock owner input',sourceThread=thread,authorId=owner)=>client.emit('messageCreate',{id,guildId:guild,partial:false,system:false,author:{id:authorId,bot:false},webhookId:null,content,createdTimestamp:now(),mentions:{users:{has:()=>false}},channel:destination(sourceThread)});
  const rpc=async(method:string,params:Record<string,unknown>={})=>{
    const response=await endpoint(new Request('https://local-mcp.invalid/mcp',{method:'POST',headers:{Authorization:'Bearer '+oauthJwt({jti:'mock-call-'+(++sequence)}, {},undefined,now()),'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:sequence,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'isolated-recovery',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
    assert.equal(response.status,200);return JSON.parse(await response.text());
  };
  const tool=(name:string,sid:string,eventId:string,content?:string)=>rpc('tools/call',{name,arguments:{subscription_id:sid,event_id:eventId,...(content===undefined?{}:{content})}});
  return {store,bridge,events,emit,rpc,tool,close:()=>{detach();auth.close();store.close();}};
}
const denied=(result:any)=>assert.ok(result.error||result.result?.isError);

test('integrated OAuth/Gateway/SQLite/SDK restart retries lost callback receipt with stable event ID and sends one bound reply',async()=>{
  const paths=folders(),path=join(paths.privateDirectory,'state.sqlite'),c=context();let f=assembly(path,c);
  try {
    assert.ok((await f.rpc('server/discover')).result.capabilities.events);
    const sid=(await f.rpc('events/subscribe',subscribe)).result.id;f.emit();f.emit();c.callbackStatus=503;assert.equal(await f.events.dispatchOne(),'pending');
    assert.equal(c.seen.size,1);assert.equal(c.attempts.length,1);assert.equal(Object.keys(f.store.state.messages).length,1);assert.equal(statSync(path).mode&0o777,0o600);
    f.close();c.time+=1001;c.callbackStatus=202;f=assembly(path,c);assert.equal(await f.events.dispatchOne(),'accepted');f.emit();assert.equal(await f.events.dispatchOne(),'idle');
    assert.equal(c.seen.size,1);assert.equal(c.attempts.length,2);assert.equal(c.attempts[0],c.attempts[1]);
    const eventId=c.attempts[1]!,read=await f.tool('discord_read',sid,eventId);assert.equal(read.result.isError,undefined);assert.equal(JSON.parse(read.result.content[0].text).message.authorization,false);
    for(let i=0;i<2;i++)assert.equal(JSON.parse((await f.tool('discord_reply',sid,eventId,'@everyone mock recovery reply')).result.content[0].text).status,'sent');
    assert.equal(c.posts.length,1);assert.equal(c.posts[0]!.threadId,thread);assert.deepEqual(c.posts[0]!.payload.allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});assert.equal(c.posts[0]!.payload.enforceNonce,true);
  } finally {f.close();paths.cleanup();}
});
test('integrated accepted-but-unacknowledged Discord reply remains uncertain across restart and cannot be resent by SDK retry',async()=>{
  const paths=folders(),c=context();let f=assembly(join(paths.privateDirectory,'state.sqlite'),c);
  try {
    const sid=(await f.rpc('events/subscribe',subscribe)).result.id;f.emit();await f.events.dispatchOne();c.loseReplyAck=true;const eventId=c.attempts[0]!;
    assert.equal(JSON.parse((await f.tool('discord_reply',sid,eventId,'mock ambiguous reply')).result.content[0].text).status,'uncertain');assert.equal(c.posts.length,1);
    f.close();f=assembly(join(paths.privateDirectory,'state.sqlite'),c);assert.equal(JSON.parse((await f.tool('discord_reply',sid,eventId,'mock ambiguous reply')).result.content[0].text).status,'uncertain');
    denied(await f.tool('discord_reply',sid,eventId,'different reply'));assert.equal(c.posts.length,1);
  } finally {f.close();paths.cleanup();}
});
test('integrated owner origin-stop and guild-stop survive restart; third-party stop grants no authority',async()=>{
  const paths=folders(),c=context();let f=assembly(join(paths.privateDirectory,'state.sqlite'),c);
  try {
    const sid=(await f.rpc('events/subscribe',subscribe)).result.id;f.emit();f.emit('100000000000000012','/bridge-stop-all',thread,'100000000000000099');assert.equal(f.store.state.guildStopped,false);
    f.emit('100000000000000013','/bridge-stop');await f.events.dispatchOne();assert.equal(c.attempts.length,0);
    const other='100000000000000015';f.emit('100000000000000016','mock second case',other);await f.events.dispatchOne();assert.equal(c.attempts.length,1);
    assert.equal(JSON.parse((await f.tool('discord_reply',sid,c.attempts[0]!,'mock second reply')).result.content[0].text).status,'sent');assert.equal(c.posts[0]!.threadId,other);
    f.emit('100000000000000017','/bridge-stop-all',other);f.close();f=assembly(join(paths.privateDirectory,'state.sqlite'),c);
    assert.equal(f.store.state.guildStopped,true);f.emit('100000000000000018','must not queue',other);assert.equal(Object.keys(f.store.state.messages).length,2);assert.equal(await f.events.dispatchOne(),'idle');denied(await f.tool('discord_read',sid,c.attempts[0]!));
    assert.equal(c.posts.length,1);assert.equal(c.attempts.length,1);
  } finally {f.close();paths.cleanup();}
});
test('integrated subscription, case and authorization expiry deny delivery/read/reply even with a current request token',async()=>{
  for(const mode of ['subscription','case','authorization'] as const) {
    const paths=folders(),c=context(),f=assembly(join(paths.privateDirectory,'state.sqlite'),c,mode==='case'?1000:1800000);
    try {
      const sid=(await f.rpc('events/subscribe',{...subscribe,...(mode==='subscription'?{ttlMs:10}:{})})).result.id;f.emit();c.time+=mode==='subscription'?11:mode==='case'?1001:61000;
      assert.equal(await f.events.dispatchOne(),'idle');assert.equal(c.attempts.length,0);assert.equal(Object.values(f.store.state.deliveries)[0]!.status,'dead');
      for(const name of ['discord_read','discord_reply'])denied(await f.tool(name,sid,'discord_100000000000000011',name==='discord_reply'?'expired mock':undefined));assert.equal(c.posts.length,0);
    } finally {f.close();paths.cleanup();}
  }
});
test('integrated ACL errors distinguish transient retry from forbidden resources and reject lost send permission without a post',async()=>{
  for(const status of [500,403,404,0]) {
    const paths=folders(),c=context(),f=assembly(join(paths.privateDirectory,'state.sqlite'),c);
    try {
      const sid=(await f.rpc('events/subscribe',subscribe)).result.id;f.emit();c.fetchStatus=status;
      if(status===500) {assert.equal(await f.events.dispatchOne(),'deferred');assert.equal(Object.values(f.store.state.deliveries)[0]!.attempts,0);c.fetchStatus=0;c.time+=1001;assert.equal(await f.events.dispatchOne(),'accepted');}
      else if(status) {assert.equal(await f.events.dispatchOne(),'idle');assert.equal(Object.values(f.store.state.deliveries)[0]!.status,'dead');assert.equal(c.attempts.length,0);denied(await f.tool('discord_read',sid,'discord_100000000000000011'));}
      else {await f.events.dispatchOne();c.view=false;denied(await f.tool('discord_read',sid,c.attempts[0]!));c.view=true;c.send=false;assert.equal(JSON.parse((await f.tool('discord_reply',sid,c.attempts[0]!,'mock forbidden send')).result.content[0].text).status,'uncertain');}
      assert.equal(c.posts.length,0);
    } finally {f.close();paths.cleanup();}
  }
});
