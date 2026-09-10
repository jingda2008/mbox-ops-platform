import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestTableOrderItemView {
  note?: string | null
  id: string
  productId: string
  name: string
  quantity: number
  unitPriceMinor: number
  totalAmountMinor: number
  components: { name: string; quantity: number }[]
  status: 'submitted' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
}

export interface GuestTableOrderView {
  publicId: string
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
export async function loadGuestCustomerOrderHistory(transaction: ScopedTransaction, customerId: string): Promise<GuestTableOrderView[]> {
  return (await loadOrderDetails(transaction, null, customerId)).reverse()
}

async function loadOrderDetails(transaction: ScopedTransaction, tableSessionId: string | null, customerId: string): Promise<GuestTableOrderView[]> {
  const result = await transaction.query<GuestTableOrderRow>(`
    WITH RECURSIVE family(id) AS (
      SELECT mbox.canonical_customer_id($1::uuid,$2::uuid,$4::uuid)
      UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id
      WHERE c.tenant_id=$1 AND c.store_id=$2
    ), selected_orders AS (
      SELECT ordering.* FROM mbox.orders ordering
      WHERE ordering.tenant_id=$1 AND ordering.store_id=$2
        AND ordering.status <> 'draft'
        AND (($3::uuid IS NOT NULL AND ordering.table_session_id=$3 AND ordering.status<>'cancelled')
          OR ($3::uuid IS NULL AND ordering.created_by_customer_id IN (SELECT id FROM family)
            AND ordering.payment_status IN ('paid','partially_refunded','refunded')))
      ORDER BY ordering.created_at DESC,ordering.id DESC
      LIMIT CASE WHEN $3::uuid IS NULL THEN 30 ELSE 2147483647 END
    ), order_balances AS (
      SELECT ordering.id, ordering.tenant_id, ordering.store_id,
        ordering.public_id, ordering.channel, ordering.status,
        ordering.payment_status, ordering.created_by_customer_id,
        ordering.created_at, ordering.currency, ordering.total_amount_minor,
        ordering.subtotal_amount_minor, ordering.discount_amount_minor,
        (SELECT max(payment.succeeded_at) FROM mbox.payments payment
         WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
           AND payment.order_id=ordering.id AND payment.status IN ('succeeded','partially_refunded','refunded')) AS paid_at,
        COALESCE(pricing_authorization.kind, 'none') AS pricing_kind,
        GREATEST(
          ordering.total_amount_minor
          - COALESCE((
              SELECT SUM(payment.amount_minor)
              FROM mbox.payments payment
              WHERE payment.tenant_id = ordering.tenant_id
                AND payment.store_id = ordering.store_id
                AND payment.order_id = ordering.id
                AND payment.status IN ('succeeded', 'partially_refunded', 'refunded')
            ), 0)
          + COALESCE((
              SELECT SUM(refund.amount_minor)
              FROM mbox.refunds refund
              JOIN mbox.payments paid
                ON paid.tenant_id = refund.tenant_id
               AND paid.store_id = refund.store_id
               AND paid.id = refund.payment_id
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
          JOIN mbox.payments paid
            ON paid.tenant_id = refund.tenant_id
           AND paid.store_id = refund.store_id
           AND paid.id = refund.payment_id
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
          WHEN $3::uuid IS NULL THEN 'not_required'
          WHEN ordering.payable_amount_minor = 0 THEN 'not_required'
          -- A completed refund is not a public invitation to charge again.
          -- Only a live, cashier-issued recollection authorization may expose
          -- this amount to the table payment flow.
          WHEN ordering.refunded_amount_minor > 0 AND NOT recollection.active THEN 'status_review'
          WHEN active_payment.method = 'auth_code' THEN 'staff_collecting'
          WHEN active_payment.id IS NOT NULL AND (
            provider_action.payment_id IS NULL OR provider_action.state IN ('unknown','failed','consumed')
          ) THEN 'status_review'
          WHEN active_payment.id IS NOT NULL THEN 'payment_in_progress'
          ELSE 'available'
        END AS payment_access
      FROM order_balances AS ordering
      LEFT JOIN LATERAL (
        SELECT payment.id, payment.method
        FROM mbox.payments payment
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
    SELECT ordering.public_id, ordering.round_number,
      ordering.channel, ordering.status AS order_status,
      CASE WHEN $3::uuid IS NULL THEN 'private' ELSE 'shared' END AS visibility,
      COALESCE(ordering.created_by_customer_id = $4::uuid, false) AS is_mine,
      ordering.created_at::text AS order_created_at,
      ordering.paid_at::text,ordering.total_amount_minor::text,
      ordering.subtotal_amount_minor::text,ordering.discount_amount_minor::text,
      ordering.payment_status, ordering.payment_access,
      ordering.payable_amount_minor::text, ordering.currency, ordering.pricing_kind,
      item.product_id, COALESCE(NULLIF(item.product_snapshot ->> 'name', ''), product.name) AS product_name,
      item.id AS item_id, item.quantity, item.status AS item_status, item.note AS item_note,
      item.unit_price_minor::text, item.total_amount_minor::text AS item_total_amount_minor,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',child.product_snapshot->>'name','quantity',child.quantity)
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
  `, [transaction.scope.tenantId, transaction.scope.storeId, tableSessionId, customerId])

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
        createdAt: timestamp(row.order_created_at),
        paidAt: row.paid_at === null ? null : timestamp(row.paid_at),
        totalAmountMinor: safeMinor(row.total_amount_minor),
        subtotalAmountMinor: safeMinor(row.subtotal_amount_minor),
        discountAmountMinor: safeMinor(row.discount_amount_minor),
        paymentStatus: row.payment_status,
        paymentAccess: row.payment_access,
        payableAmountMinor: safeMinor(row.payable_amount_minor),
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
      components: row.components,
      status: row.item_status,
    })
  }
  return [...orders.values()]
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
