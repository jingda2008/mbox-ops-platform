import { describe, expect, it } from 'vitest'
import { getAnonymousReservationIdentity } from './reservation-identity'

describe('anonymous reservation identity', () => {
  it('persists only pseudonymous identifiers so a guest can return to their reservation', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const first = getAnonymousReservationIdentity(storage, () => ids.shift() ?? 'unused')
    const second = getAnonymousReservationIdentity(storage, () => '33333333-3333-4333-8333-333333333333')
    expect(first).toEqual(second)
    expect([...values.values()].join('|')).not.toMatch(/phone|contact|token/i)
  })
})
