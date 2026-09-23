import {createHash,randomUUID} from 'node:crypto'
import type {LoyaltyRefundReviewAllocation,LoyaltyRefundReviewCommandResult,LoyaltyRefundReviewDecisionInput,LoyaltyRefundReviewRequestInput,LoyaltyRefundReviewRequestView,LoyaltyRefundReviewView} from '../../src/shared/loyalty-refund-review.js'
import {appendAuditEvent,IdempotencyConflictError} from './command-executor.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'

export class LoyaltyRefundReviewError extends Error {
  readonly statusCode=409
  commitDisposition: 'not_committed' | undefined
  constructor(readonly code:string,message:string){super(message);this.name='LoyaltyRefundReviewError'}
}
function fail(code:string,message:string):never{throw new LoyaltyRefundReviewError(`LOYALTY_REVIEW_${code}`,message)}
function minor(value:unknown):number{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new Error('Invalid authoritative refund amount');return number}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
interface ReviewRow extends Record<string,unknown>{order_id:string;payment_id:string;refund_id:string;refund_public_id:string;order_public_id:string;currency:string;completed_at:string;resolved:boolean}
interface ItemRow extends Record<string,unknown>{id:string;name:string;quantity:string;amount:string;eligible:boolean}
interface RefundRow extends Record<string,unknown>{id:string;public_id:string;payment_id:string;amount:string;completed_at:string;application_amount:string|null;allocations:Array<{id:string;amount:string}>}
interface RequestRow extends Record<string,unknown>{id:string;refund_id:string;order_id:string;basis_sha256:string;requested_by_employee_id:string;requester:string;reason:string;created_at:string;decision:'approved'|'rejected'|null;decision_reason:string|null;decider:string|null;allocations:Array<{refundId:string;orderItemId:string;salesRefundAmountMinor:number}>}
interface ReviewBasis {review:ReviewRow;view:LoyaltyRefundReviewView;items:ItemRow[];used:Map<string,number>;history:Map<string,{sales:number;eligible:number}>;awardRemaining:number;requests:RequestRow[]}

export class LoyaltyRefundReviewService {
  constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>){}

  list(context:StaffCustomerExperienceContext):Promise<LoyaltyRefundReviewView[]>{
    return this.transactions.run(context.scope,async tx=>{
      await permission(tx,context.employeeId,'view')
      const rows=await tx.query<{refund_id:string}>(`SELECT r.refund_id FROM mbox.loyalty_refund_reviews r
        WHERE r.tenant_id=$1 AND r.store_id=$2 ORDER BY
        EXISTS(SELECT 1 FROM mbox.loyalty_refund_review_decisions d WHERE (d.tenant_id,d.store_id,d.refund_id)=(r.tenant_id,r.store_id,r.refund_id) AND d.decision='approved'),r.created_at,r.refund_id LIMIT 100`,scope(tx))
      const result:LoyaltyRefundReviewView[]=[]
      for(const row of rows.rows)result.push((await loadBasis(tx,row.refund_id)).view)
      return result
    },{readOnly:true})
  }

  request(context:StaffCustomerExperienceContext,refundId:string,input:LoyaltyRefundReviewRequestInput,key:string){
    return this.execute(context,'request',key,{refundId,...input},async tx=>{
      await lockOrder(tx,refundId)
      const basis=await loadBasis(tx,refundId)
      if(basis.view.status==='resolved')fail('ALREADY_RESOLVED','该退款已完成商品归属复核，请读取原结果')
      checkVersion(input.basisVersion,basis.view.basisVersion)
      if(basis.view.blockingRefundPublicId)fail('ORDER_BLOCKED','请先完成同订单较早退款的商品归属复核')
      const allocations=validateAllocations(basis,input)
      const eligible=allocations.filter(a=>a.refundId===refundId&&a.eligible).reduce((sum,a)=>sum+a.amount,0)
      const id=randomUUID()
      await tx.query(`INSERT INTO mbox.loyalty_refund_review_requests
        (id,tenant_id,store_id,order_id,refund_id,payment_id,basis_sha256,refund_amount_minor,excess_amount_minor,sales_amount_minor,eligible_amount_minor,requested_by_employee_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,...scope(tx),basis.review.order_id,refundId,basis.review.payment_id,input.basisVersion,basis.view.refundAmountMinor,basis.view.excessAmountMinor,basis.view.salesRefundAmountMinor,eligible,context.employeeId,input.reason.trim()])
      for(const line of allocations)await tx.query(`INSERT INTO mbox.loyalty_refund_review_request_items
        (tenant_id,store_id,request_id,refund_id,order_item_id,amount_minor,loyalty_eligible) VALUES($1,$2,$3,$4,$5,$6,$7)`,[...scope(tx),id,line.refundId,line.itemId,line.amount,line.eligible])
      return {requestId:id,refundId,status:'requested',pointsDelta:0,growthDelta:0}
    })
  }

  decide(context:StaffCustomerExperienceContext,requestId:string,input:LoyaltyRefundReviewDecisionInput,key:string){
    return this.execute(context,'decision',key,{requestId,...input},async tx=>{
      if(!validId(requestId))fail('INVALID','复核申请编号无效')
      const selected=await tx.query<{refund_id:string}>(`SELECT refund_id FROM mbox.loyalty_refund_review_requests WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...scope(tx),requestId])
      const refundId=selected.rows[0]?.refund_id
      if(!refundId)fail('NOT_FOUND','复核申请不存在或不属于当前门店')
      await lockOrder(tx,refundId)
      const basis=await loadBasis(tx,refundId),request=basis.requests.find(r=>r.id===requestId)
      if(!request)fail('NOT_FOUND','复核申请不存在')
      if(request.decision)fail('ALREADY_DECIDED','该申请已被复核，请读取原结果')
      if(request.requested_by_employee_id===context.employeeId)fail('SELF_APPROVAL','申请人不能复核自己的商品归属申请')
      checkVersion(input.basisVersion,request.basis_sha256)
      if(input.decision!=='approve'&&input.decision!=='reject')fail('INVALID','请选择通过或驳回')
      if(input.decision==='approve'){
        if(basis.view.status==='resolved')fail('ALREADY_RESOLVED','该退款已完成商品归属复核')
        if(basis.requests[0]?.id!==requestId)fail('SUPERSEDED','已有更新的商品归属申请，请读取最新申请')
        checkVersion(request.basis_sha256,basis.view.basisVersion)
        if(basis.view.blockingRefundPublicId)fail('ORDER_BLOCKED','请先完成同订单较早退款的商品归属复核')
        validateAllocations(basis,requestInput(request))
      }
      const status=input.decision==='approve'?'approved':'rejected'
      await tx.query(`INSERT INTO mbox.loyalty_refund_review_decisions(tenant_id,store_id,request_id,refund_id,decision,decided_by_employee_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[...scope(tx),requestId,refundId,status,context.employeeId,input.reason.trim()])
      let pointsDelta=0,growthDelta=0
      if(status==='approved'){
        const applied=await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:basis.review.order_id,paymentId:basis.review.payment_id,refundId,occurredAt:new Date().toISOString()})
        if(!applied.applied)throw new Error('Approved review must create exactly one original refund reward application')
        pointsDelta=applied.pointsDelta;growthDelta=applied.growthDelta
      }
      return {requestId,refundId,status,pointsDelta,growthDelta}
    })
  }

  private execute(context:StaffCustomerExperienceContext,operation:'request'|'decision',key:string,input:{reason:string}&Record<string,unknown>,handler:(tx:ScopedTransaction)=>Promise<LoyaltyRefundReviewCommandResult>){
    if(typeof key!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))fail('INVALID','请求编号无效')
    const fingerprint=digest({employeeId:context.employeeId,...input})
    return this.transactions.run(context.scope,async tx=>{
      await permission(tx,context.employeeId,operation)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`loyalty-refund-review:${scope(tx).join(':')}:${operation}:${key}`])
      const receipt=(await tx.query<{request_sha256:string;result:LoyaltyRefundReviewCommandResult}>(`SELECT request_sha256,result FROM mbox.loyalty_refund_review_command_receipts WHERE tenant_id=$1 AND store_id=$2 AND operation_scope=$3 AND idempotency_key=$4`,[...scope(tx),operation,key])).rows[0]
      if(receipt){if(receipt.request_sha256!==fingerprint)throw new IdempotencyConflictError(`loyalty.refund-review.${operation}`,key);return {value:receipt.result,replayed:true}}
      let value:LoyaltyRefundReviewCommandResult
      try{
        if(typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.trim().length>1000)fail('INVALID','请填写3至1000字的商品与退款核对依据')
        value=await handler(tx)
      }catch(error){
        if(error instanceof LoyaltyRefundReviewError)error.commitDisposition='not_committed'
        throw error
      }
      await appendAuditEvent(tx,{actor:{type:'employee',employeeId:context.employeeId},action:`loyalty.refund_review.${value.status}`,objectType:'loyalty_refund_review_request',objectId:value.requestId,businessDate:context.businessDate,reason:input.reason.trim(),afterData:{...value}})
      await tx.query(`INSERT INTO mbox.loyalty_refund_review_command_receipts(tenant_id,store_id,operation_scope,idempotency_key,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[...scope(tx),operation,key,fingerprint,JSON.stringify(value)])
      return {value,replayed:false}
    })
  }
}

const scope=(tx:ScopedTransaction)=>[tx.scope.tenantId,tx.scope.storeId]
async function permission(tx:ScopedTransaction,employeeId:string,operation:'view'|'request'|'decision'){
  const access=new StaffAccessRepository(tx)
  await access.assertPermission(employeeId,operation==='view'?'reconciliation.view':'reconciliation.manage')
  await access.assertPermission(employeeId,operation==='view'?'loyalty.accrual.exception.view':operation==='request'?'loyalty.accrual.request':'loyalty.accrual.approve')
}
async function lockOrder(tx:ScopedTransaction,refundId:string){
  if(!validId(refundId))fail('INVALID','退款编号无效')
  const locked=await tx.query(`SELECT ordering.id FROM mbox.orders ordering JOIN mbox.loyalty_refund_reviews review
    ON (review.tenant_id,review.store_id,review.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)
    WHERE review.tenant_id=$1 AND review.store_id=$2 AND review.refund_id=$3 FOR UPDATE OF ordering`,[...scope(tx),refundId])
  if(!locked.rowCount)fail('NOT_FOUND','退款待核不存在或不属于当前门店')
}
function checkVersion(actual:string,expected:string){if(typeof actual!=='string'||actual!==expected)fail('STALE','原退款、商品或奖账已变化，请刷新后重新核对')}

async function loadBasis(tx:ScopedTransaction,refundId:string):Promise<ReviewBasis>{
  const review=(await tx.query<ReviewRow>(`SELECT review.order_id,review.payment_id,review.refund_id,refund.public_id AS refund_public_id,
    ordering.public_id AS order_public_id,refund.currency,refund.completed_at::text,
    EXISTS(SELECT 1 FROM mbox.loyalty_refund_review_decisions d WHERE (d.tenant_id,d.store_id,d.refund_id)=(review.tenant_id,review.store_id,review.refund_id) AND d.decision='approved') AS resolved
    FROM mbox.loyalty_refund_reviews review JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)=(review.tenant_id,review.store_id,review.refund_id)
    JOIN mbox.orders ordering ON (ordering.tenant_id,ordering.store_id,ordering.id)=(review.tenant_id,review.store_id,review.order_id)
    WHERE review.tenant_id=$1 AND review.store_id=$2 AND review.refund_id=$3 AND refund.status='succeeded'`,[...scope(tx),refundId])).rows[0]
  if(!review)fail('NOT_FOUND','退款待核不存在或不属于当前门店')
  const items=(await tx.query<ItemRow>(`SELECT item.id,COALESCE(item.product_snapshot->>'name',product.name,'原商品') AS name,item.quantity::text,
    basis.amount_minor::text AS amount,item.loyalty_eligible_at_submission AS eligible
    FROM mbox.loyalty_order_item_basis basis JOIN mbox.order_items item ON (item.tenant_id,item.store_id,item.id)=(basis.tenant_id,basis.store_id,basis.order_item_id)
    LEFT JOIN mbox.products product ON (product.tenant_id,product.store_id,product.id)=(item.tenant_id,item.store_id,item.product_id)
    WHERE basis.tenant_id=$1 AND basis.store_id=$2 AND basis.order_id=$3 ORDER BY item.id`,[...scope(tx),review.order_id])).rows
  const refunds=(await tx.query<RefundRow>(`SELECT fact.id,original.public_id,fact.payment_id,fact.amount_minor::text AS amount,fact.completed_at::text,
    application.eligible_refund_amount_minor::text AS application_amount,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.order_item_id,'amount',i.amount_minor::text) ORDER BY i.order_item_id)
      FROM mbox.refund_items i WHERE (i.tenant_id,i.store_id,i.refund_id)=(fact.tenant_id,fact.store_id,fact.id)),'[]'::jsonb) AS allocations
    FROM mbox.order_refund_facts fact JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(fact.tenant_id,fact.store_id,fact.id)
    LEFT JOIN mbox.loyalty_award_refund_applications application
      ON (application.tenant_id,application.store_id,application.refund_id)=(fact.tenant_id,fact.store_id,fact.id)
    WHERE fact.tenant_id=$1 AND fact.store_id=$2 AND fact.order_id=$3 AND fact.status='succeeded' ORDER BY fact.completed_at,fact.id`,[...scope(tx),review.order_id])).rows
  const target=refunds.find(r=>r.id===refundId)
  if(!target)throw new Error('Review lost its succeeded refund')
  const award=(await tx.query<{eligible:string;reversed:string}>(`SELECT eligible_amount_minor::text AS eligible,reversed_amount_minor::text AS reversed FROM mbox.loyalty_order_awards WHERE tenant_id=$1 AND store_id=$2 AND order_id=$3`,[...scope(tx),review.order_id])).rows[0]
  if(!award)throw new Error('Refund review lost its original award')
  const known=(await tx.query<{refund_id:string;order_item_id:string;amount:string}>(`SELECT line.refund_id,line.order_item_id,line.amount_minor::text AS amount
    FROM mbox.loyalty_refund_review_request_items line JOIN mbox.loyalty_refund_review_decisions decision
      ON (decision.tenant_id,decision.store_id,decision.request_id)=(line.tenant_id,line.store_id,line.request_id) AND decision.decision='approved'
    JOIN mbox.loyalty_refund_review_requests request ON (request.tenant_id,request.store_id,request.id)=(decision.tenant_id,decision.store_id,decision.request_id)
    WHERE request.tenant_id=$1 AND request.store_id=$2 AND request.order_id=$3 ORDER BY line.refund_id,line.order_item_id`,[...scope(tx),review.order_id])).rows
  const appliedItems=new Map<string,Map<string,number>>()
  // An approved zero-sale refund has deliberately no item rows. Preserve that
  // empty allocation instead of inferring merchandise from its old raw items.
  const approvedRefunds=await tx.query<{refund_id:string}>(`SELECT request.refund_id
    FROM mbox.loyalty_refund_review_requests request JOIN mbox.loyalty_refund_review_decisions decision
      ON (decision.tenant_id,decision.store_id,decision.request_id)=(request.tenant_id,request.store_id,request.id) AND decision.decision='approved'
    WHERE request.tenant_id=$1 AND request.store_id=$2 AND request.order_id=$3`,[...scope(tx),review.order_id])
  for(const approved of approvedRefunds.rows)appliedItems.set(approved.refund_id,new Map())
  for(const line of known){const map=appliedItems.get(line.refund_id)??new Map<string,number>();if(map.has(line.order_item_id))throw new Error('Historical sale allocation was approved more than once');map.set(line.order_item_id,minor(line.amount));appliedItems.set(line.refund_id,map)}
  const used=new Map<string,number>(),history=new Map<string,{sales:number;eligible:number}>(),historicalRefunds:LoyaltyRefundReviewView['historicalRefunds']=[]
  const accrual=new LoyaltyAccrualRepository(tx),economic=await accrual.refundEconomicFacts({orderId:review.order_id,paymentId:review.payment_id,refundId})
  const itemView=(refund:RefundRow)=>refund.allocations.map(line=>{
    const item=items.find(i=>i.id===line.id);if(!item)throw new Error('Refund allocation lost its original sale item')
    return {orderItemId:item.id,productName:item.name,quantity:Number(item.quantity),refundAllocatedAmountMinor:minor(line.amount),maxSalesReturnAmountMinor:Math.min(minor(line.amount),Math.max(0,minor(item.amount)-(used.get(item.id)??0))),loyaltyEligible:item.eligible}
  })
  for(const refund of refunds){
    if(refund.id===refundId)continue
    if(refund.application_amount===null)continue // Earlier unresolved reviews block approval; later pending reviews follow it.
    let allocation=appliedItems.get(refund.id)
    if(!allocation){
      const facts=await accrual.refundEconomicFacts({orderId:review.order_id,paymentId:refund.payment_id,refundId:refund.id}),sales=facts.total-facts.excess
      if(sales===0)allocation=new Map()
      else if(facts.excess===0)allocation=new Map(refund.allocations.map(i=>[i.id,minor(i.amount)]))
      else if(refund.allocations.length===1)allocation=new Map([[refund.allocations[0]!.id,sales]])
      else{history.set(refund.id,{sales,eligible:minor(refund.application_amount)});historicalRefunds.push({refundId:refund.id,refundPublicId:refund.public_id,refundAmountMinor:facts.total,excessAmountMinor:facts.excess,salesRefundAmountMinor:sales,items:itemView(refund)});continue}
    }
    for(const [id,amount]of allocation)used.set(id,(used.get(id)??0)+amount)
  }
  for(const entry of historicalRefunds)entry.items=itemView(refunds.find(refund=>refund.id===entry.refundId)!)
  const blocking=(await tx.query<{public_id:string}>(`SELECT refund.public_id FROM mbox.loyalty_unresolved_refund_reviews pending
    JOIN mbox.refunds refund ON (refund.tenant_id,refund.store_id,refund.id)=(pending.tenant_id,pending.store_id,pending.refund_id)
    WHERE pending.tenant_id=$1 AND pending.store_id=$2 AND pending.order_id=$3 AND (refund.completed_at,refund.id)<($4::timestamptz,$5::uuid)
    ORDER BY refund.completed_at,refund.id LIMIT 1`,[...scope(tx),review.order_id,review.completed_at,refundId])).rows[0]?.public_id??null
  const basisVersion=digest({review:{order:review.order_id,refundId,payment:review.payment_id,currency:review.currency},items,refunds,known,award,economic})
  const requests=(await tx.query<RequestRow>(`SELECT request.id,request.refund_id,request.order_id,request.basis_sha256,request.requested_by_employee_id,
    employee.display_name AS requester,request.reason,request.created_at::text,decision.decision,decision.reason AS decision_reason,reviewer.display_name AS decider,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('refundId',line.refund_id,'orderItemId',line.order_item_id,'salesRefundAmountMinor',line.amount_minor) ORDER BY line.refund_id,line.order_item_id)
     FROM mbox.loyalty_refund_review_request_items line WHERE (line.tenant_id,line.store_id,line.request_id)=(request.tenant_id,request.store_id,request.id)),'[]'::jsonb) AS allocations
    FROM mbox.loyalty_refund_review_requests request JOIN mbox.employees employee ON (employee.tenant_id,employee.store_id,employee.id)=(request.tenant_id,request.store_id,request.requested_by_employee_id)
    LEFT JOIN mbox.loyalty_refund_review_decisions decision ON (decision.tenant_id,decision.store_id,decision.request_id)=(request.tenant_id,request.store_id,request.id)
    LEFT JOIN mbox.employees reviewer ON (reviewer.tenant_id,reviewer.store_id,reviewer.id)=(decision.tenant_id,decision.store_id,decision.decided_by_employee_id)
    WHERE request.tenant_id=$1 AND request.store_id=$2 AND request.refund_id=$3 ORDER BY request.created_at DESC,request.id DESC`,[...scope(tx),refundId])).rows
  const view:LoyaltyRefundReviewView={refundId,refundPublicId:review.refund_public_id,orderPublicId:review.order_public_id,currency:review.currency,
    refundAmountMinor:economic.total,excessAmountMinor:economic.excess,salesRefundAmountMinor:economic.total-economic.excess,basisVersion,
    status:review.resolved?'resolved':'pending',blockingRefundPublicId:blocking,items:itemView(target),historicalRefunds,
    requests:requests.map((r,index):LoyaltyRefundReviewRequestView=>({requestId:r.id,requestedByEmployeeId:r.requested_by_employee_id,requestedByName:r.requester,reason:r.reason,createdAt:r.created_at,basisVersion:r.basis_sha256,
      status:r.decision??(index>0?'superseded':r.basis_sha256!==basisVersion?'stale':'requested'),allocations:requestInput(r).allocations,historicalAllocations:requestInput(r).historicalAllocations??[],decisionReason:r.decision_reason,decidedByName:r.decider}))}
  return {review,view,items,used,history,awardRemaining:minor(award.eligible)-minor(award.reversed),requests}
}

function requestInput(request:RequestRow):LoyaltyRefundReviewRequestInput{
  const historical=new Map<string,LoyaltyRefundReviewAllocation[]>()
  for(const line of request.allocations)if(line.refundId!==request.refund_id)historical.set(line.refundId,[...(historical.get(line.refundId)??[]),{orderItemId:line.orderItemId,salesRefundAmountMinor:line.salesRefundAmountMinor}])
  return {basisVersion:request.basis_sha256,reason:request.reason,allocations:request.allocations.filter(a=>a.refundId===request.refund_id).map(({orderItemId,salesRefundAmountMinor})=>({orderItemId,salesRefundAmountMinor})),historicalAllocations:[...historical].map(([refundId,allocations])=>({refundId,allocations}))}
}
function validateAllocations(basis:ReviewBasis,input:LoyaltyRefundReviewRequestInput){
  if(input.historicalAllocations!==undefined&&!Array.isArray(input.historicalAllocations))fail('INVALID','历史退款补证格式无效')
  const groups=[{refundId:basis.view.refundId,allocations:input.allocations},...(input.historicalAllocations??[])],seenRefunds=new Set<string>()
  const output:Array<{refundId:string;itemId:string;amount:number;eligible:boolean}>=[],used=new Map(basis.used)
  if(groups.length!==basis.history.size+1)fail('INVALID','请逐笔明确当前及全部待补证历史退款的商品分摊')
  for(const group of groups){
    if(!group||typeof group.refundId!=='string')fail('INVALID','历史退款编号无效')
    if(seenRefunds.has(group.refundId))fail('INVALID','同一退款不能重复提交');seenRefunds.add(group.refundId)
    const target=group.refundId===basis.view.refundId?basis.view:basis.view.historicalRefunds.find(r=>r.refundId===group.refundId)
    if(!target||!Array.isArray(group.allocations)||group.allocations.length>200)fail('INVALID','退款明细不属于本次核对范围')
    const seenItems=new Set<string>();let total=0,eligible=0
    for(const line of group.allocations){
      if(!line||typeof line.orderItemId!=='string'||seenItems.has(line.orderItemId)||!Number.isSafeInteger(line.salesRefundAmountMinor)||line.salesRefundAmountMinor<=0)fail('INVALID','请选择不重复的原商品并填写正整数分的销售退款金额')
      seenItems.add(line.orderItemId)
      const item=target.items.find(i=>i.orderItemId===line.orderItemId),original=basis.items.find(i=>i.id===line.orderItemId)
      if(!item||!original||line.salesRefundAmountMinor>item.refundAllocatedAmountMinor)fail('INVALID','商品金额不能超过原退款明细分摊')
      const cumulative=(used.get(line.orderItemId)??0)+line.salesRefundAmountMinor
      if(cumulative>minor(original.amount))fail('INVALID','累计销售退款不能超过原商品有效销售金额')
      used.set(line.orderItemId,cumulative);total+=line.salesRefundAmountMinor;if(item.loyaltyEligible)eligible+=line.salesRefundAmountMinor
      output.push({refundId:group.refundId,itemId:line.orderItemId,amount:line.salesRefundAmountMinor,eligible:item.loyaltyEligible})
    }
    if(total!==target.salesRefundAmountMinor)fail('INVALID','商品销售退款合计必须等于退款总额扣除真实超收部分')
    if(group.refundId===basis.view.refundId){if(eligible>basis.awardRemaining)fail('INVALID','计分商品退款不能超过原奖账尚未冲回的金额')}
    else if(eligible!==basis.history.get(group.refundId)?.eligible)fail('INVALID','历史商品补证必须与原已冲回奖账守恒，不能再次改奖或制造差额')
  }
  return output
}
