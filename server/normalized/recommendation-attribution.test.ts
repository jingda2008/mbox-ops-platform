import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface RecommendationAttribution {
  recommendationPublicId: string
  selectedProductId: string
}

const commonJsModule: { exports: Record<string, unknown> } = { exports: {} }
runInNewContext(
  readFileSync(new URL('../../miniprogram/utils/recommendation-attribution.js', import.meta.url), 'utf8'),
  { module: commonJsModule, exports: commonJsModule.exports },
)
const { checkoutRecommendationAttribution } = commonJsModule.exports as unknown as {
  checkoutRecommendationAttribution(
    checkoutUpgradeOfferPublicId: unknown,
    value: Partial<RecommendationAttribution> | null,
  ): RecommendationAttribution | null
}

describe('mini-program recommendation checkout attribution', () => {
  const selected = {
    recommendationPublicId: 'recommendation-public-0001',
    selectedProductId: '55555555-5555-4555-8555-555555555555',
  }

  it('keeps a selected recommendation on an unchanged basket', () => {
    expect(checkoutRecommendationAttribution(null, selected)).toEqual(selected)
  })

  it('drops the source recommendation attribution when checkout upgrade replaces the basket', () => {
    expect(checkoutRecommendationAttribution('checkout-upgrade-public-0001', selected)).toBeNull()
  })

  it('does not create a partial attribution from incomplete client state', () => {
    expect(checkoutRecommendationAttribution(null, {
      recommendationPublicId: selected.recommendationPublicId,
    })).toBeNull()
  })
})
