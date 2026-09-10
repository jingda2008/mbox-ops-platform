const initialCheckoutUpgrade = { checkoutUpgrade: null, checkoutUpgradeLoading: false, checkoutUpgradeMessage: '', checkoutUpgradeNeedsRefresh: false, checkoutUpgradeChoicesOpen: false, checkoutUpgradeVariantIndex: 0, checkoutUpgradeVariantLabel: '请选择具体菜品' }
function checkoutUpgradeMethods({ prepare, decide, randomId, scope, money }) {
  const matches = (page, identity, generation, version) => identity === scope()
    && page.data.cartGeneration === generation && page.data.cartVersion === version
  return {
    async checkoutUpgradeReady() {
      if (!this.data.checkoutUpgradeNeedsRefresh) return true
      const request = this.currentTableRequest()
      if (!request || !this.isCurrentTableRequest(request)) return false
      const refreshed = await this.refreshSharedCart(true, request)
      if (this.isCurrentTableRequest(request)) this.setData({ checkoutUpgradeNeedsRefresh: !refreshed,
        checkoutUpgradeMessage: refreshed ? '已刷新实际购物车，请核对后再次确认支付。' : '购物车尚未同步，请稍后重新核对；不会按旧草稿付款。' })
      return false
    },
    invalidateCheckoutUpgrade() {
      this.checkoutUpgradeEpoch = (this.checkoutUpgradeEpoch || 0) + 1
      this.setData({ checkoutUpgrade: null, checkoutUpgradeLoading: false, checkoutUpgradeMessage: '', checkoutUpgradeChoicesOpen: false, checkoutUpgradeVariantIndex: 0, checkoutUpgradeVariantLabel: '请选择具体菜品' })
    },
    async loadCheckoutUpgrade() {
      if (this.data.busy || !this.data.checkoutConfirmVisible || !this.data.cart.length) return
      const identity = scope(), generation = this.data.cartGeneration, version = this.data.cartVersion
      const key = identity + ':' + generation
      if (this.checkoutUpgradeAttempted === key) return
      this.checkoutUpgradeAttempted = key
      const epoch = this.checkoutUpgradeEpoch = (this.checkoutUpgradeEpoch || 0) + 1
      this.setData({ checkoutUpgradeLoading: true, checkoutUpgradeMessage: '' })
      try {
        const result = await prepare({ expectedGeneration: generation, expectedVersion: version,
          selections: this.data.couponSelections.map(selection => ({ ...selection })) }, randomId('upgrade-opportunity'))
        if (epoch !== this.checkoutUpgradeEpoch || !matches(this, identity, generation, version)
          || !this.data.checkoutConfirmVisible || this.data.busy || !result) return
        if (result.status !== 'offered' || result.generation !== generation || result.version !== version
          || result.currency !== 'CNY' || !Number.isSafeInteger(result.originalPayableMinor)
          || !Number.isSafeInteger(result.upgradedPayableMinor) || result.upgradedPayableMinor <= result.originalPayableMinor
          || !(Date.parse(result.expiresAt) > Date.now())) return
        const source = this.data.cart.find(line => (line.portionIds || []).includes(result.sourcePortionId))
        const sourceIndex = source ? source.portionIds.indexOf(result.sourcePortionId) : -1
        const selectedUnit = source && source.selectionUnits && source.selectionUnits[sourceIndex]
        const sourceLabel = (result.sourceName || (source && source.name) || '当前商品') + (sourceIndex >= 0 ? ' · 第' + (sourceIndex + 1) + '份' : '')
          + (selectedUnit && selectedUnit.label ? ' · ' + selectedUnit.label : '')
        this.setData({ checkoutUpgrade: { ...result, sourceLabel, variants: result.variants || [], variantLabels: ['请选择具体菜品'].concat((result.variants || []).map(variant => variant.label)), addedText: money(result.upgradedPayableMinor - result.originalPayableMinor),
          totalText: money(result.upgradedPayableMinor) } })
      } catch (_) {
        // Optional promotion failure never starts or locks a payment attempt.
      } finally {
        if (epoch === this.checkoutUpgradeEpoch) this.setData({ checkoutUpgradeLoading: false })
      }
    },
    declineCheckoutUpgrade() {
      if (this.data.busy) return
      const offer = this.data.checkoutUpgrade
      this.invalidateCheckoutUpgrade()
      if (offer) decide(offer.id, 'decline').catch(() => {})
    },
    chooseCheckoutUpgradeVariant(event) {
      if (this.data.busy || !this.data.checkoutUpgrade) return
      const index = Number(event.detail.value), offer = this.data.checkoutUpgrade
      if (!Number.isSafeInteger(index) || index < 0 || index > offer.variants.length) return
      this.setData({ checkoutUpgradeVariantIndex: index, checkoutUpgradeVariantLabel: offer.variantLabels[index] })
    },
    async acceptCheckoutUpgrade() {
      const offer = this.data.checkoutUpgrade
      if (!offer || this.data.busy || this.data.cartSyncing) return
      if (offer.variants.length && !this.data.checkoutUpgradeChoicesOpen) {
        this.setData({ checkoutUpgradeChoicesOpen: true })
        return
      }
      const variant = offer.variants[this.data.checkoutUpgradeVariantIndex - 1]
      if (offer.variants.length && !variant) {
        this.setData({ checkoutUpgradeMessage: '请先选择具体菜品；也可保留原单直接支付。' })
        return
      }
      const identity = scope(), request = this.currentTableRequest()
      if (!request || !this.isCurrentTableRequest(request)) return
      if (!(Date.parse(offer.expiresAt) > Date.now())) {
        this.invalidateCheckoutUpgrade()
        this.setData({ checkoutUpgradeMessage: '建议已过期，原购物车仍可提交。' })
        return
      }
      const selections = this.data.couponSelections.map(selection => ({ ...selection }))
      this.setData({ busy: true, checkoutUpgradeMessage: '', checkoutUpgradeNeedsRefresh: true })
      let accepted = null
      try {
        const result = await decide(offer.id, 'accept', variant && variant.id)
        if (identity !== scope() || !this.isCurrentTableRequest(request)) return
        if (!result || !result.opportunity || result.opportunity.status !== 'accepted') throw new Error('upgrade not confirmed')
        accepted = result.opportunity
        if (!await this.refreshSharedCart(true, request)) throw new Error('cart refresh unavailable')
        if (identity !== scope() || !this.isCurrentTableRequest(request)) return
        this.invalidateCheckoutUpgrade()
        this.setData({ checkoutUpgradeNeedsRefresh: false, checkoutUpgradeMessage: '套餐已变更，请核对具体菜品与金额后再确认支付。',
          couponSelections: selections.map(selection => ({ ...selection,
            portionId: selection.portionId === offer.sourcePortionId ? accepted.replacementPortionId : selection.portionId })),
          couponNeedsReview: selections.length > 0 })
      } catch (_) {
        if (identity !== scope() || !this.isCurrentTableRequest(request)) return
        const refreshed = await this.refreshSharedCart(true, request)
        if (identity === scope() && this.isCurrentTableRequest(request)) this.setData({
          checkoutUpgradeNeedsRefresh: !refreshed, checkoutUpgradeMessage: '升级结果需重新核对。请刷新购物车查看实际菜品和金额；尚未发起付款。' })
      } finally {
        if (identity === scope() && this.isCurrentTableRequest(request)) this.setData({ busy: false })
      }
      if (accepted && selections.length && identity === scope() && this.isCurrentTableRequest(request)) await this.quoteCheckoutCoupons()
    },
  }
}
export { initialCheckoutUpgrade, checkoutUpgradeMethods }
