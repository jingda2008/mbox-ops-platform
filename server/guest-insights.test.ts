import { describe, expect, it } from 'vitest'
import { MemoryGuestInsightsStore } from './guest-insights.js'

describe('guest insights store', () => {
  it('deduplicates behavior and later links the anonymous history to WeChat and membership', async () => {
    const store = new MemoryGuestInsightsStore()
    const input = {
      anonymousId: 'ef27c8ad-c4ef-4e36-86ed-214965067e84',
      tableSessionId: 'visit-l01',
      tableCode: 'L01',
      businessDate: '2026-07-17',
      eventType: 'session_started' as const,
      source: 'guest_web' as const,
      occurredAt: '2026-07-17T12:30:00.000Z',
      metadata: { entry: 'table_qr' },
      idempotencyKey: 'visit-start-0001',
    }
    const first = await store.recordEvent(input)
    const replay = await store.recordEvent(input)
    expect(replay.id).toBe(first.id)
    expect(store.events).toHaveLength(1)
    expect(store.profiles.get(input.anonymousId)?.visitCount).toBe(1)

    const linked = await store.linkIdentity(input.anonymousId, {
      wechatPrincipalId: 'wechat-principal-1',
      memberId: 'member-amy',
    }, '2026-07-17T13:00:00.000Z')
    expect(linked).toMatchObject({
      anonymousId: input.anonymousId,
      wechatPrincipalId: 'wechat-principal-1',
      memberId: 'member-amy',
      visitCount: 1,
    })
  })
})
