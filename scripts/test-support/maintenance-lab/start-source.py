import pathlib,subprocess,json,os,time,shutil
P=pathlib.Path;root=P('/opt/mbox');state=json.loads((root/'lab-state.json').read_text());release=P(state['oldRelease']);image=state['oldImage'];sha='5b9d929499b1d8cb0eb3a0c0668604e9a398f1fe'
def run(args,input=None):
 r=subprocess.run([str(x) for x in args],input=input,text=True,capture_output=True)
 if r.returncode:raise RuntimeError('lab command failed '+str(args[0])+': '+r.stderr[-2000:])
 return r.stdout.strip()
common=['docker','run','--rm','--network','mbox-net','--env-file',root/'secrets/old.env','--mount','type=bind,src='+str(release)+',dst=/lab,readonly']
(root/'old-migrations.log').write_text(run([*common,image,'node','dist-normalized/server/migrate-normalized.js']))
(root/'old-provision.log').write_text(run([*common,image,'node','dist-normalized/server/provision-normalized-release.js','--store=/lab/store.json','--catalog=/lab/catalog.json']))
pgenv={'PGSERVICEFILE':str(root/'secrets/pg_service.conf'),'PGPASSFILE':str(root/'secrets/pgpass')};os.environ.update(pgenv)
run(['psql','-XAt','--dbname=service=migration','-v','ON_ERROR_STOP=1'], 'GRANT mbox_runtime TO lab_runtime;')
platform=run(['docker','image','inspect',image,'--format','{{.Id}}'])
manifest=json.loads(P('/root/LAB-final/old-release/release-manifest.json').read_text());assert manifest['releaseSha']==sha and manifest['platformImageDigest']==platform and manifest['migration']['count']==224;manifest['imageTag']=image

(release/'release-manifest.json').write_text(json.dumps(manifest));(root/'current').symlink_to(release)
# Reproduce the existing release layout required by the unchanged activator.
for target in (root/'secrets/app.env',release/'app.env'):
 shutil.copyfile(root/'secrets/old.env',target);os.chmod(target,0o600)
(root/'.env').symlink_to(release/'app.env')
(root/'data').mkdir(exist_ok=True);os.chown(root/'data',1000,1000)
container=run(['docker','run','-d','--name','mbox-app','--restart=unless-stopped','--network','mbox-net','--env-file',root/'secrets/old.env','--mount','type=bind,src='+str(root/'data')+',dst=/data','--mount','type=bind,src='+str(release/'worker-adapters')+',dst=/app/worker-adapters,readonly',image])
(root/'caddy-data/mbox-ingress').mkdir(parents=True,exist_ok=True)
(root/'Caddyfile').write_text('https://localhost {\n tls /certs/cert.pem /certs/key.pem\n reverse_proxy mbox-app:8787\n}\nimport /data/mbox-ingress/*.caddy\n')
(root/'caddy-data/mbox-ingress/payment-domain.caddy').write_text('https://payments.localhost {\n tls /certs/cert.pem /certs/key.pem\n @routes path /api/ready /api/payments/providers/postar/callback /api/refunds/providers/postar/callback\n handle @routes {\n reverse_proxy mbox-app:8787\n }\n handle {\n respond 404\n }\n}\n')
run(['docker','run','-d','--name','mbox-caddy','--restart=unless-stopped','--network','mbox-net','-p','127.0.0.1:443:443','--mount','type=bind,src=/opt/mbox/Caddyfile,dst=/etc/caddy/Caddyfile,readonly','--mount','type=bind,src=/opt/mbox/tls,dst=/certs,readonly','--mount','type=bind,src=/opt/mbox/caddy-data,dst=/data','caddy:2.10.2-alpine'])
for _ in range(60):
 try:
  ready=json.loads(run(['/usr/bin/curl','--noproxy','*','-fsS','https://localhost/api/ready']))
  if ready.get('status')=='ready':break
 except Exception:time.sleep(1)
else:raise RuntimeError('old source API did not become ready')
(root/'old-ready.json').write_text(json.dumps(ready))
activity=run(['psql','-XAt','--dbname=service=migration','-c',"SELECT json_agg(json_build_object('pid',pid,'login',usename,'application',application_name)) FROM pg_stat_activity WHERE datname='lab_business' AND usename='lab_old'"])
print(json.dumps({'sourceLive':{'containerId':container,'sha':sha,'platformImageDigest':platform},'ready':ready,'actualBackends':json.loads(activity),'tlsVerified':True}))
