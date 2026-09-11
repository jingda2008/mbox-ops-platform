export interface PaymentPolicyPresentationInput {
  policyOnlinePaymentEnabled: boolean
  onlinePaymentEnabled: boolean
  providerConfigured: boolean
  providerDiagnostics?:{checkedAt:string;reasons:string[]}
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
    detail: `经营策略仍为开放。${policy.providerDiagnostics?.reasons.join('；')||'当前渠道配置未就绪，请由管理员核对运行配置。'}${policy.providerDiagnostics?` 检查时点：${new Date(policy.providerDiagnostics.checkedAt).toLocaleString('zh-CN')}。`:''}渠道恢复后策略会生效；如需暂停后续线上收款，可关闭经营开关。`,
  }
  return {
    summary: '已关闭',
    title: '线上支付已关闭',
    detail: '仅阻止新的支付发起；已有支付的验签回调、查单、退款和对账必须继续处理。',
  }
}
