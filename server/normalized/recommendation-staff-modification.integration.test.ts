import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify from 'fastify'
import {NormalizedCommandExecutor} from './command-executor.js'
import {RecommendationStaffModificationService} from './recommendation-staff-modification-service.js'
import {recommendationStaffModificationApiPlugin} from './recommendation-staff-modification-api.js'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { RecommendationStaffModificationRepository } from './recommendation-staff-modification-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeDatabaseUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl&&runtimeDatabaseUrl?describe:describe.skip

integration('recommendation staff modification PostgreSQL authority',()=>{
  const tenantId=randomUUID();const storeId=randomUUID();const otherStoreId=randomUUID()
  const employeeId=randomUUID();const unassignedEmployeeId=randomUUID()
  const approverId=randomUUID();const publisherId=randomUUID();const roleId=randomUUID()
  const areaId=randomUUID();const tableId=randomUUID();const tableSessionId=randomUUID();const customerId=randomUUID()
  const policyId=randomUUID();const recommendationId=randomUUID();const sourceProductId=randomUUID();const targetProductId=randomUUID()
  const recommendationPublicId=`staff-modification-${recommendationId}`
  const wrongRecommendationId=randomUUID(),wrongCandidateProductId=randomUUID()
  let pool:Pool;let runtimePool:Pool;let runner:ScopedPostgresTransactionRunner;let app:ReturnType<typeof Fastify>;let originalOptions:unknown[]

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({ connectionString:databaseUrl,max:4 })
    runtimePool=new Pool({connectionString:runtimeDatabaseUrl,max:8,application_name:'staff-modification-low-login'})
    expect((await runtimePool.query(`SELECT current_user=session_user direct_login,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
      has_any_column_privilege(current_user,'mbox.recommendation_options','UPDATE') can_update,
      has_table_privilege(current_user,'mbox.recommendation_options','DELETE') can_delete FROM pg_roles WHERE rolname=current_user`)).rows[0]).toEqual({direct_login:true,rolcanlogin:true,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,can_update:false,can_delete:false})
    runner=new ScopedPostgresTransactionRunner(runtimePool as unknown as PostgresPool)
    await seed()
    originalOptions=(await pool.query('SELECT to_jsonb(option) fact FROM mbox.recommendation_options option WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows
    await pool.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,employeeId,roleId])
    await pool.query("INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='recommendation.staff.modify' ON CONFLICT DO NOTHING",[tenantId,storeId,roleId])
    const service=new RecommendationStaffModificationService(runner,new NormalizedCommandExecutor(runner))
    app=Fastify()
    await app.register(recommendationStaffModificationApiPlugin,{service,resolveStaffContext:()=>({scope:{tenantId,storeId},employeeId,businessDate:new Date().toISOString().slice(0,10)})})
  },30_000)
  afterAll(async()=>{ await app?.close();await runtimePool?.end();await pool?.end() })

  it('records one strongly linked modification and rejects an idempotency-key replay outside the command journal',async()=>{
    const view=await run((repository)=>repository.latestForTable(tableSessionId,employeeId,false))
    expect(view?.options.map((option)=>option.productId)).toEqual([sourceProductId,targetProductId])
    const input={
      recommendationPublicId,sourceProductId,targetProductId,reasonCode:'customer_request' as const,
      employeeId,allowAllTables:false,idempotencyKey:'staff-modification-pg-test',requestSha256:'a'.repeat(64),
    }
    const created=await run((repository)=>repository.record(input))
    expect(created).toMatchObject({ sourceProductId,targetProductId,employeeId,reasonCode:'customer_request' })
    await expect(run((repository)=>repository.record(input))).rejects.toMatchObject({ code:'23505' })
    const stored=await pool.query(`
      SELECT actor_employee_id,source_recommendation_option_id,recommendation_option_id,
        staff_modification_reason_code,evidence_snapshot
      FROM mbox.recommendation_behavior_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `,[tenantId,storeId,created.eventId])
    expect(stored.rows[0]).toMatchObject({
      actor_employee_id:employeeId,staff_modification_reason_code:'customer_request',evidence_snapshot:{},
    })
    expect(stored.rows[0].source_recommendation_option_id).not.toBe(stored.rows[0].recommendation_option_id)
  })

  it('rejects direct writes by an employee outside the current table assignment',async()=>{
    await expect(run((repository)=>repository.record({
      recommendationPublicId,sourceProductId,targetProductId,reasonCode:'staff_judgement',
      employeeId:unassignedEmployeeId,allowAllTables:false,
      idempotencyKey:'staff-modification-cross-table',requestSha256:'b'.repeat(64),
    }))).rejects.toMatchObject({ code:'RECOMMENDATION_TABLE_SCOPE_DENIED',statusCode:403 })
    const count=await pool.query<{count:string}>(`
      SELECT count(*)::text AS count FROM mbox.recommendation_behavior_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND staff_modification_idempotency_key='staff-modification-cross-table'
    `,[tenantId,storeId])
    expect(Number(count.rows[0]?.count)).toBe(0)
  })

  it('keeps runtime reads tenant-store isolated',async()=>{
    const own=await runtimeCount(storeId)
    const other=await runtimeCount(otherStoreId)
    expect(own).toBe(1)
    expect(other).toBe(0)
  })

  const modify=(key:string,body:Record<string,unknown>={sourceProductId,targetProductId,reasonCode:'customer_request'})=>app.inject({method:'POST',url:`/staff/customer-experience/recommendations/${recommendationPublicId}/modifications`,headers:{'idempotency-key':key},payload:body})
  it('concurrent same-key HTTP requests append one event/audit and reject changed candidates under the original key',async()=>{
    const key=randomUUID(),barrier=await pool.connect();let requests:Array<ReturnType<typeof modify>>=[]
    try{
      await barrier.query('BEGIN');await barrier.query('SELECT id FROM mbox.table_sessions WHERE id=$1 FOR UPDATE',[tableSessionId])
      requests=[modify(key),modify(key)]
      let waiters=0;for(let attempt=0;attempt<80;attempt++){waiters=Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND application_name='staff-modification-low-login' AND wait_event_type='Lock'")).rows[0].n);if(waiters>=2)break;await new Promise(resolve=>setTimeout(resolve,20))}
      expect(waiters).toBeGreaterThanOrEqual(2)
      await barrier.query('COMMIT')
      const responses=await Promise.all(requests);expect(responses.map(response=>response.statusCode).sort()).toEqual([200,201])
      expect(responses[0]!.json().data).toEqual(responses[1]!.json().data)
      expect((await modify(key,{sourceProductId,targetProductId:sourceProductId,reasonCode:'customer_request'})).statusCode).toBe(409)
      const counts=(await pool.query(`SELECT
        (SELECT count(*)::int FROM mbox.recommendation_behavior_events WHERE tenant_id=$1 AND staff_modification_idempotency_key=$2) events,
        (SELECT count(*)::int FROM mbox.audit_events WHERE tenant_id=$1 AND action='customer.experience.recommendation.staff_modified') audits`,[tenantId,key])).rows[0]
      expect(counts).toEqual({events:1,audits:1})
      console.info(JSON.stringify({evidence:'staff-modification-same-key-lock-wait',lowLoginLockWaiters:waiters}))
    }finally{await barrier.query('ROLLBACK');barrier.release();await Promise.allSettled(requests)}
  })
  it('requires current modification permission before replaying an already successful HTTP request',async()=>{
    const key=randomUUID(),first=await modify(key);expect(first.statusCode,first.body).toBe(201)
    await pool.query(`INSERT INTO mbox.employee_permission_overrides(tenant_id,store_id,employee_id,permission_id,effect,reason,configured_by_employee_id)
      SELECT $1,$2,$3,id,'deny','test current modification withdrawal',$3 FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='recommendation.staff.modify'`,[tenantId,storeId,employeeId])
    try{const replay=await modify(key);expect(replay.statusCode,replay.body).toBe(403)}finally{await pool.query('DELETE FROM mbox.employee_permission_overrides WHERE tenant_id=$1 AND store_id=$2 AND employee_id=$3',[tenantId,storeId,employeeId])}
    expect((await modify(key)).json().meta.replayed).toBe(true)
  })
  it('rejects a missing candidate and another store without appending behavior or changing original options',async()=>{
    const behaviorCount=async()=>Number((await pool.query('SELECT count(*) n FROM mbox.recommendation_behavior_events WHERE tenant_id=$1',[tenantId])).rows[0].n)
    const beforeCount=await behaviorCount()
    for(const target of [randomUUID(),wrongCandidateProductId]){
      const invalid=await modify(randomUUID(),{sourceProductId,targetProductId:target,reasonCode:'staff_judgement'})
      expect(invalid.statusCode,invalid.body).toBe(409)
    }
    await expect(runner.run({tenantId,storeId:otherStoreId},tx=>new RecommendationStaffModificationRepository(tx).record({recommendationPublicId,sourceProductId,targetProductId,reasonCode:'customer_request',employeeId,allowAllTables:true,idempotencyKey:randomUUID(),requestSha256:'c'.repeat(64)}))).rejects.toMatchObject({code:'RECOMMENDATION_STAFF_MODIFICATION_INVALID'})
    for(const sql of ["UPDATE mbox.recommendation_options SET amount_minor=amount_minor+1 WHERE tenant_id=$1",'DELETE FROM mbox.recommendation_options WHERE tenant_id=$1'])await expect(runner.run({tenantId,storeId},tx=>tx.query(sql,[tenantId]))).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT to_jsonb(option) fact FROM mbox.recommendation_options option WHERE tenant_id=$1 ORDER BY id',[tenantId])).rows).toEqual(originalOptions)
    expect(await behaviorCount()).toBe(beforeCount)
  })

  async function run<Result>(operation:(repository:RecommendationStaffModificationRepository)=>Promise<Result>) {
    return runner.run({ tenantId,storeId },(transaction)=>operation(new RecommendationStaffModificationRepository(transaction)))
  }
  async function runtimeCount(scopedStoreId:string) {
    return runner.run({ tenantId,storeId:scopedStoreId },async(transaction)=>{
      const result=await transaction.query<{count:string}>('SELECT count(*)::text AS count FROM mbox.recommendation_behavior_events WHERE event_type=\'staff_modified\'')
      return Number(result.rows[0]?.count??-1)
    },{ readOnly:true })
  }

  async function seed(){
    const suffix=tenantId.replaceAll('-','').slice(0,10)
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$2,'Staff Modification Tenant')`,[tenantId,`staff_mod_${suffix}`])
    await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
      ($1::uuid,$3::uuid,$4,'Staff Modification Store'),($2::uuid,$3::uuid,$5,'Other Store')`,
    [storeId,otherStoreId,tenantId,`staff_mod_${suffix}`,`staff_mod_other_${suffix}`])
    await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1::uuid,$5::uuid,$6::uuid,'SERVER_ONE','服务员工'),
      ($2::uuid,$5::uuid,$6::uuid,'SERVER_TWO','未分配员工'),
      ($3::uuid,$5::uuid,$6::uuid,'APPROVER','审批人'),
      ($4::uuid,$5::uuid,$6::uuid,'PUBLISHER','发布人')`,
    [employeeId,unassignedEmployeeId,approverId,publisherId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1::uuid,$2::uuid,$3::uuid,'SERVER_TEST','服务角色')`,[roleId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1::uuid,$2::uuid,$3::uuid,'STAFF','员工测试区','indoor')`,[areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'S1','S1',4)`,[tableId,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,current_date,2,'open')`,[tableSessionId,tenantId,storeId,tableId,`table-session-${suffix}`])
    await pool.query(`INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,created_by_employee_id,reason) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'primary',clock_timestamp()-interval '1 minute',$4::uuid,'本桌主责')`,[tenantId,storeId,tableId,employeeId,roleId])
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'active')`,[customerId,tenantId,storeId,`customer-${suffix}`])
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor) VALUES
      ($1::uuid,$3::uuid,$4::uuid,'STAFF_SOURCE','原推荐','test','none','bundle',1000),
      ($2::uuid,$3::uuid,$4::uuid,'STAFF_TARGET','调整推荐','test','none','bundle',1200)`,[sourceProductId,targetProductId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.recommendation_policy_versions(
      id,tenant_id,store_id,public_id,policy_code,version,status,
      created_by_employee_id,approved_by_employee_id,published_by_employee_id,
      approved_at,published_at,effective_from,draft_reason,approval_reason,publication_reason,
      publication_mode,explanation_template
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,'STAFF_TEST',1,'published',$5::uuid,$6::uuid,$7::uuid,
      clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 minute','起草','复核','发布','separated','员工调整测试')`,
    [policyId,tenantId,storeId,`policy-${suffix}`,employeeId,approverId,publisherId])
    await pool.query(`INSERT INTO mbox.recommendation_sessions(
      id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,
      party_size,occasion,alcohol_preference,experience_level,service_intensity
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,current_date,'guest_table',2,'friends','mixed','enhanced','balanced')`,
    [recommendationId,tenantId,storeId,recommendationPublicId,customerId,tableSessionId])
    await pool.query(`INSERT INTO mbox.recommendation_options(
      tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,
      amount_minor,cost_amount_minor,currency,total_score,explanation
    ) VALUES
      ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1,'comfortable',6800,1000,'CNY',100,'原推荐'),
      ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$6::uuid,2,'enhanced',8800,1200,'CNY',90,'调整推荐')`,
    [tenantId,storeId,recommendationId,policyId,sourceProductId,targetProductId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind) VALUES($1,$2,$3,'OTHER_CANDIDATE','另一真实推荐候选','test','none','bundle')",[wrongCandidateProductId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.recommendation_sessions(id,tenant_id,store_id,public_id,customer_id,table_session_id,business_date,source,party_size,occasion,alcohol_preference,experience_level,service_intensity,created_at)
      VALUES($1,$2,$3,$4,$5,$6,current_date,'guest_table',2,'friends','mixed','enhanced','balanced',clock_timestamp()-interval '1 minute')`,[wrongRecommendationId,tenantId,storeId,`other-${wrongRecommendationId}`,customerId,tableSessionId])
    await pool.query(`INSERT INTO mbox.recommendation_options(tenant_id,store_id,recommendation_session_id,policy_version_id,product_id,rank,tier,amount_minor,cost_amount_minor,currency,total_score,explanation)
      VALUES($1,$2,$3,$4,$5,1,'enhanced',9900,1000,'CNY',80,'不同推荐的真实候选')`,[tenantId,storeId,wrongRecommendationId,policyId,wrongCandidateProductId])
  }
})
