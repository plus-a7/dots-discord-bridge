import { Bridge, ResourceUnavailable, Store, configSchema, type Config, type DiscordSender } from './core.js';
import { EventsAdapter } from './events.js';
import type { CallbackTransport } from './callback.js';
import type { RequestAuthenticator } from './auth.js';
import { makeAuthenticatedEndpoint } from './mcp.js';
import { LoopbackHttp } from './http.js';

export interface GatewayAdapter {
  isReady():boolean;
  attach(bridge:Bridge,onStatus:(code:string)=>void):()=>void;
  destroy():Promise<void>;
}
export class DeliveryWorker {
  private running=false;
  private started=false;
  private timer?:ReturnType<typeof setTimeout>;
  private work?:Promise<unknown>;
  constructor(private readonly events:EventsAdapter,private readonly ready:()=>boolean,private readonly intervalMs=100,private readonly onStatus:(code:string)=>void=()=>{}) {
    if(!Number.isInteger(intervalMs)||intervalMs<5||intervalMs>10000)throw new Error('invalid_worker_interval');
  }
  get pending() {return !!this.work;}
  start() {if(this.started)throw new Error('worker_already_started');this.started=true;this.running=true;this.poll();}
  stop() {this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  private poll() {
    if(!this.running)return;
    const work=Promise.resolve().then(async()=>{if(this.running&&this.ready())await this.events.dispatchOne();}).catch(()=>{try {this.onStatus('dispatch_failed');} catch {}});
    this.work=work;
    void work.finally(()=>{if(this.work===work)this.work=undefined;if(this.running)this.timer=setTimeout(()=>this.poll(),this.intervalMs);});
  }
}
export type RuntimeOptions={config:Config;statePath:string;sender:DiscordSender;gateway:GatewayAdapter;callback:CallbackTransport;callbackHosts:readonly string[];resourceAccess:(principal:string,caseId:string)=>Promise<void>;auth:RequestAuthenticator;externalHost:string;ingress?:'forwarded_https'|'tunnel_loopback';port?:number;pollMs?:number;requestTimeoutMs?:number;onStatus?:(code:string)=>void};
export class BridgeRuntime {
  readonly store:Store;readonly bridge:Bridge;readonly events:EventsAdapter;readonly http:LoopbackHttp;readonly worker:DeliveryWorker;
  private phase:'new'|'starting'|'running'|'stopping'|'stopped'='new';
  private startup?:Promise<number>;
  private startingBusy=false;
  private detach?:()=>void;
  private gatewayClosed=false;
  private destroyWork?:Promise<void>;
  private drainWork?:Promise<{clean:boolean;pending:boolean}>;
  private readonly endpoint:ReturnType<typeof makeAuthenticatedEndpoint>;
  constructor(private readonly options:RuntimeOptions) {
    const config=configSchema.parse(options.config);
    this.store=new Store(options.statePath);
    try {
    const admit=()=>{if(this.phase!=='running'||!options.gateway.isReady())throw new ResourceUnavailable();};
    this.bridge=new Bridge(config,this.store,options.sender,Date.now,admit);
    this.events=new EventsAdapter(this.bridge,options.callback,options.callbackHosts,options.resourceAccess,grant=>options.auth.assertGrant?.(grant));
    this.endpoint=makeAuthenticatedEndpoint(this.bridge,this.events,options.auth,options.externalHost,admit);
    this.http=new LoopbackHttp(this.endpoint,options.externalHost,{port:options.port,timeoutMs:options.requestTimeoutMs,ingress:options.ingress,metadataPaths:options.auth.metadata?[options.auth.metadata.path,...options.auth.metadata.aliases??[]]:[]});
    this.worker=new DeliveryWorker(this.events,()=>this.phase==='running'&&options.gateway.isReady(),options.pollMs,options.onStatus);
    } catch {this.store.close();throw new Error('runtime_configuration_failed');}
  }
  start():Promise<number> {
    if(this.phase==='starting')return this.startup!;
    if(this.phase!=='new')return Promise.reject(new Error('runtime_already_started'));
    this.phase='starting';this.startingBusy=true;
    this.startup=(async()=>{
      try {
        const port=await this.http.start();
        if(this.phase!=='starting') {this.http.stopAccepting();throw new Error('runtime_start_cancelled');}
        this.detach=this.options.gateway.attach(this.bridge,this.options.onStatus??(()=>{}));
        this.phase='running';this.worker.start();return port;
      } catch {this.phase='stopping';this.http.stopAccepting();this.beginDestroy();throw new Error('runtime_start_failed');}
      finally {this.startingBusy=false;}
    })();return this.startup;
  }
  private beginDestroy() {
    if(this.destroyWork)return;
    this.destroyWork=Promise.resolve().then(()=>this.options.gateway.destroy()).then(()=>{this.gatewayClosed=true;},()=>{this.gatewayClosed=false;});
  }
  private drained() {return !this.startingBusy&&this.gatewayClosed&&this.http.drained&&!this.endpoint.isBusy()&&!this.worker.pending&&!this.events.isBusy()&&!this.bridge.busy;}
  async stop(timeoutMs=10000):Promise<{clean:boolean;pending:boolean}> {
    if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw new Error('invalid_drain_timeout');
    if(this.phase==='stopped')return {clean:true,pending:false};
    if(this.drainWork)return this.drainWork;
    // Revoke admission synchronously, before any await or external cleanup.
    this.phase='stopping';this.worker.stop();this.http.stopAccepting();this.options.auth.close?.();
    try {this.detach?.();} catch {}this.detach=undefined;this.beginDestroy();
    this.drainWork=(async()=>{
      const until=Date.now()+timeoutMs;
      while(!this.drained()&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
      if(!this.drained()) {this.http.forceClose();return {clean:false,pending:true};}
      this.store.close();this.phase='stopped';return {clean:true,pending:false};
    })();
    try {return await this.drainWork;} finally {this.drainWork=undefined;}
  }
}
