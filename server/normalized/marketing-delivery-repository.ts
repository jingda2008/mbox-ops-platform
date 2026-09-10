import {createHash} from 'node:crypto'
import type {ScopedTransaction} from './transaction-runner.js'
import {MarketingContactRepository} from './marketing-contact-repository.js'
import {StaffAccessRepository} from './staff-access-repository.js'
import {assessMarketingContact,marketingChannels,marketingPurposes,MarketingContactError,type MarketingChannel,type MarketingPurpose} from './marketing-contact-policy.js'
import {appendAuditEvent} from './command-executor.js'

export interface MarketingChannelEvidence{
  customerId:string;channel:MarketingChannel;purpose:MarketingPurpose;checkedAt:string;validUntil:string
  channelReady:boolean;verifiedRecipient:boolean;platformPermissionVerified:boolean
  capabilityRef:string;recipientRef:string;platformRef:string
}
type Job=Record<string,unknown>&{id:string;customer_id:string;notice_id:string;consent_id:string;channel:MarketingChannel;purpose:MarketingPurpose;status:string;content:string;campaign_key:string;expires_at:string;checks:number;created_by_employee_id:string}
export type MarketingDeliveryReceipt={state:'submitted'|'sent'|'unknown'|'failed'|'cancelled';providerReceiptRef?:string}
type PreparedDelivery={status:'blocked'|'cancelled';jobId:string;reason:string}|{status:'dispatching';jobId:string;attemptId:string;channel:MarketingChannel;purpose:MarketingPurpose;customerId:string;content:string}
function uuid(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))throw new MarketingContactError('任务编号无效')}
export class MarketingDeliveryRepository{
  constructor(private readonly tx:ScopedTransaction){}
  private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
  async get(jobId:string):Promise<Job>{uuid(jobId);const row=(await this.tx.query<Job>('SELECT * FROM mbox.marketing_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,jobId])).rows[0];if(!row)throw new MarketingContactError('任务不存在或不属于本店');return row}
  async list(employeeId:string,cursor:string|null=null){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'marketing.send');if(cursor)uuid(cursor)
    const rows=(await this.tx.query(`SELECT j.id,j.channel,j.purpose,j.campaign_key,j.status,j.blocked_reason,j.checks,j.created_at,j.expires_at,c.public_id AS customer_ref FROM mbox.marketing_delivery_jobs j JOIN mbox.customers c ON c.tenant_id=j.tenant_id AND c.store_id=j.store_id AND c.id=j.customer_id WHERE j.tenant_id=$1 AND j.store_id=$2 AND ($3::uuid IS NULL OR j.id>$3) ORDER BY j.id LIMIT 51`,[...this.scope,cursor])).rows
    return{items:rows.slice(0,50),nextCursor:rows.length>50?String(rows[49]!.id):null}
  }
  async queue(input:{customerId:string;noticeId:string;channel:MarketingChannel;purpose:MarketingPurpose;campaignKey:string;content:string;expiresAt:string;employeeId:string;businessDate:string}){
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId,'marketing.send')
    if(!marketingChannels.includes(input.channel)||!marketingPurposes.includes(input.purpose)||!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(input.campaignKey)||typeof input.content!=='string'||input.content.trim().length<2||input.content.length>2000||!/(?:Z|[+-]\d{2}:\d{2})$/.test(input.expiresAt)||!Number.isFinite(Date.parse(input.expiresAt)))throw new MarketingContactError('请核对任务范围、内容、批次及截止时间')
    const authority=await new MarketingContactRepository(this.tx).executionAuthority(input.customerId,input.noticeId,input.channel,input.purpose)
    const old=(await this.tx.query<Job>(`SELECT * FROM mbox.marketing_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND campaign_key=$3 AND channel=$4 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$5`,[...this.scope,input.campaignKey,input.channel,authority.customerId])).rows[0]
    if(old){if(old.notice_id!==input.noticeId||old.purpose!==input.purpose||old.content!==input.content.trim()||new Date(old.expires_at).toISOString()!==new Date(input.expiresAt).toISOString())throw new MarketingContactError('同一活动任务内容已变化，不能复用原任务');return{jobId:old.id,status:old.status,replayed:true}}
    const consent=authority.consent
    const decision=assessMarketingContact(authority.notice.rule,{channel:input.channel,purpose:input.purpose,now:authority.now,noticeId:input.noticeId,noticePublished:authority.notice.status==='published',consent,channelReady:false,verifiedRecipient:false,platformPermissionVerified:false,sentOrSubmittedToday:0,sentOrSubmittedMonth:0,unknownAttempt:false})
    if(decision.allowed||decision.reason!=='channel_not_configured'||!consent)throw new MarketingContactError('当前没有覆盖本次任务的有效本人营销许可')
    if(Date.parse(input.expiresAt)<=authority.now.getTime()||Date.parse(input.expiresAt)>Date.parse(consent.validUntil))throw new MarketingContactError('任务截止必须在本人许可有效期内')
    const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.marketing_delivery_jobs(tenant_id,store_id,customer_id,notice_id,consent_id,channel,purpose,campaign_key,content,expires_at,created_by_employee_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[...this.scope,authority.customerId,input.noticeId,consent.consentId,input.channel,input.purpose,input.campaignKey,input.content.trim(),input.expiresAt,input.employeeId])).rows[0]!
    await appendAuditEvent(this.tx,{actor:{type:'employee',employeeId:input.employeeId},businessDate:input.businessDate,action:'marketing.task_queued',objectType:'marketing_delivery_job',objectId:row.id,afterData:{channel:input.channel,purpose:input.purpose,contentHash:createHash('sha256').update(input.content.trim()).digest('hex')}})
    return{jobId:row.id,status:'queued',replayed:false}
  }
  async cancel(jobId:string,employeeId:string,businessDate:string,reason:string){
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'marketing.send');if(reason.trim().length<2||reason.length>500)throw new MarketingContactError('请填写取消原因')
    const job=await this.get(jobId)
    await new MarketingContactRepository(this.tx).executionAuthority(job.customer_id,job.notice_id,job.channel,job.purpose)
    const result=await this.tx.query("UPDATE mbox.marketing_delivery_jobs SET status='cancelled',blocked_reason='staff_cancelled',updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('queued','blocked') RETURNING id",[...this.scope,jobId])
    if(!result.rows.length&&job.status!=='cancelled')throw new MarketingContactError('任务已进入渠道或结束，不能假装撤回已发送内容')
    if(result.rows.length)await appendAuditEvent(this.tx,{actor:{type:'employee',employeeId},businessDate,action:'marketing.task_cancelled',objectType:'marketing_delivery_job',objectId:jobId,reason})
    return{cancelled:true}
  }
  /** Server-owned adapters alone supply channel evidence. A public request
   * cannot set any readiness flag, recipient, or platform proof. */
  async prepare(jobId:string,evidence:MarketingChannelEvidence|null):Promise<PreparedDelivery|null>{
    const initial=await this.get(jobId)
    const authority=await new MarketingContactRepository(this.tx).executionAuthority(initial.customer_id,initial.notice_id,initial.channel,initial.purpose)
    const rows=await this.tx.query<Job>("SELECT * FROM mbox.marketing_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('queued','blocked') AND next_check_at<=clock_timestamp() FOR UPDATE SKIP LOCKED",[...this.scope,jobId])
    const job=rows.rows[0];if(!job)return null
    let permission=true;try{await new StaffAccessRepository(this.tx).assertPermission(job.created_by_employee_id,'marketing.send')}catch{permission=false}
    const counts=(await this.tx.query<{today:number;month:number;unknown:boolean}>(`WITH RECURSIVE family(id) AS(SELECT $3::uuid UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id WHERE c.tenant_id=$1 AND c.store_id=$2) SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS today,count(*) FILTER(WHERE created_at>=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS month,COALESCE(bool_or(state IN('dispatching','unknown','submitted')),false) AS unknown FROM mbox.marketing_delivery_attempts WHERE tenant_id=$1 AND store_id=$2 AND customer_id IN(SELECT id FROM family) AND state<>'cancelled'`,[...this.scope,authority.customerId])).rows[0]!
    const fresh=!!evidence&&evidence.customerId===authority.customerId&&evidence.channel===job.channel&&evidence.purpose===job.purpose&&Number.isFinite(Date.parse(evidence.checkedAt))&&Date.parse(evidence.checkedAt)<=authority.now.getTime()&&authority.now.getTime()-Date.parse(evidence.checkedAt)<=15000&&Date.parse(evidence.validUntil)>authority.now.getTime()
    const decision=assessMarketingContact(authority.notice.rule,{channel:job.channel,purpose:job.purpose,now:authority.now,noticeId:job.notice_id,noticePublished:authority.notice.status==='published',consent:authority.consent,queuedConsentId:job.consent_id,channelReady:fresh&&!!evidence?.channelReady,verifiedRecipient:fresh&&!!evidence?.verifiedRecipient,platformPermissionVerified:fresh&&!!evidence?.platformPermissionVerified,sentOrSubmittedToday:counts.today,sentOrSubmittedMonth:counts.month,unknownAttempt:counts.unknown})
    const expired=Date.parse(String(job.expires_at))<=authority.now.getTime()
    if(!decision.allowed||expired||!permission){
      const why=expired?'task_expired':!permission?'sender_permission_revoked':!decision.allowed?decision.reason:'not_allowed'
      const terminal=['task_expired','sender_permission_revoked','notice_unavailable','not_consented','consent_expired_or_scope_changed','consent_changed_since_queue','scope_not_covered'].includes(why)
      await this.tx.query(`UPDATE mbox.marketing_delivery_jobs SET status=$4,blocked_reason=$5,checks=checks+1,next_check_at=clock_timestamp()+(LEAST(86400,900*power(2,LEAST(checks,7)))*interval '1 second'),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,job.id,terminal?'cancelled':'blocked',why])
      return{status:terminal?'cancelled':'blocked',jobId:job.id,reason:why} as const
    }
    if(!evidence||[evidence.capabilityRef,evidence.recipientRef,evidence.platformRef].some(ref=>typeof ref!=='string'||ref.length<2||ref.length>200))throw new MarketingContactError('缺少服务端核实证据编号')
    await this.tx.query("UPDATE mbox.marketing_delivery_jobs SET status='dispatching',blocked_reason=NULL,checks=checks+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3",[...this.scope,job.id])
    const attempt=(await this.tx.query<{id:string}>(`INSERT INTO mbox.marketing_delivery_attempts(tenant_id,store_id,job_id,customer_id,consent_id,capability_evidence_ref,recipient_evidence_ref,platform_evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[...this.scope,job.id,job.customer_id,job.consent_id,evidence.capabilityRef,evidence.recipientRef,evidence.platformRef])).rows[0]!
    return{status:'dispatching' as const,jobId:job.id,attemptId:attempt.id,channel:job.channel,purpose:job.purpose,customerId:authority.customerId,content:job.content}
  }
  async finish(attemptId:string,receipt:MarketingDeliveryReceipt){
    uuid(attemptId)
    if(!['submitted','sent','unknown','failed','cancelled'].includes(receipt.state)||((receipt.state==='submitted'||receipt.state==='sent')&&!receipt.providerReceiptRef)||receipt.providerReceiptRef&&receipt.providerReceiptRef.length>200)throw new MarketingContactError('渠道回执无效，不能伪造送达')
    const attempt=(await this.tx.query<{job_id:string;state:string;provider_receipt_ref:string|null}>('SELECT job_id,state,provider_receipt_ref FROM mbox.marketing_delivery_attempts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,attemptId])).rows[0]
    if(!attempt)throw new MarketingContactError('渠道尝试不存在')
    if(attempt.state===receipt.state){if(receipt.providerReceiptRef&&attempt.provider_receipt_ref!==receipt.providerReceiptRef)throw new MarketingContactError('相同渠道回执内容冲突');return{replayed:true}}
    await this.tx.query('UPDATE mbox.marketing_delivery_attempts SET state=$4,provider_receipt_ref=COALESCE(provider_receipt_ref,$5),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,attemptId,receipt.state,receipt.providerReceiptRef??null])
    await this.tx.query('UPDATE mbox.marketing_delivery_jobs SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,attempt.job_id,receipt.state])
    return{replayed:false}
  }
  async beforeDispatch(attemptId:string,evidence:MarketingChannelEvidence){
    uuid(attemptId)
    const attempt=(await this.tx.query<{job_id:string;state:string}>('SELECT job_id,state FROM mbox.marketing_delivery_attempts WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,attemptId])).rows[0]
    if(!attempt||attempt.state!=='dispatching')return false
    const job=await this.get(attempt.job_id),authority=await new MarketingContactRepository(this.tx).executionAuthority(job.customer_id,job.notice_id,job.channel,job.purpose)
    const proof=await this.tx.query('SELECT id FROM mbox.marketing_delivery_attempts WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND state=\'dispatching\' AND handoff_at IS NULL FOR UPDATE',[...this.scope,attemptId])
    if(!proof.rows.length)return false
    let permission=true;try{await new StaffAccessRepository(this.tx).assertPermission(job.created_by_employee_id,'marketing.send')}catch{permission=false}
    const fresh=evidence.customerId===authority.customerId&&evidence.channel===job.channel&&evidence.purpose===job.purpose&&Date.parse(evidence.checkedAt)<=authority.now.getTime()&&authority.now.getTime()-Date.parse(evidence.checkedAt)<=15000&&Date.parse(evidence.validUntil)>authority.now.getTime()
    const decision=assessMarketingContact(authority.notice.rule,{channel:job.channel,purpose:job.purpose,now:authority.now,noticeId:job.notice_id,noticePublished:authority.notice.status==='published',consent:authority.consent,queuedConsentId:job.consent_id,channelReady:fresh&&evidence.channelReady,verifiedRecipient:fresh&&evidence.verifiedRecipient,platformPermissionVerified:fresh&&evidence.platformPermissionVerified,sentOrSubmittedToday:0,sentOrSubmittedMonth:0,unknownAttempt:false})
    // Frequency slot was atomically reserved by prepare; no network call is
    // inside that transaction. A withdrawal before handoff cancels this slot.
    if(!permission||!decision.allowed||Date.parse(String(job.expires_at))<=authority.now.getTime()){
      await this.finish(attemptId,{state:'cancelled'});return false
    }
    await this.tx.query('UPDATE mbox.marketing_delivery_attempts SET handoff_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.scope,attemptId])
    return true
  }
}
