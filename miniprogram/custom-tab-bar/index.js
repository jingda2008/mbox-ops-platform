const tabs = [
  { path: '/pages/home/index', text: '首页', icon: 'home' },
  { path: '/pages/reservations/index', text: '预约', icon: 'reservations' },
  { path: '/pages/order/index', text: '点单', icon: 'order' },
  { path: '/pages/community/index', text: '超嗨', icon: 'community' },
  { path: '/pages/profile/index', text: '我的', icon: 'profile' },
]
Component({
  data: { tabs, selected: 0, safeBottom: 0 },
  lifetimes: {
    attached() { this.refresh() },
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
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      if (!Number.isInteger(index) || !tabs[index]) return
      wx.switchTab({ url: tabs[index].path })
    },
  },
})
