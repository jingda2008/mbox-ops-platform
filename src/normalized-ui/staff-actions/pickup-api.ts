import {parsePickupCommand,parsePickupDeviceCommand,type PickupBoardData,type PickupCommand,type PickupCommandResult,type PickupDeviceCommand,type PickupReceipt,type PickupUnit} from '../../shared/pickup-workflow'
import {STAFF_SESSION_BINDING_HEADER} from '../../shared/staff-session-binding'
import {staffErrorMessage,staffUnavailableMessage} from '../../shared/staff-error-message'
import {pickupLines} from './pickup-board-state'

export type PickupRequest={kind:'command';command:PickupCommand}|{kind:'device';command:PickupDeviceCommand}
export type PickupMutationResult={kind:'command';data:PickupCommandResult}|{kind:'device';data:PickupBoardData}
export interface PickupAttempt {key:string;staffSessionId:string;commandScope:string;createdAt:string;request:PickupRequest;result?:PickupMutationResult;
  preview?:{title:string;lines:string[]};recoveredBy?:{staffSessionId:string;commandScope:string}}
export interface PickupRecovery {attempt:PickupAttempt|null;previousAttempt:PickupAttempt|null;count:number;error:string|null;otherSession:boolean}
export interface PickupApiPort {
  loadBoard(signal?:AbortSignal):Promise<PickupBoardData>
  recovery():PickupRecovery
  run(command:PickupCommand):Promise<PickupMutationResult>
  configureDevice(command:PickupDeviceCommand):Promise<PickupMutationResult>
  recover():Promise<PickupMutationResult>
  recoverPrevious():Promise<PickupMutationResult>
  acknowledgeRead(board:PickupBoardData):void
}
export type PickupStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>
export interface PickupApiOptions {staffSessionId:string;fetch?:typeof fetch;storage?:PickupStorage|null;timeoutMs?:number;createIdempotencyKey?:()=>string}
export class PickupApiError extends Error {
  readonly code:string
  readonly status:number|null
  readonly commitDisposition:'not_committed'|'unknown'
  constructor(message:string,code:string,status:number|null=null,commitDisposition:'not_committed'|'unknown'='unknown'){
    super(message);this.name='PickupApiError';this.code=code;this.status=status;this.commitDisposition=commitDisposition
  }
}
const prefix='mbox.pickup-command.v1:'
const flights=new Map<string,Promise<PickupMutationResult>>()
const clone=<T,>(value:T):T=>structuredClone(value)
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const text=(value:unknown):value is string=>typeof value==='string'
const id=(value:unknown):value is string=>text(value)&&value.length>0&&value.length<=256
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const date=(value:unknown):value is string=>text(value)&&Number.isFinite(Date.parse(value))
const boolean=(value:unknown):value is boolean=>typeof value==='boolean'
const nullableText=(value:unknown)=>value===null||text(value)
function validUnit(value:unknown):value is PickupUnit{
  if(!object(value)||!['original','remake'].includes(String(value.kind))||!['bar','kitchen'].includes(String(value.station)))return false
  return ['unitId','originalUnitId','taskId','itemId','orderId','tableId','tableCode','tableSessionId'].every(key=>id(value[key]))
    &&['productName','specification','itemNote','orderNote','pickupLocation'].every(key=>text(value[key]))
    &&integer(value.version)&&integer(value.locationVersion)&&(value.readyAt===null||date(value.readyAt))
}
function validReceipt(value:unknown):value is PickupReceipt{
  if(!object(value)||!['receiptId','tableId','tableCode','tableSessionId'].every(key=>id(value[key]))||!integer(value.revision)
    ||!date(value.takenAt)||value.deliveryConfirmedAt!==value.takenAt||value.deliverySource!=='pickup'||value.pickerEmployeeId!==null
    ||!object(value.source)||value.source.kind!=='shared_pickup_device'||!id(value.source.deviceId)||!text(value.source.label)
    ||!Array.isArray(value.units)||!value.units.length||!value.units.every(validUnit)||value.quantity!==value.units.length
    ||new Set(value.units.map(unit=>`${unit.kind}:${unit.unitId}`)).size!==value.units.length||!boolean(value.canUndo)||!nullableText(value.undoBlockedReason))return false
  return value.undo===null||(object(value.undo)&&id(value.undo.undoId)&&date(value.undo.undoneAt)&&value.canUndo===false)
}
export function isPickupBoard(value:unknown):value is PickupBoardData{
  if(!object(value)||!integer(value.revision)||!date(value.generatedAt)||!id(value.commandScope)||!boolean(value.recoveryAvailable)||!object(value.setup)||!object(value.actor))return false
  const setup=value.setup,actor=value.actor
  if(!['enabled','configured','canConfigure'].every(key=>boolean(setup[key]))||!['actionSessionValid','canPickup','canUndo','canConfigure'].every(key=>boolean(actor[key])))return false
  if(value.device!==null&&(!object(value.device)||!id(value.device.id)||!text(value.device.label)||value.device.mode!=='shared_pickup'))return false
  if(!Array.isArray(value.tables)||!value.tables.every(table=>object(table)&&id(table.tableId)&&id(table.tableCode)&&id(table.tableSessionId)&&integer(table.locationVersion)
    &&Array.isArray(table.units)&&table.units.every(unit=>validUnit(unit)&&unit.tableId===table.tableId&&unit.tableSessionId===table.tableSessionId&&unit.locationVersion===table.locationVersion)))return false
  const units=value.tables.flatMap(table=>table.units as PickupUnit[])
  if(new Set(units.map(unit=>`${unit.kind}:${unit.unitId}`)).size!==units.length)return false
  if(value.device===null&&units.length!==0)return false
  return Array.isArray(value.history)&&value.history.every(validReceipt)&&Array.isArray(value.attention)&&value.attention.every(item=>object(item)&&id(item.taskId)&&text(item.message)&&text(item.href)&&/^\/staff\//.test(item.href))
}
function validResult(value:unknown,request:PickupRequest):value is PickupMutationResult{
  if(!object(value)||value.kind!==request.kind)return false
  if(request.kind==='device')return isPickupBoard(value.data)
  if(!object(value.data)||!integer(value.data.revision)||!boolean(value.data.replayed)||!validReceipt(value.data.receipt))return false
  const receipt=value.data.receipt,command=request.command
  if(command.action==='undo')return receipt.receiptId===command.receiptId&&receipt.undo!==null&&receipt.revision>=command.expectedRevision
  const wanted=new Set(command.units.map(unit=>`${unit.kind}:${unit.unitId}`))
  return receipt.undo===null&&receipt.tableId===command.tableId&&receipt.tableSessionId===command.tableSessionId&&receipt.quantity===wanted.size
    &&receipt.units.every(unit=>wanted.has(`${unit.kind}:${unit.unitId}`))
}
function normalizedRequest(value:unknown):PickupRequest{
  if(!object(value))throw new TypeError('原取餐操作无法读取')
  if(value.kind==='command')return {kind:'command',command:parsePickupCommand(value.command)}
  if(value.kind==='device')return {kind:'device',command:parsePickupDeviceCommand(value.command)}
  throw new TypeError('原取餐操作无法读取')
}
function attemptFrom(value:unknown):PickupAttempt{
  if(!object(value)||!id(value.key)||!id(value.staffSessionId)||!id(value.commandScope)||!date(value.createdAt))throw new TypeError('原取餐操作无法读取')
  const request=normalizedRequest(value.request)
  if('result' in value&&!validResult(value.result,request))throw new TypeError('原取餐回执无法读取')
  if('preview' in value&&(!object(value.preview)||!text(value.preview.title)||!Array.isArray(value.preview.lines)||!value.preview.lines.every(text)))throw new TypeError('原取餐内容无法读取')
  if('recoveredBy' in value&&(!object(value.recoveredBy)||!id(value.recoveredBy.staffSessionId)||!id(value.recoveredBy.commandScope)))throw new TypeError('原取餐恢复记录无法读取')
  return {key:value.key,staffSessionId:value.staffSessionId,commandScope:value.commandScope,createdAt:value.createdAt,request,
    ...('result' in value?{result:value.result as PickupMutationResult}:{}),...('preview' in value?{preview:value.preview as PickupAttempt['preview']}:{}),
    ...('recoveredBy' in value?{recoveredBy:value.recoveredBy as PickupAttempt['recoveredBy']}:{})}
}
function optionalStorage():PickupStorage|null{try{return typeof localStorage==='undefined'?null:localStorage}catch{return null}}
function storageError(message='无法保存原取餐操作，请恢复设备存储后重试'){return new PickupApiError(message,'PICKUP_RECOVERY_STORAGE')}

/** Append-only pending keys survive competing tabs; no unknown command is replaced by a new body. */
export class PickupApi implements PickupApiPort {
  private readonly session:string
  private readonly send:typeof fetch
  private readonly storage:PickupStorage|null
  private readonly timeoutMs:number
  private readonly createKey:()=>string
  private scope:string|null=null
  private board:PickupBoardData|null=null
  constructor(options:PickupApiOptions){this.session=options.staffSessionId;this.send=options.fetch??globalThis.fetch.bind(globalThis);this.storage=options.storage===undefined?optionalStorage():options.storage;this.timeoutMs=options.timeoutMs??8000;this.createKey=options.createIdempotencyKey??(()=>crypto.randomUUID())}
  async loadBoard(signal?:AbortSignal):Promise<PickupBoardData>{
    let data:unknown
    try{data=await this.request('/api/commerce/pickup-board',{method:'GET',signal})}
    catch(error){
      if(!(error instanceof PickupApiError)||error.code!=='PICKUP_SESSION_INVALID'||signal?.aborted)throw error
      // Renew only the live lease, then read once. Never replay a pickup command here.
      await this.request('/api/auth/heartbeat',{method:'POST',signal,body:'{}',headers:{'content-type':'application/json'}})
      data=await this.request('/api/commerce/pickup-board',{method:'GET',signal})
    }
    if(!isPickupBoard(data))throw new PickupApiError('取餐内容暂时无法读取，请重新读取','PICKUP_INVALID_RESPONSE')
    this.scope=data.commandScope;this.board=data
    return data
  }
  recovery():PickupRecovery{
    try{
      const all=this.stored(),mine=all.filter(attempt=>this.belongsToCurrent(attempt)),previous=all.filter(attempt=>!this.belongsToCurrent(attempt))
      return {attempt:mine[0]??null,previousAttempt:previous[0]??null,count:all.length,otherSession:previous.length>0,error:null}
    }catch{return {attempt:null,previousAttempt:null,count:0,otherSession:false,error:'本设备的原取餐记录暂时无法读取，请恢复存储后再操作'}}
  }
  run(command:PickupCommand){return this.execute({kind:'command',command:parsePickupCommand(command)})}
  configureDevice(command:PickupDeviceCommand){return this.execute({kind:'device',command:parsePickupDeviceCommand(command)})}
  recover():Promise<PickupMutationResult>{
    const recovery=this.recovery()
    if(recovery.error)throw storageError(recovery.error)
    if(!recovery.attempt)throw new PickupApiError('没有待恢复的取餐操作','PICKUP_NO_PENDING',null,'not_committed')
    return this.execute(recovery.attempt.request)
  }
  /** Explicitly authorized by the current staff session; the server proves this is the same real device. */
  recoverPrevious():Promise<PickupMutationResult>{
    if(!this.scope)throw new PickupApiError('请先读取当前取餐屏','PICKUP_NOT_LOADED')
    const state=this.recovery(),pending=state.previousAttempt
    if(state.error)throw storageError(state.error)
    if(state.attempt)throw new PickupApiError('请先核对当前登录的原操作','PICKUP_ORIGINAL_PENDING')
    if(!pending)throw new PickupApiError('没有本设备上次操作待核对','PICKUP_NO_PENDING',null,'not_committed')
    const recoveredBy={staffSessionId:this.session,commandScope:this.scope},flightKey=`${this.storageKey(pending)}:recovery:${this.session}`
    const existing=flights.get(flightKey);if(existing)return existing
    const operation=this.request('/api/commerce/pickup-board/recovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({staffSessionId:pending.staffSessionId,commandScope:pending.commandScope,idempotencyKey:pending.key,request:pending.request})})
      .then(value=>{if(!validResult(value,pending.request))throw new PickupApiError('上次操作回执暂时未读全，请继续核对','PICKUP_INVALID_RESPONSE')
        this.save({...pending,result:value,recoveredBy});return value})
      .catch((error:unknown)=>{if(error instanceof PickupApiError&&error.commitDisposition==='not_committed'&&!['IDEMPOTENCY_CONFLICT','IDEMPOTENCY_IN_PROGRESS'].includes(error.code))this.remove(pending);throw error})
      .finally(()=>flights.delete(flightKey))
    flights.set(flightKey,operation);return operation
  }
  acknowledgeRead(board:PickupBoardData):void{
    const pending=this.recovery().attempt
    if(!pending?.result)return
    const expectedScope=pending.recoveredBy?.staffSessionId===this.session?pending.recoveredBy.commandScope:pending.commandScope
    if(!isPickupBoard(board)||board.commandScope!==expectedScope||board.revision<pending.result.data.revision)throw new PickupApiError('最新取餐内容尚未读回，请继续恢复原操作','PICKUP_READBACK_PENDING')
    this.remove(pending)
  }
  private storageKey(attempt:Pick<PickupAttempt,'staffSessionId'|'commandScope'|'key'>){return `${prefix}${encodeURIComponent(attempt.staffSessionId)}:${encodeURIComponent(attempt.commandScope)}:${encodeURIComponent(attempt.key)}`}
  private belongsToCurrent(attempt:PickupAttempt){return attempt.staffSessionId===this.session&&attempt.commandScope===this.scope||attempt.recoveredBy?.staffSessionId===this.session&&attempt.recoveredBy.commandScope===this.scope}
  private preview(request:PickupRequest):PickupAttempt['preview']{
    if(request.kind==='device')return {title:request.command.enabled?'将本机设为取餐屏':'停用本机取餐屏',lines:request.command.label?[request.command.label]:[]}
    const command=request.command
    const receipt=command.action==='undo'?this.board?.history.find(row=>row.receiptId===command.receiptId):null
    const table=command.action==='take'?this.board?.tables.find(row=>row.tableId===command.tableId&&row.tableSessionId===command.tableSessionId):null
    const units=command.action==='undo'?receipt?.units??[]:table?.units.filter(unit=>command.units.some(ref=>ref.kind===unit.kind&&ref.unitId===unit.unitId))??[]
    return {title:command.action==='take'?`${table?.tableCode??'原桌'} · 确认取走 ${command.units.length}份`:`${receipt?.tableCode??'原桌'} · 撤回本次取走`,
      lines:pickupLines(units).map(line=>`${line.location} · ${line.name} × ${line.units.length}${line.notes?` · ${line.notes}`:''}`)}
  }
  private stored():PickupAttempt[]{
    if(!this.storage)throw storageError()
    const attempts:PickupAttempt[]=[]
    for(let index=0;index<this.storage.length;index++){
      const key=this.storage.key(index)
      if(!key?.startsWith(prefix))continue
      const raw=this.storage.getItem(key)
      if(raw===null)continue
      const attempt=attemptFrom(JSON.parse(raw))
      if(this.storageKey(attempt)!==key)throw storageError()
      attempts.push(attempt)
    }
    return attempts.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key))
  }
  private save(attempt:PickupAttempt):void{
    if(!this.storage)throw storageError()
    const key=this.storageKey(attempt),value=JSON.stringify(attempt)
    try{this.storage.setItem(key,value);if(this.storage.getItem(key)!==value)throw storageError()}catch{throw storageError()}
  }
  private remove(attempt:PickupAttempt):void{
    if(!this.storage)throw storageError()
    const key=this.storageKey(attempt)
    try{this.storage.removeItem(key);if(this.storage.getItem(key)!==null)throw storageError()}catch{throw storageError('原操作已经核对，但设备记录尚未清理，请恢复存储后重试')}
  }
  private execute(request:PickupRequest):Promise<PickupMutationResult>{
    if(!this.scope)throw new PickupApiError('请先读取当前取餐屏','PICKUP_NOT_LOADED',null,'not_committed')
    const state=this.recovery()
    if(state.error)throw storageError(state.error)
    if(state.previousAttempt&&!state.attempt)throw new PickupApiError('请先核对并恢复本设备上次操作','PICKUP_PREVIOUS_PENDING')
    if(state.attempt&&JSON.stringify(state.attempt.request)!==JSON.stringify(request))throw new PickupApiError('请先恢复原操作，再领取下一批或更改取餐屏设置','PICKUP_ORIGINAL_PENDING')
    const pending=state.attempt??{key:this.createKey(),staffSessionId:this.session,commandScope:this.scope,createdAt:new Date().toISOString(),request:clone(request),preview:this.preview(request)}
    if(pending.result)return Promise.resolve(clone(pending.result))
    const flightKey=this.storageKey(pending),existing=flights.get(flightKey)
    if(existing)return existing
    this.save(pending)
    const operation=this.post(pending).then(result=>{this.save({...pending,result});return result}).catch((error:unknown)=>{
      if(error instanceof PickupApiError&&error.commitDisposition==='not_committed'&&!['IDEMPOTENCY_CONFLICT','IDEMPOTENCY_IN_PROGRESS'].includes(error.code))this.remove(pending)
      throw error
    }).finally(()=>flights.delete(flightKey))
    flights.set(flightKey,operation)
    return operation
  }
  private async post(attempt:PickupAttempt):Promise<PickupMutationResult>{
    const endpoint=attempt.request.kind==='device'?'/api/commerce/pickup-board/device':'/api/commerce/pickup-board/commands'
    const data=await this.request(endpoint,{method:'POST',headers:{'content-type':'application/json','idempotency-key':attempt.key},body:JSON.stringify(attempt.request.command)})
    const result={kind:attempt.request.kind,data}
    if(!validResult(result,attempt.request))throw new PickupApiError('原操作回执暂时未读全，请恢复原操作','PICKUP_INVALID_RESPONSE')
    return result
  }
  private async request(url:string,init:RequestInit):Promise<unknown>{
    const abort=new AbortController(),caller=init.signal
    const cancel=()=>abort.abort()
    if(caller?.aborted)cancel();else caller?.addEventListener('abort',cancel,{once:true})
    const timeout=globalThis.setTimeout(cancel,this.timeoutMs),headers=new Headers(init.headers)
    headers.set('accept','application/json');headers.set(STAFF_SESSION_BINDING_HEADER,this.session)
    try{
      const response=await this.send(url,{...init,headers,signal:abort.signal,credentials:'include'})
      const payload:unknown=await response.json().catch(()=>null)
      if(!response.ok){
        const error=object(payload)&&object(payload.error)?payload.error:null
        const disposition=error?.commitDisposition==='not_committed'?'not_committed':'unknown'
        const fallback=response.status>=500?staffUnavailableMessage(init.method??'GET'):[401,403].includes(response.status)?'当前登录或取餐权限需要核对，请恢复原登录后继续':'操作未完成，请重新核对当前出品'
        throw new PickupApiError(staffErrorMessage(error?.message,fallback,response.status),text(error?.code)?error.code:'PICKUP_HTTP_ERROR',response.status,disposition)
      }
      if(!object(payload)||!('data' in payload))throw new PickupApiError('取餐结果暂时无法读取，请核对原操作','PICKUP_INVALID_RESPONSE')
      return payload.data
    }catch(error){
      if(error instanceof PickupApiError)throw error
      if(caller?.aborted)throw new PickupApiError('读取已取消','PICKUP_ABORTED')
      throw new PickupApiError(abort.signal.aborted?'连接超时，请恢复原取餐结果':'连接中断，请恢复原取餐结果',abort.signal.aborted?'PICKUP_TIMEOUT':'PICKUP_NETWORK')
    }finally{clearTimeout(timeout);caller?.removeEventListener('abort',cancel)}
  }
}
