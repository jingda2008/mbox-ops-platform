import { describe, expect, it } from 'vitest'
import {
  createPrintTicketSnapshot,
  inferPrintTicketOutputProfile,
  isPrintTicketSnapshot,
  printTicketPageHeightMm,
  paymentLabel,
  parsePrintTicketSnapshot,
  renderPrintTicketHtml,
  ticketToJson,
} from './print-ticket-layout.js'

function ticket(kind: 'cashier_settlement' | 'cashier_payment' | 'bar_production' | 'kitchen_production') {
  return createPrintTicketSnapshot({
    kind,
    subtitle: 'M-BOX 现场系统',
    test: true,
    issuedAt: '2026-08-22T14:00:00.000Z',
    businessDate: '2026-08-22',
    ticketReference: 'TEST-PRINT-0001',
    tableCode: 'L01',
    guestCount: 3,
    operatorLabel: '测试员工',
    note: '少冰，不要香菜',
    payment: kind === 'cashier_payment' ? { provider: 'wechat', method: 'jsapi' } : null,
    lines: [{ name: '金汤力', quantity: 2, note: '少冰', totalAmountMinor: 17600 }],
    totalAmountMinor: 17600,
    currency: 'CNY',
  })
}

describe('print ticket layout', () => {
  it('uses a distinct, immutable title for every operational ticket', () => {
    expect(ticket('cashier_settlement').title).toBe('结账单')
    expect(ticket('cashier_payment').title).toBe('支付凭条')
    expect(ticket('bar_production').title).toBe('吧台调酒制作单')
    expect(ticket('kitchen_production').title).toBe('后厨制作单')
    expect(renderPrintTicketHtml(ticket('cashier_settlement'))).toContain('陆家嘴中心 L+MALL')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).not.toContain('陆家嘴中心 L+MALL')
  })

  it('serializes a safe snapshot and renders an 80mm brand-green ticket', () => {
    const source = ticket('bar_production')
    const json = ticketToJson(source)
    expect(isPrintTicketSnapshot(json)).toBe(true)
    expect(parsePrintTicketSnapshot(json)).toEqual(source)
    const html = renderPrintTicketHtml(source)
    expect(html).toContain('@page { size: 80mm auto;')
    expect(html).toContain('M-BOX · SHANGHAI')
    expect(html).toContain('吧台调酒制作单')
    expect(html).toContain('系统打印测试')
    expect(html).toContain('少冰，不要香菜')
    expect(html).toContain('table-hero')
  })

  it('uses the payment provider and method instead of inventing a payment channel', () => {
    expect(paymentLabel({ provider: 'wechat', method: 'jsapi' })).toBe('微信支付')
    expect(paymentLabel({ provider: 'physical_pos', method: 'card' })).toBe('POS刷卡支付')
    expect(renderPrintTicketHtml(ticket('cashier_settlement'))).toContain('待选择')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).toContain('微信支付')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).toContain('消费人数')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).toContain('3 位')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).toContain('金汤力')
    expect(renderPrintTicketHtml(ticket('cashier_payment'))).toContain('¥176.00')
  })

  it('adapts from known CUPS paper capability without treating A4 as thermal paper', () => {
    expect(inferPrintTicketOutputProfile('PageSize/Media Size: *80mm 58mm A4')).toEqual({ paper: '80mm', thermal: true })
    expect(inferPrintTicketOutputProfile('PageSize/Media Size: Letter *A4')).toEqual({ paper: 'a4', thermal: false })
    expect(printTicketPageHeightMm(ticket('bar_production'), { paper: '80mm', thermal: true })).toBeGreaterThan(90)
  })

  it('rejects a malformed or empty ticket before it reaches a printer', () => {
    expect(() => parsePrintTicketSnapshot({ schemaVersion: 1, kind: 'bar_production' })).toThrow('subtitle')
    expect(() => createPrintTicketSnapshot({
      kind: 'kitchen_production', subtitle: '测试', test: true, issuedAt: '2026-08-22T14:00:00.000Z',
      businessDate: '2026-08-22', ticketReference: 'TEST-EMPTY', tableCode: 'L01', guestCount: null, operatorLabel: null,
      note: null, payment: null, lines: [], totalAmountMinor: null, currency: 'CNY',
    })).toThrow('lines')
  })
})
