import { describe, expect, it } from 'vitest'
import type { ScopedTransaction } from './index.js'
import {
  OrderDeliveryBlockedError,
  OrderProductUnavailableError,
  OrderRepository,
} from './order-repository.js'
import { PricingAuthorizationDeniedError } from './pricing-authorization-policy.js'
import type { VerifiedPricingAuthorization } from './pricing-authorization-policy.js'
import {PricingAuthorizationPolicy} from './pricing-authorization-policy.js'
import {pricingLineFingerprint} from './pricing-line-allocation.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const storeId = '22222222-2222-4222-8222-222222222222'
const sessionId = '33333333-3333-4333-8333-333333333333'
const orderId = '44444444-4444-4444-8444-444444444444'
const productId = '55555555-5555-4555-8555-555555555555'
const itemId = '66666666-6666-4666-8666-666666666666'
const employeeId = '77777777-7777-4777-8777-777777777777'
const choiceGroupId = '88888888-8888-4888-8888-888888888888'
const choiceProductId = '99999999-9999-4999-8999-999999999999'

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
  it('writes a bound discount to the selected second portion, leaving first price and both costs intact',async()=>{
    const lines=[{productId,quantity:1,note:'第一杯原价'},{productId,quantity:1,note:'第二杯9.9元'}]
    const tx=new ScriptedTransaction([{rows:[{id:sessionId}]},{rows:[priceRow(),{...priceRow(),request_index:1}]},
      {rows:[{...orderRow(),discount_amount_minor:'7810',total_amount_minor:'9790'}]},
      {rows:[{...itemRow(),quantity:1,total_amount_minor:'8800'}]},
      {rows:[{...itemRow(),quantity:1,discount_amount_minor:'7810',total_amount_minor:'990'}]},
    ])
    const authorization=await new PricingAuthorizationPolicy({
      authorize:async()=>({authorized:true,authorizationId:itemId,kind:'discount',sourceType:'benefit',sourceId:itemId,
        amountMinor:7810,maximumAmountMinor:7810,currency:'CNY',lineAllocations:lines.map((line,index)=>({
          requestIndex:index,productId,quantity:1,unitPriceMinor:8800,discountAmountMinor:index===1?7810:0,lineFingerprint:pricingLineFingerprint(line),
        }))}),consume:async()=>{},
    }).authorize(tx,{scope:tx.scope,actor:{type:'system',ref:'pricing-test'},tableSessionId:sessionId,channel:'staff_assisted',lines},{sourceType:'benefit',sourceId:itemId})
    const result=await new OrderRepository(tx).createSubmitted({tableSessionId:sessionId,publicId:'priced-portions',channel:'staff_assisted',lines},authorization)
    expect(result.totalAmountMinor).toBe(9790)
    const inserts=tx.calls.filter(call=>call.sql.includes('INSERT INTO mbox.order_items'))
    expect(inserts.map(call=>call.values.slice(7,10))).toEqual([[8800,0,8800],[8800,7810,990]])
    expect(inserts.map(call=>call.values[17])).toEqual([1050,1050])
  })
  it('quotes with the submission price and cost functions without creating or reserving anything',async()=>{
    const tx=new ScriptedTransaction([{rows:[priceRow()]}])
    const quote=await new OrderRepository(tx).quoteCurrent([{productId,quantity:2,note:'保留口味'}],'staff_assisted')
    expect(quote).toMatchObject({pricingBasis:'standard_only',subtotalAmountMinor:17600,costAmountMinor:2100,currency:'CNY',items:[{productId,quantity:2,costMinor:2100,note:'保留口味'}]})
    expect(tx.calls).toHaveLength(1);expect(tx.calls.every(call=>!/(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|mbox\.)/.test(call.sql))).toBe(true)
  })
  it('never guesses zero quote cost when catalog cost is unknown',async()=>{
    const tx=new ScriptedTransaction([{rows:[{...priceRow(),cost_amount_minor:null}]}])
    expect(await new OrderRepository(tx).quoteCurrent([{productId,quantity:1}],'staff_assisted')).toMatchObject({costAmountMinor:null,items:[{costMinor:null}]})
  })
  it('rejects client quote prices just as actual submission does',async()=>{
    const tx=new ScriptedTransaction([])
    await expect(new OrderRepository(tx).quoteCurrent([{productId,quantity:1,discountAmountMinor:1} as never],'guest_qr')).rejects.toThrow(PricingAuthorizationDeniedError)
    expect(tx.calls).toHaveLength(0)
  })
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

  it('submits an order with an explicit unavailable-cost snapshot when catalog cost is incomplete', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [{ ...priceRow(), cost_amount_minor: null }] },
      { rows: [orderRow()] },
      { rows: [{
        ...itemRow(),
        unit_cost_minor_at_submission: null,
        total_cost_minor_at_submission: null,
        cost_source: 'unavailable',
        cost_reference_product_id: null,
        cost_reference_product_updated_at: null,
      }] },
    ])
    const order = await new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-missing-cost-0001',
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1 }],
    })
    expect(order.items[0]).toMatchObject({
      costSource: 'unavailable',
      unitCostMinorAtSubmission: null,
      totalCostMinorAtSubmission: null,
    })
    expect(tx.calls).toHaveLength(4)
    expect(tx.calls[3]?.values.slice(16, 22)).toEqual([
      null, null, 'unavailable', null, null, null,
    ])
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

  it.each([
    ['6800',6800], ['0',0], [null,undefined], ['-1',undefined], ['9007199254740992',undefined],
  ])('persists a concrete bundle choice with authoritative reference price %s, without charging it twice', async (referencePrice,expectedReference) => {
    const tx = new ScriptedTransaction([
      { rows: [{ id: sessionId }] },
      { rows: [{ ...priceRow(), product_kind: 'bundle', fulfillment_station: 'none' }] },
      { rows: [] },
      { rows: [{...choiceOptionRow(),component_reference_price_minor:referencePrice,
        component_product_snapshot:{singlePriceReferenceMinor:999999}}] },
      { rows: [{
        request_index: 0,
        bundle_product_id: productId,
        choice_group_id: choiceGroupId,
        selection_count: 1,
        option_count: 1,
      }] },
      { rows: [{ ...orderRow(), subtotal_amount_minor: '8800', total_amount_minor: '8800' }] },
      { rows: [{
        ...itemRow(), quantity: 1, total_amount_minor: '8800',
        unit_cost_minor_at_submission: '600', total_cost_minor_at_submission: '600',
        cost_source: 'bundle_components', cost_reference_product_updated_at: null,
      }] },
      { rows: [{
        ...itemRow(),
        id: choiceProductId,
        product_id: choiceProductId,
        parent_order_item_id: itemId,
        quantity: 1,
        unit_price_minor: '0',
        total_amount_minor: '0',
        fulfillment_station: 'bar',
        unit_cost_minor_at_submission: '0',
        total_cost_minor_at_submission: '0',
        cost_source: 'included_in_parent',
      }] },
    ])

    const order = await new OrderRepository(tx).createSubmitted({
      tableSessionId: sessionId,
      publicId: 'order-public-bundle-choice',
      channel: 'guest_qr',
      lines: [{ productId, quantity: 1, bundleSelections: [{ groups: [{
        groupId: choiceGroupId,
        productIds: [choiceProductId],
      }] }] }],
    })

    expect(order.items).toHaveLength(2)
    expect(tx.calls[6]?.values[14]).toContain('bundleSelections')
    expect(tx.calls[6]?.values.slice(16,22)).toEqual([
      600,600,'bundle_components',productId,null,null,
    ])
    expect(tx.calls[7]?.values[4]).toBe(choiceProductId)
    expect(tx.calls[7]?.values[14]).toContain('任选鸡尾酒')
    const snapshot=JSON.parse(String(tx.calls[7]?.values[14]))
    expect(snapshot.singlePriceReferenceMinor).toBe(expectedReference)
    expect(tx.calls[7]?.values.slice(7,10)).toEqual([0,0,0])
    expect(tx.calls[3]?.sql).toContain("reference_price.price_type='standard'")
  })

  it('rejects a configurable bundle when a physical unit has no concrete choice', async () => {
    const tx = new ScriptedTransaction([
      { rows: [{ ...priceRow(), product_kind: 'bundle', fulfillment_station: 'none' }] },
      { rows: [] },
      { rows: [choiceOptionRow()] },
      { rows: [{
        request_index: 0,
        bundle_product_id: productId,
        choice_group_id: choiceGroupId,
        selection_count: 1,
        option_count: 1,
      }] },
    ])

    await expect(new OrderRepository(tx).assertCurrentOrderable([
      { productId, quantity: 1 },
    ], 'guest_qr')).rejects.toBeInstanceOf(OrderProductUnavailableError)
    expect(tx.calls).toHaveLength(4)
  })

  it.each([
    ['伪造的非候选菜品', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {}],
    ['已取消顾客可见的候选菜品', choiceProductId, { component_guest_visible: false }],
    ['当前不在供应时段的候选菜品', choiceProductId, {
      component_available_from: '18:00', component_available_until: '23:00', store_local_time: '12:00',
    }],
  ])('rejects %s inside a configurable bundle', async (_label, selectedProductId, optionPatch) => {
    const tx = new ScriptedTransaction([
      { rows: [{ ...priceRow(), product_kind: 'bundle', fulfillment_station: 'none' }] },
      { rows: [] },
      { rows: [{ ...choiceOptionRow(), ...optionPatch }] },
      { rows: [{
        request_index: 0,
        bundle_product_id: productId,
        choice_group_id: choiceGroupId,
        selection_count: 1,
        option_count: 1,
      }] },
    ])

    await expect(new OrderRepository(tx).assertCurrentOrderable([{
      productId,
      quantity: 1,
      bundleSelections: [{ groups: [{ groupId: choiceGroupId, productIds: [selectedProductId] }] }],
    }], 'guest_qr')).rejects.toBeInstanceOf(OrderProductUnavailableError)
    expect(tx.calls).toHaveLength(4)
  })

  it('keeps delivery separate from KDS and requires every KDS task to be ready', async () => {
    const delivered = { ...itemRow(), status: 'delivered' }
    const tx = new ScriptedTransaction([{ rows: [delivered] }, { rows: [{ complete_annual_benefit_fulfillment_for_order: 1 }] }])
    const item = await new OrderRepository(tx).markDelivered(itemId, employeeId)
    expect(item.status).toBe('delivered')
    expect(tx.calls[0]?.sql).toContain('NOT EXISTS')
    expect(tx.calls[0]?.sql).toContain("task.status <> 'ready'")
    expect(tx.calls[0]?.sql).not.toContain('UPDATE mbox.kds_tasks')
    expect(tx.calls[1]?.sql).toContain('complete_annual_benefit_fulfillment_for_order')
    expect(tx.calls[1]?.values).toEqual([orderId])
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

function choiceOptionRow(): Record<string, unknown> {
  return {
    request_index: 0,
    bundle_product_id: productId,
    choice_group_id: choiceGroupId,
    choice_group_name: '任选鸡尾酒',
    choice_group_selection_count: 1,
    component_product_id: choiceProductId,
    option_quantity: 1,
    component_code: 'COCKTAIL-CHOICE-01',
    component_name: '客人选择的鸡尾酒',
    component_category_code: 'cocktail',
    component_fulfillment_station: 'bar',
    component_product_snapshot: {},
    component_kds_priority: 100,
    component_fulfillment_sla_seconds: 300,
    component_product_kind: 'single',
    component_status: 'active',
    component_cost_amount_minor: '600',
    component_allowed_channels: ['guest_qr', 'staff_assisted'],
    component_guest_visible: true,
    component_available_from: null,
    component_available_until: null,
    store_local_time: '12:00',
    component_quantity: 0,
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
