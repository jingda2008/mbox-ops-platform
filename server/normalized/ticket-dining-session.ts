import type {ScopedTransaction} from './transaction-runner.js'

export async function recognizeDiningTicket(tx: ScopedTransaction, sessionId:string, customerId:string) {
  const scope=[tx.scope.tenantId,tx.scope.storeId,sessionId,customerId]
  // The scan already locks the current table session. Lock candidate tickets
  // before taking the fresh snapshot that checks refund and seating state.
  const locked=await tx.query<{id:string}>(`SELECT k.id FROM mbox.table_sessions ss
    JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.table_id)=(ss.tenant_id,ss.store_id,ss.table_id)
    JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.reservation_lock_id)=(l.tenant_id,l.store_id,l.id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
    WHERE (ss.tenant_id,ss.store_id,ss.id)=($1,$2,$3) AND ss.status='open' AND l.status='confirmed'
      AND mbox.canonical_customer_id($1,$2,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)
      AND r.payment_status='paid' AND k.refunded_at IS NULL
      AND l.reserved_during @> statement_timestamp()
    ORDER BY k.id LIMIT 2 FOR UPDATE OF k`,scope)
  if (!locked.rowCount) return false
  const linked = await tx.query(`WITH candidates AS MATERIALIZED (
    SELECT k.id FROM mbox.table_sessions ss
    JOIN mbox.reservation_table_locks l ON (l.tenant_id,l.store_id,l.table_id)=(ss.tenant_id,ss.store_id,ss.table_id)
    JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.reservation_lock_id)=(l.tenant_id,l.store_id,l.id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(k.tenant_id,k.store_id,k.registration_id)
    LEFT JOIN mbox.ticket_reschedule_offers m ON m.id=k.reschedule_id
    JOIN mbox.community_activities a ON a.id=coalesce(m.activity_id,r.activity_id)
    WHERE (ss.tenant_id,ss.store_id,ss.id)=($1,$2,$3) AND ss.status='open' AND l.status='confirmed'
      AND k.refunded_at IS NULL AND r.status IN ('confirmed','checked_in') AND r.payment_status='paid'
      AND a.status IN ('published','completed') AND statement_timestamp()>=coalesce(m.starts_at,p.starts_at)
      AND statement_timestamp()<coalesce(m.ends_at,p.ends_at) AND mbox.canonical_customer_id($1,$2,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)
      AND NOT EXISTS(SELECT 1 FROM mbox.ticket_seating($1,$2,l.id))
      AND NOT EXISTS(SELECT 1 FROM mbox.reservation_seating_sessions seat WHERE (seat.tenant_id,seat.store_id,seat.table_session_id)=($1,$2,$3))
      AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f WHERE f.ticket_id=k.id AND f.status NOT IN ('cancelled','rejected'))
    AND k.id=ANY($5::uuid[])
  ) INSERT INTO mbox.ticket_dining_sessions(tenant_id,store_id,session_id,ticket_id)
    SELECT $1,$2,$3,id FROM candidates WHERE (SELECT count(*) FROM candidates)=1 ON CONFLICT DO NOTHING`,
    [...scope,locked.rows.map(row=>row.id)])
  return linked.rowCount === 1
}

export class DiningTicketRequiredError extends Error {
  constructor() { super('本场仅限持票顾客点单，请用购票会员账号扫描已安排的桌码后点单。') }
}
