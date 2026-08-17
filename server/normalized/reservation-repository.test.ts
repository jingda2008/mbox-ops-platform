import { describe, expect, it } from 'vitest'
import type { PostgresQueryResult, ScopedTransaction } from './transaction-runner.js'
import { ReservationRepository } from './reservation-repository.js'

describe('ReservationRepository validation', () => {
  it('accepts a reservation range that crosses midnight', async () => {
    const transaction = neverQueryTransaction()
    const repository = new ReservationRepository(transaction)

    await expect(repository.create({
      publicId: 'reservation-cross-midnight',
      customerName: 'Cross Midnight',
      contactToken: 'contact-token',
      guestCount: 2,
      arrivalAt: '2026-08-11T23:30:00+08:00',
      expectedEndAt: '2026-08-12T02:00:00+08:00',
      source: 'wechat',
      tableIds: ['10000000-0000-4000-8000-000000000001'],
      holdExpiresAt: '2026-08-11T23:20:00+08:00',
      arrivalGraceEndsAt: '2026-08-12T00:00:00+08:00',
      reservationPolicyVersion: 1,
    })).rejects.toThrow('query reached')
  })

  it('rejects an invalid time range before touching PostgreSQL', async () => {
    const repository = new ReservationRepository(neverQueryTransaction())
    await expect(repository.create({
      publicId: 'reservation-invalid-range',
      customerName: 'Invalid Range',
      contactToken: 'contact-token',
      guestCount: 2,
      arrivalAt: '2026-08-12T02:00:00+08:00',
      expectedEndAt: '2026-08-11T23:30:00+08:00',
      source: 'wechat',
      tableIds: ['10000000-0000-4000-8000-000000000001'],
      holdExpiresAt: '2026-08-11T23:20:00+08:00',
      arrivalGraceEndsAt: '2026-08-12T02:10:00+08:00',
      reservationPolicyVersion: 1,
    })).rejects.toThrow('expectedEndAt must be after arrivalAt')
  })
})

function neverQueryTransaction(): ScopedTransaction {
  return {
    scope: {
      tenantId: '10000000-0000-4000-8000-000000000001',
      storeId: '10000000-0000-4000-8000-000000000002',
    },
    query: async <Row extends Record<string, unknown>>(): Promise<PostgresQueryResult<Row>> => {
      throw new Error('query reached')
    },
  }
}
