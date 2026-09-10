const initialCheckoutCoupons = {
  couponPickerOpen: false, couponLoading: false, couponError: '', couponItems: [],
  couponNextCursor: null, couponPortions: [], couponSelections: [], couponQuote: null,
  couponQuoteTotal: '', couponNeedsReview: false,
}
function couponPortions(cart, coupons, selections, money) {
  return cart.flatMap(line => (line.portionIds || []).map((portionId, index) => {
    const usable = coupons.filter(coupon => coupon.state === 'available' && coupon.quantityAvailable > 0
      && coupon.pricePromise && coupon.pricePromise.products.some(product => product.id === line.productId))
    const options = [{ benefitId: null, label: '不用券' }].concat(usable.map(coupon => ({
      benefitId: coupon.id, label: (coupon.display && (coupon.display.title || coupon.display.name) || '低价兑换券')
        + ' · ' + money(coupon.pricePromise.fixedPriceMinor) + '/份',
    })))
    const selected = selections.find(selection => selection.portionId === portionId)
    const selectedIndex = Math.max(0, options.findIndex(option => option.benefitId === (selected && selected.benefitId)))
    return { portionId, label: line.name + ' · 第' + (index + 1) + '份', options,
      optionLabels: options.map(option => option.label), selectedIndex, selectedLabel: options[selectedIndex].label }
  }))
}
function checkoutCouponMethods({ getWallet, quote, money, randomId, scope, errorMessage }) {
  return {
    invalidateCheckoutCoupons(clearWallet, needsReview) {
      if (this.invalidateCheckoutUpgrade) this.invalidateCheckoutUpgrade()
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      this.setData({ couponQuote: null, couponQuoteTotal: '', couponSelections: [], couponPortions: [],
        couponLoading: false, couponNeedsReview: !!needsReview, couponError: needsReview ? '购物车或会话已变化，请重新选券，或明确选择不用券。' : '',
        ...(clearWallet ? { couponItems: [], couponNextCursor: null, couponPickerOpen: false } : {}) })
    },
    async openCheckoutCoupons() {
      if (this.data.busy) return
      if (this.checkoutCouponScope !== scope()) {
        this.invalidateCheckoutCoupons(true, false)
        this.checkoutCouponScope = scope()
      }
      this.setData({ couponPickerOpen: true })
      await this.loadCheckoutCoupons(false)
    },
    async loadCheckoutCoupons(more) {
      if (this.data.couponLoading || this.data.busy || !this.data.checkoutConfirmVisible) return
      if (more === true && !this.data.couponNextCursor) return
      const epoch = this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1, identity = scope()
      this.setData({ couponLoading: true, couponError: '' })
      try {
        const result = await getWallet(more === true ? this.data.couponNextCursor : undefined)
        if (epoch !== this.checkoutCouponEpoch || identity !== scope() || !this.data.checkoutConfirmVisible || this.data.busy) return
        const items = more === true ? [...new Map([...this.data.couponItems, ...result.items].map(item => [item.id, item])).values()] : result.items
        this.setData({ couponItems: items, couponNextCursor: result.nextCursor,
          couponPortions: couponPortions(this.data.cart, items, this.data.couponSelections, money) })
      } catch (error) {
        if (epoch === this.checkoutCouponEpoch) this.setData({ couponError: errorMessage(error, '优惠券读取失败，可重试或不用券继续。') })
      } finally { if (epoch === this.checkoutCouponEpoch) this.setData({ couponLoading: false }) }
    },
    loadMoreCheckoutCoupons() { return this.loadCheckoutCoupons(true) },
    chooseCheckoutCoupon(event) {
      if (this.data.busy || this.data.couponLoading) return
      const portion = this.data.couponPortions.find(item => item.portionId === event.currentTarget.dataset.portion)
      const option = portion && portion.options[Number(event.detail.value)]
      if (!option) return
      if (this.invalidateCheckoutUpgrade) this.invalidateCheckoutUpgrade()
      const selections = this.data.couponSelections.filter(item => item.portionId !== portion.portionId)
      if (option.benefitId) selections.push({ portionId: portion.portionId, benefitId: option.benefitId })
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      this.setData({ couponSelections: selections, couponQuote: null, couponQuoteTotal: '', couponNeedsReview: false,
        couponError: '', couponPortions: couponPortions(this.data.cart, this.data.couponItems, selections, money) })
    },
    async quoteCheckoutCoupons() {
      if (this.data.busy || this.data.couponLoading || !this.data.couponSelections.length) return
      const epoch = this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1, identity = scope()
      const input = { expectedGeneration: this.data.cartGeneration, expectedVersion: this.data.cartVersion,
        selections: this.data.couponSelections.map(selection => ({ ...selection })) }
      this.setData({ couponLoading: true, couponQuote: null, couponQuoteTotal: '', couponError: '' })
      try {
        const response = await quote(input, randomId('coupon-quote')), result = response.data || response
        if (epoch !== this.checkoutCouponEpoch || identity !== scope() || !this.data.checkoutConfirmVisible || this.data.busy
          || input.expectedGeneration !== this.data.cartGeneration || input.expectedVersion !== this.data.cartVersion) return
        if (!result.current || result.generation !== input.expectedGeneration || result.version !== input.expectedVersion
          || result.currency !== 'CNY' || !Number.isSafeInteger(result.subtotalMinor) || !Number.isSafeInteger(result.discountMinor)
          || result.discountMinor < 0 || result.subtotalMinor - result.discountMinor !== result.payableMinor
          || !Number.isSafeInteger(result.payableMinor) || result.payableMinor < 0
          || !(Date.parse(result.expiresAt) > Date.now())) throw new Error('优惠报价已失效，请重新确认')
        this.setData({ couponQuote: result, couponQuoteTotal: money(result.payableMinor), couponNeedsReview: false })
      } catch (error) {
        if (epoch === this.checkoutCouponEpoch) this.setData({ couponError: errorMessage(error, '优惠不适用于本次组合，请重新选择或不用券。') })
      } finally { if (epoch === this.checkoutCouponEpoch) this.setData({ couponLoading: false }) }
    },
    skipCheckoutCoupons() {
      if (this.data.busy) return
      this.invalidateCheckoutCoupons(false, false)
      this.setData({ couponPickerOpen: false })
    },
    couponCheckoutReady() {
      const quote = this.data.couponQuote
      if (this.data.couponNeedsReview || (this.data.couponSelections.length && (!quote || quote.generation !== this.data.cartGeneration
        || quote.version !== this.data.cartVersion || !(Date.parse(quote.expiresAt) > Date.now())))) {
        this.setData({ couponError: '请先确认有效优惠报价，或选择不用券按原价提交。' })
        return false
      }
      return true
    },
  }
}
module.exports = { initialCheckoutCoupons, couponPortions, checkoutCouponMethods }
