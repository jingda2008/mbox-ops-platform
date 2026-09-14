import { describe, expect, it } from 'vitest'
import { settlementDisplayNumber } from './settlement-display-number.js'
import {
  createPrintTicketSnapshot,
  inferPrintTicketOutputProfile,
  isPrintTicketSnapshot,
  printTicketPageHeightMm,
  paymentLabel,
  parsePrintTicketSnapshot,
  renderPrintTicketHtml,
  ticketToJson,
  paginatePrintTicket,
} from './print-ticket-layout.js'

function ticket(kind: 'cashier_settlement' | 'cashier_payment' | 'cashier_refund' | 'bar_production' | 'kitchen_production') {
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
    payment: kind === 'cashier_payment' || kind === 'cashier_refund' ? { provider: 'wechat', method: 'jsapi' } : null,
    lines: [{ name: '金汤力', quantity: 2, note: '少冰', totalAmountMinor: 17600 }],
    totalAmountMinor: 17600,
    currency: 'CNY',
  })
}

describe('print ticket layout', () => {
  it('keeps the OCR number across serialization and pages while preserving the full trace at the footer', () => {
    const number = settlementDisplayNumber('2026-09-14T16:01:02Z', 'tenant', 'store', 'session')
    expect(number).toMatch(/^20260915-000102-\d{6}$/)
    expect(settlementDisplayNumber('2026-09-14T16:01:02Z', 'tenant', 'store', 'session-0')).toBe('20260915-000102-066794')
    expect(()=>settlementDisplayNumber('invalid', 'tenant', 'store', 'session')).toThrow('开票时间')
    expect(settlementDisplayNumber('2026-09-15T00:01:02+08:00', 'tenant', 'store', 'session')).toBe(number)
    const source = createPrintTicketSnapshot({...ticket('cashier_payment'), kind:'table_settlement',
      issuedAt:'2026-09-14T16:01:02Z',businessDate:'2026-09-14',displayNumber:number,
      ticketReference:'original-session-trace',lines:Array.from({length:60},()=>({name:'啤酒',quantity:1}))})
    expect(parsePrintTicketSnapshot(ticketToJson(source))).toEqual(source)
    const pages=paginatePrintTicket({...source,lines:[...source.lines,...source.lines]})
    expect(pages.map(page=>page.displayNumber)).toEqual([number,number])
    for (const page of pages) {
      const html=renderPrintTicketHtml(page)
      expect(html).toContain(`单号：${number}`)
      expect(html).toContain('<footer>原始追溯码：original-session-trace<br>')
    }
    const legacy=ticketToJson({...source,displayNumber:undefined})
    expect(legacy).not.toHaveProperty('displayNumber')
    expect(parsePrintTicketSnapshot(legacy)).not.toHaveProperty('displayNumber')
    expect(renderPrintTicketHtml(parsePrintTicketSnapshot(legacy))).not.toContain('原始追溯码：')
    expect(()=>createPrintTicketSnapshot({...source,displayNumber:'20260915-1-123456'})).toThrow('展示单号')
    expect(()=>createPrintTicketSnapshot({...source,kind:'cashier_payment'})).toThrow('票种')
  })

  it('brands new checkout snapshots while retaining historical summaries and financial facts', () => {
    const original = createPrintTicketSnapshot({...ticket('cashier_payment'), kind:'order_summary', test:false,
      subtitle:'M-BOX · 本桌次完整消费账单', payment:null, totalAmountMinor:null,
      lines:[{name:'原订单应付',quantity:1,totalAmountMinor:40800},
        {name:'桌次实际收款',quantity:1,totalAmountMinor:10800}]})
    const checkout = createPrintTicketSnapshot({...original,documentRole:'checkout',
      subtitle:'陆家嘴中心 L+MALL · 本桌次完整消费账单'})
    expect(parsePrintTicketSnapshot(ticketToJson(checkout))).toEqual(checkout)
    expect(checkout.title).toBe('结账单')
    expect(checkout.lines).toEqual(original.lines)
    expect(checkout.totalAmountMinor).toBeNull()
    expect(parsePrintTicketSnapshot(ticketToJson(original)).title).toBe('订单汇总单（非制作指令）')
    expect(ticketToJson(original)).not.toHaveProperty('documentRole')
    for (const paper of ['58mm','80mm'] as const) {
      const html = renderPrintTicketHtml(checkout,{paper,thermal:true})
      expect(html).toContain('<p class="venue">陆家嘴中心 L+MALL</p><h1>结账单</h1>')
      expect(html.match(/陆家嘴中心 L\+MALL/g)).toHaveLength(1)
      expect(html).not.toContain('非制作')
      expect(html).not.toContain('系统打印测试')
      expect(html).toContain('¥408.00')
      expect(html).toContain('¥108.00')
    }
    const pages = paginatePrintTicket({...checkout,lines:Array.from({length:61},()=>original.lines[0])})
    expect(pages.map(page=>parsePrintTicketSnapshot(ticketToJson(page)).title)).toEqual(['结账单','结账单'])
    expect(()=>createPrintTicketSnapshot({...checkout,kind:'bar_production'})).toThrow('票种')
    expect(()=>parsePrintTicketSnapshot({...ticketToJson(checkout),documentRole:'unknown'})).toThrow('用途')
  })

  it('renders historical unit prices without deriving them from discounted totals', () => {
    const source = createPrintTicketSnapshot({...ticket('cashier_settlement'), lines: [
      {name:'啤酒',quantity:4,unitAmountMinor:4000,totalAmountMinor:12000},
      {name:'套餐内鸡尾酒',quantity:1,note:'套餐内商品，不另收费',unitAmountMinor:null,totalAmountMinor:null},
    ]})
    for (const paper of ['58mm','80mm'] as const) {
      const html = renderPrintTicketHtml(source,{paper,thermal:true})
      expect(html).toContain('单价 ¥40.00')
      expect(html).toContain('¥120.00')
      expect(html).not.toContain('单价 ¥30.00')
      expect(html).toContain('套餐内商品，不另收费')
    }
  })
  it('roundtrips new document kinds, keeps 300-character notes, and never clips long table bills', () => {
    for (const kind of ['order_summary','delivery','table_settlement'] as const) {
      const source=createPrintTicketSnapshot({...ticket('cashier_payment'),kind,note:'注'.repeat(300)})
      expect(parsePrintTicketSnapshot(ticketToJson(source))).toEqual(source)
      expect(renderPrintTicketHtml(source)).toContain(source.title)
    }
    const lines=Array.from({length:125},(_,i)=>({name:`菜品${i}`,quantity:1,note:'注'.repeat(300)}))
    const pages=paginatePrintTicket({...ticket('cashier_payment'),kind:'table_settlement',lines})
    expect(pages.map(p=>p.lines.length)).toEqual([60,60,5])
    expect(pages.flatMap(p=>p.lines).map(l=>l.name)).toEqual(lines.map(l=>l.name))
    expect(pages.map(p=>p.totalAmountMinor)).toEqual([null,null,17600])
    expect(pages[2].subtitle).toContain('第3/3页')
  })
  it('uses a distinct, immutable title for every operational ticket', () => {
    expect(ticket('cashier_settlement').title).toBe('预结账单（未确认收款）')
    expect(ticket('cashier_payment').title).toBe('支付凭条')
    expect(ticket('cashier_refund').title).toBe('退款凭条')
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
