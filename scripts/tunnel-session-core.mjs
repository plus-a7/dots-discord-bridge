import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { homedir } from 'node:os';

export const cleanEnvironment=()=>({PATH:'/usr/bin:/bin',HOME:homedir()});
export const controlSocket=directory=>join(directory,'run','s');
// Injectable only as a module for tests; the operator CLI exposes no overrides.
export async function runSession({directory,config,runtimeFactory,client,helper,profile,lifetimeMs=900000,launch=spawn,signals=process,status=()=>{}}) {
  const runDirectory=join(directory,'run'),socket=controlSocket(directory);
  let own=false,server,runtime,child,control,timer,finishResolve;
  let stopping=false,childDone=false;const connections=new Set();
  let finalCode=0;
  const finished=new Promise(resolve=>{finishResolve=resolve;});
  const report=s=>{try{status(s);}catch{/* Diagnostics cannot prevent cleanup. */}};
  const requestStop=(code=0)=>{if(stopping)return;stopping=true;finalCode=code;finishResolve();};
  const signal=()=>requestStop();
  try {
    if(Buffer.byteLength(socket)>100)throw new Error('socket_path_limit');
    mkdirSync(runDirectory,{mode:0o700});own=true;
    server=createServer(connection=>{
      connections.add(connection);connection.on('close',()=>connections.delete(connection));
      let bytes=0,text='';connection.setTimeout(1000,()=>connection.destroy());
      connection.on('error',()=>{});
      connection.on('data',data=>{bytes+=data.length;if(bytes>16){connection.destroy();return;}text+=data.toString('ascii');if(text==='STOP\n'){connection.end('STOPPING\n');requestStop();}});
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});});
    chmodSync(socket,0o600);server.on('error',()=>requestStop(2));
    signals.on('SIGINT',signal);signals.on('SIGTERM',signal);signals.on('SIGHUP',signal);
    timer=setTimeout(()=>{report('metadata_session_time_limit');requestStop();},lifetimeMs);
    runtime=runtimeFactory(config);await runtime.start(true);
    if(!stopping) {
      child=launch(helper,['--client',client,'--config',profile],{shell:false,env:cleanEnvironment(),stdio:['inherit','ignore','ignore','pipe']});
      child.on('error',()=>requestStop(2));
      child.on('close',code=>{childDone=true;requestStop(code===0?0:2);});
      control=child.stdio[3];
      if(!control||typeof control.write!=='function')throw new Error('control_unavailable');
      control.on('error',()=>requestStop(2));control.write('START\n');
      report('metadata_only_session_started');
      await finished;
    }
  } catch {finalCode=2;report('metadata_session_start_failed');}
  finally {
    stopping=true;if(timer)clearTimeout(timer);
    signals.removeListener('SIGINT',signal);signals.removeListener('SIGTERM',signal);signals.removeListener('SIGHUP',signal);
    // Closing the pipe tells the native guardian to terminate its client group.
    // Parent crashes also close this descriptor automatically.
    try{control?.end();}catch{}
    if(child&&!childDone)await new Promise(resolve=>{
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(warning);clearTimeout(bound);resolve();};
      child.once('close',finish);
      // During an interactive Keychain prompt no client has spawned yet. A TERM
      // requests cancellation; native cleanup still owns any spawned client.
      const warning=setTimeout(()=>{try{child.kill('SIGTERM');}catch{}},4000);
      const bound=setTimeout(()=>{finalCode=2;report('metadata_stop_pending');finish();},8000);
    });
    try{if(runtime){const result=await runtime.stop();if(!result.clean)finalCode=2;}}catch{finalCode=2;}
    if(server){for(const connection of connections)connection.destroy();await new Promise(resolve=>server.close(resolve));}
    if(own&&(!child||childDone)){try{rmSync(runDirectory,{recursive:true,force:true});}catch{finalCode=2;}}
    report(finalCode===0?'metadata_session_stopped':'metadata_session_failed');
  }
  return finalCode;
}
export async function stopSession(directory) {
  return new Promise(resolve=>{
    const socket=createConnection(controlSocket(directory));let settled=false,ack='';
    const finish=ok=>{if(settled)return;settled=true;socket.destroy();resolve(ok);};
    socket.setTimeout(1500,()=>finish(false));socket.on('error',()=>finish(false));
    socket.on('connect',()=>socket.write('STOP\n'));socket.on('data',data=>{ack+=data.toString('ascii');if(ack.length>16||!('STOPPING\n'.startsWith(ack)))finish(false);else if(ack==='STOPPING\n')finish(true);});
    socket.on('end',()=>finish(false));
  });
}
