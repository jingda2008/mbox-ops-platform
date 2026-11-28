const { publicImageUrl } = require('../../utils/media')
const { ensureCustomerSession } = require('../../utils/auth')
const { request } = require('../../utils/request')
const { popupShouldDisplay } = require('../../utils/launch-popup-policy')
// The WeChat package targets one store. Scope the short cache to its session
// and foreground so returning from the background refreshes campaign changes.
let popupRead
function popupScope(app) {
 return JSON.stringify([app.globalData.foregroundSequence, wx.getStorageSync('mbox.http.cookie.reservation.v2'),
  wx.getStorageSync('mbox.wechat.identity.principal.v1'), wx.getStorageSync('mbox.membership.loggedOut.v1')])
}

function readPopup(scope) {
 if (popupRead && popupRead.scope === scope && Date.now() < popupRead.expires) return popupRead.promise
 const entry = { scope, expires: Infinity }
 entry.promise = request('/api/public/mini/launch-popup', { requireTableSession: false }).then(result => {
  entry.expires = Date.now() + 15000
  return result
 }).catch(error => {
  if (popupRead === entry) popupRead = null
  throw error
 })
 popupRead = entry
 return entry.promise
}

const trialPosters = {
 'https://mbox.shmbox.com/api/public/media-assets/MA7D639F89CBF64BB5A334FBE4428FF8BB': '/assets/trial-posters/poster-1.webp',
 'https://mbox.shmbox.com/api/public/media-assets/MA6DE47AD30CF542C6AF784E013C9ED328': '/assets/trial-posters/poster-2.webp',
 'https://mbox.shmbox.com/api/public/media-assets/MAE092F5F243AE4809972E39FA01938204': '/assets/trial-posters/poster-3.webp',
 'https://mbox.shmbox.com/api/public/media-assets/MABDD855F1337344E7B2AF770E9D284754': '/assets/trial-posters/poster-4.webp',
 'https://mbox.shmbox.com/api/public/media-assets/MA3AC52B5E5BA54FAC8EDF16674BFA787F': '/assets/trial-posters/poster-5.webp',
}

function popupProducts(products) {
 const info = typeof wx.getAccountInfoSync === 'function' && wx.getAccountInfoSync()
 const version = info && info.miniProgram && info.miniProgram.envVersion
 const useTrialPosters = version === 'trial' || version === 'develop'
 return (products || []).map(item => {
  const originalImageUrl = publicImageUrl(item.imageUrl)
  const imageUrl = useTrialPosters && Object.prototype.hasOwnProperty.call(trialPosters, originalImageUrl)
   ? trialPosters[originalImageUrl] : originalImageUrl
  return Object.assign({}, item, { imageUrl, originalImageUrl, imageFailed: false, imageHeightRatio: 0 })
 })
}

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
    if (generation !== this.generation) return
    const app = getApp(), scope = popupScope(app)
    const result = await readPopup(scope)
    if (generation !== this.generation || scope !== popupScope(app)) return
    const popup = result.data, now = Date.now()
    const state = app.globalData.launchPopupSeen || {}, day = new Date(now + 8 * 3600000).toISOString().slice(0,10)
    let stored = null
    try { stored = wx.getStorageSync('mbox.launch-popup.daily.v1') } catch (_) {}
    if (!popupShouldDisplay(popup, { day, storedDay: stored && stored.day, sessionSeen: Boolean(state.session), foregroundSeen: state.foreground === app.globalData.foregroundSequence })) return
    app.globalData.launchPopupSeen = { session: true, foreground: app.globalData.foregroundSequence }
    try { wx.setStorageSync('mbox.launch-popup.daily.v1', { day }) } catch (_) {}
    this.setData({ visible: true, currentIndex: 0, posterHeight: (this.data.posterWidth || 310) * .75, popup: Object.assign({},popup,{products:popupProducts(popup.products)}) })
   } catch (_) { /* Optional promotion must not block the customer's primary task. */ }
  },
  imageFailed(event) { const index=Number(event.currentTarget.dataset.index), product=this.data.popup&&this.data.popup.products[index];if(!product)return;const patch={};patch[`popup.products[${index}]`]=Object.assign({},product,product.originalImageUrl&&product.imageUrl!==product.originalImageUrl?{imageUrl:product.originalImageUrl}:{imageFailed:true});this.setData(patch) },
  changeSlide(event) { const index=Number(event.detail.current);if(Number.isInteger(index)&&index>=0&&index<(this.data.popup?.products.length||0))this.setData({currentIndex:index}) },
  close() { this.setData({ visible: false }) },
  stop() {},
  order() { this.close(); wx.switchTab({ url: '/pages/order/index' }) },
 }
})
