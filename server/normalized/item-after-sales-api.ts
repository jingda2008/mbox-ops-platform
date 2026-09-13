import type {CommerceKdsRequestContext} from './commerce-kds-api.js'
import {QuantityRemakeHandoverQuery,QuantityRemakeHandoverCommand} from './quantity-remake-handover.js'
import {QuantityRedeliveryCommandService} from './quantity-redelivery-command-service.js'
import type {FastifyPluginAsync,FastifyReply,FastifyRequest} from 'fastify'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor,IdempotencyConflictError,IdempotencyInProgressError} from './command-executor.js'
import type {NormalizedOperationsRequestContext} from './normalized-operations-api.js'
import {NormalizedAuthenticationRequiredError} from './normalized-request-context.js'
import {StaffSessionNotFoundError} from './staff-session-repository.js'
import {StaffAccessDeniedError} from './staff-access-repository.js'
import {EmployeeTableAccessDeniedError} from './employee-table-access.js'
import {RefundLimitError} from './refund-repository.js'
import {ItemQuantityConflict} from './order-item-quantity-plan.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {ItemAfterSalesQuery} from './item-after-sales-query.js'
import {ItemAfterSalesHandoverQuery} from './item-after-sales-handover-query.js'

export interface ItemAfterSalesApiOptions {
  resolveKdsContext?(request:FastifyRequest):Promise<CommerceKdsRequestContext>|CommerceKdsRequestContext
  enabled?:boolean
  transactions:ScopedPostgresTransactionRunner;commands:NormalizedCommandExecutor
  resolveContext(request:FastifyRequest):Promise<NormalizedOperationsRequestContext>|NormalizedOperationsRequestContext
}
/** Register together with the employee workspace only after the complete batch
 * is accepted. This plugin does not change any printer or grant permissions. */
export const itemAfterSalesApiPlugin:FastifyPluginAsync<ItemAfterSalesApiOptions>=async(app,options)=>{
  app.get('/commerce/item-after-sales/access',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request)
    const recoveryAvailable=options.enabled===false&&await options.transactions.run(context.scope,async tx=>(await tx.query<{found:boolean}>(`SELECT EXISTS(
      SELECT 1 FROM mbox.item_after_sales_cases WHERE tenant_id=$1 AND store_id=$2) OR EXISTS(SELECT 1 FROM mbox.quantity_redeliveries WHERE tenant_id=$1 AND store_id=$2) OR EXISTS(SELECT 1 FROM mbox.quantity_remake_batches WHERE tenant_id=$1 AND store_id=$2) AS found`,[context.scope.tenantId,context.scope.storeId])).rows[0]?.found===true,{readOnly:true})
    return {data:{enabled:options.enabled!==false,recoveryAvailable,employeeId:context.employeeId}}
  }))
  const service=new ItemAfterSalesCommandService(options.commands,new ItemAfterSalesOperatingEffects(),options.enabled!==false)
  const redelivery=new QuantityRedeliveryCommandService(options.commands,options.enabled!==false)
  const query=new ItemAfterSalesQuery(options.transactions,options.enabled!==false),handover=new ItemAfterSalesHandoverQuery(options.transactions)
  const metadata=async(request:FastifyRequest)=>{
    const context=await options.resolveContext(request),body=object(request.body)
    const idempotencyKey=request.headers['idempotency-key']
    if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>160)throw new TypeError('原操作编号无效，请重新打开商品')
    if(typeof body.reason!=='string')throw new TypeError('请选择实际原因')
    return {...context,idempotencyKey,reason:body.reason}
  }
  app.get('/commerce/item-after-sales/items/:itemId',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request)
    const kdsContext=options.resolveKdsContext?await options.resolveKdsContext(request):undefined
    if(kdsContext&&(kdsContext.employeeId!==context.employeeId||kdsContext.scope.tenantId!==context.scope.tenantId||kdsContext.scope.storeId!==context.scope.storeId))throw new StaffAccessDeniedError('商品与制作登录身份不一致')
    return {data:await query.item({...context,itemId:uuid(object(request.params).itemId),staffSessionId:kdsContext?.staffSessionId,deviceAccessLeaseId:kdsContext?.deviceAccessLeaseId})}
  }))
  app.get('/commerce/item-after-sales/pending',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request),params=object(request.query)
    const cursor=params.cursorId===undefined?undefined:{id:uuid(params.cursorId),createdAt:String(params.createdAt??'')}
    return {data:await handover.list({...context,limit:25,cursor})}
  }))
  app.get('/commerce/item-after-sales/remake-handover',async(request,reply)=>handle(reply,async()=>{
    const context=await options.resolveContext(request),params=object(request.query)
    const cursor=params.cursorId===undefined?undefined:{id:uuid(params.cursorId),createdAt:String(params.createdAt??'')}
    return {data:await new QuantityRemakeHandoverQuery(options.transactions).list({...context,cursor})}
  }))
  app.post('/commerce/item-after-sales/remakes/:batchId/after-visit-physical',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body),disposition=body.disposition
    if(disposition!=='used_loss'&&disposition!=='returned_unopened')throw new TypeError('请选择实际实物去向')
    if(!Array.isArray(body.unitIds))throw new TypeError('请选择本批实际处理份数')
    const result=await new QuantityRemakeHandoverCommand(options.commands).dispose({...input,batchId:uuid(object(request.params).batchId),unitIds:body.unitIds.map(uuid),disposition,unopenedReceived:body.unopenedReceived===true})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/redeliveries',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    const result=await redelivery.request({...input,orderItemId:uuid(body.orderItemId),quantity:quantity(body.quantity),originalGoodsAvailable:body.originalGoodsAvailable===true})
    reply.code(result.replayed?200:201);return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/redeliveries/:redeliveryId/cancel',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request)
    const result=await redelivery.cancel({...input,redeliveryId:uuid(object(request.params).redeliveryId)})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/redeliveries/:redeliveryId/complete',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    const result=await redelivery.complete({...input,redeliveryId:uuid(object(request.params).redeliveryId),quantity:quantity(body.quantity)})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/requests',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    const result=await service.request({...input,orderItemId:uuid(body.orderItemId),quantity:quantity(body.quantity)})
    reply.code(result.replayed?200:201);return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/decision',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body),decision=body.decision
    if(decision!=='approved'&&decision!=='rejected'&&decision!=='withdrawn')throw new TypeError('请选择审核结果')
    const funding=body.funding===undefined?undefined:(()=>{
      if(!Array.isArray(body.funding)||body.funding.length>50)throw new TypeError('请核对原付款分摊')
      return body.funding.map(value=>{const row=object(value);if(typeof row.amountMinor!=='number'||!Number.isSafeInteger(row.amountMinor)||row.amountMinor<=0)throw new TypeError('原付款退回金额无效');return {paymentId:uuid(row.paymentId),amountMinor:row.amountMinor}})
    })()
    if(funding&&decision!=='approved')throw new TypeError('仅审核通过时确认原付款分摊')
    const result=await service.decide({...input,caseId:uuid(object(request.params).caseId),decision,funding})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/revision',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    const result=await service.revise({...input,caseId:uuid(object(request.params).caseId),quantity:quantity(body.quantity)})
    reply.code(result.replayed?200:201);return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/resume',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),result=await service.resume({...input,caseId:uuid(object(request.params).caseId)})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/physical',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body),disposition=body.disposition
    if(disposition!=='used_loss'&&disposition!=='returned_unopened')throw new TypeError('请选择实际实物去向')
    if(!Array.isArray(body.unitIds))throw new TypeError('请选择实际处理的份数')
    const result=await service.disposeMade({...input,caseId:uuid(object(request.params).caseId),unitIds:body.unitIds.map(uuid),disposition,unopenedReceived:body.unopenedReceived===true})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/notice-ack',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    if(!Array.isArray(body.noticeIds))throw new TypeError('请选择已核实的岗位通知')
    const result=await service.acknowledgeNotices({...input,caseId:uuid(object(request.params).caseId),noticeIds:body.noticeIds.map(uuid)})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/refund-retry',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),body=object(request.body)
    const result=await service.retryRefund({...input,caseId:uuid(object(request.params).caseId),refundId:uuid(body.refundId)})
    return {data:result.value,replayed:result.replayed}
  }))
  app.post('/commerce/item-after-sales/:caseId/resolve-unpaid',async(request,reply)=>handle(reply,async()=>{
    const input=await metadata(request),result=await service.resolveUnpaid({...input,caseId:uuid(object(request.params).caseId)})
    return {data:result.value,replayed:result.replayed}
  }))
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('请求内容无效');return value as Record<string,unknown>}
function uuid(value:unknown){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new TypeError('原商品或申请编号无效');return value}
function quantity(value:unknown){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>999)throw new TypeError('请选择1至999份实际数量');return value}
async function handle(reply:FastifyReply,run:()=>Promise<unknown>){
  try{return await run()}catch(error){
    const [status,code,message]=error instanceof NormalizedAuthenticationRequiredError||error instanceof StaffSessionNotFoundError?[401,'STAFF_SESSION_REQUIRED','请恢复员工登录后继续原操作']
      :error instanceof StaffAccessDeniedError||error instanceof EmployeeTableAccessDeniedError?[403,'STAFF_ACCESS_FORBIDDEN',error.message]
      :error instanceof RefundLimitError?[409,'PRICE_REVIEW_REQUIRED','原付款可退余额或商品退款分摊已变化，请核对原申请，未创建新的退款']
      :error instanceof ItemQuantityConflict?[409,error.code,error.message]
      :error instanceof IdempotencyInProgressError?[409,'IDEMPOTENCY_IN_PROGRESS','原操作处理中，请恢复原结果']
      :error instanceof IdempotencyConflictError?[409,'IDEMPOTENCY_CONFLICT','原操作编号不能更换商品、数量或金额']
      :error instanceof TypeError?[400,'REQUEST_INVALID',error.message]:[500,'INTERNAL_ERROR','操作结果待确认，请恢复原结果']
    if(status===500)reply.log.error({err:error},'item after-sales command failed')
    return reply.code(Number(status)).send({error:{code,message}})
  }
}
