import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { CustomerRepository } from './customer-repository.js'
import { GuestSessionService, hashTableQrCredential } from './guest-session-repository.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'

const adminUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const integration = adminUrl && runtimeUrl ? describe : describe.skip
const secret = 'local-scan-concurrency-fixture-secret-at-least-32-characters'
integration('guest scans preserve identity and location under contention', () => {
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, service: GuestSessionService
  beforeAll(async () => {
    await runNormalizedMigrations(adminUrl!)
    admin = new Pool({ connectionString: adminUrl, max: 4 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 16, application_name: 'mbox-scan-concurrency-regression' })
    expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    runner = new ScopedPostgresTransactionRunner(runtime)
    service = new GuestSessionService(runner, { resolveAnonymous: async ({ transaction, identityHash, publicId }) => {
      const value = await new CustomerRepository(transaction).createAnonymous({ identityHash, publicId })
      return { customerId: value.customer.id }
    } }, secret)
  })
  afterAll(async () => { await runtime?.end(); await admin?.end() })
  async function fixture(tableCount: number, customerCount = 0) {
    const tenantId = randomUUID(), storeId = randomUUID(), areaId = randomUUID(), scope = { tenantId, storeId }
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Scan regression')", [tenantId,tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff) VALUES($1,$2,$3,'Scan regression','Asia/Shanghai','06:00')", [storeId,tenantId,storeId])
    await admin.query("INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type) VALUES($1,$2,$3,'A','A','indoor')", [areaId,tenantId,storeId])
    const businessDate = (await runner.run(scope, tx => tx.query<{ date: string }>('SELECT mbox.current_operating_business_date($1,$2)::text AS date',[tenantId,storeId]))).rows[0]!.date
    const tables: Array<{ tableId: string; sessionId: string; token: string }> = []
    for (let i=0;i<tableCount;i++) {
      const tableId=randomUUID(),sessionId=randomUUID(),token=`scan-fixture-${randomUUID()}`
      await admin.query("INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity,qr_version) VALUES($1,$2,$3,$4,$5,$5,12,1)", [tableId,tenantId,storeId,areaId,`T${i}`])
      await admin.query('INSERT INTO mbox.table_qr_credentials(tenant_id,store_id,table_id,qr_version,credential_hash) VALUES($1,$2,$3,1,$4)', [tenantId,storeId,tableId,hashTableQrCredential(secret,scope,token)])
      await admin.query("INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count,status) VALUES($1,$2,$3,$4,$5,$6,12,'open')", [sessionId,tenantId,storeId,tableId,sessionId,businessDate])
      tables.push({tableId,sessionId,token})
    }
    const customers: string[] = []
    for (let i=0;i<customerCount;i++) {
      const id=randomUUID();customers.push(id)
      await admin.query('INSERT INTO mbox.customers(id,tenant_id,store_id,public_id) VALUES($1,$2,$3,$4)', [id,tenantId,storeId,id])
    }
    return { scope, businessDate, tables, customers }
  }
  for (const scenario of [
    { name: 'twelve anonymous devices at the same table', tables: 1, guests: 12, known: false },
    { name: 'twelve anonymous devices at different tables', tables: 12, guests: 12, known: false },
    { name: 'twelve existing customers at different tables', tables: 12, guests: 12, known: true },
    { name: '120 anonymous devices at thirty tables', tables: 30, guests: 120, known: false },
  ]) it(scenario.name, async () => {
    const f=await fixture(scenario.tables,scenario.known?scenario.guests:0)
    const result=await Promise.allSettled(Array.from({length:scenario.guests},(_,i)=>service.scanTable({
      scope:f.scope,businessDate:f.businessDate,tableQrToken:f.tables[i%f.tables.length]!.token,
      deviceFingerprint:`scan-${f.scope.storeId}-${i}`, ...(scenario.known?{customerId:f.customers[i]}:{}),
    })))
    const failed=result.filter(r=>r.status==='rejected').map(r=>String(r.reason?.code??r.reason?.name))
    expect(failed).toEqual([])
    for(const row of result)if(row.status==='fulfilled')expect(['active','already_active']).toContain(row.value.status)
    const facts=await admin.query(`SELECT (SELECT count(*)::int FROM mbox.guest_sessions WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM mbox.table_session_customer_participations WHERE tenant_id=$1 AND store_id=$2 AND left_at IS NULL) AS positions`, [f.scope.tenantId,f.scope.storeId])
    expect(facts.rows[0]).toEqual({sessions:scenario.guests,positions:scenario.guests})
  },30_000)
  it('concurrent rescans of one canonical customer preserve one current location and revoke the old table token', async () => {
    const f=await fixture(2,1),customerId=f.customers[0]!
    const result=await Promise.all([0,1].map(i=>service.scanTable({ scope:f.scope,businessDate:f.businessDate,
      tableQrToken:f.tables[i]!.token,deviceFingerprint:`same-customer-device-${i}`,customerId })))
    expect(result.every(row=>row.status==='active')).toBe(true)
    const positions=(await admin.query('SELECT table_session_id FROM mbox.table_session_customer_participations WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND left_at IS NULL', [f.scope.tenantId,f.scope.storeId,customerId])).rows
    expect(positions).toHaveLength(1)
    const sessions=(await admin.query('SELECT table_session_id FROM mbox.guest_sessions WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 AND revoked_at IS NULL', [f.scope.tenantId,f.scope.storeId,customerId])).rows
    expect(sessions).toEqual(positions)
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.guest_table_rescan_events WHERE tenant_id=$1 AND store_id=$2', [f.scope.tenantId,f.scope.storeId])).rows[0]?.n).toBe(1)
  },30_000)
  it('rechecks a QR revoked after discovery before it signs a guest session', async () => {
    const f=await fixture(1),target=f.tables[0]!
    let revoked=false
    const hookedRunner={run: (scope: Parameters<typeof runner.run>[0], operation: (tx: import('./transaction-runner.js').ScopedTransaction) => Promise<unknown>, options: import('./transaction-runner.js').TransactionOptions) => runner.run(scope, async tx => {
      const hooked={...tx,query:async(text:string,values?:readonly unknown[])=>{
        const result=await tx.query(text,values)
        if(!revoked&&text.includes('FROM mbox.table_qr_credentials AS qr')) {
          revoked=true
          await admin.query("UPDATE mbox.table_qr_credentials SET status='revoked',retired_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2 AND table_id=$3",[f.scope.tenantId,f.scope.storeId,target.tableId])
        }
        return result
      }} as import('./transaction-runner.js').ScopedTransaction
      return operation(hooked)
    },options)} as ScopedPostgresTransactionRunner
    const guarded=new GuestSessionService(hookedRunner,{resolveAnonymous:async({transaction,identityHash,publicId})=>({customerId:(await new CustomerRepository(transaction).createAnonymous({identityHash,publicId})).customer.id})},secret)
    const result=await guarded.scanTable({scope:f.scope,businessDate:f.businessDate,tableQrToken:target.token,deviceFingerprint:'revoked-discovery-device'})
    expect(revoked).toBe(true)
    expect(result.status).toBe('invalid_qr')
    expect((await admin.query('SELECT count(*)::int AS n FROM mbox.guest_sessions WHERE tenant_id=$1 AND store_id=$2',[f.scope.tenantId,f.scope.storeId])).rows[0]?.n).toBe(0)
  })

  it('waits for a legacy-authorized canonical merge before issuing restricted concurrent table sessions', async () => {
    const f=await fixture(2,2),source=f.customers[0]!,target=f.customers[1]!
    for(const customer of [source,target])await admin.query("INSERT INTO mbox.customer_tags(tenant_id,store_id,customer_id,tag,visibility) VALUES($1,$2,$3,'staff-note','staff'),($1,$2,$3,'shared-tag',$4)",[f.scope.tenantId,f.scope.storeId,customer,customer===source?'staff':'public'])
    await admin.query("INSERT INTO mbox.customer_preferences(tenant_id,store_id,customer_id,preference_key,preference_value) VALUES($1,$2,$3,'quiet','true'::jsonb)",[f.scope.tenantId,f.scope.storeId,source])
    await admin.query("INSERT INTO mbox.customer_identities(tenant_id,store_id,customer_id,identity_kind,identity_hash) VALUES($1,$2,$3,'anonymous',$4)",[f.scope.tenantId,f.scope.storeId,source,'a'.repeat(64)])
    let locked!:()=>void,release!:()=>void
    const lockHeld=new Promise<void>(r=>{locked=r}),continueMerge=new Promise<void>(r=>{release=r})
    // Schema224 cannot merge customer tags through the future restricted LOGIN.
    // Production still uses its legacy privileged connection; model only that
    // merge lane with the fixture administrator. Scans retain their real LOGIN.
    const merge=new ScopedPostgresTransactionRunner(admin).run(f.scope,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`table-customer-movement:${f.scope.tenantId}:${f.scope.storeId}`])
      locked();await continueMerge
      return new CustomerRepository(tx).merge(source,target)
    })
    await lockHeld
    const scans=[source,target].map((customerId,i)=>service.scanTable({scope:f.scope,businessDate:f.businessDate,
      tableQrToken:f.tables[i]!.token,deviceFingerprint:`merging-customer-${i}`,customerId}))
    try {
      let waiting=0
      for(let n=0;n<100&&waiting===0;n++) {
        waiting=Number((await admin.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='mbox-scan-concurrency-regression' AND wait_event='advisory'")).rows[0]?.n)
        if(!waiting)await new Promise(r=>setTimeout(r,10))
      }
      expect(waiting).toBeGreaterThan(0)
    } finally { release() }
    expect((await merge).id).toBe(target)
    expect((await admin.query('SELECT tag,visibility,source FROM mbox.customer_tags WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3 ORDER BY tag',[f.scope.tenantId,f.scope.storeId,target])).rows).toEqual([{tag:'shared-tag',visibility:'public',source:'merge'},{tag:'staff-note',visibility:'staff',source:'merge'}])
    expect((await admin.query('SELECT customer_id FROM mbox.customer_identities WHERE tenant_id=$1 AND store_id=$2',[f.scope.tenantId,f.scope.storeId])).rows).toEqual([{customer_id:target}])
    expect((await admin.query('SELECT preference_value FROM mbox.customer_preferences WHERE tenant_id=$1 AND store_id=$2 AND customer_id=$3',[f.scope.tenantId,f.scope.storeId,target])).rows).toEqual([{preference_value:true}])
    const values=await Promise.all(scans)
    expect(values.every(row=>row.status==='active')).toBe(true)
    for (const value of values) if (value.status==='active') expect(value.session.customerId).toBe(target)
    const positions=await admin.query('SELECT count(*)::int AS n FROM mbox.table_session_customer_participations WHERE tenant_id=$1 AND store_id=$2 AND left_at IS NULL',[f.scope.tenantId,f.scope.storeId])
    expect(positions.rows[0]?.n).toBe(1)
    const current=await admin.query('SELECT count(*)::int AS n FROM mbox.guest_sessions WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL',[f.scope.tenantId,f.scope.storeId])
    expect(current.rows[0]?.n).toBe(1)
    const currentId=(await admin.query('SELECT id FROM mbox.guest_sessions WHERE tenant_id=$1 AND store_id=$2 AND revoked_at IS NULL',[f.scope.tenantId,f.scope.storeId])).rows[0]?.id
    const currentIndex=values.findIndex(value=>value.status==='active'&&value.session.id===currentId)
    const latest=values[currentIndex]!
    if(latest.status!=='active')throw new Error('current guest session missing')
    const authenticated=await service.authenticate({scope:f.scope,sessionToken:latest.sessionToken,deviceFingerprint:`merging-customer-${currentIndex}`})
    expect(authenticated.customerId).toBe(target)
  },30_000)

  it('keeps QR and tag identity updates denied and hides foreign customers and tags', async () => {
    const f=await fixture(1,1),other=await fixture(1,1)
    await admin.query("INSERT INTO mbox.customer_tags(tenant_id,store_id,customer_id,tag) VALUES($1,$2,$3,'private-note')",[f.scope.tenantId,f.scope.storeId,f.customers[0]])
    expect((await runtime.query('SELECT id FROM mbox.customer_tags')).rows).toEqual([])
    await expect(runner.run(f.scope,tx=>tx.query("UPDATE mbox.table_qr_credentials SET status='revoked',retired_at=clock_timestamp() WHERE table_id=$1",[f.tables[0]!.tableId]))).rejects.toMatchObject({code:'42501'})
    await expect(runner.run(f.scope,tx=>tx.query('UPDATE mbox.customer_tags SET customer_id=$1',[f.customers[0]]))).rejects.toMatchObject({code:'42501'})
    await runner.run(other.scope,async tx=>{
      for(const table of ['customers','table_qr_credentials'])expect((await tx.query(`SELECT id FROM mbox.${table} WHERE tenant_id=$1 AND store_id=$2`,[f.scope.tenantId,f.scope.storeId])).rows).toEqual([])
      expect((await tx.query('SELECT id FROM mbox.customer_tags')).rows).toEqual([])
    })
    // Schema224 denies this update altogether (migration232 is deferred).
    await expect(runner.run(other.scope,tx=>tx.query("UPDATE mbox.customer_tags SET source='forbidden' WHERE tenant_id=$1 AND store_id=$2",[f.scope.tenantId,f.scope.storeId]))).rejects.toMatchObject({code:'42501'})
    await expect(runner.run(other.scope,tx=>new CustomerRepository(tx).merge(f.customers[0]!,other.customers[0]!))).rejects.toThrow()
    expect((await admin.query('SELECT source FROM mbox.customer_tags WHERE tenant_id=$1 AND store_id=$2',[f.scope.tenantId,f.scope.storeId])).rows).toEqual([{source:'profile'}])
  })

})
