function checkoutRecommendationAttribution(checkoutUpgradeOfferPublicId, value) {
  if (String(checkoutUpgradeOfferPublicId || '').trim()) return null
  if (!value || !value.recommendationPublicId || !value.selectedProductId) return null
  return {
    recommendationPublicId: String(value.recommendationPublicId),
    selectedProductId: String(value.selectedProductId),
  }
}

module.exports = { checkoutRecommendationAttribution }
