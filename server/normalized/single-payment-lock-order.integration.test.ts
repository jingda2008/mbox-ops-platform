import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PaymentRepository } from './payment-repository.js'
import { ScopedPostgresTransactionRunner, type ScopedTransaction } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL

;(databaseUrl && runtimeUrl ? describe : describe.skip)('single-payment parent lock order, restricted LOGIN', () => {
  let fixtures: Pool
  let runtime: Pool
  let runner: ScopedPostgresTransactionRunner
  let businessDate: string
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const areaId = randomUUID()

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    fixtures = new Pool({ connectionString: databaseUrl, max: 3 })
    runtime = new Pool({ connectionString: runtimeUrl, max: 3 })
    expect((await runtime.query(`SELECT rolsuper,rolbypassrls,rolcanlogin
      FROM pg_roles WHERE rolname=session_user`)).rows[0]).toEqual({
      rolsuper: false, rolbypassrls: false, rolcanlogin: true,
    })
    // Check the final migrated database and inherited runtime LOGIN, not only
    // the REVOKE text: later provisioning must not reopen the private counter.
    expect((await runtime.query(`SELECT
      has_sequence_privilege(current_user,'mbox.financial_fact_sequence','USAGE') AS usage,
      has_sequence_privilege(current_user,'mbox.financial_fact_sequence','SELECT') AS read,
      has_sequence_privilege(current_user,'mbox.financial_fact_sequence','UPDATE') AS update`)).rows[0]).toEqual({
      usage: false, read: false, update: false,
    })
    runner = new ScopedPostgresTransactionRunner(runtime)
    await fixtures.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'lock-order audit')", [scope.tenantId, scope.tenantId])
    await fixtures.query(`INSERT INTO mbox.stores(id,tenant_id,code,name,timezone,business_day_cutoff)
      VALUES($1,$2,'locks','lock-order audit','Asia/Shanghai','06:00')`, [scope.storeId, scope.tenantId])
    await fixtures.query(`INSERT INTO mbox.areas(id,tenant_id,store_id,code,name,area_type)
      VALUES($1,$2,$3,'A','Audit','indoor')`, [areaId, scope.tenantId, scope.storeId])
    businessDate = await runner.run(scope, async tx => (await tx.query<{ date: string }>(
      'SELECT mbox.current_operating_business_date($1,$2)::text date', [scope.tenantId, scope.storeId],
    )).rows[0]!.date)
  }, 30_000)

  afterAll(async () => {
    await runtime?.end()
    await fixtures?.end()
  })

  it.each(['callback', 'query'] as const)('serializes %s behind a session-then-order transaction without deadlock', async mode => {
    const tableId = randomUUID(), sessionId = randomUUID(), orderId = randomUUID()
    const paymentId = randomUUID(), paymentPublicId = randomUUID()
    await fixtures.query(`INSERT INTO mbox.tables(id,tenant_id,store_id,area_id,code,display_name,capacity)
      VALUES($1,$2,$3,$4,$5,$5,8)`, [tableId, scope.tenantId, scope.storeId, areaId, `T${tableId.replaceAll('-', '').slice(0, 12).toUpperCase()}`])
    await fixtures.query(`INSERT INTO mbox.table_sessions(id,tenant_id,store_id,table_id,public_id,business_date,guest_count)
      VALUES($1,$2,$3,$4,$5,$6,2)`, [sessionId, scope.tenantId, scope.storeId, tableId, sessionId, businessDate])
    await fixtures.query(`INSERT INTO mbox.orders(id,tenant_id,store_id,table_session_id,public_id,channel,status,submitted_at,subtotal_amount_minor,total_amount_minor)
      VALUES($1,$2,$3,$4,$5,'staff_assisted','submitted',clock_timestamp(),4000,4000)`, [orderId, scope.tenantId, scope.storeId, sessionId, orderId])
    await fixtures.query(`INSERT INTO mbox.payments(id,tenant_id,store_id,order_id,public_id,provider,method,amount_minor,status)
      VALUES($1,$2,$3,$4,$5,'postar','native_qr',4000,'pending')`, [paymentId, scope.tenantId, scope.storeId, orderId, paymentPublicId])

    // Refunds and table closure use this parent-first prefix. This connection
    // takes the parent first, then races the real provider-result repository.
    const other = await runtime.connect()
    let otherReleased = false, otherCommitted = false
    let releaseOrder!: () => void
    const continueRepository = new Promise<void>(resolve => { releaseOrder = resolve })
    let repositoryPid: number | undefined, orderAcquired = false
    let repositoryWork: Promise<{ ok: boolean; status?: string; code?: string }> | undefined
    try {
      await other.query('BEGIN')
      await other.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.store_id',$2,true)", [scope.tenantId, scope.storeId])
      await other.query("SET LOCAL statement_timeout='10s'")
      const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
      await other.query('SELECT id FROM mbox.table_sessions WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE', [scope.tenantId, scope.storeId, sessionId])

      repositoryWork = runner.run(scope, async tx => {
        await tx.query("SET LOCAL statement_timeout='10s'")
        repositoryPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
        const scheduled: ScopedTransaction = {
          scope,
          query: async <Row extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) => {
            const result = await tx.query<Row>(sql, args)
            // Hold an acquired order only to make a reverse dependency fully
            // deterministic on regressions; no production SQL/result is mocked.
            if (/FROM mbox\.orders\s+WHERE/.test(sql) && /FOR UPDATE/.test(sql) && !orderAcquired) {
              orderAcquired = true
              await continueRepository
            }
            return result
          },
        }
        const repository = new PaymentRepository(scheduled)
        const input = { paymentPublicId, provider: 'postar' as const, providerTransactionId: randomUUID(), reportedAmountMinor: 4000, reportedCurrency: 'CNY', succeededAt: new Date().toISOString() }
        return mode === 'callback' ? repository.applySucceededCallback(input)
          : repository.applyProviderQueryResult({ ...input, status: 'closed' })
      }).then(value => ({ ok: true, status: value.payment.status }), error => ({ ok: false, code: error.code ?? error.name }))

      let waitsForParent = false
      for (let attempt = 0; attempt < 150 && !orderAcquired; attempt += 1) {
        if (repositoryPid !== undefined) {
          const blockers = (await fixtures.query<{ ids: number[] }>('SELECT pg_blocking_pids($1) ids', [repositoryPid])).rows[0]!.ids
          if (blockers.includes(otherPid)) { waitsForParent = true; break }
        }
        await delay(20)
      }
      const heldOrderBeforeParent = orderAcquired
      // Start the actual competing order lock before releasing the repository.
      // The old implementation makes a cycle here; either side may be aborted.
      const competing = (async () => {
        try {
          await other.query('SELECT id FROM mbox.orders WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE', [scope.tenantId, scope.storeId, orderId])
          await other.query('COMMIT'); otherCommitted = true
          return { ok: true }
        } catch (error) {
          await other.query('ROLLBACK'); otherCommitted = true
          return { ok: false, code: (error as { code?: string }).code }
        }
      })()
      if (heldOrderBeforeParent) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await fixtures.query<{ ids: number[] }>('SELECT pg_blocking_pids($1) ids', [otherPid])).rows[0]!.ids.includes(repositoryPid!)) break
          await delay(10)
        }
      }
      releaseOrder()
      const [result, competingResult] = await Promise.all([repositoryWork, competing])
      expect({ heldOrderBeforeParent, waitsForParent }).toEqual({ heldOrderBeforeParent: false, waitsForParent: true })
      expect(competingResult).toEqual({ ok: true })
      expect(result).toEqual({ ok: true, status: mode === 'callback' ? 'succeeded' : 'closed' })
      expect((await fixtures.query('SELECT status FROM mbox.payments WHERE id=$1', [paymentId])).rows[0]!.status).toBe(mode === 'callback' ? 'succeeded' : 'closed')
    } finally {
      releaseOrder()
      if (!otherCommitted) await other.query('ROLLBACK')
      if (!otherReleased) { other.release(); otherReleased = true }
      await repositoryWork
    }
  })
})

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
