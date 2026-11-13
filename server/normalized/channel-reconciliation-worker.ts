import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { ChannelFinanceRepository } from './channel-finance-repository.js'
import { ChannelGiftInventory } from './channel-gift-inventory.js'
import { ChannelPricingRepository } from './channel-pricing-repository.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'
export interface ChannelReconciliationBatch{workerId:string;claimed:number;failed:number;expired:number}
export class ChannelReconciliationWorker{
 constructor(private readonly transactions:ScopedPostgresTransactionRunner){}
 async runBatch(scope:Readonly<StoreScope>,workerId:string):Promise<ChannelReconciliationBatch>{
  const batch={workerId,claimed:0,failed:0,expired:0}
  await this.transactions.run(scope,async tx=>{
   const repo=new ChannelDistributionRepository(tx);await repo.lockIdentity()
   await tx.query(`DELETE FROM mbox.channel_request_buckets WHERE tenant_id=$1 AND store_id=$2 AND minute<clock_timestamp()-interval '1 day'`,[scope.tenantId,scope.storeId])
   const due=(await tx.query<{id:string}>(`SELECT q.id FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
    WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)<=clock_timestamp() ORDER BY q.issued_at,q.id LIMIT 100 FOR UPDATE OF q`,[scope.tenantId,scope.storeId])).rows
   for(const q of due){await tx.query(`UPDATE mbox.channel_claims SET status='expired',version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[scope.tenantId,scope.storeId,q.id]);await new ChannelGiftInventory(tx).release(q.id);await repo.event(q.id,'claim.expired',workerId,{},'正常到期，不恢复 N/K');batch.expired++}
   const closed=(await tx.query<{id:string}>(`SELECT q.id FROM mbox.channel_claims q JOIN mbox.channel_activations a ON (a.tenant_id,a.store_id,a.claim_id)=(q.tenant_id,q.store_id,q.id) JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(a.tenant_id,a.store_id,a.visit_id) WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.status='active' AND a.status='active' AND a.applied_discount_minor=0 AND v.closed_at IS NOT NULL LIMIT 100 FOR UPDATE OF q,a`,[scope.tenantId,scope.storeId])).rows
   for(const q of closed){await tx.query(`UPDATE mbox.channel_claims SET status='expired',version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[scope.tenantId,scope.storeId,q.id]);await tx.query(`UPDATE mbox.channel_activations SET status='cancelled',cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 AND status='active'`,[scope.tenantId,scope.storeId,q.id]);await new ChannelGiftInventory(tx).release(q.id);await repo.event(q.id,'claim.visit-ended',workerId,{},'离店后未兑现，保留发行历史');batch.expired++}
   await tx.query(`UPDATE mbox.channel_visits v SET closed_at=clock_timestamp(),version=version+1 WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM mbox.channel_visit_tables t WHERE (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,v.id)) AND EXISTS(SELECT 1 FROM mbox.channel_effective_attributions a WHERE (a.tenant_id,a.store_id,a.visit_id)=(v.tenant_id,v.store_id,v.id)) AND NOT EXISTS(SELECT 1 FROM mbox.channel_effective_attributions a JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(a.tenant_id,a.store_id,a.order_id) JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id) WHERE (a.tenant_id,a.store_id,a.visit_id)=(v.tenant_id,v.store_id,v.id) AND s.status='open')`,[scope.tenantId,scope.storeId])
   // Fulfillment is derived from actual goods, never from clicking redeem.
   await tx.query(`UPDATE mbox.channel_activations a SET status='fulfilled',fulfilled_at=clock_timestamp() WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.status='active' AND EXISTS(
    SELECT 1 FROM mbox.channel_price_applications p JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.order_id)
    WHERE (p.tenant_id,p.store_id,p.activation_id)=(a.tenant_id,a.store_id,a.id) AND o.status<>'cancelled' AND mbox.order_consumption_settled(o.tenant_id,o.store_id,o.id)
    AND EXISTS(SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND i.parent_order_item_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id) AND i.parent_order_item_id IS NULL AND i.status NOT IN('delivered','cancelled')))`,[scope.tenantId,scope.storeId])
   await tx.query(`UPDATE mbox.channel_claims q SET status='fulfilled',version=version+1 WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.status='active' AND EXISTS(SELECT 1 FROM mbox.channel_activations a WHERE (a.tenant_id,a.store_id,a.claim_id)=(q.tenant_id,q.store_id,q.id) AND a.status='fulfilled')`,[scope.tenantId,scope.storeId])
  })
  const visits=await this.transactions.run(scope,async tx=>(await tx.query<{id:string}>(`SELECT v.id FROM mbox.channel_visits v LEFT JOIN mbox.channel_financial_positions p ON (p.tenant_id,p.store_id,p.visit_id)=(v.tenant_id,v.store_id,v.id) WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.source_batch_id IS NOT NULL ORDER BY p.checked_at NULLS FIRST,v.id LIMIT 100`,[scope.tenantId,scope.storeId])).rows,{readOnly:true})
  for(const v of visits){batch.claimed++;try{await this.transactions.run(scope,async tx=>{await new ChannelFinanceRepository(tx).reconcile(v.id);await new ChannelPricingRepository(tx).releaseUnusedCancelled(v.id)})}catch{batch.failed++}}
  return batch
 }
}
