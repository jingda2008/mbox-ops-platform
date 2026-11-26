const { beijingDateTime, parseInstant } = require('../../utils/format')
const { getGuestSession, getChannelWalletPage, getChannelOffer, claimChannelCoupon, activateChannelCoupon, recoverChannelClaim, recoverChannelCoupon } = require('../../utils/api')
const { ensureCustomerSession, isMembershipLoggedOut } = require('../../utils/auth')
const { redirectToMembershipLogin } = require('../../utils/membership-gate')
const { channelCode, channelScanCode } = require('../../utils/channel-entry')
const { commandIdentityScope, pendingGuestCommandMatches } = require('../../utils/recoverable-command')
const { customerErrorMessage } = require('../../utils/customer-error')
const { parseScanValue, getTableSession } = require('../../utils/session')
const FILTERS = [{value:'all',label:'全部'}, {value:'available',label:'待使用'}, {value:'active',label:'本次消费已绑定'}, {value:'fulfilled',label:'已兑现'}, {value:'expired',label:'已过期'}, {value:'revoked',label:'已撤销'}]
const STATES = { available: '待使用', active: '已绑定本次消费', fulfilled: '已兑现', expired: '已过期', revoked: '已撤销' }
function time(value) { return beijingDateTime(value, '待核对') }
function present(item) {
  return Object.assign({}, item, {
    stateText: STATES[item.status] || '待核对', timeText: time(item.useFrom) + ' 至 ' + time(item.useUntil),
    claimTimeText: time(item.claimFrom) + ' 至 ' + time(item.claimUntil),
    stackingText: item.allowStacking ? '允许渠道券叠加 · ' + (item.visitDiscountCapMinor == null ? '本次到店无总额上限' : '本组顾客本次到店最多优惠 ¥' + (item.visitDiscountCapMinor / 100).toFixed(2)) + '（含赠品售价，转桌不重置；不同批次取更严限制）' : '不允许叠加，每组顾客每次到店只能用一张此类优惠券',
    minimumText: '¥' + (item.minimumMinor / 100).toFixed(2),
    productText: item.eligibleProductScope === 'all' ? '全部商品参与（本券生成时在售商品）' : (item.eligibleProducts || []).map(p => p.name).join('、') || '请向员工核对适用商品',
    offerText: item.offer.kind === 'gift' ? (item.offer.productName || '指定赠品') + ' ' + item.offer.quantity + ' 份' : item.offer.kind === 'credit' ? '优惠 ¥' + (item.offer.amountMinor / 100).toFixed(2) : '优惠 ' + (item.offer.discountBps / 100) + '%，最多 ¥' + (item.offer.maximumMinor / 100).toFixed(2),
  })
}
Page({
  data: { selectedClaimId:'', selectedCoupon:null, orderAfterUse:false, canGoToOrder:false, hasTable:false, tableRetryId:null, checkingTable:false, manualEntry:false, expandedRules:'', pendingClaim:false, filters:FILTERS, filterIndex:0, nextCursor:null, loadingMore:false, code: '', coupons: [], offer: null, loading: false, busy: false, needsLogin: false, error: '', notice: '' },
  onLoad(options) {
    this.setData({selectedClaimId: options && /^[a-zA-Z0-9-]{1,80}$/.test(options.claimId || '') ? options.claimId : '', selectedCoupon:null, orderAfterUse: !!(options && options.order === '1'), canGoToOrder:false})
    if (options && (options.scene || options.code)) {
      try { this.entryError = ''; this.setData({ expandedRules: '', code: channelCode(options.scene || options.code), offer: null, error: '', notice: '' }) }
      catch (_) { this.entryError = '推广码格式不正确，请输入图上的优惠号码'; this.setData({ manualEntry: true, code: '', offer: null, error: this.entryError }) }
    }
  },
  onShow() {
    this.visible = true
    this.setData({ notice: '', hasTable: Boolean(getTableSession().tableToken), canGoToOrder: Boolean(this.data.canGoToOrder && this.orderOwner === commandIdentityScope() && this.orderScope === getTableSession().cartScope && this.orderToken === getTableSession().tableToken) })
    const app = typeof getApp === 'function' ? getApp() : null
    if (app && app.globalData.channelOfferLaunch) {
      const entry = app.globalData.channelOfferLaunch
      app.globalData.channelOfferLaunch = null
      this.tableScan = null
      this.onLoad(entry)
    } else if (this.tableScan && this.tableScan.owner === commandIdentityScope()) {
      return
    }
    this.tableScan = null
    return this.load()
  },
  onReachBottom() { return this.loadMore() },
  filterChanged(event) { const index=Number(event.detail.value); if(!FILTERS[index]||this.data.busy)return; this.setData({filterIndex:index}); return this.load() },
  onHide() { this.visible = false; this.clearValidityRefresh(); this.generation = (this.generation || 0) + 1 },
  onUnload() { this.tableScan = null; this.onHide() },
  clearValidityRefresh() { clearTimeout(this.validityTimer); this.validityTimer = null },
  scheduleValidityRefresh() {
    this.clearValidityRefresh()
    if (this.visible === false) return
    const now = Date.now(), boundaries = []
    const add = value => { const instant = parseInstant(value); if (instant > now) boundaries.push(instant) }
    const addCoupon = item => { if (item && item.status === 'available') { add(item.useFrom); add(item.useUntil) } }
    this.data.coupons.forEach(addCoupon)
    if (this.data.offer) {
      add(this.data.offer.claimFrom); add(this.data.offer.claimUntil)
      addCoupon(this.data.offer.existingCoupon)
    }
    // Device time only schedules a read; the server decides expiry and useability.
    // Active/fulfilled promises must not expire locally during the same visit.
    if (boundaries.length) this.validityTimer = setTimeout(() => this.load(), Math.min(2147483647, Math.min(...boundaries) - now + 1))
  },
  toggleManualEntry() { this.setData({ manualEntry: !this.data.manualEntry }) },
  toggleCouponRules(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ expandedRules: this.data.expandedRules === id ? '' : id })
  },
  inputCode(event) { this.clearValidityRefresh(); this.entryError = ''; this.generation = (this.generation || 0) + 1; this.setData({ expandedRules: '', code: event.detail.value, offer: null, nextCursor:null, loadingMore:false, loading: false, notice: '', error: '' }) },
  scan() {
    const generation=this.generation,owner=commandIdentityScope(),code=this.data.code
    const request=this.scanRequest=(this.scanRequest||0)+1
    const current=()=>generation===this.generation&&owner===commandIdentityScope()&&request===this.scanRequest&&code===this.data.code
    wx.scanCode({ onlyFromCamera: false, success: result => {
      if(!current())return
      try { this.entryError = ''; this.setData({ expandedRules: '', code: channelScanCode(result), offer: null, error: '', notice: '' }); this.load() }
      catch (error) { this.setData({ manualEntry: true, error: customerErrorMessage(error, '请扫描优惠码，或输入图片上的优惠号码') }) }
    }, fail: error => {
      if(!current()||/cancel/i.test(String(error&&error.errMsg||'')))return
      this.setData({ manualEntry: true, error: '未识别到优惠码，可以输入图片上的优惠号码' })
    } })
  },
  login() {
    let destination = '/pages/channel-coupons/index'
    try { if (this.data.code) destination += '?code=' + channelCode(this.data.code) } catch (_) { /* Keep invalid input out of login return paths. */ }
    redirectToMembershipLogin(destination)
  },
  presentCoupon(item) { return Object.assign(present(item), { canRecover: pendingGuestCommandMatches('channel.activate', { claimId:item.id }) }) },
  async load() {
    this.clearValidityRefresh()
    const generation = this.generation = (this.generation || 0) + 1
    this.walletOwner=null
    this.setData({ loading: true, loadingMore:false, nextCursor:null, coupons: [], offer: null, selectedCoupon:null, pendingClaim:false, needsLogin: false })
    let owner
    try {
      if (isMembershipLoggedOut()) { this.setData({ needsLogin: true }); return }
      // A cold scan can establish identity here; take the account snapshot AFTER initialization.
      await ensureCustomerSession(false)
      if (generation !== this.generation) return
      owner = commandIdentityScope()
      const code = this.data.code ? channelCode(this.data.code) : ''
      const selectedId = this.data.selectedClaimId
      const walletQuery = selectedId ? {status:'all',code} : {status:FILTERS[this.data.filterIndex].value}
      const [page, offer] = await Promise.all([getChannelWalletPage(walletQuery), code ? getChannelOffer(code) : Promise.resolve(null)])
      if (generation !== this.generation || owner !== commandIdentityScope()) return
      // Locate the exact coupon selected in the combined wallet, including later pages.
      const seen = new Set()
      while (selectedId && !page.items.some(item => item.id === selectedId) && page.nextCursor) {
        if (seen.has(page.nextCursor)) throw Error('券包分页未前进，请刷新核对')
        seen.add(page.nextCursor)
        const next = await getChannelWalletPage(Object.assign({}, walletQuery, {cursor:page.nextCursor}))
        if (generation !== this.generation || owner !== commandIdentityScope()) return
        const known = new Set(page.items.map(item => item.id))
        page.items = page.items.concat(next.items.filter(item => !known.has(item.id)))
        page.nextCursor = next.nextCursor
      }
      this.walletOwner=owner
      const viewed=offer?present(offer):null
      if(viewed)viewed.existingCoupon=offer.existingCoupon?this.presentCoupon(offer.existingCoupon):null
      this.setData({ selectedCoupon: selectedId ? page.items.filter(item=>item.id===selectedId).map(item=>this.presentCoupon(item))[0] || null : null, coupons: page.items.map(item=>this.presentCoupon(item)), pendingClaim:Boolean(code && pendingGuestCommandMatches('channel.claim', {code:this.data.code.trim()}, {customerOnly:true})), nextCursor:page.nextCursor, offer:viewed, error: selectedId && !page.items.some(item=>item.id===selectedId) ? '未查到所选优惠券，请返回我的优惠券刷新核对' : this.entryError || '' })
    } catch (error) {
      if (generation === this.generation && (!owner || owner === commandIdentityScope())) this.setData({
        needsLogin: error.code === 'AUTH_REQUIRED', error: customerErrorMessage(error, '优惠暂时无法读取，请重试'),
      })
    } finally { if (generation === this.generation) { this.setData({ loading: false }); this.scheduleValidityRefresh() } }
  },
  async loadMore() {
    if(this.data.loading||this.data.loadingMore||this.data.busy||!this.data.nextCursor)return
    if(this.walletOwner!==commandIdentityScope())return this.load()
    const owner=this.walletOwner,generation=this.generation,cursor=this.data.nextCursor,status=FILTERS[this.data.filterIndex].value
    this.setData({loadingMore:true,error:''})
    try {
      const page=await getChannelWalletPage(this.data.selectedClaimId ? {cursor,status:'all',code:channelCode(this.data.code)} : {cursor,status})
      if(generation!==this.generation||owner!==commandIdentityScope())return
      if(page.nextCursor===cursor)throw new Error('券包分页未前进，请刷新后重试')
      const known=new Set(this.data.coupons.map(item=>item.id))
      this.setData({coupons:this.data.coupons.concat(page.items.filter(item=>!known.has(item.id)).map(item=>this.presentCoupon(item))),nextCursor:page.nextCursor})
    } catch(error) {if(generation===this.generation&&owner===commandIdentityScope())this.setData({error:customerErrorMessage(error,'更多优惠读取失败，请重试')})}
    finally {if(generation===this.generation){this.setData({loadingMore:false});this.scheduleValidityRefresh()}}
  },
  openWallet() { wx.navigateTo({url:'/pages/profile-coupons/index'}) },
  goToOrder() {
    if (this.visible === false || this.data.busy || this.data.loading) return
    if (!this.data.canGoToOrder || this.orderOwner !== commandIdentityScope() || this.orderScope !== getTableSession().cartScope || this.orderToken !== getTableSession().tableToken) { this.setData({canGoToOrder:false, error:'账号或桌号已变化，请重新核对本张优惠券'}); return }
    wx.switchTab({url:'/pages/order/index', fail:()=>this.setData({error:'点单页暂未打开，优惠已绑定，请点击继续点单重试'})})
  },
  async claim() {
    if (this.data.needsLogin) { this.login(); return }
    // First inspect rules; a manual number is never submitted unseen.
    if (!this.data.offer) { await this.load(); return }
    if (this.data.offer.unavailable || this.data.loading) return
    await this.write('claim', this.data.code.trim())
  },
  async recoverClaim() { await this.write('recover-claim', this.data.code.trim()) },
  async recoverCoupon(event) { await this.write('recover-activate', event.currentTarget.dataset.id) },
  async useCoupon(event) {
    if (this.data.busy || this.data.loading || this.data.checkingTable) return
    const id = event.currentTarget.dataset.id
    const owner = commandIdentityScope()
    const available = () => this.data.coupons.concat(this.data.offer?.existingCoupon || [])
      .some(coupon => coupon.id === id && (coupon.status === 'available' || (this.data.orderAfterUse && this.data.selectedClaimId === id && coupon.status === 'active')) && !coupon.canRecover)
    if (owner !== this.walletOwner || !available()) return
    const attempt = { owner }
    this.tableScan = attempt
    const current = () => this.tableScan === attempt && owner === commandIdentityScope() && available()
    this.setData({ checkingTable: true, error: '', notice: '' })
    try {
      if (!getTableSession().tableToken || this.data.tableRetryId === id) {
        const result = await new Promise((success, fail) => wx.scanCode({
          onlyFromCamera: true, scanType: ['qrCode','wxCode'], success, fail,
        }))
        if (!current()) return
        if (result.path && !/^\/?pages\/(order|home)\/index\?/.test(result.path)) throw Error('请扫描桌面上的桌码')
        const query = parseScanValue(result.path || result.result)
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(query.token || query.tableToken || '')) throw Error('请扫描桌面上的桌码')
        getApp().refreshRuntime({query, forceTableScan: true})
      }
      const scan = {...getTableSession()}
      const connected = (await getGuestSession()).data
      const table = {...getTableSession()}
      if (!current() || scan.scanNonce !== table.scanNonce || scan.tableToken !== table.tableToken) return
      if (connected.status === 'waiting_for_table') {
        this.setData({ error: '这桌尚未开台，请联系服务员，开台后再使用这张券。' })
        return
      }
      if (!['active','already_active'].includes(connected.status) || !connected.table?.code || !table.cartScope)
        throw Error('请重新扫描桌码核对桌号')
      const sameVisit = () => current() && this.visible !== false && table.tableToken === getTableSession().tableToken
        && table.scanNonce === getTableSession().scanNonce && table.cartScope === getTableSession().cartScope
      const coupon = this.data.coupons.find(row => row.id === id) || this.data.offer.existingCoupon
      const answer = await new Promise((success, fail) => wx.showModal({
        title: '确认用券桌号', content: (coupon.title || '本张优惠券') + ' · ' + connected.table.code + ' 桌',
        confirmText: '确认使用', cancelText: '暂不使用', success, fail,
      }))
      if (!current() || this.visible === false) return
      if (!answer.confirm || !sameVisit()) {
        this.setData({tableRetryId: id, notice: '可以重新扫桌码使用这张券。'})
        return
      }
      this.setData({ tableRetryId: null })
      const confirmed = await this.write('activate', id, sameVisit)
      if (confirmed && this.data.orderAfterUse) this.goToOrder()
    } catch (error) {
      if (current() && !/cancel/i.test(String(error?.errMsg || ''))) this.setData({
        tableRetryId: id, error: '桌号暂未确认，请重新扫描桌面上的桌码。',
      })
    } finally {
      if (this.tableScan === attempt) this.tableScan = null
      this.setData({ checkingTable: false, hasTable: Boolean(getTableSession().tableToken) })
    }
  },
  async write(action, value, confirmVisit) {
    if (this.writing || !value) return
    this.writing = true
    const isClaim = action === 'claim' || action === 'recover-claim'
    const generation = this.generation, owner = commandIdentityScope()
    const table = Object.assign({}, getTableSession())
    const sameTable = () => {
      const current = getTableSession()
      return table.tableToken === current.tableToken && table.scanNonce === current.scanNonce
        && (!table.cartScope || table.cartScope === current.cartScope)
    }
    const sameView = () => generation === this.generation && owner === commandIdentityScope()
      && this.visible !== false && (isClaim || sameTable())
    this.setData({ busy: true, error: '', notice: '' })
    let failure = '', completed = false, mayContinue = false, refreshedCurrent = false
    try {
      if (action === 'recover-claim') await recoverChannelClaim(value)
      else if (action === 'recover-activate') await recoverChannelCoupon(value)
      else if (action === 'claim') await claimChannelCoupon(value)
      else await activateChannelCoupon(value, false, confirmVisit)
      completed = true
      mayContinue = sameView()
      if (sameView() && isClaim) this.setData({filterIndex:0})
      if (sameView()) this.setData({ notice: action.startsWith('recover-') ? '已查到上次办理结果，请查看下方优惠券状态。' : isClaim ? '领取成功，已放入「我的优惠券」，到店后可去点单使用。' : '已绑定本次消费，最终优惠以订单确认结果为准。' })
    } catch (error) {
      if (sameView()) failure = customerErrorMessage(error, '结果还未确认，请先查看这张券的状态')
    } finally {
      // A foreground read may have completed before this write committed. Read
      // again even after hide/show or a filter change, but never retry the write.
      if (owner === commandIdentityScope() && this.visible !== false) {
        const refresh = this.load(), refreshGeneration = this.generation
        await refresh
        if (refreshGeneration === this.generation && owner === commandIdentityScope() && this.visible !== false) {
          refreshedCurrent = true
          if (!isClaim && !sameTable()) this.setData({ notice: '' })
          else if (failure) this.setData({ error: failure })
        }
      }
      this.writing = false
      this.setData({ busy: false })
    }
    const confirmed = completed && mayContinue && refreshedCurrent && owner === commandIdentityScope() && this.visible !== false && (isClaim || sameTable())
    if (confirmed && !isClaim) {
      this.orderOwner=owner; this.orderScope=table.cartScope; this.orderToken=table.tableToken
      this.setData({canGoToOrder:true})
    }
    return confirmed
  },
})
