import { describe, expect, it } from 'vitest'
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
      detail: '经营策略仍为开放；渠道恢复后会自动生效。如不希望自动恢复，请立即关闭线上支付策略。',
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
})
