import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import {
  MembershipConfigurationDraftService,
  type MembershipConfigurationContent,
  type MembershipConfigurationDomain,
} from './membership-configuration-draft-service.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const ids={
  tenant:randomUUID(),store:randomUUID(),drafter:randomUUID(),editor:randomUUID(),
  approver:randomUUID(),publisher:randomUUID(),base:randomUUID(),tier:randomUUID(),
  benefit:randomUUID(),definition:randomUUID(),redemption:randomUUID(),promotion:randomUUID(),
  terms:randomUUID(),notification:randomUUID(),legacyNotification:randomUUID(),activity:randomUUID(),
  customer:randomUUID(),membership:randomUUID(),account:randomUUID(),
} as const

integration('membership configuration saved drafts and server impact evidence',()=>{
  let pool:Pool
  let runner:ScopedPostgresTransactionRunner
  let now=new Date()
  let service:MembershipConfigurationDraftService

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    service=new MembershipConfigurationDraftService(repository(),()=>now)
    await seed(pool)
  },30_000)
  afterAll(async()=>pool?.end())

  it('captures the original drafter, hides legacy notification rows and enforces draft CAS',async()=>{
    const contributors=await pool.query<{configuration_domain:string;employee_id:string}>(`
      SELECT configuration_domain,employee_id::text FROM mbox.membership_configuration_draft_contributors
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid ORDER BY configuration_domain
    `,[ids.tenant,ids.store])
    expect(contributors.rows).toHaveLength(7)
    expect(contributors.rows.every((row)=>row.employee_id===ids.drafter)).toBe(true)
    await expect(service.get('wechat_notifications',ids.legacyNotification)).rejects.toMatchObject({
      code:'MEMBERSHIP_CONFIGURATION_DRAFT_NOT_FOUND',
    })

    const first=service.edit({domain:'base_points',publicId:ids.base,expectedRevision:1,
      employeeId:ids.editor,reason:'并发保存第一份草稿',content:{...contents.base_points,pointsNumerator:2}})
    const second=service.edit({domain:'base_points',publicId:ids.base,expectedRevision:1,
      employeeId:ids.editor,reason:'并发保存第二份草稿',content:{...contents.base_points,pointsNumerator:3}})
    const settled=await Promise.allSettled([first,second])
    expect(settled.filter((result)=>result.status==='fulfilled')).toHaveLength(1)
    expect(settled.filter((result)=>result.status==='rejected')).toHaveLength(1)
    expect((settled.find((result)=>result.status==='rejected') as PromiseRejectedResult).reason)
      .toMatchObject({code:'MEMBERSHIP_CONFIGURATION_DRAFT_STALE'})
  })

  it('saves all seven domains through typed columns and child rows, never executable JSON',async()=>{
    for(const domain of domains.filter((entry)=>entry!=='base_points')){
      await service.edit({domain,publicId:configurationId(domain),expectedRevision:1,
        employeeId:ids.editor,reason:`更新${domain}强类型草稿`,content:contents[domain]})
    }
    const stored=await pool.query(`
      SELECT
        (SELECT points_denominator_minor FROM mbox.loyalty_policy_versions WHERE id=$1::uuid) base_denominator,
        (SELECT gold_upgrade_growth FROM mbox.loyalty_tier_policy_versions WHERE id=$2::uuid) gold_growth,
        (SELECT validity_days FROM mbox.loyalty_tier_benefit_rules WHERE policy_version_id=$3::uuid) benefit_days,
        (SELECT points_required FROM mbox.redemption_catalog_items WHERE catalog_version_id=$4::uuid) redemption_points,
        (SELECT store_budget_points FROM mbox.loyalty_promotion_policy_versions WHERE id=$5::uuid) promotion_budget,
        (SELECT title FROM mbox.membership_terms_versions WHERE id=$6::uuid) terms_title,
        (SELECT max_per_customer_per_24h FROM mbox.wechat_notification_policies WHERE id=$7::uuid) notification_cap
    `,[ids.base,ids.tier,ids.benefit,ids.redemption,ids.promotion,ids.terms,ids.notification])
    expect(stored.rows[0]).toMatchObject({base_denominator:100,gold_growth:800,benefit_days:45,
      redemption_points:600,promotion_budget:5000,terms_title:'会员经营条款第二稿',notification_cap:2})
    const displayJson=await pool.query(`
      SELECT display_snapshot FROM mbox.redemption_catalog_items WHERE catalog_version_id=$1::uuid
    `,[ids.redemption])
    expect(displayJson.rows[0]?.display_snapshot).toEqual({decorativeCopy:'仅用于展示'})
  })

  it('counts only immutable completion facts and never treats a mutable registration status as completion',async()=>{
    const waitingActivity=randomUUID();const checkedCustomer=randomUUID();const confirmedCustomer=randomUUID()
    const waitingCustomer=randomUUID();const checkedRegistration=randomUUID();const confirmedRegistration=randomUUID()
    const waitingRegistration=randomUUID()
    await publishActivity(pool,ids.activity)
    await insertCustomer(pool,checkedCustomer,'completion-checked-094')
    await insertCustomer(pool,confirmedCustomer,'completion-confirmed-094')
    await insertRegistration(pool,checkedRegistration,ids.activity,checkedCustomer,'checked_in','completion-checked-094')
    await insertRegistration(pool,confirmedRegistration,ids.activity,confirmedCustomer,'confirmed','completion-confirmed-094')
    await pool.query(`UPDATE mbox.community_activities SET status='completed' WHERE id=$1::uuid`,[ids.activity])

    await createPublishedActivity(pool,waitingActivity,'activity-not-completed-094')
    await insertCustomer(pool,waitingCustomer,'completion-waiting-094')
    await insertRegistration(pool,waitingRegistration,waitingActivity,waitingCustomer,'confirmed','completion-waiting-094')
    await pool.query(`UPDATE mbox.community_activity_registrations SET status='checked_in',checked_in_at=clock_timestamp()
      WHERE id=$1::uuid`,[waitingRegistration])

    const complete=await repository().runExclusive('promotion_points',ids.promotion,(session)=>(
      session.loadImpactSnapshot(contents.promotion_points)
    ))
    const notComplete=await repository().runExclusive('promotion_points',ids.promotion,(session)=>(
      session.loadImpactSnapshot({...contents.promotion_points,activityId:waitingActivity})
    ))
    expect(complete.promotionTriggerParticipants).toEqual([
      {triggerKind:'activity_completion',eligibleMembers:1,expectedTriggerFacts:1},
    ])
    expect(notComplete.promotionTriggerParticipants).toEqual([
      {triggerKind:'activity_completion',eligibleMembers:0,expectedTriggerFacts:0},
    ])
  })

  it('counts open benefit fulfillment by the benefit-policy rule instead of confusing the tier-policy id',async()=>{
    const customerId=randomUUID();const membershipId=randomUUID();const accountId=randomUUID()
    const eventId=randomUUID();const benefitId=randomUUID();const historicalTierId=randomUUID()
    const historicalBenefitPolicyId=randomUUID();const grantedAt=new Date(Date.now()+5*60_000).toISOString()
    const expiresAt=new Date(Date.parse(grantedAt)+45*24*60*60_000).toISOString()
    await insertCustomer(pool,customerId,'benefit-fact-member-094')
    await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no)
      VALUES($1,$2,$3,$4,'MBXBENEFIT094')`,[membershipId,ids.tenant,ids.store,customerId])
    await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,current_tier)
      VALUES($1,$2,$3,$4,$5,'silver')`,[accountId,ids.tenant,ids.store,membershipId,customerId])
    await pool.query(`INSERT INTO mbox.loyalty_tier_policy_versions(id,tenant_id,store_id,version,status,
      evaluation_window_months,tier_period_months,downgrade_grace_days,silver_upgrade_growth,
      silver_retain_growth,gold_upgrade_growth,gold_retain_growth,silver_points_multiplier_numerator,
      silver_points_multiplier_denominator,gold_points_multiplier_numerator,gold_points_multiplier_denominator,
      effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,reason,
      published_by_employee_id,published_at)
      VALUES($1,$2,$3,99,'published',12,12,30,200,150,800,600,12,10,15,10,
        '2026-08-01T00:00:00Z',$4,$5,'2026-08-01T00:00:00Z','履约事实隔离夹具',$6,'2026-08-01T00:00:00Z')`,
    [historicalTierId,ids.tenant,ids.store,ids.drafter,ids.approver,ids.publisher])
    await pool.query(`INSERT INTO mbox.loyalty_tier_benefit_policy_versions(id,tenant_id,store_id,
      tier_policy_version_id,version,drafted_by_employee_id,reason)
      VALUES($1,$2,$3,$4,99,$5,'履约事实隔离夹具')`,
    [historicalBenefitPolicyId,ids.tenant,ids.store,historicalTierId,ids.drafter])
    const historicalRule=(await pool.query<{id:string}>(`INSERT INTO mbox.loyalty_tier_benefit_rules(
      tenant_id,store_id,policy_version_id,rule_code,eligible_tier,benefit_definition_id,
      quantity,validity_days) VALUES($1,$2,$3,'HISTORICAL_SILVER_WELCOME','silver',$4,1,45)
      RETURNING id::text`,[ids.tenant,ids.store,historicalBenefitPolicyId,ids.definition])).rows[0]!
    const historicalDraft=await service.get('tier_benefits',historicalBenefitPolicyId)
    const historicalPreview=await service.preview('tier_benefits',historicalBenefitPolicyId,ids.approver)
    await service.approve({domain:'tier_benefits',publicId:historicalBenefitPolicyId,
      expectedRevision:historicalDraft.revision,approverEmployeeId:ids.approver,
      reason:'独立审批历史履约事实夹具',impactPreviewPublicId:historicalPreview.publicId})
    await pool.query(`UPDATE mbox.loyalty_tier_benefit_policy_versions SET status='published',
      effective_from='2026-08-01T00:00:00Z',published_by_employee_id=$2::uuid,
      published_at=clock_timestamp() WHERE id=$1::uuid`,[historicalBenefitPolicyId,ids.publisher])
    await pool.query(`INSERT INTO mbox.membership_tier_events(id,tenant_id,store_id,membership_id,
      policy_version_id,event_type,from_tier,to_tier,evaluated_growth,reason,source_type,source_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,'corrected','member','silver',200,'建立权益履约事实',
        'approved_correction','benefit-fact-094',$6::timestamptz)`,
    [eventId,ids.tenant,ids.store,membershipId,historicalTierId,grantedAt])
    await pool.query(`INSERT INTO mbox.benefits(id,tenant_id,store_id,customer_id,benefit_code,
      benefit_type,status,valid_from,valid_until,benefit_definition_id,benefit_kind)
      VALUES($1,$2,$3,$4,'BENEFIT_FACT_094','other','issued',$6::timestamptz,
        $7::timestamptz,$5,'tier_benefit')`,[benefitId,ids.tenant,ids.store,customerId,ids.definition,grantedAt,expiresAt])
    await pool.query(`INSERT INTO mbox.membership_tier_benefit_grants(tenant_id,store_id,membership_id,
      customer_id,tier_event_id,policy_version_id,rule_id,benefit_id,granted_tier,status,granted_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'silver','active',$9::timestamptz,$10::timestamptz)`,
    [ids.tenant,ids.store,membershipId,customerId,eventId,historicalBenefitPolicyId,historicalRule.id,
      benefitId,grantedAt,expiresAt])
    expect(historicalTierId).not.toBe(historicalBenefitPolicyId)
    const snapshot=await repository().runExclusive('tier_benefits',ids.benefit,(session)=>(
      session.loadImpactSnapshot(contents.tier_benefits)
    ))
    expect(snapshot.benefitFacts).toEqual([expect.objectContaining({
      benefitDefinitionId:ids.definition,openFulfillmentTasks:1,
    })])
  })

  it('rejects every contributor, expires previews, detects fact drift and approves only an independent checker',async()=>{
    const base=await service.get('base_points',ids.base)
    const preview=await service.preview('base_points',ids.base,ids.approver)
    await expect(service.approve({domain:'base_points',publicId:ids.base,expectedRevision:base.revision,
      approverEmployeeId:ids.drafter,reason:'原起草人不得审批',impactPreviewPublicId:preview.publicId}))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED'})
    await expect(service.approve({domain:'base_points',publicId:ids.base,expectedRevision:base.revision,
      approverEmployeeId:ids.editor,reason:'后续编辑人不得审批',impactPreviewPublicId:preview.publicId}))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_SELF_APPROVAL_DENIED'})

    await addMember(pool)
    await expect(service.approve({domain:'base_points',publicId:ids.base,expectedRevision:base.revision,
      approverEmployeeId:ids.approver,reason:'旧预览事实已变化',impactPreviewPublicId:preview.publicId}))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_IMPACT_CHANGED'})
    const current=await service.preview('base_points',ids.base,ids.approver)
    now=new Date(now.getTime()+16*60_000)
    await expect(service.approve({domain:'base_points',publicId:ids.base,expectedRevision:base.revision,
      approverEmployeeId:ids.approver,reason:'过期预览不得审批',impactPreviewPublicId:current.publicId}))
      .rejects.toMatchObject({code:'MEMBERSHIP_CONFIGURATION_PREVIEW_STALE'})
    now=new Date()
    const renewed=await service.preview('base_points',ids.base,ids.approver)
    await service.approve({domain:'base_points',publicId:ids.base,expectedRevision:base.revision,
      approverEmployeeId:ids.approver,reason:'依据最新服务端影响预览独立审批',impactPreviewPublicId:renewed.publicId})

    for(const domain of domains.filter((entry)=>entry!=='base_points')){
      const draft=await service.get(domain,configurationId(domain))
      const evidence=await service.preview(domain,draft.publicId,ids.approver)
      await service.approve({domain,publicId:draft.publicId,expectedRevision:draft.revision,
        approverEmployeeId:ids.approver,reason:`独立审批${domain}配置`,impactPreviewPublicId:evidence.publicId})
    }
    const approvals=await pool.query<{count:number}>(`
      SELECT count(*)::integer count FROM mbox.membership_configuration_approval_facts
      WHERE tenant_id=$1::uuid AND store_id=$2::uuid AND configuration_id=ANY($3::uuid[])
    `,[ids.tenant,ids.store,domains.map(configurationId)])
    expect(approvals.rows[0]?.count).toBe(7)
  })

  it('enforces publisher separation in PostgreSQL after approval',async()=>{
    await expect(pool.query(`UPDATE mbox.loyalty_policy_versions SET status='published',
      effective_from=clock_timestamp(),published_by_employee_id=$2::uuid,published_at=clock_timestamp()
      WHERE id=$1::uuid`,[ids.base,ids.editor])).rejects.toThrow(/publisher must differ/)
    await expect(pool.query(`UPDATE mbox.loyalty_policy_versions SET status='published',
      effective_from=clock_timestamp(),published_by_employee_id=$2::uuid,published_at=clock_timestamp()
      WHERE id=$1::uuid`,[ids.base,ids.approver])).rejects.toThrow(/publisher must differ/)
    await pool.query(`UPDATE mbox.loyalty_policy_versions SET status='published',
      effective_from=clock_timestamp(),published_by_employee_id=$2::uuid,published_at=clock_timestamp()
      WHERE id=$1::uuid`,[ids.base,ids.publisher])
    const row=await pool.query(`SELECT status,published_by_employee_id::text publisher
      FROM mbox.loyalty_policy_versions WHERE id=$1::uuid`,[ids.base])
    expect(row.rows[0]).toMatchObject({status:'published',publisher:ids.publisher})
  })

  function repository(){return new PostgresMembershipConfigurationDraftRepository(runner,{tenantId:ids.tenant,storeId:ids.store})}
})

const domains=['base_points','tier_policy','tier_benefits','redemption_catalog','promotion_points','membership_terms','wechat_notifications'] as const
const contents={
  base_points:{domain:'base_points',pointsNumerator:1,pointsDenominatorMinor:100,growthNumerator:1,
    growthDenominatorMinor:100,roundingMode:'floor',pointsValidityMonths:18},
  tier_policy:{domain:'tier_policy',evaluationWindowMonths:12,tierPeriodMonths:12,downgradeGraceDays:30,
    silverUpgradeGrowth:200,silverRetainGrowth:150,goldUpgradeGrowth:800,goldRetainGrowth:600,
    silverPointsMultiplierNumerator:12,silverPointsMultiplierDenominator:10,
    goldPointsMultiplierNumerator:15,goldPointsMultiplierDenominator:10},
  tier_benefits:{domain:'tier_benefits',tierPolicyVersionId:ids.tier,rules:[{ruleCode:'SILVER_WELCOME',
    eligibleTier:'silver',inheritToHigherTiers:true,grantOnEntry:true,grantOnRetention:false,
    benefitDefinitionId:ids.definition,quantity:1,validityDays:45,
    revocationPolicy:'revoke_unreserved',enabled:true}]},
  redemption_catalog:{domain:'redemption_catalog',items:[{publicId:'redemption-old-094',itemCode:'OLD_SERVICE',
    name:'会员专属服务',fulfillmentKind:'service',productId:null,benefitDefinitionId:null,activityId:null,
    pointsRequired:600,costAmountMinor:800,currency:'CNY',totalInventory:50,dailyInventory:5,
    memberDailyLimit:1,memberRolling30DayLimit:2,memberLifetimeLimit:12,minimumTier:'member',
    requiresTableSession:true,requiresEmployeeFulfillment:true,cancellationAllowedBeforeFulfillment:true,
    restoreExpiredPointsDays:7,availableFrom:'2026-08-16T00:00:00.000Z',availableUntil:null,
    fulfillmentTimeoutMinutes:240,status:'active'}]},
  promotion_points:{domain:'promotion_points',campaignCode:'PROMO_094',name:'活动完成积分',activityId:ids.activity,
    stackingGroup:'ACTIVITY_094',stackingMode:'exclusive_highest',priority:100,storeBudgetPoints:5000,
    perMemberPointsLimit:500,pointValidityDays:90,refundPolicy:'reverse_on_any_refund',
    budgetReuseAfterRefund:false,memberLimitReuseAfterRefund:false,eligibleMemberLevels:['member','silver'],
    rules:[{ruleCode:'COMPLETE_094',triggerKind:'activity_completion',points:100,
      perMemberAwardLimit:1,minimumPaidAmountMinor:0,enabled:true}]},
  membership_terms:{domain:'membership_terms',title:'会员经营条款第二稿',summary:'明确积分、权益与退款处理边界。',
    content:'本条款明确会员积分、等级权益、兑换履约、退款冲回和个人信息授权的独立处理规则。'},
  wechat_notifications:{domain:'wechat_notifications',notificationType:'loyalty_points_credited',
    authorizationPurpose:'loyalty_balance_change',authorizationContext:'loyalty_accrual',
    templateId:'template-credited-094',pagePath:'pages/points/index',pointsDataKey:'points_value',
    balanceDataKey:'balance_value',occurredAtDataKey:'occurred_at',expiresAtDataKey:null,expiryLeadDays:null,
    maxPerCustomerPer24h:2,minimumIntervalMinutes:30,quietHoursStart:'22:00:00',quietHoursEnd:'08:00:00'},
} satisfies Record<MembershipConfigurationDomain,MembershipConfigurationContent>

function configurationId(domain:MembershipConfigurationDomain){return({base_points:ids.base,tier_policy:ids.tier,
  tier_benefits:ids.benefit,redemption_catalog:ids.redemption,promotion_points:ids.promotion,
  membership_terms:ids.terms,wechat_notifications:ids.notification} as const)[domain]}

async function seed(pool:Pool){
  const suffix=ids.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$2,'Configuration 094 tenant')`,[ids.tenant,`cfg_${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2::uuid,$3,'Configuration 094 store')`,[ids.store,ids.tenant,`cfg_${suffix}`])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES
    ($1::uuid,$5::uuid,$6::uuid,'DRAFTER_094','起草人'),($2::uuid,$5::uuid,$6::uuid,'EDITOR_094','编辑人'),
    ($3::uuid,$5::uuid,$6::uuid,'APPROVER_094','审批人'),($4::uuid,$5::uuid,$6::uuid,'PUBLISHER_094','发布人')`,
  [ids.drafter,ids.editor,ids.approver,ids.publisher,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,
    summary,starts_at,ends_at,assembly_location,capacity,created_by_employee_id)
    VALUES($1::uuid,$2::uuid,$3::uuid,'activity-config-094','other','配置测试活动','用于配置影响预览',
      '2026-09-01T10:00:00Z','2026-09-01T12:00:00Z','MBOX',20,$4::uuid)`,[ids.activity,ids.tenant,ids.store,ids.drafter])
  await pool.query(`INSERT INTO mbox.loyalty_policy_versions(id,tenant_id,store_id,policy_code,version,
    points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,
    points_validity_months,drafted_by_employee_id,reason) VALUES($1,$2,$3,'BASE',1,1,100,1,100,'floor',12,$4,'初始积分草稿')`,[ids.base,ids.tenant,ids.store,ids.drafter])
  await pool.query(`INSERT INTO mbox.loyalty_tier_policy_versions(id,tenant_id,store_id,version,
    evaluation_window_months,tier_period_months,downgrade_grace_days,silver_upgrade_growth,
    silver_retain_growth,gold_upgrade_growth,gold_retain_growth,silver_points_multiplier_numerator,
    silver_points_multiplier_denominator,gold_points_multiplier_numerator,gold_points_multiplier_denominator,
    drafted_by_employee_id,reason) VALUES($1,$2,$3,1,12,12,30,100,80,500,400,11,10,13,10,$4,'初始等级草稿')`,
  [ids.tier,ids.tenant,ids.store,ids.drafter])
  await pool.query(`INSERT INTO mbox.loyalty_benefit_definitions(id,tenant_id,store_id,public_id,benefit_code,
    name,benefit_kind,validity_days,requires_employee_fulfillment,cost_amount_minor)
    VALUES($1,$2,$3,'benefit-config-094','BENEFIT_094','配置测试权益','tier_benefit',30,true,1200)`,[ids.definition,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.loyalty_tier_benefit_policy_versions(id,tenant_id,store_id,
    tier_policy_version_id,version,drafted_by_employee_id,reason) VALUES($1,$2,$3,$4,1,$5,'初始权益草稿')`,
  [ids.benefit,ids.tenant,ids.store,ids.tier,ids.drafter])
  await pool.query(`INSERT INTO mbox.loyalty_tier_benefit_rules(tenant_id,store_id,policy_version_id,
    rule_code,eligible_tier,benefit_definition_id,quantity,validity_days) VALUES($1,$2,$3,'OLD_RULE','silver',$4,1,30)`,
  [ids.tenant,ids.store,ids.benefit,ids.definition])
  await pool.query(`INSERT INTO mbox.redemption_catalog_versions(id,tenant_id,store_id,version,
    drafted_by_employee_id,reason) VALUES($1,$2,$3,1,$4,'初始兑换草稿')`,[ids.redemption,ids.tenant,ids.store,ids.drafter])
  await pool.query(`INSERT INTO mbox.redemption_catalog_items(tenant_id,store_id,catalog_version_id,public_id,
    item_code,name,fulfillment_kind,points_required,cost_amount_minor,available_from,display_snapshot)
    VALUES($1,$2,$3,'redemption-old-094','OLD_SERVICE','旧服务兑换','service',500,700,
      '2026-08-16T00:00:00Z','{"decorativeCopy":"仅用于展示"}'::jsonb)`,[ids.tenant,ids.store,ids.redemption])
  await pool.query(`INSERT INTO mbox.loyalty_promotion_policy_versions(id,tenant_id,store_id,campaign_code,
    version,name,activity_id,stacking_group,stacking_mode,priority,store_budget_points,per_member_points_limit,
    point_validity_days,refund_policy,eligible_member_levels,drafted_by_employee_id,reason)
    VALUES($1,$2,$3,'PROMO_094',1,'旧活动积分',$4,'ACTIVITY_094','exclusive_highest',10,1000,100,
      30,'reverse_on_any_refund',ARRAY['member'],$5,'初始促销草稿')`,[ids.promotion,ids.tenant,ids.store,ids.activity,ids.drafter])
  await pool.query(`INSERT INTO mbox.loyalty_promotion_rules(tenant_id,store_id,policy_version_id,rule_code,
    trigger_kind,points,per_member_award_limit) VALUES($1,$2,$3,'OLD_COMPLETE','activity_completion',50,1)`,
  [ids.tenant,ids.store,ids.promotion])
  await pool.query(`INSERT INTO mbox.membership_terms_versions(id,tenant_id,store_id,public_id,version,title,
    summary,content,drafted_by_employee_id,draft_reason) VALUES($1,$2,$3,$4,1,'会员经营条款初稿',
    '初始版本摘要','初始条款正文用于配置草稿编辑与审批测试。',$5,'初始条款草稿')`,
  [ids.terms,ids.tenant,ids.store,`MTV${ids.terms.replaceAll('-','').toUpperCase()}`,ids.drafter])
  await pool.query(`INSERT INTO mbox.wechat_notification_policies(id,tenant_id,store_id,notification_type,
    authorization_purpose,authorization_context,policy_version,template_id,page_path,points_data_key,
    balance_data_key,occurred_at_data_key,reason,governance_mode,drafted_by_employee_id)
    VALUES($1,$2,$3,'loyalty_points_credited','loyalty_balance_change','loyalty_accrual',1,
      'template-credited-094','pages/points/index','points_value','balance_value','occurred_at','初始通知草稿','managed',$4)`,
  [ids.notification,ids.tenant,ids.store,ids.drafter])
  await pool.query(`INSERT INTO mbox.wechat_notification_policies(id,tenant_id,store_id,notification_type,
    authorization_purpose,authorization_context,policy_version,template_id,page_path,points_data_key,
    balance_data_key,occurred_at_data_key,reason)
    VALUES($1,$2,$3,'loyalty_points_reversed','loyalty_balance_change','loyalty_refund',1,
      'legacy-template-094','pages/points/index','points_value','balance_value','occurred_at','历史只读通知策略')`,
  [ids.legacyNotification,ids.tenant,ids.store])
}

async function addMember(pool:Pool){
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
    VALUES($1,$2,$3,'configuration-member-094','active')`,[ids.customer,ids.tenant,ids.store])
  await pool.query(`INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no)
    VALUES($1,$2,$3,$4,'MBXCFG094001')`,[ids.membership,ids.tenant,ids.store,ids.customer])
  await pool.query(`INSERT INTO mbox.loyalty_accounts(id,tenant_id,store_id,membership_id,customer_id,
    available_points,growth_value,current_tier) VALUES($1,$2,$3,$4,$5,200,250,'silver')`,
  [ids.account,ids.tenant,ids.store,ids.membership,ids.customer])
}

async function createPublishedActivity(pool:Pool,activityId:string,publicId:string){
  await pool.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,
    summary,starts_at,ends_at,assembly_location,capacity,status,published_at,created_by_employee_id,
    approved_by_employee_id,safety_policy_version,safety_acknowledgement_text,safety_requirements,
    refund_policy_version,refund_policy_summary,activity_details,contact_instructions)
    VALUES($1,$2,$3,$4,'other','完成事实反例活动','尚未完成不能产生完成奖励事实',
      '2026-09-02T10:00:00Z','2026-09-02T12:00:00Z','MBOX',20,'published',clock_timestamp(),
      $5,$6,'safety-v1','已阅读安全说明',ARRAY['遵守现场规则'],'refund-v1','按公示规则退款',
      '用于验证只有活动完成才产生权威完成事实。','到店后联系值班人员')`,
  [activityId,ids.tenant,ids.store,publicId,ids.drafter,ids.approver])
}
async function publishActivity(pool:Pool,activityId:string){
  await pool.query(`UPDATE mbox.community_activities SET status='published',published_at=clock_timestamp(),
    approved_by_employee_id=$2,safety_policy_version='safety-v1',safety_acknowledgement_text='已阅读安全说明',
    safety_requirements=ARRAY['遵守现场规则'],refund_policy_version='refund-v1',
    refund_policy_summary='按公示规则退款',activity_details='用于验证活动完成权威事实。',
    contact_instructions='到店后联系值班人员' WHERE id=$1`,[activityId,ids.approver])
}
async function insertCustomer(pool:Pool,customerId:string,publicId:string){
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES($1,$2,$3,$4,'active')`,
  [customerId,ids.tenant,ids.store,publicId])
}
async function insertRegistration(pool:Pool,registrationId:string,activityId:string,customerId:string,status:'confirmed'|'checked_in',suffix:string){
  const checked=status==='checked_in'?new Date().toISOString():null
  await pool.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,
    activity_id,customer_id,status,fee_amount_minor,currency,contact_snapshot,idempotency_key,checked_in_at,
    acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,
    terms_acknowledgement_source,requested_payment_choice,requested_amount_due_minor)
    VALUES($1,$2,$3,$4,$5,$6,$7,0,'CNY',$8::jsonb,$9,$10::timestamptz,
      'safety-v1','refund-v1',clock_timestamp(),'staff_assisted','none',0)`,
  [registrationId,ids.tenant,ids.store,`registration-${suffix}`,activityId,customerId,status,
    JSON.stringify({contactType:'phone',contactHash:'a'.repeat(64),encryptedContact:'AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
      encryptionKeyId:'normalized-contact-v1',maskedContact:'138****0000',source:'mini_program'}),`idempotency-${suffix}`,checked])
}
