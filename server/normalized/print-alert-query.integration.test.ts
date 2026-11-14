import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'
import { HardwareRepository } from './hardware-repository.js'
import { readPrintAlerts } from './print-alert-query.js'
import { hardwareApiPlugin } from './hardware-api.js'
import { NormalizedCommandExecutor } from './command-executor.js'

const database = process.env.TEST_NORMALIZED_DATABASE_URL, runtimeDatabase = process.env.TEST_NORMALIZED_RUNTIME_DATABASE_URL
const suite = database && runtimeDatabase ? describe : describe.skip
suite('print alerts on a restricted PostgreSQL login', () => {
  const scope = {tenantId: randomUUID(), storeId: randomUUID()}
  const employees = {bar: randomUUID(), delivery: randomUUID(), manager: randomUUID(), denied: randomUUID()}
  let owner: Pool, runtime: Pool, tx: ScopedPostgresTransactionRunner
  const read = (employee = employees.manager) => tx.run(scope, t => readPrintAlerts(t, employee), {readOnly: true})
  beforeAll(async () => {
    await runNormalizedMigrations(database!)
    owner = new Pool({connectionString: database}); runtime = new Pool({connectionString: runtimeDatabase})
    tx = new ScopedPostgresTransactionRunner(runtime as unknown as PostgresPool)
    await owner.query("INSERT INTO mbox.tenants(id,code,name) VALUES($1,$2,'Print alert test')", [scope.tenantId, 'alerts-' + scope.tenantId])
    await owner.query("INSERT INTO mbox.stores(id,tenant_id,code,name) VALUES($1,$2,'alerts','Print alerts')", [scope.storeId, scope.tenantId])
    for (const [name, employee] of Object.entries(employees)) {
      const role = randomUUID(), permission = {bar: 'work.bar', delivery: 'work.delivery', manager: 'printer.manage', denied: null}[name]
      await owner.query('INSERT INTO mbox.employees(id,tenant_id,store_id,employee_code,display_name) VALUES($1,$2,$3,$4,$4)', [employee, scope.tenantId, scope.storeId, name])
      await owner.query('INSERT INTO mbox.roles(id,tenant_id,store_id,code,name) VALUES($1,$2,$3,$4,$4)', [role, scope.tenantId, scope.storeId, 'ALERT_' + name.toUpperCase()])
      await owner.query("INSERT INTO mbox.employee_roles(tenant_id,store_id,employee_id,role_id,starts_at) VALUES($1,$2,$3,$4,'2020-01-01')", [scope.tenantId, scope.storeId, employee, role])
      if (permission) {
        await owner.query('INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING', [scope.tenantId, scope.storeId, permission])
        await owner.query('INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id) SELECT $1,$2,$3,id FROM mbox.staff_permission_definitions WHERE tenant_id=$1 AND store_id=$2 AND code=$4', [scope.tenantId, scope.storeId, role, permission])
      }
    }
    await tx.run(scope, async t => {
      const repo = new HardwareRepository(t)
      for (const station of ['bar', 'kitchen', 'cashier'] as const) {
        const device = await repo.createDevice({code: `alerts-${station}`, name: station, deviceType: 'printer', stationCode: station})
        await repo.upsertPrinterRoute({code: `alerts-${station}`, name: station, stationCode: station, printerDeviceId: device.id})
      }
    })
  })
  afterAll(async () => { await runtime?.end(); await owner?.end() })
  beforeEach(async () => {
    await owner.query("UPDATE mbox.print_jobs SET status='cancelled',cancelled_at=clock_timestamp(),dead_at=NULL,printed_at=NULL,locked_by=NULL,locked_at=NULL WHERE tenant_id=$1 AND store_id=$2 AND status<>'cancelled'", [scope.tenantId, scope.storeId])
    await owner.query("UPDATE mbox.print_source_jobs SET status='skipped' WHERE tenant_id=$1 AND store_id=$2", [scope.tenantId, scope.storeId])
    await owner.query("UPDATE mbox.print_incidents SET status='resolved',claimed_by=$3,resolved_at=clock_timestamp() WHERE tenant_id=$1 AND store_id=$2", [scope.tenantId, scope.storeId, employees.manager])
  })
  async function job(station: 'bar' | 'kitchen' | 'cashier' = 'bar') {
    const source = randomUUID()
    await owner.query("INSERT INTO mbox.outbox_messages(id,tenant_id,store_id,message_key,aggregate_type,aggregate_id,aggregate_version,message_type,payload) VALUES($1::uuid,$2,$3,$1::uuid::text,'order',$1::uuid,1,'print.test.v1','{}')", [source, scope.tenantId, scope.storeId])
    const jobs = await tx.run(scope, t => new HardwareRepository(t).materializeFromOutbox({sourceOutboxMessageId: source, stationCode: station,
      sourceType: 'order', sourceReference: 'private-order-reference', printSnapshot: {tableCode: 'PRIVATE', productName: 'private product', quantity: 1}}))
    return {id: jobs[0]!.id, source}
  }
  async function fail(id: string, minutes = 0) {
    await owner.query("UPDATE mbox.print_jobs SET status='dead',dead_at=clock_timestamp(),last_error_code='ambiguous_print_result' WHERE id=$1", [id])
    await owner.query("INSERT INTO mbox.print_job_events(tenant_id,store_id,print_job_id,event_type,to_status,actor_type,occurred_at) VALUES($1,$2,$3,'dead','dead','system',clock_timestamp()-make_interval(mins=>$4))", [scope.tenantId, scope.storeId, id, minutes])
  }
  it('returns minimal station counts to servers and rechecks current permissions', async () => {
    for (const station of ['bar', 'kitchen', 'cashier'] as const) await fail((await job(station)).id)
    expect((await read(employees.bar)).alerts.map(a => a.station)).toEqual(['bar'])
    expect((await read(employees.delivery)).alerts.map(a => a.station)).toEqual(['bar', 'kitchen'])
    const all = await read()
    expect(all.alerts).toHaveLength(3); expect(all.manager).toBe(true)
    expect(JSON.stringify(all)).not.toMatch(/PRIVATE|private|productName|sourceReference/)
    await expect(read(employees.denied)).rejects.toThrow('当前岗位无打印提醒查看权限')
    await expect(tx.run({tenantId: randomUUID(), storeId: randomUUID()}, t => readPrintAlerts(t, employees.manager), {readOnly: true})).rejects.toThrow()
    expect((await runtime.query('SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolcanlogin: true, rolsuper: false, rolbypassrls: false})
  })
  it('alerts on stalled jobs after 90 seconds and escalates failures after three minutes', async () => {
    const pending = await job(), failed = await job('kitchen')
    await owner.query("UPDATE mbox.print_jobs SET created_at=clock_timestamp()-interval '100 seconds',available_at=clock_timestamp()-interval '100 seconds' WHERE id=$1", [pending.id])
    await fail(failed.id, 6)
    const result = await read()
    expect(result.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({station: 'bar', stalled: 1, failed: 0, escalated: false}),
      expect.objectContaining({station: 'kitchen', stalled: 0, failed: 1, escalated: true}),
    ]))
    await job('cashier')
    expect((await read()).alerts.some(a => a.station === 'cashier')).toBe(false)
  })
  it('does not alarm on deliberately scheduled work or a freshly claimed old job', async () => {
    const scheduled = await job(), printing = await job('kitchen')
    await owner.query("UPDATE mbox.print_jobs SET created_at=clock_timestamp()-interval '1 day',available_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [scheduled.id])
    await owner.query("UPDATE mbox.print_jobs SET created_at=clock_timestamp()-interval '1 day',status='printing',locked_by='isolated-test',locked_at=clock_timestamp() WHERE id=$1", [printing.id])
    expect((await read()).alerts).toEqual([])
  })
  it('clears recovered and successfully reprinted work without mutating the original', async () => {
    const original = await job(), replacement = await job()
    await fail(original.id)
    await owner.query("UPDATE mbox.print_jobs SET status='printed',printed_at=clock_timestamp(),reprint_of_job_id=$2,reprint_reason='isolated verified replacement' WHERE id=$1", [replacement.id, original.id])
    expect((await read()).alerts).toEqual([])
    expect((await owner.query('SELECT status FROM mbox.print_jobs WHERE id=$1', [original.id])).rows[0].status).toBe('dead')
    const recovered = await job('cashier'); await fail(recovered.id)
    expect((await read()).alerts).toHaveLength(1)
    await owner.query("UPDATE mbox.print_jobs SET status='printed',printed_at=clock_timestamp(),dead_at=NULL WHERE id=$1", [recovered.id])
    expect((await read()).alerts).toEqual([])
  })
  it('shows ticket generation failures only to managers', async () => {
    const source = (await job()).source
    await owner.query("INSERT INTO mbox.print_source_jobs(tenant_id,store_id,source_outbox_message_id,aggregate_id,ticket_kind,status) VALUES($1,$2,$3,$3,'production','dead')", [scope.tenantId, scope.storeId, source])
    expect((await read()).alerts).toEqual([expect.objectContaining({station: 'generation', failed: 1, escalated: false})])
    expect((await read(employees.delivery)).alerts).toEqual([])
  })
  it('keeps claimed incidents visible until paper verification and identifies a new episode', async () => {
    const original = await job(), bridge = randomUUID(), incident = randomUUID()
    await fail(original.id)
    await owner.query("INSERT INTO mbox.print_bridges(id,tenant_id,store_id,public_id,name,secret_hash,hostname,platform,software_version) VALUES($1,$2,$3,$4,'Local diagnostics',repeat('a',64),'local','windows','test')", [bridge, scope.tenantId, scope.storeId, `print-bridge-${bridge}`])
    await owner.query("INSERT INTO mbox.print_incidents(id,tenant_id,store_id,bridge_id,incident_key,job_id,kind,status,claimed_by,first_seen_at,last_seen_at,episode_started_at) VALUES($1,$2,$3,$4,'test-incident',$5,'print_ambiguous','claimed',$6,clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '4 minutes')", [incident, scope.tenantId, scope.storeId, bridge, original.id, employees.manager])
    const before = (await read()).alerts.find(a => a.station === 'diagnostics')!
    expect(before).toMatchObject({failed: 1, escalated: true})
    expect((await read(employees.delivery)).alerts.some(a => a.station === 'diagnostics')).toBe(false)
    await owner.query("UPDATE mbox.print_incidents SET status='resolved',resolution='paper_confirmed',resolved_at=clock_timestamp() WHERE id=$1", [incident])
    expect((await read()).alerts).toEqual([])
    await owner.query("UPDATE mbox.print_incidents SET status='open',claimed_by=NULL,resolution=NULL,resolved_at=NULL,episode_started_at=clock_timestamp() WHERE id=$1", [incident])
    const after = (await read()).alerts.find(a => a.station === 'diagnostics')!
    expect(after.escalated).toBe(false)
    expect(after.newestKey).not.toBe(before.newestKey)
  })
  it('exposes the authenticated API without caching and rejects unrelated staff', async () => {
    let who = employees.manager
    const app = Fastify()
    await app.register(hardwareApiPlugin, {transactions: tx, commands: new NormalizedCommandExecutor(tx),
      resolveContext: () => ({scope, employeeId: who, capabilities: [], roleCodes: [], businessDate: '2026-11-14'})})
    try {
      const response = await app.inject('/hardware/print-alerts')
      expect(response.statusCode, response.body).toBe(200)
      expect(response.headers['cache-control']).toBe('private, no-store')
      who = employees.denied
      expect((await app.inject('/hardware/print-alerts')).statusCode).toBe(403)
    } finally { await app.close() }
  })
})
