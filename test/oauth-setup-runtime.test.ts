import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { OAuthSetupRuntime } from '../src/oauth-setup.js';
import { oauthPolicy, oauthJwt } from './oauth-fixture.js';

async function local(port:number,path:string,method='GET',headers:Record<string,string|string[]>={},body?:string) {
  return new Promise<{status:number;body:string;headers:Record<string,unknown>}>((resolve,reject)=>{
    const raw=Object.entries({Host:'127.0.0.1:'+port,...headers}).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).flatMap(v=>[key,v]));
    const req=request({host:'127.0.0.1',port,path,method,headers:raw,agent:false},res=>{let body='';res.setEncoding('utf8');res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));});req.on('error',reject);req.end(body);
  });
}
test('explicit setup listener serves only metadata at literal loopback; no unauthenticated or authenticated MCP/Events access',async()=>{
  const {issuer,jwksUrl,resource,audience,requiredScopes}=oauthPolicy;
  const runtime=new OAuthSetupRuntime({version:1,mode:'oauth_setup',enabled:true,oauth:{issuer,jwksUrl,resource,audience,requiredScopes},http:{kind:'tunnel_loopback',port:43124}});const port=await runtime.start(true);
  try {
    for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])assert.equal((await local(port,path)).status,200);
    for(const authorization of [undefined,'Bearer '+oauthJwt()])for(const method of ['server/discover','tools/call','events/subscribe']) {
      const response=await local(port,'/mcp','POST',{...(authorization?{Authorization:authorization}:{}),'Content-Type':'application/json'},JSON.stringify({jsonrpc:'2.0',id:1,method,params:{secret:'mock-secret'}}));assert.equal(response.status,401);assert.equal(response.body,'');assert.match(String(response.headers['www-authenticate']),/oauth-protected-resource/);
    }
    const path='/.well-known/oauth-protected-resource/mcp';
    for(const headers of [{Host:'mcp.example.test'},{Host:['127.0.0.1:'+port,'127.0.0.1:'+port]},{Origin:'https://mcp.example.test'}] as Record<string,string|string[]>[])assert.equal((await local(port,path,'GET',headers)).status,403);
    for(const path of ['/mcp?access_token=mock','/.well-known/openid-configuration','/setup','/events'])assert.equal((await local(port,path)).status,404);
    assert.equal((await local(port,path,'GET',{'Content-Length':'0'})).status,400);
  } finally {assert.equal((await runtime.stop()).clean,true);}
});
