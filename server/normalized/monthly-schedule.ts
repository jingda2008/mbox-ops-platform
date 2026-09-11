import type {ScopedTransaction} from './transaction-runner.js'
import type {CreateScheduleInput} from './schedule-repository.js'

export interface MonthlyScheduleInput {month:string;slots:CreateScheduleInput[]}
export function readMonthlySchedule(value:unknown):MonthlyScheduleInput {
 if(!value||typeof value!=='object')throw new TypeError('请填写月份和场次')
 const row=value as Record<string,unknown>
 if(typeof row.month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(row.month))throw new TypeError('月份格式应为年-月')
 if(!Array.isArray(row.slots)||row.slots.length<1||row.slots.length>155)throw new TypeError('每次请提交1至155个演出时段')
 const slots=row.slots.map((value,index)=>{
  if(!value||typeof value!=='object')throw new TypeError(`第${index+1}场配置无效`)
  const slot=value as Record<string,unknown>
  if(typeof slot.performerId!=='string'||!/^[0-9a-f-]{36}$/i.test(slot.performerId))throw new TypeError(`第${index+1}场请选择歌手`)
  if(typeof slot.startsAt!=='string'||typeof slot.endsAt!=='string')throw new TypeError(`第${index+1}场请填写起止时间`)
  const start=Date.parse(slot.startsAt),end=Date.parse(slot.endsAt)
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>24*60*60*1000)throw new TypeError(`第${index+1}场起止时间无效，单场不得超过24小时`)
  if(new Date(start+8*3600000).toISOString().slice(0,7)!==row.month)throw new TypeError(`第${index+1}场开始日期不在所选月份`)
  return {performerId:slot.performerId,startsAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),sortOrder:index}
 }).sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.performerId.localeCompare(b.performerId))
 return {month:row.month,slots}
}
export async function previewMonthlySchedule(tx:ScopedTransaction,input:MonthlyScheduleInput){
 const existing=(await tx.query<{id:string;performer_id:string;name:string;starts_at:string;ends_at:string}>(`
 SELECT s.id,s.performer_id,p.stage_name AS name,s.starts_at::text,s.ends_at::text FROM mbox.schedules s
 JOIN mbox.performers p ON p.tenant_id=s.tenant_id AND p.store_id=s.store_id AND p.id=s.performer_id
 WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.status<>'cancelled' AND s.starts_at<$4::timestamptz AND s.ends_at>$3::timestamptz`,
 [tx.scope.tenantId,tx.scope.storeId,input.slots[0]!.startsAt,input.slots.reduce((end,slot)=>slot.endsAt>end?slot.endsAt:end,input.slots[0]!.endsAt)])).rows
 const performers=(await tx.query<{id:string;stage_name:string;status:string}>('SELECT id,stage_name,status FROM mbox.performers WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[])',[tx.scope.tenantId,tx.scope.storeId,[...new Set(input.slots.map(slot=>slot.performerId))]])).rows
 const overlap=(a:{startsAt:string;endsAt:string},b:{startsAt:string;endsAt:string})=>Date.parse(a.startsAt)<Date.parse(b.endsAt)&&Date.parse(a.endsAt)>Date.parse(b.startsAt)
 return input.slots.map((slot,index)=>{
  const reasons:string[]=[]
  const performer=performers.find(p=>p.id===slot.performerId)
  if(!performer||performer.status!=='active')reasons.push('所选歌手未启用或不存在，请重新选择')
  const exact=existing.find(s=>s.performer_id===slot.performerId&&Date.parse(s.starts_at)===Date.parse(slot.startsAt)&&Date.parse(s.ends_at)===Date.parse(slot.endsAt))
  for(const other of existing)if(other.id!==exact?.id&&overlap(slot,{startsAt:other.starts_at,endsAt:other.ends_at}))reasons.push(`与已发布场次 ${other.name}（${new Date(other.starts_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}）重叠，请调整本场或先办理原场改期`)
  for(let j=0;j<index;j++)if(overlap(slot,input.slots[j]!))reasons.push(`与本次第${j+1}场时间重叠，请修改时间或移除重复场次`)
  return {...slot,performerName:performer?.stage_name??'未找到歌手',existingId:exact?.id??null,reasons}
 })
}
