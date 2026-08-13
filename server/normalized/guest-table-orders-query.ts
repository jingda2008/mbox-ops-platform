import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestTableOrderItemView {
  productId: string
  name: string
  quantity: number
  status: 'submitted' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
}

export interface GuestTableOrderView {
  publicId: string
  round: number
  channel: 'guest_qr' | 'staff_assisted' | 'cashier' | 'reservation' | 'integration'
  status: 'submitted' | 'confirmed' | 'fulfilling' | 'completed'
  visibility: 'shared'
  isMine: boolean
  createdAt: string
  paymentStatus: 'unpaid' | 'pending' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded'
  paymentAccess: 'available' | 'staff_collecting' | 'payment_in_progress' | 'status_review' | 'not_required'
  payableAmountMinor: number
  currency: string
  items: GuestTableOrderItemView[]
}

interface GuestTableOrderRow extends Record<string, unknown> {
  public_id: string
  round_number: number
  channel: GuestTableOrderView['channel']
  order_status: GuestTableOrderView['status']
  visibility: GuestTableOrderView['visibility']
  is_mine: boolean
  order_created_at: string
  payment_status: GuestTableOrderView['paymentStatus']
  payment_access: GuestTableOrderView['paymentAccess']
  payable_amount_minor: string | number
  currency: string
  product_id: string
  product_name: string
  quantity: number
  item_status: GuestTableOrderItemView['status']
}

export async function loadGuestTableOrders(
  transaction: ScopedTransaction,
  tableSessionId: string,
  customerId: string,
): Promise<GuestTableOrderView[]> {
  const result = await transaction.query<GuestTableOrderRow>(`
    WITH order_balances AS (
      SELECT ordering.id, ordering.tenant_id, ordering.store_id,
        ordering.public_id, ordering.channel, ordering.status,
        ordering.payment_status, ordering.created_by_customer_id,
        ordering.created_at, ordering.currency,
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
        ) AS payable_amount_minor
      FROM mbox.orders AS ordering
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ordering.table_session_id = $3::uuid
        AND ordering.status NOT IN ('draft', 'cancelled')
    ), table_orders AS (
      SELECT ordering.*,
        CASE
          WHEN ordering.payable_amount_minor = 0 THEN 'not_required'
          WHEN active_payment.method = 'auth_code' THEN 'staff_collecting'
          WHEN provider_action.state = 'unknown' THEN 'status_review'
          WHEN provider_action.state = 'creating' THEN 'payment_in_progress'
          WHEN active_payment.method = 'jsapi'
            AND provider_action.initiated_by_type = 'guest'
            AND provider_action.initiated_by_ref <> $4::uuid THEN 'payment_in_progress'
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
        ORDER BY payment.created_at DESC, payment.id DESC
        LIMIT 1
      ) AS active_payment ON true
      LEFT JOIN mbox.payment_provider_actions AS provider_action
        ON provider_action.tenant_id = ordering.tenant_id
       AND provider_action.store_id = ordering.store_id
       AND provider_action.payment_id = active_payment.id
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
      'shared'::text AS visibility,
      COALESCE(ordering.created_by_customer_id = $4::uuid, false) AS is_mine,
      ordering.created_at::text AS order_created_at,
      ordering.payment_status, ordering.payment_access,
      ordering.payable_amount_minor::text, ordering.currency,
      item.product_id, COALESCE(NULLIF(item.product_snapshot ->> 'name', ''), product.name) AS product_name,
      item.quantity, item.status AS item_status
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
        status: row.order_status,
        visibility: row.visibility,
        isMine: row.is_mine,
        createdAt: timestamp(row.order_created_at),
        paymentStatus: row.payment_status,
        paymentAccess: row.payment_access,
        payableAmountMinor: safeMinor(row.payable_amount_minor),
        currency: row.currency,
        items: [],
      }
      orders.set(row.public_id, order)
    }
    order.items.push({
      productId: row.product_id,
      name: row.product_name,
      quantity: Number(row.quantity),
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
