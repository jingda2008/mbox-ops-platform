const { getCustomerBenefits } = require('../../utils/api')
const { money } = require('../../utils/format')
const { customerErrorMessage } = require('../../utils/customer-error')

const BENEFIT_NAMES = {
  gift_product: '赠送好礼',
  discount: '折扣券',
  credit: '金额券',
  amount_coupon: '金额券',
  access: '专属资格',
  other: '优惠券',
}

Page({
  data: { loading: true, error: '', coupons: [] },
  onShow() { this.load() },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const rows = await getCustomerBenefits()
      const coupons = (rows || []).map((item) => {
        const display = item.display || {}
        return {
          id: item.id,
          typeText: BENEFIT_NAMES[item.type] || '优惠券',
          quantityText: item.quantityAvailable > 1 ? `${item.quantityAvailable} 张` : '1 张',
          title: display.title || display.name || BENEFIT_NAMES[item.type] || '门店优惠',
          description: display.description || display.summary || '到店后可向服务员出示使用',
          valueText: item.valueAmountMinor > 0 ? money(item.valueAmountMinor) : '',
          validText: item.validUntil ? String(item.validUntil).slice(0, 10) : '长期有效',
        }
      })
      this.setData({ loading: false, coupons })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '优惠券暂时无法读取') })
    }
  },
})
