import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ActivityPaymentService } from './activity-payment-service.js'
import {
  ActivityOperationsError,
  type ActivityDraftInput,
  type ActivityPackageDraftInput,
  type ActivityRegistrationOperation,
} from './activity-operations-repository.js'
import {
  ActivityOperationsService,
  type ActivityOperationsStaffContext,
} from './activity-operations-service.js'
import type { CustomerExperienceService } from './customer-experience-service.js'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
} from './command-executor.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'
import { isPublicMediaAssetUrl } from './media-asset-url.js'
import { isStaffAuthenticationRequiredError, STAFF_AUTHENTICATION_REQUIRED_ERROR } from './staff-api-authentication.js'
import { StaffAccessDeniedError, StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction } from './transaction-runner.js'

export interface ActivityOperationsApiOptions {
  transactions: Pick<ScopedPostgresTransactionRunner, 'run'>
  service: ActivityOperationsService
  activityPublisher: Pick<CustomerExperienceService, 'publishActivity'>
  activityPayments: Pick<ActivityPaymentService, 'requestRefund'>
  resolveStaffContext(request: FastifyRequest):
    | ActivityOperationsStaffContext
    | Promise<ActivityOperationsStaffContext>
  createStaffAccessRepository?(transaction: ScopedTransaction): Pick<StaffAccessRepository, 'assertPermission'>
}

export const activityOperationsApiPlugin: FastifyPluginAsync<ActivityOperationsApiOptions> = async (app, options) => {
  app.post('/staff/activity-operations', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, ['community.activity.manage'])
    const body = object(request.body, '活动草稿')
    const result = await options.service.createDraft(context, {
      draft: draft(body),
      reason: text(body.reason, '建立原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/staff/activity-operations', async (request, reply) => handle(reply, async () => {
    const context = await authorizedAny(options, request, ['community.activity.view', 'community.activity.manage', 'community.activity.publish'])
    return reply.send({ data: await options.service.list(context) })
  }))

  app.get('/staff/activity-operations/component-catalog', async (request, reply) => handle(reply, async () => {
    const context = await authorized(options, request, ['community.activity.manage'])
    return reply.send({ data: await options.service.componentCatalog(context) })
  }))

  app.get<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId',
    async (request, reply) => handle(reply, async () => {
      const context = await authorizedAny(options, request, ['community.activity.view', 'community.activity.manage', 'community.activity.publish'])
      return reply.send({ data: await options.service.detail(context, publicId(request.params.publicId)) })
    }),
  )

  app.put<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/draft',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '活动草稿')
      const result = await options.service.updateDraft(context, {
        publicId: publicId(request.params.publicId),
        draft: draft(body),
        reason: text(body.reason, '修改原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.publish'])
      const result = await options.activityPublisher.publishActivity(context, {
        publicId: publicId(request.params.publicId),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string; packagePublicId: string; action: string } }>(
    '/staff/activity-operations/:publicId/packages/:packagePublicId/:action',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '套餐上下架操作')
      const action = packageAvailabilityOperation(request.params.action)
      const result = await options.service.setPackageAvailability(context, {
        activityPublicId: publicId(request.params.publicId),
        packagePublicId: publicId(request.params.packagePublicId),
        operation: action,
        reason: text(body.reason, '操作原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/activity-operations/:publicId/waitlist-retry',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '候补任务重试')
      const result = await options.service.retryWaitlistPromotion(context, {
        publicId: publicId(request.params.publicId),
        reason: text(body.reason, '重试原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { registrationPublicId: string; action: string } }>(
    '/staff/activity-operations/registrations/:registrationPublicId/:action',
    async (request, reply) => handle(reply, async () => {
      const operation = registrationOperation(request.params.action)
      const context = await authorized(options, request, ['community.activity.manage'])
      const body = object(request.body, '报名操作')
      const result = await options.service.transitionRegistration(context, {
        publicId: publicId(request.params.registrationPublicId),
        operation,
        reason: text(body.reason, '操作原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { registrationPublicId: string } }>(
    '/staff/activity-operations/registrations/:registrationPublicId/refund-request',
    async (request, reply) => handle(reply, async () => {
      const context = await authorized(options, request, ['community.activity.manage', 'refund.request'])
      const body = object(request.body, '退款申请')
      const result = await options.activityPayments.requestRefund(context, {
        registrationPublicId: publicId(request.params.registrationPublicId),
        reason: text(body.reason, '退款原因', 2, 1_000),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
}

async function authorized(
  options: ActivityOperationsApiOptions,
  request: FastifyRequest,
  permissions: readonly string[],
): Promise<ActivityOperationsStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    for (const permission of permissions) await access.assertPermission(context.employeeId, permission)
  }, { readOnly: true })
  return context
}

async function authorizedAny(
  options: ActivityOperationsApiOptions,
  request: FastifyRequest,
  permissions: readonly string[],
): Promise<ActivityOperationsStaffContext> {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, async (transaction) => {
    const access = options.createStaffAccessRepository?.(transaction) ?? new StaffAccessRepository(transaction)
    let denied: unknown = new StaffAccessDeniedError('当前岗位没有活动读取权限')
    for (const permission of permissions) {
      try {
        await access.assertPermission(context.employeeId, permission)
        return
      } catch (error) {
        if (!(error instanceof StaffAccessDeniedError)) throw error
        denied = error
      }
    }
    throw denied
  }, { readOnly: true })
  return context
}

function draft(value: Record<string, unknown>): ActivityDraftInput {
  const visibility = enumeration(value.visibility, '可见范围', ['public','member','segment'] as const)
  const audienceMemberLevels = stringList(
    value.audienceMemberLevels,
    '会员等级',
    ['member','silver','gold'] as const,
  )
  const audienceLifecycleStages = stringList(
    value.audienceLifecycleStages,
    '会员阶段',
    ['new','active','high_value','at_risk','dormant'] as const,
  )
  if (visibility === 'segment' && audienceMemberLevels.length + audienceLifecycleStages.length === 0) {
    throw invalid('指定客群活动至少选择一个会员等级或阶段')
  }
  if (visibility !== 'segment' && audienceMemberLevels.length + audienceLifecycleStages.length > 0) {
    throw invalid('公开或全会员活动不能携带指定客群条件')
  }
  const startsAt = timestamp(value.startsAt, '开始时间')
  const endsAt = timestamp(value.endsAt, '结束时间')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw invalid('结束时间必须晚于开始时间')
  const paymentMode = enumeration(
    value.paymentMode,
    '预付方式',
    ['none','deposit_optional','deposit_required','full_required'] as const,
  )
  const feeAmountMinor = integer(value.feeAmountMinor, '活动费用', 0, 100_000_000)
  const depositAmountMinor = integer(value.depositAmountMinor, '活动订金', 0, 100_000_000)
  if (depositAmountMinor > feeAmountMinor) throw invalid('活动订金不能超过活动费用')
  if (paymentMode === 'none' && depositAmountMinor !== 0) throw invalid('无需预付时订金必须为0')
  if ((paymentMode === 'deposit_optional' || paymentMode === 'deposit_required')
    && (feeAmountMinor <= 0 || depositAmountMinor <= 0)) throw invalid('订金模式必须配置正数费用和订金')
  if (paymentMode === 'full_required' && (feeAmountMinor <= 0 || depositAmountMinor !== 0)) {
    throw invalid('全额预付必须配置正数费用且订金为0')
  }
  const coverUrl = optionalText(value.coverUrl, '封面地址', 1_000)
  if (coverUrl !== null && !isPublicMediaAssetUrl(coverUrl)) throw invalid('封面必须从站内图片库选择，单张不超过200KB')
  const capacity = integer(value.capacity, '人数上限', 1, 1_000)
  const packageSelectionRequired = optionalBoolean(value.packageSelectionRequired, false, '套餐是否必选')
  const packages = activityPackages(value.packages, capacity, endsAt)
  if (packageSelectionRequired && packages.length === 0) throw invalid('套餐必选活动至少需要一档套餐')
  return {
    kind: enumeration(value.kind, '活动类型', ['member_night','hike','camping','city_walk','music_picnic','proposal','other'] as const),
    title: text(value.title, '活动名称', 2, 120),
    summary: text(value.summary, '列表摘要', 2, 600),
    coverUrl,
    startsAt,
    endsAt,
    assemblyLocation: text(value.assemblyLocation, '集合地点', 2, 240),
    capacity,
    feeAmountMinor,
    depositAmountMinor,
    feeBasis: enumeration(value.feeBasis, '计价方式', ['per_person','per_registration'] as const),
    paymentMode,
    paymentDeadlineMinutes: integer(value.paymentDeadlineMinutes, '付款时限', 5, 1_440),
    paymentRuleText: text(value.paymentRuleText, '付款说明', 2, 240),
    pointsReward: integer(value.pointsReward, '积分奖励（当前停用）', 0, 0),
    visibility,
    audienceMemberLevels,
    audienceLifecycleStages,
    safetyPolicyVersion: text(value.safetyPolicyVersion, '安全规则版本', 1, 64),
    safetyAcknowledgementText: text(value.safetyAcknowledgementText, '安全确认文案', 2, 1_000),
    safetyRequirements: textList(value.safetyRequirements, '安全要求', 1, 50, 500),
    refundPolicyVersion: text(value.refundPolicyVersion, '退款规则版本', 3, 64),
    refundPolicySummary: text(value.refundPolicySummary, '退款说明', 2, 500),
    activityDetails: text(value.activityDetails, '活动详情', 10, 4_000),
    includedItems: textList(value.includedItems, '费用包含', 0, 100, 500),
    participationRequirements: textList(value.participationRequirements, '参与条件', 0, 100, 500),
    contactInstructions: text(value.contactInstructions, '联系与集合说明', 2, 1_200),
    memberBenefitText: optionalText(value.memberBenefitText, '会员权益与赠送', 1_000),
    packageSelectionRequired,
    packages,
  }
}

function activityPackages(
  value: unknown,
  activityCapacity: number,
  endsAt: string,
): ActivityPackageDraftInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid('活动套餐最多20档')
  const packages = value.map((entry, index) => activityPackage(object(entry, `第${index + 1}档套餐`), activityCapacity, endsAt, index))
  if (new Set(packages.map((activityPackage) => activityPackage.name)).size !== packages.length) {
    throw invalid('活动套餐名称不能重复')
  }
  return packages
}

function activityPackage(
  value: Record<string, unknown>,
  activityCapacity: number,
  endsAt: string,
  index: number,
): ActivityPackageDraftInput {
  const feeAmountMinor = integer(value.feeAmountMinor, '套餐加购价', 0, 100_000_000)
  const depositAmountMinor = integer(value.depositAmountMinor, '套餐订金', 0, 100_000_000)
  const paymentMode = enumeration(value.paymentMode, '套餐预付方式', ['none','deposit_optional','deposit_required','full_required'] as const)
  if (depositAmountMinor > feeAmountMinor) throw invalid('套餐订金不能超过加购价')
  if (paymentMode === 'none' && depositAmountMinor !== 0) throw invalid('无需预付的套餐订金必须为0')
  if ((paymentMode === 'deposit_optional' || paymentMode === 'deposit_required')
    && (feeAmountMinor <= 0 || depositAmountMinor <= 0)) throw invalid('套餐订金模式必须配置正数加购价和订金')
  if (paymentMode === 'full_required' && (feeAmountMinor <= 0 || depositAmountMinor !== 0)) {
    throw invalid('套餐全额预付必须配置正数加购价且订金为0')
  }
  const imageUrl = optionalText(value.imageUrl, '套餐图片地址', 1_000)
  if (imageUrl !== null && !isPublicMediaAssetUrl(imageUrl)) throw invalid('套餐图片必须从站内图片库选择，单张不超过200KB')
  const availableFrom = optionalTimestamp(value.availableFrom, '套餐开售时间')
  const availableUntil = optionalTimestamp(value.availableUntil, '套餐停售时间')
  if (availableFrom !== null && Date.parse(availableFrom) >= Date.parse(endsAt)) {
    throw invalid('套餐开售时间必须早于活动结束时间')
  }
  if (availableUntil !== null && Date.parse(availableUntil) > Date.parse(endsAt)) {
    throw invalid('套餐停售时间不能晚于活动结束时间')
  }
  if (availableFrom !== null && availableUntil !== null && Date.parse(availableUntil) <= Date.parse(availableFrom)) {
    throw invalid('套餐停售时间必须晚于开售时间')
  }
  const componentsValue = value.components === undefined ? [] : value.components
  if (!Array.isArray(componentsValue) || componentsValue.length > 100) throw invalid('套餐物料最多100项')
  const components = componentsValue.map((entry, componentIndex) => {
    const component = object(entry, `套餐物料第${componentIndex + 1}项`)
    return {
      inventoryItemId: uuid(component.inventoryItemId, '套餐物料编号'),
      quantity: decimal(component.quantity, '套餐物料数量'),
      perParticipant: optionalBoolean(component.perParticipant, true, '是否按报名人数占用'),
    }
  })
  if (new Set(components.map((component) => component.inventoryItemId)).size !== components.length) {
    throw invalid('同一套餐不能重复选择同一物料')
  }
  return {
    name: text(value.name, '套餐名称', 2, 120), description: optionalText(value.description, '套餐说明', 1_000) ?? '', imageUrl,
    includedItems: textList(value.includedItems ?? [], '套餐包含内容', 0, 100, 500),
    capacity: integer(value.capacity, '套餐名额', 1, activityCapacity),
    memberPurchaseLimit: integer(value.memberPurchaseLimit ?? 1, '每会员限购', 1, 20),
    feeAmountMinor,depositAmountMinor,feeBasis: enumeration(value.feeBasis, '套餐计价方式', ['per_person','per_registration'] as const),
    paymentMode,paymentDeadlineMinutes: integer(value.paymentDeadlineMinutes, '套餐付款时限', 5, 1_440),
    paymentRuleText: text(value.paymentRuleText, '套餐付款说明', 2, 240),
    redemptionPolicyVersion: optionalText(value.redemptionPolicyVersion, '套餐取用规则版本', 64),
    refundPolicyVersion: optionalText(value.refundPolicyVersion, '套餐退款规则版本', 64),
    sortOrder: integer(value.sortOrder ?? index, '套餐排序', 0, 10_000),availableFrom,availableUntil,components,
  }
}

async function handle(reply: FastifyReply, execute: () => Promise<unknown>) {
  try { return await execute() } catch (error) {
    if (isStaffAuthenticationRequiredError(error)) {
      return reply.code(401).send({ error: STAFF_AUTHENTICATION_REQUIRED_ERROR })
    }
    if (error instanceof ActivityOperationsApiRequestError) {
      return reply.code(400).send({ error: { code: 'ACTIVITY_OPERATION_INPUT_INVALID', message: error.message } })
    }
    if (error instanceof ActivityOperationsError || error instanceof CustomerExperienceRequestError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof StaffAccessDeniedError) {
      return reply.code(403).send({ error: { code: 'STAFF_ACCESS_DENIED', message: '没有执行该活动操作的权限' } })
    }
    if (error instanceof IdempotencyConflictError || error instanceof OutboxMessageConflictError) {
      return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '重复请求内容不一致' } })
    }
    if (error instanceof IdempotencyInProgressError) {
      return reply.code(425).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同活动操作正在处理中' } })
    }
    if (error instanceof IdempotencyRecordError) {
      return reply.code(503).send({ error: { code: 'IDEMPOTENCY_UNAVAILABLE', message: '活动操作暂时无法确认，请刷新后重试' } })
    }
    throw error
  }
}

class ActivityOperationsApiRequestError extends Error {}

function invalid(message: string) { return new ActivityOperationsApiRequestError(message) }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${label}格式不正确`)
  return value as Record<string, unknown>
}

function publicId(value: unknown): string {
  return pattern(text(value, '公开编号', 8, 128), /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/, '公开编号')
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (Array.isArray(value)) throw invalid('Idempotency-Key格式不正确')
  return pattern(text(value, 'Idempotency-Key', 8, 128), /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/, 'Idempotency-Key')
}

function registrationOperation(value: string): ActivityRegistrationOperation {
  if (value === 'check-in') return 'check_in'
  if (value === 'fulfill-package') return 'fulfill_package'
  if (value === 'no-show') return 'no_show'
  if (value === 'cancel') return 'cancel'
  throw invalid('不支持的报名操作')
}

function packageAvailabilityOperation(value: string): 'pause' | 'resume' {
  if (value === 'pause' || value === 'resume') return value
  throw invalid('不支持的套餐上下架操作')
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw invalid(`${label}必须填写`)
  const normalized = value.trim()
  if (normalized.length < minimum || normalized.length > maximum) throw invalid(`${label}长度不正确`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, label, 1, maximum)
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(`${label}格式不正确`)
  return value
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return timestamp(value, label)
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid(`${label}格式不正确`)
  const normalized = String(value).trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized) || Number(normalized) <= 0 || Number(normalized) > 1_000_000) {
    throw invalid(`${label}格式不正确`)
  }
  return normalized
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label, 8, 64)
  if (!Number.isFinite(Date.parse(normalized))) throw invalid(`${label}格式不正确`)
  return new Date(normalized).toISOString()
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${label}超出范围`)
  }
  return value as number
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid(`${label}不受支持`)
  return value as Values[number]
}

function stringList<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number][] {
  if (!Array.isArray(value) || value.length > values.length) throw invalid(`${label}格式不正确`)
  return [...new Set(value.map((item) => enumeration(item, label, values)))]
}

function textList(
  value: unknown,
  label: string,
  minimumItems: number,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw invalid(`${label}项目数量不正确`)
  }
  return value.map((item, index) => text(item, `${label}第${index + 1}项`, 1, maximumLength))
}

function pattern(value: string, expression: RegExp, label: string): string {
  if (!expression.test(value)) throw invalid(`${label}格式不正确`)
  return value
}
