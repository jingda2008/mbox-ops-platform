import type {
  MenuBeverageFamily,
  MenuProduct,
  MenuRecommendationConfig,
  MenuRecommendationDwell,
  MenuRecommendationIntent,
  MenuRecommendationScene,
  MenuRecommendationTaste,
} from './contracts.js'
import { resolveMenuBeverageFamily } from './menu-product-classification.js'

export interface MenuRecommendationContext {
  partySize: number
  scene?: MenuRecommendationScene
  intent?: MenuRecommendationIntent
  taste?: MenuRecommendationTaste
  dwell?: MenuRecommendationDwell
}

export interface RankedMenuProduct {
  product: MenuProduct
  score: number
  reason: string
}

export interface MenuRecommendationSlots {
  primary: RankedMenuProduct | null
  lighter: RankedMenuProduct | null
  complete: RankedMenuProduct | null
}

export type MenuComparisonRole = 'lighter' | 'primary' | 'complete' | 'alternative'

export interface MenuComparisonOption extends RankedMenuProduct {
  role: MenuComparisonRole
}

export interface AiMenuRecommendation {
  productIds: readonly string[]
  reasons?: Readonly<Record<string, string>>
}

export type MenuRecommendationResolutionSource = 'ai' | 'rules' | 'rules_fallback'

export interface ResolvedMenuRecommendationRanking {
  ranked: RankedMenuProduct[]
  source: MenuRecommendationResolutionSource
  fallbackReason: 'missing' | 'insufficient_choices' | 'duplicate_product' | 'unknown_product' | 'unsafe_reason' | null
}

export const defaultMenuRecommendation: MenuRecommendationConfig = {
  enabled: false,
  priority: 100,
  badge: '',
  headline: '',
  reason: '',
  minimumPartySize: 1,
  maximumPartySize: 100,
  sceneTags: [],
  intentTags: [],
  tasteTags: [],
  dwellTags: [],
  singleWaveEligible: true,
  expectedPrepMinutes: 8,
  holdMinutes: 10,
  upgradeProductId: null,
}

export function recommendationConfig(product: MenuProduct): MenuRecommendationConfig {
  return {
    ...defaultMenuRecommendation,
    ...(product.recommendation ?? {}),
    sceneTags: [...(product.recommendation?.sceneTags ?? [])],
    intentTags: [...(product.recommendation?.intentTags ?? [])],
    tasteTags: [...(product.recommendation?.tasteTags ?? [])],
    dwellTags: [...(product.recommendation?.dwellTags ?? [])],
  }
}

export function normalizeMenuProductConfiguration(product: MenuProduct): MenuProduct {
  const productKind = product.productKind ?? 'single'
  return {
    ...product,
    productKind,
    beverageFamily: resolveMenuBeverageFamily(product),
    bundleComponents: productKind === 'bundle' ? [...(product.bundleComponents ?? [])] : [],
    substitutionProductIds: [...(product.substitutionProductIds ?? [])],
    recommendation: recommendationConfig(product),
  }
}

export function bundleComparisonAmount(product: MenuProduct, products: MenuProduct[]) {
  if ((product.productKind ?? 'single') !== 'bundle') return null
  const byId = new Map(products.map((item) => [item.id, item]))
  let total = 0
  for (const component of product.bundleComponents ?? []) {
    const componentProduct = byId.get(component.productId)
    if (!componentProduct) return null
    total += componentProduct.listPriceAmount * component.quantity
  }
  return Number.isSafeInteger(total) ? total : null
}

export function rankMenuRecommendations(
  products: MenuProduct[],
  context: MenuRecommendationContext,
  isEligible: (product: MenuProduct) => boolean = (product) => product.enabled && product.guestVisible !== false,
): RankedMenuProduct[] {
  const normalizedPartySize = Math.max(1, Math.min(100, Math.round(context.partySize || 1)))
  return products
    .filter(isEligible)
    .map(normalizeMenuProductConfiguration)
    .filter((product) => {
      const recommendation = recommendationConfig(product)
      return recommendation.enabled
        && hasPositiveRecommendationContribution(product)
        && recommendation.minimumPartySize <= normalizedPartySize
        && recommendation.maximumPartySize >= normalizedPartySize
    })
    .map((product) => scoreProduct(product, products, { ...context, partySize: normalizedPartySize }))
    .sort((left, right) => (
      right.score - left.score
      || (left.product.sortOrder ?? 999) - (right.product.sortOrder ?? 999)
      || left.product.name.localeCompare(right.product.name, 'zh-CN')
    ))
}

export function selectMenuRecommendationSlots(ranked: RankedMenuProduct[]): MenuRecommendationSlots {
  const primary = ranked[0] ?? null
  if (!primary) return { primary: null, lighter: null, complete: null }
  const primaryPrice = primary.product.listPriceAmount
  const lighter = ranked.find((item) => (
    item.product.id !== primary.product.id
    && item.product.listPriceAmount < primaryPrice
    && item.product.beverageFamily !== primary.product.beverageFamily
  )) ?? ranked.find((item) => item.product.id !== primary.product.id && item.product.listPriceAmount < primaryPrice) ?? null
  const configuredUpgradeId = recommendationConfig(primary.product).upgradeProductId
  const complete = ranked.find((item) => item.product.id === configuredUpgradeId)
    ?? null
  return { primary, lighter, complete }
}

export function selectMenuComparisonOptions(
  ranked: RankedMenuProduct[],
  slots: MenuRecommendationSlots = selectMenuRecommendationSlots(ranked),
  limit = 3,
): MenuComparisonOption[] {
  const bundleRanked = ranked.filter((item) => item.product.productKind === 'bundle')
  const comparisonPool = bundleRanked.length >= Math.min(3, limit) ? bundleRanked : ranked
  const uniqueRanked = comparisonPool.filter((item, index, items) => (
    items.findIndex((candidate) => candidate.product.id === item.product.id) === index
  ))
  if (uniqueRanked.length === 0 || limit <= 0) return []

  const selected: MenuComparisonOption[] = []
  const seen = new Set<string>()
  const primary = uniqueRanked.find((item) => item.product.id === slots.primary?.product.id)
    ?? uniqueRanked[0]!
  const add = (item: RankedMenuProduct | null, role: MenuComparisonRole) => {
    if (!item || seen.has(item.product.id) || selected.length >= limit) return
    seen.add(item.product.id)
    selected.push({ ...item, role })
  }

  const lowerPriced = uniqueRanked.filter((item) => (
    item.product.id !== primary.product.id
    && item.product.listPriceAmount < primary.product.listPriceAmount
  ))
  const lighter = lowerPriced.find((item) => (
    item.product.beverageFamily !== primary.product.beverageFamily
  )) ?? lowerPriced[0] ?? null
  const configuredUpgradeId = recommendationConfig(primary.product).upgradeProductId
  const configuredComplete = configuredUpgradeId
    ? uniqueRanked.find((item) => (
        item.product.id === configuredUpgradeId
        && item.product.listPriceAmount > primary.product.listPriceAmount
      )) ?? null
    : null

  add(lighter, 'lighter')
  add(primary, 'primary')
  add(configuredComplete, 'complete')

  const selectedFamilies = new Set(selected.map((item) => item.product.beverageFamily))
  const remaining = uniqueRanked.filter((item) => !seen.has(item.product.id))
  for (const item of remaining.filter((candidate) => !selectedFamilies.has(candidate.product.beverageFamily))) {
    add(item, 'alternative')
  }
  for (const item of remaining) add(item, 'alternative')
  return selected
}

export function resolveAiMenuRecommendationRanking(
  deterministicRanked: RankedMenuProduct[],
  aiRecommendation?: AiMenuRecommendation | null,
): ResolvedMenuRecommendationRanking {
  if (!aiRecommendation) {
    return { ranked: deterministicRanked, source: 'rules', fallbackReason: null }
  }
  const requiredChoices = Math.min(3, deterministicRanked.length)
  if (aiRecommendation.productIds.length < requiredChoices) {
    return { ranked: deterministicRanked, source: 'rules_fallback', fallbackReason: 'insufficient_choices' }
  }
  if (new Set(aiRecommendation.productIds).size !== aiRecommendation.productIds.length) {
    return { ranked: deterministicRanked, source: 'rules_fallback', fallbackReason: 'duplicate_product' }
  }
  const deterministicById = new Map(deterministicRanked.map((item) => [item.product.id, item]))
  if (aiRecommendation.productIds.some((productId) => !deterministicById.has(productId))) {
    return { ranked: deterministicRanked, source: 'rules_fallback', fallbackReason: 'unknown_product' }
  }
  const unsafeReason = Object.values(aiRecommendation.reasons ?? {}).some((reason) => (
    /(?:[¥￥]|\d+(?:\.\d+)?\s*(?:元|折)|免费|少付|省下|立减)/u.test(reason)
  ))
  if (unsafeReason) {
    return { ranked: deterministicRanked, source: 'rules_fallback', fallbackReason: 'unsafe_reason' }
  }

  const highestRuleScore = Math.max(0, ...deterministicRanked.map((item) => item.score))
  const aiRanked = aiRecommendation.productIds.map((productId, index) => {
    const deterministic = deterministicById.get(productId)!
    const reason = aiRecommendation.reasons?.[productId]?.trim()
    return {
      ...deterministic,
      score: highestRuleScore + (aiRecommendation.productIds.length - index) * 1_000,
      reason: reason || deterministic.reason,
    }
  })
  const selectedIds = new Set(aiRecommendation.productIds)
  return {
    ranked: [...aiRanked, ...deterministicRanked.filter((item) => !selectedIds.has(item.product.id))],
    source: 'ai',
    fallbackReason: null,
  }
}

export function pickShakeRecommendation(
  ranked: RankedMenuProduct[],
  excludedProductIds: ReadonlySet<string>,
  random: () => number = Math.random,
) {
  const source = ranked.slice(0, 8)
  const available = source.filter((item) => !excludedProductIds.has(item.product.id))
  const candidates = available.length > 0 ? available : source
  if (candidates.length === 0) return null
  const scoreFloor = Math.min(...candidates.map((item) => item.score))
  const weighted = candidates.map((item, index) => ({
    item,
    weight: Math.max(1, item.score - scoreFloor + 12 - index),
  }))
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0)
  let cursor = Math.max(0, Math.min(0.999999, random())) * totalWeight
  for (const candidate of weighted) {
    cursor -= candidate.weight
    if (cursor < 0) return candidate.item
  }
  return weighted.at(-1)?.item ?? null
}

function scoreProduct(product: MenuProduct, products: MenuProduct[], context: MenuRecommendationContext): RankedMenuProduct {
  const recommendation = recommendationConfig(product)
  let score = recommendation.priority
  const reasons: string[] = []

  if ((product.productKind ?? 'single') === 'bundle') {
    score += 55
    reasons.push('适合一次配齐')
  }
  if (recommendation.singleWaveEligible) score += 25
  if (recommendation.maximumPartySize - recommendation.minimumPartySize <= 3) score += 8
  if (recommendation.expectedPrepMinutes > 0 && recommendation.expectedPrepMinutes <= 8) score += 10
  if (recommendation.expectedPrepMinutes > 15) score -= Math.min(24, recommendation.expectedPrepMinutes - 15)

  const serverOrder = product.serverRecommendationOrder
  if (serverOrder !== undefined) score += Math.max(0, 24 - Math.min(24, Math.max(0, serverOrder)))
  else {
    const grossProfitAmount = product.listPriceAmount - product.costAmount
    const grossMarginRatio = product.listPriceAmount > 0 ? grossProfitAmount / product.listPriceAmount : 0
    if (grossProfitAmount > 0) score += Math.round(Math.max(0, Math.min(.75, grossMarginRatio)) * 24)
    else score -= 80
  }

  score += tagScore(context.scene, recommendation.sceneTags, 42)
  score += tagScore(context.intent, recommendation.intentTags, 52)
  score += tagScore(context.taste, recommendation.tasteTags, 36)
  score += tagScore(context.dwell, recommendation.dwellTags, 24)

  const partyCenter = (recommendation.minimumPartySize + recommendation.maximumPartySize) / 2
  score += Math.max(0, 18 - Math.abs(context.partySize - partyCenter) * 4)

  const comparisonAmount = bundleComparisonAmount(product, products)
  if (comparisonAmount !== null && comparisonAmount > product.listPriceAmount) {
    score += Math.min(28, Math.round((comparisonAmount - product.listPriceAmount) / 1_000))
    reasons.push(`比当前单点少付${formatAmount(comparisonAmount - product.listPriceAmount)}元`)
  }
  if (recommendation.reason) reasons.unshift(recommendation.reason)
  if (reasons.length === 0) reasons.push(defaultReason(product.beverageFamily ?? 'none'))

  return { product, score, reason: reasons.join(' · ') }
}

function hasPositiveRecommendationContribution(product: MenuProduct): boolean {
  return product.serverRecommendationOrder === undefined
    ? product.listPriceAmount > product.costAmount
    : product.recommendation?.enabled === true
}

function tagScore<T extends string>(selected: T | undefined, tags: readonly T[], weight: number) {
  if (!selected || tags.length === 0) return 0
  return tags.includes(selected) ? weight : 0
}

function defaultReason(family: MenuBeverageFamily) {
  const labels: Record<MenuBeverageFamily, string> = {
    none: '今晚供应稳定',
    cocktail: '现调好入口',
    beer: '轻松分享',
    wine: '慢慢喝更有层次',
    sparkling: '适合庆祝与仪式感',
    spirits: '酒感更完整',
    non_alcoholic: '轻松无负担',
  }
  return labels[family]
}

function formatAmount(amount: number) {
  return (amount / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}
