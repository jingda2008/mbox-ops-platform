export interface OperatingDashboardMetric {
  incomeMinor: number
  totalCostMinor: number
  operatingProfitMinor: number
  actualReceiptsMinor: number
  successfulRefundsMinor: number
  actualNetReceiptsMinor: number
  periodOutstandingMinor: number
  currentAllOutstandingMinor: number
  validOrderCount: number
  paidOrderCount: number
}

export interface OperatingDashboardTrend {
  businessDate: string
  label: string
  incomeMinor: number
  costMinor: number
  actualNetReceiptsMinor: number
  provisional: boolean
}

export interface OperatingDashboardBreakdown {
  code: string
  label: string
  amountMinor: number
  count: number
  missingCount: number
}

export interface OperatingDashboardSource {
  id: string
  kind: 'income' | 'cost' | 'receipt' | 'refund' | 'outstanding'
  category: string
  sourceType: string
  publicId: string
  label: string
  businessDate: string | null
  occurredAt: string
  amountMinor: number | null
  originalAmountMinor?: number
  missingCount: number
}

/** No customer contact, employee payroll identity or raw provider payload. */
export interface OperatingDashboardProjection {
  printAccess?: { allowed: boolean; reason: string | null }
  dashboard: OperatingDashboardMetric
  trend: OperatingDashboardTrend[]
  incomeBreakdown: OperatingDashboardBreakdown[]
  costBreakdown: OperatingDashboardBreakdown[]
  coverage: string[]
  currentBusinessDate: string
  effectiveEndDate: string
  requestedEndDate: string
  incomeBasis: 'purchase_business_date'
  knownMissingCostCount: number
  unassignedIncomeCount: number
  unreconciledActivityPaymentsMinor: number
  sources: { rows: OperatingDashboardSource[]; page: number; pageSize: number; total: number; hasMore: boolean }
}

export interface OperatingDashboardSourceQuery {
  kind?: OperatingDashboardSource['kind']
  category?: string
  page?: number
  /** Server authorization only; never read from HTTP query input. */
  includeCostDetails?: boolean
}
