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
  type ProtectedActivityRegistrationContact,
  type PublicPortalSnapshot,
  type RecommendationAnswer,
  type RecommendationResult,
  type TableExperienceContext,
  type ExperiencePlanView,
  type ExperiencePlanIntentView,
  type CheckoutBasketLine,
  type CheckoutUpgradeOfferView,
  type ActivityFeeBasis,
  type ActivityPaymentChoice,
  type ActivityPaymentMode,
  type CustomerProductRestrictionView,
  type PerformancePhaseCode,
  type PerformancePhaseEventView,
} from './customer-experience-repository.js'
import {
  CustomerExperienceObservationRepository,
  type ObservationDraftView,
  type ObservationEventInput,
  type ObservationHistoryView,
  type ObservationInputKind,
} from './customer-experience-observation-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import type { PaymentMethod } from './payment-repository.js'
import { LoyaltyAccrualRepository } from './loyalty-accrual-repository.js'
import { LoyaltyPositiveAccrualPausedError } from './loyalty-operational-control-repository.js'
import { CustomerNotificationConsentRepository } from './customer-notification-consent-repository.js'
import {
  LoyaltyRedemptionError,
  LoyaltyRedemptionRepository,
  type MemberRedemptionView,
  type RedemptionFailureCode,
} from './loyalty-redemption-repository.js'
import { CheckoutUpgradeManagementRepository } from './checkout-upgrade-management-repository.js'
import { lockBoundGuestTablePosition } from './guest-table-authority.js'
import { isPublicMediaAssetUrl } from './media-asset-url.js'

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
    private readonly activityPaymentProviderConfigured = false,
  ) {}

  portal(context: PublicCustomerExperienceContext): Promise<PublicPortalSnapshot> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction, this.activityPaymentProviderConfigured).publicPortal(context.customerId)
    ), { readOnly: true })
  }

  loyalty(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).publicLoyalty(context.customerId)
    ), { readOnly: true })
  }

  notificationConsent(
    context: PublicCustomerExperienceContext,
    policy: Readonly<{ serviceTemplateId: string; policyVersion: string }> | null,
  ) {
    return this.transactions.run(context.scope, async (transaction) => {
      const current = await new CustomerNotificationConsentRepository(transaction).current(
        context.customerId, 'wechat', 'transactional_service',
      )
      return {
        available: policy !== null,
        templateId: policy?.serviceTemplateId ?? null,
        policyVersion: policy?.policyVersion ?? null,
        decision: current?.decision ?? null,
        consentVersion: current?.consentVersion ?? 0,
        changedAt: current?.occurredAt ?? null,
      }
    }, { readOnly: true })
  }

  recordNotificationConsent(
    context: PublicCustomerExperienceContext,
    policy: Readonly<{ serviceTemplateId: string; policyVersion: string }> | null,
    input: Readonly<{
      expectedVersion: number
      authorizationContext: 'loyalty_accrual' | 'reservation' | 'activity' | 'service'
      platformResult: 'accept' | 'reject' | 'ban' | 'revoke'
      platformEventReference: string
      idempotencyKey: string
    }>,
  ) {
    if (policy === null) throw new CustomerExperienceRequestError(
      '微信服务通知模板尚未配置', 'WECHAT_NOTIFICATION_TEMPLATE_NOT_CONFIGURED', 503,
    )
    const decision = input.platformResult === 'accept' ? 'granted'
      : input.platformResult === 'revoke' ? 'revoked' : 'denied'
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.notification-consent.record',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, customerId: context.customerId, templateId: policy.serviceTemplateId }),
      resultCodec: objectCodec<{
        decision: 'granted' | 'denied' | 'revoked'; consentVersion: number; changedAt: string
      }>(),
    }, async (transaction) => {
      const consent = await new CustomerNotificationConsentRepository(transaction).record({
        customerId: context.customerId,
        channel: 'wechat',
        purpose: 'transactional_service',
        decision,
        expectedVersion: input.expectedVersion,
        policyVersion: policy.policyVersion,
        source: input.platformResult === 'revoke' ? 'customer_self_service' : 'wechat_authorization',
        sourceReference: input.authorizationContext,
        templateId: policy.serviceTemplateId,
        authorizationContext: input.authorizationContext,
        platformResult: input.platformResult === 'revoke' ? null : input.platformResult,
        platformEventReference: input.platformResult === 'revoke' ? null : input.platformEventReference,
        actorType: 'customer',
        actorRef: context.actorRef,
      })
      const output = {
        decision: consent.decision,
        consentVersion: consent.consentVersion,
        changedAt: consent.occurredAt,
      }
      return commandOutcome(
        output, guestActor(context), 'customer.notification-consent.recorded',
        'customer_notification_consent', consent.id, context.businessDate,
        { channel: 'wechat', purpose: 'transactional_service', decision,
          authorizationContext: input.authorizationContext, policyVersion: policy.policyVersion },
      )
    })
  }

  redemptionCatalog(context: PublicCustomerExperienceContext, now = new Date().toISOString()) {
    return this.transactions.run(context.scope, (transaction) => (
      new LoyaltyRedemptionRepository(transaction).catalog(context.customerId, context.businessDate, now)
    ), { readOnly: true })
  }

  redemptions(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new LoyaltyRedemptionRepository(transaction).listMine(context.customerId)
    ), { readOnly: true })
  }

  createRedemption(
    context: PublicCustomerExperienceContext,
    input: Readonly<{
      catalogItemPublicId: string
      tableAuthority: { tableSessionId:string; customerId:string; actorRef:string } | null
      idempotencyKey: string
    }>,
  ) {
    const now = new Date().toISOString()
    const request = { ...input, customerId: context.customerId }
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.redemption.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(request),
      resultCodec: objectCodec<MemberRedemptionView>(),
    }, async (transaction) => {
      const result = await new LoyaltyRedemptionRepository(transaction).create({
        customerId: context.customerId,
        catalogItemPublicId: input.catalogItemPublicId,
        tableSessionId: input.tableAuthority?.tableSessionId ?? null,
        businessDate: context.businessDate,
        now,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint(request),
        actorRef: input.tableAuthority?.actorRef,
      })
      return commandOutcome(
        result, guestActor(context), 'loyalty.redemption.created', 'member_redemption',
        result.publicId, context.businessDate,
        { publicId: result.publicId, catalogItemPublicId: result.catalogItemPublicId,
          pointsUsed: result.pointsUsed, status: result.status },
      )
    }).catch(mapRedemptionError)
  }

  cancelRedemption(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.redemption.cancel',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, customerId: context.customerId }),
      resultCodec: objectCodec<MemberRedemptionView>(),
    }, async (transaction) => {
      const result = await new LoyaltyRedemptionRepository(transaction).cancel({
        customerId: context.customerId,
        publicId: input.publicId,
        now: new Date().toISOString(),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      return commandOutcome(
        result, guestActor(context), 'loyalty.redemption.cancelled', 'member_redemption',
        result.publicId, context.businessDate,
        { publicId: result.publicId, pointsRestored: result.pointsUsed, status: result.status, reason: input.reason },
      )
    }).catch(mapRedemptionError)
  }

  fulfillRedemption(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.redemption.fulfill',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<MemberRedemptionView>(),
    }, async (transaction) => {
      const result = await new LoyaltyRedemptionRepository(transaction).fulfill({
        publicId: input.publicId,
        employeeId: context.employeeId,
        now: new Date().toISOString(),
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      return commandOutcome(
        result, staffActor(context), 'loyalty.redemption.fulfilled', 'member_redemption',
        result.publicId, context.businessDate,
        { publicId: result.publicId, status: result.status, reason: input.reason },
      )
    }).catch(mapRedemptionError)
  }

  failRedemption(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      publicId: string
      failureCode: Exclude<RedemptionFailureCode, 'customer_cancelled'>
      reason: string
      confirmedUnfulfilled: boolean
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.redemption.fail',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<MemberRedemptionView>(),
    }, async (transaction) => {
      const result = await new LoyaltyRedemptionRepository(transaction).fail({
        ...input,
        employeeId: context.employeeId,
        now: new Date().toISOString(),
      })
      return commandOutcome(
        result,staffActor(context),'loyalty.redemption.failed','member_redemption',
        result.publicId,context.businessDate,
        { publicId: result.publicId,status: result.status,failureCode: input.failureCode,
          pointsRestored: result.pointsRestored,reason: input.reason },
      )
    }).catch(mapRedemptionError)
  }

  listLoyaltyPolicies(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<{
        id: string
        policy_code: string
        version: number
        status: string
        points_numerator: number
        points_denominator_minor: number
        growth_numerator: number
        growth_denominator_minor: number
        rounding_mode: string
        points_validity_months: number
        effective_from: string | null
        effective_until: string | null
        drafted_by_employee_id: string
        approved_by_employee_id: string | null
        approved_at: string | null
        published_by_employee_id: string | null
        published_at: string | null
        publication_mode: string
        reason: string
      }>(`
        SELECT id, policy_code, version, status, points_numerator,
          points_denominator_minor, growth_numerator, growth_denominator_minor,
          rounding_mode, points_validity_months, effective_from::text,
          effective_until::text, drafted_by_employee_id, approved_by_employee_id,
          approved_at::text, published_by_employee_id, published_at::text,
          publication_mode, reason
        FROM mbox.loyalty_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        ORDER BY policy_code, version DESC, id DESC
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows.map((row) => ({
        id: row.id,
        policyCode: row.policy_code,
        version: row.version,
        status: row.status,
        pointsNumerator: row.points_numerator,
        pointsDenominatorMinor: row.points_denominator_minor,
        growthNumerator: row.growth_numerator,
        growthDenominatorMinor: row.growth_denominator_minor,
        roundingMode: row.rounding_mode,
        pointsValidityMonths: row.points_validity_months,
        effectiveFrom: row.effective_from,
        effectiveUntil: row.effective_until,
        draftedByEmployeeId: row.drafted_by_employee_id,
        approvedByEmployeeId: row.approved_by_employee_id,
        approvedAt: row.approved_at,
        publishedByEmployeeId: row.published_by_employee_id,
        publishedAt: row.published_at,
        publicationMode: row.publication_mode,
        reason: row.reason,
      }))
    }, { readOnly: true })
  }

  draftLoyaltyPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      policyCode: string
      pointsNumerator: number
      pointsDenominatorMinor: number
      growthNumerator: number
      growthDenominatorMinor: number
      roundingMode: 'floor' | 'nearest'
      pointsValidityMonths: number
      reason: string
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.policy.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; policyCode: string; version: number; status: string }>(),
    }, async (transaction) => {
      await transaction.query(`
        SELECT id FROM mbox.stores
        WHERE tenant_id=$1::uuid AND id=$2::uuid
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      const result = await transaction.query<{
        id: string
        policy_code: string
        version: number
        status: string
      }>(`
        WITH next_version AS (
          SELECT COALESCE(MAX(version), 0) + 1 AS version
          FROM mbox.loyalty_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3
        )
        INSERT INTO mbox.loyalty_policy_versions (
          tenant_id, store_id, policy_code, version, status,
          points_numerator, points_denominator_minor,
          growth_numerator, growth_denominator_minor,
          rounding_mode, points_validity_months, drafted_by_employee_id, reason
        ) SELECT $1::uuid,$2::uuid,$3,version,'draft',$4,$5,$6,$7,$8,$9,$10::uuid,$11
        FROM next_version
        RETURNING id, policy_code, version, status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.policyCode,
        input.pointsNumerator, input.pointsDenominatorMinor,
        input.growthNumerator, input.growthDenominatorMinor,
        input.roundingMode, input.pointsValidityMonths, context.employeeId, input.reason,
      ])
      const row = result.rows[0]
      if (!row) throw new CustomerExperienceRequestError('会员规则草稿没有保存', 'LOYALTY_POLICY_DRAFT_FAILED', 409)
      const output = { id: row.id, policyCode: row.policy_code, version: row.version, status: row.status }
      return commandOutcome(
        output,
        staffActor(context),
        'loyalty.policy.drafted',
        'loyalty_policy_version',
        row.id,
        context.businessDate,
        { policyCode: row.policy_code, version: row.version, reason: input.reason },
      )
    })
  }

  approveLoyaltyPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ policyId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.policy.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; policyCode: string; version: number; status: string }>(),
    }, async (transaction) => {
      const updated = await transaction.query<{
        id: string; policy_code: string; version: number; status: string
      }>(`
        UPDATE mbox.loyalty_policy_versions
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND drafted_by_employee_id<>$4::uuid
        RETURNING id,policy_code,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId, context.employeeId, input.reason])
      const row = updated.rows[0]
      if (!row) throw new CustomerExperienceRequestError(
        '只有他人起草且尚未审批的会员规则可以审批', 'LOYALTY_POLICY_APPROVAL_DENIED', 409,
      )
      const output = { id: row.id, policyCode: row.policy_code, version: row.version, status: row.status }
      return commandOutcome(output, staffActor(context), 'loyalty.policy.approved',
        'loyalty_policy_version', row.id, context.businessDate,
        { policyCode: row.policy_code, version: row.version, reason: input.reason })
    })
  }

  publishLoyaltyPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      policyId: string
      effectiveFrom: string
      effectiveUntil: string | null
      reason: string
      idempotencyKey: string
    }>,
  ) {
    assertReleaseWindow(input.effectiveFrom, input.effectiveUntil)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.policy.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; policyCode: string; version: number; status: string }>(),
    }, async (transaction) => {
      const selected = await transaction.query<{
        id: string
        policy_code: string
        version: number
        drafted_by_employee_id: string
        approved_by_employee_id: string
        status: string
      }>(`
        SELECT id,policy_code,version,drafted_by_employee_id,approved_by_employee_id,status
        FROM mbox.loyalty_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId])
      const policy = selected.rows[0]
      if (!policy || policy.status !== 'approved') throw new CustomerExperienceRequestError(
        '只有已经独立审批的会员规则可以发布', 'LOYALTY_POLICY_NOT_APPROVED', 409,
      )
      if (policy.drafted_by_employee_id === context.employeeId
        || policy.approved_by_employee_id === context.employeeId) throw new CustomerExperienceRequestError(
        '规则起草人和审批人不能执行正式发布', 'LOYALTY_POLICY_PUBLISHER_NOT_INDEPENDENT', 409,
      )
      const previous = (await transaction.query<{ id: string; effective_from: string; effective_until: string | null }>(`
        SELECT id,effective_from::text,effective_until::text
        FROM mbox.loyalty_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND policy_code=$3
          AND status='published' ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, policy.policy_code])).rows[0]
      assertAppendOnlyRelease(previous, input.effectiveFrom, '会员规则')
      await transaction.query('SET CONSTRAINTS mbox.loyalty_policy_versions_no_published_overlap_excl DEFERRED')
      const updated = await transaction.query<{
        id: string
        policy_code: string
        version: number
        status: string
      }>(`
        UPDATE mbox.loyalty_policy_versions
        SET status='published', effective_from=$4::timestamptz,
          effective_until=$5::timestamptz,published_by_employee_id=$6::uuid,
          published_at=clock_timestamp(),publication_mode='separated',reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
        RETURNING id, policy_code, version, status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.policyId,
        input.effectiveFrom, input.effectiveUntil, context.employeeId, input.reason,
      ])
      const row = updated.rows[0]
      if (!row) throw new CustomerExperienceRequestError('会员规则发布失败', 'LOYALTY_POLICY_PUBLISH_FAILED', 409)
      if (previous) await transaction.query(`
        UPDATE mbox.loyalty_policy_versions SET effective_until=$4::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
      `, [transaction.scope.tenantId, transaction.scope.storeId, previous.id, input.effectiveFrom])
      const output = { id: row.id, policyCode: row.policy_code, version: row.version, status: row.status }
      return commandOutcome(
        output,
        staffActor(context),
        'loyalty.policy.published',
        'loyalty_policy_version',
        row.id,
        context.businessDate,
        { policyCode: row.policy_code, version: row.version, effectiveFrom: input.effectiveFrom, reason: input.reason },
      )
    })
  }

  listLoyaltyTierPolicies(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<{
        id: string; version: number; status: string; evaluation_window_months: number
        tier_period_months: number; downgrade_grace_days: number
        silver_upgrade_growth: number; silver_retain_growth: number
        gold_upgrade_growth: number; gold_retain_growth: number
        silver_points_multiplier_numerator: number; silver_points_multiplier_denominator: number
        gold_points_multiplier_numerator: number; gold_points_multiplier_denominator: number
        effective_from: string | null; effective_until: string | null
        drafted_by_employee_id: string; approved_by_employee_id: string | null
        approved_at: string | null; published_by_employee_id: string | null
        published_at: string | null; publication_mode: string; reason: string
      }>(`
        SELECT id,version,status,evaluation_window_months,tier_period_months,downgrade_grace_days,
          silver_upgrade_growth,silver_retain_growth,gold_upgrade_growth,gold_retain_growth,
          silver_points_multiplier_numerator,silver_points_multiplier_denominator,
          gold_points_multiplier_numerator,gold_points_multiplier_denominator,
          effective_from::text,effective_until::text,drafted_by_employee_id,
          approved_by_employee_id,approved_at::text,published_by_employee_id,
          published_at::text,publication_mode,reason
        FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        ORDER BY version DESC,id DESC
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows.map((row) => ({
        id: row.id, version: row.version, status: row.status,
        evaluationWindowMonths: row.evaluation_window_months,
        tierPeriodMonths: row.tier_period_months,
        downgradeGraceDays: row.downgrade_grace_days,
        silverUpgradeGrowth: row.silver_upgrade_growth,
        silverRetainGrowth: row.silver_retain_growth,
        goldUpgradeGrowth: row.gold_upgrade_growth,
        goldRetainGrowth: row.gold_retain_growth,
        silverPointsMultiplierNumerator: row.silver_points_multiplier_numerator,
        silverPointsMultiplierDenominator: row.silver_points_multiplier_denominator,
        goldPointsMultiplierNumerator: row.gold_points_multiplier_numerator,
        goldPointsMultiplierDenominator: row.gold_points_multiplier_denominator,
        effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
        draftedByEmployeeId: row.drafted_by_employee_id,
        approvedByEmployeeId: row.approved_by_employee_id,
        approvedAt: row.approved_at,
        publishedByEmployeeId: row.published_by_employee_id,
        publishedAt: row.published_at,
        publicationMode: row.publication_mode,
        reason: row.reason,
      }))
    }, { readOnly: true })
  }

  draftLoyaltyTierPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      evaluationWindowMonths: number; tierPeriodMonths: number; downgradeGraceDays: number
      silverUpgradeGrowth: number; silverRetainGrowth: number
      goldUpgradeGrowth: number; goldRetainGrowth: number
      silverPointsMultiplierNumerator: number; silverPointsMultiplierDenominator: number
      goldPointsMultiplierNumerator: number; goldPointsMultiplierDenominator: number
      reason: string; idempotencyKey: string
    }>,
  ) {
    assertTierPolicy(input)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-policy.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string }>(),
    }, async (transaction) => {
      await transaction.query(`SELECT id FROM mbox.stores WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [
        transaction.scope.tenantId, transaction.scope.storeId,
      ])
      const inserted = await transaction.query<{ id: string; version: number; status: string }>(`
        WITH next_version AS (
          SELECT COALESCE(max(version),0)+1 AS version FROM mbox.loyalty_tier_policy_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        )
        INSERT INTO mbox.loyalty_tier_policy_versions (
          tenant_id,store_id,version,status,evaluation_window_months,tier_period_months,
          downgrade_grace_days,silver_upgrade_growth,silver_retain_growth,
          gold_upgrade_growth,gold_retain_growth,
          silver_points_multiplier_numerator,silver_points_multiplier_denominator,
          gold_points_multiplier_numerator,gold_points_multiplier_denominator,
          drafted_by_employee_id,reason
        ) SELECT $1::uuid,$2::uuid,version,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid,$15
        FROM next_version RETURNING id,version,status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId,
        input.evaluationWindowMonths, input.tierPeriodMonths, input.downgradeGraceDays,
        input.silverUpgradeGrowth, input.silverRetainGrowth,
        input.goldUpgradeGrowth, input.goldRetainGrowth,
        input.silverPointsMultiplierNumerator, input.silverPointsMultiplierDenominator,
        input.goldPointsMultiplierNumerator, input.goldPointsMultiplierDenominator,
        context.employeeId, input.reason,
      ])
      const row = requiredRow(inserted.rows[0], 'Loyalty tier policy draft')
      return commandOutcome(row, staffActor(context), 'loyalty.tier-policy.drafted',
        'loyalty_tier_policy_version', row.id, context.businessDate,
        { version: row.version, status: row.status, reason: input.reason })
    })
  }

  approveLoyaltyTierPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      policyId: string; impactPreviewAcknowledged: boolean; reason: string; idempotencyKey: string
    }>,
  ) {
    if (!input.impactPreviewAcknowledged) throw new CustomerExperienceRequestError(
      '审批等级规则前必须确认已复核历史会员分布与权益成本影响',
      'LOYALTY_TIER_IMPACT_NOT_ACKNOWLEDGED', 409,
    )
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-policy.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string }>(),
    }, async (transaction) => {
      const row = (await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.loyalty_tier_policy_versions
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND drafted_by_employee_id<>$4::uuid
        RETURNING id,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId, context.employeeId, input.reason])).rows[0]
      if (!row) throw new CustomerExperienceRequestError(
        '只有他人起草且尚未审批的等级规则可以审批', 'LOYALTY_TIER_POLICY_APPROVAL_DENIED', 409,
      )
      return commandOutcome(row, staffActor(context), 'loyalty.tier-policy.approved',
        'loyalty_tier_policy_version', row.id, context.businessDate,
        { version: row.version, impactPreviewAcknowledged: true, reason: input.reason })
    })
  }

  publishLoyaltyTierPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      policyId: string; effectiveFrom: string; effectiveUntil: string | null
      reason: string; idempotencyKey: string
    }>,
  ) {
    assertReleaseWindow(input.effectiveFrom, input.effectiveUntil)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.tier-policy.publish',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string }>(),
    }, async (transaction) => {
      const selected = await transaction.query<{
        id: string; version: number; status: string
        drafted_by_employee_id: string; approved_by_employee_id: string
      }>(`
        SELECT id,version,status,drafted_by_employee_id,approved_by_employee_id
        FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.policyId])
      const policy = selected.rows[0]
      if (!policy || policy.status !== 'approved') throw new CustomerExperienceRequestError(
        '只有已经独立审批的等级规则可以发布', 'LOYALTY_TIER_POLICY_NOT_APPROVED', 409,
      )
      if (policy.drafted_by_employee_id === context.employeeId
        || policy.approved_by_employee_id === context.employeeId) throw new CustomerExperienceRequestError(
        '等级规则起草人和审批人不能执行正式发布',
        'LOYALTY_TIER_POLICY_PUBLISHER_NOT_INDEPENDENT', 409,
      )
      const previous = (await transaction.query<{ id: string; effective_from: string; effective_until: string | null }>(`
        SELECT id,effective_from::text,effective_until::text
        FROM mbox.loyalty_tier_policy_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
        ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId])).rows[0]
      assertAppendOnlyRelease(previous, input.effectiveFrom, '会员等级规则')
      await transaction.query('SET CONSTRAINTS mbox.loyalty_tier_policy_versions_no_published_overlap_excl DEFERRED')
      const updated = await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.loyalty_tier_policy_versions
        SET status='published',effective_from=$4::timestamptz,effective_until=$5::timestamptz,
          published_by_employee_id=$6::uuid,published_at=clock_timestamp(),
          publication_mode='separated',reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
        RETURNING id,version,status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.policyId,
        input.effectiveFrom, input.effectiveUntil, context.employeeId, input.reason,
      ])
      const row = requiredRow(updated.rows[0], 'Loyalty tier policy publication')
      if (previous) await transaction.query(`
        UPDATE mbox.loyalty_tier_policy_versions SET effective_until=$4::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
      `, [transaction.scope.tenantId, transaction.scope.storeId, previous.id, input.effectiveFrom])
      return commandOutcome(row, staffActor(context), 'loyalty.tier-policy.published',
        'loyalty_tier_policy_version', row.id, context.businessDate,
        { version: row.version, status: row.status, effectiveFrom: input.effectiveFrom, reason: input.reason })
    })
  }

  redemptionConfiguration(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const control = await transaction.query<{
          state: string; pilot_starts_at: string | null; pilot_ends_at: string | null
          reason: string; changed_by_employee_id: string; changed_at: string
        }>(`
          SELECT state,pilot_starts_at::text,pilot_ends_at::text,reason,
            changed_by_employee_id,changed_at::text
          FROM mbox.loyalty_redemption_controls
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const versions = await transaction.query<{
          id: string; version: number; status: string; effective_from: string | null
          effective_until: string | null; drafted_by_employee_id: string
          approved_by_employee_id: string | null; approved_at: string | null
          published_by_employee_id: string | null; published_at: string | null
          publication_mode: string; reason: string; item_count: number
        }>(`
          SELECT version.id,version.version,version.status,version.effective_from::text,
            version.effective_until::text,version.drafted_by_employee_id,
            version.approved_by_employee_id,version.approved_at::text,
            version.published_by_employee_id,version.published_at::text,
            version.publication_mode,version.reason,count(item.id)::integer AS item_count
          FROM mbox.redemption_catalog_versions version
          LEFT JOIN mbox.redemption_catalog_items item
            ON item.tenant_id=version.tenant_id AND item.store_id=version.store_id
           AND item.catalog_version_id=version.id
          WHERE version.tenant_id=$1::uuid AND version.store_id=$2::uuid
          GROUP BY version.id ORDER BY version.version DESC,version.id DESC
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const pending = await transaction.query<{
          public_id: string; member_no: string; item_name: string; points_used: number
          fulfillment_kind: string; status: string; expires_at: string; created_at: string
          failure_code: string | null; recovery_state: string
          recovery_requested_at: string | null; points_restored: number
        }>(`
          SELECT redemption.public_id,membership.member_no,item.name AS item_name,
            redemption.points_used,redemption.fulfillment_kind,redemption.status,
            redemption.expires_at::text,redemption.created_at::text,
            redemption.failure_code,redemption.recovery_state,
            redemption.recovery_requested_at::text,redemption.points_restored
          FROM mbox.member_redemptions redemption
          JOIN mbox.customer_memberships membership
            ON membership.tenant_id=redemption.tenant_id AND membership.store_id=redemption.store_id
           AND membership.id=redemption.membership_id
          JOIN mbox.redemption_catalog_items item
            ON item.tenant_id=redemption.tenant_id AND item.store_id=redemption.store_id
           AND item.id=redemption.catalog_item_id
          WHERE redemption.tenant_id=$1::uuid AND redemption.store_id=$2::uuid
            AND redemption.status='awaiting_fulfillment'
          ORDER BY redemption.expires_at,redemption.id LIMIT 200
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      const items = await transaction.query<{
          catalog_id: string; catalog_version: number; catalog_status: string
          public_id: string; item_code: string; name: string; fulfillment_kind: string
          product_id: string | null; product_name: string | null
          benefit_definition_id: string | null; activity_id: string | null; points_required: number
          cost_amount_minor: string | number; currency: string
          total_inventory: number | null; daily_inventory: number | null
          member_daily_limit: number; member_rolling_30_day_limit: number
          member_lifetime_limit: number | null
          minimum_tier: string; available_from: string; available_until: string | null
          requires_table_session: boolean; requires_employee_fulfillment: boolean
          cancellation_allowed_before_fulfillment: boolean; restore_expired_points_days: number
          fulfillment_timeout_minutes: number; status: string; display_snapshot: unknown
        }>(`
          SELECT version.id AS catalog_id,version.version AS catalog_version,
            version.status AS catalog_status,item.public_id,item.item_code,item.name,
            item.fulfillment_kind,item.product_id,product.name AS product_name,
            item.benefit_definition_id,item.activity_id,
            item.points_required,item.cost_amount_minor,item.currency,
            item.total_inventory,item.daily_inventory,item.member_daily_limit,
            item.member_rolling_30_day_limit,item.member_lifetime_limit,item.minimum_tier,
            item.requires_table_session,item.requires_employee_fulfillment,
            item.cancellation_allowed_before_fulfillment,item.restore_expired_points_days,
            item.fulfillment_timeout_minutes,item.available_from::text,item.available_until::text,
            item.status,item.display_snapshot
          FROM mbox.redemption_catalog_items item
          JOIN mbox.redemption_catalog_versions version
            ON version.tenant_id=item.tenant_id AND version.store_id=item.store_id
           AND version.id=item.catalog_version_id
          LEFT JOIN mbox.products product
            ON product.tenant_id=item.tenant_id AND product.store_id=item.store_id
           AND product.id=item.product_id
          WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid
          ORDER BY version.version DESC,item.points_required,item.name,item.id
          LIMIT 500
        `, [transaction.scope.tenantId, transaction.scope.storeId])
      return {
        control: control.rows[0] ? {
          state: control.rows[0].state,
          pilotStartsAt: control.rows[0].pilot_starts_at,
          pilotEndsAt: control.rows[0].pilot_ends_at,
          reason: control.rows[0].reason,
          changedByEmployeeId: control.rows[0].changed_by_employee_id,
          changedAt: control.rows[0].changed_at,
        } : { state: 'disabled', pilotStartsAt: null, pilotEndsAt: null, reason: '尚未配置' },
        versions: versions.rows.map((row) => ({
          id: row.id, version: row.version, status: row.status,
          effectiveFrom: row.effective_from, effectiveUntil: row.effective_until,
          draftedByEmployeeId: row.drafted_by_employee_id,
          approvedByEmployeeId: row.approved_by_employee_id,
          approvedAt: row.approved_at,
          publishedByEmployeeId: row.published_by_employee_id,
          publishedAt: row.published_at,
          publicationMode: row.publication_mode,
          reason: row.reason, itemCount: row.item_count,
        })),
        pending: pending.rows.map((row) => ({
          publicId: row.public_id, memberNo: row.member_no, itemName: row.item_name,
          pointsUsed: row.points_used, fulfillmentKind: row.fulfillment_kind,
          status: row.status, expiresAt: row.expires_at, createdAt: row.created_at,
          failureCode: row.failure_code, recoveryState: row.recovery_state,
          recoveryRequestedAt: row.recovery_requested_at, pointsRestored: row.points_restored,
        })),
        items: items.rows.map((row) => ({
          catalogId: row.catalog_id, catalogVersion: row.catalog_version,
          catalogStatus: row.catalog_status, publicId: row.public_id,
          itemCode: row.item_code, name: row.name, fulfillmentKind: row.fulfillment_kind,
          productId: row.product_id, productName: row.product_name,
          benefitDefinitionId: row.benefit_definition_id, activityId: row.activity_id,
          pointsRequired: row.points_required, costAmountMinor: Number(row.cost_amount_minor),
          currency: row.currency, totalInventory: row.total_inventory,
          dailyInventory: row.daily_inventory, memberDailyLimit: row.member_daily_limit,
          memberRolling30DayLimit: row.member_rolling_30_day_limit,
          memberLifetimeLimit: row.member_lifetime_limit,
          minimumTier: row.minimum_tier, availableFrom: row.available_from,
          availableUntil: row.available_until, status: row.status,
          requiresTableSession: row.requires_table_session,
          requiresEmployeeFulfillment: row.requires_employee_fulfillment,
          cancellationAllowedBeforeFulfillment: row.cancellation_allowed_before_fulfillment,
          restoreExpiredPointsDays: row.restore_expired_points_days,
          fulfillmentTimeoutMinutes: row.fulfillment_timeout_minutes,
          display: isObject(row.display_snapshot) ? row.display_snapshot : {},
        })),
      }
    }, { readOnly: true })
  }

  draftRedemptionCatalog(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      reason: string
      items: ReadonlyArray<Readonly<{
        publicId: string; itemCode: string; name: string
        fulfillmentKind: 'product' | 'benefit' | 'activity' | 'service'
        productId: string | null; benefitDefinitionId: string | null; activityId: string | null
        pointsRequired: number; costAmountMinor: number; currency: string
        totalInventory: number | null; dailyInventory: number | null
        memberDailyLimit: number; memberRolling30DayLimit: number; memberLifetimeLimit: number | null
        minimumTier: 'member' | 'silver' | 'gold'; requiresTableSession: boolean
        requiresEmployeeFulfillment: boolean; cancellationAllowedBeforeFulfillment: boolean
        restoreExpiredPointsDays: number; availableFrom: string; availableUntil: string | null
        fulfillmentTimeoutMinutes: number; display: JsonObject
      }>>
      idempotencyKey: string
    }>,
  ) {
    if (input.items.length < 1 || input.items.length > 200) throw new CustomerExperienceRequestError(
      '兑换目录必须包含1至200个兑换项', 'LOYALTY_REDEMPTION_CATALOG_INVALID', 409,
    )
    if (new Set(input.items.map((item) => item.itemCode)).size !== input.items.length
      || new Set(input.items.map((item) => item.publicId)).size !== input.items.length) {
      throw new CustomerExperienceRequestError('兑换项代码或公开编号重复', 'LOYALTY_REDEMPTION_CATALOG_DUPLICATE', 409)
    }
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.redemption.catalog.draft',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; itemCount: number }>(),
    }, async (transaction) => {
      await transaction.query(`SELECT id FROM mbox.stores WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [
        transaction.scope.tenantId, transaction.scope.storeId,
      ])
      const version = requiredRow((await transaction.query<{ id: string; version: number; status: string }>(`
        WITH next_version AS (
          SELECT COALESCE(max(version),0)+1 AS version FROM mbox.redemption_catalog_versions
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid
        )
        INSERT INTO mbox.redemption_catalog_versions (
          tenant_id,store_id,version,status,drafted_by_employee_id,reason
        ) SELECT $1::uuid,$2::uuid,version,'draft',$3::uuid,$4 FROM next_version
        RETURNING id,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, context.employeeId, input.reason])).rows[0], 'Redemption catalog draft')
      for (const item of input.items) {
        await transaction.query(`
          INSERT INTO mbox.redemption_catalog_items (
            tenant_id,store_id,catalog_version_id,public_id,item_code,name,fulfillment_kind,
            product_id,benefit_definition_id,activity_id,points_required,cost_amount_minor,currency,
            total_inventory,daily_inventory,member_daily_limit,member_rolling_30_day_limit,
            member_lifetime_limit,minimum_tier,requires_table_session,requires_employee_fulfillment,
            cancellation_allowed_before_fulfillment,restore_expired_points_days,available_from,
            available_until,fulfillment_timeout_minutes,status,display_snapshot
          ) VALUES (
            $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::uuid,$10::uuid,$11,$12::bigint,$13,
            $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::timestamptz,$25::timestamptz,$26,'active',$27::jsonb
          )
        `, [
          transaction.scope.tenantId, transaction.scope.storeId, version.id,
          item.publicId, item.itemCode, item.name, item.fulfillmentKind,
          item.productId, item.benefitDefinitionId, item.activityId,
          item.pointsRequired, item.costAmountMinor, item.currency,
          item.totalInventory, item.dailyInventory, item.memberDailyLimit,
          item.memberRolling30DayLimit, item.memberLifetimeLimit, item.minimumTier,
          item.requiresTableSession, item.requiresEmployeeFulfillment,
          item.cancellationAllowedBeforeFulfillment, item.restoreExpiredPointsDays,
          item.availableFrom, item.availableUntil, item.fulfillmentTimeoutMinutes,
          JSON.stringify(item.display),
        ])
      }
      const result = { ...version, itemCount: input.items.length }
      return commandOutcome(result, staffActor(context), 'loyalty.redemption.catalog.drafted',
        'redemption_catalog_version', version.id, context.businessDate,
        { version: version.version, itemCount: input.items.length, reason: input.reason })
    })
  }

  approveRedemptionCatalog(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      catalogId: string; costAndFulfillmentReviewed: boolean; reason: string; idempotencyKey: string
    }>,
  ) {
    if (!input.costAndFulfillmentReviewed) throw new CustomerExperienceRequestError(
      '审批前必须确认真实成本、库存与履约能力已经复核',
      'LOYALTY_REDEMPTION_REVIEW_REQUIRED', 409,
    )
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.redemption.catalog.approve',
      idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; itemCount: number }>(),
    }, async (transaction) => {
      const catalog = (await transaction.query<{
        id: string; version: number; status: string; drafted_by_employee_id: string
      }>(`
        SELECT id,version,status,drafted_by_employee_id FROM mbox.redemption_catalog_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.catalogId])).rows[0]
      if (!catalog || catalog.status!=='draft') throw new CustomerExperienceRequestError(
        '只有兑换目录草稿可以审批', 'LOYALTY_REDEMPTION_CATALOG_NOT_DRAFT', 409,
      )
      if (catalog.drafted_by_employee_id===context.employeeId) throw new CustomerExperienceRequestError(
        '兑换目录起草人不能审批自己的目录', 'LOYALTY_REDEMPTION_CATALOG_SELF_APPROVAL_DENIED', 409,
      )
      const validation = await validateRedemptionCatalog(transaction, input.catalogId)
      const row = requiredRow((await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.redemption_catalog_versions
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),reason=$5
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='draft'
        RETURNING id,version,status
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.catalogId, context.employeeId, input.reason])).rows[0],
      'Redemption catalog approval')
      const result = { ...row, itemCount: validation.item_count }
      return commandOutcome(result, staffActor(context), 'loyalty.redemption.catalog.approved',
        'redemption_catalog_version', row.id, context.businessDate,
        { version: row.version, itemCount: validation.item_count,
          costAndFulfillmentReviewed: true, reason: input.reason })
    })
  }

  publishRedemptionCatalog(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      catalogId: string; effectiveFrom: string; effectiveUntil: string | null
      reason: string; idempotencyKey: string
    }>,
  ) {
    assertReleaseWindow(input.effectiveFrom, input.effectiveUntil)
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.redemption.catalog.publish',
      idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ id: string; version: number; status: string; itemCount: number }>(),
    }, async (transaction) => {
      const selected = await transaction.query<{
        id: string; version: number; status: string; drafted_by_employee_id: string
        approved_by_employee_id: string
      }>(`
        SELECT id,version,status,drafted_by_employee_id,approved_by_employee_id
        FROM mbox.redemption_catalog_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.catalogId])
      const catalog = selected.rows[0]
      if (!catalog || catalog.status !== 'approved') throw new CustomerExperienceRequestError(
        '只有已经独立审批的兑换目录可以发布', 'LOYALTY_REDEMPTION_CATALOG_NOT_APPROVED', 409,
      )
      if (catalog.drafted_by_employee_id===context.employeeId
        || catalog.approved_by_employee_id===context.employeeId) throw new CustomerExperienceRequestError(
        '兑换目录起草人和审批人不能执行正式发布',
        'LOYALTY_REDEMPTION_CATALOG_PUBLISHER_NOT_INDEPENDENT', 409,
      )
      const validation = await validateRedemptionCatalog(transaction, input.catalogId)
      const previous = (await transaction.query<{ id: string; effective_from: string; effective_until: string | null }>(`
        SELECT id,effective_from::text,effective_until::text FROM mbox.redemption_catalog_versions
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND status='published'
        ORDER BY effective_from DESC,id DESC LIMIT 1 FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId])).rows[0]
      assertAppendOnlyRelease(previous, input.effectiveFrom, '积分兑换目录')
      await transaction.query('SET CONSTRAINTS mbox.redemption_catalog_versions_no_published_overlap_excl DEFERRED')
      const row = requiredRow((await transaction.query<{ id: string; version: number; status: string }>(`
        UPDATE mbox.redemption_catalog_versions
        SET status='published',effective_from=$4::timestamptz,effective_until=$5::timestamptz,
          published_by_employee_id=$6::uuid,published_at=clock_timestamp(),
          publication_mode='separated',reason=$7
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='approved'
        RETURNING id,version,status
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.catalogId,
        input.effectiveFrom, input.effectiveUntil, context.employeeId, input.reason,
      ])).rows[0], 'Redemption catalog publication')
      if (previous) await transaction.query(`
        UPDATE mbox.redemption_catalog_versions SET effective_until=$4::timestamptz
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='published'
      `, [transaction.scope.tenantId, transaction.scope.storeId, previous.id, input.effectiveFrom])
      const result = { ...row, itemCount: validation.item_count }
      return commandOutcome(result, staffActor(context), 'loyalty.redemption.catalog.published',
        'redemption_catalog_version', row.id, context.businessDate,
        { version: row.version, itemCount: validation.item_count,
          effectiveFrom: input.effectiveFrom, reason: input.reason })
    })
  }

  setRedemptionControl(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      state: 'disabled' | 'pilot' | 'enabled' | 'paused'
      pilotStartsAt: string | null; pilotEndsAt: string | null
      reason: string; idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope, operationScope: 'loyalty.redemption.control',
      idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ state: string; pilotStartsAt: string | null; pilotEndsAt: string | null }>(),
    }, async (transaction) => {
      if (['pilot', 'enabled'].includes(input.state)) {
        const ready = await transaction.query<{ ready: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM mbox.redemption_catalog_versions version
            WHERE version.tenant_id=$1::uuid AND version.store_id=$2::uuid
              AND version.status='published' AND version.effective_from<=clock_timestamp()
              AND (version.effective_until IS NULL OR version.effective_until>clock_timestamp())
          ) AS ready
        `, [transaction.scope.tenantId, transaction.scope.storeId])
        if (ready.rows[0]?.ready !== true) throw new CustomerExperienceRequestError(
          '没有当前有效且完成双人复核的兑换目录，不能开放兑换', 'LOYALTY_REDEMPTION_CATALOG_NOT_READY', 409,
        )
      }
      await transaction.query(`
        INSERT INTO mbox.loyalty_redemption_controls (
          tenant_id,store_id,state,pilot_starts_at,pilot_ends_at,reason,changed_by_employee_id
        ) VALUES ($1::uuid,$2::uuid,$3,$4::timestamptz,$5::timestamptz,$6,$7::uuid)
        ON CONFLICT (tenant_id,store_id) DO UPDATE SET state=EXCLUDED.state,
          pilot_starts_at=EXCLUDED.pilot_starts_at,pilot_ends_at=EXCLUDED.pilot_ends_at,
          reason=EXCLUDED.reason,changed_by_employee_id=EXCLUDED.changed_by_employee_id,
          changed_at=clock_timestamp()
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, input.state,
        input.pilotStartsAt, input.pilotEndsAt, input.reason, context.employeeId,
      ])
      const result = { state: input.state, pilotStartsAt: input.pilotStartsAt, pilotEndsAt: input.pilotEndsAt }
      return commandOutcome(result, staffActor(context), 'loyalty.redemption.control.changed',
        'loyalty_redemption_control', transaction.scope.storeId, context.businessDate,
        { ...result, reason: input.reason })
    })
  }

  loyaltyReconciliation(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<{
        order_public_id: string
        member_no: string
        eligible_amount_minor: string | number
        expected_points: number
        expected_growth: number
        existing_points: number
        existing_growth: number
        status: string
      }>(`
        WITH RECURSIVE paid_orders AS (
          SELECT ordering.id, ordering.public_id, ordering.created_by_customer_id,
            ordering.loyalty_policy_version_id,
            ordering.loyalty_points_multiplier_numerator,
            ordering.loyalty_points_multiplier_denominator
          FROM mbox.orders ordering
          WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
            AND ordering.payment_status IN ('paid','partially_refunded','refunded')
            AND ordering.created_by_customer_id IS NOT NULL
            AND ordering.loyalty_policy_version_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM mbox.payments payment
              WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
                AND payment.order_id=ordering.id AND payment.succeeded_at IS NOT NULL
                AND payment.status IN ('succeeded','partially_refunded','refunded')
            )
        ), ancestry AS (
          SELECT paid.id AS order_id, customer.id, customer.merged_into_customer_id
          FROM paid_orders paid
          JOIN mbox.customers customer
            ON customer.tenant_id=$1::uuid AND customer.store_id=$2::uuid
           AND customer.id=paid.created_by_customer_id
          UNION ALL
          SELECT child.order_id, parent.id, parent.merged_into_customer_id
          FROM ancestry child
          JOIN mbox.customers parent ON parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
            AND parent.id=child.merged_into_customer_id
        ), canonical AS (
          SELECT order_id,id FROM ancestry WHERE merged_into_customer_id IS NULL
        ), family AS (
          SELECT order_id,id FROM canonical
          UNION ALL
          SELECT parent.order_id, child.id
          FROM family parent
          JOIN mbox.customers child ON child.tenant_id=$1::uuid AND child.store_id=$2::uuid
            AND child.merged_into_customer_id=parent.id
        ), active_memberships AS (
          SELECT DISTINCT ON (family.order_id) family.order_id,
            membership.id AS membership_id, membership.member_no
          FROM family
          JOIN mbox.customer_memberships membership
            ON membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
           AND membership.customer_id=family.id AND membership.status='active'
          ORDER BY family.order_id, membership.joined_at, membership.id
        ), eligible AS (
          SELECT paid.id AS order_id,
            CASE WHEN EXISTS (
              SELECT 1 FROM mbox.pricing_authorizations authz
              WHERE authz.tenant_id=$1::uuid AND authz.store_id=$2::uuid
                AND authz.order_id=paid.id AND authz.status='consumed' AND authz.kind='gift'
            ) THEN 0 ELSE COALESCE(SUM(item.total_amount_minor) FILTER (
              WHERE item.parent_order_item_id IS NULL AND item.status<>'cancelled'
                AND item.total_amount_minor>0 AND item.loyalty_eligible_at_submission
            ),0)::bigint END AS eligible_amount_minor
          FROM paid_orders paid
          LEFT JOIN mbox.order_items item
            ON item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=paid.id
          GROUP BY paid.id
        ), base_rewards AS (
          SELECT paid.id, paid.public_id, membership.member_no,
            eligible.eligible_amount_minor,
            paid.loyalty_points_multiplier_numerator,
            paid.loyalty_points_multiplier_denominator,
            policy.rounding_mode,
            CASE policy.rounding_mode WHEN 'nearest'
              THEN ((eligible.eligible_amount_minor * policy.points_numerator
                + policy.points_denominator_minor / 2) / policy.points_denominator_minor)::bigint
              ELSE ((eligible.eligible_amount_minor * policy.points_numerator)
                / policy.points_denominator_minor)::bigint END AS base_points,
            CASE policy.rounding_mode WHEN 'nearest'
              THEN ((eligible.eligible_amount_minor * policy.growth_numerator
                + policy.growth_denominator_minor / 2) / policy.growth_denominator_minor)::integer
              ELSE ((eligible.eligible_amount_minor * policy.growth_numerator)
                / policy.growth_denominator_minor)::integer END AS expected_growth
          FROM paid_orders paid
          JOIN active_memberships membership ON membership.order_id=paid.id
          JOIN eligible ON eligible.order_id=paid.id
          JOIN mbox.loyalty_policy_versions policy
            ON policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
           AND policy.id=paid.loyalty_policy_version_id
        ), expected AS (
          SELECT base.*, CASE base.rounding_mode WHEN 'nearest'
            THEN ((base.base_points * base.loyalty_points_multiplier_numerator
              + base.loyalty_points_multiplier_denominator / 2)
              / base.loyalty_points_multiplier_denominator)::integer
            ELSE ((base.base_points * base.loyalty_points_multiplier_numerator)
              / base.loyalty_points_multiplier_denominator)::integer END AS expected_points
          FROM base_rewards base
        )
        SELECT expected.public_id AS order_public_id, expected.member_no,
          expected.eligible_amount_minor, expected.expected_points, expected.expected_growth,
          COALESCE(award.awarded_points,0) AS existing_points,
          COALESCE(award.awarded_growth,0) AS existing_growth,
          CASE WHEN award.id IS NULL THEN 'missing'
            WHEN award.awarded_points<>expected.expected_points
              OR award.awarded_growth<>expected.expected_growth
              THEN 'mismatch' ELSE 'matched' END AS status
        FROM expected
        LEFT JOIN mbox.loyalty_order_awards award
          ON award.tenant_id=$1::uuid AND award.store_id=$2::uuid AND award.order_id=expected.id
        ORDER BY CASE WHEN award.id IS NULL THEN 0 ELSE 1 END, expected.public_id
        LIMIT 200
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows.map((row) => ({
        orderPublicId: row.order_public_id,
        memberNo: row.member_no,
        eligibleAmountMinor: Number(row.eligible_amount_minor),
        expectedPoints: row.expected_points,
        expectedGrowth: row.expected_growth,
        existingPoints: row.existing_points,
        existingGrowth: row.existing_growth,
        status: row.status,
      }))
    }, { readOnly: true })
  }

  loyaltySupplementRequests(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, async (transaction) => {
      const result = await transaction.query<{
        public_id: string
        order_public_id: string
        member_no: string
        requested_points: number
        requested_growth: number
        status: string
        reason: string
        requested_by_employee_id: string
        requested_by_name: string
        approved_by_name: string | null
        decision_reason: string | null
        created_at: string
      }>(`
        SELECT request.public_id, ordering.public_id AS order_public_id,
          membership.member_no, request.requested_points, request.requested_growth,
          request.status, request.reason, request.requested_by_employee_id,
          requester.display_name AS requested_by_name,
          approver.display_name AS approved_by_name, request.decision_reason,
          request.created_at::text
        FROM mbox.loyalty_supplement_requests request
        JOIN mbox.orders ordering
          ON ordering.tenant_id=request.tenant_id AND ordering.store_id=request.store_id
         AND ordering.id=request.order_id
        JOIN mbox.customer_memberships membership
          ON membership.tenant_id=request.tenant_id AND membership.store_id=request.store_id
         AND membership.id=request.membership_id
        JOIN mbox.employees requester
          ON requester.tenant_id=request.tenant_id AND requester.store_id=request.store_id
         AND requester.id=request.requested_by_employee_id
        LEFT JOIN mbox.employees approver
          ON approver.tenant_id=request.tenant_id AND approver.store_id=request.store_id
         AND approver.id=request.approved_by_employee_id
        WHERE request.tenant_id=$1::uuid AND request.store_id=$2::uuid
        ORDER BY CASE request.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
          request.created_at DESC, request.id DESC
        LIMIT 200
      `, [transaction.scope.tenantId, transaction.scope.storeId])
      return result.rows.map((row) => ({
        publicId: row.public_id,
        orderPublicId: row.order_public_id,
        memberNo: row.member_no,
        requestedPoints: row.requested_points,
        requestedGrowth: row.requested_growth,
        status: row.status,
        reason: row.reason,
        requestedByEmployeeId: row.requested_by_employee_id,
        requestedByName: row.requested_by_name,
        approvedByName: row.approved_by_name,
        decisionReason: row.decision_reason,
        createdAt: row.created_at,
      }))
    }, { readOnly: true })
  }

  requestLoyaltySupplement(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ orderPublicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'loyalty.supplement.request',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: string; requestedPoints: number; requestedGrowth: number }>(),
    }, async (transaction) => {
      const selected = await transaction.query<{
        order_id: string
        membership_id: string
        customer_id: string
        policy_version_id: string
        expected_points: number
        expected_growth: number
        existing_points: number
        existing_growth: number
      }>(`
        WITH RECURSIVE target AS (
          SELECT ordering.id AS order_id, ordering.created_by_customer_id AS customer_id,
            ordering.loyalty_policy_version_id AS policy_version_id,
            ordering.loyalty_points_multiplier_numerator AS multiplier_numerator,
            ordering.loyalty_points_multiplier_denominator AS multiplier_denominator
          FROM mbox.orders ordering
          WHERE ordering.tenant_id=$1::uuid AND ordering.store_id=$2::uuid
            AND ordering.public_id=$3
            AND ordering.payment_status IN ('paid','partially_refunded','refunded')
            AND ordering.created_by_customer_id IS NOT NULL
            AND ordering.loyalty_policy_version_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM mbox.payments payment
              WHERE payment.tenant_id=ordering.tenant_id AND payment.store_id=ordering.store_id
                AND payment.order_id=ordering.id AND payment.succeeded_at IS NOT NULL
                AND payment.status IN ('succeeded','partially_refunded','refunded')
            )
        ), ancestry AS (
          SELECT customer.id, customer.merged_into_customer_id
          FROM target
          JOIN mbox.customers customer
            ON customer.tenant_id=$1::uuid AND customer.store_id=$2::uuid
           AND customer.id=target.customer_id
          UNION ALL
          SELECT parent.id, parent.merged_into_customer_id
          FROM mbox.customers parent JOIN ancestry child ON parent.id=child.merged_into_customer_id
          WHERE parent.tenant_id=$1::uuid AND parent.store_id=$2::uuid
        ), canonical AS (
          SELECT id FROM ancestry WHERE merged_into_customer_id IS NULL LIMIT 1
        ), family AS (
          SELECT id FROM canonical
          UNION ALL
          SELECT child.id FROM mbox.customers child JOIN family parent
            ON child.merged_into_customer_id=parent.id
          WHERE child.tenant_id=$1::uuid AND child.store_id=$2::uuid
        ), eligible AS (
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM mbox.pricing_authorizations authz
            WHERE authz.tenant_id=$1::uuid AND authz.store_id=$2::uuid
              AND authz.order_id=target.order_id AND authz.status='consumed' AND authz.kind='gift'
          ) THEN 0 ELSE COALESCE(SUM(item.total_amount_minor) FILTER (
            WHERE item.parent_order_item_id IS NULL AND item.status<>'cancelled'
              AND item.total_amount_minor>0 AND item.loyalty_eligible_at_submission
          ),0)::bigint END AS amount_minor
          FROM target
          LEFT JOIN mbox.order_items item
            ON item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.order_id=target.order_id
          GROUP BY target.order_id
        ), calculated AS (
          SELECT target.order_id, target.customer_id, target.policy_version_id,
            target.multiplier_numerator, target.multiplier_denominator,
            membership.id AS membership_id, policy.rounding_mode,
            CASE policy.rounding_mode WHEN 'nearest'
              THEN ((eligible.amount_minor * policy.points_numerator + policy.points_denominator_minor / 2)
                / policy.points_denominator_minor)::bigint
              ELSE ((eligible.amount_minor * policy.points_numerator)
                / policy.points_denominator_minor)::bigint END AS base_points,
            CASE policy.rounding_mode WHEN 'nearest'
              THEN ((eligible.amount_minor * policy.growth_numerator + policy.growth_denominator_minor / 2)
                / policy.growth_denominator_minor)::integer
              ELSE ((eligible.amount_minor * policy.growth_numerator)
                / policy.growth_denominator_minor)::integer END AS expected_growth
          FROM target
          CROSS JOIN eligible
          JOIN mbox.loyalty_policy_versions policy
            ON policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid AND policy.id=target.policy_version_id
          JOIN mbox.customer_memberships membership
            ON membership.tenant_id=$1::uuid AND membership.store_id=$2::uuid
           AND membership.customer_id IN (SELECT id FROM family) AND membership.status='active'
          ORDER BY membership.joined_at, membership.id LIMIT 1
        )
        SELECT calculated.order_id, calculated.membership_id, calculated.customer_id,
          calculated.policy_version_id,
          CASE calculated.rounding_mode WHEN 'nearest'
            THEN ((calculated.base_points * calculated.multiplier_numerator
              + calculated.multiplier_denominator / 2) / calculated.multiplier_denominator)::integer
            ELSE ((calculated.base_points * calculated.multiplier_numerator)
              / calculated.multiplier_denominator)::integer END AS expected_points,
          calculated.expected_growth,
          COALESCE(award.awarded_points,0) AS existing_points,
          COALESCE(award.awarded_growth,0) AS existing_growth
        FROM calculated
        LEFT JOIN mbox.loyalty_order_awards award
          ON award.tenant_id=$1::uuid AND award.store_id=$2::uuid
         AND award.order_id=calculated.order_id
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.orderPublicId])
      const row = selected.rows[0]
      if (!row) throw new CustomerExperienceRequestError(
        '订单不存在、尚未权威付款或没有有效会员', 'LOYALTY_SUPPLEMENT_ORDER_INELIGIBLE', 409,
      )
      const requestedPoints = Math.max(0, row.expected_points - row.existing_points)
      const requestedGrowth = Math.max(0, row.expected_growth - row.existing_growth)
      if (requestedPoints === 0 && requestedGrowth === 0) throw new CustomerExperienceRequestError(
        '该订单积分与成长值已经完整入账', 'LOYALTY_SUPPLEMENT_NOT_REQUIRED', 409,
      )
      const publicId = `LSP-${randomUUID()}`
      const inserted = await transaction.query<{ id: string }>(`
        INSERT INTO mbox.loyalty_supplement_requests (
          tenant_id, store_id, public_id, membership_id, customer_id, order_id,
          policy_version_id, expected_points, existing_points, requested_points,
          expected_growth, existing_growth, requested_growth, reason, requested_by_employee_id
        ) VALUES (
          $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15::uuid
        ) RETURNING id
      `, [
        transaction.scope.tenantId, transaction.scope.storeId, publicId,
        row.membership_id, row.customer_id, row.order_id, row.policy_version_id,
        row.expected_points, row.existing_points, requestedPoints,
        row.expected_growth, row.existing_growth, requestedGrowth,
        input.reason, context.employeeId,
      ])
      const request = inserted.rows[0]
      if (!request) throw new Error('Loyalty supplement request was not inserted')
      const output = { publicId, status: 'requested', requestedPoints, requestedGrowth }
      return commandOutcome(output, staffActor(context), 'loyalty.supplement.requested',
        'loyalty_supplement_request', request.id, context.businessDate,
        { orderPublicId: input.orderPublicId, requestedPoints, requestedGrowth, reason: input.reason })
    })
  }

  decideLoyaltySupplement(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; decision: 'approve' | 'reject'; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: `loyalty.supplement.${input.decision}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: string; pointsDelta: number; growthDelta: number }>(),
    }, async (transaction) => {
      const selected = await transaction.query<{
        id: string
        requested_by_employee_id: string
        status: string
      }>(`
        SELECT id, requested_by_employee_id, status
        FROM mbox.loyalty_supplement_requests
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND public_id=$3
        FOR UPDATE
      `, [transaction.scope.tenantId, transaction.scope.storeId, input.publicId])
      const request = selected.rows[0]
      if (!request || request.status !== 'requested') throw new CustomerExperienceRequestError(
        '补发申请不存在或已处理', 'LOYALTY_SUPPLEMENT_NOT_PENDING', 409,
      )
      if (request.requested_by_employee_id === context.employeeId) throw new CustomerExperienceRequestError(
        '补发申请人不能复核自己的申请', 'LOYALTY_SUPPLEMENT_SELF_APPROVAL_DENIED', 409,
      )
      if (input.decision === 'reject') {
        await transaction.query(`
          UPDATE mbox.loyalty_supplement_requests
          SET status='rejected', approved_by_employee_id=$4::uuid,
              decision_reason=$5, decided_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='requested'
        `, [transaction.scope.tenantId, transaction.scope.storeId, request.id, context.employeeId, input.reason])
        const output = { publicId: input.publicId, status: 'rejected', pointsDelta: 0, growthDelta: 0 }
        return commandOutcome(output, staffActor(context), 'loyalty.supplement.rejected',
          'loyalty_supplement_request', request.id, context.businessDate, { reason: input.reason })
      }
      await transaction.query(`
        UPDATE mbox.loyalty_supplement_requests
        SET status='approved', approved_by_employee_id=$4::uuid,
            decision_reason=$5, decided_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='requested'
      `, [transaction.scope.tenantId, transaction.scope.storeId, request.id, context.employeeId, input.reason])
      let applied
      try {
        applied = await new LoyaltyAccrualRepository(transaction).executeApprovedSupplement({
          requestId: request.id,
          occurredAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof LoyaltyPositiveAccrualPausedError) {
          throw new CustomerExperienceRequestError(
            '新积分和成长值发放已由最高管理人员暂停，本次补发未执行',
            'LOYALTY_POINTS_ACCRUAL_PAUSED',
            409,
          )
        }
        throw error
      }
      const output = {
        publicId: input.publicId,
        status: applied.status,
        pointsDelta: applied.pointsDelta,
        growthDelta: applied.growthDelta,
      }
      return commandOutcome(output, staffActor(context), `loyalty.supplement.${applied.status}`,
        'loyalty_supplement_request', request.id, context.businessDate,
        { reason: input.reason, pointsDelta: applied.pointsDelta, growthDelta: applied.growthDelta })
    })
  }

  activities(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction, this.activityPaymentProviderConfigured).publicActivities(context.customerId)
    ), { readOnly: true })
  }

  activity(context: PublicCustomerExperienceContext, publicId: string) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction, this.activityPaymentProviderConfigured).publicActivity(context.customerId, publicId)
    ), { readOnly: true })
  }

  activityRegistrations(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction, this.activityPaymentProviderConfigured).publicActivityRegistrations(context.customerId)
    ), { readOnly: true })
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
      protectedContact: ProtectedActivityRegistrationContact
      termsAcknowledged: boolean
      acknowledgedSafetyPolicyVersion: string
      acknowledgedRefundPolicyVersion: string
      paymentChoice: ActivityPaymentChoice
      paymentMethod: Extract<PaymentMethod, 'jsapi' | 'native_qr'>
      idempotencyKey: string
    }>,
  ) {
    const registrationPublicId = deterministicPublicId('activity-registration', context.scope.storeId, input.idempotencyKey)
    const paymentPublicId = deterministicProviderId('AP', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.register',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        customerId: context.customerId,
        activityPublicId: input.activityPublicId,
        partySize: input.partySize,
        contactType: input.protectedContact.contactType,
        contactHash: input.protectedContact.contactHash,
        contactSource: input.protectedContact.source,
        termsAcknowledged: input.termsAcknowledged,
        acknowledgedSafetyPolicyVersion: input.acknowledgedSafetyPolicyVersion,
        acknowledgedRefundPolicyVersion: input.acknowledgedRefundPolicyVersion,
        paymentChoice: input.paymentChoice,
        paymentMethod: input.paymentMethod,
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
        paymentPublicId: string | null
      }>(),
    }, async (transaction) => {
      const registered = await new CustomerExperienceRepository(
        transaction,
        this.activityPaymentProviderConfigured,
      ).registerActivity({
        activityPublicId: input.activityPublicId,
        customerId: context.customerId,
        partySize: input.partySize,
        protectedContact: input.protectedContact,
        termsAcknowledged: input.termsAcknowledged,
        acknowledgedSafetyPolicyVersion: input.acknowledgedSafetyPolicyVersion,
        acknowledgedRefundPolicyVersion: input.acknowledgedRefundPolicyVersion,
        paymentChoice: input.paymentChoice,
        paymentMethod: input.paymentMethod,
        paymentPublicId,
        publicId: registrationPublicId,
        idempotencyKey: input.idempotencyKey,
      })
      const { id, ...result } = registered
      return commandOutcome(
        result,
        guestActor(context),
        'community.activity.registered',
        'community_activity_registration',
        id,
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
      const cancelled = await new CustomerExperienceRepository(transaction).cancelActivityRegistration({
        registrationPublicId: input.registrationPublicId,
        customerId: context.customerId,
        reason: input.reason,
      })
      const { id, ...result } = cancelled
      return commandOutcome(
        result,
        guestActor(context),
        'community.activity.registration.cancelled',
        'community_activity_registration',
        id,
        context.businessDate,
        { reason: input.reason },
      )
    })
  }

  productRestrictions(context: PublicCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).customerProductRestrictions(context.customerId)
    ), { readOnly: true })
  }

  withdrawProductRestriction(
    context: PublicCustomerExperienceContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.product-restriction.withdraw',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ customerId: context.customerId, ...input }),
      resultCodec: objectCodec<CustomerProductRestrictionView>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction)
        .withdrawCustomerProductRestriction({
          publicId: input.publicId,
          customerId: context.customerId,
          reason: input.reason,
        })
      return commandOutcome(
        result,
        guestActor(context),
        'customer.product-restriction.withdrawn',
        'customer_product_restriction',
        result.publicId,
        context.businessDate,
        { productId: result.productId, restrictionType: result.restrictionType },
      )
    })
  }

  performancePhases(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).currentPerformancePhaseEvents()
    ), { readOnly: true })
  }

  productPerformancePhases(context: StaffCustomerExperienceContext, productId: string) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).productPerformancePhases(productId)
    ), { readOnly: true })
  }

  configureProductPerformancePhases(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      productId: string
      phaseCodes: readonly PerformancePhaseCode[]
      reason: string
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'recommendation.product-performance-phases.configure',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ productId: string; phaseCodes: PerformancePhaseCode[] }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction)
        .configureProductPerformancePhases({
          productId: input.productId,
          phaseCodes: input.phaseCodes,
          employeeId: context.employeeId,
          reason: input.reason,
        })
      return commandOutcome(
        result,
        staffActor(context),
        'recommendation.product-performance-phases.configured',
        'product',
        result.productId,
        context.businessDate,
        { phaseCodes: result.phaseCodes, reason: input.reason },
      )
    })
  }

  startPerformancePhase(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      scheduleId: string
      phaseCode: PerformancePhaseCode
      reason: string
      idempotencyKey: string
    }>,
  ) {
    const publicId = deterministicPublicId(
      'performance-phase', context.scope.storeId, input.idempotencyKey,
    )
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'performance.phase.start',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<PerformancePhaseEventView>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).startPerformancePhase({
        publicId,
        scheduleId: input.scheduleId,
        phaseCode: input.phaseCode,
        employeeId: context.employeeId,
        reason: input.reason,
      })
      return commandOutcome(
        result,
        staffActor(context),
        'performance.phase.started',
        'schedule_performance_phase_event',
        result.publicId,
        context.businessDate,
        { scheduleId: result.scheduleId, phaseCode: result.phaseCode, reason: input.reason },
      )
    })
  }

  transitionPerformancePhase(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      publicId: string
      action: 'end' | 'cancel'
      reason: string
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: `performance.phase.${input.action}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<PerformancePhaseEventView>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).transitionPerformancePhase({
        publicId: input.publicId,
        action: input.action,
        employeeId: context.employeeId,
        reason: input.reason,
      })
      return commandOutcome(
        result,
        staffActor(context),
        `performance.phase.${input.action === 'end' ? 'ended' : 'cancelled'}`,
        'schedule_performance_phase_event',
        result.publicId,
        context.businessDate,
        { scheduleId: result.scheduleId, phaseCode: result.phaseCode, reason: input.reason },
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
      await assertBoundGuestTableMutation(transaction,context)
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

  recordRecommendationBehavior(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{
      recommendationPublicId: string
      eventType: 'exposed' | 'viewed' | 'selected' | 'ignored' | 'rejected'
      productId: string | null
      reasonCode: string | null
      evidence: JsonObject
      idempotencyKey: string
    }>,
  ) {
    const restrictionPublicId = deterministicPublicId(
      'product-restriction', context.scope.storeId, input.idempotencyKey,
    )
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.recommendation.behavior.record',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ context, ...input }),
      resultCodec: objectCodec<{
        recorded: true
        restriction: CustomerProductRestrictionView | null
      }>(),
    }, async (transaction) => {
      await assertBoundGuestTableMutation(transaction,context)
      const result = await new CustomerExperienceRepository(transaction).recordRecommendationBehavior({
        recommendationPublicId: input.recommendationPublicId,
        restrictionPublicId,
        customerId: context.customerId,
        tableSessionId: context.tableSessionId,
        eventType: input.eventType,
        productId: input.productId,
        actorRef: context.actorRef,
        reasonCode: input.reasonCode,
        evidence: input.evidence,
      })
      return commandOutcome(
        result,
        guestActor(context),
        'customer.experience.recommendation.behavior.recorded',
        'recommendation_session',
        input.recommendationPublicId,
        context.businessDate,
        { eventType: input.eventType, productId: input.productId },
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
  ): Promise<CommandExecution<ExperiencePlanIntentView>> {
    const publicId = deterministicPublicId('experience-intent', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.intent.select',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        context,
        recommendationPublicId: input.recommendationPublicId,
        selectedProductId: input.selectedProductId,
        promiseSummary: input.promiseSummary,
      }),
      resultCodec: objectCodec<ExperiencePlanIntentView>(),
    }, async (transaction) => {
      await assertBoundGuestTableMutation(transaction,context)
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
        'customer.experience.intent.selected',
        'recommendation_session',
        publicId,
        context.businessDate,
        {
          tableSessionId: context.tableSessionId,
          selectedProductId: input.selectedProductId,
          planCreated: false,
        },
      )
    })
  }

  plan(context: TableExperienceContext & { scope: Readonly<StoreScope> }): Promise<ExperiencePlanView | null> {
    return this.transactions.run(context.scope, async (transaction) => {
      await assertBoundGuestTableMutation(transaction,context)
      return new CustomerExperienceRepository(transaction).findPlanByTable(context.tableSessionId)
    })
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
      await assertBoundGuestTableMutation(transaction,context)
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

  recordCheckoutUpgradeOfferEvent(
    context: TableExperienceContext & { scope: Readonly<StoreScope> },
    input: Readonly<{
      publicId: string
      eventType: 'viewed' | 'declined'
      reasonCode: 'kept_original' | 'not_needed' | null
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.event',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({
        tableSessionId: context.tableSessionId,
        customerId: context.customerId,
        publicId: input.publicId,
        eventType: input.eventType,
        reasonCode: input.reasonCode,
      }),
      resultCodec: objectCodec<{
        publicId: string
        status: 'offered' | 'selected' | 'cancelled'
        eventType: 'viewed' | 'declined'
      }>(),
    }, async (transaction) => {
      await assertBoundGuestTableMutation(transaction,context)
      const value = await new CustomerExperienceRepository(transaction)
        .recordCheckoutUpgradeOfferEvent(context, input)
      return commandOutcome(
        value,
        guestActor(context),
        `customer.checkout.upgrade.${input.eventType}`,
        'checkout_upgrade_offer',
        input.publicId,
        context.businessDate,
        { eventType: input.eventType, status: value.status, reasonCode: input.reasonCode },
      )
    })
  }

  dashboard(context: StaffCustomerExperienceContext): Promise<JsonObject> {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).staffDashboard()
    ), { readOnly: true })
  }

  recommendationPolicyConfiguration(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).recommendationPolicyConfiguration()
    ), { readOnly: true })
  }

  supportContact(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CustomerExperienceRepository(transaction).staffSupportContact()
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
    if (input.featureCode === 'checkout_upgrade'
      && (input.rolloutState === 'pilot' || input.rolloutState === 'enabled')) {
      throw new CustomerExperienceRequestError(
        '付款前升级的本地交易与产能保护已完成；正式开关仍需通过门店产能配置、真实支付、岗位和营业现场验收，当前继续关闭且不影响原购物车结账',
        'CHECKOUT_UPGRADE_CAPACITY_NOT_READY',
        503,
      )
    }
    const configuration = input.featureCode === 'customer.support.contact'
      ? (input.rolloutState === 'disabled' && Object.keys(input.configuration).length === 0
        ? {} : supportContactConfiguration(input.configuration))
      : input.configuration
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.experience.feature.set',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, configuration }),
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
        JSON.stringify(configuration),
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
      minimumGrossMarginBasisPoints: number
      status: 'draft' | 'paused' | 'retired'
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
      if (input.status!=='draft') throw new CustomerExperienceRequestError(
        '规则停用和回滚必须通过版本发布流程，不能覆盖现有版本',
        'CHECKOUT_UPGRADE_RULE_IMMUTABLE',409,
      )
      const value = await new CheckoutUpgradeManagementRepository(transaction).insertRuleDraft({
        code:input.code,name:input.name,sourceProductId:input.sourceProductId,
        targetProductId:input.targetProductId,minimumPartySize:input.minimumPartySize,
        maximumPartySize:input.maximumPartySize,occasionTags:input.occasionTags,
        alcoholPreferenceTags:input.alcoholPreferenceTags,promptTitle:input.promptTitle,
        promptBody:input.promptBody,callToAction:input.callToAction,priority:input.priority,
        offerValidMinutes:input.offerValidMinutes,
        minimumGrossMarginBasisPoints:input.minimumGrossMarginBasisPoints,
        employeeId:context.employeeId,
      })
      return commandOutcome(
        value,
        staffActor(context),
        'customer.checkout.upgrade.rule.saved',
        'checkout_upgrade_rule',
        input.code,
        context.businessDate,
        {
          status: value.status,
          revision: value.revision,
          sourceProductId: input.sourceProductId,
          targetProductId: input.targetProductId,
        },
      )
    })
  }

  approveCheckoutUpgradeRule(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ code: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.checkout.upgrade.rule.approve',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ code: string; status: string; revision: number }>(),
    }, async (transaction) => {
      const approved = await transaction.query<{ code: string; status: string; revision: number }>(`
        WITH candidate AS (
          SELECT rule.id
          FROM mbox.checkout_upgrade_rules AS rule
          JOIN mbox.products AS source
            ON source.tenant_id=rule.tenant_id AND source.store_id=rule.store_id
           AND source.id=rule.source_product_id AND source.status='active'
          JOIN mbox.products AS target
            ON target.tenant_id=rule.tenant_id AND target.store_id=rule.store_id
           AND target.id=rule.target_product_id AND target.status='active'
           AND target.guest_visible=true AND target.product_kind='bundle'
           AND 'guest_qr'=ANY(target.allowed_channels)
          JOIN LATERAL (
            SELECT amount_minor FROM mbox.product_prices
            WHERE tenant_id=source.tenant_id AND store_id=source.store_id
              AND product_id=source.id AND price_type='standard'
              AND valid_from<=clock_timestamp()
              AND (valid_until IS NULL OR valid_until>clock_timestamp())
            ORDER BY valid_from DESC,id DESC LIMIT 1
          ) AS source_price ON true
          JOIN LATERAL (
            SELECT amount_minor FROM mbox.product_prices
            WHERE tenant_id=target.tenant_id AND store_id=target.store_id
              AND product_id=target.id AND price_type='standard'
              AND valid_from<=clock_timestamp()
              AND (valid_until IS NULL OR valid_until>clock_timestamp())
            ORDER BY valid_from DESC,id DESC LIMIT 1
          ) AS target_price ON true
          WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid
            AND rule.code=$3 AND rule.status='draft'
            AND rule.drafted_by_employee_id IS NOT NULL
            AND rule.drafted_by_employee_id<>$4::uuid
            AND target.cost_amount_minor IS NOT NULL
            AND target_price.amount_minor>source_price.amount_minor
            AND floor((target_price.amount_minor-target.cost_amount_minor)*10000.0/target_price.amount_minor)
              >= rule.minimum_gross_margin_basis_points
            AND EXISTS (
              SELECT 1 FROM mbox.product_bundle_components component
              WHERE component.tenant_id=rule.tenant_id AND component.store_id=rule.store_id
                AND component.bundle_product_id=rule.target_product_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM mbox.product_bundle_components component
              JOIN mbox.products component_product
                ON component_product.tenant_id=component.tenant_id
               AND component_product.store_id=component.store_id
               AND component_product.id=component.component_product_id
              WHERE component.tenant_id=rule.tenant_id AND component.store_id=rule.store_id
                AND component.bundle_product_id=rule.target_product_id
                AND (
                  component_product.status<>'active'
                  OR (
                    component_product.fulfillment_station IN ('bar','kitchen')
                    AND NOT EXISTS (
                      SELECT 1
                      FROM mbox.recipes recipe
                      JOIN mbox.recipe_items recipe_item
                        ON recipe_item.tenant_id=recipe.tenant_id
                       AND recipe_item.store_id=recipe.store_id
                       AND recipe_item.recipe_id=recipe.id
                      JOIN mbox.inventory_items inventory
                        ON inventory.tenant_id=recipe_item.tenant_id
                       AND inventory.store_id=recipe_item.store_id
                       AND inventory.id=recipe_item.inventory_item_id
                       AND inventory.status='active'
                      WHERE recipe.tenant_id=component.tenant_id
                        AND recipe.store_id=component.store_id
                        AND recipe.product_id=component.component_product_id
                        AND recipe.status='active'
                    )
                  )
                )
            )
          ORDER BY rule.revision DESC,rule.id
          LIMIT 1
          FOR UPDATE OF rule, source, target
        )
        UPDATE mbox.checkout_upgrade_rules AS rule
        SET status='approved', approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(), approval_reason=$5, updated_at=clock_timestamp()
        FROM candidate
        WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid
          AND rule.id=candidate.id
        RETURNING rule.code, rule.status, rule.revision
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.code,
        context.employeeId,
        input.reason,
      ])
      const value = approved.rows[0]
      if (!value) {
        throw new CustomerExperienceRequestError(
          '规则必须由另一名授权人员复核，且商品、价格、毛利、套餐组件和配方均须有效',
          'CHECKOUT_UPGRADE_RULE_NOT_READY',
          409,
        )
      }
      return commandOutcome(
        value,
        staffActor(context),
        'customer.checkout.upgrade.rule.approved',
        'checkout_upgrade_rule',
        input.code,
        context.businessDate,
        { revision: value.revision, reason: input.reason },
      )
    })
  }

  checkoutUpgradeRules(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CheckoutUpgradeManagementRepository(transaction).listRules()
    ), { readOnly:true })
  }

  checkoutUpgradeOutcomes(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CheckoutUpgradeManagementRepository(transaction).listOutcomes()
    ), { readOnly:true })
  }

  publishCheckoutUpgradeRule(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ ruleId:string; reason:string; idempotencyKey:string }>,
  ) {
    return this.commands.execute({
      scope:context.scope,operationScope:'customer.checkout.upgrade.rule.publish',
      idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint(input),
      resultCodec:objectCodec<{ id:string; code:string; revision:number; status:string }>(),
    }, async (transaction) => {
      const value = await new CheckoutUpgradeManagementRepository(transaction)
        .publishRule(input.ruleId,context.employeeId,input.reason)
      return commandOutcome(value,staffActor(context),'customer.checkout.upgrade.rule.published',
        'checkout_upgrade_rule',value.id,context.businessDate,
        { code:value.code,revision:value.revision,status:value.status,reason:input.reason })
    })
  }

  rollbackCheckoutUpgradeRule(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ ruleId:string; reason:string; idempotencyKey:string }>,
  ) {
    return this.commands.execute({
      scope:context.scope,operationScope:'customer.checkout.upgrade.rule.rollback-draft',
      idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint(input),
      resultCodec:objectCodec<{ id:string; code:string; revision:number; status:string }>(),
    }, async (transaction) => {
      const value = await new CheckoutUpgradeManagementRepository(transaction)
        .cloneRuleForRollback(input.ruleId,context.employeeId)
      return commandOutcome(value,staffActor(context),'customer.checkout.upgrade.rule.rollback-drafted',
        'checkout_upgrade_rule',value.id,context.businessDate,
        { sourceRuleId:input.ruleId,code:value.code,revision:value.revision,reason:input.reason })
    })
  }

  fulfillmentCapacityPolicies(context: StaffCustomerExperienceContext) {
    return this.transactions.run(context.scope, (transaction) => (
      new CheckoutUpgradeManagementRepository(transaction).listCapacityPolicies()
    ), { readOnly:true })
  }

  draftFulfillmentCapacity(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      stationCode:'bar'|'kitchen'|'cashier'
      reason:string
      windows:Array<{ startsAt:string; endsAt:string; capacityLimitUnits:number }>
      idempotencyKey:string
    }>,
  ) {
    return this.commands.execute({
      scope:context.scope,operationScope:'fulfillment.capacity.draft',
      idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint(input),
      resultCodec:objectCodec<{ id:string; stationCode:string; policyVersion:number; status:string }>(),
    }, async (transaction) => {
      const value = await new CheckoutUpgradeManagementRepository(transaction).draftCapacity({
        stationCode:input.stationCode,reason:input.reason,windows:input.windows,
        employeeId:context.employeeId,
      })
      return commandOutcome(value,staffActor(context),'fulfillment.capacity.drafted',
        'fulfillment_capacity_policy',value.id,context.businessDate,
        { stationCode:value.stationCode,policyVersion:value.policyVersion,windowCount:value.windows.length,reason:input.reason })
    })
  }

  transitionFulfillmentCapacity(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      policyId:string
      action:'approve'|'publish'
      reason:string
      idempotencyKey:string
    }>,
  ) {
    return this.commands.execute({
      scope:context.scope,operationScope:`fulfillment.capacity.${input.action}`,
      idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint(input),
      resultCodec:objectCodec<{ id:string; stationCode:string; policyVersion:number; status:string }>(),
    }, async (transaction) => {
      const repository = new CheckoutUpgradeManagementRepository(transaction)
      const value = input.action==='approve'
        ? await repository.approveCapacity(input.policyId,context.employeeId)
        : await repository.publishCapacity(input.policyId,context.employeeId)
      return commandOutcome(value,staffActor(context),`fulfillment.capacity.${input.action}d`,
        'fulfillment_capacity_policy',value.id,context.businessDate,
        { stationCode:value.stationCode,policyVersion:value.policyVersion,status:value.status,reason:input.reason })
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
      visibility: 'public' | 'member' | 'segment'
      audienceRule: JsonObject
      safetySnapshot: JsonObject
      salesCopy: JsonObject
      idempotencyKey: string
    }>,
  ) {
    validateActivityPaymentConfiguration(input)
    const audienceRule = normalizeActivityAudienceRule(input.visibility, input.audienceRule)
    const audienceMemberLevels = input.visibility === 'segment'
      ? audienceRule.memberLevels as string[]
      : []
    const publication = normalizeActivityPublicationFields(
      input.safetySnapshot,
      input.refundPolicySnapshot,
      input.salesCopy,
    )
    const publicId = deterministicPublicId('community-activity', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'community.activity.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint({ ...input, audienceRule }),
      resultCodec: objectCodec<{ publicId: string; status: 'draft' }>(),
    }, async (transaction) => {
      const result = await transaction.query<{ public_id: string; status: 'draft' }>(`
        INSERT INTO mbox.community_activities (
          tenant_id, store_id, public_id, activity_kind, title, summary,
          cover_url, starts_at, ends_at, assembly_location, capacity,
          fee_amount_minor, deposit_amount_minor, fee_basis, registration_payment_mode,
          payment_deadline_minutes, payment_rule_text, refund_policy_snapshot,
          points_reward, visibility, audience_member_levels,
          audience_lifecycle_stages, safety_snapshot, sales_copy,
          safety_policy_version, safety_acknowledgement_text, safety_requirements,
          refund_policy_version, refund_policy_summary, activity_details,
          included_items, participation_requirements, contact_instructions,
          member_benefit_text,
          status, created_by_employee_id
        ) VALUES (
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz,
          $9::timestamptz, $10, $11, $12::bigint, $13::bigint, $14, $15,
          $16, $17, $18::jsonb, $19, $20, $21::text[], '{}'::text[], $22::jsonb,
          $23::jsonb, $24, $25, $26::text[], $27, $28, $29,
          $30::text[], $31::text[], $32, $33,
          'draft', $34::uuid
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
        audienceMemberLevels,
        JSON.stringify(input.safetySnapshot),
        JSON.stringify(input.salesCopy),
        publication.safetyPolicyVersion,
        publication.safetyAcknowledgementText,
        publication.safetyRequirements,
        publication.refundPolicyVersion,
        publication.refundPolicySummary,
        publication.activityDetails,
        publication.includedItems,
        publication.participationRequirements,
        publication.contactInstructions,
        publication.memberBenefitText,
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
          AND safety_policy_version IS NOT NULL
          AND safety_acknowledgement_text IS NOT NULL
          AND cardinality(safety_requirements) > 0
          AND refund_policy_version IS NOT NULL
          AND refund_policy_summary IS NOT NULL
          AND activity_details IS NOT NULL
          AND contact_instructions IS NOT NULL
          AND (
            (fee_amount_minor = 0 AND deposit_amount_minor = 0 AND registration_payment_mode = 'none')
            OR (
              $5::boolean
              AND EXISTS (
                SELECT 1 FROM mbox.store_commerce_policies policy
                WHERE policy.tenant_id=community_activities.tenant_id
                  AND policy.store_id=community_activities.store_id
                  AND policy.online_payment_enabled
              )
              AND EXISTS (
                SELECT 1 FROM mbox.customer_experience_features feature
                WHERE feature.tenant_id=community_activities.tenant_id
                  AND feature.store_id=community_activities.store_id
                  AND feature.feature_code='community.activity.payment'
                  AND feature.rollout_state IN ('pilot','enabled')
                  AND (feature.effective_from IS NULL OR feature.effective_from <= clock_timestamp())
                  AND (feature.effective_until IS NULL OR feature.effective_until > clock_timestamp())
              )
            )
          )
        RETURNING public_id, status
      `, [
        transaction.scope.tenantId,
        transaction.scope.storeId,
        input.publicId,
        context.employeeId,
        this.activityPaymentProviderConfigured,
      ])
      const row = result.rows[0]
      if (!row) throw new CustomerExperienceRequestError(
        '活动必须由另一位授权人员审批，详情、退款和安全规则必须完整；收费活动需先完成权威活动支付接入',
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
      let adjusted
      try {
        adjusted = await new LoyaltyAccrualRepository(transaction).adjustPoints({
          ...input,
          employeeId: context.employeeId,
          occurredAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof LoyaltyPositiveAccrualPausedError) {
          throw new CustomerExperienceRequestError(
            '新积分发放已由最高管理人员暂停，本次正向调整未执行',
            'LOYALTY_POINTS_ACCRUAL_PAUSED',
            409,
          )
        }
        if (error instanceof RangeError) throw new CustomerExperienceRequestError(
          '积分余额不足', 'POINTS_BALANCE_INSUFFICIENT', 409,
        )
        if (error instanceof Error && error.message === 'Active loyalty account was not found') {
          throw new CustomerExperienceRequestError('客户尚未成为会员', 'MEMBERSHIP_REQUIRED', 409)
        }
        throw error
      }
      const output = { customerId: input.customerId, balance: adjusted.balance, delta: adjusted.delta }
      return commandOutcome(
        output,
        staffActor(context),
        'loyalty.points.adjusted',
        'loyalty_point_ledger',
        adjusted.ledgerEntryId,
        context.businessDate,
        { balance: adjusted.balance, delta: adjusted.delta, reason: input.reason },
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

  parseObservation(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      tableSessionId: string
      rawContent: string
      inputKind: ObservationInputKind
      needsImmediateAction: boolean
      idempotencyKey: string
    }>,
  ): Promise<CommandExecution<ObservationDraftView>> {
    const publicId = deterministicPublicId('observation', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.observation.parse',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<ObservationDraftView>(),
    }, async (transaction) => {
      const access = await new StaffAccessRepository(transaction)
        .assertPermission(context.employeeId, 'observation.record')
      const result = await new CustomerExperienceObservationRepository(transaction).parse({
        ...input,
        publicId,
        employeeId: context.employeeId,
        allowAllTables: access.permissions.includes('observation.record.all'),
      })
      return commandOutcome(
        result,
        staffActor(context),
        'customer.observation.parsed',
        'observation_input',
        publicId,
        context.businessDate,
        {
          tableSessionId: input.tableSessionId,
          inputKind: input.inputKind,
          needsImmediateAction: input.needsImmediateAction,
          candidateCount: result.candidates.length,
          parseConfidence: result.parseConfidence,
        },
      )
    })
  }

  recentObservations(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ tableSessionId: string; limit: number }>,
  ): Promise<{
    items: ObservationHistoryView[]
    permissions: { canCorrect: boolean; canViewRaw: boolean }
  }> {
    return this.transactions.run(context.scope, async (transaction) => {
      const access = await new StaffAccessRepository(transaction)
        .assertPermission(context.employeeId, 'observation.record')
      const canCorrect = access.permissions.includes('observation.correct')
      const canViewRaw = access.permissions.includes('observation.view.raw')
      const items = await new CustomerExperienceObservationRepository(transaction).recent({
        tableSessionId: input.tableSessionId,
        employeeId: context.employeeId,
        allowAllTables: access.permissions.includes('observation.record.all'),
        includeRaw: canViewRaw,
        limit: input.limit,
      })
      return { items, permissions: { canCorrect, canViewRaw } }
    }, { readOnly: true })
  }

  confirmObservation(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; events: readonly ObservationEventInput[]; idempotencyKey: string }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.observation.confirm',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: 'confirmed'; events: JsonObject[]; serviceTaskId: string | null }>(),
    }, async (transaction) => {
      const access = await new StaffAccessRepository(transaction)
        .assertPermission(context.employeeId, 'observation.confirm')
      const result = await new CustomerExperienceObservationRepository(transaction).confirm({
        publicId: input.publicId,
        employeeId: context.employeeId,
        allowAllTables: access.permissions.includes('observation.record.all'),
        events: input.events,
      })
      return commandOutcome(
        result,
        staffActor(context),
        'customer.observation.confirmed',
        'observation_input',
        input.publicId,
        context.businessDate,
        { eventCount: result.events.length, serviceTaskId: result.serviceTaskId },
      )
    })
  }

  reviseObservation(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      publicId: string
      previousEventId: string
      reason: string
      replacement: ObservationEventInput
      idempotencyKey: string
    }>,
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.observation.revise',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<JsonObject>(),
    }, async (transaction) => {
      const access = await new StaffAccessRepository(transaction)
        .assertPermission(context.employeeId, 'observation.correct')
      const result = await new CustomerExperienceObservationRepository(transaction).revise({
        publicId: input.publicId,
        previousEventId: input.previousEventId,
        employeeId: context.employeeId,
        allowAllTables: access.permissions.includes('observation.record.all'),
        reason: input.reason,
        replacement: input.replacement,
      })
      return commandOutcome(
        result,
        staffActor(context),
        'customer.observation.revised',
        'observation_input',
        input.publicId,
        context.businessDate,
        { previousEventId: input.previousEventId, reason: input.reason },
      )
    })
  }

  createRecommendationPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{
      code: string
      preferenceWeight: number
      sceneWeight: number
      marginWeight: number
      priorityWeight: number
      performanceWeight: number
      inventoryWeight: number
      capacityWeight: number
      minimumGrossMarginBasisPoints: number
      preferenceHalfLifeDays: number
      preferenceMaxAgeDays: number
      preferenceMinEffectiveScore: number
      preferenceMinConfidenceBasisPoints: number
      explanationTemplate: string
      displayConfiguration: JsonObject
      draftReason: string
      idempotencyKey: string
    }>,
  ) {
    const publicId = deterministicPublicId('recommendation-policy', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.recommendation.policy.create',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; code: string; version: number; status: 'draft' }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).createRecommendationPolicy({
        ...input,
        publicId,
        employeeId: context.employeeId,
      })
      return commandOutcome(
        result,
        staffActor(context),
        'customer.recommendation.policy.created',
        'recommendation_policy_version',
        publicId,
        context.businessDate,
        { code: input.code, version: result.version },
      )
    })
  }

  cloneRecommendationPolicyDraft(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ sourcePublicId: string; draftReason: string; idempotencyKey: string }>,
  ) {
    const publicId = deterministicPublicId('recommendation-policy-clone', context.scope.storeId, input.idempotencyKey)
    return this.commands.execute({
      scope: context.scope,
      operationScope: 'customer.recommendation.policy.clone',
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; code: string; version: number; status: 'draft' }>(),
    }, async (transaction) => {
      const result = await new CustomerExperienceRepository(transaction).cloneRecommendationPolicyDraft({
        sourcePublicId: input.sourcePublicId,
        publicId,
        employeeId: context.employeeId,
        draftReason: input.draftReason,
      })
      return commandOutcome(
        result,
        staffActor(context),
        'customer.recommendation.policy.cloned',
        'recommendation_policy_version',
        publicId,
        context.businessDate,
        { sourcePublicId: input.sourcePublicId, code: result.code, version: result.version },
      )
    })
  }

  approveRecommendationPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.recommendationPolicyTransition(context, input, 'approve')
  }

  publishRecommendationPolicy(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; effectiveFrom: string; reason: string; idempotencyKey: string }>,
  ) {
    return this.recommendationPolicyTransition(context, input, 'publish')
  }

  private recommendationPolicyTransition(
    context: StaffCustomerExperienceContext,
    input: Readonly<{ publicId: string; reason: string; effectiveFrom?: string; idempotencyKey: string }>,
    transition: 'approve' | 'publish',
  ) {
    return this.commands.execute({
      scope: context.scope,
      operationScope: `customer.recommendation.policy.${transition}`,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint(input),
      resultCodec: objectCodec<{ publicId: string; status: 'approved' | 'published'; effectiveFrom?: string }>(),
    }, async (transaction) => {
      const repository = new CustomerExperienceRepository(transaction)
      if (transition === 'publish' && input.effectiveFrom === undefined) {
        throw new CustomerExperienceRequestError(
          '推荐规则发布必须提供生效时间', 'RECOMMENDATION_POLICY_EFFECTIVE_TIME_REQUIRED', 409,
        )
      }
      const result = transition === 'approve'
        ? await repository.approveRecommendationPolicy(input.publicId, context.employeeId, input.reason)
        : await repository.publishRecommendationPolicy({
          publicId: input.publicId,
          employeeId: context.employeeId,
          effectiveFrom: input.effectiveFrom as string,
          reason: input.reason,
        })
      return commandOutcome(
        result,
        staffActor(context),
        `customer.recommendation.policy.${transition}d`,
        'recommendation_policy_version',
        input.publicId,
        context.businessDate,
        { status: result.status, reason: input.reason, effectiveFrom: input.effectiveFrom ?? null },
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
    WHERE session.tenant_id = $1::uuid AND session.store_id = $2::uuid
      AND session.id = $3::uuid AND session.status = 'open'
      AND EXISTS (
        SELECT 1 FROM mbox.table_session_customer_participations participation
        WHERE participation.tenant_id=session.tenant_id AND participation.store_id=session.store_id
          AND participation.table_session_id=session.id AND participation.table_id=session.table_id
          AND participation.left_at IS NULL
          AND mbox.canonical_customer_id(
            participation.tenant_id,participation.store_id,participation.customer_id
          )=mbox.canonical_customer_id(session.tenant_id,session.store_id,$4::uuid)
      )
  `, [transaction.scope.tenantId, transaction.scope.storeId, input.tableSessionId,input.customerId])
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

async function assertBoundGuestTableMutation(
  transaction: ScopedTransaction,
  context: Pick<TableExperienceContext,'tableSessionId'|'customerId'|'actorRef'>,
): Promise<void> {
  const session=await transaction.query<{ id:string }>(`
    SELECT id FROM mbox.table_sessions
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open'
    FOR UPDATE
  `,[transaction.scope.tenantId,transaction.scope.storeId,context.tableSessionId])
  if (!session.rows[0]) throw new CustomerExperienceRequestError(
    '当前桌次位置已经变化，请重新扫描所在桌二维码','TABLE_CUSTOMER_MISMATCH',403,
  )
  if (!await lockBoundGuestTablePosition(transaction,context)) {
    throw new CustomerExperienceRequestError(
      '当前桌次位置已经变化，请重新扫描所在桌二维码','TABLE_CUSTOMER_MISMATCH',403,
    )
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

function mapRedemptionError(error: unknown): never {
  if (error instanceof LoyaltyRedemptionError) {
    throw new CustomerExperienceRequestError(error.message, error.code, error.statusCode)
  }
  throw error
}

function assertReleaseWindow(effectiveFrom: string, effectiveUntil: string | null): void {
  const startsAt = Date.parse(effectiveFrom)
  const endsAt = effectiveUntil === null ? null : Date.parse(effectiveUntil)
  if (!Number.isFinite(startsAt) || (endsAt !== null && (!Number.isFinite(endsAt) || endsAt <= startsAt))) {
    throw new CustomerExperienceRequestError('规则生效区间不正确', 'LOYALTY_POLICY_RELEASE_WINDOW_INVALID', 409)
  }
}

function assertAppendOnlyRelease(
  previous: Readonly<{ effective_from: string; effective_until: string | null }> | undefined,
  effectiveFrom: string,
  label: string,
): void {
  if (!previous) return
  const nextStartsAt = Date.parse(effectiveFrom)
  if (nextStartsAt <= Date.parse(previous.effective_from)) throw new CustomerExperienceRequestError(
    `${label}只能在最后一个已发布版本之后排期`, 'LOYALTY_POLICY_RELEASE_ORDER_INVALID', 409,
  )
  if (previous.effective_until !== null && Date.parse(previous.effective_until) < nextStartsAt) {
    throw new CustomerExperienceRequestError(
      `${label}发布会造成生效时间空档`, 'LOYALTY_POLICY_RELEASE_GAP', 409,
    )
  }
}

async function validateRedemptionCatalog(transaction: ScopedTransaction, catalogId: string) {
  const validation = requiredRow((await transaction.query<{ item_count: number; invalid_count: number }>(`
    SELECT count(item.id)::integer AS item_count,
      count(item.id) FILTER (WHERE
        (item.fulfillment_kind='product' AND NOT EXISTS (
          SELECT 1 FROM mbox.products product
          WHERE product.tenant_id=item.tenant_id AND product.store_id=item.store_id
            AND product.id=item.product_id AND product.status='active'
            AND product.cost_amount_minor=item.cost_amount_minor
        ))
        OR (item.fulfillment_kind='benefit' AND NOT EXISTS (
          SELECT 1 FROM mbox.loyalty_benefit_definitions definition
          WHERE definition.tenant_id=item.tenant_id AND definition.store_id=item.store_id
            AND definition.id=item.benefit_definition_id AND definition.status='active'
            AND definition.cost_amount_minor=item.cost_amount_minor
        ))
        OR (item.fulfillment_kind='activity' AND NOT EXISTS (
          SELECT 1 FROM mbox.community_activities activity
          WHERE activity.tenant_id=item.tenant_id AND activity.store_id=item.store_id
            AND activity.id=item.activity_id AND activity.status='published'
        ))
      )::integer AS invalid_count
    FROM mbox.redemption_catalog_items item
    WHERE item.tenant_id=$1::uuid AND item.store_id=$2::uuid AND item.catalog_version_id=$3::uuid
  `, [transaction.scope.tenantId, transaction.scope.storeId, catalogId])).rows[0], 'Redemption catalog validation')
  if (validation.item_count<1) throw new CustomerExperienceRequestError(
    '兑换目录至少需要一个兑换项', 'LOYALTY_REDEMPTION_CATALOG_EMPTY', 409,
  )
  if (validation.invalid_count>0) throw new CustomerExperienceRequestError(
    '兑换项商品、活动、权益定义或真实成本已变化，请建立新草稿复核',
    'LOYALTY_REDEMPTION_CATALOG_STALE', 409,
  )
  return validation
}

function assertTierPolicy(input: Readonly<{
  evaluationWindowMonths: number; tierPeriodMonths: number; downgradeGraceDays: number
  silverUpgradeGrowth: number; silverRetainGrowth: number
  goldUpgradeGrowth: number; goldRetainGrowth: number
  silverPointsMultiplierNumerator: number; silverPointsMultiplierDenominator: number
  goldPointsMultiplierNumerator: number; goldPointsMultiplierDenominator: number
}>): void {
  if (input.silverRetainGrowth > input.silverUpgradeGrowth
    || input.goldRetainGrowth > input.goldUpgradeGrowth
    || input.goldUpgradeGrowth <= input.silverUpgradeGrowth
    || input.goldRetainGrowth < input.silverRetainGrowth) {
    throw new CustomerExperienceRequestError('等级升级与保级门槛关系不正确', 'LOYALTY_TIER_POLICY_INVALID')
  }
  if (input.silverPointsMultiplierNumerator / input.silverPointsMultiplierDenominator < 1
    || input.goldPointsMultiplierNumerator / input.goldPointsMultiplierDenominator
      < input.silverPointsMultiplierNumerator / input.silverPointsMultiplierDenominator) {
    throw new CustomerExperienceRequestError('等级积分倍率必须从普通到银卡、金卡逐级不降低', 'LOYALTY_TIER_POLICY_INVALID')
  }
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

function normalizeActivityPublicationFields(
  safety: JsonObject,
  refund: JsonObject,
  sales: JsonObject,
) {
  return {
    safetyPolicyVersion: requiredActivityText(safety.policyVersion, '安全规则版本', 1, 64),
    safetyAcknowledgementText: requiredActivityText(safety.acknowledgementText, '安全确认文案', 2, 1000),
    safetyRequirements: requiredActivityTextArray(safety.requirements, '安全参与要求', 1, 50),
    refundPolicyVersion: requiredActivityText(refund.policyVersion, '退款规则版本', 3, 64),
    refundPolicySummary: requiredActivityText(refund.summary, '退款规则说明', 2, 500),
    activityDetails: requiredActivityText(sales.details, '活动详情', 10, 4000),
    includedItems: requiredActivityTextArray(sales.includedItems, '包含内容', 0, 100),
    participationRequirements: requiredActivityTextArray(sales.participationRequirements, '参与条件', 0, 100),
    contactInstructions: requiredActivityText(sales.contactInstructions, '联系说明', 2, 1200),
    memberBenefitText: optionalActivityText(sales.memberBenefitText, '会员权益说明', 1000),
  }
}

function requiredActivityText(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new CustomerExperienceRequestError(`${label}必须填写`, 'ACTIVITY_PUBLICATION_FIELDS_INVALID')
  }
  const normalized = value.trim()
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new CustomerExperienceRequestError(`${label}长度不符合要求`, 'ACTIVITY_PUBLICATION_FIELDS_INVALID')
  }
  return normalized
}

function optionalActivityText(value: unknown, label: string, maximumLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return requiredActivityText(value, label, 1, maximumLength)
}

function requiredActivityTextArray(
  value: unknown,
  label: string,
  minimumItems: number,
  maximumItems: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new CustomerExperienceRequestError(`${label}数量不符合要求`, 'ACTIVITY_PUBLICATION_FIELDS_INVALID')
  }
  const normalized = value.map((item) => requiredActivityText(item, label, 1, 500))
  return [...new Set(normalized)]
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

// New activity promises follow the approved loyalty tier family. Historical
// black-segment activities remain readable, but no new draft may create or
// republish that unapproved tier contract.
const ACTIVITY_MEMBER_LEVELS = new Set(['member', 'silver', 'gold'])

export function normalizeActivityAudienceRule(
  visibility: 'public' | 'member' | 'segment',
  rule: JsonObject,
): JsonObject {
  if (Object.keys(rule).some((key) => key !== 'memberLevels')) {
    throw new CustomerExperienceRequestError('活动客群规则包含未支持字段', 'ACTIVITY_AUDIENCE_RULE_INVALID')
  }
  if (visibility !== 'segment') {
    if (Object.keys(rule).length > 0) {
      throw new CustomerExperienceRequestError('公开或全体会员活动不能附带分群条件', 'ACTIVITY_AUDIENCE_RULE_INVALID')
    }
    return {}
  }
  const source = rule.memberLevels
  if (!Array.isArray(source) || source.length === 0 || source.some((item) => (
    typeof item !== 'string' || !ACTIVITY_MEMBER_LEVELS.has(item)
  ))) {
    throw new CustomerExperienceRequestError('指定会员等级必须从已支持等级中选择', 'ACTIVITY_AUDIENCE_RULE_INVALID')
  }
  return { memberLevels: [...new Set(source)] }
}

function deterministicPublicId(kind: string, storeId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${kind}:${storeId}:${idempotencyKey}`).digest('hex').slice(0, 24)
  return `${kind}-${digest}`
}

function deterministicProviderId(prefix: string, storeId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${prefix}:${storeId}:${idempotencyKey}`).digest('hex').slice(0, 32)
  return `${prefix}${digest}`
}

function supportContactConfiguration(value: JsonObject): JsonObject {
  const allowed = new Set(['phone', 'phoneLabel', 'wecomName', 'wecomQrImageUrl'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CustomerExperienceRequestError(
      '门店联系配置只支持电话、电话名称、企业微信名称和企业微信二维码',
      'SUPPORT_CONTACT_CONFIGURATION_INVALID',
    )
  }
  const phone = supportText(value.phone, '门店联系电话', 6, 31)
  if (!/^[+0-9][0-9 -]{5,30}$/.test(phone)) {
    throw new CustomerExperienceRequestError('门店联系电话格式不正确', 'SUPPORT_CONTACT_CONFIGURATION_INVALID')
  }
  const phoneLabel = supportText(value.phoneLabel, '电话名称', 2, 40)
  const wecomName = supportText(value.wecomName, '企业微信名称', 2, 40)
  const qr = value.wecomQrImageUrl === null || value.wecomQrImageUrl === undefined || value.wecomQrImageUrl === ''
    ? null : supportText(value.wecomQrImageUrl, '企业微信二维码地址', 1, 1000)
  if (qr !== null && !isPublicMediaAssetUrl(qr)) {
    throw new CustomerExperienceRequestError('企业微信二维码必须从站内图片库选择，单张不超过200KB', 'SUPPORT_CONTACT_CONFIGURATION_INVALID')
  }
  return { phone, phoneLabel, wecomName, wecomQrImageUrl: qr }
}

function supportText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new CustomerExperienceRequestError(`${label}格式不正确`, 'SUPPORT_CONTACT_CONFIGURATION_INVALID')
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) {
    throw new CustomerExperienceRequestError(`${label}长度不正确`, 'SUPPORT_CONTACT_CONFIGURATION_INVALID')
  }
  return normalized
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
