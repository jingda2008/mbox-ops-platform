import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {TableManagementCommandService,TableManagementRepository} from './table-management-repository.js'
import {TableSessionRepository} from './table-session-repository.js'
import {tableManagementApiPlugin} from './table-management-api.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
const suite=url?describe:describe.skip
suite('table service ownership and employee-visible history',()=>{
 let admin:Pool,runtime:Pool,txs:ScopedPostgresTransactionRunner
 beforeAll(async()=>{await runNormalizedMigrations(url!);admin=new Pool({connectionString:url});runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??url,options:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL?undefined:'-c role=mbox_runtime'});txs=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)})
 afterAll(async()=>{await runtime?.end();await admin?.end()})
 async function fixture(){
  const tenantId=randomUUID(),storeId=randomUUID(),tableId=randomUUID(),areaId=randomUUID(),manager=randomUUID(),server=randomUUID(),reader=randomUUID(),role=randomUUID()
  await admin.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'测试')`,[tenantId])
  await admin.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'测试门店')`,[storeId,tenantId])
  await admin.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','大厅','indoor')`,[areaId,tenantId,storeId])
  await admin.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'T01','一号桌',4)`,[tableId,tenantId,storeId,areaId])
  for(const [id,code,name] of [[manager,'manager','开台店长'],[server,'server','主服务张三'],[reader,'reader','只读李四']])await admin.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$5)`,[id,tenantId,storeId,code,name])
  await admin.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'SERVICE_TEST_MANAGER','服务测试管理')`,[role,tenantId,storeId])
  await admin.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,'2020-01-01')`,[tenantId,storeId,manager,role])
  await admin.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'table.open','开台'),($1,$2,'table.assignment.manage','交接') ON CONFLICT DO NOTHING`,[tenantId,storeId])
  await admin.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('table.open','table.assignment.manage') ON CONFLICT DO NOTHING`,[tenantId,storeId,role])
  const scope={tenantId,storeId},executor=new NormalizedCommandExecutor(txs),commands=new TableManagementCommandService(executor)
  const app=Fastify();await app.register(tableManagementApiPlugin,{transactions:txs,commands,nativeCommands:executor,resolveContext:request=>{const employeeId=request.headers['x-test-employee'];if(typeof employeeId!=='string')throw new NormalizedAuthenticationRequiredError();return {scope,employeeId,businessDate:'2026-10-18',permissions:[]}}})
  const open=async(primaryServiceEmployeeId:string|undefined=server)=>txs.run(scope,tx=>new TableManagementRepository(tx).open({tableId,publicId:`service-${randomUUID()}`,guestCount:2,businessDate:'2026-10-18',openedByEmployeeId:manager,primaryServiceEmployeeId}))
  const get=(path:string,employeeId=reader)=>app.inject({method:'GET',url:path,headers:{'x-test-employee':employeeId}})
  const handover=(sessionId:string,employeeId=reader,expectedRevision=0,key=randomUUID(),actor=manager)=>app.inject({method:'POST',url:`/table-service/sessions/${sessionId}/handover`,headers:{'x-test-employee':actor,'idempotency-key':key},payload:{employeeId,expectedRevision,reason:'晚班交接'}})
  return {scope,tableId,manager,server,reader,role,app,open,get,handover}
 }
 it('requires a named primary through both open repositories and rejects inactive/cross-store selections',async()=>{
  const f=await fixture(),other=await fixture()
  for(const primary of [undefined,other.server])await expect(txs.run(f.scope,tx=>new TableManagementRepository(tx).open({tableId:f.tableId,publicId:randomUUID(),guestCount:2,businessDate:'2026-10-18',openedByEmployeeId:f.manager,primaryServiceEmployeeId:primary}))).rejects.toThrow(/主服务员/)
  await expect(txs.run(f.scope,tx=>new TableSessionRepository(tx).open({table:{kind:'id',value:f.tableId},publicId:randomUUID(),guestCount:2,businessDate:'2026-10-18',openedByEmployeeId:f.manager}))).rejects.toThrow(/主服务员/)
  await admin.query(`UPDATE mbox.employees SET status='suspended' WHERE id=$1`,[f.server]);await expect(f.open()).rejects.toThrow(/在职/)
  expect((await f.get('/table-service/tables')).json().data[0].sessionId).toBeNull();await f.app.close();await other.app.close()
 })
 it('uses the unique effective primary assignment for compatible callers without substituting the opener',async()=>{
  const f=await fixture();await admin.query(`INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason,created_by_employee_id) VALUES($1,$2,$3,$4,$5,'primary','2020-01-01','当班负责',$6)`,[f.scope.tenantId,f.scope.storeId,f.tableId,f.server,f.role,f.manager])
  const session=await txs.run(f.scope,tx=>new TableSessionRepository(tx).open({table:{kind:'id',value:f.tableId},publicId:randomUUID(),guestCount:2,businessDate:'2026-10-18',openedByEmployeeId:f.manager}))
  const d=(await f.get(`/table-service/sessions/${session.id}`)).json().data
  expect(d.session.primaryId).toBe(f.server);expect(d.session.openedBy).toBe('开台店长');expect(d.changes[0].toName).toBe('主服务张三');await f.app.close()
 })
 it('opens atomically and all active employees can read minimal data but cannot hand over',async()=>{
  const f=await fixture();const session=await f.open()
  const response=await f.get(`/table-service/sessions/${session.id}`);expect(response.statusCode,response.body).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store');expect(response.json().data.session.primaryId).toBe(f.server)
  expect(response.body).not.toMatch(/price|amount|customer|password|pin_hash|request_snapshot/)
  expect((await f.get('/table-service/tables')).json().data[0].sessionId).toBe(session.id)
  expect((await f.handover(session.id,f.reader,0,randomUUID(),f.reader)).statusCode).toBe(403)
  expect((await f.app.inject(`/table-service/sessions/${session.id}`)).statusCode).toBe(401)
  await admin.query(`UPDATE mbox.employees SET status='suspended' WHERE id=$1`,[f.reader]);expect((await f.get(`/table-service/sessions/${session.id}`)).statusCode).toBe(403);await f.app.close()
 })
 it('rejects foreign session reads and keeps RLS isolated under a restricted runtime role',async()=>{
  const a=await fixture(),b=await fixture(),s=await b.open();expect((await a.get(`/table-service/sessions/${s.id}`)).statusCode).toBe(404)
  const rows=await txs.run(a.scope,tx=>tx.query('SELECT * FROM mbox.table_session_service_changes WHERE table_session_id=$1',[s.id]));expect(rows.rowCount).toBe(0)
  expect((await a.get(`/table-service/tables/${b.tableId}/options`)).statusCode).toBe(404);await a.app.close();await b.app.close()
 })
 it('persists immutable handovers, snapshots names, and replays the same request once',async()=>{
  const f=await fixture(),s=await f.open(),key=randomUUID();const one=await f.handover(s.id,f.reader,0,key);expect(one.statusCode,one.body).toBe(200)
  const replay=await f.handover(s.id,f.reader,0,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
  await admin.query(`UPDATE mbox.employees SET display_name='改名后' WHERE id=$1`,[f.server])
  const d=(await f.get(`/table-service/sessions/${s.id}`)).json().data;expect(d.session.primaryId).toBe(f.reader);expect(d.changes).toHaveLength(2);expect(d.changes[1].toName).toBe('主服务张三');expect(d.changes[0].fromName).toBe('主服务张三')
  await expect(admin.query('UPDATE mbox.table_session_service_changes SET reason=$1 WHERE table_session_id=$2',['篡改历史',s.id])).rejects.toThrow()
  await expect(txs.run(f.scope,tx=>tx.query('UPDATE mbox.table_sessions SET primary_service_employee_id=$1 WHERE id=$2',[f.server,s.id]))).rejects.toThrow(/交接记录/)
  expect((await f.handover(s.id,f.server,0,key)).statusCode).toBe(409);await f.app.close()
 })
 it('allows exactly one of two concurrent handovers and rejects stale/closed changes',async()=>{
  const f=await fixture(),s=await f.open();const results=await Promise.all([f.handover(s.id,f.reader),f.handover(s.id,f.manager)])
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await f.handover(s.id,f.server)).statusCode).toBe(409)
  await admin.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1`,[s.id,f.manager])
  expect((await f.handover(s.id,f.server,1)).statusCode).toBe(409);await f.app.close()
 })
 it('keeps old unknown owners honest, allows explicit confirmation, and does not change closed historical owners on re-open',async()=>{
  const f=await fixture();const old=randomUUID();await admin.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,opened_by_employee_id) VALUES($1::uuid,$2,$3,$4,$1::text,'2026-10-18',2,4,$5)`,[old,f.scope.tenantId,f.scope.storeId,f.tableId,f.manager])
  const before=(await f.get(`/table-service/sessions/${old}`)).json().data;expect(before.session.primaryId).toBeNull();expect(before.changes).toEqual([])
  expect((await f.handover(old,f.server)).statusCode).toBe(200)
  await admin.query(`UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1`,[old,f.manager])
  const next=await f.open(f.reader);const d=(await f.get(`/table-service/sessions/${old}`)).json().data;expect(d.session.primaryId).toBe(f.server)
  const history=(await f.get(`/table-service/tables/${f.tableId}/sessions`)).json().data.sessions;expect(history.map((s:{id:string})=>s.id)).toEqual([next.id,old]);await f.app.close()
 })
 it('shows real service actors, system events and complete paginated history without exposing private notes',async()=>{
  const f=await fixture(),s=await f.open(),task=randomUUID()
  await admin.query(`INSERT INTO mbox.service_tasks(id,tenant_id,store_id,table_id,table_session_id,public_id,task_type,title,detail,source) VALUES($1::uuid,$2,$3,$4,$5,$1::text,'call_staff','顾客呼叫','不应公开的电话','guest')`,[task,f.scope.tenantId,f.scope.storeId,f.tableId,s.id])
  for(let i=0;i<55;i++)await admin.query(`INSERT INTO mbox.service_task_events(tenant_id,store_id,service_task_id,event_type,actor_type,actor_employee_id,note) VALUES($1,$2,$3,'task.completed','employee',$4,'私密备注')`,[f.scope.tenantId,f.scope.storeId,task,i%2?f.server:f.reader])
  await admin.query(`INSERT INTO mbox.service_task_events(tenant_id,store_id,service_task_id,event_type,actor_type) VALUES($1,$2,$3,'task.created','guest')`,[f.scope.tenantId,f.scope.storeId,task])
  const first=await f.get(`/table-service/sessions/${s.id}`),d=first.json().data;expect(d.activities).toHaveLength(50);expect(d.activitiesHasMore).toBe(true);expect(d.activities[0].actorId).toBeNull();expect(first.body).not.toMatch(/私密备注|不应公开的电话/)
  const second=(await f.get(`/table-service/sessions/${s.id}?activitiesPage=1`)).json().data;expect(second.activities).toHaveLength(6);expect(second.activitiesHasMore).toBe(false)
  expect(new Set([...d.activities,...second.activities].map((r:{id:string})=>r.id)).size).toBe(56);await f.app.close()
 })
 it('rechecks write permission before replay after access is revoked',async()=>{
  const f=await fixture(),s=await f.open(),key=randomUUID();expect((await f.handover(s.id,f.reader,0,key)).statusCode).toBe(200)
  await admin.query(`DELETE FROM mbox.role_permission_assignments WHERE tenant_id=$1 AND store_id=$2 AND role_id=$3`,[f.scope.tenantId,f.scope.storeId,f.role])
  expect((await f.handover(s.id,f.reader,0,key)).statusCode).toBe(403);await f.app.close()
 })
})
