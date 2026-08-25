import { describe, expect, it } from 'vitest'
import { PrintTicketSourceRepository } from './print-ticket-source.js'

const scope = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  storeId: '20000000-0000-4000-8000-000000000001',
}

describe('PrintTicketSourceRepository', () => {
  it('reads committed order, table-session and item facts before deciding whether a production ticket has a route', async () => {
    const queries: string[] = []
    const repository = new PrintTicketSourceRepository({
      scope,
      query: async (text) => {
        queries.push(text)
        if (text.includes('FROM mbox.orders AS ordering')) {
          return {
            rowCount: 1,
            rows: [{
              order_id: '30000000-0000-4000-8000-000000000001',
              order_public_id: 'order-print-source-0001', order_note: '与首轮酒水同步',
              total_amount_minor: '22400', currency: 'CNY', payment_status: 'unpaid',
              table_code: 'V08', guest_count: 3, business_date: '2026-08-22',
              submitted_at: '2026-08-22T14:00:00.000Z',
            }],
          }
        }
        if (text.includes('FROM mbox.order_items AS item')) {
          return {
            rowCount: 1,
            rows: [{
              item_id: '40000000-0000-4000-8000-000000000001', parent_order_item_id: null,
              quantity: 2, total_amount_minor: '17600', fulfillment_station: 'bar',
              product_snapshot: { name: '金汤力', categoryCode: 'cocktail', productKind: 'single' },
              note: '少冰',
            }],
          }
        }
        if (text.includes('FROM mbox.printer_routes AS route')) return { rowCount: 0, rows: [] }
        throw new Error('unexpected query')
      },
    })

    await expect(repository.materializeOrderProduction(
      '50000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
    )).resolves.toEqual([])

    expect(queries.join('\n')).toContain('session.guest_count')
    expect(queries.join('\n')).toContain('venue_table.code AS table_code')
    expect(queries.join('\n')).toContain('item.product_snapshot')
    expect(queries.join('\n')).not.toContain('SELECT *')
  })

  it('creates a payment voucher from one succeeded payment, without pretending a split or re-collection payment is the whole bill', async () => {
    const queries: string[] = []
    const repository = new PrintTicketSourceRepository({
      scope,
      query: async (text) => {
        queries.push(text)
        if (text.includes('FROM mbox.payments AS payment')) {
          return {
            rowCount: 1,
            rows: [{
              order_id: '30000000-0000-4000-8000-000000000001',
              order_public_id: 'order-print-source-0001', order_note: null,
              total_amount_minor: '22400', currency: 'CNY', payment_status: 'partially_refunded',
              table_code: 'V08', guest_count: 3, business_date: '2026-08-22',
              submitted_at: '2026-08-22T14:00:00.000Z',
              payment_id: '50000000-0000-4000-8000-000000000001',
              payment_public_id: 'payment-recollect-0001', payment_provider: 'postar', payment_method: 'native_qr',
              payment_amount_minor: '6800', payment_status_value: 'succeeded',
              succeeded_at: '2026-08-22T14:06:00.000Z', settled_payment_count: '2', settled_amount_minor: '15600',
            }],
          }
        }
        if (text.includes('FROM mbox.printer_routes AS route')) return { rowCount: 1, rows: [{ active: false }] }
        throw new Error('unexpected query')
      },
    })

    await expect(repository.materializeCashierPayment(
      '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
    )).resolves.toEqual([])

    expect(queries.join('\n')).toContain('payment.status AS payment_status_value')
    expect(queries.join('\n')).not.toContain('FROM mbox.order_items AS item')
  })

  it('uses committed activity payment facts for a cashier voucher without loading attendee contact data', async () => {
    const queries: string[] = []
    const repository = new PrintTicketSourceRepository({
      scope,
      query: async (text) => {
        queries.push(text)
        if (text.includes('FROM mbox.payments payment') && text.includes('community_activity_registrations')) {
          return {
            rowCount: 1,
            rows: [{
              payment_id: '50000000-0000-4000-8000-000000000001',
              payment_public_id: 'activity-payment-print-0001', payment_provider: 'physical_pos', payment_method: 'card',
              payment_amount_minor: '12800', payment_status_value: 'succeeded',
              succeeded_at: '2026-08-25T12:00:00.000Z', business_date: '2026-08-25',
              activity_public_id: 'activity-print-0001', activity_title: '晚风鸡尾酒课',
              registration_public_id: 'registration-print-0001', party_size: 2, currency: 'CNY',
            }],
          }
        }
        if (text.includes('FROM mbox.printer_routes AS route')) return { rowCount: 1, rows: [{ active: false }] }
        throw new Error('unexpected query')
      },
    })

    await expect(repository.materializeActivityCashierPayment(
      '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001',
    )).resolves.toEqual([])

    const sql = queries.join('\n')
    expect(sql).toContain("payment.payable_kind='activity_registration'")
    expect(sql).toContain('activity.title AS activity_title')
    expect(sql).not.toContain('contact_snapshot')
    expect(sql).not.toContain('customer_id')
  })
})
