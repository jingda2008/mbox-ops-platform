import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { CustomerExperienceService } from './customer-experience-service.js'
import { LoyaltyRedemptionError, LoyaltyRedemptionRepository } from './loyalty-redemption-repository.js'
import { LoyaltyRedemptionRecoveryWorker } from './loyalty-redemption-recovery-worker.js'
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import { MembershipConfigurationDraftService } from './membership-configuration-draft-service.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

const id = Object.freeze({
  tenant: randomUUID(), store: randomUUID(), employeeA: randomUUID(), employeeB: randomUUID(),
  employeeC: randomUUID(),
  area: randomUUID(), table: randomUUID(), session: randomUUID(), customer: randomUUID(),
  membership: randomUUID(), account: randomUUID(), product: randomUUID(), inventory: randomUUID(),
  recipe: randomUUID(), catalog: randomUUID(), catalogItem: randomUUID(), pointLot: randomUUID(),
})

integration('loyalty redemption PostgreSQL authority', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    runner = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await seed(pool)
    const configuration = new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(runner, scope()),
    )
    const draft = await configuration.get('redemption_catalog', id.catalog)
    const preview = await configuration.preview('redemption_catalog', id.catalog, id.employeeB)
    await configuration.approve({ domain: 'redemption_catalog', publicId: id.catalog,
      expectedRevision: draft.revision, approverEmployeeId: id.employeeB,
      reason: '测试目录经独立复核', impactPreviewPublicId: preview.publicId })
    await pool.query(`
      UPDATE mbox.redemption_catalog_versions
      SET status='published',effective_from='2026-08-01T00:00:00Z',
        published_by_employee_id=$4,published_at='2026-08-01T00:01:00Z',
        publication_mode='separated',reason='测试目录经独立发布'
      WHERE id=$1 AND tenant_id=$2 AND store_id=$3
    `, [id.catalog, id.tenant, id.store, id.employeeC])
  })

  afterAll(async () => pool?.end())

  it('atomically spends FIFO lots and opens only the authorized zero-cash item in KDS', async () => {
    const result = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).create({
      customerId: id.customer,
      catalogItemPublicId: 'RED-ITEM-COCKTAIL',
      tableSessionId: id.session,
      businessDate: '2026-08-16',
      now: '2026-08-16T04:30:00.000Z',
      idempotencyKey: 'redemption-create-primary-001',
      requestFingerprint: 'a'.repeat(64),
    }))
    expect(result).toMatchObject({
      catalogItemPublicId: 'RED-ITEM-COCKTAIL', pointsUsed: 600,
      status: 'awaiting_fulfillment', fulfillmentKind: 'product',
    })
    const facts = await pool.query(`
      SELECT redemption.status, account.available_points, lot.remaining_points,
        ordering.total_amount_minor::text, ordering.payment_status, ordering.fulfillment_state,
        item.pricing_kind, item.total_amount_minor::text AS item_total,
        task.status AS kds_status, balance.on_hand_quantity::text, balance.reserved_quantity::text,
        inventory.total_consumed, daily.consumed AS daily_consumed
      FROM mbox.member_redemptions redemption
      JOIN mbox.loyalty_accounts account ON account.id=$1
      JOIN mbox.loyalty_point_lots lot ON lot.id=$2
      JOIN mbox.orders ordering ON ordering.id=redemption.order_id
      JOIN mbox.order_items item ON item.id=redemption.order_item_id
      JOIN mbox.kds_tasks task ON task.order_item_id=item.id
      JOIN mbox.inventory_balances balance ON balance.inventory_item_id=$3
      JOIN mbox.redemption_inventory_balances inventory ON inventory.catalog_item_id=$4
      JOIN mbox.redemption_daily_inventory daily
        ON daily.catalog_item_id=$4 AND daily.business_date='2026-08-16'
      WHERE redemption.public_id=$5
    `, [id.account, id.pointLot, id.inventory, id.catalogItem, result.publicId])
    expect(facts.rows[0]).toEqual({
      status: 'awaiting_fulfillment', available_points: 400, remaining_points: 400,
      total_amount_minor: '0', payment_status: 'unpaid', fulfillment_state: 'active',
      pricing_kind: 'points_redemption', item_total: '0', kds_status: 'pending',
      on_hand_quantity: '9.000000', reserved_quantity: '0.000000',
      total_consumed: 1, daily_consumed: 1,
    })
  })

  it('rolls back every fact when points or catalog inventory are not available', async () => {
    await expect(runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).create({
      customerId: id.customer,
      catalogItemPublicId: 'RED-ITEM-COCKTAIL',
      tableSessionId: id.session,
      businessDate: '2026-08-16',
      now: '2026-08-16T04:31:00.000Z',
      idempotencyKey: 'redemption-create-soldout-002',
      requestFingerprint: 'b'.repeat(64),
    }))).rejects.toBeInstanceOf(LoyaltyRedemptionError)
    const counts = await pool.query(`
      SELECT (SELECT count(*) FROM mbox.member_redemptions WHERE tenant_id=$1 AND store_id=$2)::integer AS redemptions,
        (SELECT count(*) FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND note LIKE '积分兑换 %')::integer AS orders,
        (SELECT available_points FROM mbox.loyalty_accounts WHERE id=$3) AS points,
        (SELECT total_consumed FROM mbox.redemption_inventory_balances WHERE catalog_item_id=$4) AS consumed
    `, [id.tenant, id.store, id.account, id.catalogItem])
    expect(counts.rows[0]).toEqual({ redemptions: 1, orders: 1, points: 400, consumed: 1 })
  })

  it('cancels only before preparation and restores the original lot, inventory and catalog counters', async () => {
    const current = await pool.query(`SELECT public_id FROM mbox.member_redemptions WHERE tenant_id=$1 AND store_id=$2`, [id.tenant, id.store])
    const publicId = current.rows[0]?.public_id as string
    const cancelled = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).cancel({
      customerId: id.customer,
      publicId,
      now: '2026-08-16T04:35:00.000Z',
      reason: '顾客在制作前改变选择',
      idempotencyKey: 'redemption-cancel-primary-003',
    }))
    expect(cancelled.status).toBe('cancelled')
    const facts = await pool.query(`
      SELECT account.available_points, lot.remaining_points,
        redemption.status, ordering.status AS order_status,
        task.status AS task_status, balance.on_hand_quantity::text,
        inventory.total_consumed, daily.consumed AS daily_consumed
      FROM mbox.member_redemptions redemption
      JOIN mbox.loyalty_accounts account ON account.id=$1
      JOIN mbox.loyalty_point_lots lot ON lot.id=$2
      JOIN mbox.orders ordering ON ordering.id=redemption.order_id
      JOIN mbox.kds_tasks task ON task.order_item_id=redemption.order_item_id
      JOIN mbox.inventory_balances balance ON balance.inventory_item_id=$3
      JOIN mbox.redemption_inventory_balances inventory ON inventory.catalog_item_id=$4
      JOIN mbox.redemption_daily_inventory daily
        ON daily.catalog_item_id=$4 AND daily.business_date='2026-08-16'
      WHERE redemption.public_id=$5
    `, [id.account, id.pointLot, id.inventory, id.catalogItem, publicId])
    expect(facts.rows[0]).toEqual({
      available_points: 1000, remaining_points: 1000, status: 'cancelled',
      order_status: 'cancelled', task_status: 'cancelled', on_hand_quantity: '10.000000',
      total_consumed: 0, daily_consumed: 0,
    })
  })

  it('lets an authorized employee fail an unfulfilled redemption and records one original-lot and inventory return', async () => {
    const created = await createProductRedemption('redemption-create-employee-fail-004', 'd', '2026-08-16T04:40:00.000Z')
    const failed = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).fail({
      publicId: created.publicId,
      employeeId: id.employeeB,
      now: '2026-08-16T04:45:00.000Z',
      failureCode: 'product_unavailable',
      reason: '现场确认缺货且顾客尚未收到商品',
      confirmedUnfulfilled: true,
      idempotencyKey: 'redemption-employee-fail-004',
    }))
    expect(failed).toMatchObject({
      status: 'failed', failureCode: 'product_unavailable', recoveryState: 'restored',
      pointsRestored: 600,
    })
    const facts = await pool.query(`
      SELECT redemption.recovery_source,redemption.recovered_by_employee_id,
        account.available_points,lot.remaining_points,reservation.status AS inventory_status,
        reservation.return_movement_id IS NOT NULL AS has_inventory_return,
        allocation.restored_at IS NOT NULL AS allocation_restored,
        allocation.restoration_movement_id IS NOT NULL AS has_point_restore,
        (SELECT count(*)::integer FROM mbox.loyalty_point_lot_movements movement
          WHERE movement.id=allocation.restoration_movement_id AND movement.movement_type='restore') AS restore_movements,
        (SELECT count(*)::integer FROM mbox.redemption_fulfillment_events event
          WHERE event.redemption_id=redemption.id AND event.event_type='points_restored') AS restore_events
      FROM mbox.member_redemptions redemption
      JOIN mbox.loyalty_accounts account ON account.id=$1
      JOIN mbox.loyalty_point_lots lot ON lot.id=$2
      JOIN mbox.redemption_point_allocations allocation ON allocation.redemption_id=redemption.id
      JOIN mbox.inventory_order_reservations reservation ON reservation.order_item_id=redemption.order_item_id
      WHERE redemption.public_id=$3
    `, [id.account, id.pointLot, created.publicId])
    expect(facts.rows[0]).toEqual({
      recovery_source: 'employee', recovered_by_employee_id: id.employeeB,
      available_points: 1000, remaining_points: 1000,
      inventory_status: 'returned', has_inventory_return: true,
      allocation_restored: true, has_point_restore: true, restore_movements: 1, restore_events: 1,
    })
  })

  it('expires an untouched timed-out redemption exactly once under concurrent workers', async () => {
    const created = await createProductRedemption('redemption-create-worker-expire-005', 'e', '2026-08-16T05:00:00.000Z')
    const worker = new LoyaltyRedemptionRecoveryWorker(runner, () => '2026-08-16T10:00:00.000Z')
    const batches = await Promise.all([
      worker.runBatch(scope(), 'redemption-recovery-a'),
      worker.runBatch(scope(), 'redemption-recovery-b'),
    ])
    expect(batches.reduce((sum, batch) => sum + batch.expired, 0)).toBe(1)
    const replay = await worker.runBatch(scope(), 'redemption-recovery-a')
    expect(replay).toMatchObject({ claimed: 0, expired: 0, manualReview: 0 })
    const facts = await pool.query(`
      SELECT status,failure_code,recovery_state,recovery_source,points_restored,
        recovered_by_worker_id,(SELECT available_points FROM mbox.loyalty_accounts WHERE id=$2) AS points,
        (SELECT count(*)::integer FROM mbox.redemption_point_allocations allocation
          WHERE allocation.redemption_id=redemption.id AND allocation.restoration_movement_id IS NOT NULL) AS restored_allocations
      FROM mbox.member_redemptions redemption WHERE public_id=$1
    `, [created.publicId, id.account])
    expect(facts.rows[0]).toMatchObject({
      status: 'expired', failure_code: 'fulfillment_timeout', recovery_state: 'restored',
      recovery_source: 'worker', points_restored: 600, points: 1000, restored_allocations: 1,
    })
    expect(['redemption-recovery-a','redemption-recovery-b']).toContain(facts.rows[0].recovered_by_worker_id)
  })

  it('routes an ambiguous timed-out preparation to manual review and restores only after authorized confirmation', async () => {
    const created = await createProductRedemption('redemption-create-review-006', 'f', '2026-08-16T05:10:00.000Z')
    await pool.query(`
      UPDATE mbox.kds_tasks SET status='preparing',accepted_at='2026-08-16T05:12:00Z'
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=(
        SELECT order_item_id FROM mbox.member_redemptions WHERE public_id=$3
      )
    `, [id.tenant, id.store, created.publicId])
    const worker = new LoyaltyRedemptionRecoveryWorker(runner, () => '2026-08-16T10:00:00.000Z')
    const batch = await worker.runBatch(scope(), 'redemption-recovery-review')
    expect(batch).toMatchObject({ claimed: 1, expired: 0, manualReview: 1 })
    await expect(runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).fail({
      publicId: created.publicId, employeeId: id.employeeB, now: '2026-08-16T10:05:00.000Z',
      failureCode: 'fulfillment_rejected', reason: '尚在制作，不能直接返还', confirmedUnfulfilled: true,
      idempotencyKey: 'redemption-review-fail-blocked-006',
    }))).rejects.toMatchObject({ code: 'LOYALTY_REDEMPTION_RECOVERY_REVIEW_REQUIRED' })
    await pool.query(`
      UPDATE mbox.kds_tasks SET status='failed'
      WHERE tenant_id=$1 AND store_id=$2 AND order_item_id=(
        SELECT order_item_id FROM mbox.member_redemptions WHERE public_id=$3
      )
    `, [id.tenant, id.store, created.publicId])
    const resolved = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).fail({
      publicId: created.publicId, employeeId: id.employeeB, now: '2026-08-16T10:07:00.000Z',
      failureCode: 'fulfillment_rejected', reason: '现场核对制作失败且顾客未收到商品', confirmedUnfulfilled: true,
      idempotencyKey: 'redemption-review-fail-resolved-006',
    }))
    expect(resolved).toMatchObject({ status: 'failed', recoveryState: 'restored', pointsRestored: 600 })
    const audit = await pool.query(`
      SELECT recovery_state,recovery_source,recovered_by_employee_id,
        (SELECT count(*)::integer FROM mbox.audit_events
          WHERE object_id=$1 AND action='loyalty.redemption.recovery_review_required') AS review_audits
      FROM mbox.member_redemptions WHERE public_id=$1
    `, [created.publicId])
    expect(audit.rows[0]).toEqual({
      recovery_state: 'restored', recovery_source: 'employee', recovered_by_employee_id: id.employeeB,
      review_audits: 1,
    })
  })

  it('keeps recovery evidence behind forced store RLS and grants only the two allocation transition columns', async () => {
    const foreignScope = { tenantId: randomUUID(), storeId: randomUUID() }
    const visible = await runner.run(foreignScope, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      const result = await transaction.query(`
        SELECT public_id FROM mbox.member_redemptions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
      `, [id.tenant, id.store])
      return result.rowCount
    }, { readOnly: true })
    expect(visible).toBe(0)
    const privileges = await pool.query(`
      SELECT
        has_column_privilege('mbox_runtime','mbox.redemption_point_allocations','restored_at','UPDATE') AS can_mark_time,
        has_column_privilege('mbox_runtime','mbox.redemption_point_allocations','restoration_movement_id','UPDATE') AS can_mark_movement,
        has_column_privilege('mbox_runtime','mbox.redemption_point_allocations','points','UPDATE') AS can_change_points,
        has_table_privilege('mbox_runtime','mbox.redemption_point_allocations','DELETE') AS can_delete
    `)
    expect(privileges.rows[0]).toEqual({
      can_mark_time: true, can_mark_movement: true, can_change_points: false, can_delete: false,
    })
  })

  it('requires different employees to publish tier and redemption catalog versions and keeps the runtime switch configurable', async () => {
    const service = new CustomerExperienceService(
      runner,
      new NormalizedCommandExecutor(runner),
      { updateProfile: async () => { throw new Error('not used') } },
    )
    const configuration = new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(runner, scope()),
    )
    const tier = await service.draftLoyaltyTierPolicy(staff(id.employeeA), {
      evaluationWindowMonths: 12, tierPeriodMonths: 12, downgradeGraceDays: 60,
      silverUpgradeGrowth: 3000, silverRetainGrowth: 2000,
      goldUpgradeGrowth: 10000, goldRetainGrowth: 8000,
      silverPointsMultiplierNumerator: 11, silverPointsMultiplierDenominator: 10,
      goldPointsMultiplierNumerator: 12, goldPointsMultiplierDenominator: 10,
      reason: '仅用于验证双人审批与版本冻结',
      idempotencyKey: 'tier-policy-draft-redemption-test',
    })
    const tierDraft = await configuration.get('tier_policy', tier.value.id)
    const selfTierPreview = await configuration.preview('tier_policy', tier.value.id, id.employeeA)
    await expect(configuration.approve({ domain:'tier_policy',publicId:tier.value.id,
      expectedRevision:tierDraft.revision,approverEmployeeId:id.employeeA,reason:'本人不得审批',
      impactPreviewPublicId:selfTierPreview.publicId }))
      .rejects.toMatchObject<CustomerExperienceRequestError>({ code: 'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED' })
    const tierPreview = await configuration.preview('tier_policy', tier.value.id, id.employeeB)
    const approvedTier = await configuration.approve({ domain:'tier_policy',publicId:tier.value.id,
      expectedRevision:tierDraft.revision,approverEmployeeId:id.employeeB,
      reason:'已确认这里只验证机制，不代表经营门槛已批准',impactPreviewPublicId:tierPreview.publicId })
    expect(approvedTier.status).toBe('approved')
    const publishedTier = await service.publishLoyaltyTierPolicy(staff(id.employeeC), {
      policyId: tier.value.id, effectiveFrom: '2026-08-20T00:00:00.000Z', effectiveUntil: null,
      reason: '最高授权人员确认正式排期',
      idempotencyKey: 'tier-policy-publication-test',
    })
    expect(publishedTier.value.status).toBe('published')

    const catalog = await service.draftRedemptionCatalog(staff(id.employeeA), {
      reason: '新增轻体验兑换项草稿',
      items: [{
        publicId: 'RED-SERVICE-EXPERIENCE', itemCode: 'SERVICE_1500', name: '轻体验资格',
        fulfillmentKind: 'service', productId: null, benefitDefinitionId: null, activityId: null,
        pointsRequired: 1500, costAmountMinor: 0, currency: 'CNY',
        totalInventory: 10, dailyInventory: 2, memberDailyLimit: 1,
        memberRolling30DayLimit: 2, memberLifetimeLimit: null, minimumTier: 'member',
        requiresTableSession: false, requiresEmployeeFulfillment: true,
        cancellationAllowedBeforeFulfillment: true, restoreExpiredPointsDays: 7,
        availableFrom: '2026-08-20T00:00:00.000Z', availableUntil: null,
        fulfillmentTimeoutMinutes: 1440, display: { description: '由授权员工现场确认交付' },
      }],
      idempotencyKey: 'redemption-catalog-draft-v2-test',
    })
    const catalogDraft = await configuration.get('redemption_catalog', catalog.value.id)
    const selfCatalogPreview = await configuration.preview('redemption_catalog',catalog.value.id,id.employeeA)
    await expect(configuration.approve({domain:'redemption_catalog',publicId:catalog.value.id,
      expectedRevision:catalogDraft.revision,approverEmployeeId:id.employeeA,reason:'本人不得审批',
      impactPreviewPublicId:selfCatalogPreview.publicId}))
      .rejects.toMatchObject<CustomerExperienceRequestError>({code:'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED'})
    const catalogPreview = await configuration.preview('redemption_catalog',catalog.value.id,id.employeeB)
    const approved = await configuration.approve({domain:'redemption_catalog',publicId:catalog.value.id,
      expectedRevision:catalogDraft.revision,approverEmployeeId:id.employeeB,
      reason:'已核对测试项成本与履约方式',impactPreviewPublicId:catalogPreview.publicId})
    expect(approved.status).toBe('approved')
    const published = await service.publishRedemptionCatalog(staff(id.employeeC), {
      catalogId: catalog.value.id, effectiveFrom: '2026-08-20T00:00:00.000Z', effectiveUntil: null,
      reason: '最高授权人员确认目录正式排期',
      idempotencyKey: 'redemption-catalog-publication-test',
    })
    expect(published.value).toMatchObject({ status: 'published', itemCount: 1 })
    const paused = await service.setRedemptionControl(staff(id.employeeB), {
      state: 'paused', pilotStartsAt: null, pilotEndsAt: null,
      reason: '验收结束后暂停新兑换', idempotencyKey: 'redemption-control-pause-test',
    })
    expect(paused.value.state).toBe('paused')
  })

  it('freezes published catalog terms and creates a typed service entitlement before marking delivery complete', async () => {
    const extraLot = randomUUID()
    await pool.query(`
      INSERT INTO mbox.loyalty_point_lots(
        id,tenant_id,store_id,membership_id,customer_id,source_type,source_id,
        original_points,remaining_points,available_at,status
      ) VALUES($1,$2,$3,$4,$5,'adjust','service-redemption-test',1000,1000,
        '2026-08-20T00:00:00Z','available')
    `, [extraLot, id.tenant, id.store, id.membership, id.customer])
    await pool.query(`UPDATE mbox.loyalty_accounts SET available_points=2000 WHERE id=$1`, [id.account])
    await pool.query(`UPDATE mbox.loyalty_redemption_controls SET state='enabled',reason='验证服务兑换履约' WHERE tenant_id=$1 AND store_id=$2`, [id.tenant, id.store])
    await expect(pool.query(`
      UPDATE mbox.redemption_catalog_items SET points_required=1
      WHERE tenant_id=$1 AND store_id=$2 AND public_id='RED-SERVICE-EXPERIENCE'
    `, [id.tenant, id.store])).rejects.toThrow('mutable only while their version is draft')

    const created = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).create({
      customerId: id.customer,
      catalogItemPublicId: 'RED-SERVICE-EXPERIENCE',
      tableSessionId: null,
      businessDate: '2026-08-21',
      now: '2026-08-21T04:30:00.000Z',
      idempotencyKey: 'redemption-create-service-005',
      requestFingerprint: 'c'.repeat(64),
    }))
    const fulfilled = await runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).fulfill({
      publicId: created.publicId,
      employeeId: id.employeeB,
      now: '2026-08-21T04:35:00.000Z',
      reason: '员工已完成轻体验服务',
      idempotencyKey: 'redemption-fulfill-service-005',
    }))
    expect(fulfilled).toMatchObject({
      status: 'fulfilled', entitlementKind: 'service', entitlementStatus: 'issued',
    })
    const entitlement = await pool.query(`
      SELECT entitlement.entitlement_kind,entitlement.status,entitlement.issued_by_employee_id
      FROM mbox.member_redemption_entitlements entitlement
      JOIN mbox.member_redemptions redemption ON redemption.id=entitlement.redemption_id
      WHERE redemption.public_id=$1
    `, [created.publicId])
    expect(entitlement.rows[0]).toEqual({
      entitlement_kind: 'service', status: 'issued', issued_by_employee_id: id.employeeB,
    })
  })

  it('rejects every new redemption under the owner emergency gate without deleting points or fulfilled history', async () => {
    const service=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
    await service.set(staff(id.employeeA),{
      capability:'points_redemption',operation:'pause',reason:'现场兑换履约异常，最高管理人员暂停新兑换',
      reviewAt:null,expectedVersion:0,idempotencyKey:'redemption-emergency-pause-087',
    })
    const before=await pool.query(`SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])
    const fulfilledBefore=await pool.query(`SELECT count(*)::integer AS count FROM mbox.member_redemptions
      WHERE tenant_id=$1 AND store_id=$2 AND status='fulfilled'`,[id.tenant,id.store])
    await expect(runner.run(scope(),(transaction)=>new LoyaltyRedemptionRepository(transaction).create({
      customerId:id.customer,catalogItemPublicId:'RED-SERVICE-EXPERIENCE',tableSessionId:null,
      businessDate:'2026-08-21',now:'2026-08-21T05:00:00.000Z',
      idempotencyKey:'redemption-emergency-denied-087',requestFingerprint:'e'.repeat(64),
    }))).rejects.toMatchObject({code:'LOYALTY_REDEMPTION_DISABLED'})
    expect((await pool.query(`SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])).rows[0])
      .toEqual(before.rows[0])
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.member_redemptions
      WHERE tenant_id=$1 AND store_id=$2 AND status='fulfilled'`,[id.tenant,id.store])).rows[0])
      .toEqual(fulfilledBefore.rows[0])
  })

  function createProductRedemption(
    idempotencyKey: string,
    fingerprintCharacter: string,
    now: string,
  ) {
    return runner.run(scope(), (transaction) => new LoyaltyRedemptionRepository(transaction).create({
      customerId: id.customer,
      catalogItemPublicId: 'RED-ITEM-COCKTAIL',
      tableSessionId: id.session,
      businessDate: '2026-08-16',
      now,
      idempotencyKey,
      requestFingerprint: fingerprintCharacter.repeat(64),
    }))
  }
})

function scope() {
  return { tenantId: id.tenant, storeId: id.store }
}

function staff(employeeId: string) {
  return { scope: scope(), employeeId, businessDate: '2026-08-16' }
}

async function seed(pool: Pool) {
  const suffix = id.tenant.replaceAll('-', '').slice(0, 10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Redemption Tenant')`, [id.tenant, `red-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Redemption Store')`, [id.store, id.tenant, `red-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
      ($1,$4,$5,$6,'Redemption Drafter','active'),($2,$4,$5,$7,'Redemption Approver','active'),
      ($3,$4,$5,$8,'Redemption Publisher','active')
  `, [id.employeeA, id.employeeB, id.employeeC, id.tenant, id.store,
    `RD-${suffix}`, `RA-${suffix}`, `RP-${suffix}`])
  await pool.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,$4,'Redemption Area','bar')`, [id.area, id.tenant, id.store, `A-${suffix}`])
  await pool.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,status) VALUES($1,$2,$3,$4,$5,'R1',4,'available')`, [id.table, id.tenant, id.store, id.area, `T-${suffix}`])
  await pool.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,$5,'2026-08-16',2,'open')`, [id.session, id.tenant, id.store, id.table, `red-session-${suffix}`])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')`, [id.customer, id.tenant, id.store, `red-customer-${suffix}`])
  await pool.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')`, [id.tenant, id.store, id.session, id.customer])
  await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no,level,status,points_balance) VALUES($1,$2,$3,$4,$5,'member','active',1000)`, [id.membership, id.tenant, id.store, id.customer, `MBX${suffix.toUpperCase()}`])
  await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,available_points,current_tier) VALUES($1,$2,$3,$4,$5,1000,'member')`, [id.account, id.tenant, id.store, id.membership, id.customer])
  await pool.query(`INSERT INTO mbox.loyalty_point_lots(id,tenant_id,store_id,membership_id,customer_id,source_type,source_id,original_points,remaining_points,available_at,status) VALUES($1,$2,$3,$4,$5,'legacy_balance','redemption-test-opening',1000,1000,'2026-08-01T00:00:00Z','available')`, [id.pointLot, id.tenant, id.store, id.membership, id.customer])
  await pool.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key,occurred_at) VALUES($1,$2,$3,'grant',1000,1000,'legacy_balance','redemption-test-opening',$4,'2026-08-01T00:00:00Z')`, [id.tenant, id.store, id.pointLot, `lot-open-${suffix}`])
  await pool.query(`
    INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,product_kind,cost_amount_minor,status)
    VALUES($1,$2,$3,$4,'积分特调','drink','bar','single',1000,'active')
  `, [id.product, id.tenant, id.store, `RP-${suffix}`])
  await pool.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',8800,'CNY','2026-01-01T00:00:00Z')`, [id.tenant, id.store, id.product])
  await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'兑换原料','ingredient','piece')`, [id.inventory, id.tenant, id.store, `RI-${suffix}`])
  await pool.query(`INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at) VALUES($1,$2,$3,$4,1,1,'active','2026-01-01T00:00:00Z')`, [id.recipe, id.tenant, id.store, id.product])
  await pool.query(`INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,1)`, [id.tenant, id.store, id.recipe, id.inventory])
  await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity) VALUES($1,$2,$3,10)`, [id.tenant, id.store, id.inventory])
  await pool.query(`INSERT INTO mbox.loyalty_redemption_controls(tenant_id,store_id,state,reason,changed_by_employee_id) VALUES($1,$2,'enabled','测试门店已开放兑换',$3)`, [id.tenant, id.store, id.employeeA])
  await pool.query(`
    INSERT INTO mbox.redemption_catalog_versions(id,tenant_id,store_id,version,status,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,reason)
    VALUES($1,$2,$3,1,'draft',NULL,$4,NULL,NULL,'测试目录等待双人复核')
  `, [id.catalog, id.tenant, id.store, id.employeeA])
  await pool.query(`
    INSERT INTO mbox.redemption_catalog_items(
      id,tenant_id,store_id,catalog_version_id,public_id,item_code,name,fulfillment_kind,
      product_id,points_required,cost_amount_minor,currency,total_inventory,daily_inventory,
      member_daily_limit,member_rolling_30_day_limit,minimum_tier,requires_table_session,
      requires_employee_fulfillment,available_from,status,display_snapshot
    ) VALUES($1,$2,$3,$4,'RED-ITEM-COCKTAIL','COCKTAIL_600','积分特调','product',
      $5,600,1000,'CNY',1,1,1,4,'member',true,true,'2026-08-01T00:00:00Z','active','{"subtitle":"仅限到店兑换"}')
  `, [id.catalogItem, id.tenant, id.store, id.catalog, id.product])
}
