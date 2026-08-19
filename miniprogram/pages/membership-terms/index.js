const { getMiniBootstrap, enrollMembership, replaceVerifiedPhone } = require('../../utils/api')
const { readWechatPhoneAuthorization } = require('../../utils/wechat-phone')

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

  onAgreePrivacyAuthorization() {},

  async acceptAndEnroll(event) {
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
    const authorization = readWechatPhoneAuthorization(event)
    if (!authorization.code) {
      this.setData({ error: authorization.message })
      wx.showToast({ title: authorization.message, icon: 'none' })
      return
    }
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, this.data.acknowledgementSource)
      try {
        await replaceVerifiedPhone(authorization.code)
      } catch (phoneError) {
        this.setData({ error: phoneError.message || '会员已加入，手机号未能保存' })
        wx.showToast({ title: '已加入，手机号未保存', icon: 'none', duration: 1800 })
        setTimeout(() => {
          wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/index' }) })
        }, 1600)
        return
      }
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
