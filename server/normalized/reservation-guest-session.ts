import { createHash, randomBytes } from 'node:crypto'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
} from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

export const RESERVATION_GUEST_SCOPES = Object.freeze([
  'guest.reservation.read',
  'guest.reservation.update',
  'guest.waitlist.manage',
] as const)

export interface ReservationIdentityPort {
  resolve(input: Readonly<{
    transaction: ScopedTransaction
    provider: 'anonymous' | 'wechat'
    providerAssertion: string
    identitySubjectHash: string
    deviceHash: string
  }>): Promise<{ customerId: string; actorRef: string }>
}

export interface ReservationGuestSession {
  id: string
  customerId: string
  actorRef: string
  scopes: string[]
  expiresAt: string
}

export interface ReservationGuestSessionIssueResult {
  sessionToken: string
  session: ReservationGuestSession
}

interface SessionRow extends Record<string, unknown> {
  id: string
  customer_id: string
  scopes: string[]
  expires_at: string
  revoked_at: string | null
}

interface RateRow extends Record<string, unknown> {
  attempt_count: number
  expires_at: string
}

export class ReservationGuestSessionInvalidError extends Error {
  constructor() {
    super('预约会话已失效，请重新进入预约页面')
    this.name = 'ReservationGuestSessionInvalidError'
  }
}

export class ReservationGuestRateLimitError extends Error {
  constructor(readonly retryAt: string) {
    super('操作有点快，请稍后再试')
    this.name = 'ReservationGuestRateLimitError'
  }
}

export class ReservationGuestSessionService {
  private readonly ttlMs: number
  private readonly now: () => Date
  private readonly randomToken: () => string

  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly identities: ReservationIdentityPort,
    options: Readonly<{
      ttlMs?: number
      now?: () => Date
      randomToken?: () => string
    }> = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 5 * 60_000 || this.ttlMs > 2 * 60 * 60_000) {
      throw new TypeError('reservation guest session ttl must be between 5 minutes and 2 hours')
    }
    this.now = options.now ?? (() => new Date())
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
  }

  async issue(input: Readonly<{
    scope: Readonly<StoreScope>
    provider: 'anonymous' | 'wechat'
    providerAssertion: string
    deviceFingerprint: string
    idempotencyKey: string
    requestFingerprint: string
    businessDate: string
  }>): Promise<CommandExecution<ReservationGuestSessionIssueResult>> {
    requireText(input.providerAssertion, 'providerAssertion', 8, 4096)
    requireText(input.deviceFingerprint, 'deviceFingerprint', 8, 512)
    const principalHash = sha256(`${input.provider}:${input.providerAssertion}:${input.deviceFingerprint}`)
    const rate = await this.consumeRateLimit(input.scope, principalHash, 8, 60_000)
    if (!rate.allowed) throw new ReservationGuestRateLimitError(rate.retryAt)

    const token = this.randomToken()
    requireText(token, 'sessionToken', 32, 256)
    const tokenHash = sha256(token)
    const deviceHash = sha256(input.deviceFingerprint)
    const identitySubjectHash = sha256(`${input.provider}:${input.providerAssertion}`)
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs)

    return this.commands.execute({
      scope: input.scope,
      operationScope: 'public.reservation.session.issue',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: sessionIssueCodec,
    }, async (transaction) => {
      await transaction.query(`
        SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
      `, [`${identitySubjectHash}:${deviceHash}`])
      const identity = await this.identities.resolve({
        transaction,
        provider: input.provider,
        providerAssertion: input.providerAssertion,
        identitySubjectHash,
        deviceHash,
      })
      await transaction.query(`
        UPDATE mbox.reservation_guest_sessions
        SET revoked_at = clock_timestamp(), revoke_reason = 'superseded'
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND customer_id = $3::uuid AND device_hash = $4 AND revoked_at IS NULL
      `, [transaction.scope.tenantId, transaction.scope.storeId, identity.customerId, deviceHash])
      const inserted = await transaction.query<SessionRow>(`
        INSERT INTO mbox.reservation_guest_sessions (
          tenant_id, store_id, customer_id, token_hash, device_hash,
          identity_provider, identity_subject_hash, scopes, issued_at, expires_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::text[], $9::timestamptz, $10::timestamptz
        )
        RETURNING id, customer_id, scopes, expires_at::text, revoked_at::text
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        identity.customerId,
        tokenHash,
        deviceHash,
        input.provider,
        identitySubjectHash,
        [...RESERVATION_GUEST_SCOPES],
        issuedAt.toISOString(),
        expiresAt.toISOString(),
      ])
      const row = requiredRow(inserted.rows[0], 'reservation guest session')
      const result: ReservationGuestSessionIssueResult = {
        sessionToken: token,
        session: {
          id: row.id,
          customerId: row.customer_id,
          actorRef: identity.actorRef,
          scopes: row.scopes,
          expiresAt: row.expires_at,
        },
      }
      return {
        result,
        auditEvents: [sessionAudit(input.businessDate, identity.actorRef, row.id, 'issued')],
        outboxMessages: [{
          aggregateType: 'reservation_guest_session',
          aggregateId: row.id,
          aggregateVersion: 1,
          eventType: 'reservation_guest_session.issued.v1',
          payload: { provider: input.provider, expiresAt: row.expires_at },
        }],
      }
    })
  }

  async authenticate(input: Readonly<{
    scope: Readonly<StoreScope>
    sessionToken: string
    deviceFingerprint: string
  }>): Promise<ReservationGuestSession> {
    requireText(input.sessionToken, 'sessionToken', 32, 256)
    requireText(input.deviceFingerprint, 'deviceFingerprint', 8, 512)
    const tokenHash = sha256(input.sessionToken)
    const deviceHash = sha256(input.deviceFingerprint)
    return this.transactions.run(input.scope, async (transaction) => {
      const selected = await transaction.query<SessionRow>(`
        UPDATE mbox.reservation_guest_sessions
        SET last_seen_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND token_hash = $3 AND device_hash = $4
          AND revoked_at IS NULL AND expires_at > clock_timestamp()
        RETURNING id, customer_id, scopes, expires_at::text, revoked_at::text
      `, [transaction.scope.tenantId, transaction.scope.storeId, tokenHash, deviceHash])
      const row = selected.rows[0]
      if (!row) throw new ReservationGuestSessionInvalidError()
      return {
        id: row.id,
        customerId: row.customer_id,
        actorRef: `reservation-session:${row.id}`,
        scopes: row.scopes,
        expiresAt: row.expires_at,
      }
    })
  }

  private async consumeRateLimit(
    scope: Readonly<StoreScope>,
    principalHash: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAt: string }> {
    return this.transactions.run(scope, async (transaction) => {
      const result = await transaction.query<RateRow>(`
        INSERT INTO mbox.public_reservation_rate_limits (
          tenant_id, store_id, action, principal_hash, window_started_at, attempt_count, expires_at
        ) VALUES (
          $1::uuid, $2::uuid, 'session', $3, clock_timestamp(), 1,
          clock_timestamp() + ($5::bigint * interval '1 millisecond')
        )
        ON CONFLICT (tenant_id, store_id, action, principal_hash)
        DO UPDATE SET
          attempt_count = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
            THEN 1 ELSE LEAST(mbox.public_reservation_rate_limits.attempt_count + 1, $4 + 1) END,
          window_started_at = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
            THEN clock_timestamp() ELSE mbox.public_reservation_rate_limits.window_started_at END,
          expires_at = CASE WHEN mbox.public_reservation_rate_limits.expires_at <= clock_timestamp()
            THEN clock_timestamp() + ($5::bigint * interval '1 millisecond')
            ELSE mbox.public_reservation_rate_limits.expires_at END
        RETURNING attempt_count, expires_at::text
      `, [transaction.scope.tenantId, transaction.scope.storeId, principalHash, limit, windowMs])
      const row = requiredRow(result.rows[0], 'reservation rate limit')
      return { allowed: Number(row.attempt_count) <= limit, retryAt: row.expires_at }
    })
  }
}

export function hashReservationGuestValue(value: string): string {
  return sha256(value)
}

const sessionIssueCodec: JsonCodec<ReservationGuestSessionIssueResult> = {
  encode: (value) => ({
    sessionToken: value.sessionToken,
    session: {
      id: value.session.id,
      customerId: value.session.customerId,
      actorRef: value.session.actorRef,
      scopes: value.session.scopes,
      expiresAt: value.session.expiresAt,
    },
  }),
  decode: (value) => {
    if (!isObject(value) || typeof value.sessionToken !== 'string' || !isObject(value.session)) {
      throw new TypeError('Stored reservation session result is invalid')
    }
    const session = value.session
    if (
      typeof session.id !== 'string'
      || typeof session.customerId !== 'string'
      || typeof session.actorRef !== 'string'
      || !Array.isArray(session.scopes)
      || !session.scopes.every((scope) => typeof scope === 'string')
      || typeof session.expiresAt !== 'string'
    ) throw new TypeError('Stored reservation session result is invalid')
    return {
      sessionToken: value.sessionToken,
      session: {
        id: session.id,
        customerId: session.customerId,
        actorRef: session.actorRef,
        scopes: session.scopes,
        expiresAt: session.expiresAt,
      },
    }
  },
}

function sessionAudit(
  businessDate: string,
  actorRef: string,
  sessionId: string,
  action: string,
): { actor: AuditActor; action: string; objectType: string; objectId: string; businessDate: string; afterData: JsonObject } {
  return {
    actor: { type: 'guest', ref: actorRef },
    action: `reservation_guest_session.${action}`,
    objectType: 'reservation_guest_session',
    objectId: sessionId,
    businessDate,
    afterData: { state: action },
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requireText(value: string, name: string, minimum: number, maximum: number): void {
  if (value.trim().length < minimum || value.length > maximum) {
    throw new TypeError(`${name} length is invalid`)
  }
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
