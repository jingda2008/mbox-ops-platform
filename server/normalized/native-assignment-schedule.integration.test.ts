import { randomUUID } from 'node:crypto'
import Fastify,{type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {TableManagementRepository,TableManagementCommandService} from './table-management-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {tableManagementApiPlugin} from './table-management-api.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(databaseUrl&&runtimeUrl?describe:describe.skip)('native future assignments and unchanged current web view',()=>{
 let admin:Pool,runtime:Pool,app:FastifyInstance,runner:ScopedPostgresTransactionRunner
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employeeId=randomUUID(),otherEmployee=randomUUID(),roleId=randomUUID(),areaId=randomUUID(),tableId=randomUUID()
 let actor=employeeId
 const time=(hours:number)=>new Date(Date.now()+hours*3600000).toISOString()
 const send=(body:object,key=`native-business-${randomUUID()}`)=>app.inject({method:'POST',url:'/table-management/native-assignment-schedule/commands',headers:{'idempotency-key':key},payload:body})
 const read=async(mode='future',page=0)=>{const result=await app.inject({method:'GET',url:`/table-management/native-assignment-schedule?mode=${mode}&page=${page}`});expect(result.statusCode,result.body).toBe(200);return result.json().data}
 async function seed(start:number,end:number|null,type:'primary'|'backup'='primary') {
  return runner.run(scope,tx=>new TableManagementRepository(tx).assign({tableId,employeeId,roleId,assignmentType:type,startsAt:time(start),endsAt:end===null?null:time(end),reason:'隔离测试责任安排',createdByEmployeeId:employeeId}))
 }
 beforeAll(async()=>{
  await runNormalizedMigrations(databaseUrl!)
  admin=new Pool({connectionString:databaseUrl});runtime=new Pool({connectionString:runtimeUrl});await assertRuntimeDatabasePool(runtime,runtimeUrl!)
  runner=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Assignment test')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$1::text,'Assignment test')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'A','管理员'),($2,$3,$4,'B','其他员工')",[employeeId,otherEmployee,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'STORE_MANAGER','店长')",[roleId,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,employeeId,roleId])
  await admin.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'table.assignment.manage','管理责任分配') ON CONFLICT(tenant_id,store_id,code) DO NOTHING",[scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='table.assignment.manage'",[scope.tenantId,scope.storeId,roleId])
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','主区','indoor')",[areaId,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'A1','测试桌',4)",[tableId,scope.tenantId,scope.storeId,areaId])
  app=Fastify();const executor=new NormalizedCommandExecutor(runner)
  await app.register(tableManagementApiPlugin,{transactions:runner,commands:new TableManagementCommandService(executor),nativeCommands:executor,
   resolveContext:()=>({scope,employeeId:actor,businessDate:'2026-09-30',capabilities:['table.assignment.manage']})});await app.ready()
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await admin?.end()})
 it('advertises capability, lists future/history separately and keeps web current-only behavior',async()=>{
  await seed(-2,-1);await seed(-0.5,0.5);await seed(2,3)
  const options=await app.inject({method:'GET',url:'/table-management/assignment-options'});expect(options.json().data.supportsNativeAssignmentSchedule).toBe(true)
  expect((await read()).rows).toHaveLength(1);expect((await read('history')).rows).toHaveLength(1)
  const current=await app.inject({method:'GET',url:'/table-management/assignments'});expect(current.json().data).toHaveLength(1)
  expect((await read('future',1)).rows).toHaveLength(0)
  const denied=await app.inject({method:'GET',url:'/table-management/native-assignment-schedule?mode=future&page=-1'});expect(denied.statusCode).toBe(400)
 })
 it('updates future time and responsible employee once; stale edits cannot overwrite',async()=>{
  const before=(await read()).rows[0],key=`native-business-${randomUUID()}`
  const body={kind:'update',id:before.id,expected:before.configurationFingerprint,reason:'调整晚班负责人',schedule:{employeeId:otherEmployee,roleId,assignmentType:'backup',startsAt:time(4),endsAt:time(5)}}
  const changed=await send(body,key);expect(changed.statusCode,changed.body).toBe(200);expect(changed.json().data.row.employeeId).toBe(otherEmployee)
  expect((await send(body,key)).json()).toMatchObject({data:changed.json().data,meta:{replayed:true}})
  expect((await send({...body,reason:'试图覆盖新安排'})).statusCode).toBe(409)
  const audit=await admin.query("SELECT count(*)::int AS n FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND object_id=$3 AND action='native.assignment.update'",[scope.tenantId,scope.storeId,before.id]);expect(audit.rows[0].n).toBe(1)
 })
 it('cancels only future assignments without deleting history or granting responsibility later',async()=>{
  const before=(await read()).rows[0],key=`native-business-${randomUUID()}`
  const body={kind:'cancel',id:before.id,expected:before.configurationFingerprint,reason:'晚班人员请假取消'}
  const result=await send(body,key);expect(result.statusCode,result.body).toBe(200)
  expect(result.json().data.row.cancelledAt).not.toBeNull();expect((await read()).rows).toHaveLength(0)
  expect((await read('cancelled')).rows).toHaveLength(1)
  const visible=await runner.run(scope,async tx=>new TableManagementRepository(tx).listAssignments(await new StaffAccessRepository(tx).resolve(employeeId),time(4.5)))
  expect(visible.some(a=>a.id===before.id)).toBe(false)
  await expect(runner.run(scope,tx=>new TableManagementRepository(tx).endAssignment(before.id,time(4.8)))).rejects.toThrow()
  expect((await send(body,key)).json().meta.replayed).toBe(true)
  await seed(4,5) // Cancellation releases the original interval, without deleting the original row.
  actor=otherEmployee
  expect((await send(body,key)).statusCode).toBe(403)
  actor=employeeId
  await admin.query("UPDATE mbox.employee_roles SET ends_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3",[scope.tenantId,scope.storeId,employeeId])
  expect((await send(body,key)).statusCode).toBe(403)
  await admin.query("UPDATE mbox.employee_roles SET ends_at=NULL WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3",[scope.tenantId,scope.storeId,employeeId])
 })
 it('atomically rejects overlapping changes and a cancellation that races activation',async()=>{
  await seed(7,8)
  let rows=(await read()).rows
  const target=rows.find((r:{startsAt:string})=>Date.parse(r.startsAt)>Date.now()+6*3600000)
  const conflict={kind:'update',id:target.id,expected:target.configurationFingerprint,reason:'冲突排班应拒绝',schedule:{employeeId,roleId,assignmentType:'primary',startsAt:time(4.2),endsAt:time(4.6)}}
  const bad=await send(conflict);expect(bad.statusCode,bad.body).toBe(409);expect(bad.json().error.commitDisposition).toBe('not_committed')
  expect((await read()).rows.find((r:{id:string})=>r.id===target.id).startsAt).toBe(target.startsAt)
  // Simulate another authorized path moving the start into the active interval.
  await admin.query("UPDATE mbox.table_assignments SET starts_at=clock_timestamp()-interval '1 second',ends_at=clock_timestamp()+interval '5 minutes',employee_id=$4,assignment_type='backup' WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[scope.tenantId,scope.storeId,target.id,otherEmployee])
  expect((await send({kind:'cancel',id:target.id,expected:target.configurationFingerprint,reason:'已生效不能取消'})).statusCode).toBe(409)
 })
 it('allows one concurrent edit and rejects foreign ids and injected actors',async()=>{
  const before=(await read()).rows[0]
  const body={kind:'update',id:before.id,expected:before.configurationFingerprint,reason:'同时修改安排',schedule:{employeeId,roleId,assignmentType:'primary',startsAt:time(9),endsAt:time(10)}}
  const pair=await Promise.all([send(body),send({...body,reason:'另一管理员修改',schedule:{...body.schedule,startsAt:time(11),endsAt:time(12)}})])
  expect(pair.map(r=>r.statusCode).sort()).toEqual([200,409])
  expect((await send({...body,employeeId:otherEmployee})).statusCode).toBe(400)
  expect((await send({...body,id:randomUUID()})).statusCode).toBe(409)
 })
})
