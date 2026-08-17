const { getMiniBootstrap, enrollMembership } = require('../../utils/api')

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
    if (this.data.busy || this.data.membership || !terms) return
    const confirmed = await new Promise((resolve) => wx.showModal({
      title: '确认加入会员',
      content: `我已阅读本页展示的《${terms.title}》第${terms.version}版，并同意按该版本加入会员。手机号和通知仍需另行授权。`,
      confirmText: '同意并加入', cancelText: '再看一下',
      success: (result) => resolve(result.confirm), fail: () => resolve(false),
    }))
    if (!confirmed) return
    this.setData({ busy: true, error: '' })
    try {
      await enrollMembership(terms.version, this.data.acknowledgementSource)
      wx.showToast({ title: '入会成功', icon: 'success' })
      await this.load()
    } catch (error) {
      this.setData({ error: error.message || '入会暂时没有完成' })
    } finally {
      this.setData({ busy: false })
    }
  },
})
