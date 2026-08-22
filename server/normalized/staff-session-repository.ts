import { createHash } from 'node:crypto'
import type { ScopedTransaction } from './transaction-runner.js'

export interface StaffAuthenticationRecord {
  id: string
  employeeCode: string
  displayName: string
  pinHash: string | null
  status: 'active' | 'suspended' | 'departed'
}

export interface DailyStoreCredential {
  id: string
  businessDate: string
  credentialHash: string
  validFrom: string
  validUntil: string
  configuredByEmployeeId: string
  reusableAcrossBusinessDates: boolean
}

export interface DeviceAccessLease {
  id: string
  businessDate: string
  deviceKeyHash: string
  expiresAt: string
}

export interface StaffSession {
  id: string
  employeeId: string
  deviceAccessLeaseId: string
  issuedAt: string
  expiresAt: string
  lastHeartbeatAt: string
  onlineLeaseUntil: string
  isOnline: boolean
  revokedAt: string | null
}

interface EmployeeAuthRow extends Record<string, unknown> {
  id: string
  employee_code: string
  display_name: string
  pin_hash: string | null
  status: 'active' | 'suspended' | 'departed'
}

interface CredentialRow extends Record<string, unknown> {
  id: string
  business_date: string
  credential_hash: string
  valid_from: string
  valid_until: string
  configured_by_employee_id: string
  reusable_across_business_dates: boolean
}

interface LeaseRow extends Record<string, unknown> {
  id: string
  business_date: string
  device_key_hash: string
  expires_at: string
}

interface SessionRow extends Record<string, unknown> {
  id: string
  employee_id: string
  device_access_lease_id: string
  issued_at: string
  expires_at: string
  last_heartbeat_at: string
  online_lease_until: string
  revoked_at: string | null
  is_online: boolean
}

export class StaffSessionNotFoundError extends Error {
  constructor() {
    super('Staff session is invalid, revoked, or expired')
    this.name = 'StaffSessionNotFoundError'
  }
}

export class DeviceAccessDeniedError extends Error {
  constructor() {
    super('Daily store access is invalid, revoked, or expired')
    this.name = 'DeviceAccessDeniedError'
  }
}

export function hashOpaqueToken(token: string) {
  if (token.length < 32) throw new TypeError('Opaque token is too short')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function hashDeviceKey(deviceKey: string) {
  if (deviceKey.trim().length < 8) throw new TypeError('deviceKey must contain at least 8 characters')
  return createHash('sha256').update(deviceKey, 'utf8').digest('hex')
}

export class StaffSessionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async lockDailyCredentialScope(): Promise<void> {
    await this.transaction.query(`
      SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2 || ':daily-store-credential', 0))
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
  }

  async findEmployeeByCode(employeeCode: string): Promise<StaffAuthenticationRecord | null> {
    const result = await this.transaction.query<EmployeeAuthRow>(`
      SELECT id, employee_code, display_name, pin_hash, status
      FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND employee_code = $3
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeCode])
    return result.rows[0] ? mapEmployee(result.rows[0]) : null
  }

  async findEmployeeById(employeeId: string): Promise<StaffAuthenticationRecord | null> {
    const result = await this.transaction.query<EmployeeAuthRow>(`
      SELECT id, employee_code, display_name, pin_hash, status
      FROM mbox.employees
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId])
    return result.rows[0] ? mapEmployee(result.rows[0]) : null
  }

  async updateEmployeePinHash(employeeId: string, pinHash: string) {
    const result = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.employees
      SET pin_hash = $4
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      RETURNING id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, employeeId, pinHash])
    if (result.rowCount !== 1 || !result.rows[0]) throw new Error(`Employee was not found: ${employeeId}`)
    return result.rows[0].id
  }

  async replaceDailyCredential(input: {
    businessDate: string
    credentialHash: string
    validFrom: string
    validUntil: string
    configuredByEmployeeId: string
    now: string
  }): Promise<DailyStoreCredential> {
    const previous = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.store_daily_credentials
      SET revoked_at = $4::timestamptz
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND (business_date = $3::date OR reusable_across_business_dates = true)
        AND revoked_at IS NULL
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.businessDate,
      input.now,
    ])
    if (previous.rows.length > 0) {
      const ids = previous.rows.map((row) => row.id)
      await this.transaction.query(`
        UPDATE mbox.store_device_access_leases
        SET revoked_at = $4::timestamptz
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND daily_credential_id = ANY($3::uuid[]) AND revoked_at IS NULL
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, ids, input.now])
    }

    const result = await this.transaction.query<CredentialRow>(`
      INSERT INTO mbox.store_daily_credentials (
        tenant_id, store_id, business_date, credential_hash,
        valid_from, valid_until, configured_by_employee_id, reusable_across_business_dates
      ) VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, $6::timestamptz, $7::uuid, false)
      RETURNING id, business_date::text, credential_hash, valid_from::text, valid_until::text,
        configured_by_employee_id, reusable_across_business_dates
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.businessDate,
      input.credentialHash,
      input.validFrom,
      input.validUntil,
      input.configuredByEmployeeId,
    ])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new Error('Daily store credential was not created')
    return mapCredential(row)
  }

  async findActiveDailyCredential(businessDate: string, now: string) {
    const result = await this.transaction.query<CredentialRow>(`
      SELECT id, business_date::text, credential_hash, valid_from::text, valid_until::text,
        configured_by_employee_id, reusable_across_business_dates
      FROM mbox.store_daily_credentials
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND business_date = $3::date AND revoked_at IS NULL
        AND valid_from <= $4::timestamptz AND valid_until > $4::timestamptz
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, businessDate, now])
    return result.rows[0] ? mapCredential(result.rows[0]) : null
  }

  async findReusableDailyCredential(): Promise<DailyStoreCredential | null> {
    const result = await this.transaction.query<CredentialRow>(`
      SELECT id, business_date::text, credential_hash, valid_from::text, valid_until::text,
        configured_by_employee_id, reusable_across_business_dates
      FROM mbox.store_daily_credentials
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid
        AND revoked_at IS NULL AND reusable_across_business_dates = true
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId])
    return result.rows[0] ? mapCredential(result.rows[0]) : null
  }

  async renewReusableDailyCredential(input: {
    source: DailyStoreCredential
    businessDate: string
    now: string
    validUntil: string
  }): Promise<DailyStoreCredential> {
    if (!input.source.reusableAcrossBusinessDates) throw new DeviceAccessDeniedError()
    if (input.source.businessDate === input.businessDate) {
      const refreshed = await this.transaction.query<CredentialRow>(`
        UPDATE mbox.store_daily_credentials
        SET valid_until = $4::timestamptz
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND revoked_at IS NULL AND reusable_across_business_dates = true
        RETURNING id, business_date::text, credential_hash, valid_from::text, valid_until::text,
          configured_by_employee_id, reusable_across_business_dates
      `, [
        this.transaction.scope.tenantId,
        this.transaction.scope.storeId,
        input.source.id,
        input.validUntil,
      ])
      const row = refreshed.rows[0]
      if (refreshed.rowCount !== 1 || !row) throw new DeviceAccessDeniedError()
      return mapCredential(row)
    }

    const created = await this.transaction.query<CredentialRow>(`
      INSERT INTO mbox.store_daily_credentials (
        tenant_id, store_id, business_date, credential_hash,
        valid_from, valid_until, configured_by_employee_id, reusable_across_business_dates
      ) VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::timestamptz, $6::timestamptz, $7::uuid, true)
      RETURNING id, business_date::text, credential_hash, valid_from::text, valid_until::text,
        configured_by_employee_id, reusable_across_business_dates
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.businessDate,
      input.source.credentialHash,
      input.now,
      input.validUntil,
      input.source.configuredByEmployeeId,
    ])
    const row = created.rows[0]
    if (created.rowCount !== 1 || !row) throw new DeviceAccessDeniedError()
    return mapCredential(row)
  }

  async createDeviceAccessLease(input: {
    dailyCredentialId: string
    businessDate: string
    deviceKeyHash: string
    leaseTokenHash: string
    now: string
    expiresAt: string
  }): Promise<DeviceAccessLease> {
    const result = await this.transaction.query<LeaseRow>(`
      INSERT INTO mbox.store_device_access_leases (
        tenant_id, store_id, daily_credential_id, business_date,
        device_key_hash, lease_token_hash, issued_at, expires_at, last_used_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::date,
        $5, $6, $7::timestamptz, $8::timestamptz, $7::timestamptz
      )
      RETURNING id, business_date::text, device_key_hash, expires_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.dailyCredentialId,
      input.businessDate,
      input.deviceKeyHash,
      input.leaseTokenHash,
      input.now,
      input.expiresAt,
    ])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new Error('Device access lease was not created')
    return mapLease(row)
  }

  async requireDeviceAccessLease(leaseTokenHash: string, now: string): Promise<DeviceAccessLease> {
    const result = await this.transaction.query<LeaseRow>(`
      UPDATE mbox.store_device_access_leases AS dl
      SET last_used_at = $4::timestamptz
      FROM mbox.store_daily_credentials AS dc
      WHERE dl.tenant_id = $1::uuid AND dl.store_id = $2::uuid
        AND dl.lease_token_hash = $3 AND dl.revoked_at IS NULL
        AND dl.expires_at > $4::timestamptz
        AND dc.tenant_id = dl.tenant_id AND dc.store_id = dl.store_id
        AND dc.id = dl.daily_credential_id AND dc.revoked_at IS NULL
        AND dc.valid_from <= $4::timestamptz AND dc.valid_until > $4::timestamptz
      RETURNING dl.id, dl.business_date::text, dl.device_key_hash, dl.expires_at::text
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, leaseTokenHash, now])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new DeviceAccessDeniedError()
    return mapLease(row)
  }

  async requireDeviceAccessLeaseForSession(leaseId: string, now: string): Promise<DeviceAccessLease> {
    const result = await this.transaction.query<LeaseRow>(`
      SELECT dl.id, dl.business_date::text, dl.device_key_hash, dl.expires_at::text
      FROM mbox.store_device_access_leases AS dl
      JOIN mbox.store_daily_credentials AS dc
        ON dc.tenant_id = dl.tenant_id AND dc.store_id = dl.store_id
        AND dc.id = dl.daily_credential_id
      WHERE dl.tenant_id = $1::uuid AND dl.store_id = $2::uuid
        AND dl.id = $3::uuid AND dl.revoked_at IS NULL AND dl.expires_at > $4::timestamptz
        AND dc.revoked_at IS NULL AND dc.valid_from <= $4::timestamptz
        AND dc.valid_until > $4::timestamptz
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, leaseId, now])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new DeviceAccessDeniedError()
    return mapLease(row)
  }

  async createSession(input: {
    employeeId: string
    deviceAccessLeaseId: string
    sessionTokenHash: string
    issuedAt: string
    expiresAt: string
    onlineLeaseUntil: string
  }): Promise<StaffSession> {
    const result = await this.transaction.query<SessionRow>(`
      INSERT INTO mbox.staff_sessions (
        tenant_id, store_id, employee_id, device_access_lease_id,
        session_token_hash, issued_at, expires_at, last_heartbeat_at, online_lease_until
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid,
        $5, $6::timestamptz, $7::timestamptz, $6::timestamptz, $8::timestamptz
      )
      RETURNING id, employee_id, device_access_lease_id, issued_at::text, expires_at::text,
        last_heartbeat_at::text, online_lease_until::text, revoked_at,
        online_lease_until > $6::timestamptz AS is_online
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.employeeId,
      input.deviceAccessLeaseId,
      input.sessionTokenHash,
      input.issuedAt,
      input.expiresAt,
      input.onlineLeaseUntil,
    ])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new Error('Staff session was not created')
    return mapSession(row)
  }

  async requireSession(sessionTokenHash: string, now: string, lock = false): Promise<StaffSession> {
    const result = await this.transaction.query<SessionRow>(`
      SELECT ss.id, ss.employee_id, ss.device_access_lease_id,
        ss.issued_at::text, ss.expires_at::text, ss.last_heartbeat_at::text,
        ss.online_lease_until::text, ss.revoked_at::text,
        ss.online_lease_until > $4::timestamptz AS is_online
      FROM mbox.staff_sessions AS ss
      JOIN mbox.employees AS e
        ON e.tenant_id = ss.tenant_id AND e.store_id = ss.store_id AND e.id = ss.employee_id
      WHERE ss.tenant_id = $1::uuid AND ss.store_id = $2::uuid
        AND ss.session_token_hash = $3 AND ss.revoked_at IS NULL
        AND ss.expires_at > $4::timestamptz AND e.status = 'active'
      ${lock ? 'FOR UPDATE OF ss' : ''}
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, sessionTokenHash, now])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new StaffSessionNotFoundError()
    return mapSession(row)
  }

  async heartbeat(sessionId: string, now: string, onlineLeaseUntil: string): Promise<StaffSession> {
    const result = await this.transaction.query<SessionRow>(`
      UPDATE mbox.staff_sessions
      SET last_heartbeat_at = $4::timestamptz,
          online_lease_until = LEAST(expires_at, $5::timestamptz)
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND revoked_at IS NULL AND expires_at > $4::timestamptz
      RETURNING id, employee_id, device_access_lease_id, issued_at::text, expires_at::text,
        last_heartbeat_at::text, online_lease_until::text, revoked_at,
        online_lease_until > $4::timestamptz AS is_online
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      sessionId,
      now,
      onlineLeaseUntil,
    ])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new StaffSessionNotFoundError()
    return mapSession(row)
  }

  async revokeSession(sessionId: string, actorEmployeeId: string, reason: string, now: string) {
    const result = await this.transaction.query<SessionRow>(`
      UPDATE mbox.staff_sessions
      SET revoked_at = $5::timestamptz, revoked_by_employee_id = $4::uuid, revoke_reason = $6
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND revoked_at IS NULL
      RETURNING id, employee_id, device_access_lease_id, issued_at::text, expires_at::text,
        last_heartbeat_at::text, online_lease_until::text, revoked_at::text, false AS is_online
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      sessionId,
      actorEmployeeId,
      now,
      reason,
    ])
    const row = result.rows[0]
    if (result.rowCount !== 1 || !row) throw new StaffSessionNotFoundError()
    return mapSession(row)
  }
}

function mapEmployee(row: EmployeeAuthRow): StaffAuthenticationRecord {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    displayName: row.display_name,
    pinHash: row.pin_hash,
    status: row.status,
  }
}

function mapCredential(row: CredentialRow): DailyStoreCredential {
  return {
    id: row.id,
    businessDate: row.business_date,
    credentialHash: row.credential_hash,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    configuredByEmployeeId: row.configured_by_employee_id,
    reusableAcrossBusinessDates: row.reusable_across_business_dates,
  }
}

function mapLease(row: LeaseRow): DeviceAccessLease {
  return {
    id: row.id,
    businessDate: row.business_date,
    deviceKeyHash: row.device_key_hash,
    expiresAt: row.expires_at,
  }
}

function mapSession(row: SessionRow): StaffSession {
  return {
    id: row.id,
    employeeId: row.employee_id,
    deviceAccessLeaseId: row.device_access_lease_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    onlineLeaseUntil: row.online_lease_until,
    isOnline: row.is_online,
    revokedAt: row.revoked_at,
  }
}
