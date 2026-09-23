import {createHash,randomUUID} from 'node:crypto'
import type {OrderFinancialRecoveryDecisionInput,OrderFinancialRecoveryDimensions,OrderFinancialRecoveryPage,OrderFinancialRecoveryPreview,OrderFinancialRecoveryRequestInput,OrderFinancialRecoveryRequestView,OrderFinancialRecoveryResult,OrderRecoverySnapshot} from '../../src/shared/order-financial-recovery.js'
import {appendAuditEvent,IdempotencyConflictError} from './command-executor.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import {LoyaltyRecollectionRepository} from './loyalty-recollection-repository.js'
import {RecommendationFinancialAttributionRepository} from './recommendation-financial-attribution-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'

export class OrderFinancialRecoveryError extends Error {
  readonly statusCode=409
  commitDisposition:'not_committed'|undefined
  constructor(readonly code:string,message:string){super(message);this.name='OrderFinancialRecoveryError'}
}
function fail(code:string,message:string):never{throw new OrderFinancialRecoveryError(`ORDER_RECOVERY_${code}`,message)}
const scope=(tx:ScopedTransaction)=>[tx.scope.tenantId,tx.scope.storeId]
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const validDimensions=(v:unknown):v is OrderFinancialRecoveryDimensions=>v==='attribution'||v==='loyalty'||v==='all'
interface RequestRow extends Record<string,unknown>{id:string;order_id:string;order_public_id:string;basis_sha256:string;dimensions:OrderFinancialRecoveryDimensions;preview_snapshot:OrderRecoverySnapshot;requested_by_employee_id:string;requester:string;reason:string;created_at:string;decision:'approved'|'rejected'|null;decider:string|null;decision_reason:string|null;result:OrderFinancialRecoveryResult|null}

/** All inputs name original facts. Staff never submit points or monetary amounts. */
export class OrderFinancialRecoveryService {
  constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>){}

  list(context:StaffCustomerExperienceContext,input:{orderPublicId?:string;after?:string}={}):Promise<OrderFinancialRecoveryPage>{
    return this.transactions.run(context.scope,async tx=>{
      const permissions=await permission(tx,context.employeeId,'view')
      if(input.after&&!validId(input.after))fail('INVALID','翻页凭据无效，请重新读取')
      if(input.orderPublicId!==undefined&&(typeof input.orderPublicId!=='string'||input.orderPublicId.trim().length<1||input.orderPublicId.length>160))fail('INVALID','请输入完整原订单号')
      const rows=(await tx.query<{id:string}>(`SELECT ordering.id FROM mbox.orders ordering
        WHERE ordering.tenant_id=$1 AND ordering.store_id=$2
          AND ($3::text IS NULL OR ordering.public_id=$3)
          AND ($4::uuid IS NULL OR ordering.id>$4)
          AND ($3::text IS NOT NULL OR EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
            WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)))
        ORDER BY ordering.id LIMIT 21`,[...scope(tx),input.orderPublicId?.trim()??null,input.after??null])).rows
      const orders:OrderFinancialRecoveryPreview[]=[]
      for(const row of rows.slice(0,20))orders.push(maskPreview((await loadPreview(tx,row.id)).view,permissions))
      return {orders,nextCursor:rows.length>20?rows[19]!.id:null}
    },{readOnly:true,isolation:'repeatable-read'})
  }

  request(context:StaffCustomerExperienceContext,orderId:string,input:OrderFinancialRecoveryRequestInput,key:string){
    return this.execute(context,'request',key,{orderId,...input},async tx=>{
      await permission(tx,context.employeeId,'request',input.dimensions)
      await lockOrder(tx,orderId)
      const {view}=await loadPreview(tx,orderId)
      checkVersion(input.basisVersion,view.basisVersion)
      if(!validDimensions(input.dimensions)||!view.availableDimensions.includes(input.dimensions))fail('BLOCKED','所选恢复范围尚不符合原事实或规则，请刷新预览')
      if(view.requests.some(r=>r.status==='requested'))fail('PENDING_REQUEST','原订单已有待复核申请，请先处理原申请')
      const requestId=randomUUID()
      const snapshot:OrderRecoverySnapshot={attribution:view.attribution,loyalty:view.loyalty}
      await tx.query(`INSERT INTO mbox.order_financial_recovery_requests
        (id,tenant_id,store_id,order_id,basis_sha256,dimensions,preview_snapshot,requested_by_employee_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[requestId,...scope(tx),orderId,view.basisVersion,input.dimensions,JSON.stringify(snapshot),context.employeeId,input.reason.trim()])
      return result(requestId,view,input.dimensions,'requested')
    })
  }

  decide(context:StaffCustomerExperienceContext,requestId:string,input:OrderFinancialRecoveryDecisionInput,key:string){
    return this.execute(context,'decision',key,{requestId,...input},async tx=>{
      if(!validId(requestId))fail('INVALID','申请编号无效')
      const original=(await tx.query<{order_id:string;dimensions:OrderFinancialRecoveryDimensions}>(`SELECT order_id,dimensions FROM mbox.order_financial_recovery_requests WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope(tx),requestId])).rows[0]
      if(!original)fail('NOT_FOUND','原申请不存在或不属于当前门店')
      await permission(tx,context.employeeId,'decision',original.dimensions)
      await lockOrder(tx,original.order_id)
      const {view,recoveryPaymentId}=await loadPreview(tx,original.order_id)
      const request=view.requests.find(r=>r.requestId===requestId)
      if(!request)fail('NOT_FOUND','请读取该订单最近的原申请')
      if(request.status==='approved'||request.status==='rejected')fail('ALREADY_DECIDED','原申请已完成复核，请读取原结果')
      if(request.requestedByEmployeeId===context.employeeId)fail('SELF_APPROVAL','申请人不能复核自己的恢复申请')
      checkVersion(input.basisVersion,request.basisVersion)
      if(input.decision!=='approve'&&input.decision!=='reject')fail('INVALID','请选择通过或驳回')
      let value=result(requestId,view,request.dimensions,input.decision==='approve'?'approved':'rejected')
      if(input.decision==='approve'){
        if(request.status==='superseded')fail('SUPERSEDED','已有后续申请，请处理最新申请')
        checkVersion(request.basisVersion,view.basisVersion)
        if(!view.availableDimensions.includes(request.dimensions)||!recoveryPaymentId)fail('BLOCKED','当前事实或规则不允许此恢复，请重新核对')
        const includesAttribution=request.dimensions!=='loyalty',includesLoyalty=request.dimensions!=='attribution'
        if(includesAttribution){
          await new RecommendationFinancialAttributionRepository(tx).restoreRecollectedForOrder({orderId:view.orderId,paymentId:recoveryPaymentId,actorRef:`recovery-request:${requestId}`})
          value={...value,itemAmountMinor:view.attribution.itemAmountMinor,recommendationAmountMinor:view.attribution.recommendationDeltaMinor}
        }
        if(includesLoyalty){
          const applied=await new LoyaltyRecollectionRepository(tx).applyApprovedRecovery({orderId:view.orderId,requestId,paymentId:recoveryPaymentId,actorRef:`recovery-request:${requestId}`,occurredAt:new Date().toISOString()})
          for(const field of ['pointsDelta','growthDelta','availablePointsDelta','pendingRecoveryPointsDelta'] as const){
            if(applied[field]!==view.loyalty[field])throw new Error('Authoritative recovery changed after approval snapshot')
            value[field]=applied[field]
          }
        }
        // Never claim completion if core facts did not converge to the approved dimensions.
        const after=(await loadPreview(tx,view.orderId)).view
        if(includesAttribution&&(after.attribution.itemAmountMinor!==0||after.attribution.recommendationDeltaMinor!==0))throw new Error('Attribution recovery did not converge')
        if(includesLoyalty&&(after.loyalty.status==='ready'||after.loyalty.eligibleAmountMinor!==0||after.loyalty.pointsDelta!==0||after.loyalty.growthDelta!==0))throw new Error('Loyalty recovery did not converge')
      }
      await tx.query(`INSERT INTO mbox.order_financial_recovery_decisions
        (tenant_id,store_id,request_id,order_id,requested_by_employee_id,decided_by_employee_id,decision,reason,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[...scope(tx),requestId,view.orderId,request.requestedByEmployeeId,context.employeeId,value.status,input.reason.trim(),JSON.stringify(value)])
      return value
    })
  }

  private execute(context:StaffCustomerExperienceContext,operation:'request'|'decision',key:string,input:{reason:string}&Record<string,unknown>,handler:(tx:ScopedTransaction)=>Promise<OrderFinancialRecoveryResult>){
    if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))fail('INVALID','原操作凭据无效')
    const fingerprint=digest({employeeId:context.employeeId,...input})
    return this.transactions.run(context.scope,async tx=>{
      await permission(tx,context.employeeId,operation)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`order-financial-recovery:${scope(tx).join(':')}:${operation}:${key}`])
      const receipt=(await tx.query<{actor_employee_id:string;request_sha256:string;result:OrderFinancialRecoveryResult}>(`SELECT actor_employee_id,request_sha256,result FROM mbox.order_financial_recovery_command_receipts WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND idempotency_key=$4`,[...scope(tx),operation,key])).rows[0]
      if(receipt){await permission(tx,context.employeeId,operation,receipt.result.dimensions);if(receipt.actor_employee_id!==context.employeeId||receipt.request_sha256!==fingerprint)throw new IdempotencyConflictError(`order.financial-recovery.${operation}`,key);return {value:receipt.result,replayed:true}}
      let value:OrderFinancialRecoveryResult
      try{
        if(typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.trim().length>1000)fail('INVALID','核对依据请填写3至1000字')
        value=await handler(tx)
      }catch(error){if(error instanceof OrderFinancialRecoveryError)error.commitDisposition='not_committed';throw error}
      await appendAuditEvent(tx,{actor:{type:'employee',employeeId:context.employeeId},action:`order.financial_recovery.${value.status}`,objectType:'order_financial_recovery_request',objectId:value.requestId,businessDate:context.businessDate,reason:input.reason.trim(),afterData:{...value}})
      await tx.query(`INSERT INTO mbox.order_financial_recovery_command_receipts(tenant_id,store_id,operation_scope,idempotency_key,actor_employee_id,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[...scope(tx),operation,key,context.employeeId,fingerprint,JSON.stringify(value)])
      return {value,replayed:false}
    })
  }
}
async function permission(tx:ScopedTransaction,employeeId:string,operation:'view'|'request'|'decision',dimensions?:OrderFinancialRecoveryDimensions){
  const access=new StaffAccessRepository(tx)
  await access.assertPermission(employeeId,'reconciliation.view')
  if(operation!=='view')await access.assertPermission(employeeId,'reconciliation.manage')
  if(dimensions==='loyalty'||dimensions==='all'){
    await access.assertPermission(employeeId,'loyalty.accrual.exception.view')
    if(operation!=='view')await access.assertPermission(employeeId,operation==='request'?'loyalty.accrual.request':'loyalty.accrual.approve')
  }
  return (await access.resolve(employeeId)).permissions
}
const hiddenLoyalty:OrderRecoverySnapshot['loyalty']={status:'permission_required',memberNo:null,policyVersionId:null,eligibleAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0,expiresAt:null,blockReasons:['loyalty_permission_required']}
function maskPreview(view:OrderFinancialRecoveryPreview,permissions:readonly string[]):OrderFinancialRecoveryPreview{
  if(permissions.includes('loyalty.accrual.exception.view'))return view
  return {...view,loyalty:hiddenLoyalty,availableDimensions:view.availableDimensions.filter(d=>d==='attribution'),requests:view.requests.map(r=>({...r,snapshot:{...r.snapshot,loyalty:hiddenLoyalty},result:r.result?{...r.result,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0}:null}))}
}
async function lockOrder(tx:ScopedTransaction,orderId:string){
  if(!validId(orderId))fail('INVALID','原订单编号无效')
  if(!(await tx.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...scope(tx),orderId])).rowCount)fail('NOT_FOUND','原订单不存在或不属于当前门店')
  await tx.query(`SELECT account.id FROM mbox.loyalty_order_awards award JOIN mbox.loyalty_accounts account
    ON (account.tenant_id,account.store_id,account.membership_id)=(award.tenant_id,award.store_id,award.membership_id)
    WHERE award.tenant_id=$1 AND award.store_id=$2 AND award.order_id=$3 FOR UPDATE OF award,account`,[...scope(tx),orderId])
}
function checkVersion(actual:string,expected:string){if(actual!==expected)fail('STALE','原收款、退款或奖励事实已变化，请刷新后重新核对')}
function result(requestId:string,view:OrderFinancialRecoveryPreview,dimensions:OrderFinancialRecoveryDimensions,status:OrderFinancialRecoveryResult['status']):OrderFinancialRecoveryResult{
  return {requestId,orderId:view.orderId,orderPublicId:view.orderPublicId,dimensions,status,itemAmountMinor:0,recommendationAmountMinor:0,pointsDelta:0,growthDelta:0,availablePointsDelta:0,pendingRecoveryPointsDelta:0}
}
async function loadPreview(tx:ScopedTransaction,orderId:string){
  const order=(await tx.query<{public_id:string;currency:string}>('SELECT public_id,currency FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...scope(tx),orderId])).rows[0]
  if(!order)fail('NOT_FOUND','原订单不存在或不属于当前门店')
  const attribution=await new RecommendationFinancialAttributionRepository(tx).previewRecollectedForOrder({orderId})
  const loyalty=await new LoyaltyRecollectionRepository(tx).previewOrderRecovery({orderId})
  const products=(await tx.query<{id:string;name:string}>(`SELECT id,COALESCE(product_snapshot->>'name','原商品') AS name FROM mbox.order_items WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[...scope(tx),orderId])).rows
  const snapshot:OrderRecoverySnapshot={attribution:{eligible:attribution.eligible,itemAmountMinor:attribution.items.filter(i=>!i.restored).reduce((sum,i)=>sum+i.amountMinor,0),recommendationCurrentMinor:attribution.recommendationCurrentMinor,recommendationExpectedMinor:attribution.recommendationExpectedMinor,recommendationDeltaMinor:attribution.recommendationDeltaMinor,blockReasons:attribution.blockReasons,items:attribution.items.map(i=>({orderItemId:i.orderItemId,productName:products.find(p=>p.id===i.orderItemId)?.name??'原商品',amountMinor:i.amountMinor,restored:i.restored}))},loyalty:{status:loyalty.status,memberNo:loyalty.memberNo,policyVersionId:loyalty.policyVersionId,eligibleAmountMinor:loyalty.eligibleAmountMinor,pointsDelta:loyalty.pointsDelta,growthDelta:loyalty.growthDelta,availablePointsDelta:loyalty.availablePointsDelta,pendingRecoveryPointsDelta:loyalty.pendingRecoveryPointsDelta,expiresAt:loyalty.expiresAt,blockReasons:loyalty.blockReasons}}
  const basisVersion=digest({orderId,attribution:attribution.basis,loyalty:loyalty.basis,snapshot})
  const needsAttribution=snapshot.attribution.itemAmountMinor>0||snapshot.attribution.recommendationDeltaMinor>0
  const availableDimensions:OrderFinancialRecoveryDimensions[]=[]
  if(needsAttribution&&attribution.eligible)availableDimensions.push('attribution')
  if(loyalty.status==='ready'&&(!needsAttribution||attribution.eligible))availableDimensions.unshift(needsAttribution?'all':'loyalty')
  const rows=(await tx.query<RequestRow>(`SELECT r.*,o.public_id AS order_public_id,e.display_name AS requester,d.decision,d.reason AS decision_reason,d.result,reviewer.display_name AS decider,r.created_at::text
    FROM mbox.order_financial_recovery_requests r
    JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(r.tenant_id,r.store_id,r.order_id)
    JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(r.tenant_id,r.store_id,r.requested_by_employee_id)
    LEFT JOIN mbox.order_financial_recovery_decisions d ON (d.tenant_id,d.store_id,d.request_id)=(r.tenant_id,r.store_id,r.id)
    LEFT JOIN mbox.employees reviewer ON (reviewer.tenant_id,reviewer.store_id,reviewer.id)=(d.tenant_id,d.store_id,d.decided_by_employee_id)
    WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.order_id=$3 ORDER BY r.created_at DESC,r.id DESC LIMIT 50`,[...scope(tx),orderId])).rows
  const requests:OrderFinancialRecoveryRequestView[]=rows.map((r,i)=>({requestId:r.id,orderId:r.order_id,orderPublicId:r.order_public_id,basisVersion:r.basis_sha256,dimensions:r.dimensions,requestedByEmployeeId:r.requested_by_employee_id,requestedByName:r.requester,reason:r.reason,createdAt:r.created_at,status:r.decision??(i>0?'superseded':r.basis_sha256!==basisVersion?'stale':'requested'),snapshot:r.preview_snapshot,decidedByName:r.decider,decisionReason:r.decision_reason,result:r.result}))
  return {view:{orderId,orderPublicId:order.public_id,currency:order.currency,basisVersion,availableDimensions,...snapshot,requests},recoveryPaymentId:attribution.recoveryPaymentId??loyalty.recoveryPaymentId}
}
