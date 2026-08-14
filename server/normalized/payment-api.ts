import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { AuditActor, CommandExecution, JsonObject, JsonValue } from './command-executor.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import type { PaymentCommandService } from './payment-command-service.js'
import type { CashierWorkbenchView } from '../../src/shared/cashier-workbench-contracts.js'
import type { CashierWorkbenchQueryInput } from './cashier-workbench-query.js'
import {
  OrderNotPayableError,
  PaymentCallbackMismatchError,
  PaymentEvidenceError,
  PaymentNotFoundError,
  PaymentTransitionError,
  type Payment,
  type PaymentProvider,
} from './payment-repository.js'
import {
  PaymentAuthorizationError,
  sanitizeClientPaymentHints,
  sanitizeClientRefundEvidence,
  sanitizeProviderSnapshot,
} from './payment-security-policy.js'
import { ReconciliationConflictError, type ReconciliationEntry } from './reconciliation-repository.js'
import {
  RefundApprovalRequiredError,
  RefundCallbackMismatchError,
  RefundLimitError,
  RefundNotFoundError,
  RefundTransitionError,
  type RefundAllocation,
} from './refund-repository.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { StaffAccessDeniedError, StaffNotFoundError } from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { StoreScope } from './transaction-runner.js'
import type { OnlinePaymentAction, OnlinePaymentService } from './online-payment-service.js'
import {
  OnlinePaymentUnavailableError,
  OnlinePaymentUnknownError,
} from './online-payment-service.js'
import {
  ProviderPaymentInProgressError,
  ProviderPaymentMethodConflictError,
  ProviderPaymentUnknownError,
  WechatPaymentIdentityRequiredError,
  type ProviderPaymentContext,
} from './payment-provider-action-repository.js'
import { PostarPaymentRejectedError } from '../postar-adapter.js'

type PaymentCommandPort = Pick<
  PaymentCommandService,
  | 'initiate'
  | 'recordManual'
  | 'recordSucceededCallback'
  | 'recordProviderQueryResult'
  | 'requestRefund'
  | 'approveRefund'
  | 'rejectRefund'
  | 'beginRefundExecution'
  | 'recordProviderRefundResult'
  | 'recordManualRefundResult'
>

type OnlinePaymentProvider = Extract<PaymentProvider, 'wechat' | 'postar' | 'simulation'>

export interface PaymentApiActorContext {
  scope: Readonly<StoreScope>
  actor: AuditActor
  businessDate: string
  tableSessionId?: string
  customerId?: string
}

export interface PaymentApiStaffContext extends PaymentApiActorContext {
  actor: Extract<AuditActor, { type: 'employee' }>
  employeeId: string
  capabilities: readonly string[]
}

export interface TrustedProviderMerchantIdentity {
  provider: Extract<OnlinePaymentProvider, 'wechat' | 'postar'>
  agencyId: string
  merchantId: string
  scope: Readonly<StoreScope>
  integrationRef: string
}

export interface ProviderVerificationInput {
  provider: OnlinePaymentProvider
  headers: Readonly<Record<string, string | string[] | undefined>>
  rawBody: Buffer
  body: unknown
}

export interface VerifiedPaymentCallback {
  merchant: TrustedProviderMerchantIdentity
  eventId: string
  businessIdentity: string
  paymentPublicId: string
  providerTransactionId: string
  amountMinor: number
  currency: string
  occurredAt: string
  evidence?: JsonObject
}

export interface VerifiedRefundCallback {
  merchant: TrustedProviderMerchantIdentity
  eventId: string
  businessIdentity: string
  refundPublicId: string
  provider: Extract<OnlinePaymentProvider, 'wechat' | 'postar'>
  succeeded: boolean
  providerRefundId: string
  originalProviderTransactionId: string
  amountMinor: number
  currency: string
  occurredAt: string
  evidence?: JsonObject
}

export interface PaymentProviderVerifier {
  verifyPaymentCallback(input: Readonly<ProviderVerificationInput>): Promise<VerifiedPaymentCallback>
  verifyRefundCallback(input: Readonly<ProviderVerificationInput>): Promise<VerifiedRefundCallback>
}

export interface ReconciliationListInput {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
  entryType?: 'payment' | 'refund' | 'fee' | 'adjustment'
  cursor?: string
  limit: number
}

export interface ReconciliationListResult {
  entries: readonly ReconciliationEntry[]
  nextCursor: string | null
}

export interface ReconciliationQueryPort {
  list(input: Readonly<ReconciliationListInput>): Promise<ReconciliationListResult>
}

export interface CashierWorkbenchQueryPort {
  get(input: Readonly<CashierWorkbenchQueryInput>): Promise<CashierWorkbenchView>
}

export interface PaymentApiOptions {
  commands: PaymentCommandPort
  providerVerifier: PaymentProviderVerifier
  reconciliationQuery: ReconciliationQueryPort
  cashierWorkbenchQuery: CashierWorkbenchQueryPort
  onlinePayments?: Pick<OnlinePaymentService, 'create' | 'query' | 'assertAvailable' | 'resolveActivePayment'>
  resolveActorContext(request: FastifyRequest): Promise<PaymentApiActorContext> | PaymentApiActorContext
  resolveStaffContext(request: FastifyRequest): Promise<PaymentApiStaffContext> | PaymentApiStaffContext
  resolveProviderBusinessDate(
    merchant: Readonly<TrustedProviderMerchantIdentity>,
  ): Promise<string> | string
  createPublicId?: (kind: 'payment' | 'refund') => string
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

export class PaymentProviderVerificationError extends Error {
  constructor(message = '支付机构通知验签失败') {
    super(message)
    this.name = 'PaymentProviderVerificationError'
  }
}

class PaymentApiRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentApiRequestError'
  }
}

class PaymentActorBindingError extends Error {
  constructor() {
    super('请求中的员工身份与当前登录员工不一致')
    this.name = 'PaymentActorBindingError'
  }
}

const rawBodySymbol = Symbol('payment-callback-raw-body')
type RequestWithRawBody = FastifyRequest & { [rawBodySymbol]?: Buffer }

export const paymentApiPlugin: FastifyPluginAsync<PaymentApiOptions> = async (app, options) => {
  const createPublicId = options.createPublicId ?? defaultPublicId
  app.addHook('preParsing', (request, _reply, payload, done) => {
    const chunks: Buffer[] = []
    const capture = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        chunks.push(value)
        callback(null, value)
      },
      flush(callback) {
        ;(request as RequestWithRawBody)[rawBodySymbol] = Buffer.concat(chunks)
        callback()
      },
    })
    done(null, payload.pipe(capture))
  })

  app.post('/payments', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveActorContext(options, request)
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.actor)
    const provider = readOnlineProvider(body.provider)
    const method = readOnlineMethod(body.method)
    assertOnlineMethod(provider, method)
    assertActorPaymentMethod(context.actor, method)
    options.onlinePayments?.assertAvailable(provider === 'simulation' ? 'simulation' : 'postar')
    const idempotencyKey = readIdempotencyKey(request)
    const publicId = readOptionalString(body.publicId, 'publicId', 128, 8)
      ?? createPublicId('payment')
    const providerSnapshot = sanitizeClientPaymentHints(
      readOptionalJsonObject(body.providerSnapshot, 'providerSnapshot'),
    )
    const orderId = readUuid(body.orderId, 'orderId')
    const customerAuthCode = method === 'auth_code'
      ? readString(body.customerAuthCode, 'customerAuthCode', 32, 16)
      : undefined
    const principal = paymentInitiationPrincipal(context)
    let execution: CommandExecution<Payment>
    try {
      execution = await options.commands.initiate({
        ...metadata(request, context, idempotencyKey, {
          orderId,
          publicId,
          provider,
          method,
          providerSnapshot: providerSnapshot ?? null,
          principal: principalToJson(principal),
        }),
        orderId,
        publicId,
        provider,
        method,
        providerSnapshot,
        principal,
      })
    } catch (error) {
      if (!(error instanceof OrderNotPayableError) || options.onlinePayments === undefined) throw error
      const active = await options.onlinePayments.resolveActivePayment({
        scope: context.scope,
        orderId,
        principal,
      })
      if (active === null) throw error
      if (active.provider !== provider || active.method !== method) {
        throw new ProviderPaymentMethodConflictError()
      }
      execution = { value: paymentFromProviderContext(active), replayed: true }
    }
    const action = options.onlinePayments === undefined ? null : await options.onlinePayments.create({
      scope: context.scope,
      paymentId: execution.value.id,
      principal,
      clientIp: request.ip,
      operatorId: context.actor.type === 'employee' ? context.actor.employeeId : 'MBOXGUEST',
      ...(customerAuthCode === undefined ? {} : { customerAuthCode }),
    })
    return reply.code(execution.replayed ? 200 : 201).send(paymentExecutionResponse(execution, action))
  }))

  app.post('/payments/manual', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveStaffContext(options, request)
    const body = readObject(request.body, '请求正文')
    assertActorBinding(body, context.actor)
    const provider = readManualProvider(body.provider)
    const method = readManualMethod(body.method)
    assertManualMethod(provider, method)
    const occurredAt = readTimestamp(body.occurredAt, 'occurredAt')
    const evidence: JsonObject = {
      receiptReference: readString(body.receiptReference, 'receiptReference', 256),
      collectedByEmployeeId: context.employeeId,
      ...(body.terminalId === undefined
        ? {}
        : { terminalId: readString(body.terminalId, 'terminalId', 128) }),
    }
    const idempotencyKey = readIdempotencyKey(request)
    const publicId = readOptionalString(body.publicId, 'publicId', 128, 8)
      ?? createPublicId('payment')
    const orderId = readUuid(body.orderId, 'orderId')
    const execution = await options.commands.recordManual({
      ...metadata(request, context, idempotencyKey, {
        orderId,
        publicId,
        provider,
        method,
        evidence,
        occurredAt,
      }),
      orderId,
      publicId,
      provider,
      method,
      evidence,
      occurredAt,
    })
    return reply.code(execution.replayed ? 200 : 201).send(executionResponse(execution))
  }))

  app.post<{ Params: { paymentId: string } }>(
    '/payments/:paymentId/provider-query',
    async (request, reply) => handleRoute(reply, async () => {
      if (options.onlinePayments === undefined) throw new OnlinePaymentUnavailableError()
      const context = await resolveActorContext(options, request)
      const paymentId = readUuid(request.params.paymentId, 'paymentId')
      const idempotencyKey = readIdempotencyKey(request)
      const principal = paymentInitiationPrincipal(context)
      const queried = await options.onlinePayments.query({
        scope: context.scope,
        paymentId,
        principal,
      })
      const observed = queried.observation
      const actor: AuditActor = { type: 'integration', ref: 'postar-active-query' }
      const providerSnapshot = sanitizeProviderSnapshot({
        signatureVerified: true,
        providerStatus: observed.status,
        occurredAt: observed.occurredAt,
        receivedAt: new Date().toISOString(),
      })
      const execution = await options.commands.recordProviderQueryResult({
        ...metadata(request, { ...context, actor }, idempotencyKey, {
          paymentPublicId: queried.context.publicId,
          provider: 'postar',
          providerTransactionId: observed.providerTransactionId,
          status: observed.status,
          amountMinor: observed.amount,
          currency: observed.currency,
        }),
        paymentPublicId: queried.context.publicId,
        provider: 'postar',
        providerTransactionId: readString(observed.providerTransactionId, 'providerTransactionId', 256),
        reportedAmountMinor: readPositiveMinor(observed.amount, 'amountMinor'),
        reportedCurrency: readCurrency(observed.currency),
        status: observed.status,
        providerSnapshot,
        occurredAt: readTimestamp(observed.occurredAt, 'occurredAt'),
      })
      return reply.send(executionResponse(execution))
    }),
  )

  app.post<{ Params: { provider: string } }>(
    '/payments/providers/:provider/callback',
    async (request, reply) => handleRoute(reply, async () => {
      const provider = readCallbackProvider(request.params.provider)
      const verified = await verifyPaymentCallback(options, request, provider)
      assertVerifiedMerchantProvider(verified.merchant, provider)
      const context = await verifiedProviderContext(options, verified.merchant)
      const idempotencyKey = providerIdempotencyKey(provider, 'payment', verified.businessIdentity)
      const actor: AuditActor = { type: 'integration', ref: verified.merchant.integrationRef }
      const providerSnapshot = verifiedSnapshot(verified.evidence, verified.eventId, verified.occurredAt)
      await options.commands.recordSucceededCallback({
        ...metadata(request, { ...context, actor }, idempotencyKey, {
          paymentPublicId: verified.paymentPublicId,
          provider,
          providerTransactionId: verified.providerTransactionId,
          reportedAmountMinor: verified.amountMinor,
          reportedCurrency: verified.currency,
          occurredAt: verified.occurredAt,
          providerSnapshot,
        }),
        paymentPublicId: readString(verified.paymentPublicId, 'paymentPublicId', 128, 8),
        provider,
        providerTransactionId: readString(
          verified.providerTransactionId,
          'providerTransactionId',
          256,
        ),
        reportedAmountMinor: readPositiveMinor(verified.amountMinor, 'amountMinor'),
        reportedCurrency: readCurrency(verified.currency),
        providerSnapshot,
        occurredAt: readTimestamp(verified.occurredAt, 'occurredAt'),
      })
      return reply.send(providerAcknowledgement())
    }),
  )

  app.post<{ Params: { paymentId: string } }>(
    '/payments/:paymentId/refunds',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request)
      const body = readObject(request.body, '请求正文')
      assertActorBinding(body, context.actor)
      const paymentId = readUuid(request.params.paymentId, 'paymentId')
      const reason = readString(body.reason, 'reason', 1_000, 2)
      const allocations = readRefundAllocations(body.allocations)
      const requestEvidence = sanitizeClientRefundEvidence(
        readOptionalJsonObject(body.requestEvidence, 'requestEvidence'),
      )
      const idempotencyKey = readIdempotencyKey(request)
      const publicId = readOptionalString(body.publicId, 'publicId', 128, 8)
        ?? createPublicId('refund')
      const execution = await options.commands.requestRefund({
        ...metadata(request, context, idempotencyKey, {
          paymentId,
          publicId,
          reason,
          allocations: allocations.map((allocation) => ({ ...allocation })),
          requestEvidence: requestEvidence ?? null,
        }),
        paymentId,
        publicId,
        reason,
        allocations,
        requestEvidence,
      })
      return reply.code(execution.replayed ? 200 : 201).send(executionResponse(execution))
    }),
  )

  app.post<{ Params: { refundId: string } }>(
    '/refunds/:refundId/approve',
    async (request, reply) => refundDecisionRoute(request, reply, options, 'approve'),
  )
  app.post<{ Params: { refundId: string } }>(
    '/refunds/:refundId/reject',
    async (request, reply) => refundDecisionRoute(request, reply, options, 'reject'),
  )
  app.post<{ Params: { refundId: string } }>(
    '/refunds/:refundId/execute',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request)
      const body = readOptionalObject(request.body)
      assertActorBinding(body, context.actor)
      const refundId = readUuid(request.params.refundId, 'refundId')
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commands.beginRefundExecution({
        ...metadata(request, context, idempotencyKey, { refundId }),
        refundId,
      })
      return reply.send(executionResponse(execution))
    }),
  )

  app.post<{ Params: { refundId: string } }>(
    '/refunds/:refundId/manual-result',
    async (request, reply) => handleRoute(reply, async () => {
      const context = await resolveStaffContext(options, request)
      const body = readObject(request.body, '请求正文')
      assertActorBinding(body, context.actor)
      const refundId = readUuid(request.params.refundId, 'refundId')
      const succeeded = readBoolean(body.succeeded, 'succeeded')
      const receiptReference = readString(body.receiptReference, 'receiptReference', 256)
      const occurredAt = readTimestamp(body.occurredAt, 'occurredAt')
      const providerSnapshot: JsonObject = {
        receiptReference,
        collectedByEmployeeId: context.employeeId,
        resultCode: succeeded ? 'SUCCESS' : 'FAILED',
      }
      const idempotencyKey = readIdempotencyKey(request)
      const execution = await options.commands.recordManualRefundResult({
        ...metadata(request, context, idempotencyKey, {
          refundId,
          succeeded,
          receiptReference,
          providerSnapshot: providerSnapshot ?? null,
          occurredAt,
        }),
        refundId,
        succeeded,
        receiptReference,
        providerSnapshot,
        occurredAt,
      })
      return reply.send(executionResponse(execution))
    }),
  )

  app.post<{ Params: { provider: string } }>(
    '/refunds/providers/:provider/callback',
    async (request, reply) => handleRoute(reply, async () => {
      const provider = readCallbackProvider(request.params.provider)
      const verified = await verifyRefundCallback(options, request, provider)
      assertVerifiedMerchantProvider(verified.merchant, provider)
      if (verified.provider !== provider) throw new PaymentProviderVerificationError()
      const context = await verifiedProviderContext(options, verified.merchant)
      const idempotencyKey = providerIdempotencyKey(provider, 'refund', verified.businessIdentity)
      const actor: AuditActor = { type: 'integration', ref: verified.merchant.integrationRef }
      const providerSnapshot = verifiedSnapshot(verified.evidence, verified.eventId, verified.occurredAt)
      await options.commands.recordProviderRefundResult({
        ...metadata(request, { ...context, actor }, idempotencyKey, {
          refundPublicId: verified.refundPublicId,
          provider,
          succeeded: verified.succeeded,
          providerRefundId: verified.providerRefundId,
          originalProviderTransactionId: verified.originalProviderTransactionId,
          reportedAmountMinor: verified.amountMinor,
          reportedCurrency: verified.currency,
          providerSnapshot,
          occurredAt: verified.occurredAt,
        }),
        refundPublicId: readString(verified.refundPublicId, 'refundPublicId', 128, 8),
        provider,
        succeeded: verified.succeeded,
        providerRefundId: readString(verified.providerRefundId, 'providerRefundId', 256),
        originalProviderTransactionId: readString(
          verified.originalProviderTransactionId,
          'originalProviderTransactionId',
          256,
        ),
        reportedAmountMinor: readPositiveMinor(verified.amountMinor, 'amountMinor'),
        reportedCurrency: readCurrency(verified.currency),
        providerSnapshot,
        occurredAt: readTimestamp(verified.occurredAt, 'occurredAt'),
      })
      return reply.send(providerAcknowledgement())
    }),
  )

  app.get('/reconciliation', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveStaffContext(options, request)
    requireStaffCapability(context, 'reconciliation.view')
    const query = readObject(request.query, '查询参数')
    const businessDate = query.businessDate === undefined
      ? context.businessDate
      : readBusinessDate(query.businessDate)
    const entryType = readOptionalEntryType(query.entryType)
    const cursor = readOptionalString(query.cursor, 'cursor', 512)
    const result = await options.reconciliationQuery.list({
      scope: context.scope,
      employeeId: context.employeeId,
      businessDate,
      ...(entryType === undefined ? {} : { entryType }),
      ...(cursor === null ? {} : { cursor }),
      limit: query.limit === undefined ? 50 : readInteger(query.limit, 'limit', 1, 200),
    })
    return reply.send({ data: result.entries, meta: { nextCursor: result.nextCursor } })
  }))

  app.get('/payments/workbench', async (request, reply) => handleRoute(reply, async () => {
    const context = await resolveStaffContext(options, request)
    requireAnyStaffCapability(context, [
      'reconciliation.view',
      'payment.manual.cash.record',
      'payment.manual.pos.record',
      'refund.approve',
      'refund.execute',
    ])
    const query = readObject(request.query, '查询参数')
    const result = await options.cashierWorkbenchQuery.get({
      scope: context.scope,
      employeeId: context.employeeId,
      businessDate: context.businessDate,
      capabilities: context.capabilities,
      query: readOptionalString(query.query, 'query', 64) ?? undefined,
      limit: query.limit === undefined ? 50 : readInteger(query.limit, 'limit', 1, 100),
    })
    return reply.send({ data: result })
  }))
}

function paymentFromProviderContext(value: ProviderPaymentContext): Payment {
  return {
    id: value.id,
    orderId: value.orderId,
    publicId: value.publicId,
    provider: value.provider,
    providerTransactionId: value.providerTransactionId,
    method: value.method,
    amountMinor: value.amountMinor,
    currency: value.currency,
    status: value.status as Payment['status'],
    providerSnapshot: {},
    succeededAt: null,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
  }
}

async function refundDecisionRoute(
  request: FastifyRequest<{ Params: { refundId: string } }>,
  reply: FastifyReply,
  options: PaymentApiOptions,
  decision: 'approve' | 'reject',
): Promise<FastifyReply> {
  return handleRoute(reply, async () => {
    const context = await resolveStaffContext(options, request)
    const body = readOptionalObject(request.body)
    assertActorBinding(body, context.actor)
    const refundId = readUuid(request.params.refundId, 'refundId')
    const decisionReason = readString(body.reason, 'reason', 1_000, 2)
    const idempotencyKey = readIdempotencyKey(request)
    const input = {
      ...metadata(request, context, idempotencyKey, { refundId, decision, decisionReason }),
      refundId,
      decisionReason,
    }
    const execution = decision === 'approve'
      ? await options.commands.approveRefund(input)
      : await options.commands.rejectRefund(input)
    return reply.send(executionResponse(execution))
  })
}

async function resolveActorContext(
  options: PaymentApiOptions,
  request: FastifyRequest,
): Promise<PaymentApiActorContext> {
  return validateContext(await options.resolveActorContext(request))
}

async function resolveStaffContext(
  options: PaymentApiOptions,
  request: FastifyRequest,
): Promise<PaymentApiStaffContext> {
  const context = await options.resolveStaffContext(request)
  validateContext(context)
  readUuid(context.employeeId, 'employeeId')
  if (context.actor.type !== 'employee' || context.actor.employeeId !== context.employeeId) {
    throw new PaymentActorBindingError()
  }
  if (
    !Array.isArray(context.capabilities)
    || context.capabilities.some((capability) => typeof capability !== 'string')
  ) {
    throw new PaymentApiRequestError('员工权限上下文无效')
  }
  return context
}

function requireStaffCapability(context: PaymentApiStaffContext, capability: string): void {
  if (!context.capabilities.includes(capability)) {
    throw new PaymentAuthorizationError(`Employee lacks financial capability: ${capability}`)
  }
}

function requireAnyStaffCapability(
  context: PaymentApiStaffContext,
  capabilities: readonly string[],
): void {
  if (!capabilities.some((capability) => context.capabilities.includes(capability))) {
    throw new PaymentAuthorizationError('Employee lacks a cashier workbench capability')
  }
}

async function verifiedProviderContext(
  options: PaymentApiOptions,
  merchant: Readonly<TrustedProviderMerchantIdentity>,
): Promise<PaymentApiActorContext> {
  readUuid(merchant.scope.tenantId, 'tenantId')
  readUuid(merchant.scope.storeId, 'storeId')
  readString(merchant.agencyId, 'agencyId', 128)
  readString(merchant.merchantId, 'merchantId', 128)
  readString(merchant.integrationRef, 'integrationRef', 256)
  const businessDate = readBusinessDate(await options.resolveProviderBusinessDate(merchant))
  return {
    scope: merchant.scope,
    actor: { type: 'integration', ref: merchant.integrationRef },
    businessDate,
  }
}

function assertVerifiedMerchantProvider(
  merchant: Readonly<TrustedProviderMerchantIdentity>,
  provider: Extract<OnlinePaymentProvider, 'wechat' | 'postar'>,
): void {
  if (merchant.provider !== provider) throw new PaymentProviderVerificationError()
}

function validateContext<Context extends PaymentApiActorContext>(context: Context): Context {
  readUuid(context.scope.tenantId, 'tenantId')
  readUuid(context.scope.storeId, 'storeId')
  readBusinessDate(context.businessDate)
  if (context.actor.type === 'employee') readUuid(context.actor.employeeId, 'employeeId')
  if (context.actor.type !== 'employee' && context.actor.ref !== undefined) {
    readString(context.actor.ref, 'actor.ref', 256)
  }
  return context
}

async function verifyPaymentCallback(
  options: PaymentApiOptions,
  request: FastifyRequest,
  provider: OnlinePaymentProvider,
): Promise<VerifiedPaymentCallback> {
  try {
    return await options.providerVerifier.verifyPaymentCallback({
      provider,
      headers: request.headers,
      rawBody: readCapturedRawBody(request),
      body: request.body,
    })
  } catch (error) {
    if (error instanceof PaymentProviderVerificationError) throw error
    throw new PaymentProviderVerificationError()
  }
}

function readCapturedRawBody(request: FastifyRequest): Buffer {
  const rawBody = (request as RequestWithRawBody)[rawBodySymbol]
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new PaymentProviderVerificationError('支付机构通知缺少原始报文')
  }
  return rawBody
}

async function verifyRefundCallback(
  options: PaymentApiOptions,
  request: FastifyRequest,
  provider: OnlinePaymentProvider,
): Promise<VerifiedRefundCallback> {
  try {
    return await options.providerVerifier.verifyRefundCallback({
      provider,
      headers: request.headers,
      rawBody: readCapturedRawBody(request),
      body: request.body,
    })
  } catch (error) {
    if (error instanceof PaymentProviderVerificationError) throw error
    throw new PaymentProviderVerificationError()
  }
}

function verifiedSnapshot(
  evidence: JsonObject | undefined,
  eventId: string,
  occurredAt: string,
): JsonObject {
  return sanitizeProviderSnapshot({
    ...(evidence ?? {}),
    signatureVerified: true,
    eventId: readString(eventId, 'eventId', 256),
    occurredAt: readTimestamp(occurredAt, 'occurredAt'),
  })
}

function metadata(
  request: FastifyRequest,
  context: PaymentApiActorContext,
  idempotencyKey: string,
  payload: JsonObject,
) {
  return {
    scope: context.scope,
    actor: context.actor,
    businessDate: context.businessDate,
    idempotencyKey,
    requestFingerprint: stableStringify({
      method: request.method,
      path: request.routeOptions.url ?? request.url.split('?')[0] ?? request.url,
      tenantId: context.scope.tenantId,
      storeId: context.scope.storeId,
      actor: actorToJson(context.actor),
      payload,
    }),
  }
}

function actorToJson(actor: AuditActor): JsonObject {
  return actor.type === 'employee'
    ? {
        type: actor.type,
        employeeId: actor.employeeId,
        ...(actor.ref === undefined ? {} : { ref: actor.ref }),
      }
    : {
        type: actor.type,
        ...(actor.ref === undefined ? {} : { ref: actor.ref }),
      }
}

function assertActorBinding(body: JsonObject, actor: AuditActor): void {
  if (body.actorId === undefined) return
  if (actor.type !== 'employee' || body.actorId !== actor.employeeId) {
    throw new PaymentActorBindingError()
  }
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new PaymentApiRequestError('缺少Idempotency-Key请求头')
  }
  return readPatternString(value, 'Idempotency-Key', /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/)
}

function providerIdempotencyKey(
  provider: OnlinePaymentProvider,
  kind: 'payment' | 'refund',
  eventId: string,
): string {
  const normalizedEventId = readString(eventId, 'eventId', 256)
  const digest = createHash('sha256')
    .update(`${provider}:${kind}:${normalizedEventId}`, 'utf8')
    .digest('hex')
  return `provider:${provider}:${kind}:${digest}`
}

function executionResponse<Value>(execution: CommandExecution<Value>) {
  return { data: execution.value, meta: { replayed: execution.replayed } }
}

function paymentExecutionResponse(
  execution: CommandExecution<Payment>,
  action: OnlinePaymentAction | null,
) {
  return {
    data: {
      ...execution.value,
      providerAction: action,
    },
    meta: { replayed: execution.replayed },
  }
}

function defaultPublicId(kind: 'payment' | 'refund'): string {
  return `${kind === 'payment' ? 'P' : 'R'}${randomUUID().replaceAll('-', '')}`
}

function paymentInitiationPrincipal(
  context: Readonly<PaymentApiActorContext>,
): { type: 'employee'; employeeId: string } | { type: 'guest'; tableSessionId: string; customerId: string } {
  if (context.actor.type === 'employee') {
    return { type: 'employee', employeeId: context.actor.employeeId }
  }
  if (context.actor.type !== 'guest') {
    throw new PaymentAuthorizationError('Only authenticated guests or employees may initiate payment')
  }
  return {
    type: 'guest',
    tableSessionId: readUuid(context.tableSessionId, 'tableSessionId'),
    customerId: readUuid(context.customerId, 'customerId'),
  }
}

function principalToJson(
  principal: { type: 'employee'; employeeId: string } | { type: 'guest'; tableSessionId: string; customerId: string },
): JsonObject {
  return principal.type === 'employee'
    ? { type: principal.type, employeeId: principal.employeeId }
    : {
        type: principal.type,
        tableSessionId: principal.tableSessionId,
        customerId: principal.customerId,
      }
}

function assertActorPaymentMethod(actor: Readonly<AuditActor>, method: Payment['method']): void {
  if (actor.type === 'employee' && method === 'jsapi') {
    throw new PaymentApiRequestError('员工协助收款请选择客人扫码或扫描客人付款码')
  }
  if (actor.type === 'guest' && method === 'auth_code') {
    throw new PaymentAuthorizationError('客人端不能发起扫描付款码收款')
  }
}

function providerAcknowledgement(): JsonObject {
  return { rspCod: '000000', rspMsg: 'success' }
}

function readOnlineProvider(value: unknown): OnlinePaymentProvider {
  if (value === 'wechat' || value === 'postar' || value === 'simulation') return value
  throw new PaymentApiRequestError('provider必须是wechat、postar或simulation')
}

function readCallbackProvider(value: unknown): Extract<OnlinePaymentProvider, 'wechat' | 'postar'> {
  if (value === 'wechat' || value === 'postar') return value
  throw new PaymentProviderVerificationError('不支持的支付机构通知')
}

function readManualProvider(value: JsonValue | undefined): 'cash' | 'physical_pos' {
  if (value === 'cash' || value === 'physical_pos') return value
  throw new PaymentApiRequestError('人工收款provider必须是cash或physical_pos')
}

function readOnlineMethod(value: JsonValue | undefined): 'jsapi' | 'native_qr' | 'auth_code' {
  if (value === 'jsapi' || value === 'native_qr' || value === 'auth_code') return value
  throw new PaymentApiRequestError('线上支付method必须是jsapi、native_qr或auth_code')
}

function readManualMethod(value: JsonValue | undefined): 'cash' | 'card' | 'manual' {
  if (value === 'cash' || value === 'card' || value === 'manual') return value
  throw new PaymentApiRequestError('人工收款method必须是cash、card或manual')
}

function assertOnlineMethod(
  provider: OnlinePaymentProvider,
  method: 'jsapi' | 'native_qr' | 'auth_code',
): void {
  if (provider === 'wechat' && method === 'auth_code') return
  if (provider === 'wechat' || provider === 'postar' || provider === 'simulation') return
  throw new PaymentApiRequestError('支付机构与支付方式不匹配')
}

function assertManualMethod(provider: 'cash' | 'physical_pos', method: 'cash' | 'card' | 'manual'): void {
  if (provider === 'cash' && method !== 'cash') {
    throw new PaymentApiRequestError('现金收款必须使用cash方式')
  }
  if (provider === 'physical_pos' && method === 'cash') {
    throw new PaymentApiRequestError('物理POS不能使用cash方式')
  }
}

function readRefundAllocations(value: JsonValue | undefined): RefundAllocation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new PaymentApiRequestError('allocations必须是1至200项退款明细')
  }
  return value.map((item, index) => {
    const row = readObject(item, `allocations[${index}]`)
    return {
      orderItemId: readUuid(row.orderItemId, `allocations[${index}].orderItemId`),
      amountMinor: readPositiveMinor(row.amountMinor, `allocations[${index}].amountMinor`),
    }
  })
}

function readOptionalEntryType(
  value: unknown,
): 'payment' | 'refund' | 'fee' | 'adjustment' | undefined {
  if (value === undefined) return undefined
  if (value === 'payment' || value === 'refund' || value === 'fee' || value === 'adjustment') {
    return value
  }
  throw new PaymentApiRequestError('entryType无效')
}

function readObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new PaymentApiRequestError(`${label}必须是JSON对象`)
  return value
}

function readOptionalObject(value: unknown): JsonObject {
  if (value === undefined || value === null) return {}
  return readObject(value, '请求正文')
}

function readOptionalJsonObject(value: JsonValue | undefined, label: string): JsonObject | undefined {
  if (value === undefined) return undefined
  return readObject(value, label)
}

function readString(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new PaymentApiRequestError(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new PaymentApiRequestError(`${label}长度必须为${minimum}至${maximum}个字符`)
  }
  return normalized
}

function readOptionalString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
): string | null {
  if (value === undefined || value === null || value === '') return null
  return readString(value, label, maximum, minimum)
}

function readPatternString(value: unknown, label: string, pattern: RegExp): string {
  const normalized = readString(value, label, 128, 8)
  if (!pattern.test(normalized)) throw new PaymentApiRequestError(`${label}格式无效`)
  return normalized
}

function readUuid(value: unknown, label: string): string {
  const normalized = readString(value, label, 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new PaymentApiRequestError(`${label}必须是UUID`)
  }
  return normalized
}

function readTimestamp(value: unknown, label: string): string {
  const normalized = readString(value, label, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(normalized)) {
    throw new PaymentApiRequestError(`${label}必须是UTC ISO时间`)
  }
  if (!Number.isFinite(Date.parse(normalized))) throw new PaymentApiRequestError(`${label}不是有效时间`)
  return normalized
}

function readBusinessDate(value: unknown): string {
  const normalized = readString(value, 'businessDate', 10, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new PaymentApiRequestError('businessDate必须使用YYYY-MM-DD格式')
  }
  return normalized
}

function readCurrency(value: unknown): string {
  const normalized = readString(value, 'currency', 3, 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) throw new PaymentApiRequestError('currency无效')
  return normalized
}

function readPositiveMinor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PaymentApiRequestError(`${label}必须是正整数分`)
  }
  return value as number
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum || (parsed as number) > maximum) {
    throw new PaymentApiRequestError(`${label}必须是${minimum}至${maximum}的整数`)
  }
  return parsed as number
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new PaymentApiRequestError(`${label}必须是布尔值`)
  return value
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function handleRoute(
  reply: FastifyReply,
  operation: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapError(error)
    return reply.code(mapped.statusCode).send(mapped.body)
  }
}

function mapError(error: unknown): { statusCode: number; body: ApiErrorBody } {
  if (error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return apiError(401, 'AUTH_REQUIRED', '登录信息无效或已过期，请重新登录')
  }
  if (error instanceof PaymentProviderVerificationError) {
    return apiError(401, 'PROVIDER_SIGNATURE_INVALID', '支付机构通知验签失败')
  }
  if (
    error instanceof PaymentAuthorizationError
    || error instanceof StaffAccessDeniedError
    || error instanceof StaffNotFoundError
  ) {
    return apiError(403, 'FINANCIAL_ACTION_FORBIDDEN', '当前员工无权执行此财务操作')
  }
  if (error instanceof TrustedStoreScopeError || error instanceof NormalizedStoreUnavailableError) {
    return apiError(403, 'STORE_ACCESS_FORBIDDEN', error.message)
  }
  if (error instanceof PaymentActorBindingError) {
    return apiError(403, 'ACTOR_BINDING_FORBIDDEN', error.message)
  }
  if (error instanceof PaymentNotFoundError) return apiError(404, 'PAYMENT_NOT_FOUND', error.message)
  if (error instanceof RefundNotFoundError) return apiError(404, 'REFUND_NOT_FOUND', error.message)
  if (error instanceof OrderNotPayableError) return apiError(409, 'ORDER_NOT_PAYABLE', error.message)
  if (error instanceof ProviderPaymentInProgressError) {
    return apiError(409, 'PAYMENT_IN_PROGRESS', error.message)
  }
  if (error instanceof ProviderPaymentMethodConflictError) {
    return apiError(409, 'PAYMENT_METHOD_LOCKED', error.message)
  }
  if (error instanceof ProviderPaymentUnknownError || error instanceof OnlinePaymentUnknownError) {
    return apiError(409, 'PAYMENT_STATUS_UNKNOWN', error.message)
  }
  if (error instanceof WechatPaymentIdentityRequiredError) {
    return apiError(409, 'WECHAT_IDENTITY_REQUIRED', error.message)
  }
  if (error instanceof OnlinePaymentUnavailableError) {
    return apiError(503, 'ONLINE_PAYMENT_UNAVAILABLE', error.message)
  }
  if (error instanceof PostarPaymentRejectedError) {
    return apiError(409, 'PROVIDER_PAYMENT_REJECTED', '支付机构未受理本次付款，请核对后重试')
  }
  if (error instanceof PaymentCallbackMismatchError) {
    return apiError(409, 'PAYMENT_CALLBACK_MISMATCH', error.message)
  }
  if (error instanceof PaymentTransitionError) {
    return apiError(409, 'PAYMENT_TRANSITION_CONFLICT', error.message)
  }
  if (error instanceof RefundApprovalRequiredError) {
    return apiError(409, 'REFUND_APPROVAL_REQUIRED', '退款必须先由有权限且非申请人的员工审批')
  }
  if (error instanceof RefundLimitError) return apiError(409, 'REFUND_LIMIT_CONFLICT', error.message)
  if (error instanceof RefundCallbackMismatchError) {
    return apiError(409, 'REFUND_CALLBACK_MISMATCH', error.message)
  }
  if (error instanceof RefundTransitionError) {
    return apiError(409, 'REFUND_TRANSITION_CONFLICT', error.message)
  }
  if (error instanceof ReconciliationConflictError) {
    return apiError(409, 'RECONCILIATION_CONFLICT', error.message)
  }
  if (error instanceof IdempotencyConflictError) {
    return apiError(409, 'IDEMPOTENCY_CONFLICT', error.message)
  }
  if (error instanceof IdempotencyInProgressError) {
    return apiError(409, 'IDEMPOTENCY_IN_PROGRESS', error.message)
  }
  if (error instanceof IdempotencyRecordError) {
    return apiError(500, 'IDEMPOTENCY_STORAGE_ERROR', '请求处理记录异常，请稍后重试')
  }
  if (
    error instanceof PaymentApiRequestError
    || error instanceof PaymentEvidenceError
    || error instanceof TypeError
  ) {
    return apiError(400, 'PAYMENT_REQUEST_INVALID', error.message)
  }
  return apiError(500, 'PAYMENT_INTERNAL_ERROR', '支付服务暂时不可用，请稍后重试')
}

function apiError(statusCode: number, code: string, message: string) {
  return { statusCode, body: { error: { code, message } } }
}
