import {createHash} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'

// Resolve an exact original receipt, ticket identifier or admission code. Reading it never admits a guest.
export async function ticketRefundPreview(tx:ScopedTransaction,reference:string) {
  const matchTicket=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(reference)
  const lookup=matchTicket?'k.id=$3::uuid':/^AP[a-f0-9]{32}$/i.test(reference)?'pay.public_id=$3':
    /^[A-F0-9]{12}$/.test(reference)?'k.door_code=$3':'r.public_id=$3'
  const result=await tx.query(`SELECT r.public_id AS "orderNo",k.id,k.ordinal,p.quantity,o.name,m.member_no AS "memberNo",
    c.masked_value AS "maskedPhone",tab.display_name AS "tableName",o.price_minor AS "priceMinor",o.gift_points AS "giftPoints",
    r.refund_policy_snapshot->>'schedule' AS "refundSchedule",pay.public_id AS receipt,
    CASE WHEN pay.status IN('succeeded','partially_refunded') THEN greatest(0,least(o.price_minor,pay.amount_minor-reserved.amount)) ELSE 0 END::int AS "refundLimit",
    CASE WHEN lot.membership_id=p.membership_id AND lot.status IN('available','ticket_hold') AND lot.expires_at>statement_timestamp()
      THEN lot.remaining_points ELSE 0 END AS recoverable,
    basis.consumed_minor::text AS "consumedMinor",basis.unresolved,
    f.id AS "caseId",f.status AS "caseStatus",f.refund_id AS "refundId",cash.status AS "cashStatus"
    FROM mbox.table_ticket_purchases p JOIN mbox.community_activity_registrations r ON(r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
    JOIN mbox.table_ticket_offers o ON(o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    JOIN mbox.table_tickets k ON(k.tenant_id,k.store_id,k.registration_id)=(p.tenant_id,p.store_id,p.registration_id)
    JOIN mbox.customer_memberships m ON(m.tenant_id,m.store_id,m.id)=(p.tenant_id,p.store_id,p.membership_id)
    JOIN mbox.customer_verified_contacts c ON(c.tenant_id,c.store_id,c.id)=(p.tenant_id,p.store_id,p.contact_id)
    JOIN mbox.payments pay ON(pay.tenant_id,pay.store_id,pay.id)=(k.tenant_id,k.store_id,k.payment_id)
    LEFT JOIN mbox.loyalty_point_lots lot ON(lot.tenant_id,lot.store_id,lot.id)=(k.tenant_id,k.store_id,k.point_lot_id)
    LEFT JOIN mbox.reservation_table_locks l ON(l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.reservation_lock_id)
    LEFT JOIN mbox.tables tab ON(tab.tenant_id,tab.store_id,tab.id)=(l.tenant_id,l.store_id,mbox.ticket_current_table(l.tenant_id,l.store_id,l.id))
    LEFT JOIN mbox.table_ticket_refund_requests f ON(f.tenant_id,f.store_id,f.ticket_id)=(k.tenant_id,k.store_id,k.id) AND f.status NOT IN('cancelled','rejected')
    LEFT JOIN mbox.refunds cash ON(cash.tenant_id,cash.store_id,cash.id)=(f.tenant_id,f.store_id,f.refund_id)
    CROSS JOIN LATERAL mbox.ticket_refund_basis(k.tenant_id,k.store_id,k.id) basis
    CROSS JOIN LATERAL (SELECT coalesce(sum(rb.amount_minor),0) amount FROM mbox.refunds rb
      WHERE(rb.tenant_id,rb.store_id,rb.payment_id)=(pay.tenant_id,pay.store_id,pay.id)
      AND (rb.status IN('requested','approved','processing','succeeded') OR (rb.status='failed' AND rb.approved_by_employee_id IS NOT NULL))) reserved
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND ${lookup}
    ORDER BY k.ordinal`,[tx.scope.tenantId,tx.scope.storeId,reference])
  return result.rows.map(row=>({...row,previewVersion:createHash('sha256').update(JSON.stringify([
    row.id,row.memberNo,row.priceMinor,row.giftPoints,row.recoverable,row.consumedMinor,row.unresolved,row.refundLimit,row.caseId,row.caseStatus,row.cashStatus,
  ])).digest('hex')}))
}

export async function ticketDiningHandoffs(tx:ScopedTransaction){
  return (await tx.query(`WITH pending AS (
    SELECT f.id AS case_id,c.order_id,o.public_id AS order_no,k.id AS ticket,c.amount_minor AS due,c.merchant_minor,
      c.consented_at IS NOT NULL AS confirmed,
      pay.id IS NULL OR pay.status IN('failed','cancelled') AS collectable,
      c.amount_minor=0 OR (coalesce(pay.status='succeeded' AND pay.order_id=c.order_id AND pay.amount_minor=c.amount_minor,false)
        AND NOT EXISTS(SELECT 1 FROM mbox.refunds rb WHERE (rb.tenant_id,rb.store_id,rb.payment_id)=(c.tenant_id,c.store_id,pay.id)
        AND rb.status NOT IN('cancelled','rejected'))) AS paid
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON(k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.ticket_dining_collections c ON(c.tenant_id,c.store_id,c.case_id)=(f.tenant_id,f.store_id,f.id)
    JOIN mbox.orders o ON(o.tenant_id,o.store_id,o.id)=(c.tenant_id,c.store_id,c.order_id)
    LEFT JOIN mbox.payments pay ON(pay.tenant_id,pay.store_id,pay.id)=(c.tenant_id,c.store_id,c.payment_id)
    WHERE f.tenant_id=$1 AND f.store_id=$2 AND f.status='review' AND f.close_intent IS NULL AND c.superseded_at IS NULL
  ), per_case AS (
    SELECT case_id,ticket,bool_and(confirmed AND paid) AS ready,sum(due+coalesce(merchant_minor,0)) AS compared
    FROM pending GROUP BY case_id,ticket
  )
  SELECT p.ticket,p.case_id AS "caseId",'collect' AS step,p.order_no AS "orderNo",p.due::text AS amount
  FROM pending p WHERE p.confirmed AND p.due>0 AND NOT p.paid AND p.collectable
  UNION ALL
  SELECT c.ticket,c.case_id,'review',NULL,NULL FROM per_case c
  CROSS JOIN LATERAL mbox.ticket_refund_basis($1,$2,c.ticket) b
  WHERE c.ready AND NOT b.unresolved AND b.consumed_minor=c.compared
  ORDER BY "caseId","orderNo"`,[tx.scope.tenantId,tx.scope.storeId])).rows
}
