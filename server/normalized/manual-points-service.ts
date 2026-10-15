import {createHash,randomUUID} from 'node:crypto'
import type {ManualPointsRequest,ManualPointsDecision,ManualPointsResult,ManualPointsBoard} from '../../src/shared/manual-points.js'
import {appendAuditEvent,IdempotencyConflictError} from './command-executor.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {LoyaltyOperationalControlRepository,LoyaltyPositiveAccrualPausedError} from './loyalty-operational-control-repository.js'
import {lockStaffAccessConfiguration} from './staff-access-version.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import type {StaffCustomerExperienceContext} from './customer-experience-service.js'
import type {ScopedPostgresTransactionRunner,ScopedTransaction} from './transaction-runner.js'
export class ManualPointsError extends Error {readonly statusCode=409;commitDisposition:'not_committed'|undefined;constructor(readonly code:string,message:string){super(message)}}
function fail(code:string,message:string):never{throw new ManualPointsError(`MANUAL_POINTS_${code}`,message)}
const scope=(tx:ScopedTransaction)=>[tx.scope.tenantId,tx.scope.storeId]
interface Member extends Record<string,unknown> {id:string;customer_id:string;available_points:number;pending_recovery_points:number}
export class ManualPointsService {
 constructor(private readonly transactions:Pick<ScopedPostgresTransactionRunner,'run'>){}
 async list(ctx:StaffCustomerExperienceContext,page=0):Promise<ManualPointsBoard>{
  return this.transactions.run(ctx.scope,async tx=>{
   await this.permission(tx,ctx.employeeId,'view')
   const result=await tx.query<ManualPointsBoard['items'][number]&Record<string,unknown>>(`SELECT r.id,m.member_no AS "memberNo",r.points_delta AS "pointsDelta",r.reason,r.requested_by_employee_id AS "requestedBy",e.display_name AS "requesterName",r.created_at::text AS "createdAt",COALESCE(d.decision,'requested') AS status,d.reason AS "decisionReason",a.display_name AS "deciderName",l.expires_at::text AS "expiresAt",receipt.result->>'availableDelta' AS "availableDelta"
    FROM mbox.loyalty_manual_requests r JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id,m.id)=(r.tenant_id,r.store_id,r.membership_id)
    JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(r.tenant_id,r.store_id,r.requested_by_employee_id)
    LEFT JOIN mbox.loyalty_manual_decisions d ON (d.tenant_id,d.store_id,d.request_id)=(r.tenant_id,r.store_id,r.id)
    LEFT JOIN mbox.employees a ON (a.tenant_id,a.store_id,a.id)=(d.tenant_id,d.store_id,d.decided_by_employee_id)
    LEFT JOIN mbox.loyalty_point_ledger l ON (l.tenant_id,l.store_id,l.id)=(d.tenant_id,d.store_id,d.ledger_entry_id)
    LEFT JOIN LATERAL(SELECT result FROM mbox.loyalty_manual_receipts c WHERE c.tenant_id=r.tenant_id AND c.store_id=r.store_id AND c.operation='decision' AND c.result->>'requestId'=r.id::text LIMIT 1)receipt ON true
    WHERE r.tenant_id=$1 AND r.store_id=$2 ORDER BY (d.request_id IS NULL) DESC,r.created_at DESC,r.id LIMIT 51 OFFSET $3`,[...scope(tx),page*50])
   return {scopeKey:scope(tx).join(':'),employeeId:ctx.employeeId,items:result.rows.slice(0,50).map(r=>({...r,availableDelta:r.availableDelta===null?null:Number(r.availableDelta)})),page,hasMore:result.rows.length>50}
  },{readOnly:true})
 }
 request(ctx:StaffCustomerExperienceContext,input:ManualPointsRequest,key:string){return this.execute(ctx,'request',input,key,async tx=>{
  if(!Number.isSafeInteger(input.pointsDelta)||input.pointsDelta===0||Math.abs(input.pointsDelta)>1000000)fail('INVALID','积分必须为非零整数，绝对值不超过100万')
  const member=await this.member(tx,input.memberNo)
  const policy=await this.policy(tx)
  if(input.pointsDelta>0)await new LoyaltyOperationalControlRepository(tx).assertPositiveAccrualActive()
  const id=randomUUID()
  await tx.query(`INSERT INTO mbox.loyalty_manual_requests(id,tenant_id,store_id,membership_id,customer_id,policy_version_id,points_delta,requested_by_employee_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,...scope(tx),member.id,member.customer_id,policy,input.pointsDelta,ctx.employeeId,input.reason.trim()])
  return {requestId:id,status:'requested',pointsDelta:input.pointsDelta,availableDelta:0,balance:member.available_points,pendingRecoveryPoints:member.pending_recovery_points}
 })}
 decide(ctx:StaffCustomerExperienceContext,input:ManualPointsDecision,key:string){return this.execute(ctx,'decision',input,key,async tx=>{
  if(!['approve','reject'].includes(input.decision))fail('INVALID','请核对审核决定')
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`manual-points-request:${scope(tx).join(':')}:${input.requestId}`])
  const r=(await tx.query<{id:string;membership_id:string;customer_id:string;member_no:string;policy_version_id:string;points_delta:number;requested_by_employee_id:string}>(`SELECT r.*,m.member_no FROM mbox.loyalty_manual_requests r JOIN mbox.customer_memberships m ON (m.tenant_id,m.store_id,m.id)=(r.tenant_id,r.store_id,r.membership_id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.id=$3`,[...scope(tx),input.requestId])).rows[0]
  if(!r)fail('NOT_FOUND','申请不存在或不属于当前门店')
  if(r.requested_by_employee_id===ctx.employeeId)fail('SELF_APPROVAL','申请人不能复核自己的积分调整')
  if((await tx.query('SELECT 1 FROM mbox.loyalty_manual_decisions WHERE tenant_id=$1 AND store_id=$2 AND request_id=$3',[...scope(tx),r.id])).rowCount)fail('DECIDED','该申请已处理，请核对原结果')
  let ledger:string|null=null,result:ManualPointsResult={requestId:r.id,status:'rejected',pointsDelta:r.points_delta,availableDelta:0,balance:null,pendingRecoveryPoints:null}
  if(input.decision==='approve'){
   const member=await this.member(tx,r.member_no)
   if(member.id!==r.membership_id||member.customer_id!==r.customer_id)fail('MEMBER_CHANGED','会员归属已变化，请驳回后重新核对')
   if(await this.policy(tx)!==r.policy_version_id)fail('POLICY_CHANGED','积分规则已变化，请驳回后重新申请')
   const authority=await new StaffAccessRepository(tx).resolveApprovalAuthority(ctx.employeeId,'loyalty.adjust.manual')
   if(!authority||authority.calculationMode!=='amount_limit'||authority.currency!=='CNY'||authority.amountMinor===null||authority.amountMinor<Math.abs(r.points_delta)*100)fail('LIMIT','未配置足额人工积分审批额度，请由有额度的其他员工处理')
   const applied=await new LoyaltyAccrualRepository(tx).adjustPoints({customerId:r.customer_id,pointsDelta:r.points_delta,sourceType:'manual',sourceId:r.id,reason:input.reason.trim(),employeeId:ctx.employeeId,idempotencyKey:`manual-reviewed:${r.id}`,occurredAt:new Date().toISOString()})
   ledger=applied.ledgerEntryId
   result={requestId:r.id,status:'approved',pointsDelta:r.points_delta,availableDelta:applied.delta,balance:applied.balance,pendingRecoveryPoints:applied.pendingRecoveryPoints}
  }
  await tx.query(`INSERT INTO mbox.loyalty_manual_decisions(tenant_id,store_id,request_id,decision,decided_by_employee_id,reason,ledger_entry_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[...scope(tx),r.id,result.status,ctx.employeeId,input.reason.trim(),ledger])
  return result
 })}
 private async permission(tx:ScopedTransaction,employeeId:string,op:'view'|'request'|'decision'){
  const access=new StaffAccessRepository(tx)
  await access.assertPermission(employeeId,'loyalty.adjust.manual')
  if(op==='decision')await access.assertPermission(employeeId,'loyalty.accrual.approve')
 }
 private async member(tx:ScopedTransaction,memberNo:string){
  const m=(await tx.query<Member>(`SELECT m.id,m.customer_id,a.available_points,a.pending_recovery_points FROM mbox.customer_memberships m JOIN mbox.loyalty_accounts a ON (a.tenant_id,a.store_id,a.membership_id)=(m.tenant_id,m.store_id,m.id) JOIN mbox.customers c ON (c.tenant_id,c.store_id,c.id)=(m.tenant_id,m.store_id,m.customer_id) WHERE m.tenant_id=$1 AND m.store_id=$2 AND m.member_no=$3 AND m.status='active' AND c.status='active' AND c.merged_into_customer_id IS NULL FOR UPDATE OF c,m,a`,[...scope(tx),memberNo])).rows[0]
  if(!m)fail('MEMBER','请核对当前有效会员号，合并或停用会员不能调整')
  return m
 }
 private async policy(tx:ScopedTransaction){
  const row=(await tx.query<{id:string}>(`SELECT id FROM mbox.loyalty_policy_versions WHERE tenant_id=$1 AND store_id=$2 AND policy_code='BASE' AND status='published' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()) ORDER BY version DESC LIMIT 1 FOR SHARE`,scope(tx))).rows[0]
  if(!row)fail('POLICY','请先发布有效的积分规则，不能使用默认有效期发放')
  return row.id
 }
 private execute(ctx:StaffCustomerExperienceContext,op:'request'|'decision',input:ManualPointsRequest|ManualPointsDecision,key:string,work:(tx:ScopedTransaction)=>Promise<ManualPointsResult>){
  if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(key))fail('INVALID','请求编号无效')
  const fingerprint=createHash('sha256').update(JSON.stringify({employeeId:ctx.employeeId,...input})).digest('hex')
  return this.transactions.run(ctx.scope,async tx=>{
   await lockStaffAccessConfiguration(tx)
   await this.permission(tx,ctx.employeeId,op)
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`manual-points:${scope(tx).join(':')}:${op}:${key}`])
   const prior=(await tx.query<{fingerprint:string;result:ManualPointsResult}>('SELECT fingerprint,result FROM mbox.loyalty_manual_receipts WHERE tenant_id=$1 AND store_id=$2 AND operation=$3 AND idempotency_key=$4',[...scope(tx),op,key])).rows[0]
   if(prior){if(prior.fingerprint!==fingerprint)throw new IdempotencyConflictError('loyalty.manual',key);return {value:prior.result,replayed:true}}
   let value:ManualPointsResult
   try{
    if(typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.trim().length>240)fail('INVALID','请填写3至240字的实际依据')
    value=await work(tx)
   }catch(error){
    if(error instanceof LoyaltyPositiveAccrualPausedError)error=new ManualPointsError('MANUAL_POINTS_PAUSED','新增积分已暂停，未执行正向调整')
    if(error instanceof RangeError)error=new ManualPointsError('MANUAL_POINTS_BALANCE','当前可用积分不足，未执行扣减')
    if(error instanceof ManualPointsError)error.commitDisposition='not_committed'
    throw error
   }
   await appendAuditEvent(tx,{actor:{type:'employee',employeeId:ctx.employeeId},action:`loyalty.manual.${value.status}`,objectType:'loyalty_manual_request',objectId:value.requestId,businessDate:ctx.businessDate,reason:input.reason.trim(),afterData:{...value}})
   await tx.query('INSERT INTO mbox.loyalty_manual_receipts(tenant_id,store_id,operation,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...scope(tx),op,key,fingerprint,JSON.stringify(value)])
   return {value,replayed:false}
  })
 }
}
