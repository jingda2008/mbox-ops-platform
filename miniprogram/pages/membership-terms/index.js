const { getMiniBootstrap, getMembershipTerms, enrollMembership } = require('../../utils/api')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')
const { customerErrorCode, customerErrorMessage } = require('../../utils/customer-error')

Page({
  data: {
    loading: true, busy: false, error: '', membership: null,
    terms: null, acknowledgementSource: 'mini_profile', allowEnrollment: false,
    agreedToPolicies: false, enrollmentReady: false, enrollmentError: '',
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

  onHide() { this.termsReadGeneration = (this.termsReadGeneration || 0) + 1 },
  onUnload() { this.termsReadGeneration = (this.termsReadGeneration || 0) + 1 },

  async load() {
    const generation = this.termsReadGeneration = (this.termsReadGeneration || 0) + 1
    this.setData({ loading: true, error: '', agreedToPolicies: false, enrollmentReady: false, enrollmentError: '' })
    if (this.data.allowEnrollment) this.enrollmentPending = this.loadEnrollmentContext(generation)
    try {
      const terms = await getMembershipTerms()
      if (generation !== this.termsReadGeneration) return
      this.setData({ loading: false, terms: terms || null })
    } catch (error) {
      if (generation !== this.termsReadGeneration) return
      const code = customerErrorCode(error)
      this.setData({
        loading: false, terms: null,
        error: code === 'ROUTE_NOT_FOUND'
          ? '协议服务暂时连不上，请稍后重试'
          : customerErrorMessage(error, '当前条款暂时无法读取，请稍后重试'),
      })
    }
  },

  async loadEnrollmentContext(generation) {
    try {
      const bootstrap = await getMiniBootstrap()
      if (generation !== this.termsReadGeneration) return
      this.setData({ membership: bootstrap.membership || null, enrollmentReady: true })
    } catch (error) {
      if (generation !== this.termsReadGeneration) return
      this.setData({ enrollmentReady: false, enrollmentError: customerErrorMessage(error, '会员身份暂时无法确认，请重新读取；协议仍可阅读。') })
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
    if (this.data.allowEnrollment && !this.data.enrollmentReady) {
      this.setData({ enrollmentError: '会员身份暂时无法确认，请重新读取后再加入。' })
      return
    }
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
      const code = customerErrorCode(error)
      this.setData({
        error: code === 'ROUTE_NOT_FOUND'
          ? '入会服务暂时不可用，请稍后重试或联系门店'
          : customerErrorMessage(error, '入会暂时没有完成'),
      })
      wx.showToast({
        title: code === 'ROUTE_NOT_FOUND'
          ? '入会服务暂时不可用'
          : customerErrorMessage(error, '入会未完成'),
        icon: 'none',
      })
    } finally {
      this.setData({ busy: false })
    }
  },
})
