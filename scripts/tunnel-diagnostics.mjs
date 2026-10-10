import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const cleanEnvironment=()=>({PATH:'/usr/bin:/bin',HOME:homedir()});

const stages=new Set([
 'tunnel_helper_started','tunnel_helper_core_limit_failed','tunnel_helper_terminal_required','tunnel_helper_reference_unconfigured',
 'tunnel_keychain_lookup_started','tunnel_keychain_lookup_complete','tunnel_keychain_data_type_invalid',
 'tunnel_credential_format_invalid','tunnel_start_cancelled_before_client','tunnel_credential_pipe_failed',
 'tunnel_client_spawn_setup_failed','tunnel_client_spawn_started','tunnel_client_spawn_failed_not_found',
 'tunnel_client_spawn_failed_permission','tunnel_client_spawn_failed_executable','tunnel_client_spawn_failed_other',
 'tunnel_credential_handoff_failed','tunnel_credential_handoff_complete','tunnel_client_wait_failed',
 'tunnel_client_cleanup_started','tunnel_client_cleanup_forced','tunnel_client_cleanup_complete'
]);
for(const stage of ['open','lookup'])for(const reason of ['item_not_found','auth_failed','user_cancelled','interaction_not_allowed','not_available','invalid_parameter','other'])stages.add(`tunnel_keychain_${stage}_failed_${reason}`);
export function createDiagnosticDecoder({report,onClientPid=()=>{},onHandoff=()=>{},invalid=()=>{}}) {
 let buffer='',total=0,lines=0,denied=false;
 const reject=()=>{if(denied)return;denied=true;buffer='';report('metadata_helper_diagnostic_invalid');invalid();};
 return chunk=>{
  if(denied)return;total+=chunk.length;
  if(total>4096||!Buffer.isBuffer(chunk)||chunk.some(b=>b!==10&&(b<32||b>126))){reject();return;}
  buffer+=chunk.toString('ascii');
  while(buffer.includes('\n')){
   const split=buffer.indexOf('\n'),line=buffer.slice(0,split);buffer=buffer.slice(split+1);
   if(++lines>64||line.length>96){reject();return;}
   let pid,exit,signal;
   if(stages.has(line)){report(line);if(line==='tunnel_credential_handoff_complete')onHandoff();}
   else if((pid=/^tunnel_client_pid_([1-9][0-9]{0,8})$/.exec(line))){report(line);onClientPid(Number(pid[1]));}
   else if((exit=/^tunnel_client_exit_code_([0-9]{1,3})$/.exec(line))&&Number(exit[1])<=255)report(line);
   else if((signal=/^tunnel_client_exit_signal_([1-9][0-9]?)$/.exec(line))&&Number(signal[1])<64)report(line);
   else {reject();return;}
  }
  if(buffer.length>96)reject();
 };
}
// Reference syntax only: no secret resolution or runtime startup validation.
// A consumable pipe must appear only in the native CLI, never also in YAML.
export function validateClientProfile(client,profile,runDirectory,invoke=spawnSync) {
 const result=invoke(client,['profiles','add','metadata-diagnostic-check','--from-file',profile,'--profile-dir',join(runDirectory,'validated')],{
  env:cleanEnvironment(),shell:false,stdio:'ignore',timeout:5000
 });
 return result.error?'spawn_or_timeout':result.status===0?'ok':'rejected';
}
export function listenerOwner(port,invoke=spawnSync) {
 // Fixed port only; never request argv/environment or unrelated process listings.
 if(port!==43125&&port!==43126)return 'unknown';
 const result=invoke('/usr/sbin/lsof',['-nP','-iTCP:'+port,'-sTCP:LISTEN','-Fp'],{env:cleanEnvironment(),encoding:'ascii',timeout:1000,maxBuffer:4096,stdio:['ignore','pipe','ignore']});
 if(result.error)return 'unknown';
 if(result.status===1&&result.stdout==='')return 'absent';
 if(result.status!==0)return 'unknown';
 const pids=result.stdout.split('\n').filter(x=>/^p[1-9][0-9]{0,8}$/.test(x)).map(x=>Number(x.slice(1)));
 return pids.length===1?pids[0]:'unknown';
}
export function healthStatus(path,signal) {
 // Only status codes are retained; discard all body/header/error data.
 if(path!=='/healthz'&&path!=='/readyz')return Promise.resolve('unavailable');
 return new Promise(resolve=>{
  let done=false,req;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);req?.destroy();resolve(value);};
  const timer=setTimeout(()=>finish('timeout'),1000);
  if(signal?.aborted){finish('cancelled');return;}
  try {
   req=request({host:'127.0.0.1',port:43126,path,method:'GET',agent:false,signal,headers:{Connection:'close'}},response=>{
    const code=response.statusCode;response.destroy();finish(code===200?'ok':code===503?'gated':code>=300&&code<400?'redirect_denied':'rejected');
   });
   req.on('error',()=>finish(signal?.aborted?'cancelled':'unavailable'));req.end();
  }catch{finish('unavailable');}
 });
}
export async function probeClientHealth(pid,signal) {
 const owner=listenerOwner(43126);
 if(owner==='absent')return 'listener_absent';
 if(owner==='unknown')return 'ownership_unknown';
 if(owner!==pid)return 'listener_owner_mismatch';
 const live=await healthStatus('/healthz',signal);
 if(live!=='ok')return live==='redirect_denied'?'redirect_denied':'health_unavailable';
 const ready=await healthStatus('/readyz',signal);
 return ready==='ok'?'local_ready':ready==='gated'?'local_gated':ready==='redirect_denied'?'redirect_denied':'health_unavailable';
}
