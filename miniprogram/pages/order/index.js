const { getMenu, recommendExperience, createExperiencePlan, prepareCheckoutUpgrade, checkout, createServiceTask } = require('../../utils/api')
const { money } = require('../../utils/format')

const OCCASIONS = [
  { code: 'date', name: '约会' }, { code: 'friends', name: '朋友聚会' },
  { code: 'business', name: '商务聊天' }, { code: 'birthday', name: '生日庆祝' },
  { code: 'music', name: '专心听歌' }, { code: 'relax', name: '轻松坐坐' },
]
const ALCOHOL = [
  { code: 'cocktail', name: '鸡尾酒' }, { code: 'wine', name: '红酒' },
  { code: 'sparkling', name: '气泡酒' }, { code: 'whisky', name: '威士忌' },
  { code: 'beer', name: '啤酒' }, { code: 'non_alcoholic', name: '无酒精' },
  { code: 'undecided', name: '请帮我选' },
]

Page({
  data: {
    loading: true, busy: false, error: '', products: [], recommendations: [], recommendationPublicId: '',
    occasionOptions: OCCASIONS, occasionIndex: 1, alcoholOptions: ALCOHOL, alcoholIndex: 6,
    cart: [], cartTotal: '¥0.00', upgradeOffer: null, upgradeAdd: '', targetTotal: '',
    serviceActions: [
      { code: 'water', name: '加水' }, { code: 'ice', name: '加冰' },
      { code: 'order', name: '点单协助' }, { code: 'bill', name: '买单协助' },
      { code: 'complaint', name: '经理协助' },
    ],
  },
  onShow() { this.loadMenu() },
  async loadMenu() {
    this.setData({ loading: true, error: '' })
    try {
      const products = (await getMenu({})).filter((item) => item.available).sort((left, right) => {
        if (left.productKind !== right.productKind) return left.productKind === 'bundle' ? -1 : 1
        return (left.sortOrder || 0) - (right.sortOrder || 0)
      }).map((item) => Object.assign({}, item, {
        priceText: money(item.amountMinor),
        includedText: (item.bundleComponents || []).map((line) => `${line.name || '组合内容'}×${line.quantity || 1}`).join(' · '),
      }))
      this.setData({ loading: false, products })
    } catch (error) { this.setData({ loading: false, error: error.message || '请扫描桌码后查看菜单' }) }
  },
  onOccasionChange(event) { this.setData({ occasionIndex: Number(event.detail.value) }) },
  onAlcoholChange(event) { this.setData({ alcoholIndex: Number(event.detail.value) }) },
  async recommend() {
    if (this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      const occasion = this.data.occasionOptions[this.data.occasionIndex].code
      const alcoholPreference = this.data.alcoholOptions[this.data.alcoholIndex].code
      const result = await recommendExperience({ occasion, alcoholPreference, experienceLevel: 'enhanced', serviceIntensity: 'balanced' })
      const recommendations = (result.recommendations || []).map((item) => Object.assign({}, item, {
        priceText: money(item.amountMinor), savingsText: item.savingsAmountMinor > 0 ? `比单点省 ${money(item.savingsAmountMinor)}` : '',
        tierText: item.tier === 'signature' ? '尽兴' : item.tier === 'enhanced' ? '推荐' : '舒适',
      }))
      this.setData({ recommendations, recommendationPublicId: result.publicId || '' })
    } catch (error) { this.setData({ error: error.message || '暂时无法推荐' }) }
    finally { this.setData({ busy: false }) }
  },
  async addProduct(event) {
    const productId = event.currentTarget.dataset.id
    const product = this.data.products.concat(this.data.recommendations).find((item) => item.productId === productId)
    if (!product) return
    if (event.currentTarget.dataset.source === 'recommendation' && this.data.recommendationPublicId) {
      try {
        await createExperiencePlan({
          recommendationPublicId: this.data.recommendationPublicId,
          selectedProductId: productId,
          promiseSummary: `按${this.data.occasionOptions[this.data.occasionIndex].name}场景安排${product.name}`,
        })
      } catch (error) {
        this.setData({ error: error.message || '体验安排没有建立，请重新选择' })
        return
      }
    }
    const cart = this.data.cart.slice()
    const existing = cart.find((item) => item.productId === productId)
    if (existing) existing.quantity += 1
    else cart.push({ productId, name: product.name, quantity: 1, amountMinor: product.amountMinor })
    this.updateCart(cart)
  },
  changeQuantity(event) {
    const productId = event.currentTarget.dataset.id
    const delta = Number(event.currentTarget.dataset.delta)
    const cart = this.data.cart.map((item) => Object.assign({}, item))
    const item = cart.find((line) => line.productId === productId)
    if (item) item.quantity += delta
    this.updateCart(cart.filter((line) => line.quantity > 0))
  },
  updateCart(cart) {
    this.setData({ cart, cartTotal: money(cart.reduce((sum, item) => sum + item.amountMinor * item.quantity, 0)) })
  },
  async callService(event) {
    if (this.data.busy) return
    const code = event.currentTarget.dataset.code
    const action = this.data.serviceActions.find((item) => item.code === code)
    if (!action) return
    this.setData({ busy: true, error: '' })
    try {
      await createServiceTask({
        requestType: code === 'complaint' ? 'complaint' : 'custom',
        detail: code === 'complaint' ? '顾客请求值班经理到桌协助' : `顾客请求：${action.name}`,
      })
      wx.showToast({ title: '已通知服务人员', icon: 'success' })
    } catch (error) { this.setData({ error: error.message || '服务请求暂时没有送达' }) }
    finally { this.setData({ busy: false }) }
  },
  async openCheckout() {
    if (!this.data.cart.length || this.data.busy) return
    this.setData({ busy: true, error: '', upgradeOffer: null })
    const items = this.data.cart.map((item) => ({ productId: item.productId, quantity: item.quantity }))
    try {
      const offer = await prepareCheckoutUpgrade(items, this.data.occasionOptions[this.data.occasionIndex].code, this.data.alcoholOptions[this.data.alcoholIndex].code)
      if (offer) {
        this.setData({ upgradeOffer: offer, upgradeAdd: money(offer.amountToAddMinor), targetTotal: money(offer.targetExperience.totalAmountMinor) })
      } else await this.submitOrder(null, true)
    } catch (error) { this.setData({ error: error.message || '结算信息暂时无法确认' }) }
    finally { this.setData({ busy: false }) }
  },
  declineUpgrade() { this.setData({ upgradeOffer: null }); this.submitOrder(null) },
  acceptUpgrade() { const offer = this.data.upgradeOffer; if (!offer) return; this.setData({ upgradeOffer: null }); this.submitOrder(offer.publicId) },
  async submitOrder(offerPublicId, allowBusy) {
    if (this.data.busy && !allowBusy) return
    this.setData({ busy: true, error: '' })
    try {
      const result = await checkout(this.data.cart.map((item) => ({ productId: item.productId, quantity: item.quantity })), offerPublicId)
      const data = result.data || result
      const action = data.payment && data.payment.providerAction
      if (action && action.presentation === 'jsapi' && action.status === 'ready' && action.payload) {
        await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, action.payload, { success: resolve, fail: reject })))
        wx.showToast({ title: '付款完成', icon: 'success' })
      } else {
        wx.showModal({ title: '订单已确认', content: '付款通道尚未返回可支付信息，请联系服务人员确认，不要重复下单。', showCancel: false })
      }
      this.updateCart([])
    } catch (error) { this.setData({ error: error.message || '订单没有提交成功，请勿重复操作' }) }
    finally { this.setData({ busy: false }) }
  },
})
