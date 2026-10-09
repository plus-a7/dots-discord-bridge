import { z } from 'zod';
import { isIP } from 'node:net';
import { oauthMetadataPolicySchema, oauthMetadata } from './oauth.js';
import { LoopbackHttp } from './http.js';

// Separate strict configuration: no Bot, state directory, principal, subject,
// token, callback URL/secret or production activation fields are accepted.
const port=z.number().int().min(1024).max(65535);
function hostname(value:string) {
  try {const u=new URL('https://'+value);return u.hostname===value&&u.host===value&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&!isIP(value)&&/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(value);}
  catch {return false;}
}
const setupSchema=z.object({version:z.literal(1),mode:z.literal('oauth_setup'),enabled:z.literal(true),oauth:oauthMetadataPolicySchema,http:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tunnel_loopback'),port}).strict(),
  z.object({kind:z.literal('forwarded_https'),host:z.string().max(253).refine(hostname),port}).strict()
])}).strict();
export type OAuthSetup=z.output<typeof setupSchema>;
export function parseOAuthSetup(raw:unknown):OAuthSetup {
  try {const p=setupSchema.parse(raw);Object.freeze(p.oauth.requiredScopes);Object.freeze(p.oauth);Object.freeze(p.http);return Object.freeze(p);}
  catch {throw new Error('oauth_setup_disabled_or_incomplete');}
}
export const setupStatus=()=>({mode:'oauth_setup',metadataConfigured:true,liveReady:false,mcpEnabled:false,eventsEnabled:false,pending:['owner_subject','callback_host_confirmation','production_configuration_and_activation']});
// Host-only syntax diagnosis. No URL/token/secret input, DNS, persistence,
// callback verification or automatic trust. Operator confirms the source.
export function diagnoseCallbackHost(value:string) {
  if(value.length>253||!hostname(value))throw new Error('callback_host_invalid');
  return {status:'callback_host_syntax_valid',trusted:false,next:'confirm_actual_chatgpt_events_host_then_set_production_allowlist'};
}
export function makeOAuthSetupEndpoint(config:OAuthSetup) {
  const p=parseOAuthSetup(config),metadata=oauthMetadata(p.oauth),host=p.http.kind==='forwarded_https'?p.http.host:'local-mcp.invalid';
  const paths=[metadata.path,...metadata.aliases];
  return {host,paths,fetch:async(request:Request)=>{
    const u=new URL(request.url);
    if(u.protocol!=='https:'||u.host!==host||u.search||request.headers.has('origin'))return new Response('',{status:403});
    if(request.method==='GET'&&paths.includes(u.pathname))return new Response(JSON.stringify(metadata.body),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(u.pathname!=='/mcp')return new Response('',{status:404});
    // Never inspect a bearer or body. Even a valid token cannot enable MCP.
    return new Response('',{status:401,headers:{'WWW-Authenticate':'Bearer resource_metadata="'+metadata.url+'", scope="'+p.oauth.requiredScopes.join(' ')+'"','Cache-Control':'no-store'}});
  }};
}
export class OAuthSetupRuntime {
  private readonly http:LoopbackHttp;
  constructor(raw:unknown) {
    const p=parseOAuthSetup(raw),endpoint=makeOAuthSetupEndpoint(p);
    this.http=new LoopbackHttp(endpoint.fetch,endpoint.host,{port:p.http.port,ingress:p.http.kind,metadataPaths:endpoint.paths});
  }
  async start(activate=false) {if(!activate)throw new Error('activation_required');return this.http.start();}
  async stop():Promise<{clean:boolean;pending:boolean}> {
    this.http.stopAccepting();this.http.forceClose();
    const until=Date.now()+1000;while(!this.http.drained&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
    return {clean:this.http.drained,pending:!this.http.drained};
  }
}
