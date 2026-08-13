import type { SubmitOrderLineInput } from './order-repository.js'
import { TableSessionUnavailableForOrderError } from './order-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export interface GuestOrderSafetyPolicy {
  duplicateWindowSeconds: number
  maxOrdersPerCustomerPerMinute: number
  maxOrdersPerTablePerMinute: number
}

export const defaultGuestOrderSafetyPolicy: Readonly<GuestOrderSafetyPolicy> = {
  duplicateWindowSeconds: 45,
  maxOrdersPerCustomerPerMinute: 5,
  maxOrdersPerTablePerMinute: 20,
}

export class GuestOrderRateLimitedError extends Error {
  constructor(
    readonly dimension: 'customer' | 'table',
    readonly retryAt: string,
  ) {
    super(dimension === 'customer'
      ? '操作有点快，请稍等片刻再继续下单'
      : '本桌正在集中下单，请稍等片刻再继续')
    this.name = 'GuestOrderRateLimitedError'
  }
}

export class GuestOrderDuplicateConfirmationRequiredError extends Error {
  constructor(
    readonly conflictingOrderPublicId: string,
    readonly conflictingOrderCreatedAt: string,
  ) {
    super('本桌刚提交过相同商品，请确认这是继续加单而不是重复操作')
    this.name = 'GuestOrderDuplicateConfirmationRequiredError'
  }
}

interface GuestOrderSafetyInput {
  tableSessionId: string
  customerId: string
  lines: readonly SubmitOrderLineInput[]
  confirmedDuplicateOrderPublicId?: string | null
}

interface RateWindowRow extends Record<string, unknown> {
  customer_count: string | number
  table_count: string | number
  customer_retry_at: string | null
  table_retry_at: string | null
}

interface DuplicateOrderRow extends Record<string, unknown> {
  public_id: string
  created_at: string
}

export class GuestOrderSafetyRepository {
  constructor(
    private readonly transaction: ScopedTransaction,
    private readonly policy: Readonly<GuestOrderSafetyPolicy> = defaultGuestOrderSafetyPolicy,
  ) {}

  async assertAllowed(input: Readonly<GuestOrderSafetyInput>): Promise<void> {
    validatePolicy(this.policy)
    await this.lockOpenTableSession(input.tableSessionId)
    await this.assertWithinRateLimits(input)
    await this.assertDuplicateConfirmed(input)
  }

  private async lockOpenTableSession(tableSessionId: string): Promise<void> {
    const locked = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status = 'open'
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableSessionId])
    if (locked.rowCount !== 1) throw new TableSessionUnavailableForOrderError(tableSessionId)
  }

  private async assertWithinRateLimits(input: Readonly<GuestOrderSafetyInput>): Promise<void> {
    const result = await this.transaction.query<RateWindowRow>(`
      SELECT
        count(*) FILTER (WHERE created_by_customer_id = $4::uuid) AS customer_count,
        count(*) AS table_count,
        (min(created_at) FILTER (WHERE created_by_customer_id = $4::uuid) + interval '1 minute')::text
          AS customer_retry_at,
        (min(created_at) + interval '1 minute')::text AS table_retry_at
      FROM mbox.orders
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_session_id = $3::uuid
        AND channel = 'guest_qr'
        AND status <> 'cancelled'
        AND created_at >= clock_timestamp() - interval '1 minute'
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.customerId,
    ])
    const row = result.rows[0]
    const customerCount = Number(row?.customer_count ?? 0)
    const tableCount = Number(row?.table_count ?? 0)
    if (customerCount >= this.policy.maxOrdersPerCustomerPerMinute) {
      throw new GuestOrderRateLimitedError('customer', requiredRetryAt(row?.customer_retry_at))
    }
    if (tableCount >= this.policy.maxOrdersPerTablePerMinute) {
      throw new GuestOrderRateLimitedError('table', requiredRetryAt(row?.table_retry_at))
    }
  }

  private async assertDuplicateConfirmed(input: Readonly<GuestOrderSafetyInput>): Promise<void> {
    const result = await this.transaction.query<DuplicateOrderRow>(`
      SELECT ordering.public_id, ordering.created_at::text
      FROM mbox.orders AS ordering
      WHERE ordering.tenant_id = $1::uuid
        AND ordering.store_id = $2::uuid
        AND ordering.table_session_id = $3::uuid
        AND ordering.channel = 'guest_qr'
        AND ordering.status <> 'cancelled'
        AND ordering.created_at >= clock_timestamp() - ($4::integer * interval '1 second')
        AND (
          SELECT jsonb_object_agg(summary.product_id::text, summary.quantity)
          FROM (
            SELECT item.product_id, sum(item.quantity)::integer AS quantity
            FROM mbox.order_items AS item
            WHERE item.tenant_id = ordering.tenant_id
              AND item.store_id = ordering.store_id
              AND item.order_id = ordering.id
              AND item.parent_order_item_id IS NULL
              AND item.status <> 'cancelled'
            GROUP BY item.product_id
          ) AS summary
        ) = $5::jsonb
      ORDER BY ordering.created_at DESC, ordering.id DESC
      LIMIT 1
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      this.policy.duplicateWindowSeconds,
      JSON.stringify(basketFingerprint(input.lines)),
    ])
    const duplicate = result.rows[0]
    if (!duplicate || input.confirmedDuplicateOrderPublicId === duplicate.public_id) return
    throw new GuestOrderDuplicateConfirmationRequiredError(duplicate.public_id, duplicate.created_at)
  }
}

function basketFingerprint(lines: readonly SubmitOrderLineInput[]): Record<string, number> {
  return Object.fromEntries(
    [...lines]
      .sort((left, right) => left.productId.localeCompare(right.productId))
      .map((line) => [line.productId, line.quantity]),
  )
}

function requiredRetryAt(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? value
    : new Date(Date.now() + 60_000).toISOString()
}

function validatePolicy(policy: Readonly<GuestOrderSafetyPolicy>): void {
  if (!Number.isInteger(policy.duplicateWindowSeconds)
    || policy.duplicateWindowSeconds < 1 || policy.duplicateWindowSeconds > 600) {
    throw new TypeError('duplicateWindowSeconds must be an integer between 1 and 600')
  }
  if (!Number.isInteger(policy.maxOrdersPerCustomerPerMinute)
    || policy.maxOrdersPerCustomerPerMinute < 1 || policy.maxOrdersPerCustomerPerMinute > 100) {
    throw new TypeError('maxOrdersPerCustomerPerMinute must be an integer between 1 and 100')
  }
  if (!Number.isInteger(policy.maxOrdersPerTablePerMinute)
    || policy.maxOrdersPerTablePerMinute < policy.maxOrdersPerCustomerPerMinute
    || policy.maxOrdersPerTablePerMinute > 500) {
    throw new TypeError('maxOrdersPerTablePerMinute must be an integer between the customer limit and 500')
  }
}
