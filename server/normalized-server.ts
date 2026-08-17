import { createNormalizedApp } from './normalized/normalized-app.js'
import { Pool } from 'pg'
import { loadNormalizedRuntimeConfig } from './normalized/normalized-runtime-config.js'
import {
  NormalizedWorkerHealthTracker,
  createNormalizedWorkerRuntime,
  loadNormalizedWorkerAdapters,
  type NormalizedWorkerRuntime,
} from './normalized/normalized-worker-runtime.js'
import { ScopedPostgresTransactionRunner, type PostgresPool } from './normalized/transaction-runner.js'
import { PostgresWechatIdentityRepository } from './wechat-production-adapters.js'
import type { PostgresPool as WechatPostgresPool } from './postgres-repository.js'
import { OfficialWechatSubscriptionMessageAdapter } from './normalized/wechat-subscription-message-adapter.js'

async function main(): Promise<void> {
  const config = loadNormalizedRuntimeConfig()
  const adapters = config.startWorkers && config.workerAdapterModule !== null
    ? await loadNormalizedWorkerAdapters(config.workerAdapterModule, {
        scope: { tenantId: config.tenantId, storeId: config.storeId },
        commitSha: config.commitSha,
        schemaFlavor: config.schemaFlavor,
      })
    : null
  const workerHealth = config.startWorkers
    ? new NormalizedWorkerHealthTracker(
        config.workerIntervalMs,
        adapters !== null,
        adapters?.capabilities ?? [],
      )
    : null
  const appConfig = config.startWorkers ? Object.freeze({ ...config, startWorkers: false }) : config
  const runtime = await createNormalizedApp({
    config: appConfig,
    ...(workerHealth === null ? {} : { workerHealth }),
  })
  let workers: NormalizedWorkerRuntime | null = null
  let workerPool: PostgresPool | null = null
  let stopping: Promise<void> | null = null
  const stop = (signal: NodeJS.Signals) => {
    if (stopping !== null) return stopping
    runtime.app.log.info({ signal }, 'normalized service shutdown started')
    stopping = shutdownRuntime(workers, workerPool, () => runtime.app.close()).catch((error: unknown) => {
      runtime.app.log.error({ errorCode: safeErrorCode(error) }, 'normalized service shutdown failed')
      process.exitCode = 1
    })
    return stopping
  }

  process.once('SIGINT', () => { void stop('SIGINT') })
  process.once('SIGTERM', () => { void stop('SIGTERM') })
  try {
    if (config.startWorkers) {
      const workerId = config.workerId
      if (workerId === null) throw new Error('Worker configuration invariant failed')
      const nativeWorkerPool = new Pool({
        connectionString: config.databaseUrl,
        max: config.workerPoolMax,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        application_name: `mbox-normalized-worker:${config.commitSha.slice(0, 16)}`,
      })
      nativeWorkerPool.on('error', (error) => {
        runtime.app.log.error({ errorCode: safeErrorCode(error) }, 'normalized worker database pool idle client failed')
      })
      workerPool = nativeWorkerPool as unknown as PostgresPool
      const wechatLoyaltyNotification = config.wechatIdentity === null || config.wechatNotification === null
        ? null
        : {
            recipients: new PostgresWechatIdentityRepository({
              pool: workerPool as unknown as WechatPostgresPool,
              tenantId: config.tenantId,
              storeId: config.storeId,
              appId: config.wechatIdentity.appId,
              activeKeyVersion: config.wechatIdentity.encryptionKeyVersion,
              encryptionKeys: new Map([[
                config.wechatIdentity.encryptionKeyVersion,
                config.wechatIdentity.encryptionKey,
              ]]),
            }),
            delivery: new OfficialWechatSubscriptionMessageAdapter({
              appId: config.wechatIdentity.appId,
              appSecret: config.wechatIdentity.appSecret,
            }),
          }
      workers = createNormalizedWorkerRuntime({
        scope: { tenantId: config.tenantId, storeId: config.storeId },
        workerId,
        intervalMs: config.workerIntervalMs,
        hashSecret: config.secret,
        transactions: new ScopedPostgresTransactionRunner(workerPool),
        aiExecutions: runtime.services.ai,
        adapters,
        wechatLoyaltyNotification,
        reservationPerformanceNotification: wechatLoyaltyNotification,
        onError: (worker, error) => {
          runtime.app.log.error({ worker, errorCode: safeErrorCode(error) }, 'normalized worker failed')
        },
        ...(workerHealth === null ? {} : { onCycle: (result) => workerHealth.report(result) }),
      })
    }
    await runtime.app.listen({ host: config.host, port: config.port })
    workers?.start()
  } catch (error) {
    await shutdownRuntime(workers, workerPool, () => runtime.app.close()).catch(() => undefined)
    throw error
  }
  runtime.app.log.info({
    port: config.port,
    commitSha: config.commitSha,
    schemaFlavor: config.schemaFlavor,
    deploymentTier: config.deploymentTier,
    workersEnabled: config.startWorkers,
    integrationWorkersEnabled: adapters !== null,
  }, 'normalized service started')
}

async function shutdownRuntime(
  workers: NormalizedWorkerRuntime | null,
  workerPool: PostgresPool | null,
  closeApp: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = []
  try {
    await workers?.stop()
  } catch (error) {
    failures.push(error)
  }
  try {
    await closeApp()
  } catch (appFailure) {
    failures.push(appFailure)
  }
  try {
    await workerPool?.end()
  } catch (poolFailure) {
    failures.push(poolFailure)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Normalized service shutdown failed')
}

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64)
  }
  return error instanceof Error ? error.name.slice(0, 64) : 'UNKNOWN_ERROR'
}

void main().catch((error: unknown) => {
  process.stderr.write(`normalized service failed: ${safeErrorCode(error)}\n`)
  process.exitCode = 1
})
