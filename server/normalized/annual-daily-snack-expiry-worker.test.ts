import { describe, expect, it, vi } from 'vitest'
import { AnnualDailySnackExpiryWorker } from './annual-daily-snack-expiry-worker.js'

const scope = {
  tenantId: '91000000-0000-4000-8000-000000000001',
  storeId: '91000000-0000-4000-8000-000000000002',
}
const claimId = '91000000-0000-4000-8000-000000000003'
const benefitId = '91000000-0000-4000-8000-000000000004'
const reservationId = '91000000-0000-4000-8000-000000000005'

describe('AnnualDailySnackExpiryWorker', () => {
  it('expires a due hold exactly once, releases the benefit quantity and emits audit/outbox facts', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ claim_id: claimId, benefit_id: benefitId, benefit_reservation_id: reservationId, quantity: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const transactions = { run: vi.fn(async (_scope, operation) => operation({ scope, query })) }
    const worker = new AnnualDailySnackExpiryWorker(transactions as never, () => '2026-08-24T12:00:00.000Z')

    await expect(worker.runBatch(scope, 'worker:daily-snack-expiry')).resolves.toEqual({
      workerId: 'worker:daily-snack-expiry', evaluatedAt: '2026-08-24T12:00:00.000Z', claimed: 1, expiredClaimIds: [claimId],
    })
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF claim,reservation SKIP LOCKED')
    expect(query.mock.calls[1]?.[0]).toContain("status='expired'")
    expect(query.mock.calls[2]?.[0]).toContain('quantity_reserved=quantity_reserved')
    expect(query.mock.calls[3]?.[0]).toContain("'loyalty.annual-daily-snack.expired'")
    expect(query.mock.calls[4]?.[0]).toContain("'loyalty.annual-daily-snack.expired.v1'")
  })
})
