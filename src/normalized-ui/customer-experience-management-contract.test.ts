import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./CustomerExperienceManagementPanel.tsx', import.meta.url), 'utf8')
const configurationSource = readFileSync(new URL('./MembershipConfigurationCenterPanel.tsx', import.meta.url), 'utf8')
const analyticsSource = readFileSync(new URL('./CustomerExperienceAnalyticsPanel.tsx', import.meta.url), 'utf8')
const analyticsCss = readFileSync(new URL('./customer-experience-analytics-panel.css', import.meta.url), 'utf8')
const emergencySource = readFileSync(new URL('./LoyaltyEmergencyControlPanel.tsx', import.meta.url), 'utf8')
const emergencyCss = readFileSync(new URL('./loyalty-emergency-control-panel.css', import.meta.url), 'utf8')
const contactGovernanceSource=readFileSync(new URL('./PersonalContactGovernancePanel.tsx',import.meta.url),'utf8')
const contactGovernanceCss=readFileSync(new URL('./personal-contact-governance-panel.css',import.meta.url),'utf8')

describe('customer experience management reachability contract', () => {
  it('exposes membership recovery verification and independent approval without raw identity data', () => {
    expect(source).toContain("auth.permissions.includes('customer.membership.recovery.verify')")
    expect(source).toContain("auth.permissions.includes('customer.membership.merge.approve')")
    expect(source).toContain("'/api/staff/membership-recovery/cases'")
    expect(source).toContain('/candidates`')
    expect(source).toContain('/select`')
    expect(source).toContain('/${decision}`')
    expect(source).toContain('只显示掩码信息')
    expect(source).toContain('核验人与复核人不能是同一人')
    expect(source).not.toMatch(/candidate\.(?:phone|customerId|membershipId|order)/)
  })

  it('lets authorized staff establish a controlled historical contact without enabling marketing', () => {
    expect(source).toContain("'/api/staff/membership-recovery/verified-contacts'")
    expect(source).toContain('已现场核验手机号')
    expect(source).toContain('不会因此开启营销通知')
  })

  it('separates loyalty drafting, approval, and scheduled publication', () => {
    expect(source).toContain("auth.permissions.includes('loyalty.policy.manage')")
    expect(source).toContain("auth.permissions.includes('loyalty.policy.approve')")
    expect(source).toContain("auth.permissions.includes('loyalty.policy.publish')")
    expect(configurationSource).toContain('/approve`')
    expect(source).not.toContain('/loyalty/policies/${policy.id}/approve`')
    expect(source).toContain('/publish`')
    expect(source).toContain('起草、审批、发布由不同人员完成')
    expect(source).toContain('未来排期不会让当前规则提前失效')
  })

  it('separates redemption catalog approval from publication', () => {
    expect(source).toContain("auth.permissions.includes('loyalty.redemption.catalog.approve')")
    expect(source).toContain("auth.permissions.includes('loyalty.redemption.catalog.publish')")
    expect(source).toContain('独立审批')
    expect(source).toContain('排期发布')
  })

  it('lets authorized staff manage complete membership terms with three-person release', () => {
    expect(source).toContain("auth.permissions.includes('membership.terms.manage')")
    expect(source).toContain("auth.permissions.includes('membership.terms.approve')")
    expect(source).toContain("auth.permissions.includes('membership.terms.publish')")
    expect(source).toContain("'/api/staff/membership-terms/drafts'")
    expect(configurationSource).toContain("domainLabels:Record<Domain,string>={base_points:'基础积分'")
    expect(configurationSource).toContain("membership_terms:'入会条款'")
    expect(source).not.toContain('/membership-terms/${version.version}/approve`')
    expect(source).toContain('/membership-terms/${version.version}/publish`')
    expect(source).toContain('条款全文')
    expect(source).toContain('李艳/店长可起草')
  })

  it('lets staff configure strong tier benefit rules without a free JSON editor', () => {
    expect(source).toContain("'/api/staff/loyalty/tier-benefits'")
    expect(source).toContain("'/api/staff/loyalty/tier-benefit-policies'")
    expect(configurationSource).toContain("tier_benefits:'等级权益'")
    expect(source).not.toContain('/tier-benefit-policies/${policy.id}/approve`')
    expect(source).toContain('/tier-benefit-policies/${policy.id}/publish`')
    expect(source).toContain('发放数量')
    expect(source).toContain('有效天数')
    expect(source).toContain('降级处理')
    expect(source).not.toMatch(/tier-benefit[^\n]{0,200}(?:JSON|json)/)
  })

  it('gives the highest manager a compact independent loyalty emergency panel', () => {
    expect(source).toContain('<LoyaltyEmergencyControlPanel api={api} auth={auth} />')
    expect(emergencySource).toContain("auth.permissions.includes('loyalty.operations.control')")
    expect(emergencySource).toContain('/api/staff/loyalty/operational-controls/')
    expect(emergencySource).toContain('暂停不会停止收款、出单或退款')
    expect(emergencySource).toContain('笔已付款订单待补算')
    expect(emergencyCss).toMatch(/min-height:\s*44px/)
    expect(emergencyCss).toMatch(/@media \(max-width:760px\)[\s\S]*grid-template-columns:1fr/)
    expect(emergencySource).not.toMatch(/JSON|json/)
  })

  it('offers compact, operational filters without turning observations into automatic decisions', () => {
    for (const field of ['productId','employeeId','tableCode','partySize','occasion','performancePhase']) {
      expect(analyticsSource).toContain(field)
    }
    expect(analyticsSource).toContain('来店场景（同桌事实）')
    expect(analyticsSource).toContain('应用筛选')
    expect(analyticsSource).toContain('view.decisionBoundary')
    expect(analyticsSource).not.toMatch(/自动(?:改价|修改菜单|处分员工)/)
    expect(analyticsCss).toMatch(/min-height:\s*44px/)
    expect(analyticsCss).toMatch(/@media \(max-width: 390px\)[\s\S]*\.ce-analytics__filters \{ grid-template-columns: 1fr; \}/)
  })

  it('makes retention, hold and disposition evidence reachable without exposing protected material',()=>{
    expect(source).toContain('<PersonalContactGovernancePanel api={api} auth={auth} />')
    for(const permission of ['privacy.contact.retention.view','privacy.contact.retention.draft','privacy.contact.retention.approve','privacy.contact.retention.publish','privacy.contact.legal_hold']){
      expect(contactGovernanceSource).toContain(permission)
    }
    expect(contactGovernanceSource).toContain('/api/staff/personal-contact-governance/evidence')
    expect(contactGovernanceSource).toContain('起草保留策略')
    expect(contactGovernanceSource).toContain('独立审批')
    expect(contactGovernanceSource).toContain('第三人发布')
    expect(contactGovernanceSource).toContain('建立法定保留')
    expect(contactGovernanceSource).toContain('eligibleResources')
    expect(contactGovernanceSource).toContain('请选择当前门店的联系方式版本')
    expect(contactGovernanceSource).toContain('清除证据')
    expect(contactGovernanceSource).not.toMatch(/contactHash|encryptedContact|encryptionKeyId|employeeId/)
    expect(contactGovernanceCss).toContain('min-height:44px')
    expect(contactGovernanceCss).toContain('@media(max-width:390px)')
  })
})
