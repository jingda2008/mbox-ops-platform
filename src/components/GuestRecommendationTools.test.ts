import { describe, expect, it } from 'vitest'
import {
  GUEST_RECOMMENDATION_QUESTIONS,
  GUEST_SHAKE_FEEDBACK_PATTERNS,
  GUEST_SHAKE_RECOMMENDATION_COPY,
  applyGuestRecommendationAnswer,
  canRequestAnotherShake,
  isGuestRecommendationComplete,
  shouldRevealShakeProduct,
  type GuestRecommendationContext,
} from './GuestRecommendationTools'

describe('guest recommendation quick selection', () => {
  it('defines the three decision-driving questions in the required order', () => {
    expect(GUEST_RECOMMENDATION_QUESTIONS.map((question) => question.field)).toEqual([
      'intent',
      'taste',
      'dwell',
    ])
    expect(GUEST_RECOMMENDATION_QUESTIONS[0]?.options.map((option) => option.value)).toEqual([
      'relaxed',
      'energetic',
      'ritual',
      'unsure',
    ])
    expect(GUEST_RECOMMENDATION_QUESTIONS[1]?.options.map((option) => option.value)).toEqual([
      'refreshing',
      'layered',
      'strong',
      'any',
    ])
    expect(GUEST_RECOMMENDATION_QUESTIONS[2]?.options.map((option) => option.value)).toEqual([
      'one_set',
      'stay_longer',
      'no_rush',
    ])
  })

  it('builds a complete context without losing earlier answers', () => {
    const intent = applyGuestRecommendationAnswer({}, 'intent', 'ritual')
    const taste = applyGuestRecommendationAnswer(intent, 'taste', 'layered')
    const complete = applyGuestRecommendationAnswer(taste, 'dwell', 'no_rush')

    expect(complete).toEqual({
      intent: 'ritual',
      taste: 'layered',
      dwell: 'no_rush',
    })
    expect(isGuestRecommendationComplete(complete)).toBe(true)
  })

  it('supports optional and partially completed recommendation context', () => {
    const context: GuestRecommendationContext = { intent: 'unsure' }

    expect(isGuestRecommendationComplete({})).toBe(false)
    expect(isGuestRecommendationComplete(context)).toBe(false)
    expect(applyGuestRecommendationAnswer(context, 'taste', 'any')).toEqual({
      intent: 'unsure',
      taste: 'any',
    })
  })
})

describe('guest recommendation shake presentation', () => {
  it('allows another request only while the parent-provided limit remains', () => {
    expect(canRequestAnotherShake(0, 3)).toBe(true)
    expect(canRequestAnotherShake(2, 3)).toBe(true)
    expect(canRequestAnotherShake(3, 3)).toBe(false)
    expect(canRequestAnotherShake(4, 3)).toBe(false)
    expect(canRequestAnotherShake(0, 0)).toBe(false)
  })

  it('uses the lightweight two-stage feedback patterns and concise relationship copy', () => {
    expect(GUEST_SHAKE_FEEDBACK_PATTERNS.start).toEqual([28, 45, 28])
    expect(GUEST_SHAKE_FEEDBACK_PATTERNS.reveal).toEqual([45, 30, 70])
    expect(GUEST_SHAKE_RECOMMENDATION_COPY).toBe('根据今晚的选择替你挑一款')
  })

  it('reveals feedback only after an armed shake returns a different product', () => {
    expect(shouldRevealShakeProduct(true, '', 'product-1')).toBe(true)
    expect(shouldRevealShakeProduct(true, 'product-1', 'product-2')).toBe(true)
    expect(shouldRevealShakeProduct(true, 'product-1', 'product-1')).toBe(false)
    expect(shouldRevealShakeProduct(false, 'product-1', 'product-2')).toBe(false)
    expect(shouldRevealShakeProduct(true, 'product-1', '')).toBe(false)
  })
})
