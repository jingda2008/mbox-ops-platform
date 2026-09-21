import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NormalizedBackgroundWorkerCoordinator,
  type NormalizedWorkerCoordinatorOptions,
  type NormalizedWorkerCycleResult,
} from './background-worker-coordinator.js'
import { NormalizedWorkerHealthTracker } from './normalized-worker-runtime.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000101',
  storeId: '91000000-0000-4000-8000-000000000102',
}
const epoch = Date.parse('2026-09-21T00:00:00.000Z')
type Workers = ConstructorParameters<typeof NormalizedBackgroundWorkerCoordinator>[1]

function businessDayResult() {
  return {
    businessDate: '2026-09-21', timezone: 'Asia/Shanghai', cutoff: '06:00:00',
    created: false, rolledOverBusinessDayIds: [],
    closure: {
      businessDays: [], closedBusinessDayCount: 0,
      closedTableSessionCount: 0, blockedTableSessionCount: 0,
    },
  }
}

function harness(overrides: Partial<Workers> = {}, options: Partial<NormalizedWorkerCoordinatorOptions> = {}) {
  const tracker = new NormalizedWorkerHealthTracker(2_000, false)
  const reports: Readonly<NormalizedWorkerCycleResult>[] = []
  const serviceSla = vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] }))
  const workers: Workers = {
    serviceSla: { runBatch: serviceSla },
    reservationExpiry: { runBatch: async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] }) },
    paymentReservationExpiry: { runBatch: async () => ({
      workerId: 'payment-reservation', claimed: 0, releasedOrderIds: [], activatedOrderIds: [], reviewOrderIds: [],
    }) },
    activityRegistrationExpiry: { runBatch: async () => ({
      workerId: 'activity-registration', claimed: 0, releasedRegistrationIds: [], confirmedRegistrationIds: [], reviewRegistrationIds: [],
    }) },
    experienceCueDispatch: { runBatch: async () => ({ workerId: 'experience-cue', claimed: 0, dispatchedCueIds: [], skippedCueIds: [] }) },
    loyaltyPointsExpiry: { runBatch: async () => ({ workerId: 'points-expiry', expiredLots: 0, expiredPoints: 0 }) },
    loyaltyTierReview: { runBatch: async () => ({ workerId: 'tier-review', claimed: 0, graceStarted: 0, reviewed: 0 }) },
    idempotencyCleanup: { runBatch: async () => ({ deleted: 0, ids: [] }) },
    staffLoginRateLimitCleanup: { cleanupExpired: async () => 0 },
    businessDay: { run: async () => businessDayResult() },
    aiScheduled: { runBatch: async () => ({ workerId: 'ai', claimed: 0, statuses: [] }) },
    personalContactDisposition: { runBatch: async () => ({ workerId: 'contact', examined: 0, disposed: 0, skipped: 0, failed: 0 }) },
    ...overrides,
  }
  const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, workers, {
    print: { print: async () => undefined },
  }, {
    ...options,
    workerId: 'health-cadence-test', intervalMs: 2_000,
    onCycle: result => { reports.push(result); tracker.report(result) },
  })
  async function at(milliseconds: number) {
    vi.setSystemTime(epoch + milliseconds)
    return coordinator.runOnce()
  }
  return { coordinator, tracker, reports, serviceSla, at }
}

describe('worker cadence health with the real coordinator and health tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch) })
  afterEach(() => { vi.useRealTimers() })

  it('keeps independent 30s and 60s failures through skipped ticks until each worker really succeeds', async () => {
    const businessDay = vi.fn(async () => businessDayResult())
      .mockRejectedValueOnce(new Error('business day unavailable'))
    const cleanup = vi.fn(async () => 0)
      .mockRejectedValueOnce(new Error('login cleanup unavailable'))
    const { at, tracker, serviceSla } = harness({
      businessDay: { run: businessDay }, staffLoginRateLimitCleanup: { cleanupExpired: cleanup },
    }, { cadenceMs: { 'business-day': 30_000, 'staff-login-rate-limit-cleanup': 60_000 } })

    await at(0)
    expect(tracker.snapshot()).toMatchObject({
      status: 'degraded', failures: ['staff-login-rate-limit-cleanup', 'business-day'],
    })
    const skipped = await at(2_000)
    expect(skipped.workers.businessDay).toBeNull()
    expect(skipped.workers.staffLoginRateLimitCleanup).toBeNull()
    expect(serviceSla).toHaveBeenCalledTimes(2)
    expect(businessDay).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(tracker.snapshot()).toMatchObject({
      status: 'degraded', failures: ['staff-login-rate-limit-cleanup', 'business-day'],
    })

    const firstRecovery = await at(30_000)
    expect(firstRecovery.workers.businessDay).toEqual(businessDayResult())
    expect(firstRecovery.workers.staffLoginRateLimitCleanup).toBeNull()
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['staff-login-rate-limit-cleanup'] })
    await at(32_000)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['staff-login-rate-limit-cleanup'] })

    const recovered = await at(60_000)
    expect(recovered.workers.staffLoginRateLimitCleanup).toBe(0)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(businessDay).toHaveBeenCalledTimes(3)
    expect(tracker.snapshot()).toMatchObject({ status: 'healthy', failures: [] })
  })

  it('retains a fulfilled partial batch failure across skips and repeated partial results, then clears on a real empty batch', async () => {
    const empty = { workerId: 'contact', examined: 0, disposed: 0, skipped: 0, failed: 0 }
    const partial = { ...empty, examined: 2, disposed: 1, failed: 1 }
    const runBatch = vi.fn(async () => empty)
      .mockResolvedValueOnce(partial).mockResolvedValueOnce(partial)
    const { at, tracker } = harness({ personalContactDisposition: { runBatch } }, {
      cadenceMs: { 'personal-contact-disposition': 60_000 },
    })

    const failed = await at(0)
    expect(failed.workers.personalContactDisposition).toEqual(partial)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['personal-contact-disposition'] })
    const skipped = await at(2_000)
    expect(skipped.workers.personalContactDisposition).toBeNull()
    expect(runBatch).toHaveBeenCalledTimes(1)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['personal-contact-disposition'] })

    await at(60_000)
    expect(runBatch).toHaveBeenCalledTimes(2)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['personal-contact-disposition'] })
    await at(62_000)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: ['personal-contact-disposition'] })
    const recovered = await at(120_000)
    expect(recovered.workers.personalContactDisposition).toEqual(empty)
    expect(runBatch).toHaveBeenCalledTimes(3)
    expect(tracker.snapshot()).toMatchObject({ status: 'healthy', failures: [] })
  })

  it('keeps printing faults outside readiness, including skipped cycles, without disabling stale-cycle detection', async () => {
    const errors: string[] = []
    const print = vi.fn(async () => { throw new Error('printer unavailable') })
    const printSource = vi.fn(async () => ({ examined: 2, completed: 0, skipped: 0, retrying: 1, dead: 1 }))
      .mockRejectedValueOnce(new Error('print source unavailable'))
    const { at, tracker } = harness({ print: { runBatch: print }, printSource: { runBatch: printSource } }, {
      cadenceMs: { print: 30_000, 'print-source': 30_000 },
      onError: worker => { errors.push(worker); throw new Error('diagnostic sink unavailable') },
    })

    expect(tracker.snapshot()).toMatchObject({ status: 'starting', lastCompletedAt: null })
    await at(0)
    expect(tracker.snapshot()).toMatchObject({ status: 'healthy', failures: [] })
    const skipped = await at(2_000)
    expect(skipped.workers.print).toBeNull()
    expect(skipped.workers.printSource).toBeNull()
    expect(print).toHaveBeenCalledTimes(1)
    expect(printSource).toHaveBeenCalledTimes(1)
    expect(tracker.snapshot()).toMatchObject({ status: 'healthy', failures: [] })
    const warning = await at(30_000)
    expect(warning.workers.printSource).toMatchObject({ retrying: 1, dead: 1 })
    expect(errors).toEqual(['print', 'print-source', 'print', 'print-source'])
    expect(tracker.snapshot()).toMatchObject({ status: 'healthy', failures: [] })
    vi.setSystemTime(epoch + 40_001)
    expect(tracker.snapshot()).toMatchObject({ status: 'degraded', failures: [] })
  })

  it('shares the first in-flight cycle and waits on stop without manufacturing startup success or clearing its failure', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const businessDay = vi.fn(async () => { await blocked; throw new Error('first business day failure') })
    const { coordinator, tracker, reports } = harness({ businessDay: { run: businessDay } })

    coordinator.start()
    const first = coordinator.runOnce()
    expect(coordinator.runOnce()).toBe(first)
    expect(tracker.snapshot()).toMatchObject({ status: 'starting', lastCompletedAt: null, failures: [] })
    let stopped = false
    const stop = coordinator.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(reports).toHaveLength(0)
    expect(tracker.snapshot().status).toBe('starting')

    release()
    await first
    await stop
    expect(stopped).toBe(true)
    expect(reports).toHaveLength(1)
    expect(businessDay).toHaveBeenCalledTimes(1)
    const stoppedSnapshot = tracker.snapshot()
    expect(stoppedSnapshot).toMatchObject({ status: 'degraded', failures: ['business-day'] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(businessDay).toHaveBeenCalledTimes(1)
    expect(reports).toHaveLength(1)
    expect(tracker.snapshot()).toEqual(stoppedSnapshot)
    await coordinator.stop()
    expect(reports).toHaveLength(1)
  })
})
