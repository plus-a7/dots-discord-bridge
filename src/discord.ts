import { Client, GatewayIntentBits, Events, PermissionFlagsBits, type Message as DiscordMessage, type GuildBasedChannel } from 'discord.js';
import { Bridge, ResourceUnavailable, guildScope, originAllowed, type Origin, type RecordMessage, type DiscordSender } from './core.js';

export function normalize(m:DiscordMessage,bridgeBotId:string) {
  if(!m.guildId||!('guildId' in m.channel)||m.channel.guildId!==m.guildId||!m.channel.isTextBased()||m.partial||m.system) return null;
  if(m.channel.isThread()&&!m.channel.parentId) return null;
  return {id:m.id,guildId:m.guildId,channelId:m.channel.isThread()?m.channel.parentId!:m.channel.id,threadId:m.channel.isThread()?m.channel.id:null,authorId:m.author.id,bot:m.author.bot,webhook:!!m.webhookId,mentionsBridge:m.mentions.users.has(bridgeBotId),content:m.content,timestamp:m.createdTimestamp};
}
export function makeClient() {
  // SDK otherwise reads an inherited token in its constructor. No implicit
  // credential or sharding-manager reuse; the bootstrap passes one file token.
  if('DISCORD_TOKEN' in process.env||'SHARDING_MANAGER' in process.env)throw new Error('discord_environment_conflict');
  return new Client({shards:[0],shardCount:1,intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[],repliedUser:false},rest:{timeout:10000,retries:0,rejectOnRateLimit:()=>true}});
}
function sameOrigin(channel:GuildBasedChannel,b:Origin) {
  return channel.guildId===b.guildId&&channel.id===(b.threadId??b.channelId)&&
    (b.threadId!==null?channel.isThread()&&channel.parentId===b.channelId&&!channel.archived&&!channel.locked:!channel.isThread());
}
export class DiscordJsSender implements DiscordSender {
  constructor(readonly client:Client,readonly bridgeConfig:Bridge['config']) {}
  async send(m:RecordMessage,content:string,assertAllowed:()=>void) {
    if(!originAllowed(this.bridgeConfig,m)) throw new Error('destination_denied');
    assertAllowed();
    const channel=await this.client.channels.fetch(m.threadId??m.channelId,{force:true});
    if(!channel||!('guildId' in channel)||!sameOrigin(channel,m)||!channel.isTextBased()||!channel.isSendable()) throw new Error('origin_unavailable');
    if(!this.client.user||this.client.user.id!==this.bridgeConfig.bridgeBotId||!channel.permissionsFor(this.client.user)?.has([PermissionFlagsBits.ViewChannel,m.threadId?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages])) throw new Error('origin_permission_denied');
    assertAllowed(); // Recheck owner stop, subscription expiry and total deadline after fetching.
    const response=await channel.send({content,nonce:m.id,enforceNonce:true,allowedMentions:{parse:[],users:[],roles:[],repliedUser:false}});
    return response.id;
  }
}
export function attachGateway(client:Client,bridge:Bridge,onStatus:(code:string)=>void) {
  const message=(m:DiscordMessage)=>{try {if(!client.isReady()||client.user.id!==bridge.config.bridgeBotId) {onStatus('discord_identity_unconfirmed');return;}const normalized=normalize(m,bridge.config.bridgeBotId);if(normalized) bridge.ingest(normalized);} catch {onStatus('ingest_failed');}};
  const error=()=>onStatus('discord_error');
  client.on(Events.MessageCreate,message);client.on(Events.Error,error);
  // No login here. Credentials and an exclusive connection require separate approval.
  return ()=>{client.off(Events.MessageCreate,message);client.off(Events.Error,error);};
}
export function gatewayAdapter(client:Client) {return {isReady:()=>client.isReady(),attach:(bridge:Bridge,onStatus:(code:string)=>void)=>attachGateway(client,bridge,onStatus),destroy:()=>client.destroy()};}

// Dynamic origin resolver must be the persistent Bridge.binding function. No permission
// grants, channel creation, membership changes or archive reopening occur here.
export function resourceAccessGuard(client:Client,config:Bridge['config'],resolveOrigin?:(caseId:string)=>Origin) {
  return async (principal:string,caseId:string)=>{
    if(principal!==config.principal) throw new Error('resource_access_denied');
    if(!client.isReady()) throw new ResourceUnavailable();
    if(client.user.id!==config.bridgeBotId) throw new Error('resource_access_denied');
    if(config.mode==='guild_owner'&&caseId===guildScope(config.guildId!)) {
      // Guild visibility permits registering interest; each actual message has its own
      // fresh channel permission check before disclosure or delivery.
      if(!client.guilds.cache.has(config.guildId!)) throw new Error('resource_access_denied');return;
    }
    const b=config.mode==='guild_owner'?resolveOrigin?.(caseId):config.cases.find(c=>c.caseId===caseId);
    if(!b||!originAllowed(config,{...b,caseId} as RecordMessage)) throw new Error('resource_access_denied');
    let channel;
    try {channel=await client.channels.fetch(b.threadId??b.channelId,{force:true});} catch(error) {const status=(error as {status?:number}).status;if(status===403||status===404) throw new Error('resource_access_denied');throw new ResourceUnavailable();}
    if(!client.isReady()) throw new ResourceUnavailable();
    if(client.user.id!==config.bridgeBotId||!channel||!('guildId' in channel)||!sameOrigin(channel,b)||!channel.isTextBased()||!channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('resource_access_denied');
  };
}
