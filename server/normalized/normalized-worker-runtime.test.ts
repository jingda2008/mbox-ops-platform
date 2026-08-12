import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiScheduledExecutionPort } from './ai-capability-center.js'
import {
  NormalizedWorkerAdapterConfigurationError,
  NormalizedWorkerHealthTracker,
  REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES,
  createNormalizedWorkerRuntime,
  loadNormalizedWorkerAdapters,
  type NormalizedWorkerAdapters,
} from './normalized-worker-runtime.js'
import { ScopedPostgresTransactionRunner, type PostgresPoolClient } from './transaction-runner.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000001',
  storeId: '91000000-0000-4000-8000-000000000002',
}
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('NormalizedWorkerRuntime', () => {
  it('assembles every normalized worker and isolates a reservation worker failure', async () => {
    const errors: string[] = []
    const transactions = fakeTransactions((sql) => {
      if (sql.includes('FROM mbox.reservations AS reservation')) {
        throw new Error('reservation database path unavailable')
      }
      return emptyOrStoreClock(sql)
    })
    const runtime = createNormalizedWorkerRuntime({
      scope,
      workerId: 'normalized-worker-test',
      intervalMs: 1_000,
      hashSecret: '0123456789abcdef0123456789abcdef',
      transactions,
      aiExecutions: aiExecutions(),
      adapters: adapters(),
      onError: (worker) => errors.push(worker),
    })

    const result = await runtime.runOnce()

    expect(result.failures).toEqual(['reservation-expiry'])
    expect(result.workers.serviceSla).not.toBeNull()
    expect(result.workers.businessDay?.businessDate).toBe('2026-08-11')
    expect(result.workers.sop).not.toBeNull()
    expect(result.workers.aiScheduled).not.toBeNull()
    expect(result.workers.print).not.toBeNull()
    expect(result.workers.outbox).not.toBeNull()
    expect(result.workers.notification).not.toBeNull()
    expect(errors).toEqual(['reservation-expiry'])
  })

  it('waits for an in-flight cycle during graceful shutdown and is safe to stop twice', async () => {
    let release: (() => void) | undefined
    let serviceQueryStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { serviceQueryStarted = resolve })
    const pending = new Promise<void>((resolve) => { release = resolve })
    const transactions = fakeTransactions(async (sql) => {
      if (sql.includes('FROM mbox.service_tasks AS task')) {
        serviceQueryStarted?.()
        await pending
      }
      return emptyOrStoreClock(sql)
    })
    const runtime = createNormalizedWorkerRuntime({
      scope,
      workerId: 'normalized-worker-test',
      intervalMs: 60_000,
      hashSecret: '0123456789abcdef0123456789abcdef',
      transactions,
      aiExecutions: aiExecutions(),
      adapters: adapters(),
    })

    runtime.start()
    await started
    let stopped = false
    const stopping = runtime.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release?.()
    await stopping
    expect(stopped).toBe(true)
    await expect(runtime.stop()).resolves.toBeUndefined()
  })

  it('rejects incomplete adapters instead of installing success placeholders', () => {
    expect(() => createNormalizedWorkerRuntime({
      scope,
      workerId: 'normalized-worker-test',
      intervalMs: 1_000,
      hashSecret: '0123456789abcdef0123456789abcdef',
      transactions: fakeTransactions(emptyOrStoreClock),
      aiExecutions: aiExecutions(),
      adapters: { preflight: async () => undefined } as unknown as NormalizedWorkerAdapters,
    })).toThrowError(NormalizedWorkerAdapterConfigurationError)
  })

  it('runs database-only maintenance without claiming SOP, print, outbox, or notification work', async () => {
    const sql: string[] = []
    const runtime = createNormalizedWorkerRuntime({
      scope,
      workerId: 'normalized-core-worker',
      intervalMs: 1_000,
      hashSecret: '0123456789abcdef0123456789abcdef',
      transactions: fakeTransactions((statement) => {
        sql.push(statement)
        return emptyOrStoreClock(statement)
      }),
      aiExecutions: aiExecutions(),
      adapters: null,
    })

    const result = await runtime.runOnce()

    expect(result.failures).toEqual([])
    expect(result.workers.serviceSla).not.toBeNull()
    expect(result.workers.reservationExpiry).not.toBeNull()
    expect(result.workers.businessDay).not.toBeNull()
    expect(result.workers.aiScheduled).not.toBeNull()
    expect(result.workers.sop).toBeNull()
    expect(result.workers.print).toBeNull()
    expect(result.workers.outbox).toBeNull()
    expect(result.workers.notification).toBeNull()
    expect(sql.some((statement) => statement.includes('FROM mbox.sop_step_executions'))).toBe(false)
    expect(sql.some((statement) => statement.includes('FROM mbox.outbox_messages'))).toBe(false)
    expect(sql.some((statement) => statement.includes('FROM mbox.notifications'))).toBe(false)
    expect(sql.some((statement) => statement.includes('FROM mbox.print_jobs'))).toBe(false)
  })
})

describe('NormalizedWorkerHealthTracker', () => {
  it('reports startup, healthy cycles, failures, and stale workers without hiding integration status', () => {
    const tracker = new NormalizedWorkerHealthTracker(2_000, false)
    expect(tracker.snapshot(0)).toMatchObject({ status: 'starting', integrationWorkersEnabled: false })
    tracker.report({
      startedAt: '2026-08-12T00:00:00.000Z',
      completedAt: '2026-08-12T00:00:01.000Z',
      workers: {
        serviceSla: null, reservationExpiry: null, idempotencyCleanup: null,
        staffLoginRateLimitCleanup: null, businessDay: null, sop: null,
        aiScheduled: null, print: null, outbox: null, notification: null,
      },
      failures: [],
    })
    const completed = Date.parse('2026-08-12T00:00:01.000Z')
    expect(tracker.snapshot(completed + 5_000).status).toBe('healthy')
    expect(tracker.snapshot(completed + 10_001).status).toBe('degraded')

    tracker.report({
      startedAt: '2026-08-12T00:00:02.000Z',
      completedAt: '2026-08-12T00:00:03.000Z',
      workers: {
        serviceSla: null, reservationExpiry: null, idempotencyCleanup: null,
        staffLoginRateLimitCleanup: null, businessDay: null, sop: null,
        aiScheduled: null, print: null, outbox: null, notification: null,
      },
      failures: ['business-day'],
    })
    expect(tracker.snapshot(Date.parse('2026-08-12T00:00:04.000Z'))).toMatchObject({
      status: 'degraded', failures: ['business-day'],
    })
  })
})

describe('loadNormalizedWorkerAdapters', () => {
  it('loads and preflights an explicitly configured adapter module', async () => {
    const path = await adapterModule(`
      export async function createNormalizedWorkerAdapters(context) {
        if (!context.scope.storeId) throw new Error('scope missing')
        return {
          capabilities: ['outbox.deliver', 'notification.deliver', 'print.deliver', 'sop.execute', 'payment.create.postar', 'refund.execute.postar'],
          preflight: async () => undefined,
          outbox: async () => undefined,
          notification: async () => undefined,
          print: { print: async () => undefined },
          sop: { execute: async () => ({ state: 'completed' }) }
        }
      }
    `)
    const loaded = await loadNormalizedWorkerAdapters(path, {
      scope,
      commitSha: 'abcdef1234567',
      schemaFlavor: 'normalized-core-v1',
    })
    expect(typeof loaded.outbox).toBe('function')
    expect(typeof loaded.print.print).toBe('function')
  })

  it('fails closed on adapter preflight without leaking the provider error text', async () => {
    const path = await adapterModule(`
      export async function createNormalizedWorkerAdapters() {
        return {
          capabilities: ['outbox.deliver', 'notification.deliver', 'print.deliver', 'sop.execute', 'payment.create.postar', 'refund.execute.postar'],
          preflight: async () => { throw new Error('provider-secret-detail') },
          outbox: async () => undefined,
          notification: async () => undefined,
          print: { print: async () => undefined },
          sop: { execute: async () => ({ state: 'completed' }) }
        }
      }
    `)
    await expect(loadNormalizedWorkerAdapters(path, {
      scope,
      commitSha: 'abcdef1234567',
      schemaFlavor: 'normalized-core-v1',
    })).rejects.toMatchObject({
      name: 'NormalizedWorkerAdapterConfigurationError',
      message: expect.not.stringContaining('provider-secret-detail'),
    })
  })

  it('rejects an adapter that omits payment or refund execution capabilities', async () => {
    const path = await adapterModule(`
      export async function createNormalizedWorkerAdapters() {
        return {
          capabilities: ['outbox.deliver', 'notification.deliver', 'print.deliver', 'sop.execute'],
          preflight: async () => undefined,
          outbox: async () => undefined,
          notification: async () => undefined,
          print: { print: async () => undefined },
          sop: { execute: async () => ({ state: 'completed' }) }
        }
      }
    `)
    await expect(loadNormalizedWorkerAdapters(path, {
      scope,
      commitSha: 'abcdef1234567',
      schemaFlavor: 'normalized-core-v1',
    })).rejects.toMatchObject({
      name: 'NormalizedWorkerAdapterConfigurationError',
      message: expect.stringContaining('invalid_contract'),
    })
  })
})

function adapters(): NormalizedWorkerAdapters {
  return {
    capabilities: REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES,
    preflight: vi.fn(async () => undefined),
    outbox: vi.fn(async () => undefined),
    notification: vi.fn(async () => undefined),
    print: { print: vi.fn(async () => undefined) },
    sop: { execute: vi.fn(async () => ({ state: 'completed' as const })) },
  }
}

function aiExecutions(): AiScheduledExecutionPort {
  return { executeClaimedScheduled: vi.fn(async () => 'succeeded') }
}

function fakeTransactions(
  respond: (sql: string) => Promise<Readonly<{ rows: Record<string, unknown>[]; rowCount: number }>>
    | Readonly<{ rows: Record<string, unknown>[]; rowCount: number }>,
): ScopedPostgresTransactionRunner {
  const client: PostgresPoolClient = {
    query: async <Row extends Record<string, unknown>>(sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config('app.tenant_id'")) {
        return { rows: [] as Row[], rowCount: 0 }
      }
      const result = await respond(sql)
      return { rows: result.rows as Row[], rowCount: result.rowCount }
    },
    release: vi.fn(),
  }
  return new ScopedPostgresTransactionRunner({
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  })
}

function emptyOrStoreClock(sql: string) {
  if (sql.includes('AS business_date') && sql.includes('FROM mbox.stores')) {
    return {
      rows: [{ business_date: '2026-08-11', timezone: 'Asia/Shanghai', cutoff: '06:00:00' }],
      rowCount: 1,
    }
  }
  return { rows: [], rowCount: 0 }
}

async function adapterModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mbox-worker-adapter-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'adapter.mjs')
  await writeFile(path, source, 'utf8')
  return path
}
