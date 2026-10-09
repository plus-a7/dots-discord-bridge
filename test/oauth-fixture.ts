import { jwt, primary } from './fake-issuer.js';
import type { KeyObject } from 'node:crypto';
import type { OAuthPolicy } from '../src/oauth.js';

export const oauthPolicy:OAuthPolicy={issuer:'https://issuer.example.test/realm/bridge',jwksUrl:'https://issuer.example.test/realm/bridge/keys',resource:'https://mcp.example.test/mcp',audience:'https://mcp.example.test/mcp',ownerSubject:'mock-owner-sub',principal:'mock-owner',requiredScopes:['discord:read','discord:reply','discord:events'],jwksTimeoutMs:50,cacheMs:1000};
export function oauthJwt(claims:Record<string,unknown>={},header:Record<string,unknown>={},key:KeyObject=primary.privateKey,now=Date.now()) {
  return jwt({iss:oauthPolicy.issuer,aud:oauthPolicy.audience,sub:oauthPolicy.ownerSubject,client_id:'mock-chatgpt-client',jti:'mock-access-id',scope:oauthPolicy.requiredScopes.join(' '),...claims},{typ:'at+jwt',...header},key,now);
}
export const oauthRequest=(token=oauthJwt())=>new Request('https://local-mcp.invalid/mcp',{headers:{authorization:'Bearer '+token}});
