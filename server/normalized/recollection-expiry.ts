import type { ScopedTransaction } from './transaction-runner.js'

/** Close expired authorizations without touching a payment or reopening a refund. */
export async function expireRecollectionAuthorizations(transaction: ScopedTransaction, limit = 50): Promise<void> {
  for (const table of ['order_recollection_authorizations', 'activity_registration_recollection_authorizations'] as const) {
    await transaction.query(`
      WITH due AS (
        SELECT id FROM mbox.${table}
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND status='active' AND expires_at<=clock_timestamp()
        ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $3
      ), expired AS (
        UPDATE mbox.${table} grant_row SET status='expired'
        FROM due WHERE grant_row.id=due.id
          AND grant_row.tenant_id=$1::uuid AND grant_row.store_id=$2::uuid
          AND grant_row.status='active' AND grant_row.expires_at<=clock_timestamp()
        RETURNING grant_row.id,grant_row.expires_at
      )
      INSERT INTO mbox.audit_events(
        tenant_id,store_id,actor_type,actor_ref,action,object_type,object_id,business_date,metadata
      )
      SELECT $1::uuid,$2::uuid,'system','recollection-expiry','payment.recollection_expired',
        '${table}',expired.id::text,
        ((clock_timestamp() AT TIME ZONE store.timezone)
          -make_interval(secs=>extract(epoch FROM store.business_day_cutoff)))::date,
        jsonb_build_object('previousStatus','active','status','expired','expiresAt',expired.expires_at)
      FROM expired JOIN mbox.stores store ON store.tenant_id=$1::uuid AND store.id=$2::uuid
    `, [transaction.scope.tenantId, transaction.scope.storeId, limit])
  }
}
