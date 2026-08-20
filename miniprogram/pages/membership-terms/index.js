const { getMiniBootstrap, enrollMembership } = require('../../utils/api')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')

Page({
  data: {
    loading: true, busy: false, error: '', membership: null,
    terms: null, acknowledgementSource: 'mini_profile', allowEnrollment: false,
    agreedToPolicies: false,
  },

  onLoad(query) {
    const source = query && query.source === 'mini_menu' ? 'mini_menu' : 'mini_profile'
    this.setData({
      acknowledgementSource: source,
      allowEnrollment: Boolean(query && query.action === 'enroll'),
      agreedToPolicies: false,
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

  onAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ agreedToPolicies: values.indexOf('agree') >= 0 })
  },

  remindAgreement() {
    wx.showToast({ title: '请先勾选同意协议与隐私政策', icon: 'none' })
  },

  openPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' })
  },

  onAgreePrivacyAuthorization() {},

  async acceptAndEnroll(event) {
    const terms = this.data.terms
    if (this.data.busy) return
    if (!this.data.agreedToPolicies) {
      this.remindAgreement()
      return
    }
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
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      this.setData({ error: authorization.message })
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, this.data.acknowledgementSource, authorization.code)
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
