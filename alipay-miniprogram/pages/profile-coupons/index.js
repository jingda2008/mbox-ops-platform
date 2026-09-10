const { getCustomerBenefitWallet } = require('../../utils/api')
const { money, dateInput } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')
const BENEFIT_NAMES = { gift_product: '赠送好礼', discount: '折扣券', credit: '金额券', amount_coupon: '金额券', access: '专属资格', other: '优惠券' }
const STATES = { available: '可使用', upcoming: '未到使用时间', reserved: '使用处理中', redeemed: '已使用', expired: '已过期', revoked: '已撤销', unavailable: '暂不可用', outside_window: '非可用时段' }
function storeTime(value) {
  if (!value) return ''
  const date = new Date(dateInput(value))
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}
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
    id: item.id, typeText: pricePromise ? '固定低价兑换券' : BENEFIT_NAMES[item.type] || '优惠券',
    stateText: STATES[item.state] || STATES.unavailable,
    quantityText: '剩余 ' + item.quantityAvailable + ' · 处理中 ' + item.quantityReserved + ' · 已用 ' + item.quantityRedeemed,
    calendarText: calendar ? calendar.summary : '',
    calendarNextText: calendar ? (calendar.nextAvailableAt ? '可用时间：' + storeTime(calendar.nextAvailableAt) : '已无后续可用时段') : '',
    calendarLimitText: limitText ? limitText + '（同活动多张券合计，含处理中次数）' : '',
    title: display.title || display.name || BENEFIT_NAMES[item.type] || '门店优惠',
    description: pricePromise ? '每份按 ' + money(pricePromise.fixedPriceMinor) + ' 兑换，不是减免金额。适用：' + pricePromise.products.map(product => product.name).join('、') + '。需在订单确认时选择，叠加以报价结果为准。' : display.description || display.summary || '使用方式及限制以权益说明为准。',
    valueText: pricePromise ? money(pricePromise.fixedPriceMinor) + '/份' : item.type === 'credit' && item.valueAmountMinor > 0 ? money(item.valueAmountMinor) : '',
    validText: from ? from + ' 起' + (until ? '，至 ' + until : '，无固定截止日期') : '有效期暂不可读取',
  }
}
Page({
  data: { loading: true, loadingMore: false, error: '', moreError: '', coupons: [], nextCursor: null },
  onShow() { this.load() },
  onHide() { this.loadGeneration = (this.loadGeneration || 0) + 1 },
  onUnload() { this.loadGeneration = (this.loadGeneration || 0) + 1 },
  async load() {
    const generation = this.loadGeneration = (this.loadGeneration || 0) + 1
    this.setData({ loading: true, loadingMore: false, error: '', moreError: '', coupons: [], nextCursor: null })
    try {
      const result = await getCustomerBenefitWallet()
      if (generation !== this.loadGeneration) return
      this.setData({ loading: false, coupons: result.items.map(present), nextCursor: result.nextCursor })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.setData({ loading: false, error: customerErrorMessage(error, '优惠券暂时无法读取') })
    }
  },
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.nextCursor) return
    const generation = this.loadGeneration
    const cursor = this.data.nextCursor
    this.setData({ loadingMore: true, moreError: '' })
    try {
      const result = await getCustomerBenefitWallet(cursor)
      if (generation !== this.loadGeneration) return
      const existing = new Set(this.data.coupons.map((item) => item.id))
      const additions = result.items.filter((item) => {
        if (existing.has(item.id)) return false
        existing.add(item.id)
        return true
      }).map(present)
      this.setData({ loadingMore: false, coupons: this.data.coupons.concat(additions), nextCursor: result.nextCursor })
    } catch (error) {
      if (generation !== this.loadGeneration) return
      this.setData({ loadingMore: false, moreError: customerErrorMessage(error, '更多优惠券暂时无法读取，请重试') })
    }
  },
})
