const { getCustomerBottles } = require('../../utils/api')
const { customerErrorMessage } = require('../../utils/customer-error')
const { presentOrder } = require('../../utils/custody')
Page({
  data: { items: [], loading: false, loaded: false, error: '', nextCursor: null },
  onShow() { return this.load() },
  onHide() { this.generation = (this.generation || 0) + 1; this.setData({ items: [], loaded: false, loading: false, nextCursor: null, error: '' }) },
  onUnload() { this.generation = (this.generation || 0) + 1 },
  async onPullDownRefresh() { try { await this.load() } finally { wx.stopPullDownRefresh() } },
  onReachBottom() { return this.loadMore() },
  loadMore() { if (this.data.nextCursor && !this.data.loading) return this.load(true) },
  async load(more) {
    more = more === true
    const generation = this.generation = (this.generation || 0) + 1
    this.setData(Object.assign({ loading: true, error: '' }, more ? {} : { items: [], loaded: false, nextCursor: null }))
    try {
      const result = await getCustomerBottles(more ? this.data.nextCursor : null)
      if (generation !== this.generation) return
      const items = result.items.map(presentOrder)
      this.setData({ items: more ? Array.from(new Map(this.data.items.concat(items).map(item => [item.id, item])).values()) : items, nextCursor: result.nextCursor || null, loading: false, loaded: true })
    } catch (error) { if (generation === this.generation) this.setData({ loading: false, error: customerErrorMessage(error, '存酒记录暂未读取，请重试') }) }
  },
  retry() { return this.data.loaded && this.data.nextCursor ? this.loadMore() : this.load() },
  openDetail(event) { wx.navigateTo({ url: '/pages/profile-bottle-detail/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  openMembership() { wx.switchTab({ url: '/pages/profile/index' }) },
})
