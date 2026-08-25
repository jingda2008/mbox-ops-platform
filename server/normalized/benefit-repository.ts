import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CustomerRepository } from './customer-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import { assertEmployeeTableSessionAccess } from './employee-table-access.js'

export type BenefitType = 'gift_product' | 'discount' | 'credit' | 'access' | 'other'
export type BenefitStatus = 'issued' | 'reserved' | 'redeemed' | 'expired' | 'revoked'
export type BenefitReservationStatus = 'reserved' | 'redeemed' | 'cancelled' | 'expired'

export interface Benefit {
  id: string
  customerId: string
  benefitCode: string
  benefitType: BenefitType
  status: BenefitStatus
  valueAmountMinor: number | null
  currency: string | null
  benefitSnapshot: JsonObject
  quantityTotal: number
  quantityReserved: number
  quantityRedeemed: number
  quantityAvailable: number
  validFrom: string
  validUntil: string | null
  issuedByEmployeeId: string | null
  issuanceReason: string | null
  authorizationSource: JsonObject
  authorizationLimitId: string | null
  redeemedAt: string | null
  aggregateVersion: number
  createdAt: string
  updatedAt: string
}

export interface BenefitReservation {
  id: string
  benefitId: string
  customerId: string
  tableSessionId: string
  quantity: number
  status: BenefitReservationStatus
  reservedAt: string
  expiresAt: string
  completedAt: string | null
  cancelReason: string | null
}

export interface BenefitRedemption {
  id: string
  benefitId: string
  benefitReservationId: string
  customerId: string
  tableSessionId: string
  quantity: number
  giftOrderReference: string | null
  authorizationSource: JsonObject
  redeemedAt: string
}

export interface IssueBenefitInput {
  customerId: string
  benefitCode: string
  benefitType: BenefitType
  valueAmountMinor?: number | null
  currency?: string | null
  quantity?: number
  allowedProductIds?: readonly string[]
  benefitSnapshot?: JsonObject
  validFrom?: string
  validUntil?: string | null
  issuedByEmployeeId?: string | null
  authorizationLimitId?: string | null
  reason?: string | null
  authorizationSource: JsonObject
  issuanceIdempotencyKey: string
  issuanceFingerprint: string
}

export interface ReserveBenefitInput {
  benefitId: string
  customerId: string
  tableSessionId: string
  quantity?: number
  expiresAt: string
  reservationIdempotencyKey: string
  reservationFingerprint: string
  annualDailySnackClaimId?: string
}

export interface RedeemBenefitInput {
  benefitId: string
  benefitReservationId: string
  customerId: string
  tableSessionId: string
  redeemedByEmployeeId?: string | null
  authorizationSource: JsonObject
  redemptionIdempotencyKey: string
  redemptionFingerprint: string
  redeemedAt?: string
  businessDate?: string
  selectedProductId?: string | null
  substitutionReason?: string | null
}

export interface CancelBenefitReservationInput {
  benefitReservationId: string
  customerId: string
  tableSessionId: string
  reason: string
  cancellationIdempotencyKey: string
  cancellationFingerprint: string
  employeePermission?: 'loyalty.redemption.fulfill' | 'benefit.cancel'
}

export interface IssueBenefitCommand extends IssueBenefitInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
}

export interface ReserveBenefitCommand extends ReserveBenefitInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
}

export interface RedeemBenefitCommand extends RedeemBenefitInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
}

export interface CancelBenefitReservationCommand extends CancelBenefitReservationInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
}

export interface GiftOrderRequest {
  benefitId: string
  benefitReservationId: string
  customerId: string
  tableSessionId: string
  quantity: number
  benefitSnapshot: JsonObject
  redeemedByEmployeeId: string | null
  businessDate: string
  selectedProductId: string | null
  substitutionReason: string | null
}

export interface GiftOrderPort {
  createGiftOrder(
    transaction: ScopedTransaction,
    input: Readonly<GiftOrderRequest>,
  ): Promise<{ reference: string }>
}

interface BenefitRow extends Record<string, unknown> {
  id: string
  customer_id: string
  benefit_code: string
  benefit_type: BenefitType
  status: BenefitStatus
  value_amount_minor: string | number | null
  currency: string | null
  benefit_snapshot: JsonObject
  quantity_total: number
  quantity_reserved: number
  quantity_redeemed: number
  valid_from: string
  valid_until: string | null
  issued_by_employee_id: string | null
  issuance_reason: string | null
  authorization_source: JsonObject
  authorization_limit_id: string | null
  redeemed_at: string | null
  aggregate_version: string | number
  created_at: string
  updated_at: string
}

interface ReservationRow extends Record<string, unknown> {
  id: string
  benefit_id: string
  customer_id: string
  table_session_id: string
  quantity: number
  status: BenefitReservationStatus
  reservation_idempotency_key: string
  reservation_fingerprint: string
  reserved_at: string
  expires_at: string
  completed_at: string | null
  cancel_reason: string | null
}

interface RedemptionRow extends Record<string, unknown> {
  id: string
  benefit_id: string
  benefit_reservation_id: string
  customer_id: string
  table_session_id: string
  quantity: number
  gift_order_reference: string | null
  authorization_source: JsonObject
  redeemed_at: string
}

interface ApprovalRow extends Record<string, unknown> {
  maximum_amount_minor: string | number | null
  currency: string
}

export class BenefitNotFoundError extends Error {
  constructor(id: string) {
    super(`Benefit was not found: ${id}`)
    this.name = 'BenefitNotFoundError'
  }
}

export class BenefitReservationNotFoundError extends Error {
  constructor(id: string) {
    super(`Benefit reservation was not found: ${id}`)
    this.name = 'BenefitReservationNotFoundError'
  }
}

export class BenefitIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Benefit idempotency key conflicts with another request: ${key}`)
    this.name = 'BenefitIdempotencyConflictError'
  }
}

export class BenefitUnavailableError extends Error {
  constructor(message = 'Benefit is unavailable, expired, or has insufficient quantity') {
    super(message)
    this.name = 'BenefitUnavailableError'
  }
}

export class BenefitOwnershipError extends Error {
  constructor() {
    super('Benefit is not owned by the current customer and table session')
    this.name = 'BenefitOwnershipError'
  }
}

export class BenefitAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenefitAuthorizationError'
  }
}

export class BenefitRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string): Promise<Benefit | null> {
    const row = await this.selectById(id, false)
    return row === null ? null : mapBenefit(row)
  }

  async listAvailableForCustomer(customerId: string, at?: string): Promise<Benefit[]> {
    const customer = await new CustomerRepository(this.transaction).resolveCanonical(customerId)
    const result = await this.transaction.query<BenefitRow>(`${benefitSelectSql()}
      AND b.customer_id IN (
        WITH RECURSIVE family(id) AS (
          SELECT $3::uuid
          UNION ALL
          SELECT c.id FROM mbox.customers AS c JOIN family ON c.merged_into_customer_id = family.id
          WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid
        ) SELECT id FROM family
      )
      AND b.status IN ('issued', 'reserved')
      AND b.quantity_reserved + b.quantity_redeemed < b.quantity_total
      AND b.valid_from <= COALESCE($4::timestamptz, clock_timestamp())
      AND (b.valid_until IS NULL OR b.valid_until > COALESCE($4::timestamptz, clock_timestamp()))
      ORDER BY b.valid_until NULLS LAST, b.created_at, b.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, customer.id, at ?? null])
    return result.rows.map(mapBenefit)
  }

  async issue(input: Readonly<IssueBenefitInput>): Promise<Benefit> {
    validateIssue(input)
    const customer = await new CustomerRepository(this.transaction).resolveCanonical(input.customerId)
    await this.lockIdempotency(`benefit-issue:${input.issuanceIdempotencyKey}`)
    const existing = await this.transaction.query<BenefitRow>(`${benefitSelectSql()}
      AND b.issuance_idempotency_key = $3 LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.issuanceIdempotencyKey])
    if (existing.rows[0] !== undefined) {
      const stored = await this.transaction.query<{ issuance_fingerprint: string }>(`
        SELECT issuance_fingerprint FROM mbox.benefits
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, existing.rows[0].id])
      if (stored.rows[0]?.issuance_fingerprint !== input.issuanceFingerprint) {
        throw new BenefitIdempotencyConflictError(input.issuanceIdempotencyKey)
      }
      return mapBenefit(existing.rows[0])
    }

    await this.assertIssuanceAuthority(input)
    const inserted = await this.transaction.query<BenefitRow>(`
      INSERT INTO mbox.benefits (
        tenant_id, store_id, customer_id, benefit_code, benefit_type,
        value_amount_minor, currency, benefit_snapshot, quantity_total,
        valid_from, valid_until, issued_by_employee_id, issuance_reason,
        authorization_limit_id, authorization_source,
        issuance_idempotency_key, issuance_fingerprint
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5,
        $6::bigint, $7, $8::jsonb, $9::integer,
        COALESCE($10::timestamptz, clock_timestamp()), $11::timestamptz,
        $12::uuid, $13, $14::uuid, $15::jsonb, $16, $17
      )
      RETURNING ${benefitReturningSql()}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      customer.id,
      input.benefitCode,
      input.benefitType,
      input.valueAmountMinor ?? null,
      input.currency ?? null,
      JSON.stringify(input.benefitSnapshot ?? {}),
      input.quantity ?? 1,
      input.validFrom ?? null,
      input.validUntil ?? null,
      input.issuedByEmployeeId ?? null,
      normalizeReason(input.reason),
      input.authorizationLimitId ?? null,
      JSON.stringify(input.issuedByEmployeeId === undefined || input.issuedByEmployeeId === null
        ? input.authorizationSource
        : {
            kind: 'role_approval_limit',
            approvalLimitId: input.authorizationLimitId,
            employeeId: input.issuedByEmployeeId,
          }),
      input.issuanceIdempotencyKey,
      input.issuanceFingerprint,
    ])
    const benefit = requireOne(inserted, 'Issuing a benefit')
    const allowedProductIds = [...new Set(input.allowedProductIds ?? [])].toSorted()
    if (allowedProductIds.length > 0) {
      const allowed = await this.transaction.query(`
        INSERT INTO mbox.benefit_allowed_products (
          tenant_id, store_id, benefit_id, product_id
        )
        SELECT $1::uuid, $2::uuid, $3::uuid, product.id
        FROM mbox.products product
        WHERE product.tenant_id=$1::uuid AND product.store_id=$2::uuid
          AND product.id=ANY($4::uuid[]) AND product.status='active'
        ON CONFLICT DO NOTHING
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        benefit.id,
        allowedProductIds,
      ])
      if (allowed.rowCount !== allowedProductIds.length) {
        throw new TypeError('allowedProductIds contains an unavailable product')
      }
    }
    return mapBenefit(benefit)
  }

  async reserve(
    input: Readonly<ReserveBenefitInput>,guestActorRef?: string,employeeActorId?: string,
  ): Promise<BenefitReservation> {
    validateReserve(input)
    const canonical = await new CustomerRepository(this.transaction).resolveCanonical(input.customerId)
    await this.assertCurrentTableCustomer(
      canonical.id,input.tableSessionId,guestActorRef,employeeActorId,'loyalty.redemption.fulfill',
    )
    await this.lockIdempotency(`benefit-reserve:${input.reservationIdempotencyKey}`)
    const existing = await this.transaction.query<ReservationRow>(`${reservationSelectSql()}
      AND reservation.reservation_idempotency_key = $3 LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.reservationIdempotencyKey])
    if (existing.rows[0] !== undefined) {
      if (existing.rows[0].reservation_fingerprint !== input.reservationFingerprint) {
        throw new BenefitIdempotencyConflictError(input.reservationIdempotencyKey)
      }
      return mapReservation(existing.rows[0])
    }

    const quantity = input.quantity ?? 1
    const benefit = await this.selectById(input.benefitId, true)
    if (benefit === null) throw new BenefitNotFoundError(input.benefitId)
    if (!await this.isSameCustomerFamily(benefit.customer_id, canonical.id)) throw new BenefitOwnershipError()
    await this.assertAnnualDailySnackClaimReservation(
      benefit.id, input.tableSessionId, input.annualDailySnackClaimId,
    )
    const updated = await this.transaction.query(`
      UPDATE mbox.benefits
      SET quantity_reserved = quantity_reserved + $4::integer,
          status = 'reserved', aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status IN ('issued', 'reserved')
        AND valid_from <= clock_timestamp()
        AND (valid_until IS NULL OR valid_until > clock_timestamp())
        AND quantity_reserved + quantity_redeemed + $4::integer <= quantity_total
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.benefitId, quantity])
    if (updated.rowCount !== 1) throw new BenefitUnavailableError()
    const inserted = await this.transaction.query<ReservationRow>(`
      INSERT INTO mbox.benefit_reservations (
        tenant_id, store_id, benefit_id, customer_id, table_session_id,
        quantity, reservation_idempotency_key, reservation_fingerprint, expires_at
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::timestamptz)
      RETURNING ${reservationReturningSql()}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.benefitId,
      canonical.id,
      input.tableSessionId,
      quantity,
      input.reservationIdempotencyKey,
      input.reservationFingerprint,
      input.expiresAt,
    ])
    return mapReservation(requireOne(inserted, 'Reserving a benefit'))
  }

  async redeem(
    input: Readonly<RedeemBenefitInput>,
    giftOrders?: GiftOrderPort,
    guestActorRef?: string,
    employeeActorId?: string,
  ): Promise<BenefitRedemption> {
    validateRedeem(input)
    const canonical = await new CustomerRepository(this.transaction).resolveCanonical(input.customerId)
    await this.assertCurrentTableCustomer(
      canonical.id,input.tableSessionId,guestActorRef,employeeActorId,'loyalty.redemption.fulfill',
    )
    await this.lockIdempotency(`benefit-redeem:${input.redemptionIdempotencyKey}`)
    const existing = await this.transaction.query<RedemptionRow>(`${redemptionSelectSql()}
      AND redemption.redemption_idempotency_key = $3 LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.redemptionIdempotencyKey])
    if (existing.rows[0] !== undefined) {
      const fingerprint = await this.transaction.query<{ redemption_fingerprint: string }>(`
        SELECT redemption_fingerprint FROM mbox.benefit_redemptions
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, existing.rows[0].id])
      if (fingerprint.rows[0]?.redemption_fingerprint !== input.redemptionFingerprint) {
        throw new BenefitIdempotencyConflictError(input.redemptionIdempotencyKey)
      }
      return mapRedemption(existing.rows[0])
    }

    const competingRedemption = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.benefit_redemptions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND benefit_reservation_id = $3::uuid
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.benefitReservationId])
    if (competingRedemption.rowCount !== 0) {
      throw new BenefitUnavailableError('already redeemed by another request')
    }

    const reservation = await this.selectReservation(input.benefitReservationId, true)
    if (reservation === null) throw new BenefitReservationNotFoundError(input.benefitReservationId)
    if (reservation.benefit_id !== input.benefitId
      || reservation.customer_id !== canonical.id
      || reservation.table_session_id !== input.tableSessionId) throw new BenefitOwnershipError()
    if (reservation.status !== 'reserved' || !await this.isReservationCurrent(reservation.id)) {
      throw new BenefitUnavailableError('Benefit reservation is no longer redeemable')
    }
    const benefit = await this.selectById(input.benefitId, true)
    if (benefit === null) throw new BenefitNotFoundError(input.benefitId)

    let giftOrderReference: string | null = null
    if (benefit.benefit_type === 'gift_product') {
      if (giftOrders === undefined) throw new BenefitAuthorizationError('Gift product order adapter is required')
      const gift = await giftOrders.createGiftOrder(this.transaction, {
        benefitId: benefit.id,
        benefitReservationId: reservation.id,
        customerId: reservation.customer_id,
        tableSessionId: reservation.table_session_id,
        quantity: reservation.quantity,
        benefitSnapshot: benefit.benefit_snapshot,
        redeemedByEmployeeId: input.redeemedByEmployeeId ?? null,
        businessDate: input.businessDate ?? '',
        selectedProductId: input.selectedProductId ?? null,
        substitutionReason: input.substitutionReason?.trim() || null,
      })
      giftOrderReference = gift.reference
    }

    const inserted = await this.transaction.query<RedemptionRow>(`
      INSERT INTO mbox.benefit_redemptions (
        tenant_id, store_id, benefit_id, benefit_reservation_id,
        customer_id, table_session_id, quantity, redemption_idempotency_key,
        redemption_fingerprint, redeemed_by_employee_id, gift_order_reference,
        authorization_source, redeemed_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        $7, $8, $9, $10::uuid, $11, $12::jsonb,
        COALESCE($13::timestamptz, clock_timestamp())
      )
      RETURNING ${redemptionReturningSql()}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      benefit.id,
      reservation.id,
      reservation.customer_id,
      reservation.table_session_id,
      reservation.quantity,
      input.redemptionIdempotencyKey,
      input.redemptionFingerprint,
      input.redeemedByEmployeeId ?? null,
      giftOrderReference,
      JSON.stringify(input.authorizationSource),
      input.redeemedAt ?? null,
    ])
    await this.transaction.query(`
      UPDATE mbox.benefit_reservations
      SET status = 'redeemed', completed_at = COALESCE($4::timestamptz, clock_timestamp())
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'reserved'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, input.redeemedAt ?? null])
    const updated = await this.transaction.query(`
      UPDATE mbox.benefits
      SET quantity_reserved = quantity_reserved - $4::integer,
          quantity_redeemed = quantity_redeemed + $4::integer,
          status = CASE WHEN quantity_redeemed + $4::integer = quantity_total THEN 'redeemed' ELSE 'issued' END,
          redeemed_at = CASE WHEN quantity_redeemed + $4::integer = quantity_total
            THEN COALESCE($5::timestamptz, clock_timestamp()) ELSE redeemed_at END,
          aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND quantity_reserved >= $4::integer
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      benefit.id,
      reservation.quantity,
      input.redeemedAt ?? null,
    ])
    if (updated.rowCount !== 1) throw new BenefitUnavailableError('Benefit quantity changed during redemption')
    return mapRedemption(requireOne(inserted, 'Redeeming a benefit'))
  }

  async cancelReservation(
    input: Readonly<CancelBenefitReservationInput>,guestActorRef?: string,employeeActorId?: string,
  ): Promise<BenefitReservation> {
    validateCancel(input)
    const canonical = await new CustomerRepository(this.transaction).resolveCanonical(input.customerId)
    await this.assertCurrentTableCustomer(
      canonical.id,input.tableSessionId,guestActorRef,employeeActorId,
      input.employeePermission ?? 'benefit.cancel',
    )
    const reservation = await this.selectReservation(input.benefitReservationId, true)
    if (reservation === null) throw new BenefitReservationNotFoundError(input.benefitReservationId)
    if (reservation.customer_id !== canonical.id || reservation.table_session_id !== input.tableSessionId) {
      throw new BenefitOwnershipError()
    }
    if (reservation.status === 'cancelled') return mapReservation(reservation)
    if (reservation.status !== 'reserved') throw new BenefitUnavailableError('Only reserved benefits can be cancelled')
    await this.transaction.query(`
      UPDATE mbox.benefit_reservations
      SET status = 'cancelled', completed_at = clock_timestamp(), cancel_reason = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid AND status = 'reserved'
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reservation.id, input.reason.trim()])
    await this.transaction.query(`
      UPDATE mbox.benefits
      SET quantity_reserved = quantity_reserved - $4::integer,
          status = CASE WHEN quantity_redeemed = quantity_total THEN 'redeemed' ELSE 'issued' END,
          aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND quantity_reserved >= $4::integer
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      reservation.benefit_id,
      reservation.quantity,
    ])
    return mapReservation((await this.selectReservation(reservation.id, false))!)
  }

  private async assertIssuanceAuthority(input: Readonly<IssueBenefitInput>): Promise<void> {
    if (input.issuedByEmployeeId === undefined || input.issuedByEmployeeId === null) return
    if (input.authorizationLimitId === undefined || input.authorizationLimitId === null) {
      throw new BenefitAuthorizationError('Manual benefit issuance requires an approval limit')
    }
    if (normalizeReason(input.reason) === null) {
      throw new BenefitAuthorizationError('Manual benefit issuance requires a reason')
    }
    await new StaffAccessRepository(this.transaction)
      .assertPermission(input.issuedByEmployeeId, 'benefit.issue')
    const approval = await this.transaction.query<ApprovalRow>(`
      SELECT approval.amount_minor AS maximum_amount_minor, approval.currency
      FROM mbox.role_approval_limits AS approval
      JOIN mbox.employee_roles AS employee_role
        ON employee_role.tenant_id = approval.tenant_id
       AND employee_role.store_id = approval.store_id
       AND employee_role.role_id = approval.role_id
       AND employee_role.employee_id = $4::uuid
       AND employee_role.starts_at <= clock_timestamp()
       AND (employee_role.ends_at IS NULL OR employee_role.ends_at > clock_timestamp())
      WHERE approval.tenant_id = $1::uuid AND approval.store_id = $2::uuid
        AND approval.id = $3::uuid AND approval.enabled = true
        AND approval.approval_code = 'benefit.issue'
      FOR UPDATE OF approval
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.authorizationLimitId,
      input.issuedByEmployeeId,
    ])
    const row = approval.rows[0]
    if (row === undefined) throw new BenefitAuthorizationError('Benefit approval source is not active')
    const amount = (input.valueAmountMinor ?? 0) * (input.quantity ?? 1)
    if (!Number.isSafeInteger(amount)) throw new BenefitAuthorizationError('Benefit total value is too large')
    if (row.currency !== (input.currency ?? row.currency)) {
      throw new BenefitAuthorizationError('Benefit currency does not match the approval source')
    }
    if (row.maximum_amount_minor !== null && amount > Number(row.maximum_amount_minor)) {
      throw new BenefitAuthorizationError('Benefit value exceeds the employee approval limit')
    }
  }

  private async assertCurrentTableCustomer(
    canonicalCustomerId: string,tableSessionId: string,guestActorRef?: string,employeeActorId?: string,
    employeePermission?: 'loyalty.redemption.fulfill' | 'benefit.cancel',
  ): Promise<void> {
    if (guestActorRef!==undefined) {
      if (!await lockBoundGuestTablePosition(this.transaction,{
        tableSessionId,customerId:canonicalCustomerId,actorRef:guestActorRef,
      })) throw new BenefitOwnershipError()
      return
    }
    if (employeeActorId!==undefined) {
      if (employeePermission===undefined) throw new BenefitAuthorizationError(
        'Employee table benefit action requires an explicit permission',
      )
      await new StaffAccessRepository(this.transaction).assertPermission(employeeActorId,employeePermission)
      await assertEmployeeTableSessionAccess(this.transaction,{
        employeeId:employeeActorId,tableSessionId,lockTableSession:true,
      })
    }
    const result=await this.transaction.query<{ participation_id: string | null }>(`
      SELECT mbox.lock_active_table_customer_position($1::uuid,$2::uuid) AS participation_id
    `,[tableSessionId,canonicalCustomerId])
    if (result.rows[0]?.participation_id===null) throw new BenefitOwnershipError()
  }

  private async isSameCustomerFamily(ownerId: string, canonicalId: string): Promise<boolean> {
    const result = await this.transaction.query(`
      WITH RECURSIVE family(id) AS (
        SELECT $4::uuid
        UNION ALL
        SELECT c.id FROM mbox.customers AS c JOIN family ON c.merged_into_customer_id = family.id
        WHERE c.tenant_id = $1::uuid AND c.store_id = $2::uuid
      )
      SELECT 1 AS allowed FROM family WHERE id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, ownerId, canonicalId])
    return result.rowCount === 1
  }

  private lockIdempotency(key: string): Promise<unknown> {
    return this.transaction.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${key}`],
    )
  }

  private async selectById(id: string, forUpdate: boolean): Promise<BenefitRow | null> {
    const result = await this.transaction.query<BenefitRow>(`${benefitSelectSql()}
      AND b.id = $3::uuid ${forUpdate ? 'FOR UPDATE OF b' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] ?? null
  }

  private async selectReservation(id: string, forUpdate: boolean): Promise<ReservationRow | null> {
    const result = await this.transaction.query<ReservationRow>(`${reservationSelectSql()}
      AND reservation.id = $3::uuid ${forUpdate ? 'FOR UPDATE OF reservation' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] ?? null
  }

  private async isReservationCurrent(id: string): Promise<boolean> {
    const result = await this.transaction.query<{ valid: boolean }>(`
      SELECT expires_at > clock_timestamp() AS valid
      FROM mbox.benefit_reservations
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0]?.valid === true
  }

  private async assertAnnualDailySnackClaimReservation(
    benefitId: string, tableSessionId: string, claimId: string | undefined,
  ): Promise<void> {
    const result = await this.transaction.query<{
      id: string; table_session_id: string; status: string
    }>(`
      SELECT id,table_session_id,status FROM mbox.annual_daily_snack_claims
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND benefit_id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, benefitId])
    const claim = result.rows[0]
    if (claim === undefined) return
    if (claimId !== claim.id || claim.table_session_id !== tableSessionId || claim.status !== 'initiated') {
      throw new BenefitUnavailableError('Daily snack benefits can only be reserved by their original table-side claim')
    }
  }
}

export class BenefitCommandService {
  constructor(
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly giftOrders?: GiftOrderPort,
  ) {}

  issue(input: Readonly<IssueBenefitCommand>): Promise<CommandExecution<Benefit>> {
    return this.executeBenefit('benefit.issue', input, benefitCodec, async (repository) => ({
      result: await repository.issue(input),
      action: 'benefit.issued',
    }))
  }

  reserve(input: Readonly<ReserveBenefitCommand>): Promise<CommandExecution<BenefitReservation>> {
    return this.executeBenefit('benefit.reserve', input, reservationCodec, async (repository) => ({
      result: await repository.reserve(
        input,
        input.actor.type==='guest' ? input.actor.ref : undefined,
        input.actor.type==='employee' ? input.actor.employeeId : undefined,
      ),
      action: 'benefit.reserved',
    }))
  }

  redeem(input: Readonly<RedeemBenefitCommand>): Promise<CommandExecution<BenefitRedemption>> {
    return this.executeBenefit('benefit.redeem', input, redemptionCodec, async (repository) => ({
      result: await repository.redeem(
        input,this.giftOrders,input.actor.type==='guest' ? input.actor.ref : undefined,
        input.actor.type==='employee' ? input.actor.employeeId : undefined,
      ),
      action: 'benefit.redeemed',
    }))
  }

  cancelReservation(
    input: Readonly<CancelBenefitReservationCommand>,
  ): Promise<CommandExecution<BenefitReservation>> {
    return this.executeBenefit('benefit.cancel-reservation', {
      ...input,
      idempotencyKey: input.cancellationIdempotencyKey,
      requestFingerprint: input.cancellationFingerprint,
    }, reservationCodec, async (repository) => ({
      result: await repository.cancelReservation(
        input,input.actor.type==='guest' ? input.actor.ref : undefined,
        input.actor.type==='employee' ? input.actor.employeeId : undefined,
      ),
      action: 'benefit.reservation-cancelled',
    }))
  }

  private executeBenefit<Result extends Benefit | BenefitReservation | BenefitRedemption>(
    operationScope: string,
    input: Readonly<{
      scope: Readonly<StoreScope>
      actor: AuditActor
      businessDate: string
      idempotencyKey?: string
      requestFingerprint?: string
      issuanceIdempotencyKey?: string
      issuanceFingerprint?: string
      reservationIdempotencyKey?: string
      reservationFingerprint?: string
      redemptionIdempotencyKey?: string
      redemptionFingerprint?: string
      reason?: string | null
    }>,
    codec: JsonCodec<Result>,
    operation: (repository: BenefitRepository) => Promise<{ result: Result; action: string }>,
  ): Promise<CommandExecution<Result>> {
    const idempotencyKey = input.idempotencyKey ?? input.issuanceIdempotencyKey
      ?? input.reservationIdempotencyKey ?? input.redemptionIdempotencyKey
    const requestFingerprint = input.requestFingerprint ?? input.issuanceFingerprint
      ?? input.reservationFingerprint ?? input.redemptionFingerprint
    if (idempotencyKey === undefined || requestFingerprint === undefined) {
      throw new TypeError('Benefit command idempotency fields are required')
    }
    return this.commands.execute({
      scope: input.scope,
      operationScope,
      idempotencyKey,
      requestFingerprint,
      resultCodec: codec,
    }, async (transaction) => {
      const outcome = await operation(new BenefitRepository(transaction))
      const payload = codec.encode(outcome.result) as JsonObject
      const benefitId = 'benefitId' in outcome.result ? outcome.result.benefitId : outcome.result.id
      const objectId = outcome.result.id
      const objectType = 'benefitReservationId' in outcome.result
        ? 'benefit_redemption'
        : 'benefitId' in outcome.result
          ? 'benefit_reservation'
          : 'benefit'
      const currentBenefit = await new BenefitRepository(transaction).findById(benefitId)
      if (currentBenefit === null) throw new BenefitNotFoundError(benefitId)
      return {
        result: outcome.result,
        auditEvents: [{
          actor: input.actor,
          action: outcome.action,
          objectType,
          objectId,
          businessDate: input.businessDate,
          reason: input.reason,
          afterData: payload,
        }],
        outboxMessages: [{
          businessEventKey: `${operationScope}:${idempotencyKey}`,
          aggregateType: 'benefit',
          aggregateId: benefitId,
          aggregateVersion: currentBenefit.aggregateVersion,
          eventType: `${outcome.action}.v1`,
          payload,
        }],
      }
    })
  }
}

const benefitCodec: JsonCodec<Benefit> = { encode: benefitToJson, decode: decodeBenefit }
const reservationCodec: JsonCodec<BenefitReservation> = {
  encode: reservationToJson,
  decode: decodeReservation,
}
const redemptionCodec: JsonCodec<BenefitRedemption> = {
  encode: redemptionToJson,
  decode: decodeRedemption,
}

function benefitSelectSql(): string {
  return `SELECT ${benefitReturningSql('b')} FROM mbox.benefits AS b
    WHERE b.tenant_id = $1::uuid AND b.store_id = $2::uuid`
}

function benefitReturningSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}id, ${prefix}customer_id, ${prefix}benefit_code, ${prefix}benefit_type,
    ${prefix}status, ${prefix}value_amount_minor, ${prefix}currency, ${prefix}benefit_snapshot,
    ${prefix}quantity_total, ${prefix}quantity_reserved, ${prefix}quantity_redeemed,
    ${prefix}valid_from::text, ${prefix}valid_until::text, ${prefix}issued_by_employee_id,
    ${prefix}issuance_reason, ${prefix}authorization_source, ${prefix}authorization_limit_id,
    ${prefix}redeemed_at::text, ${prefix}aggregate_version,
    ${prefix}created_at::text, ${prefix}updated_at::text`
}

function reservationSelectSql(): string {
  return `SELECT ${reservationReturningSql('reservation')}
    FROM mbox.benefit_reservations AS reservation
    WHERE reservation.tenant_id = $1::uuid AND reservation.store_id = $2::uuid`
}

function reservationReturningSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}id, ${prefix}benefit_id, ${prefix}customer_id, ${prefix}table_session_id,
    ${prefix}quantity, ${prefix}status, ${prefix}reservation_idempotency_key,
    ${prefix}reservation_fingerprint, ${prefix}reserved_at::text, ${prefix}expires_at::text,
    ${prefix}completed_at::text, ${prefix}cancel_reason`
}

function redemptionSelectSql(): string {
  return `SELECT ${redemptionReturningSql('redemption')}
    FROM mbox.benefit_redemptions AS redemption
    WHERE redemption.tenant_id = $1::uuid AND redemption.store_id = $2::uuid`
}

function redemptionReturningSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}id, ${prefix}benefit_id, ${prefix}benefit_reservation_id,
    ${prefix}customer_id, ${prefix}table_session_id, ${prefix}quantity,
    ${prefix}gift_order_reference, ${prefix}authorization_source, ${prefix}redeemed_at::text`
}

function mapBenefit(row: BenefitRow): Benefit {
  return {
    id: row.id,
    customerId: row.customer_id,
    benefitCode: row.benefit_code,
    benefitType: row.benefit_type,
    status: row.status,
    valueAmountMinor: row.value_amount_minor === null ? null : Number(row.value_amount_minor),
    currency: row.currency,
    benefitSnapshot: row.benefit_snapshot,
    quantityTotal: row.quantity_total,
    quantityReserved: row.quantity_reserved,
    quantityRedeemed: row.quantity_redeemed,
    quantityAvailable: row.quantity_total - row.quantity_reserved - row.quantity_redeemed,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    issuedByEmployeeId: row.issued_by_employee_id,
    issuanceReason: row.issuance_reason,
    authorizationSource: row.authorization_source,
    authorizationLimitId: row.authorization_limit_id,
    redeemedAt: row.redeemed_at,
    aggregateVersion: Number(row.aggregate_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapReservation(row: ReservationRow): BenefitReservation {
  return {
    id: row.id,
    benefitId: row.benefit_id,
    customerId: row.customer_id,
    tableSessionId: row.table_session_id,
    quantity: row.quantity,
    status: row.status,
    reservedAt: row.reserved_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    cancelReason: row.cancel_reason,
  }
}

function mapRedemption(row: RedemptionRow): BenefitRedemption {
  return {
    id: row.id,
    benefitId: row.benefit_id,
    benefitReservationId: row.benefit_reservation_id,
    customerId: row.customer_id,
    tableSessionId: row.table_session_id,
    quantity: row.quantity,
    giftOrderReference: row.gift_order_reference,
    authorizationSource: row.authorization_source,
    redeemedAt: row.redeemed_at,
  }
}

function benefitToJson(value: Benefit): JsonObject { return { ...value } }
function reservationToJson(value: BenefitReservation): JsonObject { return { ...value } }
function redemptionToJson(value: BenefitRedemption): JsonObject { return { ...value } }

function decodeBenefit(value: unknown): Benefit {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.customerId !== 'string'
    || typeof value.quantityTotal !== 'number') throw new TypeError('Stored benefit result is invalid')
  return value as unknown as Benefit
}

function decodeReservation(value: unknown): BenefitReservation {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.tableSessionId !== 'string') {
    throw new TypeError('Stored benefit reservation result is invalid')
  }
  return value as unknown as BenefitReservation
}

function decodeRedemption(value: unknown): BenefitRedemption {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.benefitReservationId !== 'string') {
    throw new TypeError('Stored benefit redemption result is invalid')
  }
  return value as unknown as BenefitRedemption
}

function validateIssue(input: Readonly<IssueBenefitInput>): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(input.benefitCode)) {
    throw new TypeError('benefitCode is invalid')
  }
  validateCommandKeys(input.issuanceIdempotencyKey, input.issuanceFingerprint)
  validateMoney(input.valueAmountMinor, input.currency)
  validateQuantity(input.quantity ?? 1)
  const allowedProductIds = [...new Set(input.allowedProductIds ?? [])]
  if (allowedProductIds.some((productId) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId))) {
    throw new TypeError('allowedProductIds must contain UUID product ids')
  }
  if (input.benefitType === 'gift_product' && allowedProductIds.length === 0) {
    throw new TypeError('gift_product benefit requires allowedProductIds')
  }
  if (input.benefitType !== 'gift_product' && allowedProductIds.length > 0) {
    throw new TypeError('allowedProductIds is only valid for gift_product benefits')
  }
}

function validateReserve(input: Readonly<ReserveBenefitInput>): void {
  validateCommandKeys(input.reservationIdempotencyKey, input.reservationFingerprint)
  validateQuantity(input.quantity ?? 1)
  if (!Number.isFinite(Date.parse(input.expiresAt))) {
    throw new TypeError('expiresAt must be a valid timestamp')
  }
}

function validateRedeem(input: Readonly<RedeemBenefitInput>): void {
  validateCommandKeys(input.redemptionIdempotencyKey, input.redemptionFingerprint)
}

function validateCancel(input: Readonly<CancelBenefitReservationInput>): void {
  validateCommandKeys(input.cancellationIdempotencyKey, input.cancellationFingerprint)
  if (normalizeReason(input.reason) === null) throw new TypeError('Benefit cancellation reason is required')
}

function validateCommandKeys(key: string, fingerprint: string): void {
  if (key.length < 8 || key.length > 128 || fingerprint.length === 0) {
    throw new TypeError('Benefit idempotency fields are invalid')
  }
}

function validateMoney(amount: number | null | undefined, currency: string | null | undefined): void {
  if ((amount === null || amount === undefined) !== (currency === null || currency === undefined)) {
    throw new TypeError('valueAmountMinor and currency must be provided together')
  }
  if (amount !== null && amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) {
    throw new TypeError('valueAmountMinor must be a non-negative safe integer')
  }
  if (currency !== null && currency !== undefined && !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('currency must be a three-letter uppercase code')
  }
}

function validateQuantity(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError('quantity must be an integer between 1 and 10000')
  }
}

function normalizeReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const normalized = value.trim()
  return normalized.length === 0 ? null : normalized.slice(0, 256)
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rowCount: number | null; rows: Row[] },
  action: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${action} did not affect exactly one row`)
  return row
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
