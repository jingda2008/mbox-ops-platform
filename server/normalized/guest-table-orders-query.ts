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
  visibility: 'shared' | 'private_pending'
  isMine: boolean
  createdAt: string
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
    WITH table_orders AS (
      SELECT ordering.id, ordering.public_id, ordering.channel, ordering.status,
        ordering.payment_status, ordering.created_by_customer_id,
        ordering.created_at
      FROM mbox.orders AS ordering
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ordering.table_session_id = $3::uuid
        AND ordering.status NOT IN ('draft', 'cancelled')
    ), visible_orders_unbounded AS (
      SELECT ordering.*,
        row_number() OVER (ORDER BY ordering.created_at, ordering.id)::integer AS round_number
      FROM table_orders AS ordering
      WHERE (
          ordering.payment_status IN ('paid', 'partially_refunded', 'refunded')
          OR ordering.channel IN ('staff_assisted', 'cashier', 'reservation', 'integration')
          OR ordering.created_by_customer_id = $4::uuid
        )
    ), visible_orders AS (
      SELECT *
      FROM visible_orders_unbounded AS ordering
      ORDER BY ordering.created_at DESC, ordering.id DESC
      LIMIT 30
    )
    SELECT ordering.public_id, ordering.round_number,
      ordering.channel, ordering.status AS order_status,
      CASE
        WHEN ordering.payment_status IN ('paid', 'partially_refunded', 'refunded')
          OR ordering.channel IN ('staff_assisted', 'cashier', 'reservation', 'integration')
          THEN 'shared'
        ELSE 'private_pending'
      END AS visibility,
      ordering.created_by_customer_id = $4::uuid AS is_mine,
      ordering.created_at::text AS order_created_at,
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

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}
