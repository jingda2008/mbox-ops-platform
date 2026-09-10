import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {Pool} from 'pg'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type PostgresPool} from './transaction-runner.js'
import {MemberGiftCampaignRepository} from './member-gift-campaign-repository.js'
import {CouponCalendarRepository} from './coupon-calendar-repository.js'
import {CustomerRepository} from './customer-repository.js'
import {MemberGiftDeliveryWorker} from './member-gift-delivery-worker.js'
import {MemberCardRepository} from './member-card-repository.js'
import {StackingPricingDraftRepository} from './stacking-pricing-draft-repository.js'
import {DEFAULT_STACKING_POLICY} from './stacking-pricing.js'
import {CheckoutCouponRepository} from './checkout-coupon-repository.js'
import {CheckoutUpgradePricingRepository} from './checkout-upgrade-pricing-repository.js'
import {CheckoutUpgradeManagementRepository} from './checkout-upgrade-management-repository.js'
import {CheckoutUpgradeEvaluationRepository} from './checkout-upgrade-evaluation-repository.js'
import {CheckoutUpgradeOpportunityRepository} from './checkout-upgrade-opportunity-repository.js'
import {BenefitRepository} from './benefit-repository.js'
import type {GuestSharedCart} from './guest-shared-cart-repository.js'
import {CheckoutCouponQuoteRepository} from './checkout-coupon-quote-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {seedActiveGuestTableAuthority} from './guest-table-authority.test-helper.js'
import {PricingAuthorizationPolicy} from './pricing-authorization-policy.js'
import {PostgresPricingAuthority} from './postgres-pricing-authority.js'
import {OrderRepository} from './order-repository.js'
import {CheckoutCouponLifecycleRepository,noCouponFulfillmentHistorySql} from './checkout-coupon-lifecycle-repository.js'
import {PaymentRepository} from './payment-repository.js'
import {CheckoutCouponRecoveryWorker} from './checkout-coupon-recovery-worker.js'
import {CheckoutCouponRefundReviewRepository,cashierCouponRefundReviewCountSql} from './checkout-coupon-refund-review-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
;(url?describe:describe.skip)('published member gift campaign delivery',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),editor=randomUUID(),approver=randomUUID(),publisher=randomUUID(),denied=randomUUID(),role=randomUUID(),productId=randomUUID()
  const scope={tenantId,storeId},businessDate='2026-09-09'
  let pool:Pool,runner:ScopedPostgresTransactionRunner,calendarId:string
  const run=<T>(action:(repo:MemberGiftCampaignRepository)=>Promise<T>)=>runner.run(scope,tx=>action(new MemberGiftCampaignRepository(tx)))
  beforeAll(async()=>{
    await runNormalizedMigrations(url!);pool=new Pool({connectionString:url,max:8});runner=new ScopedPostgresTransactionRunner({connect:()=>pool.connect(),end:()=>pool.end()} as PostgresPool)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Gift test')",[tenantId,`gift-${tenantId.slice(0,8)}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'gift-test','Gift test')",[storeId,tenantId])
    for(const [id,code] of [[editor,'EDITOR'],[approver,'APPROVER'],[publisher,'PUBLISHER'],[denied,'DENIED']])await pool.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)',[id,tenantId,storeId,code])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'GIFT_REVIEW','Gift review')",[role,tenantId,storeId])
    for(const employeeId of [editor,approver,publisher])await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 minute')",[tenantId,storeId,employeeId,role])
    for(const code of ['loyalty.configuration.edit','loyalty.configuration.view','loyalty.configuration.approve','loyalty.policy.publish','member.card.manage','member.card.review']){
      await pool.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT(tenant_id,store_id,code) DO NOTHING',[tenantId,storeId,code])
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4',[tenantId,storeId,role,code])
    }
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor) VALUES($1,$2,$3,'GIFT_SNACK','Test snack','snack','kitchen',100)",[productId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 day')",[tenantId,storeId,productId])
    const from=new Date(Date.now()-86400000).toISOString(),until=new Date(Date.now()+30*86400000).toISOString()
    const saved=await runner.run(scope,tx=>new CouponCalendarRepository(tx).save({code:'GIFT_CAL',rule:{timezone:'Asia/Shanghai',dateBasis:'natural',businessDayStartMinute:0,dateFrom:from.slice(0,10),dateThrough:until.slice(0,10),validFrom:from,validUntil:until,weekdays:[1,2,3,4,5,6,7],weekStartsOn:1,windows:[{startMinute:0,endMinute:1440}],excludedDates:[],relativeValidity:{days:3,basis:'elapsed'}},limits:{perCustomerDay:null,perCustomerWeek:null,perCustomerCampaign:null},employeeId:editor,businessDate,reason:'隔离发券测试',requestKey:randomUUID(),expectedVersion:0}))
    calendarId=saved.id
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await runner.run(scope,tx=>new CouponCalendarRepository(tx).decide({versionId:calendarId,action,employeeId,businessDate,reason:'隔离发券测试'}))
  })
  afterAll(async()=>pool?.end())
  async function customer(){const id=randomUUID();await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[id,tenantId,storeId,`gift-${id}`]);await pool.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no,level) VALUES($1,$2,$3,$4,'gold')",[tenantId,storeId,id,`MBX-${id.slice(0,18).toUpperCase()}`]);return id}
  async function campaign(overrides:Record<string,unknown>={}){
    const rule={trigger:'targeted',cardProjectId:null,audience:{minimumTier:'member',cardCodes:[],cardMatch:'any',tierAndCards:'and'},quantityPerCustomer:1,maximumQuantity:2,maximumDailyQuantity:2,maximumCostMinor:200,maximumDailyCostMinor:200,maximumUnitCostMinor:100,budgetDateBasis:'natural',budgetDayStartMinute:0,currency:'CNY',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),couponCalendarVersionId:calendarId,productIds:[productId],...overrides}
    const input={code:`GIFT_${randomUUID().slice(0,8).toUpperCase()}`,name:'测试赠品',rule,employeeId:editor,businessDate,reason:'隔离测试规则',requestKey:randomUUID()}
    const created=await run(repo=>repo.create(input))
    expect(await run(repo=>repo.create(input))).toEqual({...created,replayed:true})
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await run(repo=>repo.decide({versionId:created.versionId,action,employeeId,businessDate,reason:'核实预算规则'}))
    return created.versionId
  }
  it('issues once with frozen expiry and blocks a third grant at the aggregate budget',async()=>{
    const versionId=await campaign(),customers=await Promise.all([customer(),customer(),customer()])
    const jobs=[]
    for(const customerId of customers)jobs.push(await run(repo=>repo.enqueue({versionId,customerId,cycleKey:'launch'})))
    expect((await run(repo=>repo.deliver(jobs[0]!.jobId))).status).toBe('issued')
    expect(await run(repo=>repo.deliver(jobs[0]!.jobId))).toMatchObject({status:'issued',replayed:true})
    expect((await run(repo=>repo.deliver(jobs[1]!.jobId))).status).toBe('issued')
    expect(await run(repo=>repo.deliver(jobs[2]!.jobId))).toMatchObject({status:'blocked',reason:'campaign_quantity_exceeded'})
    const rows=(await pool.query('SELECT quantity_total,EXTRACT(epoch FROM(valid_until-valid_from))::int AS seconds FROM mbox.benefits WHERE tenant_id=$1 AND store_id=$2 AND customer_id=ANY($3::uuid[])',[tenantId,storeId,customers])).rows
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.quantity_total===1&&r.seconds===259200)).toBe(true)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(0)
  })
  it('budgets the costliest concrete bundle choice and rechecks cost increases before issuance',async()=>{
    const bundle=randomUUID(),base=randomUUID(),cheap=randomUUID(),expensive=randomUUID(),group=randomUUID()
    for(const [id,kind,cost] of [[bundle,'bundle',100],[base,'single',100],[cheap,'single',200],[expensive,'single',800]] as const){
      await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode,cost_amount_minor,guest_visible) VALUES($1,$2,$3,$4,'Isolated budget sample','snack',$5,'none','not_managed',$6,true)",[id,tenantId,storeId,'COST-'+id,kind,cost])
      await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',2000,'CNY',clock_timestamp()-interval '1 minute')",[tenantId,storeId,id])
    }
    await pool.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,1,1)',[tenantId,storeId,bundle,base])
    await pool.query("INSERT INTO mbox.product_bundle_choice_groups(id,tenant_id,store_id,bundle_product_id,code,display_name,selection_count) VALUES($1,$2,$3,$4,'CHOICE','任选一款',1)",[group,tenantId,storeId,bundle])
    for(const id of [cheap,expensive])await pool.query('INSERT INTO mbox.product_bundle_choice_options(tenant_id,store_id,choice_group_id,component_product_id,quantity) VALUES($1,$2,$3,$4,1)',[tenantId,storeId,group,id])
    // Future-visit coupons may be issued before tonight's selling window.
    await pool.query("UPDATE mbox.products SET available_from=((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 hour')::time,available_until=((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '2 hours')::time WHERE id=$1",[bundle])
    const budget={productIds:[bundle],maximumUnitCostMinor:500,maximumCostMinor:4000,maximumDailyCostMinor:4000}
    await expect(campaign(budget)).rejects.toThrow('预算不足')
    const versionId=await campaign({...budget,maximumUnitCostMinor:1000})
    expect((await pool.query('SELECT unit_cost_minor FROM mbox.member_gift_campaign_products WHERE campaign_version_id=$1',[versionId])).rows[0].unit_cost_minor).toBe('900')
    const first=await customer(),job=await run(repo=>repo.enqueue({versionId,customerId:first,cycleKey:'cost-first'}))
    expect(await run(repo=>repo.deliver(job.jobId))).toMatchObject({status:'issued'})
    expect((await pool.query('SELECT estimated_cost_minor FROM mbox.member_gift_delivery_jobs WHERE id=$1',[job.jobId])).rows[0].estimated_cost_minor).toBe('900')
    await pool.query('UPDATE mbox.products SET cost_amount_minor=1200 WHERE id=$1',[expensive])
    const nextCustomer=await customer()
    const next=await run(repo=>repo.enqueue({versionId,customerId:nextCustomer,cycleKey:'cost-increased'}))
    expect(await run(repo=>repo.deliver(next.jobId))).toMatchObject({status:'blocked',reason:'unit_cost_exceeded'})
    expect((await pool.query('SELECT quantity_total,quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE customer_id=$1',[first])).rows).toEqual([{quantity_total:1,quantity_reserved:0,quantity_redeemed:0}])
  })
  it('binds a fixed-price promise to immutable published terms without creating free orders or cash-value discounts',async()=>{
    const stacking=await runner.run(scope,tx=>new StackingPricingDraftRepository(tx).save({code:`LOW_${randomUUID().slice(0,8).toUpperCase()}`,policy:DEFAULT_STACKING_POLICY,employeeId:editor,businessDate,reason:'低价券独立计价',requestKey:randomUUID(),expectedVersion:0}))
    for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await runner.run(scope,tx=>new StackingPricingDraftRepository(tx).decide({versionId:stacking.id,action,employeeId,businessDate,reason:'低价券独立计价'}))
    const versionId=await campaign({pricingKind:'fixed_price',fixedPriceMinor:990,stackingVersionId:stacking.id}),customerId=await customer()
    expect((await run(repo=>repo.options(editor,'stacking',stacking.code))).items).toEqual(expect.arrayContaining([expect.objectContaining({id:stacking.id,code:stacking.code})]))
    const job=await run(repo=>repo.enqueue({versionId,customerId,cycleKey:'low-price'})),issued=await run(repo=>repo.deliver(job.jobId))
    expect(issued.status).toBe('issued')
    const row=(await pool.query(`SELECT b.id,b.benefit_type,b.value_amount_minor,p.fixed_price_minor,p.stacking_version_id,p.campaign_version_id FROM mbox.benefits b JOIN mbox.benefit_coupon_price_promises p ON p.benefit_id=b.id WHERE b.customer_id=$1`,[customerId])).rows[0]
    expect(row).toMatchObject({benefit_type:'discount',value_amount_minor:'0',fixed_price_minor:'990',stacking_version_id:stacking.id,campaign_version_id:versionId})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(0)
    await expect(pool.query('UPDATE mbox.benefit_coupon_price_promises SET fixed_price_minor=1 WHERE campaign_version_id=$1',[versionId])).rejects.toThrow()
    await expect(pool.query('UPDATE mbox.member_gift_campaign_versions SET fixed_price_minor=1 WHERE id=$1',[versionId])).rejects.toThrow('immutable')
    await runner.run(scope,tx=>new StackingPricingDraftRepository(tx).decide({versionId:stacking.id,action:'stop_issuing',employeeId:publisher,businessDate,reason:'停止新发不撤旧券'}))
    expect((await run(repo=>repo.options(editor,'stacking',stacking.code))).items).toHaveLength(0)
    const nextCustomer=await customer()
    const next=await run(repo=>repo.enqueue({versionId,customerId:nextCustomer,cycleKey:'stopped-rule'}))
    expect(await run(repo=>repo.deliver(next.jobId))).toMatchObject({status:'blocked',reason:'stacking_policy_closed'})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.benefit_coupon_price_promises WHERE campaign_version_id=$1',[versionId])).rows[0].n).toBe(1)
    const wallet=await runner.run(scope,tx=>new BenefitRepository(tx).listWalletForCustomer(customerId,null,20))
    expect(wallet.items[0]?.pricePromise).toMatchObject({kind:'fixed_price',fixedPriceMinor:990,products:[{id:productId,name:'Test snack'}]})
    const portionId=randomUUID(),cart:GuestSharedCart={id:randomUUID(),publicId:'isolated-coupon-quote',tableSessionId:randomUUID(),generation:1,version:1,status:'open',guestWritesFrozen:false,lines:[{productId,portionIds:[portionId],quantity:1,name:'Test snack',unitPriceMinor:1000,subtotalAmountMinor:1000,currency:'CNY',available:true,unavailableReason:null,bundleSelections:[]}],totalAmountMinor:1000,currency:'CNY',updatedAt:new Date().toISOString()}
    const quoteInput={customerId,cart,expectedGeneration:1,expectedVersion:1,selections:[{benefitId:row.id as string,portionId}],channel:'guest_qr' as const}
    const quote=await runner.run(scope,tx=>new CheckoutCouponRepository(tx).quote(quoteInput))
    expect(quote).toMatchObject({orderAuthorization:false,inventoryReserved:false,price:{subtotalMinor:1000,discountMinor:10,payableMinor:990}})
    expect(quote.lineAllocations[0]).toMatchObject({unitPriceMinor:1000,discountAmountMinor:10})
    await expect(runner.run(scope,tx=>new CheckoutUpgradePricingRepository(tx).compare({cart,customerId,portionId,targetProductId:randomUUID(),selections:quoteInput.selections,channel:'guest_qr'}),{readOnly:true})).rejects.toThrow('商品池')
    const upgradeSource=randomUUID(),upgradeTarget=randomUUID(),upgradePortion=randomUUID()
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode,cost_amount_minor,guest_visible) VALUES($1,$3,$4,'COMPARE-SOURCE','Compare source','test','single','none','not_managed',100,true),($2,$3,$4,'COMPARE-TARGET','Compare target','test','bundle','none','not_managed',200,true)`,[upgradeSource,upgradeTarget,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',2000,'CNY',clock_timestamp()-interval '1 day'),($1,$2,$4,'standard',3000,'CNY',clock_timestamp()-interval '1 day')`,[tenantId,storeId,upgradeSource,upgradeTarget])
    await pool.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,2,1)',[tenantId,storeId,upgradeTarget,upgradeSource])
    const comparisonCart:GuestSharedCart={...cart,lines:[...cart.lines,{...cart.lines[0]!,productId:upgradeSource,portionIds:[upgradePortion],name:'Compare source'}]}
    const comparison=await runner.run(scope,tx=>new CheckoutUpgradePricingRepository(tx).compare({cart:comparisonCart,customerId,portionId:upgradePortion,targetProductId:upgradeTarget,selections:quoteInput.selections,channel:'guest_qr'}),{readOnly:true})
    expect(comparison).toMatchObject({pricingBasis:'fixed_coupon_and_standard',cartChanged:false,inventoryReserved:false,addedPayableMinor:1000,before:{price:{payableMinor:2990,discountMinor:10}},after:{price:{payableMinor:3990,discountMinor:10}}})
    expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
    const otherCustomer=await customer()
    await expect(runner.run(scope,tx=>new CheckoutCouponRepository(tx).quote({...quoteInput,customerId:otherCustomer}))).rejects.toThrow('不属于')
    await expect(runner.run(scope,tx=>new CheckoutCouponRepository(tx).quote({...quoteInput,selections:[{benefitId:row.id as string,portionId:randomUUID()}]}))).rejects.toThrow('商品池')
    expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
    const areaId=randomUUID(),tableId=randomUUID(),sessionId=randomUUID()
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'QUOTE','Quote','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'QUOTE01','QUOTE01',2)",[tableId,tenantId,storeId,areaId])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'coupon-quote-session',CURRENT_DATE,2,'open')",[sessionId,tenantId,storeId,tableId])
    const originalMode=(await pool.query('SELECT inventory_control_mode FROM mbox.products WHERE id=$1',[productId])).rows[0].inventory_control_mode
    await pool.query("UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1",[productId])
    try{
      let currentCart=await runner.run(scope,async tx=>{
        const carts=new GuestSharedCartRepository(tx),opened=await carts.readOpen(sessionId,`GSC${randomUUID().replaceAll('-','').toUpperCase()}`)
        await tx.query('INSERT INTO mbox.guest_shared_cart_lines(tenant_id,store_id,cart_id,product_id,quantity) VALUES($1,$2,$3,$4,1)',[tenantId,storeId,opened.id,productId])
        await tx.query('UPDATE mbox.guest_shared_carts SET version=version+1 WHERE id=$1',[opened.id])
        return carts.readOpen(sessionId,opened.publicId)
      })
      const retainedCouponPortion=currentCart.lines[0]!.portionIds![0]!
      const withSource=await runner.run(scope,tx=>new GuestSharedCartRepository(tx).adjust(sessionId,currentCart.publicId,{productId:upgradeSource,delta:1,expectedGeneration:currentCart.generation,expectedVersion:currentCart.version,operationId:'coupon-upgrade-add-source',actorSessionRef:'guest:coupon-upgrade-test'}))
      const rule=await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).insertRuleDraft({code:'COUPON_UPGRADE_INTEGRATION',name:'Coupon upgrade integration',sourceProductId:upgradeSource,targetProductId:upgradeTarget,minimumPartySize:1,maximumPartySize:4,occasionTags:[],alcoholPreferenceTags:[],promptTitle:'保留原选择',promptBody:'原券仍在另一份小食使用',callToAction:'核对升级',priority:1,offerValidMinutes:5,minimumGrossMarginBasisPoints:1000,employeeId:editor,qualification:{maximumAddMinor:1000,maximumAddBasisPoints:6000,minimumContributionMinor:1000,minimumIncrementalContributionMinor:100,positiveFitReason:'保留具体原饮品与其他商品券，增量份数适配两人',maximumQuantitiesPerPerson:[{productId:upgradeSource,quantity:1}],excludedProductIds:[]}}))
      await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).approveRule(rule.id,approver,'核对用券'))
      await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).publishRule(rule.id,publisher,'仅隔离库'))
      const capacity=await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).draftCapacity({stationCode:'kitchen',reason:'隔离测试用券小食的实际制作能力',employeeId:editor,windows:[{startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),capacityLimitUnits:100}]}))
      await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).approveCapacity(capacity.id,approver))
      await runner.run(scope,tx=>new CheckoutUpgradeManagementRepository(tx).publishCapacity(capacity.id,publisher))
      const upgradeInput={ruleId:rule.id,tableSessionId:sessionId,customerId,portionId:withSource.lines.find(line=>line.productId===upgradeSource)!.portionIds![0]!,expectedGeneration:withSource.generation,expectedVersion:withSource.version,occasion:null,alcoholPreference:null,selections:[{benefitId:row.id as string,portionId:retainedCouponPortion}]}
      const eligible=await runner.run(scope,tx=>new CheckoutUpgradeEvaluationRepository(tx).evaluate(upgradeInput),{readOnly:true})
      if(!eligible.eligible)throw new Error('Expected isolated coupon upgrade: '+eligible.reason)
      const offer=await runner.run(scope,tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(eligible,{customerId,requestKey:'coupon-upgrade-opportunity'}))
      await pool.query("INSERT INTO mbox.customer_experience_features(tenant_id,store_id,feature_code,rollout_state,reason,approved_by_employee_id) VALUES($1,$2,'checkout_upgrade','pilot','仅隔离测试用券升级',$3) ON CONFLICT(tenant_id,store_id,feature_code) DO UPDATE SET rollout_state='pilot'",[tenantId,storeId,publisher])
      const accepted=await runner.run(scope,async tx=>{
        await tx.query('SET LOCAL ROLE mbox_runtime')
        return new CheckoutUpgradeOpportunityRepository(tx).accept(offer!.id,{customerId,tableSessionId:sessionId,actorSessionRef:'guest:coupon-upgrade-test'})
      })
      expect(accepted.opportunity).toMatchObject({status:'accepted',upgradedPayableMinor:3990})
      expect(accepted.opportunity!.acceptedQuoteId).toBeTruthy()
      const upgradedQuote=await runner.run(scope,tx=>new CheckoutCouponQuoteRepository(tx).find(accepted.opportunity!.acceptedQuoteId!,customerId))
      expect(upgradedQuote).toMatchObject({payableMinor:3990,discountMinor:10,current:true,couponsReserved:false})
      expect(upgradedQuote.lines.find(line=>line.benefitId===row.id)?.portionId).toBe(retainedCouponPortion)
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
      const noUpgradePolicy=await runner.run(scope,tx=>new StackingPricingDraftRepository(tx).save({code:'AFTER_UPGRADE_DENY',policy:{...DEFAULT_STACKING_POLICY,allowBundlePrice:true,allowCheckoutUpgrade:false},employeeId:editor,businessDate,reason:'先升级后选券也不得绕过',requestKey:randomUUID(),expectedVersion:0}))
      for(const [action,employeeId] of [['approve',approver],['publish',publisher]] as const)await runner.run(scope,tx=>new StackingPricingDraftRepository(tx).decide({versionId:noUpgradePolicy.id,action,employeeId,businessDate,reason:'核对升级限制'}))
      const noUpgradeCampaign=await campaign({pricingKind:'fixed_price',fixedPriceMinor:2500,stackingVersionId:noUpgradePolicy.id,productIds:[upgradeTarget],maximumUnitCostMinor:500,maximumCostMinor:1000,maximumDailyCostMinor:1000})
      const noUpgradeJob=await run(repo=>repo.enqueue({versionId:noUpgradeCampaign,customerId,cycleKey:'after-upgrade'}))
      const noUpgradeGift=await run(repo=>repo.deliver(noUpgradeJob.jobId))
      if(noUpgradeGift.status!=='issued')throw new Error('Expected isolated fixed coupon')
      const noUpgradeBenefit=(await pool.query('SELECT benefit_id FROM mbox.member_gift_delivery_jobs WHERE id=$1',[noUpgradeJob.jobId])).rows[0].benefit_id as string
      await expect(runner.run(scope,tx=>new CheckoutCouponRepository(tx).quote({customerId,cart:accepted.cart!,expectedGeneration:accepted.cart!.generation,expectedVersion:accepted.cart!.version,selections:[{benefitId:noUpgradeBenefit,portionId:accepted.opportunity!.replacementPortionId!}],channel:'guest_qr'}))).rejects.toThrow('不能用于升级套餐')
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[noUpgradeBenefit])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
      currentCart=await runner.run(scope,tx=>new GuestSharedCartRepository(tx).removeLine(sessionId,currentCart.publicId,{productId:upgradeTarget,expectedGeneration:accepted.cart!.generation,expectedVersion:accepted.cart!.version,operationId:'coupon-upgrade-remove-target',actorSessionRef:'guest:coupon-upgrade-test'}))
      expect(await runner.run(scope,tx=>new CheckoutCouponQuoteRepository(tx).find(upgradedQuote.id,customerId))).toMatchObject({current:false})
      const prepareInput={customerId,tableSessionId:sessionId,expectedGeneration:currentCart.generation,expectedVersion:currentCart.version,selections:[{benefitId:row.id as string,portionId:currentCart.lines[0]!.portionIds![0]!}],requestKey:randomUUID()}
      const prepare=()=>runner.run(scope,tx=>new CheckoutCouponQuoteRepository(tx).prepare(prepareInput))
      const prepared=await prepare()
      expect(prepared).toMatchObject({current:true,payableMinor:990,couponsReserved:false,orderAuthorization:false,replayed:false})
      expect(await prepare()).toEqual({...prepared,replayed:true})
      await expect(pool.query(`INSERT INTO mbox.checkout_coupon_quote_lines SELECT tenant_id,store_id,quote_id,99,portion_id,product_id,standard_minor,discount_minor,line_fingerprint,benefit_id FROM mbox.checkout_coupon_quote_lines WHERE quote_id=$1 LIMIT 1`,[prepared.id])).rejects.toThrow('Sealed quote')
      await expect(runner.run(scope,tx=>tx.query(`INSERT INTO mbox.checkout_coupon_quotes(tenant_id,store_id,cart_id,cart_generation,cart_version,table_session_id,customer_id,subtotal_minor,discount_minor,payable_minor,currency,expires_at,request_key,request_fingerprint) SELECT tenant_id,store_id,cart_id,cart_generation,cart_version,table_session_id,customer_id,subtotal_minor,discount_minor,payable_minor,currency,expires_at,$2,request_fingerprint FROM mbox.checkout_coupon_quotes WHERE id=$1`,[prepared.id,randomUUID()]))).rejects.toThrow('sealed')
      await expect(runner.run(scope,tx=>new CheckoutCouponQuoteRepository(tx).find(prepared.id,otherCustomer))).rejects.toThrow('不属于')
      await expect(pool.query('UPDATE mbox.checkout_coupon_quote_lines SET discount_minor=1000 WHERE quote_id=$1',[prepared.id])).rejects.toThrow()
      await pool.query('UPDATE mbox.guest_shared_carts SET version=version+1 WHERE id=$1',[currentCart.id])
      expect(await prepare()).toMatchObject({id:prepared.id,current:false,replayed:true})
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
      await pool.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')",[tenantId,storeId,sessionId,customerId])
      const actorRef=await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId:sessionId,customerId})
      const ready=await runner.run(scope,tx=>new CheckoutCouponQuoteRepository(tx).prepare({...prepareInput,expectedVersion:prepareInput.expectedVersion+1,requestKey:randomUUID()}))
      const lines=[{productId,quantity:1}]
      const pricePolicy=new PricingAuthorizationPolicy(new PostgresPricingAuthority())
      const authorize=async(tx:Parameters<Parameters<typeof runner.run>[1]>[0])=>{
        await tx.query("UPDATE mbox.guest_shared_carts SET status='submitting',version=version+1 WHERE id=$1",[currentCart.id])
        return pricePolicy.authorize(tx,{scope,actor:{type:'guest',ref:actorRef},tableSessionId:sessionId,channel:'guest_qr',lines},{sourceType:'checkout_quote',sourceId:ready.id})
      }
      await expect(runner.run(scope,async tx=>{await authorize(tx);throw new Error('injected order failure')})).rejects.toThrow('injected order failure')
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
      const placed=await runner.run(scope,async tx=>{
        const authority=await authorize(tx)
        const order=await new OrderRepository(tx).createSubmitted({tableSessionId:sessionId,publicId:`coupon-order-${randomUUID()}`,channel:'guest_qr',settlementMode:'immediate_payment',createdByCustomerId:customerId,lines},authority)
        await pricePolicy.consume(tx,authority!,order.id)
        return order
      })
      expect(placed).toMatchObject({totalAmountMinor:990,discountAmountMinor:10})
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:1,quantity_redeemed:0})
      expect((await pool.query('SELECT order_id FROM mbox.checkout_coupon_order_links WHERE quote_id=$1',[ready.id])).rows[0].order_id).toBe(placed.id)
      const complete=()=>runner.run(scope,tx=>new CheckoutCouponLifecycleRepository(tx).redeemPaidOrder(placed.id))
      await expect(complete()).rejects.toThrow('confirmed paid')
      const temporarilyCancel=(tx:Parameters<Parameters<typeof runner.run>[1]>[0])=>tx.query("UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),fulfillment_state='cancelled',fulfillment_expires_at=NULL,fulfillment_activated_at=NULL,fulfillment_released_at=clock_timestamp() WHERE id=$1",[placed.id])
      await expect(runner.run(scope,async tx=>{
        await temporarilyCancel(tx)
        expect(await new CheckoutCouponLifecycleRepository(tx).releaseCancelledOrderHolds(placed.id)).toEqual({released:1})
        expect(await new CheckoutCouponLifecycleRepository(tx).releaseCancelledOrderHolds(placed.id)).toEqual({released:0})
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
        throw Error('restore isolated unpaid cancellation branch')
      })).rejects.toThrow('restore isolated unpaid cancellation branch')
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:1,quantity_redeemed:0})
      const payment=await runner.run(scope,tx=>new PaymentRepository(tx).createForOrder({orderId:placed.id,publicId:`coupon-pay-${randomUUID()}`,provider:'simulation',method:'jsapi',initialStatus:'pending',principal:{type:'guest',tableSessionId:sessionId,customerId,guestSessionId:actorRef.slice('guest-session:'.length)}}))
      await expect(complete()).rejects.toThrow('confirmed paid')
      await expect(runner.run(scope,async tx=>{
        await temporarilyCancel(tx)
        expect(await new CheckoutCouponLifecycleRepository(tx).releaseCancelledOrderHolds(placed.id)).toEqual({released:0})
        throw Error('restore isolated unknown payment branch')
      })).rejects.toThrow('restore isolated unknown payment branch')
      expect(await new CheckoutCouponRecoveryWorker(runner).runBatch(scope,'coupon-test-worker')).toMatchObject({examined:0,released:0,failed:0})
      await runner.run(scope,async tx=>{
        const payments=new PaymentRepository(tx)
        await payments.applySucceededCallback({paymentPublicId:payment.publicId,provider:'simulation',providerTransactionId:`isolated-${randomUUID()}`,reportedAmountMinor:990,reportedCurrency:'CNY'})
        await payments.syncOrderPaymentStatus(placed.id)
      })
      expect(await complete()).toEqual({redeemed:1})
      expect(await complete()).toEqual({redeemed:0})
      await expect(runner.run(scope,async tx=>{
        await tx.query("UPDATE mbox.orders SET fulfillment_state='active',fulfillment_activated_at=clock_timestamp(),fulfillment_expires_at=NULL WHERE id=$1",[placed.id])
        await tx.query(`INSERT INTO mbox.kds_tasks(tenant_id,store_id,order_item_id,station_code,quantity,status,accepted_at,cancelled_at)
          SELECT tenant_id,store_id,id,'kitchen',quantity,'cancelled',clock_timestamp(),clock_timestamp() FROM mbox.order_items WHERE order_id=$1 LIMIT 1`,[placed.id])
        expect((await tx.query<{safe:boolean}>(`SELECT ${noCouponFulfillmentHistorySql} AS safe FROM mbox.orders o WHERE o.id=$1`,[placed.id])).rows[0]?.safe).toBe(false)
        await temporarilyCancel(tx)
        expect(await new CheckoutCouponLifecycleRepository(tx).releaseCancelledOrderHolds(placed.id)).toEqual({released:0})
        throw Error('restore isolated produced cancellation branch')
      })).rejects.toThrow('restore isolated produced cancellation branch')
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:1})
      expect((await pool.query('SELECT count(*)::int AS n FROM mbox.benefit_redemptions WHERE benefit_id=$1',[row.id])).rows[0].n).toBe(1)
      const refundId=randomUUID(),reservationId=(await pool.query('SELECT reservation_id FROM mbox.checkout_coupon_quote_reservations WHERE quote_id=$1',[ready.id])).rows[0].reservation_id as string
      const reviews=<T>(work:(repo:CheckoutCouponRefundReviewRepository)=>Promise<T>)=>runner.run(scope,tx=>work(new CheckoutCouponRefundReviewRepository(tx)))
      const decision={employeeId:publisher,businessDate,refundId,reservationId,action:'no_return' as const,reason:'已制作商品按原规则不返券',evidenceReference:'隔离测试原规则及客服记录'}
      // Local financial-state fixture only; no live refund or provider call.
      await pool.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason)
        VALUES($1,$2,$3,$4,$5,100,'processing','隔离部分退款',$6,$7,'隔离审核')`,[refundId,tenantId,storeId,payment.id,`coupon-refund-${randomUUID()}`,editor,approver])
      expect((await reviews(repo=>repo.list(editor))).items).toHaveLength(0)
      await expect(reviews(repo=>repo.decide(decision))).rejects.toThrow('退款未成功')
      await pool.query("UPDATE mbox.refunds SET status='succeeded',provider_refund_id=$2,completed_at=clock_timestamp() WHERE id=$1",[refundId,`isolated-refund-${randomUUID()}`])
      expect((await reviews(repo=>repo.list(editor))).items).toMatchObject([{refund_id:refundId,reservation_id:reservationId,refund_amount_minor:'100',status:'redeemed'}])
      expect((await pool.query(`SELECT ${cashierCouponRefundReviewCountSql} AS n FROM mbox.orders orders WHERE id=$1`,[placed.id])).rows[0].n).toBe(1)
      await expect(reviews(repo=>repo.decide({...decision,employeeId:denied}))).rejects.toThrow()
      await expect(reviews(repo=>repo.decide({...decision,reservationId:randomUUID()}))).rejects.toThrow('不属于同一订单')
      expect(await reviews(repo=>repo.decide(decision))).toEqual({recorded:true,replayed:false})
      expect(await reviews(repo=>repo.decide(decision))).toEqual({recorded:true,replayed:true})
      await expect(reviews(repo=>repo.decide({...decision,action:'external_compensation'}))).rejects.toThrow('不能覆盖历史')
      expect((await reviews(repo=>repo.list(editor))).items).toHaveLength(0)
      expect((await reviews(repo=>repo.list(editor,'resolved'))).items).toMatchObject([{action:'no_return',reason:decision.reason}])
      expect((await pool.query(`SELECT ${cashierCouponRefundReviewCountSql} AS n FROM mbox.orders orders WHERE id=$1`,[placed.id])).rows[0].n).toBe(0)
      await expect(pool.query("UPDATE mbox.checkout_coupon_refund_decisions SET reason='修改历史' WHERE refund_id=$1",[refundId])).rejects.toThrow('append-only')
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[row.id])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:1})
      expect((await pool.query('SELECT amount_minor FROM mbox.refunds WHERE id=$1',[refundId])).rows[0].amount_minor).toBe('100')
      const secondRefundId=randomUUID()
      const successfulRefundFixture=(id:string)=>pool.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at,provider_refund_id)
        VALUES($1,$2,$3,$4,$5,100,'succeeded','隔离部分退款',$6,$7,'隔离审核',clock_timestamp(),$8)`,[id,tenantId,storeId,payment.id,`coupon-refund-${randomUUID()}`,editor,approver,`isolated-refund-${randomUUID()}`])
      await successfulRefundFixture(secondRefundId)
      const thirdRefundId=randomUUID();await successfulRefundFixture(thirdRefundId)
      const replacementCampaign=await campaign(),replacementJob=await run(repo=>repo.enqueue({versionId:replacementCampaign,customerId,cycleKey:'replacement'}))
      const replacement=await run(repo=>repo.deliver(replacementJob.jobId));expect(replacement.status).toBe('issued')
      const replacementId='benefitId' in replacement?replacement.benefitId:''
      const otherReplacementJob=await run(repo=>repo.enqueue({versionId:replacementCampaign,customerId:otherCustomer,cycleKey:'replacement'}))
      const otherReplacement=await run(repo=>repo.deliver(otherReplacementJob.jobId));expect(otherReplacement.status).toBe('issued')
      const otherReplacementId='benefitId' in otherReplacement?otherReplacement.benefitId:''
      const replacementDecision={...decision,refundId:secondRefundId,action:'replacement_coupon' as const,replacementBenefitId:replacementId,reason:'双方确认补发一份小食，关联已有活动实际发券'}
      const choices=await reviews(repo=>repo.replacementOptions(publisher,secondRefundId,reservationId))
      expect(choices.items).toEqual(expect.arrayContaining([expect.objectContaining({id:replacementId,quantity_total:1})]))
      expect(choices.items.some(item=>item.id===otherReplacementId)).toBe(false)
      await expect(reviews(repo=>repo.decide({...replacementDecision,replacementBenefitId:otherReplacementId}))).rejects.toThrow('补偿券不存在')
      await expect(reviews(repo=>repo.decide({...replacementDecision,replacementBenefitId:row.id as string}))).rejects.toThrow('补偿券不存在')
      await expect(reviews(repo=>repo.decide({...replacementDecision,replacementBenefitId:randomUUID()}))).rejects.toThrow('补偿券不存在')
      expect(await reviews(repo=>repo.decide(replacementDecision))).toEqual({recorded:true,replayed:false})
      expect(await reviews(repo=>repo.decide(replacementDecision))).toEqual({recorded:true,replayed:true})
      expect((await reviews(repo=>repo.list(editor,'resolved'))).items).toEqual(expect.arrayContaining([expect.objectContaining({refund_id:secondRefundId,action:'replacement_coupon',replacement_benefit_id:replacementId,replacement_quantity:1})]))
      expect((await reviews(repo=>repo.replacementOptions(publisher,secondRefundId,reservationId))).items.some(item=>item.id===replacementId)).toBe(false)
      // Already issued through an approved campaign, not minted or consumed by review.
      expect((await pool.query('SELECT quantity_reserved,quantity_redeemed FROM mbox.benefits WHERE id=$1',[replacementId])).rows[0]).toEqual({quantity_reserved:0,quantity_redeemed:0})
      await expect(reviews(repo=>repo.decide({...replacementDecision,refundId:thirdRefundId}))).rejects.toThrow('不能重复使用')
      await expect(pool.query(`INSERT INTO mbox.checkout_coupon_refund_decisions(tenant_id,store_id,refund_id,reservation_id,action,reason,evidence_reference,decided_by_employee_id,replacement_benefit_id,replacement_quantity) VALUES($1,$2,$3,$4,'replacement_coupon','隔离越权反例','隔离凭证',$5,$6,1)`,[tenantId,storeId,thirdRefundId,reservationId,publisher,otherReplacementId])).rejects.toThrow('same customer')
    }finally{await pool.query('UPDATE mbox.products SET inventory_control_mode=$2 WHERE id=$1',[productId,originalMode])}
  })
  it('cannot reuse a merged identity to receive the same campaign cycle twice',async()=>{
    const versionId=await campaign(),source=await customer(),target=await customer()
    const job=await run(repo=>repo.enqueue({versionId,customerId:source,cycleKey:'launch'}));await run(repo=>repo.deliver(job.jobId))
    await runner.run(scope,tx=>new CustomerRepository(tx).merge(source,target))
    expect(await run(repo=>repo.enqueue({versionId,customerId:target,cycleKey:'launch'}))).toMatchObject({jobId:job.jobId,status:'issued',replayed:true})
    await expect(pool.query("UPDATE mbox.member_gift_delivery_jobs SET status='pending',benefit_id=NULL,completed_at=NULL WHERE id=$1",[job.jobId])).rejects.toThrow('immutable')
  })
  it('blocks stopped campaigns without revoking issued benefits or disguising legacy grade as a live tier',async()=>{
    const versionId=await campaign(),customerId=await customer(),job=await run(repo=>repo.enqueue({versionId,customerId,cycleKey:'before'}))
    const result=await run(repo=>repo.deliver(job.jobId));expect(result.status).toBe('issued')
    await expect(run(repo=>repo.decide({versionId,action:'stop',employeeId:denied,businessDate,reason:'无权停发'}))).rejects.toThrow()
    await run(repo=>repo.decide({versionId,action:'stop',employeeId:publisher,businessDate,reason:'活动停止新发'}))
    await expect(run(repo=>repo.enqueue({versionId,customerId,cycleKey:'after'}))).rejects.toThrow('不接受')
    expect((await pool.query('SELECT status FROM mbox.benefits WHERE id=$1',['benefitId' in result?result.benefitId:null])).rows[0].status).toBe('issued')
    const gold=await campaign({audience:{minimumTier:'gold',cardCodes:[],cardMatch:'any',tierAndCards:'and'}})
    await expect(run(repo=>repo.enqueue({versionId:gold,customerId,cycleKey:'launch'}))).rejects.toThrow('不符合')
    await expect(pool.query('UPDATE mbox.member_gift_campaign_versions SET maximum_cost_minor=999 WHERE id=$1',[versionId])).rejects.toThrow('immutable')
    await expect(pool.query('UPDATE mbox.member_gift_campaign_products SET unit_cost_minor=0 WHERE campaign_version_id=$1',[versionId])).rejects.toThrow('immutable')
  })
  it('persists retry backoff across worker instances and recovers without duplicate issuance',async()=>{
    const versionId=await campaign(),customerId=await customer(),job=await run(repo=>repo.enqueue({versionId,customerId,cycleKey:'retry'}))
    await pool.query('UPDATE mbox.products SET cost_amount_minor=NULL WHERE id=$1',[productId])
    try{
      await new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-test-worker')
      const row=(await pool.query('SELECT status,attempts,next_attempt_at>clock_timestamp() AS delayed FROM mbox.member_gift_delivery_jobs WHERE id=$1',[job.jobId])).rows[0]
      expect(row).toMatchObject({status:'blocked',attempts:1,delayed:true})
      await new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-test-restarted')
      expect((await pool.query('SELECT attempts FROM mbox.member_gift_delivery_jobs WHERE id=$1',[job.jobId])).rows[0].attempts).toBe(1)
    }finally{await pool.query('UPDATE mbox.products SET cost_amount_minor=100 WHERE id=$1',[productId])}
    await pool.query('UPDATE mbox.member_gift_delivery_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1',[job.jobId])
    await Promise.all([new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-worker-one'),new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-worker-two')])
    expect((await pool.query('SELECT status,attempts FROM mbox.member_gift_delivery_jobs WHERE id=$1',[job.jobId])).rows[0]).toMatchObject({status:'issued',attempts:2})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.benefits WHERE customer_id=$1',[customerId])).rows[0].n).toBe(1)
  })
  it('serializes concurrent different-customer grants at a shared campaign budget',async()=>{
    const versionId=await campaign({maximumQuantity:1,maximumDailyQuantity:1,maximumCostMinor:100,maximumDailyCostMinor:100})
    const ids=await Promise.all([customer(),customer()]),jobs=[]
    for(const customerId of ids)jobs.push(await run(repo=>repo.enqueue({versionId,customerId,cycleKey:'concurrent'})))
    await Promise.allSettled(jobs.map(j=>run(repo=>repo.deliver(j.jobId))))
    for(const job of jobs)await run(repo=>repo.deliver(job.jobId))
    expect((await pool.query("SELECT count(*)::int AS n,sum(estimated_cost_minor)::int AS cost FROM mbox.member_gift_delivery_jobs WHERE campaign_version_id=$1 AND status='issued'",[versionId])).rows[0]).toEqual({n:1,cost:100})
  })
  it('recovers a committed approval after campaign stop, retains a visible obligation and never rewrites the card',async()=>{
    const customerId=await customer()
    const project=await runner.run(scope,tx=>new MemberCardRepository(tx).createProject({code:`ENTRY_${randomUUID().slice(0,8).toUpperCase()}`,name:'入卡礼测试',terms:'领取资格与营销许可独立，赠券以审批活动为准。',kind:'interest',availableFrom:new Date(Date.now()-3600000).toISOString(),availableUntil:new Date(Date.now()+86400000).toISOString(),cooperationConfirmed:false,cooperationValidUntil:null,cooperationReference:null,employeeId:editor,businessDate}))
    await runner.run(scope,tx=>new MemberCardRepository(tx).setProjectState({projectId:project.projectId,state:'open',employeeId:publisher,businessDate,reason:'开放测试卡'}))
    const versionId=await campaign({trigger:'card_entry',cardProjectId:project.projectId})
    const application=await runner.run(scope,tx=>new MemberCardRepository(tx).apply({projectId:project.projectId,customerId,acceptedProjectVersion:1,businessDate}))
    const approved=await runner.run(scope,tx=>new MemberCardRepository(tx).review({applicationId:application.applicationId,decision:'approve',employeeId:approver,businessDate,reason:'一人审核通过'}))
    // Simulates no running grant worker between approval and stop.
    await run(repo=>repo.decide({versionId,action:'stop',employeeId:publisher,businessDate,reason:'停发后核对遗留任务'}))
    await new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-recovery')
    const jobs=await run(repo=>repo.selfJobs(customerId))
    expect(jobs.items).toHaveLength(1);expect(jobs.items[0]).toMatchObject({status:'blocked',quantity:1,benefit_id:null})
    expect(JSON.stringify(jobs)).not.toMatch(/cost|audience|customer_id|last_error/)
    expect((await pool.query('SELECT status FROM mbox.member_cards WHERE id=$1',[approved.cardId])).rows[0].status).toBe('active')
    await new MemberGiftDeliveryWorker(runner).runBatch(scope,'gift-recovery-again')
    expect((await run(repo=>repo.selfJobs(customerId))).items).toHaveLength(1)
    await expect(run(repo=>repo.controlJob({jobId:jobs.items[0]!.id,action:'retry',employeeId:publisher,businessDate,reason:'不能绕过停发'}))).rejects.toThrow('已经停止')
  })
  it('does not fall back to old active membership after the canonical member is deactivated',async()=>{
    const versionId=await campaign(),source=await customer(),target=await customer()
    await runner.run(scope,tx=>new CustomerRepository(tx).merge(source,target))
    await pool.query("UPDATE mbox.customer_memberships SET status='suspended' WHERE customer_id=$1",[target])
    await expect(run(repo=>repo.enqueue({versionId,customerId:source,cycleKey:'inactive'}))).rejects.toThrow('不符合')
    expect((await run(repo=>repo.selfJobs(target))).items).toHaveLength(0)
  })
  it('authorizes option searches, returns human-readable versions and rejects a full customer export',async()=>{
    await expect(run(repo=>repo.options(denied,'products'))).rejects.toThrow()
    await expect(run(repo=>repo.options(editor,'customers'))).rejects.toThrow('至少2字')
    expect((await run(repo=>repo.options(editor,'calendars','GIFT_CAL'))).items).toContainEqual({id:calendarId,code:'GIFT_CAL',name:'GIFT_CAL · 第1版'})
    expect((await run(repo=>repo.options(editor,'products','Test snack'))).items).toContainEqual({id:productId,name:'Test snack',code:'GIFT_SNACK'})
    expect((await run(repo=>repo.options(editor,'products','%'))).items).toHaveLength(0)
  })
})
