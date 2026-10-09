import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, BlockList } from 'node:net';
import { Webhook } from 'standardwebhooks';

export type CallbackResponse={status:number;body:string};
export interface CallbackTransport {post(url:string,body:string,headers:Record<string,string>,assertAllowed:()=>void):Promise<CallbackResponse>}
// Conservatively IPv4 only; no IPv6/mapped fallback. Reserved/non-global ranges denied.
const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip,prefix,'ipv4');
export function publicIPv4(ip:string) {return isIP(ip)===4&&!blocked.check(ip,'ipv4');}
export function callbackUrl(raw:string,allowedHosts:readonly string[]) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||isIP(u.hostname)||!allowedHosts.includes(u.hostname)) throw new Error('callback_url_denied');
  return u;
}
export function validateSecret(secret:string) {
  if(!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('invalid_signing_secret');
  const text=secret.slice(6);const b=Buffer.from(text,'base64');
  if(b.length<24||b.length>64||b.toString('base64')!==text) throw new Error('invalid_signing_secret');
}
export function signedHeaders(id:string,body:string,subscriptionId:string,secret:string,now:number,oldSecret?:string) {
  validateSecret(secret);const date=new Date(now);
  let signature=new Webhook(secret).sign(id,date,body);
  if(oldSecret) {validateSecret(oldSecret);signature+=' '+new Webhook(oldSecret).sign(id,date,body);}
  return {'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(now/1000)),'webhook-signature':signature,'X-MCP-Subscription-Id':subscriptionId};
}
export class PinnedHttps implements CallbackTransport {
  constructor(readonly allowedHosts:readonly string[],readonly resolve=(host:string)=>lookup(host,{all:true,family:4}),readonly connect=request) {}
  async post(raw:string,body:string,headers:Record<string,string>,assertAllowed:()=>void):Promise<CallbackResponse> {
    assertAllowed();
    const u=callbackUrl(raw,this.allowedHosts);
    if(Buffer.byteLength(body)>262144) throw new Error('payload_too_large');
    let dnsTimer:ReturnType<typeof setTimeout>|undefined;
    let records:Awaited<ReturnType<typeof this.resolve>>;
    try {records=await Promise.race([this.resolve(u.hostname),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('dns_timeout')),3000);dnsTimer.unref();})]);}
    finally {if(dnsTimer) clearTimeout(dnsTimer);}
    if(!records.length||records.some(x=>x.family!==4||!publicIPv4(x.address))) throw new Error('callback_address_denied');
    const ip=records[0]!.address;
    // DNS is asynchronous. A request that has not reached the network must still
    // obey stop, unsubscribe, TTL and identity revocation after DNS preparation.
    assertAllowed();
    return new Promise((resolve,reject)=>{
      const req=this.connect(u,{method:'POST',headers,agent:false,servername:u.hostname,family:4,rejectUnauthorized:true,
        lookup:(_host,_opts,cb)=>cb(null,ip,4)},res=>{
        let result='';res.setEncoding('utf8');
        res.on('data',(chunk:string)=>{result+=chunk;if(Buffer.byteLength(result)>8192) req.destroy(new Error('response_too_large'));});
        res.on('end',()=>resolve({status:res.statusCode??500,body:result}));
        res.on('error',()=>reject(new Error('callback_response_failed')));
      });
      const timer=setTimeout(()=>req.destroy(new Error('callback_timeout')),10000);timer.unref();
      req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new Error('callback_failed')));
      req.end(body); // https.request does not follow redirects; TLS hostname/cert validation stays enabled.
    });
  }
}
