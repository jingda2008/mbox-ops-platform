import {orderReceivableSql} from './order-collection-sql.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestTableOrderItemView {
  progressText?:string
  note?: string | null
  id: string
  productId: string
  name: string
  quantity: number
  unitPriceMinor: number
  totalAmountMinor: number
  components: { name: string; quantity: number; progressText?:string }[]
  status: 'submitted' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
}

export interface GuestTableOrderView {
  receivableReductionMinor?:number
  receivableIncreaseMinor?:number
  settlementReviewRequired?:boolean
  publicId: string
  tableCode?: string
  businessDate?: string
  round: number
  channel: 'guest_qr' | 'staff_assisted' | 'cashier' | 'reservation' | 'integration'
  sourceText: string
  status: 'submitted' | 'confirmed' | 'fulfilling' | 'completed' | 'cancelled'
  visibility: 'shared' | 'private'
  isMine: boolean
  createdAt: string
  paidAt: string | null
  totalAmountMinor: number
  subtotalAmountMinor: number
  discountAmountMinor: number
  paymentStatus: 'unpaid' | 'pending' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded'
  paymentAccess: 'available' | 'staff_collecting' | 'payment_in_progress' | 'status_review' | 'not_required'
  payableAmountMinor: number
  currency: string
  pricingKind: 'none' | 'discount' | 'gift'
  pricingLabel: string | null
  items: GuestTableOrderItemView[]
}

interface GuestTableOrderRow extends Record<string, unknown> {
  receivable_reduction_minor?:string|number
  has_unresolved_unpaid_stop?:boolean
  quantity_facts?:GuestQuantityFacts|null
  item_note: string | null
  public_id: string
  round_number: number
  channel: GuestTableOrderView['channel']
  order_status: GuestTableOrderView['status']
  visibility: GuestTableOrderView['visibility']
  is_mine: boolean
  order_created_at: string
  paid_at: string | null
  total_amount_minor: string | number
  subtotal_amount_minor: string | number
  discount_amount_minor: string | number
  payment_status: GuestTableOrderView['paymentStatus']
  payment_access: GuestTableOrderView['paymentAccess']
  payable_amount_minor: string | number
  currency: string
  pricing_kind: GuestTableOrderView['pricingKind']
  product_id: string
  item_id: string
  unit_price_minor: string | number
  item_total_amount_minor: string | number
  components: GuestTableOrderItemView['components']
  product_name: string
  quantity: number
  item_status: GuestTableOrderItemView['status']
}

export async function loadGuestTableOrders(
  transaction: ScopedTransaction,
  tableSessionId: string,
  customerId: string,
): Promise<GuestTableOrderView[]> {
  return loadOrderDetails(transaction, tableSessionId, customerId)
}

/** The identity comes from the authenticated self context, never a query param.
 * Historical access is limited to the customer's own created orders; merely
 * sharing a table must not grant permanent access to another guest's history. */
export async function loadGuestCustomerOrderHistory(transaction: ScopedTransaction, customerId: string, beforePublicId?: string): Promise<GuestTableOrderView[]> {
  return (await loadOrderDetails(transaction, null, customerId, beforePublicId)).reverse()
}

async function loadOrderDetails(transaction: ScopedTransaction, tableSessionId: string | null, customerId: string, beforePublicId?: string): Promise<GuestTableOrderView[]> {
  const result = await transaction.query<GuestTableOrderRow>(`
    WITH RECURSIVE family(id) AS (
      SELECT mbox.canonical_customer_id($1::uuid,$2::uuid,$4::uuid)
      UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id
      WHERE c.tenant_id=$1 AND c.store_id=$2
    ), selected_orders AS (
      SELECT ordering.*,venue_table.code AS original_table_code FROM mbox.orders ordering
      JOIN mbox.table_sessions original_session ON original_session.tenant_id=ordering.tenant_id
        AND original_session.store_id=ordering.store_id AND original_session.id=ordering.table_session_id
      JOIN mbox.tables venue_table ON venue_table.tenant_id=original_session.tenant_id
        AND venue_table.store_id=original_session.store_id AND venue_table.id=original_session.table_id
      WHERE ordering.tenant_id=$1 AND ordering.store_id=$2
        AND ordering.status <> 'draft'
        AND (($3::uuid IS NOT NULL AND ordering.table_session_id=$3 AND ordering.status<>'cancelled')
          OR ($3::uuid IS NULL AND ordering.created_by_customer_id IN (SELECT id FROM family)))
        AND ($5::text IS NULL OR (ordering.created_at,ordering.id)<(SELECT cursor_order.created_at,cursor_order.id
          FROM mbox.orders cursor_order WHERE cursor_order.tenant_id=$1 AND cursor_order.store_id=$2
            AND cursor_order.public_id=$5 AND cursor_order.created_by_customer_id IN (SELECT id FROM family)))
      ORDER BY ordering.created_at DESC,ordering.id DESC
      LIMIT CASE WHEN $3::uuid IS NULL THEN 30 ELSE 2147483647 END
    ), order_balances AS (
      SELECT ordering.id, ordering.tenant_id, ordering.store_id,
        ordering.public_id, ordering.original_table_code, ordering.business_date, ordering.channel, ordering.status,
        ordering.payment_status, ordering.created_by_customer_id,
        ordering.created_at, ordering.currency, ordering.total_amount_minor,
        ordering.subtotal_amount_minor, ordering.discount_amount_minor,
        ordering.total_amount_minor-(${orderReceivableSql('ordering')}) AS receivable_reduction_minor,
        EXISTS(SELECT 1 FROM mbox.item_after_sales_cases pending_stop
          WHERE pending_stop.tenant_id=ordering.tenant_id AND pending_stop.store_id=ordering.store_id AND pending_stop.order_id=ordering.id
            AND COALESCE(pending_stop.resolved_kind,pending_stop.kind)='unpaid_stop'
            AND NOT EXISTS(SELECT 1 FROM mbox.item_receivable_adjustment_facts adjustment
              WHERE adjustment.tenant_id=pending_stop.tenant_id AND adjustment.store_id=pending_stop.store_id AND adjustment.case_id=pending_stop.id)
            AND EXISTS(SELECT 1 FROM mbox.order_item_quantity_units unit
              WHERE unit.tenant_id=pending_stop.tenant_id AND unit.store_id=pending_stop.store_id
                AND (unit.held_by_case_id=pending_stop.id OR unit.stopped_by_case_id=pending_stop.id))) AS has_unresolved_unpaid_stop,
        (SELECT max(payment.succeeded_at) FROM mbox.order_payment_facts payment
         WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
           AND payment.order_id=ordering.id AND payment.status IN ('succeeded','partially_refunded','refunded')) AS paid_at,
        COALESCE(pricing_authorization.kind, 'none') AS pricing_kind,
        GREATEST(
          ${orderReceivableSql('ordering')}
          - COALESCE((
              SELECT SUM(payment.amount_minor)
              FROM mbox.order_payment_facts payment
              WHERE payment.tenant_id = ordering.tenant_id
                AND payment.store_id = ordering.store_id
                AND payment.order_id = ordering.id
                AND payment.status IN ('succeeded', 'partially_refunded', 'refunded')
            ), 0)
          + COALESCE((
              SELECT SUM(refund.amount_minor)
              FROM mbox.refunds refund
              JOIN mbox.order_payment_facts paid
                ON paid.tenant_id = refund.tenant_id
               AND paid.store_id = refund.store_id
               AND paid.id = refund.payment_id AND (refund.order_id IS NULL OR refund.order_id=paid.order_id)
              WHERE paid.tenant_id = ordering.tenant_id
                AND paid.store_id = ordering.store_id
                AND paid.order_id = ordering.id
                AND refund.status = 'succeeded'
            ), 0),
          0
        ) AS payable_amount_minor,
        COALESCE((
          SELECT SUM(refund.amount_minor)
          FROM mbox.refunds refund
          JOIN mbox.order_payment_facts paid
            ON paid.tenant_id = refund.tenant_id
           AND paid.store_id = refund.store_id
           AND paid.id = refund.payment_id AND (refund.order_id IS NULL OR refund.order_id=paid.order_id)
          WHERE paid.tenant_id = ordering.tenant_id
            AND paid.store_id = ordering.store_id
            AND paid.order_id = ordering.id
            AND refund.status = 'succeeded'
        ), 0) AS refunded_amount_minor
      FROM selected_orders AS ordering
      LEFT JOIN mbox.pricing_authorizations AS pricing_authorization
        ON pricing_authorization.tenant_id = ordering.tenant_id
       AND pricing_authorization.store_id = ordering.store_id
       AND pricing_authorization.order_id = ordering.id
       AND pricing_authorization.status = 'consumed'
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ($3::uuid IS NULL OR ordering.table_session_id = $3::uuid)
    ), table_orders AS (
      SELECT ordering.*,
        CASE
          WHEN $3::uuid IS NULL OR ordering.status='cancelled' THEN 'not_required'
          WHEN ordering.has_unresolved_unpaid_stop THEN 'status_review'
          WHEN ordering.payable_amount_minor = 0 THEN 'not_required'
          -- A completed refund is not a public invitation to charge again.
          -- Only a live, cashier-issued recollection authorization may expose
          -- this amount to the table payment flow.
          WHEN ordering.refunded_amount_minor > 0 AND NOT recollection.active THEN 'status_review'
          ELSE 'available'
        END AS payment_access
      FROM order_balances AS ordering
      LEFT JOIN LATERAL (
        SELECT payment.id, payment.method
        FROM mbox.order_payment_facts payment
        WHERE payment.tenant_id = ordering.tenant_id
          AND payment.store_id = ordering.store_id
          AND payment.order_id = ordering.id
          AND payment.status IN ('created', 'pending')
          AND payment.retry_released_at IS NULL
        ORDER BY payment.created_at DESC, payment.id DESC
        LIMIT 1
      ) AS active_payment ON true
      LEFT JOIN mbox.payment_provider_actions AS provider_action
        ON provider_action.tenant_id = ordering.tenant_id
       AND provider_action.store_id = ordering.store_id
       AND provider_action.payment_id = active_payment.id
      LEFT JOIN LATERAL (
        SELECT EXISTS(
          SELECT 1 FROM mbox.order_recollection_authorizations recollection_authorization
          WHERE recollection_authorization.tenant_id=ordering.tenant_id AND recollection_authorization.store_id=ordering.store_id
            AND recollection_authorization.order_id=ordering.id AND recollection_authorization.status='active'
            AND recollection_authorization.expires_at>clock_timestamp()
        ) AS active
      ) recollection ON true
    ), visible_orders_unbounded AS (
      SELECT ordering.*,
        row_number() OVER (ORDER BY ordering.created_at, ordering.id)::integer AS round_number
      FROM table_orders AS ordering
    ), visible_orders AS (
      SELECT *
      FROM visible_orders_unbounded AS ordering
      ORDER BY ordering.created_at DESC, ordering.id DESC
      LIMIT 30
    )
    SELECT ordering.public_id, ordering.original_table_code, ordering.business_date::text, ordering.round_number,
      ordering.channel, ordering.status AS order_status,
      CASE WHEN $3::uuid IS NULL THEN 'private' ELSE 'shared' END AS visibility,
      COALESCE(ordering.created_by_customer_id = $4::uuid, false) AS is_mine,
      ordering.created_at::text AS order_created_at,
      ordering.paid_at::text,ordering.total_amount_minor::text,
      ordering.subtotal_amount_minor::text,ordering.discount_amount_minor::text,
      ordering.payment_status, ordering.payment_access,ordering.receivable_reduction_minor::text,ordering.has_unresolved_unpaid_stop,
      ordering.payable_amount_minor::text, ordering.currency, ordering.pricing_kind,
      item.product_id, COALESCE(NULLIF(item.product_snapshot ->> 'name', ''), product.name) AS product_name,
      item.id AS item_id, item.quantity, item.status AS item_status, item.note AS item_note,
      item.unit_price_minor::text, item.total_amount_minor::text AS item_total_amount_minor,
      ${guestQuantityFactsSql('item')} AS quantity_facts,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',child.product_snapshot->>'name','quantity',child.quantity,'quantity_facts',${guestQuantityFactsSql('child')})
        ORDER BY child.created_at,child.id) FROM mbox.order_items child
        WHERE child.tenant_id=item.tenant_id AND child.store_id=item.store_id
          AND child.order_id=item.order_id AND child.parent_order_item_id=item.id), '[]'::jsonb) AS components
    FROM visible_orders AS ordering
    JOIN mbox.order_items AS item
      ON item.tenant_id = $1::uuid
     AND item.store_id = $2::uuid
     AND item.order_id = ordering.id
     AND item.parent_order_item_id IS NULL
    JOIN mbox.products AS product
      ON product.tenant_id = item.tenant_id
     AND product.store_id = item.store_id
     AND product.id = item.product_id
    ORDER BY ordering.created_at, ordering.id, item.created_at, item.id
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId, customerId, beforePublicId ?? null])

  const orders = new Map<string, GuestTableOrderView>()
  for (const row of result.rows) {
    let order = orders.get(row.public_id)
    if (order === undefined) {
      order = {
        publicId: row.public_id,
        round: Number(row.round_number),
        channel: row.channel,
        sourceText: orderSourceText(row.channel),
        status: row.order_status,
        visibility: row.visibility,
        isMine: row.is_mine,
        tableCode: String(row.original_table_code ?? ''),
        businessDate: String(row.business_date ?? ''),
        createdAt: timestamp(row.order_created_at),
        paidAt: row.paid_at === null ? null : timestamp(row.paid_at),
        totalAmountMinor: safeMinor(row.total_amount_minor),
        subtotalAmountMinor: safeMinor(row.subtotal_amount_minor),
        discountAmountMinor: safeMinor(row.discount_amount_minor),
        ...(row.receivable_reduction_minor===undefined?{}:{receivableReductionMinor:Math.max(0,Number(row.receivable_reduction_minor)),...(Number(row.receivable_reduction_minor)<0?{receivableIncreaseMinor:safeMinor(-Number(row.receivable_reduction_minor))}:{})}),
        ...(row.has_unresolved_unpaid_stop===undefined?{}:{settlementReviewRequired:row.has_unresolved_unpaid_stop}),
        paymentStatus: row.payment_status,
        paymentAccess: row.payment_access,
        payableAmountMinor: row.payment_access==='status_review'||row.payment_access==='not_required'||row.order_status==='cancelled'?0:safeMinor(row.payable_amount_minor),
        currency: row.currency,
        pricingKind: row.pricing_kind,
        pricingLabel: row.pricing_kind === 'gift'
          ? '门店赠送'
          : row.pricing_kind === 'discount' ? '优惠' : null,
        items: [],
      }
      orders.set(row.public_id, order)
    }
    order.items.push({
      note: row.item_note || null,
      id: row.item_id,
      productId: row.product_id,
      name: row.product_name,
      quantity: Number(row.quantity),
      unitPriceMinor: safeMinor(row.unit_price_minor),
      totalAmountMinor: safeMinor(row.item_total_amount_minor),
      components: row.components.map(component=>({name:component.name,quantity:component.quantity,...quantityProgress((component as typeof component&{quantity_facts?:GuestQuantityFacts|null}).quantity_facts)})),
      ...quantityProgress(row.quantity_facts),
      status: row.item_status,
    })
  }
  return [...orders.values()]
}

interface GuestQuantityFacts {remakePreparing?:number;remakeReady?:number;remakeDelivered?:number;remakePending?:number;redelivery?:number;total:number;held:number;stopped:number;preparing:number;ready:number;delivered:number}
function guestQuantityFactsSql(item:'item'|'child'){
  return `(SELECT CASE WHEN count(*)>0 THEN jsonb_build_object('total',count(*),
    'held',count(*) FILTER(WHERE unit.held_by_case_id IS NOT NULL AND NOT unit.operationally_stopped),
    'stopped',count(*) FILTER(WHERE unit.operationally_stopped),
    'preparing',count(*) FILTER(WHERE latest.id IS NULL AND unit.production_state IN ('unmade','started') AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped),
    'ready',count(*) FILTER(WHERE latest.id IS NULL AND unit.production_state='ready' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped),
    'delivered',count(*) FILTER(WHERE unit.production_state='delivered'),
    'remakePreparing',count(*) FILTER(WHERE latest.cancelled_at IS NULL AND latest.production_state IN ('unmade','started') AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped),
    'remakeReady',count(*) FILTER(WHERE latest.cancelled_at IS NULL AND latest.production_state='ready' AND unit.held_by_case_id IS NULL AND NOT unit.operationally_stopped),
    'remakeDelivered',count(*) FILTER(WHERE latest.cancelled_at IS NULL AND latest.production_state='delivered'),
    'remakePending',count(*) FILTER(WHERE latest.cancelled_at IS NOT NULL AND NOT unit.operationally_stopped),
    'redelivery',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM mbox.quantity_redelivery_units part WHERE part.tenant_id=unit.tenant_id AND part.store_id=unit.store_id AND part.unit_id=unit.id AND part.outcome IS NULL))) END FROM mbox.order_item_quantity_units unit
    LEFT JOIN LATERAL(SELECT part.id,part.production_state,part.cancelled_at FROM mbox.quantity_remake_units part WHERE part.tenant_id=unit.tenant_id AND part.store_id=unit.store_id AND part.unit_id=unit.id ORDER BY part.generation DESC LIMIT 1) latest ON true
    WHERE unit.tenant_id=${item}.tenant_id AND unit.store_id=${item}.store_id AND unit.order_item_id=${item}.id)`
}
function quantityProgress(facts:GuestQuantityFacts|null|undefined):{progressText?:string}{
  if(!facts)return {}
  const parts:Array<[string,number]>=[['暂停',facts.held],['已停止',facts.stopped],['准备中',facts.preparing],['已备齐',facts.ready],['已送达记录',facts.delivered],['待补送',facts.redelivery??0],['重新准备中',facts.remakePreparing??0],['重做已备齐',facts.remakeReady??0],['重做已送达',facts.remakeDelivered??0],['门店处理中',facts.remakePending??0]]
  if(!Number.isSafeInteger(facts.total)||facts.total<1||parts.some(([,count])=>!Number.isSafeInteger(count)||count<0||count>facts.total))throw new Error('原商品数量进度无效')
  return {progressText:parts.filter(([,count])=>count>0).map(([label,count])=>`${label} ${count} 份`).join(' · ')}
}

function safeMinor(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('订单金额无效')
  return parsed
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function orderSourceText(channel: GuestTableOrderView['channel'] | string): string {
  return ({
    guest_qr: '顾客扫码点单',
    staff_assisted: '服务员协助点单',
    cashier: '门店收银下单',
    reservation: '预约订单',
    integration: '第三方订单',
  } as Record<string, string>)[channel] || '点单来源待确认'
}
