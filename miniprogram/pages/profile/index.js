const { getMiniBootstrap, enrollMembership, updatePreferences } = require('../../utils/api')

Page({
  data: {
    loading: true, busy: false, error: '', membership: null, points: [], features: [],
    preferredAlcohol: 'undecided', serviceIntensity: 'balanced',
    alcoholOptions: [
      { code: 'undecided', name: '到店再选' }, { code: 'cocktail', name: '鸡尾酒' },
      { code: 'wine', name: '红酒' }, { code: 'whisky', name: '威士忌' },
      { code: 'beer', name: '啤酒' }, { code: 'non_alcoholic', name: '无酒精' },
    ],
    alcoholIndex: 0,
    serviceOptions: [
      { code: 'quiet', name: '少打扰' }, { code: 'balanced', name: '适度照顾' }, { code: 'hosted', name: '希望被安排' },
    ], serviceIndex: 1,
  },
  onShow() { this.load() },
  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const data = await getMiniBootstrap()
      const preferences = data.preferences || {}
      const alcoholIndex = Math.max(0, this.data.alcoholOptions.findIndex((item) => item.code === preferences.preferredAlcohol))
      const serviceIndex = Math.max(0, this.data.serviceOptions.findIndex((item) => item.code === preferences.serviceIntensity))
      this.setData({
        loading: false,
        membership: data.membership,
        points: data.points || [],
        features: data.features || [],
        alcoholIndex,
        serviceIndex: preferences.serviceIntensity ? serviceIndex : 1,
      })
    } catch (error) { this.setData({ loading: false, error: error.message || '会员信息暂时没有接上' }) }
  },
  async becomeMember() {
    if (this.data.busy) return
    this.setData({ busy: true, error: '' })
    try { await enrollMembership(); await this.load(); wx.showToast({ title: '已成为会员', icon: 'success' }) }
    catch (error) { this.setData({ error: error.message || '入会没有完成' }) }
    finally { this.setData({ busy: false }) }
  },
  onAlcoholChange(event) { this.setData({ alcoholIndex: Number(event.detail.value) }) },
  onServiceChange(event) { this.setData({ serviceIndex: Number(event.detail.value) }) },
  async savePreferences() {
    if (this.data.busy) return
    this.setData({ busy: true, error: '' })
    try {
      await updatePreferences({
        preferredAlcohol: this.data.alcoholOptions[this.data.alcoholIndex].code,
        serviceIntensity: this.data.serviceOptions[this.data.serviceIndex].code,
      })
      wx.showToast({ title: '偏好已保存', icon: 'success' })
    } catch (error) { this.setData({ error: error.message || '偏好没有保存' }) }
    finally { this.setData({ busy: false }) }
  },
})
