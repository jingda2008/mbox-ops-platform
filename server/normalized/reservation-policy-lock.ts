import type {ScopedTransaction} from './transaction-runner.js'

/** Also acquired by the policy mutation trigger. Keep policy snapshots and
 * capacity checks serialized without granting runtime policy UPDATE rights. */
export async function lockReservationPolicy(transaction: ScopedTransaction): Promise<void> {
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended(
    'reservation-policy:'||$1::uuid::text||':'||$2::uuid::text,0))`,
  [transaction.scope.tenantId, transaction.scope.storeId])
}
