import { describe, expect, it } from 'vitest'
import {
  MembershipConfigurationDraftService,
  assertMembershipConfigurationPublisherSeparation,
  buildMembershipConfigurationImpactPreview,
  type MembershipConfigurationDraftRecord,
  type MembershipConfigurationDraftRepository,
  type MembershipConfigurationDraftSession,
  type MembershipConfigurationImpactPreview,
  type MembershipImpactSnapshot,
} from './membership-configuration-draft-service.js'

const baseSnapshot: MembershipImpactSnapshot = {
  sourceVersion: 'loyalty-impact-2026-08-16T09:30Z',
  measuredAt: '2026-08-16T09:30:00.000Z',
  activeMembers: 100,
  membersByTier: { member: 70, silver: 25, gold: 5 },
  availablePointsLiability: 48_000,
  eligiblePaidAmountMinor: 100_000,
  expectedTierEntries: { member: 0, silver: 4, gold: 1 },
  expectedTierRetentions: { member: 0, silver: 8, gold: 2 },
  growthBucketsByTier: {
    member: [{ minimumGrowth: 0, maximumGrowth: 999, members: 70, eligibleBasePoints: 700 }],
    silver: [{ minimumGrowth: 1_000, maximumGrowth: 4_999, members: 25, eligibleBasePoints: 500 }],
    gold: [{ minimumGrowth: 5_000, maximumGrowth: null, members: 5, eligibleBasePoints: 150 }],
  },
  pointCostMicrosPerPoint: 250_000,
  benefitFacts: [{
    benefitDefinitionId: '11111111-1111-4111-8111-111111111111',
    unitCostAmountMinor: 800,
    availableInventory: 8,
    reservedInventory: 2,
    requiresEmployeeFulfillment: true,
    openFulfillmentTasks: 3,
  }],
  redemptionDemand: [{ itemCode: 'DRINK_01', expectedRequests: 12,
    currentlyReservedTotal: 4, currentlyReservedToday: 1, openFulfillmentTasks: 4 }],
  promotionTriggerParticipants: [{ triggerKind: 'activity_check_in', eligibleMembers: 40, expectedTriggerFacts: 70 }],
  notificationFacts: [{ notificationType: 'loyalty_points_expiring', activeAuthorizations: 18, expectedMessagesPer24h: 6 }],
  currentTermsAcceptances: 62,
}

describe('membership configuration draft impact', () => {
  it('calculates server-owned points cost and preserves the historical member distribution', () => {
    const preview = previewFor({
      domain: 'base_points', pointsNumerator: 1, pointsDenominatorMinor: 100,
      growthNumerator: 1, growthDenominatorMinor: 100, roundingMode: 'floor', pointsValidityMonths: 12,
    })
    expect(preview.historicalMembership).toEqual({
      activeMembers: 100, membersByTier: { member: 70, silver: 25, gold: 5 }, availablePointsLiability: 48_000,
    })
    expect(preview.estimatedPointsIssued).toBe(1_000)
    expect(preview.estimatedPointsCostAmountMinor).toBe(250)
    expect(preview.warnings).toContain('points_cost_review')
  })

  it('calculates benefit cost and redemption inventory or fulfillment shortages from typed facts', () => {
    const benefits = previewFor({
      domain: 'tier_benefits',
      tierPolicyVersionId: '22222222-2222-4222-8222-222222222222',
      rules: [{
        ruleCode: 'SILVER_WELCOME', eligibleTier: 'silver', inheritToHigherTiers: true,
        grantOnEntry: true, grantOnRetention: true,
        benefitDefinitionId: '11111111-1111-4111-8111-111111111111', quantity: 1,
        validityDays: 30, revocationPolicy: 'revoke_unreserved', enabled: true,
      }],
    })
    expect(benefits.estimatedBenefitCostAmountMinor).toBe(12_000)
    expect(benefits.fulfillment[0]).toEqual(expect.objectContaining({
      referenceCode: 'SILVER_WELCOME', expectedDemand: 15, availableAfterReservations: 6, shortage: 9,
    }))
    expect(benefits.warnings).toEqual(expect.arrayContaining(['inventory_shortage', 'fulfillment_capacity_review']))

    const redemption = previewFor({
      domain: 'redemption_catalog',
      items: [redemptionItem()],
    })
    expect(redemption.estimatedRedemptionCostAmountMinor).toBe(12_000)
    expect(redemption.fulfillment[0]).toEqual({
      referenceCode: 'DRINK_01', expectedDemand: 12, availableAfterReservations: 4,
      shortage: 8, openFulfillmentTasks: 4,
    })
    expect(redemption.warnings).toEqual(expect.arrayContaining([
      'inventory_shortage', 'fulfillment_capacity_review', 'redemption_cost_review',
    ]))
  })

  it('projects tier distribution and multiplier cost, and estimates capped promotion points', () => {
    const tier = previewFor({
      domain: 'tier_policy', evaluationWindowMonths: 12, tierPeriodMonths: 12, downgradeGraceDays: 30,
      silverUpgradeGrowth: 1_000, silverRetainGrowth: 800,
      goldUpgradeGrowth: 5_000, goldRetainGrowth: 4_000,
      silverPointsMultiplierNumerator: 3, silverPointsMultiplierDenominator: 2,
      goldPointsMultiplierNumerator: 2, goldPointsMultiplierDenominator: 1,
    })
    expect(tier.projectedTierMembers).toEqual({ member: 70, silver: 25, gold: 5 })
    expect(tier.estimatedPointsIssued).toBe(1_750)
    expect(tier.estimatedPointsCostAmountMinor).toBe(438)

    const promotion = previewFor({
      domain: 'promotion_points', campaignCode: 'CHECKIN_2026', name: '签到积分',
      activityId: '33333333-3333-4333-8333-333333333333', stackingGroup: 'ACTIVITY_REWARD',
      stackingMode: 'exclusive_highest', priority: 100, storeBudgetPoints: 3_000,
      perMemberPointsLimit: 100, pointValidityDays: 90, refundPolicy: 'reverse_on_any_refund',
      budgetReuseAfterRefund: false, memberLimitReuseAfterRefund: false,
      eligibleMemberLevels: ['member', 'silver', 'gold'],
      rules: [{ ruleCode: 'CHECK_IN', triggerKind: 'activity_check_in', points: 50,
        perMemberAwardLimit: 2, minimumPaidAmountMinor: 0, enabled: true }],
    })
    expect(promotion.estimatedPointsIssued).toBe(3_000)
    expect(promotion.estimatedPointsCostAmountMinor).toBe(750)
  })

  it('edits only saved drafts, tracks every maker and requires a fresh server preview for approval', async () => {
    const repository = new MemoryRepository(draftFor({
      domain: 'membership_terms', title: '会员条款', summary: '首版摘要', content: '这是一份完整的会员入会条款正文。',
    }), baseSnapshot)
    const service = new MembershipConfigurationDraftService(
      repository, () => new Date('2026-08-16T09:35:00.000Z'), () => 'MCIP00000000000000000000000000000001',
    )
    const edited = await service.edit({
      domain: 'membership_terms', publicId: 'MCFG0001', expectedRevision: 1,
      employeeId: 'employee-editor', reason: '补充退出规则',
      content: { domain: 'membership_terms', title: '会员条款', summary: '更新摘要', content: '这是修订后的完整会员入会条款正文。' },
    })
    expect(edited.revision).toBe(2)
    expect(edited.makerEmployeeIds).toEqual(['employee-maker', 'employee-editor'])

    const preview = await service.preview('membership_terms', edited.publicId, 'employee-reviewer')
    expect(preview.affectedExistingMembers).toBe(0)
    expect(preview.warnings).toContain('terms_reacceptance_not_forced')
    await expect(service.approve({
      domain: 'membership_terms', publicId: edited.publicId, expectedRevision: 2,
      approverEmployeeId: 'employee-editor',
      impactPreviewPublicId: preview.publicId, reason: '本人不得审批',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED' })

    repository.snapshot = { ...repository.snapshot, sourceVersion: 'loyalty-impact-new' }
    await expect(service.approve({
      domain: 'membership_terms', publicId: edited.publicId, expectedRevision: 2,
      approverEmployeeId: 'employee-approver',
      impactPreviewPublicId: preview.publicId, reason: '独立审批',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CONFIGURATION_IMPACT_CHANGED' })
    const fresh = await service.preview('membership_terms', edited.publicId, 'employee-reviewer')
    await expect(service.approve({
      domain: 'membership_terms', publicId: edited.publicId, expectedRevision: 2,
      approverEmployeeId: 'employee-approver',
      impactPreviewPublicId: fresh.publicId, reason: '独立审批',
    })).resolves.toMatchObject({ status: 'approved' })
    await expect(service.edit({
      domain: 'membership_terms', publicId: edited.publicId, expectedRevision: 2,
      employeeId: 'employee-maker', reason: '审批后篡改',
      content: edited.content,
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CONFIGURATION_DRAFT_IMMUTABLE' })
    expect(() => assertMembershipConfigurationPublisherSeparation({
      makerEmployeeIds: edited.makerEmployeeIds,
      approverEmployeeId: 'employee-approver',
      publisherEmployeeId: 'employee-maker',
    })).toThrow(expect.objectContaining({ code: 'MEMBERSHIP_CONFIGURATION_PUBLISHER_SEPARATION_REQUIRED' }))
    expect(() => assertMembershipConfigurationPublisherSeparation({
      makerEmployeeIds: edited.makerEmployeeIds,
      approverEmployeeId: 'employee-approver',
      publisherEmployeeId: 'employee-owner',
    })).not.toThrow()
  })

  it('cannot approve with a client-invented preview id instead of a persisted server preview', async () => {
    const repository = new MemoryRepository(draftFor({
      domain: 'base_points', pointsNumerator: 1, pointsDenominatorMinor: 100,
      growthNumerator: 1, growthDenominatorMinor: 100, roundingMode: 'floor', pointsValidityMonths: 12,
    }), baseSnapshot)
    const service = new MembershipConfigurationDraftService(repository)
    await expect(service.approve({
      domain: 'base_points', publicId: 'MCFG0001', expectedRevision: 1,
      approverEmployeeId: 'employee-approver',
      impactPreviewPublicId: 'CLIENT-SAYS-TRUE', reason: '客户端自证影响',
    })).rejects.toMatchObject({ code: 'MEMBERSHIP_CONFIGURATION_PREVIEW_STALE' })
  })

  it('rejects mismatched notification authorization semantics and imprecise tier evidence', () => {
    expect(() => previewFor({
      domain: 'wechat_notifications', notificationType: 'loyalty_points_expiring',
      authorizationPurpose: 'loyalty_balance_change', authorizationContext: 'loyalty_accrual',
      templateId: 'template-expiry-01', pagePath: 'pages/points/index',
      pointsDataKey: 'points_value', balanceDataKey: null, occurredAtDataKey: 'occurred_at',
      expiresAtDataKey: 'expires_at', expiryLeadDays: 7, maxPerCustomerPer24h: 1,
      minimumIntervalMinutes: 60, quietHoursStart: '23:00', quietHoursEnd: '08:00',
    })).toThrow(expect.objectContaining({ code: 'MEMBERSHIP_CONFIGURATION_INVALID' }))

    expect(() => previewFor({
      domain: 'tier_policy', evaluationWindowMonths: 12, tierPeriodMonths: 12, downgradeGraceDays: 30,
      silverUpgradeGrowth: 500, silverRetainGrowth: 400,
      goldUpgradeGrowth: 5_000, goldRetainGrowth: 4_000,
      silverPointsMultiplierNumerator: 3, silverPointsMultiplierDenominator: 2,
      goldPointsMultiplierNumerator: 2, goldPointsMultiplierDenominator: 1,
    })).toThrow(expect.objectContaining({ code: 'MEMBERSHIP_CONFIGURATION_IMPACT_SOURCE_TOO_COARSE' }))
  })
})

function draftFor(content: MembershipConfigurationDraftRecord['content']): MembershipConfigurationDraftRecord {
  return {
    publicId: 'MCFG0001', domain: content.domain, status: 'draft', revision: 1,
    makerEmployeeIds: ['employee-maker'], content, updatedAt: '2026-08-16T09:30:00.000Z',
  }
}
function previewFor(content: MembershipConfigurationDraftRecord['content']) {
  return buildMembershipConfigurationImpactPreview({
    publicId: 'MCIP0001', draft: draftFor(content), snapshot: baseSnapshot,
    generatedByEmployeeId: 'employee-reviewer',
    now: new Date('2026-08-16T09:35:00.000Z'),
  })
}
function redemptionItem(): Extract<MembershipConfigurationDraftRecord['content'], {
  domain: 'redemption_catalog'
}>['items'][number] {
  return {
    publicId: 'REDEEM_DRINK_01', itemCode: 'DRINK_01', name: '指定饮品兑换',
    fulfillmentKind: 'product', productId: '44444444-4444-4444-8444-444444444444',
    benefitDefinitionId: null, activityId: null, pointsRequired: 800, costAmountMinor: 1_000,
    currency: 'CNY', totalInventory: 10, dailyInventory: 5, memberDailyLimit: 1,
    memberRolling30DayLimit: 4, memberLifetimeLimit: null, minimumTier: 'member',
    requiresTableSession: true, requiresEmployeeFulfillment: true,
    cancellationAllowedBeforeFulfillment: true, restoreExpiredPointsDays: 7,
    availableFrom: '2026-08-17T00:00:00.000Z', availableUntil: null,
    fulfillmentTimeoutMinutes: 120, status: 'active',
  }
}

class MemoryRepository implements MembershipConfigurationDraftRepository, MembershipConfigurationDraftSession {
  readonly previews = new Map<string, MembershipConfigurationImpactPreview>()
  constructor(public draft: MembershipConfigurationDraftRecord, public snapshot: MembershipImpactSnapshot) {}
  runExclusive<T>(
    _domain: MembershipConfigurationDraftRecord['domain'],
    _publicId: string,
    work: (session: MembershipConfigurationDraftSession) => Promise<T>,
  ) { return work(this) }
  async loadDraft() { return this.draft }
  async replaceDraft(input: Parameters<MembershipConfigurationDraftSession['replaceDraft']>[0]) {
    this.draft = { ...this.draft, revision: input.nextRevision, content: input.content,
      makerEmployeeIds: input.makerEmployeeIds, updatedAt: '2026-08-16T09:34:00.000Z' }
    this.previews.clear()
    return this.draft
  }
  async loadImpactSnapshot() { return this.snapshot }
  async saveImpactPreview(preview: MembershipConfigurationImpactPreview) { this.previews.set(preview.publicId, preview) }
  async loadImpactPreview(publicId: string) { return this.previews.get(publicId) ?? null }
  async approveDraft() { this.draft = { ...this.draft, status: 'approved' }; return this.draft }
}
