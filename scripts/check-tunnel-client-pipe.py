#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""Offline adopted-client regression. Never read a Keychain item or actual config.
All networking is denied by an additional sandbox. The deliberate MCP limit0
sentinel prevents constructing the runtime after the synthetic API-key parse.
Only exact fixed stderr classifications are retained; no raw output is saved.
"""
import hashlib,json,os,pathlib,select,signal,subprocess,sys,tempfile,shutil,time
CLIENT='/opt/homebrew/Cellar/tunnel-client/0.0.16/libexec/tunnel-client'
DIGEST='6f1e8d5494d6c4d6c45cd4f6e07b5291459c0b23f4b8cd8266c7a64be3d9a2a0'
SYNTHETIC=b'sk-MOCK-ONLY-PIPE-CREDENTIAL-0123456789abcdef'
ALLOWED={
 b'configure tunnel-client: file /dev/fd/4 referenced by --control-plane.api-key is empty\n':'api_key_pipe_empty',
 b'configure tunnel-client: mcp.max-concurrent-requests must be greater than zero\n':'intentional_post_key_config_sentinel'
}
BASE='''config_version: 1
control_plane:
  base_url: http://127.0.0.1:1
  tunnel_id: tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  max_inflight_requests: 1
  poll_channels: [main, harpoon]
log:
  level: warn
  format: json
  file: /dev/null
health:
  listen_addr: 127.0.0.1:43126
cloudflared:
  managed: false
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:43125/mcp
harpoon:
  allow_plaintext_http: true
'''
def run_case(folder,legacy):
 profile=folder/('legacy.yaml' if legacy else 'single.yaml')
 profile.write_text(BASE.replace('  max_inflight_requests:',('  api_key: file:/dev/fd/4\n' if legacy else '')+'  max_inflight_requests:'))
 profile.chmod(0o600)
 reader,writer=os.pipe()
 writer_saved=os.dup(writer);os.close(writer);os.dup2(reader,4,inheritable=True)
 if reader!=4:os.close(reader)
 child=None
 try:
  child=subprocess.Popen(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)',CLIENT,'run','--config',str(profile),'--control-plane.api-key','file:/dev/fd/4','--mcp.max-concurrent-requests','0'],env={'PATH':'/usr/bin:/bin','HOME':str(folder)},pass_fds=(4,),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
  os.close(4);os.write(writer_saved,SYNTHETIC);os.close(writer_saved);writer_saved=-1
  raw=bytearray();deadline=time.monotonic()+5;overflow=False
  while True:
   if time.monotonic()>deadline:raise RuntimeError('offline_timeout')
   ready,_,_=select.select([child.stderr],[],[],.1)
   if not ready:continue
   chunk=os.read(child.stderr.fileno(),512)
   if not chunk:break
   if len(raw)+len(chunk)>8192:overflow=True;raw.clear()
   elif not overflow:raw.extend(chunk)
  code=child.wait(timeout=1)
  result={'legacyDuplicateReference':legacy,'clientExit':code,'fixedClassification':ALLOWED.get(bytes(raw),'unknown_discarded') if not overflow else 'unknown_discarded','networkPolicy':'deny_all','realKeyRead':False}
  raw.clear();return result
 finally:
  if writer_saved!=-1:os.close(writer_saved)
  try:os.close(4)
  except OSError:pass
  if child is not None:
   if child.poll() is None:os.killpg(child.pid,signal.SIGKILL);child.wait()
   child.stderr.close()
def main():
 if len(sys.argv)!=1:raise RuntimeError('arguments')
 digest=hashlib.sha256()
 with open(CLIENT,'rb') as source:
  for chunk in iter(lambda:source.read(65536),b''):digest.update(chunk)
 if digest.hexdigest()!=DIGEST:raise RuntimeError('client_pin')
 folder=pathlib.Path(tempfile.mkdtemp(prefix='tm-pipe-offline-',dir='/tmp'))
 try:
  results=[run_case(folder,True),run_case(folder,False)]
  print(json.dumps({'offlineOnly':True,'cases':results}))
 finally:shutil.rmtree(folder)
try:main()
except Exception:
 print('offline_pipe_check_failed_no_raw_diagnostic');sys.exit(2)
