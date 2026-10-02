import {randomUUID} from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {MemberCardRepository} from './member-card-repository.js'
import {nativeMemberCardsApiPlugin} from './native-member-cards-api.js'
import {memberCardApiPlugin} from './member-card-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('native member cards with restricted LOGIN',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},editor=randomUUID(),reviewer=randomUUID(),publisher=randomUUID(),role=randomUUID(),publishRole=randomUUID(),customer=randomUUID(),service=randomUUID(),wecom=randomUUID(),product=randomUUID(),publicProduct=randomUUID()
 let admin:Pool,runtime:Pool,app:FastifyInstance,transactions:ScopedPostgresTransactionRunner,projectId:string
 const root='/staff/native-member-cards',body={code:'MUSIC_CARD',name:'测试音乐卡',terms:'本测试卡需顾客自主申请，会员等级与营销授权独立。',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000*30).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null}
 const send=(action:string,payload:object,actor=editor,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:root+'/commands/'+action,headers:{'idempotency-key':key,'x-test-employee':actor},payload})
 const get=async(suffix='?section=projects',actor=editor)=>{const r=await app.inject({method:'GET',url:root+suffix,headers:{'x-test-employee':actor}});expect(r.statusCode,r.body).toBe(200);return r.json().data}
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);transactions=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Native cards')",[scope.tenantId]);await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Native cards')",[scope.storeId,scope.tenantId])
  for(const [id,code]of[[editor,'EDITOR'],[reviewer,'REVIEWER'],[publisher,'PUBLISHER']])await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,code])
  for(const [id,code]of[[role,'CARD'],[publishRole,'PUBLISH']])await admin.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,$4)',[id,scope.tenantId,scope.storeId,code])
  for(const [employee,assigned]of[[editor,role],[reviewer,role],[publisher,publishRole]])await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employee,assigned])
  for(const code of['member.card.manage','member.card.review','loyalty.policy.publish']){await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code]);await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[scope.tenantId,scope.storeId,role,code])}
  await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='loyalty.policy.publish'",[scope.tenantId,scope.storeId,publishRole])
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'native-card-member')",[customer,scope.tenantId,scope.storeId]);await admin.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,'MBX-NCARD001','gold')",[scope.tenantId,scope.storeId,customer])
  for(const[id,kind]of[[service,'service_account'],[wecom,'wecom']]){
   await admin.query("INSERT INTO mbox.social_accounts(id,tenant_id,store_id,kind,name,app_id,enabled,credential_hash,encrypted_credentials,key_id,created_by_employee_id) VALUES($1::uuid,$2,$3,$4,$4,$1::text,true,'fixture',decode('00','hex'),'fixture',$5)",[id,scope.tenantId,scope.storeId,kind,editor])
   await admin.query("INSERT INTO mbox.social_relationships(tenant_id,store_id,account_id,customer_id,external_hash,encrypted_external_id,key_id,active,provider_occurred_at) VALUES($1,$2,$3,$4,'fixture',decode('00','hex'),'fixture',true,clock_timestamp())",[scope.tenantId,scope.storeId,id,customer])
  }
  for(const[id,name,visible]of[[product,'专属新品',false],[publicProduct,'公共商品',true]])await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible) VALUES($1::uuid,$2,$3,$1::text,$4,'test','none',$5)",[id,scope.tenantId,scope.storeId,name,visible])
  const options={transactions,commands:new NormalizedCommandExecutor(transactions),resolveStaffContext:(req:any)=>({scope,employeeId:req.headers['x-test-employee']??editor,businessDate:'2026-10-01'})}
  app=Fastify();await app.register(nativeMemberCardsApiPlugin,options);await app.register(memberCardApiPlugin,{...options,prefix:'/legacy',resolveSelfContext:()=>({scope,customerId:customer,businessDate:'2026-10-01',tableSessionId:null,actorRef:'test'})});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('requires current draft and independent publisher, keeps permanent receipts, and does not expose account secrets',async()=>{
  const key=`native-business-${randomUUID()}`,created=await send('create',body,editor,key);expect(created.statusCode,created.body).toBe(200);projectId=created.json().data.result.projectId;expect((await send('create',body,editor,key)).json().meta.replayed).toBe(true)
  let row=(await get()).items.find((r:any)=>r.id===projectId);const config=await get('/projects/'+projectId+'/config');expect(JSON.stringify(config)).not.toMatch(/encrypted_|credential_hash|key_id/)
  const social={projectId,expectedUpdatedAt:row.updated_at,serviceAccountId:service,wecomAccountId:wecom,autoRestore:false,artistName:'音乐现场',iconUrl:null}
  expect((await send('social',social)).statusCode).toBe(200);expect((await send('social',social)).json().error.commitDisposition).toBe('not_committed')
  row=(await get()).items.find((r:any)=>r.id===projectId);const open={projectId,expectedUpdatedAt:row.updated_at,state:'open',reason:'独立核对申请条款'}
  expect((await send('state',open)).json().error.message).toContain('不能自行')
  expect((await get('?section=projects',publisher)).items).toHaveLength(1)
  expect((await send('state',open,publisher)).statusCode).toBe(200);expect((await send('state',{...open,state:'closed'},reviewer)).statusCode).toBe(409)
  const legacy=await app.inject({method:'GET',url:'/legacy/staff/member-cards/projects'});expect(legacy.json().data.items[0]).toMatchObject({id:projectId,status:'open'});expect(legacy.json().data).not.toHaveProperty('result')
  await admin.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE employee_id=$1",[editor]);expect((await send('create',body,editor,key)).statusCode).toBe(403);await admin.query('UPDATE mbox.employee_roles SET ends_at=NULL WHERE employee_id=$1',[editor])
 })
 it('reviews one real customer application once and rejects stale card changes after suspend/resume',async()=>{
  const application=await transactions.run(scope,tx=>new MemberCardRepository(tx).apply({projectId,customerId:customer,acceptedProjectVersion:1,businessDate:'2026-10-01'}))
  expect((await get('?section=applications')).items[0].id).toBe(application.applicationId)
  const payload={applicationId:application.applicationId,decision:'approve',reason:'核对会员与双条件门槛'},key=`native-business-${randomUUID()}`
  const replies=await Promise.all([send('review',payload,reviewer,key),send('review',payload,reviewer,key)]);for(const r of replies)expect(r.statusCode,r.body).toBe(200);expect(replies.map(r=>r.json().meta.replayed).sort()).toEqual([false,true])
  expect((await send('review',payload,reviewer)).json().error.commitDisposition).toBe('not_committed')
  let card=(await get('?section=holdings')).items[0];const old=card.updated_at;const suspend={cardId:card.id,expectedUpdatedAt:old,action:'suspend',reason:'核对卡资料'}
  expect((await send('holding',suspend)).statusCode).toBe(200);card=(await get('?section=holdings')).items[0];expect((await send('holding',{...suspend,expectedUpdatedAt:card.updated_at,action:'resume'})).statusCode).toBe(200)
  expect((await send('holding',suspend)).statusCode).toBe(409)
  expect((await admin.query('SELECT level FROM mbox.customer_memberships WHERE customer_id=$1',[customer])).rows[0].level).toBe('gold');expect((await admin.query('SELECT count(*)::int AS count FROM mbox.benefits WHERE customer_id=$1',[customer])).rows[0].count).toBe(0)
 })
 it('guards complete card menus, blocks exclusive public goods, and paginates projects',async()=>{
  let config=await get('/projects/'+projectId+'/config');const payload={projectId,expectedMenu:config.expectedMenu,productId:publicProduct,exclusive:true,active:true,sortOrder:0,exclusivePriceMinor:1234}
  expect((await send('menu',payload)).statusCode).toBe(409)
  const saved=await send('menu',{...payload,productId:product});expect(saved.statusCode,saved.body).toBe(200);expect((await send('menu',{...payload,productId:product,exclusivePriceMinor:999})).statusCode).toBe(409)
  config=await get('/projects/'+projectId+'/config');expect(config.menu[0].exclusive_price_minor).toBe('1234');expect((await get('/products?search='+encodeURIComponent('专属'))).items).toHaveLength(1)
  const removed=await send('menu-remove',{projectId,productId:product,expectedMenu:config.expectedMenu});expect(removed.statusCode,removed.body).toBe(200);expect((await get('/projects/'+projectId+'/config')).menu).toHaveLength(0)
  await admin.query("INSERT INTO mbox.member_card_projects(tenant_id,store_id,code,name,kind,terms,available_from,available_until,created_by_employee_id) SELECT $1,$2,'PAGE_'||n,'分页卡','interest','分页测试条款',clock_timestamp(),clock_timestamp()+interval '1 day',$3 FROM generate_series(1,51) n",[scope.tenantId,scope.storeId,editor])
  const first=await get(),second=await get('?section=projects&cursor='+first.nextCursor);expect(first.items).toHaveLength(50);expect(second.items).toHaveLength(2);expect(new Set([...first.items,...second.items].map((r:any)=>r.id)).size).toBe(52)
 })
})
