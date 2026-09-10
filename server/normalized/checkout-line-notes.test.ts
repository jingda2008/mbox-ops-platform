import { describe, expect, it } from 'vitest'
import { checkoutLinesWithNotes } from './checkout-line-notes.js'
import type { GuestSharedCartLine } from './guest-shared-cart-repository.js'

const line: GuestSharedCartLine = { productId: 'cocktail', portionIds: ['first', 'second'], quantity: 2, name: '鸡尾酒',
  unitPriceMinor: 9800, subtotalAmountMinor: 19600, currency: 'CNY', available: true, unavailableReason: null, bundleSelections: [] }
describe('checkout portion instructions', () => {
  it('keeps separate instructions for the same product and preserves the original cart', () => {
    const result = checkoutLinesWithNotes([line], [{ portionId: 'first', note: '少冰' }, { portionId: 'second', note: '不加糖' }], false)
    expect(result.map(row => 'note' in row ? row.note : null)).toEqual(['少冰', '不加糖'])
    expect(result.map(row => row.quantity)).toEqual([1, 1])
    expect(line.quantity).toBe(2)
    expect(line).not.toHaveProperty('note')
  })
  it('refuses stale, cross-cart or duplicate portions and overlong instructions', () => {
    expect(() => checkoutLinesWithNotes([line], [{ portionId: 'removed', note: '少冰' }], false)).toThrow()
    expect(() => checkoutLinesWithNotes([line], [{ portionId: 'first', note: 'A' }, { portionId: 'first', note: 'B' }], false)).toThrow()
    expect(() => checkoutLinesWithNotes([line], [{ portionId: 'first', note: 'a'.repeat(301) }], false)).toThrow()
  })
  it('preserves coupon allocation order even when only the second portion has a note', () => {
    const result = checkoutLinesWithNotes([line], [{ portionId: 'second', note: '不辣' }], true)
    expect(result.map(row => 'note' in row ? row.note : null)).toEqual([null, '不辣'])
    expect(result.reduce((sum, row) => sum + row.quantity * (row.unitPriceMinor || 0), 0)).toBe(19600)
  })
  it('keeps legacy checkout grouping when no notes or coupons are supplied', () => {
    expect(checkoutLinesWithNotes([line], [], false)).toEqual([line])
  })
  it('keeps each bundle choice paired with its own portion note', () => {
    const choices = [{ choices: ['cocktail-A'] }, { choices: ['cocktail-B'] }]
    const bundle = { ...line, bundleSelections: choices } as unknown as GuestSharedCartLine
    const result = checkoutLinesWithNotes([bundle], [{ portionId: 'second', note: '第二份少冰' }], true)
    expect(result[0]!.bundleSelections).toEqual([choices[0]])
    expect(result[1]!.bundleSelections).toEqual([choices[1]])
    expect(result[1]).toHaveProperty('note', '第二份少冰')
  })
})
