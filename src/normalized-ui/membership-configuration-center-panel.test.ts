import { readFileSync } from 'node:fs'
import { describe,expect,it } from 'vitest'

const panel=readFileSync(new URL('./MembershipConfigurationCenterPanel.tsx',import.meta.url),'utf8')
const css=readFileSync(new URL('./membership-configuration-center-panel.css',import.meta.url),'utf8')
const legacy=readFileSync(new URL('./CustomerExperienceManagementPanel.tsx',import.meta.url),'utf8')
const promotion=readFileSync(new URL('./PromotionalLoyaltyPanel.tsx',import.meta.url),'utf8')

describe('membership configuration center operating contract',()=>{
  it('covers all seven normalized domains and four independent permissions',()=>{
    for(const domain of ['base_points','tier_policy','tier_benefits','redemption_catalog',
      'promotion_points','membership_terms','wechat_notifications'])expect(panel).toContain(domain)
    for(const permission of ['loyalty.configuration.view','loyalty.configuration.edit',
      'loyalty.configuration.preview','loyalty.configuration.approve'])expect(panel).toContain(permission)
    expect(panel).toContain('/impact-preview')
    expect(panel).toContain('impactPreviewPublicId')
    expect(panel).not.toContain('impactPreviewAcknowledged')
  })

  it('edits structured controls without exposing an executable JSON editor',()=>{
    expect(panel).toContain('membership-configuration-fields')
    expect(panel).toContain('membership-array')
    expect(panel).toContain("typeof value==='boolean'")
    expect(panel).toContain("typeof value==='number'")
    expect(panel).not.toMatch(/JSON\.parse|JSON\.stringify|textarea[^>]+json/i)
  })

  it('keeps touch targets and readable reflow at 390px and 320px',()=>{
    expect(css).toContain('min-height:44px')
    expect(css).toContain('@media(max-width:900px)')
    expect(css).toContain('@media(max-width:640px)')
    expect(css).toContain('@media(max-width:390px)')
    expect(css).toContain('@media(max-width:320px)')
    expect(css).toMatch(/@media\(max-width:320px\)[^{]*\{[^]*membership-impact-preview dl\{grid-template-columns:1fr\}/)
  })

  it('retires every former client-certified approval request',()=>{
    const former=`${legacy}\n${promotion}`
    expect(former).not.toMatch(/loyalty\/(?:policies|tier-policies|redemption-catalogs|tier-benefit-policies|promotion-policies)[^`'"\n]*\/approve/)
    expect(former).not.toMatch(/membership-terms[^`'"\n]*\/approve/)
    expect(former).not.toContain('impactPreviewAcknowledged')
    expect(former).not.toContain('costAndFulfillmentReviewed')
    expect(former).toContain('审批已移至上方“会员经营配置中心”')
    expect(former).toContain("window.dispatchEvent(new Event('mbox:open-membership-configuration'))")
    expect(former).toContain('前往配置中心审批')
    expect(panel).toContain("window.addEventListener('mbox:open-membership-configuration',open)")
  })
})
