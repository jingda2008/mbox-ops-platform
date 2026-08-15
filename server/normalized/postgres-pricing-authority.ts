import { randomUUID } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'
import {
  PricingAuthorizationDeniedError,
  type PricingAuthorizationKind,
  type PricingAuthorityContext,
  type PricingAuthorityDecision,
  type PricingAuthorityPort,
  type VerifiedPricingAuthorization,
} from './pricing-authorization-policy.js'

interface BasketLineRow extends Record<string, unknown> {
  request_index: number
  product_id: string
  quantity: number
  amount_minor: string | number
  currency: string
}

interface EmployeeAuthorityRow extends Record<string, unknown> {
  employee_status: string
  approval_code: string
  maximum_amount_minor: string | number | null
  currency: string
  rules: unknown
  role_ends_at: string | Date | null
  allowed: boolean
}

interface BenefitAuthorityRow extends Record<string, unknown> {
  benefit_type: string
  benefit_status: string
  value_amount_minor: string | number | null
  currency: string | null
  benefit_snapshot: unknown
  valid_from: string | Date
  valid_until: string | Date | null
}

interface ReservedAuthorizationRow extends Record<string, unknown> {
  id: string
}

interface ConsumedAuthorizationRow extends Record<string, unknown> {
  benefit_id: string | null
}

interface Basket {
  subtotalAmountMinor: number
  currency: string
  productIds: readonly string[]
}

export class PostgresPricingAuthority implements PricingAuthorityPort {
  async authorize(
    transaction: ScopedTransaction,
    context: Readonly<PricingAuthorityContext>,
  ): Promise<Readonly<PricingAuthorityDecision>> {
    if (context.request.sourceType === 'activity') {
      throw new PricingAuthorizationDeniedError(
        'Activity pricing is unavailable until an authoritative activity table exists',
      )
    }

    const basket = await loadServerPricedBasket(transaction, context)
    if (context.request.sourceType === 'employee') {
      return this.authorizeEmployee(transaction, context, basket)
    }
    return this.authorizeBenefit(transaction, context, basket)
  }

  async consume(
    transaction: ScopedTransaction,
    authorization: Readonly<VerifiedPricingAuthorization>,
    orderId: string,
  ): Promise<void> {
    const consumed = await transaction.query<ConsumedAuthorizationRow>(`
      UPDATE mbox.pricing_authorizations AS pricing_authorization
      SET status = 'consumed',
          order_id = ordering.id,
          consumed_at = clock_timestamp()
      FROM mbox.orders AS ordering
      WHERE pricing_authorization.tenant_id = $1::uuid
        AND pricing_authorization.store_id = $2::uuid
        AND pricing_authorization.id = $3::uuid
        AND pricing_authorization.status = 'reserved'
        AND (pricing_authorization.expires_at IS NULL OR pricing_authorization.expires_at > clock_timestamp())
        AND ordering.tenant_id = pricing_authorization.tenant_id
        AND ordering.store_id = pricing_authorization.store_id
        AND ordering.id = $4::uuid
        AND ordering.table_session_id = pricing_authorization.table_session_id
        AND ordering.discount_amount_minor = pricing_authorization.amount_minor
        AND ordering.currency = pricing_authorization.currency
      RETURNING pricing_authorization.benefit_id
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      authorization.authorizationId,
      orderId,
    ])
    const row = requireOne(consumed, 'Pricing authorization could not be consumed')
    if (row.benefit_id === null) return

    const redeemed = await transaction.query(`
      UPDATE mbox.benefits
      SET status = 'redeemed', redeemed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status = 'reserved'
    `, [transaction.scope.tenantId, transaction.scope.storeId, row.benefit_id])
    if (redeemed.rowCount !== 1) {
      throw new PricingAuthorizationDeniedError('Reserved benefit could not be redeemed')
    }
  }

  private async authorizeEmployee(
    transaction: ScopedTransaction,
    context: Readonly<PricingAuthorityContext>,
    basket: Readonly<Basket>,
  ): Promise<Readonly<PricingAuthorityDecision>> {
    if (context.actor.type !== 'employee') {
      throw new PricingAuthorizationDeniedError('Employee pricing requires an employee actor')
    }
    if (context.channel !== 'staff_assisted' && context.channel !== 'cashier') {
      throw new PricingAuthorizationDeniedError('Employee pricing is limited to staff-assisted channels')
    }

    const result = await transaction.query<EmployeeAuthorityRow>(`
      SELECT employee.status AS employee_status,
        approval.approval_code,
        approval.amount_minor AS maximum_amount_minor,
        approval.currency,
        approval.rules,
        employee_role.ends_at AS role_ends_at,
        (
          NOT EXISTS (
            SELECT 1
            FROM mbox.employee_permission_overrides denied_override
            JOIN mbox.staff_permission_definitions denied_permission
              ON denied_permission.tenant_id = denied_override.tenant_id
             AND denied_permission.store_id = denied_override.store_id
             AND denied_permission.id = denied_override.permission_id
             AND denied_permission.status = 'active'
            WHERE denied_override.tenant_id = employee.tenant_id
              AND denied_override.store_id = employee.store_id
              AND denied_override.employee_id = employee.id
              AND denied_permission.code = approval.approval_code
              AND denied_override.effect = 'deny'
              AND denied_override.starts_at <= clock_timestamp()
              AND (denied_override.ends_at IS NULL OR denied_override.ends_at > clock_timestamp())
          )
          AND (
            EXISTS (
              SELECT 1
              FROM mbox.employee_permission_overrides granted_override
              JOIN mbox.staff_permission_definitions granted_permission
                ON granted_permission.tenant_id = granted_override.tenant_id
               AND granted_permission.store_id = granted_override.store_id
               AND granted_permission.id = granted_override.permission_id
               AND granted_permission.status = 'active'
              WHERE granted_override.tenant_id = employee.tenant_id
                AND granted_override.store_id = employee.store_id
                AND granted_override.employee_id = employee.id
                AND granted_permission.code = approval.approval_code
                AND granted_override.effect = 'grant'
                AND granted_override.starts_at <= clock_timestamp()
                AND (granted_override.ends_at IS NULL OR granted_override.ends_at > clock_timestamp())
            )
            OR EXISTS (
              SELECT 1
              FROM mbox.role_permission_assignments role_permission
              JOIN mbox.staff_permission_definitions permission
                ON permission.tenant_id = role_permission.tenant_id
               AND permission.store_id = role_permission.store_id
               AND permission.id = role_permission.permission_id
               AND permission.status = 'active'
              WHERE role_permission.tenant_id = role.tenant_id
                AND role_permission.store_id = role.store_id
                AND role_permission.role_id = role.id
                AND permission.code = approval.approval_code
            )
          )
        ) AS allowed
      FROM mbox.role_approval_limits AS approval
      JOIN mbox.roles AS role
        ON role.tenant_id = approval.tenant_id
       AND role.store_id = approval.store_id
       AND role.id = approval.role_id
       AND role.status = 'active'
      JOIN mbox.employee_roles AS employee_role
        ON employee_role.tenant_id = role.tenant_id
       AND employee_role.store_id = role.store_id
       AND employee_role.role_id = role.id
       AND employee_role.employee_id = $4::uuid
       AND employee_role.starts_at <= clock_timestamp()
       AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())
      JOIN mbox.employees AS employee
        ON employee.tenant_id = employee_role.tenant_id
       AND employee.store_id = employee_role.store_id
       AND employee.id = employee_role.employee_id
      WHERE approval.tenant_id = $1::uuid
        AND approval.store_id = $2::uuid
        AND approval.id = $3::uuid
        AND approval.enabled = true
        AND approval.approval_code IN ('order.discount', 'order.gift')
      FOR UPDATE OF approval, employee
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      context.request.sourceId,
      context.actor.employeeId,
    ])
    const row = result.rows[0]
    if (!row || row.employee_status !== 'active' || !row.allowed) {
      throw new PricingAuthorizationDeniedError('Employee pricing permission is not active')
    }
    if (row.currency !== basket.currency) {
      throw new PricingAuthorizationDeniedError('Employee pricing currency does not match the order')
    }
    const maximumAmountMinor = asMoney(row.maximum_amount_minor, 'approval maximum amount')
    const rules = asObject(row.rules, 'approval rules')
    const kind = approvalKind(row.approval_code)
    const amountMinor = employeeAdjustment(kind, maximumAmountMinor, rules, basket.subtotalAmountMinor)
    const authorizationId = randomUUID()
    const expiresAt = row.role_ends_at === null ? null : toIso(row.role_ends_at)

    await reserveAuthorization(transaction, {
      authorizationId,
      tableSessionId: context.tableSessionId,
      sourceType: 'employee',
      sourceId: context.request.sourceId,
      kind,
      amountMinor,
      maximumAmountMinor,
      currency: basket.currency,
      employeeId: context.actor.employeeId,
      capability: row.approval_code,
      expiresAt,
      snapshot: { calculation: adjustmentCalculation(rules), approvalLimitId: context.request.sourceId },
    })
    return {
      authorized: true,
      authorizationId,
      kind,
      sourceType: 'employee',
      sourceId: context.request.sourceId,
      amountMinor,
      maximumAmountMinor,
      currency: basket.currency,
      authorizedByEmployeeId: context.actor.employeeId,
      capability: row.approval_code,
      expiresAt,
    }
  }

  private async authorizeBenefit(
    transaction: ScopedTransaction,
    context: Readonly<PricingAuthorityContext>,
    basket: Readonly<Basket>,
  ): Promise<Readonly<PricingAuthorityDecision>> {
    const result = await transaction.query<BenefitAuthorityRow>(`
      SELECT benefit.benefit_type, benefit.status AS benefit_status,
        benefit.value_amount_minor, benefit.currency, benefit.benefit_snapshot,
        benefit.valid_from, benefit.valid_until
      FROM mbox.benefits AS benefit
      JOIN mbox.table_session_customers AS session_customer
        ON session_customer.tenant_id = benefit.tenant_id
       AND session_customer.store_id = benefit.store_id
       AND session_customer.customer_id = benefit.customer_id
       AND session_customer.table_session_id = $4::uuid
      JOIN mbox.table_sessions AS session
        ON session.tenant_id = session_customer.tenant_id
       AND session.store_id = session_customer.store_id
       AND session.id = session_customer.table_session_id
       AND session.status = 'open'
      WHERE benefit.tenant_id = $1::uuid
        AND benefit.store_id = $2::uuid
        AND benefit.id = $3::uuid
      FOR UPDATE OF benefit, session
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      context.request.sourceId,
      context.tableSessionId,
    ])
    const row = result.rows[0]
    if (!row || row.benefit_status !== 'issued') {
      throw new PricingAuthorizationDeniedError('Benefit is unavailable for this table session')
    }
    const validFrom = Date.parse(toIso(row.valid_from))
    const validUntil = row.valid_until === null ? null : Date.parse(toIso(row.valid_until))
    const now = Date.now()
    if (validFrom > now || (validUntil !== null && validUntil <= now)) {
      throw new PricingAuthorizationDeniedError('Benefit is outside its validity period')
    }
    if (row.currency !== basket.currency) {
      throw new PricingAuthorizationDeniedError('Benefit currency does not match the order')
    }
    const maximumAmountMinor = asMoney(row.value_amount_minor, 'benefit value')
    const snapshot = asObject(row.benefit_snapshot, 'benefit snapshot')
    const { kind, amountMinor } = benefitAdjustment(
      row.benefit_type,
      maximumAmountMinor,
      snapshot,
      basket,
    )
    const authorizationId = randomUUID()

    const reserved = await transaction.query(`
      UPDATE mbox.benefits
      SET status = 'reserved', updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND status = 'issued'
        AND valid_from <= clock_timestamp()
        AND (valid_until IS NULL OR valid_until > clock_timestamp())
    `, [transaction.scope.tenantId, transaction.scope.storeId, context.request.sourceId])
    if (reserved.rowCount !== 1) {
      throw new PricingAuthorizationDeniedError('Benefit could not be reserved')
    }

    await reserveAuthorization(transaction, {
      authorizationId,
      tableSessionId: context.tableSessionId,
      sourceType: 'benefit',
      sourceId: context.request.sourceId,
      kind,
      amountMinor,
      maximumAmountMinor,
      currency: basket.currency,
      employeeId: null,
      capability: null,
      expiresAt: row.valid_until === null ? null : toIso(row.valid_until),
      snapshot: { benefitType: row.benefit_type },
    })
    return {
      authorized: true,
      authorizationId,
      kind,
      sourceType: 'benefit',
      sourceId: context.request.sourceId,
      amountMinor,
      maximumAmountMinor,
      currency: basket.currency,
      authorizedByEmployeeId: null,
      capability: null,
      expiresAt: row.valid_until === null ? null : toIso(row.valid_until),
    }
  }

}

async function loadServerPricedBasket(
  transaction: ScopedTransaction,
  context: Readonly<PricingAuthorityContext>,
): Promise<Basket> {
  const requested = context.lines.map((line, requestIndex) => ({
    request_index: requestIndex,
    product_id: line.productId,
    quantity: line.quantity,
  }))
  const result = await transaction.query<BasketLineRow>(`
    WITH requested AS (
      SELECT request_index, product_id, quantity
      FROM jsonb_to_recordset($4::jsonb)
        AS line(request_index integer, product_id uuid, quantity integer)
    )
    SELECT requested.request_index, product.id AS product_id, requested.quantity,
      price.amount_minor, price.currency
    FROM mbox.table_sessions AS session
    CROSS JOIN requested
    JOIN mbox.products AS product
      ON product.tenant_id = session.tenant_id
     AND product.store_id = session.store_id
     AND product.id = requested.product_id
     AND product.status = 'active'
    JOIN LATERAL (
      SELECT candidate.amount_minor, candidate.currency
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
    WHERE session.tenant_id = $1::uuid
      AND session.store_id = $2::uuid
      AND session.id = $3::uuid
      AND session.status = 'open'
    ORDER BY requested.request_index
    FOR KEY SHARE OF session, product
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    context.tableSessionId,
    JSON.stringify(requested),
  ])
  if (result.rows.length !== requested.length || result.rows.length === 0) {
    throw new PricingAuthorizationDeniedError('Order products or table session are unavailable')
  }
  const currencies = new Set(result.rows.map((row) => row.currency))
  if (currencies.size !== 1) {
    throw new PricingAuthorizationDeniedError('Pricing authorization requires one currency')
  }
  let subtotalAmountMinor = 0
  for (const row of result.rows) {
    const lineTotal = asMoney(row.amount_minor, 'product price') * row.quantity
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotalAmountMinor + lineTotal)) {
      throw new PricingAuthorizationDeniedError('Order subtotal exceeds the supported range')
    }
    subtotalAmountMinor += lineTotal
  }
  if (subtotalAmountMinor <= 0) {
    throw new PricingAuthorizationDeniedError('Pricing authorization requires a positive subtotal')
  }
  return {
    subtotalAmountMinor,
    currency: result.rows[0]!.currency,
    productIds: result.rows.map((row) => row.product_id),
  }
}

async function reserveAuthorization(
  transaction: ScopedTransaction,
  input: Readonly<{
    authorizationId: string
    tableSessionId: string
    sourceType: 'employee' | 'benefit'
    sourceId: string
    kind: PricingAuthorizationKind
    amountMinor: number
    maximumAmountMinor: number
    currency: string
    employeeId: string | null
    capability: string | null
    expiresAt: string | null
    snapshot: Record<string, unknown>
  }>,
): Promise<void> {
  try {
    const inserted = await transaction.query<ReservedAuthorizationRow>(`
      INSERT INTO mbox.pricing_authorizations (
        id, tenant_id, store_id, table_session_id,
        source_type, source_id, kind, amount_minor, maximum_amount_minor, currency,
        authorized_by_employee_id, capability, benefit_id, role_approval_limit_id,
        status, expires_at, authorization_snapshot
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        $5, $6::uuid, $7, $8::bigint, $9::bigint, $10,
        $11::uuid, $12,
        CASE WHEN $5 = 'benefit' THEN $6::uuid ELSE NULL END,
        CASE WHEN $5 = 'employee' THEN $6::uuid ELSE NULL END,
        'reserved', $13::timestamptz, $14::jsonb
      )
      RETURNING id
    `, [
      input.authorizationId,
      transaction.scope.tenantId,
      transaction.scope.storeId,
      input.tableSessionId,
      input.sourceType,
      input.sourceId,
      input.kind,
      input.amountMinor,
      input.maximumAmountMinor,
      input.currency,
      input.employeeId,
      input.capability,
      input.expiresAt,
      JSON.stringify(input.snapshot),
    ])
    requireOne(inserted, 'Pricing authorization reservation failed')
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PricingAuthorizationDeniedError(
        'This pricing source has already been used for the table session',
      )
    }
    throw error
  }
}

function employeeAdjustment(
  kind: PricingAuthorizationKind,
  maximumAmountMinor: number,
  rules: Record<string, unknown>,
  subtotalAmountMinor: number,
): number {
  if (kind === 'gift') {
    if (rules.allowFullGift !== true || maximumAmountMinor < subtotalAmountMinor) {
      throw new PricingAuthorizationDeniedError('Role limit does not authorize this full gift')
    }
    return subtotalAmountMinor
  }
  const fixed = rules.fixedAmountMinor
  const basisPoints = rules.discountBasisPoints
  let amountMinor: number
  if (fixed !== undefined) {
    amountMinor = asMoney(fixed, 'fixed discount')
  } else if (basisPoints !== undefined) {
    if (!Number.isInteger(basisPoints) || (basisPoints as number) < 1 || (basisPoints as number) > 9_999) {
      throw new PricingAuthorizationDeniedError('discountBasisPoints must be between 1 and 9999')
    }
    amountMinor = Math.floor(subtotalAmountMinor * (basisPoints as number) / 10_000)
  } else {
    throw new PricingAuthorizationDeniedError(
      'Role approval rules must define fixedAmountMinor or discountBasisPoints',
    )
  }
  if (amountMinor < 1 || amountMinor > maximumAmountMinor || amountMinor >= subtotalAmountMinor) {
    throw new PricingAuthorizationDeniedError('Calculated discount is outside the server approval limit')
  }
  return amountMinor
}

function benefitAdjustment(
  benefitType: string,
  maximumAmountMinor: number,
  snapshot: Record<string, unknown>,
  basket: Readonly<Basket>,
): { kind: PricingAuthorizationKind; amountMinor: number } {
  if (benefitType === 'discount') {
    if (maximumAmountMinor < 1 || maximumAmountMinor >= basket.subtotalAmountMinor) {
      throw new PricingAuthorizationDeniedError('Discount benefit cannot create a zero-total order')
    }
    return { kind: 'discount', amountMinor: maximumAmountMinor }
  }
  if (benefitType === 'credit') {
    const amountMinor = Math.min(maximumAmountMinor, basket.subtotalAmountMinor)
    if (amountMinor < 1) throw new PricingAuthorizationDeniedError('Credit benefit has no usable value')
    return {
      kind: amountMinor === basket.subtotalAmountMinor ? 'gift' : 'discount',
      amountMinor,
    }
  }
  if (benefitType === 'gift_product') {
    const allowed = snapshot.allowedProductIds
    if (!Array.isArray(allowed) || allowed.length === 0
      || basket.productIds.some((productId) => !allowed.includes(productId))
      || maximumAmountMinor < basket.subtotalAmountMinor) {
      throw new PricingAuthorizationDeniedError('Gift benefit does not cover every ordered product')
    }
    return { kind: 'gift', amountMinor: basket.subtotalAmountMinor }
  }
  throw new PricingAuthorizationDeniedError(`Benefit type is not valid for order pricing: ${benefitType}`)
}

function adjustmentCalculation(rules: Record<string, unknown>): string {
  if (rules.fixedAmountMinor !== undefined) return 'fixed_amount'
  if (rules.discountBasisPoints !== undefined) return 'basis_points'
  return 'full_gift'
}

function approvalKind(approvalCode: string): PricingAuthorizationKind {
  if (approvalCode === 'order.discount') return 'discount'
  if (approvalCode === 'order.gift') return 'gift'
  throw new PricingAuthorizationDeniedError('Role approval code cannot authorize pricing')
}

function asMoney(value: unknown, name: string): number {
  const normalized = typeof value === 'string' ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new PricingAuthorizationDeniedError(`${name} is not a valid amount`)
  }
  return normalized as number
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PricingAuthorizationDeniedError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function toIso(value: string | Date): string {
  const timestamp = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new PricingAuthorizationDeniedError('Pricing validity time is invalid')
  }
  return timestamp.toISOString()
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  message: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) {
    throw new PricingAuthorizationDeniedError(message)
  }
  return row
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
