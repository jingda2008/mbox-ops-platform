import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  CustomerExperienceRepository,
  type RecommendationAnswer,
  type TableExperienceContext,
} from './customer-experience-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const tenantId = randomUUID()
const storeId = randomUUID()
const otherStoreId = randomUUID()
const employeeId = randomUUID()
const recommendationApproverId = randomUUID()
const recommendationPublisherId = randomUUID()
const canonicalCustomerId = randomUUID()
const mergedCustomerId = randomUUID()
const areaId = randomUUID()
const tableId = randomUUID()
const tableSessionId = randomUUID()
const componentProductId = randomUUID()
const bundleProductId = randomUUID()
const performerId = randomUUID()
const scheduleId = randomUUID()
const fixtureSuffix = tenantId.replaceAll('-', '').slice(0, 12)

const answer: RecommendationAnswer = {
  partySize: 2,
  occasion: 'friends',
  alcoholPreference: 'mixed',
  experienceLevel: 'enhanced',
  serviceIntensity: 'balanced',
}

const context: TableExperienceContext = {
  customerId: mergedCustomerId,
  tableSessionId,
  partySize: 2,
  businessDate: '2026-08-16',
  actorRef: `guest:${mergedCustomerId}`,
}

integration('customer product restriction and performance phase PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await seed(pool)
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('uses only explicit customer choices as a canonical-family hard exclusion', async () => {
    const unrestricted = await recommend('restriction-initial')
    expect(unrestricted.recommendations.map((item) => item.productId)).toContain(bundleProductId)

    await run((repository) => repository.configureProductPerformancePhases({
      productId: bundleProductId,
      phaseCodes: ['band_live'],
      employeeId,
      reason: '仅在乐队现场推荐此套餐',
    }))
    expect(await run((repository) => repository.productPerformancePhases(bundleProductId)))
      .toEqual({ productId: bundleProductId, phaseCodes: ['band_live'] })
    expect((await recommend('restriction-no-reliable-phase')).recommendations).toEqual([])

    const acoustic = await run((repository) => repository.startPerformancePhase({
      publicId: 'performance-phase-acoustic-test',
      scheduleId,
      phaseCode: 'acoustic',
      employeeId,
      reason: '现场确认进入不插电阶段',
    }))
    expect((await recommend('restriction-wrong-phase')).recommendations).toEqual([])
    await run((repository) => repository.transitionPerformancePhase({
      publicId: acoustic.publicId,
      action: 'end',
      employeeId,
      reason: '不插电阶段已经结束',
    }))

    const live = await run((repository) => repository.startPerformancePhase({
      publicId: 'performance-phase-band-live-test',
      scheduleId,
      phaseCode: 'band_live',
      employeeId,
      reason: '现场确认进入乐队演出阶段',
    }))
    const matched = await recommend('restriction-matching-phase')
    const recommended = matched.recommendations.find((item) => item.productId === bundleProductId)
    expect(recommended).toBeDefined()
    const score = await pool.query<{ performance_contribution: number; inventory_contribution: number; capacity_contribution: number }>(`
      SELECT option.performance_contribution,option.inventory_contribution,option.capacity_contribution
      FROM mbox.recommendation_options option
      JOIN mbox.recommendation_sessions session
        ON session.tenant_id=option.tenant_id AND session.store_id=option.store_id
       AND session.id=option.recommendation_session_id
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.public_id='restriction-matching-phase' AND option.product_id=$3::uuid
    `,[tenantId,storeId,bundleProductId])
    expect(score.rows[0]).toEqual({
      performance_contribution:100,inventory_contribution:0,capacity_contribution:0,
    })

    const ordinary = await run((repository) => repository.recordRecommendationBehavior({
      recommendationPublicId: matched.publicId,
      restrictionPublicId: 'product-restriction-not-now-test',
      customerId: mergedCustomerId,
      tableSessionId,
      eventType: 'rejected',
      productId: bundleProductId,
      actorRef: context.actorRef,
      reasonCode: 'not_now',
      evidence: { surface: 'test' },
    }))
    expect(ordinary.restriction).toBeNull()
    expect(await run((repository) => repository.customerProductRestrictions(canonicalCustomerId))).toEqual([])

    const explicit = await run((repository) => repository.recordRecommendationBehavior({
      recommendationPublicId: matched.publicId,
      restrictionPublicId: 'product-restriction-allergy-test',
      customerId: mergedCustomerId,
      tableSessionId,
      eventType: 'rejected',
      productId: bundleProductId,
      actorRef: context.actorRef,
      reasonCode: 'allergy_or_cannot_consume',
      evidence: { surface: 'test', freeText: 'display evidence is not authoritative' },
    }))
    expect(explicit.restriction).toMatchObject({
      publicId: 'product-restriction-allergy-test',
      productId: bundleProductId,
      restrictionType: 'allergy_or_cannot_consume',
    })
    expect(await run((repository) => repository.customerProductRestrictions(canonicalCustomerId)))
      .toEqual([expect.objectContaining({ publicId: 'product-restriction-allergy-test' })])
    const revised = await run((repository) => repository.recordRecommendationBehavior({
      recommendationPublicId: matched.publicId,
      restrictionPublicId: 'product-restriction-dislike-later-test',
      customerId: mergedCustomerId,
      tableSessionId,
      eventType: 'rejected',
      productId: bundleProductId,
      actorRef: context.actorRef,
      reasonCode: 'dislike',
      evidence: { surface: 'test', action: 'explicit_reason_revision' },
    }))
    expect(revised.restriction).toMatchObject({
      publicId: 'product-restriction-allergy-test', restrictionType: 'dislike',
    })
    expect(await run((repository) => repository.customerProductRestrictions(canonicalCustomerId)))
      .toEqual([expect.objectContaining({ restrictionType: 'dislike' })])
    expect((await recommend('restriction-family-excluded')).recommendations).toEqual([])

    await run((repository) => repository.withdrawCustomerProductRestriction({
      publicId: 'product-restriction-allergy-test',
      customerId: canonicalCustomerId,
      reason: '顾客本人确认恢复该商品推荐',
    }))
    expect(await run((repository) => repository.customerProductRestrictions(mergedCustomerId))).toEqual([])
    expect((await recommend('restriction-withdrawn')).recommendations.map((item) => item.productId))
      .toContain(bundleProductId)

    await run((repository) => repository.transitionPerformancePhase({
      publicId: live.publicId,
      action: 'end',
      employeeId,
      reason: '乐队现场阶段已经结束',
    }))
    expect((await recommend('restriction-ended-phase')).recommendations).toEqual([])
  })

  it('serializes concurrent phase starts and exposes one authoritative active phase', async () => {
    const attempts = await Promise.allSettled([
      run((repository) => repository.startPerformancePhase({
        publicId: 'performance-phase-concurrent-one', scheduleId, phaseCode: 'band_live', employeeId,
        reason: '并发现场确认一',
      })),
      run((repository) => repository.startPerformancePhase({
        publicId: 'performance-phase-concurrent-two', scheduleId, phaseCode: 'intermission', employeeId,
        reason: '并发现场确认二',
      })),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = attempts.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null)
      .toMatchObject({ code: 'PERFORMANCE_PHASE_ALREADY_ACTIVE', statusCode: 409 })
    const current = await run((repository) => repository.currentPerformancePhaseEvents())
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ scheduleId, status: 'active' })
  })

  it('keeps authority in strong columns and enforces tenant-store RLS for runtime reads', async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name,column_name,data_type
      FROM information_schema.columns
      WHERE table_schema='mbox' AND table_name IN (
        'customer_product_restrictions',
        'product_performance_phase_eligibilities',
        'schedule_performance_phase_events'
      )
      ORDER BY table_name,ordinal_position
    `)
    expect(columns.rows.some((column) => column.data_type === 'json' || column.data_type === 'jsonb')).toBe(false)
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: 'customer_product_restrictions', column_name: 'restriction_type' }),
      expect.objectContaining({ table_name: 'product_performance_phase_eligibilities', column_name: 'phase_code' }),
      expect.objectContaining({ table_name: 'schedule_performance_phase_events', column_name: 'status' }),
    ]))

    const ownCount = await runtimeCount(storeId)
    const otherStoreCount = await runtimeCount(otherStoreId)
    expect(ownCount).toBe(1)
    expect(otherStoreCount).toBe(0)
  })

  async function recommend(publicId: string) {
    return run((repository) => repository.createRecommendationSession({ context, answers: answer, publicId }))
  }

  async function run<Result>(operation: (repository: CustomerExperienceRepository) => Promise<Result>) {
    return runner.run({ tenantId, storeId }, (transaction) => operation(new CustomerExperienceRepository(transaction)))
  }

  async function runtimeCount(scopedStoreId: string): Promise<number> {
    return runner.run({ tenantId, storeId: scopedStoreId }, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      const result = await transaction.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM mbox.customer_product_restrictions
      `)
      return Number(result.rows[0]?.count ?? -1)
    }, { readOnly: true })
  }
})

async function seed(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO mbox.tenants(id,code,name)
    VALUES ($1::uuid,$2,'Restriction Phase Tenant')
  `, [tenantId, `restriction_phase_${fixtureSuffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
      ($1::uuid,$3::uuid,$4,'Restriction Phase Store'),
      ($2::uuid,$3::uuid,$5,'Restriction Phase Other Store')
  `, [storeId, otherStoreId, tenantId, `restriction_store_${fixtureSuffix}`, `restriction_other_${fixtureSuffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
      ($1::uuid,$4::uuid,$5::uuid,'PHASE_MANAGER','舞台负责人'),
      ($2::uuid,$4::uuid,$5::uuid,'REC_APPROVER','推荐规则审批人'),
      ($3::uuid,$4::uuid,$5::uuid,'REC_PUBLISHER','推荐规则发布人')
  `, [employeeId, recommendationApproverId, recommendationPublisherId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'restriction-canonical-customer','active')
  `, [canonicalCustomerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.customers(
      id,tenant_id,store_id,public_id,status,merged_into_customer_id
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'restriction-merged-customer','merged',$4::uuid
    )
  `, [mergedCustomerId, tenantId, storeId, canonicalCustomerId])
  await pool.query(`
    INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'PHASE','演出区','indoor')
  `, [areaId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'P1','P1',4)
  `, [tableId, tenantId, storeId, areaId])
  await pool.query(`
    INSERT INTO mbox.table_sessions(
      id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status
    ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'restriction-phase-session','2026-08-16',2,'open')
  `, [tableSessionId, tenantId, storeId, tableId])
  await pool.query(`
    INSERT INTO mbox.table_session_customers(
      tenant_id,store_id,table_session_id,customer_id,relationship
    ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'primary')
  `, [tenantId, storeId, tableSessionId, mergedCustomerId])
  await pool.query(`
    INSERT INTO mbox.performers(id,tenant_id,store_id,code,stage_name)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'PHASE_BAND','测试乐队')
  `, [performerId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.schedules(
      id,tenant_id,store_id,performer_id,starts_at,ends_at,status
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,
      clock_timestamp()-interval '30 minutes',clock_timestamp()+interval '90 minutes','performing'
    )
  `, [scheduleId, tenantId, storeId, performerId])
  await pool.query(`
    INSERT INTO mbox.products(
      id,tenant_id,store_id,code,name,category_code,fulfillment_station,
      product_kind,cost_amount_minor,recommendation_enabled,
      recommendation_beverage_family,recommendation_scene_tags,recommendation_priority
    ) VALUES
      ($1::uuid,$3::uuid,$4::uuid,'PHASE_COMPONENT','套餐组件','test','none',
        'single',1000,false,'none','{}'::text[],100),
      ($2::uuid,$3::uuid,$4::uuid,'PHASE_BUNDLE','演出阶段套餐','test','none',
        'bundle',3000,true,'mixed',ARRAY['friends']::text[],20)
  `, [componentProductId, bundleProductId, tenantId, storeId])
  await pool.query(`
    INSERT INTO mbox.product_prices(
      tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from
    ) VALUES
      ($1::uuid,$2::uuid,$3::uuid,'standard',2500,'CNY',clock_timestamp()-interval '1 day'),
      ($1::uuid,$2::uuid,$4::uuid,'standard',6800,'CNY',clock_timestamp()-interval '1 day')
  `, [tenantId, storeId, componentProductId, bundleProductId])
  await pool.query(`
    INSERT INTO mbox.product_bundle_components(
      tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order
    ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,1)
  `, [tenantId, storeId, bundleProductId, componentProductId])
  await pool.query(`
    INSERT INTO mbox.recommendation_policy_versions(
      tenant_id,store_id,public_id,policy_code,version,status,
      created_by_employee_id,approved_by_employee_id,published_by_employee_id,
      approved_at,published_at,effective_from,draft_reason,approval_reason,
      publication_reason,publication_mode,explanation_template,performance_weight
    ) VALUES (
      $1::uuid,$2::uuid,'restriction-phase-default-policy','DEFAULT',1,'published',
      $3::uuid,$4::uuid,$5::uuid,clock_timestamp(),clock_timestamp(),
      clock_timestamp()-interval '1 minute','强类型限制与现场阶段测试起草',
      '独立复核限制与阶段配置','第三人发布用于受控集成测试','separated',
      '强类型限制与现场阶段测试',100
    )
  `, [tenantId, storeId, employeeId, recommendationApproverId, recommendationPublisherId])
  await pool.query(`UPDATE mbox.customer_experience_features
    SET rollout_state='pilot',reason='仅在强类型限制与现场阶段集成测试中开放'
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND feature_code='recommendation.engine'`,[tenantId,storeId])
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
