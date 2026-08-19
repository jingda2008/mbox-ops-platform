const { getMiniBootstrap, enrollMembership } = require('../../utils/api')

function confirmEnrollment(terms) {
  return new Promise((resolve) => {
    wx.showModal({
      title: '确认加入会员',
      content: `我已阅读本页展示的《${terms.title}》第${terms.version}版，并同意按该版本加入会员。手机号和通知仍需另行授权。`,
      // WeChat showModal confirmText/cancelText are capped at 4 characters.
      confirmText: '同意加入',
      cancelText: '再看看',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: (error) => {
        wx.showToast({
          title: (error && error.errMsg) || '确认弹窗未能打开',
          icon: 'none',
        })
        resolve(false)
      },
    })
  })
}

Page({
  data: {
    loading: true, busy: false, error: '', membership: null,
    terms: null, acknowledgementSource: 'mini_profile', allowEnrollment: false,
  },

  onLoad(query) {
    const source = query && query.source === 'mini_menu' ? 'mini_menu' : 'mini_profile'
    this.setData({
      acknowledgementSource: source,
      allowEnrollment: Boolean(query && query.action === 'enroll'),
    })
  },

  onShow() { this.load() },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const bootstrap = await getMiniBootstrap()
      this.setData({
        loading: false,
        membership: bootstrap.membership || null,
        terms: bootstrap.membershipTerms || null,
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '当前入会条款暂时无法读取' })
    }
  },

  async acceptAndEnroll() {
    const terms = this.data.terms
    if (this.data.busy) return
    if (this.data.membership) {
      wx.showToast({ title: '您已经是会员', icon: 'none' })
      return
    }
    if (!terms) {
      wx.showModal({
        title: '暂时无法加入',
        content: '当前入会条款尚未发布，暂不能新加入会员。点单和找回原会员不受影响。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    const confirmed = await confirmEnrollment(terms)
    if (!confirmed) return
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, this.data.acknowledgementSource)
      wx.showToast({ title: '入会成功', icon: 'success', duration: 1200 })
      setTimeout(() => {
        wx.navigateBack({
          fail: () => wx.switchTab({ url: '/pages/profile/index' }),
        })
      }, 1200)
    } catch (error) {
      this.setData({ error: error.message || '入会暂时没有完成' })
      wx.showToast({ title: error.message || '入会未完成', icon: 'none' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
