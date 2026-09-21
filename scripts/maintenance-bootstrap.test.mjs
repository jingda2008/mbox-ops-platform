import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createHmac} from 'node:crypto'
import {execFileSync, spawn, spawnSync} from 'node:child_process'
import test from 'node:test'
import {createMaintenanceIngress, durableFile, isNonFinancialRejection} from '../deploy/aliyun/maintenance-ingress.mjs'
const token='a'.repeat(64)
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))
const close=server=>new Promise(resolve=>server.close(resolve))
const directory=async()=>{const p=await mkdtemp(join(tmpdir(),'mbox-maintenance-'));await writeFile(join(p,'control-token'),token,{mode:0o600});return p}
const post=(port,body='{"order":"original-id"}',headers={})=>fetch(`http://127.0.0.1:${port}/api/payments/providers/postar/callback`,{method:'POST',headers:{'content-type':'application/json','x-original-signature':'untouched',...headers},body})
const control=(port,path,method='GET',headers={})=>fetch(`http://127.0.0.1:${port}/__maintenance/${path}`,{method,headers:{'x-mbox-maintenance-token':token,...headers}})

test('callback is durable before 503, survives a process restart, and retains the original signed bytes',async()=>{
 const dir=await directory();let ingress=createMaintenanceIngress(dir);let port=await listen(ingress.server)
 try {
  const bytes='{"order":  "same-key", "amount":100}\n'
  assert.equal((await post(port,bytes)).status,503)
  assert.equal(ingress.state().pending,1);assert.equal(ingress.state().epoch,true)
  await close(ingress.server);ingress=createMaintenanceIngress(dir);port=await listen(ingress.server)
  const file=(await readdir(join(dir,'callbacks')))[0],event=JSON.parse(await readFile(join(dir,'callbacks',file),'utf8'))
  assert.equal(Buffer.from(event.body,'base64').toString(),bytes);assert.equal(event.headers['x-original-signature'],'untouched')
  assert.equal(ingress.state().pending,1)
  assert.equal((await post(port,bytes)).status,503);assert.equal(ingress.state().pending,1)
 } finally {await close(ingress.server);await rm(dir,{recursive:true,force:true})}
})

test('maintenance rejects all business methods including GET without forwarding and protects control requests',async()=>{
 const dir=await directory(),ingress=createMaintenanceIngress(dir),port=await listen(ingress.server)
 try {
  for (const method of ['GET','POST','PUT','DELETE']) assert.equal((await fetch(`http://127.0.0.1:${port}/api/guest/shared-cart`,{method})).status,503)
  assert.equal((await fetch(`http://127.0.0.1:${port}/__maintenance/state`)).status,404)
  const response=await control(port,'target','POST',{'x-mbox-maintenance-target':'http://127.0.0.1:8787'});assert.equal(response.status,409)
  assert.equal(ingress.state().epoch,false)
 } finally {await close(ingress.server);await rm(dir,{recursive:true,force:true})}
})

test('replay never ACKs a provider timeout/500; only the real API success ACK completes the retained event',async()=>{
 // Use 8787 because production control accepts only the app's fixed port.
 const dir=await directory();let accepted=false,requests=0
 const api=createServer(async(req,res)=>{requests++;let body='';for await(const chunk of req)body+=chunk;assert.equal(body,'original-body');assert.equal(req.headers['x-original-signature'],'untouched');res.writeHead(accepted?200:500,{'content-type':'application/json'});res.end(JSON.stringify(accepted?{rspCod:'000000',rspMsg:'success'}:{error:'temporary'}))})
 await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(8787,'127.0.0.1',resolve)})
 const ingress=createMaintenanceIngress(dir),port=await listen(ingress.server)
 try {
  assert.equal((await post(port,'original-body')).status,503)
  assert.equal((await control(port,'target','POST',{'x-mbox-maintenance-target':'http://127.0.0.1:8787'})).status,200)
  assert.equal((await control(port,'replay','POST')).status,200);assert.equal(ingress.state().pending,1)
  accepted=true;await control(port,'replay','POST');assert.equal(ingress.state().acknowledged,1)
  assert.equal((await post(port,'original-body')).status,200);assert.equal(requests,2,'acknowledged duplicate must not send another provider/business action')
 } finally {await close(ingress.server);await close(api);await rm(dir,{recursive:true,force:true})}
})

test('epoch cannot be replaced by a later restart or callback',async()=>{
 const dir=await directory(),path=join(dir,'business-write-epoch.json')
 try {durableFile(path,{reason:'worker-before-start'},true);durableFile(path,{reason:'overwrite'},true);assert.equal(JSON.parse(await readFile(path,'utf8')).reason,'worker-before-start')}
 finally {await rm(dir,{recursive:true,force:true})}
})

test('persistent journal, binding, fault stages and forward-only recovery tests execute in a separate Python process',()=>{
 const result=execFileSync('python3',['deploy/aliyun/maintenance-bootstrap.test.py'],{encoding:'utf8',maxBuffer:1024*1024})
 assert.match(result,/maintenance fault assertions passed/)
})

test('only explicit bad signatures are retained as rejected; valid-but-unknown 404 remains pending',async()=>{
 const dir=await directory();let mode='signature'
 const api=createServer((_req,res)=>{res.writeHead(mode==='signature'?401:404,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:mode==='signature'?'PROVIDER_SIGNATURE_INVALID':'PAYMENT_NOT_FOUND'}}))})
 await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(8787,'127.0.0.1',resolve)})
 const ingress=createMaintenanceIngress(dir),port=await listen(ingress.server)
 try{
  await post(port,'bad-signature');await control(port,'target','POST',{'x-mbox-maintenance-target':'http://127.0.0.1:8787'});await control(port,'replay','POST')
  assert.equal(ingress.state().rejected,1);assert.equal(ingress.state().pending,0)
  mode='unknown';assert.equal((await post(port,'valid-but-unknown')).status,404)
  assert.equal(ingress.state().pending,1);assert.equal(ingress.state().rejected,1)
  assert.equal(readdirSyncCompat(await readdir(join(dir,'callbacks'))),2)
 }finally{await close(ingress.server);await close(api);await rm(dir,{recursive:true,force:true})}
})
function readdirSyncCompat(files){return files.filter(x=>x.endsWith('.json')).length}


test('public challenge proves the specific ingress without transmitting its control token',async()=>{
 const dir=await directory(),ingress=createMaintenanceIngress(dir),port=await listen(ingress.server)
 try{
  const challenge='b'.repeat(64)
  const response=await fetch(`http://127.0.0.1:${port}/api/payments/providers/postar/callback?mboxMaintenanceChallenge=${challenge}`)
  assert.equal(response.status,503)
  assert.deepEqual(await response.json(),{status:'maintenance',reason:'planned_maintenance_upgrade',proof:createHmac('sha256',token).update(challenge).digest('hex')})
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/payments/providers/postar/callback?mboxMaintenanceChallenge=short`)).status,503)
  assert.equal((await fetch(`http://127.0.0.1:${port}/__maintenance/state`)).status,404)
  assert.equal(ingress.state().epoch,false)
 }finally{await close(ingress.server);await rm(dir,{recursive:true,force:true})}
})


test('exclusive publication never exposes a partial final callback after abrupt writer exit',async()=>{
 const dir=await directory(),ingress=createMaintenanceIngress(dir)
 const path=join(dir,'callbacks',`${'c'.repeat(64)}.json`)
 try{
  const moduleUrl=new URL('../deploy/aliyun/maintenance-ingress.mjs',import.meta.url).href
  const program=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeFileSync;fs.writeFileSync=(fd)=>{original(fd,'{');process.exit(97)};syncBuiltinESMExports();const {durableFile}=await import(${JSON.stringify(moduleUrl)});durableFile(${JSON.stringify(path)},{status:'pending'},true)`
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8'})
  assert.equal(child.status,97)
  assert.equal((await readdir(join(dir,'callbacks'))).filter(x=>x.endsWith('.json')).length,0)
  assert.equal(ingress.state().pending,0,'unpublished interrupted bytes are never parsed as a receipt')
  durableFile(path,{status:'pending',body:'original'},true)
  assert.equal(ingress.state().pending,1)
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{status:'pending',body:'original'})
 }finally{await rm(dir,{recursive:true,force:true})}
})


test('only exact pre-handler parser rejections leave the financial pending queue',()=>{
 for(const [status,code] of [[400,'REQUEST_JSON_INVALID'],[400,'FST_ERR_CTP_INVALID_JSON_BODY'],[400,'FST_ERR_CTP_EMPTY_JSON_BODY'],[413,'FST_ERR_CTP_BODY_TOO_LARGE'],[415,'FST_ERR_CTP_INVALID_MEDIA_TYPE'],[401,'PROVIDER_SIGNATURE_INVALID']]){
  for(const body of [{code},{error:{code}}])assert.equal(isNonFinancialRejection({status,body:JSON.stringify(body)}),true)
  assert.equal(isNonFinancialRejection({status:500,body:JSON.stringify({code})}),false)
 }
 for(const [status,code] of [[404,'PAYMENT_NOT_FOUND'],[409,'PAYMENT_CALLBACK_MISMATCH'],[403,'PROVIDER_MERCHANT_UNBOUND'],[400,'UNKNOWN_BAD_REQUEST']])assert.equal(isNonFinancialRejection({status,body:JSON.stringify({error:{code}})}),false)
 assert.equal(isNonFinancialRejection({status:400,body:'not JSON'}),false)
})


test('managed-provider owner proof fails closed inside Bash command substitution',async()=>{
 const source=await readFile(new URL('../deploy/aliyun/restore-postgres.sh',import.meta.url),'utf8')
 const fn=source.slice(source.indexOf('verify_restore_owner_authority() {'),source.indexOf('write_database_evidence() {'))
 assert.match(fn,/BEGIN;[\s\S]*pg_rds_superuser[\s\S]*CREATE SCHEMA[\s\S]*ALTER TABLE[\s\S]*ROLLBACK;/)
 for(const [membership,probeExit,expected] of [['t',90,0],['f',0,0],['f',1,1],['error',0,1]]){
  const program=`set -eu\n${fn}\npsql() { local sql; sql=$(cat); if [[ "$sql" == *"SELECT pg_has_role(current_user"* ]]; then if [ "$MEMBERSHIP" = error ]; then return 2; fi; printf '%s\n' "$MEMBERSHIP"; else [[ "$sql" == *"ROLLBACK;"* ]] || return 3; return "$PROBE_EXIT"; fi; }\nproof=$(verify_restore_owner_authority isolated-reference original-owner)\nprintf '%s\n' "$proof"`
  const result=spawnSync('bash',['-c',program],{encoding:'utf8',env:{...process.env,MEMBERSHIP:membership,PROBE_EXIT:String(probeExit)}})
  assert.equal(result.status,expected,`${membership}/${probeExit}: ${result.stderr}`)
  if(expected===0)assert.equal(result.stdout.trim(),membership==='t'?'membership':'provider_transaction_probe')
  else assert.equal(result.stdout,'')
 }
})


test('restore prepares exact original extension owners and refuses unavailable SET ROLE or metadata mismatch', async()=>{
 const source=await readFile(new URL('../deploy/aliyun/restore-postgres.sh',import.meta.url),'utf8')
 const fn=source.slice(source.indexOf('prepare_restore_extensions() {'),source.indexOf('write_database_evidence() {'))
 const dir=await mkdtemp(join(tmpdir(),'mbox-extension-owner-'))
 try{
  const evidence=join(dir,'evidence.json');await writeFile(evidence,JSON.stringify({extensions:[{name:'pgcrypto',schema:'public',version:'1.3',owner:'original_owner'}]}))
  for(const [state,roleExit,expected] of [['exact',99,0],['absent',0,0],['absent',1,1],['mismatch',0,1],['schema-missing',0,1],['query-error',0,1]]){
   const program=`set -eu\n${fn}\npsql() { local sql; sql=$(cat); if [[ "$sql" == *"SELECT CASE WHEN NOT EXISTS"* ]]; then [ "$STATE" != query-error ] || return 2; printf '%s\n' "$STATE"; else [[ "$sql" == *"SET ROLE"* && "$sql" == *"CREATE EXTENSION"* && "$sql" == *"VERSION"* ]] || return 3; return "$ROLE_EXIT"; fi; }\nprepare_restore_extensions isolated-reference "$EVIDENCE"`
   const result=spawnSync('bash',['-c',program],{encoding:'utf8',env:{...process.env,STATE:state,ROLE_EXIT:String(roleExit),EVIDENCE:evidence}})
   assert.equal(result.status,expected,`${state}/${roleExit}: ${result.stderr}`)
  }
  const schemaRestore=source.indexOf('--use-list="${restore_archive_directory}/schemas.list"')
  const extensionPrepare=source.indexOf('prepare_restore_extensions "${staging_connection}"')
  const remainingRestore=source.indexOf('--use-list="${restore_archive_directory}/remaining.list"')
  assert.ok(schemaRestore>=0 && schemaRestore<extensionPrepare && extensionPrepare<remainingRestore)
  assert.match(source,/RESTORE_EVIDENCE_MISMATCH staging_vs_source/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
