import { describe, expect, it } from 'vitest'
import { guestFeedbackIdempotencyKey } from './guest-portal-utils'

describe('guest feedback idempotency key', () => {
  it('stays within the API limit regardless of the service task ID length', () => {
    const first = guestFeedbackIdempotencyKey('confirm')
    const second = guestFeedbackIdempotencyKey('confirm')

    expect(first.length).toBeLessThanOrEqual(128)
    expect(first).toMatch(/^guest-feedback-confirm-/)
    expect(second).not.toBe(first)
  })
})
