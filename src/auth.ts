import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export type AuthorizationGrant={policyId:string;subject:string;tokenDigest:string;expiresAt:number};
export class AuthorizationRevoked extends Error {constructor(){super('authorization_revoked');}}
export interface RequestAuthenticator {
  authenticate(request:Request):Promise<string>;close?():void;
  grantFor?(request:Request):AuthorizationGrant;
  assertGrant?(grant:AuthorizationGrant|undefined):void;
  metadata?:{path:string;aliases?:readonly string[];body:Record<string,unknown>};
  challenge?(request:Request):Response;
}
// Provider is injected. It must fetch only the configured issuer's fixed JWKS
// endpoint, bound raw bytes, obey abort, and never follow token/header URLs.
// HttpsJwksProvider implements this contract; tests inject isolated transports.
export interface JwksProvider {load(signal:AbortSignal):Promise<string>}
export const jwtPolicyFields={issuer:z.string().url(),audience:z.string().min(1).max(2048),principal:z.string().min(1).max(256),clockSkewSec:z.number().int().min(0).max(30).default(0),jwksTimeoutMs:z.number().int().min(20).max(3000).default(1000),cacheMs:z.number().int().min(0).max(60000).default(30000),failureCooldownMs:z.number().int().min(20).max(60000).default(1000)};
export const policySchema=z.object({...jwtPolicyFields,ownerEmail:z.string().email(),ownerSubject:z.string().min(1).max(256).optional()}).strict().superRefine((p,ctx)=>{
  const u=new URL(p.issuer);if(u.protocol!=='https:'||u.origin!==p.issuer||u.pathname!=='/'||u.port||u.username||u.password||u.search||u.hash)ctx.addIssue({code:'custom',message:'fixed HTTPS issuer origin required'});
});
export type AccessPolicy=z.input<typeof policySchema>;
const jwkSchema=z.object({kid:z.string().min(1).max(128),kty:z.literal('RSA'),n:z.string().min(1).max(1400),e:z.string().min(1).max(16),alg:z.literal('RS256').optional(),use:z.literal('sig').optional(),key_ops:z.array(z.literal('verify')).max(1).optional()}).passthrough();
const jwksSchema=z.object({keys:z.array(jwkSchema).min(1).max(8)}).passthrough();
const headerFields={alg:z.literal('RS256'),kid:z.string().min(1).max(128)};
const headerSchema=z.object({...headerFields,typ:z.literal('JWT').optional()}).strict();
const accessHeaderSchema=z.object({...headerFields,typ:z.literal('at+jwt')}).strict();
const claimsSchema=z.object({iss:z.string(),aud:z.union([z.string(),z.array(z.string()).min(1).max(8)]),sub:z.string().min(1).max(256),email:z.string().email().optional(),exp:z.number().int().nonnegative(),nbf:z.number().int().nonnegative().optional(),iat:z.number().int().nonnegative().optional()}).passthrough();
type CommonPolicy=z.output<z.ZodObject<typeof jwtPolicyFields>>;
function decode(text:string,maxBytes:number) {
  if(!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid_encoding');
  const data=Buffer.from(text,'base64url');
  if(data.length>maxBytes||data.toString('base64url')!==text) throw new Error('invalid_encoding');return data;
}
function wait<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('aborted'));signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)).catch(()=>{});
  });
}
// Shared bounded signature/key verification; adapters select one credential
// source and one token profile. There is no header or provider fallback.
export class SignedJwtVerifier {
  protected readonly grants=new WeakMap<Request,AuthorizationGrant>();
  protected readonly policyId:string;
  private closed=false;
  private cache?:{keys:Map<string,KeyObject>;until:number};
  private retryAfter=0;
  private pending?:{work:Promise<string>;controller:AbortController;timer:ReturnType<typeof setTimeout>};
  constructor(protected readonly policy:CommonPolicy,private readonly provider:JwksProvider,protected readonly now=Date.now,identity:unknown=policy) {
    const u=new URL(policy.issuer);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port||(u.href!==policy.issuer&&u.origin!==policy.issuer))throw new Error('invalid_auth_policy');
    this.policy=Object.freeze({...policy});
    this.policyId=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
  close() {this.closed=true;this.cache=undefined;this.pending?.controller.abort();}
  private assertOpen(signal:AbortSignal) {if(this.closed||signal.aborted) throw new Error('closed');}
  private async keys(signal:AbortSignal) {
    this.assertOpen(signal);if(this.cache&&this.cache.until>this.now()) return this.cache.keys;
    if(this.now()<this.retryAfter)throw new Error('jwks_cooldown');
    try {
    if(!this.pending) {
      const controller=new AbortController();
      const work=Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('aborted');return this.provider.load(controller.signal);});
      const timer=setTimeout(()=>controller.abort(),this.policy.jwksTimeoutMs);
      const pending={work,controller,timer};this.pending=pending;
      // A provider ignoring abort stays single-flight until it settles: no new
      // background requests accumulate. Late completion never installs a cache.
      void work.finally(()=>{clearTimeout(timer);if(this.pending===pending)this.pending=undefined;}).catch(()=>{});
    }
    const pending=this.pending;
    const raw=await wait(wait(pending.work,pending.controller.signal),signal);
    this.assertOpen(signal);if(pending.controller.signal.aborted||Buffer.byteLength(raw)>65536) throw new Error('jwks_failed');
    const parsed=jwksSchema.parse(JSON.parse(raw)),keys=new Map<string,KeyObject>();
    for(const key of parsed.keys) {
      if(keys.has(key.kid)||['d','p','q','dp','dq','qi','oth','jku','x5u'].some(k=>k in key)) throw new Error('invalid_jwk');
      decode(key.n,1024);decode(key.e,8);
      const publicKey=createPublicKey({format:'jwk',key:{kty:'RSA',n:key.n,e:key.e}});
      if(publicKey.asymmetricKeyType!=='rsa'||(publicKey.asymmetricKeyDetails?.modulusLength??0)<2048) throw new Error('weak_jwk');keys.set(key.kid,publicKey);
    }
    this.cache={keys,until:this.now()+this.policy.cacheMs};this.retryAfter=0;return keys;
    } catch(error) {if(!signal.aborted&&!this.closed)this.retryAfter=this.now()+this.policy.failureCooldownMs;throw error;}
  }
  protected async verifyToken(token:string|null,request:Request,accessToken=false) {
      this.assertOpen(request.signal);
      if(!token||token.length>16384) throw new Error('missing_assertion');
      const parts=token.split('.');if(parts.length!==3) throw new Error('invalid_assertion');
      const header=(accessToken?accessHeaderSchema:headerSchema).parse(JSON.parse(decode(parts[0]!,2048).toString('utf8')));
      const claims=claimsSchema.parse(JSON.parse(decode(parts[1]!,8192).toString('utf8'))),signature=decode(parts[2]!,1024);
      const key=(await this.keys(request.signal)).get(header.kid);this.assertOpen(request.signal);
      if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,signature)) throw new Error('bad_signature');
      const p=this.policy,now=this.now()/1000,skew=p.clockSkewSec;
      const audience=typeof claims.aud==='string'?[claims.aud]:claims.aud;
      if(claims.iss!==p.issuer||!audience.includes(p.audience)||claims.exp<=now-skew||(claims.nbf!==undefined&&(claims.nbf>now+skew||claims.nbf>=claims.exp))||(claims.iat!==undefined&&(claims.iat>now+skew||claims.iat>=claims.exp))) throw new Error('claims_denied');
      return {claims,token};
  }
  protected remember(request:Request,token:string,claims:z.output<typeof claimsSchema>) {
    // Persist no bearer token. A grant never outlives the verified token.
    const grant=Object.freeze({policyId:this.policyId,subject:claims.sub,tokenDigest:createHash('sha256').update(token).digest('hex'),expiresAt:claims.exp*1000});
    this.assertGrant(grant);this.grants.set(request,grant);return this.policy.principal;
  }
  grantFor(request:Request):AuthorizationGrant {const grant=this.grants.get(request);this.assertGrant(grant);return grant!;}
  assertGrant(grant:AuthorizationGrant|undefined) {
    if(this.closed||!grant||grant.policyId!==this.policyId||typeof grant.subject!=='string'||!grant.subject||!/^[a-f0-9]{64}$/.test(grant.tokenDigest)||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=this.now())throw new AuthorizationRevoked();
  }
}
export class AccessJwtAuthenticator extends SignedJwtVerifier implements RequestAuthenticator {
  private readonly access:z.output<typeof policySchema>;
  constructor(policy:AccessPolicy,provider:JwksProvider,now=Date.now) {
    const p=policySchema.parse(policy),u=new URL(p.issuer);
    if(u.pathname!=='/'||u.origin!==p.issuer)throw new Error('invalid_auth_policy');
    super(p,provider,now,{kind:'cloudflare_access',issuer:p.issuer,audience:p.audience,ownerEmail:p.ownerEmail,ownerSubject:p.ownerSubject,principal:p.principal});this.access=Object.freeze(p);
  }
  async authenticate(request:Request):Promise<string> {
    try {
      const {claims,token}=await this.verifyToken(request.headers.get('cf-access-jwt-assertion'),request);
      const p=this.access;
      if(claims.email!==p.ownerEmail||(p.ownerSubject&&claims.sub!==p.ownerSubject)||(claims.type!==undefined&&claims.type!=='app'))throw new Error('claims_denied');
      return this.remember(request,token,claims); // Authorization bearer remains opaque.
    } catch {throw new Error('authentication_failed');} // No raw JWT/claims/provider errors escape.
  }
}
