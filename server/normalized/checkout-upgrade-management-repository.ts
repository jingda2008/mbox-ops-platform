import type { ScopedTransaction } from './transaction-runner.js'
import { CustomerExperienceRequestError } from './customer-experience-repository.js'

export type CheckoutUpgradeRuleStatus = 'draft' | 'approved' | 'active' | 'paused' | 'retired'
export type CapacityPolicyStatus = 'draft' | 'approved' | 'published' | 'retired'

export interface CheckoutUpgradeRuleAdminView {
  id: string
  code: string
  revision: number
  name: string
  status: CheckoutUpgradeRuleStatus
  sourceProductId: string
  sourceProductName: string
  targetProductId: string
  targetProductName: string
  minimumPartySize: number
  maximumPartySize: number
  occasionTags: string[]
  alcoholPreferenceTags: string[]
  promptTitle: string
  promptBody: string
  callToAction: string
  priority: number
  offerValidMinutes: number
  minimumGrossMarginBasisPoints: number
  draftedByEmployeeId: string | null
  approvedByEmployeeId: string | null
  publishedByEmployeeId: string | null
  validFrom: string | null
  validUntil: string | null
  publicationMode: string
  createdAt: string
}

export interface CheckoutUpgradeOutcomeView {
  offerPublicId: string
  ruleCode: string
  ruleRevision: number
  status: string
  sourceProductName: string
  targetProductName: string
  amountToAddMinor: number
  currency: string
  offeredAt: string
  convertedOrderPublicId: string | null
  paymentState: 'not_created' | 'pending' | 'paid' | 'failed_or_closed'
  paidAmountMinor: number
  refundedAmountMinor: number
  complaintCount: number
  eventCounts: Record<'viewed' | 'declined' | 'accepted' | 'converted' | 'invalidated', number>
}

export interface CapacityWindowView {
  id: string
  startsAt: string
  endsAt: string
  capacityLimitUnits: number
  usedUnits: number
}

export interface CapacityPolicyView {
  id: string
  stationCode: 'bar' | 'kitchen' | 'cashier'
  policyVersion: number
  status: CapacityPolicyStatus
  draftedByEmployeeId: string | null
  approvedByEmployeeId: string | null
  publishedByEmployeeId: string | null
  publishedAt: string | null
  retiredAt: string | null
  publicationMode: string
  reason: string
  windows: CapacityWindowView[]
}

interface RuleRow extends Record<string, unknown> {
  id: string
  code: string
  revision: number
  name: string
  status: CheckoutUpgradeRuleStatus
  source_product_id: string
  source_product_name: string
  target_product_id: string
  target_product_name: string
  minimum_party_size: number
  maximum_party_size: number
  occasion_tags: string[]
  alcohol_preference_tags: string[]
  prompt_title: string
  prompt_body: string
  call_to_action: string
  priority: number
  offer_valid_minutes: number
  minimum_gross_margin_basis_points: number
  drafted_by_employee_id: string | null
  approved_by_employee_id: string | null
  published_by_employee_id: string | null
  valid_from: string | null
  valid_until: string | null
  publication_mode: string
  created_at: string
}

interface CapacityRow extends Record<string, unknown> {
  id: string
  station_code: CapacityPolicyView['stationCode']
  policy_version: number
  status: CapacityPolicyStatus
  drafted_by_employee_id: string | null
  approved_by_employee_id: string | null
  published_by_employee_id: string | null
  published_at: string | null
  retired_at: string | null
  publication_mode: string
  reason: string
  windows: unknown
}

export class CheckoutUpgradeManagementRepository {
  constructor(private readonly transaction: ScopedTransaction) {}

  async listRules(): Promise<CheckoutUpgradeRuleAdminView[]> {
    const result = await this.transaction.query<RuleRow>(`
      SELECT rule.id,rule.code,rule.revision,rule.name,rule.status,
        rule.source_product_id,source.name AS source_product_name,
        rule.target_product_id,target.name AS target_product_name,
        rule.minimum_party_size,rule.maximum_party_size,rule.occasion_tags,
        rule.alcohol_preference_tags,rule.prompt_title,rule.prompt_body,
        rule.call_to_action,rule.priority,rule.offer_valid_minutes,
        rule.minimum_gross_margin_basis_points,rule.drafted_by_employee_id,
        rule.approved_by_employee_id,rule.published_by_employee_id,
        rule.valid_from::text,rule.valid_until::text,rule.publication_mode,
        rule.created_at::text
      FROM mbox.checkout_upgrade_rules rule
      JOIN mbox.products source ON source.tenant_id=rule.tenant_id
        AND source.store_id=rule.store_id AND source.id=rule.source_product_id
      JOIN mbox.products target ON target.tenant_id=rule.tenant_id
        AND target.store_id=rule.store_id AND target.id=rule.target_product_id
      WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid
      ORDER BY rule.code,rule.revision DESC,rule.id
      LIMIT 300
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId])
    return result.rows.map(ruleView)
  }

  async insertRuleDraft(input: Readonly<{
    code: string
    name: string
    sourceProductId: string
    targetProductId: string
    minimumPartySize: number
    maximumPartySize: number
    occasionTags: string[]
    alcoholPreferenceTags: string[]
    promptTitle: string
    promptBody: string
    callToAction: string
    priority: number
    offerValidMinutes: number
    minimumGrossMarginBasisPoints: number
    employeeId: string
  }>): Promise<CheckoutUpgradeRuleAdminView> {
    await this.transaction.query(`
      SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2||':'||$3,0))
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.code])
    const inserted = await this.transaction.query<RuleRow>(`
      WITH next_revision AS (
        SELECT COALESCE(MAX(revision),0)+1 AS revision
        FROM mbox.checkout_upgrade_rules
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
      ), created AS (
        INSERT INTO mbox.checkout_upgrade_rules(
          tenant_id,store_id,code,revision,name,source_product_id,target_product_id,
          minimum_party_size,maximum_party_size,occasion_tags,alcohol_preference_tags,
          prompt_title,prompt_body,call_to_action,priority,offer_valid_minutes,
          minimum_gross_margin_basis_points,status,drafted_by_employee_id,configuration,
          publication_mode
        ) SELECT $1::uuid,$2::uuid,$3,next_revision.revision,$4,$5::uuid,$6::uuid,
          $7,$8,$9::text[],$10::text[],$11,$12,$13,$14,$15,$16,
          'draft',$17::uuid,'{}'::jsonb,'separated'
        FROM next_revision
        RETURNING *
      )
      SELECT created.id,created.code,created.revision,created.name,created.status,
        created.source_product_id,source.name AS source_product_name,
        created.target_product_id,target.name AS target_product_name,
        created.minimum_party_size,created.maximum_party_size,created.occasion_tags,
        created.alcohol_preference_tags,created.prompt_title,created.prompt_body,
        created.call_to_action,created.priority,created.offer_valid_minutes,
        created.minimum_gross_margin_basis_points,created.drafted_by_employee_id,
        created.approved_by_employee_id,created.published_by_employee_id,
        created.valid_from::text,created.valid_until::text,created.publication_mode,
        created.created_at::text
      FROM created
      JOIN mbox.products source ON source.tenant_id=created.tenant_id
        AND source.store_id=created.store_id AND source.id=created.source_product_id
      JOIN mbox.products target ON target.tenant_id=created.tenant_id
        AND target.store_id=created.store_id AND target.id=created.target_product_id
    `, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.code,input.name,
      input.sourceProductId,input.targetProductId,input.minimumPartySize,input.maximumPartySize,
      input.occasionTags,input.alcoholPreferenceTags,input.promptTitle,input.promptBody,
      input.callToAction,input.priority,input.offerValidMinutes,input.minimumGrossMarginBasisPoints,
      input.employeeId,
    ])
    return ruleView(required(inserted.rows[0],'checkout upgrade rule draft'))
  }

  async approveRule(ruleId: string, employeeId: string, reason: string): Promise<CheckoutUpgradeRuleAdminView> {
    const updated = await this.transaction.query<RuleRow>(`
      WITH approved AS (
        UPDATE mbox.checkout_upgrade_rules
        SET status='approved',approved_by_employee_id=$4::uuid,
          approved_at=clock_timestamp(),approval_reason=$5,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='draft' AND publication_mode='separated'
          AND drafted_by_employee_id<>$4::uuid
        RETURNING *
      )
      SELECT approved.id,approved.code,approved.revision,approved.name,approved.status,
        approved.source_product_id,source.name AS source_product_name,
        approved.target_product_id,target.name AS target_product_name,
        approved.minimum_party_size,approved.maximum_party_size,approved.occasion_tags,
        approved.alcohol_preference_tags,approved.prompt_title,approved.prompt_body,
        approved.call_to_action,approved.priority,approved.offer_valid_minutes,
        approved.minimum_gross_margin_basis_points,approved.drafted_by_employee_id,
        approved.approved_by_employee_id,approved.published_by_employee_id,
        approved.valid_from::text,approved.valid_until::text,approved.publication_mode,
        approved.created_at::text
      FROM approved
      JOIN mbox.products source ON source.tenant_id=approved.tenant_id
        AND source.store_id=approved.store_id AND source.id=approved.source_product_id
      JOIN mbox.products target ON target.tenant_id=approved.tenant_id
        AND target.store_id=approved.store_id AND target.id=approved.target_product_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,ruleId,employeeId,reason])
    const row = updated.rows[0]
    if (!row) throw new CustomerExperienceRequestError(
      '规则必须由另一名授权人员审批，且只能审批草稿','CHECKOUT_UPGRADE_RULE_APPROVAL_DENIED',409,
    )
    return ruleView(row)
  }

  async publishRule(ruleId: string, employeeId: string, reason: string): Promise<CheckoutUpgradeRuleAdminView> {
    const candidate = await this.transaction.query<{ id: string; code: string }>(`
      SELECT id,code FROM mbox.checkout_upgrade_rules
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,ruleId])
    const selected = candidate.rows[0]
    if (!selected) throw new CustomerExperienceRequestError('没有找到升级规则版本','CHECKOUT_UPGRADE_RULE_NOT_FOUND',404)
    await this.transaction.query(`
      SELECT id FROM mbox.checkout_upgrade_rules
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3
      ORDER BY revision,id FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,selected.code])
    const now = await this.transaction.query<{ now: string }>('SELECT clock_timestamp()::text AS now')
    const cutover = required(now.rows[0],'database clock').now
    await this.transaction.query(`
      UPDATE mbox.checkout_upgrade_rules
      SET status='retired',valid_until=$4::timestamptz,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND code=$3 AND status='active'
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,selected.code,cutover])
    const published = await this.transaction.query<RuleRow>(`
      WITH released AS (
        UPDATE mbox.checkout_upgrade_rules
        SET status='active',published_by_employee_id=$4::uuid,
          published_at=clock_timestamp(),publication_reason=$5,
          valid_from=$6::timestamptz,valid_until=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
          AND status='approved' AND publication_mode='separated'
          AND drafted_by_employee_id<>$4::uuid AND approved_by_employee_id<>$4::uuid
        RETURNING *
      )
      SELECT released.id,released.code,released.revision,released.name,released.status,
        released.source_product_id,source.name AS source_product_name,
        released.target_product_id,target.name AS target_product_name,
        released.minimum_party_size,released.maximum_party_size,released.occasion_tags,
        released.alcohol_preference_tags,released.prompt_title,released.prompt_body,
        released.call_to_action,released.priority,released.offer_valid_minutes,
        released.minimum_gross_margin_basis_points,released.drafted_by_employee_id,
        released.approved_by_employee_id,released.published_by_employee_id,
        released.valid_from::text,released.valid_until::text,released.publication_mode,
        released.created_at::text
      FROM released
      JOIN mbox.products source ON source.tenant_id=released.tenant_id
        AND source.store_id=released.store_id AND source.id=released.source_product_id
      JOIN mbox.products target ON target.tenant_id=released.tenant_id
        AND target.store_id=released.store_id AND target.id=released.target_product_id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,ruleId,employeeId,reason,cutover])
    const row = published.rows[0]
    if (!row) throw new CustomerExperienceRequestError(
      '已审批规则必须由第三名授权人员发布','CHECKOUT_UPGRADE_RULE_PUBLICATION_DENIED',409,
    )
    await this.transaction.query(`
      WITH invalidated AS (
        UPDATE mbox.checkout_upgrade_offers SET status='expired',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND store_id=$2::uuid
          AND status IN ('offered','selected') AND rule_id<>$3::uuid
        RETURNING id
      )
      INSERT INTO mbox.checkout_upgrade_offer_events(
        tenant_id,store_id,public_id,offer_id,event_type,actor_type,
        reason_code,idempotency_key
      ) SELECT $1::uuid,$2::uuid,'checkout-upgrade-event-'||gen_random_uuid(),id,
        'invalidated','system','rule_replaced','rule-replaced:'||$3::text||':'||id::text
      FROM invalidated ON CONFLICT DO NOTHING
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,ruleId])
    return ruleView(row)
  }

  async cloneRuleForRollback(ruleId: string, employeeId: string): Promise<CheckoutUpgradeRuleAdminView> {
    const source = await this.transaction.query<RuleRow>(`
      SELECT rule.id,rule.code,rule.revision,rule.name,rule.status,
        rule.source_product_id,source.name AS source_product_name,
        rule.target_product_id,target.name AS target_product_name,
        rule.minimum_party_size,rule.maximum_party_size,rule.occasion_tags,
        rule.alcohol_preference_tags,rule.prompt_title,rule.prompt_body,
        rule.call_to_action,rule.priority,rule.offer_valid_minutes,
        rule.minimum_gross_margin_basis_points,rule.drafted_by_employee_id,
        rule.approved_by_employee_id,rule.published_by_employee_id,
        rule.valid_from::text,rule.valid_until::text,rule.publication_mode,
        rule.created_at::text
      FROM mbox.checkout_upgrade_rules rule
      JOIN mbox.products source ON source.tenant_id=rule.tenant_id
        AND source.store_id=rule.store_id AND source.id=rule.source_product_id
      JOIN mbox.products target ON target.tenant_id=rule.tenant_id
        AND target.store_id=rule.store_id AND target.id=rule.target_product_id
      WHERE rule.tenant_id=$1::uuid AND rule.store_id=$2::uuid AND rule.id=$3::uuid
      FOR SHARE OF rule,source,target
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,ruleId])
    const row = source.rows[0]
    if (!row) throw new CustomerExperienceRequestError('没有找到可回滚的历史规则','CHECKOUT_UPGRADE_RULE_NOT_FOUND',404)
    return this.insertRuleDraft({
      code:row.code,name:row.name,sourceProductId:row.source_product_id,targetProductId:row.target_product_id,
      minimumPartySize:row.minimum_party_size,maximumPartySize:row.maximum_party_size,
      occasionTags:row.occasion_tags,alcoholPreferenceTags:row.alcohol_preference_tags,
      promptTitle:row.prompt_title,promptBody:row.prompt_body,callToAction:row.call_to_action,
      priority:row.priority,offerValidMinutes:row.offer_valid_minutes,
      minimumGrossMarginBasisPoints:row.minimum_gross_margin_basis_points,employeeId,
    })
  }

  async listOutcomes(): Promise<CheckoutUpgradeOutcomeView[]> {
    const result = await this.transaction.query<Record<string, unknown>>(`
      SELECT offer.public_id,rule.code,offer.rule_revision,offer.status,
        offer.source_name_at_offer,offer.target_name_at_offer,offer.amount_to_add_minor,
        offer.currency,offer.created_at::text,ordered.public_id AS order_public_id,
        COALESCE(payment_fact.state,'not_created') AS payment_state,
        COALESCE(payment_fact.paid_amount_minor,0)::bigint AS paid_amount_minor,
        COALESCE(refund_fact.refunded_amount_minor,0)::bigint AS refunded_amount_minor,
        COALESCE(complaint_fact.complaint_count,0)::bigint AS complaint_count,
        COALESCE(event_fact.viewed,0)::bigint AS viewed,
        COALESCE(event_fact.declined,0)::bigint AS declined,
        COALESCE(event_fact.accepted,0)::bigint AS accepted,
        COALESCE(event_fact.converted,0)::bigint AS converted,
        COALESCE(event_fact.invalidated,0)::bigint AS invalidated
      FROM mbox.checkout_upgrade_offers offer
      JOIN mbox.checkout_upgrade_rules rule ON rule.tenant_id=offer.tenant_id
        AND rule.store_id=offer.store_id AND rule.id=offer.rule_id
      LEFT JOIN mbox.orders ordered ON ordered.tenant_id=offer.tenant_id
        AND ordered.store_id=offer.store_id AND ordered.id=offer.converted_order_id
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN count(*)=0 THEN 'not_created'
          WHEN bool_or(payment.status IN ('succeeded','partially_refunded','refunded')) THEN 'paid'
          WHEN bool_or(payment.status IN ('created','pending')) THEN 'pending'
          ELSE 'failed_or_closed' END AS state,
          COALESCE(sum(payment.amount_minor) FILTER (WHERE payment.status IN ('succeeded','partially_refunded','refunded')),0) AS paid_amount_minor
        FROM mbox.payments payment
        WHERE payment.tenant_id=offer.tenant_id AND payment.store_id=offer.store_id
          AND payment.payable_kind='order' AND payment.order_id=offer.converted_order_id
      ) payment_fact ON offer.converted_order_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(item.amount_minor),0) AS refunded_amount_minor
        FROM mbox.refund_items item JOIN mbox.refunds refund
          ON refund.tenant_id=item.tenant_id AND refund.store_id=item.store_id AND refund.id=item.refund_id
        WHERE item.tenant_id=offer.tenant_id AND item.store_id=offer.store_id
          AND item.order_item_id=offer.converted_order_item_id AND refund.status='succeeded'
      ) refund_fact ON offer.converted_order_item_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT count(*) AS complaint_count
        FROM mbox.guest_service_request_groups request_group
        WHERE request_group.tenant_id=offer.tenant_id AND request_group.store_id=offer.store_id
          AND request_group.request_type='complaint'
          AND request_group.related_order_id=offer.converted_order_id
      ) complaint_fact ON offer.converted_order_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE event_type='viewed') AS viewed,
          count(*) FILTER (WHERE event_type='declined') AS declined,
          count(*) FILTER (WHERE event_type='accepted') AS accepted,
          count(*) FILTER (WHERE event_type='converted') AS converted,
          count(*) FILTER (WHERE event_type='invalidated') AS invalidated
        FROM mbox.checkout_upgrade_offer_events event
        WHERE event.tenant_id=offer.tenant_id AND event.store_id=offer.store_id
          AND event.offer_id=offer.id
      ) event_fact ON true
      WHERE offer.tenant_id=$1::uuid AND offer.store_id=$2::uuid
      ORDER BY offer.created_at DESC,offer.id DESC LIMIT 300
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId])
    return result.rows.map((row) => ({
      offerPublicId:String(row.public_id),ruleCode:String(row.code),ruleRevision:Number(row.rule_revision),
      status:String(row.status),sourceProductName:String(row.source_name_at_offer ?? ''),
      targetProductName:String(row.target_name_at_offer ?? ''),amountToAddMinor:Number(row.amount_to_add_minor),
      currency:String(row.currency),offeredAt:String(row.created_at),
      convertedOrderPublicId:row.order_public_id===null?null:String(row.order_public_id),
      paymentState:String(row.payment_state) as CheckoutUpgradeOutcomeView['paymentState'],
      paidAmountMinor:Number(row.paid_amount_minor),refundedAmountMinor:Number(row.refunded_amount_minor),
      complaintCount:Number(row.complaint_count),eventCounts:{viewed:Number(row.viewed),declined:Number(row.declined),
        accepted:Number(row.accepted),converted:Number(row.converted),invalidated:Number(row.invalidated)},
    }))
  }

  async listCapacityPolicies(): Promise<CapacityPolicyView[]> {
    const result = await this.transaction.query<CapacityRow>(`
      SELECT policy.id,policy.station_code,policy.policy_version,policy.status,
        policy.drafted_by_employee_id,policy.approved_by_employee_id,
        policy.published_by_employee_id,policy.published_at::text,policy.retired_at::text,
        policy.publication_mode,policy.reason,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',window_row.id,'startsAt',window_row.starts_at::text,'endsAt',window_row.ends_at::text,
          'capacityLimitUnits',window_row.capacity_limit_units,'usedUnits',COALESCE(usage.used_units,0)
        ) ORDER BY window_row.starts_at,window_row.id) FILTER (WHERE window_row.id IS NOT NULL),'[]'::jsonb) AS windows
      FROM mbox.fulfillment_capacity_policy_versions policy
      LEFT JOIN mbox.fulfillment_capacity_windows window_row ON window_row.tenant_id=policy.tenant_id
        AND window_row.store_id=policy.store_id AND window_row.policy_version_id=policy.id
      LEFT JOIN LATERAL (SELECT COALESCE(sum(reservation.capacity_units),0) AS used_units
        FROM mbox.fulfillment_capacity_reservations reservation
        WHERE reservation.tenant_id=window_row.tenant_id AND reservation.store_id=window_row.store_id
          AND reservation.capacity_window_id=window_row.id AND reservation.status IN ('reserved','active')) usage ON true
      WHERE policy.tenant_id=$1::uuid AND policy.store_id=$2::uuid
      GROUP BY policy.id ORDER BY policy.station_code,policy.policy_version DESC,policy.id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId])
    return result.rows.map(capacityView)
  }

  async draftCapacity(input: Readonly<{
    stationCode: CapacityPolicyView['stationCode']
    reason: string
    employeeId: string
    windows: Array<{ startsAt: string; endsAt: string; capacityLimitUnits: number }>
  }>): Promise<CapacityPolicyView> {
    await this.transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1||':'||$2||':'||$3,0))`, [
      this.transaction.scope.tenantId,this.transaction.scope.storeId,input.stationCode,
    ])
    const policy = await this.transaction.query<{ id: string }>(`
      INSERT INTO mbox.fulfillment_capacity_policy_versions(
        tenant_id,store_id,station_code,policy_version,status,drafted_by_employee_id,
        publication_mode,reason
      ) SELECT $1::uuid,$2::uuid,$3,COALESCE(MAX(policy_version),0)+1,'draft',$4::uuid,
        'separated',$5
      FROM mbox.fulfillment_capacity_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND station_code=$3
      RETURNING id
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,input.stationCode,input.employeeId,input.reason])
    const id = required(policy.rows[0],'capacity policy draft').id
    for (const window of input.windows) {
      await this.transaction.query(`
        INSERT INTO mbox.fulfillment_capacity_windows(
          tenant_id,store_id,policy_version_id,starts_at,ends_at,capacity_limit_units
        ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz,$6)
      `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,id,
        window.startsAt,window.endsAt,window.capacityLimitUnits])
    }
    return required((await this.listCapacityPolicies()).find((item)=>item.id===id),'capacity policy view')
  }

  async approveCapacity(policyId: string, employeeId: string): Promise<CapacityPolicyView> {
    const result = await this.transaction.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='approved',approved_by_employee_id=$4::uuid,
        approved_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='draft' AND drafted_by_employee_id<>$4::uuid
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,policyId,employeeId])
    if (result.rowCount!==1) throw new CustomerExperienceRequestError(
      '产能版本必须由另一名授权人员审批','FULFILLMENT_CAPACITY_APPROVAL_DENIED',409,
    )
    return required((await this.listCapacityPolicies()).find((item)=>item.id===policyId),'capacity policy view')
  }

  async publishCapacity(policyId: string, employeeId: string): Promise<CapacityPolicyView> {
    const candidate = await this.transaction.query<{ station_code: string }>(`
      SELECT station_code FROM mbox.fulfillment_capacity_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,policyId])
    const station = candidate.rows[0]?.station_code
    if (!station) throw new CustomerExperienceRequestError('没有找到产能版本','FULFILLMENT_CAPACITY_NOT_FOUND',404)
    await this.transaction.query(`
      SELECT id FROM mbox.fulfillment_capacity_policy_versions
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND station_code=$3
      ORDER BY policy_version,id FOR UPDATE
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,station])
    await this.transaction.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions SET status='retired',updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND station_code=$3 AND status='published'
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,station])
    const published = await this.transaction.query(`
      UPDATE mbox.fulfillment_capacity_policy_versions
      SET status='published',published_by_employee_id=$4::uuid,updated_at=clock_timestamp()
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='approved' AND drafted_by_employee_id<>$4::uuid
        AND approved_by_employee_id<>$4::uuid
    `, [this.transaction.scope.tenantId,this.transaction.scope.storeId,policyId,employeeId])
    if (published.rowCount!==1) throw new CustomerExperienceRequestError(
      '已审批产能版本必须由第三名授权人员发布','FULFILLMENT_CAPACITY_PUBLICATION_DENIED',409,
    )
    return required((await this.listCapacityPolicies()).find((item)=>item.id===policyId),'capacity policy view')
  }
}

function ruleView(row: RuleRow): CheckoutUpgradeRuleAdminView {
  return {
    id:row.id,code:row.code,revision:Number(row.revision),name:row.name,status:row.status,
    sourceProductId:row.source_product_id,sourceProductName:row.source_product_name,
    targetProductId:row.target_product_id,targetProductName:row.target_product_name,
    minimumPartySize:Number(row.minimum_party_size),maximumPartySize:Number(row.maximum_party_size),
    occasionTags:row.occasion_tags,alcoholPreferenceTags:row.alcohol_preference_tags,
    promptTitle:row.prompt_title,promptBody:row.prompt_body,callToAction:row.call_to_action,
    priority:Number(row.priority),offerValidMinutes:Number(row.offer_valid_minutes),
    minimumGrossMarginBasisPoints:Number(row.minimum_gross_margin_basis_points),
    draftedByEmployeeId:row.drafted_by_employee_id,approvedByEmployeeId:row.approved_by_employee_id,
    publishedByEmployeeId:row.published_by_employee_id,validFrom:row.valid_from,validUntil:row.valid_until,
    publicationMode:row.publication_mode,createdAt:row.created_at,
  }
}

function capacityView(row: CapacityRow): CapacityPolicyView {
  const windows = Array.isArray(row.windows) ? row.windows : []
  return {
    id:row.id,stationCode:row.station_code,policyVersion:Number(row.policy_version),status:row.status,
    draftedByEmployeeId:row.drafted_by_employee_id,approvedByEmployeeId:row.approved_by_employee_id,
    publishedByEmployeeId:row.published_by_employee_id,publishedAt:row.published_at,
    retiredAt:row.retired_at,publicationMode:row.publication_mode,reason:row.reason,
    windows:windows.map((value) => {
      const item = value as Record<string,unknown>
      return { id:String(item.id),startsAt:String(item.startsAt),endsAt:String(item.endsAt),
        capacityLimitUnits:Number(item.capacityLimitUnits),usedUnits:Number(item.usedUnits) }
    }),
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value===undefined) throw new Error(`${label} was not returned`)
  return value
}
