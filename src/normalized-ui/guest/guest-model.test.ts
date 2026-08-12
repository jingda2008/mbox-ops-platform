import { describe, expect, it } from 'vitest'
import {
  addCartProduct,
  cartItemCount,
  cartOrderItems,
  cartTotalMinor,
  changeCartQuantity,
  parseGuestAccess,
  parseGuestTableCode,
  tokenFreeLocation,
  type GuestMenuProduct,
} from './guest-model'

const product: GuestMenuProduct = {
  productId: '55555555-5555-4555-8555-555555555555',
  code: 'BEER-001',
  name: '精酿啤酒',
  categoryCode: 'beer',
  categoryName: '酒水',
  beverageFamily: 'beer',
  specification: '330ml',
  aliases: ['精酿'],
  tags: ['精酿'],
  imageUrl: null,
  description: '清爽麦香',
  sortOrder: 1,
  availableFrom: null,
  availableUntil: null,
  guestVisible: true,
  requiresFulfillment: true,
  maxOrderQuantity: 50,
  amountMinor: 6_800,
  currency: 'CNY',
  fulfillmentStation: 'bar',
  productKind: 'single',
  bundleComponents: [],
  recommendation: {
    enabled: false, priority: 0, badge: '', headline: '', reason: '',
    minimumPartySize: 1, maximumPartySize: 100,
    sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
    singleWaveEligible: true, expectedPrepMinutes: 8, holdMinutes: 10,
    upgradeProductId: null, contributionPositive: true,
  },
  available: true,
}

describe('normalized guest access and cart model', () => {
  it('reads table from query and credential only from the URL fragment', () => {
    const token = 'fixed-table-token-'.padEnd(48, 'x')
    const result = parseGuestAccess(`https://mbox.example/guest?table=w01#token=${token}`)

    expect(result).toEqual({ access: { tableCode: 'W01', tableQrToken: token }, error: null })
    expect(parseGuestTableCode('https://mbox.example/guest?table=w01')).toBe('W01')
    expect(tokenFreeLocation(new URL(`https://mbox.example/guest?table=W01#token=${token}`))).toBe('/guest?table=W01')
  })

  it('rejects missing, malformed, or query-string credentials', () => {
    const token = 'fixed-table-token-'.padEnd(48, 'x')
    expect(parseGuestAccess(`https://mbox.example/guest?table=W01&token=${token}`).access).toBeNull()
    expect(parseGuestAccess(`https://mbox.example/guest?table=W%2001#token=${token}`).access).toBeNull()
    expect(parseGuestAccess('not a valid URL', 'not a base').access).toBeNull()
  })

  it('updates the cart immediately and produces a price-free order command', () => {
    let cart = addCartProduct({}, product)
    cart = addCartProduct(cart, product)

    expect(cartItemCount(cart)).toBe(2)
    expect(cartTotalMinor(cart)).toBe(13_600)
    expect(cartOrderItems(cart)).toEqual([{ productId: product.productId, quantity: 2 }])
    expect(JSON.stringify(cartOrderItems(cart))).not.toContain('amountMinor')

    cart = changeCartQuantity(cart, product.productId, -2)
    expect(cartItemCount(cart)).toBe(0)
  })

  it('does not add an unavailable product', () => {
    expect(addCartProduct({}, { ...product, available: false })).toEqual({})
  })
})
