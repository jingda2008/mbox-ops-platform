import type { ScopedTransaction } from './transaction-runner.js'

export type TableSessionClosureBlockerCode =
  | 'ORDER_UNSETTLED'
  | 'ORDER_ITEM_UNRESOLVED'
  | 'KDS_ACTIVE'
  | 'PAYMENT_PENDING'
  | 'INVENTORY_RESERVED'
  | 'REFUND_PENDING'
  | 'SERVICE_ACTIVE'
  | 'PRICING_RESERVED'
  | 'SONG_ACTIVE'
  | 'BENEFIT_RESERVED'
  | 'EXPERIENCE_ACTIVE'
  | 'REDEMPTION_PENDING'
  | 'CHECKOUT_OFFER_ACTIVE'

export type TableSessionClosureBlockerKey =
  | 'order_unsettled'
  | 'order_item_unresolved'
  | 'kds_active'
  | 'payment_pending'
  | 'inventory_reserved'
  | 'refund_pending'
  | 'service_active'
  | 'pricing_reserved'
  | 'song_active'
  | 'benefit_reserved'
  | 'experience_active'
  | 'redemption_pending'
  | 'checkout_offer_active'

export interface TableSessionClosureBlocker {
  code: TableSessionClosureBlockerCode
  key: TableSessionClosureBlockerKey
  count: number
  label: string
  resolution: string
}

export interface TableSessionClosureState {
  blockers: TableSessionClosureBlocker[]
  outstandingOrderCount: number
  outstandingAmountMinor: number
}

interface ClosureCountRow extends Record<string, unknown> {
  order_unsettled: string
  order_item_unresolved: string
  kds_active: string
  payment_pending: string
  inventory_reserved: string
  refund_pending: string
  service_active: string
  pricing_reserved: string
  song_active: string
  benefit_reserved: string
  experience_active: string
  redemption_pending: string
  checkout_offer_active: string
  outstanding_order_count: string
  outstanding_amount_minor: string
}

export const tableSessionClosureBlockerDefinitions = [
  ['ORDER_UNSETTLED', 'order_unsettled', '未结订单', '请先完成付款、退款、订单完成或取消流程'],
  ['ORDER_ITEM_UNRESOLVED', 'order_item_unresolved', '未完成出品', '请先完成或取消相关订单行'],
  ['KDS_ACTIVE', 'kds_active', '进行中的出品任务', '请先完成或取消相关出品任务'],
  ['PAYMENT_PENDING', 'payment_pending', '待确认付款', '请先确认付款终态'],
  ['INVENTORY_RESERVED', 'inventory_reserved', '库存预留', '请先完成订单扣减或释放库存预留'],
  ['REFUND_PENDING', 'refund_pending', '处理中退款', '请先完成退款流程'],
  ['SERVICE_ACTIVE', 'service_active', '进行中的服务任务', '请先完成或取消服务任务'],
  ['PRICING_RESERVED', 'pricing_reserved', '占用中的定价授权', '请先完成或释放定价授权'],
  ['SONG_ACTIVE', 'song_active', '进行中的点歌请求', '请先完成或取消点歌请求'],
  ['BENEFIT_RESERVED', 'benefit_reserved', '占用中的会员权益', '请先完成或释放权益'],
  ['EXPERIENCE_ACTIVE', 'experience_active', '进行中的体验计划', '请先完成或结束体验计划'],
  ['REDEMPTION_PENDING', 'redemption_pending', '待履约兑换', '请先完成或取消兑换'],
  ['CHECKOUT_OFFER_ACTIVE', 'checkout_offer_active', '待处理加单报价', '请先接受、拒绝或失效报价'],
] as const satisfies ReadonlyArray<readonly [
  TableSessionClosureBlockerCode,
  TableSessionClosureBlockerKey,
  string,
  string,
]>

export async function readTableSessionClosureState(
  transaction: ScopedTransaction,
  tableSessionId: string,
): Promise<TableSessionClosureState> {
  const result = await transaction.query<ClosureCountRow>(`
    WITH scoped_orders AS (
      SELECT ordering.id,ordering.status,ordering.payment_status,ordering.total_amount_minor,
        EXISTS (
          SELECT 1 FROM mbox.order_settlement_exception_events settlement_exception
          WHERE settlement_exception.tenant_id=ordering.tenant_id
            AND settlement_exception.store_id=ordering.store_id
            AND settlement_exception.order_id=ordering.id
        ) AS has_settlement_exception
      FROM mbox.orders ordering
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
        AND ordering.table_session_id=$3::uuid
    ), payable_orders AS (
      SELECT ordering.id,GREATEST(
        CASE
          WHEN ordering.has_settlement_exception THEN 0::bigint
          WHEN ordering.status='cancelled' THEN COALESCE((
            SELECT sum(item.total_amount_minor)
            FROM mbox.order_items item
            WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
              AND item.order_id=ordering.id AND item.status='delivered'
          ),0)::bigint
          ELSE ordering.total_amount_minor
        END-COALESCE((
          SELECT sum(payment.amount_minor)
          FROM mbox.payments payment
          WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
            AND payment.order_id=ordering.id
            AND payment.status IN ('succeeded','partially_refunded','refunded')
        ),0)::bigint,0::bigint) AS outstanding_amount_minor
      FROM scoped_orders ordering
      WHERE ordering.payment_status IN ('unpaid','pending','partially_paid')
    ) SELECT
      (SELECT count(*)::text FROM scoped_orders ordering
        WHERE NOT ((ordering.status<>'cancelled'
            AND ordering.payment_status IN ('paid','partially_refunded','refunded'))
          OR (ordering.status='cancelled' AND ordering.payment_status='refunded')
          OR (ordering.status='cancelled' AND ordering.payment_status='unpaid'
            AND NOT EXISTS (
              SELECT 1 FROM mbox.order_items delivered_item
              WHERE delivered_item.tenant_id=$1::uuid AND delivered_item.store_id=$2::uuid
                AND delivered_item.order_id=ordering.id AND delivered_item.status='delivered'
            ))
          OR (ordering.status='cancelled' AND ordering.payment_status='unpaid'
            AND ordering.has_settlement_exception))) AS order_unsettled,
      (SELECT count(*)::text FROM mbox.order_items item
        WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
          AND item.order_id=ANY(SELECT id FROM scoped_orders)
          AND item.fulfillment_station IN ('bar','kitchen')
          AND item.status NOT IN ('delivered','cancelled')) AS order_item_unresolved,
      (SELECT count(*)::text FROM mbox.kds_tasks task
        JOIN mbox.order_items item ON item.tenant_id=task.tenant_id
          AND item.store_id=task.store_id AND item.id=task.order_item_id
        WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
          AND item.order_id=ANY(SELECT id FROM scoped_orders)
          AND (task.status IN ('pending','accepted','preparing')
            OR (task.status='ready' AND item.status<>'delivered')
            OR (task.status='failed' AND item.status<>'cancelled'))) AS kds_active,
      (SELECT count(*)::text FROM mbox.payments payment
        WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid
          AND payment.order_id=ANY(SELECT id FROM scoped_orders)
          AND payment.status IN ('created','pending')) AS payment_pending,
      (SELECT count(*)::text FROM mbox.inventory_order_reservations reservation
        WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
          AND reservation.order_id=ANY(SELECT id FROM scoped_orders)
          AND reservation.status='reserved') AS inventory_reserved,
      (SELECT count(*)::text FROM mbox.refunds refund
        JOIN mbox.payments payment ON payment.tenant_id=refund.tenant_id
          AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
        WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid
          AND payment.order_id=ANY(SELECT id FROM scoped_orders)
          AND refund.status IN ('requested','approved','processing')) AS refund_pending,
      (SELECT count(*)::text FROM mbox.service_tasks task
        WHERE task.tenant_id=$1::uuid AND task.store_id=$2::uuid
          AND task.table_session_id=$3::uuid
          AND task.status IN ('pending','acknowledged','in_progress')) AS service_active,
      (SELECT count(*)::text FROM mbox.pricing_authorizations pricing_auth
        WHERE pricing_auth.tenant_id=$1::uuid AND pricing_auth.store_id=$2::uuid
          AND pricing_auth.table_session_id=$3::uuid AND pricing_auth.status='reserved') AS pricing_reserved,
      (SELECT count(*)::text FROM mbox.song_requests song
        WHERE song.tenant_id=$1::uuid AND song.store_id=$2::uuid
          AND song.table_session_id=$3::uuid
          AND song.status IN ('requested','confirming','accepted','paid')) AS song_active,
      (SELECT count(*)::text FROM mbox.benefit_reservations reservation
        WHERE reservation.tenant_id=$1::uuid AND reservation.store_id=$2::uuid
          AND reservation.table_session_id=$3::uuid AND reservation.status='reserved') AS benefit_reserved,
      (SELECT count(*)::text FROM mbox.customer_experience_plans plan
        WHERE plan.tenant_id=$1::uuid AND plan.store_id=$2::uuid
          AND plan.table_session_id=$3::uuid
          AND plan.plan_state IN ('planned','active','paused')) AS experience_active,
      (SELECT count(*)::text FROM mbox.member_redemptions redemption
        WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
          AND redemption.table_session_id=$3::uuid
          AND redemption.status IN ('authorizing','awaiting_fulfillment')) AS redemption_pending,
      (SELECT count(*)::text FROM mbox.checkout_upgrade_offers offer
        WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid
          AND offer.table_session_id=$3::uuid AND offer.status IN ('offered','selected')) AS checkout_offer_active,
      (SELECT count(*) FILTER (WHERE outstanding_amount_minor>0)::text FROM payable_orders)
        AS outstanding_order_count,
      (SELECT COALESCE(sum(outstanding_amount_minor) FILTER (WHERE outstanding_amount_minor>0),0)::text
        FROM payable_orders) AS outstanding_amount_minor
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId])
  const row = result.rows[0]
  if (!row) return { blockers: [], outstandingOrderCount: 0, outstandingAmountMinor: 0 }
  const blockers = tableSessionClosureBlockerDefinitions.flatMap(([code, key, label, resolution]) => {
    const count = closureCount(row[key], key)
    return count === 0 ? [] : [{ code, key, count, label, resolution }]
  })
  return {
    blockers,
    outstandingOrderCount: closureCount(row.outstanding_order_count, 'outstanding_order_count'),
    outstandingAmountMinor: closureCount(row.outstanding_amount_minor, 'outstanding_amount_minor'),
  }
}

function closureCount(value: unknown, field: string): number {
  const count = Number(value ?? 0)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`关台校验返回无效计数：${field}`)
  return count
}
