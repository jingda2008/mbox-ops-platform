import { releaseUnusedChannelDiscounts } from './channel-discount-release.js'
import { channelCouponViewSchema, publicChannelOffer, type ChannelWalletQuery } from './channel-public-view.js'
import { ChannelGiftInventory } from './channel-gift-inventory.js'
import { randomBytes, randomInt } from 'node:crypto'
import { channelRuleSchema, type ChannelRule } from '../../src/shared/channel-distribution.js'
import { CustomerRepository } from './customer-repository.js'
import { assertChannelActivation, assertChannelClaimCapacity, ChannelDistributionError } from './channel-distribution-policy.js'
import type { ScopedTransaction } from './transaction-runner.js'

interface Batch extends Record<string, unknown> {
  id: string; campaign_id: string; promoter_id: string; partner_id: string; rule_snapshot: ChannelRule
  accepting_claims: boolean; campaign_open: boolean; staff_entry_enabled: boolean; self_entry_enabled: boolean
  partner_status: string; promoter_status: string; claim_limit: number; capacity_limit: number; cost_limit_minor: string
}
interface Claim extends Record<string, unknown> { id: string; customer_id: string; batch_id: string; status: string; use_until_override: string | null }
export interface ChannelClaimResult { claimId: string; batchId: string; status: string; reused: boolean; activationId?: string; visitId?: string }

/** All writes use one scoped transaction. The movement lock is shared with
 * canonical-customer merges; the campaign row serializes N/K/budget decisions. */
export class ChannelDistributionRepository {
  private readonly args: [string, string]
  constructor(private readonly tx: ScopedTransaction) { this.args = [tx.scope.tenantId, tx.scope.storeId] }

  async lockIdentity(): Promise<void> {
    await this.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))`, this.args)
  }

  async verifiedCustomer(id: string): Promise<{ id: string; family: string[]; displayName: string | null }> {
    const customer = await new CustomerRepository(this.tx).resolveCanonical(id)
    const family = (await this.tx.query<{ id: string }>(`WITH RECURSIVE family AS (
      SELECT id FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3
      UNION SELECT c.id FROM mbox.customers c JOIN family f ON c.merged_into_customer_id=f.id
      WHERE c.tenant_id=$1 AND c.store_id=$2
    ) SELECT id FROM family`, [...this.args, customer.id])).rows.map(r => r.id)
    const verified = (await this.tx.query<{ ok: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM mbox.customer_identities WHERE tenant_id=$1 AND store_id=$2
      AND customer_id=ANY($3::uuid[]) AND identity_kind IN('wechat','member') AND status='active'
      UNION ALL SELECT 1 FROM mbox.customer_memberships WHERE tenant_id=$1 AND store_id=$2
      AND customer_id=ANY($3::uuid[]) AND status='active') AS ok`, [...this.args, family])).rows[0]?.ok
    if (customer.status !== 'active' || !verified) throw new ChannelDistributionError('AUTH_REQUIRED', 403)
    return { id: customer.id, family, displayName: customer.profile.displayName }
  }

  async batch(code: string, lock = false): Promise<Batch> {
    const row = (await this.tx.query<Batch>(`SELECT b.*,c.accepting_claims AS campaign_open,
      c.staff_entry_enabled,c.self_entry_enabled,c.claim_limit,c.capacity_limit,c.cost_limit_minor::text,
      p.status AS partner_status,r.status AS promoter_status
      FROM mbox.channel_batches b JOIN mbox.channel_campaigns c ON (c.tenant_id,c.store_id,c.id)=(b.tenant_id,b.store_id,b.campaign_id)
      JOIN mbox.channel_partners p ON (p.tenant_id,p.store_id,p.id)=(b.tenant_id,b.store_id,b.partner_id)
      JOIN mbox.channel_promoters r ON (r.tenant_id,r.store_id,r.id)=(b.tenant_id,b.store_id,b.promoter_id)
      WHERE b.tenant_id=$1 AND b.store_id=$2 AND (b.offer_code=$3 OR b.public_token=$3)
      ${lock ? 'FOR UPDATE OF c,b FOR SHARE OF p,r' : ''}`, [...this.args, code])).rows[0]
    if (!row) throw new ChannelDistributionError('NOT_FOUND', 404)
    row.rule_snapshot = channelRuleSchema.parse(row.rule_snapshot)
    return row
  }

  async now(): Promise<Date> {
    return new Date((await this.tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now)
  }

  async issue(code: string, customerId: string, entry: 'staff' | 'self', reuse = false, actorRef?: string): Promise<ChannelClaimResult> {
    await this.lockIdentity()
    const customer = await this.verifiedCustomer(customerId)
    const batch = await this.batch(code, true), rule = batch.rule_snapshot, now = await this.now()
    if (reuse) {
      const existing = (await this.tx.query<Claim>(`SELECT * FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2
        AND batch_id=$3 AND customer_id=ANY($4::uuid[]) AND status IN('available','active') AND NOT voided
        AND (status<>'available' OR COALESCE(use_until_override,$5::timestamptz)>$6::timestamptz)
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'available' THEN 1 ELSE 2 END,issued_at,id LIMIT 1 FOR UPDATE`,
      [...this.args, batch.id, customer.family, rule.useUntil, now.toISOString()])).rows[0]
      if (existing) return { claimId: existing.id, batchId: batch.id, status: existing.status, reused: true }
    }
    const counts = (await this.tx.query<{ issued: number; customer_issued: number; pool_issued: number; held: number; cost: string }>(`
      SELECT count(*) FILTER(WHERE q.batch_id=$3)::integer AS issued,
        count(*) FILTER(WHERE q.batch_id=$3 AND q.customer_id=ANY($4::uuid[]))::integer AS customer_issued,
        count(*)::integer AS pool_issued,
        count(*) FILTER(WHERE q.status IN('active','fulfilled') OR (q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>$6::timestamptz))::integer AS held,
        COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR (q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>$6::timestamptz)),0)::text AS cost
      FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND b.campaign_id=$5 AND NOT q.voided`,
    [...this.args, batch.id, customer.family, batch.campaign_id, now.toISOString()])).rows[0]!
    assertChannelClaimCapacity({ rule, issued: counts.issued, customerIssued: counts.customer_issued,
      poolRemaining: batch.claim_limit - counts.pool_issued, capacityRemaining: batch.capacity_limit - counts.held,
      paused: !batch.accepting_claims || !batch.campaign_open || batch.partner_status !== 'active' || batch.promoter_status !== 'active'
        || !(entry === 'staff' ? batch.staff_entry_enabled : batch.self_entry_enabled), now })
    const commitment = rule.offer.kind === 'gift' ? rule.offer.costMinor : rule.offer.kind === 'credit' ? rule.offer.amountMinor : rule.offer.maximumMinor
    if (BigInt(counts.cost) + BigInt(commitment) > BigInt(batch.cost_limit_minor)) throw new ChannelDistributionError('CAPACITY')
    await this.assertStoreCapacity(commitment)
    const row = (await this.tx.query<{ id: string }>(`INSERT INTO mbox.channel_claims
      (tenant_id,store_id,batch_id,customer_id,entry,cost_commitment_minor)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [...this.args, batch.id, customer.id, entry, commitment])).rows[0]!
    if(rule.offer.kind==='gift')await new ChannelGiftInventory(this.tx).reserve(row.id,rule.offer)
    await this.event(row.id, 'claim.issued', actorRef ?? `customer:${customer.id}`, { batchId: batch.id, customerId: customer.id, entry })
    return { claimId: row.id, batchId: batch.id, status: 'available', reused: false }
  }

  /** Preview is informational. activate/issue repeat all authority and quota
   * checks in the write transaction; no client-provided counts are trusted. */
  async staffPreview(code: string, customerId: string, tableSessionId: string) {
    const customer = await this.verifiedCustomer(customerId), batch = await this.batch(code)
    const present = await this.tx.query(`SELECT id FROM mbox.table_session_customer_participations
      WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND customer_id=ANY($4::uuid[]) AND left_at IS NULL`, [...this.args, tableSessionId, customer.family])
    if (!present.rows.length) throw new ChannelDistributionError('OWNERSHIP', 403)
    const claims = (await this.tx.query<{ id: string; status: string; currentTable: boolean; useUntil: string }>(`SELECT q.id,
      CASE WHEN q.status='available' AND COALESCE(q.use_until_override,$5::timestamptz)<=clock_timestamp() THEN 'expired' ELSE q.status END AS status,
      COALESCE(EXISTS(SELECT 1 FROM mbox.channel_activations a JOIN mbox.channel_visit_tables t
        ON (t.tenant_id,t.store_id,t.visit_id)=(a.tenant_id,a.store_id,a.visit_id) AND t.detached_at IS NULL
        WHERE a.tenant_id=q.tenant_id AND a.store_id=q.store_id AND a.claim_id=q.id AND a.status IN('active','fulfilled') AND t.table_session_id=$6),false) AS "currentTable",
      COALESCE(q.use_until_override,$5::timestamptz)::text AS "useUntil"
      FROM mbox.channel_claims q WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.batch_id=$3 AND q.customer_id=ANY($4::uuid[]) AND NOT q.voided
      ORDER BY q.issued_at,q.id LIMIT 101`, [...this.args, batch.id, customer.family, batch.rule_snapshot.useUntil, tableSessionId])).rows
    return { batchId: batch.id, rule: batch.rule_snapshot, claims: claims.slice(0, 100), hasMoreClaims: claims.length > 100 }
  }

  async selectClaim(code: string, claimId: string, customerId: string) {
    const batch = await this.batch(code), customer = await this.verifiedCustomer(customerId)
    const row = (await this.tx.query<Claim>(`SELECT * FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2
      AND id=$3 AND batch_id=$4 AND customer_id=ANY($5::uuid[]) AND NOT voided`, [...this.args, claimId, batch.id, customer.family])).rows[0]
    if (!row) throw new ChannelDistributionError('OWNERSHIP', 403)
    return { claimId: row.id, batchId: batch.id, status: row.status, reused: true }
  }

  async activate(claimId: string, customerId: string, tableSessionId: string, actorRef: string): Promise<ChannelClaimResult> {
    await this.lockIdentity()
    const customer = await this.verifiedCustomer(customerId)
    const session = (await this.tx.query<{ id: string }>(`SELECT id FROM mbox.table_sessions
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='open' FOR UPDATE`, [...this.args, tableSessionId])).rows[0]
    const present = (await this.tx.query<{ id: string }>(`SELECT id FROM mbox.table_session_customer_participations WHERE tenant_id=$1 AND store_id=$2
      AND table_session_id=$3 AND customer_id=ANY($4::uuid[]) AND left_at IS NULL`, [...this.args, tableSessionId, customer.family])).rows[0]
    if (!session || !present) throw new ChannelDistributionError('OWNERSHIP', 403)
    const claim = (await this.tx.query<Claim>(`SELECT * FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND NOT voided FOR UPDATE`, [...this.args, claimId])).rows[0]
    if (!claim || !customer.family.includes(claim.customer_id)) throw new ChannelDistributionError('OWNERSHIP', 403)
    const existing = (await this.tx.query<{ id: string; visit_id: string; table_session_id: string }>(`SELECT a.id,a.visit_id,t.table_session_id FROM mbox.channel_activations a
      JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(a.tenant_id,a.store_id,a.visit_id) AND t.detached_at IS NULL
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.claim_id=$3 AND a.status IN('active','fulfilled') AND t.table_session_id=$4`, [...this.args, claimId, tableSessionId])).rows[0]
    if (existing) {
      await this.confirmArrival(existing.visit_id, actorRef)
      return { claimId, batchId: claim.batch_id, status: claim.status, reused: true, activationId: existing.id, visitId: existing.visit_id }
    }
    if (claim.status !== 'available') throw new ChannelDistributionError('VERSION_CONFLICT')
    const code = (await this.tx.query<{ offer_code: string }>(`SELECT offer_code FROM mbox.channel_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, claim.batch_id])).rows[0]!.offer_code
    const batch = await this.batch(code), rule = { ...batch.rule_snapshot, useUntil: claim.use_until_override ?? batch.rule_snapshot.useUntil }
    let visit = (await this.tx.query<{ id: string; source_batch_id: string | null; locked_use_limit: number | null; promoter_id: string | null; campaign_id: string | null; stacking_allowed:boolean|null; discount_cap_minor:string|null }>(`
      SELECT v.id,v.source_batch_id,v.locked_use_limit,v.stacking_allowed,v.discount_cap_minor::text,b.promoter_id,b.campaign_id FROM mbox.channel_visit_tables t
      JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.id)=(t.tenant_id,t.store_id,t.visit_id)
      LEFT JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(v.tenant_id,v.store_id,v.source_batch_id)
      WHERE t.tenant_id=$1 AND t.store_id=$2 AND t.table_session_id=$3 AND t.detached_at IS NULL AND v.closed_at IS NULL FOR UPDATE OF v`, [...this.args, tableSessionId])).rows[0]
    if (!visit) {
      const recent=await this.tx.query(`SELECT v.id FROM mbox.channel_visits v JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(v.tenant_id,v.store_id,v.id)
        JOIN mbox.table_session_customer_participations p ON (p.tenant_id,p.store_id,p.table_session_id)=(t.tenant_id,t.store_id,t.table_session_id)
        WHERE v.tenant_id=$1 AND v.store_id=$2 AND v.source_batch_id IS NOT NULL AND v.closed_at>clock_timestamp()-interval '30 minutes' AND p.customer_id=ANY($3::uuid[])
        AND NOT EXISTS(SELECT 1 FROM mbox.channel_events e WHERE e.tenant_id=v.tenant_id AND e.store_id=v.store_id AND e.object_id=$4 AND e.event_type='visit.new-confirmed' AND e.payload->>'customerId'=$5::text) LIMIT 1`,[...this.args,customer.family,tableSessionId,customer.id])
      if(recent.rows[0])throw new ChannelDistributionError('CONTINUITY_REVIEW')
      // A missed first order needs a separate supervisor correction; never
      // silently claim pre-existing organic revenue.
      const ordered = (await this.tx.query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3 AND status NOT IN('draft','cancelled')) AS ok`, [...this.args, tableSessionId])).rows[0]!.ok
      if (ordered) throw new ChannelDistributionError('SOURCE_CONFLICT')
      const id = (await this.tx.query<{ id: string }>(`INSERT INTO mbox.channel_visits(tenant_id,store_id) VALUES($1,$2) RETURNING id`, this.args)).rows[0]!.id
      await this.tx.query(`INSERT INTO mbox.channel_visit_tables(tenant_id,store_id,visit_id,table_session_id) VALUES($1,$2,$3,$4)`, [...this.args, id, tableSessionId])
      visit = { id, source_batch_id: null, locked_use_limit: null, promoter_id: null, campaign_id: null, stacking_allowed:null, discount_cap_minor:null }
    }
    const count = (await this.tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM mbox.channel_activations WHERE tenant_id=$1 AND store_id=$2 AND visit_id=$3 AND status IN('active','fulfilled')`, [...this.args, visit.id])).rows[0]!.n
    assertChannelActivation({ rule, now: await this.now(), couponCustomerId: customer.id, verifiedCustomerId: customer.id,
      atCurrentVisit: true, usedAndHeld: count, lockedVisitLimit: visit.locked_use_limit,
      existingSource: visit.promoter_id, source: batch.promoter_id, existingCampaign: visit.campaign_id, campaign: batch.campaign_id })
    const allowStacking=visit.stacking_allowed===null?(visit.source_batch_id===null&&rule.allowStacking):visit.stacking_allowed&&rule.allowStacking
    if(count>0&&!allowStacking)throw new ChannelDistributionError('STACKING_DISABLED')
    const caps=[visit.discount_cap_minor===null?null:Number(visit.discount_cap_minor),rule.visitDiscountCapMinor].filter((n):n is number=>n!==null)
    const cap=caps.length?Math.min(...caps):null
    await releaseUnusedChannelDiscounts(this.tx,visit.id)
    const used=(await this.tx.query<{amount:string}>(`SELECT COALESCE(sum(applied_discount_minor),0)::text AS amount FROM mbox.channel_activations WHERE tenant_id=$1 AND store_id=$2 AND visit_id=$3`,[...this.args,visit.id])).rows[0]!.amount
    if(cap!==null&&BigInt(used)>=BigInt(cap))throw new ChannelDistributionError('DISCOUNT_CAP')
    await this.tx.query(`UPDATE mbox.channel_visits SET source_batch_id=COALESCE(source_batch_id,$4),
      source_review_required=source_review_required OR EXISTS(SELECT 1 FROM mbox.channel_visit_tables t JOIN mbox.reservation_seating_sessions r ON (r.tenant_id,r.store_id,r.table_session_id)=(t.tenant_id,t.store_id,t.table_session_id) WHERE (t.tenant_id,t.store_id,t.visit_id)=(channel_visits.tenant_id,channel_visits.store_id,channel_visits.id)),
      stacking_allowed=$6,discount_cap_minor=$7,locked_use_limit=LEAST(COALESCE(locked_use_limit,$5),$5),version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, visit.id, batch.id, rule.perVisitUses,allowStacking,cap])
    const activation = (await this.tx.query<{ id: string }>(`INSERT INTO mbox.channel_activations(tenant_id,store_id,claim_id,visit_id,table_session_id) VALUES($1,$2,$3,$4,$5) RETURNING id`, [...this.args, claimId, visit.id, tableSessionId])).rows[0]!
    await this.tx.query(`UPDATE mbox.channel_claims SET status='active',version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, claimId])
    await this.event(claimId, 'claim.activated', actorRef, { visitId: visit.id, tableSessionId, activationId: activation.id })
    await this.confirmArrival(visit.id, actorRef)
    return { claimId, batchId: batch.id, status: 'active', reused: false, activationId: activation.id, visitId: visit.id }
  }

  private async confirmArrival(visitId: string, actorRef: string) {
    const employee = /^employee:([0-9a-f-]{36})$/i.exec(actorRef)?.[1]
    if (!employee) return // A static table QR/session is not physical-arrival proof.
    const row = (await this.tx.query<{ id: string }>(`UPDATE mbox.channel_visits SET arrival_confirmed_at=clock_timestamp(),arrival_confirmed_by_employee_id=$4,version=version+1
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND arrival_confirmed_at IS NULL AND closed_at IS NULL RETURNING id`, [...this.args, visitId, employee])).rows[0]
    if (row) await this.event(visitId, 'visit.arrival_confirmed', actorRef, { evidence: 'staff_present_customer_confirmation' })
  }

  async wallet(customerId: string) { return (await this.walletPage(customerId, {limit:100})).items }

  async walletPage(customerId: string, options: ChannelWalletQuery = {}) {
    const customer=await this.verifiedCustomer(customerId), limit=options.limit??30
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid page size')
    const batchId=options.code?(await this.batch(options.code)).id:null
    let anchor: {issuedAt:string}|undefined
    if(options.cursor){
      anchor=(await this.tx.query<{issuedAt:string}>(`SELECT issued_at::text AS "issuedAt" FROM mbox.channel_claims
        WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[]) AND id=$4 AND ($5::uuid IS NULL OR batch_id=$5)`,
      [...this.args,customer.family,options.cursor,batchId])).rows[0]
      if(!anchor)throw new ChannelDistributionError('NOT_FOUND',404)
    }
    const rows=(await this.tx.query(`SELECT q.id,q.batch_id AS "batchId",b.offer_code AS "offerCode",b.rule_snapshot->>'title' AS title,
      CASE WHEN q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)<=clock_timestamp() THEN 'expired' ELSE q.status END AS status,
      COALESCE((SELECT v.snapshot->'offer' FROM mbox.channel_gift_versions v WHERE (v.tenant_id,v.store_id,v.claim_id)=(q.tenant_id,q.store_id,q.id) ORDER BY generation DESC LIMIT 1),b.rule_snapshot->'offer') AS offer,b.rule_snapshot->>'useFrom' AS "useFrom",COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)::text AS "useUntil",p.name AS "sourceLabel"
      ,(b.rule_snapshot->>'minimumMinor')::integer AS "minimumMinor",(b.rule_snapshot->>'perCustomerClaims')::integer AS "perCustomerClaims",(b.rule_snapshot->>'perVisitUses')::integer AS "perVisitUses"
      ,COALESCE((b.rule_snapshot->>'allowStacking')::boolean,false) AS "allowStacking",(b.rule_snapshot->>'visitDiscountCapMinor')::integer AS "visitDiscountCapMinor"
      ,b.rule_snapshot->'eligibleProductNames' AS "eligibleProducts"
      FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
      JOIN mbox.channel_partners p ON (p.tenant_id,p.store_id,p.id)=(b.tenant_id,b.store_id,b.partner_id)
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.customer_id=ANY($3::uuid[]) AND NOT q.voided AND ($4::uuid IS NULL OR q.batch_id=$4) AND ($5::uuid IS NULL OR q.id=$5)
      AND ($6::text='all' OR (CASE WHEN q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)<=clock_timestamp() THEN 'expired' ELSE q.status END)=$6)
      AND ($7::timestamptz IS NULL OR (q.issued_at,q.id)<($7::timestamptz,$8::uuid))
      ORDER BY q.issued_at DESC,q.id DESC LIMIT $9`, [...this.args,customer.family,batchId,options.claimId??null,options.status??'all',anchor?.issuedAt??null,options.cursor??null,limit+1])).rows
    const items=rows.slice(0,limit).map(row=>channelCouponViewSchema.parse(row))
    return {items,nextCursor:rows.length>limit?items[items.length-1]!.id:null}
  }

  /** Read-only landing page. Never reserves stock, consumes N/K, or establishes arrival. */
  async customerOffer(code: string, customerId: string) {
    const customer = await this.verifiedCustomer(customerId), batch = await this.batch(code), rule = batch.rule_snapshot
    const now = await this.now()
    const counts = (await this.tx.query<{ issued: number; own: number; pool: number; held: number; cost: string }>(`SELECT
      count(*) FILTER(WHERE q.batch_id=$3)::integer AS issued,
      count(*) FILTER(WHERE q.batch_id=$3 AND q.customer_id=ANY($4::uuid[]))::integer AS own,
      count(*)::integer AS pool,
      count(*) FILTER(WHERE q.status IN('active','fulfilled') OR (q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>$6))::integer AS held,
      COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>$6)),0)::text AS cost
      FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND b.campaign_id=$5 AND NOT q.voided`,
    [...this.args,batch.id,customer.family,batch.campaign_id,now.toISOString()])).rows[0]!
    let unavailable: string | null = null
    try { assertChannelClaimCapacity({ rule, issued: counts.issued, customerIssued: counts.own,
      poolRemaining: batch.claim_limit-counts.pool, capacityRemaining: batch.capacity_limit-counts.held, now,
      paused: !batch.accepting_claims || !batch.campaign_open || !batch.self_entry_enabled || batch.partner_status!=='active' || batch.promoter_status!=='active' })
      const commitment=rule.offer.kind==='gift'?rule.offer.costMinor:rule.offer.kind==='credit'?rule.offer.amountMinor:rule.offer.maximumMinor
      if(BigInt(counts.cost)+BigInt(commitment)>BigInt(batch.cost_limit_minor))throw new ChannelDistributionError('CAPACITY')
      await this.assertStoreCapacity(commitment,null,true)
    }
    catch(error) { if (!(error instanceof ChannelDistributionError)) throw error; unavailable=error.message }
    const source = (await this.tx.query<{ name: string }>('SELECT name FROM mbox.channel_partners WHERE tenant_id=$1 AND store_id=$2 AND id=$3',[...this.args,batch.partner_id])).rows[0]!.name
    const existing = (await this.tx.query<{ id: string }>(`SELECT id FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2 AND batch_id=$3
      AND customer_id=ANY($4::uuid[]) AND NOT voided AND status IN('available','active','fulfilled')
      AND (status<>'available' OR COALESCE(use_until_override,$5::timestamptz)>$6) ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,issued_at DESC,id DESC LIMIT 1`,
    [...this.args,batch.id,customer.family,rule.useUntil,now.toISOString()])).rows[0]?.id ?? null
    // Consumer DTO deliberately omits commission, settlement subjects and gift cost.
    const offer = publicChannelOffer(rule.offer)
    const existingCoupon=existing?(await this.walletPage(customer.id,{claimId:existing,limit:1})).items[0]??null:null
    return { batchId: batch.id, offerCode: batch.offer_code, title:rule.title, sourceLabel:source, offer,
      minimumMinor:rule.minimumMinor, perCustomerClaims:rule.perCustomerClaims, perVisitUses:rule.perVisitUses, allowStacking:rule.allowStacking,visitDiscountCapMinor:rule.visitDiscountCapMinor,
      claimFrom:rule.claimFrom, claimUntil:rule.claimUntil, useFrom:rule.useFrom, useUntil:rule.useUntil,
      eligibleProducts:rule.eligibleProductNames ?? [], claimedCount:counts.own, existingClaimId:existing, existingCoupon, unavailable }
  }

  async cancelActivation(activationId: string, tableSessionId: string, employeeId: string, reason: string) {
    await this.lockIdentity()
    const row = (await this.tx.query<{ claim_id: string; visit_id: string; status: string; applied_discount_minor: string; until: string }>(`
      SELECT a.claim_id,a.visit_id,a.status,a.applied_discount_minor::text,COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)::text AS until
      FROM mbox.channel_activations a JOIN mbox.channel_claims q ON (q.tenant_id,q.store_id,q.id)=(a.tenant_id,a.store_id,a.claim_id)
      JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
      JOIN mbox.channel_visit_tables t ON (t.tenant_id,t.store_id,t.visit_id)=(a.tenant_id,a.store_id,a.visit_id)
      WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.id=$3 AND t.table_session_id=$4 AND t.detached_at IS NULL
      FOR UPDATE OF a,q`, [...this.args, activationId, tableSessionId])).rows[0]
    if (!row) throw new ChannelDistributionError('NOT_FOUND', 404)
    if (row.status === 'cancelled') return { activationId, status: 'cancelled' }
    await releaseUnusedChannelDiscounts(this.tx,row.visit_id)
    const current=(await this.tx.query<{applied_discount_minor:string}>(`SELECT applied_discount_minor::text FROM mbox.channel_activations WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.args,activationId])).rows[0]!
    if (row.status !== 'active' || BigInt(current.applied_discount_minor) !== 0n) throw new ChannelDistributionError('NOT_REVERSIBLE')
    // Actual applied benefits block cancellation; ordinary orders do not.
    // Their immutable referral remains after switching to another promotion.
    const available = Date.parse(row.until) > (await this.now()).getTime()
    await this.tx.query(`UPDATE mbox.channel_activations SET status='cancelled',cancelled_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, activationId])
    await this.tx.query(`UPDATE mbox.channel_claims SET status=$4,version=version+1 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, row.claim_id, available ? 'available' : 'expired'])
    if(!available)await new ChannelGiftInventory(this.tx).release(row.claim_id)
    // Source attribution deliberately survives an unused offer cancellation.
    await this.event(row.claim_id, 'activation.cancelled', `employee:${employeeId}`, { activationId, visitId: row.visit_id }, reason)
    return { activationId, status: 'cancelled' }
  }

  async createBatch(input: { campaignId: string; promoterId: string; rule: ChannelRule; contract: Record<string, unknown> }) {
    await this.lockIdentity()
    const rule = channelRuleSchema.parse(input.rule)
    const productIds = [...new Set([...rule.eligibleProductIds,...(rule.commissionProductIds??[]), ...(rule.offer.kind === 'gift' ? [rule.offer.productId] : [])])]
    const products = await this.tx.query<{ id: string; name: string; cost_amount_minor:string|null;product_kind:string }>(`SELECT id,name,cost_amount_minor::text,product_kind FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND status='active' ORDER BY id FOR SHARE`, [...this.args, productIds])
    if (products.rows.length !== productIds.length) throw new ChannelDistributionError('NOT_FOUND', 404)
    rule.eligibleProductNames = products.rows.filter(p => rule.eligibleProductIds.includes(p.id)).map(({id,name})=>({id,name}))
    if (rule.offer.kind === 'gift') {
      const giftId = rule.offer.productId
      const product=products.rows.find(p => p.id === giftId)!
      if(product.cost_amount_minor===null||product.product_kind!=='single')throw new ChannelDistributionError('CAPACITY')
      rule.offer.productName=product.name
      rule.offer.costMinor=Number(product.cost_amount_minor)*rule.offer.quantity
    }
    channelRuleSchema.parse(rule)
    const promoter = (await this.tx.query<{ partner_id: string }>(`SELECT partner_id FROM mbox.channel_promoters WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' FOR SHARE`, [...this.args, input.promoterId])).rows[0]
    if (!promoter) throw new ChannelDistributionError('NOT_FOUND', 404)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const offerCode = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('')
    return (await this.tx.query(`INSERT INTO mbox.channel_batches(tenant_id,store_id,campaign_id,partner_id,promoter_id,offer_code,public_token,rule_snapshot,contract_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING id,offer_code AS "offerCode",public_token AS "publicToken"`,
    [...this.args, input.campaignId, promoter.partner_id, input.promoterId, offerCode, randomBytes(32).toString('base64url'), JSON.stringify(rule), JSON.stringify(input.contract)])).rows[0]!
  }

  async assertStoreCapacity(commitment:number,excludeClaimId:string|null=null,readOnly=false){
    const limits=(await this.tx.query<{claim_limit:number;capacity_limit:number;cost_limit_minor:string}>(`SELECT claim_limit,capacity_limit,cost_limit_minor::text FROM mbox.channel_store_limits WHERE tenant_id=$1 AND store_id=$2 ${readOnly?'':'FOR UPDATE'}`,this.args)).rows[0]
    if(!limits)throw new ChannelDistributionError('CAPACITY')
    const counts=(await this.tx.query<{issued:number;held:number;cost:string}>(`SELECT count(*)::integer AS issued,
      count(*) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp()))::integer AS held,
      COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())),0)::text AS cost
      FROM mbox.channel_claims q JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(q.tenant_id,q.store_id,q.batch_id)
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND NOT q.voided AND ($3::uuid IS NULL OR q.id<>$3)`,[...this.args,excludeClaimId])).rows[0]!
    if((!excludeClaimId&&counts.issued>=limits.claim_limit)||counts.held>=limits.capacity_limit||BigInt(counts.cost)+BigInt(commitment)>BigInt(limits.cost_limit_minor))throw new ChannelDistributionError('CAPACITY')
  }

  async event(id: string, type: string, actor: string, payload: Record<string, unknown>, reason = type) {
    await this.tx.query(`INSERT INTO mbox.channel_events(tenant_id,store_id,object_id,event_type,actor_ref,reason,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [...this.args, id, type, actor, reason, JSON.stringify(payload)])
  }
}
