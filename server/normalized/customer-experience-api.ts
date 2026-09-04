import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyRecordError,
  OutboxMessageConflictError,
  type JsonObject,
} from './command-executor.js'
import {
  CustomerExperienceRequestError,
  type ProtectedActivityRegistrationContact,
  type AlcoholPreference,
  type CheckoutBasketLine,
  type CustomerOccasion,
  type ExperienceLevel,
  type RecommendationAnswer,
  type RecommendationIntent,
  type ServiceIntensity,
  type TableExperienceContext,
} from './customer-experience-repository.js'
import type { ObservationEventInput } from './customer-experience-observation-repository.js'
import type { ProtectedContact } from './waitlist-repository.js'
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
import type { ActivityPaymentService } from './activity-payment-service.js'
import type {
  MembershipRecoveryPhoneAuthorizationPort,
  MembershipRecoveryService,
} from './membership-recovery-service.js'
import type { MembershipTermsService } from './membership-terms-service.js'
import type { MembershipEnrollmentService } from './membership-enrollment-service.js'
import { EmployeeTableAccessDeniedError } from './employee-table-access.js'
import { createMemberIdentificationQrDataUrl } from './member-code-qr.js'
import { ActivityPaymentLateSuccessRefundRequiredError } from './payment-repository.js'
import {
  RefundApprovalRequiredError,
  RefundLimitError,
  RefundTransitionError,
} from './refund-repository.js'

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
  protectContact(value: string): Promise<ProtectedContact> | ProtectedContact
  activityPayments?: ActivityPaymentService
  resolveActivityPaymentReady?: (
    scope: Readonly<StoreScope>, customerId: string,
  ) => Promise<boolean>
  notificationConsentPolicy?: Readonly<{ serviceTemplateId: string; policyVersion: string }> | null
  membershipRecovery?: MembershipRecoveryService
  recoveryPhoneAuthorization?: MembershipRecoveryPhoneAuthorizationPort
  membershipTerms?: MembershipTermsService
  membershipEnrollment?: MembershipEnrollmentService
}

const OCCASIONS = ['business', 'friends', 'date', 'birthday', 'music', 'relax', 'other'] as const
const ALCOHOL = ['cocktail', 'wine', 'sparkling', 'beer', 'whisky', 'baijiu', 'non_alcoholic', 'mixed', 'undecided'] as const
const LEVELS = ['comfortable', 'enhanced', 'signature'] as const
const INTENSITIES = ['quiet', 'balanced', 'hosted'] as const
const PERFORMANCE_PHASES = ['before_show', 'acoustic', 'band_live', 'intermission', 'after_show'] as const

interface PrivacyPolicyReleaseRow extends Record<string, unknown> {
  policy_version: string
  content_markdown: string
  content_sha256: string
  operator_name: string
  contact: string
  data_retention_policy_version: string
  third_party_register_version: string
  effective_at: string
}

interface StaffMemberAccountRow extends Record<string, unknown> {
  membership_id: string
  member_no: string
  membership_status: string
  current_tier: 'member' | 'silver' | 'gold'
  available_points: string | number
  pending_recovery_points: string | number
  lifetime_growth: string | number
  qualification_growth: string | number
  tier_qualification_growth: string | number | null
  tier_period_ends_at: string | null
  updated_at: string
}

interface StaffMemberLedgerRow extends Record<string, unknown> {
  entry_type: string
  delta: string | number
  balance_after: string | number
  reason: string
  occurred_at: string
}

export const customerExperienceApiPlugin: FastifyPluginAsync<CustomerExperienceApiOptions> = async (app, options) => {
  app.get('/public/mini/bootstrap', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const portal = await options.service.portal(context)
    const membership = portal.membership === null ? null : {
      ...portal.membership,
      memberCodeQrDataUrl: await createMemberIdentificationQrDataUrl(portal.membership.memberNo),
    }
    reply.header('cache-control', 'private, no-store')
    reply.header('pragma', 'no-cache')
    return reply.send({ data: { ...portal, membership } })
  }))

  app.put('/public/mini/annual-benefits/birthday-consent', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.recordBirthdayBenefitConsent(context, {
      birthdayMonthDay: text(body.birthdayMonthDay, '生日月日', 5, 5), idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/public/mini/annual-benefits/birthday-consent/withdraw', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.withdrawBirthdayBenefitConsent(context, {
      reason: text(body.reason, '撤回说明', 2, 500), idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/public/mini/privacy-policy', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const policy = await options.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<PrivacyPolicyReleaseRow>(`
        SELECT policy_version,content_markdown,content_sha256,operator_name,contact,
          data_retention_policy_version,third_party_register_version,effective_at
        FROM mbox.privacy_policy_releases
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND status='published' AND effective_at<=clock_timestamp() AND withdrawn_at IS NULL
        ORDER BY effective_at DESC,id DESC
        LIMIT 1
      `, [context.scope.tenantId, context.scope.storeId])
      const row = result.rows[0]
      return row === undefined ? null : {
        version: row.policy_version,
        content: row.content_markdown,
        contentSha256: row.content_sha256,
        operatorName: row.operator_name,
        contact: row.contact,
        dataRetentionPolicyVersion: row.data_retention_policy_version,
        thirdPartyRegisterVersion: row.third_party_register_version,
        effectiveAt: timestamp(row.effective_at, '隐私政策生效时间'),
      }
    })
    reply.header('cache-control', 'no-store')
    return reply.send({ data: policy, meta: { published: policy !== null } })
  }))

  app.get('/staff/customer-publication/employees', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.public-profile.manage')
    return reply.send({ data: await options.service.listCustomerPublicationEmployees(context) })
  }))

  app.get('/staff/customer-publication/profiles', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'customer.public-profile.manage', 'customer.public-profile.publish',
    ])
    return reply.send({ data: await options.service.listCustomerPublicProfiles(context) })
  }))

  app.put<{ Params: { employeeId: string } }>(
    '/staff/customer-publication/profiles/:employeeId/draft',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'customer.public-profile.manage')
      const body = objectBody(request.body)
      const result = await options.service.draftCustomerPublicProfile(context, {
        employeeId: uuid(request.params.employeeId, '员工'),
        publicDisplayName: text(body.publicDisplayName, '顾客公开服务名', 1, 80),
        reason: text(body.reason, '草拟说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { profileId: string } }>(
    '/staff/customer-publication/profiles/:profileId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'customer.public-profile.publish')
      const body = objectBody(request.body)
      const result = await options.service.publishCustomerPublicProfile(context, {
        profileId: uuid(request.params.profileId, '顾客公开服务名'),
        approvalReference: text(body.approvalReference, '门店或人事确认编号', 8, 240),
        effectiveAt: timestamp(body.effectiveAt, '生效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { profileId: string } }>(
    '/staff/customer-publication/profiles/:profileId/withdraw',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'customer.public-profile.publish')
      const body = objectBody(request.body)
      const result = await options.service.withdrawCustomerPublicProfile(context, {
        profileId: uuid(request.params.profileId, '顾客公开服务名'),
        reason: text(body.reason, '撤下原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/staff/customer-publication/privacy-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'privacy.policy.view', 'privacy.policy.manage', 'privacy.policy.publish',
    ])
    return reply.send({ data: await options.service.listPrivacyPolicyReleases(context) })
  }))

  app.post('/staff/customer-publication/privacy-policies/drafts', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'privacy.policy.manage')
    const body = objectBody(request.body)
    const result = await options.service.draftPrivacyPolicy(context, {
      policyVersion: privacyPolicyVersion(body.policyVersion),
      content: text(body.content, '隐私政策正文', 80, 50_000),
      contentSha256: sha256(body.contentSha256, '隐私政策内容摘要'),
      operatorName: text(body.operatorName, '运营主体', 2, 200),
      contact: text(body.contact, '联系渠道', 2, 500),
      dataRetentionPolicyVersion: text(body.dataRetentionPolicyVersion, '数据保留规则版本', 2, 80),
      thirdPartyRegisterVersion: text(body.thirdPartyRegisterVersion, '第三方服务清单版本', 2, 80),
      reason: text(body.reason, '草拟说明', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyVersion: string } }>(
    '/staff/customer-publication/privacy-policies/:policyVersion/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'privacy.policy.publish')
      const body = objectBody(request.body)
      const result = await options.service.publishPrivacyPolicy(context, {
        policyVersion: privacyPolicyVersion(request.params.policyVersion),
        approvedBy: text(body.approvedBy, '法务或运营批准人', 2, 200),
        approvalReference: text(body.approvalReference, '批准材料编号', 8, 240),
        effectiveAt: timestamp(body.effectiveAt, '生效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { policyVersion: string } }>(
    '/staff/customer-publication/privacy-policies/:policyVersion/withdraw',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'privacy.policy.publish')
      const body = objectBody(request.body)
      const result = await options.service.withdrawPrivacyPolicy(context, {
        policyVersion: privacyPolicyVersion(request.params.policyVersion),
        reason: text(body.reason, '撤下原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/public/mini/loyalty', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.loyalty(context) })
  }))

  app.get('/public/mini/loyalty/ledger', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const loyalty = await options.service.loyalty(context)
    return reply.send({
      data: {
        points: loyalty.points,
        growth: loyalty.growth,
        processing: loyalty.processing,
      },
    })
  }))

  app.get('/public/mini/notification-consent', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.notificationConsent(
      context, options.notificationConsentPolicy ?? null,
    ) })
  }))

  app.post('/public/mini/notification-consent', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.recordNotificationConsent(
      context,
      options.notificationConsentPolicy ?? null,
      {
        expectedVersion: integer(body.expectedVersion, '授权版本', 0, 2_000_000_000),
        authorizationContext: enumValue(
          body.authorizationContext, '授权场景',
          ['loyalty_accrual', 'reservation', 'activity', 'service'] as const,
        ),
        platformResult: enumValue(
          body.platformResult, '微信授权结果', ['accept', 'reject', 'ban', 'revoke'] as const,
        ),
        platformEventReference: text(body.platformEventReference, '授权请求编号', 8, 160),
        idempotencyKey: idempotencyKey(request),
      },
    )
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/public/mini/product-restrictions', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.productRestrictions(context) })
  }))

  app.post<{ Params: { publicId: string } }>(
    '/public/mini/product-restrictions/:publicId/withdraw',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolvePublicContext(request)
      const body = objectBody(request.body)
      const result = await options.service.withdrawProductRestriction(context, {
        publicId: publicId(request.params.publicId),
        reason: text(body.reason ?? '顾客本人撤回长期商品限制', '撤回原因', 2, 240),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/public/mini/redemptions/catalog', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.redemptionCatalog(context) })
  }))

  app.get('/public/mini/redemptions', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.redemptions(context) })
  }))

  app.post('/public/mini/redemptions', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const guest = await Promise.resolve(options.resolveGuestContext(request)).catch(() => null)
    const tableAuthority=await trustedGuestTableAuthority(options,context,guest)
    const body = objectBody(request.body)
    const result = await options.service.createRedemption(context, {
      catalogItemPublicId: publicId(text(body.catalogItemPublicId, '兑换项', 8, 128)),
      tableAuthority,
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { redemptionPublicId: string } }>(
    '/public/mini/redemptions/:redemptionPublicId/cancel',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolvePublicContext(request)
      const body = objectBody(request.body)
      const result = await options.service.cancelRedemption(context, {
        publicId: publicId(request.params.redemptionPublicId),
        reason: text(body.reason ?? '顾客在交付前取消兑换', '取消原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/staff/loyalty/redemption-configuration', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'loyalty.policy.view',
      'loyalty.redemption.catalog.manage',
      'loyalty.redemption.catalog.approve',
      'loyalty.redemption.catalog.publish',
      'loyalty.redemption.control',
    ])
    return reply.send({ data: await options.service.redemptionConfiguration(context) })
  }))

  app.get('/staff/loyalty/redemptions/pending', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'loyalty.redemption.fulfill', 'loyalty.redemption.exception',
    ])
    return reply.send({ data: await options.service.pendingRedemptions(context) })
  }))

  app.post('/staff/loyalty/redemption-catalogs', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.redemption.catalog.manage')
    const body = objectBody(request.body)
    if (!Array.isArray(body.items)) throw new CustomerExperienceRequestError('兑换目录明细格式不正确')
    const items = body.items.map((value, index) => {
      const item = object(value, `第${index + 1}个兑换项`)
      return {
        publicId: publicIdValue(item.publicId, '兑换项公开编号'),
        itemCode: redemptionItemCode(item.itemCode),
        name: text(item.name, '兑换项名称', 2, 120),
        fulfillmentKind: enumValue(item.fulfillmentKind, '履约类型', ['product', 'benefit', 'activity', 'service'] as const),
        productId: optionalUuid(item.productId, '商品'),
        benefitDefinitionId: optionalUuid(item.benefitDefinitionId, '权益定义'),
        activityId: optionalUuid(item.activityId, '活动'),
        pointsRequired: integer(item.pointsRequired, '所需积分', 1, 2_000_000_000),
        costAmountMinor: integer(item.costAmountMinor, '成本金额', 0, Number.MAX_SAFE_INTEGER),
        currency: currency(item.currency ?? 'CNY'),
        totalInventory: item.totalInventory === undefined || item.totalInventory === null
          ? null : integer(item.totalInventory, '总库存', 0, 2_000_000_000),
        dailyInventory: item.dailyInventory === undefined || item.dailyInventory === null
          ? null : integer(item.dailyInventory, '每日库存', 0, 2_000_000_000),
        memberDailyLimit: integer(item.memberDailyLimit ?? 1, '会员每日上限', 1, 100),
        memberRolling30DayLimit: integer(item.memberRolling30DayLimit ?? 4, '会员30天上限', 1, 500),
        memberLifetimeLimit: item.memberLifetimeLimit === undefined || item.memberLifetimeLimit === null
          ? null : integer(item.memberLifetimeLimit, '会员总上限', 1, 2_000_000_000),
        minimumTier: enumValue(item.minimumTier ?? 'member', '最低等级', ['member', 'silver', 'gold'] as const),
        requiresTableSession: booleanValue(item.requiresTableSession ?? true, '是否需要桌次'),
        requiresEmployeeFulfillment: booleanValue(item.requiresEmployeeFulfillment ?? true, '是否需要员工交付'),
        cancellationAllowedBeforeFulfillment: booleanValue(
          item.cancellationAllowedBeforeFulfillment ?? true, '交付前是否可取消',
        ),
        restoreExpiredPointsDays: integer(item.restoreExpiredPointsDays ?? 7, '过期积分恢复天数', 0, 30),
        availableFrom: timestamp(item.availableFrom, '兑换开始时间'),
        availableUntil: item.availableUntil === undefined || item.availableUntil === null
          ? null : timestamp(item.availableUntil, '兑换结束时间'),
        fulfillmentTimeoutMinutes: integer(item.fulfillmentTimeoutMinutes ?? 240, '履约时限', 5, 10_080),
        display: object(item.display ?? {}, '兑换项展示内容'),
      }
    })
    const result = await options.service.draftRedemptionCatalog(context, {
      reason: text(body.reason, '配置原因', 2, 500),
      items,
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { catalogId: string } }>(
    '/staff/loyalty/redemption-catalogs/:catalogId/approve',
    async (request, reply) => handle(reply, async () => {
      await staffContextWithPermission(options, request, 'loyalty.redemption.catalog.approve')
      throw configurationApprovalMoved()
    }),
  )

  app.post<{ Params: { catalogId: string } }>(
    '/staff/loyalty/redemption-catalogs/:catalogId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.redemption.catalog.publish')
      const body = objectBody(request.body)
      const result = await options.service.publishRedemptionCatalog(context, {
        catalogId: uuid(request.params.catalogId, '兑换目录'),
        effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
        effectiveUntil: body.effectiveUntil === undefined || body.effectiveUntil === null
          ? null : timestamp(body.effectiveUntil, '失效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.put('/staff/loyalty/redemption-control', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.redemption.control')
    const body = objectBody(request.body)
    const result = await options.service.setRedemptionControl(context, {
      state: enumValue(body.state, '兑换状态', ['disabled', 'pilot', 'enabled', 'paused'] as const),
      pilotStartsAt: body.pilotStartsAt === undefined || body.pilotStartsAt === null
        ? null : timestamp(body.pilotStartsAt, '试点开始时间'),
      pilotEndsAt: body.pilotEndsAt === undefined || body.pilotEndsAt === null
        ? null : timestamp(body.pilotEndsAt, '试点结束时间'),
      reason: text(body.reason, '变更原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/public/mini/activities', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.activities(context) })
  }))

  app.get<{ Params: { activityPublicId: string } }>('/public/mini/activities/:activityPublicId', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.activity(context, publicId(request.params.activityPublicId)) })
  }))

  app.get('/public/mini/activity-registrations', async (request, reply) => handle(reply, async () => {
    reply.header('Cache-Control', 'private, no-store, max-age=0').header('Pragma', 'no-cache')
    const context = await options.resolvePublicContext(request)
    return reply.send({ data: await options.service.activityRegistrations(context) })
  }))

  app.get<{ Params: { registrationPublicId: string } }>(
    '/public/mini/activity-registrations/:registrationPublicId/payment',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolvePublicContext(request)
      if (options.activityPayments === undefined) throw new CustomerExperienceRequestError(
        '活动支付尚未启用', 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED', 503,
      )
      return reply.send({ data: await options.activityPayments.get(
        context,
        publicId(request.params.registrationPublicId),
      ) })
    }),
  )

  app.post<{ Params: { registrationPublicId: string } }>(
    '/public/mini/activity-registrations/:registrationPublicId/payment-action',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolvePublicContext(request)
      if (options.activityPayments === undefined) throw new CustomerExperienceRequestError(
        '活动支付尚未启用', 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED', 503,
      )
      const actionIdempotencyKey = idempotencyKey(request)
      return reply.send({ data: await options.activityPayments.createAction(context, {
        registrationPublicId: publicId(request.params.registrationPublicId),
        clientIp: request.ip,
        idempotencyKey: actionIdempotencyKey,
      }) })
    }),
  )

  app.post<{ Params: { registrationPublicId: string } }>(
    '/public/mini/activity-registrations/:registrationPublicId/payment-query',
    async (request, reply) => handle(reply, async () => {
      const context = await options.resolvePublicContext(request)
      if (options.activityPayments === undefined) throw new CustomerExperienceRequestError(
        '活动支付尚未启用', 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED', 503,
      )
      return reply.send({ data: await options.activityPayments.query(context, {
        registrationPublicId: publicId(request.params.registrationPublicId),
        idempotencyKey: idempotencyKey(request),
      }) })
    }),
  )

  app.post('/public/mini/membership/enroll', async (request, reply) => handle(reply, async () => {
    reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache')
    await options.resolvePublicContext(request)
    throw new CustomerExperienceRequestError(
      '请更新小程序后重新授权手机号加入会员',
      'MEMBERSHIP_ENROLLMENT_CLIENT_UPGRADE_REQUIRED',
      426,
    )
  }))

  app.post('/public/mini/membership/enroll-with-phone', async (request, reply) => handle(reply, async () => {
    reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache')
    const context = await options.resolvePublicContext(request)
    if (options.membershipEnrollment === undefined) throw new CustomerExperienceRequestError(
      '手机号入会尚未接通', 'MEMBERSHIP_ENROLLMENT_PHONE_NOT_CONFIGURED', 503,
    )
    const body = objectBody(request.body)
    const phoneAuthorization = readPhoneAuthorization(body)
    const result = await options.membershipEnrollment.enroll(context, {
      termsVersion: integer(body.termsVersion, '入会条款版本', 1, 2_000_000_000),
      acknowledgementSource: enumValue(
        body.acknowledgementSource, '入会确认入口', ['mini_menu','mini_profile','mini_community'] as const,
      ),
      phoneAuthorizationCode: phoneAuthorization.authorizationCode,
      ...(phoneAuthorization.provider ? { phoneAuthorizationProvider: phoneAuthorization.provider } : {}),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post('/public/mini/membership/recovery/start', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
      '历史会员找回尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
    )
    return reply.code(201).send({
      data: await options.membershipRecovery.start(context, { idempotencyKey: idempotencyKey(request) }),
    })
  }))

  app.post('/public/mini/membership/recovery/verify', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    if (options.membershipRecovery === undefined || options.recoveryPhoneAuthorization === undefined) {
      throw new CustomerExperienceRequestError(
        '微信手机号找回尚未接通', 'MEMBERSHIP_RECOVERY_PHONE_NOT_CONFIGURED', 503,
      )
    }
    const body = objectBody(request.body)
    const challengePublicId = publicIdValue(body.challengePublicId, '找回申请编号')
    const recoveryIdempotencyKey = idempotencyKey(request)
    const replay = await options.membershipRecovery.verifiedReplay(context, {
      challengePublicId,
      idempotencyKey: recoveryIdempotencyKey,
    })
    if (replay !== null) return reply.send({ data: replay, meta: { replayed: true } })
    const phoneAuthorization = readPhoneAuthorization(body)
    const verifiedPhone = await options.recoveryPhoneAuthorization.verify({
      ...phoneAuthorization,
      customerId: context.customerId,
    })
    return reply.send({
      data: await options.membershipRecovery.verify(context, {
        challengePublicId,
        verifiedPhone,
        idempotencyKey: recoveryIdempotencyKey,
      }),
    })
  }))

  app.get('/public/mini/membership/verified-phones', async (request, reply) => handle(reply, async () => {
    reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache')
    const context = await options.resolvePublicContext(request)
    if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
      '手机号管理尚未启用', 'VERIFIED_PHONE_NOT_CONFIGURED', 503,
    )
    return reply.send({ data: await options.membershipRecovery.listMyVerifiedPhones(context) })
  }))

  app.post('/public/mini/membership/verified-phones/replace', async (request, reply) => handle(reply, async () => {
    reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache')
    const context = await options.resolvePublicContext(request)
    if (options.membershipRecovery === undefined || options.recoveryPhoneAuthorization === undefined) {
      throw new CustomerExperienceRequestError(
        '微信手机号更换尚未接通', 'VERIFIED_PHONE_NOT_CONFIGURED', 503,
      )
    }
    const body = objectBody(request.body)
    const phoneAuthorization = readPhoneAuthorization(body)
    const verifiedPhone = await options.recoveryPhoneAuthorization.verify({
      ...phoneAuthorization,
      customerId: context.customerId,
    })
    return reply.send({ data: await options.membershipRecovery.replaceMyVerifiedPhone(context, {
      verifiedPhone,
      idempotencyKey: idempotencyKey(request),
    }) })
  }))

  app.post<{ Params: { contactPublicId: string } }>(
    '/public/mini/membership/verified-phones/:contactPublicId/revoke',
    async (request, reply) => handle(reply, async () => {
      reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache')
      const context = await options.resolvePublicContext(request)
      if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
        '手机号管理尚未启用', 'VERIFIED_PHONE_NOT_CONFIGURED', 503,
      )
      return reply.send({ data: await options.membershipRecovery.revokeMyVerifiedPhone(context, {
        contactPublicId: publicIdValue(request.params.contactPublicId, '手机号记录编号'),
        idempotencyKey: idempotencyKey(request),
      }) })
    }),
  )

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

  app.post<{ Params: { activityPublicId: string } }>('/public/mini/activities/:activityPublicId/registrations', async (request, reply) => handleActivityRegistration(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const result = await options.service.registerActivity(context, {
      activityPublicId: publicId(request.params.activityPublicId),
      activityPackagePublicId: body.activityPackagePublicId === undefined || body.activityPackagePublicId === null
        ? null : publicId(text(body.activityPackagePublicId, '套餐编号', 8, 128)),
      partySize: integer(body.partySize, '报名人数', 1, 20),
      protectedContact: await protectActivityRegistrationContact(
        miniActivityRegistrationPhone(body.contactSnapshot),
        options.protectContact,
      ),
      termsAcknowledged: booleanValue(body.termsAcknowledged, '条款确认'),
      acknowledgedSafetyPolicyVersion: text(body.acknowledgedSafetyPolicyVersion, '安全规则版本', 1, 64),
      acknowledgedRefundPolicyVersion: text(body.acknowledgedRefundPolicyVersion, '退款规则版本', 3, 64),
      paymentChoice: enumValue(body.paymentChoice ?? 'none', '付款选择', ['none', 'deposit', 'full'] as const),
      // Customer-facing activity collection is always WeChat JSAPI.  A native
      // QR returned to the same phone is neither usable nor a safe fallback.
      // The readiness bit is server-derived from the encrypted WeChat identity
      // and is checked before any seat, stock or registration write.
      paymentMethod: 'jsapi',
      jsapiReady: await options.resolveActivityPaymentReady?.(context.scope, context.customerId) ?? false,
      idempotencyKey: idempotencyKey(request),
    })
    const registration = result.value
    const payment = registration.paymentPublicId === null ? null : {
      paymentPublicId: registration.paymentPublicId,
      resolutionState: 'action_required' as const,
      amountDueMinor: registration.amountDueMinor,
      currency: registration.currency,
      expiresAt: registration.seatHoldExpiresAt,
      allowedActions: ['start_payment', 'cancel_registration'] as const,
    }
    return reply.code(result.replayed ? 200 : 201).send({
      data: { ...registration, payment },
      meta: { replayed: result.replayed },
    })
  }))

  app.post<{ Params: { registrationPublicId: string } }>('/public/mini/activity-registrations/:registrationPublicId/cancel', async (request, reply) => handle(reply, async () => {
    const context = await options.resolvePublicContext(request)
    const body = objectBody(request.body)
    const registrationPublicId = publicId(request.params.registrationPublicId)
    const cancellationIdempotencyKey = idempotencyKey(request)
    await options.activityPayments?.prepareCancellation(context, {
      registrationPublicId,
      idempotencyKey: cancellationIdempotencyKey,
    })
    const result = await options.service.cancelActivity(context, {
      registrationPublicId,
      reason: text(body.reason, '取消原因', 2, 240),
      idempotencyKey: cancellationIdempotencyKey,
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/guest/experience/recommendations/configuration', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const configuration = await options.service.recommendationInputConfiguration(context)
    reply.header('cache-control', 'private, no-store')
    return reply.send({ data: configuration })
  }))

  app.post('/guest/experience/recommendations', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const recommendationIntent = enumValue(
      body.recommendationIntent ?? 'guided', '推荐入口', ['initial', 'guided', 'shake'] as const,
    ) as RecommendationIntent
    const answers = recommendationAnswers(body, context, recommendationIntent)
    const result = await options.service.recommend(context, answers, idempotencyKey(request), recommendationIntent)
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { recommendationPublicId: string } }>('/guest/experience/recommendations/:recommendationPublicId/events', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const result = await options.service.recordRecommendationBehavior(context, {
      recommendationPublicId: publicId(request.params.recommendationPublicId),
      eventType: enumValue(body.eventType, '行为类型', ['exposed', 'viewed', 'selected', 'ignored', 'rejected'] as const),
      productId: body.productId === undefined || body.productId === null ? null : uuid(body.productId, '商品'),
      reasonCode: optionalText(body.reasonCode, '原因代码', 80),
      evidence: body.evidence === undefined ? {} : object(body.evidence, '行为证据'),
      idempotencyKey: idempotencyKey(request),
    })
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

  app.post<{ Params: { publicId: string } }>('/guest/checkout/upgrade-offers/:publicId/events', async (request, reply) => handle(reply, async () => {
    const context = await tableContext(options, request)
    const body = objectBody(request.body)
    const eventType = enumValue(body.eventType, '升级建议行为', ['viewed', 'declined'] as const)
    const result = await options.service.recordCheckoutUpgradeOfferEvent(context, {
      publicId: publicId(request.params.publicId),
      eventType,
      reasonCode: eventType === 'declined'
        ? enumValue(body.reasonCode ?? 'kept_original', '拒绝原因', ['kept_original', 'not_needed'] as const)
        : null,
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get<{ Params: { tableSessionId: string } }>('/staff/table-sessions/:tableSessionId/observations/recent', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'observation.record')
    const result = await options.service.recentObservations(context, {
      tableSessionId: uuid(request.params.tableSessionId, '桌次'),
      limit: 5,
    })
    return reply.send({ data: result })
  }))

  app.post<{ Params: { tableSessionId: string } }>('/staff/table-sessions/:tableSessionId/observations/parse', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'observation.record')
    const body = objectBody(request.body)
    const result = await options.service.parseObservation(context, {
      tableSessionId: uuid(request.params.tableSessionId, '桌次'),
      rawContent: text(body.rawContent, '观察原文', 1, 2000),
      inputKind: enumValue(body.inputKind ?? 'text', '输入方式', ['text', 'voice_transcript'] as const),
      needsImmediateAction: booleanValue(body.needsImmediateAction ?? false, '是否立即处理'),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string } }>('/staff/observations/:publicId/confirm', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'observation.confirm')
    const body = objectBody(request.body)
    const result = await options.service.confirmObservation(context, {
      publicId: publicId(request.params.publicId),
      events: observationEvents(body.events ?? body.corrections ?? []),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string; eventId: string } }>('/staff/observations/:publicId/events/:eventId/revise', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'observation.correct')
    const body = objectBody(request.body)
    const result = await options.service.reviseObservation(context, {
      publicId: publicId(request.params.publicId),
      previousEventId: uuid(request.params.eventId, '原观察事件'),
      reason: text(body.reason, '修正原因', 2, 500),
      replacement: observationEvent(body.replacement),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/staff/customer-experience/recommendation-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'recommendation.rule.view')
    return reply.send({ data: await options.service.recommendationPolicyConfiguration(context) })
  }))

  app.post('/staff/customer-experience/recommendation-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'recommendation.rule.draft')
    const body = objectBody(request.body)
    const result = await options.service.createRecommendationPolicy(context, {
      code: ruleCode(text(body.code, '策略代码', 3, 64)),
      preferenceWeight: integer(body.preferenceWeight, '偏好权重', -1000, 1000, 100, true),
      sceneWeight: integer(body.sceneWeight, '场景权重', -1000, 1000, 60, true),
      marginWeight: integer(body.marginWeight, '毛利权重', -1000, 1000, 50, true),
      priorityWeight: integer(body.priorityWeight, '优先级权重', -1000, 1000, 50, true),
      performanceWeight: integer(body.performanceWeight, '演出权重', -1000, 1000, 0, true),
      inventoryWeight: integer(body.inventoryWeight, '库存权重', -1000, 1000, 0, true),
      capacityWeight: integer(body.capacityWeight, '产能权重', -1000, 1000, 0, true),
      minimumGrossMarginBasisPoints: integer(body.minimumGrossMarginBasisPoints, '最低毛利基点', 0, 9999, 0),
      preferenceHalfLifeDays: integer(body.preferenceHalfLifeDays, '偏好衰减半衰期', 7, 730, 90),
      preferenceMaxAgeDays: integer(body.preferenceMaxAgeDays, '偏好最长有效期', 30, 3650, 730),
      preferenceMinEffectiveScore: integer(body.preferenceMinEffectiveScore, '偏好最低有效分', 1, 10000, 1000),
      preferenceMinConfidenceBasisPoints: integer(
        body.preferenceMinConfidenceBasisPoints, '偏好最低置信度', 0, 10000, 2500,
      ),
      explanationTemplate: text(body.explanationTemplate ?? '按人数、场景、偏好和当前可售状态推荐', '推荐解释', 2, 500),
      displayConfiguration: body.displayConfiguration === undefined ? {} : object(body.displayConfiguration, '展示配置'),
      draftReason: text(body.draftReason, '起草原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string } }>('/staff/customer-experience/recommendation-policies/:publicId/approve', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'recommendation.rule.approve')
    const body = objectBody(request.body)
    const result = await options.service.approveRecommendationPolicy(context, {
      publicId: publicId(request.params.publicId),
      reason: text(body.reason, '审批依据', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string } }>('/staff/customer-experience/recommendation-policies/:publicId/publish', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'recommendation.rule.publish')
    const body = objectBody(request.body)
    const result = await options.service.publishRecommendationPolicy(context, {
      publicId: publicId(request.params.publicId),
      effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
      reason: text(body.reason, '发布依据', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { publicId: string } }>('/staff/customer-experience/recommendation-policies/:publicId/clone-draft', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'recommendation.rule.draft')
    const body = objectBody(request.body)
    const result = await options.service.cloneRecommendationPolicyDraft(context, {
      sourcePublicId: publicId(request.params.publicId),
      draftReason: text(body.reason, '复制原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/staff/customer-experience/performance-phases/current', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'song.view', 'song.manage', 'performance.phase.manage',
    ])
    return reply.send({ data: await options.service.performancePhases(context) })
  }))

  app.get<{ Params: { productId: string } }>(
    '/staff/customer-experience/products/:productId/performance-phases',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'recommendation.phase.configure')
      return reply.send({
        data: await options.service.productPerformancePhases(
          context,
          uuid(request.params.productId, '商品'),
        ),
      })
    }),
  )

  app.put<{ Params: { productId: string } }>(
    '/staff/customer-experience/products/:productId/performance-phases',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'recommendation.phase.configure')
      const body = objectBody(request.body)
      const result = await options.service.configureProductPerformancePhases(context, {
        productId: uuid(request.params.productId, '商品'),
        phaseCodes: stringList(body.phaseCodes, '适用演出阶段', PERFORMANCE_PHASES),
        reason: text(body.reason, '配置原因', 2, 240),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { scheduleId: string } }>(
    '/staff/customer-experience/schedules/:scheduleId/performance-phases',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'performance.phase.manage')
      const body = objectBody(request.body)
      const result = await options.service.startPerformancePhase(context, {
        scheduleId: uuid(request.params.scheduleId, '演出场次'),
        phaseCode: enumValue(body.phaseCode, '现场演出阶段', PERFORMANCE_PHASES),
        reason: text(body.reason, '启动原因', 2, 240),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  for (const action of ['end', 'cancel'] as const) {
    app.post<{ Params: { publicId: string } }>(
      `/staff/customer-experience/performance-phases/:publicId/${action}`,
      async (request, reply) => handle(reply, async () => {
        const context = await staffContextWithPermission(options, request, 'performance.phase.manage')
        const body = objectBody(request.body)
        const result = await options.service.transitionPerformancePhase(context, {
          publicId: publicId(request.params.publicId),
          action,
          reason: text(body.reason, action === 'end' ? '结束原因' : '取消原因', 2, 240),
          idempotencyKey: idempotencyKey(request),
        })
        return reply.send({ data: result.value, meta: { replayed: result.replayed } })
      }),
    )
  }

  app.get('/staff/customer-experience/dashboard', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.view')
    return reply.send({ data: await options.service.dashboard(context) })
  }))

  app.get('/staff/customer-experience/support-contact', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.feature.manage')
    return reply.send({ data: await options.service.supportContact(context) })
  }))

  app.put('/staff/customer-experience/support-contact', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.experience.feature.manage')
    const body = objectBody(request.body)
    const result = await options.service.setFeature(context, {
      featureCode: 'customer.support.contact',
      rolloutState: enumValue(body.rolloutState, '启用状态', ['disabled', 'pilot', 'enabled'] as const),
      configuration: object(body.configuration, '门店联系配置'),
      reason: text(body.reason, '修改原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.put<{ Params: { featureCode: string } }>('/staff/customer-experience/features/:featureCode', async (request, reply) => handle(reply, async () => {
    const code = featureCode(request.params.featureCode)
    const context = await staffContextWithPermission(
      options,
      request,
      code === 'recommendation.engine' ? 'recommendation.rule.publish' : 'customer.experience.feature.manage',
    )
    const body = objectBody(request.body)
    const result = await options.service.setFeature(context, {
      featureCode: code,
      rolloutState: enumValue(body.rolloutState, '启用状态', ['disabled', 'shadow', 'pilot', 'enabled'] as const),
      configuration: object(body.configuration, '配置'),
      reason: text(body.reason, '修改原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.put<{ Params: { ruleCode: string } }>('/staff/customer-experience/checkout-upgrade-rules/:ruleCode', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.draft')
    const body = objectBody(request.body)
    if (body.configuration !== undefined) throw new CustomerExperienceRequestError(
      '升级规则不接受自由配置对象，请使用明确字段',
      'CHECKOUT_UPGRADE_FREE_CONFIGURATION_REJECTED',
    )
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
      minimumGrossMarginBasisPoints: integer(
        body.minimumGrossMarginBasisPoints,
        '最低毛利基点', 0, 9_999,
      ),
      status: enumValue(body.status ?? 'draft', '规则状态', ['draft', 'paused', 'retired'] as const),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { ruleCode: string } }>('/staff/customer-experience/checkout-upgrade-rules/:ruleCode/approve', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.approve')
    const body = objectBody(request.body)
    const result = await options.service.approveCheckoutUpgradeRule(context, {
      code: ruleCode(request.params.ruleCode),
      reason: text(body.reason, '审批原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/staff/customer-experience/checkout-upgrade-rules', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.view')
    return reply.send({ data: await options.service.checkoutUpgradeRules(context) })
  }))

  app.get('/staff/customer-experience/checkout-upgrade-outcomes', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.view')
    return reply.send({ data: await options.service.checkoutUpgradeOutcomes(context) })
  }))

  app.post<{ Params: { ruleId: string } }>('/staff/customer-experience/checkout-upgrade-rule-versions/:ruleId/publish', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.publish')
    const body = objectBody(request.body)
    const result = await options.service.publishCheckoutUpgradeRule(context, {
      ruleId: uuid(request.params.ruleId, '升级规则版本'),
      reason: text(body.reason, '发布原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { ruleId: string } }>('/staff/customer-experience/checkout-upgrade-rule-versions/:ruleId/rollback-draft', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'checkout.upgrade.rule.publish')
    const body = objectBody(request.body)
    const result = await options.service.rollbackCheckoutUpgradeRule(context, {
      ruleId: uuid(request.params.ruleId, '历史升级规则版本'),
      reason: text(body.reason, '回滚原因', 2, 240),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed?200:201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.get('/staff/customer-experience/fulfillment-capacity-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'fulfillment.capacity.view')
    return reply.send({ data: await options.service.fulfillmentCapacityPolicies(context) })
  }))

  app.post('/staff/customer-experience/fulfillment-capacity-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'fulfillment.capacity.draft')
    const body = objectBody(request.body)
    const result = await options.service.draftFulfillmentCapacity(context, {
      stationCode: enumValue(body.stationCode, '出品站点', ['bar','kitchen','cashier'] as const),
      reason: text(body.reason, '配置原因', 2, 240),
      windows: capacityWindows(body.windows),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed?200:201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  for (const action of ['approve','publish'] as const) {
    app.post<{ Params: { policyId: string } }>(`/staff/customer-experience/fulfillment-capacity-policies/:policyId/${action}`, async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, `fulfillment.capacity.${action}`)
      const body = objectBody(request.body)
      const result = await options.service.transitionFulfillmentCapacity(context, {
        policyId: uuid(request.params.policyId, '产能版本'),action,
        reason: text(body.reason, action==='approve'?'审批原因':'发布原因', 2, 240),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }))
  }

  app.post<{ Params: { registrationPublicId: string } }>(
    '/staff/community-activity-registrations/:registrationPublicId/refunds',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'refund.request')
      if (options.activityPayments === undefined) throw new CustomerExperienceRequestError(
        '活动支付尚未启用', 'ACTIVITY_PAYMENT_AUTHORITY_NOT_CONFIGURED', 503,
      )
      const body = objectBody(request.body)
      const result = await options.activityPayments.requestRefund(context, {
        registrationPublicId: publicId(request.params.registrationPublicId),
        paymentPublicId: optionalText(body.paymentPublicId, '付款编号', 128),
        reason: text(body.reason, '退款原因', 2, 1000),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { customerId: string } }>('/staff/customers/:customerId/points', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.adjust.manual')
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

  app.get('/staff/loyalty/accounts', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.account.view')
    const query = objectBody(request.query)
    const memberNo = text(query.memberNo, '会员号', 3, 64)
    const account = await options.transactions.run(context.scope, async (transaction) => {
      const accountResult = await transaction.query<StaffMemberAccountRow>(`
        SELECT membership.id AS membership_id,membership.member_no,
          membership.status AS membership_status,account.current_tier,
          account.available_points,account.pending_recovery_points,
          account.growth_value AS lifetime_growth,
          COALESCE(rolling.qualification_growth,0)::bigint AS qualification_growth,
          period.qualification_growth AS tier_qualification_growth,
          period.ends_at::text AS tier_period_ends_at,account.updated_at::text
        FROM mbox.customer_memberships membership
        JOIN mbox.loyalty_accounts account
          ON account.tenant_id=membership.tenant_id AND account.store_id=membership.store_id
         AND account.membership_id=membership.id
        LEFT JOIN LATERAL (
          SELECT SUM(ledger.growth_delta)::bigint AS qualification_growth
          FROM mbox.loyalty_growth_ledger ledger
          JOIN LATERAL (
            SELECT policy.evaluation_window_months
            FROM mbox.loyalty_tier_policy_versions policy
            WHERE policy.tenant_id=membership.tenant_id AND policy.store_id=membership.store_id
              AND policy.status='published' AND policy.effective_from<=clock_timestamp()
              AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
            ORDER BY policy.effective_from DESC,policy.version DESC LIMIT 1
          ) policy ON true
          WHERE ledger.tenant_id=membership.tenant_id AND ledger.store_id=membership.store_id
            AND ledger.membership_id=membership.id
            AND ledger.occurred_at>=clock_timestamp()-make_interval(months=>policy.evaluation_window_months)
        ) rolling ON true
        LEFT JOIN LATERAL (
          SELECT tier_period.qualification_growth,tier_period.ends_at
          FROM mbox.membership_tier_periods tier_period
          WHERE tier_period.tenant_id=membership.tenant_id AND tier_period.store_id=membership.store_id
            AND tier_period.membership_id=membership.id AND tier_period.status IN ('active','grace')
          ORDER BY tier_period.starts_at DESC,tier_period.id DESC LIMIT 1
        ) period ON true
        WHERE membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
          AND membership.member_no=$3
        LIMIT 1
      `, [context.scope.tenantId, context.scope.storeId, memberNo])
      const row = accountResult.rows[0]
      if (row === undefined) {
        throw new CustomerExperienceRequestError('未找到该会员账户', 'MEMBER_ACCOUNT_NOT_FOUND', 404)
      }
      // The transaction owns one pg client; execute ledger reads in order instead of relying on
      // node-postgres's deprecated concurrent-query queue.
      const pointEntries = await transaction.query<StaffMemberLedgerRow>(`
          SELECT entry_type,points_delta AS delta,balance_after,reason,occurred_at::text
          FROM mbox.loyalty_point_ledger
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
          ORDER BY occurred_at DESC,id DESC LIMIT 20
        `, [context.scope.tenantId, context.scope.storeId, row.membership_id])
      const growthEntries = await transaction.query<StaffMemberLedgerRow>(`
          SELECT entry_type,growth_delta AS delta,balance_after,reason,occurred_at::text
          FROM mbox.loyalty_growth_ledger
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND membership_id=$3::uuid
          ORDER BY occurred_at DESC,id DESC LIMIT 20
        `, [context.scope.tenantId, context.scope.storeId, row.membership_id])
      return {
        memberNo: row.member_no,
        membershipStatus: row.membership_status,
        tier: row.current_tier,
        availablePoints: nonNegativeSafeNumber(row.available_points, '可用积分'),
        pendingRecoveryPoints: nonNegativeSafeNumber(row.pending_recovery_points, '待追回积分'),
        lifetimeGrowth: nonNegativeSafeNumber(row.lifetime_growth, '累计成长值'),
        qualificationGrowth: nonNegativeSafeNumber(row.qualification_growth, '资格成长值'),
        tierQualificationGrowth: row.tier_qualification_growth === null
          ? null : nonNegativeSafeNumber(row.tier_qualification_growth, '等级周期资格快照'),
        tierPeriodEndsAt: row.tier_period_ends_at,
        updatedAt: row.updated_at,
        pointEntries: pointEntries.rows.map(staffLedgerEntry),
        growthEntries: growthEntries.rows.map(staffLedgerEntry),
      }
    }, { readOnly: true })
    return reply.send({ data: account })
  }))

  app.post<{ Params: { redemptionPublicId: string } }>(
    '/staff/loyalty/redemptions/:redemptionPublicId/fulfill',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.redemption.fulfill')
      const body = objectBody(request.body)
      const result = await options.service.fulfillRedemption(context, {
        publicId: publicId(request.params.redemptionPublicId),
        reason: text(body.reason ?? '员工确认已实际交付', '交付说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { redemptionPublicId: string } }>(
    '/staff/loyalty/redemptions/:redemptionPublicId/fail',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.redemption.exception')
      const body = objectBody(request.body)
      const result = await options.service.failRedemption(context, {
        publicId: publicId(request.params.redemptionPublicId),
        failureCode: enumValue(body.failureCode, '失败类型', [
          'product_unavailable','benefit_unavailable','activity_unavailable',
          'service_unavailable','fulfillment_rejected','fulfillment_timeout','technical_failure',
        ] as const),
        reason: text(body.reason, '失败说明', 2, 500),
        confirmedUnfulfilled: booleanValue(body.confirmedUnfulfilled, '确认尚未履约'),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/staff/loyalty/policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'loyalty.policy.view','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish',
    ])
    return reply.send({ data: await options.service.listLoyaltyPolicies(context) })
  }))

  app.post('/staff/loyalty/policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.policy.manage')
    const body = objectBody(request.body)
    const result = await options.service.draftLoyaltyPolicy(context, {
      policyCode: enumValue(body.policyCode ?? 'BASE', '规则代码', ['BASE'] as const),
      pointsNumerator: integer(body.pointsNumerator, '积分比例分子', 0, 1_000_000),
      pointsDenominatorMinor: integer(body.pointsDenominatorMinor, '积分比例分母', 1, 1_000_000),
      growthNumerator: integer(body.growthNumerator, '成长值比例分子', 0, 1_000_000),
      growthDenominatorMinor: integer(body.growthDenominatorMinor, '成长值比例分母', 1, 1_000_000),
      roundingMode: enumValue(body.roundingMode ?? 'floor', '取整方式', ['floor', 'nearest'] as const),
      pointsValidityMonths: integer(body.pointsValidityMonths, '积分有效月数', 1, 120),
      reason: text(body.reason, '配置原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyId: string } }>('/staff/loyalty/policies/:policyId/publish', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.policy.publish')
    const body = objectBody(request.body)
    const result = await options.service.publishLoyaltyPolicy(context, {
      policyId: uuid(request.params.policyId, '会员规则'),
      effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
      effectiveUntil: body.effectiveUntil === undefined || body.effectiveUntil === null
        ? null : timestamp(body.effectiveUntil, '失效时间'),
      reason: text(body.reason, '发布说明', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyId: string } }>('/staff/loyalty/policies/:policyId/approve', async (request, reply) => handle(reply, async () => {
    await staffContextWithPermission(options, request, 'loyalty.policy.approve')
    throw configurationApprovalMoved()
  }))

  app.get('/staff/loyalty/tier-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'loyalty.policy.view','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish',
    ])
    return reply.send({ data: await options.service.listLoyaltyTierPolicies(context) })
  }))

  app.post('/staff/loyalty/tier-policies', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.policy.manage')
    const body = objectBody(request.body)
    const result = await options.service.draftLoyaltyTierPolicy(context, {
      evaluationWindowMonths: integer(body.evaluationWindowMonths, '评估窗口月数', 1, 36),
      tierPeriodMonths: integer(body.tierPeriodMonths, '等级周期月数', 1, 36),
      downgradeGraceDays: integer(body.downgradeGraceDays, '降级宽限天数', 0, 180),
      silverUpgradeGrowth: integer(body.silverUpgradeGrowth, '银卡升级成长值', 1, 2_000_000_000),
      silverRetainGrowth: integer(body.silverRetainGrowth, '银卡保级成长值', 0, 2_000_000_000),
      goldUpgradeGrowth: integer(body.goldUpgradeGrowth, '金卡升级成长值', 1, 2_000_000_000),
      goldRetainGrowth: integer(body.goldRetainGrowth, '金卡保级成长值', 0, 2_000_000_000),
      silverPointsMultiplierNumerator: integer(body.silverPointsMultiplierNumerator, '银卡倍率分子', 1, 1_000_000),
      silverPointsMultiplierDenominator: integer(body.silverPointsMultiplierDenominator, '银卡倍率分母', 1, 1_000_000),
      goldPointsMultiplierNumerator: integer(body.goldPointsMultiplierNumerator, '金卡倍率分子', 1, 1_000_000),
      goldPointsMultiplierDenominator: integer(body.goldPointsMultiplierDenominator, '金卡倍率分母', 1, 1_000_000),
      reason: text(body.reason, '配置原因', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/tier-policies/:policyId/approve',
    async (request, reply) => handle(reply, async () => {
      await staffContextWithPermission(options, request, 'loyalty.policy.approve')
      throw configurationApprovalMoved()
    }),
  )

  app.post<{ Params: { policyId: string } }>(
    '/staff/loyalty/tier-policies/:policyId/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.policy.publish')
      const body = objectBody(request.body)
      const result = await options.service.publishLoyaltyTierPolicy(context, {
        policyId: uuid(request.params.policyId, '等级规则'),
        effectiveFrom: timestamp(body.effectiveFrom, '生效时间'),
        effectiveUntil: body.effectiveUntil === undefined || body.effectiveUntil === null
          ? null : timestamp(body.effectiveUntil, '失效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.get('/staff/loyalty/reconciliation', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.accrual.exception.view')
    return reply.send({ data: await options.service.loyaltyReconciliation(context) })
  }))

  app.get('/staff/loyalty/supplement-requests', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'loyalty.accrual.exception.view')
    return reply.send({ data: await options.service.loyaltySupplementRequests(context) })
  }))

  app.post<{ Params: { orderPublicId: string } }>(
    '/staff/loyalty/accrual-exceptions/:orderPublicId/requests',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.accrual.request')
      const body = objectBody(request.body)
      const result = await options.service.requestLoyaltySupplement(context, {
        orderPublicId: publicId(request.params.orderPublicId),
        reason: text(body.reason, '申请原因', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/loyalty/supplement-requests/:publicId/approve',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.accrual.approve')
      const body = objectBody(request.body)
      const result = await options.service.decideLoyaltySupplement(context, {
        publicId: publicId(request.params.publicId),
        decision: 'approve',
        reason: text(body.reason, '复核说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post<{ Params: { publicId: string } }>(
    '/staff/loyalty/supplement-requests/:publicId/reject',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'loyalty.accrual.approve')
      const body = objectBody(request.body)
      const result = await options.service.decideLoyaltySupplement(context, {
        publicId: publicId(request.params.publicId),
        decision: 'reject',
        reason: text(body.reason, '驳回说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )

  app.post('/staff/customer-followups', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'customer.relationship.manage')
    const body = objectBody(request.body)
    const result = await options.service.createFollowup(context, {
      customerId: uuid(body.customerId, '客户'),
      ownerEmployeeId: uuid(body.ownerEmployeeId, '负责人'),
      sourceType: enumValue(body.sourceType, '来源', ['reservation', 'visit', 'complaint', 'activity', 'dormancy', 'manual'] as const),
      sourceId: optionalText(body.sourceId, '来源编号', 128),
      priority: enumValue(body.priority, '优先级', ['low', 'normal', 'high', 'urgent'] as const),
      action: text(body.action, '跟进动作', 2, 600),
      channel: enumValue(body.channel, '跟进渠道', ['in_person', 'wecom', 'service_account', 'phone'] as const),
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

  app.post('/staff/membership-recovery/verified-contacts', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(
      options, request, 'customer.membership.recovery.verify',
    )
    if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
      '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
    )
    const body = objectBody(request.body)
    return reply.code(201).send({ data: await options.membershipRecovery.recordStaffVerifiedContact(context, {
      memberNo: text(body.memberNo, '会员号', 8, 64),
      e164Phone: text(body.phone, '已人工核验手机号', 8, 24),
      reason: text(body.reason, '核验说明', 2, 500),
      idempotencyKey: idempotencyKey(request),
    }) })
  }))

  app.get('/staff/membership-recovery/cases', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithAnyPermission(options, request, [
      'customer.membership.recovery.verify', 'customer.membership.merge.approve',
    ])
    if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
      '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
    )
    return reply.send({ data: await options.membershipRecovery.reviewQueue(context) })
  }))

  app.get<{ Params: { casePublicId: string } }>(
    '/staff/membership-recovery/cases/:casePublicId/candidates',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(
        options, request, 'customer.membership.recovery.verify',
      )
      if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
        '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
      )
      return reply.send({ data: await options.membershipRecovery.candidates(
        context, publicId(request.params.casePublicId),
      ) })
    }),
  )

  app.post<{ Params: { casePublicId: string } }>(
    '/staff/membership-recovery/cases/:casePublicId/select',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(
        options, request, 'customer.membership.recovery.verify',
      )
      if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
        '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
      )
      const body = objectBody(request.body)
      return reply.send({ data: await options.membershipRecovery.selectCandidate(context, {
        casePublicId: publicId(request.params.casePublicId),
        candidatePublicId: publicIdValue(body.candidatePublicId, '候选编号'),
        reason: text(body.reason, '候选核验说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      }) })
    }),
  )

  app.post<{ Params: { casePublicId: string } }>(
    '/staff/membership-recovery/cases/:casePublicId/approve',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(
        options, request, 'customer.membership.merge.approve',
      )
      if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
        '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
      )
      const body = objectBody(request.body)
      return reply.send({ data: await options.membershipRecovery.approve(context, {
        casePublicId: publicId(request.params.casePublicId),
        reason: text(body.reason, '复核说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      }) })
    }),
  )

  app.post<{ Params: { casePublicId: string } }>(
    '/staff/membership-recovery/cases/:casePublicId/reject',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(
        options, request, 'customer.membership.merge.approve',
      )
      if (options.membershipRecovery === undefined) throw new CustomerExperienceRequestError(
        '会员找回服务尚未启用', 'MEMBERSHIP_RECOVERY_NOT_CONFIGURED', 503,
      )
      const body = objectBody(request.body)
      return reply.send({ data: await options.membershipRecovery.reject(context, {
        casePublicId: publicId(request.params.casePublicId),
        reason: text(body.reason, '驳回说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      }) })
    }),
  )

  app.get('/staff/membership-terms', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'membership.terms.view')
    if (options.membershipTerms===undefined) throw new CustomerExperienceRequestError(
      '入会条款管理尚未启用', 'MEMBERSHIP_TERMS_NOT_CONFIGURED', 503,
    )
    return reply.send({ data: await options.membershipTerms.list(context) })
  }))

  app.post('/staff/membership-terms/drafts', async (request, reply) => handle(reply, async () => {
    const context = await staffContextWithPermission(options, request, 'membership.terms.manage')
    if (options.membershipTerms===undefined) throw new CustomerExperienceRequestError(
      '入会条款管理尚未启用', 'MEMBERSHIP_TERMS_NOT_CONFIGURED', 503,
    )
    const body = objectBody(request.body)
    const result = await options.membershipTerms.createDraft(context, {
      title: text(body.title, '条款标题', 2, 120),
      summary: text(body.summary, '条款摘要', 2, 500),
      content: text(body.content, '条款正文', 10, 12000),
      reason: text(body.reason, '起草说明', 2, 500),
      idempotencyKey: idempotencyKey(request),
    })
    return reply.code(result.replayed ? 200 : 201).send({ data: result.value, meta: { replayed: result.replayed } })
  }))

  app.post<{ Params: { version: string } }>(
    '/staff/membership-terms/:version/approve',
    async (request, reply) => handle(reply, async () => {
      await staffContextWithPermission(options, request, 'membership.terms.approve')
      throw configurationApprovalMoved()
    }),
  )

  app.post<{ Params: { version: string } }>(
    '/staff/membership-terms/:version/publish',
    async (request, reply) => handle(reply, async () => {
      const context = await staffContextWithPermission(options, request, 'membership.terms.publish')
      if (options.membershipTerms===undefined) throw new CustomerExperienceRequestError(
        '入会条款管理尚未启用', 'MEMBERSHIP_TERMS_NOT_CONFIGURED', 503,
      )
      const body = objectBody(request.body)
      const result = await options.membershipTerms.publish(context, {
        version: integer(Number(request.params.version), '条款版本', 1, 2_000_000_000),
        effectiveFrom: body.effectiveFrom===undefined || body.effectiveFrom===null
          ? null : timestamp(body.effectiveFrom, '生效时间'),
        reason: text(body.reason, '发布说明', 2, 500),
        idempotencyKey: idempotencyKey(request),
      })
      return reply.send({ data: result.value, meta: { replayed: result.replayed } })
    }),
  )
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

async function trustedGuestTableAuthority(
  options:CustomerExperienceApiOptions,
  context:PublicCustomerExperienceContext,
  guest:GuestExperienceContext|null,
): Promise<{ tableSessionId:string; customerId:string; actorRef:string }|null> {
  if (guest?.tableSessionId===null || guest===null
    || guest.scope.tenantId!==context.scope.tenantId || guest.scope.storeId!==context.scope.storeId) return null
  const sameFamily=await options.transactions.run(context.scope,async (transaction) => {
    const result=await transaction.query<{ same_family:boolean }>(`
      SELECT mbox.canonical_customer_id($1::uuid,$2::uuid,$3::uuid)
        =mbox.canonical_customer_id($1::uuid,$2::uuid,$4::uuid) AS same_family
    `,[context.scope.tenantId,context.scope.storeId,context.customerId,guest.customerId])
    return result.rows[0]?.same_family===true
  },{ readOnly:true })
  return sameFamily ? {
    tableSessionId:guest.tableSessionId,customerId:guest.customerId,actorRef:guest.actorRef,
  } : null
}

async function staffContextWithPermission(options: CustomerExperienceApiOptions, request: FastifyRequest, permission: string) {
  const context = await options.resolveStaffContext(request)
  await options.transactions.run(context.scope, (transaction) => (
    new StaffAccessRepository(transaction).assertPermission(context.employeeId, permission)
  ), { readOnly: true })
  return context
}

async function staffContextWithAnyPermission(
  options: CustomerExperienceApiOptions,
  request: FastifyRequest,
  permissions: readonly string[],
) {
  const context = await options.resolveStaffContext(request)
  for (const permission of permissions) {
    try {
      await options.transactions.run(context.scope, (transaction) => (
        new StaffAccessRepository(transaction).assertPermission(context.employeeId, permission)
      ), { readOnly: true })
      return context
    } catch (error) {
      if (!(error instanceof StaffAccessDeniedError)) throw error
    }
  }
  throw new StaffAccessDeniedError(permissions.join(' or '))
}

async function handle(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action() } catch (error) {
    const mapped = errorResponse(error)
    return reply.code(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message } })
  }
}

function errorResponse(error: unknown): { statusCode: number; code: string; message: string } {
  const known = knownErrorResponse(error)
  if (known !== null) return known
  console.error('CUSTOMER_EXPERIENCE_UNMAPPED_ERROR', error instanceof Error ? error.stack ?? error.message : error)
  return { statusCode: 500, code: 'CUSTOMER_EXPERIENCE_FAILED', message: '客户体验服务暂时没有接上' }
}

function knownErrorResponse(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (error instanceof CustomerExperienceRequestError) return { statusCode: error.statusCode, code: error.code, message: error.message }
  if (error instanceof ReservationGuestSessionInvalidError || error instanceof GuestAuthenticationRequiredError
    || error instanceof NormalizedAuthenticationRequiredError || error instanceof StaffSessionNotFoundError) {
    return { statusCode: 401, code: 'AUTHENTICATION_REQUIRED', message: '登录状态已失效，请重新进入' }
  }
  if (error instanceof StaffAccessDeniedError) return { statusCode: 403, code: 'PERMISSION_DENIED', message: '当前岗位没有这项权限' }
  if (error instanceof EmployeeTableAccessDeniedError) return {
    statusCode: 403, code: 'TABLE_ACCESS_DENIED', message: '当前员工不是该桌负责人，无权处理该桌会员权益',
  }
  if (error instanceof ActivityPaymentLateSuccessRefundRequiredError) return {
    statusCode: 409,
    code: 'ACTIVITY_LATE_PAYMENT_REFUND_REQUIRED',
    message: '旧报名付款已到账且退款未完成，请先完成原款退款后再收款',
  }
  if (error instanceof RefundLimitError) return {
    statusCode: 409, code: 'ACTIVITY_REFUND_LIMIT_CONFLICT', message: '退款余额或状态已变化，请刷新后重试',
  }
  if (error instanceof RefundTransitionError || error instanceof RefundApprovalRequiredError) return {
    statusCode: 409, code: 'ACTIVITY_REFUND_TRANSITION_CONFLICT', message: '退款状态已变化，请刷新后再处理',
  }
  if (error instanceof GuestDeviceBindingError || error instanceof GuestStoreScopeError
    || error instanceof NormalizedStoreUnavailableError || error instanceof TrustedStoreScopeError) {
    return { statusCode: 403, code: 'SCOPE_DENIED', message: '当前门店或设备身份不匹配' }
  }
  return null
}

async function handleActivityRegistration(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action() } catch (error) {
    const mapped = activityRegistrationErrorResponse(error)
    if (mapped.code === 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED') {
      console.error('ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED', safeActivityRegistrationFailure(error))
    }
    return reply.code(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message } })
  }
}

function activityRegistrationErrorResponse(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof IdempotencyConflictError) {
    return { statusCode: 409, code: 'ACTIVITY_REGISTRATION_IDEMPOTENCY_CONFLICT', message: '本次报名内容与之前的请求不一致，请刷新后重新报名' }
  }
  if (error instanceof IdempotencyInProgressError) {
    return { statusCode: 425, code: 'ACTIVITY_REGISTRATION_IN_PROGRESS', message: '报名正在确认中，请稍后在“我的活动”查看结果' }
  }
  if (error instanceof IdempotencyRecordError || error instanceof OutboxMessageConflictError) {
    return { statusCode: 503, code: 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED', message: '报名结果确认中，请稍后在“我的活动”查看' }
  }
  if (error instanceof CustomerExperienceRequestError
    && (error.code === 'ACTIVITY_CONTACT_PROTECTION_FAILED' || error.code === 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE')) {
    return { statusCode: 503, code: 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE', message: '报名服务配置异常，请稍后再试' }
  }
  return knownErrorResponse(error)
    ?? { statusCode: 503, code: 'ACTIVITY_REGISTRATION_RESULT_UNCONFIRMED', message: '报名结果确认中，请稍后在“我的活动”查看' }
}

function safeActivityRegistrationFailure(error: unknown) {
  // Registration carries protected contact data.  Do not let a future error
  // class smuggle message, code or name-derived content into an operational
  // log.  The public response already distinguishes retriable uncertainty;
  // this compact fixed taxonomy is enough for alerting without being a data
  // exfiltration path.
  if (error instanceof IdempotencyRecordError) return { kind: 'idempotency_record' as const }
  if (error instanceof OutboxMessageConflictError) return { kind: 'outbox_conflict' as const }
  return { kind: 'unexpected' as const }
}

function recommendationAnswers(
  body: JsonObject,
  context: Pick<TableExperienceContext, 'partySize' | 'recommendationScene'>,
  recommendationIntent: RecommendationIntent,
): RecommendationAnswer {
  const storedOccasion = context.recommendationScene || 'other'
  return {
    partySize: context.partySize,
    // The customer can actively choose a scene.  For an initial visit, an
    // optional staff open-table scene is a useful low-friction default; no
    // sensitive profile data is used and "不确定" remains neutral.
    occasion: recommendationIntent === 'initial' && context.recommendationScene
      ? storedOccasion
      : enumValue(body.occasion ?? storedOccasion, '聚会目的', OCCASIONS) as CustomerOccasion,
    // First exposure happens before the customer has answered anything. Keep
    // it neutral and server-owned; a guided request still requires the three
    // configured answers and re-ranks from the customer's explicit choices.
    alcoholPreference: enumValue(
      body.alcoholPreference ?? (recommendationIntent === 'initial' ? 'undecided' : undefined),
      '酒水偏好', ALCOHOL,
    ) as AlcoholPreference,
    experienceLevel: enumValue(
      body.experienceLevel ?? (recommendationIntent === 'initial' ? 'enhanced' : undefined),
      '体验档位', LEVELS,
    ) as ExperienceLevel,
    // 服务强度是门店执行节奏，不是顾客需要完成的第四道题。旧客户端仍可
    // 传入它；三题版没有传入时统一使用平衡服务，避免扩展 API 表面。
    serviceIntensity: enumValue(body.serviceIntensity ?? 'balanced', '服务方式', INTENSITIES) as ServiceIntensity,
  }
}

function publicPreferences(value: unknown): JsonObject {
  const source = object(value, '偏好')
  // Birthday month/day is purpose-bound personal data. It must only enter the
  // system through the atomic annual-benefit consent command above.
  const allowed = ['preferredAlcohol', 'tasteNotes', 'musicStyles', 'serviceIntensity', 'seatPreference', 'dietaryNotes']
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

function capacityWindows(value: unknown): Array<{
  startsAt: string
  endsAt: string
  capacityLimitUnits: number
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 96) {
    throw new CustomerExperienceRequestError('产能时间窗数量不正确')
  }
  const windows = value.map((entry) => {
    const source = object(entry, '产能时间窗')
    const startsAt = timestamp(source.startsAt, '时间窗开始时间')
    const endsAt = timestamp(source.endsAt, '时间窗结束时间')
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new CustomerExperienceRequestError('产能时间窗结束时间必须晚于开始时间')
    }
    return {
      startsAt,
      endsAt,
      capacityLimitUnits: integer(source.capacityLimitUnits, '产能上限', 1, 1_000_000),
    }
  }).toSorted((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
  for (let index = 1; index < windows.length; index += 1) {
    if (Date.parse(windows[index]!.startsAt) < Date.parse(windows[index - 1]!.endsAt)) {
      throw new CustomerExperienceRequestError('同一产能策略的时间窗不能重叠')
    }
  }
  return windows
}

function observationEvents(value: unknown): ObservationEventInput[] {
  if (!Array.isArray(value) || value.length > 20) throw new CustomerExperienceRequestError('观察事件数量不正确')
  return value.map(observationEvent)
}

function observationEvent(value: unknown): ObservationEventInput {
  const source = object(value, '观察事件')
  const preferenceEvidence = source.preferenceEvidence === undefined || source.preferenceEvidence === null
    ? undefined : preferenceEvidenceValue(source.preferenceEvidence)
  return {
    expressionKind: enumValue(source.expressionKind ?? 'staff_judgement', '表达来源', [
      'objective_fact', 'customer_quote', 'staff_judgement', 'system_inference',
    ] as const),
    scopeKind: enumValue(source.scopeKind ?? 'table', '作用范围', ['table', 'seat', 'customer', 'product'] as const),
    eventType: enumValue(source.eventType ?? 'other', '观察类型', [
      'remaining', 'consumed_little', 'praise', 'complaint', 'too_sweet', 'too_cold',
      'served_late', 'presentation', 'portion', 'other',
    ] as const),
    degree: source.degree === undefined || source.degree === null ? null
      : enumValue(source.degree, '程度', ['little', 'half', 'most', 'almost_untouched', 'unknown'] as const),
    reasonCode: optionalText(source.reasonCode, '原因代码', 80),
    seatLabel: optionalText(source.seatLabel, '座位', 40),
    customerId: optionalUuid(source.customerId, '客户'),
    candidateId: optionalUuid(source.candidateId, '商品候选'),
    productId: optionalUuid(source.productId, '商品'),
    confidence: decimal(source.confidence, '置信度', 0, 1, 0.5),
    rawExcerpt: text(source.rawExcerpt, '原文片段', 1, 1000),
    ...(preferenceEvidence === undefined ? {} : { preferenceEvidence }),
  }
}

function preferenceEvidenceValue(value: unknown): NonNullable<ObservationEventInput['preferenceEvidence']> {
  const source = object(value, '偏好证据')
  const key = text(source.key, '偏好代码', 2, 64)
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(key)) throw new CustomerExperienceRequestError('偏好代码不正确')
  return {
    key,
    value: text(source.value, '偏好内容', 1, 200),
    polarity: enumValue(source.polarity, '证据方向', ['supports', 'contradicts'] as const),
    weight: integer(source.weight, '证据权重', 1, 100),
    validUntil: source.validUntil === undefined || source.validUntil === null
      ? null : timestamp(source.validUntil, '证据有效期'),
    allowedForRecommendation: booleanValue(source.allowedForRecommendation ?? false, '是否用于推荐'),
  }
}

function objectBody(value: unknown): JsonObject { return object(value, '请求内容') }
function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CustomerExperienceRequestError(`${label}格式不正确`)
  return value as JsonObject
}

export function miniActivityRegistrationPhone(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CustomerExperienceRequestError('联系信息格式不正确', 'ACTIVITY_CONTACT_INVALID')
  }
  const snapshot = value as JsonObject
  const keys = Object.keys(snapshot).toSorted()
  const submittedFromRegistration = keys.length === 2
    && keys[0] === 'channel' && keys[1] === 'contact' && snapshot.channel === 'miniprogram'
  const submittedFromCorrection = keys.length === 2
    && keys[0] === 'contactType' && keys[1] === 'contactValue' && snapshot.contactType === 'phone'
  if (!submittedFromRegistration && !submittedFromCorrection) {
    throw new CustomerExperienceRequestError('联系信息格式不正确', 'ACTIVITY_CONTACT_INVALID')
  }
  // Do not delegate this to the generic text() validator: its generic error
  // code would turn an obvious phone-format correction into an opaque request
  // error for the mini-program.
  const rawContact = submittedFromRegistration ? snapshot.contact : snapshot.contactValue
  const contact = typeof rawContact === 'string' ? rawContact.trim() : ''
  if (!/^1\d{10}$/.test(contact)) {
    throw new CustomerExperienceRequestError('手机号格式不正确', 'ACTIVITY_CONTACT_INVALID')
  }
  return { channel: 'miniprogram', contact }
}

export async function protectActivityRegistrationContact(
  input: JsonObject,
  protectContact: (value: string) => Promise<ProtectedContact> | ProtectedContact,
): Promise<ProtectedActivityRegistrationContact> {
  const keys = Object.keys(input).toSorted()
  let contactType: 'phone' | 'wechat' | 'other'
  let contactValue: string
  if (keys.includes('contactType') || keys.includes('contactValue')) {
    if (keys.length !== 2 || keys[0] !== 'contactType' || keys[1] !== 'contactValue') {
      throw new CustomerExperienceRequestError('联系信息包含未支持字段', 'ACTIVITY_CONTACT_INVALID')
    }
    contactType = enumValue(input.contactType, '联系方式', ['phone', 'wechat', 'other'] as const)
    contactValue = text(input.contactValue, '联系信息', 3, 256)
    if (contactType === 'phone' && !/^1\d{10}$/.test(contactValue)) {
      throw new CustomerExperienceRequestError('手机号格式不正确', 'ACTIVITY_CONTACT_INVALID')
    }
  } else {
    if (keys.length !== 2 || keys[0] !== 'channel' || keys[1] !== 'contact'
      || input.channel !== 'miniprogram') {
      throw new CustomerExperienceRequestError('联系信息格式不正确', 'ACTIVITY_CONTACT_INVALID')
    }
    contactValue = text(input.contact, '联系信息', 3, 256)
    contactType = /^1\d{10}$/.test(contactValue) ? 'phone' : 'wechat'
    if (contactType === 'wechat' && !/^[A-Za-z][A-Za-z0-9_-]{2,19}$/.test(contactValue)) {
      throw new CustomerExperienceRequestError('微信号格式不正确', 'ACTIVITY_CONTACT_INVALID')
    }
  }
  let protectedContact: ProtectedContact
  try {
    protectedContact = await protectContact(contactValue)
  } catch (error) {
    console.error('ACTIVITY_CONTACT_PROTECTION_FAILED', { reason: 'provider_threw' })
    throw new CustomerExperienceRequestError(
      '报名服务配置异常', 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE', 503,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(protectedContact.hash)
    || protectedContact.encryptedBase64.length < 24 || protectedContact.encryptedBase64.length > 4096
    || protectedContact.keyId.trim().length < 3 || protectedContact.keyId.trim().length > 128
    || protectedContact.masked.trim().length < 3 || protectedContact.masked.trim().length > 64) {
    console.error('ACTIVITY_CONTACT_PROTECTION_FAILED', { reason: 'provider_output_invalid' })
    throw new CustomerExperienceRequestError(
      '报名服务配置异常', 'ACTIVITY_CONTACT_PROTECTION_UNAVAILABLE', 503,
    )
  }
  return {
    contactType,
    contactHash: protectedContact.hash,
    encryptedContact: protectedContact.encryptedBase64,
    encryptionKeyId: protectedContact.keyId,
    maskedContact: protectedContact.masked,
    source: 'mini_program',
  } satisfies ProtectedActivityRegistrationContact
}
function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new CustomerExperienceRequestError('缺少有效的幂等编号')
  return value
}
function configurationApprovalMoved() {
  return new CustomerExperienceRequestError(
    '该审批入口已停用，请先在会员经营配置中心生成服务端影响预览后审批',
    'MEMBERSHIP_CONFIGURATION_APPROVAL_MOVED', 409,
  )
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
function privacyPolicyVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(value)) {
    throw new CustomerExperienceRequestError('隐私政策版本格式不正确')
  }
  return value
}
function sha256(value: unknown, label: string): string {
  const result = text(value, label, 64, 64)
  if (!/^[0-9a-f]{64}$/.test(result)) throw new CustomerExperienceRequestError(`${label}不正确`)
  return result
}
function redemptionItemCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new CustomerExperienceRequestError('兑换项代码格式不正确')
  }
  return value
}
function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new CustomerExperienceRequestError('币种格式不正确')
  }
  return value
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CustomerExperienceRequestError(`${label}编号不正确`)
  return value
}
function optionalUuid(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === '' ? null : uuid(value, label)
}
function nonNegativeSafeNumber(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label}不是有效整数`)
  return parsed
}
function staffLedgerEntry(row: StaffMemberLedgerRow) {
  const delta = Number(row.delta)
  const balanceAfter = Number(row.balance_after)
  if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(balanceAfter) || balanceAfter < 0) {
    throw new Error('会员流水包含无效整数')
  }
  return {
    entryType: row.entry_type,
    delta,
    balanceAfter,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }
}
function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new CustomerExperienceRequestError(`${label}不正确`)
  return value.trim()
}
function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, label, 1, max)
}
function integer(value: unknown, label: string, min: number, max: number, fallback?: number, allowZero = false): number {
  const number = value === undefined && fallback !== undefined ? fallback : value
  if (!Number.isInteger(number) || (number as number) < min || (number as number) > max || (!allowZero && number === 0 && min < 0)) {
    throw new CustomerExperienceRequestError(`${label}不正确`)
  }
  return number as number
}
function decimal(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  const number = value === undefined && fallback !== undefined ? fallback : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
    throw new CustomerExperienceRequestError(`${label}不正确`)
  }
  return number
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CustomerExperienceRequestError(`${label}不正确`)
  return value
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new CustomerExperienceRequestError(`${label}不正确`)
  return new Date(value).toISOString()
}
function enumValue<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new CustomerExperienceRequestError(`${label}不正确`)
  return value as Values[number]
}
function optionalPhoneAuthorizationProvider(value: unknown): 'alipay' | 'wechat' | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return enumValue(value, '手机号授权平台', ['alipay', 'wechat'] as const)
}
function readPhoneAuthorization(body: Readonly<Record<string, unknown>>) {
  const authorizationCode = text(body.phoneAuthorizationCode, '手机号授权凭证', 8, 8192)
  const provider = optionalPhoneAuthorizationProvider(body.phoneAuthorizationProvider)
  return provider
    ? { authorizationCode, provider }
    : { authorizationCode }
}
function stringList<const Values extends readonly string[]>(value: unknown, label: string, values: Values): Values[number][] {
  if (!Array.isArray(value) || value.length > values.length) throw new CustomerExperienceRequestError(`${label}不正确`)
  const result = [...new Set(value.map((entry) => enumValue(entry, label, values)))]
  return result
}
