import { OAuthSetupRuntime } from '../dist/src/oauth-setup.js';
import { directory,loadPlan } from './tunnel-plan.mjs';
import { runSession,stopSession } from './tunnel-session-core.mjs';
import { assertPrivateDirectory } from '../dist/src/config-file.js';
import { validateClientProfile,listenerOwner,probeClientHealth } from './tunnel-diagnostics.mjs';
import { keylessPreflight } from './tunnel-preflight.mjs';
import { fileURLToPath } from 'node:url';
const out=s=>process.stdout.write(s+'\n');
export async function runMetadataCommand(args,report=out) {
let deniedStage='arguments';let code=0;
try {
  if(args.length===1&&args[0]==='--check') {
    deniedStage='static_plan';
    loadPlan();report('metadata_prepared_keychain_unverified_no_connection');
  } else if(args.length===1&&args[0]==='--preflight') {
    code=keylessPreflight(report);
  } else if(args.length===1&&args[0]==='--stop') {
    deniedStage='stop_lookup';
    assertPrivateDirectory(directory);
    code=await stopSession(directory)?0:2;report(code?'metadata_not_running_or_stop_unconfirmed':'metadata_stop_requested');
  } else if(args.length===2&&args[0]==='--start'&&args[1]==='--person-start') {
    // Operator-path guard only: TTY is not proof of a human identity.
    deniedStage='terminal';
    if(!process.stdin.isTTY||!process.stdout.isTTY||process.platform!=='darwin')throw new Error('terminal_required');
    report('metadata_static_plan_check_started');
    deniedStage='static_plan';
    const {plan,config}=loadPlan();report('metadata_static_plan_check_passed');
    report('metadata_only_start_sends_saved_runtime_key_to_openai_no_oauth_grant');
    code=await runSession({directory,config,runtimeFactory:raw=>new OAuthSetupRuntime(raw),client:plan.client.path,helper:plan.helper.path,profile:directory+'/tunnel.yaml',status:report,
      preflight:({client,profile,runDirectory,report})=>{
        const checked=validateClientProfile(client,profile,runDirectory);
        if(checked!=='ok'){report('metadata_client_config_'+checked);return false;}
        report('metadata_client_config_schema_only_not_runtime_or_auth');
        const owner=listenerOwner(43126);
        if(owner!=='absent'){report(owner==='unknown'?'metadata_health_port_check_unavailable':'metadata_health_port_already_occupied');return false;}
        report('metadata_health_port_available');return true;
      },healthProbe:probeClientHealth});
  } else throw new Error('arguments');
} catch {report('metadata_command_denied_stage_'+deniedStage);report('metadata_command_denied_no_start');code=2;}
return code;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])process.exitCode=await runMetadataCommand(process.argv.slice(2));
