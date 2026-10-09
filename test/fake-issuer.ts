import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AccessPolicy } from '../src/auth.js';

// Ephemeral test-only RSA keys; no real issuer, account, credential or HTTP fetch.
export const primary=generateKeyPairSync('rsa',{modulusLength:2048});
export const rotated=generateKeyPairSync('rsa',{modulusLength:2048});
export const policy:AccessPolicy={issuer:'https://issuer.example.test',audience:'mock-audience',ownerEmail:'owner@example.test',ownerSubject:'mock-owner-sub',principal:'mock-owner',jwksTimeoutMs:50,cacheMs:1000};
export function jwks(publicKey=primary.publicKey,kid='mock-key') {return JSON.stringify({keys:[{...publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'}]});}
export function jwt(claims:Record<string,unknown>={},header:Record<string,unknown>={},privateKey:KeyObject=primary.privateKey,now=Date.now()) {
  const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'mock-key',typ:'JWT',...header})).toString('base64url');
  const p=Buffer.from(JSON.stringify({iss:policy.issuer,aud:[policy.audience],sub:policy.ownerSubject,email:policy.ownerEmail,exp:Math.floor(now/1000)+60,iat:Math.floor(now/1000)-1,type:'app',...claims})).toString('base64url');
  return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');
}
export const authRequest=(assertion=jwt())=>new Request('https://bridge.example.test/mcp',{headers:{'Cf-Access-Jwt-Assertion':assertion,authorization:'Bearer oauth:opaque-mock'}});
