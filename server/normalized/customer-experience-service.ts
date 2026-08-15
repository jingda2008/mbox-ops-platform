import { createHash, randomUUID } from 'node:crypto'
import type {
  AuditActor,
  CommandExecution,
  JsonCodec,
  JsonObject,
  NormalizedCommandExecutor,
} from './command-executor.js'
import type { CustomerCommandService } from './customer-repository.js'
import {
  CustomerExperienceRepository,
  CustomerExperienceRequestError,
  type PublicPortalSnapshot,
  type RecommendationAnswer,
  type RecommendationResult,
  type TableExperienceContext,
  type ExperiencePlanView,
  type CheckoutBasketLine,
  type CheckoutUpgradeOfferView,
  type ActivityFeeBasis,
  type ActivityPaymentChoice,
  type ActivityPaymentMode,
} from './customer-experience-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'

type TransactionRunner = Pick<ScopedPostgresTransactionRunner, 'run'>

export interface PublicCustomerExperienceContext {
  scope: Readonly<StoreScope>
  customerId: string
  actorRef: string
  businessDate: string
}

export interface StaffCustomerExperienceContext {
  scope: Readonly<StoreScope>
  employeeId: string
  businessDate: string
}

export class CustomerExperienceService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly commands: Pick<NormalizedCommandExecutor, 'execute'>,
    private readonly customers: Pick<CustomerCommandService, 'updateProfile'>,
  ) {}

  portal(context: PublicCustomerExperienceContext): Promise<PublicPortalSnapshot> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).publicPortal(context.customerId)
    ), { readOnly: true })
  }

  activities(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).publicActivities(context.customerId)
    ), { readOnly: true })
  }

  enrollMembership(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ idempotencyKey: string }>,
  ): Promise<CommandExecution<{ membership: PublicPortalSnapshot['membership']; created: boolean }>> {
    const memberNo = memberNumber(context.customerId)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.membership.enroll',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ customerId: context.customerId, memberNo }),
      resultCodec: objectCodec<{ membership: PublicPortalSnapshot['membership']; created: boolean }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction)
        .enrollMembership(context.customerId, memberNo)
      return commandOutcome(
        result,
        guestActor(context),
        'membership.enrolled',
        'customer_membership',
        context.customerId,
        context.businessDate,
        { memberNo, created: result.created },
      )
    })
  }

  updatePreferences(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      displayName?: string | null
      preferences: JsonObject
      idempotencyKey: string
    }>,
  ) {
    return this.customers.updateProfile({
      scope: context.scope,
      actor: guestActor(context),
      businessDate: context.businessDate,
      customerId: context.customerId,
      profile: {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        preferences: input.preferences,
        publicPreferenceKeys: Object.keys(input.preferences),
      },
      reason: '客户在小程序中更新服务偏好',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        customerId: context.customerId,
        displayName: input.displayName ?? null,
        preferences: input.preferences,
      }),
    })
  }

  registerActivity(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      activityPublicId: string
      partySize: number
      contactSnapshot: JsonObject
      safetyAcknowledgement: JsonObject
      paymentChoice: ActivityPaymentChoice
      idempotencyKey: string
    }>,
  ) {
    const registrationPublicId = deterministicPublicId('activity-registration', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.register',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        customerId: context.customerId,
        activityPublicId: input.activityPublicId,
        partySize: input.partySize,
        contactSnapshot: input.contactSnapshot,
        safetyAcknowledgement: input.safetyAcknowledgement,
        paymentChoice: input.paymentChoice,
      }),
      resultCodec: objectCodec<{
        publicId: string
        status: string
        paymentRequired: boolean
        paymentChoice: ActivityPaymentChoice
        totalFeeAmountMinor: number
        amountDueMinor: number
        remainingAmountMinor: number
        paymentDueAt: string | null
        seatHoldExpiresAt: string | null
        currency: string
        paymentRuleText: string
      }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).registerActivity({
        activityPublicId: input.activityPublicId,
        customerId: context.customerId,
        partySize: input.partySize,
        contactSnapshot: input.contactSnapshot,
        safetyAcknowledgement: input.safetyAcknowledgement,
        paymentChoice: input.paymentChoice,
        publicId: registrationPublicId,
        idempotencyKey: input.idempotencyKey,
      })
      return commandOutcome(
        result,
        guestActor(context),
        'community.activity.registered',
        'community_activity_registration',
        registrationPublicId,
        context.businessDate,
        { activityPublicId: input.activityPublicId, status: result.status, partySize: input.partySize },
      )
    })
  }

  cancelActivity(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ registrationPublicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.registration.cancel',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        customerId: context.customerId,
        registrationPublicId: input.registrationPublicId,
        reason: input.reason,
      }),
      resultCodec: objectCodec<{ publicId: string; status: 'cancelled' }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).cancelActivityRegistration({
        registrationPublicId: input.registrationPublicId,
        customerId: context.customerId,
        reason: input.reason,
      })
      return commandOutcome(
        result,
        guestActor(context),
        'community.activity.registration.cancelled',
        'community_activity_registration',
        input.registrationPublicId,
        context.businessDate,
        { reason: input.reason },
      )
    })
  }

  recommend(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    answers: RecommendationAnswer,
    idempotencyKey: string,
  ): Promise<CommandExecution<RecommendationResult>> {
    const publicId = deterministicPublicId('recommendation', context.scope.storeId, idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.recommend',
      idempotencyKey,
      requestFingerprint: fingerprint({ context, answers }),
      resultCodec: objectCodec<RecommendationResult>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).createRecommendationSession({
        context,
        answers,
        publicId,
      })
      return commandOutcome(
        result,
        guestActor(context),
        'customer.experience.recommended',
        'recommendation_session',
        publicId,
        context.businessDate,
        {
          answers: {
            partySize: answers.partySize,
            occasion: answers.occasion,
            alcoholPreference: answers.alcoholPreference,
            experienceLevel: answers.experienceLevel,
            serviceIntensity: answers.serviceIntensity,
          },
          recommendationCount: result.recommendations.length,
        },
      )
    })
  }

  createPlan(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{
      recommendationPublicId: string
      selectedProductId: string
      promiseSummary: string
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<ExperiencePlanView>> {
    const publicId = deterministicPublicId('experience-plan', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.plan.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        context,
        recommendationPublicId: input.recommendationPublicId,
        selectedProductId: input.selectedProductId,
        promiseSummary: input.promiseSummary,
      }),
      resultCodec: objectCodec<ExperiencePlanView>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).createExperiencePlan({
        context,
        recommendationPublicId: input.recommendationPublicId,
        selectedProductId: input.selectedProductId,
        publicId,
        promiseSummary: input.promiseSummary,
      })
      return commandOutcome(
        result,
        guestActor(context),
        'customer.experience.plan.created',
        'customer_experience_plan',
        publicId,
        context.businessDate,
        {
          tableSessionId: context.tableSessionId,
          selectedProductId: input.selectedProductId,
          cueCount: result.cues.length,
        },
      )
    })
  }

  plan(context: TableExperienceContext & { scope: Readonly<StoreScope> }): Promise<ExperiencePlanView | null> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).findPlanByTable(context.tableSessionId)
    ), { readOnly: true })
  }

  prepareCheckoutUpgrade(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{
      items: readonly CheckoutBasketLine[]
      occasion?: RecommendationAnswer['occasion']
      alcoholPreference?: RecommendationAnswer['alcoholPreference']
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<CheckoutUpgradeOfferView | null>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.prepare',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        items: input.items,
        occasion: input.occasion ?? null,
        alcoholPreference: input.alcoholPreference ?? null,
      }),
      resultCodec: nullableObjectCodec<CheckoutUpgradeOfferView>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).prepareCheckoutUpgrade(context, input)
      return commandOutcome(
        result,
        guestActor(context),
        'customer.checkout.upgrade.prepared',
        'checkout_upgrade_offer',
        result?.publicId ?? context.tableSessionId,
        context.businessDate,
        { available: result !== null, publicId: result?.publicId ?? null },
      )
    })
  }

  selectCheckoutUpgrade(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{
      offerPublicId: string
      originalItems: readonly CheckoutBasketLine[]
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<{ offerId: string; upgradedItems: CheckoutBasketLine[] }>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.select',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        offerPublicId: input.offerPublicId,
        originalItems: input.originalItems,
      }),
      resultCodec: objectCodec<{ offerId: string; upgradedItems: CheckoutBasketLine[] }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction)
        .selectCheckoutUpgrade(context, input.offerPublicId, input.originalItems)
      return commandOutcome(
        result,
        guestActor(context),
        'customer.checkout.upgrade.selected',
        'checkout_upgrade_offer',
        input.offerPublicId,
        context.businessDate,
        { offerPublicId: input.offerPublicId, transformedLineCount: result.upgradedItems.length },
      )
    })
  }

  markCheckoutUpgradeConverted(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{ offerId: string; orderId: string; idempotencyKey: string }>,
  ): Promise<CommandExecution<{ converted: true }>> {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.convert',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ offerId: input.offerId, orderId: input.orderId }),
      resultCodec: objectCodec<{ converted: true }>(),
    }, async (transaction) => {
      await new CustomerExperienceRepository(transaction).markCheckoutUpgradeConverted(input.offerId, input.orderId)
      return commandOutcome(
        { converted: true },
        guestActor(context),
        'customer.checkout.upgrade.converted',
        'checkout_upgrade_offer',
        input.offerId,
        context.businessDate,
        { orderId: input.orderId },
      )
    })
  }

  dashboard(context: StaffCustomerExperienceContext): Promise<JsonObject> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).staffDashboard()
    ), { readOnly: true })
  }

  setFeature(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      featureCode: string
      rolloutState: 'disabled' | 'shadow' | 'pilot' | 'enabled'
      configuration: JsonObject
      reason: string
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.feature.set',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ featureCode: string; rolloutState: string }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ feature_code: string; rollout_state: string }>(`
        INSERT INTO mbox.customer_experience_features (
          tenant_id, store_id, feature_code, rollout_state, configuration,
          reason, approved_by_employee_id, effective_from
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid, clock_timestamp())
        ON CONFLICT (tenant_id, store_id, feature_code) DO UPDATE
        SET rollout_state = EXCLUDED.rollout_state,
          configuration = EXCLUDED.configuration,
          reason = EXCLUDED.reason,
          approved_by_employee_id = EXCLUDED.approved_by_employee_id,
          effective_from = clock_timestamp(), effective_until = NULL
        RETURNING feature_code, rollout_state
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.featureCode,
        input.rolloutState,
        JSON.stringify(input.configuration),
        input.reason,
        context.employeeId,
      ])
      const row = requiredRow(result.rows[0], 'customer experience feature')
      const value = { featureCode: row.feature_code, rolloutState: row.rollout_state }
      return commandOutcome(
        value,
        staffActor(context),
        'customer.experience.feature.set',
        'customer_experience_feature',
        input.featureCode,
        context.businessDate,
        { rolloutState: input.rolloutState, configuration: input.configuration, reason: input.reason },
      )
    })
  }

  upsertCheckoutUpgradeRule(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      code: string
      name: string
      sourceProductId: string
      targetProductId: string
      minimumPartySize: number
      maximumPartySize: number
      occasionTags: string[]
      alcoholPreferenceTags: string[]
      promptTitle: string
      promptBody: string
      callToAction: string
      priority: number
      offerValidMinutes: number
      status: 'draft' | 'active' | 'paused' | 'retired'
      configuration: JsonObject
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.rule.upsert',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ code: string; status: string }>(),
    }, async (transaction) => {
      const products = await transaction.query<{
        source_id: string
        target_id: string
        source_amount_minor: string | number | null
        target_amount_minor: string | number | null
        target_cost_amount_minor: string | number
        target_kind: string
        target_guest_visible: boolean
      }>(`
        SELECT source.id AS source_id, target.id AS target_id,
          source_price.amount_minor AS source_amount_minor,
          target_price.amount_minor AS target_amount_minor,
          target.cost_amount_minor AS target_cost_amount_minor,
          target.product_kind AS target_kind,
          target.guest_visible AS target_guest_visible
        FROM mbox.products AS source
        JOIN mbox.products AS target
          ON target.tenant_id = source.tenant_id AND target.store_id = source.store_id
         AND target.id = $4::uuid
        LEFT JOIN LATERAL (
          SELECT amount_minor FROM mbox.product_prices
          WHERE tenant_id = source.tenant_id AND store_id = source.store_id
            AND product_id = source.id AND price_type = 'standard'
            AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())
          ORDER BY valid_from DESC, id DESC LIMIT 1
        ) AS source_price ON true
        LEFT JOIN LATERAL (
          SELECT amount_minor FROM mbox.product_prices
          WHERE tenant_id = target.tenant_id AND store_id = target.store_id
            AND product_id = target.id AND price_type = 'standard'
            AND valid_from <= clock_timestamp() AND (valid_until IS NULL OR valid_until > clock_timestamp())
          ORDER BY valid_from DESC, id DESC LIMIT 1
        ) AS target_price ON true
        WHERE source.tenant_id = $1::uuid AND source.store_id = $2::uuid
          AND source.id = $3::uuid AND source.status = 'active' AND target.status = 'active'
        FOR KEY SHARE OF source, target
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.sourceProductId,
        input.targetProductId,
      ])
      const product = products.rows[0]
      if (!product) throw new CustomerExperienceRequestError('升级商品不存在或未启用', 'CHECKOUT_UPGRADE_PRODUCT_INVALID', 409)
      if (input.status === 'active') {
        const sourceAmount = product.source_amount_minor === null ? 0 : Number(product.source_amount_minor)
        const targetAmount = product.target_amount_minor === null ? 0 : Number(product.target_amount_minor)
        const targetCost = Number(product.target_cost_amount_minor)
        const minimumMargin = typeof input.configuration.minimumGrossMarginBasisPoints === 'number'
          ? input.configuration.minimumGrossMarginBasisPoints : 6_000
        const margin = targetAmount > 0 ? Math.floor((targetAmount - targetCost) * 10_000 / targetAmount) : -1
        if (product.target_kind !== 'bundle' || !product.target_guest_visible || targetAmount <= sourceAmount
          || !Number.isInteger(minimumMargin) || margin < minimumMargin) {
          throw new CustomerExperienceRequestError(
            '正式启用前必须确认目标为顾客可见套餐、价格高于原酒水且达到配置毛利底线',
            'CHECKOUT_UPGRADE_RULE_NOT_READY',
            409,
          )
        }
      }
      const result = await transaction.query<{ code: string; status: string }>(`
        INSERT INTO mbox.checkout_upgrade_rules (
          tenant_id, store_id, code, name, source_product_id, target_product_id,
          minimum_party_size, maximum_party_size, occasion_tags,
          alcohol_preference_tags, prompt_title, prompt_body, call_to_action,
          priority, offer_valid_minutes, status, approved_by_employee_id, configuration
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid,
          $7, $8, $9::text[], $10::text[], $11, $12, $13,
          $14, $15, $16, CASE WHEN $16 = 'active' THEN $17::uuid ELSE NULL END, $18::jsonb
        )
        ON CONFLICT (tenant_id, store_id, code) DO UPDATE
        SET name = EXCLUDED.name, source_product_id = EXCLUDED.source_product_id,
          target_product_id = EXCLUDED.target_product_id,
          minimum_party_size = EXCLUDED.minimum_party_size,
          maximum_party_size = EXCLUDED.maximum_party_size,
          occasion_tags = EXCLUDED.occasion_tags,
          alcohol_preference_tags = EXCLUDED.alcohol_preference_tags,
          prompt_title = EXCLUDED.prompt_title, prompt_body = EXCLUDED.prompt_body,
          call_to_action = EXCLUDED.call_to_action, priority = EXCLUDED.priority,
          offer_valid_minutes = EXCLUDED.offer_valid_minutes, status = EXCLUDED.status,
          approved_by_employee_id = EXCLUDED.approved_by_employee_id,
          configuration = EXCLUDED.configuration
        RETURNING code, status
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.code,
        input.name,
        input.sourceProductId,
        input.targetProductId,
        input.minimumPartySize,
        input.maximumPartySize,
        input.occasionTags,
        input.alcoholPreferenceTags,
        input.promptTitle,
        input.promptBody,
        input.callToAction,
        input.priority,
        input.offerValidMinutes,
        input.status,
        context.employeeId,
        JSON.stringify(input.configuration),
      ])
      const value = requiredRow(result.rows[0], 'checkout upgrade rule')
      return commandOutcome(
        value,
        staffActor(context),
        'customer.checkout.upgrade.rule.saved',
        'checkout_upgrade_rule',
        input.code,
        context.businessDate,
        { status: input.status, sourceProductId: input.sourceProductId, targetProductId: input.targetProductId },
      )
    })
  }

  createActivity(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      kind: string
      title: string
      summary: string
      coverUrl: string | null
      startsAt: string
      endsAt: string
      assemblyLocation: string
      capacity: number
      feeAmountMinor: number
      depositAmountMinor: number
      feeBasis: ActivityFeeBasis
      paymentMode: ActivityPaymentMode
      paymentDeadlineMinutes: number
      paymentRuleText: string
      refundPolicySnapshot: JsonObject
      pointsReward: number
      visibility: string
      audienceRule: JsonObject
      safetySnapshot: JsonObject
      salesCopy: JsonObject
      idempotencyKey: string
    }>,
  ) {
    validateActivityPaymentConfiguration(input)
    const publicId = deterministicPublicId('community-activity', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: 'draft' }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ public_id: string; status: 'draft' }>(`
        INSERT INTO mbox.community_activities (
          tenant_id, store_id, public_id, activity_kind, title, summary,
          cover_url, starts_at, ends_at, assembly_location, capacity,
          fee_amount_minor, deposit_amount_minor, fee_basis, registration_payment_mode,
          payment_deadline_minutes, payment_rule_text, refund_policy_snapshot,
          points_reward, visibility, audience_rule, safety_snapshot, sales_copy,
          status, created_by_employee_id
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz,
          $9::timestamptz, $10, $11, $12::bigint, $13::bigint, $14, $15,
          $16, $17, $18::jsonb, $19, $20, $21::jsonb, $22::jsonb,
          $23::jsonb, 'draft', $24::uuid
        ) RETURNING public_id, status
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        publicId,
        input.kind,
        input.title,
        input.summary,
        input.coverUrl,
        input.startsAt,
        input.endsAt,
        input.assemblyLocation,
        input.capacity,
        input.feeAmountMinor,
        input.depositAmountMinor,
        input.feeBasis,
        input.paymentMode,
        input.paymentDeadlineMinutes,
        input.paymentRuleText,
        JSON.stringify(input.refundPolicySnapshot),
        input.pointsReward,
        input.visibility,
        JSON.stringify(input.audienceRule),
        JSON.stringify(input.safetySnapshot),
        JSON.stringify(input.salesCopy),
        context.employeeId,
      ])
      const value = requiredRow(result.rows[0], 'community activity')
      const output = { publicId: value.public_id, status: value.status }
      return commandOutcome(
        output,
        staffActor(context),
        'community.activity.created',
        'community_activity',
        publicId,
        context.businessDate,
        { title: input.title, status: 'draft' },
      )
    })
  }

  publishActivity(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: 'published' }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ public_id: string; status: 'published' }>(`
        UPDATE mbox.community_activities
        SET status = 'published', approved_by_employee_id = $4::uuid,
          published_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND public_id = $3 AND status = 'draft'
          AND created_by_employee_id <> $4::uuid
          AND starts_at > clock_timestamp()
          AND safety_snapshot <> '{}'::jsonb
        RETURNING public_id, status
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.publicId,
        context.employeeId,
      ])
      const row = result.rows[0]
      if (!row) throw new CustomerExperienceRequestError(
        '活动必须由另一位授权人员审批，且安全信息和开始时间必须有效',
        'ACTIVITY_PUBLISH_DENIED',
        409,
      )
      const output = { publicId: row.public_id, status: row.status }
      return commandOutcome(
        output,
        staffActor(context),
        'community.activity.published',
        'community_activity',
        input.publicId,
        context.businessDate,
        { approvedByEmployeeId: context.employeeId },
      )
    })
  }

  adjustPoints(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      customerId: string
      pointsDelta: number
      reason: string
      sourceType: 'order' | 'activity' | 'benefit' | 'campaign' | 'service_recovery' | 'manual'
      sourceId: string
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.points.adjust',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ customerId: string; balance: number; delta: number }>(),
    }, async (transaction) => {
      const membership = await transaction.query<{
        id: string
        points_balance: number
        lifetime_points: number
      }>(`
        SELECT id, points_balance, lifetime_points
        FROM mbox.customer_memberships
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid
          AND customer_id = $3::uuid AND status = 'active'
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.customerId])
      const account = membership.rows[0]
      if (!account) throw new CustomerExperienceRequestError('客户尚未成为会员', 'MEMBERSHIP_REQUIRED', 409)
      const balance = account.points_balance + input.pointsDelta
      if (balance < 0) throw new CustomerExperienceRequestError('积分余额不足', 'POINTS_BALANCE_INSUFFICIENT', 409)
      await transaction.query(`
        UPDATE mbox.customer_memberships
        SET points_balance = $4,
          lifetime_points = lifetime_points + GREATEST($5, 0)
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      `, [transaction.scope.tenantId, transaction.scope.storeId, account.id, balance, input.pointsDelta])
      await transaction.query(`
        INSERT INTO mbox.loyalty_point_ledger (
          tenant_id, store_id, membership_id, customer_id, entry_type,
          points_delta, balance_after, source_type, source_id, reason,
          created_by_employee_id, idempotency_key
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'adjust',
          $5, $6, $7, $8, $9, $10::uuid, $11
        )
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        account.id,
        input.customerId,
        input.pointsDelta,
        balance,
        input.sourceType,
        input.sourceId,
        input.reason,
        context.employeeId,
        input.idempotencyKey,
      ])
      const output = { customerId: input.customerId, balance, delta: input.pointsDelta }
      return commandOutcome(
        output,
        staffActor(context),
        'loyalty.points.adjusted',
        'customer_membership',
        account.id,
        context.businessDate,
        { balance, delta: input.pointsDelta, reason: input.reason },
      )
    })
  }

  createFollowup(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      customerId: string
      ownerEmployeeId: string
      sourceType: string
      sourceId: string | null
      priority: string
      action: string
      channel: string
      dueAt: string
      idempotencyKey: string
    }>,
  ) {
    const publicId = deterministicPublicId('customer-followup', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.followup.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: 'open' }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ public_id: string; status: 'open' }>(`
        INSERT INTO mbox.customer_followup_tasks (
          tenant_id, store_id, public_id, customer_id, owner_employee_id,
          source_type, source_id, priority, recommended_action,
          recommended_channel, due_at, idempotency_key
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8,
          $9, $10, $11::timestamptz, $12
        ) RETURNING public_id, status
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        publicId,
        input.customerId,
        input.ownerEmployeeId,
        input.sourceType,
        input.sourceId,
        input.priority,
        input.action,
        input.channel,
        input.dueAt,
        input.idempotencyKey,
      ])
      const row = requiredRow(result.rows[0], 'customer followup')
      const output = { publicId: row.public_id, status: row.status }
      return commandOutcome(
        output,
        staffActor(context),
        'customer.followup.created',
        'customer_followup_task',
        publicId,
        context.businessDate,
        { ownerEmployeeId: input.ownerEmployeeId, action: input.action },
      )
    })
  }

  completeCue(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ cueId: string; note: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.cue.complete',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ cueId: string; status: 'completed' }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ id: string; service_task_id: string | null }>(`
        UPDATE mbox.experience_plan_cues
        SET status = 'completed', completed_by_employee_id = $4::uuid,
          completed_at = clock_timestamp(),
          action_payload = action_payload || jsonb_build_object('completionNote', $5)
        WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND status IN ('ready', 'dispatched')
        RETURNING id, service_task_id
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.cueId,
        context.employeeId,
        input.note,
      ])
      const row = result.rows[0]
      if (!row) throw new CustomerExperienceRequestError('这个体验节点已经处理或尚未到执行时间', 'EXPERIENCE_CUE_NOT_ACTIONABLE', 409)
      if (row.service_task_id !== null) {
        await new ServiceTaskRepository(transaction).complete({
          taskId: row.service_task_id,
          actor: { type: 'employee', employeeId: context.employeeId },
          note: input.note,
          eventIdempotencyKey: `${input.idempotencyKey}:task`,
        })
      }
      const output = { cueId: row.id, status: 'completed' as const }
      return commandOutcome(
        output,
        staffActor(context),
        'customer.experience.cue.completed',
        'experience_plan_cue',
        row.id,
        context.businessDate,
        { note: input.note },
      )
    })
  }
}

export async function resolveTableExperienceContext(
  transaction: ScopedTransaction,
  input: Readonly<{
    customerId: string
    tableSessionId: string
    businessDate: string
    actorRef: string
  }>,
): Promise<TableExperienceContext> {
  const result = await transaction.query<{ guest_count: number }>(`
    SELECT session.guest_count
    FROM mbox.table_sessions AS session
    JOIN mbox.table_session_customers AS customer
      ON customer.tenant_id = session.tenant_id
     AND customer.store_id = session.store_id
     AND customer.table_session_id = session.id
     AND customer.customer_id = $4::uuid
    WHERE session.tenant_id = $1::uuid AND session.store_id = $2::uuid
      AND session.id = $3::uuid AND session.status = 'open'
    FOR KEY SHARE OF session
  `, [transaction.scope.tenantId, transaction.scope.storeId, input.tableSessionId, input.customerId])
  const row = result.rows[0]
  if (!row) throw new CustomerExperienceRequestError('当前客户不属于这桌，请重新扫码', 'TABLE_CUSTOMER_MISMATCH', 403)
  return {
    customerId: input.customerId,
    tableSessionId: input.tableSessionId,
    businessDate: input.businessDate,
    actorRef: input.actorRef,
    partySize: row.guest_count,
  }
}

function commandOutcome<Result>(
  result: Result,
  actor: AuditActor,
  action: string,
  objectType: string,
  objectId: string,
  businessDate: string,
  afterData: JsonObject,
) {
  return {
    result,
    auditEvents: [{ actor, action, objectType, objectId, businessDate, afterData }],
    outboxMessages: [{
      businessEventKey: `${action}:${objectId}`,
      aggregateType: objectType,
      aggregateId: objectId,
      aggregateVersion: 1,
      eventType: `${action}.v1`,
      payload: afterData,
    }],
  }
}

function guestActor(context: { actorRef: string }): AuditActor {
  return { type: 'guest', ref: context.actorRef }
}

function staffActor(context: { employeeId: string }): AuditActor {
  return { type: 'employee', employeeId: context.employeeId }
}

function objectCodec<Value>(): JsonCodec<Value> {
  return {
    encode: (value) => value as unknown as JsonObject,
    decode: (value) => {
      if (!isObject(value)) throw new TypeError('Stored customer experience result is invalid')
      return value as unknown as Value
    },
  }
}

function nullableObjectCodec<Value>(): JsonCodec<Value | null> {
  return {
    encode: (value) => value === null ? null : value as unknown as JsonObject,
    decode: (value) => {
      if (value === null) return null
      if (!isObject(value)) throw new TypeError('Stored customer experience result is invalid')
      return value as unknown as Value
    },
  }
}

function memberNumber(customerId: string): string {
  return `MBX-${createHash('sha256').update(customerId).digest('hex').slice(0, 12).toUpperCase()}`
}

export function validateActivityPaymentConfiguration(input: Readonly<{
  feeAmountMinor: number
  depositAmountMinor: number
  paymentMode: ActivityPaymentMode
}>): void {
  if (input.depositAmountMinor > input.feeAmountMinor) {
    throw new CustomerExperienceRequestError('活动订金不能高于活动总费用', 'ACTIVITY_PAYMENT_CONFIGURATION_INVALID')
  }
  if (input.paymentMode === 'none' && input.depositAmountMinor !== 0) {
    throw new CustomerExperienceRequestError('无需预付的活动，订金必须为0', 'ACTIVITY_PAYMENT_CONFIGURATION_INVALID')
  }
  if ((input.paymentMode === 'deposit_optional' || input.paymentMode === 'deposit_required')
    && (input.depositAmountMinor <= 0 || input.feeAmountMinor <= 0)) {
    throw new CustomerExperienceRequestError('定金活动必须同时设置大于0的活动费用和订金', 'ACTIVITY_PAYMENT_CONFIGURATION_INVALID')
  }
  if (input.paymentMode === 'full_required' && (input.feeAmountMinor <= 0 || input.depositAmountMinor !== 0)) {
    throw new CustomerExperienceRequestError('全额预付活动必须设置活动费用，订金字段应为0', 'ACTIVITY_PAYMENT_CONFIGURATION_INVALID')
  }
}

function deterministicPublicId(kind: string, storeId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${kind}:${storeId}:${idempotencyKey}`).digest('hex').slice(0, 24)
  return `${kind}-${digest}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new Error(`${label} did not return a row`)
  return row
}

export function createCustomerExperienceId(): string {
  return randomUUID()
}
