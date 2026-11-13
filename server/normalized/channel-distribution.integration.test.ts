import { inviteChannelWeb, hashChannelWebToken } from './channel-web-auth.js'
import { channelAnonymousVisit } from './channel-partner-repository.js'
import { PostgresOrderCancellationRepository } from './order-cancellation-repository.js'
import { tableManagementApiPlugin } from './table-management-api.js'
import { TableManagementCommandService } from './table-management-repository.js'
import { PaymentCommandService } from './payment-command-service.js'
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js'
import { VerifiedProviderObservationService, NormalizedProviderObservationAuthority } from './provider-verification-observation.js'
import { PaymentRepository } from './payment-repository.js'
import { NormalizedAuthenticationRequiredError } from './normalized-request-context.js'
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
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { WechatMiniProgramCodeError } from './wechat-mini-program-code.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { ChannelDistributionRepository } from './channel-distribution-repository.js'
import { channelDistributionApiPlugin } from './channel-distribution-api.js'
import { ChannelPartnerRepository } from './channel-partner-repository.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'
import { grantFixtureStaffPermissions } from './staff-permission.test-helper.js'
import type { ChannelRule } from '../../src/shared/channel-distribution.js'

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
  async function batch(overrides: Partial<ChannelRule> = {}, limits = { claim: 100, capacity: 100, cost: 1000000 }) {
    const campaign = randomUUID()
    await admin.query(`INSERT INTO mbox.channel_campaigns(id,tenant_id,store_id,title,claim_limit,capacity_limit,cost_limit_minor,accepting_claims,staff_entry_enabled,self_entry_enabled)
      VALUES($3,$1,$2,'test campaign',$4,$5,$6,true,true,true)`, [...args, campaign, limits.claim, limits.capacity, limits.cost])
    const value = await runner.run(scope, tx => new ChannelDistributionRepository(tx).createBatch({ campaignId: campaign, promoterId: promoter, rule: { ...rule, ...overrides }, contract: { version: 'test1' } }))
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
  const issue = (code: string, cid: string, entry: 'staff' | 'self' = 'self', reuse = false) => runner.run(scope, tx => new ChannelDistributionRepository(tx).issue(code, cid, entry, reuse))
  const activate = (claim: string, cid: string, session: string) => runner.run(scope, tx => new ChannelDistributionRepository(tx).activate(claim, cid, session, `employee:${employee}`))

  async function emptyMovementTable(){
    const id=randomUUID()
    await admin.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($3::uuid,$1,$2,$4,left($3::text,30),'转桌目标',8)`,[...args,id,area]);return id
  }
  async function settleMovementOrder(o:{id:string;totalAmountMinor:number}){
    await admin.query("UPDATE mbox.order_items SET status='delivered' WHERE order_id=$1",[o.id])
    const pay=randomUUID()
    await admin.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,provider_transaction_id,method,amount_minor,status,succeeded_at) VALUES($3::uuid,$1,$2,$4,$3::text,'cash',$3::text,'cash',$5,'succeeded',clock_timestamp())`,[...args,pay,o.id,o.totalAmountMinor])
    await admin.query("UPDATE mbox.kds_tasks SET status='ready',ready_at=clock_timestamp() WHERE order_item_id IN(SELECT id FROM mbox.order_items WHERE order_id=$1)",[o.id])
    await admin.query("UPDATE mbox.orders SET status='completed',payment_status='paid',completed_at=clock_timestamp() WHERE id=$1",[o.id]);return pay
  }
  async function moveRequest(source:string,targetTable:string,kind:'whole_table_transfer'|'participant_split'|'participant_merge',target:string|null=null,customers:string[]=[],count=1){
    const row=(await admin.query('SELECT table_id,location_version FROM mbox.table_sessions WHERE id=$1',[source])).rows[0]
    const ids=(await admin.query('SELECT public_id FROM mbox.table_session_customer_participations WHERE table_session_id=$1 AND customer_id=ANY($2::uuid[]) AND left_at IS NULL',[source,customers])).rows.map(r=>r.public_id)
    return{method:'POST' as const,url:`/table-management/sessions/${source}/${kind==='whole_table_transfer'?'transfer':'participant-movements'}`,headers:{'idempotency-key':randomUUID()},payload:kind==='whole_table_transfer'?{targetTableId:targetTable,expectedSourceTableId:row.table_id,expectedLocationVersion:Number(row.location_version)}:{movementKind:kind,targetTableId:targetTable,targetTableSessionId:target,movedGuestCount:count,participantPublicIds:ids,reason:'渠道转桌联动隔离验证'}}
  }
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
  it('reserves the last actual gift once under a 12-customer burst and rolls back losing claims',async()=>{
    const gift=await giftProduct(1),b=await batch({totalClaims:30,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}})
    const people=await Promise.all(Array.from({length:12},()=>customer()))
    const results=await Promise.allSettled(people.map((cid,i)=>issue(i%2?b.token:b.code,cid,i%2?'self':'staff')))
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(11)
    expect((await admin.query('SELECT count(*)::integer AS n FROM mbox.channel_claims WHERE batch_id=$1',[b.id])).rows[0].n).toBe(1)
    const stock=(await admin.query('SELECT on_hand_quantity,reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[gift.iid])).rows[0]
    expect(Number(stock.on_hand_quantity)).toBe(1);expect(Number(stock.reserved_quantity)).toBe(1)
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
    const bodies=[{code:b.code,customerId:randomUUID()},{code:b.code,promoterId:promoter},{code:b.code,amountMinor:-1},{code:[]},{code:"'; DROP TABLE mbox.channel_claims; --"},{code:'x'.repeat(3000)}]
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
      expect((await admin.query('SELECT order_id,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]).toEqual({order_id:null,state:'reserved'})
      expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[g.pid])).rows[0].sale_remaining_quantity).toBe(0)
      expect(Number((await admin.query('SELECT reserved_quantity FROM mbox.inventory_balances WHERE inventory_item_id=$1',[g.iid])).rows[0].reserved_quantity)).toBe(1)
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
  it('blocks replacing a gift without customer consent and preserves the original reservation',async()=>{
    const old=await giftProduct(1),replacement=await giftProduct(1),b=await batch({offer:{kind:'gift',productId:old.pid,quantity:1,costMinor:100}}),coupon=await issue(b.code,await customer())
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
  it('prevents campaign overspend even across separate batches', async () => {
    const b = await batch({}, { claim: 100, capacity: 100, cost: 1000 })
    const c = await runner.run(scope, tx => new ChannelDistributionRepository(tx).createBatch({ campaignId: b.campaign, promoterId: promoter, rule, contract: { version: 'test1' } }))
    await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1', [c.id])
    const a = await customer(), d = await customer()
    const results = await Promise.allSettled([issue(b.code, a), issue(String(c.offerCode), d)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['CAPACITY'])
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
  const consumePrice = (session:string,quoteId:string,quantity=1) => runner.run(scope,async tx=>{
    await new ChannelDistributionRepository(tx).lockIdentity()
    const input=priceInput(session,quantity),policy=new PricingAuthorizationPolicy(new PostgresPricingAuthority())
    const authorization=await policy.authorize(tx,{scope,actor:{type:'employee',employeeId:employee},tableSessionId:session,channel:'staff_assisted',lines:input.lines},{sourceType:'channel_quote',sourceId:quoteId})
    const order=await new OrderRepository(tx).createSubmitted({tableSessionId:session,publicId:randomUUID(),channel:'staff_assisted',lines:input.lines,createdByEmployeeId:employee},authorization)
    await policy.consume(tx,authorization!,order.id)
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
  it('reserves actual gift stock at issuance, protects it from normal sales and creates one zero-value KDS order',async()=>{
    const g=await giftProduct(),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:999}}),cid=await customer(),session=await table([cid])
    const coupon=await issue(b.code,cid)
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
    await expect(issue(b.code,await customer())).rejects.toMatchObject({code:'CAPACITY'})
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
  it('rolls back a premature gift redemption and releases only unused expired stock, without restoring N/K',async()=>{
    const g=await giftProduct(1),b=await batch({offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
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


  it('converts a gift hold into actual KDS-start inventory consumption exactly once',async()=>{
    const g=await giftProduct(1),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),coupon=await issue(b.code,cid)
    await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const outcome=await runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'}))
    const item=(await admin.query('SELECT id FROM mbox.order_items WHERE order_id=$1',[outcome.result.orderId])).rows[0].id
    const consume=()=>runner.run(scope,tx=>new InventoryRepository(tx).consumeOrderItemReservations(item,{createdByEmployeeId:employee,reason:'KDS开始制作'}))
    expect((await consume()).length).toBe(1);expect((await consume()).length).toBe(0)
    const stock=(await admin.query('SELECT on_hand_quantity::text AS hand,reserved_quantity::text AS held FROM mbox.inventory_balances WHERE inventory_item_id=$1',[g.iid])).rows[0]
    expect(Number(stock.hand)).toBe(0);expect(Number(stock.held)).toBe(0)
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(coupon.claimId,'revoke',employee,'制作后误撤'))).rejects.toMatchObject({code:'NOT_REVERSIBLE'})
  })
  it('replaces an unused gift atomically with consent, restores old stock and preserves one N/K claim',async()=>{
    const a=await giftProduct(1),b=await giftProduct(1),batchA=await batch({minimumMinor:0,offer:{kind:'gift',productId:a.pid,quantity:1,costMinor:100}}),cid=await customer(),session=await table([cid]),claim=await issue(batchA.code,cid)
    await activate(claim.claimId,cid,session)
    await runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(claim.claimId,'replace-gift',employee,'顾客要求换口味',{productId:b.pid,quantity:1,consent:'顾客现场确认同意'}))
    expect((await admin.query('SELECT product_id,generation,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[claim.claimId])).rows[0]).toEqual({product_id:b.pid,generation:2,state:'reserved'})
    expect((await admin.query('SELECT sale_remaining_quantity FROM mbox.products WHERE id=$1',[a.pid])).rows[0].sale_remaining_quantity).toBe(1)
    const wallet=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).wallet(cid))
    expect(wallet[0]!.offer).toMatchObject({productId:b.pid})
    await expect(issue(batchA.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
    const soldOut=await giftProduct(0)
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(claim.claimId,'replace-gift',employee,'缺货替换',{productId:soldOut.pid,quantity:1,consent:'顾客同意'}))).rejects.toMatchObject({code:'CAPACITY'})
    expect((await admin.query('SELECT product_id,generation,state FROM mbox.channel_gift_promises WHERE claim_id=$1',[claim.claimId])).rows[0]).toEqual({product_id:b.pid,generation:2,state:'reserved'})
  })
  it('expires unused gift holds through the worker but protects active promises past the use deadline',async()=>{
    const g=await giftProduct(2),b=await batch({minimumMinor:0,totalClaims:2,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),one=await customer(),two=await customer(),c1=await issue(b.code,one),c2=await issue(b.code,two),session=await table([two])
    await activate(c2.claimId,two,session)
    await admin.query(`UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])`,[[c1.claimId,c2.claimId]])
    const result=await new ChannelReconciliationWorker(runner).runBatch(scope,'test-channel-worker')
    expect(result.expired).toBeGreaterThanOrEqual(1);expect(result.failed).toBe(0)
    expect((await admin.query('SELECT status FROM mbox.channel_claims WHERE id=$1',[c1.claimId])).rows[0].status).toBe('expired')
    expect((await admin.query('SELECT state FROM mbox.channel_gift_promises WHERE claim_id=$1',[c2.claimId])).rows[0].state).toBe('reserved')
    await expect(issue(b.code,one)).rejects.toMatchObject({code:'CLAIM_LIMIT'})
  })
  it('rechecks campaign capacity on an expired gift extension and voids an unused issuance only once',async()=>{
    const g=await giftProduct(1),b=await batch({totalClaims:1,minimumMinor:0,offer:{kind:'gift',productId:g.pid,quantity:1,costMinor:100}}),cid=await customer(),q=await issue(b.code,cid)
    await admin.query(`UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1`,[q.claimId])
    await new ChannelReconciliationWorker(runner).runBatch(scope,'extension-test')
    const until=new Date(Date.now()+3*3600000).toISOString()
    await admin.query('UPDATE mbox.channel_campaigns SET cost_limit_minor=99 WHERE id=$1',[b.campaign])
    await expect(runner.run(scope,tx=>new ChannelOperationsRepository(tx).claim(q.claimId,'extend',employee,'门店排队延期',{until}))).rejects.toMatchObject({code:'CAPACITY'})
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
    await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CAPACITY'})
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
  it('serializes gift fulfillment against cancellation with exactly one successful outcome',async()=>{
    const gift=await giftProduct(1),cid=await customer(),session=await table([cid]),b=await batch({minimumMinor:0,offer:{kind:'gift',productId:gift.pid,quantity:1,costMinor:100}}),coupon=await issue(b.code,cid),active=await activate(coupon.claimId,cid,session)
    const commerce=new CommerceCommandService(new NormalizedCommandExecutor(runner),new PostgresPricingAuthority())
    const results=await Promise.allSettled([runner.run(scope,tx=>fulfillChannelGift(tx,commerce,{claimId:coupon.claimId,tableSessionId:session,employeeId:employee,businessDate:'2026-11-12'})),runner.run(scope,tx=>new ChannelDistributionRepository(tx).cancelActivation(active.activationId!,session,employee,'同时误撤销'))])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const promise=(await admin.query('SELECT order_id FROM mbox.channel_gift_promises WHERE claim_id=$1',[coupon.claimId])).rows[0]
    const count=(await admin.query('SELECT count(*)::int AS n FROM mbox.orders WHERE table_session_id=$1',[session])).rows[0].n
    expect(count).toBe(promise.order_id?1:0)
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
  it('honors campaign capacity and exact budget across concurrent different batches',async()=>{
    for(const limit of [{claim:100,capacity:1,cost:1000000},{claim:100,capacity:100,cost:1999},{claim:1,capacity:100,cost:1000000}]){
      const b=await batch({},limit),other=await runner.run(scope,tx=>new ChannelDistributionRepository(tx).createBatch({campaignId:b.campaign,promoterId:promoter,rule,contract:{version:'test'}}))
      await admin.query('UPDATE mbox.channel_batches SET accepting_claims=true WHERE id=$1',[other.id])
      const a=await customer(),c=await customer(),outcomes=await Promise.allSettled([issue(b.code,a),issue(String(other.offerCode),c,'staff')])
      expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
      expect((await admin.query('SELECT count(*)::int AS n,sum(cost_commitment_minor)::text AS cost FROM mbox.channel_claims WHERE batch_id=ANY($1::uuid[])',[[b.id,other.id]])).rows[0]).toEqual({n:1,cost:'1000'})
    }
  })
  it('releases elapsed unactivated claims from store budget before the expiry worker, preserving N/K',async()=>{
    const b=await batch({totalClaims:3}),cid=await customer(),old=await issue(b.code,cid)
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1",[old.claimId])
    const baseline=(await admin.query(`SELECT count(*) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp()))::int AS held,COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())),0)::text AS cost FROM mbox.channel_claims q JOIN mbox.channel_batches b ON b.id=q.batch_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND NOT q.voided`,args)).rows[0]
    try{
      await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,baseline.held+1,Number(baseline.cost)+1000,employee,'精确剩余一张额度'))
      await expect(issue(b.code,await customer())).resolves.toMatchObject({status:'available'})
      await expect(issue(b.code,await customer())).rejects.toMatchObject({code:'CAPACITY'})
      await expect(issue(b.code,cid)).rejects.toMatchObject({code:'CUSTOMER_LIMIT'})
    }finally{await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复隔离测试额度'))}
  })
  it('shows exhausted campaign or store monetary capacity on the customer preview without claiming',async()=>{
    const b=await batch({}, {claim:100,capacity:100,cost:999}),cid=await customer();selfCustomer=cid
    const read=()=>app.inject({method:'GET',url:`/public/mini/channel/offer?code=${b.code}`})
    expect((await read()).json().data.unavailable).toBe('本批次可承诺份数不足')
    await admin.query('UPDATE mbox.channel_campaigns SET cost_limit_minor=1000 WHERE id=$1',[b.campaign])
    try{
      await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,0,employee,'全店成本暂为零'))
      expect((await read()).json().data.unavailable).toBe('本批次可承诺份数不足')
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

  it('serializes cross-campaign issuance at each independent store cap without exceeding a cent or slot',async()=>{
    for(const kind of ['claims','capacity','cost']){
      const a=await batch(),b=await batch(),ca=await customer(),cb=await customer()
      const base=(await admin.query(`SELECT count(*)::int AS issued,count(*) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp()))::int AS held,COALESCE(sum(q.cost_commitment_minor) FILTER(WHERE q.status IN('active','fulfilled') OR(q.status='available' AND COALESCE(q.use_until_override,(b.rule_snapshot->>'useUntil')::timestamptz)>clock_timestamp())),0)::text AS cost FROM mbox.channel_claims q JOIN mbox.channel_batches b ON b.id=q.batch_id WHERE q.tenant_id=$1 AND q.store_id=$2 AND NOT q.voided`,args)).rows[0]
      try{
        await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(kind==='claims'?base.issued+1:100000,kind==='capacity'?base.held+1:100000,kind==='cost'?Number(base.cost)+1999:1e9,employee,'全店边界并发'))
        const outcomes=await Promise.allSettled([issue(a.code,ca),issue(b.token,cb,'staff')])
        expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1)
        expect(outcomes.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual(['CAPACITY'])
      }finally{await runner.run(scope,tx=>new ChannelOperationsRepository(tx).limits(100000,100000,1e9,employee,'恢复隔离限额'))}
    }
  })
  it('uses the same elapsed-promise capacity for extensions before the expiry worker runs',async()=>{
    const b=await batch({}, {claim:3,capacity:1,cost:1000}),old=await issue(b.code,await customer())
    await admin.query("UPDATE mbox.channel_claims SET use_until_override=clock_timestamp()-interval '1 minute' WHERE id=$1",[old.claimId])
    const current=await issue(b.code,await customer()),until=new Date(Date.now()+3*3600000).toISOString()
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
    const nextContactAt=new Date(Date.now()+86400000).toISOString()
    for(const kind of ['sent','received','feedback','contact']){
      const request={method:'POST' as const,url:'/staff/channel/followup',headers:{'idempotency-key':`channel-${randomUUID()}`},payload:{promoterId:pid,batchId:null,kind,note:kind==='contact'?'中'.repeat(2000):'逐项交流记录',nextContactAt}}
      const result=await app.inject(request);expect(result.statusCode,result.body).toBe(200)
      const replay=await app.inject({...request,headers:{...request.headers,'x-channel-recovery':'1'}})
      expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true);expect(replay.json().data).toEqual(result.json().data)
    }
    const rows=(await admin.query('SELECT kind,note,next_contact_at FROM mbox.channel_followups WHERE promoter_id=$1',[pid])).rows
    expect(rows).toHaveLength(4);expect(rows.every(r=>r.note===(r.kind==='contact'?'中'.repeat(2000):'逐项交流记录')&&new Date(r.next_contact_at).toISOString()===nextContactAt)).toBe(true)
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
    expect((await admin.query('SELECT state,order_id FROM mbox.channel_gift_promises WHERE claim_id=$1',[g.claimId])).rows[0]).toMatchObject({state:'reserved',order_id:null})
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
    if(results[0]!.status==='fulfilled')expect(promise).toMatchObject({state:'reserved',order_id:null})
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
