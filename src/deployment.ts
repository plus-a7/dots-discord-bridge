import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, dirname } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { configSchema } from './core.js';
import { authenticationSchema } from './auth-factory.js';

const absolute=z.string().max(4096).refine(p=>isAbsolute(p)&&normalize(p)===p&&!p.includes('\0'));
const reference=z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
export const credentialSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('keychain'),service:reference,account:reference,timeoutMs:z.number().int().min(50).max(3000).default(2000)}).strict(),
  z.object({kind:z.literal('private_file')}).strict()
]);
const port=z.number().int().min(1024).max(65535);
export const ingressSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('forwarded_https'),host:z.string().min(1).max(253),port}).strict(),
  z.object({kind:z.literal('tunnel_loopback'),port}).strict()
]);
const schema=z.object({version:z.literal(2),enabled:z.literal(true),confirmations:z.object({exclusiveBotOwnership:z.literal(true),ownerIdentity:z.literal(true),messageContentIntent:z.literal(true)}).strict(),
  bridge:configSchema,authentication:authenticationSchema,credential:credentialSchema,privateDirectory:absolute,ownershipDirectory:absolute,http:ingressSchema,
  callbackHosts:z.array(z.string().min(1).max(253)).min(1).max(4),loginTimeoutMs:z.number().int().min(50).max(30000).default(15000),drainTimeoutMs:z.number().int().min(10).max(30000).default(10000)}).strict();
export type Deployment=z.output<typeof schema>;
function hostname(host:string) {const u=new URL('https://'+host);return u.hostname===host&&u.host===host&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&!isIP(host)&&/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);}
export function parseDeployment(raw:unknown):Deployment {
  try {
    if(!raw||typeof raw!=='object'||(raw as {enabled?:unknown}).enabled!==true)throw new Error('disabled');
    const p=schema.parse(raw),issuer=new URL(p.authentication.policy.issuer);
    if(p.bridge.mode!=='guild_owner'||p.authentication.policy.principal!==p.bridge.principal||(p.http.kind==='forwarded_https'&&!hostname(p.http.host))||p.callbackHosts.some(h=>!hostname(h))||new Set(p.callbackHosts).size!==p.callbackHosts.length||!hostname(issuer.hostname))throw new Error('invalid');
    if(p.authentication.kind==='cloudflare_access'&&(p.http.kind!=='forwarded_https'||issuer.origin!==p.authentication.policy.issuer||issuer.pathname!=='/'||issuer.port||issuer.username||issuer.password||issuer.search||issuer.hash))throw new Error('invalid');
    return freeze(p); // No settings/paths/secrets are included in diagnostics.
  } catch {throw new Error('deployment_disabled_or_incomplete');}
}
export function assertPrivateDirectory(directory:string) {
  try {
    const s=lstatSync(directory);
    if(!isAbsolute(directory)||realpathSync(directory)!==directory||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700)throw new Error('invalid');
  } catch {throw new Error('private_directory_denied');}
}
export function assertPrivateState(path:string) {
  // SQLite opens filenames rather than our O_NOFOLLOW descriptor. Reject
  // existing aliased/foreign leaves, including all fixed auxiliary filenames.
  // Same-UID concurrent path replacement remains an OS-account boundary.
  for(const base of [path,path+'.lock.sqlite'])for(const suffix of ['','-journal','-wal','-shm']) {
    try {const s=lstatSync(base+suffix);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)throw new Error('invalid');}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('private_state_denied');}
  }
}
function readBoundedFile(path:string,privateFile:boolean,maxBytes:number) {
  let fd:number|undefined;
  try {
    if(!isAbsolute(path)||normalize(path)!==path)throw new Error('invalid');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const s=fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.size>maxBytes||(privateFile&&(s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)))throw new Error('invalid');
    const buffer=Buffer.alloc(maxBytes+1);let size=0;
    while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
    if(size>maxBytes)throw new Error('invalid');return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
  } catch {throw new Error('private_file_denied');}finally {if(fd!==undefined)closeSync(fd);}
}
export function readPrivateToken(directory:string) {
  assertPrivateDirectory(directory);
  const token=readBoundedFile(join(directory,'discord-bot.token'),true,512).trim();
  if(!/^[A-Za-z0-9_.-]{32,256}$/.test(token)||token.startsWith('mfa.'))throw new Error('private_file_denied');return token;
}
export function readDeploymentFile(path:string,privateFile=true) {
  try {if(privateFile)assertPrivateDirectory(dirname(path));return JSON.parse(readBoundedFile(path,privateFile,65536)) as unknown;}catch {throw new Error('deployment_file_denied');}
}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
