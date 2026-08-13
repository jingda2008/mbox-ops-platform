import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { rankMenuRecommendations } from '../../shared/menu-recommendation'
import { GuestApp, GuestGate } from './GuestApp'
import { guestGatePresentation } from './guest-gate-model'
import { guestMenuProductToMenuProduct } from './menu-product-adapter'
import { guestCartStorageKey, menuRequestDelayMs, type GuestMenuProduct } from './guest-model'

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
    serverRecommendationOrder: 0,
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
    },
    available: true,
  }
}

describe('GuestApp', () => {
  it('renders a compact, friendly connection gate without leaking credentials or fake payment state', () => {
    const html = renderToStaticMarkup(createElement(GuestApp))

    expect(html).toContain('M-BOX')
    expect(html).toContain('欢迎来到 M-BOX')
    expect(html).toContain('正在为您连接桌边服务')
    expect(html).not.toContain('tableQrToken')
    expect(html).not.toContain('支付成功')
    expect(html).not.toContain('RuntimeState')
  })

  it('explains a recognized but unopened table without asking the guest to scan again', () => {
    const html = renderToStaticMarkup(createElement(GuestGate, {
      reason: 'waiting',
      message: 'server copy must not replace the customer-facing flow',
      table: { code: 'W01', displayName: '室外 W01' },
      refreshing: false,
      onRetry: () => undefined,
    }))

    expect(html).toContain('室外 W01 · 桌位已识别')
    expect(html).toContain('欢迎入座，请联系服务人员开台')
    expect(html).toContain('请告知身边的服务人员为 室外 W01 开台')
    expect(html).toContain('无需重复扫码')
    expect(html).toContain('页面每 8 秒自动更新')
    expect(html).toContain('开台完成后会直接进入菜单')
    expect(html).toContain('立即刷新')
    expect(html).not.toContain('我已入座')
    expect(html).not.toContain('请重新扫描')
  })

  it('only offers retry when retry can resolve the gate state', () => {
    expect(guestGatePresentation('temporary_failure', null, '连接超时').action).toBe('再试一次')
    expect(guestGatePresentation('waiting', { code: 'W01', displayName: 'W01' }, '').action).toBe('立即刷新')
    expect(guestGatePresentation('scan_required', null, '').action).toBeNull()
    expect(guestGatePresentation('session_ended', { code: 'W01', displayName: 'W01' }, '').action).toBeNull()
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

  it('isolates an interrupted cart from the next turnover on the same table', () => {
    const base = {
      status: 'active' as const,
      table: { code: 'W01', displayName: '室外 W01' },
      businessDate: '2026-08-13',
      capabilities: ['guest.order.create'],
    }
    expect(guestCartStorageKey({ ...base, expiresAt: '2026-08-13T16:00:00.000Z', cartScope: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
      .not.toBe(guestCartStorageKey({ ...base, expiresAt: '2026-08-13T18:00:00.000Z', cartScope: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
  })
})
