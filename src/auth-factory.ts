import { z } from 'zod';
import { AccessJwtAuthenticator, policySchema, type JwksProvider, type RequestAuthenticator } from './auth.js';
import { OAuthResourceAuthenticator, oauthPolicySchema } from './oauth.js';
import { HttpsJwksProvider } from './jwks.js';

export const authenticationSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('cloudflare_access'),policy:policySchema}).strict(),
  z.object({kind:z.literal('oauth_resource_server'),policy:oauthPolicySchema}).strict()
]);
export type Authentication=z.input<typeof authenticationSchema>;
export function createAuthenticator(raw:Authentication,provider?:JwksProvider,now=Date.now):RequestAuthenticator {
  const config=authenticationSchema.parse(raw),p=config.policy;
  const keys=provider??new HttpsJwksProvider(p.issuer,{timeoutMs:p.jwksTimeoutMs,failureCooldownMs:p.failureCooldownMs,...(config.kind==='oauth_resource_server'?{jwksUrl:config.policy.jwksUrl}:{})});
  return config.kind==='cloudflare_access'?new AccessJwtAuthenticator(config.policy,keys,now):new OAuthResourceAuthenticator(config.policy,keys,now);
}
