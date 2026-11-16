import type { CashierWorkbenchRefund, CashierWorkbenchView } from './cashier-workbench-contracts.js'

/** A display hint from the current read; the write still checks live authorization. */
export function refundReviewBlockReason(
  actions: Pick<CashierWorkbenchView['actions'],'canApproveRefund'|'refundApprovalLimits'>,
  refund: Pick<CashierWorkbenchRefund,'requestedByEmployeeId'|'amountMinor'|'currency'>,
  employeeId: string,
): string | null {
  if(refund.requestedByEmployeeId===employeeId)return '发起人不能审核或驳回自己的退款，请交给另一名具备复核权限和额度的员工；无人可处理时，请联系管理员配置“退款复核”。'
  if(!actions.canApproveRefund)return '当前员工没有退款复核权限，请交给有权限和额度的其他员工，或联系管理员配置“退款复核”。'
  if(actions.refundApprovalLimits===undefined)return '复核额度尚未读取，请刷新工作台后核对；仍未显示时联系管理员。'
  const limit=actions.refundApprovalLimits[refund.currency]
  if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<=0)return `当前员工未配置有效的 ${refund.currency} 退款复核额度，请交给已配置额度的其他员工，或联系管理员配置“退款复核”。`
  if(refund.amountMinor>limit)return `本笔退款超过当前员工单次复核额度 ${refund.currency} ${(limit/100).toFixed(2)}，请交给额度足够的其他员工。`
  return null
}
