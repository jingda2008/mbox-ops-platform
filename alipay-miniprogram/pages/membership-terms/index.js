const runtime = require('../../utils/platform')
const { getMiniBootstrap, enrollMembership } = require('../../utils/api')
const { obtainAlipayPhoneAuthorization } = require('../../utils/alipay-phone')
const { customerErrorCode, customerErrorMessage, membershipEnrollErrorMessage } = require('../../utils/customer-error')

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
      const code = customerErrorCode(error)
      this.setData({
        loading: false,
        error: code === 'ROUTE_NOT_FOUND'
          ? '会员服务暂时连不上，请稍后重试'
          : customerErrorMessage(error, '当前入会条款暂时无法读取'),
      })
    }
  },

  onAgreementChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : []
    this.setData({ agreedToPolicies: values.indexOf('agree') >= 0 })
  },

  remindAgreement() {
    runtime.showToast({ title: '请先勾选同意协议与隐私政策', icon: 'none' })
  },

  openPrivacy() {
    runtime.navigateTo({ url: '/pages/privacy/index' })
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
      runtime.showToast({ title: '您已经是会员', icon: 'none' })
      return
    }
    if (!terms) {
      runtime.showModal({
        title: '暂时无法加入',
        content: '当前入会条款尚未发布，暂不能新加入会员。点单和找回原会员不受影响。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    const authorization = await obtainAlipayPhoneAuthorization(event)
    if (!authorization.code) {
      this.setData({ error: authorization.message })
      runtime.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, this.data.acknowledgementSource, authorization.code)
      runtime.showToast({ title: '入会成功', icon: 'success', duration: 1200 })
      setTimeout(() => {
        runtime.navigateBack({
          fail: () => runtime.switchTab({ url: '/pages/profile/index' }),
        })
      }, 1200)
    } catch (error) {
      this.setData({
        error: membershipEnrollErrorMessage(error, '入会暂时没有完成'),
      })
      runtime.showToast({
        title: membershipEnrollErrorMessage(error, '入会未完成'),
        icon: 'none',
      })
    } finally {
      this.setData({ busy: false })
    }
  },
})
