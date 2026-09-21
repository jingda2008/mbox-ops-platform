import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { GuestApiClient, GuestApiError } from '../../src/normalized-ui/guest/guest-api.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

// Independent recheck at f8306c7718e011f451af5f0eb29f0e8e16dbd532.
// These assertions deliberately reproduce defects: green means STILL BROKEN, not fixed.
// Original 3 tests reproduce SIM120-04, SIM120-05, and SIM120-06/SIM120-07 respectively.
integration('SIM120 recheck: defect-reproduction assertions, green is NOT fixed', () => {
  let pool: Pool
  let app: FastifyInstance
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID(), storeId = randomUUID(), tableId = randomUUID()
  const areaId = randomUUID(), customerId = randomUUID(), tableSessionId = randomUUID()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    const wrapped: PostgresPool = {
      connect: async () => {
        const client = await pool.connect()
        return { query: (sql, values) => client.query(sql, values ? [...values] : undefined), release: error => client.release(error) }
      }, end: () => pool.end(),
    }
    transactions = new ScopedPostgresTransactionRunner(wrapped)
    await pool.query(`INSERT INTO mbox.tenants (id,code,name) VALUES ($1,$2,'120 guest service audit')`, [tenantId, `a120-${tenantId}`])
    await pool.query(`INSERT INTO mbox.stores (id,tenant_id,code,name,timezone,business_day_cutoff) VALUES ($1,$2,$3,'120 guest service audit','Asia/Shanghai','06:00')`, [storeId,tenantId,`a120-${storeId}`])
    await pool.query(`INSERT INTO mbox.areas (id,tenant_id,store_id,code,name,area_type) VALUES ($1,$2,$3,'AUDIT','Audit','indoor')`, [areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.tables (id,tenant_id,store_id,area_id,code,display_name,capacity,qr_version) VALUES ($1,$2,$3,$4,'A01','Audit table',6,1)`, [tableId,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.customers (id,tenant_id,store_id,public_id) VALUES ($1,$2,$3,$4)`, [customerId,tenantId,storeId,`a120-${customerId}`])
    await pool.query(`INSERT INTO mbox.table_sessions (id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES ($1,$2,$3,$4,$5,'2026-09-21',6,'open')`, [tableSessionId,tenantId,storeId,tableId,`a120-${tableSessionId}`])
    await pool.query(`INSERT INTO mbox.table_session_customers (tenant_id,store_id,table_session_id,customer_id,relationship) VALUES ($1,$2,$3,$4,'primary')`, [tenantId,storeId,tableSessionId,customerId])
    const actorRef = await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId,customerId})
    app = Fastify()
    await app.register(guestCommerceServiceApiPlugin, {
      prefix: '/api', transactions, commandExecutor: new NormalizedCommandExecutor(transactions),
      commerce: {} as never, payments: {} as never, onlinePayments: {} as never,
      resolveGuestContext: async () => ({ scope:{tenantId,storeId}, sessionKind:'table', customerId, tableSessionId,
        reservationId:null, tableCode:'A01',tableDisplayName:'Audit table',businessDate:'2026-09-21',
        expiresAt:'2026-09-22T00:00:00.000Z',capabilities:['guest.session.read','guest.service.create'],actorRef }),
      resolvePublicContext: async () => ({scope:{tenantId,storeId}}),
      resolveDeviceFingerprint: () => '120-guest-service-device-a',
      paymentMode:'simulation',paymentActionSecret:'120-guest-audit-not-a-real-payment-secret',
      deviceServiceLimitPerMinute:5,tableServiceLimitPerMinute:20,
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => { await app?.close(); await pool?.end() })

  it('a rate-limited new complaint stays rejected under its durable key after the limit window rolls over', async () => {
    // Five distinct ordinary requests consume the default per-device minute allowance.
    for (let index=0; index<5; index++) {
      const response = await app.inject({method:'POST',url:'/api/guest/service-requests',
        headers:{'idempotency-key':`a120-ordinary-${index}`},payload:{requestType:'custom',detail:`请加${index+1}杯水`}})
      expect(response.statusCode).toBe(201)
    }
    const storage = new Map<string,unknown>()
    const calls: Array<{key:string;status:number;body:any}> = []
    const runtime = {
      getStorageSync: (key:string) => storage.get(key),
      setStorageSync: (key:string,value:unknown) => storage.set(key,value),
      removeStorageSync: (key:string) => storage.delete(key),
      request: (input:any) => {
        void app.inject({method:input.method,url:new URL(input.url).pathname,headers:input.header,payload:input.data}).then(response => {
          calls.push({key:input.header['idempotency-key'],status:response.statusCode,body:response.json()})
          input.success({statusCode:response.statusCode,data:response.json(),header:response.headers})
        }).catch(input.fail)
      },
    }
    const createApi = () => {
      const modules = new Map<string,any>()
      const load = (name:string):any => {
        if(name==='./session') return {getTableSession:()=>({tableCode:'A01',tableToken:'audit-fixed-token',cartScope:tableSessionId}),clearTableConnection(){}}
        if(name==='../config/index') return {getRuntimeConfig:()=>({apiBaseUrl:'https://audit.invalid',storeId,requestTimeoutMs:10000})}
        if(name==='./id') return {randomId:(prefix:string)=>`${prefix}-${randomUUID()}`}
        if(name==='./auth'||name==='./recommendation-attribution') return {}
        if(modules.has(name)) return modules.get(name)
        const module={exports:{}}
        vm.runInNewContext(readFileSync(new URL(`../../miniprogram/utils/${name.replace('./','')}.js`,import.meta.url),'utf8'),{module,exports:module.exports,require:load,wx:runtime,Date,Promise,Map,Set},{filename:name})
        modules.set(name,module.exports)
        return module.exports
      }
      return {api:load('./api'),error:load('./customer-error')}
    }
    const original=createApi()
    const complaint={requestType:'complaint',detail:'食品有异物，请店长处理'}
    const firstError=await original.api.createServiceTask(complaint).catch((error:any)=>error)
    expect(firstError.statusCode).toBe(429)
    expect(firstError.code).toBe('HTTP_ERROR')
    expect(firstError.retryAt).toBeUndefined()
    expect(original.error.customerErrorMessage(firstError)).toBe('服务暂时未能确认，请稍后重试')
    expect(calls[0]!.body.data).toMatchObject({status:'rate_limited',message:'我们已经收到啦，伙伴正在赶来，请稍等一下'})
    // Move just the limiter window into the past; keep the actual command receipt unchanged.
    await pool.query(`UPDATE mbox.guest_request_rate_limits SET window_started_at=window_started_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes' WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId])
    const restarted=createApi()
    const retryError=await restarted.api.createServiceTask(complaint).catch((error:any)=>error)
    expect(retryError.statusCode).toBe(429)
    expect(calls[1]!.key).toBe(calls[0]!.key)
    expect(calls[1]!.body.meta.replayed).toBe(true)
    const before=await pool.query(`SELECT count(*)::int AS count FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND task_type='guest.complaint'`,[tenantId,storeId])
    expect(before.rows[0].count).toBe(0)
    // Control: the now-open minute accepts the identical complaint under a fresh explicit key.
    const control=await app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':'a120-fresh-complaint-control'},payload:complaint})
    expect(control.statusCode).toBe(201)
    const after=await pool.query(`SELECT count(*)::int AS count FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND task_type='guest.complaint'`,[tenantId,storeId])
    expect(after.rows[0].count).toBe(1)
    console.log(JSON.stringify({audit:'120-guest-service-recovery',firstStatus:calls[0]!.status,restartRetryStatus:calls[1]!.status,
      sameIdempotencyKey:true,replayed:true,complaintTasksBeforeRecovery:0,freshKeyStatus:control.statusCode,complaintTasksAfterFreshKey:1,
      clientCode:firstError.code,clientRetryAt:firstError.retryAt??null}))
  })

  it('web retry after a lost receipt and staff completion creates a second service task', async () => {
    await pool.query(`UPDATE mbox.guest_request_rate_limits SET window_started_at=window_started_at-interval '3 minutes',expires_at=expires_at-interval '3 minutes' WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId])
    const requestKeys:string[]=[]
    const notices:string[]=[]
    let firstTaskPublicId=''
    const api=new GuestApiClient('120-guest-web-device',{
      fetch:async (url,options)=>{
        const headers=new Headers(options?.headers)
        requestKeys.push(headers.get('idempotency-key')!)
        const response=await app.inject({method:'POST',url:String(url),headers:Object.fromEntries(headers),payload:JSON.parse(String(options?.body))})
        expect(response.statusCode).toBe(201)
        if(requestKeys.length===1){
          firstTaskPublicId=response.json().data.taskPublicId
          const task=await pool.query(`SELECT id FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3`,[tenantId,storeId,firstTaskPublicId])
          await transactions.run({tenantId,storeId},transaction=>new ServiceTaskRepository(transaction).complete({
            taskId:task.rows[0].id,actor:{type:'system'},eventIdempotencyKey:'a120-web-first-task-complete',
          }))
          throw new Error('simulated response loss after committed request and staff completion')
        }
        return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}})
      },
    })
    const source=readFileSync(new URL('../../src/normalized-ui/guest/GuestApp.tsx',import.meta.url),'utf8')
    const start=source.indexOf('  const requestService = useCallback(async (requestType: ServiceType, detail: string | null) => {')
    const end=source.indexOf('  }, [blockForSession, notify, pendingService])',start)
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start)
    const callback=source.slice(start,end).replace('  const requestService = useCallback(','')
      .replace('(requestType: ServiceType, detail: string | null)','(requestType, detail)')+'  }'
    const request=vm.runInNewContext(`(${callback})`,{
      apiRef:{current:api},pendingService:null,serviceSubmittingRef:{current:false},
      setPendingService(){},haptic(){},setPanel(){},setServiceDetail(){},blockForSession:()=>false,
      notify:(message:string)=>notices.push(message),errorMessage:(error:unknown,fallback:string)=>error instanceof GuestApiError ? error.message : fallback,
      safeIdempotencyKey:(prefix:string)=>`${prefix}-${randomUUID()}`,
    })
    await request('custom','请送一张消费单据')
    expect(notices[0]).toBe('网络好像走神了，请检查网络后重试。')
    await request('custom','请送一张消费单据')
    expect(requestKeys[0]).not.toBe(requestKeys[1])
    const tasks=await pool.query(`SELECT public_id,status FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND detail='请送一张消费单据' ORDER BY created_at`,[tenantId,storeId])
    expect(tasks.rows.map(row=>row.status)).toEqual(['completed','pending'])
    expect(tasks.rows[0].public_id).toBe(firstTaskPublicId)
    console.log(JSON.stringify({audit:'120-guest-web-receipt-loss',requestCount:requestKeys.length,distinctKeys:new Set(requestKeys).size,
      taskStatuses:tasks.rows.map(row=>row.status),firstNotice:notices[0]}))
  })

  it('a table with 31 unpaid orders exposes only 30 and the Mini Program understates the current balance', async () => {
    const productId=randomUUID()
    await pool.query(`INSERT INTO mbox.products (id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,status)
      VALUES ($1,$2,$3,'A120-FOOD','Audit food','food','kitchen','not_managed','active')`,[productId,tenantId,storeId])
    for(let round=1;round<=31;round++){
      const orderId=randomUUID()
      await pool.query(`INSERT INTO mbox.orders (id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,
        subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,created_at)
        VALUES ($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',1000,0,1000,'CNY',$6,clock_timestamp()+($7::int*interval '1 second'))`,
      [orderId,tenantId,storeId,tableSessionId,`a120-round-${round.toString().padStart(2,'0')}`,customerId,round])
      await pool.query(`INSERT INTO mbox.order_items (tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status)
        VALUES ($1,$2,$3,$4,1,1000,1000,'CNY','kitchen','{"name":"Audit food"}'::jsonb,'submitted')`,[tenantId,storeId,orderId,productId])
    }
    const actual=await pool.query(`SELECT count(*)::int AS count,sum(total_amount_minor)::int AS total FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND table_session_id=$3`,[tenantId,storeId,tableSessionId])
    expect(actual.rows[0]).toEqual({count:31,total:31000})
    const response=await app.inject({method:'GET',url:'/api/guest/orders/table'})
    expect(response.statusCode).toBe(200)
    const rawOrders=response.json().data
    expect(rawOrders).toHaveLength(30)
    expect(rawOrders[0].round).toBe(2)
    expect(rawOrders.at(-1).round).toBe(31)
    expect(rawOrders.reduce((sum:number,order:any)=>sum+order.payableAmountMinor,0)).toBe(30000)
    const makePage=(pageName:string)=>{
      const storage=new Map<string,unknown>()
      const runtime={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key)}
      let page:any
      const cache=new Map<string,any>()
      const load=(path:URL):any=>{
        if(path.pathname.endsWith('/utils/api.js'))return {getTableOrders:async()=>rawOrders}
        if(path.pathname.endsWith('/utils/session.js'))return {getTableSession:()=>({tableCode:'A01',cartScope:tableSessionId}),tableSessionCacheScope:()=>tableSessionId}
        if(path.pathname.endsWith('/config/index.js'))return {getRuntimeConfig:()=>({isDevelopment:false})}
        if(cache.has(path.href))return cache.get(path.href)
        const module={exports:{}}
        vm.runInNewContext(readFileSync(path,'utf8'),{module,exports:module.exports,Date,wx:runtime,
          require:(name:string)=>load(new URL(`${name}.js`,path)),Page:(definition:any)=>{page=definition}}, {filename:path.pathname})
        cache.set(path.href,module.exports)
        return module.exports
      }
      load(new URL(`../../miniprogram/pages/${pageName}/index.js`,import.meta.url))
      page.data=structuredClone(page.data)
      page.setData=(value:any)=>Object.assign(page.data,value)
      page.auditStorage=storage
      return page
    }
    const account=makePage('account')
    account.historyMode=false
    account.auditStorage.set('mbox.pending.guest.payment.v1',{orderPublicId:'a120-round-01',tableScope:tableSessionId})
    await account.loadData()
    expect(account.data.error).toBe('')
    expect(account.data.outstandingText).toBe('¥300.00')
    expect(account.data.hasMoreHistory).toBe(false)
    expect(account.data.orders).toHaveLength(30)
    expect(account.auditStorage.has('mbox.pending.guest.payment.v1')).toBe(false)
    const service=makePage('service')
    await service.loadComplaintOrders()
    expect(service.data.complaintOrders).toHaveLength(9)
    expect(service.data.complaintOrders.some((order:any)=>order.publicId==='a120-round-31')).toBe(false)
    console.log(JSON.stringify({audit:'120-guest-table-order-truncation',databaseOrderCount:31,databaseReceivableMinor:31000,
      apiOrderCount:rawOrders.length,apiReceivableMinor:30000,visibleCurrentBalance:account.data.outstandingText,
      currentTablePagination:account.data.hasMoreHistory,oldUnpaidLocalRecoveryRemoved:true,complaintSelectableOrders:service.data.complaintOrders.length-1,
      newestOrderSelectableForComplaint:false}))
  })
})
