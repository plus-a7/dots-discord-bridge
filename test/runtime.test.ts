import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { AccessJwtAuthenticator } from '../src/auth.js';
import { BridgeRuntime, DeliveryWorker } from '../src/runtime.js';
import { Store, configSchema, type DiscordSender } from '../src/core.js';
import { gatewayAdapter, DiscordJsSender, resourceAccessGuard } from '../src/discord.js';
import { PinnedHttps } from '../src/callback.js';
import { EventsAdapter, eventName } from '../src/events.js';
import { policy, jwks, jwt } from './fake-issuer.js';
import { LoopbackHttp } from '../src/http.js';

const owner='100000000000000001',bot='100000000000000002',guild='100000000000000003',channel='100000000000000004',thread='100000000000000005';
const config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:policy.principal});
const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),url='https://callback.example.test/events';
const subscription={name:eventName,arguments:{guild_id:guild},delivery:{mode:'webhook',url,secret}};
async function until(predicate:()=>boolean,timeout=1000) {const expires=Date.now()+timeout;while(!predicate()&&Date.now()<expires)await new Promise(r=>setTimeout(r,5));assert.equal(predicate(),true,'mock operation did not settle');}
function fixture(options:{sender?:DiscordSender;load?:()=>Promise<string>;requestTimeoutMs?:number;statePath?:string;externalHost?:string}={}) {
  const client:any=new EventEmitter();let ready=true,destroys=0,accessCalls=0,accessCompleted=0;const posted:any[]=[];let releaseFetch:Promise<void>|undefined,releaseAccess:Promise<void>|undefined;
  const destination:any={id:thread,guildId:guild,parentId:channel,archived:false,locked:false,isThread:()=>true,isTextBased:()=>true,isSendable:()=>true,permissionsFor:()=>({has:()=>true}),send:async(payload:any)=>{posted.push(payload);return {id:'mock-discord-reply'};}};
  client.user={id:bot};client.isReady=()=>ready;client.guilds={cache:new Map([[guild,{}]])};client.channels={fetch:async()=>{if(releaseFetch)await releaseFetch;return destination;}};client.destroy=async()=>{destroys++;ready=false;};
  const auth=new AccessJwtAuthenticator(policy,{load:options.load??(async()=>jwks())});
  const received:{body:string;headers:Record<string,string>}[]=[];
  let challenges=0;
  let runtime!:BridgeRuntime;
  const access=resourceAccessGuard(client,config,id=>runtime.bridge.binding(id));
  runtime=new BridgeRuntime({config,statePath:options.statePath??':memory:',gateway:gatewayAdapter(client),sender:options.sender??new DiscordJsSender(client,config),auth,externalHost:options.externalHost??'bridge.example.test',pollMs:5,requestTimeoutMs:options.requestTimeoutMs,
    resourceAccess:async(principal,id)=>{accessCalls++;if(releaseAccess)await releaseAccess;await access(principal,id);accessCompleted++;},callbackHosts:['callback.example.test'],callback:{post:async(_u,body,headers,guard)=>{guard();new Webhook(secret).verify(body,headers);const data=JSON.parse(body);if(data.type==='verification'){challenges++;return {status:200,body:JSON.stringify({challenge:data.challenge})};}received.push({body,headers});return {status:202,body:''};}}});
  const emit=(id='100000000000000011',content='mock owner input')=>client.emit('messageCreate',{id,guildId:guild,partial:false,system:false,author:{id:owner,bot:false},webhookId:null,content,createdTimestamp:Date.now(),mentions:{users:{has:()=>false}},channel:destination});
  return {runtime,client,auth,posted,received,emit,setReady:(value:boolean)=>ready=value,setFetchGate:(gate?:Promise<void>)=>releaseFetch=gate,setAccessGate:(gate?:Promise<void>)=>releaseAccess=gate,accessCalls:()=>accessCalls,accessCompleted:()=>accessCompleted,challenges:()=>challenges,destroys:()=>destroys};
}
async function post(port:number,body:string,extra:Record<string,string|string[]>={},path='/mcp',signal?:AbortSignal) {
  return new Promise<{status:number;text:string}>((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path,method:'POST',signal,headers:{Host:'bridge.example.test','Cf-Access-Jwt-Assertion':jwt(),'content-type':'application/json',...extra}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,text}));});req.on('error',reject);req.end(body);
  });
}
let requestId=0;
function envelope(method:string,params:Record<string,unknown>={}) {return JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'offline-integration',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}});}
function rpcHeaders(method:string,params:Record<string,unknown>={}) {return {'MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),accept:'application/json, text/event-stream'};}
async function rpc(port:number,method:string,params:Record<string,unknown>={}) {
  const result=await post(port,envelope(method,params),rpcHeaders(method,params));
  assert.equal(result.status,200,result.text);return JSON.parse(result.text);
}

test('actual loopback lifecycle: fake Access issuer -> SDK -> signed callback -> read/reply -> same mock thread; clean drain',async()=>{
  const f=fixture();const started=f.runtime.start();assert.equal(f.runtime.start(),started);const port=await started;
  try {
    assert.ok((await rpc(port,'server/discover')).result.capabilities.events);assert.equal((await rpc(port,'events/list')).result.events[0].name,eventName);
    const sub=await rpc(port,'events/subscribe',subscription);assert.equal(sub.error,undefined);f.emit();f.emit();await until(()=>f.received.length===1);
    const event=JSON.parse(f.received[0]!.body),binding={subscription_id:sub.result.id,event_id:event.eventId};
    const read=await rpc(port,'tools/call',{name:'discord_read',arguments:binding});assert.equal(read.result.isError,undefined);
    for(let i=0;i<2;i++) {const reply=await rpc(port,'tools/call',{name:'discord_reply',arguments:{...binding,content:'@everyone mock response'}});assert.equal(reply.result.isError,undefined);}
    assert.equal(f.posted.length,1);assert.deepEqual(f.posted[0].allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});assert.equal(f.posted[0].enforceNonce,true);
    assert.equal(Object.keys(f.runtime.store.state.messages).length,1);await rpc(port,'events/unsubscribe',{...subscription,delivery:{mode:'webhook',url}});
  } finally {assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});}
  assert.equal(f.client.listenerCount('messageCreate'),0);assert.equal(f.destroys(),1);assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});await assert.rejects(()=>f.runtime.start(),/already_started/);
});

test('request timeout during subscription ACL creates no callback or persisted subscription while runtime stays running',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const f=fixture({requestTimeoutMs:100});const port=await f.runtime.start();f.setAccessGate(gate);
  try {
    const response=post(port,envelope('events/subscribe',subscription),rpcHeaders('events/subscribe'));
    await until(()=>f.accessCalls()>0);assert.equal((await response).status,504);assert.equal(f.runtime.events.isBusy(),true);
    release();await until(()=>f.accessCompleted()===1&&!f.runtime.events.isBusy());assert.equal(f.challenges(),0);assert.equal(Object.keys(f.runtime.store.state.subscriptions).length,0);
    f.setAccessGate();assert.ok((await rpc(port,'events/subscribe',subscription)).result.id);
  } finally {release();await f.runtime.stop();}
});

test('client disconnect during reply ACL cannot reserve or post a late reply',async()=>{
  const f=fixture();const port=await f.runtime.start();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  try {
    const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);f.runtime.worker.stop();const before=f.accessCalls(),completed=f.accessCompleted();f.setAccessGate(gate);
    const params={name:'discord_reply',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId,content:'cancelled'}};
    const controller=new AbortController();const response=post(port,envelope('tools/call',params),rpcHeaders('tools/call',params),'/mcp',controller.signal).catch(()=>undefined);
    await until(()=>f.accessCalls()>before);controller.abort();await response;await new Promise(r=>setTimeout(r,20));release();await until(()=>f.accessCompleted()>completed&&f.runtime.http.pending===0);
    assert.equal(f.posted.length,0);assert.equal(Object.keys(f.runtime.store.state.replies).length,0);
  } finally {release();await f.runtime.stop();}
});

test('HTTP timeout after reply reservation blocks sender submission and retains uncertain idempotent result',async()=>{
  let release!:()=>void,entered=false,posts=0;const gate=new Promise<void>(r=>release=r);
  const f=fixture({requestTimeoutMs:100,sender:{send:async(_m,_c,guard)=>{entered=true;await gate;guard();posts++;return 'forbidden-late-post';}}});const port=await f.runtime.start();
  try {
    const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);
    const params={name:'discord_reply',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId,content:'cancelled'}};
    const response=post(port,envelope('tools/call',params),rpcHeaders('tools/call',params));await until(()=>entered);assert.equal((await response).status,504);
    release();await until(()=>f.runtime.http.pending===0&&!f.runtime.bridge.busy);assert.equal(posts,0);assert.equal(Object.values(f.runtime.store.state.replies)[0]!.status,'uncertain');
    assert.equal(JSON.parse((await rpc(port,'tools/call',params)).result.content[0].text).status,'uncertain');assert.equal(posts,0);
  } finally {release();await f.runtime.stop();}
});

test('shutdown tracks late tool ACL handler after SDK fetch has already settled on disconnect',async()=>{
  const f=fixture();const port=await f.runtime.start();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  try {
    const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);f.runtime.worker.stop();const before=f.accessCalls();f.setAccessGate(gate);
    const params={name:'discord_read',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId}};
    const controller=new AbortController();const response=post(port,envelope('tools/call',params),rpcHeaders('tools/call',params),'/mcp',controller.signal).catch(()=>undefined);
    await until(()=>f.accessCalls()>before);controller.abort();await response;await until(()=>f.runtime.http.pending===0);
    assert.deepEqual(await f.runtime.stop(20),{clean:false,pending:true});assert.doesNotThrow(()=>f.runtime.store.save());
    release();assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});assert.equal(f.posted.length,0);
  } finally {release();await f.runtime.stop();}
});

test('HTTP response streaming enforces byte/chunk caps and timeout even when stream cancellation never settles',async()=>{
  for(const mode of ['bytes','chunks','stall']) {
    let reads=0;const stream=new ReadableStream<Uint8Array>({pull(controller){reads++;if(mode==='bytes')controller.enqueue(new Uint8Array(262145));else if(mode==='chunks')controller.enqueue(new Uint8Array(1));},cancel:()=>new Promise(()=>{})});
    const http=new LoopbackHttp(async()=>new Response(stream),'bridge.example.test',{timeoutMs:50});const port=await http.start();
    try {assert.equal((await post(port,'{}')).status,mode==='stall'?504:500);await until(()=>http.pending===0);assert.ok(reads<=131);}
    finally {http.stopAccepting();http.forceClose();await until(()=>http.drained);}
  }
});

test('canceled MCP handlers retain a bounded slot until delayed ACL settles; ninth request cannot start more work',async()=>{
  const f=fixture();const port=await f.runtime.start();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  try {
    const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);f.runtime.worker.stop();const before=f.accessCalls(),completed=f.accessCompleted();f.setAccessGate(gate);
    const params={name:'discord_read',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId}};
    for(let i=0;i<8;i++) {
      const controller=new AbortController();const response=post(port,envelope('tools/call',params),rpcHeaders('tools/call',params),'/mcp',controller.signal).catch(()=>undefined);
      await until(()=>f.accessCalls()===before+i+1);controller.abort();await response;await until(()=>f.runtime.http.pending===0);
    }
    assert.equal((await rpc(port,'tools/call',params)).result.isError,true);assert.equal(f.accessCalls(),before+8);
    release();await until(()=>f.accessCompleted()===completed+8);f.setAccessGate();assert.equal((await rpc(port,'tools/call',params)).result.isError,undefined);
    assert.equal(f.posted.length,0);
  } finally {release();await f.runtime.stop();}
});

test('HTTP rejects bad assertion, duplicate assertion, wrong host/path, forwarded host and oversized authenticated input',async()=>{
  const f=fixture();const port=await f.runtime.start();try {
    assert.equal((await post(port,'{}',{'Cf-Access-Jwt-Assertion':''})).status,401);
    assert.equal((await post(port,'{}',{'Cf-Access-Jwt-Assertion':[jwt(),jwt()]})).status,403);
    assert.equal((await post(port,'{}',{Host:'attacker.test','X-Forwarded-Host':'bridge.example.test'})).status,403);
    assert.equal((await post(port,'{}',{},'https://attacker.test/mcp')).status,404);
    assert.equal((await post(port,'{}',{},'/mcp?route=other')).status,404);
    assert.equal((await post(port,'x'.repeat(65537))).status,413);assert.equal(f.posted.length,0);
  } finally {await f.runtime.stop();}
});

test('worker pauses while disconnected, resumes pending queue, and does not persist owner stop during shutdown',async()=>{
  const f=fixture();const port=await f.runtime.start();try {
    await rpc(port,'events/subscribe',subscription);f.setReady(false);
    // The real Gateway wrapper rejects disconnected ingestion. Persist a pending
    // received record while ready, then disconnect before the next worker tick.
    f.setReady(true);f.emit();f.setReady(false);await new Promise(r=>setTimeout(r,25));assert.equal(f.received.length,0);assert.equal(Object.values(f.runtime.store.state.deliveries)[0]!.attempts,0);
    f.setReady(true);await until(()=>f.received.length===1);assert.equal(f.runtime.store.state.guildStopped,false);
  } finally {await f.runtime.stop();}
});

test('stop during channel preparation blocks reply and closes Store only after surviving handler settles',async()=>{
  const f=fixture();const port=await f.runtime.start();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);f.setFetchGate(gate);
  const reply=rpc(port,'tools/call',{name:'discord_reply',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId,content:'blocked'}}).catch(()=>undefined);
  await until(()=>f.runtime.http.pending>0);const stopped=await f.runtime.stop(20);assert.deepEqual(stopped,{clean:false,pending:true});assert.equal(f.posted.length,0);
  assert.doesNotThrow(()=>f.runtime.store.save()); // Drain timeout must leave Store usable.
  release();await reply;await until(()=>f.runtime.http.pending===0);assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});assert.equal(f.posted.length,0);
});

test('never-settling sender reports uncertain and retains Store/concurrency gate until sender settles',async()=>{
  let release!:(id:string)=>void;const gate=new Promise<string>(r=>release=r);const f=fixture({sender:{send:async()=>gate}});f.runtime.bridge.config.replyTimeoutMs=50;
  const port=await f.runtime.start();const sub=await rpc(port,'events/subscribe',subscription);f.emit();await until(()=>f.received.length===1);
  const reply=await rpc(port,'tools/call',{name:'discord_reply',arguments:{subscription_id:sub.result.id,event_id:JSON.parse(f.received[0]!.body).eventId,content:'mock'}});
  assert.equal(JSON.parse(reply.result.content[0].text).status,'uncertain');assert.equal(f.runtime.bridge.busy,true);
  assert.deepEqual(await f.runtime.stop(20),{clean:false,pending:true});assert.doesNotThrow(()=>f.runtime.store.save());release('late-mock');await until(()=>!f.runtime.bridge.busy);assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});
});

test('stop aborts delayed fake JWKS before any subscription/SDK side effect',async()=>{
  let release!:(keys:string)=>void,entered!:()=>void;const gate=new Promise<string>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  const f=fixture({load:async()=>{entered();return gate;}});const port=await f.runtime.start();const response=post(port,'{}').catch(()=>undefined);await ready;
  assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});release(jwks());const result=await response;assert.ok(!result||result.status!==200);assert.equal(f.received.length,0);assert.equal(f.posted.length,0);
});

test('lifecycle pause during actual callback DNS preserves pending delivery without consuming network attempt',async()=>{
  const f=fixture();const port=await f.runtime.start();await rpc(port,'events/subscribe',subscription);f.runtime.worker.stop();f.emit();
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let connects=0;
  const pinned=new PinnedHttps(['callback.example.test'],async()=>{entered();await gate;return [{address:'8.8.8.8',family:4}];},(()=>{connects++;throw new Error('never connect');}) as any);
  const events=new EventsAdapter(f.runtime.bridge,pinned,['callback.example.test'],async()=>{});const pending=events.dispatchOne();await ready;
  // A separately injected adapter cannot be drained by runtime. Its Store work
  // remains tracked here explicitly; release preparation before closing Store.
  f.setReady(false);release();assert.equal(await pending,'deferred');const d=Object.values(f.runtime.store.state.deliveries)[0]!;assert.equal(d.attempts,0);assert.equal(d.status,'pending');assert.equal(connects,0);assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});
});

test('start cancellation is drained, constructor failure releases Store, and worker cannot restart stale generation',async()=>{
  const f=fixture();const starting=f.runtime.start();const rejection=assert.rejects(()=>starting,/start_failed/);assert.deepEqual(await f.runtime.stop(),{clean:true,pending:false});await rejection;
  const worker=new DeliveryWorker({dispatchOne:async()=>{}} as any,()=>true,5);worker.start();worker.stop();assert.throws(()=>worker.start(),/already_started/);
  assert.throws(()=>new BridgeRuntime({} as any));
  const directory=mkdtempSync(join(tmpdir(),'bridge-runtime-config-'));const path=join(directory,'state.sqlite');
  try {
    assert.throws(()=>fixture({statePath:path,externalHost:'invalid.test/mcp'}),/runtime_configuration_failed/);
    const reopened=new Store(path);reopened.close(); // Partial setup released the real OS lock.
  } finally {rmSync(directory,{recursive:true,force:true});}
});
