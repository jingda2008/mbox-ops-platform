import { describe, expect, it } from 'vitest'
import { buildOperationalProjection, PostgresOperationalProjector } from './operational-projection.js'
import { createSeedState } from './seed.js'
import type { PostgresPoolClient } from './postgres-repository.js'

function fakeClient(handler?: (text: string, values?: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number | null }) {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const client: PostgresPoolClient = {
    query: async (text, values) => {
      calls.push({ text, values })
      const result = handler?.(text, values) ?? {}
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 1 }
    },
    release: () => undefined,
  }
  return { client, calls }
}

describe('normalized operational projection', () => {
  it('maps every high-frequency aggregate into a scoped normalized row set', () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    const projection = new Map(buildOperationalProjection(state).map((set) => [set.table, set.rows]))

    expect(projection.get('operational_tables')).toHaveLength(state.tables.length)
    expect(projection.get('operational_table_sessions')).toHaveLength(state.songState.tableSessions.length)
    expect(projection.get('operational_service_tasks')).toHaveLength(state.tasks.length)
    expect(projection.get('operational_orders')).toHaveLength(state.orderDomain.orders.length)
    expect(projection.get('operational_order_items')).toHaveLength(
      state.orderDomain.orders.reduce((total, order) => total + order.items.length, 0),
    )
    expect(projection.get('operational_kds_tasks')).toHaveLength(state.orderDomain.kdsTasks.length)
    expect(projection.get('operational_payment_intents')).toHaveLength(state.paymentDomain.paymentIntents.length)
    expect(projection.get('operational_inventory_balances')).toHaveLength(state.inventoryDomain?.balances.length ?? 0)
  })

  it('performs a deterministic scoped rebuild and writes its checkpoint in the same transaction client', async () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    const { client, calls } = fakeClient()
    await new PostgresOperationalProjector().project(client, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      storeId: '00000000-0000-4000-8000-000000000002',
    }, null, state)

    expect(calls.filter((call) => call.text.startsWith('DELETE FROM mbox.operational_'))).toHaveLength(8)
    expect(calls.at(-1)?.text).toContain('operational_projection_checkpoints')
    expect(calls.at(-1)?.values?.[2]).toBe(state.revision)
  })

  it('updates only requested high-frequency projections while retaining full checkpoint counts', async () => {
    const before = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    const after = structuredClone(before)
    after.tasks[0] = { ...after.tasks[0]!, status: 'completed' }
    after.revision += 1
    const { client, calls } = fakeClient()

    await new PostgresOperationalProjector().project(client, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      storeId: '00000000-0000-4000-8000-000000000002',
    }, before, after, ['operational_service_tasks'])

    expect(calls.some((call) => call.text.includes('INSERT INTO mbox.operational_service_tasks'))).toBe(true)
    expect(calls.some((call) => call.text.includes('INSERT INTO mbox.operational_orders'))).toBe(false)
    const checkpoint = calls.at(-1)
    expect(checkpoint?.text).toContain('operational_projection_checkpoints')
    expect(JSON.parse(String(checkpoint?.values?.[4]))).toMatchObject({
      operational_tables: after.tables.length,
      operational_service_tasks: after.tasks.length,
      operational_orders: after.orderDomain.orders.length,
    })
  })

  it('builds only requested entity rows while retaining the requested table boundary', () => {
    const state = createSeedState(new Date('2026-07-20T12:00:00.000Z'))
    const occurredAt = '2026-07-20T12:01:00.000Z'
    const order = (id: string, itemId: string) => ({
      id,
      tableSessionId: 'session:table-l01:test',
      status: 'draft' as const,
      items: [{
        id: itemId,
        skuId: 'product-beer',
        name: '精酿啤酒',
        specification: '1杯',
        quantity: 1,
        unitListPriceAmount: 6800,
        unitSalePriceAmount: 6800,
        unitCostAmount: 1800,
        stationId: 'bar-main',
        configVersion: 1,
        fulfillmentStatus: 'draft' as const,
        kdsTaskId: null,
        addedBy: 'emp-lin',
        addedAt: occurredAt,
      }],
      amounts: { grossAmount: 6800, discountAmount: 0, giftAmount: 0, payableAmount: 6800 },
      revision: 1,
      createdBy: 'emp-lin',
      createdAt: occurredAt,
      submittedBy: null,
      submittedAt: null,
      fulfilledAt: null,
    })
    state.orderDomain.orders.push(order('order-selected', 'item-selected'), order('order-other', 'item-other'))
    const selectedOrder = state.orderDomain.orders[0]
    const selectedItem = selectedOrder!.items[0]

    const projection = new Map(buildOperationalProjection(
      state,
      ['operational_orders', 'operational_order_items'],
      {
        operational_orders: [selectedOrder!.id],
        operational_order_items: [selectedItem!.id],
      },
    ).map((set) => [set.table, set.rows]))

    expect([...projection.keys()]).toEqual(['operational_orders', 'operational_order_items'])
    expect(projection.get('operational_orders')).toHaveLength(1)
    expect(projection.get('operational_orders')?.[0]?.source_id).toBe(selectedOrder!.id)
    expect(projection.get('operational_order_items')).toHaveLength(1)
    expect(projection.get('operational_order_items')?.[0]?.source_id).toBe(selectedItem!.id)
  })

  it('accepts equivalent checkpoint counts independent of JSON key order', async () => {
    const expected = {
      operational_tables: 7,
      operational_table_sessions: 1,
      operational_service_tasks: 2,
      operational_orders: 3,
      operational_order_items: 4,
      operational_kds_tasks: 8,
      operational_payment_intents: 5,
      operational_inventory_balances: 6,
    }
    const actual = Object.fromEntries(Object.entries(expected).reverse())
    const { client } = fakeClient(() => ({
      rows: [{ runtime_revision: 91, entity_counts: expected, actual_counts: actual }], rowCount: 1,
    }))
    const health = await new PostgresOperationalProjector().healthCheck(client, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      storeId: '00000000-0000-4000-8000-000000000002',
    }, 91)

    expect(health).toEqual({ ready: true, runtimeRevision: 91, projectedRevision: 91, countsMatch: true })
  })
})
