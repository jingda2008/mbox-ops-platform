import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { rankMenuRecommendations } from '../../shared/menu-recommendation'
import { GuestApp } from './GuestApp'
import { guestMenuProductToMenuProduct } from './menu-product-adapter'
import { menuRequestDelayMs, type GuestMenuProduct } from './guest-model'

function recommendationProduct(
  code: string,
  categoryCode: string,
  intent: GuestMenuProduct['recommendation']['intentTags'][number],
): GuestMenuProduct {
  return {
    productId: `00000000-0000-4000-8000-${code.padStart(12, '0')}`,
    code,
    name: code,
    categoryCode,
    categoryName: '酒水',
    beverageFamily: categoryCode === 'cocktail' || categoryCode === 'beer' || categoryCode === 'spirits' || categoryCode === 'sparkling'
      ? categoryCode
      : 'none',
    specification: null,
    aliases: [],
    tags: [],
    imageUrl: null,
    description: null,
    sortOrder: 1,
    availableFrom: null,
    availableUntil: null,
    guestVisible: true,
    requiresFulfillment: true,
    maxOrderQuantity: 50,
    amountMinor: 10_000,
    currency: 'CNY',
    fulfillmentStation: 'bar',
    productKind: 'single',
    bundleComponents: [],
    recommendation: {
      enabled: true,
      priority: 0,
      badge: '',
      headline: '',
      reason: '',
      minimumPartySize: 1,
      maximumPartySize: 100,
      sceneTags: [],
      intentTags: [intent],
      tasteTags: [],
      dwellTags: [],
      singleWaveEligible: true,
      expectedPrepMinutes: 8,
      holdMinutes: 10,
      upgradeProductId: null,
      contributionPositive: true,
    },
    available: true,
  }
}

describe('GuestApp', () => {
  it('renders a compact, friendly connection gate without leaking credentials or fake payment state', () => {
    const html = renderToStaticMarkup(createElement(GuestApp))

    expect(html).toContain('M-BOX')
    expect(html).toContain('正在为您准备')
    expect(html).toContain('正在连接您的桌位')
    expect(html).not.toContain('tableQrToken')
    expect(html).not.toContain('支付成功')
    expect(html).not.toContain('RuntimeState')
  })

  it('changes recommendation order for different guest intents instead of returning the same list', () => {
    const products = [
      recommendationProduct('COCKTAIL', 'cocktail', 'relaxed'),
      recommendationProduct('SPIRITS', 'spirits', 'energetic'),
      recommendationProduct('SPARKLING', 'sparkling', 'ritual'),
    ].map(guestMenuProductToMenuProduct)

    expect(rankMenuRecommendations(products, { partySize: 2, intent: 'relaxed' })[0]?.product.sku).toBe('COCKTAIL')
    expect(rankMenuRecommendations(products, { partySize: 2, intent: 'energetic' })[0]?.product.sku).toBe('SPIRITS')
    expect(rankMenuRecommendations(products, { partySize: 2, intent: 'ritual' })[0]?.product.sku).toBe('SPARKLING')
  })

  it('loads the first menu immediately and only debounces later searches', () => {
    expect(menuRequestDelayMs(false)).toBe(0)
    expect(menuRequestDelayMs(true)).toBe(280)
  })
})
