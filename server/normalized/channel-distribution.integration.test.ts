import { DuplicateMembershipReviews } from './duplicate-membership-review.js'
import { createActivityContactProtectionKeyring } from './personal-contact-protection.js'
import { CustomerRepository } from './customer-repository.js'
import { loadGuestCustomerOrderHistory } from './guest-table-orders-query.js'
import { normalizedOperationsApiPlugin } from './normalized-operations-api.js'
import { TableSessionRepository, TableSessionCommandService } from './table-session-repository.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { AssistedOrderContextRepository } from './assisted-order-context.js'
import { menuCheckoutPricing } from '../../src/components/menu-channel-pricing.js'
import { ItemQuantityFulfillmentRepository } from './item-quantity-fulfillment-repository.js'
import { readCheckoutPrintSummary } from './checkout-print-summary.js'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import { inviteChannelWeb, hashChannelWebToken } from './channel-web-auth.js'
import { channelAnonymousVisit } from './channel-partner-repository.js'
import { PostgresOrderCancellationRepository } from './order-cancellation-repository.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import { TableManagementCommandService } from './table-management-repository.js'
import { PaymentCommandService } from './payment-command-service.js'
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js'
import { VerifiedProviderObservationService, NormalizedProviderObservationAuthority } from './provider-verification-observation.js'
import { PaymentRepository } from './payment-repository.js'
import { assertStaffSessionBinding, NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
import { readChannelReport } from './channel-report.js'
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js'
import { GuestSharedCartRepository } from './guest-shared-cart-repository.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import { ChannelOperationsRepository } from './channel-operations-repository.js'
import { ChannelFinanceRepository } from './channel-finance-repository.js'
import { ChannelReconciliationWorker } from './channel-reconciliation-worker.js'
import { fulfillChannelGift } from './channel-gift-service.js'
import { ChannelGiftInventory } from './channel-gift-inventory.js'
import { CommerceCommandService } from './commerce-command-service.js'
import { InventoryRepository } from './inventory-repository.js'
import { ChannelPricingRepository } from './channel-pricing-repository.js'
import { PricingAuthorizationPolicy } from './pricing-authorization-policy.js'
import { PostgresPricingAuthority } from './postgres-pricing-authority.js'
import { OrderRepository } from './order-repository.js'
import { createHash, randomUUID } from 'node:crypto'
import {StaffActionsApi} from '../../src/normalized-ui/staff-actions/staff-actions-api.js'
import { Pool } from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { WechatMiniProgramCodeError } from './wechat-mini-program-code.js'
import { ScopedPostgresTransactionRunner, type PostgresPool, type ScopedTransaction } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { MembershipEnrollmentService } from './membership-enrollment-service.js'
import { createMembershipRecoveryPhoneProtector, MembershipRecoveryService } from './membership-recovery-service.js'
import { CustomerExperienceRepository } from './customer-experience-repository.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { channelDistributionApiPlugin } from './channel-distribution-api.js'
import { ChannelPartnerRepository } from './channel-partner-repository.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { grantFixtureStaffPermissions } from './staff-permission.test-helper.js'
import { channelRuleSchema, type ChannelRule } from '../../src/shared/channel-distribution.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = databaseUrl && runtimeUrl ? describe : describe.skip
integration('channel distribution real PostgreSQL authority', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const employee = randomUUID(), area = randomUUID(), partner = randomUUID(), promoter = randomUUID(), product = randomUUID()
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, app: FastifyInstance
  let selfCustomer: string
  const miniCode = { appId: 'wxChannelFixture', render: vi.fn(async (_input: unknown) => sharp({create:{width:430,height:430,channels:3,background:'#186a42'}}).png().toBuffer()) }
  const args = [scope.tenantId, scope.storeId]
  const now = Date.now()
  const rule: ChannelRule = { allowStacking:false,visitDiscountCapMinor:null,title: '餐后小聚券', totalClaims: 3, perCustomerClaims: 1, perVisitUses: 1,
    claimFrom: new Date(now - 3600000).toISOString(), claimUntil: new Date(now + 3600000).toISOString(),
    useFrom: new Date(now - 3600000).toISOString(), useUntil: new Date(now + 7200000).toISOString(),
    minimumMinor: 10000, eligibleProductIds: [product], offer: { kind: 'credit', amountMinor: 1000 }, commissionBps: 1000, observationDays: 7 }
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 8 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 8, options: '-c search_path=pg_catalog' })
    await assertRuntimeDatabasePool(runtime, runtimeUrl!)
    runner = new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
    await admin.query(`INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'channel test')`, [scope.tenantId])
    await admin.query(`INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($2,$1,'channel','channel test')`, args)
    await admin.query(`INSERT INTO mbox.channel_store_limits(tenant_id,store_id,claim_limit,capacity_limit,cost_limit_minor) VALUES($1,$2,100000,100000,1000000000)`,args)
    await admin.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'CHANNEL','测试员工')`, [...args, employee])
    await admin.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($3,$1,$2,'MAIN','主区','indoor')`, [...args, area])
    await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) VALUES($3,$1,$2,'CHANNEL_ITEM','推荐饮品','drinks','bar')`, [...args, product])
    await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,amount_minor,valid_from) VALUES($1,$2,$3,10000,clock_timestamp()-interval '1 day')`, [...args, product])
    await admin.query(`INSERT INTO mbox.channel_partners(id,tenant_id,store_id,name,settlement_subject) VALUES($3,$1,$2,'楼下川菜','川菜公司')`, [...args, partner])
    await admin.query(`INSERT INTO mbox.channel_promoters(id,tenant_id,store_id,partner_id,name) VALUES($3,$1,$2,$4,'川菜店长')`, [...args, promoter, partner])
    await grantFixtureStaffPermissions(admin, scope, [employee], ['order.create', 'channel.manage', 'channel.activate', 'channel.view', 'table.view_all', 'table.transfer', 'table.participation.manage'])
    app = Fastify()
    await app.register(channelDistributionApiPlugin, { miniCode, webScope: scope, transactions: runner, commands: new NormalizedCommandExecutor(runner),
      resolveSelfContext: async () => ({ scope, customerId: selfCustomer, tableSessionId: null, businessDate: '2026-11-12', actorRef: `customer:${selfCustomer}` }),
      resolveGuestContext: async () => { throw new Error('No authenticated table guest in this fixture') },
      resolveStaffContext: async () => ({ scope, employeeId: employee, businessDate: '2026-11-12' }),
    })
    await app.register(tableManagementApiPlugin,{transactions:runner,commands:new TableManagementCommandService(new NormalizedCommandExecutor(runner)),resolveContext:()=>({scope,employeeId:employee,businessDate:'2026-11-12'})})
    await app.ready()
  })
  afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end() })

  async function webSession(pid:string) {
    const token=Buffer.from(randomUUID()+randomUUID()).subarray(0,32).toString('base64url')
    await admin.query(`INSERT INTO mbox.channel_web_accounts(tenant_id,store_id,promoter_id,username,password_hash) VALUES($1,$2,$3,$4,'fixture') ON CONFLICT DO NOTHING`,[...args,pid,'u'+pid.replaceAll('-','')])
    await admin.query(`INSERT INTO mbox.channel_web_sessions(tenant_id,store_id,promoter_id,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,[...args,pid,hashChannelWebToken(token)])
    return {cookie:`__Secure-mbox_channel_partner_session=${token}`}
  }
  async function customer(verified = true) {
    const id = randomUUID()
    await admin.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($3::uuid,$1,$2,$3::text)`, [...args, id])
    if (verified) await admin.query(`INSERT INTO mbox.customer_identities(tenant_id,store_id,customer_id,identity_kind,identity_hash) VALUES($1,$2,$3::uuid,'wechat',encode(digest($3::text,'sha256'),'hex'))`, [...args, id])
    return id
  }
  async function batch(overrides: Partial<ChannelRule> = {}, limits = { claim: 100, capacity: 100, cost: 1000000 }, targetPromoter = promoter) {
    const campaign = randomUUID()
    await admin.query(`INSERT INTO mbox.channel_campaigns(id,tenant_id,store_id,title,claim_limit,capacity_limit,cost_limit_minor,accepting_claims,staff_entry_enabled,self_entry_enabled)
      VALUES($3,$1,$2,'test campaign',$4,$5,$6,true,true,true)`, [...args, campaign, limits.claim, limits.capacity, limits.cost])
    const value = await runner.run(scope, tx => new ChannelDistributionRepository(tx).createBatch({ campaignId: campaign, promoterId: targetPromoter, rule: { ...rule, ...overrides }, contract: { version: 'test1' } }))
    await admin.query(`UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1`, [value.id])
    return { id: String(value.id), code: String(value.offerCode), token: String(value.publicToken), campaign }
  }
  async function table(customerIds: string[]) {
    const id = randomUUID(), session = randomUUID()
    await admin.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3::uuid,$1,$2,$4,left($3::text,30),'桌子',8)`, [...args, id, area])
    await admin.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,capacity_at_open,status,opened_by_employee_id,primary_service_employee_id)
      VALUES($3::uuid,$1,$2,$4,$3::text,'2026-11-12',2,8,'open',$5,$5)`, [...args, session, id, employee])
    for (const cid of customerIds) await admin.query(`INSERT INTO mbox.table_session_customer_participations(tenant_id,store_id,public_id,table_session_id,table_id,customer_id,join_source,identity_level,confirmation_state,location_started_at)
      VALUES($1,$2,$3,$4,$5,$6,'employee_assisted','wechat','confirmed',clock_timestamp())`, [...args, randomUUID(), session, id, cid])
    return session
  }
  // Construct pre-upgrade records to verify compatibility; never exposed as an API mode.
  const seedLegacyClaim=(code:string,cid:string)=>runner.run(scope,async tx=>{
    const repo=new ChannelDistributionRepository(tx);await repo.lockIdentity();const b=await repo.batch(code,true),offer=b.rule_snapshot.offer
    const cost=offer.kind==='gift'?offer.costMinor:offer.kind==='credit'?offer.amountMinor:offer.maximumMinor
    const q=(await tx.query<{id:string}>(`INSERT INTO mbox.channel_claims(tenant_id,store_id,batch_id,customer_id,entry,cost_commitment_minor) VALUES($1,$2,$3,$4,'self',$5) RETURNING id`,[...args,b.id,cid,cost])).rows[0]!
    if(offer.kind==='gift')await new ChannelGiftInventory(tx).reserve(q.id,offer)
    return{claimId:q.id,status:'available'}
  })
  const issue = (code: string, cid: string, entry: 'staff' | 'self' = 'self', reuse = false) => runner.run(scope, tx => new ChannelDistributionRepository(tx).issue(code, cid, entry, reuse))
  const activate = (claim: string, cid: string, session: string) => runner.run(scope, tx => new ChannelDistributionRepository(tx).activate(claim, cid, session, `employee:${employee}`))

  async function emptyMovementTable(){
    const id=randomUUID()
    await admin.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3::uuid,$1,$2,$4,left($3::text,30),'转桌目标',8)`,[...args,id,area]);return id
  }
  async function movementPeer(){
    const actor=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3::uuid,$1,$2,$3::text,'第二名转桌员工')",[...args,actor])
    await grantFixtureStaffPermissions(admin,scope,[actor],['table.transfer','table.participation.manage'])
    const peer=Fastify()
    await peer.register(tableManagementApiPlugin,{transactions:runner,commands:new TableManagementCommandService(new NormalizedCommandExecutor(runner)),resolveContext:()=>({scope,employeeId:actor,businessDate:'2026-11-12'})})
    return peer
  }
  async function settleMovementOrder(o:{id:string;totalAmountMinor:number}){
    await admin.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[o.id])
    const pay=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,status,succeeded_at) VALUES($3::uuid,$1,$2,$4,$3::text,'cash',$3::text,'cash',$5,'succeeded',clock_timestamp())`,[...args,pay,o.id,o.totalAmountMinor])
    await admin.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE order_item_id IN(SELECT id FROM mbox.order_items WHERE order_id=$1)",[o.id])
    await admin.query("UPDATE mbox.orders SET status='completed',payment_status='paid',completed_at=clock_timestamp() WHERE id=$1",[o.id]);return pay
  }
  async function moveRequest(source:string,targetTable:string,kind:'whole_table_transfer'|'participant_split'|'participant_merge',target:string|null=null,customers:string[]=[],count=1){
    const row=(await admin.query('SELECT table_id,location_version,guest_count FROM mbox.table_sessions WHERE id=$1',[source])).rows[0]
    const destination=(await admin.query('SELECT t.capacity,s.guest_count,s.capacity_at_open FROM mbox.tables t LEFT JOIN mbox.table_sessions s ON s.table_id=t.id AND s.status=\'open\' WHERE t.id=$1',[targetTable])).rows[0]
    const revision=(await admin.query('SELECT count(*)::text AS revision FROM mbox.table_customer_movement_events WHERE tenant_id=$1 AND store_id=$2 AND (source_table_session_id=ANY($3::uuid[]) OR target_table_session_id=ANY($3::uuid[]))',[...args,[source,...(target?[target]:[])]] )).rows[0].revision
    const movementGuard={movementRevision:revision,sourceTableId:row.table_id,sourceLocationVersion:Number(row.location_version),sourceGuestCount:row.guest_count,targetGuestCount:destination.guest_count??0,targetCapacity:destination.capacity_at_open??destination.capacity}
    const ids=(await admin.query('SELECT public_id FROM mbox.table_session_customer_participations WHERE table_session_id=$1 AND customer_id=ANY($2::uuid[]) AND left_at IS NULL',[source,customers])).rows.map(r=>r.public_id)
    return{method:'POST' as const,url:`/table-management/sessions/${source}/${kind==='whole_table_transfer'?'transfer':'participant-movements'}`,headers:{'idempotency-key':randomUUID()},payload:kind==='whole_table_transfer'?{targetTableId:targetTable,expectedSourceTableId:row.table_id,expectedLocationVersion:Number(row.location_version)}:{movementHistoryConfirmed:true,movementGuard,movementKind:kind,targetTableId:targetTable,targetTableSessionId:target,movedGuestCount:count,participantPublicIds:ids,reason:'渠道转桌联动隔离验证'}}
  }
  it('independently approves an old card into the later card and keeps its WeChat, original gift and order history',async()=>{
    const source=await customer(), keeper=await customer(false), reviewer=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'DUP_REVIEW','独立复核')",[...args,reviewer])
    await grantFixtureStaffPermissions(admin,scope,[employee],['customer.membership.recovery.verify','customer.membership.merge.approve'])
    await grantFixtureStaffPermissions(admin,scope,[reviewer],['customer.membership.recovery.verify','customer.membership.merge.approve'])
    const keys=createActivityContactProtectionKeyring(null,'duplicate-membership-test-keyring')
    const phone=keys.protectPhone('+8613800004321')
    const numbers=['MBX-DUP-OLD1','MBX-DUP-NEW2']
    for (const [i,id] of [source,keeper].entries()) {
      await runner.run(scope,async tx=>{
        await new CustomerExperienceRepository(tx).enrollMembership(id,numbers[i])
        await tx.query(`INSERT INTO mbox.customer_verified_contacts(tenant_id,store_id,customer_id,contact_type,
          contact_hash,encrypted_value,encryption_key_version,contact_encryption_key_id,masked_value,verification_source,
          provider_reference_sha256,verified_by_customer_id,verified_at)
          VALUES($1,$2,$3,'phone',$4,$5,2,$6,$7,'wechat_phone_authorization',$8,$3,clock_timestamp())`,
        [...args,id,phone.contactHash,phone.encryptedValue,phone.encryptionKeyId,phone.maskedValue,createHash('sha256').update(id).digest('hex')])
      })
    }
    const session=await table([source])
    for(let i=0;i<2;i++)await admin.query(`WITH o AS (INSERT INTO mbox.orders(tenant_id,store_id,table_session_id,public_id,channel,status,
      created_by_customer_id,business_date,cancelled_at) VALUES($1,$2,$3,$4,'guest_qr','cancelled',$5,'2026-11-12',clock_timestamp()) RETURNING id)
      INSERT INTO mbox.order_items(tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,
        fulfillment_station,product_snapshot,status) SELECT $1,$2,id,$6,1,0,0,'bar','{"name":"演练菜品"}','cancelled' FROM o`,
      [...args,session,randomUUID(),source,product])
    const registrationContact = keys.protect('13800004321')
    const registrations = [randomUUID(), randomUUID()]
    for (const [index, registration] of registrations.entries()) {
      const paid = index === 0
      await admin.query(`WITH event AS (
        INSERT INTO mbox.community_activities(tenant_id,store_id,public_id,activity_kind,title,summary,
          starts_at,ends_at,assembly_location,capacity,created_by_employee_id)
        VALUES ($1,$2,$3,'member_night','已结束的演出','现场演出',now()-interval '3 days',
          now()-interval '2 days','演出厅',10,$4) RETURNING id)
        INSERT INTO mbox.community_activity_registrations(tenant_id,store_id,public_id,activity_id,customer_id,
          status,payment_choice,payment_status,fee_amount_minor,paid_amount_minor,currency,idempotency_key,
          requested_payment_choice,requested_amount_due_minor,requested_payment_method,acknowledged_safety_policy_version,
          acknowledged_refund_policy_version,terms_acknowledged_at,terms_acknowledgement_source,contact_snapshot)
        SELECT $1,$2,$3,id,$5,$6,$7,$8,$9,$9,'CNY',$3,$7,$9,$10,'safety-v1','refund-v1',now(),'staff_assisted',$11::jsonb FROM event`,
        [...args, registration, employee, source, paid ? 'confirmed':'cancelled', paid ? 'full':'none',
          paid ? 'paid':'not_required', paid ? 5000:0, paid ? 'jsapi':null,
          JSON.stringify({contactType:'phone',contactHash:registrationContact.hash,encryptedContact:registrationContact.encryptedBase64,
            encryptionKeyId:registrationContact.keyId,maskedContact:registrationContact.masked,source:'mini_program'})])
    }
    const gift=await giftProduct(1), b=await batch({minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}})
    const claim=await issue(b.code,source)
    const memberIds=(await admin.query('SELECT id FROM mbox.customer_memberships WHERE store_id=$1 AND customer_id=ANY($2::uuid[]) ORDER BY joined_at',[scope.storeId,[source,keeper]])).rows.map(r=>r.id)
    const service=new DuplicateMembershipReviews(runner,keys,[memberIds[0],memberIds[1]])
    const maker={scope,employeeId:employee,businessDate:'2026-11-12'}, checker={...maker,employeeId:reviewer}
    const reason='顾客已确认两个会员号属于本人并指定保留新号', key=randomUUID()
    const orders=(id:string)=>runner.run(scope,tx=>loadGuestCustomerOrderHistory(tx,id))
    const originalOrders=(await orders(source)).map(o=>o.publicId).sort()
    expect(originalOrders).toHaveLength(2)
    expect(await service.list(maker)).toMatchObject({status:'new',sourceSuffix:'OLD1',keeperSuffix:'NEW2'})
    const {id}=await service.request(maker,reason,key)
    expect((await service.request(maker,reason,key)).id).toBe(id)
    await expect(service.decide(maker,id,true,'自行审批')).rejects.toThrow('另一位')
    expect((await runner.run(scope,tx=>new ChannelDistributionRepository(tx).wallet(keeper)))).toHaveLength(0)
    await admin.query('UPDATE mbox.loyalty_accounts SET available_points=10 WHERE customer_id=$1',[source])
    await expect(service.decide(checker,id,true,'重新核对')).rejects.toThrow('积分')
    await admin.query('UPDATE mbox.loyalty_accounts SET available_points=0 WHERE customer_id=$1',[source])
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=now()-interval '1 day' WHERE id=$1",[claim.claimId])
    await expect(service.decide(checker,id,true,'券到期后重新核对')).rejects.toThrow('已撤销本次修改')
    expect(await service.list(maker)).toMatchObject({id,status:'pending'})
    const oldCard = await runner.run(scope,tx=>new CustomerExperienceRepository(tx).findMembership(source))
    expect(oldCard?.id).toBe(memberIds[0])
    await admin.query('UPDATE mbox.channel_claims SET use_until_override=NULL WHERE id=$1',[claim.claimId])
    for(let i=0;i<2;i++)expect(await service.decide(checker,id,true,'已独立核对两户与原券')).toEqual({status:'approved'})
    const after=await runner.run(scope,async tx=>{
      const owner=await new CustomerRepository(tx).findByIdentity('wechat',createHash('sha256').update(source).digest('hex'))
      return {owner:owner?.id,member:(await new CustomerExperienceRepository(tx).findMembership(owner!.id))?.member_no,
        wallet:await new ChannelDistributionRepository(tx).wallet(owner!.id)}
    })
    expect(after).toMatchObject({owner:keeper,member:numbers[1],wallet:[{id:claim.claimId,status:'available'}]})
    expect((await orders(keeper)).map(o=>o.publicId).sort()).toEqual(originalOrders)
    const registrationDetails = (publicId:string) => runner.run(scope,tx=>
      new CustomerExperienceRepository(tx,true).publicActivityRegistrations(keeper,{id:publicId}))
    expect(await registrationDetails(registrations[0]!)).toMatchObject([
      {publicId:registrations[0],status:'confirmed',paymentStatus:'paid',paidAmountMinor:5000}])
    expect(await registrationDetails(registrations[1]!)).toMatchObject([
      {publicId:registrations[1],status:'cancelled',paymentStatus:'not_required',paidAmountMinor:0}])
    expect(await activate(claim.claimId, keeper, session)).toMatchObject({claimId:claim.claimId,status:'active'})
    expect((await admin.query('SELECT customer_id FROM mbox.channel_claims WHERE id=$1',[claim.claimId])).rows[0].customer_id).toBe(source)
  })

  it('shows the original gift coupon in the WeChat wallet after reclaiming a unique historical membership', async () => {
    const owner = await customer(), visitor = await customer()
    const phones = createMembershipRecoveryPhoneProtector('channel-legacy-member-phone-fixture')
    const context = (customerId: string) => ({
      scope, customerId, businessDate: '2026-11-12', actorRef: `customer:${customerId}`,
    })
    await runner.run(scope, tx => new CustomerExperienceRepository(tx).enrollMembership(owner, 'MBX-WALLETOWNER'))
    const e164Phone = '+8613800001234'
    await new MembershipRecoveryService(runner, phones).replaceMyVerifiedPhone(context(owner), {
      verifiedPhone: { e164Phone, providerReference: randomUUID(), verifiedAt: new Date().toISOString() },
      idempotencyKey: randomUUID(),
    })
    const gift = await giftProduct(1)
    const offer = await batch({ minimumMinor: 0, offer: { kind:'gift', productId:gift.pid, quantity:1, costMinor:100 } })
    const claim = await issue(offer.code, owner)
    const wallet = (cid: string) => runner.run(scope, tx => new ChannelDistributionRepository(tx).wallet(cid))
    expect(await wallet(visitor)).toHaveLength(0)
    const membership = new MembershipEnrollmentService(new NormalizedCommandExecutor(runner), {
      verify: async ({authorizationCode}) => ({ e164Phone, providerReference: authorizationCode, verifiedAt: new Date().toISOString() }),
    }, phones)
    const result = await membership.enroll(context(visitor), {
      termsVersion: 1, acknowledgementSource: 'mini_profile', phoneAuthorizationCode: randomUUID(),
      wechatPrincipalHash: createHash('sha256').update(visitor).digest('hex'), idempotencyKey: randomUUID(),
    })
    expect(result.value).toMatchObject({ created:false, membership:{ memberNo:'MBX-WALLETOWNER' } })
    expect(await wallet(visitor)).toEqual([expect.objectContaining({id:claim.claimId,status:'available'})])
    expect(await wallet(owner)).toEqual(await wallet(visitor))
  })

  it('does not let query text select a different authentication context',async()=>{
    const b=await batch();selfCustomer=await customer()
    const response=await app.inject({method:'POST',url:'/public/mini/channel/claim?trace=/guest/channel/',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code}})
    expect(response.statusCode,response.body).toBe(200)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
  })
  it('serializes a 16-request mixed QR and number burst against one shared customer limit',async()=>{
    const b=await batch({totalClaims:30,perCustomerClaims:2}),cid=await customer()
    const results=await Promise.allSettled(Array.from({length:16},(_,i)=>issue(i%2?b.code:b.token,cid,i%3?'self':'staff')))
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(14)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(2)
  })
  it('allows twelve claims without stock holds but fulfills the last actual gift only once under concurrency',async()=>{
    const gift=await giftProduct(1),b=await batch({totalClaims:30,minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}})
    const people=await Promise.all(Array.from({length:12},()=>customer()))
    const claims=await Promise.all(people.map((cid,i)=>issue(i%2?b.token:b.code,cid,i%2?'self':'staff')))
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(12)
    const stock=()=>admin.query('SELECT on_hand_quantity,reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[gift.iid])
    expect(Number((await stock()).rows[0].reserved_quantity)).toBe(0)
    const tables=await Promise.all(people.map(cid=>table([cid])))
    await Promise.all(claims.map((c,i)=>activate(c.claimId,people[i]!,tables[i]!)))
    expect(Number((await stock()).rows[0].reserved_quantity)).toBe(0)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const results=await Promise.allSettled(claims.map((c,i)=>runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:c.claimId,tableSessionId:tables[i]!,employeeId:employee,businessDate:'2026-11-12'}))))
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(11)
    expect(Number((await stock()).rows[0].reserved_quantity)).toBe(1)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_gift_promises WHERE claim_id=ANY($1::uuid[])',[claims.map(c=>c.claimId)])).rows[0].n).toBe(1)
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[gift.pid])).rows[0].sale_remaining_quantity).toBe(0)
  })

  it('recovers one claim after 12 simultaneous identical HTTP commands and rejects changed owner or payload',async()=>{
    const b=await batch({totalClaims:30,perCustomerClaims:20});selfCustomer=await customer()
    const request={method:'POST' as const,url:'/public/mini/channel/claim',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code}}
    const results=await Promise.all(Array.from({length:12},()=>app.inject(request)))
    expect(results.every(r=>[200,409].includes(r.statusCode)),results.map(r=>r.body).join("\n")).toBe(true)
    expect(results.some(r=>r.statusCode===200)).toBe(true)
    const recovery=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
    expect(recovery.statusCode,recovery.body).toBe(200)
    const id=recovery.json().data.claimId
    expect(results.filter(r=>r.statusCode===200).every(r=>r.json().data.claimId===id)).toBe(true)
    const other=await batch()
    expect((await app.inject({...request,payload:{code:other.code}})).statusCode).toBe(409)
    selfCustomer=await customer()
    const foreign=await app.inject(request)
    expect(foreign.statusCode).toBe(409);expect(foreign.body).not.toContain(id)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
  })
  it('rejects malformed, oversized and authority-forging claim bodies without issuing',async()=>{
    const b=await batch();selfCustomer=await customer()
    const bodies=[{code:b.code,fulfillmentPolicy:'reserved'},{code:b.code,cost_commitment_minor:0},{code:b.code,customerId:randomUUID()},{code:b.code,promoterId:promoter},{code:b.code,amountMinor:-1},{code:[]},{code:"'; DROP TABLE mbox.channel_claims; --"},{code:'x'.repeat(3000)}]
    for(const payload of bodies){
      const response=await app.inject({method:'POST',url:'/public/mini/channel/claim',headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
      expect([400,404,413],response.body).toContain(response.statusCode)
      expect(response.body).not.toMatch(/SELECT |INSERT |postgresql:|at .*\.ts:/)
    }
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
  })
  it('rejects exhausted request buckets without issuing and keeps another customer independent',async()=>{
    const b=await batch();selfCustomer=await customer()
    // Seed both adjacent minute buckets so a wall-clock minute boundary cannot make this flaky.
    await admin.query(`INSERT INTO mbox.channel_request_buckets(tenant_id,store_id,actor_hash,minute,count)
      SELECT $1,$2,encode(digest($3::text,'sha256'),'hex'),date_trunc('minute',clock_timestamp())+n*interval '1 minute',60 FROM generate_series(0,1) n`,[...args,selfCustomer])
    const blocked=await app.inject({method:'POST',url:'/public/mini/channel/claim',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code}})
    expect(blocked.statusCode,blocked.body).toBe(429)
    expect(blocked.json().error.code).toBe('RATE_LIMIT')
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
    selfCustomer=await customer()
    const allowed=await app.inject({method:'POST',url:'/public/mini/channel/claim',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code}})
    expect(allowed.statusCode,allowed.body).toBe(200)
  })
  it('rejects a stale staff preview after the customer leaves the selected table without consuming quota',async()=>{
    const b=await batch(),cid=await customer(),session=await table([cid])
    const payload={code:b.code,customerId:cid,tableSessionId:session}
    expect((await app.inject({method:'POST',url:'/staff/channel/preview',payload})).statusCode).toBe(200)
    await admin.query('UPDATE mbox.table_session_customer_participations SET left_at=clock_timestamp() WHERE customer_id=$1 AND left_at IS NULL',[cid])
    const newSession=await table([cid])
    const wrong=await app.inject({method:'POST',url:'/staff/channel/activate',headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
    expect(wrong.statusCode,wrong.body).toBe(403)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
    const right=await app.inject({method:'POST',url:'/staff/channel/activate',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{...payload,tableSessionId:newSession}})
    expect(right.statusCode,right.body).toBe(200)
  })
  it('rejects contradictory customer selectors and existing-plus-new choices without consuming quota',async()=>{
    const b=await batch(),cid=await customer(),session=await table([cid])
    for(const extra of [{memberCode:'not-another-person'},{claimId:randomUUID(),issueNew:true}]){
      const response=await app.inject({method:'POST',url:'/staff/channel/activate',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code,customerId:cid,tableSessionId:session,...extra}})
      expect(response.statusCode,response.body).toBe(400)
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
  })
  it('keeps an issued coupon usable after mistakenly pausing new issuance',async()=>{
    const b=await batch(),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await admin.query('UPDATE mbox.channel_campaigns SET accepting_claims=false WHERE id=$1',[b.campaign])
    await expect(issue(b.code,await customer())).rejects.toMatchObject({code:'PAUSED'})
    selfCustomer=await customer()
    const rejected=await app.inject({method:'POST',url:'/public/mini/channel/claim',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code}})
    expect(rejected.statusCode,rejected.body).toBe(409)
    expect(rejected.json().error).toMatchObject({code:'PAUSED',commitDisposition:'not_committed'})
    expect((await activate(coupon.claimId,cid,session)).status).toBe('active')
  })
  it.each([0,1000])('protects gift stock and cancellation when catalog price is %i',async price=>{
    const g=await giftProduct(1)
    await admin.query('UPDATE mbox.product_prices SET amount_minor=$2 WHERE product_id=$1',[g.pid,price])
    const b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    const activation=await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const fulfill=()=>runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    if(price===0){
      await expect(fulfill()).rejects.toThrow('标准价格')
      expect((await admin.query('SELECT order_id,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]).toBeUndefined()
      expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[g.pid])).rows[0].sale_remaining_quantity).toBe(1)
      expect(Number((await admin.query('SELECT reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[g.iid])).rows[0].reserved_quantity)).toBe(0)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(0)
      return
    }
    const result=await fulfill()
    await expect(runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(activation.activationId!,session,employee,'误点撤销已下单赠品'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
    const promise=(await admin.query('SELECT order_id,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]
    expect(promise.order_id).toBe(result.result.orderId)
    expect((await admin.query('SELECT status FROM mbox.channel_claims WHERE id=$1',[coupon.claimId])).rows[0].status).toBe('active')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.kds_tasks k JOIN mbox.order_items i ON i.id=k.order_item_id WHERE i.order_id=$1',[result.result.orderId])).rows[0].n).toBe(1)
  })
  it('legacy: blocks replacing a gift without customer consent and preserves the original reservation',async()=>{
    const old=await giftProduct(1),replacement=await giftProduct(1),b=await batch({offer:{kind:'gift',productId:old.pid,quantity:1,costMinor:100}}),coupon=await seedLegacyClaim(b.code,await customer())
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(coupon.claimId,'replace-gift',employee,'误点替换',{productId:replacement.pid,quantity:1,consent:' '}))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
    expect((await admin.query('SELECT product_id,state,generation FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]).toEqual({product_id:old.pid,state:'reserved',generation:1})
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[replacement.pid])).rows[0].sale_remaining_quantity).toBe(1)
  })
  it('rejects mistyped commission amounts and duplicate bank receipts without changing the paid balance',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'误操作核验'))
    await run(r=>r.respond(statement.id,f.owner,false,'确认无误'));await run(r=>r.approve(statement.id,reviewer,'独立复核'))
    for(const value of [0,-1,0.5,9000])await expect(run(r=>r.startPayment(statement.id,value,randomUUID(),employee,'金额录入错误'))).rejects.toThrow()
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_payouts WHERE statement_id=$1',[statement.id])).rows[0].n).toBe(0)
    const payout=await run(r=>r.startPayment(statement.id,400,randomUUID(),employee,'付款登记')),receipt='bank-'+randomUUID()
    await run(r=>r.confirmPayment(payout.id,true,receipt,reviewer,'独立核实'))
    await expect(run(r=>r.confirmPayment(payout.id,false,'other-'+randomUUID(),reviewer,'误改成功为失败'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await expect(run(r=>r.returnPayment(payout.id,100,receipt,reviewer,'误用付款流水作退款'))).rejects.toThrow('流水已登记')
    const returned='return-'+randomUUID();await run(r=>r.returnPayment(payout.id,100,returned,reviewer,'核实银行退回'))
    await expect(run(r=>r.returnPayment(payout.id,100,returned,reviewer,'重复登记退回'))).rejects.toThrow('流水已登记')
    expect((await run(r=>r.overview(f.rid))).statements[0]).toMatchObject({paidMinor:'300'})
  })
  it('shares the last N slot between QR and number under concurrent A/B requests', async () => {
    const b = await batch({ totalClaims: 1 }), customers = await Promise.all([customer(), customer()])
    const results = await Promise.allSettled([issue(b.code, customers[0]!, 'staff'), issue(b.token, customers[1]!)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    const count = await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1', [b.id])
    expect(count.rows[0].n).toBe(1)
  })
  it('enforces K across both entries and reuses a self coupon after all new claims stop', async () => {
    const b = await batch({ totalClaims: 1 }), cid = await customer(), session = await table([cid])
    const first = await issue(b.token, cid)
    await expect(issue(b.code, cid, 'staff')).rejects.toMatchObject({ code: 'CLAIM_LIMIT' })
    await admin.query('UPDATE mbox.channel_campaigns SET accepting_claims=false WHERE id=$1', [b.campaign])
    const reused = await issue(b.code, cid, 'staff', true)
    expect(reused.claimId).toBe(first.claimId)
    const active = await activate(first.claimId, cid, session)
    expect(active.status).toBe('active')
    expect((await activate(first.claimId, cid, session)).activationId).toBe(active.activationId)
  })
  it('holds L atomically for different customers at the same visit', async () => {
    const b = await batch(), a = await customer(), c = await customer(), session = await table([a, c])
    const coupons = await Promise.all([issue(b.code, a), issue(b.token, c)])
    const results = await Promise.allSettled([activate(coupons[0]!.claimId, a, session), activate(coupons[1]!.claimId, c, session)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['VISIT_LIMIT'])
  })
  it('rolls back staff issuance when current-table activation fails', async () => {
    const b = await batch(), cid = await customer(), other = await customer(), session = await table([other])
    await expect(runner.run(scope, async tx => { const repo = new ChannelDistributionRepository(tx); const claim = await repo.issue(b.code, cid, 'staff', true); return repo.activate(claim.claimId, cid, session, `employee:${employee}`) })).rejects.toMatchObject({ code: 'OWNERSHIP' })
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1', [b.id])).rows[0].n).toBe(0)
  })
  it('does not count an anonymous device as a verified person', async () => {
    const b = await batch(), cid = await customer(false)
    await expect(issue(b.code, cid)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })
  it('preserves issuance N/K after expiry and rejects foreign ownership', async () => {
    const b = await batch(), cid = await customer(), other = await customer(), session = await table([other])
    const coupon = await issue(b.code, cid)
    await admin.query(`UPDATE mbox.channel_claims SET status='expired' WHERE id=$1`, [coupon.claimId])
    await expect(issue(b.code, cid)).rejects.toMatchObject({ code: 'CUSTOMER_LIMIT' })
    await expect(activate(coupon.claimId, other, session)).rejects.toMatchObject({ code: 'OWNERSHIP' })
  })
  it('does not reserve campaign cost for claims across separate batches', async () => {
    const b = await batch({}, { claim: 100, capacity: 100, cost: 1000 })
    const c = await runner.run(scope, tx => new ChannelDistributionRepository(tx).createBatch({ campaignId: b.campaign, promoterId: promoter, rule, contract: { version: 'test1' } }))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1', [c.id])
    const a = await customer(), d = await customer()
    const results = await Promise.allSettled([issue(b.code, a), issue(String(c.offerCode), d)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual([])
  })
  it('recovers the same HTTP claim receipt without issuing twice or trusting a body customer', async () => {
    const b = await batch(); selfCustomer = await customer()
    const headers = { 'idempotency-key': `channel-${randomUUID()}` }, payload = { code: b.code.toLowerCase() }
    const first = await app.inject({ method: 'POST', url: '/public/mini/channel/claim', headers, payload })
    expect(first.statusCode, first.body).toBe(200)
    const replay = await app.inject({ method: 'POST', url: '/public/mini/channel/claim', headers: { ...headers, 'x-channel-recovery': '1' }, payload })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data.claimId).toBe(first.json().data.claimId)
    expect(replay.json().meta.replayed).toBe(true)
    const forged = await app.inject({ method: 'POST', url: '/public/mini/channel/claim', headers, payload: { ...payload, customerId: randomUUID() } })
    expect(forged.statusCode).toBe(400)
    const recovery = await app.inject({ method: 'POST', url: '/public/mini/channel/claim', headers: { 'idempotency-key': `channel-${randomUUID()}`, 'x-channel-recovery': '1' }, payload })
    expect(recovery.statusCode).toBe(409)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1', [b.id])).rows[0].n).toBe(1)
  })
  it('restricts data by store and freezes issued rule snapshots', async () => {
    const b = await batch({ eligibleProductNames: [{ id: product, name: '伪造商品展示名' }] })
    expect((await admin.query(`SELECT rule_snapshot->'eligibleProductNames' AS names FROM mbox.channel_batches WHERE id=$1`, [b.id])).rows[0].names).toEqual([{ id: product, name: '推荐饮品' }])
    const rows = await runner.run({ ...scope, storeId: randomUUID() }, tx => tx.query('SELECT id FROM mbox.channel_batches'))
    expect(rows.rows).toEqual([])
    await expect(runner.run(scope, tx => tx.query(`UPDATE mbox.channel_batches SET rule_snapshot=rule_snapshot||'{"totalClaims":999}'::jsonb WHERE id=$1`, [b.id]))).rejects.toMatchObject({ code: '23514' })
  })
  it('staff HTTP entry identifies a verified seated nonmember and uses the same coupon as B', async () => {
    const b = await batch({ totalClaims: 1 }), cid = await customer(), session = await table([cid])
    const coupon = await issue(b.token, cid)
    const headers = { 'idempotency-key': `channel-${randomUUID()}` }, payload = { code: `MBOX_CHANNEL_V1:${b.token}`, customerId: cid, tableSessionId: session }
    const first = await app.inject({ method: 'POST', url: '/staff/channel/activate', headers, payload })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data.claimId).toBe(coupon.claimId)
    const replay = await app.inject({ method: 'POST', url: '/staff/channel/activate', headers, payload })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().meta.replayed).toBe(true)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1', [b.id])).rows[0].n).toBe(1)
  })
  it('previews and explicitly selects an existing coupon, or adds one when K and L permit', async () => {
    const b = await batch({ totalClaims: 4, perCustomerClaims: 2, perVisitUses: 2,allowStacking:true }), cid = await customer(), session = await table([cid])
    const first = await issue(b.code, cid)
    const preview = await app.inject({ method: 'POST', url: '/staff/channel/preview', payload: { code: b.code, customerId: cid, tableSessionId: session } })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().data.claims.map((c: { id: string }) => c.id)).toEqual([first.claimId])
    const request = (extra: Record<string, unknown>) => app.inject({ method: 'POST', url: '/staff/channel/activate', headers: { 'idempotency-key': `channel-${randomUUID()}` },
      payload: { code: b.code, customerId: cid, tableSessionId: session, ...extra } })
    const second = await request({ issueNew: true })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().data.claimId).not.toBe(first.claimId)
    const selected = await request({ claimId: first.claimId })
    expect(selected.statusCode, selected.body).toBe(200)
    expect(selected.json().data.claimId).toBe(first.claimId)
    const noMore = await request({ issueNew: true })
    expect(noMore.statusCode).toBe(409)
    expect(noMore.json().error.code).toBe('CUSTOMER_LIMIT')
    const ambiguous = await request({ claimId: first.claimId, issueNew: true })
    expect(ambiguous.statusCode).toBe(400)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1', [b.id])).rows[0].n).toBe(2)
  })
  it('does not issue an extra coupon when explicit new activation exceeds L; rejects another source or owner', async () => {
    const b = await batch({ perCustomerClaims: 2 }), otherBatch = await batch(), cid = await customer(), outsider = await customer(), session = await table([cid])
    const first = await issue(b.code, cid), foreign = await issue(b.code, outsider)
    await activate(first.claimId, cid, session)
    const request = (extra: Record<string, unknown>) => app.inject({ method: 'POST', url: '/staff/channel/activate', headers: { 'idempotency-key': `channel-${randomUUID()}` },
      payload: { code: b.code, customerId: cid, tableSessionId: session, ...extra } })
    const limit = await request({ issueNew: true })
    expect(limit.statusCode).toBe(409); expect(limit.json().error.code).toBe('VISIT_LIMIT')
    const wrongOwner = await request({ claimId: foreign.claimId })
    expect(wrongOwner.statusCode).toBe(403)
    const wrongBatch = await request({ code: otherBatch.code, claimId: first.claimId })
    expect(wrongBatch.statusCode).toBe(403)
    const previewOther = await app.inject({ method: 'POST', url: '/staff/channel/preview', payload: { code: b.code, customerId: outsider, tableSessionId: session } })
    expect(previewOther.statusCode).toBe(403)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1 AND customer_id=$2', [b.id, cid])).rows[0].n).toBe(1)
  })
  async function order(session: string, channel: string) {
    const id = randomUUID()
    await runner.run(scope, tx => tx.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,total_amount_minor,created_by_employee_id,submitted_at,business_date)
      VALUES($3::uuid,$1,$2,$4,$3::text,$5,'submitted','unpaid',10000,10000,$6,clock_timestamp(),'2026-11-12')`, [...args, id, session, channel, employee]))
    return id
  }
  it('both customer and employee order channels inherit the immutable visit source', async () => {
    const b = await batch(), cid = await customer(), session = await table([cid])
    const coupon = await issue(b.code, cid), activated = await activate(coupon.claimId, cid, session)
    const orders = await Promise.all([order(session, 'guest_qr'), order(session, 'staff_assisted')])
    const rows = await runner.run(scope, tx => tx.query('SELECT order_id,visit_id,batch_id FROM mbox.channel_order_attributions WHERE order_id=ANY($1::uuid[])', [orders]))
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.every(r => r.visit_id === activated.visitId && r.batch_id === b.id)).toBe(true)
    await expect(runner.run(scope, tx => tx.query('UPDATE mbox.channel_order_attributions SET batch_id=$1 WHERE order_id=$2', [b.id, orders[0]]))).rejects.toMatchObject({ code: '42501' })
  })
  it('blocks automatic retroactive attribution after the first organic order', async () => {
    const b = await batch(), cid = await customer(), session = await table([cid])
    await order(session, 'staff_assisted')
    const coupon = await issue(b.code, cid)
    await expect(activate(coupon.claimId, cid, session)).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' })
  })
  it('cancels an unused activation once, restores L but never restores issued N/K', async () => {
    const b = await batch(), cid = await customer(), session = await table([cid])
    const coupon = await issue(b.code, cid), activated = await activate(coupon.claimId, cid, session)
    const cancel = () => runner.run(scope, tx => new ChannelDistributionRepository(tx).cancelActivation(activated.activationId!, session, employee, '误绑原券回退'))
    expect((await cancel()).status).toBe('cancelled')
    expect((await cancel()).status).toBe('cancelled')
    expect((await activate(coupon.claimId, cid, session)).status).toBe('active')
    await expect(issue(b.code, cid)).rejects.toMatchObject({ code: 'CUSTOMER_LIMIT' })
    await order(session, 'staff_assisted')
    const active = await activate(coupon.claimId, cid, session)
    expect(await runner.run(scope, tx => new ChannelDistributionRepository(tx).cancelActivation(active.activationId!, session, employee, '普通原价订单未兑现渠道券，可以换会员优惠'))).toMatchObject({status:'cancelled'})
  })
  it('counts canonical-family claims after a customer merge', async () => {
    const b = await batch(), old = await customer(), canonical = await customer()
    const coupon = await issue(b.code, old)
    await admin.query(`UPDATE mbox.customers SET status='merged',merged_into_customer_id=$2 WHERE id=$1`, [old, canonical])
    await expect(issue(b.token, canonical)).rejects.toMatchObject({ code: 'CUSTOMER_LIMIT' })
    selfCustomer=canonical
    const preview=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    expect(preview.json().data).toMatchObject({claimedCount:1,existingClaimId:coupon.claimId})
    const wallet=await app.inject({method:'GET',url:'/public/mini/channel/wallet'})
    expect(wallet.json().data.some((item:{id:string})=>item.id===coupon.claimId)).toBe(true)
  })
  it('does not reset a party limit by independently scanning a new table', async () => {
    const b = await batch(), cid = await customer(), source = await table([cid]), target = await table([])
    const coupon = await issue(b.code, cid)
    await activate(coupon.claimId, cid, source)
    const participation = (await admin.query(`SELECT id FROM mbox.table_session_customer_participations WHERE customer_id=$1 AND left_at IS NULL`, [cid])).rows[0].id
    await expect(admin.query(`INSERT INTO mbox.guest_table_rescan_events(tenant_id,store_id,customer_id,source_participation_id,target_table_session_id) VALUES($1,$2,$3,$4,$5)`, [...args, cid, participation, target])).rejects.toMatchObject({ code: '23514', message: 'channel_guest_rescan_requires_staff' })
  })
  it('distinguishes self binding from staff-confirmed physical arrival', async () => {
    const b = await batch(), cid = await customer(), session = await table([cid]), coupon = await issue(b.code, cid)
    const active = await runner.run(scope, tx => new ChannelDistributionRepository(tx).activate(coupon.claimId, cid, session, `guest-session:${randomUUID()}`))
    const before = (await admin.query('SELECT arrival_confirmed_at FROM mbox.channel_visits WHERE id=$1', [active.visitId])).rows[0]
    expect(before.arrival_confirmed_at).toBeNull()
    await activate(coupon.claimId, cid, session)
    await activate(coupon.claimId, cid, session)
    const after = (await admin.query('SELECT arrival_confirmed_by_employee_id FROM mbox.channel_visits WHERE id=$1', [active.visitId])).rows[0]
    expect(after.arrival_confirmed_by_employee_id).toBe(employee)
    expect((await admin.query(`SELECT count(*)::integer AS n FROM mbox.channel_events WHERE object_id=$1 AND event_type='visit.arrival_confirmed'`, [active.visitId])).rows[0].n).toBe(1)
  })
  const priceInput = (session:string, quantity=1) => ({tableSessionId:session,channel:'staff_assisted' as const,actorRef:`employee:${employee}`,lines:[{productId:product,quantity}]})
  const prepare = (session:string,quantity=1) => runner.run(scope,tx=>new ChannelPricingRepository(tx).prepare(priceInput(session,quantity)))
  const consumePrice = (session:string,quoteId:string,quantity=1,beforeCommit?:(pid:number)=>Promise<void>) => runner.run(scope,async tx=>{
    await new ChannelDistributionRepository(tx).lockIdentity()
    const input=priceInput(session,quantity),policy=new PricingAuthorizationPolicy(new PostgresPricingAuthority())
    const authorization=await policy.authorize(tx,{scope,actor:{type:'employee',employeeId:employee},tableSessionId:session,channel:'staff_assisted',lines:input.lines},{sourceType:'channel_quote',sourceId:quoteId})
    const order=await new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted',lines:input.lines,createdByEmployeeId:employee},authorization)
    await policy.consume(tx,authorization!,order.id)
    if(beforeCommit)await beforeCommit(Number((await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid))
    return order
  })
  it('prices real submitted orders using one cumulative credit and rejects stale, changed or repeated quotes',async()=>{
    const b=await batch(),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    const quote=await prepare(session)
    expect(quote.payableMinor).toBe(9000)
    await expect(consumePrice(session,quote.id,2)).rejects.toThrow('重新确认')
    const same=await prepare(session)
    const order=await consumePrice(session,quote.id)
    expect(order.totalAmountMinor).toBe(9000);expect(order.items[0]!.discountAmountMinor).toBe(1000)
    await expect(consumePrice(session,same.id)).rejects.toThrow('重新确认')
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    expect((await admin.query('SELECT sum(amount_minor)::text AS amount FROM mbox.channel_price_applications WHERE order_id=$1',[order.id])).rows[0].amount).toBe('1000')
  })
  it('rejects an expired immutable quote without creating any order or spending coupon capacity',async()=>{
    const b=await batch(),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session);const original=await prepare(session),expired=randomUUID()
    await admin.query(`INSERT INTO mbox.channel_price_quotes(id,tenant_id,store_id,visit_id,table_session_id,actor_ref,customer_id,channel,snapshot,fingerprint,expires_at,created_at) SELECT $2,tenant_id,store_id,visit_id,table_session_id,actor_ref,customer_id,channel,snapshot,fingerprint,clock_timestamp()-interval '1 second',clock_timestamp()-interval '3 minutes' FROM mbox.channel_price_quotes WHERE id=$1`,[original.id,expired])
    await expect(consumePrice(session,expired)).rejects.toThrow('已失效')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(0)
    expect((await consumePrice(session,original.id)).discountAmountMinor).toBe(1000)
  })
  it('accumulates percentage discounts across add-ons and refuses a quote on another table',async()=>{
    const b=await batch({offer:{kind:'discount',discountBps:1000,maximumMinor:2500}}),cid=await customer(),session=await table([cid]),other=await table([]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    const q1=await prepare(session);await expect(consumePrice(other,q1.id)).rejects.toThrow('当前账号和桌次')
    expect((await consumePrice(session,q1.id)).discountAmountMinor).toBe(1000)
    const q2=await prepare(session);expect((await consumePrice(session,q2.id)).discountAmountMinor).toBe(1000)
    const q3=await prepare(session);expect((await consumePrice(session,q3.id)).discountAmountMinor).toBe(500)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })
  it('keeps zero-paid channel goods in cumulative percentage spend without exceeding the cap',async()=>{
    const b=await batch({minimumMinor:0,offer:{kind:'discount',discountBps:10000,maximumMinor:25000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    for(const expected of [10000,10000,5000]){const q=await prepare(session);expect((await consumePrice(session,q.id)).discountAmountMinor).toBe(expected)}
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })
  it('waits for cumulative spend threshold and supports explicit zero-payable channel authority',async()=>{
    const b=await batch({minimumMinor:20000,offer:{kind:'credit',amountMinor:10000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    // First order is submitted at its ordinary authoritative price.
    await runner.run(scope,tx=>new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted',lines:[{productId:product,quantity:1}],createdByEmployeeId:employee}))
    const quote=await prepare(session),order=await consumePrice(session,quote.id)
    expect(order.totalAmountMinor).toBe(0)
    const settled=await runner.run(scope,tx=>tx.query<{ok:boolean}>('SELECT mbox.order_fully_settled_by_channel($1,$2,$3) AS ok',[...args,order.id]))
    expect(settled.rows[0]!.ok).toBe(true)
  })
  async function giftProduct(stock=2){
    const pid=randomUUID(),iid=randomUUID(),rid=randomUUID()
    await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,cost_amount_minor,inventory_control_mode,sale_remaining_quantity) VALUES($3::uuid,$1,$2,$3::text,'渠道赠品','food','kitchen',100,'tracked',$4)`,[...args,pid,stock])
    await admin.query(`INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,amount_minor,valid_from) VALUES($1,$2,$3,1000,clock_timestamp()-interval '1 day')`,[...args,pid])
    await admin.query(`INSERT INTO mbox.inventory_items(id,tenant_id,store_id,sku,name,item_type,base_unit) VALUES($3::uuid,$1,$2,$3::text,'赠品原料','food','portion')`,[...args,iid])
    await admin.query(`INSERT INTO mbox.inventory_balances(tenant_id,store_id,inventory_item_id,on_hand_quantity) VALUES($1,$2,$3,$4)`,[...args,iid,stock])
    await admin.query(`INSERT INTO mbox.recipes(id,tenant_id,store_id,product_id,version,status,effective_at) VALUES($3,$1,$2,$4,1,'active',clock_timestamp()-interval '1 hour')`,[...args,rid,pid])
    await admin.query(`INSERT INTO mbox.recipe_items(tenant_id,store_id,recipe_id,inventory_item_id,quantity) VALUES($1,$2,$3,$4,1)`,[...args,rid,iid])
    return{pid,iid,rid}
  }
  it('legacy: reserves actual gift stock at issuance, protects it from normal sales and creates one zero-value KDS order',async()=>{
    const g=await giftProduct(),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:999}}),cid=await customer(),session=await table([cid])
    const coupon=await seedLegacyClaim(b.code,cid)
    const stock=()=>admin.query(`SELECT on_hand_quantity::text AS hand,reserved_quantity::text AS held FROM mbox.inventory_balances WHERE inventory_item_id=$1`,[g.iid])
    expect(Number((await stock()).rows[0].held)).toBe(1)
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[g.pid])).rows[0].sale_remaining_quantity).toBe(1)
    await expect(admin.query('UPDATE mbox.products SET sale_quantity_generation=sale_quantity_generation+1 WHERE id=$1',[g.pid])).rejects.toMatchObject({code:'23514'})
    const ordinary=await runner.run(scope,async tx=>{
      const o=await new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'cashier',settlementMode:'immediate_payment',lines:[{productId:g.pid,quantity:1}],createdByEmployeeId:employee})
      await new InventoryRepository(tx).reserveForImmediatePaymentOrder(o.id,o.items)
      return o
    })
    expect(ordinary.totalAmountMinor).toBe(1000)
    await expect(issue(b.code,await customer())).resolves.toMatchObject({status:'available'})
    // The ordinary order above is deliberately a separate organic table.
    // Binding after a first order is blocked; use a new empty table for the coupon.
    await admin.query('UPDATE mbox.table_session_customer_participations SET left_at=clock_timestamp() WHERE customer_id=$1 AND left_at IS NULL',[cid])
    const giftTable=await table([cid]);await activate(coupon.claimId,cid,giftTable)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const fulfill=()=>runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:giftTable,employeeId:employee,businessDate:'2026-11-12'}))
    const first=await fulfill(),again=await fulfill()
    expect(again.result.orderId).toBe(first.result.orderId);expect(again.result.replayed).toBe(true)
    const order=(await admin.query('SELECT total_amount_minor::text,payment_status,fulfillment_state FROM mbox.orders WHERE id=$1',[first.result.orderId])).rows[0]
    expect(order).toMatchObject({total_amount_minor:'0',payment_status:'paid',fulfillment_state:'active'})
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.kds_tasks k JOIN mbox.order_items i ON i.id=k.order_item_id WHERE i.order_id=$1',[first.result.orderId])).rows[0].n).toBe(1)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.payments WHERE order_id=$1',[first.result.orderId])).rows[0].n).toBe(0)
    expect(Number((await stock()).rows[0].held)).toBe(2)
    expect(Number((await stock()).rows[0].hand)).toBe(2)
  })
  it('legacy: rolls back a premature gift redemption and releases only unused expired stock, without restoring N/K',async()=>{
    const g=await giftProduct(1),b=await batch({offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),coupon=await seedLegacyClaim(b.code,cid)
    await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    await expect(runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))).rejects.toThrow('尚未达到赠品门槛')
    expect((await admin.query('SELECT state,order_id FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]).toEqual({state:'reserved',order_id:null})
    // Active promises cannot be released silently.
    await expect(runner.run(scope,tx=>new ChannelGiftInventory(tx).release(coupon.claimId))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
    await admin.query("UPDATE mbox.channel_claims SET status='expired' WHERE id=$1",[coupon.claimId])
    await runner.run(scope,tx=>new ChannelGiftInventory(tx).release(coupon.claimId))
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[g.pid])).rows[0].sale_remaining_quantity).toBe(1)
    await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
  })


  it.each(['100','0',null])('records actual gift consumption cost %s, preserving zero versus unknown and not charging for claims',async unitCost=>{
    const g=await giftProduct(1),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    const report=()=>runner.run(scope,tx=>readChannelReport(tx))
    expect((await report()).find(r=>r.id===b.id)).toMatchObject({giftCostMinor:'0',fulfilledClaims:0})
    await admin.query("UPDATE mbox.inventory_balances SET weighted_unit_cost_minor=$2,cost_status=CASE WHEN $2::numeric IS NULL THEN 'pending' ELSE 'complete' END,cost_basis=CASE WHEN $2::numeric IS NULL THEN 'none' ELSE 'manual_correction' END WHERE inventory_item_id=$1",[g.iid,unitCost])
    await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const outcome=await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    const item=(await admin.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[outcome.result.orderId])).rows[0].id
    const consume=()=>runner.run(scope,tx=>new InventoryRepository(tx).consumeOrderItemReservations(item,{createdByEmployeeId:employee,reason:'KDS开始制作'}))
    expect((await consume()).length).toBe(1);expect((await consume()).length).toBe(0)
    const stock=(await admin.query('SELECT on_hand_quantity::text AS hand,reserved_quantity::text AS held FROM mbox.inventory_balances WHERE inventory_item_id=$1',[g.iid])).rows[0]
    expect(Number(stock.hand)).toBe(0);expect(Number(stock.held)).toBe(0)
    expect((await report()).find(r=>r.id===b.id)).toMatchObject({costMinor:unitCost,giftCostMinor:unitCost,fulfilledClaims:0})
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(coupon.claimId,'revoke',employee,'制作后误撤'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
  })
  it('legacy: replaces an unused gift atomically with consent, restores old stock and preserves one N/K claim',async()=>{
    const a=await giftProduct(1),b=await giftProduct(1),batchA=await batch({minimumMinor:0,offer:{kind:'gift',productId:a.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),claim=await seedLegacyClaim(batchA.code,cid)
    await activate(claim.claimId,cid,session)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(claim.claimId,'replace-gift',employee,'顾客要求换口味',{productId:b.pid,quantity:1,consent:'顾客现场确认同意'}))
    expect((await admin.query('SELECT product_id,generation,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[claim.claimId])).rows[0]).toEqual({product_id:b.pid,generation:2,state:'reserved'})
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[a.pid])).rows[0].sale_remaining_quantity).toBe(1)
    const wallet=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).wallet(cid))
    expect(wallet[0]!.offer).toMatchObject({productId:b.pid})
    await expect(issue(batchA.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
    const soldOut=await giftProduct(0)
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(claim.claimId,'replace-gift',employee,'缺货替换',{productId:soldOut.pid,quantity:1,consent:'顾客同意'}))).rejects.toMatchObject({code:'GIFT_STOCK'})
    expect((await admin.query('SELECT product_id,generation,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[claim.claimId])).rows[0]).toEqual({product_id:b.pid,generation:2,state:'reserved'})
  })
  it('legacy: expires unused gift holds through the worker but protects active promises past the use deadline',async()=>{
    const g=await giftProduct(2),b=await batch({minimumMinor:0,totalClaims:2,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),one=await customer(),two=await customer(),c1=await seedLegacyClaim(b.code,one),c2=await seedLegacyClaim(b.code,two),session=await table([two])
    await activate(c2.claimId,two,session)
    await admin.query(`UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])`,[[c1.claimId,c2.claimId]])
    const result=await new ChannelReconciliationWorker(runner).runBatch(scope,'test-channel-worker')
    expect(result.expired).toBeGreaterThanOrEqual(1);expect(result.failed).toBe(0)
    expect((await admin.query('SELECT status FROM mbox.channel_claims WHERE id=$1',[c1.claimId])).rows[0].status).toBe('expired')
    expect((await admin.query('SELECT state FROM mbox.channel_gift_promises WHERE claim_id=$1',[c2.claimId])).rows[0].state).toBe('reserved')
    await expect(issue(b.code,one)).rejects.toMatchObject({code:'CLAIM_LIMIT'})
  })
  it('legacy: rechecks campaign capacity on an expired gift extension and voids an unused issuance only once',async()=>{
    const g=await giftProduct(1),b=await batch({totalClaims:1,minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),q=await seedLegacyClaim(b.code,cid)
    await admin.query(`UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1`,[q.claimId])
    await new ChannelReconciliationWorker(runner).runBatch(scope,'extension-test')
    const until=new Date(Date.now()+3*3600000).toISOString()
    await admin.query('UPDATE mbox.channel_campaigns SET cost_limit_minor=99 WHERE id=$1',[b.campaign])
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'extend',employee,'门店排队延期',{until}))).rejects.toMatchObject({code:'CAMPAIGN_BUDGET'})
    await admin.query('UPDATE mbox.channel_campaigns SET cost_limit_minor=100 WHERE id=$1',[b.campaign])
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'extend',employee,'门店排队延期',{until}))
    expect((await admin.query('SELECT status FROM mbox.channel_claims WHERE id=$1',[q.claimId])).rows[0].status).toBe('available')
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[g.pid])).rows[0].sale_remaining_quantity).toBe(0)
    await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CLAIM_LIMIT'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'void',employee,'误发原券冲销'))
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'void',employee,'重复冲销'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
    await expect(issue(b.code,cid)).resolves.toMatchObject({status:'available'})
  })
  it.each(['zero','prepaid','online'] as const)('uses an authenticated guest channel quote for %s checkout and preserves its retry receipt',async(mode)=>{
    const b=await batch({minimumMinor:0,offer:{kind:'credit',amountMinor:mode==='zero'?10000:1000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    const active=await activate(coupon.claimId,cid,session)
    if(mode==='prepaid'){
      await admin.query("UPDATE mbox.table_sessions SET minimum_spend_mode='prepaid',minimum_spend_minor=10000 WHERE id=$1",[session])
      const p=await runner.run(scope,tx=>new PaymentRepository(tx).createForTablePrepayment({tableSessionId:session,customerId:cid,publicId:randomUUID(),amountMinor:10000,provider:'postar',method:'jsapi'}))
      await admin.query("UPDATE mbox.payments SET status='succeeded',succeeded_at=clock_timestamp(),provider_transaction_id=id::text WHERE id=$1",[p.id])
    }
    await admin.query(`UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1`,[product])
    await admin.query(`UPDATE mbox.table_sessions SET guest_cart_protocol_version=2 WHERE id=$1`,[session])
    await admin.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')`,[...args,session,cid])
    const actorRef=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:cid})
    const cart=await runner.run(scope,async tx=>{const r=new GuestSharedCartRepository(tx,cid),open=await r.readOpen(session,'GSC'+randomUUID().replace(/-/g,'').toUpperCase());return r.adjust(session,open.publicId,{productId:product,delta:1,expectedGeneration:open.generation,expectedVersion:open.version,operationId:randomUUID(),actorSessionRef:actorRef})})
    const guest=Fastify({logger:{level:'error'}}),commands=new NormalizedCommandExecutor(runner),commerce=new CommerceCommandService(commands,new PostgresPricingAuthority())
    let currentCustomer=cid
    const payments=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    await guest.register(guestCommerceServiceApiPlugin,{transactions:runner,commandExecutor:commands,commerce,payments,onlinePayments:{assertAvailable:()=>{},assertGuestJsapiReady:async()=> 'jsapi',create:async({paymentId}:{paymentId:string})=>({status:'pending',paymentId,presentation:'jsapi',payload:{timeStamp:'1',nonceStr:'fixture',package:'prepay_id=fixture',signType:'RSA',paySign:'isolated-not-a-real-signature'}})} as never,
      resolveGuestContext:async()=>({scope,sessionKind:'table',customerId:currentCustomer,tableSessionId:session,reservationId:null,tableCode:'test',tableDisplayName:'测试桌',businessDate:'2026-11-12',expiresAt:new Date(Date.now()+3600000).toISOString(),capabilities:['guest.session.read','guest.order.create'],actorRef}),
      resolvePublicContext:async()=>({scope}),paymentMode:mode==='online'?'wechat_jsapi':'simulation',paymentActionSecret:'channel-test-no-real-payment'})
    try{
      const quote=await guest.inject({method:'POST',url:'/guest/shared-cart/channel-quote',payload:{expectedGeneration:cart.generation,expectedVersion:cart.version}})
      expect(quote.statusCode,quote.body).toBe(200)
      const q=quote.json().data;expect(q).toMatchObject({sourceType:'channel_quote',payableMinor:mode==='zero'?0:9000})
      const payload={expectedGeneration:cart.generation,expectedVersion:cart.version,couponQuoteId:q.id},key='channel-'+randomUUID(),url=mode==='zero'?'/guest/shared-cart/channel-settlement':mode==='prepaid'?'/guest/shared-cart/prepayment-settlement':'/guest/shared-cart/checkout'
      const checkout=await guest.inject({method:'POST',url,headers:{'idempotency-key':key},payload})
      expect(checkout.statusCode,checkout.body).toBe(201);if(mode==='online')expect((await admin.query('SELECT amount_minor::int AS amount FROM mbox.payments WHERE public_id=$1',[checkout.json().data.payment.publicId])).rows[0]).toMatchObject({amount:9000});else expect(checkout.json().data).toMatchObject({payment:null,...(mode==='zero'?{channelSettlement:true}:{prepaymentSettlement:true,settlement:{payableAmountMinor:9000}})})
      if(mode==='online'){
        const publicId=checkout.json().data.payment.publicId,integrationRef='channel-isolated-callback',providerTransactionId=randomUUID(),occurredAt=new Date().toISOString()
        const observation=await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,paymentPublicId:publicId,providerTransactionId,reportedAmountMinor:9000,reportedCurrency:'CNY',status:'succeeded',occurredAt})
        const command={scope,actor:{type:'integration' as const,ref:integrationRef},businessDate:'2026-11-12',idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId:observation,paymentPublicId:publicId,provider:'postar' as const,providerTransactionId,reportedAmountMinor:9000,reportedCurrency:'CNY',occurredAt}
        expect((await payments.recordSucceededCallback(command)).value.status).toBe('succeeded');expect((await payments.recordSucceededCallback(command)).replayed).toBe(true)
      }
      const replay=await guest.inject({method:'POST',url,headers:{'idempotency-key':key},payload})
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data.order.publicId).toBe(checkout.json().data.order.publicId)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_price_applications WHERE quote_id=$1',[q.id])).rows[0].n).toBe(1)
      if(mode!=='zero'){
        const orderId=(await admin.query('SELECT id FROM mbox.orders WHERE public_id=$1',[checkout.json().data.order.publicId])).rows[0].id
        await admin.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[orderId])
        await admin.query('UPDATE mbox.channel_visits SET closed_at=clock_timestamp() WHERE id=$1',[active.visitId])
        expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(active.visitId!))).toMatchObject({basis:9000,target:900})
        if(mode==='prepaid')expect((await admin.query('SELECT sum(amount_minor)::text AS amount FROM mbox.table_prepayment_allocations WHERE order_id=$1',[orderId])).rows[0].amount).toBe('9000')
      }
      currentCustomer=await customer()
      const stolen=await guest.inject({method:'POST',url,headers:{'idempotency-key':'channel-'+randomUUID()},payload})
      expect(stolen.statusCode).toBeGreaterThanOrEqual(400)
    }finally{await guest.close()}
  }, 30_000)
  const reviewer=randomUUID()
  it.each([false,true])('closes self claim, staff binding, commerce, transfer, refund and commission settlement with channel attribution=%s',async withChannel=>{
    const approver=randomUUID(),cid=await customer(),session=await table([cid])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3::uuid,$1,$2,$3::text,'闭环独立复核')",[...args,approver])
    // New roles already receive selected baseline permissions from migrations.
    const grant=async(actor:string,codes:string[])=>{
      const role=randomUUID()
      await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($3::uuid,$1,$2,'CLOSURE_'||upper(replace($3::text,'-','')),'闭环测试岗位')",[...args,role])
      for(const code of codes){
        await admin.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING',[...args,code])
        await admin.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4 ON CONFLICT DO NOTHING',[...args,role,code])
      }
      await admin.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 day')",[...args,actor,role])
      return role
    }
    await grant(employee,['payment.manual.cash.record','payment.collect.all_tables','refund.request','refund.execute','table.close'])
    const approvalRole=await grant(approver,['refund.approve','refund.execute','payment.collect.all_tables','table.view_all'])
    await admin.query("INSERT INTO mbox.role_approval_limits(tenant_id,store_id,role_id,approval_code,amount_minor,currency) VALUES($1,$2,$3,'refund.approve',100000,'CNY')",[...args,approvalRole])
    await admin.query("UPDATE mbox.products SET inventory_control_mode='not_managed' WHERE id=$1",[product])
    const meta=(actor=employee)=>({scope,actor:{type:'employee' as const,employeeId:actor},businessDate:'2026-11-12',idempotencyKey:randomUUID(),requestFingerprint:randomUUID()})
    let visitId:string|undefined,quoteId:string|undefined,claimId='',batchId='',demoPromoter='',demoPartner=''
    let miniPage:any,miniClient:any
    const evidence:Record<string,unknown>={isolated:true,realFunds:false,stages:[]}
    if(process.env.CHANNEL_CLOSURE_DEMO_DIR)mkdirSync(process.env.CHANNEL_CLOSURE_DEMO_DIR,{recursive:true})
    const stage=(name:string,data:unknown)=>{(evidence.stages as unknown[]).push({name,data});if(process.env.CHANNEL_CLOSURE_DEMO_DIR)writeFileSync(process.env.CHANNEL_CLOSURE_DEMO_DIR+'/lifecycle-progress.json',JSON.stringify(evidence,null,2))}
    if(withChannel){
      demoPartner=randomUUID();demoPromoter=randomUUID()
      await admin.query("INSERT INTO mbox.channel_partners(id,tenant_id,store_id,name,settlement_subject) VALUES($3,$1,$2,'演示闭环茶馆','演示茶馆公司')",[...args,demoPartner])
      await admin.query("INSERT INTO mbox.channel_promoters(id,tenant_id,store_id,partner_id,name,can_confirm_statement) VALUES($3,$1,$2,$4,'演示茶馆店长',true)",[...args,demoPromoter,demoPartner])
      const b=await batch({minimumMinor:0,observationDays:0},undefined,demoPromoter);batchId=b.id
      selfCustomer=cid
      const memberNo='MBX'+cid.replaceAll('-','').toUpperCase()
      await admin.query('INSERT INTO mbox.customer_memberships(tenant_id,store_id,customer_id,member_no) VALUES($1,$2,$3,$4)',[...args,cid,memberNo])
      const {liveMiniHarness}=createRequire(import.meta.url)('../../scripts/miniprogram-live-contract-harness.mjs')
      miniClient=liveMiniHarness('miniprogram',async(call:any)=>{
        const reply=await app.inject({method:call.method,url:call.path.replace(/^\/api/,'')+call.query,headers:call.headers,...(call.method==='GET'?{}:{payload:call.data})})
        return{status:reply.statusCode,data:reply.json()}
      })
      vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/channel-coupons/index.js',import.meta.url),'utf8'),{
        Page:(value:unknown)=>{miniPage=value},wx:miniClient.runtime,Date,getApp:()=>({globalData:{}}),setTimeout:()=>1,clearTimeout:()=>{},
        require:(path:string)=>miniClient.load(miniClient.root+'/'+path.replace('../../','')),
      })
      miniPage.data=structuredClone(miniPage.data);miniPage.setData=(patch:object)=>Object.assign(miniPage.data,patch)
      miniPage.onLoad({code:b.code});await miniPage.onShow();await miniPage.claim()
      expect(miniPage.data.error).toBe('');claimId=miniPage.data.coupons[0].id
      expect(miniPage.data.coupons[0].status).toBe('available');stage('本人小程序领券',miniPage.data.coupons)
      const bind={method:'POST' as const,url:'/staff/channel/activate',headers:{'idempotency-key':'channel-'+randomUUID()},payload:{code:b.code,memberCode:memberNo,tableSessionId:session,claimId}}
      const preview=await app.inject({...bind,url:'/staff/channel/preview'});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().data.claims[0].id).toBe(claimId)
      expect((await admin.query('SELECT c.customer_id FROM mbox.channel_claims c JOIN mbox.customer_memberships m ON m.customer_id=c.customer_id WHERE c.id=$1 AND m.member_no=$2',[claimId,memberNo])).rows[0].customer_id).toBe(cid)
      const result=await app.inject(bind);expect(result.statusCode,result.body).toBe(200);visitId=result.json().data.visitId
      expect((await app.inject({...bind,headers:{...bind.headers,'x-channel-recovery':'1'}})).json().meta.replayed).toBe(true)
      stage('员工复用原券绑定本桌',result.json())
      quoteId=(await prepare(session)).id
    }
    const commands=new NormalizedCommandExecutor(runner),commerce=new CommerceCommandService(commands,new PostgresPricingAuthority())
    const existingCredential=(await admin.query('SELECT id FROM mbox.store_daily_credentials WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL AND business_date=current_date',args)).rows[0]
    const credentialId=existingCredential?.id??randomUUID(),leaseId=randomUUID(),staffSessionId=randomUUID()
    if(!existingCredential)await admin.query("INSERT INTO mbox.store_daily_credentials(id,tenant_id,store_id,business_date,credential_hash,valid_from,valid_until,configured_by_employee_id) VALUES($1,$2,$3,current_date,'scrypt$closure-test',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours',$4)",[credentialId,...args,employee])
    await admin.query("INSERT INTO mbox.store_device_access_leases(id,tenant_id,store_id,daily_credential_id,business_date,device_key_hash,lease_token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,current_date,$5,$6,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '8 hours')",[leaseId,...args,credentialId,createHash('sha256').update(randomUUID()).digest('hex'),createHash('sha256').update(randomUUID()).digest('hex')])
    await admin.query("INSERT INTO mbox.staff_sessions(id,tenant_id,store_id,employee_id,device_access_lease_id,session_token_hash,issued_at,expires_at,online_lease_until) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '6 hours',statement_timestamp()+interval '30 minutes')",[staffSessionId,...args,employee,leaseId,createHash('sha256').update(randomUUID()).digest('hex')])
    const binding={employeeId:employee,staffSessionId,deviceAccessLeaseId:leaseId}
    const context=await runner.run(scope,tx=>new AssistedOrderContextRepository(tx).issue({...binding,tableSessionId:session}))
    const submission={...meta(),assistedOrderContext:{...binding,token:context.token},tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted' as const,createdByEmployeeId:employee,lines:[{productId:product,quantity:1}],...(quoteId?{pricingAuthorization:{sourceType:'channel_quote' as const,sourceId:quoteId}}:{})}
    const submitted=await commerce.submitOrder(submission),order=submitted.value.order,paid=withChannel?9000:10000
    expect(order.totalAmountMinor).toBe(paid)
    expect((await commerce.submitOrder(submission)).replayed).toBe(true)
    const money=new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    const paymentCommand={...meta(),orderId:order.id,publicId:randomUUID(),provider:'cash' as const,method:'cash' as const,evidence:{receiptReference:randomUUID(),collectedByEmployeeId:employee}}
    const payment=await money.recordManual(paymentCommand)
    expect((await money.recordManual(paymentCommand)).replayed).toBe(true)
    expect(payment.value.amountMinor).toBe(paid)
    const task=(await admin.query('SELECT id FROM mbox.kds_tasks WHERE order_item_id=$1',[order.items[0]!.id])).rows[0]
    expect(task).toBeTruthy()
    const delivery={itemId:order.items[0]!.id,taskId:task.id,employeeId:employee,quantity:1,eventKey:randomUUID()}
    await runner.run(scope,async tx=>{
      const production=new ItemQuantityFulfillmentRepository(tx)
      await production.complete({...delivery,eventKey:randomUUID()})
      await production.deliver(delivery)
      expect((await production.deliver(delivery)).replayed).toBe(true)
    })
    if(visitId)expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visitId!))).toMatchObject({basis:paid,target:paid/10,frozen:true,reasons:expect.arrayContaining(['客组尚未结束'])})
    if(withChannel){
      const transfer=await moveRequest(session,await emptyMovementTable(),'whole_table_transfer')
      const moved=await app.inject(transfer);expect(moved.statusCode,moved.body).toBe(200)
      expect((await app.inject(transfer)).json().meta.replayed).toBe(true)
      const tableState=await app.inject({method:'GET',url:'/staff/channel/table/'+session})
      expect(tableState.statusCode,tableState.body).toBe(200)
      expect(tableState.json().data.activations).toHaveLength(1)
      expect(tableState.json().data.activations[0]).toMatchObject({claimId,sourceLabel:expect.stringContaining('演示闭环茶馆')})
      stage('转桌后原券与来源不变',tableState.json())
    }
    const refund=await money.requestRefund({...meta(),paymentId:payment.value.id,publicId:randomUUID(),purpose:'service_compensation',reason:'隔离服务补偿',allocations:[{orderItemId:order.items[0]!.id,amountMinor:2000}]})
    await money.approveRefund({...meta(approver),refundId:refund.value.id,decisionReason:'隔离独立复核'})
    await money.beginRefundExecution({...meta(approver),refundId:refund.value.id})
    if(visitId)expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visitId!))).toMatchObject({frozen:true,reasons:expect.arrayContaining(['退款待核实'])})
    const refundCommand={...meta(approver),refundId:refund.value.id,succeeded:true,receiptReference:randomUUID()}
    expect((await money.recordManualRefundResult(refundCommand)).value.status).toBe('succeeded')
    expect((await money.recordManualRefundResult(refundCommand)).replayed).toBe(true)
    const summary=await runner.run(scope,tx=>readCheckoutPrintSummary(tx,[order.id]))
    expect(summary).toMatchObject({received:paid,refunded:2000,net:paid-2000,due:0,state:'paid'})
    if(visitId){
      const finance=()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visitId!))
      expect(await finance()).toMatchObject({basis:paid-2000,target:(paid-2000)/10,deltaMinor:-200})
      expect(await finance()).toMatchObject({deltaMinor:0})
      expect((await admin.query('SELECT applied_discount_minor::int AS n FROM mbox.channel_activations WHERE visit_id=$1',[visitId])).rows[0].n).toBe(1000)
    }else expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_order_attributions WHERE order_id=$1',[order.id])).rows[0].n).toBe(0)
    const operations=Fastify()
    await operations.register(normalizedOperationsApiPlugin,{
      operationsQuery:{getStaffView:async()=>{throw new Error('unused read port')}},
      tableSessions:new TableSessionCommandService(commands),commandExecutor:commands,
      resolveContext:()=>({scope,employeeId:employee,businessDate:'2026-11-12',capabilities:['table.close']}),
      createTableSessionRepository:tx=>new TableSessionRepository(tx),createServiceTaskRepository:tx=>new ServiceTaskRepository(tx),
    })
    try{for(const transition of ['begin-closing','close']){
      const request={method:'POST' as const,url:`/table-sessions/${session}/${transition}`,headers:{'idempotency-key':randomUUID()},payload:{}}
      const response=await operations.inject(request)
      expect(response.statusCode,response.body).toBe(200)
      expect((await operations.inject(request)).statusCode).toBe(200)
    }}finally{await operations.close()}
    if(visitId){
      expect((await new ChannelReconciliationWorker(runner).runBatch(scope,'closure-audit')).failed).toBe(0)
      expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visitId!))).toMatchObject({basis:paid-2000,target:(paid-2000)/10,frozen:false,deltaMinor:0})
      expect((await admin.query('SELECT closed_at FROM mbox.channel_visits WHERE id=$1',[visitId])).rows[0].closed_at).not.toBeNull()
    }
    if(visitId){
      await grant(employee,['channel.settle']);await grant(approver,['channel.settle'])
      const peer=Fastify()
      await peer.register(channelDistributionApiPlugin,{transactions:runner,commands,resolveSelfContext:async()=>{throw Error('unused')},resolveGuestContext:async()=>{throw Error('unused')},resolveStaffContext:async()=>({scope,employeeId:approver,businessDate:'2026-11-12'})})
      const finance=async(server:FastifyInstance,payload:Record<string,unknown>,status=200)=>{
        const request={method:'POST' as const,url:'/staff/channel/finance',headers:{'idempotency-key':'channel-'+randomUUID()},payload:{...payload,reason:'隔离演示，不发生真实转账'}}
        const result=await server.inject(request);expect(result.statusCode,result.body).toBe(status)
        if(status===200){const retry=await server.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}});expect(retry.json().meta.replayed).toBe(true);expect(retry.json().data).toEqual(result.json().data)}
        return result.json().data
      }
      try{
        const account=await finance(app,{action:'account',partnerId:demoPartner,reference:'DEMO-ACCOUNT-'+randomUUID()})
        await finance(app,{action:'verify-account',id:account.id},403)
        await finance(peer,{action:'verify-account',id:account.id})
        const statement=await finance(app,{action:'statement',promoterId:demoPromoter,accountId:account.id})
        expect(Number(statement.amountMinor)).toBe(700)
        const headers=await webSession(demoPromoter)
        const dashboard=await app.inject({method:'GET',url:'/cooperation/partner',headers})
        expect(dashboard.statusCode,dashboard.body).toBe(200)
        expect(dashboard.json().data.balance).toMatchObject({accruedMinor:'700',paidMinor:'0',balanceMinor:'700'})
        stage('退款20元后应计佣金7元',dashboard.json())
        // Drive the shipped partner browser UI into the real HTTP/PG handlers.
        if(process.env.CHANNEL_CLOSURE_DEMO_DIR){
          const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true})
          try{
            const page=await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN',timezoneId:'Asia/Shanghai'}),errors:string[]=[]
            page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message))
            await page.route('http://localhost/**',async route=>{
              const request=route.request(),url=new URL(request.url())
              if(url.pathname.startsWith('/cooperation/api/')){
                const reply=await app.inject({method:request.method() as 'GET'|'POST',url:url.pathname.replace('/api/','/')+url.search,headers:{...request.headers(),...headers,host:'localhost',origin:'https://www.shmbox.com','x-channel-web':'1'},...(request.method()==='POST'?{payload:request.postDataJSON()}:{})})
                return route.fulfill({status:reply.statusCode,contentType:'application/json',body:reply.body})
              }
              const file=url.pathname==='/cooperation/'?'index.html':url.pathname.split('/').at(-1)!
              if(!/^[a-zA-Z0-9.-]+$/.test(file))return route.abort()
              return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:readFileSync(new URL('../../public/cooperation/'+file,import.meta.url))})
            })
            await page.goto('http://localhost/cooperation/')
            await page.getByRole('button',{name:'查看汇总'}).click()
            await page.getByRole('button',{name:'确认汇总金额'}).click()
            await page.locator('#message').filter({hasText:'已保存'}).waitFor()
            expect(await page.locator('#balance').innerText()).toContain('¥7.00')
            expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
            mkdirSync(process.env.CHANNEL_CLOSURE_DEMO_DIR,{recursive:true})
            await page.screenshot({path:process.env.CHANNEL_CLOSURE_DEMO_DIR+'/partner-confirmed.png',fullPage:true})
            expect(errors).toEqual([])
          }finally{await browser.close()}
        }else{
          const response=await app.inject({method:'POST',url:'/cooperation/statement-response',headers:{...headers,host:'localhost',origin:'https://www.shmbox.com','x-channel-web':'1','idempotency-key':'channel-'+randomUUID()},payload:{id:statement.id,dispute:false,reason:'隔离演示核对'}})
          expect(response.statusCode,response.body).toBe(200)
        }
        await finance(app,{action:'approve',id:statement.id},403)
        await finance(peer,{action:'approve',id:statement.id})
        const payout=await finance(app,{action:'start-payment',id:statement.id,amountMinor:700,reference:'DEMO-PAYOUT-'+randomUUID()})
        await finance(app,{action:'start-payment',id:statement.id,amountMinor:700,reference:'DEMO-DUPLICATE-'+randomUUID()},409)
        await finance(peer,{action:'confirm-payment',id:payout.id,success:true,reference:'DEMO-RECEIPT-'+randomUUID()})
        const final=await app.inject({method:'GET',url:'/cooperation/partner',headers})
        expect(final.json().data.balance).toMatchObject({accruedMinor:'700',paidMinor:'700',balanceMinor:'0'})
        for(const value of [cid,order.id,session])expect(final.body).not.toContain(value)
        expect(JSON.stringify(final.json().data.visits)).not.toContain('推荐饮品')
        await miniPage.load();expect(miniPage.data.coupons[0].status).toBe('fulfilled')
        expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[batchId])).rows[0].n).toBe(1)
        stage('已用券不复活',miniPage.data.coupons);stage('佣金7元结清与脱敏',final.json())
        const financeView=(await app.inject({method:'GET',url:'/staff/channel/finance'})).json();expect(financeView.data.payouts.find((p:any)=>p.id===payout.id)).toMatchObject({promoterId:demoPromoter,status:'succeeded',amountMinor:'700'});stage('财务最终状态',financeView)
        if(process.env.CHANNEL_CLOSURE_DEMO_DIR)writeFileSync(process.env.CHANNEL_CLOSURE_DEMO_DIR+'/lifecycle.json',JSON.stringify(evidence,null,2))
      }finally{await peer.close();miniPage.onUnload()}
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.payments WHERE order_id=$1',[order.id])).rows[0].n).toBe(1)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.refunds WHERE payment_id=$1',[payment.value.id])).rows[0].n).toBe(1)
  },30_000)
  it('passes a promised gift through the real quantity production and delivery path without consuming stock or commission twice',async()=>{
    const gift=await giftProduct(1),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),claim=await issue(b.code,cid)
    const active=await activate(claim.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const first=await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:claim.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    const item=(await admin.query('SELECT i.id,t.id AS task FROM mbox.order_items i JOIN mbox.kds_tasks t ON t.order_item_id=i.id WHERE i.order_id=$1',[first.result.orderId])).rows[0]
    const finish={itemId:item.id,taskId:item.task,employeeId:employee,quantity:1,eventKey:randomUUID()},deliver={...finish,eventKey:randomUUID()}
    await runner.run(scope,async tx=>{
      const production=new ItemQuantityFulfillmentRepository(tx)
      await production.complete(finish);expect((await production.complete(finish)).replayed).toBe(true)
      await production.deliver(deliver);expect((await production.deliver(deliver)).replayed).toBe(true)
    })
    const inventory=(await admin.query('SELECT on_hand_quantity::text AS hand,reserved_quantity::text AS held FROM mbox.inventory_balances WHERE inventory_item_id=$1',[gift.iid])).rows[0]
    expect(Number(inventory.hand)).toBe(0);expect(Number(inventory.held)).toBe(0)
    expect(await runner.run(scope,tx=>readCheckoutPrintSummary(tx,[first.result.orderId]))).toMatchObject({received:0,due:0,state:'paid'})
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(active.visitId!))).toMatchObject({basis:0,target:0})
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.payments WHERE order_id=$1',[first.result.orderId])).rows[0].n).toBe(0)
  })
  async function financeFixture(observationDays=0,provider='cash'){
    await admin.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3,$1,$2,'CHANNEL_REVIEW','复核员工') ON CONFLICT DO NOTHING`,[...args,reviewer])
    const pid=randomUUID(),rid=randomUUID(),owner=await customer(),campaign=randomUUID()
    await admin.query(`INSERT INTO mbox.channel_partners(id,tenant_id,store_id,name,settlement_subject) VALUES($3,$1,$2,'结算测试餐厅','结算测试公司')`,[...args,pid])
    await admin.query(`INSERT INTO mbox.channel_promoters(id,tenant_id,store_id,partner_id,name,customer_id,can_confirm_statement) VALUES($3,$1,$2,$4,'测试推荐人',$5,true)`,[...args,rid,pid,owner])
    await admin.query(`INSERT INTO mbox.channel_campaigns(id,tenant_id,store_id,title,claim_limit,capacity_limit,cost_limit_minor,accepting_claims,staff_entry_enabled,self_entry_enabled) VALUES($3,$1,$2,'finance',10,10,100000,true,true,true)`,[...args,campaign])
    const b=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:campaign,promoterId:rid,rule:{...rule,observationDays},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[b.id])
    const cid=await customer(),session=await table([cid]),coupon=await issue(String(b.offerCode),cid),activation=await activate(coupon.claimId,cid,session)
    const quote=await prepare(session),order=await consumePrice(session,quote.id)
    await admin.query(`UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1`,[order.id])
    const payment=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,status,succeeded_at) VALUES($3::uuid,$1,$2,$4,$3::text,$5,$3::text,$6,9000,'succeeded',clock_timestamp())`,[...args,payment,order.id,provider,provider==='cash'?'cash':'jsapi'])
    await admin.query(`UPDATE mbox.channel_visits SET closed_at=clock_timestamp() WHERE id=$1`,[activation.visitId])
    const account=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).account(pid,'secure-file:acct-v1',employee,'已核对合作主体'))
    await runner.run(scope,tx=>new ChannelFinanceRepository(tx).verifyAccount(account.id,reviewer,'独立复核账户原件'))
    return{pid,rid,owner,order,payment,visitId:activation.visitId!,account:account.id}
  }
  async function financeRefund(f:Pick<Awaited<ReturnType<typeof financeFixture>>,'payment'|'order'>,value:number,status='succeeded'){
    const id=randomUUID()
    await admin.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($3::uuid,$1,$2,$4,$3::text,$3::text,$5,$6,'退款',$7,$8,'独立审核',CASE WHEN $6='succeeded' THEN clock_timestamp() ELSE NULL END)`,[...args,id,f.payment,value,status,employee,reviewer])
    await admin.query(`INSERT INTO mbox.refund_items(tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,$5,'CNY')`,[...args,id,f.order.items[0]!.id,value])
    return id
  }
  it('renders an actual partner HTTP settlement timestamp with the shipped cooperation formatter without exposing order identity',async()=>{
    const f=await financeFixture(),statement=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'完整记录核对'))
    const response=await app.inject({method:'GET',url:'/cooperation/partner',headers:await webSession(f.rid)})
    expect(response.statusCode,response.body).toBe(200)
    const data=response.json().data,row=data.statements.find((s:{id:string})=>s.id===statement.id)
    expect(row).toBeTruthy()
    const source=readFileSync('public/cooperation/app.js','utf8'),format=vm.runInNewContext(source.slice(source.indexOf('const beijing ='),source.indexOf('\nfunction renderRows'))+';beijing',{Date,Intl:undefined})
    const expected=(await admin.query("SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI') AS value FROM mbox.channel_statements WHERE id=$1",[statement.id])).rows[0].value
    expect(format(row.createdAt)).toBe(expected)
    expect(JSON.stringify(data)).not.toContain(f.order.id)
    expect(JSON.stringify(data)).not.toContain(f.order.items[0]!.id)
    expect(JSON.stringify(data)).not.toContain(f.owner)
  })
  it('keeps wallet redemption history and spent capacity after failed, partial and full refunds',async()=>{
    const f=await financeFixture()
    const claim=(await admin.query(`SELECT q.id,q.customer_id,a.id AS activation_id FROM mbox.channel_claims q JOIN mbox.channel_activations a ON a.claim_id=q.id WHERE a.visit_id=$1`,[f.visitId])).rows[0]
    const worker=new ChannelReconciliationWorker(runner)
    await worker.runBatch(scope,'wallet-before-refund')
    const wallet=()=>runner.run(scope,tx=>new ChannelDistributionRepository(tx).walletPage(claim.customer_id,{claimId:claim.id}))
    expect((await wallet()).items[0]).toMatchObject({id:claim.id,status:'fulfilled'})
    const reconcile=()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))
    const pending=await financeRefund(f,2000,'processing')
    expect(await reconcile()).toMatchObject({frozen:true})
    await admin.query("UPDATE mbox.refunds SET status='failed',completed_at=clock_timestamp() WHERE id=$1",[pending])
    expect(await reconcile()).toMatchObject({basis:9000,target:900,frozen:false})
    await financeRefund(f,2000);expect(await reconcile()).toMatchObject({basis:7000,target:700})
    await financeRefund(f,7000)
    await worker.runBatch(scope,'wallet-after-refund');await worker.runBatch(scope,'wallet-after-refund-retry')
    expect(await reconcile()).toMatchObject({basis:0,target:0,deltaMinor:0,frozen:false})
    expect((await wallet()).items[0]).toMatchObject({id:claim.id,status:'fulfilled'})
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[claim.activation_id])).rows[0].used).toBe('1000')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_price_releases WHERE activation_id=$1',[claim.activation_id])).rows[0].n).toBe(0)
    await admin.query('UPDATE mbox.table_session_customer_participations SET left_at=clock_timestamp() WHERE customer_id=$1 AND left_at IS NULL',[claim.customer_id])
    const another=await table([claim.customer_id])
    await expect(activate(claim.id,claim.customer_id,another)).rejects.toMatchObject({code:'VERSION_CONFLICT'})
    expect((await admin.query('SELECT sum(commission_delta_minor)::text AS net FROM mbox.channel_ledger WHERE visit_id=$1',[f.visitId])).rows[0].net).toBe('0')
  })
  it('expires unused wallet coupons before the worker, preserves active transfer promises, and never revives an expired cancellation',async()=>{
    const b=await batch({totalClaims:2,perCustomerClaims:2}),cid=await customer(),session=await table([cid])
    const used=await issue(b.code,cid),unused=await issue(b.code,cid),a=await activate(used.claimId,cid,session)
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",[[used.claimId,unused.claimId]])
    const wallet=()=>runner.run(scope,tx=>new ChannelDistributionRepository(tx).walletPage(cid))
    const before=(await wallet()).items
    expect(before.find(q=>q.id===unused.claimId)?.status).toBe('expired')
    expect(before.find(q=>q.id===used.claimId)?.status).toBe('active')
    const moved=await app.inject(await moveRequest(session,await emptyMovementTable(),'whole_table_transfer'))
    expect(moved.statusCode,moved.body).toBe(200)
    expect(await activate(used.claimId,cid,session)).toMatchObject({reused:true,activationId:a.activationId})
    expect((await prepare(session)).discountMinor).toBe(1000)
    await runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(a.activationId!,session,employee,'过期后取消未使用绑定'))
    expect((await wallet()).items.every(q=>q.status==='expired')).toBe(true)
    await expect(activate(used.claimId,cid,session)).rejects.toMatchObject({code:'VERSION_CONFLICT'})
    await expect(activate(unused.claimId,cid,session)).rejects.toThrow()
    await expect(issue(b.code,cid)).rejects.toThrow()
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(2)
  })
  it.each(['response-lost','receipt-truncated'])('runs real mini page and HTTP concurrent activation, refund lock, transfer and recovery: %s',async fault=>{
    const {liveMiniHarness}=createRequire(import.meta.url)('../../scripts/miniprogram-live-contract-harness.mjs')
    const cid=await customer(),session=await table([cid]),b=await batch({minimumMinor:0,observationDays:0,allowStacking:true,visitDiscountCapMinor:3000,offer:{kind:'discount',discountBps:1000,maximumMinor:3000}})
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')",[...args,session,cid])
    const actorRef=await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:cid})
    const guest=Fastify()
    await guest.register(channelDistributionApiPlugin,{prefix:'/api',transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveSelfContext:async()=>({scope,customerId:cid,tableSessionId:null,businessDate:'2026-11-12',actorRef:`customer:${cid}`}),
      resolveGuestContext:async()=>({scope,customerId:cid,tableSessionId:session,businessDate:'2026-11-12',actorRef}),
      resolveStaffContext:async()=>({scope,employeeId:employee,businessDate:'2026-11-12'})})
    const { rows: [activeTable] } = await admin.query<{code: string}>(`
      SELECT t.code FROM mbox.table_sessions s JOIN mbox.tables t ON t.id=s.table_id WHERE s.id=$1
    `, [session])
    let activationResponses=0
    const transport=async(call:any)=>{
      if(call.path.startsWith('/api/guest/session'))return{data:{data:{status:'active',table:activeTable}}}
      const reply=await guest.inject({method:call.method,url:call.path+call.query,headers:call.headers,...(call.method==='GET'?{}:{payload:call.data})})
      if(call.path==='/api/guest/channel/activate'&&++activationResponses===1&&reply.statusCode===200)
        return fault==='response-lost'?{networkError:true}:{data:{data:{}}}
      return{status:reply.statusCode,data:reply.json()}
    }
    let client=liveMiniHarness('miniprogram',transport)
    let page:any
    const openPage=()=>{
    vm.runInNewContext(readFileSync(new URL('../../miniprogram/pages/channel-coupons/index.js',import.meta.url),'utf8'),{
      Page:(value:unknown)=>{page=value},wx:client.runtime,Date,getApp:()=>({globalData:{}}),setTimeout:()=>1,clearTimeout:()=>{},
      require:(path:string)=>client.load(client.root+'/'+path.replace('../../','')),
    })
    page.data=structuredClone(page.data);page.setData=(patch:object)=>Object.assign(page.data,patch)
    }
    openPage()
    const refundConnection=await admin.connect()
    try{
      page.onLoad({code:b.code});await page.onShow();await page.claim()
      const claimId=page.data.coupons[0].id
      const staff={method:'POST' as const,url:'/staff/channel/activate',payload:{code:b.code,claimId,customerId:cid,tableSessionId:session}}
      const first=await Promise.all([page.useCoupon({currentTarget:{dataset:{id:claimId}}}),app.inject({...staff,headers:{'idempotency-key':'channel-'+randomUUID()}}),app.inject({...staff,headers:{'idempotency-key':'channel-'+randomUUID()}})])
      for(const response of first.slice(1))expect(response.statusCode,response.body).toBe(200)
      expect(client.modals).toHaveLength(1)
      expect(client.modals[0].content).toContain(activeTable!.code)
      expect(activationResponses).toBe(1)
      expect(page.data.error).toBeTruthy();expect(page.data.notice).toBe('')
      expect([...client.storage.keys()].filter((k:any)=>k.startsWith('mbox.command.v2:'))).toHaveLength(1)
      const firstCalls=client.calls.slice(),savedStorage=client.storage
      page.onUnload();client=liveMiniHarness('miniprogram',transport,{storage:savedStorage});openPage()
      client.storage.set('mbox.wechat.identity.principal.v1',{principalId:'other-account'})
      await expect(client.api.recoverChannelCoupon(claimId)).rejects.toMatchObject({code:'COMMAND_RECOVERY_NOT_FOUND'})
      expect(client.calls.filter((c:any)=>c.path==='/api/guest/channel/activate')).toHaveLength(0)
      client.storage.delete('mbox.wechat.identity.principal.v1')
      page.onLoad({code:b.code});await page.onShow()
      expect(page.data.coupons[0].canRecover).toBe(true)
      const activation=(await admin.query('SELECT id,visit_id FROM mbox.channel_activations WHERE claim_id=$1',[claimId])).rows
      expect(activation).toHaveLength(1)
      const visit=activation[0].visit_id,order=await consumePrice(session,(await prepare(session)).id),payment=await settleMovementOrder(order)
      await new ChannelReconciliationWorker(runner).runBatch(scope,'cross-before-refund')
      const staleQuote=await prepare(session)
      await refundConnection.query('BEGIN')
      const refundId=randomUUID(),pid=(await refundConnection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await refundConnection.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($3::uuid,$1,$2,$4,$3::text,$3::text,9000,'succeeded','并发全退',$5,$6,'独立复核',clock_timestamp())`,[...args,refundId,payment,employee,reviewer])
      await refundConnection.query(`INSERT INTO mbox.refund_items(tenant_id,store_id,refund_id,order_item_id,amount_minor,currency) VALUES($1,$2,$3,$4,9000,'CNY')`,[...args,refundId,order.items[0]!.id])
      const reconcile=runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visit))
      // Prove a real lock wait, rather than relying on request timing or sleep.
      await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true))
      const movement=app.inject(await moveRequest(session,await emptyMovementTable(),'whole_table_transfer'))
      const checkout=Promise.allSettled([consumePrice(session,staleQuote.id),consumePrice(session,staleQuote.id)])
      const recovery=page.recoverCoupon({currentTarget:{dataset:{id:claimId}}})
      await refundConnection.query('COMMIT')
      expect(await reconcile).toMatchObject({basis:0,target:0})
      const moved=await movement;expect(moved.statusCode,moved.body).toBe(200)
      expect((await checkout).map(r=>r.status)).toEqual(['rejected','rejected'])
      await recovery
      expect(page.data.error).toBe('');expect(page.data.coupons[0].status).toBe('fulfilled')
      const writes=[...firstCalls,...client.calls].filter((c:any)=>c.path==='/api/guest/channel/activate')
      expect(writes).toHaveLength(2);expect(writes[1].headers['idempotency-key']).toBe(writes[0].headers['idempotency-key']);expect(writes[1].headers['x-channel-recovery']).toBe('1')
      expect([...client.storage.keys()].filter((k:any)=>k.startsWith('mbox.command.v2:'))).toHaveLength(0)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE claim_id=$1',[claimId])).rows[0].used).toBe('1000')
      const positions=await Promise.all([1,2,3].map(()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visit))))
      for(const position of positions)expect(position).toMatchObject({basis:0,target:0,deltaMinor:0})
    }finally{page.onUnload();await refundConnection.query('ROLLBACK');refundConnection.release();await guest.close()}
  },30_000)
  it('deduplicates partial refund callbacks across table split, transfer and commission reconciliation',async()=>{
    const f=await financeFixture(0,'postar'),payment=(await admin.query('SELECT provider_transaction_id FROM mbox.payments WHERE id=$1',[f.payment])).rows[0]
    const source=f.order.tableSessionId!,claim=(await admin.query('SELECT q.id,q.customer_id,a.id AS activation_id FROM mbox.channel_claims q JOIN mbox.channel_activations a ON a.claim_id=q.id WHERE a.visit_id=$1',[f.visitId])).rows[0]
    // This fixture's finance helper closes the referral visit; reopen only this
    // synthetic party for a real split, then close it for final reconciliation.
    await admin.query('UPDATE mbox.channel_visits SET closed_at=NULL WHERE id=$1',[f.visitId])
    await admin.query("UPDATE mbox.orders SET status='completed',payment_status='paid',completed_at=clock_timestamp() WHERE id=$1",[f.order.id])
    await admin.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE order_item_id IN(SELECT id FROM mbox.order_items WHERE order_id=$1)",[f.order.id])
    const companion=await customer(),sourceTable=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].table_id
    await admin.query(`INSERT INTO mbox.table_session_customer_participations(tenant_id,store_id,public_id,table_session_id,table_id,customer_id,join_source,identity_level,confirmation_state,location_started_at) VALUES($1,$2,$3,$4,$5,$6,'employee_assisted','wechat','confirmed',clock_timestamp())`,[...args,randomUUID(),source,sourceTable,companion])
    const code=(await admin.query('SELECT b.offer_code FROM mbox.channel_claims q JOIN mbox.channel_batches b ON b.id=q.batch_id WHERE q.id=$1',[claim.id])).rows[0].offer_code
    const original={method:'POST' as const,url:'/staff/channel/activate',headers:{'idempotency-key':'channel-'+randomUUID()},payload:{code,claimId:claim.id,customerId:claim.customer_id,tableSessionId:source}}
    const initial=await app.inject(original);expect(initial.statusCode,initial.body).toBe(200)
    const split=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[claim.customer_id],1))
    expect(split.statusCode,split.body).toBe(200)
    const target=split.json().data.targetTableSessionId
    const oldClaimCount=(await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE customer_id=$1',[claim.customer_id])).rows[0].n
    const recovery=await app.inject({...original,headers:{...original.headers,'x-channel-recovery':'1'}})
    expect(recovery.statusCode,recovery.body).toBe(200);expect(recovery.json().meta.replayed).toBe(true)
    const rewritten=await app.inject({...original,headers:{...original.headers,'x-channel-recovery':'1'},payload:{...original.payload,tableSessionId:target}})
    expect(rewritten.statusCode,rewritten.body).toBe(409)
    const reused=await activate(claim.id,claim.customer_id,target)
    expect(reused).toMatchObject({reused:true,activationId:claim.activation_id,visitId:f.visitId})
    const payments=new PaymentCommandService(new NormalizedCommandExecutor(runner),new NormalizedPaymentCapabilityAuthorization(),new NormalizedProviderObservationAuthority())
    const observation=new VerifiedProviderObservationService(runner),integrationRef='channel-partial-refund-test'
    async function callback(refundId:string,amount:number,succeeded=true){
      const occurredAt=new Date().toISOString(),verifiedObservationId=await observation.recordRefund({scope,provider:'postar',verificationKind:'callback_signature',providerEventId:randomUUID(),integrationRef,refundPublicId:refundId,providerTransactionId:refundId,originalProviderTransactionId:payment.provider_transaction_id,reportedAmountMinor:amount,reportedCurrency:'CNY',status:succeeded?'succeeded':'failed',occurredAt,evidence:{fixture:true}})
      return{scope,actor:{type:'integration' as const,ref:integrationRef},businessDate:'2026-11-12',idempotencyKey:randomUUID(),requestFingerprint:randomUUID(),verifiedObservationId,refundPublicId:refundId,provider:'postar' as const,providerRefundId:refundId,originalProviderTransactionId:payment.provider_transaction_id,reportedAmountMinor:amount,reportedCurrency:'CNY',succeeded,occurredAt}
    }
    const first=await financeRefund(f,2000,'processing'),command=await callback(first,2000)
    const moved=app.inject(await moveRequest(target,await emptyMovementTable(),'whole_table_transfer'))
    const copies=await Promise.all([1,2,3,4].map(()=>payments.recordProviderRefundResult(command)))
    expect(copies.filter(row=>!row.replayed)).toHaveLength(1)
    expect((await moved).statusCode).toBe(200)
    const redelivery=await callback(first,2000)
    await payments.recordProviderRefundResult(redelivery)
    await expect(callback(first,2000,false).then(input=>payments.recordProviderRefundResult(input))).rejects.toThrow()
    await expect(callback(first,2001).then(input=>payments.recordProviderRefundResult(input))).rejects.toThrow()
    const second=await financeRefund(f,1000,'processing')
    await payments.recordProviderRefundResult(await callback(second,1000))
    await payments.recordProviderRefundResult(await callback(second,1000))
    await admin.query('UPDATE mbox.channel_visits SET closed_at=clock_timestamp() WHERE id=$1',[f.visitId])
    const reconciled=await Promise.all([1,2,3].map(()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))))
    for(const row of reconciled)expect(row).toMatchObject({basis:6000,target:600,frozen:false})
    expect((await admin.query("SELECT count(*)::int AS n,sum(amount_minor)::text AS amount FROM mbox.refunds WHERE payment_id=$1 AND status='succeeded'",[f.payment])).rows[0]).toEqual({n:2,amount:'3000'})
    expect((await admin.query("SELECT count(*)::int AS n,sum(amount_minor)::text AS amount FROM mbox.reconciliation_entries WHERE refund_id=ANY($1::uuid[]) AND entry_type='refund'",[[first,second]])).rows[0]).toEqual({n:2,amount:'-3000'})
    expect((await admin.query('SELECT sum(commission_delta_minor)::text AS amount FROM mbox.channel_ledger WHERE visit_id=$1',[f.visitId])).rows[0].amount).toBe('600')
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[claim.activation_id])).rows[0].used).toBe('1000')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE customer_id=$1',[claim.customer_id])).rows[0].n).toBe(oldClaimCount)
  },30_000)
  it.each([4500,9000])('reprices new consumption after refund %i across two split tables without restoring spent capacity',async refundMinor=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:2500,observationDays:0,offer:{kind:'discount',discountBps:1000,maximumMinor:5000}})
    const owner=await customer(),companion=await customer(),source=await table([owner,companion]),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const original=await consumePrice(source,(await prepare(source)).id),payment=await settleMovementOrder(original)
    const split=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1))
    expect(split.statusCode,split.body).toBe(200);const target=split.json().data.targetTableSessionId
    const stale=await prepare(source)
    await financeRefund({payment,order:original},refundMinor)
    await expect(consumePrice(source,stale.id)).rejects.toThrow()
    for(const tableId of [source,target]){
      const rows=await app.inject({method:'GET',url:`/staff/channel/table/${tableId}`})
      expect(rows.statusCode,rows.body).toBe(200)
      expect(rows.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId,usedDiscountMinor:'1000',visitDiscountCapMinor:2500})])
    }
    if(refundMinor===9000){
      // A full refund cannot recreate the already spent first ten yuan. The
      // next ordinary order builds new eligible spend, with the same source.
      await expect(prepare(target)).rejects.toThrow('尚无可抵扣')
      const ordinary=await runner.run(scope,tx=>new OrderRepository(tx).createSubmitted({tableSessionId:target,publicId:randomUUID(),channel:'staff_assisted',lines:[{productId:product,quantity:1}],createdByEmployeeId:employee}))
      expect(ordinary.totalAmountMinor).toBe(10000);await settleMovementOrder(ordinary)
    }
    const {loadMiniModule}=createRequire(import.meta.url)('../../scripts/load-miniprogram-test-module.mjs')
    const utils=loadMiniModule(new URL('../../miniprogram/utils/checkout-coupons.js',import.meta.url))
    const page:any={...utils.checkoutCouponMethods({quoteChannel:async()=>({...await prepare(target),current:true,sourceType:'channel_quote',generation:1,version:1}),money:(n:number)=>(n/100).toFixed(2),randomId:()=>randomUUID(),scope:()=>target,errorMessage:(e:Error)=>e.message}),data:{...structuredClone(utils.initialCheckoutCoupons),busy:false,cart:[],cartGeneration:1,cartVersion:1,checkoutConfirmVisible:true},setData(patch:object){Object.assign(this.data,patch)}}
    const nextDiscount=refundMinor===4500?500:1000
    await page.quoteCheckoutChannel()
    expect(page.data.couponQuoteTotal).toBe(((10000-nextDiscount)/100).toFixed(2));expect(page.couponCheckoutReady()).toBe(true)
    const q=page.data.couponQuote
    expect(menuCheckoutPricing({originalMinor:10000,quote:{...q,fingerprint:'target-cart'},fingerprint:'target-cart',now:Date.now()})).toMatchObject({amountMinor:10000-nextDiscount,discountMinor:nextDiscount})
    const quotes=await Promise.all([prepare(source),prepare(target)])
    expect(quotes.map(q=>q.discountMinor)).toEqual([nextDiscount,nextDiscount])
    const attempts=await Promise.allSettled([consumePrice(source,quotes[0]!.id),consumePrice(target,quotes[1]!.id)])
    const winners=attempts.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof consumePrice>>>=>r.status==='fulfilled')
    expect(winners).toHaveLength(1);await settleMovementOrder(winners[0]!.value)
    await expect(runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(active.activationId!,target,employee,'已消费后不能撤销恢复额度'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
    const lastDiscount=2500-1000-nextDiscount
    await page.quoteCheckoutChannel();expect(page.data.couponQuote.discountMinor).toBe(lastDiscount)
    const last=await consumePrice(target,page.data.couponQuote.id);expect(last.totalAmountMinor).toBe(10000-lastDiscount);await settleMovementOrder(last)
    await page.quoteCheckoutChannel();expect(page.data.couponQuote).toBeNull();expect(page.couponCheckoutReady()).toBe(false)
    expect(menuCheckoutPricing({originalMinor:10000,quote:null,fingerprint:'target-cart',now:Date.now(),needsReview:page.data.couponNeedsReview})).toMatchObject({amountMinor:null,needsReview:true})
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[[source,target]])
    const amounts=await Promise.all([1,2,3].map(()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(active.visitId!))))
    for(const amount of amounts)expect(amount).toMatchObject({basis:refundMinor===4500?23000:28500,target:refundMinor===4500?2300:2850,frozen:false})
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('2500')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE claim_id=$1',[coupon.claimId])).rows[0].n).toBe(1)
  },30_000)
  it('isolates two staff actors sharing a mistaken command number, then reuses the same split-party binding',async()=>{
    const otherEmployee=randomUUID()
    await admin.query(`INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3::uuid,$1,$2,$3::text,'并发员工')`,[...args,otherEmployee])
    await grantFixtureStaffPermissions(admin,scope,[otherEmployee],['channel.activate','table.view_all'])
    const otherApp=Fastify()
    await otherApp.register(channelDistributionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),resolveSelfContext:async()=>{throw new Error('not a customer')},resolveGuestContext:async()=>{throw new Error('not a guest')},resolveStaffContext:async()=>({scope,employeeId:otherEmployee,businessDate:'2026-11-12'})})
    try{
      const b=await batch(),owner=await customer(),companion=await customer(),source=await table([owner,companion]),coupon=await issue(b.code,owner)
      const request={method:'POST' as const,url:'/staff/channel/activate',headers:{'idempotency-key':'channel-'+randomUUID()},payload:{code:b.code,claimId:coupon.claimId,customerId:owner,tableSessionId:source}}
      const results=await Promise.all([app.inject(request),otherApp.inject(request)])
      expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
      const winner=results[0]!.statusCode===200?app:otherApp,loser=winner===app?otherApp:app
      const denied=await loser.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}});expect(denied.statusCode).toBe(409)
      const move=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1));expect(move.statusCode,move.body).toBe(200)
      const target=move.json().data.targetTableSessionId
      const recovered=await winner.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().meta.replayed).toBe(true)
      const confirmed=await loser.inject({...request,headers:{'idempotency-key':'channel-'+randomUUID()},payload:{...request.payload,tableSessionId:target}})
      expect(confirmed.statusCode,confirmed.body).toBe(200);expect(confirmed.json().data.activationId).toBe(recovered.json().data.activationId);expect(confirmed.json().data.reused).toBe(true)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE claim_id=$1',[coupon.claimId])).rows[0].n).toBe(1)
    }finally{await otherApp.close()}
  })
  it('accrues net paid eligible goods once and appends partial/full refund deltas without rounding drift',async()=>{
    const f=await financeFixture(),reconcile=()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))
    expect(await reconcile()).toMatchObject({basis:9000,target:900,deltaMinor:900,frozen:false})
    expect(await reconcile()).toMatchObject({deltaMinor:0})
    await financeRefund(f,2000)
    expect(await reconcile()).toMatchObject({basis:7000,target:700,deltaMinor:-200})
    expect(await reconcile()).toMatchObject({deltaMinor:0})
    await financeRefund(f,7000)
    expect(await reconcile()).toMatchObject({basis:0,target:0,deltaMinor:-700})
    const ledger=(await admin.query('SELECT sum(commission_delta_minor)::text AS net,count(*)::int AS n FROM mbox.channel_ledger WHERE visit_id=$1',[f.visitId])).rows[0]
    expect(ledger).toEqual({net:'0',n:3})
  })
  it('requires maturity, freezes pending refunds and excludes simulation receipts',async()=>{
    const f=await financeFixture(7)
    await expect(runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'生成周结'))).rejects.toThrow('没有已成熟')
    await financeRefund(f,1000,'processing')
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))).toMatchObject({frozen:true,reasons:['退款待核实']})
    const test=await financeFixture(0,'simulation')
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(test.visitId))).toMatchObject({basis:0,target:0})
  })
  it('freezes unsettled extra payment attempts even when one original receipt has succeeded',async()=>{
    const f=await financeFixture(),id=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($3::uuid,$1,$2,$4,$3::text,'postar','jsapi',100,'pending')`,[...args,id,f.order.id])
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))).toMatchObject({basis:9000,target:900,frozen:true,reasons:['付款待核实']})
    await expect(runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'未知款未核对'))).rejects.toThrow('没有已成熟')
  })
  it('waits on an uncommitted refund fact before registering any commission payout',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'并发退款验证'))
    await run(r=>r.respond(statement.id,f.owner,false,'确认'));await run(r=>r.approve(statement.id,reviewer,'复核'))
    const source=await admin.connect(),refundId=randomUUID()
    let attempt:Promise<unknown>|undefined
    try{
      await source.query('BEGIN')
      const pid=(await source.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await source.query(`INSERT INTO mbox.refunds(id,tenant_id,store_id,payment_id,public_id,provider_refund_id,amount_minor,status,reason,requested_by_employee_id,approved_by_employee_id,decision_reason,completed_at) VALUES($3::uuid,$1,$2,$4,$3::text,$3::text,2000,'succeeded','并发退款',$5,$6,'复核',clock_timestamp())`,[...args,refundId,f.payment,employee,reviewer])
      attempt=run(r=>r.startPayment(statement.id,900,randomUUID(),employee,'读取真实退款后才可付款')).then(value=>({value}),error=>({error}))
      let blocked=false
      for(let n=0;n<100;n++){
        blocked=(await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked
        if(blocked)break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(blocked).toBe(true)
      await source.query('COMMIT')
      const result=await attempt as {error?:Error};expect(result.error?.message).toMatch(/调整|金额|余额/)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_payouts WHERE statement_id=$1',[statement.id])).rows[0].n).toBe(0)
    }finally{await source.query('ROLLBACK');source.release();await attempt}
  })
  it('settles with partner confirmation, separate approval, partial payment, unknown-payment block and bank returns',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'本周对账'))
    expect(statement.amountMinor).toBe(900)
    await expect(run(r=>r.statement(f.rid,f.account,employee,'重复出单'))).rejects.toThrow('没有已成熟')
    await expect(run(r=>r.approve(statement.id,reviewer,'尚未确认'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    const outsider=await customer()
    await expect(run(r=>r.respond(statement.id,outsider,false,'冒领确认'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await run(r=>r.respond(statement.id,f.owner,false,'核对原单无误'))
    await expect(run(r=>r.approve(statement.id,employee,'自审'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await run(r=>r.approve(statement.id,reviewer,'独立审批'))
    const pay=await run(r=>r.startPayment(statement.id,400,randomUUID(),employee,'已发起线下付款待查账'))
    await expect(run(r=>r.startPayment(statement.id,400,randomUUID(),employee,'重付'))).rejects.toThrow('状态不明')
    await expect(run(r=>r.confirmPayment(pay.id,true,randomUUID(),employee,'自审'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await run(r=>r.confirmPayment(pay.id,true,'bank-'+randomUUID(),reviewer,'原银行回单核实'))
    const second=await run(r=>r.startPayment(statement.id,500,randomUUID(),employee,'尾款待查'))
    await run(r=>r.confirmPayment(second.id,false,'failed-'+randomUUID(),reviewer,'银行明确失败'))
    await run(r=>r.returnPayment(pay.id,100,randomUUID(),reviewer,'银行退回一百'))
    const overview=await run(r=>r.overview(f.rid))
    expect(overview.statements[0]).toMatchObject({paidMinor:'300'})
    await expect(run(r=>r.returnPayment(pay.id,301,randomUUID(),reviewer,'超退'))).rejects.toThrow('超过')
  })
  it('rejects approval after a refund and carries an already paid refund as a negative balance',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const s=await run(r=>r.statement(f.rid,f.account,employee,'周结'))
    await run(r=>r.respond(s.id,f.owner,false,'确认'))
    await run(r=>r.approve(s.id,reviewer,'审批'))
    const pay=await run(r=>r.startPayment(s.id,900,randomUUID(),employee,'付款'))
    await run(r=>r.confirmPayment(pay.id,true,randomUUID(),reviewer,'已支付'))
    await financeRefund(f,2000)
    expect(await run(r=>r.reconcile(f.visitId))).toMatchObject({target:700,deltaMinor:-200})
    const adjustment=await run(r=>r.statement(f.rid,f.account,employee,'退款调整'))
    expect(adjustment.amountMinor).toBe(-200)
    expect((await run(r=>r.overview(f.rid))).statements.find(x=>x.id===s.id)).toMatchObject({paidMinor:'900'})
    await expect(run(r=>r.startPayment(s.id,1,randomUUID(),employee,'误付'))).rejects.toThrow()
  })

  it('checks publish approval, store-wide capacity, disabled-account authorization and statement ownership',async()=>{
    const b=await batch(),cid=await customer()
    await admin.query(`UPDATE mbox.channel_batches SET created_by=$2,accepting_claims=false WHERE id=$1`,[b.id,employee])
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).publish(b.id,true,employee,'自己发布'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).publish(b.id,true,reviewer,'独立审核规则和成本'))
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(0,0,0,employee,'暂停全店新增承诺'))
    await expect(issue(b.code,cid)).rejects.toMatchObject({code:'STORE_LIMIT'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复测试上限'))
    const f=await financeFixture(),statement=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'生成对账'))
    await expect(runner.run(scope,tx=>new ChannelFinanceRepository(tx).statementDetail(statement.id,promoter))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    expect((await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statementDetail(statement.id,f.rid))).lines).toHaveLength(1)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).promoter(f.rid,false,false,false,employee,employee,'离职停用'))
    await expect(runner.run(scope,tx=>new ChannelPartnerRepository(tx).dashboard(f.owner))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
  })
  it('continues partially paid commissions through new verified bank accounts without reusing ledger amounts',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const approve=async(id:string)=>{await run(r=>r.respond(id,f.owner,false,'核对尾款'));await run(r=>r.approve(id,reviewer,'独立审批'))}
    const pay=async(id:string,value:number)=>{const p=await run(r=>r.startPayment(id,value,randomUUID(),employee,'按新账户付款'));await run(r=>r.confirmPayment(p.id,true,randomUUID(),reviewer,'核实银行回单'));return p}
    const account=async()=>{const a=await run(r=>r.account(f.pid,'new-bank-'+randomUUID(),employee,'更换收款账户'));await run(r=>r.verifyAccount(a.id,reviewer,'独立核对新账户'));return a}
    const original=await run(r=>r.statement(f.rid,f.account,employee,'原周结单'));await approve(original.id);const first=await pay(original.id,400)
    const a2=await account(),tail=await run(r=>r.reissueAccount(original.id,a2.id,employee,'已付四元，剩余换账户'))
    expect(tail).toMatchObject({amountMinor:500,sourceStatementId:original.id})
    await expect(run(r=>r.reissueAccount(original.id,a2.id,employee,'重复续结'))).rejects.toThrow('已有未结')
    await expect(run(r=>r.startPayment(tail.id,500,randomUUID(),employee,'未审批'))).rejects.toThrow('确认和独立审批')
    const detail=await run(r=>r.statementDetail(tail.id,f.rid));expect(detail.lines).toHaveLength(1);expect(detail.statement).not.toHaveProperty('accountReference')
    await approve(tail.id);await pay(tail.id,200)
    const a3=await account(),final=await run(r=>r.reissueAccount(tail.id,a3.id,employee,'再次换账户续结'))
    expect(final).toMatchObject({amountMinor:300,sourceStatementId:original.id});await approve(final.id)
    await expect(run(r=>r.startPayment(tail.id,100,randomUUID(),employee,'旧账户尾款'))).rejects.toThrow('账户版本已变化')
    await pay(final.id,300)
    await expect(run(r=>r.startPayment(final.id,1,randomUUID(),employee,'多付一分'))).rejects.toThrow('合计未付额')
    expect((await run(r=>r.overview(f.rid))).balances[0]).toMatchObject({accruedMinor:'900',paidMinor:'900',balanceMinor:'0'})
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_statement_lines WHERE statement_id=ANY($1::uuid[])',[[tail.id,final.id]])).rows[0].n).toBe(0)
    await run(r=>r.returnPayment(first.id,100,randomUUID(),reviewer,'原账户银行退回部分'))
    const returned=await run(r=>r.reissueAccount(original.id,a3.id,employee,'仅续结原银行退回部分'));expect(returned.amountMinor).toBe(100)
    await approve(returned.id);await pay(returned.id,100)
    expect((await run(r=>r.overview(f.rid))).balances[0]).toMatchObject({paidMinor:'900',balanceMinor:'0'})
  })
  it('does not use a changed bank account to bypass unknown payouts, disputes or later refunds',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const original=await run(r=>r.statement(f.rid,f.account,employee,'周结'));await run(r=>r.respond(original.id,f.owner,false,'确认'));await run(r=>r.approve(original.id,reviewer,'审批'))
    const unknown=await run(r=>r.startPayment(original.id,400,randomUUID(),employee,'待核付款'))
    const account=await run(r=>r.account(f.pid,'new-account-'+randomUUID(),employee,'账户变更'));await run(r=>r.verifyAccount(account.id,reviewer,'核实'))
    await expect(run(r=>r.reissueAccount(original.id,account.id,employee,'未知款续结'))).rejects.toThrow('状态不明')
    await run(r=>r.confirmPayment(unknown.id,true,randomUUID(),reviewer,'核实到账'))
    const tail=await run(r=>r.reissueAccount(original.id,account.id,employee,'核实后续结'))
    await run(r=>r.respond(tail.id,f.owner,true,'尾款争议'))
    await expect(run(r=>r.reissueAccount(original.id,account.id,employee,'绕开争议'))).rejects.toThrow('争议')
    await financeRefund(f,100);await expect(run(r=>r.statement(f.rid,account.id,employee,'争议中的新调整'))).rejects.toThrow('没有已成熟')
    await run(r=>r.cancel(tail.id,employee,'证据核对后重出'))
    const revised=await run(r=>r.reissueAccount(original.id,account.id,employee,'解决争议后续结'));await run(r=>r.respond(revised.id,f.owner,false,'确认'))
    await financeRefund(f,1000)
    await expect(run(r=>r.approve(revised.id,reviewer,'退款后旧金额'))).rejects.toThrow('新调整')
    expect((await run(r=>r.overview(f.rid))).balances[0].paidMinor).toBe('400')
  })
  it('corrects only selected order attribution with balanced old/new commission deltas and immutable original records',async()=>{
    const first=await financeFixture(),second=await financeFixture()
    await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(first.visitId))
    const original=(await admin.query('SELECT * FROM mbox.channel_order_attributions WHERE order_id=$1',[first.order.id])).rows[0]
    const target=(await admin.query('SELECT source_batch_id FROM mbox.channel_visits WHERE id=$1',[second.visitId])).rows[0].source_batch_id
    const correction=await runner.run(scope,tx=>new ChannelOperationsRepository(tx).correctOrders([first.order.publicId],target,employee,'原始推荐截图和错绑工单123'))
    const rows=(await admin.query('SELECT visit_id,sum(commission_delta_minor)::text AS amount FROM mbox.channel_ledger WHERE visit_id=ANY($1::uuid[]) GROUP BY visit_id',[[first.visitId,correction.visitId]])).rows
    expect(rows.find(r=>r.visit_id===first.visitId).amount).toBe('0');expect(rows.find(r=>r.visit_id===correction.visitId).amount).toBe('900')
    expect((await admin.query('SELECT * FROM mbox.channel_order_attributions WHERE order_id=$1',[first.order.id])).rows[0]).toEqual(original)
    expect((await admin.query('SELECT amount_minor::text FROM mbox.payments WHERE id=$1',[first.payment])).rows[0].amount_minor).toBe('9000')
  })
  it('requires renewed confirmation after refunds or account changes, and isolates disputed statements',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const s=await run(r=>r.statement(f.rid,f.account,employee,'周结'))
    await run(r=>r.respond(s.id,f.owner,false,'确认'))
    await financeRefund(f,1000)
    await expect(run(r=>r.approve(s.id,reviewer,'旧单审批'))).rejects.toThrow('新调整')
    await run(r=>r.cancel(s.id,employee,'撤旧单后重算'))
    const revised=await run(r=>r.statement(f.rid,f.account,employee,'退款后重出'))
    expect(revised.amountMinor).toBe(800)
    await run(r=>r.respond(revised.id,f.owner,true,'消费金额有异议'))
    await expect(run(r=>r.approve(revised.id,reviewer,'争议未结'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await run(r=>r.cancel(revised.id,employee,'完成争议核对后重出'))
    const final=await run(r=>r.statement(f.rid,f.account,employee,'证据核对完成'))
    await run(r=>r.respond(final.id,f.owner,false,'已核对无误'))
    const newAccount=await run(r=>r.account(f.pid,'secure-file:changed-account',employee,'收款主体资料新版'))
    await expect(run(r=>r.verifyAccount(newAccount.id,employee,'自审'))).rejects.toMatchObject({code:'NOT_AUTHORIZED'})
    await run(r=>r.verifyAccount(newAccount.id,reviewer,'独立复核资料'))
    await expect(run(r=>r.approve(final.id,reviewer,'原账户单'))).rejects.toThrow('账户版本已变化')
  })

  it('keeps delegated finance/operations/partner routes under the real 401 classifier',async()=>{
    const unauthenticated=Fastify()
    await unauthenticated.register(channelDistributionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),resolveStaffContext:async()=>{throw new NormalizedAuthenticationRequiredError()},resolveSelfContext:async()=>{throw new Error('unused')},resolveGuestContext:async()=>{throw new Error('unused')}})
    try{for(const url of ['/staff/channel/finance','/staff/channel/directory','/staff/channel/report']){
      const response=await unauthenticated.inject({method:'GET',url});expect(response.statusCode,response.body).toBe(401);expect(response.json().error.code).toBe('AUTH_REQUIRED')
    }
    const response=await unauthenticated.inject({method:'POST',url:'/staff/channel/operations',payload:{action:'limits'}});expect(response.statusCode).toBe(401)
    }finally{await unauthenticated.close()}
  })
  it('reports unknown costs explicitly and never subtracts discounts or refunds twice',async()=>{
    const f=await financeFixture();await financeRefund(f,2000);await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))
    const rows=await runner.run(scope,tx=>readChannelReport(tx),{readOnly:true})
    const id=(await admin.query('SELECT source_batch_id FROM mbox.channel_visits WHERE id=$1',[f.visitId])).rows[0].source_batch_id
    expect(rows.find(r=>r.id===id)).toMatchObject({netReceiptsMinor:'7000',commissionMinor:'700',costMinor:null,contributionMinor:null})
  })
  it('keeps a continued party on its original L and requires a supervisor decision before a recent reopen',async()=>{
    const b=await batch({perCustomerClaims:2}),cid=await customer(),session=await table([cid]),one=await issue(b.code,cid),first=await activate(one.claimId,cid,session)
    await admin.query(`UPDATE mbox.channel_visits SET closed_at=clock_timestamp() WHERE id=$1`,[first.visitId])
    await admin.query(`UPDATE mbox.channel_visit_tables SET detached_at=clock_timestamp() WHERE visit_id=$1`,[first.visitId])
    await admin.query(`UPDATE mbox.table_session_customer_participations SET left_at=clock_timestamp() WHERE customer_id=$1 AND left_at IS NULL`,[cid])
    const secondTable=await table([cid]),two=await issue(b.code,cid)
    await expect(activate(two.claimId,cid,secondTable)).rejects.toMatchObject({code:'CONTINUITY_REVIEW'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).continuity(secondTable,first.visitId!,cid,'continue',employee,'现场确认同批客人临时换桌续坐'))
    await expect(activate(two.claimId,cid,secondTable)).rejects.toMatchObject({code:'VISIT_LIMIT'})
  })
  it('previews only this offer and own claim counts without consuming quota or stock', async () => {
    const b=await batch(), c=await customer(); selfCustomer=c
    const offer=()=>app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    const first=await offer(); expect(first.statusCode,first.body).toBe(200)
    expect(first.json().data).toMatchObject({batchId:b.id,offerCode:b.code,claimedCount:0,existingClaimId:null,unavailable:null,sourceLabel:'楼下川菜'})
    expect(JSON.stringify(first.json())).not.toMatch(/commission|settlement|costMinor|customerId/)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
    const claim=await issue(b.token,c)
    const again=await offer(); expect(again.json().data).toMatchObject({claimedCount:1,existingClaimId:claim.claimId,unavailable:'您已达到本批次领取上限'})
    selfCustomer=await customer()
    expect((await offer()).json().data).toMatchObject({claimedCount:0,existingClaimId:null})
    const forged=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}&customerId=${c}`})
    expect(forged.statusCode).toBe(400)
    selfCustomer=await customer(false); expect((await offer()).statusCode).toBe(403)
  })
  it('shows expired or paused offers without allowing a claim and never exposes gift cost', async () => {
    await admin.query('UPDATE mbox.products SET cost_amount_minor=500 WHERE id=$1',[product])
    const b=await batch({claimFrom:new Date(now-7200000).toISOString(),claimUntil:new Date(now-3600000).toISOString(),offer:{kind:'gift',productId:product,quantity:1,costMinor:500}})
    selfCustomer=await customer()
    const result=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    expect(result.statusCode,result.body).toBe(200); expect(result.json().data.unavailable).toBe('已超过有效时间')
    expect(result.json().data.offer).not.toHaveProperty('costMinor')
    await expect(issue(b.code,selfCustomer)).rejects.toMatchObject({code:'EXPIRED'})
    const paused=await batch(); await admin.query('UPDATE mbox.channel_batches SET accepting_claims=false WHERE id=$1',[paused.id])
    expect((await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${paused.code}`})).json().data.unavailable).toContain('已暂停')
  })
  it('uses the official short scene and immutable cache without reissuing quota', async () => {
    const b=await batch(), before=miniCode.render.mock.calls.length
    const first=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}?format=data`})
    expect(first.statusCode,first.body).toBe(200)
    expect(miniCode.render.mock.calls[before]?.[0]).toEqual({page:'pages/channel-coupons/index',scene:`CH_${b.code}`,environment:'release',width:430})
    const again=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}?format=data`})
    expect(again.json().data).toEqual(first.json().data); expect(miniCode.render.mock.calls.length).toBe(before+1)
    const snapshot=(await admin.query('SELECT snapshot FROM mbox.channel_poster_versions WHERE batch_id=$1',[b.id])).rows[0].snapshot
    expect(snapshot.entry).toEqual({appId:miniCode.appId,page:'pages/channel-coupons/index',scene:`CH_${b.code}`,environment:'release'})
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
  })
  it('regenerates pre-scope posters while keeping frozen product names and the original coupon',async()=>{
    const b=await batch({offer:{kind:'discount',discountBps:1500,maximumMinor:2000}})
    const row=(await admin.query(`SELECT b.promoter_id,b.offer_code AS code,b.public_token AS token,b.rule_snapshot AS rule,p.name AS source,
      b.accepting_claims AND c.accepting_claims AND r.status='active' AND p.status='active' AS accepting
      FROM mbox.channel_batches b JOIN mbox.channel_campaigns c ON c.id=b.campaign_id JOIN mbox.channel_promoters r ON r.id=b.promoter_id JOIN mbox.channel_partners p ON p.id=b.partner_id WHERE b.id=$1`,[b.id])).rows[0]
    row.rule=channelRuleSchema.parse(row.rule)
    const oldSnapshot={template:'channel-poster-official-v2',...row,entry:{appId:miniCode.appId,page:'pages/channel-coupons/index',scene:`CH_${b.code}`,environment:'release'}}
    const oldKey=createHash('sha256').update(JSON.stringify(oldSnapshot)).digest('hex'),oldPng=await sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}}).png().toBuffer()
    await admin.query('INSERT INTO mbox.channel_poster_versions(tenant_id,store_id,batch_id,artifact_key,sha256,png,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',[...args,b.id,oldKey,createHash('sha256').update(oldPng).digest('hex'),oldPng,oldSnapshot])
    const original=(await admin.query('SELECT rule_snapshot FROM mbox.channel_batches WHERE id=$1',[b.id])).rows[0].rule_snapshot
    await admin.query("UPDATE mbox.products SET name='当前已改名商品' WHERE id=$1",[product])
    try{
      const first=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}?format=data`});expect(first.statusCode,first.body).toBe(200);expect(first.json().data.artifactKey).not.toBe(oldKey)
      const artifact=(await admin.query('SELECT snapshot FROM mbox.channel_poster_versions WHERE batch_id=$1 AND artifact_key=$2',[b.id,first.json().data.artifactKey])).rows[0].snapshot
      expect(artifact.template).toBe('channel-poster-official-v3-scope');expect(artifact.rule.eligibleProductNames).toEqual(original.eligibleProductNames)
      const directory=await app.inject({method:'GET',url:`/staff/channel/directory?batchId=${b.id}`});expect(directory.json().data.batches.find((x:{id:string})=>x.id===b.id).rule).toEqual(original)
      const again=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}?format=data`});expect(again.json().data).toEqual(first.json().data)
      expect((await admin.query('SELECT count(*)::int n FROM mbox.channel_poster_versions WHERE batch_id=$1',[b.id])).rows[0].n).toBe(2)
      expect((await admin.query('SELECT rule_snapshot FROM mbox.channel_batches WHERE id=$1',[b.id])).rows[0].rule_snapshot).toEqual(original)
    }finally{await admin.query("UPDATE mbox.products SET name='推荐饮品' WHERE id=$1",[product])}
  })
  it('fills missing legacy display labels only in the poster snapshot without altering the saved scope',async()=>{
    const b=await batch(),legacy=randomUUID()
    await admin.query(`INSERT INTO mbox.channel_batches(id,tenant_id,store_id,campaign_id,partner_id,promoter_id,offer_code,public_token,rule_snapshot,contract_snapshot)
      SELECT $2,tenant_id,store_id,campaign_id,partner_id,promoter_id,'LEGACYAB2345',encode(gen_random_bytes(32),'hex'),rule_snapshot-'eligibleProductNames',contract_snapshot FROM mbox.channel_batches WHERE id=$1`,[b.id,legacy])
    const poster=await app.inject({method:'GET',url:`/staff/channel/poster/${legacy}?format=data`});expect(poster.statusCode,poster.body).toBe(200)
    const saved=(await admin.query('SELECT snapshot FROM mbox.channel_poster_versions WHERE batch_id=$1',[legacy])).rows[0].snapshot
    expect(saved.rule.eligibleProductIds).toEqual([product]);expect(saved.rule.eligibleProductNames).toEqual([{id:product,name:'推荐饮品'}])
    expect((await admin.query('SELECT rule_snapshot FROM mbox.channel_batches WHERE id=$1',[legacy])).rows[0].rule_snapshot).not.toHaveProperty('eligibleProductNames')
  })
  it('fails closed for an unreleased page or invalid platform image without archiving a fake QR', async () => {
    const b=await batch()
    miniCode.render.mockRejectedValueOnce(new WechatMiniProgramCodeError('微信小程序码场景或页面未获平台接受','WECHAT_MINI_CODE_CONTRACT_INVALID'))
    const failed=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}`})
    expect(failed.statusCode).toBe(503); expect(failed.json().error.code).toBe('WECHAT_MINI_CODE_CONTRACT_INVALID')
    miniCode.render.mockResolvedValueOnce(Buffer.from('not an image access_token=secret'))
    const invalid=await app.inject({method:'GET',url:`/staff/channel/poster/${b.id}`})
    expect(invalid.statusCode).toBe(503); expect(invalid.body).not.toContain('secret')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_poster_versions WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
  })
  it('refuses poster generation when official WeChat configuration is absent', async () => {
    const b=await batch(), unconfigured=Fastify()
    await unconfigured.register(channelDistributionApiPlugin,{transactions:runner,commands:new NormalizedCommandExecutor(runner),
      resolveSelfContext:async()=>{throw new Error('unused')},resolveGuestContext:async()=>{throw new Error('unused')},
      resolveStaffContext:async()=>({scope,employeeId:employee,businessDate:'2026-11-12'})})
    try {
      const result=await unconfigured.inject({method:'GET',url:`/staff/channel/poster/${b.id}`})
      expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe('WECHAT_MINI_CODE_CONFIGURATION_INVALID')
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_poster_versions WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
    } finally {await unconfigured.close()}
  })
  it('filters internal cost from original and replaced gifts in wallet, offer and direct-use data',async()=>{
    const a=await giftProduct(),replacement=await giftProduct(),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:a.pid,quantity:1,costMinor:999}})
    const cid=await customer();selfCustomer=cid;const coupon=await issue(b.code,cid)
    const wallet=()=>app.inject({method:'GET',url:'/public/mini/channel/wallet'})
    const preview=()=>app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    for(const response of [await wallet(),await preview()]){expect(response.statusCode,response.body).toBe(200);expect(response.body).not.toContain('costMinor')}
    const session=await table([cid]);await activate(coupon.claimId,cid,session)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(coupon.claimId,'replace-gift',employee,'更换赠品',{productId:replacement.pid,quantity:1,consent:'顾客同意'}))
    const changed=await preview();expect(changed.statusCode,changed.body).toBe(200)
    expect(changed.json().data.existingCoupon).toMatchObject({id:coupon.claimId,status:'active',offer:{productId:replacement.pid}})
    for(const response of [await wallet(),changed])expect(response.body).not.toContain('costMinor')
  })
  it('paginates beyond 100 coupons with timestamp ties and directly uses the old promoted coupon without reissuing',async()=>{
    const cid=await customer();selfCustomer=cid
    const target=await batch(),old=await issue(target.code,cid)
    const later=await batch({totalClaims:150,perCustomerClaims:120},{claim:200,capacity:200,cost:1000000})
    for(let i=0;i<100;i++)await issue(later.code,cid)
    await admin.query("UPDATE mbox.channel_claims SET issued_at=clock_timestamp()+interval '1 second' WHERE batch_id=$1",[later.id])
    // Force identical timestamps, including all fractional digits, to exercise the ID tie breaker.
    await admin.query('UPDATE mbox.channel_claims SET issued_at=(SELECT max(issued_at) FROM mbox.channel_claims WHERE batch_id=$1) WHERE batch_id=$1',[later.id])
    const preview=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${target.code}`})
    expect(preview.json().data.existingCoupon).toMatchObject({id:old.claimId,status:'available'})
    let cursor:string|null=null;const ids:string[]=[]
    do{const response=await app.inject({method:'GET',url:'/public/mini/channel/wallet?limit=30'+(cursor?'&cursor='+cursor:'')})
      expect(response.statusCode,response.body).toBe(200);ids.push(...response.json().data.map((item:{id:string})=>item.id));cursor=response.json().meta.nextCursor
    }while(cursor)
    expect(ids).toHaveLength(101);expect(new Set(ids).size).toBe(101);expect(ids).toContain(old.claimId)
    const filtered=await app.inject({method:'GET',url:`/public/mini/channel/wallet?code=${target.code}&status=available`})
    expect(filtered.json().data.map((item:{id:string})=>item.id)).toEqual([old.claimId])
    const before=(await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE customer_id=$1',[cid])).rows[0].n
    await activate(preview.json().data.existingCoupon.id,cid,await table([cid]))
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE customer_id=$1',[cid])).rows[0].n).toBe(before)
  })
  it('filters expired and revoked coupons after identity merge and rejects foreign cursors and forged filters',async()=>{
    const b=await batch({totalClaims:10,perCustomerClaims:5}),old=await customer(),canonical=await customer(),other=await customer()
    const valid=await issue(b.code,old),expired=await issue(b.code,old),revoked=await issue(b.code,old),foreign=await issue(b.code,other)
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 hour' WHERE id=$1",[expired.claimId])
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(revoked.claimId,'revoke',employee,'未兑现撤销'))
    const voided=await issue(b.code,old),fulfilled=await issue(b.code,old)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(voided.claimId,'void',employee,'未绑定错误发行冲销'))
    // Read-model fixture: a later fulfilled coupon must not hide the earlier usable one.
    await admin.query("UPDATE mbox.channel_claims SET status='fulfilled' WHERE id=$1",[fulfilled.claimId])
    await admin.query("UPDATE mbox.customers SET status='merged',merged_into_customer_id=$2 WHERE id=$1",[old,canonical]);selfCustomer=canonical
    for(const [status,id] of [['available',valid.claimId],['expired',expired.claimId],['revoked',revoked.claimId],['fulfilled',fulfilled.claimId]]){
      const response=await app.inject({method:'GET',url:'/public/mini/channel/wallet?status='+status})
      expect(response.statusCode,response.body).toBe(200);expect(response.json().data.map((item:{id:string})=>item.id)).toEqual([id])
    }
    const preview=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    expect(preview.json().data.existingCoupon.id).toBe(valid.claimId)
    for(const query of ['customerId='+other,'limit=1000','cursor=broken','status=made-up'])expect((await app.inject({method:'GET',url:'/public/mini/channel/wallet?'+query})).statusCode).toBe(400)
    expect((await app.inject({method:'GET',url:'/public/mini/channel/wallet?cursor='+foreign.claimId})).statusCode).toBe(404)
    expect((await app.inject({method:'GET',url:'/public/mini/channel/wallet?cursor='+valid.claimId})).statusCode).toBe(200)
  })
  it('paginates partner batches, visits and more than 500 statements without losing pending history or permitting cross-partner cursors',async()=>{
    const f=await financeFixture(),statement=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'分页原单'))
    const ownBatch=(await admin.query('SELECT id FROM mbox.channel_batches WHERE promoter_id=$1',[f.rid])).rows[0].id
    // Historical list fixtures, never payments or payable ledger entries.
    await admin.query(`INSERT INTO mbox.channel_batches(tenant_id,store_id,campaign_id,partner_id,promoter_id,offer_code,public_token,rule_snapshot,contract_snapshot)
      SELECT tenant_id,store_id,campaign_id,partner_id,promoter_id,'P'||lpad(translate(to_hex(n),'0123456789abcdef','ABCDEFGHIJKLMNOP'),11,'A'),encode(gen_random_bytes(32),'hex'),rule_snapshot,contract_snapshot FROM mbox.channel_batches CROSS JOIN generate_series(2,102) n WHERE id=$1`,[ownBatch])
    await admin.query(`INSERT INTO mbox.channel_visits(tenant_id,store_id,source_batch_id,locked_use_limit,opened_at) SELECT tenant_id,store_id,source_batch_id,locked_use_limit,'2026-11-12T01:00:00Z'::timestamptz FROM mbox.channel_visits CROSS JOIN generate_series(1,101) WHERE id=$1`,[f.visitId])
    await admin.query(`INSERT INTO mbox.channel_statements(tenant_id,store_id,promoter_id,account_id,amount_minor,cutoff_at,created_by,created_at)
      SELECT tenant_id,store_id,promoter_id,account_id,0,cutoff_at,created_by,'2026-11-12T01:00:00Z'::timestamptz FROM mbox.channel_statements CROSS JOIN generate_series(1,501) WHERE id=$1`,[statement.id])
    const headers=await webSession(f.rid)
    for(const [kind,count,original] of [['batches',102,ownBatch],['visits',102,f.visitId],['statements',502,statement.id]] as const){
      let cursor:string|null=null;const ids:string[]=[]
      do{const response=await app.inject({method:'GET',headers,url:`/cooperation/history?kind=${kind}&limit=100`+(cursor?'&cursor='+cursor:'')})
        expect(response.statusCode,response.body).toBe(200);ids.push(...response.json().data.map((item:{id?:string;visitNumber?:string})=>item.id??item.visitNumber));cursor=response.json().meta.nextCursor
      }while(cursor)
      expect(ids).toHaveLength(count);expect(new Set(ids).size).toBe(count);expect(ids).toContain(kind==='visits'?channelAnonymousVisit(f.rid,original):original)
    }
    const original=await app.inject({method:'GET',headers,url:'/cooperation/statement/'+statement.id})
    expect(original.statusCode,original.body).toBe(200);expect(original.json().data.lines).toHaveLength(1)
    expect(JSON.stringify(original.json().data.lines)).not.toMatch(/payments|refunds|principalMinor|costMinor|orderId|evidence|accountReference|visitId/)
    const foreign=await batch()
    expect((await app.inject({method:'GET',headers,url:'/cooperation/history?kind=batches&cursor='+foreign.id})).statusCode).toBe(403)
    expect((await app.inject({method:'GET',headers,url:'/cooperation/history?kind=batches&promoterId='+promoter})).statusCode).toBe(400)
    await admin.query("UPDATE mbox.channel_promoters SET status='disabled' WHERE id=$1",[f.rid])
    expect((await app.inject({method:'GET',headers,url:'/cooperation/history?kind=batches&cursor='+ownBatch})).statusCode).toBe(401)
  })
  it('binds a single-use promoter invitation and refuses cross-account data and posters', async () => {
    const invited = await customer(), outsider = await customer(), b = await batch()
    const invitation = await runner.run(scope, tx => new ChannelPartnerRepository(tx).invite(promoter, employee))
    await runner.run(scope, tx => new ChannelPartnerRepository(tx).accept(invitation.token, invited))
    await expect(runner.run(scope, tx => new ChannelPartnerRepository(tx).accept(invitation.token, outsider))).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    const own = await runner.run(scope, tx => new ChannelPartnerRepository(tx).dashboard(invited), { readOnly: true })
    expect(own.batches.some(row => row.id === b.id)).toBe(true)
    expect(JSON.stringify(own.batches)).not.toMatch(/costMinor|publicToken|contract_snapshot/)
    const headers=await webSession(promoter)
    const history=await app.inject({method:'GET',headers,url:'/cooperation/history?kind=batches'})
    expect(history.statusCode,history.body).toBe(200);expect(history.body).not.toMatch(/costMinor|publicToken|contract_snapshot/)
    expect(own.visits.every(row => !('customer_id' in row) && !('customerId' in row))).toBe(true)
    await expect(runner.run(scope, tx => new ChannelPartnerRepository(tx).dashboard(outsider), { readOnly: true })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    selfCustomer = outsider
    const blocked = await app.inject({ method: 'GET', url: `/cooperation/poster/${b.id}?format=data` })
    expect(blocked.statusCode).toBe(401)
    selfCustomer = invited
    const poster = await app.inject({ method: 'GET', headers, url: `/cooperation/poster/${b.id}?format=data` })
    expect(poster.statusCode, poster.body.slice(0, 300)).toBe(200)
    expect(Buffer.from(poster.json().data.base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect((await admin.query(`SELECT actor_ref,employee_id FROM mbox.channel_followups WHERE batch_id=$1 AND kind='download'`, [b.id])).rows).toEqual([{ actor_ref: `promoter:${promoter}`, employee_id: null }])
    const another=await batch()
    miniCode.render.mockImplementationOnce(async()=>{
      await admin.query("UPDATE mbox.channel_promoters SET status='disabled' WHERE id=$1",[promoter])
      return sharp({create:{width:430,height:430,channels:3,background:'#186a42'}}).png().toBuffer()
    })
    try {
      const revoked=await app.inject({method:'GET',headers,url:`/cooperation/poster/${another.id}`})
      expect(revoked.statusCode).toBe(401)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_poster_versions WHERE batch_id=$1',[another.id])).rows[0].n).toBe(0)
    } finally {await admin.query("UPDATE mbox.channel_promoters SET status='active' WHERE id=$1",[promoter])}

  })
  it('whole-table HTTP transfer retains source and cumulative discount, then reconciles original payments and refunds',async()=>{
    const b=await batch({observationDays:0,offer:{kind:'discount',discountBps:1000,maximumMinor:1500}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),activation=await activate(coupon.claimId,cid,session)
    const firstQuote=await prepare(session),first=await consumePrice(session,firstQuote.id)
    const target=await emptyMovementTable(),request=await moveRequest(session,target,'whole_table_transfer')
    const moved=await app.inject(request);expect(moved.statusCode,moved.body).toBe(200)
    expect((await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[session])).rows[0].table_id).toBe(target)
    const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
    const quote=await prepare(session);expect(quote.discountMinor).toBe(500)
    const second=await consumePrice(session,quote.id)
    const refs=(await admin.query('SELECT order_id,visit_id,batch_id FROM mbox.channel_order_attributions WHERE order_id=ANY($1::uuid[])',[[first.id,second.id]])).rows
    expect(refs).toHaveLength(2);expect(refs.every(r=>r.visit_id===activation.visitId&&r.batch_id===b.id)).toBe(true)
    let firstPayment=''
    for(const o of [first,second]){
      const pay=randomUUID();if(o.id===first.id)firstPayment=pay
      await admin.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[o.id])
      await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,status,succeeded_at) VALUES($3::uuid,$1,$2,$4,$3::text,'cash',$3::text,'cash',$5,'succeeded',clock_timestamp())`,[...args,pay,o.id,o.totalAmountMinor])
    }
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(activation.visitId!))).toMatchObject({basis:18500,target:1850})
    await financeRefund({payment:firstPayment,order:first},2000)
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(activation.visitId!))).toMatchObject({basis:16500,target:1650})
  })
  it('partial split shares visit and cumulative coupon cap across both tables',async()=>{
    const cid=await customer(),other=await customer(),session=await table([cid,other]),b=await batch({offer:{kind:'discount',discountBps:1000,maximumMinor:1500}}),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const first=await prepare(session),paid=await consumePrice(session,first.id)
    const request=await moveRequest(session,await emptyMovementTable(),'participant_split',null,[cid],1)
    const blocked=await app.inject(request);expect(blocked.statusCode,blocked.body).toBe(409)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[session])).rows[0].n).toBe(0)
    await settleMovementOrder(paid)
    const response=await app.inject({...request,headers:{'idempotency-key':randomUUID()}})
    expect(response.statusCode,response.body).toBe(200)
    const target=response.json().data.targetTableSessionId
    const links=(await admin.query('SELECT visit_id FROM mbox.channel_visit_tables WHERE table_session_id=ANY($1::uuid[]) AND detached_at IS NULL',[[session,target]])).rows
    expect(links).toHaveLength(2);expect(links.every(r=>r.visit_id===active.visitId)).toBe(true)
    const remaining=await prepare(target);expect(remaining.discountMinor).toBe(500);await consumePrice(target,remaining.id)
    const another=await issue(b.code,other)
    await expect(activate(another.claimId,other,session)).rejects.toMatchObject({code:'VISIT_LIMIT'})
    expect((await admin.query('SELECT sum(applied_discount_minor)::text AS amount FROM mbox.channel_activations WHERE visit_id=$1',[active.visitId])).rows[0].amount).toBe('1500')
  })
  it.each(['participant_split','participant_merge'] as const)('rejects new legacy requests without a snapshot, including receipt-only probes: %s',async kind=>{
    const owner=await customer(),source=await table(kind==='participant_split'?[owner,await customer()]:[])
    const target=kind==='participant_merge'?await table([]):null,targetTable=target?(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id:await emptyMovementTable()
    const request=await moveRequest(source,targetTable,kind,target,kind==='participant_split'?[owner]:[],kind==='participant_split'?1:2)
    const {movementGuard:_,...legacy}=request.payload
    const original=await app.inject({...request,payload:legacy})
    expect(original.statusCode,original.body).toBe(409);expect(original.json().error).toMatchObject({code:'TABLE_PARTICIPANT_NOT_COMMITTED',commitDisposition:'not_committed'})
    const forged=await app.inject({...request,payload:{...legacy,requireGuard:false,receiptOnly:false,nativeGuard:request.payload.movementGuard}})
    expect(forged.statusCode,forged.body).toBe(409);expect(forged.json().error.code).toBe('TABLE_PARTICIPANT_NOT_COMMITTED')
    const receiptOnly=await app.inject({...request,headers:{...request.headers,'x-table-movement-recovery':'1'}})
    expect(receiptOnly.statusCode,receiptOnly.body).toBe(409);expect(receiptOnly.json().error.code).toBe('TABLE_MOVEMENT_RECEIPT_UNAVAILABLE')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
    const valid=await app.inject(request);expect(valid.statusCode,valid.body).toBe(200)
  })
  it('recovers a historical unguarded receipt after transfer, merge and another split without executing it again',async()=>{
    const owner=await customer(),other=await customer(),source=await table([owner,other]),b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1),{movementGuard:_,...body}=request.payload
    // Seed a genuinely old committed command through the repository service,
    // not through the now guarded HTTP route. Its original fingerprint is kept.
    const original=await new TableManagementCommandService(new NormalizedCommandExecutor(runner)).moveParticipants({
      ...body,sourceTableSessionId:source,movementKind:'participant_split',targetTableSessionId:null,movedGuestCount:1,participantPublicIds:body.participantPublicIds!,
      scope,actor:{type:'employee',employeeId:employee},businessDate:'2026-11-12',reason:body.reason!,idempotencyKey:request.headers['idempotency-key'],
      requestFingerprint:createHash('sha256').update(JSON.stringify({method:'POST',url:request.url,employeeId:employee,body})).digest('hex'),
    })
    const split=original.value.targetTableSessionId
    expect((await app.inject(await moveRequest(split,await emptyMovementTable(),'whole_table_transfer'))).statusCode).toBe(200)
    const sourceTable=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].table_id
    const merge=await app.inject(await moveRequest(split,sourceTable,'participant_merge',source,[owner],1));expect(merge.statusCode,merge.body).toBe(200)
    expect((await app.inject(await moveRequest(source,await emptyMovementTable(),'whole_table_transfer'))).statusCode).toBe(200)
    const splitAgain=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1));expect(splitAgain.statusCode,splitAgain.body).toBe(200)
    const before=(await admin.query('SELECT id,table_id,status,guest_count,location_version FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',[[source,split,splitAgain.json().data.targetTableSessionId]])).rows
    const eventCounts=async()=>(await admin.query(`SELECT
      (SELECT count(*)::int FROM mbox.table_customer_movement_events WHERE tenant_id=$1 AND store_id=$2) AS movements,
      (SELECT count(*)::int FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2) AS audits,
      (SELECT count(*)::int FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2) AS outbox`,args)).rows[0]
    const counts=await eventCounts()
    const replayRequest={...request,payload:body,headers:{...request.headers,'x-table-movement-recovery':'1'}}
    for(const durable of [false,true]){
      if(durable)await admin.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='table.participation.move' AND idempotency_key=$3",[...args,request.headers['idempotency-key']])
      const results=await Promise.all([app.inject(replayRequest),app.inject(replayRequest)])
      for(const response of results){expect(response.statusCode,response.body).toBe(200);expect(response.json().meta.replayed).toBe(true);expect(response.json().data.eventId).toBe(original.value.eventId)}
    }
    const tampered=await app.inject({...replayRequest,payload:{...body,targetTableId:await emptyMovementTable()}});expect(tampered.statusCode).toBe(409)
    const peer=await movementPeer();try{expect((await peer.inject(replayRequest)).statusCode).toBe(409)}finally{await peer.close()}
    expect((await admin.query('SELECT id,table_id,status,guest_count,location_version FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',[[source,split,splitAgain.json().data.targetTableSessionId]])).rows).toEqual(before)
    const binding=await app.inject({method:'GET',url:`/staff/channel/table/${splitAgain.json().data.targetTableSessionId}`})
    expect(binding.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId})])
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE visit_id=$1',[active.visitId])).rows[0].n).toBe(1)
    expect(await eventCounts()).toEqual(counts)
  })
  it.each(['after-commit','before-dispatch','bad-receipt'])('runs real web API recovery against HTTP and PostgreSQL without rewriting the split: %s',async fault=>{
    const owner=await customer(),source=await table([owner,await customer()]),b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const body={...request.payload,sourceTableSessionId:source} as Parameters<StaffActionsApi['moveParticipants']>[0]
    const journal=new Map<string,string>(),storage={getItem:(k:string)=>journal.get(k)??null,setItem:(k:string,v:string)=>{journal.set(k,v)},removeItem:(k:string)=>{journal.delete(k)}}
    let first=true;const calls:{body:string;key:string;recovery:boolean}[]=[]
    const send:typeof fetch=async(url,init)=>{
      const headers=Object.fromEntries(new Headers(init?.headers).entries()),write=init?.method==='POST'
      if(write)calls.push({body:String(init?.body),key:headers['x-idempotency-key']!,recovery:headers['x-table-movement-recovery']==='1'})
      const fail=write&&first;if(write)first=false
      if(fail&&fault==='before-dispatch')throw new TypeError('isolated network loss before dispatch')
      const response=await app.inject({method:(init?.method??'GET') as 'POST'|'GET',url:String(url).replace(/^\/api/,''),headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})})
      if(fail&&fault==='after-commit')throw new TypeError('isolated response loss after commit')
      if(fail&&fault==='bad-receipt')return new Response(JSON.stringify({data:{},meta:{replayed:false}}))
      return new Response(response.body,{status:response.statusCode})
    }
    const client=()=>new StaffActionsApi({fetch:send,staffSessionId:'isolated-staff',commandStorage:storage})
    await expect(client().moveParticipants(body)).rejects.toThrow();expect(journal.size).toBe(1)
    if(fault==='before-dispatch'){
      await expect(client().recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'})
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
      expect(journal.size).toBe(1)
      await expect(client().sealParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'})
      expect(journal.size).toBe(0);await client().moveParticipants(body)
    }else{
      const destination=(await admin.query("SELECT target_table_session_id FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1 AND movement_kind='participant_split'",[source])).rows[0].target_table_session_id
      expect((await app.inject(await moveRequest(destination,await emptyMovementTable(),'whole_table_transfer'))).statusCode).toBe(200)
      await client().recoverParticipantMovement()
      const rows=await app.inject({method:'GET',url:`/staff/channel/table/${destination}`})
      expect(rows.json().data.activations).toEqual([expect.objectContaining({id:active.activationId})])
    }
    expect(calls[1]).toEqual({...calls[0]!,recovery:true});expect(journal.size).toBe(0)
    expect((await admin.query("SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1 AND movement_kind='participant_split'",[source])).rows[0].n).toBe(1)
  })
  it('rejects an old preview after the headcount returns to the original value and requires historical review for the next intent',async()=>{
    const owner=await customer(),companion=await customer(),source=await table([owner,companion]),target=await emptyMovementTable()
    const stale=await moveRequest(source,target,'participant_split',null,[owner],1)
    const split=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[companion],1));expect(split.statusCode,split.body).toBe(200)
    const splitSession=split.json().data.targetTableSessionId,sourceTable=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].table_id
    const merged=await app.inject(await moveRequest(splitSession,sourceTable,'participant_merge',source,[companion],1));expect(merged.statusCode,merged.body).toBe(200)
    const current=(await admin.query('SELECT table_id,guest_count,location_version FROM mbox.table_sessions WHERE id=$1',[source])).rows[0]
    expect(current).toMatchObject({table_id:stale.payload.movementGuard!.sourceTableId,guest_count:2})
    expect(Number(current.location_version)).toBe(stale.payload.movementGuard!.sourceLocationVersion)
    const blocked=await app.inject(stale);expect(blocked.statusCode,blocked.body).toBe(409)
    const fresh=await moveRequest(source,target,'participant_split',null,[owner],1)
    expect(fresh.payload.movementGuard!.movementRevision).toBe('2')
    const unreviewed=await app.inject({...fresh,payload:{...fresh.payload,movementHistoryConfirmed:false}})
    expect(unreviewed.statusCode,unreviewed.body).toBe(409);expect(unreviewed.json().error.message).toContain('历史')
    const valid=await app.inject(fresh);expect(valid.statusCode,valid.body).toBe(200)
  })
  it.each(['participant_split','participant_merge'] as const)('fences delayed original and two fresh devices after empty history: %s',async kind=>{
   for(const order of ['original-first','new-first','simultaneous']){
    const peer=await movementPeer(),owner=await customer(),companion=await customer(),source=await table([owner,companion])
    const target=kind==='participant_merge'?await table([]):null
    const targetTable=target?(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id:await emptyMovementTable()
    const request=await moveRequest(source,targetTable,kind,target,kind==='participant_split'?[owner]:[owner,companion],kind==='participant_split'?1:2)
    const body={...request.payload,sourceTableSessionId:source} as Parameters<StaffActionsApi['moveParticipants']>[0]
    const b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    const client=(delayed=false)=>{
      const journal=new Map<string,string>()
      return new StaffActionsApi({staffSessionId:'same-employee',commandStorage:{getItem:k=>journal.get(k)??null,setItem:(k,v)=>{journal.set(k,v)},removeItem:k=>{journal.delete(k)}},fetch:async(url,init)=>{
        if(delayed&&init?.method==='POST')await gate
        const r=await peer.inject({method:(init?.method??'GET') as 'GET'|'POST',url:String(url).replace(/^\/api/,''),headers:Object.fromEntries(new Headers(init?.headers)),...(init?.body?{payload:JSON.parse(String(init.body))}:{})})
        return new Response(r.body,{status:r.statusCode})
      }})
    }
    try{
      const a=client(true),b=client(),c=client(),first=a.moveParticipants(body).then(()=>true,()=>false)
      expect((await b.loadParticipantMovementHistory()).items).toEqual([])
      expect((await c.loadParticipantMovementHistory()).items).toEqual([])
      let results:boolean[]
      if(order==='original-first'){release();results=[await first,...await Promise.all([b,c].map(x=>x.moveParticipants(body).then(()=>true,()=>false)))]}
      else if(order==='new-first'){const next=await b.moveParticipants(body).then(()=>true,()=>false);release();results=[next,await first,await c.moveParticipants(body).then(()=>true,()=>false)]}
      else{const next=[b,c].map(x=>x.moveParticipants(body).then(()=>true,()=>false));release();results=await Promise.all([first,...next])}
      expect(results.filter(Boolean)).toHaveLength(1)
      const rows=(await admin.query('SELECT target_table_session_id FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows
      expect(rows).toHaveLength(1)
      const binding=await app.inject({method:'GET',url:`/staff/channel/table/${rows[0].target_table_session_id}`})
      expect(binding.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId})])
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE claim_id=$1',[coupon.claimId])).rows[0].n).toBe(1)
      const state=(await admin.query('SELECT guest_count,status FROM mbox.table_sessions WHERE id=$1',[source])).rows[0]
      if(kind==='participant_split')expect(state).toMatchObject({guest_count:1,status:'open'});else expect(state.status).toBe('closed')
    }finally{release();await peer.close()}
   }
  })
  it.each([false,true])('keeps a missing receipt unknown until original arrives or explicit withdrawal commits: seal=%s',async withdraw=>{
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const body={...request.payload,sourceTableSessionId:source} as Parameters<StaffActionsApi['moveParticipants']>[0]
    const journal=new Map<string,string>(),storage={getItem:(k:string)=>journal.get(k)??null,setItem:(k:string,v:string)=>{journal.set(k,v)},removeItem:(k:string)=>{journal.delete(k)}}
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r});let original=true,loseSeal=withdraw
    const calls:{key:string;seal:boolean}[]=[]
    const client=()=>new StaffActionsApi({staffSessionId:'same-employee',commandStorage:storage,fetch:async(url,init)=>{
      const headers=Object.fromEntries(new Headers(init?.headers)),write=init?.method==='POST'
      if(write){calls.push({key:headers['x-idempotency-key'],seal:headers['x-table-movement-seal']==='1'});if(original){original=false;await gate}}
      const r=await app.inject({method:(init?.method??'GET') as 'GET'|'POST',url:String(url).replace(/^\/api/,''),headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})})
      if(loseSeal&&headers['x-table-movement-seal']==='1'){loseSeal=false;throw new TypeError('withdrawal committed but response lost')}
      return new Response(r.body,{status:r.statusCode})
    }})
    const pending=client().moveParticipants(body).then(()=>null,e=>e)
    try{
      await expect(client().recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'})
      expect(journal.size).toBe(1)
      await expect(client().moveParticipants({...body,reason:'different'})).rejects.toThrow('不能更改')
      if(withdraw){
        await expect(client().sealParticipantMovement()).rejects.toMatchObject({code:'NETWORK_ERROR'});expect(journal.size).toBe(1)
        await expect(client().sealParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'});expect(journal.size).toBe(0)
      }
      release();const result=await pending
      if(withdraw)expect(result).toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'});else expect(result).toBeNull()
      expect(journal.size).toBe(0);expect(new Set(calls.map(c=>c.key)).size).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(withdraw?0:1)
    }finally{release();await pending}
  })
  it.each(['seal-first','original-first','concurrent'])('persists a withdrawal fence across cache cleanup without undoing committed movement: %s',async order=>{
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const sealed={...request,headers:{...request.headers,'x-table-movement-seal':'1'}}
    const missing=await app.inject({...request,headers:{...request.headers,'x-table-movement-recovery':'1'}})
    expect(missing.json().error).toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'})
    expect(missing.json().error.commitDisposition).toBeUndefined()
    let responses
    if(order==='seal-first')responses=[await app.inject(sealed),await app.inject(request)]
    else if(order==='original-first')responses=[await app.inject(request),await app.inject(sealed)]
    else responses=await Promise.all([app.inject(request),app.inject(sealed)])
    const committed=responses[0].statusCode===200
    for(const r of responses){expect(r.statusCode,r.body).toBe(committed?200:409);if(!committed)expect(r.json().error.code).toBe('TABLE_MOVEMENT_REQUEST_SEALED')}
    await admin.query('DELETE FROM mbox.idempotency_records WHERE idempotency_key=$1',[request.headers['idempotency-key']])
    const mutated=await app.inject({...sealed,payload:{...request.payload,movementKind:'participant_merge'}})
    expect(mutated.statusCode,mutated.body).toBe(409);expect(mutated.json().error.code).toBe('TABLE_OPERATION_CONFLICT')
    const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(committed?200:409)
    if(committed)expect(replay.json().data.eventId).toBe(responses[0].json().data.eventId)
    else expect(replay.json().error.code).toBe('TABLE_MOVEMENT_REQUEST_SEALED')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(committed?1:0)
    const peer=await movementPeer();try{expect((await peer.inject(sealed)).statusCode).toBe(409)}finally{await peer.close()}
    expect((await app.inject({...sealed,payload:{...request.payload,reason:'different original'}})).statusCode).toBe(409)
    const seals=(await admin.query("SELECT object_id FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2 AND action='table.participation.sealed' AND trace_id=$3",[...args,'participant-movement-seal:'+createHash('sha256').update(request.headers['idempotency-key']).digest('hex')])).rows
    expect(seals).toHaveLength(committed?0:1)
    if(!committed){
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.outbox_messages WHERE aggregate_id=$1',[seals[0].object_id])).rows[0].n).toBe(0)
      const fresh=await app.inject({...request,headers:{'idempotency-key':randomUUID()}});expect(fresh.statusCode,fresh.body).toBe(200)
    }
  })
  it('uses server history on fresh devices after local storage loss without creating a second split',async()=>{
    const owner=await customer(),source=await table([owner,await customer()]),b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1),body={...request.payload,sourceTableSessionId:source} as Parameters<StaffActionsApi['moveParticipants']>[0]
    const calls:{method:string;url:string}[]=[]
    const send:typeof fetch=async(url,init)=>{
      calls.push({method:init?.method??'GET',url:String(url)})
      const result=await app.inject({method:(init?.method??'GET') as 'GET'|'POST',url:String(url).replace(/^\/api/,''),headers:Object.fromEntries(new Headers(init?.headers)),...(init?.body?{payload:JSON.parse(String(init.body))}:{})})
      return new Response(result.body,{status:result.statusCode})
    }
    const client=(session:string)=>{const map=new Map<string,string>();return new StaffActionsApi({fetch:send,staffSessionId:session,commandStorage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>{map.set(k,v)},removeItem:k=>{map.delete(k)}}})}
    const first=client('device-a'),second=client('device-b')
    const outcomes=await Promise.allSettled([first.moveParticipants(body),second.moveParticipants(body)])
    expect(outcomes.map(r=>r.status).sort()).toEqual(['fulfilled','rejected'])
    const committed=(await admin.query("SELECT id,target_table_session_id FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1 AND movement_kind='participant_split'",[source])).rows
    expect(committed).toHaveLength(1)
    const destination=committed[0].target_table_session_id
    expect((await app.inject(await moveRequest(destination,await emptyMovementTable(),'whole_table_transfer'))).statusCode).toBe(200)
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[[source,destination]])
    for(const session of ['relogin-same-employee','third-device']){
      const fresh=client(session),before=calls.filter(c=>c.method==='POST').length
      expect(fresh.pendingParticipantMovement()).toBeNull()
      const history=await fresh.loadParticipantMovementHistory()
      const row=history.items.find(r=>r.id===committed[0].id)
      expect(row).toMatchObject({kind:'participant_split',movedGuestCount:1,targetSessionStatus:'closed'})
      expect(calls.filter(c=>c.method==='POST')).toHaveLength(before)
      expect(JSON.stringify(history)).not.toContain(coupon.claimId);expect(JSON.stringify(history)).not.toContain(owner)
      expect(Object.keys(row!).sort()).toEqual(['id','kind','sourceTableCode','targetTableCode','movedGuestCount','employeeName','occurredAt','targetCurrentTableCode','targetSessionStatus'].sort())
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE visit_id=$1',[active.visitId])).rows[0].n).toBe(1)
  })
  it('paginates own server movement history, ignores requested actor overrides and rechecks revoked permission',async()=>{
    const peer=await movementPeer(),other=await movementPeer(),source=await table([])
    try{
      for(let i=0;i<22;i++){const moved=await peer.inject(await moveRequest(source,await emptyMovementTable(),'whole_table_transfer'));expect(moved.statusCode,moved.body).toBe(200)}
      const first=await peer.inject({method:'GET',url:'/table-management/participant-movements/history'})
      expect(first.statusCode,first.body).toBe(200);expect(first.headers['cache-control']).toBe('no-store')
      expect(first.json().data.items).toHaveLength(20)
      const cursor=first.json().data.nextCursor,last=await peer.inject({method:'GET',url:`/table-management/participant-movements/history?cursor=${cursor}`})
      expect(last.json().data.items).toHaveLength(2);expect(last.json().data.nextCursor).toBeNull()
      expect(new Set([...first.json().data.items,...last.json().data.items].map(row=>row.id)).size).toBe(22)
      const actor=(await admin.query('SELECT moved_by_employee_id FROM mbox.table_customer_movement_events WHERE id=$1',[cursor])).rows[0].moved_by_employee_id
      const empty=await other.inject({method:'GET',url:`/table-management/participant-movements/history?employeeId=${actor}`})
      expect(empty.statusCode).toBe(200);expect(empty.json().data.items).toEqual([])
      expect((await other.inject({method:'GET',url:`/table-management/participant-movements/history?cursor=${cursor}`})).statusCode).toBe(409)
      await admin.query('DELETE FROM mbox.employee_roles WHERE employee_id=$1',[actor])
      expect((await peer.inject({method:'GET',url:'/table-management/participant-movements/history'})).statusCode).toBe(403)
    }finally{await peer.close();await other.close()}
  })
  it('waits behind an in-flight movement before listing its committed history',async()=>{
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const blocker=await admin.connect();let move:ReturnType<typeof app.inject>|undefined,history:ReturnType<typeof app.inject>|undefined
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))",args)
      move=app.inject(request);const moving=Promise.resolve(move)
      const waiting=async()=>Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)
      await vi.waitFor(async()=>expect(await waiting()).toBeGreaterThanOrEqual(1))
      history=app.inject({method:'GET',url:'/table-management/participant-movements/history'});const reading=Promise.resolve(history)
      await vi.waitFor(async()=>expect(await waiting()).toBeGreaterThanOrEqual(2))
      await blocker.query('COMMIT')
      const result=await moving;expect(result.statusCode,result.body).toBe(200)
      const records=await reading;expect(records.statusCode,records.body).toBe(200)
      expect(records.json().data.items.some(row=>row.id===result.json().data.eventId)).toBe(true)
    }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled([...(move?[move]:[]),...(history?[history]:[])])}
  })
  it.each(['before-auth','after-seal'])('keeps withdrawal identity through account switching, restored permissions and old-device replay: %s',async phase=>{
    const actor=randomUUID()
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($3::uuid,$1,$2,$3::text,'隔离恢复员工')",[...args,actor])
    const permissions=['table.transfer','table.participation.manage'];await grantFixtureStaffPermissions(admin,scope,[actor],permissions)
    let currentActor=actor
    const authApp=Fastify();await authApp.register(tableManagementApiPlugin,{transactions:runner,commands:new TableManagementCommandService(new NormalizedCommandExecutor(runner)),resolveContext:request=>{
      assertStaffSessionBinding(request,{id:'isolated-session',employeeId:currentActor});return{scope,employeeId:currentActor,businessDate:'2026-11-16'}
    }})
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const body={...request.payload,sourceTableSessionId:source} as Parameters<StaffActionsApi['moveParticipants']>[0]
    const journal=new Map<string,string>(),storage={getItem:(k:string)=>journal.get(k)??null,setItem:(k:string,v:string)=>{journal.set(k,v)},removeItem:(k:string)=>{journal.delete(k)}}
    let original:Parameters<typeof authApp.inject>[0]|undefined,first=true,release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{entered=r})
    let delaySeal=true
    const transport:typeof fetch=async(url,init)=>{
      if(String(url)==='/api/operations')return new Response(JSON.stringify({data:{actor:{id:currentActor}}}))
      const headers=Object.fromEntries(new Headers(init?.headers)),r={method:(init?.method??'GET') as 'POST'|'GET',url:String(url).replace(/^\/api/,''),headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})}
      if(first&&init?.method==='POST'){first=false;original=r;throw new TypeError('original offline')}
      const delayed=headers['x-table-movement-seal']==='1'&&delaySeal
      if(delayed&&phase==='before-auth'){entered();await gate}
      const response=await authApp.inject(r)
      if(delayed&&phase==='after-seal'){entered();await gate;throw new TypeError('seal committed response lost')}
      return new Response(response.body,{status:response.statusCode})
    }
    const client=()=>new StaffActionsApi({fetch:transport,commandStorage:storage})
    let withdrawal:Promise<unknown>|undefined
    try{
      const a=client();await a.loadOperations();await expect(a.moveParticipants(body)).rejects.toMatchObject({code:'NETWORK_ERROR'})
      withdrawal=a.sealParticipantMovement().then(()=>null,e=>e);await started
      currentActor=employee
      const b=client();await b.loadOperations();expect(b.pendingParticipantMovement()?.canRecover).toBe(false)
      await expect(b.recoverParticipantMovement()).rejects.toThrow('原员工');await expect(b.sealParticipantMovement()).rejects.toThrow('原员工')
      release();expect(await withdrawal).toMatchObject({code:phase==='before-auth'?'AUTH_REQUIRED':'NETWORK_ERROR'})
      expect(journal.size).toBe(1);delaySeal=false;currentActor=actor
      const restored=client();await restored.loadOperations()
      await admin.query('DELETE FROM mbox.employee_roles WHERE employee_id=$1',[actor])
      await expect(restored.recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_PERMISSION_DENIED'});expect(journal.size).toBe(1)
      await grantFixtureStaffPermissions(admin,scope,[actor],permissions)
      if(phase==='before-auth'){
        await expect(restored.recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_RECEIPT_UNAVAILABLE'});expect(journal.size).toBe(1)
        await expect(restored.sealParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'})
      }else await expect(restored.recoverParticipantMovement()).rejects.toMatchObject({code:'TABLE_MOVEMENT_REQUEST_SEALED'})
      expect(journal.size).toBe(0)
      currentActor=employee;expect((await authApp.inject(original!)).statusCode).toBe(401)
      currentActor=actor
      for(const result of await Promise.all([authApp.inject(original!),authApp.inject(original!)]))expect(result.json().error.code).toBe('TABLE_MOVEMENT_REQUEST_SEALED')
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
      await restored.moveParticipants(body)
      expect((await authApp.inject(original!)).json().error.code).toBe('TABLE_MOVEMENT_REQUEST_SEALED')
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(1)
    }finally{release();if(withdrawal)await withdrawal;await authApp.close()}
  })
  it.each(['before-dispatch','after-commit'])('does not duplicate a move after withdrawal disconnect, journal loss and two fresh devices: %s',async fault=>{
    const peer=await movementPeer(),owner=await customer(),source=await table([owner,await customer()])
    const originalRequest=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const nextRequest=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const body=(request:typeof originalRequest)=>({...request.payload,sourceTableSessionId:source}) as Parameters<StaffActionsApi['moveParticipants']>[0]
    const b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const journal=new Map<string,string>(),storage=(map:Map<string,string>)=>({getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}})
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r});let holdFirst=true
    const send:typeof fetch=async(url,init)=>{
      const headers=Object.fromEntries(new Headers(init?.headers)),seal=headers['x-table-movement-seal']==='1'
      if(init?.method==='POST'&&holdFirst){holdFirst=false;await gate}
      if(seal&&fault==='before-dispatch')throw new TypeError('withdrawal did not reach server')
      const r=await peer.inject({method:(init?.method??'GET') as 'GET'|'POST',url:String(url).replace(/^\/api/,''),headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})})
      if(seal)throw new TypeError('withdrawal response lost')
      return new Response(r.body,{status:r.statusCode})
    }
    const client=(map:Map<string,string>)=>new StaffActionsApi({fetch:send,staffSessionId:'same-employee',commandStorage:storage(map)})
    const pending=client(journal).moveParticipants(body(originalRequest)).then(()=>null,e=>e)
    try{
      await expect(client(journal).sealParticipantMovement()).rejects.toMatchObject({code:'NETWORK_ERROR'})
      expect(client(journal).pendingParticipantMovement()?.message).toContain('不代表撤回成功')
      journal.clear()
      const second=client(new Map()),third=client(new Map())
      for(const device of [second,third]){
        expect(device.pendingParticipantMovement()).toBeNull()
        await expect(device.sealParticipantMovement()).rejects.toThrow('没有待恢复')
        expect((await device.loadParticipantMovementHistory()).items).toEqual([])
      }
      const results=await Promise.allSettled([second.moveParticipants(body(nextRequest)),third.moveParticipants(body(nextRequest))])
      expect(results.map(r=>r.status).sort()).toEqual(['fulfilled','rejected'])
      release();const late=await pending
      expect(late).toMatchObject({code:fault==='after-commit'?'TABLE_MOVEMENT_REQUEST_SEALED':'TABLE_PARTICIPANT_NOT_COMMITTED'})
      const moves=(await admin.query('SELECT target_table_session_id FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows
      expect(moves).toHaveLength(1)
      const current=await app.inject({method:'GET',url:`/staff/channel/table/${moves[0].target_table_session_id}`})
      expect(current.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId})])
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE claim_id=$1',[coupon.claimId])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT guest_count FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].guest_count).toBe(1)
      expect((await second.loadParticipantMovementHistory()).items).toHaveLength(1)
    }finally{release();await pending;await peer.close()}
  })
  it.each(['cached-move','cached-seal','durable-move','durable-seal','new-seal'])('rechecks authorization after waiting to recover or withdraw an original request: %s',async mode=>{
    const peer=await movementPeer(),seed=await table([])
    const bootstrap=await peer.inject(await moveRequest(seed,await emptyMovementTable(),'whole_table_transfer'))
    expect(bootstrap.statusCode,bootstrap.body).toBe(200)
    const actor=(await admin.query('SELECT moved_by_employee_id FROM mbox.table_customer_movement_events WHERE id=$1',[bootstrap.json().data.eventId])).rows[0].moved_by_employee_id
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    if(mode!=='new-seal'){
      const first=await peer.inject({...request,headers:{...request.headers,...(mode.endsWith('seal')?{'x-table-movement-seal':'1'}:{})}})
      expect(first.statusCode,first.body).toBe(mode.endsWith('seal')?409:200)
    }
    if(mode.startsWith('durable'))await admin.query('DELETE FROM mbox.idempotency_records WHERE idempotency_key=$1',[request.headers['idempotency-key']])
    const blocker=await admin.connect();let pending:Promise<Awaited<ReturnType<typeof peer.inject>>>|undefined
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if(mode.startsWith('cached'))await blocker.query('SELECT id FROM mbox.idempotency_records WHERE idempotency_key=$1 FOR UPDATE',[request.headers['idempotency-key']])
      else await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))",args)
      pending=Promise.resolve(peer.inject({...request,headers:{...request.headers,'x-table-movement-recovery':'1','x-table-movement-seal':'1'}}))
      await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true))
      await admin.query('DELETE FROM mbox.employee_roles WHERE employee_id=$1',[actor]);await blocker.query('COMMIT')
      const denied=await pending;expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().error.commitDisposition).toBeUndefined();expect(denied.json().data).toBeUndefined()
      if(mode==='new-seal'){
        expect((await admin.query("SELECT count(*)::int AS n FROM mbox.audit_events WHERE actor_employee_id=$1 AND action='table.participation.sealed'",[actor])).rows[0].n).toBe(0)
        expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
      }
    }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await peer.close()}
  })
  it.each(['seal','original'])('serializes two truly blocked requests when the first arriving request is %s',async first=>{
    const owner=await customer(),source=await table([owner,await customer()]),request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const seal={...request,headers:{...request.headers,'x-table-movement-seal':'1'}}
    const blocker=await admin.connect();const pending:Promise<Awaited<ReturnType<typeof app.inject>>>[]=[]
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))",args)
      pending.push(Promise.resolve(app.inject(first==='seal'?seal:request)))
      let firstPid=0
      await vi.waitFor(async()=>{const row=(await admin.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows[0];expect(row).toBeTruthy();firstPid=row?.pid})
      pending.push(Promise.resolve(app.inject(first==='seal'?request:seal)))
      await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[firstPid])).rows[0].blocked).toBe(true))
      await blocker.query('COMMIT')
      for(const r of await Promise.all(pending)){expect(r.statusCode,r.body).toBe(first==='seal'?409:200);if(first==='seal')expect(r.json().error.code).toBe('TABLE_MOVEMENT_REQUEST_SEALED')}
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(first==='seal'?0:1)
    }finally{await blocker.query('ROLLBACK');blocker.release();await Promise.allSettled(pending)}
  })
  it('denies historical records when the original employee loses permission while waiting for a movement lock',async()=>{
    const peer=await movementPeer(),source=await table([]),moved=await peer.inject(await moveRequest(source,await emptyMovementTable(),'whole_table_transfer'))
    expect(moved.statusCode,moved.body).toBe(200)
    const actor=(await admin.query('SELECT moved_by_employee_id FROM mbox.table_customer_movement_events WHERE id=$1',[moved.json().data.eventId])).rows[0].moved_by_employee_id
    const blocker=await admin.connect();let pending:Promise<Awaited<ReturnType<typeof peer.inject>>>|undefined
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('table-customer-movement:'||$1::text||':'||$2::text,0))",args)
      pending=Promise.resolve(peer.inject({method:'GET',url:'/table-management/participant-movements/history'}))
      await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true))
      await admin.query('DELETE FROM mbox.employee_roles WHERE employee_id=$1',[actor])
      await blocker.query('COMMIT')
      const denied=await pending;expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().data).toBeUndefined()
    }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await peer.close()}
  })
  it.each(['same-source','same-target'])('serializes competing whole-table transfers: %s',async mode=>{
    const owner=await customer(),source=await table([owner]),b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const other=mode==='same-source'?source:await table([await customer()]),target=await emptyMovementTable()
    const requests=await Promise.all([moveRequest(source,target,'whole_table_transfer'),moveRequest(other,mode==='same-source'?await emptyMovementTable():target,'whole_table_transfer')])
    const peer=await movementPeer()
    let responses
    try{responses=await Promise.all([app.inject(requests[0]!),peer.inject(requests[1]!)])
      const winner=responses.findIndex(r=>r.statusCode===200),replay=await (winner===0?app:peer).inject(requests[winner]!)
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
    }finally{await peer.close()}
    expect(responses.map(r=>r.statusCode).sort(),responses.map(r=>r.body).join('\n')).toEqual([200,409])
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=ANY($1::uuid[])',[[source,other]])).rows[0].n).toBe(1)
    const rows=await app.inject({method:'GET',url:`/staff/channel/table/${source}`})
    expect(rows.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId})])
    const location=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].table_id
    expect((await admin.query('SELECT table_id FROM mbox.table_session_customer_participations WHERE customer_id=$1 AND left_at IS NULL',[owner])).rows.map(r=>r.table_id)).toEqual([location])
  })
  it('rejects a web split preview taken before another employee transfers the source',async()=>{
    const owner=await customer(),source=await table([owner,await customer()]),b=await batch(),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const request=await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1)
    const row=(await admin.query('SELECT table_id,location_version FROM mbox.table_sessions WHERE id=$1',[source])).rows[0]
    const guard={movementRevision:'0',sourceTableId:row.table_id,sourceLocationVersion:Number(row.location_version),sourceGuestCount:2,targetGuestCount:0,targetCapacity:8}
    const preview=await app.inject({...request,url:request.url+'/preview'})
    expect(preview.statusCode,preview.body).toBe(200)
    const moved=await app.inject(await moveRequest(source,await emptyMovementTable(),'whole_table_transfer'));expect(moved.statusCode,moved.body).toBe(200)
    const stale=await app.inject({...request,payload:{...request.payload,movementGuard:guard}})
    expect(stale.statusCode,stale.body).toBe(409)
    expect(preview.json().data.movementGuard).toEqual(guard)
    expect((await admin.query("SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1 AND movement_kind='participant_split'",[source])).rows[0].n).toBe(0)
    const refreshedRequest=await moveRequest(source,request.payload.targetTableId,'participant_split',null,[owner],1)
    const fresh=await app.inject({...refreshedRequest,url:refreshedRequest.url+'/preview'});expect(fresh.statusCode,fresh.body).toBe(200)
    const retried=await app.inject({...refreshedRequest,payload:{...refreshedRequest.payload,movementGuard:fresh.json().data.movementGuard}})
    expect(retried.statusCode,retried.body).toBe(200)
    const binding=await app.inject({method:'GET',url:`/staff/channel/table/${retried.json().data.targetTableSessionId}`})
    expect(binding.json().data.activations).toEqual([expect.objectContaining({id:active.activationId})])
  })
  it('rejects a stale anonymous full-merge even when no participant identity can detect the move',async()=>{
    const source=await table([]),target=await table([]),targetTable=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id
    const request=await moveRequest(source,targetTable,'participant_merge',target,[],2)
    const preview=await app.inject({...request,url:request.url+'/preview'});expect(preview.statusCode,preview.body).toBe(200)
    const moved=await app.inject(await moveRequest(source,await emptyMovementTable(),'whole_table_transfer'));expect(moved.statusCode,moved.body).toBe(200)
    const stale=await app.inject({...request,payload:{...request.payload,movementGuard:preview.json().data.movementGuard}})
    expect(stale.statusCode,stale.body).toBe(409)
    expect(stale.json().error.message).toContain('重新预检')
    expect((await admin.query("SELECT count(*)::int AS n FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) AND status='open'",[[source,target]])).rows[0].n).toBe(2)
  })
  it('merges a split party back once under competing requests without resetting attribution or discount',async()=>{
    const owner=await customer(),other=await customer(),source=await table([owner,other]),b=await batch({allowStacking:true,visitDiscountCapMinor:1500,minimumMinor:0,offer:{kind:'discount',discountBps:1000,maximumMinor:5000}}),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,source)
    const original=await consumePrice(source,(await prepare(source)).id);await settleMovementOrder(original)
    const split=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[owner],1))
    expect(split.statusCode,split.body).toBe(200);const splitSession=split.json().data.targetTableSessionId
    const stale=await prepare(splitSession),sourceTable=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].table_id
    const request=await moveRequest(splitSession,sourceTable,'participant_merge',source,[owner],1)
    const peer=await movementPeer()
    let results
    try{results=await Promise.all([app.inject(request),peer.inject({...request,headers:{'idempotency-key':randomUUID()}})])}finally{await peer.close()}
    expect(results.map(r=>r.statusCode).sort(),results.map(r=>r.body).join('\n')).toEqual([200,409])
    await expect(consumePrice(splitSession,stale.id)).rejects.toThrow()
    const originalRow=(await admin.query('SELECT table_session_id FROM mbox.orders WHERE id=$1',[original.id])).rows[0]
    expect(originalRow.table_session_id).toBe(source)
    expect((await admin.query('SELECT closed_at FROM mbox.channel_visits WHERE id=$1',[active.visitId])).rows[0].closed_at).toBeNull()
    const bindings=await app.inject({method:'GET',url:`/staff/channel/table/${source}`})
    expect(bindings.json().data.activations).toEqual([expect.objectContaining({id:active.activationId,claimId:coupon.claimId,usedDiscountMinor:'1000',visitDiscountCapMinor:1500})])
    const quote=await prepare(source);expect(quote.discountMinor).toBe(500)
    expect(menuCheckoutPricing({originalMinor:10000,quote:{...quote,fingerprint:'merged'},fingerprint:'merged',now:Date.now()})).toMatchObject({amountMinor:9500,discountMinor:500})
    const next=await consumePrice(source,quote.id);await settleMovementOrder(next)
    await expect(prepare(source)).rejects.toThrow()
    expect((await admin.query('SELECT visit_id FROM mbox.channel_order_attributions WHERE order_id=ANY($1::uuid[])',[[original.id,next.id]])).rows.map(r=>r.visit_id)).toEqual([active.visitId,active.visitId])
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_activations WHERE visit_id=$1',[active.visitId])).rows[0].n).toBe(1)
  })
  it.each(['refund-first','order-first'])('serializes a refund with a new discounted order through real lock waits: %s',async ordering=>{
    const owner=await customer(),session=await table([owner]),b=await batch({minimumMinor:0,observationDays:0,allowStacking:true,visitDiscountCapMinor:2500,offer:{kind:'discount',discountBps:1000,maximumMinor:5000}}),coupon=await issue(b.code,owner),active=await activate(coupon.claimId,owner,session)
    const original=await consumePrice(session,(await prepare(session)).id),payment=await settleMovementOrder(original),quote=await prepare(session)
    const refund=await financeRefund({payment,order:original},4500,'processing'),connection=await admin.connect()
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
    let pendingOrder:ReturnType<typeof consumePrice>|undefined,pendingRefund:ReturnType<typeof connection.query>|undefined
    try{
      if(ordering==='refund-first'){
        await connection.query('BEGIN')
        const pid=Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await connection.query("UPDATE mbox.refunds SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1",[refund])
        const attempt=consumePrice(session,quote.id).then(value=>({value,error:null}),error=>({value:null,error}))
        await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true))
        await connection.query('COMMIT');expect((await attempt).error).toBeTruthy()
        const fresh=await prepare(session);expect(fresh.discountMinor).toBe(500);pendingOrder=consumePrice(session,fresh.id)
      }else{
        let locked!:(pid:number)=>void;const entered=new Promise<number>(resolve=>{locked=resolve})
        pendingOrder=consumePrice(session,quote.id,1,async pid=>{locked(pid);await gate})
        const pid=await entered
        pendingRefund=connection.query("UPDATE mbox.refunds SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1",[refund])
        await vi.waitFor(async()=>expect((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true))
        release();await pendingRefund
      }
      const added=await pendingOrder!;await settleMovementOrder(added)
      expect(added.totalAmountMinor).toBe(ordering==='refund-first'?9500:9000)
      const {loadMiniModule}=createRequire(import.meta.url)('../../scripts/load-miniprogram-test-module.mjs'),utils=loadMiniModule(new URL('../../miniprogram/utils/checkout-coupons.js',import.meta.url))
      const page:any={...utils.checkoutCouponMethods({quoteChannel:async()=>({...await prepare(session),current:true,sourceType:'channel_quote',generation:1,version:1}),money:(n:number)=>(n/100).toFixed(2),randomId:()=>randomUUID(),scope:()=>session,errorMessage:(e:Error)=>e.message}),data:{...structuredClone(utils.initialCheckoutCoupons),busy:false,cart:[],cartGeneration:1,cartVersion:1,checkoutConfirmVisible:true},setData(patch:object){Object.assign(this.data,patch)}}
      await page.quoteCheckoutChannel()
      const remaining=ordering==='refund-first'?1000:500
      expect(page.data.couponQuote.discountMinor).toBe(remaining);expect(page.couponCheckoutReady()).toBe(true)
      expect(menuCheckoutPricing({originalMinor:10000,quote:{...page.data.couponQuote,fingerprint:'after-refund'},fingerprint:'after-refund',now:Date.now()})).toMatchObject({amountMinor:10000-remaining,discountMinor:remaining})
      const last=await consumePrice(session,page.data.couponQuote.id);await settleMovementOrder(last)
      await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
      const reconciled=await Promise.all([1,2,3].map(()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(active.visitId!))))
      for(const row of reconciled)expect(row).toMatchObject({basis:23000,target:2300,frozen:false})
      expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('2500')
    }finally{release();await connection.query('ROLLBACK');await Promise.allSettled([...(pendingOrder?[pendingOrder]:[]),...(pendingRefund?[pendingRefund]:[])]);connection.release()}
  },30_000)
  it('full merge into an empty-consumption table preserves an open referral visit and coupon use',async()=>{
    const cid=await customer(),source=await table([cid]),target=await table([]),b=await batch(),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,source)
    const targetId=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id
    const response=await app.inject(await moveRequest(source,targetId,'participant_merge',target,[cid],2))
    expect(response.statusCode,response.body).toBe(200)
    expect((await admin.query('SELECT status FROM mbox.table_sessions WHERE id=$1',[source])).rows[0].status).toBe('closed')
    expect((await admin.query('SELECT visit_id FROM mbox.channel_visit_tables WHERE table_session_id=$1 AND detached_at IS NULL',[target])).rows[0]?.visit_id).toBe(active.visitId)
    expect((await admin.query('SELECT closed_at FROM mbox.channel_visits WHERE id=$1',[active.visitId])).rows[0].closed_at).toBeNull()
    expect((await prepare(target)).discountMinor).toBe(1000)
  })
  it('rejects merging distinct referral groups atomically, preserving both tables and coupons',async()=>{
    const a=await customer(),b=await customer(),source=await table([a]),target=await table([b]),offerA=await batch(),offerB=await batch()
    const ca=await issue(offerA.code,a),cb=await issue(offerB.code,b);await activate(ca.claimId,a,source);await activate(cb.claimId,b,target)
    const before=(await admin.query('SELECT id,status,guest_count FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',[[source,target]])).rows
    const targetId=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id
    const response=await app.inject(await moveRequest(source,targetId,'participant_merge',target,[a],2))
    expect(response.statusCode,response.body).toBe(409)
    expect((await admin.query('SELECT id,status,guest_count FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',[[source,target]])).rows).toEqual(before)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
  })

  it('moves a reserved gift with the split party and creates only one gift order at the destination',async()=>{
    const gift=await giftProduct(1),cid=await customer(),other=await customer(),source=await table([cid,other]),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}}),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,source)
    const response=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[cid],1));expect(response.statusCode,response.body).toBe(200)
    const target=response.json().data.targetTableSessionId
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const fulfill=()=>runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:target,employeeId:employee,businessDate:'2026-11-12'}))
    const first=await fulfill(),again=await fulfill();expect(again.result.orderId).toBe(first.result.orderId)
    expect((await admin.query('SELECT visit_id,batch_id FROM mbox.channel_order_attributions WHERE order_id=$1',[first.result.orderId])).rows[0]).toEqual({visit_id:active.visitId,batch_id:b.id})
    expect((await admin.query('SELECT table_session_id FROM mbox.orders WHERE id=$1',[first.result.orderId])).rows[0].table_session_id).toBe(target)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.kds_tasks k JOIN mbox.order_items i ON i.id=k.order_item_id WHERE i.order_id=$1',[first.result.orderId])).rows[0].n).toBe(1)
    expect(Number((await admin.query('SELECT reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[gift.iid])).rows[0].reserved_quantity)).toBe(1)
  })
  it.each(['organic-into-channel','channel-into-consuming'])('blocks %s merge without changing either table',async kind=>{
    const cid=await customer(),other=await customer(),source=await table([cid]),target=await table([other]),b=await batch(),owner=kind==='organic-into-channel'?other:cid
    const coupon=await issue(b.code,owner);await activate(coupon.claimId,owner,kind==='organic-into-channel'?target:source)
    if(kind==='channel-into-consuming'){
      const o=await runner.run(scope,tx=>new OrderRepository(tx).createSubmitted({tableSessionId:target,publicId:randomUUID(),channel:'staff_assisted',lines:[{productId:product,quantity:1}],createdByEmployeeId:employee}));await settleMovementOrder(o)
    }
    const targetId=(await admin.query('SELECT table_id FROM mbox.table_sessions WHERE id=$1',[target])).rows[0].table_id
    const response=await app.inject(await moveRequest(source,targetId,'participant_merge',target,[cid],2));expect(response.statusCode,response.body).toBe(409)
    expect((await admin.query("SELECT count(*)::int AS n FROM mbox.table_sessions WHERE id=ANY($1::uuid[]) AND status='open'",[[source,target]])).rows[0].n).toBe(2)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.table_customer_movement_events WHERE source_table_session_id=$1',[source])).rows[0].n).toBe(0)
  })

  it('serializes eight commission recomputations and two statement creations without duplicate ledger allocation',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    await Promise.all(Array.from({length:8},()=>run(r=>r.reconcile(f.visitId))))
    expect((await admin.query('SELECT count(*)::int AS n,sum(commission_delta_minor)::text AS total FROM mbox.channel_ledger WHERE visit_id=$1',[f.visitId])).rows[0]).toEqual({n:1,total:'900'})
    const results=await Promise.allSettled([run(r=>r.statement(f.rid,f.account,employee,'财务甲出单')),run(r=>r.statement(f.rid,f.account,employee,'财务乙出单'))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_statements WHERE promoter_id=$1',[f.rid])).rows[0].n).toBe(1)
  })
  it('serializes competing payouts and competing returns within original net paid limits',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'并发付款'))
    await run(r=>r.respond(statement.id,f.owner,false,'核对'));await run(r=>r.approve(statement.id,reviewer,'独立复核'))
    const payouts=await Promise.allSettled([run(r=>r.startPayment(statement.id,600,randomUUID(),employee,'财务甲')),run(r=>r.startPayment(statement.id,600,randomUUID(),employee,'财务乙'))])
    expect(payouts.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const paid=(payouts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{id:string}>).value
    await run(r=>r.confirmPayment(paid.id,true,randomUUID(),reviewer,'银行成功回单'))
    const returns=await Promise.allSettled([run(r=>r.returnPayment(paid.id,400,randomUUID(),reviewer,'退回甲')),run(r=>r.returnPayment(paid.id,400,randomUUID(),reviewer,'退回乙'))])
    expect(returns.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await run(r=>r.overview(f.rid))).statements[0]).toMatchObject({paidMinor:'200'})
  })
  it('serializes partner dispute against independent approval without approving a disputed statement',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'争议审批竞态'));await run(r=>r.respond(statement.id,f.owner,false,'先确认'))
    const results=await Promise.allSettled([run(r=>r.respond(statement.id,f.owner,true,'随后发现退款争议')),run(r=>r.approve(statement.id,reviewer,'审批'))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const state=(await admin.query('SELECT status,approved_by FROM mbox.channel_statements WHERE id=$1',[statement.id])).rows[0]
    expect(['approved','disputed']).toContain(state.status)
    if(state.status==='disputed'){expect(state.approved_by).toBeNull();await expect(run(r=>r.startPayment(statement.id,900,randomUUID(),employee,'不得付款'))).rejects.toThrow()}
  })
  it('confirms an already attempted bank payment after a concurrent customer refund without losing the negative balance',async()=>{
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'退款和回单'))
    await run(r=>r.respond(statement.id,f.owner,false,'核对'));await run(r=>r.approve(statement.id,reviewer,'独立复核'))
    const payout=await run(r=>r.startPayment(statement.id,900,randomUUID(),employee,'银行已发起待核'))
    await Promise.all([financeRefund(f,9000),run(r=>r.confirmPayment(payout.id,true,randomUUID(),reviewer,'核实银行已付'))])
    await run(r=>r.reconcile(f.visitId))
    const view=await run(r=>r.overview(f.rid));expect(view.balances[0]).toMatchObject({balanceMinor:'-900',paidMinor:'900',accruedMinor:'0'})
    await expect(run(r=>r.startPayment(statement.id,1,randomUUID(),employee,'不得补付'))).rejects.toThrow()
  })
  it('recovers the original partial-payout HTTP receipt and refuses missing receipts without creating another payout',async()=>{
    await grantFixtureStaffPermissions(admin,scope,[employee],['channel.settle'])
    const f=await financeFixture(),run=<T>(fn:(r:ChannelFinanceRepository)=>Promise<T>)=>runner.run(scope,tx=>fn(new ChannelFinanceRepository(tx)))
    const statement=await run(r=>r.statement(f.rid,f.account,employee,'回执恢复'))
    await run(r=>r.respond(statement.id,f.owner,false,'确认'));await run(r=>r.approve(statement.id,reviewer,'复核'))
    const key=`channel-${randomUUID()}`,request={method:'POST' as const,url:'/staff/channel/finance',headers:{'idempotency-key':key},payload:{action:'start-payment',id:statement.id,amountMinor:400,reference:randomUUID(),reason:'已发起银行付款'}}
    const first=await app.inject(request);expect(first.statusCode,first.body).toBe(200)
    await run(r=>r.confirmPayment(first.json().data.id,true,randomUUID(),reviewer,'实际成功回单'))
    const recovery={...request,headers:{...request.headers,'x-channel-recovery':'1'}}
    const replay=await app.inject(recovery);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data.id).toBe(first.json().data.id)
    await admin.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='channel.finance' AND idempotency_key=$3",[...args,key])
    const missing=await app.inject(recovery);expect(missing.statusCode,missing.body).toBe(409)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_payouts WHERE statement_id=$1',[statement.id])).rows[0].n).toBe(1)
  })
  it('refuses missing claim receipts even when the customer still has issuance capacity',async()=>{
    const b=await batch({perCustomerClaims:2});selfCustomer=await customer()
    const key=`channel-${randomUUID()}`,request={method:'POST' as const,url:'/public/mini/channel/claim',headers:{'idempotency-key':key},payload:{code:b.code}}
    expect((await app.inject(request)).statusCode).toBe(200)
    await admin.query("DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='channel.self.claim' AND idempotency_key=$3",[...args,key])
    const missing=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
    expect(missing.statusCode,missing.body).toBe(409)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
  })
  it.each(['fulfill','cancel'] as const)('serializes gift fulfillment against cancellation when %s wins',async first=>{
    const gift=await giftProduct(1),cid=await customer(),session=await table([cid])
    const b=await batch({minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}})
    const coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const act=async(tx:ScopedTransaction,action:'fulfill'|'cancel')=>{
      if(action==='fulfill') await fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'})
      else await new ChannelDistributionRepository(tx).cancelActivation(active.activationId!,session,employee,'同时误撤销')
    }
    let second:Promise<unknown>|undefined
    await runner.run(scope,async tx=>{
      await act(tx,first)
      const {pid}=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!
      second=runner.run(scope,other=>act(other,first==='fulfill'?'cancel':'fulfill')).then(()=>null,error=>error)
      await vi.waitFor(async()=>expect((await admin.query(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked).toBe(true),
        {timeout:10_000,interval:25})
    })
    await expect(second).resolves.toMatchObject({code:first==='fulfill'?'NOT_REVERSIBLE':'OWNERSHIP'})
    const promises=(await admin.query('SELECT order_id,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows
    const orders=(await admin.query('SELECT id FROM mbox.orders WHERE table_session_id=$1',[session])).rows
    const activation=(await admin.query('SELECT status FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0]
    if(first==='fulfill'){
      expect(orders).toHaveLength(1)
      expect(promises).toEqual([{order_id:orders[0].id,state:'converted'}])
      expect(activation.status).toBe('active')
    }else{
      expect(orders).toEqual([])
      expect(promises).toEqual([])
      expect(activation.status).toBe('cancelled')
    }
  })

  it('prices 85-percent-payable only on eligible goods in a mixed basket',async()=>{
    const excluded=await giftProduct(10),cid=await customer(),session=await table([cid])
    const b=await batch({offer:{kind:'discount',discountBps:1500,maximumMinor:5000}}),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    const input={...priceInput(session),lines:[{productId:product,quantity:2},{productId:excluded.pid,quantity:3}]}
    const quote=await runner.run(scope,tx=>new ChannelPricingRepository(tx).prepare(input))
    expect(quote).toMatchObject({subtotalMinor:23000,discountMinor:3000,payableMinor:20000})
    expect(quote.allocations.map(a=>a.discountAmountMinor)).toEqual([3000,0])
    const order=await runner.run(scope,async tx=>{
      await new ChannelDistributionRepository(tx).lockIdentity()
      const policy=new PricingAuthorizationPolicy(new PostgresPricingAuthority())
      const authorization=await policy.authorize(tx,{scope,actor:{type:'employee',employeeId:employee},tableSessionId:session,channel:'staff_assisted',lines:input.lines},{sourceType:'channel_quote',sourceId:quote.id})
      const result=await new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted',lines:input.lines,createdByEmployeeId:employee},authorization)
      await policy.consume(tx,authorization!,result.id);return result
    })
    expect(order.totalAmountMinor).toBe(20000)
    expect(order.items.find(i=>i.productId===excluded.pid)!.discountAmountMinor).toBe(0)
  })
  it('serializes simultaneous percentage quotes and never spends the cap twice',async()=>{
    const b=await batch({offer:{kind:'discount',discountBps:1500,maximumMinor:2000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    const active=await activate(coupon.claimId,cid,session)
    const quotes=await Promise.all([prepare(session),prepare(session)])
    const outcomes=await Promise.allSettled(quotes.map(q=>consumePrice(session,q.id)))
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1)
    const fresh=await prepare(session);expect(fresh.discountMinor).toBe(500)
    expect((await consumePrice(session,fresh.id)).totalAmountMinor).toBe(9500)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('2000')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(2)
  })
  it('reaches percentage threshold through add-ons and deducts the cumulative entitlement once',async()=>{
    const b=await batch({minimumMinor:20000,offer:{kind:'discount',discountBps:1500,maximumMinor:5000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    await runner.run(scope,tx=>new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted',lines:[{productId:product,quantity:1}],createdByEmployeeId:employee}))
    const quote=await prepare(session);expect(quote.discountMinor).toBe(3000)
    expect((await consumePrice(session,quote.id)).totalAmountMinor).toBe(7000)
    expect((await prepare(session)).discountMinor).toBe(1500)
  })
  it('does not restore redeemed percentage cap on a full refund or accrue refunded discount',async()=>{
    const b=await batch({minimumMinor:0,observationDays:0,offer:{kind:'discount',discountBps:1500,maximumMinor:1500}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    const active=await activate(coupon.claimId,cid,session),quote=await prepare(session),order=await consumePrice(session,quote.id)
    expect(order.totalAmountMinor).toBe(8500)
    const payment=await settleMovementOrder(order)
    await financeRefund({payment,order},8500)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('1500')
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(active.visitId!))).toMatchObject({basis:0,target:0})
  })

  it('adds two percentage coupons against original eligible spend, with independent caps and shared L',async()=>{
    const b=await batch({totalClaims:3,perCustomerClaims:3,perVisitUses:2,allowStacking:true,offer:{kind:'discount',discountBps:1500,maximumMinor:2000}}),cid=await customer(),session=await table([cid])
    const a=await issue(b.code,cid),c=await issue(b.token,cid,'staff'),extra=await issue(b.code,cid)
    await activate(a.claimId,cid,session);await activate(c.claimId,cid,session)
    await expect(activate(extra.claimId,cid,session)).rejects.toMatchObject({code:'VISIT_LIMIT'})
    const quote=await prepare(session);expect(quote.discountMinor).toBe(3000)
    expect(quote.coupons.map(x=>x.amountMinor)).toEqual([1500,1500])
    expect((await consumePrice(session,quote.id)).totalAmountMinor).toBe(7000)
    const second=await prepare(session);expect(second.discountMinor).toBe(1000)
    await consumePrice(session,second.id)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(3)
  })
  it('clamps stacked credits to the current item price and only carries their unspent entitlement to add-ons',async()=>{
    const b=await batch({totalClaims:2,perCustomerClaims:2,perVisitUses:2,allowStacking:true,offer:{kind:'credit',amountMinor:8000}}),cid=await customer(),session=await table([cid])
    for(let n=0;n<2;n++){const c=await issue(b.code,cid);await activate(c.claimId,cid,session)}
    const first=await prepare(session);expect(first.coupons.map(c=>c.amountMinor)).toEqual([8000,2000]);expect(first.payableMinor).toBe(0)
    await consumePrice(session,first.id)
    const second=await prepare(session);expect(second.discountMinor).toBe(6000);expect(second.payableMinor).toBe(4000)
    await consumePrice(session,second.id);await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })
  it('stacks same-source gift and discount without discounting the gift or issuing it twice',async()=>{
    const gift=await giftProduct(2),b=await batch({minimumMinor:0,perVisitUses:2,allowStacking:true,offer:{kind:'discount',discountBps:1500,maximumMinor:2000}}),cid=await customer(),session=await table([cid])
    const other=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,minimumMinor:0,perVisitUses:2,allowStacking:true,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[other.id])
    const discount=await issue(b.code,cid),free=await issue(String(other.offerCode),cid)
    await activate(discount.claimId,cid,session);await activate(free.claimId,cid,session)
    const quote=await prepare(session);expect(quote.discountMinor).toBe(1500);await consumePrice(session,quote.id)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:free.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:free.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(2)
    expect((await prepare(session)).discountMinor).toBe(500)
  })
  it('enforces shared campaign claim quota while capacity and budget no longer reserve at issuance',async()=>{
    for(const limit of [{claim:100,capacity:1,cost:1000000},{claim:100,capacity:100,cost:1999},{claim:1,capacity:100,cost:1000000}]){
      const b=await batch({},limit),other=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule,contract:{version:'test'}}))
      await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[other.id])
      const a=await customer(),c=await customer(),outcomes=await Promise.allSettled([issue(b.code,a),issue(String(other.offerCode),c,'staff')])
      expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(limit.claim===1?1:2)
      expect((await admin.query('SELECT count(*)::int AS n,sum(cost_commitment_minor)::text AS cost FROM mbox.channel_claims WHERE batch_id=ANY($1::uuid[])',[[b.id,other.id]])).rows[0]).toEqual({n:limit.claim===1?1:2,cost:'0'})
    }
  })
  it('expired unredeemed coupons never reserve cost or restore N/K',async()=>{
    const b=await batch({totalClaims:4}),cid=await customer(),old=await issue(b.code,cid)
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1",[old.claimId])
    const baseline=(await admin.query(`SELECT count(*) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp()))::int AS held,COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())),0)::text AS cost FROM mbox.channel_claims q JOIN mbox.channel_batches b ON b.id=q.batch_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND NOT q.voided`,args)).rows[0]
    try{
      await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,baseline.held+1,Number(baseline.cost)+1000,employee,'精确剩余一张额度'))
      await expect(issue(b.code,await customer())).resolves.toMatchObject({status:'available'})
      await expect(issue(b.code,await customer())).resolves.toMatchObject({status:'available'})
      await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
    }finally{await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复隔离测试额度'))}
  })
  it('retries a stock failure and lost gift-order response without reserving early or duplicating the order',async()=>{
    const g=await giftProduct(0),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}},{claim:50,capacity:1,cost:0}),cid=await customer(),session=await table([cid])
    const q=await issue(b.code,cid);await activate(q.claimId,cid,session)
    const commands=new NormalizedCommandExecutor(runner),commerce=new CommerceCommandService(commands,new PostgresPricingAuthority()),server=Fastify()
    await server.register(channelDistributionApiPlugin,{transactions:runner,commands,commerce,resolveStaffContext:()=>({scope,employeeId:employee,businessDate:'2026-11-12'}),resolveSelfContext:()=>{throw Error('No self')},resolveGuestContext:()=>{throw Error('No guest')}});await server.ready()
    const request=()=>({method:'POST' as const,url:'/staff/channel/fulfill-gift',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{claimId:q.claimId,tableSessionId:session}})
    try{
      const failed=await server.inject(request());expect(failed.statusCode).toBe(409);expect(failed.json().error).toMatchObject({code:'GIFT_STOCK',commitDisposition:'not_committed'})
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_gift_promises WHERE claim_id=$1',[q.claimId])).rows[0].n).toBe(0)
      await admin.query('UPDATE mbox.inventory_balances SET on_hand_quantity=1 WHERE inventory_item_id=$1',[g.iid]);await admin.query('UPDATE mbox.products SET sale_remaining_quantity=1,cost_amount_minor=260000 WHERE id=$1',[g.pid])
      const write=request(),first=await server.inject(write);expect(first.statusCode,first.body).toBe(200)
      const recovered=await server.inject({...write,headers:{...write.headers,'x-channel-recovery':'1'}});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().meta.replayed).toBe(true);expect(recovered.json().data.orderId).toBe(first.json().data.orderId)
      const duplicate=await server.inject(request());expect(duplicate.statusCode,duplicate.body).toBe(200);expect(duplicate.json().data.orderId).toBe(first.json().data.orderId)
      expect((await admin.query('SELECT cost_minor::text FROM mbox.channel_gift_promises WHERE claim_id=$1',[q.claimId])).rows[0].cost_minor).toBe('260000')
      expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(1)
      expect((await admin.query('SELECT cost_commitment_minor::text,fulfillment_policy FROM mbox.channel_claims WHERE id=$1',[q.claimId])).rows[0]).toEqual({cost_commitment_minor:'0',fulfillment_policy:'on_use'})
      await expect(admin.query("UPDATE mbox.channel_claims SET fulfillment_policy='reserved' WHERE id=$1",[q.claimId])).rejects.toThrow('immutable')
    }finally{await server.close()}
  })
  it('replaces and extends an unused on-use gift without checking stock, keeps consent, and updates staff and customer views',async()=>{
    const g=await giftProduct(0),replacement=await giftProduct(0),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}},{claim:50,capacity:1,cost:0}),cid=await customer(),session=await table([cid]),q=await issue(b.code,cid)
    await activate(q.claimId,cid,session)
    const run=(consent:string)=>runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'replace-gift',employee,'缺货确认替换',{productId:replacement.pid,quantity:2,consent}))
    await expect(run(' ')).rejects.toMatchObject({code:'NOT_REVERSIBLE'});await run('顾客同意更换两份')
    const wallet=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).wallet(cid));expect(wallet[0]).toMatchObject({fulfillmentPolicy:'on_use',offer:{productId:replacement.pid,quantity:2}});expect(wallet[0]!.offer).not.toHaveProperty('costMinor')
    const staff=await app.inject({url:`/staff/channel/table/${session}`});expect(staff.statusCode,staff.body).toBe(200);expect(staff.json().data.activations[0].offer).toMatchObject({productId:replacement.pid,quantity:2})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'extend',employee,'到店延期',{until:new Date(now+3*3600000).toISOString()}))
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_gift_promises WHERE claim_id=$1',[q.claimId])).rows[0].n).toBe(0)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'revoke',employee,'顾客不再使用'))
    expect((await admin.query('SELECT sum(reserved_quantity)::text AS n FROM mbox.inventory_balances WHERE inventory_item_id=ANY($1::uuid[])',[[g.iid,replacement.iid]])).rows[0].n).toBe('0.000000')
  })
  it('expires or cancels on-use entitlements without stock movement, expense or restoring claim limits',async()=>{
    const g=await giftProduct(0),b=await batch({totalClaims:2,minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),q=await issue(b.code,cid)
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1",[q.claimId]);await new ChannelReconciliationWorker(runner).runBatch(scope,'on-use-expiry')
    expect((await admin.query('SELECT status,cost_commitment_minor::text FROM mbox.channel_claims WHERE id=$1',[q.claimId])).rows[0]).toEqual({status:'expired',cost_commitment_minor:'0'})
    await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'extend',employee,'未使用延期',{until:new Date(now+3*3600000).toISOString()}))
    const session=await table([cid]),a=await activate(q.claimId,cid,session)
    await runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(a.activationId!,session,employee,'仅取消绑定'))
    expect((await admin.query('SELECT status FROM mbox.channel_claims WHERE id=$1',[q.claimId])).rows[0].status).toBe('available')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_gift_promises WHERE claim_id=$1',[q.claimId])).rows[0].n).toBe(0)
  })
  it('allows fifty claims against forty-three gifts and a lower budget without changing recorded costs',async()=>{
    const g=await giftProduct(43)
    await admin.query('UPDATE mbox.products SET cost_amount_minor=260000 WHERE id=$1',[g.pid])
    const b=await batch({totalClaims:50,minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:0}},{claim:100,capacity:100,cost:200000})
    const cid=await customer(),preview=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).customerOffer(b.code,cid))
    expect(preview.unavailable).toBeNull()
    expect(preview.offer).not.toHaveProperty('costMinor')
    await issue(b.code,cid)
    await Promise.all(Array.from({length:49},async()=>issue(b.code,await customer())))
    await expect(issue(b.code,await customer())).rejects.toMatchObject({code:'CLAIM_LIMIT'})
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(50)
    expect(Number((await admin.query('SELECT reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[g.iid])).rows[0].reserved_quantity)).toBe(0)
    expect(Number((await admin.query('SELECT cost_amount_minor FROM mbox.products WHERE id=$1',[g.pid])).rows[0].cost_amount_minor)).toBe(260000)
  })
  it('proves all-products scope on the server, freezes IDs and carries it to both landing and wallet',async()=>{
    const catalog=(await admin.query(`SELECT id FROM mbox.products WHERE tenant_id=$1 AND store_id=$2 AND status='active' ORDER BY id`,args)).rows.map(p=>p.id)
    const b=await batch({eligibleProductIds:catalog,eligibleProductScope:'all'}),cid=await customer()
    const preview=()=>runner.run(scope,tx=>new ChannelDistributionRepository(tx).customerOffer(b.code,cid))
    expect((await preview()).eligibleProductScope).toBe('all')
    await issue(b.code,cid)
    const wallet=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).wallet(cid))
    expect(wallet[0]!.eligibleProductScope).toBe('all');expect(wallet[0]!.eligibleProducts.map(p=>p.id).sort()).toEqual([...catalog].sort())
    await giftProduct(1)
    expect((await preview()).eligibleProducts).toHaveLength(catalog.length)
    await expect(batch({eligibleProductIds:catalog,eligibleProductScope:'all'})).rejects.toThrow('商品范围已变化')
    const selected=await batch({eligibleProductIds:[product],eligibleProductScope:'selected'})
    expect((await runner.run(scope,tx=>new ChannelDistributionRepository(tx).customerOffer(selected.code,cid))).eligibleProductScope).toBe('selected')
    await expect(batch({eligibleProductIds:[product],eligibleProductScope:'all'})).rejects.toThrow('商品范围已变化')
  })
  it('keeps customer preview claimable under zero monetary budget without issuing or reserving',async()=>{
    const b=await batch({}, {claim:100,capacity:100,cost:999}),cid=await customer();selfCustomer=cid
    const read=()=>app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    expect((await read()).json().data.unavailable).toBeNull()
    await admin.query('UPDATE mbox.channel_campaigns SET cost_limit_minor=1000 WHERE id=$1',[b.campaign])
    try{
      await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,0,employee,'全店成本暂为零'))
      expect((await read()).json().data.unavailable).toBeNull()
    }finally{await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复测试额度'))}
    expect((await read()).json().data.unavailable).toBeNull()
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(0)
  })
  it('persists every management field through HTTP with authoritative gift cost and immutable paused rules',async()=>{
    const post=(path:string,payload:unknown)=>app.inject({method:'POST',url:`/staff/channel/${path}`,headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
    const partnerResult=await post('partner',{name:' 配置餐厅 ',settlementSubject:'配置公司',promoterName:'店长甲',reason:'逐项模拟'})
    expect(partnerResult.statusCode,partnerResult.body).toBe(200)
    const pid=partnerResult.json().data.promoterId
    const campaign=await post('campaign',{title:'配置活动',claimLimit:30,capacityLimit:20,costLimitMinor:60000,reason:'逐项模拟'})
    expect(campaign.statusCode,campaign.body).toBe(200)
    const campaignId=campaign.json().data.id
    expect((await admin.query('SELECT claim_limit,capacity_limit,cost_limit_minor::text,accepting_claims FROM mbox.channel_campaigns WHERE id=$1',[campaignId])).rows[0]).toEqual({claim_limit:30,capacity_limit:20,cost_limit_minor:'60000',accepting_claims:false})
    const gift=await giftProduct(4)
    for(const offer of [{kind:'credit',amountMinor:1234},{kind:'discount',discountBps:1250,maximumMinor:4567},{kind:'gift',productId:gift.pid,quantity:2,costMinor:1}]){
      const configured={...rule,title:'配置图标题',totalClaims:12,perCustomerClaims:2,perVisitUses:3,minimumMinor:5432,commissionProductIds:[gift.pid],commissionBps:850,observationDays:9,offer}
      const response=await post('batch',{campaignId,promoterId:pid,rule:configured,contract:{version:'合同v2',settlementSubject:'配置公司',terms:'净消费计佣'},reason:'逐项模拟'})
      expect(response.statusCode,response.body).toBe(200)
      const saved=(await admin.query('SELECT rule_snapshot,contract_snapshot,accepting_claims,created_by FROM mbox.channel_batches WHERE id=$1',[response.json().data.id])).rows[0]
      expect(saved.rule_snapshot).toMatchObject({...configured,offer:offer.kind==='gift'?{...offer,costMinor:200}:offer})
      expect(saved).toMatchObject({contract_snapshot:{version:'合同v2',settlementSubject:'配置公司',terms:'净消费计佣'},accepting_claims:false,created_by:employee})
    }
  })
  it('copies the selected promoter latest template into a new paused batch, without consuming quota or copying approval',async()=>{
    const b=await batch(),post=(payload:unknown,key=`channel-${randomUUID()}`)=>app.inject({method:'POST',url:'/staff/channel/batch',headers:{'idempotency-key':key},payload})
    const payload={campaignId:b.campaign,promoterId:promoter,rule:{...rule,title:'复制来源',commissionProductIds:[product]},contract:{version:'复制v1',settlementSubject:'川菜公司',terms:'按净实收计佣'},reason:'配置复制回归'}
    const original=await post(payload);expect(original.statusCode,original.body).toBe(200)
    const source=original.json().data
    const before=(await admin.query('SELECT count(*)::int n FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2',args)).rows[0].n
    const template=await app.inject({url:`/staff/channel/batch-template/${promoter}`});expect(template.statusCode,template.body).toBe(200)
    expect(template.json().data).toMatchObject({id:source.id,campaignId:b.campaign,rule:payload.rule,contract:payload.contract})
    expect(Object.keys(template.json().data).sort()).toEqual(['campaignId','contract','id','rule'])
    expect((await app.inject({url:`/staff/channel/batch-template/${randomUUID()}`})).json().data).toBeNull()
    const key=`channel-${randomUUID()}`,copyPayload={...payload,rule:{...template.json().data.rule,title:'复制后的新批次',claimFrom:new Date(now+86400000).toISOString(),claimUntil:new Date(now+90000000).toISOString(),useFrom:new Date(now+86400000).toISOString(),useUntil:new Date(now+93600000).toISOString()}}
    const copied=await post(copyPayload,key),replayed=await post(copyPayload,key);expect(copied.statusCode,copied.body).toBe(200);expect(replayed.json().data.id).toBe(copied.json().data.id);expect(replayed.json().meta.replayed).toBe(true)
    expect(copied.json().data.offerCode).not.toBe(source.offerCode);expect(copied.json().data.publicToken).not.toBe(source.publicToken)
    const saved=(await admin.query('SELECT accepting_claims,approved_by,created_by FROM mbox.channel_batches WHERE id=$1',[copied.json().data.id])).rows[0]
    expect(saved).toEqual({accepting_claims:false,approved_by:null,created_by:employee})
    const selfApproval=await app.inject({method:'POST',url:'/staff/channel/operations',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{action:'publish',id:copied.json().data.id,enabled:true,expected:{enabled:false},reason:'不能自批'}})
    expect(selfApproval.statusCode).toBe(403)
    expect((await admin.query('SELECT count(*)::int n FROM mbox.channel_claims WHERE tenant_id=$1 AND store_id=$2',args)).rows[0].n).toBe(before)
    expect((await admin.query('SELECT rule_snapshot FROM mbox.channel_batches WHERE id=$1',[source.id])).rows[0].rule_snapshot.title).toBe('复制来源')
  })
  it('reuses a configuration for a new merchant without copying source identity, approval or consumed quota',async()=>{
    const seed=await batch()
    const source={...await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:seed.campaign,promoterId:promoter,rule,contract:{version:'v1',settlementSubject:'原商家公司',terms:'适用商品净实收计佣'}})),campaign:seed.campaign}
    const post=(path:string,payload:unknown,key=`channel-${randomUUID()}`)=>app.inject({method:'POST',url:`/staff/channel/${path}`,headers:{'idempotency-key':key},payload})
    const partnerReply=await post('partner',{name:'新合作茶馆',settlementSubject:'茶馆结算公司',promoterName:'茶馆店长',reason:'复用优惠演练'})
    expect(partnerReply.statusCode,partnerReply.body).toBe(200)
    const target=partnerReply.json().data
    const before=(await admin.query('SELECT rule_snapshot,contract_snapshot,promoter_id,partner_id,offer_code,public_token FROM mbox.channel_batches WHERE id=$1',[source.id])).rows[0]
    const read=await app.inject({url:`/staff/channel/batch-template/${promoter}`});expect(read.statusCode,read.body).toBe(200)
    const template=read.json().data,key=`channel-${randomUUID()}`
    const body={promoterId:target.promoterId,campaignId:template.campaignId,rule:{...template.rule,title:'新商家沿用方案'},contract:{...template.contract,settlementSubject:'茶馆结算公司'},reason:'确认条款适用新商家'}
    const result=await post('batch',body,key);expect(result.statusCode,result.body).toBe(200)
    const replay=await post('batch',body,key);expect(replay.json().data.id).toBe(result.json().data.id)
    const saved=(await admin.query('SELECT promoter_id,partner_id,campaign_id,contract_snapshot,offer_code,public_token,accepting_claims,approved_by FROM mbox.channel_batches WHERE id=$1',[result.json().data.id])).rows[0]
    expect(saved.promoter_id).toBe(target.promoterId);expect(saved.partner_id).toBe(target.id);expect(saved.campaign_id).toBe(source.campaign)
    expect(saved.contract_snapshot.settlementSubject).toBe('茶馆结算公司');expect(saved.accepting_claims).toBe(false);expect(saved.approved_by).toBeNull();expect((await admin.query('SELECT count(*)::int n FROM mbox.channel_claims WHERE batch_id=$1',[result.json().data.id])).rows[0].n).toBe(0)
    expect(saved.offer_code).not.toBe(before.offer_code);expect(saved.public_token).not.toBe(before.public_token)
    expect((await admin.query('SELECT rule_snapshot,contract_snapshot,promoter_id,partner_id,offer_code,public_token FROM mbox.channel_batches WHERE id=$1',[source.id])).rows[0]).toEqual(before)
  })
  it('keeps the selected batch and its source in the directory beyond the recent window, with exact followup linkage',async()=>{
    const b=await batch()
    await admin.query(`INSERT INTO mbox.channel_batches(tenant_id,store_id,campaign_id,partner_id,promoter_id,offer_code,public_token,rule_snapshot,contract_snapshot)
      SELECT tenant_id,store_id,campaign_id,partner_id,promoter_id,translate(upper(substr(md5(random()::text),1,12)),'01','GH'),gen_random_uuid()::text,rule_snapshot,contract_snapshot FROM mbox.channel_batches CROSS JOIN generate_series(1,105) WHERE id=$1`,[b.id])
    const read=await app.inject({url:`/staff/channel/directory?batchId=${b.id}`});expect(read.statusCode,read.body).toBe(200)
    const directory=read.json().data;expect(directory.batches).toHaveLength(100);expect(directory.batches[0]).toMatchObject({id:b.id,campaignId:b.campaign,createdBy:null,approvedAt:null})
    expect(directory.partners.find((p:any)=>p.promoterId===promoter)).toMatchObject({partnerStatus:'active',hasVerifiedAccount:expect.any(Boolean)})
    const payload={promoterId:promoter,batchId:b.id,kind:'sent',note:'已发送当前专属图',nextContactAt:null},key=`channel-${randomUUID()}`
    const post={method:'POST' as const,url:'/staff/channel/followup',headers:{'idempotency-key':key},payload}
    const sent=await app.inject(post);expect(sent.statusCode,sent.body).toBe(200)
    expect((await app.inject({...post,headers:{...post.headers,'x-channel-recovery':'1'}})).json().meta.replayed).toBe(true)
    await admin.query(`INSERT INTO mbox.channel_followups(tenant_id,store_id,promoter_id,employee_id,actor_ref,kind,note) SELECT $1,$2,$3,$4::uuid,'employee:'||$4::uuid::text,'contact','其他联系' FROM generate_series(1,105)`,[...args,promoter,employee])
    const rows=(await app.inject({url:`/staff/channel/directory?batchId=${b.id}`})).json().data.followups.filter((f:any)=>f.id===sent.json().data.id)
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({batchId:b.id,promoterId:promoter,kind:'sent'})
    expect((await app.inject({...post,headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{...payload,promoterId:randomUUID()}})).statusCode).toBe(403)
    const missing=(await app.inject({url:`/staff/channel/directory?batchId=${randomUUID()}`})).json().data;expect(missing.batches).toHaveLength(100)
    expect((await app.inject({url:'/staff/channel/directory?batchId=invalid'})).statusCode).toBe(400)
  })
  it('reads complete campaign and promoter switches and prevents concurrent stale overwrites with recoverable receipts',async()=>{
    const b=await batch(),directory=(await app.inject({url:'/staff/channel/directory'})).json().data
    expect(directory.campaigns.find((c:any)=>c.id===b.campaign)).toMatchObject({acceptingClaims:true,staffEntryEnabled:true,selfEntryEnabled:true})
    expect(directory.partners.find((p:any)=>p.promoterId===promoter)).toMatchObject({status:'active',canConfirmStatement:expect.any(Boolean),restaurantScope:expect.any(Boolean),contactEmployeeId:null})
    const expected={enabled:true,staff:true,self:true},requests=[false,true].map(staff=>({method:'POST' as const,url:'/staff/channel/operations',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{action:'campaign',id:b.campaign,enabled:true,staff,self:!staff,expected,reason:'并发修改入口'}}))
    const results=await Promise.all(requests.map(r=>app.inject(r)));expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
    const success=results.findIndex(r=>r.statusCode===200),last=requests[success]!
    expect((await admin.query('SELECT staff_entry_enabled,self_entry_enabled FROM mbox.channel_campaigns WHERE id=$1',[b.campaign])).rows[0]).toEqual({staff_entry_enabled:last.payload.staff,self_entry_enabled:last.payload.self})
    const replay=await app.inject({...last,headers:{...last.headers,'x-channel-recovery':'1'}});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
    expect((await app.inject({url:'/staff/channel/directory'})).json().data.campaigns.find((c:any)=>c.id===b.campaign)).toMatchObject({staffEntryEnabled:last.payload.staff,selfEntryEnabled:last.payload.self})
  })
  it('refuses stale publish and promoter state without overwriting untouched settings',async()=>{
    const b=await batch(),post=(payload:unknown)=>app.inject({method:'POST',url:'/staff/channel/operations',headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
    expect((await post({action:'publish',id:b.id,enabled:false,expected:{enabled:false},reason:'旧页面状态'})).statusCode).toBe(409)
    const correct=await post({action:'publish',id:b.id,enabled:false,expected:{enabled:true},reason:'核对后暂停'});expect(correct.statusCode,correct.body).toBe(200)
    const create=await app.inject({method:'POST',url:'/staff/channel/partner',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{name:'状态回显店',settlementSubject:'回显公司',promoterName:'回显店长',reason:'回显回归'}})
    const id=create.json().data.promoterId
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).promoter(id,true,true,true,employee,employee,'完整状态'))
    const current={enabled:true,confirm:true,restaurantScope:true,contactEmployeeId:employee}
    const stale=await post({action:'promoter',id,enabled:true,confirm:false,restaurantScope:false,contactEmployeeId:employee,expected:{...current,confirm:false},reason:'拒绝覆盖'})
    expect(stale.statusCode).toBe(409)
    const saved=await post({action:'promoter',id,enabled:true,confirm:false,restaurantScope:true,contactEmployeeId:employee,expected:current,reason:'只改确认权限'});expect(saved.statusCode,saved.body).toBe(200)
    expect((await app.inject({url:'/staff/channel/directory'})).json().data.partners.find((p:any)=>p.promoterId===id)).toMatchObject({canConfirmStatement:false,restaurantScope:true,contactEmployeeId:employee})
    expect((await post({action:'campaign',id:b.campaign,enabled:true,staff:true,self:true,expected:{enabled:true},reason:'不完整快照'})).statusCode).toBe(400)
  })
  it('accepts the advertised maximum 500 eligible products through the HTTP configuration route',async()=>{
    const ids=Array.from({length:500},()=>randomUUID()),b=await batch()
    await admin.query(`INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station) SELECT id,$1,$2,id::text,'配置商品','drinks','bar' FROM unnest($3::uuid[]) id`,[...args,ids])
    const response=await app.inject({method:'POST',url:'/staff/channel/batch',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{campaignId:b.campaign,promoterId:promoter,rule:{...rule,eligibleProductIds:ids,commissionProductIds:ids},contract:{version:'v1',settlementSubject:'川菜公司',terms:'500商品测试'},reason:'最大配置测试'}})
    expect(response.statusCode,response.body).toBe(200)
    expect((await admin.query('SELECT rule_snapshot FROM mbox.channel_batches WHERE id=$1',[response.json().data.id])).rows[0].rule_snapshot.eligibleProductIds).toHaveLength(500)
  })
  it('independently switches staff and self claims but preserves previously issued promises',async()=>{
    const b=await batch(),cid=await customer(),prior=await issue(b.code,cid),session=await table([cid])
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).campaign(b.campaign,true,false,true,employee,'只开顾客入口'))
    await expect(issue(b.code,await customer(),'staff')).rejects.toMatchObject({code:'PAUSED'})
    await expect(issue(b.code,await customer(),'self')).resolves.toMatchObject({status:'available'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).campaign(b.campaign,true,true,false,employee,'只开员工入口'))
    await expect(issue(b.code,await customer(),'self')).rejects.toMatchObject({code:'PAUSED'})
    await expect(issue(b.code,await customer(),'staff')).resolves.toMatchObject({status:'available'})
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).campaign(b.campaign,false,false,false,employee,'停止新增'))
    await expect(activate(prior.claimId,cid,session)).resolves.toMatchObject({status:'active'})
  })

  it('serializes cross-campaign claim quota without reserving budget or capacity',async()=>{
    for(const kind of ['claims','capacity','cost']){
      const a=await batch(),b=await batch(),ca=await customer(),cb=await customer()
      const base=(await admin.query(`SELECT count(*)::int AS issued,count(*) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp()))::int AS held,COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())),0)::text AS cost FROM mbox.channel_claims q JOIN mbox.channel_batches b ON b.id=q.batch_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND NOT q.voided`,args)).rows[0]
      try{
        await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(kind==='claims'?base.issued+1:100000,kind==='capacity'?base.held+1:100000,kind==='cost'?Number(base.cost)+1999:1e9,employee,'全店边界并发'))
        const outcomes=await Promise.allSettled([issue(a.code,ca),issue(b.token,cb,'staff')])
        expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(kind==='claims'?1:2)
        expect(outcomes.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(kind==='claims'?['STORE_LIMIT']:[])
      }finally{await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复隔离限额'))}
    }
  })
  it('legacy: uses the same elapsed-promise capacity for extensions before the expiry worker runs',async()=>{
    const b=await batch({}, {claim:3,capacity:1,cost:1000}),old=await seedLegacyClaim(b.code,await customer())
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1",[old.claimId])
    const current=await seedLegacyClaim(b.code,await customer()),until=new Date(Date.now()+3*3600000).toISOString()
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(current.claimId,'extend',employee,'门店延迟核验',{until}))).resolves.toMatchObject({id:current.claimId})
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(old.claimId,'extend',employee,'不得多占份数',{until}))).rejects.toMatchObject({code:'CAPACITY'})
  })
  it('stores operational switches, contact permissions and all follow-up states through HTTP',async()=>{
    const post=(path:string,payload:unknown)=>app.inject({method:'POST',url:`/staff/channel/${path}`,headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
    const b=await batch(),created=await post('partner',{name:'独立配置餐厅',settlementSubject:'独立公司',promoterName:'配置店长',reason:'权限验证'})
    expect(created.statusCode).toBe(200);const pid=created.json().data.promoterId
    const permissions=await post('operations',{action:'promoter',id:pid,enabled:true,confirm:true,restaurantScope:true,contactEmployeeId:employee,reason:'本人授权'})
    expect(permissions.statusCode,permissions.body).toBe(200)
    expect((await admin.query('SELECT status,can_confirm_statement,restaurant_scope,contact_employee_id FROM mbox.channel_promoters WHERE id=$1',[pid])).rows[0]).toEqual({status:'active',can_confirm_statement:true,restaurant_scope:true,contact_employee_id:employee})
    for(const [staff,self] of [[false,true],[true,false],[false,false]]){
      const result=await post('operations',{action:'campaign',id:b.campaign,enabled:true,staff,self,reason:'入口逐项配置'})
      expect(result.statusCode,result.body).toBe(200)
      expect((await admin.query('SELECT staff_entry_enabled,self_entry_enabled FROM mbox.channel_campaigns WHERE id=$1',[b.campaign])).rows[0]).toEqual({staff_entry_enabled:staff,self_entry_enabled:self})
    }
    const followupBatch=await batch({},undefined,pid)
    const nextContactAt=new Date(Date.now()+86400000).toISOString()
    for(const kind of ['sent','received']){
      const invalid=await post('followup',{promoterId:pid,batchId:null,kind,note:'不得脱离批次登记',nextContactAt:null})
      expect(invalid.statusCode,invalid.body).toBe(400)
      const wrong=await post('followup',{promoterId:pid,batchId:b.id,kind,note:'不得串用商家批次',nextContactAt:null})
      expect(wrong.statusCode,wrong.body).toBe(403)
    }
    for(const kind of ['sent','received','feedback','contact']){
      const request={method:'POST' as const,url:'/staff/channel/followup',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{promoterId:pid,batchId:['sent','received'].includes(kind)?followupBatch.id:null,kind,note:kind==='contact'?'中'.repeat(2000):'逐项交流记录',nextContactAt}}
      const result=await app.inject(request);expect(result.statusCode,kind+':'+result.body).toBe(200)
      const replay=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toEqual(result.json().data)
    }
    const rows=(await admin.query('SELECT kind,note,next_contact_at FROM mbox.channel_followups WHERE promoter_id=$1',[pid])).rows
    expect(rows).toHaveLength(4);expect(rows.every(r=>r.note===(r.kind==='contact'?'中'.repeat(2000):'逐项交流记录')&&new Date(r.next_contact_at).toISOString()===nextContactAt)).toBe(true)
    // Preserve a pre-upgrade successful receipt without permitting new unbatched sends.
    const legacyInput={promoterId:pid,batchId:null,kind:'sent',note:'旧版已发送，丢失回执',nextContactAt:null},legacyKey='channel-'+randomUUID()
    const legacy=await new NormalizedCommandExecutor(runner).execute({scope,operationScope:'channel.partner.followup',idempotencyKey:legacyKey,requestFingerprint:JSON.stringify({input:legacyInput,employeeId:employee}),retainReceipt:true,resultCodec:{encode:(v:{id:string})=>v,decode:(v:unknown)=>v as {id:string}}},async tx=>({result:await new ChannelPartnerRepository(tx).followup({...legacyInput,employeeId:employee,actorRef:`employee:${employee}`}) as {id:string},auditEvents:[],outboxMessages:[]}))
    const recovery={method:'POST' as const,url:'/staff/channel/followup',headers:{'idempotency-key':legacyKey,'x-channel-recovery':'1'},payload:legacyInput}
    const recovered=await app.inject(recovery);expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toMatchObject({data:{id:legacy.value.id},meta:{replayed:true}})
    const missing=await app.inject({...recovery,headers:{...recovery.headers,'idempotency-key':'channel-'+randomUUID()}})
    expect(missing.statusCode,missing.body).toBe(409)
    const changed=await app.inject({...recovery,payload:{...legacyInput,note:'不能改写旧回执'}});expect(changed.statusCode,changed.body).toBe(409)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_followups WHERE promoter_id=$1',[pid])).rows[0].n).toBe(5)

  })
  it('rejects forged extra configuration fields and keeps the enlarged batch route bounded',async()=>{
    const b=await batch(),base={campaignId:b.campaign,promoterId:promoter,rule,contract:{version:'v1',settlementSubject:'川菜公司',terms:'约定条款'},reason:'输入验证'}
    const send=(payload:unknown)=>app.inject({method:'POST',url:'/staff/channel/batch',headers:{'idempotency-key':`channel-${randomUUID()}`},payload})
    const before=(await admin.query('SELECT count(*)::int AS n FROM mbox.channel_batches WHERE campaign_id=$1',[b.campaign])).rows[0].n
    for(const payload of [{...base,enabled:true},{...base,rule:{...rule,commissionBps:10001}},{...base,rule:{...rule,totalClaims:1,perCustomerClaims:2}},{...base,rule:{...rule,offer:{kind:'credit',amountMinor:100,discountBps:1000}}}])expect((await send(payload)).statusCode).toBe(400)
    expect((await send({...base,reason:'x'.repeat(512*1024)})).statusCode).toBe(413)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_batches WHERE campaign_id=$1',[b.campaign])).rows[0].n).toBe(before)
  })

  it('creates a usable promoter invitation through HTTP and recovers it without issuing a second secret',async()=>{
    const partnerResponse=await app.inject({method:'POST',url:'/staff/channel/partner',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{name:'邀请回归餐厅',settlementSubject:'邀请公司',promoterName:'店长',reason:'邀请测试'}})
    expect(partnerResponse.statusCode).toBe(200);const pid=partnerResponse.json().data.promoterId
    const request={method:'POST' as const,url:'/staff/channel/invite',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{promoterId:pid}}
    const original=await app.inject(request);expect(original.statusCode,original.body).toBe(200)
    const replay=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
    expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toEqual(original.json().data)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_web_invitations WHERE promoter_id=$1',[pid])).rows[0].n).toBe(1)
    const accepted=await app.inject({method:'POST',url:'/cooperation/activate',headers:{origin:'https://www.shmbox.com','x-channel-web':'1'},payload:{token:original.json().data.token,username:'invite_'+pid.replaceAll('-','').slice(0,20),password:'fixture-password-123'}})
    expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().data.activated).toBe(true)

  })

  it('website distinguishes a reconciled zero commission from a pending or frozen calculation',async()=>{
    const f=await financeFixture(),headers=await webSession(f.rid)
    const visit=async()=>{
      const response=await app.inject({method:'GET',url:'/cooperation/partner',headers})
      expect(response.statusCode,response.body).toBe(200)
      return response.json().data.visits.find((v:{visitNumber:string})=>v.visitNumber===channelAnonymousVisit(f.rid,f.visitId))
    }
    expect(await visit()).toMatchObject({qualifiedConsumptionMinor:null,accruedCommissionMinor:null})
    await admin.query("UPDATE mbox.payments SET status='pending' WHERE id=$1",[f.payment])
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))).toMatchObject({target:0,frozen:true})
    expect(await visit()).toMatchObject({accruedCommissionMinor:null})
    await admin.query("UPDATE mbox.payments SET status='succeeded' WHERE id=$1",[f.payment])
    await financeRefund(f,9000)
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(f.visitId))).toMatchObject({target:0,frozen:false})
    expect(await visit()).toMatchObject({qualifiedConsumptionMinor:'0',accruedCommissionMinor:'0'})
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_ledger WHERE visit_id=$1',[f.visitId])).rows[0].n).toBe(0)
  })

  it('website invitation activation, password login, reset and logout isolate customer and staff identities',async()=>{
    const f=await financeFixture(),origin={origin:'https://www.shmbox.com','x-channel-web':'1'},username='web_'+f.rid.replaceAll('-','').slice(0,20),password='fixture-password-123'
    const post=(url:string,payload:object,headers:Record<string,string>=origin)=>app.inject({method:'POST',url:'/cooperation/'+url,remoteAddress:'192.0.2.91',headers,payload})
    const invite=await runner.run(scope,tx=>inviteChannelWeb(tx,f.rid,employee))
    expect((await post('activate',{token:invite.token,username,password},{origin:'https://evil.example','x-channel-web':'1'})).statusCode).toBe(403)
    const results=await Promise.all([post('activate',{token:invite.token,username,password}),post('activate',{token:invite.token,username,password})])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,401])
    expect((await post('login',{username,password:'wrong-password-123'})).statusCode).toBe(401)
    const login=await post('login',{username,password});expect(login.statusCode,login.body).toBe(200)
    const cookie=String(login.headers['set-cookie']);expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);expect(cookie).toContain('Path=/cooperation')
    const headers={cookie:cookie.split(';')[0]!}
    const own=await app.inject({method:'GET',url:'/cooperation/partner',headers});expect(own.statusCode,own.body).toBe(200)
    expect(own.body).not.toMatch(/customerId|customerName|customerPhone|orderId|orderCount|tableId|tableName|evidence|accountReference|accountSubject|promoterId|contact|restaurant/)
    expect((await app.inject({method:'GET',url:'/cooperation/partner'})).statusCode).toBe(401)
    for(const url of ['/public/mini/channel/partner','/public/mini/channel/history','/public/mini/channel/poster/'+randomUUID(),'/public/mini/channel/statement/'+randomUUID()])expect((await app.inject({method:'GET',url,headers})).statusCode).toBe(404)
    const statement=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(f.rid,f.account,employee,'网页核对'))
    const input={id:statement.id,dispute:false,reason:'核对匿名金额'},key='channel-'+randomUUID()
    expect((await post('statement-response',input,{...headers,'idempotency-key':key})).statusCode).toBe(403)
    const command={...origin,...headers,'idempotency-key':key}
    const confirmed=await post('statement-response',input,command);expect(confirmed.statusCode,confirmed.body).toBe(200)
    expect((await post('statement-response',input,{...command,'idempotency-key':'channel-'+randomUUID()})).statusCode).toBe(409)
    const replay=await post('statement-response',input,{...command,'x-channel-recovery':'1'});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
    expect((await admin.query('SELECT confirmed_by,confirmed_by_promoter_id FROM mbox.channel_statements WHERE id=$1',[statement.id])).rows[0]).toEqual({confirmed_by:null,confirmed_by_promoter_id:f.rid})
    const foreign=await financeFixture(),foreignStatement=await runner.run(scope,tx=>new ChannelFinanceRepository(tx).statement(foreign.rid,foreign.account,employee,'其他推荐人'))
    expect((await app.inject({method:'GET',url:'/cooperation/statement/'+foreignStatement.id,headers})).statusCode).toBe(403)
    await runner.run(scope,tx=>new ChannelFinanceRepository(tx).approve(statement.id,reviewer,'网页确认后独立审批'))
    const reset=await runner.run(scope,tx=>inviteChannelWeb(tx,f.rid,employee)),newPassword='reset-fixture-password'
    expect((await post('activate',{token:reset.token,username,password:newPassword})).statusCode).toBe(200)
    expect((await post('statement-response',input,{...command,'x-channel-recovery':'1'})).statusCode).toBe(401)
    expect((await app.inject({method:'GET',url:'/cooperation/partner',headers})).statusCode).toBe(401)
    expect((await post('login',{username,password})).statusCode).toBe(401)
    const newLogin=await post('login',{username,password:newPassword});expect(newLogin.statusCode,newLogin.body).toBe(200)
    const fresh={cookie:String(newLogin.headers['set-cookie']).split(';')[0]!}
    expect((await post('statement-response',input,{...origin,...fresh,'idempotency-key':key,'x-channel-recovery':'1'})).json().meta.replayed).toBe(true)
    expect((await post('logout',{}, {...origin,...fresh})).statusCode).toBe(200)
    expect((await app.inject({method:'GET',url:'/cooperation/partner',headers:fresh})).statusCode).toBe(401)
  },30000)
  it('stopping a website promoter permanently revokes sessions and runtime cannot reassign or un-revoke them',async()=>{
    const f=await financeFixture(),headers=await webSession(f.rid)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).promoter(f.rid,false,true,false,employee,employee,'停止合作'))
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).promoter(f.rid,true,true,false,employee,employee,'恢复账号但需重新登录'))
    expect((await app.inject({method:'GET',url:'/cooperation/partner',headers})).statusCode).toBe(401)
    await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.channel_web_sessions SET revoked_at=NULL WHERE promoter_id=$1',[f.rid]))).rejects.toThrow('revocation is final')
    await expect(runner.run(scope,tx=>tx.query('UPDATE mbox.channel_web_sessions SET promoter_id=$2 WHERE promoter_id=$1',[f.rid,promoter]))).rejects.toMatchObject({code:'42501'})
  })
  it('website login throttling persists rejected attempts and ignores forged client IP headers',async()=>{
    const username='missing_'+randomUUID().replaceAll('-','').slice(0,16)
    for(let i=0;i<11;i++){
      const response=await app.inject({method:'POST',url:'/cooperation/login',remoteAddress:'192.0.2.92',headers:{origin:'https://www.shmbox.com','x-channel-web':'1','x-forwarded-for':`198.51.100.${i}`},payload:{username,password:'wrong-password-123'}})
      expect(response.statusCode,response.body).toBe(i<10?401:429)
    }
  },30000)
  it('rejects expired and regenerated website invitations without consuming another account',async()=>{
    const f=await financeFixture(),old=await runner.run(scope,tx=>inviteChannelWeb(tx,f.rid,employee)),current=await runner.run(scope,tx=>inviteChannelWeb(tx,f.rid,employee))
    const send=(token:string)=>app.inject({method:'POST',url:'/cooperation/activate',remoteAddress:'192.0.2.93',headers:{origin:'https://www.shmbox.com','x-channel-web':'1'},payload:{token,username:'expire_'+f.rid.slice(0,8),password:'fixture-password-123'}})
    expect((await send(old.token)).statusCode).toBe(401)
    await admin.query("UPDATE mbox.channel_web_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[current.id])
    expect((await send(current.token)).statusCode).toBe(401)
    const replacement=await runner.run(scope,tx=>inviteChannelWeb(tx,f.rid,employee));expect(replacement.token).not.toBe(current.token)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_web_accounts WHERE promoter_id=$1',[f.rid])).rows[0].n).toBe(0)
  })

  it('defaults to no stacking even when L is larger, and rolls back a second staff claim atomically',async()=>{
    const b=await batch({totalClaims:3,perCustomerClaims:3,perVisitUses:3}),cid=await customer(),session=await table([cid]),first=await issue(b.code,cid)
    await activate(first.claimId,cid,session)
    const response=await app.inject({method:'POST',url:'/staff/channel/activate',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{code:b.code,customerId:cid,tableSessionId:session,issueNew:true}})
    expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('STACKING_DISABLED')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
    const second=await issue(b.code,cid)
    await expect(activate(second.claimId,cid,session)).rejects.toMatchObject({code:'STACKING_DISABLED'})
    const current=await activate(first.claimId,cid,session);expect(current.reused).toBe(true)
    await runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(current.activationId!,session,employee,'未兑现换券'))
    await expect(activate(second.claimId,cid,session)).resolves.toMatchObject({status:'active'})
  })
  it('caps stacked coupons once per party across whole-table transfer and subsequent refund',async()=>{
    const b=await batch({totalClaims:3,perCustomerClaims:3,perVisitUses:3,allowStacking:true,visitDiscountCapMinor:4000,observationDays:0,offer:{kind:'discount',discountBps:1500,maximumMinor:5000}}),cid=await customer(),session=await table([cid])
    let visit='';for(let i=0;i<2;i++){const coupon=await issue(b.code,cid);visit=(await activate(coupon.claimId,cid,session)).visitId!}
    const firstQuote=await prepare(session);expect(firstQuote.discountMinor).toBe(3000);const first=await consumePrice(session,firstQuote.id)
    const payment=await settleMovementOrder(first)
    const moved=await app.inject(await moveRequest(session,await emptyMovementTable(),'whole_table_transfer'));expect(moved.statusCode,moved.body).toBe(200)
    const nextQuote=await prepare(session);expect(nextQuote.discountMinor).toBe(1000);const second=await consumePrice(session,nextQuote.id);await settleMovementOrder(second)
    await financeRefund({payment,order:first},2000)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    const last=await issue(b.code,cid);await expect(activate(last.claimId,cid,session)).rejects.toMatchObject({code:'DISCOUNT_CAP'})
    const view=await app.inject({method:'GET',url:`/staff/channel/table/${session}`});expect(view.statusCode).toBe(200)
    expect(view.json().data.activations[0]).toMatchObject({allowStacking:true,visitDiscountCapMinor:4000,usedDiscountMinor:'4000'})
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",[session])
    expect(await runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visit))).toMatchObject({basis:14000,target:1400})
  })
  it('shares the remaining total cap between split tables under simultaneous add-on checkout',async()=>{
    const b=await batch({totalClaims:2,perCustomerClaims:2,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:4000,offer:{kind:'discount',discountBps:1500,maximumMinor:5000}}),cid=await customer(),other=await customer(),source=await table([cid,other])
    for(let i=0;i<2;i++){const coupon=await issue(b.code,cid);await activate(coupon.claimId,cid,source)}
    const first=await consumePrice(source,(await prepare(source)).id);await settleMovementOrder(first)
    const targetTable=await emptyMovementTable(),moved=await app.inject(await moveRequest(source,targetTable,'participant_split',null,[other],1));expect(moved.statusCode,moved.body).toBe(200)
    const target=(await admin.query("SELECT id FROM mbox.table_sessions WHERE table_id=$1 AND status='open'",[targetTable])).rows[0].id
    const quotes=await Promise.all([prepare(source),prepare(target)]);expect(quotes.map(q=>q.discountMinor)).toEqual([1000,1000])
    const results=await Promise.allSettled([consumePrice(source,quotes[0]!.id),consumePrice(target,quotes[1]!.id)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
    for(const session of [source,target])await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })
  it('does not raise a locked group cap or bypass a non-stacking source with a later batch',async()=>{
    const b=await batch({perVisitUses:3,allowStacking:true,visitDiscountCapMinor:2000}),cid=await customer(),session=await table([cid]),one=await issue(b.code,cid)
    const active=await activate(one.claimId,cid,session)
    const make=async(allowStacking:boolean,visitDiscountCapMinor:number|null)=>{
      const row=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,perVisitUses:3,allowStacking,visitDiscountCapMinor},contract:{version:'test'}}))
      await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[row.id]);return issue(String(row.offerCode),cid)
    }
    const bigger=await make(true,5000);await activate(bigger.claimId,cid,session)
    expect((await admin.query('SELECT discount_cap_minor::int AS cap FROM mbox.channel_visits WHERE id=$1',[active.visitId])).rows[0].cap).toBe(2000)
    const off=await make(false,null);await expect(activate(off.claimId,cid,session)).rejects.toMatchObject({code:'STACKING_DISABLED'})
    await expect(admin.query('UPDATE mbox.channel_visits SET discount_cap_minor=5000 WHERE id=$1',[active.visitId])).rejects.toMatchObject({code:'23514'})
    const plain=await batch({perVisitUses:3}),plainCid=await customer(),plainTable=await table([plainCid]),plainCoupon=await issue(plain.code,plainCid),plainVisit=await activate(plainCoupon.claimId,plainCid,plainTable)
    await expect(admin.query('UPDATE mbox.channel_visits SET stacking_allowed=true WHERE id=$1',[plainVisit.visitId])).rejects.toMatchObject({code:'23514'})
    const later=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:plain.campaign,promoterId:promoter,rule:{...rule,perVisitUses:3,allowStacking:true,visitDiscountCapMinor:5000},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[later.id])
    const laterClaim=await issue(String(later.offerCode),plainCid)
    await expect(activate(laterClaim.claimId,plainCid,plainTable)).rejects.toMatchObject({code:'STACKING_DISABLED'})

  })
  it('counts full gift retail discount toward the same cap and rolls back an unaffordable gift completely',async()=>{
    const gift=await giftProduct(1),b=await batch({minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500,offer:{kind:'credit',amountMinor:1000}}),cid=await customer(),session=await table([cid])
    const row=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[row.id])
    const a=await issue(b.code,cid),g=await issue(String(row.offerCode),cid);await activate(a.claimId,cid,session);await activate(g.claimId,cid,session)
    await consumePrice(session,(await prepare(session)).id)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    await expect(runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:g.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))).rejects.toThrow('余额不足')
    expect((await admin.query('SELECT state,order_id FROM mbox.channel_gift_promises WHERE claim_id=$1',[g.claimId])).rows[0]).toBeUndefined()
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(1)
  })
  it('a gift redeemed first leaves only the remaining capped monetary discount',async()=>{
    const gift=await giftProduct(1),b=await batch({minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500,offer:{kind:'credit',amountMinor:1000}}),cid=await customer(),session=await table([cid])
    const row=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[row.id])
    const a=await issue(b.code,cid),g=await issue(String(row.offerCode),cid);await activate(a.claimId,cid,session);await activate(g.claimId,cid,session)
    const stale=await prepare(session),commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:g.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    await expect(consumePrice(session,stale.id)).rejects.toThrow('重新确认')
    const fresh=await prepare(session);expect(fresh.discountMinor).toBe(500);await consumePrice(session,fresh.id)
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })
  it('returns cap only for unpaid unmade cancelled orders, never by replaying the release',async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500,offer:{kind:'credit',amountMinor:1000}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id);expect(order.discountAmountMinor).toBe(500)
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    const again=await prepare(session);expect(again.discountMinor).toBe(500)
    await runner.run(scope,tx=>new ChannelPricingRepository(tx).releaseUnusedCancelled(active.visitId!))
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('0')
    await consumePrice(session,again.id);await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
  })

  it('exposes configured stacking and caps through self preview and wallet',async()=>{
    const b=await batch({allowStacking:true,visitDiscountCapMinor:1234}),cid=await customer();selfCustomer=cid
    const preview=await app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`});expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({allowStacking:true,visitDiscountCapMinor:1234})
    await issue(b.code,cid)
    const wallet=await app.inject({method:'GET',url:'/public/mini/channel/wallet'})
    expect(wallet.json().data[0]).toMatchObject({allowStacking:true,visitDiscountCapMinor:1234})
    expect(wallet.json().data[0].offer).not.toHaveProperty('costMinor')
  })
  it('tightens a new batch cap only above already-used money and keeps the total stable after an unused cancellation',async()=>{
    const b=await batch({allowStacking:true,visitDiscountCapMinor:4000,perVisitUses:3}),cid=await customer(),session=await table([cid]),c=await issue(b.code,cid),active=await activate(c.claimId,cid,session)
    await consumePrice(session,(await prepare(session)).id)
    const make=async(cap:number)=>{
      const row=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,perVisitUses:3,allowStacking:true,visitDiscountCapMinor:cap},contract:{version:'test'}}))
      await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[row.id]);return issue(String(row.offerCode),cid)
    }
    const tooSmall=await make(500);await expect(activate(tooSmall.claimId,cid,session)).rejects.toMatchObject({code:'DISCOUNT_CAP'})
    const smaller=await make(1500),second=await activate(smaller.claimId,cid,session)
    await runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(second.activationId!,session,employee,'未用取消但保留客组上限'))
    expect((await admin.query('SELECT discount_cap_minor::int AS cap FROM mbox.channel_visits WHERE id=$1',[active.visitId])).rows[0].cap).toBe(1500)
    const larger=await make(9000);await activate(larger.claimId,cid,session)
    expect((await prepare(session)).discountMinor).toBe(500)
  })

  for(const paymentStatus of ['created','pending'])it(`keeps cancelled discount occupied while a ${paymentStatus} payment is unresolved`,async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id),payment=randomUUID()
    // Historical/abnormal state probe: not a claim that normal cancellation permits pending payment.
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status) VALUES($3::uuid,$1,$2,$4,$3::text,'postar','jsapi',$5,$6)`,[...args,payment,order.id,order.totalAmountMinor,paymentStatus])
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    await runner.run(scope,tx=>new ChannelPricingRepository(tx).releaseUnusedCancelled(active.visitId!))
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('500')
    await expect(prepare(session)).rejects.toThrow('尚无可抵扣')
    await admin.query("UPDATE mbox.payments SET status='closed' WHERE id=$1",[payment])
    expect((await prepare(session)).discountMinor).toBe(500)
  })
  it('preserves a channel discount after local closure with an unposted success receipt',async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid])
    const claim=await issue(b.code,cid),active=await activate(claim.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id),payment=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status)
      VALUES($3::uuid,$1,$2,$4,$3::text,'postar','jsapi',$5,'closed')`,[...args,payment,order.id,order.totalAmountMinor])
    await new VerifiedProviderObservationService(runner).recordPayment({scope,provider:'postar',verificationKind:'active_query_binding',
      providerEventId:randomUUID(),integrationRef:'isolated-channel-success',paymentPublicId:payment,providerTransactionId:randomUUID(),
      reportedAmountMinor:order.totalAmountMinor,reportedCurrency:'CNY',status:'succeeded',occurredAt:new Date().toISOString()})
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    await runner.run(scope,tx=>new ChannelPricingRepository(tx).releaseUnusedCancelled(active.visitId!))
    expect((await admin.query('SELECT applied_discount_minor::int AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe(500)
  })
  it('allows immediate unused activation cancellation after safe order cancellation without waiting for a worker',async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id)
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    await expect(runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(active.activationId!,session,employee,'未付款未制作整单撤销'))).resolves.toMatchObject({status:'cancelled'})
    await activate(coupon.claimId,cid,session);expect((await prepare(session)).discountMinor).toBe(500)
  })
  it('reconciles safe cancelled holds before binding another stacked coupon',async()=>{
    const b=await batch({minimumMinor:0,totalClaims:2,perCustomerClaims:2,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid]),first=await issue(b.code,cid),second=await issue(b.code,cid)
    await activate(first.claimId,cid,session);const order=await consumePrice(session,(await prepare(session)).id)
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    await expect(activate(second.claimId,cid,session)).resolves.toMatchObject({status:'active'})
    expect((await prepare(session)).discountMinor).toBe(500)
  })
  it('serializes simultaneous cancellation releases so both retries succeed and only one release is recorded',async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id)
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[order.id])
    // Hold the row to force both readers to overlap rather than rely on scheduling luck.
    const blocker=await admin.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM mbox.channel_activations WHERE id=$1 FOR UPDATE',[active.activationId])
    try{
      const attempts=Promise.allSettled(Array.from({length:3},()=>runner.run(scope,tx=>new ChannelPricingRepository(tx).releaseUnusedCancelled(active.visitId!))))
      await new Promise(resolve=>setTimeout(resolve,100));await blocker.query('COMMIT')
      expect((await attempts).map(r=>r.status)).toEqual(['fulfilled','fulfilled','fulfilled'])
    }finally{await blocker.query('ROLLBACK');blocker.release()}
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_price_releases WHERE order_id=$1',[order.id])).rows[0].n).toBe(1)
    expect((await prepare(session)).discountMinor).toBe(500)
  })

  it('retains the cap for a delivered item cancelled by the real unpaid-cancellation operation even without a KDS history',async()=>{
    const b=await batch({minimumMinor:0,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const order=await consumePrice(session,(await prepare(session)).id)
    await admin.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[order.id])
    await admin.query(`INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,'order.cancel_unpaid','撤销未付订单') ON CONFLICT DO NOTHING`,args)
    await admin.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,r.role_id,p.id FROM mbox.employee_roles r JOIN mbox.staff_permission_definitions p ON (p.tenant_id,p.store_id)=(r.tenant_id,r.store_id) WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.employee_id=$3 AND p.code='order.cancel_unpaid' ON CONFLICT DO NOTHING`,[...args,employee])
    const date=(await admin.query(`SELECT ((clock_timestamp() AT TIME ZONE timezone)-business_day_cutoff)::date::text AS date FROM mbox.stores WHERE id=$1`,[scope.storeId])).rows[0].date
    const cancelled=await new PostgresOrderCancellationRepository(runner).cancel({scope,orderId:order.id,employeeId:employee,businessDate:date,reasonCode:'guest_left',reasonNote:'已送达但尚未付款，核实离店',idempotencyKey:randomUUID()})
    expect(cancelled.deliveredItemCount).toBe(1)
    await runner.run(scope,tx=>new ChannelPricingRepository(tx).releaseUnusedCancelled(active.visitId!))
    expect((await admin.query('SELECT applied_discount_minor::text AS used FROM mbox.channel_activations WHERE id=$1',[active.activationId])).rows[0].used).toBe('500')
    await expect(runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(active.activationId!,session,employee,'已送达不得返还优惠'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
  })
  it('replays concurrent HTTP activation receipts across transfer without claiming or binding twice',async()=>{
    const b=await batch({totalClaims:3,perCustomerClaims:3,perVisitUses:3,allowStacking:true,visitDiscountCapMinor:500}),cid=await customer(),session=await table([cid])
    const request={method:'POST' as const,url:'/staff/channel/activate',headers:{'idempotency-key':'channel-'+randomUUID()},payload:{code:b.code,customerId:cid,tableSessionId:session}}
    const replies=await Promise.all([app.inject(request),app.inject(request),app.inject({...request,headers:{'idempotency-key':'channel-'+randomUUID()}})])
    for(const r of replies)expect(r.statusCode,r.body).toBe(200)
    expect(new Set(replies.map(r=>r.json().data.activationId)).size).toBe(1)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
    const moved=await app.inject(await moveRequest(session,await emptyMovementTable(),'whole_table_transfer'));expect(moved.statusCode,moved.body).toBe(200)
    const replay=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
    expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data.activationId).toBe(replies[0]!.json().data.activationId)
    const quote=await prepare(session),orders=await Promise.allSettled([consumePrice(session,quote.id),consumePrice(session,quote.id)])
    expect(orders.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(1)
  })
  it('preserves shared cap through split, destination transfer, safe cancellation and processing-to-success refund',async()=>{
    const b=await batch({totalClaims:2,perCustomerClaims:2,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:4000,observationDays:0,offer:{kind:'discount',discountBps:1500,maximumMinor:5000}}),cid=await customer(),other=await customer(),source=await table([cid,other])
    let visit='';for(let i=0;i<2;i++){const c=await issue(b.code,cid);visit=(await activate(c.claimId,cid,source)).visitId!}
    const original=await consumePrice(source,(await prepare(source)).id),payment=await settleMovementOrder(original)
    const split=await app.inject(await moveRequest(source,await emptyMovementTable(),'participant_split',null,[other],1));expect(split.statusCode,split.body).toBe(200)
    const target=split.json().data.targetTableSessionId
    const transferred=await app.inject(await moveRequest(target,await emptyMovementTable(),'whole_table_transfer'));expect(transferred.statusCode,transferred.body).toBe(200)
    const cancelled=await consumePrice(target,(await prepare(target)).id)
    await admin.query("UPDATE mbox.orders SET status='cancelled' WHERE id=$1",[cancelled.id])
    const quotes=await Promise.all([prepare(source),prepare(target)]);expect(quotes.map(q=>q.discountMinor)).toEqual([1000,1000])
    const finalOrder=await consumePrice(target,quotes[1]!.id);await settleMovementOrder(finalOrder)
    await expect(consumePrice(source,quotes[0]!.id)).rejects.toThrow('重新确认')
    const refund=await financeRefund({payment,order:original},2000,'processing')
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=ANY($1::uuid[])",[[source,target]])
    const reconcile=()=>runner.run(scope,tx=>new ChannelFinanceRepository(tx).reconcile(visit))
    expect(await reconcile()).toMatchObject({frozen:true})
    await admin.query("UPDATE mbox.refunds SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1",[refund])
    const settled=await Promise.all([reconcile(),reconcile(),reconcile()]);for(const row of settled)expect(row).toMatchObject({basis:14000,target:1400,frozen:false})
    expect((await admin.query('SELECT sum(applied_discount_minor)::text AS used FROM mbox.channel_activations WHERE visit_id=$1',[visit])).rows[0].used).toBe('4000')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_price_releases WHERE order_id=$1',[cancelled.id])).rows[0].n).toBe(1)
    expect((await admin.query('SELECT sum(commission_delta_minor)::text AS net FROM mbox.channel_ledger WHERE visit_id=$1',[visit])).rows[0].net).toBe('1400')
  })
  it('serializes gift fulfillment against a monetary redemption under the same party cap',async()=>{
    const gift=await giftProduct(1),b=await batch({minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500}),cid=await customer(),session=await table([cid])
    const row=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule:{...rule,minimumMinor:0,perVisitUses:2,allowStacking:true,visitDiscountCapMinor:1500,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}},contract:{version:'test'}}))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[row.id])
    const c=await issue(b.code,cid),g=await issue(String(row.offerCode),cid),active=await activate(c.claimId,cid,session);await activate(g.claimId,cid,session)
    const quote=await prepare(session),commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const results=await Promise.allSettled([consumePrice(session,quote.id),runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:g.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await admin.query('SELECT sum(applied_discount_minor)::text AS used FROM mbox.channel_activations WHERE visit_id=$1',[active.visitId])).rows[0].used).toBe('1000')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n).toBe(1)
    const promise=(await admin.query('SELECT state,order_id FROM mbox.channel_gift_promises WHERE claim_id=$1',[g.claimId])).rows[0]
    if(results[0]!.status==='fulfilled')expect(promise).toBeUndefined()
    else expect(promise.order_id).toBeTruthy()
  })

  it.each(['paid-before','simulation','paid-after'] as const)('counts returning visits only from earlier real receipts: %s',async mode=>{
    const f=await financeFixture(0,mode==='simulation'?'simulation':'cash')
    const prior=(await admin.query(`SELECT o.table_session_id,p.customer_id FROM mbox.orders o JOIN mbox.table_session_customer_participations p ON p.table_session_id=o.table_session_id WHERE o.id=$1`,[f.order.id])).rows[0]
    await admin.query('UPDATE mbox.table_session_customer_participations SET left_at=clock_timestamp() WHERE table_session_id=$1 AND customer_id=$2',[prior.table_session_id,prior.customer_id])
    const current=await table([prior.customer_id]),b=await batch(),visit=randomUUID()
    await admin.query(`INSERT INTO mbox.channel_visits(id,tenant_id,store_id,source_batch_id,locked_use_limit) VALUES($3,$1,$2,$4,1)`,[...args,visit,b.id])
    await admin.query(`INSERT INTO mbox.channel_visit_tables(tenant_id,store_id,visit_id,table_session_id) VALUES($1,$2,$3,$4)`,[...args,visit,current])
    if(mode==='paid-after')await admin.query("UPDATE mbox.payments SET succeeded_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[f.payment])
    const started=performance.now(),rows=await runner.run(scope,tx=>readChannelReport(tx),{readOnly:true})
    expect(rows.find(r=>r.id===b.id)).toMatchObject({knownReturningVisits:mode==='paid-before'?1:0})
    expect(performance.now()-started).toBeLessThan(8000)
  },15_000)

  it('preserves empty, simulated, known and latest-corrected cost totals after report materialization',async()=>{
    const saved=(await admin.query('SELECT cost_amount_minor,inventory_control_mode FROM mbox.products WHERE id=$1',[product])).rows[0]
    let paid:Awaited<ReturnType<typeof financeFixture>>,simulation:Awaited<ReturnType<typeof financeFixture>>
    try{
      await admin.query("UPDATE mbox.products SET cost_amount_minor=1200,inventory_control_mode='not_managed' WHERE id=$1",[product])
      paid=await financeFixture();simulation=await financeFixture(0,'simulation')
    }finally{await admin.query('UPDATE mbox.products SET cost_amount_minor=$2,inventory_control_mode=$3 WHERE id=$1',[product,saved.cost_amount_minor,saved.inventory_control_mode])}
    const batchId=async(visitId:string)=>(await admin.query('SELECT source_batch_id FROM mbox.channel_visits WHERE id=$1',[visitId])).rows[0].source_batch_id as string
    const original=await batchId(paid!.visitId),simulated=await batchId(simulation!.visitId),empty=await batch(),latest=await batch()
    const report=()=>runner.run(scope,tx=>readChannelReport(tx),{readOnly:true})
    let rows=await report()
    expect(rows.find(r=>r.id===original)).toMatchObject({costMinor:'1200',missingCostItems:0})
    for(const id of [simulated,empty.id])expect(rows.find(r=>r.id===id)).toMatchObject({costMinor:'0',missingCostItems:0})
    for(const id of [empty.id,latest.id])await runner.run(scope,tx=>new ChannelOperationsRepository(tx).correctOrders([paid!.order.id],id,employee,'隔离测试核实原订单来源'))
    rows=await report()
    expect(rows.find(r=>r.id===latest.id)).toMatchObject({costMinor:'1200',missingCostItems:0})
    for(const id of [original,empty.id])expect(rows.find(r=>r.id===id)).toMatchObject({costMinor:'0',missingCostItems:0})
    expect((await admin.query('SELECT amount_minor::int AS n FROM mbox.payments WHERE id=$1',[paid!.payment])).rows[0].n).toBe(9000)
  },30_000)

  it.each(['initial','partial','full'] as const)('bounds report attribution work under %s statistics without weakening RLS',async statistics=>{
    if(statistics==='partial')await admin.query('ANALYZE mbox.orders')
    if(statistics==='full')await admin.query('ANALYZE mbox.channel_batches,mbox.channel_order_attributions,mbox.channel_order_corrections,mbox.order_items')
    const count=Number((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_order_attributions')).rows[0].n)
    const corrections=Number((await admin.query('SELECT count(*)::int AS n FROM mbox.channel_order_corrections')).rows[0].n)
    expect(count).toBeGreaterThan(50)
    await runner.run(scope,async tx=>{
      let sql='',values:readonly unknown[]=[]
      await readChannelReport({scope,query:async(text,args)=>{sql=text;values=args??[];return {rows:[],rowCount:0}}})
      await tx.query("SET LOCAL statement_timeout='8s'")
      const explained=await tx.query<{'QUERY PLAN':Array<{Plan:Record<string,unknown>;'Execution Time':number}>}>('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,values)
      const scans:Array<Record<string,unknown>>=[]
      const visit=(node:Record<string,unknown>)=>{
        if(node['Relation Name']==='channel_order_attributions')scans.push(node)
        for(const child of (node.Plans??[]) as Array<Record<string,unknown>>)visit(child)
      }
      visit(explained.rows[0]!['QUERY PLAN'][0]!.Plan)
      expect(scans.length).toBeGreaterThan(0)
      // The UNION may scan the source once plus one anti-lookup per correction.
      // It must not repeat those scans for every batch/item pair.
      const work=scans.reduce((sum,node)=>sum+Number(node['Actual Loops'])*Math.max(1,Number(node['Actual Rows'])),0)
      expect(scans.every(node=>Number(node['Actual Loops'])<=Math.max(1,corrections))).toBe(true)
      expect(work).toBeLessThanOrEqual(count*(corrections+1)+corrections)
      console.log(JSON.stringify({check:'channel-report-scan',statistics,attributions:count,scannedRows:work,ms:explained.rows[0]!['QUERY PLAN'][0]!['Execution Time']}))
    },{readOnly:true})
    expect(await runner.run({...scope,storeId:randomUUID()},tx=>readChannelReport(tx),{readOnly:true})).toEqual([])
    expect(await runner.run({...scope,tenantId:randomUUID()},tx=>readChannelReport(tx),{readOnly:true})).toEqual([])
  },30_000)

  it.each(['initial','partial','full'] as const)('fulfills only paid delivered channel orders under %s table statistics',async statistics=>{
    const paid=await financeFixture(),unmade=await financeFixture()
    await admin.query("UPDATE mbox.order_items SET status='submitted' WHERE order_id=$1",[unmade.order.id])
    if(statistics!=='initial')await admin.query('ANALYZE mbox.orders')
    if(statistics==='full')await admin.query('ANALYZE mbox.channel_visits,mbox.channel_price_applications,mbox.channel_activations,mbox.channel_order_attributions,mbox.channel_order_corrections')
    const started=performance.now(),result=await new ChannelReconciliationWorker(runner).runBatch(scope,'fulfillment-regression')
    expect(result.failed).toBe(0)
    const status=async(visit:string)=>(await admin.query('SELECT status FROM mbox.channel_activations WHERE visit_id=$1',[visit])).rows[0].status
    expect(await status(paid.visitId)).toBe('fulfilled');expect(await status(unmade.visitId)).toBe('active')
    const elapsed=performance.now()-started
    console.info(JSON.stringify({check:'channel-reconciliation-growth',statistics,visits:result.claimed,ms:Math.round(elapsed)}))
    expect(elapsed).toBeLessThan(8000)
  },15_000)

  it('closes corrected historical visits only after their source tables close',async()=>{
    const f=await financeFixture(),b=await batch(),empty=randomUUID()
    await admin.query('UPDATE mbox.channel_visits SET closed_at=NULL WHERE id=$1',[f.visitId])
    const correction=await runner.run(scope,tx=>new ChannelOperationsRepository(tx).correctOrders([f.order.publicId],b.id,employee,'历史来源核对'))
    await admin.query('INSERT INTO mbox.channel_visits(id,tenant_id,store_id) VALUES($3,$1,$2)',[...args,empty])
    const closed=async(id:string)=>(await admin.query('SELECT closed_at FROM mbox.channel_visits WHERE id=$1',[id])).rows[0].closed_at
    expect((await new ChannelReconciliationWorker(runner).runBatch(scope,'corrected-open')).failed).toBe(0)
    expect(await closed(correction.visitId)).toBeNull();expect(await closed(empty)).toBeNull()
    await admin.query("UPDATE mbox.table_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=(SELECT table_session_id FROM mbox.orders WHERE id=$1)",[f.order.id])
    expect((await new ChannelReconciliationWorker(runner).runBatch(scope,'corrected-closed')).failed).toBe(0)
    expect(await closed(correction.visitId)).not.toBeNull();expect(await closed(empty)).toBeNull()
  },30_000)

})
