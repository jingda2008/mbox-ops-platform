import { describe, expect, it } from 'vitest'
import type { MenuProduct } from './contracts.js'
import {
  bundleComparisonAmount,
  pickShakeRecommendation,
  rankMenuRecommendations,
  resolveAiMenuRecommendationRanking,
  selectMenuComparisonOptions,
  selectMenuRecommendationSlots,
} from './menu-recommendation.js'

function product(overrides: Partial<MenuProduct>): MenuProduct {
  return {
    id: 'product-default',
    sku: 'SKU-DEFAULT',
    name: '默认商品',
    specification: '1份',
    listPriceAmount: 6_800,
    costAmount: 1_800,
    stationId: 'bar-main',
    enabled: true,
    configVersion: 1,
    guestVisible: true,
    recommendation: {
      enabled: true, priority: 100, badge: '', headline: '', reason: '',
      minimumPartySize: 1, maximumPartySize: 100,
      sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
      singleWaveEligible: true, expectedPrepMinutes: 8, holdMinutes: 10, upgradeProductId: null,
    },
    ...overrides,
  }
}

describe('menu recommendation ranking', () => {
  it('uses party size and hidden-intent answers without removing other eligible beverage families', () => {
    const products = [
      product({
        id: 'cocktail',
        name: '双人鸡尾酒',
        beverageFamily: 'cocktail',
        recommendation: {
          enabled: true, priority: 100, badge: '', headline: '', reason: '',
          minimumPartySize: 2, maximumPartySize: 2,
          sceneTags: ['date'], intentTags: ['relaxed'], tasteTags: ['refreshing'], dwellTags: ['one_set'],
          singleWaveEligible: true, expectedPrepMinutes: 6, holdMinutes: 8, upgradeProductId: null,
        },
      }),
      product({
        id: 'wine',
        name: '双人葡萄酒',
        beverageFamily: 'wine',
        recommendation: {
          enabled: true, priority: 90, badge: '', headline: '', reason: '',
          minimumPartySize: 2, maximumPartySize: 4,
          sceneTags: ['date'], intentTags: ['ritual'], tasteTags: ['layered'], dwellTags: ['no_rush'],
          singleWaveEligible: true, expectedPrepMinutes: 5, holdMinutes: 20, upgradeProductId: null,
        },
      }),
    ]

    const ranked = rankMenuRecommendations(products, {
      partySize: 2,
      scene: 'date',
      intent: 'ritual',
      taste: 'layered',
      dwell: 'no_rush',
    })

    expect(ranked.map((item) => item.product.id)).toEqual(['wine', 'cocktail'])
    expect(ranked).toHaveLength(2)
  })

  it('changes the main choice when the guest gives materially different answers', () => {
    const products = [
      product({ id: 'entry', productKind: 'bundle', listPriceAmount: 20_800, beverageFamily: 'beer' }),
      product({
        id: 'relaxed',
        productKind: 'bundle',
        listPriceAmount: 24_800,
        beverageFamily: 'cocktail',
        recommendation: {
          ...product({}).recommendation!,
          priority: 180,
          intentTags: ['relaxed'],
          tasteTags: ['refreshing'],
          dwellTags: ['one_set'],
        },
      }),
      product({
        id: 'ritual',
        productKind: 'bundle',
        listPriceAmount: 26_800,
        beverageFamily: 'wine',
        recommendation: {
          ...product({}).recommendation!,
          priority: 170,
          intentTags: ['ritual'],
          tasteTags: ['layered'],
          dwellTags: ['no_rush'],
        },
      }),
      product({ id: 'complete', productKind: 'bundle', listPriceAmount: 34_800, beverageFamily: 'sparkling' }),
    ]

    const relaxed = selectMenuComparisonOptions(rankMenuRecommendations(products, {
      partySize: 2,
      intent: 'relaxed',
      taste: 'refreshing',
      dwell: 'one_set',
    }))
    const ritual = selectMenuComparisonOptions(rankMenuRecommendations(products, {
      partySize: 2,
      intent: 'ritual',
      taste: 'layered',
      dwell: 'no_rush',
    }))

    expect(relaxed.find((item) => item.role === 'primary')?.product.id).toBe('relaxed')
    expect(ritual.find((item) => item.role === 'primary')?.product.id).toBe('ritual')
  })

  it('hard-filters party-size mismatches and disabled recommendations', () => {
    const products = [
      product({
        id: 'two-person',
        recommendation: {
          enabled: true, priority: 100, badge: '', headline: '', reason: '',
          minimumPartySize: 2, maximumPartySize: 2,
          sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
          singleWaveEligible: true, expectedPrepMinutes: 5, holdMinutes: 5, upgradeProductId: null,
        },
      }),
      product({
        id: 'disabled',
        recommendation: {
          enabled: false, priority: 999, badge: '', headline: '', reason: '',
          minimumPartySize: 1, maximumPartySize: 100,
          sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
          singleWaveEligible: true, expectedPrepMinutes: 5, holdMinutes: 5, upgradeProductId: null,
        },
      }),
    ]

    expect(rankMenuRecommendations(products, { partySize: 4 })).toEqual([])
  })

  it('never recommends a product without positive contribution margin', () => {
    const lossLeader = product({
      id: 'loss-leader',
      listPriceAmount: 6_800,
      costAmount: 6_800,
      recommendation: {
        enabled: true, priority: 999, badge: '', headline: '', reason: '',
        minimumPartySize: 1, maximumPartySize: 100,
        sceneTags: [], intentTags: [], tasteTags: [], dwellTags: [],
        singleWaveEligible: true, expectedPrepMinutes: 2, holdMinutes: 10, upgradeProductId: null,
      },
    })

    expect(rankMenuRecommendations([lossLeader], { partySize: 2 })).toEqual([])
  })

  it('uses the server-returned order without exposing contribution scores to the customer', () => {
    const secondChoice = product({
      id: 'second-choice',
      listPriceAmount: 10_000,
      costAmount: 10_000,
      serverRecommendationOrder: 1,
    })
    const firstChoice = product({
      id: 'first-choice',
      listPriceAmount: 10_000,
      costAmount: 10_000,
      serverRecommendationOrder: 0,
    })
    const serverRejected = product({
      id: 'server-rejected',
      listPriceAmount: 10_000,
      costAmount: 10_000,
      serverRecommendationOrder: 2,
      recommendation: { ...product({}).recommendation!, enabled: false, priority: 999 },
    })

    const ranked = rankMenuRecommendations(
      [secondChoice, firstChoice, serverRejected],
      { partySize: 2 },
    )

    expect(ranked.map((entry) => entry.product.id)).toEqual(['first-choice', 'second-choice'])
  })

  it('computes bundle value from current component prices instead of a marketing claim', () => {
    const cocktail = product({ id: 'cocktail', listPriceAmount: 8_800 })
    const snack = product({ id: 'snack', listPriceAmount: 9_800 })
    const bundle = product({
      id: 'bundle',
      productKind: 'bundle',
      listPriceAmount: 24_800,
      bundleComponents: [
        { productId: cocktail.id, quantity: 2 },
        { productId: snack.id, quantity: 1 },
      ],
    })

    expect(bundleComparisonAmount(bundle, [cocktail, snack, bundle])).toBe(27_400)
    expect(rankMenuRecommendations([cocktail, snack, bundle], { partySize: 2 })[0]?.reason).toContain('少付26元')
  })

  it('keeps default, quick-select and shake on one ranked candidate pool', () => {
    const products = [
      product({ id: 'primary', listPriceAmount: 58_800, beverageFamily: 'wine' }),
      product({ id: 'lighter', listPriceAmount: 38_800, beverageFamily: 'beer' }),
      product({ id: 'complete', listPriceAmount: 88_800, beverageFamily: 'sparkling' }),
    ]
    const ranked = rankMenuRecommendations(products, { partySize: 2, intent: 'ritual' })
    const slots = selectMenuRecommendationSlots(ranked)
    const shaken = pickShakeRecommendation(ranked, new Set([ranked[0]!.product.id]), () => 0)

    expect(slots.primary?.product.id).toBe(ranked[0]?.product.id)
    expect(new Set(ranked.map((item) => item.product.id)).has(shaken!.product.id)).toBe(true)
    expect(shaken?.product.id).not.toBe(ranked[0]?.product.id)
  })

  it('only exposes an explicitly configured upgrade instead of guessing a higher-priced product', () => {
    const primary = product({ id: 'primary', listPriceAmount: 38_800 })
    const expensive = product({ id: 'expensive', listPriceAmount: 88_800 })
    const withoutUpgrade = selectMenuRecommendationSlots(rankMenuRecommendations([primary, expensive], { partySize: 2 }))
    expect(withoutUpgrade.complete).toBeNull()

    const configuredPrimary = product({
      id: 'configured-primary',
      listPriceAmount: 38_800,
      recommendation: {
        ...primary.recommendation!,
        priority: 200,
        upgradeProductId: expensive.id,
      },
    })
    const withUpgrade = selectMenuRecommendationSlots(
      rankMenuRecommendations([configuredPrimary, expensive], { partySize: 2 }),
    )
    expect(withUpgrade.complete?.product.id).toBe(expensive.id)
  })

  it('builds three distinct comparable choices when at least three eligible recommendations exist', () => {
    const lighter = product({ id: 'lighter', listPriceAmount: 20_800, beverageFamily: 'beer' })
    const primary = product({
      id: 'primary',
      listPriceAmount: 24_800,
      beverageFamily: 'cocktail',
      recommendation: {
        ...product({}).recommendation!,
        priority: 200,
        upgradeProductId: 'complete',
      },
    })
    const complete = product({ id: 'complete', listPriceAmount: 34_800, beverageFamily: 'cocktail' })
    const alternative = product({ id: 'alternative', listPriceAmount: 26_800, beverageFamily: 'wine' })
    const ranked = rankMenuRecommendations([primary, lighter, complete, alternative], { partySize: 2 })
    const options = selectMenuComparisonOptions(ranked)

    expect(options).toHaveLength(3)
    expect(options.map((item) => item.product.id)).toEqual(['lighter', 'primary', 'complete'])
    expect(options.map((item) => item.role)).toEqual(['lighter', 'primary', 'complete'])
    expect(new Set(options.map((item) => item.product.id)).size).toBe(3)
  })

  it('fills the comparison row from ranked candidates without inventing an upgrade', () => {
    const ranked = rankMenuRecommendations([
      product({ id: 'first', recommendation: { ...product({}).recommendation!, priority: 300 } }),
      product({ id: 'second', listPriceAmount: 5_800 }),
      product({ id: 'third', listPriceAmount: 7_800 }),
    ], { partySize: 2 })
    const slots = selectMenuRecommendationSlots(ranked)
    const options = selectMenuComparisonOptions(ranked, slots)

    expect(slots.complete).toBeNull()
    expect(options).toHaveLength(3)
    expect(new Set(options.map((item) => item.product.id)).size).toBe(3)
  })

  it('keeps the best-matched product as the main choice instead of replacing it with a fixed price midpoint', () => {
    const ranked = rankMenuRecommendations([
      product({ id: 'entry', listPriceAmount: 49_800, recommendation: { ...product({}).recommendation!, priority: 280 } }),
      product({ id: 'cheap-top-score', listPriceAmount: 58_800, recommendation: { ...product({}).recommendation!, priority: 400 } }),
      product({ id: 'middle-wine', listPriceAmount: 88_800, beverageFamily: 'wine', recommendation: { ...product({}).recommendation!, priority: 320 } }),
      product({ id: 'middle-sparkling', listPriceAmount: 88_800, beverageFamily: 'sparkling', recommendation: { ...product({}).recommendation!, priority: 300 } }),
      product({ id: 'complete', listPriceAmount: 128_800, recommendation: { ...product({}).recommendation!, priority: 260 } }),
    ], { partySize: 2 })

    const options = selectMenuComparisonOptions(ranked)

    expect(options.map((item) => item.product.id)).toEqual(['entry', 'cheap-top-score', 'middle-wine'])
    expect(options.map((item) => item.role)).toEqual(['lighter', 'primary', 'alternative'])
  })

  it('changes the visible primary and comparison set for materially different two-person answers', () => {
    const recommendation = (overrides: Partial<NonNullable<MenuProduct['recommendation']>>) => ({
      ...product({}).recommendation!,
      minimumPartySize: 2,
      maximumPartySize: 2,
      ...overrides,
    })
    const products = [
      product({
        id: 'cocktail-night', name: '双人鸡尾酒完整夜', productKind: 'bundle',
        listPriceAmount: 62_800, beverageFamily: 'cocktail',
        recommendation: recommendation({
          priority: 10, intentTags: ['relaxed', 'energetic', 'ritual'],
          tasteTags: ['refreshing', 'layered'], dwellTags: ['one_set', 'stay_longer'],
        }),
      }),
      product({
        id: 'beer-night', name: '双人啤酒现场', productKind: 'bundle',
        listPriceAmount: 68_800, beverageFamily: 'beer',
        recommendation: recommendation({
          priority: 13, intentTags: ['relaxed', 'energetic'],
          tasteTags: ['refreshing'], dwellTags: ['one_set', 'stay_longer'],
        }),
      }),
      product({
        id: 'wine-night', name: '双人葡萄酒共叙', productKind: 'bundle',
        listPriceAmount: 98_800, beverageFamily: 'wine',
        recommendation: recommendation({
          priority: 16, intentTags: ['relaxed', 'ritual'],
          tasteTags: ['layered'], dwellTags: ['one_set', 'stay_longer'],
        }),
      }),
      product({
        id: 'sparkling-night', name: '双人起泡夜', productKind: 'bundle',
        listPriceAmount: 88_800, beverageFamily: 'sparkling',
        recommendation: recommendation({
          priority: 19, intentTags: ['ritual', 'energetic'],
          tasteTags: ['refreshing'], dwellTags: ['one_set', 'stay_longer'],
        }),
      }),
      product({
        id: 'spirits-night', name: '双人开瓶主场', productKind: 'bundle',
        listPriceAmount: 148_800, beverageFamily: 'spirits',
        recommendation: recommendation({
          priority: 22, intentTags: ['energetic', 'ritual'],
          tasteTags: ['strong', 'layered'], dwellTags: ['one_set', 'stay_longer'],
        }),
      }),
    ]

    const relaxed = selectMenuComparisonOptions(rankMenuRecommendations(products, {
      partySize: 2, intent: 'relaxed', taste: 'refreshing', dwell: 'one_set',
    }))
    const ritual = selectMenuComparisonOptions(rankMenuRecommendations(products, {
      partySize: 2, intent: 'ritual', taste: 'layered', dwell: 'no_rush',
    }))

    expect(relaxed.find((item) => item.role === 'primary')?.product.id).toBe('beer-night')
    expect(ritual.find((item) => item.role === 'primary')?.product.id).toBe('spirits-night')
    expect(relaxed.map((item) => item.product.id)).not.toEqual(ritual.map((item) => item.product.id))
  })

  it('keeps the three-way comparison focused on bundles when enough bundle choices are available', () => {
    const single = product({ id: 'single', listPriceAmount: 6_800, recommendation: { ...product({}).recommendation!, priority: 500 } })
    const bundles = [
      product({ id: 'bundle-entry', productKind: 'bundle', listPriceAmount: 20_800 }),
      product({ id: 'bundle-main', productKind: 'bundle', listPriceAmount: 24_800 }),
      product({ id: 'bundle-complete', productKind: 'bundle', listPriceAmount: 34_800 }),
    ]
    const options = selectMenuComparisonOptions(
      rankMenuRecommendations([single, ...bundles], { partySize: 2 }),
    )

    expect(options.map((item) => item.product.id)).toEqual(['bundle-entry', 'bundle-main', 'bundle-complete'])
    expect(options.every((item) => item.product.productKind === 'bundle')).toBe(true)
  })

  it('keeps the higher-value choice centered when three bundles only cover two real price points', () => {
    const options = selectMenuComparisonOptions(rankMenuRecommendations([
      product({ id: 'entry', productKind: 'bundle', listPriceAmount: 58_800, beverageFamily: 'beer' }),
      product({
        id: 'main',
        productKind: 'bundle',
        listPriceAmount: 88_800,
        beverageFamily: 'wine',
        recommendation: { ...product({}).recommendation!, priority: 300 },
      }),
      product({ id: 'same-price-style', productKind: 'bundle', listPriceAmount: 88_800, beverageFamily: 'sparkling' }),
    ], { partySize: 2 }))

    expect(options.map((item) => item.product.id)).toEqual(['entry', 'main', 'same-price-style'])
    expect(options.map((item) => item.role)).toEqual(['lighter', 'primary', 'alternative'])
  })

  it('uses AI only to rerank products already admitted by deterministic business rules', () => {
    const ranked = rankMenuRecommendations([
      product({ id: 'beer', beverageFamily: 'beer' }),
      product({ id: 'wine', beverageFamily: 'wine' }),
      product({ id: 'sparkling', beverageFamily: 'sparkling' }),
    ], { partySize: 2 })

    const resolved = resolveAiMenuRecommendationRanking(ranked, {
      productIds: ['wine', 'sparkling', 'beer'],
      reasons: { wine: '更贴合今晚想慢慢聊的节奏' },
    })

    expect(resolved.source).toBe('ai')
    expect(resolved.ranked.map((item) => item.product.id)).toEqual(['wine', 'sparkling', 'beer'])
    expect(resolved.ranked[0]?.reason).toBe('更贴合今晚想慢慢聊的节奏')
  })

  it.each([
    [{ productIds: ['wine', 'wine', 'beer'] }, 'duplicate_product'],
    [{ productIds: ['wine', 'sparkling', 'not-orderable'] }, 'unknown_product'],
    [{ productIds: ['wine'] }, 'insufficient_choices'],
    [{ productIds: ['wine', 'sparkling', 'beer'], reasons: { wine: '今晚免费再少付20元' } }, 'unsafe_reason'],
  ] as const)('falls back to deterministic ranking when AI output is invalid', (aiRecommendation, fallbackReason) => {
    const ranked = rankMenuRecommendations([
      product({ id: 'beer', beverageFamily: 'beer' }),
      product({ id: 'wine', beverageFamily: 'wine' }),
      product({ id: 'sparkling', beverageFamily: 'sparkling' }),
    ], { partySize: 2 })

    const resolved = resolveAiMenuRecommendationRanking(ranked, aiRecommendation)

    expect(resolved.source).toBe('rules_fallback')
    expect(resolved.fallbackReason).toBe(fallbackReason)
    expect(resolved.ranked).toEqual(ranked)
  })
})
