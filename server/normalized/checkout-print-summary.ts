import { orderCollectionDueSql, orderNeedsCollectionSql, orderReceivableSql } from './order-collection-sql.js'
import type { ScopedTransaction } from './transaction-runner.js'

/** Read confirmed, per-order allocations; a pending channel attempt is never cash. */
export async function readCheckoutPrintSummary(tx: ScopedTransaction, orderIds: readonly string[]) {
  const { rows } = await tx.query<{
    receivable: string; received: string; refunded: string; pending: string; due: string; needs_collection: boolean
  }>(`
    SELECT CASE WHEN ordering.status='cancelled' THEN 0 ELSE ${orderReceivableSql('ordering')} END::text AS receivable,
      amounts.received::text, amounts.refunded::text, amounts.pending::text,
      CASE WHEN ${orderNeedsCollectionSql('ordering')}
        THEN ${orderCollectionDueSql('ordering')}
        ELSE 0 END::text AS due,
      ${orderNeedsCollectionSql('ordering')} AS needs_collection
    FROM mbox.orders ordering
    CROSS JOIN LATERAL (SELECT
      COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p
        WHERE p.tenant_id=ordering.tenant_id AND p.store_id=ordering.store_id AND p.order_id=ordering.id
          AND p.status IN ('succeeded','partially_refunded','refunded')),0) AS received,
      COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r
        WHERE r.tenant_id=ordering.tenant_id AND r.store_id=ordering.store_id AND r.order_id=ordering.id
          AND r.status='succeeded'),0) AS refunded,
      COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p
        WHERE p.tenant_id=ordering.tenant_id AND p.store_id=ordering.store_id AND p.order_id=ordering.id
          AND p.status='pending'),0) AS pending
    ) amounts
    WHERE ordering.tenant_id=$1 AND ordering.store_id=$2 AND ordering.id=ANY($3::uuid[])
      AND ordering.status<>'draft'
  `, [tx.scope.tenantId, tx.scope.storeId, orderIds])
  if (rows.length !== orderIds.length) throw new Error('结账汇总订单不完整')
  const sum = (key: 'receivable' | 'received' | 'refunded' | 'pending' | 'due') => {
    let result = 0
    for (const row of rows) {
      const value = Number(row[key])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('结账汇总金额无效')
      result += value
      if (!Number.isSafeInteger(result)) throw new Error('结账汇总金额超出有效范围')
    }
    return result
  }
  const received = sum('received'), refunded = sum('refunded')
  if (refunded > received) throw new Error('结账退款超过实际收款')
  return {
    receivable: sum('receivable'), received, refunded, net: received - refunded,
    pending: sum('pending'), due: sum('due'),
    state: received === 0 ? 'unpaid' as const
      : rows.some(row => row.needs_collection) ? 'partial' as const : 'paid' as const,
  }
}
