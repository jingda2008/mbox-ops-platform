#!/usr/bin/env python3
import importlib.util, tempfile, pathlib, json, unittest, os, subprocess
spec=importlib.util.spec_from_file_location('bootstrap',pathlib.Path(__file__).with_name('maintenance-bootstrap.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PersistentTests(unittest.TestCase):
 def migration_manifest(self,count):
  files=[{'filename':'%03d_change.sql'%index,'sha256':m.hashlib.sha256(str(index).encode()).hexdigest()} for index in range(1,count+1)]
  digest=m.hashlib.sha256(''.join(row['filename']+'\0'+row['sha256']+'\n' for row in files).encode()).hexdigest()
  return {'migration':{'count':count,'digest':'sha256:'+digest,'files':files}}
 def migration_snapshot(self,count):
  return {'schemaVersion':str(count),'schemaFlavor':'normalized-core-v1','applied':[{'version':'%03d'%i, 'filename':row['filename'],'checksum':row['sha256']} for i,row in enumerate(self.migration_manifest(count)['migration']['files'],1)]}
 def test_ordinary_ancestry_requires_exact_applied_files_not_just_larger_schema(self):
  base,current,target=self.migration_manifest(2),self.migration_manifest(3),self.migration_manifest(4)
  self.assertEqual(m.verify_ordinary_migration_ancestry(base,current,target,self.migration_snapshot(3)),3)
  # Old compatible app retained after a failed ordinary cutover, schema ahead.
  self.assertEqual(m.verify_ordinary_migration_ancestry(base,base,target,self.migration_snapshot(3)),3)
  for snapshot in (self.migration_snapshot(1),self.migration_snapshot(5),{**self.migration_snapshot(3),'schemaVersion':'4'},
                   {**self.migration_snapshot(3),'schemaFlavor':'legacy'}):
   with self.assertRaises(m.Blocked):m.verify_ordinary_migration_ancestry(base,current,target,snapshot)
  for field,value in (('version','004'),('filename','003_other.sql'),('checksum','a'*64)):
   snapshot=self.migration_snapshot(3);snapshot['applied'][-1][field]=value
   with self.assertRaises(m.Blocked):m.verify_ordinary_migration_ancestry(base,current,target,snapshot)
  changed=self.migration_manifest(4);changed['migration']['files'][0]['sha256']='f'*64
  with self.assertRaises(m.Blocked):m.verify_ordinary_migration_ancestry(base,current,changed,self.migration_snapshot(3))
  # Even a recomputed aggregate cannot replace an older immutable migration.
  changed['migration']['digest']='sha256:'+m.hashlib.sha256(''.join(row['filename']+'\0'+row['sha256']+'\n' for row in changed['migration']['files']).encode()).hexdigest()
  with self.assertRaises(m.Blocked):m.verify_ordinary_migration_ancestry(base,current,changed,self.migration_snapshot(3))
  for field,value in (('count',4),('files',[]),('digest','sha256:'+'a'*64)):
   changed=self.migration_manifest(3);changed['migration'][field]=value
   with self.assertRaises(m.Blocked):m.verified_migration_files(changed)
 def test_completed_withdrawals_accept_checked_successors_and_app_rollback_without_writes(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);release=root/'releases'/'base';release.mkdir(parents=True)
   current=root/'releases'/'live';current.mkdir();target=root/'releases'/('c'*7);target.mkdir()
   (root/'current').symlink_to(current);directory=root/'maintenance'/'completed'
   manifest={**self.migration_manifest(2),'releaseSha':'base','imageDigest':'base-image','platformImageDigest':'base-platform'}
   live_manifest={**self.migration_manifest(3),'releaseSha':'live','imageDigest':'live-image','platformImageDigest':'live-platform'}
   candidate={**self.migration_manifest(4),'releaseSha':'c'*40}
   for path,value in ((release,manifest),(current,live_manifest),(target,candidate)):m.atomic(path/'release-manifest.json',value)
   plan={'transitionId':'completed','sourceLive':{'releaseSha':'old'}};m.atomic(release/'maintenance-plan.json',plan)
   binding={'transitionId':'completed','sourceLive':plan['sourceLive'],'forwardRecoveryTarget':{'releaseSha':'base','imageDigest':'base-image','schema':2,'migrationDigest':manifest['migration']['digest']},'planSha256':m.sha(release/'maintenance-plan.json')}
   journal=m.Journal(directory,binding);journal.append('schema-provisioned');journal.append('completed')
   prior=m.Journal(root/'maintenance'/'withdrawn',{'sourceLive':{}});prior.append('drain-intent')
   h=object.__new__(m.Host);h.root=root;h.release=release;h.directory=directory;h.plan=plan;h.manifest=manifest;h.sha='base';h.schema=2;h.public='https://example.test';h.adminservice='admin';h.pg_env={}
   live={'State':{'Running':True},'Image':'live-platform','Config':{'Labels':{'org.opencontainers.image.revision':'live'}}}
   ready={'status':'ready','writeEnabled':True,'commitSha':'live','releaseImageDigest':'live-image','schemaVersion':'3'}
   h.inspect=lambda _:live;h.request=lambda _: (200,ready);queries=[]
   def run(args,input=None,env=None):
    self.assertIn('-XqAt',args);self.assertTrue(input.startswith('BEGIN READ ONLY;'));self.assertIn("statement_timeout='8s'",input);self.assertTrue(input.endswith('ROLLBACK;'));queries.append(input)
    return json.dumps(self.migration_snapshot(3))
   h.run=run;calls=[]
   def verify(path,records,record=True):
    self.assertFalse(record);self.assertEqual(h.ordinary_schema_evidence,{'baseline':2,'current':3});calls.append(path)
   h.verify_withdrawn_transition=verify
   original=m.protected;m.protected=lambda p:pathlib.Path(p)
   try:
    before={str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()}
    self.assertEqual(h.verify_completed_withdrawals(target)['withdrawnTransitions'],['withdrawn'])
    self.assertEqual(before,{str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()})
    self.assertEqual(len(queries),1);self.assertEqual(len(calls),1)
    # Application rollback leaves schema3. Its immutable prefix and live
    # readiness must both prove that state; completed evidence stays schema2.
    live_manifest['migration']=manifest['migration'];m.atomic(current/'release-manifest.json',live_manifest)
    h.verify_completed_withdrawals(target)
    ready['schemaVersion']='2'
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals(target)
    ready['schemaVersion']='3';ready['writeEnabled']=False
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals(target)
    ready['writeEnabled']=True;candidate['releaseSha']='d'*40;m.atomic(target/'release-manifest.json',candidate)
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals(target)
    candidate['releaseSha']='c'*40;m.atomic(target/'release-manifest.json',candidate)
    prior.append('schema-provisioned');prior.path.write_text(prior.path.read_text().replace('schema-provisioned','tampered'))
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals(target)
   finally:m.protected=original
 def test_completed_withdrawal_validation_is_read_only_and_bound_to_live_schema(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);release=root/'releases'/'done';release.mkdir(parents=True)
   (root/'current').symlink_to(release);directory=root/'maintenance'/'completed'
   manifest={'releaseSha':'done','imageDigest':'digest','platformImageDigest':'platform','migration':{'count':242,'digest':'migration'}}
   m.atomic(release/'release-manifest.json',manifest)
   plan={'transitionId':'completed','sourceLive':{'releaseSha':'old'}};m.atomic(release/'maintenance-plan.json',plan)
   binding={'transitionId':'completed','sourceLive':plan['sourceLive'],'forwardRecoveryTarget':{'releaseSha':'done','imageDigest':'digest','schema':242,'migrationDigest':'migration'},'planSha256':m.sha(release/'maintenance-plan.json')}
   journal=m.Journal(directory,binding);journal.append('schema-provisioned');journal.append('completed')
   prior=m.Journal(root/'maintenance'/'withdrawn',{'sourceLive':{}});prior.append('drain-intent')
   h=object.__new__(m.Host);h.root=root;h.release=release;h.directory=directory;h.plan=plan;h.manifest=manifest;h.sha='done';h.schema=242;h.public='https://example.test'
   live={'State':{'Running':True},'Image':'platform','Config':{'Labels':{'org.opencontainers.image.revision':'done'}}}
   ready={'status':'ready','writeEnabled':True,'commitSha':'done','releaseImageDigest':'digest','schemaVersion':'242'}
   h.inspect=lambda _:live;h.request=lambda _: (200,ready)
   calls=[]
   def verify(path,records,record=True):
    self.assertFalse(record);self.assertEqual(path,prior.path);calls.append(path)
   h.verify_withdrawn_transition=verify
   original=m.protected;m.protected=lambda p:pathlib.Path(p)
   try:
    before={str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()}
    self.assertEqual(h.verify_completed_withdrawals()['withdrawnTransitions'],['withdrawn'])
    self.assertEqual(before,{str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()})
    # A later ordinary release remains eligible only with exactly the same schema.
    next_release=root/'releases'/'next';next_release.mkdir();next_manifest={**manifest,'releaseSha':'next','imageDigest':'next-digest','platformImageDigest':'next-platform'}
    m.atomic(next_release/'release-manifest.json',next_manifest);(root/'current').unlink();(root/'current').symlink_to(next_release)
    live['Image']='next-platform';live['Config']['Labels']['org.opencontainers.image.revision']='next';ready.update(commitSha='next',releaseImageDigest='next-digest')
    h.verify_completed_withdrawals()
    for change in ({'writeEnabled':False},{'commitSha':'wrong'},{'schemaVersion':'243'}):
     saved=ready.copy();ready.update(change)
     with self.assertRaises(m.Blocked):h.verify_completed_withdrawals()
     ready.clear();ready.update(saved)
    next_manifest['migration']={'count':242,'digest':'wrong'};m.atomic(next_release/'release-manifest.json',next_manifest)
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals()
    next_manifest['migration']=manifest['migration'];m.atomic(next_release/'release-manifest.json',next_manifest)
    plan['changed']=True;m.atomic(release/'maintenance-plan.json',plan)
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals()
    plan.pop('changed');m.atomic(release/'maintenance-plan.json',plan)
    prior.path.write_text(prior.path.read_text().replace('drain-intent','other-event'))
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals()
    m.atomic(prior.path,{})
    with self.assertRaises(m.Blocked):h.verify_completed_withdrawals()
   finally:m.protected=original
 def test_unmigrated_withdrawal_requires_bound_evidence_and_stopped_controls(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);directory=root/'maintenance-original';release=root/'source';release.mkdir()
   (release/'release-manifest.json').write_text(json.dumps({'migration':{'count':224}}))
   binding={'sourceLive':{'releaseSha':'old'},'forwardRecoveryTarget':{'releaseSha':'cancelled'}}
   journal=m.Journal(directory,binding);journal.append('drain-intent');journal.append('maintenance-required')
   receipt={'at':m.time.time()+1,'status':'original-production-restored','databaseReplaced':False,'sourceEvidenceUnchangedBeforeRestart':True,'journalAndEpochPreserved':True,'maintenanceGuardDisabled':True,'maintenanceIngressStopped':True,'callbackQueue':{'pending':0,'active':0,'replaying':False},'sourceReleaseSha':'old','deploymentCancelled':'cancelled','schemaVersion':224}
   receipt_path=directory/'operator-cancelled-unmigrated.json';m.atomic(receipt_path,receipt)
   entry={'transitionId':directory.name,'journalSha256':m.sha(journal.path),'receiptSha256':m.sha(receipt_path)}
   h=object.__new__(m.Host);h.plan={'withdrawnTransitions':[entry],'sourceLive':{'releaseDirectory':str(release)}};h.adminservice='admin';h.reentry=False
   h.sql=lambda *a:'224';h.optional_container=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}}
   h.run=lambda *a:'MainPID=0\nActiveState=inactive\nUnitFileState=disabled';h.save=lambda *a:None
   original=m.protected;m.protected=lambda p:pathlib.Path(p)
   try:
    h.verify_withdrawn_transition(journal.path,journal.records)
    h.plan['withdrawnTransitions']=[]
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.plan['withdrawnTransitions']=[entry];h.sql=lambda *a:'225'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    # The old withdrawal remains schema224; this transition has genuinely
    # provisioned242. Re-entry and a later target may retain that exact state.
    h.reentry=True;current_binding={'sourceLive':h.plan['sourceLive'],'forwardRecoveryTarget':{'releaseSha':'new','schema':242}}
    h.journal=m.Journal(root/'current',current_binding);h.journal.append('drain-intent')
    h.sql=lambda *a:'242'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.journal.append('schema-provisioned')
    h.verify_withdrawn_transition(journal.path,journal.records)
    next_binding={**current_binding,'forwardRecoveryTarget':{'releaseSha':'next','schema':243}}
    h.journal=m.Journal(root/'current',next_binding,h.journal.records[-1]['hash'])
    h.verify_withdrawn_transition(journal.path,journal.records)
    h.sql=lambda *a:'243'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.sql=lambda *a:'224'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.sql=lambda *a:'241'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.sql=lambda *a:'243';h.journal.append('completed')
    h.ordinary_schema_evidence={'baseline':242,'current':243}
    h.verify_withdrawn_transition(journal.path,journal.records,record=False)
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.sql=lambda *a:'244'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records,record=False)
    h.ordinary_schema_evidence=None
    h.sql=lambda *a:'242';h.reentry=False
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.reentry=True;h.plan['sourceLive']={'releaseDirectory':str(release),'releaseSha':'wrong'}
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.plan['sourceLive']=current_binding['sourceLive'];h.reentry=False
    h.sql=lambda *a:'224';h.run=lambda *a:'MainPID=23\nActiveState=active\nUnitFileState=disabled'
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.run=lambda *a:'MainPID=0\nActiveState=inactive\nUnitFileState=disabled'
    h.optional_container=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'always'}}}
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    h.optional_container=lambda _:None;receipt['callbackQueue']['pending']=1;m.atomic(receipt_path,receipt)
    entry['receiptSha256']=m.sha(receipt_path)
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
    receipt['callbackQueue']['pending']=0;m.atomic(receipt_path,receipt);entry['receiptSha256']=m.sha(receipt_path)
    journal.append('schema-provisioned');entry['journalSha256']=m.sha(journal.path)
    with self.assertRaises(m.Blocked):h.verify_withdrawn_transition(journal.path,journal.records)
   finally:m.protected=original
 def test_systemd_inventory_ignores_only_static_numeric_login_scopes(self):
  persistent='crond.service enabled\nmbox-health-watchdog.timer enabled'
  first='session-119.scope static\nsession-60929.scope static\n'+persistent
  second='session-119.scope static\nsession-60930.scope static\n'+persistent
  self.assertNotEqual(m.hashlib.sha256(first.encode()).hexdigest(),m.hashlib.sha256(second.encode()).hexdigest())
  self.assertEqual(m.systemd_inventory_sha256(first),m.systemd_inventory_sha256(second))
  self.assertNotEqual(m.systemd_inventory_sha256('session-1.scope static\n writer.service enabled'),m.systemd_inventory_sha256('session-2.scope static\nwriter.service enabled'))
  for changed in (persistent+'\nnew-writer.service enabled',persistent.replace('crond.service enabled','crond.service disabled'),
                  persistent+'\nsession-60930.service enabled',persistent+'\nsession-custom.scope static',
                  persistent+'\nsession-60930.scope enabled',persistent.replace('enabled','masked')):
   self.assertNotEqual(m.systemd_inventory_sha256(first),m.systemd_inventory_sha256(changed))
 def binding(self,sha='a',schema=229): return {'sourceLive':{'releaseSha':'s'},'forwardRecoveryTarget':{'releaseSha':sha,'schema':schema},'planSha256':sha}
 def row(self,id='a',fingerprint='1',classification='baseline_candidate:stopped_payment_finance_review'):
  return {'kind':'payment','tenant_id':'t','store_id':'s','id':id,'facts_sha256':fingerprint,'classification':classification}
 def test_history_baseline_is_identity_and_fingerprint_bound_not_count_based(self):
  old=self.row(); new=self.row('b')
  self.assertEqual(m.funds_delta([old],[old],set())['blockingCount'],0)
  result=m.funds_delta([new],[old],set())
  self.assertEqual(result['blockingCount'],2);self.assertEqual(len(result['missingOriginalFacts']),1)
  self.assertEqual(m.funds_delta([self.row(fingerprint='2')],[old],set())['blockingCount'],1)
 def test_only_explicit_terminal_resolution_releases_missing_original(self):
  old=self.row();key=m.funds_key(old)
  self.assertEqual(m.funds_delta([],[old],set())['blockingCount'],1)
  self.assertEqual(m.funds_delta([],[old],{key})['blockingCount'],0)
  self.assertEqual(m.funds_delta([self.row(classification='block:unresolved_payment')],[old],{key})['blockingCount'],1)
 def test_baseline_never_refreshes_after_migration(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.directory=pathlib.Path(d);h.journal=m.Journal(d,{})
   h.journal.append('schema-provisioned')
   with self.assertRaises(m.Blocked):h.freeze_funds()
 def test_systemd_219_separates_persistent_mask_and_stop(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.draining=True;h.journal=m.Journal(d,{});h.directory=pathlib.Path(d);h.login='runtime';h.candidate='candidate';h.plan={'writerContainerIds':[],'systemdUnits':['cron.service']};calls=[]
   h.optional_container=lambda name:{'Id':name};h.inspect=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}};h.route=lambda _:None;h.sql=lambda _:None;h.run=lambda args,**kwargs:(calls.append(args) or ('masked' if 'is-enabled' in args else 'inactive' if 'is-active' in args else ''));h.assert_zero=lambda:None;h.save=lambda *args:None
   h.fail_closed('fault')
   self.assertIn(['systemctl','mask','cron.service'],calls);self.assertIn(['systemctl','stop','cron.service'],calls)
   self.assertFalse(any('--now' in c for c in calls))
 def test_main_and_imported_payment_routes_restore_from_same_persistent_baseline(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);main=root/'Caddyfile';data=root/'data';(data/'mbox-ingress').mkdir(parents=True)
   main.write_text(':80 { reverse_proxy mbox-app:8787 }\nimport /data/mbox-ingress/*.caddy\n');snippet=data/'mbox-ingress/payment-domain.caddy';snippet.write_text('https://pay.invalid { reverse_proxy mbox-app:8787 }\n')
   original=[main.read_text(),snippet.read_text()];h=object.__new__(m.Host);h.directory=root/'journal';h.directory.mkdir();h.ingress='isolated-maintenance';h.run=lambda *a,**k:None
   h.inspect=lambda _: {'Mounts':[{'Type':'bind','Destination':'/etc/caddy/Caddyfile','Source':str(main)},{'Type':'volume','Destination':'/data','Source':str(data)}]}
   h.route(True);self.assertIn('isolated-maintenance:8787',main.read_text());self.assertIn('isolated-maintenance:8787',snippet.read_text())
   h.route(True);h.route(False);self.assertEqual([main.read_text(),snippet.read_text()],original)
   main.write_text('import /unknown/*.caddy\n')
   with self.assertRaises(m.Blocked):h.caddy_sources()
 def test_public_probe_gets_actual_callback_path_and_never_sends_control_secret(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.directory=pathlib.Path(d);secret='private-control-secret-123456789012345';(h.directory/'control-token').write_text(secret)
   h.public='https://app.invalid';h.plan={'callbackUrls':['https://pay.invalid/api/payments/providers/postar/callback']};calls=[]
   def request(url,**options):
    calls.append((url,options))
    if '?mboxMaintenanceChallenge=' in url:
     challenge=url.split('mboxMaintenanceChallenge=')[1];return 503,{'reason':'planned_maintenance_upgrade','proof':m.hmac.new(secret.encode(),challenge.encode(),m.hashlib.sha256).hexdigest()}
    return 503,{'reason':'planned_maintenance_upgrade'}
   h.request=request;h.save=lambda *args:None;h.verify_ingress_routes()
   self.assertTrue(any(url.startswith(h.plan['callbackUrls'][0]+'?mboxMaintenanceChallenge=') for url,_ in calls));self.assertNotIn(secret,str(calls))
   h.request=lambda url,**kw:(200,{'status':'old-app'})
   with self.assertRaises(m.Blocked):h.verify_ingress_routes()
 def test_optional_docker_inspect_requires_successful_absence_inventory(self):
  h=object.__new__(m.Host)
  for output in ('','[]','[ ]'):
   h.run=lambda args,**kw:output if args[1]=='inspect' else '';self.assertIsNone(h.optional_container('absent'))
  h.run=lambda *a,**kw:'[{"Id":"exact"}]';self.assertEqual(h.optional_container('present'),{'Id':'exact'})
  for output in ('{}','[{},{}]'):
   h.run=lambda *a,**kw:output
   with self.assertRaises(m.Blocked):h.optional_container('ambiguous')
  def daemon_down(args,**kwargs):
   if args[1]=='inspect':return '[]'
   raise m.Blocked('daemon unavailable')
  h.run=daemon_down
  with self.assertRaises(m.Blocked):h.optional_container('absent')
  h.run=lambda args,**kw:'[]' if args[1]=='inspect' else 'a'*64+'\tcandidate'
  for name in ('candidate','a'*64,'a'*12):
   with self.assertRaises(m.Blocked):h.optional_container(name)
 def test_failure_fence_skips_only_verified_absence_and_checks_stopped_identity(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.draining=True;h.journal=m.Journal(d,{});h.directory=pathlib.Path(d);h.login='runtime';h.candidate='missing';h.plan={'writerContainerIds':['old']};calls=[];reports=[]
   h.route=lambda _:None;h.sql=lambda _:None;h.run=lambda args,**kw:calls.append(args);h.assert_zero=lambda:None;h.save=lambda name,value:reports.append(value)
   h.optional_container=lambda name:None if name in ('missing','mbox-app') else {'Id':'old'}
   h.inspect=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}}
   self.assertTrue(h.fail_closed('stage before candidate exists'))
   self.assertNotIn(['docker','stop','-t','60','missing'],calls)
   h.inspect=lambda _: {'State':{'Running':True},'HostConfig':{'RestartPolicy':{'Name':'no'}}}
   self.assertFalse(h.fail_closed('stop did not stop'))
 def test_forward_ingress_rebinds_image_and_script_preserving_spool_on_creation_failure(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.directory=pathlib.Path(d)/'maintenance';h.directory.mkdir(mode=0o700);(h.directory/'callbacks').mkdir();receipt=h.directory/'callbacks/receipt.json';receipt.write_text('{"original":"signed-bytes"}');epoch=h.directory/'business-write-epoch.json';epoch.write_text('{"reason":"original"}')
   # Directory ownership is a production requirement; this test isolates the
   # lifecycle helper by mocking only stat ownership, never Docker responses.
   h.root=pathlib.Path(d);h.sha='b'*40;h.release=h.root/'releases'/h.sha[:7];h.release.mkdir(parents=True);h.image='candidate';h.ingress='ingress';h.args=[];h.journal=m.Journal(h.directory,{})
   old={'Id':'1'*64,'State':{'Running':True}};new={'Id':'2'*64,'State':{'Running':True}};state={'current':old,'fail':True};calls=[]
   h.ingress_binding=lambda container:{'containerId':container['Id'],'releaseSha':'a'*40 if container['Id']==old['Id'] else h.sha,'platformImageDigest':'digest','scriptSha256':'hash'}
   h.inspect=lambda name:old if name==old['Id'] else state['current']
   def run(args,**kw):
    calls.append(args)
    if args[:2]==['docker','inspect']:return json.dumps([state['current']]) if state['current'] else ''
    if args[:2]==['docker','stop']:old['State']['Running']=False
    if args[:2]==['docker','rename']:state['current']=None
    if args[:2]==['docker','run']:
     if state['fail']:raise m.Blocked('injected new-image start failure')
     state['current']=new
    return ''
   h.run=run;h.control=lambda _: {'pending':1};original=(receipt.read_bytes(),epoch.read_bytes())
   from unittest.mock import patch
   real_stat=pathlib.Path.stat
   def stat(path,*args,**kwargs):
    result=real_stat(path,*args,**kwargs)
    if path==h.directory:
     values=list(result);values[4]=0;return os.stat_result(values)
    return result
   with patch.object(pathlib.Path,'stat',stat):
    with self.assertRaises(m.Blocked):h.start_ingress()
    self.assertFalse(old['State']['Running']);self.assertIsNone(state['current']);self.assertEqual((receipt.read_bytes(),epoch.read_bytes()),original)
    state['fail']=False;h.start_ingress()
   self.assertEqual(json.loads((h.directory/'ingress-active.json').read_text())['releaseSha'],h.sha)
   self.assertEqual((receipt.read_bytes(),epoch.read_bytes()),original)
   self.assertIn(['docker','update','--restart=no',old['Id']],calls)
   self.assertFalse(any(c[:2]==['docker','start'] and old['Id'] in c for c in calls))
 def test_backup_reentry_uses_actual_verified_target_after_an_earlier_preflight_failure(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.root=pathlib.Path(d);first='a'*40;verified='b'*40
   h.journal=m.Journal(h.root/'journal',self.binding(first));h.journal=m.Journal(h.root/'journal',self.binding(verified),h.journal.records[-1]['hash'])
   release=h.root/'releases'/verified[:7];stage=release/'oss-maintenance-backup';stage.mkdir(parents=True)
   (release/'release-manifest.json').write_text(json.dumps({'releaseSha':verified}));original=h.root/'original.dump';original.write_bytes(b'actual stopped database backup');(stage/original.name).write_bytes(original.read_bytes());proof=stage/'maintenance-restore-verification.json';proof.write_text('{"verified":true}')
   record={'releaseSha':verified,'backup':str(original),'sha256':m.sha(original),'restoreReportSha256':m.sha(proof)}
   self.assertEqual(h.verified_backup_stage(record),stage)
   legacy={k:v for k,v in record.items() if k!='releaseSha'}
   with self.assertRaises(m.Blocked):h.verified_backup_stage(legacy)
   h.journal.append('backup-verified',legacy)
   h.journal=m.Journal(h.root/'journal',self.binding('c'*40),h.journal.records[-1]['hash'])
   self.assertEqual(h.verified_backup_stage(legacy),stage);self.assertEqual(h.verified_backup_stage(record),stage)
   with self.assertRaises(m.Blocked):h.verified_backup_stage({**record,'releaseSha':'d'*40})
   proof.write_text('{"replaced":true}')
   with self.assertRaises(m.Blocked):h.verified_backup_stage(record)
 def test_maintenance_services_share_one_ca_mount_without_docker_duplicate_targets(self):
  from unittest.mock import patch
  h=object.__new__(m.Host);h.maintenance={'PGSERVICEFILE':'/opt/mbox/secrets/services','PGPASSFILE':'/opt/mbox/secrets/pass'};h.adminservice='admin';h.appservice='app';h.backupservice='backup';h.services={key:{'sslrootcert':'/opt/mbox/secrets/ca.pem'} for key in ('admin','app','backup')};h.store=pathlib.Path('/config/store');h.catalog=pathlib.Path('/config/catalog');h.release=pathlib.Path('/release');h.args=[];h.image='image';calls=[];h.run=lambda args:calls.append(args)
  with patch.object(pathlib.Path,'is_file',return_value=True),patch.object(pathlib.Path,'is_symlink',return_value=False):
   h.maintenance_command('migrate','--verify-only')
  self.assertEqual(calls[0].count('type=bind,src=/opt/mbox/secrets/ca.pem,dst=/opt/mbox/secrets/ca.pem,readonly'),1)
  self.assertIn('--verify-only',calls[0]);self.assertIn('--maintenance-service=admin',calls[0])
 def test_reentry_keeps_epoch_and_hash_chain(self):
  with tempfile.TemporaryDirectory() as d:
   j=m.Journal(d,self.binding());j.append('drain-intent');j.epoch('before-worker')
   original=pathlib.Path(d,'business-write-epoch.json').read_bytes();j2=m.Journal(d,self.binding());j2.epoch('bad-reset')
   self.assertEqual(pathlib.Path(d,'business-write-epoch.json').read_bytes(),original)
   self.assertTrue(j2.has('drain-intent'));self.assertEqual(len(j2.records),2)
 def test_rejects_torn_or_altered_journal(self):
  for suffix in [b'{"torn":',b'\n{}\n']:
   with tempfile.TemporaryDirectory() as d:
    m.Journal(d,self.binding());p=pathlib.Path(d,'journal.jsonl');p.write_bytes(p.read_bytes()+suffix)
    with self.assertRaises(Exception): m.Journal(d,self.binding())
 def test_forward_repair_requires_exact_last_hash_and_same_source_and_no_schema_downgrade(self):
  with tempfile.TemporaryDirectory() as d:
   j=m.Journal(d,self.binding());j.append('maintenance-required');old=j.records[-1]['hash']
   with self.assertRaises(m.Blocked): m.Journal(d,self.binding('b'),recovery_from='stale')
   with self.assertRaises(m.Blocked): m.Journal(d,self.binding('b',228),recovery_from=old)
   nxt=m.Journal(d,self.binding('b'),recovery_from=old);self.assertTrue(nxt.has('forward-target'))
   self.assertEqual(nxt.records[0]['data'],self.binding())
 def test_epoch_survives_child_abrupt_exit(self):
  with tempfile.TemporaryDirectory() as d:
   code="import importlib.util,os; s=importlib.util.spec_from_file_location('m',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);j=m.Journal(%r,{});j.epoch('worker');os._exit(9)"%(str(pathlib.Path(m.__file__)),d)
   result=subprocess.run(['python3','-c',code]);self.assertEqual(result.returncode,9)
   self.assertEqual(json.loads(pathlib.Path(d,'business-write-epoch.json').read_text())['reason'],'worker')
 def test_failure_attempts_every_fence_even_when_route_reload_fails(self):
  with tempfile.TemporaryDirectory() as d:
   h=object.__new__(m.Host);h.draining=True;h.journal=m.Journal(d,{});h.directory=pathlib.Path(d);h.login='runtime';h.candidate='candidate';h.plan={'writerContainerIds':['old']};events=[]
   def route(_): events.append('route');raise m.Blocked('reload')
   h.optional_container=lambda name:{'Id':name};h.inspect=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}};h.route=route;h.sql=lambda q:events.append(q);h.run=lambda args:events.append(args);h.assert_zero=lambda:events.append('connections-zero');h.save=lambda name,value:events.append(value)
   h.fail_closed('fault')
   self.assertIn('ALTER ROLE "runtime" NOLOGIN;',events);self.assertIn('connections-zero',events)
   self.assertIn(['docker','stop','-t','60','old'],events);self.assertTrue(h.journal.has('maintenance-required'))
   self.assertNotIn(['docker','start','old'],events)
 def test_before_drain_failure_leaves_original_live_untouched(self):
  h=object.__new__(m.Host);h.draining=False;h.journal=None;h.fail_closed('preflight')
 def test_all_failure_stages_preserve_epoch_and_never_start_old(self):
  # Each stage exercises the actual common error path, not a second rollback model.
  for stage in ['route','service-mask','docker-stop','connection-drain','backup','restore-drill','oss-readback','migration-225','migration-228','migration-229','identity','readonly-start','epoch-upload','worker-start','callback-replay','fund-reconciliation','public-cutover','completion-evidence']:
   with self.subTest(stage=stage),tempfile.TemporaryDirectory() as d:
    h=object.__new__(m.Host);h.draining=True;h.journal=m.Journal(d,{});h.directory=pathlib.Path(d);h.login='runtime';h.candidate='candidate';h.plan={'writerContainerIds':['old']};calls=[]
    h.optional_container=lambda name:{'Id':name};h.inspect=lambda _: {'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}}};h.route=lambda state:calls.append(('route',state));h.sql=lambda q:calls.append(('sql',q));h.run=lambda a:calls.append(tuple(a));h.assert_zero=lambda:None;h.save=lambda *args:None
    h.journal.epoch('original');h.fail_closed(stage)
    self.assertTrue(pathlib.Path(d,'business-write-epoch.json').exists());self.assertIn(('docker','stop','-t','60','old'),calls)
    self.assertFalse(any(x[:2]==('docker','start') for x in calls))
if __name__=='__main__':
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(PersistentTests);result=unittest.TextTestRunner().run(suite)
 if not result.wasSuccessful():raise SystemExit(1)
 print('maintenance fault assertions passed')
