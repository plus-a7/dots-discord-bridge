import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fixture,folders,settings,subscribe,until,thread } from './bootstrap-fixture.js';
import { oauthPolicy,oauthJwt } from './oauth-fixture.js';

let sequence=0;
// A mock of documented HTTP forwarding, not the official tunnel-client or an
// OpenAI control plane. The only socket destination is literal 127.0.0.1.
async function local(port:number,path:string,method:string,headers:Record<string,string|string[]>={},body?:string) {
  return new Promise<{status:number;headers:Record<string,unknown>;text:string}>((resolve,reject)=>{
    const rawHeaders=Object.entries({Host:'127.0.0.1:'+port,...headers}).flatMap(([name,value])=>(Array.isArray(value)?value:[value]).flatMap(v=>[name,v]));
    const req=request({host:'127.0.0.1',port,path,method,headers:rawHeaders,agent:false},res=>{let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,text}));});req.on('error',reject);req.end(body);
  });
}
async function forward(port:number,method:string,params:Record<string,unknown>={},authorization:string|undefined='Bearer '+oauthJwt()) {
  const body=JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'mock-tunnel-http-forwarder',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}});
  const response=await local(port,'/mcp','POST',{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{}),Accept:'application/json, text/event-stream',...(authorization===undefined?{}:{Authorization:authorization})},body);
  return {...response,value:response.text?JSON.parse(response.text):null};
}
function setup(ingress:'tunnel_loopback'|'forwarded_https'='tunnel_loopback') {
  const paths=folders();const raw={...settings(paths),authentication:{kind:'oauth_resource_server',policy:oauthPolicy},http:ingress==='tunnel_loopback'?{kind:ingress,port:43123}:{kind:ingress,port:43123,host:'mcp.example.test'}};const f=fixture({paths,raw});return {f,boot:f.create()};
}
test('isolated mock Tunnel HTTP forwarding: OAuth metadata/challenge -> MCP2 Events -> signed mock callback -> read/reply in same mock thread',async()=>{
  const {f,boot}=setup();const port=await boot.start(true);
  try {
    const metadata=await local(port,'/.well-known/oauth-protected-resource/mcp','GET');assert.equal(metadata.status,200);assert.deepEqual(JSON.parse(metadata.text),{resource:oauthPolicy.resource,authorization_servers:[oauthPolicy.issuer],scopes_supported:oauthPolicy.requiredScopes,bearer_methods_supported:['header']});
    assert.equal((await local(port,'/.well-known/oauth-protected-resource','GET')).status,200);
    const absent=await local(port,'/mcp','POST',{'Content-Type':'application/json'},'{}');assert.equal(absent.status,401);assert.match(String(absent.headers['www-authenticate']),/resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/);assert.doesNotMatch(String(absent.headers['www-authenticate']),/error=/);
    const invalid=await forward(port,'server/discover',{},'Bearer oauth:opaque');assert.equal(invalid.status,401);assert.match(String(invalid.headers['www-authenticate']),/error="invalid_token"/);
    const discover=await forward(port,'server/discover');assert.equal(discover.status,200);assert.deepEqual(discover.value.result.supportedVersions,['2026-07-28']);assert.ok(discover.value.result.capabilities.events);
    assert.equal((await forward(port,'events/list')).value.result.events[0].name,subscribe.name);
    const sub=await forward(port,'events/subscribe',subscribe);assert.equal(sub.status,200);assert.ok(sub.value.result.id);f.emit();await until(()=>f.callbacks.length===1);boot.runtime!.worker.stop();f.emit();await boot.runtime!.events.dispatchOne();assert.equal(f.callbacks.length,1);
    const args={subscription_id:sub.value.result.id,event_id:f.callbacks[0].eventId};const read=await forward(port,'tools/call',{name:'discord_read',arguments:args});const saved=JSON.parse(read.value.result.content[0].text);assert.equal(saved.message.threadId,thread);assert.equal(saved.message.authorization,false);
    const reply={name:'discord_reply',arguments:{...args,content:'isolated mock reply'}};assert.equal(JSON.parse((await forward(port,'tools/call',reply)).value.result.content[0].text).status,'sent');await forward(port,'tools/call',reply);assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});assert.equal(f.posts[0].enforceNonce,true);
    const second=await forward(port,'events/subscribe',{...subscribe,delivery:{...subscribe.delivery,url:subscribe.delivery.url+'/other'}});assert.ok(second.value.error);assert.equal(Object.keys(boot.runtime!.store.state.subscriptions).length,1);
    const unsubscribe={...subscribe,delivery:{mode:'webhook',url:subscribe.delivery.url}};assert.equal((await forward(port,'events/unsubscribe',unsubscribe)).status,200);assert.equal(boot.runtime!.store.state.subscriptions[args.subscription_id]!.active,false);
    assert.equal(f.logins(),1);assert.equal(f.reads(),1); // Both are explicitly mocked.
  } finally {await boot.stop();f.paths.cleanup();}
});
test('loopback ingress rejects wrong/duplicate Host, query credential, Origin, metadata body and arbitrary GET paths',async()=>{
  const {f,boot}=setup();const port=await boot.start(true);
  try {
    const path='/.well-known/oauth-protected-resource/mcp';
    for(const headers of [{Host:'mcp.example.test'},{Host:'127.0.0.1:'+String(port+1)},{Host:['127.0.0.1:'+port,'127.0.0.1:'+port]},{Origin:'https://mcp.example.test'}] as Record<string,string|string[]>[])assert.equal((await local(port,path,'GET',headers)).status,403);
    for(const other of ['/mcp?access_token=mock','/.well-known/oauth-protected-resource/mcp?x=1','/.well-known/openid-configuration','/anything'])assert.equal((await local(port,other,'GET')).status,404);
    assert.equal((await local(port,path,'GET',{'Content-Length':'0'})).status,400);assert.equal((await local(port,path,'POST',{},'{}')).status,404);assert.equal(f.callbacks.length,0);assert.equal(f.posts.length,0);
  } finally {await boot.stop();f.paths.cleanup();}
});
test('standard OAuth also works behind a generic HTTPS forwarder using configured Host; loopback listener never accepts arbitrary hosts',async()=>{
  const {f,boot}=setup('forwarded_https');const port=await boot.start(true);
  try {
    const path='/.well-known/oauth-protected-resource/mcp';assert.equal((await local(port,path,'GET')).status,403);
    const metadata=await local(port,path,'GET',{Host:'mcp.example.test'});assert.equal(metadata.status,200);assert.equal(JSON.parse(metadata.text).resource,oauthPolicy.resource);
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'mock-https-forwarder',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}});
    const response=await local(port,'/mcp','POST',{Host:'mcp.example.test',Authorization:'Bearer '+oauthJwt(),'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'server/discover',Accept:'application/json, text/event-stream'},body);assert.equal(response.status,200);assert.ok(JSON.parse(response.text).result.capabilities.events);
  } finally {await boot.stop();f.paths.cleanup();}
});
