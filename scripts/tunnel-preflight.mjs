import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { directory, loadPlan } from './tunnel-plan.mjs';
import { validateClientProfile, listenerOwner } from './tunnel-diagnostics.mjs';

// No native helper, Keychain lookup, listener or HTTP request is started here.
export function keylessPreflight(report, {load=loadPlan,folder=directory,validate=validateClientProfile,owner=listenerOwner}={}) {
  let temporary;
  try {
    report('metadata_preflight_static_check_started');
    const {plan}=load();
    if(Buffer.byteLength(join(folder,'run','s'))>100)throw new Error('path');
    if(existsSync(join(folder,'run'))){report('metadata_preflight_existing_lock_stop');return 2;}
    report('metadata_preflight_static_check_passed');
    temporary=mkdtempSync(join(tmpdir(),'tm-launch-preflight-'));
    const checked=validate(plan.client.path,join(folder,'tunnel.yaml'),temporary);
    if(checked!=='ok'){report('metadata_preflight_client_config_'+(checked==='rejected'?'rejected':'spawn_or_timeout'));return 2;}
    report('metadata_client_config_schema_only_not_runtime_or_auth');
    for(const [port,label] of [[43125,'metadata'],[43126,'health']]) {
      const state=owner(port);
      if(state!=='absent'){report('metadata_preflight_'+label+'_port_'+(state==='unknown'?'check_unavailable':'already_occupied'));return 2;}
      report('metadata_preflight_'+label+'_port_available');
    }
    report('metadata_preflight_passed_no_key_read_no_connection');return 0;
  } catch {report('metadata_preflight_failed_no_key_read_no_start');return 2;}
  finally {if(temporary){try{rmSync(temporary,{recursive:true,force:true});}catch{report('metadata_preflight_temporary_cleanup_failed');return 2;}}}
}
