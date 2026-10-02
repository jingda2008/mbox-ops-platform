import {randomUUID} from 'node:crypto'
import sharp from 'sharp'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {bottleCustodyApiPlugin} from './bottle-custody-api.js'
import {BottleCustodyRepository} from './bottle-custody-repository.js'
import {defaultCustodyPolicy} from './bottle-custody-policy.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native custody durable guarded commands',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),role=randomUUID(),customer=randomUUID(),category=randomUUID()
 const protection=createActivityContactProtectionKeyring(null,'native-custody-local-test-not-production')
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,app:FastifyInstance,photo:string,order:Record<string,any>
 const root='/native/staff/bottle-custody'
 const send=(suffix:string,body:object,version?:number,key=`native-business-${randomUUID()}`,extra:Record<string,string>={})=>app.inject({method:'POST',url:root+suffix,headers:{'idempotency-key':key,...(version?{'x-custody-version':String(version)}:{}),...extra},payload:body})
 const get=async(path:string)=>{const response=await app.inject({method:'GET',url:root+path});expect(response.statusCode,response.body).toBe(200);return response.json().data}
 const input=()=>({memberNo:'100001',categoryId:category,itemName:'测试会员寄存酒',unit:'瓶',quantity:'2',evidence:{photoBase64:photo,phone:'+8613800012345',fraction:null}})
 beforeAll(async()=>{
  await runNormalizedMigrations(database!)
  admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!)
  runner=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Native custody')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$1::text,'Native custody')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'NC','存酒管理员')",[employee,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'NC','存酒管理员')",[role,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employee,role])
  await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('bottle.manage.all','member.card.manage','bottle.custody.export')",[scope.tenantId,scope.storeId,role])
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)",[customer,scope.tenantId,scope.storeId,customer])
  await admin.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'100001')",[scope.tenantId,scope.storeId,customer])
  await runner.run(scope,async tx=>{const repo=new BottleCustodyRepository(tx,protection);await repo.savePolicy({...defaultCustodyPolicy,enabled:true},0);await repo.saveCategory({id:category,code:'BRANDY',name:'白兰地',defaultDays:20,sortOrder:0,active:true})})
  photo=(await sharp({create:{width:320,height:240,channels:3,background:'#305040'}}).jpeg().toBuffer()).toString('base64')
  app=Fastify();const common={transactions:runner,commands:new NormalizedCommandExecutor(runner),protection,resolveStaffContext:()=>({scope,employeeId:employee,businessDate:'2026-09-30'})}
  await app.register(bottleCustodyApiPlugin,{...common,prefix:'/native',nativeReceipts:true});await app.register(bottleCustodyApiPlugin,common);await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('creates once with immutable replay and preserves legacy response shape',async()=>{
  expect((await get('/native-capabilities')).durableCommands).toBe(true)
  const key=`native-business-${randomUUID()}`,body=input(),result=await send('',body,undefined,key)
  expect(result.statusCode,result.body).toBe(200);order=result.json().data.result.order
  expect(result.json().data).toMatchObject({operation:'create',employeeId:employee,requestKey:key})
  expect((await send('',body,undefined,key)).json()).toMatchObject({data:result.json().data,meta:{replayed:true,protocol:1}})
  const rows=(await get('')).items;expect(rows).toHaveLength(1)
  const old=await app.inject({method:'GET',url:'/staff/bottle-custody/'+order.id});expect(old.json().data.order.id).toBe(order.id);expect(old.json().data).not.toHaveProperty('result')
  const evidence=(await get('/'+order.id)).deposits[0];expect(evidence.phone_masked).toBe('138****2345');expect(JSON.stringify(evidence)).not.toContain('photoBase64')
 })
 it('resolves only the original member consumption order by public number',async()=>{
  const area=randomUUID(),table=randomUUID(),session=randomUUID(),source=randomUUID(),other=randomUUID();
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'CUSTODY','存酒测试','bar')",[area,scope.tenantId,scope.storeId]);
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'C01','测试桌',4)",[table,scope.tenantId,scope.storeId,area]);
  await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,'2026-09-30',1)",[session,scope.tenantId,scope.storeId,table]);
  await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,created_by_customer_id) VALUES($1::uuid,$2,$3,$4,$1::text,'staff_assisted',$5),($6::uuid,$2,$3,$4,$6::text,'staff_assisted',NULL)",[source,scope.tenantId,scope.storeId,session,customer,other]);
  expect((await get('/source-order?memberNo=100001&publicId='+source)).id).toBe(source);
  expect((await app.inject({method:'GET',url:root+'/source-order?memberNo=100001&publicId='+other})).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:root+'/source-order?memberNo=999999&publicId='+source})).statusCode).toBe(404);
 });
 it('rejects stale expiry changes, keeps original reply and checks rights on replay',async()=>{
  const key=`native-business-${randomUUID()}`,body={expiresAt:new Date(Date.now()+40*86400000).toISOString(),reason:'延长原单有效期'}
  const result=await send('/'+order.id+'/expiry',body,order.version,key);expect(result.statusCode,result.body).toBe(200)
  expect((await send('/'+order.id+'/expiry',{...body,reason:'旧界面不能覆盖'},order.version)).json().error).toMatchObject({commitDisposition:'not_committed'})
  expect((await send('/'+order.id+'/expiry',body,order.version,key)).json().meta.replayed).toBe(true)
  await admin.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3",[scope.tenantId,scope.storeId,employee])
  expect((await send('/'+order.id+'/expiry',body,order.version,key)).statusCode).toBe(403)
  await admin.query('UPDATE mbox.employee_roles SET ends_at=NULL WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[scope.tenantId,scope.storeId,employee])
  order=(await get('/'+order.id)).order
 })
 it('counts a wrong OTP once, requires verification and consumes custody exactly once',async()=>{
  const issued=await send('/'+order.id+'/request-code',{quantity:'2'},order.version);expect(issued.statusCode,issued.body).toBe(200)
  const challengeId=issued.json().data.result.challengeId
  expect((await send('/'+order.id+'/collect',{challengeId},order.version)).json().error.commitDisposition).toBe('not_committed')
  const stored=(await admin.query("UPDATE mbox.bottle_custody_challenges SET delivery_status='accepted' WHERE id=$1 RETURNING encrypted_code,code_hash,key_id",[challengeId])).rows[0]
  const code=protection.reveal({encryptedContact:stored.encrypted_code,contactHash:stored.code_hash,encryptionKeyId:stored.key_id}).split(':')[1]!
  const wrong=code==='0000'?'9999':'0000',badKey=`native-business-${randomUUID()}`
  const bad=await send('/'+order.id+'/verify',{challengeId,code:wrong},order.version,badKey);expect(bad.json().data.result.verified).toBe(false)
  expect((await send('/'+order.id+'/verify',{challengeId,code:wrong},order.version,badKey)).json().meta.replayed).toBe(true)
  expect((await admin.query('SELECT attempts FROM mbox.bottle_custody_challenges WHERE id=$1',[challengeId])).rows[0].attempts).toBe(1)
  expect((await send('/'+order.id+'/verify',{challengeId,code},order.version)).json().data.result.verified).toBe(true)
  const key=`native-business-${randomUUID()}`,collected=await send('/'+order.id+'/collect',{challengeId},order.version,key)
  expect(collected.statusCode,collected.body).toBe(200);expect(collected.json().data.result.order.remaining_quantity).toMatch(/^0(?:\.0+)?$/)
  expect((await send('/'+order.id+'/collect',{challengeId},order.version,key)).json().meta.replayed).toBe(true)
  expect((await send('/'+order.id+'/collect',{challengeId},order.version)).statusCode).toBe(409)
  order=collected.json().data.result.order
 })
 it('restores with new photo, guards category edits, exports the selected report and prints a native snapshot',async()=>{
  const detail=await get('/'+order.id),collectionId=detail.collections[0].id
  const result=await send('/'+order.id+'/resolve-collection',{collectionId,quantity:'2',restorageMode:'original',reason:'余酒全部再次寄存',evidence:input().evidence},order.version)
  expect(result.statusCode,result.body).toBe(200);order=result.json().data.result.order;expect(order.status).toBe('stored')
  const config=await get('/policy'),categoryRow=config.categories[0]
  const categoryBody={id:category,code:'BRANDY',name:'调整白兰地',defaultDays:25,active:true,sortOrder:1}
  const updated=await send('/categories',categoryBody,undefined,undefined,{'x-custody-category':categoryRow.configurationFingerprint});expect(updated.statusCode,updated.body).toBe(200)
  expect((await send('/categories',{...categoryBody,name:'旧版本覆盖'},undefined,undefined,{'x-custody-category':categoryRow.configurationFingerprint})).statusCode).toBe(409)
  const exported=await send('/report-export',{scope:'custody',memberNo:'100001'});expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().data.operation).toBe('report_export');expect(exported.json().data.result.count).toBe(1)
  expect((await send('/report-export',{scope:'all'})).statusCode).toBe(409) // No order-history permission.
  const print=await send('/'+order.id+'/print',{},order.version);expect(print.statusCode,print.body).toBe(200);expect(print.json().data.result.document.order.id).toBe(order.id)
 })
})
