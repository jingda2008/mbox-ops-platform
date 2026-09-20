import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaffNoticeController,fulfillmentNoticeKey } from './staff-notice-controller'

describe('action results and background reminders', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps a successful action visible when its refresh discovers a pending payment', () => {
    const publish = vi.fn()
    const controller = new StaffNoticeController(publish)
    controller.show({ kind: 'success', message: '订单已挂桌' })
    controller.show({ kind: 'attention', message: '新增 1 张桌待收款' })
    vi.advanceTimersByTime(3_199)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ kind: 'success', message: '订单已挂桌' })
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenLastCalledWith({ kind: 'attention', message: '新增 1 张桌待收款' })
    vi.advanceTimersByTime(12_000)
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('shows an action error immediately and resumes the reminder afterwards', () => {
    const publish = vi.fn()
    const controller = new StaffNoticeController(publish)
    controller.show({ kind: 'attention', message: '有待处理服务' })
    vi.advanceTimersByTime(100)
    controller.show({ kind: 'error', message: '位置已变化，请重新确认' })
    expect(publish).toHaveBeenLastCalledWith({ kind: 'error', message: '位置已变化，请重新确认' })
    vi.advanceTimersByTime(3_200)
    expect(publish).toHaveBeenLastCalledWith({ kind: 'attention', message: '有待处理服务' })
  })

  it('does not repeat identical reminders while the employee reads guidance', () => {
    const publish = vi.fn()
    const controller = new StaffNoticeController(publish)
    controller.show({ kind: 'guidance', message: '请先选择桌台' })
    for (let index = 0; index < 5; index++) controller.show({ kind: 'attention', message: '有待处理服务' })
    vi.advanceTimersByTime(6_000)
    controller.show({ kind: 'attention', message: '有待处理服务' })
    vi.advanceTimersByTime(12_000)
    expect(publish.mock.calls).toEqual([
      [{ kind: 'guidance', message: '请先选择桌台' }],
      [{ kind: 'attention', message: '有待处理服务' }],
      [null],
    ])
  })

  it.each(['clear', 'dispose'] as const)('%s cancels queued reminders on dismissal, navigation or unmount', method => {
    const publish = vi.fn()
    const controller = new StaffNoticeController(publish)
    controller.show({ kind: 'success', message: '已保存' })
    controller.show({ kind: 'attention', message: '有待办' })
    controller[method]()
    const calls = publish.mock.calls.length
    vi.runAllTimers()
    expect(publish).toHaveBeenCalledTimes(calls)
    if (method === 'clear') expect(publish).toHaveBeenLastCalledWith(null)
  })
})

it('identifies each partial ready batch even when the same task is still awaiting delivery',()=>{
  const item={taskId:'original',readyForDelivery:true,deliveryNoticeVersion:1}
  expect(fulfillmentNoticeKey(item)).not.toBe(fulfillmentNoticeKey({...item,deliveryNoticeVersion:2}))
  expect(fulfillmentNoticeKey(item)).not.toBe(fulfillmentNoticeKey({...item,readyForDelivery:false}))
  expect(fulfillmentNoticeKey({...item})).toBe(fulfillmentNoticeKey(item))
})
