import { describe, expect, it } from 'vitest'
import { hapticEnabledForContext, shouldTrackMutation } from './interaction-feedback'

describe('shouldTrackMutation', () => {
  it('tracks user mutations and excludes reads and background telemetry', () => {
    expect(shouldTrackMutation('/api/tasks/1/actions', 'POST')).toBe(true)
    expect(shouldTrackMutation('/api/payments/table-intents', 'POST')).toBe(true)
    expect(shouldTrackMutation('/api/bootstrap', 'GET')).toBe(false)
    expect(shouldTrackMutation('/api/auth/presence/heartbeat', 'POST')).toBe(false)
    expect(shouldTrackMutation('/api/guest/events', 'POST')).toBe(false)
  })
})

describe('hapticEnabledForContext', () => {
  it('keeps employee feedback on while limiting guest feedback to explicit actions', () => {
    expect(hapticEnabledForContext(false)).toBe(true)
    expect(hapticEnabledForContext(true)).toBe(false)
    expect(hapticEnabledForContext(true, 'action')).toBe(true)
  })
})
