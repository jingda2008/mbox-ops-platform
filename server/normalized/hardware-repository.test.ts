import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runNormalizedMigrations } from '../migrate-normalized.js'
import { HardwarePolicyError, HardwareRepository } from './hardware-repository.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './transaction-runner.js'

const databaseUrl = process.env.TEST_NORMALIZED_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const scope = {
  tenantId: '26000000-0000-4000-8000-000000000001',
  storeId: '26000000-0000-4000-8000-000000000002',
}
const employeeId = '26000000-0000-4000-8000-000000000003'
const sourceId = '26000000-0000-4000-8000-000000000004'

describe('HardwareRepository policy', () => {
  it('rejects sensitive fields in device snapshots before database access', async () => {
    const repository = new HardwareRepository({
      scope,
      query: async () => { throw new Error('database should not be reached') },
    })
    await expect(repository.createDevice({
      code: 'bar-printer',
      name: '吧台打印机',
      deviceType: 'printer',
      configSnapshot: { accessToken: 'must-not-be-stored' },
    })).rejects.toBeInstanceOf(HardwarePolicyError)
  })
})

integration('HardwareRepository PostgreSQL', () => {
  let pool: Pool
  let transactions: ScopedPostgresTransactionRunner
  let barPrinterId: string
  let kitchenPrinterId: string

  beforeAll(async () => {
    await runNormalizedMigrations(databaseUrl!)
    pool = new Pool({ connectionString: databaseUrl, max: 8 })
    transactions = new ScopedPostgresTransactionRunner(pool as unknown as PostgresPool)
    await pool.query(`INSERT INTO mbox.tenants(id, code, name) VALUES ($1, 'hardware-tenant', 'Hardware Tenant')`, [scope.tenantId])
    await pool.query(`INSERT INTO mbox.stores(id, tenant_id, code, name) VALUES ($1, $2, 'hardware-store', 'Hardware Store')`, [scope.storeId, scope.tenantId])
    await pool.query(`
      INSERT INTO mbox.employees(id, tenant_id, store_id, employee_code, display_name)
      VALUES ($1, $2, $3, 'hardware-manager', '设备管理员')
    `, [employeeId, scope.tenantId, scope.storeId])
    await pool.query(`
      INSERT INTO mbox.outbox_messages(
        id, tenant_id, store_id, message_key, aggregate_type, aggregate_id,
        aggregate_version, message_type, payload
      ) VALUES ($1, $2, $3, 'hardware-print-source-0001', 'order', $4, 1,
        'order.item.submitted.v1', '{"orderItemId":"item-1"}'::jsonb)
    `, [sourceId, scope.tenantId, scope.storeId, employeeId])
    await transactions.run(scope, async (transaction) => {
      const repository = new HardwareRepository(transaction)
      barPrinterId = (await repository.createDevice({
        code: 'bar-printer-01', name: '吧台打印机', deviceType: 'printer', stationCode: 'bar',
      })).id
      kitchenPrinterId = (await repository.createDevice({
        code: 'kitchen-printer-01', name: '后厨打印机', deviceType: 'printer', stationCode: 'kitchen',
      })).id
      await repository.upsertPrinterRoute({
        code: 'bar-default', name: '吧台默认', stationCode: 'bar', printerDeviceId: barPrinterId,
      })
      await repository.upsertPrinterRoute({
        code: 'kitchen-snack', name: '后厨小吃', stationCode: 'kitchen',
        productCategoryCode: 'snack', printerDeviceId: kitchenPrinterId,
      })
    })
  })

  afterAll(async () => pool?.end())

  it('materializes a server snapshot from Outbox once and routes by station/category', async () => {
    const input = {
      sourceOutboxMessageId: sourceId,
      stationCode: 'kitchen' as const,
      productCategoryCode: 'snack',
      sourceType: 'kds' as const,
      sourceReference: 'order-item-001',
      printSnapshot: {
        tableCode: 'VIP1', productName: '小食拼盘', quantity: 1,
        note: '不要辣', noteStyle: 'priority',
      },
      containsPriorityNote: true,
    }
    const first = await transactions.run(scope, (transaction) => (
      new HardwareRepository(transaction).materializeFromOutbox(input)
    ))
    const replay = await transactions.run(scope, (transaction) => (
      new HardwareRepository(transaction).materializeFromOutbox(input)
    ))

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      printerDeviceId: kitchenPrinterId,
      stationCode: 'kitchen',
      productCategoryCode: 'snack',
      containsPriorityNote: true,
    })
    expect(replay[0]?.id).toBe(first[0]?.id)
    const evidence = await pool.query<{ jobs: string; events: string }>(`
      SELECT
        (SELECT count(*)::text FROM mbox.print_jobs WHERE source_outbox_message_id = $1) AS jobs,
        (SELECT count(*)::text
         FROM mbox.print_job_events AS event
         JOIN mbox.print_jobs AS job
           ON job.tenant_id = event.tenant_id AND job.store_id = event.store_id
          AND job.id = event.print_job_id
         WHERE job.source_outbox_message_id = $1) AS events
    `, [sourceId])
    expect(evidence.rows[0]).toEqual({ jobs: '1', events: '1' })
  })

  it('keeps bar and kitchen work separated', async () => {
    const result = await transactions.run(scope, async (transaction) => {
      const repository = new HardwareRepository(transaction)
      return {
        bar: await repository.listPrintJobs({ stations: ['bar'] }),
        kitchen: await repository.listPrintJobs({ stations: ['kitchen'] }),
      }
    })
    expect(result.bar).toHaveLength(0)
    expect(result.kitchen).toHaveLength(1)
  })
})
