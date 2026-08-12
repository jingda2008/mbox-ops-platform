import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReservationBookingView, type ReservationBookingViewProps } from './ReservationBooking'
import type { ReservationAvailability } from './types'

const callbacks = {
  onDraftChange: vi.fn(), onLoadAvailability: vi.fn(), onChooseMode: vi.fn(), onZoneChange: vi.fn(),
  onChooseTable: vi.fn(), onContinue: vi.fn(), onBack: vi.fn(), onJoinWaitlist: vi.fn(), onSubmit: vi.fn(),
  onReconnect: vi.fn(), onEdit: vi.fn(), onCancel: vi.fn(), onDismissCancel: vi.fn(),
}

function base(overrides: Partial<ReservationBookingViewProps> = {}): ReservationBookingViewProps {
  return {
    step: 'schedule', phase: 'idle', message: null, retryAt: null, sessionReady: true,
    draft: {
      date: '2026-08-12', time: '2026-08-12|1230', guestCount: 2, mode: 'direct', tableCodes: [],
      customerName: '', contact: '', note: '',
    },
    slots: [{ value: '2026-08-12|1230', label: '12:30', iso: '2026-08-12T12:30:00+08:00', nextDay: false }],
    availability: availability(), selectedZone: 'stage-front', focusedTable: null,
    reservation: null, waitlist: null, joinWaitlist: false, cancelArmed: false, holdSeconds: 0,
    minDate: '2026-08-12', maxDate: '2026-11-10', ...callbacks, ...overrides,
  }
}

function render(props: ReservationBookingViewProps): string {
  return renderToStaticMarkup(createElement(ReservationBookingView, props))
}

describe('ReservationBookingView', () => {
  it('keeps date, time and people on one compact first step', () => {
    const html = render(base())
    expect(html).toContain('今晚几点来？')
    expect(html).toContain('type="date"')
    expect(html).toContain('到店时间')
    expect(html).toContain('预约人数')
    expect(html).not.toContain('其他客户')
  })

  it('offers direct booking and clickable grouped seats with visible commercial facts', () => {
    const props = base({ step: 'seat', focusedTable: availability().areas[0]!.tables[0]! })
    props.draft = { ...props.draft, mode: 'self_select' }
    const html = render(props)
    expect(html).toContain('直接预约')
    expect(html).toContain('座位自选')
    expect(html).toContain('舞台前')
    expect(html).toContain('VIP1')
    expect(html).toContain('最低消费 ¥1,888')
    expect(html).toContain('已预订')
    expect(html).toContain('临时锁定')
  })

  it('shows only the signed-in customer result and the server hold countdown', () => {
    const html = render(base({
      step: 'complete', holdSeconds: 1139,
      reservation: {
        publicId: 'reservation-own-001', customerName: '王女士', maskedContact: '138****8000', guestCount: 2,
        arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', status: 'pending',
        arrivalState: 'not_arrived', note: null, tableCodes: ['VIP1'], holdExpiresAt: '2026-08-12T12:20:00Z', cancellationPolicy: {},
      },
    }))
    expect(html).toContain('reservation-own-001')
    expect(html).toContain('138****8000')
    expect(html).toContain('座位保留 18:59')
    expect(html).not.toContain('联系电话原文')
  })

  it('keeps retry and reconnect actions explicit after session or rate-limit failures', () => {
    const html = render(base({ sessionReady: false, message: '预约会话已失效，请重新进入预约页面', retryAt: '2099-01-01T00:00:00Z' }))
    expect(html).toContain('重新连接')
    expect(html).toContain('预约会话已失效')
    expect(html).toContain('秒后可重试')
  })

  it('does not present a zero deposit before a direct-booking table is assigned', () => {
    const value = availability()
    value.depositRule = { enabled: true, mode: 'minimum_spend_ratio', amountMinor: 0, ruleText: '定金抵扣消费' }
    const html = render(base({ step: 'confirm', availability: value }))
    expect(html).toContain('预约定金将按门店最终安排位置计算')
    expect(html).not.toContain('预约定金 ¥0')
  })
})

function availability(): ReservationAvailability {
  return {
    arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', guestCount: 2, holdMinutes: 20,
    depositRule: { enabled: true, mode: 'flat', amountMinor: 50000, ruleText: '可抵扣当日消费' },
    areas: [{
      code: 'VIP', name: '舞台前区', type: 'vip', zone: 'stage-front',
      tables: [{ code: 'VIP1', name: 'VIP 1', capacity: 6, minimumSpendMinor: 188800, currency: 'CNY', status: 'available' }],
    }],
  }
}
