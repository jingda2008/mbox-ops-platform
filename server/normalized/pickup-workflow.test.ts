import {createHash,randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {readPhysicalPickupUnits} from './pickup-workflow-query.js'
import Fastify from 'fastify'
import {Pool} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type TransactionOptions,type ScopedTransaction,type StoreScope} from './transaction-runner.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {ItemQuantityFulfillmentRepository} from './item-quantity-fulfillment-repository.js'
import {QuantityRemakeRepository} from './quantity-remake-repository.js'
import {QuantityRemakeFulfillmentRepository} from './quantity-remake-fulfillment-repository.js'
import {readTableSessionClosureState} from './table-session-closure-blockers.js'
import {pickupWorkflowApiPlugin} from './pickup-workflow-api.js'
import {AnnualDailySnackClaimService} from './annual-daily-snack-claim-service.js'
import {TableSessionRepository} from './table-session-repository.js'
import {FulfillmentQueryService} from './fulfillment-query-service.js'
import {parsePickupCommand,type PickupBoardData,type PickupCommand,type PickupCommandResult} from '../../src/shared/pickup-workflow.js'

const databaseUrl=process.env.TEST_NORMALIZED_DATABASE_URL
const integration=databaseUrl?describe:describe.skip
integration('trusted pickup exact physical transaction boundary',()=>{
  const tenantId=randomUUID(),storeId=randomUUID(),employeeId=randomUUID(),areaId=randomUUID(),productId=randomUUID(),roleId=randomUUID()
  const credentialId=randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID(),scope={tenantId,storeId}
  let currentSessionId=staffSessionId
  const latency:Array<Record<string,unknown>>=[]
  let captureUpdatePlan=false,captureReadPlan=false
  let pool:Pool,runner:ScopedPostgresTransactionRunner,runtime:ScopedPostgresTransactionRunner,businessDate:string
  const app=Fastify({logger:{level:'error'}})
  beforeAll(async()=>{
    await runNormalizedMigrations(databaseUrl!);pool=new Pool({connectionString:databaseUrl,max:8});runner=new ScopedPostgresTransactionRunner(pool)
    runtime={run:<T>(s:StoreScope,operation:(tx:ScopedTransaction)=>Promise<T>,options?:TransactionOptions)=>runner.run(s,async tx=>{await tx.query('SET LOCAL ROLE mbox_runtime');if(process.env.PICKUP_FORCE_GENERIC_PLAN==='true')await tx.query('SET LOCAL plan_cache_mode=force_generic_plan');return operation(!process.env.PICKUP_QUERY_PLAN_OUTPUT?tx:{...tx,query:async(text,values)=>{
      if(captureReadPlan&&text.startsWith('WITH eligible_items')){
        captureReadPlan=false;const plans:Record<string,unknown>={}
        for(const [label,jit] of [['firstOn','on'],['off','off'],['secondOn','on']]){await tx.query(`SET LOCAL jit=${jit}`);plans[label!]=(await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${text}`,values)).rows}
        writeFileSync(process.env.PICKUP_QUERY_PLAN_OUTPUT!.replace('.json','-read-cold.json'),JSON.stringify(plans,null,2))
      }
      if(captureUpdatePlan&&text.startsWith("UPDATE mbox.order_item_quantity_units SET production_state='delivered'")){
        captureUpdatePlan=false;const plans:Record<string,unknown>={}
        for(const jit of ['on','off']){await tx.query(`SET LOCAL jit=${jit}`);await tx.query('SAVEPOINT pickup_plan');plans[jit]=(await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${text}`,values)).rows;await tx.query('ROLLBACK TO SAVEPOINT pickup_plan');await tx.query('RELEASE SAVEPOINT pickup_plan')}
        await tx.query('SET LOCAL jit=on');writeFileSync(process.env.PICKUP_QUERY_PLAN_OUTPUT!.replace('.json','-update.json'),JSON.stringify(plans,null,2))
      }
      const began=performance.now();try{return await tx.query(text,values)}finally{const duration=performance.now()-began;if(duration>150)console.info('slow pickup sql ms',Math.round(duration),text.slice(0,360))}}})},options)} as ScopedPostgresTransactionRunner
    await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Kitchen isolation')",[tenantId,`k-${tenantId}`])
    await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,'kitchen-store','Kitchen','Asia/Shanghai','06:00')",[storeId,tenantId])
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
    await app.register(pickupWorkflowApiPlugin,{enabled:true,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId:currentSessionId,deviceAccessLeaseId:leaseId,businessDate})})
  },30000)
  afterAll(async()=>{
    await app.close();await pool?.end()
    if(process.env.PICKUP_LATENCY_OUTPUT){
      const paths=['server/normalized/pickup-workflow-api.ts','server/normalized/pickup-workflow-query.ts','server/normalized/pickup-workflow-repository.ts','server/normalized/pickup-workflow.test.ts','server/normalized/item-quantity-projection.ts','src/shared/pickup-workflow.ts','database/normalized-migrations/225_loyalty_order_financial_basis.sql','database/normalized-migrations/226_inventory_waste_receipts.sql','database/normalized-migrations/227_staff_permission_deployment_recovery.sql','database/normalized-migrations/228_three_screen_workflow.sql']
      writeFileSync(process.env.PICKUP_LATENCY_OUTPUT,JSON.stringify({measuredAt:new Date().toISOString(),boundary:'Local Fastify.inject plus isolated PostgreSQL under mbox_runtime, sequential regression with accumulated fixture data; excludes physical production, network, touch and delivery travel.',outsideScopeFixtureUnits:1000,forceGenericPlan:process.env.PICKUP_FORCE_GENERIC_PLAN==='true',sourceSha256:Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),samples:latency},null,2))
    }
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
  async function board(){const started=performance.now(),response=await app.inject('/api/commerce/pickup-board');expect(response.statusCode,response.body).toBe(200);const data=response.json().data as PickupBoardData;latency.push({operation:'board',elapsedMs:performance.now()-started,pendingUnits:data.tables.reduce((n,table)=>n+table.units.length,0),historyReceipts:data.history.length});return data}
  const configure=(enabled=true,key=randomUUID())=>app.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':key},payload:{enabled,label:'吧台共用平板'}})
  const command=async(body:PickupCommand,key=randomUUID())=>{const started=performance.now(),response=await app.inject({method:'POST',url:'/api/commerce/pickup-board/commands',headers:{'idempotency-key':key},payload:body});latency.push({operation:body.action,statusCode:response.statusCode,elapsedMs:performance.now()-started,quantity:response.statusCode===200?response.json().data.receipt.quantity:body.action==='take'?body.units.length:null});return response}
  async function take(row:{tableSessionId:string},count?:number){const group=(await board()).tables.find(table=>table.tableSessionId===row.tableSessionId)!;expect(group).toBeDefined()
    return {action:'take',tableId:group.tableId,tableSessionId:group.tableSessionId,locationVersion:group.locationVersion,units:group.units.slice(0,count).map(unit=>({kind:unit.kind,unitId:unit.unitId,version:unit.version}))} as const}
  async function ok(body:PickupCommand,key?:string){const response=await command(body,key);expect(response.statusCode,response.body).toBe(200);return response.json().data as PickupCommandResult}
  const undo=(result:PickupCommandResult)=>({action:'undo',receiptId:result.receipt.receiptId,expectedRevision:result.receipt.revision,physicalStillAtPickupPoint:true} as const)
  async function ready(row:{itemId:string;taskId:string},quantity=5){return runtime.run(scope,tx=>new ItemQuantityFulfillmentRepository(tx).complete({...row,employeeId,quantity,eventKey:randomUUID()}))}
  async function financial(row:{stockId:string;orderId:string}){return (await pool.query(`SELECT original.payment_status,original.total_amount_minor::text,
    (SELECT count(*)::int FROM mbox.inventory_movements movement WHERE movement.inventory_item_id=$1) AS movements,
    (SELECT on_hand_quantity::text FROM mbox.inventory_balances WHERE inventory_item_id=$1) AS on_hand,
    (SELECT reserved_quantity::text FROM mbox.inventory_balances WHERE inventory_item_id=$1) AS reserved,
    (SELECT jsonb_agg(to_jsonb(movement) ORDER BY movement.id) FROM mbox.inventory_movements movement WHERE movement.inventory_item_id=$1) AS ledger,
    (SELECT count(*)::int FROM mbox.payments payment WHERE payment.order_id=original.id) AS payments
    FROM mbox.orders original WHERE original.id=$2`,[row.stockId,row.orderId])).rows[0]}
  async function seedOutsideScopePlannerLoad(){
    const tenant=randomUUID();await pool.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'取餐性能隔离背景租户')",[tenant,`load-${tenant}`])
    for(let storeIndex=0;storeIndex<2;storeIndex++){
      const store=randomUUID(),area=randomUUID(),table=randomUUID(),visit=randomUUID(),product=randomUUID()
      await pool.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,$3,'外店统计背景')",[store,tenant,`load-${storeIndex}`])
      await pool.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'L','L','indoor')",[area,tenant,store])
      await pool.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,'L','L',2)",[table,tenant,store,area])
      await pool.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,$5,$6,1)",[visit,tenant,store,table,`load-${visit}`,businessDate])
      await pool.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($1,$2,$3,'L','外店测试商品','food','kitchen')",[product,tenant,store])
      const rows=Array.from({length:500},()=>({orderId:randomUUID(),itemId:randomUUID(),taskId:randomUUID(),unitId:randomUUID()})),payload=JSON.stringify(rows)
      await pool.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor)
        SELECT (r->>'orderId')::uuid,$1,$2,$3,'load-'||(r->>'orderId'),'staff_assisted','submitted',clock_timestamp(),0,0 FROM jsonb_array_elements($4::jsonb) r`,[tenant,store,visit,payload])
      await pool.query(`INSERT INTO mbox.order_items(id,tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,fulfillment_station,product_snapshot,status)
        SELECT (r->>'itemId')::uuid,$1,$2,(r->>'orderId')::uuid,$3,1,0,0,'kitchen','{"name":"外店测试商品","inventoryControlMode":"not_managed"}','ready' FROM jsonb_array_elements($4::jsonb) r`,[tenant,store,product,payload])
      await pool.query(`INSERT INTO mbox.kds_tasks(id,tenant_id,store_id,order_item_id,station_code,quantity,status,ready_at)
        SELECT (r->>'taskId')::uuid,$1,$2,(r->>'itemId')::uuid,'kitchen',1,'ready',clock_timestamp() FROM jsonb_array_elements($3::jsonb) r`,[tenant,store,payload])
      await pool.query(`INSERT INTO mbox.order_item_quantity_units(id,tenant_id,store_id,order_item_id,unit_index,original_amount_minor,inventory_evidence_state,production_state)
        SELECT (r->>'unitId')::uuid,$1,$2,(r->>'itemId')::uuid,0,0,'untracked','ready' FROM jsonb_array_elements($3::jsonb) r`,[tenant,store,payload])
    }
    for(const relation of ['orders','order_items','kds_tasks','table_sessions','order_item_quantity_units','pickup_receipts','pickup_receipt_parts'])await pool.query(`ANALYZE mbox.${relation}`)
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
    return {claimId,benefitId}
  }
  it('requires server-trusted device purpose and keeps the durable scope across configuration/revocation',async()=>{
    const before=await board();expect(before.device).toBeNull();expect(before.actor.canPickup).toBe(false);expect(before.actor.canConfigure).toBe(true)
    const key=randomUUID(),response=await configure(true,key);expect(response.statusCode,response.body).toBe(200)
    const current=await board();expect(current.commandScope).toBe(before.commandScope);expect(current.device?.label).toBe('吧台共用平板')
    expect((await configure(true,key)).json().data).toEqual(response.json().data)
    expect((await configure(false,key)).statusCode).toBe(409)
    const concurrent=await Promise.all([configure(),configure()]);expect(concurrent.map(response=>response.statusCode)).toEqual([200,200])
  })
  it('takes exact cross-station portions from one table, preserves stock/payment and binds anonymous device history',async()=>{
    const first=await item('',true),second=await item('少冰',false,first),other=await item()
    await pool.query("UPDATE mbox.kds_tasks SET station_code='bar' WHERE id=$1",[second.taskId])
    await ready(first,2);await ready(second,1);await ready(other,1)
    const before=await financial(first);expect(before.movements).toBeGreaterThan(0);expect(before.ledger).toHaveLength(before.movements);const body=await take(first),key=randomUUID(),result=await ok(body,key)
    expect(result.receipt.revision).toBe(1);expect(result.revision).toBeGreaterThan(1_000_000);expect((await board()).revision).toBeGreaterThanOrEqual(result.revision)
    expect(result.receipt.quantity).toBe(3);expect(result.receipt.units.map(unit=>unit.station).sort()).toEqual(['bar','kitchen','kitchen'])
    expect(result.receipt.pickerEmployeeId).toBeNull();expect(result.receipt.deliverySource).toBe('pickup');expect(result.receipt.deliveryConfirmedAt).toBe(result.receipt.takenAt)
    expect(result.receipt.units.every(unit=>unit.readyAt!==null)).toBe(true)
    expect((await ok(body,key)).receipt.receiptId).toBe(result.receipt.receiptId)
    expect((await board()).tables.find(table=>table.tableSessionId===other.tableSessionId)?.units).toHaveLength(1)
    expect(await financial(first)).toEqual(before)
    const audits=(await pool.query("SELECT count(*)::int AS n FROM mbox.audit_events WHERE tenant_id=$1 AND object_id=$2 AND action='kds.deliver'",[tenantId,first.taskId])).rows[0].n
    expect(audits).toBe(0)
    await pool.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND operation_scope='commerce.pickup'",[tenantId])
    expect((await ok(body,key)).receipt.receiptId).toBe(result.receipt.receiptId)
    const reverted=await ok(undo(result));expect(reverted.receipt.revision).toBe(2);expect(reverted.revision).toBeGreaterThan(result.revision);expect((await board()).revision).toBeGreaterThanOrEqual(reverted.revision);expect(reverted.receipt.undo).not.toBeNull();expect((await board()).tables.find(table=>table.tableSessionId===first.tableSessionId)?.units).toHaveLength(3)
    const retaken=await ok(await take(first));expect(retaken.receipt.receiptId).not.toBe(result.receipt.receiptId)
    expect((await command(undo(result))).json().error.code).toBe('PICKUP_UNDO_UNAVAILABLE');expect(await financial(first)).toEqual(before)
  })
  it('concurrent clicks have one winner and stale cards cannot take newly ready portions',async()=>{
    const row=await item('',true);await ready(row,2);const body=await take(row,1)
    const responses=await Promise.all([command(body),command(body)])
    expect(responses.map(response=>response.statusCode).sort()).toEqual([200,409])
    await ready(row,2);expect((await command(body)).statusCode).toBe(409)
    expect((await board()).tables.find(table=>table.tableSessionId===row.tableSessionId)?.units).toHaveLength(3)
  })
  it('undo is idempotent, SQL cannot rewind without its exact current receipt, and original item/closure recover',async()=>{
    const row=await item();await ready(row);const picked=await ok(await take(row)),unit=picked.receipt.units[0]!
    const before=await runtime.run(scope,tx=>readTableSessionClosureState(tx,row.tableSessionId));expect(before.blockers.some(blocker=>blocker.code==='ORDER_ITEM_UNRESOLVED')).toBe(false)
    await expect(runtime.run(scope,tx=>tx.query("UPDATE mbox.order_item_quantity_units SET production_state='ready' WHERE id=$1",[unit.unitId]))).rejects.toMatchObject({code:'23514'})
    const key=randomUUID(),undone=await ok(undo(picked),key);expect((await ok(undo(picked),key)).receipt.undo).toEqual(undone.receipt.undo)
    expect((await pool.query('SELECT status FROM mbox.order_items WHERE id=$1',[row.itemId])).rows[0].status).toBe('ready')
    const after=await runtime.run(scope,tx=>readTableSessionClosureState(tx,row.tableSessionId));expect(after.blockers.some(blocker=>blocker.code==='ORDER_ITEM_UNRESOLVED')).toBe(true)
    await expect(runtime.run(scope,tx=>tx.query("UPDATE mbox.order_item_quantity_units SET fulfillment_revision=fulfillment_revision+1 WHERE id=$1",[unit.unitId]))).rejects.toMatchObject({code:'23514'})
  })
  it('preserves original delivery history while current remake pickup/undo controls closure and exact generation',async()=>{
    const row=await item('',true);await ready(row);const original=await ok(await take(row)),before=await financial(row)
    const batch=await runtime.run(scope,tx=>new QuantityRemakeRepository(tx).create({itemId:row.itemId,employeeId,quantity:1,originalGoodsLost:true,reason:'测试原货损坏后实际重做',eventKey:randomUUID()}))
    await runtime.run(scope,tx=>new QuantityRemakeFulfillmentRepository(tx).act({taskId:batch.taskId,employeeId,quantity:1,action:'complete',eventKey:randomUUID()}))
    expect((await command(undo(original))).json().error.code).toBe('PICKUP_UNDO_UNAVAILABLE')
    const afterMaking=await financial(row);expect(afterMaking.movements).toBe(before.movements+1)
    const body=await take(row);expect(body.units.map(unit=>unit.kind)).toEqual(['remake'])
    const picked=await ok(body);await ok(undo(picked));expect(await financial(row)).toEqual(afterMaking)
    expect((await pool.query('SELECT status FROM mbox.order_items WHERE id=$1',[row.itemId])).rows[0].status).toBe('delivered')
    expect((await runtime.run(scope,tx=>readTableSessionClosureState(tx,row.tableSessionId))).blockers.some(blocker=>blocker.code==='KDS_ACTIVE')).toBe(true)
    expect((await runtime.run(scope,tx=>tx.query<{current:string}>('SELECT mbox.pickup_order_current_fulfillment($1,$2,$3) AS current',[tenantId,storeId,row.orderId]))).rows[0]!.current).toBe('ready')
    await ok(await take(row))
    expect((await runtime.run(scope,tx=>readTableSessionClosureState(tx,row.tableSessionId))).blockers.some(blocker=>blocker.code==='KDS_ACTIVE')).toBe(false)
  })
  it('trusted GET safely adopts reliable old ready facts without inventory movements',async()=>{
    const row=await item();await pool.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE id=$1",[row.taskId])
    expect((await board()).tables.find(table=>table.tableSessionId===row.tableSessionId)?.units).toHaveLength(5)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.inventory_movements WHERE order_item_id=$1',[row.itemId])).rows[0].n).toBe(0)
  })
  it('corrects annual-benefit current fulfillment without reopening redeemed eligibility or changing historical completion',async()=>{
    const row=await item('',false,undefined,true),ids=await annualClaim(row);await ready(row)
    const service=new AnnualDailySnackClaimService(runtime,new NormalizedCommandExecutor(runtime)),context={scope,employeeId,businessDate}
    const claim=async()=>(await service.listForStaff(context,row.tableSessionId)).find(claim=>claim.id===ids.claimId)!
    expect((await claim()).currentFulfillmentStatus).toBe('ready')
    const picked=await ok(await take(row)),completed=await claim();expect(completed.status).toBe('fulfilled');expect(completed.currentFulfillmentStatus).toBe('delivered')
    const facts=async()=>(await pool.query(`SELECT benefit.status,benefit.quantity_total,benefit.quantity_reserved,benefit.quantity_redeemed,grant_row.status AS grant_status,
      (SELECT count(*)::int FROM mbox.benefit_redemptions redemption WHERE redemption.benefit_id=benefit.id) AS redemption_count
      FROM mbox.benefits benefit JOIN mbox.membership_annual_benefit_grants grant_row ON grant_row.benefit_id=benefit.id WHERE benefit.id=$1`,[ids.benefitId])).rows[0]
    const before=await facts();expect(before.grant_status).toBe('fulfilled')
    await ok(undo(picked));const corrected=await claim();expect(corrected.status).toBe('fulfilled');expect(corrected.fulfilledAt).toBe(completed.fulfilledAt);expect(corrected.currentFulfillmentStatus).toBe('ready');expect(await facts()).toEqual(before)
    await ok(await take(row));expect(await facts()).toEqual(before)
  })
  it('rejects old table locations, held goods and closed visits without partial changes',async()=>{
    const row=await item();await ready(row);const body=await take(row)
    const target=await table();await runtime.run(scope,tx=>tx.query(`SELECT * FROM mbox.execute_table_customer_movement('whole_table_transfer',$1,NULL,$2,2,'{}','{}','{}',$3,'测试领取转桌并发保护',$4,$5::char(64),NULL,NULL,'{}')`,[row.tableSessionId,target,employeeId,randomUUID(),createHash('sha256').update(target).digest('hex')]))
    expect((await command(body)).json().error.code).toBe('PICKUP_TABLE_MOVED')
    const picked=await ok(await take(row))
    await runtime.run(scope,tx=>new ItemQuantityRepository(tx).hold({orderItemId:row.itemId,quantity:1,kind:'unpaid_stop',allowMadeUnpaidHold:true,employeeId,businessDate,reason:'测试暂停商品核对'}))
    expect((await command(undo(picked))).json().error.code).toBe('PICKUP_UNDO_UNAVAILABLE')
  })
  it('explicitly recovers the same original intent after session replacement, rejects another device and changed body, and serializes recovery',async()=>{
    const row=await item('',true);await ready(row,2);const body=await take(row,1),key=randomUUID(),oldSessionId=currentSessionId,oldScope=(await board()).commandScope
    const picked=await ok(body,key),remaining=await take(row,1),neverSentKey=randomUUID(),before=await financial(row)
    const recoveryBody={staffSessionId:oldSessionId,commandScope:oldScope,idempotencyKey:key,request:{kind:'command',command:body}}
    const recover=(payload:unknown)=>app.inject({method:'POST',url:'/api/commerce/pickup-board/recovery',payload})
    await pool.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[oldSessionId])
    currentSessionId=randomUUID()
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[currentSessionId,tenantId,storeId,employeeId,leaseId,createHash('sha256').update(currentSessionId).digest('hex')])
    expect((await board()).commandScope).not.toBe(oldScope)
    const recovered=await recover(recoveryBody);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().data.data.receipt.receiptId).toBe(picked.receipt.receiptId)
    expect((await recover({...recoveryBody,request:{kind:'command',command:remaining}})).statusCode).toBe(409)
    expect((await recover({...recoveryBody,commandScope:'0'.repeat(64)})).statusCode).toBe(403)
    const otherLease=randomUUID(),otherSession=randomUUID()
    await pool.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,repeat('d',64),repeat('e',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[otherLease,tenantId,storeId,credentialId])
    await pool.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,repeat('f',64),statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[otherSession,tenantId,storeId,employeeId,otherLease])
    expect((await recover({...recoveryBody,staffSessionId:otherSession})).statusCode).toBe(403)
    const unsent={...recoveryBody,idempotencyKey:neverSentKey,request:{kind:'command',command:remaining}}
    const responses=await Promise.all([recover(unsent),recover(unsent)]);expect(responses.some(response=>response.statusCode===200)).toBe(true)
    const final=await recover(unsent);expect(final.statusCode,final.body).toBe(200)
    const receiptId=final.json().data.data.receipt.receiptId
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.pickup_receipts WHERE id=$1',[receiptId])).rows[0].n).toBe(1)
    expect(await financial(row)).toEqual(before)
  })
  it('database receipt-bound undo rejects transfer and forged device source even when a low-privilege caller inserts an undo record',async()=>{
    const row=await item();await ready(row);const picked=await ok(await take(row)),target=await table(),device=(await board()).device!
    await runtime.run(scope,tx=>tx.query(`SELECT * FROM mbox.execute_table_customer_movement('whole_table_transfer',$1,NULL,$2,2,'{}','{}','{}',$3,'测试领取后换桌不能回退原领取',$4,$5::char(64),NULL,NULL,'{}')`,[row.tableSessionId,target,employeeId,randomUUID(),createHash('sha256').update(target).digest('hex')]))
    expect((await command(undo(picked))).json().error.code).toBe('PICKUP_UNDO_UNAVAILABLE')
    await expect(runtime.run(scope,async tx=>{
      await tx.query(`INSERT INTO mbox.pickup_undos(tenant_id,store_id,receipt_id,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,physical_still_at_pickup_point) VALUES($1,$2,$3,$4,$5,$6,$7,true)`,[tenantId,storeId,picked.receipt.receiptId,device.id,employeeId,currentSessionId,leaseId])
      await tx.query("UPDATE mbox.order_item_quantity_units SET production_state='ready',current_pickup_receipt_id=NULL,fulfillment_revision=fulfillment_revision+1 WHERE id=ANY($1::uuid[])",[picked.receipt.units.map(unit=>unit.unitId)])
    })).rejects.toMatchObject({code:'23514'})
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.pickup_undos WHERE receipt_id=$1',[picked.receipt.receiptId])).rows[0].n).toBe(0)
    await expect(runtime.run(scope,tx=>tx.query(`INSERT INTO mbox.pickup_undos(tenant_id,store_id,receipt_id,device_id,authorized_employee_id,staff_session_id,device_access_lease_id,physical_still_at_pickup_point) VALUES($1,$2,$3,$4,$5,$6,$7,true)`,[tenantId,storeId,picked.receipt.receiptId,device.id,employeeId,staffSessionId,leaseId]))).rejects.toMatchObject({code:'23514'})
  })
  it('returns a definite uncommitted error for more than 50 tasks instead of an unrecoverable unknown command',async()=>{
    await seedOutsideScopePlannerLoad()
    const first=await item();await ready(first,1)
    for(let index=0;index<50;index++){const next=await item('',false,first);await ready(next,1)}
    captureReadPlan=process.env.PICKUP_CAPTURE_COLD_DIAGNOSTICS==='true'
    const started=performance.now(),body=await take(first),boardAt=performance.now(),response=await command(body),rejectedAt=performance.now()
    expect(response.statusCode,response.body).toBe(400);expect(response.json().error).toMatchObject({code:'PICKUP_INVALID',commitDisposition:'not_committed'})
    captureUpdatePlan=process.env.PICKUP_CAPTURE_COLD_DIAGNOSTICS==='true'
    const portion={...body,units:body.units.slice(0,50)},picked=await ok(portion),takenAt=performance.now();expect(picked.receipt.quantity).toBe(50)
    await ok(undo(picked));const undoneAt=performance.now();expect((await board()).tables.find(table=>table.tableSessionId===first.tableSessionId)?.units).toHaveLength(51)
    console.info('51-task phases ms',{board:boardAt-started,rejected:rejectedAt-boardAt,take:takenAt-rejectedAt,undo:undoneAt-takenAt,reread:performance.now()-undoneAt})
    console.info('51-task board / rejected take / 50-task take + undo / reread elapsed ms',Math.round(performance.now()-started))
    const single=await ok(await take(first,1));await ok(undo(single))
    if(process.env.PICKUP_QUERY_PLAN_OUTPUT){
      let sql='',parameters:readonly unknown[]|undefined
      await runtime.run(scope,tx=>readPhysicalPickupUnits({...tx,query:(text,values)=>{sql=text;parameters=values;return tx.query(text,values)}}))
      const plans:Record<string,unknown>={}
      for(const [name,statement] of [['current',sql]] as const){
        try{plans[name]=await runtime.run(scope,async tx=>{await tx.query("SET LOCAL statement_timeout='10s'");return (await tx.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`,parameters)).rows})}
        catch(error){plans[name]={error:error instanceof Error?error.message:String(error)}}
      }
      writeFileSync(process.env.PICKUP_QUERY_PLAN_OUTPUT,JSON.stringify(plans,null,2))
    }
  },60000)
  it('serializes a legal zero-due table closure against pickup undo without reopening the visit',async()=>{
    const row=await item('',false,undefined,true);await ready(row);const picked=await ok(await take(row))
    expect((await runtime.run(scope,tx=>readTableSessionClosureState(tx,row.tableSessionId))).blockers).toEqual([])
    let release!:()=>void,locked!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{locked=resolve})
    const closing=runtime.run(scope,async tx=>{
      await new TableSessionRepository(tx).beginClosing(row.tableSessionId,employeeId)
      expect((await readTableSessionClosureState(tx,row.tableSessionId)).blockers).toEqual([])
      locked();await gate
      await new TableSessionRepository(tx).completeClosing(row.tableSessionId,employeeId)
    })
    await Promise.race([entered,closing]);const pending=command(undo(picked));release();await closing
    const response=await pending;expect(response.statusCode,response.body).toBe(409)
    expect((await pool.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[row.tableSessionId])).rows[0].status).toBe('closed')
    expect((await pool.query("SELECT count(*)::int AS n FROM mbox.order_item_quantity_units WHERE order_item_id=$1 AND production_state='delivered'",[row.itemId])).rows[0].n).toBe(5)
    expect((await pool.query('SELECT count(*)::int AS n FROM mbox.pickup_undos WHERE receipt_id=$1',[picked.receipt.receiptId])).rows[0].n).toBe(0)
  })
  it('pauses new device admission while an existing trusted device finishes ready goods and exact undo',async()=>{
    const paused=Fastify(),setupKey=randomUUID()
    const setup=await configure(true,setupKey);expect(setup.statusCode,setup.body).toBe(200)
    await paused.register(pickupWorkflowApiPlugin,{enabled:false,prefix:'/api',staffAccessTransactions:runtime,commandExecutor:new NormalizedCommandExecutor(runtime),resolveContext:()=>({scope,employeeId,staffSessionId:currentSessionId,deviceAccessLeaseId:leaseId,businessDate})})
    try{
      const row=await item('',true);await ready(row,2)
      const legacy=await item();await pool.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE id=$1",[legacy.taskId])
      const response=await paused.inject('/api/commerce/pickup-board');expect(response.statusCode,response.body).toBe(200)
      const view=response.json().data as PickupBoardData
      expect(view.setup).toMatchObject({enabled:false,configured:true,canConfigure:false});expect(view.recoveryAvailable).toBe(true);expect(view.actor.canPickup).toBe(true)
      expect(view.tables.find(table=>table.tableSessionId===legacy.tableSessionId)?.units).toHaveLength(5)
      const phoneQueue=()=>new FulfillmentQueryService(runtime,false,false).getStaffWorkQueue(scope,employeeId,businessDate,{staffSessionId:currentSessionId,deviceAccessLeaseId:leaseId})
      expect((await phoneQueue()).actor).toMatchObject({threeScreenWorkflowEnabled:false,sharedPickupActive:true,threeScreenRecoveryAvailable:true})
      const before=await financial(row),body=await take(row)
      const act=(payload:PickupCommand,key=randomUUID())=>paused.inject({method:'POST',url:'/api/commerce/pickup-board/commands',headers:{'idempotency-key':key},payload})
      const taken=await act(body);expect(taken.statusCode,taken.body).toBe(200)
      const reverted=await act(undo(taken.json().data));expect(reverted.statusCode,reverted.body).toBe(200);expect(await financial(row)).toEqual(before)
      const replay=await paused.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':setupKey},payload:{enabled:true,label:'吧台共用平板'}})
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(setup.json().data)
      const revoke=await paused.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':randomUUID()},payload:{enabled:false}});expect(revoke.statusCode,revoke.body).toBe(200)
      expect((await paused.inject('/api/commerce/pickup-board')).json().data.recoveryAvailable).toBe(false)
      expect((await phoneQueue()).actor.sharedPickupActive).toBe(false)
      const denied=await paused.inject({method:'POST',url:'/api/commerce/pickup-board/device',headers:{'idempotency-key':randomUUID()},payload:{enabled:true}})
      expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error).toMatchObject({code:'PICKUP_ADMISSION_PAUSED',commitDisposition:'not_committed'})
      expect((await act(body)).statusCode).toBe(403)
    }finally{await paused.close();await configure()}
  })
  it('RLS hides other scopes, immutable receipts resist edits, and revoked devices reject cached actions with unknown disposition',async()=>{
    const row=await item();await ready(row);const body=await take(row),key=randomUUID(),picked=await ok(body,key)
    expect(await runtime.run({...scope,storeId:randomUUID()},async tx=>(await tx.query('SELECT id FROM mbox.pickup_receipts')).rowCount,{readOnly:true})).toBe(0)
    await expect(runtime.run(scope,tx=>tx.query('DELETE FROM mbox.pickup_receipts WHERE id=$1',[picked.receipt.receiptId]))).rejects.toMatchObject({code:'42501'})
    await expect(runtime.run(scope,tx=>tx.query("UPDATE mbox.pickup_receipts SET snapshot='{}' WHERE id=$1",[picked.receipt.receiptId]))).rejects.toMatchObject({code:'42501'})
    const previousScope=(await board()).commandScope;expect((await configure(false)).statusCode).toBe(200);expect((await board()).commandScope).toBe(previousScope)
    const denied=await command(body,key);expect(denied.statusCode).toBe(403);expect(denied.json().error.commitDisposition).toBe('unknown')
    await configure();expect((await ok(body,key)).receipt.receiptId).toBe(picked.receipt.receiptId)
    await pool.query('UPDATE mbox.staff_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[currentSessionId])
    expect((await command(body,key)).statusCode).toBe(403)
  })
})

describe('pickup command validation',()=>{
  it('requires exact unique physical selections and physical availability assertion for undo',()=>{
    const id=randomUUID(),base={action:'take',tableId:randomUUID(),tableSessionId:randomUUID(),locationVersion:0,units:[{kind:'original',unitId:id,version:0}]}
    expect(parsePickupCommand(base)).toEqual(base)
    expect(()=>parsePickupCommand({...base,units:[...base.units,...base.units]})).toThrow('重复')
    expect(()=>parsePickupCommand({action:'undo',receiptId:randomUUID(),expectedRevision:1})).toThrow('实物')
  })
})
