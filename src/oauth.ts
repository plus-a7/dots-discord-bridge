import { isIP } from 'node:net';
import { z } from 'zod';
import { SignedJwtVerifier, AuthorizationRevoked, jwtPolicyFields, type AuthorizationGrant, type JwksProvider, type RequestAuthenticator } from './auth.js';

// Configuration URLs only. Tokens never select an issuer, key URL or resource.
export function fixedHttpsUrl(raw:string) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||isIP(u.hostname)||!u.hostname.includes('.')||(u.href!==raw&&u.origin!==raw))throw new Error('invalid_fixed_https_url');
  return u;
}
const scope=z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/);
const metadataFields={issuer:z.string().url().max(2048),jwksUrl:z.string().url().max(2048),resource:z.string().url().max(2048),audience:z.string().min(1).max(2048),requiredScopes:z.array(scope).min(1).max(8)};
export const oauthMetadataPolicySchema=z.object(metadataFields).strict().superRefine((p,ctx)=>{
  try {fixedHttpsUrl(p.issuer);fixedHttpsUrl(p.jwksUrl);fixedHttpsUrl(p.resource);if(p.audience!==p.resource||new Set(p.requiredScopes).size!==p.requiredScopes.length)throw new Error('invalid');}
  catch {ctx.addIssue({code:'custom',message:'fixed HTTPS metadata and matching audience required'});}
});
export function oauthMetadata(p:z.output<typeof oauthMetadataPolicySchema>) {
  const pathname=new URL(p.resource).pathname;
  const path='/.well-known/oauth-protected-resource'+(pathname==='/'?'':pathname);
  return {path,aliases:['/.well-known/oauth-protected-resource'],body:{resource:p.resource,authorization_servers:[p.issuer],scopes_supported:[...p.requiredScopes],bearer_methods_supported:['header']},url:new URL(path,p.resource).href};
}
export const oauthPolicySchema=z.object({...jwtPolicyFields,
  jwksUrl:z.string().url().max(2048),resource:z.string().url().max(2048),
  ownerSubject:z.string().min(1).max(256),requiredScopes:z.array(scope).min(1).max(8),
  revokedTokenDigests:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000).default([])
}).strict().superRefine((p,ctx)=>{
  try {fixedHttpsUrl(p.issuer);fixedHttpsUrl(p.jwksUrl);fixedHttpsUrl(p.resource);if(p.audience!==p.resource||new Set(p.requiredScopes).size!==p.requiredScopes.length||new Set(p.revokedTokenDigests).size!==p.revokedTokenDigests.length)throw new Error('invalid');}
  catch {ctx.addIssue({code:'custom',message:'fixed HTTPS issuer/JWKS/resource, matching audience and unique scopes/revocations required'});}
});
export type OAuthPolicy=z.input<typeof oauthPolicySchema>;
// One interoperable JWT access-token profile: RFC 9068, RS256, typ=at+jwt.
// ID tokens and opaque tokens require a different adapter; never a fallback.
const accessClaims=z.object({client_id:z.string().min(1).max(256),jti:z.string().min(1).max(256),iat:z.number().int().nonnegative(),scope:z.string().min(1).max(2048)}).passthrough();
export class OAuthResourceAuthenticator extends SignedJwtVerifier implements RequestAuthenticator {
  private readonly oauth:z.output<typeof oauthPolicySchema>;
  readonly metadata:{path:string;aliases:readonly string[];body:Record<string,unknown>};
  private readonly metadataUrl:string;
  constructor(input:OAuthPolicy,provider:JwksProvider,now=Date.now) {
    const p=oauthPolicySchema.parse(input);
    super(p,provider,now,{kind:'oauth_resource_server',issuer:p.issuer,jwksUrl:p.jwksUrl,resource:p.resource,audience:p.audience,ownerSubject:p.ownerSubject,requiredScopes:[...p.requiredScopes].sort(),principal:p.principal});
    this.oauth=Object.freeze({...p,requiredScopes:Object.freeze([...p.requiredScopes]) as unknown as string[],revokedTokenDigests:Object.freeze([...p.revokedTokenDigests]) as unknown as string[]});
    const metadata=oauthMetadata(p);
    this.metadata={path:metadata.path,aliases:metadata.aliases,body:metadata.body};
    this.metadataUrl=metadata.url;
  }
  challenge(request:Request) {return new Response('',{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="'+this.metadataUrl+'", scope="'+this.oauth.requiredScopes.join(' ')+'"'+(request.headers.has('authorization')?', error="invalid_token"':''),'Cache-Control':'no-store'}});}
  override assertGrant(grant:AuthorizationGrant|undefined) {
    super.assertGrant(grant);
    if(grant!.subject!==this.oauth.ownerSubject||this.oauth.revokedTokenDigests.includes(grant!.tokenDigest))throw new AuthorizationRevoked();
  }
  async authenticate(request:Request):Promise<string> {
    try {
      const authorization=request.headers.get('authorization');
      if(!authorization||authorization.length>16400||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization))throw new Error('invalid_bearer');
      const {claims,token}=await this.verifyToken(authorization.slice(7),request,true);
      const access=accessClaims.parse(claims),scopes=access.scope.split(' ');
      if(scopes.length>32||scopes.some(s=>!scope.safeParse(s).success)||new Set(scopes).size!==scopes.length||claims.sub!==this.oauth.ownerSubject||this.oauth.requiredScopes.some(s=>!scopes.includes(s)))throw new Error('claims_denied');
      return this.remember(request,token,claims);
    } catch {throw new Error('authentication_failed');}
  }
}
