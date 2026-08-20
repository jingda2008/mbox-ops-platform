import { createHash, createHmac, randomBytes } from 'node:crypto'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export const TABLE_GUEST_SCOPES = Object.freeze([
  'guest.session.read',
  'guest.menu.read',
  'guest.order.create',
  'guest.service.create',
  'guest.song.request',
] as const)

export type GuestSessionKind = 'table' | 'reservation' | 'member'
export type TableGuestScope = (typeof TABLE_GUEST_SCOPES)[number]

export interface GuestAnonymousIdentityPort {
  resolveAnonymous(input: Readonly<{
    transaction: ScopedTransaction
    identityHash: string
    publicId: string
    businessDate: string
  }>): Promise<{ customerId: string }>
}

export interface GuestSessionRecord {
  id: string
  kind: GuestSessionKind
  customerId: string
  tableSessionId: string | null
  reservationId: string | null
  tableCode: string | null
  tableDisplayName: string | null
  businessDate: string | null
  scopes: string[]
  issuedAt: string
  expiresAt: string
  lastSeenAt: string
}

export interface ActiveTableCredential {
  credentialId: string
  credentialHash: string
  tableId: string
  tableCode: string
  tableDisplayName: string
  tableSessionId: string | null
  businessDate: string | null
}

export interface TableScanInput {
  scope: Readonly<StoreScope>
  tableQrToken: string
  deviceFingerprint: string
  businessDate: string
}

export type TableScanResult =
  | {
      status: 'active'
      sessionToken: string
      session: GuestSessionRecord
    }
  | {
      status: 'already_active'
      session: GuestSessionRecord
    }
  | {
      status: 'waiting_for_table'
      tableCode: string
      tableDisplayName: string
    }
  | { status: 'invalid_qr' }
  | { status: 'rate_limited'; retryAt: string }

export interface GuestSessionServiceOptions {
  sessionTtlMs?: number
  now?: () => Date
  randomToken?: () => string
  randomPublicId?: () => string
}

interface TableCredentialRow extends Record<string, unknown> {
  credential_id: string
  table_id: string
  table_code: string
  table_display_name: string
}

interface OpenTableSessionRow extends Record<string, unknown> {
  id: string
  business_date: string
}

interface GuestSessionRow extends Record<string, unknown> {
  id: string
  session_kind: GuestSessionKind
  customer_id: string
  table_session_id: string | null
  reservation_id: string | null
  table_code: string | null
  table_display_name: string | null
  business_date: string | null
  scopes: string[]
  issued_at: string
  expires_at: string
  last_seen_at: string
  revoked_at: string | null
  customer_status: string
  table_session_status: string | null
}

interface RateLimitRow extends Record<string, unknown> {
  attempt_count: number
  expires_at: string
}

export class GuestSessionInvalidError extends Error {
  constructor(message = '访客会话无效，请重新扫描桌面二维码') {
    super(message)
    this.name = 'GuestSessionInvalidError'
  }
}

export class GuestTableSessionEndedError extends Error {
  constructor() {
    super('本桌本次服务已经结束，请重新扫描桌面固定二维码')
    this.name = 'GuestTableSessionEndedError'
  }
}

export class GuestCustomerAtAnotherTableError extends Error {
  constructor() {
    super('当前身份已在其他桌次使用，请扫描您当前所在桌面的二维码，或联系服务人员调整桌位')
    this.name = 'GuestCustomerAtAnotherTableError'
  }
}

export class GuestSessionRateLimitError extends Error {
  readonly retryAt: string

  constructor(retryAt: string) {
    super('操作有点快，请稍后再试')
    this.name = 'GuestSessionRateLimitError'
    this.retryAt = retryAt
  }
}

export class GuestSessionRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async consumeRateLimit(
    kind: 'table_scan' | 'invalid_token',
    principalHash: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAt: string }> {
    requireSha256(principalHash, 'principalHash')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('rate limit must be an integer between 1 and 100')
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) {
      throw new TypeError('rate-limit window must be between 1 second and 1 hour')
    }
    const result = await this.transaction.query<RateLimitRow>(`
      WITH rate_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS current_at
      ), rate_window AS (
        SELECT current_at,
          to_timestamp(
            floor(extract(epoch FROM current_at) * 1000 / $6::bigint)
            * $6::bigint / 1000
          ) AS window_started_at
        FROM rate_clock
      )
      INSERT INTO mbox.guest_session_rate_limits (
        tenant_id, store_id, attempt_kind, principal_hash,
        window_started_at, attempt_count, expires_at
      )
      SELECT $1::uuid, $2::uuid, $3, $4,
        window_started_at, 1,
        window_started_at + make_interval(secs => $6::double precision / 1000)
      FROM rate_window
      ON CONFLICT (tenant_id, store_id, attempt_kind, principal_hash)
      DO UPDATE SET
        window_started_at = CASE
          WHEN mbox.guest_session_rate_limits.expires_at <= clock_timestamp()
            THEN EXCLUDED.window_started_at
          ELSE mbox.guest_session_rate_limits.window_started_at
        END,
        attempt_count = CASE
          WHEN mbox.guest_session_rate_limits.expires_at <= clock_timestamp() THEN 1
          ELSE LEAST(mbox.guest_session_rate_limits.attempt_count + 1, $5::integer + 1)
        END,
        expires_at = CASE
          WHEN mbox.guest_session_rate_limits.expires_at <= clock_timestamp()
            THEN EXCLUDED.expires_at
          ELSE mbox.guest_session_rate_limits.expires_at
        END
      RETURNING attempt_count, expires_at::text
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      kind,
      principalHash,
      limit,
      windowMs,
    ])
    const row = requiredRow(result.rows[0], 'guest session rate limit')
    return {
      allowed: Number(row.attempt_count) <= limit,
      retryAt: new Date(row.expires_at).toISOString(),
    }
  }

  async findActiveTableCredential(credentialHash: string): Promise<ActiveTableCredential | null> {
    requireSha256(credentialHash, 'credentialHash')
    const credentialResult = await this.transaction.query<TableCredentialRow>(`
      SELECT qr.id AS credential_id, table_record.id AS table_id,
        table_record.code AS table_code,
        table_record.display_name AS table_display_name
      FROM mbox.table_qr_credentials AS qr
      JOIN mbox.tables AS table_record
        ON table_record.tenant_id = qr.tenant_id
        AND table_record.store_id = qr.store_id
        AND table_record.id = qr.table_id
      WHERE qr.tenant_id = $1::uuid
        AND qr.store_id = $2::uuid
        AND qr.credential_hash = $3
        AND qr.status = 'active'
        AND qr.qr_version = table_record.qr_version
        AND table_record.status = 'available'
      FOR KEY SHARE OF qr, table_record
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, credentialHash])
    const credential = credentialResult.rows[0]
    if (!credential) return null

    const tableSessionResult = await this.transaction.query<OpenTableSessionRow>(`
      SELECT id, business_date::text
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_id = $3::uuid
        AND status = 'open'
      FOR KEY SHARE
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, credential.table_id])
    const tableSession = tableSessionResult.rows[0]
    return {
      credentialId: credential.credential_id,
      credentialHash,
      tableId: credential.table_id,
      tableCode: credential.table_code,
      tableDisplayName: credential.table_display_name,
      tableSessionId: tableSession?.id ?? null,
      businessDate: tableSession?.business_date ?? null,
    }
  }

  async issueTableSession(input: Readonly<{
    credential: ActiveTableCredential
    customerId: string
    tokenHash: string
    deviceHash: string
    issuedAt: string
    expiresAt: string
  }>): Promise<
    | { status: 'issued'; session: GuestSessionRecord }
    | { status: 'already_active'; session: GuestSessionRecord }
  > {
    if (!input.credential.tableSessionId) throw new GuestTableSessionEndedError()
    requireSha256(input.tokenHash, 'tokenHash')
    requireSha256(input.deviceHash, 'deviceHash')
    await this.transaction.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`guest-session:${this.transaction.scope.tenantId}:${this.transaction.scope.storeId}:${input.credential.tableSessionId}:${input.deviceHash}`],
    )

    const open = await this.transaction.query<OpenTableSessionRow>(`
      SELECT id, business_date::text
      FROM mbox.table_sessions
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND id = $3::uuid
        AND table_id = $4::uuid
        AND status = 'open'
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.credential.tableSessionId,
      input.credential.tableId,
    ])
    if (open.rowCount !== 1) throw new GuestTableSessionEndedError()

    const position = await this.transaction.query<{ participation_id: string | null }>(`
      SELECT mbox.ensure_scanned_table_customer_position(
        $1::char(64),$2::uuid,$3::uuid
      ) AS participation_id
    `, [input.credential.credentialHash, input.credential.tableSessionId, input.customerId])
    if (position.rows[0]?.participation_id === null) throw new GuestTableSessionEndedError()

    const existing = await this.transaction.query<GuestSessionRow>(`
      SELECT guest.id, guest.session_kind, guest.customer_id,
        guest.table_session_id, guest.reservation_id,
        $5::text AS table_code, $6::text AS table_display_name,
        $7::text AS business_date, guest.scopes,
        guest.issued_at::text, guest.expires_at::text,
        guest.last_seen_at::text, guest.revoked_at::text,
        'active'::text AS customer_status,
        'open'::text AS table_session_status
      FROM mbox.guest_sessions AS guest
      WHERE guest.tenant_id = $1::uuid
        AND guest.store_id = $2::uuid
        AND guest.table_session_id = $3::uuid
        AND guest.device_hash = $4
        AND guest.session_kind = 'table'
        AND guest.revoked_at IS NULL
      FOR UPDATE
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.credential.tableSessionId,
      input.deviceHash,
      input.credential.tableCode,
      input.credential.tableDisplayName,
      input.credential.businessDate,
    ])
    const current = existing.rows[0]
    if (current
      && new Date(input.issuedAt).getTime() - new Date(current.issued_at).getTime() < 5_000
      && new Date(current.expires_at).getTime() > new Date(input.issuedAt).getTime()) {
      await this.recordEvent({
        guestSessionId: current.id,
        tableId: input.credential.tableId,
        tableSessionId: input.credential.tableSessionId,
        eventType: 'guest_session.scan-coalesced',
        outcome: 'succeeded',
      })
      return { status: 'already_active', session: mapSession(current) }
    }

    const revoked = await this.transaction.query<{ id: string }>(`
      UPDATE mbox.guest_sessions
      SET revoked_at = $5::timestamptz, revoke_reason = 'superseded_by_rescan'
      WHERE tenant_id = $1::uuid
        AND store_id = $2::uuid
        AND table_session_id = $3::uuid
        AND device_hash = $4
        AND session_kind = 'table'
        AND revoked_at IS NULL
      RETURNING id
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.credential.tableSessionId,
      input.deviceHash,
      input.issuedAt,
    ])
    for (const previous of revoked.rows) {
      await this.recordEvent({
        guestSessionId: previous.id,
        tableId: input.credential.tableId,
        tableSessionId: input.credential.tableSessionId,
        eventType: 'guest_session.revoked',
        outcome: 'revoked',
        reasonCode: 'SUPERSEDED_BY_RESCAN',
      })
    }

    const inserted = await this.transaction.query<GuestSessionRow>(`
      INSERT INTO mbox.guest_sessions (
        tenant_id, store_id, session_kind, customer_id, table_session_id,
        token_hash, device_hash, scopes, issued_at, expires_at, last_seen_at
      ) VALUES (
        $1::uuid, $2::uuid, 'table', $3::uuid, $4::uuid,
        $5, $6, $7::text[], $8::timestamptz, $9::timestamptz, $8::timestamptz
      )
      RETURNING id, session_kind, customer_id, table_session_id, reservation_id,
        $10::text AS table_code, $11::text AS table_display_name,
        $12::text AS business_date, scopes,
        issued_at::text, expires_at::text, last_seen_at::text,
        revoked_at::text, 'active'::text AS customer_status,
        'open'::text AS table_session_status
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.customerId,
      input.credential.tableSessionId,
      input.tokenHash,
      input.deviceHash,
      [...TABLE_GUEST_SCOPES],
      input.issuedAt,
      input.expiresAt,
      input.credential.tableCode,
      input.credential.tableDisplayName,
      input.credential.businessDate,
    ])
    const row = requiredRow(inserted.rows[0], 'guest session')
    await this.recordEvent({
      guestSessionId: row.id,
      tableId: input.credential.tableId,
      tableSessionId: input.credential.tableSessionId,
      eventType: 'guest_session.issued',
      outcome: 'succeeded',
      metadata: { kind: 'table' },
    })
    return { status: 'issued', session: mapSession(row) }
  }

  async authenticate(input: Readonly<{
    tokenHash: string
    deviceHash: string
    invalidPrincipalHash: string
    now: string
  }>): Promise<
    | { status: 'active'; session: GuestSessionRecord }
    | { status: 'invalid'; retryAt?: string }
    | { status: 'ended' }
  > {
    requireSha256(input.tokenHash, 'tokenHash')
    requireSha256(input.deviceHash, 'deviceHash')
    requireSha256(input.invalidPrincipalHash, 'invalidPrincipalHash')
    const candidate = await this.transaction.query<{
      id: string
      session_kind: GuestSessionKind
      table_session_id: string | null
      customer_id: string
    }>(`
      SELECT id,session_kind,table_session_id,customer_id
      FROM mbox.guest_sessions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        AND token_hash=$3 AND device_hash=$4
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId,
      input.tokenHash, input.deviceHash])
    const candidateRow = candidate.rows[0]
    let activePosition = true
    if (candidateRow?.session_kind === 'table' && candidateRow.table_session_id !== null) {
      const guard = await this.transaction.query<{ participation_id: string | null }>(`
        SELECT mbox.lock_active_table_guest_session_position($1::uuid,$2::uuid,$3::uuid)
          AS participation_id
      `, [candidateRow.table_session_id, candidateRow.customer_id, candidateRow.id])
      activePosition = guard.rows[0]?.participation_id !== null
    }
    const result = await this.transaction.query<GuestSessionRow>(`
      SELECT guest.id, guest.session_kind, guest.customer_id,
        guest.table_session_id, guest.reservation_id,
        table_record.code AS table_code,
        table_record.display_name AS table_display_name,
        table_session.business_date::text AS business_date,
        guest.scopes, guest.issued_at::text, guest.expires_at::text,
        guest.last_seen_at::text, guest.revoked_at::text,
        customer.status AS customer_status,
        table_session.status AS table_session_status
      FROM mbox.guest_sessions AS guest
      JOIN mbox.customers AS customer
        ON customer.tenant_id = guest.tenant_id
        AND customer.store_id = guest.store_id
        AND customer.id = guest.customer_id
      LEFT JOIN mbox.table_sessions AS table_session
        ON table_session.tenant_id = guest.tenant_id
        AND table_session.store_id = guest.store_id
        AND table_session.id = guest.table_session_id
      LEFT JOIN mbox.tables AS table_record
        ON table_record.tenant_id = table_session.tenant_id
        AND table_record.store_id = table_session.store_id
        AND table_record.id = table_session.table_id
      WHERE guest.tenant_id = $1::uuid
        AND guest.store_id = $2::uuid
        AND guest.token_hash = $3
        AND guest.device_hash = $4
      FOR UPDATE OF guest
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.tokenHash,
      input.deviceHash,
    ])
    const row = result.rows[0]
    if (!row) return this.recordInvalidAuthentication(input.invalidPrincipalHash, null)

    const expired = new Date(row.expires_at).getTime() <= new Date(input.now).getTime()
    const unavailableCustomer = row.customer_status !== 'active'
    const tableEnded = row.session_kind === 'table'
      && (row.table_session_status !== 'open' || !activePosition)
    if (row.revoked_at !== null || expired || unavailableCustomer || tableEnded) {
      const reasonCode = tableEnded ? 'TABLE_SESSION_ENDED'
        : expired ? 'SESSION_EXPIRED'
          : unavailableCustomer ? 'CUSTOMER_UNAVAILABLE'
            : 'SESSION_REVOKED'
      if (row.revoked_at === null) {
        await this.transaction.query(`
          UPDATE mbox.guest_sessions
          SET revoked_at = $4::timestamptz, revoke_reason = $5
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND revoked_at IS NULL
        `, [
          this.transaction.scope.tenantId,
          this.transaction.scope.storeId,
          row.id,
          input.now,
          reasonCode.toLocaleLowerCase('en-US'),
        ])
        await this.recordEvent({
          guestSessionId: row.id,
          tableSessionId: row.table_session_id,
          eventType: 'guest_session.revoked',
          outcome: 'revoked',
          reasonCode,
        })
      }
      return tableEnded ? { status: 'ended' } : { status: 'invalid' }
    }

    if (new Date(input.now).getTime() - new Date(row.last_seen_at).getTime() >= 5 * 60_000) {
      await this.transaction.query(`
        UPDATE mbox.guest_sessions
        SET last_seen_at = $4::timestamptz
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, row.id, input.now])
      await this.recordEvent({
        guestSessionId: row.id,
        tableSessionId: row.table_session_id,
        eventType: 'guest_session.seen',
        outcome: 'succeeded',
      })
      row.last_seen_at = input.now
    }
    return { status: 'active', session: mapSession(row) }
  }

  async cleanupExpiredRateLimits(limit = 50): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('limit must be an integer between 1 and 50')
    }
    const result = await this.transaction.query<{ id: string }>(`
      WITH candidates AS (
        SELECT id
        FROM mbox.guest_session_rate_limits
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND expires_at <= clock_timestamp()
        ORDER BY expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      DELETE FROM mbox.guest_session_rate_limits AS rate_limit
      USING candidates
      WHERE rate_limit.tenant_id = $1::uuid
        AND rate_limit.store_id = $2::uuid
        AND rate_limit.id = candidates.id
      RETURNING rate_limit.id
    `, [this.transaction.scope.tenantId, this.transaction.scope.storeId, limit])
    if (result.rows.length > 0) {
      await this.recordEvent({
        eventType: 'guest_session.rate-limit-cleaned',
        outcome: 'succeeded',
        metadata: { deletedCount: result.rows.length },
      })
    }
    return result.rows.length
  }

  async recordEvent(input: Readonly<{
    guestSessionId?: string | null
    tableId?: string | null
    tableSessionId?: string | null
    eventType: string
    outcome: 'succeeded' | 'denied' | 'rate_limited' | 'revoked'
    reasonCode?: string | null
    metadata?: Readonly<Record<string, string | number | boolean | null>>
  }>): Promise<void> {
    await this.transaction.query(`
      INSERT INTO mbox.guest_session_events (
        tenant_id, store_id, guest_session_id, table_id, table_session_id,
        event_type, outcome, reason_code, metadata
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
        $6, $7, $8, $9::jsonb
      )
    `, [
      this.transaction.scope.tenantId,
      this.transaction.scope.storeId,
      input.guestSessionId ?? null,
      input.tableId ?? null,
      input.tableSessionId ?? null,
      input.eventType,
      input.outcome,
      input.reasonCode ?? null,
      JSON.stringify(input.metadata ?? {}),
    ])
  }

  private async recordInvalidAuthentication(
    principalHash: string,
    guestSessionId: string | null,
  ): Promise<{ status: 'invalid'; retryAt?: string }> {
    const rate = await this.consumeRateLimit('invalid_token', principalHash, 20, 5 * 60_000)
    await this.recordEvent({
      guestSessionId,
      eventType: 'guest_session.authentication-denied',
      outcome: rate.allowed ? 'denied' : 'rate_limited',
      reasonCode: rate.allowed ? 'INVALID_CREDENTIALS' : 'AUTH_RATE_LIMITED',
    })
    return rate.allowed ? { status: 'invalid' } : { status: 'invalid', retryAt: rate.retryAt }
  }
}

export class GuestSessionService {
  private readonly sessionTtlMs: number
  private readonly now: () => Date
  private readonly randomToken: () => string
  private readonly randomPublicId: () => string

  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly identities: GuestAnonymousIdentityPort,
    private readonly hashSecret: string,
    options: Readonly<GuestSessionServiceOptions> = {},
  ) {
    if (hashSecret.length < 32) throw new TypeError('guest session hash secret must contain at least 32 characters')
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60_000
    if (!Number.isSafeInteger(this.sessionTtlMs)
      || this.sessionTtlMs < 5 * 60_000
      || this.sessionTtlMs > 2 * 60 * 60_000) {
      throw new TypeError('guest session TTL must be between 5 minutes and 2 hours')
    }
    this.now = options.now ?? (() => new Date())
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
    this.randomPublicId = options.randomPublicId ?? (() => `guest-${randomBytes(16).toString('hex')}`)
  }

  async scanTable(input: Readonly<TableScanInput>): Promise<TableScanResult> {
    validateTableQrToken(input.tableQrToken)
    validateDeviceFingerprint(input.deviceFingerprint)
    const credentialHash = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'table-qr-v1',
      input.tableQrToken,
    )
    const deviceHash = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'guest-device-v1',
      input.deviceFingerprint,
    )
    const ratePrincipal = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'guest-scan-rate-v1',
      `${credentialHash}:${deviceHash}`,
    )
    const tableRatePrincipal = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'guest-table-scan-rate-v1',
      credentialHash,
    )
    const rawToken = this.randomToken()
    validateGuestToken(rawToken)
    const tokenHash = hashGuestSessionToken(rawToken)
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + this.sessionTtlMs)

    return this.transactions.run(input.scope, async (transaction) => {
      const repository = new GuestSessionRepository(transaction)
      const deviceRate = await repository.consumeRateLimit(
        'table_scan', ratePrincipal, 10, 60_000,
      )
      const tableRate = await repository.consumeRateLimit(
        'table_scan', tableRatePrincipal, 30, 60_000,
      )
      if (!deviceRate.allowed || !tableRate.allowed) {
        const retryAt = new Date(Math.max(
          new Date(deviceRate.retryAt).getTime(),
          new Date(tableRate.retryAt).getTime(),
        )).toISOString()
        await repository.recordEvent({
          eventType: 'guest_session.scan-denied',
          outcome: 'rate_limited',
          reasonCode: 'SCAN_RATE_LIMITED',
        })
        return { status: 'rate_limited', retryAt }
      }

      const credential = await repository.findActiveTableCredential(credentialHash)
      if (!credential) {
        await repository.recordEvent({
          eventType: 'guest_session.scan-denied',
          outcome: 'denied',
          reasonCode: 'INVALID_TABLE_QR',
        })
        return { status: 'invalid_qr' }
      }
      if (!credential.tableSessionId) {
        await repository.recordEvent({
          tableId: credential.tableId,
          eventType: 'guest_session.scan-waiting',
          outcome: 'denied',
          reasonCode: 'TABLE_NOT_OPEN',
        })
        return {
          status: 'waiting_for_table',
          tableCode: credential.tableCode,
          tableDisplayName: credential.tableDisplayName,
        }
      }

      const identity = await this.identities.resolveAnonymous({
        transaction,
        identityHash: deviceHash,
        publicId: this.randomPublicId(),
        businessDate: input.businessDate,
      })
      let issuance: Awaited<ReturnType<GuestSessionRepository['issueTableSession']>>
      try {
        issuance = await repository.issueTableSession({
          credential,
          customerId: identity.customerId,
          tokenHash,
          deviceHash,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        })
      } catch (error) {
        if (isCustomerAtAnotherTableError(error)) throw new GuestCustomerAtAnotherTableError()
        throw error
      }
      if (issuance.status === 'already_active') {
        return { status: 'already_active', session: issuance.session }
      }
      return { status: 'active', sessionToken: rawToken, session: issuance.session }
    }, { isolation: 'serializable', retryOnConflict: 2 })
  }

  async authenticate(input: Readonly<{
    scope: Readonly<StoreScope>
    sessionToken: string
    deviceFingerprint: string
  }>): Promise<GuestSessionRecord> {
    validateGuestToken(input.sessionToken)
    validateDeviceFingerprint(input.deviceFingerprint)
    const tokenHash = hashGuestSessionToken(input.sessionToken)
    const deviceHash = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'guest-device-v1',
      input.deviceFingerprint,
    )
    const invalidPrincipalHash = hmacSensitiveValue(
      this.hashSecret,
      input.scope,
      'guest-invalid-token-rate-v1',
      `${tokenHash}:${deviceHash}`,
    )
    const outcome = await this.transactions.run(input.scope, (transaction) => (
      new GuestSessionRepository(transaction).authenticate({
        tokenHash,
        deviceHash,
        invalidPrincipalHash,
        now: this.now().toISOString(),
      })
    ))
    if (outcome.status === 'active') return outcome.session
    if (outcome.status === 'ended') throw new GuestTableSessionEndedError()
    if (outcome.retryAt) throw new GuestSessionRateLimitError(outcome.retryAt)
    throw new GuestSessionInvalidError()
  }
}

function isCustomerAtAnotherTableError(error: unknown): boolean {
  return typeof error==='object' && error!==null
    && 'code' in error && error.code==='55000'
    && 'message' in error && typeof error.message==='string'
    && error.message.includes('customer already has another active table position')
}

export function hashGuestSessionToken(token: string): string {
  validateGuestToken(token)
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function hashTableQrCredential(
  secret: string,
  scope: Readonly<StoreScope>,
  token: string,
): string {
  if (secret.length < 32) throw new TypeError('guest session hash secret must contain at least 32 characters')
  validateTableQrToken(token)
  return hmacSensitiveValue(secret, scope, 'table-qr-v1', token)
}

function hmacSensitiveValue(
  secret: string,
  scope: Readonly<StoreScope>,
  domain: string,
  value: string,
): string {
  return createHmac('sha256', secret)
    .update('mbox-normalized-guest-v1\0')
    .update(scope.tenantId)
    .update('\0')
    .update(scope.storeId)
    .update('\0')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')
}

function mapSession(row: GuestSessionRow): GuestSessionRecord {
  return {
    id: row.id,
    kind: row.session_kind,
    customerId: row.customer_id,
    tableSessionId: row.table_session_id,
    reservationId: row.reservation_id,
    tableCode: row.table_code,
    tableDisplayName: row.table_display_name,
    businessDate: row.business_date,
    scopes: [...row.scopes],
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  }
}

function validateTableQrToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new GuestSessionInvalidError('桌面二维码信息不完整')
}

function validateGuestToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new GuestSessionInvalidError()
}

function validateDeviceFingerprint(value: string): void {
  if (value.trim().length < 8 || value.length > 512) {
    throw new GuestSessionInvalidError('设备会话信息不完整，请重新扫描桌面二维码')
  }
}

function requireSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} was not persisted`)
  return row
}
