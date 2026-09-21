import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations, unwrapNormalizedMigrationTransaction } from '../migrate-normalized.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { guestCommerceServiceApiPlugin } from './guest-commerce-service-api.js'
import { seedActiveGuestTableAuthority } from './guest-table-authority.test-helper.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { ServiceTaskRepository } from './service-task-repository.js'
import { GuestApiClient } from '../../src/normalized-ui/guest/guest-api.js'

import { GuestServiceRecovery } from '../../src/normalized-ui/guest/guest-service-recovery.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip

// SIM120-04–07: real route/transaction regression. Authentication is injected;
// CI supplies an actual NOBYPASSRLS LOGIN for business calls, admin only fixtures/readback.
integration('SIM120 guest recovery and complete table bill', () => {
  let pool: Pool
  let businessPool: Pool
  let app: FastifyInstance
  let transactions: ScopedPostgresTransactionRunner
  const tenantId = randomUUID(), storeId = randomUUID(), tableId = randomUUID()
  const areaId = randomUUID(), customerId = randomUUID(), tableSessionId = randomUUID()

  let actorRef = '', contextCustomerId = customerId, deviceFingerprint = '120-guest-service-device-a'

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    businessPool = new Pool({ connectionString: process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL ?? databaseUrl, max: 4 })
    const wrapped: PostgresPool = {
      connect: async () => {
        const client = await businessPool.connect()
        return { query: (sql, values) => client.query(sql, values ? [...values] : undefined), release: error => client.release(error) }
      }, end: () => businessPool.end(),
    }
    transactions = new ScopedPostgresTransactionRunner(wrapped)
    await pool.query(`INSERT INTO mbox.tenants (id,code,name) VALUES ($1,$2,'120 guest service audit')`, [tenantId, `a120-${tenantId}`])
    await pool.query(`INSERT INTO mbox.stores (id,tenant_id,code,name,timezone,business_day_cutoff) VALUES ($1,$2,$3,'120 guest service audit','Asia/Shanghai','06:00')`, [storeId,tenantId,`a120-${storeId}`])
    await pool.query(`INSERT INTO mbox.areas (id,tenant_id,store_id,code,name,area_type) VALUES ($1,$2,$3,'AUDIT','Audit','indoor')`, [areaId,tenantId,storeId])
    await pool.query(`INSERT INTO mbox.tables (id,tenant_id,store_id,area_id,code,display_name,capacity,qr_version) VALUES ($1,$2,$3,$4,'A01','Audit table',6,1)`, [tableId,tenantId,storeId,areaId])
    await pool.query(`INSERT INTO mbox.customers (id,tenant_id,store_id,public_id) VALUES ($1,$2,$3,$4)`, [customerId,tenantId,storeId,`a120-${customerId}`])
    await pool.query(`INSERT INTO mbox.table_sessions (id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES ($1,$2,$3,$4,$5,'2026-09-21',6,'open')`, [tableSessionId,tenantId,storeId,tableId,`a120-${tableSessionId}`])
    await pool.query(`INSERT INTO mbox.table_session_customers (tenant_id,store_id,table_session_id,customer_id,relationship) VALUES ($1,$2,$3,$4,'primary')`, [tenantId,storeId,tableSessionId,customerId])
    actorRef = await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId,customerId})
    app = Fastify()
    await app.register(guestCommerceServiceApiPlugin, {
      prefix: '/api', transactions, commandExecutor: new NormalizedCommandExecutor(transactions),
      commerce: {} as never, payments: {} as never, onlinePayments: {} as never,
      resolveGuestContext: async () => ({ scope:{tenantId,storeId}, sessionKind:'table', customerId:contextCustomerId, tableSessionId,
        reservationId:null, tableCode:'A01',tableDisplayName:'Audit table',businessDate:'2026-09-21',
        expiresAt:'2026-09-22T00:00:00.000Z',capabilities:['guest.session.read','guest.service.create'],actorRef }),
      resolvePublicContext: async () => ({scope:{tenantId,storeId}}),
      resolveDeviceFingerprint: () => deviceFingerprint,
      paymentMode:'simulation',paymentActionSecret:'120-guest-audit-not-a-real-payment-secret',
      deviceServiceLimitPerMinute:5,tableServiceLimitPerMinute:20,
    })
    await app.ready()
  }, 120_000)

  afterAll(async () => { await app?.close(); await businessPool?.end(); await pool?.end() })

  for (const platform of ['miniprogram', 'alipay-miniprogram']) {
    it(`${platform}: a persisted 429 resumes under the original key, serializes concurrent retry and never changes intent`, async () => {
      await pool.query('DELETE FROM mbox.guest_request_rate_limits WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])
      for (let index=0; index<5; index++) {
        const response=await app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':`${platform}-fill-${index}`},payload:{requestType:'custom',detail:`${platform}需要${index}杯水`}})
        expect(response.statusCode).toBe(201)
      }
      const storage=new Map<string,unknown>(), calls:Array<{key:string;status:number;body:any}>=[]
      const runtime={
        getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key),
        request:(input:any)=>{ void app.inject({method:input.method,url:new URL(input.url).pathname,headers:input.header,payload:input.data}).then(response=>{
          calls.push({key:input.header['idempotency-key'],status:response.statusCode,body:response.json()})
          if (platform === 'alipay-miniprogram' && response.statusCode === 429) input.fail({status:429,error:19,errorMessage:'http status error',data:response.json()})
          else input.success({statusCode:response.statusCode,data:response.json(),header:response.headers})
        }).catch(input.fail) },
      }
      const createApi=()=>{
        const modules=new Map<string,any>()
        const load=(name:string):any=>{
          if(name==='./platform')return runtime
          if(name==='./session')return {getTableSession:()=>({tableCode:'A01',tableToken:'fixture-token',cartScope:tableSessionId}),clearTableConnection(){}}
          if(name==='../config/index')return {getRuntimeConfig:()=>({apiBaseUrl:'https://fixture.invalid',storeId,requestTimeoutMs:10000})}
          if(name==='./id')return {randomId:(prefix:string)=>`${prefix}-${randomUUID()}`}
          if(name==='./auth'||name==='./recommendation-attribution')return {}
          if(modules.has(name))return modules.get(name)
          const module={exports:{}}
          vm.runInNewContext(commonJs(readFileSync(new URL(`../../${platform}/utils/${name.replace('./','')}.js`,import.meta.url),'utf8')),{module,exports:module.exports,require:load,wx:runtime,Date,Promise,Map,Set},{filename:name})
          modules.set(name,module.exports);return module.exports
        }
        return load('./api')
      }
      const complaint={requestType:'complaint',detail:`${platform}食品有异物，请店长处理`}
      const first=await createApi().createServiceTask(complaint).catch((error:any)=>error)
      expect(first).toMatchObject({statusCode:429,code:'GUEST_SERVICE_RATE_LIMITED'})
      expect(Number.isFinite(Date.parse(first.retryAt))).toBe(true)
      expect(calls[0]!.body.data.message).toContain('尚未受理')
      const key=calls[0]!.key
      const early=await createApi().createServiceTask(complaint).catch((error:any)=>error)
      expect(early.statusCode).toBe(429)
      expect(calls[1]).toMatchObject({key,body:{meta:{replayed:true}}})
      const changed=await app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':key},payload:{...complaint,detail:'不同的投诉'}})
      expect(changed.statusCode).toBe(409)
      // Deterministically advance both persisted time facts, not the request identity.
      await pool.query(`UPDATE mbox.guest_request_rate_limits SET window_started_at=window_started_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes' WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId])
      await pool.query(`UPDATE mbox.idempotency_records SET response_snapshot=jsonb_set(response_snapshot,'{result,retryAt}',to_jsonb((clock_timestamp()-interval '2 minutes')::text)) WHERE tenant_id=$1 AND store_id=$2 AND operation_scope='guest.service.request' AND idempotency_key=$3`,[tenantId,storeId,key])
      const concurrent=await Promise.all(Array.from({length:4},()=>app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':key},payload:complaint})))
      expect(concurrent.map(response=>response.statusCode).sort()).toEqual([200,200,200,201])
      expect(new Set(concurrent.map(response=>response.json().data.taskPublicId)).size).toBe(1)
      const recovered=await createApi().createServiceTask(complaint)
      expect(recovered.data.status).toBe('created')
      expect(calls.at(-1)!.key).toBe(key)
      expect(calls.at(-1)!.body.meta.replayed).toBe(true)
      const tasks=await pool.query(`SELECT count(*)::int AS count FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND detail=$3`,[tenantId,storeId,complaint.detail])
      expect(tasks.rows[0].count).toBe(1)
      const behaviors=await pool.query(`SELECT behavior_type,count(*)::int AS count FROM mbox.guest_behavior_events WHERE tenant_id=$1 AND store_id=$2 AND behavior_code='complaint' GROUP BY behavior_type`,[tenantId,storeId])
      expect(behaviors.rows.every(row=>row.count<= (platform==='miniprogram'?1:2))).toBe(true)
    })
  }

  it('Web unknown receipt survives a new client and worker completion without creating a second task', async () => {
    await pool.query('DELETE FROM mbox.guest_request_rate_limits WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])
    const data=new Map<string,string>(), keys:string[]=[]
    const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
    const createClient=()=>new GuestApiClient('web-restore-device',{fetch:async(url,options)=>{
      const headers=new Headers(options?.headers);keys.push(headers.get('idempotency-key')!)
      const response=await app.inject({method:'POST',url:String(url),headers:Object.fromEntries(headers),payload:JSON.parse(String(options?.body))})
      expect([200,201]).toContain(response.statusCode)
      if(keys.length===1){
        const task=await pool.query('SELECT id FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[tenantId,storeId,response.json().data.taskPublicId])
        await transactions.run({tenantId,storeId},tx=>new ServiceTaskRepository(tx).complete({taskId:task.rows[0].id,actor:{type:'system'},eventIdempotencyKey:'web-restore-staff-completed'}))
        throw new Error('response lost after commit and staff completion')
      }
      return new Response(response.body,{status:response.statusCode})
    }})
    const first=createClient()
    await expect(new GuestServiceRecovery(storage,tableSessionId,'web-restore-device').execute({requestType:'custom',detail:'请送消费单据'},first.requestService.bind(first))).rejects.toThrow()
    const restarted=createClient(),recovery=new GuestServiceRecovery(storage,tableSessionId,'web-restore-device')
    await recovery.execute(null,restarted.requestService.bind(restarted))
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(recovery.pending()).toBeNull()
    const tasks=await pool.query(`SELECT status FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND detail='请送消费单据'`,[tenantId,storeId])
    expect(tasks.rows).toEqual([{status:'completed'}])
  })

  it('31 then 60 table orders preserve the authoritative amount, earliest payment recovery and every complaint target on both platforms', async () => {
    const productId=randomUUID()
    await pool.query(`INSERT INTO mbox.products (id,tenant_id,store_id,code,name,category_code,fulfillment_station,inventory_control_mode,status) VALUES ($1,$2,$3,'FIX-FOOD','Food','food','kitchen','not_managed','active')`,[productId,tenantId,storeId])
    for(let round=1;round<=60;round++){
      const orderId=randomUUID()
      await pool.query(`INSERT INTO mbox.orders (id,tenant_id,store_id,table_session_id,public_id,channel,status,payment_status,subtotal_amount_minor,discount_amount_minor,total_amount_minor,currency,created_by_customer_id,created_at) VALUES ($1,$2,$3,$4,$5,'staff_assisted','submitted','unpaid',1000,0,1000,'CNY',$6,clock_timestamp()+($7::int*interval '1 second'))`,[orderId,tenantId,storeId,tableSessionId,`fix-round-${round.toString().padStart(2,'0')}`,customerId,round])
      await pool.query(`INSERT INTO mbox.order_items (tenant_id,store_id,order_id,product_id,quantity,unit_price_minor,total_amount_minor,currency,fulfillment_station,product_snapshot,status) VALUES ($1,$2,$3,$4,1,1000,1000,'CNY','kitchen','{"name":"Food"}'::jsonb,'submitted')`,[tenantId,storeId,orderId,productId])
      if(round!==31&&round!==60)continue
      const response=await app.inject({method:'GET',url:'/api/guest/orders/table'})
      expect(response.statusCode).toBe(200)
      const orders=response.json().data
      expect(orders).toHaveLength(round)
      expect(orders.reduce((sum:number,order:any)=>sum+order.payableAmountMinor,0)).toBe(round*1000)
      for(const platform of ['miniprogram','alipay-miniprogram']){
        const account=makePage(platform,'account',orders)
        account.historyMode=false
        account.storage.set('mbox.pending.guest.payment.v1',{orderPublicId:'fix-round-01',tableScope:tableSessionId})
        await account.loadData()
        expect(account.data.error).toBe('')
        expect(account.data.outstandingText).toBe(`¥${round*10}.00`)
        expect(account.storage.has('mbox.pending.guest.payment.v1')).toBe(true)
        const service=makePage(platform,'service',orders)
        await service.loadComplaintOrders()
        expect(service.data.complaintOrders).toHaveLength(round+1)
        expect(service.data.complaintOrders.some((order:any)=>order.publicId===`fix-round-${round}`)).toBe(true)
        service.data.complaintOrderIndex=round
        await service.loadComplaintOrders()
        expect(service.data.complaintOrderIndex).toBe(round)
        // A missing row alone never proves payment completion.
        const incomplete=makePage(platform,'account',[])
        incomplete.storage.set('mbox.pending.guest.payment.v1',{orderPublicId:'fix-round-01',tableScope:tableSessionId})
        await incomplete.loadData()
        expect(incomplete.storage.has('mbox.pending.guest.payment.v1')).toBe(true)
      }
    }
  })

  it('migration preserves uniquely attributable legacy acceptance and blocks missing/ambiguous ownership without guessing', async () => {
    const client=await pool.connect()
    const snapshot=async()=>JSON.stringify((await pool.query(`SELECT idempotency_key,result,table_session_id,customer_id FROM mbox.guest_service_command_receipts WHERE tenant_id=$1 AND store_id=$2 ORDER BY idempotency_key`,[tenantId,storeId])).rows)
    const before=await snapshot()
    try {
      await client.query('BEGIN')
      // The dedicated integration database already has 233. Re-run the exact
      // migration against real earlier behavior/cache facts inside a rollback.
      await client.query('DROP TABLE mbox.guest_service_command_receipts')
      await client.query(`INSERT INTO mbox.idempotency_records(tenant_id,store_id,operation_scope,idempotency_key,request_sha256,status,response_status,response_snapshot,expires_at)
        SELECT tenant_id,store_id,operation_scope,'legacy-unattributed-key',request_sha256,status,response_status,
          jsonb_set(response_snapshot,'{result,taskPublicId}','"legacy-no-behavior"'::jsonb),expires_at
        FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key='miniprogram-fill-0'`,[tenantId,storeId])
      await client.query(`INSERT INTO mbox.guest_behavior_events(tenant_id,store_id,table_session_id,customer_id,behavior_type,behavior_code,behavior_data,actor_ref_hash,device_hash)
        SELECT tenant_id,store_id,table_session_id,customer_id,behavior_type,behavior_code,behavior_data,actor_ref_hash,device_hash
        FROM mbox.guest_behavior_events WHERE tenant_id=$1 AND store_id=$2 AND behavior_data->>'taskPublicId'=(
          SELECT response_snapshot->'result'->>'taskPublicId' FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key='miniprogram-fill-0')`,[tenantId,storeId])
      await client.query(unwrapNormalizedMigrationTransaction(readFileSync(new URL('../../database/normalized-migrations/233_guest_service_command_receipts.sql',import.meta.url),'utf8')))
      const rows=(await client.query(`SELECT idempotency_key,table_session_id,customer_id FROM mbox.guest_service_command_receipts WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=ANY($3::text[]) ORDER BY idempotency_key`,[tenantId,storeId,['legacy-unattributed-key','miniprogram-fill-0','miniprogram-fill-1']])).rows
      expect(rows).toEqual([
        {idempotency_key:'legacy-unattributed-key',table_session_id:null,customer_id:null},
        {idempotency_key:'miniprogram-fill-0',table_session_id:null,customer_id:null},
        {idempotency_key:'miniprogram-fill-1',table_session_id:tableSessionId,customer_id:customerId},
      ])
      expect((await client.query(`SELECT count(*)::int AS count FROM mbox.guest_service_command_receipts WHERE result->>'status'='rate_limited'`)).rows[0].count).toBe(0)
    } finally { await client.query('ROLLBACK');client.release() }
    expect(await snapshot()).toBe(before)
    const key='legacy-unattributed-api',payload={requestType:'custom',detail:'不可归属旧请求'}
    const requestHash=createHash('sha256').update(JSON.stringify({detail:payload.detail,relatedOrderPublicId:null,requestType:payload.requestType})).digest('hex')
    await pool.query(`INSERT INTO mbox.guest_service_command_receipts(tenant_id,store_id,idempotency_key,request_sha256,result) VALUES($1,$2,$3,$4,$5::jsonb)`,[tenantId,storeId,key,requestHash,JSON.stringify({status:'created',requestType:'custom',taskPublicId:'legacy-no-evidence'})])
    const response=await app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':key},payload})
    expect(response.statusCode,response.body).toBe(409)
    expect(response.json()).toMatchObject({error:{code:'GUEST_SERVICE_RECEIPT_REVIEW_REQUIRED'}})
    expect(response.json().data).toBeUndefined()
    expect((await pool.query(`SELECT count(*)::int AS count FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,[tenantId,storeId,key])).rows[0].count).toBe(0)
  })

  it('permanent created/merged receipts survive expiry/deletion and renewed canonical identity, without repeating tasks/counts/audits/outbox', async () => {
    await pool.query('DELETE FROM mbox.guest_request_rate_limits WHERE tenant_id=$1 AND store_id=$2',[tenantId,storeId])
    const payload={requestType:'custom',detail:'永久受理回执核对'},key='permanent-service-created',mergedKey='permanent-service-merged'
    const submit=(idempotencyKey:string,body:unknown=payload)=>app.inject({method:'POST',url:'/api/guest/service-requests',headers:{'idempotency-key':idempotencyKey},payload:body as any})
    const created=await submit(key),merged=await submit(mergedKey)
    expect(created.statusCode,created.body).toBe(201);expect(merged.statusCode,merged.body).toBe(200)
    expect(created.json().data).toMatchObject({status:'created',requestCount:1})
    expect(merged.json().data).toMatchObject({status:'merged',requestCount:2})
    const task=(await pool.query('SELECT id FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2 AND public_id=$3',[tenantId,storeId,created.json().data.taskPublicId])).rows[0]
    await transactions.run({tenantId,storeId},tx=>new ServiceTaskRepository(tx).complete({taskId:task.id,actor:{type:'system'},eventIdempotencyKey:'permanent-service-finished'}))
    const facts=async()=>(await pool.query(`SELECT
      (SELECT count(*) FROM mbox.service_tasks WHERE tenant_id=$1 AND store_id=$2) AS tasks,
      (SELECT sum(request_count) FROM mbox.guest_service_request_groups WHERE tenant_id=$1 AND store_id=$2) AS requests,
      (SELECT count(*) FROM mbox.guest_behavior_events WHERE tenant_id=$1 AND store_id=$2) AS behaviors,
      (SELECT count(*) FROM mbox.audit_events WHERE tenant_id=$1 AND store_id=$2) AS audits,
      (SELECT count(*) FROM mbox.outbox_messages WHERE tenant_id=$1 AND store_id=$2) AS outbox,
      (SELECT count(*) FROM mbox.guest_service_command_receipts WHERE tenant_id=$1 AND store_id=$2) AS receipts`,[tenantId,storeId])).rows[0]
    const baseline=await facts()
    await pool.query(`UPDATE mbox.idempotency_records SET created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=$3`,[tenantId,storeId,key])
    for(const response of await Promise.all([submit(key),submit(key)])){
      expect(response.statusCode,response.body).toBe(200);expect(response.json().data).toEqual(created.json().data);expect(response.json().meta.replayed).toBe(true)
    }
    await pool.query(`DELETE FROM mbox.idempotency_records WHERE tenant_id=$1 AND store_id=$2 AND idempotency_key=ANY($3::text[])`,[tenantId,storeId,[key,mergedKey]])
    expect((await submit(mergedKey)).json().data).toEqual(merged.json().data)
    expect((await submit(key,{...payload,detail:'试图改参'})).statusCode).toBe(409)
    deviceFingerprint='different-device-forbidden'
    expect((await submit(key)).statusCode).toBe(409)
    deviceFingerprint='120-guest-service-device-a'
    // The current session can rotate without losing the original accepted intent.
    const originalActor=actorRef
    actorRef=await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId,customerId})
    await pool.query(`UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='superseded_by_rescan' WHERE id=$1`,[originalActor.slice('guest-session:'.length)])
    expect((await submit(key)).json().data).toEqual(created.json().data)
    // A distinct authenticated customer at this table cannot recover the receipt.
    const otherCustomer=randomUUID()
    await pool.query(`INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)`,[otherCustomer,tenantId,storeId,`other-${otherCustomer}`])
    await pool.query(`INSERT INTO mbox.table_session_customers(tenant_id,store_id,table_session_id,customer_id,relationship) VALUES($1,$2,$3,$4,'guest')`,[tenantId,storeId,tableSessionId,otherCustomer])
    const currentActor=actorRef
    actorRef=await seedActiveGuestTableAuthority(pool,{tenantId,storeId,tableSessionId,customerId:otherCustomer});contextCustomerId=otherCustomer
    expect((await submit(key)).statusCode).toBe(409)
    // Canonical merging preserves ownership; the original actor remains audit history.
    await pool.query(`UPDATE mbox.customers SET status='merged',merged_into_customer_id=$2 WHERE id=$1`,[customerId,otherCustomer])
    expect((await submit(key)).json().data).toEqual(created.json().data)
    await pool.query(`UPDATE mbox.guest_sessions SET revoked_at=clock_timestamp(),revoke_reason='fixture_authority_revoked' WHERE id=$1`,[actorRef.slice('guest-session:'.length)])
    expect((await submit(key)).statusCode).toBe(401)
    expect(await facts()).toEqual(baseline)
    await expect(transactions.run({tenantId,storeId},tx=>tx.query(`UPDATE mbox.guest_service_command_receipts SET result='{}'::jsonb`))).rejects.toMatchObject({code:'42501'})
    const crossScope=await transactions.run({tenantId:randomUUID(),storeId:randomUUID()},tx=>tx.query<{count:string}>(`SELECT count(*)::text AS count FROM mbox.guest_service_command_receipts`))
    expect(crossScope.rows[0]?.count).toBe('0')
    actorRef=currentActor
  })

  function makePage(platform:string,pageName:string,orders:any[]){
    const storage=new Map<string,unknown>()
    const runtime={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key)}
    let page:any
    const cache=new Map<string,any>()
    const load=(path:URL):any=>{
      if(path.pathname.endsWith('/utils/platform.js'))return runtime
      if(path.pathname.endsWith('/utils/api.js'))return {getTableOrders:async()=>orders}
      if(path.pathname.endsWith('/utils/session.js'))return {getTableSession:()=>({tableCode:'A01',cartScope:tableSessionId}),tableSessionCacheScope:()=>tableSessionId}
      if(path.pathname.endsWith('/config/index.js'))return {getRuntimeConfig:()=>({isDevelopment:false})}
      if(cache.has(path.href))return cache.get(path.href)
      const module={exports:{}}
      vm.runInNewContext(commonJs(readFileSync(path,'utf8')),{module,exports:module.exports,Date,wx:runtime,require:(name:string)=>load(new URL(`${name}.js`,path)),Page:(definition:any)=>{page=definition}},{filename:path.pathname})
      cache.set(path.href,module.exports);return module.exports
    }
    load(new URL(`../../${platform}/pages/${pageName}/index.js`,import.meta.url))
    page.data=structuredClone(page.data);page.setData=(value:any)=>Object.assign(page.data,value);page.storage=storage
    return page
  }
})

function commonJs(source:string){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,allowJs:true}}).outputText}
