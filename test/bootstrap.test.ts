import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/core.js';
import { fixture,folders,settings,subscribe,rpc,until,owner,guild,channel,thread,bot,dummyToken } from './bootstrap-fixture.js';

test('explicit fake login bootstrap -> authenticated loopback/SDK -> signed event -> idempotent same-thread reply',async()=>{
  const f=fixture(),boot=f.create();
  try {
    const port=await boot.start(true);assert.equal(f.logins(),1);assert.equal((await rpc(port,'events/list',{},'invalid')).status,401);
    const sub=await rpc(port,'events/subscribe',subscribe);assert.equal(sub.status,200);f.emit();f.emit();await until(()=>f.callbacks.length===1);
    const args={subscription_id:sub.value.result.id,event_id:f.callbacks[0].eventId};assert.equal((await rpc(port,'tools/call',{name:'discord_read',arguments:args})).value.result.isError,undefined);
    for(let i=0;i<2;i++)assert.equal((await rpc(port,'tools/call',{name:'discord_reply',arguments:{...args,content:'mock response @everyone'}})).value.result.isError,undefined);
    assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});assert.equal(Object.keys(boot.runtime!.store.state.messages).length,1);
    assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.destroys(),1);assert.equal(f.client.listenerCount('messageCreate'),0);await assert.rejects(()=>boot.start(true),/already_started/);
  } finally {await boot.stop();f.paths.cleanup();}
});
test('login failure, wrong Bot/non-Bot identity, missing guild and no-ready deadline never start HTTP/worker',async()=>{
  for(const options of [{login:async()=>{throw new Error(dummyToken);}},{identity:owner},{botFlag:false},{visibleGuild:false},{readyOnLogin:false}]) {
    const f=fixture(options),boot=f.create();
    try {await assert.rejects(()=>boot.start(true),{message:'bootstrap_start_failed'});assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(boot.runtime!.http.drained,true);assert.equal(f.destroys(),1);assert.equal(f.callbacks.length,0);assert.equal(f.posts.length,0);}
    finally {await boot.stop();f.paths.cleanup();}
  }
});
test('late login after timeout retains lease across different state paths, then first destroy prevents revival',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const f=fixture({login:async()=>gate}),boot=f.create(),otherPaths=folders();
  const other=fixture({paths:otherPaths,raw:{...settings(otherPaths),ownershipDirectory:f.paths.ownershipDirectory}}),second=other.create();
  try {
    await assert.rejects(()=>boot.start(true),/bootstrap_start_failed/);assert.deepEqual(await boot.stop(),{clean:false,pending:true});assert.equal(f.destroys(),0);assert.doesNotThrow(()=>boot.runtime!.store.save());
    await assert.rejects(()=>second.start(true),/bootstrap_start_failed/);assert.equal(other.clients(),0);assert.equal(other.reads(),0);assert.equal(other.logins(),0);await second.stop();
    release();await until(()=>f.destroys()===1);assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.client.isReady(),false);assert.equal(f.callbacks.length,0);assert.equal(f.posts.length,0);
    const lease=new Store(join(f.paths.ownershipDirectory,'bot_'+bot+'.lease.sqlite'));lease.close();
  } finally {release();await boot.stop();await second.stop();f.paths.cleanup();otherPaths.cleanup();}
});
test('stop during pending login returns unclean without releasing state; late completion is cleaned once',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=fixture({login:async()=>gate}),boot=f.create();const starting=boot.start(true);const failed=assert.rejects(()=>starting,/bootstrap_start_failed/);
  try {
    await until(()=>f.logins()===1);assert.deepEqual(await boot.stop(20),{clean:false,pending:true});await failed;assert.equal(f.destroys(),0);
    assert.throws(()=>new Store(join(f.paths.privateDirectory,'state.sqlite')),/store_already_in_use/);
    release();await until(()=>f.destroys()===1);assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.client.isReady(),false);
  } finally {release();await boot.stop();f.paths.cleanup();}
});
test('stop during credential preparation or runtime start blocks admission immediately and retains ownership until settle',async()=>{
  for(const mode of ['token','runtime']) {
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);const f=fixture(mode==='token'?{token:async()=>{await gate;return dummyToken;}}:{startGate:gate}),boot=f.create();const starting=boot.start(true),failed=assert.rejects(()=>starting,/bootstrap_start_failed/);
    try {
      await until(()=>mode==='token'?f.reads()===1:f.logins()===1);assert.deepEqual(await boot.stop(20),{clean:false,pending:true});
      assert.equal(boot.runtime!.bridge.ingest({id:'100000000000000012',guildId:guild,channelId:channel,threadId:thread,authorId:owner,bot:false,webhook:false,mentionsBridge:false,content:'late blocked mock',timestamp:Date.now()}),'paused');
      release();await failed;assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.callbacks.length,0);assert.equal(f.posts.length,0);if(mode==='token')assert.equal(f.logins(),0);
    } finally {release();await boot.stop();f.paths.cleanup();}
  }
});
test('never-settling Gateway destroy is bounded and retains lease until real completion',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=fixture({destroy:async()=>gate}),boot=f.create();
  try {await boot.start(true);assert.deepEqual(await boot.stop(20),{clean:false,pending:true});assert.equal(f.destroys(),1);assert.doesNotThrow(()=>boot.runtime!.store.save());release();assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.destroys(),1);}
  finally {release();await boot.stop();f.paths.cleanup();}
});
test('partial runtime setup with never-settling orphan destroy is bounded and retains Bot lease',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=fixture({destroy:async()=>gate});const existing=new Store(join(f.paths.privateDirectory,'state.sqlite')),boot=f.create();
  try {
    await assert.rejects(()=>boot.start(true),/bootstrap_start_failed/);assert.equal(boot.runtime,undefined);assert.deepEqual(await boot.stop(),{clean:false,pending:true});assert.equal(f.logins(),0);
    assert.throws(()=>new Store(join(f.paths.ownershipDirectory,'bot_'+bot+'.lease.sqlite')),/store_already_in_use/);
    release();assert.deepEqual(await boot.stop(),{clean:true,pending:false});assert.equal(f.destroys(),1);
  } finally {release();await boot.stop();existing.close();f.paths.cleanup();}
});
test('bootstrap restart recovers verified subscription/pending delivery and rejects duplicate Gateway event',async()=>{
  const paths=folders(),first=fixture({paths,callbackStatus:503}),old=first.create();let fresh:ReturnType<typeof first.create>|undefined;
  try {
    const port=await old.start(true),sub=await rpc(port,'events/subscribe',subscribe);assert.ok(sub.value.result.id);first.emit();first.emit();await until(()=>first.callbacks.length===1);
    old.runtime!.worker.stop();const d=Object.values(old.runtime!.store.state.deliveries)[0]!;d.nextAt=0;old.runtime!.store.save();assert.equal(d.status,'pending');assert.deepEqual(await old.stop(),{clean:true,pending:false});
    const second=fixture({paths});fresh=second.create();const secondPort=await fresh.start(true);await until(()=>second.callbacks.length===1);second.emit();await new Promise(r=>setTimeout(r,15));assert.equal(second.callbacks.length,1);assert.equal(second.callbacks[0].eventId,first.callbacks[0].eventId);assert.equal(Object.keys(fresh.runtime!.store.state.messages).length,1);
    const args={subscription_id:sub.value.result.id,event_id:second.callbacks[0].eventId};assert.equal((await rpc(secondPort,'tools/call',{name:'discord_read',arguments:args})).value.result.isError,undefined);assert.equal(second.posts.length,0);
  } finally {await old.stop();await fresh?.stop();paths.cleanup();}
});
