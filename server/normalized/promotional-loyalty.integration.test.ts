import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { LoyaltyOperationalControlService } from './loyalty-operational-control-service.js'
import { PostgresMembershipConfigurationDraftRepository } from './membership-configuration-draft-repository.js'
import { MembershipConfigurationDraftService } from './membership-configuration-draft-service.js'
import { PromotionalLoyaltyService } from './promotional-loyalty-service.js'
import { PromotionalLoyaltyWorker } from './promotional-loyalty-worker.js'
import { ScopedPostgresTransactionRunner,type PostgresPool } from './transaction-runner.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
const id={
  tenant:randomUUID(),store:randomUUID(),manager:randomUUID(),ops:randomUUID(),owner:randomUUID(),
  managerRole:randomUUID(),opsRole:randomUUID(),ownerRole:randomUUID(),activity:randomUUID(),
  customer:randomUUID(),membership:randomUUID(),account:randomUUID(),registration:randomUUID(),payment:randomUUID(),
  nonMember:randomUUID(),nonMemberRegistration:randomUUID(),nonMemberPayment:randomUUID(),
  refundRaceCustomer:randomUUID(),refundRaceMembership:randomUUID(),refundRaceAccount:randomUUID(),
  refundRaceRegistration:randomUUID(),refundRacePayment:randomUUID(),
} as const
const scope={tenantId:id.tenant,storeId:id.store}

integration('promotional loyalty PostgreSQL authority',()=>{
  let pool:Pool
  let runner:ScopedPostgresTransactionRunner
  let service:PromotionalLoyaltyService
  let configuration:MembershipConfigurationDraftService
  let controls:LoyaltyOperationalControlService
  let worker:PromotionalLoyaltyWorker
  let effectiveFrom:string

  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:8})
    runner=new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const commands=new NormalizedCommandExecutor(runner)
    service=new PromotionalLoyaltyService(runner,commands)
    configuration=new MembershipConfigurationDraftService(
      new PostgresMembershipConfigurationDraftRepository(runner,scope),
    )
    controls=new LoyaltyOperationalControlService(runner,commands)
    worker=new PromotionalLoyaltyWorker(runner)
    await seed(pool)
    effectiveFrom=new Date(Date.now()+60_000).toISOString()
  })
  afterAll(async()=>pool?.end())

  it('uses configurable default roles and enforces independent draft, approve and publish',async()=>{
    const assigned=await pool.query(`
      SELECT role.code AS role_code,permission.code AS permission_code
      FROM mbox.role_permission_assignments assignment
      JOIN mbox.roles role ON role.id=assignment.role_id
      JOIN mbox.staff_permission_definitions permission ON permission.id=assignment.permission_id
      WHERE assignment.tenant_id=$1 AND assignment.store_id=$2
        AND permission.code LIKE 'loyalty.promotion.%'
      ORDER BY role.code,permission.code
    `,[id.tenant,id.store])
    expect(assigned.rows).toEqual([
      {role_code:'MANAGER',permission_code:'loyalty.promotion.manage'},
      {role_code:'MANAGER',permission_code:'loyalty.promotion.view'},
      {role_code:'OPS_LEAD',permission_code:'loyalty.promotion.approve'},
      {role_code:'OPS_LEAD',permission_code:'loyalty.promotion.view'},
      {role_code:'OWNER',permission_code:'loyalty.promotion.publish'},
      {role_code:'OWNER',permission_code:'loyalty.promotion.view'},
    ])
    const drafted=await service.draft(staff(id.manager),{
      campaignCode:'SUPERHIGH-OPENING',name:'超嗨到场积分',activityId:id.activity,
      stackingGroup:'SUPERHIGH',stackingMode:'exclusive_highest',priority:100,
      storeBudgetPoints:100,perMemberPointsLimit:100,pointValidityDays:180,
      refundPolicy:'reverse_on_any_refund',budgetReuseAfterRefund:false,
      memberLimitReuseAfterRefund:false,eligibleMemberLevels:['member','silver','gold'],
      rules:[
        {ruleCode:'PAID',triggerKind:'activity_payment',points:40,perMemberAwardLimit:1,minimumPaidAmountMinor:3000,enabled:true},
        {ruleCode:'CHECK-IN',triggerKind:'activity_check_in',points:60,perMemberAwardLimit:1,minimumPaidAmountMinor:0,enabled:true},
      ],reason:'限定100积分预算验证付款与签到闭环',idempotencyKey:'promotion-draft-pg-001',
    })
    await expect(service.approve(staff(id.manager),{
      policyId:drafted.value.id,reason:'起草人不能自批',idempotencyKey:'promotion-self-approve-pg-001',
    })).rejects.toMatchObject({code:'LOYALTY_PROMOTION_APPROVAL_DENIED'})
    await approvePromotion(configuration,drafted.value.id,id.ops,'预算、叠加和退款冲回已复核')
    await expect(service.publish(staff(id.ops),{
      policyId:drafted.value.id,effectiveFrom,effectiveUntil:null,
      reason:'审批人不能发布',idempotencyKey:'promotion-self-publish-pg-001',
    })).rejects.toMatchObject({code:'LOYALTY_PROMOTION_PUBLISHER_NOT_INDEPENDENT'})
    const published=await service.publish(staff(id.owner),{
      policyId:drafted.value.id,effectiveFrom,effectiveUntil:null,
      reason:'第三人确认后未来排期发布',idempotencyKey:'promotion-publish-pg-001',
    })
    expect(published.value).toMatchObject({status:'published',storeBudgetPoints:100,perMemberPointsLimit:100})
    expect((await service.configuration(staff(id.owner))).policies[0]).toMatchObject({
      status:'published',awardedPoints:0,remainingBudgetPoints:100,
    })
    const replacementDraft=await service.draft(staff(id.manager),{
      campaignCode:'SUPERHIGH-OPENING',name:'超嗨到场积分第二版',activityId:id.activity,
      stackingGroup:'SUPERHIGH',stackingMode:'exclusive_highest',priority:100,
      storeBudgetPoints:120,perMemberPointsLimit:100,pointValidityDays:180,
      refundPolicy:'reverse_on_any_refund',budgetReuseAfterRefund:false,
      memberLimitReuseAfterRefund:false,eligibleMemberLevels:['member','silver','gold'],
      rules:[
        {ruleCode:'PAID',triggerKind:'activity_payment',points:40,perMemberAwardLimit:1,minimumPaidAmountMinor:3000,enabled:true},
        {ruleCode:'CHECK-IN',triggerKind:'activity_check_in',points:60,perMemberAwardLimit:1,minimumPaidAmountMinor:0,enabled:true},
      ],reason:'验证未来版本精确切换且旧版不会提前停用',idempotencyKey:'promotion-draft-pg-002',
    })
    await approvePromotion(configuration,replacementDraft.value.id,id.ops,'复核第二版未来排期')
    const replacementEffectiveFrom=new Date(Date.parse(effectiveFrom)+3_600_000).toISOString()
    await service.publish(staff(id.owner),{
      policyId:replacementDraft.value.id,effectiveFrom:replacementEffectiveFrom,effectiveUntil:null,
      reason:'第三人发布第二版并精确衔接旧版',idempotencyKey:'promotion-publish-pg-002',
    })
    const windows=await pool.query(`SELECT version,status,
        effective_from=$3::timestamptz AS starts_at_first,
        effective_from=$4::timestamptz AS starts_at_replacement,
        effective_until=$4::timestamptz AS ends_at_replacement,
        effective_until IS NULL AS open_ended
      FROM mbox.loyalty_promotion_policy_versions
      WHERE tenant_id=$1 AND store_id=$2 AND campaign_code='SUPERHIGH-OPENING'
      ORDER BY version`,[id.tenant,id.store,effectiveFrom,replacementEffectiveFrom])
    expect(windows.rows).toEqual([
      {version:1,status:'published',starts_at_first:true,starts_at_replacement:false,ends_at_replacement:true,open_ended:false},
      {version:2,status:'published',starts_at_first:false,starts_at_replacement:true,ends_at_replacement:null,open_ended:true},
    ])
  })

  it('defers authoritative payment while accrual is paused and safely awards it once after resume',async()=>{
    await controls.set(staff(id.owner),{
      capability:'points_accrual',operation:'pause',reason:'促销积分上线前暂停核对',reviewAt:null,
      expectedVersion:0,idempotencyKey:'promotion-accrual-pause-pg-001',
    })
    await insertSucceededActivityPayment(pool,id.payment,id.registration,'member')
    const paused=await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')
    expect(paused).toMatchObject({claimed:1,awarded:0,deferred:1,paused:true})
    expect((await pool.query(`SELECT status,resolution_code,pause_control_version
      FROM mbox.loyalty_promotion_trigger_facts WHERE payment_id=$1`,[id.payment])).rows[0]).toEqual({
      status:'deferred',resolution_code:'points_accrual_paused',pause_control_version:1,
    })
    await controls.set(staff(id.owner),{
      capability:'points_accrual',operation:'resume',reason:'规则复核完成恢复发放',reviewAt:null,
      expectedVersion:1,idempotencyKey:'promotion-accrual-resume-pg-001',
    })
    const resumed=await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')
    const replay=await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')
    expect(resumed).toMatchObject({claimed:1,awarded:1,deferred:0,paused:false})
    expect(replay).toMatchObject({claimed:0,awarded:0})
    const facts=await pool.query(`
      SELECT account.available_points,award.awarded_points,award.credited_points,
        ledger.entry_type,ledger.source_type,ledger.points_delta,lot.remaining_points,
        (SELECT count(*)::integer FROM mbox.loyalty_promotion_awards WHERE payment_id=$1) AS award_count
      FROM mbox.loyalty_accounts account
      JOIN mbox.loyalty_promotion_awards award ON award.membership_id=account.membership_id
      JOIN mbox.loyalty_point_ledger ledger ON ledger.id=award.source_ledger_entry_id
      JOIN mbox.loyalty_point_lots lot ON lot.source_ledger_entry_id=ledger.id
      WHERE account.id=$2 AND award.payment_id=$1
    `,[id.payment,id.account])
    expect(facts.rows[0]).toEqual({
      available_points:40,awarded_points:40,credited_points:40,
      entry_type:'earn',source_type:'campaign',points_delta:40,remaining_points:40,award_count:1,
    })
  })

  it('awards check-in, records completion without a rule and never auto-enrolls a non-member',async()=>{
    await pool.query(`UPDATE mbox.community_activity_registrations
      SET status='checked_in',checked_in_at=$4::timestamptz
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[
      id.tenant,id.store,id.registration,new Date(Date.parse(effectiveFrom)+120_000).toISOString(),
    ])
    expect(await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')).toMatchObject({claimed:1,awarded:1})
    await insertSucceededActivityPayment(pool,id.nonMemberPayment,id.nonMemberRegistration,'non-member')
    expect(await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')).toMatchObject({claimed:1,notApplicable:1})
    expect((await pool.query(`SELECT count(*)::integer AS count FROM mbox.customer_memberships
      WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3`,[id.tenant,id.store,id.nonMember])).rows[0]?.count).toBe(0)
    await pool.query(`UPDATE mbox.community_activities SET status='completed',updated_at=$4::timestamptz
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[
      id.tenant,id.store,id.activity,new Date(Date.parse(effectiveFrom)+180_000).toISOString(),
    ])
    expect(await worker.runTriggerBatch(scope,'promotion-trigger-pg-worker')).toMatchObject({claimed:1,notApplicable:1})
    const account=(await pool.query(`SELECT available_points FROM mbox.loyalty_accounts WHERE id=$1`,[id.account])).rows[0]
    expect(account.available_points).toBe(100)
  })

  it('reverses every linked award once after authoritative refund even if accrual is paused',async()=>{
    await controls.set(staff(id.owner),{
      capability:'points_accrual',operation:'pause',reason:'退款期间暂停新增积分但不阻断冲回',reviewAt:null,
      expectedVersion:2,idempotencyKey:'promotion-refund-pause-pg-001',
    })
    await pool.query(`UPDATE mbox.payments SET status='refunded',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[id.tenant,id.store,id.payment])
    const refundId=randomUUID()
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,
      status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,5000,'CNY','succeeded','顾客活动退款',$7,$8,
      '店长发起后由独立收银复核通过',clock_timestamp())`,[
      refundId,id.tenant,id.store,id.payment,`promotion-refund-${refundId.slice(0,8)}`,
      `provider-refund-${refundId.slice(0,8)}`,id.manager,id.ops,
    ])
    const first=await worker.runRefundBatch(scope,'promotion-refund-pg-worker')
    const replay=await worker.runRefundBatch(scope,'promotion-refund-pg-worker')
    expect(first).toMatchObject({claimed:1,applications:2,reversedPoints:100})
    expect(replay).toMatchObject({claimed:0,applications:0,reversedPoints:0})
    const facts=await pool.query(`
      SELECT account.available_points,account.pending_recovery_points,
        membership.points_balance,
        (SELECT count(*)::integer FROM mbox.loyalty_promotion_refund_applications WHERE refund_id=$1) AS applications,
        (SELECT count(*)::integer FROM mbox.loyalty_point_ledger WHERE refund_id=$1 AND entry_type='reverse') AS ledgers,
        (SELECT count(*)::integer FROM mbox.loyalty_point_lots WHERE membership_id=$2 AND status='reversed') AS reversed_lots
      FROM mbox.loyalty_accounts account
      JOIN mbox.customer_memberships membership ON membership.id=account.membership_id
      WHERE account.id=$3
    `,[refundId,id.membership,id.account])
    expect(facts.rows[0]).toEqual({
      available_points:0,pending_recovery_points:0,points_balance:0,
      applications:2,ledgers:2,reversed_lots:2,
    })
    await expect(pool.query(`UPDATE mbox.loyalty_promotion_awards SET awarded_points=999
      WHERE tenant_id=$1 AND store_id=$2 AND membership_id=$3`,[id.tenant,id.store,id.membership])).rejects.toThrow()
  })

  it('serializes a refund racing its unapplied trigger and never closes the refund too early',async()=>{
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status)
      VALUES($1,$2,$3,'promotion-refund-race-member','active')`,[
      id.refundRaceCustomer,id.tenant,id.store,
    ])
    await pool.query(`INSERT INTO mbox.customer_memberships(
      id,tenant_id,store_id,customer_id,member_no,level,status
    ) VALUES($1,$2,$3,$4,'MBXREFUNDRACE','member','active')`,[
      id.refundRaceMembership,id.tenant,id.store,id.refundRaceCustomer,
    ])
    await pool.query(`INSERT INTO mbox.loyalty_accounts(
      id,tenant_id,store_id,membership_id,customer_id
    ) VALUES($1,$2,$3,$4,$5)`,[
      id.refundRaceAccount,id.tenant,id.store,id.refundRaceMembership,id.refundRaceCustomer,
    ])
    await insertRegistration(
      pool,id.refundRaceRegistration,id.refundRaceCustomer,id.refundRaceMembership,'refund-race',
    )
    await insertSucceededActivityPayment(pool,id.refundRacePayment,id.refundRaceRegistration,'refund-race')
    await pool.query(`UPDATE mbox.payments SET status='refunded',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[id.tenant,id.store,id.refundRacePayment])
    const refundId=randomUUID()
    await pool.query(`INSERT INTO mbox.refunds(
      id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,currency,
      status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at
    ) VALUES($1,$2,$3,$4,$5,$6,5000,'CNY','succeeded','并发退款验真',$7,$8,
      '独立复核通过后写入权威退款事实',clock_timestamp())`,[
      refundId,id.tenant,id.store,id.refundRacePayment,`promotion-race-${refundId.slice(0,8)}`,
      `provider-race-${refundId.slice(0,8)}`,id.manager,id.ops,
    ])
    await Promise.all([
      worker.runTriggerBatch(scope,'promotion-race-trigger-worker'),
      worker.runRefundBatch(scope,'promotion-race-refund-worker'),
    ])
    await worker.runRefundBatch(scope,'promotion-race-refund-worker')
    const facts=await pool.query(`
      SELECT trigger.status AS trigger_status,trigger.resolution_code AS trigger_resolution,
        refund.status AS refund_status,refund.resolution_code AS refund_resolution,
        (SELECT count(*)::integer FROM mbox.loyalty_promotion_awards award
          WHERE award.registration_id=$3) AS award_count
      FROM mbox.loyalty_promotion_trigger_facts trigger
      JOIN mbox.loyalty_promotion_refund_facts refund
        ON refund.tenant_id=trigger.tenant_id AND refund.store_id=trigger.store_id
       AND refund.registration_id=trigger.registration_id
      WHERE trigger.tenant_id=$1 AND trigger.store_id=$2
        AND trigger.registration_id=$3 AND trigger.trigger_kind='activity_payment'
    `,[id.tenant,id.store,id.refundRaceRegistration])
    expect(facts.rows[0]).toEqual({
      trigger_status:'not_applicable',trigger_resolution:'refunded',
      refund_status:'processed',refund_resolution:'no_promotion_award',award_count:0,
    })
  })
})

async function approvePromotion(
  configuration:MembershipConfigurationDraftService,policyId:string,
  approverEmployeeId:string,reason:string,
){
  const draft=await configuration.get('promotion_points',policyId)
  const preview=await configuration.preview('promotion_points',policyId,approverEmployeeId)
  return configuration.approve({domain:'promotion_points',publicId:policyId,
    expectedRevision:draft.revision,approverEmployeeId,reason,
    impactPreviewPublicId:preview.publicId})
}

function staff(employeeId:string){return {scope,employeeId,businessDate:'2026-08-16'}}

async function seed(pool:Pool){
  const suffix=id.tenant.replaceAll('-','').slice(0,10)
  await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Promotion Tenant')`,[id.tenant,`promo-${suffix}`])
  await pool.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'Promotion Store')`,[id.store,id.tenant,`promo-${suffix}`])
  await pool.query(`INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES
    ($1,$4,$5,'MANAGER','Manager'),($2,$4,$5,'OPS_LEAD','Ops'),($3,$4,$5,'OWNER','Owner')`,[
    id.managerRole,id.opsRole,id.ownerRole,id.tenant,id.store,
  ])
  await pool.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
    ($1,$4,$5,$6,'Manager','active'),($2,$4,$5,$7,'Ops','active'),($3,$4,$5,$8,'Owner','active')`,[
    id.manager,id.ops,id.owner,id.tenant,id.store,`PM-${suffix}`,`PO-${suffix}`,`PW-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,granted_by_employee_id) VALUES
    ($1,$2,$3,$4,$5),($1,$2,$5,$6,$5),($1,$2,$7,$8,$5)`,[
    id.tenant,id.store,id.manager,id.managerRole,id.ops,id.opsRole,id.owner,id.ownerRole,
  ])
  await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id,status) VALUES
    ($1,$3,$4,$5,'active'),($2,$3,$4,$6,'active')`,[
    id.customer,id.nonMember,id.tenant,id.store,`promotion-member-${suffix}`,`promotion-guest-${suffix}`,
  ])
  await pool.query(`INSERT INTO mbox.customer_memberships(
    id,tenant_id,store_id,customer_id,member_no,level,status
  ) VALUES($1,$2,$3,$4,$5,'member','active')`,[
    id.membership,id.tenant,id.store,id.customer,`MBX${suffix.toUpperCase()}`,
  ])
  await pool.query(`INSERT INTO mbox.loyalty_accounts(
    id,tenant_id,store_id,membership_id,customer_id
  ) VALUES($1,$2,$3,$4,$5)`,[id.account,id.tenant,id.store,id.membership,id.customer])
  await pool.query(`INSERT INTO mbox.community_activities(
    id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,
    assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,
    registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,
    points_reward,visibility,audience_member_levels,audience_lifecycle_stages,
    safety_policy_version,safety_acknowledgement_text,safety_requirements,
    refund_policy_version,refund_policy_summary,activity_details,included_items,
    participation_requirements,contact_instructions,member_benefit_text,status,
    published_at,created_by_employee_id,approved_by_employee_id
  ) VALUES(
    $1,$2,$3,'promotion-superhigh-event','member_night','超嗨会员活动','促销积分集成测试',
    clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 3 hours',
    'M-BOX陆家嘴店',20,5000,0,'per_registration','full_required',15,'须全额预付','CNY',
    0,'segment',ARRAY['member','silver','gold']::text[],'{}'::text[],
    'activity-safety-v1','我已阅读并同意安全要求',ARRAY['须年满18周岁']::text[],
    'activity-refund-v1','退款由店长发起、收银复核','现场音乐、会员交流与限定体验活动',ARRAY['欢迎饮品']::text[],
    ARRAY['提前到场']::text[],'在小程序查看联系说明','限定欢迎礼','published',
    clock_timestamp(),$4,$5
  )`,[id.activity,id.tenant,id.store,id.manager,id.ops])
  await insertRegistration(pool,id.registration,id.customer,id.membership,'member')
  await insertRegistration(pool,id.nonMemberRegistration,id.nonMember,null,'non-member')
}

async function insertRegistration(pool:Pool,registrationId:string,customerId:string,membershipId:string|null,label:string){
  await pool.query(`INSERT INTO mbox.community_activity_registrations(
    id,tenant_id,store_id,public_id,activity_id,customer_id,membership_id,party_size,status,
    payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,
    contact_snapshot,safety_acknowledgement,idempotency_key,refund_policy_snapshot,
    acknowledged_safety_policy_version,acknowledged_refund_policy_version,
    terms_acknowledged_at,terms_acknowledgement_source,
    requested_payment_choice,requested_payment_method,requested_amount_due_minor
  ) VALUES(
    $1,$2,$3,$4,$5,$6,$7,1,'confirmed','full','paid',5000,0,5000,'CNY',
    jsonb_build_object('contactType','phone','contactHash',repeat('a',64),
      'encryptedContact','AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=','encryptionKeyId','normalized-contact-v1',
      'maskedContact','138****8000','source','mini_program'),
    '{}'::jsonb,$8,jsonb_build_object('policyVersion','activity-refund-v1'),
    'activity-safety-v1','activity-refund-v1',clock_timestamp(),'mini_program',
    'full','jsapi',5000
  )`,[
    registrationId,id.tenant,id.store,`promotion-registration-${label}`,id.activity,
    customerId,membershipId,`promotion-registration-key-${label}`,
  ])
}

async function insertSucceededActivityPayment(pool:Pool,paymentId:string,registrationId:string,label:string){
  const occurred=new Date(Date.now()+120_000).toISOString()
  await pool.query(`INSERT INTO mbox.payments(
    id,tenant_id,store_id,payable_kind,activity_registration_id,public_id,
    provider,provider_transaction_id,method,amount_minor,currency,status,
    provider_snapshot,succeeded_at
  ) VALUES($1,$2,$3,'activity_registration',$4,$5,'postar',$6,'jsapi',5000,'CNY',
    'succeeded','{}'::jsonb,$7::timestamptz)`,[
    paymentId,id.tenant,id.store,registrationId,`promotion-payment-${label}`,
    `promotion-provider-${label}`,occurred,
  ])
  await pool.query(`UPDATE mbox.community_activity_registrations SET payment_id=$4
    WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[id.tenant,id.store,registrationId,paymentId])
}
