import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source=readFileSync(new URL('./PromotionalLoyaltyPanel.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./promotional-loyalty-panel.css',import.meta.url),'utf8')

describe('promotional loyalty management reachability',()=>{
  it('keeps drafting and publication independently permissioned while approval moves to the configuration center',()=>{
    expect(source).toContain("auth.permissions.includes('loyalty.promotion.view')")
    expect(source).toContain("auth.permissions.includes('loyalty.promotion.manage')")
    expect(source).toContain("auth.permissions.includes('loyalty.promotion.approve')")
    expect(source).toContain("auth.permissions.includes('loyalty.promotion.publish')")
    expect(source).toContain('/api/staff/loyalty/promotion-policies')
    expect(source).not.toContain('/approve')
    expect(source).toContain('审批已移至“会员经营配置中心”')
    expect(source).toContain('/publish')
  })

  it('makes every operating limit visible and configurable without a JSON editor',()=>{
    for(const field of [
      'storeBudgetPoints','perMemberPointsLimit','pointValidityDays','stackingGroup',
      'stackingMode','priority','refundPolicy','budgetReuseAfterRefund','memberLimitReuseAfterRefund','eligibleMemberLevels','triggerKind',
      'points','perMemberAwardLimit','minimumPaidAmountMinor',
    ])expect(source).toContain(field)
    expect(source).not.toMatch(/JSON\.stringify|JSON\.parse|textarea[^>]+json/i)
    expect(source).toContain('旧活动里的积分数字不会自动发放')
  })

  it('stays compact and collapsible on desktop, tablet and phone',()=>{
    expect(source).toContain('aria-expanded={expanded}')
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(css).toContain('@media(max-width:900px)')
    expect(css).toContain('@media(max-width:640px)')
    expect(css).toContain('min-height:44px')
  })
})
