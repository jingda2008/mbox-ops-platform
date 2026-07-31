export const STAFF_COLLABORATION_EVENT = 'mbox:staff-collaboration-guidance'

export interface StaffCollaborationGuidance {
  message: string
  instruction: string
}

const collaborationPattern = /已提交审批|待审批|等待.{0,6}审批|需要.{0,6}审批|审批(?:权限|额度)|不能审批|权限不足|没有.{0,8}权限|无权|额度为0|额度不足|请由|请联系|另一名|等待(?:领班|经理|主管|店长|管理员|授权人员)|需要(?:领班|经理|主管|店长|管理员|授权人员)|重新派单|接管/

export function staffCollaborationGuidance(message: string): StaffCollaborationGuidance | null {
  const normalized = message.trim()
  if (!normalized || !collaborationPattern.test(normalized)) return null

  let instruction = '请联系值班经理，由值班经理确认责任人并在对应工作台继续处理。'
  if (/退款|退单|退定金/.test(normalized)) {
    instruction = '请让另一名具备退款审批权限且额度足够的员工，进入“收银/支付”完成复核。'
  } else if (/库存|盘点|存酒|差异/.test(normalized)) {
    instruction = '请让另一名具备库存审批权限的员工，进入“库存/存酒”的待审批区处理。'
  } else if (/权益|赠送|赠品|额度为0|赠送授权/.test(normalized)) {
    instruction = '请联系店长或管理员，在“会员权益”或人员权限中完成审批、授权或额度配置。'
  } else if (/出品|KDS|缺货|错品|制作/.test(normalized)) {
    instruction = '请通知当班领班或店长，进入“订单/KDS”查看异常并决定补做、取消或转派。'
  } else if (/预约|定金/.test(normalized)) {
    instruction = '请通知值班经理，进入“预约”查看该记录并完成确认或审批。'
  } else if (/配置|发布/.test(normalized)) {
    instruction = '请联系管理员或有配置发布权限的负责人，进入“配置”完成复核。'
  } else if (/任务|派单|接管|领班/.test(normalized)) {
    instruction = '请联系当班领班，在“任务”中重新派单或接管；现场服务不要等待系统转派才开始。'
  } else if (/交班|关账|结算/.test(normalized)) {
    instruction = '请让另一名具备关账权限的经理使用本人账号，进入“收银/支付”完成复核。'
  }

  return { message: normalized, instruction }
}

export function publishStaffCollaborationGuidance(message: string) {
  if (typeof window === 'undefined') return
  const guidance = staffCollaborationGuidance(message)
  if (!guidance) return
  window.dispatchEvent(new CustomEvent<StaffCollaborationGuidance>(STAFF_COLLABORATION_EVENT, {
    detail: guidance,
  }))
}
