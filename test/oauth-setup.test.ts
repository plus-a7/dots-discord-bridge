import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { OAuthSetupRuntime, parseOAuthSetup, makeOAuthSetupEndpoint, diagnoseCallbackHost } from '../src/oauth-setup.js';
import { parseDeployment } from '../src/deployment.js';
import { runCommand } from '../src/cli.js';
import { folders } from './bootstrap-fixture.js';
import { oauthPolicy, oauthJwt } from './oauth-fixture.js';

export function setupConfig() {
  const {issuer,jwksUrl,resource,audience,requiredScopes}=oauthPolicy;
  return {version:1,mode:'oauth_setup',enabled:true,oauth:{issuer,jwksUrl,resource,audience,requiredScopes:[...requiredScopes]},http:{kind:'tunnel_loopback',port:43124}};
}
test('metadata setup requires real-shaped issuer/resource but never owner/Bot/callback fields; production refuses it',async()=>{
  const config=setupConfig();assert.ok(Object.isFrozen(parseOAuthSetup(config).oauth.requiredScopes));
  assert.throws(()=>parseOAuthSetup(JSON.parse(readFileSync('oauth-setup.example.json','utf8'))),{message:'oauth_setup_disabled_or_incomplete'});
  for(const raw of [{...config,enabled:false},{...config,oauth:null},{...config,ownerSubject:'mock'},{...config,callbackHosts:[]},{...config,credential:{kind:'keychain'}},{...config,authentication:{token:'mock-secret'}},{...config,oauth:{...config.oauth,ownerSubject:'mock'}},{...config,oauth:{...config.oauth,audience:'https://other.example.test/mcp'}},{...config,oauth:{...config.oauth,jwksUrl:'http://issuer.example.test/keys'}},{...config,oauth:{...config.oauth,requiredScopes:['dup','dup']}},{...config,http:{kind:'forwarded_https',host:'127.0.0.1',port:43124}}])assert.throws(()=>parseOAuthSetup(raw),{message:'oauth_setup_disabled_or_incomplete'});
  assert.throws(()=>parseDeployment(config),{message:'deployment_disabled_or_incomplete'});
  const runtime=new OAuthSetupRuntime(config);await assert.rejects(()=>runtime.start(),/activation_required/);assert.equal((await runtime.stop()).clean,true);
});
test('metadata-only fetch refuses discovery/tools/Events regardless of valid JWT, and never fetches JWKS or callback',async()=>{
  const endpoint=makeOAuthSetupEndpoint(parseOAuthSetup(setupConfig()));let requests=0;const previous=globalThis.fetch;
  globalThis.fetch=async()=>{requests++;throw new Error('outbound_denied');};
  try {
    for(const path of endpoint.paths) {
      const response=await endpoint.fetch(new Request('https://local-mcp.invalid'+path));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{resource:oauthPolicy.resource,authorization_servers:[oauthPolicy.issuer],scopes_supported:oauthPolicy.requiredScopes,bearer_methods_supported:['header']});
    }
    const secret='mock-private-signing-secret';
    for(const method of ['server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe'])for(const token of [undefined,'Bearer '+oauthJwt(),'Bearer '+secret]) {
      const response=await endpoint.fetch(new Request('https://local-mcp.invalid/mcp',{method:'POST',headers:{...(token?{Authorization:token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{delivery:{url:'https://receiver.example.test/private-mock-path',secret}}})}));
      assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate')!,/oauth-protected-resource\/mcp/);assert.equal(await response.text(),'');assert.equal(JSON.stringify([...response.headers]).includes(secret),false);
    }
    for(const url of ['https://other.example.test/mcp','http://local-mcp.invalid/mcp','https://local-mcp.invalid/mcp?access_token=mock'])assert.equal((await endpoint.fetch(new Request(url))).status,403);
    assert.equal((await endpoint.fetch(new Request('https://local-mcp.invalid/mcp',{headers:{Origin:'https://mcp.example.test'}}))).status,403);
    assert.equal((await endpoint.fetch(new Request('https://local-mcp.invalid/.well-known/openid-configuration'))).status,404);
    assert.equal(requests,0);
  } finally {globalThis.fetch=previous;}
});
test('CLI setup commands require explicit activation, do static checks without production factory, and drain on stop',async()=>{
  let reads=0,starts=0,production=0;const signals=new EventEmitter(),status:string[]=[];let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const io={readConfig:()=>{reads++;return setupConfig();},createBootstrap:()=>{production++;throw new Error('production_denied');},createSetup:()=>{starts++;return {start:async()=>{entered();return 43124;},stop:async()=>({clean:true,pending:false})};},signals,status:(s:string)=>status.push(s)};
  assert.equal(await runCommand(['setup-serve','--config','/mock/setup.json'],io),2);assert.equal(reads,0);assert.equal(starts,0);
  assert.equal(await runCommand(['setup-check','--config','/mock/setup.json'],io),0);assert.equal(starts,0);assert.equal(JSON.parse(status.at(-1)!).eventsEnabled,false);
  const pending=runCommand(['setup-serve','--config','/mock/setup.json','--activate'],io);await ready;await new Promise(r=>setImmediate(r));signals.emit('SIGTERM');assert.equal(await pending,0);assert.equal(production,0);assert.equal(starts,1);assert.equal(signals.listenerCount('SIGTERM'),0);assert.ok(status.includes('oauth_setup_metadata_only_running'));
  assert.equal(await runCommand(['setup-serve','--config','/mock/setup.json','--activate'],{...io,createSetup:()=>{throw new Error('mock-secret');}}),1);assert.equal(status.join('\n').includes('mock-secret'),false);
});
test('callback diagnostic accepts hostname only, never trusts/fetches/stores URL or secret, and hides invalid inputs',async()=>{
  assert.deepEqual(diagnoseCallbackHost('receiver.example.test'),{status:'callback_host_syntax_valid',trusted:false,next:'confirm_actual_chatgpt_events_host_then_set_production_allowlist'});
  const status:string[]=[];let reads=0;const io={readConfig:()=>{reads++;throw new Error('no config read');},status:(s:string)=>status.push(s)};
  for(const value of ['https://receiver.example.test/private-mock-secret?token=mock','127.0.0.1','localhost','*.example.test','Receiver.example.test','receiver.example.test:443','user:mock-secret@receiver.example.test','receiver.example.test\nmock-secret']) {
    assert.throws(()=>diagnoseCallbackHost(value),{message:'callback_host_invalid'});assert.equal(await runCommand(['setup-callback-check','--host',value],io),2);assert.equal(status.at(-1),'callback_host_invalid');
  }
  assert.equal(await runCommand(['setup-callback-check','--host','receiver.example.test'],io),0);assert.equal(JSON.parse(status.at(-1)!).trusted,false);assert.equal(status.at(-1)!.includes('receiver.example.test'),false);assert.equal(reads,0);
});
test('real CLI setup check/import loads no Discord/bootstrap/keychain/JWKS/callback runtime and creates no SQLite/credential state',()=>{
  const paths=folders();
  try {
    const source=`import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(['discord.js','node:https','node:dns','node:child_process'].includes(s)||/\\/(bootstrap|discord|keychain|jwks|callback|runtime|mcp)\\.js$/.test(s))throw new Error('forbidden_dependency:'+s);return next(s,c);},load(u,c,next){if(u==='node:sqlite')return {format:'module',shortCircuit:true,source:'export class DatabaseSync {constructor(){throw new Error("sqlite_denied")}}'};return next(u,c);}});const {runCommand}=await import('./dist/src/cli.js');let starts=0;const code=await runCommand(['setup-check','--config','/mock/setup.json'],{readConfig:()=>(${JSON.stringify(setupConfig())}),createBootstrap:()=>{starts++;throw new Error('production_denied')}});if(code!==0||starts)throw new Error('setup_failed');`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,DISCORD_TOKEN:'mock-secret-must-not-be-read'},encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.equal(JSON.parse(result.stdout).liveReady,false);assert.equal(result.stdout.includes('mock-secret'),false);
    assert.deepEqual(readdirSync(paths.privateDirectory),[]);assert.deepEqual(readdirSync(paths.ownershipDirectory),[]);
  } finally {paths.cleanup();}
});
