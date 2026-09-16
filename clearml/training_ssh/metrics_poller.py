import json, os, subprocess, time
from pathlib import Path
OUT=Path(os.environ.get('TRAINING_METRICS_OUTPUT','/tmp/training-metrics.json'))
INTERVAL=max(1,int(os.environ.get('TRAINING_METRICS_INTERVAL_SEC','5')))
while True:
 env=dict(os.environ); env['TRAINING_SSH_TEST_SCRIPT']=env.get('TRAINING_SSH_METRICS_SCRIPT','')
 try:
  r=subprocess.run(['python','/app/client.py','test'],env=env,text=True,capture_output=True,timeout=INTERVAL)
  data=json.loads(r.stdout) if r.returncode==0 else {'ok':False,'error':r.stderr.strip()}
 except Exception as e: data={'ok':False,'error':str(e)}
 data['updated_at']=int(time.time()); OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(data),encoding='utf-8'); time.sleep(INTERVAL)
