import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import type {
  StaffLoginRateLimitAttempt,
  StaffLoginRateLimiter,
} from './staff-auth-command-service.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const WINDOW_MS = 10 * 60 * 1_000
const LIMITS: Record<StaffLoginRateLimitAttempt['kind'], number> = {
  daily_store_credential: 5,
  employee_pin: 8,
}

type Bucket = { principalHash: string; deviceHash: string; limit: number }
type Reservation = Bucket & { expiresAt: string }

type TransactionExecutor = Pick<ScopedPostgresTransactionRunner, 'run'>

export class StaffLoginRateLimitError extends Error {
  readonly retryAt: string

  constructor(retryAt: string) {
    super('Staff login attempt limit exceeded')
    this.name = 'StaffLoginRateLimitError'
    this.retryAt = retryAt
  }
}

export class PostgresStaffLoginRateLimiter implements StaffLoginRateLimiter {
  private readonly reservations = new WeakMap<Readonly<StaffLoginRateLimitAttempt>, Reservation[]>()

  constructor(
    private readonly transactions: TransactionExecutor,
    private readonly hashSecret: string,
  ) {
    if (hashSecret.length < 32) {
      throw new TypeError('Staff login rate-limit hash secret must contain at least 32 characters')
    }
  }

  async consume(attempt: Readonly<StaffLoginRateLimitAttempt>): Promise<void> {
    const buckets = this.buckets(attempt)
    const result = await this.transactions.run(attempt.scope, async (transaction) => {
      const reservations: Reservation[] = []
      // Fixed store -> source -> account -> device order bounds row creation and lock ordering.
      for (const bucket of buckets) {
        const consumed = await transaction.query<{ attempt_count: number; expires_at: string }>(`
          WITH rate_limit_clock AS MATERIALIZED (
            SELECT clock_timestamp() AS current_at
          ), rate_limit_window AS (
            SELECT
              current_at,
              to_timestamp(
                floor(extract(epoch FROM current_at) * 1000 / $7::bigint)
                * $7::bigint / 1000
              ) AS window_started_at
            FROM rate_limit_clock
          )
          INSERT INTO mbox.staff_login_rate_limits (
            tenant_id,
            store_id,
            attempt_kind,
            principal_hash,
            device_key_hash,
            window_started_at,
            attempt_count,
            expires_at
          )
          SELECT
            $1::uuid,
            $2::uuid,
            $3,
            $4,
            $5,
            window_started_at,
            1,
            window_started_at + make_interval(secs => $7::double precision / 1000)
          FROM rate_limit_window
          ON CONFLICT (tenant_id, store_id, attempt_kind, principal_hash, device_key_hash)
          DO UPDATE SET
            window_started_at = CASE
              WHEN mbox.staff_login_rate_limits.expires_at <= clock_timestamp()
                THEN EXCLUDED.window_started_at
              ELSE mbox.staff_login_rate_limits.window_started_at
            END,
            attempt_count = CASE
              WHEN mbox.staff_login_rate_limits.expires_at <= clock_timestamp() THEN 1
              ELSE LEAST(mbox.staff_login_rate_limits.attempt_count + 1, $6::integer + 1)
            END,
            expires_at = CASE
              WHEN mbox.staff_login_rate_limits.expires_at <= clock_timestamp()
                THEN EXCLUDED.expires_at
              ELSE mbox.staff_login_rate_limits.expires_at
            END
          RETURNING attempt_count, expires_at::text
        `, [
          transaction.scope.tenantId,
          transaction.scope.storeId,
          attempt.kind,
          bucket.principalHash,
          bucket.deviceHash,
          bucket.limit,
          WINDOW_MS,
        ])
        const row = consumed.rows[0]
        if (consumed.rowCount !== 1 || !row) {
          throw new Error('Staff login rate-limit attempt was not persisted')
        }
        if (Number(row.attempt_count) > bucket.limit) return { blockedUntil: row.expires_at, reservations }
        reservations.push({ ...bucket, expiresAt: row.expires_at })
      }
      return { blockedUntil: null, reservations }
    })

    // Throw after commit: a rejected request must not roll back the shared counters.
    if (result.blockedUntil) {
      throw new StaffLoginRateLimitError(new Date(result.blockedUntil).toISOString())
    }
    this.reservations.set(attempt, result.reservations)
  }

  async recordResult(
    attempt: Readonly<StaffLoginRateLimitAttempt>,
    succeeded: boolean,
  ): Promise<void> {
    const reservations = this.reservations.get(attempt)
    this.reservations.delete(attempt)
    if (!succeeded || !reservations) return
    await this.transactions.run(attempt.scope, async (transaction) => {
      for (const reservation of reservations) {
        // Release only this successful attempt, never other users' failures. Matching
        // the window also prevents a late success from reducing a new window's count.
        await transaction.query(`
          UPDATE mbox.staff_login_rate_limits
          SET attempt_count = GREATEST(0, attempt_count - 1)
          WHERE tenant_id = $1::uuid AND store_id = $2::uuid
            AND attempt_kind = $3 AND principal_hash = $4 AND device_key_hash = $5
            AND expires_at = $6::timestamptz
        `, [attempt.scope.tenantId, attempt.scope.storeId, attempt.kind,
          reservation.principalHash, reservation.deviceHash, reservation.expiresAt])
      }
    })
  }

  private buckets(attempt: Readonly<StaffLoginRateLimitAttempt>): Bucket[] {
    const principalHash = this.hashPrincipal(attempt)
    let source = attempt.sourceKey ?? 'unknown'
    if (source.startsWith('::ffff:') && isIP(source.slice(7)) === 4) source = source.slice(7)
    if (isIP(source) === 6) source = new URL(`http://[${source}]/`).hostname.slice(1, -1)
    if (source !== 'unknown' && !isIP(source)) throw new TypeError('Staff login source is invalid')
    const shared = (dimension: string, key: string, limit: number): Bucket => ({
      principalHash: createHmac('sha256', this.hashSecret)
        .update(JSON.stringify(['mbox-staff-login-shared-v1', attempt.scope.tenantId,
          attempt.scope.storeId, attempt.kind, dimension, key])).digest('hex'),
      deviceHash: '0'.repeat(64),
      limit,
    })
    // Failed/in-flight attempts per 10-minute window. Normal successes return their
    // slot, supporting shared venue NAT and shift changes without clearing attacks.
    return [
      shared('store', '', 200),
      shared('source', source, 40),
      ...(attempt.kind === 'employee_pin' ? [shared('account', principalHash, 8)] : []),
      { principalHash, deviceHash: attempt.deviceKeyHash, limit: LIMITS[attempt.kind] },
    ]
  }

  async cleanupExpired(
    scope: Readonly<StaffLoginRateLimitAttempt['scope']>,
    limit = 50,
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('limit must be an integer between 1 and 50')
    }
    return this.transactions.run(scope, async (transaction) => {
      const deleted = await transaction.query<{ id: string }>(`
        WITH candidates AS (
          SELECT id
          FROM mbox.staff_login_rate_limits
          WHERE tenant_id = $1::uuid
            AND store_id = $2::uuid
            AND expires_at <= clock_timestamp()
          ORDER BY expires_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        DELETE FROM mbox.staff_login_rate_limits rate_limit
        USING candidates
        WHERE rate_limit.tenant_id = $1::uuid
          AND rate_limit.store_id = $2::uuid
          AND rate_limit.id = candidates.id
        RETURNING rate_limit.id
      `, [transaction.scope.tenantId, transaction.scope.storeId, limit])
      return deleted.rows.length
    })
  }

  private hashPrincipal(attempt: Readonly<StaffLoginRateLimitAttempt>): string {
    if (!attempt.principalKey || attempt.principalKey.length > 512) {
      throw new TypeError('Staff login rate-limit principal is invalid')
    }
    if (!/^[0-9a-f]{64}$/.test(attempt.deviceKeyHash)) {
      throw new TypeError('Staff login rate-limit device hash is invalid')
    }
    return createHmac('sha256', this.hashSecret)
      .update('mbox-normalized-staff-login-v1\0')
      .update(attempt.scope.tenantId)
      .update('\0')
      .update(attempt.scope.storeId)
      .update('\0')
      .update(attempt.kind)
      .update('\0')
      .update(attempt.principalKey.trim().toLocaleLowerCase('en-US'))
      .digest('hex')
  }
}
