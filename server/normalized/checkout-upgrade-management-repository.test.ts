import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CheckoutUpgradeManagementRepository } from './checkout-upgrade-management-repository.js'
import { CheckoutUpgradeAvailabilityRepository } from './checkout-upgrade-availability-repository.js'
import {CheckoutUpgradeEvaluationRepository} from './checkout-upgrade-evaluation-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {OrderRepository} from './order-repository.js'
import {CheckoutUpgradeOpportunityRepository} from './checkout-upgrade-opportunity-repository.js'
import {
  ScopedPostgresTransactionRunner,
  type PostgresPool,
  type ScopedTransaction,
} from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

describe('checkout upgrade payment-state projection', () => {
  it('does not report an operationally released payment attempt as pending', async () => {
    let capturedSql = ''
    const transaction = {
      scope: { tenantId: randomUUID(), storeId: randomUUID() },
      query: async (text: string) => {
        capturedSql = text.replace(/\s+/g, ' ').trim()
        return { rows: [], rowCount: 0 }
      },
    } as unknown as ScopedTransaction

    await new CheckoutUpgradeManagementRepository(transaction).listOutcomes()

    expect(capturedSql).toContain("payment.status IN ('created','pending') AND payment.retry_released_at IS NULL")
  })
})

integration('checkout upgrade and capacity release management PostgreSQL integration', () => {
  const tenantId = randomUUID()
  const storeId = randomUUID()
  const otherStoreId = randomUUID()
  const employees = [randomUUID(), randomUUID(), randomUUID()]
  const sourceProductId = randomUUID()
  const targetProductId = randomUUID()
  let pool: Pool
  let runner: ScopedPostgresTransactionRunner

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    runner = new ScopedPostgresTransactionRunner(asPool(pool))
    await pool.query(`INSERT INTO mbox.tenants(id,code,name) VALUES ($1,$2,'Checkout management tenant')`, [
      tenantId, `checkout-management-${tenantId.slice(0,8)}`,
    ])
    await pool.query(`
      INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES
        ($1,$3,$4,'Checkout management store'),($2,$3,$5,'Other checkout management store')
    `, [storeId,otherStoreId,tenantId,`checkout-${storeId.slice(0,8)}`,`checkout-${otherStoreId.slice(0,8)}`])
    await pool.query(`
      INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name,status) VALUES
        ($1,$4,$5,'CHECKOUT_MAKER','Checkout Maker','active'),
        ($2,$4,$5,'CHECKOUT_CHECKER','Checkout Checker','active'),
        ($3,$4,$5,'CHECKOUT_PUBLISHER','Checkout Publisher','active')
    `, [...employees,tenantId,storeId])
    await pool.query(`
      INSERT INTO mbox.products(
        id,tenant_id,store_id,code,name,category_code,product_kind,
        fulfillment_station,cost_amount_minor,guest_visible,allowed_channels
      ) VALUES
        ($1,$3,$4,'CHECKOUT-SOURCE','Checkout Source','drink','single','bar',1000,true,ARRAY['guest_qr']),
        ($2,$3,$4,'CHECKOUT-TARGET','Checkout Target','bundle','bundle','none',3000,true,ARRAY['guest_qr'])
    `, [sourceProductId,targetProductId,tenantId,storeId])
  })

  afterAll(async () => pool?.end())

  it('requires three distinct people and keeps released rule facts immutable', async () => {
    const draft = await run((repository) => repository.insertRuleDraft({
      code:'CHECKOUT_MANAGED',name:'Managed checkout upgrade',sourceProductId,targetProductId,
      minimumPartySize:2,maximumPartySize:8,occasionTags:['friends'],alcoholPreferenceTags:['mixed'],
      promptTitle:'升级今晚体验',promptBody:'将当前单品升级为完整套餐',callToAction:'查看升级',
      priority:120,offerValidMinutes:10,minimumGrossMarginBasisPoints:100,employeeId:employees[0]!,
    }))
    expect(draft).toMatchObject({ revision:1,status:'draft',draftedByEmployeeId:employees[0] })

    await expect(run((repository) => repository.approveRule(
      draft.id,employees[0]!,'制单人不能自行审批',
    ))).rejects.toMatchObject({ code:'CHECKOUT_UPGRADE_RULE_APPROVAL_DENIED' })
    const approved = await run((repository) => repository.approveRule(
      draft.id,employees[1]!,'商品价格和毛利已复核',
    ))
    expect(approved).toMatchObject({ status:'approved',approvedByEmployeeId:employees[1] })

    await expect(run((repository) => repository.publishRule(
      draft.id,employees[1]!,'审批人不能自行发布',
    ))).rejects.toMatchObject({ code:'CHECKOUT_UPGRADE_RULE_PUBLICATION_DENIED' })
    const published = await run((repository) => repository.publishRule(
      draft.id,employees[2]!,'发布受控升级规则',
    ))
    expect(published).toMatchObject({ status:'active',publishedByEmployeeId:employees[2] })
    expect(await run((repository) => repository.listRules())).toEqual([
      expect.objectContaining({ id:draft.id,revision:1,status:'active' }),
    ])

    await expect(pool.query(`
      UPDATE mbox.checkout_upgrade_rules SET prompt_body='绕过版本直接修改'
      WHERE tenant_id=$1 AND store_id=$2 AND id=$3
    `, [tenantId,storeId,draft.id])).rejects.toMatchObject({ code:'23514' })
    const rollback = await run((repository) => repository.cloneRuleForRollback(draft.id,employees[0]!))
    expect(rollback).toMatchObject({ revision:2,status:'draft',code:'CHECKOUT_MANAGED' })
  })

  it('publishes typed non-overlapping capacity windows through the same separation', async () => {
    const now = Date.now()
    const draft = await run((repository) => repository.draftCapacity({
      stationCode:'bar',reason:'周末酒吧产能测试',employeeId:employees[0]!,windows:[{
        startsAt:new Date(now+60_000).toISOString(),endsAt:new Date(now+3_660_000).toISOString(),
        capacityLimitUnits:40,
      }],
    }))
    expect(draft).toMatchObject({ stationCode:'bar',policyVersion:1,status:'draft' })
    await expect(run((repository) => repository.approveCapacity(draft.id,employees[0]!)))
      .rejects.toMatchObject({ code:'FULFILLMENT_CAPACITY_APPROVAL_DENIED' })
    expect(await run((repository) => repository.approveCapacity(draft.id,employees[1]!)))
      .toMatchObject({ status:'approved' })
    await expect(run((repository) => repository.publishCapacity(draft.id,employees[1]!)))
      .rejects.toMatchObject({ code:'FULFILLMENT_CAPACITY_PUBLICATION_DENIED' })
    const published = await run((repository) => repository.publishCapacity(draft.id,employees[2]!))
    expect(published).toMatchObject({ status:'published',windows:[expect.objectContaining({ capacityLimitUnits:40 })] })

    const isolated = await runner.run({ tenantId,storeId:otherStoreId }, (transaction) => (
      new CheckoutUpgradeManagementRepository(transaction).listCapacityPolicies()
    ), { readOnly:true })
    expect(isolated).toEqual([])
  })

  it('freezes explicit high-fit bounds with the version and preserves them in a rollback draft',async()=>{
    const qualification={maximumAddMinor:3000,maximumAddBasisPoints:2000,minimumContributionMinor:1000,minimumIncrementalContributionMinor:0,positiveFitReason:'保留原具体商品，增加该人数适配的小食',maximumQuantitiesPerPerson:[{productId:sourceProductId,quantity:1}],excludedProductIds:[]}
    const input={code:'CHECKOUT_STRICT',name:'Strict checkout qualification',sourceProductId,targetProductId,minimumPartySize:2,maximumPartySize:8,occasionTags:['friends'],alcoholPreferenceTags:['mixed'],promptTitle:'升级体验',promptBody:'先核对具体菜品和份量',callToAction:'查看升级',priority:120,offerValidMinutes:10,minimumGrossMarginBasisPoints:100,employeeId:employees[0]!,qualification}
    await expect(run(repo=>repo.insertRuleDraft({...input,code:'CHECKOUT_BAD_BOUNDS',qualification:{...qualification,maximumAddMinor:undefined}}))).rejects.toThrow('整数')
    expect((await pool.query("SELECT count(*)::int AS n FROM mbox.checkout_upgrade_rules WHERE tenant_id=$1 AND store_id=$2 AND code='CHECKOUT_BAD_BOUNDS'",[tenantId,storeId])).rows[0].n).toBe(0)
    const draft=await run(repo=>repo.insertRuleDraft(input))
    expect(draft.qualification).toMatchObject({...qualification,minimumPartySize:2,maximumPartySize:8,minimumMarginBasisPoints:100,requiredOccasions:['friends']})
    const listed=(await run(repo=>repo.listRules())).find(rule=>rule.id===draft.id)
    expect(listed?.qualification).toEqual(draft.qualification)
    await expect(pool.query('UPDATE mbox.checkout_upgrade_qualifications SET maximum_add_minor=99999 WHERE rule_id=$1',[draft.id])).rejects.toThrow('append-only')
    await expect(pool.query('INSERT INTO mbox.checkout_upgrade_excluded_products(tenant_id,store_id,rule_id,product_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,draft.id,targetProductId])).rejects.toThrow('same transaction')
    await run(repo=>repo.approveRule(draft.id,employees[1]!,'核对加价、贡献和份量'))
    await run(repo=>repo.publishRule(draft.id,employees[2]!,'发布完整准入规则'))
    const rollback=await run(repo=>repo.cloneRuleForRollback(draft.id,employees[0]!))
    expect(rollback.qualification).toEqual(draft.qualification)
    const isolated=await runner.run({tenantId,storeId:otherStoreId},tx=>new CheckoutUpgradeManagementRepository(tx).listRules(),{readOnly:true})
    expect(isolated).toEqual([])
  })

  it('checks exact stock and published capacity without reserving either or creating an order',async()=>{
    const productId=randomUUID(),materialId=randomUUID(),recipeId=randomUUID()
    await pool.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'AVAILABILITY','Availability','drink','single','none','not_managed')`,[productId,tenantId,storeId])
    const assess=(quantity=1,scopeStore=storeId)=>runner.run({tenantId,storeId:scopeStore},tx=>new CheckoutUpgradeAvailabilityRepository(tx).assess([{productId,quantity}]),{readOnly:true})
    expect(await assess()).toEqual({available:true,inventoryKnownAndSufficient:true,productionAvailable:true,inventoryReserved:false,capacityReserved:false})
    expect(await assess(1,otherStoreId)).toMatchObject({available:false,inventoryKnownAndSufficient:false,productionAvailable:false})
    await pool.query("UPDATE mbox.products SET inventory_control_mode='tracked' WHERE id=$1",[productId])
    expect(await assess()).toMatchObject({inventoryKnownAndSufficient:false})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeAvailabilityRepository(tx).assess([{productId,quantity:1,consumesInventory:false,fulfillmentStation:'none'}]),{readOnly:true})).toMatchObject({available:true,inventoryKnownAndSufficient:true,productionAvailable:true})
    await pool.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,'AVAILABILITY','Availability','ingredient','ml')`,[materialId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,yield_quantity,status,effective_at) VALUES($1,$2,$3,$4,1,3,'active',clock_timestamp())`,[recipeId,tenantId,storeId,productId])
    await pool.query(`INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,1)`,[tenantId,storeId,recipeId,materialId])
    expect(await assess()).toMatchObject({inventoryKnownAndSufficient:false})
    await pool.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,1,0.333334)`,[tenantId,storeId,materialId])
    // Actual orders round each operational portion to six decimals before summing.
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeAvailabilityRepository(tx).assess([{productId,quantity:1},{productId,quantity:1}]),{readOnly:true})).toMatchObject({inventoryKnownAndSufficient:true})
    expect(await assess(2)).toMatchObject({inventoryKnownAndSufficient:false})
    await pool.query("UPDATE mbox.inventory_items SET status='inactive' WHERE id=$1",[materialId])
    expect(await assess()).toMatchObject({inventoryKnownAndSufficient:false})
    await pool.query("UPDATE mbox.inventory_items SET status='active' WHERE id=$1",[materialId])
    await pool.query("UPDATE mbox.products SET fulfillment_station='kitchen' WHERE id=$1",[productId])
    expect(await assess()).toMatchObject({productionAvailable:false})
    const policy=await run(repo=>repo.draftCapacity({stationCode:'kitchen',reason:'只读准入测试',employeeId:employees[0]!,windows:[{startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),capacityLimitUnits:1}]}))
    await run(repo=>repo.approveCapacity(policy.id,employees[1]!))
    await run(repo=>repo.publishCapacity(policy.id,employees[2]!))
    expect(await assess()).toMatchObject({productionAvailable:true})
    expect(await assess(2)).toMatchObject({productionAvailable:false})
    expect((await pool.query('SELECT on_hand_quantity,reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[materialId])).rows).toEqual([{on_hand_quantity:'1.000000',reserved_quantity:'0.333334'}])
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.fulfillment_capacity_reservations WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(0)
  })

  it('derives strict qualification from current cart, actual prices, stock, capacity and whole-table portions',async()=>{
    const customerId=randomUUID(),areaId=randomUUID(),tableId=randomUUID(),tableSessionId=randomUUID(),snackId=randomUUID()
    await pool.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,'qualification-customer')",[customerId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'Q','Qualification','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'Q01','Q01',4)",[tableId,tenantId,storeId,areaId])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'qualification-session',CURRENT_DATE,2,'open')",[tableSessionId,tenantId,storeId,tableId])
    await pool.query("UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1",[sourceProductId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode,cost_amount_minor,guest_visible) VALUES($1,$2,$3,'QUAL-SNACK','Qualification snack','snack','single','none','not_managed',500,true)",[snackId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',10000,'CNY',clock_timestamp()-interval '1 day'),($1,$2,$4,'standard',13000,'CNY',clock_timestamp()-interval '1 day'),($1,$2,$5,'standard',1000,'CNY',clock_timestamp()-interval '1 day')",[tenantId,storeId,sourceProductId,targetProductId,snackId])
    await pool.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,1,1),($1,$2,$3,$5,1,2)',[tenantId,storeId,targetProductId,sourceProductId,snackId])
    const draft=await run(repo=>repo.insertRuleDraft({code:'QUALIFIED_LIVE_FACTS',name:'Qualified live facts',sourceProductId,targetProductId,minimumPartySize:1,maximumPartySize:4,occasionTags:[],alcoholPreferenceTags:[],promptTitle:'保留原酒水',promptBody:'增加适配小食',callToAction:'查看升级',priority:10,offerValidMinutes:5,minimumGrossMarginBasisPoints:2000,employeeId:employees[0]!,qualification:{maximumAddMinor:3000,maximumAddBasisPoints:4000,minimumContributionMinor:1000,minimumIncrementalContributionMinor:0,positiveFitReason:'原酒水完整保留，增加两人份量范围内的小食',maximumQuantitiesPerPerson:[{productId:snackId,quantity:1}],excludedProductIds:[]}}))
    await run(repo=>repo.approveRule(draft.id,employees[1]!,'隔离测试复核'))
    await run(repo=>repo.publishRule(draft.id,employees[2]!,'隔离测试发布规则，不开启推荐'))
    const cart=await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).adjust(tableSessionId,`GSC${randomUUID().replaceAll('-','').toUpperCase()}`,{productId:sourceProductId,delta:1,expectedGeneration:1,expectedVersion:0,operationId:'qualification-source-cart',actorSessionRef:'guest:qualification-test'}))
    const input={ruleId:draft.id,tableSessionId,customerId,portionId:cart.lines[0]!.portionIds![0]!,expectedGeneration:cart.generation,expectedVersion:cart.version,occasion:null,alcoholPreference:null,selections:[]}
    const evaluate=(value=input)=>runner.run({tenantId,storeId},tx=>new CheckoutUpgradeEvaluationRepository(tx).evaluate(value),{readOnly:true})
    const qualified=await evaluate()
    expect(qualified).toMatchObject({eligible:true,addedPayableMinor:3000,contributionMinor:10000,incrementalContributionMinor:1000,targetProductId})
    if(!qualified.eligible)throw new Error('Expected isolated qualified fixture')
    const requestKey='qualification-opportunity-first'
    const opportunity=await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(qualified,{customerId,requestKey}))
    expect(opportunity).toMatchObject({status:'offered',sourcePortionId:input.portionId,originalPayableMinor:10000,upgradedPayableMinor:13000})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(qualified,{customerId,requestKey}))).toEqual(opportunity)
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(qualified,{customerId,requestKey:'another-device-opportunity'}))).toBeNull()
    expect(await runner.run({tenantId,storeId:otherStoreId},tx=>new CheckoutUpgradeOpportunityRepository(tx).find(opportunity!.id,customerId),{readOnly:true})).toBeNull()
    await expect(pool.query("UPDATE mbox.checkout_upgrade_opportunities SET fit_reason='rewrite' WHERE id=$1",[opportunity!.id])).rejects.toThrow('append-only')
    await expect(pool.query("INSERT INTO mbox.checkout_upgrade_opportunity_choices(tenant_id,store_id,opportunity_id,choice_group_id,position,component_product_id) VALUES($1,$2,$3,$4,0,$5)",[tenantId,storeId,opportunity!.id,randomUUID(),snackId])).rejects.toThrow('same transaction')
    await expect(pool.query("INSERT INTO mbox.checkout_upgrade_opportunity_closures(tenant_id,store_id,opportunity_id,action,customer_id,accepted_operation_id,replacement_portion_id,reason) VALUES($1,$2,$3,'accepted',$4,$5,$6,'伪造接受无实际替换')",[tenantId,storeId,opportunity!.id,customerId,randomUUID(),input.portionId])).rejects.toThrow('actual atomic portion replacement')
    await expect(runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).decline(opportunity!.id,customerId,randomUUID()))).rejects.toThrow('当前桌次')
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).find(opportunity!.id,customerId))).toMatchObject({status:'offered'})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).decline(opportunity!.id,customerId,tableSessionId))).toMatchObject({status:'declined'})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).decline(opportunity!.id,customerId,tableSessionId))).toMatchObject({status:'declined'})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(qualified,{customerId,requestKey:'return-page-opportunity'}))).toBeNull()
    expect(await evaluate({...input,expectedVersion:0})).toMatchObject({eligible:false,reason:'cart_changed'})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeEvaluationRepository(tx).evaluate({...input,alcoholPreference:'non_alcoholic'}),{readOnly:true})).toMatchObject({eligible:false,reason:'restriction_not_verified_or_failed'})
    expect(await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).findCurrentOpen(tableSessionId),{readOnly:true})).toEqual(cart)
    const acceptTableId=randomUUID(),acceptSessionId=randomUUID()
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'Q02','Q02',4)",[acceptTableId,tenantId,storeId,areaId])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'qualification-accept-session',CURRENT_DATE,2,'open')",[acceptSessionId,tenantId,storeId,acceptTableId])
    const acceptCart=await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).adjust(acceptSessionId,`GSC${randomUUID().replaceAll('-','').toUpperCase()}`,{productId:sourceProductId,delta:1,expectedGeneration:1,expectedVersion:0,operationId:'qualification-accept-cart',actorSessionRef:'guest:qualification-test'}))
    const acceptEvaluation=await evaluate({...input,tableSessionId:acceptSessionId,portionId:acceptCart.lines[0]!.portionIds![0]!,expectedVersion:acceptCart.version})
    if(!acceptEvaluation.eligible)throw new Error('Expected isolated acceptance candidate')
    const acceptOffer=await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(acceptEvaluation,{customerId,requestKey:'qualification-accept-offer'}))
    const acceptInput={customerId,tableSessionId:acceptSessionId,actorSessionRef:'guest:qualification-test'}
    await expect(runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).accept(acceptOffer!.id,{...acceptInput,tableSessionId}))).rejects.toThrow('当前桌次')
    await expect(runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).accept(acceptOffer!.id,acceptInput))).rejects.toThrow('已暂停')
    expect(await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).findCurrentOpen(acceptSessionId),{readOnly:true})).toEqual(acceptCart)
    await pool.query("INSERT INTO mbox.customer_experience_features(tenant_id,store_id,feature_code,rollout_state,reason,approved_by_employee_id) VALUES($1,$2,'checkout_upgrade','pilot','仅隔离测试接受',$3)",[tenantId,storeId,employees[2]])
    await pool.query("UPDATE mbox.products SET status='inactive' WHERE id=$1",[targetProductId])
    await expect(runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).accept(acceptOffer!.id,acceptInput))).rejects.toThrow('未更改原购物车')
    expect(await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).findCurrentOpen(acceptSessionId),{readOnly:true})).toEqual(acceptCart)
    await pool.query("UPDATE mbox.products SET status='active' WHERE id=$1",[targetProductId])
    const accepted=await runner.run({tenantId,storeId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return new CheckoutUpgradeOpportunityRepository(tx).accept(acceptOffer!.id,acceptInput)
    })
    expect(accepted).toMatchObject({replayed:false,opportunity:{status:'accepted'},cart:{version:acceptCart.version+1,lines:[{productId:targetProductId,quantity:1}]}})
    expect(accepted.opportunity!.replacementPortionId).not.toBe(acceptEvaluation.comparison.sourcePortionId)
    const acceptedReplay=await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).accept(acceptOffer!.id,acceptInput))
    expect(acceptedReplay).toEqual({...accepted,replayed:true})
    expect(await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).decline(acceptOffer!.id,customerId,acceptSessionId))).toMatchObject({status:'accepted'})
    const crossStoreDelete=await runner.run({tenantId,storeId:otherStoreId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return tx.query('DELETE FROM mbox.guest_shared_cart_lines WHERE cart_id=$1',[accepted.cart!.id])
    })
    expect(crossStoreDelete.rowCount).toBe(0)
    const cleared=await runner.run({tenantId,storeId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return new GuestSharedCartRepository(tx).clear(acceptSessionId,accepted.cart!.publicId,{expectedGeneration:accepted.cart!.generation,expectedVersion:accepted.cart!.version,operationId:'qualification-runtime-clear',actorSessionRef:acceptInput.actorSessionRef})
    })
    expect(cleared.lines).toEqual([])
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.guest_shared_cart_portions WHERE cart_id=$1 AND removed_at IS NOT NULL',[accepted.cart!.id])).rows[0].n).toBe(2)
    await expect(runner.run({tenantId,storeId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return tx.query('DELETE FROM mbox.guest_shared_cart_portions WHERE cart_id=$1',[accepted.cart!.id])
    })).rejects.toThrow('permission denied')
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(0)
    await runner.run({tenantId,storeId},tx=>new OrderRepository(tx).createSubmitted({tableSessionId,publicId:'qualification-existing-order',channel:'guest_qr',createdByCustomerId:customerId,lines:[{productId:snackId,quantity:2}]}))
    expect(await evaluate()).toMatchObject({eligible:false,reason:'redundant_or_excessive_portions'})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])).rows[0].n).toBe(1)
    const choiceTableId=randomUUID(),choiceSessionId=randomUUID(),choiceGroupId=randomUUID()
    await pool.query("INSERT INTO mbox.product_bundle_choice_groups(id,tenant_id,store_id,bundle_product_id,code,display_name,selection_count) VALUES($1,$2,$3,$4,'EXTRA','加配小食',1)",[choiceGroupId,tenantId,storeId,targetProductId])
    await pool.query('INSERT INTO mbox.product_bundle_choice_options(tenant_id,store_id,choice_group_id,component_product_id,quantity) VALUES($1,$2,$3,$4,1)',[tenantId,storeId,choiceGroupId,snackId])
    await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'Q03','Q03',4)",[choiceTableId,tenantId,storeId,areaId])
    await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,'qualification-choice-session',CURRENT_DATE,2,'open')",[choiceSessionId,tenantId,storeId,choiceTableId])
    const choiceCart=await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).adjust(choiceSessionId,`GSC${randomUUID().replaceAll('-','').toUpperCase()}`,{productId:sourceProductId,delta:1,expectedGeneration:1,expectedVersion:0,operationId:'qualification-choice-cart',actorSessionRef:acceptInput.actorSessionRef}))
    const choiceEvaluation=await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeEvaluationRepository(tx).evaluate({...input,tableSessionId:choiceSessionId,portionId:choiceCart.lines[0]!.portionIds![0]!,expectedVersion:choiceCart.version,bundleSelection:{groups:[{groupId:choiceGroupId,productIds:[snackId]}]}}),{readOnly:true})
    if(!choiceEvaluation.eligible)throw new Error('Expected isolated choice candidate: '+choiceEvaluation.reason)
    const choiceOffer=await runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).offerOnce(choiceEvaluation,{customerId,requestKey:'qualification-choice-offer',variants:[{evaluation:choiceEvaluation,label:'加配小食：Qualification snack'}]}))
    expect(choiceOffer!.variants).toHaveLength(1)
    const choiceInput={customerId,tableSessionId:choiceSessionId,actorSessionRef:acceptInput.actorSessionRef}
    await expect(runner.run({tenantId,storeId},tx=>new CheckoutUpgradeOpportunityRepository(tx).accept(choiceOffer!.id,choiceInput))).rejects.toThrow('请先选齐具体菜品')
    expect(await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).findCurrentOpen(choiceSessionId),{readOnly:true})).toEqual(choiceCart)
    const chosen=await runner.run({tenantId,storeId},async tx=>{
      await tx.query('SET LOCAL ROLE mbox_runtime')
      return new CheckoutUpgradeOpportunityRepository(tx).accept(choiceOffer!.id,{...choiceInput,variantId:choiceOffer!.variants[0]!.id})
    })
    expect(chosen.cart!.lines[0]!.bundleSelections).toEqual([{groups:[{groupId:choiceGroupId,productIds:[snackId]}]}])
    expect(chosen.opportunity!.acceptedVariantId).toBe(choiceOffer!.variants[0]!.id)
    const beforeSubmit=await run(repository=>repository.listOutcomes())
    expect(beforeSubmit.find(row=>row.offerPublicId===choiceOffer!.id)).toMatchObject({status:'accepted',convertedOrderPublicId:null,paymentState:'not_created',paidAmountMinor:0,eventCounts:{viewed:0,accepted:1,converted:0}})
    expect(beforeSubmit.find(row=>row.offerPublicId===opportunity!.id)).toMatchObject({status:'declined',eventCounts:{declined:1,accepted:0,converted:0}})
    // Removing an accepted replacement, then buying another product, must not
    // turn the removed upgrade into a submitted conversion.
    const originalAgain=await runner.run({tenantId,storeId},tx=>new GuestSharedCartRepository(tx).adjust(acceptSessionId,cleared.publicId,{productId:sourceProductId,delta:1,expectedGeneration:cleared.generation,expectedVersion:cleared.version,operationId:'qualification-original-readded',actorSessionRef:acceptInput.actorSessionRef}))
    for(const current of [originalAgain,chosen.cart!]) {
      await runner.run({tenantId,storeId},async tx=>{
        const carts=new GuestSharedCartRepository(tx)
        const operationId=`qualification-submit-${current.id}`
        const submitting=await carts.beginCheckout(current.tableSessionId,current.publicId,{expectedGeneration:current.generation,expectedVersion:current.version,operationId,actorSessionRef:acceptInput.actorSessionRef})
        const order=await new OrderRepository(tx).createSubmitted({tableSessionId:current.tableSessionId,publicId:`qualification-order-${current.id}`,channel:'guest_qr',createdByCustomerId:customerId,lines:current.lines.map(line=>({productId:line.productId,quantity:line.quantity,bundleSelections:line.bundleSelections}))})
        await carts.completeCheckout(submitting,{orderId:order.id,expectedVersion:current.version,operationId,actorSessionRef:acceptInput.actorSessionRef,nextCartPublicId:`GSC${randomUUID().replaceAll('-','').toUpperCase()}`})
      })
    }
    const outcomes=await run(repository=>repository.listOutcomes())
    expect(outcomes.find(row=>row.offerPublicId===choiceOffer!.id)).toMatchObject({convertedOrderPublicId:`qualification-order-${chosen.cart!.id}`,paymentState:'not_created',eventCounts:{accepted:1,converted:1}})
    expect(outcomes.find(row=>row.offerPublicId===acceptOffer!.id)).toMatchObject({convertedOrderPublicId:null,paymentState:'not_created',eventCounts:{accepted:1,converted:0}})
    expect(await runner.run({tenantId,storeId:otherStoreId},tx=>new CheckoutUpgradeManagementRepository(tx).listOutcomes(),{readOnly:true})).toEqual([])
  })

  function run<Result>(operation: (repository: CheckoutUpgradeManagementRepository) => Promise<Result>) {
    return runner.run({ tenantId,storeId }, (transaction) => operation(new CheckoutUpgradeManagementRepository(transaction)))
  }
})

function asPool(pool: Pool): PostgresPool {
  return { connect: async () => pool.connect(), end: async () => pool.end() }
}
