// Entire assembly is in-process and mock-only. No sockets, credentials, Discord login,
// environment loading, background workers, model inference or real dot are involved.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Webhook } from 'standardwebhooks';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Bridge, Store, configSchema, guildScope, type Message, type Origin } from './core.js';
import { EventsAdapter, eventName } from './events.js';
import { makeMcpServer } from './mcp.js';

export function makeMockRuntime() {
  const config=configSchema.parse({mode:'guild_owner',guildId:'100000000000000003',ownerUserId:'100000000000000001',bridgeBotId:'100000000000000002',principal:'mock-owner-dot'});
  const store=new Store(':memory:');const origins=new Map<string,Origin>();
  const secret='whsec_'+randomBytes(32).toString('base64'); // Ephemeral mock signing key, never a real credential.
  const callback='https://mock-callback.example.test/events';
  const received:{body:string;headers:Record<string,string>}[]=[];const posted:{origin:Origin;content:string}[]=[];
  const validate=(m:Origin)=>{const o=origins.get(m.threadId??m.channelId);if(!o||JSON.stringify(o)!==JSON.stringify({guildId:m.guildId,channelId:m.channelId,threadId:m.threadId})) throw new Error('mock_origin_denied');};
  const bridge=new Bridge(config,store,{send:async(m,content,guard)=>{validate(m);guard();posted.push({origin:{guildId:m.guildId,channelId:m.channelId,threadId:m.threadId},content});return 'mock_reply_'+posted.length;}});
  const events=new EventsAdapter(bridge,{post:async(_u,body,headers,guard)=>{
    guard();
    new Webhook(secret).verify(body,headers);const data=JSON.parse(body);
    if(data.type==='verification') return {status:200,body:JSON.stringify({challenge:data.challenge})};
    received.push({body,headers});return {status:202,body:''};
  }},['mock-callback.example.test'],async(p,id)=>{bridge.authorize(p);if(id!==guildScope(config.guildId!)) validate(bridge.binding(id));});
  const handler=createMcpHandler(()=>makeMcpServer(bridge,events,config.principal),{legacy:'reject',onerror:()=>{}});
  let requestId=0;
  const rpc=async(method:string,params:Record<string,unknown>={})=>{
    const r=await handler.fetch(new Request('https://in-process.mock.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'in-process-mock',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})}));
    if(r.status!==200) throw new Error('mock_rpc_transport_failed');return JSON.parse(await r.text());
  };
  return {config,bridge,events,received,posted,rpc,
    allowMockOrigin:(o:Origin)=>origins.set(o.threadId??o.channelId,{...o}),
    receive:(m:Message)=>{try {validate(m);} catch {return 'excluded';}return bridge.ingest(m);},
    subscribe:()=>rpc('events/subscribe',{name:eventName,arguments:{guild_id:config.guildId},delivery:{mode:'webhook',url:callback,secret}}),
    close:()=>store.close()};
}
export async function runMockDemo() {
  const r=makeMockRuntime();try {
    const origin={guildId:r.config.guildId!,channelId:'100000000000000004',threadId:'100000000000000005'};
    r.allowMockOrigin(origin);const discover=await r.rpc('server/discover');const sub=await r.subscribe();
    if(sub.error||!discover.result.capabilities.events) throw new Error('mock_discovery_or_subscription_failed');
    const message:Message={...origin,id:'100000000000000011',authorId:r.config.ownerUserId,bot:false,webhook:false,mentionsBridge:false,content:'mock input',timestamp:Date.now()};
    if(r.receive(message)!=='queued'||await r.events.dispatchOne()!=='accepted') throw new Error('mock_event_failed');
    const event=JSON.parse(r.received[0]!.body);const binding={subscription_id:sub.result.id,event_id:event.eventId};
    const read=await r.rpc('tools/call',{name:'discord_read',arguments:binding});
    const reply=await r.rpc('tools/call',{name:'discord_reply',arguments:{...binding,content:'mock reply'}});
    if(read.error||read.result.isError||reply.error||reply.result.isError||r.posted.length!==1) throw new Error('mock_tools_failed');
    return {mockOnly:true,auth:'none/in-process',eventsCapability:true,signedMockCallbacks:r.received.length,mockReplies:r.posted.length,liveDiscordPosts:0,liveDotWake:false};
  } finally {r.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runMockDemo().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{process.stderr.write('mock_demo_failed\n');process.exitCode=1;});
}
