import { fileURLToPath } from 'node:url';
// Keep module/config import failures inside the fixed-error/hold-screen path.
async function runExistingCommand(args,report) {
  const {runMetadataCommand}=await import('./tunnel-metadata.mjs');
  return runMetadataCommand(args,report);
}

// Enter/TTY is an operator interaction guard, never proof of human identity.
export function waitForEnter(input=process.stdin,signals=process) {
  return new Promise(resolve=>{
    let text='',settled=false;
    const finish=ok=>{if(settled)return;settled=true;input.removeListener('data',data);input.removeListener('end',cancel);input.removeListener('error',cancel);for(const s of ['SIGINT','SIGTERM','SIGHUP'])signals.removeListener(s,cancel);input.pause();resolve(ok);};
    const cancel=()=>finish(false);
    const data=chunk=>{text+=chunk.toString('utf8');if(text.length>1024){finish(false);return;}const end=text.indexOf('\n');if(end>=0)finish(text.slice(0,end).replace(/\r$/,'')==='');};
    input.on('data',data);input.once('end',cancel);input.once('error',cancel);
    for(const s of ['SIGINT','SIGTERM','SIGHUP'])signals.on(s,cancel);
    if(input.readableEnded||input.destroyed){cancel();return;}input.resume();
  });
}
const translations={
  metadata_only_session_started:'開始受付。キー取得・接続・認証・dot wakeはまだ未確認です。',
  metadata_client_local_ready_does_not_prove_auth_or_dot_wake:'ローカルready。OpenAI認証・OAuth・dot wakeは未確認です。',
  metadata_stop_requested:'停止受付。開始画面の「停止完了」を確認してください。',
  metadata_session_stopped:'停止完了。今回のlistenerとclientの終了処理が完了しました。',
  metadata_session_failed:'今回の実行は失敗で終了しました。自動再試行はしません。',
  metadata_stop_pending:'停止未完了。再起動やlock削除をせず、固定診断を親へ報告してください。'
};
export async function runLauncher({action,command=runExistingCommand,tty=process.platform==='darwin'&&process.stdin.isTTY&&process.stdout.isTTY,enter=waitForEnter,output=s=>process.stdout.write(s+'\n')}={}) {
  const report=s=>{output(s);if(translations[s])output(translations[s]);};
  let code=2;
  try {
    if(!tty||(action!=='start'&&action!=='stop')){report('metadata_launcher_denied_no_start');return 2;}
    if(action==='stop')code=await command(['--stop'],report);
    else {
      output('一時的なmetadata専用Tunnelを開始します。');
      output('Enter後、login Keychainの保存済みruntime keyを読み、OpenAI control plane（https://api.openai.com）へ送信します。');
      output('Discord/MCP Events/read/replyは起動しません。OAuth grantは作成せず、最大15分で停止します。');
      code=await command(['--preflight'],report);
      if(code===0){
        output('開始する場合だけEnterを1回押してください。取消はCtrl-C、または文字を入力してEnter。キーやURLを貼らないでください。');
        if(await enter())code=await command(['--start','--person-start'],report);
        else{report('metadata_launcher_cancelled_no_start');code=2;}
      }
    }
  } catch {report('metadata_launcher_failed_no_raw_diagnostic');code=2;}
  finally {
    if(tty){
      report('metadata_launcher_finished_'+(code===0?'ok':'failed_or_cancelled'));
      output('結果を確認してください。画面を閉じるにはEnter。再実行は自動では行いません。');
      try{await enter();}catch{}
    }
  }
  return code;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  const args=process.argv.slice(2);
  process.exitCode=await runLauncher({action:args.length===1&&args[0]==='--start'?'start':args.length===1&&args[0]==='--stop'?'stop':undefined});
}
