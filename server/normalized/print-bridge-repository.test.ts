import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { PrintBridgeRepository } from './print-bridge-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool, type ScopedTransaction } from './transaction-runner.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const bridgeId = '33333333-3333-4333-8333-333333333333'
const jobId = '44444444-4444-4444-8444-444444444444'
const commandId = '55555555-5555-4555-8555-555555555555'
const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip

describe('PrintBridgeRepository', () => {
  it('claims only bridge-pull jobs and printer commands assigned to this bridge', async () => {
    const transaction = new ScriptedTransaction([
      rows([{
        id: jobId, business_key: 'ticket:bar:order-1', printer_device_id: '66666666-6666-4666-8666-666666666666',
        printer_code: 'BAR-USB-01', printer_name: '吧台打印机', windows_queue_name: 'Gprinter GP-D802',
        print_profile: 'escpos_80', station_code: 'bar', copies: 1,
        print_snapshot: { schemaVersion: 1 }, contains_priority_note: false, attempts: 1,
      }]),
      rows([{
        id: commandId, public_id: 'hardware-command-test-1', device_id: '66666666-6666-4666-8666-666666666666',
        command_type: 'test_print', windows_queue_name: 'Gprinter GP-D802', print_profile: 'escpos_80',
        payload_snapshot: {}, attempts: 1,
      }]),
    ])
    const repository = new PrintBridgeRepository(transaction, 'unit-test-secret-value')

    await expect(repository.claim({ id: bridgeId, publicId: 'print-bridge-1234567890abcdef' }, 10)).resolves.toEqual({
      jobs: [expect.objectContaining({ id: jobId, businessKey: 'ticket:bar:order-1', windowsQueueName: 'Gprinter GP-D802' })],
      commands: [expect.objectContaining({ id: commandId, commandType: 'test_print' })],
    })
    expect(transaction.calls[0]?.sql).toContain("job.delivery_mode='bridge_pull'")
    expect(transaction.calls[0]?.sql).toContain('job.print_bridge_id=$3::uuid')
    expect(transaction.calls[0]?.sql).toContain("candidate_device.status='active'")
    expect(transaction.calls[1]?.sql).toContain("command.command_type IN ('test_print','reconnect','ping')")
    expect(transaction.calls[1]?.sql).toContain("device.status='active'")
  })

  it('acknowledges a leased print once and treats a repeated success report as replay', async () => {
    const transaction = new ScriptedTransaction([
      rows([{ status: 'printing', attempts: 1, max_attempts: 5 }]),
      rows([] as Record<string, unknown>[], 1),
      rows([] as Record<string, unknown>[], 1),
      rows([{ status: 'printed', attempts: 1, max_attempts: 5 }]),
    ])
    const repository = new PrintBridgeRepository(transaction, 'unit-test-secret-value')
    const bridge = { id: bridgeId, publicId: 'print-bridge-1234567890abcdef' }

    await expect(repository.recordPrintResult(bridge, { jobId, outcome: 'printed' }))
      .resolves.toEqual({ id: jobId, status: 'printed', replayed: false })
    await expect(repository.recordPrintResult(bridge, { jobId, outcome: 'printed' }))
      .resolves.toEqual({ id: jobId, status: 'printed', replayed: true })
    expect(transaction.calls[1]?.sql).toContain("status='printed'")
    expect(transaction.calls.filter((call) => call.sql.includes('INSERT INTO mbox.print_job_events'))).toHaveLength(1)
  })
})

postgresIt('executes the bridge claim SQL against normalized PostgreSQL', async () => {
  await runNormalizedMigrations(databaseUrl!)
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    await pool.query(`
      INSERT INTO mbox.tenants(id,code,name)
      VALUES($1::uuid,'print-bridge-repository-tenant','打印桥测试租户')
      ON CONFLICT(id) DO NOTHING
    `, [tenantId])
    await pool.query(`
      INSERT INTO mbox.stores(id,tenant_id,code,name)
      VALUES($1::uuid,$2::uuid,'print-bridge-repository-store','打印桥测试门店')
      ON CONFLICT(id) DO NOTHING
    `, [storeId, tenantId])
    await pool.query(`
      INSERT INTO mbox.print_bridges(
        id,tenant_id,store_id,public_id,name,secret_hash,hostname,software_version
      ) VALUES($1::uuid,$2::uuid,$3::uuid,'print-bridge-1234567890abcdef','门店打印桥',
        repeat('a',64),'MBOX-WINDOWS','1.0.0')
      ON CONFLICT(id) DO NOTHING
    `, [bridgeId, tenantId, storeId])
    const transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    const result = await transactions.run({ tenantId, storeId }, (transaction) => (
      new PrintBridgeRepository(transaction, 'integration-test-secret').claim({
        id: bridgeId,
        publicId: 'print-bridge-1234567890abcdef',
      }, 10)
    ))
    expect(result).toEqual({ jobs: [], commands: [] })
  } finally {
    await pool.end()
  }
}, 120_000)

interface Response { data: Record<string, unknown>[]; rowCount: number }
function rows(data: Record<string, unknown>[], rowCount = data.length): Response { return { data, rowCount } }

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  constructor(private readonly responses: Response[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql: text.replace(/\s+/g, ' ').trim(), values })
    const response = this.responses.shift()
    if (response === undefined) throw new Error(`Unexpected query: ${text}`)
    return { rows: response.data as Row[], rowCount: response.rowCount }
  }
}
