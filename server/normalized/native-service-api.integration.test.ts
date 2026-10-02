import { randomUUID } from 'node:crypto'
import Fastify, {type FastifyInstance} from 'fastify'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {registerNativeServiceRoutes} from './native-service-api.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {ServiceTaskRepository} from './service-task-repository.js'
import {OperationsQueryService} from './operations-query-service.js'
import type {NormalizedOperationsApiOptions} from './normalized-operations-api.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeDatabase=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const suite=database&&runtimeDatabase?describe:describe.skip
suite('native service center runtime integration',()=>{
 const tenant=randomUUID(),store=randomUUID(),area=randomUUID(),table=randomUUID(),session=randomUUID(),manager=randomUUID(),worker=randomUUID(),role=randomUUID(),workerRole=randomUUID()
 const scope={tenantId:tenant,storeId:store};let pool:Pool,runtime:Pool,app:FastifyInstance
 let actor=manager
 let readonlyMode=false
 beforeAll(async()=>{
 await runNormalizedMigrations(database!);pool=new Pool({connectionString:database});runtime=new Pool({connectionString:runtimeDatabase});const tx=new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
 await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Native Service')",[tenant,'native-service-'+tenant])
 await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'native-service','Native Service')",[store,tenant])
 await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type,sort_order) VALUES($1,$2,$3,'MAIN','大厅','indoor',1)",[area,tenant,store])
 await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'A5','A5',4)",[table,tenant,store,area])
 await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$3,$4,'manager','主管'),($2,$3,$4,'worker','员工')",[manager,worker,tenant,store])
 await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$3,$4,'MANAGER','主管'),($2,$3,$4,'WORKER','员工')",[role,workerRole,tenant,store])
 await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$5,'2026-01-01'),($1,$2,$4,$6,'2026-01-01')",[tenant,store,manager,worker,role,workerRole])
 await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'service.execute','服务'),($1,$2,'service.manage','主管服务'),($1,$2,'table.view_all','查看全店桌台') ON CONFLICT DO NOTHING",[tenant,store])
 await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('service.execute','service.manage','table.view_all') ON CONFLICT DO NOTHING",[tenant,store,role])
 await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='service.execute' ON CONFLICT DO NOTHING",[tenant,store,workerRole])
 await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status,opened_by_employee_id) VALUES($1,$2,$3,$4,$5,CURRENT_DATE,2,'open',$6)",[session,tenant,store,table,'native-service-'+session,manager])
 app=Fastify();await app.register(async child=>registerNativeServiceRoutes(child,{resolveContext:(request)=>{const employeeId=(request.headers['x-test-actor'] as string)||actor;return {scope,employeeId,businessDate:'2026-09-28',capabilities:readonlyMode?['service.view']:employeeId===manager?['service.execute','service.manage','table.view_all']:['service.execute']}},commandExecutor:new NormalizedCommandExecutor(tx),operationsQuery:new OperationsQueryService(tx),createServiceTaskRepository:t=>new ServiceTaskRepository(t)} as NormalizedOperationsApiOptions),{prefix:'/api'})
 })
 afterAll(async()=>{await app?.close();await runtime?.end();await pool?.end()})
 async function task(type='guest.water') {const id=randomUUID();await pool.query("INSERT INTO mbox.service_tasks(id,tenant_id,store_id,table_id,table_session_id,public_id,task_type,title,priority,status,source,assigned_employee_id) VALUES($1,$2,$3,$4,$5,$6,$7,'现场服务','normal','pending','employee',$8)",[id,tenant,store,table,session,'service-'+id,type,manager]);return id}
 function send(id:string,action:string,key:string,body:Record<string,unknown>={}){return app.inject({method:'POST',url:`/api/native-service-tasks/${id}/${action}`,headers:{'idempotency-key':key},payload:{employeeId:actor,tableSessionId:session,taskType:'guest.water',expectedStatus:'pending',expectedPriority:'normal',expectedAssignedEmployeeId:manager,note:'已核对现场情况',...body}})}
 it('reads scoped tasks and only eligible service employees',async()=>{const id=await task();const response=await app.inject({url:'/api/native-service-center'});expect(response.statusCode).toBe(200);expect(response.json().data.tasks.some((t:{id:string})=>t.id===id)).toBe(true);expect(response.json().data.employees).toEqual(expect.arrayContaining([expect.objectContaining({id:worker,canManage:false})]))})
 it('allows scoped read-only service staff without employee directory or mutation authority',async()=>{
  const id=await task(),permission=(await pool.query("SELECT id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='service.view'",[tenant,store])).rows[0].id;await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)",[tenant,store,workerRole,permission]);await pool.query("UPDATE mbox.service_tasks SET assigned_employee_id=$1 WHERE id=$2",[worker,id]);actor=worker;readonlyMode=true
  const denied=randomUUID();await pool.query("INSERT INTO mbox.employee_permission_overrides(id,tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,$4,id,'deny','只读角色验证',$5 FROM mbox.staff_permission_definitions WHERE tenant_id=$2 AND store_id=$3 AND code='service.execute'",[denied,tenant,store,worker,manager])
  try{const response=await app.inject('/api/native-service-center');expect(response.statusCode,response.body).toBe(200);expect(response.json().data.tasks.some((r:{id:string})=>r.id===id)).toBe(true);expect(response.json().data.employees).toEqual([]);expect((await send(id,'complete','native-business-'+randomUUID(),{expectedAssignedEmployeeId:worker})).statusCode).toBe(403)
   await pool.query('DELETE FROM mbox.role_permission_assignments WHERE role_id=$1 AND permission_id=$2',[workerRole,permission]);expect((await app.inject('/api/native-service-center')).statusCode).toBe(403)
  }finally{readonlyMode=false;actor=manager;await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE id=$1',[denied])}
 })
 it('reassigns atomically and replays one immutable event',async()=>{const id=await task();const key='native-business-'+randomUUID();const first=await send(id,'assign',key,{assignedEmployeeId:worker});expect(first.statusCode,first.body).toBe(200);expect(first.json().data.assignedEmployeeId).toBe(worker);const second=await send(id,'assign',key,{assignedEmployeeId:worker});expect(second.json().meta.replayed).toBe(true);expect((await pool.query('SELECT count(*) FROM mbox.service_task_events WHERE service_task_id=$1 AND idempotency_key=$2',[id,key])).rows[0].count).toBe('1');expect((await pool.query('SELECT expires_at::text AS expiry FROM mbox.idempotency_records WHERE idempotency_key=$1',[key])).rows[0].expiry).toBe('infinity')})
 it('stale state is explicitly rolled back, conflicting receipt content remains unknown',async()=>{const id=await task();const key='native-business-'+randomUUID();const stale=await send(id,'priority',key,{priority:'high',expectedPriority:'urgent'});expect(stale.statusCode).toBe(409);expect(stale.json().error.commitDisposition).toBe('not_committed');const first=await send(id,'priority',key,{priority:'high'});expect(first.statusCode,first.body).toBe(200);const changed=await send(id,'priority',key,{priority:'urgent'});expect(changed.statusCode).toBe(409);expect(changed.json().error.commitDisposition).toBeUndefined()})
 it('denies out-of-scope worker and rechecks revoked permission before cached success',async()=>{const id=await task();const key='native-business-'+randomUUID();actor=worker;const denied=await send(id,'complete',key);expect(denied.statusCode).toBe(404);actor=manager;expect((await send(id,'complete',key)).statusCode).toBe(200);const deny=randomUUID();await pool.query("INSERT INTO mbox.employee_permission_overrides(id,tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,$4,id,'deny','撤权恢复验证',$4 FROM mbox.staff_permission_definitions WHERE tenant_id=$2 AND store_id=$3 AND code='service.execute'",[deny,tenant,store,manager]);try{const replay=await send(id,'complete',key);expect(replay.statusCode).toBe(403);expect(replay.json().error.commitDisposition).toBeUndefined()}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE id=$1',[deny])}})
 it('complaints require a manager recipient and recorded resolution',async()=>{const id=await task('guest.complaint');const key='native-business-'+randomUUID();const denied=await send(id,'assign',key,{taskType:'guest.complaint',assignedEmployeeId:worker});expect(denied.statusCode).toBe(409);expect(denied.json().error.commitDisposition).toBe('not_committed');const short=await send(id,'complete',key,{taskType:'guest.complaint',note:'完成'});expect(short.statusCode).toBe(400);const complete=await send(id,'complete',key,{taskType:'guest.complaint',note:'已当面沟通并确认处理结果'});expect(complete.statusCode,complete.body).toBe(200);expect(complete.json().data.status).toBe('completed')})
 it('does not flatten specialized experience tasks into ordinary service completion',async()=>{const id=await task('experience.followup');const reply=await send(id,'complete','native-business-'+randomUUID(),{taskType:'experience.followup'});expect(reply.statusCode).toBe(409);expect(reply.json().error.commitDisposition).toBe('not_committed');expect((await pool.query('SELECT status FROM mbox.service_tasks WHERE id=$1',[id])).rows[0].status).toBe('pending')})
 function recoveryBody(id:string,key:string){return {taskId:id,action:'complete',originalKey:key,original:{employeeId:worker,tableSessionId:session,taskType:'guest.water',expectedStatus:'pending',expectedPriority:'normal',expectedAssignedEmployeeId:worker,note:'已核对现场情况'},reason:'原员工离岗，主管核对原请求',confirmed:true}}
 function resolve(body:Record<string,unknown>,employee=manager){return app.inject({method:'POST',url:'/api/native-service-recovery',headers:{'x-test-actor':employee},payload:body})}
 async function workerTask(){const id=await task();await pool.query('UPDATE mbox.service_tasks SET assigned_employee_id=$1 WHERE id=$2',[worker,id]);return id}
 function original(body:ReturnType<typeof recoveryBody>){return app.inject({method:'POST',url:`/api/native-service-tasks/${body.taskId}/complete`,headers:{'idempotency-key':body.originalKey,'x-test-actor':worker},payload:body.original})}
 it('supervisor recovers a committed receipt after the original employee is suspended, without repeating the task',async()=>{
  const id=await workerTask(),body=recoveryBody(id,'native-business-'+randomUUID());expect((await original(body)).statusCode).toBe(200)
  await pool.query("UPDATE mbox.employees SET status='suspended' WHERE id=$1",[worker])
  try{const response=await resolve(body);expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toMatchObject({disposition:'committed',originalKey:body.originalKey,employeeId:worker,receipt:{id,status:'completed'}});expect(response.json().meta.replayed).toBe(true);expect((await pool.query('SELECT count(*) FROM mbox.service_task_events WHERE service_task_id=$1',[id])).rows[0].count).toBe('1')}
  finally{await pool.query("UPDATE mbox.employees SET status='active' WHERE id=$1",[worker])}
 })
 it('permanently withdraws an uncommitted original request without changing the task; an original retry cannot execute',async()=>{
  const id=await workerTask(),body=recoveryBody(id,'native-business-'+randomUUID());const first=await resolve(body);expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({disposition:'withdrawn',employeeId:worker,resolution:{supervisorId:manager,originalKey:body.originalKey}})
  const retry=await original(body);expect(retry.statusCode,retry.body).toBe(409);expect(retry.json().error.commitDisposition).toBe('not_committed');expect((await resolve(body)).json().meta.replayed).toBe(true)
  expect((await pool.query('SELECT status FROM mbox.service_tasks WHERE id=$1',[id])).rows[0].status).toBe('pending');expect((await pool.query('SELECT count(*) FROM mbox.service_task_events WHERE service_task_id=$1',[id])).rows[0].count).toBe('0')
  const conflict=await resolve({...body,original:{...body.original,note:'另一个请求'}});expect(conflict.statusCode).toBe(409);expect(conflict.json().error.commitDisposition).toBeUndefined()
  expect((await pool.query('SELECT expires_at::text AS expiry FROM mbox.idempotency_records WHERE idempotency_key=$1',[body.originalKey])).rows[0].expiry).toBe('infinity')
 })
 it('does not infer non-commit when the domain event remains but its receipt has been removed',async()=>{
  const id=await workerTask(),body=recoveryBody(id,'native-business-'+randomUUID());expect((await original(body)).statusCode).toBe(200);await pool.query('DELETE FROM mbox.idempotency_records WHERE idempotency_key=$1',[body.originalKey]);const response=await resolve(body);expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('NATIVE_SERVICE_UNCONFIRMED');expect(response.json().error.commitDisposition).toBeUndefined()
 })
 it('requires another authorized supervisor and confirmation, including fresh authorization on receipt replay',async()=>{
  const body=recoveryBody(await workerTask(),'native-business-'+randomUUID());expect((await resolve(body,worker)).statusCode).toBe(403);expect((await resolve({...body,confirmed:false})).statusCode).toBe(400);expect((await resolve({...body,original:{...body.original,employeeId:manager}})).statusCode).toBe(400)
  expect((await resolve(body)).statusCode).toBe(200);const deny=randomUUID();await pool.query("INSERT INTO mbox.employee_permission_overrides(id,tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id) SELECT $1,$2,$3,$4,id,'deny','撤权恢复验证',$4 FROM mbox.staff_permission_definitions WHERE tenant_id=$2 AND store_id=$3 AND code='service.manage'",[deny,tenant,store,manager]);try{expect((await resolve(body)).statusCode).toBe(403)}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE id=$1',[deny])}
 })
 it('serializes supervisor withdrawal with an original request racing on the same task and key',async()=>{
  const body=recoveryBody(await workerTask(),'native-business-'+randomUUID());const [first,second]=await Promise.all([original(body),resolve(body)]);expect(second.statusCode,second.body).toBe(200);const committed=second.json().data.disposition==='committed';expect(first.statusCode,first.body).toBe(committed?200:409);expect((await pool.query('SELECT count(*) FROM mbox.service_task_events WHERE service_task_id=$1',[body.taskId])).rows[0].count).toBe(committed?'1':'0')
 })

})
