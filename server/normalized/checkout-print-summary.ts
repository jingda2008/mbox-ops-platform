import { orderCollectionDueSql, orderNeedsCollectionSql,orderReceivableSql } from './order-collection-sql.js'
import {hasCarryoverDebtSchema} from './carryover-debt.js'
import type { ScopedTransaction } from './transaction-runner.js'

/** Read confirmed, per-order allocations; a pending channel attempt is never cash. */
export async function readCheckoutPrintSummary(tx: ScopedTransaction, orderIds: readonly string[]) {
  const carryover=await hasCarryoverDebtSchema(tx)
  const needsCollection=carryover?orderNeedsCollectionSql('ordering'):`(ordering.status NOT IN('draft','cancelled') AND ${orderCollectionDueSql('ordering')}>0)`
  const { rows } = await tx.query<{
    receivable: string; received: string; refunded: string; pending: string; due: string; needs_collection: boolean; consumption_settled: boolean; carryover?:boolean
  }>(`
    SELECT CASE WHEN ordering.status='cancelled' AND ${carryover?"debt.eligibility IS DISTINCT FROM 'confirmed'":'true'} THEN 0
      ELSE ${carryover?'mbox.order_financial_receivable_amount(ordering.tenant_id,ordering.store_id,ordering.id)':orderReceivableSql('ordering')} END::text AS receivable,
      ${carryover?"debt.eligibility='confirmed'":'false'} AS carryover,
      amounts.received::text, amounts.refunded::text, amounts.pending::text,
      CASE WHEN ${needsCollection}
        THEN ${orderCollectionDueSql('ordering')}
        ELSE 0 END::text AS due,
      ${needsCollection} AS needs_collection,
      mbox.order_consumption_settled(ordering.tenant_id,ordering.store_id,ordering.id) AS consumption_settled
    FROM mbox.orders ordering
    ${carryover?'LEFT JOIN mbox.order_carryover_debts debt ON (debt.tenant_id,debt.store_id,debt.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)':''}
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
    ...(rows.some(row=>row.carryover)?{carryover:true}:{}),
    receivable: sum('receivable'), received, refunded, net: received - refunded,
    pending: sum('pending'), due: sum('due'),
    state: received === 0 && !rows.some(row => row.consumption_settled) ? 'unpaid' as const
      : rows.some(row => row.needs_collection) ? 'partial' as const : 'paid' as const,
  }
}
