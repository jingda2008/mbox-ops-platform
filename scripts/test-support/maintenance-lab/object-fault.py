#!/usr/bin/env python3
"""LAB-only real readback corruption. Called after the local copy completed."""
import json,subprocess,sys
from pathlib import Path
root=Path('/root/LAB-final');args=sys.argv[1:]
r=subprocess.run(['/usr/local/bin/ossutil.lab-base',*args]);
if r.returncode:raise SystemExit(r.returncode)
mode=(root/'fault-mode').read_text().strip()
readback=len(args)>=3 and args[0]=='cp' and args[1].startswith('oss://')
if not readback:raise SystemExit(0)
trigger=(mode=='backup' and '/maintenance-backup/' in args[1]) or (mode in ('epoch','seed') and '/maintenance-epoch/' in args[1])
if not trigger:raise SystemExit(0)
(root/'fault-mode').write_text('none')
if mode in ('epoch','seed'):
 with (root/'private-logs/financial-seed-driver.log').open('w') as log:
  subprocess.run(['python3',root/'fixture/seed-financial.py'],check=True,stdout=log,stderr=subprocess.STDOUT)
if mode!='seed':
 with Path(args[2]).open('ab') as f:f.write(b'LAB-READBACK-CORRUPTION')
with (root/'fault-events.jsonl').open('a') as f:f.write(json.dumps({'mode':mode,'copiedBeforeInjection':True,'corruptedReadback':mode!='seed','businessFactsCreated':mode in ('epoch','seed')})+'\n')
