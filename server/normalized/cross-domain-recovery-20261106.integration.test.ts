import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { grantFixtureStaffPermissions, holdFixtureReceipts } from './staff-permission.test-helper.js'
import { reservationPerformanceApiPlugin } from './reservation-performance-api.js'
import { ReservationCommandService } from './reservation-command-service.js'
import { PerformanceCommandService } from './performance-command-service.js'
import { customerPreferenceApiPlugin } from './customer-preference-api.js'
import { CustomerPreferenceService } from './customer-preference-service.js'
import { AnnualDailySnackClaimService, type AnnualDailySnackClaim } from './annual-daily-snack-claim-service.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
const adminUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(adminUrl&&runtimeUrl?describe:describe.skip)('cross-domain lock, time and identity recovery',()=>{
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,commands:NormalizedCommandExecutor,app:ReturnType<typeof Fastify>
 let scope:{tenantId:string;storeId:string},employee:string,other:string,customer:string,businessDate:string
 const rights=['reservation.manage','reservation.view','reservation.view.all','reservation.cancel.override','reservation.contact.view']
 const context=()=>({scope,employeeId:employee,businessDate})
 const publicContext=()=>({scope,customerId:customer,actorRef:'reservation-session:local',businessDate})
 beforeAll(async()=>{
  await runNormalizedMigrations(adminUrl!);admin=new Pool({connectionString:adminUrl,max:8});runtime=new Pool({connectionString:runtimeUrl,max:8})
  await assertRuntimeDatabasePool(runtime,runtimeUrl!);runner=new ScopedPostgresTransactionRunner(runtime);commands=new NormalizedCommandExecutor(runner)
  app=Fastify();await app.register(reservationPerformanceApiPlugin,{transactions:runner,reservations:new ReservationCommandService(commands),performance:new PerformanceCommandService(commands),resolveStaffContext:context,resolveGuestContext:()=>{throw Error('unused guest entry')}})
  await app.register(customerPreferenceApiPlugin,{service:new CustomerPreferenceService(runner,commands),resolvePublicContext:publicContext})
 })
 beforeEach(async()=>{
  scope={tenantId:randomUUID(),storeId:randomUUID()};employee=randomUUID();other=randomUUID();customer=randomUUID()
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Local recovery matrix')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Local recovery matrix')",[scope.storeId,scope.tenantId])
  const publisher=randomUUID()
  for(const id of [employee,other,publisher])await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
  await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)',[customer,scope.tenantId,scope.storeId])
  await grantFixtureStaffPermissions(admin,scope,[employee,other],rights)
  await admin.query('INSERT INTO mbox.public_reservation_policies(tenant_id,store_id,hold_minutes,arrival_grace_minutes) VALUES($1,$2,20,10)',[scope.tenantId,scope.storeId])
  await admin.query(`INSERT INTO mbox.recommendation_policy_versions(id,tenant_id,store_id,public_id,policy_code,version,status,created_by_employee_id,approved_by_employee_id,published_by_employee_id,approved_at,published_at,effective_from,draft_reason,approval_reason,publication_reason,publication_mode,explanation_template) VALUES($1::uuid,$2,$3,$1::text,'DEFAULT',1,'published',$4,$5,$6,clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 minute','Local draft','Local independent approval','Local publication','separated','Local preference')`,[randomUUID(),scope.tenantId,scope.storeId,employee,other,publisher])
  businessDate=await runner.run(scope,async tx=>(await tx.query('SELECT mbox.current_operating_business_date($1,$2)::text d',[scope.tenantId,scope.storeId])).rows[0].d)
 })
 afterEach(()=>vi.restoreAllMocks())
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 async function revoke(code:string){await admin.query('DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p WHERE a.tenant_id=$1 AND a.permission_id=p.id AND p.code=$2',[scope.tenantId,code])}
 async function facts(){const result:Record<string,unknown>={};for(const table of ['reservations','reservation_table_locks','customer_preference_declarations','customer_preference_withdrawals','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') rows FROM mbox.${table} t WHERE tenant_id=$1`,[scope.tenantId])).rows[0].rows;return result}
 const cases=[false,true].flatMap(native=>['confirm','arrive','complete','cancel'].flatMap(action=>['permission','scope','contact'].map(kind=>({native,action,kind}))))
 it.each(cases)('reservation $native/$action rechecks $kind after an observed receipt lock wait',async({native,action,kind})=>{
  const id=randomUUID(),status=action==='complete'?'arrived':action==='confirm'?'pending':'confirmed'
  await admin.query("INSERT INTO mbox.reservations(id,tenant_id,store_id,public_id,customer_name,contact_token,guest_count,arrival_at,expected_end_at,status,source,owner_employee_id) VALUES($1::uuid,$2,$3,$1::text,'Local guest','local-contact',2,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '4 hours',$4,'employee',$5)",[id,scope.tenantId,scope.storeId,status,other])
  const request={method:'POST' as const,url:`/staff/${native?'native-reservations':'reservations'}/${id}/${action}`,headers:{'idempotency-key':`native-business-${randomUUID()}`},payload:{reason:'Local recovery check'}}
  const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200);if(kind==='contact')expect(first.json().data.contactToken).toBe('local-contact')
  const before=await facts(),held=await holdFixtureReceipts(admin,scope.tenantId)
  let response:Awaited<ReturnType<typeof app.inject>>|undefined
  const pending=app.inject(request).then(r=>{response=r})
  try{await held.waitUntilBlocked();await revoke(kind==='permission'?'reservation.manage':kind==='scope'?'reservation.view.all':'reservation.contact.view')}finally{await held.release()}
  await pending;expect(response!.statusCode,response!.body).toBe(kind==='permission'?403:kind==='scope'?404:200);if(kind==='contact')expect(response!.json().data.contactToken).toBeUndefined();expect(await facts()).toEqual(before)
  const independent=await app.inject(request);expect(independent.statusCode,independent.body).toBe(kind==='permission'?403:kind==='scope'?404:200)
  await grantFixtureStaffPermissions(admin,scope,[employee],rights)
  const restored=await app.inject(request);expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().meta.replayed).toBe(true);expect(restored.json().data.id).toBe(id);if(kind==='contact')expect(restored.json().data.contactToken).toBe('local-contact');expect(await facts()).toEqual(before)
 })
 it.each(['permission','contact'])('native reservation creation rechecks %s after the historical receipt lock',async kind=>{
  const area=randomUUID(),table=randomUUID()
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'CREATE','Local','indoor')",[area,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'CREATE','Local',8)",[table,scope.tenantId,scope.storeId,area])
  const req={method:'POST' as const,url:'/staff/native-reservations',headers:{'idempotency-key':`native-business-${randomUUID()}`},payload:{publicId:`NRES-${randomUUID()}`,customerName:'Local guest',contactToken:'local-contact',guestCount:2,arrivalAt:new Date(Date.now()+3600000).toISOString(),expectedEndAt:new Date(Date.now()+14400000).toISOString(),tableIds:[table],source:'employee',initialStatus:'pending'}}
  const first=await app.inject(req);expect(first.statusCode,first.body).toBe(201);if(kind==='contact')expect(first.json().data.contactToken).toBe('local-contact');const before=await facts(),held=await holdFixtureReceipts(admin,scope.tenantId)
  let response:Awaited<ReturnType<typeof app.inject>>|undefined
  const pending=app.inject(req).then(r=>{response=r})
  try{await held.waitUntilBlocked();await revoke(kind==='permission'?'reservation.manage':'reservation.contact.view')}finally{await held.release()}
  await pending;expect(response!.statusCode,response!.body).toBe(kind==='permission'?403:200)
  const withoutReceiptTimestamp=(snapshot:Record<string,unknown>)=>({...snapshot,idempotency_records:(snapshot.idempotency_records as Record<string,unknown>[]).map(({updated_at: _updatedAt,...record})=>record)})
  if(kind==='contact'){
    expect(response!.json().data.contactToken).toBeUndefined()
    expect(withoutReceiptTimestamp(await facts())).toEqual(withoutReceiptTimestamp(before))
  }else expect(await facts()).toEqual(before)
  await grantFixtureStaffPermissions(admin,scope,[employee],rights)
  const restored=await app.inject(req);expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().meta.replayed).toBe(true)
  if(kind==='contact')expect(restored.json().data.contactToken).toBe('local-contact')
  // Legitimate legacy-receipt promotion refreshes only its updated_at timestamp.
  expect(withoutReceiptTimestamp(await facts())).toEqual(withoutReceiptTimestamp(before))
 })
 it.each(['declare','withdraw'])('preference %s replay reports current preferences without repeating the old mutation',async action=>{
  const declare={method:'POST' as const,url:'/public/mini/preferences',headers:{'idempotency-key':randomUUID()},payload:{key:'beverage.family',value:'wine',polarity:'supports'}}
  const first=await app.inject(declare);expect(first.statusCode,first.body).toBe(201)
  const source=first.json().data.sources[0].publicId
  const withdraw={method:'POST' as const,url:`/public/mini/preferences/${source}/withdraw`,headers:{'idempotency-key':randomUUID()},payload:{reason:'Local withdrawal'}}
  expect((await app.inject(withdraw)).statusCode).toBe(200)
  if(action==='withdraw')expect((await app.inject({...declare,headers:{'idempotency-key':randomUUID()},payload:{...declare.payload,value:'beer'}})).statusCode).toBe(201)
  const before=await facts(),replay=await app.inject(action==='declare'?declare:withdraw),current=await app.inject('/public/mini/preferences')
  expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
  expect(replay.json().data).toEqual(current.json().data);expect(await facts()).toEqual(before)
 })
 it('preference replay survives its original validity deadline, while new expired declarations fail',async()=>{
  const now=Date.now(),validUntil=new Date(now+60_000).toISOString(),key=randomUUID()
  const req={method:'POST' as const,url:'/public/mini/preferences',headers:{'idempotency-key':key},payload:{key:'beverage.family',value:'wine',polarity:'supports',validUntil}}
  const first=await app.inject(req);expect(first.statusCode,first.body).toBe(201);const before=await facts()
  vi.spyOn(Date,'now').mockReturnValue(now+120_000)
  const replay=await app.inject(req);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(await facts()).toEqual(before)
  const fresh=await app.inject({...req,headers:{'idempotency-key':randomUUID()}});expect(fresh.statusCode,fresh.body).toBe(400);expect(await facts()).toEqual(before)
 })
 it.each(['payload','identity'])('preference key conflict is 409, not a server failure: %s',async mode=>{
  const req={method:'POST' as const,url:'/public/mini/preferences',headers:{'idempotency-key':randomUUID()},payload:{key:'beverage.family',value:'wine',polarity:'supports'}}
  expect((await app.inject(req)).statusCode).toBe(201);const before=await facts()
  if(mode==='identity'){customer=randomUUID();await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)',[customer,scope.tenantId,scope.storeId])}
  const result=await app.inject(mode==='payload'?{...req,payload:{...req.payload,value:'beer'}}:req)
  expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('CUSTOMER_PREFERENCE_CONFLICT');expect(await facts()).toEqual(before)
 })
 it.each(['revoked','foreign-device'])('snack cached receipt still requires current table authority: %s',async mode=>{
  const area=randomUUID(),table=randomUUID(),session=randomUUID()
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1::uuid,$2,$3,'LOCAL','Local','indoor')",[area,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1::uuid,$2,$3,$4,'LOCAL','Local',8)",[table,scope.tenantId,scope.storeId,area])
  await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)',[session,scope.tenantId,scope.storeId,table,businessDate])
  await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')",[scope.tenantId,scope.storeId,session,customer])
  const actorRef=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:customer})
  const ctx={...publicContext(),tableSessionId:session,actorRef},key=randomUUID()
  // Seed a historical receipt through the real executor, without issuing benefits or orders.
  // This tests cached-receipt authorization, not the unexecuted grant/inventory lifecycle.
  const fingerprint=createHash('sha256').update(JSON.stringify({businessDate,customerId:customer,tableSessionId:session})).digest('hex')
  const result:AnnualDailySnackClaim={id:randomUUID(),claimCode:'DSN-LOCAL-RECEIPT',benefitId:null,benefitReservationId:null,giftOrderId:null,attemptNo:1,quantity:1,status:'expired',expiresAt:null,redeemedByEmployeeId:null,redeemedByEmployeeName:null,redeemedAt:null,fulfilledAt:null,title:'Local receipt'}
  await commands.execute({scope,operationScope:'loyalty.annual-daily-snack.claim',idempotencyKey:key,requestFingerprint:fingerprint,resultCodec:{encode:v=>JSON.parse(JSON.stringify(v)),decode:v=>v as unknown as AnnualDailySnackClaim}},async()=>({result,auditEvents:[],outboxMessages:[]}))
  const service=new AnnualDailySnackClaimService(runner,commands)
  expect((await service.claim(ctx,{idempotencyKey:key})).replayed).toBe(true)
  if(mode==='revoked')await admin.query("UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='local authority withdrawal' WHERE id=$1",[actorRef.slice('guest-session:'.length)])
  else ctx.actorRef=`guest-session:${randomUUID()}`
  const before=await facts()
  await expect(service.claim(ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DAILY_SNACK_TABLE_AUTH_REQUIRED'})
  await expect(service.claim(ctx,{idempotencyKey:key})).rejects.toMatchObject({code:'DAILY_SNACK_TABLE_AUTH_REQUIRED'})
  expect(await facts()).toEqual(before)
 })
})
