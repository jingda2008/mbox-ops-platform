import { describe, expect, it } from 'vitest'
import { isMenuConfirmationDisabled } from './MenuOrderingWorkspace'

describe('menu order confirmations', () => {
  it('allows a guest to confirm a new cart adjustment even while checkout is temporarily unavailable', () => {
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: true,
      confirmation: 'continue',
      confirmedDuplicateOrderId: '',
    })).toBe(false)
  })

  it('keeps an unavailable checkout and an unconfirmed duplicate order blocked', () => {
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: true,
      confirmation: 'submit',
      confirmedDuplicateOrderId: '',
    })).toBe(true)
    expect(isMenuConfirmationDisabled({
      busy: false,
      submitDisabled: false,
      confirmation: 'duplicate',
      confirmedDuplicateOrderId: '',
    })).toBe(true)
  })
})
