import { createHash,randomUUID } from 'node:crypto'
import {appendAuditEvent,appendOutboxMessage,type JsonObject } from './command-executor.js'
import type { ScopedTransaction,ScopedPostgresTransactionRunner } from './transaction-runner.js'
import type { NormalizedOperationsRequestContext } from './normalized-operations-api.js'
import { CommercialOpsRepository,maskVoucher,voucherCodeDigest } from './commercial-ops-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { readGroupVoucherPrepareHandle,GroupVoucherPlatformError,type GroupVoucherPlatformRegistry,type ConsumedGroupVoucher } from './group-voucher-platforms.js'
import { groupVoucherPlatformLabel,type GroupVoucherPlatformCode } from '../../src/shared/group-voucher-contracts.js'

type Context=NormalizedOperationsRequestContext
interface Operation extends Record<string,unknown> {
 id:string;idempotency_key:string;request_sha256:string;platform:GroupVoucherPlatformCode;voucher_hash:string;voucher_masked:string;
 actor_employee_id:string;business_date:string;public_id:string;order_id:string|null;table_session_id:string|null;
 prepared_snapshot:Prepared;status:'dispatching'|'unknown'|'provider_succeeded'|'recorded'|'not_consumed';provider_result:ConsumedGroupVoucher|null;result_snapshot:JsonObject|null;review_snapshot:Review|null;created_at:string;updated_at:string
}
interface Prepared {campaignName:string;faceValueMinor:number;settlementAmountMinor:number;currency:string;certificateId:string}
export interface VoucherOperationInput {platform:GroupVoucherPlatformCode;voucherCode:string;prepareHandle:string;publicId:string;orderId:string|null;tableSessionId:string|null}
export interface VoucherReviewInput {outcome:'consumed'|'not_consumed';certificateId:string;verifyId:string;evidenceReference:string;reason:string}
interface Review extends VoucherReviewInput {id:string;employeeId:string;approvedBy?:string}
export class VoucherOperationError extends Error {notCommitted=false; constructor(message:string,readonly statusCode=409){super(message)} }
export interface VoucherOperationView {
 id:string;platform:string;voucherCodeMasked:string;campaignName:string;faceValueMinor:number;settlementAmountMinor:number;currency:string;
 status:string;businessDate:string;publicId:string;actorEmployeeId:string;orderId:string|null;tableSessionId:string|null;createdAt:string;
 review:Review|null;result:JsonObject|null
}
export class VoucherOperationService {
 constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>,private readonly verification:{registry:GroupVoucherPlatformRegistry;signingSecret:string;now?():number}){}
 async list(c:Context):Promise<VoucherOperationView[]> {
  return this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.view')
   return (await tx.query<Operation>(`SELECT *,business_date::text,created_at::text,updated_at::text FROM mbox.voucher_operations op WHERE tenant_id=$1 AND store_id=$2 ORDER BY (status NOT IN ('recorded','not_consumed')) DESC,op.created_at DESC,id DESC LIMIT 100`,[c.scope.tenantId,c.scope.storeId])).rows.map(view)
  },{readOnly:true})
 }
 async find(c:Context,publicId:string):Promise<VoucherOperationView|null>{return this.transactions.run(c.scope,async tx=>{
  await this.access(tx,c,'commercial.voucher.view')
  const row=(await tx.query<Operation>(`SELECT *,business_date::text,created_at::text FROM mbox.voucher_operations WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3`,[c.scope.tenantId,c.scope.storeId,publicId])).rows[0]
  return row?view(row):null
 },{readOnly:true})}
 async redeem(c:Context,key:string,input:VoucherOperationInput):Promise<VoucherOperationView> {
  const digest=hash(JSON.stringify({actor:c.employeeId,...input,voucherCode:voucherCodeDigest(input.voucherCode),prepareHandle:hash(input.prepareHandle)}))
  let token:string|null=null
  const op=await this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.redeem')
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${c.scope.tenantId}:${c.scope.storeId}:voucher-operation:${key}`])
   const existing=(await tx.query<Operation>(`SELECT *,business_date::text,created_at::text FROM mbox.voucher_operations WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,[c.scope.tenantId,c.scope.storeId,key])).rows[0]
   if(existing){if(existing.request_sha256.trim()!==digest)throw new VoucherOperationError('原核销请求内容已改变，不能复用原键');return existing}
   try {
   const duplicate=(await tx.query(`SELECT id FROM mbox.voucher_operations WHERE tenant_id=$1 AND store_id=$2 AND platform=$3 AND voucher_hash=$4 AND status<>'not_consumed' LIMIT 1`,[c.scope.tenantId,c.scope.storeId,input.platform,voucherCodeDigest(input.voucherCode)])).rows[0]
   if(duplicate)throw new VoucherOperationError('此券已有原核销事项，请在核销记录中恢复，不能重新消耗')
   const prepared=readGroupVoucherPrepareHandle(input.prepareHandle,this.verification.signingSecret,this.verification.now?.()??Date.now())
   if(prepared.codeHash!==voucherCodeDigest(input.voucherCode)||prepared.platform!==input.platform)throw new VoucherOperationError('券码、平台与原查询结果不一致',400)
   if(!this.verification.registry.status().some(p=>p.code===input.platform&&p.enabled))throw new VoucherOperationError('平台当前不可用',503)
   if(Boolean(input.orderId)!==Boolean(input.tableSessionId))throw new VoucherOperationError('订单和桌次必须一起关联',400)
   if(input.orderId){const bound=await tx.query(`SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND table_session_id=$4 AND status NOT IN ('cancelled','draft') FOR SHARE`,[c.scope.tenantId,c.scope.storeId,input.orderId,input.tableSessionId]);if(!bound.rowCount)throw new VoucherOperationError('原订单已取消或不属于所选桌次')}
   const old=await tx.query(`SELECT id FROM mbox.group_voucher_redemptions WHERE tenant_id=$1 AND store_id=$2 AND voucher_code_hash=$3 LIMIT 1`,[c.scope.tenantId,c.scope.storeId,voucherCodeDigest(input.voucherCode)])
   if(old.rowCount)throw new VoucherOperationError('此券已有本地核销事实，请查询原记录')
   const snapshot:Prepared={campaignName:prepared.campaignName,faceValueMinor:prepared.faceValueMinor,settlementAmountMinor:prepared.settlementAmountMinor,currency:prepared.currency,certificateId:prepared.certificateId}
   const inserted=(await tx.query<Operation>(`INSERT INTO mbox.voucher_operations(tenant_id,store_id,idempotency_key,request_sha256,platform,voucher_hash,voucher_masked,actor_employee_id,business_date,public_id,order_id,table_session_id,prepared_snapshot,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'dispatching') RETURNING *,business_date::text,created_at::text`,[c.scope.tenantId,c.scope.storeId,key,digest,input.platform,voucherCodeDigest(input.voucherCode),maskVoucher(input.voucherCode),c.employeeId,c.businessDate,input.publicId,input.orderId,input.tableSessionId,JSON.stringify(snapshot)])).rows[0]!
   await this.event(tx,c,inserted.id,'dispatch_reserved',{platform:input.platform,voucherMasked:maskVoucher(input.voucherCode)})
   token=prepared.prepareToken
   return inserted
   }catch(error){
    if(error instanceof GroupVoucherPlatformError && !error.retryable){const rejected=new VoucherOperationError(error.message,400);rejected.notCommitted=true;throw rejected}
    if(error instanceof VoucherOperationError)error.notCommitted=true
    throw error
   }
  })
  // Only the transaction that durably reserved dispatch may contact the platform.
  // A process death, timeout or duplicate HTTP request never triggers consume again.
  if(token!==null){
   try {
    const consumed=await this.verification.registry.adapter(input.platform).consume({voucherCode:input.voucherCode,prepareToken:token,requestId:key})
    const result={...consumed,faceValueMinor:consumed.faceValueProvided===false?op.prepared_snapshot.faceValueMinor:consumed.faceValueMinor,settlementAmountMinor:consumed.settlementAmountProvided===false?op.prepared_snapshot.settlementAmountMinor:consumed.settlementAmountMinor}
    if(result.platform!==input.platform||result.currency!==op.prepared_snapshot.currency||!result.verifyId||!result.certificateId||!Number.isSafeInteger(result.faceValueMinor)||!Number.isSafeInteger(result.settlementAmountMinor)||result.faceValueMinor<0||result.settlementAmountMinor<0)throw new VoucherOperationError('平台核销回执不完整，需核对原请求')
    await this.transactions.run(c.scope,async tx=>{
     await tx.query(`UPDATE mbox.voucher_operations SET provider_result=$4::jsonb,status='provider_succeeded',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='dispatching'`,[c.scope.tenantId,c.scope.storeId,op.id,JSON.stringify(result)])
     await this.event(tx,c,op.id,'provider_succeeded',{verifyId:result.verifyId,certificateId:result.certificateId})
    })
   }catch{
    await this.transactions.run(c.scope,async tx=>{await tx.query(`UPDATE mbox.voucher_operations SET status='unknown',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='dispatching'`,[c.scope.tenantId,c.scope.storeId,op.id]);await this.event(tx,c,op.id,'provider_result_unknown',{})})
   }
  }
  return this.recover(c,op.id)
 }
 async recover(c:Context,id:string):Promise<VoucherOperationView>{
  return this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.redeem')
   const op=await this.lock(tx,c,id)
   if(op.status!=='provider_succeeded')return view(op)
   const result=op.provider_result!
   // Original verified facts are retained even when the associated order later closes.
   // Voucher recording never creates payment or reduces an order's receivable.
   const voucher=await new CommercialOpsRepository(tx).redeemVoucher({publicId:op.public_id,platform:groupVoucherPlatformLabel(op.platform),platformCode:op.platform,campaignName:result.campaignName||op.prepared_snapshot.campaignName,voucherCode:op.voucher_masked,faceValueMinor:result.faceValueMinor,settlementAmountMinor:result.settlementAmountMinor,currency:result.currency,orderId:op.order_id,tableSessionId:op.table_session_id,providerCertificateId:result.certificateId,providerVerifyId:result.verifyId,providerStatus:op.review_snapshot?.approvedBy?'consumed_manual_review':'consumed',redeemedByEmployeeId:op.actor_employee_id,redeemedBusinessDate:op.business_date},true,{codeHash:op.voucher_hash,masked:op.voucher_masked})
   const resultView:JsonObject={id:voucher.id,publicId:voucher.publicId,platform:voucher.platform,platformCode:voucher.platformCode,campaignName:voucher.campaignName,voucherCodeMasked:voucher.voucherCodeMasked,faceValueMinor:voucher.faceValueMinor,settlementAmountMinor:voucher.settlementAmountMinor,currency:voucher.currency,isSettled:voucher.reconciliationEntryId!==null,providerCertificateId:voucher.providerCertificateId,providerVerifyId:voucher.providerVerifyId,redeemedBusinessDate:voucher.redeemedBusinessDate,redeemedAt:voucher.redeemedAt}
   await tx.query(`UPDATE mbox.voucher_operations SET status='recorded',result_snapshot=$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[c.scope.tenantId,c.scope.storeId,id,JSON.stringify(resultView)])
   await appendAuditEvent(tx,{actor:{type:'employee',employeeId:c.employeeId},action:'commercial.voucher.redeemed',objectType:'group_voucher',objectId:voucher.id,businessDate:op.business_date,afterData:{...resultView,voucherCodeHashPrefix:op.voucher_hash.slice(0,12),originalActorEmployeeId:op.actor_employee_id}})
   await appendOutboxMessage(tx,{aggregateType:'group_voucher',aggregateId:voucher.id,aggregateVersion:1,eventType:'commercial.voucher.redeemed.v1',payload:resultView})
   await this.event(tx,c,id,'recorded',{redemptionId:voucher.id,manualReview:!!op.review_snapshot?.approvedBy})
   return view({...op,status:'recorded',result_snapshot:resultView})
  })
 }
 async review(c:Context,id:string,input:VoucherReviewInput,key?:string):Promise<VoucherOperationView>{
  return this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.redeem');const op=await this.lock(tx,c,id)
   if(key){const prior=(await tx.query<{evidence:JsonObject}>(`SELECT evidence FROM mbox.voucher_operation_events WHERE tenant_id=$1 AND store_id=$2 AND operation_id=$3 AND event_type='review_proposed' AND evidence->>'key'=$4 LIMIT 1`,[c.scope.tenantId,c.scope.storeId,id,key])).rows[0];if(prior){if(prior.evidence.employeeId!==c.employeeId||(['outcome','certificateId','verifyId','evidenceReference','reason'] as const).some(k=>prior.evidence[k]!==input[k]))throw new VoucherOperationError('不能更改原证据提交请求');return view(op)}}
   try {
   if(!['dispatching','unknown'].includes(op.status))throw new VoucherOperationError('原核销已有明确结果，请刷新')
   if((this.verification.now?.()??Date.now())-Date.parse(op.created_at)<120000)throw new VoucherOperationError('原核销仍可能在途，至少两分钟后核对平台原凭证')
   if(op.review_snapshot){if(op.review_snapshot.employeeId===c.employeeId && (['outcome','certificateId','verifyId','evidenceReference','reason'] as const).every(k=>op.review_snapshot![k]===input[k]))return view(op);throw new VoucherOperationError('已有复核证据，请由另一名财务人员确认；不能覆盖原证据')}
   if(input.reason.trim().length<4||input.reason.length>500||input.evidenceReference.trim().length<4||input.evidenceReference.length>500||input.certificateId.length>256||input.verifyId.length>256||input.outcome==='consumed'&&(!input.certificateId.trim()||!input.verifyId.trim()))throw new VoucherOperationError('请提供平台原核销凭证编号、查询依据及实际原因',400)
   const review:Review={...input,id:randomUUID(),employeeId:c.employeeId}
   await tx.query(`UPDATE mbox.voucher_operations SET review_snapshot=$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[c.scope.tenantId,c.scope.storeId,id,JSON.stringify(review)])
   await this.event(tx,c,id,'review_proposed',{...review,...(key?{key}:{})} as unknown as JsonObject)
   return view({...op,review_snapshot:review})
   }catch(error){if(key && error instanceof VoucherOperationError)error.notCommitted=true;throw error}
  })
 }
 async approve(c:Context,id:string,expectedReviewId?:string):Promise<VoucherOperationView>{
  await this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.redeem');await this.access(tx,c,'reconciliation.manage');const op=await this.lock(tx,c,id)
   if(expectedReviewId && op.review_snapshot?.id!==expectedReviewId)throw new VoucherOperationError('原复核证据已变化，请重新核对');
   if(['provider_succeeded','recorded','not_consumed'].includes(op.status)){if(op.review_snapshot?.approvedBy===c.employeeId)return;throw new VoucherOperationError('原复核已由其他流程处理，请刷新')}
   const review=op.review_snapshot
   if(!review||review.employeeId===c.employeeId)throw new VoucherOperationError('须由另一名有财务复核权限的员工独立核对平台原凭证')
   const approved={...review,approvedBy:c.employeeId}
   const result:ConsumedGroupVoucher={platform:op.platform,...op.prepared_snapshot,certificateId:review.certificateId,verifyId:review.verifyId}
   await tx.query(`UPDATE mbox.voucher_operations SET review_snapshot=$4::jsonb,status=$5,provider_result=$6::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[c.scope.tenantId,c.scope.storeId,id,JSON.stringify(approved),review.outcome==='consumed'?'provider_succeeded':'not_consumed',review.outcome==='consumed'?JSON.stringify(result):null])
   await this.event(tx,c,id,'review_approved',approved as unknown as JsonObject)
  })
  return this.recover(c,id)
 }
 async reject(c:Context,id:string,key:string,reviewId:string,reason:string):Promise<VoucherOperationView>{
  return this.transactions.run(c.scope,async tx=>{
   await this.access(tx,c,'commercial.voucher.redeem');await this.access(tx,c,'reconciliation.manage');const op=await this.lock(tx,c,id)
   const old=(await tx.query<{evidence:JsonObject}>(`SELECT evidence FROM mbox.voucher_operation_events WHERE tenant_id=$1 AND store_id=$2 AND operation_id=$3 AND event_type='review_rejected' AND evidence->>'key'=$4 LIMIT 1`,[c.scope.tenantId,c.scope.storeId,id,key])).rows[0]
   if(old){if(old.evidence.reviewId!==reviewId||old.evidence.reason!==reason||old.evidence.employeeId!==c.employeeId)throw new VoucherOperationError('不能更改原驳回请求');return view(op)}
   const review=op.review_snapshot
   if(!['dispatching','unknown'].includes(op.status)||!review||review.id!==reviewId||review.employeeId===c.employeeId||review.approvedBy||reason.trim().length<4||reason.length>500)throw new VoucherOperationError('须由另一名财务人员核对原待审证据并填写驳回原因')
   await this.event(tx,c,id,'review_rejected',{key,reviewId,reason,employeeId:c.employeeId,review:review as unknown as JsonObject})
   await tx.query(`UPDATE mbox.voucher_operations SET review_snapshot=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[c.scope.tenantId,c.scope.storeId,id])
   return view({...op,review_snapshot:null})
  })
 }
 private async lock(tx:ScopedTransaction,c:Context,id:string){const op=(await tx.query<Operation>(`SELECT *,business_date::text,created_at::text FROM mbox.voucher_operations WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[c.scope.tenantId,c.scope.storeId,id])).rows[0];if(!op)throw new VoucherOperationError('原核销事项不存在',404);return op}
 private access(tx:ScopedTransaction,c:Context,p:string){return new StaffAccessRepository(tx).assertPermission(c.employeeId,p)}
 private async event(tx:ScopedTransaction,c:Context,id:string,type:string,evidence:JsonObject){await tx.query(`INSERT INTO mbox.voucher_operation_events(tenant_id,store_id,operation_id,employee_id,event_type,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[c.scope.tenantId,c.scope.storeId,id,c.employeeId,type,JSON.stringify(evidence)])}

}
function hash(v:string){return createHash('sha256').update(v).digest('hex')}
function view(op:Operation):VoucherOperationView{return {id:op.id,platform:op.platform,voucherCodeMasked:op.voucher_masked,campaignName:op.prepared_snapshot.campaignName,faceValueMinor:op.prepared_snapshot.faceValueMinor,settlementAmountMinor:op.prepared_snapshot.settlementAmountMinor,currency:op.prepared_snapshot.currency,status:op.status,businessDate:op.business_date,publicId:op.public_id,actorEmployeeId:op.actor_employee_id,orderId:op.order_id,tableSessionId:op.table_session_id,createdAt:op.created_at,review:op.review_snapshot,result:op.result_snapshot}}
