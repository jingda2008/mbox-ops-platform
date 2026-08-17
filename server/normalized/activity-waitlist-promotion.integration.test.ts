import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ActivityWaitlistPromotionWorker } from './activity-waitlist-promotion-worker.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const tenantId = randomUUID()
const storeId = randomUUID()
const otherStoreId = randomUUID()
const employeeId = randomUUID()
const suffix = tenantId.replaceAll('-','').slice(0,12)
const customers = Array.from({ length: 12 }, () => randomUUID())
const freeActivityId = randomUUID()
const paidActivityId = randomUUID()
const fifoActivityId = randomUUID()
const blockedActivityId = randomUUID()
const freeOccupiedIds = [randomUUID(),randomUUID()]
const freeWaitIds = [randomUUID(),randomUUID()]
const paidOccupiedId = randomUUID()
const paidWaitId = randomUUID()
const fifoOccupiedId = randomUUID()
const fifoWaitIds = [randomUUID(),randomUUID()]
const blockedOccupiedId = randomUUID()
const blockedWaitId = randomUUID()

integration('activity waitlist promotion PostgreSQL integration', () => {
  let pool: Pool
  let worker: ActivityWaitlistPromotionWorker
  let transactions: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 12 })
    transactions = new ScopedPostgresTransactionRunner(asPool(pool))
    worker = new ActivityWaitlistPromotionWorker(transactions, true)
    await seed(pool)
  })

  afterAll(async () => { await pool?.end() })

  it('promotes the strict first free candidate once under concurrent workers and records notification evidence', async () => {
    await release(pool, freeOccupiedIds[0]!, 'cancelled')
    const attempts = await Promise.all([
      worker.runBatch({ tenantId,storeId }, 'activity-waitlist-worker-a'),
      worker.runBatch({ tenantId,storeId }, 'activity-waitlist-worker-b'),
    ])
    expect(attempts.flatMap((result) => result.promotedRegistrationIds)).toEqual([freeWaitIds[0]])
    const registrations = await pool.query<{ id: string; status: string }>(`
      SELECT id,status FROM mbox.community_activity_registrations
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=ANY($3::uuid[])
      ORDER BY registered_at,id
    `, [tenantId,storeId,freeWaitIds])
    expect(registrations.rows.map((row) => row.status)).toEqual(['confirmed','waitlisted'])
    const evidence = await pool.query<{ promotions: number; notifications: number; audits: number }>(`
      SELECT
        (SELECT count(*)::integer FROM mbox.activity_waitlist_promotions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND activity_id=$3::uuid) AS promotions,
        (SELECT count(*)::integer FROM mbox.notifications
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND template_code='community.activity.waitlist_confirmed') AS notifications,
        (SELECT count(*)::integer FROM mbox.audit_events
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
            AND action='community.activity.waitlist_promoted') AS audits
    `, [tenantId,storeId,freeActivityId])
    expect(evidence.rows[0]).toEqual({ promotions: 1,notifications: 1,audits: 1 })
  })

  it('creates a pending payment only after a paid candidate is promoted and never starts a provider action', async () => {
    const before = await pool.query<{ payments: number; actions: number }>(`
      SELECT
        (SELECT count(*)::integer FROM mbox.payments payment
          JOIN mbox.community_activity_registrations registration
            ON registration.id=payment.activity_registration_id
          WHERE registration.id=$1::uuid) AS payments,
        (SELECT count(*)::integer FROM mbox.payment_provider_actions action
          JOIN mbox.payments payment ON payment.id=action.payment_id
          WHERE payment.activity_registration_id=$1::uuid) AS actions
    `, [paidWaitId])
    expect(before.rows[0]).toEqual({ payments: 0,actions: 0 })

    await release(pool, paidOccupiedId, 'cancelled')
    const batch = await worker.runBatch({ tenantId,storeId }, 'activity-waitlist-paid-worker')
    expect(batch.promotedRegistrationIds).toEqual([paidWaitId])
    const after = await pool.query<{
      status: string; payment_status: string; payment_choice: string
      amount_due_minor: string; payments: number; actions: number; promotion_payment_id: string | null
    }>(`
      SELECT registration.status,registration.payment_status,registration.payment_choice,
        registration.amount_due_minor::text,
        (SELECT count(*)::integer FROM mbox.payments payment
          WHERE payment.activity_registration_id=registration.id) AS payments,
        (SELECT count(*)::integer FROM mbox.payment_provider_actions action
          JOIN mbox.payments payment ON payment.id=action.payment_id
          WHERE payment.activity_registration_id=registration.id) AS actions,
        promotion.payment_id AS promotion_payment_id
      FROM mbox.community_activity_registrations registration
      JOIN mbox.activity_waitlist_promotions promotion
        ON promotion.tenant_id=registration.tenant_id AND promotion.store_id=registration.store_id
       AND promotion.registration_id=registration.id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.id=$3::uuid
    `, [tenantId,storeId,paidWaitId])
    expect(after.rows[0]).toMatchObject({
      status: 'payment_pending',payment_status: 'pending',payment_choice: 'deposit',
      amount_due_minor: '2000',payments: 1,actions: 0,
    })
    expect(after.rows[0]?.promotion_payment_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('does not let a smaller later party jump a first candidate that cannot fit', async () => {
    await release(pool, fifoOccupiedId, 'cancelled')
    const batch = await worker.runBatch({ tenantId,storeId }, 'activity-waitlist-fifo-worker')
    expect(batch.promotedRegistrationIds).toEqual([])
    const current = await pool.query<{ statuses: string[]; resolution: string }>(`
      SELECT array_agg(registration.status ORDER BY registration.registered_at,registration.id) AS statuses,
        (SELECT event.resolution FROM mbox.activity_waitlist_release_events event
          WHERE event.activity_id=$3::uuid ORDER BY event.created_at DESC LIMIT 1) AS resolution
      FROM mbox.community_activity_registrations registration
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.id=ANY($4::uuid[])
    `, [tenantId,storeId,fifoActivityId,fifoWaitIds])
    expect(current.rows[0]).toEqual({ statuses: ['waitlisted','waitlisted'],resolution: 'head_party_does_not_fit' })
  })

  it('defers a paid promotion when any payment gate closes without creating or starting payment', async () => {
    await pool.query(`
      UPDATE mbox.store_commerce_policies SET online_payment_enabled=false
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    `, [tenantId,storeId])
    await release(pool, blockedOccupiedId, 'cancelled')
    const batch = await worker.runBatch({ tenantId,storeId }, 'activity-waitlist-blocked-worker')
    expect(batch.deferredEventIds).toHaveLength(1)
    expect(batch.promotedRegistrationIds).toEqual([])
    const state = await pool.query<{
      status: string; payment_id: string | null; processed_at: string | null; last_block_reason: string
    }>(`
      SELECT registration.status,registration.payment_id,event.processed_at::text,event.last_block_reason
      FROM mbox.community_activity_registrations registration
      JOIN mbox.activity_waitlist_release_events event ON event.activity_id=registration.activity_id
      WHERE registration.tenant_id=$1::uuid AND registration.store_id=$2::uuid
        AND registration.id=$3::uuid
      ORDER BY event.created_at DESC LIMIT 1
    `, [tenantId,storeId,blockedWaitId])
    expect(state.rows[0]).toEqual({
      status: 'waitlisted',payment_id: null,processed_at: null,last_block_reason: 'payment_gate_closed',
    })
  })

  it('rejects silent published-promise edits and nonversioned activity points in PostgreSQL', async () => {
    await expect(pool.query(`
      UPDATE mbox.community_activities SET title='静默改变后的标题'
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    `, [tenantId,storeId,freeActivityId])).rejects.toThrow(/published activity promises are immutable/)
    await expect(pool.query(`
      INSERT INTO mbox.community_activities(
        tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
        assembly_location,capacity,points_reward,status,created_by_employee_id
      ) VALUES (
        $1::uuid,$2::uuid,'activity-invalid-points','other','无效积分活动','无效积分活动',
        clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',
        'M-BOX',10,100,'draft',$3::uuid
      )
    `, [tenantId,storeId,employeeId])).rejects.toMatchObject({ code: '23514' })
  })

  it('isolates release and promotion evidence by store RLS and prevents evidence deletion', async () => {
    const hidden = await transactions.run({ tenantId,storeId: otherStoreId }, async (transaction) => {
      await transaction.query('SET LOCAL ROLE mbox_runtime')
      return transaction.query<{ releases: number; promotions: number }>(`
        SELECT
          (SELECT count(*)::integer FROM mbox.activity_waitlist_release_events) AS releases,
          (SELECT count(*)::integer FROM mbox.activity_waitlist_promotions) AS promotions
      `)
    }, { readOnly: true })
    expect(hidden.rows[0]).toEqual({ releases: 0,promotions: 0 })
    await expect(pool.query(`
      DELETE FROM mbox.activity_waitlist_release_events
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
    `, [tenantId,storeId])).rejects.toThrow(/cannot be deleted/)
  })
})

async function seed(pool: Pool) {
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1::uuid,$2,'Waitlist Tenant')`, [tenantId,`waitlist_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1::uuid,$2::uuid,$3,'Waitlist Store')
  `, [storeId,tenantId,`waitlist_store_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES ($1::uuid,$2::uuid,$3,'Other Waitlist Store')
  `, [otherStoreId,tenantId,`waitlist_other_${suffix}`])
  await pool.query(`
    INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'WAITLIST_MANAGER','候补负责人')
  `, [employeeId,tenantId,storeId])
  await pool.query(`
    INSERT INTO mbox.store_commerce_policies(
      tenant_id,store_id,online_payment_enabled,reason,updated_by_employee_id
    ) VALUES ($1::uuid,$2::uuid,true,'活动候补支付集成测试',$3::uuid)
  `, [tenantId,storeId,employeeId])
  await pool.query(`
    INSERT INTO mbox.customer_experience_features(
      tenant_id,store_id,feature_code,rollout_state,reason,approved_by_employee_id
    ) VALUES ($1::uuid,$2::uuid,'community.activity.payment','enabled','活动支付集成测试',$3::uuid)
    ON CONFLICT (tenant_id,store_id,feature_code) DO UPDATE
    SET rollout_state='enabled',reason=EXCLUDED.reason,
      approved_by_employee_id=EXCLUDED.approved_by_employee_id
  `, [tenantId,storeId,employeeId])
  for (const [index,customerId] of customers.entries()) {
    await pool.query(`
      INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'active')
    `, [customerId,tenantId,storeId,`waitlist-customer-${index + 1}`])
  }
  await insertActivity(pool,freeActivityId,'waitlist-free-activity','免费候补活动',2,'none',0,0)
  await insertActivity(pool,paidActivityId,'waitlist-paid-activity','收费候补活动',1,'deposit_required',10000,2000)
  await insertActivity(pool,fifoActivityId,'waitlist-fifo-activity','先到先候补活动',1,'none',0,0)
  await insertActivity(pool,blockedActivityId,'waitlist-blocked-activity','支付关闭候补活动',1,'deposit_required',10000,2000)
  await insertRegistration(pool,freeOccupiedIds[0]!,'free-occupied-1',freeActivityId,customers[0]!,1,'confirmed')
  await insertRegistration(pool,freeOccupiedIds[1]!,'free-occupied-2',freeActivityId,customers[1]!,1,'confirmed')
  await insertRegistration(pool,freeWaitIds[0]!,'free-wait-1',freeActivityId,customers[2]!,1,'waitlisted')
  await insertRegistration(pool,freeWaitIds[1]!,'free-wait-2',freeActivityId,customers[3]!,1,'waitlisted')
  await insertRegistration(pool,paidOccupiedId,'paid-occupied',paidActivityId,customers[4]!,1,'confirmed')
  await insertRegistration(pool,paidWaitId,'paid-wait',paidActivityId,customers[5]!,1,'waitlisted','deposit','jsapi',2000)
  await insertRegistration(pool,fifoOccupiedId,'fifo-occupied',fifoActivityId,customers[6]!,1,'confirmed')
  await insertRegistration(pool,fifoWaitIds[0]!,'fifo-wait-large',fifoActivityId,customers[7]!,2,'waitlisted')
  await insertRegistration(pool,fifoWaitIds[1]!,'fifo-wait-small',fifoActivityId,customers[8]!,1,'waitlisted')
  await insertRegistration(pool,blockedOccupiedId,'blocked-occupied',blockedActivityId,customers[9]!,1,'confirmed')
  await insertRegistration(pool,blockedWaitId,'blocked-wait',blockedActivityId,customers[10]!,1,'waitlisted','deposit','jsapi',2000)
}

async function insertActivity(
  pool: Pool,id: string,publicId: string,title: string,capacity: number,
  paymentMode: 'none' | 'deposit_required',feeAmountMinor: number,depositAmountMinor: number,
) {
  await pool.query(`
    INSERT INTO mbox.community_activities(
      id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
      assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,
      registration_payment_mode,payment_deadline_minutes,payment_rule_text,points_reward,
      visibility,audience_member_levels,audience_lifecycle_stages,safety_policy_version,
      safety_acknowledgement_text,safety_requirements,refund_policy_version,
      refund_policy_summary,activity_details,included_items,participation_requirements,
      contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4,'member_night',$5,'候补自动递补集成测试',
      clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 3 hours',
      'M-BOX陆家嘴店',$6,$7::bigint,$8::bigint,'per_registration',$9,15,
      CASE WHEN $9='none' THEN '本活动无需预付' ELSE '递补后需在15分钟内支付订金' END,
      0,'public','{}'::text[],'{}'::text[],'activity-safety-v1',
      '我已阅读并同意安全要求',ARRAY['须年满18周岁']::text[],
      'activity-refund-v1','按公示退款规则处理','候补自动递补活动完整详情。',
      '{}'::text[],'{}'::text[],'在小程序我的报名中查看递补结果',
      'full',clock_timestamp(),$10::uuid,$10::uuid
    )
  `, [id,tenantId,storeId,publicId,title,capacity,feeAmountMinor,depositAmountMinor,paymentMode,employeeId])
}

async function insertRegistration(
  pool: Pool,id: string,publicId: string,activityId: string,customerId: string,
  partySize: number,status: 'confirmed' | 'waitlisted',
  requestedChoice: 'none' | 'deposit' = 'none',
  requestedMethod: 'jsapi' | null = null,
  requestedAmount = 0,
) {
  await pool.query(`
    INSERT INTO mbox.community_activity_registrations(
      id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,
      payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,
      currency,contact_snapshot,safety_acknowledgement,idempotency_key,
      refund_policy_snapshot,acknowledged_safety_policy_version,
      acknowledged_refund_policy_version,terms_acknowledged_at,
      terms_acknowledgement_source,requested_payment_choice,
      requested_payment_method,requested_amount_due_minor
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,
      'none','not_required',$9::bigint,0,0,'CNY',
      jsonb_build_object('contactType','phone','contactHash',repeat('b',64),
        'encryptedContact','AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
        'encryptionKeyId','normalized-contact-v1','maskedContact','138****8000','source','mini_program'),
      '{}'::jsonb,$10,jsonb_build_object('policyVersion','activity-refund-v1'),
      'activity-safety-v1','activity-refund-v1',clock_timestamp(),'mini_program',
      $11,$12,$13::bigint
    )
  `, [
    id,tenantId,storeId,publicId,activityId,customerId,partySize,status,
    requestedChoice === 'none' ? 0 : 10000,`waitlist-registration-${publicId}`.slice(0,128),
    requestedChoice,requestedMethod,requestedAmount,
  ])
}

async function release(pool: Pool,registrationId: string,status: 'cancelled') {
  await pool.query(`
    UPDATE mbox.community_activity_registrations
    SET status=$4,cancelled_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
  `, [tenantId,storeId,registrationId,status])
}

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(),end: async () => pool.end() }
}
