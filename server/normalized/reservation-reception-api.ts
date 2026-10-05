import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest,FastifyReply} from 'fastify'
import {IdempotencyConflictError,IdempotencyInProgressError,NativeCommandNotCommittedError,type JsonObject,type JsonValue,type NormalizedCommandExecutor} from './command-executor.js'
import {CustomerRepository} from './customer-repository.js'
import {assertEmployeeTableSessionAccess,EmployeeTableAccessDeniedError} from './employee-table-access.js'
import {StaffAccessDeniedError,StaffNotFoundError,StaffAccessRepository,type EffectiveStaffAccess} from './staff-access-repository.js'
import {NormalizedStoreUnavailableError,TrustedStoreScopeError} from './normalized-request-context.js'
import {isStaffAuthenticationRequiredError} from './staff-api-authentication.js'
import {ReservationRepository,type Reservation} from './reservation-repository.js'
import {reservationVisibility,type StaffReservationPerformanceContext} from './reservation-performance-api.js'
import {readPolicy,readReservationCapacity,capacityAccepts,insertPrivateContact,validateReservationWindow,assertPreferredSchedule} from './public-reservation-api.js'
import type {ProtectedContact} from './waitlist-repository.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'

export interface ReservationReceptionApiOptions {
  transactions:Pick<ScopedPostgresTransactionRunner,'run'>
  commands:Pick<NormalizedCommandExecutor,'execute'>
  resolveStaffContext(request:FastifyRequest):Promise<StaffReservationPerformanceContext>|StaffReservationPerformanceContext
  protectContact(value:string):Promise<ProtectedContact>|ProtectedContact
  reservationReceptionCreateEnabled?:boolean
  now?:()=>Date
}
export class ReservationReceptionError extends Error {
  constructor(readonly code:string,readonly status:number,message:string){super(message);this.name='ReservationReceptionError'}
}
const fail=(message:string,code='RESERVATION_RECEPTION_CHANGED',status=409):never=>{throw new ReservationReceptionError(code,status,message)}
const uuid=(value:unknown,label:string):string=>{if(typeof value!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail(`${label}格式不正确`,'RESERVATION_RECEPTION_INPUT',400);return value as string}
const text=(value:unknown,label:string,min:number,max:number):string=>{if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(`${label}格式不正确`,'RESERVATION_RECEPTION_INPUT',400);return (value as string).trim()}
const optional=(value:unknown,label:string,max:number):string|null=>value===undefined||value===null||value===''?null:text(value,label,1,max)
const integer=(value:unknown,label:string,min:number,max:number):number=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)fail(`${label}格式不正确`,'RESERVATION_RECEPTION_INPUT',400);return value as number}
const timestamp=(value:unknown,label:string):string=>{const parsed=text(value,label,8,100);if(!Number.isFinite(Date.parse(parsed)))fail(`${label}格式不正确`,'RESERVATION_RECEPTION_INPUT',400);return new Date(parsed).toISOString()}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('请求格式不正确','RESERVATION_RECEPTION_INPUT',400);return value as Record<string,unknown>}
const exact=(body:Record<string,unknown>,keys:readonly string[])=>{if(Object.keys(body).some(key=>!keys.includes(key)))fail('请求包含未开放字段；预约不提前绑定桌台','RESERVATION_RECEPTION_INPUT',400)}
const choice=<T extends string>(value:unknown,values:readonly T[],label:string):T=>{if(typeof value!=='string'||!values.includes(value as T))fail(`${label}格式不正确`,'RESERVATION_RECEPTION_INPUT',400);return value as T}
const json=(value:unknown):JsonObject=>JSON.parse(JSON.stringify(value)) as JsonObject
const hash=(value:unknown):string=>createHash('sha256').update(stable(value)).digest('hex')
function stable(value:unknown):string {if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;return JSON.stringify(value)}
const codec={encode:(value:JsonObject)=>value,decode:(value:JsonValue)=>{const parsed=object(value);if(parsed.protocol!==1)throw Error('Invalid reception receipt');return parsed as JsonObject}}
const preference=['no_preference','stage_atmosphere','quiet_chat','comfortable_booth','outdoor_view'] as const

export const reservationReceptionApiPlugin:FastifyPluginAsync<ReservationReceptionApiOptions>=async(app,options)=>{
  const now=options.now??(()=>new Date())
  async function context(request:FastifyRequest,permission='reservation.manage') {
    const context=await options.resolveStaffContext(request)
    const access=await options.transactions.run(context.scope,tx=>new StaffAccessRepository(tx).assertPermission(context.employeeId,permission),{readOnly:true})
    return {...context,access}
  }
  app.get('/staff/reservation-receptions/options',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request),query=object(request.query)
    exact(query,['arrivalAt','expectedEndAt'])
    const arrivalAt=timestamp(query.arrivalAt,'到店时间'),expectedEndAt=timestamp(query.expectedEndAt,'预计结束时间')
    const data=await options.transactions.run(ctx.scope,async tx=>{
      const policy=await readPolicy(tx)
      validateReservationWindow(arrivalAt,expectedEndAt,now(),policy.max_advance_days)
      const capacity=await readReservationCapacity(tx,arrivalAt,expectedEndAt)
      return {protocol:1,creationEnabled:options.reservationReceptionCreateEnabled===true,arrivalAt,expectedEndAt,policy:{version:policy.policy_version,maxAdvanceDays:policy.max_advance_days,defaultDurationMinutes:policy.default_duration_minutes,arrivalGraceMinutes:policy.arrival_grace_minutes},capacity:{totalGuests:Number(capacity.total_capacity),committedGuests:Number(capacity.committed_guests)},physicalTablesPreassigned:false}
    },{readOnly:true})
    return reply.send({data})
  }))
  app.post('/staff/reservation-receptions',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request),body=object(request.body)
    exact(body,['protocol','publicId','customerName','contact','guestCount','arrivalAt','expectedEndAt','source','initialStatus','note','seatPreference','reservationPolicyVersion','preferredScheduleId'])
    integer(body.protocol,'协议',1,1)
    const input={publicId:text(body.publicId,'预约编号',8,128),customerName:text(body.customerName,'预约姓名',1,120),contact:text(body.contact,'联系方式',3,256),guestCount:integer(body.guestCount,'预约人数',1,200),arrivalAt:timestamp(body.arrivalAt,'到店时间'),expectedEndAt:timestamp(body.expectedEndAt,'预计结束时间'),source:choice(body.source,['phone','employee'] as const,'预约来源'),initialStatus:choice(body.initialStatus,['pending','confirmed'] as const,'预约状态'),note:optional(body.note,'备注',1000),seatPreference:choice(body.seatPreference??'no_preference',preference,'位置偏好'),reservationPolicyVersion:integer(body.reservationPolicyVersion,'规则版本',1,2_147_483_647),preferredScheduleId:body.preferredScheduleId==null?null:uuid(body.preferredScheduleId,'演出偏好')}
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.publicId))fail('预约编号格式不正确','RESERVATION_RECEPTION_INPUT',400)
    const key=requestKey(request),protectedContact=await options.protectContact(input.contact)
    const requestFingerprint=hash({actor:ctx.employeeId,scope:ctx.scope,input:{...input,contact:protectedContact.hash}})
    let recovered=false
    const execution=await options.commands.execute({scope:ctx.scope,operationScope:'reservation.reception.create.v1',idempotencyKey:key,requestFingerprint,retainReceipt:true,resultCodec:codec},async tx=>{
      const repository=new ReservationRepository(tx)
      const existing=await repository.findByPublicId(input.publicId)
      if(existing){
        if(existing.reservationSnapshot.receptionRequestHash!==requestFingerprint)throw new IdempotencyConflictError('reservation.reception.create.v1',key)
        recovered=true
        return {result:createReceipt(existing,ctx.employeeId,key,protectedContact.masked),auditEvents:[],outboxMessages:[]}
      }
      // Existing receipts/public IDs recover before this rollout gate. Never downgrade their protocol.
      if(options.reservationReceptionCreateEnabled!==true)fail('本轮暂未开放新接待登记，原预约和未确认操作仍可核对恢复','RESERVATION_RECEPTION_CREATE_DISABLED')
      const policy=await readPolicy(tx,true)
      if(policy.policy_version!==input.reservationPolicyVersion)fail('预约规则已变化，请重新读取名额和规则','RESERVATION_POLICY_CHANGED')
      validateReservationWindow(input.arrivalAt,input.expectedEndAt,now(),policy.max_advance_days)
      await assertPreferredSchedule(tx,input.preferredScheduleId,input.arrivalAt)
      if(!capacityAccepts(await readReservationCapacity(tx,input.arrivalAt,input.expectedEndAt),input.guestCount))fail('该时间段接待名额不足，请重新选择','RESERVATION_CAPACITY_UNAVAILABLE')
      const anonymous=await new CustomerRepository(tx).createAnonymous({publicId:`reception-${hash({scope:ctx.scope,publicId:input.publicId}).slice(0,40)}`,profile:{displayName:input.customerName}})
      const holdUntil=new Date(Math.min(Date.parse(input.arrivalAt),now().getTime()+policy.hold_minutes*60_000)).toISOString()
      const reservation=await repository.create({publicId:input.publicId,customerId:anonymous.customer.id,customerName:input.customerName,contactToken:protectedContact.hash,guestCount:input.guestCount,arrivalAt:input.arrivalAt,expectedEndAt:input.expectedEndAt,source:input.source,ownerEmployeeId:ctx.employeeId,note:input.note,seatPreference:input.seatPreference,tableIds:[],allowUnassignedTable:true,initialStatus:input.initialStatus,holdExpiresAt:input.initialStatus==='pending'?holdUntil:null,requestHoldExpiresAt:input.initialStatus==='pending'?holdUntil:null,customerCancelUntil:new Date(Date.parse(input.arrivalAt)-policy.customer_cancel_cutoff_minutes*60_000).toISOString(),cancellationPolicySnapshot:{cutoffMinutes:policy.customer_cancel_cutoff_minutes,depositMode:policy.deposit_mode},arrivalGraceEndsAt:new Date(Date.parse(input.arrivalAt)+policy.arrival_grace_minutes*60_000).toISOString(),reservationPolicyVersion:policy.policy_version,reservationPolicyAcknowledgedVersion:policy.policy_version,preferredScheduleId:input.preferredScheduleId,reservationSnapshot:{receptionProtocol:1,receptionRequestHash:requestFingerprint,bookingMode:'direct',physicalTablesPreassigned:false}})
      await insertPrivateContact(tx,reservation.id,protectedContact)
      const payload=json({reservationId:reservation.id,publicId:reservation.publicId,customerId:reservation.customerId,status:reservation.status,guestCount:reservation.guestCount,arrivalAt:reservation.arrivalAt,expectedEndAt:reservation.expectedEndAt,ownerEmployeeId:ctx.employeeId,physicalTablesPreassigned:false})
      return {result:createReceipt(reservation,ctx.employeeId,key,protectedContact.masked),auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},action:'reservation.created',objectType:'reservation',objectId:reservation.id,businessDate:ctx.businessDate,afterData:payload}],outboxMessages:[{aggregateType:'reservation',aggregateId:reservation.id,aggregateVersion:reservation.aggregateVersion,eventType:'reservation.created.v1',payload}]}
    },async tx=>{
      await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'reservation.manage')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`staff-reservation-reception:${ctx.scope.tenantId}:${ctx.scope.storeId}:${input.publicId}`])
    })
    return reply.code(execution.replayed||recovered?200:201).send({data:execution.value,meta:{replayed:execution.replayed||recovered}})
  }))
  app.get<{Params:{publicId:string}}>('/staff/reservation-receptions/by-public-id/:publicId',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request),publicId=text(request.params.publicId,'预约编号',8,128),query=object(request.query)
    exact(query,['requestKey']);const key=text(query.requestKey,'原请求编号',8,160)
    const data=await options.transactions.run(ctx.scope,async tx=>{
      const receipt=(await tx.query<{response_snapshot:JsonObject}>(`SELECT response_snapshot FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='reservation.reception.create.v1' AND idempotency_key=$3 AND status='completed'`,[ctx.scope.tenantId,ctx.scope.storeId,key])).rows[0]
      const result=receipt?.response_snapshot.result
      if(!result||typeof result!=='object'||Array.isArray(result)||result.employeeId!==ctx.employeeId||result.requestKey!==key)fail('尚未查到本人原预约回执，请继续保留原请求','RESERVATION_RECEIPT_NOT_FOUND',404)
      const reservation=(result as JsonObject).reservation
      if(!reservation||typeof reservation!=='object'||Array.isArray(reservation)||reservation.publicId!==publicId)fail('尚未查到本人原预约回执，请继续保留原请求','RESERVATION_RECEIPT_NOT_FOUND',404)
      return result
    },{readOnly:true})
    return reply.send({data,meta:{replayed:true}})
  }))
  app.get<{Params:{reservationId:string}}>('/staff/reservation-receptions/:reservationId',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request,'reservation.view'),id=uuid(request.params.reservationId,'预约')
    const data=await options.transactions.run(ctx.scope,async tx=>{
      await visibleReservation(tx,ctx,id,ctx.access)
      const reservation=await new ReservationRepository(tx).findById(id)
      return {protocol:1,reservation:staffReservation(reservation!),seating:await readSeating(tx,id)}
    },{readOnly:true})
    return reply.send({data})
  }))
  app.get<{Params:{reservationId:string}}>('/staff/reservation-receptions/:reservationId/table-sessions',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request),id=uuid(request.params.reservationId,'预约')
    const data=await options.transactions.run(ctx.scope,async tx=>{
      const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'table.open')
      await visibleReservation(tx,ctx,id,access)
      const reservation=await new ReservationRepository(tx).findById(id)
      const rows=reservation?.status!=='arrived'?[]:(await tx.query<Record<string,unknown>>(`SELECT s.id AS "tableSessionId",s.table_id AS "tableId",t.code AS "tableCode",s.location_version AS "locationVersion",s.guest_count AS "guestCount",s.business_date::text AS "businessDate",s.opened_at::text AS "openedAt"
        FROM mbox.table_sessions s JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id)
        WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.status='open' AND s.business_date=$4::date
        AND NOT EXISTS(SELECT 1 FROM mbox.reservation_seating_sessions linked WHERE(linked.tenant_id,linked.store_id,linked.table_session_id)=(s.tenant_id,s.store_id,s.id))
        AND (mbox.employee_has_effective_permission($1,$2,$3,'table.view_all') OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE(a.tenant_id,a.store_id,a.table_id,a.employee_id)=(s.tenant_id,s.store_id,s.table_id,$3) AND a.assignment_type IN('primary','backup') AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp())))
        ORDER BY t.code,s.id LIMIT 1000`,[ctx.scope.tenantId,ctx.scope.storeId,ctx.employeeId,ctx.businessDate])).rows
      return {protocol:1,reservationId:id,reservationVersion:reservation!.aggregateVersion,reservationGuestCount:reservation!.guestCount,reservationStatus:reservation!.status,sessions:rows.map(row=>({...row,locationVersion:Number(row.locationVersion),guestCount:Number(row.guestCount)})),partialSeatingSupported:false}
    },{readOnly:true})
    return reply.send({data})
  }))
  app.post<{Params:{reservationId:string}}>('/staff/reservation-receptions/:reservationId/seat',async(request,reply)=>handle(reply,async()=>{
    const ctx=await context(request),id=uuid(request.params.reservationId,'预约'),body=object(request.body)
    exact(body,['protocol','reservationVersion','sessions','reason']);integer(body.protocol,'协议',1,1)
    const reservationVersion=integer(body.reservationVersion,'预约版本',1,Number.MAX_SAFE_INTEGER),reason=text(body.reason,'接待核对说明',4,1000)
    if(!Array.isArray(body.sessions)||body.sessions.length<1||body.sessions.length>20)fail('请选择1至20个实际已开桌次','RESERVATION_RECEPTION_INPUT',400)
    const sessions=(body.sessions as unknown[]).map(value=>{const row=object(value);exact(row,['tableSessionId','expectedTableId','expectedLocationVersion','expectedGuestCount']);return {tableSessionId:uuid(row.tableSessionId,'桌次'),expectedTableId:uuid(row.expectedTableId,'桌台'),expectedLocationVersion:integer(row.expectedLocationVersion,'位置版本',0,Number.MAX_SAFE_INTEGER),expectedGuestCount:integer(row.expectedGuestCount,'实际人数',1,200)}})
    if(new Set(sessions.map(row=>row.tableSessionId)).size!==sessions.length||new Set(sessions.map(row=>row.expectedTableId)).size!==sessions.length)fail('同一桌台或桌次不能重复选择','RESERVATION_RECEPTION_INPUT',400)
    const key=requestKey(request),requestFingerprint=hash({actor:ctx.employeeId,scope:ctx.scope,reservationId:id,reservationVersion,sessions,reason})
    const execution=await options.commands.execute({scope:ctx.scope,operationScope:'reservation.reception.seat.v1',idempotencyKey:key,requestFingerprint,retainReceipt:true,resultCodec:codec},async tx=>{
      const locked=await tx.query<{customer_id:string|null;guest_count:number;aggregate_version:string|number;status:string}>(`SELECT customer_id,guest_count,aggregate_version,status FROM mbox.reservations WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[ctx.scope.tenantId,ctx.scope.storeId,id])
      const reservation=locked.rows[0] ?? fail('未找到预约','RESERVATION_NOT_FOUND',404)
      if(reservation.status!=='arrived'||Number(reservation.aggregate_version)!==reservationVersion)fail('预约状态或版本已变化，仅已到店预约可以确认入座')
      if((await tx.query('SELECT id FROM mbox.reservation_seating_batches WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$3',[ctx.scope.tenantId,ctx.scope.storeId,id])).rowCount)fail('该预约已有关联，请读取原接待批次')
      // Match table.open's table-before-session order. The movement advisory lock
      // (taken before claim) additionally serializes transfers and customer merge.
      await tx.query('SELECT id FROM mbox.tables WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR KEY SHARE',[ctx.scope.tenantId,ctx.scope.storeId,sessions.map(row=>row.expectedTableId).sort()])
      const current=await tx.query<{id:string;table_id:string;table_code:string;guest_count:number;location_version:string|number;status:string;business_date:string}>(`SELECT s.id,s.table_id,t.code AS table_code,s.guest_count,s.location_version,s.status,s.business_date::text FROM mbox.table_sessions s JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id) WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=ANY($3::uuid[]) ORDER BY s.id FOR UPDATE OF s`,[ctx.scope.tenantId,ctx.scope.storeId,sessions.map(row=>row.tableSessionId).sort()])
      if(current.rowCount!==sessions.length)fail('存在不属于本店的桌次或已移除桌次')
      for(const selected of sessions){
        const row=current.rows.find(row=>row.id===selected.tableSessionId)!
        if(row.status!=='open'||row.business_date!==ctx.businessDate||row.table_id!==selected.expectedTableId||Number(row.location_version)!==selected.expectedLocationVersion||row.guest_count!==selected.expectedGuestCount)fail('实际桌位、人数或营业状态已变化，请重新读取核对')
        await assertEmployeeTableSessionAccess(tx,{employeeId:ctx.employeeId,tableSessionId:row.id,requiredPermissionCodes:['table.open','reservation.manage']})
      }
      if((await tx.query('SELECT id FROM mbox.reservation_seating_sessions WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=ANY($3::uuid[])',[ctx.scope.tenantId,ctx.scope.storeId,sessions.map(row=>row.tableSessionId)])).rowCount)fail('所选桌次已归属另一预约，不能重复关联')
      let customerId=reservation.customer_id
      if(!customerId){
        const customer=await new CustomerRepository(tx).createAnonymous({publicId:`reception-customer-${id}`})
        customerId=customer.customer.id
        await tx.query('UPDATE mbox.reservations SET customer_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[ctx.scope.tenantId,ctx.scope.storeId,id,customerId])
      }
      const customer=await new CustomerRepository(tx).resolveCanonical(customerId)
      if(customer.status!=='active')fail('原预约客户不可用，请由主管核对')
      const totalGuests=current.rows.reduce((sum,row)=>sum+row.guest_count,0)
      const batch=(await tx.query<{id:string;seated_at:string}>(`INSERT INTO mbox.reservation_seating_batches(tenant_id,store_id,reservation_id,customer_id,reservation_version,reservation_guest_count,seated_guest_count,seated_by_employee_id,business_date,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10) RETURNING id,seated_at::text`,[ctx.scope.tenantId,ctx.scope.storeId,id,customerId,reservationVersion,reservation.guest_count,totalGuests,ctx.employeeId,ctx.businessDate,reason])).rows[0]!
      for(const row of current.rows)await tx.query(`INSERT INTO mbox.reservation_seating_sessions(tenant_id,store_id,batch_id,table_session_id,table_id_at_seating,table_code_at_seating,location_version_at_seating,guest_count_at_seating) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[ctx.scope.tenantId,ctx.scope.storeId,batch.id,row.id,row.table_id,row.table_code,Number(row.location_version),row.guest_count])
      const trace=json({batchId:batch.id,customerId,seatedAt:new Date(batch.seated_at).toISOString(),seatedByEmployeeId:ctx.employeeId,seatedGuestCount:totalGuests,reservationGuestCount:reservation.guest_count,reason,sessions:current.rows.map(row=>({tableSessionId:row.id,tableIdAtSeating:row.table_id,tableCodeAtSeating:row.table_code,locationVersionAtSeating:Number(row.location_version),guestCountAtSeating:row.guest_count}))})
      await tx.query(`UPDATE mbox.reservations SET status='seated',aggregate_version=aggregate_version+1,reservation_snapshot=jsonb_set(reservation_snapshot,'{reception}', $4::jsonb) WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[ctx.scope.tenantId,ctx.scope.storeId,id,JSON.stringify(trace)])
      await tx.query(`UPDATE mbox.reservation_table_locks SET status='released',hold_expires_at=NULL WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$3 AND status IN('held','confirmed')`,[ctx.scope.tenantId,ctx.scope.storeId,id])
      const updated=await new ReservationRepository(tx).findById(id)
      const payload=json({reservationId:id,customerId,batchId:batch.id,seatedGuestCount:totalGuests,reservationGuestCount:reservation.guest_count,tableSessionIds:current.rows.map(row=>row.id),reason})
      return {result:json({protocol:1,operation:'seat',employeeId:ctx.employeeId,requestKey:key,reservation:staffReservation(updated!),seating:trace}),auditEvents:[{actor:{type:'employee' as const,employeeId:ctx.employeeId},action:'reservation.seated',objectType:'reservation',objectId:id,businessDate:ctx.businessDate,reason,afterData:payload}],outboxMessages:[{aggregateType:'reservation',aggregateId:id,aggregateVersion:updated!.aggregateVersion,eventType:'reservation.seated.v1',payload}]}
    },async tx=>{
      const access=await new StaffAccessRepository(tx).assertPermission(ctx.employeeId,'reservation.manage')
      if(!access.permissions.includes('table.open'))throw new StaffAccessDeniedError('table.open required')
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))`,[ctx.scope.tenantId,ctx.scope.storeId])
      await visibleReservation(tx,ctx,id,access)
    })
    return reply.send({data:execution.value,meta:{replayed:execution.replayed}})
  }))
}

function requestKey(request:FastifyRequest):string {return text(request.headers['idempotency-key'],'原请求编号',8,160)}
function staffReservation(reservation:Reservation) {const {contactToken,...rest}=reservation;const snapshot={...reservation.reservationSnapshot};delete snapshot.receptionRequestHash;return {...rest,reservationSnapshot:snapshot,contactAvailable:contactToken.length>0}}
function createReceipt(reservation:Reservation,employeeId:string,requestKey:string,maskedContact:string):JsonObject{return json({protocol:1,operation:'create',employeeId,requestKey,reservation:staffReservation(reservation),maskedContact})}
async function visibleReservation(tx:ScopedTransaction,ctx:StaffReservationPerformanceContext,id:string,access:EffectiveStaffAccess) {
  const scope=reservationVisibility({...ctx,access})
  const row=await tx.query(`SELECT r.id FROM mbox.reservations r WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3 AND ($4::boolean OR r.owner_employee_id=ANY($5::uuid[]) OR EXISTS(SELECT 1 FROM mbox.reservation_table_locks l JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(l.tenant_id,l.store_id,l.table_id) WHERE(l.tenant_id,l.store_id,l.reservation_id)=(r.tenant_id,r.store_id,r.id) AND t.area_id=ANY($6::uuid[])) OR EXISTS(SELECT 1 FROM mbox.reservation_seating_batches b JOIN mbox.reservation_seating_sessions l ON(l.tenant_id,l.store_id,l.batch_id)=(b.tenant_id,b.store_id,b.id) JOIN mbox.table_sessions s ON(s.tenant_id,s.store_id,s.id)=(l.tenant_id,l.store_id,l.table_session_id) JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id) WHERE(b.tenant_id,b.store_id,b.reservation_id)=(r.tenant_id,r.store_id,r.id) AND t.area_id=ANY($6::uuid[])))`,[ctx.scope.tenantId,ctx.scope.storeId,id,scope.all,scope.ownerEmployeeIds,scope.areaIds])
  if(row.rowCount!==1)fail('未找到当前岗位可见的预约','RESERVATION_NOT_FOUND',404)
}
async function readSeating(tx:ScopedTransaction,id:string):Promise<JsonObject|null> {
  const batch=(await tx.query<Record<string,unknown>>(`SELECT id AS "batchId",customer_id AS "customerId",reservation_version::text AS "reservationVersion",reservation_guest_count AS "reservationGuestCount",seated_guest_count AS "seatedGuestCount",seated_by_employee_id AS "seatedByEmployeeId",business_date::text AS "businessDate",reason,seated_at::text AS "seatedAt" FROM mbox.reservation_seating_batches WHERE tenant_id=$1 AND store_id=$2 AND reservation_id=$3`,[tx.scope.tenantId,tx.scope.storeId,id])).rows[0]
  if(!batch)return null
  const sessions=(await tx.query<Record<string,unknown>>(`SELECT l.table_session_id AS "tableSessionId",l.table_id_at_seating AS "tableIdAtSeating",l.table_code_at_seating AS "tableCodeAtSeating",l.location_version_at_seating::text AS "locationVersionAtSeating",l.guest_count_at_seating AS "guestCountAtSeating",s.table_id AS "currentTableId",t.code AS "currentTableCode",s.location_version::text AS "currentLocationVersion",s.status AS "currentStatus" FROM mbox.reservation_seating_sessions l JOIN mbox.table_sessions s ON(s.tenant_id,s.store_id,s.id)=(l.tenant_id,l.store_id,l.table_session_id) JOIN mbox.tables t ON(t.tenant_id,t.store_id,t.id)=(s.tenant_id,s.store_id,s.table_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND l.batch_id=$3 ORDER BY l.table_session_id`,[tx.scope.tenantId,tx.scope.storeId,batch.batchId])).rows
  return json({...batch,reservationVersion:Number(batch.reservationVersion),sessions:sessions.map(row=>({...row,locationVersionAtSeating:Number(row.locationVersionAtSeating),currentLocationVersion:Number(row.currentLocationVersion)}))})
}
async function handle(reply:FastifyReply,work:()=>Promise<unknown>) {
  try{return await work()}catch(outer){
    const notCommitted=outer instanceof NativeCommandNotCommittedError,error=notCommitted?outer.original:outer
    let status=503,code='RESERVATION_RECEPTION_UNAVAILABLE',message='接待请求结果未确认，请保留原请求并稍后核对'
    if(error instanceof ReservationReceptionError){status=error.status;code=error.code;message=error.message}
    else if(error instanceof IdempotencyConflictError){status=409;code='IDEMPOTENCY_CONFLICT';message='原请求编号与载荷不一致，请保留原请求核对'}
    else if(error instanceof IdempotencyInProgressError){status=409;code='IDEMPOTENCY_IN_PROGRESS';message='原请求仍在处理中，请保留原请求'}
    else if(error instanceof StaffAccessDeniedError||error instanceof StaffNotFoundError||error instanceof NormalizedStoreUnavailableError||error instanceof TrustedStoreScopeError||error instanceof EmployeeTableAccessDeniedError){status=403;code='STAFF_ACCESS_DENIED';message='当前员工没有此预约或桌次的操作权限'}
    else if(isStaffAuthenticationRequiredError(error)){status=401;code='AUTH_REQUIRED';message='员工登录已失效，请重新登录'}
    else if(error instanceof Error&&error.name==='PublicReservationRequestError'){status=400;code='RESERVATION_RECEPTION_INPUT';message=error.message}
    return reply.code(status).send({error:{code,message,...(notCommitted?{commitDisposition:'not_committed'}:{})}})
  }
}
