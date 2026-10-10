import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,copyFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createDiagnosticDecoder,validateClientProfile,listenerOwner,healthStatus,probeClientHealth } from '../scripts/tunnel-diagnostics.mjs';
import { runSession,stopSession,cleanEnvironment,controlSocket } from '../scripts/tunnel-session-core.mjs';
import { OAuthSetupRuntime } from '../dist/src/oauth-setup.js';
import { validatePlan,profileText,provisionalResource } from '../scripts/tunnel-plan.mjs';

const temporary=mkdtempSync('/tmp/tm-mock-');
const helper=join(temporary,'launcher-mock');
const build=spawnSync('/usr/bin/xcrun',['swiftc','-O','-suppress-warnings','-D','TUNNEL_MOCK','-module-cache-path',resolve('dist/native/module-cache'),'native/tunnel-keychain-launcher.swift','-o',helper,'-framework','Security','-framework','LocalAuthentication'],{encoding:'utf8',timeout:60000});
assert.equal(build.status,0,build.stderr);
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const token='sk-MOCK-ONLY-PIPE-CREDENTIAL-0123456789abcdef';
const python='/usr/bin/python3';
function fixture(mode='wait') {
  const directory=mkdtempSync(join(temporary,'session-')),report=join(directory,'report.json'),client=join(directory,'mock-client'),profile=join(directory,'mock-config.json');
  writeFileSync(profile,JSON.stringify({mode,report}),{mode:0o600});
  writeFileSync(client,`#!${python}
import os,sys,json,signal,time,subprocess
config=json.load(open(sys.argv[sys.argv.index('--config')+1]))
credential=open('/dev/fd/4','rb').read()
expected=b'${token}'
record={'pid':os.getpid(),'pipe_ok':credential==expected,'argv_clean':expected.decode() not in ' '.join(sys.argv),'env_clean':expected.decode() not in str(dict(os.environ)),'control_closed':False,'mode':config['mode']}
try: os.fstat(3)
except OSError: record['control_closed']=True
if config['mode']=='descendant':
    child=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'])
    record['descendant']=child.pid
with open(config['report']+'.tmp','w') as saved: json.dump(record,saved)
os.replace(config['report']+'.tmp',config['report'])
print(expected.decode(),flush=True)
print(expected.decode(),file=sys.stderr,flush=True)
if config['mode']=='fail': sys.exit(9)
if config['mode']=='zero': sys.exit(0)
if config['mode']=='signal': os.kill(os.getpid(),signal.SIGTERM)
signal.signal(signal.SIGTERM,lambda a,b:sys.exit(0))
while True: time.sleep(.02)
`,{mode:0o700});
  return{directory,report,client,profile};
}
async function until(predicate,ms=3000) {
  const deadline=Date.now()+ms;while(!predicate()){if(Date.now()>deadline)throw new Error('mock_wait_timeout');await new Promise(r=>setTimeout(r,15));}
}
function alive(pid) {
  const result=spawnSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'});return result.status===0&&result.stdout.trim()&&!result.stdout.trim().startsWith('Z');
}
const config={version:1,mode:'oauth_setup',enabled:true,oauth:{issuer:'https://issuer.example.test/',jwksUrl:'https://issuer.example.test/.well-known/jwks.json',resource:provisionalResource,audience:provisionalResource,requiredScopes:['discord:bridge']},http:{kind:'tunnel_loopback',port:43125}};
function options(f,extra={}) {
  return{...f,helper,config,runtimeFactory:()=>({start:async()=>43125,stop:async()=>({clean:true})}),signals:new EventEmitter(),...extra};
}
test('native inherited pipe delivers only synthetic credential; user stop cleans group, state, listener, and output',async()=>{
  const f=fixture('descendant'),status=[];let starts=0,stops=0;
  const pending=runSession(options(f,{runtimeFactory:()=>({start:async()=>{starts++;},stop:async()=>{stops++;return{clean:true};}}),status:s=>status.push(s)}));
  await until(()=>existsSync(f.report));const report=JSON.parse(readFileSync(f.report,'utf8'));
  assert.equal(report.pipe_ok,true);assert.equal(report.argv_clean,true);assert.equal(report.env_clean,true);assert.equal(report.control_closed,true);
  assert.equal(await stopSession(f.directory),true);assert.equal(await pending,0);
  await until(()=>!alive(report.descendant));assert.equal(alive(report.pid),false);
  assert.equal(starts,1);assert.equal(stops,1);assert.equal(existsSync(join(f.directory,'run')),false);
  assert.equal(status.includes('metadata_only_session_started'),true);assert.equal(status.includes('metadata_session_stopped'),true);assert.equal(status.join('\n').includes(token),false);
  for(const name of readdirSync(f.directory))assert.equal(readFileSync(join(f.directory,name),'utf8').includes(token),name==='mock-client');
});
test('client failure, spawn failure, startup failure, timeout, and concurrent start release only owned resources',async()=>{
  for(const scenario of ['fail','spawn','startup','timeout']) {
    const f=fixture(scenario==='fail'?'fail':'wait'),status=[];let stopped=0;
    const opts=options(f,{lifetimeMs:scenario==='timeout'?80:3000,status:s=>status.push(s),runtimeFactory:()=>({start:async()=>{if(scenario==='startup')throw new Error(token);},stop:async()=>{stopped++;return{clean:true};}})});
    if(scenario==='spawn')opts.helper=join(f.directory,'absent-helper');
    const code=await runSession(opts);assert.equal(code,scenario==='timeout'?0:2);assert.equal(stopped,1);assert.equal(existsSync(join(f.directory,'run')),false);assert.equal(status.join('\n').includes(token),false);
    if(existsSync(f.report))assert.equal(alive(JSON.parse(readFileSync(f.report,'utf8')).pid),false);
  }
  const f=fixture(),pending=runSession(options(f));await until(()=>existsSync(f.report));let otherStarted=0;
  assert.equal(await runSession(options(f,{runtimeFactory:()=>{otherStarted++;throw new Error('unexpected');}})),2);assert.equal(otherStarted,0);
  assert.equal(existsSync(controlSocket(f.directory)),true);assert.equal(await stopSession(f.directory),true);assert.equal(await pending,0);
});
test('hard parent death closes control pipe and native guardian terminates client',async()=>{
  const f=fixture('descendant');
  const body=`import {runSession} from ${JSON.stringify(new URL('../scripts/tunnel-session-core.mjs',import.meta.url).href)};await runSession({...${JSON.stringify({...f,helper,config})},runtimeFactory:()=>({start:async()=>{},stop:async()=>({clean:true})})});`;
  const parent=spawn(process.execPath,['--input-type=module','-e',body],{env:cleanEnvironment(),stdio:'ignore'});
  const closed=new Promise(r=>parent.once('close',r));
  await until(()=>existsSync(f.report));const report=JSON.parse(readFileSync(f.report,'utf8'));parent.kill('SIGKILL');await closed;
  await until(()=>!alive(report.pid)&&!alive(report.descendant),5000);
  // Abrupt death can leave a stale lock; it must prevent unattended restart.
  assert.equal(await runSession(options(f)),2);assert.equal(existsSync(join(f.directory,'run')),true);
});
test('real metadata-only listener remains 401 for discovery, tools and events during a mock session',async()=>{
  const f=fixture(),pending=runSession(options(f,{runtimeFactory:raw=>new OAuthSetupRuntime(raw)}));
  try {
    await until(()=>existsSync(f.report));
    const metadata=await fetch('http://127.0.0.1:43125/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.status,200);assert.equal((await metadata.json()).resource,provisionalResource);
    for(const method of ['server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']) {
      const response=await fetch('http://127.0.0.1:43125/mcp',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method})});assert.equal(response.status,401);assert.equal(await response.text(),'');
    }
  }finally {await stopSession(f.directory);await pending;}
  await assert.rejects(fetch('http://127.0.0.1:43125/.well-known/oauth-protected-resource'));
});
test('Terminal hangup and fragmented stop acknowledgement both work',async()=>{
  const f=fixture('descendant'),signals=new EventEmitter();let child;
  const pending=runSession(options(f,{signals,launch:(...args)=>{child=spawn(...args);return child;}}));
  await until(()=>existsSync(f.report));const report=JSON.parse(readFileSync(f.report,'utf8'));
  child.kill('SIGHUP');signals.emit('SIGHUP');assert.equal(await pending,0);
  await until(()=>!alive(report.pid)&&!alive(report.descendant));assert.equal(signals.listenerCount('SIGHUP'),0);
  const directory=mkdtempSync(join(temporary,'split-'));mkdirSync(join(directory,'run'),{mode:0o700});
  const server=createServer(socket=>socket.on('data',()=>{socket.write('STOP');setTimeout(()=>socket.end('PING\n'),25);}));
  await new Promise(resolve=>server.listen(controlSocket(directory),resolve));
  try{assert.equal(await stopSession(directory),true);}finally{await new Promise(resolve=>server.close(resolve));}
});
test('CLI start refuses non-Terminal and missing activation; safe config rendering cannot add grants or logging',()=>{
  for(const args of [[],['--start'],['--start','--person-start'],['--start','--person-start','--mock']]) {
    const result=spawnSync(process.execPath,['scripts/tunnel-metadata.mjs',...args],{env:{...cleanEnvironment(),CONTROL_PLANE_API_KEY:token,LOG_HTTP_RAW_UNSAFE:'true',CLOUDFLARED_MANAGED:'true'},encoding:'utf8'});assert.equal(result.status,2);assert.match(result.stdout,/^metadata_command_denied_stage_(arguments|terminal)\nmetadata_command_denied_no_start\n$/);assert.equal(result.stdout.includes(token),false);assert.equal(result.stderr,'');
  }
  const p={tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-mock',issuer:'https://mock.us.auth0.com/'};
  const yaml=profileText(p);assert.equal(yaml.includes('api_key:'),false);assert.equal(yaml.includes('/dev/fd/4'),false);assert.match(yaml,/http_raw_unsafe: false/);assert.match(yaml,/capture_payloads: false/);assert.match(yaml,/file: \/dev\/null/);assert.equal(yaml.includes(token),false);
  assert.equal(Object.keys(cleanEnvironment()).sort().join(','),'HOME,PATH');
  assert.throws(()=>validatePlan({...p,credential:token}),/plan_denied/);
});

test('fixed native stages classify synthetic Keychain errors before any client starts',async()=>{
 for(const [name,category] of [['notfound','item_not_found'],['denied','auth_failed'],['cancelled','user_cancelled'],['interaction','interaction_not_allowed'],['other','other']]){
  const f=fixture(),client=join(f.directory,'mock-keychain-'+name),status=[];copyFileSync(f.client,client);
  assert.equal(await runSession(options({...f,client},{status:s=>status.push(s)})),2);
  assert(status.includes('tunnel_helper_started'));assert(status.includes('tunnel_keychain_lookup_started'));
  assert(status.includes('tunnel_keychain_lookup_failed_'+category));assert(status.includes('metadata_guardian_exit_code_2'));
  assert.equal(status.includes('tunnel_client_spawn_started'),false);assert.equal(existsSync(f.report),false);
  assert.equal(existsSync(join(f.directory,'run')),false);assert.equal(status.join('\n').includes(token),false);
 }
});
test('native spawn failure and client exit/signal remain distinct from guardian result',async()=>{
 for(const mode of ['fail','zero','signal','missing']){
  const f=fixture(mode),status=[];
  if(mode==='missing')f.client=join(f.directory,'absent-client');
  assert.equal(await runSession(options(f,{status:s=>status.push(s)})),2);
  assert(status.includes('tunnel_keychain_lookup_complete'));assert(status.includes('tunnel_client_spawn_started'));
  if(mode==='missing')assert(status.includes('tunnel_client_spawn_failed_not_found'));
  else{assert(status.some(s=>/^tunnel_client_pid_[0-9]+$/.test(s)));assert(status.includes('tunnel_credential_handoff_complete'));
   assert(status.includes(mode==='signal'?'tunnel_client_exit_signal_15':mode==='zero'?'tunnel_client_exit_code_0':'tunnel_client_exit_code_9'));}
  assert(status.includes('metadata_guardian_exit_code_'+(mode==='zero'?0:2)));assert(status.includes('metadata_cleanup_started'));
  assert(status.includes('metadata_session_lock_released'));assert.equal(status.join('\n').includes(token),false);
 }
});
test('diagnostic decoder accepts fragments but never reflects secret, unknown, non-ASCII or oversized frames',()=>{
 const accepted=[],pids=[];let handoffs=0;
 const decode=createDiagnosticDecoder({report:s=>accepted.push(s),onClientPid:p=>pids.push(p),onHandoff:()=>handoffs++});
 decode(Buffer.from('tunnel_helper_sta'));decode(Buffer.from('rted\ntunnel_client_pid_123\ntunnel_credential_handoff_complete\ntunnel_client_exit_code_9\n'));
 assert.deepEqual(pids,[123]);assert.equal(handoffs,1);assert(accepted.includes('tunnel_client_exit_code_9'));
 for(const frames of [[token+'\n'],['https://example.invalid/?state='+token+'\n'],['tunnel_client_exit_code_999\n'],['tunnel_client_exit_signal_99\n'],['\u00e9\n'],['x'.repeat(100)],['tunnel_helper_started\n'.repeat(65)],['tunnel_helper_started\n'.repeat(250)]]){
  const status=[];let invalid=0;const parse=createDiagnosticDecoder({report:s=>status.push(s),invalid:()=>invalid++});
  for(const frame of frames)parse(Buffer.from(frame));parse(Buffer.from(token));
  assert.equal(invalid,1);assert.equal(status.filter(s=>s==='metadata_helper_diagnostic_invalid').length,1);
  assert.equal(status.join('\n').includes(token),false);assert.equal(status.some(s=>s.includes('state=')||s.includes('https:')),false);
 }
});
test('preflight and metadata startup failures name their stage and cleanup without reading Keychain',async()=>{
 for(const scenario of ['config','metadata']){
  const f=fixture(),status=[];let launchCount=0;
  const opts=options(f,{status:s=>status.push(s),launch:()=>{launchCount++;throw new Error(token);},preflight:()=>scenario!=='config',runtimeFactory:()=>({start:async()=>{throw new Error(token);},stop:async()=>({clean:true})})});
  assert.equal(await runSession(opts),2);assert.equal(launchCount,0);
  assert(status.includes('metadata_start_failed_stage_'+(scenario==='config'?'client_config':'metadata_listener')));assert(status.includes('metadata_session_lock_released'));
  assert.equal(status.join('\n').includes(token),false);assert.equal(existsSync(f.report),false);
 }
 const f=fixture(),calls=[];
 for(const result of [{status:0},{status:2,stdout:token,stderr:token},{error:Error(token)}]){
  const output=validateClientProfile(f.client,f.profile,f.directory,(...args)=>{calls.push(args);return result;});
  assert(['ok','rejected','spawn_or_timeout'].includes(output));assert.equal(output.includes(token),false);
 }
 for(const [,args,opts] of calls){assert.equal(args[0],'profiles');assert.equal(args[1],'add');assert.equal(opts.stdio,'ignore');assert.deepEqual(Object.keys(opts.env).sort(),['HOME','PATH']);}
});
test('health timeout, owner mismatch and readiness snapshots diagnose once and clean up',async()=>{
 for(const state of ['listener_absent','listener_owner_mismatch','local_ready']){
  const f=fixture(),status=[];let probes=0;
  const pending=runSession(options(f,{status:s=>status.push(s),healthTimeoutMs:35,healthIntervalMs:10,healthProbe:async pid=>{assert(Number.isInteger(pid)&&pid>0);probes++;return state;}}));
  if(state==='local_ready'){await until(()=>status.includes('metadata_client_local_ready_does_not_prove_auth_or_dot_wake'));await stopSession(f.directory);assert.equal(await pending,0);}
  else assert.equal(await pending,2);
  assert(probes>=1);assert.equal(status.filter(s=>s==='metadata_client_'+state).length,1);
  assert.equal(status.includes('metadata_client_health_timeout'),state==='listener_absent');
  assert(status.includes('metadata_session_lock_released'));assert.equal(status.join('\n').includes(token),false);
 }
});
test('health reads are local status-only, refuse redirects, verify owner and abort boundedly',async()=>{
 let mode='ready';const paths=[];
 const server=httpServer((req,res)=>{paths.push(req.url);if(mode==='hang')return;
  if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/?state='+token});res.end(token);return;}
  res.writeHead(req.url==='/readyz'&&mode==='gated'?503:200);res.end(token);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(43126,'127.0.0.1',resolve);});
 try{
  assert.equal(listenerOwner(43126),process.pid);
  assert.equal(await probeClientHealth(process.pid+1000000),'listener_owner_mismatch');assert.equal(paths.length,0);
  assert.equal(await probeClientHealth(process.pid),'local_ready');mode='gated';assert.equal(await probeClientHealth(process.pid),'local_gated');
  mode='redirect';assert.equal(await probeClientHealth(process.pid),'redirect_denied');
  assert.equal(await healthStatus('/invalid'),'unavailable');
  mode='hang';const controller=new AbortController();const pending=healthStatus('/readyz',controller.signal);controller.abort();assert.equal(await pending,'cancelled');
  const started=Date.now();assert.equal(await healthStatus('/readyz'),'timeout');assert(Date.now()-started<1800);
  assert(paths.every(p=>p==='/healthz'||p==='/readyz'));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 assert.equal(listenerOwner(43126),'absent');
});

test('late ready and nonsettling health probes cannot outlive or succeed after startup deadline',async()=>{
 for(const mode of ['late','never']){
  const f=fixture(),status=[];let observedSignal;
  const pending=runSession(options(f,{status:s=>status.push(s),healthTimeoutMs:35,healthProbe:(_pid,signal)=>{
   observedSignal=signal;
   return mode==='late'?new Promise(resolve=>setTimeout(()=>resolve('local_ready'),70)):new Promise(()=>{});
  }}));
  assert.equal(await pending,2);
  assert.equal(observedSignal.aborted,true);assert(status.includes('metadata_client_health_timeout'));
  assert.equal(status.includes('metadata_client_local_ready'),false);assert.equal(status.includes('metadata_client_local_ready_does_not_prove_auth_or_dot_wake'),false);
  assert(status.includes('metadata_session_lock_released'));assert.equal(status.join('\n').includes(token),false);
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(status.includes('metadata_client_local_ready'),false);
 }
});
