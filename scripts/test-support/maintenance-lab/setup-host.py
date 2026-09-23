import pathlib,os,json,secrets,subprocess,time,uuid,base64,hashlib
P=pathlib.Path;root=P('/opt/mbox');secret=root/'secrets';secret.mkdir(parents=True,mode=0o700,exist_ok=True)
def run(args,input=None):
 r=subprocess.run([str(x) for x in args],input=input,text=True,capture_output=True)
 if r.returncode:raise RuntimeError('lab command failed '+str(args[0])+': '+r.stderr[-500:])
 return r.stdout.strip()
def private(path,text):path=P(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);os.chmod(path,0o600)
admin=dict(l.split('=',1) for l in P('/root/lab-pg.env').read_text().splitlines())['POSTGRES_PASSWORD']
run(['docker','network','create','mbox-net'])
gateway=json.loads(run(['docker','network','inspect','mbox-net']))[0]['IPAM']['Config'][0]['Gateway']
os.environ['PGPASSWORD']=admin
for _ in range(60):
 try:run(['psql','-h','127.0.0.1','-U','lab_admin','-d','postgres','-Atc','SELECT 1']);break
 except Exception:time.sleep(1)
pw={x:secrets.token_hex(32) for x in ('old','runtime','backup')}
query="CREATE ROLE lab_old LOGIN CREATEDB CREATEROLE BYPASSRLS REPLICATION PASSWORD '%s';CREATE ROLE lab_runtime LOGIN PASSWORD '%s';CREATE ROLE lab_backup LOGIN BYPASSRLS PASSWORD '%s';GRANT pg_monitor,pg_read_all_data TO lab_backup;CREATE DATABASE lab_business OWNER lab_old;"%(pw['old'],pw['runtime'],pw['backup'])
run(['psql','-h','127.0.0.1','-U','lab_admin','-d','postgres','-v','ON_ERROR_STOP=1'],query)
service='';passfile=''
for name,db,user,password in [('application','lab_business','lab_runtime',pw['runtime']),('migration','lab_business','lab_admin',admin),('cluster','postgres','lab_admin',admin),('backup','lab_business','lab_backup',pw['backup'])]:
 service+='[%s]\nhost=%s\nport=5432\nsslmode=disable\ndbname=%s\nuser=%s\n'%(name,gateway,db,user);passfile+='%s:5432:%s:%s:%s\n'%(gateway,db,user,password)
private(secret/'pg_service.conf',service);private(secret/'pgpass',passfile)
private(secret/'database-maintenance.env','APPLICATION_DATABASE_SERVICE=application\nBACKUP_DATABASE_SERVICE=backup\nADMIN_DATABASE_SERVICE=migration\nPGSERVICEFILE=/opt/mbox/secrets/pg_service.conf\nPGPASSFILE=/opt/mbox/secrets/pgpass\n')
oldsha='c8d989f21757f2da8211a9852eac87f127bfcd5f';oldrelease=root/'releases'/oldsha[:7];oldrelease.mkdir(parents=True,exist_ok=True)
adapter=oldrelease/'worker-adapters';adapter.mkdir()
adapter.joinpath('local.mjs').write_text("export function createNormalizedWorkerAdapters(){const deny=async()=>{throw new Error('LAB external delivery forbidden')};return {capabilities:['outbox.deliver','notification.deliver','print.deliver','sop.execute','payment.create.postar','refund.execute.postar'],preflight:async()=>{},outbox:async()=>{},notification:deny,print:{print:deny},sop:{execute:deny}}}\n")
for p in adapter.iterdir():os.chmod(p,0o644)
tenant=str(uuid.uuid4());store=str(uuid.uuid4())
# Synthetic IDs/config only. Reuse the production config structure, never its users/data.
config={'version':'lab-full-entry-1','tenant':{'id':tenant,'code':'isolated-lab','name':'Isolated release lab'},'store':{'id':store,'code':'isolated-lab','name':'Isolated release lab','timezone':'Asia/Shanghai','businessDayCutoff':'06:00','currency':'CNY'},'dailyCredentialEnv':'MBOX_STORE_DAILY_CREDENTIAL','bootstrapAdminEmployeeCode':'lab-operator','automaticTableTurnover':{'enabled':True,'operatingStartsAt':'12:00'},'reservationPolicy':{'holdMinutes':20,'arrivalGraceMinutes':10,'maxAdvanceDays':90,'defaultDurationMinutes':240,'customerCancelCutoffMinutes':120,'depositMode':'disabled'},'areas':[{'code':'main','name':'Lab area','type':'indoor'}],'tables':[{'code':'LAB1','name':'Lab table','areaCode':'main','capacity':4,'minimumSpendMinor':0}],'roles':[{'code':'ADMIN','name':'Lab operator','permissions':['system.admin']}],'employees':[{'code':'lab-operator','name':'Lab operator','roleCodes':['ADMIN'],'pinEnv':'MBOX_EMPLOYEE_PIN_LAB'}]}
catalog={'version':'lab-full-entry-1','source':'SYNTHETIC LOCAL RELEASE LAB','products':[{'sku':'lab-zero','name':'Lab item','categoryId':'drink','stationId':'bar-main','productKind':'single','enabled':True,'soldOut':False,'guestVisible':True,'listPriceAmount':0,'costAmount':0,'bundleComponents':[],'snapshot':{'inventoryTrackingEnabled':False}}]}
(oldrelease/'store.json').write_text(json.dumps(config));(oldrelease/'catalog.json').write_text(json.dumps(catalog))
run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',secret/'synthetic-provider.pem'])
pub=base64.b64encode(subprocess.check_output(['openssl','pkey','-in',str(secret/'synthetic-provider.pem'),'-pubout','-outform','DER'])).decode()
b64=lambda:base64.b64encode(secrets.token_bytes(32)).decode()
env={'NODE_ENV':'production','PORT':'8787','HOST':'0.0.0.0','MBOX_STATIC_DIR':'/app/dist','MBOX_DEPLOYMENT_TIER':'production','MBOX_TENANT_ID':tenant,'MBOX_STORE_ID':store,'MBOX_NORMALIZED_SECRET':secrets.token_hex(32),'MBOX_METRICS_TOKEN':secrets.token_hex(32),'MBOX_RUNTIME_CONFIG_VERSION':'normalized-runtime-config/v1','MBOX_PAYMENT_MODE':'production','MBOX_AI_MODE':'disabled','MBOX_PRINT_MODE':'disabled','MBOX_HEADSET_MODE':'disabled','MBOX_TRUST_PROXY_HOPS':'1','MBOX_CONTACT_ACTIVE_KEY_ID':'lab-current','MBOX_CONTACT_ACTIVE_KEY_BASE64':b64(),'MBOX_CONTACT_LOOKUP_KEY_BASE64':b64(),'MBOX_CONTACT_LEGACY_PHONE_LOOKUP_KEY_BASE64':b64(),'MBOX_CONTACT_PREVIOUS_KEYS':'lab-previous='+b64(),'MBOX_PAYMENT_PROVIDER':'postar','POSTAR_AGENCY_ID':'LOCAL-LAB-ONLY','POSTAR_MERCHANT_ID':'LOCAL-LAB-ONLY','POSTAR_PUBLIC_KEY':pub,'POSTAR_CALLBACK_URL':'https://payments.localhost/api/payments/providers/postar/callback','MBOX_GUEST_PAYMENT_MODE':'wechat_jsapi','MBOX_WECHAT_ENABLED':'true','MBOX_WECHAT_APP_ID':'wxLocalLabOnly01','MBOX_WECHAT_APP_SECRET':secrets.token_hex(32),'MBOX_WECHAT_STATE_SECRET':secrets.token_hex(32),'MBOX_WECHAT_ENCRYPTION_KEY_VERSION':'1','MBOX_WECHAT_ENCRYPTION_KEY_BASE64':b64(),'POSTAR_WECHAT_APP_ID':'wxLocalLabOnly01','POSTAR_WECHAT_TRADE_TYPE':'8','MBOX_START_WORKERS':'true','MBOX_WORKER_ID':'isolated-full-entry','MBOX_WORKER_INTERVAL_MS':'400','MBOX_WORKER_ADAPTER_MODULE':'/app/worker-adapters/local.mjs','MBOX_DATABASE_POOL_MAX':'3','MBOX_WORKER_DATABASE_POOL_MAX':'3','MBOX_INVENTORY_ENFORCEMENT_MODE':'strict','MBOX_STORE_DAILY_CREDENTIAL':secrets.token_hex(16),'MBOX_EMPLOYEE_PIN_LAB':'4826','MBOX_PUBLIC_URL':'https://localhost'}
for kind,user in [('old','lab_old'),('runtime','lab_runtime')]:
 values={**env,'DATABASE_URL':'postgresql://'+user+':'+pw[kind]+'@'+gateway+':5432/lab_business'}
 if kind=='old':values.update({'APP_COMMIT_SHA':oldsha,'MBOX_RELEASE_SHA':oldsha})
 else:values.update({'MBOX_QUANTITY_AFTER_SALES_ENABLED':'true','MBOX_KITCHEN_BATCH_BOARD_ENABLED':'true','MBOX_THREE_SCREEN_WORKFLOW_ENABLED':'true'})
 private(secret/('old.env' if kind=='old' else 'maintenance-runtime.env'),''.join(k+'='+v+'\n' for k,v in values.items()))
(root/'lab-state.json').write_text(json.dumps({'gateway':gateway,'scope':{'tenantId':tenant,'storeId':store},'oldRelease':str(oldrelease),'oldImage':'audit-maintenance-source-live:c8d989f'}))
# Real SSH to this isolated namespace, no external target and no password auth.
P('/root/.ssh').mkdir(mode=0o700,exist_ok=True);run(['ssh-keygen','-q','-t','ed25519','-N','','-f','/root/.ssh/lab_release'])
private('/root/.ssh/authorized_keys',P('/root/.ssh/lab_release.pub').read_text())
# Trust local CA only inside this disposable host/browser profile.
ca=P('/usr/local/share/ca-certificates/mbox-lab-ca.crt');key=secret/'lab-ca.key';tls=root/'tls';tls.mkdir()
run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','2','-subj','/CN=MBOX ISOLATED LAB CA'])
run(['openssl','req','-new','-newkey','rsa:2048','-nodes','-keyout',tls/'key.pem','-out',tls/'server.csr','-subj','/CN=localhost'])
(tls/'ext.cnf').write_text('subjectAltName=DNS:localhost,DNS:payments.localhost\nextendedKeyUsage=serverAuth\n')
run(['openssl','x509','-req','-in',tls/'server.csr','-CA',ca,'-CAkey',key,'-CAcreateserial','-out',tls/'cert.pem','-days','2','-extfile',tls/'ext.cnf']);run(['update-ca-certificates'])
P('/root/.pki/nssdb').mkdir(parents=True,exist_ok=True);run(['certutil','-N','--empty-password','-d','sql:/root/.pki/nssdb']);run(['certutil','-A','-n','MBOX-LAB-CA','-t','C,,','-i',ca,'-d','sql:/root/.pki/nssdb'])
with P('/etc/hosts').open('a') as out:out.write('\n127.0.0.1 payments.localhost\n')
# Harmless process is a real persistent restart source to fence.
P('/etc/systemd/system/cron.service').write_text('[Service]\nExecStart=/bin/sleep infinity\nRestart=always\n[Install]\nWantedBy=multi-user.target\n');run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','cron.service'])
print(json.dumps({'localOnly':True,'prepared':True,'database':'lab_business','scope':{'tenantId':tenant,'storeId':store},'sourceLiveSha':oldsha,'tls':'local CA trusted only in disposable lab'}))
