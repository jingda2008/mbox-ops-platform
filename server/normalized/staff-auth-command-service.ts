import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import type { AuditActor, CommandExecution, JsonCodec, JsonObject } from './command-executor.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import {
  StaffAccessRepository,
  type EffectiveStaffAccess,
  type EmployeePermissionOverrideInput,
  type PermissionDefinitionInput,
  type RoleApprovalLimitInput,
  type RoleDataScopeInput,
  type RoleNavigationInput,
  type RolePermissionInput,
} from './staff-access-repository.js'
import {
  DeviceAccessDeniedError,
  StaffSessionNotFoundError,
  StaffSessionRepository,
  hashDeviceKey,
  hashOpaqueToken,
  type StaffSession,
} from './staff-session-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type ScopedTransaction,
  type StoreScope,
} from './transaction-runner.js'

const SESSION_DURATION_MS = 6 * 60 * 60 * 1_000
const ONLINE_LEASE_MS = 90 * 1_000
const DEVICE_CREDENTIAL_WINDOW_MS = 30 * 60 * 60 * 1_000

export interface StaffLoginRateLimitAttempt {
  scope: Readonly<StoreScope>
  kind: 'daily_store_credential' | 'employee_pin'
  principalKey: string
  deviceKeyHash: string
}

export interface StaffLoginRateLimiter {
  consume(attempt: Readonly<StaffLoginRateLimitAttempt>): Promise<void>
  recordResult?(attempt: Readonly<StaffLoginRateLimitAttempt>, succeeded: boolean): Promise<void>
}

export interface CredentialHasher {
  hash(secret: string): Promise<string>
  verify(secret: string, encodedHash: string): Promise<boolean>
}

export interface AuthTokenSource {
  create(): string
}

export interface AuthClock {
  now(): Date
}

export interface DeviceAccessGrant {
  leaseToken: string
  leaseId: string
  businessDate: string
  expiresAt: string
}

export interface StaffLoginResult {
  sessionToken: string
  session: StaffSession
  access: EffectiveStaffAccess
}

export interface AuthenticatedStaffSession {
  session: StaffSession
  access: EffectiveStaffAccess
}

export interface AccessChangeMetadata {
  scope: Readonly<StoreScope>
  actorEmployeeId: string
  businessDate: string
  idempotencyKey: string
  requestFingerprint: string
  reason: string
}

export class InvalidStaffCredentialsError extends Error {
  constructor() {
    super('Employee code or PIN is invalid')
    this.name = 'InvalidStaffCredentialsError'
  }
}

export class StoreCredentialVerificationError extends Error {
  constructor() {
    super('Daily store credential is invalid')
    this.name = 'StoreCredentialVerificationError'
  }
}

export class StaffCredentialConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaffCredentialConfigurationError'
  }
}

export class ScryptCredentialHasher implements CredentialHasher {
  async hash(secret: string) {
    assertCredentialSecret(secret)
    const salt = randomBytes(16)
    const derived = await scrypt(secret, salt, 32)
    return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
  }

  async verify(secret: string, encodedHash: string) {
    try {
      const [algorithm, nText, rText, pText, saltText, digestText, extra] = encodedHash.split('$')
      if (algorithm !== 'scrypt' || extra !== undefined || !saltText || !digestText) return false
      const n = Number(nText)
      const r = Number(rText)
      const p = Number(pText)
      if (n !== 16_384 || r !== 8 || p !== 1) return false
      const salt = Buffer.from(saltText, 'base64url')
      const expected = Buffer.from(digestText, 'base64url')
      if (salt.length !== 16 || expected.length !== 32) return false
      const actual = await scrypt(secret, salt, expected.length)
      return timingSafeEqual(actual, expected)
    } catch {
      return false
    }
  }
}

export class StaffAuthCommandService {
  constructor(
    private readonly transactions: ScopedPostgresTransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly rateLimiter: StaffLoginRateLimiter,
    private readonly hasher: CredentialHasher = new ScryptCredentialHasher(),
    private readonly tokenSource: AuthTokenSource = {
      create: () => randomBytes(32).toString('base64url'),
    },
    private readonly clock: AuthClock = { now: () => new Date() },
  ) {}

  async configureDailyStoreCredential(input: Readonly<AccessChangeMetadata & {
    credential: string
    validFrom: string
    validUntil: string
  }>) {
    assertStoreCredential(input.credential)
    assertTimeRange(input.validFrom, input.validUntil)
    const credentialHash = await this.hasher.hash(input.credential)
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'staff.daily-credential.configure',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: jsonObjectCodec,
    }, async (transaction) => {
      await requireAccessAdministrator(transaction, input.actorEmployeeId)
      const credential = await new StaffSessionRepository(transaction).replaceDailyCredential({
        businessDate: input.businessDate,
        credentialHash,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        configuredByEmployeeId: input.actorEmployeeId,
        now: this.clock.now().toISOString(),
      })
      const result: JsonObject = {
        credentialId: credential.id,
        businessDate: credential.businessDate,
        validFrom: credential.validFrom,
        validUntil: credential.validUntil,
      }
      return accessChangeOutcome(input, 'staff.daily-credential.configured', 'store_daily_credential', credential.id, result)
    })
  }

  async setEmployeePin(input: Readonly<AccessChangeMetadata & {
    employeeId: string
    pin: string
  }>) {
    assertPin(input.pin)
    const pinHash = await this.hasher.hash(input.pin)
    return this.commands.execute({
      scope: input.scope,
      operationScope: 'staff.pin.configure',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: jsonObjectCodec,
    }, async (transaction) => {
      await requireAccessAdministrator(transaction, input.actorEmployeeId)
      await new StaffSessionRepository(transaction).updateEmployeePinHash(input.employeeId, pinHash)
      const result: JsonObject = { employeeId: input.employeeId, pinConfigured: true }
      return accessChangeOutcome(input, 'staff.pin.configured', 'employee', input.employeeId, result)
    })
  }

  upsertPermissionDefinition(input: Readonly<AccessChangeMetadata & PermissionDefinitionInput>) {
    return this.executeAccessChange(
      input,
      'staff.permission-definition.configured',
      'staff_permission_definition',
      async (repository) => {
        const id = await repository.upsertPermissionDefinition(input)
        return { id, code: input.code, status: input.status ?? 'active' }
      },
    )
  }

  setRolePermission(input: Readonly<AccessChangeMetadata & RolePermissionInput>) {
    return this.executeAccessChange(
      input,
      'staff.role-permission.configured',
      'role_permission_assignment',
      async (repository) => ({
        ...(await repository.setRolePermission(input)),
        roleId: input.roleId,
        permissionCode: input.permissionCode,
      }),
    )
  }

  setEmployeePermissionOverride(
    input: Readonly<AccessChangeMetadata & EmployeePermissionOverrideInput>,
  ) {
    return this.executeAccessChange(
      input,
      'staff.employee-permission-override.configured',
      'employee_permission_override',
      async (repository) => ({
        ...(await repository.setEmployeePermissionOverride(input)),
        employeeId: input.employeeId,
        permissionCode: input.permissionCode,
      }),
    )
  }

  setRoleDataScope(input: Readonly<AccessChangeMetadata & RoleDataScopeInput>) {
    return this.executeAccessChange(
      input,
      'staff.role-data-scope.configured',
      'role_data_scope',
      async (repository) => ({
        id: await repository.setRoleDataScope(input),
        roleId: input.roleId,
        scopeKey: input.scopeKey,
        effect: input.effect,
        enabled: input.enabled,
      }),
    )
  }

  setRoleApprovalLimit(input: Readonly<AccessChangeMetadata & RoleApprovalLimitInput>) {
    return this.executeAccessChange(
      input,
      'staff.role-approval-limit.configured',
      'role_approval_limit',
      async (repository) => ({
        id: await repository.setRoleApprovalLimit(input),
        roleId: input.roleId,
        approvalCode: input.approvalCode,
        amountMinor: input.amountMinor,
        currency: input.currency,
        enabled: input.enabled,
      }),
    )
  }

  setRoleNavigation(input: Readonly<AccessChangeMetadata & RoleNavigationInput>) {
    return this.executeAccessChange(
      input,
      'staff.role-navigation.configured',
      'role_navigation_item',
      async (repository) => ({
        id: await repository.setRoleNavigation(input),
        roleId: input.roleId,
        navigationCode: input.navigationCode,
        enabled: input.enabled,
      }),
    )
  }

  async verifyDailyStoreCredential(input: Readonly<{
    scope: Readonly<StoreScope>
    businessDate: string
    credential: string
    deviceKey: string
  }>): Promise<DeviceAccessGrant> {
    assertStoreCredential(input.credential)
    const now = this.clock.now().toISOString()
    const deviceKeyHash = hashDeviceKey(input.deviceKey)
    const attempt = rateLimitAttempt(input.scope, 'daily_store_credential', input.businessDate, deviceKeyHash)
    await this.rateLimiter.consume(attempt)
    try {
      const result = await this.transactions.run(input.scope, async (transaction) => {
        const repository = new StaffSessionRepository(transaction)
        await repository.lockDailyCredentialScope()
        let credential = await repository.findActiveDailyCredential(input.businessDate, now)
        const sourceCredential = credential ?? await repository.findReusableDailyCredential()
        if (!sourceCredential || !await this.hasher.verify(input.credential, sourceCredential.credentialHash)) {
          throw new StoreCredentialVerificationError()
        }
        if (!credential) {
          credential = await repository.renewReusableDailyCredential({
            source: sourceCredential,
            businessDate: input.businessDate,
            now,
            validUntil: new Date(this.clock.now().getTime() + DEVICE_CREDENTIAL_WINDOW_MS).toISOString(),
          })
          await appendSecurityEvidence(transaction, {
            actor: { type: 'system', ref: 'store-access-gate' },
            action: 'staff.daily-credential.renewed',
            objectType: 'store_daily_credential',
            objectId: credential.id,
            businessDate: input.businessDate,
            eventType: 'staff.daily-credential.renewed.v1',
            payload: {
              sourceCredentialId: sourceCredential.id,
              credentialId: credential.id,
              businessDate: input.businessDate,
              validUntil: credential.validUntil,
            },
          })
        }
        const leaseToken = this.tokenSource.create()
        const lease = await repository.createDeviceAccessLease({
          dailyCredentialId: credential.id,
          businessDate: input.businessDate,
          deviceKeyHash,
          leaseTokenHash: hashOpaqueToken(leaseToken),
          now,
          expiresAt: credential.validUntil,
        })
        await appendSecurityEvidence(transaction, {
          actor: { type: 'system', ref: 'store-access-gate' },
          action: 'staff.device-access.granted',
          objectType: 'store_device_access_lease',
          objectId: lease.id,
          businessDate: input.businessDate,
          eventType: 'staff.device-access.granted.v1',
          payload: { leaseId: lease.id, businessDate: lease.businessDate, expiresAt: lease.expiresAt },
        })
        return {
          leaseToken,
          leaseId: lease.id,
          businessDate: lease.businessDate,
          expiresAt: lease.expiresAt,
        }
      })
      await this.rateLimiter.recordResult?.(attempt, true)
      return result
    } catch (error) {
      await this.rateLimiter.recordResult?.(attempt, false)
      throw error
    }
  }

  async login(input: Readonly<{
    scope: Readonly<StoreScope>
    deviceAccessToken: string
    employeeCode: string
    pin: string
  }>): Promise<StaffLoginResult> {
    assertPin(input.pin)
    const deviceAccessHash = hashOpaqueToken(input.deviceAccessToken)
    return this.loginWithLease({
      scope: input.scope,
      deviceAccessHash,
      employeeCode: input.employeeCode,
      pin: input.pin,
      currentSession: null,
    })
  }

  async switchEmployee(input: Readonly<{
    scope: Readonly<StoreScope>
    currentSessionToken: string
    employeeCode: string
    pin: string
  }>): Promise<StaffLoginResult> {
    assertPin(input.pin)
    const now = this.clock.now().toISOString()
    const currentSessionHash = hashOpaqueToken(input.currentSessionToken)
    return this.transactions.run(input.scope, async (transaction) => {
      const sessionRepository = new StaffSessionRepository(transaction)
      const current = await sessionRepository.requireSession(currentSessionHash, now, true)
      const lease = await sessionRepository.requireDeviceAccessLeaseForSession(
        current.deviceAccessLeaseId,
        now,
      )
      return this.loginInsideTransaction({
        transaction,
        employeeCode: input.employeeCode,
        pin: input.pin,
        deviceAccessLeaseId: current.deviceAccessLeaseId,
        deviceKeyHash: lease.deviceKeyHash,
        currentSession: current,
        now,
      })
    })
  }

  async authenticateSession(
    scope: Readonly<StoreScope>,
    sessionToken: string,
  ): Promise<AuthenticatedStaffSession> {
    const now = this.clock.now().toISOString()
    const tokenHash = hashOpaqueToken(sessionToken)
    return this.transactions.run(scope, async (transaction) => {
      const session = await new StaffSessionRepository(transaction).requireSession(tokenHash, now)
      const access = await new StaffAccessRepository(transaction).resolve(session.employeeId, now)
      return { session, access }
    }, { readOnly: true })
  }

  async heartbeat(scope: Readonly<StoreScope>, sessionToken: string) {
    const nowDate = this.clock.now()
    const now = nowDate.toISOString()
    const tokenHash = hashOpaqueToken(sessionToken)
    return this.transactions.run(scope, async (transaction) => {
      const repository = new StaffSessionRepository(transaction)
      const current = await repository.requireSession(tokenHash, now, true)
      const session = await repository.heartbeat(
        current.id,
        now,
        new Date(nowDate.getTime() + ONLINE_LEASE_MS).toISOString(),
      )
      const access = await new StaffAccessRepository(transaction).resolve(session.employeeId, now)
      return { session, access }
    })
  }

  async revokeSession(input: Readonly<{
    scope: Readonly<StoreScope>
    sessionToken: string
    actorEmployeeId: string
    businessDate: string
    reason: string
  }>) {
    if (input.reason.trim().length === 0) throw new TypeError('Session revoke reason is required')
    const now = this.clock.now().toISOString()
    const tokenHash = hashOpaqueToken(input.sessionToken)
    return this.transactions.run(input.scope, async (transaction) => {
      const repository = new StaffSessionRepository(transaction)
      const current = await repository.requireSession(tokenHash, now, true)
      if (current.employeeId !== input.actorEmployeeId) {
        await new StaffAccessRepository(transaction).assertPermission(
          input.actorEmployeeId,
          'staff.session.revoke',
          now,
        )
      }
      const revoked = await repository.revokeSession(
        current.id,
        input.actorEmployeeId,
        input.reason,
        now,
      )
      await appendSecurityEvidence(transaction, {
        actor: { type: 'employee', employeeId: input.actorEmployeeId },
        action: 'staff.session.revoked',
        objectType: 'staff_session',
        objectId: revoked.id,
        businessDate: input.businessDate,
        eventType: 'staff.session.revoked.v1',
        payload: { sessionId: revoked.id, employeeId: revoked.employeeId, reason: input.reason },
        aggregateVersion: 2,
      })
      return revoked
    })
  }

  private async loginWithLease(input: {
    scope: Readonly<StoreScope>
    deviceAccessHash: string
    employeeCode: string
    pin: string
    currentSession: StaffSession | null
  }) {
    const now = this.clock.now().toISOString()
    return this.transactions.run(input.scope, async (transaction) => {
      const sessionRepository = new StaffSessionRepository(transaction)
      const lease = await sessionRepository.requireDeviceAccessLease(input.deviceAccessHash, now)
      return this.loginInsideTransaction({
        transaction,
        employeeCode: input.employeeCode,
        pin: input.pin,
        deviceAccessLeaseId: lease.id,
        deviceKeyHash: lease.deviceKeyHash,
        currentSession: input.currentSession,
        now,
      })
    })
  }

  private async loginInsideTransaction(input: {
    transaction: ScopedTransaction
    employeeCode: string
    pin: string
    deviceAccessLeaseId: string
    deviceKeyHash: string
    currentSession: StaffSession | null
    now: string
  }): Promise<StaffLoginResult> {
    const attempt = rateLimitAttempt(
      input.transaction.scope,
      'employee_pin',
      input.employeeCode,
      input.deviceKeyHash,
    )
    await this.rateLimiter.consume(attempt)
    try {
      const sessionRepository = new StaffSessionRepository(input.transaction)
      const employee = await sessionRepository.findEmployeeByCode(input.employeeCode)
      if (!employee || employee.status !== 'active' || !employee.pinHash
        || !await this.hasher.verify(input.pin, employee.pinHash)) {
        throw new InvalidStaffCredentialsError()
      }
      const nowDate = new Date(input.now)
      const expiresAt = new Date(nowDate.getTime() + SESSION_DURATION_MS)

      if (input.currentSession) {
        await sessionRepository.revokeSession(
          input.currentSession.id,
          input.currentSession.employeeId,
          'employee switched on device',
          input.now,
        )
      }
      const sessionToken = this.tokenSource.create()
      const session = await sessionRepository.createSession({
        employeeId: employee.id,
        deviceAccessLeaseId: input.deviceAccessLeaseId,
        sessionTokenHash: hashOpaqueToken(sessionToken),
        issuedAt: input.now,
        expiresAt: expiresAt.toISOString(),
        onlineLeaseUntil: new Date(Math.min(
          nowDate.getTime() + ONLINE_LEASE_MS,
          expiresAt.getTime(),
        )).toISOString(),
      })
      const access = await new StaffAccessRepository(input.transaction).resolve(employee.id, input.now)
      await appendSecurityEvidence(input.transaction, {
        actor: { type: 'employee', employeeId: employee.id },
        action: 'staff.session.started',
        objectType: 'staff_session',
        objectId: session.id,
        businessDate: await businessDateForLease(input.transaction, input.deviceAccessLeaseId),
        eventType: 'staff.session.started.v1',
        payload: {
          sessionId: session.id,
          employeeId: employee.id,
          expiresAt: session.expiresAt,
        },
      })
      await this.rateLimiter.recordResult?.(attempt, true)
      return { sessionToken, session, access }
    } catch (error) {
      await this.rateLimiter.recordResult?.(attempt, false)
      throw error
    }
  }

  private executeAccessChange(
    input: Readonly<AccessChangeMetadata>,
    action: string,
    objectType: string,
    handler: (repository: StaffAccessRepository) => Promise<JsonObject>,
  ): Promise<CommandExecution<JsonObject>> {
    return this.commands.execute({
      scope: input.scope,
      operationScope: action,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      resultCodec: jsonObjectCodec,
    }, async (transaction) => {
      await requireAccessAdministrator(transaction, input.actorEmployeeId)
      const result = await handler(new StaffAccessRepository(transaction))
      const objectId = typeof result.id === 'string' ? result.id : input.actorEmployeeId
      return accessChangeOutcome(input, action, objectType, objectId, result)
    })
  }
}

async function requireAccessAdministrator(transaction: ScopedTransaction, employeeId: string) {
  await new StaffAccessRepository(transaction).assertPermission(
    employeeId,
    'staff.access.configure',
  )
}

function accessChangeOutcome(
  input: Readonly<AccessChangeMetadata>,
  action: string,
  objectType: string,
  objectId: string,
  result: JsonObject,
) {
  return {
    result,
    auditEvents: [{
      actor: { type: 'employee', employeeId: input.actorEmployeeId } as AuditActor,
      action,
      objectType,
      objectId,
      businessDate: input.businessDate,
      reason: input.reason,
      afterData: result,
    }],
    outboxMessages: [{
      eventId: `staff-access:${input.idempotencyKey}`,
      aggregateType: objectType,
      aggregateId: objectId,
      aggregateVersion: 1,
      eventType: `${action}.v1`,
      payload: result,
    }],
  }
}

async function appendSecurityEvidence(transaction: ScopedTransaction, event: {
  actor: AuditActor
  action: string
  objectType: string
  objectId: string
  businessDate: string
  eventType: string
  payload: JsonObject
  aggregateVersion?: number
}) {
  const audit = await transaction.query(`
    INSERT INTO mbox.audit_events (
      tenant_id, store_id, actor_type, actor_employee_id, actor_ref,
      action, object_type, object_id, after_snapshot, business_date
    ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::date)
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    event.actor.type,
    event.actor.type === 'employee' ? event.actor.employeeId : null,
    event.actor.ref ?? null,
    event.action,
    event.objectType,
    event.objectId,
    JSON.stringify(event.payload),
    event.businessDate,
  ])
  if (audit.rowCount !== 1) throw new Error('Staff security audit was not persisted')
  const outbox = await transaction.query(`
    INSERT INTO mbox.outbox_messages (
      tenant_id, store_id, message_key, aggregate_type, aggregate_id,
      aggregate_version, message_type, payload
    ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::bigint, $7, $8::jsonb)
  `, [
    transaction.scope.tenantId,
    transaction.scope.storeId,
    `${event.eventType}:${event.objectId}:${event.aggregateVersion ?? 1}`,
    event.objectType,
    event.objectId,
    event.aggregateVersion ?? 1,
    event.eventType,
    JSON.stringify(event.payload),
  ])
  if (outbox.rowCount !== 1) throw new Error('Staff security outbox message was not persisted')
}

async function businessDateForLease(transaction: ScopedTransaction, leaseId: string) {
  const result = await transaction.query<{ business_date: string }>(`
    SELECT business_date::text
    FROM mbox.store_device_access_leases
    WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, leaseId])
  const row = result.rows[0]
  if (!row) throw new DeviceAccessDeniedError()
  return row.business_date
}

function rateLimitAttempt(
  scope: Readonly<StoreScope>,
  kind: StaffLoginRateLimitAttempt['kind'],
  principalKey: string,
  deviceKeyHash: string,
): StaffLoginRateLimitAttempt {
  return { scope, kind, principalKey, deviceKeyHash }
}

function assertPin(pin: string) {
  if (!/^\d{4}$/.test(pin)) throw new StaffCredentialConfigurationError('Employee PIN must be exactly four digits')
}

function assertStoreCredential(credential: string) {
  if (credential.length < 6 || credential.length > 128) {
    throw new StaffCredentialConfigurationError('Daily store credential must contain 6 to 128 characters')
  }
}

function assertCredentialSecret(secret: string) {
  if (secret.length < 4 || secret.length > 128) {
    throw new StaffCredentialConfigurationError('Credential secret length is invalid')
  }
}

function assertTimeRange(validFrom: string, validUntil: string) {
  const startsAt = new Date(validFrom).getTime()
  const endsAt = new Date(validUntil).getTime()
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    throw new StaffCredentialConfigurationError('Daily store credential validity is invalid')
  }
}

function scrypt(secret: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(secret, salt, keyLength, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

const jsonObjectCodec: JsonCodec<JsonObject> = {
  encode: (value) => value,
  decode: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Stored staff access result is invalid')
    }
    return value as JsonObject
  },
}

export { StaffSessionNotFoundError }
