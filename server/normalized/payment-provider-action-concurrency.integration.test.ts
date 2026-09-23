import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'
import { OnlinePaymentService } from './online-payment-service.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { CommerceCommandService } from './commerce-command-service.js'
import { PaymentCommandService } from './payment-command-service.js'
import { NormalizedPaymentCapabilityAuthorization } from './payment-security-policy.js'
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const secret = 'isolated-provider-concurrency-fixture-at-least-32-bytes'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

;(adminUrl && runtimeUrl ? describe : describe.skip)('SYS337 guest provider preparation, restricted LOGIN', () => {
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }, area = randomUUID(), product = randomUUID()
  let date: string
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 5, options: '-c statement_timeout=3000' })
    runtime = new Pool({ connectionString: runtimeUrl, max: 8 })
    runner = new ScopedPostgresTransactionRunner(runtime)
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Provider concurrency')", [scope.tenantId, scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,$3,'Provider concurrency','Asia/Shanghai','06:00')", [scope.storeId, scope.tenantId, scope.storeId])
    date = await runner.run(scope, async tx => (await tx.query<{ date: string }>('SELECT mbox.current_operating_business_date($1,$2)::text date', [scope.tenantId,scope.storeId])).rows[0]!.date)
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [area,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.products(id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode) VALUES($1,$2,$3,'FIXTURE','Fixture','food','none','not_managed')", [product,scope.tenantId,scope.storeId])
    await admin.query("INSERT INTO mbox.product_prices(tenant_id,store_id,product_id,price_type,amount_minor,currency,valid_from) VALUES($1,$2,$3,'standard',4000,'CNY',clock_timestamp()-interval '1 minute')", [scope.tenantId,scope.storeId,product])
  }, 30_000)
  afterAll(async () => { await runtime?.end(); await admin?.end() })

  async function fixture(withPayment = true) {
    const table = randomUUID(), session = randomUUID(), customer = randomUUID(), order = randomUUID(), payment = randomUUID()
    await admin.query('INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity) VALUES($1,$2,$3,$4,$5,$5,4)', [table,scope.tenantId,scope.storeId,area,table.slice(0,8)])
    await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1::uuid,$2,$3,$1::text)', [customer,scope.tenantId,scope.storeId])
    await admin.query('INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count) VALUES($1::uuid,$2,$3,$4,$1::text,$5,2)', [session,scope.tenantId,scope.storeId,table,date])
    await admin.query("INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'primary')", [scope.tenantId,scope.storeId,session,customer])
    const actorRef = await seedActiveGuestTableAuthority(admin,{...scope,tableSessionId:session,customerId:customer})
    if (withPayment) {
      await admin.query("INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor,settlement_mode,fulfillment_state) VALUES($1::uuid,$2,$3,$4,$1::text,'guest_qr','submitted',clock_timestamp(),4000,4000,'immediate_payment','awaiting_payment')", [order,scope.tenantId,scope.storeId,session])
      await admin.query("INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,currency,status) VALUES($1::uuid,$2,$3,$4,$1::text,'simulation','native_qr',4000,'CNY','pending')", [payment,scope.tenantId,scope.storeId,order])
    }
    const principal = { type:'guest' as const,tableSessionId:session,customerId:customer,guestSessionId:actorRef.slice('guest-session:'.length) }
    return { table,session,customer,order,payment,actorRef,principal }
  }
  const createInput = (f: Awaited<ReturnType<typeof fixture>>) => ({ scope,paymentId:f.payment,principal:f.principal,clientIp:'127.0.0.1',operatorId:f.actorRef,idempotencyKey:`provider-${f.payment}` })
  async function waitBlocked(pid: number) {
    for (let n=0;n<200;n++) {
      if (Number((await admin.query('SELECT cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n)>0) return
      await new Promise(r=>setTimeout(r,10))
    }
    throw new Error('Expected an actual PostgreSQL lock wait')
  }
  function hookRunner(hook: (tx:ScopedTransaction, sql:string) => Promise<void>) {
    return { run: <T>(s:typeof scope, operation:(tx:ScopedTransaction)=>Promise<T>) => runner.run(s,tx=>operation({scope:tx.scope,query:async(sql,values)=>{await hook(tx,sql);return tx.query(sql,values)}})) }
  }
  it('serializes the actual two-transaction participation/payment cycle and returns one original action', async () => {
    const f = await fixture(), prepared = deferred(), complete = deferred(), entered = deferred()
    let secondPid = 0
    const firstService = new OnlinePaymentService(hookRunner(async(_tx,sql)=>{
      if(sql.includes('WITH action_updated AS')) { prepared.resolve(); await complete.promise }
    }),secret,null)
    const secondService = new OnlinePaymentService(hookRunner(async(tx,sql)=>{
      if(sql.includes('mbox.lock_active_table_guest_session_position')) {
        secondPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid; entered.resolve()
      }
    }),secret,null)
    const first = firstService.create(createInput(f))
    await prepared.promise
    const second = secondService.create(createInput(f))
    const results = Promise.allSettled([first,second])
    try { await entered.promise; await waitBlocked(secondPid) } finally { complete.resolve() }
    const outcome = await results
    expect(outcome.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code)).toEqual([])
    expect(outcome.every(r=>r.status==='fulfilled'&&r.value.paymentId===f.payment)).toBe(true)
    const replay = await new OnlinePaymentService(runner,secret,null).create(createInput(f))
    expect(replay.payload).toEqual({presentation:'simulation'})
    expect((await admin.query('SELECT state, count(*) OVER()::int n FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows).toEqual([{state:'ready',n:1}])
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payments WHERE order_id=$1',[f.order])).rows[0].n).toBe(1)
  }, 15_000)

  it('rereads terminal payment state after waiting for current guest authority', async () => {
    const f = await fixture(), held = deferred(), release = deferred(), entered = deferred()
    let pid = 0
    const blocker = runner.run(scope,async tx=>{
      await tx.query('SELECT mbox.lock_active_table_guest_session_position($1,$2,$3)',[f.session,f.customer,f.principal.guestSessionId])
      held.resolve(); await release.promise
    })
    await held.promise
    const service = new OnlinePaymentService(hookRunner(async(tx,sql)=>{
      if(sql.includes('mbox.lock_active_table_guest_session_position')) {pid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;entered.resolve()}
    }),secret,null)
    const result = service.create(createInput(f)).then(value=>({value,error:null}),error=>({value:null,error}))
    try {
      await entered.promise; await waitBlocked(pid)
      // A different transaction can finish the payment while guest authorization waits.
      await admin.query("UPDATE mbox.payments SET status='closed' WHERE id=$1",[f.payment])
    } finally { release.resolve() }
    await blocker
    // Keep the schema224 API contract; terminal-action recovery belongs to the deferred newer flow.
    expect((await result).error).toMatchObject({message:'这笔订单已经不处于待付款状态'})
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows[0].n).toBe(0)
  }, 15_000)

  it.each(['scope','other_table','revoked'] as const)('rejects %s before creating a provider action',async kind=>{
    const f=await fixture(), input=createInput(f)
    if(kind==='scope')input.scope={...scope,storeId:randomUUID()}
    if(kind==='other_table')input.principal={...f.principal,tableSessionId:(await fixture(false)).session}
    if(kind==='revoked')await admin.query("UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='fixture' WHERE id=$1",[f.principal.guestSessionId])
    await expect(new OnlinePaymentService(runner,secret,null).create(input)).rejects.toThrow()
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows[0].n).toBe(0)
  })

  it('does not return the original action when the guest is revoked after the unlocked lookup',async()=>{
    const f=await fixture(), located=deferred(), proceed=deferred()
    await new OnlinePaymentService(runner,secret,null).create(createInput(f))
    const service=new OnlinePaymentService(hookRunner(async(_tx,sql)=>{
      if(sql.includes('mbox.lock_active_table_guest_session_position')){located.resolve();await proceed.promise}
    }),secret,null)
    const result=service.create(createInput(f)).then(()=>null,error=>error)
    try {
      await located.promise
      await admin.query("UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='superseded_by_rescan' WHERE id=$1",[f.principal.guestSessionId])
    } finally {proceed.resolve()}
    expect(await result).toMatchObject({name:'GuestOrderPaymentAccessError',reason:'guest_not_at_current_table'})
    expect((await admin.query('SELECT count(*)::int n FROM mbox.payment_provider_actions WHERE payment_id=$1',[f.payment])).rows[0].n).toBe(1)
  })

  it('commits one order/payment/action for concurrent original-key shared-cart HTTP checkout',async()=>{
    const f=await fixture(false),app=Fastify({logger:{level:'error'}}),online=new OnlinePaymentService(runner,secret,null)
    const commands=new NormalizedCommandExecutor(runner)
    await app.register(guestCommerceServiceApiPlugin,{prefix:'/api',transactions:runner,commandExecutor:commands,commerce:new CommerceCommandService(commands),payments:new PaymentCommandService(commands,new NormalizedPaymentCapabilityAuthorization()),onlinePayments:online,
      resolveGuestContext:async()=>({scope,sessionKind:'table',customerId:f.customer,tableSessionId:f.session,reservationId:null,tableCode:'FIXTURE',tableDisplayName:'Fixture',businessDate:date,expiresAt:new Date(Date.now()+3_600_000).toISOString(),capabilities:['guest.session.read','guest.menu.read','guest.order.create'],actorRef:f.actorRef}),
      resolvePublicContext:async()=>({scope}),resolveDeviceFingerprint:()=>`device-${f.customer}`,paymentMode:'simulation',paymentActionSecret:secret})
    try {
      const empty=await app.inject({method:'GET',url:'/api/guest/shared-cart'});expect(empty.statusCode,empty.body).toBe(200)
      const cart=empty.json().data
      const added=await app.inject({method:'POST',url:'/api/guest/shared-cart/lines',headers:{'idempotency-key':randomUUID()},payload:{productId:product,delta:1,expectedGeneration:cart.generation,expectedVersion:cart.version}})
      expect(added.statusCode,added.body).toBe(200)
      const filled=added.json().data,key=randomUUID(),request={method:'POST' as const,url:'/api/guest/shared-cart/checkout',headers:{'idempotency-key':key},payload:{expectedGeneration:filled.generation,expectedVersion:filled.version}}
      const results=await Promise.all([app.inject(request),app.inject(request)])
      expect(results.map(r=>r.statusCode).sort(),results.map(r=>r.body).join('\n')).toEqual([200,201])
      const replay=await app.inject(request);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().meta.replayed).toBe(true)
      const facts=(await admin.query(`SELECT (SELECT count(*)::int FROM mbox.orders WHERE table_session_id=$1) orders,
        (SELECT count(*)::int FROM mbox.payments p JOIN mbox.orders o ON o.id=p.order_id WHERE o.table_session_id=$1) payments,
        (SELECT count(*)::int FROM mbox.payment_provider_actions a JOIN mbox.payments p ON p.id=a.payment_id JOIN mbox.orders o ON o.id=p.order_id WHERE o.table_session_id=$1) actions`,[f.session])).rows[0]
      expect(facts).toEqual({orders:1,payments:1,actions:1})
    } finally { await app.close() }
  },15_000)
})
