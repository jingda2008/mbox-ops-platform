import {randomUUID} from 'node:crypto'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {CustomerExperienceRepository} from './customer-experience-repository.js'
import {pickupWorkflowApiPlugin} from './pickup-workflow-api.js'
import {assertRuntimeDatabasePool} from './runtime-database-identity.js'
import type {PickupBoardData,PickupCommandResult} from '../../src/shared/pickup-workflow.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl=process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('public portal annual calendar after exact pickup correction',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  let pool:Pool,runtimePool:Pool,runner:ScopedPostgresTransactionRunner,businessDate:string
  let fixture:Awaited<ReturnType<typeof item>>,ids:Awaited<ReturnType<typeof annualClaim>>
  const app=Fastify()
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!)
    pool=new Pool({connectionString:databaseUrl,max:3})
    runtimePool=new Pool({connectionString:runtimeUrl??databaseUrl,max:3})
    runner=new ScopedPostgresTransactionRunner(runtimePool)
    if(runtimeUrl)await assertRuntimeDatabasePool(runtimePool,runtimeUrl)
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Kitchen isolation')",[tenantId,`k-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'kitchen-store','Kitchen','Asia/Shanghai','00:00')",[storeId,tenantId])
    businessDate=await runner.run(scope,async tx=>(await tx.query<{date:string}>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[tenantId,storeId])).rows[0]!.date)
    await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'K','K','indoor')",[areaId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'cook','测试厨师')",[employeeId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'KITCHEN_TEST','Kitchen')",[roleId,tenantId,storeId])
    await pool.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 hour')",[tenantId,storeId,employeeId,roleId])
    for(const code of ['kds.prepare','kds.deliver','table.transfer','fulfillment.view_all','staff.access.configure','kds.exception.manage']){
      const permission=(await pool.query("INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category) VALUES($1,$2,$3,$3,'operations') ON CONFLICT(tenant_id,store_id,code) DO UPDATE SET name=EXCLUDED.name RETURNING id",[tenantId,storeId,code])).rows[0].id
      await pool.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,roleId,permission])
    }
    await pool.query(`INSERT INTO mbox.role_data_scopes(tenant_id,store_id,role_id,scope_key,effect,scope_value,value_kind,text_values,enabled) VALUES($1,$2,$3,'kds.station_codes','include','["kitchen"]','text_set',ARRAY['kitchen'],true)`,[tenantId,storeId,roleId])
    await pool.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$kitchen-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,tenantId,storeId,employeeId])
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('a',64),repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,tenantId,storeId,credentialId])
    // Session expiry is constrained to exactly six hours after issuance; all fixture times must share one statement timestamp.
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('c',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,tenantId,storeId,employeeId,leaseId])
    await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'K-FOOD','测试薯条','food','kitchen')",[productId,tenantId,storeId])
    await app.register(pickupWorkflowApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runner,commandExecutor:new NormalizedCommandExecutor(runner),resolveContext:()=>({scope,employeeId,staffSessionId,deviceAccessLeaseId:leaseId,businessDate})})
    fixture=await item('',false,undefined,true);ids=await annualClaim(fixture)
    await runner.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({...fixture,employeeId,quantity:5,eventKey:randomUUID()}))
  },30000)
  afterAll(async()=>{await app.close();await runtimePool?.end();await pool?.end()})
  async function portal(){return runner.run(scope,tx=>new CustomerExperienceRepository(tx).publicPortal(ids.customerId),{readOnly:true})}
  async function calendar(){return (await portal()).annualBenefitCalendar.find(row=>row.benefitId===ids.benefitId)!}
  async function facts(){return (await pool.query(`SELECT benefit.status,benefit.quantity_total,benefit.quantity_reserved,benefit.quantity_redeemed,grant_row.status AS grant_status,
    claim.status AS claim_status,claim.fulfilled_at::text,
    (SELECT count(*)::int FROM mbox.benefit_redemptions WHERE benefit_id=benefit.id) AS redemptions
    FROM mbox.benefits benefit JOIN mbox.membership_annual_benefit_grants grant_row ON grant_row.benefit_id=benefit.id
    JOIN mbox.annual_daily_snack_claims claim ON claim.benefit_id=benefit.id WHERE benefit.id=$1`,[ids.benefitId])).rows[0]}
  it('keeps the normal member portal readable before any annual fulfillment completes',async()=>{
    const before=await calendar()
    expect(before).toBeDefined()
    expect(before.currentFulfillmentStatus).toBe('ready')
    expect(before.canApply).toBe(false)
  })
  it('reads ready again after exact undo while the original grant stays fulfilled and non-redeemable',async()=>{
    const configured=await app.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':randomUUID()},payload:{enabled:true,label:'权益回归取餐屏'}})
    expect(configured.statusCode,configured.body).toBe(200)
    const view=await app.inject('/api/commerce/pickup-board');expect(view.statusCode,view.body).toBe(200)
    const group=(view.json().data as PickupBoardData).tables.find(row=>row.tableSessionId===fixture.tableSessionId)!
    const taken=await app.inject({method:'POST',url:'/api/commerce/pickup-board/commands',headers:{'idempotency-key':randomUUID()},payload:{action:'take',tableId:group.tableId,tableSessionId:group.tableSessionId,locationVersion:group.locationVersion,units:group.units.map(unit=>({kind:unit.kind,unitId:unit.unitId,version:unit.version}))}})
    expect(taken.statusCode,taken.body).toBe(200)
    const receipt=(taken.json().data as PickupCommandResult).receipt
    expect(await calendar()).toMatchObject({factState:'fulfilled',currentFulfillmentStatus:'delivered',canApply:false,redeemable:false,claimable:false})
    const completed=await facts();expect(completed).toMatchObject({status:'redeemed',grant_status:'fulfilled',claim_status:'fulfilled',redemptions:1})
    const undone=await app.inject({method:'POST',url:'/api/commerce/pickup-board/commands',headers:{'idempotency-key':randomUUID()},payload:{action:'undo',receiptId:receipt.receiptId,expectedRevision:receipt.revision,physicalStillAtPickupPoint:true}})
    expect(undone.statusCode,undone.body).toBe(200)
    expect(await calendar()).toMatchObject({factState:'fulfilled',currentFulfillmentStatus:'ready',canApply:false,redeemable:false,claimable:false})
    expect(await facts()).toEqual(completed)
  })
  async function table(){const id=randomUUID();await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,8)",[id,tenantId,storeId,areaId,`T${id.slice(0,8)}`]);return id}
  async function item(note='',stock=false,at?:{tableId:string;tableSessionId:string},zeroPrice=false){
    const tableId=at?.tableId??await table(),tableSessionId=at?.tableSessionId??randomUUID(),orderId=randomUUID(),itemId=randomUUID(),taskId=randomUUID()
    if(!at)await pool.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,2)',[tableSessionId,tenantId,storeId,tableId,`s-${tableSessionId}`,businessDate])
    await pool.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor) VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),$6,$6)",[orderId,tenantId,storeId,tableSessionId,`k-${orderId}`,zeroPrice?0:5000])
    await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,note) VALUES($1,$2,$3,$4,$5,5,$8::bigint,$8::bigint*5,'kitchen',$6::jsonb,$7)`,[itemId,tenantId,storeId,orderId,productId,JSON.stringify({name:'测试薯条',inventoryControlMode:stock?'tracked':'not_managed'}),note,zeroPrice?0:1000])
    await pool.query("INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity) VALUES($1,$2,$3,$4,'kitchen',5)",[taskId,tenantId,storeId,itemId])
    const stockId=randomUUID()
    if(stock){await pool.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1,$2,$3,$4,'薯条材料','food','piece')",[stockId,tenantId,storeId,`K-${stockId}`])
      await pool.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity,reserved_quantity) VALUES($1,$2,$3,10,5)',[tenantId,storeId,stockId])
      await pool.query("INSERT INTO mbox.inventory_order_reservations(tenant_id,store_id,order_id,order_item_id,inventory_item_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,5,clock_timestamp()+interval '1 hour')",[tenantId,storeId,orderId,itemId,stockId])}
    return {taskId,itemId,tableId,tableSessionId,orderId,stockId}
  }
  async function annualClaim(row:{orderId:string;tableSessionId:string;tableId:string}){
    const customerId=randomUUID(),membershipId=randomUUID(),policyId=randomUUID(),definitionId=randomUUID(),ruleId=randomUUID(),benefitId=randomUUID(),reservationId=randomUUID(),claimId=randomUUID()
    await pool.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)',[customerId,tenantId,storeId,`pickup-customer-${customerId}`])
    await pool.query('INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4,$5)',[membershipId,tenantId,storeId,customerId,`MBX${customerId.replaceAll('-','').slice(0,16).toUpperCase()}`])
    await pool.query("INSERT INTO mbox.loyalty_benefit_definitions(id,tenant_id,store_id,public_id,benefit_code,name,benefit_kind,product_id,validity_days,cost_amount_minor) VALUES($1,$2,$3,$4,$5,'每日点心','gift_product',$6,1,0)",[definitionId,tenantId,storeId,`pickup-definition-${definitionId}`,`P${definitionId.slice(0,8)}`,productId])
    await pool.query("INSERT INTO mbox.loyalty_annual_benefit_policy_versions(id,tenant_id,store_id,policy_code,version,drafted_by_employee_id,reason) VALUES($1,$2,$3,$4,1,$5,'取餐权益回归测试')",[policyId,tenantId,storeId,`P${policyId.replaceAll('-','').toUpperCase()}`,employeeId])
    await pool.query("INSERT INTO mbox.loyalty_annual_benefit_rules(id,tenant_id,store_id,policy_version_id,rule_code,title,rule_kind,eligible_tier,benefit_definition_id,validity_days,redemption_hold_minutes,stack_group,priority,inventory_requirement,revocation_policy) VALUES($1,$2,$3,$4,'DAILY_SNACK','每日点心','daily_snack','member',$5,1,10,'daily_snack',100,'strict_recipe','cancel_before_redeem')",[ruleId,tenantId,storeId,policyId,definitionId])
    await pool.query("INSERT INTO mbox.benefits(id,tenant_id,store_id,customer_id,benefit_code,benefit_type,status,quantity_total,quantity_redeemed,benefit_definition_id,benefit_kind,redeemed_at) VALUES($1,$2,$3,$4,$5,'gift_product','redeemed',1,1,$6,'gift_product',clock_timestamp())",[benefitId,tenantId,storeId,customerId,`P${benefitId.slice(0,8)}`,definitionId])
    await pool.query("INSERT INTO mbox.benefit_reservations(id,tenant_id,store_id,benefit_id,customer_id,table_session_id,quantity,status,reservation_idempotency_key,reservation_fingerprint,reserved_at,expires_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,1,'redeemed',$7,'test',statement_timestamp(),statement_timestamp()+interval '10 minutes',statement_timestamp())",[reservationId,tenantId,storeId,benefitId,customerId,row.tableSessionId,randomUUID()])
    await pool.query("INSERT INTO mbox.membership_annual_benefit_grants(tenant_id,store_id,membership_id,customer_id,policy_version_id,rule_id,cycle_key,benefit_id,granted_at,expires_at,stack_group,priority,window_starts_on,window_ends_on) VALUES($1,$2,$3,$4,$5,$6,$7::text,$8,statement_timestamp(),statement_timestamp()+interval '1 day','daily_snack',100,$7::text::date,$7::text::date)",[tenantId,storeId,membershipId,customerId,policyId,ruleId,businessDate,benefitId])
    await pool.query("INSERT INTO mbox.annual_daily_snack_claims(id,tenant_id,store_id,membership_id,customer_id,policy_version_id,rule_id,business_date,table_session_id,claim_code,quantity,benefit_id,benefit_reservation_id,status,expires_at,gift_order_id,redeemed_by_employee_id,redeemed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,'redeemed',clock_timestamp()+interval '10 minutes',$13,$14,clock_timestamp())",[claimId,tenantId,storeId,membershipId,customerId,policyId,ruleId,businessDate,row.tableSessionId,`DSN-${claimId.replaceAll('-','').slice(0,18).toUpperCase()}`,benefitId,reservationId,row.orderId,employeeId])
    await runner.run(scope,tx=>tx.query("INSERT INTO mbox.benefit_redemptions(tenant_id,store_id,benefit_id,benefit_reservation_id,customer_id,table_session_id,quantity,redemption_idempotency_key,redemption_fingerprint,redeemed_by_employee_id,gift_order_reference,authorization_source) VALUES($1,$2,$3,$4,$5,$6,1,$7,'test',$8,$9,'{\"kind\":\"staff_assisted\"}')",[tenantId,storeId,benefitId,reservationId,customerId,row.tableSessionId,randomUUID(),employeeId,`k-${row.orderId}`]))
    await pool.query("INSERT INTO mbox.table_assignments(tenant_id,store_id,table_id,employee_id,role_id,assignment_type,starts_at,reason) VALUES($1,$2,$3,$4,$5,'primary',clock_timestamp()-interval '1 hour','测试权益原桌服务权限')",[tenantId,storeId,row.tableId,employeeId,roleId])
    await pool.query('INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)',[tenantId,storeId,membershipId,customerId])
    return {claimId,benefitId,customerId}
  }
})
