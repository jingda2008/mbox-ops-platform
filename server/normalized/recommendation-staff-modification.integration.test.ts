import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { RecommendationStaffModificationRepository } from './recommendation-staff-modification-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip

integration('recommendation staff modification PostgreSQL authority',()=>{
  const tenantId=randomUUID();const storeId=randomUUID();const otherStoreId=randomUUID()
  const employeeId=randomUUID();const unassignedEmployeeId=randomUUID()
  const approverId=randomUUID();const publisherId=randomUUID();const roleId=randomUUID()
  const areaId=randomUUID();const tableId=randomUUID();const tableSessionId=randomUUID();const customerId=randomUUID()
  const policyId=randomUUID();const recommendationId=randomUUID();const sourceProductId=randomUUID();const targetProductId=randomUUID()
  const recommendationPublicId=`staff-modification-${recommendationId}`
  let pool:Pool;let runner:ScopedPostgresTransactionRunner

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({ connectionString:databaseUrl,max:4 })
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed()
  },30_000)
  afterAll(async()=>{ await pool?.end() })

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

  async function run<Result>(operation:(repository:RecommendationStaffModificationRepository)=>Promise<Result>) {
    return runner.run({ tenantId,storeId },(transaction)=>operation(new RecommendationStaffModificationRepository(transaction)))
  }
  async function runtimeCount(scopedStoreId:string) {
    return runner.run({ tenantId,storeId:scopedStoreId },async(transaction)=>{
      await transaction.query('SET LOCAL ROLE mbox_runtime')
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
  }
})
