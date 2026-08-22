const { getMiniBootstrap, enrollMembership } = require('../../utils/api')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')

Page({
  data: {
    loading: true, busy: false, error: '', membership: null,
    terms: null, acknowledgementSource: 'mini_profile', allowEnrollment: false,
    agreedToPolicies: false,
  },

  onLoad(query) {
    const source = query && ['mini_menu', 'mini_profile', 'mini_community'].includes(query.source)
      ? query.source : 'mini_profile'
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
      const message = String((error && error.message) || '')
      this.setData({
        loading: false,
        error: /请求的页面或接口不存在|ROUTE_NOT_FOUND/.test(message)
          ? '会员服务暂时连不上，请稍后重试或确认小程序已指向最新服务端'
          : (message || '当前入会条款暂时无法读取'),
      })
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
      const message = String((error && error.message) || '')
      this.setData({
        error: /请求的页面或接口不存在|ROUTE_NOT_FOUND|会员服务暂时连不上/.test(message)
          ? '入会服务暂时不可用，请稍后重试或联系门店'
          : (message || '入会暂时没有完成'),
      })
      wx.showToast({
        title: /请求的页面或接口不存在|ROUTE_NOT_FOUND/.test(message)
          ? '入会服务暂时不可用'
          : (message || '入会未完成'),
        icon: 'none',
      })
    } finally {
      this.setData({ busy: false })
    }
  },
})
