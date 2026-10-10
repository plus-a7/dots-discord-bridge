import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory } from '../dist/src/config-file.js';
import { root,directory,provisionalResource,installedClient,installedDigest,digestFile,profileText,validatePlan,loadPlan } from './tunnel-plan.mjs';
try {
  const a=process.argv.slice(2);
  if(a.length!==6||a[0]!=='--tunnel-id'||a[2]!=='--organization-id'||a[4]!=='--issuer')throw new Error('arguments');
  const p=validatePlan({version:1,tunnelId:a[1],organizationId:a[3],issuer:a[5],diagnosticOnly:true,
    client:{path:installedClient,sha256:installedDigest},
    helper:{path:join(root,'dist/native/tunnel-keychain-launcher'),sha256:digestFile(join(root,'dist/native/tunnel-keychain-launcher'),true)},
    node:{path:process.execPath,sha256:digestFile(process.execPath,true)},files:{'oauth-setup.json':'0'.repeat(64),'tunnel.yaml':'0'.repeat(64)}});
  if(digestFile(installedClient,true)!==installedDigest)throw new Error('client');
  try{mkdirSync(join(root,'private'),{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  assertPrivateDirectory(join(root,'private'));mkdirSync(directory,{mode:0o700});assertPrivateDirectory(directory);
  const config={version:1,mode:'oauth_setup',enabled:true,oauth:{issuer:p.issuer,jwksUrl:p.issuer+'.well-known/jwks.json',resource:provisionalResource,audience:provisionalResource,requiredScopes:['discord:bridge']},http:{kind:'tunnel_loopback',port:43125}};
  writeFileSync(join(directory,'oauth-setup.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  writeFileSync(join(directory,'tunnel.yaml'),profileText(p),{mode:0o600,flag:'wx'});
  for(const name of Object.keys(p.files))p.files[name]=digestFile(join(directory,name));
  writeFileSync(join(directory,'plan.json'),JSON.stringify(p,null,2)+'\n',{mode:0o600,flag:'wx'});
  loadPlan();process.stdout.write('metadata_prepared_no_keychain_no_connection\n');
}catch {process.stderr.write('metadata_preparation_failed_no_start\n');process.exitCode=2;}
