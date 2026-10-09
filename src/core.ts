import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AuthorizationGrant } from './auth.js';

const snowflake = z.string().regex(/^[0-9]{17,20}$/);
export const configSchema = z.object({
  ownerUserId: snowflake, bridgeBotId: snowflake, principal: z.string().min(1),
  mode:z.enum(['fixed_cases','guild_owner']).default('fixed_cases'), guildId:snowflake.optional(),
  cases: z.array(z.object({caseId:z.string().min(1).max(80), guildId:snowflake, channelId:snowflake, threadId:snowflake}).strict()).max(10).default([]),
  maxOrigins:z.number().int().min(1).max(1000).default(100),
  maxSubscriptions:z.number().int().min(1).max(100).default(32),
  allowedUsers: z.array(snowflake).default([]), allowedBots: z.array(snowflake).default([]),
  maxReplies: z.number().int().min(1).max(20).default(8),
  maxCaseMs: z.number().int().min(1000).max(3600000).default(1800000),
  replyTimeoutMs:z.number().int().min(50).max(10000).default(10000),
  maxRecords: z.number().int().min(1).max(10000).default(1000)
}).strict().superRefine((c,ctx)=>{
  if(c.mode==='guild_owner' ? !c.guildId||c.cases.length>0||c.allowedUsers.length>0||c.allowedBots.length>0 : c.cases.length===0)
    ctx.addIssue({code:'custom',message:'guild_owner requires one guild and owner-only dynamic origins; fixed_cases requires cases'});
  if(new Set(c.cases.map(x=>x.caseId)).size!==c.cases.length || new Set(c.cases.map(x=>x.threadId)).size!==c.cases.length)
    ctx.addIssue({code:'custom',message:'cases must have unique case and thread IDs'});
});
export type Config = z.infer<typeof configSchema>;
export type Origin = {guildId:string;channelId:string;threadId:string|null};
export type Message = Origin & {id:string;authorId:string;bot:boolean;webhook:boolean;mentionsBridge:boolean;content:string;timestamp:number};
export const guildScope=(guildId:string)=>'guild_'+guildId;
export const originCaseId=(m:Origin)=>'origin_'+m.guildId+'_'+m.channelId+'_'+(m.threadId??'channel');
export function originAllowed(config:Config,m:RecordMessage) {
  return config.mode==='guild_owner' ? m.guildId===config.guildId&&m.caseId===originCaseId(m) : config.cases.some(c=>c.caseId===m.caseId&&c.guildId===m.guildId&&c.channelId===m.channelId&&c.threadId===m.threadId);
}
export type RecordMessage = Message & {caseId:string;provenance:'owner'|'third_party'|'allowed_bot';authorization:false};
export type Subscription = {id:string;principal:string;caseId:string;url:string;secret:string;oldSecret?:string;rotateUntil?:number;expires:number;active:boolean;authorization?:AuthorizationGrant};
export type Delivery = {key:string;subscriptionId:string;messageId:string;eventId:string;status:'pending'|'accepted'|'dead';attempts:number;nextAt:number};
export type Reply = {key:string;subscriptionId:string;messageId:string;content:string;status:'reserved'|'sent'|'uncertain';discordId?:string};
type State = {messages:Record<string,RecordMessage>;subscriptions:Record<string,Subscription>;deliveries:Record<string,Delivery>;replies:Record<string,Reply>;cases:Record<string,{stopped:boolean;started:number;replies:number}>;origins:Record<string,Origin>;guildStopped:boolean};

// One process, small atomic SQLite snapshot. No JSON/secret/message logging.
export class Store {
  private db:DatabaseSync;
  private lockDb?:DatabaseSync;
  state:State;
  constructor(path:string) {
    if(path!==':memory:') {
      mkdirSync(dirname(path),{recursive:true,mode:0o700}); chmodSync(dirname(path),0o700);
      // SQLite holds an OS lock until this process exits, including SIGKILL. No stale PID file.
      const lock=new DatabaseSync(path+'.lock.sqlite');
      try {chmodSync(path+'.lock.sqlite',0o600);lock.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE');this.lockDb=lock;}
      catch {lock.close();throw new Error('store_already_in_use');}
    }
    try {
      this.db=new DatabaseSync(path);
      if(path!==':memory:') chmodSync(path,0o600);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      const row=this.db.prepare('SELECT value FROM state WHERE id=1').get() as {value:string}|undefined;
      this.state=row?JSON.parse(row.value):{messages:{},subscriptions:{},deliveries:{},replies:{},cases:{},origins:{},guildStopped:false};
      this.state.origins??={};this.state.guildStopped??=false;
      // A crash after external acceptance is ambiguous: never blindly resend a reply.
      for(const reply of Object.values(this.state.replies)) if(reply.status==='reserved') reply.status='uncertain';
      this.save();
    } catch { this.lockDb?.close(); throw new Error('store_open_failed'); }
  }
  save() {this.db.prepare('INSERT INTO state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(this.state));}
  close() {this.db.close();this.lockDb?.close();this.lockDb=undefined;}
}
export class ResourceUnavailable extends Error {constructor(){super('resource_unavailable');}}
export interface DiscordSender {send(m:RecordMessage,content:string,assertAllowed:()=>void):Promise<string>}
export class Bridge {
  busy=false;
  constructor(readonly config:Config,readonly store:Store,readonly sender:DiscordSender,readonly now=Date.now,readonly admit:()=>void=()=>{}) {}
  authorize(principal:string) {this.admit();if(principal!==this.config.principal) throw new Error('unauthorized');}
  sameBinding(m:RecordMessage) {
    const c=this.binding(m.caseId);if(c.guildId!==m.guildId||c.channelId!==m.channelId||c.threadId!==m.threadId) throw new Error('destination_revoked');
    if(this.config.mode==='guild_owner'&&(m.authorId!==this.config.ownerUserId||m.bot||m.webhook||m.provenance!=='owner')) throw new Error('source_revoked');
  }
  binding(caseId:string):Origin {
    const c=this.config.mode==='guild_owner'?this.store.state.origins[caseId]:this.config.cases.find(x=>x.caseId===caseId);
    if(!c||(this.config.mode==='guild_owner'&&(c.guildId!==this.config.guildId||originCaseId(c)!==caseId))) throw new Error('forbidden_case');return c;
  }
  scope(caseId:string) {if(this.config.mode==='guild_owner'&&caseId===guildScope(this.config.guildId!)) {if(this.store.state.guildStopped) throw new Error('guild_stopped');return;}this.usable(caseId);}
  matches(s:Subscription,m:RecordMessage) {return s.caseId===(this.config.mode==='guild_owner'?guildScope(this.config.guildId!):m.caseId);}
  usable(caseId:string) {
    if(this.config.mode==='guild_owner'&&this.store.state.guildStopped) throw new Error('guild_stopped');
    this.binding(caseId); const c=this.store.state.cases[caseId];
    if(c && (c.stopped || this.now()-c.started>=this.config.maxCaseMs || c.replies>=this.config.maxReplies)) throw new Error('case_stopped_or_limit');
  }
  ingest(m:Message):string {
    try {this.admit();} catch {return 'paused';}
    if(![m.id,m.guildId,m.channelId,m.authorId,...(m.threadId?[m.threadId]:[])].every(id=>snowflake.safeParse(id).success)) return 'excluded';
    const c=this.config.mode==='guild_owner'?(m.guildId===this.config.guildId?{...m,caseId:originCaseId(m)}:undefined):this.config.cases.find(x=>x.guildId===m.guildId&&x.channelId===m.channelId&&x.threadId===m.threadId);
    if(!c||m.webhook||m.authorId===this.config.bridgeBotId||!Number.isFinite(m.timestamp)||m.timestamp>this.now()+60000||m.timestamp<this.now()-this.config.maxCaseMs) return 'excluded';
    let provenance:RecordMessage['provenance'];
    if(!m.bot&&m.authorId===this.config.ownerUserId) provenance='owner';
    else if(this.config.mode==='fixed_cases'&&m.bot&&this.config.allowedBots.includes(m.authorId)&&m.mentionsBridge) provenance='allowed_bot';
    else if(this.config.mode==='fixed_cases'&&!m.bot&&this.config.allowedUsers.includes(m.authorId)&&m.mentionsBridge) provenance='third_party';
    else return 'excluded';
    if(this.store.state.messages[m.id]) return 'duplicate';
    if(this.config.mode==='guild_owner'&&m.content.trim()==='/bridge-stop-all') {
      this.store.state.guildStopped=true;for(const s of Object.values(this.store.state.subscriptions)) s.active=false;this.store.save();return 'stopped';
    }
    if(this.config.mode==='guild_owner'&&!this.store.state.origins[c.caseId]) {
      if(Object.keys(this.store.state.origins).length>=this.config.maxOrigins||!m.content||m.content.length>8000||Object.keys(this.store.state.messages).length>=this.config.maxRecords||this.store.state.guildStopped) return 'empty_or_full';
      this.store.state.origins[c.caseId]={guildId:m.guildId,channelId:m.channelId,threadId:m.threadId};
    }
    if(provenance==='owner'&&m.content.trim()==='/bridge-stop') {
      this.stop(c.caseId); return 'stopped';
    }
    try {this.usable(c.caseId);} catch {return 'limited';}
    if(!m.content||m.content.length>8000||Object.keys(this.store.state.messages).length>=this.config.maxRecords) return 'empty_or_full';
    this.store.state.cases[c.caseId]??={stopped:false,started:this.now(),replies:0};
    const record:RecordMessage={...m,caseId:c.caseId,provenance,authorization:false};
    this.store.state.messages[m.id]=record;
    for(const s of Object.values(this.store.state.subscriptions)) if(this.matches(s,record)&&s.active&&s.expires>this.now()) {
      const key=s.id+':'+m.id;
      this.store.state.deliveries[key]={key,subscriptionId:s.id,messageId:m.id,eventId:'discord_'+m.id,status:'pending',attempts:0,nextAt:this.now()};
    }
    this.store.save();return 'queued';
  }
  stop(caseId:string) {
    this.binding(caseId);
    this.store.state.cases[caseId]??={stopped:false,started:this.now(),replies:0};
    this.store.state.cases[caseId]!.stopped=true;
    for(const s of Object.values(this.store.state.subscriptions)) if(s.caseId===caseId) s.active=false;
    this.store.save();
  }
  subscription(principal:string,id:string) {
    this.authorize(principal);const s=this.store.state.subscriptions[id];
    if(!s||s.principal!==principal||!s.active||s.expires<=this.now()) throw new Error('forbidden_subscription');
    this.scope(s.caseId);return s;
  }
  read(principal:string,subscriptionId:string,eventId:string) {
    const s=this.subscription(principal,subscriptionId);
    const d=Object.values(this.store.state.deliveries).find(x=>x.subscriptionId===s.id&&x.eventId===eventId&&x.attempts>0);
    const m=d&&this.store.state.messages[d.messageId];
    if(!m||!this.matches(s,m)) throw new Error('forbidden_event');
    this.sameBinding(m);this.usable(m.caseId);
    // Third-party and bot text cannot grant owner approval. Even owner identity is not a blanket instruction grant.
    return {message:m,reply:this.store.state.replies[s.id+':'+m.id]?.status??'none'};
  }
  async reply(principal:string,subscriptionId:string,eventId:string,content:string,requestAllowed:()=>void=()=>{}) {
    requestAllowed();
    this.authorize(principal);
    const previous=Object.values(this.store.state.replies).find(r=>r.subscriptionId===subscriptionId&&eventId==='discord_'+r.messageId);
    if(previous) {
      const s=this.store.state.subscriptions[subscriptionId];const m=this.store.state.messages[previous.messageId];
      if(!s||s.principal!==principal||!m) throw new Error('forbidden_reply');this.sameBinding(m);
      if(previous.content!==content) throw new Error('idempotency_conflict');
      return {status:previous.status,discordId:previous.discordId};
    }
    const {message:m}=this.read(principal,subscriptionId,eventId);const key=subscriptionId+':'+m.id;
    if(!content.trim()||content.length>2000) throw new Error('invalid_reply');
    if(this.busy) throw new Error('concurrency_limit');
    this.usable(m.caseId);this.busy=true;
    const controller=new AbortController();
    // Limit reservation happens before awaiting. Guard below permits the reserved final reply.
    const assertAllowed=()=>{
      requestAllowed();
      if(controller.signal.aborted) throw new Error('reply_timeout');
      this.authorize(principal);this.sameBinding(m);
      const s=this.store.state.subscriptions[subscriptionId];const c=this.store.state.cases[m.caseId];
      if(!s?.active||s.expires<=this.now()||!c||c.stopped||this.store.state.guildStopped||this.now()-c.started>=this.config.maxCaseMs) throw new Error('reply_revoked');
    };
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      this.store.state.cases[m.caseId]!.replies++;
      this.store.state.replies[key]={key,subscriptionId,messageId:m.id,content,status:'reserved'};this.store.save();
      const operation=this.sender.send(m,content,assertAllowed);
      // Keep the concurrency gate until an in-flight sender settles, even after a timeout response.
      const settled=operation.finally(()=>{this.busy=false;});
      try {
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('reply_timeout'));},this.config.replyTimeoutMs);});
        const id=await Promise.race([settled,timeout]);
        this.store.state.replies[key]!.status='sent';this.store.state.replies[key]!.discordId=id;this.store.save();
        return {status:'sent',discordId:id};
      } catch {
        this.store.state.replies[key]!.status='uncertain';this.store.save();return {status:'uncertain'};
      }
    } catch {this.busy=false;throw new Error('reply_reservation_failed');}
    finally {if(timer) clearTimeout(timer);}
  }
}
