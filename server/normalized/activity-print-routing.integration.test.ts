import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {ActivityServiceRepository,activityCredential} from './activity-service-repository.js'
import {ActivityServiceExceptionRepository} from './activity-service-exception-repository.js'
import {prepareActivityPurchase,type ActivityMealItem} from './activity-purchase-support.js'
import {HardwareRepository} from './hardware-repository.js'
import {PrintTicketSourceRepository} from './print-ticket-source.js'
import type {ActivityServiceLine} from '../../src/shared/activity-service.js'
import type {ActivityServiceExceptionCommand} from '../../src/shared/activity-service-exception.js'

const database=process.env.TEST_NORMALIZED_DATABASE_URL
;(database?describe:describe.skip)('activity production uses existing category printer routes',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),customer=randomUUID(),activity=randomUUID(),packageId=randomUUID()
  const hot=randomUUID(),cold=randomUUID(),drink=randomUUID()
  const printers=new Map<string,string>()
  let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner
  beforeAll(async()=>{
    await runNormalizedMigrations(database!)
    admin=new Pool({connectionString:database})
    runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??database})
    runner=new ScopedPostgresTransactionRunner(runtime)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Activity printing')",[scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Activity printing')",[scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'PRINT','打印测试')",[employee,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[customer,scope.tenantId,scope.storeId])
    await admin.query(`INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-PRINT-ROUTE')`,[scope.tenantId,scope.storeId,customer])
    await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,points_reward,visibility,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id,addon_product_ids)
      VALUES($1::uuid,$2,$3,$1::text,'member_night','分类打印活动','分类打印回归',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','门口',100,0,0,'per_registration','none',15,'免费活动','CNY',0,'public','activity-safety-v1','已知安全规则',ARRAY['年满18周岁'],'activity-refund-v1','按原退款约定','现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品'],ARRAY['提前到场'],'报名后查看集合通知','published',clock_timestamp(),$4,$4,$5::uuid[])`,[activity,scope.tenantId,scope.storeId,employee,[hot,cold,drink]])
    for(const [id,category,station] of [[hot,'hot-food','kitchen'],[cold,'cold-food','kitchen'],[drink,'drinks','bar']] as const){
      await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,guest_visible) VALUES($1::uuid,$2,$3,$1::text,$4,$4,$5,'not_managed',true)`,[id,scope.tenantId,scope.storeId,category,station])
      await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1200,'CNY',clock_timestamp()-interval '1 hour')",[scope.tenantId,scope.storeId,id])
      await runner.run(scope,async tx=>{
        const hardware=new HardwareRepository(tx),device=await hardware.createDevice({code:category,name:category,deviceType:'printer',stationCode:station})
        printers.set(category,device.id)
        await hardware.upsertPrinterRoute({code:category,name:category,stationCode:station,productCategoryCode:category,printerDeviceId:device.id})
      })
    }
    await admin.query(`INSERT INTO mbox.community_activity_packages(id,tenant_id,store_id,activity_id,public_id,name,capacity,member_purchase_limit,fee_amount_minor,deposit_amount_minor,fee_basis,payment_mode,payment_deadline_minutes,payment_rule_text,status,max_participants,includes_admission,has_meal)
      VALUES($1::uuid,$2,$3,$4,$1::text,'含菜套餐',100,20,5000,0,'per_registration','full_required',15,'固定价格','draft',5,true,true)`,[packageId,scope.tenantId,scope.storeId,activity])
    await admin.query('INSERT INTO mbox.activity_package_products(tenant_id,store_id,package_id,product_id,quantity) VALUES($1,$2,$3,$4,2)',[scope.tenantId,scope.storeId,packageId,hot])
  })
  afterAll(async()=>{await runtime?.end();await admin?.end()})
  const run=<T>(fn:(repo:ActivityServiceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ActivityServiceRepository(tx)))
  async function registration(items:ActivityMealItem[]){
    const id=randomUUID()
    await admin.query(`INSERT INTO mbox.community_activity_registrations(id,tenant_id,store_id,public_id,activity_id,customer_id,party_size,status,payment_choice,payment_status,fee_amount_minor,amount_due_minor,paid_amount_minor,currency,safety_acknowledgement,idempotency_key,refund_policy_snapshot,acknowledged_safety_policy_version,acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,requested_payment_choice,requested_amount_due_minor,service_version,reserved_seats,max_participants,includes_admission,purchase_kind,service_items_snapshot,service_has_meal)
      VALUES($1::uuid,$2,$3,$1::text,$4,$5,1,'confirmed','none','not_required',0,0,0,'CNY','{}',$1::text,'{"policyVersion":"activity-refund-v1"}','activity-safety-v1','activity-refund-v1',clock_timestamp(),'staff_assisted','none',0,3,5,5,true,'admission_package',$6::jsonb,true)`,[id,scope.tenantId,scope.storeId,activity,customer,JSON.stringify(items)])
    const r=await run(repo=>repo.registration(id))
    return{id,code:activityCredential(id,r.credential_token)}
  }
  async function redeem(items:ActivityMealItem[]){
    const r=await registration(items)
    const view=await run(repo=>repo.door(r.id,{action:'redeem',credential:r.code},randomUUID(),employee,'2026-10-22'))
    await run(repo=>repo.door(r.id,{action:'plaque_issued'},randomUUID(),employee,'2026-10-22'))
    return{r,lines:view.meal!.lines}
  }
  async function print(line:ActivityServiceLine){
    const source=(await admin.query("SELECT source_outbox_message_id FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='activity_production'",[line.id])).rows[0]
    return runner.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeActivityProduction(source.source_outbox_message_id,line.id))
  }
  async function exception(line:ActivityServiceLine,action:ActivityServiceExceptionCommand['action'],extra:Partial<ActivityServiceExceptionCommand>={}){
    return runner.run(scope,tx=>new ActivityServiceExceptionRepository(tx).execute({action,lineId:line.id,expectedVersion:line.version,reason:'核对原菜品处理',...extra},randomUUID(),employee))
  }
  async function printNotice(receiptId:string){
    const source=(await admin.query("SELECT source_outbox_message_id FROM mbox.print_source_jobs WHERE aggregate_id=$1 AND ticket_kind='production_notice'",[receiptId])).rows[0]
    return runner.run(scope,tx=>new PrintTicketSourceRepository(tx).materializeProductionNotice(source.source_outbox_message_id,receiptId))
  }
  it('captures fixed package, selected child and single-dish categories at purchase and routes without a default printer',async()=>{
    const parent=await registration([])
    const fixed=await runner.run(scope,tx=>prepareActivityPurchase(tx,{customerId:customer,activityId:activity,packageId,maxParticipants:5,partySize:1,packageIncludesAdmission:true,mealOnlyAmount:null,choiceGroups:[{id:'side',name:'配菜',quantity:1,productIds:[cold]}],selections:[{groupId:'side',productId:cold}]}))
    const single=await runner.run(scope,tx=>prepareActivityPurchase(tx,{customerId:customer,activityId:activity,packageId:null,maxParticipants:null,partySize:1,packageIncludesAdmission:false,mealOnlyAmount:null,purchaseKind:'single_dish',parentRegistrationPublicId:parent.id,productId:drink,quantity:1}))
    expect(fixed!.items).toEqual(expect.arrayContaining([expect.objectContaining({productId:hot,categoryCode:'hot-food'}),expect.objectContaining({productId:cold,categoryCode:'cold-food'})]))
    expect(single!.items[0]).toMatchObject({productId:drink,categoryCode:'drinks'})
    const {lines}=await redeem([...fixed!.items,...single!.items])
    // Changing the live catalogue must not redirect already purchased dishes.
    await admin.query("UPDATE mbox.products SET category_code='changed-after-purchase' WHERE id=ANY($1::uuid[])",[[hot,cold,drink]])
    for(const line of lines){
      const category=line.productId===hot?'hot-food':line.productId===cold?'cold-food':'drinks'
      const jobs=await print(line)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({productCategoryCode:category,printerDeviceId:printers.get(category)})
      expect((await print(line))[0]!.id).toBe(jobs[0]!.id)
    }
  })
  it('uses the same original category for hold, resume, stop notices and a remake',async()=>{
    const {lines}=await redeem([{productId:hot,name:'热菜',station:'kitchen',categoryCode:'hot-food',quantity:3}])
    let line=lines[0]!
    const held=await exception(line,'hold');line=held.lines[0]!
    const resumed=await exception(line,'resume');line=resumed.lines[0]!
    const stopped=await exception(line,'cancel_unmade',{quantity:1});line=stopped.lines[0]!
    for(const result of [held,resumed,stopped])expect((await printNotice(result.receiptId))[0]).toMatchObject({printerDeviceId:printers.get('hot-food'),productCategoryCode:'hot-food'})
    line=(await run(repo=>repo.production({action:'start',lines:[{lineId:line.id,expectedVersion:line.version,quantity:1}]},randomUUID(),employee))).lines[0]!
    line=(await run(repo=>repo.production({action:'ready',lines:[{lineId:line.id,expectedVersion:line.version,quantity:1}]},randomUUID(),employee))).lines[0]!
    const remade=await exception(line,'remake',{quantity:1,remakeFrom:'ready',goodsLost:true}),remake=remade.lines.find(item=>item.id!==line.id)!
    expect((await print(remake))[0]).toMatchObject({printerDeviceId:printers.get('hot-food'),productCategoryCode:'hot-food'})
    expect((await admin.query('SELECT product_snapshot FROM mbox.activity_service_lines WHERE id=$1',[remake.id])).rows[0].product_snapshot.categoryCode).toBe('hot-food')
  })
  it('routes an older missing-category snapshot through the product category without changing stored history',async()=>{
    await admin.query("UPDATE mbox.products SET category_code='cold-food' WHERE id=$1",[cold])
    const {lines}=await redeem([{productId:cold,name:'旧菜品',station:'kitchen',quantity:1}]),line=lines[0]!
    expect((await print(line))[0]).toMatchObject({printerDeviceId:printers.get('cold-food'),productCategoryCode:'cold-food'})
    const held=await exception(line,'hold')
    expect((await printNotice(held.receiptId))[0]).toMatchObject({printerDeviceId:printers.get('cold-food'),productCategoryCode:'cold-food'})
    expect((await admin.query('SELECT product_snapshot FROM mbox.activity_service_lines WHERE id=$1',[line.id])).rows[0].product_snapshot).not.toHaveProperty('categoryCode')
  })
  it('preserves an explicit default category and the existing fallback when no exact route exists',async()=>{
    const fallback=await runner.run(scope,async tx=>{
      const hardware=new HardwareRepository(tx),device=await hardware.createDevice({code:'kitchen-default',name:'默认后厨',deviceType:'printer',stationCode:'kitchen'})
      await hardware.upsertPrinterRoute({code:'kitchen-default',name:'默认后厨',stationCode:'kitchen',printerDeviceId:device.id})
      return device.id
    })
    for(const categoryCode of [null,'without-exact-route']){
      const {lines}=await redeem([{productId:cold,name:'默认菜',station:'kitchen',categoryCode,quantity:1}])
      expect((await print(lines[0]!))[0]).toMatchObject({printerDeviceId:fallback,productCategoryCode:categoryCode})
    }
  })
})
