#!/usr/bin/env bash
set -u
cpu=$(LC_ALL=C top -bn1 2>/dev/null | awk '/Cpu\(s\)/ {printf "%.1f", 100 - $8; exit}')
[ -n "$cpu" ] || cpu=null
read -r total used available <<EOF
$(free -b 2>/dev/null | awk '/^Mem:/ {print $2, $3, $7}')
EOF
python3 - "$cpu" "${total:-0}" "${used:-0}" "${available:-0}" <<'PY2'
import json, os, subprocess, sys, time
cpu,total,used,available=sys.argv[1:]
def n(v):
 try: return float(v) if '.' in v else int(v)
 except: return None
p={'ok':True,'timestamp':int(time.time()),'cpu_percent':n(cpu),'cpu_count':os.cpu_count(),'memory':{'total_bytes':int(total),'used_bytes':int(used),'available_bytes':int(available)},'gpus':[]}
try:
 out=subprocess.check_output(['nvidia-smi','--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'],stderr=subprocess.DEVNULL,text=True,timeout=3)
 for line in out.splitlines():
  a=[x.strip() for x in line.split(',')]
  if len(a)>=6: p['gpus'].append({'index':n(a[0]),'name':a[1],'utilization_percent':n(a[2]),'memory_used_mb':n(a[3]),'memory_total_mb':n(a[4]),'temperature_c':n(a[5])})
except Exception: p['gpu_error']='nvidia-smi unavailable'
print(json.dumps(p,separators=(',',':')))
PY2
