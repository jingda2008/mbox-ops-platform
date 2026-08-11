import { createHash, randomBytes } from 'node:crypto'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export const ASSISTED_ORDER_CONTEXT_TTL_SECONDS = 15 * 60

export interface AssistedOrderActorBinding {
  employeeId: string
  staffSessionId: string
  deviceAccessLeaseId: string
}

export interface AssistedOrderContextProof extends AssistedOrderActorBinding {
  token: string
}

export interface AssistedOrderContext {
  id: string
  employeeId: string
  staffSessionId: string
  deviceAccessLeaseId: string
  tableSessionId: string
  tableId: string
  tableCode: string
  expiresAt: string
}

export interface IssuedAssistedOrderContext extends AssistedOrderContext {
  token: string
}

interface ContextRow extends Record<string, unknown> {
  id: string
  employee_id: string
  staff_session_id: string
  device_access_lease_id: string
  table_session_id: string
  table_id: string
  table_code: string
  expires_at: string
}

export class AssistedOrderContextDeniedError extends Error {
  constructor(public readonly code:
    | 'ASSISTED_CONTEXT_SESSION_INVALID'
    | 'ASSISTED_CONTEXT_TABLE_FORBIDDEN'
    | 'ASSISTED_CONTEXT_INVALID') {
    super(code === 'ASSISTED_CONTEXT_SESSION_INVALID'
      ? '当前员工会话或设备授权已经失效'
      : code === 'ASSISTED_CONTEXT_TABLE_FORBIDDEN'
        ? '当前员工未负责该桌台'
        : '协助点单授权无效或已经过期')
    this.name = 'AssistedOrderContextDeniedError'
  }
}

export class AssistedOrderContextRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async issue(input: Readonly<AssistedOrderActorBinding & {
    tableSessionId: string
    ttlSeconds?: number
  }>): Promise<IssuedAssistedOrderContext> {
    validateBinding(input)
    requireUuid('tableSessionId', input.tableSessionId)
    const ttlSeconds = input.ttlSeconds ?? ASSISTED_ORDER_CONTEXT_TTL_SECONDS
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 60) {
      throw new TypeError('assisted order context TTL must be between 60 and 1800 seconds')
    }
    await this.assertLiveAccess(input, input.tableSessionId)
    const token = randomBytes(32).toString('base64url')
    const inserted = await this.transaction.query<ContextRow>(`
      WITH inserted AS (
        INSERT INTO mbox.assisted_order_contexts (
          tenant_id, store_id, token_hash, employee_id, staff_session_id,
          device_access_lease_id, table_session_id, issued_at, expires_at
        )
        SELECT $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
          $6::uuid, session.id, clock_timestamp(),
          clock_timestamp() + ($8::integer * interval '1 second')
        FROM mbox.table_sessions AS session
        WHERE session.tenant_id = $1::uuid
          AND session.store_id = $2::uuid
          AND session.id = $7::uuid
          AND session.status = 'open'
        RETURNING id, tenant_id, store_id, employee_id, staff_session_id,
          device_access_lease_id, table_session_id, expires_at
      )
      SELECT inserted.id, inserted.employee_id, inserted.staff_session_id,
        inserted.device_access_lease_id, inserted.table_session_id,
        table_session.table_id, venue_table.code AS table_code,
        inserted.expires_at::text
      FROM inserted
      JOIN mbox.table_sessions AS table_session
        ON table_session.tenant_id = inserted.tenant_id
       AND table_session.store_id = inserted.store_id
       AND table_session.id = inserted.table_session_id
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      hashToken(token),
      input.employeeId,
      input.staffSessionId,
      input.deviceAccessLeaseId,
      input.tableSessionId,
      ttlSeconds,
    ])
    const row = inserted.rows[0]
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    return { ...mapContext(row), token }
  }

  async requireForSubmit(proof: Readonly<AssistedOrderContextProof>): Promise<AssistedOrderContext> {
    validateBinding(proof)
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(proof.token)) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    const selected = await this.transaction.query<ContextRow>(`
      UPDATE mbox.assisted_order_contexts AS context
      SET last_used_at = clock_timestamp(), use_count = context.use_count + 1
      FROM mbox.staff_sessions AS staff_session
      JOIN mbox.store_device_access_leases AS device_lease
        ON device_lease.tenant_id = staff_session.tenant_id
       AND device_lease.store_id = staff_session.store_id
       AND device_lease.id = staff_session.device_access_lease_id
      JOIN mbox.store_daily_credentials AS credential
        ON credential.tenant_id = device_lease.tenant_id
       AND credential.store_id = device_lease.store_id
       AND credential.id = device_lease.daily_credential_id
      JOIN mbox.employees AS employee
        ON employee.tenant_id = staff_session.tenant_id
       AND employee.store_id = staff_session.store_id
       AND employee.id = staff_session.employee_id
      CROSS JOIN mbox.table_sessions AS table_session
      JOIN mbox.tables AS venue_table
        ON venue_table.tenant_id = table_session.tenant_id
       AND venue_table.store_id = table_session.store_id
       AND venue_table.id = table_session.table_id
      WHERE context.tenant_id = $1::uuid
        AND context.store_id = $2::uuid
        AND context.token_hash = $3
        AND context.employee_id = $4::uuid
        AND context.staff_session_id = $5::uuid
        AND context.device_access_lease_id = $6::uuid
        AND context.revoked_at IS NULL
        AND context.expires_at > clock_timestamp()
        AND table_session.tenant_id = context.tenant_id
        AND table_session.store_id = context.store_id
        AND table_session.id = context.table_session_id
        AND staff_session.id = context.staff_session_id
        AND staff_session.employee_id = context.employee_id
        AND staff_session.device_access_lease_id = context.device_access_lease_id
        AND staff_session.revoked_at IS NULL
        AND staff_session.expires_at > clock_timestamp()
        AND staff_session.online_lease_until > clock_timestamp()
        AND device_lease.revoked_at IS NULL
        AND device_lease.expires_at > clock_timestamp()
        AND credential.revoked_at IS NULL
        AND credential.valid_from <= clock_timestamp()
        AND credential.valid_until > clock_timestamp()
        AND employee.status = 'active'
        AND table_session.status = 'open'
      RETURNING context.id, context.employee_id, context.staff_session_id,
        context.device_access_lease_id, context.table_session_id,
        table_session.table_id, venue_table.code AS table_code, context.expires_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      hashToken(proof.token),
      proof.employeeId,
      proof.staffSessionId,
      proof.deviceAccessLeaseId,
    ])
    const row = selected.rows[0]
    if (selected.rowCount !== 1 || row === undefined) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_INVALID')
    }
    await this.assertLiveAccess(proof, row.table_session_id)
    return mapContext(row)
  }

  private async assertLiveAccess(
    binding: Readonly<AssistedOrderActorBinding>,
    tableSessionId: string,
  ): Promise<void> {
    const access = await new StaffAccessRepository(this.transaction)
      .assertPermission(binding.employeeId, 'order.create')
    const session = await this.transaction.query<{ table_allowed: boolean }>(`
      SELECT (
        $7::boolean
        OR EXISTS (
          SELECT 1
          FROM mbox.table_assignments AS assignment
          WHERE assignment.tenant_id = table_session.tenant_id
            AND assignment.store_id = table_session.store_id
            AND assignment.table_id = table_session.table_id
            AND assignment.employee_id = $4::uuid
            AND assignment.assignment_type IN ('primary', 'backup')
            AND assignment.starts_at <= clock_timestamp()
            AND (assignment.ends_at IS NULL OR assignment.ends_at > clock_timestamp())
        )
      ) AS table_allowed
      FROM mbox.table_sessions AS table_session
      JOIN mbox.staff_sessions AS staff_session
        ON staff_session.tenant_id = table_session.tenant_id
       AND staff_session.store_id = table_session.store_id
       AND staff_session.id = $5::uuid
       AND staff_session.employee_id = $4::uuid
       AND staff_session.device_access_lease_id = $6::uuid
       AND staff_session.revoked_at IS NULL
       AND staff_session.expires_at > clock_timestamp()
       AND staff_session.online_lease_until > clock_timestamp()
      JOIN mbox.store_device_access_leases AS device_lease
        ON device_lease.tenant_id = staff_session.tenant_id
       AND device_lease.store_id = staff_session.store_id
       AND device_lease.id = staff_session.device_access_lease_id
       AND device_lease.revoked_at IS NULL
       AND device_lease.expires_at > clock_timestamp()
      JOIN mbox.store_daily_credentials AS credential
        ON credential.tenant_id = device_lease.tenant_id
       AND credential.store_id = device_lease.store_id
       AND credential.id = device_lease.daily_credential_id
       AND credential.revoked_at IS NULL
       AND credential.valid_from <= clock_timestamp()
       AND credential.valid_until > clock_timestamp()
      WHERE table_session.tenant_id = $1::uuid
        AND table_session.store_id = $2::uuid
        AND table_session.id = $3::uuid
        AND table_session.status = 'open'
      FOR KEY SHARE OF table_session, staff_session, device_lease, credential
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      tableSessionId,
      binding.employeeId,
      binding.staffSessionId,
      binding.deviceAccessLeaseId,
      access.permissions.includes('table.view_all'),
    ])
    const row = session.rows[0]
    if (session.rowCount !== 1 || row === undefined) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_SESSION_INVALID')
    }
    if (!row.table_allowed) {
      throw new AssistedOrderContextDeniedError('ASSISTED_CONTEXT_TABLE_FORBIDDEN')
    }
  }
}

export function hashAssistedOrderContextToken(token: string): string {
  return hashToken(token)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function mapContext(row: ContextRow): AssistedOrderContext {
  return {
    id: row.id,
    employeeId: row.employee_id,
    staffSessionId: row.staff_session_id,
    deviceAccessLeaseId: row.device_access_lease_id,
    tableSessionId: row.table_session_id,
    tableId: row.table_id,
    tableCode: row.table_code,
    expiresAt: row.expires_at,
  }
}

function validateBinding(input: Readonly<AssistedOrderActorBinding>): void {
  requireUuid('employeeId', input.employeeId)
  requireUuid('staffSessionId', input.staffSessionId)
  requireUuid('deviceAccessLeaseId', input.deviceAccessLeaseId)
}

function requireUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`)
  }
}
