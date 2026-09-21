"""Invoked exclusively inside a disposable network-none nested systemd LAB."""
import configparser,hashlib,json,os,shutil,socket,subprocess,sys,time,traceback
from pathlib import Path
root=Path('/root/LAB-final');fixture=root/'fixture';logs=root/'private-logs';logs.mkdir(exist_ok=True)
assert os.uname().machine=='x86_64' and Path('/.dockerenv').exists()
assert socket.gethostname().startswith('mbox-maint-lab-')
assert not any(row.split()[1]=='00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:])
scenario=sys.argv[1];assert scenario in ('success','forward')
constants=json.loads((root/'images.json').read_text());initial='ce9c52640e3034d03c6c0929057ae7ee6095f6f4';final='ab8b23713e7a52dace2933132d15d8f2ffc02150'
phase='setup';entries=[]
def run(args,label,timeout=300,success=True,env=None):
 with (logs/(label+'.log')).open('w') as f:
  p=subprocess.run([str(x) for x in args],stdout=f,stderr=subprocess.STDOUT,timeout=timeout,env={**os.environ,**(env or {})})
 if success:assert p.returncode==0,label+' failed'
 return p.returncode
run(['python3',fixture/'setup-host.py'],'setup')
run(['python3',fixture/'start-source.py'],'old-source')
run(['python3',fixture/'seed-inflight.py'],'inflight')
# Verifier uses loopback; application containers retain the separate bridge route.
service=Path('/opt/mbox/secrets/pg_service.conf').read_text();gateway=json.loads(Path('/opt/mbox/lab-state.json').read_text())['gateway']
(root/'pg_service.conf').write_text(service.replace('host='+gateway,'host=127.0.0.1'))
(root/'pgpass').write_text(Path('/opt/mbox/secrets/pgpass').read_text().replace(gateway+':','127.0.0.1:'));os.chmod(root/'pgpass',0o600)
transition='local-entry-20260921-a';directory=Path('/opt/mbox/maintenance')/transition
marker={'labId':'rc217-'+scenario,'controllerHostname':socket.gethostname(),'isolatedNestedDocker':True,'externalNetwork':False};(root/'isolated-lab.json').write_text(json.dumps(marker))
def prepare(sha):
 image=constants[sha];c=json.loads((fixture/'parameterized/config.template.json').read_text())
 c.update(labId=marker['labId'],controllerHostname=marker['controllerHostname'],targetSha=sha,sourceSha='5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe',backupOriginSha=initial if scenario=='forward' else final,imageTag=image['tag'],imageDigest=image['digest'],platformImageDigest=image['config'],platform='linux/amd64',schema=240,sourceDirectory=str(root/('source-'+sha[:7])),bundleDirectory=str(root/('bundle-'+sha[:7])),sourceReleaseDirectory='/opt/mbox/releases/5b9d929',imageArchive=str(root/image['archive']),sourceShaFile=str(root/('sha-'+sha[:7])),formalEntryScript=str(root/'formal-entry.sh'),sshKeyFile='/root/.ssh/lab_release',transitionId=transition,labCiRunId='9000000001',callbackBodyFile='/root/lab-callback-body.json')
 (root/('sha-'+sha[:7])).write_text(sha+'\n');(root/'active-config.json').write_text(json.dumps(c));run(['python3',fixture/'parameterized/prepare-bundle-parameterized.py','--config',root/'active-config.json','--execute-lab'],'prepare-'+sha[:7]);
 Path('/usr/local/bin/ossutil').rename('/usr/local/bin/ossutil.lab-base');shutil.copyfile(fixture/'object-fault.py','/usr/local/bin/ossutil');os.chmod('/usr/local/bin/ossutil',0o755)
 return c
c=prepare(initial if scenario=='forward' else final)
env={'NODE_EXTRA_CA_CERTS':'/usr/local/share/ca-certificates/mbox-lab-ca.crt'}
callback_log=(logs/'callback.log').open('w');callback=subprocess.Popen(['node',fixture/'send-delayed-callback.mjs'],stdout=callback_log,stderr=subprocess.STDOUT,env={**os.environ,**env})
def entry(mode,label,expected):
 (root/'fault-mode').write_text(mode);code=run(['bash',root/'formal-entry.sh'],label,timeout=900,success=False)
 entries.append({'label':label,'exitCode':code,'expectedSuccess':expected,'sourceSha':c['targetSha']})
 assert (code==0)==expected,label+' unexpected result'
 if not expected:
  state=json.loads((directory/'maintenance-operator-state.json').read_text()) if (directory/'maintenance-operator-state.json').exists() else json.loads((Path('/opt/mbox/releases')/c['targetSha'][:7]/'maintenance-operator-state.json').read_text())
  assert state['status']=='maintenance-required' and state['sourceLiveStartAllowed'] is False
  cfg=configparser.ConfigParser();cfg.read(root/'pg_service.conf')
  e={**os.environ,'PGSERVICEFILE':str(root/'pg_service.conf'),'PGPASSFILE':str(root/'pgpass')}
  canlogin=subprocess.check_output(['psql','-XAt','--dbname=service=migration','-c',"SELECT rolcanlogin FROM pg_roles WHERE rolname='lab_old'"],env=e,text=True).strip();assert canlogin=='f'
  assert subprocess.check_output(['/usr/bin/curl','--noproxy','*','-s','-o','/dev/null','-w','%{http_code}','https://localhost/api/ready'],text=True)=='503'
if scenario=='forward':
 phase='backup-readback-failure';entry('backup','first-backup-fault',False)
 c=prepare(initial);phase='after-financial-write-failure';entry('epoch','same-sha-reentry-epoch-fault',False)
 assert json.loads((root/'financial-seed-result.json').read_text())['baselineCaptured']
 c=prepare(final);phase='forward-recovery';entry('none','new-sha-forward-recovery',True)
else:
 phase='success';entry('seed','successful-upgrade',True)
assert callback.wait(timeout=15)==0;callback_log.close()
phase='final-verification';run(['python3',fixture/'parameterized/v240/verify-financial-240.py','--config',root/'active-config.json','--execute-lab'],'final-verification')
result=json.loads((root/'final-verification.json').read_text());assert result['verified']
result['formalEntries']=entries;result['faultEvents']=[json.loads(x) for x in (root/'fault-events.jsonl').read_text().splitlines()];result['scenario']=scenario;result['formalScriptsUnmodified']=True
(root/'report.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'scenario':scenario,'verified':True,'formalEntries':entries,'schema':240}))
