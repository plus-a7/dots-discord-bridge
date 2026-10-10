import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivateDirectory } from '../dist/src/config-file.js';
import { directory, root, loadPlan } from './tunnel-plan.mjs';

function quote(value){if(typeof value!=='string'||!value.startsWith('/')||/[\x00-\x1f\x7f]/.test(value))throw new Error('path');return "'"+value.replaceAll("'","'\\''")+"'";}
export function launcherText(node,script,action) {
  if(action!=='start'&&action!=='stop')throw new Error('action');
  // Absolute commands, no eval/AppleScript/automation, no shell secret lookup.
  const nodePath=quote(node),scriptPath=quote(script);
  return `#!/bin/sh
if [ ! -t 0 ] || [ ! -t 1 ]; then
  printf '%s\\n' 'metadata_launcher_denied_no_start'
  exit 2
fi
if [ ! -x ${nodePath} ] || [ ! -f ${scriptPath} ] || [ ! -r ${scriptPath} ]; then
  printf '%s\\n' 'metadata_launcher_bootstrap_files_unavailable_no_start' '結果を確認してください。画面を閉じるにはEnter。'
  IFS= read -r ignored
  exit 2
fi
exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin ${nodePath} ${scriptPath} --${action} 2>/dev/null
`;
}
export function prepareLaunchers() {
  const {plan}=loadPlan();assertPrivateDirectory(directory);
  const target=join(directory,'launchers');let own=false;
  try {
    mkdirSync(target,{mode:0o700});own=true;assertPrivateDirectory(target);
    for(const [name,action] of [['Start Metadata.command','start'],['Stop Metadata.command','stop']])writeFileSync(join(target,name),launcherText(plan.node.path,join(root,'scripts/tunnel-launcher.mjs'),action),{mode:0o700,flag:'wx'});
    return target;
  } catch {if(own)rmSync(target,{recursive:true,force:true});throw new Error('launcher_preparation');}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  try{if(process.argv.length!==2)throw new Error('arguments');prepareLaunchers();process.stdout.write('metadata_launchers_prepared_no_key_read_no_start\n');}
  catch{process.stdout.write('metadata_launcher_preparation_failed_no_start\n');process.exitCode=2;}
}
