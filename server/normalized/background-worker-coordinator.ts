import type { IdempotencyCleanupResult } from './idempotency-cleanup-worker.js'
import type { BusinessDayRolloverResult } from './business-day-worker.js'
import type { NotificationBatchResult, NotificationDelivery } from './notification-worker.js'
import type { OutboxBatchResult, OutboxDelivery } from './outbox-dispatcher.js'
import type { PrintAdapter, PrintBatchResult } from './print-worker.js'
import type { ReservationHoldExpiryBatch } from './reservation-hold-expiry-worker.js'
import type { PaymentReservationExpiryBatch } from './payment-reservation-expiry-worker.js'
import type { ServiceTaskSlaBatch } from './service-task-sla-worker.js'
import type { SopWorkerBatchResult } from './sop-worker.js'
import type { StoreScope } from './transaction-runner.js'

type ServiceSlaPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ServiceTaskSlaBatch>
}
type ReservationExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<ReservationHoldExpiryBatch>
}
type PaymentReservationExpiryPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<PaymentReservationExpiryBatch>
}
type IdempotencyCleanupPort = {
  runBatch(scope: Readonly<StoreScope>): Promise<IdempotencyCleanupResult>
}
type StaffLoginRateLimitCleanupPort = {
  cleanupExpired(scope: Readonly<StoreScope>, limit?: number): Promise<number>
}
type OutboxPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: OutboxDelivery,
  ): Promise<OutboxBatchResult>
}
type NotificationPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    deliver: NotificationDelivery,
  ): Promise<NotificationBatchResult>
}
type BusinessDayPort = {
  run(scope: Readonly<StoreScope>, workerId: string): Promise<BusinessDayRolloverResult>
}
type SopPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<SopWorkerBatchResult>
}
type AiScheduledPort = {
  runBatch(scope: Readonly<StoreScope>, workerId: string): Promise<{
    workerId: string
    claimed: number
    statuses: readonly string[]
  }>
}
type PrintPort = {
  runBatch(
    scope: Readonly<StoreScope>,
    workerId: string,
    adapter: PrintAdapter,
  ): Promise<PrintBatchResult>
}

export interface NormalizedWorkerCoordinatorOptions {
  workerId: string
  intervalMs?: number
  cadenceMs?: Partial<Record<NormalizedWorkerName, number>>
  now?: () => number
  onError?: (worker: NormalizedWorkerName, error: unknown) => void
  onCycle?: (result: Readonly<NormalizedWorkerCycleResult>) => void
}

export type NormalizedWorkerName =
  | 'service-sla'
  | 'reservation-expiry'
  | 'payment-reservation-expiry'
  | 'idempotency-cleanup'
  | 'staff-login-rate-limit-cleanup'
  | 'business-day'
  | 'sop'
  | 'ai-scheduled'
  | 'print'
  | 'outbox'
  | 'notification'

export interface NormalizedWorkerCycleResult {
  startedAt: string
  completedAt: string
  workers: {
    serviceSla: ServiceTaskSlaBatch | null
    reservationExpiry: ReservationHoldExpiryBatch | null
    paymentReservationExpiry: PaymentReservationExpiryBatch | null
    idempotencyCleanup: IdempotencyCleanupResult | null
    staffLoginRateLimitCleanup: number | null
    businessDay: BusinessDayRolloverResult | null
    sop: SopWorkerBatchResult | null
    aiScheduled: { workerId: string; claimed: number; statuses: readonly string[] } | null
    print: PrintBatchResult | null
    outbox: OutboxBatchResult | null
    notification: NotificationBatchResult | null
  }
  failures: NormalizedWorkerName[]
}

export class NormalizedBackgroundWorkerCoordinator {
  private timer: NodeJS.Timeout | null = null
  private cycle: Promise<NormalizedWorkerCycleResult> | null = null
  private readonly intervalMs: number
  private readonly cadenceMs: Readonly<Record<NormalizedWorkerName, number>>
  private readonly lastStartedAt = new Map<NormalizedWorkerName, number>()
  private readonly now: () => number

  constructor(
    private readonly scope: Readonly<StoreScope>,
    private readonly workers: Readonly<{
      serviceSla: ServiceSlaPort
      reservationExpiry: ReservationExpiryPort
      paymentReservationExpiry: PaymentReservationExpiryPort
      idempotencyCleanup: IdempotencyCleanupPort
      staffLoginRateLimitCleanup: StaffLoginRateLimitCleanupPort
      businessDay: BusinessDayPort
      sop?: SopPort
      aiScheduled: AiScheduledPort
      print?: PrintPort
      outbox?: OutboxPort
      notification?: NotificationPort
    }>,
    private readonly delivery: Readonly<{
      outbox?: OutboxDelivery
      notification?: NotificationDelivery
      print?: PrintAdapter
    }>,
    private readonly options: Readonly<NormalizedWorkerCoordinatorOptions>,
  ) {
    validateWorkerId(options.workerId)
    this.intervalMs = validateInterval(options.intervalMs ?? 2_000)
    this.cadenceMs = workerCadences(options.cadenceMs)
    this.now = options.now ?? Date.now
  }

  runOnce(): Promise<NormalizedWorkerCycleResult> {
    if (this.cycle !== null) return this.cycle
    this.cycle = this.executeCycle().finally(() => {
      this.cycle = null
    })
    return this.cycle
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    this.timer.unref()
    void this.runOnce()
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.cycle
  }

  private async executeCycle(): Promise<NormalizedWorkerCycleResult> {
    const startedAt = new Date().toISOString()
    const names: readonly NormalizedWorkerName[] = [
      'service-sla',
      'reservation-expiry',
      'payment-reservation-expiry',
      'idempotency-cleanup',
      'staff-login-rate-limit-cleanup',
      'business-day',
      'sop',
      'ai-scheduled',
      'print',
      'outbox',
      'notification',
    ]
    const executions = await Promise.allSettled([
      this.runWhenDue('service-sla', () => this.workers.serviceSla.runBatch(this.scope, `${this.options.workerId}:service-sla`)),
      this.runWhenDue('reservation-expiry', () => this.workers.reservationExpiry.runBatch(this.scope, `${this.options.workerId}:reservation-expiry`)),
      this.runWhenDue('payment-reservation-expiry', () => this.workers.paymentReservationExpiry.runBatch(
        this.scope,
        `${this.options.workerId}:payment-reservation-expiry`,
      )),
      this.runWhenDue('idempotency-cleanup', () => this.workers.idempotencyCleanup.runBatch(this.scope)),
      this.runWhenDue('staff-login-rate-limit-cleanup', () => this.workers.staffLoginRateLimitCleanup.cleanupExpired(this.scope)),
      this.runWhenDue('business-day', () => this.workers.businessDay.run(this.scope, `${this.options.workerId}:business-day`)),
      this.workers.sop === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('sop', () => this.workers.sop!.runBatch(this.scope, `${this.options.workerId}:sop`)),
      this.runWhenDue('ai-scheduled', () => this.workers.aiScheduled.runBatch(this.scope, `${this.options.workerId}:ai-scheduled`)),
      this.workers.print === undefined || this.delivery.print === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('print', () => this.workers.print!.runBatch(this.scope, `${this.options.workerId}:print`, this.delivery.print!)),
      this.workers.outbox === undefined || this.delivery.outbox === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('outbox', () => this.workers.outbox!.runBatch(this.scope, `${this.options.workerId}:outbox`, this.delivery.outbox!)),
      this.workers.notification === undefined || this.delivery.notification === undefined
        ? Promise.resolve(null)
        : this.runWhenDue('notification', () => this.workers.notification!.runBatch(
            this.scope,
            `${this.options.workerId}:notification`,
            this.delivery.notification!,
          )),
    ] as const)

    const failures: NormalizedWorkerName[] = []
    executions.forEach((execution, index) => {
      if (execution.status === 'fulfilled') return
      const worker = names[index]
      if (worker === undefined) return
      failures.push(worker)
      this.options.onError?.(worker, execution.reason)
    })

    const result: NormalizedWorkerCycleResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      workers: {
        serviceSla: fulfilledValue(executions[0]),
        reservationExpiry: fulfilledValue(executions[1]),
        paymentReservationExpiry: fulfilledValue(executions[2]),
        idempotencyCleanup: fulfilledValue(executions[3]),
        staffLoginRateLimitCleanup: fulfilledValue(executions[4]),
        businessDay: fulfilledValue(executions[5]),
        sop: fulfilledValue(executions[6]),
        aiScheduled: fulfilledValue(executions[7]),
        print: fulfilledValue(executions[8]),
        outbox: fulfilledValue(executions[9]),
        notification: fulfilledValue(executions[10]),
      },
      failures,
    }
    this.options.onCycle?.(result)
    return result
  }

  private runWhenDue<Value>(name: NormalizedWorkerName, execute: () => Promise<Value>): Promise<Value | null> {
    const now = this.now()
    const lastStartedAt = this.lastStartedAt.get(name)
    if (lastStartedAt !== undefined && now - lastStartedAt < this.cadenceMs[name]) {
      return Promise.resolve(null)
    }
    this.lastStartedAt.set(name, now)
    return execute()
  }
}

function fulfilledValue<Value>(result: PromiseSettledResult<Value>): Value | null {
  return result.status === 'fulfilled' ? result.value : null
}

function validateWorkerId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,95}$/.test(value)) {
    throw new TypeError('workerId must be a stable internal identifier between 3 and 96 characters')
  }
}

function validateInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new TypeError('intervalMs must be an integer between 250 and 60000')
  }
  return value
}

const DEFAULT_WORKER_CADENCES: Readonly<Record<NormalizedWorkerName, number>> = Object.freeze({
  'service-sla': 2_000,
  'reservation-expiry': 5_000,
  'payment-reservation-expiry': 5_000,
  'idempotency-cleanup': 60_000,
  'staff-login-rate-limit-cleanup': 60_000,
  'business-day': 30_000,
  sop: 2_000,
  'ai-scheduled': 2_000,
  print: 500,
  outbox: 500,
  notification: 500,
})

function workerCadences(
  overrides: Partial<Record<NormalizedWorkerName, number>> | undefined,
): Readonly<Record<NormalizedWorkerName, number>> {
  const result = { ...DEFAULT_WORKER_CADENCES, ...overrides }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 250 || value > 3_600_000) {
      throw new TypeError(`cadence for ${name} must be an integer between 250 and 3600000`)
    }
  }
  return Object.freeze(result)
}
