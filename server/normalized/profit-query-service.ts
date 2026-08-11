import type { StoreScope, ScopedPostgresTransactionRunner } from './transaction-runner.js'

export type ProfitPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface ProfitPeriodRange {
  startDate: string
  endDate: string
}

export interface ProfitReport {
  period: ProfitPeriod
  range: ProfitPeriodRange
  currency: string
  asOf: string
  status: 'complete' | 'provisional'
  revenue: {
    cash: {
      paymentReceiptsMinor: number
      refundsMinor: number
      adjustmentsMinor: number
      providerFeesMinor: number
      netReceiptsMinor: number
    }
    accrual: {
      reconciledRevenueMinor: number
    }
  }
  costs: {
    cashPaidMinor: number
    accrualAllocatedMinor: number
    taxIncludedMinor: number
  }
  profit: {
    cashBasisMinor: number
    accrualBasisMinor: number
  }
  gaps: {
    unreconciledCapturedPaymentsMinor: number
    unsettledVoucherSettlementMinor: number
    unactualizedAccrualMinor: number
    costsMissingCashDateMinor: number
    unknownUnrecordedCostsMeasurable: false
  }
  caveats: string[]
}

export interface EmployeeSalesQuery {
  startDate: string
  endDate: string
  employeeIds?: readonly string[]
  productId?: string
}

export interface EmployeeSalesRow {
  employeeId: string
  employeeCode: string
  employeeDisplayName: string
  productId: string
  productCode: string
  productName: string
  categoryCode: string
  quantity: string
  salesAmountMinor: number
  costAmountMinor: number | null
  contributionProfitMinor: number | null
  refundReversalAmountMinor: number
  costCoverageComplete: boolean
  currency: string
}

export interface CostSummaryRow {
  id: string
  publicId: string
  category: string
  recognitionState: string
  allocationPeriod: string
  serviceStartDate: string
  serviceEndDate: string
  cashPaidOn: string | null
  netAmountMinor: number
  taxAmountMinor: number
  grossAmountMinor: number
  currency: string
  sourceType: string
  correctsCostEntryId: string | null
  correctionReason: string | null
  recordedBusinessDate: string
  recordedAt: string
}

export interface VoucherSummaryRow {
  id: string
  publicId: string
  platform: string
  campaignName: string
  voucherCodeMasked: string
  faceValueMinor: number
  settlementAmountMinor: number
  currency: string
  isSettled: boolean
  redeemedBusinessDate: string
  redeemedAt: string
}

interface RevenueRow extends Record<string, unknown> {
  payment_minor: string | number
  refund_minor: string | number
  adjustment_minor: string | number
  fee_minor: string | number
  net_minor: string | number
}

interface CostAggregateRow extends Record<string, unknown> {
  cash_cost_minor: string | number
  accrual_cost_minor: string | number
  allocated_tax_minor: string | number
  unactualized_accrual_minor: string | number
  missing_cash_date_minor: string | number
}

interface GapRow extends Record<string, unknown> {
  unreconciled_payments_minor: string | number
  unsettled_vouchers_minor: string | number
}

interface EmployeeSalesDbRow extends Record<string, unknown> {
  employee_id: string
  employee_code: string
  display_name: string
  product_id: string
  product_code: string
  product_name: string
  category_code: string
  quantity: string
  sales_amount_minor: string | number
  cost_amount_minor: string | number | null
  contribution_profit_minor: string | number | null
  refund_reversal_amount_minor: string | number
  cost_coverage_complete: boolean
  currency: string
}

interface CostSummaryDbRow extends Record<string, unknown> {
  id: string
  public_id: string
  category: string
  recognition_state: string
  allocation_period: string
  service_start_date: string
  service_end_date: string
  cash_paid_on: string | null
  net_amount_minor: string | number
  tax_amount_minor: string | number
  gross_amount_minor: string | number
  currency: string
  source_type: string
  corrects_cost_entry_id: string | null
  correction_reason: string | null
  recorded_business_date: string
  recorded_at: string
}

interface VoucherSummaryDbRow extends Record<string, unknown> {
  id: string
  public_id: string
  platform: string
  campaign_name: string
  voucher_code_masked: string
  face_value_minor: string | number
  settlement_amount_minor: string | number
  currency: string
  is_settled: boolean
  redeemed_business_date: string
  redeemed_at: string
}

export class ProfitQueryService {
  constructor(private readonly transactions: ScopedPostgresTransactionRunner) {}

  async getProfitReport(
    scope: Readonly<StoreScope>,
    period: ProfitPeriod,
    anchorDate: string,
  ): Promise<ProfitReport> {
    const range = profitPeriodRange(period, anchorDate)
    return this.transactions.run(scope, async (transaction) => {
      const store = await transaction.query<{ currency: string }>(`
        SELECT currency FROM mbox.stores
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      `, [scope.tenantId, scope.storeId])
      const currency = store.rows[0]?.currency
      if (!currency) throw new Error('Store currency was not found')

      const cashRevenue = await transaction.query<RevenueRow>(`
        SELECT
          COALESCE(SUM(amount_minor) FILTER (WHERE entry_type = 'payment'), 0)::text AS payment_minor,
          COALESCE(SUM(amount_minor) FILTER (WHERE entry_type = 'refund'), 0)::text AS refund_minor,
          COALESCE(SUM(amount_minor) FILTER (WHERE entry_type = 'adjustment'), 0)::text AS adjustment_minor,
          COALESCE(SUM(amount_minor) FILTER (WHERE entry_type = 'fee'), 0)::text AS fee_minor,
          COALESCE(SUM(amount_minor), 0)::text AS net_minor
        FROM mbox.reconciliation_entries
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND business_date BETWEEN $3::date AND $4::date
          AND currency = $5
      `, [scope.tenantId, scope.storeId, range.startDate, range.endDate, currency])

      const accrualRevenue = await transaction.query<{ net_minor: string | number }>(`
        SELECT COALESCE(SUM(entry.amount_minor), 0)::text AS net_minor
        FROM mbox.reconciliation_entries AS entry
        JOIN mbox.payments AS payment
          ON payment.tenant_id = entry.tenant_id AND payment.store_id = entry.store_id
         AND payment.id = entry.payment_id
        JOIN mbox.orders AS order_row
          ON order_row.tenant_id = payment.tenant_id AND order_row.store_id = payment.store_id
         AND order_row.id = payment.order_id
        JOIN mbox.table_sessions AS session
          ON session.tenant_id = order_row.tenant_id AND session.store_id = order_row.store_id
         AND session.id = order_row.table_session_id
        WHERE entry.tenant_id = $1::uuid AND entry.store_id = $2::uuid
          AND session.business_date BETWEEN $3::date AND $4::date
          AND entry.currency = $5
      `, [scope.tenantId, scope.storeId, range.startDate, range.endDate, currency])

      const costs = await transaction.query<CostAggregateRow>(`
        WITH active_costs AS (
          SELECT cost.*
          FROM mbox.operating_cost_entries AS cost
          WHERE cost.tenant_id = $1::uuid AND cost.store_id = $2::uuid
            AND cost.currency = $5
            AND NOT EXISTS (
              SELECT 1 FROM mbox.operating_cost_entries AS correction
              WHERE correction.tenant_id = cost.tenant_id AND correction.store_id = cost.store_id
                AND correction.corrects_cost_entry_id = cost.id
            )
        ), allocated_days AS (
          SELECT cost.id, cost.recognition_state, day::date AS allocated_date,
            (cost.gross_amount_minor / day_count)
              + CASE WHEN day_number <= (cost.gross_amount_minor % day_count) THEN 1 ELSE 0 END
                AS allocated_gross_minor,
            (cost.tax_amount_minor / day_count)
              + CASE WHEN day_number <= (cost.tax_amount_minor % day_count) THEN 1 ELSE 0 END
                AS allocated_tax_minor
          FROM active_costs AS cost
          CROSS JOIN LATERAL (
            SELECT generated.day, generated.day_number,
              (cost.service_end_date - cost.service_start_date + 1)::bigint AS day_count
            FROM (
              SELECT day, row_number() OVER (ORDER BY day)::bigint AS day_number
              FROM generate_series(
                cost.service_start_date::timestamp,
                cost.service_end_date::timestamp,
                interval '1 day'
              ) AS day
            ) AS generated
          ) AS allocation
        )
        SELECT
          COALESCE((SELECT SUM(gross_amount_minor) FROM active_costs
            WHERE cash_paid_on BETWEEN $3::date AND $4::date), 0)::text AS cash_cost_minor,
          COALESCE(SUM(allocated_gross_minor) FILTER (
            WHERE allocated_date BETWEEN $3::date AND $4::date
          ), 0)::text AS accrual_cost_minor,
          COALESCE(SUM(allocated_tax_minor) FILTER (
            WHERE allocated_date BETWEEN $3::date AND $4::date
          ), 0)::text AS allocated_tax_minor,
          COALESCE(SUM(allocated_gross_minor) FILTER (
            WHERE allocated_date BETWEEN $3::date AND $4::date AND recognition_state = 'accrual'
          ), 0)::text AS unactualized_accrual_minor,
          COALESCE((SELECT SUM(gross_amount_minor) FROM active_costs
            WHERE cash_paid_on IS NULL AND recognition_state IN ('known', 'actual')
              AND service_start_date <= $4::date AND service_end_date >= $3::date), 0)::text
            AS missing_cash_date_minor
        FROM allocated_days
      `, [scope.tenantId, scope.storeId, range.startDate, range.endDate, currency])

      const gaps = await transaction.query<GapRow>(`
        SELECT
          COALESCE((
            SELECT SUM(payment.amount_minor)
            FROM mbox.payments AS payment
            JOIN mbox.orders AS order_row
              ON order_row.tenant_id = payment.tenant_id AND order_row.store_id = payment.store_id
             AND order_row.id = payment.order_id
            JOIN mbox.table_sessions AS session
              ON session.tenant_id = order_row.tenant_id AND session.store_id = order_row.store_id
             AND session.id = order_row.table_session_id
            WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
              AND payment.status IN ('succeeded', 'partially_refunded', 'refunded')
              AND payment.currency = $5
              AND session.business_date BETWEEN $3::date AND $4::date
              AND NOT EXISTS (
                SELECT 1 FROM mbox.reconciliation_entries AS entry
                WHERE entry.tenant_id = payment.tenant_id AND entry.store_id = payment.store_id
                  AND entry.payment_id = payment.id AND entry.entry_type = 'payment'
              )
          ), 0)::text AS unreconciled_payments_minor,
          COALESCE((
            SELECT SUM(voucher.settlement_amount_minor)
            FROM mbox.group_voucher_redemptions AS voucher
            WHERE voucher.tenant_id = $1::uuid AND voucher.store_id = $2::uuid
              AND voucher.currency = $5
              AND voucher.redeemed_business_date BETWEEN $3::date AND $4::date
              AND voucher.reconciliation_entry_id IS NULL
          ), 0)::text AS unsettled_vouchers_minor
      `, [scope.tenantId, scope.storeId, range.startDate, range.endDate, currency])

      const cash = required(cashRevenue.rows[0])
      const cost = required(costs.rows[0])
      const gap = required(gaps.rows[0])
      const paymentReceiptsMinor = minor(cash.payment_minor)
      const refundsMinor = minor(cash.refund_minor)
      const adjustmentsMinor = minor(cash.adjustment_minor)
      const providerFeesMinor = minor(cash.fee_minor)
      const netReceiptsMinor = minor(cash.net_minor)
      const reconciledRevenueMinor = minor(required(accrualRevenue.rows[0]).net_minor)
      const cashPaidMinor = minor(cost.cash_cost_minor)
      const accrualAllocatedMinor = minor(cost.accrual_cost_minor)
      const reportGaps = {
        unreconciledCapturedPaymentsMinor: minor(gap.unreconciled_payments_minor),
        unsettledVoucherSettlementMinor: minor(gap.unsettled_vouchers_minor),
        unactualizedAccrualMinor: minor(cost.unactualized_accrual_minor),
        costsMissingCashDateMinor: minor(cost.missing_cash_date_minor),
        unknownUnrecordedCostsMeasurable: false as const,
      }
      const hasKnownGap = Object.values(reportGaps).some((value) => typeof value === 'number' && value !== 0)
      return {
        period, range, currency, asOf: new Date().toISOString(),
        status: hasKnownGap ? 'provisional' : 'complete',
        revenue: {
          cash: { paymentReceiptsMinor, refundsMinor, adjustmentsMinor, providerFeesMinor, netReceiptsMinor },
          accrual: { reconciledRevenueMinor },
        },
        costs: {
          cashPaidMinor, accrualAllocatedMinor,
          taxIncludedMinor: minor(cost.allocated_tax_minor),
        },
        profit: {
          cashBasisMinor: netReceiptsMinor - cashPaidMinor,
          accrualBasisMinor: reconciledRevenueMinor - accrualAllocatedMinor,
        },
        gaps: reportGaps,
        caveats: [
          '收入只采用已写入对账流水的支付、退款、费用和调整。',
          '现金口径按对账营业日和成本付款日计算；权责口径按订单营业日及成本服务期逐日分摊。',
          '尚未录入系统的未知成本无法被量化，报告不能替代月末财务关账。',
        ],
      }
    }, { isolation: 'repeatable-read', readOnly: true })
  }

  async listEmployeeSales(
    scope: Readonly<StoreScope>,
    query: Readonly<EmployeeSalesQuery>,
  ): Promise<EmployeeSalesRow[]> {
    validateRange(query.startDate, query.endDate)
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<EmployeeSalesDbRow>(`
        SELECT event.employee_id, employee.employee_code, employee.display_name,
          item.product_id,
          MIN(event.product_snapshot->>'code') AS product_code,
          MIN(event.product_snapshot->>'name') AS product_name,
          MIN(event.product_snapshot->>'categoryCode') AS category_code,
          SUM(event.quantity_delta)::text AS quantity,
          SUM(event.sales_amount_delta_minor)::text AS sales_amount_minor,
          CASE WHEN bool_or(event.cost_amount_delta_minor IS NULL) THEN NULL
            ELSE SUM(event.cost_amount_delta_minor)::text END AS cost_amount_minor,
          CASE WHEN bool_or(event.cost_amount_delta_minor IS NULL) THEN NULL
            ELSE (SUM(event.sales_amount_delta_minor) - SUM(event.cost_amount_delta_minor))::text
          END AS contribution_profit_minor,
          COALESCE(-SUM(event.sales_amount_delta_minor) FILTER (
            WHERE event.event_type = 'refund_reversal'
          ), 0)::text AS refund_reversal_amount_minor,
          NOT bool_or(event.cost_amount_delta_minor IS NULL) AS cost_coverage_complete,
          MIN(event.currency) AS currency
        FROM mbox.employee_sales_attribution_events AS event
        JOIN mbox.employees AS employee
          ON employee.tenant_id = event.tenant_id AND employee.store_id = event.store_id
         AND employee.id = event.employee_id
        JOIN mbox.order_items AS item
          ON item.tenant_id = event.tenant_id AND item.store_id = event.store_id
         AND item.id = event.order_item_id
        WHERE event.tenant_id = $1::uuid AND event.store_id = $2::uuid
          AND event.business_date BETWEEN $3::date AND $4::date
          AND ($5::uuid[] IS NULL OR event.employee_id = ANY($5::uuid[]))
          AND ($6::uuid IS NULL OR item.product_id = $6::uuid)
        GROUP BY event.employee_id, employee.employee_code, employee.display_name, item.product_id
        ORDER BY SUM(event.sales_amount_delta_minor) DESC, employee.display_name, product_name
      `, [
        scope.tenantId, scope.storeId, query.startDate, query.endDate,
        query.employeeIds?.length ? [...query.employeeIds] : null, query.productId ?? null,
      ])
      return result.rows.map(mapEmployeeSales)
    }, { isolation: 'repeatable-read', readOnly: true })
  }

  async listCosts(
    scope: Readonly<StoreScope>,
    startDate: string,
    endDate: string,
  ): Promise<CostSummaryRow[]> {
    validateRange(startDate, endDate)
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<CostSummaryDbRow>(`
        SELECT cost.id, cost.public_id, cost.category, cost.recognition_state,
          cost.allocation_period, cost.service_start_date::text, cost.service_end_date::text,
          cost.cash_paid_on::text, cost.net_amount_minor::text, cost.tax_amount_minor::text,
          cost.gross_amount_minor::text, cost.currency, cost.source_type,
          cost.corrects_cost_entry_id, cost.correction_reason,
          cost.recorded_business_date::text, cost.recorded_at::text
        FROM mbox.operating_cost_entries AS cost
        WHERE cost.tenant_id = $1::uuid AND cost.store_id = $2::uuid
          AND cost.service_start_date <= $4::date AND cost.service_end_date >= $3::date
        ORDER BY cost.service_start_date DESC, cost.recorded_at DESC, cost.id
      `, [scope.tenantId, scope.storeId, startDate, endDate])
      return result.rows.map(mapCostSummary)
    }, { readOnly: true })
  }

  async listVouchers(
    scope: Readonly<StoreScope>,
    startDate: string,
    endDate: string,
  ): Promise<VoucherSummaryRow[]> {
    validateRange(startDate, endDate)
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<VoucherSummaryDbRow>(`
        SELECT id, public_id, platform, campaign_name, voucher_code_masked,
          face_value_minor::text, settlement_amount_minor::text, currency,
          reconciliation_entry_id IS NOT NULL AS is_settled,
          redeemed_business_date::text, redeemed_at::text
        FROM mbox.group_voucher_redemptions
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND redeemed_business_date BETWEEN $3::date AND $4::date
        ORDER BY redeemed_at DESC, id DESC
      `, [scope.tenantId, scope.storeId, startDate, endDate])
      return result.rows.map((row) => ({
        id: row.id, publicId: row.public_id, platform: row.platform,
        campaignName: row.campaign_name, voucherCodeMasked: row.voucher_code_masked,
        faceValueMinor: minor(row.face_value_minor),
        settlementAmountMinor: minor(row.settlement_amount_minor), currency: row.currency,
        isSettled: row.is_settled, redeemedBusinessDate: row.redeemed_business_date,
        redeemedAt: row.redeemed_at,
      }))
    }, { readOnly: true })
  }
}

export function profitPeriodRange(period: ProfitPeriod, anchorDate: string): ProfitPeriodRange {
  validateDate(anchorDate, 'anchorDate')
  const anchor = parseUtcDate(anchorDate)
  if (period === 'day') return { startDate: anchorDate, endDate: anchorDate }
  if (period === 'week') {
    const weekday = anchor.getUTCDay() || 7
    return { startDate: addDays(anchor, 1 - weekday), endDate: addDays(anchor, 7 - weekday) }
  }
  if (period === 'month') {
    return {
      startDate: formatDate(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))),
      endDate: formatDate(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0))),
    }
  }
  if (period === 'quarter') {
    const startMonth = Math.floor(anchor.getUTCMonth() / 3) * 3
    return {
      startDate: formatDate(new Date(Date.UTC(anchor.getUTCFullYear(), startMonth, 1))),
      endDate: formatDate(new Date(Date.UTC(anchor.getUTCFullYear(), startMonth + 3, 0))),
    }
  }
  return {
    startDate: `${anchor.getUTCFullYear()}-01-01`,
    endDate: `${anchor.getUTCFullYear()}-12-31`,
  }
}

function mapEmployeeSales(row: EmployeeSalesDbRow): EmployeeSalesRow {
  return {
    employeeId: row.employee_id, employeeCode: row.employee_code,
    employeeDisplayName: row.display_name, productId: row.product_id,
    productCode: row.product_code, productName: row.product_name,
    categoryCode: row.category_code, quantity: row.quantity,
    salesAmountMinor: minor(row.sales_amount_minor),
    costAmountMinor: nullableMinor(row.cost_amount_minor),
    contributionProfitMinor: nullableMinor(row.contribution_profit_minor),
    refundReversalAmountMinor: minor(row.refund_reversal_amount_minor),
    costCoverageComplete: row.cost_coverage_complete, currency: row.currency,
  }
}

function mapCostSummary(row: CostSummaryDbRow): CostSummaryRow {
  return {
    id: row.id, publicId: row.public_id, category: row.category,
    recognitionState: row.recognition_state, allocationPeriod: row.allocation_period,
    serviceStartDate: row.service_start_date, serviceEndDate: row.service_end_date,
    cashPaidOn: row.cash_paid_on, netAmountMinor: minor(row.net_amount_minor),
    taxAmountMinor: minor(row.tax_amount_minor), grossAmountMinor: minor(row.gross_amount_minor),
    currency: row.currency, sourceType: row.source_type,
    correctsCostEntryId: row.corrects_cost_entry_id, correctionReason: row.correction_reason,
    recordedBusinessDate: row.recorded_business_date, recordedAt: row.recorded_at,
  }
}

function validateRange(startDate: string, endDate: string): void {
  validateDate(startDate, 'startDate')
  validateDate(endDate, 'endDate')
  if (endDate < startDate) throw new TypeError('date range is invalid')
}

function validateDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TypeError(`${label} must use YYYY-MM-DD`)
  }
}

function parseUtcDate(value: string): Date { return new Date(`${value}T00:00:00Z`) }
function formatDate(value: Date): string { return value.toISOString().slice(0, 10) }
function addDays(value: Date, days: number): string {
  const result = new Date(value)
  result.setUTCDate(result.getUTCDate() + days)
  return formatDate(result)
}

function minor(value: string | number): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(parsed)) throw new RangeError('Amount exceeds safe integer range')
  return parsed
}

function nullableMinor(value: string | number | null): number | null {
  return value === null ? null : minor(value)
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error('Expected database aggregate row')
  return value
}
