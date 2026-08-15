import { describe, expect, it, vi } from 'vitest'
import {
  PublicReservationApi,
  PublicReservationApiError,
  withReservationSessionRecovery,
} from './reservation-api'

type FetchCall = [input: RequestInfo | URL, init?: RequestInit]

describe('PublicReservationApi', () => {
  it('loads the selected date performance without requiring a reservation mutation', async () => {
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ data: {
      timezone: 'Asia/Shanghai', localDate: '2026-08-12', phase: 'upcoming',
      current: null, startsInSeconds: 3600, remainingSeconds: null,
      next: {
        id: 'schedule-0001', performerStageName: '李艳', performerProfile: { genres: ['流行'] },
        startsAt: '2026-08-12T12:30:00.000Z', endsAt: '2026-08-12T13:15:00.000Z',
        status: 'scheduled', sortOrder: 1,
      },
      schedules: [{
        id: 'schedule-0001', performerStageName: '李艳', performerProfile: { genres: ['流行'] },
        startsAt: '2026-08-12T12:30:00.000Z', endsAt: '2026-08-12T13:15:00.000Z',
        status: 'scheduled', sortOrder: 1,
      }],
    } }))
    const api = new PublicReservationApi({ fetch: send as unknown as typeof globalThis.fetch })

    await expect(api.performance('2026-08-12')).resolves.toMatchObject({
      phase: 'upcoming', next: { performerStageName: '李艳' },
    })
    expect(String(send.mock.calls[0]?.[0])).toBe('/api/public/reservation/performances?date=2026-08-12')
    expect(send.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('uses HttpOnly-cookie credentials and does not put identity or contact in URLs', async () => {
    const calls: FetchCall[] = []
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init])
      return json({ data: { status: 'active', expiresAt: '2026-08-12T12:00:00Z', capabilities: [] } }, 201)
    }) as unknown as typeof fetch
    const api = new PublicReservationApi({ fetch: send, createIdempotencyKey: () => 'session-command-0001' })

    await api.issueSession({
      provider: 'wechat',
      providerAssertion: 'wechat-assertion-secret',
      deviceFingerprint: 'device-fingerprint-secret',
    })

    expect(String(calls[0]?.[0])).toBe('/api/public/reservation/session')
    expect(calls[0]?.[1]?.credentials).toBe('include')
    expect(new Headers(calls[0]?.[1]?.headers).get('idempotency-key')).toBe('session-command-0001')
    expect(new Headers(calls[0]?.[1]?.headers).get('x-mbox-guest-device')).toBe('device-fingerprint-secret')
    expect(String(calls[0]?.[0])).not.toContain('wechat-assertion-secret')
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ provider: 'wechat' })
  })

  it('maps availability into privacy-safe areas and supports future status values', async () => {
    const send = vi.fn(async () => json({ data: availabilityData() })) as unknown as typeof fetch
    const api = new PublicReservationApi({ fetch: send })
    const result = await api.availability('2026-08-12T20:30:00+08:00', 2)

    expect(result.areas[0]).toMatchObject({ name: '舞台前区', zone: 'stage-front' })
    expect(result.areas[0]?.tables[0]).toMatchObject({ code: 'VIP1', status: 'available', minimumSpendMinor: 188800 })
    expect(JSON.stringify(result)).not.toContain('customerName')
    expect(JSON.stringify(result)).not.toContain('contact')
  })

  it('preserves conflict and rate-limit recovery details', async () => {
    const conflictApi = new PublicReservationApi({
      fetch: vi.fn(async () => json({ error: { code: 'RESERVATION_CAPACITY_FULL', message: '这个时段预约已满' } }, 409)) as unknown as typeof fetch,
      createIdempotencyKey: () => 'reservation-command-0001',
    })
    await expect(conflictApi.createReservation('direct', {
      customerName: '王女士', contact: '13800138000', guestCount: 2,
      arrivalAt: '2026-08-12T20:30:00+08:00',
    })).rejects.toMatchObject({ code: 'RESERVATION_CAPACITY_FULL', seatConflict: true })

    const retryAt = '2026-08-12T12:00:30.000Z'
    const rateApi = new PublicReservationApi({
      fetch: vi.fn(async () => json({ error: { code: 'PUBLIC_RESERVATION_RATE_LIMITED', message: '操作有点快', retryAt } }, 429)) as unknown as typeof fetch,
    })
    await expect(rateApi.availability('2026-08-12T20:30:00+08:00', 2)).rejects.toMatchObject({ retryAt, retryable: true })
  })

  it('keeps a network failure retryable without manufacturing a successful reservation', async () => {
    const api = new PublicReservationApi({ fetch: vi.fn(async () => { throw new TypeError('offline') }) as unknown as typeof fetch })
    await expect(api.availability('2026-08-12T20:30:00+08:00', 2)).rejects.toSatisfy((error: unknown) => (
      error instanceof PublicReservationApiError && error.kind === 'network' && error.retryable
    ))
  })

  it('renews one expired session and retries the protected operation once', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new PublicReservationApiError(
        '预约会话已失效，请重新进入预约页面',
        'RESERVATION_SESSION_INVALID',
        401,
      ))
      .mockResolvedValueOnce('reservation-created')
    const renew = vi.fn().mockResolvedValue(undefined)

    await expect(withReservationSessionRecovery(operation, renew)).resolves.toBe('reservation-created')
    expect(renew).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('does not loop when the renewed session is still rejected', async () => {
    const invalid = new PublicReservationApiError(
      '预约会话已失效，请重新进入预约页面',
      'RESERVATION_SESSION_INVALID',
      401,
    )
    const operation = vi.fn().mockRejectedValue(invalid)
    const renew = vi.fn().mockResolvedValue(undefined)

    await expect(withReservationSessionRecovery(operation, renew)).rejects.toBe(invalid)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledTimes(2)
  })
})

function availabilityData() {
  return {
    arrivalAt: '2026-08-12T12:30:00.000Z', expectedEndAt: '2026-08-12T16:30:00.000Z', guestCount: 2,
    acceptingReservations: true,
    depositRule: { enabled: false, mode: 'disabled', amountMinor: 0, ruleText: null },
    areas: [{
      code: 'VIP', name: '舞台前区', type: 'vip',
      tables: [{ code: 'VIP1', name: 'VIP 1', capacity: 6, minimumSpendMinor: 188800, currency: 'CNY', available: true }],
    }],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
