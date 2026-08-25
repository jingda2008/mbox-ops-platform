import type { JsonObject } from './command-executor.js'
import type { ScopedTransaction } from './transaction-runner.js'
import { expireReservationHold } from './reservation-hold-expiry.js'

export type ReservationStatus =
  | 'pending'
  | 'confirmed'
  | 'arrived'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'no_show'
export type ReservationSource = 'wechat' | 'phone' | 'walk_in' | 'employee' | 'integration'
export type ReservationLockStatus = 'held' | 'confirmed' | 'released' | 'expired' | 'cancelled'
export type ReservationSeatPreference =
  | 'no_preference'
  | 'stage_atmosphere'
  | 'quiet_chat'
  | 'comfortable_booth'
  | 'outdoor_view'

export interface ReservationTableLock {
  id: string
  reservationId: string
  tableId: string
  startsAt: string
  endsAt: string
  status: ReservationLockStatus
  holdExpiresAt: string | null
  tableCode: string
  tableDisplayName: string
}

export interface Reservation {
  id: string
  publicId: string
  customerId: string | null
  customerName: string
  contactToken: string
  guestCount: number
  arrivalAt: string
  expectedEndAt: string
  status: ReservationStatus
  source: ReservationSource
  ownerEmployeeId: string | null
  note: string | null
  seatPreference: ReservationSeatPreference
  reservationSnapshot: JsonObject
  createdAt: string
  updatedAt: string
  aggregateVersion: number
  customerCancelUntil: string | null
  cancellationPolicySnapshot: JsonObject
  requestHoldExpiresAt: string | null
  arrivalGraceEndsAt: string
  reservationPolicyVersion: number
  reservationPolicyAcknowledgedVersion: number
  preferredScheduleId: string | null
  annualPriorityRuleId?: string | null
  annualPriorityHoldMinutes?: number | null
  tableLocks: ReservationTableLock[]
}

export interface CreateReservationInput {
  publicId: string
  customerId?: string | null
  customerName: string
  contactToken: string
  guestCount: number
  arrivalAt: string
  expectedEndAt: string
  source: ReservationSource
  ownerEmployeeId?: string | null
  note?: string | null
  seatPreference?: ReservationSeatPreference
  reservationSnapshot?: JsonObject
  tableIds: readonly string[]
  allowUnassignedTable?: boolean
  initialStatus?: 'pending' | 'confirmed'
  holdExpiresAt?: string | null
  customerCancelUntil?: string | null
  cancellationPolicySnapshot?: JsonObject
  requestHoldExpiresAt?: string | null
  arrivalGraceEndsAt: string
  reservationPolicyVersion: number
  reservationPolicyAcknowledgedVersion?: number
  preferredScheduleId?: string | null
  annualPriorityRuleId?: string | null
  annualPriorityHoldMinutes?: number | null
}

export interface ReservationMutationResult {
  reservation: Reservation
  changed: boolean
}

interface ReservationRow extends Record<string, unknown> {
  id: string
  public_id: string
  customer_id: string | null
  customer_name: string
  contact_token: string
  guest_count: number
  arrival_at: string
  expected_end_at: string
  status: ReservationStatus
  source: ReservationSource
  owner_employee_id: string | null
  note: string | null
  seat_preference: ReservationSeatPreference
  reservation_snapshot: JsonObject
  created_at: string
  updated_at: string
  aggregate_version: string | number
  customer_cancel_until: string | null
  cancellation_policy_snapshot: JsonObject
  request_hold_expires_at: string | null
  arrival_grace_ends_at: string
  reservation_policy_version: string | number
  reservation_policy_acknowledged_version: string | number
  preferred_schedule_id: string | null
  annual_priority_rule_id: string | null
  annual_priority_hold_minutes: number | null
}

interface ReservationLockRow extends Record<string, unknown> {
  id: string
  reservation_id: string
  table_id: string
  starts_at: string
  ends_at: string
  status: ReservationLockStatus
  hold_expires_at: string | null
  table_code: string
  table_display_name: string
}

export class ReservationNotFoundError extends Error {
  constructor(id: string) {
    super(`Reservation was not found: ${id}`)
    this.name = 'ReservationNotFoundError'
  }
}

export class ReservationConflictError extends Error {
  constructor() {
    super('One or more selected tables are already reserved during this time')
    this.name = 'ReservationConflictError'
  }
}

export class ReservationTransitionError extends Error {
  constructor(id: string, from: ReservationStatus, to: ReservationStatus) {
    super(`Reservation ${id} cannot transition from ${from} to ${to}`)
    this.name = 'ReservationTransitionError'
  }
}

export class ReservationLockUnavailableError extends Error {
  constructor(id: string) {
    super(`Reservation ${id} no longer owns every required table lock`)
    this.name = 'ReservationLockUnavailableError'
  }
}

export class ReservationHoldExpiredError extends Error {
  constructor() {
    super('Reservation hold must expire in the future')
    this.name = 'ReservationHoldExpiredError'
  }
}

export class ReservationTableUnavailableError extends Error {
  constructor() {
    super('One or more reservation tables were not found or are unavailable')
    this.name = 'ReservationTableUnavailableError'
  }
}

export class ReservationCustomerNotFoundError extends Error {
  constructor() {
    super('Reservation customer was not found')
    this.name = 'ReservationCustomerNotFoundError'
  }
}

export class ReservationCancellationPolicyError extends Error {
  constructor(readonly reason: 'cutoff' | 'paid_deposit') {
    super(reason === 'paid_deposit'
      ? 'A paid reservation deposit requires staff exception handling'
      : 'The customer cancellation cutoff has passed')
    this.name = 'ReservationCancellationPolicyError'
  }
}

export class ReservationRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string): Promise<Reservation | null> {
    const row = await this.selectReservation('r.id = $3::uuid', id, false)
    return row === null ? null : this.hydrate(row)
  }

  async findByPublicId(publicId: string): Promise<Reservation | null> {
    const row = await this.selectReservation('r.public_id = $3', publicId, false)
    return row === null ? null : this.hydrate(row)
  }

  async create(input: Readonly<CreateReservationInput>): Promise<Reservation> {
    validateCreateReservation(input)
    const tableIds = [...new Set(input.tableIds)].sort()
    if (tableIds.length > 0) {
      const existingTables = await this.transaction.query<{ id: string }>(`
        SELECT id
        FROM mbox.tables
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND id = ANY($3::uuid[]) AND status = 'available'
        ORDER BY id
        FOR UPDATE
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableIds])
      if (existingTables.rowCount !== tableIds.length) {
        throw new ReservationTableUnavailableError()
      }
      const expiredReservations = await this.transaction.query<{ id: string; public_id: string }>(`
        SELECT reservation.id, reservation.public_id
        FROM mbox.reservations AS reservation
        WHERE reservation.tenant_id = $1::uuid
          AND reservation.store_id = $2::uuid
          AND reservation.status = 'pending'
          AND EXISTS (
            SELECT 1 FROM mbox.reservation_table_locks AS table_lock
            WHERE table_lock.tenant_id = reservation.tenant_id
              AND table_lock.store_id = reservation.store_id
              AND table_lock.reservation_id = reservation.id
              AND table_lock.table_id = ANY($3::uuid[])
              AND table_lock.status = 'held'
              AND table_lock.hold_expires_at <= clock_timestamp()
          )
        ORDER BY reservation.id
        FOR UPDATE OF reservation
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableIds])
      for (const expired of expiredReservations.rows) {
        await expireReservationHold(this.transaction, {
          id: expired.id,
          publicId: expired.public_id,
        }, 'reservation-create-cleanup')
      }
    }
    if (input.customerId) {
      const customer = await this.transaction.query<{ id: string }>(`
        SELECT id FROM mbox.customers
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND status IN ('active', 'merged')
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.customerId])
      if (customer.rowCount !== 1) throw new ReservationCustomerNotFoundError()
    }

    const reservationSnapshot: JsonObject = input.reservationSnapshot ?? {}
    const requestHoldExpiresAt = input.requestHoldExpiresAt ?? input.holdExpiresAt ?? null
    const arrivalGraceEndsAt = input.arrivalGraceEndsAt
    const inserted = await this.transaction.query<ReservationRow>(`
      INSERT INTO mbox.reservations (
        tenant_id, store_id, public_id, customer_id, customer_name, contact_token, guest_count,
        arrival_at, expected_end_at, status, source, owner_employee_id, note,
        reservation_snapshot, customer_cancel_until, cancellation_policy_snapshot,
        request_hold_expires_at, arrival_grace_ends_at, reservation_policy_version,
        reservation_policy_acknowledged_version, preferred_schedule_id, seat_preference,
        annual_priority_rule_id, annual_priority_hold_minutes
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7,
        $8::timestamptz, $9::timestamptz, $10, $11, $12::uuid, $13, $14::jsonb,
        $15::timestamptz, $16::jsonb, $17::timestamptz, $18::timestamptz, $19::integer,
        $20::integer, $21::uuid, $22, $23::uuid, $24::smallint
      )
      RETURNING id, public_id, customer_id, customer_name, contact_token, guest_count,
        arrival_at::text, expected_end_at::text, status, source, owner_employee_id,
        note, reservation_snapshot, seat_preference, created_at::text, updated_at::text,
        aggregate_version, customer_cancel_until::text, cancellation_policy_snapshot,
        request_hold_expires_at::text, arrival_grace_ends_at::text, reservation_policy_version,
        reservation_policy_acknowledged_version, preferred_schedule_id,
        annual_priority_rule_id, annual_priority_hold_minutes
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.publicId,
      input.customerId ?? null,
      input.customerName.trim(),
      input.contactToken.trim(),
      input.guestCount,
      input.arrivalAt,
      input.expectedEndAt,
      input.initialStatus ?? 'pending',
      input.source,
      input.ownerEmployeeId ?? null,
      input.note?.trim() || null,
      JSON.stringify(reservationSnapshot),
      input.customerCancelUntil ?? null,
      JSON.stringify(input.cancellationPolicySnapshot ?? {}),
      requestHoldExpiresAt,
      arrivalGraceEndsAt,
      input.reservationPolicyVersion,
      input.reservationPolicyAcknowledgedVersion ?? input.reservationPolicyVersion ?? 1,
      input.preferredScheduleId ?? null,
      input.seatPreference ?? 'no_preference',
      input.annualPriorityRuleId ?? null,
      input.annualPriorityHoldMinutes ?? null,
    ])
    const reservationRow = inserted.rows[0]
    if (inserted.rowCount !== 1 || reservationRow === undefined) {
      throw new Error('Creating a reservation did not affect exactly one row')
    }

    const lockStatus: ReservationLockStatus = (input.initialStatus ?? 'pending') === 'confirmed'
      ? 'confirmed'
      : 'held'
    try {
      const lockRows = await this.transaction.query<ReservationLockRow>(`
        INSERT INTO mbox.reservation_table_locks (
          tenant_id, store_id, reservation_id, table_id, reserved_during,
          status, hold_expires_at
        )
        SELECT $1::uuid, $2::uuid, $3::uuid, table_id,
          tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6,
          CASE WHEN $6 = 'held' THEN $7::timestamptz ELSE NULL END
        FROM unnest($8::uuid[]) AS table_id
        WHERE $6 <> 'held' OR $7::timestamptz > clock_timestamp()
        RETURNING id, reservation_id, table_id,
          lower(reserved_during)::text AS starts_at,
          upper(reserved_during)::text AS ends_at,
          status, hold_expires_at::text
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        reservationRow.id,
        input.arrivalAt,
        input.expectedEndAt,
        lockStatus,
        input.holdExpiresAt ?? null,
        tableIds,
      ])
      if (lockRows.rowCount !== tableIds.length) {
        if (lockStatus === 'held') throw new ReservationHoldExpiredError()
        throw new Error('Reservation table locks were not all created')
      }
      return this.hydrate(reservationRow)
    } catch (error) {
      if (postgresErrorCode(error) === '23P01') throw new ReservationConflictError()
      throw error
    }
  }

  async confirm(id: string): Promise<Reservation> {
    return (await this.confirmWithResult(id)).reservation
  }

  confirmWithResult(id: string): Promise<ReservationMutationResult> {
    return this.transition(id, ['pending'], 'confirmed', 'confirmed')
  }

  async arrive(id: string): Promise<Reservation> {
    return (await this.arriveWithResult(id)).reservation
  }

  arriveWithResult(id: string): Promise<ReservationMutationResult> {
    return this.transition(id, ['pending', 'confirmed'], 'arrived', 'confirmed')
  }

  async complete(id: string): Promise<Reservation> {
    return (await this.completeWithResult(id)).reservation
  }

  completeWithResult(id: string): Promise<ReservationMutationResult> {
    return this.transition(id, ['arrived', 'seated'], 'completed', 'released')
  }

  async cancel(id: string, options: { overridePolicy?: boolean } = {}): Promise<Reservation> {
    return (await this.cancelWithResult(id, options)).reservation
  }

  cancelWithResult(
    id: string,
    options: { overridePolicy?: boolean } = {},
  ): Promise<ReservationMutationResult> {
    return this.transition(
      id,
      ['pending', 'confirmed'],
      'cancelled',
      'cancelled',
      options.overridePolicy === true,
    )
  }

  private async transition(
    id: string,
    allowedFrom: readonly ReservationStatus[],
    targetStatus: ReservationStatus,
    targetLockStatus: ReservationLockStatus,
    overrideCancellationPolicy = false,
  ): Promise<ReservationMutationResult> {
    const current = await this.selectReservation('r.id = $3::uuid', id, true)
    if (current === null) throw new ReservationNotFoundError(id)
    if (current.status === targetStatus) {
      return { reservation: await this.hydrate(current), changed: false }
    }
    if (!allowedFrom.includes(current.status)) {
      throw new ReservationTransitionError(id, current.status, targetStatus)
    }
    const currentWithLocks = await this.hydrate(current)
    if (targetStatus === 'cancelled' && !overrideCancellationPolicy) {
      const policyClock = await this.transaction.query<{ cutoff_passed: boolean }>(`
        SELECT customer_cancel_until IS NOT NULL
          AND customer_cancel_until <= clock_timestamp() AS cutoff_passed
        FROM mbox.reservations
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
      if (policyClock.rows[0]?.cutoff_passed === true) {
        throw new ReservationCancellationPolicyError('cutoff')
      }
      const deposits = await this.transaction.query<{ status: string }>(`
        SELECT payment.status
        FROM mbox.reservation_payments AS reservation_payment
        JOIN mbox.payments AS payment
          ON payment.tenant_id = reservation_payment.tenant_id
          AND payment.store_id = reservation_payment.store_id
          AND payment.id = reservation_payment.payment_id
        WHERE reservation_payment.tenant_id = $1::uuid
          AND reservation_payment.store_id = $2::uuid
          AND reservation_payment.reservation_id = $3::uuid
          AND reservation_payment.purpose = 'deposit'
        FOR SHARE OF payment
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
      if (deposits.rows.some((deposit) => (
        deposit.status === 'succeeded' || deposit.status === 'partially_refunded'
      ))) throw new ReservationCancellationPolicyError('paid_deposit')
    }
    if (targetLockStatus === 'confirmed') {
      const activeLocks = await this.transaction.query<{ id: string }>(`
        UPDATE mbox.reservation_table_locks
        SET status = 'confirmed', hold_expires_at = NULL
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND reservation_id = $3::uuid
          AND (
            status = 'confirmed'
            OR (status = 'held' AND hold_expires_at > clock_timestamp())
          )
        RETURNING id
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
      if (activeLocks.rowCount !== currentWithLocks.tableLocks.length) {
        throw new ReservationLockUnavailableError(id)
      }
    }
    const updated = await this.transaction.query<ReservationRow>(`
      UPDATE mbox.reservations
      SET status = $4,
          request_hold_expires_at = CASE WHEN $4='confirmed' THEN NULL ELSE request_hold_expires_at END,
          aggregate_version = aggregate_version + 1
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = ANY($5::text[])
      RETURNING id, public_id, customer_id, customer_name, contact_token, guest_count,
        arrival_at::text, expected_end_at::text, status, source, owner_employee_id,
        note, reservation_snapshot, seat_preference, created_at::text, updated_at::text,
        aggregate_version, customer_cancel_until::text, cancellation_policy_snapshot,
        request_hold_expires_at::text, arrival_grace_ends_at::text, reservation_policy_version,
        reservation_policy_acknowledged_version, preferred_schedule_id,
        annual_priority_rule_id, annual_priority_hold_minutes
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      id,
      targetStatus,
      allowedFrom,
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new ReservationTransitionError(id, current.status, targetStatus)
    }
    if (targetLockStatus !== 'confirmed') {
      await this.transaction.query(`
        UPDATE mbox.reservation_table_locks
        SET status = $4, hold_expires_at = NULL
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND reservation_id = $3::uuid AND status IN ('held', 'confirmed')
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id, targetLockStatus])
    }
    return { reservation: await this.hydrate(row), changed: true }
  }

  private async hydrate(row: ReservationRow): Promise<Reservation> {
    const locks = await this.transaction.query<ReservationLockRow>(`
      SELECT table_lock.id, table_lock.reservation_id, table_lock.table_id,
        lower(table_lock.reserved_during)::text AS starts_at,
        upper(table_lock.reserved_during)::text AS ends_at,
        table_lock.status, table_lock.hold_expires_at::text,
        venue_table.code AS table_code, venue_table.display_name AS table_display_name
      FROM mbox.reservation_table_locks AS table_lock
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id = table_lock.tenant_id
        AND venue_table.store_id = table_lock.store_id
        AND venue_table.id = table_lock.table_id
      WHERE table_lock.tenant_id = $1::uuid AND table_lock.store_id = $2::uuid
        AND table_lock.reservation_id = $3::uuid
      ORDER BY table_lock.table_id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id])
    return mapReservation(row, locks.rows)
  }

  private async selectReservation(
    predicate: string,
    value: string,
    forUpdate: boolean,
  ): Promise<ReservationRow | null> {
    const lock = forUpdate ? 'FOR UPDATE OF r' : ''
    const result = await this.transaction.query<ReservationRow>(`
      SELECT r.id, r.public_id, r.customer_id, r.customer_name, r.contact_token, r.guest_count,
        r.arrival_at::text, r.expected_end_at::text, r.status, r.source,
        r.owner_employee_id, r.note, r.reservation_snapshot, r.seat_preference,
        r.created_at::text, r.updated_at::text, r.aggregate_version,
        r.customer_cancel_until::text, r.cancellation_policy_snapshot,
        r.request_hold_expires_at::text, r.arrival_grace_ends_at::text,
        r.reservation_policy_version, r.reservation_policy_acknowledged_version,
        r.preferred_schedule_id, r.annual_priority_rule_id, r.annual_priority_hold_minutes
      FROM mbox.reservations AS r
      WHERE r.tenant_id = $1::uuid AND r.store_id = $2::uuid AND ${predicate}
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, value])
    return result.rows[0] ?? null
  }
}

function mapReservation(row: ReservationRow, locks: readonly ReservationLockRow[]): Reservation {
  return {
    id: row.id,
    publicId: row.public_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    contactToken: row.contact_token,
    guestCount: row.guest_count,
    arrivalAt: isoInstant(row.arrival_at),
    expectedEndAt: isoInstant(row.expected_end_at),
    status: row.status,
    source: row.source,
    ownerEmployeeId: row.owner_employee_id,
    note: row.note,
    seatPreference: row.seat_preference,
    reservationSnapshot: row.reservation_snapshot,
    createdAt: isoInstant(row.created_at),
    updatedAt: isoInstant(row.updated_at),
    aggregateVersion: Number(row.aggregate_version),
    customerCancelUntil: nullableIsoInstant(row.customer_cancel_until),
    cancellationPolicySnapshot: row.cancellation_policy_snapshot,
    requestHoldExpiresAt: nullableIsoInstant(row.request_hold_expires_at),
    arrivalGraceEndsAt: isoInstant(row.arrival_grace_ends_at),
    reservationPolicyVersion: Number(row.reservation_policy_version),
    reservationPolicyAcknowledgedVersion: Number(row.reservation_policy_acknowledged_version),
    preferredScheduleId: row.preferred_schedule_id,
    annualPriorityRuleId: row.annual_priority_rule_id,
    annualPriorityHoldMinutes: row.annual_priority_hold_minutes,
    tableLocks: locks.map((lock) => ({
      id: lock.id,
      reservationId: lock.reservation_id,
      tableId: lock.table_id,
      startsAt: isoInstant(lock.starts_at),
      endsAt: isoInstant(lock.ends_at),
      status: lock.status,
      holdExpiresAt: nullableIsoInstant(lock.hold_expires_at),
      tableCode: lock.table_code,
      tableDisplayName: lock.table_display_name,
    })),
  }
}

function isoInstant(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError('Reservation timestamp is invalid')
  return new Date(timestamp).toISOString()
}

function nullableIsoInstant(value: string | null): string | null {
  return value === null ? null : isoInstant(value)
}

function validateCreateReservation(input: Readonly<CreateReservationInput>): void {
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (input.customerName.trim().length === 0) throw new TypeError('customerName must not be blank')
  if (input.contactToken.trim().length === 0) throw new TypeError('contactToken must not be blank')
  if (!Number.isInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 200) {
    throw new TypeError('guestCount must be an integer between 1 and 200')
  }
  if (input.tableIds.length === 0 && input.allowUnassignedTable !== true) {
    throw new TypeError('at least one table is required unless the reservation is explicitly unassigned')
  }
  const startsAt = Date.parse(input.arrivalAt)
  const endsAt = Date.parse(input.expectedEndAt)
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    throw new TypeError('expectedEndAt must be after arrivalAt')
  }
  if ((input.initialStatus ?? 'pending') === 'pending') {
    const holdExpiresAt = Date.parse(input.holdExpiresAt ?? '')
    if (!Number.isFinite(holdExpiresAt)) throw new TypeError('pending reservation requires holdExpiresAt')
    if (holdExpiresAt > startsAt) throw new TypeError('holdExpiresAt must not be after arrivalAt')
  }
  const requestHoldExpiresAt = input.requestHoldExpiresAt ?? input.holdExpiresAt ?? null
  if (requestHoldExpiresAt !== null && (
    !Number.isFinite(Date.parse(requestHoldExpiresAt)) || Date.parse(requestHoldExpiresAt) > startsAt
  )) throw new TypeError('requestHoldExpiresAt must be a valid instant no later than arrivalAt')
  if (input.arrivalGraceEndsAt !== undefined && (
    !Number.isFinite(Date.parse(input.arrivalGraceEndsAt)) || Date.parse(input.arrivalGraceEndsAt) <= startsAt
  )) throw new TypeError('arrivalGraceEndsAt must be a valid instant after arrivalAt')
  if (input.reservationPolicyVersion !== undefined && (
    !Number.isSafeInteger(input.reservationPolicyVersion) || input.reservationPolicyVersion < 1
  )) throw new TypeError('reservationPolicyVersion must be a positive integer')
  if (
    input.customerCancelUntil !== undefined
    && input.customerCancelUntil !== null
    && (
      !Number.isFinite(Date.parse(input.customerCancelUntil))
      || Date.parse(input.customerCancelUntil) > startsAt
    )
  ) throw new TypeError('customerCancelUntil must be a valid instant no later than arrivalAt')
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
