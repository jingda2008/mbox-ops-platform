import type { JsonObject } from './command-executor.js'
import { PerformerRepository } from './performer-repository.js'
import { ScheduleRepository } from './schedule-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export type SongRequestType = 'catalog' | 'custom'
export type SongRequestStatus =
  | 'requested'
  | 'confirming'
  | 'accepted'
  | 'rejected'
  | 'paid'
  | 'performed'
  | 'cancelled'

export interface SongRequest {
  id: string
  tableSessionId: string
  performerId: string
  scheduleId: string
  customerId: string | null
  songTitle: string
  requestType: SongRequestType
  status: SongRequestStatus
  quotedAmountMinor: number | null
  currency: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface SubmitSongRequestInput {
  tableSessionId: string
  scheduleId: string
  customerId?: string | null
  songTitle: string
  requestType: SongRequestType
  note?: string | null
  requestedAt?: string
  requestExtension?: boolean
  businessDate: string
}

export interface SongRequestSubmission {
  request: SongRequest
  slot: 'current' | 'next'
  extensionRequested: boolean
  requiresStaffConfirmation: boolean
}

export interface ConfirmSongRequestInput {
  requestId: string
  actorEmployeeId: string
  quotedAmountMinor: number
  currency: string
}

export interface MarkSongRequestPaidInput {
  requestId: string
  actorEmployeeId: string
  paymentId: string
  reconciliationEntryId: string
}

export interface SongRequestMutationResult {
  request: SongRequest
  changed: boolean
}

interface SongRequestRow extends Record<string, unknown> {
  id: string
  table_session_id: string
  performer_id: string
  schedule_id: string
  customer_id: string | null
  song_title: string
  request_type: SongRequestType
  status: SongRequestStatus
  quoted_amount_minor: string | number | null
  currency: string | null
  note: string | null
  created_at: string
  updated_at: string
}

const REQUEST_COLUMNS = `
  id, table_session_id, performer_id, schedule_id, customer_id,
  song_title, request_type, status, quoted_amount_minor, currency, note,
  created_at::text, updated_at::text
`

export class SongRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Song request was not found: ${id}`)
    this.name = 'SongRequestNotFoundError'
  }
}

export class SongRequestEligibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SongRequestEligibilityError'
  }
}

export class SongRequestTransitionError extends Error {
  constructor(id: string, from: SongRequestStatus, to: SongRequestStatus) {
    super(`Song request ${id} cannot transition from ${from} to ${to}`)
    this.name = 'SongRequestTransitionError'
  }
}

export class SongRequestCustomerSessionError extends SongRequestEligibilityError {
  constructor() {
    super('客户与当前桌次不匹配')
    this.name = 'SongRequestCustomerSessionError'
  }
}

export class SongRequestPaymentEvidenceError extends Error {
  constructor(message = '点歌付款凭证无效或金额不一致') {
    super(message)
    this.name = 'SongRequestPaymentEvidenceError'
  }
}

export class SongRequestRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findById(id: string, forUpdate = false): Promise<SongRequest | null> {
    const lock = forUpdate ? 'FOR UPDATE' : ''
    const result = await this.transaction.query<SongRequestRow>(`
      SELECT ${REQUEST_COLUMNS}
      FROM mbox.song_requests
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, id])
    return result.rows[0] === undefined ? null : mapSongRequest(result.rows[0])
  }

  async submit(input: Readonly<SubmitSongRequestInput>): Promise<SongRequestSubmission> {
    validateSubmit(input)
    const at = input.requestedAt ?? new Date().toISOString()
    const session = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'open'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.tableSessionId])
    if (session.rowCount !== 1) {
      throw new SongRequestEligibilityError('Song requests require an open table session')
    }
    if (input.customerId === undefined || input.customerId === null) {
      throw new SongRequestCustomerSessionError()
    }
    const customerLink = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.table_session_customers
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND table_session_id = $3::uuid AND customer_id = $4::uuid
      FOR KEY SHARE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      input.customerId,
    ])
    if (customerLink.rowCount !== 1) throw new SongRequestCustomerSessionError()

    const schedules = new ScheduleRepository(this.transaction)
    const target = await schedules.findById(input.scheduleId, true)
    if (target === null || target.status === 'cancelled' || target.status === 'completed') {
      throw new SongRequestEligibilityError('The selected performance slot is unavailable')
    }
    const daily = await schedules.getDailyView(input.businessDate, at)
    const slot = daily.current?.id === target.id
      ? 'current'
      : daily.next?.id === target.id
        ? 'next'
        : null
    if (slot === null) {
      throw new SongRequestEligibilityError('Song requests are limited to today\'s current or next performer')
    }
    if (input.requestExtension === true && slot !== 'current') {
      throw new SongRequestEligibilityError('An extension can only be requested from the current performer')
    }

    const performer = await new PerformerRepository(this.transaction).findById(target.performerId)
    if (performer === null || performer.status !== 'active') {
      throw new SongRequestEligibilityError('The selected performer is unavailable')
    }
    const canonicalTitle = input.requestType === 'catalog'
      ? findCatalogTitle(performer.songCatalog, input.songTitle)
      : input.songTitle.trim()
    if (canonicalTitle === null) {
      throw new SongRequestEligibilityError('The song is not in the selected performer\'s available catalog')
    }

    const needsConfirmation = input.requestType === 'custom' || input.requestExtension === true
    const inserted = await this.transaction.query<SongRequestRow>(`
      INSERT INTO mbox.song_requests (
        tenant_id, store_id, table_session_id, performer_id, schedule_id, customer_id,
        song_title, request_type, status, note
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
        $7, $8, $9, $10
      )
      RETURNING ${REQUEST_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tableSessionId,
      target.performerId,
      target.id,
      input.customerId ?? null,
      canonicalTitle,
      input.requestType,
      needsConfirmation ? 'confirming' : 'requested',
      input.note?.trim() || null,
    ])
    return {
      request: mapSongRequest(requireOne(inserted, 'song request insert')),
      slot,
      extensionRequested: input.requestExtension === true,
      requiresStaffConfirmation: true,
    }
  }

  async confirm(input: Readonly<ConfirmSongRequestInput>): Promise<SongRequest> {
    return (await this.confirmWithResult(input)).request
  }

  async confirmWithResult(
    input: Readonly<ConfirmSongRequestInput>,
  ): Promise<SongRequestMutationResult> {
    validateConfirm(input)
    await this.requireActiveEmployee(input.actorEmployeeId)
    const current = await this.requireLocked(input.requestId)
    if (current.status === 'accepted') {
      if (current.quotedAmountMinor === input.quotedAmountMinor && current.currency === input.currency) {
        return { request: current, changed: false }
      }
      throw new SongRequestTransitionError(current.id, current.status, 'accepted')
    }
    if (!['requested', 'confirming'].includes(current.status)) {
      throw new SongRequestTransitionError(current.id, current.status, 'accepted')
    }
    return {
      request: await this.updateStatus(
        current.id,
        current.status,
        'accepted',
        input.quotedAmountMinor,
        input.currency,
      ),
      changed: true,
    }
  }

  async reject(requestId: string, actorEmployeeId: string): Promise<SongRequest> {
    await this.requireActiveEmployee(actorEmployeeId)
    return this.transition(requestId, ['requested', 'confirming'], 'rejected')
  }

  async markPaid(input: Readonly<MarkSongRequestPaidInput>): Promise<SongRequest> {
    await this.requireActiveEmployee(input.actorEmployeeId)
    const current = await this.requireLocked(input.requestId)
    if (current.status === 'paid') {
      const existing = await this.transaction.query<{ payment_id: string; reconciliation_entry_id: string }>(`
        SELECT payment_id, reconciliation_entry_id
        FROM mbox.song_request_payment_evidence
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND song_request_id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, input.requestId])
      const evidence = existing.rows[0]
      if (
        existing.rowCount === 1
        && evidence?.payment_id === input.paymentId
        && evidence.reconciliation_entry_id === input.reconciliationEntryId
      ) return current
      throw new SongRequestPaymentEvidenceError('该点歌请求已绑定其他付款凭证')
    }
    if (current.status !== 'accepted' || current.quotedAmountMinor === null || current.currency === null) {
      throw new SongRequestTransitionError(current.id, current.status, 'paid')
    }
    const verified = await this.transaction.query<{ payment_id: string }>(`
      SELECT payment.id AS payment_id
      FROM mbox.payments AS payment
      JOIN mbox.orders AS customer_order
        ON customer_order.tenant_id = payment.tenant_id
        AND customer_order.store_id = payment.store_id
        AND customer_order.id = payment.order_id
      JOIN mbox.table_sessions AS table_session
        ON table_session.tenant_id = customer_order.tenant_id
        AND table_session.store_id = customer_order.store_id
        AND table_session.id = customer_order.table_session_id
      JOIN mbox.reconciliation_entries AS reconciliation
        ON reconciliation.tenant_id = payment.tenant_id
        AND reconciliation.store_id = payment.store_id
        AND reconciliation.payment_id = payment.id
      WHERE payment.tenant_id = $1::uuid AND payment.store_id = $2::uuid
        AND payment.id = $3::uuid
        AND reconciliation.id = $4::uuid
        AND customer_order.table_session_id = $7::uuid
        AND reconciliation.business_date = table_session.business_date
        AND payment.status IN ('succeeded', 'partially_refunded')
        AND reconciliation.entry_type = 'payment'
        AND payment.amount_minor = $5::bigint
        AND reconciliation.amount_minor = $5::bigint
        AND payment.currency = $6
        AND reconciliation.currency = $6
      FOR KEY SHARE OF payment
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.paymentId,
      input.reconciliationEntryId,
      current.quotedAmountMinor,
      current.currency,
      current.tableSessionId,
    ])
    if (verified.rowCount !== 1) throw new SongRequestPaymentEvidenceError()
    const evidence = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.song_request_payment_evidence (
        tenant_id, store_id, song_request_id, payment_id,
        reconciliation_entry_id, recorded_by_employee_id
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)
      ON CONFLICT (tenant_id, store_id, song_request_id) DO NOTHING
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      current.id,
      input.paymentId,
      input.reconciliationEntryId,
      input.actorEmployeeId,
    ])
    if (evidence.rowCount !== 1) throw new SongRequestPaymentEvidenceError('点歌付款凭证已被占用')
    return this.updateStatus(current.id, 'accepted', 'paid', current.quotedAmountMinor, current.currency)
  }

  async markPerformed(requestId: string, actorEmployeeId: string): Promise<SongRequest> {
    await this.requireActiveEmployee(actorEmployeeId)
    const current = await this.requireLocked(requestId)
    const allowed = current.status === 'paid'
      || (current.status === 'accepted' && current.quotedAmountMinor === 0)
    if (!allowed) throw new SongRequestTransitionError(current.id, current.status, 'performed')
    return this.updateStatus(
      current.id,
      current.status,
      'performed',
      current.quotedAmountMinor,
      current.currency,
    )
  }

  cancel(requestId: string): Promise<SongRequest> {
    return this.transition(requestId, ['requested', 'confirming', 'accepted'], 'cancelled')
  }

  private async transition(
    requestId: string,
    allowedFrom: readonly SongRequestStatus[],
    target: SongRequestStatus,
  ): Promise<SongRequest> {
    const current = await this.requireLocked(requestId)
    if (current.status === target) return current
    if (!allowedFrom.includes(current.status)) {
      throw new SongRequestTransitionError(current.id, current.status, target)
    }
    return this.updateStatus(
      current.id,
      current.status,
      target,
      current.quotedAmountMinor,
      current.currency,
    )
  }

  private async updateStatus(
    requestId: string,
    from: SongRequestStatus,
    target: SongRequestStatus,
    amount: number | null,
    currency: string | null,
  ): Promise<SongRequest> {
    const updated = await this.transaction.query<SongRequestRow>(`
      UPDATE mbox.song_requests
      SET status = $4, quoted_amount_minor = $5::bigint, currency = $6
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = $7
      RETURNING ${REQUEST_COLUMNS}
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      requestId,
      target,
      amount,
      currency,
      from,
    ])
    return mapSongRequest(requireOne(updated, 'song request transition'))
  }

  private async requireLocked(id: string): Promise<SongRequest> {
    const request = await this.findById(id, true)
    if (request === null) throw new SongRequestNotFoundError(id)
    return request
  }

  private async requireActiveEmployee(employeeId: string): Promise<void> {
    const employee = await this.transaction.query<{ id: string }>(`
      SELECT id FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'active'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId])
    if (employee.rowCount !== 1) throw new Error(`Active employee was not found: ${employeeId}`)
  }
}

function findCatalogTitle(catalog: readonly JsonObject[], requestedTitle: string): string | null {
  const expected = normalizeSongName(requestedTitle)
  for (const song of catalog) {
    if (song.available === false) continue
    const title = song.title
    if (typeof title !== 'string') continue
    const aliases = Array.isArray(song.aliases)
      ? song.aliases.filter((alias): alias is string => typeof alias === 'string')
      : []
    if ([title, ...aliases].some((candidate) => normalizeSongName(candidate) === expected)) {
      return title.trim()
    }
  }
  return null
}

function normalizeSongName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function validateSubmit(input: Readonly<SubmitSongRequestInput>): void {
  if (input.tableSessionId.trim().length === 0) throw new TypeError('tableSessionId must not be blank')
  if (input.scheduleId.trim().length === 0) throw new TypeError('scheduleId must not be blank')
  if (input.songTitle.trim().length === 0) throw new TypeError('songTitle must not be blank')
  if (input.requestedAt !== undefined && !Number.isFinite(Date.parse(input.requestedAt))) {
    throw new TypeError('requestedAt must be an ISO timestamp')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('businessDate must be YYYY-MM-DD')
  }
}

function validateConfirm(input: Readonly<ConfirmSongRequestInput>): void {
  if (input.requestId.trim().length === 0) throw new TypeError('requestId must not be blank')
  if (input.actorEmployeeId.trim().length === 0) throw new TypeError('actorEmployeeId must not be blank')
  if (!Number.isSafeInteger(input.quotedAmountMinor) || input.quotedAmountMinor < 0) {
    throw new TypeError('quotedAmountMinor must be a non-negative safe integer')
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new TypeError('currency must be an ISO 4217 code')
}

function mapSongRequest(row: SongRequestRow): SongRequest {
  return {
    id: row.id,
    tableSessionId: row.table_session_id,
    performerId: row.performer_id,
    scheduleId: row.schedule_id,
    customerId: row.customer_id,
    songTitle: row.song_title,
    requestType: row.request_type,
    status: row.status,
    quotedAmountMinor: row.quoted_amount_minor === null ? null : Number(row.quoted_amount_minor),
    currency: row.currency,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requireOne<Row extends Record<string, unknown>>(
  result: { rows: Row[]; rowCount: number | null },
  action: string,
): Row {
  const row = result.rows[0]
  if (result.rowCount !== 1 || row === undefined) throw new Error(`${action} did not affect exactly one row`)
  return row
}
