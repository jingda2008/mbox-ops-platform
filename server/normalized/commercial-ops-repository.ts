import { createHash } from 'node:crypto'
import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type CostCategory =
  | 'beverage_purchase' | 'personnel' | 'performer' | 'band'
  | 'rent' | 'utilities' | 'miscellaneous'
export type CostRecognitionState = 'known' | 'accrual' | 'actual'
export type CostAllocationPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'
export type CostSourceType =
  | 'inventory_purchase' | 'payroll' | 'performance' | 'lease' | 'utility_bill' | 'manual'
export type SalesAttributionMode = 'explicit' | 'order_creator' | 'table_primary' | 'disabled'

export interface OperatingCostEntry {
  id: string
  publicId: string
  category: CostCategory
  recognitionState: CostRecognitionState
  allocationPeriod: CostAllocationPeriod
  serviceStartDate: string
  serviceEndDate: string
  cashPaidOn: string | null
  netAmountMinor: number
  taxAmountMinor: number
  grossAmountMinor: number
  currency: string
  sourceType: CostSourceType
  purchaseReceiptLineId: string | null
  employeeId: string | null
  scheduleId: string | null
  sourceReference: string | null
  sourceSnapshot: JsonObject
  correctsCostEntryId: string | null
  correctionReason: string | null
  recordedBusinessDate: string
  recordedByEmployeeId: string
  recordedAt: string
}

export interface WriteOperatingCostInput {
  publicId: string
  category: CostCategory
  recognitionState: CostRecognitionState
  allocationPeriod: CostAllocationPeriod
  serviceStartDate: string
  serviceEndDate: string
  cashPaidOn?: string | null
  netAmountMinor: number
  taxAmountMinor?: number
  currency: string
  sourceType: CostSourceType
  purchaseReceiptLineId?: string | null
  employeeId?: string | null
  scheduleId?: string | null
  sourceReference?: string | null
  sourceSnapshot?: JsonObject
  recordedBusinessDate: string
  recordedByEmployeeId: string
}

export interface EmployeeSalesRule {
  id: string
  productId: string
  attributionMode: SalesAttributionMode
  salesCreditBps: number
  costSource: 'order_item_snapshot' | 'none'
  effectiveFrom: string
  effectiveUntil: string
  ruleSnapshot: JsonObject
  reason: string
  configuredByEmployeeId: string
  createdAt: string
}

export interface CreateEmployeeSalesRuleInput {
  productId: string
  attributionMode: SalesAttributionMode
  salesCreditBps: number
  costSource: 'order_item_snapshot' | 'none'
  effectiveFrom: string
  effectiveUntil: string
  ruleSnapshot?: JsonObject
  reason: string
  configuredByEmployeeId: string
}

export interface EmployeeSalesAttributionEvent {
  id: string
  eventType: 'sale' | 'refund_reversal'
  orderId: string
  orderItemId: string
  employeeId: string
  ruleId: string | null
  sourceSaleEventId: string | null
  refundId: string | null
  businessDate: string
  quantityDelta: string
  salesAmountDeltaMinor: number
  costAmountDeltaMinor: number | null
  currency: string
  productSnapshot: JsonObject
  attributionSnapshot: JsonObject
  recordedByEmployeeId: string
  occurredAt: string
}

export interface RecordSaleAttributionInput {
  orderItemId: string
  explicitEmployeeId?: string | null
  recordedByEmployeeId: string
}

export interface GroupVoucherRedemption {
  id: string
  publicId: string
  platform: string
  campaignName: string
  voucherCodeMasked: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  orderId: string | null
  tableSessionId: string | null
  reconciliationEntryId: string | null
  redeemedByEmployeeId: string
  redeemedBusinessDate: string
  redeemedAt: string
}

export interface RedeemGroupVoucherInput {
  publicId: string
  platform: string
  campaignName: string
  voucherCode: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  orderId?: string | null
  tableSessionId?: string | null
  reconciliationEntryId?: string | null
  redeemedByEmployeeId: string
  redeemedBusinessDate: string
  redeemedAt?: string
}

interface CostRow extends Record<string, unknown> {
  id: string
  public_id: string
  category: CostCategory
  recognition_state: CostRecognitionState
  allocation_period: CostAllocationPeriod
  service_start_date: string
  service_end_date: string
  cash_paid_on: string | null
  net_amount_minor: string | number
  tax_amount_minor: string | number
  gross_amount_minor: string | number
  currency: string
  source_type: CostSourceType
  purchase_receipt_line_id: string | null
  employee_id: string | null
  schedule_id: string | null
  source_reference: string | null
  source_snapshot: JsonObject
  corrects_cost_entry_id: string | null
  correction_reason: string | null
  recorded_business_date: string
  recorded_by_employee_id: string
  recorded_at: string
}

interface RuleRow extends Record<string, unknown> {
  id: string
  product_id: string
  attribution_mode: SalesAttributionMode
  sales_credit_bps: number
  cost_source: 'order_item_snapshot' | 'none'
  effective_from: string
  effective_until: string
  rule_snapshot: JsonObject
  reason: string
  configured_by_employee_id: string
  created_at: string
}

interface SaleSourceRow extends Record<string, unknown> {
  order_id: string
  order_item_id: string
  table_session_id: string
  table_id: string
  order_created_by_employee_id: string | null
  order_created_at: string
  business_date: string
  payment_status: string
  order_status: string
  product_id: string
  quantity: number
  total_amount_minor: string | number
  currency: string
  product_code: string
  product_name: string
  category_code: string
  total_cost_minor_at_submission: string | number | null
  cost_source: 'catalog_product' | 'legacy_snapshot' | 'included_in_parent' | 'unavailable'
}

interface AttributionRow extends Record<string, unknown> {
  id: string
  event_type: 'sale' | 'refund_reversal'
  order_id: string
  order_item_id: string
  employee_id: string
  rule_id: string | null
  source_sale_event_id: string | null
  refund_id: string | null
  business_date: string
  quantity_delta: string
  sales_amount_delta_minor: string | number
  cost_amount_delta_minor: string | number | null
  currency: string
  product_snapshot: JsonObject
  attribution_snapshot: JsonObject
  recorded_by_employee_id: string
  occurred_at: string
}

interface RefundAllocationRow extends Record<string, unknown> {
  refund_id: string
  business_date: string
  order_item_id: string
  item_total_minor: string | number
  cumulative_refund_minor: string | number
}

interface VoucherRow extends Record<string, unknown> {
  id: string
  public_id: string
  platform: string
  campaign_name: string
  voucher_code_masked: string
  face_value_minor: string | number
  settlement_amount_minor: string | number
  currency: string
  order_id: string | null
  table_session_id: string | null
  reconciliation_entry_id: string | null
  redeemed_by_employee_id: string
  redeemed_business_date: string
  redeemed_at: string
}

export class CommercialRecordNotFoundError extends Error {}
export class CostAlreadyCorrectedError extends Error {}
export class SalesRuleOverlapError extends Error {}
export class SalesAttributionNotAllowedError extends Error {}
export class VoucherAlreadyRedeemedError extends Error {}
export class CommercialIntegrityError extends Error {}

export class CommercialOpsRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async createCost(input: Readonly<WriteOperatingCostInput>): Promise<OperatingCostEntry> {
    validateCost(input)
    return this.insertCost(input, null, null)
  }

  async correctCost(
    correctedEntryId: string,
    replacement: Readonly<WriteOperatingCostInput>,
    correctionReason: string,
  ): Promise<OperatingCostEntry> {
    validateCost(replacement)
    nonBlank(correctionReason, 'correctionReason')
    const target = await this.transaction.query<CostRow>(`
      SELECT ${COST_COLUMNS}
      FROM mbox.operating_cost_entries AS cost
      WHERE cost.tenant_id = $1::uuid AND cost.store_id = $2::uuid AND cost.id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, correctedEntryId])
    const current = target.rows[0]
    if (!current) throw new CommercialRecordNotFoundError('Cost entry was not found')
    const child = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.operating_cost_entries
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND corrects_cost_entry_id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, correctedEntryId])
    if (child.rowCount) throw new CostAlreadyCorrectedError('Cost entry already has a correction')
    if (current.currency !== replacement.currency) {
      throw new CommercialIntegrityError('A cost correction cannot change currency')
    }
    try {
      return await this.insertCost(replacement, correctedEntryId, correctionReason.trim())
    } catch (error) {
      if (isUniqueViolation(error)) throw new CostAlreadyCorrectedError('Cost entry already has a correction')
      throw error
    }
  }

  async createSalesRule(input: Readonly<CreateEmployeeSalesRuleInput>): Promise<EmployeeSalesRule> {
    validateSalesRule(input)
    try {
      const result = await this.transaction.query<RuleRow>(`
        INSERT INTO mbox.employee_sales_rules (
          tenant_id, store_id, product_id, attribution_mode, sales_credit_bps,
          cost_source, effective_during, rule_snapshot, reason, configured_by_employee_id
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
          tstzrange($7::timestamptz, $8::timestamptz, '[)'), $9::jsonb, $10, $11::uuid
        )
        RETURNING ${RULE_COLUMNS}
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        input.productId, input.attributionMode, input.salesCreditBps, input.costSource,
        input.effectiveFrom, input.effectiveUntil, JSON.stringify(input.ruleSnapshot ?? {}),
        input.reason.trim(), input.configuredByEmployeeId,
      ])
      return mapRule(required(result.rows[0], 'Sales rule was not inserted'))
    } catch (error) {
      if (hasPostgresCode(error, '23P01')) throw new SalesRuleOverlapError('Product sales rule overlaps an existing rule')
      throw error
    }
  }

  async recordSaleAttribution(
    input: Readonly<RecordSaleAttributionInput>,
  ): Promise<EmployeeSalesAttributionEvent> {
    nonBlank(input.orderItemId, 'orderItemId')
    nonBlank(input.recordedByEmployeeId, 'recordedByEmployeeId')
    const source = await this.lockSaleSource(input.orderItemId)
    if (source.payment_status !== 'paid' || ['draft', 'cancelled'].includes(source.order_status)) {
      throw new SalesAttributionNotAllowedError('Only fully paid, active orders can be attributed')
    }
    const ruleResult = await this.transaction.query<RuleRow>(`
      SELECT ${RULE_COLUMNS}
      FROM mbox.employee_sales_rules
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid
        AND effective_during @> $4::timestamptz
      ORDER BY lower(effective_during) DESC, id
      LIMIT 1
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      source.product_id, source.order_created_at,
    ])
    const rule = ruleResult.rows[0]
    if (!rule || rule.attribution_mode === 'disabled' || rule.sales_credit_bps === 0) {
      throw new SalesAttributionNotAllowedError('This product is not configured for employee sales attribution')
    }
    const employeeId = await this.resolveAttributedEmployee(source, rule, input.explicitEmployeeId)
    const existing = await this.transaction.query<AttributionRow>(`
      SELECT ${ATTRIBUTION_COLUMNS}
      FROM mbox.employee_sales_attribution_events
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND order_item_id = $3::uuid AND event_type = 'sale'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.order_item_id])
    if (existing.rows[0]) {
      if (existing.rows[0].employee_id !== employeeId) {
        throw new SalesAttributionNotAllowedError('Order item already belongs to another employee')
      }
      return mapAttribution(existing.rows[0])
    }

    const itemSales = safeMinor(source.total_amount_minor, 'order item total')
    const attributedSales = prorate(itemSales, rule.sales_credit_bps, 10_000)
    if (attributedSales <= 0) throw new SalesAttributionNotAllowedError('Attributed sales amount rounds to zero')
    const itemCost = rule.cost_source === 'none' ? null : requireFrozenOrderItemCost(source)
    const attributedCost = itemCost === null ? null : prorate(itemCost, rule.sales_credit_bps, 10_000)
    const quantityDelta = decimalProduct(source.quantity, rule.sales_credit_bps, 10_000)
    const snapshot: JsonObject = {
      attributionMode: rule.attribution_mode,
      salesCreditBps: rule.sales_credit_bps,
      costSource: rule.cost_source,
      orderItemCostSource: source.cost_source,
      ruleId: rule.id,
    }
    const inserted = await this.transaction.query<AttributionRow>(`
      INSERT INTO mbox.employee_sales_attribution_events (
        tenant_id, store_id, event_type, order_id, order_item_id, employee_id,
        rule_id, business_date, quantity_delta, sales_amount_delta_minor,
        cost_amount_delta_minor, currency, product_snapshot, attribution_snapshot,
        recorded_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, 'sale', $3::uuid, $4::uuid, $5::uuid,
        $6::uuid, $7::date, $8::numeric, $9::bigint,
        $10::bigint, $11, $12::jsonb, $13::jsonb, $14::uuid
      )
      ON CONFLICT DO NOTHING
      RETURNING ${ATTRIBUTION_COLUMNS}
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      source.order_id, source.order_item_id, employeeId, rule.id, source.business_date,
      quantityDelta, attributedSales, attributedCost, source.currency,
      JSON.stringify({ code: source.product_code, name: source.product_name, categoryCode: source.category_code }),
      JSON.stringify(snapshot), input.recordedByEmployeeId,
    ])
    if (inserted.rows[0]) return mapAttribution(inserted.rows[0])
    const concurrent = await this.transaction.query<AttributionRow>(`
      SELECT ${ATTRIBUTION_COLUMNS}
      FROM mbox.employee_sales_attribution_events
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND order_item_id = $3::uuid AND event_type = 'sale'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, source.order_item_id])
    if (concurrent.rows[0]?.employee_id === employeeId) return mapAttribution(concurrent.rows[0])
    throw new SalesAttributionNotAllowedError('Order item already belongs to another employee')
  }

  async reverseSalesForRefund(
    refundId: string,
    recordedByEmployeeId: string,
  ): Promise<EmployeeSalesAttributionEvent[]> {
    nonBlank(refundId, 'refundId')
    nonBlank(recordedByEmployeeId, 'recordedByEmployeeId')
    const refund = await this.transaction.query<{ id: string; status: string }>(`
      SELECT id, status FROM mbox.refunds
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    if (!refund.rows[0]) throw new CommercialRecordNotFoundError('Refund was not found')
    if (refund.rows[0].status !== 'succeeded') {
      throw new SalesAttributionNotAllowedError('Sales attribution can only reverse a succeeded refund')
    }
    const allocations = await this.transaction.query<RefundAllocationRow>(`
      SELECT $3::uuid AS refund_id,
        reconciliation.business_date::text,
        current_item.order_item_id,
        item.total_amount_minor::text AS item_total_minor,
        SUM(all_refund_item.amount_minor)::text AS cumulative_refund_minor
      FROM mbox.refund_items AS current_item
      JOIN mbox.order_items AS item
        ON item.tenant_id = current_item.tenant_id AND item.store_id = current_item.store_id
       AND item.id = current_item.order_item_id
      JOIN mbox.refunds AS all_refund
        ON all_refund.tenant_id = current_item.tenant_id AND all_refund.store_id = current_item.store_id
       AND all_refund.payment_id = (SELECT payment_id FROM mbox.refunds WHERE id = $3::uuid)
       AND all_refund.status = 'succeeded'
      JOIN mbox.refund_items AS all_refund_item
        ON all_refund_item.tenant_id = all_refund.tenant_id
       AND all_refund_item.store_id = all_refund.store_id
       AND all_refund_item.refund_id = all_refund.id
       AND all_refund_item.order_item_id = current_item.order_item_id
      JOIN LATERAL (
        SELECT entry.business_date
        FROM mbox.reconciliation_entries AS entry
        WHERE entry.tenant_id = current_item.tenant_id AND entry.store_id = current_item.store_id
          AND entry.refund_id = $3::uuid AND entry.entry_type = 'refund'
        ORDER BY entry.occurred_at, entry.id LIMIT 1
      ) AS reconciliation ON true
      WHERE current_item.tenant_id = $1::uuid AND current_item.store_id = $2::uuid
        AND current_item.refund_id = $3::uuid
      GROUP BY reconciliation.business_date, current_item.order_item_id, item.total_amount_minor
      ORDER BY current_item.order_item_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, refundId])
    if (!allocations.rowCount) {
      throw new CommercialIntegrityError('Refund has no item and reconciliation evidence')
    }
    const reversed: EmployeeSalesAttributionEvent[] = []
    for (const allocation of allocations.rows) {
      const saleRows = await this.transaction.query<AttributionRow>(`
        SELECT ${ATTRIBUTION_COLUMNS}
        FROM mbox.employee_sales_attribution_events
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND order_item_id = $3::uuid AND event_type = 'sale'
        ORDER BY employee_id, id
        FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, allocation.order_item_id])
      for (const sale of saleRows.rows) {
        const existing = await this.transaction.query<AttributionRow>(`
          SELECT ${ATTRIBUTION_COLUMNS}
          FROM mbox.employee_sales_attribution_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND source_sale_event_id = $3::uuid AND refund_id = $4::uuid
        `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, sale.id, refundId])
        if (existing.rows[0]) {
          reversed.push(mapAttribution(existing.rows[0]))
          continue
        }
        const prior = await this.transaction.query<{
          reversed_sales: string | number
          reversed_cost: string | number | null
          reversed_quantity: string | number
        }>(`
          SELECT
            COALESCE(-SUM(sales_amount_delta_minor), 0)::text AS reversed_sales,
            CASE WHEN bool_or(cost_amount_delta_minor IS NULL) THEN NULL
              ELSE COALESCE(-SUM(cost_amount_delta_minor), 0)::text END AS reversed_cost,
            COALESCE(-SUM(quantity_delta), 0)::text AS reversed_quantity
          FROM mbox.employee_sales_attribution_events
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND source_sale_event_id = $3::uuid AND event_type = 'refund_reversal'
        `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, sale.id])
        const priorRow = required(prior.rows[0], 'Refund reversal totals were not returned')
        const itemTotal = safeMinor(allocation.item_total_minor, 'order item total')
        const cumulativeRefund = Math.min(safeMinor(allocation.cumulative_refund_minor, 'cumulative refund'), itemTotal)
        const originalSales = safeMinor(sale.sales_amount_delta_minor, 'attributed sales')
        const targetSales = prorate(originalSales, cumulativeRefund, itemTotal)
        const salesToReverse = targetSales - safeMinor(priorRow.reversed_sales, 'prior reversed sales')
        if (salesToReverse <= 0) continue
        const originalCost = nullableMinor(sale.cost_amount_delta_minor, 'attributed cost')
        const targetCost = originalCost === null ? null : prorate(originalCost, cumulativeRefund, itemTotal)
        const priorCost = nullableMinor(priorRow.reversed_cost, 'prior reversed cost')
        const costToReverse = targetCost === null || priorCost === null ? null : targetCost - priorCost
        const originalQuantity = Number(sale.quantity_delta)
        const targetQuantity = originalQuantity * cumulativeRefund / itemTotal
        const quantityToReverse = targetQuantity - Number(priorRow.reversed_quantity)
        const inserted = await this.transaction.query<AttributionRow>(`
          INSERT INTO mbox.employee_sales_attribution_events (
            tenant_id, store_id, event_type, order_id, order_item_id, employee_id,
            rule_id, source_sale_event_id, refund_id, business_date, quantity_delta,
            sales_amount_delta_minor, cost_amount_delta_minor, currency,
            product_snapshot, attribution_snapshot, recorded_by_employee_id
          ) VALUES (
            $1::uuid, $2::uuid, 'refund_reversal', $3::uuid, $4::uuid, $5::uuid,
            $6::uuid, $7::uuid, $8::uuid, $9::date, $10::numeric,
            $11::bigint, $12::bigint, $13, $14::jsonb, $15::jsonb, $16::uuid
          ) RETURNING ${ATTRIBUTION_COLUMNS}
        `, [
          this.transaction.scope.tenantId, this.transaction.scope.storeId,
          sale.order_id, sale.order_item_id, sale.employee_id, sale.rule_id,
          sale.id, refundId, allocation.business_date, (-quantityToReverse).toFixed(6),
          -salesToReverse, costToReverse === null ? null : -costToReverse, sale.currency,
          JSON.stringify(sale.product_snapshot),
          JSON.stringify({ ...sale.attribution_snapshot, reversalSource: 'succeeded_refund_reconciliation' }),
          recordedByEmployeeId,
        ])
        reversed.push(mapAttribution(required(inserted.rows[0], 'Refund reversal was not inserted')))
      }
    }
    return reversed
  }

  async redeemVoucher(input: Readonly<RedeemGroupVoucherInput>): Promise<GroupVoucherRedemption> {
    validateVoucher(input)
    if (input.reconciliationEntryId) await this.assertVoucherReconciliation(input)
    if (input.orderId || input.tableSessionId) await this.assertVoucherOwnership(input)
    const normalizedCode = normalizeVoucherCode(input.voucherCode)
    const codeHash = voucherCodeDigest(normalizedCode)
    try {
      const result = await this.transaction.query<VoucherRow>(`
        INSERT INTO mbox.group_voucher_redemptions (
          tenant_id, store_id, public_id, platform, campaign_name,
          voucher_code_hash, voucher_code_masked, face_value_minor,
          settlement_amount_minor, currency, order_id, table_session_id,
          reconciliation_entry_id, redeemed_by_employee_id,
          redeemed_business_date, redeemed_at
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10,
          $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::date,
          COALESCE($16::timestamptz, clock_timestamp())
        ) RETURNING ${VOUCHER_COLUMNS}
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        input.publicId, input.platform.trim(), input.campaignName.trim(), codeHash,
        maskVoucher(normalizedCode), input.faceValueMinor, input.settlementAmountMinor,
        input.currency, input.orderId ?? null, input.tableSessionId ?? null,
        input.reconciliationEntryId ?? null, input.redeemedByEmployeeId,
        input.redeemedBusinessDate, input.redeemedAt ?? null,
      ])
      return mapVoucher(required(result.rows[0], 'Voucher redemption was not inserted'))
    } catch (error) {
      if (isUniqueViolation(error)) throw new VoucherAlreadyRedeemedError('Voucher has already been redeemed')
      throw error
    }
  }

  private async insertCost(
    input: Readonly<WriteOperatingCostInput>,
    correctsCostEntryId: string | null,
    correctionReason: string | null,
  ): Promise<OperatingCostEntry> {
    const result = await this.transaction.query<CostRow>(`
      INSERT INTO mbox.operating_cost_entries AS cost (
        tenant_id, store_id, public_id, category, recognition_state,
        allocation_period, service_start_date, service_end_date, cash_paid_on,
        net_amount_minor, tax_amount_minor, currency, source_type,
        purchase_receipt_line_id, employee_id, schedule_id, source_reference,
        source_snapshot, corrects_cost_entry_id, correction_reason,
        recorded_business_date, recorded_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9::date,
        $10::bigint, $11::bigint, $12, $13, $14::uuid, $15::uuid, $16::uuid,
        $17, $18::jsonb, $19::uuid, $20, $21::date, $22::uuid
      ) RETURNING ${COST_COLUMNS}
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.publicId, input.category, input.recognitionState, input.allocationPeriod,
      input.serviceStartDate, input.serviceEndDate, input.cashPaidOn ?? null,
      input.netAmountMinor, input.taxAmountMinor ?? 0, input.currency, input.sourceType,
      input.purchaseReceiptLineId ?? null, input.employeeId ?? null, input.scheduleId ?? null,
      input.sourceReference?.trim() || null, JSON.stringify(input.sourceSnapshot ?? {}),
      correctsCostEntryId, correctionReason, input.recordedBusinessDate,
      input.recordedByEmployeeId,
    ])
    return mapCost(required(result.rows[0], 'Cost entry was not inserted'))
  }

  private async lockSaleSource(orderItemId: string): Promise<SaleSourceRow> {
    const result = await this.transaction.query<SaleSourceRow>(`
      SELECT order_row.id AS order_id, item.id AS order_item_id,
        order_row.table_session_id, session.table_id,
        order_row.created_by_employee_id AS order_created_by_employee_id,
        COALESCE(order_row.submitted_at, order_row.created_at)::text AS order_created_at,
        session.business_date::text, order_row.payment_status,
        order_row.status AS order_status, item.product_id, item.quantity,
        item.total_amount_minor::text, item.currency, product.code AS product_code,
        product.name AS product_name, product.category_code,
        item.total_cost_minor_at_submission::text, item.cost_source
      FROM mbox.order_items AS item
      JOIN mbox.orders AS order_row
        ON order_row.tenant_id = item.tenant_id AND order_row.store_id = item.store_id
       AND order_row.id = item.order_id
      JOIN mbox.table_sessions AS session
        ON session.tenant_id = order_row.tenant_id AND session.store_id = order_row.store_id
       AND session.id = order_row.table_session_id
      JOIN mbox.products AS product
        ON product.tenant_id = item.tenant_id AND product.store_id = item.store_id
       AND product.id = item.product_id
      WHERE item.tenant_id = $1::uuid AND item.store_id = $2::uuid AND item.id = $3::uuid
        AND item.parent_order_item_id IS NULL
      FOR UPDATE OF item, order_row
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, orderItemId])
    const row = result.rows[0]
    if (!row) throw new CommercialRecordNotFoundError('Order item was not found')
    return row
  }

  private async resolveAttributedEmployee(
    source: SaleSourceRow,
    rule: RuleRow,
    explicitEmployeeId?: string | null,
  ): Promise<string> {
    let employeeId: string | null = null
    if (rule.attribution_mode === 'explicit') employeeId = explicitEmployeeId?.trim() || null
    if (rule.attribution_mode === 'order_creator') employeeId = source.order_created_by_employee_id
    if (rule.attribution_mode === 'table_primary') {
      const assignment = await this.transaction.query<{ employee_id: string }>(`
        SELECT employee_id FROM mbox.table_assignments
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND table_id = $3::uuid
          AND assignment_type = 'primary' AND starts_at <= $4::timestamptz
          AND (ends_at IS NULL OR ends_at > $4::timestamptz)
        ORDER BY starts_at DESC, id LIMIT 1
      `, [
        this.transaction.scope.tenantId, this.transaction.scope.storeId,
        source.table_id, source.order_created_at,
      ])
      employeeId = assignment.rows[0]?.employee_id ?? null
    }
    if (!employeeId) throw new SalesAttributionNotAllowedError('Attribution rule did not resolve an employee')
    const active = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'active'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId])
    if (!active.rowCount) throw new SalesAttributionNotAllowedError('Attributed employee is not active')
    return employeeId
  }

  private async assertVoucherReconciliation(input: Readonly<RedeemGroupVoucherInput>): Promise<void> {
    const result = await this.transaction.query<{
      amount_minor: string | number
      currency: string
      business_date: string
      entry_type: string
    }>(`
      SELECT amount_minor::text, currency, business_date::text, entry_type
      FROM mbox.reconciliation_entries
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.reconciliationEntryId])
    const row = result.rows[0]
    if (!row) throw new CommercialRecordNotFoundError('Reconciliation entry was not found')
    if (!['payment', 'adjustment'].includes(row.entry_type)
      || safeMinor(row.amount_minor, 'reconciliation amount') !== input.settlementAmountMinor
      || row.currency !== input.currency
      || row.business_date !== input.redeemedBusinessDate) {
      throw new CommercialIntegrityError('Voucher settlement does not match reconciliation evidence')
    }
  }

  private async assertVoucherOwnership(input: Readonly<RedeemGroupVoucherInput>): Promise<void> {
    if (!input.orderId || !input.tableSessionId) {
      throw new CommercialIntegrityError('orderId and tableSessionId must be provided together')
    }
    const result = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.orders
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND table_session_id = $4::uuid AND status <> 'cancelled'
    `, [
      this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.orderId, input.tableSessionId,
    ])
    if (!result.rowCount) throw new CommercialIntegrityError('Voucher order does not belong to the table session')
  }
}

const COST_COLUMNS = `
  cost.id, cost.public_id, cost.category, cost.recognition_state,
  cost.allocation_period, cost.service_start_date::text, cost.service_end_date::text,
  cost.cash_paid_on::text, cost.net_amount_minor::text, cost.tax_amount_minor::text,
  cost.gross_amount_minor::text, cost.currency, cost.source_type,
  cost.purchase_receipt_line_id, cost.employee_id, cost.schedule_id,
  cost.source_reference, cost.source_snapshot, cost.corrects_cost_entry_id,
  cost.correction_reason, cost.recorded_business_date::text,
  cost.recorded_by_employee_id, cost.recorded_at::text
`
const RULE_COLUMNS = `
  id, product_id, attribution_mode, sales_credit_bps, cost_source,
  lower(effective_during)::text AS effective_from,
  upper(effective_during)::text AS effective_until,
  rule_snapshot, reason, configured_by_employee_id, created_at::text
`
const ATTRIBUTION_COLUMNS = `
  id, event_type, order_id, order_item_id, employee_id, rule_id,
  source_sale_event_id, refund_id, business_date::text, quantity_delta::text,
  sales_amount_delta_minor::text, cost_amount_delta_minor::text,
  currency, product_snapshot, attribution_snapshot,
  recorded_by_employee_id, occurred_at::text
`
const VOUCHER_COLUMNS = `
  id, public_id, platform, campaign_name, voucher_code_masked,
  face_value_minor::text, settlement_amount_minor::text, currency,
  order_id, table_session_id, reconciliation_entry_id,
  redeemed_by_employee_id, redeemed_business_date::text, redeemed_at::text
`

function mapCost(row: CostRow): OperatingCostEntry {
  return {
    id: row.id, publicId: row.public_id, category: row.category,
    recognitionState: row.recognition_state, allocationPeriod: row.allocation_period,
    serviceStartDate: row.service_start_date, serviceEndDate: row.service_end_date,
    cashPaidOn: row.cash_paid_on, netAmountMinor: safeMinor(row.net_amount_minor, 'net cost'),
    taxAmountMinor: safeMinor(row.tax_amount_minor, 'tax cost'),
    grossAmountMinor: safeMinor(row.gross_amount_minor, 'gross cost'), currency: row.currency,
    sourceType: row.source_type, purchaseReceiptLineId: row.purchase_receipt_line_id,
    employeeId: row.employee_id, scheduleId: row.schedule_id,
    sourceReference: row.source_reference, sourceSnapshot: row.source_snapshot,
    correctsCostEntryId: row.corrects_cost_entry_id, correctionReason: row.correction_reason,
    recordedBusinessDate: row.recorded_business_date,
    recordedByEmployeeId: row.recorded_by_employee_id, recordedAt: row.recorded_at,
  }
}

function mapRule(row: RuleRow): EmployeeSalesRule {
  return {
    id: row.id, productId: row.product_id, attributionMode: row.attribution_mode,
    salesCreditBps: row.sales_credit_bps, costSource: row.cost_source,
    effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
    ruleSnapshot: row.rule_snapshot, reason: row.reason,
    configuredByEmployeeId: row.configured_by_employee_id, createdAt: row.created_at,
  }
}

function mapAttribution(row: AttributionRow): EmployeeSalesAttributionEvent {
  return {
    id: row.id, eventType: row.event_type, orderId: row.order_id,
    orderItemId: row.order_item_id, employeeId: row.employee_id, ruleId: row.rule_id,
    sourceSaleEventId: row.source_sale_event_id, refundId: row.refund_id,
    businessDate: row.business_date, quantityDelta: row.quantity_delta,
    salesAmountDeltaMinor: safeSignedMinor(row.sales_amount_delta_minor, 'sales amount'),
    costAmountDeltaMinor: nullableSignedMinor(row.cost_amount_delta_minor, 'cost amount'),
    currency: row.currency, productSnapshot: row.product_snapshot,
    attributionSnapshot: row.attribution_snapshot,
    recordedByEmployeeId: row.recorded_by_employee_id, occurredAt: row.occurred_at,
  }
}

function mapVoucher(row: VoucherRow): GroupVoucherRedemption {
  return {
    id: row.id, publicId: row.public_id, platform: row.platform,
    campaignName: row.campaign_name, voucherCodeMasked: row.voucher_code_masked,
    faceValueMinor: safeMinor(row.face_value_minor, 'voucher face value'),
    settlementAmountMinor: safeMinor(row.settlement_amount_minor, 'voucher settlement'),
    currency: row.currency, orderId: row.order_id, tableSessionId: row.table_session_id,
    reconciliationEntryId: row.reconciliation_entry_id,
    redeemedByEmployeeId: row.redeemed_by_employee_id,
    redeemedBusinessDate: row.redeemed_business_date, redeemedAt: row.redeemed_at,
  }
}

function validateCost(input: Readonly<WriteOperatingCostInput>): void {
  nonBlank(input.publicId, 'publicId')
  nonBlank(input.recordedByEmployeeId, 'recordedByEmployeeId')
  validateDate(input.serviceStartDate, 'serviceStartDate')
  validateDate(input.serviceEndDate, 'serviceEndDate')
  validateDate(input.recordedBusinessDate, 'recordedBusinessDate')
  if (input.cashPaidOn) validateDate(input.cashPaidOn, 'cashPaidOn')
  if (input.serviceEndDate < input.serviceStartDate) throw new TypeError('service period is invalid')
  safeMinor(input.netAmountMinor, 'netAmountMinor')
  safeMinor(input.taxAmountMinor ?? 0, 'taxAmountMinor')
  validateCurrency(input.currency)
}

function validateSalesRule(input: Readonly<CreateEmployeeSalesRuleInput>): void {
  nonBlank(input.productId, 'productId')
  nonBlank(input.configuredByEmployeeId, 'configuredByEmployeeId')
  nonBlank(input.reason, 'reason')
  if (!Number.isSafeInteger(input.salesCreditBps) || input.salesCreditBps < 0 || input.salesCreditBps > 10_000) {
    throw new TypeError('salesCreditBps must be an integer between 0 and 10000')
  }
  if (input.attributionMode === 'disabled' && input.salesCreditBps !== 0) {
    throw new TypeError('disabled sales rule must have zero credit')
  }
  if (!(Date.parse(input.effectiveUntil) > Date.parse(input.effectiveFrom))) {
    throw new TypeError('sales rule effective period is invalid')
  }
}

function validateVoucher(input: Readonly<RedeemGroupVoucherInput>): void {
  nonBlank(input.publicId, 'publicId')
  nonBlank(input.platform, 'platform')
  nonBlank(input.campaignName, 'campaignName')
  if (input.voucherCode.trim().length < 4 || input.voucherCode.trim().length > 256) {
    throw new TypeError('voucherCode must contain between 4 and 256 characters')
  }
  safeMinor(input.faceValueMinor, 'faceValueMinor')
  safeMinor(input.settlementAmountMinor, 'settlementAmountMinor')
  validateCurrency(input.currency)
  validateDate(input.redeemedBusinessDate, 'redeemedBusinessDate')
  nonBlank(input.redeemedByEmployeeId, 'redeemedByEmployeeId')
}

function requireFrozenOrderItemCost(source: SaleSourceRow): number {
  if (source.cost_source !== 'catalog_product' && source.cost_source !== 'legacy_snapshot') {
    throw new SalesAttributionNotAllowedError('Order item has no authoritative frozen contribution cost')
  }
  if (source.total_cost_minor_at_submission === null) {
    throw new SalesAttributionNotAllowedError('Order item frozen contribution cost is unavailable')
  }
  return safeMinor(source.total_cost_minor_at_submission, 'order item frozen cost')
}

function safeMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError(`${label} is not a non-negative safe integer`)
  return parsed
}

function safeSignedMinor(value: string | number, label: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} is not a safe integer`)
  return parsed
}

function nullableMinor(value: string | number | null, label: string): number | null {
  return value === null ? null : safeMinor(value, label)
}

function nullableSignedMinor(value: string | number | null, label: string): number | null {
  return value === null ? null : safeSignedMinor(value, label)
}

function prorate(total: number, numerator: number, denominator: number): number {
  if (denominator <= 0) throw new CommercialIntegrityError('Proration denominator must be positive')
  return Math.round(total * numerator / denominator)
}

function decimalProduct(quantity: number, numerator: number, denominator: number): string {
  return (quantity * numerator / denominator).toFixed(6)
}

function maskVoucher(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= 4) return `${normalized[0] ?? '*'}**${normalized.at(-1) ?? '*'}`
  return `${normalized.slice(0, 2)}${'*'.repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-2)}`
}

export function voucherCodeDigest(value: string): string {
  return createHash('sha256').update(normalizeVoucherCode(value), 'utf8').digest('hex')
}

function normalizeVoucherCode(value: string): string {
  return value.trim().toUpperCase()
}

function validateDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TypeError(`${label} must use YYYY-MM-DD`)
  }
}

function validateCurrency(value: string): void {
  if (!/^[A-Z]{3}$/.test(value)) throw new TypeError('currency must be a three-letter uppercase code')
}

function nonBlank(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be blank`)
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message)
  return value
}

function hasPostgresCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isUniqueViolation(error: unknown): boolean {
  return hasPostgresCode(error, '23505')
}
