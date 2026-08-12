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
      date: '2026-08-12', time: '2026-08-12|1230', guestCount: 2, mode: 'direct',
      seatPreference: 'no_preference', customerName: '王女士', contact: '13800138000', note: '',
    },
    slots: [{ value: '2026-08-12|1230', label: '12:30', iso: '2026-08-12T12:30:00+08:00', nextDay: false }],
    availability: availability(),
    reservation: null, waitlist: null, joinWaitlist: false, cancelArmed: false,
    arrivalHold: { kind: 'hidden', seconds: 0 },
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

  it('makes pending approval explicit without exposing the internal anti-conflict hold', () => {
    const html = render(base({
      step: 'complete',
      reservation: {
        publicId: 'reservation-own-001', customerName: '王女士', maskedContact: '138****8000', guestCount: 2,
        arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', status: 'pending',
        arrivalState: 'not_arrived', note: null, seatPreference: 'stage_atmosphere',
        arrivalGraceEndsAt: '2026-08-12T20:40:00+08:00', cancellationPolicy: {},
      },
    }))
    expect(html).toContain('reservation-own-001')
    expect(html).toContain('138****8000')
    expect(html).toContain('等待门店确认')
    expect(html).toContain('门店确认后才正式生效')
    expect(html).not.toContain('临时锁位')
    expect(html).not.toContain('预约锁位剩余')
    expect(html).toContain('刷新确认状态')
    expect(html).toContain('位置安排</dt><dd>确认后保留预约名额')
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
        arrivalState: 'not_arrived', note: null, seatPreference: 'comfortable_booth',
        arrivalGraceEndsAt: '2026-08-12T20:40:00+08:00', cancellationPolicy: {},
      },
    }))

    expect(html).toContain('<h1 id="reservation-complete-title">预约已确认</h1>')
    expect(html).toContain('门店已确认本次预约')
    expect(html).toContain('位置安排</dt><dd>到店后由门迎安排')
    expect(html).not.toContain('临时锁位')
    expect(html).not.toContain('刷新确认状态')
  })

  it('shows the ten-minute arrival retention only after confirmed arrival time is reached', () => {
    const reservation = {
      publicId: 'reservation-confirmed-002', customerName: '王女士', maskedContact: '138****8000', guestCount: 2,
      arrivalAt: '2026-08-12T21:00:00+08:00', expectedEndAt: '2026-08-13T01:00:00+08:00', status: 'confirmed',
      arrivalState: 'not_arrived' as const, note: null, seatPreference: 'comfortable_booth' as const,
      arrivalGraceEndsAt: '2026-08-12T21:10:00+08:00', cancellationPolicy: {},
    }
    const beforeArrival = render(base({ step: 'complete', reservation }))
    expect(beforeArrival).not.toContain('预约到店保留剩余')

    const duringGrace = render(base({
      step: 'complete', reservation, arrivalHold: { kind: 'active', seconds: 599 },
    }))
    expect(duringGrace).toContain('预约到店保留剩余 09:59')
    expect(duringGrace).toContain('本次预约为您保留到 21:10')
    expect(duringGrace).toContain('具体位置到店后由门迎安排')
    expect(duringGrace).not.toContain('VIP1')
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
    arrivalAt: '2026-08-12T20:30:00+08:00', expectedEndAt: '2026-08-13T00:30:00+08:00', guestCount: 2,
    acceptingReservations: true,
    depositRule: { enabled: true, mode: 'flat', amountMinor: 50000, ruleText: '可抵扣当日消费' },
    areas: [{
      code: 'VIP', name: '舞台前区', type: 'vip', zone: 'stage-front',
      tables: [{ code: 'VIP1', name: 'VIP 1', capacity: 6, minimumSpendMinor: 188800, currency: 'CNY', status: 'available' }],
    }],
  }
}
