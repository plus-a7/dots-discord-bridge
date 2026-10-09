import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export type FetchEndpoint=(request:Request)=>Promise<Response>;
export class LoopbackHttp {
  private readonly server;
  private started=false;
  private accepting=false;
  private stopRequested=false;
  private active=0;
  private closed=true;
  private readonly controllers=new Set<AbortController>();
  constructor(private readonly endpoint:FetchEndpoint,private readonly externalHost:string,private readonly options:{port?:number;maxRequests?:number;timeoutMs?:number;ingress?:'forwarded_https'|'tunnel_loopback';metadataPaths?:readonly string[]}={}) {
    const url=new URL('https://'+externalHost);
    if(url.host!==externalHost||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new Error('invalid_http_host');
    const port=options.port??0,max=options.maxRequests??8,timeout=options.timeoutMs??15000;
    if(!Number.isInteger(port)||port<0||port>65535||!Number.isInteger(max)||max<1||max>32||!Number.isInteger(timeout)||timeout<50||timeout>30000) throw new Error('invalid_http_limits');
    this.server=createServer({maxHeaderSize:16384,requestTimeout:timeout,headersTimeout:Math.min(timeout,5000)},(req,res)=>{void this.handle(req,res);});
    this.server.maxConnections=max;this.server.maxRequestsPerSocket=1;
    this.server.on('upgrade',(_req,socket)=>socket.destroy());
    this.server.on('clientError',(_error,socket)=>socket.destroy());
    this.server.on('error',()=>{}); // Never log raw request/parser errors.
  }
  get pending() {return this.active;}
  get drained() {return this.active===0&&this.closed&&!this.server.listening;}
  async start():Promise<number> {
    if(this.started) throw new Error('http_already_started');this.started=true;this.closed=false;
    try {
      await new Promise<void>((resolve,reject)=>{
        const error=()=>{cleanup();reject(new Error('http_start_failed'));};
        const ready=()=>{cleanup();resolve();};
        const cleanup=()=>{this.server.off('error',error);this.server.off('listening',ready);};
        this.server.once('error',error);this.server.once('listening',ready);
        this.server.listen(this.options.port??0,'127.0.0.1');
      });
      if(this.stopRequested) {this.server.close(()=>{this.closed=true;});throw new Error('http_start_cancelled');}
      this.accepting=true;const address=this.server.address();
      if(!address||typeof address==='string'||address.address!=='127.0.0.1') throw new Error('http_start_failed');return address.port;
    } catch {this.accepting=false;if(this.server.listening)this.server.close(()=>{this.closed=true;});else this.closed=true;throw new Error('http_start_failed');}
  }
  stopAccepting() {
    this.stopRequested=true;this.accepting=false;for(const c of this.controllers)c.abort();
    // Closing before the pending listen emits 'listening' can cancel that event
    // and strand start(). The start path observes stopRequested and closes then.
    if(this.server.listening&&!this.closed) {this.server.close(()=>{this.closed=true;});this.server.closeIdleConnections();}
  }
  forceClose() {this.server.closeAllConnections();}
  private async handle(req:IncomingMessage,res:ServerResponse) {
    const reject=(status:number)=>{res.writeHead(status,{'Connection':'close','Cache-Control':'no-store'});res.end();req.resume();};
    if(!this.accepting) {reject(503);return;}
    if(this.active>=(this.options.maxRequests??8)) {reject(503);return;}
    if(!(req.url==='/mcp'&&req.method==='POST')&&!(this.options.metadataPaths?.includes(req.url??'')&&req.method==='GET')) {reject(404);return;}
    const critical=new Map<string,number>();
    for(let i=0;i<req.rawHeaders.length;i+=2) {const name=req.rawHeaders[i]!.toLowerCase();critical.set(name,(critical.get(name)??0)+1);}
    const address=this.server.address();const expectedHost=this.options.ingress==='tunnel_loopback'&&address&&typeof address!=='string'?'127.0.0.1:'+address.port:this.externalHost;
    if(['host','authorization','cf-access-jwt-assertion','content-length','transfer-encoding'].some(h=>(critical.get(h)??0)>1)||req.headers.host!==expectedHost) {reject(403);return;}
    if(req.method==='GET'&&(req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined)) {reject(400);return;}
    this.active++;const controller=new AbortController();this.controllers.add(controller);
    const disconnected=()=>{if(!res.writableFinished)controller.abort();};res.on('close',disconnected);
    const timer=setTimeout(()=>{controller.abort();if(!res.headersSent)reject(504);else res.destroy();},this.options.timeoutMs??15000);
    try {
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers)) {if(typeof value==='string')headers.set(name,value);else if(value)headers.set(name,value.join(','));}
      // Fixed external URL. Forwarded host/proto never choose the resource.
      // Logical internal origin stays separate from the OAuth resource URI.
      const request=new Request('https://'+this.externalHost+req.url,{method:req.method,headers,...(req.method==='POST'?{body:Readable.toWeb(req),duplex:'half'}:{}),signal:controller.signal} as RequestInit);
      const response=await this.endpoint(request);
      if(controller.signal.aborted||res.writableEnded)return;
      const bytes=await boundedResponse(response,controller.signal);
      if(controller.signal.aborted||res.writableEnded)return;
      const outgoing:Record<string,string>={'Connection':'close','Cache-Control':'no-store'};
      for(const key of ['content-type','www-authenticate','allow']) {const value=response.headers.get(key);if(value)outgoing[key]=value;}
      res.writeHead(response.status,outgoing);res.end(bytes);
    } catch {if(!res.headersSent&&!res.writableEnded)reject(controller.signal.aborted?503:500);else if(!res.writableEnded)res.destroy();}
    finally {clearTimeout(timer);this.controllers.delete(controller);this.active--;res.off('close',disconnected);if(!req.complete)req.destroy();}
  }
}

// Abort and byte/chunk caps apply while reading, before accumulating a body.
// Cancellation is best-effort: an untrusted stream cannot hold the active slot.
async function boundedResponse(response:Response,signal:AbortSignal) {
  if(signal.aborted)throw new Error('response_cancelled');
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();
  let abort!:()=>void;
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('response_cancelled'));signal.addEventListener('abort',abort,{once:true});});
  let size=0;const chunks:Uint8Array[]=[];
  try {
    while(true) {
      const next=await Promise.race([reader.read(),cancelled]);
      if(signal.aborted)throw new Error('response_cancelled');
      if(next.done)break;
      size+=next.value.length;if(size>262144||chunks.length>=128)throw new Error('response_limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks,size);
  } catch(error) {void reader.cancel().catch(()=>{});throw error;}
  finally {signal.removeEventListener('abort',abort);}
}
