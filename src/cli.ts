import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import { readDeploymentFile } from './config-file.js';
import { OAuthSetupRuntime, parseOAuthSetup, setupStatus, diagnoseCallbackHost } from './oauth-setup.js';

type BootstrapContract={start(activate:boolean):Promise<number>;stop():Promise<{clean:boolean;pending:boolean}>};
type CommandIO={readConfig?:(path:string,privateFile:boolean)=>unknown;createBootstrap?:(raw:unknown)=>BootstrapContract;createSetup?:(raw:unknown)=>BootstrapContract;signals?:EventEmitter;status?:(status:string)=>void};
export async function runCommand(argv:readonly string[],io:CommandIO={}):Promise<number> {
  const status=io.status??(code=>process.stdout.write(code+'\n'));
  const command=argv[0];
  if(command==='setup-callback-check') {
    if(argv.length!==3||argv[1]!=='--host'||!argv[2]){status('arguments_or_activation_required');return 2;}
    try {status(JSON.stringify(diagnoseCallbackHost(argv[2])));return 0;}catch {status('callback_host_invalid');return 2;}
  }
  const setup=command==='setup-check'||command==='setup-serve';
  if(setup) {
    const serve=command==='setup-serve',expected=serve?['setup-serve','--config',argv[2],'--activate']:['setup-check','--config',argv[2]];
    if(argv.length!==expected.length||argv.some((arg,i)=>arg!==expected[i])||!argv[2]||!isAbsolute(argv[2])){status('arguments_or_activation_required');return 2;}
    let raw:unknown;
    try {raw=(io.readConfig??readDeploymentFile)(argv[2],serve);parseOAuthSetup(raw);}catch {status('oauth_setup_disabled_or_incomplete');return 2;}
    if(!serve){status(JSON.stringify(setupStatus()));return 0;}
    let runtime:BootstrapContract;
    try {runtime=(io.createSetup??(config=>new OAuthSetupRuntime(config)))(raw);}catch {status('oauth_setup_start_failed');return 1;}
    return serveCommand(runtime,io,status,'oauth_setup_metadata_only_running');
  }
  const expected=command==='run'?['run','--config',argv[2],'--activate']:['check','--config',argv[2]];
  if((command!=='run'&&command!=='check')||argv.length!==expected.length||argv.some((arg,i)=>arg!==expected[i])||!argv[2]||!isAbsolute(argv[2])) {status('arguments_or_activation_required');return 2;}
  let raw:unknown;
  try {raw=(io.readConfig??readDeploymentFile)(argv[2],command==='run');(await import('./deployment.js')).parseDeployment(raw);}catch {status('deployment_disabled_or_incomplete');return 2;}
  if(command==='check'){status('configuration_valid_not_started');return 0;}
  let bootstrap:BootstrapContract;
  try {bootstrap=io.createBootstrap?io.createBootstrap(raw):new (await import('./bootstrap.js')).LoginBootstrap(raw);}catch {status('bootstrap_start_failed');return 1;}
  return serveCommand(bootstrap,io,status,'bridge_running');
}
async function serveCommand(bootstrap:BootstrapContract,io:CommandIO,status:(status:string)=>void,running:string) {
  const source=io.signals??process;let stopSignal!:()=>void;const stopped=new Promise<void>(r=>stopSignal=r);let requested=false;
  const stop=()=>{if(requested)return;requested=true;stopSignal();void bootstrap.stop().catch(()=>{});};
  source.on('SIGINT',stop);source.on('SIGTERM',stop);
  let failed=false;
  try {await Promise.race([bootstrap.start(true),stopped]);if(!requested)status(running);await stopped;}catch {failed=!requested;status(requested?'startup_cancelled':'bootstrap_start_failed');}
  finally {source.off('SIGINT',stop);source.off('SIGTERM',stop);}
  try {const result=await bootstrap.stop();status(result.clean?'bridge_stopped':'bridge_stop_pending_process_exit_required');return result.clean?(failed?1:0):1;}
  catch {status('bridge_stop_pending_process_exit_required');return 1;}
}
