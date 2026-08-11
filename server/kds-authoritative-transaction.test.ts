import { describe, expect, it } from 'vitest'
import {
  addOrderItem,
  completeKdsTask,
  createOrderDraft,
  startKdsTask,
  submitOrder,
} from './order-domain.js'
import { createSeedState } from './seed.js'
import {
  KdsAuthorityStateError,
  inferKdsCommandOccurredAt,
  installAuthoritativeKdsTask,
  kdsAuthorityEventId,
  kdsRequestHash,
} from './kds-authoritative-transaction.js'

function stateWithKdsTask() {
  const state = createSeedState(new Date('2026-08-11T12:00:00.000Z'))
  createOrderDraft(state.orderDomain, {
    orderId: 'order-normalized-kds',
    tableSessionId: 'session:table-l01:normalized-kds',
    createdBy: 'emp-xiao-zhi',
    occurredAt: '2026-08-11T12:00:00.000Z',
    idempotencyKey: 'normalized-draft-0001',
  })
  addOrderItem(state.orderDomain, {
    orderId: 'order-normalized-kds',
    item: {
      id: 'item-normalized-kds',
      skuId: 'product-beer',
      name: '精酿啤酒',
      specification: '330ml',
      quantity: 1,
      unitListPriceAmount: 6800,
      unitSalePriceAmount: 6800,
      unitCostAmount: 1800,
      stationId: 'bar-main',
      configVersion: 1,
    },
    actorId: 'emp-xiao-zhi',
    occurredAt: '2026-08-11T12:00:10.000Z',
    idempotencyKey: 'normalized-item-0001',
  })
  const order = submitOrder(state.orderDomain, {
    orderId: 'order-normalized-kds',
    submittedBy: 'emp-xiao-zhi',
    occurredAt: '2026-08-11T12:00:20.000Z',
    idempotencyKey: 'normalized-submit-0001',
  })
  const task = state.orderDomain.kdsTasks.find((candidate) => candidate.id === order.items[0]?.kdsTaskId)
  if (!task) throw new Error('seed state does not contain a KDS task')
  return { state, task }
}

describe('normalized KDS authoritative transaction helpers', () => {
  it('installs the row-locked normalized task as the domain command source', () => {
    const { state, task } = stateWithKdsTask()
    const installed = installAuthoritativeKdsTask(state, {
      source_id: task.id,
      status: task.status,
      payload: structuredClone(task),
      snapshot_revision: state.revision,
    }, task.id)

    expect(installed).toEqual(task)
    expect(installed).not.toBe(task)
    expect(state.orderDomain.kdsTasks.find((candidate) => candidate.id === task.id)).toBe(installed)
  })

  it('fails closed when the normalized status column and payload diverge', () => {
    const { state, task } = stateWithKdsTask()
    expect(() => installAuthoritativeKdsTask(state, {
      source_id: task.id,
      status: task.status === 'queued' ? 'preparing' : 'queued',
      payload: task,
      snapshot_revision: state.revision,
    }, task.id)).toThrow(KdsAuthorityStateError)
  })

  it('fails closed instead of overwriting a divergent compatibility mirror', () => {
    const { state, task } = stateWithKdsTask()
    const authority = structuredClone(task)
    authority.itemName = '权威行商品'
    expect(() => installAuthoritativeKdsTask(state, {
      source_id: task.id,
      status: task.status,
      payload: authority,
      snapshot_revision: state.revision,
    }, task.id)).toThrow('KDS规范化权威行与兼容镜像内容不一致')
  })

  it('derives immutable event time from the actual transition', () => {
    const { state, task } = stateWithKdsTask()
    const before = structuredClone(task)
    const startedAt = '2026-08-11T12:01:00.000Z'
    startKdsTask(state.orderDomain, {
      taskId: task.id,
      actorId: 'emp-xiao-zhi',
      occurredAt: startedAt,
      idempotencyKey: 'normalized-start-0001',
    })
    const afterStart = structuredClone(state.orderDomain.kdsTasks.find((candidate) => candidate.id === task.id)!)
    expect(inferKdsCommandOccurredAt(before, afterStart)).toBe(startedAt)

    const completedAt = '2026-08-11T12:02:00.000Z'
    completeKdsTask(state.orderDomain, {
      taskId: task.id,
      actorId: 'emp-xiao-zhi',
      occurredAt: completedAt,
      idempotencyKey: 'normalized-complete-0001',
    })
    const afterComplete = state.orderDomain.kdsTasks.find((candidate) => candidate.id === task.id)!
    expect(inferKdsCommandOccurredAt(afterStart, afterComplete)).toBe(completedAt)
  })

  it('creates deterministic event IDs and request hashes without exposing request data', () => {
    expect(kdsAuthorityEventId('commerce.kds.action.v2', 'normalized-key-0001'))
      .toBe(kdsAuthorityEventId('commerce.kds.action.v2', 'normalized-key-0001'))
    expect(kdsAuthorityEventId('commerce.kds.action.v2', 'normalized-key-0001'))
      .not.toBe(kdsAuthorityEventId('commerce.kds.action.v2', 'normalized-key-0002'))
    expect(kdsRequestHash('{"actorId":"emp-xiao-zhi"}')).toMatch(/^[0-9a-f]{64}$/)
  })
})
