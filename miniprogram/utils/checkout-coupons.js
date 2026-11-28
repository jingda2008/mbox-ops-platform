const { parseInstant } = require('./format')
const initialCheckoutCoupons = {
  ticketPreview: null, ticketChoice: '', ticketPreviewLoading:false, ticketPreviewError:false, savedDirect:null,
  pointsPickerOpen: false, pointsLoading: false, pointsError: '', pointsBalance: null, earnMinorPerPoint: null, maximumPoints: null, pointsInput: '',
  couponAvailability: 'checking', hasTableOffer:false, couponPickerOpen: false, couponLoading: false, couponError: '', couponItems: [],
  couponNextCursor: null, couponPortions: [], couponSelections: [], couponQuote: null,
  couponQuoteTotal: '', couponNeedsReview: false, couponEntryOpen: false, couponProducts: [], issuedCouponPending: null,
}
function matchesCheckoutLine(coupon, line) {
  return coupon.state === 'available' && coupon.quantityAvailable > 0
    && (line.available !== false || line.couponReviewAvailable)
    && coupon.pricePromise?.products.some(product => product.id === line.productId)
}
function couponPortions(cart, coupons, selections, money) {
  return cart.flatMap(line => (line.portionIds || []).map((portionId, index) => {
    const usable = coupons.filter(coupon => matchesCheckoutLine(coupon, line))
    const options = [{ benefitId: null, label: '不用券' }].concat(usable.map(coupon => ({
      benefitId: coupon.id, label: (coupon.display && (coupon.display.title || coupon.display.name) || '低价兑换券')
        + ' · ' + money(coupon.pricePromise.fixedPriceMinor) + '/份',
    })))
    const selected = selections.find(selection => selection.portionId === portionId)
    if (selected && selected.benefitId && !options.some(option => option.benefitId === selected.benefitId)) {
      options.push({ benefitId: selected.benefitId, label: '已选优惠券（请重新确认）' })
    }
    const selectedIndex = Math.max(0, options.findIndex(option => option.benefitId === (selected && selected.benefitId)))
    return { portionId, label: line.name + ' · 第' + (index + 1) + '份', options,
      optionLabels: options.map(option => option.label), selectedIndex, selectedLabel: options[selectedIndex].label }
  }))
}
function checkoutCouponMethods({ getWallet, checkAvailability, quote, getPoints, quotePoints, quoteChannel, money, randomId, scope, errorMessage }) {
  return {
    async readCheckoutCouponAvailability() {
      const request = this.couponAvailabilityRequest = {}
      this.eligibleWalletPage = null
      const {cart, cartVersion, cartGeneration} = this.data
      const identity = scope()
      const current = () => this.couponAvailabilityRequest === request && this.data.checkoutConfirmVisible
        && scope() === identity && this.data.cartVersion === cartVersion && this.data.cartGeneration === cartGeneration
      this.setData({couponAvailability:'checking',hasTableOffer:false})
      if (!cart.length) { this.setData({couponAvailability:'none'}); return }
      try {
        const seen = new Set()
        let cursor, checkedTable = false
        do {
          const page = await getWallet(cursor)
          if (!current()) return
          if (!Array.isArray(page?.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw Error()
          const candidates = []
          for (const coupon of page.items) {
            for (const line of cart) {
              if (matchesCheckoutLine(coupon,line)) {
                for (const portionId of line.portionIds || []) candidates.push({benefitId:coupon.id,portionId})
              }
            }
          }
          for (let i=0; i<candidates.length; i+=8) {
            const eligibility = await checkAvailability({expectedGeneration:cartGeneration,expectedVersion:cartVersion,candidates:candidates.slice(i,i+8)})
            if (!current()) return
            if (typeof eligibility?.available !== 'boolean') throw Error()
            checkedTable = true
            this.setData({hasTableOffer:eligibility.tableOffer === true})
            if (eligibility.available) {
              this.eligibleWalletPage = {page, identity, cartVersion, cartGeneration}
              this.setData({couponAvailability:'available'})
              return
            }
          }
          cursor = page.nextCursor
          if (cursor && seen.has(cursor)) throw Error()
          seen.add(cursor)
        } while (cursor)
        this.setData({couponAvailability:'none'})
        if (!checkedTable) {
          const result = await checkAvailability({expectedGeneration:cartGeneration,expectedVersion:cartVersion,candidates:[]})
          if (!current()) return
          this.setData({hasTableOffer:result.tableOffer === true})
        }
      } catch {
        if (current()) this.setData({couponAvailability:'error'})
      }
    },
    async readTicketCheckout() {
      const request = this.ticketPreviewRequest = {}
      if (this.data.prepayment || this.data.membershipStatus === 'nonmember' || this.data.couponReviewRequired || this.data.issuedCouponPending) {
        this.setData({ticketPreview:null,ticketChoice:'',savedDirect:null,ticketPreviewError:false,ticketPreviewLoading:false})
        return
      }
      const generation = this.data.cartGeneration, version = this.data.cartVersion, identity = scope()
      const current = () => request === this.ticketPreviewRequest && this.data.checkoutConfirmVisible && scope() === identity
        && this.data.cartVersion === version && this.data.cartGeneration === generation
      this.setData({ticketPreviewLoading:true,ticketPreviewError:false})
      try {
        const result = await getPoints({generation,version,checkoutView:true})
        if (!current()) return
        if (!result.ticketCheckout) {
          if (this.data.ticketChoice === 'points') this.invalidateCheckoutCoupons(false,true)
          this.setData({ticketPreview:null,ticketChoice:'',savedDirect:null})
          return
        }
        const {availablePoints,maximumPoints,standardMinor} = result
        if (!Number.isSafeInteger(availablePoints) || !Number.isSafeInteger(standardMinor) || standardMinor < 0 ||
            result.minorPerPoint !== 100 || result.allowCoupons !== false || !Number.isSafeInteger(maximumPoints) ||
            maximumPoints < 0 || maximumPoints !== Math.min(availablePoints,Math.floor(standardMinor/100))) throw Error('积分暂未读到')
        const remaining = standardMinor-maximumPoints*100
        if (this.data.pointsInput && Number(this.data.pointsInput) > maximumPoints) {
          this.invalidateCheckoutCoupons(false,true)
          this.setData({couponError:'可用积分变了，请重新选择结账方式。'})
        }
        this.setData({ticketPreview:{availablePoints,maximumPoints,remainder:remaining ? '微信补 '+money(remaining) : '全额抵扣'},
          ticketChoice:this.data.pointsInput ? 'points' : this.data.ticketChoice || (maximumPoints === 0 ? 'direct' : '')})
      } catch (_) {
        if (current()) this.setData({ticketPreview:null,ticketChoice:'',savedDirect:null,ticketPreviewError:true})
      } finally {
        if (current()) this.setData({ticketPreviewLoading:false})
      }
    },
    async useTicketPoints() {
      const preview = this.data.ticketPreview
      if (!preview || !preview.maximumPoints || this.data.busy || this.data.pointsLoading || this.data.couponLoading) return
      if (this.data.ticketChoice === 'points' && this.data.couponQuote?.pointsUsed && parseInstant(this.data.couponQuote.expiresAt) > Date.now()) return
      if (this.data.ticketChoice !== 'points') this.setData({savedDirect:{quote:this.data.couponQuote, total:this.data.couponQuoteTotal,
        selections:this.data.couponSelections, review:this.data.couponNeedsReview}})
      this.setData({ticketChoice:'points',pointsPickerOpen:false,couponPickerOpen:false,pointsBalance:preview.availablePoints,maximumPoints:preview.maximumPoints})
      this.onCheckoutPointsInput({detail:{value:String(preview.maximumPoints)}})
      return this.quoteCheckoutPoints()
    },
    useDirectCheckout() {
      if (this.data.busy || this.data.pointsLoading || this.data.couponLoading) return
      const saved = this.data.savedDirect
      if (this.data.ticketChoice === 'points') {
        const expired = saved && saved.quote && !(parseInstant(saved.quote.expiresAt) > Date.now())
        this.setData({couponQuote:saved && !expired ? saved.quote : null,couponQuoteTotal:saved && !expired ? saved.total : '',
          couponSelections:saved ? saved.selections : [],couponNeedsReview:!!(saved && (saved.review || expired)),
          couponError:expired ? '优惠已变化，请重新选择。' : '',pointsPickerOpen:false,pointsInput:'',pointsError:''})
      }
      if (!saved && !this.data.couponSelections.length && !this.data.couponReviewRequired && !this.data.issuedCouponPending && !this.data.couponQuote) {
        this.setData({couponNeedsReview:false,couponError:''})
      }
      this.setData({ticketChoice:'direct',savedDirect:null})
    },
    async quoteCheckoutChannel() {
      if (this.data.busy || this.data.couponLoading || !quoteChannel) return
      this.invalidateCheckoutCoupons(false, false)
      const epoch = this.checkoutCouponEpoch, identity = scope()
      const input = { expectedGeneration: this.data.cartGeneration, expectedVersion: this.data.cartVersion,
        lineNotes: Object.entries(this.checkoutLineNotes || {}).filter(([, note]) => note.trim()).map(([portionId, note]) => ({ portionId, note: note.trim() })) }
      this.setData({ couponLoading: true, couponError: '', couponNeedsReview: true })
      try {
        const result = await quoteChannel(input)
        if (epoch !== this.checkoutCouponEpoch || identity !== scope() || !this.data.checkoutConfirmVisible || this.data.busy) return
        if (!result.current || result.sourceType !== 'channel_quote' || result.generation !== this.data.cartGeneration || result.version !== this.data.cartVersion || result.currency !== 'CNY' || !Number.isSafeInteger(result.subtotalMinor) || result.subtotalMinor < 0 || !Number.isSafeInteger(result.discountMinor) || result.discountMinor < 0 || !Number.isSafeInteger(result.payableMinor) || result.payableMinor < 0 || result.subtotalMinor - result.discountMinor !== result.payableMinor || !(parseInstant(result.expiresAt) > Date.now())) throw new Error('本桌优惠已变化，请重新选择。')
        this.setData({ couponQuote: result, couponQuoteTotal: money(result.payableMinor), couponNeedsReview: false, couponPickerOpen: false })
      } catch (error) { if (epoch === this.checkoutCouponEpoch && identity === scope()) this.setData({ couponError: /渠道|报价/.test(error?.message || '') ? '这单暂时用不了本桌优惠，可以选择其他优惠券。' : errorMessage(error, '暂时查不到本桌优惠，请稍后再试。') }) }
      finally { if (epoch === this.checkoutCouponEpoch && identity === scope()) this.setData({ couponLoading: false }) }
    },
    async openCheckoutPoints() {
      if (this.data.busy || this.data.couponLoading) return
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      const epoch = this.checkoutCouponEpoch, identity = scope()
      this.setData({ pointsPickerOpen: true, couponPickerOpen: false, pointsLoading: true, pointsError: '', pointsBalance: null, earnMinorPerPoint: null, maximumPoints: null })
      try {
        const response = await getPoints({ generation: this.data.cartGeneration, version: this.data.cartVersion }), result = response.data || response
        if (epoch !== this.checkoutCouponEpoch || identity !== scope() || !this.data.checkoutConfirmVisible || this.data.busy) return
        if (!Number.isSafeInteger(result.availablePoints) || result.availablePoints < 0 || result.minorPerPoint !== 100 || result.allowCoupons !== false) throw new Error('积分规则暂不可用')
        this.setData({ pointsBalance: result.availablePoints, earnMinorPerPoint: Number.isSafeInteger(result.earnMinorPerPoint) && result.earnMinorPerPoint > 0 ? result.earnMinorPerPoint : null, maximumPoints: Number.isSafeInteger(result.maximumPoints) && result.maximumPoints >= 0 && result.maximumPoints <= result.availablePoints ? result.maximumPoints : null })
      } catch (error) {
        if (epoch === this.checkoutCouponEpoch) this.setData({ pointsError: errorMessage(error, '积分读取失败，请重试或不使用积分。') })
      } finally { if (epoch === this.checkoutCouponEpoch) this.setData({ pointsLoading: false }) }
    },
    closeCheckoutPoints() {
      if (this.data.busy) return
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      this.setData({ pointsPickerOpen: false, pointsLoading: false })
    },
    onCheckoutPointsInput(event) {
      if (this.data.busy || this.data.pointsLoading) return
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      this.setData({ pointsInput: String(event.detail.value || ''), pointsError: '', couponSelections: [], couponQuote: null, couponQuoteTotal: '' })
    },
    fillMaximumCheckoutPoints() {
      if (this.data.maximumPoints > 0) this.onCheckoutPointsInput({ detail: { value: String(this.data.maximumPoints) } })
    },
    async quoteCheckoutPoints() {
      if (this.data.busy || this.data.pointsLoading) return
      if (!/^[1-9][0-9]*$/.test(this.data.pointsInput) || !Number.isSafeInteger(Number(this.data.pointsInput)) || Number(this.data.pointsInput) > (this.data.maximumPoints ?? this.data.pointsBalance)) {
        const limit = this.data.maximumPoints ?? this.data.pointsBalance
        this.setData({ pointsError: limit > 0 ? '请输入 1 到 ' + limit + ' 之间的整数。' : '本单暂无可用积分。' }); return
      }
      const epoch = this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1, identity = scope()
      const input = { expectedGeneration: this.data.cartGeneration, expectedVersion: this.data.cartVersion, points: Number(this.data.pointsInput) }
      this.setData({ pointsLoading: true, pointsError: '', couponQuote: null, couponQuoteTotal: '' })
      try {
        const response = await quotePoints(input, randomId('points-quote')), result = response.data || response
        if (epoch !== this.checkoutCouponEpoch || identity !== scope() || !this.data.checkoutConfirmVisible || this.data.busy || input.expectedGeneration !== this.data.cartGeneration || input.expectedVersion !== this.data.cartVersion) return
        if (!result.current || result.generation !== input.expectedGeneration || result.version !== input.expectedVersion || result.currency !== 'CNY' || result.pointsUsed !== input.points || result.discountMinor !== input.points * 100 || !Number.isSafeInteger(result.subtotalMinor) || !Number.isSafeInteger(result.payableMinor) || result.payableMinor < 0 || result.subtotalMinor - result.discountMinor !== result.payableMinor || !(parseInstant(result.expiresAt) > Date.now())) throw new Error('积分已变化，请重新选择。')
        this.setData({ couponQuote: result, couponQuoteTotal: money(result.payableMinor), couponNeedsReview: false })
        return result
      } catch (error) {
        if (epoch === this.checkoutCouponEpoch) this.setData({ pointsError: errorMessage(error, '暂时算不出抵扣金额，请再试一次。') })
      } finally { if (epoch === this.checkoutCouponEpoch) this.setData({ pointsLoading: false }) }
    },
    invalidateCheckoutCoupons(clearWallet, needsReview) {
      if (clearWallet) {
        this.ticketPreviewRequest=null
        this.setData({ticketPreview:null,ticketChoice:'',savedDirect:null,ticketPreviewLoading:false,ticketPreviewError:false})
      } else this.setData({ticketChoice:'',savedDirect:null})
      if (this.invalidateCheckoutUpgrade) this.invalidateCheckoutUpgrade()
      this.checkoutCouponEpoch = (this.checkoutCouponEpoch || 0) + 1
      this.setData({ pointsPickerOpen: false, pointsLoading: false, pointsInput: '', pointsError: '', pointsBalance: null, maximumPoints: null, couponQuote: null, couponQuoteTotal: '', couponSelections: [], couponPortions: [],
        couponLoading: false, couponNeedsReview: !!needsReview, couponError: needsReview ? '订单有变化，请重新选择优惠。' : '',
        ...(clearWallet ? { couponItems: [], couponProducts: [], couponNextCursor: null, couponPickerOpen: false, couponEntryOpen: false } : {}) })
    },
    async openCheckoutCoupons() {
      if (this.data.busy) return
      if (this.checkoutCouponScope !== scope()) {
        const entry = this.data.couponEntryOpen
        this.invalidateCheckoutCoupons(true, false)
        if (entry) this.setData({ couponEntryOpen: true })
        this.checkoutCouponScope = scope()
      }
      if (this.data.pointsPickerOpen && this.data.pointsInput) this.invalidateCheckoutCoupons(false, false)
      else if (this.data.pointsPickerOpen) this.closeCheckoutPoints()
      const cached = this.eligibleWalletPage
      this.setData({ couponPickerOpen: true })
      if (!this.data.couponEntryOpen && cached && cached.identity === scope() && cached.cartVersion === this.data.cartVersion && cached.cartGeneration === this.data.cartGeneration) {
        this.setData({couponItems:cached.page.items, couponNextCursor:cached.page.nextCursor,
          couponPortions:couponPortions(this.data.cart,cached.page.items,this.data.couponSelections,money)})
        return
      }
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
          couponProducts: items.filter(item => item.state === 'available' && item.quantityAvailable > 0 && item.pricePromise)
            .flatMap(item => item.pricePromise.products.map(product => ({ ...product, benefitId: item.id,
              key: item.id + ':' + product.id, couponTitle: item.display && (item.display.title || item.display.name) || '兑换券',
              priceText: money(item.pricePromise.fixedPriceMinor) + '/份' }))),
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
          || !(parseInstant(result.expiresAt) > Date.now())) throw new Error('优惠已变化，请重新选择。')
        this.setData({ couponQuote: result, couponQuoteTotal: money(result.payableMinor), couponNeedsReview: false, couponPickerOpen: false })
      } catch (error) {
        if (epoch === this.checkoutCouponEpoch) this.setData({ couponError: errorMessage(error, '优惠不适用于本次组合，请重新选择或不用券。') })
      } finally { if (epoch === this.checkoutCouponEpoch) this.setData({ couponLoading: false }) }
    },
    skipCheckoutCoupons() {
      if (this.data.busy) return
      this.invalidateCheckoutCoupons(false, false)
      const unavailable = this.data.cart.some(line => line.available === false)
      this.setData({ couponPickerOpen: unavailable, ...(unavailable ? { couponError: '不用券时请先移除暂不可售商品，不会改按原价提交。' } : {}) })
    },
    couponCheckoutReady() {
      const quote = this.data.couponQuote
      if (quote && (!quote.current || quote.generation !== this.data.cartGeneration || quote.version !== this.data.cartVersion || !(parseInstant(quote.expiresAt) > Date.now()))) {
        this.setData({ couponQuote: null, couponQuoteTotal: '', couponNeedsReview: true,
          couponError: '优惠已变化，请重新选择。' })
        return false
      }
      const unavailable = this.data.cart.filter(line => line.available === false)
      if (this.data.issuedCouponPending || (unavailable.length && (!quote || !quote.current || quote.pointsUsed > 0
        || quote.generation !== this.data.cartGeneration || quote.version !== this.data.cartVersion
        || !(parseInstant(quote.expiresAt) > Date.now()) || unavailable.some(line => !line.couponReviewAvailable
          || (line.portionIds || []).length !== line.quantity || line.portionIds.some(portionId => !(quote.lines || []).some(part =>
            part.portionId === portionId && part.productId === line.productId && part.benefitId
            && this.data.couponSelections.some(selection => selection.portionId === portionId && selection.benefitId === part.benefitId))))))) {
        this.setData({ couponError: this.data.issuedCouponPending ? '请先查看商品添加结果。' : '部分商品仅限用券兑换，请选券或移除商品。' })
        return false
      }
      if (this.data.couponNeedsReview || ((this.data.couponSelections.length || this.data.pointsInput || quote && quote.sourceType === 'channel_quote') && (!quote || quote.generation !== this.data.cartGeneration
        || quote.version !== this.data.cartVersion || !(parseInstant(quote.expiresAt) > Date.now())))) {
        this.setData({ couponError: '请重新选券，或选择不用优惠券。' })
        return false
      }
      return true
    },
  }
}
module.exports = { initialCheckoutCoupons, couponPortions, checkoutCouponMethods }
