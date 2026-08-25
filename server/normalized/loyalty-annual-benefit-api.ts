import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError, IdempotencyInProgressError, IdempotencyRecordError, OutboxMessageConflictError,
} from './command-executor.js'
import {
  ANNUAL_BENEFIT_ALCOHOL_HANDLING, ANNUAL_BENEFIT_RULE_KINDS, ANNUAL_BENEFIT_TIERS,
  ANNUAL_BENEFIT_FEB29_POLICIES, ANNUAL_BENEFIT_INVENTORY_REQUIREMENTS,
  ANNUAL_BENEFIT_REVOCATION_POLICIES,
  AnnualBenefitPolicyError, LoyaltyAnnualBenefitService, type AnnualBenefitRuleInput, type AnnualBenefitStaffContext,
} from './loyalty-annual-benefit-service.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface LoyaltyAnnualBenefitApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: LoyaltyAnnualBenefitService
  resolveStaffContext(request: FastifyRequest): AnnualBenefitStaffContext | Promise<AnnualBenefitStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const loyaltyAnnualBenefitApiPlugin: FastifyPluginAsync<LoyaltyAnnualBenefitApiOptions> = async (app, options) => {
  app.get('/staff/loyalty/annual-benefit-policies', async (request, reply) => handle(reply, async () => {
    const context = await authorize(options, request, 'loyalty.annual-benefit.view')
    return reply.send({ data: await options.service.configuration(context) })
  }))
  app.post('/staff/loyalty/annual-benefit-policies', async (request, reply) => handle(reply, async () => {
    const context = await authorize(options, request, 'loyalty.annual-benefit.manage')
    const body = object(request.body, '请求')
    if (!Array.isArray(body.rules)) throw invalid('年度礼遇规则必须是数组')
    const result = await options.service.draft(context, {
      policyCode: code(body.policyCode, '政策编号'), timezone: text(body.timezone ?? 'Asia/Shanghai', '时区', 3, 64),
      reason: text(body.reason, '起草说明', 2, 500), rules: body.rules.map((item, index) => rule(object(item, `第${index + 1}条规则`))),
      idempotencyKey: idempotency(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))
  app.post<{ Params: { policyId: string } }>('/staff/loyalty/annual-benefit-policies/:policyId/approve', async (request, reply) => handle(reply, async () => {
    const context = await authorize(options, request, 'loyalty.annual-benefit.approve')
    const body = object(request.body, '请求')
    const result = await options.service.approve(context, {
      policyId: uuid(request.params.policyId, '年度礼遇政策'), reason: text(body.reason, '审批说明', 2, 500), idempotencyKey: idempotency(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))
  app.post<{ Params: { policyId: string } }>('/staff/loyalty/annual-benefit-policies/:policyId/publish', async (request, reply) => handle(reply, async () => {
    const context = await authorize(options, request, 'loyalty.annual-benefit.publish')
    const body = object(request.body, '请求')
    const result = await options.service.publish(context, {
      policyId: uuid(request.params.policyId, '年度礼遇政策'), effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
      effectiveUntil: body.effectiveUntil === undefined || body.effectiveUntil === null ? null : timestamp(body.effectiveUntil, '失效时间'),
      reason: text(body.reason, '发布说明', 2, 500), idempotencyKey: idempotency(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))
  app.post('/staff/loyalty/annual-benefit-occurrences', async (request, reply) => handle(reply, async () => {
    const context = await authorize(options, request, 'loyalty.annual-benefit.occurrence.confirm')
    const body = object(request.body, '请求')
    const result = await options.service.confirmFestivalOccurrence(context, {
      ruleId: uuid(body.ruleId, '节日规则'), cycleYear: integer(body.cycleYear, '年份', 2020, 2200),
      startsOn: date(body.startsOn, '开始日期'), endsOn: date(body.endsOn, '结束日期'),
      confirmationReference: text(body.confirmationReference, '确认依据', 2, 240), idempotencyKey: idempotency(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))
}

async function authorize(options: LoyaltyAnnualBenefitApiOptions, request: FastifyRequest, permission: string) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, (transaction) => (
    (options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)).assertPermission(context.employeeId, permission)
  ), { readOnly: true })
  return context
}

function rule(value: Record<string, unknown>): AnnualBenefitRuleInput {
  return {
    ruleCode: code(value.ruleCode, '规则编号'), title: text(value.title, '规则名称', 2, 120),
    ruleKind: enumeration(value.ruleKind, '规则类型', ANNUAL_BENEFIT_RULE_KINDS),
    eligibleTier: enumeration(value.eligibleTier, '适用等级', ANNUAL_BENEFIT_TIERS),
    inheritToHigherTiers: bool(value.inheritToHigherTiers, '高等级继承'), benefitDefinitionId: uuid(value.benefitDefinitionId, '权益定义'),
    quantity: integer(value.quantity, '数量', 1, 100), validityDays: integer(value.validityDays, '有效天数', 1, 366),
    windowBeforeDays: integer(value.windowBeforeDays, '提前可用天数', 0, 90), windowAfterDays: integer(value.windowAfterDays, '延后可用天数', 0, 90),
    onSiteOnly: bool(value.onSiteOnly, '仅到店使用'), requiresTableSession: bool(value.requiresTableSession, '关联桌台'),
    memberDailyLimit: integer(value.memberDailyLimit, '会员每日上限', 1, 100), tableDailyLimit: integer(value.tableDailyLimit, '桌台每日上限', 1, 100),
    alcoholHandling: enumeration(value.alcoholHandling, '酒水处理方式', ANNUAL_BENEFIT_ALCOHOL_HANDLING),
    stackGroup: stackGroup(value.stackGroup, '叠加组'),
    priority: integer(value.priority, '优先级', 1, 32767),
    inventoryRequirement: enumeration(value.inventoryRequirement, '库存要求', ANNUAL_BENEFIT_INVENTORY_REQUIREMENTS),
    revocationPolicy: enumeration(value.revocationPolicy, '撤销策略', ANNUAL_BENEFIT_REVOCATION_POLICIES),
    feb29Policy: value.feb29Policy === undefined || value.feb29Policy === null
      ? null : enumeration(value.feb29Policy, '2月29日处理规则', ANNUAL_BENEFIT_FEB29_POLICIES),
    substitutes: array(value.substitutes ?? [], '替代品').map((item, index) => {
      const substitute = object(item, `第${index + 1}个替代品`)
      return {
        productId: uuid(substitute.productId, '替代商品'),
        priority: integer(substitute.priority, '替代品优先级', 1, 32767),
        reason: text(substitute.reason, '替代原因', 2, 240),
      }
    }),
    reservationHoldMinutes: value.reservationHoldMinutes === undefined || value.reservationHoldMinutes === null
      ? null : integer(value.reservationHoldMinutes, '优先订座保留分钟', 5, 30),
    redemptionHoldMinutes: value.redemptionHoldMinutes === undefined || value.redemptionHoldMinutes === null
      ? null : integer(value.redemptionHoldMinutes, '每日点心暂留分钟', 5, 30),
    enabled: bool(value.enabled, '是否启用'),
  }
}

async function handle(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action() } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    if (error instanceof AnnualBenefitPolicyError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    if (error instanceof StaffAccessDeniedError) return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该操作的权限' } })
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致' } })
    if (error instanceof IdempotencyInProgressError) return reply.code(425).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同请求正在处理中' } })
    if (error instanceof IdempotencyRecordError) return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '操作暂时无法确认，请稍后重试' } })
    throw error
  }
}
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${label}格式不正确`); return value as Record<string, unknown> }
function text(value: unknown, label: string, min: number, max: number) { if (typeof value !== 'string') throw invalid(`${label}必须填写`); const result = value.trim(); if (result.length < min || result.length > max) throw invalid(`${label}长度不正确`); return result }
function uuid(value: unknown, label: string) { const result=text(value,label,36,36); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw invalid(`${label}格式不正确`); return result }
function code(value: unknown, label: string) { const result=text(value,label,3,64); if(!/^[A-Z][A-Z0-9_]{2,63}$/.test(result)) throw invalid(`${label}格式不正确`); return result }
function stackGroup(value: unknown, label: string) { const result=text(value,label,2,64); if(!/^[a-z][a-z0-9_.-]{1,63}$/.test(result)) throw invalid(`${label}格式不正确`); return result }
function array(value: unknown, label: string): unknown[] { if(!Array.isArray(value)) throw invalid(`${label}必须是数组`); return value }
function integer(value: unknown, label: string, min: number, max: number) { if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max) throw invalid(`${label}超出范围`); return value as number }
function bool(value: unknown, label: string) { if(typeof value!=='boolean') throw invalid(`${label}必须是布尔值`); return value }
function date(value: unknown, label: string) { const result=text(value,label,10,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw invalid(`${label}格式不正确`); return result }
function timestamp(value: unknown, label: string) { const result=text(value,label,20,40); if(!Number.isFinite(Date.parse(result))) throw invalid(`${label}格式不正确`); return result }
function enumeration<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] { if(typeof value!=='string'||!values.includes(value)) throw invalid(`${label}不受支持`); return value as Values[number] }
function idempotency(request: FastifyRequest) { const value=request.headers['idempotency-key']; if(typeof value!=='string'||value.length<8||value.length>128) throw invalid('缺少有效的幂等键'); return value }
function invalid(message: string) { return new AnnualBenefitPolicyError('INVALID_REQUEST', message, 400) }
