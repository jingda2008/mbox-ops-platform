"""Disposable GitHub x86_64 runner only. No production connections or secrets."""
import hashlib,json,os,secrets,shutil,subprocess,sys,tarfile,time
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.uname().machine=='x86_64' and os.environ.get('RUNNER_OS')=='Linux'
repo=Path.cwd();fixture=repo/'scripts/test-support/maintenance-lab';root=Path(os.environ['RUNNER_TEMP'])/('mbox-maint-'+os.environ['GITHUB_RUN_ID']);root.mkdir();artifacts=repo/'artifacts/maintenance-native';artifacts.mkdir(parents=True)
initial='da0c2498931b16c1916af1756e3b0f79e801660e';final='ddb9a71b5913d89c510bd3faf07f328acc4946ed';old='5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe'
def run(args,**kwargs):return subprocess.run([str(x) for x in args],check=True,**kwargs)
def text(args):return subprocess.check_output([str(x) for x in args],text=True).strip()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def unpack_source(commit,destination):
 destination.mkdir();archive=root/(commit+'.tar');run(['git','archive','--output',archive,commit]);
 with tarfile.open(archive) as t:t.extractall(destination,filter='data')
 shutil.copytree(repo/'node_modules',destination/'node_modules',symlinks=True)
def fetch(version,commit):
 dest=root/('release-'+version);dest.mkdir();run(['gh','release','download','v'+version,'--pattern','release-manifest.json','--pattern','migration-manifest.json','--pattern','mbox-normalized-*.tar.gz','--dir',dest],stdout=subprocess.DEVNULL)
 m=json.loads((dest/'release-manifest.json').read_text());assert m['releaseSha']==commit and sha(dest/m['archive'])==m['archiveSha256'];run(['docker','load','-i',dest/m['archive']],stdout=subprocess.DEVNULL)
 assert text(['docker','image','inspect',m['imageTag'],'--format','{{.Id}}'])==m['platformImageDigest']
 assert text(['docker','image','inspect',m['imageTag'],'--format','{{.Architecture}}'])=='amd64'
 return dest,m
old_dir,old_manifest=fetch('1.0.0-rc.216',old);final_dir,final_manifest=fetch('1.0.0-rc.220',final)
run(['docker','tag',old_manifest['imageTag'],'audit-maintenance-source-live:5b9d929']);run(['docker','tag',final_manifest['imageTag'],'audit-maintenance-final:ddb9a71'])
assets=root/'assets';assets.mkdir();shutil.copytree(fixture,assets/'fixture');shutil.copytree(old_dir,assets/'old-release')
unpack_source(final,assets/'source-ddb9a71')
shutil.copyfile(final_dir/final_manifest['archive'],assets/'final-image.tar.gz')
images={final:{'tag':'audit-maintenance-final:ddb9a71','digest':final_manifest['imageDigest'],'config':final_manifest['platformImageDigest'],'archive':'final-image.tar.gz'}};(assets/'images.json').write_text(json.dumps(images));(artifacts/'input-identities.json').write_text(json.dumps({'source':old_manifest['releaseSha'],'images':images,'nativeArchitecture':os.uname().machine,'productionCredentialsUsed':False},indent=2)+'\n')
run(['docker','build','-t','audit-maintenance-full-entry:rc220',fixture]);run(['docker','pull','postgres:16-alpine']);run(['docker','pull','caddy:2.10.2-alpine'])
inner_images=root/'inner-images.tar';run(['docker','save','-o',inner_images,'audit-maintenance-source-live:5b9d929','audit-maintenance-final:ddb9a71','caddy:2.10.2-alpine'])
# Transfer-only rc220: current normal entry; unchanged recovery/controller faults remain rc220 evidence.
for scenario in ['success']:
 host='mbox-maint-lab-'+scenario+'-'+os.environ['GITHUB_RUN_ID'];created=[];dest=artifacts/scenario;dest.mkdir();credential=root/(scenario+'-pg.env');credential.write_text('POSTGRES_USER=lab_admin\nPOSTGRES_PASSWORD='+secrets.token_hex(32)+'\nPOSTGRES_DB=postgres\n');credential.chmod(0o600)
 try:
  cid=text(['docker','run','-d','--name',host,'--hostname',host,'--privileged','--cgroupns=private','--network','none','--memory','4g','--memory-swap','4g','--cpus','3','--pids-limit','1024','--shm-size','256m','--tmpfs','/run','--tmpfs','/run/lock','--tmpfs','/tmp','audit-maintenance-full-entry:rc220']);created.append(cid)
  pg=text(['docker','run','-d','--name',host+'-pg','--network','container:'+host,'--memory','768m','--cpus','1','--pids-limit','256','--env-file',credential,'postgres:16-alpine']);created.append(pg)
  for attempt in range(60):
   p=subprocess.run(['docker','exec',host,'systemctl','is-active','docker.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if p.returncode==0:break
   time.sleep(1)
  else:raise RuntimeError('nested docker did not start')
  assert text(['docker','exec',host,'uname','-m'])=='x86_64'
  inspection=json.loads(text(['docker','inspect',host]))[0];assert inspection['HostConfig']['NetworkMode']=='none' and not any(m['Type']=='bind' for m in inspection['Mounts'])
  run(['docker','exec',host,'mkdir','-p','/root/LAB-final']);run(['docker','cp',str(assets)+'/.',host+':/root/LAB-final']);run(['docker','cp',credential,host+':/root/lab-pg.env'])
  with inner_images.open('rb') as stream:run(['docker','exec','-i',host,'docker','load'],stdin=stream,stdout=subprocess.DEVNULL)
  r=subprocess.run(['docker','exec',host,'python3','/root/LAB-final/fixture/guarded-inside.py',scenario],timeout=3000)
  run(['docker','exec',host,'python3','/root/LAB-final/fixture/export-evidence.py']);run(['docker','cp',host+':/root/LAB-final/safe-evidence/.',dest])
  assert r.returncode==0,'LAB scenario failed: '+scenario
 finally:
  for cid in reversed(created):run(['docker','rm','-f',cid],stdout=subprocess.DEVNULL)
  credential.unlink()
  remaining=text(['docker','ps','-aq','--filter','name='+host]);assert not remaining
  (dest/'cleanup.json').write_text(json.dumps({'exactCreatedContainerIds':created,'remainingOwnedContainers':0,'temporaryCredentialRemoved':True},indent=2)+'\n')
print('Native non-root-publisher maintenance success verified; prior unchanged-controller fault evidence remains separately bound')
