import { describe, expect, it, vi } from 'vitest'
import { LoyaltyTierBenefitExpiryWorker } from './loyalty-tier-benefit-expiry-worker.js'

const scope = {
  tenantId: '82000000-0000-4000-8000-000000000001',
  storeId: '82000000-0000-4000-8000-000000000002',
}

describe('LoyaltyTierBenefitExpiryWorker', () => {
  it('runs the typed expiry claim in one scoped transaction and audits only material changes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'benefit-1' }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const transactions = {
      run: vi.fn(async (_scope, operation) => operation({ scope, query })),
    }
    const worker = new LoyaltyTierBenefitExpiryWorker(
      transactions as never,
      () => '2026-08-16T12:00:00.000Z',
    )
    await expect(worker.runBatch(scope, 'worker:tier-benefit-expiry', 50)).resolves.toEqual({
      workerId: 'worker:tier-benefit-expiry', expiredBenefits: 2,
      evaluatedAt: '2026-08-16T12:00:00.000Z',
    })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF benefit SKIP LOCKED LIMIT $4')
    expect(query.mock.calls[1]?.[0]).toContain("'loyalty.tier-benefits.expired'")
  })

  it('is a no-op replay after the repository reports no due entitlement', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const transactions = { run: vi.fn(async (_scope, operation) => operation({ scope, query })) }
    const worker = new LoyaltyTierBenefitExpiryWorker(
      transactions as never,
      () => '2026-08-16T12:00:00.000Z',
    )
    expect(await worker.runBatch(scope, 'worker:tier-benefit-expiry')).toMatchObject({ expiredBenefits: 0 })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects unstable worker identifiers and unsafe batch sizes', () => {
    const worker = new LoyaltyTierBenefitExpiryWorker({} as never)
    expect(() => worker.runBatch(scope, 'x')).toThrow('workerId')
    expect(() => worker.runBatch(scope, 'valid-worker', 501)).toThrow('batchSize')
  })
})
