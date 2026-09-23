"""Invoked exclusively inside a disposable network-none nested systemd LAB."""
import configparser,hashlib,json,os,shutil,socket,subprocess,sys,time,traceback
from pathlib import Path
root=Path('/root/LAB-final');fixture=root/'fixture';logs=root/'private-logs';logs.mkdir(exist_ok=True)
assert os.uname().machine=='x86_64' and Path('/.dockerenv').exists()
assert socket.gethostname().startswith('mbox-maint-lab-')
assert not any(row.split()[1]=='00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:])
scenario=sys.argv[1];assert scenario in ('success','forward')
constants=json.loads((root/'images.json').read_text());identities=json.loads((root/'run-identities.json').read_text());initial=identities['initialSha'];final=identities['finalSha'];assert not identities['candidateOnly'] or scenario=='success'
phase='setup';entries=[]
def run(args,label,timeout=300,success=True,env=None):
 with (logs/(label+'.log')).open('w') as f:
  p=subprocess.run([str(x) for x in args],stdout=f,stderr=subprocess.STDOUT,timeout=timeout,env={**os.environ,**(env or {})})
 if success:assert p.returncode==0,label+' failed'
 return p.returncode
run(['python3',fixture/'setup-host.py'],'setup')
run(['python3',fixture/'start-source.py'],'old-source')
run(['python3',fixture/'seed-inflight.py'],'inflight')
run(['bash',fixture/'install-container-clients.sh'],'container-client-wrapper')
# Verifier uses loopback; application containers retain the separate bridge route.
service=Path('/opt/mbox/secrets/pg_service.conf').read_text();gateway=json.loads(Path('/opt/mbox/lab-state.json').read_text())['gateway']
(root/'pg_service.conf').write_text(service.replace('host='+gateway,'host=127.0.0.1'))
(root/'pgpass').write_text(Path('/opt/mbox/secrets/pgpass').read_text().replace(gateway+':','127.0.0.1:'));os.chmod(root/'pgpass',0o600)
transition='local-entry-20260921-a';directory=Path('/opt/mbox/maintenance')/transition
marker={'labId':'rc224-'+('candidate-' if identities['candidateOnly'] else '')+scenario,'controllerHostname':socket.gethostname(),'isolatedNestedDocker':True,'externalNetwork':False};(root/'isolated-lab.json').write_text(json.dumps(marker))
def prepare(sha):
 image=constants[sha];c=json.loads((fixture/'parameterized/config.template.json').read_text())
 c.update(version=identities['version'],labId=marker['labId'],controllerHostname=marker['controllerHostname'],targetSha=sha,sourceSha='c8d989f21757f2da8211a9852eac87f127bfcd5f',backupOriginSha=initial if scenario=='forward' else final,imageTag=image['tag'],imageDigest=image['digest'],platformImageDigest=image['config'],platform='linux/amd64',schema=242,sourceDirectory=str(root/('source-'+sha[:7])),bundleDirectory=str(root/('bundle-'+sha[:7])),sourceReleaseDirectory='/opt/mbox/releases/c8d989f',imageArchive=str(root/image['archive']),sourceShaFile=str(root/('sha-'+sha[:7])),formalEntryScript=str(root/'formal-entry.sh'),sshKeyFile='/root/.ssh/lab_release',transitionId=transition,labCiRunId='9000000001',callbackBodyFile='/root/lab-callback-body.json')
 (root/('sha-'+sha[:7])).write_text(sha+'\n');(root/'active-config.json').write_text(json.dumps(c));run(['python3',fixture/'parameterized/prepare-bundle-parameterized.py','--config',root/'active-config.json','--execute-lab'],'prepare-'+sha[:7]);
 # Reproduce a non-root publisher and a previously copied wrong-owner plan.
 # Only disposable LAB paths are changed; formal scripts remain unmodified.
 for path in [Path(c['bundleDirectory']),Path(c['bundleDirectory'])/'maintenance-plan.json',Path('/opt/mbox/releases')/sha[:7]/'maintenance-plan.json']:
  os.chown(path,12345,12346)
 os.chmod(c['bundleDirectory'],0o775)
 Path('/usr/local/bin/ossutil').rename('/usr/local/bin/ossutil.lab-base');shutil.copyfile(fixture/'object-fault.py','/usr/local/bin/ossutil');os.chmod('/usr/local/bin/ossutil',0o755)
 return c
c=prepare(initial if scenario=='forward' else final)
env={'NODE_EXTRA_CA_CERTS':'/usr/local/share/ca-certificates/mbox-lab-ca.crt'}
callback_log=(logs/'callback.log').open('w');callback=subprocess.Popen(['node',fixture/'send-delayed-callback.mjs'],stdout=callback_log,stderr=subprocess.STDOUT,env={**os.environ,**env})
def entry(mode,label,expected):
 (root/'fault-mode').write_text(mode);code=run(['bash',root/'formal-entry.sh'],label,timeout=900,success=False)
 destination=Path('/opt/mbox/releases')/c['targetSha'][:7]
 plan=destination/'maintenance-plan.json';plan_stat=plan.stat();directory_stat=destination.stat()
 assert plan_stat.st_uid==0 and plan_stat.st_gid==0 and plan_stat.st_mode&0o777==0o600
 assert directory_stat.st_uid==0 and directory_stat.st_mode&0o777==0o700
 assert (Path(c['bundleDirectory'])/'maintenance-plan.json').stat().st_uid==12345
 entries.append({'label':label,'exitCode':code,'expectedSuccess':expected,'sourceSha':c['targetSha'],
                 'publisherUid':12345,'publisherGid':12346,'publisherDirectoryMode':'0775',
                 'receiverPlanRoot0600':True,'receiverDirectoryRoot0700':True,'sourceOwnerUnchanged':True})
 (root/'entry-results.json').write_text(json.dumps(entries,indent=2)+'\n')
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
# Record the real post-upgrade definer and table owner. This synthetic local
# PostgreSQL administrator is not proof of RDS provider-role capabilities.
query="""BEGIN READ ONLY; SET LOCAL statement_timeout='8000ms';
 SELECT json_build_object('sessionLogin',session_user,'currentLogin',current_user,
   'functionOwner',owner.rolname,'ownerSuper',owner.rolsuper,'ownerBypassRls',owner.rolbypassrls,
   'securityDefiner',proc.prosecdef,'searchPath',proc.proconfig,
   'tableOwner',tab.relowner::regrole::text,'tableForceRls',tab.relforcerowsecurity,
   'oldSeedOwner',(SELECT proowner::regrole::text FROM pg_proc WHERE oid='mbox.seed_member_card_permission_definitions()'::regprocedure),
   'runtimeExecute',has_function_privilege('lab_runtime','mbox.advance_staff_access_revision()','EXECUTE'))
 FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner
 JOIN pg_class tab ON tab.oid='mbox.staff_access_revisions'::regclass
 WHERE proc.oid='mbox.advance_staff_access_revision()'::regprocedure; COMMIT;"""
owner_env={**os.environ,'PGSERVICEFILE':str(root/'pg_service.conf'),'PGPASSFILE':str(root/'pgpass')}
owner=json.loads(subprocess.check_output(['psql','-XqAt','--dbname=service=migration','-v','ON_ERROR_STOP=1','-c',query],env=owner_env,text=True))
assert owner['functionOwner']==owner['tableOwner']==owner['currentLogin']==owner['sessionLogin']
assert owner['securityDefiner'] and owner['tableForceRls'] and (owner['ownerSuper'] or owner['ownerBypassRls'])
assert owner['oldSeedOwner']=='lab_old' and owner['runtimeExecute'] is False
assert [value.replace(' ','') for value in owner['searchPath']]==['search_path=pg_catalog,mbox']
result['staffRevisionOwner']=owner
closure_query="""BEGIN READ ONLY; SET LOCAL statement_timeout='8000ms';
 SELECT json_build_object('functionOwner',owner.rolname,'ownerSuper',owner.rolsuper,'ownerBypassRls',owner.rolbypassrls,
 'securityDefiner',proc.prosecdef,'searchPath',proc.proconfig,
 'admissionOwner',(SELECT relowner::regrole::text FROM pg_class WHERE oid='mbox.closed_debt_manual_payment_admissions'::regclass),
 'runtimeExecute',has_function_privilege('lab_runtime',proc.oid,'EXECUTE'),
 'privateOwnersMatch',(SELECT bool_and(proowner=proc.proowner) FROM pg_proc WHERE oid IN (
   'mbox.allow_closed_debt_manual_payment(jsonb,uuid)'::regprocedure,
   'mbox.allow_closed_order_verified_payment_projection(jsonb,jsonb,uuid)'::regprocedure,
   'mbox.allow_closed_order_manual_debt_projection(jsonb,jsonb,uuid)'::regprocedure)))
 FROM pg_proc proc JOIN pg_roles owner ON owner.oid=proc.proowner
 WHERE proc.oid='mbox.lock_table_session_for_closure_fact_write()'::regprocedure; COMMIT;"""
closure=json.loads(subprocess.check_output(['psql','-XqAt','--dbname=service=migration','-v','ON_ERROR_STOP=1','-c',closure_query],env=owner_env,text=True))
assert closure['functionOwner']==closure['admissionOwner']==owner['currentLogin']
assert closure['privateOwnersMatch'] and closure['securityDefiner'] and closure['runtimeExecute'] is False
assert closure['ownerSuper'] or closure['ownerBypassRls']
assert [value.replace(' ','') for value in closure['searchPath']]==['search_path=pg_catalog,mbox']
result['closureGuardOwner']=closure
result['limits'].append('LAB migration login is its local PostgreSQL administrator; RDS provider-role authority needs separate production verification')
result['previousUnmigratedWithdrawalRetained']=True
result['candidateOnly']=identities['candidateOnly'];result['officialReleaseImageUsed']=not identities['candidateOnly'];result['formalEntries']=entries;result['faultEvents']=[json.loads(x) for x in (root/'fault-events.jsonl').read_text().splitlines()];result['scenario']=scenario;result['formalScriptsUnmodified']=True
(root/'report.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'scenario':scenario,'verified':True,'formalEntries':entries,'schema':242}))
