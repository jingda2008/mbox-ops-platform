import { pathToFileURL } from 'node:url'
import type { AiScheduledExecutionPort } from './ai-capability-center.js'
import {
  NormalizedBackgroundWorkerCoordinator,
  type NormalizedWorkerCycleResult,
  type NormalizedWorkerName,
} from './background-worker-coordinator.js'
import { BusinessDayRolloverWorker } from './business-day-worker.js'
import { IdempotencyCleanupWorker } from './idempotency-cleanup-worker.js'
import { NotificationWorker, type NotificationDelivery } from './notification-worker.js'
import { OutboxDispatcher, type OutboxDelivery } from './outbox-dispatcher.js'
import { PrintWorker, type PrintAdapter } from './print-worker.js'
import { ReservationHoldExpiryWorker } from './reservation-hold-expiry-worker.js'
import { PaymentReservationExpiryWorker } from './payment-reservation-expiry-worker.js'
import { ServiceTaskSlaWorker } from './service-task-sla-worker.js'
import { AiScheduledExecutionWorker, SopWorker, type SopActionPort } from './sop-worker.js'
import { PostgresStaffLoginRateLimiter } from './staff-login-rate-limiter.js'
import type { ScopedPostgresTransactionRunner, StoreScope } from './transaction-runner.js'

export interface NormalizedWorkerAdapters {
  capabilities: readonly NormalizedWorkerAdapterCapability[]
  preflight(): Promise<void>
  outbox: OutboxDelivery
  notification: NotificationDelivery
  print: PrintAdapter
  sop: SopActionPort
}

export const REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES = Object.freeze([
  'outbox.deliver',
  'notification.deliver',
  'print.deliver',
  'sop.execute',
  'payment.create.postar',
  'refund.execute.postar',
] as const)

export type NormalizedWorkerAdapterCapability =
  (typeof REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES)[number]

export interface NormalizedWorkerAdapterFactoryContext {
  scope: Readonly<StoreScope>
  commitSha: string
  schemaFlavor: string
}

export interface NormalizedWorkerRuntimeOptions {
  scope: Readonly<StoreScope>
  workerId: string
  intervalMs: number
  hashSecret: string
  transactions: ScopedPostgresTransactionRunner
  aiExecutions: AiScheduledExecutionPort
  adapters?: Readonly<NormalizedWorkerAdapters> | null
  onError?: (worker: NormalizedWorkerName, error: unknown) => void
  onCycle?: (result: Readonly<NormalizedWorkerCycleResult>) => void
}

export class NormalizedWorkerAdapterConfigurationError extends Error {
  constructor(code: string) {
    super(`Normalized worker adapter configuration failed: ${code}`)
    this.name = 'NormalizedWorkerAdapterConfigurationError'
  }
}

export class NormalizedWorkerRuntime {
  private started = false

  constructor(private readonly coordinator: NormalizedBackgroundWorkerCoordinator) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.coordinator.start()
  }

  runOnce(): Promise<NormalizedWorkerCycleResult> {
    return this.coordinator.runOnce()
  }

  async stop(): Promise<void> {
    this.started = false
    await this.coordinator.stop()
  }
}

export function createNormalizedWorkerRuntime(
  options: Readonly<NormalizedWorkerRuntimeOptions>,
): NormalizedWorkerRuntime {
  const adapters = options.adapters ?? null
  if (adapters !== null) assertAdapters(adapters)
  const transactions = options.transactions
  const coordinator = new NormalizedBackgroundWorkerCoordinator(options.scope, {
    serviceSla: new ServiceTaskSlaWorker(transactions),
    reservationExpiry: new ReservationHoldExpiryWorker(transactions),
    paymentReservationExpiry: new PaymentReservationExpiryWorker(transactions),
    idempotencyCleanup: new IdempotencyCleanupWorker(transactions),
    staffLoginRateLimitCleanup: new PostgresStaffLoginRateLimiter(transactions, options.hashSecret),
    businessDay: new BusinessDayRolloverWorker(transactions),
    ...(adapters === null ? {} : { sop: new SopWorker(transactions, adapters.sop) }),
    aiScheduled: new AiScheduledExecutionWorker(transactions, options.aiExecutions),
    ...(adapters === null ? {} : {
      print: new PrintWorker(transactions),
      outbox: new OutboxDispatcher(transactions),
      notification: new NotificationWorker(transactions),
    }),
  }, {
    ...(adapters === null ? {} : {
      outbox: adapters.outbox,
      notification: adapters.notification,
      print: adapters.print,
    }),
  }, {
    workerId: options.workerId,
    intervalMs: options.intervalMs,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onCycle === undefined ? {} : { onCycle: options.onCycle }),
  })
  return new NormalizedWorkerRuntime(coordinator)
}

export interface NormalizedWorkerHealthSnapshot {
  status: 'starting' | 'healthy' | 'degraded'
  lastCompletedAt: string | null
  failures: readonly NormalizedWorkerName[]
  integrationWorkersEnabled: boolean
  adapterCapabilities: readonly NormalizedWorkerAdapterCapability[]
}

export class NormalizedWorkerHealthTracker {
  private lastCycle: Readonly<NormalizedWorkerCycleResult> | null = null

  constructor(
    private readonly intervalMs: number,
    private readonly integrationWorkersEnabled: boolean,
    private readonly adapterCapabilities: readonly NormalizedWorkerAdapterCapability[] = [],
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
      throw new TypeError('intervalMs must be an integer between 250 and 60000')
    }
  }

  report(result: Readonly<NormalizedWorkerCycleResult>): void {
    this.lastCycle = result
  }

  snapshot(nowMs = Date.now()): NormalizedWorkerHealthSnapshot {
    if (this.lastCycle === null) {
      return {
        status: 'starting', lastCompletedAt: null, failures: [],
        integrationWorkersEnabled: this.integrationWorkersEnabled,
        adapterCapabilities: [...this.adapterCapabilities],
      }
    }
    const completedAtMs = Date.parse(this.lastCycle.completedAt)
    const staleAfterMs = Math.max(10_000, this.intervalMs * 3)
    const stale = !Number.isFinite(completedAtMs) || nowMs - completedAtMs > staleAfterMs
    const failures = [...this.lastCycle.failures]
    return {
      status: stale || failures.length > 0 ? 'degraded' : 'healthy',
      lastCompletedAt: this.lastCycle.completedAt,
      failures,
      integrationWorkersEnabled: this.integrationWorkersEnabled,
      adapterCapabilities: [...this.adapterCapabilities],
    }
  }
}

export async function loadNormalizedWorkerAdapters(
  modulePath: string,
  context: Readonly<NormalizedWorkerAdapterFactoryContext>,
): Promise<Readonly<NormalizedWorkerAdapters>> {
  let imported: Record<string, unknown>
  try {
    imported = await import(pathToFileURL(modulePath).href) as Record<string, unknown>
  } catch {
    throw new NormalizedWorkerAdapterConfigurationError('module_load_failed')
  }
  const factory = imported.createNormalizedWorkerAdapters
  if (typeof factory !== 'function') {
    throw new NormalizedWorkerAdapterConfigurationError('factory_missing')
  }
  let candidate: unknown
  try {
    candidate = await factory(Object.freeze({ ...context }))
  } catch {
    throw new NormalizedWorkerAdapterConfigurationError('factory_failed')
  }
  assertAdapters(candidate)
  try {
    await candidate.preflight()
  } catch {
    throw new NormalizedWorkerAdapterConfigurationError('preflight_failed')
  }
  const print: PrintAdapter = {
    print: (request) => candidate.print.print(request),
  }
  const sop: SopActionPort = {
    execute: (request) => candidate.sop.execute(request),
  }
  const adapters: NormalizedWorkerAdapters = {
    capabilities: Object.freeze([...candidate.capabilities]),
    preflight: () => candidate.preflight(),
    outbox: (message) => candidate.outbox(message),
    notification: (request) => candidate.notification(request),
    print: Object.freeze(print),
    sop: Object.freeze(sop),
  }
  return Object.freeze(adapters)
}

function assertAdapters(value: unknown): asserts value is NormalizedWorkerAdapters {
  if (!isRecord(value)
    || !hasRequiredCapabilities(value.capabilities)
    || typeof value.preflight !== 'function'
    || typeof value.outbox !== 'function'
    || typeof value.notification !== 'function'
    || !isRecord(value.print)
    || typeof value.print.print !== 'function'
    || !isRecord(value.sop)
    || typeof value.sop.execute !== 'function') {
    throw new NormalizedWorkerAdapterConfigurationError('invalid_contract')
  }
}

function hasRequiredCapabilities(value: unknown): value is readonly NormalizedWorkerAdapterCapability[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return false
  const configured = new Set(value)
  return REQUIRED_NORMALIZED_COMMERCIAL_ADAPTER_CAPABILITIES.every((capability) => configured.has(capability))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
