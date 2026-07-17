import { describe, expect, it } from 'vitest'
import {
  acceptSongRequest,
  cancelSongRequest,
  completeSongRequest,
  confirmSongRequest,
  createSongState,
  markSongRequestPaid,
  markSongRequestRefunded,
  rejectSongRequest,
  startSongPerformance,
  submitSongRequest,
} from './song-domain.js'

const guest = { actorId: 'member-1', role: 'guest' as const }
const singer = { actorId: 'actor-singer-1', role: 'singer' as const }
const manager = { actorId: 'manager-1', role: 'manager' as const }
const staff = { actorId: 'server-1', role: 'staff' as const }

function makeState() {
  return createSongState({
    businessDate: '2026-07-14',
    singers: [
      { id: 'singer-1', displayName: '小霆', actorId: singer.actorId, active: true },
      { id: 'singer-2', displayName: '天天', actorId: 'actor-singer-2', active: true },
    ],
    songs: [
      { id: 'song-1', title: '海阔天空', artist: 'Beyond', durationSeconds: 326, active: true },
      { id: 'song-2', title: '后来', artist: '刘若英', durationSeconds: 341, active: true },
    ],
    repertoire: [
      {
        id: 'offer-1',
        singerId: 'singer-1',
        songId: 'song-1',
        priceAmount: 8800,
        currency: 'CNY',
        configVersion: 3,
        enabled: true,
      },
    ],
    performanceSessions: [
      {
        id: 'performance-1',
        businessDate: '2026-07-14',
        title: '第一轮演出',
        status: 'live',
        startsAt: '2026-07-14T20:30:00+08:00',
        endsAt: '2026-07-14T21:15:00+08:00',
        appearances: [
          {
            id: 'appearance-1',
            singerId: 'singer-1',
            startsAt: '2026-07-14T20:30:00+08:00',
            endsAt: '2026-07-14T20:50:00+08:00',
            requestOpensAt: '2026-07-14T20:30:00+08:00',
            requestClosesAt: '2026-07-14T20:45:00+08:00',
            acceptingRequests: true,
          },
        ],
      },
    ],
    tableSessions: [
      {
        id: 'table-session-A01-1',
        tableId: 'table-A01',
        tableCode: 'A01',
        status: 'open',
        openedAt: '2026-07-14T19:50:00+08:00',
        closedAt: null,
      },
    ],
    managerActorIds: [manager.actorId],
  })
}

function submit(state = makeState(), overrides: Partial<Parameters<typeof submitSongRequest>[1]> = {}) {
  const command = {
    requestId: 'request-1',
    performanceSessionId: 'performance-1',
    appearanceId: 'appearance-1',
    tableSessionId: 'table-session-A01-1',
    singerId: 'singer-1',
    songId: 'song-1',
    requestedBy: guest.actorId,
    customerNote: '生日祝福',
    occurredAt: '2026-07-14T20:35:00+08:00',
    idempotencyKey: 'submit-request-1',
    ...overrides,
  }
  return { state, request: submitSongRequest(state, command), command }
}

function pay(state: ReturnType<typeof makeState>, requestId = 'request-1') {
  const request = state.requests.find((item) => item.id === requestId)
  if (request?.status === 'pending_confirmation') {
    confirmSongRequest(state, {
      requestId,
      actor: staff,
      occurredAt: '2026-07-14T20:35:30+08:00',
      idempotencyKey: `confirm-${requestId}`,
    })
  }
  return markSongRequestPaid(state, {
    requestId,
    paymentReference: `pos-${requestId}`,
    paidAmount: 8800,
    currency: 'CNY',
    collectionChannel: 'physical_pos',
    actor: staff,
    occurredAt: '2026-07-14T20:36:00+08:00',
    idempotencyKey: `paid-${requestId}`,
  })
}

describe('paid song request lifecycle', () => {
  it('keeps price snapshot and completes the singer workflow with an audit trail', () => {
    const { state, request } = submit()
    expect(request.status).toBe('pending_confirmation')
    expect(request.priceSnapshot).toMatchObject({
      songTitle: '海阔天空',
      singerName: '小霆',
      priceAmount: 8800,
      currency: 'CNY',
      configVersion: 3,
    })

    pay(state)
    acceptSongRequest(state, {
      requestId: request.id,
      actor: singer,
      occurredAt: '2026-07-14T20:37:00+08:00',
      idempotencyKey: 'accept-request-1',
    })
    startSongPerformance(state, {
      requestId: request.id,
      actor: singer,
      occurredAt: '2026-07-14T20:40:00+08:00',
      idempotencyKey: 'start-request-1',
    })
    const completed = completeSongRequest(state, {
      requestId: request.id,
      actor: singer,
      occurredAt: '2026-07-14T20:45:00+08:00',
      idempotencyKey: 'complete-request-1',
    })

    expect(completed.status).toBe('completed')
    expect(completed.payment).toMatchObject({ paymentReference: 'pos-request-1', collectionChannel: 'physical_pos' })
    expect(state.auditEvents.map((event) => event.toStatus)).toEqual([
      'pending_confirmation',
      'pending_payment',
      'paid',
      'accepted',
      'performing',
      'completed',
    ])
  })

  it('returns the original request for a duplicate click and rejects changed key reuse', () => {
    const { state, request, command } = submit()
    const retried = submitSongRequest(state, command)
    expect(retried).toBe(request)
    expect(state.requests).toHaveLength(1)
    expect(state.auditEvents).toHaveLength(1)

    expect(() => submitSongRequest(state, { ...command, songId: 'song-2' })).toThrow(
      '幂等键已用于不同请求',
    )
  })

  it('moves a paid rejection to refund_required and records the eventual refund', () => {
    const { state, request } = submit()
    pay(state)
    const rejected = rejectSongRequest(state, {
      requestId: request.id,
      actor: manager,
      reason: '歌手临时身体不适',
      occurredAt: '2026-07-14T20:38:00+08:00',
      idempotencyKey: 'reject-request-1',
    })
    expect(rejected.status).toBe('refund_required')
    expect(rejected.refundReason).toBe('歌手临时身体不适')

    const refunded = markSongRequestRefunded(state, {
      requestId: request.id,
      actor: { actorId: 'refund-worker', role: 'system' },
      refundReference: 'wechat-refund-1',
      occurredAt: '2026-07-14T20:39:00+08:00',
      idempotencyKey: 'refund-request-1',
    })
    expect(refunded.status).toBe('refunded')
    expect(refunded.refundReference).toBe('wechat-refund-1')
  })

  it('lets an authorized manager take over acceptance and completion', () => {
    const { state, request } = submit()
    pay(state)
    acceptSongRequest(state, {
      requestId: request.id,
      actor: manager,
      occurredAt: '2026-07-14T20:37:00+08:00',
      idempotencyKey: 'manager-accept-request-1',
    })
    startSongPerformance(state, {
      requestId: request.id,
      actor: manager,
      occurredAt: '2026-07-14T20:40:00+08:00',
      idempotencyKey: 'manager-start-request-1',
    })
    completeSongRequest(state, {
      requestId: request.id,
      actor: manager,
      occurredAt: '2026-07-14T20:45:00+08:00',
      idempotencyKey: 'manager-complete-request-1',
    })
    expect(request.status).toBe('completed')
    expect(request.acceptedBy).toBe(manager.actorId)
  })

  it('uses the captured price even when the repertoire is reconfigured later', () => {
    const { state, request } = submit()
    state.repertoire[0]!.priceAmount = 12800
    confirmSongRequest(state, {
      requestId: request.id,
      actor: staff,
      occurredAt: '2026-07-14T20:35:30+08:00',
      idempotencyKey: 'confirm-before-wrong-price',
    })

    expect(() =>
      markSongRequestPaid(state, {
        requestId: request.id,
        paymentReference: 'wechat-pay-wrong-price',
        paidAmount: 12800,
        currency: 'CNY',
        collectionChannel: 'physical_pos',
        actor: staff,
        occurredAt: '2026-07-14T20:36:00+08:00',
        idempotencyKey: 'wrong-price-payment',
      }),
    ).toThrow('支付金额或币种与点歌价格快照不一致')
    expect(request.status).toBe('pending_payment')
    expect(request.priceSnapshot.priceAmount).toBe(8800)
  })
})

describe('song request business validation', () => {
  it('rejects a song outside the selected singer repertoire without mutation', () => {
    const state = makeState()
    expect(() => submit(state, { songId: 'song-2' })).toThrow('该歌手不会或暂不接受演唱此歌曲')
    expect(state.requests).toHaveLength(0)
    expect(state.auditEvents).toHaveLength(0)
  })

  it('turns a song that no longer fits the current slot into an extension negotiation', () => {
    const state = makeState()
    const { request } = submit(state, { occurredAt: '2026-07-14T20:46:00+08:00' })
    expect(request).toMatchObject({ requestMode: 'extension_negotiation', scheduleVersion: 1 })
  })

  it('rejects an overrun when the singer disabled extension negotiation', () => {
    const state = makeState()
    state.performanceSessions[0]!.appearances[0]!.extensionNegotiationEnabled = false
    expect(() => submit(state, { occurredAt: '2026-07-14T20:46:00+08:00' })).toThrow('当前不在该歌手可预约或协商的点歌时段')
  })

  it('accepts an advance reservation and keeps the schedule and repertoire versions', () => {
    const state = makeState()
    const performance = state.performanceSessions[0]!
    performance.startsAt = '2026-07-14T12:00:00+08:00'
    performance.configVersion = 4
    performance.appearances[0]!.requestOpensAt = '2026-07-14T12:00:00+08:00'
    const { request } = submit(state, { occurredAt: '2026-07-14T20:00:00+08:00' })
    expect(request).toMatchObject({ requestMode: 'advance_reservation', scheduleVersion: 4, priceSnapshot: { configVersion: 3 } })
  })

  it('requires an open table session', () => {
    const state = makeState()
    state.tableSessions[0]!.status = 'closed'
    state.tableSessions[0]!.closedAt = '2026-07-14T20:20:00+08:00'
    expect(() => submit(state)).toThrow('桌台尚未开台或已经结台')
  })

  it('does not allow the guest client to mark its own request paid', () => {
    const { state, request } = submit()
    confirmSongRequest(state, {
      requestId: request.id,
      actor: staff,
      occurredAt: '2026-07-14T20:35:30+08:00',
      idempotencyKey: 'confirm-before-guest-payment',
    })
    expect(() =>
      markSongRequestPaid(state, {
        requestId: request.id,
        paymentReference: 'untrusted-client-payment',
        paidAmount: 8800,
        currency: 'CNY',
        collectionChannel: 'cash',
        actor: guest,
        occurredAt: '2026-07-14T20:36:00+08:00',
        idempotencyKey: 'guest-marks-paid',
      }),
    ).toThrow('仅现场收款人员可以登记点歌收款')
    expect(request.status).toBe('pending_payment')
  })

  it('requires service confirmation before onsite collection', () => {
    const { state, request } = submit()
    expect(() => markSongRequestPaid(state, {
      requestId: request.id,
      paymentReference: 'pos-too-early',
      paidAmount: 8800,
      currency: 'CNY',
      collectionChannel: 'physical_pos',
      actor: staff,
      occurredAt: '2026-07-14T20:35:30+08:00',
      idempotencyKey: 'onsite-before-confirmation',
    })).toThrow('点歌请求状态pending_confirmation不能确认支付')
    expect(request.payment).toBeNull()
  })

  it('allows cancellation only before payment', () => {
    const { state, request } = submit()
    cancelSongRequest(state, {
      requestId: request.id,
      actor: guest,
      reason: '客人改选歌曲',
      occurredAt: '2026-07-14T20:36:00+08:00',
      idempotencyKey: 'cancel-request-1',
    })
    expect(request.status).toBe('cancelled')

    const second = submit(state, { requestId: 'request-2', idempotencyKey: 'submit-request-2' }).request
    pay(state, second.id)
    expect(() =>
      cancelSongRequest(state, {
        requestId: second.id,
        actor: guest,
        reason: '客人改变主意',
        occurredAt: '2026-07-14T20:37:00+08:00',
        idempotencyKey: 'cancel-request-2',
      }),
    ).toThrow('点歌请求状态paid不能变更为cancelled')
  })

  it('rejects illegal state transitions and the wrong singer', () => {
    const { state, request } = submit()
    expect(() =>
      acceptSongRequest(state, {
        requestId: request.id,
        actor: singer,
        occurredAt: '2026-07-14T20:36:00+08:00',
        idempotencyKey: 'accept-before-pay',
      }),
    ).toThrow('点歌请求状态pending_confirmation不能变更为accepted')

    pay(state)
    expect(() =>
      acceptSongRequest(state, {
        requestId: request.id,
        actor: { actorId: 'actor-singer-2', role: 'singer' },
        occurredAt: '2026-07-14T20:37:00+08:00',
        idempotencyKey: 'wrong-singer',
      }),
    ).toThrow('仅被点歌手本人可以处理该请求')
    expect(request.status).toBe('paid')
  })
})
