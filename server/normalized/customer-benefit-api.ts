import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  BenefitAuthorizationError,
  BenefitCommandService,
  BenefitIdempotencyConflictError,
  BenefitNotFoundError,
  BenefitOwnershipError,
  BenefitRepository,
  BenefitReservationNotFoundError,
  BenefitUnavailableError,
} from './benefit-repository.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  type JsonObject,
} from './command-executor.js'
import {
  CustomerCommandService,
  CustomerIdentityConflictError,
  CustomerMergeConflictError,
  CustomerNotFoundError,
  CustomerRepository,
  type CustomerIdentityKind,
} from './customer-repository.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type {
  ScopedPostgresTransactionRunner,
  ScopedTransaction,
  StoreScope,
} from './transaction-runner.js'

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export interface CustomerBenefitGuestContext {
  scope: Readonly<StoreScope>
  customerId: string
  tableSessionId: string | null
  businessDate: string
  actorRef: string
}

export interface CustomerBenefitStaffContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export interface CustomerBenefitApiOptions {
  transactions: TransactionRunner
  customers: CustomerCommandService
  benefits: BenefitCommandService
  now?: () => Date
  resolveGuestContext(request: FastifyRequest): Promise<CustomerBenefitGuestContext> | CustomerBenefitGuestContext
  resolveStaffContext(request: FastifyRequest): Promise<CustomerBenefitStaffContext> | CustomerBenefitStaffContext
  createCustomerRepository?(transaction: ScopedTransaction): CustomerRepository
  createBenefitRepository?(transaction: ScopedTransaction): BenefitRepository
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

interface ApiErrorBody { error: { code: string; message: string } }

class CustomerBenefitRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustomerBenefitRequestError'
  }
}

export const customerBenefitApiPlugin: FastifyPluginAsync<CustomerBenefitApiOptions> = async (
  app,
  options,
) => {
  app.get('/guest/customer/profile', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveGuestContext(request)
    const customer = await options.transactions.run(context.scope, async (transaction) =>
      customerRepository(options, transaction).findPublicById(context.customerId), { readOnly: true })
    if (customer === null) throw new CustomerNotFoundError(context.customerId)
    return reply.send({ data: customer })
  }))

  app.get('/guest/customer/benefits', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveGuestContext(request)
    const benefits = await options.transactions.run(context.scope, async (transaction) =>
      benefitRepository(options, transaction).listAvailableForCustomer(context.customerId), { readOnly: true })
    return reply.send({ data: benefits.map(toPublicBenefit) })
  }))

  app.post('/guest/customer/benefits/:benefitId/reservations', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      if (context.tableSessionId === null) throw new CustomerBenefitRequestError('请在入座后预约使用权益')
      const body = readObject(request.body)
      const benefitId = readRouteId(request.params, 'benefitId')
      const idempotencyKey = readIdempotencyKey(request)
      const quantity = readInteger(body.quantity, '数量', 1, 100, 1)
      const result = await options.benefits.reserve({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        benefitId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        quantity,
        expiresAt: reservationExpiresAt(options),
        reservationIdempotencyKey: idempotencyKey,
        reservationFingerprint: fingerprint({
          benefitId,
          customerId: context.customerId,
          tableSessionId: context.tableSessionId,
          quantity,
        }),
      })
      return reply.code(201).send({ data: toPublicReservation(result.value), meta: { replayed: result.replayed } })
    }))

  app.post('/guest/customer/benefit-reservations/:reservationId/cancel', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveGuestContext(request)
      if (context.tableSessionId === null) throw new CustomerBenefitRequestError('当前没有可操作的桌次')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const idempotencyKey = readIdempotencyKey(request)
      const reason = readString(body.reason, '取消原因', 256, 2)
      const result = await options.benefits.cancelReservation({
        scope: context.scope,
        actor: { type: 'guest', ref: context.actorRef },
        businessDate: context.businessDate,
        benefitReservationId: reservationId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        reason,
        cancellationIdempotencyKey: idempotencyKey,
        cancellationFingerprint: fingerprint({ reservationId, reason, tableSessionId: context.tableSessionId }),
      })
      return reply.send({ data: toPublicReservation(result.value), meta: { replayed: result.replayed } })
    }))

  app.get('/customers/:publicId', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const customer = await options.transactions.run(context.scope, async (transaction) => {
      await staffAccess(options, transaction).assertPermission(context.employeeId, 'customer.view')
      return customerRepository(options, transaction).findByPublicId(readRouteId(request.params, 'publicId'))
    }, { readOnly: true })
    if (customer === null) throw new CustomerNotFoundError('public')
    return reply.send({ data: toStaffCustomer(customer) })
  }))

  app.get('/customers/:publicId/history', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      await staffAccess(options, transaction).assertPermission(context.employeeId, 'customer.view')
      const repository = customerRepository(options, transaction)
      const customer = await repository.findByPublicId(readRouteId(request.params, 'publicId'))
      if (customer === null) throw new CustomerNotFoundError('public')
      return repository.listHistory(customer.id, readLimit(request.query))
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.patch('/customers/:customerId/profile', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const customerId = readRouteId(request.params, 'customerId')
    const idempotencyKey = readIdempotencyKey(request)
    const reason = readString(body.reason, '修改原因', 256, 2)
    const profile = readProfile(body.profile)
    const result = await options.customers.updateProfile({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      customerId,
      profile,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ customerId, profile, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/customers/:customerId/identities', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const customerId = readRouteId(request.params, 'customerId')
    const identityKind = readIdentityKind(body.identityKind)
    const identityHash = readHash(body.identityHash)
    const reason = readString(body.reason, '绑定原因', 256, 2)
    const idempotencyKey = readIdempotencyKey(request)
    const result = await options.customers.linkIdentity({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      customerId,
      identityKind,
      identityHash,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ customerId, identityKind, identityHash, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/customers/merge', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'customer.manage')
    const body = readObject(request.body)
    const sourceCustomerId = readString(body.sourceCustomerId, '源客户', 64, 8)
    const targetCustomerId = readString(body.targetCustomerId, '目标客户', 64, 8)
    const reason = readString(body.reason, '合并原因', 256, 2)
    const idempotencyKey = readIdempotencyKey(request)
    const result = await options.customers.merge({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      sourceCustomerId,
      targetCustomerId,
      reason,
      idempotencyKey,
      requestFingerprint: fingerprint({ sourceCustomerId, targetCustomerId, reason }),
    })
    return reply.send({ data: toStaffCustomer(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/benefits', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'benefit.issue')
    const body = readObject(request.body)
    const idempotencyKey = readIdempotencyKey(request)
    const input = readIssueBenefit(body)
    const result = await options.benefits.issue({
      ...input,
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      issuedByEmployeeId: context.employeeId,
      issuanceIdempotencyKey: idempotencyKey,
      issuanceFingerprint: fingerprint(input),
    })
    return reply.code(201).send({ data: toStaffBenefit(result.value), meta: { replayed: result.replayed } })
  }))

  app.post('/benefits/:benefitId/reservations', async (request, reply) => handleRoute(reply, async () => {
    const context = await options.resolveStaffContext(request)
    await assertPermission(options, context, 'benefit.redeem')
    const body = readObject(request.body)
    const benefitId = readRouteId(request.params, 'benefitId')
    const idempotencyKey = readIdempotencyKey(request)
    const customerId = readString(body.customerId, '客户', 64, 8)
    const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
    const quantity = readInteger(body.quantity, '数量', 1, 100, 1)
    const result = await options.benefits.reserve({
      scope: context.scope,
      actor: { type: 'employee', employeeId: context.employeeId },
      businessDate: context.businessDate,
      benefitId,
      customerId,
      tableSessionId,
      quantity,
      expiresAt: reservationExpiresAt(options),
      reservationIdempotencyKey: idempotencyKey,
      reservationFingerprint: fingerprint({ benefitId, customerId, tableSessionId, quantity }),
    })
    return reply.code(201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/benefit-reservations/:reservationId/redeem', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'benefit.redeem')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const idempotencyKey = readIdempotencyKey(request)
      const benefitId = readString(body.benefitId, '权益', 64, 8)
      const customerId = readString(body.customerId, '客户', 64, 8)
      const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
      const result = await options.benefits.redeem({
        scope: context.scope,
        actor: { type: 'employee', employeeId: context.employeeId },
        businessDate: context.businessDate,
        benefitId,
        benefitReservationId: reservationId,
        customerId,
        tableSessionId,
        redeemedByEmployeeId: context.employeeId,
        authorizationSource: { kind: 'employee', employeeId: context.employeeId },
        redemptionIdempotencyKey: idempotencyKey,
        redemptionFingerprint: fingerprint({ benefitId, reservationId, customerId, tableSessionId }),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }))

  app.post('/benefit-reservations/:reservationId/cancel', async (request, reply) =>
    handleRoute(reply, async () => {
      const context = await options.resolveStaffContext(request)
      await assertPermission(options, context, 'benefit.cancel')
      const body = readObject(request.body)
      const reservationId = readRouteId(request.params, 'reservationId')
      const customerId = readString(body.customerId, '客户', 64, 8)
      const tableSessionId = readString(body.tableSessionId, '桌次', 64, 8)
      const reason = readString(body.reason, '取消原因', 256, 2)
      const idempotencyKey = readIdempotencyKey(request)
      const result = await options.benefits.cancelReservation({
        scope: context.scope,
        actor: { type: 'employee', employeeId: context.employeeId },
        businessDate: context.businessDate,
        benefitReservationId: reservationId,
        customerId,
        tableSessionId,
        reason,
        cancellationIdempotencyKey: idempotencyKey,
        cancellationFingerprint: fingerprint({ reservationId, customerId, tableSessionId, reason }),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }))
}

async function assertPermission(
  options: CustomerBenefitApiOptions,
  context: CustomerBenefitStaffContext,
  permission: string,
): Promise<void> {
  await options.transactions.run(context.scope, async (transaction) =>
    staffAccess(options, transaction).assertPermission(context.employeeId, permission), { readOnly: true })
}

function customerRepository(options: CustomerBenefitApiOptions, transaction: ScopedTransaction): CustomerRepository {
  return options.createCustomerRepository?.(transaction) ?? new CustomerRepository(transaction)
}

function benefitRepository(options: CustomerBenefitApiOptions, transaction: ScopedTransaction): BenefitRepository {
  return options.createBenefitRepository?.(transaction) ?? new BenefitRepository(transaction)
}

function staffAccess(
  options: CustomerBenefitApiOptions,
  transaction: ScopedTransaction,
): Pick<StaffAccessRepository, 'assertPermission'> {
  return options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
}

function toPublicBenefit(benefit: Awaited<ReturnType<BenefitRepository['listAvailableForCustomer']>>[number]) {
  return {
    id: benefit.id,
    code: benefit.benefitCode,
    type: benefit.benefitType,
    valueAmountMinor: benefit.valueAmountMinor,
    currency: benefit.currency,
    display: publicDisplay(benefit.benefitSnapshot),
    quantityAvailable: benefit.quantityAvailable,
    validFrom: benefit.validFrom,
    validUntil: benefit.validUntil,
  }
}

function toStaffBenefit(benefit: Awaited<ReturnType<BenefitRepository['issue']>>) {
  return { ...toPublicBenefit(benefit), customerId: benefit.customerId, status: benefit.status,
    issuedByEmployeeId: benefit.issuedByEmployeeId, issuanceReason: benefit.issuanceReason }
}

function publicDisplay(snapshot: JsonObject): JsonObject {
  const display = snapshot.publicDisplay
  return isObject(display) ? display : {}
}

function toPublicReservation(value: { id: string; benefitId: string; quantity: number; status: string; expiresAt: string }) {
  return { id: value.id, benefitId: value.benefitId, quantity: value.quantity,
    status: value.status, expiresAt: value.expiresAt }
}

function toStaffCustomer(customer: Awaited<ReturnType<CustomerRepository['resolveCanonical']>>) {
  return {
    id: customer.id,
    publicId: customer.publicId,
    status: customer.status,
    firstSeenAt: customer.firstSeenAt,
    lastSeenAt: customer.lastSeenAt,
    profile: customer.profile,
    identityKinds: customer.identities.filter((identity) => identity.status === 'active')
      .map((identity) => identity.kind),
  }
}

function readIssueBenefit(body: JsonObject) {
  const authorizationLimitId = readString(body.authorizationLimitId, '审批额度来源', 64, 8)
  const validFrom = readOptionalTimestamp(body.validFrom, '生效时间')
  const validUntil = readOptionalTimestamp(body.validUntil, '失效时间')
  return {
    customerId: readString(body.customerId, '客户', 64, 8),
    benefitCode: readString(body.benefitCode, '权益编码', 64, 2),
    benefitType: readEnum(body.benefitType, ['gift_product', 'discount', 'credit', 'access', 'other'], '权益类型'),
    valueAmountMinor: readOptionalInteger(body.valueAmountMinor, '权益金额', 0, Number.MAX_SAFE_INTEGER),
    currency: readOptionalString(body.currency, '币种', 3, 3),
    quantity: readInteger(body.quantity, '数量', 1, 10_000, 1),
    benefitSnapshot: readOptionalObject(body.benefitSnapshot),
    ...(validFrom === null ? {} : { validFrom }),
    ...(validUntil === null ? {} : { validUntil }),
    authorizationLimitId,
    reason: readString(body.reason, '赠送原因', 256, 2),
    authorizationSource: { kind: 'role_approval_limit', approvalLimitId: authorizationLimitId },
  }
}

function readProfile(value: unknown) {
  const body = readObject(value)
  return {
    displayName: readOptionalString(body.displayName, '称呼', 128, 1),
    tags: readStringArray(body.tags, '标签'),
    publicTags: readStringArray(body.publicTags, '公开标签'),
    preferences: readOptionalObject(body.preferences),
    publicPreferenceKeys: readStringArray(body.publicPreferenceKeys, '公开偏好键'),
    consentSnapshot: readOptionalObject(body.consentSnapshot),
  }
}

async function handleRoute(reply: FastifyReply, operation: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try { return await operation() } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return apiError(401, 'CUSTOMER_BENEFIT_AUTH_REQUIRED', '登录或桌边会话已过期，请重新验证')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return apiError(403, 'CUSTOMER_BENEFIT_STORE_FORBIDDEN', '当前门店不可用或无权访问')
  }
  if (error instanceof StaffAccessDeniedError || error instanceof BenefitAuthorizationError) {
    return apiError(403, 'CUSTOMER_BENEFIT_FORBIDDEN', '当前账号无权执行此操作，或赠送额度不足')
  }
  if (error instanceof CustomerNotFoundError || error instanceof BenefitNotFoundError
    || error instanceof BenefitReservationNotFoundError) {
    return apiError(404, 'CUSTOMER_BENEFIT_NOT_FOUND', '客户或权益不存在')
  }
  if (error instanceof BenefitOwnershipError) {
    return apiError(403, 'BENEFIT_OWNERSHIP_MISMATCH', '该权益不属于当前桌次客户')
  }
  if (error instanceof BenefitUnavailableError) {
    return apiError(409, 'BENEFIT_UNAVAILABLE', '权益已过期、已用完或状态已变化')
  }
  if (error instanceof BenefitIdempotencyConflictError || error instanceof CustomerIdentityConflictError
    || error instanceof CustomerMergeConflictError || error instanceof IdempotencyConflictError) {
    return apiError(409, 'CUSTOMER_BENEFIT_CONFLICT', error.message)
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(409, 'CUSTOMER_BENEFIT_IN_PROGRESS', '相同操作正在处理中，请稍候查看结果')
  }
  if (error instanceof CustomerBenefitRequestError || error instanceof TypeError) {
    return apiError(400, 'CUSTOMER_BENEFIT_REQUEST_INVALID', error.message)
  }
  return apiError(500, 'CUSTOMER_BENEFIT_INTERNAL_ERROR', '客户权益服务暂时不可用，请稍后再试')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}

function readObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new CustomerBenefitRequestError('请求内容格式不正确')
  return value as JsonObject
}

function readOptionalObject(value: unknown): JsonObject {
  return value === undefined || value === null ? {} : readObject(value)
}

function readRouteId(value: unknown, key: string): string {
  const params = readObject(value)
  return readString(params[key], key, 128, 1)
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new CustomerBenefitRequestError('缺少有效的幂等请求标识')
  }
  return value
}

function readString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new CustomerBenefitRequestError(`${label}格式不正确`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new CustomerBenefitRequestError(`${label}长度不正确`)
  }
  return normalized
}

function readOptionalString(value: unknown, label: string, maximum: number, minimum = 1): string | null {
  return value === undefined || value === null ? null : readString(value, label, maximum, minimum)
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CustomerBenefitRequestError(`${label}必须是有效整数`)
  }
  return value as number
}

function readOptionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  return value === undefined || value === null ? null : readInteger(value, label, minimum, maximum, minimum)
}

function readTimestamp(value: unknown, label: string): string {
  const timestamp = readString(value, label, 64, 10)
  if (!Number.isFinite(Date.parse(timestamp))) throw new CustomerBenefitRequestError(`${label}格式不正确`)
  return timestamp
}

function readOptionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : readTimestamp(value, label)
}

function readStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    throw new CustomerBenefitRequestError(`${label}格式不正确`)
  }
  return value as string[]
}

function readIdentityKind(value: unknown): CustomerIdentityKind {
  return readEnum(value, ['anonymous', 'wechat', 'member', 'manual'], '身份类型')
}

function readHash(value: unknown): string {
  const hash = readString(value, '身份摘要', 64, 64)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new CustomerBenefitRequestError('身份摘要格式不正确')
  return hash
}

function readEnum<const Value extends string>(value: unknown, values: readonly Value[], label: string): Value {
  if (typeof value !== 'string' || !values.includes(value as Value)) {
    throw new CustomerBenefitRequestError(`${label}不正确`)
  }
  return value as Value
}

function readLimit(query: unknown): number {
  if (!isObject(query) || query.limit === undefined) return 50
  const value = Number(query.limit)
  return Number.isSafeInteger(value) && value >= 1 && value <= 200 ? value : 50
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function reservationExpiresAt(options: CustomerBenefitApiOptions): string {
  const now = options.now?.() ?? new Date()
  return new Date(now.getTime() + 15 * 60_000).toISOString()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`
  return JSON.stringify(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
