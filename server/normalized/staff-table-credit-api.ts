import {EmployeeTableAccessDeniedError} from './employee-table-access.js'
import {createHash,randomUUID} from 'node:crypto'
import type {FastifyInstance} from 'fastify'
import type {PaymentApiOptions} from './payment-api.js'
import {NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import {assertStaffCreditAccess,collectStaffCredit,readStaffCredit,type StaffCreditInput} from './staff-table-credit.js'
import {TablePrepaymentError} from './table-prepayment-repository.js'
import {PaymentEvidenceError} from './payment-repository.js'
import {IdempotencyConflictError,IdempotencyInProgressError,IdempotencyReceiptUnavailableError} from './command-executor.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import {StaffAccessDeniedError} from './staff-access-repository.js'
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
export function registerStaffTableCreditApi(app:FastifyInstance,options:PaymentApiOptions){
 app.get('/payments/table-prepayment/:sessionId',async(request,reply)=>{
  try{
   if(!options.transactions)throw new Error('预收款服务不可用')
   const context=await options.resolveStaffContext(request),sessionId=(request.params as {sessionId:string}).sessionId
   if(!uuid(sessionId))return reply.code(400).send({error:{message:'桌次无效'}})
   const data=await options.transactions.run(context.scope,async tx=>{await assertStaffCreditAccess(tx,context.employeeId,undefined,sessionId,true);return readStaffCredit(tx,sessionId)},{readOnly:true})
   reply.header('cache-control','no-store');return{data}
  }catch(e){return fail(reply,e)}
 })
 app.post('/payments/table-prepayment/:paymentId/resume',async(request,reply)=>{
  try{
   if(!options.transactions||!options.onlinePayments)throw new Error('预收款服务不可用')
   const context=await options.resolveStaffContext(request),paymentId=(request.params as {paymentId:string}).paymentId
   if(!uuid(paymentId))throw new TypeError('原付款编号无效')
   await options.transactions.run(context.scope,async tx=>{
    const row=(await tx.query<{method:string;status:string;session_id:string}>(`SELECT p.method,s.status,s.id session_id FROM mbox.payments p JOIN mbox.table_sessions s ON(s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.prepaid_table_session_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3`,[context.scope.tenantId,context.scope.storeId,paymentId])).rows[0]
    if(!row||row.method!=='native_qr'||row.status!=='open')throw new TablePrepaymentError('TABLE_CREDIT_REVIEW_REQUIRED','原付款不支持继续出码，请查询原付款或由收银核对')
    await assertStaffCreditAccess(tx,context.employeeId,undefined,row.session_id,true)
   },{readOnly:true})
   const action=await options.onlinePayments.create({scope:context.scope,paymentId,principal:{type:'employee',employeeId:context.employeeId},clientIp:request.ip,operatorId:context.employeeId,idempotencyKey:`staff-credit-resume-${paymentId}`})
   return reply.send({data:action})
  }catch(e){return fail(reply,e)}
 })
 app.post('/payments/table-prepayment',async(request,reply)=>{
  try{
   if(!options.transactions)throw new Error('预收款服务不可用')
   const context=await options.resolveStaffContext(request),body=request.body as Partial<StaffCreditInput>&{customerAuthCode?:string},key=request.headers['idempotency-key']
   if(!body||typeof body!=='object'||!uuid(body.sessionId)||typeof key!=='string'||key.length<8||key.length>128||!Array.isArray(body.orderIds)||body.orderIds.length>50||!body.orderIds.every(uuid)||body.sharedTableConsent!==true||!Number.isSafeInteger(body.amountMinor)||!Number.isSafeInteger(body.expectedLocationVersion)||!Number.isSafeInteger(body.expectedMinimumMinor)||typeof body.payerReference!=='string')return reply.code(400).send({error:{message:'请核对桌次、金额、原订单与共享确认'}})
   const provider=body.provider??options.onlinePaymentProvider??'postar',method=body.method
   if(!(['cash:cash','physical_pos:card','external_manual:manual','postar:native_qr','postar:auth_code','simulation:native_qr'].includes(`${provider}:${method}`)))return reply.code(400).send({error:{message:'收款方式无效'}})
   if(!['cash','physical_pos','external_manual'].includes(provider)){
    if(!options.onlinePayments)throw new Error('线上支付未配置')
    options.onlinePayments.assertAvailable(provider==='simulation'?'simulation':'postar')
    if(method==='auth_code'&&(typeof body.customerAuthCode!=='string'||!/^\d{16,24}$/.test(body.customerAuthCode)))return reply.code(400).send({error:{message:'请扫描有效顾客付款码'}})
   }
   const input:StaffCreditInput={sessionId:body.sessionId!,employeeId:context.employeeId,amountMinor:body.amountMinor!,expectedLocationVersion:body.expectedLocationVersion!,expectedMinimumMinor:body.expectedMinimumMinor!,orderIds:[...new Set(body.orderIds)].sort(),payerReference:body.payerReference,sharedTableConsent:true,provider,method:method!,receiptReference:body.receiptReference,terminalId:body.terminalId,externalMethodCode:body.externalMethodCode,collectionNote:body.collectionNote,publicId:`prepaid-${randomUUID()}`,businessDate:context.businessDate}
   await options.transactions.run(context.scope,tx=>assertStaffCreditAccess(tx,context.employeeId,provider,input.sessionId,true),{readOnly:true})
   const {publicId:_,businessDate:__,...fingerprint}=input
   const execution=await new NormalizedCommandExecutor(options.transactions).execute<JsonObject>({scope:context.scope,operationScope:'staff.table-prepayment',idempotencyKey:key,retainReceipt:true,rejectExpiredReceipt:true,authorizeReplay:tx=>assertStaffCreditAccess(tx,context.employeeId,provider,input.sessionId,true),requestFingerprint:createHash('sha256').update(JSON.stringify({...fingerprint,authCodeHash:body.customerAuthCode?createHash('sha256').update(body.customerAuthCode).digest('hex'):null})).digest('hex'),resultCodec:{encode:v=>v,decode:v=>v as JsonObject}},async tx=>{
    const {payment,messages}=await collectStaffCredit(tx,input)
    const result=JSON.parse(JSON.stringify(payment)) as JsonObject
    return{result,auditEvents:[{actor:context.actor,action:'table.prepayment.staff_collected',objectType:'payment',objectId:payment.id,businessDate:context.businessDate,afterData:{amountMinor:payment.amountMinor,status:payment.status,orderIds:input.orderIds,sessionId:input.sessionId},reason:input.payerReference}],outboxMessages:messages}
   })
   const action=['cash','physical_pos','external_manual'].includes(provider)?null:await options.onlinePayments!.create({scope:context.scope,paymentId:String(execution.value.id),principal:{type:'employee',employeeId:context.employeeId},clientIp:request.ip,operatorId:context.employeeId,idempotencyKey:key,...(body.customerAuthCode?{customerAuthCode:body.customerAuthCode}:{})})
   return reply.send({data:{payment:execution.value,action},meta:{replayed:execution.replayed}})
  }catch(e){return fail(reply,e)}
 })
}
function fail(reply:import('fastify').FastifyReply,e:unknown){
 const status=e instanceof NormalizedAuthenticationRequiredError?401:e instanceof StaffAccessDeniedError||e instanceof EmployeeTableAccessDeniedError?403:e instanceof TablePrepaymentError||e instanceof IdempotencyConflictError||e instanceof IdempotencyInProgressError||e instanceof IdempotencyReceiptUnavailableError?409:e instanceof TypeError||e instanceof PaymentEvidenceError?400:500
 return reply.code(status).send({error:{code:e instanceof TablePrepaymentError?e.code:'TABLE_PREPAYMENT_ERROR',message:status===500?'预收款结果待核对，请重试同一操作或查询原付款':e instanceof Error?e.message:'操作失败'}})
}
