export interface PaymentPolicyPresentationInput {
  policyOnlinePaymentEnabled: boolean
  onlinePaymentEnabled: boolean
  providerConfigured: boolean
}

export function paymentPolicyPresentation(policy: Readonly<PaymentPolicyPresentationInput>): {
  summary: string
  title: string
  detail: string
} {
  if (policy.onlinePaymentEnabled) return {
    summary: '已开放',
    title: '线上支付已开放',
    detail: '顾客桌边点单和员工协助订单可发起线上支付。',
  }
  if (policy.policyOnlinePaymentEnabled && !policy.providerConfigured) return {
    summary: '策略开放 · 渠道不可用',
    title: '线上支付当前不可用',
    detail: '经营策略仍为开放；渠道恢复后会自动生效。如不希望自动恢复，请立即关闭线上支付策略。',
  }
  return {
    summary: '已关闭',
    title: '线上支付已关闭',
    detail: '仅阻止新的支付发起；已有支付的验签回调、查单、退款和对账必须继续处理。',
  }
}
