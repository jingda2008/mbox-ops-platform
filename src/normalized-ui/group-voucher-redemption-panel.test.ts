import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./GroupVoucherRedemptionPanel.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./group-voucher-redemption-panel.css', import.meta.url), 'utf8')

describe('group voucher redemption panel', () => {
  it('limits the cashier surface to the four supported platforms and a prepare-then-consume path', () => {
    expect(source).toContain("auth.permissions.includes('commercial.voucher.redeem')")
    expect(source).toContain("auth.permissions.includes('commercial.voucher.view')")
    expect(source).toContain('/api/commercial-ops/vouchers/platforms')
    expect(source).toContain('/api/commercial-ops/vouchers/prepare')
    expect(source).toContain('/api/commercial-ops/vouchers/redeem')
    expect(source).toContain('prepareHandle')
    expect(source).toContain('大众点评')
    expect(source).toContain('美团')
    expect(source).toContain('抖音')
    expect(source).toContain('快手')
    expect(source).not.toContain('支付宝')
    expect(source).not.toContain('微信')
    expect(source).toContain('InventoryBarcodeScanner')
    expect(source).toContain('确认核销')
  })

  it('keeps success and failure states readable on a phone-width cashier screen', () => {
    expect(source).toContain('role={notice.tone === \'error\' ? \'alert\' : \'status\'}')
    expect(css).toContain('min-height: 46px')
    expect(css).toContain('@media (max-width: 480px)')
    expect(css).toContain('overflow-wrap: anywhere')
  })
})
