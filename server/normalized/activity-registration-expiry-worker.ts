import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface DueActivityRegistration extends Record<string, unknown> {
  id: string
  public_id: string
  payment_id: string | null
  payment_state: 'none' | 'terminal' | 'unknown' | 'captured' | 'amount_mismatch'
  captured_amount_minor: string | number | null
}

export interface ActivityRegistrationExpiryBatch {
  workerId: string
  claimed: number
  releasedRegistrationIds: readonly string[]
  confirmedRegistrationIds: readonly string[]
  reviewRegistrationIds: readonly string[]
}

export class ActivityRegistrationExpiryWorker {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  runBatch(scope: Readonly<StoreScope>, workerId: string, batchSize = 50): Promise<ActivityRegistrationExpiryBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    return this.transactions.run(scope, async (transaction) => {
      const due = await claimDue(transaction, batchSize)
      const releasedRegistrationIds: string[] = []
      const confirmedRegistrationIds: string[] = []
      const reviewRegistrationIds: string[] = []
      for (const registration of due) {
        if (registration.payment_state === 'unknown' || registration.payment_state === 'amount_mismatch') {
          await transaction.query(`
            UPDATE mbox.community_activity_registrations
            SET seat_hold_expires_at = clock_timestamp() + interval '15 minutes',
              updated_at = clock_timestamp(),
              contact_snapshot = contact_snapshot || jsonb_build_object(
                'paymentReviewReason', $4,
                'paymentReviewAt', clock_timestamp()
              )
            WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              AND status = 'payment_pending' AND payment_status = 'pending'
          `, [transaction.scope.tenantId, transaction.scope.storeId, registration.id, registration.payment_state])
          reviewRegistrationIds.push(registration.id)
          await recordReview(transaction, registration, workerId, registration.payment_state)
          continue
        }
        if (registration.payment_state === 'captured') {
          const capturedAmount = money(registration.captured_amount_minor)
          await transaction.query(`
            UPDATE mbox.community_activity_registrations
            SET status = 'confirmed', payment_status = 'paid', amount_due_minor = 0,
              paid_amount_minor = LEAST(fee_amount_minor, $4::bigint), updated_at = clock_timestamp()
            WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              AND status = 'payment_pending' AND payment_status = 'pending'
          `, [transaction.scope.tenantId, transaction.scope.storeId, registration.id, capturedAmount])
          confirmedRegistrationIds.push(registration.id)
          await recordResolution(transaction, registration, workerId, 'confirmed')
          continue
        }
        await transaction.query(`
          UPDATE mbox.community_activity_registrations
          SET status = 'cancelled', payment_status = 'expired', amount_due_minor = 0,
            cancelled_at = clock_timestamp(), updated_at = clock_timestamp(),
            contact_snapshot = contact_snapshot || '{"cancellationReason":"payment_deadline_expired"}'::jsonb
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND status = 'payment_pending' AND payment_status = 'pending'
        `, [transaction.scope.tenantId, transaction.scope.storeId, registration.id])
        releasedRegistrationIds.push(registration.id)
        await recordResolution(transaction, registration, workerId, 'released')
      }
      return { workerId, claimed: due.length, releasedRegistrationIds, confirmedRegistrationIds, reviewRegistrationIds }
    })
  }
}

async function claimDue(transaction: ScopedTransaction, batchSize: number): Promise<DueActivityRegistration[]> {
  const result = await transaction.query<DueActivityRegistration>(`
    SELECT registration.id, registration.public_id, registration.payment_id,
      CASE
        WHEN payment.status = 'succeeded' AND payment.amount_minor >= registration.amount_due_minor THEN 'captured'
        WHEN payment.status = 'succeeded' THEN 'amount_mismatch'
        WHEN payment.status IN ('created', 'pending', 'partially_refunded') THEN 'unknown'
        WHEN payment.status = 'refunded' THEN 'terminal'
        WHEN payment.id IS NOT NULL THEN 'terminal'
        ELSE 'none'
      END AS payment_state,
      CASE WHEN payment.status = 'succeeded'
        THEN payment.amount_minor ELSE NULL END AS captured_amount_minor
    FROM mbox.community_activity_registrations AS registration
    LEFT JOIN mbox.payments AS payment
      ON payment.tenant_id = registration.tenant_id
     AND payment.store_id = registration.store_id
     AND payment.id = registration.payment_id
    WHERE registration.tenant_id = $1::uuid AND registration.store_id = $2::uuid
      AND registration.status = 'payment_pending' AND registration.payment_status = 'pending'
      AND registration.seat_hold_expires_at <= clock_timestamp()
    ORDER BY registration.seat_hold_expires_at, registration.id
    FOR UPDATE OF registration SKIP LOCKED
    LIMIT $3
  `, [transaction.scope.tenantId, transaction.scope.storeId, batchSize])
  return result.rows
}

async function recordReview(
  transaction: ScopedTransaction,
  registration: Readonly<Pick<DueActivityRegistration, 'id' | 'public_id'>>,
  workerId: string,
  reason: 'unknown' | 'amount_mismatch',
): Promise<void> {
  await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $4, 'community.activity.payment_review_required',
      'community_activity_registration', $3::uuid::text,
      ((clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff)))::date,
      jsonb_build_object('workerId', $4, 'reason', $5)
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, registration.id, workerId, reason])
  await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'community_activity_registration', $4::uuid,
      1, 'community.activity.payment_review_required.v1',
      jsonb_build_object('registrationPublicId', $5, 'workerId', $6, 'reason', $7)
    ) ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `activity-registration-review:${registration.id}:${reason}`,
    registration.id,
    registration.public_id,
    workerId,
    reason,
  ])
}

async function recordResolution(
  transaction: ScopedTransaction,
  registration: Readonly<Pick<DueActivityRegistration, 'id' | 'public_id'>>,
  workerId: string,
  resolution: 'released' | 'confirmed',
): Promise<void> {
  const action = resolution === 'released'
    ? 'community.activity.payment_hold_expired'
    : 'community.activity.payment_confirmed'
  await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_ref, action,
      object_type, object_id, business_date, metadata
    )
    SELECT $1::uuid, $2::uuid, 'system', $4, $5,
      'community_activity_registration', $3::uuid::text,
      ((clock_timestamp() AT TIME ZONE store.timezone)
        - make_interval(secs => extract(epoch FROM store.business_day_cutoff)))::date,
      jsonb_build_object('workerId', $4, 'resolution', $6)
    FROM mbox.stores AS store
    WHERE store.tenant_id = $1::uuid AND store.id = $2::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, registration.id, workerId, action, resolution])
  await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'community_activity_registration', $4::uuid,
      1, $5, jsonb_build_object('registrationPublicId', $6, 'workerId', $7, 'resolution', $8)
    ) ON CONFLICT (tenant_id, store_id, message_key) DO NOTHING
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `activity-registration-${resolution}:${registration.id}`,
    registration.id,
    `${action}.v1`,
    registration.public_id,
    workerId,
    resolution,
  ])
}

function money(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('captured activity payment amount is invalid')
  return number
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(value)) throw new TypeError('workerId must be a stable internal identifier')
}

function validateBatchSize(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new TypeError('batchSize must be an integer between 1 and 50')
}
