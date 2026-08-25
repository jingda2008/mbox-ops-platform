import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

interface DueClaimRow extends Record<string, unknown> {
  claim_id: string
  benefit_id: string
  benefit_reservation_id: string
  quantity: string | number
}

export interface AnnualDailySnackExpiryBatch {
  workerId: string
  evaluatedAt: string
  claimed: number
  expiredClaimIds: readonly string[]
}

/**
 * Releases short daily-snack holds that no employee has confirmed in time.
 * The claim, benefit reservation, quantity balance, audit event and outbox
 * message are written in one transaction, so a customer never has a stale
 * "waiting for staff" state after the release is durable.
 */
export class AnnualDailySnackExpiryWorker {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    batchSize = 100,
  ): Promise<AnnualDailySnackExpiryBatch> {
    validateWorkerId(workerId)
    validateBatchSize(batchSize)
    const evaluatedAt = this.now()
    if (!Number.isFinite(Date.parse(evaluatedAt))) throw new TypeError('worker time is invalid')
    return this.transactions.run(scope, async (transaction) => {
      const due = await claimDue(transaction, evaluatedAt, batchSize)
      const expiredClaimIds: string[] = []
      for (const claim of due) {
        await expireClaim(transaction, claim, workerId, evaluatedAt)
        expiredClaimIds.push(claim.claim_id)
      }
      return { workerId, evaluatedAt, claimed: due.length, expiredClaimIds }
    })
  }
}

async function claimDue(
  transaction: ScopedTransaction,
  evaluatedAt: string,
  batchSize: number,
): Promise<DueClaimRow[]> {
  const result = await transaction.query<DueClaimRow>(`
    SELECT claim.id AS claim_id,claim.benefit_id,claim.benefit_reservation_id,reservation.quantity
    FROM mbox.annual_daily_snack_claims AS claim
    JOIN mbox.benefit_reservations AS reservation
      ON reservation.tenant_id=claim.tenant_id AND reservation.store_id=claim.store_id
     AND reservation.id=claim.benefit_reservation_id
    WHERE claim.tenant_id=$1::uuid AND claim.store_id=$2::uuid
      AND claim.status='reserved' AND claim.expires_at<=$3::timestamptz
      AND reservation.status='reserved' AND reservation.expires_at<=$3::timestamptz
    ORDER BY claim.expires_at,claim.id
    FOR UPDATE OF claim,reservation SKIP LOCKED
    LIMIT $4
  `, [transaction.scope.tenantId, transaction.scope.storeId, evaluatedAt, batchSize])
  return result.rows
}

async function expireClaim(
  transaction: ScopedTransaction,
  claim: DueClaimRow,
  workerId: string,
  evaluatedAt: string,
): Promise<void> {
  const reservation = await transaction.query(`
    UPDATE mbox.benefit_reservations
    SET status='expired',completed_at=$4::timestamptz,cancel_reason='daily snack temporary hold expired'
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='reserved'
  `, [transaction.scope.tenantId, transaction.scope.storeId, claim.benefit_reservation_id, evaluatedAt])
  if (reservation.rowCount !== 1) throw new Error(`Daily snack reservation could not expire: ${claim.benefit_reservation_id}`)

  const quantity = Number(claim.quantity)
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`Daily snack reservation quantity is invalid: ${claim.benefit_reservation_id}`)
  const benefit = await transaction.query(`
    UPDATE mbox.benefits
    SET quantity_reserved=quantity_reserved-$4::integer,
        status=CASE WHEN quantity_redeemed=quantity_total THEN 'redeemed' ELSE 'issued' END,
        aggregate_version=aggregate_version+1
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND quantity_reserved>=$4::integer
  `, [transaction.scope.tenantId, transaction.scope.storeId, claim.benefit_id, quantity])
  if (benefit.rowCount !== 1) throw new Error(`Daily snack benefit balance could not release: ${claim.benefit_id}`)

  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events(
      tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
    ) SELECT $1::uuid,$2::uuid,'system',$3,'loyalty.annual-daily-snack.expired',
      'annual_daily_snack_claim',$4::uuid::text,
      (($5::timestamptz AT TIME ZONE store.timezone)-make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
      jsonb_build_object('workerId',$3::text,'benefitReservationId',$6::uuid,'evaluatedAt',$5::timestamptz)
    FROM mbox.stores AS store WHERE store.tenant_id=$1::uuid AND store.id=$2::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, workerId, claim.claim_id, evaluatedAt, claim.benefit_reservation_id])
  if (audit.rowCount !== 1) throw new Error(`Daily snack expiry audit was not recorded: ${claim.claim_id}`)

  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages(
      tenant_id,store_id,message_key,aggregate_type,aggregate_id,aggregate_version,message_type,payload
    ) VALUES($1::uuid,$2::uuid,$3,'annual_daily_snack_claim',$4::uuid,1,'loyalty.annual-daily-snack.expired.v1',
      jsonb_build_object('claimId',$4::uuid,'benefitReservationId',$5::uuid,'workerId',$6::text))
    ON CONFLICT(tenant_id,store_id,message_key) DO NOTHING
  `, [transaction.scope.tenantId, transaction.scope.storeId, `annual-daily-snack-expired:${claim.claim_id}`,
    claim.claim_id, claim.benefit_reservation_id, workerId])
  if (outbox.rowCount !== 1) throw new Error(`Daily snack expiry outbox message was not recorded: ${claim.claim_id}`)
}

function validateWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)) throw new TypeError('workerId is invalid')
}

function validateBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new TypeError('batchSize is invalid')
}
