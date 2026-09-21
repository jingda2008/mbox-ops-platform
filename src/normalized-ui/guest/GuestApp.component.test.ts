import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { rankMenuRecommendations } from '../../shared/menu-recommendation'
import { GuestApp, GuestGate, TableOrdersPanel, paymentStatusCopy } from './GuestApp'
import type { GuestOrderResult, GuestTableOrder } from './guest-api'
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
    expect(guestCartStorageKey({ ...base, cartScope: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
      .not.toBe(guestCartStorageKey({ ...base, cartScope: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
  })

  it.each(['succeeded','closed','refunded'])('shows recovered %s checkout without inviting another payment', status => {
    const result = {payment:{status,simulated:false,providerAction:{status:'resolved',terminalPaymentStatus:status,payload:null}}} as GuestOrderResult
    const copy = paymentStatusCopy(result,null)
    expect(copy.title).toContain('已找回原')
    expect(copy.detail).not.toContain('重新发起')
    expect(copy.detail).not.toContain('没有受理')
  })

  it('lets the authoritative table order replace a stale initial payment result', () => {
    const result = {
      payment: {
        status: 'pending', simulated: false, mode: 'wechat_jsapi',
        providerAction: { status: 'pending', payload: {} },
      },
    } as GuestOrderResult
    const paidOrder = { paymentStatus: 'paid', paymentAccess: 'not_required' } as GuestTableOrder
    const reviewingOrder = { paymentStatus: 'pending', paymentAccess: 'status_review' } as GuestTableOrder

    expect(paymentStatusCopy(result, paidOrder).title).toBe('支付已经完成')
    expect(paymentStatusCopy(result, reviewingOrder).title).toBe('订单已建立，付款状态待核对')
  })

  it('turns a WeChat payment cancellation into a durable safe-release request', () => {
    const source = readFileSync(new URL('./GuestApp.tsx', import.meta.url), 'utf8')

    expect(source).toContain("error.code === 'PAYMENT_CANCELLED'")
    expect(source).toContain('await api.abandonCheckout(orderPublicId')
    expect(source).toContain('await api.abandonCheckout(result.order.publicId')
    expect(source).toContain('订单和占用已安全释放')
  })
})


it('renders actual item and bundle progress while leaving unresolved stopped amounts unpayable', () => {
  const base: GuestTableOrder = { publicId: 'original', round: 1, channel: 'staff_assisted', sourceText: '员工协助点单',
    status: 'fulfilling', visibility: 'shared', isMine: false, createdAt: '2026-09-13T10:00:00Z', paymentStatus: 'unpaid',
    paymentAccess: 'status_review', settlementReviewRequired: true, payableAmountMinor: 0, currency: 'CNY',
    items: [{ productId: 'water', name: '水', quantity: 5, status: 'preparing', progressText: '暂停 2 份 · 准备中 3 份' },
      { productId: 'bundle', name: '套餐', quantity: 1, status: 'preparing', components: [{ name: '套餐鸡尾酒', quantity: 2, progressText: '暂停 1 份 · 已备齐 1 份' }] }] }
  const render = (order: GuestTableOrder) => renderToStaticMarkup(createElement(TableOrdersPanel, { orders: [order], loading: false, onRefresh() {}, onPay() {} }))
  const review = render(base)
  expect(review).toContain('水 × 5'); expect(review).toContain('暂停 2 份 · 准备中 3 份')
  expect(review).toContain('套餐鸡尾酒 × 2'); expect(review).toContain('暂停 1 份 · 已备齐 1 份')
  expect(review).toContain('商品停止金额待员工核对'); expect(review).not.toContain('微信支付')
  const payable = render({ ...base, settlementReviewRequired: false, paymentAccess: 'available', payableAmountMinor: 2400, receivableReductionMinor: 1600 })
  expect(payable).toContain('退菜减额'); expect(payable).toContain('微信支付')
  const stopped = render({ ...base, settlementReviewRequired: false, paymentAccess: 'not_required', receivableReductionMinor: 4000 })
  expect(stopped).toContain('无需再付款'); expect(stopped).not.toContain('等待付款'); expect(stopped).not.toContain('微信支付')
})
