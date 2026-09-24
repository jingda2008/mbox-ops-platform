import { describe, expect, it } from 'vitest'
import { sameGuestTableCode } from './table-code-alias'

describe('printed table hints after the approved roster rename', () => {
  it.each(['W01', 'W02', 'W03', 'W05', 'W06', 'W07', 'W08', 'W09', 'A01', 'A02', 'A03', 'A05', 'A06', 'A07', 'A08', 'B01', 'B02', 'B03', 'B05', 'B06', 'B07', 'B08', 'C01', 'C02', 'C03', 'C05', 'C06', 'C07'])('accepts the explicit %s alias in either direction', old => {
    const current = old.replace('0', '')
    expect(sameGuestTableCode(current, old.toLowerCase())).toBe(true)
    expect(sameGuestTableCode(old, current)).toBe(true)
  })
  it.each([['W1', 'W10'], ['W01', 'W2'], ['W04', 'W4'], ['C08', 'C8'], ['X01', 'X1'], ['W001', 'W1'], ['W01', 'B1']])('rejects unrelated or unapproved hints %s / %s', (actual, hint) => {
    expect(sameGuestTableCode(actual, hint)).toBe(false)
  })
  it('retains ordinary case-insensitive matching', () => {
    expect(sameGuestTableCode('VIP3', 'vip3')).toBe(true)
  })
})
