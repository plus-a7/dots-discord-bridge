import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { readKeychainToken, type KeychainSpawn } from '../src/keychain.js';
import { LoginBootstrap } from '../src/bootstrap.js';
import { parseDeployment } from '../src/deployment.js';
import { folders,settings,dummyToken,until,bot,guild } from './bootstrap-fixture.js';

const ref={kind:'keychain',service:'DOTS_DISCORD_BOT',account:'discord',timeoutMs:50};
function transport(run:(pipe:PassThrough,child:EventEmitter)=>void=()=>{}) {
  const pipe=new PassThrough(),child:any=new EventEmitter(),kills:string[]=[],calls:{executable:string;args:readonly string[];options:SpawnOptions}[]=[];
  child.stdio=[null,null,null,pipe];child.kill=(signal:string)=>{kills.push(signal);return true;};
  const launch:KeychainSpawn=(executable,args,options)=>{calls.push({executable,args,options});queueMicrotask(()=>run(pipe,child));return child as ChildProcess;};
  return {pipe,child,kills,calls,launch};
}
function succeed(pipe:PassThrough,child:EventEmitter,value=dummyToken) {pipe.end(Buffer.from(value));setImmediate(()=>child.emit('close',0,null));}
test('Keychain reference is explicit and helper receives names only, a private fd3 pipe, no inherited env or stdout/stderr',async()=>{
  const t=transport(succeed),token=await readKeychainToken(ref,new AbortController().signal,t.launch);assert.equal(token,dummyToken);
  assert.equal(t.calls.length,1);assert.equal(t.calls[0]!.executable,resolve('dist/native/keychain-reader'));
  assert.deepEqual(t.calls[0]!.args,['--service',ref.service,'--account',ref.account,'--no-ui']);
  assert.deepEqual(t.calls[0]!.options.stdio,['ignore','ignore','ignore','pipe']);assert.equal(t.calls[0]!.options.shell,false);
  assert.deepEqual(t.calls[0]!.options.env,{PATH:'/usr/bin:/bin'});assert.equal(JSON.stringify(t.calls).includes(dummyToken),false);assert.deepEqual(t.kills,[]);
});
test('unset, invalid, wrong source or already aborted reference never launches a helper or chooses a fallback',async()=>{
  const t=transport(),cancel=new AbortController();cancel.abort();
  for(const raw of [undefined,null,{}, {...ref,service:''},{...ref,account:'discord\nsecret'}, {...ref,timeoutMs:3001},{...ref,extra:dummyToken},{kind:'private_file'}])await assert.rejects(()=>readKeychainToken(raw,new AbortController().signal,t.launch),{message:'keychain_denied'});
  await assert.rejects(()=>readKeychainToken(ref,cancel.signal,t.launch),{message:'keychain_denied'});assert.equal(t.calls.length,0);
});
test('missing/denied/locked/mock UI-required and partial failures disclose no result or raw child error',async()=>{
  for(const run of [
    (_p:PassThrough,c:EventEmitter)=>c.emit('close',2,null),
    (p:PassThrough,c:EventEmitter)=>{p.end();setImmediate(()=>c.emit('close',0,null));},
    (p:PassThrough,c:EventEmitter)=>{p.end(Buffer.from(dummyToken));setImmediate(()=>c.emit('close',2,null));},
    (p:PassThrough,c:EventEmitter)=>{p.write(Buffer.from(dummyToken));c.emit('close',0,null);},
    (_p:PassThrough,c:EventEmitter)=>c.emit('error',new Error(dummyToken)),
    (p:PassThrough,_c:EventEmitter)=>p.emit('error',new Error(dummyToken)),
    (p:PassThrough,c:EventEmitter)=>{p.end(Buffer.from(dummyToken));setImmediate(()=>c.emit('close',null,'SIGTERM'));}
  ]) {const t=transport(run);await assert.rejects(()=>readKeychainToken(ref,new AbortController().signal,t.launch),{message:'keychain_denied'});assert.deepEqual(t.kills,['SIGKILL']);}
  await assert.rejects(()=>readKeychainToken(ref,new AbortController().signal,()=>{throw new Error(dummyToken);}),{message:'keychain_denied'});
});
test('wrong token bytes, selfbot token, output size/chunk overflow all fail closed and erase received buffers',async()=>{
  for(const value of ['','short','mfa.'+'x'.repeat(40),'x'.repeat(257),dummyToken+'\n',dummyToken+'💬']) {
    let data:Buffer|undefined;const t=transport((p,c)=>{data=Buffer.from(value);p.end(data);setImmediate(()=>c.emit('close',0,null));});
    await assert.rejects(()=>readKeychainToken(ref,new AbortController().signal,t.launch),{message:'keychain_denied'});assert.ok(!data||data.every(v=>v===0));
  }
  const chunks=Array.from({length:33},()=>Buffer.from('x')),t=transport((p,c)=>{for(const b of chunks)p.write(b);p.end();setImmediate(()=>c.emit('close',0,null));});
  await assert.rejects(()=>readKeychainToken(ref,new AbortController().signal,t.launch),{message:'keychain_denied'});assert.equal(t.kills.length,1);
});
test('Keychain timeout and owner shutdown kill only the helper; late successful output never becomes login data',async()=>{
  const t=transport();await assert.rejects(()=>readKeychainToken(ref,new AbortController().signal,t.launch),{message:'keychain_denied'});assert.deepEqual(t.kills,['SIGKILL']);
  t.child.emit('close',0,null);t.child.emit('error',new Error(dummyToken));
  const cancel=new AbortController(),u=transport(),work=readKeychainToken(ref,cancel.signal,u.launch);cancel.abort();await assert.rejects(()=>work,{message:'keychain_denied'});assert.deepEqual(u.kills,['SIGKILL']);
  const late=Buffer.from(dummyToken);u.pipe.emit('data',late);assert.ok(late.every(v=>v===0));u.child.emit('close',0,null);
});
test('required credential selector rejects stale config and disabled template never invokes Keychain',async()=>{
  const paths=folders(),base=settings(paths),t=transport();
  try {
    const {credential:_,...stale}=base;assert.throws(()=>parseDeployment(stale),{message:'deployment_disabled_or_incomplete'});
    const template=JSON.parse(readFileSync('deployment.example.json','utf8'));assert.deepEqual(template.credential,{...ref,timeoutMs:2000});assert.equal(template.enabled,false);assert.equal(template.confirmations.exclusiveBotOwnership,false);
    assert.throws(()=>new LoginBootstrap(template,{keychainSpawn:t.launch}),{message:'deployment_disabled_or_incomplete'});
    const boot=new LoginBootstrap({...base,credential:ref},{keychainSpawn:t.launch});await assert.rejects(()=>boot.start(),/activation_required/);assert.equal(t.calls.length,0);await boot.stop();
  }finally {paths.cleanup();}
});
function bootstrap(run:(pipe:PassThrough,child:EventEmitter)=>void) {
  const paths=folders(),t=transport(run),client:any=new EventEmitter();let ready=false,logins=0,closed=false;const status:string[]=[];
  client.guilds={cache:new Map([[guild,{}]])};client.user={id:bot,bot:true};client.isReady=()=>ready;
  client.login=async(value:string)=>{assert.equal(value,dummyToken);logins++;ready=true;return value;};client.destroy=async()=>{ready=false;client.token=null;};
  const boot=new LoginBootstrap({...settings(paths),credential:ref},{createClient:()=>client,keychainSpawn:t.launch,
    createRuntime:((options:any)=>({bridge:{binding:()=>{}},start:async()=>{options.onStatus?.('mock');return 0;},stop:async()=>{await options.gateway.destroy();closed=true;return {clean:true,pending:false};}})) as any});
  return {paths,t,boot,logins:()=>logins,closed:()=>closed,status};
}
test('bootstrap default Keychain route passes mock token only to mock client, not state, args or logs',async()=>{
  const f=bootstrap(succeed);
  try {assert.equal(await f.boot.start(true),0);assert.equal(f.logins(),1);assert.deepEqual(await f.boot.stop(),{clean:true,pending:false});assert.equal(f.closed(),true);assert.deepEqual(readdirSync(f.paths.privateDirectory),[]);assert.equal(JSON.stringify(f.t.calls).includes(dummyToken),false);
    for(const file of readdirSync(f.paths.ownershipDirectory))assert.equal(readFileSync(join(f.paths.ownershipDirectory,file)).includes(Buffer.from(dummyToken)),false);
  }finally {await f.boot.stop();f.paths.cleanup();}
});
test('bootstrap rejects mock Keychain denial before login and stop during pending read prevents late login',async()=>{
  const denied=bootstrap((_p,c)=>c.emit('close',2,null));
  try {await assert.rejects(()=>denied.boot.start(true),{message:'bootstrap_start_failed'});assert.equal(denied.logins(),0);assert.equal(denied.t.calls.length,1);assert.deepEqual(await denied.boot.stop(),{clean:true,pending:false});}
  finally {await denied.boot.stop();denied.paths.cleanup();}
  const f=bootstrap(()=>{}),starting=f.boot.start(true),failure=assert.rejects(()=>starting,{message:'bootstrap_start_failed'});
  try {await until(()=>f.t.calls.length===1);await f.boot.stop();await failure;f.t.child.emit('close',0,null);assert.equal(f.logins(),0);assert.deepEqual(f.t.kills,['SIGKILL']);}
  finally {await f.boot.stop();f.paths.cleanup();}
});
test('compiled native helper rejects missing args or nonpipe fd3 before Keychain access, with no standard output',()=>{
  for(const args of [[],['--service','MOCK_NEVER_READ','--account','mock','--no-ui']]) {
    const child=spawnSync(resolve('dist/native/keychain-reader'),args,{stdio:['ignore','pipe','pipe','ignore'],encoding:'utf8',timeout:2000});
    assert.equal(child.error,undefined);assert.equal(child.status,2);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  }
});
