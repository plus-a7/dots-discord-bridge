import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessJwtAuthenticator } from '../src/auth.js';
import { policy, jwks, jwt, primary, rotated, authRequest } from './fake-issuer.js';

test('Access assertion verifies issuer audience owner subject RSA signature; opaque Bearer is not parsed',async()=>{
  let loads=0;const auth=new AccessJwtAuthenticator(policy,{load:async()=>{loads++;return jwks();}});
  assert.equal(await auth.authenticate(authRequest()),policy.principal);assert.equal(await auth.authenticate(authRequest(jwt({aud:policy.audience}))),policy.principal);assert.equal(loads,1);
  await assert.rejects(()=>auth.authenticate(new Request('https://bridge.example.test/mcp',{headers:{authorization:'Bearer '+jwt()}})),/authentication_failed/);auth.close();
});
for(const [name,claims] of Object.entries({issuer:{iss:'https://attacker.example.test'},audience:{aud:['other']},owner:{email:'other@example.test'},subject:{sub:'other'},expired:{exp:0},futureNbf:{nbf:Math.floor(Date.now()/1000)+1000},futureIat:{iat:Math.floor(Date.now()/1000)+1000},missingExp:{exp:null},serviceToken:{type:'service'},badAudience:{aud:[1]}})) test(`Access rejects ${name} claims`,async()=>{
  const auth=new AccessJwtAuthenticator(policy,{load:async()=>jwks()});await assert.rejects(()=>auth.authenticate(authRequest(jwt(claims))),{message:'authentication_failed'});auth.close();
});
test('Access rejects algorithms and header key URLs without contacting any issuer',async()=>{
  let loads=0;const auth=new AccessJwtAuthenticator(policy,{load:async()=>{loads++;return jwks();}});
  for(const h of [{alg:'none'},{alg:'HS256'},{jku:'https://127.0.0.1/a'},{x5u:'https://attacker.test'},{jwk:{}},{crit:['b64']},{b64:false}]) await assert.rejects(()=>auth.authenticate(authRequest(jwt({},h))),/authentication_failed/);
  assert.equal(loads,0);auth.close();
});
test('Access rejects wrong signing key, unknown kid, noncanonical encoding and folded duplicate assertions',async()=>{
  const auth=new AccessJwtAuthenticator(policy,{load:async()=>jwks()});
  for(const token of [jwt({}, {},rotated.privateKey),jwt({}, {kid:'unknown'}),jwt()+'=',jwt()+','+jwt(),'a.b.c']) await assert.rejects(()=>auth.authenticate(authRequest(token)),/authentication_failed/);
  auth.close();
});
test('JWKS validates capacity, unique kids, public-only RSA signing keys and minimum modulus',async()=>{
  const key=JSON.parse(jwks()).keys[0];
  for(const raw of [' '.repeat(65537),JSON.stringify({keys:Array(9).fill(key)}),JSON.stringify({keys:[key,key]}),JSON.stringify({keys:[{...key,d:'private'}]}),JSON.stringify({keys:[{...key,kty:'oct'}]}),JSON.stringify({keys:[{...key,use:'enc'}]}),JSON.stringify({keys:[{...key,key_ops:['sign']}]}),JSON.stringify({keys:[{...key,n:'AQAB'}]})]) {
    const auth=new AccessJwtAuthenticator(policy,{load:async()=>raw});await assert.rejects(()=>auth.authenticate(authRequest()),/authentication_failed/);auth.close();
  }
});
test('JWKS caches with bounded TTL and unknown kid does not cause refresh storms; rotation after TTL works',async()=>{
  let time=Date.now(),loads=0,current=jwks();const auth=new AccessJwtAuthenticator(policy,{load:async()=>{loads++;return current;}},()=>time);
  await auth.authenticate(authRequest());for(let i=0;i<10;i++)await assert.rejects(()=>auth.authenticate(authRequest(jwt({}, {kid:'new-key'}))));assert.equal(loads,1);
  current=jwks(rotated.publicKey,'new-key');time+=1001;assert.equal(await auth.authenticate(authRequest(jwt({}, {kid:'new-key'},rotated.privateKey))),policy.principal);assert.equal(loads,2);auth.close();
});
test('JWKS timeout is bounded even if provider ignores abort, stays single-flight, late result does not revive cache',async()=>{
  let release!:(raw:string)=>void,loads=0;const gate=new Promise<string>(r=>release=r);
  const auth=new AccessJwtAuthenticator({...policy,jwksTimeoutMs:20},{load:async()=>{loads++;return gate;}});
  const pending=auth.authenticate(authRequest());await assert.rejects(()=>pending,/authentication_failed/);
  await assert.rejects(()=>auth.authenticate(authRequest()),/authentication_failed/);assert.equal(loads,1);
  auth.close();release(jwks());await assert.rejects(()=>auth.authenticate(authRequest()),/authentication_failed/);
});
test('expiry and validator close are rechecked after delayed JWKS; config is an immutable snapshot',async()=>{
  for(const action of ['expire','close']) {
    let time=Date.now(),release!:(raw:string)=>void;const gate=new Promise<string>(r=>release=r);
    const input={...policy,ownerEmail:policy.ownerEmail};const auth=new AccessJwtAuthenticator(input,{load:()=>gate},()=>time);
    const pending=auth.authenticate(authRequest(jwt({}, {},primary.privateKey,time)));input.ownerEmail='attacker@example.test';
    if(action==='close')auth.close();else time+=61000;release(jwks());await assert.rejects(()=>pending,/authentication_failed/);auth.close();
  }
});
test('fixed auth policy rejects non-HTTPS, issuer paths and unbounded skew',()=>{
  for(const p of [{...policy,issuer:'http://issuer.test'},{...policy,issuer:'https://issuer.test/keys'},{...policy,issuer:'https://issuer.test/'},{...policy,clockSkewSec:31}]) assert.throws(()=>new AccessJwtAuthenticator(p,{load:async()=>jwks()}));
});
