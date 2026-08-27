import { createHash } from 'node:crypto'
import type { ScopedPostgresTransactionRunner, ScopedTransaction, StoreScope } from './transaction-runner.js'
import { LoyaltyOperationalControlRepository } from './loyalty-operational-control-repository.js'
import type { WechatMiniProgramNotificationRecipientResolver, WechatSubscriptionDeliveryResult } from './wechat-loyalty-notification-worker.js'
import type { WechatTemplateMessageDelivery } from './wechat-subscription-message-adapter.js'

interface ClaimedRow extends Record<string,unknown> {
  id:string;customer_id:string;identity_external_id:string;template_id:string;page_path:string
  title_data_key:string;detail_data_key:string;occurred_at_data_key:string
  title:string;detail:string;event_occurred_at:string
}
export interface WechatMemberServiceNotificationBatch {
  workerId:string;paused:boolean;claimed:number;accepted:string[];rejected:string[];unknown:string[]
}

export class WechatMemberServiceNotificationWorker {
  constructor(
    private readonly transactions: Pick<ScopedPostgresTransactionRunner,'run'>,
    private readonly recipients: WechatMiniProgramNotificationRecipientResolver,
    private readonly delivery: WechatTemplateMessageDelivery,
  ) {}

  async runBatch(scope:Readonly<StoreScope>,workerId:string,batchSize=50):Promise<WechatMemberServiceNotificationBatch>{
    validateWorker(workerId,batchSize)
    const initiallyPaused=await this.transactions.run(scope,async(transaction)=>(
      (await new LoyaltyOperationalControlRepository(transaction).state('wechat_notification')).state==='paused'
    ),{readOnly:true})
    if(initiallyPaused)return {workerId,paused:true,claimed:0,accepted:[],rejected:[],unknown:[]}
    await this.delivery.preflight?.()
    const claimed=await this.transactions.run(scope,(transaction)=>claim(transaction,workerId,batchSize))
    const batch:WechatMemberServiceNotificationBatch={workerId,paused:claimed.paused,claimed:claimed.jobs.length,accepted:[],rejected:[],unknown:[]}
    for(const job of claimed.jobs){
      let result:WechatSubscriptionDeliveryResult
      try{
        const recipient=await this.recipients.resolveMiniProgramNotificationRecipient(job.customer_id,job.identity_external_id)
        result=recipient===null?{outcome:'provider_rejected',providerReference:null,errorCode:'recipient_unavailable'}
          :await this.delivery.sendTemplate({jobId:job.id,recipientOpenId:recipient.openId,templateId:job.template_id,
            pagePath:job.page_path,data:{[job.title_data_key]:job.title,[job.detail_data_key]:job.detail,[job.occurred_at_data_key]:providerTime(job.event_occurred_at)}})
      }catch{result={outcome:'unknown',providerReference:null,errorCode:'delivery_outcome_unknown'}}
      await this.transactions.run(scope,(transaction)=>recordOutcome(transaction,job.id,workerId,result))
      batch[result.outcome==='accepted'?'accepted':result.outcome==='provider_rejected'?'rejected':'unknown'].push(job.id)
    }
    return batch
  }
}

async function claim(transaction:ScopedTransaction,workerId:string,batchSize:number):Promise<{jobs:ClaimedRow[];paused:boolean}>{
  const control=await new LoyaltyOperationalControlRepository(transaction).state('wechat_notification',true)
  if(control.state==='paused')return {jobs:[],paused:true}
  await transaction.query(`
    UPDATE mbox.wechat_member_service_notification_jobs job
    SET status='suppressed',failure_code=CASE WHEN EXISTS(
      SELECT 1 FROM mbox.wechat_member_service_notification_authorization_uses used
      WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id AND used.authorization_id=job.authorization_id
    ) THEN 'authorization_already_used'
    WHEN (job.source_type='activity_registration' AND NOT EXISTS(
      SELECT 1 FROM mbox.community_activity_registrations registration
      WHERE registration.tenant_id=job.tenant_id AND registration.store_id=job.store_id AND registration.id=job.source_id
        AND registration.customer_id=job.customer_id AND registration.membership_id=job.membership_id
        AND registration.registration_cycle=job.source_occurrence AND registration.status IN ('confirmed','checked_in')
    )) OR (job.source_type='benefit' AND NOT EXISTS(
      SELECT 1 FROM mbox.benefits benefit
      WHERE benefit.tenant_id=job.tenant_id AND benefit.store_id=job.store_id AND benefit.id=job.source_id
        AND benefit.customer_id=job.customer_id AND benefit.status IN ('issued','reserved')
    )) OR (job.source_type='membership_tier_event' AND NOT EXISTS(
      SELECT 1 FROM mbox.membership_tier_events tier_event
      WHERE tier_event.tenant_id=job.tenant_id AND tier_event.store_id=job.store_id AND tier_event.id=job.source_id
        AND tier_event.membership_id=job.membership_id
    )) THEN 'source_no_longer_sendable'
    ELSE 'authorization_or_scope_invalid' END,updated_at=clock_timestamp()
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.status IN ('pending','failed')
      AND (EXISTS(SELECT 1 FROM mbox.wechat_member_service_notification_authorization_uses used
        WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id AND used.authorization_id=job.authorization_id)
      OR (job.source_type='activity_registration' AND NOT EXISTS(
        SELECT 1 FROM mbox.community_activity_registrations registration
        WHERE registration.tenant_id=job.tenant_id AND registration.store_id=job.store_id AND registration.id=job.source_id
          AND registration.customer_id=job.customer_id AND registration.membership_id=job.membership_id
          AND registration.registration_cycle=job.source_occurrence AND registration.status IN ('confirmed','checked_in')
      )) OR (job.source_type='benefit' AND NOT EXISTS(
        SELECT 1 FROM mbox.benefits benefit
        WHERE benefit.tenant_id=job.tenant_id AND benefit.store_id=job.store_id AND benefit.id=job.source_id
          AND benefit.customer_id=job.customer_id AND benefit.status IN ('issued','reserved')
      )) OR (job.source_type='membership_tier_event' AND NOT EXISTS(
        SELECT 1 FROM mbox.membership_tier_events tier_event
        WHERE tier_event.tenant_id=job.tenant_id AND tier_event.store_id=job.store_id AND tier_event.id=job.source_id
          AND tier_event.membership_id=job.membership_id
      ))
      OR NOT EXISTS(
        SELECT 1 FROM mbox.wechat_member_service_notification_authorizations active_auth
        JOIN mbox.wechat_member_service_notification_policies policy
          ON policy.tenant_id=active_auth.tenant_id AND policy.store_id=active_auth.store_id AND policy.id=active_auth.policy_id
        JOIN mbox.customer_memberships membership
          ON membership.tenant_id=active_auth.tenant_id AND membership.store_id=active_auth.store_id
         AND membership.id=active_auth.membership_id AND membership.customer_id=active_auth.customer_id AND membership.status='active'
        JOIN mbox.wechat_identities identity
          ON identity.tenant_id=active_auth.tenant_id AND identity.store_id=active_auth.store_id
         AND identity.external_identity_id=active_auth.identity_external_id AND identity.channel='mini_program' AND identity.revoked_at IS NULL
        WHERE active_auth.tenant_id=job.tenant_id AND active_auth.store_id=job.store_id
          AND active_auth.id=job.authorization_id AND active_auth.decision='granted'
          AND policy.status='published' AND policy.effective_from<=clock_timestamp()
          AND (policy.effective_until IS NULL OR policy.effective_until>clock_timestamp())
          AND active_auth.id=(SELECT latest.id FROM mbox.wechat_member_service_notification_authorizations latest
            WHERE latest.tenant_id=active_auth.tenant_id AND latest.store_id=active_auth.store_id
              AND latest.customer_id=active_auth.customer_id AND latest.policy_id=active_auth.policy_id
            ORDER BY latest.authorization_version DESC,latest.id DESC LIMIT 1)
      ))
  `,[transaction.scope.tenantId,transaction.scope.storeId])
  await transaction.query(`
    WITH rate_clock AS (
      SELECT job.id,GREATEST(job.scheduled_for,
        COALESCE(MAX(sent.sent_at)+make_interval(mins=>policy.minimum_interval_minutes),job.scheduled_for),
        CASE WHEN COUNT(sent.id)>=policy.max_per_customer_per_24h THEN COALESCE(MIN(sent.sent_at)+interval '24 hours',job.scheduled_for) ELSE job.scheduled_for END
      ) AS next_scheduled_for
      FROM mbox.wechat_member_service_notification_jobs job
      JOIN mbox.wechat_member_service_notification_policies policy ON policy.tenant_id=job.tenant_id AND policy.store_id=job.store_id AND policy.id=job.policy_id
      LEFT JOIN mbox.wechat_member_service_notification_jobs sent ON sent.tenant_id=job.tenant_id AND sent.store_id=job.store_id
       AND sent.customer_id=job.customer_id AND sent.policy_id=job.policy_id AND sent.status='sent' AND sent.sent_at>clock_timestamp()-interval '24 hours'
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.status IN ('pending','failed')
      GROUP BY job.id,job.scheduled_for,policy.minimum_interval_minutes,policy.max_per_customer_per_24h
    ) UPDATE mbox.wechat_member_service_notification_jobs job
      SET scheduled_for=rate_clock.next_scheduled_for,updated_at=clock_timestamp()
      FROM rate_clock WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.id=rate_clock.id
        AND rate_clock.next_scheduled_for>job.scheduled_for
  `,[transaction.scope.tenantId,transaction.scope.storeId])
  const claimed=await transaction.query<ClaimedRow>(`
    WITH candidates AS MATERIALIZED(
      SELECT job.id,job.authorization_id FROM mbox.wechat_member_service_notification_jobs job
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.status IN ('pending','failed')
        AND job.attempts<job.max_attempts AND job.scheduled_for<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM mbox.wechat_member_service_notification_authorization_uses used
          WHERE used.tenant_id=job.tenant_id AND used.store_id=job.store_id AND used.authorization_id=job.authorization_id)
      ORDER BY job.scheduled_for,job.created_at,job.id FOR UPDATE SKIP LOCKED LIMIT $4
    ),consumed AS(
      INSERT INTO mbox.wechat_member_service_notification_authorization_uses(tenant_id,store_id,authorization_id,notification_job_id)
      SELECT $1::uuid,$2::uuid,candidate.authorization_id,candidate.id FROM candidates candidate ON CONFLICT DO NOTHING RETURNING notification_job_id
    ),changed AS(
      UPDATE mbox.wechat_member_service_notification_jobs job SET status='sending',attempts=job.attempts+1,locked_by=$3,
        locked_at=clock_timestamp(),failure_code=NULL,updated_at=clock_timestamp() FROM consumed
      WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.id=consumed.notification_job_id RETURNING job.*
    ) SELECT changed.id,changed.customer_id,changed.identity_external_id,changed.template_id,policy.page_path,
      policy.title_data_key,policy.detail_data_key,policy.occurred_at_data_key,changed.title,changed.detail,changed.event_occurred_at::text
    FROM changed JOIN mbox.wechat_member_service_notification_policies policy
      ON policy.tenant_id=changed.tenant_id AND policy.store_id=changed.store_id AND policy.id=changed.policy_id
    ORDER BY changed.scheduled_for,changed.created_at,changed.id
  `,[transaction.scope.tenantId,transaction.scope.storeId,workerId,batchSize])
  return {jobs:claimed.rows,paused:false}
}

async function recordOutcome(transaction:ScopedTransaction,jobId:string,workerId:string,result:WechatSubscriptionDeliveryResult):Promise<void>{
  const errorCode=result.outcome==='accepted'?null:normalizeCode(result.errorCode)
  const reference=result.providerReference===null?null:createHash('sha256').update(result.providerReference).digest('hex')
  const inserted=await transaction.query(`
    INSERT INTO mbox.wechat_member_service_notification_receipts(tenant_id,store_id,notification_job_id,outcome,provider_reference_hash,provider_error_code,occurred_at)
    SELECT $1::uuid,$2::uuid,job.id,$4,$5,$6,clock_timestamp() FROM mbox.wechat_member_service_notification_jobs job
    WHERE job.tenant_id=$1::uuid AND job.store_id=$2::uuid AND job.id=$3::uuid AND job.status='sending' AND job.locked_by=$7
    ON CONFLICT(tenant_id,store_id,notification_job_id) DO NOTHING RETURNING notification_job_id
  `,[transaction.scope.tenantId,transaction.scope.storeId,jobId,result.outcome,reference,errorCode,workerId])
  if(inserted.rowCount!==1)throw new Error('WeChat member-service notification job lease was lost before receipt')
  const updated=await transaction.query(`
    UPDATE mbox.wechat_member_service_notification_jobs SET status=$4,failure_code=$5,
      sent_at=CASE WHEN $4='sent' THEN clock_timestamp() ELSE NULL END,locked_by=NULL,locked_at=NULL,updated_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='sending' AND locked_by=$6
  `,[transaction.scope.tenantId,transaction.scope.storeId,jobId,result.outcome==='accepted'?'sent':'failed',errorCode,workerId])
  if(updated.rowCount!==1)throw new Error('WeChat member-service notification job lease was lost after receipt')
}
function providerTime(value:string):string{const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new TypeError('provider time is invalid');return date.toISOString().replace('T',' ').slice(0,16)}
function validateWorker(workerId:string,batchSize:number):void{if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId))throw new TypeError('workerId is invalid');if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('batchSize is invalid')}
function normalizeCode(value:string):string{const normalized=value.trim().toLowerCase();return /^[a-z][a-z0-9_.:-]{2,95}$/.test(normalized)?normalized:'provider_error_invalid'}
