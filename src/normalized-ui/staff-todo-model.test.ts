import { describe, expect, it } from 'vitest'
import type { StaffBootstrapView } from '../shared/normalized-contracts'
import { staffTodoSources, uniqueStaffTodos, type StaffTodo } from './staff-todo-model'

function bootstrap(permissions: string[], codes: string[]) {
  return { staff: { id: 'operator' }, access: { permissions }, navigation: codes.map(code => ({ code })) } as StaffBootstrapView
}
describe('shared staff todo queue', () => {
  it('does not request unrelated modules or turn a read-only hardware role into a print reader', () => {
    expect(staffTodoSources(bootstrap(['hardware.view'], ['devices']))).toEqual([])
    expect(staffTodoSources(bootstrap(['service.execute'], ['tasks'])).map(source => source.id)).toEqual(['service'])
    expect(staffTodoSources(bootstrap(['loyalty.redemption.exception'], ['member-exceptions'])).map(source => source.id)).toEqual(['redemptions', 'member-exceptions'])
  })
  it('counts a shared-payment refund once while retaining distinct refunds and independent approval', () => {
    const source = staffTodoSources(bootstrap(['refund.approve'], ['payments']))[0]
    const refund = { id: 'refund-1', requestedByEmployeeId: 'operator', amountMinor: 100, status: 'requested', createdAt: '2026-09-20' }
    const order = { id: 'order-1', publicId: 'O001', tableCode: 'A01', payments: [{ refunds: [refund] }] }
    const items = source.map({ actions: { canApproveRefund: true }, orders: [order, { ...order, id: 'order-2' }, { ...order, payments: [{ refunds: [{ ...refund, id: 'refund-2', requestedByEmployeeId: 'another' }] }] }] })
    expect(items).toHaveLength(2)
    expect(items.find(item => item.id === 'refund:refund-1')?.state).toBe('waiting')
    expect(items.find(item => item.id === 'refund:refund-2')?.state).toBe('action')
    const link = new URL(items[0].route, 'https://example.test')
    expect(link.searchParams.get('orderId')).toBe('order-1')
    expect(link.searchParams.get('todo')).toBe('refund:refund-2')
  })
  it('keeps a processing refund and a redeemed snack in waiting state', () => {
    const sources = staffTodoSources(bootstrap(['loyalty.redemption.fulfill'], ['member-fulfillment', 'payments']))
    const snacks = sources.find(source => source.id === 'snacks')!.map([{ id: 'snack', status: 'redeemed', quantity: 1, title: '点心' }, { id: 'done', status: 'fulfilled' }])
    expect(snacks).toHaveLength(1)
    expect(snacks[0].state).toBe('waiting')
    const refunds = sources.find(source => source.id === 'refunds')!.map({ actions: { canExecuteRefund: true }, orders: [{ id: 'o', publicId: 'O', tableCode: 'A', payments: [{ refunds: [{ id: 'r', status: 'processing', providerSubmissionState: 'submitted', amountMinor: 100 }] }] }] })
    expect(refunds[0].state).toBe('waiting')
  })
  it('treats malformed read responses as failures rather than empty queues', () => {
    const sources = staffTodoSources(bootstrap(['service.execute', 'print.view'], ['tasks', 'devices']))
    for (const source of sources) expect(() => source.map({ unavailable: true })).toThrow('读取不完整')
  })
  it('deduplicates the same record across entrances without merging separate steps on one table', () => {
    const item: StaffTodo = { id: 'service:a', domain: 'service', title: 'A01', detail: '', owner: '我', next: '查看', route: '/staff/tasks', state: 'action', priority: 1, time: '2026-09-20' }
    expect(uniqueStaffTodos([item, { ...item }, { ...item, id: 'print:b', domain: 'print' }])).toHaveLength(2)
  })
})
