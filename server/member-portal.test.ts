import { describe, expect, it } from 'vitest'
import { requestBenefitGrant } from './benefit-domain.js'
import { buildMemberPortal } from './member-portal.js'
import { createSeedState } from './seed.js'

describe('member portal projection', () => {
  it('returns only the selected member profile and active benefits', () => {
    const state = createSeedState()
    requestBenefitGrant(state, {
      actorId: 'emp-lin',
      memberId: 'member-amy',
      templateId: 'benefit-beer',
      quantity: 1,
      reason: '会员端投影测试',
      channel: 'none',
      idempotencyKey: 'member-portal-grant',
    }, new Date('2026-07-14T12:00:00.000Z'))
    const portal = buildMemberPortal(state, 'member-amy')
    expect(portal.communityBrand).toMatchObject({
      name: '超嗨部落',
      highlights: ['主题活动', '现场互动', '同好社群'],
    })
    expect(portal.member).toMatchObject({ id: 'member-amy', displayName: 'Amy', phoneMasked: '138****2108' })
    expect(portal.benefits).toHaveLength(1)
    expect(portal.benefits[0]).toMatchObject({ name: '精酿啤酒1杯', remainingQuantity: 1, status: 'available' })
    expect(JSON.stringify(portal)).not.toContain('member-li')
  })

  it('rejects an unknown member instead of returning another account', () => {
    expect(() => buildMemberPortal(createSeedState(), 'unknown-member')).toThrow('会员不存在')
  })

  it('respects the independently configurable member-portal visibility switch', () => {
    const state = createSeedState()
    state.config.communityBrand.memberPortalVisible = false
    expect(buildMemberPortal(state, 'member-amy').communityBrand).toBeNull()
  })
})
