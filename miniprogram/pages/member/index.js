const { getMemberPortal } = require('../../utils/api')
const { getRuntimeConfig } = require('../../config/index')
const { customerErrorMessage } = require('../../utils/customer-error')

const LEVEL_NAMES = { standard: '会员', silver: '银卡会员', gold: '金卡会员', platinum: '白金会员' }
const KIND_NAMES = { product_gift: '商品权益', amount_coupon: '金额券', service: '服务权益', song: '点歌权益' }

Page({
  data: {
    loading: true,
    error: '',
    warning: '',
    isDevelopment: false,
    member: null,
    benefits: [],
    totalQuantity: 0,
  },

  onLoad() {
    this.setData({ isDevelopment: getRuntimeConfig().isDevelopment })
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const result = await getMemberPortal()
      const benefits = result.data.benefits.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        kindText: KIND_NAMES[item.kind] || '会员权益',
        kindInitial: (KIND_NAMES[item.kind] || '权益').slice(0, 1),
        quantityText: `×${item.remainingQuantity}`,
        validUntilText: String(item.validUntil).slice(0, 10),
        statusText: item.status === 'locked' ? '使用中' : '可用',
      }))
      this.setData({
        loading: false,
        warning: result.warning,
        member: Object.assign({}, result.data.member, {
          levelText: LEVEL_NAMES[result.data.member.level] || '会员',
          initial: result.data.member.displayName.slice(0, 1),
        }),
        benefits,
        totalQuantity: result.data.benefits.reduce((sum, item) => sum + item.remainingQuantity, 0),
      })
    } catch (error) {
      this.setData({ loading: false, error: customerErrorMessage(error, '会员账户载入失败') })
    }
  },
})
