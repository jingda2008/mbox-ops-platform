import { describe, expect, it } from 'vitest'
import { guestFeedbackIdempotencyKey, guestMoodServiceNote } from './guest-portal-utils'

describe('guest feedback idempotency key', () => {
  it('stays within the API limit regardless of the service task ID length', () => {
    const first = guestFeedbackIdempotencyKey('confirm')
    const second = guestFeedbackIdempotencyKey('confirm')

    expect(first.length).toBeLessThanOrEqual(128)
    expect(first).toMatch(/^guest-feedback-confirm-/)
    expect(second).not.toBe(first)
  })
})

describe('guest mood service note', () => {
  it('turns a guest mood into an actionable note within the API limit', () => {
    const note = guestMoodServiceNote('微醺', '请主动补水，关注饮酒节奏和身体状态，避免继续强推酒水。')

    expect(note).toContain('客户心情反馈：微醺')
    expect(note).toContain('请主动补水')
    expect(note).toContain('服务专员')
    expect(note.length).toBeLessThanOrEqual(300)
  })
})
