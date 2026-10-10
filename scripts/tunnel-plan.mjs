import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeploymentFile, assertPrivateDirectory } from '../dist/src/config-file.js';
import { parseOAuthSetup } from '../dist/src/oauth-setup.js';

export const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
export const directory=join(root,'private','tunnel-metadata');
export const provisionalResource='https://tunnel-bootstrap.invalid/mcp';
export const installedClient='/opt/homebrew/Cellar/tunnel-client/0.0.16/libexec/tunnel-client';
export const installedDigest='6f1e8d5494d6c4d6c45cd4f6e07b5291459c0b23f4b8cd8266c7a64be3d9a2a0';
export function digestFile(path,executable=false) {
  const before=lstatSync(path);
  if(realpathSync(path)!==path||!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o022)!==0||(executable&&(before.mode&0o100)===0)||before.size>512_000_000)throw new Error('file_denied');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);if(stat.ino!==before.ino||stat.dev!==before.dev)throw new Error('file_denied');const hash=createHash('sha256'),bytes=Buffer.alloc(65536);let count,total=0;while((count=readSync(fd,bytes,0,bytes.length,null))!==0){total+=count;if(total>512_000_000)throw new Error('file_denied');hash.update(bytes.subarray(0,count));}return hash.digest('hex');}
  finally {closeSync(fd);}
}
export function profileText(p) {
  return `config_version: 1
control_plane:
  base_url: https://api.openai.com
  tunnel_id: ${p.tunnelId}
  organization_id: ${p.organizationId}
  max_inflight_requests: 1
  poll_timeout: 10s
  poll_channels: [main, harpoon]
log:
  level: warn
  format: json
  file: /dev/null
  http_raw_unsafe: false
health:
  listen_addr: 127.0.0.1:43126
  show_details: false
admin_ui:
  allow_remote: false
  open_browser: false
  log_buffer_events: 1
cloudflared:
  managed: false
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:43125/mcp
  oauth_trusted_origins:
    - ${new URL(p.issuer).origin}
  max_concurrent_requests: 1
  startup_wait_timeout: 5s
  forward_trace_context: false
harpoon:
  allow_plaintext_http: true
  capture_payloads: false
  max_redirects: 0
  max_response_bytes: 16384
`;
}
export function validatePlan(p) {
  const keys=['version','tunnelId','organizationId','issuer','diagnosticOnly','client','helper','node','files'];
  if(!p||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||p.version!==1||p.diagnosticOnly!==true||!/^tunnel_[a-z0-9]{32}$/.test(p.tunnelId)||!/^org-[A-Za-z0-9]{1,64}$/.test(p.organizationId)||!/^https:\/\/[a-z0-9-]+\.us\.auth0\.com\/$/.test(p.issuer))throw new Error('plan_denied');
  for(const item of [p.client,p.helper,p.node])if(!item||Object.keys(item).sort().join(',')!=='path,sha256'||typeof item.path!=='string'||!/^\/[\x20-\x7e]+$/.test(item.path)||!/^([a-f0-9]{64})$/.test(item.sha256))throw new Error('plan_denied');
  if(p.client.path!==installedClient||p.client.sha256!==installedDigest||p.helper.path!==join(root,'dist/native/tunnel-keychain-launcher')||p.node.path!==process.execPath)throw new Error('plan_denied');
  const expected=['oauth-setup.json','tunnel.yaml'];
  if(!p.files||Object.keys(p.files).sort().join(',')!==expected.join(',')||expected.some(k=>!/^[a-f0-9]{64}$/.test(p.files[k])))throw new Error('plan_denied');
  return p;
}
export function loadPlan() {
  assertPrivateDirectory(directory);const p=validatePlan(readDeploymentFile(join(directory,'plan.json')));
  for(const item of [p.client,p.helper,p.node])if(digestFile(item.path,true)!==item.sha256)throw new Error('plan_denied');
  for(const name of Object.keys(p.files)){assertPrivateFileMode(name);if(digestFile(join(directory,name))!==p.files[name])throw new Error('plan_denied');}
  const config=parseOAuthSetup(readDeploymentFile(join(directory,'oauth-setup.json')));
  if(config.oauth.resource!==provisionalResource||config.oauth.audience!==provisionalResource||config.oauth.issuer!==p.issuer||config.oauth.jwksUrl!==p.issuer+'.well-known/jwks.json'||config.oauth.requiredScopes.join(' ')!=='discord:bridge'||config.http.kind!=='tunnel_loopback'||config.http.port!==43125)throw new Error('plan_denied');
  if(readFileSync(join(directory,'tunnel.yaml'),'utf8')!==profileText(p))throw new Error('plan_denied');
  return {plan:p,config};
}
function assertPrivateFileMode(name) {
  const path=join(directory,name),s=lstatSync(path);
  if(s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)throw new Error('plan_denied');
}
