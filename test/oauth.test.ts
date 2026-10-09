import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Webhook } from 'standardwebhooks';
import { OAuthResourceAuthenticator,oauthPolicySchema } from '../src/oauth.js';
import { createAuthenticator } from '../src/auth-factory.js';
import { AuthorizationRevoked } from '../src/auth.js';
import { Bridge,Store,configSchema,type Message } from '../src/core.js';
import { EventsAdapter } from '../src/events.js';
import { PinnedHttps } from '../src/callback.js';
import { makeAuthenticatedEndpoint } from '../src/mcp.js';
import { parseDeployment } from '../src/deployment.js';
import { oauthPolicy,oauthJwt,oauthRequest } from './oauth-fixture.js';
import { jwks,jwt,rotated } from './fake-issuer.js';
import { settings,folders,owner,bot,guild,channel,thread,subscribe,secret } from './bootstrap-fixture.js';

test('explicit factory supports owner JWT access tokens without Cloudflare; independent per-request grants contain no bearer',async()=>{
  let loads=0;const auth=createAuthenticator({kind:'oauth_resource_server',policy:oauthPolicy},{load:async()=>{loads++;return jwks();}});
  const requests=[oauthRequest(),oauthRequest(oauthJwt({jti:'second',exp:Math.floor(Date.now()/1000)+30}))];
  assert.deepEqual(await Promise.all(requests.map(r=>auth.authenticate(r))),['mock-owner','mock-owner']);assert.equal(loads,1);
  const grants=requests.map(r=>auth.grantFor!(r));assert.notEqual(grants[0]!.tokenDigest,grants[1]!.tokenDigest);assert.notEqual(grants[0]!.expiresAt,grants[1]!.expiresAt);assert.equal(Object.keys(grants[0]!).sort().join(','),'expiresAt,policyId,subject,tokenDigest');
  assert.throws(()=>auth.grantFor!(oauthRequest()),AuthorizationRevoked);auth.close!();assert.throws(()=>auth.assertGrant!(grants[0]),AuthorizationRevoked);
});
for(const [name,claims] of Object.entries({issuer:{iss:'https://attacker.example.test/realm'},audience:{aud:'https://other.example.test/mcp'},subject:{sub:'third-party'},expired:{exp:0},futureNbf:{nbf:Math.floor(Date.now()/1000)+1000},futureIat:{iat:Math.floor(Date.now()/1000)+1000},noExpiry:{exp:null},noIssuedAt:{iat:undefined},noClient:{client_id:undefined},noJti:{jti:undefined},noScope:{scope:undefined},missingScope:{scope:'discord:read'},foldedScope:{scope:'discord:read,discord:reply,discord:events'},duplicateScope:{scope:oauthPolicy.requiredScopes.join(' ')+' discord:read'},arrayScope:{scope:oauthPolicy.requiredScopes},badAudience:{aud:[1]}}))test(`OAuth access token rejects ${name}`,async()=>{
  const auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>jwks()});await assert.rejects(()=>auth.authenticate(oauthRequest(oauthJwt(claims))),{message:'authentication_failed'});auth.close();
});
test('OAuth denies ID/Cloudflare/opaque tokens and malformed Bearer; never falls back to assertion or selects JWT key URLs',async()=>{
  let loads=0;const auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>{loads++;return jwks();}});
  for(const h of [{typ:'JWT'},{typ:undefined},{alg:'none'},{alg:'HS256'},{jku:'https://127.0.0.1/keys'},{x5u:'https://attacker.test/a'},{crit:['b64']},{jwk:{}}])await assert.rejects(()=>auth.authenticate(oauthRequest(oauthJwt({},h))),/authentication_failed/);
  for(const value of ['',jwt(),'oauth:opaque-mock','Bearer '+oauthJwt()+', Bearer '+oauthJwt(),'Bearer  '+oauthJwt(),'Basic '+oauthJwt()])await assert.rejects(()=>auth.authenticate(new Request('https://local-mcp.invalid/mcp',{headers:{authorization:value,'Cf-Access-Jwt-Assertion':jwt()}})),/authentication_failed/);
  assert.equal(loads,0);await assert.rejects(()=>auth.authenticate(oauthRequest(oauthJwt({}, {},rotated.privateKey))),/authentication_failed/);assert.equal(loads,1);auth.close();
});
test('fixed OAuth config is mandatory, accepts path issuers, rejects URL selectors, wrong audience and no-auth factory',()=>{
  for(const patch of [{issuer:'http://issuer.test'},{jwksUrl:'https://127.0.0.1/keys'},{jwksUrl:'https://user@issuer.test/keys'},{resource:'https://mcp.test/mcp?access_token=x'},{resource:'https://mcp.test/mcp#fragment'},{audience:'other'},{ownerSubject:''},{requiredScopes:[]},{requiredScopes:['scope"injection']},{requiredScopes:['x','x']}])assert.throws(()=>oauthPolicySchema.parse({...oauthPolicy,...patch}));
  for(const config of [{kind:'none'},{kind:'oauth_resource_server'},{kind:'oauth_resource_server',policy:{...oauthPolicy,jwksUrl:undefined}}])assert.throws(()=>createAuthenticator(config as any,{load:async()=>jwks()}));
  const paths=folders();try {const previous=settings(paths);const valid={...previous,authentication:{kind:'oauth_resource_server',policy:oauthPolicy},http:{kind:'tunnel_loopback',port:43123}};assert.equal(parseDeployment(valid).authentication.kind,'oauth_resource_server');for(const raw of [{...valid,authentication:undefined},{...valid,http:{...valid.http,host:'attacker.test'}},{...previous,version:1},{...previous,authentication:undefined,access:previous.authentication.policy}])assert.throws(()=>parseDeployment(raw));}finally{paths.cleanup();}
});
test('grants expire without skew extension, reject configured token digests and incompatible policies, and input mutation cannot expand access',async()=>{
  let time=Date.now();const token=oauthJwt({}, {},undefined,time),request=oauthRequest(token);const input={...oauthPolicy,requiredScopes:[...oauthPolicy.requiredScopes],revokedTokenDigests:[] as string[]};
  const auth=new OAuthResourceAuthenticator(input,{load:async()=>jwks()},()=>time);await auth.authenticate(request);const grant=auth.grantFor(request);input.requiredScopes.length=0;input.revokedTokenDigests.push(grant.tokenDigest);auth.assertGrant(grant);
  const revoked=new OAuthResourceAuthenticator({...oauthPolicy,revokedTokenDigests:[createHash('sha256').update(token).digest('hex')]},{load:async()=>jwks()});assert.throws(()=>revoked.assertGrant(grant),AuthorizationRevoked);await assert.rejects(()=>revoked.authenticate(oauthRequest(token)),/authentication_failed/);
  const changed=new OAuthResourceAuthenticator({...oauthPolicy,ownerSubject:'other'},{load:async()=>jwks()});assert.throws(()=>changed.assertGrant(grant),AuthorizationRevoked);
  time=grant.expiresAt;assert.throws(()=>auth.assertGrant(grant),AuthorizationRevoked);auth.close();revoked.close();changed.close();
});
test('persisted OAuth subscriptions survive restart with matching policy; expiry/revocation/policy change retire pending work without a callback',async()=>{
  for(const mode of ['same','expire','revoke','policy','legacy'] as const) {
    const dir=mkdtempSync(join(tmpdir(),'oauth-grant-')),path=join(dir,'state.sqlite');let time=Date.now(),calls=0;
    const token=oauthJwt({}, {},undefined,time),request=oauthRequest(token),auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>jwks()},()=>time);await auth.authenticate(request);const grant=auth.grantFor(request);
    const callback:any={post:async(_url:string,body:string,headers:any,guard:()=>void)=>{guard();new Webhook(secret).verify(body,headers);const data=JSON.parse(body);if(data.type==='verification')return {status:200,body:JSON.stringify({challenge:data.challenge})};calls++;return {status:202,body:''};}};
    const config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:oauthPolicy.principal});
    let store=new Store(path),bridge=new Bridge(config,store,{send:async()=>{throw new Error('no send');}},()=>time),events=new EventsAdapter(bridge,callback,['callback.example.test'],async()=>{},g=>auth.assertGrant(g));
    try {
      const sub=await events.subscribe(config.principal,subscribe,()=>{},grant);assert.equal(Date.parse(sub.refreshBefore),grant.expiresAt);
      const message:Message={id:'100000000000000011',guildId:guild,channelId:channel,threadId:thread,authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'mock only',timestamp:time};assert.equal(bridge.ingest(message),'queued');
      assert.ok(!readFileSync(path).includes(Buffer.from(token)));if(mode==='legacy')delete store.state.subscriptions[sub.id]!.authorization;store.save();store.close();auth.close();
      if(mode==='expire')time=grant.expiresAt;
      const next=new OAuthResourceAuthenticator({...oauthPolicy,...(mode==='revoke'?{revokedTokenDigests:[grant.tokenDigest]}:{}),...(mode==='policy'?{requiredScopes:['discord:read']}:{})},{load:async()=>jwks()},()=>time);
      store=new Store(path);bridge=new Bridge(config,store,{send:async()=>{throw new Error('no send');}},()=>time);events=new EventsAdapter(bridge,callback,['callback.example.test'],async()=>{},g=>next.assertGrant(g));
      await events.dispatchOne();assert.equal(calls,mode==='same'?1:0);assert.equal(store.state.subscriptions[sub.id]!.active,mode==='same');assert.equal(Object.values(store.state.deliveries)[0]!.status,mode==='same'?'accepted':'dead');next.close();
    } finally {store.close();auth.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test('access expires during callback challenge preparation: no activation or application submission',async()=>{
  let time=Date.now();const auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>jwks()},()=>time),request=oauthRequest(oauthJwt({}, {},undefined,time));await auth.authenticate(request);const grant=auth.grantFor(request);
  const store=new Store(':memory:'),config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:oauthPolicy.principal}),bridge=new Bridge(config,store,{send:async()=>''},()=>time);
  let posts=0;const events=new EventsAdapter(bridge,{post:async(_url,body,_headers,guard)=>{time=grant.expiresAt;guard();posts++;return {status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})};}},['callback.example.test'],async()=>{},g=>auth.assertGrant(g));
  try {await assert.rejects(()=>events.subscribe(config.principal,subscribe,()=>{},grant));assert.equal(posts,0);assert.equal(Object.keys(store.state.subscriptions).length,0);}finally{auth.close();store.close();}
});

async function grantFixture() {
  let time=Date.now(),posts=0;const now=()=>time;
  const auth=new OAuthResourceAuthenticator(oauthPolicy,{load:async()=>jwks()},now),request=oauthRequest(oauthJwt({}, {},undefined,time));await auth.authenticate(request);const grant=auth.grantFor(request);
  const store=new Store(':memory:'),config=configSchema.parse({mode:'guild_owner',ownerUserId:owner,bridgeBotId:bot,guildId:guild,principal:oauthPolicy.principal});
  const bridge=new Bridge(config,store,{send:async(_m,_text,guard)=>{guard();posts++;return 'mock-reply';}},now);
  const transport={post:async(_url:string,body:string,headers:Record<string,string>,guard:()=>void)=>{guard();new Webhook(secret).verify(body,headers);return {status:202,body:JSON.stringify({challenge:JSON.parse(body).challenge})};}};
  const adapter=(a:OAuthResourceAuthenticator)=>new EventsAdapter(bridge,transport,['callback.example.test'],async()=>{},g=>a.assertGrant(g));
  const events=adapter(auth),sub=await events.subscribe(config.principal,subscribe,()=>{},grant);
  const message:Message={id:'100000000000000011',guildId:guild,channelId:channel,threadId:thread,authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'mock only',timestamp:time};
  return {auth,grant,store,bridge,events,sub,adapter,transport,message,now,setTime:(v:number)=>{time=v;},posts:()=>posts};
}
async function tool(endpoint:ReturnType<typeof makeAuthenticatedEndpoint>,token:string,name:string,args:Record<string,unknown>) {
  const request=new Request('https://local-mcp.invalid/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':name,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'mock-grant-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
  const response=await endpoint(request);return {status:response.status,value:JSON.parse(await response.text())};
}
test('valid replacement token cannot read/reply an expired, revoked, changed-policy or legacy subscription, including cached replies',async()=>{
  for(const mode of ['expire','revoke','policy','legacy'] as const) {
    const f=await grantFixture();let next:OAuthResourceAuthenticator|undefined;
    try {
      f.bridge.ingest(f.message);await f.events.dispatchOne();const args={subscription_id:f.sub.id,event_id:'discord_'+f.message.id};
      await f.bridge.reply(oauthPolicy.principal,f.sub.id,args.event_id,'mock reply');assert.equal(f.posts(),1);
      if(mode==='expire')f.setTime(f.grant.expiresAt);if(mode==='legacy')delete f.store.state.subscriptions[f.sub.id]!.authorization;
      next=new OAuthResourceAuthenticator({...oauthPolicy,...(mode==='revoke'?{revokedTokenDigests:[f.grant.tokenDigest]}:{}),...(mode==='policy'?{requiredScopes:['discord:read']}:{})},{load:async()=>jwks()},f.now);
      const token=oauthJwt({jti:'replacement'}, {},undefined,f.now());await next.authenticate(oauthRequest(token));const endpoint=makeAuthenticatedEndpoint(f.bridge,f.adapter(next),next,'local-mcp.invalid');
      for(const name of ['discord_read','discord_reply']) {const result=await tool(endpoint,token,name,{...args,...(name==='discord_reply'?{content:'mock reply'}:{})});assert.equal(result.status,200);assert.ok(result.value.error||result.value.result?.isError);assert.doesNotMatch(JSON.stringify(result.value),/mock only|mock-reply/);}
      assert.equal(f.posts(),1);assert.equal(f.store.state.subscriptions[f.sub.id]!.active,false);
    } finally {next?.close();f.auth.close();f.store.close();}
  }
});
test('refresh with a new authorized token replaces only the same subscription grant and permits bound read/reply',async()=>{
  const f=await grantFixture();try {
    f.setTime(f.grant.expiresAt);const request=oauthRequest(oauthJwt({jti:'refresh'}, {},undefined,f.now()));await f.auth.authenticate(request);const grant=f.auth.grantFor(request);
    const refreshed=await f.events.subscribe(oauthPolicy.principal,subscribe,()=>{},grant);assert.equal(refreshed.id,f.sub.id);assert.equal(Object.keys(f.store.state.subscriptions).length,1);assert.equal(f.store.state.subscriptions[f.sub.id]!.authorization!.tokenDigest,grant.tokenDigest);assert.equal(Date.parse(refreshed.refreshBefore),grant.expiresAt);
    f.bridge.ingest({...f.message,timestamp:f.now()});await f.events.dispatchOne();const result=await tool(makeAuthenticatedEndpoint(f.bridge,f.events,f.auth,'local-mcp.invalid'),request.headers.get('authorization')!.slice(7),'discord_reply',{subscription_id:f.sub.id,event_id:'discord_'+f.message.id,content:'mock refreshed reply'});assert.equal(result.value.result.isError,undefined);assert.equal(f.posts(),1);
  } finally {f.auth.close();f.store.close();}
});
test('grant expiry after actual callback DNS preparation denies HTTPS creation',async()=>{
  const f=await grantFixture();let connects=0,entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  try {
    f.bridge.ingest(f.message);const transport=new PinnedHttps(['callback.example.test'],async()=>{entered();await gate;return [{address:'8.8.8.8',family:4}];},(()=>{connects++;throw new Error('never connect');}) as any);
    const events=new EventsAdapter(f.bridge,transport,['callback.example.test'],async()=>{},g=>f.auth.assertGrant(g));const pending=events.dispatchOne();await ready;f.setTime(f.grant.expiresAt);release();await pending;assert.equal(connects,0);assert.equal(f.store.state.subscriptions[f.sub.id]!.active,false);assert.equal(Object.values(f.store.state.deliveries)[0]!.status,'dead');
  } finally {release?.();f.auth.close();f.store.close();}
});
test('idle worker retires expired/revoked authorization without waiting for a message',async()=>{
  for(const mode of ['expire','revoke'] as const) {const f=await grantFixture();let auth=f.auth;try {if(mode==='expire')f.setTime(f.grant.expiresAt);else auth=new OAuthResourceAuthenticator({...oauthPolicy,revokedTokenDigests:[f.grant.tokenDigest]},{load:async()=>jwks()},f.now);assert.equal(await f.adapter(auth).dispatchOne(),'idle');assert.equal(f.store.state.subscriptions[f.sub.id]!.active,false);assert.equal(Object.keys(f.store.state.deliveries).length,0);}finally{auth.close();f.auth.close();f.store.close();}}
});
test('old subscription expiry during reply preparation prevents a send even with a current request token',async()=>{
  const f=await grantFixture();try {
    f.bridge.ingest(f.message);await f.events.dispatchOne();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let sends=0;
    (f.bridge as any).sender={send:async(_m:unknown,_text:string,guard:()=>void)=>{entered();await gate;guard();sends++;return 'never';}};
    const token=oauthJwt({jti:'current-longer',exp:Math.floor(f.now()/1000)+1200}, {},undefined,f.now()),endpoint=makeAuthenticatedEndpoint(f.bridge,f.events,f.auth,'local-mcp.invalid');
    const pending=tool(endpoint,token,'discord_reply',{subscription_id:f.sub.id,event_id:'discord_'+f.message.id,content:'mock delayed reply'});await ready;f.setTime(f.grant.expiresAt);release();const result=await pending;assert.equal(sends,0);assert.ok(result.value.error||result.value.result?.isError||JSON.parse(result.value.result.content[0].text).status==='uncertain');
  } finally {f.auth.close();f.store.close();}
});
