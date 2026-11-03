import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import {commercialOpsApiPlugin} from './commercial-ops-api.js'
import {ProfitQueryService} from './profit-query-service.js'
import {loyaltyOperationalControlApiPlugin} from './loyalty-operational-control-api.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import type {CashHandoverCommand} from './cash-handover-service.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database&&runtimeUrl?describe:describe.skip)('cash and loyalty receipts with restricted LOGIN',()=>{
 let admin:Pool,runtime:Pool,transactions:ScopedPostgresTransactionRunner,app:ReturnType<typeof Fastify>
 let scope:{tenantId:string;storeId:string},actor:string,other:string,role:string,beforeExecute:(()=>Promise<void>)|undefined
 const cashPermissions=['reconciliation.view','payment.manual.cash.record','reconciliation.manage']
 const permissions=[...cashPermissions,'loyalty.operations.control','loyalty.operations.view']
 const grant=async(codes=permissions)=>{
  await admin.query('DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND role_id=$2',[scope.tenantId,role])
  await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=ANY($4::text[])',[scope.tenantId,scope.storeId,role,codes])
 }
 const snapshot=async()=>{
  const result:Record<string,unknown>={}
  for(const table of ['cash_handovers','cash_handover_events','reconciliation_entries','loyalty_operational_control_states','loyalty_operational_control_events','loyalty_accounts','loyalty_point_ledger','loyalty_growth_ledger','audit_events','outbox_messages','idempotency_records'])result[table]=(await admin.query(`SELECT to_jsonb(t) row FROM mbox.${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,[scope.tenantId])).rows
  return result
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!);transactions=new ScopedPostgresTransactionRunner(runtime)
  const executor=new NormalizedCommandExecutor(transactions)
  const commands={execute:((...args:Parameters<NormalizedCommandExecutor['execute']>)=>{const hook=beforeExecute;beforeExecute=undefined;return (async()=>{await hook?.();return executor.execute(...args)})()}) as NormalizedCommandExecutor['execute']}
  const resolveContext=(request:{headers:Record<string,unknown>})=>({scope,employeeId:String(request.headers['x-test-employee']??actor),businessDate:'2026-11-03'})
  app=Fastify()
  await app.register(commercialOpsApiPlugin,{transactions,commandExecutor:commands,queryService:new ProfitQueryService(transactions),resolveContext})
  await app.register(loyaltyOperationalControlApiPlugin,{transactions,service:new LoyaltyOperationalControlService(transactions,commands),resolveStaffContext:resolveContext})
  await app.ready()
 })
 beforeEach(async()=>{
  beforeExecute=undefined;scope={tenantId:randomUUID(),storeId:randomUUID()};actor=randomUUID();other=randomUUID();role=randomUUID()
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Receipt audit')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Receipt audit')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'AUDITOR','Audit')",[role,scope.tenantId,scope.storeId])
  for(const id of [actor,other]){
   await admin.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,$1::text)',[id,scope.tenantId,scope.storeId])
   await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id,role])
  }
  for(const code of permissions)await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[scope.tenantId,scope.storeId,code])
  await grant()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 const cash=(body:CashHandoverCommand,key=randomUUID(),employee=actor)=>app.inject({method:'POST',url:'/commercial-ops/cash-handovers/commands',headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const fixture=async(action:CashHandoverCommand['action'])=>{
  if(action==='open')return {body:{action,amountMinor:10000,reason:'隔离测试实点备用金'} as CashHandoverCommand,employee:actor}
  const opened=await cash({action:'open',amountMinor:10000,reason:'隔离测试实点备用金'});expect(opened.statusCode,opened.body).toBe(200)
  const id=opened.json().data.id as string
  if(action==='movement')return {body:{action,id,expectedRevision:1,amountMinor:1000,direction:'out',reference:'ISOLATED-001',reason:'隔离测试实际取款'} as CashHandoverCommand,employee:actor}
  const count:CashHandoverCommand={action:'count',id,expectedRevision:1,denominations:{'10000':1},reason:'隔离测试独立实点'}
  if(action==='count')return {body:count,employee:actor}
  expect((await cash(count)).statusCode).toBe(200)
  return {body:{action,id,expectedRevision:2,reason:'隔离测试复核盘点',...(action==='approve'?{reviewCountedMinor:10000}:{})} as CashHandoverCommand,employee:action==='approve'?other:actor}
 }
 for(const action of ['open','movement','count','withdraw','approve'] as const){
  for(const mode of ['fresh','receipt'] as const)it.each(['view','write'])(`${action} ${mode} rejects %s revocation after preflight`,async revoked=>{
   const f=await fixture(action),key=randomUUID(),first=mode==='receipt'?await cash(f.body,key,f.employee):undefined
   if(first)expect(first.statusCode,first.body).toBe(200)
   const before=await snapshot()
   // Preserve the lower cash-record permission when revoking management for privileged actions.
   const narrowed=revoked==='view'?permissions.filter(p=>p!=='reconciliation.view'):permissions.filter(p=>p!=='reconciliation.manage'&&(['movement','approve'].includes(action)||p!=='payment.manual.cash.record'))
   beforeExecute=()=>grant(narrowed)
   const denied=await cash(f.body,key,f.employee);expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error.message).toContain('权限')
   expect(await snapshot()).toEqual(before)
   await grant();const recovered=await cash(f.body,key,f.employee);expect(recovered.statusCode,recovered.body).toBe(200)
   expect(recovered.json().replayed).toBe(mode==='receipt')
   if(first){expect(recovered.json()).toEqual({...first.json(),replayed:true});expect(await snapshot()).toEqual(before)}
  })
  it(`${action} recovers the durable event after receipt expiry without executing twice`,async()=>{
   const f=await fixture(action),key=randomUUID(),first=await cash(f.body,key,f.employee);expect(first.statusCode,first.body).toBe(200)
   await admin.query("UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND idempotency_key=$2",[scope.tenantId,key])
   const before=await snapshot();beforeExecute=()=>grant([])
   expect((await cash(f.body,key,f.employee)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
   await grant();const replay=await cash(f.body,key,f.employee);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data)
   const after=await snapshot();delete before.idempotency_records;delete after.idempotency_records;expect(after).toEqual(before)
  })
 }
 it('cash preserves actor/body conflict and denies suspended staff on an old receipt',async()=>{
  const f=await fixture('open'),key=randomUUID();expect((await cash(f.body,key)).statusCode).toBe(200);const before=await snapshot()
  expect((await cash(f.body,key,other)).statusCode).toBe(409)
  expect((await cash({...f.body,amountMinor:20000},key)).statusCode).toBe(409)
  beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor])}
  expect((await cash(f.body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 for(const action of ['open','count','withdraw'] as const)it.each(['payment.manual.cash.record','reconciliation.manage'])(`${action} accepts either current counting authority: %s`,async permission=>{
  const f=await fixture(action),key=randomUUID();await grant(['reconciliation.view',permission])
  const first=await cash(f.body,key);expect(first.statusCode,first.body).toBe(200);const before=await snapshot()
  expect((await cash(f.body,key)).json()).toEqual({...first.json(),replayed:true});expect(await snapshot()).toEqual(before)
 })
 it('cash rejects both new and old requests when permission was already revoked',async()=>{
  const f=await fixture('open'),key=randomUUID();expect((await cash(f.body,key)).statusCode).toBe(200)
  await grant([]);const before=await snapshot()
  expect((await cash(f.body,key)).statusCode).toBe(409);expect((await cash(f.body)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
 const loyalty=(capability:string,body:object,key=randomUUID(),employee=actor)=>app.inject({method:'PUT',url:`/staff/loyalty/operational-controls/${capability}`,headers:{'idempotency-key':key,'x-test-employee':employee},payload:body})
 const loyaltyFixture=async(capability:string,operation:string)=>{
  if(operation==='resume')expect((await loyalty(capability,{operation:'pause',reason:'隔离测试暂停',expectedVersion:0})).statusCode).toBe(200)
  return {operation,reason:'隔离测试运行开关',expectedVersion:operation==='pause'?0:1}
 }
 for(const capability of ['points_accrual','points_redemption','wechat_notification']){
  for(const operation of ['pause','resume'])it.each(['fresh','receipt'])(`${capability} ${operation} %s rejects revocation after route authorization`,async mode=>{
   const body=await loyaltyFixture(capability,operation),key=randomUUID(),first=mode==='receipt'?await loyalty(capability,body,key):undefined
   if(first)expect(first.statusCode,first.body).toBe(200)
   const before=await snapshot();beforeExecute=()=>grant(permissions.filter(p=>p!=='loyalty.operations.control'))
   expect((await loyalty(capability,body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
   await grant();const recovered=await loyalty(capability,body,key);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().meta.replayed).toBe(mode==='receipt')
   if(first){expect(recovered.json().data).toEqual(first.json().data);expect(await snapshot()).toEqual(before)}
  })
  it(`${capability} binds legacy receipt to its original actor and preserves same-actor recovery after later changes`,async()=>{
   const body=await loyaltyFixture(capability,'pause'),key=randomUUID(),first=await loyalty(capability,body,key);expect(first.statusCode,first.body).toBe(200)
   expect((await loyalty(capability,{operation:'resume',reason:'隔离测试恢复',expectedVersion:1})).statusCode).toBe(200)
   const before=await snapshot()
   expect((await loyalty(capability,body,key,other)).statusCode).toBe(409)
   expect((await loyalty(capability,{...body,reason:'另一个暂停原因'},key)).statusCode).toBe(409)
   const replay=await loyalty(capability,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual({data:first.json().data,meta:{replayed:true}})
   expect(await snapshot()).toEqual(before)
  })
 }
 it('loyalty rejects a suspended actor between route authorization and receipt lookup',async()=>{
  const body=await loyaltyFixture('points_accrual','pause'),key=randomUUID();expect((await loyalty('points_accrual',body,key)).statusCode).toBe(200)
  const before=await snapshot();beforeExecute=async()=>{await admin.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[actor])}
  expect((await loyalty('points_accrual',body,key)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it('loyalty rejects both new and old requests when control was already revoked',async()=>{
  const body=await loyaltyFixture('points_accrual','pause'),key=randomUUID();expect((await loyalty('points_accrual',body,key)).statusCode).toBe(200)
  await grant(['loyalty.operations.view']);const before=await snapshot()
  expect((await loyalty('points_accrual',body,key)).statusCode).toBe(403);expect((await loyalty('points_accrual',body)).statusCode).toBe(403);expect(await snapshot()).toEqual(before)
 })
 it.each(['missing','mismatched'])('loyalty fails closed on %s receipt actor evidence',async kind=>{
  const body=await loyaltyFixture('points_accrual','pause'),key=randomUUID();expect((await loyalty('points_accrual',body,key)).statusCode).toBe(200)
  const raw=(await admin.query('SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,key])).rows[0].response_snapshot
  if(kind==='missing')delete raw.result.changedByEmployeeId;else raw.result.changedByEmployeeId=other
  await admin.query('UPDATE mbox.idempotency_records SET response_snapshot=$3::jsonb WHERE tenant_id=$1 AND idempotency_key=$2',[scope.tenantId,key,JSON.stringify(raw)])
  const before=await snapshot();expect((await loyalty('points_accrual',body,key)).statusCode).toBe(409);expect(await snapshot()).toEqual(before)
 })
})
