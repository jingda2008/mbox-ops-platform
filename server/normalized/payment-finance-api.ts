import {createHash} from 'node:crypto'
import type {FastifyPluginAsync,FastifyRequest} from 'fastify'
import {IdempotencyConflictError,IdempotencyInProgressError,type NormalizedCommandExecutor,type JsonObject} from './command-executor.js'
import type {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import type {NormalizedOperationsRequestContext} from './normalized-operations-api.js'
import {StaffAccessRepository,StaffAccessDeniedError} from './staff-access-repository.js'
interface Options {transactions:Pick<ScopedPostgresTransactionRunner,'run'>;commands:Pick<NormalizedCommandExecutor,'execute'>;resolveContext(request:FastifyRequest):Promise<NormalizedOperationsRequestContext>|NormalizedOperationsRequestContext}
export const paymentFinanceApiPlugin:FastifyPluginAsync<Options>=async(app,options)=>{
 app.setErrorHandler((error,_request,reply)=>{const auth=error instanceof Error&&/AuthenticationRequired|StaffSessionNotFound/.test(error.name);const status=auth?401:error instanceof StaffAccessDeniedError?403:500;return reply.code(status).send({error:{code:auth?'AUTH_REQUIRED':status===403?'STAFF_ACCESS_FORBIDDEN':'FINANCE_REVIEW_UNAVAILABLE',message:auth?'登录已失效，请重新登录':status===403?'当前岗位没有财务核对查看权限':'财务核对暂未读取，请稍后重试'}})})
 app.get('/payments/finance-review',async(request,reply)=>{
  const context=await options.resolveContext(request)
  const page=Number((request.query as {page?:string}).page??0)
  if(!Number.isSafeInteger(page)||page<0||page>100000)return reply.code(400).send({error:{code:'REQUEST_INVALID',message:'查询页码无效'}})
  const data=await options.transactions.run(context.scope,async tx=>{
   await new StaffAccessRepository(tx).assertPermission(context.employeeId,'reconciliation.view')
   return (await tx.query(`SELECT p.id,p.public_id AS "publicId",p.amount_minor::text AS "amountMinor",p.status,p.created_at::text AS "createdAt",
    s.phase,s.stop_reason AS "stopReason",s.next_query_at::text AS "nextQueryAt",s.total_query_count AS "queryCount",
    c.status AS "caseStatus",c.note,e.display_name AS "ownerName",c.owner_employee_id AS "ownerEmployeeId",
    o.public_id AS "orderPublicId",t.code AS "tableCode",financial.signals AS "financialSignals",count(*) FILTER(WHERE financial.signals IS NOT NULL) OVER()::int AS "urgentCount"
    FROM mbox.payments p LEFT JOIN mbox.payment_reconciliation_states s ON s.tenant_id=p.tenant_id AND s.store_id=p.store_id AND s.payment_id=p.id
    LEFT JOIN mbox.payment_finance_cases c ON c.tenant_id=p.tenant_id AND c.store_id=p.store_id AND c.payment_id=p.id
    LEFT JOIN mbox.employees e ON e.tenant_id=c.tenant_id AND e.store_id=c.store_id AND e.id=c.owner_employee_id
    LEFT JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
    LEFT JOIN mbox.order_payment_batches batch ON batch.tenant_id=p.tenant_id AND batch.store_id=p.store_id AND batch.id=p.order_batch_id
    LEFT JOIN mbox.table_sessions visit ON visit.tenant_id=p.tenant_id AND visit.store_id=p.store_id AND visit.id=COALESCE(o.table_session_id,batch.table_session_id)
    LEFT JOIN mbox.tables t ON t.tenant_id=visit.tenant_id AND t.store_id=visit.store_id AND t.id=visit.table_id
    LEFT JOIN LATERAL(SELECT array_agg(DISTINCT signal.signal) AS signals FROM (SELECT signal FROM mbox.payment_financial_monitoring_signals signal
      WHERE signal.tenant_id=p.tenant_id AND signal.store_id=p.store_id AND (signal.subject_id=p.id OR EXISTS(SELECT 1 FROM mbox.order_payment_facts fact WHERE fact.tenant_id=p.tenant_id AND fact.store_id=p.store_id AND fact.id=p.id AND fact.order_id=signal.subject_id))
        AND signal.signal IN ('order_overcollected','cancelled_order_captured','succeeded_payment_missing_reconciliation')
      UNION ALL SELECT 'confirmed_payment_not_applied' WHERE p.status NOT IN ('succeeded','partially_refunded','refunded') AND EXISTS(
        SELECT 1 FROM mbox.verified_provider_observations v WHERE v.tenant_id=p.tenant_id AND v.store_id=p.store_id AND v.payment_id=p.id
          AND v.observed_status='payment_succeeded' AND v.consumed_at IS NULL)
      ) signal) financial ON true
    WHERE p.tenant_id=$1 AND p.store_id=$2 AND (financial.signals IS NOT NULL OR p.status IN ('created','pending') OR c.status='reviewing')
    ORDER BY (financial.signals IS NOT NULL) DESC,p.created_at,p.id LIMIT 101 OFFSET $3`,[context.scope.tenantId,context.scope.storeId,page*100])).rows
  },{readOnly:true})
  return reply.send({data:data.slice(0,100),hasMore:data.length>100,urgentCount:data[0]?.urgentCount??0})
 })
 app.post('/payments/:paymentId/finance-review',async(request,reply)=>{
  try{
   const context=await options.resolveContext(request),paymentId=(request.params as {paymentId:string}).paymentId
   const body=request.body as {note?:unknown;resolve?:unknown}|null,key=request.headers['idempotency-key']
   if(!/^[0-9a-f-]{36}$/i.test(paymentId)||!body||typeof body.note!=='string'||body.note.trim().length<3||body.note.length>1000||typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))return reply.code(400).send({error:{code:'REQUEST_INVALID',message:'请填写3至1000字的核对记录，并使用有效请求编号'}})
   if(body.resolve!==undefined&&typeof body.resolve!=='boolean')return reply.code(400).send({error:{code:'REQUEST_INVALID',message:'结案选项无效'}})
   const note=body.note.trim(),resolve=body.resolve===true
   const result=await options.commands.execute({scope:context.scope,operationScope:'payment.finance-review',idempotencyKey:key,
    requestFingerprint:createHash('sha256').update(JSON.stringify({employeeId:context.employeeId,paymentId,note,resolve})).digest('hex'),
    resultCodec:{encode:(value:JsonObject)=>value,decode:value=>value as JsonObject}},async tx=>{
     await new StaffAccessRepository(tx).assertPermission(context.employeeId,'reconciliation.view')
     await new StaffAccessRepository(tx).assertPermission(context.employeeId,'reconciliation.manage')
     const payment=(await tx.query<{status:string}>('SELECT status FROM mbox.payments WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[context.scope.tenantId,context.scope.storeId,paymentId])).rows[0]
     if(!payment)throw new TypeError('付款记录不存在或不属于当前门店')
     if(resolve){const unapplied=await tx.query(`SELECT 1 FROM mbox.verified_provider_observations WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND observed_status='payment_succeeded' AND consumed_at IS NULL AND $4 NOT IN ('succeeded','partially_refunded','refunded') LIMIT 1`,[context.scope.tenantId,context.scope.storeId,paymentId,payment.status]);if(unapplied.rowCount)throw new TypeError('渠道已确认支付成功，但本地尚未入账；请先恢复账务，不能结案')}
     if(resolve&&['created','pending'].includes(payment.status))throw new TypeError('原支付仍未知，不能结案；可保存核对进展，营业收款不受影响')
     const before=(await tx.query('SELECT owner_employee_id,note,status FROM mbox.payment_finance_cases WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3',[context.scope.tenantId,context.scope.storeId,paymentId])).rows[0] as JsonObject|undefined
     if(resolve&&['succeeded','partially_refunded','refunded'].includes(payment.status)){const evidence=await tx.query("SELECT id FROM mbox.reconciliation_entries WHERE tenant_id=$1 AND store_id=$2 AND payment_id=$3 AND entry_type='payment' LIMIT 1",[context.scope.tenantId,context.scope.storeId,paymentId]);if(!evidence.rowCount)throw new TypeError('付款成功但尚缺对应入账流水，不能结案；请继续财务核对')}
     if(resolve){const open=await tx.query(`SELECT 1 FROM mbox.payment_financial_monitoring_signals signal WHERE signal.tenant_id=$1 AND signal.store_id=$2 AND signal.signal IN ('order_overcollected','cancelled_order_captured') AND EXISTS(SELECT 1 FROM mbox.order_payment_facts fact WHERE fact.tenant_id=$1 AND fact.store_id=$2 AND fact.id=$3 AND fact.order_id=signal.subject_id) LIMIT 1`,[context.scope.tenantId,context.scope.storeId,paymentId]);if(open.rowCount)throw new TypeError('仍有已确认多收或取消订单到账待退款，请完成退款后再结案')}
     await tx.query(`INSERT INTO mbox.payment_finance_cases(tenant_id,store_id,payment_id,owner_employee_id,note,status,resolved_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='resolved' THEN clock_timestamp() ELSE NULL END)
      ON CONFLICT(tenant_id,store_id,payment_id) DO UPDATE SET owner_employee_id=excluded.owner_employee_id,note=excluded.note,status=excluded.status,resolved_at=excluded.resolved_at,updated_at=clock_timestamp()`,
     [context.scope.tenantId,context.scope.storeId,paymentId,context.employeeId,note,resolve?'resolved':'reviewing'])
     const value:JsonObject={paymentId,ownerEmployeeId:context.employeeId,note,status:resolve?'resolved':'reviewing'}
     return {result:value,auditEvents:[{actor:{type:'employee' as const,employeeId:context.employeeId},action:'payment.finance_review.updated',objectType:'payment',objectId:paymentId,businessDate:context.businessDate,beforeData:before??null,afterData:value}],outboxMessages:[]}
    })
   return reply.send({data:result.value,replayed:result.replayed})
  }catch(error){
   const authentication=error instanceof Error&&/AuthenticationRequired|StaffSessionNotFound/.test(error.name)
   const status=authentication?401:error instanceof StaffAccessDeniedError?403:error instanceof TypeError?400:error instanceof IdempotencyConflictError?409:error instanceof IdempotencyInProgressError?425:500
   return reply.code(status).send({error:{code:status===401?'AUTH_REQUIRED':status===403?'STAFF_ACCESS_FORBIDDEN':status===409?'IDEMPOTENCY_CONFLICT':status===425?'IDEMPOTENCY_IN_PROGRESS':'FINANCE_REVIEW_FAILED',message:status===401?'登录已失效，请重新登录':status===500?'核对记录保存结果未确认，请用原请求重试':error instanceof Error?error.message:'请求未完成'}})
  }
 })
}
