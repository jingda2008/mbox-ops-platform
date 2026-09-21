/** A pickup is the business delivery confirmation; it is not a measured arrival at the guest table. */
export const MAX_PICKUP_TASKS=50
export const MAX_PICKUP_UNITS=999
export interface PickupUnit {
  kind:'original'|'remake'; unitId:string; originalUnitId:string; taskId:string; itemId:string; orderId:string
  version:number; tableId:string; tableCode:string; tableSessionId:string; locationVersion:number
  productName:string; specification:string; itemNote:string; orderNote:string
  station:'bar'|'kitchen'; pickupLocation:string; readyAt:string|null
}
export interface PickupSelection {kind:'original'|'remake';unitId:string;version:number}
export type PickupCommand =
  | {action:'take';tableId:string;tableSessionId:string;locationVersion:number;units:PickupSelection[]}
  | {action:'undo';receiptId:string;expectedRevision:number;physicalStillAtPickupPoint:true}
export interface PickupDevice {id:string;label:string;mode:'shared_pickup'}
export interface PickupReceipt {
  receiptId:string;revision:number;tableId:string;tableCode:string;tableSessionId:string
  takenAt:string;deliveryConfirmedAt:string;deliverySource:'pickup'
  source:{kind:'shared_pickup_device';deviceId:string;label:string};pickerEmployeeId:null
  units:PickupUnit[];quantity:number;undo:null|{undoId:string;undoneAt:string}
  canUndo:boolean;undoBlockedReason:string|null
}
export interface PickupBoardData {
  /** Read snapshot ordering token, not an optimistic lock across unrelated tables. */
  revision:number;generatedAt:string;commandScope:string;device:PickupDevice|null
  /** An already authorized shared device can finish handoff while new admission is paused. */
  recoveryAvailable:boolean
  setup:{enabled:boolean;configured:boolean;canConfigure:boolean}
  actor:{actionSessionValid:boolean;canPickup:boolean;canUndo:boolean;canConfigure:boolean}
  tables:Array<{tableId:string;tableCode:string;tableSessionId:string;locationVersion:number;units:PickupUnit[]}>
  history:PickupReceipt[]
  attention:Array<{taskId:string;message:string;href:string}>
}
export interface PickupCommandResult {receipt:PickupReceipt;/** Same server transaction-time ordering token as board.revision. */revision:number;replayed:boolean}
export interface PickupDeviceCommand {enabled:boolean;label?:string}
export interface PickupRecoveryCommand {
  staffSessionId:string;commandScope:string;idempotencyKey:string
  request:{kind:'command';command:PickupCommand}|{kind:'device';command:PickupDeviceCommand}
}
export type PickupRecoveryResult={kind:'command';data:PickupCommandResult}|{kind:'device';data:PickupBoardData}
export type PickupErrorCode='PICKUP_INVALID'|'PICKUP_FORBIDDEN'|'PICKUP_DEVICE_REQUIRED'|'PICKUP_SESSION_INVALID'
  |'PICKUP_RECEIPT_NOT_FOUND'|'PICKUP_STALE'|'PICKUP_TABLE_MOVED'|'PICKUP_UNDO_UNAVAILABLE'
  |'PICKUP_ADMISSION_PAUSED'|'IDEMPOTENCY_CONFLICT'|'IDEMPOTENCY_IN_PROGRESS'|'PICKUP_TEMPORARILY_UNAVAILABLE'
export interface PickupErrorBody {error:{code:PickupErrorCode;message:string;commitDisposition:'not_committed'|'unknown'}}

export function parsePickupCommand(value:unknown):PickupCommand {
  const body=record(value)
  if(body.action==='undo'){
    if(body.physicalStillAtPickupPoint!==true)throw new TypeError('请确认这次领取的实物仍在取餐区')
    return {action:'undo',receiptId:uuid(body.receiptId),expectedRevision:integer(body.expectedRevision),physicalStillAtPickupPoint:true}
  }
  if(body.action!=='take'||!Array.isArray(body.units)||body.units.length<1||body.units.length>MAX_PICKUP_UNITS)throw new TypeError('请选择实际取走的出品，每次最多999份')
  const seen=new Set<string>()
  const units=body.units.map(raw=>{const row=record(raw);if(row.kind!=='original'&&row.kind!=='remake')throw new TypeError('出品来源无效')
    const unitId=uuid(row.unitId),key=`${row.kind}:${unitId}`;if(seen.has(key))throw new TypeError('同一份出品不能重复选择');seen.add(key)
    return {kind:row.kind,unitId,version:integer(row.version)} as PickupSelection})
  return {action:'take',tableId:uuid(body.tableId),tableSessionId:uuid(body.tableSessionId),locationVersion:integer(body.locationVersion),units}
}
export function parsePickupDeviceCommand(value:unknown):PickupDeviceCommand {
  const body=record(value);if(typeof body.enabled!=='boolean')throw new TypeError('请选择启用或停用取餐屏')
  if(body.label!==undefined&&(typeof body.label!=='string'||!body.label.trim()||body.label.trim().length>40))throw new TypeError('设备名称请填写1至40字')
  return {enabled:body.enabled,...(typeof body.label==='string'?{label:body.label.trim()}: {})}
}
export function parsePickupRecoveryCommand(value:unknown):PickupRecoveryCommand {
  const body=record(value),request=record(body.request)
  if(typeof body.commandScope!=='string'||!/^[a-f0-9]{64}$/.test(body.commandScope)||typeof body.idempotencyKey!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(body.idempotencyKey))throw new TypeError('原操作凭据无效，请保留原记录')
  const base={staffSessionId:uuid(body.staffSessionId),commandScope:body.commandScope,idempotencyKey:body.idempotencyKey}
  if(request.kind==='command')return {...base,request:{kind:'command',command:parsePickupCommand(request.command)}}
  if(request.kind==='device')return {...base,request:{kind:'device',command:parsePickupDeviceCommand(request.command)}}
  throw new TypeError('原操作类型无效')
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('请提交完整操作');return value as Record<string,unknown>}
function uuid(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new TypeError('原出品标识无效');return value}
function integer(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new TypeError('出品版本无效，请重新读取');return value}
