import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner } from './transaction-runner.js'
import { NormalizedCommandExecutor } from './command-executor.js'
import { hardwareApiPlugin } from './hardware-api.js'
import { HardwareRepository } from './hardware-repository.js'
import { StaffAccessRepository } from './staff-access-repository.js'
import { ProfitQueryService } from './profit-query-service.js'
import { buildOperatingReportLines } from './operating-report-format.js'
import { assertRuntimeDatabasePool } from './runtime-database-identity.js'

const database = process.env.TEST_NORMALIZED_DATABASE_URL, runtimeUrl = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
;(database && runtimeUrl ? describe : describe.skip)('operating report printing with restricted PostgreSQL', () => {
  const scope = { tenantId: randomUUID(), storeId: randomUUID() }
  const employeeId = randomUUID(), roleId = randomUUID()
  let admin: Pool, runtime: Pool, runner: ScopedPostgresTransactionRunner, app: FastifyInstance, executor: NormalizedCommandExecutor
  let date: string, printerId: string
  const key = randomUUID()
  let receipt: { requestId: string; jobIds: string[] }
  const send = (requestKey = key, anchorDate = date) => app.inject({ method: 'POST', url: '/hardware/operating-report',
    headers: { 'idempotency-key': requestKey }, payload: { period: 'day', anchorDate } })
  beforeAll(async () => {
    await runNormalizedMigrations(database!)
    admin = new Pool({ connectionString: database }); runtime = new Pool({ connectionString: runtimeUrl })
    await assertRuntimeDatabasePool(runtime, runtimeUrl!)
    runner = new ScopedPostgresTransactionRunner(runtime); executor = new NormalizedCommandExecutor(runner)
    await admin.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1::uuid,$1::text,'Report fixture')", [scope.tenantId])
    await admin.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1::uuid,$2,$1::text,'Report fixture')", [scope.storeId, scope.tenantId])
    await admin.query("INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,'REPORT','经营查看')", [employeeId, scope.tenantId, scope.storeId])
    await admin.query("INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,'REPORT_TEST','经营查看')", [roleId, scope.tenantId, scope.storeId])
    await admin.query('INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id) VALUES($1,$2,$3,$4)', [scope.tenantId, scope.storeId, employeeId, roleId])
    await admin.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT tenant_id,store_id,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2
        AND code=ANY($4::text[]) ON CONFLICT DO NOTHING`, [scope.tenantId, scope.storeId, roleId,
      ['commercial.profit.view', 'order.bill.print', 'order.history.all', 'print.view_all', 'print.reprint']])
    date = (await runner.run(scope, tx => tx.query<{ date: string }>('SELECT mbox.current_operating_business_date($1,$2)::text AS date', [scope.tenantId, scope.storeId]))).rows[0]!.date
    await runner.run(scope, async tx => {
      const hardware = new HardwareRepository(tx)
      printerId = (await hardware.createDevice({ code: 'report-printer', name: '收银', deviceType: 'printer', stationCode: 'cashier' })).id
      await hardware.upsertPrinterRoute({ code: 'report-route', name: '收银汇总', stationCode: 'cashier', printerDeviceId: printerId, copies: 1 })
    })
    app = Fastify()
    await app.register(hardwareApiPlugin, { transactions: runner, commands: executor, resolveContext: async () => {
      const access = await runner.run(scope, tx => new StaffAccessRepository(tx).resolve(employeeId))
      return { scope, employeeId, businessDate: date, capabilities: access.permissions }
    } })
    await app.ready()
  })
  afterAll(async () => { await app?.close(); await runtime?.end(); await admin?.end() })

  it('opts report commands into repeatable read without changing other commands', async () => {
    for (const isolation of [undefined, 'repeatable-read'] as const) {
      const result = await executor.execute({ scope, operationScope: 'test.report.isolation', idempotencyKey: randomUUID(), requestFingerprint: 'isolation',
        transactionIsolation: isolation, resultCodec: { encode: value => String(value), decode: value => String(value) } },
      async tx => ({ result: (await tx.query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level")).rows[0]!.level, auditEvents: [], outboxMessages: [] }))
      expect(result.value).toBe(isolation === undefined ? 'read committed' : 'repeatable read')
    }
  })
  it('creates a compact cashier ticket once and retains the original receipt indefinitely', async () => {
    const first = await send(); expect(first.statusCode, first.body).toBe(202)
    receipt = first.json().data
    expect(receipt.jobIds).toHaveLength(1)
    const repeated = await send(); expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json()).toMatchObject({ data: receipt, replayed: true })
    const jobs = await admin.query('SELECT station_code,print_snapshot FROM mbox.print_jobs WHERE id=ANY($1::uuid[])', [receipt.jobIds])
    expect(jobs.rows).toHaveLength(1)
    expect(jobs.rows[0].station_code).toBe('cashier')
    const report = await new ProfitQueryService(runner).getProfitReport(scope, 'day', date)
    expect(jobs.rows[0].print_snapshot.lines.slice(0, 7)).toEqual(buildOperatingReportLines(report).slice(0, 7).map(line => ({ ...line, note: line.note ?? null, unitAmountMinor: null, totalAmountMinor: null })))
    expect(JSON.stringify(jobs.rows[0].print_snapshot)).toContain('按已入账数据计算')
    expect((await admin.query("SELECT expires_at::text AS expiry FROM mbox.idempotency_records WHERE operation_scope='operating.report.print' AND idempotency_key=$1", [key])).rows[0].expiry).toBe('infinity')
    expect((await app.inject(`/hardware/print-requests/${receipt.requestId}`)).statusCode).toBe(200)
  })
  it('rejects stale authority even when replaying and preserves old daily-report permissions', async () => {
    await admin.query(`DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p
      WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code='order.bill.print'`, [roleId])
    expect((await send()).statusCode).toBe(403)
    await admin.query(`INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
      SELECT tenant_id,store_id,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code='order.bill.print'`, [scope.tenantId, scope.storeId, roleId])
    expect((await send()).json()).toMatchObject({ replayed: true, data: receipt })
    const old = await app.inject({ method: 'POST', url: `/hardware/business-days/${date}/report`, payload: {}, headers: { 'idempotency-key': randomUUID() } })
    expect(old.statusCode, old.body).toBe(403)
  })
  it('keeps historical and future period boundaries instead of silently expanding print access', async () => {
    await admin.query(`DELETE FROM mbox.role_permission_assignments a USING mbox.staff_permission_definitions p
      WHERE a.permission_id=p.id AND a.role_id=$1 AND p.code='order.history.all'`, [roleId])
    expect((await send(randomUUID(), '2000-01-01')).statusCode).toBe(400)
    expect((await send(randomUUID(), '2999-01-01')).statusCode).toBe(400)
  })
  it('counts more than 100 failed print jobs without reading only the list page', async () => {
    const original = (await admin.query('SELECT * FROM mbox.print_jobs WHERE id=$1', [receipt.jobIds[0]])).rows[0]
    await admin.query(`INSERT INTO mbox.print_jobs(tenant_id,store_id,source_outbox_message_id,printer_device_id,station_code,
      source_type,source_reference,business_key,copies,status,print_snapshot,printer_route_id)
      SELECT $1,$2,$3,$4,'cashier','cashier','summary-'||n,'summary-'||n,1,'failed',$5::jsonb,$6 FROM generate_series(1,105) n`,
    [scope.tenantId, scope.storeId, original.source_outbox_message_id, printerId, JSON.stringify(original.print_snapshot), original.printer_route_id])
    const summary = await app.inject('/hardware/print-jobs/summary')
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json().data).toMatchObject({ total: 105, action: 105, waiting: 0 })
    const list = await app.inject('/hardware/print-jobs?status=failed&limit=100')
    expect(list.json().data).toHaveLength(100)
  })
})
