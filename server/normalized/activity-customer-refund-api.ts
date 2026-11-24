import {createHash} from 'node:crypto'
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify'
import {NormalizedCommandExecutor,NativeCommandNotCommittedError,type JsonObject} from './command-executor.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
import type {PublicCustomerExperienceContext} from './customer-experience-service.js'
import {CustomerExperienceRequestError} from './customer-experience-repository.js'
import {RefundRepository} from './refund-repository.js'

type Options={transactions:Pick<ScopedPostgresTransactionRunner,'run'>;resolvePublicContext(request:FastifyRequest):Promise<PublicCustomerExperienceContext>|PublicCustomerExperienceContext;handle(reply:FastifyReply,action:()=>Promise<unknown>):Promise<unknown>}
export async function registerActivityCustomerRefundRoutes(app:FastifyInstance,options:Options){
 const commands=new NormalizedCommandExecutor(options.transactions)
 app.post<{Params:{registrationPublicId:string}}>('/public/mini/activity-registrations/:registrationPublicId/refund-request',async(request,reply)=>options.handle(reply,async()=>{
  const context=await options.resolvePublicContext(request),registrationPublicId=request.params.registrationPublicId,raw=request.headers['idempotency-key'],body=request.body as {reason?:unknown;ticketId?:unknown}|null
  if(typeof raw!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(raw)||typeof registrationPublicId!=='string'||registrationPublicId.length<8||registrationPublicId.length>128||!body||typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.trim().length>500)throw new CustomerExperienceRequestError('请填写退订原因并保留原申请凭据','ACTIVITY_REFUND_REQUEST_INVALID',400)
  const reason=body.reason.trim(),key=createHash('sha256').update(`${context.customerId}:${raw}`).digest('hex')
  const ticketId=body.ticketId
  if(ticketId!==undefined && (typeof ticketId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ticketId))) throw new CustomerExperienceRequestError('票号格式不正确')
  const owned=async(tx:ScopedTransaction)=>{
   const row=(await tx.query<{id:string;payment_id:string|null;service_version:number;staff_handles_order:boolean;contact:string|null}>(`SELECT r.id,r.payment_id,r.service_version,(r.service_version=3 OR r.purchase_kind IS NOT NULL OR r.fee_amount_minor>0) AS staff_handles_order,(SELECT et.service_contact FROM mbox.table_ticket_purchases p JOIN mbox.table_ticket_offers o ON(o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
     JOIN mbox.table_ticket_event_terms et ON(et.tenant_id,et.store_id,et.id)=(o.tenant_id,o.store_id,o.event_terms_id)
     WHERE(p.tenant_id,p.store_id,p.registration_id)=(r.tenant_id,r.store_id,r.id)) AS contact FROM mbox.community_activity_registrations r
     WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.public_id=$3
       AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id($1,$2,$4)`,[context.scope.tenantId,context.scope.storeId,registrationPublicId,context.customerId])).rows[0]
   if(!row)throw new CustomerExperienceRequestError('未找到本人的报名记录','ACTIVITY_REGISTRATION_NOT_FOUND',404)
   if(row.service_version===4)throw new CustomerExperienceRequestError('请联系门店办理退票。'+(row.contact || '联系方式见小程序「我的 → 联系我们」。'),'TICKET_CONTACT_STORE',409)
   if(row.staff_handles_order)throw new CustomerExperienceRequestError('如需退订商品或门票，请联系工作人员。','ORDER_CONTACT_STORE',409)
   return row
  }
  try {
   const execution=await commands.execute<JsonObject>({scope:context.scope,operationScope:'customer.activity.refund-request',idempotencyKey:key,requestFingerprint:JSON.stringify({customerId:context.customerId,registrationPublicId,reason,ticketId}),retainReceipt:true,resultCodec:{encode:value=>value,decode:value=>value as JsonObject}},async tx=>{
    const registration=await owned(tx)
    if(!registration.payment_id)throw new CustomerExperienceRequestError('该报名没有可退的原付款，请联系门店核对','ACTIVITY_REFUND_NOT_ALLOWED',409)
    if(ticketId)throw new CustomerExperienceRequestError('票号不属于原单','TICKET_NOT_FOUND',404)
    const refund=await new RefundRepository(tx).requestActivity({paymentId:registration.payment_id,publicId:`acr_${createHash('sha256').update(`${context.scope.storeId}:${key}`).digest('hex').slice(0,40)}`,reason,requestedByCustomerId:context.customerId,requestEvidence:{registrationPublicId}})
    const result={refundPublicId:refund.publicId,status:refund.status,amountMinor:refund.amountMinor,currency:refund.currency}
    return {result,auditEvents:[{actor:{type:'guest' as const,ref:context.actorRef},action:'refund.activity_requested',objectType:'refund',objectId:refund.id,businessDate:context.businessDate,reason,afterData:{...result,requestedByCustomerId:context.customerId,registrationPublicId}}],outboxMessages:[{aggregateType:'refund',aggregateId:refund.id,aggregateVersion:1,eventType:'refund.activity_requested.v1',payload:{...result,paymentId:refund.paymentId,activityRegistrationId:refund.activityRegistrationId,requestedByCustomerId:context.customerId}}]}
   },async tx=>{await owned(tx)})
   return reply.send({data:execution.value,meta:{replayed:execution.replayed}})
  }catch(error){if(error instanceof NativeCommandNotCommittedError)throw error.original;throw error}
 }))
}
