import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync,writeFileSync,chmodSync,symlinkSync,linkSync,unlinkSync,mkdirSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LoginBootstrap } from '../src/bootstrap.js';
import { parseDeployment,readPrivateToken,readDeploymentFile } from '../src/deployment.js';
import { runCommand } from '../src/cli.js';
import { folders,settings,dummyToken,fixture } from './bootstrap-fixture.js';

test('disabled/incomplete/unsupported deployment and missing activation do no credential/client/lease work',async()=>{
  const paths=folders(),valid=settings(paths);let calls=0;
  try {
    const template=JSON.parse(readFileSync('deployment.example.json','utf8'));
    for(const raw of [template,{...valid,enabled:false},{...valid,bridge:null},{...valid,confirmations:{...valid.confirmations,exclusiveBotOwnership:false}},{...valid,authentication:{...valid.authentication,policy:{...valid.authentication.policy,issuer:'https://issuer.example.test:8443'}}},{...valid,authentication:{...valid.authentication,policy:{...valid.authentication.policy,issuer:'http://issuer.example.test'}}},{...valid,bridge:{...valid.bridge,mode:'fixed_cases'}},{...valid,authentication:{...valid.authentication,policy:{...valid.authentication.policy,principal:'other'}}},{...valid,http:{...valid.http,host:'127.0.0.1'}}])assert.throws(()=>new LoginBootstrap(raw,{createClient:()=>{calls++;return null as any;},readToken:async()=>{calls++;return dummyToken;}}),{message:'deployment_disabled_or_incomplete'});
    const boot=new LoginBootstrap(valid,{createClient:()=>{calls++;return null as any;},readToken:async()=>{calls++;return dummyToken;}});await assert.rejects(()=>boot.start(),/activation_required/);assert.equal(calls,0);assert.deepEqual(readdirSync(paths.privateDirectory),[]);assert.deepEqual(readdirSync(paths.ownershipDirectory),[]);await boot.stop();
    const parsed=parseDeployment(valid);assert.ok(Object.isFrozen(parsed)&&Object.isFrozen(parsed.bridge));
  } finally {paths.cleanup();}
});
test('explicit token file reader accepts only owner600 regular bounded file in canonical owner700 directory',()=>{
  const paths=folders(),file=join(paths.privateDirectory,'discord-bot.token'),target=join(paths.root,'dummy-other-file');
  try {
    writeFileSync(file,dummyToken+'\n',{mode:0o600});assert.equal(readPrivateToken(paths.privateDirectory),dummyToken);
    chmodSync(file,0o644);assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);chmodSync(file,0o600);
    chmodSync(paths.privateDirectory,0o755);assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_directory_denied/);chmodSync(paths.privateDirectory,0o700);
    writeFileSync(file,'x'.repeat(513));assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);
    writeFileSync(file,'mfa.'+'x'.repeat(40));assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);
    unlinkSync(file);writeFileSync(target,dummyToken,{mode:0o600});symlinkSync(target,file);assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);unlinkSync(file);
    linkSync(target,file);assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);unlinkSync(file);
    mkdirSync(file);assert.throws(()=>readPrivateToken(paths.privateDirectory),/private_file_denied/);
  } finally {paths.cleanup();}
});
test('settings reader is bounded/owner-private for run and never returns raw parse errors',()=>{
  const paths=folders(),file=join(paths.privateDirectory,'deployment.json');
  try {
    writeFileSync(file,JSON.stringify(settings(paths)),{mode:0o600});assert.ok(parseDeployment(readDeploymentFile(file)));
    chmodSync(file,0o644);assert.throws(()=>readDeploymentFile(file),{message:'deployment_file_denied'});chmodSync(file,0o600);
    writeFileSync(file,'private-mock-body-invalid');assert.throws(()=>readDeploymentFile(file),{message:'deployment_file_denied'});
    writeFileSync(file,'x'.repeat(65537));assert.throws(()=>readDeploymentFile(file),{message:'deployment_file_denied'});
  } finally {paths.cleanup();}
});
test('aliased existing SQLite state/lock/journal leaves are rejected before client or secret and target stays untouched',async()=>{
  for(const suffix of ['','.lock.sqlite','-journal','.lock.sqlite-wal']) {
    const f=fixture(),target=join(f.paths.root,'unrelated-dummy-file'),leaf=join(f.paths.privateDirectory,'state.sqlite'+suffix);const boot=f.create();
    try {writeFileSync(target,'do not mutate mock target',{mode:0o600});symlinkSync(target,leaf);await assert.rejects(()=>boot.start(true),/bootstrap_start_failed/);await boot.stop();assert.equal(f.clients(),0);assert.equal(f.reads(),0);assert.equal(readFileSync(target,'utf8'),'do not mutate mock target');assert.deepEqual(readdirSync(f.paths.ownershipDirectory),[]);}
    finally {await boot.stop();f.paths.cleanup();}
  }
});
test('CLI requires explicit run activation before reading settings; check is static and templates safely refuse startup',async()=>{
  let reads=0,starts=0;const status:string[]=[];const paths=folders();
  try {
    const io={readConfig:()=>{reads++;return settings(paths);},createBootstrap:()=>{starts++;return null as any;},status:(s:string)=>status.push(s)};
    assert.equal(await runCommand(['run','--config','/unused/template.json'],io),2);assert.equal(reads,0);assert.equal(starts,0);
    assert.equal(await runCommand(['check','--config','/unused/template.json'],io),0);assert.equal(reads,1);assert.equal(starts,0);assert.equal(status.at(-1),'configuration_valid_not_started');
    for(const args of [[],['check','--config',resolve('deployment.example.json')],['run','--config',resolve('deployment.example.json'),'--activate']]) {
      const child=spawnSync(process.execPath,['dist/src/main.js',...args],{encoding:'utf8',timeout:2000});assert.equal(child.status,2);assert.match(child.stdout,/arguments_or_activation_required|deployment_disabled_or_incomplete/);assert.equal(child.stderr,'');
    }
    const child=spawnSync(process.execPath,['--input-type=module','-e',"import {makeClient} from './dist/src/discord.js'; try{makeClient()}catch{console.log('environment_conflict')}"],{env:{PATH:process.env.PATH,DISCORD_TOKEN:dummyToken},encoding:'utf8',timeout:2000});assert.equal(child.status,0);assert.equal(child.stdout.trim(),'environment_conflict');
    const imported=spawnSync(process.execPath,['--input-type=module','-e',"await import('./dist/src/main.js');console.log('import_only')"],{encoding:'utf8',timeout:2000});assert.equal(imported.status,0);assert.equal(imported.stdout.trim(),'import_only');assert.equal(imported.stderr,'');
  } finally {paths.cleanup();}
});
test('CLI repeated termination requests idempotent drain, removes signal handlers and hides raw errors',async()=>{
  const paths=folders(),signals=new EventEmitter(),status:string[]=[];let ready!:()=>void,stops=0;const gate=new Promise<void>(r=>ready=r);
  try {
    const pending=runCommand(['run','--config','/mock/approved.json','--activate'],{readConfig:()=>settings(paths),signals,status:s=>status.push(s),createBootstrap:()=>({start:async()=>{ready();return 1234;},stop:async()=>{stops++;return {clean:true,pending:false};}})});
    await gate;await new Promise(r=>setImmediate(r));signals.emit('SIGTERM');signals.emit('SIGINT');assert.equal(await pending,0);assert.equal(stops,2); // signal stop and final idempotent drain
    assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(status.at(-1),'bridge_stopped');
    const failure=await runCommand(['run','--config','/mock/approved.json','--activate'],{readConfig:()=>settings(paths),signals,status:s=>status.push(s),createBootstrap:()=>({start:async()=>{throw new Error(dummyToken);},stop:async()=>({clean:true,pending:false})})});assert.equal(failure,1);assert.equal(status.join('\n').includes(dummyToken),false);
  } finally {paths.cleanup();}
});
test('CLI can exit its own process on termination even if startup never settles, without reporting clean',async()=>{
  const paths=folders(),signals=new EventEmitter();let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const status:string[]=[];
  try {
    const pending=runCommand(['run','--config','/mock/approved.json','--activate'],{readConfig:()=>settings(paths),signals,status:s=>status.push(s),createBootstrap:()=>({start:async()=>{entered();await new Promise(()=>{});return 1;},stop:async()=>({clean:false,pending:true})})});await ready;signals.emit('SIGTERM');assert.equal(await pending,1);assert.equal(status.at(-1),'bridge_stop_pending_process_exit_required');
  } finally {paths.cleanup();}
});
test('LaunchAgent is an unregistered disabled template without environment secrets or automatic restart',()=>{
  const file=resolve('deploy/local.discord-dot-bridge.plist.example'),result=spawnSync('/usr/bin/plutil',['-lint',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const plist=readFileSync(file,'utf8');assert.match(plist,/<key>Disabled<\/key><true\/>/);assert.match(plist,/<key>RunAtLoad<\/key><false\/>/);assert.match(plist,/<key>KeepAlive<\/key><false\/>/);assert.ok(plist.includes('__ABSOLUTE_NODE_BINARY__')&&plist.includes('__ABSOLUTE_PRIVATE_DIRECTORY__'));assert.equal(plist.includes('EnvironmentVariables'),false);assert.equal(plist.includes(dummyToken),false);
});
