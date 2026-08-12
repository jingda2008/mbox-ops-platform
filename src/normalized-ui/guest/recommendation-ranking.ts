import type { GuestMenuProduct } from './guest-model'

export type RecommendationIntent = 'easy' | 'party' | 'ritual' | 'explore'

export function rankRecommendations(
  products: readonly GuestMenuProduct[],
  intent: RecommendationIntent | null,
): GuestMenuProduct[] {
  const categoryPreference: Record<RecommendationIntent, readonly string[]> = {
    easy: ['cocktail', 'beer', 'non_alcoholic', 'combo'],
    party: ['spirits', 'beer', 'combo', 'cocktail'],
    ritual: ['sparkling', 'wine', 'combo', 'cocktail'],
    explore: ['combo', 'cocktail', 'wine', 'beer'],
  }
  return products.filter((product) => product.available).toSorted((left, right) => {
    const score = (product: GuestMenuProduct) => {
      const preference = intent === null ? [] : categoryPreference[intent]
      const categoryIndex = preference.indexOf(product.categoryCode)
      return product.recommendation.priority
        + (product.recommendation.featured ? 80 : 0)
        + (product.recommendation.partySizeMatched ? 30 : -40)
        + (intent !== null && product.recommendation.intents.includes(intent) ? 70 : 0)
        + (categoryIndex < 0 ? 0 : 30 - categoryIndex * 6)
        + (product.productKind === 'bundle' ? 12 : 0)
    }
    const difference = score(right) - score(left)
    return difference !== 0 ? difference : left.productId.localeCompare(right.productId)
  })
}
