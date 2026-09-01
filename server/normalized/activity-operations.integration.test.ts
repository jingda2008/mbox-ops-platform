import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import {
  ActivityOperationsRepository,
  type ActivityDraftInput,
} from './activity-operations-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = randomUUID()
const storeId = randomUUID()
const employeeId = randomUUID()
const customerIds = Array.from({ length: 7 }, () => randomUUID())
const draftActivityId = randomUUID()
const publishedActivityId = randomUUID()
const freeRegistrationId = randomUUID()
const noShowRegistrationId = randomUUID()
const paidRegistrationId = randomUUID()
const pendingRegistrationId = randomUUID()
const concurrentRegistrationId = randomUUID()
const packageRegistrationId = randomUUID()
const packageReleaseRegistrationId = randomUUID()
const packageId = randomUUID()
const packageComponentId = randomUUID()
const packageInventoryItemId = randomUUID()
const paidPaymentId = randomUUID()
const pendingPaymentId = randomUUID()
const suffix = tenantId.replaceAll('-', '').slice(0, 12)

integration('activity operations PostgreSQL integration', () => {
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await seed(pool)
  })

  afterAll(async () => { await pool?.end() })

  it('reads operational counts without exposing protected contact and updates draft-only promises', async () => {
    const listed = await run((repository) => repository.list())
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicId: 'activity-ops-published', occupiedSeats: 9, waitlistedSeats: 0 }),
      expect.objectContaining({ publicId: 'activity-ops-draft', occupiedSeats: 0 }),
    ]))
    const detail = await run((repository) => repository.detail('activity-ops-published'))
    expect(detail.registrations).toHaveLength(7)
    expect(JSON.stringify(detail)).not.toContain('encryptedContact')
    expect(JSON.stringify(detail)).not.toContain('13800138000')

    const updated = await run((repository) => repository.updateDraft('activity-ops-draft', {
      ...draftInput,
      title: '更新后的活动草稿',
      memberBenefitText: '会员到场可领取纪念徽章',
    }))
    expect(updated).toMatchObject({ title: '更新后的活动草稿', status: 'draft', pointsReward: 0 })
    await expect(run((repository) => repository.updateDraft('activity-ops-published', draftInput)))
      .rejects.toMatchObject({ code: 'PUBLISHED_ACTIVITY_IMMUTABLE', statusCode: 409 })
  })

  it('supports attendance but rejects premature no-show and direct paid cancellation', async () => {
    const checkedIn = await run((repository) => repository.transitionRegistration(
      'activity-ops-registration-free', 'check_in', '现场确认顾客到场',
    ))
    expect(checkedIn).toMatchObject({ status: 'checked_in', paymentStatus: 'not_required' })

    await expect(run((repository) => repository.transitionRegistration(
      'activity-ops-registration-no-show', 'no_show', '现场尚未见到顾客',
    ))).rejects.toMatchObject({ code: 'ACTIVITY_NO_SHOW_TOO_EARLY' })

    await expect(run((repository) => repository.transitionRegistration(
      'activity-ops-registration-paid', 'cancel', '顾客申请取消',
    ))).rejects.toMatchObject({ code: 'ACTIVITY_PAID_CANCELLATION_REQUIRES_REFUND' })
    const paid = await pool.query<{ status: string; payment_status: string }>(`
      SELECT status,payment_status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [tenantId, storeId, paidRegistrationId])
    expect(paid.rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' })
  })

  it('keeps selected package stock reserved at check-in, consumes only on explicit delivery, and releases a pending intent on refund', async () => {
    const checkedIn = await run((repository) => repository.transitionRegistration(
      'activity-ops-registration-package', 'check_in', '现场确认套餐顾客到场', employeeId,
    ))
    expect(checkedIn).toMatchObject({ status: 'checked_in', packageFulfillmentStatus: 'pending' })
    const afterCheckIn = await pool.query<{ on_hand_quantity: number; reserved_quantity: number; movements: string; intent: string }>(`
      SELECT balance.on_hand_quantity::float8,balance.reserved_quantity::float8,
        (SELECT count(*)::text FROM mbox.inventory_movements movement
          WHERE movement.tenant_id=$1::uuid AND movement.store_id=$2::uuid
            AND movement.inventory_item_id=$3::uuid) AS movements,
        (SELECT status FROM mbox.community_activity_package_fulfillment_intents intent
          WHERE intent.tenant_id=$1::uuid AND intent.store_id=$2::uuid
            AND intent.registration_id=$4::uuid AND intent.registration_cycle=1) AS intent
      FROM mbox.inventory_balances balance
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid AND balance.inventory_item_id=$3::uuid
    `, [tenantId, storeId, packageInventoryItemId, packageRegistrationId])
    expect(afterCheckIn.rows[0]).toEqual({ on_hand_quantity: 5, reserved_quantity: 2, movements: '0', intent: 'pending' })

    const delivered = await run((repository) => repository.transitionRegistration(
      'activity-ops-registration-package', 'fulfill_package', '吧台已实际交付限定饮品', employeeId,
    ))
    expect(delivered).toMatchObject({ status: 'checked_in', packageFulfillmentStatus: 'delivered' })
    const afterDelivery = await pool.query<{ on_hand_quantity: number; reserved_quantity: number; reservation_status: string; movement_type: string }>(`
      SELECT balance.on_hand_quantity::float8,balance.reserved_quantity::float8,
        reservation.status AS reservation_status,movement.movement_type
      FROM mbox.inventory_balances balance
      JOIN mbox.community_activity_package_inventory_reservations reservation
        ON reservation.tenant_id=balance.tenant_id AND reservation.store_id=balance.store_id
       AND reservation.inventory_item_id=balance.inventory_item_id AND reservation.registration_id=$4::uuid
      JOIN mbox.inventory_movements movement
        ON movement.tenant_id=reservation.tenant_id AND movement.store_id=reservation.store_id
       AND movement.id=reservation.movement_id
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid AND balance.inventory_item_id=$3::uuid
    `, [tenantId, storeId, packageInventoryItemId, packageRegistrationId])
    expect(afterDelivery.rows[0]).toEqual({ on_hand_quantity: 4, reserved_quantity: 1, reservation_status: 'consumed', movement_type: 'sale' })

    await run((repository) => repository.transitionRegistration(
      'activity-ops-registration-package-release', 'check_in', '现场签到等待交付', employeeId,
    ))
    await pool.query(`UPDATE mbox.community_activity_registrations
      SET status='refunded',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`, [tenantId, storeId, packageReleaseRegistrationId])
    const released = await pool.query<{ on_hand_quantity: number; reserved_quantity: number; reservation_status: string; intent_status: string }>(`
      SELECT balance.on_hand_quantity::float8,balance.reserved_quantity::float8,
        reservation.status AS reservation_status,intent.status AS intent_status
      FROM mbox.inventory_balances balance
      JOIN mbox.community_activity_package_inventory_reservations reservation
        ON reservation.tenant_id=balance.tenant_id AND reservation.store_id=balance.store_id
       AND reservation.inventory_item_id=balance.inventory_item_id AND reservation.registration_id=$4::uuid
      JOIN mbox.community_activity_package_fulfillment_intents intent
        ON intent.tenant_id=reservation.tenant_id AND intent.store_id=reservation.store_id
       AND intent.registration_id=reservation.registration_id AND intent.registration_cycle=reservation.registration_cycle
      WHERE balance.tenant_id=$1::uuid AND balance.store_id=$2::uuid AND balance.inventory_item_id=$3::uuid
    `, [tenantId, storeId, packageInventoryItemId, packageReleaseRegistrationId])
    expect(released.rows[0]).toEqual({ on_hand_quantity: 4, reserved_quantity: 0, reservation_status: 'released', intent_status: 'cancelled' })
  })

  it('requires a provider query after any payment-channel action and does not release the seat', async () => {
    await expect(run((repository) => repository.transitionRegistration(
      'activity-ops-registration-pending', 'cancel', '顾客申请取消待付款报名',
    ))).rejects.toMatchObject({ code: 'ACTIVITY_PAYMENT_QUERY_REQUIRED' })
    const current = await pool.query<{ registration_status: string; payment_status: string }>(`
      SELECT registration.status AS registration_status,payment.status AS payment_status
      FROM mbox.community_activity_registrations registration
      JOIN mbox.payments payment ON payment.tenant_id=registration.tenant_id
        AND payment.store_id=registration.store_id AND payment.id=registration.payment_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.id=$3::uuid
    `, [tenantId, storeId, pendingRegistrationId])
    expect(current.rows[0]).toEqual({ registration_status: 'payment_pending', payment_status: 'pending' })
  })

  it('serializes two operator cancellations so only one transition can release the same seat', async () => {
    const attempts = await Promise.allSettled([
      run((repository) => repository.transitionRegistration(
        'activity-ops-registration-concurrent', 'cancel', '第一位员工处理取消',
      )),
      run((repository) => repository.transitionRegistration(
        'activity-ops-registration-concurrent', 'cancel', '第二位员工重复处理',
      )),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const stored = await pool.query<{ status: string }>(`
      SELECT status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [tenantId, storeId, concurrentRegistrationId])
    expect(stored.rows[0]?.status).toBe('cancelled')
  })

  it('keeps historical bottle-unit items visible in the activity component catalog', async () => {
    const legacyLiquidItemId = randomUUID()
    await pool.query(`
      INSERT INTO mbox.inventory_items(
        id,tenant_id,store_id,sku,name,item_type,base_unit,category_code,package_volume_ml,status
      ) VALUES($1::uuid,$2::uuid,$3::uuid,'ACTIVITY-LEGACY-BOTTLE','活动历史瓶装威士忌',
        'bottle','bottle','spirits.whisky',750,'active')
    `, [legacyLiquidItemId, tenantId, storeId])
    const catalog = await run((repository) => repository.componentCatalog())
    expect(catalog).toContainEqual({
      id: legacyLiquidItemId,
      sku: 'ACTIVITY-LEGACY-BOTTLE',
      name: '活动历史瓶装威士忌',
      baseUnit: 'bottle',
    })
  })

  async function run<Result>(operation: (repository: ActivityOperationsRepository) => Promise<Result>) {
    return runner.run({ tenantId, storeId }, (transaction) => operation(new ActivityOperationsRepository(transaction)))
  }
})

const draftInput: ActivityDraftInput = {
  kind: 'member_night', title: '活动草稿', summary: '活动草稿摘要', coverUrl: null,
  startsAt: '2026-09-10T11:00:00.000Z', endsAt: '2026-09-10T14:00:00.000Z',
  assemblyLocation: 'M-BOX陆家嘴店', capacity: 30, feeAmountMinor: 0, depositAmountMinor: 0,
  feeBasis: 'per_registration', paymentMode: 'none', paymentDeadlineMinutes: 15,
  paymentRuleText: '本活动无需预付', pointsReward: 0, visibility: 'public',
  audienceMemberLevels: [], audienceLifecycleStages: [], safetyPolicyVersion: 'activity-safety-v1',
  safetyAcknowledgementText: '我已阅读并同意安全要求', safetyRequirements: ['须年满18周岁'],
  refundPolicyVersion: 'activity-refund-v1', refundPolicySummary: '免费活动可在开始前取消',
  activityDetails: '现场音乐、交流与限定饮品体验。', includedItems: ['欢迎饮品'],
  participationRequirements: ['请提前15分钟到场'], contactInstructions: '报名成功后在小程序查看集合通知',
  memberBenefitText: null, packageSelectionRequired: false, packages: [],
}

async function seed(pool: Pool) {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1::uuid,$2,'Activity Ops Tenant')`, [tenantId, `activity_ops_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name)
    VALUES ($1::uuid,$2::uuid,$3,'Activity Ops Store')
  `, [storeId, tenantId, `activity_ops_store_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'ACTIVITY_MANAGER','活动店长')
  `, [employeeId, tenantId, storeId])
  for (const [index, customerId] of customerIds.entries()) {
    await pool.query(`
      INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'active')
    `, [customerId, tenantId, storeId, `activity-ops-customer-${index + 1}`])
    await pool.query(`
      INSERT INTO mbox.customer_profiles(tenant_id,store_id,customer_id,display_name)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4)
    `, [tenantId, storeId, customerId, `顾客${index + 1}`])
  }
  await insertActivity(pool, draftActivityId, 'activity-ops-draft', 'draft', '活动草稿')
  await insertActivity(pool, publishedActivityId, 'activity-ops-published', 'published', '已发布活动')
  await insertRegistration(pool, freeRegistrationId, 'activity-ops-registration-free', customerIds[0]!, 'confirmed', 'not_required', 1)
  await insertRegistration(pool, noShowRegistrationId, 'activity-ops-registration-no-show', customerIds[1]!, 'confirmed', 'not_required', 1)
  await insertRegistration(pool, paidRegistrationId, 'activity-ops-registration-paid', customerIds[2]!, 'confirmed', 'paid', 2)
  await insertRegistration(pool, pendingRegistrationId, 'activity-ops-registration-pending', customerIds[3]!, 'payment_pending', 'pending', 1)
  await insertRegistration(pool, concurrentRegistrationId, 'activity-ops-registration-concurrent', customerIds[4]!, 'confirmed', 'not_required', 2)
  await seedPackageFulfillment(pool)
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,
      provider,provider_transaction_id,method,amount_minor,currency,status,
      provider_snapshot,succeeded_at
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'activity_registration',$4::uuid,1,'activity-ops-payment-paid',
      'postar','ACTIVITY-OPS-PROVIDER-TRANSACTION-PAID','jsapi',5000,'CNY',
      'succeeded','{}'::jsonb,clock_timestamp()
    )
  `, [paidPaymentId, tenantId, storeId, paidRegistrationId])
  await pool.query(`
    UPDATE mbox.community_activity_registrations SET payment_id=$4::uuid,paid_amount_minor=5000
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
  `, [tenantId, storeId, paidRegistrationId, paidPaymentId])
  await pool.query(`
    INSERT INTO mbox.payments(
      id,tenant_id,store_id,payable_kind,activity_registration_id,activity_registration_cycle,public_id,
      provider,method,amount_minor,currency,status,provider_snapshot
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'activity_registration',$4::uuid,1,'activity-ops-payment-pending',
      'postar','jsapi',2000,'CNY','pending','{}'::jsonb
    )
  `, [pendingPaymentId, tenantId, storeId, pendingRegistrationId])
  await pool.query(`
    UPDATE mbox.community_activity_registrations SET payment_id=$4::uuid
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
  `, [tenantId, storeId, pendingRegistrationId, pendingPaymentId])
  await pool.query(`
    INSERT INTO mbox.payment_provider_actions(
      tenant_id,store_id,payment_id,presentation,initiated_by_type,
      initiated_by_ref,state,expires_at
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,'jsapi','guest',$4::uuid,'unknown',
      clock_timestamp()+interval '15 minutes'
    )
  `, [tenantId, storeId, pendingPaymentId, customerIds[3]])
}

async function seedPackageFulfillment(pool: Pool) {
  await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit)
    VALUES($1::uuid,$2::uuid,$3::uuid,'ACTIVITY-PACKAGE-INGREDIENT','活动套餐限定饮品','consumable','portion')`,
  [packageInventoryItemId,tenantId,storeId])
  await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity)
    VALUES($1::uuid,$2::uuid,$3::uuid,5,2)`, [tenantId,storeId,packageInventoryItemId])
  await pool.query(`INSERT INTO mbox.community_activity_packages(
    id,tenant_id,store_id,activity_id,public_id,name,capacity,member_purchase_limit,
    fee_amount_minor,deposit_amount_minor,fee_basis,payment_mode,payment_deadline_minutes,payment_rule_text,status
  ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'activity-ops-package','限定饮品加购',20,1,0,0,'per_registration','none',15,'免费限定饮品','draft')`,
  [packageId,tenantId,storeId,publishedActivityId])
  await pool.query(`INSERT INTO mbox.community_activity_package_components(
    id,tenant_id,store_id,activity_package_id,inventory_item_id,quantity,per_participant
  ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1,true)`,
  [packageComponentId,tenantId,storeId,packageId,packageInventoryItemId])
  await pool.query(`UPDATE mbox.community_activity_packages
    SET status='published' WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
  [tenantId,storeId,packageId])
  await insertRegistration(pool,packageRegistrationId,'activity-ops-registration-package',customerIds[5]!,'confirmed','not_required',1)
  await insertRegistration(pool,packageReleaseRegistrationId,'activity-ops-registration-package-release',customerIds[6]!,'confirmed','not_required',1)
  for (const registrationId of [packageRegistrationId,packageReleaseRegistrationId]) {
    await pool.query(`UPDATE mbox.community_activity_registrations
      SET activity_package_id=$4::uuid,activity_package_snapshot=jsonb_build_object(
        'publicId','activity-ops-package','name','限定饮品加购','feeAmountMinor',0,'paymentMode','none','feeBasis','per_registration'
      )
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`, [tenantId,storeId,registrationId,packageId])
    await pool.query(`INSERT INTO mbox.community_activity_package_inventory_reservations(
      tenant_id,store_id,registration_id,registration_cycle,package_component_id,inventory_item_id,quantity,status,expires_at
    ) VALUES($1::uuid,$2::uuid,$3::uuid,1,$4::uuid,$5::uuid,1,'reserved',clock_timestamp()+interval '1 day')`,
    [tenantId,storeId,registrationId,packageComponentId,packageInventoryItemId])
  }
}

async function insertActivity(pool: Pool, id: string, publicId: string, status: 'draft' | 'published', title: string) {
  await pool.query(`
    INSERT INTO mbox.community_activities(
      id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
      assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,
      registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,
      points_reward,visibility,audience_member_levels,audience_lifecycle_stages,
      safety_policy_version,safety_acknowledgement_text,safety_requirements,
      refund_policy_version,refund_policy_summary,activity_details,included_items,
      participation_requirements,contact_instructions,member_benefit_text,status,
      published_at,created_by_employee_id,approved_by_employee_id
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4,'member_night',$5,'活动运营集成测试',
      clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 3 hours',
      'M-BOX陆家嘴店',20,0,0,'per_registration','none',15,'本活动无需预付','CNY',
      0,'public','{}'::text[],'{}'::text[],'activity-safety-v1','我已阅读并同意安全要求',
      ARRAY['须年满18周岁']::text[],'activity-refund-v1','免费活动可提前取消',
      '现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品']::text[],ARRAY['提前到场']::text[],
      '报名成功后在小程序查看集合通知',NULL,$6,
      CASE WHEN $6='published' THEN clock_timestamp() ELSE NULL END,$7::uuid,
      CASE WHEN $6='published' THEN $7::uuid ELSE NULL END
    )
  `, [id, tenantId, storeId, publicId, title, status, employeeId])
}

async function insertRegistration(
  pool: Pool,
  id: string,
  publicId: string,
  customerId: string,
  status: 'confirmed' | 'payment_pending',
  paymentStatus: 'not_required' | 'pending' | 'paid',
  partySize: number,
) {
  const amountDue = paymentStatus === 'pending' ? 2000 : 0
  const fee = paymentStatus === 'paid' ? 5000 : amountDue
  await pool.query(`
    INSERT INTO mbox.community_activity_registrations(
      id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,
      payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,
      currency,contact_snapshot,safety_acknowledgement,idempotency_key,
      payment_due_at,seat_hold_expires_at,refund_policy_snapshot,
      acknowledged_safety_policy_version,acknowledged_refund_policy_version,
      terms_acknowledged_at,terms_acknowledgement_source,
      requested_payment_choice,requested_payment_method,requested_amount_due_minor
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,
      CASE WHEN $9='pending' THEN 'deposit' WHEN $9='paid' THEN 'full' ELSE 'none' END,$9,
      $10::bigint,$11::bigint,CASE WHEN $9='paid' THEN $10::bigint ELSE 0 END,'CNY',
      jsonb_build_object('contactType','phone','contactHash',repeat('a',64),
        'encryptedContact','AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
        'encryptionKeyId','normalized-contact-v1','maskedContact','138****8000','source','mini_program'),
      '{}'::jsonb,$12,
      CASE WHEN $9='pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,
      CASE WHEN $9='pending' THEN clock_timestamp()+interval '15 minutes' ELSE NULL END,
      jsonb_build_object('policyVersion','activity-refund-v1'),
      'activity-safety-v1','activity-refund-v1',clock_timestamp(),'staff_assisted'
      ,CASE WHEN $9='pending' THEN 'deposit' WHEN $9='paid' THEN 'full' ELSE 'none' END
      ,CASE WHEN $9 IN ('pending','paid') THEN 'jsapi' ELSE NULL END
      ,CASE WHEN $9='paid' THEN $10::bigint WHEN $9='pending' THEN $11::bigint ELSE 0 END
    )
  `, [
    id, tenantId, storeId, publicId, publishedActivityId, customerId, partySize, status,
    paymentStatus, fee, amountDue, `activity-ops-registration-key-${publicId}`.slice(0,128),
  ])
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
