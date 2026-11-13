import { publicChannelRule } from './channel-public-view.js'
import { ChannelFinanceRepository } from './channel-finance-repository.js'
import { createHash, randomBytes } from 'node:crypto'
import { ChannelDistributionError } from './channel-distribution-policy.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import type { ScopedTransaction } from './transaction-runner.js'

export class ChannelPartnerRepository {
  private readonly args: [string, string]
  constructor(private readonly tx: ScopedTransaction) { this.args = [tx.scope.tenantId, tx.scope.storeId] }

  async authorize(customerId: string) {
    const customer = await new ChannelDistributionRepository(this.tx).verifiedCustomer(customerId)
    const rows = (await this.tx.query<{ id: string; partner_id: string; name: string; can_confirm_statement: boolean;restaurant_scope:boolean;contact_employee_id:string|null }>(`
      SELECT id,partner_id,name,can_confirm_statement,restaurant_scope,contact_employee_id FROM mbox.channel_promoters
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[]) AND status='active'`, [...this.args, customer.family])).rows
    // A merge linking two promoter accounts requires review, never implicit
    // access to whichever source happens to be returned first.
    if (rows.length !== 1) throw new ChannelDistributionError('NOT_AUTHORIZED', 403)
    return rows[0]!
  }

  async invite(promoterId: string, employeeId: string) {
    const row = (await this.tx.query<{ id: string; customer_id: string | null }>(`SELECT id,customer_id FROM mbox.channel_promoters WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' FOR UPDATE`, [...this.args, promoterId])).rows[0]
    if (!row || row.customer_id) throw new ChannelDistributionError('VERSION_CONFLICT')
    const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex')
    // Regenerating an invitation invalidates all prior unaccepted invitations.
    await this.tx.query(`UPDATE mbox.channel_invitations SET expires_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND promoter_id=$3 AND accepted_at IS NULL`, [...this.args, promoterId])
    const invitation = (await this.tx.query<{ id: string; expiresAt: string }>(`INSERT INTO mbox.channel_invitations(tenant_id,store_id,promoter_id,token_hash,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '72 hours') RETURNING id,expires_at::text AS "expiresAt"`, [...this.args, promoterId, hash])).rows[0]!
    await new ChannelDistributionRepository(this.tx).event(invitation.id, 'partner.invited', `employee:${employeeId}`, { promoterId })
    return { ...invitation, token }
  }

  async accept(token: string, customerId: string) {
    const repo = new ChannelDistributionRepository(this.tx)
    await repo.lockIdentity()
    const customer = await repo.verifiedCustomer(customerId), hash = createHash('sha256').update(token).digest('hex')
    const invitation = (await this.tx.query<{ id: string; promoter_id: string; accepted_customer_id: string | null; valid: boolean }>(`SELECT id,promoter_id,accepted_customer_id,expires_at>clock_timestamp() AS valid
      FROM mbox.channel_invitations WHERE tenant_id=$1 AND store_id=$2 AND token_hash=$3 FOR UPDATE`, [...this.args, hash])).rows[0]
    if (!invitation || !invitation.valid || invitation.accepted_customer_id) throw new ChannelDistributionError('NOT_AUTHORIZED', 403)
    const promoter = (await this.tx.query<{ customer_id: string | null; status: string }>(`SELECT customer_id,status FROM mbox.channel_promoters WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, [...this.args, invitation.promoter_id])).rows[0]
    if (!promoter || promoter.customer_id || promoter.status !== 'active') throw new ChannelDistributionError('VERSION_CONFLICT')
    const existing = await this.tx.query(`SELECT id FROM mbox.channel_promoters WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[])`, [...this.args, customer.family])
    if (existing.rows.length) throw new ChannelDistributionError('VERSION_CONFLICT')
    await this.tx.query(`UPDATE mbox.channel_promoters SET customer_id=$4 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, invitation.promoter_id, customer.id])
    await this.tx.query(`UPDATE mbox.channel_invitations SET accepted_customer_id=$4,accepted_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND id=$3`, [...this.args, invitation.id, customer.id])
    await repo.event(invitation.promoter_id, 'partner.accepted', `customer:${customer.id}`, { invitationId: invitation.id })
    return { promoterId: invitation.promoter_id }
  }

  async dashboard(customerId: string) {
    const promoter = await this.authorize(customerId)
    const batchPage=await this.historyFor(promoter.id,'batches')
    const visitPage=await this.historyFor(promoter.id,'visits')
    const statementPage=await this.historyFor(promoter.id,'statements')
    const batches=batchPage.items, visits=visitPage.items
    const restaurant=promoter.restaurant_scope?(await this.tx.query(`SELECT r.name,COUNT(DISTINCT v.id)::integer AS "visitCount",COALESCE(sum(f.commission_minor),0)::text AS "commissionMinor" FROM mbox.channel_promoters r LEFT JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.promoter_id)=(r.tenant_id,r.store_id,r.id) LEFT JOIN mbox.channel_visits v ON (v.tenant_id,v.store_id,v.source_batch_id)=(b.tenant_id,b.store_id,b.id) LEFT JOIN mbox.channel_financial_positions f ON (f.tenant_id,f.store_id,f.visit_id)=(v.tenant_id,v.store_id,v.id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.partner_id=$3 GROUP BY r.id,r.name ORDER BY r.name`,[...this.args,promoter.partner_id])).rows:null
    const contact=promoter.contact_employee_id?(await this.tx.query<{name:string}>(`SELECT display_name AS name FROM mbox.employees WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active'`,[...this.args,promoter.contact_employee_id])).rows[0]?.name:null
    const finance=await new ChannelFinanceRepository(this.tx).overview(promoter.id)
    return { promoter: { id: promoter.id, name: promoter.name,canConfirmStatement:promoter.can_confirm_statement }, batches, visits,contact,restaurant,
      finance:{positions:finance.positions,balances:finance.balances,statements:statementPage.items,limit:finance.limit},
      nextCursors:{batches:batchPage.nextCursor,visits:visitPage.nextCursor,statements:statementPage.nextCursor} }

  }

  async history(customerId:string,kind:'batches'|'visits'|'statements',cursor?:string,limit=30){
    const promoter=await this.authorize(customerId)
    return this.historyFor(promoter.id,kind,cursor,limit)
  }

  private async historyFor(promoterId:string,kind:'batches'|'visits'|'statements',cursor?:string,limit=30){
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Invalid page size')
    const args=[...this.args,promoterId]
    const specs={
      batches:{alias:'b',time:'created_at',from:'mbox.channel_batches b',where:'b.tenant_id=$1 AND b.store_id=$2 AND b.promoter_id=$3',select:`SELECT b.id,b.offer_code AS "offerCode",b.rule_snapshot AS rule,b.accepting_claims AS "acceptingClaims",
      (SELECT count(*)::integer FROM mbox.channel_claims q WHERE q.tenant_id=b.tenant_id AND q.store_id=b.store_id AND q.batch_id=b.id AND NOT q.voided) AS claims,
      (SELECT count(*)::integer FROM mbox.channel_visits v WHERE v.tenant_id=b.tenant_id AND v.store_id=b.store_id AND v.source_batch_id=b.id AND v.arrival_confirmed_at IS NOT NULL) AS arrivals
      FROM mbox.channel_batches b WHERE b.tenant_id=$1 AND b.store_id=$2 AND b.promoter_id=$3`},
      visits:{alias:'v',time:'opened_at',from:'mbox.channel_visits v JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(v.tenant_id,v.store_id,v.source_batch_id)',where:'v.tenant_id=$1 AND v.store_id=$2 AND b.promoter_id=$3',select:`SELECT v.id,right(v.id::text,8) AS "visitNumber",v.opened_at::text AS "boundAt",v.arrival_confirmed_at::text AS "arrivedAt",v.closed_at::text AS "closedAt",
      b.offer_code AS "offerCode",(SELECT count(*)::integer FROM mbox.channel_order_attributions o WHERE (o.tenant_id,o.store_id,o.visit_id)=(v.tenant_id,v.store_id,v.id)) AS "orderCount",
      (SELECT l.net_basis_minor::text FROM mbox.channel_financial_positions l WHERE (l.tenant_id,l.store_id,l.visit_id)=(v.tenant_id,v.store_id,v.id)) AS "qualifiedConsumptionMinor",
      (SELECT sum(l.commission_delta_minor)::text FROM mbox.channel_ledger l WHERE (l.tenant_id,l.store_id,l.visit_id)=(v.tenant_id,v.store_id,v.id)) AS "accruedCommissionMinor"
      FROM mbox.channel_visits v JOIN mbox.channel_batches b ON (b.tenant_id,b.store_id,b.id)=(v.tenant_id,v.store_id,v.source_batch_id)
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND b.promoter_id=$3`},
      statements:{alias:'s',time:'created_at',from:'mbox.channel_statements s',where:'s.tenant_id=$1 AND s.store_id=$2 AND s.promoter_id=$3',select:`SELECT s.id,s.source_statement_id AS "sourceStatementId",s.amount_minor::text AS "amountMinor",s.status,s.created_at::text AS "createdAt",
        COALESCE((SELECT sum(p.amount_minor-COALESCE((SELECT sum(r.amount_minor) FROM mbox.channel_payout_returns r WHERE (r.tenant_id,r.store_id,r.payout_id)=(p.tenant_id,p.store_id,p.id)),0)) FROM mbox.channel_payouts p WHERE (p.tenant_id,p.store_id,p.statement_id)=(s.tenant_id,s.store_id,s.id) AND p.status='succeeded'),0)::text AS "paidMinor"
        FROM mbox.channel_statements s WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.promoter_id=$3`},
    }
    const spec=specs[kind];let anchor:string|null=null
    if(cursor){
      const found=(await this.tx.query<{time:string}>(`SELECT ${spec.alias}.${spec.time}::text AS time FROM ${spec.from} WHERE ${spec.where} AND ${spec.alias}.id=$4`,[...args,cursor])).rows[0]
      if(!found)throw new ChannelDistributionError('NOT_AUTHORIZED',403)
      anchor=found.time
    }
    const rows=(await this.tx.query(`${spec.select} AND ($4::timestamptz IS NULL OR (${spec.alias}.${spec.time},${spec.alias}.id)<($4::timestamptz,$5::uuid)) ORDER BY ${spec.alias}.${spec.time} DESC,${spec.alias}.id DESC LIMIT $6`,[...args,anchor,cursor??null,limit+1])).rows
    const items=rows.slice(0,limit).map(row=>kind==='batches'?{...row,rule:publicChannelRule(row.rule)}:row)
    return {items,nextCursor:rows.length>limit?String(items[items.length-1]!.id):null}
  }

  async followup(input: { promoterId: string; batchId: string | null; employeeId: string | null; actorRef: string; kind: string; note: string; nextContactAt: string | null }) {
    if (input.batchId) {
      const match = await this.tx.query(`SELECT id FROM mbox.channel_batches WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND promoter_id=$4`, [...this.args, input.batchId, input.promoterId])
      if (!match.rows[0]) throw new ChannelDistributionError('OWNERSHIP', 403)
    }
    return (await this.tx.query(`INSERT INTO mbox.channel_followups(tenant_id,store_id,promoter_id,batch_id,employee_id,actor_ref,kind,note,next_contact_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [...this.args, input.promoterId, input.batchId, input.employeeId, input.actorRef, input.kind, input.note, input.nextContactAt])).rows[0]!
  }
}
