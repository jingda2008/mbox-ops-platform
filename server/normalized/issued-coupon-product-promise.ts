import type { ScopedTransaction } from './transaction-runner.js'
import type { SubmitOrderLineInput } from './order-repository.js'
import { CouponCalendarError } from './coupon-calendar.js'
import { CouponCalendarRepository } from './coupon-calendar-repository.js'

export class IssuedCouponPromiseError extends Error {}

/** Internal references to already issued fixed-price promises, never a price or
 * availability override supplied by a customer. Every use is checked below. */
export interface IssuedCouponProductLine {
  requestIndex: number
  benefitId: string
}

export async function verifyIssuedCouponProductLines(
  tx: ScopedTransaction,
  customerId: string | null,
  lines: readonly SubmitOrderLineInput[],
  promises: readonly IssuedCouponProductLine[],
): Promise<void> {
  if (!promises.length) return
  if (!customerId || new Set(promises.map(p => p.requestIndex)).size !== promises.length) {
    throw new IssuedCouponPromiseError('请使用本人有效券，并为每份商品选择一张券')
  }
  const scope = [tx.scope.tenantId, tx.scope.storeId]
  const calendars = new CouponCalendarRepository(tx)
  for (const benefitId of new Set(promises.map(p => p.benefitId))) {
    const selected = promises.filter(p => p.benefitId === benefitId)
    if (selected.some(p => !Number.isInteger(p.requestIndex) || !lines[p.requestIndex])) throw new IssuedCouponPromiseError('券对应的商品份次无效')
    const quantity = selected.reduce((sum, p) => sum + lines[p.requestIndex]!.quantity, 0)
    const result = await tx.query<{ product_ids: string[] }>(`
      SELECT ARRAY(SELECT pool.product_id FROM mbox.member_gift_campaign_products pool
        WHERE pool.tenant_id=b.tenant_id AND pool.store_id=b.store_id
          AND pool.campaign_version_id=promise.campaign_version_id) AS product_ids
      FROM mbox.benefits b JOIN mbox.benefit_coupon_price_promises promise
        ON promise.tenant_id=b.tenant_id AND promise.store_id=b.store_id AND promise.benefit_id=b.id
      WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.id=$3
        AND mbox.canonical_customer_id(b.tenant_id,b.store_id,b.customer_id)=mbox.canonical_customer_id($1,$2,$4)
        AND b.status IN('issued','reserved') AND b.valid_from<=clock_timestamp()
        AND (b.valid_until IS NULL OR b.valid_until>clock_timestamp())
        AND b.quantity_total-b.quantity_reserved-b.quantity_redeemed >= $5
    `, [...scope, benefitId, customerId, quantity])
    const row = result.rows[0]
    if (!row || selected.some(p => !row.product_ids.includes(lines[p.requestIndex]!.productId))) {
      throw new IssuedCouponPromiseError('原券不属于本人、已失效、次数不足或不适用于该商品')
    }
    if (!await calendars.authorizeReservation(benefitId, customerId, quantity)) throw new IssuedCouponPromiseError('原券缺少有效的使用时间规则')
  }
}

/** Only informs the existing cart that coupon confirmation is possible. It
 * never marks a hidden item as ordinarily purchasable or reserves a coupon. */
export async function canReviewIssuedCouponProduct(tx: ScopedTransaction, customerId: string | null, productId: string): Promise<boolean> {
  if (!customerId) return false
  const rows = await tx.query<{ id: string }>(`
    SELECT b.id FROM mbox.benefits b JOIN mbox.benefit_coupon_price_promises promise
      ON promise.tenant_id=b.tenant_id AND promise.store_id=b.store_id AND promise.benefit_id=b.id
    JOIN mbox.member_gift_campaign_products pool ON pool.tenant_id=promise.tenant_id AND pool.store_id=promise.store_id
      AND pool.campaign_version_id=promise.campaign_version_id AND pool.product_id=$4
    JOIN mbox.products product ON product.tenant_id=pool.tenant_id AND product.store_id=pool.store_id AND product.id=pool.product_id AND product.status='active'
    JOIN mbox.stores store ON store.tenant_id=product.tenant_id AND store.id=product.store_id
    WHERE b.tenant_id=$1 AND b.store_id=$2 AND 'guest_qr'=ANY(product.allowed_channels) AND (${legacyProductDeadlineSql()}) IS NOT NULL
      AND mbox.canonical_customer_id(b.tenant_id,b.store_id,b.customer_id)=mbox.canonical_customer_id($1,$2,$3)
      AND b.status IN('issued','reserved') AND b.quantity_total>b.quantity_reserved+b.quantity_redeemed
      AND b.valid_from<=clock_timestamp() AND (b.valid_until IS NULL OR b.valid_until>clock_timestamp())
    ORDER BY b.valid_until NULLS LAST,b.id LIMIT 20
  `, [tx.scope.tenantId, tx.scope.storeId, customerId, productId])
  for (const row of rows.rows) {
    try {
      await verifyIssuedCouponProductLines(tx, customerId, [{ productId, quantity: 1 }], [{ requestIndex: 0, benefitId: row.id }])
      return true
    } catch (error) {
      // Eligibility failures are ordinary empty states. Database failures must
      // still abort rather than returning a misleading available cart.
      if (!(error instanceof IssuedCouponPromiseError) && !(error instanceof CouponCalendarError)) throw error
    }
  }
  return false
}

/** Pre-existing daily operating hours remain a constraint. Only the new service
 * windows and menu visibility are exempted for an issued promise. Aliases are
 * internal constants, never customer input. */
export function legacyProductDeadlineSql(product = 'product', store = 'store'): string {
  const local = `(clock_timestamp() AT TIME ZONE ${store}.timezone)`
  return `CASE WHEN ${product}.available_from IS NULL OR ${product}.available_until IS NULL THEN 'infinity'::timestamptz
    WHEN (${product}.available_from<${product}.available_until AND ${local}::time>=${product}.available_from AND ${local}::time<${product}.available_until)
      OR (${product}.available_from>=${product}.available_until AND (${local}::time>=${product}.available_from OR ${local}::time<${product}.available_until))
    THEN ((${local}::date + ${product}.available_until) + CASE WHEN ${product}.available_from>=${product}.available_until AND ${local}::time>=${product}.available_from THEN interval '1 day' ELSE interval '0 day' END) AT TIME ZONE ${store}.timezone
    ELSE NULL END`
}
