import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import Fastify from 'fastify'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {CustomerExperienceRepository} from './customer-experience-repository.js'
import {ExperiencePlanActivationRepository} from './experience-plan-activation-repository.js'
import {ExperienceCueDispatchWorker} from './experience-cue-dispatch-worker.js'
import {customerExperienceApiPlugin} from './customer-experience-api.js'
import {CustomerExperienceService} from './customer-experience-service.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {NormalizedProviderObservationAuthority} from './provider-verification-observation.js'
import {normalizedOperationsApiPlugin} from './normalized-operations-api.js'
import {ServiceTaskRepository} from './service-task-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {TableSessionRepository,TableSessionCommandService} from './table-session-repository.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL,runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const newIds=()=>({
  tenant:randomUUID(),store:randomUUID(),otherStore:randomUUID(),canonical:randomUUID(),merged:randomUUID(),
  area:randomUUID(),tableTabTable:randomUUID(),paymentTable:randomUUID(),
  tableTabSession:randomUUID(),paymentSession:randomUUID(),product:randomUUID(),policy:randomUUID(),
  policyDrafter:randomUUID(),policyApprover:randomUUID(),policyPublisher:randomUUID(),
  tableTabRecommendation:randomUUID(),paymentRecommendation:randomUUID(),
  tableTabOption:randomUUID(),paymentOption:randomUUID(),tableTabOrder:randomUUID(),paymentOrder:randomUUID(),
  tableTabItem:randomUUID(),paymentItem:randomUUID(),payment:randomUUID(),
})

;(url&&runtimeUrl?describe:describe.skip)('normal experience lifecycle, real restricted LOGIN',()=>{
  let pool:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner,commands:NormalizedCommandExecutor
  const apps:Array<ReturnType<typeof Fastify>>=[]
  beforeAll(async()=>{await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:12});runtime=new Pool({connectionString:runtimeUrl,max:12,application_name:'experience-lifecycle-low-runtime'});runner=new ScopedPostgresTransactionRunner(runtime);commands=new NormalizedCommandExecutor(runner)
    expect((await runtime.query('SELECT current_user=session_user direct_login,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({direct_login:true,rolsuper:false,rolbypassrls:false})
  },30000)
  afterAll(async()=>{vi.useRealTimers();for(const app of apps)await app.close();await runtime?.end();await pool?.end()})
  async function fixture(ageMinutes=120){
    const id=newIds(),scope={tenantId:id.tenant,storeId:id.store},employeeId=id.policyPublisher
    await seed(pool,id)
    const role=randomUUID(),permissions=['service.execute','customer.experience.manage','table.close','table.view_all','payment.manual.cash.record','payment.collect.all_tables']
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'LIFECYCLE','Lifecycle')",[role,scope.tenantId,scope.storeId])
    await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,employeeId,role])
    for(const code of permissions){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[scope.tenantId,scope.storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,role,permission])
    }
    const reference=await runner.run(scope,tx=>new CustomerExperienceRepository(tx).recordRecommendationOrdered({recommendationPublicId:'recommendation-table-tab-086',selectedProductId:id.product,customerId:id.merged,tableSessionId:id.tableTabSession,businessDate:'2026-08-16',orderId:id.tableTabOrder,orderPublicId:'order-table-tab-086',actorRef:'lifecycle-fixture'}))
    // Only the business Date used to create the plan is moved back. PostgreSQL
    // clocks/timers and every service/worker transition remain real.
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()-ageMinutes*60000)
    try{expect((await runner.run(scope,tx=>new ExperiencePlanActivationRepository(tx).recordOrderedNonCritical({reference,orderId:id.tableTabOrder,actorRef:'lifecycle-fixture'}))).state).toBe('active')}finally{vi.useRealTimers()}
    const date=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text date',[scope.tenantId,scope.storeId])).rows[0]!.date)
    const money=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    await money.recordManual({scope,actor:{type:'employee',employeeId},businessDate:date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),orderId:id.tableTabOrder,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{collectedByEmployeeId:employeeId,receiptReference:randomUUID()}})
    const app=Fastify();apps.push(app)
    await app.register(normalizedOperationsApiPlugin,{operationsQuery:{getStaffView:async()=>{throw Error('unused')}},tableSessions:new TableSessionCommandService(commands),commandExecutor:commands,
      resolveContext:async()=>({scope,employeeId,businessDate:date,capabilities:(await runner.run(scope,tx=>new StaffAccessRepository(tx).resolve(employeeId))).permissions}),
      createTableSessionRepository:tx=>new TableSessionRepository(tx),createServiceTaskRepository:tx=>new ServiceTaskRepository(tx)})
    const worker=new ExperienceCueDispatchWorker(runner)
    const service=new CustomerExperienceService(runner,commands,{updateProfile:async()=>{throw Error('unused')}})
    await app.register(customerExperienceApiPlugin,{transactions:runner,service,resolveStaffContext:()=>({scope,employeeId,businessDate:date}),resolvePublicContext:()=>{throw Error('unused')},resolveGuestContext:()=>{throw Error('unused')},protectContact:()=>{throw Error('unused')}})
    const rows=async()=>(await pool.query('SELECT cue.*,plan.plan_state,plan.completed_at plan_completed_at,plan.id plan_id FROM mbox.experience_plan_cues cue JOIN mbox.customer_experience_plans plan ON plan.id=cue.experience_plan_id WHERE plan.order_id=$1 ORDER BY cue.sequence_no',[id.tableTabOrder])).rows
    const complete=(taskId:string,key=randomUUID())=>app.inject({method:'POST',url:`/service-tasks/${taskId}/complete`,headers:{'idempotency-key':key},payload:{note:'已按本桌节点要求实际完成服务'}})
    return {id,scope,employeeId,date,app,worker,service,rows,complete}
  }
  it('normal service completion converges every linked cue and then the plan, allowing ordinary table closure',async()=>{
    const f=await fixture();const batch=await f.worker.runBatch(f.scope,'lifecycle-red')
    expect(batch.dispatchedCueIds.length).toBe(9)
    for(const cue of await f.rows()){const result=await f.complete(cue.service_task_id);expect(result.statusCode,result.body).toBe(200)}
    const rows=await f.rows()
    expect(rows.map(row=>row.status)).toEqual(Array(9).fill('completed'))
    expect(rows.every(row=>row.plan_state==='completed'&&row.plan_completed_at!==null)).toBe(true)
    expect((await runner.run(f.scope,tx=>readTableSessionClosureState(tx,f.id.tableTabSession))).blockers).toEqual([])
    for(const transition of ['begin-closing','close']){const result=await f.app.inject({method:'POST',url:`/table-sessions/${f.id.tableTabSession}/${transition}`,headers:{'idempotency-key':randomUUID()},payload:{}});expect(result.statusCode,result.body).toBe(200)}
  })
  it('the explicit cue completion path also finishes the active plan exactly when every real node is done',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-explicit')
    for(const cue of await f.rows())await f.service.completeCue({scope:f.scope,employeeId:f.employeeId,businessDate:f.date},{cueId:cue.id,note:'实际完成本节点服务',idempotencyKey:randomUUID()})
    expect((await f.rows()).every(row=>row.plan_state==='completed')).toBe(true)
  })
  const close=(f:Awaited<ReturnType<typeof fixture>>)=>f.app.inject({method:'POST',url:`/table-sessions/${f.id.tableTabSession}/begin-closing`,headers:{'idempotency-key':randomUUID()},payload:{}})
  async function countPlanEvents(f:Awaited<ReturnType<typeof fixture>>){return (await pool.query(`SELECT
    (SELECT count(*)::int FROM mbox.audit_events WHERE tenant_id=$1 AND action='customer.experience.plan.completed') audits,
    (SELECT count(*)::int FROM mbox.outbox_messages WHERE tenant_id=$1 AND message_type='customer.experience.plan.completed.v1') outbox`,[f.id.tenant])).rows[0]}
  it('recovers only the legacy missing cue projection from real employee task events, preserving every original task/event',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-legacy-dispatch')
    for(const cue of await f.rows())await runner.run(f.scope,tx=>new ServiceTaskRepository(tx).complete({taskId:cue.service_task_id,actor:{type:'employee',employeeId:f.employeeId},note:'原流程已实际完成服务',eventIdempotencyKey:randomUUID()}))
    // Exercise the original repository business transition, without the new
    // projection hook. No completed task/cue/plan is fabricated through SQL.
    const originals=async()=>({tasks:(await pool.query('SELECT to_jsonb(task) fact FROM mbox.service_tasks task WHERE tenant_id=$1 ORDER BY id',[f.id.tenant])).rows,events:(await pool.query('SELECT to_jsonb(event) fact FROM mbox.service_task_events event WHERE tenant_id=$1 ORDER BY id',[f.id.tenant])).rows})
    const before=await originals();expect((await f.rows()).every(row=>row.status==='dispatched'&&row.plan_state==='active')).toBe(true)
    await f.worker.runBatch(f.scope,'lifecycle-legacy-recover',1)
    const rows=await f.rows();expect(rows.every(row=>row.status==='completed'&&row.plan_state==='completed')).toBe(true)
    for(const row of rows){const original=before.tasks.find(value=>value.fact.id===row.service_task_id)!.fact;expect(new Date(row.completed_at).toISOString()).toBe(new Date(original.completed_at).toISOString());expect(row.completed_by_employee_id).toBe(f.employeeId)}
    expect(await originals()).toEqual(before);expect(await countPlanEvents(f)).toEqual({audits:1,outbox:1})
    await f.worker.runBatch(f.scope,'lifecycle-legacy-again',1)
    expect(await originals()).toEqual(before);expect(await countPlanEvents(f)).toEqual({audits:1,outbox:1})
  })
  it.each(['paused','skipped'] as const)('does not reinterpret a %s controlled-state fixture as normally fulfilled',async state=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-state')
    const cues=await f.rows()
    // Negative state fixtures only; no SQL sets completed or manufactures
    // service evidence. Early-leave/skip business rules are outside this change.
    if(state==='paused')await pool.query("UPDATE mbox.customer_experience_plans SET plan_state='paused' WHERE order_id=$1",[f.id.tableTabOrder])
    else await pool.query("UPDATE mbox.experience_plan_cues SET status='skipped' WHERE id=$1",[cues[0]!.id])
    for(const cue of cues.slice(state==='paused'?0:1))await runner.run(f.scope,tx=>new ServiceTaskRepository(tx).complete({taskId:cue.service_task_id,actor:{type:'employee',employeeId:f.employeeId},note:'已实际完成的其余任务',eventIdempotencyKey:randomUUID()}))
    await f.worker.runBatch(f.scope,'lifecycle-state-reconcile')
    expect((await f.rows()).every(row=>row.plan_state===(state==='paused'?'paused':'active'))).toBe(true)
    expect(await countPlanEvents(f)).toEqual({audits:0,outbox:0})
    expect((await close(f)).statusCode).toBe(409)
  })
  it('future pending cues and cancelled service tasks remain real blockers',async()=>{
    const f=await fixture(0),batch=await f.worker.runBatch(f.scope,'lifecycle-future')
    expect(batch.dispatchedCueIds).toHaveLength(1)
    const cues=await f.rows(),first=cues[0]!
    expect((await f.complete(first.service_task_id)).statusCode).toBe(200)
    expect((await f.rows()).filter(row=>row.status==='pending')).toHaveLength(8)
    expect((await close(f)).statusCode).toBe(409)
    await expect(f.service.completeCue({scope:f.scope,employeeId:f.employeeId,businessDate:f.date},{cueId:cues[1]!.id,note:'不能提前假记完成',idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'EXPERIENCE_CUE_NOT_ACTIONABLE'})
    expect(await countPlanEvents(f)).toEqual({audits:0,outbox:0})
    const cancelled=await fixture();await cancelled.worker.runBatch(cancelled.scope,'lifecycle-cancel')
    const targets=await cancelled.rows()
    const response=await cancelled.app.inject({method:'POST',url:`/service-tasks/${targets[0]!.service_task_id}/cancel`,headers:{'idempotency-key':randomUUID()},payload:{note:'该服务已取消但不能冒记履约'}})
    expect(response.statusCode,response.body).toBe(200)
    for(const cue of targets.slice(1))expect((await cancelled.complete(cue.service_task_id)).statusCode).toBe(200)
    await cancelled.worker.runBatch(cancelled.scope,'lifecycle-cancel-recheck')
    expect((await cancelled.rows()).every(row=>row.plan_state==='active')).toBe(true)
    expect((await close(cancelled)).statusCode).toBe(409)
  })
  it('replays both original endpoints once, rejects changed bodies and current permission withdrawal',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-replay')
    const cues=await f.rows(),taskKey=randomUUID(),cueKey=randomUUID()
    const request=()=>f.app.inject({method:'POST',url:`/staff/customer-experience/cues/${cues[1]!.id}/complete`,headers:{'idempotency-key':cueKey},payload:{note:'员工实际完成原节点'}})
    expect((await f.complete(cues[0]!.service_task_id,taskKey)).statusCode).toBe(200)
    expect((await f.complete(cues[0]!.service_task_id,taskKey)).json().meta.replayed).toBe(true)
    expect((await request()).statusCode).toBe(200);expect((await request()).json().meta.replayed).toBe(true)
    for(const note of ['员工实际完成原节点','新键改写原说明']){
      const repeat=await f.app.inject({method:'POST',url:`/staff/customer-experience/cues/${cues[1]!.id}/complete`,headers:{'idempotency-key':randomUUID()},payload:{note}})
      expect(repeat.statusCode,repeat.body).toBe(409)
    }
    expect((await pool.query("SELECT count(*)::int n FROM mbox.audit_events WHERE tenant_id=$1 AND action='customer.experience.cue.completed'",[f.id.tenant])).rows[0].n).toBe(1)
    const changed=await f.app.inject({method:'POST',url:`/staff/customer-experience/cues/${cues[1]!.id}/complete`,headers:{'idempotency-key':cueKey},payload:{note:'改了原完成说明'}})
    expect(changed.statusCode).toBe(409)
    await pool.query(`INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id)
      SELECT $1,$2,$3,id,'deny','test current withdrawal',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code IN ('service.execute','customer.experience.manage')`,[f.scope.tenantId,f.scope.storeId,f.employeeId])
    expect((await f.complete(cues[0]!.service_task_id,taskKey)).statusCode).toBe(403)
    expect((await request()).statusCode).toBe(403)
    expect((await pool.query("SELECT count(*)::int n FROM mbox.service_task_events WHERE tenant_id=$1 AND event_type='task.completed'",[f.id.tenant])).rows[0].n).toBe(2)
  })
  it('reads a persisted pre-change cue fingerprint without rewriting it and rejects its replay after permission withdrawal',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-old-receipt')
    const cue=(await f.rows())[0]!
    expect((await f.complete(cue.service_task_id)).statusCode).toBe(200)
    const input={cueId:String(cue.id),note:'旧版本已确认实际完成',idempotencyKey:randomUUID()}
    // Persist the pre-change stable-JSON fingerprint/envelope through the real
    // executor. The completion itself above is real, not a fabricated row.
    const originalFingerprint=createHash('sha256').update(JSON.stringify({cueId:input.cueId,idempotencyKey:input.idempotencyKey,note:input.note})).digest('hex')
    await commands.execute({scope:f.scope,operationScope:'customer.experience.cue.complete',idempotencyKey:input.idempotencyKey,requestFingerprint:originalFingerprint,
      resultCodec:{encode:value=>value,decode:value=>value as {cueId:string;status:'completed'}}},async()=>({result:{cueId:input.cueId,status:'completed' as const},auditEvents:[],outboxMessages:[]}))
    const receipt=async()=>(await pool.query("SELECT to_jsonb(receipt) fact FROM mbox.idempotency_records receipt WHERE tenant_id=$1 AND operation_scope='customer.experience.cue.complete' AND idempotency_key=$2",[f.id.tenant,input.idempotencyKey])).rows
    const before=await receipt()
    expect(await f.service.completeCue({scope:f.scope,employeeId:f.employeeId,businessDate:f.date},input)).toMatchObject({replayed:true,value:{cueId:input.cueId,status:'completed'}})
    expect(await receipt()).toEqual(before)
    await pool.query(`INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id)
      SELECT $1,$2,$3,id,'deny','old receipt current permission withdrawn',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='customer.experience.manage'`,[f.scope.tenantId,f.scope.storeId,f.employeeId])
    await expect(f.service.completeCue({scope:f.scope,employeeId:f.employeeId,businessDate:f.date},input)).rejects.toMatchObject({name:'StaffAccessDeniedError'})
    expect(await receipt()).toEqual(before)
  })
  it('serializes two final nodes and a real close request behind the same parent row, with one terminal audit/outbox',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-race')
    const cues=await f.rows();for(const cue of cues.slice(0,-2))expect((await f.complete(cue.service_task_id)).statusCode).toBe(200)
    const blocker=await pool.connect();const work:Promise<unknown>[]=[]
    let sampled=0
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM mbox.table_sessions WHERE id=$1 FOR UPDATE',[f.id.tableTabSession])
      const a=f.complete(cues.at(-2)!.service_task_id),b=f.complete(cues.at(-1)!.service_task_id),closing=close(f)
      work.push(a,b,closing)
      for(let attempt=0;attempt<80;attempt++){
        sampled=Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND application_name='experience-lifecycle-low-runtime' AND wait_event_type='Lock'")).rows[0].n)
        if(sampled>=3)break
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      expect(sampled).toBeGreaterThanOrEqual(3)
      await blocker.query('COMMIT')
      const result=await Promise.all([a,b,closing]);expect(result.slice(0,2).map(r=>r.statusCode)).toEqual([200,200]);expect([200,409]).toContain(result[2]!.statusCode)
      console.info(JSON.stringify({evidence:'two-final-cues-and-close-lock-wait',actualLowLoginLockWaiters:sampled}))
    }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(work)}
    expect((await f.rows()).every(row=>row.plan_state==='completed')).toBe(true)
    expect(await countPlanEvents(f)).toEqual({audits:1,outbox:1})
    await f.worker.runBatch(f.scope,'lifecycle-race-replay')
    expect(await countPlanEvents(f)).toEqual({audits:1,outbox:1})
  })
  it('skips a parent held by close/completion without taking child locks, then dispatches remaining due work',async()=>{
    const f=await fixture();await f.worker.runBatch(f.scope,'lifecycle-parent-first',1)
    const first=(await f.rows()).find(row=>row.service_task_id!==null)!
    const blocker=await pool.connect();let pending:ReturnType<typeof f.complete>|undefined
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM mbox.table_sessions WHERE id=$1 FOR UPDATE',[f.id.tableTabSession])
      pending=f.complete(first.service_task_id)
      let sampled=0;for(let attempt=0;attempt<80;attempt++){sampled=Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND application_name='experience-lifecycle-low-runtime' AND wait_event_type='Lock'")).rows[0].n);if(sampled>0)break;await new Promise(resolve=>setTimeout(resolve,20))}
      expect(sampled).toBeGreaterThan(0)
      expect((await f.worker.runBatch(f.scope,'lifecycle-parent-skip',1)).claimed).toBe(0)
      await blocker.query('COMMIT');expect((await pending).statusCode).toBe(200)
      console.info(JSON.stringify({evidence:'worker-parent-skip-during-completion',actualLowLoginLockWaiters:sampled}))
    }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending}
    expect((await f.worker.runBatch(f.scope,'lifecycle-parent-resume')).claimed).toBe(8)
    expect((await f.rows()).every(row=>row.plan_state==='active')).toBe(true)
  })

})
async function seed(pool:Pool,id:ReturnType<typeof newIds>){
  const suffix=id.tenant.replaceAll('-','').slice(0,12)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name)VALUES($1,$2,'Preference Plan Tenant')`,[id.tenant,`preference_plan_${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name)VALUES($1,$3,$4,'Preference Plan Store'),($2,$3,$5,'Other Store')`,[id.store,id.otherStore,id.tenant,`preference_store_${suffix}`,`preference_other_${suffix}`])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)VALUES
    ($1,$4,$5,$6,'偏好测试起草人'),($2,$4,$5,$7,'偏好测试审批人'),($3,$4,$5,$8,'偏好测试发布人')`,[
    id.policyDrafter,id.policyApprover,id.policyPublisher,id.tenant,id.store,
    `PREF_D_${suffix}`,`PREF_A_${suffix}`,`PREF_P_${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)VALUES($1,$2,$3,'preference-canonical-086','active')`,[id.canonical,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status,merged_into_customer_id)VALUES($1,$2,$3,'preference-merged-086','merged',$4)`,[id.merged,id.tenant,id.store,id.canonical])
  await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)VALUES($1,$2,$3,'PREF','偏好测试区','indoor')`,[id.area,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)VALUES($1,$3,$4,$5,'PT1','PT1',4),($2,$3,$4,$5,'PT2','PT2',4)`,[id.tableTabTable,id.paymentTable,id.tenant,id.store,id.area])
  await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status)VALUES($1,$3,$4,$5,'preference-table-tab-session','2026-08-16',2,'open'),($2,$3,$4,$6,'preference-payment-session','2026-08-16',2,'open')`,[id.tableTabSession,id.paymentSession,id.tenant,id.store,id.tableTabTable,id.paymentTable])
  await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor,recommendation_enabled,recommendation_beverage_family,recommendation_scene_tags,recommendation_priority)VALUES($1,$2,$3,'PREF_WINE','偏好红酒套餐','test','none','bundle',3000,true,'wine',ARRAY['friends']::text[],20)`,[id.product,id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)VALUES($1,$2,$3,'standard',8800,'CNY',clock_timestamp()-interval '1 day')`,[id.tenant,id.store,id.product])
  await pool.query(`INSERT INTO mbox.recommendation_policy_versions(
    id,tenant_id,store_id,public_id,policy_code,version,status,
    created_by_employee_id,approved_by_employee_id,published_by_employee_id,
    approved_at,published_at,effective_from,draft_reason,approval_reason,
    publication_reason,publication_mode,explanation_template
  )VALUES(
    $1,$2,$3,'preference-default-policy-086','DEFAULT',1,'published',
    $4,$5,$6,clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 minute',
    '偏好聚合测试规则起草','偏好衰减参数独立复核','第三人发布用于偏好聚合集成测试',
    'separated','偏好聚合测试'
  )`,[id.policy,id.tenant,id.store,id.policyDrafter,id.policyApprover,id.policyPublisher])
  await pool.query(`UPDATE mbox.customer_experience_features SET rollout_state='pilot',reason='仅偏好聚合集成测试开放'
    WHERE tenant_id=$1 AND store_id=$2 AND feature_code='recommendation.engine'`,[id.tenant,id.store])
  await pool.query(`INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level,service_intensity)VALUES($1,$3,$4,'recommendation-table-tab-086',$5,$6,'2026-08-16','guest_table',2,'friends','undecided','enhanced','balanced'),($2,$3,$4,'recommendation-payment-086',$5,$7,'2026-08-16','guest_table',2,'friends','undecided','enhanced','balanced')`,[id.tableTabRecommendation,id.paymentRecommendation,id.tenant,id.store,id.merged,id.tableTabSession,id.paymentSession])
  await pool.query(`INSERT INTO mbox.recommendation_options(id,tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)VALUES($1,$3,$4,$5,$7,$8,1,'enhanced',8800,3000,'CNY',100,'测试推荐'),($2,$3,$4,$6,$7,$8,1,'enhanced',8800,3000,'CNY',100,'测试推荐')`,[id.tableTabOption,id.paymentOption,id.tenant,id.store,id.tableTabRecommendation,id.paymentRecommendation,id.policy,id.product])
  await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,submitted_at,settlement_mode,fulfillment_state)VALUES($1,$3,$4,$5,'order-table-tab-086','guest_qr','submitted','unpaid',8800,0,8800,'CNY',$7,clock_timestamp(),'table_tab','active'),($2,$3,$4,$6,'order-payment-086','guest_qr','submitted','unpaid',8800,0,8800,'CNY',$7,clock_timestamp(),'immediate_payment','awaiting_payment')`,[id.tableTabOrder,id.paymentOrder,id.tenant,id.store,id.tableTabSession,id.paymentSession,id.merged])
  await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,discount_amount_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status,unit_cost_minor_at_submission,total_cost_minor_at_submission,cost_source,cost_reference_product_id,cost_reference_product_updated_at)VALUES($1,$3,$4,$5,$7,1,8800,0,8800,'CNY','none','{}','submitted',3000,3000,'catalog_product',$7,clock_timestamp()),($2,$3,$4,$6,$7,1,8800,0,8800,'CNY','none','{}','submitted',3000,3000,'catalog_product',$7,clock_timestamp())`,[id.tableTabItem,id.paymentItem,id.tenant,id.store,id.tableTabOrder,id.paymentOrder,id.product])
}
