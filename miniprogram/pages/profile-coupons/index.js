const { beginMemberPage } = require('../../utils/member-pagination')
const { getCustomerBenefitWallet, getChannelWalletPage } = require('../../utils/api')
const { money, beijingDateTime, parseInstant } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const { channelCode } = require('../../utils/channel-entry')
const BENEFIT_NAMES = { gift_product: '赠送好礼', discount: '折扣券', credit: '金额券', amount_coupon: '金额券', access: '专属资格', other: '优惠券' }
const STATES = { available: '可使用', upcoming: '未到使用时间', reserved: '使用处理中', redeemed: '已使用', expired: '已过期', revoked: '已撤销', unavailable: '暂不可用', outside_window: '非可用时段' }
function storeTime(value) { return beijingDateTime(value, '') }
function present(item) {
  const display = item.display || {}
  const from = storeTime(item.validFrom)
  const until = storeTime(item.validUntil)
  const calendar = item.calendar
  const pricePromise = item.pricePromise
  const limits = calendar && calendar.limits
  const limitText = limits ? [['perCustomerDay', '每日'], ['perCustomerWeek', '每周'], ['perCustomerCampaign', '本活动']]
    .filter(([key]) => limits[key] != null).map(([key, label]) => label + '最多' + limits[key] + '次').join(' · ') : ''
  return {
    validityBoundaries: ['available','upcoming','outside_window'].includes(item.state) ? [item.validFrom,item.validUntil,calendar && calendar.nextAvailableAt].filter(value => typeof value === 'string') : [],
    canUsePriceCoupon: !!pricePromise && item.state === 'available' && item.quantityAvailable > 0,
    id: item.id, typeText: pricePromise ? '固定低价兑换券' : BENEFIT_NAMES[item.type] || '优惠券',
    stateText: STATES[item.state] || STATES.unavailable,
    quantityText: '剩余 ' + item.quantityAvailable + ' · 处理中 ' + item.quantityReserved + ' · 已用 ' + item.quantityRedeemed,
    calendarText: calendar ? calendar.summary : '',
    calendarNextText: calendar ? (calendar.nextAvailableAt ? '可用时间：' + storeTime(calendar.nextAvailableAt) : '已无后续可用时段') : '',
    calendarLimitText: limitText ? limitText + '（同活动多张券合计，含处理中次数）' : '',
    title: display.title || display.name || BENEFIT_NAMES[item.type] || '门店优惠',
    description: pricePromise ? '每份按 ' + money(pricePromise.fixedPriceMinor) + ' 兑换，不是减免金额。适用：' + pricePromise.products.map(product => product.name).join('、') + '。需在订单确认时选择，叠加以报价结果为准。' : display.description || display.summary || '使用方式及限制以权益说明为准。',
    valueText: pricePromise ? money(pricePromise.fixedPriceMinor) + '/份' : item.type === 'credit' && item.valueAmountMinor > 0 ? money(item.valueAmountMinor) : '',
    validText: from ? from + ' 起' + (item.validUntil === null ? '，无固定截止日期' : until ? '，至 ' + until : '，截止时间待核对') : '有效期暂不可读取',
  }
}
function presentChannel(item) {
  const offer = item.offer || {}
  return {
    id: item.id, offerCode: item.offerCode, title: item.title || '推广优惠',
    stateText: { available: '待使用', active: '已绑定本次消费', fulfilled: '已兑现', expired: '已过期', revoked: '已撤销' }[item.status] || '待核对',
    canUse: item.status === 'available', canOrder: ['available','active'].includes(item.status),
    sourceLabel: item.sourceLabel || '门店推荐',
    offerText: offer.kind === 'gift' ? (offer.productName || '指定赠品') + ' ' + offer.quantity + ' 份' : offer.kind === 'credit' ? '优惠 ' + money(offer.amountMinor) : offer.kind === 'discount' ? '优惠 ' + offer.discountBps / 100 + '%，最多 ' + money(offer.maximumMinor) : '请查看优惠规则',
    productText: item.eligibleProductScope === 'all' ? '全部商品参与（本券生成时在售商品）' : (item.eligibleProducts || []).map(p => p.name).join('、') || '请查看适用商品',
    validText: storeTime(item.useFrom) + ' 至 ' + storeTime(item.useUntil),
    validityBoundaries: item.status === 'available' ? [item.useFrom, item.useUntil].filter(Boolean) : [],
  }
}
Page({
  data: { channelCoupons: [], channelLoading: true, channelLoadingMore: false, channelError: '', channelNextCursor: null, loading: true, loadingMore: false, error: '', moreError: '', coupons: [], nextCursor: null },
  onShow() { this.visible = true; return this.load() },
  clearValidityRefresh() { clearTimeout(this.validityTimer); this.validityTimer = null },
  scheduleValidityRefresh() {
    this.clearValidityRefresh()
    if (this.visible === false) return
    const now = Date.now(), boundaries = []
    this.data.coupons.concat(this.data.channelCoupons).forEach(item => item.validityBoundaries.forEach(value => {
      const instant = parseInstant(value); if (instant > now) boundaries.push(instant)
    }))
    // Refresh authoritative state; never convert redeemed/reserved coupons back locally.
    if (boundaries.length) this.validityTimer = setTimeout(() => this.load(), Math.min(2147483647, Math.min(...boundaries) - now + 1))
  },
  usePriceCoupon() {
    wx.setStorageSync('mbox.issued-coupon-entry-request.v1', true)
    wx.switchTab({ url: '/pages/order/index' })
  },
  onHide() { this.visible = false; this.clearValidityRefresh(); this.loadGeneration = (this.loadGeneration || 0) + 1; this.channelGeneration = (this.channelGeneration || 0) + 1 },
  onUnload() { this.onHide() },
  async load() {
    this.clearValidityRefresh()
    const channelRead = this.loadChannelCoupons()
    const generation = this.loadGeneration = (this.loadGeneration || 0) + 1
    this.setData({ loading: true, loadingMore: false, error: '', moreError: '', coupons: [], nextCursor: null })
    try {
      const acceptPage = beginMemberPage(this, 'coupons', null)
      const result = await getCustomerBenefitWallet()
      if (generation !== this.loadGeneration) return
      acceptPage(result.nextCursor)
      this.setData({ loading: false, coupons: result.items.map(present), nextCursor: result.nextCursor })
      this.scheduleValidityRefresh()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.setData({ loading: false, error: customerErrorMessage(error, '优惠券暂时无法读取') })
    } finally { await channelRead }
  },
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.nextCursor) return
    const generation = this.loadGeneration
    const cursor = this.data.nextCursor
    this.setData({ loadingMore: true, moreError: '' })
    try {
      const acceptPage = beginMemberPage(this, 'coupons', cursor)
      const result = await getCustomerBenefitWallet(cursor)
      if (generation !== this.loadGeneration) return
      acceptPage(result.nextCursor)
      const existing = new Set(this.data.coupons.map((item) => item.id))
      const additions = result.items.filter((item) => {
        if (existing.has(item.id)) return false
        existing.add(item.id)
        return true
      }).map(present)
      this.setData({ loadingMore: false, coupons: this.data.coupons.concat(additions), nextCursor: result.nextCursor })
      this.scheduleValidityRefresh()
    } catch (error) {
      if (generation !== this.loadGeneration) return
      if (error.memberPageOwnerChanged) this.setData({ coupons: [], nextCursor: null })
      this.setData({ loadingMore: false, moreError: customerErrorMessage(error, '更多优惠券暂时无法读取，请重试') })
    }
  },
  async loadChannelCoupons(event, more = false) {
    if (more && (this.data.channelLoading || this.data.channelLoadingMore || !this.data.channelNextCursor)) return
    const cursor = more ? this.data.channelNextCursor : null
    const generation = more ? this.channelGeneration : (this.channelGeneration = (this.channelGeneration || 0) + 1)
    this.setData(more ? {channelLoadingMore:true, channelError:''} : {channelLoading:true, channelLoadingMore:false, channelCoupons:[], channelNextCursor:null, channelError:''})
    try {
      const acceptPage = beginMemberPage(this, 'channel-coupons', cursor)
      const result = await getChannelWalletPage({cursor, status:'all'})
      if (generation !== this.channelGeneration) return
      acceptPage(result.nextCursor)
      this.acceptChannelOwner = acceptPage
      const previous = more ? this.data.channelCoupons : [], known = new Set(previous.map(c => c.id))
      const additions = result.items.filter(c => { if (known.has(c.id)) return false; known.add(c.id); return true }).map(presentChannel)
      this.setData({channelCoupons:previous.concat(additions), channelNextCursor:result.nextCursor})
    } catch (error) {
      if (generation !== this.channelGeneration) return
      if (error.memberPageOwnerChanged) this.setData({channelCoupons:[], channelNextCursor:null, coupons:[], nextCursor:null})
      this.setData({channelError:customerErrorMessage(error, '推广优惠暂时无法读取，请重试')})
    } finally {
      if (generation === this.channelGeneration) { this.setData({channelLoading:false, channelLoadingMore:false}); this.scheduleValidityRefresh() }
    }
  },
  loadMoreChannelCoupons() { return this.loadChannelCoupons(null, true) },
  openChannelCoupon(event) {
    const item = this.data.channelCoupons.find(c => c.id === event.currentTarget.dataset.id)
    if (!item || this.visible === false) return
    try {
      if (!this.acceptChannelOwner) return
      this.acceptChannelOwner(null)
      wx.navigateTo({url:'/pages/channel-coupons/index?code=' + channelCode(item.offerCode) + '&claimId=' + encodeURIComponent(item.id) + (item.canOrder ? '&order=1' : '')})
    } catch (error) { this.setData({channelCoupons:[], channelNextCursor:null, channelError:customerErrorMessage(error, '请刷新后重新选择优惠券')}) }
  },

})
