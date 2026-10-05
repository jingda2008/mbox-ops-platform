/** Employee reception v1. Personal contact stays in the current page's memory. */
export type ReceptionStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>
export type ReceptionRequest = (path:string,init?:{method?:'GET'|'POST';body?:string;key?:string})=>Promise<unknown>
export interface ReceptionCreateInput {
  customerName:string;contact:string;guestCount:number;arrivalAt:string;expectedEndAt:string
  source:'phone'|'employee';initialStatus:'pending'|'confirmed';note:string|null
  seatPreference:'no_preference'|'stage_atmosphere'|'quiet_chat'|'comfortable_booth'|'outdoor_view'
  reservationPolicyVersion:number;preferredScheduleId:string|null
}
export interface ReceptionOptions {protocol:1;creationEnabled:boolean;arrivalAt:string;expectedEndAt:string;policy:{version:number;maxAdvanceDays:number;defaultDurationMinutes:number;arrivalGraceMinutes:number};capacity:{totalGuests:number;committedGuests:number};physicalTablesPreassigned:false}
export interface ReceptionSession {tableSessionId:string;tableId:string;tableCode:string;locationVersion:number;guestCount:number;businessDate:string;openedAt:string}
export interface ReceptionCandidates {protocol:1;reservationId:string;reservationVersion:number;reservationGuestCount:number;reservationStatus:string;sessions:ReceptionSession[];partialSeatingSupported:false}
export interface ReceptionSeatInput {protocol:1;reservationVersion:number;sessions:Array<{tableSessionId:string;expectedTableId:string;expectedLocationVersion:number;expectedGuestCount:number}>;reason:string}
export interface ReceptionReservation {id:string;publicId:string;customerName?:string;guestCount:number;status:string;aggregateVersion:number;reservationSnapshot?:{receptionProtocol?:number}}
export interface ReceptionSeating {batchId:string;customerId:string;seatedAt:string;seatedByEmployeeId:string;seatedGuestCount:number;reservationGuestCount:number;reason:string;sessions:Array<{tableSessionId:string;tableIdAtSeating:string;tableCodeAtSeating:string;locationVersionAtSeating:number;guestCountAtSeating:number;currentTableCode?:string;currentStatus?:string}>}
export interface ReceptionDetail {protocol:1;reservation:ReceptionReservation;seating:ReceptionSeating|null}
export interface ReceptionReceipt {protocol:1;operation:'create'|'seat';employeeId:string;requestKey:string;reservation:ReceptionReservation;seating?:ReceptionSeating;maskedContact?:string}
type BaseAttempt={version:1;employeeId:string;scope:string;key:string;confirmed:boolean}
type CreateAttempt=BaseAttempt&{kind:'create';publicId:string}
type SeatAttempt=BaseAttempt&{kind:'seat';reservationId:string;body:ReceptionSeatInput}
type Attempt=CreateAttempt|SeatAttempt
export interface ReceptionPending {kind:'create'|'seat';canRecover:boolean;message:string}
const prefix='mbox.reservation-reception.v1:'
const root='/api/staff/reservation-receptions'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const str=(v:unknown):v is string=>typeof v==='string'&&v.length>0
const int=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const validKey=(v:unknown):v is string=>typeof v==='string'&&v.length>=8&&v.length<=160
export function receptionTime(value:string):number{return Date.parse(value.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00'))}
function reject(message='接待回执或数据无法核实，请保留原操作重新读取'):never{throw new Error(message)}
function data(raw:unknown):Record<string,unknown>{if(!object(raw)||!object(raw.data)||raw.data.protocol!==1)return reject();return raw.data}
function reservation(raw:unknown):ReceptionReservation{
  if(!object(raw)||!uuid(raw.id)||!str(raw.publicId)||!int(raw.guestCount,1)||!int(raw.aggregateVersion,1)||(raw.customerName!==undefined&&!str(raw.customerName))||!['pending','confirmed','arrived','seated','completed','cancelled','no_show'].includes(String(raw.status)))return reject()
  return raw as unknown as ReceptionReservation
}
function seating(raw:unknown):ReceptionSeating{
  if(!object(raw)||!uuid(raw.batchId)||!uuid(raw.customerId)||!uuid(raw.seatedByEmployeeId)||!str(raw.seatedAt)||!Number.isFinite(receptionTime(raw.seatedAt))||!int(raw.seatedGuestCount,1)||!int(raw.reservationGuestCount,1)||!str(raw.reason)||!Array.isArray(raw.sessions)||!raw.sessions.length)return reject()
  const ids=new Set<string>()
  for(const row of raw.sessions){if(!object(row)||!uuid(row.tableSessionId)||ids.has(row.tableSessionId)||!uuid(row.tableIdAtSeating)||!str(row.tableCodeAtSeating)||!int(row.locationVersionAtSeating)||!int(row.guestCountAtSeating,1)||(row.currentTableCode!==undefined&&!str(row.currentTableCode))||(row.currentStatus!==undefined&&!str(row.currentStatus)))return reject();ids.add(row.tableSessionId)}
  if(raw.sessions.reduce((sum,row)=>sum+row.guestCountAtSeating,0)!==raw.seatedGuestCount)return reject()
  return raw as unknown as ReceptionSeating
}
export function validateReceptionSeat(body:ReceptionSeatInput):void{
  if(body.protocol!==1||!int(body.reservationVersion,1)||!Array.isArray(body.sessions)||body.sessions.length<1||body.sessions.length>20||typeof body.reason!=='string'||body.reason.trim().length<4||body.reason.length>1000)reject('请选择本组全部已开桌次，并填写至少4个字的核对说明')
  const sessions=new Set<string>(),tables=new Set<string>()
  for(const row of body.sessions){if(!uuid(row.tableSessionId)||!uuid(row.expectedTableId)||sessions.has(row.tableSessionId)||tables.has(row.expectedTableId)||!int(row.expectedLocationVersion)||!int(row.expectedGuestCount,1)||row.expectedGuestCount>200)reject('桌次、人数或版本无效，请重新读取');sessions.add(row.tableSessionId);tables.add(row.expectedTableId)}
}
export function validateReceptionReceipt(raw:unknown,attempt:Attempt,original?:ReceptionCreateInput&{publicId:string;protocol:1}):ReceptionReceipt{
  const value=data(raw);if(!object(raw)||!object(raw.meta)||typeof raw.meta.replayed!=='boolean'||value.operation!==attempt.kind||value.employeeId!==attempt.employeeId||value.requestKey!==attempt.key)return reject()
  const row=reservation(value.reservation)
  if(attempt.kind==='create'){
    if(!str(value.maskedContact)||row.publicId!==attempt.publicId||!object(value.reservation)||value.reservation.ownerEmployeeId!==attempt.employeeId||!uuid(value.reservation.customerId)||'contactToken'in value.reservation||'contact'in value.reservation||!Array.isArray(value.reservation.tableLocks)||value.reservation.tableLocks.length!==0||!['pending','confirmed'].includes(row.status))return reject()
    if(!object(value.reservation.reservationSnapshot)||value.reservation.reservationSnapshot.physicalTablesPreassigned!==false||value.reservation.reservationSnapshot.receptionProtocol!==1)return reject()
    if(original){for(const key of ['customerName','guestCount','source','seatPreference','note']as const)if(value.reservation[key]!==original[key])return reject();for(const key of ['arrivalAt','expectedEndAt']as const)if(typeof value.reservation[key]!=='string'||receptionTime(value.reservation[key])!==receptionTime(original[key]))return reject();if(row.status!==original.initialStatus)return reject()}
  }else{
    const batch=seating(value.seating)
    if(row.id!==attempt.reservationId||row.status!=='seated'||row.aggregateVersion!==attempt.body.reservationVersion+1||batch.seatedByEmployeeId!==attempt.employeeId||batch.reservationGuestCount!==row.guestCount||batch.reason!==attempt.body.reason||batch.sessions.length!==attempt.body.sessions.length)return reject()
    for(const target of attempt.body.sessions){const actual=batch.sessions.find(row=>row.tableSessionId===target.tableSessionId);if(!actual||actual.tableIdAtSeating!==target.expectedTableId||actual.locationVersionAtSeating!==target.expectedLocationVersion||actual.guestCountAtSeating!==target.expectedGuestCount)return reject()}
  }
  return value as unknown as ReceptionReceipt
}
export class ReservationReception {
  private readonly memoryBodies=new Map<string,ReceptionCreateInput&{publicId:string;protocol:1}>()
  private readonly flights=new Map<string,Promise<ReceptionReceipt>>()
  private readonly request:ReceptionRequest
  private readonly owner:()=>string|null
  private readonly storage:ReceptionStorage|undefined
  private readonly scope:string
  private readonly makeId:()=>string
  constructor(request:ReceptionRequest,owner:()=>string|null,storage:ReceptionStorage|undefined,scope:string,makeId:()=>string=()=>crypto.randomUUID()){
    this.request=request;this.owner=owner;this.storage=storage;this.scope=scope;this.makeId=makeId
  }
  private currentOwner():string{const id=this.owner();if(!uuid(id))return reject('请先刷新并确认当前员工身份');return id}
  private assertOwner(actor:string){if(this.owner()!==actor)reject('员工已切换，请由原员工核对原接待请求')}
  private read(kind:'create'|'seat'):Attempt|null{
    try{
      if(!this.storage)throw Error();const raw=this.storage.getItem(prefix+kind);if(raw===null)return null
      const value:unknown=JSON.parse(raw)
      if(!object(value)||value.version!==1||value.kind!==kind||!uuid(value.employeeId)||!str(value.scope)||!validKey(value.key)||typeof value.confirmed!=='boolean')throw Error()
      if(kind==='create'){if(!str(value.publicId)||!/^reception-[a-f0-9-]{36}$/.test(value.publicId)||Object.keys(value).some(k=>!['version','kind','employeeId','scope','key','confirmed','publicId'].includes(k)))throw Error()}
      else {if(!uuid(value.reservationId)||!object(value.body))throw Error();validateReceptionSeat(value.body as unknown as ReceptionSeatInput)}
      return value as unknown as Attempt
    }catch{return reject('本机原接待记录无法安全读取，请勿重复创建，联系主管核对')}
  }
  private write(attempt:Attempt){try{if(!this.storage)throw Error();const raw=JSON.stringify(attempt);this.storage.setItem(prefix+attempt.kind,raw);if(this.storage.getItem(prefix+attempt.kind)!==raw)throw Error()}catch{reject('本机未能保存原接待请求，暂不提交；请恢复原记录或联系主管')}}
  private owns(attempt:Attempt){return attempt.employeeId===this.owner()&&attempt.scope===this.scope}
  private clear(attempt:Attempt){try{const current=this.read(attempt.kind);if(current?.key!==attempt.key||!this.owns(current))throw Error();this.storage!.removeItem(prefix+attempt.kind);if(this.storage!.getItem(prefix+attempt.kind)!==null)throw Error();this.memoryBodies.delete(attempt.key)}catch{reject('原接待请求已核实，但本机记录未能清除，请继续核对原请求')}}
  pending():ReceptionPending[]{return (['create','seat']as const).flatMap(kind=>{try{const a=this.read(kind);return a?[{kind,canRecover:this.owns(a),message:!this.owns(a)?'本机有其他员工或门店的接待请求，请回到原员工核对':a.confirmed?'原接待结果已确认，本机记录仍需清理':kind==='create'?'原预约创建结果待确认，请核对原请求后再创建':'原入座结果待确认，请恢复原桌次集合后继续'}]:[]}catch(error){return[{kind,canRecover:false,message:(error as Error).message}]}})}
  async capabilities():Promise<{create:boolean;seat:boolean}>{const actor=this.currentOwner(),raw=await this.request('/api/staff/native-reservation-capabilities');this.assertOwner(actor);if(!object(raw)||!object(raw.data))return reject();return{create:raw.data.admissionCreateV1===true,seat:raw.data.receptionSeatV1===true}}
  async options(arrivalAt:string,expectedEndAt:string):Promise<ReceptionOptions>{const actor=this.currentOwner(),v=data(await this.request(root+'/options?'+new URLSearchParams({arrivalAt,expectedEndAt})));this.assertOwner(actor);if(v.physicalTablesPreassigned!==false||v.arrivalAt!==arrivalAt||v.expectedEndAt!==expectedEndAt||!object(v.policy)||!int(v.policy.version,1)||!int(v.policy.maxAdvanceDays,1)||!int(v.policy.defaultDurationMinutes,1)||!int(v.policy.arrivalGraceMinutes)||!object(v.capacity)||!int(v.capacity.totalGuests)||!int(v.capacity.committedGuests))return reject();return {...v,creationEnabled:v.creationEnabled===true} as unknown as ReceptionOptions}
  async candidates(id:string):Promise<ReceptionCandidates>{if(!uuid(id))return reject();const actor=this.currentOwner(),v=data(await this.request(root+'/'+id+'/table-sessions'));this.assertOwner(actor);if(v.reservationId!==id||!int(v.reservationVersion,1)||!int(v.reservationGuestCount,1)||!str(v.reservationStatus)||v.partialSeatingSupported!==false||!Array.isArray(v.sessions))return reject();const ids=new Set<string>();for(const row of v.sessions){if(!object(row)||!uuid(row.tableSessionId)||ids.has(row.tableSessionId)||!uuid(row.tableId)||!str(row.tableCode)||!int(row.locationVersion)||!int(row.guestCount,1)||!str(row.businessDate)||!str(row.openedAt)||!Number.isFinite(receptionTime(row.openedAt)))return reject();ids.add(row.tableSessionId)}return v as unknown as ReceptionCandidates}
  async detail(id:string):Promise<ReceptionDetail>{if(!uuid(id))return reject();const actor=this.currentOwner(),v=data(await this.request(root+'/'+id));this.assertOwner(actor);const r=reservation(v.reservation);if(r.id!==id)return reject();return{protocol:1,reservation:r,seating:v.seating===null?null:seating(v.seating)}}
  async create(input:ReceptionCreateInput):Promise<ReceptionReceipt>{
    const actor=this.currentOwner();if(this.read('create'))return reject('请先核对原预约请求，不会创建新的预约')
    if(!(await this.capabilities()).create)return reject('新预约登记暂未开放，原预约仍可处理');this.assertOwner(actor)
    if((await this.options(input.arrivalAt,input.expectedEndAt)).creationEnabled!==true)return reject('新预约登记暂未开放，原预约仍可处理');this.assertOwner(actor)
    // A second click may have completed the capability read concurrently.
    if(this.read('create'))return reject('请先核对原预约请求')
    if(!input.customerName.trim()||input.customerName.trim().length>120||input.contact.trim().length<3||input.contact.trim().length>256||!int(input.guestCount,1)||input.guestCount>200||!Number.isFinite(receptionTime(input.arrivalAt))||!Number.isFinite(receptionTime(input.expectedEndAt))||receptionTime(input.expectedEndAt)<=receptionTime(input.arrivalAt)||!int(input.reservationPolicyVersion,1))return reject('请核对姓名、联系方式、人数与预约时间')
    const a:CreateAttempt={version:1,kind:'create',employeeId:actor,scope:this.scope,key:'reception-create-'+this.makeId(),publicId:'reception-'+this.makeId(),confirmed:false}
    const body={...input,publicId:a.publicId,protocol:1 as const};this.write(a);this.memoryBodies.set(a.key,body)
    return this.dispatch(a)
  }
  async seat(reservationId:string,input:ReceptionSeatInput):Promise<ReceptionReceipt>{const actor=this.currentOwner();if(!uuid(reservationId))return reject();validateReceptionSeat(input);if(this.read('seat'))return reject('请先核对原入座请求，不会改选桌次');if(!(await this.capabilities()).seat)return reject('后台尚未支持实际桌次关联，请更新后台');this.assertOwner(actor);if(this.read('seat'))return reject('请先核对原入座请求');const a:SeatAttempt={version:1,kind:'seat',employeeId:actor,scope:this.scope,key:'reception-seat-'+this.makeId(),reservationId,body:JSON.parse(JSON.stringify(input)),confirmed:false};this.write(a);return this.dispatch(a)}
  recover(kind:'create'|'seat'):Promise<ReceptionReceipt>{const a=this.read(kind);if(!a)return Promise.reject(new Error('没有待核对的接待请求'));if(!this.owns(a))return Promise.reject(new Error('请由原员工在原门店恢复接待请求'));return this.dispatch(a)}
  private dispatch(a:Attempt):Promise<ReceptionReceipt>{
    const running=this.flights.get(a.key);if(running)return running
    const promise=(async()=>{
      if(!this.owns(a))return reject('员工或门店已切换，请由原员工核对')
      const original=a.kind==='create'?this.memoryBodies.get(a.key):undefined
      let raw:unknown
      try{
        raw=a.kind==='create'&&(!original||a.confirmed)
          ?await this.request(root+'/by-public-id/'+encodeURIComponent(a.publicId)+'?'+new URLSearchParams({requestKey:a.key}))
          :await this.request(a.kind==='create'?root:root+'/'+a.reservationId+'/seat',{method:'POST',key:a.key,body:JSON.stringify(a.kind==='create'?original:a.body)})
      }catch(error){
        this.assertOwner(a.employeeId)
        const e=error as {code?:string;status?:number;commitDisposition?:string}
        if(e.commitDisposition==='not_committed'&&['RESERVATION_POLICY_CHANGED','RESERVATION_CAPACITY_UNAVAILABLE','RESERVATION_RECEPTION_CHANGED','RESERVATION_RECEPTION_INPUT','RESERVATION_RECEPTION_CREATE_DISABLED'].includes(e.code??'')||e.status===400&&e.code==='RESERVATION_RECEPTION_INPUT')this.clear(a)
        throw error
      }
      this.assertOwner(a.employeeId)
      const receipt=validateReceptionReceipt(raw,a,original)
      this.write({...a,confirmed:true});this.clear(a)
      return receipt
    })().finally(()=>this.flights.delete(a.key))
    this.flights.set(a.key,promise);return promise
  }
}

export function canCompleteReservation(value:{status:string;reservationSnapshot?:{receptionProtocol?:number}}):boolean{
  return value.status==='seated'||value.status==='arrived'&&value.reservationSnapshot?.receptionProtocol!==1
}
