import Fastify from 'fastify'
import {PromotionalLoyaltyWorker} from './promotional-loyalty-worker.js'
import {reservationReceptionApiPlugin} from './reservation-reception-api.js'
import {correctTicketGift} from './table-ticket-correction.js'
import {LoyaltyAccrualRepository} from './loyalty-accrual-repository.js'
import {proposeTicketDining,consentTicketDining,ticketDiningLines} from './table-ticket-dining.js'
import {grantFixtureStaffPermissions} from './staff-permission.test-helper.js'
import {seedActiveGuestTableAuthority} from './guest-table-authority.test-helper.js'
import {CommerceCommandService} from './commerce-command-service.js'
import {PostgresPricingAuthority} from './postgres-pricing-authority.js'
import {NormalizedCommandExecutor} from './command-executor.js'
import {staffPointsProposal,adoptAssistedPoints} from './assisted-points-proposal.js'
import {CheckoutPointsRepository} from './checkout-points-repository.js'
import {GuestSharedCartRepository} from './guest-shared-cart-repository.js'
import {checkoutLinesWithNotes} from './checkout-line-notes.js'
import {RefundRepository} from './refund-repository.js'
import {decideTicketCase,requestTicketRefund,submitTicketCashRefund} from './table-ticket-refund.js'
import {ReservationRepository} from './reservation-repository.js'
import {ticketReception,ticketFinanceDay,ticketStatement,admitTicketBatch,updateTicketContact,assignTicketTable} from './table-ticket-reception.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {describe,it,expect,beforeAll,afterAll} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction} from './transaction-runner.js'
import {buyTableTickets,memberTicketProposals,publicTableTickets} from './table-ticket-purchase.js'
import {approveEventTicketTerms,saveTicketOffer,ticketOfferCatalog} from './table-ticket-offer-repository.js'
import {creditTableTicketGifts} from './table-ticket-gifts.js'
import {PaymentRepository} from './payment-repository.js'
const url=process.env.TEST_NORMALIZED_DATABASE_URL
describe.skipIf(!url)('member table tickets on PostgreSQL',()=>{
  const scope={tenantId:randomUUID(),storeId:randomUUID()},employee=randomUUID(),customer=randomUUID(),activity=randomUUID(),area=randomUUID()
  let admin:Pool,runner:ScopedPostgresTransactionRunner
  const protection=createActivityContactProtectionKeyring(null,'test-ticket-local-secret')
  const run=<T>(callback:(tx:ScopedTransaction)=>Promise<T>)=>runner.run(scope,async tx=>{
    await tx.query('SET LOCAL ROLE mbox_runtime')
    return callback(tx)
  })
  async function placeDining(session:string,customer:string,ref:string,adopted:Awaited<ReturnType<typeof adoptAssistedPoints>>,transaction?:ScopedTransaction){
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const submit=async(tx:ScopedTransaction)=>{
      const key=randomUUID(), cart=await new GuestSharedCartRepository(tx,customer).beginCheckout(session,'GSC'+randomUUID().replaceAll('-','').toUpperCase(),{
        expectedGeneration:adopted.cart.generation,expectedVersion:adopted.cart.version,operationId:key,actorSessionRef:ref})
      return (await commerce.submitOrderInTransaction(tx,{scope,actor:{type:'guest',ref},createdByCustomerId:customer,
        businessDate:new Date().toISOString().slice(0,10),idempotencyKey:key,publicId:'O'+randomUUID().replaceAll('-',''),
        tableSessionId:session,channel:'guest_qr',settlementMode:'immediate_payment',lines:checkoutLinesWithNotes(cart.lines,[],true),
        pricingAuthorization:{sourceType:'checkout_quote',sourceId:adopted.quote.id}})).result.order
    }
    return transaction?submit(transaction):run(submit)
  }
  function collectDining(orderId:string,transaction?:ScopedTransaction){
    const collect=async(tx:ScopedTransaction)=>{
      const repo=new PaymentRepository(tx),receipt=await repo.createForOrder({orderId:orderId,publicId:randomUUID(),provider:'cash',method:'cash',evidence:{receiptReference:randomUUID(),collectedByEmployeeId:employee},providerTransactionId:randomUUID(),initialStatus:'succeeded',principal:{type:'employee',employeeId:employee}})
      await repo.syncOrderPaymentStatus(orderId)
      await new CheckoutPointsRepository(tx).consume(orderId)
      await new LoyaltyAccrualRepository(tx).recordPaidOrder({orderId:orderId,paymentId:receipt.id,occurredAt:new Date().toISOString()})
      return receipt
    }
    return transaction?collect(transaction):run(collect)
  }
  beforeAll(async()=>{
    await runNormalizedMigrations(url!)
    admin=new Pool({connectionString:url});runner=new ScopedPostgresTransactionRunner(admin)
        await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Activity service')", [scope.tenantId]);
        await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Activity service')", [scope.storeId, scope.tenantId]);
        await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'AS','Activity service')", [employee, scope.tenantId, scope.storeId]);
        await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)", [customer, scope.tenantId, scope.storeId]);
        await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,points_reward,visibility,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id) VALUES($1::uuid,$2,$3,$1::text,'member_night','服务测试','服务测试活动',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','门口',1000,0,0,'per_registration','none',15,'免费活动','CNY',0,'public','activity-safety-v1','已知安全规则',ARRAY['年满18周岁'],'activity-refund-v1','按原退款约定','现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品'],ARRAY['提前到场'],'报名成功后在小程序查看集合通知','published',clock_timestamp(),$4,$4)`, [activity, scope.tenantId, scope.storeId, employee]);

      await admin.query(`WITH membership AS(INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-SERVICE-TEST') RETURNING *) INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) SELECT tenant_id,store_id,id,customer_id FROM membership`,[scope.tenantId,scope.storeId,customer]);
      await admin.query(`INSERT INTO mbox.store_commerce_policies(tenant_id,store_id,online_payment_enabled,reason,updated_by_employee_id) VALUES($1,$2,true,'活动服务测试',$3) ON CONFLICT(tenant_id,store_id) DO UPDATE SET online_payment_enabled=true`,[scope.tenantId,scope.storeId,employee]);
      await admin.query(`UPDATE mbox.customer_experience_features SET rollout_state='pilot',reason='活动服务支付测试' WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'`,[scope.tenantId,scope.storeId]);

    await admin.query("INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)",[scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'window','窗边','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1,$2,$3,'T'||n,'靠窗'||n,6 FROM generate_series(1,3)n",[scope.tenantId,scope.storeId,area])
  })
  afterAll(async()=>{await admin?.end()})
  const offerInput={areaId:area,expectedVersion:0,name:'整桌演出票',priceMinor:50000,giftPoints:550,status:'published' as const,visibleFrom:null,visibleUntil:null}
  it('publishes an immutable offer, rejects stale edits and hides a withdrawn series',async()=>{
    await expect(run(tx=>saveTicketOffer(tx,activity,employee,offerInput))).rejects.toMatchObject({code:'TICKET_EVENT_TERMS_REQUIRED'})
    await run(tx=>approveEventTicketTerms(tx,activity,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'隔离测试场次资料',performers:'测试乐队',
      durationMinutes:90,programNote:'至少十首',serviceContact:'测试客服',refundSchedule:'开演前可在订单内申请全额退票；演出取消原路退回。',requiresNamedAttendees:false},0))
    const draft=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,giftPoints:null,status:'draft'}))
    await expect(run(tx=>saveTicketOffer(tx,activity,employee,offerInput))).rejects.toMatchObject({code:'TICKET_VERSION_CHANGED'})
    expect(await run(publicTableTickets)).toHaveLength(0)
    const first=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:draft.version}))
    expect(await run(publicTableTickets)).toMatchObject([{id:first.id,giftPoints:550,priceMinor:50000}])
    await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,status:'withdrawn',expectedVersion:first.version}))
    expect(await run(publicTableTickets)).toHaveLength(0)
    expect(await run(tx=>ticketOfferCatalog(tx,activity))).toMatchObject([{status:'withdrawn',version:3}])
  })
  it('checks verified membership and capacity, then grants once per paid ticket on retry',async()=>{
    const v=(await run(tx=>ticketOfferCatalog(tx,activity)))[0]?.version??0
    const offer=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:Number(v)}))
    const buy=(quantity:number)=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity,safetyVersion:'activity-safety-v1',refundVersion:'activity-refund-v1'},randomUUID(),randomUUID(),randomUUID(),protection))
    await expect(buy(1)).rejects.toMatchObject({code:'TICKET_MEMBERSHIP_PHONE_REQUIRED'})
    const phone=protection.protectPhone('+8613800000000')
    await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.customer_verified_contacts(tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,encrypted_value,
      encryption_key_version,contact_encryption_key_id,masked_value,verification_source,verified_by_customer_id,provider_reference_sha256,verified_at)
      VALUES($1,$2,$3,$4,'phone',$5,$6,1,$7,'138****0000','wechat_phone_authorization',$4,repeat('b',64),clock_timestamp())`,
      [scope.tenantId,scope.storeId,'CVC'+randomUUID().replaceAll('-','').toUpperCase(),customer,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId]))
    await expect(buy(4)).rejects.toMatchObject({code:'TICKET_CAPACITY_FULL'})
    const order=await buy(2)
    expect(order.amountMinor).toBe(100000)
    expect((await run(publicTableTickets))[0]?.remaining).toBe(1)
    expect((await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[order.id])).rowCount).toBe(0)
    const payment=(await admin.query<{id:string}>(`UPDATE mbox.payments SET status='succeeded',provider_transaction_id='fixture-'||id::text,succeeded_at=clock_timestamp()
      WHERE activity_registration_id=$1 RETURNING id`,[order.id])).rows[0]!.id
    await run(async tx=>{
      await tx.query('SAVEPOINT delayed_credit')
      await tx.query('UPDATE mbox.loyalty_accounts SET pending_recovery_points=1 WHERE customer_id=$1',[customer])
      await new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:payment,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:100000,succeededAt:new Date().toISOString(),status:'succeeded'})
      const delayed=await tx.query('SELECT id,point_lot_id FROM mbox.table_tickets WHERE registration_id=$1 ORDER BY ordinal',[order.id])
      expect(delayed.rows.map(k=>k.point_lot_id)).toEqual([null,null])
      await requestTicketRefund(tx,order.id,delayed.rows[0].id,customer,'赠分作业恢复前核定零现金退票')
      await decideTicketCase(tx,delayed.rows[0].id,{employee},'zero','原条款核定应退现金为零')
      await tx.query('UPDATE mbox.loyalty_accounts SET pending_recovery_points=0 WHERE customer_id=$1',[customer])
      const worker=new PromotionalLoyaltyWorker({run:(_scope,callback)=>callback(tx)})
      await worker.runTriggerBatch(scope,'ticket-gift-replay')
      const recovered=(await tx.query('SELECT point_lot_id FROM mbox.table_tickets WHERE registration_id=$1 ORDER BY ordinal',[order.id])).rows
      expect(recovered[0].point_lot_id).toBeNull()
      expect(recovered[1].point_lot_id).toEqual(expect.any(String))
      await worker.runTriggerBatch(scope,'ticket-gift-replay-retry')
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points).toBe(550)
      expect((await tx.query('SELECT count(*)::int n FROM mbox.ticket_reception_tasks WHERE registration_id=$1',[order.id])).rows[0].n).toBe(1)
      await tx.query('ROLLBACK TO SAVEPOINT delayed_credit')
    })
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:payment,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:100000,succeededAt:new Date().toISOString(),status:'succeeded'}))
    expect((await admin.query("SELECT count(point_lot_id)::int AS gifts FROM mbox.table_tickets WHERE registration_id=$1",[order.id])).rows[0]?.gifts).toBe(2)
    expect(await run(tx=>creditTableTicketGifts(tx,order.id,payment))).toBe(0)
    const lots=(await admin.query(`SELECT l.original_points,l.remaining_points,l.membership_id,t.ordinal FROM mbox.table_tickets t
      JOIN mbox.loyalty_point_lots l ON l.id=t.point_lot_id WHERE t.registration_id=$1 ORDER BY t.ordinal`,[order.id])).rows
    expect(lots).toHaveLength(2)
    expect(lots.map(l=>l.original_points)).toEqual([550,550])
    expect(lots[0]?.membership_id).toBe(lots[1]?.membership_id)
    expect((await admin.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0]?.available_points).toBe(1100)
  })
  it('assigns one physical lock and returns only the other ticket through the original payment',async()=>{
    const tickets=(await admin.query('SELECT * FROM mbox.table_tickets WHERE tenant_id=$1 ORDER BY ordinal',[scope.tenantId])).rows
    const first=tickets[0]!, second=tickets[1]!
    const table=(await admin.query('SELECT id FROM mbox.tables WHERE area_id=$1 ORDER BY code',[area])).rows[0]!.id
    await run(tx=>assignTicketTable(tx,first.id,table,employee,null))
    expect(await run(tx=>assignTicketTable(tx,first.id,table,employee,null))).toEqual({id:first.id,tableId:table})
    expect((await run(publicTableTickets))[0]?.remaining).toBe(1)
    const awaitedOrderNo=(await admin.query('SELECT public_id FROM mbox.community_activity_registrations WHERE id=$1',[first.registration_id])).rows[0].public_id
    const contact=await run(tx=>updateTicketContact(tx,(awaitedOrderNo),'called',employee))
    expect(contact.status).toBe('called')
    const receptionRows=await run(tx=>ticketReception(tx,activity))
    expect(receptionRows.orders.find(row=>row.id===first.id)).toMatchObject({contactStatus:'called',registrationStatus:'confirmed',contactVersionPublicId:expect.any(String),maskedPhone:expect.stringContaining('*')})

    expect((await admin.query('SELECT count(*)::int n FROM mbox.ticket_reception_tasks WHERE registration_id=$1',[first.registration_id])).rows[0].n).toBe(1)
    const admissionKey=randomUUID()
    await expect(run(tx=>admitTicketBatch(tx,first.id,'FFFFFFFFFFFF',2,employee,admissionKey))).rejects.toMatchObject({code:'TICKET_DOOR_INVALID'})
    await run(tx=>admitTicketBatch(tx,first.id,first.door_code,2,employee,admissionKey))
    await run(tx=>admitTicketBatch(tx,first.id,first.door_code,2,employee,admissionKey))
    await run(tx=>admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID()))
    expect((await admin.query('SELECT sum(quantity)::int n FROM mbox.ticket_admission_batches WHERE ticket_id=$1',[first.id])).rows[0].n).toBe(3)
    await grantFixtureStaffPermissions(admin,scope,[employee],['reservation.manage','reservation.view','table.open','table.view_all'])
    const reserved=(await run(tx=>tx.query(`UPDATE mbox.reservations SET status='arrived' WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
      RETURNING id,aggregate_version`,[scope.tenantId,scope.storeId,'ticket-'+first.id]))).rows[0]
    const se=(await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($1,$2,$3,$4,current_date,3,6,'open',$5,$5) RETURNING id,location_version,business_date::text`,[scope.tenantId,scope.storeId,table,randomUUID(),employee]))).rows[0]
    const reception=Fastify()
    await reception.register(reservationReceptionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveStaffContext:()=>({scope,employeeId:employee,businessDate:se.business_date}),protectContact:value=>protection.protect(value)})
    try{
      const response=await reception.inject({method:'POST',url:'/staff/reservation-receptions/'+reserved.id+'/seat',headers:{'idempotency-key':randomUUID()},
        payload:{protocol:1,reservationVersion:Number(reserved.aggregate_version),reason:'已核对原票入座桌号',sessions:[{tableSessionId:se.id,
          expectedTableId:table,expectedLocationVersion:Number(se.location_version),expectedGuestCount:3}]}})
      expect(response.statusCode,response.body).toBe(200)
    }finally{await reception.close()}
    expect((await run(publicTableTickets))[0]?.remaining).toBe(1)
    const later=await run(tx=>admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID()))
    expect(later.quantity).toBe(1)
    const open=()=>run(tx=>requestTicketRefund(tx,second.registration_id,second.id,customer,'顾客申请退本票'))
    const request=await open()
    expect((await open()).caseId).toBe(request.caseId)
    expect(request.consumedMinor).toBe(0)
    expect((await admin.query('SELECT status FROM mbox.loyalty_point_lots WHERE id=$1',[second.point_lot_id])).rows[0]?.status).toBe('ticket_hold')
    const cash=await run(tx=>submitTicketCashRefund(tx,request.caseId,employee,50000,null))
    const other=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'AUD','复核人')",[other,scope.tenantId,scope.storeId])
    const refund=await run(tx=>new RefundRepository(tx).approve(cash.refundId,other,'复核原票'))
    await run(tx=>new RefundRepository(tx).beginExecution(cash.refundId))
    const complete=()=>run(tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:refund.publicId,provider:'postar',
      providerRefundId:'local-'+cash.refundId,originalProviderTransactionId:'fixture-'+second.payment_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true}))
    // Abort the local transaction after consuming the external result, then replay the same receipt.
    await expect(run(async tx=>{
      await new RefundRepository(tx).completeProviderExecution({refundPublicId:refund.publicId,provider:'postar',
        providerRefundId:'local-'+cash.refundId,originalProviderTransactionId:'fixture-'+second.payment_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      throw new Error('injected-before-commit')
    })).rejects.toThrow('injected-before-commit')
    expect((await admin.query('SELECT status FROM mbox.table_ticket_refund_requests WHERE id=$1',[request.caseId])).rows[0].status).toBe('requested')
    expect((await complete()).applied).toBe(true)
    expect((await complete()).applied).toBe(false)
    expect((await admin.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0]?.available_points).toBe(550)
    expect((await admin.query('SELECT status,remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[first.point_lot_id])).rows[0]).toEqual({status:'available',remaining_points:550})
    expect((await admin.query('SELECT status,remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[second.point_lot_id])).rows[0]).toEqual({status:'reversed',remaining_points:0})
    const statement=await run(tx=>ticketStatement(tx,second.id))
    expect(statement.ticket.priceMinor).toBe(50000)
    expect(statement.refunds).toMatchObject([{cashMinor:'50000',cashStatus:'succeeded'}])
    expect(statement.points.map(p=>p.delta)).toEqual([550,-550])
    expect(await run(tx=>ticketFinanceDay(tx,null))).toMatchObject({amounts:{ticketCash:'100000',ticketRefund:'50000',points_grant:'1100',points_reverse:'-550'}})
    expect((await open()).status).toBe('refunded')
    expect((await run(publicTableTickets))[0]?.remaining).toBe(2)
  })
  it('uses the customer-confirmed staff basket, collects only the original dining discount, then refunds the ticket',async()=>{
    const args=[scope.tenantId,scope.storeId], session=randomUUID(),product=randomUUID(),table=randomUUID()
    const checker=randomUUID(),publisher=randomUUID()
    for(const emp of [checker,publisher])await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'测试员工')",[emp,...args])
    await grantFixtureStaffPermissions(admin,scope,[employee],['order.create','payment.collect.all_tables','refund.approve','table.view_all'])
    await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) SELECT tenant_id,store_id,role_id,'refund.approve',100000,'CNY' FROM mbox.employee_roles WHERE employee_id=$1",[employee])
    await admin.query(`INSERT INTO mbox.loyalty_policy_versions(tenant_id,store_id,policy_code,version,status,points_numerator,points_denominator_minor,growth_numerator,growth_denominator_minor,rounding_mode,points_validity_months,effective_from,drafted_by_employee_id,approved_by_employee_id,approved_at,published_by_employee_id,published_at,publication_mode,reason,points_rounding_scope,cash_redemption_enabled)
      VALUES($1,$2,'BASE',1,'published',1,1000,1,100,'floor',12,'2020-01-01',$3,$4,'2020-01-01',$5,'2020-01-02','separated','餐饮收款测试规则','order',true)`,[...args,employee,checker,publisher])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3,$1,$2,$4,'DIN','餐桌',6)",[...args,table,area])
    await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id,minimum_spend_minor,minimum_spend_mode)
      VALUES($3::uuid,$1,$2,$4,$3::text,current_date,1,6,'open',$5,$5,50000,'prepaid')`,[...args,session,table,employee]))
    expect((await admin.query('SELECT minimum_spend_minor,minimum_spend_mode FROM mbox.table_sessions WHERE id=$1',[session])).rows[0]).toEqual({minimum_spend_minor:'0',minimum_spend_mode:'order_gate'})
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id) VALUES($1,$2,$3,$4)",[...args,session,customer])
    const ref=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:customer})
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,guest_visible,status,cost_amount_minor) VALUES($3,$1,$2,'DISH','菜品','food','none',true,'active',1000)",[...args,product])
    await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,amount_minor,valid_from) VALUES($1,$2,$3,26000,'2020-01-01')",[...args,product])
    const quote=await run(tx=>staffPointsProposal(tx,employee,session,'MBX-SERVICE-TEST',[{productId:product,quantity:1}],null))
    expect(quote.maximumPoints).toBe(260)
    const proposal=await run(tx=>staffPointsProposal(tx,employee,session,'MBX-SERVICE-TEST',[{productId:product,quantity:1}],200))
    await expect(run(tx=>adoptAssistedPoints(tx,{customerId:randomUUID(),tableSessionId:session,actorRef:ref},proposal.id!))).rejects.toThrow()
    const adopted=await run(tx=>adoptAssistedPoints(tx,{customerId:customer,tableSessionId:session,actorRef:ref},proposal.id!))
    expect(adopted.quote).toMatchObject({subtotalMinor:26000,payableMinor:6000,pointsUsed:200})
    const order=await placeDining(session,customer,ref,adopted)
    const collect=()=>collectDining(order.id)
    const initialReceipt=await collect()
    expect(initialReceipt.amountMinor).toBe(6000)
    const k=(await admin.query('SELECT * FROM mbox.table_tickets WHERE tenant_id=$1 AND refunded_at IS NULL',[scope.tenantId])).rows[0]
    await run(async tx=>{
      await tx.query('SAVEPOINT partial_dish_first')
      const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[order.id])).rows[0]
      const repo=new RefundRepository(tx)
      const food=await repo.request({purpose:'return_goods',paymentId:initialReceipt.id,publicId:'DF'+randomUUID(),reason:'原菜款部分退回',
        requestedByEmployeeId:employee,allocations:[{orderItemId:item.id,amountMinor:3000}]})
      await repo.approve(food.id,checker,'核对原菜品及已收款');await repo.beginExecution(food.id)
      await repo.completeManualExecution({refundId:food.id,succeeded:true,receiptReference:'DISH-'+food.id})
      await new CheckoutPointsRepository(tx).restoreRefund(order.id,food.id)
      const f=await requestTicketRefund(tx,k.registration_id,k.id,customer,'先部分退菜后退本票')
      expect(f.consumedMinor).toBe(10000)
      expect(await ticketDiningLines(tx,f.caseId)).toMatchObject([{usedMinor:10000,review:false}])
      expect(await proposeTicketDining(tx,f.caseId,employee,'核对原菜款按份分摊')).toMatchObject({amountMinor:10000})
      await tx.query('ROLLBACK TO SAVEPOINT partial_dish_first')
    })
    const f=await run(tx=>requestTicketRefund(tx,k.registration_id,k.id,customer,'原票个人退票'))
    expect(f.consumedMinor).toBe(20000)
    expect(await run(tx=>ticketDiningLines(tx,f.caseId))).toMatchObject([{usedMinor:20000,priceMinor:26000}])
    await expect(run(tx=>submitTicketCashRefund(tx,f.caseId,employee,50000,null))).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
    await run(tx=>proposeTicketDining(tx,f.caseId,employee,'根据原票明示条款核算'))
    const bill=(await admin.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
    await expect(collect()).rejects.toThrow()
    await run(tx=>consentTicketDining(tx,bill,customer))
    const supplement=await collect()
    expect(supplement.amountMinor).toBe(20000)
    expect((await admin.query('SELECT eligible_amount_minor,awarded_points,awarded_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[order.id])).rows[0]).toEqual({eligible_amount_minor:'26000',awarded_points:26,awarded_growth:260})
    expect((await run(tx=>new LoyaltyAccrualRepository(tx).recordPaidOrder({orderId:order.id,paymentId:supplement.id,occurredAt:new Date().toISOString()}))).applied).toBe(false)
    await expect(collect()).rejects.toThrow()
    await run(async tx=>{
      await tx.query('SAVEPOINT zero_cash')
      await decideTicketCase(tx,k.id,{employee},'zero','依原条款核定应退现金零元')
      expect((await tx.query('SELECT status,refund_id,closed_without_receipt FROM mbox.table_ticket_refund_requests WHERE id=$1',[f.caseId])).rows[0]).toEqual({status:'refunded',refund_id:null,closed_without_receipt:true})
      expect((await tx.query('SELECT return_refund_id FROM mbox.ticket_dining_collections WHERE id=$1',[bill])).rows[0].return_refund_id).toBeNull()
      expect((await tx.query('SELECT status,remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[k.point_lot_id])).rows[0]).toEqual({status:'reversed',remaining_points:0})
      await tx.query('ROLLBACK TO SAVEPOINT zero_cash')
    })
    const ticketRefund=await run(tx=>submitTicketCashRefund(tx,f.caseId,employee,50000,null))
    await run(tx=>new RefundRepository(tx).reject(ticketRefund.refundId,checker,'核对原票后保留原票'))
    expect((await admin.query('SELECT status FROM mbox.loyalty_point_lots WHERE id=$1',[k.point_lot_id])).rows[0].status).toBe('ticket_hold')
    await run(tx=>decideTicketCase(tx,k.id,{employee},'rejected','原票保留，退回原补款'))
    const reversal=(await admin.query('SELECT return_refund_id FROM mbox.ticket_dining_collections WHERE id=$1',[bill])).rows[0].return_refund_id
    await run(tx=>new RefundRepository(tx).approve(reversal,checker,'核对原餐饮补款'))
    await run(tx=>new RefundRepository(tx).beginExecution(reversal))
    await run(async tx=>{
      await new RefundRepository(tx).completeManualExecution({refundId:reversal,succeeded:true,receiptReference:'LOCAL-CASH-'+reversal})
      await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:order.id,paymentId:supplement.id,refundId:reversal,occurredAt:new Date().toISOString()})
    })
    expect((await admin.query('SELECT status FROM mbox.table_ticket_refund_requests WHERE id=$1',[f.caseId])).rows[0].status).toBe('rejected')
    expect((await admin.query('SELECT status,remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[k.point_lot_id])).rows[0]).toEqual({status:'available',remaining_points:350})
    expect((await admin.query('SELECT reversed_points,reversed_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[order.id])).rows[0]).toEqual({reversed_points:20,reversed_growth:200})
    expect((await admin.query('SELECT count(*)::int n FROM mbox.order_items WHERE order_id=$1',[order.id])).rows[0].n).toBe(1)
  })
  it('arbitrates concurrent purchases for the last desks',async()=>{
    const offer=(await run(publicTableTickets))[0]!
    const last=offer.remaining
    expect(last).toBeGreaterThan(0)
    const buy=()=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:last,safetyVersion:offer.safetyVersion,refundVersion:offer.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
    const result=await Promise.allSettled([buy(),buy()])
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(result.filter(r=>r.status==='rejected')).toHaveLength(1)
    const id=result.find(r=>r.status==='fulfilled')!.value.id
    await run(tx=>tx.query("UPDATE mbox.community_activity_registrations SET status='cancelled',cancelled_at=clock_timestamp(),payment_status='expired',amount_due_minor=0,seat_hold_expires_at=NULL,payment_due_at=NULL WHERE id=$1",[id]))
  })
  it('requires a second authorized reviewer and replaces only a proven wrong unused lot',async()=>{
    const offer=(await run(publicTableTickets))[0]!
    const k=await run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:offer.safetyVersion,refundVersion:offer.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
    const args=[scope.tenantId,scope.storeId],wrong=randomUUID(),reviewer=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3::uuid,$1,$2,$3::text,'冲正审批')",[...args,reviewer])
    await grantFixtureStaffPermissions(admin,scope,[employee,reviewer],['loyalty.adjust.manual','loyalty.accrual.approve','community.activity.manage'])
    await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) SELECT tenant_id,store_id,role_id,'loyalty.adjust.manual',100000,'CNY' FROM mbox.employee_roles WHERE employee_id=$1",[reviewer])
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($3::uuid,$1,$2,$3::text)",[...args,wrong])
    const member=(await admin.query("INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-WRONG') RETURNING id",[...args,wrong])).rows[0].id
    await admin.query("INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)",[...args,member,wrong])
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='local-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[k.id])).rows[0].id
    await run(tx=>tx.query("UPDATE mbox.community_activity_registrations SET status='confirmed',payment_status='paid',paid_amount_minor=fee_amount_minor,amount_due_minor=0,payment_due_at=NULL,seat_hold_expires_at=NULL WHERE id=$1",[k.id]))
    const ticket=(await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[k.id])).rows[0].id
    await run(async tx=>{
      await tx.query('SAVEPOINT award_not_yet_posted')
      const f=await requestTicketRefund(tx,k.id,ticket,customer,'尚未发分时退票')
      expect(await creditTableTicketGifts(tx,k.id,pay)).toBe(0)
      expect(await submitTicketCashRefund(tx,f.caseId,employee,50000,null)).toMatchObject({caseId:f.caseId})
      await tx.query('ROLLBACK TO SAVEPOINT award_not_yet_posted')
    })
    // Compare both quantity errors against the same promise and original buyer.
    for(const granted of [600,500]){
      await run(async tx=>{
        await tx.query('SAVEPOINT wrong_quantity')
        const original=(await tx.query<{membership_id:string;available_points:number}>(`SELECT a.membership_id,a.available_points FROM mbox.loyalty_accounts a
          JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,membership_id) WHERE p.registration_id=$1 FOR UPDATE OF a`,[k.id])).rows[0]!
        const lot=(await tx.query<{id:string}>(`WITH entry AS (INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key)
          VALUES($1,$2,$3,$4,'earn',$6,$7,'activity',$5,'原始数量差错','quantity:'||$5) RETURNING id)
          INSERT INTO mbox.loyalty_point_lots(tenant_id,store_id,membership_id,customer_id,source_ledger_entry_id,source_type,source_id,original_points,remaining_points,available_at,expires_at)
          SELECT $1,$2,$3,$4,id,'table_ticket',$5,$6,$6,clock_timestamp(),mbox.table_ticket_expiry(clock_timestamp()) FROM entry RETURNING id`,[...args,original.membership_id,customer,ticket,granted,original.available_points+granted])).rows[0]!
        await tx.query('UPDATE mbox.loyalty_accounts SET available_points=available_points+$2 WHERE membership_id=$1',[original.membership_id,granted])
        await tx.query('UPDATE mbox.customer_memberships SET points_balance=$2 WHERE id=$1',[original.membership_id,original.available_points+granted])
        await tx.query('UPDATE mbox.table_tickets SET point_lot_id=$2 WHERE id=$1',[ticket,lot.id])
        const fix=await correctTicketGift(tx,ticket,employee,'原票应赠550分','request',null)
        await correctTicketGift(tx,ticket,reviewer,'复核购票时赠分','approve',fix.id)
        expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[original.membership_id])).rows[0].available_points).toBe(original.available_points+550)
        expect((await tx.query('SELECT l.remaining_points FROM mbox.loyalty_point_lots l JOIN mbox.table_tickets k ON k.point_lot_id=l.id WHERE k.id=$1',[ticket])).rows[0].remaining_points).toBe(550)
        await expect(correctTicketGift(tx,ticket,employee,'重复申请','request',null)).rejects.toMatchObject({code:'TICKET_CORRECTION_INELIGIBLE'})
        await tx.query('ROLLBACK TO SAVEPOINT wrong_quantity')
      })
    }
    // Simulate a historical issuer writing a genuine ledger and lot to an incorrect member.
    await run(async tx=>{
      const lot=(await tx.query<{id:string}>(`WITH entry AS (INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,source_type,source_id,reason,idempotency_key)
        VALUES($1,$2,$3,$4,'earn',550,550,'activity',$5,'测试错户原始发放','table-ticket:'||$5) RETURNING id)
        INSERT INTO mbox.loyalty_point_lots(tenant_id,store_id,membership_id,customer_id,source_ledger_entry_id,source_type,source_id,original_points,remaining_points,available_at,expires_at)
        SELECT $1,$2,$3,$4,id,'table_ticket',$5,550,550,clock_timestamp(),mbox.table_ticket_expiry(clock_timestamp()) FROM entry RETURNING id`,[...args,member,wrong,ticket])).rows[0]!
      await tx.query("UPDATE mbox.loyalty_accounts SET available_points=550 WHERE membership_id=$1",[member])
      await tx.query("UPDATE mbox.customer_memberships SET points_balance=550 WHERE id=$1",[member])
      await tx.query('UPDATE mbox.table_tickets SET point_lot_id=$2 WHERE id=$1',[ticket,lot.id])
    })
    const physical=(await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) VALUES ($1,$2,$3,'CORRECTION','差错核对桌',4) RETURNING id",[...args,area])).rows[0].id
    const tableSession=(await run(tx=>tx.query("INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id) VALUES($1,$2,$3,$4,current_date,1,4,'open',$5,$5) RETURNING id",[...args,physical,randomUUID(),employee]))).rows[0].id
    const menuItem=(await admin.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id) VALUES($1,$2,$3,$4)",[...args,tableSession,wrong])
    const wrongMemberRef=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:tableSession,customerId:wrong})
    await run(async tx=>{
      await tx.query('SAVEPOINT wrong_member_dined')
      const prior=(await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points
      const preview=await staffPointsProposal(tx,employee,tableSession,'MBX-WRONG',[{productId:menuItem,quantity:1}],200)
      const adopted=await adoptAssistedPoints(tx,{customerId:wrong,tableSessionId:tableSession,actorRef:wrongMemberRef},preview.id!)
      const meal=await placeDining(tableSession,wrong,wrongMemberRef,adopted,tx)
      expect((await collectDining(meal.id,tx)).amountMinor).toBe(6000)
      await expect(correctTicketGift(tx,ticket,employee,'未核清责任','request',null)).rejects.toMatchObject({code:'TICKET_USED_CORRECTION_REVIEW'})
      const decision=await correctTicketGift(tx,ticket,employee,'核对原单，门店承担错户本人已消费的200元','request',null,true)
      await correctTicketGift(tx,ticket,reviewer,'复核原消费及门店承担记录','approve',decision.id)
      expect((await tx.query('SELECT consumed_points,consumption_resolution FROM mbox.table_ticket_corrections WHERE id=$1',[decision.id])).rows[0]).toEqual({consumed_points:200,consumption_resolution:'merchant_assumes'})
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points).toBe(prior+550)
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[wrong])).rows[0].available_points).toBe(6)
      expect((await requestTicketRefund(tx,k.id,ticket,customer,'实际消费由门店承担后退原购票人的票')).consumedMinor).toBe(0)
      await tx.query('ROLLBACK TO SAVEPOINT wrong_member_dined')
    })
    const fix=await run(tx=>correctTicketGift(tx,ticket,employee,'凭原票核对确认为错户','request',null))
    await expect(run(tx=>correctTicketGift(tx,ticket,employee,'同人审批应拒绝','approve',fix.id))).rejects.toMatchObject({code:'TICKET_CORRECTION_REVIEWER'})
    const coordinated=await run(tx=>requestTicketRefund(tx,k.id,ticket,customer,'错户复核期间申请退票'))
    await expect(run(tx=>submitTicketCashRefund(tx,coordinated.caseId,employee,50000,null))).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
    // A merchant-caused refund can settle without charging the buyer for someone else's dining.
    // Roll back this alternative, then exercise the independent correction after the buyer withdraws.
    await run(async tx=>{
      await tx.query('SAVEPOINT merchant_refund')
      const cash=await submitTicketCashRefund(tx,coordinated.caseId,employee,50000,'演出取消')
      const repo=new RefundRepository(tx),refund=await repo.approve(cash.refundId,reviewer,'退票款与错户分开核实')
      await repo.beginExecution(cash.refundId)
      await repo.completeProviderExecution({refundPublicId:refund.publicId,provider:'postar',providerRefundId:'m-'+cash.refundId,
        originalProviderTransactionId:'local-'+pay,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      expect((await tx.query('SELECT status FROM mbox.table_ticket_refund_requests WHERE id=$1',[coordinated.caseId])).rows[0].status).toBe('refunded')
      expect((await tx.query('SELECT status FROM mbox.loyalty_point_lots WHERE membership_id=$1',[member])).rows[0].status).toBe('ticket_hold')
      await correctTicketGift(tx,ticket,reviewer,'票款已退，收回误发权益','approve',fix.id)
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])).rows[0].available_points).toBe(0)
      await tx.query('ROLLBACK TO SAVEPOINT merchant_refund')
    })
    await run(tx=>decideTicketCase(tx,ticket,{customer},'cancelled','本人撤回，保留原票'))

    await run(tx=>correctTicketGift(tx,ticket,reviewer,'核对原单后更正归属','approve',fix.id))
    expect((await admin.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])).rows[0].available_points).toBe(0)
    expect((await admin.query('SELECT l.customer_id,l.original_points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE k.id=$1',[ticket])).rows[0]).toEqual({customer_id:customer,original_points:550})
    expect(await run(tx=>creditTableTicketGifts(tx,k.id,pay))).toBe(0)
    await expect(run(tx=>correctTicketGift(tx,ticket,employee,'申请转给同行人','request',null))).rejects.toMatchObject({code:'TICKET_CORRECTION_INELIGIBLE'})
  })
  it('converts the only pre-booked table in its area without a second reservation or phantom sale',async()=>{
    const extraArea=randomUUID(),table=randomUUID(),args=[scope.tenantId,scope.storeId]
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'SOFA','沙发','indoor')",[...args,extraArea])
    await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3,$1,$2,$4,'SOFA1','沙发1',6)",[...args,table,extraArea])
    const offer=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,areaId:extraArea}))
    const available=(await run(publicTableTickets)).find(o=>o.id===offer.id)!
    const reservation=await run(tx=>new ReservationRepository(tx).create({publicId:'existing-'+randomUUID(),source:'integration',customerId:customer,
      customerName:'现场预约',contactToken:'local',guestCount:2,arrivalAt:available.startsAt,expectedEndAt:available.endsAt,
      ownerEmployeeId:employee,tableIds:[table],initialStatus:'confirmed',reservationSnapshot:{},reservationPolicyVersion:1,arrivalGraceEndsAt:available.endsAt}))
    const current=() =>run(publicTableTickets).then(offers=>offers.find(o=>o.id===offer.id)!.remaining)
    expect(await current()).toBe(0)
    const order=await run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:available.safetyVersion,refundVersion:available.refundVersion,
      reservationLockId:reservation.tableLocks[0]!.id},randomUUID(),randomUUID(),randomUUID(),protection))
    expect(await current()).toBe(0)
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='LOCAL-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[order.id])).rows[0].id
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:50000,succeededAt:new Date().toISOString(),status:'succeeded'}))
    const ticket=(await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[order.id])).rows[0].id
    await run(tx=>assignTicketTable(tx,ticket,table,employee,reservation.publicId))
    expect((await admin.query('SELECT reservation_lock_id FROM mbox.table_tickets WHERE id=$1',[ticket])).rows[0].reservation_lock_id).toBe(reservation.tableLocks[0]!.id)
    await run(tx=>requestTicketRefund(tx,order.id,ticket,customer,'按原票条款终止'))
    expect((await run(tx=>decideTicketCase(tx,ticket,{employee},'zero','原场规定该时段无应退现金'))).status).toBe('refunded')
    expect((await admin.query('SELECT status FROM mbox.reservation_table_locks WHERE id=$1',[reservation.tableLocks[0]!.id])).rows[0].status).toBe('confirmed')
    expect(await current()).toBe(0)
  })
  it('binds a staff-selected offer to the verified phone and refunds a late payment without issuing tickets',async()=>{
    const offer=(await run(publicTableTickets)).find(o=>o.remaining>0)!
    const args=[scope.tenantId,scope.storeId]
    const phone=protection.protectPhone('+8613800000000')
    const proposal=(await run(tx=>tx.query<{id:string}>(`INSERT INTO mbox.table_ticket_assistance
      (tenant_id,store_id,employee_id,offer_id,quantity,phone_hashes) VALUES ($1,$2,$3,$4,1,ARRAY[$5::text]) RETURNING id`,[...args,employee,offer.id,phone.contactHash]))).rows[0]!
    expect(await run(tx=>memberTicketProposals(tx,customer))).toEqual(expect.arrayContaining([expect.objectContaining({id:proposal.id})]))
    expect(await run(tx=>memberTicketProposals(tx,randomUUID()))).toHaveLength(0)
    const buy=(quantity:number)=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity,proposalId:proposal.id,safetyVersion:offer.safetyVersion,refundVersion:offer.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
    await expect(buy(2)).rejects.toMatchObject({code:'TICKET_ASSISTANCE_CHANGED'})
    const order=await buy(1)
    await expect(buy(1)).rejects.toMatchObject({code:'TICKET_ASSISTANCE_CHANGED'})
    await admin.query("UPDATE mbox.community_activity_registrations SET payment_due_at=clock_timestamp()-interval '1 second' WHERE id=$1",[order.id])
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='late-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id,succeeded_at",[order.id])).rows[0]
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:offer.priceMinor,succeededAt:pay.succeeded_at.toISOString(),status:'succeeded'}))
    expect((await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[order.id])).rowCount).toBe(0)
    const apply=(who:string)=>run(tx=>new RefundRepository(tx).requestActivity({paymentId:pay.id,publicId:'late-'+randomUUID(),reason:'已收款未出票',requestedByCustomerId:who}))
    await expect(apply(randomUUID())).rejects.toMatchObject({code:'ACTIVITY_REFUND_NOT_ALLOWED'})
    const ref=await apply(customer)
    expect(ref.amountMinor).toBe(offer.priceMinor)
    await expect(apply(customer)).rejects.toMatchObject({code:'ACTIVITY_REFUND_PENDING'})
    const approver=(await admin.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
    await run(tx=>new RefundRepository(tx).approve(ref.id,approver,'核对迟到收款'))
    await run(tx=>new RefundRepository(tx).beginExecution(ref.id))
    expect((await run(tx=>new RefundRepository(tx).completeProviderExecution({refundPublicId:ref.publicId,provider:'postar',
      providerRefundId:'returned-'+ref.id,originalProviderTransactionId:'late-'+pay.id,reportedAmountMinor:offer.priceMinor,reportedCurrency:'CNY',succeeded:true}))).applied).toBe(true)
    expect((await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[order.id])).rowCount).toBe(0)
  })
  it('settles either ticket from the same two-table payment after the first funded a meal',async()=>{
    const args=[scope.tenantId,scope.storeId],buyer=randomUUID(),member=randomUUID(),extra=randomUUID()
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($3::uuid,$1,$2,$3::text)",[...args,buyer])
    await admin.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES($3,$1,$2,$4,'MBX-TWO-TABLES')",[...args,member,buyer])
    await admin.query("INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)",[...args,member,buyer])
    const phone=protection.protectPhone('+8613800000001')
    await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.customer_verified_contacts(tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,encrypted_value,encryption_key_version,
      contact_encryption_key_id,masked_value,verification_source,verified_by_customer_id,provider_reference_sha256,verified_at)
      VALUES($1,$2,$3,$4,'phone',$5,$6,1,$7,'138****0001','wechat_phone_authorization',$4,repeat('c',64),clock_timestamp())`,
      [...args,'CVC'+randomUUID().replaceAll('-','').toUpperCase(),buyer,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId]))
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'BOX','卡座','indoor')",[...args,extra])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1,$2,$3,'BOX'||n,'卡座'||n,6 FROM generate_series(1,3) n",[...args,extra])
    const offer=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,areaId:extra}))
    const sale=await run(tx=>buyTableTickets(tx,buyer,{offerId:offer.id,quantity:2,safetyVersion:'activity-safety-v1',refundVersion:'activity-refund-v1'},randomUUID(),randomUUID(),randomUUID(),protection))
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='twotix-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id,succeeded_at",[sale.id])).rows[0]
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:sale.id,payableKind:'activity_registration',amountMinor:100000,succeededAt:pay.succeeded_at.toISOString(),status:'succeeded'}))
    const tickets=(await admin.query('SELECT id,point_lot_id FROM mbox.table_tickets WHERE registration_id=$1 ORDER BY ordinal',[sale.id])).rows
    const physical=(await admin.query("SELECT id FROM mbox.tables WHERE tenant_id=$1 AND code='BOX1'",[scope.tenantId])).rows[0].id
    const session=(await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($1,$2,$3,$4,current_date,1,6,'open',$5,$5) RETURNING id`,[...args,physical,randomUUID(),employee]))).rows[0].id
    const product=(await admin.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id) VALUES($1,$2,$3,$4)",[...args,session,buyer])
    const ref=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:buyer})
    await run(async tx=>{
      await tx.query('SAVEPOINT two_lots_one_dish')
      const preview=await staffPointsProposal(tx,employee,session,'MBX-TWO-TABLES',[{productId:product,quantity:1,note:'少冰'},{productId:product,quantity:2,note:'常温'}],700)
      const confirmed=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},preview.id!)
      expect(Object.values(confirmed.notes).sort()).toEqual(['少冰','常温','常温'].sort())
      const meal=await placeDining(session,buyer,ref,confirmed,tx)
      expect((await collectDining(meal.id,tx)).amountMinor).toBe(8000)
      const links=(await tx.query(`SELECT s.portion_id,count(DISTINCT lot_id)::int sources FROM mbox.checkout_point_portion_sources s
        WHERE s.quote_id=$1 GROUP BY s.portion_id`,[confirmed.quote.id])).rows
      expect(links).toHaveLength(3)
      expect(links.every(line=>line.sources===2)).toBe(true)
      const f=await requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'退共用同份菜的第二票')
      expect(f.consumedMinor).toBe(15000)
      expect((await ticketDiningLines(tx,f.caseId)).reduce((n,l)=>n+l.usedMinor,0)).toBe(15000)
      await proposeTicketDining(tx,f.caseId,employee,'核对三份菜中第二票150元')
      const bill=(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
      await consentTicketDining(tx,bill,buyer)
      expect((await collectDining(meal.id,tx)).amountMinor).toBe(15000)
      const first=await requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'再核对已用完的第一票')
      expect(first.consumedMinor).toBe(55000)
      await expect(proposeTicketDining(tx,first.caseId,employee,'已超过票款须人工核定')).rejects.toMatchObject({code:'TICKET_DINING_REVIEW'})
      await tx.query('ROLLBACK TO SAVEPOINT two_lots_one_dish')
    })
    const proposal=await run(tx=>staffPointsProposal(tx,employee,session,'MBX-TWO-TABLES',[{productId:product,quantity:1}],200))
    const adopted=await run(tx=>adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},proposal.id!))
    const dish=await placeDining(session,buyer,ref,adopted)
    const originalDishReceipt=await collectDining(dish.id)
    expect(originalDishReceipt.amountMinor).toBe(6000)
    const remaining=async(tx:ScopedTransaction)=>(await tx.query('SELECT l.remaining_points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE k.registration_id=$1 ORDER BY ordinal',[sale.id])).rows.map(l=>l.remaining_points)
    expect(await run(remaining)).toEqual([350,550])
    const reviewer=(await admin.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
    await run(async tx=>{
      await tx.query('SAVEPOINT return_unused')
      const f=await requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'退未用分的一桌')
      expect(f.consumedMinor).toBe(0)
      const r=await submitTicketCashRefund(tx,f.caseId,employee,50000,null)
      const repo=new RefundRepository(tx),approved=await repo.approve(r.refundId,reviewer,'复核第二桌')
      await repo.beginExecution(r.refundId)
      await repo.completeProviderExecution({refundPublicId:approved.publicId,provider:'postar',providerRefundId:'unused-'+r.refundId,originalProviderTransactionId:'twotix-'+pay.id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      expect(await remaining(tx)).toEqual([350,0])
      await tx.query('ROLLBACK TO SAVEPOINT return_unused')
    })
    const f=await run(tx=>requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'改退已用分的一桌'))
    expect(f.consumedMinor).toBe(20000)
    await run(tx=>proposeTicketDining(tx,f.caseId,employee,'按原菜价补差额'))
    const bill=(await admin.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
    await run(tx=>consentTicketDining(tx,bill,buyer))
    const extraDishReceipt=await collectDining(dish.id)
    expect(extraDishReceipt.amountMinor).toBe(20000)
    const r=await run(tx=>submitTicketCashRefund(tx,f.caseId,employee,50000,null))
    await run(async tx=>{
      const repo=new RefundRepository(tx),approved=await repo.approve(r.refundId,reviewer,'复核第一桌')
      await repo.beginExecution(r.refundId)
      await repo.completeProviderExecution({refundPublicId:approved.publicId,provider:'postar',providerRefundId:'used-'+r.refundId,originalProviderTransactionId:'twotix-'+pay.id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      expect(await remaining(tx)).toEqual([0,550])
      const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[dish.id])).rows[0].id
      for(const [payment,amount] of [[extraDishReceipt,8000],[extraDishReceipt,12000],[originalDishReceipt,6000]] as const){
        const food=await repo.request({purpose:'return_goods',paymentId:payment.id,publicId:'AF'+randomUUID(),reason:'退票之后退原菜品',
          requestedByEmployeeId:employee,allocations:[{orderItemId:item,amountMinor:amount}]})
        await repo.approve(food.id,reviewer,'核对原菜及两笔实付')
        await repo.beginExecution(food.id)
        await repo.completeManualExecution({refundId:food.id,succeeded:true,receiptReference:'AFTER-'+food.id})
        await new CheckoutPointsRepository(tx).restoreRefund(dish.id,food.id)
        await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:dish.id,paymentId:payment.id,refundId:food.id,occurredAt:new Date().toISOString()})
      }
      expect(await remaining(tx)).toEqual([0,550])
      const summary=await ticketStatement(tx,tickets[0].id)
      expect(summary.dining[0].returns).toMatchObject([{status:'succeeded',amountMinor:8000},{status:'succeeded',amountMinor:12000}])
      expect((await tx.query('SELECT reversed_points,reversed_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[dish.id])).rows[0]).toEqual({reversed_points:26,reversed_growth:260})
      expect((await tx.query("SELECT sum(amount_minor)::int net FROM mbox.order_refund_facts WHERE order_id=$1 AND status='succeeded'",[dish.id])).rows[0].net).toBe(26000)
    })
  })
  it('sells five desks and then the sixth to one member with separate lots and independent area limits',async()=>{
    const other=randomUUID(),args=[scope.tenantId,scope.storeId]
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'SIX','中间','indoor')",[...args,other])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1,$2,$3,'SIX'||n,'中间'||n,2 FROM generate_series(1,6)n",[...args,other])
    await run(async tx=>{
      await tx.query('SAVEPOINT multi_desk')
      const offer=await saveTicketOffer(tx,activity,employee,{...offerInput,areaId:other})
      const list=()=>publicTableTickets(tx)
      const before=await list(),available=before.find(o=>o.id===offer.id)!
      const buy=(quantity:number)=>buyTableTickets(tx,customer,{offerId:offer.id,quantity,safetyVersion:available.safetyVersion,refundVersion:available.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection)
      for(const n of [5,1]){
        const sale=await buy(n)
        const pay=(await tx.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='six-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[sale.id])).rows[0]
        await new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:sale.id,payableKind:'activity_registration',amountMinor:n*50000,succeededAt:new Date().toISOString(),status:'succeeded'})
        expect((await tx.query('SELECT count(DISTINCT k.point_lot_id)::int n,sum(l.original_points)::int points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE registration_id=$1 AND l.customer_id=$2',[sale.id,customer])).rows[0]).toEqual({n,points:n*550})
        if(n===5)await expect(buy(2)).rejects.toMatchObject({code:'TICKET_CAPACITY_FULL'})
      }
      expect((await list()).find(o=>o.id===offer.id)?.remaining).toBe(0)
      expect((await list()).filter(o=>o.id!==offer.id).map(o=>o.remaining)).toEqual(before.filter(o=>o.id!==offer.id).map(o=>o.remaining))
      await tx.query('ROLLBACK TO SAVEPOINT multi_desk')
    })
  })
  it('honors nested category and individual product display times independently of dining supply windows',async()=>{
    await run(async tx=>{
      const args=[scope.tenantId,scope.storeId]
      const product=(await tx.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND code='DISH'",args)).rows[0].id
      await tx.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,display_name,sort_order,guest_visible) VALUES($1,$2,'TICKET-MENU','场次菜单',1,true)",args)
      await tx.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,parent_code,display_name,sort_order,guest_visible) VALUES($1,$2,'TICKET-SUB','TICKET-MENU','晚餐',1,true)",args)
      await tx.query("UPDATE mbox.products SET category_code='TICKET-SUB',visible_from='2026-12-01T16:00Z',visible_until='2026-12-01T18:00Z' WHERE id=$1",[product])
      const visible=async(time:string)=>(await tx.query('SELECT mbox.product_visible_now($1,$2,$3,NULL,$4) visible',[...args,product,time])).rows[0].visible
      expect(await visible('2026-12-01T15:59Z')).toBe(false)
      expect(await visible('2026-12-01T16:00Z')).toBe(true)
      expect(await visible('2026-12-01T18:00Z')).toBe(false)
      await tx.query("UPDATE mbox.menu_categories SET visible_until='2026-12-01T17:00Z' WHERE tenant_id=$1 AND store_id=$2 AND code='TICKET-MENU'",args)
      expect(await visible('2026-12-01T17:00Z')).toBe(false)
    })
  })
  it('keeps issued promises while changing price and points, and stops all new table sales for a named event',async()=>{
    const previous=(await run(tx=>ticketOfferCatalog(tx,activity))).find(o=>o.areaId===area)!
    await run(async tx=>{
      await tx.query('SAVEPOINT preview_window')
      const preview=await saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:Number(previous.version),saleFrom:'2070-01-01T00:00:00Z'})
      const displayed=(await publicTableTickets(tx)).find(o=>o.id===preview.id)!
      expect(displayed.saleState).toBe('upcoming')
      await expect(buyTableTickets(tx,customer,{offerId:preview.id,quantity:1,safetyVersion:displayed.safetyVersion,refundVersion:displayed.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection)).rejects.toMatchObject({code:'TICKET_SALES_WINDOW'})
      await tx.query('ROLLBACK TO SAVEPOINT preview_window')
      await tx.query('SAVEPOINT hide_previously_live')
      await saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:Number(previous.version),visibleFrom:'2070-01-01T00:00:00Z'})
      expect((await publicTableTickets(tx)).some(o=>o.areaId===area)).toBe(false)
      await expect(buyTableTickets(tx,customer,{offerId:previous.id,quantity:1,safetyVersion:'old',refundVersion:'old'},randomUUID(),randomUUID(),randomUUID(),protection)).rejects.toMatchObject({code:'TICKET_OFFER_CHANGED'})
      await tx.query('ROLLBACK TO SAVEPOINT hide_previously_live')
    })
    const changed=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:Number(previous.version),name:'普通整桌票',priceMinor:45000,giftPoints:0}))
    expect(await run(publicTableTickets)).toEqual(expect.arrayContaining([expect.objectContaining({id:changed.id,giftPoints:0,priceMinor:45000})]))
    const original=(await admin.query("SELECT k.id FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id) WHERE k.tenant_id=$1 AND p.offer_id=$2 LIMIT 1",[scope.tenantId,previous.id])).rows[0].id
    expect((await run(tx=>ticketStatement(tx,original))).ticket).toMatchObject({priceMinor:50000,giftPoints:550})
    await run(tx=>approveEventTicketTerms(tx,activity,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'模拟实名场',performers:'测试乐队',
      durationMinutes:90,programNote:'至少十首',serviceContact:'测试客服',refundSchedule:'按已公示条款受理',requiresNamedAttendees:true},1))
    expect(await run(publicTableTickets)).toHaveLength(0)
    await expect(run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:changed.version}))).rejects.toMatchObject({code:'TICKET_EVENT_TERMS_REQUIRED'})
  })
  it('keeps equal-price shows independent on the same Beijing day, including a show ending after midnight',async()=>{
    await run(async tx=>{
      await tx.query('SAVEPOINT two_shows')
      const copied=[]
      for(const [hour,points] of [[18,100],[23,550]] as const){
        const id=randomUUID()
        await tx.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||
          jsonb_build_object('id',$4::uuid,'public_id',$4::text,'starts_at',schedule.begin,'ends_at',schedule.begin+interval '2 hours'))).*
          FROM mbox.community_activities a CROSS JOIN LATERAL(SELECT (((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date+7)+make_interval(hours=>$5)) AT TIME ZONE 'Asia/Shanghai' AS begin) schedule
          WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.id=$3`,[scope.tenantId,scope.storeId,activity,id,hour])
        await approveEventTicketTerms(tx,id,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'测试场次编号',performers:'测试乐队',
          durationMinutes:90,programNote:'十首',serviceContact:'门店客服',refundSchedule:'开演前可在原单申请全额退票',requiresNamedAttendees:false},0)
        const offer=await saveTicketOffer(tx,id,employee,{...offerInput,name:hour+'点场',giftPoints:points})
        const shown=(await publicTableTickets(tx)).find(o=>o.id===offer.id)!
        const order=await buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:shown.safetyVersion,refundVersion:shown.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection)
        const pay=(await tx.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='show-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[order.id])).rows[0]
        await new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:50000,succeededAt:new Date().toISOString(),status:'succeeded'})
        const actual=(await tx.query('SELECT original_points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE k.registration_id=$1',[order.id])).rows[0].original_points
        copied.push({hour:new Date(Date.parse(shown.startsAt)+8*3600000).getUTCHours(),end:new Date(Date.parse(shown.endsAt)+8*3600000).getUTCHours(),points:actual,amount:order.amountMinor})
      }
      expect(copied).toEqual([{hour:18,end:20,points:100,amount:50000},{hour:23,end:1,points:550,amount:50000}])
      await tx.query('ROLLBACK TO SAVEPOINT two_shows')
    })
  })
  it('expires only after the Shanghai anniversary including leap day',async()=>{
    const {rows}=await admin.query(`SELECT mbox.table_ticket_expiry('2024-02-28 16:01Z')='2025-02-28 16:00Z' leap,
      mbox.table_ticket_expiry('2026-11-22 16:01Z')='2027-11-23 16:00Z' normal`)
    expect(rows[0]).toEqual({leap:true,normal:true})
  })
})
