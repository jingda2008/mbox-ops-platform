import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { JsonObject } from './command-executor.js'
import {
  CustomerExperienceRequestError,
  type AlcoholPreference,
  type CheckoutBasketLine,
  type CustomerOccasion,
  type ExperienceLevel,
  type RecommendationAnswer,
  type ServiceIntensity,
} from './customer-experience-repository.js'
import {
  CustomerExperienceService,
  resolveTableExperienceContext,
  type PublicCustomerExperienceContext,
  type StaffCustomerExperienceContext,
} from './customer-experience-service.js'
import {
  GuestAuthenticationRequiredError,
  GuestDeviceBindingError,
  GuestStoreScopeError,
} from './guest-request-context.js'
import {
  NormalizedAuthenticationRequiredError,
  NormalizedStoreUnavailableError,
  TrustedStoreScopeError,
} from './normalized-request-context.js'
import { ReservationGuestSessionInvalidError } from './reservation-guest-session.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import { StaffSessionNotFoundError } from './staff-session-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

interface GuestExperienceContext {
  scope: Readonly<StoreScope>
  customerId: string
  tableSessionId: string | null
  businessDate: string
  actorRef: string
}

interface CustomerExperienceApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: CustomerExperienceService
  resolvePublicContext(request: FastifyRequest): Promise<PublicCustomerExperienceContext> | PublicCustomerExperienceContext
  resolveGuestContext(request: FastifyRequest): Promise<GuestExperienceContext> | GuestExperienceContext
  resolveStaffContext(request: FastifyRequest): Promise<StaffCustomerExperienceContext> | StaffCustomerExperienceContext
}

const OCCASIONS = ['business', 'friends', 'date', 'birthday', 'music', 'relax', 'other'] as const
const ALCOHOL = ['cocktail', 'wine', 'sparkling', 'beer', 'whisky', 'baijiu', 'non_alcoholic', 'mixed', 'undecided'] as const
const LEVELS = ['comfortable', 'enhanced', 'signature'] as const
const INTENSITIES = ['quiet', 'balanced', 'hosted'] as const

export const customerExperienceApiPlugin: FastifyPluginAsync<CustomerExperienceApiOptions> = async (app, options) => {
  app.get('/public/mini/bootstrap', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.portal(context) })
  }))

  app.get('/public/mini/activities', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.activities(context) })
  }))

  app.post('/public/mini/membership/enroll', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const result = await options.service.enrollMembership(context, { idempotencyKey: idempotencyKey(request) })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.patch('/public/mini/preferences', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.updatePreferences(context, {
      ...(body.displayName === undefined ? {} : { displayName: optionalText(body.displayName, '称呼', 80) }),
      preferences: publicPreferences(body.preferences),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { activityPublicId: string } }>('/public/mini/activities/:activityPublicId/registrations', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.registerActivity(context, {
      activityPublicId: publicId(request.params.activityPublicId),
      partySize: integer(body.partySize, '报名人数', 1, 20),
      contactSnapshot: object(body.contactSnapshot, '联系信息'),
      safetyAcknowledgement: object(body.safetyAcknowledgement, '安全确认'),
      paymentChoice: enumValue(body.paymentChoice ?? 'none', '付款选择', ['none', 'deposit', 'full'] as const),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { registrationPublicId: string } }>('/public/mini/activity-registrations/:registrationPublicId/cancel', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.cancelActivity(context, {
      registrationPublicId: publicId(request.params.registrationPublicId),
      reason: text(body.reason, '取消原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/guest/experience/recommendations', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const answers = recommendationAnswers(body, context.partySize)
    const result = await options.service.recommend(context, answers, idempotencyKey(request))
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/guest/experience/plans', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const result = await options.service.createPlan(context, {
      recommendationPublicId: publicIdValue(body.recommendationPublicId, '推荐编号'),
      selectedProductId: uuid(body.selectedProductId, '套餐商品'),
      promiseSummary: text(body.promiseSummary, '体验承诺', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/guest/experience/plan', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    return reply.send({ data: await options.service.plan(context) })
  }))

  app.post('/guest/checkout/upgrade-offers', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const result = await options.service.prepareCheckoutUpgrade(context, {
      items: checkoutItems(body.items),
      ...(body.occasion === undefined ? {} : { occasion: enumValue(body.occasion, '场景', OCCASIONS) }),
      ...(body.alcoholPreference === undefined ? {} : { alcoholPreference: enumValue(body.alcoholPreference, '酒水偏好', ALCOHOL) }),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed, pricing: 'server_authoritative' } })
  }))

  app.get('/staff/customer-experience/dashboard', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.view')
    return reply.send({ data: await options.service.dashboard(context) })
  }))

  app.put<{ Params: { featureCode: string } }>('/staff/customer-experience/features/:featureCode', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.feature.manage')
    const body = objectBody(request.body)
    const result = await options.service.setFeature(context, {
      featureCode: featureCode(request.params.featureCode),
      rolloutState: enumValue(body.rolloutState, '启用状态', ['disabled', 'shadow', 'pilot', 'enabled'] as const),
      configuration: object(body.configuration, '配置'),
      reason: text(body.reason, '修改原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.put<{ Params: { ruleCode: string } }>('/staff/customer-experience/checkout-upgrade-rules/:ruleCode', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.feature.manage')
    const body = objectBody(request.body)
    const result = await options.service.upsertCheckoutUpgradeRule(context, {
      code: ruleCode(request.params.ruleCode),
      name: text(body.name, '规则名称', 2, 80),
      sourceProductId: uuid(body.sourceProductId, '原酒水'),
      targetProductId: uuid(body.targetProductId, '目标套餐'),
      minimumPartySize: integer(body.minimumPartySize, '最少人数', 1, 200),
      maximumPartySize: integer(body.maximumPartySize, '最多人数', 1, 200),
      occasionTags: stringList(body.occasionTags, '场景标签', OCCASIONS),
      alcoholPreferenceTags: stringList(body.alcoholPreferenceTags, '酒水标签', ALCOHOL),
      promptTitle: text(body.promptTitle, '提示标题', 2, 60),
      promptBody: text(body.promptBody, '提示内容', 2, 240),
      callToAction: text(body.callToAction, '按钮文字', 2, 30),
      priority: integer(body.priority, '优先级', 0, 10_000),
      offerValidMinutes: integer(body.offerValidMinutes, '有效分钟', 2, 30),
      status: enumValue(body.status, '规则状态', ['draft', 'active', 'paused', 'retired'] as const),
      configuration: object(body.configuration, '规则配置'),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/staff/community-activities', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'community.activity.manage')
    const body = objectBody(request.body)
    const result = await options.service.createActivity(context, {
      kind: enumValue(body.kind, '活动类型', ['member_night', 'hike', 'camping', 'city_walk', 'music_picnic', 'proposal', 'other'] as const),
      title: text(body.title, '活动名称', 2, 120),
      summary: text(body.summary, '活动说明', 2, 600),
      coverUrl: optionalText(body.coverUrl, '封面地址', 1000),
      startsAt: timestamp(body.startsAt, '开始时间'),
      endsAt: timestamp(body.endsAt, '结束时间'),
      assemblyLocation: text(body.assemblyLocation, '集合地点', 2, 240),
      capacity: integer(body.capacity, '人数上限', 1, 1000),
      feeAmountMinor: integer(body.feeAmountMinor, '活动费用', 0, 100_000_000),
      depositAmountMinor: integer(body.depositAmountMinor, '活动订金', 0, 100_000_000),
      feeBasis: enumValue(body.feeBasis, '计价方式', ['per_person', 'per_registration'] as const),
      paymentMode: enumValue(body.paymentMode, '预付方式', ['none', 'deposit_optional', 'deposit_required', 'full_required'] as const),
      paymentDeadlineMinutes: integer(body.paymentDeadlineMinutes, '付款时限', 5, 1440),
      paymentRuleText: text(body.paymentRuleText, '付款规则说明', 2, 240),
      refundPolicySnapshot: object(body.refundPolicySnapshot, '退款规则'),
      pointsReward: integer(body.pointsReward, '积分奖励', 0, 1_000_000),
      visibility: enumValue(body.visibility, '可见范围', ['public', 'member', 'segment'] as const),
      audienceRule: object(body.audienceRule, '客群规则'),
      safetySnapshot: object(body.safetySnapshot, '安全规则'),
      salesCopy: object(body.salesCopy, '销售文案'),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string } }>('/staff/community-activities/:publicId/publish', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'community.activity.publish')
    const result = await options.service.publishActivity(context, {
      publicId: publicId(request.params.publicId),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { customerId: string } }>('/staff/customers/:customerId/points', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.adjust')
    const body = objectBody(request.body)
    const result = await options.service.adjustPoints(context, {
      customerId: uuid(request.params.customerId, '客户'),
      pointsDelta: integer(body.pointsDelta, '积分变化', -1_000_000, 1_000_000, undefined, true),
      reason: text(body.reason, '调整原因', 2, 240),
      sourceType: enumValue(body.sourceType, '来源', ['order', 'activity', 'benefit', 'campaign', 'service_recovery', 'manual'] as const),
      sourceId: text(body.sourceId, '来源编号', 1, 128),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/staff/customer-followups', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.relationship.manage')
    const body = objectBody(request.body)
    const result = await options.service.createFollowup(context, {
      customerId: uuid(body.customerId, '客户'),
      ownerEmployeeId: uuid(body.ownerEmployeeId, '负责人'),
      sourceType: enumValue(body.sourceType, '来源', ['visit', 'reservation', 'activity', 'feedback', 'manual'] as const),
      sourceId: optionalText(body.sourceId, '来源编号', 128),
      priority: enumValue(body.priority, '优先级', ['low', 'normal', 'high', 'urgent'] as const),
      action: text(body.action, '跟进动作', 2, 600),
      channel: enumValue(body.channel, '跟进渠道', ['wecom', 'wechat_service', 'phone', 'sms', 'in_person'] as const),
      dueAt: timestamp(body.dueAt, '跟进时间'),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { cueId: string } }>('/staff/customer-experience/cues/:cueId/complete', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.manage')
    const body = objectBody(request.body)
    const result = await options.service.completeCue(context, {
      cueId: uuid(request.params.cueId, '体验节点'),
      note: text(body.note, '完成说明', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))
}

async function tableContext(options: CustomerExperienceApiOptions, request: FastifyRequest) {
  const guest = await options.resolveGuestContext(request)
  if (guest.tableSessionId === null) throw new CustomerExperienceRequestError('请入座扫码后使用现场体验', 'TABLE_SESSION_REQUIRED', 409)
  return options.transactions.run(guest.scope, (transaction) => resolveTableExperienceContext(transaction, {
    customerId: guest.customerId,
    tableSessionId: guest.tableSessionId!,
    businessDate: guest.businessDate,
    actorRef: guest.actorRef,
  }), { readOnly: true }).then((context) => ({ ...context, scope: guest.scope }))
}

async function staffContextWithPermission(options: CustomerExperienceApiOptions, request: FastifyRequest, permission: string) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, (transaction) => (
    new StaffAccessRepository(transaction).assertPermission(context.employeeId, permission)
  ), { readOnly: true })
  return context
}

async function handle(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action() } catch (error) {
    const mapped = errorResponse(error)
    return reply.code(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message } })
  }
}

function errorResponse(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof CustomerExperienceRequestError) return { statusCode: error.statusCode, code: error.code, message: error.message }
  if (error instanceof ReservationGuestSessionInvalidError || error instanceof GuestAuthenticationRequiredError
    || error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return { statusCode: 401, code: 'AUTHENTICATION_REQUIRED', message: '登录状态已失效，请重新进入' }
  }
  if (error instanceof StaffAccessDeniedError) return { statusCode: 403, code: 'PERMISSION_DENIED', message: '当前岗位没有这项权限' }
  if (error instanceof GuestDeviceBindingError || error instanceof GuestStoreScopeError
    || error instanceof NormalizedStoreUnavailableError || error instanceof TrustedStoreScopeError) {
    return { statusCode: 403, code: 'SCOPE_DENIED', message: '当前门店或设备身份不匹配' }
  }
  return { statusCode: 500, code: 'CUSTOMER_EXPERIENCE_FAILED', message: '客户体验服务暂时没有接上' }
}

function recommendationAnswers(body: JsonObject, partySize: number): RecommendationAnswer {
  return {
    partySize,
    occasion: enumValue(body.occasion, '聚会目的', OCCASIONS) as CustomerOccasion,
    alcoholPreference: enumValue(body.alcoholPreference, '酒水偏好', ALCOHOL) as AlcoholPreference,
    experienceLevel: enumValue(body.experienceLevel, '体验档位', LEVELS) as ExperienceLevel,
    serviceIntensity: enumValue(body.serviceIntensity, '服务方式', INTENSITIES) as ServiceIntensity,
  }
}

function publicPreferences(value: unknown): JsonObject {
  const source = object(value, '偏好')
  const allowed = ['preferredAlcohol', 'tasteNotes', 'musicStyles', 'serviceIntensity', 'seatPreference', 'dietaryNotes', 'birthdayMonthDay']
  return Object.fromEntries(allowed.flatMap((key) => (
    source[key] === undefined ? [] : [[key, source[key]]]
  ))) as JsonObject
}

function checkoutItems(value: unknown): CheckoutBasketLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw new CustomerExperienceRequestError('购物车商品数量不正确')
  return value.map((entry) => {
    const item = object(entry, '购物车商品')
    return {
      productId: uuid(item.productId, '商品'),
      quantity: integer(item.quantity, '数量', 1, 20),
      ...(item.note === undefined ? {} : { note: optionalText(item.note, '备注', 240) }),
    }
  })
}

function objectBody(value: unknown): JsonObject { return object(value, '请求内容') }
function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CustomerExperienceRequestError(`${label}格式不正确`)
  return value as JsonObject
}
function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new CustomerExperienceRequestError('缺少有效的幂等编号')
  return value
}
function publicId(value: string): string { return text(value, '公开编号', 8, 128) }
function publicIdValue(value: unknown, label: string): string { return text(value, label, 8, 128) }
function featureCode(value: string): string {
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(value)) throw new CustomerExperienceRequestError('功能编号格式不正确')
  return value
}
function ruleCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_-]{2,63}$/.test(value)) throw new CustomerExperienceRequestError('规则编号格式不正确')
  return value
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CustomerExperienceRequestError(`${label}编号不正确`)
  return value
}
function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new CustomerExperienceRequestError(`${label}不正确`)
  return value.trim()
}
function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === '') return null
  return text(value, label, 1, max)
}
function integer(value: unknown, label: string, min: number, max: number, fallback?: number, allowZero = false): number {
  const number = value === undefined && fallback !== undefined ? fallback : value
  if (!Number.isInteger(number) || (number as number) < min || (number as number) > max || (!allowZero && number === 0 && min < 0)) {
    throw new CustomerExperienceRequestError(`${label}不正确`)
  }
  return number as number
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new CustomerExperienceRequestError(`${label}不正确`)
  return new Date(value).toISOString()
}
function enumValue<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new CustomerExperienceRequestError(`${label}不正确`)
  return value as Values[number]
}
function stringList<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number][] {
  if (!Array.isArray(value) || value.length > values.length) throw new CustomerExperienceRequestError(`${label}不正确`)
  const result = [...new Set(value.map((entry) => enumValue(entry, label, values)))]
  return result
}
