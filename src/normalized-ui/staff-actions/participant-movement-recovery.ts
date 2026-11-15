import {parseInstant} from '../../shared/instant-time'
import {readRecoveryJournal} from '../recovery-journal'
import type {StaffParticipantMovementPreview} from './types'

export interface ParticipantMovementInput {
  movementHistoryConfirmed?:boolean
  movementGuard?:StaffParticipantMovementPreview['movementGuard']
  sourceTableSessionId:string
  movementKind:'participant_split'|'participant_merge'
  targetTableId:string
  targetTableSessionId:string|null
  movedGuestCount:number
  participantPublicIds:string[]
  reason:string
  capacityOverrideReason?:string
}
export interface MovementRecoverySummary {message:string;canRecover:boolean;canSeal?:boolean}
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>
type Receipt={eventId:string;targetTableSessionId:string}
type Attempt={owner:string;key:string;body:ParticipantMovementInput;receipt?:Receipt;sealRequested?:boolean}
const storageKey='mbox.participant-movement-recovery.v1'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0
export class ParticipantMovementRecovery {
  private flight:Promise<void>|null=null
  private readonly owner:()=>string|null
  private readonly storage:StoragePort|undefined
  private readonly send:(body:ParticipantMovementInput,key:string,recovery:boolean,seal?:boolean)=>Promise<unknown>
  private readonly refresh:(body:ParticipantMovementInput,receipt:Receipt)=>Promise<void>
  private readonly newKey:()=>string
  constructor(owner:()=>string|null,storage:StoragePort|undefined,
    send:(body:ParticipantMovementInput,key:string,recovery:boolean,seal?:boolean)=>Promise<unknown>,
    refresh:(body:ParticipantMovementInput,receipt:Receipt)=>Promise<void>,newKey:()=>string){
    this.owner=owner;this.storage=storage;this.send=send;this.refresh=refresh;this.newKey=newKey
  }
  private read(){
    return readRecoveryJournal<Attempt>(this.storage,storageKey,(v):v is Attempt=>object(v)&&text(v.owner)&&text(v.key)&&object(v.body)
      &&text(v.body.sourceTableSessionId)&&text(v.body.targetTableId)&&['participant_split','participant_merge'].includes(String(v.body.movementKind))
      &&Array.isArray(v.body.participantPublicIds)&&v.body.participantPublicIds.every(text)
      &&Number.isSafeInteger(v.body.movedGuestCount)&&Number(v.body.movedGuestCount)>0
      &&(v.sealRequested===undefined||typeof v.sealRequested==='boolean')
      &&(v.receipt===undefined||object(v.receipt)&&text(v.receipt.eventId)&&text(v.receipt.targetTableSessionId)),null)
  }
  private write(a:Attempt){
    if(!this.storage)throw new Error('无法保存拆并桌原请求，请恢复浏览器存储后再操作')
    const raw=JSON.stringify(a);this.storage.setItem(storageKey,raw)
    if(this.storage.getItem(storageKey)!==raw)throw new Error('拆并桌原请求保存失败，本次未发送')
  }
  private assertOwner(a:Attempt){if(this.owner()!==a.owner)throw new Error('请切回原员工核对拆并桌结果，不会使用当前账号重放')}
  private clear(a:Attempt){
    this.assertOwner(a)
    if(this.read()?.key!==a.key)return
    this.storage!.removeItem(storageKey)
    if(this.storage!.getItem(storageKey)!==null)throw new Error('原请求记录未清除，请继续核对原结果')
  }
  summary():MovementRecoverySummary|null{
    try{const a=this.read();return a?{canRecover:this.owner()===a.owner,canSeal:this.owner()===a.owner&&!a.receipt,message:this.owner()!==a.owner?'有其他员工的拆并桌待核对，请切回原员工':a.receipt?'原拆并桌已确认，需刷新核对后继续':a.sealRequested?'撤回结果待核对，不代表撤回成功；请核对原结果或再次撤回':'原拆并桌结果待核对；不会重发或执行新操作'}:null}
    catch(e){return{canRecover:false,message:e instanceof Error?e.message:'原请求记录异常'}}
  }
  run(body:ParticipantMovementInput):Promise<void>{
    if(this.flight)return Promise.reject(new Error('正在核对原拆并桌，请勿重复操作'))
    try{
      const original=this.read()
      if(original){this.assertOwner(original);if(JSON.stringify(original.body)!==JSON.stringify(body))throw new Error('请先核对原拆并桌，不能更改待确认的桌号、名单或快照')}
      const owner=this.owner();if(!owner)throw new Error('请刷新并确认当前员工身份')
      if(!original&&(!body.movementGuard||!/^\d+$/.test(body.movementGuard.movementRevision??'')))throw new Error('请重新预检取得完整桌位快照')
      const a=original??{owner,key:this.newKey(),body:structuredClone(body)}
      if(!original)this.write(a)
      return this.dispatch(a,!!original)
    }catch(e){return Promise.reject(e)}
  }
  recover():Promise<void>{
    try{const a=this.read();if(!a)throw new Error('没有待恢复的拆并桌请求');this.assertOwner(a);if(this.flight)return this.flight;return this.dispatch(a,true)}catch(e){return Promise.reject(e)}
  }
  seal():Promise<void>{
    try{let a=this.read();if(!a)throw new Error('没有待恢复的拆并桌请求');this.assertOwner(a);if(this.flight)return this.flight;if(!a.receipt){a={...a,sealRequested:true};this.write(a)}return this.dispatch(a,true,true)}catch(e){return Promise.reject(e)}
  }
  private dispatch(a:Attempt,recovery:boolean,seal=false):Promise<void>{
    const work=async()=>{
      if(!a.receipt){
        let result:unknown
        try{result=await this.send(a.body,a.key,recovery,seal)}catch(e){
          const error=e as {code?:string;commitDisposition?:string}
          if(error.commitDisposition==='not_committed'&&['TABLE_PARTICIPANT_NOT_COMMITTED','TABLE_MOVEMENT_REQUEST_SEALED'].includes(error.code??''))this.clear(a)
          throw e
        }
        a={...a,receipt:movementReceipt(result,a.body)};this.assertOwner(a);if(this.read()?.key===a.key)this.write(a)
      }
      await this.refresh(a.body,a.receipt!)
      this.clear(a)
    }
    this.flight=work().finally(()=>{this.flight=null});return this.flight
  }
}
export function movementReceipt(value:unknown,input:ParticipantMovementInput):Receipt{
  const bad=()=>{throw new Error('拆并桌回执不完整或与原请求不符，请核对原操作')}
  if(!object(value)||!object(value.data)||!object(value.meta)||typeof value.meta.replayed!=='boolean')return bad()
  const r=value.data,g=input.movementGuard
  if(!text(r.eventId)||!text(r.targetTableSessionId)||!Number.isFinite(parseInstant(r.occurredAt))
    ||r.movedParticipantCount!==input.participantPublicIds.length
    ||!Number.isSafeInteger(r.revokedGuestSessionCount)||Number(r.revokedGuestSessionCount)<0
    ||!g||r.targetCapacityAtMovement!==g.targetCapacity||r.targetGuestCountBefore!==g.targetGuestCount
    ||r.targetGuestCountAfter!==g.targetGuestCount+input.movedGuestCount
    ||input.movementKind==='participant_merge'&&r.targetTableSessionId!==input.targetTableSessionId)return bad()
  return{eventId:r.eventId,targetTableSessionId:r.targetTableSessionId}
}
