import {refundReservesAmountSql} from './refund-attempt-sql.js'

function alias(value:string){if(!/^[a-z_]+$/.test(value))throw new TypeError('Invalid refund SQL alias');return value}

/** Original item has fully documented unpaid quantity waivers and no remaining
 * physical work. A generic cancelled line without this evidence stays barred. */
export function fullyWaivedQuantityItemSql(itemAlias:string):string {
  const item=alias(itemAlias)
  return `(${item}.status='cancelled' AND ${item}.total_amount_minor>0
    AND EXISTS(SELECT 1 FROM mbox.item_receivable_adjustments waiver
      WHERE waiver.tenant_id=${item}.tenant_id AND waiver.store_id=${item}.store_id AND waiver.order_id=${item}.order_id AND waiver.order_item_id=${item}.id
      HAVING sum(waiver.quantity)=${item}.quantity AND sum(waiver.amount_minor)=${item}.total_amount_minor)
    AND EXISTS(SELECT 1 FROM mbox.order_item_quantity_units portion
      WHERE portion.tenant_id=${item}.tenant_id AND portion.store_id=${item}.store_id AND portion.order_item_id=${item}.id
      HAVING count(*)=${item}.quantity AND bool_and(portion.operationally_stopped)))`
}

/** Actual captured order shares less effective receivables and all refund
 * reservations. Used under the existing order lock for writes, read-only for UI. */
export function unreservedOrderExcessSql(orderReferenceAlias:string):string {
  const reference=alias(orderReferenceAlias)
  return `GREATEST(0,COALESCE((SELECT sum(receipt.amount_minor) FROM mbox.order_payment_facts receipt
    WHERE receipt.tenant_id=${reference}.tenant_id AND receipt.store_id=${reference}.store_id AND receipt.order_id=${reference}.order_id
      AND receipt.status IN ('succeeded','partially_refunded','refunded')),0)
    -mbox.order_receivable_amount(${reference}.tenant_id,${reference}.store_id,${reference}.order_id)
    -COALESCE((SELECT sum(reserved_refund.amount_minor) FROM mbox.order_refund_facts reserved_refund
      WHERE reserved_refund.tenant_id=${reference}.tenant_id AND reserved_refund.store_id=${reference}.store_id
        AND reserved_refund.order_id=${reference}.order_id AND ${refundReservesAmountSql('reserved_refund')}),0))`
}
