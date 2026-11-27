import type { ScopedTransaction } from './transaction-runner.js'

/** Show the original dining receipts paid with this ticket's points, including
 * returns separately. A mixed payment only exposes this ticket's share. */
export async function customerTicketDining(tx: ScopedTransaction, customerId: string, ticketId: string) {
  return (await tx.query(`
    WITH allocations AS (
      SELECT a.quote_id, a.lot_id, a.points, a.restored_points
      FROM mbox.table_tickets k
      JOIN mbox.table_ticket_purchases p USING (tenant_id,store_id,registration_id)
      JOIN mbox.community_activity_registrations r
        ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
      JOIN mbox.loyalty_point_lots own
        ON (own.tenant_id,own.store_id,own.id,own.membership_id)=(k.tenant_id,k.store_id,k.point_lot_id,p.membership_id)
      JOIN mbox.checkout_point_lots a ON (a.tenant_id,a.store_id)=(k.tenant_id,k.store_id)
        AND a.lot_id IN (SELECT mbox.ticket_spending_lots(k.tenant_id,k.store_id,k.point_lot_id))
      JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(a.tenant_id,a.store_id,a.quote_id)
      WHERE k.tenant_id=$1 AND k.store_id=$2 AND k.id=$3 AND h.status='consumed'
        AND mbox.canonical_customer_id($1,$2,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)
    ), by_quote AS (
      SELECT quote_id, sum(points)::int AS used, sum(restored_points)::int AS restored
      FROM allocations GROUP BY quote_id
    )
    SELECT o.public_id AS "orderNo", o.created_at::text AS "createdAt", b.used, b.restored,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',line.portion_id,'name',coalesce(i.product_snapshot->>'name',pr.name),
          'originalMinor',CASE WHEN line.tab_item_id IS NULL THEN line.standard_minor ELSE i.unit_price_minor*i.quantity END,
          'discountMinor',amount.discount) ORDER BY line.request_index)
        FROM (SELECT s.portion_id,sum(s.amount_minor) AS discount FROM allocations a
          JOIN mbox.checkout_point_portion_sources s ON s.tenant_id=$1 AND s.store_id=$2
            AND s.quote_id=a.quote_id AND s.lot_id=a.lot_id
          WHERE a.quote_id=b.quote_id GROUP BY s.portion_id) amount
        JOIN mbox.checkout_coupon_quote_lines line ON line.tenant_id=$1 AND line.store_id=$2
          AND line.quote_id=b.quote_id AND line.portion_id=amount.portion_id
        JOIN mbox.products pr ON pr.tenant_id=$1 AND pr.store_id=$2 AND pr.id=line.product_id
        LEFT JOIN mbox.checkout_portion_order_items m ON (m.tenant_id,m.store_id,m.quote_id,m.portion_id)
          =(line.tenant_id,line.store_id,line.quote_id,line.portion_id)
        LEFT JOIN mbox.order_items i ON i.tenant_id=$1 AND i.store_id=$2 AND i.order_id=o.id AND i.id=m.order_item_id
      ),'[]'::jsonb) AS items
    FROM by_quote b JOIN mbox.checkout_coupon_order_links l ON l.tenant_id=$1 AND l.store_id=$2 AND l.quote_id=b.quote_id
    JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(l.tenant_id,l.store_id,l.order_id)
    ORDER BY o.created_at DESC,o.id`, [tx.scope.tenantId,tx.scope.storeId,ticketId,customerId])).rows
}
