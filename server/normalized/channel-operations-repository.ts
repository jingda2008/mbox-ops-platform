import { channelRuleSchema } from '../../src/shared/channel-distribution.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { ChannelFinanceRepository } from './channel-finance-repository.js'
import { ChannelGiftInventory } from './channel-gift-inventory.js'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'
export class ChannelOperationsRepository{
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 private get repo(){return new ChannelDistributionRepository(this.tx)}
 async limits(claimLimit:number,capacityLimit:number,costLimitMinor:number,employee:string,reason:string){
  await this.repo.lockIdentity();await this.tx.query(`INSERT INTO mbox.channel_store_limits(tenant_id,store_id,claim_limit,capacity_limit,cost_limit_minor) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,store_id) DO UPDATE SET claim_limit=$3,capacity_limit=$4,cost_limit_minor=$5,updated_at=clock_timestamp()`,[...this.scope,claimLimit,capacityLimit,costLimitMinor]);await this.repo.event(this.tx.scope.storeId,'store.limits',`employee:${employee}`,{claimLimit,capacityLimit,costLimitMinor},reason);return{id:this.tx.scope.storeId}
 }
 async campaign(id:string,enabled:boolean,staff:boolean,self:boolean,employee:string,reason:string){
  await this.repo.lockIdentity();const row=await this.tx.query(`UPDATE mbox.channel_campaigns SET accepting_claims=$4,staff_entry_enabled=$5,self_entry_enabled=$6 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING id`,[...this.scope,id,enabled,staff,self]);if(!row.rows[0])throw new ChannelDistributionError('NOT_FOUND',404);await this.repo.event(id,'campaign.switch',`employee:${employee}`,{enabled,staff,self},reason);return{id}
 }
 async publish(id:string,enabled:boolean,employee:string,reason:string){
  await this.repo.lockIdentity()
  if(enabled){await this.repo.assertStoreCapacity(0);const row=(await this.tx.query<{created_by:string|null;rule:unknown}>(`SELECT created_by,rule_snapshot AS rule FROM mbox.channel_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,id])).rows[0]
   if(!row||!row.created_by||row.created_by===employee)throw new ChannelDistributionError('NOT_AUTHORIZED',403);channelRuleSchema.parse(row.rule)}
  const row=await this.tx.query(`UPDATE mbox.channel_batches SET accepting_claims=$4,approved_by=CASE WHEN $4 THEN $5 ELSE approved_by END,approved_at=CASE WHEN $4 THEN clock_timestamp() ELSE approved_at END WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING id`,[...this.scope,id,enabled,employee]);if(!row.rows[0])throw new ChannelDistributionError('NOT_FOUND',404)
  await this.repo.event(id,enabled?'batch.published':'batch.paused',`employee:${employee}`,{},reason);return{id}
 }
 async promoter(id:string,enabled:boolean,confirm:boolean,restaurantScope:boolean,contactEmployeeId:string,employee:string,reason:string){
  await this.repo.lockIdentity();const row=await this.tx.query(`UPDATE mbox.channel_promoters SET status=$4,can_confirm_statement=$5,restaurant_scope=$6,contact_employee_id=$7 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 RETURNING id`,[...this.scope,id,enabled?'active':'disabled',confirm,restaurantScope,contactEmployeeId]);if(!row.rows[0])throw new ChannelDistributionError('NOT_FOUND',404);if(!enabled)await this.tx.query(`UPDATE mbox.channel_web_sessions SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND promoter_id=$3 AND revoked_at IS NULL`,[...this.scope,id]);await this.repo.event(id,'promoter.access',`employee:${employee}`,{enabled,confirm,restaurantScope,contactEmployeeId},reason);return{id}
 }
 private async replacementCapacity(id:string,cost:number){
  await this.repo.assertStoreCapacity(cost,id)
  const row=(await this.tx.query<{held:number;cost:string;capacity:number;limit:string}>(`SELECT c.capacity_limit AS capacity,c.cost_limit_minor::text AS limit,count(other.id)::integer AS held,COALESCE(sum(other.cost_commitment_minor),0)::text AS cost FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id) JOIN mbox.channel_campaigns c ON (c.tenant_id,c.store_id,c.id)=(b.tenant_id,b.store_id,b.campaign_id) LEFT JOIN mbox.channel_batches sibling ON (sibling.tenant_id,sibling.store_id,sibling.campaign_id)=(c.tenant_id,c.store_id,c.id) LEFT JOIN mbox.channel_claims other ON (other.tenant_id,other.store_id,other.batch_id)=(sibling.tenant_id,sibling.store_id,sibling.id) AND other.id<>q.id AND NOT other.voided AND (other.status IN('active','fulfilled') OR(other.status='available' AND COALESCE(other.use_until_override,(sibling.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())) WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.id=$3 GROUP BY c.id,c.capacity_limit,c.cost_limit_minor`,[...this.scope,id])).rows[0]
  if(!row||row.held>=row.capacity||BigInt(row.cost)+BigInt(cost)>BigInt(row.limit))throw new ChannelDistributionError('CAPACITY')
 }
 async claim(id:string,action:'void'|'revoke'|'extend'|'replace-gift',employee:string,reason:string,options:{until?:string;productId?:string;quantity?:number;consent?:string}={}){
  await this.repo.lockIdentity()
  const q=(await this.tx.query<{status:string;voided:boolean;rule:unknown;use_until_override:string|null;cost_commitment_minor:string}>(`SELECT q.status,q.voided,q.use_until_override::text,q.cost_commitment_minor::text,b.rule_snapshot AS rule FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id) WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.id=$3 FOR UPDATE OF q`,[...this.scope,id])).rows[0]
  if(!q||q.voided||q.status==='fulfilled')throw new ChannelDistributionError('NOT_REVERSIBLE')
  const used=await this.tx.query(`SELECT id FROM mbox.channel_activations WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 AND (applied_discount_minor>0 OR status='fulfilled') LIMIT 1`,[...this.scope,id]);if(used.rows[0])throw new ChannelDistributionError('NOT_REVERSIBLE')
  const gift=(await this.tx.query<{state:string;order_id:string|null}>(`SELECT state,order_id FROM mbox.channel_gift_promises WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 FOR UPDATE`,[...this.scope,id])).rows[0]
  if(gift?.order_id||gift?.state==='converted')throw new ChannelDistributionError('NOT_REVERSIBLE')
  const rule=channelRuleSchema.parse(q.rule)
  if(action==='void'||action==='revoke'){
   if(action==='void'&&q.status==='active')throw new ChannelDistributionError('NOT_REVERSIBLE')
   await this.tx.query(`UPDATE mbox.channel_claims SET status='revoked',voided=$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id,action==='void'])
   await this.tx.query(`UPDATE mbox.channel_activations SET status='cancelled',cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 AND status='active'`,[...this.scope,id]);await new ChannelGiftInventory(this.tx).release(id)
  }else if(action==='extend'){
   const now=await this.repo.now(),until=Date.parse(options.until??'')
   if(!Number.isFinite(until)||until<=Math.max(now.getTime(),Date.parse(q.use_until_override??rule.useUntil))||until>now.getTime()+7*86400000||q.status==='revoked')throw new ChannelDistributionError('VERSION_CONFLICT')
   await this.replacementCapacity(id,Number(q.cost_commitment_minor))
   if(gift?.state==='released'&&rule.offer.kind==='gift'){const saved=(await this.tx.query<{offer:typeof rule.offer}>(`SELECT snapshot->'offer' AS offer FROM mbox.channel_gift_versions WHERE tenant_id=$1 AND store_id=$2 AND claim_id=$3 ORDER BY generation DESC LIMIT 1`,[...this.scope,id])).rows[0];await new ChannelGiftInventory(this.tx).reserve(id,saved?.offer??rule.offer)}
   await this.tx.query(`UPDATE mbox.channel_claims SET use_until_override=$4,status=CASE WHEN status='expired' THEN 'available' ELSE status END,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id,options.until])
  }else{
   if(rule.offer.kind!=='gift'||!options.productId||!options.quantity||!options.consent?.trim()||!['available','active','expired'].includes(q.status))throw new ChannelDistributionError('NOT_REVERSIBLE')
   if(q.status==='expired'||options.until){const now=(await this.repo.now()).getTime(),until=Date.parse(options.until??'');if(!Number.isFinite(until)||until<=now||until>now+7*86400000||(q.status!=='expired'&&until<Date.parse(q.use_until_override??rule.useUntil)))throw new ChannelDistributionError('EXPIRED')}
   const product=(await this.tx.query<{name:string;cost:string}>(`SELECT name,cost_amount_minor::text AS cost FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' AND product_kind='single' AND cost_amount_minor IS NOT NULL`,[...this.scope,options.productId])).rows[0];if(!product)throw new ChannelDistributionError('CAPACITY')
   const offer={kind:'gift' as const,productId:options.productId,productName:product.name,quantity:options.quantity,costMinor:Number(product.cost)*options.quantity}
   await this.replacementCapacity(id,offer.costMinor)
   await this.tx.query(`UPDATE mbox.channel_claims SET status='revoked' WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id]);await new ChannelGiftInventory(this.tx).release(id);await new ChannelGiftInventory(this.tx).reserve(id,offer)
   await this.tx.query(`UPDATE mbox.channel_claims SET status=$4,cost_commitment_minor=$5,use_until_override=COALESCE($6::timestamptz,use_until_override),version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id,q.status==='expired'?'available':q.status,offer.costMinor,options.until??null])
  }
  await this.repo.event(id,`claim.${action}`,`employee:${employee}`,options,reason);return{id}
 }
 async arrival(tableSessionId:string,employee:string,reason:string){
  await this.repo.lockIdentity();const row=(await this.tx.query<{id:string}>(`UPDATE mbox.channel_visits v SET arrival_confirmed_at=COALESCE(arrival_confirmed_at,clock_timestamp()),arrival_confirmed_by_employee_id=COALESCE(arrival_confirmed_by_employee_id,$4) WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.closed_at IS NULL AND EXISTS(SELECT 1 FROM mbox.channel_visit_tables t WHERE (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,v.id) AND t.table_session_id=$3 AND t.detached_at IS NULL) RETURNING id`,[...this.scope,tableSessionId,employee])).rows[0];if(!row)throw new ChannelDistributionError('NOT_FOUND',404);await this.repo.event(row.id,'arrival.confirmed',`employee:${employee}`,{tableSessionId},reason);return row
 }
 async continuity(tableSessionId:string,previousVisitId:string,customerId:string,mode:'new'|'continue',employee:string,reason:string){
  await this.repo.lockIdentity();const customer=await this.repo.verifiedCustomer(customerId)
  const present=await this.tx.query(`SELECT p.id FROM mbox.table_session_customer_participations p JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.table_session_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.table_session_id=$3 AND p.customer_id=ANY($4::uuid[]) AND p.left_at IS NULL AND s.status='open' FOR UPDATE OF s`,[...this.scope,tableSessionId,customer.family]);if(!present.rows[0])throw new ChannelDistributionError('OWNERSHIP',403)
  const previous=await this.tx.query(`SELECT v.id FROM mbox.channel_visits v WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.id=$3 AND v.closed_at>clock_timestamp()-interval '30 minutes' AND v.opened_at>clock_timestamp()-interval '18 hours' AND EXISTS(SELECT 1 FROM mbox.channel_visit_tables t JOIN mbox.table_session_customer_participations p ON (p.tenant_id,p.store_id,p.table_session_id)=(t.tenant_id,t.store_id,t.table_session_id) WHERE (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,v.id) AND p.customer_id=ANY($4::uuid[])) FOR UPDATE OF v`,[...this.scope,previousVisitId,customer.family]);if(!previous.rows[0])throw new ChannelDistributionError('VERSION_CONFLICT')
  const occupied=await this.tx.query(`SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status NOT IN('draft','cancelled') UNION ALL SELECT visit_id FROM mbox.channel_visit_tables WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND detached_at IS NULL`,[...this.scope,tableSessionId]);if(occupied.rows[0])throw new ChannelDistributionError('SOURCE_CONFLICT')
  if(mode==='continue'){
    await this.tx.query(`UPDATE mbox.channel_visits SET closed_at=NULL,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,previousVisitId])
    await this.tx.query(`INSERT INTO mbox.channel_visit_tables(tenant_id,store_id,visit_id,table_session_id) VALUES($1,$2,$3,$4)`,[...this.scope,previousVisitId,tableSessionId])
    await new ChannelFinanceRepository(this.tx).reconcile(previousVisitId)
  }
  await this.repo.event(tableSessionId,mode==='new'?'visit.new-confirmed':'visit.continued',`employee:${employee}`,{customerId:customer.id,previousVisitId},reason);return{tableSessionId,previousVisitId,mode}
 }
 async correctOrders(orderIds:string[],batchId:string,employee:string,reason:string){
  await this.repo.lockIdentity()
  const batch=await this.tx.query(`SELECT id FROM mbox.channel_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,batchId]);if(!batch.rows[0])throw new ChannelDistributionError('NOT_FOUND',404)
  const orders=(await this.tx.query<{id:string;visit_id:string|null;closed_at:string|null;table_session_id:string;root_id:string|null;table_closed:boolean}>(`SELECT o.id,o.table_session_id,a.visit_id,v.closed_at::text,COALESCE(v.reporting_root_id,v.id) AS root_id,EXISTS(SELECT 1 FROM mbox.table_sessions s WHERE (s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id) AND s.status IN('closed','cancelled')) AS table_closed FROM mbox.orders o LEFT JOIN mbox.channel_effective_attributions a ON (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id) LEFT JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(a.tenant_id,a.store_id,a.visit_id) WHERE o.tenant_id=$1 AND o.store_id=$2 AND (o.id::text=ANY($3::text[]) OR o.public_id=ANY($3::text[])) ORDER BY o.id FOR UPDATE OF o`,[...this.scope,orderIds])).rows
  if(orders.length!==orderIds.length)throw new ChannelDistributionError('NOT_FOUND',404)
  if(new Set(orders.map(o=>o.root_id??o.table_session_id)).size!==1)throw new ChannelDistributionError('SOURCE_CONFLICT')
  // A correction concerns the listed historical orders only. It never rewrites
  // their price, guest account, original attribution or future table source.
  const visit=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_visits(tenant_id,store_id,source_batch_id,locked_use_limit,closed_at,reporting_root_id) VALUES($1,$2,$3,1,CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,$4) RETURNING id`,[...this.scope,batchId,orders[0]!.root_id,orders.every(o=>!!o.closed_at||o.table_closed)])).rows[0]!
  for(const o of orders)await this.tx.query(`INSERT INTO mbox.channel_order_corrections(tenant_id,store_id,order_id,visit_id,batch_id,employee_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,[...this.scope,o.id,visit.id,batchId,employee,reason])
  for(const id of new Set(orders.map(o=>o.visit_id).filter((id):id is string=>!!id)))await new ChannelFinanceRepository(this.tx).reconcile(id)
  await new ChannelFinanceRepository(this.tx).reconcile(visit.id)
  await this.repo.event(visit.id,'orders.source-corrected',`employee:${employee}`,{orderIds,batchId},reason);return{visitId:visit.id}
 }
}
