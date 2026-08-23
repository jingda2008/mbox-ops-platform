import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import {
  LoyaltyTierBenefitManagementService,
  type TierBenefitStaffContext,
  type TierBenefitRuleInput,
} from './loyalty-tier-benefit-management-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface LoyaltyTierBenefitManagementApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: LoyaltyTierBenefitManagementService
  resolveStaffContext(request: FastifyRequest): Promise<TierBenefitStaffContext> | TierBenefitStaffContext
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const loyaltyTierBenefitManagementApiPlugin: FastifyPluginAsync<
  LoyaltyTierBenefitManagementApiOptions
> = async (app, options) => {
  app.get('/staff/loyalty/tier-benefits', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'loyalty.policy.view')
    return reply.send({ data: await options.service.configuration(context) })
  }))

  app.post('/staff/loyalty/tier-benefit-policies', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'loyalty.policy.manage')
    const body = object(request.body, '请求')
    if (!Array.isArray(body.rules)) throw invalid('等级权益规则必须是数组')
    const result = await options.service.draft(context, {
      tierPolicyVersionId: uuid(body.tierPolicyVersionId, '等级规则版本'),
      reason: text(body.reason, '起草原因', 2, 500),
      rules: body.rules.map((value, index) => rule(object(value, `第${index + 1}条规则`))),
      idempotencyKey: idempotency(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/tier-benefit-policies/:policyId/approve',
    async (request, reply) => handle(reply, async () => {
      await authorized(options, request, 'loyalty.policy.approve')
      throw new CustomerExperienceRequestError(
        '该审批入口已停用，请先在会员经营配置中心生成服务端影响预览后审批',
        'MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED', 409,
      )
    }),
  )

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/tier-benefit-policies/:policyId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, 'loyalty.policy.publish')
      const body = object(request.body, '请求')
      const result = await options.service.publish(context, {
        policyId: uuid(request.params.policyId, '等级权益政策'),
        effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
        effectiveUntil: body.effectiveUntil===undefined || body.effectiveUntil===null
          ? null : timestamp(body.effectiveUntil, '失效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotency(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
}

async function authorized(
  options: LoyaltyTierBenefitManagementApiOptions,
  request: FastifyRequest,
  permission: string,
) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, (transaction) => (
    (options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction))
      .assertPermission(context.employeeId, permission)
  ), { readOnly: true })
  return context
}

function rule(value: Record<string, unknown>): TierBenefitRuleInput {
  return {
    ruleCode: code(value.ruleCode),
    eligibleTier: enumeration(value.eligibleTier, '适用等级', ['member','silver','gold'] as const),
    inheritToHigherTiers: bool(value.inheritToHigherTiers, '高等级继承'),
    grantOnEntry: bool(value.grantOnEntry, '进入等级发放'),
    grantOnRetention: bool(value.grantOnRetention, '保级发放'),
    benefitDefinitionId: uuid(value.benefitDefinitionId, '权益定义'),
    quantity: integer(value.quantity, '数量', 1, 100),
    validityDays: integer(value.validityDays, '有效天数', 1, 366),
    revocationPolicy: enumeration(
      value.revocationPolicy, '降级处理', ['revoke_unreserved','protect_until_expiry'] as const,
    ),
    enabled: bool(value.enabled, '是否启用'),
  }
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try { return await execute() } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof CustomerExperienceRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该操作的权限' } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致' } })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(425).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同请求正在处理中' } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '操作暂时无法确认，请稍后重试' } })
    }
    throw error
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value!=='object' || value===null || Array.isArray(value)) throw invalid(`${label}格式不正确`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value!=='string') throw invalid(`${label}必须填写`)
  const normalized = value.trim()
  if (normalized.length<minimum || normalized.length>maximum) throw invalid(`${label}长度不正确`)
  return normalized
}

function uuid(value: unknown, label: string) {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function code(value: unknown) {
  const normalized = text(value, '规则代码', 3, 64)
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(normalized)) throw invalid('规则代码格式不正确')
  return normalized
}

function bool(value: unknown, label: string) {
  if (typeof value!=='boolean') throw invalid(`${label}必须是布尔值`)
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number)<minimum || (value as number)>maximum) {
    throw invalid(`${label}超出范围`)
  }
  return value as number
}

function enumeration<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
  if (typeof value!=='string' || !values.includes(value)) throw invalid(`${label}不受支持`)
  return value as Values[number]
}

function timestamp(value: unknown, label: string) {
  const normalized = text(value, label, 20, 40)
  if (!Number.isFinite(Date.parse(normalized))) throw invalid(`${label}格式不正确`)
  return normalized
}

function idempotency(request: FastifyRequest) {
  const value = request.headers['idempotency-key']
  if (typeof value!=='string' || value.length<8 || value.length>128) throw invalid('缺少有效幂等键')
  return value
}

function invalid(message: string) {
  return new CustomerExperienceRequestError(message, 'INVALID_REQUEST', 400)
}
