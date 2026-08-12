import { describe, expect, it, vi } from 'vitest'
import { PublicReservationApi, PublicReservationApiError } from './reservation-api'

type FetchCall = [input: RequestInfo | URL, init?: RequestInit]

describe('PublicReservationApi', () => {
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
      fetch: vi.fn(async () => json({ error: { code: 'TABLE_ALREADY_RESERVED', message: '这个位置刚刚被预订' } }, 409)) as unknown as typeof fetch,
      createIdempotencyKey: () => 'reservation-command-0001',
    })
    await expect(conflictApi.createReservation('self_select', {
      customerName: '王女士', contact: '13800138000', guestCount: 2,
      arrivalAt: '2026-08-12T20:30:00+08:00', tableCodes: ['VIP1'],
    })).rejects.toMatchObject({ code: 'TABLE_ALREADY_RESERVED', seatConflict: true })

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
})

function availabilityData() {
  return {
    arrivalAt: '2026-08-12T12:30:00.000Z', expectedEndAt: '2026-08-12T16:30:00.000Z', guestCount: 2,
    holdMinutes: 20,
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
