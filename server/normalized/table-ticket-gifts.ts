import type {ScopedTransaction} from './transaction-runner.js'

// null means a legacy registration: its normal promotion rules still apply.
// The existing promotion worker owns the durable capture fact and retry.
export async function creditTableTicketGifts(tx: ScopedTransaction, registrationId: string, paymentId: string, correction?: {ticketId:string;caseId:string}) {
  const scope=[tx.scope.tenantId,tx.scope.storeId]
  const purchase=(await tx.query<{quantity:number;gift_points:number;membership_id:string;payment_id:string;status:string}>(`
    SELECT p.quantity,o.gift_points,p.membership_id,r.payment_id,r.status
    FROM mbox.table_ticket_purchases p JOIN mbox.table_ticket_offers o
      ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.community_activity_registrations r ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.registration_id=$3`,[...scope,registrationId])).rows[0]
  if (!purchase) return null
  if (purchase.payment_id!==paymentId || purchase.status==='cancelled') return 0
  const tickets=(await tx.query<{id:string;ordinal:number;point_lot_id:string|null;closed:boolean;paid_at:string;expires_at:string}>(`
    SELECT id,ordinal,point_lot_id,(refunded_at IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f
      WHERE (f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id) AND f.status NOT IN('rejected','cancelled'))) closed,paid_at::text,mbox.table_ticket_expiry(paid_at)::text expires_at
    FROM mbox.table_tickets k WHERE tenant_id=$1 AND store_id=$2 AND registration_id=$3 AND payment_id=$4
    ORDER BY ordinal FOR UPDATE`,[...scope,registrationId,paymentId])).rows
  if (tickets.length!==purchase.quantity) throw new Error('足额票款与出票数量待核对')
  if (!purchase.gift_points) return 0
  const account=(await tx.query<{id:string;customer_id:string;available_points:number;pending_recovery_points:number}>(`
    SELECT id,customer_id,available_points,pending_recovery_points FROM mbox.loyalty_accounts
    WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3 FOR UPDATE`,[...scope,purchase.membership_id])).rows[0]
  if (!account || account.pending_recovery_points) throw new Error('票务赠分账户需要复核')
  let balance=account.available_points
  let credited=0
  for (const ticket of tickets) {
    if (ticket.point_lot_id || ticket.closed || (correction && ticket.id!==correction.ticketId)) continue
    balance+=purchase.gift_points
    const params=[...scope,purchase.membership_id,account.customer_id,purchase.gift_points,balance,ticket.id,ticket.paid_at,ticket.expires_at,paymentId,correction?.caseId??ticket.id]
    const ledger=(await tx.query<{id:string}>(`
      INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,
        balance_after,source_type,source_id,reason,idempotency_key,available_at,occurred_at,expires_at,payment_id)
      VALUES($1,$2,$3,$4,'earn',$5,$6,'activity',$7,'整桌门票按原票赠送积分','table-ticket:'||$11,$8,$8,$9,$10)
      RETURNING id`,params)).rows[0]!
    const lot=(await tx.query<{id:string}>(`
      INSERT INTO mbox.loyalty_point_lots(tenant_id,store_id,membership_id,customer_id,source_ledger_entry_id,
        source_type,source_id,original_points,remaining_points,available_at,expires_at,status,ticket_ordinal)
      VALUES($1,$2,$3,$4,$5,'table_ticket',$6,$7,$7,$8,$9,'available',$10) RETURNING id`,
      [...scope,purchase.membership_id,account.customer_id,ledger.id,ticket.id,purchase.gift_points,ticket.paid_at,ticket.expires_at,ticket.ordinal])).rows[0]!
    await tx.query(`INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,
      balance_after,source_type,source_id,idempotency_key,occurred_at)
      VALUES($1,$2,$3,'grant',$4,$4,'table_ticket',$5,'ticket-grant:'||$7,$6)`,
      [...scope,lot.id,purchase.gift_points,ticket.id,ticket.paid_at,correction?.caseId??ticket.id])
    await tx.query('UPDATE mbox.table_tickets SET point_lot_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',
      [...scope,ticket.id,lot.id])
    credited++
  }
  if (credited) {
    await tx.query('UPDATE mbox.loyalty_accounts SET available_points=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,account.id,balance])
    await tx.query('UPDATE mbox.customer_memberships SET points_balance=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope,purchase.membership_id,balance])
  }
  return credited
}
