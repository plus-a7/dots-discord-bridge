import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { credentialSchema } from './deployment.js';

// Only reference names enter argv. No security(1), shell, environment secret,
// stdout/stderr capture, fallback source, interactive unlock, or write operation.
export type KeychainSpawn=(executable:string,args:readonly string[],options:SpawnOptions)=>ChildProcess;
const helper=fileURLToPath(new URL('../native/keychain-reader',import.meta.url));
const nativeSpawn:KeychainSpawn=(executable,args,options)=>{
  if(process.platform!=='darwin')throw new Error('keychain_denied');
  const s=lstatSync(executable);
  if(realpathSync(executable)!==executable||!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o022)!==0||(s.mode&0o100)===0)throw new Error('keychain_denied');
  return spawn(executable,[...args],options);
};
export async function readKeychainToken(raw:unknown,signal:AbortSignal,launch:KeychainSpawn=nativeSpawn):Promise<string> {
  let ref;
  try {ref=credentialSchema.parse(raw);if(ref.kind!=='keychain'||signal.aborted)throw new Error('denied');}catch {throw new Error('keychain_denied');}
  return new Promise((resolve,reject)=>{
    let child:ChildProcess|undefined,pipe:Readable|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    let done=false,ended=false,size=0,chunks=0;
    const bytes=Buffer.alloc(256);
    const finish=(ok=false)=>{
      if(done)return;done=true;
      if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);
      try {
        if(ok&&!signal.aborted&&ended&&size>=32){
          // ASCII token validation before creating the SDK-required string.
          for(let i=0;i<size;i++){const b=bytes[i]!;if(!((b>=48&&b<=57)||(b>=65&&b<=90)||(b>=97&&b<=122)||b===45||b===46||b===95))throw new Error('denied');}
          const token=bytes.subarray(0,size).toString('ascii');if(token.startsWith('mfa.'))throw new Error('denied');resolve(token);return;
        }
        throw new Error('denied');
      }catch {try {child?.kill('SIGKILL');}catch {}pipe?.destroy();reject(new Error('keychain_denied'));}
      finally {bytes.fill(0);}
    };
    const abort=()=>finish();
    signal.addEventListener('abort',abort,{once:true});
    try {
      if(signal.aborted){finish();return;}
      child=launch(helper,['--service',ref.service,'--account',ref.account,'--no-ui'],{
        shell:false,stdio:['ignore','ignore','ignore','pipe'],
        // No inherited credentials, DYLD injection or configurable helper path.
        env:{PATH:'/usr/bin:/bin'},windowsHide:true
      });
      pipe=child.stdio[3] as Readable|undefined;
      child.on('error',()=>finish());child.on('close',(code,exitSignal)=>finish(code===0&&exitSignal===null));
      if(!pipe||typeof pipe.on!=='function')throw new Error('missing_pipe');
      pipe.on('error',()=>finish());
      pipe.on('data',(chunk:Buffer)=>{
        if(done){if(Buffer.isBuffer(chunk))chunk.fill(0);return;}
        if(!Buffer.isBuffer(chunk)||++chunks>32||size+chunk.length>bytes.length){if(Buffer.isBuffer(chunk))chunk.fill(0);finish();return;}
        chunk.copy(bytes,size);size+=chunk.length;chunk.fill(0);
      });
      pipe.on('end',()=>{ended=true;});
      timer=setTimeout(abort,ref.timeoutMs);
      if(signal.aborted)finish();
    }catch {finish();}
  });
}
