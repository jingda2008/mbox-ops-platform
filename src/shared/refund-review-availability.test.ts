import {describe,expect,it} from 'vitest'
import {refundReviewBlockReason as reason} from './refund-review-availability.js'
const refund={requestedByEmployeeId:'requester',amountMinor:2000,currency:'CNY'}
describe('refund action availability',()=>{
 it('uses the same currency, exact amount boundary and separate reviewer',()=>{
  const actions={canApproveRefund:true,refundApprovalLimits:{CNY:2000,USD:10000}}
  expect(reason(actions,refund,'reviewer')).toBeNull()
  expect(reason(actions,{...refund,amountMinor:2001},'reviewer')).toContain('20.00')
  expect(reason(actions,refund,'requester')).toContain('发起人不能')
  expect(reason({...actions,canApproveRefund:false},refund,'reviewer')).toContain('没有退款复核权限')
 })
 it.each([undefined,{}, {CNY:0},{CNY:-1},{CNY:NaN},{CNY:Infinity},{CNY:0.5},{USD:999999}] as Array<Record<string,number>|undefined>)('fails closed for missing or unusable limit %j',refundApprovalLimits=>expect(reason({canApproveRefund:true,refundApprovalLimits},refund,'reviewer')).not.toBeNull())
})
