import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync,statSync,copyFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLauncher,waitForEnter } from '../scripts/tunnel-launcher.mjs';
import { launcherText } from '../scripts/prepare-tunnel-launchers.mjs';
import { keylessPreflight } from '../scripts/tunnel-preflight.mjs';
const token='sk-MOCK-ONLY-UX-NONDISCLOSURE-0123456789abcdef';

test('launcher announces key use and requires preflight then one Enter before the exact existing start command',async()=>{
 const calls=[],output=[];let enters=0;
 const code=await runLauncher({action:'start',tty:true,output:s=>output.push(s),enter:async()=>{enters++;return true;},command:async(args,report)=>{
  calls.push(args);if(args[0]==='--start'){assert.equal(enters,1);report('metadata_only_session_started');report('metadata_client_local_ready_does_not_prove_auth_or_dot_wake');report('metadata_session_stopped');}return 0;
 }});
 assert.equal(code,0);assert.deepEqual(calls,[['--preflight'],['--start','--person-start']]);assert.equal(enters,2);
 assert(output.some(s=>s.includes('https://api.openai.com')));assert(output.some(s=>s.includes('ローカルready。OpenAI認証')));assert(output.includes('metadata_launcher_finished_ok'));
});
test('preflight error, cancel and exception never start or retry and retain only fixed results',async()=>{
 for(const mode of ['error','cancel','throw']){
  const calls=[],output=[];let enters=0;
  const code=await runLauncher({action:'start',tty:true,output:s=>output.push(s),enter:async()=>{enters++;return mode!=='cancel';},command:async args=>{calls.push(args);if(mode==='throw')throw new Error(token);return mode==='error'?2:0;}});
  assert.equal(code,2);assert.deepEqual(calls,[['--preflight']]);assert.equal(enters,mode==='cancel'?2:1);assert.equal(output.join('\n').includes(token),false);assert(output.includes('metadata_launcher_finished_failed_or_cancelled'));
 }
});
test('stop uses only the socket CLI and distinguishes acceptance from completion; non-TTY does no work',async()=>{
 const calls=[],output=[];let enters=0;
 assert.equal(await runLauncher({action:'stop',tty:true,command:async(a,r)=>{calls.push(a);r('metadata_stop_requested');return 0;},enter:async()=>{enters++;return true;},output:s=>output.push(s)}),0);
 assert.deepEqual(calls,[['--stop']]);assert.equal(enters,1);assert(output.some(s=>s.includes('開始画面の「停止完了」')));
 assert.equal(await runLauncher({action:'start',tty:false,command:()=>{assert.fail('unexpected_start');},enter:()=>{assert.fail('unexpected_input');},output:()=>{}}),2);
});
test('Enter reader accepts an empty line and cancels on text, EOF, signal and oversized input without reflection',async()=>{
 for(const mode of ['enter','text','eof','signal','long']){
  const input=new PassThrough(),signals=new EventEmitter(),pending=waitForEnter(input,signals);
  if(mode==='enter')input.write('\n');if(mode==='text')input.write(token+'\n');if(mode==='eof')input.end();if(mode==='signal')signals.emit('SIGINT');if(mode==='long')input.write('x'.repeat(1025));
  assert.equal(await pending,mode==='enter');assert.equal(signals.listenerCount('SIGINT'),0);input.destroy();
 }
});
test('keyless preflight refuses locks and config/port errors without launching or reading a key',()=>{
 const folder=mkdtempSync('/tmp/tm-ux-preflight-');
 try{
  const output=[],base={folder,load:()=>({plan:{client:{path:'/mock/client'}}}),validate:()=> 'ok',owner:()=> 'absent'};
  assert.equal(keylessPreflight(s=>output.push(s),base),0);assert(output.includes('metadata_preflight_passed_no_key_read_no_connection'));
  assert.equal(keylessPreflight(()=>{},{...base,validate:()=> 'rejected'}),2);
  assert.equal(keylessPreflight(()=>{},{...base,owner:()=>123}),2);
  assert.equal(keylessPreflight(()=>{},{...base,load:()=>{throw new Error(token);}}),2);
  mkdirSync(join(folder,'run'),{mode:0o700});assert.equal(keylessPreflight(()=>{},{...base,validate:()=>{assert.fail('lock_must_fail_first');}}),2);assert(existsSync(join(folder,'run')));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test('public renderer quotes absolute paths and gives no shell credential/automation or override path',()=>{
 assert.throws(()=>launcherText('/tmp/node','$invalid','start'),/path/);
 const text=launcherText('/tmp/node a\'b','/tmp/fixture a\'b.mjs','start');
 assert(text.includes("'\\''"));assert(text.includes('/usr/bin/env -i'));assert(text.includes('--start'));assert.equal(/osascript|security |eval |API_KEY|--client/.test(text),false);
 assert.throws(()=>launcherText('/tmp/node','/tmp/fixture','retry'),/action/);
});

test('Mac PTY executes the generated command with mock start/socket stop, duplicate start, cancel and failure',()=>{
 const folder=mkdtempSync("/tmp/tm-ux-a'b "),dir=join(folder,'session'),entry=join(folder,'fixture.mjs'),helper=join(folder,'helper'),stop=join(folder,'stop.mjs'),wrapper=join(folder,'fixture.command'),python=join(folder,'mock-pty-runner.py');
 mkdirSync(dir,{mode:0o700});
 const launcherURL=new URL('../scripts/tunnel-launcher.mjs',import.meta.url).href,coreURL=new URL('../scripts/tunnel-session-core.mjs',import.meta.url).href,preflightURL=new URL('../scripts/tunnel-preflight.mjs',import.meta.url).href;
 writeFileSync(helper,`#!${process.execPath}\nimport {Socket} from 'node:net';const s=new Socket({fd:3,readable:true,writable:true});s.on('end',()=>process.exit(0));s.once('data',()=>{process.stdout.write(${JSON.stringify(token)});process.stderr.write(${JSON.stringify(token)});s.write('tunnel_helper_started\\n');if(process.env.HOME.endsWith('fail'))process.exit(9);});`,{mode:0o700});
 writeFileSync(entry,`import {runLauncher} from ${JSON.stringify(launcherURL)};import {runSession,stopSession} from ${JSON.stringify(coreURL)};import {keylessPreflight} from ${JSON.stringify(preflightURL)};const folder=${JSON.stringify(dir)};process.exitCode=await runLauncher({action:process.argv[2]==='--stop'?'stop':'start',command:async(args,report)=>{if(args[0]==='--preflight')return keylessPreflight(report,{folder,load:()=>({plan:{client:{path:'/mock'}}}),validate:()=> 'ok',owner:()=> 'absent'});if(args[0]==='--stop')return await stopSession(folder)?0:2;return runSession({directory:folder,config:{},helper:${JSON.stringify(helper)},client:'/mock',profile:'/mock',runtimeFactory:()=>({start:async()=>{},stop:async()=>({clean:true})}),status:report,lifetimeMs:5000});}});`,{mode:0o600});
 writeFileSync(stop,`import {stopSession} from ${JSON.stringify(coreURL)};process.exitCode=await stopSession(${JSON.stringify(dir)})?0:2;`,{mode:0o600});
 writeFileSync(wrapper,launcherText(process.execPath,entry,'start'),{mode:0o700});
 writeFileSync(python,`import os,sys,pty,subprocess,select,time,json,signal
mode,wrapper,node,stop=sys.argv[1:];children=[]
def launch():
 m,s=pty.openpty();p=subprocess.Popen(['/bin/sh',wrapper],stdin=s,stdout=s,stderr=subprocess.DEVNULL,env={'HOME':'/tmp/fail' if mode=='fail' else '/tmp/mock','PATH':'/usr/bin:/bin'},start_new_session=True);os.close(s);children.append((p,m));return [p,m,b'']
def until(c,marker):
 deadline=time.monotonic()+8
 while marker not in c[2]:
  if time.monotonic()>deadline:raise Exception('timeout')
  if select.select([c[1]],[],[],.05)[0]:
   try:data=os.read(c[1],4096)
   except OSError:data=b''
   if not data:
    c[0].wait(timeout=1);raise Exception('early_exit')
   c[2]+=data
   if len(c[2])>32768:raise Exception('overflow')
def close_screen(c):
 until(c,'画面を閉じるにはEnter'.encode());os.write(c[1],b'\\n');return c[0].wait(timeout=3)
try:
 first=launch();other=None
 if mode not in ['missing','import']:
  until(first,'開始する場合だけEnter'.encode());os.write(first[1],b'cancel\\n' if mode=='cancel' else b'\\n')
 if mode not in ['cancel','fail','missing','import']:
  until(first,b'metadata_only_session_started')
  if mode=='double':other=launch();until(other,b'metadata_preflight_existing_lock_stop');assert close_screen(other)==2
  result=subprocess.run([node,stop],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'HOME':'/tmp/mock','PATH':'/usr/bin:/bin'},timeout=3);assert result.returncode==0
  until(first,b'metadata_session_stopped')
 status=close_screen(first)
 combined=first[2]+(other[2] if other else b'')
 print(json.dumps({'mode':mode,'exit':status,'secretVisible':${JSON.stringify(token)}.encode() in combined,'failed':b'metadata_session_failed' in combined,'cancelled':b'metadata_launcher_cancelled_no_start' in combined,'stopped':b'metadata_session_stopped' in combined,'duplicateRefused':b'metadata_preflight_existing_lock_stop' in combined,'bootstrapDenied':b'metadata_launcher_bootstrap_files_unavailable_no_start' in combined,'importDenied':b'metadata_launcher_failed_no_raw_diagnostic' in combined}))
except Exception as error:print(json.dumps({'mockError':type(error).__name__ if type(error).__name__ in ['TypeError','NameError','OSError','AssertionError','TimeoutExpired','AttributeError','ValueError','UnicodeEncodeError','UnboundLocalError','PermissionError','FileNotFoundError'] else 'fixture_failed','childExit':first[0].poll() if 'first' in locals() else None,'bytesSeen':len(first[2]) if 'first' in locals() else 0,'launcherDenied':b'metadata_launcher_denied_no_start' in first[2] if 'first' in locals() else False,'preflightFailed':b'metadata_preflight_failed_no_key_read_no_start' in first[2] if 'first' in locals() else False}));sys.exit(2)
finally:
 for p,m in children:
  if p.poll() is None:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   p.wait()
  os.close(m)
`,{mode:0o600});
 try {
  assert.equal(statSync(wrapper).mode&0o777,0o700);
  assert.equal(spawnSync(process.execPath,['--check',entry],{stdio:'ignore'}).status,0,'fixture_syntax');
  assert.equal(spawnSync('/bin/sh',['-n',wrapper],{stdio:'ignore'}).status,0,'wrapper_syntax');
  const nonTTY=spawnSync('/bin/sh',[wrapper],{encoding:'utf8',stdio:['ignore','pipe','ignore']});assert.equal(nonTTY.status,2);assert.equal(nonTTY.stdout,'metadata_launcher_denied_no_start\n');
  const isolated=join(folder,'isolated-launcher.mjs');copyFileSync(new URL('../scripts/tunnel-launcher.mjs',import.meta.url),isolated);
  for(const mode of ['stop','double','cancel','fail','missing','import']){
   writeFileSync(wrapper,launcherText(process.execPath,mode==='missing'?join(folder,'absent.mjs'):mode==='import'?realpathSync(isolated):entry,'start'),{mode:0o700});
   const result=spawnSync('/usr/bin/python3',[python,mode,wrapper,process.execPath,stop],{encoding:'utf8',timeout:15000,maxBuffer:4096,stdio:['ignore','pipe','ignore']});
   assert.equal(result.status,0,'mock_pty_failed '+result.stdout);let data;try{data=JSON.parse(result.stdout);}catch{assert.fail('mock_pty_result_unavailable');}
   assert.equal(data.secretVisible,false);assert.equal(data.exit,['cancel','fail','missing','import'].includes(mode)?2:0);
   assert.equal(data.stopped,mode==='stop'||mode==='double');assert.equal(data.cancelled,mode==='cancel');assert.equal(data.failed,mode==='fail');assert.equal(data.duplicateRefused,mode==='double');
   assert.equal(data.bootstrapDenied,mode==='missing');assert.equal(data.importDenied,mode==='import');
   assert.equal(existsSync(join(dir,'run')),false);
  }
 }finally{rmSync(folder,{recursive:true,force:true});}
});
