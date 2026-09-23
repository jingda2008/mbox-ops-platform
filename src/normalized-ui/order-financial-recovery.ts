import type {NormalizedApiClient} from '../normalized-api'
import type {OrderFinancialRecoveryDecisionInput,OrderFinancialRecoveryRequestInput,OrderFinancialRecoveryResult} from '../shared/order-financial-recovery'

export type FinancialRecoveryCommand = {
  kind:'request'; orderId:string; orderPublicId:string; body:OrderFinancialRecoveryRequestInput
}|{
  kind:'decision'; orderId:string; orderPublicId:string; requestId:string; requestedByEmployeeId:string; dimensions:OrderFinancialRecoveryRequestInput['dimensions']; body:OrderFinancialRecoveryDecisionInput
}
export type FinancialRecoveryIntent=FinancialRecoveryCommand&{version:1;scopeKey:string;employeeId:string;key:string;createdAt:string}
type StoragePort=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>
const flights=new Map<string,Promise<OrderFinancialRecoveryResult>>()
const definiteCodes=new Set(['INVALID','STALE','BLOCKED','PENDING_REQUEST','NOT_FOUND','ALREADY_DECIDED','SELF_APPROVAL','SUPERSEDED'].map(code=>`ORDER_RECOVERY_${code}`))
export function financialRecoveryPermissions(permissions:readonly string[]){
  const view=permissions.includes('reconciliation.view')
  return {view,request:view&&permissions.includes('reconciliation.manage'),approve:view&&permissions.includes('reconciliation.manage')}
}
export function canSendFinancialRecovery(command:FinancialRecoveryCommand,employeeId:string,permissions:readonly string[]){
  const access=financialRecoveryPermissions(permissions)
  const dimensions=command.kind==='request'?command.body.dimensions:command.dimensions
  const loyaltyAllowed=dimensions==='attribution'||permissions.includes('loyalty.accrual.exception.view')&&permissions.includes(command.kind==='request'?'loyalty.accrual.request':'loyalty.accrual.approve')
  return loyaltyAllowed&&(command.kind==='request'?access.request:access.approve&&command.requestedByEmployeeId!==employeeId)
}
export function recoveryDefinitelyNotCommitted(error:unknown){
  const detail=error as {code?:string;status?:number;commitDisposition?:string}|null
  return detail?.commitDisposition==='not_committed'&&definiteCodes.has(detail.code??'')&&[400,404,409,422].includes(detail.status??0)
}
/** postEndpoint unwraps the HTTP data envelope; the journal verifies that value. */
export async function sendFinancialRecoveryIntent(api:NormalizedApiClient,intent:FinancialRecoveryIntent){
  const path=intent.kind==='request'?`/api/staff/order-financial-recovery/${encodeURIComponent(intent.orderId)}/requests`:`/api/staff/order-financial-recovery-requests/${encodeURIComponent(intent.requestId)}/decisions`
  const data=await api.postEndpoint<OrderFinancialRecoveryResult>(path,intent.body,{idempotencyKey:intent.key})
  return {data}
}
/** Each original intent survives refresh, lost response and failed readback. */
export class OrderFinancialRecoveryJournal {
  private readonly prefix:string
  private readonly scopeKey:string
  private readonly employeeId:string
  private readonly storage:StoragePort
  constructor(scopeKey:string,employeeId:string,storage:StoragePort){this.scopeKey=scopeKey;this.employeeId=employeeId;this.storage=storage;this.prefix=`mbox.order-financial-recovery.v1:${scopeKey}:${employeeId}:`}
  pending():FinancialRecoveryIntent|null{
    const found:FinancialRecoveryIntent[]=[]
    for(let i=0;i<this.storage.length;i++){
      const key=this.storage.key(i);if(!key?.startsWith(this.prefix))continue
      let value:unknown
      try{value=JSON.parse(this.storage.getItem(key)??'null')}catch{throw new Error('原恢复凭据无法读取，请保留并联系管理员')}
      if(!validIntent(value,this.scopeKey,this.employeeId)||key!==this.prefix+value.key)throw new Error('原恢复凭据无法读取，请保留并联系管理员')
      found.push(value)
    }
    return found.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key))[0]??null
  }
  async execute(command:FinancialRecoveryCommand|null,permissions:readonly string[],send:(intent:FinancialRecoveryIntent)=>Promise<{data:OrderFinancialRecoveryResult}>,readback:(intent:FinancialRecoveryIntent)=>Promise<void>){
    let intent=this.pending()
    if(intent&&command)throw new Error('已有原操作待恢复，不能用新申请覆盖')
    if(!intent){
      if(!command)throw new Error('没有待恢复的原操作')
      intent=JSON.parse(JSON.stringify({...command,version:1,scopeKey:this.scopeKey,employeeId:this.employeeId,key:`order-recovery-${crypto.randomUUID()}`,createdAt:new Date().toISOString()})) as FinancialRecoveryIntent
      if(!validIntent(intent,this.scopeKey,this.employeeId))throw new Error('请重新读取原订单并填写3至1000字的核对依据')
      if(!canSendFinancialRecovery(intent,this.employeeId,permissions))throw new Error('当前授权不足，申请人与复核人必须不同')
      const encoded=JSON.stringify(intent)
      this.storage.setItem(this.prefix+intent.key,encoded)
      if(this.storage.getItem(this.prefix+intent.key)!==encoded)throw new Error('原操作未能安全保存，请恢复浏览器存储后再提交')
    }
    if(!canSendFinancialRecovery(intent,this.employeeId,permissions))throw new Error('当前无权恢复此操作，请恢复原员工授权后核对')
    const key=this.prefix+intent.key,existing=flights.get(key);if(existing)return existing
    const original=intent;let confirmed=false
    const flight=Promise.resolve().then(()=>send(original)).then(async({data})=>{
      const status=original.kind==='request'?'requested':original.body.decision==='approve'?'approved':'rejected'
      if(!data||data.orderId!==original.orderId||data.orderPublicId!==original.orderPublicId||data.status!==status||!data.requestId||original.kind==='decision'&&(data.requestId!==original.requestId||data.dimensions!==original.dimensions)||original.kind==='request'&&data.dimensions!==original.body.dimensions||!['itemAmountMinor','recommendationAmountMinor','pointsDelta','growthDelta','availablePointsDelta','pendingRecoveryPointsDelta'].every(k=>Number.isSafeInteger(data[k as keyof OrderFinancialRecoveryResult])))throw new Error('原操作回执无法核对，请保留原凭据继续恢复')
      confirmed=true
      await readback(original)
      this.storage.removeItem(key)
      return data
    }).catch((error:unknown)=>{if(!confirmed&&recoveryDefinitelyNotCommitted(error))this.storage.removeItem(key);throw error}).finally(()=>flights.delete(key))
    flights.set(key,flight);return flight
  }
}
function validIntent(value:unknown,scopeKey:string,employeeId:string):value is FinancialRecoveryIntent{
  if(value===null||typeof value!=='object')return false
  const v=value as FinancialRecoveryIntent,b=v.body
  if(v.version!==1||v.scopeKey!==scopeKey||v.employeeId!==employeeId||typeof v.key!=='string'||!/^order-recovery-[0-9a-f-]{36}$/.test(v.key)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt))||typeof v.orderId!=='string'||!v.orderId||typeof v.orderPublicId!=='string'||!v.orderPublicId||!b||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.trim().length>1000||typeof b.basisVersion!=='string'||!/^[0-9a-f]{64}$/.test(b.basisVersion))return false
  if(v.kind==='request')return ['attribution','loyalty','all'].includes(v.body.dimensions)&&Object.keys(b).every(k=>['dimensions','reason','basisVersion'].includes(k))
  return v.kind==='decision'&&['attribution','loyalty','all'].includes(v.dimensions)&&typeof v.requestId==='string'&&!!v.requestId&&typeof v.requestedByEmployeeId==='string'&&!!v.requestedByEmployeeId&&['approve','reject'].includes(v.body.decision)&&Object.keys(b).every(k=>['decision','reason','basisVersion'].includes(k))
}
