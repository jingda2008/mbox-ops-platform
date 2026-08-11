import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type { ScopedTransaction, StoreScope } from './transaction-runner.js'

export type TableSessionStatus = 'open' | 'closing' | 'closed' | 'cancelled'

export type TableReference =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'code'; readonly value: string }

export interface VenueTable {
  id: string
  code: string
  displayName: string
  capacity: number
  status: 'available' | 'paused' | 'retired'
}

export interface TableSession {
  id: string
  tableId: string
  tableCode: string
  publicId: string
  businessDate: string
  guestCount: number
  capacityAtOpen: number
  capacityOverrideReason: string | null
  capacityOverriddenByEmployeeId: string | null
  guestProfileSnapshot: JsonObject
  status: TableSessionStatus
  openedByEmployeeId: string | null
  closedByEmployeeId: string | null
  openedAt: string
  closedAt: string | null
}

interface VenueTableRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  capacity: number
  status: VenueTable['status']
}

interface TableSessionRow extends Record<string, unknown> {
  id: string
  table_id: string
  table_code: string
  public_id: string
  business_date: string
  guest_count: number
  capacity_at_open: number
  capacity_override_reason: string | null
  capacity_overridden_by_employee_id: string | null
  guest_profile_snapshot: JsonObject
  status: TableSessionStatus
  opened_by_employee_id: string | null
  closed_by_employee_id: string | null
  opened_at: string
  closed_at: string | null
}

export interface OpenTableSessionInput {
  table: TableReference
  publicId: string
  businessDate: string
  guestCount: number
  capacityOverrideReason?: string | null
  guestProfileSnapshot?: JsonObject
  openedByEmployeeId?: string | null
}

export interface OpenTableSessionCommand extends OpenTableSessionInput {
  scope: Readonly<StoreScope>
  actor: AuditActor
  idempotencyKey: string
  requestFingerprint: string
}

export class TableNotFoundError extends Error {
  constructor(reference: TableReference) {
    super(`Table was not found by ${reference.kind}: ${reference.value}`)
    this.name = 'TableNotFoundError'
  }
}

export class TableUnavailableError extends Error {
  constructor(tableCode: string, status: VenueTable['status']) {
    super(`Table ${tableCode} is not available: ${status}`)
    this.name = 'TableUnavailableError'
  }
}

export class TableAlreadyOpenError extends Error {
  constructor(tableCode: string) {
    super(`Table ${tableCode} already has an active session`)
    this.name = 'TableAlreadyOpenError'
  }
}

export class TableSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Table session was not found: ${id}`)
    this.name = 'TableSessionNotFoundError'
  }
}

export class TableSessionTransitionError extends Error {
  constructor(id: string, from: TableSessionStatus, to: TableSessionStatus) {
    super(`Table session ${id} cannot transition from ${from} to ${to}`)
    this.name = 'TableSessionTransitionError'
  }
}

export class TableSessionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async findTable(reference: TableReference): Promise<VenueTable | null> {
    const result = await this.selectTable(reference, false)
    return result === null ? null : mapTable(result)
  }

  async findSessionById(id: string): Promise<TableSession | null> {
    return this.findSession('s.id = $3::uuid', id, false)
  }

  async findSessionByPublicId(publicId: string): Promise<TableSession | null> {
    return this.findSession('s.public_id = $3', publicId, false)
  }

  async open(input: Readonly<OpenTableSessionInput>): Promise<TableSession> {
    validateOpenInput(input)
    const tableRow = await this.selectTable(input.table, true)
    if (tableRow === null) throw new TableNotFoundError(input.table)
    if (tableRow.status !== 'available') {
      throw new TableUnavailableError(tableRow.code, tableRow.status)
    }

    // Locking the one target table serializes competing opens for that table only.
    const active = await this.transaction.query<{ id: string }>(`
      SELECT id
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_id = $3::uuid
        AND status IN ('open', 'closing')
      LIMIT 1
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, tableRow.id])
    if (active.rowCount !== 0) throw new TableAlreadyOpenError(tableRow.code)

    const extraSeatCount = Math.max(0, input.guestCount - tableRow.capacity)
    const capacityOverrideReason = normalizeCapacityOverrideReason(input.capacityOverrideReason)
    if (extraSeatCount > 0 && (capacityOverrideReason === null || input.openedByEmployeeId == null)) {
      throw new TypeError('超过桌台容量时必须填写加座原因并记录操作员工')
    }
    if (extraSeatCount === 0 && capacityOverrideReason !== null) {
      throw new TypeError('人数未超过桌台容量时不能填写加座原因')
    }
    const guestProfileSnapshot: JsonObject = {
      ...(input.guestProfileSnapshot ?? {}),
      extraSeatCount,
    }
    const inserted = await this.transaction.query<TableSessionRow>(`
      INSERT INTO mbox.table_sessions (
        tenant_id, store_id, table_id, public_id, business_date,
        guest_count, capacity_at_open, capacity_override_reason,
        capacity_overridden_by_employee_id, guest_profile_snapshot, status,
        opened_by_employee_id
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::date,
        $6, $7, $8, $9::uuid, $10::jsonb, 'open', $11::uuid
      )
      RETURNING id, table_id, $12::text AS table_code, public_id,
        business_date::text, guest_count, capacity_at_open,
        capacity_override_reason, capacity_overridden_by_employee_id,
        guest_profile_snapshot, status,
        opened_by_employee_id, closed_by_employee_id,
        opened_at::text, closed_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableRow.id,
      input.publicId,
      input.businessDate,
      input.guestCount,
      tableRow.capacity,
      capacityOverrideReason,
      extraSeatCount > 0 ? input.openedByEmployeeId : null,
      JSON.stringify(guestProfileSnapshot),
      input.openedByEmployeeId ?? null,
      tableRow.code,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new Error('Opening a table did not create exactly one session')
    }
    return mapSession(row)
  }

  beginClosing(id: string, closedByEmployeeId: string): Promise<TableSession> {
    return this.transition(id, 'open', 'closing', closedByEmployeeId)
  }

  completeClosing(id: string, closedByEmployeeId: string): Promise<TableSession> {
    return this.transition(id, 'closing', 'closed', closedByEmployeeId)
  }

  cancelOpenSession(id: string, employeeId: string): Promise<TableSession> {
    return this.transition(id, 'open', 'cancelled', employeeId)
  }

  private async transition(
    id: string,
    expectedStatus: TableSessionStatus,
    targetStatus: 'closing' | 'closed' | 'cancelled',
    employeeId: string,
  ): Promise<TableSession> {
    const current = await this.findSession('s.id = $3::uuid', id, true)
    if (current === null) throw new TableSessionNotFoundError(id)
    if (current.status !== expectedStatus) {
      throw new TableSessionTransitionError(id, current.status, targetStatus)
    }

    const terminal = targetStatus === 'closed' || targetStatus === 'cancelled'
    const updated = await this.transaction.query<TableSessionRow>(`
      UPDATE mbox.table_sessions AS s
      SET status = $4,
          closed_by_employee_id = $5::uuid,
          closed_at = CASE WHEN $6::boolean THEN clock_timestamp() ELSE NULL END
      FROM mbox.tables AS t
      WHERE s.tenant_id = $1::uuid
        AND s.store_id = $2::uuid
        AND s.id = $3::uuid
        AND s.status = $7
        AND t.tenant_id = s.tenant_id
        AND t.store_id = s.store_id
        AND t.id = s.table_id
      RETURNING s.id, s.table_id, t.code AS table_code, s.public_id,
        s.business_date::text, s.guest_count, s.guest_profile_snapshot, s.status,
        s.opened_by_employee_id, s.closed_by_employee_id,
        s.opened_at::text, s.closed_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      id,
      targetStatus,
      employeeId,
      terminal,
      expectedStatus,
    ])
    const row = updated.rows[0]
    if (updated.rowCount !== 1 || row === undefined) {
      throw new TableSessionTransitionError(id, expectedStatus, targetStatus)
    }
    return mapSession(row)
  }

  private async selectTable(
    reference: TableReference,
    forUpdate: boolean,
  ): Promise<VenueTableRow | null> {
    const predicate = reference.kind === 'id' ? 'id = $3::uuid' : 'code = $3'
    const lock = forUpdate ? 'FOR UPDATE' : ''
    const result = await this.transaction.query<VenueTableRow>(`
      SELECT id, code, display_name, capacity, status
      FROM mbox.tables
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND ${predicate}
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, reference.value])
    return result.rows[0] ?? null
  }

  private async findSession(
    predicate: string,
    value: string,
    forUpdate: boolean,
  ): Promise<TableSession | null> {
    const lock = forUpdate ? 'FOR UPDATE OF s' : ''
    const result = await this.transaction.query<TableSessionRow>(`
      SELECT s.id, s.table_id, t.code AS table_code, s.public_id,
        s.business_date::text, s.guest_count, s.capacity_at_open,
        s.capacity_override_reason, s.capacity_overridden_by_employee_id,
        s.guest_profile_snapshot, s.status,
        s.opened_by_employee_id, s.closed_by_employee_id,
        s.opened_at::text, s.closed_at::text
      FROM mbox.table_sessions AS s
      JOIN mbox.tables AS t
        ON t.tenant_id = s.tenant_id
       AND t.store_id = s.store_id
       AND t.id = s.table_id
      WHERE s.tenant_id = $1::uuid
        AND s.store_id = $2::uuid
        AND ${predicate}
      ${lock}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, value])
    return result.rows[0] === undefined ? null : mapSession(result.rows[0])
  }
}

export class TableSessionCommandService {
  constructor(private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>) {}

  open(input: Readonly<OpenTableSessionCommand>): Promise<CommandExecution<TableSession>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'table-session.open',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: tableSessionCodec,
    }, async (transaction) => {
      const session = await new TableSessionRepository(transaction).open(input)
      return {
        result: session,
        auditEvents: [{
          actor: input.actor,
          action: 'table_session.opened',
          objectType: 'table_session',
          objectId: session.id,
          businessDate: input.businessDate,
          afterData: tableSessionToJson(session),
        }],
        outboxMessages: [{
          aggregateType: 'table_session',
          aggregateId: session.id,
          aggregateVersion: 1,
          eventType: 'table_session.opened.v1',
          payload: tableSessionToJson(session),
        }],
      }
    })
  }
}

const tableSessionCodec: JsonCodec<TableSession> = {
  encode: tableSessionToJson,
  decode: (value) => {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('Stored table session result is invalid')
    }
    const row = value as Partial<TableSession>
    if (typeof row.id !== 'string' || typeof row.tableId !== 'string'
      || typeof row.tableCode !== 'string' || typeof row.publicId !== 'string'
      || typeof row.businessDate !== 'string' || typeof row.guestCount !== 'number'
      || typeof row.status !== 'string' || typeof row.openedAt !== 'string') {
      throw new TypeError('Stored table session result is incomplete')
    }
    return row as TableSession
  },
}

function mapTable(row: VenueTableRow): VenueTable {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    capacity: row.capacity,
    status: row.status,
  }
}

function mapSession(row: TableSessionRow): TableSession {
  return {
    id: row.id,
    tableId: row.table_id,
    tableCode: row.table_code,
    publicId: row.public_id,
    businessDate: row.business_date,
    guestCount: row.guest_count,
    capacityAtOpen: row.capacity_at_open,
    capacityOverrideReason: row.capacity_override_reason,
    capacityOverriddenByEmployeeId: row.capacity_overridden_by_employee_id,
    guestProfileSnapshot: row.guest_profile_snapshot,
    status: row.status,
    openedByEmployeeId: row.opened_by_employee_id,
    closedByEmployeeId: row.closed_by_employee_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  }
}

function tableSessionToJson(session: TableSession): JsonObject {
  return {
    id: session.id,
    tableId: session.tableId,
    tableCode: session.tableCode,
    publicId: session.publicId,
    businessDate: session.businessDate,
    guestCount: session.guestCount,
    capacityAtOpen: session.capacityAtOpen,
    capacityOverrideReason: session.capacityOverrideReason,
    capacityOverriddenByEmployeeId: session.capacityOverriddenByEmployeeId,
    guestProfileSnapshot: session.guestProfileSnapshot,
    status: session.status,
    openedByEmployeeId: session.openedByEmployeeId,
    closedByEmployeeId: session.closedByEmployeeId,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  }
}

function validateOpenInput(input: Readonly<OpenTableSessionInput>): void {
  if (input.table.value.trim().length === 0) throw new TypeError('table reference must not be blank')
  if (input.publicId.length < 8 || input.publicId.length > 128) {
    throw new TypeError('publicId must contain between 8 and 128 characters')
  }
  if (!Number.isInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 200) {
    throw new TypeError('guestCount must be an integer between 1 and 200')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new TypeError('businessDate must use YYYY-MM-DD')
  }
}

function normalizeCapacityOverrideReason(value: string | null | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim()
  if (normalized.length < 2 || normalized.length > 1_000) {
    throw new TypeError('加座原因长度必须在2到1000个字符之间')
  }
  return normalized
}
