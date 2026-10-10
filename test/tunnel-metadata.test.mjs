import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
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
json.dump(record,open(config['report'],'w'))
print(expected.decode(),flush=True)
print(expected.decode(),file=sys.stderr,flush=True)
if config['mode']=='fail': sys.exit(9)
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
    const result=spawnSync(process.execPath,['scripts/tunnel-metadata.mjs',...args],{env:{...cleanEnvironment(),CONTROL_PLANE_API_KEY:token,LOG_HTTP_RAW_UNSAFE:'true',CLOUDFLARED_MANAGED:'true'},encoding:'utf8'});assert.equal(result.status,2);assert.equal(result.stdout,'metadata_command_denied_no_start\n');assert.equal(result.stderr,'');
  }
  const p={tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-mock',issuer:'https://mock.us.auth0.com/'};
  const yaml=profileText(p);assert.match(yaml,/api_key: file:\/dev\/fd\/4/);assert.match(yaml,/http_raw_unsafe: false/);assert.match(yaml,/capture_payloads: false/);assert.match(yaml,/file: \/dev\/null/);assert.equal(yaml.includes(token),false);
  assert.equal(Object.keys(cleanEnvironment()).sort().join(','),'HOME,PATH');
  assert.throws(()=>validatePlan({...p,credential:token}),/plan_denied/);
});
