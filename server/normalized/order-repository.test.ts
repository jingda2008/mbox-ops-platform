import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './index.js'
import {
  OrderDeliveryBlockedError,
  OrderProductCostUnavailableError,
  OrderProductUnavailableError,
  OrderRepository,
} from './order-repository.js'
import { PricingAuthorizationDeniedError } from './pricing-authorization-policy.js'
import type { VerifiedPricingAuthorization } from './pricing-authorization-policy.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const sessionId = '33333333-3333-4333-8333-333333333333'
const orderId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'
const itemId = '66666666-6666-4666-8666-666666666666'
const employeeId = '77777777-7777-4777-8777-777777777777'

interface Call { sql: string; values: readonly unknown[] }
type Response = { rows: Record<string, unknown>[]; rowCount?: number }

class ScriptedTransaction implements ScopedTransaction {
  readonly scope = { tenantId, storeId }
  readonly calls: Call[] = []
  constructor(private readonly responses: Response[]) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) {
    this.calls.push({ sql: normalize(text), values: [...values] })
    const response = this.responses.shift()
    if (!response) throw new Error(`Unexpected query: ${normalize(text)}`)
    return { rows: response.rows as Row[], rowCount: response.rowCount ?? response.rows.length }
  }
}

describe('OrderRepository', () => {
  it('locks the target session, prices on the server and inserts only target order rows', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [priceRow()] },
      { rows: [orderRow()] },
      { rows: [itemRow()] },
    ])

    const order = await new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-public-0001',
      channel: 'staff_assisted',
      createdByEmployeeId: employeeId,
      lines: [{ productId, quantity: 2 }],
    })

    expect(order).toMatchObject({ subtotalAmountMinor: 17600, discountAmountMinor: 0, totalAmountMinor: 17600 })
    expect(order).toMatchObject({ settlementMode: 'table_tab', paymentStatus: 'unpaid' })
    expect(tx.calls[0]?.sql).toContain("id = $3::uuid AND status = 'open' FOR KEY SHARE")
    expect(tx.calls[1]?.sql).toContain('JOIN LATERAL')
    expect(tx.calls[1]?.sql).toContain("product.status = 'active'")
    expect(tx.calls[1]?.sql).toContain("candidate.price_type = 'standard'")
    expect(tx.calls[1]?.sql).toContain('FOR SHARE OF product')
    expect(tx.calls[1]?.values[2]).toBe(JSON.stringify([{
      request_index: 0,
      product_id: productId,
    }]))
    expect(tx.calls[2]?.sql).toContain('INSERT INTO mbox.orders')
    expect(tx.calls[2]?.sql).toContain('settlement_mode')
    expect(tx.calls[2]?.values[5]).toBe('table_tab')
    expect(tx.calls[3]?.sql).toContain('INSERT INTO mbox.order_items')
    expect(tx.calls[3]?.values[15]).toBe(JSON.stringify({
      unitCostMinor: 1050,
      totalCostMinor: 2100,
      source: 'catalog_product',
      authority: 'strong_order_item_columns',
    }))
    expect(tx.calls[3]?.values.slice(16, 22)).toEqual([
      1050,
      2100,
      'catalog_product',
      productId,
      null,
      '2026-08-11T11:59:00.000Z',
    ])
  })

  it('rejects client-selected price types and full line discounts before database access', async () => {
    const tx = new ScriptedTransaction([])
    const hostileLine = {
      productId,
      quantity: 1,
      priceType: 'promotion',
      discountAmountMinor: 8800,
    }
    await expect(new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-public-hostile',
      channel: 'guest_qr',
      lines: [hostileLine],
    })).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    expect(tx.calls).toHaveLength(0)
  })

  it('rejects a forged in-process pricing authorization before database access', async () => {
    const tx = new ScriptedTransaction([])
    const forged = {
      authorizationId: '88888888-8888-4888-8888-888888888888',
      kind: 'gift',
      sourceType: 'employee',
      sourceId: employeeId,
      amountMinor: 8800,
      maximumAmountMinor: 8800,
      authorizedByEmployeeId: employeeId,
      capability: 'order.gift',
    } as const satisfies VerifiedPricingAuthorization
    await expect(new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-public-forged',
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1 }],
    }, forged)).rejects.toBeInstanceOf(PricingAuthorizationDeniedError)
    expect(tx.calls).toHaveLength(0)
  })

  it('rejects a missing product price before creating an order', async () => {
    const tx = new ScriptedTransaction([{ rows: [{ id: sessionId }] }, { rows: [] }])
    await expect(new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-public-0002',
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1 }],
    })).rejects.toBeInstanceOf(OrderProductUnavailableError)
    expect(tx.calls).toHaveLength(2)
  })

  it('fails closed before order creation when the catalog has no authoritative cost', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [{ ...priceRow(), cost_amount_minor: null }] },
    ])
    await expect(new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-missing-cost-0001',
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1 }],
    })).rejects.toBeInstanceOf(OrderProductCostUnavailableError)
    expect(tx.calls).toHaveLength(2)
  })

  it.each([
    [{ max_order_quantity: 1 }, 'guest_qr' as const, 2],
    [{ allowed_channels: ['cashier'] }, 'guest_qr' as const, 1],
    [{ available_from: '10:00', available_until: '11:00' }, 'guest_qr' as const, 1],
    [{ guest_visible: false }, 'guest_qr' as const, 1],
  ])('enforces quantity, channel, visibility and local time from typed product fields', async (fields, channel, quantity) => {
    const tx = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [{ ...priceRow(), ...fields }] },
    ])
    await expect(new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: `order-availability-${quantity}-${channel}`,
      channel,
      lines: [{ productId, quantity }],
    })).rejects.toBeInstanceOf(OrderProductUnavailableError)
    expect(tx.calls).toHaveLength(2)
  })

  it('keeps delivery separate from KDS and requires every KDS task to be ready', async () => {
    const delivered = { ...itemRow(), status: 'delivered' }
    const tx = new ScriptedTransaction([{ rows: [delivered] }])
    const item = await new OrderRepository(tx).markDelivered(itemId, employeeId)
    expect(item.status).toBe('delivered')
    expect(tx.calls[0]?.sql).toContain('NOT EXISTS')
    expect(tx.calls[0]?.sql).toContain("task.status <> 'ready'")
    expect(tx.calls[0]?.sql).not.toContain('UPDATE mbox.kds_tasks')
  })

  it('does not deliver when the conditional row lock loses the race', async () => {
    const tx = new ScriptedTransaction([{ rows: [] }])
    await expect(new OrderRepository(tx).markDelivered(itemId, employeeId))
      .rejects.toBeInstanceOf(OrderDeliveryBlockedError)
  })
})

function priceRow(): Record<string, unknown> {
  return {
    request_index: 0,
    product_id: productId,
    product_code: 'COCKTAIL-01',
    product_name: 'Signature Cocktail',
    category_code: 'cocktail',
    product_kind: 'single',
    fulfillment_station: 'bar',
    product_snapshot: { image: 'cocktail.jpg' },
    guest_visible: true,
    allowed_channels: ['guest_qr', 'staff_assisted', 'cashier', 'reservation', 'integration'],
    max_order_quantity: 50,
    available_from: null,
    available_until: null,
    kds_priority: 100,
    fulfillment_sla_seconds: 300,
    cost_amount_minor: '1050',
    product_updated_at: '2026-08-11T11:59:00.000Z',
    price_type: 'standard',
    amount_minor: '8800',
    currency: 'CNY',
    store_timezone: 'Asia/Shanghai',
    store_local_time: '12:00',
    store_iso_weekday: 1,
  }
}

function orderRow(): Record<string, unknown> {
  return {
    id: orderId,
    table_session_id: sessionId,
    public_id: 'order-public-0001',
    channel: 'staff_assisted',
    settlement_mode: 'table_tab',
    status: 'submitted',
    payment_status: 'unpaid',
    subtotal_amount_minor: '17600',
    discount_amount_minor: '0',
    total_amount_minor: '17600',
    currency: 'CNY',
    note: null,
    created_by_employee_id: employeeId,
    created_by_customer_id: null,
    created_at: '2026-08-11T12:00:00.000Z',
    submitted_at: '2026-08-11T12:00:00.000Z',
  }
}

function itemRow(): Record<string, unknown> {
  return {
    id: itemId,
    order_id: orderId,
    product_id: productId,
    parent_order_item_id: null,
    quantity: 2,
    unit_price_minor: '8800',
    discount_amount_minor: '0',
    total_amount_minor: '17600',
    currency: 'CNY',
    fulfillment_station: 'bar',
    fulfillment_priority: 100,
    fulfillment_due_at: '2026-08-11T12:05:00.000Z',
    product_snapshot: { name: 'Signature Cocktail' },
    cost_snapshot: {},
    unit_cost_minor_at_submission: '1050',
    total_cost_minor_at_submission: '2100',
    cost_source: 'catalog_product',
    cost_reference_product_id: productId,
    cost_reference_order_item_id: null,
    cost_reference_product_updated_at: '2026-08-11T11:59:00.000Z',
    status: 'submitted',
    note: null,
    created_at: '2026-08-11T12:00:00.000Z',
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
