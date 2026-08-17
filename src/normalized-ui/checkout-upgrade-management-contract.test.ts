import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name:string) => readFileSync(new URL(name,import.meta.url),'utf8')

describe('checkout upgrade operational management contract', () => {
  it('separates draft, approval and publication without enabling the feature', () => {
    const panel = read('./CheckoutUpgradeManagementPanel.tsx')
    expect(panel).toContain("auth.permissions.includes('checkout.upgrade.rule.draft')")
    expect(panel).toContain("auth.permissions.includes('checkout.upgrade.rule.approve')")
    expect(panel).toContain("auth.permissions.includes('checkout.upgrade.rule.publish')")
    expect(panel).toContain('/checkout-upgrade-rules/${encodeURIComponent(item.code)}/approve')
    expect(panel).toContain('/checkout-upgrade-rule-versions/${encodeURIComponent(item.id)}/${action}')
    expect(panel).toContain("action:'approve'|'publish'|'rollback-draft'")
    expect(panel).toContain('功能默认关闭')
    expect(panel).not.toContain('/customer-experience/features/checkout_upgrade')
    expect(panel).not.toContain("rolloutState:'enabled'")
  })

  it('uses typed multi-window capacity controls and compact 320/390 layouts', () => {
    const panel = read('./CheckoutUpgradeManagementPanel.tsx')
    const css = read('./checkout-upgrade-management-panel.css')
    expect(panel).toContain("auth.permissions.includes('fulfillment.capacity.draft')")
    expect(panel).toContain("auth.permissions.includes('fulfillment.capacity.approve')")
    expect(panel).toContain("auth.permissions.includes('fulfillment.capacity.publish')")
    expect(panel).toContain('capacityLimitUnits')
    expect(panel).toContain('增加时间窗')
    expect(panel).toContain('paymentState')
    expect(panel).toContain('refundedAmountMinor')
    expect(panel).toContain('complaintCount')
    expect(css).toContain('@media(max-width:640px)')
    expect(css).toContain('@media(max-width:350px)')
    expect(css).toMatch(/min-height:40px/)
  })

  it('records optional checkout display telemetry without blocking the original order', () => {
    const order = read('../../miniprogram/pages/order/index.js')
    const api = read('../../miniprogram/utils/api.js')
    expect(api).toContain('recordCheckoutUpgradeEvent')
    expect(api).toContain('/events`')
    expect(order).toContain("recordCheckoutUpgradeEvent(offer.publicId, 'viewed', null).catch")
    expect(order).toContain("recordCheckoutUpgradeEvent(offer.publicId, 'declined', 'kept_original')")
    expect(order).toContain('await this.submitOrder(null)')
  })
})
