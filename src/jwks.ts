import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { JwksProvider } from './auth.js';
import { publicIPv4 } from './callback.js';
import { fixedHttpsUrl } from './oauth.js';

export type JwksNetwork={resolve?:typeof lookup;connect?:typeof request;now?:()=>number};
// Only a trusted fixed issuer selects the endpoint. JWT/header URLs never do.
export class HttpsJwksProvider implements JwksProvider {
  private readonly endpoint:URL;
  private readonly resolve:typeof lookup;
  private readonly connect:typeof request;
  private readonly now:()=>number;
  private pending=false;
  private retryAfter=0;
  constructor(issuer:string,private readonly options:{timeoutMs?:number;failureCooldownMs?:number;jwksUrl?:string}={},network:JwksNetwork={}) {
    const u=new URL(issuer);
    if(options.jwksUrl) {fixedHttpsUrl(issuer);fixedHttpsUrl(options.jwksUrl);}
    else if(u.protocol!=='https:'||u.origin!==issuer||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.port||isIP(u.hostname))throw new Error('jwks_policy_invalid');
    for(const n of [options.timeoutMs??3000,options.failureCooldownMs??1000])if(!Number.isInteger(n)||n<20||n>60000)throw new Error('jwks_policy_invalid');
    this.endpoint=options.jwksUrl?new URL(options.jwksUrl):new URL('/cdn-cgi/access/certs',u);this.resolve=network.resolve??lookup;this.connect=network.connect??request;this.now=network.now??Date.now;
  }
  async load(signal:AbortSignal):Promise<string> {
    if(signal.aborted||this.pending||this.now()<this.retryAfter)throw new Error('jwks_unavailable');
    this.pending=true;const controller=new AbortController();
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.options.timeoutMs??3000);
    const work=this.read(controller.signal);
    // DNS lookup may ignore cancellation. Hold the single-flight slot until
    // the underlying preparation actually settles; late DNS cannot submit GET.
    void work.finally(()=>{this.pending=false;}).catch(()=>{});
    let interrupted!:()=>void;
    const cancelled=new Promise<never>((_,reject)=>{interrupted=()=>reject(new Error('jwks_unavailable'));controller.signal.addEventListener('abort',interrupted,{once:true});if(controller.signal.aborted)interrupted();});
    try {return await Promise.race([work,cancelled]);}
    catch {this.retryAfter=this.now()+(this.options.failureCooldownMs??1000);throw new Error('jwks_unavailable');}
    finally {clearTimeout(timer);signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',interrupted);}
  }
  private async read(signal:AbortSignal):Promise<string> {
    if(signal.aborted)throw new Error('jwks_unavailable');
    const records=await this.resolve(this.endpoint.hostname,{all:true,family:4});
    if(signal.aborted||!records.length||records.some(r=>r.family!==4||!publicIPv4(r.address)))throw new Error('jwks_unavailable');
    const ip=records[0]!.address;
    return new Promise((resolve,reject)=>{
      let settled=false;let req:ReturnType<typeof request>|undefined;
      const finish=(error?:Error,body?:string)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error){reject(new Error('jwks_unavailable'));req?.destroy();}else resolve(body!);};
      const abort=()=>finish(new Error('aborted'));signal.addEventListener('abort',abort,{once:true});
      try {
        if(signal.aborted){abort();return;}
        req=this.connect(this.endpoint,{method:'GET',agent:false,servername:this.endpoint.hostname,rejectUnauthorized:true,family:4,maxHeaderSize:16384,
          headers:{Accept:'application/json','Accept-Encoding':'identity'},lookup:(_host,_options,callback)=>callback(null,ip,4)},res=>{
          if(settled){res.destroy();return;}
          const type=String(res.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();
          const length=res.headers['content-length'];
          if(res.statusCode!==200||type!=='application/json'||(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')||(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>65536))) {finish(new Error('response_denied'));res.destroy();return;}
          let bytes=0;const chunks:Buffer[]=[];
          res.on('data',(chunk:Buffer)=>{if(settled)return;if(!Buffer.isBuffer(chunk)){finish(new Error('encoding_denied'));return;}bytes+=chunk.length;if(bytes>65536||chunks.length>=128){finish(new Error('response_limit'));res.destroy();return;}chunks.push(chunk);});
          res.on('aborted',()=>finish(new Error('response_aborted')));res.on('error',()=>finish(new Error('response_failed')));
          res.on('close',()=>{if(!settled)finish(new Error('response_incomplete'));});
          res.on('end',()=>{
            if(settled)return;
            try {
              if(signal.aborted||(length!==undefined&&Number(length)!==bytes))throw new Error('response_incomplete');
              const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));
              const json=JSON.parse(raw);if(!json||!Array.isArray(json.keys)||json.keys.length<1||json.keys.length>8)throw new Error('jwks_invalid');
              finish(undefined,raw);
            } catch {finish(new Error('jwks_invalid'));}
          });
        });
        req.on('error',()=>finish(new Error('request_failed')));req.on('close',()=>{if(!settled)finish(new Error('request_incomplete'));});
        if(signal.aborted){abort();return;}req.end(); // Native HTTPS does not follow redirects.
      } catch {finish(new Error('request_failed'));}
    });
  }
}
