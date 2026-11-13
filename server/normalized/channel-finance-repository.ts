import { channelPartnerStatementSchema } from './channel-public-view.js'
import { createHash } from 'node:crypto'
import { channelRuleSchema } from '../../src/shared/channel-distribution.js'
import { allocateChannelAmount, channelCommissionDelta, ChannelDistributionError, ChannelBusinessError } from './channel-distribution-policy.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { ChannelPartnerRepository } from './channel-partner-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

const amount=(v:unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new ChannelBusinessError('渠道源金额无效');return n}
interface PaymentFact{id:string;amount:number;provider:string;status:string;succeededAt:string|null}
interface RefundFact{id:string;amount:number;status:string;completedAt:string|null}
interface LineFact{id:string;productId:string;amount:number;refunded:number;fulfilled:boolean;updatedAt:string}
interface OrderFact extends Record<string,unknown>{id:string;status:string;settled:boolean;gift:boolean;payments:PaymentFact[];refunds:RefundFact[];lines:LineFact[]}
/** Rebuild from authoritative facts, never from a callback's claimed amount.
 * All deltas are append-only, while position is an explicitly dated read model. */
export class ChannelFinanceRepository {
 constructor(private readonly tx:ScopedTransaction){}
 private get scope(){return[this.tx.scope.tenantId,this.tx.scope.storeId]}
 async lock(){await new ChannelDistributionRepository(this.tx).lockIdentity();await this.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`channel-finance:${this.scope.join(':')}`])}
 private event(id:string,type:string,actor:string,payload:Record<string,unknown>,reason:string){return new ChannelDistributionRepository(this.tx).event(id,type,actor,payload,reason)}
 async reconcile(visitId:string){
  await this.lock()
  const visit=(await this.tx.query<{batch_id:string;closed_at:string|null;source_review_required:boolean;rule:unknown}>(`SELECT v.source_batch_id AS batch_id,v.closed_at::text,v.source_review_required,b.rule_snapshot AS rule FROM mbox.channel_visits v JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(v.tenant_id,v.store_id,v.source_batch_id) WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.id=$3 FOR UPDATE OF v`,[...this.scope,visitId])).rows[0]
  if(!visit)throw new ChannelDistributionError('NOT_FOUND',404)
  const rule=channelRuleSchema.parse(visit.rule)
  // One SQL statement gives one coherent source snapshot under READ COMMITTED.
  const orders=(await this.tx.query<OrderFact>(`SELECT o.id,o.status,mbox.order_consumption_settled(o.tenant_id,o.store_id,o.id) AS settled,
   EXISTS(SELECT 1 FROM mbox.pricing_authorizations a WHERE (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id) AND a.status='consumed' AND a.kind='gift') AS gift,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount_minor,'provider',p.provider,'status',p.status,'succeededAt',p.succeeded_at) ORDER BY p.id) FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.order_id)=(o.tenant_id,o.store_id,o.id)),'[]') AS payments,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount_minor,'status',r.status,'completedAt',r.completed_at) ORDER BY r.id) FROM mbox.order_refund_facts r WHERE (r.tenant_id,r.store_id,r.order_id)=(o.tenant_id,o.store_id,o.id)),'[]') AS refunds,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'productId',i.product_id,'amount',b.amount_minor,
    'refunded',COALESCE((SELECT sum(ri.amount_minor) FROM mbox.refund_items ri JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(ri.tenant_id,ri.store_id,ri.refund_id) WHERE (ri.tenant_id,ri.store_id,ri.order_item_id)=(i.tenant_id,i.store_id,i.id) AND r.status='succeeded'),0),
    'fulfilled',i.status='delivered' OR (EXISTS(SELECT 1 FROM mbox.order_item_quantity_units u WHERE (u.tenant_id,u.store_id,u.order_item_id)=(i.tenant_id,i.store_id,i.id)) AND NOT EXISTS(SELECT 1 FROM mbox.order_item_quantity_units u WHERE (u.tenant_id,u.store_id,u.order_item_id)=(i.tenant_id,i.store_id,i.id) AND NOT u.operationally_stopped AND u.production_state<>'delivered')),
    'updatedAt',i.updated_at) ORDER BY i.id) FROM mbox.loyalty_order_item_basis b JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(b.tenant_id,b.store_id,b.order_item_id) WHERE (b.tenant_id,b.store_id,b.order_id)=(o.tenant_id,o.store_id,o.id)),'[]') AS lines
   FROM mbox.channel_effective_attributions a JOIN mbox.orders o ON (o.tenant_id,o.store_id,o.id)=(a.tenant_id,a.store_id,a.order_id)
   WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.visit_id=$3 ORDER BY o.id`,[...this.scope,visitId])).rows
  const reasons=new Set<string>(),evidence:Record<string,unknown>[]=[];let basis=0,latest=visit.closed_at?Date.parse(visit.closed_at):0
  if(!visit.closed_at)reasons.add('客组尚未结束')
  if(visit.source_review_required)reasons.add('原预约来源待主管按订单核对')
  for(const order of orders){
   const pending=order.refunds.some(r=>['requested','approved','processing'].includes(r.status));if(pending)reasons.add('退款待核实')
   if(order.gift||order.payments.some(p=>p.provider==='simulation')){evidence.push({orderId:order.id,excluded:order.gift?'gift':'simulation'});continue}
   if(order.payments.some(p=>['created','pending'].includes(p.status)))reasons.add('付款待核实')
   const successful=order.payments.filter(p=>['succeeded','partially_refunded','refunded'].includes(p.status)&&p.succeededAt)
   const unknown=successful.some(p=>!['cash','physical_pos','external_manual','wechat','postar'].includes(p.provider))
   if(unknown)reasons.add('本金来源待核实')
   const paid=successful.reduce((n,p)=>n+amount(p.amount),0),refunded=order.refunds.filter(r=>r.status==='succeeded').reduce((n,r)=>n+amount(r.amount),0)
   for(const p of successful)latest=Math.max(latest,Date.parse(p.succeededAt!))
   for(const l of order.lines)if(l.fulfilled)latest=Math.max(latest,Date.parse(l.updatedAt))
   const gross=order.lines.reduce((n,l)=>n+amount(l.amount),0)
   const allocated=order.lines.map(l=>({id:l.id,basisMinor:Math.max(0,amount(l.amount)-amount(l.refunded))}))
   const allocatedRefund=order.lines.reduce((n,l)=>n+amount(l.refunded),0)
   const extraRefund=Math.max(0,refunded-allocatedRefund)
   const mixed=order.lines.some(l=>(rule.commissionProductIds??rule.eligibleProductIds).includes(l.productId))&&order.lines.some(l=>!(rule.commissionProductIds??rule.eligibleProductIds).includes(l.productId))
   if(paid>gross&&extraRefund>0&&mixed){reasons.add('混合商品超收退款待分摊');evidence.push({orderId:order.id,pending:'overcollection_refund',paid,refunded});continue}
   const available=allocated.reduce((n,l)=>n+l.basisMinor,0)
   const extra=allocateChannelAmount(Math.min(available,extraRefund),allocated)
   const netLines=allocated.map((l,i)=>({...l,basisMinor:l.basisMinor-extra[i]!.amountMinor}))
   const netTotal=netLines.reduce((n,l)=>n+l.basisMinor,0),netPaid=Math.max(0,paid-refunded)
   const principal=allocateChannelAmount(Math.min(netTotal,netPaid),netLines)
   // Successful historical principal covers the original gross sale even after
   // refunds make the collection helper report a new balance for retained goods.
   const financiallyCovered=order.settled||(gross>0&&paid>=gross)
   let orderBasis=0
   if(order.status!=='cancelled'&&order.status!=='draft'&&!unknown&&!visit.source_review_required){
    if(!financiallyCovered&&netTotal>0)reasons.add('消费尚未结清')
    if(financiallyCovered)for(let i=0;i<order.lines.length;i++){
     const l=order.lines[i]!;if(!l.fulfilled&&netLines[i]!.basisMinor>0)reasons.add('商品尚未履约')
     if(l.fulfilled&&(rule.commissionProductIds??rule.eligibleProductIds).includes(l.productId))orderBasis+=principal[i]!.amountMinor
    }
   }
   basis+=orderBasis;evidence.push({orderId:order.id,paid,refunded,settled:order.settled,basis:orderBasis,netReceipt:financiallyCovered&&order.lines.every((l,i)=>l.fulfilled||netLines[i]!.basisMinor===0)?Math.min(netTotal,netPaid):0,lines:order.lines.map((l,i)=>({id:l.id,principalMinor:principal[i]!.amountMinor,fulfilled:l.fulfilled,eligible:(rule.commissionProductIds??rule.eligibleProductIds).includes(l.productId)})),payments:successful.map(p=>p.id),refunds:order.refunds})
  }
  const previous=(await this.tx.query<{commission_minor:string;fingerprint:string;revision:string}>(`SELECT commission_minor::text,fingerprint,revision::text FROM mbox.channel_financial_positions WHERE tenant_id=$1 AND store_id=$2 AND visit_id=$3 FOR UPDATE`,[...this.scope,visitId])).rows[0]
  const total=(await this.tx.query<{n:string}>(`SELECT COALESCE(sum(commission_delta_minor),0)::text AS n FROM mbox.channel_ledger WHERE tenant_id=$1 AND store_id=$2 AND visit_id=$3`,[...this.scope,visitId])).rows[0]!
  const delta=channelCommissionDelta(basis,rule.commissionBps,Number(total.n)),frozen=reasons.size>0
  const maturesAt=visit.closed_at?new Date(latest+rule.observationDays*86400000).toISOString():null
  const state={basis,target:delta.targetMinor,frozen,reasons:[...reasons].sort(),maturesAt,evidence},fingerprint=createHash('sha256').update(JSON.stringify(state)).digest('hex')
  const revision=Number(previous?.revision??0)+(previous?.fingerprint===fingerprint?0:1)
  if(delta.deltaMinor!==0)await this.tx.query(`INSERT INTO mbox.channel_ledger(tenant_id,store_id,visit_id,batch_id,event_key,net_basis_minor,commission_delta_minor,evidence,matures_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,COALESCE($9::timestamptz,'infinity'))`,[...this.scope,visitId,visit.batch_id,`reconcile:${visitId}:${revision}`,basis,delta.deltaMinor,JSON.stringify(state),maturesAt])
  await this.tx.query(`INSERT INTO mbox.channel_financial_positions(tenant_id,store_id,visit_id,batch_id,net_basis_minor,commission_minor,fingerprint,revision,frozen,reasons,matures_at,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)
   ON CONFLICT(tenant_id,store_id,visit_id) DO UPDATE SET net_basis_minor=EXCLUDED.net_basis_minor,commission_minor=EXCLUDED.commission_minor,fingerprint=EXCLUDED.fingerprint,revision=EXCLUDED.revision,frozen=EXCLUDED.frozen,reasons=EXCLUDED.reasons,matures_at=EXCLUDED.matures_at,evidence=EXCLUDED.evidence,checked_at=clock_timestamp()`,[...this.scope,visitId,visit.batch_id,basis,delta.targetMinor,fingerprint,revision,frozen,JSON.stringify(state.reasons),maturesAt,JSON.stringify(evidence)])
  return{visitId,...state,deltaMinor:delta.deltaMinor,revision}
 }
 async reconcilePromoter(promoterId:string){
  await this.lock();const rows=(await this.tx.query<{id:string}>(`SELECT v.id FROM mbox.channel_visits v JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(v.tenant_id,v.store_id,v.source_batch_id) WHERE v.tenant_id=$1 AND v.store_id=$2 AND b.promoter_id=$3 ORDER BY v.id`,[...this.scope,promoterId])).rows
  for(const v of rows)await this.reconcile(v.id)
 }
 async account(partnerId:string,reference:string,employeeId:string,reason:string){
  await this.lock();const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_settlement_accounts(tenant_id,store_id,partner_id,subject,account_reference,requested_by) SELECT $1,$2,id,settlement_subject,$4,$5 FROM mbox.channel_partners WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' RETURNING id`,[...this.scope,partnerId,reference,employeeId])).rows[0]
  if(!row)throw new ChannelDistributionError('NOT_FOUND',404);await this.event(row.id,'account.requested',`employee:${employeeId}`,{partnerId},reason);return row
 }
 async verifyAccount(id:string,employeeId:string,reason:string){
  await this.lock();const row=(await this.tx.query<{partner_id:string}>(`UPDATE mbox.channel_settlement_accounts SET verified_by=$4,verified_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND requested_by<>$4 AND verified_at IS NULL AND revoked_at IS NULL RETURNING partner_id`,[...this.scope,id,employeeId])).rows[0]
  if(!row)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  await this.tx.query(`UPDATE mbox.channel_settlement_accounts SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND partner_id=$3 AND id<>$4 AND revoked_at IS NULL`,[...this.scope,row.partner_id,id])
  await this.event(id,'account.verified',`employee:${employeeId}`,{},reason);return{id}
 }
 async statement(promoterId:string,accountId:string,employeeId:string,reason:string){
  await this.reconcilePromoter(promoterId)
  const account=await this.tx.query(`SELECT a.id FROM mbox.channel_settlement_accounts a JOIN mbox.channel_promoters p ON (p.tenant_id,p.store_id,p.partner_id)=(a.tenant_id,a.store_id,a.partner_id) WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.id=$3 AND p.id=$4 AND p.status='active' AND a.verified_at IS NOT NULL AND a.revoked_at IS NULL`,[...this.scope,accountId,promoterId]);if(!account.rows[0])throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  const lines=(await this.tx.query<{id:string;amount:string}>(`SELECT l.id,l.commission_delta_minor::text AS amount FROM mbox.channel_ledger l JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.batch_id)
   JOIN mbox.channel_financial_positions p ON (p.tenant_id,p.store_id,p.visit_id)=(l.tenant_id,l.store_id,l.visit_id)
   WHERE l.tenant_id=$1 AND l.store_id=$2 AND b.promoter_id=$3 AND NOT p.frozen AND p.matures_at<=clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM mbox.channel_statement_lines disputed_line JOIN mbox.channel_statements disputed ON (disputed.tenant_id,disputed.store_id,disputed.id)=(disputed_line.tenant_id,disputed_line.store_id,disputed_line.statement_id) JOIN mbox.channel_ledger disputed_ledger ON (disputed_ledger.tenant_id,disputed_ledger.store_id,disputed_ledger.id)=(disputed_line.tenant_id,disputed_line.store_id,disputed_line.ledger_id) WHERE disputed.tenant_id=l.tenant_id AND disputed.store_id=l.store_id AND EXISTS(SELECT 1 FROM mbox.channel_statements dispute_version WHERE (dispute_version.tenant_id,dispute_version.store_id,COALESCE(dispute_version.source_statement_id,dispute_version.id))=(disputed.tenant_id,disputed.store_id,disputed.id) AND dispute_version.status='disputed') AND disputed_ledger.visit_id=l.visit_id AND disputed_line.released_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM mbox.channel_statement_lines x WHERE (x.tenant_id,x.store_id,x.ledger_id)=(l.tenant_id,l.store_id,l.id) AND x.released_at IS NULL) ORDER BY l.sequence`,[...this.scope,promoterId])).rows
  if(!lines.length)throw new ChannelBusinessError('没有已成熟且未冻结的待结算账项')
  const total=lines.reduce((n,l)=>n+Number(l.amount),0)
  const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_statements(tenant_id,store_id,promoter_id,account_id,amount_minor,cutoff_at,created_by) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6) RETURNING id`,[...this.scope,promoterId,accountId,total,employeeId])).rows[0]!
  for(const l of lines)await this.tx.query(`INSERT INTO mbox.channel_statement_lines(tenant_id,store_id,statement_id,ledger_id,amount_minor) VALUES($1,$2,$3,$4,$5)`,[...this.scope,row.id,l.id,l.amount])
  await this.event(row.id,'statement.created',`employee:${employeeId}`,{amountMinor:total,lineCount:lines.length},reason);return{...row,amountMinor:total}
 }
 private async familyBalance(id:string){
  return(await this.tx.query<{root_id:string;remaining:string;unknown:boolean;disputed:boolean}>(`SELECT root.id AS root_id,(root.amount_minor-COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p JOIN mbox.channel_statements sibling ON (sibling.tenant_id,sibling.store_id,sibling.id)=(p.tenant_id,p.store_id,p.statement_id) WHERE (sibling.tenant_id,sibling.store_id,COALESCE(sibling.source_statement_id,sibling.id))=(root.tenant_id,root.store_id,root.id) AND p.status='succeeded'),0))::text AS remaining,
   EXISTS(SELECT 1 FROM mbox.channel_payouts p JOIN mbox.channel_statements sibling ON (sibling.tenant_id,sibling.store_id,sibling.id)=(p.tenant_id,p.store_id,p.statement_id) WHERE (sibling.tenant_id,sibling.store_id,COALESCE(sibling.source_statement_id,sibling.id))=(root.tenant_id,root.store_id,root.id) AND p.status='unknown') AS unknown,EXISTS(SELECT 1 FROM mbox.channel_statements sibling WHERE (sibling.tenant_id,sibling.store_id,COALESCE(sibling.source_statement_id,sibling.id))=(root.tenant_id,root.store_id,root.id) AND sibling.status='disputed') AS disputed
   FROM mbox.channel_statements current JOIN mbox.channel_statements root ON (root.tenant_id,root.store_id,root.id)=(current.tenant_id,current.store_id,COALESCE(current.source_statement_id,current.id)) WHERE current.tenant_id=$1 AND current.store_id=$2 AND current.id=$3`,[...this.scope,id])).rows[0]!
 }
 async reissueAccount(id:string,accountId:string,employeeId:string,reason:string){
  const old=await this.lockedStatement(id),family=await this.familyBalance(id)
  const root=await this.lockedStatement(family.root_id)
  if(root.status!=='approved'||old.status==='cancelled'||accountId===old.account_id)throw new ChannelBusinessError('尾款续结须选择原已审批单及新的已核实收款账户')
  if(family.disputed)throw new ChannelBusinessError('关联结算单存在争议，先处理原争议再续结')
  if(family.unknown)throw new ChannelBusinessError('原付款状态不明，先查原回单后再换账户续结')
  if(Number(family.remaining)<=0)throw new ChannelBusinessError('原结算链已付清，没有可续结的尾款')
  const account=await this.tx.query(`SELECT a.id FROM mbox.channel_settlement_accounts a JOIN mbox.channel_promoters p ON (p.tenant_id,p.store_id,p.partner_id)=(a.tenant_id,a.store_id,a.partner_id) WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.id=$3 AND p.id=$4 AND p.status='active' AND a.verified_at IS NOT NULL AND a.revoked_at IS NULL`,[...this.scope,accountId,old.promoter_id]);if(!account.rows[0])throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  const duplicate=await this.tx.query(`SELECT s.id FROM mbox.channel_statements s WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.source_statement_id=$3 AND s.account_id=$4 AND s.status<>'cancelled' AND s.amount_minor>COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p WHERE (p.tenant_id,p.store_id,p.statement_id)=(s.tenant_id,s.store_id,s.id) AND p.status='succeeded'),0)`,[...this.scope,root.id,accountId]);if(duplicate.rows[0])throw new ChannelBusinessError('新账户已有未结尾款单，请恢复原续结单')
  await this.reconcilePromoter(old.promoter_id)
  const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_statements(tenant_id,store_id,promoter_id,account_id,amount_minor,cutoff_at,created_by,source_statement_id) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7) RETURNING id`,[...this.scope,old.promoter_id,accountId,family.remaining,employeeId,root.id])).rows[0]!
  await this.event(row.id,'statement.account-tail-created',`employee:${employeeId}`,{sourceStatementId:root.id,amountMinor:Number(family.remaining),accountId},reason)
  return{...row,sourceStatementId:root.id,amountMinor:Number(family.remaining)}
 }
 async respond(id:string,customerId:string,dispute:boolean,reason:string){
  await this.lock();const promoter=await new ChannelPartnerRepository(this.tx).authorize(customerId)
  if(!promoter.can_confirm_statement)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  const row=await this.tx.query(`UPDATE mbox.channel_statements SET status=$5,confirmed_by=$6 WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND promoter_id=$4 AND status IN('pending','confirmed') RETURNING id`,[...this.scope,id,promoter.id,dispute?'disputed':'confirmed',customerId])
  if(!row.rows[0])throw new ChannelDistributionError('VERSION_CONFLICT');await this.event(id,dispute?'statement.disputed':'statement.confirmed',`customer:${customerId}`,{},reason);return{id}
 }
 private async lockedStatement(id:string){
  await this.lock();const s=(await this.tx.query<{id:string;promoter_id:string;account_id:string;source_statement_id:string|null;status:string;created_by:string;amount_minor:string}>(`SELECT id,promoter_id,account_id,source_statement_id,status,created_by,amount_minor::text FROM mbox.channel_statements WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`,[...this.scope,id])).rows[0]
  if(!s)throw new ChannelDistributionError('NOT_FOUND',404);return s
 }
 private async validateCurrent(id:string,promoterId:string){
  await this.reconcilePromoter(promoterId)
  const current=await this.lockedStatement(id),sourceId=current.source_statement_id??id
  if((await this.familyBalance(id)).disputed)throw new ChannelBusinessError('关联结算单存在争议，不能审批或付款')
  if(current.source_statement_id&&(await this.lockedStatement(sourceId)).status!=='approved')throw new ChannelBusinessError('原结算单已失效，不能继续尾款付款')
  const invalid=(await this.tx.query(`SELECT l.id FROM mbox.channel_statement_lines x JOIN mbox.channel_ledger l ON (l.tenant_id,l.store_id,l.id)=(x.tenant_id,x.store_id,x.ledger_id)
   JOIN mbox.channel_financial_positions p ON (p.tenant_id,p.store_id,p.visit_id)=(l.tenant_id,l.store_id,l.visit_id)
   WHERE x.tenant_id=$1 AND x.store_id=$2 AND x.statement_id=$3 AND x.released_at IS NULL AND (p.frozen OR p.matures_at>clock_timestamp() OR EXISTS(
    SELECT 1 FROM mbox.channel_ledger newer WHERE (newer.tenant_id,newer.store_id,newer.visit_id)=(l.tenant_id,l.store_id,l.visit_id) AND newer.sequence>l.sequence
     AND NOT EXISTS(SELECT 1 FROM mbox.channel_statement_lines included JOIN mbox.channel_statements confirmed ON (confirmed.tenant_id,confirmed.store_id,confirmed.id)=(included.tenant_id,included.store_id,included.statement_id) WHERE included.tenant_id=newer.tenant_id AND included.store_id=newer.store_id AND (included.statement_id=x.statement_id OR confirmed.status='approved') AND included.ledger_id=newer.id AND included.released_at IS NULL))) LIMIT 1`,[...this.scope,sourceId])).rows
  if(invalid.length)throw new ChannelBusinessError('账项出现退款、冻结或新调整，请取消原结算单并重新核对确认')
  const a=await this.tx.query(`SELECT s.id FROM mbox.channel_statements s JOIN mbox.channel_settlement_accounts a ON (a.tenant_id,a.store_id,a.id)=(s.tenant_id,s.store_id,s.account_id) WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 AND a.verified_at IS NOT NULL AND a.revoked_at IS NULL`,[...this.scope,id]);if(!a.rows[0])throw new ChannelBusinessError('收款账户版本已变化，请重新出单确认')
 }
 async approve(id:string,employeeId:string,reason:string){
  const s=await this.lockedStatement(id);if(s.status!=='confirmed'||s.created_by===employeeId)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  await this.validateCurrent(id,s.promoter_id)
  await this.tx.query(`UPDATE mbox.channel_statements SET status='approved',approved_by=$4,approved_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id,employeeId]);await this.event(id,'statement.approved',`employee:${employeeId}`,{},reason);return{id}
 }
 async cancel(id:string,employeeId:string,reason:string){
  const s=await this.lockedStatement(id);if(s.status==='cancelled')return{id}
  const successors=await this.tx.query(`SELECT id FROM mbox.channel_statements WHERE tenant_id=$1 AND store_id=$2 AND source_statement_id=$3 AND status<>'cancelled' LIMIT 1`,[...this.scope,id]);if(successors.rows[0])throw new ChannelBusinessError('请先核对或取消关联尾款续结单')
  const used=await this.tx.query(`SELECT id FROM mbox.channel_payouts WHERE tenant_id=$1 AND store_id=$2 AND statement_id=$3 AND status IN('unknown','succeeded') LIMIT 1`,[...this.scope,id]);if(used.rows[0])throw new ChannelBusinessError('已有付款或待核付款，保留原单并追加后续调整，不能撤销占用')
  await this.tx.query(`UPDATE mbox.channel_statements SET status='cancelled' WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,id]);await this.tx.query(`UPDATE mbox.channel_statement_lines SET released_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND statement_id=$3 AND released_at IS NULL`,[...this.scope,id]);await this.event(id,'statement.cancelled',`employee:${employeeId}`,{},reason);return{id}
 }
 async startPayment(id:string,value:number,reference:string,employeeId:string,reason:string){
  const s=await this.lockedStatement(id);if(s.status!=='approved')throw new ChannelBusinessError('请先完成对方确认和独立审批')
  await this.validateCurrent(id,s.promoter_id)
  const family=await this.familyBalance(id)
  if(value>Number(family.remaining))throw new ChannelBusinessError('付款超过原结算单及全部续结单的合计未付额')
  const totals=(await this.tx.query<{due:string;balance:string;unknown:boolean}>(`SELECT
   s.amount_minor-COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p WHERE (p.tenant_id,p.store_id,p.statement_id)=(s.tenant_id,s.store_id,s.id) AND p.status='succeeded'),0) AS due,
   COALESCE((SELECT sum(l.commission_delta_minor) FROM mbox.channel_ledger l JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.batch_id) WHERE l.tenant_id=s.tenant_id AND l.store_id=s.store_id AND b.promoter_id=s.promoter_id),0)-COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p JOIN mbox.channel_statements x ON (x.tenant_id,x.store_id,x.id)=(p.tenant_id,p.store_id,p.statement_id) WHERE x.tenant_id=s.tenant_id AND x.store_id=s.store_id AND x.promoter_id=s.promoter_id AND p.status='succeeded'),0) AS balance,
   EXISTS(SELECT 1 FROM mbox.channel_payouts p JOIN mbox.channel_statements x ON (x.tenant_id,x.store_id,x.id)=(p.tenant_id,p.store_id,p.statement_id) WHERE x.tenant_id=s.tenant_id AND x.store_id=s.store_id AND x.promoter_id=s.promoter_id AND p.status='unknown') AS unknown
   FROM mbox.channel_statements s WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3`,[...this.scope,id])).rows[0]!
  if(totals.unknown)throw new ChannelBusinessError('该推荐人有状态不明的原付款，先查原回单，不得重复付款')
  if(value<=0||value>Number(totals.due)||value>Number(totals.balance))throw new ChannelBusinessError('付款超过原单未付额或扣除退款后的净应付余额')
  const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_payouts(tenant_id,store_id,statement_id,amount_minor,attempt_reference,requested_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[...this.scope,id,amount(value),reference,employeeId])).rows[0]!
  await this.event(row.id,'payout.pending-verification',`employee:${employeeId}`,{statementId:id,amountMinor:value},reason);return row
 }
 private async assertReceiptUnique(reference:string){
  const used=await this.tx.query(`SELECT id FROM mbox.channel_payouts WHERE tenant_id=$1 AND store_id=$2 AND receipt_reference=$3 UNION ALL SELECT id FROM mbox.channel_payout_returns WHERE tenant_id=$1 AND store_id=$2 AND receipt_reference=$3`,[...this.scope,reference]);if(used.rows[0])throw new ChannelBusinessError('原银行流水已登记，请查原记录，不能重复入账')
 }
 async confirmPayment(id:string,success:boolean,receipt:string,employeeId:string,reason:string){
  await this.lock();await this.assertReceiptUnique(receipt)
  const row=await this.tx.query(`UPDATE mbox.channel_payouts SET status=$4,receipt_reference=$5,confirmed_by=$6,confirmed_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='unknown' AND requested_by<>$6 RETURNING id`,[...this.scope,id,success?'succeeded':'failed',receipt,employeeId]);if(!row.rows[0])throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  // This confirms an already happened bank fact, even if a later refund made
  // the balance negative. Never hide real money by refusing its confirmation.
  await this.event(id,success?'payout.succeeded':'payout.failed',`employee:${employeeId}`,{},reason);return{id}
 }
 async returnPayment(id:string,value:number,receipt:string,employeeId:string,reason:string){
  await this.lock();await this.assertReceiptUnique(receipt);const p=(await this.tx.query<{remaining:string}>(`SELECT p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0) AS remaining FROM mbox.channel_payouts p WHERE p.tenant_id=$1 AND p.store_id=$2 AND p.id=$3 AND p.status='succeeded' FOR UPDATE`,[...this.scope,id])).rows[0]
  if(!p||value<=0||value>Number(p.remaining))throw new ChannelBusinessError('退回金额超过原成功付款未退回金额')
  const row=(await this.tx.query<{id:string}>(`INSERT INTO mbox.channel_payout_returns(tenant_id,store_id,payout_id,amount_minor,receipt_reference,recorded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[...this.scope,id,amount(value),receipt,employeeId])).rows[0]!
  await this.event(row.id,'payout.returned',`employee:${employeeId}`,{payoutId:id,amountMinor:value},reason);return row
 }
 async statementDetail(id:string,promoterId?:string){
  const statement=(await this.tx.query(`SELECT s.id,s.promoter_id AS "promoterId",s.source_statement_id AS "sourceStatementId",s.amount_minor::text AS "amountMinor",s.status,a.subject AS "accountSubject",a.account_reference AS "accountReference" FROM mbox.channel_statements s JOIN mbox.channel_settlement_accounts a ON (a.tenant_id,a.store_id,a.id)=(s.tenant_id,s.store_id,s.account_id) WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 AND ($4::uuid IS NULL OR s.promoter_id=$4)`,[...this.scope,id,promoterId??null])).rows[0]
  if(!statement)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
  const lines=(await this.tx.query(`SELECT l.visit_id AS "visitId",x.amount_minor::text AS "deltaMinor",l.net_basis_minor::text AS "basisMinor",l.evidence,l.created_at::text AS "createdAt" FROM mbox.channel_statement_lines x JOIN mbox.channel_ledger l ON (l.tenant_id,l.store_id,l.id)=(x.tenant_id,x.store_id,x.ledger_id) WHERE x.tenant_id=$1 AND x.store_id=$2 AND x.statement_id=$3 ORDER BY l.sequence`,[...this.scope,statement.sourceStatementId??id])).rows
  return promoterId?channelPartnerStatementSchema.parse({statement,lines}):{statement,lines}
 }
 async overview(promoterId?:string){
  const args=[...this.scope,promoterId??null]
  const positions=(await this.tx.query(`SELECT p.visit_id AS "visitId",p.net_basis_minor::text AS "basisMinor",p.commission_minor::text AS "commissionMinor",p.frozen,p.reasons,p.matures_at::text AS "maturesAt",p.checked_at::text AS "checkedAt",clock_timestamp()-p.checked_at>interval '60 seconds' AS stale,b.promoter_id AS "promoterId" FROM mbox.channel_financial_positions p JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(p.tenant_id,p.store_id,p.batch_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND ($3::uuid IS NULL OR b.promoter_id=$3) ORDER BY p.checked_at DESC LIMIT 500`,args)).rows
  const statements=(await this.tx.query(`SELECT s.id,s.source_statement_id AS "sourceStatementId",s.promoter_id AS "promoterId",s.amount_minor::text AS "amountMinor",s.status,s.created_at::text AS "createdAt",s.account_id AS "accountId",COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p WHERE (p.tenant_id,p.store_id,p.statement_id)=(s.tenant_id,s.store_id,s.id) AND p.status='succeeded'),0)::text AS "paidMinor" FROM mbox.channel_statements s WHERE s.tenant_id=$1 AND s.store_id=$2 AND ($3::uuid IS NULL OR s.promoter_id=$3) ORDER BY s.created_at DESC LIMIT 500`,args)).rows
  const ledger=(await this.tx.query(`SELECT l.id,l.visit_id AS "visitId",l.net_basis_minor::text AS "basisMinor",l.commission_delta_minor::text AS "deltaMinor",l.created_at::text AS "createdAt",b.promoter_id AS "promoterId" FROM mbox.channel_ledger l JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.batch_id) WHERE l.tenant_id=$1 AND l.store_id=$2 AND ($3::uuid IS NULL OR b.promoter_id=$3) ORDER BY l.sequence DESC LIMIT 500`,args)).rows
  const payouts=(await this.tx.query(`SELECT p.id,p.statement_id AS "statementId",p.amount_minor::text AS "amountMinor",p.status,p.attempt_reference AS "attemptReference",p.receipt_reference AS "receiptReference",COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)::text AS "returnedMinor" FROM mbox.channel_payouts p JOIN mbox.channel_statements s ON (s.tenant_id,s.store_id,s.id)=(p.tenant_id,p.store_id,p.statement_id) WHERE p.tenant_id=$1 AND p.store_id=$2 AND ($3::uuid IS NULL OR s.promoter_id=$3) ORDER BY p.created_at DESC LIMIT 500`,args)).rows
  const balances=(await this.tx.query(`SELECT p.id AS "promoterId",COALESCE((SELECT sum(l.commission_delta_minor) FROM mbox.channel_ledger l JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(l.tenant_id,l.store_id,l.batch_id) WHERE b.tenant_id=p.tenant_id AND b.store_id=p.store_id AND b.promoter_id=p.id),0)::text AS "accruedMinor",COALESCE((SELECT sum(pay.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(pay.tenant_id,pay.store_id,pay.id)),0)) FROM mbox.channel_payouts pay JOIN mbox.channel_statements s ON (s.tenant_id,s.store_id,s.id)=(pay.tenant_id,pay.store_id,pay.statement_id) WHERE s.tenant_id=p.tenant_id AND s.store_id=p.store_id AND s.promoter_id=p.id AND pay.status='succeeded'),0)::text AS "paidMinor" FROM mbox.channel_promoters p WHERE p.tenant_id=$1 AND p.store_id=$2 AND ($3::uuid IS NULL OR p.id=$3)`,args)).rows.map(b=>({...b,balanceMinor:String(BigInt(String(b.accruedMinor))-BigInt(String(b.paidMinor)))}))
  return{positions,statements,ledger,payouts,balances,limit:500}
 }
}
