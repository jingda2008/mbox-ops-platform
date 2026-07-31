import { describe, expect, it } from 'vitest'
import { staffCollaborationGuidance } from './staff-action-guidance'

describe('staff collaboration guidance', () => {
  it('turns refund approval boundaries into a precise next step', () => {
    expect(staffCollaborationGuidance('你是申请人，不能审批自己的退款。请由另一名授权人员处理。')).toEqual({
      message: '你是申请人，不能审批自己的退款。请由另一名授权人员处理。',
      instruction: '请让另一名具备退款审批权限且额度足够的员工，进入“收银/支付”完成复核。',
    })
  })

  it('routes production exceptions to the responsible manager workspace', () => {
    expect(staffCollaborationGuidance('精酿啤酒已报告缺货，等待领班或经理处置')?.instruction)
      .toContain('“订单/KDS”')
  })

  it('does not interrupt staff for ordinary successful operations', () => {
    expect(staffCollaborationGuidance('L01已开台，当前4位客人')).toBeNull()
    expect(staffCollaborationGuidance('审批通过，权益已到账')).toBeNull()
  })
})
