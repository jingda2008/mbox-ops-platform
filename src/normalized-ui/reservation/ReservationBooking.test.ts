import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReservationBookingView, type ReservationBookingViewProps } from './ReservationBooking'
import type { ReservationAvailability } from './types'

const callbacks = {
  onDraftChange: vi.fn(), onLoadAvailability: vi.fn(), onBack: vi.fn(), onJoinWaitlist: vi.fn(), onSubmit: vi.fn(),
  onReconnect: vi.fn(), onRefreshStatus: vi.fn(), onEdit: vi.fn(), onCancel: vi.fn(), onDismissCancel: vi.fn(),
}

function base(overrides: Partial<ReservationBookingViewProps> = {}): ReservationBookingViewProps {
  return {
    step: 'schedule', phase: 'idle', message: null, retryAt: null, sessionReady: true,
    draft: {
      date: '2026-08-12', time: '2026-08-12|1230', guestCount: 2, mode: 'direct', tableCodes: [],
      seatPreference: 'no_preference', customerName: '王女士', contact: '13800138000', note: '',
    },
    slots: [{ value: '2026-08-12|1230', label: '12:30', iso: '2026-08-12T12:30:00+08:00', nextDay: false }],
    availability: availability(),
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
    expect(html).toContain('为今晚留个位置')
    expect(html).toContain('type="date"')
    expect(html).toContain('到店时间')
    expect(html).toContain('预约人数')
    expect(html).not.toContain('其他客户')
  })

  it('uses lightweight seat preferences without exposing exact table self-selection', () => {
    const html = render(base())
    expect(html).toContain('门店帮我安排')
    expect(html).toContain('靠近舞台')
    expect(html).toContain('方便聊天')
    expect(html).toContain('卡座舒适')
    expect(html).toContain('室外露台')
    expect(html).toContain('偏好不等于锁台')
    expect(html).not.toContain('座位自选')
    expect(html).not.toContain('VIP1')
  })

  it('summarizes the selected preference and explains that confirmation is required', () => {
    const props = base({ step: 'confirm' })
    props.draft = { ...props.draft, seatPreference: 'stage_atmosphere' }
    const html = render(props)
    expect(html).toContain('位置偏好')
    expect(html).toContain('靠近舞台')
    expect(html).toContain('这是一份预约申请')
    expect(html).toContain('收到“预约已确认”后才算预约成功')
  })

  it('makes pending approval explicit and distinguishes it from the temporary table hold', () => {
    const html = render(base({
      step: 'complete', holdSeconds: 1139,
      reservation: {
        publicId: 'reservation-own-001', customerName: '王女士', maskedContact: '138****8000', guestCount: 2,
        arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', status: 'pending',
        arrivalState: 'not_arrived', note: null, seatPreference: 'stage_atmosphere', tableCodes: ['VIP1'], holdExpiresAt: '2026-08-12T12:20:00Z', cancellationPolicy: {},
      },
    }))
    expect(html).toContain('reservation-own-001')
    expect(html).toContain('138****8000')
    expect(html).toContain('等待门店确认')
    expect(html).toContain('门店确认后才正式生效')
    expect(html).toContain('临时锁位剩余 18:59')
    expect(html).toContain('不代表预约已确认')
    expect(html).toContain('刷新确认状态')
    expect(html).toContain('确认位置</dt><dd>待门店确认')
    expect(html).not.toContain('>VIP1<')
    expect(html).not.toContain('<h1 id="reservation-complete-title">预约已确认</h1>')
    expect(html).not.toContain('联系电话原文')
  })

  it('shows a confirmed reservation only after the server status changes', () => {
    const html = render(base({
      step: 'complete',
      reservation: {
        publicId: 'reservation-confirmed-001', customerName: '王女士', maskedContact: '138****8000', guestCount: 2,
        arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', status: 'confirmed',
        arrivalState: 'not_arrived', note: null, seatPreference: 'comfortable_booth', tableCodes: ['VIP1'], holdExpiresAt: null, cancellationPolicy: {},
      },
    }))

    expect(html).toContain('<h1 id="reservation-complete-title">预约已确认</h1>')
    expect(html).toContain('门店已确认本次预约')
    expect(html).not.toContain('临时锁位')
    expect(html).not.toContain('刷新确认状态')
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
