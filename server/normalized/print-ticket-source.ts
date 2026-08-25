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

interface RefundContextRow extends OrderContextRow {
  refund_id: string
  refund_public_id: string
  refund_amount_minor: string | number
  refund_status: string
  completed_at: string | null
  payment_provider: string
  payment_method: string
}

interface ActivityPaymentContextRow extends Record<string, unknown> {
  payment_id: string
  payment_public_id: string
  payment_provider: string
  payment_method: string
  payment_amount_minor: string | number
  payment_status_value: string
  succeeded_at: string | null
  business_date: string
  activity_public_id: string
  activity_title: string
  registration_public_id: string
  party_size: number
  currency: string
}

interface ActivityRefundContextRow extends ActivityPaymentContextRow {
  refund_id: string
  refund_public_id: string
  refund_amount_minor: string | number
  refund_status: string
  completed_at: string | null
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
    // A payment voucher states one committed payment, not the entire bill.
    // That keeps split settlements and post-refund replacement payments
    // printable without falsely labelling a partial collection as full payment.
    if (payment.payment_status_value !== 'succeeded') return []
    const snapshot = cashierPaymentSnapshot(payment)
    return this.materializeCashier(sourceOutboxMessageId, payment, snapshot)
  }

  async materializeActivityCashierPayment(
    sourceOutboxMessageId: string,
    paymentId: string,
  ): Promise<readonly PrintJob[]> {
    const payment = await this.loadActivityPaymentContext(paymentId)
    if (payment.payment_status_value !== 'succeeded') return []
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_payment',
      subtitle: 'M-BOX · 活动现场收款凭条',
      test: false,
      issuedAt: requiredTime(payment.succeeded_at, 'activity payment succeeded_at'),
      businessDate: payment.business_date,
      ticketReference: payment.payment_public_id,
      tableCode: null,
      guestCount: payment.party_size,
      operatorLabel: null,
      note: null,
      payment: paymentFromRow(payment),
      lines: [{
        name: `活动报名 · ${payment.activity_title}`,
        quantity: payment.party_size,
        totalAmountMinor: numeric(payment.payment_amount_minor, 'activity payment amount'),
      }],
      totalAmountMinor: numeric(payment.payment_amount_minor, 'activity payment amount'),
      currency: currency(payment.currency),
    })
    return this.materializeActivityCashier(sourceOutboxMessageId, payment.payment_public_id, snapshot)
  }

  async materializeCashierRefund(
    sourceOutboxMessageId: string,
    refundId: string,
  ): Promise<readonly PrintJob[]> {
    const refund = await this.loadRefundContext(refundId)
    if (refund.refund_status !== 'succeeded') return []
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_refund',
      subtitle: 'M-BOX · 退款已完成',
      test: false,
      issuedAt: refund.completed_at ?? refund.submitted_at,
      businessDate: refund.business_date,
      ticketReference: refund.refund_public_id,
      tableCode: refund.table_code,
      guestCount: refund.guest_count,
      operatorLabel: null,
      note: refund.order_note,
      payment: paymentFromRefund(refund),
      lines: [{ name: `订单退款 · ${refund.order_public_id}`, quantity: 1, totalAmountMinor: numeric(refund.refund_amount_minor, 'refund_amount_minor') }],
      totalAmountMinor: numeric(refund.refund_amount_minor, 'refund_amount_minor'),
      currency: currency(refund.currency),
    })
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference: refund.refund_public_id,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: snapshot.note !== null,
    })
  }

  async materializeActivityCashierRefund(
    sourceOutboxMessageId: string,
    refundId: string,
  ): Promise<readonly PrintJob[]> {
    const refund = await this.loadActivityRefundContext(refundId)
    if (refund.refund_status !== 'succeeded') return []
    const snapshot = createPrintTicketSnapshot({
      kind: 'cashier_refund',
      subtitle: 'M-BOX · 活动退款已完成',
      test: false,
      issuedAt: requiredTime(refund.completed_at, 'activity refund completed_at'),
      businessDate: refund.business_date,
      ticketReference: refund.refund_public_id,
      tableCode: null,
      guestCount: refund.party_size,
      operatorLabel: null,
      note: null,
      payment: paymentFromRow(refund),
      lines: [{
        name: `活动退款 · ${refund.activity_title}`,
        quantity: refund.party_size,
        totalAmountMinor: numeric(refund.refund_amount_minor, 'activity refund amount'),
      }],
      totalAmountMinor: numeric(refund.refund_amount_minor, 'activity refund amount'),
      currency: currency(refund.currency),
    })
    return this.materializeActivityCashier(sourceOutboxMessageId, refund.refund_public_id, snapshot)
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

  private async materializeActivityCashier(
    sourceOutboxMessageId: string,
    sourceReference: string,
    snapshot: Readonly<PrintTicketSnapshot>,
  ): Promise<readonly PrintJob[]> {
    if (!await this.hasActiveRoute('cashier')) return []
    return this.hardware.materializeFromOutbox({
      sourceOutboxMessageId,
      stationCode: 'cashier',
      sourceType: 'cashier',
      sourceReference,
      printSnapshot: ticketToJson(snapshot),
      containsPriorityNote: false,
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

  private async loadRefundContext(refundId: string): Promise<RefundContextRow> {
    const result = await this.transaction.query<RefundContextRow>(`
      SELECT ordering.id AS order_id, ordering.public_id AS order_public_id,
        ordering.note AS order_note, ordering.total_amount_minor, ordering.currency,
        ordering.payment_status, venue_table.code AS table_code, session.guest_count,
        session.business_date::text, ordering.submitted_at::text,
        refund.id AS refund_id, refund.public_id AS refund_public_id,
        refund.amount_minor AS refund_amount_minor, refund.status AS refund_status,
        refund.completed_at::text,
        payment.provider AS payment_provider, payment.method AS payment_method
      FROM mbox.refunds AS refund
      JOIN mbox.payments AS payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id
       AND payment.id=refund.payment_id
      JOIN mbox.orders AS ordering
        ON ordering.tenant_id=payment.tenant_id AND ordering.store_id=payment.store_id
       AND ordering.id=payment.order_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id=ordering.tenant_id AND session.store_id=ordering.store_id
       AND session.id=ordering.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id=session.tenant_id AND venue_table.store_id=session.store_id
       AND venue_table.id=session.table_id
      WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid AND refund.id=$3::uuid
      FOR SHARE OF refund,payment,ordering,session,venue_table
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源退款不存在')
    return row
  }

  private async loadActivityPaymentContext(paymentId: string): Promise<ActivityPaymentContextRow> {
    const result = await this.transaction.query<ActivityPaymentContextRow>(`
      SELECT payment.id AS payment_id,payment.public_id AS payment_public_id,
        payment.provider AS payment_provider,payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor,payment.status AS payment_status_value,
        payment.succeeded_at::text,
        COALESCE(reconciliation.business_date::text,(payment.succeeded_at AT TIME ZONE 'Asia/Shanghai')::date::text) AS business_date,
        activity.public_id AS activity_public_id,activity.title AS activity_title,
        registration.public_id AS registration_public_id,registration.party_size,registration.currency
      FROM mbox.payments payment
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
       AND registration.id=payment.activity_registration_id
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN LATERAL (
        SELECT entry.business_date
        FROM mbox.reconciliation_entries entry
        WHERE entry.tenant_id=payment.tenant_id AND entry.store_id=payment.store_id
          AND entry.payment_id=payment.id AND entry.entry_type='payment'
        ORDER BY entry.occurred_at DESC,entry.id DESC LIMIT 1
      ) reconciliation ON true
      WHERE payment.tenant_id=$1::uuid AND payment.store_id=$2::uuid AND payment.id=$3::uuid
        AND payment.payable_kind='activity_registration'
      FOR SHARE OF payment,registration,activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, paymentId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源活动支付不存在')
    return row
  }

  private async loadActivityRefundContext(refundId: string): Promise<ActivityRefundContextRow> {
    const result = await this.transaction.query<ActivityRefundContextRow>(`
      SELECT payment.id AS payment_id,payment.public_id AS payment_public_id,
        payment.provider AS payment_provider,payment.method AS payment_method,
        payment.amount_minor AS payment_amount_minor,payment.status AS payment_status_value,
        payment.succeeded_at::text,
        COALESCE(reconciliation.business_date::text,(refund.completed_at AT TIME ZONE 'Asia/Shanghai')::date::text) AS business_date,
        activity.public_id AS activity_public_id,activity.title AS activity_title,
        registration.public_id AS registration_public_id,registration.party_size,registration.currency,
        refund.id AS refund_id,refund.public_id AS refund_public_id,
        refund.amount_minor AS refund_amount_minor,refund.status AS refund_status,refund.completed_at::text
      FROM mbox.refunds refund
      JOIN mbox.payments payment
        ON payment.tenant_id=refund.tenant_id AND payment.store_id=refund.store_id AND payment.id=refund.payment_id
      JOIN mbox.community_activity_registrations registration
        ON registration.tenant_id=payment.tenant_id AND registration.store_id=payment.store_id
       AND registration.id=payment.activity_registration_id
      JOIN mbox.community_activities activity
        ON activity.tenant_id=registration.tenant_id AND activity.store_id=registration.store_id
       AND activity.id=registration.activity_id
      LEFT JOIN LATERAL (
        SELECT entry.business_date
        FROM mbox.reconciliation_entries entry
        WHERE entry.tenant_id=refund.tenant_id AND entry.store_id=refund.store_id
          AND entry.refund_id=refund.id AND entry.entry_type='refund'
        ORDER BY entry.occurred_at DESC,entry.id DESC LIMIT 1
      ) reconciliation ON true
      WHERE refund.tenant_id=$1::uuid AND refund.store_id=$2::uuid AND refund.id=$3::uuid
        AND payment.payable_kind='activity_registration'
      FOR SHARE OF refund,payment,registration,activity
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    const row = result.rows[0]
    if (!row) throw new Error('打印源活动退款不存在')
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

function cashierPaymentSnapshot(context: Readonly<PaymentContextRow>): PrintTicketSnapshot {
  const amount = numeric(context.payment_amount_minor, 'payment_amount_minor')
  return createPrintTicketSnapshot({
    kind: 'cashier_payment',
    subtitle: 'M-BOX · 本次收款凭条',
    test: false,
    issuedAt: context.succeeded_at ?? context.submitted_at,
    businessDate: context.business_date,
    ticketReference: context.payment_public_id,
    tableCode: context.table_code,
    guestCount: context.guest_count,
    operatorLabel: null,
    note: context.order_note,
    payment: paymentFromRow(context),
    lines: [{ name: `本次收款 · ${context.order_public_id}`, quantity: 1, totalAmountMinor: amount }],
    totalAmountMinor: amount,
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

function paymentFromRow(row: Readonly<Pick<PaymentContextRow, 'payment_provider' | 'payment_method'>>): PrintTicketPayment {
  const provider = row.payment_provider
  const method = row.payment_method
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation'].includes(provider)) throw new Error('支付方式无效')
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(method)) throw new Error('支付渠道无效')
  return { provider: provider as PrintTicketPayment['provider'], method: method as PrintTicketPayment['method'] }
}

function paymentFromRefund(row: Readonly<RefundContextRow>): PrintTicketPayment {
  const provider = row.payment_provider
  const method = row.payment_method
  if (!['wechat', 'postar', 'cash', 'physical_pos', 'external_manual', 'simulation'].includes(provider)) {
    throw new Error('退款支付方式无效')
  }
  if (!['jsapi', 'native_qr', 'auth_code', 'cash', 'card', 'manual'].includes(method)) {
    throw new Error('退款支付渠道无效')
  }
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

function requiredTime(value: string | null, field: string): string {
  if (value === null || Number.isNaN(Date.parse(value))) throw new Error(`${field}无效`)
  return value
}
