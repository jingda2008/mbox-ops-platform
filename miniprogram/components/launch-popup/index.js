const { publicImageUrl } = require('../../utils/media')
const { ensureCustomerSession } = require('../../utils/auth')
const { request } = require('../../utils/request')
const { popupShouldDisplay } = require('../../utils/launch-popup-policy')
Component({
 data: { visible: false, popup: null, currentIndex: 0, posterWidth: 310, posterHeight: 232.5 },
 pageLifetimes: { show() { this.loadPopup() }, resize(event) { this.updatePosterSize(event.size.windowWidth) }, hide() { this.setData({ visible: false }); this.generation = (this.generation || 0) + 1 } },
 lifetimes: { detached() { this.generation = (this.generation || 0) + 1 } },
 methods: {
  updatePosterSize(windowWidth) {
   const width = Number(windowWidth)
   const posterWidth = Number.isFinite(width) && width > 0 ? Math.min(width * 620 / 750, 480) : (this.data.posterWidth || 310)
   this.setData({ posterWidth, posterHeight: posterWidth * .75 })
  },
  imageLoaded(event) {
   const index = Number(event.currentTarget.dataset.index), width = Number(event.detail.width), height = Number(event.detail.height)
   const product = this.data.popup && this.data.popup.products[index]
   if (!product || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
   const ratio = height / width, patch = {}
   patch[`popup.products[${index}]`] = Object.assign({}, product, { imageHeightRatio: ratio })
   this.setData(patch)
  },
  async loadPopup() {
   const generation = this.generation = (this.generation || 0) + 1
   try {
    const window = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.updatePosterSize(window.windowWidth)
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
    this.setData({ visible: true, currentIndex: 0, posterHeight: (this.data.posterWidth || 310) * .75, popup: Object.assign({},popup,{products:(popup.products||[]).map(item=>Object.assign({},item,{imageUrl:publicImageUrl(item.imageUrl),originalImageUrl:publicImageUrl(item.imageUrl),imageFailed:false,imageHeightRatio:0}))}) })
   } catch (_) { /* Optional promotion must not block the customer's primary task. */ }
  },
  imageFailed(event) { const index=Number(event.currentTarget.dataset.index), product=this.data.popup&&this.data.popup.products[index];if(!product)return;const patch={};patch[`popup.products[${index}]`]=Object.assign({},product,product.originalImageUrl&&product.imageUrl!==product.originalImageUrl?{imageUrl:product.originalImageUrl}:{imageFailed:true});this.setData(patch) },
  changeSlide(event) { const index=Number(event.detail.current);if(Number.isInteger(index)&&index>=0&&index<(this.data.popup?.products.length||0))this.setData({currentIndex:index}) },
  close() { this.setData({ visible: false }) },
  stop() {},
  order() { this.close(); wx.switchTab({ url: '/pages/order/index' }) },
 }
})
