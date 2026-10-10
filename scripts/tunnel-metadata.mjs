import { OAuthSetupRuntime } from '../dist/src/oauth-setup.js';
import { directory,loadPlan } from './tunnel-plan.mjs';
import { runSession,stopSession } from './tunnel-session-core.mjs';
import { assertPrivateDirectory } from '../dist/src/config-file.js';
const out=s=>process.stdout.write(s+'\n');
try {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--check') {
    loadPlan();out('metadata_prepared_keychain_unverified_no_connection');
  } else if(args.length===1&&args[0]==='--stop') {
    assertPrivateDirectory(directory);
    process.exitCode=await stopSession(directory)?0:2;out(process.exitCode?'metadata_not_running_or_stop_unconfirmed':'metadata_stop_requested');
  } else if(args.length===2&&args[0]==='--start'&&args[1]==='--person-start') {
    // Only a person at Terminal may activate; no daemon or agent start path.
    if(!process.stdin.isTTY||!process.stdout.isTTY||process.platform!=='darwin')throw new Error('terminal_required');
    const {plan,config}=loadPlan();
    out('metadata_only_start_sends_saved_runtime_key_to_openai_no_oauth_grant');
    process.exitCode=await runSession({directory,config,runtimeFactory:raw=>new OAuthSetupRuntime(raw),client:plan.client.path,helper:plan.helper.path,profile:directory+'/tunnel.yaml',status:out});
  } else throw new Error('arguments');
} catch {out('metadata_command_denied_no_start');process.exitCode=2;}
