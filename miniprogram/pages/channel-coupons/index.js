const { getChannelWalletPage, getChannelOffer, claimChannelCoupon, activateChannelCoupon } = require('../../utils/api')
const { ensureCustomerSession, isMembershipLoggedOut } = require('../../utils/auth')
const { redirectToMembershipLogin } = require('../../utils/membership-gate')
const { channelCode, channelScanCode } = require('../../utils/channel-entry')
const { commandIdentityScope } = require('../../utils/recoverable-command')
const { customerErrorMessage } = require('../../utils/customer-error')
const { getTableSession } = require('../../utils/session')
const FILTERS = [{value:'all',label:'全部'}, {value:'available',label:'待使用'}, {value:'active',label:'本次消费已绑定'}, {value:'fulfilled',label:'已兑现'}, {value:'expired',label:'已过期'}, {value:'revoked',label:'已撤销'}]
const STATES = { available: '待使用', active: '已绑定本次消费', fulfilled: '已兑现', expired: '已过期', revoked: '已撤销' }
function time(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + 28800000).toISOString().slice(0, 16).replace('T', ' ') : '待核对'
}
function present(item) {
  return Object.assign({}, item, {
    stateText: STATES[item.status] || '待核对', timeText: time(item.useFrom) + ' 至 ' + time(item.useUntil),
    claimTimeText: time(item.claimFrom) + ' 至 ' + time(item.claimUntil),
    stackingText: item.allowStacking ? '允许渠道券叠加 · ' + (item.visitDiscountCapMinor == null ? '未设置客组总上限' : '客组总优惠最高 ¥' + (item.visitDiscountCapMinor / 100).toFixed(2)) + '（含赠品售价，转桌不重置；不同批次取更严限制）' : '不允许叠加，本次客组只能使用一张渠道券',
    minimumText: '¥' + (item.minimumMinor / 100).toFixed(2),
    productText: (item.eligibleProducts || []).map(p => p.name).join('、') || '请向员工核对适用商品',
    offerText: item.offer.kind === 'gift' ? (item.offer.productName || '指定赠品') + ' ' + item.offer.quantity + ' 份' : item.offer.kind === 'credit' ? '优惠 ¥' + (item.offer.amountMinor / 100).toFixed(2) : '优惠 ' + (item.offer.discountBps / 100) + '%，最多 ¥' + (item.offer.maximumMinor / 100).toFixed(2),
  })
}
Page({
  data: { filters:FILTERS, filterIndex:0, nextCursor:null, loadingMore:false, code: '', coupons: [], offer: null, loading: false, busy: false, needsLogin: false, error: '', notice: '' },
  onLoad(options) {
    if (options && (options.scene || options.code)) {
      try { this.entryError = ''; this.setData({ code: channelCode(options.scene || options.code), offer: null, error: '', notice: '' }) }
      catch (_) { this.entryError = '推广码格式不正确，请输入图上的优惠号码'; this.setData({ code: '', offer: null, error: this.entryError }) }
    }
  },
  onShow() {
    const app = typeof getApp === 'function' ? getApp() : null
    if (app && app.globalData.channelOfferLaunch) {
      const entry = app.globalData.channelOfferLaunch
      app.globalData.channelOfferLaunch = null
      this.onLoad(entry)
    }
    return this.load()
  },
  onReachBottom() { return this.loadMore() },
  filterChanged(event) { const index=Number(event.detail.value); if(!FILTERS[index]||this.data.busy)return; this.setData({filterIndex:index}); return this.load() },
  onHide() { this.generation = (this.generation || 0) + 1 },
  onUnload() { this.generation = (this.generation || 0) + 1 },
  inputCode(event) { this.entryError = ''; this.generation = (this.generation || 0) + 1; this.setData({ code: event.detail.value, offer: null, nextCursor:null, loadingMore:false, loading: false, notice: '', error: '' }) },
  scan() {
    const generation=this.generation,owner=commandIdentityScope(),code=this.data.code
    const request=this.scanRequest=(this.scanRequest||0)+1
    const current=()=>generation===this.generation&&owner===commandIdentityScope()&&request===this.scanRequest&&code===this.data.code
    wx.scanCode({ onlyFromCamera: false, success: result => {
      if(!current())return
      try { this.entryError = ''; this.setData({ code: channelScanCode(result), offer: null, error: '', notice: '' }); this.load() }
      catch (error) { this.setData({ error: error.message }) }
    }, fail: error => {
      if(!current()||/cancel/i.test(String(error&&error.errMsg||'')))return
      this.setData({ error: '未识别到优惠码，可以输入图片上的优惠号码' })
    } })
  },
  login() {
    let destination = '/pages/channel-coupons/index'
    try { if (this.data.code) destination += '?code=' + channelCode(this.data.code) } catch (_) { /* Keep invalid input out of login return paths. */ }
    redirectToMembershipLogin(destination)
  },
  async load() {
    const generation = this.generation = (this.generation || 0) + 1
    this.walletOwner=null
    this.setData({ loading: true, loadingMore:false, nextCursor:null, coupons: [], offer: null, needsLogin: false })
    let owner
    try {
      if (isMembershipLoggedOut()) { this.setData({ needsLogin: true }); return }
      // A cold scan can establish identity here; take the account snapshot AFTER initialization.
      await ensureCustomerSession(false)
      if (generation !== this.generation) return
      owner = commandIdentityScope()
      const code = this.data.code ? channelCode(this.data.code) : ''
      const [page, offer] = await Promise.all([getChannelWalletPage({status:FILTERS[this.data.filterIndex].value}), code ? getChannelOffer(code) : Promise.resolve(null)])
      if (generation !== this.generation || owner !== commandIdentityScope()) return
      this.walletOwner=owner
      const viewed=offer?present(offer):null
      if(viewed)viewed.existingCoupon=offer.existingCoupon?present(offer.existingCoupon):null
      this.setData({ coupons: page.items.map(present), nextCursor:page.nextCursor, offer:viewed, error: this.entryError || '' })
    } catch (error) {
      if (generation === this.generation && (!owner || owner === commandIdentityScope())) this.setData({
        needsLogin: error.code === 'AUTH_REQUIRED', error: customerErrorMessage(error, '优惠暂时无法读取，请重试'),
      })
    } finally { if (generation === this.generation) this.setData({ loading: false }) }
  },
  async loadMore() {
    if(this.data.loading||this.data.loadingMore||this.data.busy||!this.data.nextCursor)return
    if(this.walletOwner!==commandIdentityScope())return this.load()
    const owner=this.walletOwner,generation=this.generation,cursor=this.data.nextCursor,status=FILTERS[this.data.filterIndex].value
    this.setData({loadingMore:true,error:''})
    try {
      const page=await getChannelWalletPage({cursor,status})
      if(generation!==this.generation||owner!==commandIdentityScope())return
      if(page.nextCursor===cursor)throw new Error('券包分页未前进，请刷新后重试')
      const known=new Set(this.data.coupons.map(item=>item.id))
      this.setData({coupons:this.data.coupons.concat(page.items.filter(item=>!known.has(item.id)).map(present)),nextCursor:page.nextCursor})
    } catch(error) {if(generation===this.generation&&owner===commandIdentityScope())this.setData({error:customerErrorMessage(error,'更多优惠读取失败，请重试')})}
    finally {if(generation===this.generation)this.setData({loadingMore:false})}
  },
  async claim() {
    if (this.data.needsLogin) { this.login(); return }
    // First inspect rules; a manual number is never submitted unseen.
    if (!this.data.offer) { await this.load(); return }
    if (this.data.offer.unavailable || this.data.loading) return
    await this.write('claim', this.data.code.trim())
  },
  async useCoupon(event) {
    if (!getTableSession().tableToken) { this.setData({ error: '请先扫描当前桌码确认入座，再使用本人的优惠券' }); return }
    await this.write('activate', event.currentTarget.dataset.id)
  },
  async write(action, value) {
    if (this.writing || !value) return
    this.writing = true
    const generation = this.generation, owner = commandIdentityScope()
    this.setData({ busy: true, error: '', notice: '' })
    try {
      if (action === 'claim') await claimChannelCoupon(value)
      else await activateChannelCoupon(value)
      if (generation !== this.generation || owner !== commandIdentityScope()) return
      this.setData({ notice: action === 'claim' ? '已领到本人账户，可在「我的优惠券 → 推荐优惠」查看。到店扫描桌码后使用。' : '已绑定本次消费，最终优惠以订单确认结果为准。' })
      await this.load()
    } catch (error) {
      if (generation === this.generation && owner === commandIdentityScope()) this.setData({ error: customerErrorMessage(error, '结果待核对，请用相同内容恢复原操作') })
    } finally { this.writing = false; this.setData({ busy: false }) }
  },
})
