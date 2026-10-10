import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { createDiagnosticDecoder,cleanEnvironment } from './tunnel-diagnostics.mjs';

export {cleanEnvironment};
export const controlSocket=directory=>join(directory,'run','s');
const guardianSignals=new Set(['SIGTERM','SIGINT','SIGHUP','SIGKILL','SIGALRM','SIGABRT','SIGSEGV','SIGPIPE']);
const healthStates=new Set(['listener_absent','ownership_unknown','listener_owner_mismatch','health_unavailable','redirect_denied','local_ready','local_gated']);
// Injectable module hooks are test seams; operator CLI accepts no overrides.
export async function runSession({directory,config,runtimeFactory,client,helper,profile,lifetimeMs=900000,launch=spawn,signals=process,status=()=>{},preflight,healthProbe,healthTimeoutMs=30000,healthIntervalMs=500}) {
 const runDirectory=join(directory,'run'),socket=controlSocket(directory);
 let own=false,server,runtime,child,control,timer,finishResolve;
 let stopping=false,childDone=false,stage='session_lock',clientPid,healthTask;
 const connections=new Set(),healthAbort=new AbortController();let finalCode=0;
 const finished=new Promise(resolve=>{finishResolve=resolve;});
 const report=s=>{try{status(s);}catch{/* Diagnostics cannot prevent cleanup. */}};
 const requestStop=(code=0)=>{if(stopping)return;stopping=true;finalCode=code;healthAbort.abort();finishResolve();};
 const signal=()=>requestStop();
 const startHealth=()=>{
  if(!healthProbe||healthTask||stopping)return;
  if(!clientPid){report('metadata_client_pid_missing');requestStop(2);return;}
  healthTask=(async()=>{
   report('metadata_client_health_check_started');let previous='';const deadline=Date.now()+healthTimeoutMs;
   while(!stopping){
    const remaining=deadline-Date.now();
    if(remaining<=0){report('metadata_client_health_timeout');requestStop(2);return;}
    const probeSignal=AbortSignal.any([healthAbort.signal,AbortSignal.timeout(remaining)]);
    let state,release;
    const cancelled=new Promise(resolve=>{const abort=()=>resolve('health_unavailable');release=()=>probeSignal.removeEventListener('abort',abort);probeSignal.addEventListener('abort',abort,{once:true});if(probeSignal.aborted)abort();});
    try{state=await Promise.race([Promise.resolve().then(()=>healthProbe(clientPid,probeSignal)).catch(()=>'health_unavailable'),cancelled]);}
    finally{release();}
    if(stopping)return;
    // Readiness after the deadline is never accepted, even if a probe ignores abort.
    if(Date.now()>=deadline||probeSignal.aborted){report('metadata_client_health_timeout');requestStop(2);return;}
    if(!healthStates.has(state))state='health_unavailable';
    if(state!==previous){report('metadata_client_'+state);previous=state;}
    if(state==='local_ready'){report('metadata_client_local_ready_does_not_prove_auth_or_dot_wake');return;}
    if(state==='listener_owner_mismatch'){requestStop(2);return;}
    if(Date.now()>=deadline){report('metadata_client_health_timeout');requestStop(2);return;}
    await new Promise(resolve=>{const tick=setTimeout(done,Math.min(healthIntervalMs,Math.max(1,deadline-Date.now())));function done(){clearTimeout(tick);healthAbort.signal.removeEventListener('abort',done);resolve();}healthAbort.signal.addEventListener('abort',done,{once:true});if(healthAbort.signal.aborted)done();});
   }
  })();
 };
 try {
  if(Buffer.byteLength(socket)>100)throw new Error('socket_path_limit');
  mkdirSync(runDirectory,{mode:0o700});own=true;report('metadata_session_lock_acquired');stage='control_listener';
  server=createServer(connection=>{
   connections.add(connection);connection.on('close',()=>connections.delete(connection));
   let bytes=0,text='';connection.setTimeout(1000,()=>connection.destroy());connection.on('error',()=>{});
   connection.on('data',data=>{bytes+=data.length;if(bytes>16){connection.destroy();return;}text+=data.toString('ascii');if(text==='STOP\n'){connection.end('STOPPING\n');requestStop();}});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});
  chmodSync(socket,0o600);server.on('error',()=>{report('metadata_control_listener_failed');requestStop(2);});
  signals.on('SIGINT',signal);signals.on('SIGTERM',signal);signals.on('SIGHUP',signal);
  timer=setTimeout(()=>{report('metadata_session_time_limit');requestStop();},lifetimeMs);
  if(preflight){stage='client_config';report('metadata_client_config_check_started');if(await preflight({client,profile,runDirectory,report})!==true)throw new Error('preflight');report('metadata_client_config_check_passed');}
  stage='metadata_listener';report('metadata_listener_start_requested');runtime=runtimeFactory(config);await runtime.start(true);report('metadata_listener_started_mcp_events_denied');
  if(!stopping){
   stage='helper_launch';report('metadata_helper_launch_requested');
   child=launch(helper,['--client',client,'--config',profile],{shell:false,env:cleanEnvironment(),stdio:['inherit','ignore','ignore','pipe']});
   child.on('error',()=>{report('metadata_helper_launch_failed');requestStop(2);});
   child.on('spawn',()=>report('metadata_helper_process_spawned'));
   child.on('close',(code,exitSignal)=>{
    childDone=true;
    if(Number.isInteger(code)&&code>=0&&code<=255)report('metadata_guardian_exit_code_'+code);
    else report('metadata_guardian_exit_signal_'+(guardianSignals.has(exitSignal)?exitSignal:'other'));
    if(!stopping){report('metadata_client_or_helper_ended_before_user_stop');requestStop(2);}
   });
   control=child.stdio[3];if(!control||typeof control.write!=='function')throw new Error('control_unavailable');
   control.on('data',createDiagnosticDecoder({report,onClientPid:pid=>{clientPid=pid;},onHandoff:startHealth,invalid:()=>requestStop(2)}));
   control.on('error',()=>{report('metadata_helper_control_failed');requestStop(2);});control.write('START\n');
   report('metadata_only_session_started');await finished;
  }
 }catch{finalCode=2;report('metadata_start_failed_stage_'+stage);report('metadata_session_start_failed');}
 finally{
  stopping=true;healthAbort.abort();if(timer)clearTimeout(timer);
  signals.removeListener('SIGINT',signal);signals.removeListener('SIGTERM',signal);signals.removeListener('SIGHUP',signal);
  report('metadata_cleanup_started');try{control?.end();}catch{}
  if(child&&!childDone)await new Promise(resolve=>{
   let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(warning);clearTimeout(bound);resolve();};child.once('close',finish);
   const warning=setTimeout(()=>{report('metadata_guardian_stop_requested');try{child.kill('SIGTERM');}catch{}},4000);
   const bound=setTimeout(()=>{finalCode=2;report('metadata_stop_pending');finish();},8000);
  });
  // Each health request is bounded and abortable; no raw data is retained.
  if(healthTask)await healthTask;
  try{if(runtime){const result=await runtime.stop();report(result.clean?'metadata_listener_stopped':'metadata_listener_cleanup_pending');if(!result.clean)finalCode=2;}}catch{finalCode=2;report('metadata_listener_cleanup_failed');}
  if(server){for(const connection of connections)connection.destroy();await new Promise(resolve=>server.close(resolve));}
  if(own&&(!child||childDone)){try{rmSync(runDirectory,{recursive:true,force:true});report('metadata_session_lock_released');}catch{finalCode=2;report('metadata_session_lock_cleanup_failed');}}
  report(finalCode===0?'metadata_session_stopped':'metadata_session_failed');
 }
 return finalCode;
}
export async function stopSession(directory){
 return new Promise(resolve=>{
  const socket=createConnection(controlSocket(directory));let settled=false,ack='';
  const finish=ok=>{if(settled)return;settled=true;socket.destroy();resolve(ok);};
  socket.setTimeout(1500,()=>finish(false));socket.on('error',()=>finish(false));
  socket.on('connect',()=>socket.write('STOP\n'));socket.on('data',data=>{ack+=data.toString('ascii');if(ack.length>16||!('STOPPING\n'.startsWith(ack)))finish(false);else if(ack==='STOPPING\n')finish(true);});socket.on('end',()=>finish(false));
 });
}
