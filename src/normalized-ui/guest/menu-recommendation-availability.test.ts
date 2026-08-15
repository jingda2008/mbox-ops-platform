import { describe, expect, it } from 'vitest'
import type { MenuProduct } from '../../shared/contracts'
import { recommendationProductIsOrderable } from '../../components/menu-recommendation-availability.js'

const bundle = {
  id: 'bundle', productKind: 'bundle', guestVisible: true,
  bundleComponents: [{ productId: 'internal-component', quantity: 1 }],
} as MenuProduct

describe('guest bundle recommendation availability', () => {
  it('accepts a server-validated guest bundle whose internal component is intentionally not sold alone', () => {
    const availability = new Map([
      ['bundle', { state: 'available' as const, orderable: true, label: '在售' }],
    ])
    expect(recommendationProductIsOrderable(bundle, availability, true)).toBe(true)
    expect(recommendationProductIsOrderable(bundle, availability, false)).toBe(false)
  })

  it('never recommends a bundle the server marked unavailable', () => {
    const availability = new Map([
      ['bundle', { state: 'sold_out' as const, orderable: false, label: '暂时售罄' }],
    ])
    expect(recommendationProductIsOrderable(bundle, availability, true)).toBe(false)
  })
})
