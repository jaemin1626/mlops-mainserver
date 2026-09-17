import json, os, signal, subprocess, time
from pathlib import Path
OUT=Path(os.environ.get('TRAINING_METRICS_OUTPUT','/tmp/training-metrics.json'))
INTERVAL=max(1,int(os.environ.get('TRAINING_METRICS_INTERVAL_SEC','5')))
while True:
 env=dict(os.environ); env['TRAINING_SSH_TEST_SCRIPT']=env.get('TRAINING_SSH_METRICS_SCRIPT','')
 try:
  # start_new_session=True puts `client.py` (and any ssh child it spawns) in its own
  # process group. subprocess.run(timeout=...) only kills the direct child; if the ssh
  # grandchild survives it keeps the stdout/stderr pipe open and the next internal
  # communicate() call hangs forever, silently freezing this whole loop (observed: process
  # alive but training-metrics.json stops updating for hours). Killing the process group
  # on timeout takes the ssh child down with it.
  proc=subprocess.Popen(['python','/app/client.py','test'],env=env,text=True,
                         stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  try:
   out,err=proc.communicate(timeout=INTERVAL)
   data=json.loads(out) if proc.returncode==0 else {'ok':False,'error':err.strip()}
  except subprocess.TimeoutExpired:
   os.killpg(proc.pid,signal.SIGKILL)
   proc.wait()
   data={'ok':False,'error':'SSH 명령 시간 초과'}
 except Exception as e: data={'ok':False,'error':str(e)}
 data['updated_at']=int(time.time()); data['host']=os.environ.get('TRAINING_SSH_HOST','')
 OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(data),encoding='utf-8'); time.sleep(INTERVAL)
