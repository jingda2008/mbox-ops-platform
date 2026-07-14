import { describe, expect, it } from 'vitest'
import {
  decideBenefitGrant,
  launchBenefitCampaign,
  previewBenefitCampaign,
  requestBenefitGrant,
  updateBenefitPolicy,
  updateBenefitTemplate,
} from './benefit-domain.js'
import { createSeedState } from './seed.js'

const now = new Date('2026-07-14T12:00:00.000Z')

function grantInput(overrides: Partial<Parameters<typeof requestBenefitGrant>[1]> = {}) {
  return {
    actorId: 'emp-lin',
    memberId: 'member-amy',
    templateId: 'benefit-beer',
    quantity: 1,
    reason: '现场服务关怀',
    channel: 'service_account' as const,
    idempotencyKey: 'grant-test-0001',
    ...overrides,
  }
}

describe('member benefit grants', () => {
  it('allows a server to grant an authorized low-cost benefit directly', () => {
    const state = createSeedState()
    const request = requestBenefitGrant(state, grantInput(), now)
    expect(request.status).toBe('granted')
    expect(state.memberBenefits).toHaveLength(1)
    expect(state.customerNotifications[0]?.status).toBe('queued')
  })

  it('routes an out-of-policy server grant to approval without crediting the member', () => {
    const state = createSeedState()
    const request = requestBenefitGrant(state, grantInput({ templateId: 'benefit-return-50' }), now)
    expect(request.status).toBe('pending')
    expect(state.memberBenefits).toHaveLength(0)
    expect(state.customerNotifications).toHaveLength(0)
  })

  it('credits the member and queues notification after manager approval', () => {
    const state = createSeedState()
    const request = requestBenefitGrant(state, grantInput({ templateId: 'benefit-return-50' }), now)
    const approved = decideBenefitGrant(state, request.id, {
      actorId: 'emp-chen',
      decision: 'granted',
      note: '经理批准老客关怀',
    }, now)
    expect(approved.status).toBe('granted')
    expect(approved.decidedBy).toBe('emp-chen')
    expect(state.memberBenefits[0]?.approvedBy).toBe('emp-chen')
    expect(state.customerNotifications[0]?.status).toBe('queued')
  })

  it('rejects approval by an employee without approval authority', () => {
    const state = createSeedState()
    const request = requestBenefitGrant(state, grantInput({ templateId: 'benefit-song' }), now)
    expect(() => decideBenefitGrant(state, request.id, {
      actorId: 'emp-lin',
      decision: 'granted',
      note: '尝试越权批准',
    }, now)).toThrow('没有权益审批权限')
  })

  it('launches a deduplicated dormant-member campaign and keeps unsendable messages explicit', () => {
    const state = createSeedState()
    const input = {
      actorId: 'emp-chen',
      name: '老朋友回店礼',
      segment: 'dormant_30' as const,
      templateId: 'benefit-return-50',
      channel: 'service_account' as const,
      reason: '30天未到店会员召回',
      idempotencyKey: 'campaign-test-0001',
    }
    const campaign = launchBenefitCampaign(state, input, now)
    const replay = launchBenefitCampaign(state, input, now)
    expect(replay.id).toBe(campaign.id)
    expect(campaign.eligibleCount).toBe(3)
    expect(campaign.issuedCount).toBe(3)
    expect(state.memberBenefits).toHaveLength(3)
    expect(state.customerNotifications.filter((item) => item.status === 'queued')).toHaveLength(2)
    expect(state.customerNotifications.filter((item) => item.status === 'skipped')).toHaveLength(1)
  })

  it('previews authoritative campaign reach and cost before launch', () => {
    const state = createSeedState()
    const preview = previewBenefitCampaign(state, {
      actorId: 'emp-chen',
      name: '老朋友回店礼',
      segment: 'dormant_30',
      templateId: 'benefit-return-50',
      channel: 'service_account',
      reason: '30天未到店会员召回',
      idempotencyKey: 'campaign-preview-test',
    }, now)
    expect(preview).toEqual({
      eligibleCount: 3,
      issuableCount: 3,
      skippedCount: 0,
      reachableCount: 2,
      estimatedCostAmount: 15000,
      withinDailyBudget: true,
    })
    expect(state.memberBenefits).toHaveLength(0)
  })

  it('blocks campaign launch by a role without campaign authority', () => {
    const state = createSeedState()
    expect(() => launchBenefitCampaign(state, {
      actorId: 'emp-mia',
      name: '越权活动',
      segment: 'vip',
      templateId: 'benefit-song',
      channel: 'wecom',
      reason: '权限验证',
      idempotencyKey: 'campaign-test-0002',
    }, now)).toThrow('没有活动批量发放权限')
  })

  it('uses editable benefit templates and role policies instead of fixed permissions', () => {
    const state = createSeedState()
    updateBenefitTemplate(state, 'benefit-beer', {
      name: '精酿啤酒双杯',
      kind: 'product_gift',
      description: '调整后的门店权益',
      valueAmount: 13600,
      costAmount: 3600,
      productId: 'product-beer',
      validityDays: 21,
      maxPerMember: 4,
      enabled: true,
    }, 'emp-chen', now)
    updateBenefitPolicy(state, 'policy-server', {
      templateIds: ['benefit-beer', 'benefit-cocktail'],
      maxCostPerGrantAmount: 4000,
      maxDailyCostAmount: 20000,
      canApprove: false,
      canLaunchCampaign: false,
    }, 'emp-chen', now)
    const request = requestBenefitGrant(state, grantInput({ idempotencyKey: 'grant-test-config' }), now)
    expect(request.status).toBe('granted')
    expect(state.benefitTemplates.find((item) => item.id === 'benefit-beer')?.validityDays).toBe(21)
    expect(state.auditEntries.some((entry) => entry.action === 'benefit.policy_updated.v1')).toBe(true)
  })
})
