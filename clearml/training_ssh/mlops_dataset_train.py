#!/usr/bin/env python3
"""Pass verified Dataset identity to the server and retain it beside its training lists."""
import json
import os
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
if len(sys.argv)<5 or sys.argv[1]!='--metadata' or sys.argv[3]!='--':raise SystemExit('Invalid Dataset training request')
metadata=json.loads(sys.argv[2]);args=sys.argv[4:]
if args[0]!=str(ROOT/'scripts/train.sh'):raise SystemExit('Invalid training entrypoint')
raw=metadata['dataset_manifest']
if not raw.startswith('/workspace/'):raise SystemExit('Invalid manifest path')
manifest=(ROOT/raw.removeprefix('/workspace/')).resolve()
if not any(manifest.is_relative_to(base.resolve()) for base in [ROOT/'Detector/data/generated',ROOT/'VLM/data/vlm']) or manifest.name!='manifest.json' or not manifest.is_file():raise SystemExit('Missing Dataset manifest')
(manifest.parent/'training_dataset.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('MLOps Dataset: '+json.dumps(metadata,ensure_ascii=False),flush=True)
os.execv(args[0],args)
