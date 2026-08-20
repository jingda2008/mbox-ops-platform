import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const id={
  tenant:randomUUID(),store:randomUUID(),manager:randomUUID(),ops:randomUUID(),owner:randomUUID(),
  managerRole:randomUUID(),opsRole:randomUUID(),ownerRole:randomUUID(),
} as const
const scope={tenantId:id.tenant,storeId:id.store}

integration('recommendation policy operational release PostgreSQL authority',()=>{
  let pool:Pool
  let runner:ScopedPostgresTransactionRunner

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:6})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
  })
  afterAll(async()=>pool?.end())

  it('assigns the minimum default roles and keeps recommendation closed before managed publication',async()=>{
    const assigned=await pool.query(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission ON permission.id=assignment.permission_id
      WHERE assignment.tenant_id=$1 AND assignment.store_id=$2
        AND permission.code LIKE 'recommendation.rule.%'
      ORDER BY role.code,permission.code
    `,[id.tenant,id.store])
    expect(assigned.rows).toEqual([
      {role_code:'MANAGER',permission_code:'recommendation.rule.draft'},
      {role_code:'MANAGER',permission_code:'recommendation.rule.view'},
      {role_code:'OPS_LEAD',permission_code:'recommendation.rule.approve'},
      {role_code:'OPS_LEAD',permission_code:'recommendation.rule.view'},
      {role_code:'OWNER',permission_code:'recommendation.rule.publish'},
      {role_code:'OWNER',permission_code:'recommendation.rule.view'},
    ])
    await expect(pool.query(`UPDATE mbox.customer_experience_features
      SET rollout_state='pilot',reason='没有受控规则时不得开放'
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='recommendation.engine'`,[id.tenant,id.store]))
      .rejects.toThrow(/current managed three-person policy/)
  })

  it('requires three employees, freezes approved facts and separates publication from rollout',async()=>{
    const first=await createDraft('recommendation-policy-managed-v1',id.manager,'第一版经营参数影子验证')
    await expect(run((repository)=>repository.approveRecommendationPolicy(first.publicId,id.manager,'起草人不能自批')))
      .rejects.toMatchObject({code:'RECOMMENDATION_POLICY_APPROVAL_DENIED'})
    await run((repository)=>repository.approveRecommendationPolicy(first.publicId,id.ops,'偏好衰减、毛利底线和解释文案已复核'))
    await expect(pool.query(`UPDATE mbox.recommendation_policy_versions SET margin_weight=999
      WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3`,[id.tenant,id.store,first.publicId]))
      .rejects.toThrow(/recommendation policy facts are immutable/)
    const effectiveFrom=new Date(Date.now()-1_000).toISOString()
    await expect(run((repository)=>repository.publishRecommendationPolicy({
      publicId:first.publicId,employeeId:id.ops,effectiveFrom,reason:'审批人不能兼任发布人',
    }))).rejects.toMatchObject({code:'RECOMMENDATION_POLICY_PUBLISHER_NOT_INDEPENDENT'})
    await run((repository)=>repository.publishRecommendationPolicy({
      publicId:first.publicId,employeeId:id.owner,effectiveFrom,reason:'第三人确认首版进入可选试点',
    }))
    const beforeOpen=await configuration()
    expect(beforeOpen.feature.rolloutState).toBe('disabled')
    expect(beforeOpen.policies[0]).toMatchObject({
      publicId:first.publicId,status:'published',publicationMode:'separated',
      createdBy:'Manager',approvedBy:'Ops',publishedBy:'Owner',
    })
    await pool.query(`UPDATE mbox.customer_experience_features
      SET rollout_state='pilot',reason='经营参数已三人复核，限定影子样本门店试点'
      WHERE tenant_id=$1 AND store_id=$2 AND feature_code='recommendation.engine'`,[id.tenant,id.store])
    expect((await configuration()).feature.rolloutState).toBe('pilot')
  })

  it('schedules exact future cut-over without a gap and rejects a concurrent overlapping release',async()=>{
    const second=await createDraft('recommendation-policy-managed-v2',id.manager,'第二版未来排期')
    await run((repository)=>repository.approveRecommendationPolicy(second.publicId,id.ops,'第二版参数独立复核'))
    const third=await createDraft('recommendation-policy-managed-v3',id.manager,'并发重叠反测试')
    await run((repository)=>repository.approveRecommendationPolicy(third.publicId,id.ops,'第三版参数独立复核'))
    const replacementStart=new Date(Date.now()+3_600_000).toISOString()
    const results=await Promise.allSettled([
      run((repository)=>repository.publishRecommendationPolicy({
        publicId:second.publicId,employeeId:id.owner,effectiveFrom:replacementStart,reason:'第二版准确接替首版',
      })),
      run((repository)=>repository.publishRecommendationPolicy({
        publicId:third.publicId,employeeId:id.owner,effectiveFrom:replacementStart,reason:'相同时间的重叠版本应被拒绝',
      })),
    ])
    expect(results.filter((result)=>result.status==='fulfilled')).toHaveLength(1)
    expect(results.filter((result)=>result.status==='rejected')).toHaveLength(1)
    const windows=await pool.query(`SELECT version,effective_from::text,effective_until::text
      FROM mbox.recommendation_policy_versions
      WHERE tenant_id=$1 AND store_id=$2 AND status='published'
      ORDER BY effective_from,version`,[id.tenant,id.store])
    expect(windows.rows).toHaveLength(2)
    expect(Date.parse(windows.rows[0]?.effective_until)).toBe(Date.parse(replacementStart))
    expect(Date.parse(windows.rows[1]?.effective_from)).toBe(Date.parse(replacementStart))
  })

  it('clones a historical version into a new draft without mutating the source',async()=>{
    const source=(await configuration()).policies.find((policy)=>policy.status==='published')
    expect(source).toBeDefined()
    const cloned=await run((repository)=>repository.cloneRecommendationPolicyDraft({
      sourcePublicId:source!.publicId,publicId:'recommendation-policy-cloned-draft',
      employeeId:id.manager,draftReason:'从已验证版本建立回退草稿',
    }))
    expect(cloned).toMatchObject({status:'draft',code:'DEFAULT'})
    const latest=await configuration()
    expect(latest.policies.find((policy)=>policy.publicId===source!.publicId)?.status).toBe('published')
    expect(latest.policies.find((policy)=>policy.publicId===cloned.publicId)).toMatchObject({
      status:'draft',draftReason:'从已验证版本建立回退草稿',createdBy:'Manager',
    })
  })

  async function createDraft(publicId:string,employeeId:string,draftReason:string){
    return run((repository)=>repository.createRecommendationPolicy({
      publicId,code:'DEFAULT',employeeId,preferenceWeight:100,sceneWeight:60,
      marginWeight:50,priorityWeight:50,performanceWeight:0,inventoryWeight:0,capacityWeight:0,
      minimumGrossMarginBasisPoints:1500,preferenceHalfLifeDays:90,preferenceMaxAgeDays:730,
      preferenceMinEffectiveScore:1000,preferenceMinConfidenceBasisPoints:2500,
      explanationTemplate:'按人数、场景、明确偏好与当前可售状态提供建议',displayConfiguration:{},draftReason,
    }))
  }
  function configuration(){return run((repository)=>repository.recommendationPolicyConfiguration())}
  function run<Value>(operation:(repository:CustomerExperienceRepository)=>Promise<Value>){
    return runner.run(scope,(transaction)=>operation(new CustomerExperienceRepository(transaction)))
  }
})

async function seed(pool:Pool){
  const suffix=id.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Recommendation Tenant')`,[id.tenant,`rec-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Recommendation Store')`,[id.store,id.tenant,`rec-${suffix}`])
  await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES
    ($1,$4,$5,'MANAGER','Manager'),($2,$4,$5,'OPS_LEAD','Ops'),($3,$4,$5,'OWNER','Owner')`,[
    id.managerRole,id.opsRole,id.ownerRole,id.tenant,id.store,
  ])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
    ($1,$4,$5,$6,'Manager','active'),($2,$4,$5,$7,'Ops','active'),($3,$4,$5,$8,'Owner','active')`,[
    id.manager,id.ops,id.owner,id.tenant,id.store,`RM-${suffix}`,`RO-${suffix}`,`RW-${suffix}`,
  ])
}
