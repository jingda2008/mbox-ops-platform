import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import {
  PROMOTION_MEMBER_LEVELS,
  PROMOTION_REFUND_POLICIES,
  PROMOTION_STACKING_MODES,
  PROMOTION_TRIGGER_KINDS,
  PromotionalLoyaltyError,
  type PromotionMemberLevel,
  type PromotionRuleInput,
  type PromotionalLoyaltyService,
  type PromotionalLoyaltyStaffContext,
} from './promotional-loyalty-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface PromotionalLoyaltyApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: PromotionalLoyaltyService
  resolveStaffContext(request: FastifyRequest):
    | PromotionalLoyaltyStaffContext
    | Promise<PromotionalLoyaltyStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const promotionalLoyaltyApiPlugin: FastifyPluginAsync<PromotionalLoyaltyApiOptions> = async (app, options) => {
  app.get('/staff/loyalty/promotion-policies', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'loyalty.promotion.view')
    return reply.send({ data: await options.service.configuration(context) })
  }))

  app.post('/staff/loyalty/promotion-policies', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, 'loyalty.promotion.manage')
    const body = object(request.body, '请求')
    if (!Array.isArray(body.rules)) throw invalid('积分规则必须是数组')
    const result = await options.service.draft(context, {
      campaignCode: text(body.campaignCode, '活动积分编号', 3, 64),
      name: text(body.name, '规则名称', 2, 80),
      activityId: uuid(body.activityId, '活动'),
      stackingGroup: text(body.stackingGroup, '叠加组', 3, 64),
      stackingMode: enumeration(body.stackingMode, '叠加方式', PROMOTION_STACKING_MODES),
      priority: integer(body.priority, '优先级', 0, 10_000),
      storeBudgetPoints: integer(body.storeBudgetPoints, '门店积分预算', 1, 10_000_000),
      perMemberPointsLimit: integer(body.perMemberPointsLimit, '每会员积分上限', 1, 100_000),
      pointValidityDays: integer(body.pointValidityDays, '积分有效天数', 1, 730),
      refundPolicy: enumeration(body.refundPolicy, '退款冲回方式', PROMOTION_REFUND_POLICIES),
      budgetReuseAfterRefund: bool(body.budgetReuseAfterRefund, '退款后是否释放预算'),
      memberLimitReuseAfterRefund: bool(body.memberLimitReuseAfterRefund, '退款后是否释放个人限额'),
      eligibleMemberLevels: memberLevels(body.eligibleMemberLevels),
      rules: body.rules.map((value, index) => rule(object(value, `第${index + 1}条积分规则`))),
      reason: text(body.reason, '起草原因', 2, 500),
      idempotencyKey: idempotency(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/promotion-policies/:policyId/approve',
    async (request, reply) => handle(reply, async () => {
      await authorized(options, request, 'loyalty.promotion.approve')
      throw new PromotionalLoyaltyError(
        'MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED',
        '该审批入口已停用，请先在会员经营配置中心生成服务端影响预览后审批',
      )
    }),
  )

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/promotion-policies/:policyId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, 'loyalty.promotion.publish')
      const body = object(request.body, '请求')
      const result = await options.service.publish(context, {
        policyId: uuid(request.params.policyId, '促销积分规则'),
        effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
        effectiveUntil: body.effectiveUntil === undefined || body.effectiveUntil === null
          ? null : timestamp(body.effectiveUntil, '失效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotency(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
}

async function authorized(
  options: PromotionalLoyaltyApiOptions,
  request: FastifyRequest,
  permission: string,
): Promise<PromotionalLoyaltyStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, (transaction) => (
    (options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction))
      .assertPermission(context.employeeId, permission)
  ), { readOnly: true })
  return context
}

function rule(value: Record<string, unknown>): PromotionRuleInput {
  return {
    ruleCode: text(value.ruleCode, '规则编号', 3, 64),
    triggerKind: enumeration(value.triggerKind, '触发条件', PROMOTION_TRIGGER_KINDS),
    points: integer(value.points, '奖励积分', 1, 100_000),
    perMemberAwardLimit: integer(value.perMemberAwardLimit, '每会员发放次数', 1, 100),
    minimumPaidAmountMinor: integer(value.minimumPaidAmountMinor, '最低付款金额', 0, 100_000_000),
    enabled: bool(value.enabled, '是否启用'),
  }
}

function memberLevels(value: unknown): PromotionMemberLevel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROMOTION_MEMBER_LEVELS.length) {
    throw invalid('至少选择一个会员等级')
  }
  return [...new Set(value.map((item) => enumeration(item, '会员等级', PROMOTION_MEMBER_LEVELS)))]
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try {
    return await execute()
  } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof PromotionalLoyaltyError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该操作的权限' } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致' } })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '请求正在处理中，请稍后查询' } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '请求保护暂时不可用' } })
    }
    throw error
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${label}格式无效`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw invalid(`${label}格式无效`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) throw invalid(`${label}长度无效`)
  return normalized
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw invalid(`${label}格式无效`)
  }
  return normalized
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Date.parse(value))) {
    throw invalid(`${label}格式无效`)
  }
  return new Date(value).toISOString()
}

function enumeration<Value extends string>(
  value: unknown,
  label: string,
  values: readonly Value[],
): Value {
  if (typeof value !== 'string' || !values.includes(value as Value)) throw invalid(`${label}无效`)
  return value as Value
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw invalid(`${label}无效`)
  return Number(value)
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${label}无效`)
  return value
}

function idempotency(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw invalid('缺少有效的幂等键')
  return value
}

function invalid(message: string): PromotionalLoyaltyError {
  return new PromotionalLoyaltyError('LOYALTY_PROMOTION_INVALID_INPUT', message, 400)
}
