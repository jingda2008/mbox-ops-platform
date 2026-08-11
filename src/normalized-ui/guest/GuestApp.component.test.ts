import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GuestApp } from './GuestApp'
import { rankRecommendations } from './recommendation-ranking'
import { menuRequestDelayMs, type GuestMenuProduct } from './guest-model'

function recommendationProduct(code: string, categoryCode: string): GuestMenuProduct {
  return {
    productId: `00000000-0000-4000-8000-${code.padStart(12, '0')}`,
    code,
    name: code,
    categoryCode,
    specification: null,
    aliases: [],
    imageUrl: null,
    description: null,
    amountMinor: 10_000,
    currency: 'CNY',
    fulfillmentStation: 'bar',
    productKind: 'single',
    bundleComponents: [],
    recommendation: {
      featured: false,
      priority: 0,
      partySizeMatched: true,
      intents: [],
      badge: null,
      valueCopy: null,
      upgradeProductId: null,
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
      recommendationProduct('COCKTAIL', 'cocktail'),
      recommendationProduct('BEER', 'beer'),
      recommendationProduct('SPIRITS', 'spirits'),
      recommendationProduct('SPARKLING', 'sparkling'),
    ]

    expect(rankRecommendations(products, 'easy')[0]?.code).toBe('COCKTAIL')
    expect(rankRecommendations(products, 'party')[0]?.code).toBe('SPIRITS')
    expect(rankRecommendations(products, 'ritual')[0]?.code).toBe('SPARKLING')
  })

  it('loads the first menu immediately and only debounces later searches', () => {
    expect(menuRequestDelayMs(false)).toBe(0)
    expect(menuRequestDelayMs(true)).toBe(280)
  })
})
