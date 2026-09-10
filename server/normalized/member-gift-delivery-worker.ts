import type {ScopedPostgresTransactionRunner,StoreScope} from './transaction-runner.js'
import {MemberGiftCampaignRepository} from './member-gift-campaign-repository.js'
export interface MemberGiftDeliveryBatch{workerId:string;discovered:number;issued:number;blocked:number;failed:number}
/** Approval commits independently. Approved applications are durable source
 * facts; periodic discovery heals a process crash without rolling back a card.
 * No HTTP/provider/marketing delivery happens in any of these transactions. */
export class MemberGiftDeliveryWorker{
  constructor(private readonly transactions:ScopedPostgresTransactionRunner){}
  async runBatch(scope:Readonly<StoreScope>,workerId:string,batchSize=50):Promise<MemberGiftDeliveryBatch>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(workerId)||!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new TypeError('Invalid gift worker batch')
    const result:MemberGiftDeliveryBatch={workerId,discovered:0,issued:0,blocked:0,failed:0}
    const candidates=await this.transactions.run(scope,async tx=>(await tx.query<{version_id:string;customer_id:string;application_id:string}>(`SELECT v.id AS version_id,a.customer_id,a.id AS application_id FROM mbox.member_gift_campaign_versions v
      JOIN mbox.member_card_applications a ON a.tenant_id=v.tenant_id AND a.store_id=v.store_id AND a.project_id=v.card_project_id AND a.status='approved'
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.trigger_kind='card_entry' AND v.status IN('published','stopped')
        AND a.resolved_at>=v.published_at AND a.resolved_at>=v.available_from AND a.resolved_at<v.available_until
        AND (v.stopped_at IS NULL OR a.resolved_at<v.stopped_at)
        AND NOT EXISTS(SELECT 1 FROM mbox.member_gift_delivery_jobs j WHERE j.tenant_id=v.tenant_id AND j.store_id=v.store_id AND j.campaign_code=v.code AND j.cycle_key='entry' AND mbox.canonical_customer_id(j.tenant_id,j.store_id,j.customer_id)=mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id))
      ORDER BY a.resolved_at,a.id,v.id LIMIT $3`,[scope.tenantId,scope.storeId,batchSize])).rows)
    for(const candidate of candidates){
      try{await this.transactions.run(scope,tx=>new MemberGiftCampaignRepository(tx).enqueue({versionId:candidate.version_id,customerId:candidate.customer_id,applicationId:candidate.application_id,cycleKey:'entry'}));result.discovered++}
      catch{result.failed++}
    }
    const due=await this.transactions.run(scope,async tx=>(await tx.query<{id:string}>(`SELECT id FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND status IN('pending','blocked') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT $3`,[scope.tenantId,scope.storeId,batchSize])).rows)
    for(const job of due){
      try{
        const delivered=await this.transactions.run(scope,async tx=>{
          // Two worker processes cannot both evaluate an already rescheduled
          // job. SKIP LOCKED keeps slow campaigns from serializing the batch.
          const claimed=await tx.query('SELECT id FROM mbox.member_gift_delivery_jobs WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN(\'pending\',\'blocked\') AND next_attempt_at<=clock_timestamp() FOR UPDATE SKIP LOCKED',[scope.tenantId,scope.storeId,job.id])
          return claimed.rows.length?new MemberGiftCampaignRepository(tx).deliver(job.id):null
        })
        if(delivered?.status==='issued')result.issued++
        if(delivered?.status==='blocked')result.blocked++
      }catch{
        result.failed++
        // A failed grant transaction has rolled back completely. A separate
        // short transaction records retry timing, never a fictional benefit.
        try{await this.transactions.run(scope,tx=>tx.query(`UPDATE mbox.member_gift_delivery_jobs SET status='blocked',attempts=attempts+1,last_error_code='delivery_retry_required',next_attempt_at=clock_timestamp()+(LEAST(86400,900*power(2,LEAST(attempts,7))) * interval '1 second') WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status IN('pending','blocked') AND next_attempt_at<=clock_timestamp()`,[scope.tenantId,scope.storeId,job.id]))}catch{/* Keep failure visible in the batch result; original job remains durable. */}
      }
    }
    return result
  }
}
