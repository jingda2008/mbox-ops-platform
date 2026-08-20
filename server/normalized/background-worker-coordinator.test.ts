import { describe, expect, it, vi } from 'vitest'
import { NormalizedBackgroundWorkerCoordinator } from './background-worker-coordinator.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000001',
  storeId: '91000000-0000-4000-8000-000000000002',
}

describe('NormalizedBackgroundWorkerCoordinator', () => {
  it('runs independent normalized workers and contains one worker failure', async () => {
    const errors: string[] = []
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] })) },
      reservationExpiry: {
        runBatch: vi.fn(async () => { throw new Error('reservation worker unavailable') }),
      },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyRedemptionRecovery: { runBatch: vi.fn(async () => loyaltyRedemptionRecoveryResult()) },
      loyaltyTierBenefitExpiry: { runBatch: vi.fn(async () => loyaltyTierBenefitExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: vi.fn(async () => ({ deleted: 0, ids: [] })) },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 2) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      sop: { runBatch: vi.fn(async () => ({ workerId: 'sop', claimed: 0, processed: [] })) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch: vi.fn(async () => personalContactDispositionResult()) },
      print: { runBatch: vi.fn(async () => ({ claimed: 0, printed: [], retrying: [], dead: [], lost: [] })) },
      outbox: { runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], failed: [] })) },
      notification: {
        runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], retrying: [], dead: [], lost: [] })),
      },
    }, {
      outbox: async () => undefined,
      notification: async () => undefined,
      print: { print: async () => undefined },
    }, {
      workerId: 'normalized-test',
      onError: (worker) => errors.push(worker),
    })

    const result = await coordinator.runOnce()

    expect(result.failures).toEqual(['reservation-expiry'])
    expect(result.workers.serviceSla).not.toBeNull()
    expect(result.workers.reservationExpiry).toBeNull()
    expect(result.workers.staffLoginRateLimitCleanup).toBe(2)
    expect(result.workers.businessDay?.businessDate).toBe('2026-08-11')
    expect(result.workers.loyaltyTierBenefitExpiry?.expiredBenefits).toBe(0)
    expect(result.workers.loyaltyRedemptionRecovery?.expired).toBe(0)
    expect(result.workers.sop).not.toBeNull()
    expect(result.workers.aiScheduled).not.toBeNull()
    expect(result.workers.print).not.toBeNull()
    expect(result.workers.outbox).not.toBeNull()
    expect(errors).toEqual(['reservation-expiry'])
  })

  it('coalesces overlapping in-process ticks without creating a global business queue', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const serviceSla = vi.fn(async () => {
      await pending
      return { workerId: 'sla', claimed: 0, processed: [] }
    })
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: serviceSla },
      reservationExpiry: { runBatch: vi.fn(async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] })) },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: vi.fn(async () => ({ deleted: 0, ids: [] })) },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 0) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      sop: { runBatch: vi.fn(async () => ({ workerId: 'sop', claimed: 0, processed: [] })) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch: vi.fn(async () => personalContactDispositionResult()) },
      print: { runBatch: vi.fn(async () => ({ claimed: 0, printed: [], retrying: [], dead: [], lost: [] })) },
      outbox: { runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], failed: [] })) },
      notification: {
        runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], retrying: [], dead: [], lost: [] })),
      },
    }, {
      outbox: async () => undefined,
      notification: async () => undefined,
      print: { print: async () => undefined },
    }, { workerId: 'normalized-test' })

    const first = coordinator.runOnce()
    const second = coordinator.runOnce()
    expect(first).toBe(second)
    release?.()
    await first
    expect(serviceSla).toHaveBeenCalledTimes(1)
  })

  it('contains a print failure without blocking the business-day or SOP workers', async () => {
    const errors: string[] = []
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] })) },
      reservationExpiry: { runBatch: vi.fn(async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] })) },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: vi.fn(async () => ({ deleted: 0, ids: [] })) },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 0) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      sop: { runBatch: vi.fn(async () => ({ workerId: 'sop', claimed: 1, processed: [] })) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch: vi.fn(async () => personalContactDispositionResult()) },
      print: { runBatch: vi.fn(async () => { throw new Error('printer unavailable') }) },
      outbox: { runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], failed: [] })) },
      notification: { runBatch: vi.fn(async () => ({ claimed: 0, delivered: [], retrying: [], dead: [], lost: [] })) },
    }, {
      outbox: async () => undefined,
      notification: async () => undefined,
      print: { print: async () => undefined },
    }, {
      workerId: 'normalized-test',
      onError: (worker) => errors.push(worker),
    })

    const result = await coordinator.runOnce()
    expect(result.failures).toEqual(['print'])
    expect(result.workers.print).toBeNull()
    expect(result.workers.businessDay).not.toBeNull()
    expect(result.workers.sop?.claimed).toBe(1)
    expect(errors).toEqual(['print'])
  })

  it('runs each worker on its own cadence instead of querying every queue on every tick', async () => {
    let now = 1_000
    const serviceSla = vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] }))
    const cleanup = vi.fn(async () => ({ deleted: 0, ids: [] }))
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: serviceSla },
      reservationExpiry: { runBatch: vi.fn(async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] })) },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: cleanup },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 0) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch: vi.fn(async () => personalContactDispositionResult()) },
    }, {}, {
      workerId: 'normalized-cadence-test',
      now: () => now,
      cadenceMs: { 'service-sla': 1_000, 'idempotency-cleanup': 60_000 },
    })

    await coordinator.runOnce()
    now += 500
    await coordinator.runOnce()
    expect(serviceSla).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)

    now += 600
    await coordinator.runOnce()
    expect(serviceSla).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('marks contained personal-contact item failures as degraded without blocking the cycle', async () => {
    const errors:string[]=[]
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] })) },
      reservationExpiry: { runBatch: vi.fn(async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] })) },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: vi.fn(async () => ({ deleted: 0, ids: [] })) },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 0) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch: vi.fn(async (_scope,workerId) => ({
        workerId,examined:2,disposed:1,skipped:0,failed:1,
      })) },
    }, {}, {
      workerId:'normalized-contact-health',
      onError:(worker) => errors.push(worker),
    })

    const result=await coordinator.runOnce()
    expect(result.failures).toEqual(['personal-contact-disposition'])
    expect(result.workers.personalContactDisposition?.disposed).toBe(1)
    expect(result.workers.personalContactDisposition?.failed).toBe(1)
    expect(errors).toEqual(['personal-contact-disposition'])
  })

  it('constructs the personal-contact evidence worker id exactly once within 128 characters', async () => {
    const runBatch=vi.fn(async (_scope:typeof scope,workerId:string) => ({
      workerId,examined:0,disposed:0,skipped:0,failed:0,
    }))
    const coordinator = new NormalizedBackgroundWorkerCoordinator(scope, {
      serviceSla: { runBatch: vi.fn(async () => ({ workerId: 'sla', claimed: 0, processed: [] })) },
      reservationExpiry: { runBatch: vi.fn(async () => ({ workerId: 'reservation', claimed: 0, expiredReservationIds: [] })) },
      paymentReservationExpiry: { runBatch: vi.fn(async () => paymentReservationResult()) },
      activityRegistrationExpiry: { runBatch: vi.fn(async () => activityRegistrationResult()) },
      experienceCueDispatch: { runBatch: vi.fn(async () => experienceCueResult()) },
      loyaltyPointsExpiry: { runBatch: vi.fn(async () => loyaltyPointsExpiryResult()) },
      loyaltyTierReview: { runBatch: vi.fn(async () => loyaltyTierReviewResult()) },
      idempotencyCleanup: { runBatch: vi.fn(async () => ({ deleted: 0, ids: [] })) },
      staffLoginRateLimitCleanup: { cleanupExpired: vi.fn(async () => 0) },
      businessDay: { run: vi.fn(async () => businessDayResult()) },
      aiScheduled: { runBatch: vi.fn(async () => ({ workerId: 'ai', claimed: 0, statuses: [] })) },
      personalContactDisposition: { runBatch },
    }, {}, { workerId:`w${'x'.repeat(95)}` })

    await coordinator.runOnce()
    const workerId=runBatch.mock.calls[0]?.[1]
    expect(workerId).toBe(`w${'x'.repeat(95)}:personal-contact-disposition`)
    expect(workerId?.length).toBeLessThanOrEqual(128)
  })
})

function businessDayResult() {
  return {
    businessDate: '2026-08-11',
    timezone: 'Asia/Shanghai',
    cutoff: '06:00:00',
    created: false,
    rolledOverBusinessDayIds: [],
  }
}

function paymentReservationResult() {
  return {
    workerId: 'payment-reservation',
    claimed: 0,
    releasedOrderIds: [],
    activatedOrderIds: [],
    reviewOrderIds: [],
  }
}

function loyaltyTierBenefitExpiryResult() {
  return {
    workerId: 'tier-benefit-expiry', expiredBenefits: 0,
    evaluatedAt: '2026-08-16T00:00:00.000Z',
  }
}

function activityRegistrationResult() {
  return {
    workerId: 'activity-registration-expiry',
    claimed: 0,
    releasedRegistrationIds: [],
    confirmedRegistrationIds: [],
    reviewRegistrationIds: [],
  }
}

function experienceCueResult() {
  return {
    workerId: 'experience-cue-dispatch',
    claimed: 0,
    dispatchedCueIds: [],
    skippedCueIds: [],
  }
}

function loyaltyPointsExpiryResult() {
  return { workerId: 'loyalty-points-expiry', expiredLots: 0, expiredPoints: 0 }
}

function loyaltyRedemptionRecoveryResult() {
  return {
    workerId: 'loyalty-redemption-recovery', evaluatedAt: '2026-08-16T00:00:00.000Z',
    claimed: 0, expired: 0, manualReview: 0,
    expiredPublicIds: [], manualReviewPublicIds: [],
  }
}

function loyaltyTierReviewResult() {
  return { workerId: 'loyalty-tier-review', claimed: 0, graceStarted: 0, reviewed: 0 }
}

function personalContactDispositionResult() {
  return {
    workerId:'personal-contact-disposition:test',examined:0,disposed:0,skipped:0,failed:0,
  }
}
