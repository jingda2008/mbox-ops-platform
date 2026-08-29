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

export type OrderItemCostSource =
  | 'catalog_product'
  | 'legacy_snapshot'
  | 'included_in_parent'
  | 'unavailable'

export type OrderItemLoyaltyEligibilitySource =
  | 'catalog_product'
  | 'included_in_parent'
  | 'legacy_current_catalog'

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
  fulfillmentPriority?: number
  fulfillmentDueAt?: string | null
  productSnapshot: JsonObject
  costSnapshot: JsonObject
  unitCostMinorAtSubmission: number | null
  totalCostMinorAtSubmission: number | null
  costSource: OrderItemCostSource
  costReferenceProductId: string | null
  costReferenceOrderItemId: string | null
  costReferenceProductUpdatedAt: string | null
  loyaltyEligibleAtSubmission: boolean
  loyaltyEligibilitySource: OrderItemLoyaltyEligibilitySource
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
  paymentStatus: 'unpaid' | 'pending' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded'
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
  guest_visible: boolean
  allowed_channels: OrderChannel[]
  max_order_quantity: number
  available_from: string | null
  available_until: string | null
  kds_priority: number
  fulfillment_sla_seconds: number | null
  cost_amount_minor: string | number | null
  loyalty_eligible: boolean
  product_updated_at: string
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
  component_kds_priority: number
  component_fulfillment_sla_seconds: number | null
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
  payment_status: SubmittedOrder['paymentStatus']
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
  fulfillment_priority: number
  fulfillment_due_at: string | null
  product_snapshot: unknown
  cost_snapshot: unknown
  unit_cost_minor_at_submission: string | number | null
  total_cost_minor_at_submission: string | number | null
  cost_source: OrderItemCostSource
  cost_reference_product_id: string | null
  cost_reference_order_item_id: string | null
  cost_reference_product_updated_at: string | null
  loyalty_eligible_at_submission: boolean
  loyalty_eligibility_source: OrderItemLoyaltyEligibilitySource
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

export class OrderProductCostUnavailableError extends Error {
  constructor(productId: string) {
    super(`Product has no authoritative catalog cost: ${productId}`)
    this.name = 'OrderProductCostUnavailableError'
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

  /**
   * Reuses the order-price authority for a server-owned cart before it accepts
   * a quantity increase.  Checkout repeats the full order and inventory
   * validation in the same transaction that creates the submitted order.
   */
  async assertCurrentOrderable(
    lines: readonly SubmitOrderLineInput[],
    channel: OrderChannel,
  ): Promise<void> {
    const requested = normalizeRequestedLines(lines)
    const priced = await this.loadCurrentPrices(requested)
    for (const [index, price] of priced.entries()) {
      assertProductOrderable(price, requested[index]!, channel)
    }
    await this.loadBundleComponents(requested, priced)
  }

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
        created_by_customer_id, submitted_at, fulfillment_state,
        fulfillment_expires_at, fulfillment_activated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
        'submitted', 'unpaid', $7::bigint, $8::bigint,
        $9::bigint, $10, $11, $12::uuid, $13::uuid, clock_timestamp(),
        CASE WHEN $6 = 'immediate_payment' THEN 'awaiting_payment' ELSE 'active' END,
        CASE WHEN $6 = 'immediate_payment' THEN clock_timestamp() + make_interval(mins => COALESCE((
          SELECT policy.payment_reservation_minutes
          FROM mbox.store_commerce_policies AS policy
          WHERE policy.tenant_id = $1::uuid AND policy.store_id = $2::uuid
        ), 10)) ELSE NULL END,
        CASE WHEN $6 = 'table_tab' THEN clock_timestamp() ELSE NULL END
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
          fulfillment_station, fulfillment_priority, fulfillment_due_at,
          product_snapshot, cost_snapshot, unit_cost_minor_at_submission,
          total_cost_minor_at_submission, cost_source, cost_reference_product_id,
          cost_reference_order_item_id, cost_reference_product_updated_at,
          loyalty_eligible_at_submission, loyalty_eligibility_source,
          status, note
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
          $8::bigint, $9::bigint, $10::bigint, $11,
          $12, $13::smallint, $14::timestamptz, $15::jsonb, $16::jsonb,
          $17::bigint, $18::bigint, $19, $20::uuid, $21::uuid, $22::timestamptz,
          $23, $24, 'submitted', $25
        )
        RETURNING id, order_id, product_id, parent_order_item_id, quantity, unit_price_minor,
          discount_amount_minor, total_amount_minor, currency, fulfillment_station,
          fulfillment_priority, fulfillment_due_at::text,
          product_snapshot, cost_snapshot, unit_cost_minor_at_submission,
          total_cost_minor_at_submission, cost_source, cost_reference_product_id,
          cost_reference_order_item_id, cost_reference_product_updated_at::text,
          loyalty_eligible_at_submission, loyalty_eligibility_source,
          status, note, created_at::text
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
        item.fulfillmentPriority,
        item.fulfillmentDueAt,
        JSON.stringify(item.productSnapshot),
        JSON.stringify(item.costSnapshot),
        item.unitCostMinorAtSubmission,
        item.totalCostMinorAtSubmission,
        item.costSource,
        item.costReferenceProductId,
        item.costReferenceOrderItemId,
        item.costReferenceProductUpdatedAt,
        item.loyaltyEligibleAtSubmission,
        item.loyaltyEligibilitySource,
        item.note,
      ])
      insertedItems.push(mapOrderItem(requireOne(inserted, 'Order item insert')))
    }

    return { ...mapOrder(order), items: insertedItems }
  }

  async getSubmittedForFulfillment(orderId: string): Promise<SubmittedOrder> {
    requireUuidLike('orderId', orderId)
    const selectedOrder = await this.transaction.query<OrderRow>(`
      SELECT id, table_session_id, public_id, channel, settlement_mode,
        status, payment_status, subtotal_amount_minor, discount_amount_minor,
        total_amount_minor, currency, note, created_by_employee_id, created_by_customer_id,
        created_at::text, submitted_at::text
      FROM mbox.orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND status = 'submitted'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    const order = requireOne(selectedOrder, 'Submitted fulfillment order lookup')
    const selectedItems = await this.transaction.query<OrderItemRow>(`
      SELECT id, order_id, product_id, parent_order_item_id, quantity, unit_price_minor,
        discount_amount_minor, total_amount_minor, currency, fulfillment_station,
        fulfillment_priority, fulfillment_due_at::text,
        product_snapshot, cost_snapshot, unit_cost_minor_at_submission,
        total_cost_minor_at_submission, cost_source, cost_reference_product_id,
        cost_reference_order_item_id, cost_reference_product_updated_at::text,
        loyalty_eligible_at_submission, loyalty_eligibility_source,
        status, note, created_at::text
      FROM mbox.order_items
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
      ORDER BY created_at, id
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderId])
    return { ...mapOrder(order), items: selectedItems.rows.map(mapOrderItem) }
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
        item.fulfillment_priority, item.fulfillment_due_at::text,
        item.cost_snapshot, item.unit_cost_minor_at_submission,
        item.total_cost_minor_at_submission, item.cost_source,
        item.cost_reference_product_id, item.cost_reference_order_item_id,
        item.cost_reference_product_updated_at::text,
        item.loyalty_eligible_at_submission, item.loyalty_eligibility_source,
        item.status, item.note, item.created_at::text
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
    await this.transaction.query(
      'SELECT mbox.complete_annual_benefit_fulfillment_for_order($1::uuid)',
      [row.order_id],
    )
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
        product.product_snapshot, product.guest_visible, product.allowed_channels,
        product.max_order_quantity,
        to_char(product.available_from, 'HH24:MI') AS available_from,
        to_char(product.available_until, 'HH24:MI') AS available_until,
        product.kds_priority, product.fulfillment_sla_seconds,
        product.cost_amount_minor, product.loyalty_eligible,
        product.updated_at::text AS product_updated_at,
        price.price_type,
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
      FOR SHARE OF product
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
        product.kds_priority AS component_kds_priority,
        product.fulfillment_sla_seconds AS component_fulfillment_sla_seconds,
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
  const fulfillmentStation = price.product_kind === 'bundle' ? 'none' as const : price.fulfillment_station
  const unitCostMinorAtSubmission = authoritativeCatalogCostOrNull(price.cost_amount_minor)
  const costKnown = unitCostMinorAtSubmission !== null
  const totalCostMinorAtSubmission = costKnown
    ? multiplySafeMoney(
      unitCostMinorAtSubmission,
      requested.quantity,
      `catalog cost total for product ${requested.productId}`,
    )
    : null
  const costReferenceProductUpdatedAt = costKnown
    ? authoritativeCatalogCostVersion(price.product_updated_at, requested.productId)
    : null
  const costSource: OrderItemCostSource = costKnown ? 'catalog_product' : 'unavailable'
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
    fulfillmentStation,
    fulfillmentPriority: price.kds_priority,
    fulfillmentDueAt: fulfillmentDueAt(fulfillmentStation, price.fulfillment_sla_seconds),
    productSnapshot: {
      code: price.product_code,
      name: price.product_name,
      categoryCode: price.category_code,
      priceType: price.price_type,
      productKind: price.product_kind,
      source: toJsonObject(price.product_snapshot),
    },
    unitCostMinorAtSubmission,
    totalCostMinorAtSubmission,
    costSource,
    costReferenceProductId: costKnown ? requested.productId : null,
    costReferenceOrderItemId: null as string | null,
    costReferenceProductUpdatedAt,
    loyaltyEligibleAtSubmission: price.loyalty_eligible,
    loyaltyEligibilitySource: 'catalog_product' as const,
    costSnapshot: costSnapshot(
      unitCostMinorAtSubmission,
      totalCostMinorAtSubmission,
      costSource,
    ),
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
        fulfillmentPriority: component.component_kds_priority,
        fulfillmentDueAt: fulfillmentDueAt(
          component.component_fulfillment_station,
          component.component_fulfillment_sla_seconds,
        ),
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
        unitCostMinorAtSubmission: 0,
        totalCostMinorAtSubmission: 0,
        costSource: 'included_in_parent',
        costReferenceProductId: null,
        costReferenceOrderItemId: parent.id,
        costReferenceProductUpdatedAt: null,
        loyaltyEligibleAtSubmission: false,
        loyaltyEligibilitySource: 'included_in_parent',
        costSnapshot: costSnapshot(0, 0, 'included_in_parent'),
      })
    }
  }
  return operational
}

function authoritativeCatalogCostOrNull(costAmountMinor: unknown): number | null {
  const unitCostMinor = typeof costAmountMinor === 'string' && /^\d+$/.test(costAmountMinor)
    ? Number(costAmountMinor)
    : costAmountMinor
  if (!Number.isSafeInteger(unitCostMinor) || Number(unitCostMinor) < 0) {
    return null
  }
  return Number(unitCostMinor)
}

function multiplySafeMoney(unitAmount: number, quantity: number, label: string): number {
  const total = unitAmount * quantity
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError(`${label} is not a non-negative safe integer`)
  return total
}

function authoritativeCatalogCostVersion(value: unknown, productId: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new OrderProductCostUnavailableError(productId)
  }
  return value
}

function costSnapshot(
  unitCostMinor: number | null,
  totalCostMinor: number | null,
  source: 'catalog_product' | 'included_in_parent' | 'unavailable',
): JsonObject {
  if (unitCostMinor === null || totalCostMinor === null) {
    return { source, authority: 'strong_order_item_columns' }
  }
  return { unitCostMinor, totalCostMinor, source, authority: 'strong_order_item_columns' }
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
    fulfillmentPriority: row.fulfillment_priority,
    fulfillmentDueAt: row.fulfillment_due_at,
    productSnapshot: toJsonObject(row.product_snapshot),
    costSnapshot: toJsonObject(row.cost_snapshot),
    unitCostMinorAtSubmission: nullableSafeMoney(
      row.unit_cost_minor_at_submission ?? null,
      'unit cost at submission',
    ),
    totalCostMinorAtSubmission: nullableSafeMoney(
      row.total_cost_minor_at_submission ?? null,
      'total cost at submission',
    ),
    costSource: row.cost_source ?? 'unavailable',
    costReferenceProductId: row.cost_reference_product_id ?? null,
    costReferenceOrderItemId: row.cost_reference_order_item_id ?? null,
    costReferenceProductUpdatedAt: row.cost_reference_product_updated_at ?? null,
    loyaltyEligibleAtSubmission: row.loyalty_eligible_at_submission,
    loyaltyEligibilitySource: row.loyalty_eligibility_source,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  }
}

function nullableSafeMoney(value: string | number | null, label: string): number | null {
  return value === null ? null : asSafeMoney(value, label)
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
  if (requested.quantity > price.max_order_quantity) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  if (!price.allowed_channels.includes(channel)
    || (channel === 'guest_qr' && !price.guest_visible)) {
    throw new OrderProductUnavailableError(requested.productId)
  }
  if (price.available_from === null || price.available_until === null) return
  const orderable = price.available_from < price.available_until
    ? price.store_local_time >= price.available_from && price.store_local_time < price.available_until
    : price.store_local_time >= price.available_from || price.store_local_time < price.available_until
  if (!orderable) throw new OrderProductUnavailableError(requested.productId)
}

function fulfillmentDueAt(station: FulfillmentStation, configuredSeconds: number | null): string | null {
  if (station === 'none') return null
  const fallback = station === 'bar' ? 5 * 60 : station === 'kitchen' ? 10 * 60 : 2 * 60
  return new Date(Date.now() + (configuredSeconds ?? fallback) * 1_000).toISOString()
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
