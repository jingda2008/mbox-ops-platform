import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  decideBenefitGrant,
  launchBenefitCampaign,
  previewBenefitCampaign,
  requestBenefitGrant,
  registerBenefitRoutes,
  updateBenefitPolicy,
  updateBenefitTemplate,
} from './benefit-domain.js'
import { registerAuthContext } from './auth-context.js'
import { JsonRepository } from './repository.js'
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
  it('resets the employee daily benefit budget at Beijing midnight', () => {
    const state = createSeedState()
    state.benefitGrantPolicies.find((policy) => policy.roleId === 'server')!.maxDailyCostAmount = 1800
    const beforeMidnight = new Date('2026-07-17T15:30:00.000Z')
    const afterMidnight = new Date('2026-07-17T16:30:00.000Z')

    const first = requestBenefitGrant(state, grantInput({ idempotencyKey: 'grant-beijing-day-1' }), beforeMidnight)
    const second = requestBenefitGrant(state, grantInput({ memberId: 'member-li', idempotencyKey: 'grant-beijing-day-2' }), afterMidnight)

    expect(first.status).toBe('granted')
    expect(second.status).toBe('granted')
  })

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

  it('rejects approval for a benefit outside the approver policy template scope', () => {
    const state = createSeedState()
    const request = requestBenefitGrant(state, grantInput({ templateId: 'benefit-return-50' }), now)
    expect(() => decideBenefitGrant(state, request.id, {
      actorId: 'emp-mia',
      decision: 'granted',
      note: '尝试审批策略范围外权益',
    }, now)).toThrow('没有该权益审批权限')
    expect(request.status).toBe('pending')
    expect(state.memberBenefits).toHaveLength(0)
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

async function routeFixture() {
  const repository = new JsonRepository(`/tmp/mbox-benefit-domain-${crypto.randomUUID()}.json`)
  await repository.init()
  const app = Fastify()
  await registerAuthContext(app, { runtimeMode: 'test', readState: () => repository.read() })
  registerBenefitRoutes(app, repository)
  return { app, repository }
}

function actorHeaders(actorId: string) {
  return { 'x-mbox-actor-id': actorId, 'x-mbox-store-id': 'mbox-lujiazui' }
}

describe('benefit HTTP actor binding', () => {
  it('uses the authenticated requester and approver instead of claimed body identities', async () => {
    const { app, repository } = await routeFixture()
    const grant = await app.inject({
      method: 'POST',
      url: '/api/benefits/grants',
      headers: actorHeaders('emp-lin'),
      payload: {
        actorId: 'emp-chen',
        requestedBy: 'emp-chen',
        memberId: 'member-amy',
        templateId: 'benefit-return-50',
        quantity: 1,
        reason: '验证发放身份不可冒用',
        channel: 'none',
        idempotencyKey: 'grant-http-impersonation-0001',
      },
    })
    expect(grant.statusCode).toBe(201)
    expect(grant.json()).toMatchObject({ status: 'pending', requestedBy: 'emp-lin' })

    const denied = await app.inject({
      method: 'POST',
      url: `/api/benefits/grants/${grant.json().id}/decision`,
      headers: actorHeaders('emp-lin'),
      payload: {
        actorId: 'emp-chen',
        decidedBy: 'emp-chen',
        decision: 'granted',
        note: '冒用经理批准',
      },
    })
    expect(denied.statusCode).toBe(403)
    expect((await repository.read()).benefitGrantRequests[0]?.status).toBe('pending')

    const approved = await app.inject({
      method: 'POST',
      url: `/api/benefits/grants/${grant.json().id}/decision`,
      headers: actorHeaders('emp-chen'),
      payload: {
        actorId: 'emp-lin',
        decidedBy: 'emp-lin',
        decision: 'granted',
        note: '经理本人批准',
      },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ status: 'granted', decidedBy: 'emp-chen' })
    expect((await repository.read()).memberBenefits[0]?.approvedBy).toBe('emp-chen')

    await app.close()
    await repository.close()
  })

  it('enforces campaign and policy write roles even when the body claims a manager identity', async () => {
    const { app, repository } = await routeFixture()
    const campaign = await app.inject({
      method: 'POST',
      url: '/api/benefits/campaigns',
      headers: actorHeaders('emp-mia'),
      payload: {
        actorId: 'emp-chen',
        requestedBy: 'emp-chen',
        name: '冒用经理活动',
        segment: 'vip',
        templateId: 'benefit-song',
        channel: 'wecom',
        reason: '验证活动权限',
        idempotencyKey: 'campaign-http-impersonation-0001',
      },
    })
    expect(campaign.statusCode).toBe(403)

    const policy = await app.inject({
      method: 'PUT',
      url: '/api/benefits/policies/policy-server',
      headers: actorHeaders('emp-mia'),
      payload: {
        actorId: 'emp-chen',
        authorizedBy: 'emp-chen',
        templateIds: ['benefit-beer'],
        maxCostPerGrantAmount: 2000,
        maxDailyCostAmount: 10000,
        canApprove: true,
        canLaunchCampaign: true,
      },
    })
    expect(policy.statusCode).toBe(403)
    expect((await repository.read()).benefitGrantPolicies.find((item) => item.id === 'policy-server'))
      .toMatchObject({ canApprove: false, canLaunchCampaign: false })

    await app.close()
    await repository.close()
  })
})
