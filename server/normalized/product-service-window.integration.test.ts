import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner} from './transaction-runner.js'
import {saveProductServiceWindow,readProductServiceWindow} from './product-service-window-repository.js'
import {OrderRepository} from './order-repository.js'
import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {validateProductPaymentWindow} from './product-payment-window.js'
import {PaymentProviderActionRepository} from './payment-provider-action-repository.js'
import {OnlinePaymentService} from './online-payment-service.js'
import {DEFAULT_PRODUCT_SERVICE_WINDOW as all} from '../../src/shared/product-service-window.js'
import {customerSupplyCopy,customerSupplyProjection} from './product-supply-presentation.js'
const database=process.env.TEST_NORMALIZED_DATABASE_URL
;(database?describe:describe.skip)('product time rules in PostgreSQL',()=>{
 const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),customer=randomUUID()
 let admin:Pool,runtime:Pool,runner:ScopedPostgresTransactionRunner
 beforeAll(async()=>{
  await runNormalizedMigrations(database!);admin=new Pool({connectionString:database});runtime=new Pool({connectionString:process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL??database});runner=new ScopedPostgresTransactionRunner(runtime)
  await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Window test')",[scope.tenantId])
  await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone) VALUES($1::uuid,$2,$1::text,'Window test','Asia/Shanghai')",[scope.storeId,scope.tenantId])
  await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,'WINDOW','Window')",[employee,scope.tenantId,scope.storeId])
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[customer,scope.tenantId,scope.storeId])
 })
 afterAll(async()=>{await runtime?.end();await admin?.end()})
 async function product(visible=true){
  const id=randomUUID();await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible) VALUES($1::uuid,$2,$3,$1::text,'定时菜品','test','none',$4)",[id,scope.tenantId,scope.storeId,visible])
  await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',1000,'CNY',clock_timestamp()-interval '1 day')",[scope.tenantId,scope.storeId,id]);return id
 }
 async function card(productId:string,amount=700,owner=customer){
  const project=randomUUID(),app=randomUUID(),holding=randomUUID()
  await admin.query("INSERT INTO mbox.member_card_projects(id,tenant_id,store_id,code,name,kind,terms,available_from,available_until,status,created_by_employee_id,flow_mode,require_social_conditions,social_configuration_required) VALUES($1,$2,$3,$4,'兴趣卡','interest','测试条款',clock_timestamp()-interval '1 day',NULL,'closed',$5,'simple',false,false)",[project,scope.tenantId,scope.storeId,'W'+project.replaceAll('-','').toUpperCase(),employee])
  await admin.query("INSERT INTO mbox.member_card_applications(id,tenant_id,store_id,project_id,customer_id,accepted_project_version,status,reviewed_by_employee_id,resolved_at) VALUES($1,$2,$3,$4,$5,1,'approved',$6,clock_timestamp())",[app,scope.tenantId,scope.storeId,project,owner,employee])
  await admin.query("INSERT INTO mbox.member_cards(id,tenant_id,store_id,project_id,customer_id,application_id,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '1 day',NULL)",[holding,scope.tenantId,scope.storeId,project,owner,app])
  await admin.query('INSERT INTO mbox.member_card_menu_items(tenant_id,store_id,project_id,product_id,exclusive_price_minor,exclusive) VALUES($1,$2,$3,$4,$5,true)',[scope.tenantId,scope.storeId,project,productId,amount]);return {project,holding}
 }
 const q=(sql:string,params:unknown[])=>runner.run(scope,tx=>tx.query(sql,[scope.tenantId,scope.storeId,...params]))
 it('roundtrips typed rules and gives start-inclusive/end-exclusive overnight deadlines',async()=>{
  const id=await product();const window={...all,dateFrom:'2100-01-01',dateThrough:'2100-01-01',weekdays:[5],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1260,visibleEndMinute:1560}
  await runner.run(scope,async tx=>{await saveProductServiceWindow(tx,id,window);expect(await readProductServiceWindow(tx,id)).toEqual(window)})
  for(const [at,active] of [['2100-01-01T13:59:59Z',false],['2100-01-01T14:00:00Z',true],['2100-01-01T17:59:59Z',true],['2100-01-01T18:00:00Z',false]] as const){const r=await q('SELECT mbox.product_base_service_deadline($1,$2,$3,$4) IS NOT NULL AS active',[id,at]);expect(r.rows[0]?.active).toBe(active)}
 })
 it('keeps old daily rules as a supply upper bound and removes only the new rule',async()=>{
  const id=await product();await admin.query("UPDATE mbox.products SET available_from='18:00',available_until='02:00' WHERE id=$1",[id])
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,saleStartMinute:1200,saleEndMinute:1380,visibleStartMinute:1140,visibleEndMinute:1380}))
  expect((await q('SELECT mbox.product_base_service_deadline($1,$2,$3,$4) IS NOT NULL AS active',[id,'2100-01-01T11:00:00Z'])).rows[0]?.active).toBe(false)
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,null))
  expect((await q('SELECT mbox.product_base_service_deadline($1,$2,$3,$4) IS NOT NULL AS active',[id,'2100-01-01T11:00:00Z'])).rows[0]?.active).toBe(true)
 })
 it('validates an intersection across different start dates and rejects genuinely disjoint hours',async()=>{
  const id=await product(false),c=await card(id)
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,dateFrom:'2100-01-01',dateThrough:'2100-01-01',weekdays:[5],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}))
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,dateFrom:'2100-01-02',dateThrough:'2100-01-02',weekdays:[6],saleStartMinute:0,saleEndMinute:60,visibleStartMinute:0,visibleEndMinute:60},c.project))
  await expect(runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,saleStartMinute:600,saleEndMinute:660,visibleStartMinute:600,visibleEndMinute:660},c.project))).rejects.toThrow('没有交集')
 })
 it('allows a permanent simple card after applications close, without opening a hidden product to others',async()=>{
  const id=await product(false);await card(id)
  const r=await q('SELECT mbox.product_visible_now($1,$2,$3,$4) AS mine,mbox.product_visible_now($1,$2,$3,NULL) AS other,mbox.customer_card_price($1,$2,$3,$4)::text AS price',[id,customer])
  expect(r.rows[0]).toEqual({mine:true,other:false,price:'700'})
  expect(await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:id,quantity:1}],'guest_qr'))).toMatchObject({subtotalAmountMinor:700})
  await expect(runner.run(scope,tx=>new OrderRepository(tx,null).quoteCurrent([{productId:id,quantity:1}],'guest_qr'))).rejects.toThrow()
  await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[id])
  await expect(runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent([{productId:id,quantity:1}],'guest_qr'))).rejects.toThrow()
 })
 it('ignores the lower price of a card whose own sale window is closed',async()=>{
  const id=await product(false),cheap=await card(id,500);await card(id,700)
  await admin.query('INSERT INTO mbox.product_service_windows(tenant_id,store_id,product_id,card_project_id,date_from,weekdays,sale_start_minute,sale_end_minute,visible_start_minute,visible_end_minute) VALUES($1,$2,$3,$4,$5,$6,0,1440,0,1440)',[scope.tenantId,scope.storeId,id,cheap.project,'2100-01-01',[1,2,3,4,5,6,7]])
  expect((await q('SELECT mbox.customer_card_price($1,$2,$3,$4)::text AS price',[id,customer])).rows[0]?.price).toBe('700')
 })
 it('projects only the current customer usable visible card conditions and never another customer card rule',async()=>{
  const id=await product(false),mine=await card(id),stranger=randomUUID()
  await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)",[stranger,scope.tenantId,scope.storeId])
  const other=await card(id,700,stranger)
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,saleStartMinute:1080,saleEndMinute:1200},mine.project))
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,saleStartMinute:600,saleEndMinute:720},other.project))
  const presentation=async(owner:string|null)=>(await q(`SELECT ${customerSupplyProjection('product','$4')} FROM mbox.products product WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[id,owner])).rows[0]!.supply_presentation
  const own=await presentation(customer),anonymous=await presentation(null)
  expect(own.cards).toHaveLength(1);expect(own.cards[0].window.saleStartMinute).toBe(1080)
  expect(customerSupplyCopy(own).description).toContain('18:00–20:00')
  expect(customerSupplyCopy(own).description).not.toContain('10:00–12:00')
  expect(JSON.stringify(own)).not.toContain(other.project);expect(anonymous.cards).toEqual([])
  await admin.query("UPDATE mbox.member_cards SET status='suspended' WHERE id=$1",[mine.holding])
  expect((await presentation(customer)).cards).toEqual([])
 })
 it('uses the real base date/weekday/overnight rules and keeps ordinary menu copy independent of card-only schedules',async()=>{
  const id=await product(),c=await card(id)
  const base={...all,dateFrom:'2100-01-01',dateThrough:'2100-01-01',weekdays:[5],saleStartMinute:1320,saleEndMinute:1560,visibleStartMinute:1320,visibleEndMinute:1560}
  await runner.run(scope,tx=>saveProductServiceWindow(tx,id,base))
  await admin.query("UPDATE mbox.products SET available_from='18:00',available_until='02:00' WHERE id=$1",[id])
  const data=(await q(`SELECT ${customerSupplyProjection('product','$4')} FROM mbox.products product WHERE tenant_id=$1 AND store_id=$2 AND id=$3`,[id,customer])).rows[0]!.supply_presentation
  expect(data.cards).toEqual([]);expect(data.window).toEqual(base)
  expect(customerSupplyCopy(data)).toMatchObject({description:expect.stringContaining('2100-01-01至2100-01-01 周五 22:00–次日02:00'),unavailableText:expect.stringContaining('供应日期尚未开始')})
  expect(JSON.stringify(data)).not.toContain(c.project)
 })
 async function paymentOrder(withChoice=false,simulation=false) {
  const p=await product(),area=randomUUID(),table=randomUUID(),session=randomUUID(),payment=randomUUID()
  await admin.query("UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1",[p])
  await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,$4,'Window','indoor')",[area,scope.tenantId,scope.storeId,area.slice(0,8)])
  await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,'Window',2)",[table,scope.tenantId,scope.storeId,area,table.slice(0,8)])
  await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,current_date,1)",[session,scope.tenantId,scope.storeId,table])
  let child:string|null=null,group:string|null=null
  if(withChoice){
   child=await product();group=randomUUID()
   await admin.query("UPDATE mbox.products SET product_kind='bundle' WHERE id=$1",[p])
   await admin.query("UPDATE mbox.products SET inventory_control_mode='not_managed',fulfillment_station='kitchen' WHERE id=$1",[child])
   await admin.query("INSERT INTO mbox.product_bundle_choice_groups(id,tenant_id,store_id,bundle_product_id,code,display_name,selection_count) VALUES($1,$2,$3,$4,'choice','选菜',1)",[group,scope.tenantId,scope.storeId,p])
   await admin.query('INSERT INTO mbox.product_bundle_choice_options(tenant_id,store_id,choice_group_id,component_product_id) VALUES($1,$2,$3,$4)',[scope.tenantId,scope.storeId,group,child])
   const minute=Number((await admin.query("SELECT floor(extract(epoch FROM (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::time)/60)::int AS minute")).rows[0].minute)
   await runner.run(scope,tx=>saveProductServiceWindow(tx,child!,{...all,saleStartMinute:minute,saleEndMinute:minute+3,visibleStartMinute:minute,visibleEndMinute:minute+3}))
  }
  const lines=[{productId:p,quantity:1,...(group&&child?{bundleSelections:[{groups:[{groupId:group,productIds:[child]}]}]}:{})}]
  const quote=await runner.run(scope,tx=>new OrderRepository(tx,customer).quoteCurrent(lines,'guest_qr'))
  const order=await runner.run(scope,tx=>new OrderRepository(tx,customer).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'guest_qr',settlementMode:'immediate_payment',createdByCustomerId:customer,lines}))
  await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($1::uuid,$2,$3,$4,$1::text,$5,$6,1000,'pending')",[payment,scope.tenantId,scope.storeId,order.id,simulation?'simulation':'postar',simulation?'native_qr':'jsapi'])
  await admin.query("INSERT INTO mbox.payment_provider_actions(payment_id,tenant_id,store_id,presentation,initiated_by_type,initiated_by_ref,state,expires_at) VALUES($1,$2,$3,$5,$6,$4,'creating',clock_timestamp()+interval '5 minutes')",[payment,scope.tenantId,scope.storeId,simulation?employee:customer,simulation?'qr':'jsapi',simulation?'employee':'guest'])
  return {p,order,payment,child,quote}
 }
 it('checks the real persisted quote on a new payment and refuses a subsequent product stop',async()=>{
  const f=await paymentOrder(),expiry=new Date(Date.now()+5*60_000).toISOString()
  expect(Date.parse(await runner.run(scope,tx=>validateProductPaymentWindow(tx,f.payment,expiry)))).toBeLessThanOrEqual(Date.parse(expiry))
  await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[f.p])
  await expect(runner.run(scope,tx=>validateProductPaymentWindow(tx,f.payment,expiry))).rejects.toThrow('已变化')
 })
 it.each([false,true])('uses channel success time and preserves late money without releasing food (late=%s)',async late=>{
  const f=await paymentOrder()
  await admin.query("UPDATE mbox.payment_provider_actions SET expires_at=clock_timestamp()-interval '1 minute' WHERE payment_id=$1",[f.payment])
  await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id=$1::text,succeeded_at=clock_timestamp()-make_interval(mins=>$2) WHERE id=$1",[f.payment,late?0:2])
  // Product changes after a valid action must not revoke its original promise.
  await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[f.p])
  const activation=await runner.run(scope,tx=>new PaymentFulfillmentRepository(tx).activatePaidOrder(f.order.id,{paymentId:f.payment}))
  expect(activation.activated).toBe(!late)
  expect((await admin.query('SELECT fulfillment_state FROM mbox.orders WHERE id=$1',[f.order.id])).rows[0].fulfillment_state).toBe(late?'cancelled':'active')
  expect((await admin.query('SELECT status FROM mbox.payments WHERE id=$1',[f.payment])).rows[0].status).toBe('succeeded')
 })
 it('blocks new quotes during preview while still making the dish visible',async()=>{
  const id=await product();await runner.run(scope,tx=>saveProductServiceWindow(tx,id,{...all,dateFrom:'2100-01-01',dateThrough:'2100-01-01',saleStartMinute:1200,saleEndMinute:1380,visibleStartMinute:1080,visibleEndMinute:1380}))
  const r=await q('SELECT mbox.product_visible_now($1,$2,$3,NULL,$4) AS visible,mbox.product_purchase_deadline($1,$2,$3,NULL,$4) IS NOT NULL AS sellable',[id,'2100-01-01T11:00:00Z'])
  expect(r.rows[0]).toEqual({visible:true,sellable:false})
  await expect(runner.run(scope,tx=>new OrderRepository(tx).quoteCurrent([{productId:id,quantity:1}],'staff_assisted'))).rejects.toThrow()
 })
 it('preserves legacy invoice terms and already-settled v3 debt instead of repricing the current menu',async()=>{
  const legacy=await paymentOrder(),expiry=new Date(Date.now()+300000).toISOString();
  await admin.query("UPDATE mbox.order_items SET product_snapshot=product_snapshot-'purchaseRuleVersion' WHERE order_id=$1",[legacy.order.id]);
  await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[legacy.p]);
  expect(await runner.run(scope,tx=>validateProductPaymentWindow(tx,legacy.payment,expiry))).toBe(expiry);
  const settled=await paymentOrder(),supplement=randomUUID();
  await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id=$1::text,succeeded_at=clock_timestamp() WHERE id=$1",[settled.payment]);
  await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($1::uuid,$2,$3,$4,$1::text,'postar','jsapi',1000,'pending')",[supplement,scope.tenantId,scope.storeId,settled.order.id]);
  await admin.query("UPDATE mbox.products SET status='sold_out' WHERE id=$1",[settled.p]);
  expect(await runner.run(scope,tx=>validateProductPaymentWindow(tx,supplement,expiry))).toBe(expiry);
 })

 it('intersects a selected bundle dish deadline at quote, order creation and first payment, refusing a later close',async()=>{
  const f=await paymentOrder(true),expiry=new Date(Date.now()+300000).toISOString()
  expect(f.quote.purchaseDeadline).not.toBeNull()
  const cutoff=Date.parse(f.quote.purchaseDeadline!)
  expect(cutoff).toBeGreaterThan(Date.now())
  expect(cutoff).toBeLessThan(Date.parse(expiry))
  const reserved=(await admin.query('SELECT fulfillment_expires_at FROM mbox.orders WHERE id=$1',[f.order.id])).rows[0].fulfillment_expires_at
  expect(new Date(reserved).getTime()).toBe(cutoff)
  expect(Date.parse(await runner.run(scope,tx=>validateProductPaymentWindow(tx,f.payment,expiry)))).toBe(cutoff)
  await runner.run(scope,tx=>saveProductServiceWindow(tx,f.child!,{...all,dateFrom:'2100-01-01'}))
  await expect(runner.run(scope,tx=>validateProductPaymentWindow(tx,f.payment,expiry))).rejects.toThrow('已变化')
  expect((await admin.query('SELECT state FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows[0].state).toBe('creating')
 })
 it('recovers the original payment after its selected bundle dish closes and fulfills the original paid composition',async()=>{
  const f=await paymentOrder(true,true),secret='bundle-window-recovery-test-secret'
  const expiry=await runner.run(scope,async tx=>{
   const deadline=await validateProductPaymentWindow(tx,f.payment,new Date(Date.now()+300000).toISOString())
   await new PaymentProviderActionRepository(tx,secret).complete(f.payment,'qr',{presentation:'simulation'},deadline,null)
   return deadline
  })
  await runner.run(scope,tx=>saveProductServiceWindow(tx,f.child!,{...all,dateFrom:'2100-01-01'}))
  await expect(runner.run(scope,tx=>validateProductPaymentWindow(tx,f.payment,expiry))).rejects.toThrow('已变化')
  const recovered=await new OnlinePaymentService(runner,secret,null).create({scope,paymentId:f.payment,principal:{type:'employee',employeeId:employee},operatorId:'MBOX'})
  expect(Date.parse(recovered.expiresAt)).toBe(Date.parse(expiry))
  expect(recovered.payload).toEqual({presentation:'simulation'})
  await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id=$1::text,succeeded_at=clock_timestamp() WHERE id=$1",[f.payment])
  expect((await runner.run(scope,tx=>new PaymentFulfillmentRepository(tx).activatePaidOrder(f.order.id,{paymentId:f.payment}))).activated).toBe(true)
  const composition=await admin.query('SELECT product_id,quantity FROM mbox.order_items WHERE order_id=$1 AND parent_order_item_id IS NOT NULL',[f.order.id])
  expect(composition.rows).toEqual([{product_id:f.child,quantity:1}])
  expect((await admin.query('SELECT count(*)::int AS count FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows[0].count).toBe(1)
 })

})
