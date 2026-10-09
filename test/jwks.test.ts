import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HttpsJwksProvider } from '../src/jwks.js';
import { AccessJwtAuthenticator } from '../src/auth.js';
import { PinnedHttps } from '../src/callback.js';
import { policy,jwks,jwt,rotated,authRequest } from './fake-issuer.js';

type Reply={status?:number;headers?:Record<string,string>;chunks?:Buffer[];ending?:'end'|'error'|'aborted'|'close'|'stall'};
function network(reply:()=>Reply=()=>({})) {
  let lookups=0,gets=0,destroys=0;const calls:{url:string;options:any;body?:string}[]=[];
  const resolve=async(host:string,options?:unknown)=>{assert.equal(host,'issuer.example.test');if(options)assert.deepEqual(options,{all:true,family:4});lookups++;return [{address:'8.8.8.8',family:4}];};
  const connect=(url:URL,options:any,onResponse:(res:any)=>void)=>{
    calls.push({url:url.href,options});gets++;const req:any=new EventEmitter();let closed=false;
    req.destroy=()=>{if(!closed){closed=true;destroys++;req.emit('close');}return req;};
    req.end=(body?:string)=>{calls.at(-1)!.body=body;queueMicrotask(()=>{
      if(closed)return;const raw=reply(),res:any=new EventEmitter();res.statusCode=raw.status??200;res.headers={'content-type':'application/json',...raw.headers};res.destroy=()=>{req.destroy();};res.setEncoding=()=>{};
      onResponse(res);for(const chunk of raw.chunks??[Buffer.from(jwks())])if(!closed)res.emit('data',options.method==='POST'?chunk.toString('utf8'):chunk);
      if(!closed&&raw.ending!=='stall')res.emit(raw.ending??'end');
    });};return req;
  };
  return {resolve:resolve as any,connect:connect as any,calls,lookups:()=>lookups,gets:()=>gets,destroys:()=>destroys};
}
test('JWKS native HTTPS seam fixes issuer endpoint/IP/family/TLS, GET has no credentials or JWT-selected URL',async()=>{
  const n=network(),provider=new HttpsJwksProvider(policy.issuer,{},n);assert.equal(await provider.load(new AbortController().signal),jwks());
  const call=n.calls[0]!;assert.equal(call.url,policy.issuer+'/cdn-cgi/access/certs');assert.equal(call.options.method,'GET');assert.equal(call.options.family,4);assert.equal(call.options.servername,'issuer.example.test');assert.equal(call.options.rejectUnauthorized,true);assert.equal(call.options.agent,false);assert.deepEqual(call.options.headers,{Accept:'application/json','Accept-Encoding':'identity'});assert.equal(call.body,undefined);
  call.options.lookup('issuer.example.test',{},(error:unknown,ip:string,family:number)=>{assert.equal(error,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
  for(const bad of ['http://issuer.test','https://127.0.0.1','https://issuer.test:8443','https://user@issuer.test','https://issuer.test/a','https://issuer.test/','https://issuer.test?x=1'])assert.throws(()=>new HttpsJwksProvider(bad));
});
test('JWKS rejects redirects/errors/compression/raw byte and chunk excess/incomplete or non-UTF8 bodies',async()=>{
  const cases:Reply[]=[{status:302,headers:{location:'https://127.0.0.1/secret'}},{status:503},{headers:{'content-encoding':'gzip'}},{headers:{'content-type':'text/html'}},{headers:{'content-length':'65537'}},{headers:{'content-length':'3'}},{chunks:[Buffer.alloc(65537)]},{chunks:Array(129).fill(Buffer.from(' '))},{chunks:[Buffer.from([0xff])]},{chunks:[Buffer.from('{')],ending:'error'},{ending:'aborted'},{ending:'close'},{chunks:[Buffer.from('{}')]}];
  for(const response of cases) {const n=network(()=>response),provider=new HttpsJwksProvider(policy.issuer,{},n);await assert.rejects(()=>provider.load(new AbortController().signal),{message:'jwks_unavailable'});assert.equal(n.gets(),1);assert.ok(n.destroys()>0);await assert.rejects(()=>provider.load(new AbortController().signal));assert.equal(n.gets(),1);}
});
test('JWKS denies private/mixed/IPv6 DNS before GET; cancellation during DNS cannot submit later',async()=>{
  for(const records of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],[{address:'2001:4860:4860::8888',family:6}],[]]) {
    const n=network(),p=new HttpsJwksProvider(policy.issuer,{}, {...n,resolve:(async()=>records) as any});await assert.rejects(()=>p.load(new AbortController().signal));assert.equal(n.gets(),0);
  }
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),controller=new AbortController(),n=network();
  const p=new HttpsJwksProvider(policy.issuer,{}, {...n,resolve:(async()=>{await gate;return [{address:'8.8.8.8',family:4}];}) as any});const pending=p.load(controller.signal);controller.abort();await assert.rejects(()=>pending);release();await new Promise(r=>setImmediate(r));assert.equal(n.gets(),0);
});
test('JWKS DNS timeout stays single-flight after ignored abort; synchronous abort in resolver is also bounded',async()=>{
  let release!:()=>void,lookups=0;const gate=new Promise<void>(r=>release=r),n=network();
  const p=new HttpsJwksProvider(policy.issuer,{timeoutMs:20,failureCooldownMs:20},{...n,resolve:(async()=>{lookups++;await gate;return [{address:'8.8.8.8',family:4}];}) as any});
  await assert.rejects(()=>p.load(new AbortController().signal));await assert.rejects(()=>p.load(new AbortController().signal));assert.equal(lookups,1);release();await new Promise(r=>setImmediate(r));assert.equal(n.gets(),0);
  let finish!:()=>void;const blocked=new Promise<void>(r=>finish=r),controller=new AbortController();
  const other=new HttpsJwksProvider(policy.issuer,{}, {...n,resolve:(async()=>{controller.abort();await blocked;return [];}) as any});await assert.rejects(()=>other.load(controller.signal));finish();
});
test('JWKS stalled response abort destroys request; rapid network failure is cooled down and later recovers',async()=>{
  const n=network(()=>({ending:'stall'})),p=new HttpsJwksProvider(policy.issuer,{timeoutMs:20},n);await assert.rejects(()=>p.load(new AbortController().signal));assert.equal(n.destroys(),1);
  let time=1000,fail=true;const remote=network(()=>({status:fail?503:200})),provider=new HttpsJwksProvider(policy.issuer,{failureCooldownMs:100}, {...remote,now:()=>time});
  await assert.rejects(()=>provider.load(new AbortController().signal));for(let i=0;i<5;i++)await assert.rejects(()=>provider.load(new AbortController().signal));assert.equal(remote.gets(),1);time+=101;fail=false;assert.equal(await provider.load(new AbortController().signal),jwks());assert.equal(remote.gets(),2);
});
test('actual provider + validator reject unusable HTTP200 JWKS with cooldown; rotations and transient outage recover',async()=>{
  let time=Date.now(),raw=JSON.stringify({keys:[{}]});const n=network(()=>({chunks:[Buffer.from(raw)]}));
  const provider=new HttpsJwksProvider(policy.issuer,{}, {...n,now:()=>time});const auth=new AccessJwtAuthenticator({...policy,failureCooldownMs:100},provider,()=>time);
  for(let i=0;i<5;i++)await assert.rejects(()=>auth.authenticate(authRequest()));assert.equal(n.gets(),1);
  time+=101;raw=jwks();assert.equal(await auth.authenticate(authRequest()),policy.principal);assert.equal(n.gets(),2);
  raw=jwks(rotated.publicKey,'new-key');await assert.rejects(()=>auth.authenticate(authRequest(jwt({}, {kid:'new-key'},rotated.privateKey))));assert.equal(n.gets(),2);
  time+=1001;assert.equal(await auth.authenticate(authRequest(jwt({}, {kid:'new-key'},rotated.privateKey))),policy.principal);assert.equal(n.gets(),3);auth.close();
});
test('callback native HTTPS seam explicitly fixes IPv4 and certificate validation',async()=>{
  const n=network(()=>({chunks:[Buffer.from('{}')]}));const callback=new PinnedHttps(['issuer.example.test'],n.resolve,n.connect);
  assert.equal((await callback.post(policy.issuer+'/events','{}',{},()=>{})).status,200);assert.equal(n.calls[0]!.options.family,4);assert.equal(n.calls[0]!.options.rejectUnauthorized,true);
});
test('OAuth fixed path JWKS uses the same bounded DNS/TLS transport without Cloudflare endpoint assumptions',async()=>{
  const n=network(),issuer=policy.issuer+'/realm/bridge',endpoint=policy.issuer+'/realm/bridge/keys';
  const provider=new HttpsJwksProvider(issuer,{jwksUrl:endpoint},n);assert.equal(await provider.load(new AbortController().signal),jwks());assert.equal(n.calls[0]!.url,endpoint);assert.equal(n.calls[0]!.options.servername,'issuer.example.test');assert.equal(n.calls[0]!.options.rejectUnauthorized,true);
  for(const url of ['http://issuer.example.test/keys','https://127.0.0.1/keys','https://issuer.example.test/keys?token=x','https://user@issuer.example.test/keys'])assert.throws(()=>new HttpsJwksProvider(issuer,{jwksUrl:url},n));
  const blocked=new HttpsJwksProvider(issuer,{jwksUrl:endpoint},{...n,resolve:(async()=>[{address:'10.0.0.1',family:4}]) as any});await assert.rejects(()=>blocked.load(new AbortController().signal));assert.equal(n.gets(),1);
});
