import { EventEmitter } from 'node:events';
import { mkdtempSync,mkdirSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { Webhook } from 'standardwebhooks';
import { LoginBootstrap } from '../src/bootstrap.js';
import { BridgeRuntime } from '../src/runtime.js';
import { policy,jwks,jwt } from './fake-issuer.js';

export const owner='100000000000000001',bot='100000000000000002',guild='100000000000000003',channel='100000000000000004',thread='100000000000000005';
export const dummyToken='mock-token-not-a-discord-credential-0123456789';
export const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),callbackUrl='https://callback.example.test/events';
export const subscribe={name:'discord.message.created',arguments:{guild_id:guild},delivery:{mode:'webhook',url:callbackUrl,secret}};
export function folders() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-bootstrap-'))),privateDirectory=join(root,'state'),ownershipDirectory=join(root,'ownership');mkdirSync(privateDirectory,{mode:0o700});mkdirSync(ownershipDirectory,{mode:0o700});
  return {root,privateDirectory,ownershipDirectory,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
export function settings(paths:{privateDirectory:string;ownershipDirectory:string}) {
  return {version:2,enabled:true,confirmations:{exclusiveBotOwnership:true,ownerIdentity:true,messageContentIntent:true},bridge:{mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:policy.principal,cases:[]},authentication:{kind:'cloudflare_access',policy:{...policy,jwksTimeoutMs:100}},credential:{kind:'private_file'},privateDirectory:paths.privateDirectory,ownershipDirectory:paths.ownershipDirectory,http:{kind:'forwarded_https',host:'bridge.example.test',port:43123},callbackHosts:['callback.example.test'],loginTimeoutMs:100,drainTimeoutMs:20};
}
export function fixture(options:{login?:()=>Promise<void>;destroy?:()=>Promise<void>;token?:()=>Promise<string>;raw?:unknown;paths?:ReturnType<typeof folders>;callbackStatus?:number;identity?:string;botFlag?:boolean;visibleGuild?:boolean;readyOnLogin?:boolean;startGate?:Promise<void>}={}) {
  const paths=options.paths??folders(),raw=options.raw??settings({privateDirectory:paths.privateDirectory,ownershipDirectory:paths.ownershipDirectory});
  const client:any=new EventEmitter();let ready=false,clients=0,reads=0,logins=0,destroys=0;const posts:any[]=[];const callbacks:any[]=[];
  const destination:any={id:thread,guildId:guild,parentId:channel,archived:false,locked:false,isThread:()=>true,isTextBased:()=>true,isSendable:()=>true,permissionsFor:()=>({has:()=>true}),send:async(p:any)=>{posts.push(p);return {id:'mock-reply'};}};
  client.isReady=()=>ready;client.guilds={cache:new Map()};client.channels={fetch:async()=>destination};
  client.login=async(token:string)=>{logins++;assertDummy(token);await options.login?.();ready=options.readyOnLogin!==false;client.user={id:options.identity??bot,bot:options.botFlag??true};if(options.visibleGuild!==false)client.guilds.cache.set(guild,{});return token;};
  client.destroy=async()=>{destroys++;await options.destroy?.();ready=false;client.token=null;};
  const create=()=>new LoginBootstrap(raw,{createClient:()=>{clients++;return client;},readToken:async()=>{reads++;return options.token?options.token():dummyToken;},jwks:{load:async()=>jwks()},createRuntime:opts=>{const runtime=new BridgeRuntime({...opts,port:0,pollMs:5});if(options.startGate){const start=runtime.start.bind(runtime);runtime.start=async()=>{await options.startGate;return start();};}return runtime;},callback:{post:async(_url,body,headers,guard)=>{guard();new Webhook(secret).verify(body,headers);const value=JSON.parse(body);if(value.type==='verification')return {status:200,body:JSON.stringify({challenge:value.challenge})};callbacks.push(value);return {status:options.callbackStatus??202,body:''};}}});
  const emit=()=>client.emit('messageCreate',{id:'100000000000000011',guildId:guild,partial:false,system:false,author:{id:owner,bot:false},webhookId:null,content:'mock owner input',createdTimestamp:Date.now(),mentions:{users:{has:()=>false}},channel:destination});
  return {paths,raw,create,client,posts,callbacks,emit,setReady:(value:boolean)=>ready=value,clients:()=>clients,reads:()=>reads,logins:()=>logins,destroys:()=>destroys};
}
function assertDummy(token:string) {if(token!==dummyToken)throw new Error('unexpected_test_token');}
export async function until(test:()=>boolean,timeout=1000) {const end=Date.now()+timeout;while(!test()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));if(!test())throw new Error('mock_operation_timeout');}
let sequence=0;
export async function rpc(port:number,method:string,params:Record<string,unknown>={},assertion=jwt()) {
  const body=JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'bootstrap-mock',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}});
  return new Promise<{status:number;value:any}>((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{Host:'bridge.example.test','Cf-Access-Jwt-Assertion':assertion,'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),Accept:'application/json, text/event-stream'}},res=>{let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode!,value:text?JSON.parse(text):null}));});req.on('error',reject);req.end(body);
  });
}
