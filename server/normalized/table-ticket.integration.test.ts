import {planTicketCashRefund,processTicketRefundReviews} from './table-ticket-auto-review.js'
import {ticketDiningHandoffs,ticketRefundPreview,ticketRefundReviewQueue} from './table-ticket-refund-preview.js'
import {orderCollectionBalancesCtesSql} from './order-collection-balances-sql.js'
import {TableSessionRepository} from './table-session-repository.js'
import {WaitlistRepository} from './waitlist-repository.js'
import {tableManagementApiPlugin} from './table-management-api.js'
import {TableManagementCommandService,TableManagementRepository} from './table-management-repository.js'
import {MembershipConfigurationDraftService} from './membership-configuration-draft-service.js'
import {PostgresMembershipConfigurationDraftRepository} from './membership-configuration-draft-repository.js'
import {PaymentFulfillmentRepository} from './payment-fulfillment-repository.js'
import {LoyaltyOperationalControlService} from './loyalty-operational-control-service.js'
import {LoyaltyPointsExpiryWorker} from './loyalty-points-expiry-worker.js'
import {ItemQuantityRepository} from './item-quantity-repository.js'
import {CustomerExperienceRepository,CustomerExperienceRequestError} from './customer-experience-repository.js'
import {customerExperienceApiPlugin} from './customer-experience-api.js'
import {createMembershipRecoveryPhoneProtector,replaceVerifiedPhoneInTransaction} from './membership-recovery-service.js'
import {OrderRepository} from './order-repository.js'
import {TablePrepaymentRepository} from './table-prepayment-repository.js'
import {ItemAfterSalesCommandService} from './item-after-sales-command-service.js'
import {ItemAfterSalesOperatingEffects} from './item-after-sales-operating-effects.js'
import {ActivityOperationsService} from './activity-operations-service.js'
import {AssistedOrderContextRepository} from './assisted-order-context.js'
import {offerTabPoints,confirmTabPoints} from './existing-tab-points.js'
import {proposeMove,decideMove} from './table-ticket-reschedule.js'
import Fastify from 'fastify'
import {PromotionalLoyaltyWorker} from './promotional-loyalty-worker.js'
import {reservationReceptionApiPlugin} from './reservation-reception-api.js'
import {correctTicketGift,confirmBuyerUse} from './table-ticket-correction.js'
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
import {ActivityRegistrationExpiryWorker} from './activity-registration-expiry-worker.js'
import {ReservationHoldExpiryWorker} from './reservation-hold-expiry-worker.js'
import {ReservationRepository} from './reservation-repository.js'
import {ticketReception,ticketFinanceDay,ticketStatement,admitTicketBatch,updateTicketContact,assignTicketTable} from './table-ticket-reception.js'
import {createActivityContactProtectionKeyring} from './personal-contact-protection.js'
import {createHash,randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {describe,it,expect,beforeAll,afterAll} from 'vitest'
import {runNormalizedMigrations} from '../migrate-normalized.js'
import {ScopedPostgresTransactionRunner,type ScopedTransaction} from './transaction-runner.js'
import {buyTableTickets,memberTicketProposals,publicTableTickets} from './table-ticket-purchase.js'
import {approveEventTicketTerms,saveTicketOffer,ticketOfferCatalog,publishTicketDrafts} from './table-ticket-offer-repository.js'
import {creditTableTicketGifts} from './table-ticket-gifts.js'
import {PaymentRepository} from './payment-repository.js'
import {PaymentCommandService} from './payment-command-service.js'
import {NormalizedPaymentCapabilityAuthorization} from './payment-security-policy.js'
import {PostgresCashierWorkbenchQuery} from './cashier-workbench-query.js'
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
        await admin.query(`INSERT INTO mbox.community_activities(id,tenant_id,store_id,public_id,activity_kind,title,summary,cover_url,starts_at,ends_at,assembly_location,capacity,fee_amount_minor,deposit_amount_minor,fee_basis,registration_payment_mode,payment_deadline_minutes,payment_rule_text,currency,points_reward,visibility,safety_policy_version,safety_acknowledgement_text,safety_requirements,refund_policy_version,refund_policy_summary,activity_details,included_items,participation_requirements,contact_instructions,status,published_at,created_by_employee_id,approved_by_employee_id) VALUES($1::uuid,$2,$3,$1::text,'member_night','服务测试','服务测试活动','/menu/show.jpg',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','门口',1000,0,0,'per_registration','none',15,'免费活动','CNY',0,'public','activity-safety-v1','已知安全规则',ARRAY['年满18周岁'],'activity-refund-v1','按原退款约定','现场音乐、交流与限定饮品体验。',ARRAY['欢迎饮品'],ARRAY['提前到场'],'报名成功后在小程序查看集合通知','published',clock_timestamp(),$4,$4)`, [activity, scope.tenantId, scope.storeId, employee]);

      await admin.query(`WITH membership AS(INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,'MBX-SERVICE-TEST') RETURNING *) INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) SELECT tenant_id,store_id,id,customer_id FROM membership`,[scope.tenantId,scope.storeId,customer]);
      await admin.query(`INSERT INTO mbox.store_commerce_policies(tenant_id,store_id,online_payment_enabled,reason,updated_by_employee_id) VALUES($1,$2,true,'活动服务测试',$3) ON CONFLICT(tenant_id,store_id) DO UPDATE SET online_payment_enabled=true`,[scope.tenantId,scope.storeId,employee]);
      await admin.query(`UPDATE mbox.customer_experience_features SET rollout_state='pilot',reason='活动服务支付测试' WHERE tenant_id=$1 AND store_id=$2 AND feature_code='community.activity.payment'`,[scope.tenantId,scope.storeId]);

    await admin.query("INSERT INTO mbox.public_reservation_policies(tenant_id,store_id) VALUES($1,$2)",[scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'window','窗边','indoor')",[area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1,$2,$3,'T'||n,'靠窗'||n,6 FROM generate_series(1,3)n",[scope.tenantId,scope.storeId,area])
  })
  afterAll(async()=>{await admin?.end()})
  const offerInput={areaId:area,expectedVersion:0,name:'整桌演出票',priceMinor:50000,giftPoints:550,status:'published' as const,visibleFrom:null,visibleUntil:null}
  it('commits concurrent reception and cashier opens once per desk before ticket sales',async()=>{
    const scope={tenantId:randomUUID(),storeId:randomUUID()}
    const walkInArea=randomUUID(),cashier=randomUUID(),employee=randomUUID()
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'并发测试')",[scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'并发测试')",[scope.storeId,scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'FLOOR','接待测试')",[scope.tenantId,scope.storeId,employee])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'CASH','收银测试')",[scope.tenantId,scope.storeId,cashier])
    await grantFixtureStaffPermissions(admin,scope,[employee,cashier],['table.open'])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'BURST','并发测试区','indoor')",[scope.tenantId,scope.storeId,walkInArea])
    const desks=await admin.query<{id:string}>(`INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity)
      SELECT $1,$2,$3,'BURST'||n,'并发桌'||n,4 FROM generate_series(1,48)n RETURNING id`,[scope.tenantId,scope.storeId,walkInArea])
    const service=new TableManagementCommandService(new NormalizedCommandExecutor(runner))
    const commands=desks.rows.map(({id},index)=>({scope,actor:{type:'employee' as const,employeeId:index%2?employee:cashier},
      businessDate:'2026-11-23',reason:'现场开台',primaryServiceEmployeeId:employee,tableId:id,publicId:randomUUID(),guestCount:2,idempotencyKey:randomUUID(),requestFingerprint:randomUUID()}))
    expect(await runner.run(scope,publicTableTickets)).toHaveLength(0)
    const durations:number[]=[]
    for(let index=0;index<commands.length;index+=8){
      const batch=commands.slice(index,index+8)
      const opens=await Promise.all(batch.map(async command=>{
        const started=performance.now()
        const result=await service.open(command)
        durations.push(performance.now()-started)
        return result
      }))
      const replays=await Promise.all(batch.map(command=>service.open(command)))
      expect(replays.map(r=>r.value.id)).toEqual(opens.map(r=>r.value.id))
      expect(replays.every(r=>r.replayed)).toBe(true)
    }
    const sessions=await admin.query(`SELECT s.table_id FROM mbox.table_sessions s JOIN mbox.tables t ON t.id=s.table_id
      WHERE t.area_id=$1 AND s.status='open'`,[walkInArea])
    expect(sessions.rows.map(row=>row.table_id).sort()).toEqual(desks.rows.map(row=>row.id).sort())
    durations.sort((a,b)=>a-b)
    console.info('Concurrent table opens (ms)',{count:durations.length,p95:Math.ceil(durations[Math.ceil(durations.length*0.95)-1]!),max:Math.ceil(durations.at(-1)!)})
  })
  it('publishes an immutable offer, rejects stale edits and hides a withdrawn series',async()=>{
    await expect(run(tx=>saveTicketOffer(tx,activity,employee,offerInput))).rejects.toMatchObject({code:'TICKET_EVENT_TERMS_REQUIRED'})
    await run(tx=>approveEventTicketTerms(tx,activity,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'隔离测试场次资料',performers:'测试乐队',
      durationMinutes:90,programNote:'至少十首',serviceContact:'测试客服',refundSchedule:'开演前可在订单内申请全额退票；演出取消原路退回。',requiresNamedAttendees:false},0))
    const editor=randomUUID(),service=new ActivityOperationsService(runner,new NormalizedCommandExecutor(runner),protection)
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'DRAFT','票档录入')",[editor,scope.tenantId,scope.storeId])
    await grantFixtureStaffPermissions(admin,scope,[editor],['community.activity.manage'])
    await grantFixtureStaffPermissions(admin,scope,[employee],['community.activity.publish'])
    const context=(employeeId:string)=>({scope,employeeId,businessDate:'2026-11-23'})
    const discovery=()=>run(async tx=>(await new CustomerExperienceRepository(tx,true).publicActivities(customer)).map(a=>a.publicId))
    expect(await discovery()).toContain(activity)
    const draft=(await service.saveTicketOffer(context(editor),activity,{...offerInput,giftPoints:null,status:'draft'},randomUUID())).value
    await expect(service.saveTicketOffer(context(editor),activity,{...offerInput,expectedVersion:draft.version},randomUUID())).rejects.toThrow()
    expect(await service.ticketOffers(context(employee),activity)).toMatchObject([{status:'draft',version:draft.version}])
    await expect(run(tx=>saveTicketOffer(tx,activity,employee,offerInput))).rejects.toMatchObject({code:'TICKET_VERSION_CHANGED'})
    expect(await run(publicTableTickets)).toHaveLength(0)
    await expect(run(tx=>approveEventTicketTerms(tx,activity,employee,{organizer:'门店演出',seller:'门店售票',approvalReference:'本场资料',performers:'驻场乐队',
      durationMinutes:90,programNote:'现场节目',serviceContact:'12345678901',refundSchedule:'12345678901',requiresNamedAttendees:false},1))).rejects.toMatchObject({code:'TICKET_REFUND_TERMS_INVALID'})
    // Exercise the multi-area publication inside a savepoint, leaving the later public-offer fixtures unchanged.
    await run(async tx=>{
      await tx.query('SAVEPOINT batch_setup')
      const other=randomUUID()
      await tx.query("INSERT INTO mbox.areas(tenant_id,store_id,id,code,name,area_type) VALUES($1,$2,$3,'BATCH','复核桌区','indoor')",[scope.tenantId,scope.storeId,other])
      await tx.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,'BATCH1','复核桌',4)",[scope.tenantId,scope.storeId,other])
      const a=await saveTicketOffer(tx,activity,editor,{...offerInput,status:'draft',expectedVersion:draft.version})
      const b=await saveTicketOffer(tx,activity,editor,{...offerInput,status:'draft',areaId:other})
      const selection=[{areaId:area,version:a.version},{areaId:other,version:b.version}]
      await expect(publishTicketDrafts(tx,activity,editor,selection,1)).rejects.toMatchObject({code:'TICKET_SELF_REVIEW'})
      const freeTemplateEvent=randomUUID()
      await tx.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,
        to_jsonb(a)||jsonb_build_object('id',$4::text,'public_id',$4::text,'refund_policy_summary','免费活动可在开始前取消'))).*
        FROM mbox.community_activities a WHERE a.tenant_id=$1 AND a.store_id=$2 AND a.public_id=$3`,[scope.tenantId,scope.storeId,activity,freeTemplateEvent])
      await approveEventTicketTerms(tx,freeTemplateEvent,employee,{organizer:'本场主办',seller:'门店',approvalReference:'场次核实',performers:'驻场乐团',durationMinutes:90,programNote:'现场演出',serviceContact:'现场客服',refundSchedule:'开演之前可按票面全额退票',requiresNamedAttendees:false},0)
      await expect(saveTicketOffer(tx,freeTemplateEvent,employee,offerInput)).rejects.toMatchObject({code:'TICKET_REFUND_TERMS_INVALID'})
      await tx.query('SAVEPOINT stale_batch')
      await expect(publishTicketDrafts(tx,activity,employee,[selection[0]!,{...selection[1]!,version:9}],1)).rejects.toMatchObject({code:'TICKET_VERSION_CHANGED'})
      await tx.query('ROLLBACK TO SAVEPOINT stale_batch')
      expect(await publicTableTickets(tx)).toHaveLength(0)
      expect(await publishTicketDrafts(tx,activity,employee,selection,1)).toHaveLength(2)
      expect(await publicTableTickets(tx)).toHaveLength(2)
      await tx.query('ROLLBACK TO SAVEPOINT batch_setup')
    })
    const first=(await service.saveTicketOffer(context(employee),activity,{...offerInput,expectedVersion:draft.version},randomUUID())).value
    expect(await run(publicTableTickets)).toMatchObject([{id:first.id,giftPoints:550,priceMinor:50000}])
    expect(await discovery()).not.toContain(activity)
    expect(await run(tx=>publicTableTickets(tx,true))).toEqual([])
    await admin.query("INSERT INTO mbox.menu_categories(tenant_id,store_id,code,display_name,guest_visible) VALUES($1,$2,'shows','演出专场',true)",[scope.tenantId,scope.storeId])
    const promo=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,categoryCode:'shows',recommendInCommunity:true,expectedVersion:first.version}))
    expect(await run(tx=>publicTableTickets(tx,true))).toMatchObject([{id:promo.id,priceMinor:50000,categoryCode:'shows',categoryName:'演出专场',coverUrl:'/menu/show.jpg',activityDetails:'现场音乐、交流与限定饮品体验。'}])
    await admin.query("UPDATE mbox.menu_categories SET guest_visible=false WHERE tenant_id=$1 AND store_id=$2 AND code='shows'",[scope.tenantId,scope.storeId])
    expect(await run(publicTableTickets)).toHaveLength(0)
    await admin.query("UPDATE mbox.menu_categories SET guest_visible=true WHERE tenant_id=$1 AND store_id=$2 AND code='shows'",[scope.tenantId,scope.storeId])
    const revision=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,status:'draft',recommendInCommunity:false,expectedVersion:promo.version}))
    expect(await run(tx=>publicTableTickets(tx,true))).toMatchObject([{id:promo.id}])
    await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,status:'withdrawn',expectedVersion:revision.version}))
    expect(await run(publicTableTickets)).toHaveLength(0)
    expect(await run(tx=>ticketOfferCatalog(tx,activity))).toMatchObject([{status:'withdrawn',version:5}])
  })
  it('checks verified membership and capacity, then grants once per paid ticket on retry',async()=>{
    const v=(await run(tx=>ticketOfferCatalog(tx,activity)))[0]?.version??0
    const offer=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,expectedVersion:Number(v)}))
    const terms=(await run(publicTableTickets)).find(row=>row.id===offer.id)!
    expect(terms.refundSchedule).toContain('首次验票入场后')
    await expect(run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:terms.safetyVersion,refundVersion:'activity-refund-v1'},randomUUID(),randomUUID(),randomUUID(),protection))).rejects.toMatchObject({code:'TICKET_OFFER_CHANGED'})
    const buy=(quantity:number)=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity,safetyVersion:'activity-safety-v1',refundVersion:terms.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
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
  it('finishes an open or transfer already claiming a desk when ticket reception requests the same desk',async()=>{
    const ticket=(await admin.query('SELECT id FROM mbox.table_tickets WHERE tenant_id=$1 ORDER BY ordinal LIMIT 1',[scope.tenantId])).rows[0]!.id
    const desk=(await admin.query('SELECT id FROM mbox.tables WHERE area_id=$1 ORDER BY code LIMIT 1',[area])).rows[0]!.id
    const other=(await admin.query('SELECT id FROM mbox.tables WHERE area_id=$1 AND id<>$2 ORDER BY code LIMIT 1',[area,desk])).rows[0]!.id
    await grantFixtureStaffPermissions(admin,scope,[employee],['table.transfer','table.view_all'])
    for(const surface of ['management','operations','transfer']){
      const input={businessDate:'2026-11-23',guestCount:1,publicId:randomUUID(),openedByEmployeeId:employee,primaryServiceEmployeeId:employee}
      const source=surface==='transfer'?await run(tx=>new TableManagementRepository(tx).open({...input,tableId:other})):undefined
      const write=source?'FROM mbox.execute_table_customer_movement(':'INSERT INTO mbox.table_sessions'
      let signal!:(pid:number)=>void,resume!:()=>void
      const ready=new Promise<number>(resolve=>{signal=resolve})
      const paused=new Promise<void>(resolve=>{resume=resolve})
      const opening=run(async tx=>{
        const pid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        const instrumented:ScopedTransaction={scope,async query(sql,values){
          if(sql.includes(write)){
            signal(pid)
            await paused
          }
          return tx.query(sql,values)
        }}
        if(source){
          const service=new TableManagementCommandService(new NormalizedCommandExecutor({run:(_scope,fn)=>fn(instrumented)}))
          const result=await service.transfer({scope,actor:{type:'employee',employeeId:employee},businessDate:input.businessDate,
            tableSessionId:source.id,targetTableId:desk,reason:'同区整体转桌',idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
          return {id:result.value.tableSessionId}
        }
        return surface==='management'?new TableManagementRepository(instrumented).open({...input,tableId:desk})
          :new TableSessionRepository(instrumented).open({...input,table:{kind:'id',value:desk}})
      })
      const holder=await Promise.race([ready,opening.then(()=>{throw Error('开桌未经过桌次写入')})])
      const assigning=run(tx=>assignTicketTable(tx,ticket,desk,employee,null))
      const outcomes=Promise.allSettled([opening,assigning])
      let blocked=false
      try{
        for(let step=0;step<200 && !blocked;step++){
          blocked=(await admin.query('SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) blocked',[holder])).rows[0].blocked
          if(!blocked)await new Promise(resolve=>setTimeout(resolve,5))
        }
      }finally{resume()}
      const [opened,assigned]=await outcomes
      if(opened.status==='rejected')throw opened.reason
      try{
        expect(blocked).toBe(true)
        expect(assigned).toMatchObject({status:'rejected',reason:{code:'TICKET_TABLE_UNAVAILABLE'}})
        await expect(run(tx=>assignTicketTable(tx,ticket,desk,employee,null))).rejects.toMatchObject({code:'TICKET_TABLE_UNAVAILABLE'})
        expect((await admin.query('SELECT reservation_lock_id FROM mbox.table_tickets WHERE id=$1',[ticket])).rows[0].reservation_lock_id).toBeNull()
      }finally{
        await run(tx=>new TableSessionRepository(tx).cancelOpenSession(opened.value.id,employee))
      }
    }
  })
  it('assigns one physical lock and returns only the other ticket through the original payment',async()=>{
    const tickets=(await admin.query('SELECT * FROM mbox.table_tickets WHERE tenant_id=$1 ORDER BY ordinal',[scope.tenantId])).rows
    const first=tickets[0]!, second=tickets[1]!
    await expect(run(tx=>new RefundRepository(tx).requestActivity({paymentId:first.payment_id,publicId:randomUUID(),reason:'整笔支付未选择具体桌票',requestedByCustomerId:customer}))).rejects.toThrow()
    expect((await admin.query('SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1',[first.payment_id])).rows[0].n).toBe(0)

    const table=(await admin.query('SELECT id FROM mbox.tables WHERE area_id=$1 ORDER BY code',[area])).rows[0]!.id
    // One ticket takes A, the second still needs a desk. B and C cannot both open.
    const others=(await admin.query<{id:string}>('SELECT id FROM mbox.tables WHERE area_id=$1 AND id<>$2 ORDER BY code',[area,table])).rows
    const cashier=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'MIXCASH','收银测试')",[scope.tenantId,scope.storeId,cashier])
    await grantFixtureStaffPermissions(admin,scope,[employee,cashier],['table.open'])
    const floor=Fastify()
    await floor.register(tableManagementApiPlugin,{transactions:runner,commands:new TableManagementCommandService(new NormalizedCommandExecutor(runner)),
      resolveContext:req=>({scope,employeeId:req.headers['test-staff']==='cashier'?cashier:employee,businessDate:'2026-11-23',capabilities:['table.open']})})
    try{
      const requests=others.map(({id},index)=>({method:'POST' as const,url:'/table-management/sessions/open',
        headers:{'idempotency-key':randomUUID(),'test-staff':index?'cashier':'reception'},
        payload:{publicId:randomUUID(),guestCount:2,tableId:id,primaryServiceEmployeeId:employee}}))
      await floor.ready()
      const [assigned,opens]=await Promise.all([run(tx=>assignTicketTable(tx,first.id,table,employee,null)),Promise.all(requests.map(req=>floor.inject(req)))])
      expect(assigned).toEqual({id:first.id,tableId:table})
      expect(opens.map(r=>r.statusCode).sort()).toEqual([201,409])
      const replays=await Promise.all(requests.map(req=>floor.inject(req)))
      for(const [index,response] of opens.entries()){
        expect(replays[index]!.statusCode).toBe(response.statusCode)
        if(response.statusCode===409){
          expect(response.json().error.code).toBe('TABLE_TICKET_CAPACITY_RESERVED')
          expect(replays[index]!.json().error).toEqual(response.json().error)
        }else{
          expect(replays[index]!.json().meta.replayed).toBe(true)
        }
      }
      const [show]=await run(publicTableTickets)
      expect(show!.remaining).toBe(0)
      const bookAssignedDesk=()=>run(tx=>new ReservationRepository(tx).create({publicId:randomUUID(),source:'phone',guestCount:1,
        customerName:'电话订桌',contactToken:'test',tableIds:[table],arrivalAt:show!.startsAt,expectedEndAt:show!.endsAt,
        initialStatus:'confirmed',reservationPolicyVersion:1,arrivalGraceEndsAt:show!.endsAt}))
      await expect(bookAssignedDesk()).rejects.toMatchObject({name:'ReservationConflictError'})
      expect((await admin.query("SELECT count(*)::int n FROM mbox.reservation_table_locks WHERE table_id=$1 AND status IN ('held','confirmed')",[table])).rows[0].n).toBe(1)
      const active=await admin.query('SELECT id,public_id FROM mbox.table_sessions WHERE table_id=ANY($1::uuid[]) AND status=\'open\'',[others.map(t=>t.id)])
      expect(active.rows.map(s=>s.public_id)).toEqual([requests[opens.findIndex(r=>r.statusCode===201)]!.payload.publicId])
      await run(tx=>new TableSessionRepository(tx).cancelOpenSession(active.rows[0]!.id,employee))
    }finally{await floor.close()}
    expect(await run(tx=>assignTicketTable(tx,first.id,table,employee,null))).toEqual({id:first.id,tableId:table})
    expect((await run(publicTableTickets))[0]?.remaining).toBe(1)
    const awaitedOrderNo=(await admin.query('SELECT public_id FROM mbox.community_activity_registrations WHERE id=$1',[first.registration_id])).rows[0].public_id
    const contact=await run(tx=>updateTicketContact(tx,(awaitedOrderNo),'called',employee))
    expect(contact.status).toBe('called')
    const receptionRows=await run(tx=>ticketReception(tx,activity))
    expect(receptionRows.orders.find(row=>row.id===first.id)).toMatchObject({contactStatus:'called',registrationStatus:'confirmed',contactVersionPublicId:expect.any(String),maskedPhone:expect.stringContaining('*')})

    expect((await admin.query('SELECT count(*)::int n FROM mbox.ticket_reception_tasks WHERE registration_id=$1',[first.registration_id])).rows[0].n).toBe(1)
    await expect(run(tx=>admitTicketBatch(tx,first.id,first.door_code,1001,employee,randomUUID()))).rejects.toMatchObject({code:'TICKET_DOOR_CAPACITY'})
    const lockedReservation=(await admin.query("UPDATE mbox.reservations SET arrival_grace_ends_at=clock_timestamp()-interval '1 minute' WHERE public_id='ticket-'||$1::text RETURNING id",[first.id])).rows[0].id
    const sweep=await new ReservationHoldExpiryWorker(runner).runBatch(scope,'paid-ticket-arrival-grace',50)
    expect(sweep.noShowReservationIds).not.toContain(lockedReservation)
    expect((await admin.query('SELECT status FROM mbox.reservations WHERE id=$1',[lockedReservation])).rows[0].status).toBe('confirmed')
    const admissionKey=randomUUID()
    await expect(run(tx=>admitTicketBatch(tx,first.id,'FFFFFFFFFFFF',2,employee,admissionKey))).rejects.toMatchObject({code:'TICKET_DOOR_INVALID'})
    await grantFixtureStaffPermissions(admin,scope,[employee],['reservation.manage','reservation.view','table.open','table.view_all'])
    const reserved=(await run(tx=>tx.query(`UPDATE mbox.reservations SET status='arrived' WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3
      RETURNING id,aggregate_version`,[scope.tenantId,scope.storeId,'ticket-'+first.id]))).rows[0]
    const se=(await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($1,$2,$3,$4,current_date,3,6,'open',$5,$5) RETURNING id,location_version,business_date::text`,[scope.tenantId,scope.storeId,table,randomUUID(),employee]))).rows[0]
    const reception=Fastify()
    await reception.register(reservationReceptionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveStaffContext:()=>({scope,employeeId:employee,businessDate:se.business_date}),protectContact:value=>protection.protect(value)})
    try{
      const candidates=()=>reception.inject({method:'GET',url:'/staff/reservation-receptions/'+reserved.id+'/table-sessions'})
      const seat=(expectedTableId=table,session=se)=>reception.inject({method:'POST',url:'/staff/reservation-receptions/'+reserved.id+'/seat',
        headers:{'idempotency-key':randomUUID()},payload:{protocol:1,reservationVersion:Number(reserved.aggregate_version),reason:'已核对原票入座桌号',
          sessions:[{tableSessionId:session.id,expectedTableId,expectedLocationVersion:Number(session.location_version),expectedGuestCount:3}]}})
      const beforeScan=await seat()
      expect(beforeScan.statusCode,beforeScan.body).toBe(409)
      expect(beforeScan.json().error.code).toBe('TICKET_SEATING_UNAVAILABLE')
      expect((await candidates()).json().data.ticketGuidance).toContain('入场码')
      await run(tx=>admitTicketBatch(tx,first.id,first.door_code,2,employee,admissionKey))
      await run(tx=>admitTicketBatch(tx,first.id,first.door_code,2,employee,admissionKey))
      await run(tx=>admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID()))
      expect((await admin.query('SELECT sum(quantity)::int n FROM mbox.ticket_admission_batches WHERE ticket_id=$1',[first.id])).rows[0].n).toBe(3)
      expect((await run(tx=>ticketRefundPreview(tx,first.id)))[0]).toMatchObject({personalRefundClosed:true})
      expect((await run(tx=>ticketRefundPreview(tx,second.id)))[0]).toMatchObject({personalRefundClosed:false})
      await expect(run(tx=>requestTicketRefund(tx,first.registration_id,first.id,customer,'入场后个人退票'))).rejects.toMatchObject({code:'TICKET_ALREADY_ADMITTED'})
      // Exercise the existing seating, dining and refund flows with a pre-policy purchase.
      await admin.query(`UPDATE mbox.community_activity_registrations SET refund_policy_snapshot=
        (refund_policy_snapshot-'personalRefundUntil') || jsonb_build_object('schedule','按购票时公示的原规则办理') WHERE id=$1`,[first.registration_id])
      let release!:()=>void,readyToSeat!:(pid:number)=>void
      const hold=new Promise<void>(resolve=>{release=resolve})
      const locked=new Promise<number>(resolve=>{readyToSeat=resolve})
      const refund=run(async tx=>{
        await requestTicketRefund(tx,first.registration_id,first.id,customer,'原票已到店，申请退票待复核')
        readyToSeat((await tx.query('SELECT pg_backend_pid() pid')).rows[0]!.pid)
        await hold
      })
      const pid=await Promise.race([locked,refund.then(()=>{throw Error('退票未锁定')})])
      const seating=seat().then(response=>response)
      let waiting=false
      try{
        for(let step=0;step<200 && !waiting;step++){
          waiting=(await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting
          if(!waiting)await new Promise(resolve=>setTimeout(resolve,5))
        }
      }finally{release()}
      const [,blocked]=await Promise.all([refund,seating])
      expect(waiting).toBe(true)
      const frozen=await candidates()
      expect(frozen.statusCode,frozen.body).toBe(200)
      expect(frozen.json().data.sessions).toEqual([])
      expect(frozen.json().data.ticketGuidance).toContain('退票')
      expect(blocked.statusCode,blocked.body).toBe(409)
      expect(blocked.json().error.code).toBe('TICKET_SEATING_UNAVAILABLE')
      expect((await admin.query('SELECT id FROM mbox.reservation_seating_batches WHERE reservation_id=$1',[reserved.id])).rowCount).toBe(0)
      await run(async tx=>{
        await tx.query('SAVEPOINT settle_arrival')
        await decideTicketCase(tx,first.id,{employee},'zero','按原条款零现金办结，释放已到店未领桌的专属预约')
        const released=(await tx.query('SELECT r.status,l.status AS lock FROM mbox.reservations r JOIN mbox.reservation_table_locks l ON l.reservation_id=r.id WHERE r.id=$1',[reserved.id])).rows[0]
        expect(released).toEqual({status:'cancelled',lock:'cancelled'})
        await tx.query('ROLLBACK TO SAVEPOINT settle_arrival')
      })
      await run(tx=>decideTicketCase(tx,first.id,{customer},'cancelled','购票人撤回退票，保留原桌'))
      const otherTable=(await admin.query('SELECT id FROM mbox.tables WHERE area_id=$1 AND id<>$2 ORDER BY code LIMIT 1',[area,table])).rows[0]!.id
      const otherSession=(await admin.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
        VALUES($1,$2,$3,$4,current_date,3,6,'open',$5,$5) RETURNING id,location_version`,[scope.tenantId,scope.storeId,otherTable,randomUUID(),employee])).rows[0]!
      const ready=await candidates()
      expect(ready.json().data.sessions.map((s:{tableId:string})=>s.tableId)).toEqual([table])
      const wrong=await seat(otherTable,otherSession)
      await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[otherSession.id])
      expect(wrong.statusCode).toBe(409)
      expect(wrong.json().error.code).toBe('TICKET_SEATING_TABLE_CHANGED')
      const response=await seat()
      expect(response.statusCode,response.body).toBe(200)
    }finally{await reception.close()}
    expect((await run(publicTableTickets))[0]?.remaining).toBe(1)
    const later=await run(tx=>admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID()))
    expect(later.quantity).toBe(1)
    await grantFixtureStaffPermissions(admin,scope,[employee],['table.transfer','table.view_all'])
    await run(async tx=>{
      await tx.query('SAVEPOINT seated_transfer')
      const newDesk=(await tx.query('SELECT id,display_name FROM mbox.tables WHERE area_id=$1 AND id<>$2 ORDER BY code LIMIT 1',[area,table])).rows[0]
      const transfer=new TableManagementCommandService(new NormalizedCommandExecutor({run:(_scope,fn)=>fn(tx)}))
      await transfer.transfer({scope,actor:{type:'employee',employeeId:employee},businessDate:se.business_date,idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),
        tableSessionId:se.id,targetTableId:newDesk.id,expectedSourceTableId:table,expectedLocationVersion:Number(se.location_version),reason:'同区换桌保留原接待'})
      expect((await publicTableTickets(tx))[0]?.remaining).toBe(1)
      expect((await ticketReception(tx,activity)).orders.find(r=>r.id===first.id)).toMatchObject({tableName:newDesk.display_name,deskClosed:false})
      expect(await assignTicketTable(tx,first.id,newDesk.id,employee,null)).toMatchObject({tableId:newDesk.id})
      expect(await admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID())).toMatchObject({quantity:1})
      await tx.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[se.id,employee])
      expect((await publicTableTickets(tx))[0]?.remaining).toBe(2)
      expect((await ticketReception(tx,activity)).orders.find(r=>r.id===first.id)).toMatchObject({tableName:null,deskClosed:true,awaitingDuringShow:false})
      await expect(assignTicketTable(tx,first.id,table,employee,null)).rejects.toMatchObject({code:'TICKET_NOT_ASSIGNABLE'})
      await expect(admitTicketBatch(tx,first.id,first.door_code,1,employee,randomUUID())).rejects.toMatchObject({code:'TICKET_DOOR_INVALID'})
      await tx.query('ROLLBACK TO SAVEPOINT seated_transfer')
    })

    const open=()=>run(tx=>requestTicketRefund(tx,second.registration_id,second.id,customer,'顾客申请退本票'))
    const request=await open()
    expect((await open()).caseId).toBe(request.caseId)
    expect(request.consumedMinor).toBe(0)
    expect((await admin.query('SELECT status FROM mbox.loyalty_point_lots WHERE id=$1',[second.point_lot_id])).rows[0]?.status).toBe('ticket_hold')
    const cash=await run(tx=>submitTicketCashRefund(tx,request.caseId,employee,50000,null))
    expect(await run(tx=>submitTicketCashRefund(tx,request.caseId,employee,50000,null))).toEqual(cash)
    await expect(run(tx=>submitTicketCashRefund(tx,request.caseId,employee,45000,null))).rejects.toMatchObject({code:'TICKET_REFUND_CHANGED'})
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
  it('uses the customer-confirmed staff basket, collects only the original dining discount, then refunds the ticket',{timeout:20_000},async()=>{
    const args=[scope.tenantId,scope.storeId], session=randomUUID(),product=randomUUID(),table=randomUUID()
    const checker=randomUUID(),publisher=randomUUID()
    for(const emp of [checker,publisher])await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1::uuid,$2,$3,$1::text,'测试员工')",[emp,...args])
    await grantFixtureStaffPermissions(admin,scope,[employee],['order.create','payment.collect.all_tables','payment.manual.cash.record','refund.approve','table.view_all'])
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
    const pendingTicket=(await admin.query('SELECT * FROM mbox.table_tickets WHERE tenant_id=$1 AND refunded_at IS NULL',[scope.tenantId])).rows[0]
    await run(async tx=>{
      await tx.query('SAVEPOINT pending_dining_capture')
      const pendingCase=await requestTicketRefund(tx,pendingTicket.registration_id,pendingTicket.id,customer,'餐饮款仍在途时申请退票')
      expect(pendingCase.consumedMinor).toBe(0)
      await expect(submitTicketCashRefund(tx,pendingCase.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
      await tx.query('SAVEPOINT abandon_dining')
      await tx.query("UPDATE mbox.orders SET status='cancelled',cancelled_at=clock_timestamp(),fulfillment_state='cancelled',fulfillment_expires_at=NULL,fulfillment_activated_at=NULL,fulfillment_released_at=clock_timestamp() WHERE id=$1",[order.id])
      expect(await new CheckoutPointsRepository(tx).releaseCancelled(order.id)).toBe(200)
      expect(await new CheckoutPointsRepository(tx).releaseCancelled(order.id)).toBe(0)
      expect((await submitTicketCashRefund(tx,pendingCase.caseId,employee,50000,null)).caseId).toBe(pendingCase.caseId)
      await tx.query('ROLLBACK TO SAVEPOINT abandon_dining')
      await collectDining(order.id,tx)
      expect((await requestTicketRefund(tx,pendingTicket.registration_id,pendingTicket.id,customer,'重新查看同一原案')).consumedMinor).toBe(20000)
      expect((await ticketDiningLines(tx,pendingCase.caseId))[0]?.usedMinor).toBe(20000)
      expect((await proposeTicketDining(tx,pendingCase.caseId,employee,'原餐饮款已收，重新核算')).amountMinor).toBe(20000)
      await tx.query('ROLLBACK TO SAVEPOINT pending_dining_capture')
    })
    const initialReceipt=await collect()
    expect(initialReceipt.amountMinor).toBe(6000)
    const k=(await admin.query('SELECT * FROM mbox.table_tickets WHERE tenant_id=$1 AND refunded_at IS NULL',[scope.tenantId])).rows[0]
    await run(async tx=>{
      await tx.query('SAVEPOINT partial_dish_first')
      const originalCase=await requestTicketRefund(tx,k.registration_id,k.id,customer,'先申请退票再退部分菜款')
      await proposeTicketDining(tx,originalCase.caseId,employee,'按原抵扣二百元提请核对')
      const findProposal=async()=>(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1 AND superseded_at IS NULL',[originalCase.caseId])).rows[0]!.id
      const oldProposal=await findProposal()
      async function returnHalfOfOriginal(){
        const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[order.id])).rows[0]
        const repo=new RefundRepository(tx)
        const food=await repo.request({purpose:'return_goods',paymentId:initialReceipt.id,publicId:'DF'+randomUUID(),reason:'原菜款部分退回',
          requestedByEmployeeId:employee,allocations:[{orderItemId:item.id,amountMinor:3000}]})
        await repo.approve(food.id,checker,'核对原菜品及已收款');await repo.beginExecution(food.id)
        await repo.completeManualExecution({refundId:food.id,succeeded:true,receiptReference:'DISH-'+food.id})
        await new CheckoutPointsRepository(tx).restoreRefund(order.id,food.id)
      }
      await tx.query('SAVEPOINT confirmed_before_dish_return')
      await consentTicketDining(tx,oldProposal,customer)
      await returnHalfOfOriginal()
      await expect(collectDining(order.id,tx)).rejects.toThrow('原菜款或退菜记录已变化')
      await tx.query('ROLLBACK TO SAVEPOINT confirmed_before_dish_return')
      await returnHalfOfOriginal()
      const f=await requestTicketRefund(tx,k.registration_id,k.id,customer,'先部分退菜后退本票')
      expect(f.consumedMinor).toBe(10000)
      expect(await ticketDiningLines(tx,f.caseId)).toMatchObject([{usedMinor:10000,review:false}])
      expect(f.caseId).toBe(originalCase.caseId)
      await expect(consentTicketDining(tx,oldProposal,customer)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW'})
      expect(await proposeTicketDining(tx,f.caseId,employee,'核对原菜款按份分摊')).toMatchObject({amountMinor:10000})
      const revised=await findProposal()
      expect(revised).not.toBe(oldProposal)
      await expect(consentTicketDining(tx,oldProposal,customer)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW'})
      expect((await consentTicketDining(tx,revised,customer)).amountMinor).toBe(10000)
      expect((await collectDining(order.id,tx)).amountMinor).toBe(10000)
      expect((await submitTicketCashRefund(tx,f.caseId,employee,50000,null)).caseId).toBe(f.caseId)
      await tx.query('ROLLBACK TO SAVEPOINT partial_dish_first')
    })
    const f=await run(tx=>requestTicketRefund(tx,k.registration_id,k.id,customer,'原票个人退票'))
    expect(f.consumedMinor).toBe(20000)
    expect(await run(tx=>ticketDiningLines(tx,f.caseId))).toMatchObject([{usedMinor:20000,priceMinor:26000}])
    await expect(run(tx=>submitTicketCashRefund(tx,f.caseId,employee,50000,null))).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
    await run(tx=>proposeTicketDining(tx,f.caseId,employee,'根据原票明示条款核算'))
    await run(async tx=>{
      await tx.query('SAVEPOINT pending_supplement_refund')
      const bill=(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0]!.id
      await consentTicketDining(tx,bill,customer)
      const cashier=new PaymentRepository(tx)
      const attempt=await cashier.createForOrder({orderId:order.id,publicId:'DP'+randomUUID(),provider:'postar',method:'native_qr',
        initialStatus:'pending',principal:{type:'employee',employeeId:employee}})
      expect((await ticketDiningHandoffs(tx)).filter(row=>row.caseId===f.caseId)).toMatchObject([{step:'check_receipt',amount:'20000'}])
      await tx.query('SAVEPOINT closed_supplement_receipt')
      await tx.query("UPDATE mbox.payments SET status='closed' WHERE id=$1",[attempt.id])
      expect((await ticketDiningHandoffs(tx)).filter(row=>row.caseId===f.caseId)).toMatchObject([{step:'collect'}])
      await tx.query('ROLLBACK TO SAVEPOINT closed_supplement_receipt')
      const venue=await submitTicketCashRefund(tx,f.caseId,employee,50000,'门店取消演出，补款渠道待确认')
      const refunds=new RefundRepository(tx)
      const ticket=await refunds.approve(venue.refundId,checker,'按门店责任退原票款')
      await refunds.beginExecution(ticket.id)
      await refunds.completeProviderExecution({refundPublicId:ticket.publicId,provider:'postar',providerRefundId:'T-'+ticket.id,
        originalProviderTransactionId:'fixture-'+k.payment_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      expect((await tx.query('SELECT id FROM mbox.refunds WHERE payment_id=$1',[attempt.id])).rowCount).toBe(0)
      const capture=()=>cashier.applySucceededCallback({paymentPublicId:attempt.publicId,provider:'postar',providerTransactionId:'D-'+attempt.id,reportedAmountMinor:20000,reportedCurrency:'CNY'})
      expect((await capture()).applied).toBe(true)
      expect((await capture()).applied).toBe(false)
      const lateReturn=(await tx.query('SELECT id,status,amount_minor FROM mbox.refunds WHERE payment_id=$1',[attempt.id])).rows
      expect(lateReturn).toMatchObject([{status:'requested',amount_minor:'20000'}])
      const loyalty=new LoyaltyAccrualRepository(tx)
      await cashier.syncOrderPaymentStatus(order.id)
      await loyalty.recordPaidOrder({orderId:order.id,paymentId:attempt.id,occurredAt:new Date().toISOString()})
      const back=await refunds.approve(lateReturn[0]!.id,checker,'原补款迟到后按原路退回')
      await refunds.beginExecution(back.id)
      const returnInput={refundPublicId:back.publicId,provider:'postar' as const,providerRefundId:'R-'+back.id,originalProviderTransactionId:'D-'+attempt.id,reportedAmountMinor:20000,reportedCurrency:'CNY',succeeded:true}
      expect((await refunds.completeProviderExecution(returnInput)).applied).toBe(true)
      await loyalty.reverseSucceededRefund({orderId:order.id,paymentId:attempt.id,refundId:back.id,occurredAt:new Date().toISOString()})
      expect((await refunds.completeProviderExecution(returnInput)).applied).toBe(false)
      const net=(await tx.query(`SELECT (awarded_points-reversed_points+restored_points)::int points,
        (awarded_growth-reversed_growth+restored_growth)::int growth FROM mbox.loyalty_order_awards WHERE order_id=$1`,[order.id])).rows[0]
      expect(net).toEqual({points:6,growth:60})
      expect((await tx.query('SELECT remaining_points,status FROM mbox.loyalty_point_lots WHERE id=$1',[k.point_lot_id])).rows[0]).toEqual({remaining_points:0,status:'reversed'})
      await tx.query('ROLLBACK TO SAVEPOINT pending_supplement_refund')
    })
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,employee])
    const bill=(await admin.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
    await expect(collect()).rejects.toThrow()
    await run(tx=>consentTicketDining(tx,bill,customer))
    const payments=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization())
    const collectClosed=(expected:number,actor=employee)=>payments.recordManual({scope,actor:{type:'employee',employeeId:actor},
      businessDate:new Date().toISOString().slice(0,10),idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),publicId:randomUUID(),
      orderId:order.id,provider:'cash',method:'cash',evidence:{collectedByEmployeeId:actor,receiptReference:randomUUID()},
      closedDebtGuard:{amountMinor:expected,authorizationId:bill}})
    await expect(collectClosed(20000,checker)).rejects.toThrow()
    await grantFixtureStaffPermissions(admin,scope,[employee],['payment.recollect.authorize'])
    const workbench=await new PostgresCashierWorkbenchQuery(runner).get({scope,employeeId:employee,
      businessDate:new Date().toISOString().slice(0,10),query:order.publicId,limit:20,capabilities:['payment.collect.all_tables','payment.recollect.authorize','payment.manual.cash.record']})
    expect(workbench.orders.find(o=>o.id===order.id)).toMatchObject({confirmedTicketDiningMinor:20000,outstandingAmountMinor:20000,
      closedDebtRecovery:{kind:'ticket_dining',status:'available',confirmationId:bill}})
    await expect(collectClosed(19900)).rejects.toThrow()
    const supplement=(await collectClosed(20000)).value
    await expect(collectClosed(20000)).rejects.toThrow()
    expect((await admin.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[session])).rows[0].status).toBe('closed')
    expect(supplement.amountMinor).toBe(20000)
    await run(async tx=>{
      await tx.query('SAVEPOINT venue_assumes_paid_dining')
      const venue=await submitTicketCashRefund(tx,f.caseId,employee,50000,'门店取消演出，承担已收的餐饮差额')
      const repo=new RefundRepository(tx)
      const ticketReturn=await repo.approve(venue.refundId,checker,'门店承担，分别核对票款和补款')
      await repo.beginExecution(ticketReturn.id)
      const complete=()=>repo.completeProviderExecution({refundPublicId:ticketReturn.publicId,provider:'postar',
        providerRefundId:'test-'+venue.refundId,originalProviderTransactionId:'fixture-'+k.payment_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      await complete()
      expect((await tx.query('SELECT status FROM mbox.table_ticket_refund_requests WHERE id=$1',[f.caseId])).rows[0].status).toBe('refunded')
      const diningReturn=(await tx.query("SELECT id,amount_minor FROM mbox.refunds WHERE payment_id=$1 AND status='requested'",[supplement.id])).rows
      expect(diningReturn).toMatchObject([{amount_minor:'20000'}])
      await repo.approve(diningReturn[0]!.id,checker,'独立复核原补款');await repo.beginExecution(diningReturn[0]!.id)
      await repo.completeManualExecution({refundId:diningReturn[0]!.id,succeeded:true,receiptReference:'VENUE-'+bill})
      await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:order.id,paymentId:supplement.id,refundId:diningReturn[0]!.id,occurredAt:new Date().toISOString()})
      expect((await tx.query("SELECT count(*)::int n FROM mbox.refunds WHERE payment_id=$1",[supplement.id])).rows[0].n).toBe(1)
      expect((await tx.query('SELECT reversed_points FROM mbox.loyalty_order_awards WHERE order_id=$1',[order.id])).rows[0].reversed_points).toBe(20)
      await tx.query('ROLLBACK TO SAVEPOINT venue_assumes_paid_dining')
    })
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
    const free=(await admin.query("SELECT t.id FROM mbox.tables t WHERE t.area_id=$1 AND NOT EXISTS(SELECT 1 FROM mbox.reservation_table_locks l WHERE l.table_id=t.id AND l.status IN ('held','confirmed')) AND NOT EXISTS(SELECT 1 FROM mbox.table_sessions d WHERE d.table_id=t.id AND d.status IN ('open','closing')) LIMIT 1",[offer.areaId])).rows[0].id
    await expect(run(tx=>new ReservationRepository(tx).create({publicId:randomUUID(),source:'phone',guestCount:1,customerName:'电话预约',contactToken:'test',tableIds:[free],arrivalAt:offer.startsAt,expectedEndAt:offer.endsAt,initialStatus:'confirmed',reservationPolicyVersion:1,arrivalGraceEndsAt:offer.endsAt}))).rejects.toThrow(/已购桌票|时段.*占用/)
    await expect(run(tx=>tx.query("INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1,$2,$3,$4,current_date,1)",[scope.tenantId,scope.storeId,free,randomUUID()]))).rejects.toThrow(/已购桌票|时段.*占用/)
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
      for(const resolvesAfterCash of [false,true]){
        await tx.query('SAVEPOINT wrong_refund_first')
        const disputed=await requestTicketRefund(tx,k.id,ticket,customer,'本人先申请退票，核实错户已用')
        await expect(proposeTicketDining(tx,disputed.caseId,employee,'未经核实的菜款')).rejects.toThrow()
        await expect(submitTicketCashRefund(tx,disputed.caseId,employee,50000,null)).rejects.toThrow()
        const finish=async(merchantReason:string|null)=>{
          const cash=await submitTicketCashRefund(tx,disputed.caseId,employee,50000,merchantReason)
          const repository=new RefundRepository(tx),refund=await repository.approve(cash.refundId,reviewer,'按原票实付退款')
          await repository.beginExecution(cash.refundId)
          await repository.completeProviderExecution({refundPublicId:refund.publicId,provider:'postar',providerRefundId:'case-'+cash.refundId,
            originalProviderTransactionId:'local-'+pay,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
        }
        if(resolvesAfterCash)await finish('门店取消演出，票款先退')
        const issue=await correctTicketGift(tx,ticket,employee,'核对原菜款，错户本人用分由门店承担','request',null,true)
        await correctTicketGift(tx,ticket,reviewer,'核实原用分流水和门店承担','approve',issue.id)
        if(!resolvesAfterCash){
          expect(await requestTicketRefund(tx,k.id,ticket,customer,'属于同一原案')).toMatchObject({caseId:disputed.caseId,consumedMinor:0})
          const replacement=(await tx.query('SELECT l.status,l.remaining_points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE k.id=$1',[ticket])).rows[0]
          expect(replacement).toEqual({status:'ticket_hold',remaining_points:550})
          await finish(null)
        }
        expect((await tx.query('SELECT status FROM mbox.table_ticket_refund_requests WHERE id=$1',[disputed.caseId])).rows[0].status).toBe('refunded')
        expect((await tx.query('SELECT count(*)::int n FROM mbox.ticket_dining_collections WHERE case_id=$1',[disputed.caseId])).rows[0].n).toBe(0)
        expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[wrong])).rows[0].available_points).toBe(6)
        expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points).toBe(prior)
        await tx.query('ROLLBACK TO SAVEPOINT wrong_refund_first')
      }
      await tx.query('SAVEPOINT buyer_corrects_open_refund')
      const beforeCorrection=await requestTicketRefund(tx,k.id,ticket,customer,'先申请退票，再核实本人用分')
      const buyerFix=await correctTicketGift(tx,ticket,employee,'核对购票会员实际使用200分','request',null,false,true)
      await confirmBuyerUse(tx,buyerFix.id,customer)
      await correctTicketGift(tx,ticket,reviewer,'独立核对本人确认和原菜品','approve',buyerFix.id)
      expect((await tx.query('SELECT f.frozen_points,f.consumed_minor::int used,l.status,l.remaining_points FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON k.id=f.ticket_id JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE f.id=$1',[beforeCorrection.caseId])).rows[0])
        .toEqual({frozen_points:350,used:20000,status:'ticket_hold',remaining_points:350})
      expect((await proposeTicketDining(tx,beforeCorrection.caseId,employee,'按已确认的原单差额补款')).amountMinor).toBe(20000)
      await expect(submitTicketCashRefund(tx,beforeCorrection.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
      await tx.query('ROLLBACK TO SAVEPOINT buyer_corrects_open_refund')
      await tx.query('SAVEPOINT buyer_use_review')
      const use=await correctTicketGift(tx,ticket,employee,'待本人确认使用200分','request',null,false,true)
      await expect(correctTicketGift(tx,ticket,reviewer,'核实原菜','approve',use.id)).rejects.toMatchObject({code:'TICKET_BUYER_CONFIRM_REQUIRED'})
      await expect(confirmBuyerUse(tx,use.id,wrong)).rejects.toMatchObject({code:'TICKET_BUYER_MISMATCH'})
      await confirmBuyerUse(tx,use.id,customer)
      await correctTicketGift(tx,ticket,reviewer,'核对本人确认记录','approve',use.id)
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points).toBe(prior+350)
      await tx.query('SAVEPOINT before_buyer_refund')
      const refund=await requestTicketRefund(tx,k.id,ticket,customer,'核对曾用200分')
      expect(refund.consumedMinor).toBe(20000)
      expect((await ticketDiningLines(tx,refund.caseId)).reduce((sum,line)=>sum+line.usedMinor,0)).toBe(20000)
      await tx.query('ROLLBACK TO SAVEPOINT before_buyer_refund')
      const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[meal.id])).rows[0]
      const receipt=(await tx.query('SELECT id FROM mbox.payments WHERE order_id=$1 AND amount_minor=6000',[meal.id])).rows[0]
      const returns=new RefundRepository(tx)
      const returned=await returns.request({purpose:'return_goods',paymentId:receipt.id,publicId:randomUUID(),reason:'购票人确认后退原菜',requestedByEmployeeId:employee,allocations:[{orderItemId:item.id,amountMinor:6000}]})
      await returns.approve(returned.id,reviewer,'按原菜退还')
      await returns.beginExecution(returned.id)
      await returns.completeManualExecution({refundId:returned.id,succeeded:true,receiptReference:randomUUID()})
      const points=new CheckoutPointsRepository(tx)
      await points.restoreRefund(meal.id,returned.id)
      await points.restoreRefund(meal.id,returned.id)
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE customer_id=$1',[customer])).rows[0].available_points).toBe(prior+550)
      expect((await requestTicketRefund(tx,k.id,ticket,customer,'退菜后再退票')).consumedMinor).toBe(0)
      await tx.query('ROLLBACK TO SAVEPOINT buyer_use_review')
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
    const convert=()=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:available.safetyVersion,refundVersion:available.refundVersion,
      reservationLockId:reservation.tableLocks[0]!.id},randomUUID(),randomUUID(),randomUUID(),protection))
    const unpaid=await convert()
    expect(await current()).toBe(0)
    await admin.query("UPDATE mbox.reservations SET status='arrived' WHERE id=$1",[reservation.id])
    const reception=Fastify()
    await reception.register(reservationReceptionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveStaffContext:()=>({scope,employeeId:employee,businessDate:new Date().toISOString().slice(0,10)}),protectContact:value=>protection.protect(value)})
    try{
      const pending=await reception.inject({method:'GET',url:'/staff/reservation-receptions/'+reservation.id+'/table-sessions'})
      expect(pending.statusCode,pending.body).toBe(200)
      expect(pending.json().data.ticketGuidance).toContain('原购票单')
      await admin.query("UPDATE mbox.community_activity_registrations SET seat_hold_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[unpaid.id])
      const expired=await new ActivityRegistrationExpiryWorker(runner).runBatch(scope,'ticket-conversion-expiry')
      expect(expired.releasedRegistrationIds).toContain(unpaid.id)
      const resumed=await reception.inject({method:'GET',url:'/staff/reservation-receptions/'+reservation.id+'/table-sessions'})
      expect(resumed.json().data.ticketGuidance).toBeNull()
    }finally{await reception.close()}
    const order=await convert()
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='LOCAL-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[order.id])).rows[0].id
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:50000,succeededAt:new Date().toISOString(),status:'succeeded'}))
    const ticket=(await admin.query('SELECT id FROM mbox.table_tickets WHERE registration_id=$1',[order.id])).rows[0].id
    await run(tx=>assignTicketTable(tx,ticket,table,employee,reservation.publicId))
    expect((await admin.query('SELECT reservation_lock_id FROM mbox.table_tickets WHERE id=$1',[ticket])).rows[0].reservation_lock_id).toBe(reservation.tableLocks[0]!.id)
    await run(async tx=>{
      await tx.query('SAVEPOINT prior_no_show')
      await tx.query("UPDATE mbox.reservation_table_locks SET status='expired' WHERE id=$1",[reservation.tableLocks[0]!.id])
      expect((await publicTableTickets(tx)).find(o=>o.id===offer.id)!.remaining).toBe(0)
      expect((await ticketReception(tx,activity)).orders.find(o=>o.id===ticket)?.tableName).toBeNull()
      await assignTicketTable(tx,ticket,table,employee,null)
      await assignTicketTable(tx,ticket,table,employee,null)
      expect((await publicTableTickets(tx)).find(o=>o.id===offer.id)!.remaining).toBe(0)
      await tx.query('ROLLBACK TO SAVEPOINT prior_no_show')
    })
    await run(tx=>requestTicketRefund(tx,order.id,ticket,customer,'按原票条款终止'))
    expect((await run(tx=>decideTicketCase(tx,ticket,{employee},'zero','原场规定该时段无应退现金'))).status).toBe('refunded')
    expect((await admin.query('SELECT status FROM mbox.reservation_table_locks WHERE id=$1',[reservation.tableLocks[0]!.id])).rows[0].status).toBe('confirmed')
    expect((await admin.query('SELECT status FROM mbox.reservations WHERE id=$1',[reservation.id])).rows[0].status).toBe('arrived')
    expect(await current()).toBe(0)
  })
  it('binds a staff-selected offer to the verified phone and refunds a late payment without issuing tickets',async()=>{
    const offer=(await run(publicTableTickets)).find(o=>o.remaining>0)!
    const colleague=(await admin.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
    await grantFixtureStaffPermissions(admin,scope,[employee],['refund.request'])
    await grantFixtureStaffPermissions(admin,scope,[employee,colleague],['community.activity.verify'])
    const assistance=new ActivityOperationsService(runner,new NormalizedCommandExecutor(runner),protection)
    const send=(actor:string,phone:string,key:string)=>assistance.offerTicketToMember({scope,employeeId:actor,businessDate:'2026-11-23'},offer.id,1,phone,key)
    const firstKey=randomUUID()
    const [first,second,wrong]=await Promise.all([send(employee,'13800000000',firstKey),send(colleague,'13800000000',randomUUID()),send(employee,'13800000009',randomUUID())])
    const proposal=first.value
    expect((await send(employee,'13800000000',firstKey)).value.id).toBe(proposal.id)
    const visible=await run(tx=>memberTicketProposals(tx,customer))
    expect(visible.map(x=>x.id)).toEqual(expect.arrayContaining([proposal.id,second.value.id]))
    expect(visible.map(x=>x.id)).not.toContain(wrong.value.id)
    expect(await run(tx=>memberTicketProposals(tx,randomUUID()))).toHaveLength(0)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.customer_memberships WHERE customer_id=$1',[customer])).rows[0].n).toBe(1)
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
  it('settles either ticket from the same two-table payment after the first funded a meal',{timeout:20_000},async()=>{
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
    const terms=(await run(publicTableTickets)).find(row=>row.id===offer.id)!
    const sale=await run(tx=>buyTableTickets(tx,buyer,{offerId:offer.id,quantity:2,safetyVersion:'activity-safety-v1',refundVersion:terms.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='twotix-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id,succeeded_at",[sale.id])).rows[0]
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:sale.id,payableKind:'activity_registration',amountMinor:100000,succeededAt:pay.succeeded_at.toISOString(),status:'succeeded'}))
    const tickets=(await admin.query('SELECT id,point_lot_id FROM mbox.table_tickets WHERE registration_id=$1 ORDER BY ordinal',[sale.id])).rows
    const physical=(await admin.query("SELECT id FROM mbox.tables WHERE tenant_id=$1 AND code='BOX1'",[scope.tenantId])).rows[0].id
    const session=(await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($1,$2,$3,$4,current_date,1,6,'open',$5,$5) RETURNING id`,[...args,physical,randomUUID(),employee]))).rows[0].id
    const product=(await admin.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id) VALUES($1,$2,$3,$4)",[...args,session,buyer])
    const ref=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:buyer})
    // Use one fully funded dish. The second ticket is a control for cross-ticket balance changes.
    const fullGiftDish = randomUUID()
    await admin.query(`WITH dish AS (
      INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode)
      VALUES($3,$1,$2,'FULLGIFT','550元原价菜','food','none','not_managed') RETURNING id,tenant_id,store_id
    ) INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from)
      SELECT tenant_id,store_id,id,'standard',55000,'CNY','2020-01-01' FROM dish`, [...args,fullGiftDish])
    await run(async tx=>{
      await tx.query('SAVEPOINT full_ticket_meal')
      const proposal = await staffPointsProposal(tx,employee,session,'MBX-TWO-TABLES',[{productId:fullGiftDish,quantity:1}],550)
      const checkout = await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},proposal.id!)
      expect(checkout.quote).toMatchObject({subtotalMinor:55000,pointsUsed:550,payableMinor:0})
      const meal = await placeDining(session,buyer,ref,checkout,tx)
      await new PaymentRepository(tx).syncOrderPaymentStatus(meal.id)
      await new PaymentFulfillmentRepository(tx).activatePaidOrder(meal.id)
      await new CheckoutPointsRepository(tx).consume(meal.id)
      const original = (await tx.query('SELECT lot_id,points FROM mbox.checkout_point_lots WHERE quote_id=$1',[checkout.quote.id])).rows
      expect(original).toEqual([{lot_id:tickets[0].point_lot_id,points:550}])
      const lots = ()=>tx.query(`SELECT l.remaining_points,l.status FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l
        ON l.id=k.point_lot_id WHERE k.registration_id=$1 ORDER BY k.ordinal`,[sale.id])
      const mealPayments = ()=>tx.query('SELECT id FROM mbox.payments WHERE order_id=$1',[meal.id])
      const originalTicket = tickets[0].id
      const dayBefore = await ticketFinanceDay(tx,null)
      await tx.query('SAVEPOINT personal_full_ticket')
      // Bind the normal commands to this fixture transaction so each responsibility scenario can start from the same sale.
      const transactions:Pick<ScopedPostgresTransactionRunner,'run'>={run:(_scope,handler)=>handler(tx)}
      const commands=new NormalizedCommandExecutor(transactions)
      const staff=new ActivityOperationsService(transactions,commands,protection)
      const context={scope,employeeId:employee,businessDate:dayBefore.day}
      const [preview]=await ticketRefundPreview(tx,originalTicket)
      const openKey=randomUUID()
      const opened=await staff.openStaffTicketRefund(context,originalTicket,'本人原因，按购票条款退500元',openKey,preview!.previewVersion,50000)
      expect((await staff.openStaffTicketRefund(context,originalTicket,'本人原因，按购票条款退500元',openKey,preview!.previewVersion,50000)).replayed).toBe(true)
      const personal = await requestTicketRefund(tx,sale.id,originalTicket,buyer,'本人原因，依据原菜款申请核定')
      expect(opened.value.caseId).toBe(personal.caseId)
      expect(personal.consumedMinor).toBe(55000)
      expect((await ticketStatement(tx,originalTicket)).originalDishes).toMatchObject([{orderNo:meal.publicId,name:'550元原价菜',priceMinor:55000,usedMinor:55000}])
      expect(await ticketDiningLines(tx,personal.caseId)).toMatchObject([{priceMinor:55000,usedMinor:55000,review:false}])
      await expect(proposeTicketDining(tx,personal.caseId,employee,'已人工核对原价550元及票款500元')).rejects.toMatchObject({code:'TICKET_DINING_REVIEW'})
      expect((await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[personal.caseId])).rows).toEqual([])
      await expect(submitTicketCashRefund(tx,personal.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
      await expect(collectDining(meal.id,tx)).rejects.toThrow('no outstanding balance')
      expect((await mealPayments()).rows).toEqual([])
      expect(await ticketFinanceDay(tx,dayBefore.day)).toEqual(dayBefore)
      expect((await lots()).rows).toEqual([{remaining_points:0,status:'ticket_hold'},{remaining_points:550,status:'available'}])
      expect((await ticketStatement(tx,originalTicket)).refunds).toMatchObject([{status:'review',cashStatus:null}])
      const approver = (await tx.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
      const confirmedRefund = async(refundId:string)=>{
        const refunds = new RefundRepository(tx)
        const approved = await refunds.approve(refundId,approver,'复核原票实付500元')
        await refunds.beginExecution(approved.id)
        const receipt = {refundPublicId:approved.publicId,provider:'postar' as const,providerRefundId:'FULL-'+approved.id,
          originalProviderTransactionId:'twotix-'+pay.id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true}
        expect((await refunds.completeProviderExecution(receipt)).applied).toBe(true)
        expect((await refunds.completeProviderExecution(receipt)).applied).toBe(false)
      }
      const activeBill = async()=>(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1 AND superseded_at IS NULL',[personal.caseId])).rows[0].id
      const propose = (customerMinor:number,merchantMinor:number,reason:string)=>proposeTicketDining(tx,personal.caseId,employee,reason,{customerMinor,merchantMinor})
      await expect(propose(50000,4999,'原餐单人工核定')).rejects.toThrow('合计')
      await propose(0,55000,'个人退票，经核定全额由门店承担')
      const zeroBill=await activeBill()
      await tx.query('SAVEPOINT zero_personal_due')
      await planTicketCashRefund(tx,personal.caseId,employee,50000)
      expect(await processTicketRefundReviews(tx)).toMatchObject({submitted:0})
      await consentTicketDining(tx,zeroBill,buyer)
      await expect(collectDining(meal.id,tx)).rejects.toThrow('no outstanding balance')
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:1,exceptions:0})
      const zeroRefund=(await tx.query('SELECT refund_id AS "refundId" FROM mbox.table_ticket_refund_requests WHERE id=$1',[personal.caseId])).rows[0]!
      await confirmedRefund(zeroRefund.refundId)
      expect((await mealPayments()).rows).toEqual([])
      await tx.query('ROLLBACK TO SAVEPOINT zero_personal_due')

      const basis='按本场售出条款及原菜品凭证核定，顾客补500元，门店承担50元'
      const splitKey=randomUUID(), split={customerMinor:50000,merchantMinor:5000}
      expect((await staff.proposeTicketDining(context,personal.caseId,basis,splitKey,split)).value.amountMinor).toBe(50000)
      expect((await staff.proposeTicketDining(context,personal.caseId,basis,splitKey,split)).replayed).toBe(true)
      const bill=await activeBill()
      expect(bill).not.toBe(zeroBill)
      await expect(consentTicketDining(tx,zeroBill,buyer)).rejects.toThrow()
      await expect(consentTicketDining(tx,bill,randomUUID())).rejects.toThrow()
      await expect(collectDining(meal.id,tx)).rejects.toThrow('no outstanding balance')
      expect(await processTicketRefundReviews(tx)).toMatchObject({submitted:0})
      expect((await ticketDiningHandoffs(tx)).some(r=>r.caseId===personal.caseId)).toBe(false)
      expect((await consentTicketDining(tx,bill,buyer)).amountMinor).toBe(50000)
      expect((await ticketDiningHandoffs(tx)).filter(r=>r.caseId===personal.caseId)).toMatchObject([{step:'collect',amount:'50000'}])
      const mealBalance=async()=>(await tx.query(`WITH ${orderCollectionBalancesCtesSql}
        SELECT amount,effective_minor FROM collection_balances WHERE id=$3`,[scope.tenantId,scope.storeId,meal.id])).rows[0]
      expect(await mealBalance()).toEqual({amount:'50000',effective_minor:'50000'})

      await expect(submitTicketCashRefund(tx,personal.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_DINING_REVIEW_REQUIRED'})
      const cashier=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization())
      const cashCommand={scope,actor:{type:'employee' as const,employeeId:employee},businessDate:dayBefore.day,idempotencyKey:randomUUID(),
        requestFingerprint:randomUUID(),publicId:randomUUID(),orderId:meal.id,provider:'cash' as const,method:'cash' as const,
        evidence:{receiptReference:randomUUID(),collectedByEmployeeId:employee}}
      expect(await processTicketRefundReviews(tx)).toMatchObject({submitted:0})
      const supplement=(await cashier.recordManual(cashCommand)).value
      await expect(submitTicketCashRefund(tx,personal.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_AUTO_REVIEW_PLANNED'})
      await tx.query('SAVEPOINT merchant_assumes_collected_supplement')
      const venueCash=await staff.submitTicketRefund(context,personal.caseId,50000,'门店取消，退原票并承担全部550元菜款',randomUUID())
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:0,exceptions:0})
      await confirmedRefund(venueCash.value.refundId)
      const returns=(await tx.query<{id:string;amount_minor:string}>("SELECT id,amount_minor FROM mbox.refunds WHERE payment_id=$1 AND status='requested'",[supplement.id])).rows
      expect(returns).toMatchObject([{amount_minor:'50000'}])
      const diningBack=returns[0]!.id,repo=new RefundRepository(tx)
      await repo.approve(diningBack,approver,'独立核对原餐单补款')
      await repo.beginExecution(diningBack)
      await repo.completeManualExecution({refundId:diningBack,succeeded:true,receiptReference:'DINING-'+diningBack})
      await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:meal.id,paymentId:supplement.id,refundId:diningBack,occurredAt:new Date().toISOString()})
      expect((await ticketFinanceDay(tx,dayBefore.day)).amounts).toMatchObject({
        ticketRefund:String(Number(dayBefore.amounts.ticketRefund??0)+50000),
        merchantDining:String(Number(dayBefore.amounts.merchantDining??0)+55000),
        diningCash:String(Number(dayBefore.amounts.diningCash??0)+50000),
        diningRefund:String(Number(dayBefore.amounts.diningRefund??0)+50000),
        diningRewardReverse:String(Number(dayBefore.amounts.diningRewardReverse??0)-50),
      })
      await tx.query('ROLLBACK TO SAVEPOINT merchant_assumes_collected_supplement')
      await tx.query('SAVEPOINT missing_request_permission')
      await tx.query('RESET ROLE')
      await tx.query(`DELETE FROM mbox.employee_roles e USING mbox.role_permission_assignments a,mbox.staff_permission_definitions d
        WHERE (e.tenant_id,e.store_id,e.employee_id)=($1,$2,$3) AND (a.tenant_id,a.store_id,a.role_id)=(e.tenant_id,e.store_id,e.role_id)
          AND (d.tenant_id,d.store_id,d.id)=(a.tenant_id,a.store_id,a.permission_id) AND d.code='refund.request'`,[scope.tenantId,scope.storeId,employee])
      await tx.query('SET LOCAL ROLE mbox_runtime')
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:0,exceptions:1})
      expect((await ticketDiningHandoffs(tx)).filter(row=>row.caseId===personal.caseId)).toMatchObject([{step:'issue'}])
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:0,exceptions:0})
      expect((await mealPayments()).rowCount).toBe(1)
      await tx.query('ROLLBACK TO SAVEPOINT missing_request_permission')
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:1,exceptions:0})
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:0,exceptions:0})
      expect((await ticketDiningHandoffs(tx)).filter(r=>r.caseId===personal.caseId)).toEqual([])
      expect(supplement.amountMinor).toBe(50000)
      expect(await mealBalance()).toEqual({amount:'0',effective_minor:'50000'})
      expect((await cashier.recordManual(cashCommand)).replayed).toBe(true)
      await expect(collectDining(meal.id,tx)).rejects.toThrow('no outstanding balance')
      const rewardBeforeRefund=await tx.query('SELECT eligible_amount_minor,awarded_points,awarded_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[meal.id])
      expect(rewardBeforeRefund.rows).toEqual([{eligible_amount_minor:'50000',awarded_points:50,awarded_growth:500}])
      const pending=await tx.query(`SELECT r.id AS "refundId",r.status,r.amount_minor,r.requested_by_employee_id,r.approved_by_employee_id,r.provider_snapshot
        FROM mbox.refunds r JOIN mbox.table_ticket_refund_requests f ON f.refund_id=r.id WHERE f.id=$1`,[personal.caseId])
      expect(pending.rows).toMatchObject([{status:'requested',amount_minor:'50000',requested_by_employee_id:employee,approved_by_employee_id:null,provider_snapshot:{submittedAfterDiningCollection:true}}])
      const personalCash=pending.rows[0]!
      await tx.query('SAVEPOINT two_tickets_in_review')
      const otherCase=await requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'同单第二张票申请退票')
      const otherCash=await submitTicketCashRefund(tx,otherCase.caseId,employee,50000,null)
      const myQueue=async(id:string)=>(await ticketRefundReviewQueue(tx,id)).filter(row=>[originalTicket,tickets[1].id].includes(row.ticketId))
      expect(await myQueue(employee)).toEqual([])
      expect((await myQueue(approver)).map(row=>row.refundId).sort()).toEqual([personalCash.refundId,otherCash.refundId].sort())
      await confirmedRefund(otherCash.refundId)
      expect(await myQueue(approver)).toMatchObject([{refundId:personalCash.refundId,automatic:true,amountMinor:50000}])
      await tx.query('ROLLBACK TO SAVEPOINT two_tickets_in_review')
      await confirmedRefund(personalCash.refundId)
      expect((await submitTicketCashRefund(tx,personal.caseId,employee,50000,null)).refundId).toBe(personalCash.refundId)
      const account=await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])
      expect(account.rows).toEqual([{available_points:600}])
      expect((await lots()).rows).toEqual([{remaining_points:0,status:'reversed'},{remaining_points:550,status:'available'}])
      const statementAfter=await ticketStatement(tx,originalTicket)
      expect(statementAfter.dining).toMatchObject([{amountMinor:'50000',merchantMinor:'5000',reason:basis,paymentStatus:'succeeded'}])
      expect(statementAfter.refunds).toMatchObject([{cashStatus:'succeeded',cashMinor:'50000'}])
      expect(statementAfter.points.map(entry=>entry.delta)).toEqual([550,-550])
      const afterDay=(await ticketFinanceDay(tx,dayBefore.day)).amounts
      expect(afterDay).toEqual({...dayBefore.amounts,
        ticketRefund:String(Number(dayBefore.amounts.ticketRefund??0)+50000),
        diningCash:String(Number(dayBefore.amounts.diningCash??0)+50000),
        diningRewardEarn:String(Number(dayBefore.amounts.diningRewardEarn??0)+50),
        merchantDining:String(Number(dayBefore.amounts.merchantDining??0)+5000)})
      const caps=(await tx.query("SELECT provider_snapshot->'ticketDiningItemCaps' AS caps FROM mbox.payments WHERE id=$1",[supplement.id])).rows[0].caps
      const item=meal.items[0]!.id
      expect(caps).toEqual({[item]:50000})
      const foodRefunds=new RefundRepository(tx)
      const returned=await foodRefunds.request({purpose:'return_goods',paymentId:supplement.id,publicId:'SPLIT-'+randomUUID(),
        reason:'退票后退菜只退原补款',requestedByEmployeeId:employee,allocations:[{orderItemId:item,amountMinor:50000}]})
      await foodRefunds.approve(returned.id,approver,'核对原菜款实付')
      await foodRefunds.beginExecution(returned.id)
      await foodRefunds.completeManualExecution({refundId:returned.id,succeeded:true,receiptReference:'BACK-'+returned.id})
      await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:meal.id,paymentId:supplement.id,refundId:returned.id,occurredAt:new Date().toISOString()})
      expect((await tx.query('SELECT reversed_points,reversed_growth FROM mbox.loyalty_order_awards WHERE order_id=$1',[meal.id])).rows)
        .toEqual([{reversed_points:50,reversed_growth:500}])
      const returnedDay=(await ticketFinanceDay(tx,dayBefore.day)).amounts
      expect(returnedDay).toMatchObject({diningRefund:String(Number(afterDay.diningRefund??0)+50000),
        diningRewardReverse:String(Number(afterDay.diningRewardReverse??0)-50)})

      await tx.query('ROLLBACK TO SAVEPOINT personal_full_ticket')

      const merchant = await requestTicketRefund(tx,sale.id,originalTicket,buyer,'门店取消本场演出')
      expect(merchant.consumedMinor).toBe(55000)
      const cash = await submitTicketCashRefund(tx,merchant.caseId,employee,50000,'门店承担本次全部已用赠分菜款550元')
      expect(await processTicketRefundReviews(tx)).toEqual({submitted:0,exceptions:0})
      expect((await mealPayments()).rowCount).toBe(0)
      await confirmedRefund(cash.refundId)
      expect((await tx.query('SELECT payment_id,amount_minor,status FROM mbox.refunds WHERE payment_id=$1',[pay.id])).rows)
        .toEqual([{payment_id:pay.id,amount_minor:'50000',status:'succeeded'}])
      const statement = await ticketStatement(tx,originalTicket)
      expect(statement.ticket).toMatchObject({priceMinor:50000,giftPoints:550})
      expect(statement.refunds).toMatchObject([{status:'refunded',cashMinor:'50000',cashStatus:'succeeded'}])
      expect(statement.dining).toEqual([])
      const expectedDaily = {...dayBefore.amounts,merchantDining:String(Number(dayBefore.amounts.merchantDining??0)+55000),ticketRefund:String(Number(dayBefore.amounts.ticketRefund??0)+50000)}
      expect((await ticketFinanceDay(tx,dayBefore.day)).amounts).toEqual(expectedDaily)
      expect(statement.points.map(m=>m.delta)).toEqual([550,-550])
      expect((await mealPayments()).rows).toEqual([])
      expect((await lots()).rows).toEqual([{remaining_points:0,status:'reversed'},{remaining_points:550,status:'available'}])
      const balance = await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])
      expect(balance.rows).toEqual([{available_points:550}])
      const reward = await tx.query('SELECT coalesce(sum(awarded_points-reversed_points+restored_points),0)::int points FROM mbox.loyalty_order_awards WHERE order_id=$1',[meal.id])
      expect(reward.rows).toEqual([{points:0}])
      await tx.query('ROLLBACK TO SAVEPOINT full_ticket_meal')
    })
    const existingCredential=(await admin.query('SELECT id FROM mbox.store_daily_credentials WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL AND business_date=current_date',args)).rows[0]
    const credentialId=existingCredential?.id??randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID()
    if(!existingCredential)await admin.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$closure-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,...args,employee])
    await admin.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,$5,$6,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,...args,credentialId,createHash('sha256').update(randomUUID()).digest('hex'),createHash('sha256').update(randomUUID()).digest('hex')])
    await admin.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,...args,employee,leaseId,createHash('sha256').update(randomUUID()).digest('hex')])
    const binding={employeeId:employee,staffSessionId,deviceAccessLeaseId:leaseId}
    const inventory=randomUUID(),recipe=randomUUID()
    await admin.query("INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($1::uuid,$2,$3,$1::text,'挂桌食材','ingredient','g')",[inventory,...args])
    await admin.query('INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity) VALUES($1,$2,$3,100)',[...args,inventory])
    await admin.query("INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($1,$2,$3,$4,1,'active',clock_timestamp()-interval '1 hour')",[recipe,...args,product])
    await admin.query('INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,1)',[...args,recipe,inventory])
    await run(async tx=>{
      await tx.query('SAVEPOINT old_placed_tab')
      await tx.query("UPDATE mbox.products SET fulfillment_station='kitchen' WHERE id=$1",[product])
      const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
      const context=await new AssistedOrderContextRepository(tx).issue({...binding,tableSessionId:session})
      const original=(await commerce.submitOrderInTransaction(tx,{scope,actor:{type:'employee',employeeId:employee},createdByEmployeeId:employee,assistedOrderContext:{...binding,token:context.token},
        businessDate:new Date().toISOString().slice(0,10),idempotencyKey:randomUUID(),publicId:'O'+randomUUID().replaceAll('-',''),
        tableSessionId:session,channel:'staff_assisted',settlementMode:'table_tab',lines:[{productId:product,quantity:1}]})).result.order
      const kitchen=async()=>(await tx.query('SELECT k.id FROM mbox.kds_tasks k JOIN mbox.order_items i ON i.id=k.order_item_id WHERE i.order_id=$1 ORDER BY k.id',[original.id])).rows
      const tasks=await kitchen()
      expect(tasks.length).toBeGreaterThan(0)
      await tx.query('SAVEPOINT tab_bundle')
      const root=randomUUID(),part=randomUUID()
      for(const [id,kind,price] of [[root,'bundle',26000],[part,'single',13000]] as const){
        await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode) VALUES($3::uuid,$1,$2,$3::text,'挂桌套餐验收','food',$4,'none','not_managed')",[...args,id,kind])
        await tx.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',$4,'CNY',now()-interval '1 hour')",[...args,id,price])
      }
      await tx.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,2,1)',[...args,root,part])
      const bundleContext=await new AssistedOrderContextRepository(tx).issue({...binding,tableSessionId:session})
      const tabBundle=(await commerce.submitOrderInTransaction(tx,{scope,actor:{type:'employee',employeeId:employee},createdByEmployeeId:employee,assistedOrderContext:{...binding,token:bundleContext.token},
        businessDate:new Date().toISOString().slice(0,10),idempotencyKey:randomUUID(),publicId:'O'+randomUUID().replaceAll('-',''),tableSessionId:session,
        channel:'staff_assisted',settlementMode:'table_tab',lines:[{productId:root,quantity:1}]})).result.order
      const discount=await offerTabPoints(tx,employee,tabBundle.publicId,'MBX-TWO-TABLES',200,randomUUID())
      await confirmTabPoints(tx,discount.id!,buyer)
      expect((await collectDining(tabBundle.id,tx)).amountMinor).toBe(6000)
      const bundleChild=tabBundle.items.find(i=>i.parentOrderItemId!==null)!
      const bundleReturn=await new ItemQuantityRepository(tx).hold({orderItemId:bundleChild.id,quantity:1,employeeId:employee,businessDate:'2026-11-23',kind:'paid_return',reason:'按套餐原快照退一份'})
      const price=(await tx.query('SELECT mbox.prepare_after_sales_price($1) priced',[bundleReturn.caseId])).rows[0].priced
      expect(price).toMatchObject({policy:'broken_bundle',refundAmountMinor:6000})
      expect(await new CheckoutPointsRepository(tx).casePoints(bundleReturn.caseId)).toMatchObject({approvalAmountMinor:20000})
      await tx.query('ROLLBACK TO SAVEPOINT tab_bundle')
      const preview=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',null,randomUUID())
      expect(preview.maximumPoints).toBe(260)
      await tx.query('SAVEPOINT historical_partial')
      const stale=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',240,randomUUID())
      const partial=randomUUID()
      await tx.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,status,succeeded_at)
        VALUES($3::uuid,$1,$2,$4,$3::text,'cash',$3::text,'cash',6000,'succeeded',clock_timestamp())`,[...args,partial,original.id])
      await expect(confirmTabPoints(tx,stale.id!,buyer)).rejects.toThrow(/变化/)
      const limited=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',null,randomUUID())
      expect(limited.maximumPoints).toBe(200)
      const all=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',200,randomUUID())
      await confirmTabPoints(tx,all.id!,buyer)
      expect((await tx.query('SELECT mbox.order_collection_due_amount($1,$2,$3)::int due',[...args,original.id])).rows[0].due).toBe(0)
      expect((await tx.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[original.id])).rows[0].payment_status).toBe('paid')
      expect((await tx.query('SELECT count(*)::int n FROM mbox.order_payment_facts WHERE order_id=$1',[original.id])).rows[0].n).toBe(1)
      expect(await kitchen()).toEqual(tasks)
      const partialReturn=await requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'原账部分实收后用分')
      expect((await ticketDiningLines(tx,partialReturn.caseId)).map(l=>[l.priceMinor,l.usedMinor])).toEqual([[26000,20000]])
      expect((await tx.query('SELECT awarded_points FROM mbox.loyalty_order_awards WHERE order_id=$1',[original.id])).rows[0]?.awarded_points).toBe(6)
      await tx.query('ROLLBACK TO SAVEPOINT historical_partial')
      await tx.query('SAVEPOINT old_prepaid')
      // Seed a pre-existing prepaid table before re-entering the actual staff/customer runtime role.
      await tx.query('RESET ROLE')
      await tx.query("UPDATE mbox.table_sessions SET minimum_spend_mode='prepaid' WHERE id=$1",[session])
      await tx.query('SET LOCAL ROLE mbox_runtime')
      const funds=await new PaymentRepository(tx).createForTablePrepayment({tableSessionId:session,customerId:buyer,publicId:randomUUID(),amountMinor:10000,provider:'cash',method:'cash',manualEmployeeId:employee,evidence:{receiptReference:randomUUID(),collectedByEmployeeId:employee}})
      const prepaid=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',200,randomUUID())
      await confirmTabPoints(tx,prepaid.id!,buyer)
      expect((await new TablePrepaymentRepository(tx).snapshot(session))?.availableMinor).toBe(4000)
      expect((await tx.query('SELECT payment_id,amount_minor::int amount FROM mbox.table_prepayment_allocations WHERE order_id=$1',[original.id])).rows).toEqual([{payment_id:funds.id,amount:6000}])
      expect((await tx.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1',[original.id])).rows[0].n).toBe(0)
      expect(await kitchen()).toEqual(tasks)
      await tx.query('ROLLBACK TO SAVEPOINT old_prepaid')
      await tx.query('SAVEPOINT confirmed_closed_tab')
      await tx.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[original.id])
      await tx.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp(),closed_by_employee_id=$2 WHERE id=$1",[session,employee])
      expect((await tx.query('SELECT eligibility FROM mbox.order_carryover_debts WHERE order_id=$1',[original.id])).rows[0]?.eligibility).toBe('confirmed')
      const closedOffer=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',260,randomUUID())
      await confirmTabPoints(tx,closedOffer.id!,buyer)
      expect((await tx.query('SELECT payment_status FROM mbox.orders WHERE id=$1',[original.id])).rows[0].payment_status).toBe('paid')
      expect((await tx.query('SELECT count(*)::int n FROM mbox.order_payment_facts WHERE order_id=$1',[original.id])).rows[0].n).toBe(0)
      expect(await kitchen()).toEqual(tasks)
      expect((await tx.query('SELECT h.status FROM mbox.checkout_point_holds h JOIN mbox.checkout_coupon_order_links k USING(quote_id) WHERE k.order_id=$1',[original.id])).rows[0].status).toBe('consumed')
      await tx.query('ROLLBACK TO SAVEPOINT confirmed_closed_tab')
      const previous=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',199,randomUUID())
      const offer=await offerTabPoints(tx,employee,original.publicId,'MBX-TWO-TABLES',200,randomUUID())
      await expect(confirmTabPoints(tx,previous.id!,buyer)).rejects.toThrow(/已变化/)
      await tx.query('SAVEPOINT authority_revoked')
      await tx.query('RESET ROLE')
      await tx.query('UPDATE mbox.employee_roles SET ends_at=clock_timestamp() WHERE employee_id=$1 AND ends_at IS NULL',[employee])
      await tx.query('SET LOCAL ROLE mbox_runtime')
      await expect(confirmTabPoints(tx,offer.id!,buyer)).rejects.toThrow()
      await tx.query('ROLLBACK TO SAVEPOINT authority_revoked')
      await expect(confirmTabPoints(tx,offer.id!,randomUUID())).rejects.toThrow()
      await confirmTabPoints(tx,offer.id!,buyer)
      await confirmTabPoints(tx,offer.id!,buyer)
      expect((await collectDining(original.id,tx)).amountMinor).toBe(6000)
      expect(await kitchen()).toEqual(tasks)
      expect((await tx.query('SELECT awarded_points FROM mbox.loyalty_order_awards WHERE order_id=$1',[original.id])).rows[0]?.awarded_points).toBe(6)
      const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[original.id])).rows
      expect(item).toHaveLength(1)
      await tx.query('SAVEPOINT old_tab_food_return')
      const returned=await new ItemQuantityRepository(tx).hold({orderItemId:item[0].id,quantity:1,employeeId:employee,businessDate:'2026-11-23',kind:'paid_return',reason:'退挂桌原菜'})
      expect((await tx.query('SELECT mbox.prepare_after_sales_price($1) priced',[returned.caseId])).rows[0].priced).toMatchObject({refundAmountMinor:6000,selectedOriginalMinor:6000})
      expect(await new CheckoutPointsRepository(tx).casePoints(returned.caseId)).toMatchObject({approvalAmountMinor:20000})
      await tx.query('ROLLBACK TO SAVEPOINT old_tab_food_return')
      const f=await requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'挂桌抵扣来源')
      expect(f.consumedMinor).toBe(20000)
      expect((await ticketDiningLines(tx,f.caseId)).map(l=>[l.priceMinor,l.usedMinor])).toEqual([[26000,20000]])
      await tx.query('ROLLBACK TO SAVEPOINT old_placed_tab')
    })
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
      expect((await ticketStatement(tx,tickets[1].id)).originalDishes.reduce((total,line)=>total+line.usedMinor,0)).toBe(15000)
      expect(await ticketRefundPreview(tx,tickets[1].id)).toMatchObject([{id:tickets[1].id,ordinal:2,priceMinor:50000,consumedMinor:'15000',caseId:null}])
      await expect(requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'旧预览','0'.repeat(64))).rejects.toMatchObject({code:'TICKET_PREVIEW_CHANGED'})
      const [snapshot]=await ticketRefundPreview(tx,tickets[1].id)
      const f=await requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'退共用同份菜的第二票',snapshot!.previewVersion)
      expect(f.consumedMinor).toBe(15000)
      expect((await ticketDiningLines(tx,f.caseId)).reduce((n,l)=>n+l.usedMinor,0)).toBe(15000)
      await proposeTicketDining(tx,f.caseId,employee,'核对三份菜中第二票150元')
      const bill=(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
      await consentTicketDining(tx,bill,buyer)
      expect((await collectDining(meal.id,tx)).amountMinor).toBe(15000)
      const first=await requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'再核对已用完的第一票')
      expect(first.consumedMinor).toBe(55000)
      await expect(proposeTicketDining(tx,first.caseId,employee,'已超过票款须人工核定')).rejects.toMatchObject({code:'TICKET_DINING_REVIEW'})
      await proposeTicketDining(tx,first.caseId,employee,'逐份按原抵扣比例分摊，尾差按分结清',{customerMinor:49999,merchantMinor:5001})
      const apportioned=(await tx.query(`SELECT amount_minor,merchant_minor,line_snapshot FROM mbox.ticket_dining_collections
        WHERE case_id=$1 AND superseded_at IS NULL`,[first.caseId])).rows[0]
      expect(apportioned).toMatchObject({amount_minor:'49999',merchant_minor:'5001'})
      const portions=apportioned.line_snapshot as {customerMinor:number;usedMinor:number}[]
      expect(portions.length).toBe(3)
      expect(portions.reduce((sum,line)=>sum+line.customerMinor,0)).toBe(49999)
      expect(portions.every(line=>Number.isSafeInteger(line.customerMinor) && line.customerMinor<=line.usedMinor)).toBe(true)
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
    // Independent staff orders and independent member confirmations compete for the same remaining 550 points.
    const pendingTabs=[]
    for (let i=0;i<2;i++){
      pendingTabs.push(await run(async tx=>{
        const context=await new AssistedOrderContextRepository(tx).issue({...binding,tableSessionId:session})
        const service=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
        const order=(await service.submitOrderInTransaction(tx,{scope,actor:{type:'employee',employeeId:employee},createdByEmployeeId:employee,assistedOrderContext:{...binding,token:context.token},businessDate:'2026-11-23',
          idempotencyKey:randomUUID(),publicId:'O'+randomUUID().replaceAll('-',''),tableSessionId:session,channel:'staff_assisted',settlementMode:'table_tab',lines:[{productId:product,quantity:3,note:String(i)}]})).result.order
        return (await offerTabPoints(tx,employee,order.publicId,'MBX-TWO-TABLES',550,randomUUID())).id!
      }))
    }
    const attempts=await Promise.allSettled(pendingTabs.map(id=>run(tx=>confirmTabPoints(tx,id,buyer))))
    expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1)
    expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1)
    expect((await admin.query("SELECT sum(points)::int pts FROM mbox.tab_points_requests WHERE id=ANY($1::uuid[]) AND state='applied'",[pendingTabs])).rows[0].pts).toBe(550)
  })
  it('reconciles two ticket sources and a dish refund in all six chronological orders',{timeout:20_000},async()=>{
    const args=[scope.tenantId,scope.storeId],buyer=randomUUID(),member=randomUUID(),extra=randomUUID()
    await admin.query("INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($3::uuid,$1,$2,$3::text)",[...args,buyer])
    await admin.query("INSERT INTO mbox.customer_memberships(id,tenant_id,store_id,customer_id,member_no) VALUES($3,$1,$2,$4,'MBX-REFUND-MATRIX')",[...args,member,buyer])
    await admin.query("INSERT INTO mbox.loyalty_accounts(tenant_id,store_id,membership_id,customer_id) VALUES($1,$2,$3,$4)",[...args,member,buyer])
    const phone=protection.protectPhone('+8613800000002')
    await runner.run(scope,tx=>tx.query(`INSERT INTO mbox.customer_verified_contacts(tenant_id,store_id,public_id,customer_id,contact_type,contact_hash,encrypted_value,encryption_key_version,
      contact_encryption_key_id,masked_value,verification_source,verified_by_customer_id,provider_reference_sha256,verified_at)
      VALUES($1,$2,$3,$4,'phone',$5,$6,1,$7,'138****0002','wechat_phone_authorization',$4,repeat('f',64),clock_timestamp())`,
      [...args,'CVC'+randomUUID().replaceAll('-','').toUpperCase(),buyer,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId]))
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'MATRIX','卡座','indoor')",[...args,extra])
    await admin.query("INSERT INTO mbox.tables(tenant_id,store_id,area_id,code,display_name,capacity) SELECT $1,$2,$3,'MATRIX'||n,'卡座'||n,6 FROM generate_series(1,3) n",[...args,extra])
    const offer=await run(tx=>saveTicketOffer(tx,activity,employee,{...offerInput,areaId:extra,giftPoints:150}))
    const terms=(await run(publicTableTickets)).find(row=>row.id===offer.id)!
    const sale=await run(tx=>buyTableTickets(tx,buyer,{offerId:offer.id,quantity:2,safetyVersion:'activity-safety-v1',refundVersion:terms.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
    const pay=(await admin.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='twotix-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id,succeeded_at",[sale.id])).rows[0]
    await run(tx=>new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:pay.id,activityRegistrationId:sale.id,payableKind:'activity_registration',amountMinor:100000,succeededAt:pay.succeeded_at.toISOString(),status:'succeeded'}))
    const tickets=(await admin.query('SELECT id,point_lot_id FROM mbox.table_tickets WHERE registration_id=$1 ORDER BY ordinal',[sale.id])).rows
    const physical=(await admin.query("SELECT id FROM mbox.tables WHERE tenant_id=$1 AND code='MATRIX1'",[scope.tenantId])).rows[0].id
    const session=(await run(tx=>tx.query(`INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($1,$2,$3,$4,current_date,1,6,'open',$5,$5) RETURNING id`,[...args,physical,randomUUID(),employee]))).rows[0].id
    const product=(await admin.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id) VALUES($1,$2,$3,$4)",[...args,session,buyer])
    const ref=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:buyer})

    const reviewer=(await admin.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
    await run(async tx=>{
      await tx.query('SAVEPOINT earlier_regular_points')
      const ordinary=(await tx.query("INSERT INTO mbox.loyalty_point_lots(tenant_id,store_id,membership_id,customer_id,source_type,source_id,original_points,remaining_points,available_at,expires_at) VALUES($1,$2,$3,$4,'legacy_balance','regular-fifo',1,1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 month') RETURNING id,expires_at::text",[...args,member,buyer])).rows[0]
      await tx.query('UPDATE mbox.loyalty_accounts SET available_points=available_points+1 WHERE membership_id=$1',[member])
      await tx.query('UPDATE mbox.customer_memberships SET points_balance=points_balance+1 WHERE id=$1',[member])
      const single=await staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:product,quantity:1}],2)
      const mixed=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},single.id!)
      await placeDining(session,buyer,ref,mixed,tx)
      expect((await tx.query('SELECT lot_id,points FROM mbox.checkout_point_lots WHERE quote_id=$1',[mixed.quote.id])).rows).toEqual(expect.arrayContaining([{lot_id:ordinary.id,points:1},{lot_id:tickets[0].point_lot_id,points:1}]))
      expect((await tx.query('SELECT expires_at::text FROM mbox.loyalty_point_lots WHERE id=$1',[ordinary.id])).rows[0].expires_at).toBe(ordinary.expires_at)
      await tx.query('ROLLBACK TO SAVEPOINT earlier_regular_points')
      await tx.query('SAVEPOINT fractional_return')
      const pair=await staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:product,quantity:1,note:'一号'},{productId:product,quantity:1,note:'二号'}],1)
      const quote=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},pair.id!)
      const paired=await placeDining(session,buyer,ref,quote,tx)
      const pairedCash=await collectDining(paired.id,tx)
      const items=(await tx.query('SELECT id,total_amount_minor::int paid,discount_amount_minor::int discount FROM mbox.order_items WHERE order_id=$1 ORDER BY id',[paired.id])).rows
      expect(items.map(i=>[i.paid,i.discount])).toEqual([[25950,50],[25950,50]])
      for(const ordered of [items,[...items].reverse()]){
        await tx.query('SAVEPOINT fractional_order')
        const foodRefund=new RefundRepository(tx),points=new CheckoutPointsRepository(tx)
        for(const [idx,part] of ordered.entries()){
          const refund=await foodRefund.request({purpose:'return_goods',paymentId:pairedCash.id,publicId:randomUUID(),reason:'按原份次退菜',requestedByEmployeeId:employee,allocations:[{orderItemId:part.id,amountMinor:part.paid}]})
          await foodRefund.approve(refund.id,reviewer,'退原菜品');await foodRefund.beginExecution(refund.id)
          await foodRefund.completeManualExecution({refundId:refund.id,succeeded:true,receiptReference:randomUUID()})
          await points.restoreRefund(paired.id,refund.id)
          expect((await tx.query('SELECT restored_points FROM mbox.checkout_point_holds WHERE quote_id=$1',[quote.quote.id])).rows[0].restored_points).toBe(idx)
          expect(await points.restoreRefund(paired.id,refund.id)).toBe(0)
          if(idx===0){
            await tx.query('SAVEPOINT half_ticket')
            const ticket=await requestTicketRefund(tx,sale.id,tickets[0].id,buyer,'只退过一份菜')
            expect(ticket.consumedMinor).toBe(50)
            await tx.query('ROLLBACK TO SAVEPOINT half_ticket')
          }
        }
        await tx.query('ROLLBACK TO SAVEPOINT fractional_order')
      }
      await tx.query('ROLLBACK TO SAVEPOINT fractional_return')
      await tx.query('SAVEPOINT main_mixed_meal')
      const proposal=await staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:product,quantity:1}],200)
      const adopted=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},proposal.id!)
      const meal=await placeDining(session,buyer,ref,adopted,tx)
      const original=await collectDining(meal.id,tx)
      expect(original.amountMinor).toBe(6000)
      const item=(await tx.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[meal.id])).rows[0].id
      const repo=new RefundRepository(tx)
      for(const sequence of ['ABD','ADB','DAB','BAD','BDA','DBA']){
        await tx.query('SAVEPOINT mixed_return_order')
        const receipts=[original]
        let returned=false
        for(const action of sequence){
          if(action==='D'){
            for(const paid of receipts){
              const food=await repo.request({purpose:'return_goods',paymentId:paid.id,publicId:randomUUID(),reason:'原菜品全退',
                requestedByEmployeeId:employee,allocations:[{orderItemId:item,amountMinor:paid.amountMinor}]})
              await repo.approve(food.id,reviewer,'核对原单与该笔实付')
              await repo.beginExecution(food.id)
              await repo.completeManualExecution({refundId:food.id,succeeded:true,receiptReference:randomUUID()})
              await new CheckoutPointsRepository(tx).restoreRefund(meal.id,food.id)
              await new LoyaltyAccrualRepository(tx).reverseSucceededRefund({orderId:meal.id,paymentId:paid.id,refundId:food.id,occurredAt:new Date().toISOString()})
            }
            returned=true
          }else{
            const ticket=tickets[action==='A'?0:1]
            const f=await requestTicketRefund(tx,sale.id,ticket.id,buyer,'原票单张退票')
            expect(f.consumedMinor,sequence+action).toBe(returned?0:action==='A'?15000:5000)
            if(f.consumedMinor){
              await proposeTicketDining(tx,f.caseId,employee,'按本票原抵扣补收')
              const bill=(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[f.caseId])).rows[0].id
              await consentTicketDining(tx,bill,buyer)
              const receipt=await collectDining(meal.id,tx)
              expect(receipt.amountMinor).toBe(f.consumedMinor)
              receipts.push(receipt)
            }
            const cash=await submitTicketCashRefund(tx,f.caseId,employee,50000,null)
            const approved=await repo.approve(cash.refundId,reviewer,'单票退款')
            await repo.beginExecution(cash.refundId)
            await repo.completeProviderExecution({refundPublicId:approved.publicId,provider:'postar',providerRefundId:randomUUID(),
              originalProviderTransactionId:'twotix-'+pay.id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
          }
        }
        if(sequence==='ABD'){
          await tx.query('SAVEPOINT checkout_dates')
          // Seed receipts on opposite sides of the Shanghai 06:00 cutoff, after the actual workflow has run.
          await tx.query('RESET ROLE')
          await tx.query("UPDATE mbox.stores SET timezone='Asia/Shanghai',business_day_cutoff='06:00' WHERE id=$1",[scope.storeId])
          await tx.query("UPDATE mbox.payments SET succeeded_at='2026-10-20 05:59:59+08' WHERE id IN($1,$2)",[original.id,pay.id])
          await tx.query("UPDATE mbox.payments SET succeeded_at='2026-10-20 06:00:00+08' WHERE id=$1 OR id=$2",[receipts[1]!.id,receipts[2]!.id])
          await tx.query("UPDATE mbox.refunds SET completed_at='2026-10-20 06:00:01+08' WHERE payment_id=ANY($1::uuid[])",[[original.id,pay.id,...receipts.slice(1).map(r=>r.id)]])
          await tx.query('SET LOCAL ROLE mbox_runtime')
          expect((await ticketFinanceDay(tx,'2026-10-19')).amounts).toMatchObject({ticketCash:'100000',originalDiningCash:'6000'})
          expect((await ticketFinanceDay(tx,'2026-10-20')).amounts).toMatchObject({ticketRefund:'100000',diningCash:'20000',diningRefund:'20000',originalDiningRefund:'6000'})
          await tx.query('ROLLBACK TO SAVEPOINT checkout_dates')
        }
        const refunded=(await tx.query("SELECT sum(amount_minor)::int amount FROM mbox.order_refund_facts WHERE order_id=$1 AND status='succeeded'",[meal.id])).rows[0].amount
        expect(refunded,sequence).toBe(receipts.reduce((sum,r)=>sum+r.amountMinor,0))
        expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])).rows[0].available_points,sequence).toBe(0)
        expect((await tx.query('SELECT count(*)::int n FROM mbox.table_tickets WHERE registration_id=$1 AND refunded_at IS NOT NULL',[sale.id])).rows[0].n).toBe(2)
        await tx.query('ROLLBACK TO SAVEPOINT mixed_return_order')
      }
      await tx.query('ROLLBACK TO SAVEPOINT main_mixed_meal')
    })
    await admin.query("UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1",[product])
    const control=new LoyaltyOperationalControlService(runner,new NormalizedCommandExecutor(runner))
    await grantFixtureStaffPermissions(admin,scope,[employee],['loyalty.operations.control'])
    const operator={scope,employeeId:employee,businessDate:'2026-11-23'}
    const paused=await control.set(operator,{capability:'points_redemption',operation:'pause',reason:'隔离暂停新增用分',expectedVersion:0,reviewAt:null,idempotencyKey:randomUUID()})
    await expect(run(tx=>staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:product,quantity:1}],260))).rejects.toThrow('暂停')
    expect((await run(tx=>ticketStatement(tx,tickets[0].id))).ticket.priceMinor).toBe(50000)
    await control.set(operator,{capability:'points_redemption',operation:'resume',reason:'恢复隔离用分',expectedVersion:paused.value.version,reviewAt:null,idempotencyKey:randomUUID()})
    const bundle=randomUUID(),component=randomUUID()
    for(const [id,code,kind,price] of [[bundle,'MIXEDBUNDLE','bundle',26000],[component,'MIXEDPART','single',13000]] as const){
      await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,product_kind,fulfillment_station,inventory_control_mode) VALUES($3,$1,$2,$4,$4,'food',$5,'none','not_managed')",[...args,id,code,kind])
      await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',$4,'CNY',clock_timestamp()-interval '1 day')",[...args,id,price])
    }
    await admin.query('INSERT INTO mbox.product_bundle_components(tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order) VALUES($1,$2,$3,$4,2,1)',[...args,bundle,component])
    const paidWithPoints=await run(async tx=>{
      const proposal=await staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:bundle,quantity:1}],260)
      const quote=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},proposal.id!)
      const order=await placeDining(session,buyer,ref,quote,tx)
      await new PaymentRepository(tx).syncOrderPaymentStatus(order.id)
      await new PaymentFulfillmentRepository(tx).activatePaidOrder(order.id)
      await new CheckoutPointsRepository(tx).consume(order.id)
      return order
    })
    // Advance the second ticket's batch past its anniversary after 110 of its 150 points funded the dish.
    await admin.query("UPDATE mbox.loyalty_point_lots SET available_at=clock_timestamp()-interval '1 year 2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[tickets[1].point_lot_id])
    const expiry=new LoyaltyPointsExpiryWorker(runner)
    expect(await expiry.runBatch(scope,'ticket-expiry-check')).toMatchObject({expiredPoints:40,expiredLots:1})
    expect(await expiry.runBatch(scope,'ticket-expiry-check')).toMatchObject({expiredPoints:0})
    await run(async tx=>{
      const f=await requestTicketRefund(tx,sale.id,tickets[1].id,buyer,'部分用分后到期')
      expect(f.consumedMinor).toBe(11000)
      expect((await tx.query('SELECT frozen_points FROM mbox.table_ticket_refund_requests WHERE id=$1',[f.caseId])).rows[0].frozen_points).toBe(0)
      await decideTicketCase(tx,tickets[1].id,{customer:buyer},'cancelled','原票保留核实餐饮')
    })
    await grantFixtureStaffPermissions(admin,scope,[employee,reviewer],['refund.request','refund.approve','refund.execute'])
    await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) SELECT tenant_id,store_id,role_id,'refund.approve',100000,'CNY' FROM mbox.employee_roles WHERE employee_id=$1 ON CONFLICT DO NOTHING",[reviewer])
    const returns=new ItemAfterSalesCommandService(new NormalizedCommandExecutor(runner),new ItemAfterSalesOperatingEffects())
    const operation={scope,businessDate:new Date().toISOString().slice(0,10),reason:'零实付退回整份菜',employeeId:employee}
    const child=paidWithPoints.items.find(i=>i.parentOrderItemId!==null)!
    for(const count of [1,2]){
      const ask=await returns.request({...operation,idempotencyKey:randomUUID(),orderItemId:child.id,quantity:1})
      const decision=await returns.decide({...operation,caseId:ask.value.caseId,idempotencyKey:randomUUID(),employeeId:reviewer,decision:'approved'})
      expect(decision.value.stoppedQuantity).toBe(1)
      const total=(await admin.query('SELECT sum(s.returned_minor)::int returned FROM mbox.checkout_coupon_order_links l CROSS JOIN LATERAL mbox.checkout_returned_sources(l.tenant_id,l.store_id,l.quote_id) s WHERE l.order_id=$1',[paidWithPoints.id])).rows[0].returned
      expect(total).toBe(count*13000)
    }
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1',[paidWithPoints.id])).rows[0].n).toBe(0)
    await run(async tx=>{
      expect((await tx.query('SELECT status,remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[tickets[1].point_lot_id])).rows[0]).toEqual({status:'expired',remaining_points:0})
      expect((await tx.query('SELECT available_points FROM mbox.loyalty_accounts WHERE membership_id=$1',[member])).rows[0].available_points).toBe(150)
      for(const ticket of tickets){
        const f=await requestTicketRefund(tx,sale.id,ticket.id,buyer,'已退全部零实付菜')
        expect(f.consumedMinor).toBe(0)
      }
    })
  })
  it('keeps one refund of the supplement when its capture overlaps the ticket refund',async()=>{
    const fixture=(await admin.query(`SELECT k.id AS ticket,k.registration_id,k.payment_id,m.customer_id AS buyer,s.table_session_id AS session,
      p.provider_transaction_id FROM mbox.customer_memberships m JOIN mbox.table_session_customers s USING(tenant_id,store_id,customer_id)
      JOIN mbox.table_ticket_purchases b ON (b.tenant_id,b.store_id,b.membership_id)=(m.tenant_id,m.store_id,m.id)
      JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.registration_id)=(b.tenant_id,b.store_id,b.registration_id)
      JOIN mbox.payments p ON p.id=k.payment_id WHERE m.tenant_id=$1 AND m.member_no='MBX-REFUND-MATRIX' AND k.ordinal=1`,[scope.tenantId])).rows[0]!
    const {ticket,registration_id:registration,buyer,session}=fixture
    const product=(await admin.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
    const reviewer=(await admin.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
    await run(tx=>decideTicketCase(tx,ticket,{customer:buyer},'cancelled','保留原票后重新消费'))
    const ref=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:buyer})
    const {attempt,refund}=await run(async tx=>{
      const proposal=await staffPointsProposal(tx,employee,session,'MBX-REFUND-MATRIX',[{productId:product,quantity:1}],100)
      const quote=await adoptAssistedPoints(tx,{customerId:buyer,tableSessionId:session,actorRef:ref},proposal.id!)
      const order=await placeDining(session,buyer,ref,quote,tx)
      await collectDining(order.id,tx)
      const afterSale=await requestTicketRefund(tx,registration,ticket,buyer,'退票期间已补款')
      await proposeTicketDining(tx,afterSale.caseId,employee,'原餐单补100元')
      const bill=(await tx.query('SELECT id FROM mbox.ticket_dining_collections WHERE case_id=$1',[afterSale.caseId])).rows[0]!.id
      await consentTicketDining(tx,bill,buyer)
      const attempt=await new PaymentRepository(tx).createForOrder({orderId:order.id,publicId:'RC'+randomUUID(),provider:'postar',method:'native_qr',
        initialStatus:'pending',principal:{type:'employee',employeeId:employee}})
      const ticketRefund=await submitTicketCashRefund(tx,afterSale.caseId,employee,50000,'门店承担，票款和餐饮补款分别核对')
      const repository=new RefundRepository(tx),refund=await repository.approve(ticketRefund.refundId,reviewer,'核对原路')
      await repository.beginExecution(refund.id)
      return {attempt,refund}
    })
    // Leave capture uncommitted while the separate refund callback reads the original order.
    let unlock!:()=>void, captured!:()=>void
    const release=new Promise<void>(resolve=>{unlock=resolve})
    const reached=new Promise<void>(resolve=>{captured=resolve})
    const capture=run(async tx=>{
      await new PaymentRepository(tx).applySucceededCallback({paymentPublicId:attempt.publicId,provider:'postar',providerTransactionId:'C-'+attempt.id,reportedAmountMinor:10000,reportedCurrency:'CNY'})
      captured()
      await release
    })
    await Promise.race([reached,capture])
    let done=false, callbackPid=0, sawBlockedCallback=false
    const returned=run(async tx=>{
      callbackPid=Number((await tx.query('SELECT pg_backend_pid() pid')).rows[0]!.pid)
      await new RefundRepository(tx).completeProviderExecution({refundPublicId:refund.publicId,provider:'postar',providerRefundId:'R-'+refund.id,
        originalProviderTransactionId:fixture.provider_transaction_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
    }).finally(()=>{done=true})
    try{
      for(let step=0;step<200 && !done;step++){
        if(callbackPid && (await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS blocked',[callbackPid])).rows[0].blocked>0){
          sawBlockedCallback=true
          break
        }
        await new Promise(resolve=>setTimeout(resolve,5))
      }
    }finally{unlock()}
    await Promise.all([capture,returned])
    expect(sawBlockedCallback).toBe(true)
    expect((await admin.query('SELECT status,amount_minor FROM mbox.refunds WHERE payment_id=$1',[attempt.id])).rows).toEqual([{status:'requested',amount_minor:'10000'}])
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
      const shows=[]
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
        const ticket=(await tx.query('SELECT k.id,k.point_lot_id,l.expires_at::text FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE registration_id=$1',[order.id])).rows[0]
        shows.push({offer,shown,ticket,order})
        copied.push({hour:new Date(Date.parse(shown.startsAt)+8*3600000).getUTCHours(),end:new Date(Date.parse(shown.endsAt)+8*3600000).getUTCHours(),points:actual,amount:order.amountMinor})
      }
      expect(copied).toEqual([{hour:18,end:20,points:100,amount:50000},{hour:23,end:1,points:550,amount:50000}])
      const [a,b]=shows as [typeof shows[number],typeof shows[number]]
      await tx.query('SAVEPOINT independent_gifts')
      const promoRefund=await requestTicketRefund(tx,b.order.id,b.ticket.id,customer,'只退晚场促销票')
      const cash=await submitTicketCashRefund(tx,promoRefund.caseId,employee,50000,null)
      const refundRepo=new RefundRepository(tx),reviewer=(await tx.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code='AUD'",[scope.tenantId])).rows[0].id
      const approved=await refundRepo.approve(cash.refundId,reviewer,'按原票实付核对500元')
      await refundRepo.beginExecution(cash.refundId)
      const paid=(await tx.query('SELECT provider_transaction_id FROM mbox.payments WHERE activity_registration_id=$1',[b.order.id])).rows[0]
      await refundRepo.completeProviderExecution({refundPublicId:approved.publicId,provider:'postar',providerRefundId:'test-'+cash.refundId,originalProviderTransactionId:paid.provider_transaction_id,reportedAmountMinor:50000,reportedCurrency:'CNY',succeeded:true})
      expect((await tx.query('SELECT remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[a.ticket.point_lot_id])).rows[0].remaining_points).toBe(100)
      expect((await tx.query('SELECT remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[b.ticket.point_lot_id])).rows[0].remaining_points).toBe(0)
      await tx.query('ROLLBACK TO SAVEPOINT independent_gifts')
      await tx.query('SAVEPOINT existing_package')
      const pkg=randomUUID(), displayed=b.shown.activityPublicId
      const policy=randomUUID()
      const otherStaff=(await tx.query("SELECT id FROM mbox.employees WHERE tenant_id=$1 AND employee_code IN('DRAFT','AUD') ORDER BY employee_code",[scope.tenantId])).rows
      await tx.query(`INSERT INTO mbox.loyalty_promotion_policy_versions(id,tenant_id,store_id,campaign_code,version,name,activity_id,stacking_group,stacking_mode,priority,store_budget_points,per_member_points_limit,point_validity_days,refund_policy,eligible_member_levels,drafted_by_employee_id,reason)
        VALUES($1,$2,$3,'SAME-SHOW',1,'同场购票赠分',$4,'SAME-SHOW','exclusive_highest',10,10000,1000,30,'reverse_on_any_refund',ARRAY['member','silver','gold'],$5,'同场付款真规则验收')`,[policy,scope.tenantId,scope.storeId,b.shown.activityId,employee])
      await tx.query("INSERT INTO mbox.loyalty_promotion_rules(tenant_id,store_id,policy_version_id,rule_code,trigger_kind,points,per_member_award_limit) VALUES($1,$2,$3,'PAID','activity_payment',40,3)",[scope.tenantId,scope.storeId,policy])
      const governance=new MembershipConfigurationDraftService(new PostgresMembershipConfigurationDraftRepository({run:(_scope,callback)=>callback(tx)},scope))
      const draftPolicy=await governance.get('promotion_points',policy)
      const impact=await governance.preview('promotion_points',policy,otherStaff[0].id)
      await governance.approve({domain:'promotion_points',publicId:policy,expectedRevision:draftPolicy.revision,approverEmployeeId:otherStaff[0].id,reason:'核对同场促销与桌票赠分',impactPreviewPublicId:impact.publicId})
      await tx.query("UPDATE mbox.loyalty_promotion_policy_versions SET status='published',published_at=now()-interval '1 hour',effective_from=now()-interval '1 hour',published_by_employee_id=$2 WHERE id=$1",[policy,otherStaff[1].id])

      const dish=(await tx.query("SELECT id FROM mbox.products WHERE tenant_id=$1 AND code='DISH'",[scope.tenantId])).rows[0].id
      await tx.query(`INSERT INTO mbox.community_activity_packages(id,tenant_id,store_id,activity_id,public_id,name,capacity,member_purchase_limit,fee_amount_minor,deposit_amount_minor,fee_basis,payment_mode,payment_deadline_minutes,payment_rule_text,status,max_participants,includes_admission,meal_only_fee_amount_minor,has_meal)
        VALUES($1::uuid,$2,$3,$4,$1::text,'原活动套餐',20,10,5000,0,'per_registration','full_required',15,'原套餐价','draft',2,true,3000,true)`,[pkg,scope.tenantId,scope.storeId,b.shown.activityId])
      await tx.query('INSERT INTO mbox.activity_package_products(tenant_id,store_id,package_id,product_id,quantity) VALUES($1,$2,$3,$4,1)',[scope.tenantId,scope.storeId,pkg,dish])
      await tx.query("UPDATE mbox.community_activity_packages SET status='published' WHERE id=$1",[pkg])
      await tx.query("UPDATE mbox.products SET fulfillment_station='kitchen' WHERE id=$1",[dish])
      const key=randomUUID(),registered=await new CustomerExperienceRepository(tx,true).registerActivity({activityPublicId:displayed,activityPackagePublicId:pkg,customerId:customer,partySize:1,
        protectedContact:{contactType:'phone',contactHash:'a'.repeat(64),encryptedContact:'AQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',encryptionKeyId:'activity-test-v1',maskedContact:'138****8000',source:'mini_program'},
        termsAcknowledged:true,acknowledgedSafetyPolicyVersion:'activity-safety-v1',acknowledgedRefundPolicyVersion:'activity-refund-v1',paymentChoice:'full',paymentMethod:'jsapi',jsapiReady:true,publicId:key,paymentPublicId:'AP'+key.replaceAll('-',''),idempotencyKey:key})
      const payments=new PaymentRepository(tx)
      const posted=await payments.applySucceededCallback({paymentPublicId:registered.paymentPublicId!,provider:'postar',providerTransactionId:randomUUID(),reportedAmountMinor:5000,reportedCurrency:'CNY',providerSnapshot:{test:true},succeededAt:new Date().toISOString()})
      await payments.syncActivityRegistrationPaymentStatus(posted.payment)
      expect((await tx.query('SELECT count(*)::int n FROM mbox.table_tickets WHERE registration_id=$1',[registered.id])).rows[0].n).toBe(0)
      const promotions=new PromotionalLoyaltyWorker({run:(_scope,callback)=>callback(tx)})
      await promotions.runTriggerBatch(scope,'same-event-promotions',100)
      const awards=(await tx.query('SELECT registration_id,awarded_points FROM mbox.loyalty_promotion_awards WHERE policy_version_id=$1',[policy])).rows
      expect(awards).toEqual([{registration_id:registered.id,awarded_points:40}])
      const refund=await new RefundRepository(tx).requestActivity({paymentId:posted.payment.id,publicId:randomUUID(),reason:'原活动套餐按原单退',requestedByCustomerId:customer})
      expect(refund.amountMinor).toBe(5000)
      expect((await tx.query('SELECT remaining_points FROM mbox.loyalty_point_lots WHERE id=$1',[b.ticket.point_lot_id])).rows[0].remaining_points).toBe(550)
      await tx.query('ROLLBACK TO SAVEPOINT existing_package')
      const table=(await tx.query("SELECT id FROM mbox.tables WHERE tenant_id=$1 AND area_id=$2 AND status='available' ORDER BY id",[scope.tenantId,area])).rows[0].id
      await assignTicketTable(tx,a.ticket.id,table,employee,null)
      const sourceLock=(await tx.query('SELECT reservation_lock_id id FROM mbox.table_tickets WHERE id=$1',[a.ticket.id])).rows[0].id
      const first=await proposeMove(tx,a.ticket.id,b.offer.id,table,employee,'原购票人选择晚场',randomUUID())
      await expect(decideMove(tx,first.id,randomUUID(),true)).rejects.toMatchObject({code:'TICKET_RESCHEDULE_CHANGED'})
      await decideMove(tx,first.id,customer,false)
      expect((await tx.query('SELECT status FROM mbox.reservation_table_locks WHERE id=$1',[sourceLock])).rows[0].status).toBe('confirmed')
      const proposal=await proposeMove(tx,a.ticket.id,b.offer.id,table,employee,'再次联系确认晚场',randomUUID())
      await tx.query('SAVEPOINT occupied_target')
      await assignTicketTable(tx,b.ticket.id,table,employee,null)
      await expect(decideMove(tx,proposal.id,customer,true)).rejects.toThrow()
      await tx.query('ROLLBACK TO SAVEPOINT occupied_target')
      await decideMove(tx,proposal.id,customer,true)
      await decideMove(tx,proposal.id,customer,true)
      const after=(await tx.query('SELECT k.point_lot_id,l.expires_at::text,k.reservation_lock_id,k.reschedule_id,l.remaining_points FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON l.id=k.point_lot_id WHERE k.id=$1',[a.ticket.id])).rows[0]
      expect(after).toMatchObject({point_lot_id:a.ticket.point_lot_id,expires_at:a.ticket.expires_at,reschedule_id:proposal.id,remaining_points:100})
      expect(after.reservation_lock_id).not.toBe(sourceLock)
      expect((await tx.query('SELECT status FROM mbox.reservation_table_locks WHERE id=$1',[sourceLock])).rows[0].status).toBe('cancelled')
      const scopes=await publicTableTickets(tx)
      expect(scopes.find(o=>o.id===a.offer.id)!.remaining).toBe(a.shown.remaining)
      expect(scopes.find(o=>o.id===b.offer.id)!.remaining).toBe(b.shown.remaining-2)
      await tx.query('SAVEPOINT moved_lock_expired')
      await tx.query("UPDATE mbox.reservation_table_locks SET status='expired' WHERE id=$1",[after.reservation_lock_id])
      expect((await publicTableTickets(tx)).find(o=>o.id===b.offer.id)!.remaining).toBe(b.shown.remaining-2)
      const waiting=(await ticketReception(tx,b.shown.activityPublicId)).orders.find(o=>o.id===a.ticket.id)
      expect(waiting?.tableName).toBeNull()
      await assignTicketTable(tx,a.ticket.id,table,employee,null)
      expect((await publicTableTickets(tx)).find(o=>o.id===b.offer.id)!.remaining).toBe(b.shown.remaining-2)
      await tx.query('ROLLBACK TO SAVEPOINT moved_lock_expired')
      await requestTicketRefund(tx,a.order.id,a.ticket.id,customer,'改期后按原票退')
      await decideTicketCase(tx,a.ticket.id,{employee},'zero','模拟该票零现金结案，回收桌位')
      expect((await tx.query('SELECT status FROM mbox.reservation_table_locks WHERE id=$1',[after.reservation_lock_id])).rows[0].status).toBe('cancelled')
      await tx.query('ROLLBACK TO SAVEPOINT two_shows')
    })
  })
  it('keeps overlapping shows, assisted sales and physical seating on the same last desk',async()=>{
    const operations=new ActivityOperationsService(runner,new NormalizedCommandExecutor(runner),protection)
    for(const channel of ['phone','walk_in'] as const){
      const localArea=randomUUID(),desk=randomUUID(),ids=[randomUUID(),randomUUID()]
      const offers=await run(async tx=>{
        await tx.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,$4,'最后一桌','indoor')",[scope.tenantId,scope.storeId,localArea,channel])
        await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3,$1,$2,$4,$5,'末桌',6)",[scope.tenantId,scope.storeId,desk,localArea,channel])
        const offers=[]
        for(const [index,id] of ids.entries()){
          await tx.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||
            jsonb_build_object('id',$2::uuid,'public_id',$2::text,'starts_at',now()-make_interval(mins=>$3),'ends_at',now()+interval '2 hours'))).*
            FROM mbox.community_activities a WHERE a.id=$1`,[activity,id,30+index*10])
          await approveEventTicketTerms(tx,id,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'测试场次编号',performers:'测试乐队',durationMinutes:90,programNote:'十首',serviceContact:'店内接待',refundSchedule:'按本场公示办理',requiresNamedAttendees:false},0)
          const offer=await saveTicketOffer(tx,id,employee,{...offerInput,areaId:localArea})
          offers.push((await publicTableTickets(tx)).find(item=>item.id===offer.id)!)
        }
        return offers
      })
      const [first,second]=offers
      const assist=await operations.offerTicketToMember({scope,employeeId:employee,businessDate:'2026-11-23'},second!.id,1,'13800000000',randomUUID())
      const waiting=await run(tx=>new WaitlistRepository(tx).create({publicId:randomUUID(),customerName:'现场候补',contact:protection.protect(channel==='phone'?'13800000007':'13800000008'),guestCount:1,desiredArrivalAt:new Date().toISOString(),source:'walk_in'}))
      expect(waiting.status).toBe('waiting')
      const buy=(offer:typeof offers[number],proposalId?:string)=>run(tx=>buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,proposalId,safetyVersion:offer.safetyVersion,refundVersion:offer.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection))
      const ready=channel==='phone'?run(tx=>new ReservationRepository(tx).create({publicId:randomUUID(),source:'phone',guestCount:1,customerName:'普通预约',contactToken:'test',tableIds:[desk],arrivalAt:second!.startsAt,expectedEndAt:first!.endsAt,initialStatus:'confirmed',reservationPolicyVersion:1,arrivalGraceEndsAt:first!.endsAt})):
        run(tx=>new TableSessionRepository(tx).open({table:{kind:'id',value:desk},publicId:randomUUID(),guestCount:1,businessDate:new Date().toISOString().slice(0,10),openedByEmployeeId:employee,primaryServiceEmployeeId:employee}))
      const outcomes=await Promise.allSettled([ready,buy(first!),buy(second!,assist.value.id)])
      expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
      for(const outcome of outcomes){
        if(outcome.status==='rejected')expect(String(outcome.reason)).toMatch(/余量|已购桌票|时段.*占用|容量|桌位|可售/)
      }
      const final=await run(publicTableTickets)
      expect(offers.map(o=>final.find(row=>row.id===o.id)?.remaining)).toEqual([0,0])
    }
  })
  it('retains a late paid desk until the show ends and closes an unattended reservation only once',async()=>{
    await run(async tx=>{
      await tx.query('SAVEPOINT no_show')
      const id=randomUUID(),localArea=randomUUID(),desk=randomUUID()
      await tx.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'LATE-GUEST','迟到接待','indoor')",[scope.tenantId,scope.storeId,localArea])
      await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3,$1,$2,$4,'LATE-GUEST','迟到接待',6)",[scope.tenantId,scope.storeId,desk,localArea])
      await tx.query(`INSERT INTO mbox.community_activities SELECT (jsonb_populate_record(NULL::mbox.community_activities,to_jsonb(a)||
        jsonb_build_object('id',$2::uuid,'public_id',$2::text,'starts_at',clock_timestamp()-interval '1 hour','ends_at',clock_timestamp()+interval '2 seconds'))).*
        FROM mbox.community_activities a WHERE a.id=$1`,[activity,id])
      await approveEventTicketTerms(tx,id,employee,{organizer:'测试举办方',seller:'测试售票方',approvalReference:'测试场次编号',performers:'测试乐队',
        durationMinutes:60,programNote:'十首',serviceContact:'门店客服',refundSchedule:'开演前可在原单申请全额退票',requiresNamedAttendees:false},0)
      const offer=await saveTicketOffer(tx,id,employee,{...offerInput,areaId:localArea})
      const shown=(await publicTableTickets(tx)).find(o=>o.id===offer.id)!
      const order=await buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:shown.safetyVersion,refundVersion:shown.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection)
      const receipt=(await tx.query("UPDATE mbox.payments SET status='succeeded',provider_transaction_id='expiry-'||id,succeeded_at=clock_timestamp() WHERE activity_registration_id=$1 RETURNING id",[order.id])).rows[0].id
      await new PaymentRepository(tx).syncActivityRegistrationPaymentStatus({id:receipt,activityRegistrationId:order.id,payableKind:'activity_registration',amountMinor:50000,succeededAt:new Date().toISOString(),status:'succeeded'})
      const first=(await ticketReception(tx,id)).orders[0]!
      expect(first).toMatchObject({awaitingDuringShow:true,showEnded:false,remainingPoints:550})
      await saveTicketOffer(tx,id,employee,{...offerInput,areaId:localArea,expectedVersion:offer.version,status:'withdrawn'})
      expect((await publicTableTickets(tx)).some(o=>o.id===offer.id)).toBe(false)
      await expect(buyTableTickets(tx,customer,{offerId:offer.id,quantity:1,safetyVersion:shown.safetyVersion,refundVersion:shown.refundVersion},randomUUID(),randomUUID(),randomUUID(),protection)).rejects.toThrow()

      await assignTicketTable(tx,first.id,desk,employee,null)
      const reservation=(await tx.query('SELECT id FROM mbox.reservations WHERE public_id=$1',['ticket-'+first.id])).rows[0].id
      await tx.query('SAVEPOINT sold_rights')
      const code=(await tx.query('SELECT door_code FROM mbox.table_tickets WHERE id=$1',[first.id])).rows[0].door_code
      expect(await admitTicketBatch(tx,first.id,code,1,employee,randomUUID())).toMatchObject({quantity:1})
      expect((await ticketRefundPreview(tx,first.id))[0]).toMatchObject({personalRefundClosed:true})
      await expect(requestTicketRefund(tx,order.id,first.id,customer,'个人原因')).rejects.toMatchObject({code:'TICKET_ALREADY_ADMITTED'})
      const merchant=await requestTicketRefund(tx,order.id,first.id,customer,'门店取消演出',undefined,true)
      await expect(submitTicketCashRefund(tx,merchant.caseId,employee,50000,null)).rejects.toMatchObject({code:'TICKET_ALREADY_ADMITTED'})
      expect(await submitTicketCashRefund(tx,merchant.caseId,employee,50000,'门店取消演出')).toHaveProperty('refundId')
      await tx.query('ROLLBACK TO SAVEPOINT sold_rights')
      const expiry=new ReservationHoldExpiryWorker({run:(_scope,fn)=>fn(tx)})
      expect((await expiry.runBatch(scope,'paid-not-yet-ended')).noShowReservationIds).not.toContain(reservation)
      await tx.query('SELECT pg_sleep_until($1::timestamptz)',[shown.endsAt])
      expect((await expiry.runBatch(scope,'paid-event-ended')).noShowReservationIds).toContain(reservation)
      expect((await expiry.runBatch(scope,'paid-ended-retry')).noShowReservationIds).not.toContain(reservation)
      expect((await ticketReception(tx,id)).orders[0]).toMatchObject({arrived:0,showEnded:true,awaitingDuringShow:false,remainingPoints:550})
      await tx.query('ROLLBACK TO SAVEPOINT no_show')
    })
  })
  it('counts full table intervals across midnight and charges an ordinary 36-yuan meal after ticket adoption',async()=>{
    await run(async tx=>{
      await tx.query('SAVEPOINT ordinary_meal')
      const args=[scope.tenantId,scope.storeId],localArea=randomUUID(),one=randomUUID(),two=randomUUID(),product=randomUUID()
      await tx.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'LATE','跨午夜桌区','indoor')",[...args,localArea])
      for(const id of [one,two])await tx.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,minimum_spend_minor) VALUES($3::uuid,$1,$2,$4,'L'||left(replace($3::text,'-',''),7),'普通桌',6,50000)",[...args,id,localArea])
      const next=(await tx.query("SELECT (((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date+3)+time '23:00') AT TIME ZONE 'Asia/Shanghai' begin")).rows[0].begin as Date
      const hour=(offset:number)=>new Date(next.getTime()+offset*3600000).toISOString()
      for(const [i,table] of [one,two].entries())await new ReservationRepository(tx).create({publicId:randomUUID(),source:'phone',guestCount:1,customerName:'跨日期预约',contactToken:'test',tableIds:[table],arrivalAt:hour(i),expectedEndAt:hour(i+1),initialStatus:'confirmed',reservationPolicyVersion:1,arrivalGraceEndsAt:hour(i+1)})
      const space=async(from:number,to:number)=>(await tx.query('SELECT mbox.table_ticket_area_remaining($1,$2,$3,$4,$5) remaining',[...args,localArea,hour(from),hour(to)])).rows[0].remaining
      expect(await space(0,1)).toBe(1);expect(await space(1,2)).toBe(1);expect(await space(0,2)).toBe(0)
      const table=(await tx.query("INSERT INTO mbox.table_sessions(tenant_id,store_id,table_id,public_id,business_date,guest_count,minimum_spend_minor,minimum_spend_mode) VALUES($1,$2,$3,$4,current_date,2,50000,'prepaid') RETURNING id,minimum_spend_minor::int minimum,minimum_spend_mode mode",[...args,one,randomUUID()])).rows[0]
      expect(table).toMatchObject({minimum:0,mode:'order_gate'})
      await tx.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($3,$1,$2,'REG36','36元单点','food','none','not_managed')",[...args,product])
      await tx.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',3600,'CNY',clock_timestamp()-interval '1 hour')",[...args,product])
      const dish=await new OrderRepository(tx).createSubmitted({tableSessionId:table.id,publicId:randomUUID(),channel:'guest_qr',settlementMode:'immediate_payment',createdByCustomerId:customer,lines:[{productId:product,quantity:1}]})
      expect(dish.totalAmountMinor).toBe(3600)
      await tx.query('ROLLBACK TO SAVEPOINT ordinary_meal')
    })
  })
  it('keeps the original mini-program purchases through verified phone replacement and an identity merge',async()=>{
    const app=Fastify(),businessDate='2026-11-23',alias=randomUUID()
    const unavailable=()=>{throw new Error('unexpected handler')}
    let authenticated=customer
    await app.register(customerExperienceApiPlugin,{transactions:runner,service:{purchaseTableTickets(){throw new CustomerExperienceRequestError('该场余量不足','TICKET_CAPACITY_FULL',409)}} as never,resolveStaffContext:unavailable,resolveGuestContext:unavailable,protectContact:unavailable,
      resolvePublicContext:()=>({scope,customerId:authenticated,actorRef:'local-ticket-identity',businessDate})})
    const path='/public/mini/table-ticket-purchases'
    const orders=async()=>{
      const result=await app.inject({method:'GET',url:path})
      expect(result.statusCode,result.body).toBe(200)
      return result.json().data.map((o:{registrationPublicId:string})=>o.registrationPublicId).sort()
    }
    try{
      const before=await orders()
      expect(before.length).toBeGreaterThan(0)
      const insufficient=await app.inject({method:'POST',url:path,headers:{'idempotency-key':randomUUID()},
        payload:{offerId:randomUUID(),quantity:2,safetyVersion:'v1',refundVersion:'v01',termsAcknowledged:true}})
      expect(insufficient.statusCode).toBe(409)
      expect(insufficient.json().error).toMatchObject({code:'TICKET_CAPACITY_FULL',commitDisposition:'not_committed'})
      for(const payload of [{points:500},{points:200,payMinor:30000}]){
        const invalid=await app.inject({method:'POST',url:path,payload})
        expect(invalid.json().error.code).toBe('TICKET_TENDER_INVALID')
      }
      const mobile=createMembershipRecoveryPhoneProtector(protection)
      await run(tx=>replaceVerifiedPhoneInTransaction(tx,{customerId:customer,protectedPhone:mobile.protect('+8613800000019'),providerReferenceHash:createHash('sha256').update(randomUUID()).digest('hex'),verifiedAt:new Date().toISOString(),idempotencyKey:randomUUID()}))
      expect(await orders()).toEqual(before)
      expect((await admin.query("SELECT count(*)::int n FROM mbox.customer_memberships WHERE customer_id=$1 AND status='active'",[customer])).rows[0].n).toBe(1)
      await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($3::uuid,$1,$2,$3::text)',[scope.tenantId,scope.storeId,alias])
      authenticated=alias
      expect(await orders()).toEqual([])
      await admin.query("UPDATE mbox.customers SET status='merged',merged_into_customer_id=$2 WHERE id=$1",[customer,alias])
      expect(await orders()).toEqual(before)
    }finally{await app.close()}
  })
  it('expires only after the Shanghai anniversary including leap day',async()=>{
    const {rows}=await admin.query(`SELECT mbox.table_ticket_expiry('2024-02-28 16:01Z')='2025-02-28 16:00Z' leap,
      mbox.table_ticket_expiry('2026-11-22 16:01Z')='2027-11-23 16:00Z' normal`)
    expect(rows[0]).toEqual({leap:true,normal:true})
  })
})
