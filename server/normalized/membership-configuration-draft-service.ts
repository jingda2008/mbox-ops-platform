import { createHash, randomUUID } from 'node:crypto'

export type MembershipConfigurationDomain =
  | 'base_points'
  | 'tier_policy'
  | 'tier_benefits'
  | 'redemption_catalog'
  | 'promotion_points'
  | 'membership_terms'
  | 'wechat_notifications'
export type MembershipTier = 'member' | 'silver' | 'gold'
export type PromotionTriggerKind = 'activity_payment' | 'activity_check_in' | 'activity_completion'

export type MembershipConfigurationContent =
  | Readonly<{
      domain: 'base_points'
      pointsNumerator: number
      pointsDenominatorMinor: number
      growthNumerator: number
      growthDenominatorMinor: number
      roundingMode: 'floor' | 'nearest'
      pointsValidityMonths: number
    }>
  | Readonly<{
      domain: 'tier_policy'
      evaluationWindowMonths: number
      tierPeriodMonths: number
      downgradeGraceDays: number
      silverUpgradeGrowth: number
      silverRetainGrowth: number
      goldUpgradeGrowth: number
      goldRetainGrowth: number
      silverPointsMultiplierNumerator: number
      silverPointsMultiplierDenominator: number
      goldPointsMultiplierNumerator: number
      goldPointsMultiplierDenominator: number
    }>
  | Readonly<{
      domain: 'tier_benefits'
      tierPolicyVersionId: string
      rules: readonly Readonly<{
        ruleCode: string
        eligibleTier: MembershipTier
        inheritToHigherTiers: boolean
        grantOnEntry: boolean
        grantOnRetention: boolean
        benefitDefinitionId: string
        quantity: number
        validityDays: number
        revocationPolicy: 'revoke_unreserved' | 'protect_until_expiry'
        enabled: boolean
      }>[]
    }>
  | Readonly<{
      domain: 'redemption_catalog'
      items: readonly Readonly<{
        publicId: string
        itemCode: string
        name: string
        fulfillmentKind: 'product' | 'benefit' | 'activity' | 'service'
        productId: string | null
        benefitDefinitionId: string | null
        activityId: string | null
        pointsRequired: number
        costAmountMinor: number
        currency: string
        totalInventory: number | null
        dailyInventory: number | null
        memberDailyLimit: number
        memberRolling30DayLimit: number
        memberLifetimeLimit: number | null
        minimumTier: MembershipTier
        requiresTableSession: boolean
        requiresEmployeeFulfillment: boolean
        cancellationAllowedBeforeFulfillment: boolean
        restoreExpiredPointsDays: number
        availableFrom: string
        availableUntil: string | null
        fulfillmentTimeoutMinutes: number
        status: 'active' | 'paused' | 'retired'
      }>[]
    }>
  | Readonly<{
      domain: 'promotion_points'
      campaignCode: string
      name: string
      activityId: string
      stackingGroup: string
      stackingMode: 'stackable' | 'exclusive_highest' | 'exclusive_first'
      priority: number
      storeBudgetPoints: number
      perMemberPointsLimit: number
      pointValidityDays: number
      refundPolicy: 'reverse_on_any_refund' | 'reverse_on_full_refund'
      budgetReuseAfterRefund: boolean
      memberLimitReuseAfterRefund: boolean
      eligibleMemberLevels: readonly MembershipTier[]
      rules: readonly Readonly<{
        ruleCode: string
        triggerKind: PromotionTriggerKind
        points: number
        perMemberAwardLimit: number
        minimumPaidAmountMinor: number
        enabled: boolean
      }>[]
    }>
  | Readonly<{
      domain: 'membership_terms'
      title: string
      summary: string
      content: string
    }>
  | Readonly<{
      domain: 'wechat_notifications'
      notificationType: 'loyalty_points_credited' | 'loyalty_points_reversed' | 'loyalty_points_expiring'
      authorizationPurpose: 'loyalty_balance_change' | 'loyalty_expiry_reminder'
      authorizationContext: 'loyalty_accrual' | 'loyalty_refund' | 'loyalty_expiry'
      templateId: string
      pagePath: string
      pointsDataKey: string
      balanceDataKey: string | null
      occurredAtDataKey: string
      expiresAtDataKey: string | null
      expiryLeadDays: number | null
      maxPerCustomerPer24h: number
      minimumIntervalMinutes: number
      quietHoursStart: string | null
      quietHoursEnd: string | null
    }>

export interface MembershipConfigurationDraftRecord {
  publicId: string
  domain: MembershipConfigurationDomain
  status: 'draft' | 'approved' | 'published' | 'paused' | 'retired'
  revision: number
  makerEmployeeIds: readonly string[]
  content: MembershipConfigurationContent
  updatedAt: string
}

export interface MembershipImpactSnapshot {
  sourceVersion: string
  measuredAt: string
  activeMembers: number
  membersByTier: Readonly<Record<MembershipTier, number>>
  availablePointsLiability: number
  eligiblePaidAmountMinor: number
  expectedTierEntries: Readonly<Record<MembershipTier, number>>
  expectedTierRetentions: Readonly<Record<MembershipTier, number>>
  growthBucketsByTier: Readonly<Record<MembershipTier,
    readonly Readonly<{
      minimumGrowth: number
      maximumGrowth: number | null
      members: number
      eligibleBasePoints: number
    }>[]> >
  pointCostMicrosPerPoint: number
  benefitFacts: readonly Readonly<{
    benefitDefinitionId: string
    unitCostAmountMinor: number
    availableInventory: number | null
    reservedInventory: number
    requiresEmployeeFulfillment: boolean
    openFulfillmentTasks: number
  }>[]
  redemptionDemand: readonly Readonly<{
    itemCode: string
    expectedRequests: number
    currentlyReservedTotal: number
    currentlyReservedToday: number
    openFulfillmentTasks: number
  }>[]
  promotionTriggerParticipants: readonly Readonly<{
    triggerKind: PromotionTriggerKind
    eligibleMembers: number
    expectedTriggerFacts: number
  }>[]
  notificationFacts: readonly Readonly<{
    notificationType: 'loyalty_points_credited' | 'loyalty_points_reversed' | 'loyalty_points_expiring'
    activeAuthorizations: number
    expectedMessagesPer24h: number
  }>[]
  currentTermsAcceptances: number
}

export interface MembershipConfigurationImpactPreview {
  publicId: string
  draftPublicId: string
  domain: MembershipConfigurationDomain
  draftRevision: number
  generatedByEmployeeId: string
  generatedAt: string
  expiresAt: string
  sourceVersion: string
  historicalMembership: Readonly<{
    activeMembers: number
    membersByTier: Readonly<Record<MembershipTier, number>>
    availablePointsLiability: number
  }>
  policyContent: MembershipConfigurationContent
  estimatedPointsIssued: number
  estimatedPointsCostAmountMinor: number
  estimatedBenefitCostAmountMinor: number
  estimatedRedemptionCostAmountMinor: number
  projectedTierMembers: Readonly<Record<MembershipTier, number>> | null
  fulfillment: readonly Readonly<{
    referenceCode: string
    expectedDemand: number
    availableAfterReservations: number | null
    shortage: number
    openFulfillmentTasks: number
  }>[]
  affectedExistingMembers: number
  warnings: readonly (
    | 'inventory_shortage'
    | 'fulfillment_capacity_review'
    | 'points_cost_review'
    | 'benefit_cost_review'
    | 'redemption_cost_review'
    | 'terms_reacceptance_not_forced'
  )[]
  fingerprint: string
}

export interface MembershipConfigurationDraftSession {
  loadDraft(publicId: string): Promise<MembershipConfigurationDraftRecord | null>
  replaceDraft(input: Readonly<{
    publicId: string
    expectedRevision: number
    nextRevision: number
    content: MembershipConfigurationContent
    makerEmployeeIds: readonly string[]
    reason: string
    employeeId: string
  }>): Promise<MembershipConfigurationDraftRecord>
  loadImpactSnapshot(content: MembershipConfigurationContent): Promise<MembershipImpactSnapshot>
  saveImpactPreview(preview: MembershipConfigurationImpactPreview): Promise<void>
  loadImpactPreview(publicId: string): Promise<MembershipConfigurationImpactPreview | null>
  approveDraft(input: Readonly<{
    publicId: string
    expectedRevision: number
    approverEmployeeId: string
    reason: string
    impactPreviewPublicId: string
    impactFingerprint: string
  }>): Promise<MembershipConfigurationDraftRecord>
}

export interface MembershipConfigurationDraftRepository {
  runExclusive<T>(
    domain: MembershipConfigurationDomain,
    publicId: string,
    work: (session: MembershipConfigurationDraftSession) => Promise<T>,
  ): Promise<T>
}

export class MembershipConfigurationDraftError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function assertMembershipConfigurationPublisherSeparation(input: Readonly<{
  makerEmployeeIds: readonly string[]
  approverEmployeeId: string
  publisherEmployeeId: string
}>): void {
  if (input.makerEmployeeIds.includes(input.publisherEmployeeId)
    || input.publisherEmployeeId === input.approverEmployeeId) throw configurationError(
    'MEMBERSHIP_CONFIGURATION_PUBLISHER_SEPARATION_REQUIRED', '发布人必须与所有草稿编辑者和审批人不同',
  )
}

export class MembershipConfigurationDraftService {
  constructor(
    private readonly repository: MembershipConfigurationDraftRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly nextPublicId: () => string = () => `MCIP${cryptoId()}`,
  ) {}

  get(
    domain: MembershipConfigurationDomain,
    publicId: string,
  ): Promise<MembershipConfigurationDraftRecord> {
    return this.repository.runExclusive(domain, publicId, async (session) => {
      const draft = requiredDraft(await session.loadDraft(publicId))
      if (draft.domain !== domain) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DOMAIN_MISMATCH', '配置草稿不属于请求的配置域',
      )
      return draft
    })
  }

  edit(input: Readonly<{
    domain: MembershipConfigurationDomain
    publicId: string
    expectedRevision: number
    employeeId: string
    reason: string
    content: MembershipConfigurationContent
  }>): Promise<MembershipConfigurationDraftRecord> {
    assertReason(input.reason)
    return this.repository.runExclusive(input.domain, input.publicId, async (session) => {
      const draft = requiredDraft(await session.loadDraft(input.publicId))
      if (draft.status !== 'draft') throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DRAFT_IMMUTABLE', '审批或发布后的配置不可编辑，请从该版本新建草稿并重新审批',
      )
      if (draft.revision !== input.expectedRevision) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DRAFT_STALE', '草稿已被修改，请刷新后重新编辑',
      )
      if (draft.domain !== input.domain || draft.domain !== input.content.domain) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DOMAIN_MISMATCH', '不能把一类会员配置替换成另一类配置',
      )
      assertContent(input.content)
      return session.replaceDraft({
        publicId: draft.publicId,
        expectedRevision: draft.revision,
        nextRevision: draft.revision + 1,
        content: input.content,
        makerEmployeeIds: unique([...draft.makerEmployeeIds, input.employeeId]),
        reason: input.reason.trim(),
        employeeId: input.employeeId,
      })
    })
  }

  preview(
    domain: MembershipConfigurationDomain,
    publicId: string,
    generatedByEmployeeId: string,
  ): Promise<MembershipConfigurationImpactPreview> {
    return this.repository.runExclusive(domain, publicId, async (session) => {
      const draft = requiredDraft(await session.loadDraft(publicId))
      if (draft.domain !== domain) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DOMAIN_MISMATCH', '配置草稿不属于请求的配置域',
      )
      if (draft.status !== 'draft') throw configurationError(
        'MEMBERSHIP_CONFIGURATION_PREVIEW_NOT_DRAFT', '只能为待审批草稿生成影响预览',
      )
      const snapshot = await session.loadImpactSnapshot(draft.content)
      const preview = buildMembershipConfigurationImpactPreview({
        publicId: this.nextPublicId(), draft, snapshot, generatedByEmployeeId, now: this.now(),
      })
      await session.saveImpactPreview(preview)
      return preview
    })
  }

  approve(input: Readonly<{
    domain: MembershipConfigurationDomain
    publicId: string
    expectedRevision: number
    approverEmployeeId: string
    reason: string
    impactPreviewPublicId: string
  }>): Promise<MembershipConfigurationDraftRecord> {
    assertReason(input.reason)
    return this.repository.runExclusive(input.domain, input.publicId, async (session) => {
      const draft = requiredDraft(await session.loadDraft(input.publicId))
      if (draft.domain !== input.domain) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_DOMAIN_MISMATCH', '配置草稿不属于请求的配置域',
      )
      if (draft.status !== 'draft' || draft.revision !== input.expectedRevision) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_APPROVAL_STALE', '草稿已变更或已审批，必须重新预览并审批',
      )
      if (draft.makerEmployeeIds.includes(input.approverEmployeeId)) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED', '任何参与该草稿内容修改的人都不能审批',
      )
      const recorded = await session.loadImpactPreview(input.impactPreviewPublicId)
      if (!recorded || recorded.draftPublicId !== draft.publicId || recorded.draftRevision !== draft.revision
        || Date.parse(recorded.expiresAt) <= this.now().getTime()) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_PREVIEW_STALE', '影响预览不存在、已过期或不属于当前草稿',
      )
      const current = buildMembershipConfigurationImpactPreview({
        publicId: recorded.publicId,
        draft,
        snapshot: await session.loadImpactSnapshot(draft.content),
        generatedByEmployeeId: recorded.generatedByEmployeeId,
        now: new Date(recorded.generatedAt),
      })
      if (current.fingerprint !== recorded.fingerprint) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_IMPACT_CHANGED', '会员分布、成本、库存或履约事实已改变，必须重新生成影响预览',
      )
      return session.approveDraft({
        publicId: draft.publicId,
        expectedRevision: draft.revision,
        approverEmployeeId: input.approverEmployeeId,
        reason: input.reason.trim(),
        impactPreviewPublicId: recorded.publicId,
        impactFingerprint: recorded.fingerprint,
      })
    })
  }
}

export function buildMembershipConfigurationImpactPreview(input: Readonly<{
  publicId: string
  draft: MembershipConfigurationDraftRecord
  snapshot: MembershipImpactSnapshot
  generatedByEmployeeId: string
  now: Date
}>): MembershipConfigurationImpactPreview {
  assertSnapshot(input.snapshot)
  assertContent(input.draft.content)
  const computation = compute(input.draft.content, input.snapshot)
  const generatedAt = input.now.toISOString()
  const expiresAt = new Date(input.now.getTime() + 15 * 60 * 1000).toISOString()
  const common = [
    input.draft.publicId, input.draft.domain, input.draft.revision, input.snapshot.sourceVersion,
    input.snapshot.measuredAt, input.snapshot.activeMembers,
    input.snapshot.membersByTier.member, input.snapshot.membersByTier.silver, input.snapshot.membersByTier.gold,
    input.snapshot.availablePointsLiability,
  ]
  return {
    publicId: input.publicId,
    draftPublicId: input.draft.publicId,
    domain: input.draft.domain,
    draftRevision: input.draft.revision,
    generatedByEmployeeId: input.generatedByEmployeeId,
    generatedAt,
    expiresAt,
    sourceVersion: input.snapshot.sourceVersion,
    historicalMembership: {
      activeMembers: input.snapshot.activeMembers,
      membersByTier: { ...input.snapshot.membersByTier },
      availablePointsLiability: input.snapshot.availablePointsLiability,
    },
    policyContent: input.draft.content,
    ...computation.output,
    fingerprint: fingerprint([...common, ...computation.fingerprint]),
  }
}

function compute(content: MembershipConfigurationContent, snapshot: MembershipImpactSnapshot) {
  const empty = {
    estimatedPointsIssued: 0, estimatedPointsCostAmountMinor: 0,
    estimatedBenefitCostAmountMinor: 0, estimatedRedemptionCostAmountMinor: 0,
    projectedTierMembers: null, fulfillment: [], affectedExistingMembers: snapshot.activeMembers,
    warnings: [] as MembershipConfigurationImpactPreview['warnings'],
  }
  if (content.domain === 'base_points') {
    const points = ratio(snapshot.eligiblePaidAmountMinor, content.pointsNumerator,
      content.pointsDenominatorMinor, content.roundingMode)
    const pointCost = pointsCost(points, snapshot.pointCostMicrosPerPoint)
    return result({ ...empty, estimatedPointsIssued: points, estimatedPointsCostAmountMinor: pointCost,
      warnings: pointCost > 0 ? ['points_cost_review'] : [] }, [
      content.pointsNumerator, content.pointsDenominatorMinor, content.growthNumerator,
      content.growthDenominatorMinor, content.roundingMode, content.pointsValidityMonths,
      snapshot.eligiblePaidAmountMinor, snapshot.pointCostMicrosPerPoint,
    ])
  }
  if (content.domain === 'tier_policy') {
    const memberGold = membersAtGrowth(snapshot.growthBucketsByTier.member, content.goldUpgradeGrowth)
    const memberSilverOrHigher = membersAtGrowth(snapshot.growthBucketsByTier.member, content.silverUpgradeGrowth)
    const silverGold = membersAtGrowth(snapshot.growthBucketsByTier.silver, content.goldUpgradeGrowth)
    const silverRetained = membersAtGrowth(snapshot.growthBucketsByTier.silver, content.silverRetainGrowth)
    const goldRetained = membersAtGrowth(snapshot.growthBucketsByTier.gold, content.goldRetainGrowth)
    const formerGoldSilverOrHigher = membersAtGrowth(snapshot.growthBucketsByTier.gold, content.silverRetainGrowth)
    const gold = memberGold + silverGold + goldRetained
    const silver = memberSilverOrHigher - memberGold + silverRetained - silverGold
      + formerGoldSilverOrHigher - goldRetained
    const tiers = { member: Math.max(0, snapshot.activeMembers - silver - gold), silver, gold }
    const memberGoldPoints = pointsAtGrowth(snapshot.growthBucketsByTier.member, content.goldUpgradeGrowth)
    const memberSilverOrHigherPoints = pointsAtGrowth(snapshot.growthBucketsByTier.member, content.silverUpgradeGrowth)
    const silverGoldPoints = pointsAtGrowth(snapshot.growthBucketsByTier.silver, content.goldUpgradeGrowth)
    const silverRetainedPoints = pointsAtGrowth(snapshot.growthBucketsByTier.silver, content.silverRetainGrowth)
    const goldRetainedPoints = pointsAtGrowth(snapshot.growthBucketsByTier.gold, content.goldRetainGrowth)
    const formerGoldSilverOrHigherPoints = pointsAtGrowth(snapshot.growthBucketsByTier.gold, content.silverRetainGrowth)
    const goldBasePoints = memberGoldPoints + silverGoldPoints + goldRetainedPoints
    const silverBasePoints = memberSilverOrHigherPoints - memberGoldPoints
      + silverRetainedPoints - silverGoldPoints
      + formerGoldSilverOrHigherPoints - goldRetainedPoints
    const totalBasePoints = sumGrowthMeasure(snapshot.growthBucketsByTier, 'eligibleBasePoints')
    const memberBasePoints = Math.max(0, totalBasePoints - silverBasePoints - goldBasePoints)
    const points = memberBasePoints
      + ratio(silverBasePoints, content.silverPointsMultiplierNumerator,
        content.silverPointsMultiplierDenominator, 'floor')
      + ratio(goldBasePoints, content.goldPointsMultiplierNumerator,
        content.goldPointsMultiplierDenominator, 'floor')
    const pointCost = pointsCost(points, snapshot.pointCostMicrosPerPoint)
    return result({ ...empty, estimatedPointsIssued: points,
      estimatedPointsCostAmountMinor: pointCost, projectedTierMembers: tiers,
      warnings: pointCost > 0 ? ['points_cost_review'] : [] }, [
      content.evaluationWindowMonths, content.tierPeriodMonths, content.downgradeGraceDays,
      content.silverUpgradeGrowth, content.silverRetainGrowth, content.goldUpgradeGrowth,
      content.goldRetainGrowth, content.silverPointsMultiplierNumerator,
      content.silverPointsMultiplierDenominator, content.goldPointsMultiplierNumerator,
      content.goldPointsMultiplierDenominator,
      ...(['member', 'silver', 'gold'] as const).flatMap((tier) => [tier,
        ...snapshot.growthBucketsByTier[tier].flatMap((entry) => [entry.minimumGrowth,
          entry.maximumGrowth ?? -1, entry.members, entry.eligibleBasePoints])]),
      snapshot.pointCostMicrosPerPoint,
    ])
  }
  if (content.domain === 'tier_benefits') {
    let cost = 0
    const fulfillment: MembershipConfigurationImpactPreview['fulfillment'][number][] = []
    for (const rule of content.rules.filter((entry) => entry.enabled)) {
      const fact = snapshot.benefitFacts.find((entry) => entry.benefitDefinitionId === rule.benefitDefinitionId)
      if (!fact) throw configurationError('MEMBERSHIP_CONFIGURATION_BENEFIT_FACT_MISSING', '自动权益缺少强类型成本与库存事实')
      const entries = rule.grantOnEntry ? eligibleTierCount(snapshot.expectedTierEntries, rule.eligibleTier, rule.inheritToHigherTiers) : 0
      const retentions = rule.grantOnRetention ? eligibleTierCount(snapshot.expectedTierRetentions, rule.eligibleTier, rule.inheritToHigherTiers) : 0
      const demand = (entries + retentions) * rule.quantity
      cost += demand * fact.unitCostAmountMinor
      const available = fact.availableInventory === null ? null : Math.max(0, fact.availableInventory - fact.reservedInventory)
      fulfillment.push({ referenceCode: rule.ruleCode, expectedDemand: demand, availableAfterReservations: available,
        shortage: available === null ? 0 : Math.max(0, demand - available),
        openFulfillmentTasks: fact.openFulfillmentTasks })
    }
    const warnings = warningsFor(
      fulfillment, cost, fulfillment.some((entry) => entry.expectedDemand > 0), 'benefit_cost_review',
    )
    return result({ ...empty, estimatedBenefitCostAmountMinor: cost, fulfillment, warnings }, [
      content.tierPolicyVersionId,
      ...content.rules.flatMap((rule) => [rule.ruleCode, rule.eligibleTier, rule.inheritToHigherTiers,
        rule.grantOnEntry, rule.grantOnRetention, rule.benefitDefinitionId, rule.quantity,
        rule.validityDays, rule.revocationPolicy, rule.enabled]),
      ...snapshot.benefitFacts.flatMap((fact) => [fact.benefitDefinitionId, fact.unitCostAmountMinor,
        fact.availableInventory ?? -1, fact.reservedInventory, fact.requiresEmployeeFulfillment,
        fact.openFulfillmentTasks]),
    ])
  }
  if (content.domain === 'redemption_catalog') {
    let cost = 0
    const activeItems = content.items.filter((item) => item.status === 'active')
    const fulfillment = activeItems.map((item) => {
      const demand = snapshot.redemptionDemand.find((entry) => entry.itemCode === item.itemCode)
        ?? { expectedRequests: 0, currentlyReservedTotal: 0, currentlyReservedToday: 0, openFulfillmentTasks: 0 }
      const totalAvailable = item.totalInventory === null
        ? null : Math.max(0, item.totalInventory - demand.currentlyReservedTotal)
      const dailyAvailable = item.dailyInventory === null
        ? null : Math.max(0, item.dailyInventory - demand.currentlyReservedToday)
      const available = totalAvailable === null ? dailyAvailable
        : dailyAvailable === null ? totalAvailable : Math.min(totalAvailable, dailyAvailable)
      cost += demand.expectedRequests * item.costAmountMinor
      return { referenceCode: item.itemCode, expectedDemand: demand.expectedRequests, availableAfterReservations: available,
        shortage: available === null ? 0 : Math.max(0, demand.expectedRequests - available),
        openFulfillmentTasks: demand.openFulfillmentTasks }
    })
    return result({ ...empty, estimatedRedemptionCostAmountMinor: cost, fulfillment,
      warnings: warningsFor(fulfillment, cost,
        activeItems.some((item) => item.requiresEmployeeFulfillment), 'redemption_cost_review') }, [
      ...content.items.flatMap((item) => [item.publicId, item.itemCode, item.name, item.fulfillmentKind,
        item.productId ?? '', item.benefitDefinitionId ?? '', item.activityId ?? '', item.pointsRequired,
        item.costAmountMinor, item.currency, item.totalInventory ?? -1, item.dailyInventory ?? -1,
        item.memberDailyLimit, item.memberRolling30DayLimit, item.memberLifetimeLimit ?? -1,
        item.minimumTier, item.requiresTableSession, item.requiresEmployeeFulfillment,
        item.cancellationAllowedBeforeFulfillment, item.restoreExpiredPointsDays, item.availableFrom,
        item.availableUntil ?? '', item.fulfillmentTimeoutMinutes, item.status]),
      ...snapshot.redemptionDemand.flatMap((entry) => [entry.itemCode, entry.expectedRequests,
        entry.currentlyReservedTotal, entry.currentlyReservedToday, entry.openFulfillmentTasks]),
    ])
  }
  if (content.domain === 'promotion_points') {
    let points = 0
    for (const rule of content.rules.filter((entry) => entry.enabled)) {
      const participants = snapshot.promotionTriggerParticipants.find((entry) => entry.triggerKind === rule.triggerKind)
      const eligibleMembers = participants?.eligibleMembers ?? 0
      const awards = Math.min(
        participants?.expectedTriggerFacts ?? 0,
        eligibleMembers * rule.perMemberAwardLimit,
      )
      points += Math.min(awards * rule.points, eligibleMembers * content.perMemberPointsLimit)
    }
    points = Math.min(points, content.storeBudgetPoints, snapshot.activeMembers * content.perMemberPointsLimit)
    const pointCost = pointsCost(points, snapshot.pointCostMicrosPerPoint)
    return result({ ...empty, estimatedPointsIssued: points, estimatedPointsCostAmountMinor: pointCost,
      warnings: pointCost > 0 ? ['points_cost_review'] : [] }, [content.campaignCode, content.name,
      content.activityId, content.stackingGroup, content.stackingMode, content.priority,
      content.storeBudgetPoints, content.perMemberPointsLimit, content.pointValidityDays,
      content.refundPolicy, content.budgetReuseAfterRefund, content.memberLimitReuseAfterRefund,
      ...content.eligibleMemberLevels,
      ...content.rules.flatMap((rule) => [rule.ruleCode, rule.triggerKind, rule.points,
        rule.perMemberAwardLimit, rule.minimumPaidAmountMinor, rule.enabled]),
      ...snapshot.promotionTriggerParticipants.flatMap((entry) => [entry.triggerKind,
        entry.eligibleMembers, entry.expectedTriggerFacts]),
      snapshot.pointCostMicrosPerPoint,
    ])
  }
  if (content.domain === 'membership_terms') {
    return result({ ...empty, affectedExistingMembers: 0, warnings: ['terms_reacceptance_not_forced'] }, [
      content.title, content.summary, content.content, snapshot.currentTermsAcceptances,
    ])
  }
  const notification = snapshot.notificationFacts.find((entry) => entry.notificationType === content.notificationType)
  if (!notification) throw configurationError(
    'MEMBERSHIP_CONFIGURATION_NOTIFICATION_FACT_MISSING', '通知策略缺少强类型授权与发送基线',
  )
  return result({ ...empty, affectedExistingMembers: notification.activeAuthorizations }, [
    content.notificationType, content.authorizationPurpose, content.authorizationContext,
    content.templateId, content.pagePath, content.pointsDataKey, content.balanceDataKey ?? '',
    content.occurredAtDataKey, content.expiresAtDataKey ?? '', content.expiryLeadDays ?? -1,
    content.maxPerCustomerPer24h, content.minimumIntervalMinutes,
    content.quietHoursStart ?? '', content.quietHoursEnd ?? '',
    notification.activeAuthorizations, notification.expectedMessagesPer24h,
  ])
}

function result(output: Omit<MembershipConfigurationImpactPreview, 'publicId' | 'draftPublicId' | 'domain' | 'draftRevision' | 'generatedByEmployeeId' | 'generatedAt' | 'expiresAt' | 'sourceVersion' | 'historicalMembership' | 'policyContent' | 'fingerprint'>, basis: readonly unknown[]) {
  return { output, fingerprint: basis }
}
function warningsFor(
  fulfillment: MembershipConfigurationImpactPreview['fulfillment'],
  cost: number,
  requiresFulfillment: boolean,
  costWarning: 'benefit_cost_review' | 'redemption_cost_review',
) {
  const warnings: MembershipConfigurationImpactPreview['warnings'][number][] = []
  if (fulfillment.some((entry) => entry.shortage > 0)) warnings.push('inventory_shortage')
  if (requiresFulfillment) warnings.push('fulfillment_capacity_review')
  if (cost > 0) warnings.push(costWarning)
  return warnings
}
function ratio(amount: number, numerator: number, denominator: number, mode: 'floor' | 'nearest') {
  const raw = amount * numerator / denominator
  return mode === 'nearest' ? Math.round(raw) : Math.floor(raw)
}
function pointsCost(points: number, micros: number) { return Math.ceil(points * micros / 1_000_000) }
function membersAtGrowth(buckets: MembershipImpactSnapshot['growthBucketsByTier'][MembershipTier], threshold: number) {
  if (buckets.some((entry) => entry.minimumGrowth < threshold
    && (entry.maximumGrowth === null || entry.maximumGrowth >= threshold))) {
    throw configurationError(
      'MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_TOO_COARSE', '历史成长值分布粒度不足，不能精确预估新等级人数',
    )
  }
  return buckets.filter((entry) => entry.minimumGrowth >= threshold).reduce((sum, entry) => sum + entry.members, 0)
}
function pointsAtGrowth(buckets: MembershipImpactSnapshot['growthBucketsByTier'][MembershipTier], threshold: number) {
  membersAtGrowth(buckets, threshold)
  return buckets.filter((entry) => entry.minimumGrowth >= threshold)
    .reduce((sum, entry) => sum + entry.eligibleBasePoints, 0)
}
function sumGrowthMeasure(
  buckets: MembershipImpactSnapshot['growthBucketsByTier'],
  measure: 'eligibleBasePoints',
) {
  return (['member', 'silver', 'gold'] as const).reduce((sum, tier) => (
    sum + buckets[tier].reduce((tierSum, entry) => tierSum + entry[measure], 0)
  ), 0)
}
function eligibleTierCount(counts: Readonly<Record<MembershipTier, number>>, tier: MembershipTier, inherit: boolean) {
  if (!inherit) return counts[tier]
  if (tier === 'member') return counts.member + counts.silver + counts.gold
  if (tier === 'silver') return counts.silver + counts.gold
  return counts.gold
}
function assertContent(content: MembershipConfigurationContent) {
  if (content.domain === 'base_points') {
    positive(content.pointsDenominatorMinor); positive(content.growthDenominatorMinor)
    nonnegative(content.pointsNumerator); nonnegative(content.growthNumerator)
    if (content.pointsValidityMonths < 1 || content.pointsValidityMonths > 120) throw configurationError(
      'MEMBERSHIP_CONFIGURATION_INVALID', '积分有效期必须为1至120个月',
    )
  } else if (content.domain === 'tier_policy') {
    for (const value of [content.evaluationWindowMonths, content.tierPeriodMonths,
      content.silverUpgradeGrowth, content.goldUpgradeGrowth,
      content.silverPointsMultiplierNumerator, content.silverPointsMultiplierDenominator,
      content.goldPointsMultiplierNumerator, content.goldPointsMultiplierDenominator]) positive(value)
    for (const value of [content.downgradeGraceDays, content.silverRetainGrowth, content.goldRetainGrowth]) nonnegative(value)
    if (content.silverRetainGrowth > content.silverUpgradeGrowth
      || content.goldRetainGrowth < content.silverRetainGrowth
      || content.goldRetainGrowth > content.goldUpgradeGrowth
      || content.goldUpgradeGrowth <= content.silverUpgradeGrowth) throw configurationError(
      'MEMBERSHIP_CONFIGURATION_INVALID', '会员等级升级与保级门槛顺序无效',
    )
  } else if (content.domain === 'tier_benefits') {
    if (content.rules.length < 1) throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', '自动权益规则不能为空')
    uuid(content.tierPolicyVersionId)
    distinct(content.rules.map((rule) => rule.ruleCode), '自动权益规则代码重复')
    for (const rule of content.rules) {
      code(rule.ruleCode); uuid(rule.benefitDefinitionId); positive(rule.quantity); positive(rule.validityDays)
      if (!rule.grantOnEntry && !rule.grantOnRetention) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_INVALID', '自动权益必须至少选择入级或保级发放',
      )
    }
  } else if (content.domain === 'redemption_catalog') {
    if (content.items.length < 1 || content.items.length > 200) throw configurationError(
      'MEMBERSHIP_CONFIGURATION_INVALID', '兑换目录必须包含1至200个兑换项',
    )
    distinct(content.items.map((item) => item.itemCode), '兑换项代码重复')
    distinct(content.items.map((item) => item.publicId), '兑换项公开编号重复')
    for (const item of content.items) {
      code(item.itemCode); textBetween(item.publicId, 8, 128); textBetween(item.name, 2, 120)
      positive(item.pointsRequired); nonnegative(item.costAmountMinor); positive(item.fulfillmentTimeoutMinutes)
      if (item.totalInventory !== null) nonnegative(item.totalInventory)
      if (item.dailyInventory !== null) nonnegative(item.dailyInventory)
      positive(item.memberDailyLimit); positive(item.memberRolling30DayLimit)
      if (item.memberLifetimeLimit !== null) positive(item.memberLifetimeLimit)
      nonnegative(item.restoreExpiredPointsDays)
      if (!/^[A-Z]{3}$/.test(item.currency)) invalid('兑换项币种无效')
      timestamp(item.availableFrom)
      if (item.availableUntil !== null
        && Date.parse(timestamp(item.availableUntil)) <= Date.parse(item.availableFrom)) invalid('兑换项可用时间无效')
      const references = [item.productId, item.benefitDefinitionId, item.activityId].filter((value) => value !== null)
      for (const reference of references) uuid(reference!)
      if (item.fulfillmentKind === 'product' && item.productId === null) invalid('商品兑换必须关联商品')
      if (item.fulfillmentKind === 'benefit' && item.benefitDefinitionId === null) invalid('权益兑换必须关联权益定义')
      if (item.fulfillmentKind === 'activity' && item.activityId === null) invalid('活动兑换必须关联活动')
    }
  } else if (content.domain === 'promotion_points') {
    code(content.campaignCode); textBetween(content.name, 2, 80); uuid(content.activityId)
    code(content.stackingGroup); nonnegative(content.priority)
    positive(content.storeBudgetPoints); positive(content.perMemberPointsLimit)
    positive(content.pointValidityDays)
    if (content.eligibleMemberLevels.length < 1) invalid('促销积分适用会员等级不能为空')
    distinct(content.eligibleMemberLevels, '促销积分适用会员等级重复')
    if (content.rules.length < 1) invalid('促销积分规则不能为空')
    distinct(content.rules.map((rule) => rule.ruleCode), '促销积分规则代码重复')
    for (const rule of content.rules) {
      code(rule.ruleCode); positive(rule.points); positive(rule.perMemberAwardLimit)
      nonnegative(rule.minimumPaidAmountMinor)
      if (rule.triggerKind !== 'activity_payment' && rule.minimumPaidAmountMinor !== 0) invalid(
        '非付款触发的促销规则不能设置最低付款金额',
      )
    }
  } else if (content.domain === 'membership_terms'
    && (content.title.trim().length < 2 || content.summary.trim().length < 2 || content.content.trim().length < 10)) {
    throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', '入会条款标题、摘要或正文不完整')
  } else if (content.domain === 'wechat_notifications') {
    positive(content.maxPerCustomerPer24h); nonnegative(content.minimumIntervalMinutes)
    if (content.templateId.trim().length < 8 || !/^pages\/[A-Za-z0-9_./-]{1,180}$/.test(content.pagePath)
      || !dataKey(content.pointsDataKey) || !dataKey(content.occurredAtDataKey)
      || (content.balanceDataKey !== null && !dataKey(content.balanceDataKey))
      || (content.expiresAtDataKey !== null && !dataKey(content.expiresAtDataKey))) {
      throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', '微信通知模板或页面路径无效')
    }
    const expected = notificationAuthorization(content.notificationType)
    if (content.authorizationPurpose !== expected.purpose
      || content.authorizationContext !== expected.context
      || (content.notificationType === 'loyalty_points_expiring') !== (content.expiryLeadDays !== null)
      || (content.notificationType === 'loyalty_points_expiring') !== (content.expiresAtDataKey !== null)
      || (content.notificationType === 'loyalty_points_expiring') === (content.balanceDataKey !== null)) invalid(
        '微信通知类型、授权用途、数据字段或到期策略不匹配',
      )
    if ((content.quietHoursStart === null) !== (content.quietHoursEnd === null)
      || (content.quietHoursStart !== null && (!time(content.quietHoursStart)
        || !time(content.quietHoursEnd!) || content.quietHoursStart === content.quietHoursEnd))) invalid(
      '微信通知静默时段无效',
    )
  }
}
function assertSnapshot(snapshot: MembershipImpactSnapshot) {
  for (const value of [snapshot.activeMembers, snapshot.membersByTier.member, snapshot.membersByTier.silver,
    snapshot.membersByTier.gold, snapshot.availablePointsLiability, snapshot.eligiblePaidAmountMinor,
    snapshot.pointCostMicrosPerPoint, snapshot.currentTermsAcceptances]) nonnegative(value)
  if (snapshot.membersByTier.member + snapshot.membersByTier.silver + snapshot.membersByTier.gold !== snapshot.activeMembers) {
    throw configurationError('MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_INVALID', '历史会员等级分布与活跃会员数不守恒')
  }
  for (const tier of ['member', 'silver', 'gold'] as const) {
    nonnegative(snapshot.expectedTierEntries[tier]); nonnegative(snapshot.expectedTierRetentions[tier])
  }
  for (const tier of ['member', 'silver', 'gold'] as const) {
    let previousMaximum = -1
    let bucketMembers = 0
    for (const bucket of snapshot.growthBucketsByTier[tier]) {
      nonnegative(bucket.minimumGrowth); nonnegative(bucket.members)
      nonnegative(bucket.eligibleBasePoints)
      if (bucket.maximumGrowth !== null && bucket.maximumGrowth < bucket.minimumGrowth) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_INVALID', '历史成长值分布区间无效',
      )
      if (bucket.minimumGrowth <= previousMaximum) throw configurationError(
        'MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_INVALID', '历史成长值分布区间重叠或无序',
      )
      previousMaximum = bucket.maximumGrowth ?? Number.MAX_SAFE_INTEGER
      bucketMembers += bucket.members
    }
    if (bucketMembers !== snapshot.membersByTier[tier]) throw configurationError(
      'MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_INVALID', '历史成长值分布与当前等级会员数不守恒',
    )
  }
  for (const fact of snapshot.benefitFacts) {
    nonnegative(fact.unitCostAmountMinor); nonnegative(fact.reservedInventory)
    nonnegative(fact.openFulfillmentTasks)
    if (fact.availableInventory !== null) nonnegative(fact.availableInventory)
  }
  for (const fact of snapshot.redemptionDemand) {
    nonnegative(fact.expectedRequests); nonnegative(fact.currentlyReservedTotal)
    nonnegative(fact.currentlyReservedToday); nonnegative(fact.openFulfillmentTasks)
  }
  for (const fact of snapshot.promotionTriggerParticipants) {
    nonnegative(fact.eligibleMembers); nonnegative(fact.expectedTriggerFacts)
  }
  for (const fact of snapshot.notificationFacts) {
    nonnegative(fact.activeAuthorizations); nonnegative(fact.expectedMessagesPer24h)
  }
}
function positive(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', '配置数值必须为正整数') }
function nonnegative(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', '配置数值必须为非负整数') }
function invalid(message: string): never { throw configurationError('MEMBERSHIP_CONFIGURATION_INVALID', message) }
function code(value: string) { if (!/^[A-Z0-9][A-Z0-9_.-]{2,63}$/.test(value)) invalid('配置代码格式无效') }
function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    invalid('配置引用编号无效')
  }
}
function textBetween(value: string, minimum: number, maximum: number) {
  const length = value.trim().length
  if (length < minimum || length > maximum) invalid('配置文本长度无效')
}
function timestamp(value: string) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) invalid('配置时间无效')
  return new Date(parsed).toISOString()
}
function time(value: string) { return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) }
function dataKey(value: string) { return /^[a-z][a-z0-9_]{1,31}$/.test(value) }
function distinct(values: readonly string[], message: string) {
  if (new Set(values).size !== values.length) invalid(message)
}
function notificationAuthorization(
  notificationType: Extract<MembershipConfigurationContent, { domain: 'wechat_notifications' }>['notificationType'],
) {
  if (notificationType === 'loyalty_points_credited') {
    return { purpose: 'loyalty_balance_change', context: 'loyalty_accrual' } as const
  }
  if (notificationType === 'loyalty_points_reversed') {
    return { purpose: 'loyalty_balance_change', context: 'loyalty_refund' } as const
  }
  return { purpose: 'loyalty_expiry_reminder', context: 'loyalty_expiry' } as const
}
function assertReason(reason: string) { if (reason.trim().length < 2) throw configurationError('MEMBERSHIP_CONFIGURATION_REASON_REQUIRED', '必须填写可追溯原因') }
function requiredDraft(value: MembershipConfigurationDraftRecord | null) { if (!value) throw configurationError('MEMBERSHIP_CONFIGURATION_DRAFT_NOT_FOUND', '会员配置草稿不存在'); return value }
function configurationError(code: string, message: string) { return new MembershipConfigurationDraftError(code, message) }
function unique(values: readonly string[]) { return [...new Set(values)] }
function cryptoId() { return randomUUID().replaceAll('-', '').toUpperCase() }
function fingerprint(parts: readonly unknown[]) {
  const hash = createHash('sha256')
  for (const part of parts) { const value = String(part); hash.update(`${Buffer.byteLength(value)}:`); hash.update(value) }
  return hash.digest('hex')
}
