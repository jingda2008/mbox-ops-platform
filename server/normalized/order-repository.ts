import { randomUUID } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  assertVerifiedPricingAuthorization,
  PricingAuthorizationDeniedError,
  type VerifiedPricingAuthorization,
} from './pricing-authorization-policy.js'

export type OrderChannel =
  | 'guest_qr'
  | 'staff_assisted'
  | 'cashier'
  | 'reservation'
  | 'integration'

export type SettlementMode = 'immediate_payment' | 'table_tab'

export type FulfillmentStation = 'bar' | 'kitchen' | 'cashier' | 'none'

export interface SubmitOrderLineInput {
  productId: string
  quantity: number
  note?: string | null
}

export interface CreateSubmittedOrderInput {
  tableSessionId: string
  publicId: string
  channel: OrderChannel
  settlementMode?: SettlementMode
  lines: readonly SubmitOrderLineInput[]
  note?: string | null
  createdByEmployeeId?: string | null
  createdByCustomerId?: string | null
}

export interface OrderItem {
  id: string
  orderId: string
  productId: string
  parentOrderItemId: string | null
  billable: boolean
  consumesInventory: boolean
  quantity: number
  unitPriceMinor: number
  discountAmountMinor: number
  totalAmountMinor: number
  currency: string
  fulfillmentStation: FulfillmentStation
  productSnapshot: JsonObject
  costSnapshot: JsonObject
  status: 'submitted' | 'delivered' | 'cancelled'
  note: string | null
  createdAt: string
}

export interface SubmittedOrder {
  id: string
  tableSessionId: string
  publicId: string
  channel: OrderChannel
  settlementMode: SettlementMode
  status: 'submitted'
  paymentStatus: 'unpaid'
  subtotalAmountMinor: number
  discountAmountMinor: number
  totalAmountMinor: number
  currency: string
  note: string | null
  createdByEmployeeId: string | null
  createdByCustomerId: string | null
  createdAt: string
  submittedAt: string
  items: readonly OrderItem[]
}

interface ProductPriceRow extends Record<string, unknown> {
  request_index: number
  product_id: string
  product_code: string
  product_name: string
  category_code: string
  product_kind: 'single' | 'bundle'
  fulfillment_station: FulfillmentStation
  product_snapshot: unknown
  price_type: string
  amount_minor: string | number
  currency: string
  store_timezone: string
  store_local_time: string
  store_iso_weekday: number
}

interface BundleComponentRow extends Record<string, unknown> {
  request_index: number
  bundle_product_id: string
  component_product_id: string
  component_code: string
  component_name: string
  component_category_code: string
  component_fulfillment_station: FulfillmentStation
  component_product_snapshot: unknown
  component_product_kind: 'single' | 'bundle'
  component_status: 'active' | 'sold_out' | 'inactive'
  component_quantity: number
}

interface OrderRow extends Record<string, unknown> {
  id: string
  table_session_id: string
  public_id: string
  channel: OrderChannel
  settlement_mode: SettlementMode
  status: 'submitted'
  payment_status: 'unpaid'
  subtotal_amount_minor: string | number
  discount_amount_minor: string | number
  total_amount_minor: string | number
  currency: string
  note: string | null
  created_by_employee_id: string | null
  created_by_customer_id: string | null
  created_at: string
  submitted_at: string
}

interface OrderItemRow extends Record<string, unknown> {
  id: string
  order_id: string
  product_id: string
  parent_order_item_id: string | null
  quantity: number
  unit_price_minor: string | number
  discount_amount_minor: string | number
  total_amount_minor: string | number
  currency: string
  fulfillment_station: FulfillmentStation
  product_snapshot: unknown
  cost_snapshot: unknown
  status: 'submitted' | 'delivered' | 'cancelled'
  note: string | null
  created_at: string
}

interface RequestedLineRecord {
  requestIndex: number
  productId: string
  quantity: number
  note: string | null
}

export class TableSessionUnavailableForOrderError extends Error {
  constructor(tableSessionId: string) {
    super(`Table session is not open for ordering: ${tableSessionId}`)
    this.name = 'TableSessionUnavailableForOrderError'
  }
}

export class OrderProductUnavailableError extends Error {
  constructor(productId: string) {
    super(`Product or active standard price is unavailable: ${productId}`)
    this.name = 'OrderProductUnavailableError'
  }
}

export class OrderDeliveryBlockedError extends Error {
  constructor(orderItemId: string) {
    super(`Order item is not ready for delivery: ${orderItemId}`)
    this.name = 'OrderDeliveryBlockedError'
  }
}

export class OrderRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createSubmitted(
    input: Readonly<CreateSubmittedOrderInput>,
    pricingAuthorization?: Readonly<VerifiedPricingAuthorization>,
  ): Promise<SubmittedOrder> {
    validateCreateInput(input)
    if (pricingAuthorization) assertVerifiedPricingAuthorization(pricingAuthorization)
    const requested = normalizeRequestedLines(input.lines)
    await this.lockOpenTableSession(input.tableSessionId)
    const priced = await this.loadCurrentPrices(requested)
    const currency = requireSingleCurrency(priced)
    const grossItems = priced.map((price, index) => {
      assertProductOrderable(price, requested[index]!, input.channel)
      return buildItem(price, requested[index]!)
    })
    const subtotalAmountMinor = sumSafe(grossItems.map((item) => item.unitPriceMinor * item.quantity))
    validatePricingAuthorization(pricingAuthorization, subtotalAmountMinor)
    const itemRows = allocatePricingAdjustment(grossItems, pricingAuthorization)
    const bundleComponents = await this.loadBundleComponents(requested, priced)
    const operationalItems = expandBundleItems(itemRows, bundleComponents)
    const discountAmountMinor = sumSafe(itemRows.map((item) => item.discountAmountMinor))
    const totalAmountMinor = subtotalAmountMinor - discountAmountMinor

    const insertedOrder = await this.transaction.query<OrderRow>(`
      INSERT INTO mbox.orders (
        tenant_id, store_id, table_session_id, public_id, channel, settlement_mode,
        status, payment_status, subtotal_amount_minor, discount_amount_minor,
        total_amount_minor, currency, note, created_by_employee_id,
        created_by_customer_id, submitted_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
        'submitted', 'unpaid', $7::bigint, $8::bigint,
        $9::bigint, $10, $11, $12::uuid, $13::uuid, clock_timestamp()
      )
      RETURNING id, table_session_id, public_id, channel, settlement_mode,
        status, payment_status, subtotal_amount_minor, discount_amount_minor,
        total_amount_minor, currency, note, created_by_employee_id, created_by_customer_id,
        created_at::text, submitted_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.publicId,
      input.channel,
      input.settlementMode ?? 'table_tab',
      subtotalAmountMinor,
      discountAmountMinor,
      totalAmountMinor,
      currency,
      input.note ?? null,
      input.createdByEmployeeId ?? null,
      input.createdByCustomerId ?? null,
    ])
    const order = requireOne(insertedOrder, 'Submitted order insert')

    const insertedItems: OrderItem[] = []
    for (const item of operationalItems) {
      const inserted = await this.transaction.query<OrderItemRow>(`
        INSERT INTO mbox.order_items (
          id, tenant_id, store_id, order_id, product_id, parent_order_item_id, quantity,
          unit_price_minor, discount_amount_minor, total_amount_minor, currency,
          fulfillment_station, product_snapshot, cost_snapshot, status, note
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
          $8::bigint, $9::bigint, $10::bigint, $11,
          $12, $13::jsonb, $14::jsonb, 'submitted', $15
        )
        RETURNING id, order_id, product_id, parent_order_item_id, quantity, unit_price_minor,
          discount_amount_minor, total_amount_minor, currency, fulfillment_station,
          product_snapshot, cost_snapshot, status, note, created_at::text
      `, [
        item.id,
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        order.id,
        item.productId,
        item.parentOrderItemId,
        item.quantity,
        item.unitPriceMinor,
        item.discountAmountMinor,
        item.totalAmountMinor,
        item.currency,
        item.fulfillmentStation,
        JSON.stringify(item.productSnapshot),
        JSON.stringify(item.costSnapshot),
        item.note,
      ])
      insertedItems.push(mapOrderItem(requireOne(inserted, 'Order item insert')))
    }

    return { ...mapOrder(order), items: insertedItems }
  }

  async markDelivered(orderItemId: string, deliveredByEmployeeId: string): Promise<OrderItem> {
    requireUuidLike('orderItemId', orderItemId)
    requireUuidLike('deliveredByEmployeeId', deliveredByEmployeeId)
    const updated = await this.transaction.query<OrderItemRow>(`
      WITH candidate AS (
        SELECT item.id
        FROM mbox.order_items AS item
        WHERE item.tenant_id = $1::uuid
          AND item.store_id = $2::uuid
          AND item.id = $3::uuid
          AND item.status = 'submitted'
          AND EXISTS (
            SELECT 1
            FROM mbox.employees AS employee
            WHERE employee.tenant_id = item.tenant_id
              AND employee.store_id = item.store_id
              AND employee.id = $4::uuid
              AND employee.status = 'active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM mbox.kds_tasks AS task
            WHERE task.tenant_id = item.tenant_id
              AND task.store_id = item.store_id
              AND task.order_item_id = item.id
              AND task.status <> 'ready'
          )
        FOR UPDATE OF item
      )
      UPDATE mbox.order_items AS item
      SET status = 'delivered', updated_at = clock_timestamp()
      FROM candidate
      WHERE item.tenant_id = $1::uuid
        AND item.store_id = $2::uuid
        AND item.id = candidate.id
      RETURNING item.id, item.order_id, item.product_id, item.parent_order_item_id, item.quantity,
        item.unit_price_minor, item.discount_amount_minor, item.total_amount_minor,
        item.currency, item.fulfillment_station, item.product_snapshot,
        item.cost_snapshot, item.status, item.note, item.created_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      orderItemId,
      deliveredByEmployeeId,
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new OrderDeliveryBlockedError(orderItemId)
    }
    return mapOrderItem(row)
  }

  private async lockOpenTableSession(tableSessionId: string): Promise<void> {
    requireUuidLike('tableSessionId', tableSessionId)
    const locked = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status = 'open'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    if (locked.rowCount !== 1) throw new TableSessionUnavailableForOrderError(tableSessionId)
  }

  private async loadCurrentPrices(requested: readonly RequestedLineRecord[]): Promise<ProductPriceRow[]> {
    const result = await this.transaction.query<ProductPriceRow>(`
      WITH requested AS (
        SELECT request_index, product_id
        FROM jsonb_to_recordset($3::jsonb)
          AS line(request_index integer, product_id uuid)
      )
      SELECT requested.request_index, product.id AS product_id,
        product.code AS product_code, product.name AS product_name,
        product.category_code, product.product_kind, product.fulfillment_station,
        product.product_snapshot, price.price_type,
        price.amount_minor, price.currency, store.timezone AS store_timezone,
        to_char(clock_timestamp() AT TIME ZONE store.timezone, 'HH24:MI') AS store_local_time,
        extract(isodow FROM clock_timestamp() AT TIME ZONE store.timezone)::integer AS store_iso_weekday
      FROM requested
      JOIN mbox.stores AS store
        ON store.tenant_id = $1::uuid
       AND store.id = $2::uuid
       AND store.status = 'active'
      JOIN mbox.products AS product
        ON product.tenant_id = $1::uuid
       AND product.store_id = $2::uuid
       AND product.id = requested.product_id
       AND product.status = 'active'
      JOIN LATERAL (
        SELECT candidate.price_type, candidate.amount_minor, candidate.currency
        FROM mbox.product_prices AS candidate
        WHERE candidate.tenant_id = product.tenant_id
          AND candidate.store_id = product.store_id
          AND candidate.product_id = product.id
          AND candidate.price_type = 'standard'
          AND candidate.valid_from <= clock_timestamp()
          AND (candidate.valid_until IS NULL OR candidate.valid_until > clock_timestamp())
        ORDER BY candidate.valid_from DESC, candidate.id DESC
        LIMIT 1
      ) AS price ON true
      ORDER BY requested.request_index
      FOR KEY SHARE OF product
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      JSON.stringify(requested.map((line) => ({
        request_index: line.requestIndex,
        product_id: line.productId,
      }))),
    ])
    if (result.rows.length !== requested.length) {
      const found = new Set(result.rows.map((row) => row.request_index))
      const missing = requested.find((line) => !found.has(line.requestIndex))!
      throw new OrderProductUnavailableError(missing.productId)
    }
    return result.rows
  }

  private async loadBundleComponents(
    requested: readonly RequestedLineRecord[],
    priced: readonly ProductPriceRow[],
  ): Promise<BundleComponentRow[]> {
    const bundles = priced.flatMap((price, index) => price.product_kind === 'bundle'
      ? [{
          request_index: requested[index]!.requestIndex,
          bundle_product_id: price.product_id,
          ordered_quantity: requested[index]!.quantity,
        }]
      : [])
    if (bundles.length === 0) return []
    const result = await this.transaction.query<BundleComponentRow>(`
      WITH requested_bundle AS (
        SELECT request_index, bundle_product_id, ordered_quantity
        FROM jsonb_to_recordset($3::jsonb)
          AS line(request_index integer, bundle_product_id uuid, ordered_quantity integer)
      )
      SELECT requested_bundle.request_index,
        requested_bundle.bundle_product_id,
        component.component_product_id,
        product.code AS component_code,
        product.name AS component_name,
        product.category_code AS component_category_code,
        product.fulfillment_station AS component_fulfillment_station,
        product.product_snapshot AS component_product_snapshot,
        product.product_kind AS component_product_kind,
        product.status AS component_status,
        component.quantity * requested_bundle.ordered_quantity AS component_quantity
      FROM requested_bundle
      JOIN mbox.product_bundle_components AS component
        ON component.tenant_id = $1::uuid
       AND component.store_id = $2::uuid
       AND component.bundle_product_id = requested_bundle.bundle_product_id
      JOIN mbox.products AS product
        ON product.tenant_id = component.tenant_id
       AND product.store_id = component.store_id
       AND product.id = component.component_product_id
      ORDER BY requested_bundle.request_index, component.sort_order, component.component_product_id
      FOR KEY SHARE OF component, product
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      JSON.stringify(bundles),
    ])
    for (const bundle of bundles) {
      const components = result.rows.filter((row) => row.request_index === bundle.request_index)
      if (components.length === 0) throw new OrderProductUnavailableError(bundle.bundle_product_id)
      for (const component of components) {
        if (component.component_product_kind !== 'single'
          || component.component_status !== 'active'
          || !Number.isInteger(component.component_quantity)
          || component.component_quantity < 1
          || component.component_quantity > 999) {
          throw new OrderProductUnavailableError(bundle.bundle_product_id)
        }
      }
    }
    return result.rows
  }
}

function normalizeRequestedLines(lines: readonly SubmitOrderLineInput[]): RequestedLineRecord[] {
  if (lines.length < 1 || lines.length > 100) {
    throw new TypeError('lines must contain between 1 and 100 items')
  }
  return lines.map((line, requestIndex) => {
    requireUuidLike(`lines[${requestIndex}].productId`, line.productId)
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) {
      throw new TypeError(`lines[${requestIndex}].quantity must be an integer between 1 and 999`)
    }
    const untrustedLine = line as SubmitOrderLineInput & Record<string, unknown>
    if ('priceType' in untrustedLine || 'discountAmountMinor' in untrustedLine) {
      throw new PricingAuthorizationDeniedError(
        'Order lines cannot select a price type or discount amount',
      )
    }
    return {
      requestIndex,
      productId: line.productId,
      quantity: line.quantity,
      note: line.note?.trim() || null,
    }
  })
}

function buildItem(price: ProductPriceRow, requested: RequestedLineRecord) {
  const unitPriceMinor = asSafeMoney(price.amount_minor, 'unit price')
  const gross = unitPriceMinor * requested.quantity
  if (!Number.isSafeInteger(gross)) {
    throw new TypeError(`Invalid line total for product ${requested.productId}`)
  }
  return {
    id: randomUUID(),
    requestIndex: requested.requestIndex,
    productId: requested.productId,
    parentOrderItemId: null as string | null,
    quantity: requested.quantity,
    unitPriceMinor,
    discountAmountMinor: 0,
    totalAmountMinor: gross,
    currency: price.currency,
    fulfillmentStation: price.product_kind === 'bundle' ? 'none' as const : price.fulfillment_station,
    productSnapshot: {
      code: price.product_code,
      name: price.product_name,
      categoryCode: price.category_code,
      priceType: price.price_type,
      productKind: price.product_kind,
      source: toJsonObject(price.product_snapshot),
    },
    costSnapshot: costSnapshot(price.product_snapshot),
    note: requested.note,
  }
}

function expandBundleItems<T extends ReturnType<typeof buildItem>>(
  paidItems: readonly T[],
  components: readonly BundleComponentRow[],
): Array<T & { parentOrderItemId: string | null }> {
  const operational: Array<T & { parentOrderItemId: string | null }> = paidItems
    .map((item) => ({ ...item, parentOrderItemId: null }))
  for (const parent of paidItems) {
    if (parent.productSnapshot.productKind !== 'bundle') continue
    for (const component of components.filter((row) => row.request_index === parent.requestIndex)) {
      operational.push({
        ...parent,
        id: randomUUID(),
        productId: component.component_product_id,
        parentOrderItemId: parent.id,
        quantity: component.component_quantity,
        unitPriceMinor: 0,
        discountAmountMinor: 0,
        totalAmountMinor: 0,
        fulfillmentStation: component.component_fulfillment_station,
        productSnapshot: {
          code: component.component_code,
          name: component.component_name,
          categoryCode: component.component_category_code,
          priceType: 'bundle_component',
          productKind: 'single',
          source: toJsonObject(component.component_product_snapshot),
          bundleComponent: true,
          paidByParentOrderItemId: parent.id,
        },
        costSnapshot: {},
      })
    }
  }
  return operational
}

function costSnapshot(productSnapshot: unknown): JsonObject {
  const source = toJsonObject(productSnapshot)
  const unitCostMinor = source.costAmount
  if (!Number.isSafeInteger(unitCostMinor) || Number(unitCostMinor) < 0) return {}
  return {
    unitCostMinor: Number(unitCostMinor),
    source: 'catalog_at_order_submission',
  }
}

function validatePricingAuthorization(
  authorization: Readonly<VerifiedPricingAuthorization> | undefined,
  subtotalAmountMinor: number,
): void {
  if (!authorization) return
  if (authorization.amountMinor > subtotalAmountMinor) {
    throw new TypeError('Authorized pricing adjustment exceeds the order subtotal')
  }
  if (authorization.kind === 'discount' && authorization.amountMinor === subtotalAmountMinor) {
    throw new TypeError('A zero-total order requires an explicit gift authorization')
  }
}

function allocatePricingAdjustment<T extends {
  unitPriceMinor: number
  quantity: number
  discountAmountMinor: number
  totalAmountMinor: number
  productSnapshot: JsonObject
}>(
  items: readonly T[],
  authorization: Readonly<VerifiedPricingAuthorization> | undefined,
): T[] {
  if (!authorization) return [...items]
  let remaining = authorization.amountMinor
  return items.map((item) => {
    const gross = item.unitPriceMinor * item.quantity
    const allocated = Math.min(gross, remaining)
    remaining -= allocated
    return {
      ...item,
      discountAmountMinor: allocated,
      totalAmountMinor: gross - allocated,
      productSnapshot: {
        ...item.productSnapshot,
        pricingAuthorization: {
          authorizationId: authorization.authorizationId,
          kind: authorization.kind,
          sourceType: authorization.sourceType,
          sourceId: authorization.sourceId,
          allocatedAmountMinor: allocated,
        },
      },
    }
  })
}

function requireSingleCurrency(rows: readonly ProductPriceRow[]): string {
  const currencies = new Set(rows.map((row) => row.currency))
  if (currencies.size !== 1) throw new TypeError('All order lines must use the same currency')
  return rows[0]!.currency
}

function mapOrder(row: OrderRow): Omit<SubmittedOrder, 'items'> {
  return {
    id: row.id,
    tableSessionId: row.table_session_id,
    publicId: row.public_id,
    channel: row.channel,
    settlementMode: row.settlement_mode,
    status: row.status,
    paymentStatus: row.payment_status,
    subtotalAmountMinor: asSafeMoney(row.subtotal_amount_minor, 'subtotal'),
    discountAmountMinor: asSafeMoney(row.discount_amount_minor, 'discount'),
    totalAmountMinor: asSafeMoney(row.total_amount_minor, 'total'),
    currency: row.currency,
    note: row.note,
    createdByEmployeeId: row.created_by_employee_id,
    createdByCustomerId: row.created_by_customer_id,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  }
}

function mapOrderItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    parentOrderItemId: row.parent_order_item_id,
    billable: row.parent_order_item_id === null,
    consumesInventory: row.parent_order_item_id !== null || row.fulfillment_station !== 'none',
    quantity: row.quantity,
    unitPriceMinor: asSafeMoney(row.unit_price_minor, 'unit price'),
    discountAmountMinor: asSafeMoney(row.discount_amount_minor, 'discount'),
    totalAmountMinor: asSafeMoney(row.total_amount_minor, 'total'),
    currency: row.currency,
    fulfillmentStation: row.fulfillment_station,
    productSnapshot: toJsonObject(row.product_snapshot),
    costSnapshot: toJsonObject(row.cost_snapshot),
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  }
}

function validateCreateInput(input: Readonly<CreateSubmittedOrderInput>): void {
  requireUuidLike('tableSessionId', input.tableSessionId)
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.createdByEmployeeId) requireUuidLike('createdByEmployeeId', input.createdByEmployeeId)
  if (input.createdByCustomerId) requireUuidLike('createdByCustomerId', input.createdByCustomerId)
  if (input.createdByEmployeeId && input.createdByCustomerId) {
    throw new TypeError('An order cannot have both an employee and guest creator')
  }
  if (input.settlementMode !== undefined
    && input.settlementMode !== 'immediate_payment'
    && input.settlementMode !== 'table_tab') {
    throw new TypeError('settlementMode is invalid')
  }
}

function assertProductOrderable(
  price: ProductPriceRow,
  requested: RequestedLineRecord,
  channel: OrderChannel,
): void {
  const snapshot = toJsonObject(price.product_snapshot)
  const configuredMaximum = snapshot.maxOrderQuantity
  const maximum = configuredMaximum === undefined || configuredMaximum === null
    ? 50
    : readPositiveInteger(configuredMaximum)
  if (maximum === null) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  if (requested.quantity > maximum) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  const allowedChannels = readStringArray(snapshot.allowedChannels)
  if (allowedChannels !== null && !allowedChannels.includes(channel)) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  const windows = snapshot.orderWindows
  if (windows === undefined || windows === null) return
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  const localTime = price.store_local_time
  const weekday = price.store_iso_weekday
  const orderable = windows.some((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const window = value as Record<string, unknown>
    const days = Array.isArray(window.days)
      ? window.days.filter((day): day is number => Number.isInteger(day) && Number(day) >= 1 && Number(day) <= 7)
      : []
    if (days.length > 0 && !days.includes(weekday)) return false
    if (typeof window.start !== 'string' || typeof window.end !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.start)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.end)) return false
    return window.start <= window.end
      ? localTime >= window.start && localTime < window.end
      : localTime >= window.start || localTime < window.end
  })
  if (!orderable) throw new OrderProductUnavailableError(requested.productId)
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 999
    ? Number(value)
    : null
}

function readStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return []
  return value.map((item) => String(item))
}

function requireUuidLike(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}

function requireMoney(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
}

function asSafeMoney(value: string | number, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  requireMoney(name, parsed)
  return parsed
}

function sumSafe(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) throw new TypeError('Order total exceeds the safe integer range')
  return total
}

function toJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object from PostgreSQL')
  }
  return value as JsonObject
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  operation: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${operation} did not affect exactly one row`)
  return row
}
