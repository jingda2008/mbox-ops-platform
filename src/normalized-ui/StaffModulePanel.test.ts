import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { paymentPolicyPresentation } from './payment-policy-presentation'

describe('paymentPolicyPresentation', () => {
  it('distinguishes an open operating policy from an unavailable provider', () => {
    expect(paymentPolicyPresentation({
      policyOnlinePaymentEnabled: true,
      onlinePaymentEnabled: false,
      providerConfigured: false,
    })).toEqual({
      summary: '策略开放 · 渠道不可用',
      title: '线上支付当前不可用',
      detail: '经营策略仍为开放。当前渠道配置未就绪，请由管理员核对运行配置。渠道恢复后策略会生效；如需暂停后续线上收款，可关闭经营开关。',
    })
  })

  it('reports the effective open and closed states without ambiguity', () => {
    expect(paymentPolicyPresentation({
      policyOnlinePaymentEnabled: true,
      onlinePaymentEnabled: true,
      providerConfigured: true,
    }).summary).toBe('已开放')
    expect(paymentPolicyPresentation({
      policyOnlinePaymentEnabled: false,
      onlinePaymentEnabled: false,
      providerConfigured: true,
    }).summary).toBe('已关闭')
  })

  it('keeps the exact cross-day blocker fact visible after entering another module',()=>{
    const source=readFileSync(new URL('./StaffModulePanel.tsx',import.meta.url),'utf8')
    expect(source).toContain('data-blocker-fact-id={initialBlockerFact.id}')
    expect(source).toContain('上一营业日阻断的具体事实')
    expect(source).toContain('任何处理仍按当前权限和服务端状态复验')
  })

  it('starts a new tier draft from the documented silver and gold thresholds',()=>{
    const source=readFileSync(new URL('./CustomerExperienceManagementPanel.tsx',import.meta.url),'utf8')
    expect(source).toContain("silverUpgradeGrowth: '5000', silverRetainGrowth: '3000'")
    expect(source).toContain("goldUpgradeGrowth: '20000', goldRetainGrowth: '12000'")
  })
})
