import { createHash } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonCodec, JsonObject, NormalizedCommandExecutor } from './command-executor.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
} from './command-executor.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import { StaffAccessDeniedError, StaffAccessRepository, StaffNotFoundError } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

export interface StoreCommercePolicyView extends Record<string, unknown> {
  configured: boolean
  policyOnlinePaymentEnabled: boolean
  onlinePaymentEnabled: boolean
  providerConfigured: boolean
  provider: 'postar' | 'simulation' | null
  paymentReservationMinutes: number
  policyVersion: number
  reason: string | null
  updatedByEmployeeId: string | null
  updatedAt: string | null
}

interface PolicyRow extends Record<string, unknown> {
  online_payment_enabled: boolean
  payment_reservation_minutes: number
  policy_version: number
  reason: string
  updated_by_employee_id: string
  updated_at: string
}

export interface StoreCommercePolicyApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  commands: Pick<NormalizedCommandExecutor, 'execute'>
  providerConfigured: boolean
  provider: 'postar' | 'simulation' | null
  resolveContext(request: FastifyRequest): Promise<NormalizedOperationsRequestContext> | NormalizedOperationsRequestContext
}

export class StoreCommercePolicyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreCommercePolicyConflictError'
  }
}

export class StoreCommercePolicyRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreCommercePolicyRequestError'
  }
}

export class StoreCommercePolicyRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async get(providerConfigured: boolean, provider: 'postar' | 'simulation' | null): Promise<StoreCommercePolicyView> {
    const result = await this.transaction.query<PolicyRow>(`
      SELECT online_payment_enabled, payment_reservation_minutes, policy_version, reason,
        updated_by_employee_id, updated_at::text
      FROM mbox.store_commerce_policies
      LIMIT 1
    `)
    const row = result.rows[0]
    if (row === undefined) return {
      configured: false,
      policyOnlinePaymentEnabled: false,
      onlinePaymentEnabled: false,
      providerConfigured,
      provider,
      paymentReservationMinutes: 10,
      policyVersion: 0,
      reason: null,
      updatedByEmployeeId: null,
      updatedAt: null,
    }
    return {
      configured: true,
      policyOnlinePaymentEnabled: row.online_payment_enabled,
      onlinePaymentEnabled: providerConfigured && row.online_payment_enabled,
      providerConfigured,
      provider,
      paymentReservationMinutes: Number(row.payment_reservation_minutes),
      policyVersion: Number(row.policy_version),
      reason: row.reason,
      updatedByEmployeeId: row.updated_by_employee_id,
      updatedAt: row.updated_at,
    }
  }

  async set(input: { enabled: boolean; paymentReservationMinutes?: number; expectedVersion: number; employeeId: string; reason: string; providerConfigured: boolean; provider: 'postar' | 'simulation' | null }): Promise<StoreCommercePolicyView> {
    if (input.enabled && !input.providerConfigured) {
      throw new StoreCommercePolicyConflictError('支付渠道尚未配置完成，不能开放线上支付')
    }
    const current = await this.transaction.query<PolicyRow>(`
      SELECT online_payment_enabled, payment_reservation_minutes, policy_version, reason,
        updated_by_employee_id, updated_at::text
      FROM mbox.store_commerce_policies
      FOR UPDATE
    `)
    const currentVersion = current.rows[0] === undefined ? 0 : Number(current.rows[0].policy_version)
    if (currentVersion !== input.expectedVersion) {
      throw new StoreCommercePolicyConflictError('支付策略已被其他管理员更新，请刷新后重试')
    }
    await this.transaction.query(`
      INSERT INTO mbox.store_commerce_policies (
        tenant_id, store_id, online_payment_enabled, payment_reservation_minutes,
        policy_version, reason, updated_by_employee_id
      ) VALUES (
        mbox.current_tenant_id(), mbox.current_store_id(), $1::boolean,
        COALESCE($4::smallint, 10), 1, $2::text, $3::uuid
      )
      ON CONFLICT (tenant_id, store_id) DO UPDATE SET
        online_payment_enabled=EXCLUDED.online_payment_enabled,
        payment_reservation_minutes=COALESCE($4::smallint, mbox.store_commerce_policies.payment_reservation_minutes),
        policy_version=mbox.store_commerce_policies.policy_version + 1,
        reason=EXCLUDED.reason,
        updated_by_employee_id=EXCLUDED.updated_by_employee_id,
        updated_at=clock_timestamp()
    `, [input.enabled, input.reason, input.employeeId, input.paymentReservationMinutes ?? null])
    return this.get(input.providerConfigured, input.provider)
  }
}

export async function resolveEffectiveOnlinePayment(
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>,
  scope: Readonly<StoreScope>,
  providerConfigured: boolean,
  provider: 'postar' | 'simulation' | null,
): Promise<StoreCommercePolicyView> {
  return transactions.run(scope, (transaction) => (
    new StoreCommercePolicyRepository(transaction).get(providerConfigured, provider)
  ), { readOnly: true })
}

export const storeCommercePolicyApiPlugin: FastifyPluginAsync<StoreCommercePolicyApiOptions> = async (app, options) => {
  app.get('/store/commerce-policy', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const data = await options.transactions.run(context.scope, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(context.employeeId, 'payment.policy.manage')
      return new StoreCommercePolicyRepository(transaction).get(options.providerConfigured, options.provider)
    }, { readOnly: true })
    return reply.send({ data })
  }))

  app.patch('/store/commerce-policy/online-payment', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const enabled = readBoolean(body.enabled, 'enabled')
    const expectedVersion = readInteger(body.expectedVersion, 'expectedVersion', 0)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commands.execute({
      scope: context.scope,
      operationScope: 'store.commerce-policy.online-payment',
      idempotencyKey,
      requestFingerprint: createHash('sha256').update(JSON.stringify({ employeeId: context.employeeId, enabled, expectedVersion, reason })).digest('hex'),
      resultCodec: codec<StoreCommercePolicyView>(),
    }, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(context.employeeId, 'payment.policy.manage')
      const before = await new StoreCommercePolicyRepository(transaction).get(options.providerConfigured, options.provider)
      const result = await new StoreCommercePolicyRepository(transaction).set({
        enabled, expectedVersion, employeeId: context.employeeId, reason,
        providerConfigured: options.providerConfigured, provider: options.provider,
      })
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee' as const, employeeId: context.employeeId },
          action: 'store.online_payment_policy.changed.v1',
          objectType: 'store_commerce_policy',
          objectId: context.scope.storeId,
          businessDate: context.businessDate,
          reason,
          beforeData: policyAudit(before),
          afterData: policyAudit(result),
        }],
        outboxMessages: [{
          aggregateType: 'store_commerce_policy',
          aggregateId: context.scope.storeId,
          aggregateVersion: result.policyVersion,
          eventType: 'store.online_payment_policy.changed.v1',
          payload: policyAudit(result),
        }],
      }
    })
    return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
  }))

  app.patch('/store/commerce-policy/payment-reservation', async (request, reply) => handle(reply, async () => {
    const context = await options.resolveContext(request)
    const body = readObject(request.body)
    const paymentReservationMinutes = readIntegerRange(
      body.paymentReservationMinutes,
      'paymentReservationMinutes',
      2,
      30,
    )
    const expectedVersion = readInteger(body.expectedVersion, 'expectedVersion', 0)
    const reason = readString(body.reason, 'reason', 1000, 3)
    const idempotencyKey = readIdempotencyKey(request)
    const execution = await options.commands.execute({
      scope: context.scope,
      operationScope: 'store.commerce-policy.payment-reservation',
      idempotencyKey,
      requestFingerprint: createHash('sha256').update(JSON.stringify({
        employeeId: context.employeeId,
        paymentReservationMinutes,
        expectedVersion,
        reason,
      })).digest('hex'),
      resultCodec: codec<StoreCommercePolicyView>(),
    }, async (transaction) => {
      await new StaffAccessRepository(transaction).assertPermission(context.employeeId, 'payment.policy.manage')
      const repository = new StoreCommercePolicyRepository(transaction)
      const before = await repository.get(options.providerConfigured, options.provider)
      const result = await repository.set({
        enabled: before.policyOnlinePaymentEnabled,
        paymentReservationMinutes,
        expectedVersion,
        employeeId: context.employeeId,
        reason,
        providerConfigured: options.providerConfigured,
        provider: options.provider,
      })
      return {
        result,
        auditEvents: [{
          actor: { type: 'employee' as const, employeeId: context.employeeId },
          action: 'store.payment_reservation_policy.changed.v1',
          objectType: 'store_commerce_policy',
          objectId: context.scope.storeId,
          businessDate: context.businessDate,
          reason,
          beforeData: policyAudit(before),
          afterData: policyAudit(result),
        }],
        outboxMessages: [{
          aggregateType: 'store_commerce_policy',
          aggregateId: context.scope.storeId,
          aggregateVersion: result.policyVersion,
          eventType: 'store.payment_reservation_policy.changed.v1',
          payload: policyAudit(result),
        }],
      }
    })
    return reply.send({ data: execution.value, meta: { replayed: execution.replayed } })
  }))
}

function policyAudit(view: StoreCommercePolicyView): JsonObject {
  return {
    policyOnlinePaymentEnabled: view.policyOnlinePaymentEnabled,
    onlinePaymentEnabled: view.onlinePaymentEnabled,
    providerConfigured: view.providerConfigured,
    provider: view.provider,
    paymentReservationMinutes: view.paymentReservationMinutes,
    policyVersion: view.policyVersion,
  }
}

function codec<Value extends Record<string, unknown>>(): JsonCodec<Value> {
  return { encode: (value) => value as JsonObject, decode: (value) => readObject(value) as Value }
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new StoreCommercePolicyRequestError('请求格式无效')
  return value as Record<string, unknown>
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new StoreCommercePolicyRequestError(`${field}格式无效`)
  return value
}

function readInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new StoreCommercePolicyRequestError(`${field}格式无效`)
  return Number(value)
}

function readIntegerRange(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = readInteger(value, field, minimum)
  if (parsed > maximum) throw new StoreCommercePolicyRequestError(`${field}格式无效`)
  return parsed
}

function readString(value: unknown, field: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new StoreCommercePolicyRequestError(`${field}格式无效`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw new StoreCommercePolicyRequestError(`${field}格式无效`)
  return normalized
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'] ?? request.headers['x-idempotency-key']
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) throw new StoreCommercePolicyRequestError('缺少有效的幂等键')
  return value
}

async function handle(reply: FastifyReply, operation: () => Promise<FastifyReply>) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'PAYMENT_POLICY_FORBIDDEN', message: '当前岗位无权修改线上支付策略' } })
    if (error instanceof StaffNotFoundError) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: '请重新登录' } })
    if (error instanceof StoreCommercePolicyConflictError || error instanceof IdempotencyConflictError || error instanceof IdempotencyInProgressError) return reply.code(409).send({ error: { code: 'PAYMENT_POLICY_CONFLICT', message: error.message } })
    if (error instanceof StoreCommercePolicyRequestError) return reply.code(400).send({ error: { code: 'PAYMENT_POLICY_REQUEST_INVALID', message: error.message } })
    if (error instanceof IdempotencyRecordError) return reply.code(503).send({ error: { code: 'PAYMENT_POLICY_TEMPORARILY_UNAVAILABLE', message: '支付策略服务暂时不可用' } })
    return reply.code(500).send({ error: { code: 'PAYMENT_POLICY_INTERNAL_ERROR', message: '支付策略服务暂时不可用' } })
  }
}
