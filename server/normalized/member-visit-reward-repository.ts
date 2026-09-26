import type { ScopedTransaction } from './transaction-runner.js'
import { resolveMemberScanCustomer } from './member-participation-query.js'
import { CustomerRepository } from './customer-repository.js'
import { MemberGiftCampaignRepository } from './member-gift-campaign-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { appendAuditEvent } from './command-executor.js'
import type { MemberVisitRewardRequest, MemberVisitRewardRule, MemberVisitRewardProgress } from '../../src/shared/member-visit-reward.js'

export class MemberVisitRewardError extends Error {}
type Rule = { id: string; campaign_version_id: string; required_visits: number; status: string; created_at: string }
type Request = { id: string; rule_id: string; customer_id: string; status: string }
export class MemberVisitRewardRepository {
  constructor(private readonly tx: ScopedTransaction) {}
  private get scope() { return [this.tx.scope.tenantId, this.tx.scope.storeId] }
  private async audit(action: string, id: string, employeeId: string, businessDate: string, reason: string) {
    await appendAuditEvent(this.tx, { actor: { type: 'employee', employeeId }, businessDate, action: `member.visit.reward.${action}`, objectType: 'member_visit_reward', objectId: id, reason })
  }
  private async lockIdentity() {
    const lock = await this.tx.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked', [`table-customer-movement:${this.scope.join(':')}`])
    if (!lock.rows[0]?.locked) throw new MemberVisitRewardError('客户身份正在同步，请稍后重试')
  }
  async lockCustomer(customerId: string) {
    await this.lockIdentity()
    const canonical = (await new CustomerRepository(this.tx).resolveCanonical(customerId)).id
    const row = (await this.tx.query<{status:string}>('SELECT status FROM mbox.customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE', [...this.scope, canonical])).rows[0]
    if (row?.status !== 'active') throw new MemberVisitRewardError('会员状态已变化，请重新查询')
    return canonical
  }
  async create(input: {campaignVersionId:string;requiredVisits:number;employeeId:string;businessDate:string;reason:string}) {
    await new StaffAccessRepository(this.tx).assertPermission(input.employeeId, 'loyalty.policy.publish')
    if (!Number.isInteger(input.requiredVisits) || input.requiredVisits < 1 || input.requiredVisits > 365) throw new MemberVisitRewardError('签到门槛为1至365次')
    const campaign = await new MemberGiftCampaignRepository(this.tx).find(input.campaignVersionId)
    if (campaign.status !== 'published' || campaign.rule.trigger !== 'targeted' || campaign.rule.pricingKind !== 'free' || campaign.rule.dessertProductId) throw new MemberVisitRewardError('请选择已发布的免费商品券活动；每人限一套的组合赠礼不能用于循环签到奖励')
    if (Date.parse(campaign.rule.availableUntil) <= Date.now()) throw new MemberVisitRewardError('赠券活动已结束')
    const result = await this.tx.query<{id:string}>(`INSERT INTO mbox.member_visit_reward_rules(tenant_id,store_id,campaign_version_id,campaign_code,required_visits,created_by_employee_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,store_id,campaign_code) DO NOTHING RETURNING id`, [...this.scope,campaign.id,campaign.code,input.requiredVisits,input.employeeId])
    if (!result.rows[0]) throw new MemberVisitRewardError('该活动编号已配置签到规则；不能重置累计次数，请核对原规则')
    await this.audit('configure',result.rows[0].id,input.employeeId,input.businessDate,input.reason)
    return {id:result.rows[0].id}
  }
  async stop(id:string, employeeId:string, businessDate:string, reason:string) {
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.policy.publish')
    const row = (await this.tx.query<{id:string}>(`UPDATE mbox.member_visit_reward_rules SET status='stopped' WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND status='active' RETURNING id`, [...this.scope,id])).rows[0]
    if (row) await this.audit('stop',id,employeeId,businessDate,reason)
    return {id,stopped:true}
  }
  async rules(): Promise<MemberVisitRewardRule[]> {
    return (await this.tx.query<MemberVisitRewardRule & Record<string,unknown>>(`SELECT r.id,v.name,r.required_visits,r.status,r.created_at::text,v.status AS campaign_status,v.available_until::text,v.quantity_per_customer AS quantity,
      (SELECT string_agg(p.name,'、' ORDER BY p.name) FROM mbox.member_gift_campaign_products cp JOIN mbox.products p ON p.tenant_id=cp.tenant_id AND p.store_id=cp.store_id AND p.id=cp.product_id WHERE cp.tenant_id=r.tenant_id AND cp.store_id=r.store_id AND cp.campaign_version_id=v.id) AS products
      FROM mbox.member_visit_reward_rules r JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=r.tenant_id AND v.store_id=r.store_id AND v.id=r.campaign_version_id
      WHERE r.tenant_id=$1 AND r.store_id=$2 ORDER BY r.created_at DESC LIMIT 200`, this.scope)).rows
  }
  // One canonical customer lock serializes scans, cancellations and decisions.
  // Counting dates, rather than record IDs, also prevents undo/re-check-in and
  // merged historical identities from creating additional stamps on the same day.
  private async available(rule:Rule, customerId:string) {
    return (await this.tx.query<{id:string;business_date:string}>(`SELECT DISTINCT ON(v.business_date) v.id,v.business_date::text
      FROM mbox.member_visit_checkins v JOIN mbox.member_gift_campaign_versions c ON c.tenant_id=v.tenant_id AND c.store_id=v.store_id AND c.id=$5
      WHERE v.tenant_id=$1 AND v.store_id=$2 AND mbox.canonical_customer_id(v.tenant_id,v.store_id,v.customer_id)=$3
      AND v.cancelled_at IS NULL AND v.checked_in_at >= $4::timestamptz AND v.checked_in_at >= c.available_from AND v.checked_in_at<c.available_until
      AND NOT EXISTS(SELECT 1 FROM mbox.member_visit_reward_sources s JOIN mbox.member_visit_reward_requests q ON q.tenant_id=s.tenant_id AND q.store_id=s.store_id AND q.id=s.request_id JOIN mbox.member_visit_checkins used ON used.tenant_id=s.tenant_id AND used.store_id=s.store_id AND used.id=s.visit_id
        WHERE q.tenant_id=v.tenant_id AND q.store_id=v.store_id AND q.rule_id=$6 AND q.status IN ('pending','issued','rejected') AND mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)=$3 AND used.business_date=v.business_date)
      ORDER BY v.business_date,v.checked_in_at,v.id`, [...this.scope,customerId,rule.created_at,rule.campaign_version_id,rule.id])).rows
  }
  async sync(customerId:string) {
    customerId = await this.lockCustomer(customerId)
    await this.tx.query(`UPDATE mbox.member_visit_reward_requests q SET status='invalid',decided_at=clock_timestamp(),decision_reason='原签到已撤回，剩余有效签到重新累计'
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)=$3 AND q.status='pending'
      AND EXISTS(SELECT 1 FROM mbox.member_visit_reward_sources s JOIN mbox.member_visit_checkins v ON v.tenant_id=s.tenant_id AND v.store_id=s.store_id AND v.id=s.visit_id WHERE s.tenant_id=q.tenant_id AND s.store_id=q.store_id AND s.request_id=q.id AND v.cancelled_at IS NOT NULL)`, [...this.scope,customerId])
    const rules = (await this.tx.query<Rule>(`SELECT r.* FROM mbox.member_visit_reward_rules r JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=r.tenant_id AND v.store_id=r.store_id AND v.id=r.campaign_version_id WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='active' AND v.status='published' AND v.available_from<=clock_timestamp() AND v.available_until>clock_timestamp() ORDER BY r.id`, this.scope)).rows
    for (const rule of rules) {
      const visits = await this.available(rule,customerId)
      for (let offset=0; offset+rule.required_visits<=visits.length; offset+=rule.required_visits) {
        const sources=visits.slice(offset,offset+rule.required_visits)
        const request=(await this.tx.query<{id:string}>(`INSERT INTO mbox.member_visit_reward_requests(tenant_id,store_id,rule_id,customer_id,earned_business_date) VALUES($1,$2,$3,$4,$5::date) RETURNING id`, [...this.scope,rule.id,customerId,sources.at(-1)!.business_date])).rows[0]!
        await this.tx.query(`INSERT INTO mbox.member_visit_reward_sources(tenant_id,store_id,request_id,visit_id) SELECT $1,$2,$3,unnest($4::uuid[])`, [...this.scope,request.id,sources.map(v=>v.id)])
      }
    }
  }
  async progressForMember(memberNo:string) { return this.progress((await resolveMemberScanCustomer(this.tx,memberNo)).id) }
  async progress(customerId:string):Promise<MemberVisitRewardProgress[]> {
    const rules=(await this.tx.query<Rule & {name:string}>(`SELECT r.*,v.name FROM mbox.member_visit_reward_rules r JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=r.tenant_id AND v.store_id=r.store_id AND v.id=r.campaign_version_id WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='active' AND v.status='published' AND v.available_until>clock_timestamp() ORDER BY r.id`,this.scope)).rows
    const result:MemberVisitRewardProgress[]=[]
    for(const rule of rules){
      const counts=(await this.tx.query<{pending:number;issued:number}>(`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='issued')::int AS issued FROM mbox.member_visit_reward_requests WHERE tenant_id=$1 AND store_id=$2 AND rule_id=$3 AND mbox.canonical_customer_id(tenant_id,store_id,customer_id)=$4`,[...this.scope,rule.id,customerId])).rows[0]!
      result.push({name:rule.name,requiredVisits:rule.required_visits,remainingVisits:Math.max(0,rule.required_visits-(await this.available(rule,customerId)).length),...counts})
    }
    return result
  }
  async list(date:string|null,status:string,cursor:string|null) {
    const rows=(await this.tx.query<MemberVisitRewardRequest & Record<string,unknown>>(`SELECT q.id,v.name,COALESCE((SELECT member_no FROM mbox.customer_memberships m WHERE m.tenant_id=q.tenant_id AND m.store_id=q.store_id AND mbox.canonical_customer_id(m.tenant_id,m.store_id,m.customer_id)=mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id) AND m.status='active' ORDER BY m.joined_at DESC,m.id LIMIT 1),'会员已停用') AS member_no,
      q.earned_business_date::text,r.required_visits,v.quantity_per_customer AS quantity,q.status,q.decision_reason,b.status AS benefit_status,COALESCE(b.quantity_redeemed,0)::int AS quantity_redeemed,
      (SELECT string_agg(p.name,'、' ORDER BY p.name) FROM mbox.member_gift_campaign_products cp JOIN mbox.products p ON p.tenant_id=cp.tenant_id AND p.store_id=cp.store_id AND p.id=cp.product_id WHERE cp.tenant_id=q.tenant_id AND cp.store_id=q.store_id AND cp.campaign_version_id=v.id) AS products,
      (SELECT count(*)::int FROM mbox.member_visit_reward_sources s JOIN mbox.member_visit_checkins a ON a.tenant_id=s.tenant_id AND a.store_id=s.store_id AND a.id=s.visit_id WHERE s.tenant_id=q.tenant_id AND s.store_id=q.store_id AND s.request_id=q.id AND a.cancelled_at IS NOT NULL) AS cancelled_sources,
      ARRAY(SELECT a.business_date::text FROM mbox.member_visit_reward_sources s JOIN mbox.member_visit_checkins a ON a.tenant_id=s.tenant_id AND a.store_id=s.store_id AND a.id=s.visit_id WHERE s.tenant_id=q.tenant_id AND s.store_id=q.store_id AND s.request_id=q.id ORDER BY a.business_date) AS visit_dates
      FROM mbox.member_visit_reward_requests q JOIN mbox.member_visit_reward_rules r ON r.tenant_id=q.tenant_id AND r.store_id=q.store_id AND r.id=q.rule_id JOIN mbox.member_gift_campaign_versions v ON v.tenant_id=r.tenant_id AND v.store_id=r.store_id AND v.id=r.campaign_version_id
      LEFT JOIN mbox.member_gift_delivery_jobs j ON j.tenant_id=q.tenant_id AND j.store_id=q.store_id AND j.id=q.job_id LEFT JOIN mbox.benefits b ON b.tenant_id=j.tenant_id AND b.store_id=j.store_id AND b.id=j.benefit_id
      WHERE q.tenant_id=$1 AND q.store_id=$2 AND ($3::date IS NULL OR q.earned_business_date=$3) AND ($4='all' OR q.status=$4) AND ($5::uuid IS NULL OR q.id>$5) ORDER BY q.id LIMIT 51`,[...this.scope,date,status,cursor])).rows
    return {items:rows.slice(0,50),nextCursor:rows.length>50?rows[49]!.id:null}
  }
  async decide(ids:string[],action:'approve'|'reject',employeeId:string,businessDate:string,reason:string) {
    await new StaffAccessRepository(this.tx).assertPermission(employeeId,'loyalty.configuration.approve')
    if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw new MemberVisitRewardError('每批选择1至50条不重复的待审批记录')
    const requests=(await this.tx.query<Request>(`SELECT * FROM mbox.member_visit_reward_requests WHERE tenant_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) ORDER BY customer_id,id`,[...this.scope,ids])).rows
    if(requests.length!==ids.length)throw new MemberVisitRewardError('审批记录不存在或不属于当前门店')
    // Stable lock order for overlapping batches, including merged identities.
    await this.lockIdentity()
    const canonicalIds:string[]=[]
    for(const q of requests)canonicalIds.push((await new CustomerRepository(this.tx).resolveCanonical(q.customer_id)).id)
    for(const id of [...new Set(canonicalIds)].sort())await this.lockCustomer(id)
    const results=[]
    for(const original of requests){
      const q=(await this.tx.query<Request>('SELECT * FROM mbox.member_visit_reward_requests WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',[...this.scope,original.id])).rows[0]!
      if(q.status!=='pending')throw new MemberVisitRewardError('所选记录状态已变化，请重新读取；本批未发放')
      const rule=(await this.tx.query<Rule>('SELECT * FROM mbox.member_visit_reward_rules WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR SHARE',[...this.scope,q.rule_id])).rows[0]!
      if(action==='approve'){
        if(rule.status!=='active')throw new MemberVisitRewardError('签到奖励已停用；本批未发放')
        const valid=(await this.tx.query<{n:number;conflict:boolean}>(`SELECT count(DISTINCT v.business_date)::int AS n,COALESCE(bool_or(EXISTS(SELECT 1 FROM mbox.member_visit_reward_sources s2 JOIN mbox.member_visit_reward_requests q2 ON q2.tenant_id=s2.tenant_id AND q2.store_id=s2.store_id AND q2.id=s2.request_id JOIN mbox.member_visit_checkins v2 ON v2.tenant_id=s2.tenant_id AND v2.store_id=s2.store_id AND v2.id=s2.visit_id WHERE q2.tenant_id=q.tenant_id AND q2.store_id=q.store_id AND q2.rule_id=q.rule_id AND q2.id<>q.id AND q2.status IN ('issued','rejected') AND mbox.canonical_customer_id(q2.tenant_id,q2.store_id,q2.customer_id)=mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id) AND v2.business_date=v.business_date)),false) AS conflict
          FROM mbox.member_visit_reward_requests q JOIN mbox.member_visit_reward_sources s ON s.tenant_id=q.tenant_id AND s.store_id=q.store_id AND s.request_id=q.id JOIN mbox.member_visit_checkins v ON v.tenant_id=s.tenant_id AND v.store_id=s.store_id AND v.id=s.visit_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND q.id=$3 AND v.cancelled_at IS NULL`,[...this.scope,q.id])).rows[0]!
        if(valid.n!==rule.required_visits||valid.conflict)throw new MemberVisitRewardError('签到已撤回或合并后重复计次，请驳回该申请并核对；本批未发放')
        const gifts=new MemberGiftCampaignRepository(this.tx)
        const job=await gifts.enqueue({versionId:rule.campaign_version_id,customerId:q.customer_id,cycleKey:`visit:${q.id}`})
        const delivery=await gifts.deliver(job.jobId)
        if(delivery.status!=='issued')throw new MemberVisitRewardError('资格、商品或预算检查未通过；本批审批全部回滚，仍待审批，请核对赠券活动后重试')
        await this.tx.query(`UPDATE mbox.member_visit_reward_requests SET status='issued',decided_at=clock_timestamp(),decided_by_employee_id=$4,decision_reason=$5,job_id=$6 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,q.id,employeeId,reason,job.jobId])
      }else await this.tx.query(`UPDATE mbox.member_visit_reward_requests SET status='rejected',decided_at=clock_timestamp(),decided_by_employee_id=$4,decision_reason=$5 WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[...this.scope,q.id,employeeId,reason])
      await this.audit(action,q.id,employeeId,businessDate,reason)
      results.push({id:q.id,status:action==='approve'?'issued':'rejected'})
    }
    return {items:results}
  }
}
