import { join } from 'node:path';
import type { Client } from 'discord.js';
import { Events } from 'discord.js';
import { type JwksProvider } from './auth.js';
import { createAuthenticator } from './auth-factory.js';
import { PinnedHttps, type CallbackTransport } from './callback.js';
import { Store } from './core.js';
import { makeClient, DiscordJsSender, attachGateway, resourceAccessGuard } from './discord.js';
import { BridgeRuntime, type RuntimeOptions } from './runtime.js';
import { parseDeployment, assertPrivateDirectory, assertPrivateState, readPrivateToken, type Deployment } from './deployment.js';
import { readKeychainToken, type KeychainSpawn } from './keychain.js';

type Dependencies={createClient?:()=>Client;readToken?:(directory:string,credential:Deployment['credential'],signal:AbortSignal)=>Promise<string>;keychainSpawn?:KeychainSpawn;jwks?:JwksProvider;callback?:CallbackTransport;createRuntime?:(options:RuntimeOptions)=>BridgeRuntime};
export class LoginBootstrap {
  readonly config:Deployment;
  runtime?:BridgeRuntime;
  private lease?:Store;
  private client?:Client;
  private readonly controller=new AbortController();
  private loginWork?:Promise<void>;
  private startingWork=false;
  private phase:'new'|'starting'|'running'|'stopping'|'stopped'='new';
  private stopping?:Promise<{clean:boolean;pending:boolean}>;
  private orphanDestroy?:Promise<void>;
  private orphanClosed=false;
  constructor(raw:unknown,private readonly dependencies:Dependencies={}) {this.config=parseDeployment(raw);}
  async start(activate=false):Promise<number> {
    // Even a complete configuration requires explicit activation. No path IO,
    // lease, secret, client, listener or DNS work occurs before this gate.
    if(!activate)throw new Error('activation_required');
    if(this.phase!=='new')throw new Error('bootstrap_already_started');
    this.phase='starting';this.startingWork=true;
    const signal=this.controller.signal;let token='';let timer:ReturnType<typeof setTimeout>|undefined;
    const assertStarting=()=>{if(signal.aborted||this.phase!=='starting')throw new Error('bootstrap_cancelled');};
    try {
      assertPrivateDirectory(this.config.privateDirectory);assertPrivateDirectory(this.config.ownershipDirectory);
      const leasePath=join(this.config.ownershipDirectory,'bot_'+this.config.bridge.bridgeBotId+'.lease.sqlite');
      assertPrivateState(leasePath);assertPrivateState(join(this.config.privateDirectory,'state.sqlite'));
      // All bootstrap instances must use the same canonical ownership directory
      // for a Bot, independent of state directory. Existing runtimes do not
      // participate in this lock: exclusive handoff still requires confirmation.
      this.lease=new Store(leasePath);
      assertStarting();
      const client=(this.dependencies.createClient??makeClient)();this.client=client;
      client.on(Events.Error,()=>{}); // Never attach SDK debug or log raw errors.
      const auth=createAuthenticator(this.config.authentication,this.dependencies.jwks);
      const config=this.config.bridge;
      const gateway={isReady:()=>!signal.aborted&&client.isReady()&&client.user?.id===config.bridgeBotId&&client.user.bot&&client.guilds.cache.has(config.guildId!),
        attach:(bridge:BridgeRuntime['bridge'],status:(code:string)=>void)=>attachGateway(client,bridge,status),
        destroy:async()=>{
          // discord.js destroy is one-shot. Destroying before its asynchronous
          // login preparation settles can leave a later shard unclosed. Keep
          // Store/lease ownership and perform the first destroy after settlement.
          if(this.loginWork)await this.loginWork.catch(()=>{});
          await client.destroy();
        }};
      this.runtime=(this.dependencies.createRuntime??(options=>new BridgeRuntime(options)))({config,statePath:join(this.config.privateDirectory,'state.sqlite'),sender:new DiscordJsSender(client,config),gateway,auth,externalHost:this.config.http.kind==='forwarded_https'?this.config.http.host:'local-mcp.invalid',port:this.config.http.port,ingress:this.config.http.kind,
        callback:this.dependencies.callback??new PinnedHttps(this.config.callbackHosts),callbackHosts:this.config.callbackHosts,
        resourceAccess:resourceAccessGuard(client,config,id=>this.runtime!.bridge.binding(id))});
      token=await (this.dependencies.readToken??(async (directory,credential,cancel)=>credential.kind==='keychain'
        ? readKeychainToken(credential,cancel,this.dependencies.keychainSpawn)
        : readPrivateToken(directory)))(this.config.privateDirectory,this.config.credential,signal);assertStarting();
      if(!/^[A-Za-z0-9_.-]{32,256}$/.test(token)||token.startsWith('mfa.'))throw new Error('credential_invalid');
      timer=setTimeout(()=>this.controller.abort(),this.config.loginTimeoutMs);
      // Discard the SDK's returned token; errors are never printed or returned.
      this.loginWork=Promise.resolve().then(()=>{assertStarting();return client.login(token);}).then(()=>{token='';},()=>{token='';throw new Error('login_failed');});
      await abortable(this.loginWork,signal);assertStarting();
      while(!client.isReady()){await abortable(new Promise<void>(r=>setTimeout(r,5)),signal);assertStarting();}
      if(!gateway.isReady())throw new Error('discord_identity_unconfirmed');
      clearTimeout(timer);timer=undefined;
      const port=await this.runtime.start();assertStarting();this.phase='running';return port;
    } catch {
      this.phase='stopping';this.controller.abort();
      // Stop is retried after startingWork clears. Pending login cannot cause
      // an early clean report or release the Bot lease.
      throw new Error('bootstrap_start_failed');
    } finally {
      token='';if(timer)clearTimeout(timer);this.startingWork=false;
      if(this.phase==='stopping')void this.stop().catch(()=>{});
    }
  }
  async stop(timeoutMs=this.config.drainTimeoutMs):Promise<{clean:boolean;pending:boolean}> {
    if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw new Error('invalid_drain_timeout');
    if(this.phase==='stopped')return {clean:true,pending:false};if(this.stopping)return this.stopping;
    this.phase='stopping';this.controller.abort();
    this.stopping=(async()=>{
      const until=Date.now()+timeoutMs;
      while(this.startingWork&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
      if(this.startingWork)return {clean:false,pending:true};
      const result=this.runtime?await this.runtime.stop(Math.max(10,until-Date.now())):{clean:true,pending:false};
      if(!this.runtime&&this.client) {
        this.orphanDestroy??=Promise.resolve().then(()=>this.client!.destroy()).then(()=>{this.orphanClosed=true;},()=>{});
        while(!this.orphanClosed&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
        if(!this.orphanClosed)return {clean:false,pending:true};
      }
      if(!result.clean)return result;
      this.lease?.close();this.lease=undefined;this.phase='stopped';return {clean:true,pending:false};
    })();
    try {return await this.stopping;}finally {this.stopping=undefined;}
  }
}
function abortable<T>(work:Promise<T>,signal:AbortSignal) {
  if(signal.aborted)return Promise.reject(new Error('bootstrap_cancelled'));
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('bootstrap_cancelled'));};signal.addEventListener('abort',abort,{once:true});
    void work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)).catch(()=>{});
  });
}
