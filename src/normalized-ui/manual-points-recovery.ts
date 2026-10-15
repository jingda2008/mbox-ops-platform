import type {ManualPointsRequest,ManualPointsDecision,ManualPointsResult} from '../shared/manual-points'
export type ManualPointsCommand={kind:'request';body:ManualPointsRequest}|{kind:'decision';body:ManualPointsDecision;requestedBy:string}
export type ManualPointsIntent=ManualPointsCommand&{version:1;scopeKey:string;employeeId:string;key:string}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>
const flights=new Map<string,Promise<ManualPointsResult>>()
export class ManualPointsRecovery {
 private readonly storageKey:string
 private readonly scopeKey:string
 private readonly employeeId:string
 private readonly storage:StoragePort
 constructor(scopeKey:string,employeeId:string,storage:StoragePort){this.scopeKey=scopeKey;this.employeeId=employeeId;this.storage=storage;this.storageKey=`mbox.manual-points.v1:${scopeKey}:${employeeId}`}
 pending():ManualPointsIntent|null{
  const raw=this.storage.getItem(this.storageKey);if(!raw)return null
  let value:unknown;try{value=JSON.parse(raw)}catch{throw new Error('原积分请求损坏，请保留记录并联系管理员')}
  if(!valid(value,this.scopeKey,this.employeeId))throw new Error('原积分请求无法核验，请保留记录并联系管理员')
  return value
 }
 async execute(command:ManualPointsCommand|null,permissions:readonly string[],send:(i:ManualPointsIntent)=>Promise<ManualPointsResult>,readback:()=>Promise<void>){
  let intent=this.pending()
  if(intent&&command)throw new Error('请先恢复原操作，不能覆盖尚未确认的积分请求')
  if(!intent){
   if(!command)throw new Error('没有待恢复的积分请求')
   intent=structuredClone({...command,version:1,scopeKey:this.scopeKey,employeeId:this.employeeId,key:`manual-points-${crypto.randomUUID()}`}) as ManualPointsIntent
   if(!valid(intent,this.scopeKey,this.employeeId))throw new Error('请核对会员号、积分数量和实际依据')
   this.authorize(intent,permissions)
   const encoded=JSON.stringify(intent);this.storage.setItem(this.storageKey,encoded)
   if(this.storage.getItem(this.storageKey)!==encoded)throw new Error('无法保存原操作，未提交积分请求')
  }
  this.authorize(intent,permissions)
  const flightKey=this.storageKey+intent.key,existing=flights.get(flightKey);if(existing)return existing
  const original=intent
  let receiptConfirmed=false
  const operation=Promise.resolve().then(()=>send(original)).then(async result=>{
   const expected=original.kind==='request'?'requested':original.body.decision==='approve'?'approved':'rejected'
   if(!result||result.status!==expected||typeof result.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.requestId)||(expected!=='rejected'&&(!Number.isSafeInteger(result.balance)||result.balance!<0||!Number.isSafeInteger(result.pendingRecoveryPoints)||result.pendingRecoveryPoints!<0))||!Number.isSafeInteger(result.pointsDelta)||!Number.isSafeInteger(result.availableDelta)||(original.kind==='request'&&result.pointsDelta!==original.body.pointsDelta)||(original.kind==='decision'&&result.requestId!==original.body.requestId))throw new Error('积分回执不完整，请恢复原请求')
   receiptConfirmed=true
   await readback();this.storage.removeItem(this.storageKey);return result
  }).catch(error=>{
   const e=error as {code?:string;commitDisposition?:string;status?:number}
   if(!receiptConfirmed&&e.status===409&&e.commitDisposition==='not_committed'&&new Set(['INVALID','NOT_FOUND','SELF_APPROVAL','DECIDED','MEMBER_CHANGED','POLICY_CHANGED','LIMIT','MEMBER','POLICY','PAUSED','BALANCE'].map(c=>'MANUAL_POINTS_'+c)).has(e.code??''))this.storage.removeItem(this.storageKey)
   throw error
  }).finally(()=>flights.delete(flightKey))
  flights.set(flightKey,operation);return operation
 }
 private authorize(i:ManualPointsIntent,p:readonly string[]){if(!p.includes('loyalty.adjust.manual')||(i.kind==='decision'&&(!p.includes('loyalty.accrual.approve')||i.requestedBy===this.employeeId)))throw new Error('当前员工无权执行或审核自己的积分申请')}
}
function valid(v:unknown,scopeKey:string,employeeId:string):v is ManualPointsIntent{
 if(!v||typeof v!=='object')return false
 const i=v as ManualPointsIntent,b=i.body
 if(i.version!==1||i.scopeKey!==scopeKey||i.employeeId!==employeeId||typeof i.key!=='string'||!/^manual-points-[a-f0-9-]{36}$/.test(i.key)||!b||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.length>240)return false
 return i.kind==='request'?typeof i.body.memberNo==='string'&&i.body.memberNo.trim().length>0&&i.body.memberNo.length<=64&&Number.isSafeInteger(i.body.pointsDelta)&&i.body.pointsDelta!==0&&Math.abs(i.body.pointsDelta)<=1000000:i.kind==='decision'&&typeof i.requestedBy==='string'&&typeof i.body.requestId==='string'&&/^[a-f0-9-]{36}$/.test(i.body.requestId)&&['approve','reject'].includes(i.body.decision)
}
