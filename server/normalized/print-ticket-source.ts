import type { JsonObject } from './command-executor.js'
import {
  HardwareRepository,
  type HardwareStation,
  type PrintJob,
} from './hardware-repository.js'
import {
  createPrintTicketSnapshot,
  ticketToJson,
  type PrintTicketKind,
  type PrintTicketLine,
  type PrintTicketPayment,
  type PrintTicketSnapshot,
} from './print-ticket-layout.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface OrderContextRow extends Record<string, unknown> {
  order_id: string
  order_public_id: string
  order_note: string | null
  total_amount_minor: string | number
  currency: string
  payment_status: string
  table_code: string
  guest_count: number
  business_date: string
  submitted_at: string
}

interface OrderItemRow extends Record<string, unknown> {
  item_id: string
  parent_order_item_id: string | null
  quantity: number
  total_amount_minor: string | number
  fulfillment_station: HardwareStation | 'cashier' | 'none'
  product_snapshot: unknown
  note: string | null
}

interface PaymentContextRow extends OrderContextRow {
  payment_id: string
  payment_public_id: string
  payment_provider: string
  payment_method: string
  payment_amount_minor: string | number
  payment_status_value: string
  succeeded_at: string | null
  settled_payment_count: string | number
  settled_amount_minor: string | number
}

interface RouteCategoryRow extends Record<string, unknown> {
  product_category_code: string | null
}

interface SourceItem {
  name: string
  quantity: number
  note: string | null
  totalAmountMinor: number
  categoryCode: string | null
  parentOrderItemId: string | null
  fulfillmentStation: HardwareStation | 'cashier' | 'none'
  productKind: string
}

/**
 * Creates printer snapshots exclusively from committed server facts.  It never
 * accepts a product name, amount, table or payment method from an API caller.
 */
export class PrintTicketSourceRepository {
  private readonly hardware: HardwareRepository

  constructor(private readonly transaction: ScopedTransaction) {
    this.hardware = new HardwareRepository(transaction)
  }

  async materializeOrderProduction(
    sourceOutboxMessageId: string,
    orderId: string,
  ): Promise<readonly PrintJob[]> {
    const context = await this.loadOrderContext(orderId)
    const items = await this.loadItems(orderId)
    const jobs: PrintJob[] = []
    for (const station of ['bar', 'kitchen'] as const) {
      const operational = items.filter((item) => (
        item.fulfillmentStation === station && item.productKind !== 'bundle'
      ))
      if (operational.length === 0) continue
      const groups = await this.groupsForRoutes(station, operational)
      for (const group of groups) {
        const snapshot = productionSnapshot(context, station, group.items, group.categoryCode)
        const created = await this.hardware.materializeFromOutbox({
          sourceOutboxMessageId,
          stationCode: station,
          productCategoryCode: group.categoryCode,
          sourceType: 'kds',
          sourceReference: `${context.order_public_id}:${station}:${group.categoryCode ?? 'default'}`,
          printSnapshot: ticketToJson(snapshot),
          containsPriorityNote: group.items.some((item) => item.note !== null) || context.order_note !== null,
        })
        jobs.push(...created)
      }
    }
    return jobs
  }

  async materializeCashierSettlement(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadPaymentContext(paymentId)
    if (payment.payment_status_value !== 'pending') return []
    const items = await this.loadItems(payment.order_id)
    const snapshot = cashierSnapshot(payment, 'cashier_settlement', items, null)
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  async materializeCashierPayment(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadPaymentContext(paymentId)
    // A receipt must never label a split settlement as a single payment method.
    // It is produced after the order is fully settled by exactly this payment.
    if (
      payment.payment_status !== 'paid'
      || payment.payment_status_value !== 'succeeded'
      || numeric(payment.settled_payment_count, 'settled_payment_count') !== 1
      || numeric(payment.settled_amount_minor, 'settled_amount_minor') !== numeric(payment.total_amount_minor, 'total_amount_minor')
      || numeric(payment.payment_amount_minor, 'payment_amount_minor') !== numeric(payment.total_amount_minor, 'total_amount_minor')
    ) return []
    const items = await this.loadItems(payment.order_id)
    const snapshot = cashierSnapshot(payment, 'cashier_payment', items, paymentFromRow(payment))
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  private async materializeCashier(
    sourceOutboxMessageId: string,
    payment: Readonly<PaymentContextRow>,
    snapshot: Readonly<PrintTicketSnapshot>,
  ): Promise<readonly PrintJob[]> {
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference: payment.payment_public_id,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: snapshot.note !== null,
    })
  }

  private async loadOrderContext(orderId: string): Promise<OrderContextRow> {
    const result = await this.transaction.query<OrderContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        session.business_date::text, ordering.submitted_at::text
      FROM mbox.orders AS ordering
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid AND ordering.id=$3::uuid
        AND ordering.status='submitted'
      FOR SHARE OF ordering, session, venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源订单不存在或不可打印')
    return row
  }

  private async loadPaymentContext(paymentId: string): Promise<PaymentContextRow> {
    const result = await this.transaction.query<PaymentContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        session.business_date::text, ordering.submitted_at::text,
        payment.id AS payment_id, payment.public_id AS payment_public_id,
        payment.provider AS payment_provider, payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor, payment.status AS payment_status_value,
        payment.succeeded_at::text,
        (SELECT count(*) FROM mbox.payments AS settled
          WHERE settled.tenant_id=ordering.tenant_id AND settled.store_id=ordering.store_id
            AND settled.order_id=ordering.id AND settled.status='succeeded')::text AS settled_payment_count,
        (SELECT COALESCE(sum(settled.amount_minor),0) FROM mbox.payments AS settled
          WHERE settled.tenant_id=ordering.tenant_id AND settled.store_id=ordering.store_id
            AND settled.order_id=ordering.id AND settled.status='succeeded')::text AS settled_amount_minor
      FROM mbox.payments AS payment
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
      FOR SHARE OF payment, ordering, session, venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源支付不存在')
    return row
  }

  private async loadItems(orderId: string): Promise<readonly SourceItem[]> {
    const result = await this.transaction.query<OrderItemRow>(`
      SELECT item.id AS item_id, item.parent_order_item_id, item.quantity,
        item.total_amount_minor, item.fulfillment_station, item.product_snapshot, item.note
      FROM mbox.order_items AS item
      WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=$3::uuid
        AND item.status='submitted'
      ORDER BY item.created_at, item.id
      FOR SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    if (result.rows.length === 0) throw new Error('打印源订单没有可用明细')
    return result.rows.map(sourceItem)
  }

  private async groupsForRoutes(
    station: HardwareStation,
    items: readonly SourceItem[],
  ): Promise<readonly { categoryCode: string | null; items: readonly SourceItem[] }[]> {
    const routes = await this.transaction.query<RouteCategoryRow>(`
      SELECT route.product_category_code
      FROM mbox.printer_routes AS route
      JOIN mbox.devices AS device
        ON device.tenant_id=route.tenant_id AND device.store_id=route.store_id
       AND device.id=route.printer_device_id
      WHERE route.tenant_id=$1::uuid AND route.store_id=$2::uuid
        AND route.station_code=$3 AND route.status='active' AND device.status='active'
      FOR SHARE OF route, device
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, station])
    const exactCategories = new Set(routes.rows.flatMap((route) => route.product_category_code === null ? [] : [route.product_category_code]))
    const hasFallback = routes.rows.some((route) => route.product_category_code === null)
    const groups = new Map<string | null, SourceItem[]>()
    for (const item of items) {
      const categoryCode = item.categoryCode !== null && exactCategories.has(item.categoryCode)
        ? item.categoryCode
        : hasFallback ? null : null
      if (categoryCode === null && !hasFallback && !exactCategories.has(item.categoryCode ?? '')) continue
      const current = groups.get(categoryCode) ?? []
      current.push(item)
      groups.set(categoryCode, current)
    }
    return [...groups.entries()].map(([categoryCode, grouped]) => ({ categoryCode, items: grouped }))
  }

  private async hasActiveRoute(station: HardwareStation): Promise<boolean> {
    const result = await this.transaction.query<{ active: boolean }>(`
      SELECT EXISTS(
        SELECT 1
        FROM mbox.printer_routes AS route
        JOIN mbox.devices AS device
          ON device.tenant_id=route.tenant_id AND device.store_id=route.store_id
         AND device.id=route.printer_device_id
        WHERE route.tenant_id=$1::uuid AND route.store_id=$2::uuid
          AND route.station_code=$3 AND route.status='active' AND device.status='active'
      ) AS active
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, station])
    return result.rows[0]?.active === true
  }
}

function productionSnapshot(
  context: Readonly<OrderContextRow>,
  station: HardwareStation,
  items: readonly SourceItem[],
  categoryCode: string | null,
): PrintTicketSnapshot {
  return createPrintTicketSnapshot({
    kind: station === 'bar' ? 'bar_production' : 'kitchen_production',
    subtitle: categoryCode === null ? 'M-BOX · 现场出品' : `M-BOX · ${categoryCode}`,
    test: false,
    issuedAt: context.submitted_at,
    businessDate: context.business_date,
    ticketReference: context.order_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment: null,
    lines: items.map(toProductionLine),
    totalAmountMinor: null,
    currency: currency(context.currency),
  })
}

function cashierSnapshot(
  context: Readonly<PaymentContextRow>,
  kind: Extract<PrintTicketKind, 'cashier_settlement' | 'cashier_payment'>,
  items: readonly SourceItem[],
  payment: PrintTicketPayment | null,
): PrintTicketSnapshot {
  const billable = items.filter((item) => item.parentOrderItemId === null)
  if (billable.length === 0) throw new Error('打印源订单没有计费明细')
  return createPrintTicketSnapshot({
    kind,
    subtitle: 'M-BOX · 现场结账服务',
    test: false,
    issuedAt: kind === 'cashier_payment' ? context.succeeded_at ?? context.submitted_at : context.submitted_at,
    businessDate: context.business_date,
    ticketReference: kind === 'cashier_payment' ? context.payment_public_id : context.order_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment,
    lines: billable.map(toCashierLine),
    totalAmountMinor: numeric(context.total_amount_minor, 'total_amount_minor'),
    currency: currency(context.currency),
  })
}

function sourceItem(row: Readonly<OrderItemRow>): SourceItem {
  const snapshot = jsonObject(row.product_snapshot, 'product_snapshot')
  const name = text(snapshot.name, 'product_snapshot.name')
  const categoryCode = optionalText(snapshot.categoryCode)
  const productKind = optionalText(snapshot.productKind) ?? 'single'
  return {
    name,
    quantity: integer(row.quantity, 'quantity'),
    note: row.note,
    totalAmountMinor: numeric(row.total_amount_minor, 'total_amount_minor'),
    categoryCode,
    parentOrderItemId: row.parent_order_item_id,
    fulfillmentStation: row.fulfillment_station,
    productKind,
  }
}

function toProductionLine(item: Readonly<SourceItem>): PrintTicketLine {
  return { name: item.name, quantity: item.quantity, note: item.note, totalAmountMinor: null }
}

function toCashierLine(item: Readonly<SourceItem>): PrintTicketLine {
  return { name: item.name, quantity: item.quantity, note: item.note, totalAmountMinor: item.totalAmountMinor }
}

function paymentFromRow(row: Readonly<PaymentContextRow>): PrintTicketPayment {
  const provider = row.payment_provider
  const method = row.payment_method
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'simulation'].includes(provider)) throw new Error('支付方式无效')
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(method)) throw new Error('支付渠道无效')
  return { provider: provider as PrintTicketPayment['provider'], method: method as PrintTicketPayment['method'] }
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field}不是对象`)
  return value as JsonObject
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) throw new Error(`${field}无效`)
  return value.trim()
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numeric(value: string | number, field: string): number {
  const numberValue = Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(`${field}无效`)
  return numberValue
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) throw new Error(`${field}无效`)
  return value
}

function currency(value: string): 'CNY' {
  if (value !== 'CNY') throw new Error('暂不支持非CNY打印票据')
  return 'CNY'
}
