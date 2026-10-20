const { getMiniBootstrap, getVerifiedPhones, replaceVerifiedPhone } = require('../utils/api')
const { readWechatPhoneAuthorization } = require('../utils/wechat-phone')
const { customerErrorMessage } = require('../utils/customer-error')
const { getRuntimeConfig } = require('../config/index')
const DISMISSED_KEY = 'mbox.membership.invite.dismissed.until.v1'
const tabs = [
  { path: '/pages/home/index', text: '首页', icon: 'home' },
  { path: '/pages/reservations/index', text: '预约', icon: 'reservations' },
  { path: '/pages/order/index', text: '点单', icon: 'order' },
  { path: '/pages/community/index', text: '超嗨', icon: 'community' },
  { path: '/pages/profile/index', text: '我的', icon: 'profile' },
]
Component({
  data: { tabs, selected: 0, needsPhone: false, busy: false, safeBottom: 0 },
  lifetimes: {
    attached() { this.refresh() },
    detached() { this.generation = (this.generation || 0) + 1 },
  },
  pageLifetimes: { show() { this.refresh() } },
  methods: {
    refresh(path) {
      const pages = getCurrentPages()
      const page = pages[pages.length - 1]
      const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : null
      const inset = info && info.safeArea && Number(info.screenHeight) - Number(info.safeArea.bottom)
      const safeBottom = Number.isFinite(inset) && inset >= 0 && inset <= 80 ? inset : 0
      this.setData({ safeBottom })
      if (page && typeof page.setData === 'function') page.setData({ customTabBarHeight: 50 + safeBottom })
      const route = path || '/' + (page || {}).route
      const selected = tabs.findIndex(tab => tab.path === route)
      if (selected >= 0) this.setData({ selected })
      if (!this.data.busy) return this.loadPhoneState()
    },
    async loadPhoneState() {
      const generation = this.generation = (this.generation || 0) + 1
      this.setData({ needsPhone: false })
      if (Number(wx.getStorageSync(DISMISSED_KEY)) > Date.now()) return
      try {
        const bootstrap = await getMiniBootstrap()
        if (generation !== this.generation || !bootstrap || bootstrap.membership !== null) return
        const phones = await getVerifiedPhones()
        if (generation !== this.generation) return
        this.setData({ needsPhone: Array.isArray(phones) && phones.length === 0 })
      } catch (_) { /* Unknown identity never blocks menu navigation. */ }
    },
    switchTab(event) {
      if (this.data.busy) return
      const index = Number(event.currentTarget.dataset.index)
      if (!Number.isInteger(index) || !tabs[index]) return
      wx.switchTab({ url: tabs[index].path })
    },
    async authorizeAndOrder(event) {
      if (this.data.busy) return
      const authorization = readWechatPhoneAuthorization(event)
      this.setData({ busy: true })
      try {
        if (authorization.code) {
          const verified = await replaceVerifiedPhone(authorization.code)
          if (!verified || verified.status !== 'active' || !verified.publicId) throw new Error('手机号验证未完成')
        }
        const configured = Number(getRuntimeConfig().membershipInviteCooldownHours)
        const hours = Number.isFinite(configured) && configured >= 1 && configured <= 2160 ? configured : 24
        wx.setStorageSync(DISMISSED_KEY, Date.now() + hours * 3600000)
        this.setData({ needsPhone: false })
      } catch (error) {
        wx.showToast({ title: customerErrorMessage(error, '手机号授权未完成，可继续点菜'), icon: 'none' })
      } finally {
        this.setData({ busy: false })
        // Denial and verification failure must still lead to the real menu.
        wx.switchTab({ url: '/pages/order/index' })
      }
    },
  },
})
