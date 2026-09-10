import { describe, expect, it } from 'vitest'
import { benefitWalletState, parseBenefitWalletCursor } from './benefit-wallet.js'
import type { Benefit } from './benefit-repository.js'

const at = new Date('2026-09-09T04:00:00Z')
const benefit = {
  status: 'issued', quantityAvailable: 1, quantityReserved: 0,
  quantityRedeemed: 0, quantityTotal: 1,
  validFrom: '2026-09-01T00:00:00Z', validUntil: '2026-09-30T16:00:00Z',
} satisfies Parameters<typeof benefitWalletState>[0]
describe('benefit wallet read model', () => {
  it.each([
    [{}, 'available'],
    [{ validFrom: '2026-09-10T00:00:00Z' }, 'upcoming'],
    [{ validUntil: at.toISOString() }, 'expired'],
    [{ status: 'revoked' }, 'revoked'],
    [{ quantityRedeemed: 1, quantityAvailable: 0 }, 'redeemed'],
    [{ quantityReserved: 1, quantityAvailable: 0, validUntil: '2026-09-08T00:00:00Z' }, 'reserved'],
    [{ quantityReserved: 1, quantityTotal: 2 }, 'available'],
    [{ validFrom: 'invalid' }, 'unavailable'],
    [{ validUntil: 'invalid' }, 'unavailable'],
  ] as const)('classifies without mutating financial/fulfillment facts: %j', (overrides, expected) => {
    const row = { ...benefit, ...overrides } as Benefit
    const before = structuredClone(row)
    expect(benefitWalletState(row, at)).toBe(expected)
    expect(row).toEqual(before)
  })
  it('retains microsecond cursor precision and validates shape', () => {
    const cursor = '2026-09-09 04:00:00.123456+00|11111111-1111-4111-8111-111111111111'
    expect(parseBenefitWalletCursor(cursor)?.createdAt).toBe('2026-09-09 04:00:00.123456+00')
    expect(parseBenefitWalletCursor(undefined)).toBeNull()
    for (const value of ['', [], 'bad', cursor + '|other', 'x'.repeat(121)]) {
      expect(() => parseBenefitWalletCursor(value)).toThrow()
    }
  })
  it('uses authoritative calendar status without replacing reserved or revoked facts', () => {
    const calendar = { available: false, nextAvailableAt: '2026-09-10T13:00:00Z', lastAvailableUntil: '2026-09-30T16:00:00Z', summary: '时间受限', limits: { perCustomerDay: 1, perCustomerWeek: null, perCustomerCampaign: null } }
    expect(benefitWalletState({ ...benefit, calendar }, at)).toBe('outside_window')
    expect(benefitWalletState({ ...benefit, calendar: { ...calendar, nextAvailableAt: null } }, at)).toBe('expired')
    expect(benefitWalletState({ ...benefit, calendar, quantityAvailable: 0, quantityReserved: 1 }, at)).toBe('reserved')
    expect(benefitWalletState({ ...benefit, calendar, status: 'revoked' }, at)).toBe('revoked')
  })
})
