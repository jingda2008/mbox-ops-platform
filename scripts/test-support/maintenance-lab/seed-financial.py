"""Run existing positive command/API fixtures; never insert the six fact tables."""
import configparser,json,os,subprocess
from pathlib import Path
from urllib.parse import quote
root=Path('/root/LAB-final');c=json.loads((root/'active-config.json').read_text());services=configparser.ConfigParser();services.read(c['pgServiceFile']);passwords={row.split(':')[3]:row.split(':')[4] for row in Path(c['pgPassFile']).read_text().splitlines()}
def url(name):
 s=services[name];return 'postgresql://'+quote(s['user'],safe='')+':'+quote(passwords[s['user']],safe='')+'@127.0.0.1:5432/'+s['dbname']
env={**os.environ,'TEST_NORMALIZED_DATABASE_URL':url('migration'),'TEST_NORMALIZED_RUNTIME_DATABASE_URL':url('application')}
repo=Path(c['sourceDirectory']);pattern='previews original awarded-equals-expected net deficit|accepts exact authorized .* compensation-preserving projection'
with (root/'private-logs/financial-seed.log').open('w') as log:
 p=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','server/normalized/order-financial-recovery.integration.test.ts','server/normalized/closed-manual-debt-projection.integration.test.ts','--maxWorkers=1','--pool=forks','--reporter=verbose','-t',pattern],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
assert p.returncode==0,'existing positive business fixtures failed'
subprocess.run(['python3',root/'fixture/parameterized/v240/verify-financial-240.py','--config',root/'active-config.json','--execute-lab','--capture-financial-baseline'],stdout=subprocess.DEVNULL,check=True)
(root/'financial-seed-result.json').write_text(json.dumps({'existingTestsPassed':True,'directFactTableInserts':False,'sourceSha':c['targetSha'],'baselineCaptured':True}))
