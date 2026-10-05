import { describe, expect, it } from 'vitest'
import { PublicReservationApi, type PublicReservationApiOptions } from './reservation-api'

const identity = { provider: 'anonymous' as const, providerAssertion: 'anonymous-browser-identity', deviceFingerprint: 'web-device-fingerprint' }
const input = { customerName: '恢复预约测试', contact: '13800138000', guestCount: 2, arrivalAt: '2026-10-06T12:30:00.000Z', expectedEndAt: '2026-10-06T16:30:00.000Z', reservationPolicyVersion: 1, note: null }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }) }
function harness() {
  const records = new Map<string, string>()
  const reservations = new Map<string, object>()
  const posts: { key: string | null; body: Record<string, unknown> }[] = []
  let scope = 'a'.repeat(64), behavior = 'normal', now = Date.now(), keys = 0
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value) }, removeItem: (key: string) => { records.delete(key) } }
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/session')) return json({ data: { recoveryScope: scope } })
    if (init?.method === 'GET') {
      if (behavior === 'read-fails') return json({ error: { code: 'UNAVAILABLE', message: '查询暂不可用' } }, 503)
      const value = reservations.get(String(url).split('/').at(-1)!)
      return value ? json({ data: value }) : json({ error: { code: 'RESERVATION_NOT_FOUND', message: '未找到预约' } }, 404)
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    posts.push({ key: new Headers(init?.headers).get('idempotency-key'), body })
    if (behavior === 'uncommitted') throw new TypeError('request did not arrive')
    if (behavior === 'capacity') return json({ error: { code: 'RESERVATION_CAPACITY_FULL', message: '满额' } }, 409)
    if (behavior === 'unknown-conflict') return json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '原请求冲突' } }, 409)
    const saved = { ...body, maskedContact: '138****8000', status: 'pending', arrivalState: 'not_arrived', arrivalGraceEndsAt: '2026-10-06T12:40:00.000Z', preferredScheduleId: null, cancellationPolicy: {} }
    reservations.set(String(body.publicId), saved)
    if (behavior === 'lost-response') throw new TypeError('server committed; response lost')
    return json({ data: saved }, 201)
  }
  const create = async (options: Partial<PublicReservationApiOptions> = {}) => {
    const api = new PublicReservationApi({ fetch, storage, now: () => now, createIdempotencyKey: () => `web-command-${++keys}`, ...options })
    await api.issueSession(identity)
    return api
  }
  return { records, reservations, posts, storage, fetch, create, setScope: (value: string) => { scope = value }, setBehavior: (value: string) => { behavior = value }, advance: (ms: number) => { now += ms } }
}

describe('web original reservation recovery', () => {
  it('recovers a committed lost response after reopening without another POST', async () => {
    const h = harness(), api = await h.create()
    h.setBehavior('lost-response')
    await expect(api.createReservation('direct', input)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const pending = api.getPendingReservation()
    expect(pending).toMatchObject({ arrivalAt: input.arrivalAt, guestCount: 2 })
    expect([...h.records.values()][0]).not.toContain(identity.providerAssertion)
    h.setBehavior('normal')
    const reopened = await h.create()
    await expect(reopened.recoverReservation()).resolves.toMatchObject({ publicId: pending!.publicId })
    expect(h.posts).toHaveLength(1)
    expect(h.reservations.size).toBe(1)
    expect(reopened.getPendingReservation()).toBeNull()
  })

  it('replays exactly the original payload and key only after a definite own 404', async () => {
    const h = harness(), api = await h.create()
    h.setBehavior('uncommitted')
    await expect(api.createReservation('direct', input)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    h.setBehavior('normal')
    await (await h.create()).recoverReservation()
    expect(h.posts).toHaveLength(2)
    expect(h.posts[1]).toEqual(h.posts[0])
    expect(h.reservations.size).toBe(1)
  })

  it('blocks changed payload and preserves the original attempt when lookup fails', async () => {
    const h = harness(), api = await h.create()
    h.setBehavior('lost-response')
    await expect(api.createReservation('direct', input)).rejects.toThrow()
    await expect(api.createReservation('direct', { ...input, guestCount: 8 })).rejects.toMatchObject({ code: 'RESERVATION_SUBMISSION_PENDING' })
    const before = [...h.records]
    h.setBehavior('read-fails')
    await expect((await h.create()).recoverReservation()).rejects.toMatchObject({ status: 503 })
    expect([...h.records]).toEqual(before)
    expect(h.posts).toHaveLength(1)
  })

  it('isolates customers and stores using the trusted opaque session scope', async () => {
    const h = harness(), api = await h.create()
    h.setBehavior('uncommitted')
    await expect(api.createReservation('direct', input)).rejects.toThrow()
    h.setScope('b'.repeat(64))
    const other = await h.create()
    expect(other.getPendingReservation()).toBeNull()
    expect(await other.recoverReservation()).toBeNull()
    expect(h.posts).toHaveLength(1)
    h.setScope('a'.repeat(64))
    expect((await h.create()).getPendingReservation()).not.toBeNull()
  })

  it('requires durable storage before sending and keeps unknown conflicts', async () => {
    const h = harness()
    const unavailable = await h.create({ storage: { ...h.storage, setItem: () => { throw new Error('quota') } } })
    expect(() => unavailable.createReservation('direct', input)).toThrow('本机未能保存')
    expect(h.posts).toHaveLength(0)
    const api = await h.create()
    h.setBehavior('unknown-conflict')
    await expect(api.createReservation('direct', input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(api.getPendingReservation()).not.toBeNull()
  })

  it('clears only definitive rejections and coalesces same in-flight creation', async () => {
    const h = harness(), api = await h.create()
    h.setBehavior('capacity')
    const first = api.createReservation('direct', input)
    expect(api.createReservation('direct', input)).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'RESERVATION_CAPACITY_FULL' })
    expect(h.posts).toHaveLength(1)
    expect(api.getPendingReservation()).toBeNull()
  })

  it('does not apply a late receipt or clear original storage after identity changes', async () => {
    const h = harness()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const api = await h.create({ fetch: async (url, init) => {
      const response = await h.fetch(url, init)
      if (String(url).endsWith('/reservations') && init?.method === 'POST') await gate
      return response
    } })
    const submitting = api.createReservation('direct', input)
    h.setScope('b'.repeat(64))
    await api.issueSession({ ...identity, providerAssertion: 'different-person' })
    release!()
    await expect(submitting).rejects.toMatchObject({ code: 'RESERVATION_SUBMISSION_SCOPE_CHANGED' })
    expect(api.getPendingReservation()).toBeNull()
    expect(h.records.size).toBe(1)
    h.setScope('a'.repeat(64))
    await expect((await h.create()).recoverReservation()).resolves.toMatchObject({ status: 'pending' })
    expect(h.posts).toHaveLength(1)
  })

  it('cannot overwrite the latest trusted identity with a late session response', async () => {
    const h = harness()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    let slow = false
    const api = await h.create({ fetch: async (url, init) => {
      const response = await h.fetch(url, init)
      if (slow && String(url).endsWith('/session')) { slow = false; await gate }
      return response
    } })
    h.setBehavior('uncommitted')
    await expect(api.createReservation('direct', input)).rejects.toThrow()
    slow = true
    const originalRenewal = api.issueSession(identity)
    h.setScope('b'.repeat(64))
    await api.issueSession({ ...identity, providerAssertion: 'different-person' })
    release!()
    await originalRenewal
    expect(api.getPendingReservation()).toBeNull()
    expect(h.records.size).toBe(1)
  })

  it('allows old committed readback but forbids unknown creation after recovery deadline', async () => {
    for (const committed of [false, true]) {
      const h = harness(), api = await h.create()
      h.setBehavior(committed ? 'lost-response' : 'uncommitted')
      await expect(api.createReservation('direct', input)).rejects.toThrow()
      h.advance(25 * 60 * 60_000)
      h.setBehavior('normal')
      const reopened = await h.create()
      if (committed) await expect(reopened.recoverReservation()).resolves.toMatchObject({ status: 'pending' })
      else await expect(reopened.recoverReservation()).rejects.toMatchObject({ code: 'RESERVATION_SUBMISSION_EXPIRED' })
      expect(h.posts).toHaveLength(1)
    }
  })
})
