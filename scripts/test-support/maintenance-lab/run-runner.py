"""Disposable GitHub x86_64 runner only. No production connections or secrets."""
import hashlib,json,os,secrets,shutil,subprocess,sys,tarfile,time
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.uname().machine=='x86_64' and os.environ.get('RUNNER_OS')=='Linux'
repo=Path.cwd();fixture=repo/'scripts/test-support/maintenance-lab';root=Path(os.environ['RUNNER_TEMP'])/('mbox-maint-'+os.environ['GITHUB_RUN_ID']);root.mkdir();artifacts=repo/'artifacts/maintenance-native';artifacts.mkdir(parents=True)
initial='ce9c52640e3034d03c6c0929057ae7ee6095f6f4';final='ab8b23713e7a52dace2933132d15d8f2ffc02150';old='5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe'
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
old_dir,old_manifest=fetch('1.0.0-rc.216',old);final_dir,final_manifest=fetch('1.0.0-rc.217',final)
run(['docker','tag',old_manifest['imageTag'],'audit-maintenance-source-live:5b9d929']);run(['docker','tag',final_manifest['imageTag'],'audit-maintenance-final:ab8b237'])
assets=root/'assets';assets.mkdir();shutil.copytree(fixture,assets/'fixture');shutil.copytree(old_dir,assets/'old-release')
unpack_source(initial,assets/'source-ce9c526');unpack_source(final,assets/'source-ab8b237')
metadata=root/'initial-build.json';initial_tag='audit-maintenance-initial:ce9c526'
run(['docker','buildx','build','--load','--build-arg','APP_COMMIT_SHA='+initial,'--build-arg','APP_RELEASE_VERSION=1.0.0-rc.217','--metadata-file',metadata,'-t',initial_tag,'.'],cwd=assets/'source-ce9c526')
build=json.loads(metadata.read_text());config=text(['docker','image','inspect',initial_tag,'--format','{{.Id}}']);assert build['containerimage.config.digest']==config
run(['docker','save','--output',assets/'initial-image.tar',initial_tag]);shutil.copyfile(final_dir/final_manifest['archive'],assets/'final-image.tar.gz')
# Docker export may change the manifest representation while preserving its
# config. Bind the actual immutable exported bytes, not a builder cache digest.
with tarfile.open(assets/'initial-image.tar') as archive:
 index=json.load(archive.extractfile('index.json'))
 refs=[x for x in index['manifests'] if x.get('annotations',{}).get('org.opencontainers.image.ref.name')]
 assert len(refs)==1
 exported_digest=refs[0]['digest'];blob=archive.extractfile('blobs/sha256/'+exported_digest.split(':')[1]).read()
 assert 'sha256:'+hashlib.sha256(blob).hexdigest()==exported_digest
 reference=json.loads(blob)
 if 'manifests' in reference:
  platforms=[m for m in reference['manifests'] if m.get('platform',{}).get('os')=='linux' and m.get('platform',{}).get('architecture')=='amd64'];assert len(platforms)==1
  platform_digest=platforms[0]['digest'];blob=archive.extractfile('blobs/sha256/'+platform_digest.split(':')[1]).read();assert 'sha256:'+hashlib.sha256(blob).hexdigest()==platform_digest;reference=json.loads(blob)
 assert reference['config']['digest']==config
images={initial:{'tag':initial_tag,'digest':exported_digest,'config':config,'archive':'initial-image.tar'},final:{'tag':'audit-maintenance-final:ab8b237','digest':final_manifest['imageDigest'],'config':final_manifest['platformImageDigest'],'archive':'final-image.tar.gz'}};(assets/'images.json').write_text(json.dumps(images));(artifacts/'input-identities.json').write_text(json.dumps({'source':old_manifest['releaseSha'],'images':images,'nativeArchitecture':os.uname().machine,'productionCredentialsUsed':False},indent=2)+'\n')
run(['docker','build','-t','audit-maintenance-full-entry:rc217',fixture]);run(['docker','pull','postgres:16-alpine']);run(['docker','pull','caddy:2.10.2-alpine'])
inner_images=root/'inner-images.tar';run(['docker','save','-o',inner_images,'audit-maintenance-source-live:5b9d929',initial_tag,'audit-maintenance-final:ab8b237','caddy:2.10.2-alpine'])
for scenario in ['success','forward']:
 host='mbox-maint-lab-'+scenario+'-'+os.environ['GITHUB_RUN_ID'];created=[];dest=artifacts/scenario;dest.mkdir();credential=root/(scenario+'-pg.env');credential.write_text('POSTGRES_USER=lab_admin\nPOSTGRES_PASSWORD='+secrets.token_hex(32)+'\nPOSTGRES_DB=postgres\n');credential.chmod(0o600)
 try:
  cid=text(['docker','run','-d','--name',host,'--hostname',host,'--privileged','--cgroupns=private','--network','none','--memory','4g','--memory-swap','4g','--cpus','3','--pids-limit','1024','--shm-size','256m','--tmpfs','/run','--tmpfs','/run/lock','--tmpfs','/tmp','audit-maintenance-full-entry:rc217']);created.append(cid)
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
print('Native maintenance success and forward-failure scenarios verified')
