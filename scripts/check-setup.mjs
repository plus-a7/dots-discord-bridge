// Public checkout checks only. No env/private config/credential reads, network,
// listener, login, native helper execution, or install is performed.
import { readSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const publicStat=relative=>{
  const parts=relative.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('public_file_denied');let parent=root;
  for(const part of parts.slice(0,-1)) {parent=join(parent,part);const directory=lstatSync(parent);if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('public_file_denied');}
  const path=join(root,relative),s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||realpathSync(path)!==path)throw new Error('public_file_denied');
  return {path,s};
};
const regular=relative=>{try {publicStat(relative);return true;}catch{return false;}};
const publicText=relative=>{
  const {path,s}=publicStat(relative);if(s.size>65536)throw new Error('public_file_denied');let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==s.dev||opened.ino!==s.ino||opened.size>65536)throw new Error('public_file_denied');
    const bytes=Buffer.alloc(65537);let size=0;
    while(size<bytes.length) {const count=readSync(fd,bytes,size,bytes.length-size,null);if(!count)break;size+=count;}
    if(size>65536)throw new Error('public_file_denied');return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));
  } finally {if(fd!==undefined)closeSync(fd);}
};
const json=relative=>JSON.parse(publicText(relative));
const allowedPackages=new Set(['@modelcontextprotocol/server','discord.js','standardwebhooks','zod','@types/node','typescript']);
const [major,minor]=process.versions.node.split('.').map(Number);
const checks={arguments:process.argv.length===2,node:major>24||major===24&&minor>=20,macOS:process.platform==='darwin',dependencies:false,swiftCompiler:false,jsBuild:regular('dist/src/main.js'),nativeBuild:regular('dist/native/keychain-reader'),disabledTemplates:false};
try {
  const p=json('package.json'),dependencies=Object.entries({...p.dependencies,...p.devDependencies});checks.dependencies=dependencies.length===allowedPackages.size&&dependencies.every(([name,version])=>{
    if(!allowedPackages.has(name)||typeof version!=='string')return false;
    const relative='node_modules/'+name+'/package.json';return regular(relative)&&json(relative).version===version;
  });
  checks.disabledTemplates=['deployment.example.json','deployment.cloudflare.example.json'].every(relative=>{
    if(!regular(relative))return false;const p=json(relative);
    return p.version===2&&p.enabled===false&&p.bridge===null&&p.authentication?.policy===null&&p.http?.port===null&&['exclusiveBotOwnership','ownerIdentity','messageContentIntent'].every(name=>p.confirmations?.[name]===false);
  });
  const setup=json('oauth-setup.example.json');
  checks.disabledTemplates=checks.disabledTemplates&&setup.version===1&&setup.mode==='oauth_setup'&&setup.enabled===false&&setup.oauth===null&&setup.http?.kind==='tunnel_loopback'&&setup.http?.port===null;
  if(checks.macOS) {
    const probe=spawnSync('/usr/bin/xcrun',['--find','swiftc'],{cwd:root,env:{PATH:'/usr/bin:/bin'},stdio:'ignore',timeout:5000});
    checks.swiftCompiler=!probe.error&&probe.status===0;
  }
} catch {/* Fixed diagnostics only. Never print raw errors or paths. */}
let sourceLicense='review_required';
try {if(publicText('LICENSE').startsWith('No public license has been selected'))sourceLicense='unselected';}catch{}
const offlineReady=Object.values(checks).every(Boolean);
process.stdout.write(JSON.stringify({checks,offlineReady,liveReady:false,sourceLicense,scope:'public-checkout-only',next:offlineReady?'run_tests_then_review_docs_morning':'see_docs_setup'})+'\n');
process.exitCode=offlineReady?0:2;
