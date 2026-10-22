import type {ActivityServiceLine} from './activity-service.js'

export interface ActivityServiceExceptionCommand {
  action:'hold'|'resume'|'cancel_unmade'|'remake'|'record_issue'
  lineId:string
  expectedVersion:number
  quantity?:number
  reason:string
  remakeFrom?:'ready'|'taken'
  goodsLost?:true
}
export interface ActivityServiceExceptionResult {
  receiptId:string
  action:ActivityServiceExceptionCommand['action']
  lines:ActivityServiceLine[]
}
export function parseActivityServiceException(value:unknown):ActivityServiceExceptionCommand {
  if(!value||typeof value!=='object')throw new TypeError('请选择原出品及处理原因')
  const input=value as Record<string,unknown>
  if(!['hold','resume','cancel_unmade','remake','record_issue'].includes(String(input.action))||typeof input.lineId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.lineId)
    ||!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1||typeof input.reason!=='string'||input.reason.trim().length<2||input.reason.trim().length>500)throw new TypeError('请核对原出品并填写处理原因')
  if(['cancel_unmade','remake'].includes(String(input.action))&&(!Number.isSafeInteger(input.quantity)||Number(input.quantity)<1||Number(input.quantity)>100))throw new TypeError('请填写实际处理份数')
  if(input.action==='remake'&&(!['ready','taken'].includes(String(input.remakeFrom))||input.goodsLost!==true))throw new TypeError('补做前须确认原实物已损耗，不能把补打当补做')
  return {action:input.action as ActivityServiceExceptionCommand['action'],lineId:input.lineId,expectedVersion:Number(input.expectedVersion),reason:input.reason.trim(),
    ...(['cancel_unmade','remake'].includes(String(input.action))?{quantity:Number(input.quantity)}:{}),
    ...(input.action==='remake'?{remakeFrom:input.remakeFrom as 'ready'|'taken',goodsLost:true as const}:{})}
}
