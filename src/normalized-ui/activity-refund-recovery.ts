import {DurableStaffCommand} from './durable-staff-command'

export interface ActivityRefundRequestBody {
  reason:string
  amountMinor?:number
  disposition?:'retain_fulfillment'|'stop_unstarted'
  customerConfirmed?:boolean
}

export function activityRefundCommand<R>(employeeId:string,registrationId:string,send:(body:ActivityRefundRequestBody,key:string)=>Promise<R>){
  return new DurableStaffCommand<ActivityRefundRequestBody,R>(`activity-refund:${employeeId}:${registrationId}`,send,undefined,true)
}

export function pendingActivityRefund(employeeId:string,registrationId:string){
  const pending=activityRefundCommand(employeeId,registrationId,async()=>undefined).pending()
  if(!pending)return null
  const body=pending.body
  if(!body||typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.length>1000||
    (body.amountMinor!==undefined&&(!Number.isSafeInteger(body.amountMinor)||body.amountMinor<=0||!['retain_fulfillment','stop_unstarted'].includes(body.disposition??'')||body.customerConfirmed!==true)))
    throw new Error('原活动退款记录无法读取，请交由管理者核对，勿另建申请。')
  return pending
}
