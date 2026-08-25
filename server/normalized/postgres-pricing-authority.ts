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
  calculation_mode: 'amount_limit' | 'fixed_amount' | 'basis_points' | 'full_gift'
  fixed_amount_minor: string | number | null
  discount_basis_points: number | null
  allow_full_gift: boolean
  role_ends_at: string | Date | null
  allowed: boolean
}

interface BenefitAuthorityRow extends Record<string, unknown> {
  benefit_type: string
  benefit_status: string
  value_amount_minor: string | number | null
  currency: string | null
  allowed_product_ids: string[]
  valid_from: string | Date
  valid_until: string | Date | null
  has_active_benefit_reservation: boolean
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
        approval.calculation_mode,
        approval.fixed_amount_minor,
        approval.discount_basis_points,
        approval.allow_full_gift,
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
    const kind = approvalKind(row.approval_code)
    const amountMinor = employeeAdjustment(kind, maximumAmountMinor, {
      calculationMode: row.calculation_mode,
      fixedAmountMinor: row.fixed_amount_minor === null ? null : asMoney(row.fixed_amount_minor, 'fixed discount'),
      discountBasisPoints: row.discount_basis_points,
      allowFullGift: row.allow_full_gift,
    }, basket.subtotalAmountMinor)
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
      snapshot: { calculation: row.calculation_mode, approvalLimitId: context.request.sourceId },
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
    const lockedSession = await transaction.query<{ id: string }>(`
      SELECT session.id
      FROM mbox.table_sessions session
      WHERE session.tenant_id=$1::uuid AND session.store_id=$2::uuid
        AND session.id=$3::uuid AND session.status='open'
      FOR UPDATE
    `, [transaction.scope.tenantId, transaction.scope.storeId, context.tableSessionId])
    if (!lockedSession.rows[0]) {
      throw new PricingAuthorizationDeniedError('Table session is no longer open')
    }
    const result = await transaction.query<BenefitAuthorityRow>(`
      SELECT benefit.benefit_type, benefit.status AS benefit_status,
        benefit.value_amount_minor, benefit.currency,
        COALESCE((
          SELECT array_agg(allowed.product_id::text ORDER BY allowed.product_id)
          FROM mbox.benefit_allowed_products allowed
          WHERE allowed.tenant_id=benefit.tenant_id AND allowed.store_id=benefit.store_id
            AND allowed.benefit_id=benefit.id
        ), '{}'::text[]) AS allowed_product_ids,
        benefit.valid_from, benefit.valid_until,
        EXISTS (
          SELECT 1 FROM mbox.benefit_reservations benefit_reservation
          WHERE benefit_reservation.tenant_id=benefit.tenant_id AND benefit_reservation.store_id=benefit.store_id
            AND benefit_reservation.benefit_id=benefit.id AND benefit_reservation.table_session_id=$4::uuid
            AND benefit_reservation.status='reserved' AND benefit_reservation.expires_at>clock_timestamp()
        ) AS has_active_benefit_reservation
      FROM mbox.benefits AS benefit
      JOIN mbox.table_sessions AS session
        ON session.tenant_id = benefit.tenant_id
       AND session.store_id = benefit.store_id
       AND session.id = $4::uuid
       AND session.status = 'open'
      WHERE benefit.tenant_id = $1::uuid
        AND benefit.store_id = $2::uuid
        AND benefit.id = $3::uuid
        AND mbox.lock_active_table_customer_position(session.id,benefit.customer_id) IS NOT NULL
      FOR UPDATE OF benefit
    `, [
      transaction.scope.tenantId,
      transaction.scope.storeId,
      context.request.sourceId,
      context.tableSessionId,
    ])
    const row = result.rows[0]
    if (!row || (row.benefit_status !== 'issued'
      && (row.benefit_status !== 'reserved' || !row.has_active_benefit_reservation))) {
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
    const { kind, amountMinor } = benefitAdjustment(
      row.benefit_type,
      maximumAmountMinor,
      row.allowed_product_ids,
      basket,
    )
    const authorizationId = randomUUID()

    if (row.benefit_status === 'issued') {
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
        $5::text, $6::uuid, $7::text, $8::bigint, $9::bigint, $10::text,
        $11::uuid, $12::text,
        CASE WHEN $5::text = 'benefit' THEN $6::uuid ELSE NULL END,
        CASE WHEN $5::text = 'employee' THEN $6::uuid ELSE NULL END,
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
  control: Readonly<{
    calculationMode: EmployeeAuthorityRow['calculation_mode']
    fixedAmountMinor: number | null
    discountBasisPoints: number | null
    allowFullGift: boolean
  }>,
  subtotalAmountMinor: number,
): number {
  if (kind === 'gift') {
    if (control.calculationMode !== 'full_gift' || !control.allowFullGift
      || maximumAmountMinor < subtotalAmountMinor) {
      throw new PricingAuthorizationDeniedError('Role limit does not authorize this full gift')
    }
    return subtotalAmountMinor
  }
  let amountMinor: number
  if (control.calculationMode === 'fixed_amount' && control.fixedAmountMinor !== null) {
    amountMinor = control.fixedAmountMinor
  } else if (control.calculationMode === 'basis_points' && control.discountBasisPoints !== null) {
    amountMinor = Math.floor(subtotalAmountMinor * control.discountBasisPoints / 10_000)
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
  allowedProductIds: readonly string[],
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
    if (allowedProductIds.length === 0
      || basket.productIds.some((productId) => !allowedProductIds.includes(productId))) {
      throw new PricingAuthorizationDeniedError('Gift benefit does not cover every ordered product')
    }
    // A gift authorizes the published product and quantity, not a stale price
    // ceiling. The issue-time value remains an accounting snapshot; a price
    // change during a valid hold must not make an authorized gift unredeemable.
    return { kind: 'gift', amountMinor: basket.subtotalAmountMinor }
  }
  throw new PricingAuthorizationDeniedError(`Benefit type is not valid for order pricing: ${benefitType}`)
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
