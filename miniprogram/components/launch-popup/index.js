const { publicImageUrl } = require('../../utils/media')
const { money } = require('../../utils/format')
const { ensureCustomerSession } = require('../../utils/auth')
const { request } = require('../../utils/request')
const { popupShouldDisplay } = require('../../utils/launch-popup-policy')
Component({
 data: { visible: false, popup: null, currentIndex: 0 },
 pageLifetimes: { show() { this.loadPopup() }, hide() { this.setData({ visible: false }); this.generation = (this.generation || 0) + 1 } },
 lifetimes: { detached() { this.generation = (this.generation || 0) + 1 } },
 methods: {
  async loadPopup() {
   const generation = this.generation = (this.generation || 0) + 1
   try {
    await ensureCustomerSession()
    const result = await request('/api/public/mini/launch-popup', { requireTableSession: false })
    if (generation !== this.generation) return
    const popup = result.data, app = getApp(), now = Date.now()
    const state = app.globalData.launchPopupSeen || {}, day = new Date(now + 8 * 3600000).toISOString().slice(0,10)
    let stored = null
    try { stored = wx.getStorageSync('mbox.launch-popup.daily.v1') } catch (_) {}
    if (!popupShouldDisplay(popup, { day, storedDay: stored && stored.day, sessionSeen: Boolean(state.session), foregroundSeen: state.foreground === app.globalData.foregroundSequence })) return
    app.globalData.launchPopupSeen = { session: true, foreground: app.globalData.foregroundSequence }
    try { wx.setStorageSync('mbox.launch-popup.daily.v1', { day }) } catch (_) {}
    this.setData({ visible: true, currentIndex: 0, popup: Object.assign({},popup,{products:(popup.products||[]).map(item=>Object.assign({},item,{imageUrl:publicImageUrl(item.imageUrl),originalImageUrl:publicImageUrl(item.imageUrl),imageFailed:false,priceText:Number.isSafeInteger(item.amountMinor)&&item.amountMinor>=0?(item.currency==='CNY'?money(item.amountMinor):`${item.currency||''} ${(item.amountMinor/100).toFixed(2)}`):'价格待确认'}))}) })
   } catch (_) { /* Optional promotion must not block the customer's primary task. */ }
  },
  imageFailed(event) { const index=Number(event.currentTarget.dataset.index), product=this.data.popup&&this.data.popup.products[index];if(!product)return;const patch={};patch[`popup.products[${index}]`]=Object.assign({},product,product.originalImageUrl&&product.imageUrl!==product.originalImageUrl?{imageUrl:product.originalImageUrl}:{imageFailed:true});this.setData(patch) },
  changeSlide(event) { const index=Number(event.detail.current);if(Number.isInteger(index)&&index>=0&&index<(this.data.popup?.products.length||0))this.setData({currentIndex:index}) },
  close() { this.setData({ visible: false }) },
  stop() {},
  order() { this.close(); wx.switchTab({ url: '/pages/order/index' }) },
 }
})
