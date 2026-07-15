import { describe, expect, it } from 'vitest'
import type { CreateReservationCommand } from '../src/shared/reservation-contracts.js'
import {
  cancelReservation,
  completeReservationDepositRefund,
  confirmReservation,
  confirmReservationDeposit,
  createReservation,
  createReservationState,
  markReservationArrived,
  markReservationNoShow,
  recordReservationDepositIntent,
  seatReservation,
  startReservationDepositRefund,
  updateReservationDetails,
  decideLateReservationHold,
} from './reservation-domain.js'

const T0 = '2026-07-14T10:00:00.000Z'
const T1 = '2026-07-14T10:05:00.000Z'
const T2 = '2026-07-14T10:10:00.000Z'
const T3 = '2026-07-14T10:20:00.000Z'
const SCHEDULED = '2026-07-14T12:00:00.000Z'

function state() {
  return createReservationState({ tenantId: 'tenant-mbox', storeId: 'store-lujiazui' }, {
    version: 3,
    minimumPartySize: 1,
    maximumPartySize: 12,
    sources: [{ code: 'wechat', name: '微信', enabled: true, sortOrder: 1 }],
    areaPreferences: [{ code: 'stage', name: '舞台互动区', enabled: true, sortOrder: 1 }],
    occasions: [{ code: 'birthday', name: '生日', enabled: true, serviceScript: ['准备生日权益'] }],
    lateHoldMinutes: 30,
    waitlistResponseMinutes: 10,
  })
}

function createCommand(overrides: Partial<CreateReservationCommand> = {}): CreateReservationCommand {
  return {
    reservationId: 'reservation-1',
    customerReference: 'member-opaque-1',
    customerName: '王女士',
    contactReference: 'encrypted-contact-1',
    sourceCode: 'wechat',
    partySize: 6,
    areaPreferenceCode: 'stage',
    occasionCode: 'birthday',
    occasionNote: '22:00送生日歌，不要提前透露',
    scheduledAt: SCHEDULED,
    depositRequiredAmount: 50000,
    depositCurrency: 'CNY',
    actorId: 'employee-1',
    occurredAt: T0,
    idempotencyKey: 'reservation-create-0001',
    ...overrides,
  }
}

function action(idempotencyKey: string, occurredAt = T1) {
  return { reservationId: 'reservation-1', actorId: 'employee-1', occurredAt, idempotencyKey }
}

function payDeposit(domain: ReturnType<typeof state>) {
  recordReservationDepositIntent(domain, {
    ...action('reservation-intent-0001'),
    paymentIntentReference: 'payment-intent-1',
  })
  return confirmReservationDeposit(domain, {
    ...action('reservation-payment-0001', T2),
    paymentIntentReference: 'payment-intent-1',
    paymentConfirmationReference: 'provider-payment-1',
    confirmedAmount: 50000,
    currency: 'CNY',
  })
}

describe('reservation configuration and lifecycle', () => {
  it('captures configurable source, party size, area preference and birthday context', () => {
    const domain = state()
    const reservation = createReservation(domain, createCommand())

    expect(reservation).toMatchObject({
      sourceCode: 'wechat',
      partySize: 6,
      areaPreferenceCode: 'stage',
      occasionCode: 'birthday',
      status: 'requested',
      configVersion: 3,
    })
    expect(reservation.deposit).toMatchObject({ status: 'payment_required', paymentIntentReference: null })
    expect(domain.auditEvents[0]).toMatchObject({ type: 'reservation.requested.v1', actorId: 'employee-1' })
    expect(() => createReservation(domain, createCommand({ sourceCode: 'disabled-source', idempotencyKey: 'reservation-create-0002' }))).toThrow(
      '预约来源未配置或已停用',
    )
    expect(() => createReservation(domain, createCommand({ partySize: 13, idempotencyKey: 'reservation-create-0003' }))).toThrow(
      '预约人数必须在1至12之间',
    )
  })

  it('is idempotent and rejects a changed payload under the same key', () => {
    const domain = state()
    const command = createCommand()
    const first = createReservation(domain, command)
    expect(createReservation(domain, command)).toBe(first)
    expect(domain.reservations).toHaveLength(1)
    expect(() => createReservation(domain, { ...command, partySize: 7 })).toThrow('幂等键已用于不同请求')
  })

  it('requires an external deposit intent and confirmation before confirmation', () => {
    const domain = state()
    createReservation(domain, createCommand())
    expect(() => confirmReservation(domain, action('reservation-confirm-early'))).toThrow('订金尚未收到外部支付确认')

    recordReservationDepositIntent(domain, {
      ...action('reservation-intent-0001'),
      paymentIntentReference: 'payment-intent-1',
    })
    expect(() => confirmReservationDeposit(domain, {
      ...action('reservation-payment-wrong'),
      paymentIntentReference: 'payment-intent-1',
      paymentConfirmationReference: 'provider-payment-wrong',
      confirmedAmount: 49999,
      currency: 'CNY',
    })).toThrow('支付确认金额或币种不匹配')

    const paid = confirmReservationDeposit(domain, {
      ...action('reservation-payment-0001', T2),
      paymentIntentReference: 'payment-intent-1',
      paymentConfirmationReference: 'provider-payment-1',
      confirmedAmount: 50000,
      currency: 'CNY',
    })
    expect(paid.deposit).toMatchObject({ status: 'payment_confirmed', paymentConfirmationReference: 'provider-payment-1' })
    expect(confirmReservation(domain, action('reservation-confirm-0001', T3)).status).toBe('confirmed')
  })

  it('binds an arrived reservation to one concrete table session', () => {
    const domain = state()
    createReservation(domain, createCommand({ depositRequiredAmount: 0 }))
    confirmReservation(domain, action('reservation-confirm-0001'))
    markReservationArrived(domain, action('reservation-arrive-0001', T2))
    const seated = seatReservation(domain, {
      ...action('reservation-seat-0001', T3),
      tableId: 'table-18',
      tableCode: 'L18',
      tableSessionId: 'table-session-18-20260714',
    })
    expect(seated).toMatchObject({ status: 'seated', tableId: 'table-18', tableCode: 'L18', tableSessionId: 'table-session-18-20260714' })
    expect(domain.auditEvents.at(-1)).toMatchObject({ type: 'reservation.seated.v1', toStatus: 'seated' })
  })

  it('only marks no-show after the scheduled time', () => {
    const domain = state()
    createReservation(domain, createCommand({ depositRequiredAmount: 0 }))
    confirmReservation(domain, action('reservation-confirm-0001'))
    expect(() => markReservationNoShow(domain, {
      ...action('reservation-noshow-early', T3),
      reason: '系统定时检查',
    })).toThrow('预约时间未到')
    expect(markReservationNoShow(domain, {
      ...action('reservation-noshow-0001', '2026-07-14T12:30:00.000Z'),
      reason: '超过保留时间且两次联系未果',
    }).status).toBe('no_show')
  })

  it('records party-size changes and manager late-hold decisions without replacing the reservation', () => {
    const domain = state()
    const original = createReservation(domain, createCommand({ depositRequiredAmount: 0 }))
    const updated = updateReservationDetails(domain, {
      ...action('reservation-update-details-001', T1),
      partySize: 8,
      scheduledAt: '2026-07-14T12:30:00.000Z',
      areaPreferenceCode: 'stage',
      reason: '顾客确认增加两人',
    })
    expect(updated.id).toBe(original.id)
    expect(updated).toMatchObject({ partySize: 8, scheduledAt: '2026-07-14T12:30:00.000Z', revision: 2 })
    expect(domain.auditEvents.at(-1)).toMatchObject({
      type: 'reservation.details_updated.v1',
      details: { beforePartySize: 6, afterPartySize: 8 },
    })

    confirmReservation(domain, action('reservation-confirm-001', T2))
    const held = decideLateReservationHold(domain, {
      ...action('reservation-late-hold-001', '2026-07-14T12:20:00.000Z'),
      decision: 'hold',
      expectedArrivalAt: '2026-07-14T12:50:00.000Z',
      contactReference: 'wecom-message-20260714-01',
      reason: '顾客已联系并确认在途',
    })
    expect(held).toMatchObject({
      id: original.id,
      holdStatus: 'held',
      holdUntil: '2026-07-14T13:20:00.000Z',
      lateContactReference: 'wecom-message-20260714-01',
    })
    expect(domain.auditEvents.at(-1)?.type).toBe('reservation.late_hold_decided.v1')
  })
})

describe('reservation deposit refund lifecycle', () => {
  it('cancellation creates a refund requirement but never claims money was refunded', () => {
    const domain = state()
    createReservation(domain, createCommand())
    payDeposit(domain)
    confirmReservation(domain, action('reservation-confirm-0001', T3))

    const cancelled = cancelReservation(domain, {
      ...action('reservation-cancel-0001', '2026-07-14T11:00:00.000Z'),
      reason: '顾客行程变化',
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellationReason: '顾客行程变化' })
    expect(cancelled.deposit).toMatchObject({
      status: 'refund_required',
      refundRequestReference: null,
      refundConfirmationReference: null,
      refundedAt: null,
    })
    expect(domain.auditEvents.slice(-2).map((item) => item.type)).toEqual([
      'reservation.cancelled.v1',
      'reservation.deposit_refund_required.v1',
    ])
  })

  it('requires matching external refund request and confirmation references', () => {
    const domain = state()
    createReservation(domain, createCommand())
    payDeposit(domain)
    cancelReservation(domain, {
      ...action('reservation-cancel-0001', T3),
      reason: '顾客取消',
    })
    startReservationDepositRefund(domain, {
      ...action('reservation-refund-start-0001', '2026-07-14T10:30:00.000Z'),
      refundRequestReference: 'refund-request-1',
    })
    expect(() => completeReservationDepositRefund(domain, {
      ...action('reservation-refund-complete-wrong', '2026-07-14T10:35:00.000Z'),
      refundRequestReference: 'refund-request-other',
      refundConfirmationReference: 'refund-provider-1',
      refundedAmount: 50000,
      currency: 'CNY',
    })).toThrow('退款确认与退款请求不匹配')

    const refunded = completeReservationDepositRefund(domain, {
      ...action('reservation-refund-complete-0001', '2026-07-14T10:40:00.000Z'),
      refundRequestReference: 'refund-request-1',
      refundConfirmationReference: 'refund-provider-1',
      refundedAmount: 50000,
      currency: 'CNY',
    })
    expect(refunded.deposit).toMatchObject({ status: 'refunded', refundConfirmationReference: 'refund-provider-1' })
  })
})
