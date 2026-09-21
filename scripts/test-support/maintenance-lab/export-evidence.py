"""Export only synthetic LAB reports and logs with temporary secrets removed."""
import json,re,shutil
from pathlib import Path
root=Path('/root/LAB-final');out=root/'safe-evidence';out.mkdir(exist_ok=True)
secrets=[]
for p in Path('/opt/mbox/secrets').glob('*.env'):
 for line in p.read_text().splitlines():
  if '=' in line:
   key,value=line.split('=',1)
   if re.search(r'SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL|DATABASE_URL|PIN',key) and len(value)>=4:secrets.append(value)
for p in [Path('/opt/mbox/secrets/pgpass'),root/'pgpass']:
 if p.exists():
  for line in p.read_text().splitlines():
   if line:secrets.append(line.rsplit(':',1)[-1])
def clean(text):
 for value in sorted(set(secrets),key=len,reverse=True):text=text.replace(value,'[REDACTED-LAB-SECRET]')
 text=re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----','[REDACTED-KEY]',text)
 text=re.sub(r'postgres(?:ql)?://[^\s\x22\x27]+','[REDACTED-CONNECTION]',text)
 return text
for name in ['report.json','error.json','financial-seed-result.json','fault-events.jsonl','entry-results.json']:
 p=root/name
 if p.exists():(out/name).write_text(clean(p.read_text()))
for p in (root/'private-logs').glob('*.log'):
 text=p.read_text(errors='replace');(out/p.name).write_text(clean(text[-2000000:]))
# Never export env/service/pass files, keys, database dumps, callback bodies, or raw rows.

for release in Path('/opt/mbox/releases').iterdir():
 p=release/'maintenance-operator-state.json'
 if p.is_file():(out/(release.name+'-operator-state.json')).write_text(clean(p.read_text()))
